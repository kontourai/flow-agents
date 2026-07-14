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
    "Command npm test was observed to pass (exit 0)");
  assert.equal(observedCommand({ sourceId: source("ambiguous"), command: "grep needle", observedResult: "ambiguous", exitCode: null }).proposition,
    "Command grep needle was observed to complete ambiguously (exit unknown)");
  assert.equal(observedToolAction({ sourceId: source("tool"), toolName: "execute_bash", eventType: "tool.invoke" }).proposition,
    "Tool execute_bash emitted event tool.invoke");
  assert.equal(observedDelegation({ sourceId: source("delegation"), agentId: "agent-1", targets: ["worker-1", "worker-2"] }).proposition,
    "Agent agent-1 delegated work to worker-1, worker-2");
  assert.equal(observedFileCreation({ sourceId: fileSource, path: "created.txt" }).proposition,
    "File created.txt was observed to be created");
});

test("derived constructors render rules with grounded inputs", () => {
  const first = source("retry-1");
  const second = source("retry-2");
  assert.deepEqual(derivedRetry({ sourceIds: [first, second], command: "npm test", attempts: 2, ruleInputs: [first, second] }), {
    id: derivedRetry({ sourceIds: [first, second], command: "npm test", attempts: 2, ruleInputs: [first, second] }).id,
    class: "deterministic_derived",
    proposition: "Command npm test was retried across 2 attempts",
    source_refs: [first, second],
    rule: { id: "retry-detection", version: "v1", inputs: [first, second] },
  });
  assert.equal(derivedNoOpTurn({ turnRef: 3, sourceIds: [first] }).proposition, "Turn 3 was classified as a no-op");
  assert.equal(derivedNoOpTurn({ turnRef: -1, sourceIds: [first] }).turn_ref, -1);
  assert.equal(derivedTimeout({ sourceId: first, operation: "delegate worker", timeoutMs: 30000 }).proposition,
    "Operation delegate worker exceeded its 30000 ms timeout");
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
  assert.match(a.id, /^[0-9a-f]{8}$/);
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
