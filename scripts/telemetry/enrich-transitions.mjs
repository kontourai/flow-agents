#!/usr/bin/env node
/**
 * enrich-transitions.mjs — stamp output-token attribution onto transition records.
 *
 * Console's per-gate scorecard (console#279) has declared `output_tokens_floor` and
 * `attribution.transitions_without_turn` since it shipped, and has reported
 * `cost_availability: "activity_only"` for every gate ever since — invocations and
 * durations real, cost explicitly unavailable — because nothing put an attribution on the
 * records it ingests. This is that producer (flow-agents#1320).
 *
 * WHY A SEPARATE PASS RATHER THAN THE EMITTER
 *
 * See the long note in `token-attribution.mjs`. In short: "at most one transition per
 * turn" is a decision about a SET, the emitter's write is a best-effort append that must
 * never affect the command it describes, and the transcript is a host-private format the
 * emitter is deliberately independent of. The emitter therefore stamps nothing and guesses
 * nothing; this runs afterwards, when the answer is knowable, and writes only what it can
 * prove.
 *
 * WHAT IT WRITES — two fields, additive and optional, on records that already exist:
 *
 *   output_tokens      the floor, present IFF a turn was won. Console's wire contract
 *                      (`ConsoleTransitionRecord.output_tokens`) already declares it, so
 *                      this name is not a choice this tool gets to make.
 *   token_attribution  { granularity, attributed, turn_ref?, reason?, ambiguous?, source }
 *                      the label travelling with the number, and — for an unattributable
 *                      transition — a POSITIVE statement that it was examined and had no
 *                      turn to charge. That is what makes `transitions_without_turn`
 *                      emitted rather than inferred from a missing field, which is the
 *                      only way a consumer can tell an un-enriched log from a measured
 *                      one.
 *
 * An unattributable transition gets NO `output_tokens` key. Not zero. Zero is a claim
 * about spend and this tool has no evidence for it; the enriched log must never let a gate
 * that was simply never costed read as a gate that was free.
 *
 * SAFETY. The rewrite goes to a temp file in the same directory and is renamed over the
 * target, so an interrupted run leaves the original intact rather than a truncated log.
 * Records that are not transition records pass through byte-for-byte, in their original
 * order, as do unparseable lines — a log being appended to live routinely ends in a
 * half-written line and losing it would be a worse outcome than not enriching it.
 *
 * RE-RUNS. A record already carrying an attribution is left alone and its turn is
 * pre-consumed, so "at most one transition per turn" holds ACROSS runs and not merely
 * within one. `--reattribute` discards the stored attributions and recomputes from
 * scratch; it is opt-in because a re-run against a smaller transcript set would otherwise
 * silently downgrade attributed records to unattributable.
 *
 * Usage:
 *   node scripts/telemetry/enrich-transitions.mjs --transcript <jsonl> [--transcript ...]
 *        [--transitions <file>] [--out <file>] [--reattribute] [--dry-run] [--json]
 *
 * Exit codes: 0 enriched, 2 usage error, 3 nothing to measure (no log, no records, or no
 * usable turns — absence is reported, never rendered as a tidy run of zeroes).
 */

import fs from "node:fs";
import path from "node:path";

import { sharedRepoRoot } from "./gate-scorecard.mjs";
import {
  ATTRIBUTION_GRANULARITY,
  attributeTokens,
  OUTPUT_TOKENS_FIELD,
  readJsonl,
  stampAttribution,
  TOKEN_ATTRIBUTION_FIELD,
} from "./token-attribution.mjs";

const TRANSITION_SCHEMA = "kontour.flow-agents.transition";
/** Names the derivation, not the machine: no path, no session, nothing host-specific. */
const ATTRIBUTION_SOURCE = "host-transcript-turn";

function parseArgs(argv) {
  const options = { transcripts: [], json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = () => argv[(index += 1)];
    if (token === "--transitions") options.transitions = value();
    else if (token === "--transcript") options.transcripts.push(value());
    else if (token === "--out") options.out = value();
    else if (token === "--reattribute") options.reattribute = true;
    else if (token === "--dry-run") options.dryRun = true;
    else if (token === "--json") options.json = true;
    else if (token === "--help" || token === "-h") options.help = true;
    else throw new Error(`unknown option: ${token}`);
  }
  return options;
}

/**
 * Read the log preserving every line's identity: parsed transition records get enriched,
 * everything else is replayed verbatim. `raw` is kept for the non-transition lines so a
 * foreign or half-written line survives the rewrite unchanged rather than being
 * re-serialized (or dropped) by a tool that does not understand it.
 */
function readLog(file) {
  const lines = [];
  const transitions = [];
  let unparseable = 0;
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      unparseable += 1;
      lines.push({ raw: line });
      continue;
    }
    if (parsed?.schema !== TRANSITION_SCHEMA) {
      lines.push({ raw: line });
      continue;
    }
    lines.push({ record: parsed });
    transitions.push(parsed);
  }
  return { lines, transitions, unparseable };
}

export function enrich({ lines, transitions, transcripts, reattribute = false }) {
  // A stored attribution is evidence that a turn is already spoken for. Honouring it is
  // what makes the one-turn-one-transition rule survive a second pass; `--reattribute`
  // drops the lot deliberately and recomputes.
  const preConsumedTurnRefs = new Set();
  const preserved = new Set();
  let unlabelled = 0;
  for (const record of transitions) {
    const block = record[TOKEN_ATTRIBUTION_FIELD];
    if (!block || typeof block !== "object") {
      // A number with no label: some other writer put `output_tokens` here. This tool did
      // not write it and cannot say what it means, so it does not overwrite it and does
      // not delete it — it reports it. Silently clearing another producer's figure would
      // turn a measured gate into an unmeasured one with no trace of the change.
      if (record[OUTPUT_TOKENS_FIELD] !== undefined) {
        preserved.add(record);
        unlabelled += 1;
      }
      continue;
    }
    if (reattribute) {
      delete record[TOKEN_ATTRIBUTION_FIELD];
      delete record[OUTPUT_TOKENS_FIELD];
      continue;
    }
    preserved.add(record);
    if (block.attributed === true && typeof block.turn_ref === "string") preConsumedTurnRefs.add(block.turn_ref);
  }

  const pending = transitions.filter((record) => !preserved.has(record));
  const attribution = attributeTokens(pending, transcripts, { preConsumedTurnRefs });

  let attributed = 0;
  let withoutTurn = 0;
  let outputTokensFloor = 0;
  for (const record of pending) {
    const turn = attribution.attributed.get(record);
    if (turn) {
      stampAttribution(
        record,
        { attributed: true, output: turn.output, turn_ref: turn.ref, ambiguous: turn.ambiguous === true },
        { source: ATTRIBUTION_SOURCE },
      );
      attributed += 1;
      outputTokensFloor += turn.output;
    } else {
      const why = attribution.reasons.get(record) ?? {};
      stampAttribution(
        record,
        { attributed: false, reason: why.reason ?? null, turn_ref: why.turn_ref, ambiguous: why.ambiguous === true },
        { source: ATTRIBUTION_SOURCE },
      );
      withoutTurn += 1;
    }
  }

  const text = `${lines.map((line) => (line.raw !== undefined ? line.raw : JSON.stringify(line.record))).join("\n")}\n`;
  return {
    text,
    attribution,
    summary: {
      granularity: ATTRIBUTION_GRANULARITY,
      transitions: transitions.length,
      already_attributed: preserved.size - unlabelled,
      unlabelled_attributions: unlabelled,
      newly_examined: pending.length,
      transitions_with_turn: attributed,
      // Emitted, not inferred: each of these records now SAYS it has no turn.
      transitions_without_turn: withoutTurn,
      // A floor over the records this pass stamped. It is output tokens only — roughly
      // 6.6% of spend on this repo's own corpus, and not proportional to it — and it
      // excludes every transition above that had no turn to charge. It is not a total and
      // it is not currency.
      output_tokens_floor: outputTokensFloor,
      available_turns: attribution.availableTurns,
      sidechain_turns_excluded: attribution.sidechainTurnsExcluded,
      ambiguous_turn_claims: attribution.ambiguousTurnClaims,
    },
  };
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`enrich-transitions: ${error.message}`);
    return 2;
  }
  if (options.help) {
    console.log(
      "Usage: enrich-transitions.mjs --transcript <jsonl> [--transcript ...] [--transitions <file>] [--out <file>] [--reattribute] [--dry-run] [--json]",
    );
    return 0;
  }
  if (!options.transcripts.length) {
    // Never auto-discovered. Binding a transition log to a session transcript is a claim
    // about which session ran these commands, and no cwd/mtime/"most recent" heuristic can
    // make that claim honestly (flow-agents#922's boundary). The caller says which.
    console.error("enrich-transitions: --transcript is required; the session binding is never inferred");
    return 2;
  }

  const transitionsFile =
    options.transitions ?? path.join(sharedRepoRoot(process.cwd()), ".flow-agents", "telemetry", "transitions.jsonl");
  if (!fs.existsSync(transitionsFile)) {
    console.error(`enrich-transitions: no transition log at ${transitionsFile}. Nothing has been measured — this is not a clean result.`);
    return 3;
  }
  const { lines, transitions, unparseable } = readLog(transitionsFile);
  if (!transitions.length) {
    console.error(`enrich-transitions: ${transitionsFile} holds no transition records${unparseable ? ` (${unparseable} unparseable line(s))` : ""}. Nothing has been measured.`);
    return 3;
  }
  for (const transcript of options.transcripts) {
    if (!fs.existsSync(transcript)) {
      console.error(`enrich-transitions: transcript not found: ${transcript}`);
      return 2;
    }
  }

  const result = enrich({ lines, transitions, transcripts: options.transcripts, reattribute: options.reattribute });
  // A renamed field, a moved path or a typo'd --transcript all converge on "no turns" —
  // which, if written, would stamp every record `attributed: false` and publish a
  // permanent, authoritative-looking zero. Refuse instead.
  if (result.attribution.availableTurns === 0) {
    console.error(
      "enrich-transitions: the transcript(s) yielded no usable turns. The transcript format is internal to Claude Code and changes between releases; nothing is stamped rather than stamping every record as unattributable.",
    );
    return 3;
  }

  const summary = { ...result.summary, transitions_file: transitionsFile, unparseable_lines: unparseable };
  if (!options.dryRun) {
    const out = options.out ?? transitionsFile;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    // Same-directory temp + rename: an interrupted run leaves the original log intact
    // rather than a truncated one. A telemetry tool that can destroy the telemetry is a
    // worse instrument than no tool.
    const temp = `${out}.enrich-${process.pid}.tmp`;
    fs.writeFileSync(temp, result.text, "utf8");
    fs.renameSync(temp, out);
    summary.written_to = out;
  }

  if (options.json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(
      `transitions ${summary.transitions}  with turn ${summary.transitions_with_turn}  without turn ${summary.transitions_without_turn}` +
        (summary.already_attributed ? `  already attributed ${summary.already_attributed}` : "") +
        `  output-tokens floor ${summary.output_tokens_floor} (${ATTRIBUTION_GRANULARITY}, not a total, not currency)`,
    );
    for (const claim of summary.ambiguous_turn_claims) {
      console.log(`ambiguous: ${claim.transitions} transitions share ${claim.started_at}; the turn was charged to "${claim.awarded_to}" by line order, not by the data`);
    }
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
