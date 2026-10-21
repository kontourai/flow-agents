import { createHash } from "node:crypto";
import { canonicalJson, type ModelInvocationRequest } from "@kontourai/relay";
import type { AuthorizationLedger } from "@kontourai/dispatch";
import { definitionIdentity, loadRun, type FlowStepClaimActor } from "@kontourai/flow";
import {
  copyDelegationJsonV2, delegationDigestV2, delegationIdV2, delegationIntegerV2, delegationFlowDefinitionIdentityV2,
  delegationRecordV2, delegationReferenceV2, requireDelegationV2, type DelegationReferenceV2,
} from "./delegation-authority-contract.js";
import {
  delegationEnvelopeDigestV2, rootAuthorityReferenceV2,
  type DelegationEnvelopeV2, type RootAuthorityReferenceV2,
} from "./delegation-envelope-v2.js";
import { createDelegationAuthorityService, type DelegationInvocationAmounts, type DelegationInvocation } from "./delegation-authority-service.js";
import { executeAuthorizedDelegation } from "./delegation-execution.js";
import { orchestrateDelegationFlow, type DelegationFlowExecutionHost } from "./delegation-flow-execution.js";
import type { DelegationDispatchOutcome } from "./delegation-dispatch.js";

export type GroupControllerV2 = { id: string; generation: number };
export type DelegationGroupSeatV2 = {
  seatId: string;
  envelope: { id: string; generation: number; digest: string };
  stepId: string | null;
  effect: string;
  allocation: DelegationInvocationAmounts;
};
export type DelegationGroupSpecV2 = {
  schemaVersion: "2.0";
  groupId: string;
  rootAuthorityRef: RootAuthorityReferenceV2;
  controller: GroupControllerV2;
  policy: { reference: DelegationReferenceV2; maxConcurrent: number };
  topology: { kind: "independent-advisory" } | {
    kind: "flow"; runId: string; definition: ReturnType<typeof definitionIdentity>; actor: FlowStepClaimActor;
  };
  seats: DelegationGroupSeatV2[];
};
export type GroupCommandV2 = {
  groupId: string; operationKey: string; expectedRevision: number; controller: GroupControllerV2;
} & ({ kind: "create"; spec: DelegationGroupSpecV2 } | { kind: "run" } | { kind: "cancel" }
  | { kind: "terminal"; seatId: string; invocationId: string; observation: GroupMemberObservationV2 }
  | { kind: "not_launched"; seatId: string });
export type GroupMemberObservationV2 = {
  outcome: DelegationDispatchOutcome["outcome"];
  outcomeRef: DelegationReferenceV2;
  dissentRefs: DelegationReferenceV2[];
  uncertaintyRefs: DelegationReferenceV2[];
};
type GroupEventBodyV2 =
  | { kind: "created" | "run_pending" | "cancel_pending" | "terminal_recorded" | "terminal_unlaunched"; command: GroupCommandV2; authorization: DelegationReferenceV2 }
  | { kind: "member_pending"; operationKey: string; seatId: string; claimId: string | null }
  | { kind: "member_invoking"; operationKey: string; seatId: string; invocationId: string }
  | { kind: "member_observed"; operationKey: string; seatId: string; observation: GroupMemberObservationV2 }
  | { kind: "run_returned"; operationKey: string; status: "returned" | "execution_unknown"; reference: DelegationReferenceV2 }
  | { kind: "cancel_requested"; operationKey: string; reference: DelegationReferenceV2 };
export type GroupEventV2 = { revision: number } & GroupEventBodyV2;
export type DelegationGroupJournalV2 = { schemaVersion: "2.0"; groupId: string; events: GroupEventV2[] };
export type DelegationGroupProjectionV2 = {
  spec: DelegationGroupSpecV2;
  revision: number;
  execution: "idle" | "execution_unknown" | "returned";
  cancellation: "none" | "pending" | "requested";
  acceptance: "unassessed";
  /** Neither a returned scheduler nor cancellation acknowledgement proves descendant termination. */
  terminal: "unproven" | "proven";
  members: { seatId: string; claimId: string | null; invocationId: string | null; terminalReference: DelegationReferenceV2 | null; observation: GroupMemberObservationV2 | null }[];
};
export interface DelegationGroupStoreV2 {
  /** Serializes all reads/updates; commit and durability repair precede return. */
  transact<T>(groupId: string, body: (journal: DelegationGroupJournalV2 | null) => Promise<{
    journal: DelegationGroupJournalV2; result: T;
  }>): Promise<T>;
  scan<T>(body: (journals: DelegationGroupJournalV2[]) => Promise<T>): Promise<T>;
}
export interface DelegationGroupHostV2 {
  /** Authenticate the actual caller, immutable membership and exclusive root custody across stores, including replay. */
  authorize(input: {
    action: "create" | "run" | "cancel" | "terminal" | "not_launched" | "get" | "list" | "events" | "replay" | "execute" | "record";
    groupId: string | null; spec: DelegationGroupSpecV2 | null; current: DelegationGroupProjectionV2 | null; command: GroupCommandV2 | null;
  }): Promise<DelegationReferenceV2 | null>;
  /** Its invokeFenced must enforce this group's current custody/cancellation across the actual launch. */
  executionHost(spec: DelegationGroupSpecV2): DelegationFlowExecutionHost;
  prepareIndependentRequest?(spec: DelegationGroupSpecV2, seat: DelegationGroupSeatV2, envelope: DelegationEnvelopeV2): Promise<ModelInvocationRequest>;
  retainMemberOutcome(spec: DelegationGroupSpecV2, seat: DelegationGroupSeatV2, outcome: DelegationDispatchOutcome): Promise<Omit<GroupMemberObservationV2, "outcome">>;
  retainRunObservation(spec: DelegationGroupSpecV2, observation: unknown): Promise<DelegationReferenceV2>;
  retainRunFailure(spec: DelegationGroupSpecV2, error: unknown): Promise<DelegationReferenceV2>;
  /** Confirms this exact revoked seat never launched; absence of a ledger entry alone is insufficient. */
  confirmNotLaunched?(spec: DelegationGroupSpecV2, seat: DelegationGroupSeatV2): Promise<DelegationReferenceV2 | null>;
  /** Authenticates physical termination of this exact invocation and its descendants, not a model's claim. */
  confirmTerminal?(spec: DelegationGroupSpecV2, seat: DelegationGroupSeatV2, invocation: DelegationInvocation, observation: GroupMemberObservationV2): Promise<DelegationReferenceV2 | null>;
  /** Request cancellation of these seats and descendants; acknowledgement is not terminal proof. */
  confirmDescendantCancellation?(spec: DelegationGroupSpecV2, command: GroupCommandV2): Promise<DelegationReferenceV2 | null>;
  requestDescendantCancellation(spec: DelegationGroupSpecV2): Promise<DelegationReferenceV2>;
}
export const GROUP_V2_MAX_EVENTS = 512;
export const GROUP_V2_MAX_BYTES = 32 * 1024 * 1024;
const MAX_RECORD_BYTES = 32 * 1024;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function controller(value: unknown): asserts value is GroupControllerV2 {
  const r = delegationRecordV2(value, ["id", "generation"]);
  delegationIdV2(r.id); delegationIntegerV2(r.generation);
}
function amounts(value: unknown): void {
  const r = delegationRecordV2(value, ["inputTokens", "outputTokens", "costMicros"]);
  Object.values(r).forEach(v => delegationIntegerV2(v));
}
export function validateDelegationGroupSpecV2(value: unknown): DelegationGroupSpecV2 {
  const r = delegationRecordV2(copyDelegationJsonV2(value), ["schemaVersion", "groupId", "rootAuthorityRef", "controller", "policy", "topology", "seats"]);
  requireDelegationV2(r.schemaVersion === "2.0", "unsupported_group_schema");
  delegationIdV2(r.groupId); controller(r.controller);
  const root = delegationRecordV2(r.rootAuthorityRef, ["id", "digest", "authority_epoch"]);
  delegationIdV2(root.id); delegationDigestV2(root.digest); delegationIntegerV2(root.authority_epoch);
  const policy = delegationRecordV2(r.policy, ["reference", "maxConcurrent"]);
  delegationReferenceV2(policy.reference); delegationIntegerV2(policy.maxConcurrent, 64);
  requireDelegationV2((policy.maxConcurrent as number) > 0, "invalid_group_concurrency");
  requireDelegationV2(Array.isArray(r.seats) && r.seats.length > 0 && r.seats.length <= 64, "invalid_group_seats");
  for (const seat of r.seats) {
    const s = delegationRecordV2(seat, ["seatId", "envelope", "stepId", "effect", "allocation"]);
    delegationIdV2(s.seatId); delegationIdV2(s.effect); amounts(s.allocation);
    const e = delegationRecordV2(s.envelope, ["id", "generation", "digest"]);
    delegationIdV2(e.id); delegationIntegerV2(e.generation, 32); delegationDigestV2(e.digest);
    if (s.stepId !== null) delegationIdV2(s.stepId);
  }
  const seats = r.seats as DelegationGroupSeatV2[];
  requireDelegationV2(new Set(seats.map(s => s.seatId)).size === seats.length
    && new Set(seats.map(s => s.envelope.id)).size === seats.length, "duplicate_group_seat");
  const topology = r.topology as DelegationGroupSpecV2["topology"];
  if (topology.kind === "independent-advisory") {
    delegationRecordV2(topology, ["kind"]);
    requireDelegationV2(seats.every(s => s.stepId === null), "unexpected_group_step");
  } else {
    delegationRecordV2(topology, ["kind", "runId", "definition", "actor"]);
    requireDelegationV2(topology.kind === "flow", "unsupported_group_topology");
    delegationIdV2(topology.runId);
    delegationFlowDefinitionIdentityV2(topology.definition);
    const a = delegationRecordV2(topology.actor, ["key", ...(topology.actor.kind !== undefined ? ["kind"] : [])]);
    delegationIdV2(a.key); if (a.kind !== undefined) delegationIdV2(a.kind);
    requireDelegationV2(seats.every(s => s.stepId !== null) && new Set(seats.map(s => s.stepId)).size === seats.length, "invalid_group_steps");
  }
  return r as DelegationGroupSpecV2;
}
function command(value: unknown): GroupCommandV2 {
  const copy = copyDelegationJsonV2(value);
  const kind = (copy as { kind?: unknown })?.kind;
  const r = delegationRecordV2(copy, ["kind", "groupId", "operationKey", "expectedRevision", "controller", ...(kind === "create" ? ["spec"] : kind === "terminal" ? ["seatId", "invocationId", "observation"] : kind === "not_launched" ? ["seatId"] : [])]);
  requireDelegationV2(kind === "create" || kind === "run" || kind === "cancel" || kind === "terminal" || kind === "not_launched", "invalid_group_command");
  delegationIdV2(r.groupId); delegationIdV2(r.operationKey); delegationIntegerV2(r.expectedRevision, GROUP_V2_MAX_EVENTS); controller(r.controller);
  if (kind === "create") {
    const spec = validateDelegationGroupSpecV2(r.spec);
    requireDelegationV2(spec.groupId === r.groupId && same(spec.controller, r.controller), "group_identity_mismatch");
    r.spec = spec;
  }
  if (kind === "not_launched") delegationIdV2(r.seatId);
  if (kind === "terminal") { delegationIdV2(r.seatId); delegationIdV2(r.invocationId); observation(r.observation); }
  return r as GroupCommandV2;
}
function observation(value: unknown): asserts value is GroupMemberObservationV2 {
  const r = delegationRecordV2(value, ["outcome", "outcomeRef", "dissentRefs", "uncertaintyRefs"]);
  requireDelegationV2(["succeeded", "exhausted", "budget-exceeded", "aborted", "no-eligible-candidates"].includes(r.outcome as string), "invalid_member_outcome");
  delegationReferenceV2(r.outcomeRef);
  for (const refs of [r.dissentRefs, r.uncertaintyRefs]) {
    requireDelegationV2(Array.isArray(refs) && refs.length <= 4, "invalid_member_references");
    refs.forEach(delegationReferenceV2);
  }
}
function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Replay validates every transition; cached projections and caller claims carry no authority. */
export function projectDelegationGroupV2(journal: DelegationGroupJournalV2): DelegationGroupProjectionV2 {
  delegationRecordV2(journal, ["schemaVersion", "groupId", "events"]);
  requireDelegationV2(journal.schemaVersion === "2.0" && Array.isArray(journal.events)
    && journal.events.length > 0 && journal.events.length <= GROUP_V2_MAX_EVENTS, "invalid_group_journal");
  delegationIdV2(journal.groupId);
  let result: DelegationGroupProjectionV2 | undefined;
  let runKey: string | undefined, cancelKey: string | undefined, returned = false, cancellationReturned = false;
  const operations = new Set<string>();
  for (const [index, raw] of journal.events.entries()) {
    const e = copyDelegationJsonV2(raw) as GroupEventV2;
    requireDelegationV2(e.revision === index + 1, "group_revision_mismatch");
    if ("command" in e) {
      requireDelegationV2(["created", "run_pending", "cancel_pending", "terminal_recorded", "terminal_unlaunched"].includes(e.kind), "invalid_group_event");
      delegationRecordV2(e, ["revision", "kind", "command", "authorization"]);
      const c = command(e.command);
      delegationReferenceV2(e.authorization);
      requireDelegationV2(c.groupId === journal.groupId && c.expectedRevision === index
        && !operations.has(c.operationKey), "invalid_group_operation");
      operations.add(c.operationKey);
      if (e.kind === "created") {
        requireDelegationV2(!result && c.kind === "create", "invalid_group_creation");
        result = { spec: c.spec, revision: 1, execution: "idle", cancellation: "none", acceptance: "unassessed", terminal: "unproven", members: [] };
      } else {
        requireDelegationV2(result && same(c.controller, result.spec.controller), "controller_fence_conflict");
        if (e.kind === "terminal_unlaunched") {
          requireDelegationV2(c.kind === "not_launched" && result.cancellation !== "none"
            && result.spec.seats.some(s => s.seatId === c.seatId), "unlaunched_member_mismatch");
          const member = result.members.find(m => m.seatId === c.seatId);
          requireDelegationV2(!member?.invocationId && !member?.terminalReference, "unlaunched_member_mismatch");
          if (member) member.terminalReference = e.authorization;
          else result.members.push({ seatId: c.seatId, claimId: null, invocationId: null, terminalReference: e.authorization, observation: null });
        } else if (e.kind === "terminal_recorded") {
          requireDelegationV2(c.kind === "terminal", "terminal_command_required");
          const member = result.members.find(m => m.seatId === c.seatId);
          requireDelegationV2(member && member.invocationId === c.invocationId && !member.terminalReference
            && (!member.observation || same(member.observation, c.observation)), "terminal_member_mismatch");
          member.observation = c.observation; member.terminalReference = e.authorization;
        } else if (e.kind === "run_pending") {
          requireDelegationV2(c.kind === "run" && !runKey && !cancelKey, "group_run_already_admitted");
          runKey = c.operationKey; result.execution = "execution_unknown";
        } else {
          requireDelegationV2(c.kind === "cancel" && !cancelKey, "group_cancel_already_requested");
          cancelKey = c.operationKey; result.cancellation = "pending";
        }
      }
    } else {
      requireDelegationV2(result, "group_missing");
      delegationIdV2(e.operationKey);
      if (e.kind === "member_pending") {
        delegationRecordV2(e, ["revision", "kind", "operationKey", "seatId", "claimId"]);
        requireDelegationV2(e.operationKey === runKey && !cancelKey && !returned
          && result.spec.seats.some(s => s.seatId === e.seatId) && !result.members.some(m => m.seatId === e.seatId), "member_admission_refused");
        if (e.claimId !== null) delegationIdV2(e.claimId);
        requireDelegationV2((result.spec.topology.kind === "flow") === (e.claimId !== null), "member_claim_mismatch");
        result.members.push({ seatId: e.seatId, claimId: e.claimId, invocationId: null, terminalReference: null, observation: null });
      } else if (e.kind === "member_invoking") {
        delegationRecordV2(e, ["revision", "kind", "operationKey", "seatId", "invocationId"]);
        const member = result.members.find(m => m.seatId === e.seatId);
        requireDelegationV2(e.operationKey === runKey && member && !member.invocationId && !cancelKey && !returned
          && !result.members.some(m => m.invocationId === e.invocationId), "member_invocation_refused");
        delegationIdV2(e.invocationId); member.invocationId = e.invocationId;
      } else if (e.kind === "member_observed") {
        delegationRecordV2(e, ["revision", "kind", "operationKey", "seatId", "observation"]);
        const member = result.members.find(m => m.seatId === e.seatId);
        requireDelegationV2(e.operationKey === runKey && member && member.invocationId && !member.observation && !returned, "member_observation_refused");
        observation(e.observation); member.observation = e.observation;
      } else if (e.kind === "run_returned") {
        delegationRecordV2(e, ["revision", "kind", "operationKey", "status", "reference"]);
        requireDelegationV2(e.operationKey === runKey && !returned && ["returned", "execution_unknown"].includes(e.status), "run_observation_refused");
        delegationReferenceV2(e.reference); returned = true; result.execution = e.status;
      } else {
        delegationRecordV2(e, ["revision", "kind", "operationKey", "reference"]);
        requireDelegationV2(e.kind === "cancel_requested" && e.operationKey === cancelKey && !cancellationReturned, "cancellation_observation_refused");
        delegationReferenceV2(e.reference); cancellationReturned = true; result.cancellation = "requested";
      }
    }
    requireDelegationV2(e.kind === "created" || Buffer.byteLength(canonicalJson(e)) <= MAX_RECORD_BYTES, "group_record_full");
    result!.revision = index + 1;
  }
  result!.terminal = result!.spec.seats.every(s => result!.members.some(m => m.seatId === s.seatId && m.terminalReference)) ? "proven" : "unproven";
  return structuredClone(result!);
}

/** Reserve event/byte room for all remaining member records, run return and cancellation acknowledgement. */
export function delegationGroupCapacityV2(journal: DelegationGroupJournalV2): { events: number; bytes: number } {
  const p = projectDelegationGroupV2(journal);
  const run = journal.events.some(e => e.kind === "run_pending");
  const returned = journal.events.some(e => e.kind === "run_returned");
  const unrepresented = p.spec.seats.length - p.members.length;
  const unstarted = returned || p.cancellation !== "none" ? 0 : unrepresented;
  const outstanding = p.members.reduce((sum, m) => sum + (m.observation ? 0 : 1) + (m.invocationId ? 0 : 1) + (m.terminalReference ? 0 : 1), 0);
  const events = unstarted * 4 + (p.cancellation !== "none" ? unrepresented : 0) + outstanding + (returned ? 0 : run ? 1 : 2)
    + (p.cancellation === "none" ? 2 : p.cancellation === "pending" ? 1 : 0);
  return { events, bytes: events * MAX_RECORD_BYTES };
}

export function createDelegationGroupControllerV2(input: {
  store: DelegationGroupStoreV2;
  authorityService: ReturnType<typeof createDelegationAuthorityService>;
  dispatchLedger: AuthorizationLedger;
  host: DelegationGroupHostV2;
  cwd?: string;
}) {
  const { store, host, authorityService: service } = input;
  async function authorize(action: Parameters<DelegationGroupHostV2["authorize"]>[0]["action"], p: DelegationGroupProjectionV2 | null, c: GroupCommandV2 | null = null, groupId: string | null = null) {
    const reference = await host.authorize({ action, groupId: p?.spec.groupId ?? c?.groupId ?? groupId, spec: p ? structuredClone(p.spec) : c?.kind === "create" ? structuredClone(c.spec) : null,
      current: p && structuredClone(p), command: c && structuredClone(c) });
    requireDelegationV2(reference, "group_host_authorization_refused");
    const receipt = copyDelegationJsonV2(reference); delegationReferenceV2(receipt);
    const spec = p?.spec ?? (c?.kind === "create" ? c.spec : null);
    if (spec) {
      const authority = await service.inspect(spec.rootAuthorityRef.id);
      requireDelegationV2(same(rootAuthorityReferenceV2(authority.root), spec.rootAuthorityRef), "group_root_authority_mismatch");
    }
    return receipt;
  }
  async function get(groupId: string, action: "get" | "events" = "get") {
    delegationIdV2(groupId);
    await authorize(action, null, null, groupId);
    return store.transact(groupId, async journal => {
      const p = journal ? projectDelegationGroupV2(journal) : null;
      await authorize(action, p, null, groupId);
      requireDelegationV2(journal && p, "group_missing");
      return { journal, result: { projection: p, journal: structuredClone(journal) } };
    });
  }
  async function begin(value: unknown, kind: GroupCommandV2["kind"]) {
    const c = command(value); requireDelegationV2(c.kind === kind, "group_command_mismatch");
    await authorize(kind, null, c);
    return store.transact(c.groupId, async journal => {
      const p = journal ? projectDelegationGroupV2(journal) : null;
      const previous = journal?.events.find(e => "command" in e && e.command.operationKey === c.operationKey);
      if (previous && "command" in previous) {
        await authorize("replay", p, c);
        requireDelegationV2(same(c.controller, p!.spec.controller), "controller_fence_conflict");
        requireDelegationV2(digest(previous.command) === digest(c), "operation_intent_conflict");
        return { journal: journal!, result: { replayed: true, projection: p! } };
      }
      await authorize(kind, p, c);
      requireDelegationV2(c.expectedRevision === (p?.revision ?? 0), "group_revision_conflict");
      requireDelegationV2(!p || same(c.controller, p.spec.controller), "controller_fence_conflict");
      let terminalReceipt: DelegationReferenceV2 | null = null;
      if (c.kind === "create") {
        requireDelegationV2(!p, "group_already_exists");
        const authority = await service.inspect(c.spec.rootAuthorityRef.id);
        requireDelegationV2(!authority.cancelled && same(c.spec.policy.reference, authority.root.revisions.policy), "group_policy_inactive");
        requireDelegationV2(c.spec.policy.maxConcurrent <= authority.root.budget.max_concurrent_children, "group_concurrency_exceeded");
        for (const seat of c.spec.seats) {
          const { envelope } = await service.admitEffect(c.spec.rootAuthorityRef.id, seat.envelope.id, seat.effect);
          requireDelegationV2(envelope.generation === seat.envelope.generation && delegationEnvelopeDigestV2(envelope) === seat.envelope.digest, "group_envelope_mismatch");
          requireDelegationV2(seat.allocation.inputTokens <= envelope.budget.max_input_tokens && seat.allocation.outputTokens <= envelope.budget.max_output_tokens
            && seat.allocation.costMicros <= envelope.budget.max_cost_micros, "group_allocation_exceeded");
          const flow = envelope.execution_binding.flow_binding, topology = c.spec.topology;
          if (topology.kind === "flow") requireDelegationV2(flow.status === "bound" && flow.flow_run_id === topology.runId
            && flow.flow_step_id === seat.stepId && same(flow.definition, topology.definition), "group_flow_binding_mismatch");
          else requireDelegationV2(flow.status === "unbound" && envelope.execution_authority.posture === "report-only"
            && envelope.execution_authority.mutable_resources.length === 0, "independent_advisory_required");
        }
      } else {
        requireDelegationV2(p, "group_missing");
        if (c.kind === "not_launched") {
          const seat = p.spec.seats.find(s => s.seatId === c.seatId);
          const member = p.members.find(m => m.seatId === c.seatId);
          requireDelegationV2(seat && p.cancellation !== "none" && !member?.invocationId && !member?.terminalReference, "unlaunched_member_mismatch");
          const authority = await service.inspect(p.spec.rootAuthorityRef.id);
          requireDelegationV2(authority.cancelled && !authority.invocations.some(i => i.envelopeId === seat.envelope.id), "unlaunched_authority_unconfirmed");
          const receipt = await host.confirmNotLaunched?.(structuredClone(p.spec), structuredClone(seat));
          requireDelegationV2(receipt, "unlaunched_host_proof_required");
          const copy = copyDelegationJsonV2(receipt); delegationReferenceV2(copy); terminalReceipt = copy;
        } else if (c.kind === "terminal") {
          const seat = p.spec.seats.find(s => s.seatId === c.seatId);
          const member = p.members.find(m => m.seatId === c.seatId);
          requireDelegationV2(seat && member?.invocationId === c.invocationId && !member.terminalReference, "terminal_member_mismatch");
          const authority = await service.inspect(p.spec.rootAuthorityRef.id);
          const invocation = authority.invocations.find(i => i.invocationId === c.invocationId && i.envelopeId === seat.envelope.id);
          requireDelegationV2(invocation?.terminal && invocation.usage !== null, "terminal_accounting_unconfirmed");
          const receipt = await host.confirmTerminal?.(structuredClone(p.spec), structuredClone(seat), structuredClone(invocation), structuredClone(c.observation));
          requireDelegationV2(receipt, "terminal_host_proof_required");
          const copy = copyDelegationJsonV2(receipt); delegationReferenceV2(copy); terminalReceipt = copy;
        } else if (c.kind === "run") requireDelegationV2(p.execution === "idle" && p.cancellation === "none", "group_run_already_admitted");
        else requireDelegationV2(p.cancellation === "none", "group_cancel_already_requested");
      }
      const authorization = await authorize(kind, p, c);
      const next: DelegationGroupJournalV2 = journal ?? { schemaVersion: "2.0", groupId: c.groupId, events: [] };
      next.events.push({ revision: next.events.length + 1, kind: kind === "create" ? "created" : kind === "run" ? "run_pending" : kind === "terminal" ? "terminal_recorded" : kind === "not_launched" ? "terminal_unlaunched" : "cancel_pending", command: c, authorization: terminalReceipt ?? authorization });
      return { journal: next, result: { replayed: false, projection: projectDelegationGroupV2(next) } };
    });
  }
  async function append(groupId: string, value: GroupEventBodyV2) {
    const body = copyDelegationJsonV2(value) as GroupEventBodyV2;
    return store.transact(groupId, async journal => {
      requireDelegationV2(journal, "group_missing");
      await authorize(body.kind === "member_pending" || body.kind === "member_invoking" ? "execute" : "record", projectDelegationGroupV2(journal));
      if (body.kind === "cancel_requested") {
        const pending = journal.events.find(e => e.kind === "cancel_pending");
        requireDelegationV2(pending && "command" in pending && pending.command.operationKey === body.operationKey, "cancellation_identity_mismatch");
        const current = projectDelegationGroupV2(journal);
        if (current.cancellation === "requested") return { journal, result: current };
      }
      if (body.kind === "run_returned" && journal.events.some(e => e.kind === "run_returned")) {
        return { journal, result: projectDelegationGroupV2(journal) };
      }
      journal.events.push({ ...body, revision: journal.events.length + 1 });
      return { journal, result: projectDelegationGroupV2(journal) };
    });
  }
  async function active(groupId: string) {
    const { projection } = await get(groupId);
    await authorize("execute", projection);
    requireDelegationV2(projection.cancellation === "none", "group_cancelled");
    return projection;
  }
  return {
    create: (value: unknown) => begin(value, "create"),
    recordTerminal: (value: unknown) => begin(value, "terminal"),
    recordNotLaunched: (value: unknown) => begin(value, "not_launched"),
    async get(groupId: string) { return (await get(groupId)).projection; },
    async events(groupId: string, afterRevision = 0) {
      delegationIntegerV2(afterRevision, GROUP_V2_MAX_EVENTS);
      return (await get(groupId, "events")).journal.events.filter(e => e.revision > afterRevision);
    },
    async list() {
      await authorize("list", null);
      return store.scan(async journals => {
        await authorize("list", null);
        const projections = [];
        for (const journal of journals) {
          const p = projectDelegationGroupV2(journal); await authorize("list", p); projections.push(p);
        }
        return projections;
      });
    },
    async cancel(value: unknown) {
      const c = command(value);
      const started = await begin(c, "cancel");
      if (started.replayed) return started;
      // Ambiguous callback failure leaves cancel_pending. Replay never repeats the external request.
      await authorize("cancel", started.projection, c);
      await service.cancel(started.projection.spec.rootAuthorityRef.id);
      const reference = await host.requestDescendantCancellation(structuredClone(started.projection.spec));
      delegationReferenceV2(reference);
      return { replayed: false, projection: await append(c.groupId, { kind: "cancel_requested", operationKey: c.operationKey, reference }) };
    },
    async reconcileCancellation(value: unknown) {
      const c = command(value);
      requireDelegationV2(c.kind === "cancel", "cancel_command_required");
      const current = await get(c.groupId);
      requireDelegationV2(current.projection.cancellation !== "none", "cancellation_not_requested");
      const original = current.journal.events.find(e => e.kind === "cancel_pending");
      requireDelegationV2(original && "command" in original && same(original.command, c), "cancellation_identity_mismatch");
      const started = await begin(c, "cancel");
      if (started.projection.cancellation === "requested") return started;
      await authorize("cancel", started.projection, c);
      // Local revocation is idempotent; observation of the external request is not a resend.
      await service.cancel(started.projection.spec.rootAuthorityRef.id);
      const reference = await host.confirmDescendantCancellation?.(structuredClone(started.projection.spec), structuredClone(c));
      requireDelegationV2(reference, "cancellation_confirmation_unavailable");
      delegationReferenceV2(reference);
      return { replayed: false, projection: await append(c.groupId, { kind: "cancel_requested", operationKey: c.operationKey, reference }) };
    },
    async run(value: unknown, options: { signal?: AbortSignal } = {}) {
      options.signal?.throwIfAborted();
      const c = command(value);
      const started = await begin(c, "run");
      if (started.replayed) return started;
      const spec = started.projection.spec;
      try {
        const delegate = host.executionHost(structuredClone(spec));
        const beginMember = async (seat: DelegationGroupSeatV2, claimId: string | null) => {
          options.signal?.throwIfAborted();
          await append(spec.groupId, { kind: "member_pending", operationKey: c.operationKey, seatId: seat.seatId, claimId });
          options.signal?.throwIfAborted();
        };
        const recordMember = async (seat: DelegationGroupSeatV2, outcome: DelegationDispatchOutcome) => {
          const retained = await host.retainMemberOutcome(structuredClone(spec), structuredClone(seat), structuredClone(outcome));
          const observed = { ...retained, outcome: outcome.outcome };
          observation(copyDelegationJsonV2(observed));
          await append(spec.groupId, { kind: "member_observed", operationKey: c.operationKey, seatId: seat.seatId, observation: observed });
        };
        const execution: DelegationFlowExecutionHost = {
          resolveRuntime: async envelope => {
            const seat = spec.seats.find(s => s.envelope.id === envelope.envelope_id);
            requireDelegationV2(seat && envelope.generation === seat.envelope.generation
              && delegationEnvelopeDigestV2(envelope) === seat.envelope.digest, "group_envelope_mismatch");
            await active(spec.groupId); return delegate.resolveRuntime(envelope);
          },
          invokeFenced: async (envelope, id, invoke) => {
            const seat = spec.seats.find(s => s.envelope.id === envelope.envelope_id);
            requireDelegationV2(seat, "group_seat_missing");
            await append(spec.groupId, { kind: "member_invoking", operationKey: c.operationKey, seatId: seat.seatId, invocationId: id });
            await active(spec.groupId);
            return delegate.invokeFenced(envelope, id, invoke);
          },
          retainResult: (...args) => delegate.retainResult(...args),
          retainFailure: (...args) => delegate.retainFailure(...args),
          recordScheduleEvent: async event => { await active(spec.groupId); return delegate.recordScheduleEvent(event); },
          confirmClaim: async (claim, envelope) => {
            await active(spec.groupId); return delegate.confirmClaim(claim, envelope);
          },
          prepareRequest: async (claim, envelope) => {
            const seat = spec.seats.find(s => s.envelope.id === envelope.envelope_id);
            requireDelegationV2(seat, "group_seat_missing");
            await beginMember(seat, claim.claim_id);
            return delegate.prepareRequest(claim, envelope);
          },
          recordMemberOutcome: async (claim, envelope, outcome) => {
            const seat = spec.seats.find(s => s.envelope.id === envelope.envelope_id);
            requireDelegationV2(seat, "group_seat_missing");
            await recordMember(seat, outcome);
            await delegate.recordMemberOutcome(claim, envelope, outcome);
            await active(spec.groupId);
          },
        };
        let result: unknown;
        if (spec.topology.kind === "flow") {
          const topology = spec.topology;
          const loaded = await loadRun(topology.runId, input.cwd);
          requireDelegationV2(same(definitionIdentity(loaded.definition), topology.definition), "group_flow_definition_mismatch");
          await active(spec.groupId);
          result = await orchestrateDelegationFlow({ authorityId: spec.rootAuthorityRef.id, service, dispatchLedger: input.dispatchLedger,
            host: execution, runId: topology.runId, actor: topology.actor, cwd: input.cwd,
            maxConcurrent: spec.policy.maxConcurrent, signal: options.signal,
            seats: spec.seats.map(s => ({ stepId: s.stepId!, envelopeId: s.envelope.id, effect: s.effect, allocation: s.allocation })),
          });
        } else {
          const prepareRequest = host.prepareIndependentRequest?.bind(host);
          requireDelegationV2(prepareRequest, "independent_request_host_required");
          let cursor = 0, admissionStopped = false;
          const workers = Array.from({ length: Math.min(spec.policy.maxConcurrent, spec.seats.length) }, async () => {
            try {
              while (!admissionStopped && cursor < spec.seats.length) {
                const seat = spec.seats[cursor++];
                await beginMember(seat, null);
                const { envelope } = await service.admitEffect(spec.rootAuthorityRef.id, seat.envelope.id, seat.effect);
                const request = await prepareRequest(structuredClone(spec), structuredClone(seat), structuredClone(envelope));
                await active(spec.groupId);
                const outcome = await executeAuthorizedDelegation({ service, host: execution, dispatchLedger: input.dispatchLedger,
                  authorityId: spec.rootAuthorityRef.id, envelopeId: seat.envelope.id,
                  invocationId: `group_${digest([spec.groupId, spec.controller, c.operationKey, seat.seatId])}`,
                  effect: seat.effect, allocation: seat.allocation, request, signal: options.signal });
                await recordMember(seat, outcome);
              }
            } catch (error) { admissionStopped = true; throw error; }
          });
          const settled = await Promise.allSettled(workers);
          const errors = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected").map(r => r.reason);
          if (errors.length) throw new AggregateError(errors, "Independent group execution unknown");
          result = { kind: "independent-advisory", membersObserved: spec.seats.length };
        }
        const reference = await host.retainRunObservation(structuredClone(spec), result);
        delegationReferenceV2(reference);
        return { replayed: false, projection: await append(spec.groupId, { kind: "run_returned", operationKey: c.operationKey, status: "returned", reference }) };
      } catch (error) {
        const reference = await host.retainRunFailure(structuredClone(spec), error);
        delegationReferenceV2(reference);
        await append(spec.groupId, { kind: "run_returned", operationKey: c.operationKey, status: "execution_unknown", reference });
        throw error;
      }
    },
  };
}
