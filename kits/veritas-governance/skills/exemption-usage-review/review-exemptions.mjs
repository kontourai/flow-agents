#!/usr/bin/env node
// review-exemptions.mjs — Veritas Governance Kit exemption-usage-review helper (ADR 0022 §3).
//
// PURPOSE. A periodic audit tool that lists every standing `delivery/DECLARED` exemption
// (scope, reason, approver, age since declared_at) and flags stale/overdue entries against a
// configurable threshold, for owner re-confirmation. This is PROCESS VISIBILITY, not
// enforcement: it is read-only, writes nothing outside its own stdout/report output, and its
// own findings never feed back into `scripts/ci/trust-reconcile.js`'s exit code or into
// `delivery/DECLARED` itself. See ADR 0022 §3: "a periodic audit skill/flow that walks
// delivery/DECLARED history (git log --follow -- delivery/DECLARED) merged in a review window
// and surfaces every standing exemption (scope, reason, approver, age) for owner
// re-confirmation — process visibility, not enforcement."
//
// WHAT THIS DOES VERIFY:
//   - Every entry currently present in the live `delivery/DECLARED` JSON array/object is
//     listed with its `scope`, `reason`, `approved_by`, `declared_at`, computed `age_days`,
//     and a `stale` boolean (age_days > --stale-days).
//   - The `git log --follow -- delivery/DECLARED` commit history for the file (within
//     --window-days when given, else full history) is walked and reported as
//     `history_commits` (sha, author, date, subject) — this is a supplementary "how did this
//     file change over time" view, separate from the "what's standing today" listing.
//
// WHAT THIS DOES NOT VERIFY (state plainly, per this kit's honesty convention):
//   - It does NOT verify that any `approved_by` value corresponds to a real, authenticated
//     human approver — that field is free text in `delivery/DECLARED` itself (see
//     docs/README.md "Human-approval evidence: what is and is not enforced"); this tool only
//     reports what the field says, never authenticates it.
//   - It does NOT re-evaluate whether a scope's `ref:`/`commit:`/`author:`/`branch-prefix:`
//     condition currently matches any particular change — that is
//     `scripts/ci/trust-reconcile.js`'s `matchesScope`/`matchesScopeCondition` job (a
//     "does this exemption apply to THIS change" question). This tool answers a different
//     question — "what exemptions are standing at all, and how old are they" — for every
//     entry, regardless of whether any given entry's scope currently matches anything.
//   - It does NOT reconstruct a full point-in-time list of entries that existed at each
//     historical commit and diff them against each other (e.g. it does not detect "entry X
//     was removed then silently re-added with a different reason") — `history_commits` gives
//     the commit-level trail (who changed the file, when) for a human reviewer to inspect
//     with `git show <sha>:delivery/DECLARED` themselves; this tool does not do that
//     per-commit content diffing itself.
//   - It does NOT mutate `delivery/DECLARED`, does not attach evidence, does not run a Flow
//     gate, and has no exit-code-driven pass/fail: this script's own process exit code is 0
//     on any clean parse, regardless of how many entries are flagged stale — staleness is
//     informational output, not a script failure condition.
//
// NO-FORK NOTE: this script intentionally does NOT reuse trust-reconcile.js's
// `matchesScope`/`matchesScopeCondition`/`parseDeclaredMarker` functions. The review lists ALL
// entries unconditionally (it has no "does this scope match the current context" question to
// answer), so it needs only a much simpler "parse the JSON array, compute age" routine, not
// the reconciler's scope-matching engine. This is a deliberate scope difference, not a missed
// reuse opportunity — see SKILL.md.
//
// Usage:
//   node review-exemptions.mjs [--declared-path <path>] [--repo-root <path>]
//     [--stale-days <n>] [--window-days <n>] [--as-of <ISO8601>] [--json]
//
// Exit: 0 on a clean run (parse succeeded, report printed) — even when entries are flagged
// stale. Exit 2 on bad args. Exit 3 when delivery/DECLARED is missing or not valid JSON
// (nothing to review — this is a tool-usage failure, not a staleness finding).

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const DEFAULT_STALE_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const out = {
    declaredPath: undefined,
    repoRoot: process.cwd(),
    staleDays: DEFAULT_STALE_DAYS,
    windowDays: undefined,
    asOf: undefined,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--declared-path") out.declaredPath = argv[++i];
    else if (a === "--repo-root") out.repoRoot = argv[++i];
    else if (a === "--stale-days") out.staleDays = Number(argv[++i]);
    else if (a === "--window-days") out.windowDays = Number(argv[++i]);
    else if (a === "--as-of") out.asOf = argv[++i];
    else if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function usage() {
  return "usage: review-exemptions.mjs [--declared-path <path>] [--repo-root <path>] "
    + "[--stale-days <n>] [--window-days <n>] [--as-of <ISO8601>] [--json]\n";
}

/**
 * Read and parse the live delivery/DECLARED file into a flat array of raw entries.
 * Mirrors trust-reconcile.js's tolerant single-object-or-array shape (a single {scope,...}
 * object OR a JSON array of such objects) WITHOUT reusing its parseDeclaredMarker() function
 * (see NO-FORK NOTE above) — this parse is deliberately simpler: no well-formed/malformed
 * bucketing, no scope-matching, just "read the array, keep what looks like an entry object".
 */
export function readDeclaredEntries(declaredPath) {
  const raw = readFileSync(declaredPath, "utf8");
  const parsed = JSON.parse(raw);
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  return entries.filter((e) => e && typeof e === "object");
}

/** Age in whole days between an ISO8601 `declared_at` and an ISO8601 `asOfIso` "now". */
export function ageDays(declaredAtIso, asOfIso) {
  const declared = new Date(declaredAtIso).getTime();
  const asOf = new Date(asOfIso).getTime();
  if (Number.isNaN(declared) || Number.isNaN(asOf)) return null;
  return Math.floor((asOf - declared) / MS_PER_DAY);
}

/**
 * Build the standing-exemption report rows: one row per delivery/DECLARED entry, with
 * computed age_days and a stale boolean (age_days > staleDays). Entries with an unparsable
 * declared_at get age_days: null, stale: null (never silently coerced to fresh or stale).
 */
export function buildReport(entries, { staleDays, asOfIso }) {
  return entries.map((entry) => {
    const declaredAt = typeof entry.declared_at === "string" ? entry.declared_at : null;
    const age = declaredAt ? ageDays(declaredAt, asOfIso) : null;
    return {
      scope: typeof entry.scope === "string" ? entry.scope : null,
      reason: typeof entry.reason === "string" ? entry.reason : null,
      approved_by: typeof entry.approved_by === "string" ? entry.approved_by : null,
      declared_at: declaredAt,
      age_days: age,
      stale: age === null ? null : age > staleDays,
    };
  });
}

/**
 * Walk `git log --follow -- <declaredRelPath>` history for delivery/DECLARED, optionally
 * bounded to a review window (--window-days before asOfIso). Read-only (`git log`, no
 * mutation). Never throws — a git failure (no repo, no history, shallow clone) degrades to
 * an empty list plus a diagnostic note, never a crash.
 */
export function walkDeclaredHistory(repoRoot, declaredRelPath, { windowDays, asOfIso }) {
  const args = ["log", "--follow", "--date=iso-strict", "--format=%H%x1f%an%x1f%ad%x1f%s"];
  if (windowDays && Number.isFinite(windowDays) && windowDays > 0) {
    const since = new Date(new Date(asOfIso).getTime() - windowDays * MS_PER_DAY).toISOString();
    args.push(`--since=${since}`);
  }
  args.push("--", declaredRelPath);
  try {
    const res = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
    if (!res || res.error || res.status !== 0) {
      return { commits: [], diagnostic: "git log --follow unavailable or failed; history_commits is empty (no historical trail could be walked)" };
    }
    const lines = res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    const commits = lines.map((line) => {
      const [sha, author, date, subject] = line.split("\x1f");
      return { sha, author, date, subject };
    });
    return { commits, diagnostic: null };
  } catch (err) {
    return { commits: [], diagnostic: `git log --follow threw: ${err && err.message ? err.message : String(err)}` };
  }
}

function renderHuman(report, history, opts) {
  const lines = [];
  lines.push(`Exemption usage review — as-of ${opts.asOfIso}, stale threshold ${opts.staleDays} day(s)`);
  lines.push(`PROCESS-ONLY: read-only report. Does not modify delivery/DECLARED or scripts/ci/trust-reconcile.js's behavior.`);
  lines.push("");
  lines.push(`Standing exemptions (${report.length}):`);
  if (report.length === 0) lines.push("  (none)");
  for (const row of report) {
    const staleTag = row.stale === null ? "UNKNOWN-AGE" : row.stale ? "STALE — needs owner re-confirmation" : "fresh";
    lines.push(`  - scope: ${row.scope ?? "(missing)"}`);
    lines.push(`    reason: ${row.reason ?? "(missing)"}`);
    lines.push(`    approved_by: ${row.approved_by ?? "(missing)"}`);
    lines.push(`    declared_at: ${row.declared_at ?? "(missing)"} | age_days: ${row.age_days ?? "n/a"} | ${staleTag}`);
  }
  lines.push("");
  lines.push(`History (git log --follow -- delivery/DECLARED)${opts.windowDays ? ` — last ${opts.windowDays} day(s)` : " — full history"}:`);
  if (history.diagnostic) lines.push(`  NOTE: ${history.diagnostic}`);
  if (history.commits.length === 0 && !history.diagnostic) lines.push("  (no commits found)");
  for (const c of history.commits) {
    lines.push(`  - ${c.sha.slice(0, 12)} ${c.date} ${c.author} — ${c.subject}`);
  }
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }
  const repoRoot = path.resolve(args.repoRoot);
  const declaredPath = args.declaredPath
    ? path.resolve(args.declaredPath)
    : path.join(repoRoot, "delivery", "DECLARED");
  const staleDays = Number.isFinite(args.staleDays) ? args.staleDays : DEFAULT_STALE_DAYS;
  const asOfIso = args.asOf || new Date().toISOString();

  let entries;
  try {
    entries = readDeclaredEntries(declaredPath);
  } catch (err) {
    process.stderr.write(`cannot read/parse delivery/DECLARED at ${declaredPath}: ${err && err.message ? err.message : String(err)}\n`);
    return 3;
  }

  const report = buildReport(entries, { staleDays, asOfIso });
  const declaredRelPath = path.relative(repoRoot, declaredPath) || "delivery/DECLARED";
  const history = walkDeclaredHistory(repoRoot, declaredRelPath, { windowDays: args.windowDays, asOfIso });

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      as_of: asOfIso,
      stale_days: staleDays,
      window_days: args.windowDays ?? null,
      declared_path: declaredPath,
      entries: report,
      history_commits: history.commits,
      history_diagnostic: history.diagnostic,
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderHuman(report, history, { asOfIso, staleDays, windowDays: args.windowDays })}\n`);
  }
  return 0;
}

const isEntry = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isEntry) process.exitCode = main();
