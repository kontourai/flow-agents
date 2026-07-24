export const WORKFLOW_PROCESS_STATUSES = [
  "completed",
  "blocked",
  "canceled",
  "failed",
  "not_verified",
] as const;

export type WorkflowProcessStatus = (typeof WORKFLOW_PROCESS_STATUSES)[number];

export type WorkflowOutcome = {
  schema_version: "1.0";
  source: "canonical_flow_projection";
  flow_status: string;
  process_status: WorkflowProcessStatus;
  verification_status: "PASS" | "FAIL" | "NOT_VERIFIED";
  quality_status: "not_independently_evaluated";
};

export type WorkflowVerificationStatus = WorkflowOutcome["verification_status"];

export function deriveWorkflowOutcome(
  flowStatus: string,
  verificationStatus?: unknown,
): WorkflowOutcome {
  const normalizedFlowStatus = boundedStatus(flowStatus);
  return {
    schema_version: "1.0",
    source: "canonical_flow_projection",
    flow_status: normalizedFlowStatus,
    process_status: processStatus(normalizedFlowStatus),
    verification_status: normalizeVerificationStatus(verificationStatus),
    quality_status: "not_independently_evaluated",
  };
}

export function verificationStatusFromFlowGateOutcomes(value: unknown): WorkflowVerificationStatus {
  if (!Array.isArray(value)) return "NOT_VERIFIED";
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const outcome = value[index];
    if (!isRecord(outcome) || outcome.gate_id !== "verify-gate") continue;
    if (outcome.status === "pass") return "PASS";
    if (outcome.status === "route-back") return "FAIL";
    return "NOT_VERIFIED";
  }
  return "NOT_VERIFIED";
}

function processStatus(flowStatus: string): WorkflowProcessStatus {
  if (flowStatus === "completed") return "completed";
  if (flowStatus === "blocked" || flowStatus === "needs_decision" || flowStatus === "paused") return "blocked";
  if (flowStatus === "canceled") return "canceled";
  if (flowStatus === "failed") return "failed";
  return "not_verified";
}

function normalizeVerificationStatus(value: unknown): WorkflowOutcome["verification_status"] {
  return value === "PASS" || value === "FAIL" || value === "NOT_VERIFIED"
    ? value
    : "NOT_VERIFIED";
}

function boundedStatus(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(normalized)) {
    throw new TypeError("flowStatus must be a bounded opaque status identifier");
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
