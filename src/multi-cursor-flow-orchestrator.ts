import { randomUUID } from "node:crypto";
import { setMaxListeners } from "node:events";
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
  /** Aborted on cancellation or lost liveness; callbacks must stop before returning. */
  signal: AbortSignal;
}

export interface OrchestrateFlowMultiCursorInput {
  runId: string;
  actor: FlowStepClaimActor;
  execute: (execution: FlowMultiCursorExecution) => Promise<void>;
  cwd?: string;
  leaseSeconds?: number;
  renewalIntervalMs?: number;
  /** Maximum dispatch rounds, including batches of a bounded ready frontier. Default: 100. */
  maxRounds?: number;
  /**
   * Maximum ready steps claimed per round, an integer from 1 through 1024.
   * Default: 64, bounding host fan-out while preserving smaller ready frontiers.
   */
  maxConcurrent?: number;
  signal?: AbortSignal;
  /**
   * Awaited lifecycle persistence; admitted and started must succeed before execute.
   * This observer provides neither budget reservation nor authorization proof.
   * Events for independent claims may overlap; each receives an isolated snapshot.
   * Renewal counts are coalesced while an observer is pending; observation is
   * joined before evaluation or release without pausing the lease heartbeat.
   */
  onEvent?: (event: FlowScheduleEvent) => Promise<void>;
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
  execution: AbortController;
  heartbeatStop: AbortController;
  heartbeat: Promise<void>;
  joinRenewalObservation: () => Promise<void>;
  failures: unknown[];
  claimOpen: boolean;
  detach: () => void;
}

interface ScheduleContext {
  input: OrchestrateFlowMultiCursorInput;
  result: FlowScheduleObservation;
  controller: AbortController;
  observerFailed: boolean;
  mutation: Promise<void>;
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
  const cap = input.maxConcurrent ?? 64;
  if (!Number.isInteger(cap) || cap < 1 || cap > 1024) {
    throw new TypeError("maxConcurrent must be an integer from 1 through 1024");
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

// Flow serializes run mutations itself. Queue this host's calls before entering
// that lock so a wide frontier cannot exhaust Flow's lock-wait timeout.
function mutateFlow<T>(context: ScheduleContext, operation: () => Promise<T>): Promise<T> {
  const pending = context.mutation.then(operation);
  context.mutation = pending.then(() => undefined, () => undefined);
  return pending;
}

async function observe(context: ScheduleContext, event: FlowScheduleEvent): Promise<void> {
  context.result.events.push(event);
  await notify(context, event);
}

async function notify(context: ScheduleContext, event: FlowScheduleEvent): Promise<void> {
  try {
    await context.input.onEvent?.(structuredClone(event));
  } catch (error) {
    context.observerFailed = true;
    context.controller.abort(error);
    throw error;
  }
}

function startHeartbeat(context: ScheduleContext, claim: FlowDurableStepClaim): AdmittedExecution {
  const execution = new AbortController();
  const heartbeatStop = new AbortController();
  const relayAbort = () => execution.abort(context.controller.signal.reason);
  context.controller.signal.addEventListener("abort", relayAbort, { once: true });
  if (context.controller.signal.aborted) relayAbort();
  const admitted: AdmittedExecution = {
    claim,
    livenessId: claim.liveness_id,
    execution,
    heartbeatStop,
    heartbeat: Promise.resolve(),
    joinRenewalObservation: async () => {},
    failures: [],
    claimOpen: true,
    detach: () => context.controller.signal.removeEventListener("abort", relayAbort),
  };
  admitted.heartbeat = renewUntilStopped(context, admitted).catch((error) => {
    admitted.failures.push(error);
    execution.abort(error);
  });
  return admitted;
}

async function stopHeartbeat(admitted: AdmittedExecution): Promise<void> {
  admitted.heartbeatStop.abort();
  await admitted.heartbeat;
  admitted.detach();
}

async function admitStep(context: ScheduleContext, stepId: string): Promise<AdmittedExecution | null> {
  const { input, result } = context;
  context.controller.signal.throwIfAborted();
  const identity = identityFor(input, stepId);
  context.controller.signal.throwIfAborted();
  let claimed: Awaited<ReturnType<typeof claimReadyStep>>;
  try {
    claimed = await mutateFlow(context, () => {
      context.controller.signal.throwIfAborted();
      return claimReadyStep(input.runId, {
        claim_id: identity.claimId,
        liveness_id: identity.livenessId,
        step_id: stepId,
        actor: input.actor,
        lease_seconds: input.leaseSeconds,
        cwd: input.cwd,
      });
    });
  } catch (error) {
    if (!isResourceConflict(error)) throw error;
    await observe(context, {
      kind: "deferred",
      stepId,
      diagnosticCode: error.code,
      summary: "Flow deferred the step because a declared mutable resource is already claimed.",
    });
    if (!result.deferredSteps.includes(stepId)) result.deferredSteps.push(stepId);
    return null;
  }
  const admitted = startHeartbeat(context, claimed.claim);
  let reason = "definition-identity-drift";
  try {
    assertDefinitionUnchanged(result.definition, admitted.claim.definition);
    reason = "admission-round-failed";
    context.controller.signal.throwIfAborted();
    await observe(context, {
      kind: "admitted",
      claimId: admitted.claim.claim_id,
      livenessId: admitted.livenessId,
      stepId,
      mutableResources: [...admitted.claim.mutable_resources],
    });
    admitted.execution.signal.throwIfAborted();
    return admitted;
  } catch (error) {
    await admitted.joinRenewalObservation();
    const failures = [error, ...admitted.failures.filter((failure) => failure !== error)];
    try { await releaseAdmitted(context, admitted, reason); }
    catch (releaseError) { failures.push(releaseError); }
    finally { await stopHeartbeat(admitted); }
    throw new AggregateError(failures, "multi-cursor unused claim cleanup");
  }
}

async function renewUntilStopped(context: ScheduleContext, admitted: AdmittedExecution): Promise<void> {
  const { input, result } = context;
  const signal = admitted.heartbeatStop.signal;
  const interval = input.renewalIntervalMs ?? Math.max(250, Math.floor((input.leaseSeconds ?? 300) * 500));
  let pendingObservation: Promise<void> | undefined;
  let observedCount = 0;
  let joiningObservation = false;
  let renewal: Extract<FlowScheduleEvent, { kind: "renewed" }> | undefined;
  const observeRenewal = (event: Extract<FlowScheduleEvent, { kind: "renewed" }>) => {
    observedCount = event.count;
    return notify(context, event).catch((error) => { admitted.failures.push(error); });
  };
  admitted.joinRenewalObservation = async () => {
    // Stop launching observers, not renewals. A slow final observer must not
    // outlive the lease that Flow still needs for evaluation or exact release.
    joiningObservation = true;
    await pendingObservation;
    if (renewal && renewal.count > observedCount && !context.observerFailed) await observeRenewal(renewal);
  };
  while (!signal.aborted) {
    try {
      await delay(interval, undefined, { signal });
    } catch (error) {
      if (signal.aborted) break;
      throw error;
    }
    if (signal.aborted) break;
    try {
      const renewed = await mutateFlow(context, async () => {
        // Recheck inside the queue: an earlier evaluation/release may have
        // consumed this claim while this renewal was waiting for its turn.
        if (!admitted.claimOpen || signal.aborted) return false;
        await renewStepClaim(input.runId, {
          claim_id: admitted.claim.claim_id,
          liveness_id: admitted.livenessId,
          actor: input.actor,
          lease_seconds: input.leaseSeconds,
          cwd: input.cwd,
        });
        return true;
      });
      if (!renewed) break;
    } catch (error) {
      admitted.execution.abort(error);
      throw error;
    }
    if (renewal) renewal.count += 1;
    else {
      renewal = { kind: "renewed", claimId: admitted.claim.claim_id, stepId: admitted.claim.step_id, count: 1 };
      result.events.push(renewal);
    }
    // At most one pending renewal observer per claim; lease renewal continues
    // even when persistence is slow or has already aborted execution.
    if (!joiningObservation && !context.observerFailed && !pendingObservation) {
      pendingObservation = observeRenewal(renewal).finally(() => { pendingObservation = undefined; });
    }
  }
}

async function releaseAdmitted(context: ScheduleContext, admitted: AdmittedExecution, reason: string): Promise<void> {
  const { input } = context;
  await mutateFlow(context, async () => {
    await releaseStepClaim(input.runId, {
      claim_id: admitted.claim.claim_id,
      liveness_id: admitted.livenessId,
      actor: input.actor,
      reason,
      cwd: input.cwd,
    });
    admitted.claimOpen = false;
  });
  await observe(context, { kind: "released", claimId: admitted.claim.claim_id, stepId: admitted.claim.step_id, reason });
}

async function executeAdmitted(context: ScheduleContext, admitted: AdmittedExecution, barrier: RoundBarrier): Promise<void> {
  const { input, result } = context;
  const failures: unknown[] = [];
  try {
    admitted.execution.signal.throwIfAborted();
    await observe(context, { kind: "started", claimId: admitted.claim.claim_id, stepId: admitted.claim.step_id });
    admitted.execution.signal.throwIfAborted();
    await input.execute({
      claim: structuredClone(admitted.claim),
      runId: input.runId,
      cwd: input.cwd ?? process.cwd(),
      signal: admitted.execution.signal,
    });
    admitted.execution.signal.throwIfAborted();
  } catch (error) {
    failures.push(error);
    admitted.execution.abort(error);
  }
  // Flow evaluation can route back and invalidate sibling claims. Every host
  // must have stopped first, with heartbeats kept alive across the barrier.
  await barrier.arrive();
  await admitted.joinRenewalObservation();
  failures.push(...admitted.failures.filter((error) => !failures.includes(error)));
  try {
    context.controller.signal.throwIfAborted();
    admitted.execution.signal.throwIfAborted();
    if (failures.length > 0) throw new AggregateError(failures, "host execution failed");
    const evaluated = await mutateFlow(context, async () => {
      context.controller.signal.throwIfAborted();
      admitted.execution.signal.throwIfAborted();
      const evaluation = await evaluateClaimedStep(input.runId, {
        claim_id: admitted.claim.claim_id,
        liveness_id: admitted.livenessId,
        actor: input.actor,
        cwd: input.cwd,
      });
      if (evaluation.settled) admitted.claimOpen = false;
      return evaluation;
    });
    await observe(context, { kind: "settled", claimId: admitted.claim.claim_id, stepId: admitted.claim.step_id, settled: evaluated.settled });
    if (!evaluated.settled) {
      result.unsettledSteps.push(admitted.claim.step_id);
      await releaseAdmitted(context, admitted, "gate-not-settled");
    }
  } catch (error) {
    if (!failures.includes(error)) failures.push(error);
    try { if (admitted.claimOpen) await releaseAdmitted(context, admitted, "host-execution-failed"); }
    catch (releaseError) { failures.push(releaseError); }
    try {
      await observe(context, {
        kind: "failed", claimId: admitted.claim.claim_id, stepId: admitted.claim.step_id,
        summary: "Host execution or exact-claim cleanup failed.",
      });
    } catch (observerError) { failures.push(observerError); }
    throw new AggregateError(failures, "multi-cursor host execution and cleanup failed");
  } finally {
    await stopHeartbeat(admitted);
  }
}

async function recoverClaims(context: ScheduleContext): Promise<void> {
  const { input } = context;
  const recovered = await recoverExpiredStepClaims(input.runId, { cwd: input.cwd });
  for (const claim of [...recovered.expired, ...recovered.invalidated]) {
    await observe(context, { kind: "recovered", claimId: claim.claim_id, stepId: claim.step_id });
  }
}

async function admitReadySteps(context: ScheduleContext, ready: string[]): Promise<AdmittedExecution[]> {
  const attempts = await Promise.allSettled(ready.map((stepId) => admitStep(context, stepId)));
  const admitted = attempts
    .filter((attempt): attempt is PromiseFulfilledResult<AdmittedExecution | null> => attempt.status === "fulfilled")
    .map((attempt) => attempt.value)
    .filter((claim): claim is AdmittedExecution => claim !== null);
  const failures = attempts
    .filter((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected")
    .map((attempt) => attempt.reason);
  if (failures.length === 0 && !context.controller.signal.aborted) return admitted;
  if (context.controller.signal.aborted) failures.push(context.controller.signal.reason);
  const cleanup = await Promise.allSettled(admitted.map(async (claim) => {
    await claim.joinRenewalObservation();
    try { await releaseAdmitted(context, claim, "admission-round-failed"); }
    finally { await stopHeartbeat(claim); }
  }));
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
  const controller = new AbortController();
  setMaxListeners(input.maxConcurrent ?? 64, controller.signal);
  const relayAbort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", relayAbort, { once: true });
  if (input.signal?.aborted) relayAbort();
  const context: ScheduleContext = { input, result, controller, observerFailed: false, mutation: Promise.resolve() };
  const maxRounds = input.maxRounds ?? 100;
  const deferredFrontier = new Set<string>();
  try {
    controller.signal.throwIfAborted();
    await recoverClaims(context);
    for (let round = 0; round < maxRounds; round += 1) {
      controller.signal.throwIfAborted();
      const ready = (await readySteps(input, result)).filter((stepId) => !deferredFrontier.has(stepId));
      controller.signal.throwIfAborted();
      if (ready.length === 0) return await finalizeObservation(input, result);
      const batch = ready.slice(0, input.maxConcurrent ?? 64);
      const admitted = await admitReadySteps(context, batch);
      if (admitted.length === 0) {
        for (const stepId of batch) deferredFrontier.add(stepId);
        continue;
      }
      deferredFrontier.clear();
      const barrier = roundBarrier(admitted.length);
      const executions = await Promise.allSettled(admitted.map((claim) => executeAdmitted(context, claim, barrier)));
      const failures = executions
        .filter((execution): execution is PromiseRejectedResult => execution.status === "rejected")
        .map((execution) => execution.reason);
      if (failures.length > 0) throw new AggregateError(failures, "multi-cursor execution round failed");
    }
    controller.signal.throwIfAborted();
    if ((await readySteps(input, result)).every((stepId) => deferredFrontier.has(stepId))) return await finalizeObservation(input, result);
    throw new Error(`multi-cursor orchestration exceeded ${maxRounds} rounds`);
  } catch (error) {
    let failure = error;
    try { await finalizeObservation(input, result); }
    catch (finalizationError) {
      failure = new AggregateError([error, finalizationError], "multi-cursor failure and final observation capture both failed");
    }
    throw new FlowMultiCursorOrchestrationError("multi-cursor orchestration failed", result, { cause: failure });
  } finally {
    input.signal?.removeEventListener("abort", relayAbort);
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
