import test from "node:test";
import assert from "node:assert/strict";
import { evidenceRejectionGuidance } from "../../build/src/flow-specific-reason-guidance.js";

const blocked = (diagnostics, gateId = "verify-gate") => ({ gate_id: gateId, status: "block", missing: ["tests-evidence"], diagnostics: { claim_evaluation: diagnostics } });

test("each Flow 6 specific reason maps to an actionable next step and keeps the coarse reason", () => {
  const cases = {
    policy_unresolved: /no verification policy that resolves/,
    policy_unresolved_reference: /names a policy that is not in the bundle/,
    policy_requires_nothing: /requires no evidence type or method/,
    check_result_missing: /carries no explicit result/,
    check_failed: /reported a failing result.*route-back/,
    validity_unevaluable: /validity rule cannot be evaluated/,
    required_evidence_missing: /policy requires is not attached/,
    verification_method_unsatisfied: /method the policy does not accept/,
    corroboration_missing: /requires corroboration/,
    evidence_not_entailing: /does not support the claim's stated value/,
    verification_stale: /verification is stale/,
    claim_conflict: /Conflicting claims or evidence/,
    policy_violation: /violates its verification policy/,
  };
  for (const [specific, pattern] of Object.entries(cases)) {
    const [entry] = evidenceRejectionGuidance([blocked([{ expectation_id: "tests-evidence", evidence_id: "ev.1", reason: "rejected", specific_reason: specific }])], ["verify-gate"]);
    assert.equal(entry.reason, "rejected", specific);
    assert.equal(entry.specific_reason, specific);
    assert.match(entry.next_step, pattern, specific);
  }
});

test("an unknown specific reason falls back to Surface's own gap message", () => {
  const [entry] = evidenceRejectionGuidance([blocked([{ expectation_id: "tests-evidence", evidence_id: "ev.1", reason: "rejected", specific_reason: "surface_blocking_gap", surface_gaps: [{ message: "Claim c has an unclassified blocking gap." }] }])], ["verify-gate"]);
  assert.match(entry.next_step, /^Surface reports: Claim c has an unclassified blocking gap\./);
});

test("coarse-only rejections, passing outcomes, superseded outcomes and closed gates yield no guidance", () => {
  const coarseOnly = blocked([{ expectation_id: "tests-evidence", evidence_id: "ev.1", reason: "rejected" }]);
  assert.deepEqual(evidenceRejectionGuidance([coarseOnly], ["verify-gate"]), []);
  const rejected = blocked([{ expectation_id: "tests-evidence", evidence_id: "ev.1", reason: "rejected", specific_reason: "check_failed" }]);
  assert.deepEqual(evidenceRejectionGuidance([rejected, { gate_id: "verify-gate", status: "pass" }], ["verify-gate"]), [], "only the gate's latest outcome counts");
  assert.deepEqual(evidenceRejectionGuidance([rejected], ["merge-ready-gate"]), [], "a gate that is not open yields nothing");
  assert.deepEqual(evidenceRejectionGuidance(undefined, ["verify-gate"]), []);
});
