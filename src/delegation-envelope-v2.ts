import { createHash } from "node:crypto";
import { canonicalJson } from "@kontourai/relay";
import {
  assertAuthorityNarrowingV2, assertBudgetNarrowingV2, copyDelegationJsonV2,
  delegationAuthorityV2, delegationBudgetV2, delegationDigestV2, delegationExecutionBindingV2,
  delegationIdV2, delegationIntegerV2, delegationListV2, delegationRecordV2, delegationReferenceV2,
  delegationSubsetV2, delegationTimestampV2, requireDelegationV2, rootAuthorityDigestV2,
  validateRootAuthorityV2,
  type DelegationAuthorityV2, type DelegationBudgetV2, type DelegationExecutionBindingV2,
  type DelegationReferenceV2, type RootAuthorityV2,
} from "./delegation-authority-contract.js";

export const DELEGATION_ENVELOPE_V2_SCHEMA_VERSION = "2.0" as const;
export const DELEGATION_ENVELOPE_V2_DIGEST_DOMAIN = "flow-agents/delegation-envelope/2.0";
export type RootAuthorityReferenceV2 = { id: string; digest: string; authority_epoch: number };
export type DelegationParentReferenceV2 = { schema_version: "2.0"; id: string; generation: number; digest: string };
export type DelegationEnvelopeV2 = {
  schema_version: typeof DELEGATION_ENVELOPE_V2_SCHEMA_VERSION;
  envelope_id: string;
  generation: number;
  parent: DelegationParentReferenceV2 | null;
  root_authority_ref: RootAuthorityReferenceV2;
  execution_id: string;
  /** Authorization principal, not an observed engine/session/turn identity. */
  actor: DelegationReferenceV2;
  assignment_subject: DelegationReferenceV2;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  selected_grant_id: string;
  /** May be empty at a leaf; selection for each child must come from its parent's list. */
  remaining_allowed_grant_ids: string[];
  /** Must equal the entire selected catalogue tuple, irrespective of JSON key order. */
  execution_binding: DelegationExecutionBindingV2;
  delegation_ceiling: DelegationAuthorityV2;
  execution_authority: DelegationAuthorityV2;
  budget: DelegationBudgetV2;
  continuation_ref: DelegationReferenceV2;
  cancellation_ref: DelegationReferenceV2;
};

/** Structural validation only. This cannot authenticate any authority or receipt. */
export function validateDelegationEnvelopeV2(value: unknown): DelegationEnvelopeV2 {
  const r = delegationRecordV2(copyDelegationJsonV2(value), ["schema_version", "envelope_id", "generation", "parent", "root_authority_ref", "execution_id", "actor", "assignment_subject", "trace_id", "span_id", "parent_span_id", "selected_grant_id", "remaining_allowed_grant_ids", "execution_binding", "delegation_ceiling", "execution_authority", "budget", "continuation_ref", "cancellation_ref"]);
  requireDelegationV2(r.schema_version === "2.0", "unsupported_envelope_schema");
  delegationIdV2(r.envelope_id); delegationIntegerV2(r.generation, 32); delegationIdV2(r.execution_id);
  delegationReferenceV2(r.actor); delegationReferenceV2(r.assignment_subject);
  delegationIdV2(r.trace_id); delegationIdV2(r.span_id);
  if (r.parent === null) {
    requireDelegationV2(r.generation === 0 && r.parent_span_id === null, "invalid_root_lineage");
  } else {
    const parent = delegationRecordV2(r.parent, ["schema_version", "id", "generation", "digest"]);
    requireDelegationV2(parent.schema_version === "2.0", "unsupported_parent_schema");
    delegationIdV2(parent.id); delegationIntegerV2(parent.generation, 31); delegationDigestV2(parent.digest);
    delegationIdV2(r.parent_span_id);
    requireDelegationV2(r.generation === parent.generation + 1 && r.envelope_id !== parent.id && r.span_id !== r.parent_span_id, "invalid_parent_lineage");
  }
  const root = delegationRecordV2(r.root_authority_ref, ["id", "digest", "authority_epoch"]);
  delegationIdV2(root.id); delegationDigestV2(root.digest); delegationIntegerV2(root.authority_epoch);
  delegationIdV2(r.selected_grant_id); delegationListV2(r.remaining_allowed_grant_ids, delegationIdV2);
  delegationExecutionBindingV2(r.execution_binding);
  delegationAuthorityV2(r.delegation_ceiling); delegationAuthorityV2(r.execution_authority);
  assertAuthorityNarrowingV2(r.execution_authority, r.delegation_ceiling);
  delegationBudgetV2(r.budget);
  requireDelegationV2(r.generation + r.budget.remaining_depth <= 32, "depth_limit");
  delegationReferenceV2(r.continuation_ref); delegationReferenceV2(r.cancellation_ref);
  return r as DelegationEnvelopeV2;
}
export function serializeDelegationEnvelopeV2(value: unknown): string { return canonicalJson(validateDelegationEnvelopeV2(value)); }
export function delegationEnvelopeDigestV2(value: unknown): string {
  return `sha256:${createHash("sha256").update(`${DELEGATION_ENVELOPE_V2_DIGEST_DOMAIN}\0`).update(serializeDelegationEnvelopeV2(value)).digest("hex")}`;
}
export function rootAuthorityReferenceV2(value: unknown): RootAuthorityReferenceV2 {
  const root = validateRootAuthorityV2(value);
  return { id: root.authority_id, digest: rootAuthorityDigestV2(root), authority_epoch: root.authority_epoch };
}
export function delegationParentReferenceV2(value: unknown): DelegationParentReferenceV2 {
  const envelope = validateDelegationEnvelopeV2(value);
  return { schema_version: "2.0", id: envelope.envelope_id, generation: envelope.generation, digest: delegationEnvelopeDigestV2(envelope) };
}
function equal(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }
function assertBoundToRoot(root: RootAuthorityV2, envelope: DelegationEnvelopeV2, rootRef: RootAuthorityReferenceV2): void {
  requireDelegationV2(equal(envelope.root_authority_ref, rootRef), "root_authority_reference_mismatch");
  requireDelegationV2(equal(envelope.actor, root.authenticated_principal_ref), "principal_reference_mismatch");
  requireDelegationV2(equal(envelope.assignment_subject, root.authenticated_subject_ref), "subject_reference_mismatch");
  requireDelegationV2(envelope.trace_id === root.root_trace.trace_id, "root_trace_mismatch");
  requireDelegationV2(equal(envelope.cancellation_ref, root.root_cancellation_ref), "root_cancellation_mismatch");
  const grant = root.execution_grants.find(grant => grant.grant_id === envelope.selected_grant_id);
  requireDelegationV2(grant, "unknown_execution_grant");
  requireDelegationV2(equal(envelope.execution_binding, { runtime: grant.runtime, source: grant.source, flow_binding: grant.flow_binding }), "execution_grant_binding_mismatch");
  requireDelegationV2(delegationSubsetV2(envelope.remaining_allowed_grant_ids, root.execution_grants.map(grant => grant.grant_id)), "unknown_remaining_grant");
  assertAuthorityNarrowingV2(envelope.delegation_ceiling, root.delegation_ceiling);
  assertAuthorityNarrowingV2(envelope.execution_authority, grant.authority_ceiling);
  assertBudgetNarrowingV2(envelope.budget, root.budget, false);
  requireDelegationV2(envelope.generation <= root.budget.remaining_depth
    && envelope.budget.remaining_depth <= root.budget.remaining_depth - envelope.generation, "root_depth_limit");
  requireDelegationV2(envelope.budget.max_total_envelopes <= root.budget.max_total_envelopes - envelope.generation, "root_envelope_limit");
  if (envelope.parent === null) {
    requireDelegationV2(envelope.span_id === root.root_trace.span_id, "root_span_mismatch");
  } else {
    requireDelegationV2(envelope.span_id !== root.root_trace.span_id, "repeated_root_span");
  }
}

/**
 * Pure edge admission: pass null parent for a root envelope. Validates the actual
 * root and parent digests, including epoch, never authenticates them. A non-root
 * parent is not proof of its missing ancestors; use validateDelegationAncestryV2.
 * A coordinator's execution_authority can be report-only while its distinct
 * delegation_ceiling permits a child writer. Each execution must also narrow
 * its own selected grant. No tool, worker, filesystem, model, or Flow effect runs.
 */
export function narrowDelegationEnvelopeV2(rootValue: unknown, parentValue: unknown, childValue: unknown, observedAt: unknown): DelegationEnvelopeV2 {
  const root = validateRootAuthorityV2(rootValue);
  const child = validateDelegationEnvelopeV2(childValue);
  const parent = parentValue === null ? null : validateDelegationEnvelopeV2(parentValue);
  delegationTimestampV2(observedAt);
  requireDelegationV2(observedAt < root.budget.expires_at, "root_authority_expired");
  const rootRef = rootAuthorityReferenceV2(root);
  for (const envelope of parent ? [parent, child] : [child]) {
    requireDelegationV2(observedAt < envelope.budget.expires_at, "envelope_expired");
    assertBoundToRoot(root, envelope, rootRef);
  }
  if (parent === null) {
    requireDelegationV2(child.parent === null, "missing_parent");
  } else {
    requireDelegationV2(equal(child.parent, delegationParentReferenceV2(parent)), "parent_reference_mismatch");
    requireDelegationV2(child.generation === parent.generation + 1, "generation_mismatch");
    requireDelegationV2(child.envelope_id !== parent.envelope_id && child.span_id !== parent.span_id
      && child.execution_id !== parent.execution_id, "repeated_lineage_identity");
    requireDelegationV2(child.parent_span_id === parent.span_id, "parent_span_mismatch");
    requireDelegationV2(child.trace_id === parent.trace_id, "parent_trace_mismatch");
    requireDelegationV2(equal(child.continuation_ref, parent.continuation_ref), "continuation_reference_mismatch");
    requireDelegationV2(parent.remaining_allowed_grant_ids.includes(child.selected_grant_id), "selected_grant_not_allowed");
    requireDelegationV2(delegationSubsetV2(child.remaining_allowed_grant_ids, parent.remaining_allowed_grant_ids), "remaining_grant_widening");
    assertAuthorityNarrowingV2(child.delegation_ceiling, parent.delegation_ceiling);
    assertBudgetNarrowingV2(child.budget, parent.budget, true);
  }
  return child;
}

/**
 * Ordered root-envelope -> leaf chain, inclusive; absent ancestors and reused
 * envelope/span/execution IDs are refused within this chain (at most 33 entries).
 * Durable host services must enforce global uniqueness, aggregate lifetime fanout,
 * reservations/accounting, authenticated issuance, current epoch/revocation and an
 * effect-time fence. These pure functions prove none of those host guarantees.
 * Actual child session/turn/model/terminal observations belong in separate append-only
 * records; never derive them from a configured model, cwd, clock, or newest session.
 */
export function validateDelegationAncestryV2(rootValue: unknown, chainValue: unknown, observedAt: unknown): DelegationEnvelopeV2[] {
  requireDelegationV2(Array.isArray(chainValue) && chainValue.length > 0 && chainValue.length <= 33
    && Object.getPrototypeOf(chainValue) === Array.prototype && Reflect.ownKeys(chainValue).length === chainValue.length + 1, "invalid_ancestry_bound");
  const chain: DelegationEnvelopeV2[] = [];
  const ids = new Set<string>(), spans = new Set<string>(), executions = new Set<string>();
  for (let i = 0; i < chainValue.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(chainValue, String(i));
    requireDelegationV2(descriptor && "value" in descriptor && descriptor.enumerable, "invalid_ancestry_array");
    const envelope = narrowDelegationEnvelopeV2(rootValue, chain.at(-1) ?? null, descriptor.value, observedAt);
    requireDelegationV2(!ids.has(envelope.envelope_id) && !spans.has(envelope.span_id)
      && !executions.has(envelope.execution_id), "repeated_ancestry_identity");
    ids.add(envelope.envelope_id); spans.add(envelope.span_id); executions.add(envelope.execution_id);
    chain.push(envelope);
  }
  return chain;
}
