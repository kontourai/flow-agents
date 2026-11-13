/**
 * Flow 6 keeps the coarse gate diagnostic `reason` (for example `rejected`) and adds an additive
 * `specific_reason` derived from Surface's blocking transparency gaps. The coarse reason still
 * drives routing; this module only turns the specific reason into a next step an agent can act on,
 * instead of a bare "rejected". Unknown future codes fall back to Surface's own gap message.
 */

type JsonRecord = Record<string, unknown>;

export type EvidenceRejectionGuidance = {
  gate_id: string;
  expectation_id: string;
  /** Flow's coarse diagnostic reason, passed through unchanged. */
  reason: string;
  /** Flow 6's additive Surface-derived detail code. */
  specific_reason: string;
  next_step: string;
};

const NEXT_STEP_BY_SPECIFIC_REASON: Readonly<Record<string, string>> = Object.freeze({
  policy_unresolved: "The claim has no verification policy that resolves for it, so it cannot verify. Re-record the evidence through `workflow evidence` (the writer attaches the policy), or include a policy for this claim type and name it in the claim's `verificationPolicyId`.",
  policy_unresolved_reference: "The claim's `verificationPolicyId` names a policy that is not in the bundle. Include that policy in the bundle, or re-record the evidence through `workflow evidence`.",
  policy_requires_nothing: "The resolved policy requires no evidence type or method, so nothing can verify the claim. Re-record with a policy that requires the evidence you attach.",
  check_result_missing: "A required check (test output, calculation trace or runtime observation) carries no explicit result. Re-run the command through the capture path so its result is recorded as `passing: true`.",
  check_failed: "A required check reported a failing result. Fix the failure and re-run the check, or record `fail` to take the gate's declared route-back.",
  validity_unevaluable: "The claim's validity rule cannot be evaluated (for example a commit rule without a current integrity ref, or a time without an RFC 3339 offset). Re-record with an evaluable validity window and offset timestamps.",
  required_evidence_missing: "The evidence type the policy requires is not attached. Record evidence of the required type for this claim.",
  verification_method_unsatisfied: "The evidence was collected with a method the policy does not accept. Re-record it with the method the policy requires.",
  corroboration_missing: "The policy requires corroboration. Add independent corroborating evidence for the claim.",
  evidence_not_entailing: "The evidence does not support the claim's stated value. Record evidence that entails the value, or correct the claim.",
  verification_stale: "The verification is stale. Re-run the check and record fresh evidence.",
  claim_conflict: "Conflicting claims or evidence block verification. Resolve the dispute or supersede the conflicting claim.",
  policy_violation: "The claim violates its verification policy. Read the Surface gap message and re-record evidence that satisfies the policy.",
});

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function fallbackNextStep(diagnostic: JsonRecord): string {
  const gaps = Array.isArray(diagnostic.surface_gaps) ? diagnostic.surface_gaps.filter(isRecord) : [];
  const message = gaps.map((gap) => gap.message).find(nonEmpty);
  return message
    ? `Surface reports: ${message} Re-record evidence that resolves this gap.`
    : "Surface reported a blocking gap for this claim. Inspect the gate diagnostics and re-record evidence that resolves it.";
}

/**
 * Guidance for each rejected expectation at a currently open gate whose latest Flow outcome
 * blocked with a Surface-specific reason. Outcomes without `specific_reason` (Flow < 6, or a
 * coarse-only rejection) yield nothing, so existing coarse handling is unchanged.
 */
export function evidenceRejectionGuidance(gateOutcomes: unknown, openGateIds: readonly string[]): EvidenceRejectionGuidance[] {
  if (!Array.isArray(gateOutcomes) || openGateIds.length === 0) return [];
  const guidance: EvidenceRejectionGuidance[] = [];
  for (const gateId of openGateIds) {
    const latest = [...gateOutcomes].reverse().find((outcome) => isRecord(outcome) && outcome.gate_id === gateId);
    if (!isRecord(latest) || latest.status !== "block" || !isRecord(latest.diagnostics)) continue;
    const claimEvaluation = Array.isArray(latest.diagnostics.claim_evaluation) ? latest.diagnostics.claim_evaluation.filter(isRecord) : [];
    for (const diagnostic of claimEvaluation) {
      if (!nonEmpty(diagnostic.specific_reason) || !nonEmpty(diagnostic.expectation_id) || !nonEmpty(diagnostic.reason)) continue;
      guidance.push({
        gate_id: gateId,
        expectation_id: diagnostic.expectation_id,
        reason: diagnostic.reason,
        specific_reason: diagnostic.specific_reason,
        next_step: Object.hasOwn(NEXT_STEP_BY_SPECIFIC_REASON, diagnostic.specific_reason)
          ? NEXT_STEP_BY_SPECIFIC_REASON[diagnostic.specific_reason]!
          : fallbackNextStep(diagnostic),
      });
    }
  }
  return guidance;
}
