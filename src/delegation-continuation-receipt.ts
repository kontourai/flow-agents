import { createHash } from "node:crypto";
import { canonicalJson } from "@kontourai/relay";
import {
  definitionIdentity, flowRunHead, flowTransitionRef, loadRun, retryAuthorizationMatches,
  validateRetryAuthorizationRequest,
  type FlowCheckedOperationIdentity, type FlowCheckedOperationRequest, type FlowCheckedRunOperationReceipt,
} from "./delegation-flow-bindings.js";
import { requireDelegationV2 } from "./delegation-authority-contract.js";
import type { DelegationRoundsCommand, DelegationRoundsSpec } from "./delegation-group-rounds.js";

export type ReceiptContinuationCommand = Extract<DelegationRoundsCommand, { kind: "reappraise" | "authorizeRetry" }>;
export type ContinuationReceiptProof = {
  schemaVersion: "1.0"; operationId: string; intentDigest: string;
  originalPrefixDigest: string; receiptDigest: string;
};
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export function continuationDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
function record(value: unknown): Record<string, unknown> {
  requireDelegationV2(value !== null && typeof value === "object" && !Array.isArray(value), "rounds_continuation_proof_shape");
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  requireDelegationV2(Array.isArray(value), "rounds_continuation_proof_shape"); return value;
}
function hex(value: unknown): asserts value is string {
  requireDelegationV2(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), "rounds_continuation_proof_hash");
}
function integer(value: unknown): asserts value is number {
  requireDelegationV2(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, "rounds_continuation_proof_bounds");
}
function text(value: unknown): asserts value is string {
  requireDelegationV2(typeof value === "string" && value.length > 0, "rounds_continuation_proof_shape");
}
/** Original prefix/spec bind intent; fresh current authorization is a separate host obligation. */
export function continuationOperation(spec: DelegationRoundsSpec, command: ReceiptContinuationCommand, originalPrefixDigest: string): FlowCheckedOperationIdentity {
  hex(originalPrefixDigest);
  requireDelegationV2(spec.topology.kind === "flow" && spec.groupId === command.groupId, "rounds_continuation_proof_binding");
  return {
    id: `rounds_${continuationDigest([spec.groupId, command.operationKey])}`,
    intentDigest: continuationDigest({ domain: "flow-agents/continuation/1", spec, command, originalPrefixDigest }),
  };
}
export function continuationRequest(spec: DelegationRoundsSpec, command: ReceiptContinuationCommand): FlowCheckedOperationRequest {
  requireDelegationV2(spec.topology.kind === "flow", "rounds_flow_required");
  return command.kind === "reappraise"
    ? { kind: "evaluate", runId: spec.topology.runId, expectedRunHead: command.flowHead, gate: command.gate, now: null }
    : { kind: "authorize-retry", runId: spec.topology.runId, request: validateRetryAuthorizationRequest(command.request) };
}
/** Validate the immutable receipt bindings without treating an untrusted JSON value as a Flow type. */
function receiptBindings(spec: DelegationRoundsSpec, c: ReceiptContinuationCommand, prefix: string, value: unknown) {
  requireDelegationV2(spec.topology.kind === "flow", "rounds_flow_required");
  const receipt = record(value), operation = continuationOperation(spec, c, prefix), request = continuationRequest(spec, c);
  requireDelegationV2(receipt.version === "1" && same(receipt.operation, operation) && same(receipt.request, request)
    && receipt.kind === request.kind && receipt.runId === spec.topology.runId && receipt.priorRunHead === c.flowHead
    && receipt.requestSemanticDigest === flowRunHead(request) && same(receipt.originDefinition, spec.topology.definition),
  "rounds_continuation_receipt_binding");
  hex(receipt.originalResultHead); hex(receipt.snapshotDigest);
  integer(receipt.transitionStart); integer(receipt.evaluationStart);
  const refs = array(receipt.transitionRefs); refs.forEach(hex);
  requireDelegationV2(refs.length > 0 && new Set(refs).size === refs.length, "rounds_continuation_reference_ambiguity");
  return { receipt, operation, refs };
}

/** Authenticate a published winner using only immutable retained bytes, without Flow or retention calls. */
export function authenticateContinuationWinner(input: {
  spec: DelegationRoundsSpec; command: ReceiptContinuationCommand; originalPrefixDigest: string;
  bytes: string; referenceDigest: string; flowHead: string; transitionRef: string | null; proof: ContinuationReceiptProof;
}): void {
  requireDelegationV2(typeof input.bytes === "string" && `sha256:${createHash("sha256").update(input.bytes).digest("hex")}` === input.referenceDigest,
    "rounds_continuation_completion_conflict");
  let value: unknown;
  try { value = JSON.parse(input.bytes); } catch { requireDelegationV2(false, "rounds_continuation_completion_conflict"); }
  const observation = record(value);
  requireDelegationV2(Object.keys(observation).sort().join(",") === "kind,operationKey,originalPrefixDigest,receipt,schemaVersion,transitionRef"
    && observation.schemaVersion === "1.0" && observation.kind === input.command.kind
    && observation.operationKey === input.command.operationKey && observation.originalPrefixDigest === input.originalPrefixDigest,
  "rounds_continuation_completion_conflict");
  const { receipt, operation, refs } = receiptBindings(input.spec, input.command, input.originalPrefixDigest, observation.receipt);
  requireDelegationV2(input.proof.operationId === operation.id && input.proof.intentDigest === operation.intentDigest
    && input.proof.originalPrefixDigest === input.originalPrefixDigest && input.proof.receiptDigest === continuationDigest(receipt)
    && receipt.originalResultHead === input.flowHead && observation.transitionRef === input.transitionRef
    && typeof input.transitionRef === "string" && refs.filter(ref => ref === input.transitionRef).length === 1,
  "rounds_continuation_completion_conflict");
}
/** Join ONLY through public canonical loadRun and exact receipt-owned references.
 * LIMIT-EXCEEDED metadata records a canonical recovery decision, never retry authority.
 * Raw transitions/current state are deliberately excluded from the returned observation. */
export async function continuationObservation(input: {
  spec: DelegationRoundsSpec; command: ReceiptContinuationCommand; originalPrefixDigest: string;
  receipt: FlowCheckedRunOperationReceipt; cwd?: string;
}) {
  const { spec, command: c, receipt, originalPrefixDigest } = input;
  requireDelegationV2(spec.topology.kind === "flow", "rounds_flow_required");
  const { operation, refs } = receiptBindings(spec, c, originalPrefixDigest, receipt);
  const run = await loadRun(spec.topology.runId, input.cwd);
  // Public loadRun validates canonical history, checked segments, snapshots and amendments.
  // Its extensible declarations do not justify trusting un-narrowed extension fields.
  const state = record(run.state), transitions = array(state.transitions);
  requireDelegationV2(state.run_id === spec.topology.runId, "rounds_continuation_receipt_binding");
  const records = array(record(state.checked_operation_ledger).records);
  const matches = records.filter(value => record(record(value).operation).id === operation.id);
  const { originalResultHead: _head, ...expectedRecord } = receipt;
  requireDelegationV2(matches.length === 1 && same(matches[0], expectedRecord), "rounds_continuation_record_conflict");
  requireDelegationV2(receipt.transitionStart + refs.length <= transitions.length, "rounds_continuation_proof_bounds");
  const evaluationRefs = array(receipt.evaluationRefs);
  const evaluationLedger = state.gate_evaluation_ledger === undefined ? [] : array(record(state.gate_evaluation_ledger).records).map(record);
  requireDelegationV2(receipt.evaluationStart + evaluationRefs.length <= evaluationLedger.length, "rounds_continuation_proof_bounds");
  for (const [index, ref] of evaluationRefs.entries()) {
    requireDelegationV2(same(evaluationLedger[receipt.evaluationStart + index].ref, ref), "rounds_continuation_evaluation_binding");
  }
  const segment = transitions.slice(receipt.transitionStart, receipt.transitionStart + refs.length).map(record);
  for (const [i, transition] of segment.entries()) {
    requireDelegationV2(flowTransitionRef(transition) === refs[i], "rounds_continuation_reference_conflict");
  }
  const amendments = state.definition_amendments === undefined ? [] : array(state.definition_amendments);
  const definitions: unknown[] = [run.startDefinition, ...amendments.map(value => record(value).successor)];
  const origins = definitions.filter(value => same(definitionIdentity(record(value)), receipt.originDefinition));
  requireDelegationV2(origins.length === 1, "rounds_continuation_definition_unavailable");
  const definition = record(origins[0]);
  let candidates: number[];
  if (c.kind === "reappraise") {
    const gate = record(record(definition.gates)[c.gate]); text(gate.step);
    requireDelegationV2(spec.seats.some(seat => seat.stepId === gate.step), "rounds_unauthorized_gate");
    const outcomes = array(receipt.outcomes).map(record).filter(outcome => outcome.gate_id === c.gate && outcome.limit_exceeded === true);
    requireDelegationV2(outcomes.length === 1, "rounds_continuation_result_ambiguous");
    const outcome = outcomes[0]; text(outcome.selected_route);
    const evaluation = record(outcome.evaluation_ref);
    requireDelegationV2(evaluation.runId === spec.topology.runId && evaluation.gateId === c.gate
      && array(receipt.evaluationRefs).filter(ref => same(ref, evaluation)).length === 1, "rounds_continuation_evaluation_binding");
    const evaluationRecords = evaluationLedger.filter(entry => same(entry.ref, evaluation));
    requireDelegationV2(evaluationRecords.length === 1, "rounds_continuation_evaluation_binding");
    const evaluationRecord = evaluationRecords[0], route = record(evaluationRecord.routeBack);
    requireDelegationV2(evaluationRecord.originalVerdict === outcome.status && same(evaluationRecord.definition, receipt.originDefinition)
      && record(evaluationRecord.gate).id === c.gate && route.attempt === outcome.attempt
      && route.maxAttempts === outcome.max_attempts && route.retryEpoch === outcome.retry_epoch
      && route.reason === outcome.route_reason && route.selectedRoute === outcome.selected_route,
    "rounds_continuation_evaluation_binding");
    candidates = segment.flatMap((transition, index) => {
      if (transition.type !== "route_back" || transition.gate_id !== c.gate || transition.limit_exceeded !== true) return [];
      integer(transition.attempt); integer(transition.max_attempts); text(transition.from_step); text(transition.to_step);
      text(transition.selected_route);
      requireDelegationV2(transition.status === "blocked" && transition.attempt > transition.max_attempts
        && transition.selected_route === outcome.selected_route, "rounds_continuation_result_unproven");
      for (const key of ["evaluated_step", "recovery_step"]) if (transition[key] !== undefined) text(transition[key]);
      if (transition.retry_epoch !== undefined) integer(transition.retry_epoch);
      return [index];
    });
  } else {
    requireDelegationV2(spec.seats.some(seat => seat.stepId === c.request.target_step), "rounds_unauthorized_seat");
    candidates = segment.flatMap((transition, index) => transition.type === "retry_authorized"
      && transition.status === "retry-authorized" && retryAuthorizationMatches(transition, c.request) ? [index] : []);
    requireDelegationV2(segment.length === 1 && receipt.outcomes.length === 0 && receipt.evaluationRefs.length === 0,
      "rounds_continuation_result_unproven");
  }
  requireDelegationV2(candidates.length === 1, "rounds_continuation_result_ambiguous");
  const transitionRef = receipt.transitionRefs[candidates[0]];
  const proof: ContinuationReceiptProof = { schemaVersion: "1.0", operationId: operation.id, intentDigest: operation.intentDigest,
    originalPrefixDigest, receiptDigest: continuationDigest(receipt) };
  return {
    observation: { schemaVersion: "1.0" as const, kind: c.kind, operationKey: c.operationKey, originalPrefixDigest,
      receipt: structuredClone(receipt), transitionRef },
    proof, flowHead: receipt.originalResultHead, transitionRef,
  };
}
