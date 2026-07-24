import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKFLOW_PROCESS_STATUSES,
  deriveWorkflowOutcome,
  verificationStatusFromFlowGateOutcomes,
} from "../../build/src/workflow-outcome.js";

test("canonical Flow lifecycle maps to process outcomes without claiming task quality", () => {
  const cases = new Map([
    ["completed", "completed"],
    ["accepted_by_exception", "not_verified"],
    ["blocked", "blocked"],
    ["needs_decision", "blocked"],
    ["paused", "blocked"],
    ["canceled", "canceled"],
    ["failed", "failed"],
    ["active", "not_verified"],
  ]);
  for (const [flowStatus, processStatus] of cases) {
    const outcome = deriveWorkflowOutcome(flowStatus, "PASS");
    assert.equal(outcome.process_status, processStatus);
    assert.equal(outcome.flow_status, flowStatus);
    assert.equal(outcome.quality_status, "not_independently_evaluated");
  }
  assert.deepEqual([...WORKFLOW_PROCESS_STATUSES], [
    "completed",
    "blocked",
    "canceled",
    "failed",
    "not_verified",
  ]);
});

test("workflow outcome keeps verification unknown unless an explicit verdict exists", () => {
  assert.equal(deriveWorkflowOutcome("active").verification_status, "NOT_VERIFIED");
  assert.equal(deriveWorkflowOutcome("failed", "FAIL").verification_status, "FAIL");
  assert.throws(() => deriveWorkflowOutcome("../completed"), /bounded opaque status/);
});

test("verification status comes only from canonical Flow verify-gate outcomes", () => {
  assert.equal(verificationStatusFromFlowGateOutcomes(undefined), "NOT_VERIFIED");
  assert.equal(verificationStatusFromFlowGateOutcomes([
    { gate_id: "execute-gate", status: "pass" },
    { gate_id: "verify-gate", status: "pass" },
  ]), "PASS");
  assert.equal(verificationStatusFromFlowGateOutcomes([
    { gate_id: "verify-gate", status: "pass" },
    { gate_id: "verify-gate", status: "route-back" },
  ]), "FAIL");
  assert.equal(verificationStatusFromFlowGateOutcomes([
    { gate_id: "verify-gate", status: "mystery" },
  ]), "NOT_VERIFIED");
});
