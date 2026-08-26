import test from "node:test";
import assert from "node:assert/strict";

import * as consoleContract from "../../build/src/console-contract.js";

const EXPECTED_VALUE_EXPORTS = [
  "WORKFLOW_STATUS_TO_CONSOLE_PROCESS_STATUS",
  "mapWorkflowStatusToConsoleProcessStatus",
  "deriveConsoleProcessBlockedReason",
  // #1021: the liveness lane predicate. Pure and dependency-free, so it belongs on the same
  // contract surface as the mappers above -- Console renders lane state, and a renderer that
  // recomputes "is this still live" from an age and a TTL is the #933 drift shape again.
  "laneState",
];

test("console-contract subpath exports the documented value contract", () => {
  for (const name of EXPECTED_VALUE_EXPORTS) {
    assert.ok(name in consoleContract, `${name} must be exported from the console-contract subpath`);
  }
  assert.equal(typeof consoleContract.mapWorkflowStatusToConsoleProcessStatus, "function");
  assert.equal(typeof consoleContract.deriveConsoleProcessBlockedReason, "function");
  assert.equal(typeof consoleContract.WORKFLOW_STATUS_TO_CONSOLE_PROCESS_STATUS, "object");
  assert.equal(typeof consoleContract.laneState, "function");
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

// --- laneState (#1021) ---
// The whole point of exporting this is that a renderer must NOT recompute liveness from an age
// and a TTL. These assert the rule through the contract subpath, so the subpath itself is the
// thing under test -- a re-export that silently stopped resolving would fail here, not just in
// the liveness-fleet unit tests.

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const at = (msAgo) => new Date(NOW - msAgo).toISOString();

test("laneState: a trailing release is released regardless of elapsed time", () => {
  assert.equal(
    consoleContract.laneState({ lastEventType: "release", lastEventAt: at(0), ttlSeconds: 1800 }, NOW),
    "released",
  );
});

test("laneState: a heartbeat inside its TTL still holds, and past its TTL is reclaimable", () => {
  assert.equal(
    consoleContract.laneState({ lastEventType: "heartbeat", lastEventAt: at(60_000), ttlSeconds: 1800 }, NOW),
    "held",
  );
  assert.equal(
    consoleContract.laneState({ lastEventType: "heartbeat", lastEventAt: at(1_801_000), ttlSeconds: 1800 }, NOW),
    "reclaimable",
  );
});

test("laneState: an unparsable timestamp is reclaimable, never held", () => {
  assert.equal(
    consoleContract.laneState({ lastEventType: "claim", lastEventAt: "not-a-timestamp", ttlSeconds: 1800 }, NOW),
    "reclaimable",
    "an unreadable lease must not exclude work",
  );
});
