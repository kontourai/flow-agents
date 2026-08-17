#!/usr/bin/env node
/**
 * Gate scorecard — derive per-gate cost and outcome from the transition log.
 *
 * The first scorecard over these gates was assembled by hand from a TSV an operator
 * appended to after every call. This replaces that with a derivation over
 * `.kontourai/telemetry/transitions.jsonl` (written by the CLI itself; see
 * src/transition-log.ts) plus the kit's own flow definitions.
 *
 * Two rules this tool holds itself to, because the defects it exists to find are the
 * same ones a careless analyzer commits:
 *
 *   1. The expectation → gate mapping is DERIVED from the kit's flow definitions, never
 *      hardcoded here. A table in this file would drift silently from the flows and
 *      report gates that no longer exist under names nobody uses.
 *   2. Anything it cannot attribute is REPORTED, not dropped. A scorecard that quietly
 *      discards a third of the run reads as full coverage of a smaller problem. The
 *      `coverage` block and `unattributed` list exist so an empty finding and an
 *      unexamined one never look alike.
 *
 * Usage:
 *   node scripts/telemetry/gate-scorecard.mjs [--transitions <file>] [--kit <dir>]
 *        [--transcript <jsonl>]... [--out <file>] [--trend <file>] [--json]
 */

import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const options = { transcripts: [], json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = () => argv[(index += 1)];
    if (token === "--transitions") options.transitions = value();
    else if (token === "--kit") options.kit = value();
    else if (token === "--flow") (options.flows ??= []).push(value());
    else if (token === "--transcript") options.transcripts.push(value());
    else if (token === "--out") options.out = value();
    else if (token === "--trend") options.trend = value();
    else if (token === "--json") options.json = true;
    else if (token === "--help" || token === "-h") options.help = true;
    else throw new Error(`unknown option: ${token}`);
  }
  return options;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const records = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // A truncated final line is normal for a log being appended to live.
    }
  }
  return records;
}

/**
 * Build expectation-id → {gate, step} from every flow definition in the kit. This is
 * the derivation the whole tool rests on: the gates it reports are the gates the kit
 * actually declares.
 */
export function buildExpectationIndex(kitDir, flowIds = null) {
  const flowsDir = path.join(kitDir, "flows");
  const index = new Map();
  const gates = new Map();
  if (!fs.existsSync(flowsDir)) return { index, gates };
  for (const entry of fs.readdirSync(flowsDir)) {
    if (!entry.endsWith(".flow.json")) continue;
    let flow;
    try {
      flow = JSON.parse(fs.readFileSync(path.join(flowsDir, entry), "utf8"));
    } catch {
      continue;
    }
    // A kit declares several flows; a scorecard for one of them must not list another
    // flow's gates as "never invoked" — they were never in scope to invoke.
    if (flowIds && !flowIds.includes(flow.id)) continue;
    for (const [gateName, gate] of Object.entries(flow.gates ?? {})) {
      const expectations = (gate.expects ?? []).map((expectation) => expectation.id);
      gates.set(gateName, { gate: gateName, step: gate.step ?? null, flow: flow.id ?? entry, expectations });
      for (const id of expectations) index.set(id, { gate: gateName, step: gate.step ?? null });
    }
  }
  return { index, gates };
}

function emptyTally() {
  return { calls: 0, ok: 0, refused_or_error: 0, usage: 0, duration_ms: 0, exit_codes: {} };
}

function tally(bucket, record) {
  bucket.calls += 1;
  bucket.duration_ms += Number(record.duration_ms) || 0;
  const code = String(record.exit_code);
  bucket.exit_codes[code] = (bucket.exit_codes[code] ?? 0) + 1;
  if (record.outcome === "ok") bucket.ok += 1;
  else if (record.outcome === "usage") bucket.usage += 1;
  else bucket.refused_or_error += 1;
}

/**
 * Attribute per-turn output tokens from a host transcript to transitions by wall-clock
 * containment: a turn whose usage was recorded while a transition was in flight paid
 * for that transition. Approximate by construction — a turn that also did other work
 * is counted whole — so the result is reported as an attribution with its own turn
 * count rather than as a measurement.
 */
export function attributeTokens(transitions, transcriptFiles) {
  const turns = [];
  for (const file of transcriptFiles) {
    for (const record of readJsonl(file)) {
      const usage = record?.message?.usage;
      const at = Date.parse(record?.timestamp ?? "");
      if (!usage || Number.isNaN(at)) continue;
      const id = record?.message?.id ?? `${file}:${at}`;
      // One API response is logged as several lines sharing a message id and identical
      // usage totals; counting each line triples the tokens.
      turns.push({ id, at, output: Number(usage.output_tokens) || 0 });
    }
  }
  const deduped = new Map();
  for (const turn of turns) if (!deduped.has(turn.id)) deduped.set(turn.id, turn);
  const ordered = [...deduped.values()].sort((a, b) => a.at - b.at);

  const attributed = new Map();
  let matchedTurns = 0;
  for (const transition of transitions) {
    const start = Date.parse(transition.started_at ?? "");
    if (Number.isNaN(start)) continue;
    const end = start + (Number(transition.duration_ms) || 0);
    // The turn that invoked a transition records its usage when the turn ends, i.e.
    // at or after the transition completes. Take the first turn ending at/after it.
    const turn = ordered.find((candidate) => candidate.at >= start);
    if (!turn || turn.at > end + 120_000) continue;
    attributed.set(transition, turn);
    matchedTurns += 1;
  }
  return { attributed, matchedTurns, availableTurns: ordered.length };
}

export function buildScorecard({ transitions, expectationIndex, gateIndex, tokenAttribution }) {
  const gates = new Map();
  const verbs = new Map();
  const unattributed = [];

  for (const record of transitions) {
    const expectation = record?.targets?.expectation;
    const declaredGate = record?.targets?.gate;
    const mapped = (expectation && expectationIndex.get(expectation)) ?? null;
    const gateName = mapped?.gate ?? (gateIndex.has(declaredGate) ? declaredGate : null);

    if (gateName) {
      if (!gates.has(gateName)) gates.set(gateName, { ...emptyTally(), gate: gateName, step: gateIndex.get(gateName)?.step ?? null, expectations: {} });
      const bucket = gates.get(gateName);
      tally(bucket, record);
      if (expectation) bucket.expectations[expectation] = (bucket.expectations[expectation] ?? 0) + 1;
    } else {
      const key = `${record.command ?? "?"} ${record.verb ?? ""}`.trim();
      if (!verbs.has(key)) verbs.set(key, { ...emptyTally(), verb: key });
      tally(verbs.get(key), record);
      // An evidence write naming an expectation no kit flow declares is a real finding,
      // not noise: either the kit moved or the operator invented an id.
      if (expectation) unattributed.push({ expectation, command: record.command ?? null, exit_code: record.exit_code });
    }

    if (tokenAttribution) {
      const turn = tokenAttribution.attributed.get(record);
      if (turn) {
        const target = gateName ? gates.get(gateName) : verbs.get(`${record.command ?? "?"} ${record.verb ?? ""}`.trim());
        target.output_tokens = (target.output_tokens ?? 0) + turn.output;
        target.token_turns = (target.token_turns ?? 0) + 1;
      }
    }
  }

  // Declared-but-never-invoked is the most interesting cell on the card: a gate that
  // never fired in the window costs nothing and proves nothing.
  for (const [gateName, declared] of gateIndex) {
    if (!gates.has(gateName)) gates.set(gateName, { ...emptyTally(), gate: gateName, step: declared.step, expectations: {}, never_invoked: true });
  }

  const times = transitions.map((record) => Date.parse(record.started_at ?? "")).filter((value) => !Number.isNaN(value));
  return {
    schema_version: "1.0",
    kind: "kontour.flow-agents.gate-scorecard",
    generated_at: new Date().toISOString(),
    window: {
      transitions: transitions.length,
      from: times.length ? new Date(Math.min(...times)).toISOString() : null,
      to: times.length ? new Date(Math.max(...times)).toISOString() : null,
    },
    coverage: {
      gate_attributed: [...gates.values()].reduce((sum, bucket) => sum + bucket.calls, 0),
      verb_attributed: [...verbs.values()].reduce((sum, bucket) => sum + bucket.calls, 0),
      expectations_naming_no_declared_gate: unattributed.length,
      tokens: tokenAttribution
        ? { matched_turns: tokenAttribution.matchedTurns, available_turns: tokenAttribution.availableTurns }
        : null,
    },
    gates: [...gates.values()].sort((a, b) => b.calls - a.calls || a.gate.localeCompare(b.gate)),
    verbs: [...verbs.values()].sort((a, b) => b.calls - a.calls),
    unattributed,
  };
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log("Usage: gate-scorecard.mjs [--transitions <file>] [--kit <dir>] [--transcript <jsonl>]... [--out <file>] [--trend <file>] [--json]");
    return 0;
  }

  const transitionsFile = options.transitions ?? path.join(process.cwd(), ".kontourai", "telemetry", "transitions.jsonl");
  const kitDir = options.kit ?? path.join(process.cwd(), "kits", "builder");
  const transitions = readJsonl(transitionsFile).filter((record) => record?.kind === "kontour.flow-agents.transition");
  const { index: expectationIndex, gates: gateIndex } = buildExpectationIndex(kitDir, options.flows ?? null);

  if (!gateIndex.size) {
    const scope = options.flows ? ` for flow(s) ${options.flows.join(", ")}` : "";
    console.error(`gate-scorecard: no gate definitions found under ${path.join(kitDir, "flows")}${scope} — check --kit/--flow`);
    return 2;
  }

  const tokenAttribution = options.transcripts.length ? attributeTokens(transitions, options.transcripts) : null;
  const scorecard = buildScorecard({ transitions, expectationIndex, gateIndex, tokenAttribution });

  if (options.out) {
    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    fs.writeFileSync(options.out, `${JSON.stringify(scorecard, null, 2)}\n`, "utf8");
  }
  if (options.trend) {
    fs.mkdirSync(path.dirname(options.trend), { recursive: true });
    fs.appendFileSync(options.trend, `${JSON.stringify(scorecard)}\n`, "utf8");
  }
  if (options.json || !options.out) {
    console.log(JSON.stringify(scorecard, null, 2));
    return 0;
  }

  console.log(`transitions: ${scorecard.window.transitions}  gates declared: ${gateIndex.size}`);
  for (const gate of scorecard.gates) {
    const cost = gate.output_tokens ? `  ${gate.output_tokens} tok` : "";
    const note = gate.never_invoked ? "  never invoked in window" : "";
    console.log(`  ${gate.gate.padEnd(24)} calls ${String(gate.calls).padStart(3)}  refused/error ${String(gate.refused_or_error).padStart(3)}${cost}${note}`);
  }
  // Verbs are not gates, but they are where the run's cost actually went in the one
  // window measured so far. Printing gates alone would report a third of the work.
  if (scorecard.verbs.length) {
    console.log(`non-gate transitions (${scorecard.coverage.verb_attributed} calls):`);
    for (const verb of scorecard.verbs) {
      const cost = verb.output_tokens ? `  ${verb.output_tokens} tok` : "";
      console.log(`  ${verb.verb.padEnd(36)} calls ${String(verb.calls).padStart(3)}  refused/error ${String(verb.refused_or_error).padStart(3)}${cost}`);
    }
  }
  if (scorecard.unattributed.length) {
    const ids = [...new Set(scorecard.unattributed.map((entry) => entry.expectation))];
    console.log(`unattributed: ${scorecard.unattributed.length} evidence write(s) named an expectation no declared gate expects — ${ids.join(", ")}`);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
