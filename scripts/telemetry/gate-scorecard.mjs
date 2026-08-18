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

/** How far before a transition its invoking turn may sit before the link is a guess. */
const TURN_GRACE_MS = 10 * 60_000;

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
 * Every kit installed under `root`, from the catalog it publishes. Nothing here knows
 * what a builder kit is: a kit declares its flows, a flow declares its gates, and a
 * gate declares what it expects. Scoring is the same operation for all of them.
 *
 * Falls back to scanning for `kits/*​/kit.json` when no catalog is present, so a repo
 * that has kits but has not published a catalog is still measurable.
 */
/**
 * A catalog listing the same kit twice would register its gates twice, turning one
 * unambiguous expectation into two claimants — reporting a phantom collision AND
 * refusing to credit the gate that actually fired. Deduplicate by resolved directory,
 * and take the id from the first entry so the identifier stays stable.
 */
function dedupeKits(kits) {
  const seen = new Map();
  for (const kit of kits) if (!seen.has(kit.dir)) seen.set(kit.dir, kit);
  return [...seen.values()];
}

export function discoverKitDirs(root = process.cwd()) {
  const kitsRoot = path.join(root, "kits");
  const catalogPath = path.join(kitsRoot, "catalog.json");
  if (fs.existsSync(catalogPath)) {
    try {
      const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
      const dirs = dedupeKits(
        (catalog.kits ?? [])
          .map((kit) => ({ id: kit.id ?? null, dir: path.resolve(root, kit.path ?? "") }))
          .filter((kit) => fs.existsSync(kit.dir)),
      );
      if (dirs.length) return dirs;
    } catch {
      // A malformed catalog is not a reason to report zero kits; fall through to a scan.
    }
  }
  if (!fs.existsSync(kitsRoot)) return [];
  return dedupeKits(
    fs
      .readdirSync(kitsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(kitsRoot, entry.name, "kit.json")))
      .map((entry) => ({ id: entry.name, dir: path.join(kitsRoot, entry.name) })),
  );
}

/**
 * The flow definition files a kit declares. A kit.json names its flows explicitly, and
 * that declaration is authoritative — a stray .flow.json in the directory is not part
 * of the kit. Only when there is no kit.json does this fall back to globbing.
 */
function flowFilesForKit(kitDir) {
  const manifest = path.join(kitDir, "kit.json");
  if (fs.existsSync(manifest)) {
    try {
      const kit = JSON.parse(fs.readFileSync(manifest, "utf8"));
      // Authoritative even when it resolves to nothing: a kit that declares a flow
      // whose file was renamed has a broken manifest, and quietly globbing the
      // directory would hide that behind whatever strays happen to sit there.
      return (kit.flows ?? [])
        .map((flow) => path.resolve(kitDir, flow.path ?? ""))
        .filter((file) => fs.existsSync(file));
    } catch {
      // An unreadable manifest is not a declaration; fall through to the glob.
    }
  }
  const flowsDir = path.join(kitDir, "flows");
  if (!fs.existsSync(flowsDir)) return [];
  return fs
    .readdirSync(flowsDir)
    .filter((entry) => entry.endsWith(".flow.json"))
    .map((entry) => path.join(flowsDir, entry));
}

/**
 * Build expectation-id → {gate, step, flow, kit} across one or more kits. This is the
 * derivation the whole tool rests on: the gates it reports are the gates the kits
 * actually declare.
 */
export function buildExpectationIndex(kitDirs, flowIds = null) {
  const kits = (Array.isArray(kitDirs) ? kitDirs : [kitDirs]).map((entry) =>
    typeof entry === "string" ? { id: path.basename(entry), dir: entry } : entry,
  );
  const index = new Map();
  const gates = new Map();
  // Gate names repeat across flows by design — `propose-gate` means something
  // different in `knowledge.synthesize` than in `knowledge.consolidate` — so the
  // registry is keyed by flow AND gate, and a shared name is not a collision.
  //
  // A shared EXPECTATION id is, because a transition names its expectation and
  // nothing else: if two flows' gates both expect `proposal-carries-source-refs`,
  // that id alone cannot say which gate a write belongs to. Those are recorded as
  // ambiguous rather than silently attributed to whichever flow was read last.
  const ambiguousExpectations = [];
  for (const kit of kits) {
    for (const file of flowFilesForKit(kit.dir)) {
      let flow;
      try {
        flow = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      const flowId = flow.id ?? path.basename(file);
      if (flowIds && !flowIds.includes(flowId)) continue;
      for (const [gateName, gate] of Object.entries(flow.gates ?? {})) {
        const expectations = (gate.expects ?? []).map((expectation) => expectation.id);
        // Gate names are only unique within a flow, so key the registry by both. The
        // collision report below is about names that genuinely clash.
        const key = `${flowId}::${gateName}`;
        gates.set(key, {
          key,
          gate: gateName,
          step: gate.step ?? null,
          flow: flowId,
          kit: kit.id,
          expectations,
        });
        for (const id of expectations) {
          const claimants = index.get(id) ?? [];
          if (!claimants.some((claimant) => claimant.key === key)) {
            claimants.push({ key, gate: gateName, step: gate.step ?? null, flow: flowId, kit: kit.id });
          }
          index.set(id, claimants);
        }
      }
    }
  }
  for (const [id, claimants] of index) {
    if (claimants.length > 1) {
      ambiguousExpectations.push({
        expectation: id,
        claimed_by: claimants.map((claimant) => `${claimant.flow}::${claimant.gate}`),
      });
    }
  }
  return { index, gates, ambiguousExpectations };
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
    const fallbackSession = path.basename(file).replace(/\.jsonl$/, "");
    for (const record of readJsonl(file)) {
      const usage = record?.message?.usage;
      const at = Date.parse(record?.timestamp ?? "");
      if (!usage || Number.isNaN(at)) continue;
      const id = record?.message?.id ?? `${file}:${at}`;
      // One API response is logged as several lines sharing a message id and identical
      // usage totals; counting each line triples the tokens.
      turns.push({
        id,
        at,
        output: Number(usage.output_tokens) || 0,
        session: record?.sessionId ?? record?.session_id ?? fallbackSession,
      });
    }
  }
  const deduped = new Map();
  for (const turn of turns) if (!deduped.has(turn.id)) deduped.set(turn.id, turn);
  const ordered = [...deduped.values()].sort((a, b) => a.at - b.at);

  const attributed = new Map();
  const consumed = new Set();
  let matchedTurns = 0;

  // A turn's timestamp is when the model EMITTED the tool call, which precedes the
  // command running — verified live: a transition at 00:45:32 was invoked by a turn
  // stamped 00:45:21. Searching forward from the transition therefore matches nothing,
  // or worse matches the NEXT turn. The invoking turn is the most recent one before it.
  //
  // A turn is consumed once. One turn routinely invokes several transitions, and if
  // each claimed it the total would inflate; and a transition whose turn is already
  // consumed must NOT reach further back, because that older turn belongs to earlier
  // work. Those transitions are disclosed as `transitions_without_turn` instead, so
  // every per-gate cost is a floor rather than an invention.
  const chronological = [...transitions].sort(
    (a, b) => (Date.parse(a.started_at ?? "") || 0) - (Date.parse(b.started_at ?? "") || 0),
  );
  for (const transition of chronological) {
    const start = Date.parse(transition.started_at ?? "");
    if (Number.isNaN(start)) continue;
    // Sibling sessions write their transcripts into the same directory, so matching on
    // time alone imports another run's spend. When the transition names its session,
    // only that session's turns may pay for it.
    const session = transition?.actor?.session_id ?? null;
    let candidate = null;
    for (const turn of ordered) {
      if (turn.at > start) break;
      if (session && turn.session && turn.session !== session) continue;
      candidate = turn;
    }
    if (!candidate) continue;
    if (start - candidate.at > TURN_GRACE_MS) continue;
    if (consumed.has(candidate.id)) continue;
    consumed.add(candidate.id);
    attributed.set(transition, candidate);
    matchedTurns += 1;
  }
  return {
    attributed,
    matchedTurns,
    availableTurns: ordered.length,
    transitionsWithoutTurn: transitions.length - matchedTurns,
  };
}

export function buildScorecard({ transitions, expectationIndex, gateIndex, tokenAttribution, ambiguousExpectations = [] }) {
  const gates = new Map();
  const verbs = new Map();
  const unattributed = [];
  const ambiguous = [];

  // Only gate names that are unique across every declared flow can identify a gate on
  // their own. A name reused by two flows says as little as a shared expectation id
  // does, so it resolves nothing rather than resolving to whichever flow was read
  // first — the file order that would decide it is not even contractually stable.
  const byGateName = new Map();
  const gateNameCounts = new Map();
  for (const declared of gateIndex.values()) {
    gateNameCounts.set(declared.gate, (gateNameCounts.get(declared.gate) ?? 0) + 1);
    if (!byGateName.has(declared.gate)) byGateName.set(declared.gate, declared);
  }
  const uniqueGateName = (name) => (gateNameCounts.get(name) === 1 ? byGateName.get(name) : null);

  for (const record of transitions) {
    const expectation = record?.targets?.expectation;
    const declaredGate = record?.targets?.gate;
    const claimants = (expectation && expectationIndex.get(expectation)) ?? [];
    // One claimant is unambiguous. Several means the id is shared, and the record's own
    // --flow is the only thing that can break the tie; without it the write is recorded
    // as ambiguous rather than assigned to a gate that may not have seen it.
    let mapped = claimants.length === 1 ? claimants[0] : null;
    let unresolved = false;
    if (!mapped && claimants.length > 1) {
      const declaredFlow = record?.targets?.flow;
      const withinFlow = claimants.filter((claimant) => claimant.flow === declaredFlow);
      // One match inside the named flow resolves it. Two means the flow declares the
      // same id on two gates, and naming the flow has not actually narrowed anything.
      mapped = withinFlow.length === 1 ? withinFlow[0] : null;
      if (!mapped) {
        unresolved = true;
        ambiguous.push({
          expectation,
          claimed_by: claimants.map((claimant) => `${claimant.flow}::${claimant.gate}`),
          exit_code: record.exit_code,
        });
      }
    }
    // A write already recorded as unattributable must not then be posted to a gate by
    // its --gate flag: it would be reported as ambiguous AND counted in some gate's
    // tally, cost and tokens, which is worse than either alone.
    if (!mapped && !unresolved && declaredGate) mapped = uniqueGateName(declaredGate);

    if (mapped) {
      if (!gates.has(mapped.key)) {
        gates.set(mapped.key, {
          ...emptyTally(),
          gate: mapped.gate,
          step: mapped.step ?? null,
          flow: mapped.flow ?? null,
          kit: mapped.kit ?? null,
          expectations: {},
        });
      }
      const bucket = gates.get(mapped.key);
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
        const target = mapped ? gates.get(mapped.key) : verbs.get(`${record.command ?? "?"} ${record.verb ?? ""}`.trim());
        target.output_tokens = (target.output_tokens ?? 0) + turn.output;
        target.token_turns = (target.token_turns ?? 0) + 1;
      }
    }
  }

  // Scope is DERIVED, not declared. A flow the window never touched was never in scope
  // to fire, so listing its gates as "never invoked" would bury the one finding that
  // matters — a gate that sat idle inside a flow the run actually ran. Those are
  // reported; the untouched flows are counted.
  const exercisedFlows = new Set([...gates.values()].map((bucket) => bucket.flow));
  const flowsNotExercised = new Set();
  for (const [key, declared] of gateIndex) {
    if (gates.has(key)) continue;
    if (!exercisedFlows.has(declared.flow)) {
      flowsNotExercised.add(declared.flow);
      continue;
    }
    gates.set(key, {
      ...emptyTally(),
      gate: declared.gate,
      step: declared.step,
      flow: declared.flow,
      kit: declared.kit,
      expectations: {},
      never_invoked: true,
    });
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
    scope: {
      kits: [...new Set([...gateIndex.values()].map((declared) => declared.kit))].filter(Boolean),
      gates_declared: gateIndex.size,
      flows_exercised: [...exercisedFlows].filter(Boolean).sort(),
      flows_not_exercised: flowsNotExercised.size,
    },
    coverage: {
      gate_attributed: [...gates.values()].reduce((sum, bucket) => sum + bucket.calls, 0),
      verb_attributed: [...verbs.values()].reduce((sum, bucket) => sum + bucket.calls, 0),
      expectations_naming_no_declared_gate: unattributed.length,
      ambiguous_writes: ambiguous.length,
      shared_expectation_ids: ambiguousExpectations.length,
      tokens: tokenAttribution
        ? {
            matched_turns: tokenAttribution.matchedTurns,
            available_turns: tokenAttribution.availableTurns,
            // Transitions that share a turn with an earlier one get no tokens of their
            // own, so every per-gate cost here is a FLOOR. Stated, not smoothed over.
            transitions_without_turn: tokenAttribution.transitionsWithoutTurn,
          }
        : null,
    },
    ambiguous_expectations: ambiguousExpectations,
    ambiguous,
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
  // No kit is privileged: with no --kit, every kit the repo publishes is scored.
  const kitDirs = options.kit ? [{ id: path.basename(options.kit), dir: options.kit }] : discoverKitDirs(process.cwd());
  const transitions = readJsonl(transitionsFile).filter((record) => record?.kind === "kontour.flow-agents.transition");
  const { index: expectationIndex, gates: gateIndex, ambiguousExpectations } = buildExpectationIndex(kitDirs, options.flows ?? null);

  if (!gateIndex.size) {
    const where = options.kit ? options.kit : `${path.join(process.cwd(), "kits")} (no --kit given)`;
    const scope = options.flows ? ` for flow(s) ${options.flows.join(", ")}` : "";
    console.error(`gate-scorecard: no kit declared any gate under ${where}${scope}`);
    return 2;
  }

  const tokenAttribution = options.transcripts.length ? attributeTokens(transitions, options.transcripts) : null;
  const scorecard = buildScorecard({ transitions, expectationIndex, gateIndex, tokenAttribution, ambiguousExpectations });

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

  console.log(
    `transitions: ${scorecard.window.transitions}  kits: ${scorecard.scope.kits.join(", ") || "—"}  ` +
      `gates declared: ${scorecard.scope.gates_declared}  flows exercised: ${scorecard.scope.flows_exercised.length}` +
      (scorecard.scope.flows_not_exercised ? ` (${scorecard.scope.flows_not_exercised} not exercised)` : ""),
  );
  for (const gate of scorecard.gates) {
    const cost = gate.output_tokens ? `  ${gate.output_tokens} tok` : "";
    const note = gate.never_invoked ? "  never invoked in window" : "";
    const label = `${gate.flow ?? "?"}/${gate.gate}`;
    console.log(`  ${label.padEnd(42)} calls ${String(gate.calls).padStart(3)}  refused/error ${String(gate.refused_or_error).padStart(3)}${cost}${note}`);
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
  for (const shared of scorecard.ambiguous_expectations) {
    console.log(`shared id: "${shared.expectation}" is expected by ${shared.claimed_by.join(" and ")} — a write naming it needs --flow to attribute`);
  }
  if (scorecard.ambiguous.length) {
    console.log(`ambiguous: ${scorecard.ambiguous.length} write(s) named a shared expectation id with no --flow to disambiguate`);
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
