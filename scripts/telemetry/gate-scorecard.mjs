#!/usr/bin/env node
/**
 * Gate scorecard — derive per-gate cost and outcome from the transition log.
 *
 * The first scorecard over these gates was assembled by hand from a TSV an operator
 * appended to after every call. This replaces that with a derivation over
 * `.flow-agents/telemetry/transitions.jsonl` (written by the CLI itself; see
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

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  ATTRIBUTION_GRANULARITY,
  attributeTokens,
  attributionFromRecords,
  MODEL_GRANULARITY,
  readJsonl,
  TURN_GRACE_MS,
} from "./token-attribution.mjs";

// The attribution rule lives in ONE module, imported by this fold and by
// `enrich-transitions.mjs`, the producer that writes it onto the records. It used to live
// here; a second copy over there would be the #1300/#1302/#1307/#1312 failure again — two
// components independently encoding one contract, drifting inside a release, with nothing
// to say which number was right. Re-exported because it is part of this module's tested
// surface and callers already import it from here.
export { attributeTokens, TURN_GRACE_MS };

/** Mirrors the writer's root resolution so reader and writer cannot disagree. */
export function sharedRepoRoot(cwd) {
  try {
    const env = { ...process.env };
    for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_CEILING_DIRECTORIES"]) delete env[key];
    const out = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out ? path.dirname(path.resolve(cwd, out)) : cwd;
  } catch {
    return cwd;
  }
}

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
  const composed = [];
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
      // A step may delegate to another flow (`uses_flow`). Its gates are declared over
      // there but they run as part of THIS flow, so a run of this flow must be able to
      // attribute them — otherwise a builder.build run reports a third of its gates as
      // belonging to a flow it never started, and its own scope reads as unexercised.
      for (const step of flow.steps ?? []) {
        if (typeof step?.uses_flow === "string") composed.push({ host: flowId, guest: step.uses_flow, kit: kit.id });
      }
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
  // Re-home composed gates: declared by the guest flow, exercised by the host.
  for (const { host, guest, kit } of composed) {
    for (const declared of [...gates.values()]) {
      if (declared.flow !== guest) continue;
      const key = `${host}::${declared.gate}`;
      if (gates.has(key)) continue;
      gates.set(key, { ...declared, key, flow: host, kit: kit ?? declared.kit, composed_from: guest });
      for (const id of declared.expectations) {
        const claimants = index.get(id) ?? [];
        if (!claimants.some((claimant) => claimant.key === key)) {
          claimants.push({ key, gate: declared.gate, step: declared.step, flow: host, kit: kit ?? declared.kit });
        }
        index.set(id, claimants);
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
  return { calls: 0, ok: 0, advanced: 0, awaiting: 0, refused_or_error: 0, usage: 0, duration_ms: 0, exit_codes: {} };
}

function tally(bucket, record) {
  bucket.calls += 1;
  bucket.duration_ms += Number(record.duration_ms) || 0;
  const code = String(record.exit_code);
  bucket.exit_codes[code] = (bucket.exit_codes[code] ?? 0) + 1;
  // The gate's own verdict wins over the process exit code, because `workflow evidence`
  // returns 0 whether the gate advanced or is still awaiting the rest of its
  // expectations. Counting exit codes alone reports a refusing gate as a pass — and
  // partial satisfaction is the ordinary path, not an edge case.
  if (record.gate_outcome === "advanced") bucket.advanced = (bucket.advanced ?? 0) + 1;
  else if (record.gate_outcome === "awaiting") bucket.awaiting = (bucket.awaiting ?? 0) + 1;

  if (record.outcome === "ok") bucket.ok += 1;
  else if (record.outcome === "usage") bucket.usage += 1;
  else bucket.refused_or_error += 1;
}

/**
 * Split one bucket's tally by the model that invoked each transition — flow-agents#1327.
 *
 * The pooled per-gate figure answers "is this gate worth it on average over whatever mix
 * of models happened to run", and a decision to drop a gate taken on that number drops it
 * for every model at once. Gate value is plausibly model-dependent, so the honest unit is
 * (gate × model) and this is where it becomes expressible.
 *
 * THREE POPULATIONS, KEPT APART, because collapsing any two of them is the failure this
 * whole module is built to avoid:
 *
 *   by_model[]              one entry per OBSERVED model. Only models. There is no
 *                           `model: "unknown"` row, because a reader summing the column
 *                           would then be summing a non-model as if it were one.
 *   calls_without_model     examined, and no model was observable. A measured absence.
 *   calls_model_not_enriched nothing ever looked. A pre-#1327 log, or none at all.
 *
 * A gate whose calls are all in the last two buckets carries an EMPTY `by_model` and its
 * pooled tally: unknown, never a per-model verdict inferred from a pooled one.
 */
function modelBucket(bucket, model) {
  bucket.by_model ??= new Map();
  if (!bucket.by_model.has(model)) bucket.by_model.set(model, { ...emptyTally(), model });
  return bucket.by_model.get(model);
}

/** Map → sorted array, once, at the end. Buckets are built as Maps for O(1) lookup. */
function finalizeModels(bucket) {
  if (bucket.by_model instanceof Map) {
    bucket.by_model = [...bucket.by_model.values()].sort(
      (a, b) => b.calls - a.calls || a.model.localeCompare(b.model),
    );
  } else bucket.by_model ??= [];
  bucket.calls_without_model ??= 0;
  bucket.calls_model_not_enriched ??= 0;
  return bucket;
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

    const target = mapped ? gates.get(mapped.key) : verbs.get(`${record.command ?? "?"} ${record.verb ?? ""}`.trim());

    // The model dimension. `models` holds an observation; `modelReasons` holds a measured
    // absence; a record in neither was never examined. Those are three different states
    // and each gets its own counter — a gate whose model was never looked for must not
    // read the same as one whose model was looked for and not found.
    const observedModel = tokenAttribution?.models?.get(record) ?? null;
    if (observedModel) {
      tally(modelBucket(target, observedModel.model), record);
    } else if (tokenAttribution?.modelReasons?.has(record)) {
      target.calls_without_model = (target.calls_without_model ?? 0) + 1;
    } else {
      target.calls_model_not_enriched = (target.calls_model_not_enriched ?? 0) + 1;
    }

    if (tokenAttribution) {
      const turn = tokenAttribution.attributed.get(record);
      if (turn) {
        target.output_tokens = (target.output_tokens ?? 0) + turn.output;
        target.token_turns = (target.token_turns ?? 0) + 1;
        // The per-model floor is a floor twice over: output tokens only, and only for the
        // transitions that won their turn. Carried per model so the cost side of a
        // (gate × model) comparison is not silently pooled either.
        if (observedModel) {
          const perModel = modelBucket(target, observedModel.model);
          perModel.output_tokens = (perModel.output_tokens ?? 0) + turn.output;
          perModel.token_turns = (perModel.token_turns ?? 0) + 1;
        }
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
      unparseable_lines: 0,
      expectations_naming_no_declared_gate: unattributed.length,
      ambiguous_writes: ambiguous.length,
      shared_expectation_ids: ambiguousExpectations.length,
      tokens: tokenAttribution
        ? {
            note: "output tokens only — roughly 6.6% of spend, and not proportional to it. Not cost.",
            granularity: ATTRIBUTION_GRANULARITY,
            // Which of the two equivalent readings produced these numbers: a transcript
            // this tool parsed itself, or an attribution a producer already stamped onto
            // the records. They agree by construction — one module computes both — and a
            // test pins that agreement over the live corpus.
            source: tokenAttribution.source ?? "transcript",
            matched_turns: tokenAttribution.matchedTurns,
            available_turns: tokenAttribution.availableTurns,
            sidechain_turns_excluded: tokenAttribution.sidechainTurnsExcluded,
            // Transitions that share a turn with an earlier one get no tokens of their
            // own, so every per-gate cost here is a FLOOR. Stated, not smoothed over.
            transitions_without_turn: tokenAttribution.transitionsWithoutTurn,
            // Records nothing ever attributed. NOT "no turn": no one looked. Folding the
            // two together makes an un-enriched log read as a measured one whose gates
            // happened to be free.
            ...(tokenAttribution.transitionsNotEnriched === undefined
              ? {}
              : { transitions_not_enriched: tokenAttribution.transitionsNotEnriched }),
            ...(tokenAttribution.malformedAttributions
              ? { malformed_attributions: tokenAttribution.malformedAttributions }
              : {}),
            // Turns claimed by two transitions stamped at the SAME instant: which one is
            // charged follows line order, not the data. Reported rather than presented as
            // a derivation.
            ambiguous_turn_claims:
              tokenAttribution.ambiguousTurnClaims?.length ?? tokenAttribution.ambiguousAttributions ?? 0,
          }
        : null,
      // The (gate × model) dimension's own coverage, reported beside the tokens' rather
      // than folded into it: the two have different denominators, because a turn's model
      // is readable even when its tokens are already charged to an earlier transition.
      models: tokenAttribution
        ? {
            note: "the model that emitted the invoking tool call — not 'the model that ran the gate', and not the session's model. A gate with no attribution reports unknown; it is never pooled.",
            granularity: MODEL_GRANULARITY,
            source: tokenAttribution.source ?? "transcript",
            transitions_with_model: tokenAttribution.matchedModels ?? 0,
            // Examined, and no model was observable. A measured absence.
            transitions_without_model: tokenAttribution.transitionsWithoutModel ?? 0,
            // Never examined for a model: a log enriched before #1327, or not at all.
            // Folding these into the line above would report an un-enriched log as one
            // whose gates were measured and found to be model-less.
            ...(tokenAttribution.modelsNotEnriched === undefined
              ? {}
              : { transitions_model_not_enriched: tokenAttribution.modelsNotEnriched }),
            ...(tokenAttribution.malformedModelAttributions
              ? { malformed_model_attributions: tokenAttribution.malformedModelAttributions }
              : {}),
            // Turns present in the window that named no model. Every turn landing here is
            // the shape a renamed transcript field would take, so it is reported.
            ...(tokenAttribution.turnsReportingNoModel === undefined || tokenAttribution.turnsReportingNoModel === null
              ? {}
              : { turns_reporting_no_model: tokenAttribution.turnsReportingNoModel }),
            models_observed: [
              ...new Set([...(tokenAttribution.models?.values() ?? [])].map((entry) => entry.model)),
            ].sort(),
          }
        : null,
    },
    ambiguous_expectations: ambiguousExpectations,
    ambiguous,
    gates: [...gates.values()].map(finalizeModels).sort((a, b) => b.calls - a.calls || a.gate.localeCompare(b.gate)),
    verbs: [...verbs.values()].map(finalizeModels).sort((a, b) => b.calls - a.calls),
    unattributed,
  };
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log("Usage: gate-scorecard.mjs [--transitions <file>] [--kit <dir>] [--transcript <jsonl>]... [--out <file>] [--trend <file>] [--json]");
    return 0;
  }

  // The writer anchors on the shared repository root, so a linked worktree appends to
  // the primary checkout's log. Defaulting the reader to cwd made it read a file that
  // will never exist there.
  const transitionsFile = options.transitions ?? path.join(sharedRepoRoot(process.cwd()), ".flow-agents", "telemetry", "transitions.jsonl");
  // No kit is privileged: with no --kit, every kit the repo publishes is scored.
  const kitDirs = options.kit ? [{ id: path.basename(options.kit), dir: options.kit }] : discoverKitDirs(process.cwd());
  const read = readJsonl(transitionsFile);
  const transitions = read.records.filter((record) => record?.schema === "kontour.flow-agents.transition");
  // Absence is not health. A missing or empty log used to render as a tidy scorecard of
  // zeroes — the exact failure this tool opens by indicting the capture hook for.
  if (read.missing) {
    console.error(`gate-scorecard: no transition log at ${transitionsFile}. Nothing has been measured — this is not a clean result.`);
    return 3;
  }
  if (!transitions.length) {
    console.error(`gate-scorecard: ${transitionsFile} holds no transition records${read.unparseable ? ` (${read.unparseable} unparseable line(s))` : ""}. Nothing has been measured.`);
    return 3;
  }
  const { index: expectationIndex, gates: gateIndex, ambiguousExpectations } = buildExpectationIndex(kitDirs, options.flows ?? null);

  if (!gateIndex.size) {
    const where = options.kit ? options.kit : `${path.join(process.cwd(), "kits")} (no --kit given)`;
    const scope = options.flows ? ` for flow(s) ${options.flows.join(", ")}` : "";
    console.error(`gate-scorecard: no kit declared any gate under ${where}${scope}`);
    return 2;
  }

  // Two sources for one contract. With `--transcript` this tool reads the host transcript
  // itself, as it always has. Without it, it reads the attribution a producer already
  // stamped onto the records (`enrich-transitions.mjs`) — the same module computes both,
  // so a consumer that has never seen a transcript gets the same figure rather than the
  // `activity_only` no-answer. An explicit --transcript wins: it is the primary evidence,
  // and silently preferring a stored derivation over the source it was derived from is how
  // a stale figure outlives the data that produced it.
  const tokenAttribution = options.transcripts.length
    ? attributeTokens(transitions, options.transcripts)
    : attributionFromRecords(transitions);
  // A renamed field, a moved path or a typo'd --transcript all converge on "no turns",
  // which used to render as a scorecard that simply omits the token column. That is the
  // format-break-looks-like-a-quiet-run failure this tool exists to refuse.
  if (tokenAttribution?.source === "transcript" && tokenAttribution.availableTurns === 0) {
    console.error(
      `gate-scorecard: --transcript was given but yielded no usable turns. The transcript format is internal to Claude Code and changes between releases; token figures are omitted rather than guessed.`,
    );
  }
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
    const cost = gate.output_tokens ? `  ${gate.output_tokens} out-tok` : "";
    const verdicts = gate.advanced || gate.awaiting ? `  advanced ${gate.advanced}/awaiting ${gate.awaiting}` : "";
    const note = gate.never_invoked ? "  never invoked in window" : verdicts;
    const label = `${gate.flow ?? "?"}/${gate.gate}`;
    console.log(`  ${label.padEnd(42)} calls ${String(gate.calls).padStart(3)}  refused/error ${String(gate.refused_or_error).padStart(3)}${cost}${note}`);
    // Per-model rows are printed BENEATH the pooled one, never instead of it, and the
    // unknown calls are printed as their own line rather than distributed across the
    // models above. A reader must be able to see that a gate's evidence covers one model
    // and not another before removing it for both.
    for (const perModel of gate.by_model) {
      const perCost = perModel.output_tokens ? `  ${perModel.output_tokens} out-tok` : "";
      console.log(
        `    ${`· ${perModel.model}`.padEnd(40)} calls ${String(perModel.calls).padStart(3)}  refused/error ${String(perModel.refused_or_error).padStart(3)}${perCost}` +
          (perModel.advanced || perModel.awaiting ? `  advanced ${perModel.advanced}/awaiting ${perModel.awaiting}` : ""),
      );
    }
    if (gate.calls_without_model || gate.calls_model_not_enriched) {
      const parts = [];
      if (gate.calls_without_model) parts.push(`${gate.calls_without_model} no model observed`);
      if (gate.calls_model_not_enriched) parts.push(`${gate.calls_model_not_enriched} never examined for a model`);
      console.log(`    ${"· unknown".padEnd(40)} ${parts.join(", ")}`);
    }
  }
  // Verbs are not gates, but they are where the run's cost actually went in the one
  // window measured so far. Printing gates alone would report a third of the work.
  if (scorecard.verbs.length) {
    console.log(`non-gate transitions (${scorecard.coverage.verb_attributed} calls):`);
    for (const verb of scorecard.verbs) {
      const cost = verb.output_tokens ? `  ${verb.output_tokens} out-tok` : "";
      const models = verb.by_model.map((entry) => `${entry.model} ${entry.calls}`).join(", ");
      // Compact here rather than one row each: the verb list is long, and the split is
      // still shown rather than pooled away. `--json` carries the full per-model tally.
      const unknown = verb.calls_without_model || verb.calls_model_not_enriched;
      const split = models || unknown ? `  [${[models, unknown ? `${unknown} unknown` : ""].filter(Boolean).join(", ")}]` : "";
      console.log(`  ${verb.verb.padEnd(36)} calls ${String(verb.calls).padStart(3)}  refused/error ${String(verb.refused_or_error).padStart(3)}${cost}${split}`);
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
