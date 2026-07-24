import test from "node:test";
import assert from "node:assert/strict";

import * as consoleContract from "../../build/src/console-contract.js";

const EXPECTED_VALUE_EXPORTS = [
  "WORKFLOW_STATUS_TO_CONSOLE_PROCESS_STATUS",
  "mapWorkflowStatusToConsoleProcessStatus",
  "deriveConsoleProcessBlockedReason",
];

test("console-contract subpath exports the documented value contract", () => {
  for (const name of EXPECTED_VALUE_EXPORTS) {
    assert.ok(name in consoleContract, `${name} must be exported from the console-contract subpath`);
  }
  assert.equal(typeof consoleContract.mapWorkflowStatusToConsoleProcessStatus, "function");
  assert.equal(typeof consoleContract.deriveConsoleProcessBlockedReason, "function");
  assert.equal(typeof consoleContract.WORKFLOW_STATUS_TO_CONSOLE_PROCESS_STATUS, "object");
});

test("console-contract subpath exports no other surprise value exports", () => {
  const actual = Object.keys(consoleContract).sort();
  assert.deepEqual(actual, [...EXPECTED_VALUE_EXPORTS].sort());
});

test("WORKFLOW_STATUS_TO_CONSOLE_PROCESS_STATUS is frozen at runtime", () => {
  const table = consoleContract.WORKFLOW_STATUS_TO_CONSOLE_PROCESS_STATUS;
  assert.equal(Object.isFrozen(table), true);
  assert.throws(() => {
    table.new = "running";
  });
});

test("WORKFLOW_STATUS_TO_CONSOLE_PROCESS_STATUS carries the full status table", () => {
  const table = consoleContract.WORKFLOW_STATUS_TO_CONSOLE_PROCESS_STATUS;
  assert.equal(table.new, "not_started");
  assert.equal(table.blocked, "blocked");
  assert.equal(table.failed, "failed");
  assert.equal(table.delivered, "completed");
  assert.equal(table.canceled, "cancelled");
});

test("mapWorkflowStatusToConsoleProcessStatus matches the base table for a non-refined status", () => {
  assert.equal(consoleContract.mapWorkflowStatusToConsoleProcessStatus("in_progress"), "running");
  assert.equal(consoleContract.mapWorkflowStatusToConsoleProcessStatus("blocked"), "blocked");
});

test("mapWorkflowStatusToConsoleProcessStatus refines verified+done to completed", () => {
  assert.equal(consoleContract.mapWorkflowStatusToConsoleProcessStatus("verified", "done"), "completed");
  assert.equal(consoleContract.mapWorkflowStatusToConsoleProcessStatus("verified", "continue"), "running");
});

test("mapWorkflowStatusToConsoleProcessStatus overrides non-terminal statuses with review_pending on an unresolved critique", () => {
  assert.equal(
    consoleContract.mapWorkflowStatusToConsoleProcessStatus("in_progress", "continue", true),
    "review_pending",
  );
  assert.equal(
    consoleContract.mapWorkflowStatusToConsoleProcessStatus("delivered", "done", true),
    "completed",
    "terminal statuses must not be overridden by an unresolved critique",
  );
});

test("deriveConsoleProcessBlockedReason sources blocked reason from handoff blockers, else clears for non-eligible statuses", () => {
  assert.equal(
    consoleContract.deriveConsoleProcessBlockedReason("blocked", { handoffBlockers: ["waiting on review"] }),
    "waiting on review",
  );
  assert.equal(
    consoleContract.deriveConsoleProcessBlockedReason("completed", { nextActionSummary: "should be dropped" }),
    undefined,
  );
});
