import { createHash } from "node:crypto";
import { canonicalJson, type ModelInvocationRequest } from "@kontourai/relay";
import type { AuthorizationLedger } from "@kontourai/dispatch";
import type { FlowDurableStepClaim, FlowStepClaimActor } from "@kontourai/flow";
import { createDelegationAuthorityService, DelegationAdmissionError, type DelegationInvocationAmounts } from "./delegation-authority-service.js";
import type { DelegationEnvelopeV2 } from "./delegation-envelope-v2.js";
import { executeAuthorizedDelegation, type DelegationExecutionHost } from "./delegation-execution.js";
import { orchestrateFlowMultiCursor, type FlowScheduleEvent } from "./multi-cursor-flow-orchestrator.js";
import type { DelegationDispatchOutcome } from "./delegation-dispatch.js";

export interface DelegationFlowSeat {
  stepId: string;
  envelopeId: string;
  effect: string;
  allocation: DelegationInvocationAmounts;
}
export interface DelegationFlowExecutionHost extends DelegationExecutionHost {
  /** Durably records the lifecycle event before scheduling can proceed. */
  recordScheduleEvent(event: FlowScheduleEvent): Promise<void>;
  /** Authenticates current Flow claim/assignment against this exact execution envelope. */
  confirmClaim(claim: FlowDurableStepClaim, envelope: DelegationEnvelopeV2): Promise<boolean>;
  prepareRequest(claim: FlowDurableStepClaim, envelope: DelegationEnvelopeV2): Promise<ModelInvocationRequest>;
  /** Retains raw member outcome; only Flow's existing authorized evidence path may affect a gate. */
  recordMemberOutcome(claim: FlowDurableStepClaim, envelope: DelegationEnvelopeV2, outcome: DelegationDispatchOutcome): Promise<void>;
}

/** Flow owns readiness, durable claims, dependencies and evaluation; this adds no DAG reducer. */
export async function orchestrateDelegationFlow(input: {
  authorityId: string;
  service: ReturnType<typeof createDelegationAuthorityService>;
  dispatchLedger: AuthorizationLedger;
  host: DelegationFlowExecutionHost;
  runId: string;
  actor: FlowStepClaimActor;
  seats: readonly DelegationFlowSeat[];
  cwd?: string;
  maxConcurrent: number;
  signal?: AbortSignal;
}) {
  const seats = structuredClone(input.seats);
  if (seats.length < 1 || seats.length > 64 || new Set(seats.map((s) => s.stepId)).size !== seats.length
    || new Set(seats.map((s) => s.envelopeId)).size !== seats.length) throw new DelegationAdmissionError("invalid_flow_seats");
  const initial = await input.service.inspect(input.authorityId);
  for (const seat of seats) {
    const envelope = initial.envelopes.find((e) => e.envelope_id === seat.envelopeId);
    if (!envelope || envelope.execution_binding.flow_binding.status !== "bound"
      || envelope.execution_binding.flow_binding.flow_run_id !== input.runId
      || envelope.execution_binding.flow_binding.flow_step_id !== seat.stepId) {
      throw new DelegationAdmissionError("flow_seat_binding_mismatch");
    }
  }
  return orchestrateFlowMultiCursor({
    runId: input.runId, actor: input.actor, cwd: input.cwd, maxConcurrent: input.maxConcurrent,
    ...(input.signal ? { signal: input.signal } : {}),
    onEvent: (event) => input.host.recordScheduleEvent(event),
    async execute({ claim, signal }) {
      const seat = seats.find((s) => s.stepId === claim.step_id);
      if (!seat) throw new DelegationAdmissionError("unassigned_flow_step");
      const { envelope } = await input.service.admitEffect(input.authorityId, seat.envelopeId, seat.effect);
      const flow = envelope.execution_binding.flow_binding;
      if (flow.status !== "bound" || flow.flow_run_id !== claim.run_id || flow.flow_step_id !== claim.step_id
        || canonicalJson(flow.definition) !== canonicalJson(claim.definition)
        || !await input.host.confirmClaim(structuredClone(claim), structuredClone(envelope))) {
        throw new DelegationAdmissionError("flow_claim_binding_mismatch");
      }
      const request = await input.host.prepareRequest(structuredClone(claim), structuredClone(envelope));
      signal.throwIfAborted();
      const invocationId = `flow_${createHash("sha256").update(canonicalJson([input.authorityId, envelope.execution_id, claim.claim_id])).digest("hex")}`;
      const outcome = await executeAuthorizedDelegation({
        service: input.service, host: input.host, dispatchLedger: input.dispatchLedger,
        authorityId: input.authorityId, envelopeId: seat.envelopeId, invocationId,
        effect: seat.effect, allocation: seat.allocation, request, signal,
      });
      await input.host.recordMemberOutcome(structuredClone(claim), structuredClone(envelope), outcome);
      if (outcome.outcome !== "succeeded") throw new DelegationAdmissionError(`member_${outcome.outcome}`);
    },
  });
}
