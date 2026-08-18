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
    version: "1.0",
    schema: "kontour.flow-agents.transition",
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
  // Includes an AMBIGUOUS write: without one, silently discarding every ambiguous
  // transition passes this test, which is how that defect survived a full round.
  fs.writeFileSync(
    path.join(kitDir, "flows", "overlap.flow.json"),
    JSON.stringify({
      id: "demo.overlap",
      gates: { "audit-gate": { step: "audit", expects: [{ id: "acceptance-criteria" }] } },
    }),
    "utf8",
  );
  const transitions = [
    transition({ targets: { expectation: "acceptance-criteria" } }),
    transition({ targets: { expectation: "tests-evidence" } }),
    transition({ targets: { expectation: "unknown-id" } }),
    transition({ command: "workflow", verb: "start", targets: {} }),
    transition({ command: "assignment-provider", verb: "render-claim", targets: {} }),
    transition({ command: "publish-change", verb: "execute", targets: {} }),
  ];
  const card = scorecardFor(transitions, { kitDir });
  assert.equal(card.window.transitions, transitions.length);
  assert.ok(card.ambiguous.length >= 1, "the fixture must actually produce an ambiguous write");
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

// A turn's timestamp is when the model EMITTED the tool call, so the invoking turn
// PRECEDES the transition it caused. Verified live: a transition at 00:45:32 was
// invoked by a turn stamped 00:45:21. These fixtures previously put the turn after the
// transition, which matched the implementation's assumption rather than reality — and
// so could never have caught the direction being wrong.
function transcript(dir, name, entries) {
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    entries
      .map(([id, at, output, session]) =>
        JSON.stringify({ timestamp: at, sessionId: session ?? "sess-a", message: { id, usage: { output_tokens: output } } }),
      )
      .join("\n"),
    "utf8",
  );
  return file;
}

test("token attribution counts one API response once, not once per content block", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-scorecard-tx-"));
  // One response logged as three lines sharing a message id and identical usage.
  const file = transcript(dir, "transcript.jsonl", [
    ["msg_a", "2026-08-17T12:00:00.000Z", 500],
    ["msg_a", "2026-08-17T12:00:00.000Z", 500],
    ["msg_a", "2026-08-17T12:00:00.000Z", 500],
  ]);
  const transitions = [transition({ started_at: "2026-08-17T12:00:05.000Z", duration_ms: 100 })];
  const attribution = attributeTokens(transitions, [file]);
  assert.equal(attribution.availableTurns, 1);
  assert.equal(attribution.matchedTurns, 1);
  assert.equal(attribution.attributed.get(transitions[0]).output, 500);
});

// Over-attribution manufactures spend that never happened — the exact defect the
// scorecard exists to find.
test("one turn cannot pay for two transitions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-scorecard-tx-"));
  const file = transcript(dir, "transcript.jsonl", [["m1", "2026-08-17T12:00:00.000Z", 500]]);
  const first = transition({ started_at: "2026-08-17T12:00:05.000Z", duration_ms: 100 });
  const second = transition({ started_at: "2026-08-17T12:00:06.000Z", duration_ms: 100 });
  const attribution = attributeTokens([first, second], [file]);

  assert.equal(attribution.matchedTurns, 1, "a single turn must be counted once");
  assert.equal(attribution.transitionsWithoutTurn, 1, "the unpaid transition must be disclosed");
  const total =
    (attribution.attributed.get(first)?.output ?? 0) + (attribution.attributed.get(second)?.output ?? 0);
  assert.equal(total, 500, "attributed spend must never exceed the spend that occurred");
});

// A transition whose invoking turn is already consumed must not reach further back:
// that older turn paid for earlier work, and claiming it invents spend for this one.
test("a transition does not reach back past its own invoking turn", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-scorecard-tx-"));
  const file = transcript(dir, "transcript.jsonl", [
    ["older", "2026-08-17T12:00:00.000Z", 900],
    ["invoker", "2026-08-17T12:00:10.000Z", 100],
  ]);
  const first = transition({ started_at: "2026-08-17T12:00:11.000Z", duration_ms: 10 });
  const second = transition({ started_at: "2026-08-17T12:00:12.000Z", duration_ms: 10 });
  const attribution = attributeTokens([first, second], [file]);
  assert.ok(attribution.attributed.get(first).id.endsWith("::invoker"), "the nearest preceding turn pays");
  assert.equal(attribution.attributed.get(second), undefined, "must not fall back to the older turn");
  assert.equal(attribution.transitionsWithoutTurn, 1);
});

// Sibling sessions write transcripts into the same directory. Matching on time alone
// imports another run's spend as this run's cost.
test("a sibling session's turn never pays for this run's transition", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-scorecard-tx-"));
  const file = transcript(dir, "mixed.jsonl", [
    ["mine", "2026-08-17T12:00:00.000Z", 100, "sess-a"],
    ["theirs", "2026-08-17T12:00:04.000Z", 8000, "sess-b"],
  ]);
  const mine = transition({
    started_at: "2026-08-17T12:00:05.000Z",
    duration_ms: 10,
    actor: { runtime: "claude-code", session_id: "sess-a" },
  });
  const attribution = attributeTokens([mine], [file]);
  assert.equal(attribution.matchedTurns, 1);
  assert.equal(attribution.attributed.get(mine).output, 100, "the nearer turn belongs to another session");
});

test("attributed tokens never exceed the transcript's own total", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-scorecard-tx-"));
  const file = transcript(dir, "transcript.jsonl", [
    ["m1", "2026-08-17T12:00:00.000Z", 300],
    ["m2", "2026-08-17T12:00:01.000Z", 200],
  ]);
  const transitions = Array.from({ length: 5 }, (unused, index) =>
    transition({ started_at: `2026-08-17T12:00:0${5 + index}.000Z`, duration_ms: 10 }),
  );
  const attribution = attributeTokens(transitions, [file]);
  const total = transitions.reduce((sum, item) => sum + (attribution.attributed.get(item)?.output ?? 0), 0);
  // Exact, not an upper bound: only the transition whose invoking turn is m2 is paid,
  // and the rest do NOT reach back to the older m1. A `<= 500` assertion here survives
  // both over-attribution and reach-back, so it proves nothing.
  assert.equal(attribution.matchedTurns, 1);
  assert.equal(attribution.transitionsWithoutTurn, 4);
  assert.equal(total, 200, "the invoking turn pays; older turns belong to earlier work");
});

test("a turn far outside a transition's window is not attributed to it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-scorecard-tx-"));
  // Hours earlier: too distant to be the turn that invoked this transition.
  const file = transcript(dir, "transcript.jsonl", [["msg_b", "2026-08-17T09:00:00.000Z", 900]]);
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

// --- what a kit declares, and what happens when the declaration is broken ---------

function kitWithManifest(flows, extraFiles = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-scorecard-kit-"));
  fs.mkdirSync(path.join(root, "flows"), { recursive: true });
  fs.writeFileSync(path.join(root, "kit.json"), JSON.stringify({ id: "demo", flows }), "utf8");
  for (const [name, body] of Object.entries(extraFiles)) {
    fs.writeFileSync(path.join(root, "flows", name), JSON.stringify(body), "utf8");
  }
  return root;
}

// A kit that declares a flow whose file was renamed has a broken manifest. Globbing the
// directory would hide that behind whatever strays happen to sit there.
test("a broken kit.json declaration does not silently fall back to globbing strays", () => {
  const kitDir = kitWithManifest([{ id: "demo.gone", path: "flows/missing.flow.json" }], {
    "stray.flow.json": { id: "stray.flow", gates: { "stray-gate": { step: "s", expects: [{ id: "stray" }] } } },
  });
  const { gates } = buildExpectationIndex(kitDir);
  assert.equal(gates.size, 0, "a stray flow file is not part of the kit");
});

test("an empty flows declaration means the kit declares no flows", () => {
  const kitDir = kitWithManifest([], {
    "stray.flow.json": { id: "stray.flow", gates: { "stray-gate": { step: "s", expects: [{ id: "stray" }] } } },
  });
  assert.equal(buildExpectationIndex(kitDir).gates.size, 0);
});

test("a kit with no manifest at all still globs its flows directory", () => {
  const kitDir = kitFixture();
  assert.ok(buildExpectationIndex(kitDir).gates.size > 0);
});

// A catalog listing one kit twice would register its gates twice, turning a single
// unambiguous expectation into two claimants: a phantom collision, and the gate that
// actually fired credited with nothing.
test("a kit listed twice in the catalog is registered once", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-scorecard-cat-"));
  const kitDir = path.join(root, "kits", "solo");
  fs.mkdirSync(path.join(kitDir, "flows"), { recursive: true });
  fs.writeFileSync(path.join(kitDir, "kit.json"), JSON.stringify({ id: "solo", flows: [{ id: "solo.flow", path: "flows/solo.flow.json" }] }), "utf8");
  fs.writeFileSync(
    path.join(kitDir, "flows", "solo.flow.json"),
    JSON.stringify({ id: "solo.flow", gates: { "verify-gate": { step: "verify", expects: [{ id: "only-id" }] } } }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, "kits", "catalog.json"),
    JSON.stringify({ kits: [{ id: "solo", path: "kits/solo" }, { id: "solo", path: "kits/solo" }] }),
    "utf8",
  );

  const kits = discoverKitDirs(root);
  assert.equal(kits.length, 1, "the duplicate entry must not register the kit twice");
  const { index, ambiguousExpectations } = buildExpectationIndex(kits);
  assert.equal(index.get("only-id").length, 1);
  assert.deepEqual(ambiguousExpectations, [], "a single kit cannot collide with itself");

  const card = buildScorecard({
    transitions: [transition({ targets: { expectation: "only-id" } })],
    expectationIndex: index,
    gateIndex: buildExpectationIndex(kits).gates,
    tokenAttribution: null,
    ambiguousExpectations,
  });
  assert.equal(card.gates.find((gate) => gate.gate === "verify-gate").calls, 1);
});

test("discovery falls back to scanning when no catalog is published", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-scorecard-scan-"));
  const kitDir = path.join(root, "kits", "scanned");
  fs.mkdirSync(path.join(kitDir, "flows"), { recursive: true });
  fs.writeFileSync(path.join(kitDir, "kit.json"), JSON.stringify({ id: "scanned", flows: [] }), "utf8");
  const kits = discoverKitDirs(root);
  assert.deepEqual(kits.map((kit) => kit.id), ["scanned"]);
});

// --- a --gate flag is not a licence to guess ------------------------------------

test("an ambiguous write is not rescued onto a gate by its --gate flag", () => {
  const kitDir = kitFixture();
  fs.writeFileSync(
    path.join(kitDir, "flows", "overlap.flow.json"),
    JSON.stringify({
      id: "demo.overlap",
      // Uniquely named on purpose: with both rivals called "verify-gate" the gate-name
      // lookup short-circuits for an unrelated reason and the test passes even with the
      // guard removed. Proven by injection.
      gates: { "audit-gate": { step: "audit", expects: [{ id: "tests-evidence" }] } },
    }),
    "utf8",
  );
  const card = scorecardFor(
    [transition({ targets: { expectation: "tests-evidence", gate: "audit-gate" } })],
    { kitDir },
  );
  assert.equal(card.ambiguous.length, 1, "the write is ambiguous");
  assert.equal(
    card.gates.filter((gate) => gate.calls > 0).length,
    0,
    "and must not ALSO be counted in some gate's tally",
  );
});

// A gate name shared by two flows identifies a gate no better than a shared
// expectation id does; the file order that would decide it is not even stable.
test("a --gate naming a gate two flows declare resolves nothing", () => {
  const kitDir = kitFixture();
  fs.writeFileSync(
    path.join(kitDir, "flows", "rival.flow.json"),
    JSON.stringify({
      id: "demo.rival",
      gates: { "verify-gate": { step: "verify", expects: [{ id: "rival-evidence" }] } },
    }),
    "utf8",
  );
  const card = scorecardFor([transition({ targets: { gate: "verify-gate" } })], { kitDir });
  assert.equal(card.gates.filter((gate) => gate.calls > 0).length, 0);
  assert.equal(card.coverage.verb_attributed, 1, "it is still counted, as a verb");
});

test("a --gate naming a gate only one flow declares does resolve", () => {
  const kitDir = kitFixture();
  const card = scorecardFor([transition({ targets: { gate: "plan-gate" } })], { kitDir });
  assert.equal(card.gates.find((gate) => gate.gate === "plan-gate").calls, 1);
});

// Subagent turns carry the PARENT's session id, so a session filter does not exclude
// them — and "the nearest preceding turn" then picks a subagent's turn instead of the
// orchestrator's between 8% and 42% of the time on delegation-heavy sessions.
test("a subagent turn never pays for the orchestrator's transition", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-scorecard-tx-"));
  const file = path.join(dir, "t.jsonl");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ timestamp: "2026-08-17T12:00:00.000Z", sessionId: "s", message: { id: "orchestrator", usage: { output_tokens: 120 } } }),
      JSON.stringify({ timestamp: "2026-08-17T12:00:04.000Z", sessionId: "s", isSidechain: true, message: { id: "subagent", usage: { output_tokens: 9000 } } }),
    ].join("\n"),
    "utf8",
  );
  const mine = transition({ started_at: "2026-08-17T12:00:05.000Z", duration_ms: 10, actor: { runtime: "claude-code", session_id: "s" } });
  const attribution = attributeTokens([mine], [file]);
  assert.equal(attribution.sidechainTurnsExcluded, 1);
  assert.equal(attribution.attributed.get(mine).output, 120, "the nearer turn is a subagent's");
});

// The same response appears in two files after /branch or --fork-session.
test("a response copied into two transcripts is not collapsed across sessions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-scorecard-tx-"));
  const line = (session) =>
    JSON.stringify({ timestamp: "2026-08-17T12:00:00.000Z", sessionId: session, message: { id: "shared", usage: { output_tokens: 50 } } });
  const a = path.join(dir, "a.jsonl");
  const b = path.join(dir, "b.jsonl");
  fs.writeFileSync(a, line("sess-a"), "utf8");
  fs.writeFileSync(b, line("sess-b"), "utf8");
  const mine = transition({ started_at: "2026-08-17T12:00:05.000Z", duration_ms: 10, actor: { runtime: "claude-code", session_id: "sess-b" } });
  const attribution = attributeTokens([mine], [a, b]);
  assert.equal(attribution.matchedTurns, 1, "sess-b's own copy is still reachable");
  assert.equal(attribution.attributed.get(mine).session, "sess-b");
});
