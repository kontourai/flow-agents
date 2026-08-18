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
} from "../../scripts/telemetry/gate-scorecard.mjs";

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
  const { index, gates } = buildExpectationIndex(kitDir, flows);
  return buildScorecard({ transitions, expectationIndex: index, gateIndex: gates, tokenAttribution: null });
}

test("the expectation index is derived from the kit's flow definitions", () => {
  const kitDir = kitFixture();
  const { index, gates } = buildExpectationIndex(kitDir);
  assert.equal(index.get("tests-evidence").gate, "verify-gate");
  assert.equal(index.get("implementation-plan").gate, "plan-gate");
  assert.deepEqual([...gates.keys()].sort(), ["plan-gate", "shape-gate", "verify-gate"]);
});

test("scoping to a flow excludes another flow's gates entirely", () => {
  const kitDir = kitFixture();
  const { gates } = buildExpectationIndex(kitDir, ["demo.build"]);
  assert.deepEqual([...gates.keys()].sort(), ["plan-gate", "verify-gate"]);
  assert.ok(!gates.has("shape-gate"));
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
