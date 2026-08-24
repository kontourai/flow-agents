import {
  containsSensitiveCredential,
  validateRunCorrelationPresence,
  type RunCorrelationPresence,
} from "./run-correlation.js";

/** Portable, provider-neutral delegation contract revision. */
export const DELEGATION_ENVELOPE_SCHEMA_VERSION = "1.0" as const;

export type DelegationPosture = "report-only" | "writer";
export type DelegationApprovalPosture = "automatic" | "requires_approval";
export type DelegationEscalationPosture = "deny" | "request";

export type DelegationFlowBinding =
  | {
    status: "bound";
    flow_run_id: string;
    flow_step_id: string;
    gate_attempt: number;
  }
  | { status: "unbound"; reason: string };

export type DelegationSourceBinding = {
  repository_id: string;
  worktree_id: string;
  source_state_id: string;
  dirty_state_fingerprint?: string;
};

export type DelegationAuthority = {
  allowed_tools: string[];
  allowed_effects: string[];
  mutable_resources: string[];
  posture: DelegationPosture;
  approval: DelegationApprovalPosture;
  escalation: DelegationEscalationPosture;
};

export type DelegationBudget = {
  max_attempts: number;
  max_depth: number;
  max_concurrent_children: number;
  max_input_tokens: number;
  max_output_tokens: number;
  max_cost_micros: number;
  expires_at: string;
};

/**
 * A closed portable delegation value. It deliberately carries references and
 * limits, never prompts, credentials, provider diagnostics, or host-specific
 * lifecycle state. Hosts propagate it; they do not extend it.
 */
export type DelegationEnvelope = {
  schema_version: typeof DELEGATION_ENVELOPE_SCHEMA_VERSION;
  envelope_id: string;
  generation: number;
  parent_envelope_id?: string;
  correlation: RunCorrelationPresence;
  flow_binding: DelegationFlowBinding;
  actor_id: string;
  subject_id: string;
  source: DelegationSourceBinding;
  authority: DelegationAuthority;
  budget: DelegationBudget;
  runtime: {
    required_capabilities: string[];
    runtime_receipt_ref: string;
    model_receipt_ref: string;
  };
  continuation_id: string;
  cancellation_id: string;
  revisions: {
    prompt_revision: string;
    rubric_revision: string;
    policy_revision: string;
  };
};

export class DelegationEnvelopeValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid delegation envelope: ${issues.join("; ")}`);
    this.name = "DelegationEnvelopeValidationError";
    this.issues = [...issues];
  }
}

export class DelegationEnvelopeNarrowingError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Delegation envelope is not a monotonic narrowing: ${issues.join("; ")}`);
    this.name = "DelegationEnvelopeNarrowingError";
    this.issues = [...issues];
  }
}

const envelopeKeys = new Set([
  "schema_version",
  "envelope_id",
  "generation",
  "parent_envelope_id",
  "correlation",
  "flow_binding",
  "actor_id",
  "subject_id",
  "source",
  "authority",
  "budget",
  "runtime",
  "continuation_id",
  "cancellation_id",
  "revisions",
]);
const sourceKeys = new Set(["repository_id", "worktree_id", "source_state_id", "dirty_state_fingerprint"]);
const authorityKeys = new Set(["allowed_tools", "allowed_effects", "mutable_resources", "posture", "approval", "escalation"]);
const budgetKeys = new Set(["max_attempts", "max_depth", "max_concurrent_children", "max_input_tokens", "max_output_tokens", "max_cost_micros", "expires_at"]);
const runtimeKeys = new Set(["required_capabilities", "runtime_receipt_ref", "model_receipt_ref"]);
const revisionKeys = new Set(["prompt_revision", "rubric_revision", "policy_revision"]);
const boundFlowKeys = new Set(["status", "flow_run_id", "flow_step_id", "gate_attempt"]);
const unboundFlowKeys = new Set(["status", "reason"]);
const opaqueIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:@#/-]{0,254}$/;
const uriIdentifier = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const resource = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9][A-Za-z0-9._@-]*(?:\/[A-Za-z0-9][A-Za-z0-9._@-]*)*$/;
const canonicalTimestamp = /^(?:(?:[0-9]{4}-(?:(?:01|03|05|07|08|10|12)-(?:0[1-9]|[12][0-9]|3[01])|(?:04|06|09|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8])))|(?:(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:00|0[48]|[2468][048]|[13579][26])00)-02-29))T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && opaqueIdentifier.test(value)
    && !uriIdentifier.test(value)
    && !containsSensitiveCredential(value);
}

function isSafeReason(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && !/[\u0000-\u001f\u007f]/.test(value)
    && !containsSensitiveCredential(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !canonicalTimestamp.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0;
}

function isUniqueList(value: unknown, validator: (item: unknown) => boolean): value is string[] {
  return Array.isArray(value)
    && value.every(validator)
    && new Set(value).size === value.length;
}

function isResourceList(value: unknown): value is string[] {
  return isUniqueList(value, (item) => typeof item === "string" && resource.test(item) && !containsSensitiveCredential(item));
}

function validateFlowBinding(value: unknown, issues: string[]): value is DelegationFlowBinding {
  if (!isRecord(value)) {
    issues.push("flow_binding must be an object");
    return false;
  }
  if (value.status === "bound") {
    if (!hasOnlyKeys(value, boundFlowKeys)) issues.push("flow_binding has unknown properties");
    if (!isSafeIdentifier(value.flow_run_id)) issues.push("flow_binding.flow_run_id must be a safe identifier");
    if (!isSafeIdentifier(value.flow_step_id)) issues.push("flow_binding.flow_step_id must be a safe identifier");
    if (!isNonNegativeInteger(value.gate_attempt)) issues.push("flow_binding.gate_attempt must be a non-negative integer");
    return true;
  }
  if (value.status === "unbound") {
    if (!hasOnlyKeys(value, unboundFlowKeys)) issues.push("flow_binding has unknown properties");
    if (!isSafeReason(value.reason)) issues.push("flow_binding.reason must be a bounded non-sensitive explanation");
    return true;
  }
  issues.push("flow_binding.status must be bound or unbound");
  return false;
}

function validateSource(value: unknown, issues: string[]): value is DelegationSourceBinding {
  if (!isRecord(value)) {
    issues.push("source must be an object");
    return false;
  }
  if (!hasOnlyKeys(value, sourceKeys)) issues.push("source has unknown properties");
  for (const key of ["repository_id", "worktree_id", "source_state_id"] as const) {
    if (!isSafeIdentifier(value[key])) issues.push(`source.${key} must be a safe identifier`);
  }
  if (value.dirty_state_fingerprint !== undefined && (typeof value.dirty_state_fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(value.dirty_state_fingerprint))) {
    issues.push("source.dirty_state_fingerprint must be a SHA-256 digest");
  }
  return true;
}

function validateAuthority(value: unknown, issues: string[]): value is DelegationAuthority {
  if (!isRecord(value)) {
    issues.push("authority must be an object");
    return false;
  }
  if (!hasOnlyKeys(value, authorityKeys)) issues.push("authority has unknown properties");
  if (!isUniqueList(value.allowed_tools, isSafeIdentifier)) issues.push("authority.allowed_tools must be unique safe identifiers");
  if (!isUniqueList(value.allowed_effects, isSafeIdentifier)) issues.push("authority.allowed_effects must be unique safe identifiers");
  if (!isResourceList(value.mutable_resources)) issues.push("authority.mutable_resources must be unique relative POSIX resources");
  if (value.posture !== "report-only" && value.posture !== "writer") issues.push("authority.posture is invalid");
  if (value.approval !== "automatic" && value.approval !== "requires_approval") issues.push("authority.approval is invalid");
  if (value.escalation !== "deny" && value.escalation !== "request") issues.push("authority.escalation is invalid");
  return true;
}

function validateBudget(value: unknown, issues: string[]): value is DelegationBudget {
  if (!isRecord(value)) {
    issues.push("budget must be an object");
    return false;
  }
  if (!hasOnlyKeys(value, budgetKeys)) issues.push("budget has unknown properties");
  for (const key of ["max_attempts", "max_depth", "max_concurrent_children", "max_input_tokens", "max_output_tokens", "max_cost_micros"] as const) {
    if (!isNonNegativeInteger(value[key])) issues.push(`budget.${key} must be a non-negative integer`);
  }
  if (!isCanonicalTimestamp(value.expires_at)) issues.push("budget.expires_at must be canonical UTC milliseconds");
  return true;
}

function validateRuntime(value: unknown, issues: string[]): boolean {
  if (!isRecord(value)) {
    issues.push("runtime must be an object");
    return false;
  }
  if (!hasOnlyKeys(value, runtimeKeys)) issues.push("runtime has unknown properties");
  if (!isUniqueList(value.required_capabilities, isSafeIdentifier)) issues.push("runtime.required_capabilities must be unique safe identifiers");
  if (!isSafeIdentifier(value.runtime_receipt_ref)) issues.push("runtime.runtime_receipt_ref must be a safe identifier");
  if (!isSafeIdentifier(value.model_receipt_ref)) issues.push("runtime.model_receipt_ref must be a safe identifier");
  return true;
}

function validateRevisions(value: unknown, issues: string[]): boolean {
  if (!isRecord(value)) {
    issues.push("revisions must be an object");
    return false;
  }
  if (!hasOnlyKeys(value, revisionKeys)) issues.push("revisions has unknown properties");
  for (const key of ["prompt_revision", "rubric_revision", "policy_revision"] as const) {
    if (!isSafeIdentifier(value[key])) issues.push(`revisions.${key} must be a safe identifier`);
  }
  return true;
}

/** Validate and defensively copy a closed v1 delegation envelope. */
export function validateDelegationEnvelope(value: unknown): DelegationEnvelope {
  const issues: string[] = [];
  if (!isRecord(value)) throw new DelegationEnvelopeValidationError(["envelope must be an object"]);
  if (!hasOnlyKeys(value, envelopeKeys)) issues.push("envelope has unknown properties");
  if (value.schema_version !== DELEGATION_ENVELOPE_SCHEMA_VERSION) issues.push("schema_version must be 1.0");
  if (typeof value.envelope_id !== "string" || !uuid.test(value.envelope_id)) issues.push("envelope_id must be a canonical UUIDv4");
  if (!isNonNegativeInteger(value.generation)) issues.push("generation must be a non-negative integer");
  if (value.parent_envelope_id !== undefined && (typeof value.parent_envelope_id !== "string" || !uuid.test(value.parent_envelope_id))) issues.push("parent_envelope_id must be a canonical UUIDv4");
  if (value.parent_envelope_id === undefined && value.generation !== 0) issues.push("root envelopes must have generation zero");
  if (value.parent_envelope_id !== undefined && value.generation === 0) issues.push("child envelopes must have a positive generation");
  try {
    validateRunCorrelationPresence(value.correlation);
  } catch {
    issues.push("correlation must satisfy the canonical run-correlation contract");
  }
  validateFlowBinding(value.flow_binding, issues);
  if (!isSafeIdentifier(value.actor_id)) issues.push("actor_id must be a safe identifier");
  if (!isSafeIdentifier(value.subject_id)) issues.push("subject_id must be a safe identifier");
  validateSource(value.source, issues);
  validateAuthority(value.authority, issues);
  validateBudget(value.budget, issues);
  validateRuntime(value.runtime, issues);
  if (!isSafeIdentifier(value.continuation_id)) issues.push("continuation_id must be a safe identifier");
  if (!isSafeIdentifier(value.cancellation_id)) issues.push("cancellation_id must be a safe identifier");
  validateRevisions(value.revisions, issues);
  if (issues.length > 0) throw new DelegationEnvelopeValidationError(issues);
  return structuredClone(value) as DelegationEnvelope;
}

/**
 * Return a defensive copy only when the supplied canonical observation time is
 * strictly before the envelope expiry. Callers provide time explicitly so this
 * portable contract never consults a host clock.
 */
export function assertDelegationEnvelopeActiveAt(
  value: unknown,
  observedAt: unknown,
): DelegationEnvelope {
  const envelope = validateDelegationEnvelope(value);
  if (!isCanonicalTimestamp(observedAt)) {
    throw new DelegationEnvelopeValidationError([
      "observed_at must be a canonical UTC milliseconds timestamp",
    ]);
  }
  if (Date.parse(observedAt) >= Date.parse(envelope.budget.expires_at)) {
    throw new DelegationEnvelopeNarrowingError([
      "envelope is expired at observed_at",
    ]);
  }
  return structuredClone(envelope);
}

function isSubset(child: readonly string[], parent: readonly string[]): boolean {
  const allowed = new Set(parent);
  return child.every((value) => allowed.has(value));
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Accept a child only when it is exactly linked to the parent and narrows the
 * parent's executable authority. The returned child is a defensive copy.
 */
export function narrowDelegationEnvelope(
  parentValue: unknown,
  childValue: unknown,
  observedAt: unknown,
): DelegationEnvelope {
  const parent = assertDelegationEnvelopeActiveAt(parentValue, observedAt);
  const child = assertDelegationEnvelopeActiveAt(childValue, observedAt);
  const issues: string[] = [];
  if (child.envelope_id === parent.envelope_id) issues.push("child envelope_id must differ from parent");
  if (child.parent_envelope_id !== parent.envelope_id) issues.push("child parent_envelope_id must equal parent envelope_id");
  if (child.generation !== parent.generation + 1) issues.push("child generation must increment parent generation by one");
  for (const [name, left, right] of [
    ["correlation", child.correlation, parent.correlation],
    ["flow_binding", child.flow_binding, parent.flow_binding],
    ["actor_id", child.actor_id, parent.actor_id],
    ["subject_id", child.subject_id, parent.subject_id],
    ["source", child.source, parent.source],
    ["runtime", child.runtime, parent.runtime],
    ["continuation_id", child.continuation_id, parent.continuation_id],
    ["cancellation_id", child.cancellation_id, parent.cancellation_id],
    ["revisions", child.revisions, parent.revisions],
  ] as const) {
    if (!equalJson(left, right)) issues.push(`child ${name} must equal parent ${name}`);
  }
  if (!isSubset(child.authority.allowed_tools, parent.authority.allowed_tools)) issues.push("child allowed_tools must be a subset of parent allowed_tools");
  if (!isSubset(child.authority.allowed_effects, parent.authority.allowed_effects)) issues.push("child allowed_effects must be a subset of parent allowed_effects");
  if (!isSubset(child.authority.mutable_resources, parent.authority.mutable_resources)) issues.push("child mutable_resources must be a subset of parent mutable_resources");
  if (parent.authority.posture === "report-only" && child.authority.posture !== "report-only") issues.push("child cannot widen report-only posture to writer");
  if (parent.authority.approval === "requires_approval" && child.authority.approval !== "requires_approval") issues.push("child cannot weaken required approval");
  if (parent.authority.escalation === "deny" && child.authority.escalation !== "deny") issues.push("child cannot widen denied escalation to request");
  for (const key of ["max_attempts", "max_concurrent_children", "max_input_tokens", "max_output_tokens", "max_cost_micros"] as const) {
    if (child.budget[key] > parent.budget[key]) issues.push(`child budget.${key} exceeds parent`);
  }
  if (parent.budget.max_depth === 0) {
    issues.push("a parent with zero depth cannot derive a child");
  } else if (child.budget.max_depth > parent.budget.max_depth - 1) {
    issues.push("child budget.max_depth must consume one parent depth");
  }
  if (Date.parse(child.budget.expires_at) > Date.parse(parent.budget.expires_at)) issues.push("child budget.expires_at must not exceed parent expiry");
  if (issues.length > 0) throw new DelegationEnvelopeNarrowingError(issues);
  return structuredClone(child);
}
