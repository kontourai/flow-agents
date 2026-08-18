// Unit tests for scripts/telemetry/gate-scorecard.mjs.
//
// The module under test is a plain ESM script alongside the other telemetry tools, so
// it is imported directly rather than from build/. Fixtures live under os.tmpdir().
//
// Run: `npm run test:unit`, or directly:
//   node --test src/cli/gate-scorecard.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  attributeTokens,
  buildExpectationIndex,
  buildScorecard,
  discoverKitDirs,
} from "../../scripts/telemetry/gate-scorecard.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

function kitFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-scorecard-"));
  const flows = path.join(root, "flows");
  fs.mkdirSync(flows, { recursive: true });
  fs.writeFileSync(
    path.join(flows, "build.flow.json"),
    JSON.stringify({
      id: "demo.build",
      gates: {
        "verify-gate": { step: "verify", expects: [{ id: "tests-evidence" }, { id: "acceptance-criteria" }] },
        "plan-gate": { step: "plan", expects: [{ id: "implementation-plan" }] },
      },
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(flows, "shape.flow.json"),
    JSON.stringify({ id: "demo.shape", gates: { "shape-gate": { step: "shape", expects: [{ id: "shaped" }] } } }),
    "utf8",
  );
  return root;
}

function transition(overrides) {
  return {
    schema_version: "1.0",
    kind: "kontour.flow-agents.transition",
    command: "workflow",
    verb: "evidence",
    targets: {},
    flags: [],
    exit_code: 0,
    outcome: "ok",
    started_at: "2026-08-17T12:00:00.000Z",
    duration_ms: 1000,
    cwd_repo: null,
    actor: { runtime: null, session_id: null },
    ...overrides,
  };
}

function scorecardFor(transitions, { kitDir, flows = null }) {
  const { index, gates, ambiguousExpectations } = buildExpectationIndex(kitDir, flows);
  return buildScorecard({
    transitions,
    expectationIndex: index,
    gateIndex: gates,
    tokenAttribution: null,
    ambiguousExpectations,
  });
}

test("the expectation index is derived from the kit's flow definitions", () => {
  const kitDir = kitFixture();
  const { index, gates } = buildExpectationIndex(kitDir);
  assert.equal(index.get("tests-evidence")[0].gate, "verify-gate");
  assert.equal(index.get("implementation-plan")[0].gate, "plan-gate");
  assert.deepEqual([...gates.values()].map((gate) => gate.gate).sort(), ["plan-gate", "shape-gate", "verify-gate"]);
  assert.equal(index.get("tests-evidence")[0].flow, "demo.build");
});

// Gate names repeat across flows by design — the same word means a different gate in
// a different flow — so sharing one is not a collision and must not be reported as
// noise that buries the real finding below.
test("a gate name reused by two flows yields two distinct gates, not a collision", () => {
  const kitDir = kitFixture();
  fs.writeFileSync(
    path.join(kitDir, "flows", "rival.flow.json"),
    JSON.stringify({
      id: "demo.rival",
      gates: { "verify-gate": { step: "verify", expects: [{ id: "rival-evidence" }] } },
    }),
    "utf8",
  );
  const { gates, ambiguousExpectations } = buildExpectationIndex(kitDir);
  assert.deepEqual(ambiguousExpectations, []);
  const verifyGates = [...gates.values()].filter((gate) => gate.gate === "verify-gate");
  assert.equal(verifyGates.length, 2, "each flow keeps its own verify-gate");
  assert.deepEqual(verifyGates.map((gate) => gate.flow).sort(), ["demo.build", "demo.rival"]);
});

// A transition names its expectation and nothing else, so a shared id genuinely cannot
// be attributed — that IS ambiguous, and guessing would put a write on a gate that
// never saw it.
test("an expectation id claimed by two flows is reported as ambiguous", () => {
  const kitDir = kitFixture();
  fs.writeFileSync(
    path.join(kitDir, "flows", "overlap.flow.json"),
    JSON.stringify({
      id: "demo.overlap",
      gates: { "audit-gate": { step: "audit", expects: [{ id: "tests-evidence" }] } },
    }),
    "utf8",
  );
  const { index, ambiguousExpectations } = buildExpectationIndex(kitDir);
  assert.equal(index.get("tests-evidence").length, 2);
  const shared = ambiguousExpectations.find((entry) => entry.expectation === "tests-evidence");
  assert.ok(shared, "the shared id must be reported");
  assert.deepEqual(shared.claimed_by.sort(), ["demo.build::verify-gate", "demo.overlap::audit-gate"]);
});

test("a write naming a shared id is held as ambiguous, not assigned to a guess", () => {
  const kitDir = kitFixture();
  fs.writeFileSync(
    path.join(kitDir, "flows", "overlap.flow.json"),
    JSON.stringify({
      id: "demo.overlap",
      gates: { "audit-gate": { step: "audit", expects: [{ id: "tests-evidence" }] } },
    }),
    "utf8",
  );
  const card = scorecardFor([transition({ targets: { expectation: "tests-evidence" } })], { kitDir });
  assert.equal(card.ambiguous.length, 1);
  assert.equal(card.coverage.ambiguous_writes, 1);
  assert.equal(
    card.gates.filter((gate) => gate.calls > 0).length,
    0,
    "no gate may be credited with a write that cannot be attributed to it",
  );
});

test("--flow on the record breaks the tie for a shared expectation id", () => {
  const kitDir = kitFixture();
  fs.writeFileSync(
    path.join(kitDir, "flows", "overlap.flow.json"),
    JSON.stringify({
      id: "demo.overlap",
      gates: { "audit-gate": { step: "audit", expects: [{ id: "tests-evidence" }] } },
    }),
    "utf8",
  );
  const card = scorecardFor(
    [transition({ targets: { expectation: "tests-evidence", flow: "demo.overlap" } })],
    { kitDir },
  );
  assert.equal(card.ambiguous.length, 0);
  const audit = card.gates.find((gate) => gate.gate === "audit-gate");
  assert.equal(audit.calls, 1);
});

// Real data, not a fixture: the knowledge kit genuinely shares one expectation id
// across two flows. If that is ever resolved upstream this test should be updated,
// not deleted — it is the only case proving the detector fires on real definitions.
test("the shipped kits' one shared expectation id is detected", () => {
  const { ambiguousExpectations } = buildExpectationIndex(discoverKitDirs(REPO_ROOT));
  const shared = ambiguousExpectations.find(
    (entry) => entry.expectation === "proposal-carries-source-refs",
  );
  assert.ok(shared, "knowledge.synthesize and knowledge.consolidate both expect this id");
  assert.equal(shared.claimed_by.length, 2);
});

// Nothing in the scorer knows what a builder kit is.
test("kit discovery finds every kit the repo publishes, not a privileged one", () => {
  const kits = discoverKitDirs(REPO_ROOT);
  const ids = kits.map((kit) => kit.id).sort();
  assert.ok(ids.includes("builder"), ids.join(","));
  assert.ok(ids.includes("knowledge"), ids.join(","));
  assert.ok(kits.length >= 3, "the catalog declares at least three kits");
  const { gates } = buildExpectationIndex(kits);
  const kitsWithGates = new Set([...gates.values()].map((gate) => gate.kit));
  assert.ok(kitsWithGates.size >= 2, "gates are scored for more than one kit");
});

test("scoping to a flow excludes another flow's gates entirely", () => {
  const kitDir = kitFixture();
  const { gates } = buildExpectationIndex(kitDir, ["demo.build"]);
  const names = [...gates.values()].map((gate) => gate.gate).sort();
  assert.deepEqual(names, ["plan-gate", "verify-gate"]);
  assert.ok(!names.includes("shape-gate"));
});

test("evidence writes land on the gate their expectation belongs to", () => {
  const kitDir = kitFixture();
  const card = scorecardFor(
    [
      transition({ targets: { expectation: "tests-evidence" } }),
      transition({ targets: { expectation: "acceptance-criteria" }, exit_code: 70, outcome: "unhandled-error" }),
      transition({ targets: { expectation: "implementation-plan" } }),
    ],
    { kitDir, flows: ["demo.build"] },
  );
  const verify = card.gates.find((gate) => gate.gate === "verify-gate");
  assert.equal(verify.calls, 2);
  assert.equal(verify.ok, 1);
  assert.equal(verify.refused_or_error, 1);
  assert.deepEqual(verify.expectations, { "tests-evidence": 1, "acceptance-criteria": 1 });
});

// The failure this guards against is the one that made the hand-built scorecard wrong:
// retry-suffixed ids ("ci-merge-readiness2") looked like real expectations and would
// have been silently discarded, shrinking the denominator without saying so.
test("an expectation no declared gate expects is reported, never dropped", () => {
  const kitDir = kitFixture();
  const card = scorecardFor(
    [
      transition({ targets: { expectation: "tests-evidence" } }),
      transition({ targets: { expectation: "tests-evidence2" }, exit_code: 70, outcome: "unhandled-error" }),
    ],
    { kitDir, flows: ["demo.build"] },
  );
  assert.equal(card.unattributed.length, 1);
  assert.equal(card.unattributed[0].expectation, "tests-evidence2");
  assert.equal(card.coverage.expectations_naming_no_declared_gate, 1);
  const verify = card.gates.find((gate) => gate.gate === "verify-gate");
  assert.equal(verify.calls, 1, "the unrecognised id must not inflate the gate it resembles");
});

// The invariant that makes the card trustworthy: every transition is somewhere.
test("no transition is lost — gate and verb attribution partition the window", () => {
  const kitDir = kitFixture();
  const transitions = [
    transition({ targets: { expectation: "tests-evidence" } }),
    transition({ targets: { expectation: "unknown-id" } }),
    transition({ command: "workflow", verb: "start", targets: {} }),
    transition({ command: "assignment-provider", verb: "render-claim", targets: {} }),
    transition({ command: "publish-change", verb: "execute", targets: {} }),
  ];
  const card = scorecardFor(transitions, { kitDir, flows: ["demo.build"] });
  assert.equal(card.window.transitions, transitions.length);
  assert.equal(
    card.coverage.gate_attributed + card.coverage.verb_attributed,
    transitions.length,
    "every transition must be counted exactly once across gates and verbs",
  );
});

// A gate that never ran costs nothing and proves nothing, and must not read as clean.
test("a declared gate never invoked in the window is reported as such", () => {
  const kitDir = kitFixture();
  const card = scorecardFor([transition({ targets: { expectation: "tests-evidence" } })], {
    kitDir,
    flows: ["demo.build"],
  });
  const plan = card.gates.find((gate) => gate.gate === "plan-gate");
  assert.equal(plan.never_invoked, true);
  assert.equal(plan.calls, 0);
  const verify = card.gates.find((gate) => gate.gate === "verify-gate");
  assert.ok(!verify.never_invoked);
});

test("token attribution counts one API response once, not once per content block", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-scorecard-tx-"));
  const file = path.join(dir, "transcript.jsonl");
  // One response logged as three lines sharing a message id and identical usage.
  const line = (id, at, output) =>
    JSON.stringify({ timestamp: at, message: { id, usage: { output_tokens: output } } });
  fs.writeFileSync(
    file,
    [
      line("msg_a", "2026-08-17T12:00:02.000Z", 500),
      line("msg_a", "2026-08-17T12:00:02.000Z", 500),
      line("msg_a", "2026-08-17T12:00:02.000Z", 500),
    ].join("\n"),
    "utf8",
  );
  const transitions = [transition({ started_at: "2026-08-17T12:00:00.000Z", duration_ms: 5000 })];
  const attribution = attributeTokens(transitions, [file]);
  assert.equal(attribution.availableTurns, 1);
  assert.equal(attribution.matchedTurns, 1);
  assert.equal(attribution.attributed.get(transitions[0]).output, 500);
});

// The defect this caught in review: two transitions sharing one turn each claimed its
// full cost, reporting 1000 tokens spent for a 500-token turn. Over-attribution
// manufactures spend that never happened — the exact failure the scorecard exists to
// find — so a turn is consumed once and the shortfall is disclosed instead.
test("one turn cannot pay for two transitions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-scorecard-tx-"));
  const file = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(
    file,
    JSON.stringify({ timestamp: "2026-08-17T12:00:05.000Z", message: { id: "m1", usage: { output_tokens: 500 } } }),
    "utf8",
  );
  const first = transition({ started_at: "2026-08-17T12:00:00.000Z", duration_ms: 10_000 });
  const second = transition({ started_at: "2026-08-17T12:00:01.000Z", duration_ms: 10_000 });
  const attribution = attributeTokens([first, second], [file]);

  assert.equal(attribution.matchedTurns, 1, "a single turn must be counted once");
  assert.equal(attribution.transitionsWithoutTurn, 1, "the unpaid transition must be disclosed");
  const total =
    (attribution.attributed.get(first)?.output ?? 0) + (attribution.attributed.get(second)?.output ?? 0);
  assert.equal(total, 500, "attributed spend must never exceed the spend that occurred");
});

test("attributed tokens never exceed the transcript's own total", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-scorecard-tx-"));
  const file = path.join(dir, "transcript.jsonl");
  const line = (id, at, output) =>
    JSON.stringify({ timestamp: at, message: { id, usage: { output_tokens: output } } });
  fs.writeFileSync(
    file,
    [line("m1", "2026-08-17T12:00:05.000Z", 300), line("m2", "2026-08-17T12:00:06.000Z", 200)].join("\n"),
    "utf8",
  );
  const transitions = Array.from({ length: 5 }, (unused, index) =>
    transition({ started_at: "2026-08-17T12:00:00.000Z", duration_ms: 10_000 + index }),
  );
  const attribution = attributeTokens(transitions, [file]);
  const total = transitions.reduce((sum, item) => sum + (attribution.attributed.get(item)?.output ?? 0), 0);
  assert.equal(total, 500);
  assert.equal(attribution.matchedTurns, 2);
  assert.equal(attribution.transitionsWithoutTurn, 3);
});

test("a turn far outside a transition's window is not attributed to it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-scorecard-tx-"));
  const file = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(
    file,
    JSON.stringify({ timestamp: "2026-08-17T14:00:00.000Z", message: { id: "msg_b", usage: { output_tokens: 900 } } }),
    "utf8",
  );
  const transitions = [transition({ started_at: "2026-08-17T12:00:00.000Z", duration_ms: 1000 })];
  const attribution = attributeTokens(transitions, [file]);
  assert.equal(attribution.matchedTurns, 0);
});

// Scope is derived from the window, not declared by a flag. A flow the run never
// touched was never in scope to fire, and listing its gates as "never invoked" would
// bury the finding that matters: a gate idle inside a flow the run actually ran.
test("gates of an unexercised flow are counted, not listed as never invoked", () => {
  const kitDir = kitFixture();
  const card = scorecardFor([transition({ targets: { expectation: "tests-evidence" } })], { kitDir });

  const reported = card.gates.map((gate) => gate.gate);
  assert.ok(reported.includes("verify-gate"), "the exercised gate is reported");
  assert.ok(reported.includes("plan-gate"), "an idle gate in the SAME flow is reported");
  assert.ok(!reported.includes("shape-gate"), "a gate in an untouched flow is not listed");
  assert.deepEqual(card.scope.flows_exercised, ["demo.build"]);
  assert.equal(card.scope.flows_not_exercised, 1);
  assert.equal(card.scope.gates_declared, 3);
});
