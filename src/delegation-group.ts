import type { FlowDurableStepClaim, FlowReadyStepFrontier } from "@kontourai/flow";
import { canonicalJson } from "@kontourai/relay";
import { assertDelegationEnvelopeActiveAt, type DelegationEnvelope } from "./delegation-envelope.js";
import {
  DELEGATION_GROUP_MAX_EVENTS,
  DelegationGroupError,
  applyGroupRequest,
  groupDigest,
  projectDelegationGroup,
  validateDelegationGroupLedger,
  validateGroupRequest,
  type DelegationGroupLedger,
  type DelegationGroupProjection,
  type DelegationGroupSpec,
  type GroupConfirmation,
  type GroupEnvelopeReference,
  type GroupOutcome,
  type GroupReference,
  type GroupRequest,
  type GroupSeat,
} from "./delegation-group-contract.js";

/** Serialize the callback, bind each envelope id exclusively to one group in this store, and durably commit before returning. */
export interface DelegationGroupStore {
  read(groupId: string): Promise<DelegationGroupLedger | null>;
  transact<T>(groupId: string, body: (ledger: DelegationGroupLedger | null) => Promise<{
    ledger: DelegationGroupLedger;
    result: T;
  }>): Promise<T>;
}
export type GroupReadinessReceipt =
  | { kind: "independent"; reference: GroupReference }
  | { kind: "flow_claim"; reference: GroupReference; claim: FlowDurableStepClaim; frontier: FlowReadyStepFrontier };
export type AuthorizedGroupEnvelope = { envelope: DelegationEnvelope; authorization: GroupReference };

/** Trusted host boundary. Receipts attest this exact request and current external state, not caller metadata. */
export interface DelegationGroupHost {
  now(): string;
  resolveAuthorizedEnvelope(identity: GroupEnvelopeReference, groupId: string): Promise<AuthorizedGroupEnvelope | null>;
  confirmController(request: GroupRequest, current: DelegationGroupProjection | null): Promise<GroupReference | null>;
  confirmReadiness?(request: GroupRequest, current: DelegationGroupProjection, seat: GroupSeat): Promise<GroupReadinessReceipt | null>;
  confirmBudgetEnforcement?(request: GroupRequest, current: DelegationGroupProjection): Promise<GroupReference | null>;
  confirmEvidence?(request: GroupRequest, current: DelegationGroupProjection): Promise<GroupReference | null>;
}
export type GroupOperationResult = { replayed: boolean; outcome: GroupOutcome; projection: DelegationGroupProjection };

function requireCapability<T>(value: T | null | undefined, code: string): T {
  if (value === null || value === undefined) throw new DelegationGroupError(code);
  return value;
}
function same(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }

export function createDelegationGroupService(store: DelegationGroupStore, host: DelegationGroupHost) {
  async function authorize(identity: GroupEnvelopeReference, now: string, groupId: string): Promise<AuthorizedGroupEnvelope> {
    const resolved = requireCapability(await host.resolveAuthorizedEnvelope(structuredClone(identity), groupId), "envelope_authorization_unsupported");
    const envelope = assertDelegationEnvelopeActiveAt(resolved.envelope, now);
    if (envelope.envelope_id !== identity.envelope_id || envelope.generation !== identity.generation || groupDigest(envelope) !== identity.digest) {
      throw new DelegationGroupError("envelope_identity_mismatch");
    }
    if (envelope.authority.posture !== "report-only" || envelope.authority.mutable_resources.length !== 0) {
      throw new DelegationGroupError("writer_envelope_unsupported");
    }
    return { envelope, authorization: resolved.authorization };
  }
  function checkBinding(envelope: DelegationEnvelope, spec: DelegationGroupSpec, seat?: GroupSeat): void {
    if (!same(envelope.source, seat?.source ?? spec.source)) throw new DelegationGroupError("envelope_source_mismatch");
    if (envelope.revisions.policy_revision !== spec.policy.revision) throw new DelegationGroupError("envelope_policy_mismatch");
    const topology = spec.topology;
    if (topology.kind === "independent") {
      if (envelope.flow_binding.status !== "unbound") throw new DelegationGroupError("envelope_flow_mismatch");
    } else if (envelope.flow_binding.status !== "bound" || envelope.flow_binding.flow_run_id !== topology.run_id
      || (seat?.work.kind === "flow" && envelope.flow_binding.flow_step_id !== seat.work.step_id)) {
      throw new DelegationGroupError("envelope_flow_mismatch");
    }
  }
  async function confirmations(request: GroupRequest, current: DelegationGroupProjection | null): Promise<GroupConfirmation[]> {
    const receipts: GroupConfirmation[] = [];
    const activeEnvelopes: DelegationEnvelope[] = [];
    let claimExpiry: string | undefined;
    const action = request.action;
    if (action.kind === "create") {
      const now = host.now();
      const parent = await authorize(action.spec.parent_envelope, now, request.group_id);
      checkBinding(parent.envelope, action.spec);
      activeEnvelopes.push(parent.envelope);
      const policy = action.spec.policy;
      if (policy.max_attempts > parent.envelope.budget.max_attempts || policy.max_concurrent > parent.envelope.budget.max_concurrent_children
        || policy.ceilings.input_tokens > parent.envelope.budget.max_input_tokens || policy.ceilings.output_tokens > parent.envelope.budget.max_output_tokens
        || policy.ceilings.cost_micros > parent.envelope.budget.max_cost_micros) throw new DelegationGroupError("group_exceeds_parent_budget");
      receipts.push({ kind: "authorization", reference: parent.authorization });
      for (const seat of action.spec.seats) {
        const member = await authorize(seat.envelope, now, request.group_id);
        checkBinding(member.envelope, action.spec, seat);
        activeEnvelopes.push(member.envelope);
        receipts.push({ kind: "authorization", reference: member.authorization });
      }
    }
    if (action.kind === "reserve") {
      const state = requireCapability(current, "group_missing");
      const seat = requireCapability(state.spec.seats.find((s) => s.seat_id === action.seat_id), "seat_missing");
      const now = host.now();
      const parent = await authorize(state.spec.parent_envelope, now, request.group_id);
      const member = await authorize(seat.envelope, now, request.group_id);
      checkBinding(parent.envelope, state.spec); checkBinding(member.envelope, state.spec, seat);
      activeEnvelopes.push(parent.envelope, member.envelope);
      const seatAttempts = state.attempts.filter((a) => a.seat_id === seat.seat_id);
      const envelopeBudget = member.envelope.budget;
      if (seatAttempts.length >= envelopeBudget.max_attempts || envelopeBudget.max_concurrent_children < 1) {
        throw new DelegationGroupError("member_attempt_ceiling");
      }
      for (const [key, ceiling] of [
        ["input_tokens", envelopeBudget.max_input_tokens], ["output_tokens", envelopeBudget.max_output_tokens], ["cost_micros", envelopeBudget.max_cost_micros],
      ] as const) {
        const consumed = seatAttempts.reduce((sum, a) => sum + (a.usage ?? a.allocation)[key], 0);
        if (consumed + action.allocation[key] > ceiling) throw new DelegationGroupError("member_budget_ceiling");
      }
      receipts.push({ kind: "authorization", reference: parent.authorization }, { kind: "authorization", reference: member.authorization });
      const ready = requireCapability(await host.confirmReadiness?.(structuredClone(request), structuredClone(state), structuredClone(seat)), "claimed_readiness_unsupported");
      if (state.spec.topology.kind === "flow") {
        if (ready.kind !== "flow_claim" || seat.work.kind !== "flow") throw new DelegationGroupError("flow_claim_required");
        const { claim, frontier } = ready;
        claimExpiry = claim.expires_at;
        if (claim.schema_version !== "1" || frontier.schema_version !== "1" || claim.run_id !== state.spec.topology.run_id
          || frontier.run_id !== claim.run_id || claim.definition.digest !== state.spec.topology.definition_digest
          || !same(claim.definition, frontier.definition) || claim.claim_base.head !== frontier.run_head
          || claim.claim_base.step_id !== claim.step_id || claim.step_id !== seat.work.step_id
          || claim.actor.key !== member.envelope.actor_id || claim.mutable_resources.length !== 0
          || !frontier.ready_steps.some((s) => s.step_id === claim.step_id && s.mutable_resources.length === 0)
          || !Number.isFinite(Date.parse(claim.expires_at)) || Date.parse(claim.expires_at) <= Date.parse(host.now())) {
          throw new DelegationGroupError("flow_claim_mismatch");
        }
      } else if (ready.kind !== "independent") throw new DelegationGroupError("independent_readiness_required");
      receipts.push({ kind: "readiness", reference: ready.reference });
      receipts.push({ kind: "budget_enforcement", reference: requireCapability(await host.confirmBudgetEnforcement?.(structuredClone(request), structuredClone(state)), "budget_enforcement_unsupported") });
    }
    if (["invoked", "mark_unknown", "terminal", "account", "cancellation_confirmed"].includes(action.kind)) {
      const state = requireCapability(current, "group_missing");
      const reference = requireCapability(await host.confirmEvidence?.(structuredClone(request), structuredClone(state)), "evidence_confirmation_unsupported");
      const kind = action.kind === "invoked" || action.kind === "mark_unknown" ? "invocation" : action.kind === "account" ? "accounting" : action.kind === "cancellation_confirmed" ? "cancellation" : "terminal";
      receipts.push({ kind, reference });
    }
    receipts.push({ kind: "controller", reference: requireCapability(await host.confirmController(structuredClone(request), current && structuredClone(current)), "controller_fence_unsupported") });
    if (activeEnvelopes.length > 0) {
      const commitTime = host.now();
      activeEnvelopes.forEach((envelope) => assertDelegationEnvelopeActiveAt(envelope, commitTime));
      if (claimExpiry && Date.parse(claimExpiry) <= Date.parse(commitTime)) throw new DelegationGroupError("flow_claim_expired");
    }
    return receipts;
  }
  return {
    async read(groupId: string): Promise<DelegationGroupProjection | null> {
      const ledger = await store.read(groupId);
      return ledger ? projectDelegationGroup(ledger) : null;
    },
    async operate(value: unknown): Promise<GroupOperationResult> {
      const request = validateGroupRequest(value);
      return store.transact<GroupOperationResult>(request.group_id, async (raw) => {
        const ledger = raw ? validateDelegationGroupLedger(raw) : { schema_version: "1.0" as const, group_id: request.group_id, events: [] };
        const previousIndex = ledger.events.findIndex((e) => e.request.operation_id === request.operation_id);
        if (previousIndex >= 0) {
          const previous = ledger.events[previousIndex];
          if (previous.request.request_digest !== request.request_digest) throw new DelegationGroupError("operation_intent_conflict");
          return { ledger, result: { replayed: true, outcome: previous.outcome,
            projection: projectDelegationGroup({ ...ledger, events: ledger.events.slice(0, previousIndex + 1) }) } };
        }
        if (ledger.events.length >= DELEGATION_GROUP_MAX_EVENTS) throw new DelegationGroupError("ledger_full");
        const current = ledger.events.length ? projectDelegationGroup(ledger) : null;
        if (request.expected_revision !== (current?.revision ?? 0)) throw new DelegationGroupError("revision_conflict");
        if (current && !same(request.fence, current.fence)) throw new DelegationGroupError("controller_fence_conflict");
        const confirmed = await confirmations(request, current);
        const result = applyGroupRequest(current, request, confirmed);
        ledger.events.push({ request, confirmations: confirmed, outcome: result.outcome });
        validateDelegationGroupLedger(ledger);
        return { ledger, result: { replayed: false, outcome: result.outcome, projection: result.projection } };
      });
    },
  };
}
