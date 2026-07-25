import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  FlowMultiCursorError,
  claimReadyStep,
  claimableMultiCursorSteps,
  evaluateClaimedStep,
  loadRun,
  recoverExpiredStepClaims,
  releaseStepClaim,
  renewStepClaim,
  definitionIdentity,
  flowRunHead,
  type FlowDurableStepClaim,
  type FlowDefinitionIdentity,
  type FlowStepClaimActor,
} from "@kontourai/flow";

export type FlowScheduleEvent =
  | { kind: "recovered"; claimId: string; stepId: string }
  | { kind: "admitted"; claimId: string; livenessId: string; stepId: string; mutableResources: string[] }
  | { kind: "deferred"; stepId: string; diagnosticCode: "flow.multi_cursor.claim.resource_conflict"; summary: string }
  | { kind: "started"; claimId: string; stepId: string }
  | { kind: "renewed"; claimId: string; stepId: string; count: number }
  | { kind: "settled"; claimId: string; stepId: string; settled: boolean }
  | { kind: "released"; claimId: string; stepId: string; reason: string }
  | { kind: "failed"; claimId: string; stepId: string; summary: string };

export interface FlowScheduleObservation {
  schemaVersion: "1.0";
  runId: string;
  /** Exact Flow definition that admitted this schedule. */
  definition: FlowDefinitionIdentity;
  /** Flow head before this host began recovery or dispatch. */
  initialRunHead: string;
  /** Flow head after final capture, or null when final capture itself failed. */
  finalRunHead: string | null;
  actor: FlowStepClaimActor;
  events: FlowScheduleEvent[];
  deferredSteps: string[];
  unsettledSteps: string[];
}

export interface FlowMultiCursorExecution {
  claim: FlowDurableStepClaim;
  runId: string;
  cwd: string;
  /** Aborted when claim renewal fails; callbacks must stop before returning. */
  signal: AbortSignal;
}

export interface OrchestrateFlowMultiCursorInput {
  runId: string;
  actor: FlowStepClaimActor;
  execute: (execution: FlowMultiCursorExecution) => Promise<void>;
  cwd?: string;
  leaseSeconds?: number;
  renewalIntervalMs?: number;
  maxRounds?: number;
  identityFactory?: (stepId: string) => { claimId: string; livenessId: string };
}

export class FlowMultiCursorOrchestrationError extends Error {
  readonly observation: FlowScheduleObservation;

  constructor(message: string, observation: FlowScheduleObservation, options?: ErrorOptions) {
    super(message, options);
    this.name = "FlowMultiCursorOrchestrationError";
    this.observation = observation;
  }
}

interface AdmittedExecution {
  claim: FlowDurableStepClaim;
  livenessId: string;
}

interface RoundBarrier {
  arrive: () => Promise<void>;
}

function roundBarrier(participants: number): RoundBarrier {
  let remaining = participants;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return {
    arrive: async () => {
      remaining -= 1;
      if (remaining === 0) release();
      await ready;
    },
  };
}

function observation(
  input: OrchestrateFlowMultiCursorInput,
  run: Awaited<ReturnType<typeof loadRun>>,
): FlowScheduleObservation {
  return {
    schemaVersion: "1.0",
    runId: input.runId,
    definition: definitionIdentity(run.definition),
    initialRunHead: flowRunHead(run.state),
    finalRunHead: null,
    actor: structuredClone(input.actor),
    events: [],
    deferredSteps: [],
    unsettledSteps: [],
  };
}

function identityFor(input: OrchestrateFlowMultiCursorInput, stepId: string): { claimId: string; livenessId: string } {
  return input.identityFactory?.(stepId) ?? {
    claimId: `flow-agents-${stepId}-${randomUUID()}`,
    livenessId: `flow-agents-${randomUUID()}`,
  };
}

function validateInput(input: OrchestrateFlowMultiCursorInput): void {
  const leaseMs = (input.leaseSeconds ?? 300) * 1_000;
  const renewalMs = input.renewalIntervalMs ?? Math.max(250, Math.floor(leaseMs / 2));
  if (!Number.isInteger(input.maxRounds ?? 100) || (input.maxRounds ?? 100) < 1) {
    throw new TypeError("maxRounds must be a positive integer");
  }
  if (!Number.isFinite(renewalMs) || renewalMs < 1 || renewalMs >= leaseMs) {
    throw new TypeError("renewalIntervalMs must be positive and shorter than the Flow claim lease");
  }
}

function isResourceConflict(error: unknown): error is FlowMultiCursorError & { code: "flow.multi_cursor.claim.resource_conflict" } {
  return error instanceof FlowMultiCursorError
    && error.code === "flow.multi_cursor.claim.resource_conflict";
}

function assertDefinitionUnchanged(expected: FlowDefinitionIdentity, actual: FlowDefinitionIdentity): void {
  if (expected.id !== actual.id || expected.version !== actual.version || expected.digest !== actual.digest) {
    throw new Error("Flow definition identity changed during multi-cursor orchestration");
  }
}

async function admitStep(
  input: OrchestrateFlowMultiCursorInput,
  stepId: string,
  result: FlowScheduleObservation,
): Promise<AdmittedExecution | null> {
  const identity = identityFor(input, stepId);
  try {
    const admitted = await claimReadyStep(input.runId, {
      claim_id: identity.claimId,
      liveness_id: identity.livenessId,
      step_id: stepId,
      actor: input.actor,
      lease_seconds: input.leaseSeconds,
      cwd: input.cwd,
    });
    try {
      assertDefinitionUnchanged(result.definition, admitted.claim.definition);
    } catch (error) {
      try {
        await releaseStepClaim(input.runId, {
          claim_id: admitted.claim.claim_id,
          liveness_id: admitted.claim.liveness_id,
          actor: input.actor,
          reason: "definition-identity-drift",
          cwd: input.cwd,
        });
      } catch (releaseError) {
        throw new AggregateError([error, releaseError], "definition drift claim cleanup failed");
      }
      throw error;
    }
    result.events.push({
      kind: "admitted",
      claimId: admitted.claim.claim_id,
      livenessId: admitted.claim.liveness_id,
      stepId,
      mutableResources: [...admitted.claim.mutable_resources],
    });
    return { claim: admitted.claim, livenessId: identity.livenessId };
  } catch (error) {
    if (!isResourceConflict(error)) throw error;
    result.events.push({
      kind: "deferred",
      stepId,
      diagnosticCode: error.code,
      summary: "Flow deferred the step because a declared mutable resource is already claimed.",
    });
    if (!result.deferredSteps.includes(stepId)) result.deferredSteps.push(stepId);
    return null;
  }
}

async function renewUntilStopped(
  input: OrchestrateFlowMultiCursorInput,
  admitted: AdmittedExecution,
  result: FlowScheduleObservation,
  signal: AbortSignal,
): Promise<void> {
  const interval = input.renewalIntervalMs ?? Math.max(250, Math.floor((input.leaseSeconds ?? 300) * 500));
  while (!signal.aborted) {
    try {
      await delay(interval, undefined, { signal });
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
    if (signal.aborted) return;
    await renewStepClaim(input.runId, {
      claim_id: admitted.claim.claim_id,
      liveness_id: admitted.livenessId,
      actor: input.actor,
      lease_seconds: input.leaseSeconds,
      cwd: input.cwd,
    });
    const prior = result.events.find((event) => event.kind === "renewed" && event.claimId === admitted.claim.claim_id);
    if (prior?.kind === "renewed") prior.count += 1;
    else result.events.push({ kind: "renewed", claimId: admitted.claim.claim_id, stepId: admitted.claim.step_id, count: 1 });
  }
}

async function releaseAdmitted(
  input: OrchestrateFlowMultiCursorInput,
  admitted: AdmittedExecution,
  result: FlowScheduleObservation,
  reason: string,
): Promise<void> {
  await releaseStepClaim(input.runId, {
    claim_id: admitted.claim.claim_id,
    liveness_id: admitted.livenessId,
    actor: input.actor,
    reason,
    cwd: input.cwd,
  });
  result.events.push({ kind: "released", claimId: admitted.claim.claim_id, stepId: admitted.claim.step_id, reason });
}

async function executeAdmitted(
  input: OrchestrateFlowMultiCursorInput,
  admitted: AdmittedExecution,
  result: FlowScheduleObservation,
  barrier: RoundBarrier,
): Promise<void> {
  const controller = new AbortController();
  let arrived = false;
  const heartbeat = renewUntilStopped(input, admitted, result, controller.signal);
  result.events.push({ kind: "started", claimId: admitted.claim.claim_id, stepId: admitted.claim.step_id });
  const callback = Promise.resolve().then(() => input.execute({
    claim: structuredClone(admitted.claim),
    runId: input.runId,
    cwd: input.cwd ?? process.cwd(),
    signal: controller.signal,
  }));
  const heartbeatFailure = heartbeat.then(
    () => new Promise<never>(() => undefined),
    (error) => Promise.reject(error),
  );
  try {
    await Promise.race([callback, heartbeatFailure]);
    await barrier.arrive();
    arrived = true;
    controller.abort();
    await heartbeat;
    await callback;
    const evaluated = await evaluateClaimedStep(input.runId, {
      claim_id: admitted.claim.claim_id,
      liveness_id: admitted.livenessId,
      actor: input.actor,
      cwd: input.cwd,
    });
    result.events.push({ kind: "settled", claimId: admitted.claim.claim_id, stepId: admitted.claim.step_id, settled: evaluated.settled });
    if (!evaluated.settled) {
      result.unsettledSteps.push(admitted.claim.step_id);
      await releaseAdmitted(input, admitted, result, "gate-not-settled");
    }
  } catch (error) {
    const failure = await cleanupFailedExecution(input, admitted, result, controller, heartbeat, callback, error);
    if (!arrived) await barrier.arrive();
    throw failure;
  }
}

async function cleanupFailedExecution(
  input: OrchestrateFlowMultiCursorInput,
  admitted: AdmittedExecution,
  result: FlowScheduleObservation,
  controller: AbortController,
  heartbeat: Promise<void>,
  callback: Promise<void>,
  primary: unknown,
): Promise<unknown> {
  controller.abort();
  const cleanup: unknown[] = [];
  for (const operation of [heartbeat, callback]) {
    try { await operation; } catch (error) { if (error !== primary) cleanup.push(error); }
  }
  try { await releaseAdmitted(input, admitted, result, "host-execution-failed"); }
  catch (error) { cleanup.push(error); }
  result.events.push({
    kind: "failed",
    claimId: admitted.claim.claim_id,
    stepId: admitted.claim.step_id,
    summary: "Host execution or exact-claim cleanup failed.",
  });
  return cleanup.length > 0
    ? new AggregateError([primary, ...cleanup], "multi-cursor host execution and cleanup failed")
    : primary;
}

async function recoverClaims(input: OrchestrateFlowMultiCursorInput, result: FlowScheduleObservation): Promise<void> {
  const recovered = await recoverExpiredStepClaims(input.runId, { cwd: input.cwd });
  for (const claim of [...recovered.expired, ...recovered.invalidated]) {
    result.events.push({ kind: "recovered", claimId: claim.claim_id, stepId: claim.step_id });
  }
}

async function admitReadySteps(
  input: OrchestrateFlowMultiCursorInput,
  ready: string[],
  result: FlowScheduleObservation,
): Promise<AdmittedExecution[]> {
  const attempts = await Promise.allSettled(ready.map((stepId) => admitStep(input, stepId, result)));
  const admitted = attempts
    .filter((attempt): attempt is PromiseFulfilledResult<AdmittedExecution | null> => attempt.status === "fulfilled")
    .map((attempt) => attempt.value)
    .filter((claim): claim is AdmittedExecution => claim !== null);
  const failures = attempts
    .filter((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected")
    .map((attempt) => attempt.reason);
  if (failures.length === 0) return admitted;
  const cleanup = await Promise.allSettled(
    admitted.map((claim) => releaseAdmitted(input, claim, result, "admission-round-failed")),
  );
  const cleanupFailures = cleanup
    .filter((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected")
    .map((attempt) => attempt.reason);
  throw new AggregateError([...failures, ...cleanupFailures], "multi-cursor admission round failed");
}

/** Dispatch Flow-ready work only after Flow grants durable, resource-safe claims. */
export async function orchestrateFlowMultiCursor(input: OrchestrateFlowMultiCursorInput): Promise<FlowScheduleObservation> {
  validateInput(input);
  const startingRun = await loadRun(input.runId, input.cwd);
  const result = observation(input, startingRun);
  const maxRounds = input.maxRounds ?? 100;
  try {
    await recoverClaims(input, result);
    for (let round = 0; round < maxRounds; round += 1) {
      const ready = await readySteps(input, result);
      if (ready.length === 0) return finalizeObservation(input, result);
      const admitted = await admitReadySteps(input, ready, result);
      if (admitted.length === 0) return finalizeObservation(input, result);
      const barrier = roundBarrier(admitted.length);
      const executions = await Promise.allSettled(admitted.map((claim) => executeAdmitted(input, claim, result, barrier)));
      const failure = executions.find((execution): execution is PromiseRejectedResult => execution.status === "rejected");
      if (failure) throw failure.reason;
    }
    if ((await readySteps(input, result)).length === 0) return finalizeObservation(input, result);
    throw new Error(`multi-cursor orchestration exceeded ${maxRounds} rounds`);
  } catch (error) {
    let failure = error;
    try { await finalizeObservation(input, result); }
    catch (finalizationError) {
      failure = new AggregateError([error, finalizationError], "multi-cursor failure and final observation capture both failed");
    }
    if (failure instanceof FlowMultiCursorOrchestrationError) throw failure;
    throw new FlowMultiCursorOrchestrationError("multi-cursor orchestration failed", result, { cause: failure });
  }
}

async function readySteps(
  input: OrchestrateFlowMultiCursorInput,
  result: FlowScheduleObservation,
): Promise<string[]> {
  const run = await loadRun(input.runId, input.cwd);
  assertDefinitionUnchanged(result.definition, definitionIdentity(run.definition));
  return claimableMultiCursorSteps(run.definition, run.state)
    .filter((stepId) => !result.unsettledSteps.includes(stepId));
}

async function finalizeObservation(
  input: OrchestrateFlowMultiCursorInput,
  result: FlowScheduleObservation,
): Promise<FlowScheduleObservation> {
  const finalRun = await loadRun(input.runId, input.cwd);
  result.finalRunHead = flowRunHead(finalRun.state);
  return result;
}
