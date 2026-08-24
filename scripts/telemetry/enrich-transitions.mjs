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
 *   resolved_model     the model of the turn that emitted the invoking tool call, present
 *                      IFF it was observed (flow-agents#1327). Read off the same
 *                      transcript record as the usage totals, so the two cannot describe
 *                      different turns.
 *   model_attribution  { granularity, attributed, turn_ref?, reason?, source } — the same
 *                      positive-absence discipline for the model dimension.
 *
 * An unattributable transition gets NO `output_tokens` key. Not zero. Zero is a claim
 * about spend and this tool has no evidence for it; the enriched log must never let a gate
 * that was simply never costed read as a gate that was free. Likewise a transition whose
 * model was not observed gets NO `resolved_model` key — no default, no host guess. A
 * fabricated model silently poisons every (gate × model) conclusion drawn afterwards, and
 * unlike an absence it cannot be counted as unknown.
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
 * A CONSEQUENCE, STATED RATHER THAN DISCOVERED: a log enriched by a pre-#1327 build
 * carries a token attribution and no model block, and "already attributed" skips it — so
 * those records stay without a model until someone runs `--reattribute`. The summary
 * counts them (`models_not_enriched`) so the gap is visible in the output rather than
 * inferred from an absence, and the fold reports them as un-enriched rather than as
 * transitions whose model was looked for and not found.
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
  MODEL_ATTRIBUTION_FIELD,
  MODEL_GRANULARITY,
  OUTPUT_TOKENS_FIELD,
  readJsonl,
  RESOLVED_MODEL_FIELD,
  stampAttribution,
  stampModelAttribution,
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
export function readLog(file) {
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
      delete record[MODEL_ATTRIBUTION_FIELD];
      delete record[RESOLVED_MODEL_FIELD];
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
  let withModel = 0;
  let withoutModel = 0;
  const modelCounts = new Map();
  for (const record of pending) {
    const model = attribution.models.get(record);
    if (model) {
      stampModelAttribution(
        record,
        { attributed: true, model: model.model, turn_ref: model.turn_ref },
        { source: ATTRIBUTION_SOURCE },
      );
      withModel += 1;
      modelCounts.set(model.model, (modelCounts.get(model.model) ?? 0) + 1);
    } else {
      const why = attribution.modelReasons.get(record) ?? {};
      stampModelAttribution(
        record,
        { attributed: false, reason: why.reason ?? null, turn_ref: why.turn_ref },
        { source: ATTRIBUTION_SOURCE },
      );
      withoutModel += 1;
    }

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
      // The model dimension, counted separately from the token one because the two have
      // different denominators: a turn's model is readable even when its tokens are
      // already spoken for by an earlier transition (see attributeTokens).
      model_granularity: MODEL_GRANULARITY,
      transitions_with_model: withModel,
      transitions_without_model: withoutModel,
      // Records that carry NO model attribution after this pass — skipped as already
      // token-attributed by a pre-#1327 build, so nothing has ever looked at their
      // model. NOT "no model was found": a preserved record that already carries a
      // model block is not counted here, or an idempotent re-run would report every
      // measured record as unmeasured. `--reattribute` recomputes them.
      models_not_enriched: [...preserved].filter((record) => !record[MODEL_ATTRIBUTION_FIELD]).length,
      turns_reporting_no_model: attribution.turnsReportingNoModel,
      // What was actually observed, so a caller can see the mix rather than trust a
      // headline count. Never a default and never a total.
      models_observed: [...modelCounts]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([model, transitions]) => ({ model, transitions })),
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
    console.log(
      `model ${summary.transitions_with_model} attributed  ${summary.transitions_without_model} unknown (${MODEL_GRANULARITY})` +
        (summary.models_observed.length
          ? `  — ${summary.models_observed.map((entry) => `${entry.model} ${entry.transitions}`).join(", ")}`
          : "  — none observed"),
    );
    // Every turn present and none naming a model is the shape a renamed transcript field
    // would take. Tokens are still attributable, so this is not a refusal — but reporting
    // "0 attributed" without saying why would read as a run that simply had no models.
    if (summary.available_turns && summary.turns_reporting_no_model === summary.available_turns) {
      console.log(
        "note: every usable turn reported no model. The transcript format is internal to Claude Code and changes between releases; nothing is guessed, so the model dimension is unavailable for this window.",
      );
    }
    for (const claim of summary.ambiguous_turn_claims) {
      console.log(`ambiguous: ${claim.transitions} transitions share ${claim.started_at}; the turn was charged to "${claim.awarded_to}" by line order, not by the data`);
    }
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
