import { createHash } from "node:crypto";
import type { AuthorizationLedger } from "@kontourai/dispatch";
import { loadRun, definitionIdentity, flowRunHead, flowTransitionRef, evaluateRun, authorizeRetry } from "./delegation-flow-bindings.js";
import { canonicalJson } from "@kontourai/relay";
import { delegationRecordV2, delegationIdV2, delegationIntegerV2, delegationDigestV2, requireDelegationV2, delegationReferenceV2, type DelegationReferenceV2 } from "./delegation-authority-contract.js";
import { createDelegationAuthorityService } from "./delegation-authority-service.js";
import { bindRoundsRecipient, validateRecipientIdentity, type DelegationRecipientIdentity } from "./delegation-rounds-recipient.js";
import { delegationContextSyncInvocationIds, type DelegationSyncReceipt } from "./delegation-context-sync.js";
import { syncRoundsDelegation } from "./delegation-rounds-accounting.js";
import type { DelegationRoundsSpec, DelegationRoundsProjection, DelegationRoundsCommand, DelegationRoundsHost, DelegationRoundsEventBody, FinalizeRoundsSyncCommand } from "./delegation-group-rounds.js";

type Continuation = Extract<DelegationRoundsCommand, {kind: "reappraise" | "authorizeRetry" | "sync"}>;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
/** Names the exact public sync operation; callers must still authenticate its durable command and reservation. */
export function delegationRoundsSyncIdentity(input: { command: Pick<Extract<DelegationRoundsCommand, {kind: "sync"}>, "groupId" | "operationKey" | "seatId" | "contextRef">; authorityId: string; envelopeId: string }) {
  const c = structuredClone(input.command);
  [c.groupId, c.operationKey, c.seatId].forEach(delegationIdV2); delegationReferenceV2(c.contextRef);
  const runId = `roundsync_${createHash("sha256").update(canonicalJson([c.groupId, c.operationKey, c.seatId, c.contextRef])).digest("hex")}`;
  return { runId, invocationIds: delegationContextSyncInvocationIds(input.authorityId, input.envelopeId, runId, c.contextRef.digest) };
}

async function runFor(spec: DelegationRoundsSpec, head: string, cwd?: string) {
  requireDelegationV2(spec.topology.kind === "flow", "rounds_flow_required");
  const run = await loadRun(spec.topology.runId, cwd);
  requireDelegationV2(same(definitionIdentity(run.definition), spec.topology.definition), "rounds_flow_definition_drift");
  requireDelegationV2(flowRunHead(run.state) === head, "rounds_flow_head_conflict"); return run;
}
export async function validateRoundsContinuation(p: DelegationRoundsProjection, c: Continuation, cwd?: string): Promise<void> {
  const run = await runFor(p.spec, c.flowHead, cwd);
  if (c.kind === "reappraise") {
    const blocked = run.state.transitions.at(-1);
    requireDelegationV2(p.spec.seats.some(s => s.stepId === run.definition.gates[c.gate]?.step), "rounds_unauthorized_gate");
    requireDelegationV2(run.state.status === "blocked" && blocked?.status === "blocked"
      && blocked.gate_id === c.gate && flowTransitionRef(blocked) === c.blockedTransitionRef, "rounds_current_block_required");
  } else if (c.kind === "authorizeRetry") {
    const reappraisal = p.continuations.find(r => r.command.kind === "reappraise" && r.command.operationKey === c.reappraisalKey);
    requireDelegationV2(reappraisal?.receipt && reappraisal.receipt.flowHead === c.flowHead
      && reappraisal.receipt.transitionRef === c.request.blocked_transition_ref && c.request.expected_run_head === c.flowHead,
    "rounds_checked_reappraisal_required");
    requireDelegationV2(p.spec.seats.some(s => s.stepId === c.request.target_step), "rounds_unauthorized_seat");
    const last = run.state.transitions.at(-1);
    requireDelegationV2(last?.type === "route_back" && last.limit_exceeded === true
      && flowTransitionRef(last) === c.request.blocked_transition_ref && last.selected_route === c.request.target_step, "rounds_exhausted_proof_required");
  } else requireDelegationV2(p.spec.seats.some(s => s.seatId === c.seatId), "rounds_unauthorized_seat");
}
export async function runRoundsContinuation(input: {
  spec: DelegationRoundsSpec; command: Continuation; projection: DelegationRoundsProjection; authorityService: ReturnType<typeof createDelegationAuthorityService>;
  dispatchLedger: AuthorizationLedger; host: DelegationRoundsHost; cwd?: string;
  mutate<T>(body: () => Promise<T>): Promise<T>;
  authorize(): Promise<void>; append(body: DelegationRoundsEventBody): Promise<unknown>;
}): Promise<void> {
  const { spec, command: c, host } = input; requireDelegationV2(spec.topology.kind === "flow" && host.retainContinuation, "rounds_continuation_host_required");
  await input.authorize(); await runFor(spec, c.flowHead, input.cwd);
  if (c.kind === "sync") {
    const seat = spec.seats.find(s => s.seatId === c.seatId)!;
    requireDelegationV2(host.context, "rounds_sync_host_required");
    const text = await host.context.load(structuredClone(c.contextRef));
    requireDelegationV2(`sha256:${createHash("sha256").update(text).digest("hex")}` === c.contextRef.digest, "rounds_sync_context_digest");
    const { envelope } = await input.authorityService.admitEffect(spec.rootAuthorityRef.id, seat.envelope.id, "context-sync");
    const bound = await bindRoundsRecipient({ spec, seatId: seat.seatId, envelope, host, service: input.authorityService });
    const physical = bound.executionHost;
    const { runId: syncId } = delegationRoundsSyncIdentity({ command: c, authorityId: spec.rootAuthorityRef.id, envelopeId: seat.envelope.id });
    const terminalProofs: PreparedRoundsSync["terminalProofs"] = [], attempted: string[] = [];
    const priorRecipient = (id: string): DelegationRecipientIdentity | null => input.projection.attempts.find(a => a.invocationId === id)?.recipient
      ?? input.projection.continuations.find(r => r.prepared?.invocations.some(i => i.invocationId === id))?.prepared?.recipient ?? null;
    const receipt = await syncRoundsDelegation({ accountingProtocol: host.accountingProtocol, service: input.authorityService, dispatchLedger: input.dispatchLedger,
      authorityId: spec.rootAuthorityRef.id, envelopeId: seat.envelope.id, runId: syncId, text, allocation: seat.allocation,
      maxOutputTokens: seat.allocation.outputTokens,
      host: { resolveRuntime: e => physical.resolveRuntime(e), retainResult: (r, e, id) => physical.retainResult(r, e, id),
        retainFailure: (error, e, id) => physical.retainFailure(error, e, id),
        async invokeFenced(e, id, launch) {
          await input.authorize(); await runFor(spec, c.flowHead, input.cwd);
          const ledger = await input.authorityService.inspect(spec.rootAuthorityRef.id);
          const index = ledger.invocations.findIndex(i => i.invocationId === id);
          const prior = ledger.invocations.slice(0, index).filter(i => i.envelopeId === seat.envelope.id).at(-1);
          if (prior) {
            requireDelegationV2(prior.terminal && prior.usage !== null, "rounds_sync_previous_usage_unknown");
            const recipient = attempted.includes(prior.invocationId) ? bound.identity : priorRecipient(prior.invocationId);
            const proof = await host.context!.confirmTerminal(structuredClone(spec), structuredClone(seat), structuredClone(prior), recipient);
            requireDelegationV2(proof, "rounds_sync_physical_terminal_required"); delegationReferenceV2(proof);
            terminalProofs.push({ invocationId: prior.invocationId, reference: proof, recipient });
          }
          attempted.push(id); return physical.invokeFenced(e, id, launch);
        },
        async retainSyncReceipt(receipt) {
          if (receipt.status === "acknowledged") {
            const ledger = await input.authorityService.inspect(spec.rootAuthorityRef.id);
            const invocation = ledger.invocations.find(i => i.invocationId === attempted.at(-1));
            requireDelegationV2(invocation?.terminal && invocation.usage !== null, "rounds_sync_terminal_usage_required");
            const proof = await host.context!.confirmTerminal(structuredClone(spec), structuredClone(seat), structuredClone(invocation), bound.identity);
            requireDelegationV2(proof, "rounds_sync_physical_terminal_required"); delegationReferenceV2(proof);
            terminalProofs.push({ invocationId: invocation.invocationId, reference: proof, recipient: bound.identity });
          }
          const ledger = await input.authorityService.inspect(spec.rootAuthorityRef.id);
          const invocations = ledger.invocations.filter(i => attempted.includes(i.invocationId));
          const prepared: PreparedRoundsSync = { schemaVersion: "3.0", groupId: spec.groupId, operationKey: c.operationKey, seatId: c.seatId,
            flowHead: c.flowHead, recipient: bound.identity, receipt: structuredClone(receipt), terminalProofs: structuredClone(terminalProofs), invocations };
          await input.append({ kind: "sync_prepared", operationKey: c.operationKey, prepared });
          const reference = await host.retainContinuation!(structuredClone(spec), prepared);
          await input.append({ kind: "continued", operationKey: c.operationKey, receipt: { reference, flowHead: c.flowHead,
            transitionRef: null, acknowledged: receipt.status === "acknowledged" && receipt.reason === "exact_ack" } });
        },
      },
    });
    requireDelegationV2(receipt.status === "acknowledged", "rounds_sync_ack_required"); return;
  }
  const runId = spec.topology.runId;
  const result = await input.mutate(async () => {
    const run = await runFor(spec, c.flowHead, input.cwd);
    const stepId = c.kind === "reappraise" ? run.definition.gates[c.gate]?.step : c.request.target_step;
    const seat = spec.seats.find(s => s.stepId === stepId); requireDelegationV2(seat, "rounds_unauthorized_seat");
    await input.authorityService.admitEffect(spec.rootAuthorityRef.id, seat.envelope.id, seat.effect);
    return c.kind === "reappraise" ? evaluateRun(runId, { cwd: input.cwd, gate: c.gate })
      : authorizeRetry(runId, { cwd: input.cwd, request: c.request });
  });
  const actual = await runFor(spec, flowRunHead(result.state), input.cwd);
  const transition = actual.state.transitions.at(-1);
  requireDelegationV2(c.kind === "reappraise" ? transition?.type === "route_back" && transition.limit_exceeded === true
    : transition?.type === "retry_authorized", "rounds_recovery_result_unproven");
  const reference = await host.retainContinuation(structuredClone(spec), { kind: c.kind, outcomes: result.outcomes ?? null,
    transition, flowHead: flowRunHead(result.state) });
  await input.append({ kind: "continued", operationKey: c.operationKey, receipt: { reference, flowHead: flowRunHead(result.state),
    transitionRef: flowTransitionRef(transition), acknowledged: false } });
}

/** An ACK is not model memory: retain and reintroduce the exact authenticated bytes on paid continuation. */
export async function loadRoundsSyncedContext(p: DelegationRoundsProjection, syncKey: string, host: DelegationRoundsHost): Promise<string> {
  const exchange = p.continuations.find(r => r.command.kind === "sync" && r.command.operationKey === syncKey);
  requireDelegationV2(exchange?.command.kind === "sync" && exchange.receipt?.acknowledged && host.context, "rounds_sync_ack_required");
  const text = await host.context.load(structuredClone(exchange.command.contextRef));
  requireDelegationV2(`sha256:${createHash("sha256").update(text).digest("hex")}` === exchange.command.contextRef.digest, "rounds_sync_context_digest");
  return text;
}


export type PreparedRoundsSync = {
  schemaVersion: "3.0"; groupId: string; operationKey: string; seatId: string; flowHead: string;
  recipient: DelegationRecipientIdentity; receipt: DelegationSyncReceipt;
  terminalProofs: { invocationId: string; reference: DelegationReferenceV2; recipient: DelegationRecipientIdentity | null }[];
  invocations: import("./delegation-authority-service.js").DelegationInvocation[];
};
export function preparedRoundsSyncDigest(value: PreparedRoundsSync): string { return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`; }
export function validatePreparedRoundsSync(value: PreparedRoundsSync): void {
  delegationRecordV2(value, ["schemaVersion", "groupId", "operationKey", "seatId", "flowHead", "recipient", "receipt", "terminalProofs", "invocations"]);
  [value.groupId, value.operationKey, value.seatId].forEach(delegationIdV2);
  requireDelegationV2(typeof value.flowHead === "string" && /^[a-f0-9]{64}$/.test(value.flowHead), "rounds_prepared_sync_invalid");
  delegationRecordV2(value.receipt, ["runId", "envelopeId", "contentDigest", "attempts", "status", "reason"]);
  delegationIdV2(value.receipt.runId); delegationIdV2(value.receipt.envelopeId); delegationDigestV2(value.receipt.contentDigest);
  requireDelegationV2(["acknowledged", "incomplete"].includes(value.receipt.status)
    && ["exact_ack", "ack_mismatch", "unexpected_tools", "execution_incomplete"].includes(value.receipt.reason), "rounds_prepared_sync_invalid");
  delegationIntegerV2(value.receipt.attempts, 2);
  requireDelegationV2(value.schemaVersion === "3.0" && value.invocations.length <= 2 && value.terminalProofs.length <= 3, "rounds_prepared_sync_invalid");
  validateRecipientIdentity(value.recipient);
  requireDelegationV2(value.receipt.envelopeId === value.recipient.envelope.id, "rounds_prepared_sync_identity");
  requireDelegationV2(value.receipt.attempts >= 1 && value.receipt.attempts <= 2, "rounds_prepared_sync_invalid");
  if (value.receipt.status === "acknowledged") requireDelegationV2(value.receipt.reason === "exact_ack" && value.invocations.length > 0
    && value.invocations.every(i => i.terminal && i.usage !== null)
    && value.invocations.every(i => value.terminalProofs.some(p => p.invocationId === i.invocationId)), "rounds_prepared_sync_terminal_required");
  for (const proof of value.terminalProofs) {
    delegationRecordV2(proof, ["invocationId", "reference", "recipient"]); if (proof.recipient) validateRecipientIdentity(proof.recipient); delegationIdV2(proof.invocationId); delegationReferenceV2(proof.reference);
  }
  for (const invocation of value.invocations) {
    delegationRecordV2(invocation, ["invocationId", "envelopeId", "allocation", "usage", "terminal"]);
    delegationIdV2(invocation.invocationId); requireDelegationV2(invocation.envelopeId === value.receipt.envelopeId && typeof invocation.terminal === "boolean", "rounds_prepared_sync_invalid");
    for (const amounts of [invocation.allocation, ...(invocation.usage ? [invocation.usage] : [])]) {
      delegationRecordV2(amounts, ["inputTokens", "outputTokens", "costMicros"]); Object.values(amounts).forEach(a => delegationIntegerV2(a));
    }
  }
}
export async function finalizeRoundsSync(input: { projection: DelegationRoundsProjection; command: FinalizeRoundsSyncCommand;
  host: DelegationRoundsHost; service: ReturnType<typeof createDelegationAuthorityService> }): Promise<DelegationReferenceV2> {
  const { projection: p, command: c, host, service } = input;
  const pending = p.continuations.find(r => r.command.operationKey === c.syncOperationKey);
  requireDelegationV2(pending?.command.kind === "sync" && pending.prepared && !pending.receipt && host.retainContinuation, "rounds_prepared_sync_required");
  const prepared = pending.prepared; validatePreparedRoundsSync(prepared);
  requireDelegationV2(preparedRoundsSyncDigest(prepared) === c.preparedDigest, "rounds_prepared_sync_identity");
  const ledger = await service.inspect(p.spec.rootAuthorityRef.id);
  for (const invocation of prepared.invocations) requireDelegationV2(ledger.invocations.some(i => canonicalJson(i) === canonicalJson(invocation)), "rounds_prepared_accounting_conflict");
  for (const proof of prepared.terminalProofs) requireDelegationV2(ledger.invocations.some(i => i.invocationId === proof.invocationId && i.terminal && i.usage !== null), "rounds_prepared_accounting_conflict");
  return host.retainContinuation(structuredClone(p.spec), structuredClone(prepared));
}
