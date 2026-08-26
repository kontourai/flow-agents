// Model attribution on transition records — flow-agents#1327.
//
// WHY THE DIMENSION EXISTS. `actor.runtime` says `claude-code` or `codex` and
// nothing more, so a per-gate scorecard folded from these records cannot compare a
// gate across models. It has to: gate value is plausibly model-dependent, and a
// pooled per-gate verdict answers "is this gate worth it on average over whatever
// mix of models happened to run" — a number on which a decision to remove a gate
// removes it for every model at once.
//
// WHAT IS ACTUALLY OBSERVABLE, and what these tests therefore hold the code to. No
// environment variable names the executing model on either runtime, so the emitter
// cannot know it and does not guess (`the emitter writes neither field` below).
// The turn that emitted the invoking tool call DOES name its model, on the same
// transcript record as the usage totals `output_tokens` is derived from — so it is
// stamped by the same post-hoc pass, from the same evidence, through the same
// module.
//
// THE FIXTURE IS REAL, and shared with the token-attribution suite.
// `fixtures/transition-attribution/turns.jsonl` is derived from the host transcript
// of one live builder run, and `message.model` is joined onto it from that same
// transcript — every one of its 730 lines matched a source record on
// (timestamp, output_tokens) with no ambiguity and no misses. It is not invented.
//
// What the real slice does and does not exercise, stated rather than assumed. It
// covers a genuine TWO-MODEL window (an orchestrator's turns interleaved with a
// delegate's) and it covers `turn-outside-grace-window`. It carries two
// `<synthetic>` turns — the host's own placeholder for a rate-limit notice or a
// rejected model id, which is not a model — but NO transition in the corpus has one
// as its candidate turn, so the refusal path is latent there rather than realized.
// A guardrail whose rejection path has never executed is unproven, so that path is
// covered by a constructed case below, asserted in BOTH directions.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import Ajv from "ajv";

import { buildExpectationIndex, buildScorecard, discoverKitDirs } from "../../scripts/telemetry/gate-scorecard.mjs";
import { enrich, readLog } from "../../scripts/telemetry/enrich-transitions.mjs";
import {
  attributeTokens,
  attributionFromRecords,
  MODEL_ATTRIBUTION_FIELD,
  MODEL_GRANULARITY,
  normalizeTurnModel,
  RESOLVED_MODEL_FIELD,
  TOKEN_ATTRIBUTION_FIELD,
  OUTPUT_TOKENS_FIELD,
} from "../../scripts/telemetry/token-attribution.mjs";
import { buildTransitionRecord } from "../../build/src/transition-log.js";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const FIXTURES = path.join(import.meta.dirname, "fixtures", "transition-attribution");
const CORPUS = path.join(FIXTURES, "transitions.jsonl");
const TURNS = path.join(FIXTURES, "turns.jsonl");
const ENRICHER = path.join(REPO_ROOT, "scripts", "telemetry", "enrich-transitions.mjs");
const SCHEMA = path.join(REPO_ROOT, "scripts", "telemetry", "transition-record.schema.json");

// Pinned so the corpus cannot be swapped for a friendlier one without the diff saying
// so. Every number is the fixture's own, computed once and read off.
const EXPECTED = {
  transitions: 700,
  withModel: 574,
  withoutModel: 126,
  // Deliberately far above the 97 that carry TOKENS. A model is not an additive
  // quantity, so it follows the candidate turn rather than the consumed one; if these
  // two ever converge, someone has applied the one-turn-one-transition exclusion to a
  // dimension it does not belong to and has thrown away 85% of the evidence.
  withTokens: 97,
  models: { "claude-fable-5": 480, "claude-opus-5": 94 },
  reasons: { "turn-outside-grace-window": 126 },
  turnsReportingNoModel: 2,
  availableTurns: 372,
};

function readCorpus() {
  return fs.readFileSync(CORPUS, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * Reclaimable, per #1326/#1349: this file builds ~10 fixture roots per run and a bare
 * `fs.mkdtempSync` leaks every one of them permanently. It landed in the same window as
 * the sweep that fixed the rest of the corpus, so it adopts the helper rather than
 * reintroducing the leak one file at a time.
 */
function scratch(prefix = "transition-model-") {
  return makeFixtureDir(prefix);
}

/** Run the real enricher binary over a copy of the real corpus. Not a helper call. */
function enrichCorpusThroughCli(extraArgs = []) {
  const dir = scratch();
  const file = path.join(dir, "transitions.jsonl");
  fs.copyFileSync(CORPUS, file);
  const summary = JSON.parse(
    execFileSync(process.execPath, [ENRICHER, "--transitions", file, "--transcript", TURNS, "--json", ...extraArgs], {
      encoding: "utf8",
    }),
  );
  return { summary, file, transitions: readLog(file).transitions };
}

const KIT_INDEX = (() => {
  const kitDirs = discoverKitDirs(REPO_ROOT);
  return buildExpectationIndex(kitDirs);
})();

function scorecardOver(transitions, tokenAttribution) {
  return buildScorecard({
    transitions,
    expectationIndex: KIT_INDEX.index,
    gateIndex: KIT_INDEX.gates,
    tokenAttribution,
    ambiguousExpectations: KIT_INDEX.ambiguousExpectations,
  });
}

/**
 * A transition record in the shape the emitter writes, with the gate-bearing fields a
 * scorecard needs. `shaped-problem` is declared by exactly one gate in this repo's own
 * kits, so it resolves without the ambiguity machinery getting involved.
 */
function transitionAt(startedAt, overrides = {}) {
  return {
    schema: "kontour.flow-agents.transition",
    version: "1.0",
    command: "workflow",
    verb: "evidence",
    targets: { expectation: "shaped-problem" },
    flags: ["--expectation"],
    exit_code: 0,
    outcome: "ok",
    started_at: startedAt,
    duration_ms: 1,
    cwd_repo: "/repo",
    actor: { runtime: "claude-code", session_id: "session-a" },
    ...overrides,
  };
}

function turnAt(timestamp, model, { id = "m1", output = 100 } = {}) {
  return JSON.stringify({
    timestamp,
    sessionId: "session-a",
    isSidechain: false,
    message: { id, ...(model === undefined ? {} : { model }), usage: { output_tokens: output } },
  });
}

function writeTranscript(dir, lines) {
  const file = path.join(dir, "turns.jsonl");
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  return file;
}

// ---------------------------------------------------------------------------
// THE KNOWN PATH, end to end through the real write.
// ---------------------------------------------------------------------------

test("the enricher attributes the live corpus to exactly the models its transcript names", () => {
  const { summary, transitions } = enrichCorpusThroughCli();
  assert.equal(summary.transitions, EXPECTED.transitions);
  assert.equal(summary.model_granularity, MODEL_GRANULARITY);
  assert.equal(summary.transitions_with_model, EXPECTED.withModel);
  assert.equal(summary.transitions_without_model, EXPECTED.withoutModel);
  assert.equal(summary.transitions_with_model + summary.transitions_without_model, EXPECTED.transitions);
  assert.equal(summary.turns_reporting_no_model, EXPECTED.turnsReportingNoModel);
  assert.deepEqual(
    Object.fromEntries(summary.models_observed.map((entry) => [entry.model, entry.transitions])),
    EXPECTED.models,
  );

  // The window really is multi-model — an orchestrator and a delegate — which is the
  // whole reason the dimension exists. A single-model corpus could not discriminate a
  // per-model fold from a pooled one.
  assert.ok(Object.keys(EXPECTED.models).length >= 2, "the fixture must span more than one model");

  // Read off the records themselves, not the summary that claims them.
  const onRecords = {};
  for (const record of transitions) {
    const model = record[RESOLVED_MODEL_FIELD];
    if (model !== undefined) onRecords[model] = (onRecords[model] ?? 0) + 1;
  }
  assert.deepEqual(onRecords, EXPECTED.models);

  // A model is not a divisible quantity, so it is attributed far more often than
  // tokens are. Pinned as an inequality with a real gap so an accidental application
  // of the token exclusion to this dimension shows up as a failure, not a shrug.
  assert.ok(
    summary.transitions_with_model > summary.transitions_with_turn * 5,
    `models (${summary.transitions_with_model}) must not be gated by the token exclusion (${summary.transitions_with_turn})`,
  );
  assert.equal(summary.transitions_with_turn, EXPECTED.withTokens);
});

test("resolved_model is present if and only if the attribution claims one, in both directions", () => {
  const { transitions } = enrichCorpusThroughCli();
  let claimed = 0;
  let disclaimed = 0;
  for (const record of transitions) {
    const block = record[MODEL_ATTRIBUTION_FIELD];
    assert.ok(block, "every examined record carries the model block");
    assert.equal(block.granularity, MODEL_GRANULARITY, "the label travels with the value");
    const hasModel = RESOLVED_MODEL_FIELD in record;
    assert.equal(hasModel, block.attributed === true, "the field and the claim must agree");
    if (block.attributed === true) {
      claimed += 1;
      assert.equal(typeof record[RESOLVED_MODEL_FIELD], "string");
      assert.ok(record[RESOLVED_MODEL_FIELD].length > 0);
      assert.match(block.turn_ref, /^sha256:[0-9a-f]{32}$/, "the turn handle carries no filesystem path");
    } else {
      disclaimed += 1;
      assert.equal(typeof block.reason, "string", "the reason is emitted, never left for the reader to infer");
    }
  }
  assert.equal(claimed, EXPECTED.withModel);
  assert.equal(disclaimed, EXPECTED.withoutModel);
});

// ---------------------------------------------------------------------------
// THE UNKNOWN PATH. This is the one that matters: a fabricated model cannot be
// un-fabricated downstream, and unlike an absence it is indistinguishable from a
// measurement in every (gate × model) comparison drawn from this data afterwards.
// ---------------------------------------------------------------------------

test("an unattributable transition carries no resolved_model key at all, never a placeholder", () => {
  const { transitions } = enrichCorpusThroughCli();
  const unattributed = transitions.filter((record) => record[MODEL_ATTRIBUTION_FIELD].attributed !== true);
  assert.equal(unattributed.length, EXPECTED.withoutModel);
  for (const record of unattributed) {
    assert.equal(RESOLVED_MODEL_FIELD in record, false, "an unobserved model must not be filled in");
  }
  // Nor may an "unknown"-shaped string reach the wire under any spelling. A reader
  // grouping by this field must never see a bucket that is not a model.
  for (const record of transitions) {
    const model = record[RESOLVED_MODEL_FIELD];
    if (model === undefined) continue;
    assert.ok(
      !/^(unknown|none|null|n\/a|default|<.*>)$/i.test(model),
      `a placeholder reached the model field: ${model}`,
    );
  }
});

test("every unattributable transition says why, with the exact real-corpus counts", () => {
  const { transitions } = enrichCorpusThroughCli();
  const reasons = {};
  for (const record of transitions) {
    const block = record[MODEL_ATTRIBUTION_FIELD];
    if (block.attributed === true) continue;
    reasons[block.reason] = (reasons[block.reason] ?? 0) + 1;
  }
  assert.deepEqual(reasons, EXPECTED.reasons);
});

// THE HOST PLACEHOLDER. Claude Code writes its own generated assistant messages —
// "You've hit your weekly limit", "No response requested", a rejected model id — with
// `model: "<synthetic>"` and all-zero usage. There are 379 of them in a 400-transcript
// sample of this repo's own corpus. Folding that string would put a bucket named
// `<synthetic>` in a per-model scorecard and invite exactly the comparison it cannot
// support.
//
// Asserted in BOTH directions in one test, so it cannot pass by the field never being
// written: the same transition, the same instant, the same code — one turn naming a
// real model, one naming the placeholder.
test("a turn that names no real model yields no model, while an identical real turn does", () => {
  const realDir = scratch("model-real-");
  const synthDir = scratch("model-synth-");
  const realTranscript = writeTranscript(realDir, [turnAt("2026-08-21T04:00:00.000Z", "claude-opus-5")]);
  const synthTranscript = writeTranscript(synthDir, [turnAt("2026-08-21T04:00:00.000Z", "<synthetic>", { output: 0 })]);

  const withReal = transitionAt("2026-08-21T04:00:05.000Z");
  const withSynthetic = transitionAt("2026-08-21T04:00:05.000Z");

  enrich({ lines: [{ record: withReal }], transitions: [withReal], transcripts: [realTranscript] });
  enrich({ lines: [{ record: withSynthetic }], transitions: [withSynthetic], transcripts: [synthTranscript] });

  // Direction 1 — the guard does not swallow a real model.
  assert.equal(withReal[RESOLVED_MODEL_FIELD], "claude-opus-5");
  assert.equal(withReal[MODEL_ATTRIBUTION_FIELD].attributed, true);

  // Direction 2 — the placeholder is refused, positively, with a reason.
  assert.equal(RESOLVED_MODEL_FIELD in withSynthetic, false, "`<synthetic>` is not a model and must not be stamped as one");
  assert.equal(withSynthetic[MODEL_ATTRIBUTION_FIELD].attributed, false);
  assert.equal(withSynthetic[MODEL_ATTRIBUTION_FIELD].reason, "turn-reports-no-model");
  // The turn WAS identified — the record says which — so the absence is a measured
  // finding about that turn, not a failure to find one.
  assert.match(withSynthetic[MODEL_ATTRIBUTION_FIELD].turn_ref, /^sha256:[0-9a-f]{32}$/);

  // And it reaches the fold as unknown rather than as a model.
  const card = scorecardOver([withSynthetic], attributeTokens([withSynthetic], [synthTranscript]));
  const gate = card.gates.find((entry) => entry.calls > 0);
  assert.ok(gate, "the constructed transition must resolve to a declared gate");
  assert.deepEqual(gate.by_model, [], "an unobserved model must create no per-model bucket");
  assert.equal(gate.calls_without_model, 1);
  assert.equal(gate.calls, 1, "and the pooled tally still counts the call");
  assert.deepEqual(card.coverage.models.models_observed, []);
});

// A transcript field rename would make every turn report no model. Tokens would still
// attribute, so this is not a refusal — but it must read as "the model dimension is
// unavailable for this window", never as a window whose gates ran on nothing.
test("a transcript whose turns name no model reports unavailability, not a run without models", () => {
  const dir = scratch();
  const transcript = writeTranscript(dir, [
    turnAt("2026-08-21T04:00:00.000Z", undefined, { id: "m1", output: 42 }),
    turnAt("2026-08-21T04:00:01.000Z", "", { id: "m2", output: 7 }),
  ]);
  const record = transitionAt("2026-08-21T04:00:05.000Z");
  const result = enrich({ lines: [{ record }], transitions: [record], transcripts: [transcript] });

  assert.equal(result.summary.transitions_with_model, 0);
  assert.equal(result.summary.transitions_without_model, 1);
  assert.equal(result.summary.turns_reporting_no_model, result.summary.available_turns);
  assert.deepEqual(result.summary.models_observed, []);
  // Tokens are unaffected: the two dimensions fail independently, which is the point
  // of stamping them as separate blocks.
  assert.equal(record[OUTPUT_TOKENS_FIELD], 7);
  assert.equal(record[TOKEN_ATTRIBUTION_FIELD].attributed, true);
  assert.equal(RESOLVED_MODEL_FIELD in record, false);
});

test("a turn too old to be the invoker is not evidence of the model either", () => {
  const dir = scratch();
  const transcript = writeTranscript(dir, [turnAt("2026-08-21T04:00:00.000Z", "claude-opus-5")]);
  const record = transitionAt("2026-08-21T05:00:00.000Z"); // an hour later; grace is 10 minutes
  enrich({ lines: [{ record }], transitions: [record], transcripts: [transcript] });
  assert.equal(RESOLVED_MODEL_FIELD in record, false, "a stale match must not name a model");
  assert.equal(record[MODEL_ATTRIBUTION_FIELD].reason, "turn-outside-grace-window");
});

test("a transition with no preceding turn at all says exactly that", () => {
  const dir = scratch();
  const transcript = writeTranscript(dir, [turnAt("2026-08-21T06:00:00.000Z", "claude-opus-5")]);
  const record = transitionAt("2026-08-21T04:00:00.000Z");
  enrich({ lines: [{ record }], transitions: [record], transcripts: [transcript] });
  assert.equal(RESOLVED_MODEL_FIELD in record, false);
  assert.equal(record[MODEL_ATTRIBUTION_FIELD].reason, "no-turn-before-transition");
});

// A transition whose turn's tokens are already spent still knows which model ran it.
// Applying the additive exclusion here would discard 85% of the dimension while
// telling no additional truth.
test("a transition whose turn was already charged still carries that turn's model", () => {
  const dir = scratch();
  const transcript = writeTranscript(dir, [turnAt("2026-08-21T04:00:00.000Z", "claude-opus-5", { output: 500 })]);
  const first = transitionAt("2026-08-21T04:00:05.000Z", { command: "first" });
  const second = transitionAt("2026-08-21T04:00:06.000Z", { command: "second" });
  enrich({ lines: [{ record: first }, { record: second }], transitions: [first, second], transcripts: [transcript] });

  assert.equal(first[OUTPUT_TOKENS_FIELD], 500);
  assert.equal(OUTPUT_TOKENS_FIELD in second, false, "one turn, one transition — for tokens");
  assert.equal(second[TOKEN_ATTRIBUTION_FIELD].reason, "turn-consumed-by-earlier-transition");
  assert.equal(first[RESOLVED_MODEL_FIELD], "claude-opus-5");
  assert.equal(second[RESOLVED_MODEL_FIELD], "claude-opus-5", "both were invoked by the same model");
});

// ---------------------------------------------------------------------------
// THE EMITTER. Nothing it can see names the model.
// ---------------------------------------------------------------------------

test("the emitter writes neither model field, and no environment variable makes it", () => {
  const build = (env) =>
    buildTransitionRecord({
      command: "workflow",
      argv: ["evidence", "--expectation", "shaped-problem"],
      exitCode: 0,
      startedAt: new Date("2026-08-21T04:00:00.000Z"),
      endedAt: new Date("2026-08-21T04:00:01.000Z"),
      repoRoot: "/repo",
      env,
    });

  for (const env of [
    {},
    // Every hopeful shape at once. None of these is an observation of the executing
    // model: ANTHROPIC_MODEL is a REJECTED mechanism in docs/decisions/model-routing.md,
    // a request the host may not honour, and wrong for a delegated sub-agent whose
    // turns interleave with its orchestrator's in this repo's own corpus.
    {
      ANTHROPIC_MODEL: "claude-opus-5",
      CLAUDE_MODEL: "claude-opus-5",
      FLOW_AGENTS_MODEL: "claude-opus-5",
      MODEL: "claude-opus-5",
      CLAUDE_CODE_SESSION_ID: "session-a",
      FLOW_AGENTS_RUNTIME: "claude-code",
    },
  ]) {
    const record = build(env);
    assert.equal(RESOLVED_MODEL_FIELD in record, false, "the emitter must not guess the model");
    assert.equal(MODEL_ATTRIBUTION_FIELD in record, false, "nor claim to have examined it");
  }

  // It does still record what it CAN observe, so this test cannot pass by the emitter
  // having stopped working.
  const record = build({ CLAUDE_CODE_SESSION_ID: "session-a" });
  assert.equal(record.actor.runtime, "claude-code");
  assert.equal(record.actor.session_id, "session-a");
});

// ---------------------------------------------------------------------------
// THE FOLD. One encoding, read two ways, and the three populations kept apart.
// ---------------------------------------------------------------------------

test("the producer's stamped model and the fold's own derivation agree exactly", () => {
  const raw = readCorpus();
  const fromTranscript = scorecardOver(raw, attributeTokens(raw, [TURNS]));
  const { transitions: enriched } = enrichCorpusThroughCli();
  const fromRecords = scorecardOver(enriched, attributionFromRecords(enriched));

  const modelsByGate = (card) =>
    card.gates
      .filter((gate) => gate.by_model.length)
      .map((gate) => [
        `${gate.flow}/${gate.gate}`,
        gate.by_model.map((entry) => [entry.model, entry.calls, entry.output_tokens ?? null]),
        gate.calls_without_model,
      ]);

  const gateModels = modelsByGate(fromTranscript);
  assert.ok(gateModels.length >= 3, `real gates must carry models for this to discriminate, got ${gateModels.length}`);
  assert.deepEqual(modelsByGate(fromRecords), gateModels);
  assert.equal(fromRecords.coverage.models.transitions_with_model, fromTranscript.coverage.models.transitions_with_model);
  assert.equal(
    fromRecords.coverage.models.transitions_without_model,
    fromTranscript.coverage.models.transitions_without_model,
  );
  assert.deepEqual(fromRecords.coverage.models.models_observed, fromTranscript.coverage.models.models_observed);
  assert.deepEqual(fromTranscript.coverage.models.models_observed, Object.keys(EXPECTED.models).sort());
  // Labelled by where each reading came from, so a stored derivation can never be
  // mistaken for a fresh read of the source.
  assert.equal(fromTranscript.coverage.models.source, "transcript");
  assert.equal(fromRecords.coverage.models.source, "record");
  assert.equal(fromTranscript.coverage.models.granularity, MODEL_GRANULARITY);
});

// At least one bucket must actually SPAN models, or the dimension is decorative here
// and a fold that silently pooled would be indistinguishable from one that did not.
//
// AND A REAL FINDING, PINNED. In this window every GATE call came from the
// orchestrator and every second model appears only on non-gate verbs — so a gate-set
// ablation run over this data would cover exactly one model. That is precisely the
// conclusion #1327 exists to make visible instead of invisible, and it is asserted
// here so a future fixture cannot quietly acquire multi-model gate coverage while the
// suite still claims to be testing the single-model case.
test("a bucket exercised by two models reports them separately, and the parts account for the whole", () => {
  const raw = readCorpus();
  const card = scorecardOver(raw, attributeTokens(raw, [TURNS]));

  const multiModel = [...card.gates, ...card.verbs].filter((bucket) => bucket.by_model.length > 1);
  assert.ok(multiModel.length > 0, "the fixture must contain a bucket exercised by more than one model");
  for (const bucket of multiModel) {
    assert.deepEqual(
      bucket.by_model.map((entry) => entry.model).sort(),
      Object.keys(EXPECTED.models).sort(),
      "a multi-model bucket names both, separately",
    );
  }
  assert.deepEqual(
    card.gates.filter((gate) => gate.by_model.length > 1).map((gate) => gate.gate),
    [],
    "every gate call in this window came from one model — the evidence covers that model only",
  );
  assert.deepEqual(
    [...new Set(card.gates.flatMap((gate) => gate.by_model.map((entry) => entry.model)))],
    ["claude-fable-5"],
  );

  for (const bucket of [...card.gates, ...card.verbs]) {
    const perModelCalls = bucket.by_model.reduce((sum, entry) => sum + entry.calls, 0);
    assert.equal(
      perModelCalls + bucket.calls_without_model + bucket.calls_model_not_enriched,
      bucket.calls,
      `${bucket.gate ?? bucket.verb}: every call must land in exactly one of the three populations`,
    );
    // The unknown calls are their own counter, never a row a reader could sum as a
    // model. There is no `model: "unknown"` bucket by construction.
    assert.ok(
      bucket.by_model.every((entry) => normalizeTurnModel(entry.model) === entry.model),
      "only observed models may appear as per-model rows",
    );
  }

  // The per-model token floors are floors of the pooled floor, never more.
  for (const bucket of card.gates) {
    const perModelTokens = bucket.by_model.reduce((sum, entry) => sum + (entry.output_tokens ?? 0), 0);
    assert.ok(perModelTokens <= (bucket.output_tokens ?? 0), "a per-model floor cannot exceed the pooled one");
  }
});

// A record nothing has looked at and a record examined and found model-less are
// different facts. Folding the first into the second reports an un-enriched log as a
// measured one whose gates all happened to run on nothing.
test("a record nothing enriched for a model is not folded as a measured absence", () => {
  const { transitions } = enrichCorpusThroughCli();
  // The exact shape a pre-#1327 enrichment leaves behind: tokens attributed, no model
  // block at all.
  const legacy = transitions.map((record, index) => {
    if (index % 5 !== 0) return record;
    const copy = { ...record };
    delete copy[MODEL_ATTRIBUTION_FIELD];
    delete copy[RESOLVED_MODEL_FIELD];
    return copy;
  });
  const stripped = legacy.filter((record) => !(MODEL_ATTRIBUTION_FIELD in record)).length;
  assert.ok(stripped > 0);

  const partial = attributionFromRecords(legacy);
  assert.equal(partial.modelsNotEnriched, stripped);
  assert.equal(partial.matchedModels + partial.transitionsWithoutModel + stripped, EXPECTED.transitions);
  assert.ok(partial.matchedModels < EXPECTED.withModel, "stripping must lower the measured population, not keep it");
  // Tokens are untouched: the two dimensions are read independently.
  assert.equal(partial.matchedTurns, EXPECTED.withTokens);

  const card = scorecardOver(legacy, partial);
  assert.equal(card.coverage.models.transitions_model_not_enriched, stripped);
  const notEnriched = [...card.gates, ...card.verbs].reduce((sum, bucket) => sum + bucket.calls_model_not_enriched, 0);
  assert.equal(notEnriched, stripped, "an un-examined record is counted as such by the fold, gate by gate");
});

test("a log nothing has enriched yields no model block at all, not a block of unknowns", () => {
  const raw = readCorpus();
  assert.equal(attributionFromRecords(raw), null, "absence is reported as absence");
  const card = scorecardOver(raw, attributionFromRecords(raw));
  assert.equal(card.coverage.models, null);
  assert.ok(card.gates.every((gate) => gate.by_model.length === 0));
  assert.ok(card.gates.every((gate) => gate.calls_without_model === 0), "nothing examined means nothing found absent");
});

// A claim of attribution carrying no usable model is a producer bug. Absorbing it as
// "no model" would hide the bug inside an honest-looking unknown count.
test("an attribution claiming a model without a usable value is counted as malformed", () => {
  const { transitions } = enrichCorpusThroughCli();
  const index = transitions.findIndex((record) => record[MODEL_ATTRIBUTION_FIELD].attributed === true);
  assert.ok(index >= 0);
  const broken = { ...transitions[index] };
  delete broken[RESOLVED_MODEL_FIELD];
  const mixed = transitions.map((record, position) => (position === index ? broken : record));

  const result = attributionFromRecords(mixed);
  assert.equal(result.malformedModelAttributions, 1);
  assert.equal(result.matchedModels, EXPECTED.withModel - 1);
  assert.equal(
    result.transitionsWithoutModel,
    EXPECTED.withoutModel,
    "a malformed claim is NOT laundered into a measured absence",
  );
});

// ---------------------------------------------------------------------------
// BACKWARD COMPATIBILITY. Additive and optional, as `output_tokens` was.
// ---------------------------------------------------------------------------

test("enrichment leaves every field the emitter wrote byte-identical", () => {
  const raw = readCorpus();
  const { transitions } = enrichCorpusThroughCli();
  assert.equal(transitions.length, raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    const stripped = { ...transitions[index] };
    for (const field of [OUTPUT_TOKENS_FIELD, TOKEN_ATTRIBUTION_FIELD, RESOLVED_MODEL_FIELD, MODEL_ATTRIBUTION_FIELD]) {
      delete stripped[field];
    }
    assert.deepEqual(stripped, raw[index], `record ${index} was altered beyond the additive fields`);
    assert.deepEqual(Object.keys(stripped), Object.keys(raw[index]), "the additions are appended, never interleaved");
  }
});

test("an enriched record still validates against the pre-#1327 consumer schema", () => {
  const current = JSON.parse(fs.readFileSync(SCHEMA, "utf8"));
  // Pinned literally: this change must add no REQUIRED field, or an old consumer would
  // start rejecting. Deriving it from `current` alone could not catch that.
  assert.deepEqual(current.required, [
    "schema",
    "version",
    "command",
    "verb",
    "targets",
    "flags",
    "exit_code",
    "outcome",
    "started_at",
    "duration_ms",
    "actor",
  ]);
  assert.equal(current.additionalProperties, true, "an old consumer must accept a producer's minor-version additions");

  const old = JSON.parse(JSON.stringify(current));
  delete old.properties[RESOLVED_MODEL_FIELD];
  delete old.properties[MODEL_ATTRIBUTION_FIELD];
  delete old.$id;
  // The installed ajv build does not carry the 2020-12 meta-schema; the dialect
  // declaration is irrelevant to what this asserts.
  delete old.$schema;

  const ajv = new Ajv({ strict: false, allErrors: true });
  const validateOld = ajv.compile(old);
  const validateCurrent = ajv.compile({ ...current, $id: undefined, $schema: undefined });
  const { transitions } = enrichCorpusThroughCli();
  for (const record of transitions) {
    assert.ok(validateOld(record), `old consumer rejected an enriched record: ${ajv.errorsText(validateOld.errors)}`);
    assert.ok(validateCurrent(record), `current schema rejected an enriched record: ${ajv.errorsText(validateCurrent.errors)}`);
  }
  // An un-enriched record — the shape every existing log holds — still validates.
  for (const record of readCorpus()) {
    assert.ok(validateCurrent(record), `current schema rejected an un-enriched record: ${ajv.errorsText(validateCurrent.errors)}`);
  }
});

test("--reattribute recomputes the model dimension onto records a prior pass left without one", () => {
  const dir = scratch();
  const file = path.join(dir, "transitions.jsonl");
  // A log in the pre-#1327 shape: tokens attributed, no model block anywhere.
  const { transitions } = enrichCorpusThroughCli();
  const legacy = transitions.map((record) => {
    const copy = { ...record };
    delete copy[MODEL_ATTRIBUTION_FIELD];
    delete copy[RESOLVED_MODEL_FIELD];
    return copy;
  });
  fs.writeFileSync(file, `${legacy.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");

  // A plain re-run preserves those records and stamps nothing — and SAYS so, rather
  // than leaving the gap to be inferred from an absence.
  const preserved = JSON.parse(
    execFileSync(process.execPath, [ENRICHER, "--transitions", file, "--transcript", TURNS, "--json"], { encoding: "utf8" }),
  );
  assert.equal(preserved.models_not_enriched, EXPECTED.transitions);
  assert.equal(preserved.transitions_with_model, 0);
  assert.ok(readLog(file).transitions.every((record) => !(MODEL_ATTRIBUTION_FIELD in record)));

  const again = JSON.parse(
    execFileSync(process.execPath, [ENRICHER, "--transitions", file, "--transcript", TURNS, "--reattribute", "--json"], {
      encoding: "utf8",
    }),
  );
  assert.equal(again.transitions_with_model, EXPECTED.withModel);
  assert.equal(again.models_not_enriched, 0);
  assert.deepEqual(
    Object.fromEntries(again.models_observed.map((entry) => [entry.model, entry.transitions])),
    EXPECTED.models,
  );

  // And a plain re-run over the NOW-enriched log reports zero un-examined records —
  // the counter is "carries no model block", not "was skipped this pass", or an
  // idempotent second pass would report every measured record as unmeasured.
  const idempotent = JSON.parse(
    execFileSync(process.execPath, [ENRICHER, "--transitions", file, "--transcript", TURNS, "--json"], { encoding: "utf8" }),
  );
  assert.equal(idempotent.newly_examined, 0, "a second pass examines nothing");
  assert.equal(idempotent.models_not_enriched, 0, "and finds nothing un-examined for a model");
});
