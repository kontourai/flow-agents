import { canonicalJson } from "@kontourai/relay";
import { assertSyncedRecipient } from "./delegation-rounds-recipient.js";
import { loadRoundsSyncedContext } from "./delegation-rounds-continuation.js";
import type { AuthorizationLedger } from "@kontourai/dispatch";
import {
  loadRun, definitionIdentity, flowRunHead, flowTransitionRef, claimableMultiCursorSteps,
  reopenMultiCursorStep, validateDurableStepClaim, type FlowDurableStepClaim,
} from "./delegation-flow-bindings.js";
import { requireDelegationV2 } from "./delegation-authority-contract.js";
import { createDelegationAuthorityService } from "./delegation-authority-service.js";
import { executeRoundsDelegation } from "./delegation-rounds-accounting.js";
import { orchestrateFlowMultiCursor } from "./multi-cursor-flow-orchestrator.js";
import type {
  DelegationRoundsSpec, DelegationRoundsProjection, DelegationRoundsCommand,
  DelegationRoundsHost, DelegationRoundsEventBody, FlowRoundAction, RoundSelection,
} from "./delegation-group-rounds.js";

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
async function currentRun(spec: DelegationRoundsSpec, cwd?: string) {
  requireDelegationV2(spec.topology.kind === "flow", "rounds_flow_required");
  const run = await loadRun(spec.topology.runId, cwd);
  requireDelegationV2(same(definitionIdentity(run.definition), spec.topology.definition), "rounds_flow_definition_drift");
  return run;
}
/** Matches Flow's persisted invalidation list; does not derive readiness, ancestry or retry limits. */
function affectsStep(value: unknown, stepId: string): boolean {
  const t = value as { type?: string; to_step?: string; invalidated_steps?: string[] };
  return ["route_back", "retry_authorized", "gate_reappraisal"].includes(t.type ?? "")
    && (t.to_step === stepId || t.invalidated_steps?.includes(stepId) === true);
}
function sourceAction(p: DelegationRoundsProjection, invocationId: string): FlowRoundAction {
  const source = p.flowActions.find(a => a.mode === "invoke" && a.invocationId === invocationId);
  requireDelegationV2(source?.claim, "rounds_source_claim_required"); return source;
}
function validateSelection(p: DelegationRoundsProjection, selection: RoundSelection, run: Awaited<ReturnType<typeof loadRun>>) {
  const seat = p.spec.seats.find(s => s.seatId === selection.seatId);
  requireDelegationV2(seat?.stepId, "rounds_unauthorized_seat");
  if (selection.mode === "evaluate") {
    const attempt = p.attempts.find(a => a.invocationId === selection.invocationId && a.seatId === selection.seatId);
    requireDelegationV2(attempt?.observation && attempt.terminal, "rounds_retained_terminal_required");
    const source = sourceAction(p, selection.invocationId);
    requireDelegationV2(!run.state.transitions.slice(source.claim!.transitionCount).some((t: unknown) => affectsStep(t, seat.stepId!)), "rounds_retained_result_invalidated");
  } else {
    requireDelegationV2(selection.mode === "invoke", "rounds_mode");
    if (selection.nonadmissionOf !== undefined) {
      const prior = p.attempts.find(a => a.seatId === selection.seatId && a.invocationId === selection.nonadmissionOf);
      requireDelegationV2(prior?.admission === "not_admitted"
        && selection.previousInvocationId === null && selection.retryRef === null, "rounds_definite_nonadmission_required");
    } else if (selection.previousInvocationId === null) requireDelegationV2(selection.retryRef === null, "rounds_unexpected_retry_reference");
    else {
      const previous = sourceAction(p, selection.previousInvocationId);
      const retry = run.state.transitions.slice(previous.claim!.transitionCount).filter((t: unknown) => affectsStep(t, seat.stepId!)).at(-1);
      requireDelegationV2(retry && flowTransitionRef(retry) === selection.retryRef && ((retry.type === "route_back" && retry.limit_exceeded !== true)
        || retry.type === "retry_authorized"), "rounds_current_flow_retry_required");
      if (retry.type === "retry_authorized") requireDelegationV2(p.continuations.some(r => r.command.kind === "authorizeRetry"
        && r.receipt?.transitionRef === selection.retryRef), "rounds_checked_reappraisal_required");
    }
    requireDelegationV2(claimableMultiCursorSteps(run.definition, run.state).includes(seat.stepId), "rounds_step_not_ready");
  }
}
export async function validateFlowRoundCreation(spec: DelegationRoundsSpec, service: ReturnType<typeof createDelegationAuthorityService>, cwd?: string): Promise<void> {
  const run = await currentRun(spec, cwd);
  requireDelegationV2(spec.topology.kind === "flow", "rounds_flow_required");
  requireDelegationV2(run.definition.execution?.mode === "multi-cursor", "rounds_multi_cursor_required");
  const authority = await service.inspect(spec.rootAuthorityRef.id);
  for (const seat of spec.seats) {
    const binding = authority.envelopes.find(e => e.envelope_id === seat.envelope.id)!.execution_binding.flow_binding;
    requireDelegationV2(binding.status === "bound" && binding.flow_run_id === spec.topology.runId
      && binding.flow_step_id === seat.stepId && same(binding.definition, spec.topology.definition)
      && run.definition.steps.some((s: { id: string }) => s.id === seat.stepId), "rounds_flow_seat_binding");
  }
}
export async function validateFlowRoundRelease(p: DelegationRoundsProjection, c: Extract<DelegationRoundsCommand, {kind: "release"}>, cwd?: string): Promise<void> {
  const run = await currentRun(p.spec, cwd);
  requireDelegationV2(c.flowHead === flowRunHead(run.state), "rounds_flow_head_conflict");
  for (const selection of c.seats) {
    if ((p.spec.policy.maxSyncs ?? 0) > 0 || selection.syncKey !== undefined) {
      const exchange = p.continuations.find(r => r.command.operationKey === selection.syncKey);
      requireDelegationV2(exchange?.command.kind === "sync" && exchange.command.seatId === selection.seatId
        && exchange.receipt?.acknowledged && exchange.receipt.flowHead === c.flowHead && exchange.afterRound === p.rounds.length, "rounds_current_seat_sync_required");
    }
    validateSelection(p, selection, run);
    if (selection.mode === "evaluate") {
      const step = p.spec.seats.find(s => s.seatId === selection.seatId)!.stepId!;
      requireDelegationV2(claimableMultiCursorSteps(run.definition, run.state).includes(step)
        || run.state.multi_cursor.blocked_steps.some((b: { step_id: string }) => b.step_id === step), "rounds_step_not_ready");
    }
  }
}

/** A finite checkpoint over the existing scheduler and public Flow mutation APIs. */
export async function runDelegationFlowRound(input: {
  authorityService: ReturnType<typeof createDelegationAuthorityService>; dispatchLedger: AuthorizationLedger;
  host: DelegationRoundsHost; cwd?: string; command: Extract<DelegationRoundsCommand, {kind: "release"}>;
  projection: DelegationRoundsProjection; get(): Promise<DelegationRoundsProjection>;
  withAdmission<T>(stepId: string, body: () => Promise<T>): Promise<T>;
  authorize(action: "execute"): Promise<void>; append(body: DelegationRoundsEventBody): Promise<unknown>;
}): Promise<void> {
  const { projection: p, command: c, host } = input, { spec } = p;
  requireDelegationV2(spec.topology.kind === "flow" && host.flow, "rounds_flow_host_required");
  const flowHost = host.flow.executionHost(structuredClone(spec)), topology = spec.topology;
  const actions = p.flowActions.filter(a => a.round === p.rounds.length);
  const remaining = new Set(actions.map(a => spec.seats.find(s => s.seatId === a.seatId)!.stepId!));
  const actionForStep = (stepId: string) => {
    const action = actions.find(a => spec.seats.find(s => s.seatId === a.seatId)!.stepId === stepId);
    requireDelegationV2(action, "rounds_unreleased_step"); return action;
  };
  for (const action of actions.filter(a => a.mode === "evaluate")) {
    await input.authorize("execute");
    const current = await input.get(), attempt = current.attempts.find(a => a.invocationId === action.invocationId)!;
    requireDelegationV2(await host.flow.confirmRetainedResult(structuredClone(spec), structuredClone(attempt), structuredClone(attempt.observation!)), "rounds_retained_result_unconfirmed");
    const run = await currentRun(spec, input.cwd);
    validateSelection(current, c.seats.find(s => s.seatId === action.seatId)!, run);
    const stepId = spec.seats.find(s => s.seatId === action.seatId)!.stepId!;
    if (run.state.multi_cursor.blocked_steps.some((b: { step_id: string }) => b.step_id === stepId)) {
      await input.withAdmission(stepId, () => reopenMultiCursorStep(topology.runId, { step_id: stepId, cwd: input.cwd }));
    }
  }
  async function currentClaim(claim: FlowDurableStepClaim) {
    await input.authorize("execute");
    const run = await currentRun(spec, input.cwd);
    const current = validateDurableStepClaim(run.definition, run.state, claim, new Date());
    const seat = spec.seats.find(s => s.stepId === claim.step_id)!;
    const selection = c.seats.find(s => s.seatId === seat.seatId)!;
    if (selection.mode !== "evaluate" && selection.nonadmissionOf !== undefined) {
      const ledger = await input.authorityService.inspect(spec.rootAuthorityRef.id);
      requireDelegationV2(!ledger.invocations.some(i => i.invocationId === selection.nonadmissionOf), "rounds_definite_nonadmission_required");
    }
    const { envelope } = await input.authorityService.admitEffect(spec.rootAuthorityRef.id, seat.envelope.id, seat.effect);
    requireDelegationV2(await flowHost.confirmClaim(structuredClone(current), structuredClone(envelope)), "rounds_current_claim_unconfirmed");
    return { run, envelope };
  }
  const observation = await orchestrateFlowMultiCursor({
    runId: topology.runId, actor: topology.actor, cwd: input.cwd,
    maxConcurrent: spec.policy.maxConcurrent, maxRounds: actions.length + 1,
    async selectReadySteps(ready) {
      await input.authorize("execute"); return ready.filter(step => remaining.has(step));
    },
    withClaimAdmission: input.withAdmission,
    async beforeClaim(stepId) {
      await input.authorize("execute"); requireDelegationV2(remaining.has(stepId), "rounds_unreleased_step");
      const current = await input.get(), run = await currentRun(spec, input.cwd);
      validateSelection(current, c.seats.find(s => s.seatId === actionForStep(stepId).seatId)!, run);
    },
    async onEvent(event) {
      if (event.kind === "admitted") {
        const run = await currentRun(spec, input.cwd);
        const claim = run.state.multi_cursor.active_claims.find((a: FlowDurableStepClaim) => a.claim_id === event.claimId);
        requireDelegationV2(claim, "rounds_admitted_claim_missing"); await currentClaim(claim);
        const action = actionForStep(event.stepId); remaining.delete(event.stepId);
        const selection = c.seats.find(s => s.seatId === action.seatId)!;
        const recipient = selection.syncKey ? (await assertSyncedRecipient(await input.get(), selection.syncKey, host, input.authorityService)).identity : undefined;
        await input.append({ kind: "flow_claimed", operationKey: c.operationKey, seatId: action.seatId,
          claim: structuredClone(claim), transitionCount: run.state.transitions.length, ...(recipient ? { recipient } : {}) });
      }
      await flowHost.recordScheduleEvent(structuredClone(event));
    },
    async execute({ claim, signal }) {
      const { envelope } = await currentClaim(claim), action = actionForStep(claim.step_id);
      if (action.mode === "evaluate") {
        const current = await input.get(), attempt = current.attempts.find(a => a.invocationId === action.invocationId)!;
        requireDelegationV2(await host.flow!.confirmRetainedResult(structuredClone(spec), structuredClone(attempt), structuredClone(attempt.observation!)), "rounds_retained_result_unconfirmed");
        return;
      }
      const seat = spec.seats.find(s => s.seatId === action.seatId)!, attempt = (await input.get()).attempts.find(a => a.invocationId === action.invocationId)!;
      const request = await flowHost.prepareRequest(structuredClone(claim), structuredClone(envelope));
      const selection = c.seats.find(s => s.seatId === action.seatId)!;
      if (selection.syncKey !== undefined) {
        const text = await loadRoundsSyncedContext(await input.get(), selection.syncKey, host);
        request.messages = [{ role: "user", content: text }, ...request.messages];
      }
      const paidHost = selection.syncKey ? (await assertSyncedRecipient(await input.get(), selection.syncKey, host, input.authorityService)).executionHost : flowHost;
      const outcome = await executeRoundsDelegation({ accountingProtocol: host.accountingProtocol, service: input.authorityService, dispatchLedger: input.dispatchLedger,
        authorityId: spec.rootAuthorityRef.id, envelopeId: seat.envelope.id, invocationId: action.invocationId,
        effect: seat.effect, allocation: seat.allocation, request, signal,
        host: {
          resolveRuntime: e => paidHost.resolveRuntime(e), retainResult: (r, e, id) => paidHost.retainResult(r, e, id),
          retainFailure: (error, e, id) => paidHost.retainFailure(error, e, id),
          async invokeFenced(e, id, launch) { await currentClaim(claim); return paidHost.invokeFenced(e, id, launch); },
        },
      });
      await flowHost.recordMemberOutcome(structuredClone(claim), structuredClone(envelope), outcome);
      const reference = await host.retainObservation(structuredClone(spec), structuredClone(attempt), { outcome });
      await input.append({ kind: "observed", invocationId: action.invocationId, reference });
      requireDelegationV2(outcome.outcome === "succeeded", "rounds_member_execution_unknown");
    },
    async onEvaluation(receipt) {
      const current = await input.get(), action = current.flowActions.find(a => a.claim?.value.claim_id === receipt.claim.claim_id)!;
      const attempt = current.attempts.find(a => a.invocationId === action.invocationId)!;
      const reference = await host.flow!.retainEvaluation(structuredClone(spec), structuredClone(action), {
        kind: action.mode === "evaluate" ? "evaluation-only" : "invocation-evaluation",
        invocationId: action.invocationId, retainedResult: attempt.observation, ...structuredClone(receipt),
      });
      await input.append({ kind: "flow_evaluated", operationKey: c.operationKey, seatId: action.seatId,
        claimId: receipt.claim.claim_id, receipt: { reference, settled: receipt.settled, runHead: receipt.runHead } });
    },
  });
  // Only a successfully returned scheduler's explicit conflict proves this action never claimed.
  for (const action of actions) {
    const current = await input.get(), stored = current.flowActions.find(a => a.round === action.round && a.seatId === action.seatId)!;
    if (stored.claim) continue;
    const stepId = spec.seats.find(s => s.seatId === action.seatId)!.stepId!;
    requireDelegationV2(observation.deferredSteps.includes(stepId) && observation.finalRunHead, "rounds_nonadmission_unproven");
    const ledger = await input.authorityService.inspect(spec.rootAuthorityRef.id);
    requireDelegationV2(action.mode === "evaluate" || !ledger.invocations.some(i => i.invocationId === action.invocationId), "rounds_nonadmission_unproven");
    await input.append({ kind: "flow_not_admitted", operationKey: c.operationKey, seatId: action.seatId,
      reason: "resource_conflict", runHead: observation.finalRunHead });
  }
}
