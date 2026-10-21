import { createHash } from "node:crypto";
import { canonicalJson } from "@kontourai/relay";
import type { FlowDefinitionIdentity } from "@kontourai/flow";
import { containsSensitiveCredential } from "./run-correlation.js";

export const DELEGATION_AUTHORITY_SCHEMA_VERSION = "2.0" as const;
export const DELEGATION_V2_MAX_BYTES = 1024 * 1024;
export const DELEGATION_V2_MAX_GRANTS = 64;
export const DELEGATION_V2_MAX_DEPTH = 32;
export const DELEGATION_AUTHORITY_DIGEST_DOMAIN = "flow-agents/delegation-authority/2.0";

/** A content reference, never a signature, credential, or transferable authority. */
export type DelegationReferenceV2 = { id: string; domain: string; digest: string };
export type PublishedFlowDefinitionIdentity = Readonly<FlowDefinitionIdentity>;
export type DelegationResourceV2 = {
  repository_id: string;
  execution_worktree_id: string;
  /** Relative POSIX path; '.' names the root object only, never its descendants. */
  path: string;
};
export type DelegationAuthorityV2 = {
  allowed_tools: string[];
  allowed_effects: string[];
  readable_resources: DelegationResourceV2[];
  mutable_resources: DelegationResourceV2[];
  posture: "report-only" | "writer";
  approval: "automatic" | "requires_approval";
  escalation: "deny" | "request";
};
/** Limits on a subtree, not evidence of spent/reserved capacity. Total envelopes includes self. */
export type DelegationBudgetV2 = {
  remaining_depth: number;
  /** Lifetime immediate-child limit at each envelope; aggregate usage is host-owned. */
  max_total_children: number;
  max_total_envelopes: number;
  max_concurrent_children: number;
  max_runtime_ms: number;
  max_input_tokens: number;
  max_output_tokens: number;
  /** Upper bound in millionths of USD; fractional micros round upward. No currency conversion. */
  max_cost_micros: number;
  max_attempts: number;
  expires_at: string;
};
export type DelegationFlowBindingV2 =
  | { status: "unbound"; reason: string }
  | { status: "bound"; flow_run_id: string; definition: PublishedFlowDefinitionIdentity; flow_step_id: string; gate_attempt: number };
export type DelegationExecutionBindingV2 = {
  runtime: {
    runtime_receipt_ref: DelegationReferenceV2;
    model_receipt_ref: DelegationReferenceV2;
    required_capabilities: string[];
  };
  source: {
    repository_id: string;
    source_state_id: string;
    dirty_state_fingerprint: string | null;
    execution_worktree_id: string;
    source_admission_receipt: DelegationReferenceV2;
  };
  flow_binding: DelegationFlowBindingV2;
};
/** One indivisible preauthorized selection, not independent runtime/source allowlists. */
export type DelegationExecutionGrantV2 = DelegationExecutionBindingV2 & {
  grant_id: string;
  authority_ceiling: DelegationAuthorityV2;
};
export type RootAuthorityV2 = {
  schema_version: typeof DELEGATION_AUTHORITY_SCHEMA_VERSION;
  authority_id: string;
  authority_epoch: number;
  issuer_host_id: string;
  authenticated_principal_ref: DelegationReferenceV2;
  authenticated_subject_ref: DelegationReferenceV2;
  source_origin: {
    repository_id: string;
    worktree_id: string;
    source_state_id: string;
    dirty_state_fingerprint: string | null;
  };
  execution_worktree_ids: string[];
  execution_grants: DelegationExecutionGrantV2[];
  delegation_ceiling: DelegationAuthorityV2;
  budget: DelegationBudgetV2;
  revisions: { policy: DelegationReferenceV2; prompt: DelegationReferenceV2; rubric: DelegationReferenceV2 };
  root_trace: { trace_id: string; span_id: string };
  root_cancellation_ref: DelegationReferenceV2;
};

export class DelegationContractV2Error extends Error {
  constructor(readonly code: string) {
    super(`Delegation v2 refused: ${code}`);
    this.name = "DelegationContractV2Error";
  }
}

// Shared closed-contract primitives; none perform I/O, authentication, or host admission.
export function requireDelegationV2(condition: unknown, code: string): asserts condition {
  if (!condition) throw new DelegationContractV2Error(code);
}
export function delegationRecordV2(value: unknown, keys: readonly string[]): Record<string, unknown> {
  requireDelegationV2(typeof value === "object" && value !== null && !Array.isArray(value), "invalid_object");
  const r = value as Record<string, unknown>;
  requireDelegationV2(Object.getPrototypeOf(r) === Object.prototype || Object.getPrototypeOf(r) === null, "invalid_object_prototype");
  requireDelegationV2(Object.keys(r).length === keys.length && keys.every(key => Object.hasOwn(r, key)), "unknown_or_missing_property");
  return r;
}
export function delegationIdV2(value: unknown): asserts value is string {
  requireDelegationV2(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@#/-]{0,254}$/.test(value)
    && !containsSensitiveCredential(value), "invalid_identifier");
}
export function delegationIntegerV2(value: unknown, max = 1_000_000_000_000): asserts value is number {
  requireDelegationV2(typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= 0 && value <= max, "invalid_integer");
}
export function delegationTimestampV2(value: unknown): asserts value is string {
  requireDelegationV2(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, "invalid_timestamp");
}
export function delegationDigestV2(value: unknown): asserts value is string {
  requireDelegationV2(typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value), "invalid_digest");
}
export function delegationReferenceV2(value: unknown): asserts value is DelegationReferenceV2 {
  const r = delegationRecordV2(value, ["id", "domain", "digest"]);
  delegationIdV2(r.id); delegationIdV2(r.domain); delegationDigestV2(r.digest);
}
export function delegationListV2<T>(value: unknown, validate: (item: unknown) => asserts item is T, max = 64): asserts value is T[] {
  requireDelegationV2(Array.isArray(value) && value.length <= max, "invalid_list_bound");
  value.forEach(item => validate(item));
  requireDelegationV2(new Set(value.map(item => canonicalJson(item))).size === value.length, "duplicate_list_item");
}

/** Reject hostile/non-JSON values before cloning or canonicalizing. No getters or toJSON run. */
export function copyDelegationJsonV2(value: unknown): unknown {
  let bytes = 0, nodes = 0;
  const active = new Set<object>();
  function text(value: string): void {
    requireDelegationV2(value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value) && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value), "invalid_json_text");
    requireDelegationV2(!containsSensitiveCredential(value), "sensitive_credential");
    bytes += Buffer.byteLength(JSON.stringify(value));
  }
  function visit(item: unknown, depth: number): unknown {
    requireDelegationV2(++nodes <= 100000 && depth <= 24, "json_bounds");
    if (typeof item === "string") { text(item); return item; }
    if (typeof item === "number") {
      requireDelegationV2(Number.isSafeInteger(item) && !Object.is(item, -0), "invalid_json_number");
      bytes += 24; return item;
    }
    if (item === null || typeof item === "boolean") { bytes += 5; return item; }
    requireDelegationV2(typeof item === "object" && item !== null, "invalid_json_value");
    requireDelegationV2(!active.has(item), "json_cycle");
    active.add(item);
    let result: unknown;
    if (Array.isArray(item)) {
      requireDelegationV2(Object.getPrototypeOf(item) === Array.prototype && item.length <= 64
        && Reflect.ownKeys(item).length === item.length + 1, "invalid_json_array");
      const list: unknown[] = [];
      for (let i = 0; i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        requireDelegationV2(descriptor && "value" in descriptor && descriptor.enumerable, "invalid_json_array");
        list.push(visit(descriptor.value, depth + 1));
      }
      result = list;
    } else {
      requireDelegationV2(Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null, "invalid_object_prototype");
      const entries: [string, unknown][] = [];
      const keys = Reflect.ownKeys(item);
      requireDelegationV2(keys.length <= 64, "json_bounds");
      for (const key of keys) {
        requireDelegationV2(typeof key === "string" && !["__proto__", "constructor", "prototype"].includes(key), "invalid_json_key");
        text(key);
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        requireDelegationV2(descriptor && "value" in descriptor && descriptor.enumerable, "invalid_json_property");
        entries.push([key, visit(descriptor.value, depth + 1)]);
      }
      result = Object.fromEntries(entries);
    }
    active.delete(item);
    bytes += 2 + Reflect.ownKeys(item).length * 2;
    requireDelegationV2(bytes <= DELEGATION_V2_MAX_BYTES, "json_byte_bound");
    return result;
  }
  const result = visit(value, 0);
  requireDelegationV2(bytes <= DELEGATION_V2_MAX_BYTES && Buffer.byteLength(canonicalJson(result)) <= DELEGATION_V2_MAX_BYTES, "json_byte_bound");
  return result;
}

function resource(value: unknown): asserts value is DelegationResourceV2 {
  const r = delegationRecordV2(value, ["repository_id", "execution_worktree_id", "path"]);
  delegationIdV2(r.repository_id); delegationIdV2(r.execution_worktree_id);
  requireDelegationV2(typeof r.path === "string" && [...r.path].length <= 512 && (r.path === "."
    || (!/(?:^|\/)\.{1,2}(?:\/|$)/.test(r.path)
      && /^(?![A-Za-z]:)[^/\\\u0000-\u001f\u007f-\u009f]+(?:\/[^/\\\u0000-\u001f\u007f-\u009f]+)*$/.test(r.path))), "invalid_resource_path");
}
export function delegationAuthorityV2(value: unknown): asserts value is DelegationAuthorityV2 {
  const r = delegationRecordV2(value, ["allowed_tools", "allowed_effects", "readable_resources", "mutable_resources", "posture", "approval", "escalation"]);
  delegationListV2(r.allowed_tools, delegationIdV2); delegationListV2(r.allowed_effects, delegationIdV2);
  delegationListV2(r.readable_resources, resource); delegationListV2(r.mutable_resources, resource);
  requireDelegationV2(r.posture === "report-only" || r.posture === "writer", "invalid_posture");
  requireDelegationV2(r.approval === "automatic" || r.approval === "requires_approval", "invalid_approval");
  requireDelegationV2(r.escalation === "deny" || r.escalation === "request", "invalid_escalation");
  requireDelegationV2(r.posture !== "report-only" || r.mutable_resources.length === 0, "report_only_mutable_resources");
}
export function delegationSubsetV2(child: readonly unknown[], parent: readonly unknown[]): boolean {
  const allowed = new Set(parent.map(item => canonicalJson(item)));
  return child.every(item => allowed.has(canonicalJson(item)));
}
export function assertAuthorityNarrowingV2(child: DelegationAuthorityV2, parent: DelegationAuthorityV2): void {
  for (const key of ["allowed_tools", "allowed_effects", "readable_resources", "mutable_resources"] as const) {
    requireDelegationV2(delegationSubsetV2(child[key], parent[key]), `authority_widening:${key}`);
  }
  requireDelegationV2(parent.posture !== "report-only" || child.posture === "report-only", "authority_widening:posture");
  requireDelegationV2(parent.approval !== "requires_approval" || child.approval === "requires_approval", "authority_widening:approval");
  requireDelegationV2(parent.escalation !== "deny" || child.escalation === "deny", "authority_widening:escalation");
}
export function delegationBudgetV2(value: unknown): asserts value is DelegationBudgetV2 {
  const r = delegationRecordV2(value, ["remaining_depth", "max_total_children", "max_total_envelopes", "max_concurrent_children", "max_runtime_ms", "max_input_tokens", "max_output_tokens", "max_cost_micros", "max_attempts", "expires_at"]);
  for (const key of ["max_runtime_ms", "max_input_tokens", "max_output_tokens", "max_cost_micros", "max_attempts"]) delegationIntegerV2(r[key]);
  delegationIntegerV2(r.remaining_depth, 32); delegationIntegerV2(r.max_total_children, 64);
  delegationIntegerV2(r.max_concurrent_children, 64); delegationIntegerV2(r.max_total_envelopes, 4096);
  requireDelegationV2(r.max_total_envelopes >= 1 && r.max_concurrent_children <= r.max_total_children, "invalid_budget_limits");
  delegationTimestampV2(r.expires_at);
}
export function assertBudgetNarrowingV2(child: DelegationBudgetV2, parent: DelegationBudgetV2, consume: boolean): void {
  for (const key of ["remaining_depth", "max_total_children", "max_total_envelopes", "max_concurrent_children", "max_runtime_ms", "max_input_tokens", "max_output_tokens", "max_cost_micros", "max_attempts"] as const) {
    const consumed = consume && (key === "remaining_depth" || key === "max_total_envelopes") ? 1 : 0;
    requireDelegationV2(child[key] <= parent[key] - consumed, `budget_widening:${key}`);
  }
  requireDelegationV2(!consume || (parent.max_total_children > 0 && parent.max_concurrent_children > 0), "parent_cannot_delegate");
  requireDelegationV2(child.expires_at <= parent.expires_at, "budget_widening:expires_at");
}
function fingerprint(value: unknown): void {
  requireDelegationV2(value === null || (typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value)), "invalid_dirty_fingerprint");
}
export function delegationExecutionBindingV2(value: unknown): asserts value is DelegationExecutionBindingV2 {
  const r = delegationRecordV2(value, ["runtime", "source", "flow_binding"]);
  const runtime = delegationRecordV2(r.runtime, ["runtime_receipt_ref", "model_receipt_ref", "required_capabilities"]);
  delegationReferenceV2(runtime.runtime_receipt_ref); delegationReferenceV2(runtime.model_receipt_ref);
  delegationListV2(runtime.required_capabilities, delegationIdV2);
  const source = delegationRecordV2(r.source, ["repository_id", "source_state_id", "dirty_state_fingerprint", "execution_worktree_id", "source_admission_receipt"]);
  delegationIdV2(source.repository_id); delegationIdV2(source.source_state_id); fingerprint(source.dirty_state_fingerprint);
  delegationIdV2(source.execution_worktree_id); delegationReferenceV2(source.source_admission_receipt);
  const flow = r.flow_binding as Record<string, unknown> | null;
  if (flow?.status === "unbound") {
    delegationRecordV2(flow, ["status", "reason"]);
    requireDelegationV2(typeof flow.reason === "string" && flow.reason.length > 0 && [...flow.reason].length <= 512
      && !/[\u0000-\u001f\u007f]/.test(flow.reason), "invalid_unbound_reason");
  } else {
    const f = delegationRecordV2(flow, ["status", "flow_run_id", "definition", "flow_step_id", "gate_attempt"]);
    requireDelegationV2(f.status === "bound", "invalid_flow_binding");
    delegationIdV2(f.flow_run_id); delegationIdV2(f.flow_step_id); delegationIntegerV2(f.gate_attempt);
    delegationFlowDefinitionIdentityV2(f.definition);
  }
}
export function delegationFlowDefinitionIdentityV2(value: unknown): asserts value is PublishedFlowDefinitionIdentity {
  const definition = delegationRecordV2(value, ["id", "version", "digest"]);
  // Flow identity references are bounded text, not delegation identifiers. Preserve their bytes.
  for (const value of [definition.id, definition.version]) {
    requireDelegationV2(typeof value === "string" && value.length > 0 && [...value].length <= 128
      && !/[\u0000-\u001f\u007f-\u009f]/u.test(value), "invalid_flow_definition_text");
  }
  // Flow's published definitionIdentity uses an unprefixed SHA-256 digest.
  requireDelegationV2(typeof definition.digest === "string" && /^[a-f0-9]{64}$/.test(definition.digest), "invalid_flow_definition_digest");
}
function grant(value: unknown): asserts value is DelegationExecutionGrantV2 {
  const r = delegationRecordV2(value, ["grant_id", "runtime", "source", "flow_binding", "authority_ceiling"]);
  delegationIdV2(r.grant_id);
  delegationExecutionBindingV2({ runtime: r.runtime, source: r.source, flow_binding: r.flow_binding });
  delegationAuthorityV2(r.authority_ceiling);
}

/**
 * Validate/copy host-supplied claims. Parsing never authenticates an issuer, principal,
 * receipt, revision, or epoch. The host must check current revocation and retain the
 * immutable root digest before admitting effects. Opaque tool/effect names require
 * host-owned semantics and enforcement; report-only has no mutable resources here.
 */
export function validateRootAuthorityV2(value: unknown): RootAuthorityV2 {
  const r = delegationRecordV2(copyDelegationJsonV2(value), ["schema_version", "authority_id", "authority_epoch", "issuer_host_id", "authenticated_principal_ref", "authenticated_subject_ref", "source_origin", "execution_worktree_ids", "execution_grants", "delegation_ceiling", "budget", "revisions", "root_trace", "root_cancellation_ref"]);
  requireDelegationV2(r.schema_version === "2.0", "unsupported_authority_schema");
  delegationIdV2(r.authority_id); delegationIntegerV2(r.authority_epoch); delegationIdV2(r.issuer_host_id);
  delegationReferenceV2(r.authenticated_principal_ref); delegationReferenceV2(r.authenticated_subject_ref);
  const source = delegationRecordV2(r.source_origin, ["repository_id", "worktree_id", "source_state_id", "dirty_state_fingerprint"]);
  delegationIdV2(source.repository_id); delegationIdV2(source.worktree_id); delegationIdV2(source.source_state_id); fingerprint(source.dirty_state_fingerprint);
  delegationListV2(r.execution_worktree_ids, delegationIdV2);
  requireDelegationV2(r.execution_worktree_ids.includes(source.worktree_id), "uncatalogued_origin_worktree");
  delegationListV2(r.execution_grants, grant, DELEGATION_V2_MAX_GRANTS);
  requireDelegationV2(r.execution_grants.length > 0 && new Set(r.execution_grants.map(g => g.grant_id)).size === r.execution_grants.length, "invalid_grant_ids");
  delegationAuthorityV2(r.delegation_ceiling); delegationBudgetV2(r.budget);
  for (const item of [...r.delegation_ceiling.readable_resources, ...r.delegation_ceiling.mutable_resources]) {
    requireDelegationV2(item.repository_id === source.repository_id && r.execution_worktree_ids.includes(item.execution_worktree_id), "uncatalogued_root_resource");
  }
  for (const g of r.execution_grants) {
    requireDelegationV2(g.source.repository_id === source.repository_id && g.source.source_state_id === source.source_state_id
      && g.source.dirty_state_fingerprint === source.dirty_state_fingerprint, "grant_source_origin_mismatch");
    requireDelegationV2(r.execution_worktree_ids.includes(g.source.execution_worktree_id), "uncatalogued_execution_worktree");
    assertAuthorityNarrowingV2(g.authority_ceiling, r.delegation_ceiling);
    for (const item of [...g.authority_ceiling.readable_resources, ...g.authority_ceiling.mutable_resources]) {
      requireDelegationV2(item.repository_id === g.source.repository_id && item.execution_worktree_id === g.source.execution_worktree_id, "grant_resource_worktree_mismatch");
    }
  }
  const revisions = delegationRecordV2(r.revisions, ["policy", "prompt", "rubric"]);
  Object.values(revisions).forEach(delegationReferenceV2);
  const trace = delegationRecordV2(r.root_trace, ["trace_id", "span_id"]);
  delegationIdV2(trace.trace_id); delegationIdV2(trace.span_id); delegationReferenceV2(r.root_cancellation_ref);
  return r as RootAuthorityV2;
}
export function serializeRootAuthorityV2(value: unknown): string { return canonicalJson(validateRootAuthorityV2(value)); }
export function rootAuthorityDigestV2(value: unknown): string {
  return `sha256:${createHash("sha256").update(`${DELEGATION_AUTHORITY_DIGEST_DOMAIN}\0`).update(serializeRootAuthorityV2(value)).digest("hex")}`;
}
