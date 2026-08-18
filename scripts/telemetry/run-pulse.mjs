#!/usr/bin/env node
/**
 * Run pulse — is the run flowing, and if not, what is wrong?
 *
 * The scorecard answers "was this gate worth it" across runs. This answers a
 * different question, during one: a long run is in progress, nobody wants to watch it,
 * and the only thing worth surfacing is the moment it stops being fine.
 *
 * That is deliberately NOT a timeline. A timeline shows everything and asks the reader
 * to notice what is wrong, which is the same as asking them to watch. The pathologies
 * this system actually produces are computable from the transition log, so they are
 * computed and named, and the activity strip is there to give them context — not the
 * other way round.
 *
 * The pathologies, all observed in real runs:
 *   - a retry storm: the same verb refused over and over while its recipe is discovered
 *   - a stall: nothing happening at all, which looks identical to "thinking" from outside
 *   - churn: an expectation recorded, accepted, then recorded again — work being redone
 *   - data the scorer cannot attribute, which is a defect in the run OR in the kit
 *
 * Nothing here is kit-specific. It reads outcomes and identifiers, not meanings.
 *
 * Usage:
 *   node scripts/telemetry/run-pulse.mjs [--transitions <file>] [--watch] [--json]
 *        [--stall-minutes <n>] [--since <iso>]
 */

import fs from "node:fs";
import path from "node:path";

import { sharedRepoRoot } from "./gate-scorecard.mjs";

const DEFAULT_STALL_MINUTES = 8;
const RETRY_STORM_THRESHOLD = 3;
const CHURN_THRESHOLD = 2;
const STRIP_CELLS = 40;

/**
 * Every linked worktree appends to the primary checkout's log, so one file holds every
 * lane's transitions. Without a filter the storm/churn/stall detectors report a sibling
 * lane's pathology as this run's — the same contamination the token attributor was
 * fixed to prevent, and a worse version of it, because a storm has no session id
 * printed beside it to give the reader a clue.
 */
export function filterToSession(transitions, session) {
  if (!session) return transitions;
  return transitions.filter((record) => (record?.actor?.session_id ?? null) === session);
}

export function readTransitions(file) {
  if (!fs.existsSync(file)) return [];
  const records = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed);
      if (record?.kind === "kontour.flow-agents.transition") records.push(record);
    } catch {
      // A partial trailing line is normal while the log is being appended to.
    }
  }
  return records;
}

/** What a transition was aimed at, for grouping repeats. */
export function subjectOf(record) {
  const target =
    record?.targets?.expectation ?? record?.targets?.gate ?? record?.targets?.decision ?? null;
  // Expectation ids are not globally unique — the shipped kits share one across two
  // flows — so the flow, when the record names it, is part of the subject. Without it
  // two unrelated gates merge into one fabricated retry storm.
  const flow = record?.targets?.flow ?? null;
  return [record?.command ?? "?", record?.verb ?? "", flow ?? "", target ?? ""].filter(Boolean).join(" ");
}

const isOk = (record) => record?.outcome === "ok";
/**
 * A refusal is a contract rejection. `usage` (exit 64) is a malformed invocation and is
 * excluded from the headline count, so it must be excluded here too — otherwise a panel
 * can read "0 refused (0%)" beside "refused 3x in a row" about the same transitions.
 */
const isRefusal = (record) => !isOk(record) && record?.outcome !== "usage";

/**
 * Consecutive refusals of the same subject. This is the dominant failure signature in
 * practice: a verb whose input shape is being discovered one rejection at a time. It is
 * reported by SUBJECT rather than by count alone, because "7 refusals" is ambiguous and
 * "render-claim refused 7 times in a row" is actionable.
 */
export function detectRetryStorms(transitions, threshold = RETRY_STORM_THRESHOLD) {
  const storms = [];
  let run = [];
  const flush = () => {
    if (run.length >= threshold) {
      const first = run[0];
      const last = run[run.length - 1];
      storms.push({
        kind: "retry-storm",
        severity: "warn",
        subject: subjectOf(first),
        count: run.length,
        from: first.started_at,
        to: last.started_at,
        exit_codes: [...new Set(run.map((record) => record.exit_code))],
      });
    }
    run = [];
  };
  for (const record of transitions) {
    if (!isRefusal(record)) {
      flush();
      continue;
    }
    if (run.length && subjectOf(run[0]) !== subjectOf(record)) flush();
    run.push(record);
  }
  flush();
  return storms;
}

/**
 * A subject that succeeded and was then attempted again — work being redone. In this
 * system that is usually evidence going stale underneath a moving head, which is worth
 * seeing while it is happening rather than in a postmortem.
 */
export function detectChurn(transitions, threshold = CHURN_THRESHOLD) {
  const succeeded = new Set();
  const repeats = new Map();
  for (const record of transitions) {
    const subject = subjectOf(record);
    if (succeeded.has(subject)) repeats.set(subject, (repeats.get(subject) ?? 0) + 1);
    if (isOk(record)) succeeded.add(subject);
  }
  return [...repeats.entries()]
    .filter(([, count]) => count >= threshold)
    .map(([subject, count]) => ({
      kind: "churn",
      severity: "info",
      subject,
      count,
      note: "recorded again after it had already been accepted",
    }));
}

/** Nothing has happened for a while, which from outside is indistinguishable from work. */
export function detectStall(transitions, now, stallMinutes = DEFAULT_STALL_MINUTES) {
  if (!transitions.length) return null;
  const last = transitions[transitions.length - 1];
  const lastAt = Date.parse(last.started_at ?? "");
  if (Number.isNaN(lastAt)) return null;
  const idleMs = now - lastAt;
  if (idleMs < stallMinutes * 60_000) return null;
  return {
    kind: "stall",
    severity: "warn",
    idle_ms: idleMs,
    since: last.started_at,
    last_subject: subjectOf(last),
  };
}

/**
 * A coarse activity strip: one cell per time bucket over the run, marked by what
 * happened in it. Its job is to give the anomalies context — where in the run the
 * storm sits, how long the quiet has lasted — not to be read on its own.
 */
export function activityStrip(transitions, now, cells = STRIP_CELLS) {
  if (!transitions.length) return { cells: [], from: null, to: null, bucket_ms: 0 };
  const times = transitions.map((record) => Date.parse(record.started_at ?? "")).filter((t) => !Number.isNaN(t));
  if (!times.length) return { cells: [], from: null, to: null, bucket_ms: 0 };
  const from = Math.min(...times);
  // Spans activity, not wall clock to now. Stretching to `now` makes a run that has
  // been idle overnight render as four cells of work and thirty-six of nothing, which
  // hides the shape of the part that matters. Silence is the stall anomaly's job and
  // the header's idle figure; each cell here is real elapsed run time.
  const to = Math.max(...times);
  const bucketMs = Math.max(1, Math.ceil(Math.max(1, to - from) / cells));
  const buckets = Array.from({ length: cells }, () => ({ ok: 0, bad: 0 }));
  for (const record of transitions) {
    const at = Date.parse(record.started_at ?? "");
    if (Number.isNaN(at)) continue;
    const index = Math.min(cells - 1, Math.floor((at - from) / bucketMs));
    if (isOk(record)) buckets[index].ok += 1;
    else buckets[index].bad += 1;
  }
  return {
    cells: buckets.map((bucket) => (bucket.bad ? "bad" : bucket.ok ? "ok" : "idle")),
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    bucket_ms: bucketMs,
  };
}

export function buildPulse(transitions, { now = Date.now(), stallMinutes = DEFAULT_STALL_MINUTES } = {}) {
  const ordered = [...transitions].sort(
    (a, b) => (Date.parse(a.started_at ?? "") || 0) - (Date.parse(b.started_at ?? "") || 0),
  );
  const anomalies = [...detectRetryStorms(ordered), ...detectChurn(ordered)];
  const stall = detectStall(ordered, now, stallMinutes);
  if (stall) anomalies.unshift(stall);

  const refused = ordered.filter(isRefusal).length;
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  return {
    schema_version: "1.0",
    kind: "kontour.flow-agents.run-pulse",
    generated_at: new Date(now).toISOString(),
    totals: {
      transitions: ordered.length,
      ok: ordered.filter(isOk).length,
      refused_or_error: refused,
      refusal_rate: ordered.length ? Number((refused / ordered.length).toFixed(3)) : 0,
    },
    span: {
      from: first?.started_at ?? null,
      to: last?.started_at ?? null,
      idle_ms: last ? Math.max(0, now - (Date.parse(last.started_at ?? "") || now)) : null,
    },
    // Severity first, then most recent: the point is what needs attention, in order.
    anomalies: anomalies.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "warn" ? -1 : 1)),
    strip: activityStrip(ordered, now),
    recent: ordered.slice(-8).map((record) => ({
      at: record.started_at,
      subject: subjectOf(record),
      outcome: record.outcome,
      exit_code: record.exit_code,
      duration_ms: record.duration_ms,
    })),
  };
}

// --- rendering -------------------------------------------------------------

const GLYPH = { ok: "▇", bad: "▚", idle: "·" };

function humanDuration(ms) {
  if (ms === null || ms === undefined) return "—";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.round(ms / 1000)}s`;
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}

function clockOf(iso) {
  return iso ? iso.slice(11, 16) : "--:--";
}

export function renderPulse(pulse) {
  const lines = [];
  const { totals, span } = pulse;
  lines.push(
    `RUN PULSE  ${totals.transitions} transitions  ·  ${totals.refused_or_error} refused ` +
      `(${Math.round(totals.refusal_rate * 100)}%)  ·  idle ${humanDuration(span.idle_ms)}`,
  );
  lines.push(
    `${clockOf(span.from)} ${pulse.strip.cells.map((cell) => GLYPH[cell]).join("")} ${clockOf(pulse.generated_at)}`,
  );
  lines.push("");

  if (!pulse.anomalies.length) {
    lines.push("  nothing needs attention — flowing");
  }
  for (const anomaly of pulse.anomalies) {
    const mark = anomaly.severity === "warn" ? "!" : "·";
    if (anomaly.kind === "retry-storm") {
      lines.push(
        `  ${mark} RETRY STORM  ${anomaly.subject} refused ${anomaly.count}x in a row ` +
          `(exit ${anomaly.exit_codes.join("/")}, from ${clockOf(anomaly.from)})`,
      );
    } else if (anomaly.kind === "stall") {
      lines.push(
        `  ${mark} STALLED      nothing for ${humanDuration(anomaly.idle_ms)} — last was ${anomaly.last_subject}`,
      );
    } else if (anomaly.kind === "churn") {
      lines.push(`  ${mark} CHURN        ${anomaly.subject} ${anomaly.note} (${anomaly.count}x)`);
    }
  }

  if (pulse.recent.length) {
    lines.push("");
    lines.push("  recent");
    for (const entry of pulse.recent) {
      const mark = entry.outcome === "ok" ? "ok " : "XX ";
      lines.push(
        `    ${clockOf(entry.at)} ${mark} ${entry.subject.padEnd(46).slice(0, 46)} ` +
          `${entry.outcome === "ok" ? "" : `exit ${entry.exit_code}`}`,
      );
    }
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = () => argv[(index += 1)];
    if (token === "--transitions") options.transitions = value();
    else if (token === "--stall-minutes") options.stallMinutes = Number(value());
    else if (token === "--watch") options.watch = true;
    else if (token === "--json") options.json = true;
    else if (token === "--session") options.session = value();
    else if (token === "--all-sessions") options.allSessions = true;
    else if (token === "--interval") options.intervalMs = Number(value()) * 1000;
    else if (token === "--help" || token === "-h") options.help = true;
    else throw new Error(`unknown option: ${token}`);
  }
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log("Usage: run-pulse.mjs [--transitions <file>] [--watch] [--interval <s>] [--json] [--stall-minutes <n>]");
    return 0;
  }
  const file = options.transitions ?? path.join(sharedRepoRoot(process.cwd()), ".kontourai", "telemetry", "transitions.jsonl");
  // Default to this session so a lane sees its own run, not the whole machine's.
  const session = options.allSessions ? null : options.session ?? process.env["CLAUDE_CODE_SESSION_ID"] ?? null;
  const render = () => {
    const all = readTransitions(file);
    const scoped = filterToSession(all, session);
    if (session && !scoped.length && all.length) {
      console.log(`no transitions for session ${session} in ${file} (${all.length} from other sessions) — pass --all-sessions to include them`);
    }
    const pulse = buildPulse(scoped, { stallMinutes: options.stallMinutes ?? DEFAULT_STALL_MINUTES });
    if (options.json) console.log(JSON.stringify(pulse, null, 2));
    else console.log(renderPulse(pulse));
    return pulse;
  };

  if (!options.watch) {
    render();
    return 0;
  }

  // Watch redraws in place. It polls rather than watching the inode because the log is
  // appended to by other processes and an editor-style rename would break a watcher.
  const interval = options.intervalMs ?? 5000;
  const draw = () => {
    process.stdout.write("[2J[H");
    render();
    process.stdout.write(`\n  watching ${file} every ${interval / 1000}s — ctrl-c to stop\n`);
  };
  draw();
  const timer = setInterval(draw, interval);
  process.on("SIGINT", () => {
    clearInterval(timer);
    process.exit(0);
  });
  return null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const code = main(process.argv.slice(2));
  if (code !== null) process.exit(code);
}
