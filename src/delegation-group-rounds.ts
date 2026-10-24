import { createHash } from "node:crypto";
import { canonicalJson, type ModelInvocationRequest } from "@kontourai/relay";
import { type FlowDefinitionIdentity, type FlowStepClaimActor, type FlowDurableStepClaim, type FlowRetryAuthorizationRequest, validateRetryAuthorizationRequest } from "./delegation-flow-bindings.js";
import { runDelegationFlowRound, validateFlowRoundRelease, validateFlowRoundCreation } from "./delegation-rounds-flow.js";
import { finalizeRoundsSync, type PreparedRoundsSync, preparedRoundsSyncDigest, validatePreparedRoundsSync, runRoundsContinuation, validateRoundsContinuation } from "./delegation-rounds-continuation.js";
import { authorityLineageReference, type AuthorityEpochV3 } from "./delegation-authority-service-v3.js";
import { assertSyncedRecipient, type ResolvedDelegationRecipient, type DelegationRecipientIdentity, validateRecipientIdentity } from "./delegation-rounds-recipient.js";
import type { AuthorizationLedger } from "@kontourai/dispatch";
import {
  copyDelegationJsonV2, delegationRecordV2, delegationIdV2, delegationIntegerV2, delegationDigestV2, delegationFlowDefinitionIdentityV2, delegationTimestampV2,
  delegationReferenceV2, requireDelegationV2, type DelegationReferenceV2,
} from "./delegation-authority-contract.js";
import { rootAuthorityReferenceV2, delegationEnvelopeDigestV2, type RootAuthorityReferenceV2, type DelegationEnvelopeV2 } from "./delegation-envelope-v2.js";
import { createDelegationAuthorityService, type DelegationInvocation, type DelegationInvocationAmounts } from "./delegation-authority-service.js";
import { executeRoundsDelegation, type DelegationRoundsExecutionHost, type DelegationRoundsFlowExecutionHost, type DelegationRoundsOutcome } from "./delegation-rounds-accounting.js";
export type { DelegationRoundsExecutionHost, DelegationRoundsFlowExecutionHost, DelegationRoundsOutcome } from "./delegation-rounds-accounting.js";

export type RoundSeat = {
  seatId: string; envelope: { id: string; generation: number; digest: string };
  stepId?: string;
  effect: string; allocation: DelegationInvocationAmounts;
};
export type DelegationRoundsSpec = {
  schemaVersion: "1.0"; groupId: string; rootAuthorityRef: RootAuthorityReferenceV2;
  controller: { id: string; generation: number };
  topology: { kind: "independent-advisory" } | { kind: "flow"; runId: string; definition: FlowDefinitionIdentity; actor: FlowStepClaimActor };
  policy: { reference: DelegationReferenceV2; maxRounds: number; maxAttempts: number; maxConcurrent: number; maxEvaluations?: number; maxRecoveries?: number; maxSyncs?: number; maxRenewals?: number };
  seats: RoundSeat[];
};
export type RoundSelection = { seatId: string; previousInvocationId: string | null; mode?: "invoke"; retryRef?: string | null; nonadmissionOf?: string; syncKey?: string }
  | { seatId: string; mode: "evaluate"; invocationId: string; syncKey?: string };
export type FlowRoundAction = { round: number; seatId: string; mode: "invoke" | "evaluate"; invocationId: string;
  claim: { value: FlowDurableStepClaim; transitionCount: number } | null;
  recipient?: DelegationRecipientIdentity;
  nonadmission?: { reason: "resource_conflict"; runHead: string };
  evaluation: { reference: DelegationReferenceV2; settled: boolean; runHead: string } | null };
type CommandBase = { groupId: string; operationKey: string; expectedRevision: number; controller: DelegationRoundsSpec["controller"] };
export type DelegationRoundsCommand = CommandBase & (
  | { kind: "create"; spec: DelegationRoundsSpec }
  | { kind: "release"; checkpoint: DelegationReferenceV2; flowHead?: string; seats: RoundSelection[] }
  | { kind: "reappraise"; checkpoint: DelegationReferenceV2; flowHead: string; gate: string; blockedTransitionRef: string }
  | { kind: "authorizeRetry"; checkpoint: DelegationReferenceV2; flowHead: string; reappraisalKey: string; request: FlowRetryAuthorizationRequest }
  | { kind: "sync"; checkpoint: DelegationReferenceV2; flowHead: string; seatId: string; contextRef: DelegationReferenceV2 }
  | { kind: "terminal"; invocationId: string }
  | { kind: "cancel" }
);
export type RoundContinuation = {
  command: Extract<DelegationRoundsCommand, {kind: "reappraise" | "authorizeRetry" | "sync"}>;
  afterRound: number;
  prepared?: PreparedRoundsSync;
  receipt: null | { reference: DelegationReferenceV2; flowHead: string; transitionRef: string | null; acknowledged: boolean };
};
export type RoundAttempt = {
  round: number; seatId: string; invocationId: string; previousInvocationId: string | null;
  claimRefs?: string[];
  recipient?: DelegationRecipientIdentity;
  admission?: "planned" | "claimed" | "not_admitted";
  nonadmissionOf?: string;
  observation: DelegationReferenceV2 | null; terminal: DelegationReferenceV2 | null;
};
export type AdoptAuthorityRenewalCommand = CommandBase & { kind: "adoptRenewal"; renewalOperationKey: string; authority: RootAuthorityReferenceV2 };
export type FinalizeRoundsSyncCommand = CommandBase & { kind: "finalizeSync"; syncOperationKey: string; preparedDigest: string };
export type FinalizeRoundsCancelCommand = CommandBase & { kind: "finalizeCancel"; cancelOperationKey: string };
export type DelegationRoundsAuthorizationCommand = DelegationRoundsCommand | FinalizeRoundsSyncCommand | AdoptAuthorityRenewalCommand | FinalizeRoundsCancelCommand;
export type DelegationRoundsEventBody =
  | { kind: "command"; command: DelegationRoundsCommand; authorization: DelegationReferenceV2 }
  | { kind: "grant_adopted"; command: AdoptAuthorityRenewalCommand; authorization: DelegationReferenceV2; hostReceipt: DelegationReferenceV2;
      previous: RootAuthorityReferenceV2; envelopes: { seatId: string; envelope: RoundSeat["envelope"] }[] }
  | { kind: "sync_prepared"; operationKey: string; prepared: PreparedRoundsSync }
  | { kind: "sync_finalized"; command: FinalizeRoundsSyncCommand; authorization: DelegationReferenceV2; reference: DelegationReferenceV2 }
  | { kind: "continued"; operationKey: string; receipt: NonNullable<RoundContinuation["receipt"]> }
  | { kind: "flow_not_admitted"; operationKey: string; seatId: string; reason: "resource_conflict"; runHead: string }
  | { kind: "flow_claimed"; operationKey: string; seatId: string; claim: FlowDurableStepClaim; transitionCount: number; recipient?: DelegationRecipientIdentity }
  | { kind: "flow_evaluated"; operationKey: string; seatId: string; claimId: string; receipt: { reference: DelegationReferenceV2; settled: boolean; runHead: string } }
  | { kind: "observed"; invocationId: string; reference: DelegationReferenceV2 }
  | { kind: "returned"; operationKey: string }
  | { kind: "cancel_requested"; reference: DelegationReferenceV2 }
  | { kind: "cancel_finalized"; command: FinalizeRoundsCancelCommand; authorization: DelegationReferenceV2; reference: DelegationReferenceV2 };
export type DelegationRoundsEvent = DelegationRoundsEventBody & { revision: number };
export type DelegationRoundsJournal = { schemaVersion: "1.0"; groupId: string; events: DelegationRoundsEvent[] };
export type DelegationRoundsProjection = {
  spec: DelegationRoundsSpec; revision: number; cancellation: "none" | "pending" | "requested";
  rounds: { operationKey: string; checkpoint: DelegationReferenceV2; returned: boolean }[];
  flowActions: FlowRoundAction[];
  continuations: RoundContinuation[];
  grants: { authority: RootAuthorityReferenceV2; envelopes: { seatId: string; envelope: RoundSeat["envelope"] }[]; renewals: number };
  attempts: RoundAttempt[]; acceptance: "unassessed";
};
export interface DelegationRoundsStore {
  transact<T>(groupId: string, body: (journal: DelegationRoundsJournal | null) => Promise<{ journal: DelegationRoundsJournal; result: T }>): Promise<T>;
}
export interface DelegationRoundsHost {
  /** Explicit host-only opt-in; tagged accounting is never inferred from Relay dollars. */
  accountingProtocol?: "retained-tariff-v1";
  /** Authenticate current caller/custody, immutable roster/policy and root exclusivity across stores.
   * For release, authorize this exact checkpoint, seat subset and all predecessor identities NOW.
   * A checkpoint reference does not authorize itself. Reads/replays must also authenticate. */
  authorize(input: { action: "create" | "release" | "terminal" | "cancel" | "get" | "events" | "replay" | "execute" | "record" | "reappraise" | "authorizeRetry" | "sync" | "finalizeSync" | "adoptRenewal" | "finalizeCancel";
    groupId: string; current: DelegationRoundsProjection | null; command: DelegationRoundsAuthorizationCommand | null }): Promise<DelegationReferenceV2 | null>;
  executionHost(spec: DelegationRoundsSpec): DelegationRoundsExecutionHost;
  prepareRequest(spec: DelegationRoundsSpec, seat: RoundSeat, attempt: RoundAttempt, envelope: DelegationEnvelopeV2): Promise<ModelInvocationRequest>;
  /** Retain raw output/dissent/uncertainty or error. A reference grants no acceptance. */
  retainObservation(spec: DelegationRoundsSpec, attempt: RoundAttempt, observation: { outcome: DelegationRoundsOutcome } | { error: unknown }): Promise<DelegationReferenceV2>;
  /** Confirm exact physical invocation AND descendants are terminal, independently of model output. */
  confirmTerminal(spec: DelegationRoundsSpec, attempt: RoundAttempt, invocation: DelegationInvocation): Promise<DelegationReferenceV2 | null>;
  /** Flow-specific authenticated boundary. Existing independent callers need not implement it. */
  flow?: {
    executionHost(spec: DelegationRoundsSpec): DelegationRoundsFlowExecutionHost;
    /** Exclusive host custody over other Flow mutations; public evaluateRun lacks expected-head admission. */
    withContinuationMutation?<T>(spec: DelegationRoundsSpec, command: DelegationRoundsCommand, body: () => Promise<T>): Promise<T>;
    confirmRetainedResult(spec: DelegationRoundsSpec, attempt: RoundAttempt, reference: DelegationReferenceV2): Promise<boolean>;
    retainEvaluation(spec: DelegationRoundsSpec, action: FlowRoundAction, receipt: unknown): Promise<DelegationReferenceV2>;
  };
  /** Resolves the actual physical recipient from the authenticated host session registry. */
  recipient?: { resolve(spec: DelegationRoundsSpec, seat: RoundSeat, envelope: DelegationEnvelopeV2): Promise<ResolvedDelegationRecipient> };
  retainContinuation?(spec: DelegationRoundsSpec, receipt: unknown): Promise<DelegationReferenceV2>;
  context?: {
    load(reference: DelegationReferenceV2): Promise<string>;
    executionHost(spec: DelegationRoundsSpec, seat: RoundSeat): DelegationRoundsExecutionHost;
    confirmTerminal(spec: DelegationRoundsSpec, seat: RoundSeat, invocation: DelegationInvocation, recipient: DelegationRecipientIdentity | null): Promise<DelegationReferenceV2 | null>;
  };
  requestDescendantCancellation(spec: DelegationRoundsSpec): Promise<DelegationReferenceV2>;
  /** Observe an independently retained cancellation request for this exact original
   * command. Never resend interrupts here; this proves a request, not termination. */
  confirmCancellation?(spec: DelegationRoundsSpec, command: Extract<DelegationRoundsCommand, { kind: "cancel" }>): Promise<DelegationReferenceV2 | null>;
}
export const ROUNDS_MAX_EVENTS = 1024;
export const ROUNDS_MAX_BYTES = 32 * 1024 * 1024;
export const ROUNDS_RECORD_BYTES = 32 * 1024;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function fence(value: unknown): void {
  const r = delegationRecordV2(value, ["id", "generation"]);
  delegationIdV2(r.id); delegationIntegerV2(r.generation);
}
function reference(value: unknown): DelegationReferenceV2 {
  const copy = copyDelegationJsonV2(value); delegationReferenceV2(copy); return copy;
}
export function validateDelegationRoundsSpec(value: unknown): DelegationRoundsSpec {
  const r = delegationRecordV2(copyDelegationJsonV2(value), ["schemaVersion", "groupId", "rootAuthorityRef", "controller", "topology", "policy", "seats"]);
  requireDelegationV2(r.schemaVersion === "1.0", "rounds_schema"); delegationIdV2(r.groupId); fence(r.controller);
  const root = delegationRecordV2(r.rootAuthorityRef, ["id", "digest", "authority_epoch"]);
  delegationIdV2(root.id); delegationDigestV2(root.digest); delegationIntegerV2(root.authority_epoch);
  const topology = r.topology as DelegationRoundsSpec["topology"];
  if (topology.kind === "flow") {
    delegationRecordV2(topology, ["kind", "runId", "definition", "actor"]); delegationIdV2(topology.runId);
    delegationFlowDefinitionIdentityV2(topology.definition);
    delegationRecordV2(topology.actor, ["key", ...(topology.actor.kind === undefined ? [] : ["kind"])]);
    delegationIdV2(topology.actor.key); if (topology.actor.kind !== undefined) delegationIdV2(topology.actor.kind);
  } else {
    delegationRecordV2(topology, ["kind"]); requireDelegationV2(topology.kind === "independent-advisory", "rounds_topology");
  }
  const policy = delegationRecordV2(r.policy, ["reference", "maxRounds", "maxAttempts", "maxConcurrent", ...(topology.kind === "flow" ? ["maxEvaluations"] : []), ...((r.policy as {maxRecoveries?: unknown}).maxRecoveries === undefined ? [] : ["maxRecoveries"]), ...((r.policy as {maxSyncs?: unknown}).maxSyncs === undefined ? [] : ["maxSyncs"]), ...((r.policy as {maxRenewals?: unknown}).maxRenewals === undefined ? [] : ["maxRenewals"])]);
  if (topology.kind === "flow") delegationIntegerV2(policy.maxEvaluations, 128);
  if (policy.maxRecoveries !== undefined) delegationIntegerV2(policy.maxRecoveries, 16);
  if (policy.maxSyncs !== undefined) delegationIntegerV2(policy.maxSyncs, 32);
  if (policy.maxRenewals !== undefined) delegationIntegerV2(policy.maxRenewals, 8);
  requireDelegationV2(topology.kind === "flow" || (policy.maxRecoveries === undefined && policy.maxSyncs === undefined && policy.maxRenewals === undefined), "rounds_flow_policy_required");
  delegationReferenceV2(policy.reference);
  for (const [key, max] of [["maxRounds", 16], ["maxAttempts", 128], ["maxConcurrent", 64]] as const) {
    delegationIntegerV2(policy[key], max); requireDelegationV2((policy[key] as number) > 0, "rounds_positive_bound");
  }
  requireDelegationV2(Array.isArray(r.seats) && r.seats.length > 0 && r.seats.length <= 64, "rounds_roster");
  for (const seat of r.seats) {
    const s = delegationRecordV2(seat, ["seatId", "envelope", "effect", "allocation", ...(topology.kind === "flow" ? ["stepId"] : [])]);
    delegationIdV2(s.seatId); delegationIdV2(s.effect); if (topology.kind === "flow") delegationIdV2(s.stepId);
    const e = delegationRecordV2(s.envelope, ["id", "generation", "digest"]);
    delegationIdV2(e.id); delegationIntegerV2(e.generation, 32);
    delegationDigestV2(e.digest);
    const a = delegationRecordV2(s.allocation, ["inputTokens", "outputTokens", "costMicros"]);
    Object.values(a).forEach(v => delegationIntegerV2(v));
  }
  const seats = r.seats as RoundSeat[];
  requireDelegationV2(new Set(seats.map(s => s.seatId)).size === seats.length && new Set(seats.map(s => s.envelope.id)).size === seats.length, "rounds_duplicate_seat");
  if (topology.kind === "flow") requireDelegationV2(new Set(seats.map(s => s.stepId)).size === seats.length, "rounds_duplicate_step");
  if ((policy.maxRenewals as number | undefined) && Buffer.byteLength(canonicalJson(seats.map(s => ({ seatId: s.seatId, envelope: s.envelope })))) + 8192 > ROUNDS_RECORD_BYTES) {
    requireDelegationV2(false, "rounds_renewal_record_capacity");
  }
  requireDelegationV2(Buffer.byteLength(canonicalJson(r)) <= 1024 * 1024, "rounds_spec_full");
  return r as DelegationRoundsSpec;
}
function command(value: unknown): DelegationRoundsCommand {
  const copy = copyDelegationJsonV2(value), kind = (copy as { kind?: unknown })?.kind;
  const r = delegationRecordV2(copy, ["kind", "groupId", "operationKey", "expectedRevision", "controller",
    ...(kind === "create" ? ["spec"] : kind === "release" ? ["checkpoint", "seats", ...((copy as {flowHead?: unknown}).flowHead === undefined ? [] : ["flowHead"])] : kind === "terminal" ? ["invocationId"] : kind === "reappraise" ? ["checkpoint", "flowHead", "gate", "blockedTransitionRef"] : kind === "authorizeRetry" ? ["checkpoint", "flowHead", "reappraisalKey", "request"] : kind === "sync" ? ["checkpoint", "flowHead", "seatId", "contextRef"] : [])]);
  requireDelegationV2(["create", "release", "terminal", "cancel", "reappraise", "authorizeRetry", "sync"].includes(kind as string), "rounds_command");
  delegationIdV2(r.groupId); delegationIdV2(r.operationKey); delegationIntegerV2(r.expectedRevision, ROUNDS_MAX_EVENTS); fence(r.controller);
  if (kind === "create") {
    const spec = validateDelegationRoundsSpec(r.spec);
    requireDelegationV2(spec.groupId === r.groupId && same(spec.controller, r.controller), "rounds_identity"); r.spec = spec;
  } else if (kind === "release") {
    delegationReferenceV2(r.checkpoint); if (r.flowHead !== undefined) hex(r.flowHead);
    requireDelegationV2(Array.isArray(r.seats) && r.seats.length > 0 && r.seats.length <= 64, "rounds_release_seats");
    for (const value of r.seats) {
      const selection = value as RoundSelection;
      if (selection.mode === "evaluate") {
        delegationRecordV2(selection, ["seatId", "mode", "invocationId", ...(selection.syncKey === undefined ? [] : ["syncKey"])]); delegationIdV2(selection.invocationId);
      } else {
        const s = delegationRecordV2(value, ["seatId", "previousInvocationId", ...(selection.mode === undefined ? [] : ["mode", "retryRef", ...(selection.nonadmissionOf === undefined ? [] : ["nonadmissionOf"]), ...(selection.syncKey === undefined ? [] : ["syncKey"])])]);
        if (s.previousInvocationId !== null) delegationIdV2(s.previousInvocationId);
        if (selection.nonadmissionOf !== undefined) delegationIdV2(selection.nonadmissionOf);
        if (selection.mode !== undefined) { requireDelegationV2(selection.mode === "invoke", "rounds_mode"); if (selection.retryRef !== null) hex(selection.retryRef); }
      }
      delegationIdV2(selection.seatId); if (selection.syncKey !== undefined) delegationIdV2(selection.syncKey);
    }
    requireDelegationV2(new Set(r.seats.map(s => s.seatId)).size === r.seats.length, "rounds_duplicate_release");
  } else if (kind === "terminal") delegationIdV2(r.invocationId);
  else if (kind === "reappraise" || kind === "authorizeRetry" || kind === "sync") {
    delegationReferenceV2(r.checkpoint); hex(r.flowHead);
    if (kind === "reappraise") { delegationIdV2(r.gate); hex(r.blockedTransitionRef); }
    else if (kind === "authorizeRetry") { delegationIdV2(r.reappraisalKey); r.request = validateRetryAuthorizationRequest(r.request); }
    else { delegationIdV2(r.seatId); delegationReferenceV2(r.contextRef); }
  }
  return r as DelegationRoundsCommand;
}
function adoptCommand(value: unknown): AdoptAuthorityRenewalCommand {
  const r = delegationRecordV2(copyDelegationJsonV2(value), ["kind", "groupId", "operationKey", "expectedRevision", "controller", "renewalOperationKey", "authority"]);
  requireDelegationV2(r.kind === "adoptRenewal", "rounds_command"); [r.groupId, r.operationKey, r.renewalOperationKey].forEach(delegationIdV2);
  delegationIntegerV2(r.expectedRevision, ROUNDS_MAX_EVENTS); fence(r.controller);
  const a = delegationRecordV2(r.authority, ["id", "digest", "authority_epoch"]); delegationIdV2(a.id); delegationDigestV2(a.digest); delegationIntegerV2(a.authority_epoch);
  return r as AdoptAuthorityRenewalCommand;
}
function finalizeCommand(value: unknown): FinalizeRoundsSyncCommand {
  const r = delegationRecordV2(copyDelegationJsonV2(value), ["kind", "groupId", "operationKey", "expectedRevision", "controller", "syncOperationKey", "preparedDigest"]);
  requireDelegationV2(r.kind === "finalizeSync", "rounds_command"); [r.groupId, r.operationKey, r.syncOperationKey].forEach(delegationIdV2);
  delegationIntegerV2(r.expectedRevision, ROUNDS_MAX_EVENTS); fence(r.controller); delegationDigestV2(r.preparedDigest);
  return r as FinalizeRoundsSyncCommand;
}
function finalizeCancelCommand(value: unknown): FinalizeRoundsCancelCommand {
  const r = delegationRecordV2(copyDelegationJsonV2(value), ["kind", "groupId", "operationKey", "expectedRevision", "controller", "cancelOperationKey"]);
  requireDelegationV2(r.kind === "finalizeCancel", "rounds_command"); [r.groupId, r.operationKey, r.cancelOperationKey].forEach(delegationIdV2);
  delegationIntegerV2(r.expectedRevision, ROUNDS_MAX_EVENTS); fence(r.controller);
  return r as FinalizeRoundsCancelCommand;
}
function hex(value: unknown): asserts value is string {
  requireDelegationV2(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), "rounds_flow_hash");
}
/** Historical claim shape only. Current authority is checked by Flow at execution time. */
function historicalClaim(claim: FlowDurableStepClaim): void {
  delegationRecordV2(claim, ["schema_version", "claim_id", "liveness_id", "run_id", "definition", "claim_base", "step_id", "actor", "mutable_resources", "issued_at", "renewed_at", "expires_at"]);
  requireDelegationV2(claim.schema_version === "1", "rounds_claim_schema");
  for (const id of [claim.claim_id, claim.liveness_id, claim.run_id, claim.step_id]) delegationIdV2(id);
  delegationFlowDefinitionIdentityV2(claim.definition);
  delegationRecordV2(claim.claim_base, ["schema_version", "step_id", "head"]); hex(claim.claim_base.head);
  requireDelegationV2(claim.claim_base.schema_version === "1" && claim.claim_base.step_id === claim.step_id, "rounds_claim_base");
  delegationRecordV2(claim.actor, ["key", ...(claim.actor.kind === undefined ? [] : ["kind"])]);
  delegationIdV2(claim.actor.key); if (claim.actor.kind !== undefined) delegationIdV2(claim.actor.kind);
  requireDelegationV2(Array.isArray(claim.mutable_resources) && claim.mutable_resources.length <= 1024
    && claim.mutable_resources.every(r => typeof r === "string" && r.length > 0), "rounds_claim_resources");
  for (const at of [claim.issued_at, claim.renewed_at, claim.expires_at]) delegationTimestampV2(at);
  requireDelegationV2(claim.issued_at <= claim.renewed_at && claim.renewed_at < claim.expires_at, "rounds_claim_time");
}
function invocationId(spec: DelegationRoundsSpec, c: DelegationRoundsCommand, seatId: string): string {
  return `round_${createHash("sha256").update(canonicalJson([spec.groupId, spec.rootAuthorityRef, c.operationKey, seatId])).digest("hex")}`;
}
/** Closed replay of append-only intent/history; never invokes services or host effects. */
export function projectDelegationRounds(journal: DelegationRoundsJournal): DelegationRoundsProjection {
  delegationRecordV2(journal, ["schemaVersion", "groupId", "events"]); delegationIdV2(journal.groupId);
  requireDelegationV2(journal.schemaVersion === "1.0" && Array.isArray(journal.events) && journal.events.length > 0 && journal.events.length <= ROUNDS_MAX_EVENTS, "rounds_journal");
  let p: DelegationRoundsProjection | undefined;
  const keys = new Set<string>();
  for (const [index, raw] of journal.events.entries()) {
    const e = copyDelegationJsonV2(raw) as DelegationRoundsEvent;
    requireDelegationV2(e.revision === index + 1, "rounds_revision");
    if (e.kind === "command") {
      delegationRecordV2(e, ["revision", "kind", "command", "authorization"]);
      const c = command(e.command); delegationReferenceV2(e.authorization);
      requireDelegationV2(c.groupId === journal.groupId && c.expectedRevision === index && !keys.has(c.operationKey), "rounds_operation"); keys.add(c.operationKey);
      if (c.kind === "create") {
        requireDelegationV2(!p && index === 0, "rounds_creation");
        p = { spec: c.spec, revision: 1, cancellation: "none", rounds: [], attempts: [], flowActions: [], continuations: [], grants: { authority: c.spec.rootAuthorityRef, envelopes: c.spec.seats.map(s => ({ seatId: s.seatId, envelope: s.envelope })), renewals: 0 }, acceptance: "unassessed" };
      } else {
        requireDelegationV2(p && same(c.controller, p.spec.controller), "rounds_controller_fence");
        if (c.kind === "release") {
          requireDelegationV2(p.cancellation === "none", "rounds_cancelled");
          requireDelegationV2(p.rounds.every(r => r.returned) && p.continuations.every(r => r.receipt), "rounds_pending_hold");
          requireDelegationV2(p.rounds.length < p.spec.policy.maxRounds && p.attempts.length + 2 * p.continuations.filter(r => r.command.kind === "sync").length + c.seats.filter(s => s.mode !== "evaluate").length <= p.spec.policy.maxAttempts, "rounds_capacity");
          requireDelegationV2(!p.rounds.some(r => same(r.checkpoint, c.checkpoint)) && !p.continuations.some(r => same(r.command.checkpoint, c.checkpoint)), "rounds_checkpoint_reused");
          const round = p.rounds.length + 1, flow = p.spec.topology.kind === "flow";
          requireDelegationV2(flow === (c.flowHead !== undefined), "rounds_flow_head_required");
          for (const selection of c.seats) {
            requireDelegationV2(p.spec.seats.some(s => s.seatId === selection.seatId), "rounds_unauthorized_seat");
            requireDelegationV2(flow ? selection.mode !== undefined : selection.mode === undefined, "rounds_mode");
            const previous = p.attempts.filter(a => a.seatId === selection.seatId).at(-1);
            let id: string;
            if (selection.mode === "evaluate") {
              requireDelegationV2(previous && previous.invocationId === selection.invocationId && previous.observation && previous.terminal, "rounds_retained_terminal_required");
              requireDelegationV2(p.flowActions.filter(a => a.mode === "evaluate").length < p.spec.policy.maxEvaluations!, "rounds_evaluation_capacity");
              id = selection.invocationId;
            } else {
              if (selection.nonadmissionOf !== undefined) {
                requireDelegationV2(flow && previous?.admission === "not_admitted" && previous.invocationId === selection.nonadmissionOf
                  && selection.previousInvocationId === null && selection.retryRef === null, "rounds_definite_nonadmission_required");
              } else requireDelegationV2(previous ? previous.invocationId === selection.previousInvocationId && previous.terminal !== null : selection.previousInvocationId === null, "rounds_previous_terminal_required");
              id = invocationId(p.spec, c, selection.seatId);
              p.attempts.push({ round, seatId: selection.seatId, invocationId: id, previousInvocationId: selection.previousInvocationId,
                observation: null, terminal: null, ...(flow ? { claimRefs: [], admission: "planned" as const } : {}), ...(selection.nonadmissionOf === undefined ? {} : { nonadmissionOf: selection.nonadmissionOf }) });
            }
            if (flow) p.flowActions.push({ round, seatId: selection.seatId, mode: selection.mode!, invocationId: id, claim: null, evaluation: null });
          }
          p.rounds.push({ operationKey: c.operationKey, checkpoint: c.checkpoint, returned: false });
        } else if (c.kind === "reappraise" || c.kind === "authorizeRetry" || c.kind === "sync") {
          requireDelegationV2(p.spec.topology.kind === "flow" && p.cancellation === "none" && p.rounds.every(r => r.returned)
            && p.continuations.every(r => r.receipt), "rounds_continuation_admission");
          requireDelegationV2(!p.rounds.some(r => same(r.checkpoint, c.checkpoint)) && !p.continuations.some(r => same(r.command.checkpoint, c.checkpoint)), "rounds_checkpoint_reused");
          if (c.kind === "sync") requireDelegationV2(p.continuations.filter(r => r.command.kind === "sync").length < (p.spec.policy.maxSyncs ?? 0)
            && p.attempts.length + 2 * (p.continuations.filter(r => r.command.kind === "sync").length + 1) <= p.spec.policy.maxAttempts, "rounds_sync_capacity");
          else requireDelegationV2(p.continuations.filter(r => r.command.kind !== "sync").length < (p.spec.policy.maxRecoveries ?? 0), "rounds_recovery_capacity");
          p.continuations.push({ command: c, afterRound: p.rounds.length, receipt: null });
        } else if (c.kind === "terminal") {
          const attempt = p.attempts.find(a => a.invocationId === c.invocationId);
          requireDelegationV2(attempt && !attempt.terminal, "rounds_terminal_identity"); attempt.terminal = e.authorization;
        } else {
          requireDelegationV2(p.cancellation === "none", "rounds_cancelled"); p.cancellation = "pending";
        }
      }
    } else {
      requireDelegationV2(p, "rounds_missing");
      if (e.kind === "grant_adopted") {
        delegationRecordV2(e, ["revision", "kind", "command", "authorization", "hostReceipt", "previous", "envelopes"]);
        const c = adoptCommand(e.command); delegationReferenceV2(e.authorization); delegationReferenceV2(e.hostReceipt);
        requireDelegationV2(c.groupId === p.spec.groupId && c.expectedRevision === index && !keys.has(c.operationKey)
          && same(c.controller, p.spec.controller), "rounds_operation"); keys.add(c.operationKey);
        requireDelegationV2(p.cancellation === "none" && p.rounds.every(r => r.returned) && p.continuations.every(r => r.receipt)
          && p.grants.renewals < (p.spec.policy.maxRenewals ?? 0), "rounds_renewal_admission");
        requireDelegationV2(same(e.previous, p.grants.authority) && c.authority.id === p.spec.rootAuthorityRef.id
          && c.authority.authority_epoch === e.previous.authority_epoch + 1 && e.envelopes.length === p.spec.seats.length, "rounds_renewal_lineage");
        for (const [i, binding] of e.envelopes.entries()) requireDelegationV2(binding.seatId === p.spec.seats[i].seatId
          && binding.envelope.id === p.spec.seats[i].envelope.id && binding.envelope.generation === p.spec.seats[i].envelope.generation, "rounds_renewal_membership");
        p.grants = { authority: c.authority, envelopes: e.envelopes, renewals: p.grants.renewals + 1 };
      } else if (e.kind === "sync_prepared") {
        delegationRecordV2(e, ["revision", "kind", "operationKey", "prepared"]); validatePreparedRoundsSync(e.prepared);
        const pending = p.continuations.find(r => r.command.operationKey === e.operationKey);
        requireDelegationV2(pending?.command.kind === "sync" && !pending.prepared && !pending.receipt
          && e.prepared.operationKey === e.operationKey && e.prepared.groupId === p.spec.groupId
          && e.prepared.seatId === pending.command.seatId && e.prepared.receipt.contentDigest === pending.command.contextRef.digest
          && e.prepared.flowHead === pending.command.flowHead && e.prepared.recipient.authority.id === p.spec.rootAuthorityRef.id
          && e.prepared.receipt.envelopeId === p.spec.seats.find(s => s.seatId === e.prepared.seatId)!.envelope.id, "rounds_prepared_sync_identity");
        pending.prepared = e.prepared;
      } else if (e.kind === "cancel_finalized") {
        delegationRecordV2(e, ["revision", "kind", "command", "authorization", "reference"]);
        const c = finalizeCancelCommand(e.command); delegationReferenceV2(e.authorization); delegationReferenceV2(e.reference);
        requireDelegationV2(!keys.has(c.operationKey) && c.expectedRevision === index && c.groupId === p.spec.groupId
          && same(c.controller, p.spec.controller) && p.cancellation === "pending"
          && journal.events.slice(0, index).some(prior => prior.kind === "command" && prior.command.kind === "cancel" && prior.command.operationKey === c.cancelOperationKey), "rounds_cancel_identity");
        keys.add(c.operationKey); p.cancellation = "requested";
      } else if (e.kind === "sync_finalized") {
        delegationRecordV2(e, ["revision", "kind", "command", "authorization", "reference"]); delegationReferenceV2(e.authorization); delegationReferenceV2(e.reference);
        const c = finalizeCommand(e.command); requireDelegationV2(!keys.has(c.operationKey) && c.expectedRevision === index
          && c.groupId === p.spec.groupId && same(c.controller, p.spec.controller), "rounds_operation"); keys.add(c.operationKey);
        const pending = p.continuations.find(r => r.command.operationKey === c.syncOperationKey);
        requireDelegationV2(pending?.command.kind === "sync" && pending.prepared && !pending.receipt
          && preparedRoundsSyncDigest(pending.prepared) === c.preparedDigest, "rounds_prepared_sync_identity");
        pending.receipt = { reference: e.reference, flowHead: pending.command.flowHead, transitionRef: null,
          acknowledged: pending.prepared.receipt.status === "acknowledged" && pending.prepared.receipt.reason === "exact_ack" };
      } else if (e.kind === "continued") {
        delegationRecordV2(e, ["revision", "kind", "operationKey", "receipt"]);
        delegationRecordV2(e.receipt, ["reference", "flowHead", "transitionRef", "acknowledged"]);
        delegationReferenceV2(e.receipt.reference); hex(e.receipt.flowHead);
        if (e.receipt.transitionRef !== null) hex(e.receipt.transitionRef);
        const pending = p.continuations.find(r => r.command.operationKey === e.operationKey);
        requireDelegationV2(pending && !pending.receipt && typeof e.receipt.acknowledged === "boolean", "rounds_continuation_identity");
        requireDelegationV2((pending.command.kind === "sync") === (e.receipt.transitionRef === null), "rounds_continuation_receipt");
        pending.receipt = e.receipt;
      } else if (e.kind === "flow_not_admitted") {
        delegationRecordV2(e, ["revision", "kind", "operationKey", "seatId", "reason", "runHead"]); hex(e.runHead);
        const round = p.rounds.findIndex(r => r.operationKey === e.operationKey) + 1;
        const action = p.flowActions.find(a => a.round === round && a.seatId === e.seatId);
        requireDelegationV2(e.reason === "resource_conflict" && action && !action.claim && !action.nonadmission
          && !p.rounds[round - 1].returned, "rounds_nonadmission_identity");
        action.nonadmission = { reason: e.reason, runHead: e.runHead };
        if (action.mode === "invoke") p.attempts.find(a => a.invocationId === action.invocationId)!.admission = "not_admitted";
      } else if (e.kind === "flow_claimed" || e.kind === "flow_evaluated") {
        const round = p.rounds.findIndex(r => r.operationKey === e.operationKey) + 1;
        const action = p.flowActions.find(a => a.round === round && a.seatId === e.seatId);
        requireDelegationV2(action && !p.rounds[round - 1].returned, "rounds_flow_action");
        if (e.kind === "flow_claimed") {
          delegationRecordV2(e, ["revision", "kind", "operationKey", "seatId", "claim", "transitionCount", ...(e.recipient ? ["recipient"] : [])]);
          delegationIntegerV2(e.transitionCount); requireDelegationV2(!action.claim && !action.nonadmission && p.cancellation === "none", "rounds_flow_claim_conflict");
          const topology = p.spec.topology, claim = e.claim; historicalClaim(claim);
          requireDelegationV2(topology.kind === "flow" && claim.run_id === topology.runId && same(claim.definition, topology.definition)
            && claim.step_id === p.spec.seats.find(s => s.seatId === e.seatId)!.stepId && same(claim.actor, topology.actor), "rounds_flow_claim_binding");
          delegationIdV2(claim.claim_id); delegationIdV2(claim.liveness_id);
          requireDelegationV2(!p.flowActions.some(a => a.claim?.value.claim_id === claim.claim_id), "rounds_flow_claim_reused");
          if (e.recipient) { validateRecipientIdentity(e.recipient); action.recipient = e.recipient; }
          action.claim = { value: claim, transitionCount: e.transitionCount };
          const attempt = p.attempts.find(a => a.invocationId === action.invocationId)!;
          attempt.claimRefs!.push(claim.claim_id); if (action.mode === "invoke") { attempt.admission = "claimed"; if (e.recipient) attempt.recipient = e.recipient; }
        } else {
          delegationRecordV2(e, ["revision", "kind", "operationKey", "seatId", "claimId", "receipt"]);
          delegationRecordV2(e.receipt, ["reference", "settled", "runHead"]); delegationReferenceV2(e.receipt.reference); hex(e.receipt.runHead);
          requireDelegationV2(action.claim?.value.claim_id === e.claimId && !action.evaluation && typeof e.receipt.settled === "boolean", "rounds_flow_evaluation_identity");
          action.evaluation = e.receipt;
        }
      } else if (e.kind === "observed") {
        delegationRecordV2(e, ["revision", "kind", "invocationId", "reference"]); delegationReferenceV2(e.reference);
        const attempt = p.attempts.find(a => a.invocationId === e.invocationId);
        requireDelegationV2(attempt && !attempt.observation && !p.rounds[attempt.round - 1].returned, "rounds_observation_identity"); attempt.observation = e.reference;
      } else if (e.kind === "returned") {
        delegationRecordV2(e, ["revision", "kind", "operationKey"]);
        const round = p.rounds.find(r => r.operationKey === e.operationKey);
        requireDelegationV2(round && !round.returned, "rounds_return_identity"); round.returned = true;
      } else {
        delegationRecordV2(e, ["revision", "kind", "reference"]); delegationReferenceV2(e.reference);
        requireDelegationV2(e.kind === "cancel_requested" && p.cancellation === "pending", "rounds_cancel_identity"); p.cancellation = "requested";
      }
    }
    requireDelegationV2(index === 0 || Buffer.byteLength(canonicalJson(e)) <= ROUNDS_RECORD_BYTES, "rounds_record_full");
    p!.revision = index + 1;
  }
  return structuredClone(p!);
}
/** Worst-case room for ALL declared rounds, attempts, terminal proofs and cancellation. */
export function delegationRoundsCapacity(journal: DelegationRoundsJournal): { events: number; bytes: number } {
  const p = projectDelegationRounds(journal);
  const total = 1 + 2 * p.spec.policy.maxRounds + (p.spec.topology.kind === "flow" ? 4 : 2) * p.spec.policy.maxAttempts
    + 2 * (p.spec.policy.maxEvaluations ?? 0) + 2 * (p.spec.policy.maxRecoveries ?? 0) + 3 * (p.spec.policy.maxSyncs ?? 0) + (p.spec.policy.maxRenewals ?? 0) + 2;
  const events = total - journal.events.length;
  requireDelegationV2(events >= 0, "rounds_capacity");
  return { events, bytes: events * ROUNDS_RECORD_BYTES };
}

export function createDelegationRoundsController(input: {
  store: DelegationRoundsStore; authorityService: ReturnType<typeof createDelegationAuthorityService>;
  dispatchLedger: AuthorizationLedger; host: DelegationRoundsHost; cwd?: string;
}) {
  const { store, host, authorityService: service } = input;
  requireDelegationV2(host.accountingProtocol === undefined || host.accountingProtocol === "retained-tariff-v1", "rounds_accounting_protocol");
  async function authorize(action: Parameters<DelegationRoundsHost["authorize"]>[0]["action"], groupId: string, p: DelegationRoundsProjection | null, c: DelegationRoundsAuthorizationCommand | null = null) {
    const receipt = await host.authorize({ action, groupId, current: p && structuredClone(p), command: c && structuredClone(c) });
    requireDelegationV2(receipt, "rounds_host_authorization");
    const ref = reference(receipt), spec = p?.spec ?? (c?.kind === "create" ? c.spec : null);
    if (spec) {
      const ledger = await service.inspect(spec.rootAuthorityRef.id);
      requireDelegationV2(same(authorityLineageReference(ledger), spec.rootAuthorityRef), "rounds_root_mismatch");
      if (p && ["release", "execute", "sync", "reappraise", "authorizeRetry"].includes(action)) {
        requireDelegationV2(same(rootAuthorityReferenceV2(ledger.root), p.grants.authority), "rounds_grant_adoption_required");
        for (const binding of p.grants.envelopes) {
          const envelope = ledger.envelopes.find(e => e.envelope_id === binding.envelope.id);
          requireDelegationV2(envelope && delegationEnvelopeDigestV2(envelope) === binding.envelope.digest, "rounds_effective_grant_conflict");
        }
      }
    }
    return ref;
  }
  async function get(groupId: string, action: "get" | "events" = "get") {
    delegationIdV2(groupId); await authorize(action, groupId, null);
    return store.transact(groupId, async journal => {
      const p = journal && projectDelegationRounds(journal); await authorize(action, groupId, p);
      requireDelegationV2(journal && p, "rounds_missing"); return { journal, result: { projection: p, journal } };
    });
  }
  async function begin(c: DelegationRoundsCommand) {
    await authorize(c.kind, c.groupId, null, c);
    return store.transact(c.groupId, async journal => {
      const p = journal && projectDelegationRounds(journal);
      const old = journal?.events.find(e => e.kind === "command" && e.command.operationKey === c.operationKey);
      if (old?.kind === "command") {
        await authorize("replay", c.groupId, p, c);
        requireDelegationV2(same(old.command, c), "rounds_intent_conflict");
        return { journal: journal!, result: { replayed: true, projection: p! } };
      }
      let authorization = await authorize(c.kind, c.groupId, p, c);
      requireDelegationV2(c.expectedRevision === (p?.revision ?? 0), "rounds_revision_conflict");
      const spec = p?.spec ?? (c.kind === "create" ? c.spec : null);
      requireDelegationV2(spec, "rounds_missing");
      const ledger = await service.inspect(spec.rootAuthorityRef.id);
      if (c.kind === "create") {
        requireDelegationV2(!p && !ledger.cancelled && same(spec.policy.reference, ledger.root.revisions.policy), "rounds_policy_inactive");
        requireDelegationV2(spec.policy.maxAttempts <= ledger.root.budget.max_attempts && spec.policy.maxConcurrent <= ledger.root.budget.max_concurrent_children, "rounds_root_capacity");
        for (const seat of spec.seats) {
          const { envelope } = await service.admitEffect(spec.rootAuthorityRef.id, seat.envelope.id, seat.effect);
          requireDelegationV2(envelope.generation === seat.envelope.generation && delegationEnvelopeDigestV2(envelope) === seat.envelope.digest, "rounds_envelope_mismatch");
          if (spec.topology.kind === "independent-advisory") requireDelegationV2(envelope.execution_binding.flow_binding.status === "unbound" && envelope.execution_authority.posture === "report-only" && envelope.execution_authority.mutable_resources.length === 0, "rounds_independent_advisory_required");
          else requireDelegationV2(host.flow, "rounds_flow_host_required");
          requireDelegationV2(seat.allocation.inputTokens <= envelope.budget.max_input_tokens && seat.allocation.outputTokens <= envelope.budget.max_output_tokens && seat.allocation.costMicros <= envelope.budget.max_cost_micros, "rounds_allocation");
        }
      } else if (c.kind === "release") {
        requireDelegationV2(p, "rounds_missing");
        requireDelegationV2(!ledger.cancelled, "rounds_authority_cancelled");
        if (spec.topology.kind === "flow") await validateFlowRoundRelease({ ...p!, spec: effectiveRoundsSpec(p!) }, c, input.cwd);
        for (const selection of c.seats) if (selection.syncKey) await assertSyncedRecipient(p!, selection.syncKey, host, service);
        for (const selection of c.seats) {
          const prior = p!.attempts.filter(a => a.seatId === selection.seatId).at(-1);
          if (selection.mode !== "evaluate" && selection.nonadmissionOf !== undefined) {
            requireDelegationV2(prior?.admission === "not_admitted" && prior.invocationId === selection.nonadmissionOf
              && !ledger.invocations.some(i => i.invocationId === prior.invocationId), "rounds_definite_nonadmission_required");
          } else if (prior) {
            const seat = spec.seats.find(s => s.seatId === selection.seatId)!;
            const invocation = ledger.invocations.find(i => i.invocationId === prior.invocationId && i.envelopeId === seat.envelope.id);
            requireDelegationV2(invocation?.terminal && invocation.usage !== null, "rounds_previous_accounting_required");
          }
        }
      } else if (c.kind === "reappraise" || c.kind === "authorizeRetry" || c.kind === "sync") {
        requireDelegationV2(p && !ledger.cancelled && host.retainContinuation && (c.kind === "sync" || host.flow?.withContinuationMutation), "rounds_continuation_host_required");
        await validateRoundsContinuation(p, c, input.cwd);
        if (c.kind === "sync") {
          const seat = spec.seats.find(s => s.seatId === c.seatId); requireDelegationV2(seat && host.context, "rounds_sync_host_required");
          const { envelope } = await service.admitEffect(spec.rootAuthorityRef.id, seat.envelope.id, "context-sync");
          requireDelegationV2(envelope.execution_authority.allowed_tools.length === 0, "rounds_sync_no_tools_required");
          const latest = ledger.invocations.filter(i => i.envelopeId === seat.envelope.id).at(-1);
          requireDelegationV2(!latest || latest.terminal && latest.usage !== null, "rounds_sync_previous_usage_unknown");
          const prior = p.attempts.filter(a => a.seatId === seat.seatId).at(-1);
          requireDelegationV2(!prior || prior.admission === "not_admitted" || prior.terminal, "rounds_sync_previous_terminal_required");
        }
      } else if (c.kind === "terminal") {
        const attempt = p!.attempts.find(a => a.invocationId === c.invocationId), seat = spec.seats.find(s => s.seatId === attempt?.seatId);
        const invocation = ledger.invocations.find(i => i.invocationId === c.invocationId && i.envelopeId === seat?.envelope.id);
        requireDelegationV2(attempt && invocation?.terminal && invocation.usage !== null, "rounds_terminal_accounting_required");
        const proof = await host.confirmTerminal(structuredClone(spec), structuredClone(attempt), structuredClone(invocation));
        requireDelegationV2(proof, "rounds_physical_terminal_required"); authorization = reference(proof);
      }
      if (c.kind === "create" && spec.topology.kind === "flow") await validateFlowRoundCreation(spec, service, input.cwd);
      await authorize(c.kind, c.groupId, p, c);
      const next = journal ?? { schemaVersion: "1.0" as const, groupId: c.groupId, events: [] };
      next.events.push({ revision: next.events.length + 1, kind: "command", command: c, authorization });
      return { journal: next, result: { replayed: false, projection: projectDelegationRounds(next) } };
    });
  }
  async function append(groupId: string, body: DelegationRoundsEventBody) {
    return store.transact(groupId, async journal => {
      requireDelegationV2(journal, "rounds_missing"); await authorize("record", groupId, projectDelegationRounds(journal));
      journal.events.push({ ...body, revision: journal.events.length + 1 });
      return { journal, result: projectDelegationRounds(journal) };
    });
  }
  async function continueCommand(value: unknown, kind: "reappraise" | "authorizeRetry" | "sync") {
    const c = command(value); requireDelegationV2(c.kind === kind, "rounds_command");
    requireDelegationV2(c.kind === "reappraise" || c.kind === "authorizeRetry" || c.kind === "sync", "rounds_command");
    const admitted = await begin(c); if (admitted.replayed) return admitted;
    const spec = effectiveRoundsSpec(admitted.projection);
    await runRoundsContinuation({ ...input, spec, command: c, projection: { ...admitted.projection, spec },
      authorize: async () => { const p = (await get(c.groupId)).projection; await authorize(c.kind, c.groupId, p, c); requireDelegationV2(p.cancellation === "none", "rounds_cancelled"); },
      append: body => append(c.groupId, body),
      mutate: body => store.transact(c.groupId, async journal => {
        requireDelegationV2(journal, "rounds_missing"); const p = projectDelegationRounds(journal);
        await authorize(c.kind, c.groupId, p, c); requireDelegationV2(p.cancellation === "none", "rounds_cancelled");
        return { journal, result: await host.flow!.withContinuationMutation!(structuredClone(spec), structuredClone(c), body) };
      }),
    });
    return { replayed: false, projection: (await get(c.groupId)).projection };
  }
  return {
    async adoptRenewal(value: unknown) {
      const c = adoptCommand(value); await authorize("adoptRenewal", c.groupId, null, c);
      return store.transact(c.groupId, async journal => {
        requireDelegationV2(journal, "rounds_missing"); const p = projectDelegationRounds(journal);
        const authorization = await authorize("adoptRenewal", c.groupId, p, c);
        const prior = journal.events.find(e => e.kind === "grant_adopted" && e.command.operationKey === c.operationKey);
        if (prior?.kind === "grant_adopted") {
          await authorize("replay", c.groupId, p, c); requireDelegationV2(same(prior.command, c), "rounds_intent_conflict"); return { journal, result: { replayed: true, projection: p } };
        }
        const ledger = await service.inspect(p.spec.rootAuthorityRef.id);
        requireDelegationV2("epochs" in ledger && Array.isArray(ledger.epochs), "rounds_versioned_authority_required");
        const epoch = ledger.epochs.at(-1) as AuthorityEpochV3;
        requireDelegationV2(c.expectedRevision === p.revision && epoch.renewal?.command.operationKey === c.renewalOperationKey
          && same(rootAuthorityReferenceV2(epoch.root), c.authority) && same(epoch.renewal.command.previousAuthority, p.grants.authority), "rounds_service_renewal_required");
        const envelopes = p.spec.seats.map(seat => {
          const envelope = epoch.envelopes.find(e => e.envelope_id === seat.envelope.id); requireDelegationV2(envelope, "rounds_renewal_membership");
          return { seatId: seat.seatId, envelope: { id: envelope.envelope_id, generation: envelope.generation, digest: delegationEnvelopeDigestV2(envelope) } };
        });
        journal.events.push({ kind: "grant_adopted", revision: journal.events.length + 1, command: c, authorization,
          hostReceipt: epoch.renewal.authenticatedReceipt, previous: p.grants.authority, envelopes });
        return { journal, result: { replayed: false, projection: projectDelegationRounds(journal) } };
      });
    },
    async finalizeCancel(value: unknown) {
      const c = finalizeCancelCommand(value); await authorize("finalizeCancel", c.groupId, null, c);
      return store.transact(c.groupId, async journal => {
        requireDelegationV2(journal, "rounds_missing"); const p = projectDelegationRounds(journal);
        const authorization = await authorize("finalizeCancel", c.groupId, p, c);
        const prior = journal.events.find(e => e.kind === "cancel_finalized" && e.command.operationKey === c.operationKey);
        if (prior?.kind === "cancel_finalized") {
          await authorize("replay", c.groupId, p, c); requireDelegationV2(same(prior.command, c), "rounds_intent_conflict");
          return { journal, result: { replayed: true, projection: p } };
        }
        requireDelegationV2(c.expectedRevision === p.revision && same(c.controller, p.spec.controller), "rounds_revision_conflict");
        const original = journal.events.find(e => e.kind === "command" && e.command.kind === "cancel" && e.command.operationKey === c.cancelOperationKey);
        requireDelegationV2(p.cancellation === "pending" && original?.kind === "command" && original.command.kind === "cancel", "rounds_cancel_identity");
        requireDelegationV2(host.confirmCancellation, "rounds_cancel_confirmation_required");
        await service.cancel(p.spec.rootAuthorityRef.id);
        const receipt = await host.confirmCancellation(structuredClone(p.spec), structuredClone(original.command));
        requireDelegationV2(receipt, "rounds_cancel_confirmation_required"); delegationReferenceV2(receipt);
        await authorize("finalizeCancel", c.groupId, p, c);
        journal.events.push({ revision: journal.events.length + 1, kind: "cancel_finalized", command: c, authorization, reference: receipt });
        return { journal, result: { replayed: false, projection: projectDelegationRounds(journal) } };
      });
    },
    async finalizeSync(value: unknown) {
      const c = finalizeCommand(value); await authorize("finalizeSync", c.groupId, null, c);
      return store.transact(c.groupId, async journal => {
        requireDelegationV2(journal, "rounds_missing"); const p = projectDelegationRounds(journal);
        await authorize("finalizeSync", c.groupId, p, c);
        const prior = journal.events.find(e => e.kind === "sync_finalized" && e.command.operationKey === c.operationKey);
        if (prior?.kind === "sync_finalized") {
          await authorize("replay", c.groupId, p, c); requireDelegationV2(same(prior.command, c), "rounds_intent_conflict"); return { journal, result: { replayed: true, projection: p } };
        }
        requireDelegationV2(c.expectedRevision === p.revision && same(c.controller, p.spec.controller), "rounds_revision_conflict");
        const authorization = await authorize("finalizeSync", c.groupId, p, c);
        const reference = await finalizeRoundsSync({ projection: p, command: c, host, service });
        journal.events.push({ revision: journal.events.length + 1, kind: "sync_finalized", command: c, authorization, reference });
        return { journal, result: { replayed: false, projection: projectDelegationRounds(journal) } };
      });
    },
    reappraise: (value: unknown) => continueCommand(value, "reappraise"),
    authorizeRetry: (value: unknown) => continueCommand(value, "authorizeRetry"),
    sync: (value: unknown) => continueCommand(value, "sync"),
    async create(value: unknown) { const c = command(value); requireDelegationV2(c.kind === "create", "rounds_command"); return begin(c); },
    async get(groupId: string) { return (await get(groupId)).projection; },
    async events(groupId: string) { return (await get(groupId, "events")).journal.events; },
    async recordTerminal(value: unknown) { const c = command(value); requireDelegationV2(c.kind === "terminal", "rounds_command"); return begin(c); },
    async cancel(value: unknown) {
      const c = command(value); requireDelegationV2(c.kind === "cancel", "rounds_command");
      const admitted = await begin(c); if (admitted.replayed) return admitted;
      await service.cancel(admitted.projection.spec.rootAuthorityRef.id);
      const receipt = reference(await host.requestDescendantCancellation(structuredClone(admitted.projection.spec)));
      return { replayed: false, projection: await append(c.groupId, { kind: "cancel_requested", reference: receipt }) };
    },
    /** One explicit host-authorized checkpoint. Reconnect/replay observes; it never resumes effects. */
    async release(value: unknown) {
      const c = command(value); requireDelegationV2(c.kind === "release", "rounds_command");
      const admitted = await begin(c); if (admitted.replayed) return admitted;
      const spec = effectiveRoundsSpec(admitted.projection);
      if (spec.topology.kind === "flow") {
        await runDelegationFlowRound({ ...input, command: c, projection: { ...admitted.projection, spec },
          get: async () => (await get(c.groupId)).projection,
          authorize: async action => { const p = (await get(c.groupId)).projection; await authorize(action, c.groupId, p, c); requireDelegationV2(p.cancellation === "none", "rounds_cancelled"); },
          append: body => append(c.groupId, body),
          withAdmission: (stepId, body) => store.transact(c.groupId, async journal => {
            requireDelegationV2(journal, "rounds_missing"); const p = projectDelegationRounds(journal);
            await authorize("execute", c.groupId, p, c); requireDelegationV2(p.cancellation === "none", "rounds_cancelled");
            const seat = spec.seats.find(s => s.stepId === stepId);
            requireDelegationV2(seat && c.seats.some(s => s.seatId === seat.seatId), "rounds_unreleased_step");
            await service.admitEffect(spec.rootAuthorityRef.id, seat.envelope.id, seat.effect);
            return { journal, result: await body() };
          }),
        });
        return { replayed: false, projection: await append(c.groupId, { kind: "returned", operationKey: c.operationKey }) };
      }
      const attempts = admitted.projection.attempts.filter(a => a.round === admitted.projection.rounds.length);
      let cursor = 0;
      const workers = Array.from({ length: Math.min(attempts.length, spec.policy.maxConcurrent) }, async () => {
        while (cursor < attempts.length) {
          const attempt = attempts[cursor++], seat = spec.seats.find(s => s.seatId === attempt.seatId)!;
          let observation: { outcome: DelegationRoundsOutcome } | { error: unknown };
          try {
            const current = (await get(c.groupId)).projection;
            await authorize("execute", c.groupId, current, c); requireDelegationV2(current.cancellation === "none", "rounds_cancelled");
            const { envelope } = await service.admitEffect(spec.rootAuthorityRef.id, seat.envelope.id, seat.effect);
            requireDelegationV2(envelope.generation === seat.envelope.generation && delegationEnvelopeDigestV2(envelope) === seat.envelope.digest, "rounds_envelope_mismatch");
            const request = await host.prepareRequest(structuredClone(spec), structuredClone(seat), structuredClone(attempt), envelope);
            const physical = host.executionHost(structuredClone(spec));
            const outcome = await executeRoundsDelegation({ accountingProtocol: host.accountingProtocol, service, dispatchLedger: input.dispatchLedger, authorityId: spec.rootAuthorityRef.id,
              envelopeId: seat.envelope.id, invocationId: attempt.invocationId, effect: seat.effect, allocation: seat.allocation, request,
              host: {
                resolveRuntime: e => physical.resolveRuntime(e),
                retainResult: (r, e, id) => physical.retainResult(r, e, id),
                retainFailure: (error, e, id) => physical.retainFailure(error, e, id),
                async invokeFenced(envelope, id, launch) {
                const current = (await get(c.groupId)).projection;
                await authorize("execute", c.groupId, current, c); requireDelegationV2(current.cancellation === "none", "rounds_cancelled");
                // The host fence must keep custody/cancellation current through the actual launch.
                return physical.invokeFenced(envelope, id, launch);
              } },
            });
            observation = { outcome };
          } catch (error) { observation = { error }; }
          const ref = reference(await host.retainObservation(structuredClone(spec), structuredClone(attempt), observation));
          await append(c.groupId, { kind: "observed", invocationId: attempt.invocationId, reference: ref });
        }
      });
      const settled = await Promise.allSettled(workers);
      const failures = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(r => r.reason), "Round retention unknown; admission remains held");
      return { replayed: false, projection: await append(c.groupId, { kind: "returned", operationKey: c.operationKey }) };
    },
  };
}

export { preparedRoundsSyncDigest } from "./delegation-rounds-continuation.js";
export type { PreparedRoundsSync } from "./delegation-rounds-continuation.js";
export type { DelegationRecipientIdentity, ResolvedDelegationRecipient } from "./delegation-rounds-recipient.js";

/** Effective host view only; the journal's original spec is never rewritten. */
export function effectiveRoundsSpec(p: DelegationRoundsProjection): DelegationRoundsSpec {
  return { ...structuredClone(p.spec), rootAuthorityRef: structuredClone(p.grants.authority),
    seats: p.spec.seats.map(seat => ({ ...structuredClone(seat), envelope: structuredClone(p.grants.envelopes.find(e => e.seatId === seat.seatId)!.envelope) })) };
}
