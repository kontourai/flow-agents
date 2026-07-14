import test from "node:test";
import assert from "node:assert/strict";

import {
  NarrativeStatementError,
  derivedNoOpTurn,
  derivedRetry,
  derivedTimeout,
  derivedUnavailableSource,
  observedCommand,
  observedDelegation,
  observedFileCreation,
  observedToolAction,
} from "../../build/src/index.js";

const source = (suffix) => `fa1:telemetry:full/session:event-${suffix}/0123abcd`;
const fileSource = `fa1:file:created.txt:${"a".repeat(64)}`;

test("observed constructors render one grounded proposition", () => {
  assert.equal(observedCommand({ sourceId: source("command"), command: "npm test", observedResult: "pass", exitCode: 0, actor: "codex" }).proposition,
    "Command `npm test` was observed to pass (exit 0)");
  assert.equal(observedCommand({ sourceId: source("ambiguous"), command: "grep needle", observedResult: "ambiguous", exitCode: null }).proposition,
    "Command `grep needle` was observed to complete ambiguously (exit unknown)");
  assert.equal(observedToolAction({ sourceId: source("tool"), toolName: "execute_bash", eventType: "tool.invoke" }).proposition,
    "Tool execute_bash emitted event tool.invoke");
  assert.equal(observedDelegation({ sourceId: source("delegation"), agentId: "agent-1", targets: ["worker-1", "worker-2"] }).proposition,
    "Agent agent-1 delegated work to worker-1, worker-2");
  assert.equal(observedFileCreation({ sourceId: fileSource, path: "created.txt" }).proposition,
    "File `created.txt` was observed to be created");
});

test("derived constructors render rules with grounded inputs", () => {
  const first = source("retry-1");
  const second = source("retry-2");
  assert.deepEqual(derivedRetry({ sourceIds: [first, second], command: "npm test", attempts: 2, ruleInputs: [first, second] }), {
    id: derivedRetry({ sourceIds: [first, second], command: "npm test", attempts: 2, ruleInputs: [first, second] }).id,
    class: "deterministic_derived",
    proposition: "Command `npm test` was retried across 2 attempts",
    source_refs: [first, second],
    rule: { id: "retry-detection", version: "v1", inputs: [first, second] },
  });
  assert.equal(derivedNoOpTurn({ turnRef: 3, sourceIds: [first] }).proposition, "Turn 3 was classified as a no-op");
  assert.equal(derivedNoOpTurn({ turnRef: -1, sourceIds: [first] }).turn_ref, -1);
  assert.equal(derivedTimeout({ sourceId: first, operation: "delegate worker", timeoutMs: 30000 }).proposition,
    "Operation `delegate worker` exceeded its 30000 ms timeout");
  assert.equal(derivedUnavailableSource({ sourceId: first, reason: "not_captured" }).proposition,
    `Source ${first} was unavailable because not_captured`);
});

test("delegation attribution defaults honestly", () => {
  const statement = observedDelegation({ sourceId: source("unattributed"), agentId: null });
  assert.equal(statement.actor, "unattributed");
  assert.equal(statement.proposition, "Agent unattributed delegated work");
});

test("observed and deterministic-derived constructors expose their class invariants", () => {
  const observed = observedFileCreation({ sourceId: fileSource, path: "created.txt" });
  const derived = derivedNoOpTurn({ turnRef: 0, sourceIds: [source("no-op")] });
  assert.equal(observed.class, "observed");
  assert.equal("rule" in observed, false);
  assert.equal(derived.class, "deterministic_derived");
  assert.deepEqual(derived.rule, { id: "no-op-turn", version: "v1", inputs: derived.source_refs });
});

test("statement IDs are deterministic, source-order insensitive, and input-sensitive", () => {
  const first = source("id-1");
  const second = source("id-2");
  const a = derivedRetry({ sourceIds: [first, second], command: "npm test", attempts: 2, ruleInputs: [first] });
  const b = derivedRetry({ sourceIds: [second, first], command: "npm test", attempts: 2, ruleInputs: [first] });
  const c = derivedRetry({ sourceIds: [first, second], command: "npm test", attempts: 3, ruleInputs: [first] });
  assert.match(a.id, /^[0-9a-f]{16}$/);
  assert.equal(a.id, b.id);
  assert.notEqual(a.id, c.id);
});

test("constructors reject invariant violations with typed errors", () => {
  const first = source("valid");
  const other = source("other");
  for (const invoke of [
    () => observedCommand({ sourceId: "not-fa1", command: "npm test", observedResult: "pass", exitCode: 0 }),
    () => observedCommand({ sourceId: first, command: "npm test", observedResult: "pass", exitCode: 1 }),
    () => observedCommand({ sourceId: first, command: "npm test; npm publish", observedResult: "pass", exitCode: 0 }),
    () => observedToolAction({ sourceId: first, toolName: "read\nand write", eventType: "tool.invoke" }),
    () => observedToolAction({ sourceId: first, toolName: "read and write", eventType: "tool.invoke" }),
    () => derivedRetry({ sourceIds: [first], command: "npm test", attempts: 1, ruleInputs: [first] }),
    () => derivedRetry({ sourceIds: [first], command: "npm test", attempts: 2, ruleInputs: [other] }),
    () => derivedNoOpTurn({ turnRef: 1, sourceIds: [] }),
  ]) {
    assert.throws(invoke, (error) => error instanceof NarrativeStatementError && typeof error.code === "string");
  }
});

// ── Review-round regressions (#618 verify findings) ──────────────────────────
import { buildTurnSpine } from "../../build/src/narrative/turn-spine.js";

test("H1: an explicit turn closes the session's derived spine — no merge across the boundary", () => {
  const src = (n) => `fa1:telemetry:full/s1:evt-${n}/01234567`;
  const spine = buildTurnSpine([
    { sourceId: src("pre"), record: { session_id: "s1", event_type: "tool.invoke" } },
    { sourceId: src("user"), record: { session_id: "s1", event_type: "tool.invoke", hook: { turn_id: "t-explicit" } } },
    { sourceId: src("post"), record: { session_id: "s1", event_type: "tool.invoke" } },
  ]);
  const derived = spine.filter((turn) => turn.boundary.derived && turn.ordinal !== -1);
  assert.equal(derived.length, 2, "pre and post must land in SEPARATE derived turns");
  assert.deepEqual(derived[0].sources, [src("pre")]);
  assert.deepEqual(derived[1].sources, [src("post")]);
});

test("H3: identifier-shaped fields reject prose injection; quoted commands tolerate conjunctions", () => {
  assert.throws(
    () => observedToolAction({ sourceId: source("tool"), toolName: "alpha emitted event first but tool beta", eventType: "second" }),
    (error) => error.code === "invalid_input",
  );
  assert.throws(
    () => observedDelegation({ sourceId: source("tool"), agentId: "worker one but really two" }),
    (error) => error.code === "invalid_input",
  );
  // A genuine command containing a conjunction is quoted free text, not a second clause.
  const ok = observedCommand({ sourceId: source("tool"), command: "grep -E 'this or that' file.txt", observedResult: "fail", exitCode: 1 });
  assert.match(ok.proposition, /^Command `.*` was observed to fail \(exit 1\)$/);
});

test("H2a: derivedTimeout is material without a duration", () => {
  const out = derivedTimeout({ sourceId: source("tool"), operation: "delegate worker" });
  assert.equal(out.proposition, "Operation `delegate worker` exceeded its timeout (duration unknown)");
  assert.equal(out.rule.id, "timeout-detection");
});
