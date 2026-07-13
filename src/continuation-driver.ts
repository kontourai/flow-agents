import * as path from "node:path";
import { inspectBuilderFlowSession, syncBuilderFlowSession } from "./builder-flow-runtime.js";
import {
  gateActionProgressSnapshot,
  withGateActionPriorProgress,
  type GateActionEnvelope,
  type GateActionPriorProgress,
  type GateActionProgressSnapshot,
} from "./builder-gate-action-envelope.js";
import { createFileContinuationStore } from "./continuation-persistence.js";
import { assertMaxTurns, assertMissionIdentity, validateSnapshot, validateState, validateTurnResult } from "./continuation-validation.js";

export { MAX_CONTINUATION_TURNS, createFileContinuationStore, withContinuationDriverLock } from "./continuation-persistence.js";
export { MAX_CONTINUATION_ADAPTER_EVIDENCE_BYTES, MAX_CONTINUATION_TURN_RESULT_BYTES } from "./continuation-validation.js";

export type ContinuationBarrier =
  | { kind: "pid"; pid: number }
  | { kind: "deadline"; at: string };

export type ContinuationSnapshot = {
  run_id: string;
  definition_id: string;
  status: string;
  disposition: "continue" | "waiting" | "done" | "failed";
  current_step: string;
  next_action: Record<string, unknown> | null;
  /** Additive Builder-specific execution context. Generic adapters may ignore it. */
  gate_action_envelope?: GateActionEnvelope;
};

export type ContinuationTurnRequest = {
  schema_version: "1.0";
  run_id: string;
  definition_id: string;
  current_step: string;
  iteration: number;
  max_turns: number;
  next_action: Record<string, unknown> | null;
  /** Additive schema-1.0 field; older external adapters remain valid. */
  gate_action_envelope?: GateActionEnvelope;
};

export type ContinuationTurnResult =
  | { status: "completed"; summary?: string; evidence?: Record<string, unknown> }
  | { status: "wait"; barrier: ContinuationBarrier; summary?: string };


export class ContinuationAdapterTimeoutError extends Error {
  readonly code = "CONTINUATION_ADAPTER_TIMEOUT";

  constructor(timeoutMs: number) {
    super(`continuation adapter timed out after ${timeoutMs}ms`);
    this.name = "ContinuationAdapterTimeoutError";
  }
}

export type ContinuationDriverState = {
  schema_version: "1.0";
  run_id: string;
  definition_id: string;
  max_turns: number;
  adapter_command_identity: string | null;
  status: "active" | "waiting" | "done" | "failed" | "budget_exhausted";
  turns_started: number;
  // Added after schema 1.0 shipped. Legacy state files may omit it.
  active_turn_step?: string | null;
  // Anchors the ephemeral signer outside active-turn.json. Legacy state files may omit it.
  active_turn_public_key_digest?: string | null;
  /** Durable recovery marker for an adapter turn without a post-turn measurement. */
  active_turn_phase?: "prepared" | "started" | "measured" | null;
  active_turn_progress?: GateActionProgressSnapshot | null;
  /** Crash-recovery journal entry retained until capture and audit are durable. */
  active_turn_capture?: ContinuationAcceptedTurn | null;
  /** Last canonical progress observed after an adapter turn. Additive to state schema 1.0. */
  last_progress?: GateActionProgressSnapshot | null;
  prior_progress?: GateActionPriorProgress | null;
  pending_barrier: ContinuationBarrier | null;
  updated_at: string;
};

export type ContinuationDriverEvent = {
  schema_version: "1.0";
  type: "started" | "turn_started" | "turn_completed" | "turn_recovered" | "gate_not_advanced" | "turn_failed" | "authority_cleanup_failed" | "parked" | "resumed" | "done" | "budget_exhausted";
  run_id: string;
  definition_id: string;
  current_step: string;
  turns_started: number;
  at: string;
  barrier?: ContinuationBarrier;
  summary?: string;
  failure_kind?: "adapter_error" | "timeout";
  progress?: GateActionPriorProgress;
  turn_id?: string;
};

export type ContinuationAcceptedTurn = {
  schema_version: "1.0";
  turn_id: string;
  iteration: number;
  request: ContinuationTurnRequest;
  result: ContinuationTurnResult;
  progress: GateActionPriorProgress | null;
  captured_at: string;
};

export interface ContinuationStateStore {
  load(): ContinuationDriverState | null;
  save(state: ContinuationDriverState): void;
  append(event: ContinuationDriverEvent): void;
  captureAcceptedTurn(turn: ContinuationAcceptedTurn): void;
  acceptedTurns(): ContinuationAcceptedTurn[];
}

export interface ContinuationRuntimePort {
  inspect(): Promise<ContinuationSnapshot>;
  synchronize(): Promise<ContinuationSnapshot>;
  execute(request: ContinuationTurnRequest, context?: ContinuationTurnContext): Promise<ContinuationTurnResult>;
}

export type ContinuationTurnContext = {
  continuationTurnSecret?: string;
  continuationRunId?: string;
};

export type ContinuationDriverLockLease = {
  pid: number;
  token: string;
  created_at: string;
};

export type ContinuationTurnAuthority = {
  runId: string;
  turnSecret: string;
  publicKeyDigest: string;
  cleanup(): boolean;
};

export type ContinuationDriverOutcome = {
  outcome: "done" | "waiting" | "failed" | "budget_exhausted";
  turns_started: number;
  snapshot: ContinuationSnapshot;
  barrier?: ContinuationBarrier;
};

export interface RunContinuationDriverInput {
  maxTurns: number;
  adapterCommandIdentity?: string;
  runtime: ContinuationRuntimePort;
  store: ContinuationStateStore;
  waitForBarrier?: (barrier: ContinuationBarrier) => Promise<"ready" | "pending">;
  authorizeTurn?: () => Promise<void>;
  issueTurnAuthority?: (request: ContinuationTurnRequest) => Promise<ContinuationTurnAuthority>;
  preflightTurn?: (request: ContinuationTurnRequest) => void | Promise<void>;
  onTurnAccepted?: (request: ContinuationTurnRequest, result: ContinuationTurnResult) => void | Promise<void>;
  now?: () => Date;
}

export interface DriveBuilderFlowSessionInput {
  sessionDir: string;
  maxTurns: number;
  adapterCommandIdentity?: string;
  execute: ContinuationRuntimePort["execute"];
  waitForBarrier?: RunContinuationDriverInput["waitForBarrier"];
  authorizeTurn?: RunContinuationDriverInput["authorizeTurn"];
  issueTurnAuthority?: RunContinuationDriverInput["issueTurnAuthority"];
  preflightTurn?: RunContinuationDriverInput["preflightTurn"];
  onTurnAccepted?: RunContinuationDriverInput["onTurnAccepted"];
  now?: () => Date;
  store?: ContinuationStateStore;
}

export async function runContinuationDriver(input: RunContinuationDriverInput): Promise<ContinuationDriverOutcome> {
  assertMaxTurns(input.maxTurns);
  const now = input.now ?? (() => new Date());
  const adapterCommandIdentity = input.adapterCommandIdentity ?? null;
  const inspected = validateSnapshot(await input.runtime.inspect());
  let state = loadOrCreateState(input.store, inspected, input.maxTurns, adapterCommandIdentity, now);
  if (state.max_turns !== input.maxTurns) throw new Error(`continuation maxTurns ${input.maxTurns} does not match the persisted mission budget ${state.max_turns}`);
  if (state.adapter_command_identity !== adapterCommandIdentity) throw new Error("continuation adapter command identity does not match the persisted mission adapter");
  let settled = await settleMissionStart(input, state, now);
  if (settled.outcome) return settled.outcome;
  ({ state } = settled);
  let snapshot = settled.snapshot;
  while (state.turns_started < input.maxTurns) {
    const turn = await executeContinuationTurn(input, state, snapshot, now);
    if (turn.outcome) return turn.outcome;
    state = turn.state;
    snapshot = turn.snapshot;
  }
  return finishBudgetExhausted(input.store, state, snapshot, now);
}

type MissionPosition = { state: ContinuationDriverState; snapshot: ContinuationSnapshot; outcome?: ContinuationDriverOutcome };
type TurnCaptureFailure = Error & { cause: unknown; capture_failure: true };

async function settleMissionStart(input: RunContinuationDriverInput, state: ContinuationDriverState, now: () => Date): Promise<MissionPosition> {
  let position = await synchronizeAndRecover(input, state, now);
  if (position.state.pending_barrier && new Set(["done", "failed"]).has(canonicalOutcome(position.snapshot))) {
    const barrier = position.state.pending_barrier;
    position.state = saveState(input.store, position.state, { status: "active", pending_barrier: null }, now);
    appendEvent(input.store, position.state, position.snapshot, "resumed", now, { barrier, summary: "canonical Flow resolved the pending barrier" });
  }
  const terminal = resolveCanonicalDisposition(input.store, position.state, position.snapshot, now, false);
  if (terminal) return { ...position, outcome: terminal };
  if (position.state.pending_barrier) {
    const barrier = position.state.pending_barrier;
    const readiness = await (input.waitForBarrier ?? (async () => "pending" as const))(barrier);
    if (readiness === "pending") {
      const waiting = saveState(input.store, position.state, { status: "waiting" }, now);
      return { state: waiting, snapshot: position.snapshot, outcome: { outcome: "waiting", turns_started: waiting.turns_started, snapshot: position.snapshot, barrier } };
    }
    position.state = saveState(input.store, position.state, { status: "active", pending_barrier: null }, now);
    appendEvent(input.store, position.state, position.snapshot, "resumed", now, { barrier });
    position = await synchronizeAndRecover(input, position.state, now);
  }
  const disposition = resolveCanonicalDisposition(input.store, position.state, position.snapshot, now, true);
  return disposition ? { ...position, outcome: disposition } : position;
}

async function synchronizeAndRecover(input: RunContinuationDriverInput, state: ContinuationDriverState, now: () => Date): Promise<MissionPosition> {
  const snapshot = validateSnapshot(await input.runtime.synchronize());
  assertMissionIdentity(state, snapshot);
  const recovered = reconcileInterruptedTurn(input.store, state, snapshot, now);
  return { state: reconcileProgress(input.store, recovered, snapshot, now), snapshot };
}

function resolveCanonicalDisposition(
  store: ContinuationStateStore,
  state: ContinuationDriverState,
  snapshot: ContinuationSnapshot,
  now: () => Date,
  includeWaiting: boolean,
): ContinuationDriverOutcome | null {
  const disposition = canonicalOutcome(snapshot);
  if (disposition === "done") return finishDone(store, state, snapshot, now);
  if (disposition === "failed") return finishFailed(store, state, snapshot, now);
  if (includeWaiting && disposition === "waiting") {
    const waiting = saveState(store, state, { status: "waiting" }, now);
    return { outcome: "waiting", turns_started: waiting.turns_started, snapshot };
  }
  return null;
}

async function executeContinuationTurn(
  input: RunContinuationDriverInput,
  current: ContinuationDriverState,
  snapshot: ContinuationSnapshot,
  now: () => Date,
): Promise<MissionPosition> {
  await (input.authorizeTurn ?? (async () => {}))();
  const request = continuationTurnRequest(input, current, snapshot);
  if (input.preflightTurn) await input.preflightTurn(request);
  let state = beginContinuationTurn(input.store, current, snapshot, request.iteration, now);
  let authority: ContinuationTurnAuthority | undefined;
  try {
    authority = input.issueTurnAuthority ? await input.issueTurnAuthority(request) : undefined;
    if (authority) state = saveState(input.store, state, { active_turn_public_key_digest: authority.publicKeyDigest }, now);
    const result = validateTurnResult(await input.runtime.execute(request, authorityContext(authority)));
    return await recordAcceptedTurn(input, state, snapshot, request, result, now);
  } catch (error) {
    const failed = await recordFailedTurn(input, input.store.load() ?? state, snapshot, error, now);
    if (isTurnCaptureFailure(error)) throw error.cause;
    return failed;
  } finally {
    auditAuthorityCleanup(input.store, state, snapshot, authority, now);
  }
}

function continuationTurnRequest(input: RunContinuationDriverInput, state: ContinuationDriverState, snapshot: ContinuationSnapshot): ContinuationTurnRequest {
  const envelope = snapshot.gate_action_envelope
    ? withGateActionPriorProgress(snapshot.gate_action_envelope, state.prior_progress ?? initialProgress())
    : undefined;
  return Object.freeze({
    schema_version: "1.0",
    run_id: snapshot.run_id,
    definition_id: snapshot.definition_id,
    current_step: snapshot.current_step,
    iteration: state.turns_started + 1,
    max_turns: input.maxTurns,
    next_action: snapshot.next_action ? structuredClone(snapshot.next_action) : null,
    ...(envelope ? { gate_action_envelope: envelope } : {}),
  });
}

function beginContinuationTurn(store: ContinuationStateStore, state: ContinuationDriverState, snapshot: ContinuationSnapshot, iteration: number, now: () => Date): ContinuationDriverState {
  let started = saveState(store, state, {
    status: "active", turns_started: iteration, active_turn_step: snapshot.current_step,
    active_turn_public_key_digest: null, active_turn_phase: "prepared", active_turn_progress: progressSnapshot(snapshot), active_turn_capture: null,
  }, now);
  appendEvent(store, started, snapshot, "turn_started", now);
  started = saveState(store, started, { active_turn_phase: "started" }, now);
  return started;
}

function authorityContext(authority: ContinuationTurnAuthority | undefined): ContinuationTurnContext | undefined {
  return authority ? { continuationTurnSecret: authority.turnSecret, continuationRunId: authority.runId } : undefined;
}

async function captureAcceptedTurn(
  callback: NonNullable<RunContinuationDriverInput["onTurnAccepted"]>,
  request: ContinuationTurnRequest,
  result: ContinuationTurnResult,
): Promise<void> {
  try {
    await callback(request, result);
  } catch (cause) {
    const error = new Error(boundedErrorMessage(cause)) as TurnCaptureFailure;
    error.cause = cause;
    error.capture_failure = true;
    throw error;
  }
}

function isTurnCaptureFailure(error: unknown): error is TurnCaptureFailure {
  return error instanceof Error && (error as Partial<TurnCaptureFailure>).capture_failure === true;
}

async function recordFailedTurn(
  input: RunContinuationDriverInput,
  state: ContinuationDriverState,
  previous: ContinuationSnapshot,
  error: unknown,
  now: () => Date,
): Promise<MissionPosition> {
  const measured = state.active_turn_phase === "measured" && state.active_turn_capture
    ? { state, snapshot: validateSnapshot(await input.runtime.synchronize()), progress: state.active_turn_capture.progress ?? undefined }
    : await synchronizeTurnMeasurement(input, state, previous, null, null, now);
  appendEvent(input.store, measured.state, measured.snapshot, "turn_failed", now, {
    summary: boundedErrorMessage(error),
    failure_kind: error instanceof ContinuationAdapterTimeoutError ? "timeout" : "adapter_error",
    ...(measured.progress ? { progress: measured.progress } : {}),
    ...(measured.state.active_turn_capture ? { turn_id: measured.state.active_turn_capture.turn_id } : {}),
  });
  const cleared = clearActiveTurn(input.store, measured.state, now);
  const outcome = resolveCanonicalDisposition(input.store, cleared, measured.snapshot, now, true);
  return outcome ? { state: cleared, snapshot: measured.snapshot, outcome } : { ...measured, state: cleared };
}

async function recordAcceptedTurn(
  input: RunContinuationDriverInput,
  state: ContinuationDriverState,
  previous: ContinuationSnapshot,
  request: ContinuationTurnRequest,
  result: ContinuationTurnResult,
  now: () => Date,
): Promise<MissionPosition> {
  let measured = await synchronizeTurnMeasurement(input, state, previous, request, result, now);
  const capture = measured.state.active_turn_capture!;
  input.store.captureAcceptedTurn(capture);
  if (input.onTurnAccepted) await captureAcceptedTurn(input.onTurnAccepted, request, result);
  if (result.status === "wait") return parkAcceptedTurn(input, measured, result, now);
  appendEvent(input.store, measured.state, measured.snapshot, "turn_completed", now, {
    summary: result.summary,
    ...(measured.progress ? { progress: measured.progress } : {}),
    turn_id: capture.turn_id,
  });
  measured = { ...measured, state: clearActiveTurn(input.store, measured.state, now) };
  if (measured.snapshot.status === "active" && measured.snapshot.current_step === request.current_step) {
    appendEvent(input.store, measured.state, measured.snapshot, "gate_not_advanced", now, { summary: "adapter completed without canonical gate advancement" });
  }
  const outcome = resolveCanonicalDisposition(input.store, measured.state, measured.snapshot, now, true);
  return outcome ? { state: measured.state, snapshot: measured.snapshot, outcome } : measured;
}

async function parkAcceptedTurn(
  input: RunContinuationDriverInput,
  measured: MissionPosition & { progress?: GateActionPriorProgress },
  result: Extract<ContinuationTurnResult, { status: "wait" }>,
  now: () => Date,
): Promise<MissionPosition> {
  let state = saveState(input.store, measured.state, { status: "waiting", pending_barrier: result.barrier }, now);
  const turnId = state.active_turn_capture!.turn_id;
  appendEvent(input.store, state, measured.snapshot, "parked", now, {
    barrier: result.barrier, summary: result.summary, ...(measured.progress ? { progress: measured.progress } : {}), turn_id: turnId,
  });
  state = clearActiveTurn(input.store, state, now);
  const readiness = await (input.waitForBarrier ?? (async () => "pending" as const))(result.barrier);
  if (readiness === "pending") {
    return { state, snapshot: measured.snapshot, outcome: { outcome: "waiting", turns_started: state.turns_started, snapshot: measured.snapshot, barrier: result.barrier } };
  }
  state = saveState(input.store, state, { status: "active", pending_barrier: null }, now);
  appendEvent(input.store, state, measured.snapshot, "resumed", now, { barrier: result.barrier });
  const resumed = await synchronizeAndRecover(input, state, now);
  const outcome = resolveCanonicalDisposition(input.store, resumed.state, resumed.snapshot, now, true);
  return outcome ? { ...resumed, outcome } : resumed;
}

async function synchronizeTurnMeasurement(
  input: RunContinuationDriverInput,
  state: ContinuationDriverState,
  previous: ContinuationSnapshot,
  request: ContinuationTurnRequest | null,
  result: ContinuationTurnResult | null,
  now: () => Date,
): Promise<MissionPosition & { progress?: GateActionPriorProgress }> {
  const snapshot = validateSnapshot(await input.runtime.synchronize());
  assertMissionIdentity(state, snapshot);
  const before = state.active_turn_progress ?? state.last_progress ?? progressSnapshot(previous);
  const progress = measureProgress(state, before, progressSnapshot(snapshot));
  const capture = request && result ? acceptedTurnCapture(request, result, progress?.delta ?? null, now) : null;
  const measured = saveState(input.store, state, {
    ...(progress ? { last_progress: progress.snapshot, prior_progress: progress.delta } : {}),
    ...(capture ? { active_turn_phase: "measured", active_turn_capture: capture } : {}),
  }, now);
  return { state: measured, snapshot, ...(progress ? { progress: progress.delta } : {}) };
}

function acceptedTurnCapture(request: ContinuationTurnRequest, result: ContinuationTurnResult, progress: GateActionPriorProgress | null, now: () => Date): ContinuationAcceptedTurn {
  return {
    schema_version: "1.0",
    turn_id: `${request.run_id}:${request.iteration}`,
    iteration: request.iteration,
    request: structuredClone(request),
    result: structuredClone(result),
    progress: progress ? structuredClone(progress) : null,
    captured_at: now().toISOString(),
  };
}

function clearActiveTurn(store: ContinuationStateStore, state: ContinuationDriverState, now: () => Date): ContinuationDriverState {
  return saveState(store, state, {
    active_turn_step: null,
    active_turn_public_key_digest: null,
    active_turn_phase: null,
    active_turn_progress: null,
    active_turn_capture: null,
  }, now);
}

function auditAuthorityCleanup(
  store: ContinuationStateStore,
  state: ContinuationDriverState,
  snapshot: ContinuationSnapshot,
  authority: ContinuationTurnAuthority | undefined,
  now: () => Date,
): void {
  let summary: string | undefined;
  try {
    if (authority && !authority.cleanup()) summary = "continuation turn authority cleanup returned false";
  } catch (error) {
    summary = boundedErrorMessage(error);
  }
  if (!summary) return;
  try {
    appendEvent(store, state, snapshot, "authority_cleanup_failed", now, { summary });
  } catch {
    // Audit is best effort. A cleanup extension must not replace the adapter outcome.
  }
}

function finishBudgetExhausted(store: ContinuationStateStore, state: ContinuationDriverState, snapshot: ContinuationSnapshot, now: () => Date): ContinuationDriverOutcome {
  const exhausted = saveState(store, state, {
    status: "budget_exhausted", active_turn_step: null, active_turn_public_key_digest: null,
    active_turn_phase: null, active_turn_progress: null, active_turn_capture: null,
  }, now);
  appendEvent(store, exhausted, snapshot, "budget_exhausted", now);
  return { outcome: "budget_exhausted", turns_started: exhausted.turns_started, snapshot };
}

export async function driveBuilderFlowSession(input: DriveBuilderFlowSessionInput): Promise<ContinuationDriverOutcome> {
  const sessionDir = path.resolve(input.sessionDir);
  const runtime: ContinuationRuntimePort = {
    inspect: async () => builderSessionSnapshot(await inspectBuilderFlowSession({ sessionDir })),
    synchronize: async () => builderSessionSnapshot(await syncBuilderFlowSession({ sessionDir })),
    execute: input.execute,
  };
  return runContinuationDriver({
      maxTurns: input.maxTurns,
      ...(input.adapterCommandIdentity ? { adapterCommandIdentity: input.adapterCommandIdentity } : {}),
    runtime,
    store: input.store ?? createFileContinuationStore(sessionDir),
    ...(input.waitForBarrier ? { waitForBarrier: input.waitForBarrier } : {}),
    ...(input.authorizeTurn ? { authorizeTurn: input.authorizeTurn } : {}),
    ...(input.issueTurnAuthority ? { issueTurnAuthority: input.issueTurnAuthority } : {}),
    ...(input.preflightTurn ? { preflightTurn: input.preflightTurn } : {}),
    ...(input.onTurnAccepted ? { onTurnAccepted: input.onTurnAccepted } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
}

function builderSessionSnapshot(result: Awaited<ReturnType<typeof inspectBuilderFlowSession>>): ContinuationSnapshot {
  const nextAction = result.projection.next_action;
  return validateSnapshot({
    run_id: result.run.runId,
    definition_id: result.run.definitionId,
    status: result.run.state.status,
    disposition: builderContinuationDisposition(result.projection.next_action),
    current_step: result.run.state.current_step,
    next_action: nextAction && typeof nextAction === "object" && !Array.isArray(nextAction)
      ? structuredClone(nextAction as Record<string, unknown>)
      : null,
    ...(result.gateActionEnvelope ? { gate_action_envelope: structuredClone(result.gateActionEnvelope) } : {}),
  });
}

function loadOrCreateState(
  store: ContinuationStateStore,
  snapshot: ContinuationSnapshot,
  maxTurns: number,
  adapterCommandIdentity: string | null,
  now: () => Date,
): ContinuationDriverState {
  const existing = store.load();
  if (existing) {
    validateState(existing);
    assertMissionIdentity(existing, snapshot);
    return existing;
  }
  const state: ContinuationDriverState = {
    schema_version: "1.0",
    run_id: snapshot.run_id,
    definition_id: snapshot.definition_id,
    max_turns: maxTurns,
    adapter_command_identity: adapterCommandIdentity,
    status: "active",
    turns_started: 0,
    active_turn_step: null,
    active_turn_public_key_digest: null,
    active_turn_phase: null,
    active_turn_progress: null,
    active_turn_capture: null,
    pending_barrier: null,
    updated_at: now().toISOString(),
  };
  store.save(state);
  appendEvent(store, state, snapshot, "started", now);
  return state;
}

function canonicalOutcome(snapshot: ContinuationSnapshot): "done" | "waiting" | "failed" | "continue" {
  return snapshot.disposition;
}

function reconcileProgress(
  store: ContinuationStateStore,
  state: ContinuationDriverState,
  snapshot: ContinuationSnapshot,
  now: () => Date,
): ContinuationDriverState {
  const current = progressSnapshot(snapshot);
  if (!current) return state;
  if (!state.last_progress) return saveState(store, state, { last_progress: current, prior_progress: initialProgress() }, now);
  if (sameProgressSnapshot(state.last_progress, current)) return state;
  const progress = measureProgress(state, state.last_progress, current);
  return progress ? saveState(store, state, { last_progress: progress.snapshot, prior_progress: progress.delta }, now) : state;
}

function reconcileInterruptedTurn(
  store: ContinuationStateStore,
  state: ContinuationDriverState,
  snapshot: ContinuationSnapshot,
  now: () => Date,
): ContinuationDriverState {
  if (!state.active_turn_phase) return state;
  if (state.active_turn_phase === "prepared") {
    return clearActiveTurn(store, state, now);
  }
  if (state.active_turn_phase === "measured") {
    if (!state.active_turn_capture) throw new Error("continuation measured turn is missing its durable capture");
    const capture = state.active_turn_capture;
    store.captureAcceptedTurn(capture);
    let recovered = capture.result.status === "wait"
      ? saveState(store, state, { status: "waiting", pending_barrier: capture.result.barrier }, now)
      : state;
    appendEvent(store, recovered, snapshot, capture.result.status === "wait" ? "parked" : "turn_completed", now, {
      ...(capture.result.status === "wait" ? { barrier: capture.result.barrier } : {}),
      ...(capture.result.summary ? { summary: capture.result.summary } : {}),
      ...(capture.progress ? { progress: capture.progress } : {}),
      turn_id: capture.turn_id,
    });
    recovered = clearActiveTurn(store, recovered, now);
    appendEvent(store, recovered, snapshot, "turn_recovered", now, {
      summary: "completed durable accepted-turn capture after interruption",
      ...(capture.progress ? { progress: capture.progress } : {}),
      turn_id: capture.turn_id,
    });
    return recovered;
  }
  const progress = measureProgress(state, state.active_turn_progress ?? state.last_progress ?? null, progressSnapshot(snapshot));
  const recovered = saveState(store, state, {
    ...(progress ? { last_progress: progress.snapshot, prior_progress: progress.delta } : {}),
    active_turn_step: null,
    active_turn_public_key_digest: null,
    active_turn_phase: null,
    active_turn_progress: null,
    active_turn_capture: null,
  }, now);
  appendEvent(store, recovered, snapshot, "turn_recovered", now, {
    summary: "recovered interrupted adapter turn from canonical Flow progress",
    ...(progress ? { progress: progress.delta } : {}),
  });
  return recovered;
}

function sameProgressSnapshot(left: GateActionProgressSnapshot, right: GateActionProgressSnapshot): boolean {
  return left.current_step === right.current_step
    && left.canonical_evidence.length === right.canonical_evidence.length
    && left.canonical_evidence.every((entry, index) => entry === right.canonical_evidence[index])
    && left.observed_artifacts.length === right.observed_artifacts.length
    && left.observed_artifacts.every((entry, index) => entry === right.observed_artifacts[index]);
}

function progressSnapshot(snapshot: ContinuationSnapshot): GateActionProgressSnapshot | null {
  return snapshot.gate_action_envelope ? gateActionProgressSnapshot(snapshot.gate_action_envelope) : null;
}

function initialProgress(): GateActionPriorProgress {
  return {
    step_advanced: false,
    evidence_added: [],
    artifact_changes: [],
    no_progress: false,
    consecutive_no_progress: 0,
    stagnation: "none",
  };
}

function measureProgress(
  state: ContinuationDriverState,
  before: GateActionProgressSnapshot | null,
  after: GateActionProgressSnapshot | null,
): { snapshot: GateActionProgressSnapshot; delta: GateActionPriorProgress } | null {
  if (!before || !after) return null;
  const stepAdvanced = before.current_step !== after.current_step;
  const evidenceAdded = after.canonical_evidence.filter((entry) => !before.canonical_evidence.includes(entry));
  const artifactChanges = after.observed_artifacts.filter((entry) => !before.observed_artifacts.includes(entry));
  const noProgress = !stepAdvanced && evidenceAdded.length === 0 && artifactChanges.length === 0;
  const consecutiveNoProgress = noProgress ? (state.prior_progress?.consecutive_no_progress ?? 0) + 1 : 0;
  return {
    snapshot: after,
    delta: {
      step_advanced: stepAdvanced,
      evidence_added: evidenceAdded,
      artifact_changes: artifactChanges,
      no_progress: noProgress,
      consecutive_no_progress: consecutiveNoProgress,
      stagnation: consecutiveNoProgress >= 2 ? "stagnant" : consecutiveNoProgress === 1 ? "possible" : "none",
    },
  };
}

function finishDone(store: ContinuationStateStore, state: ContinuationDriverState, snapshot: ContinuationSnapshot, now: () => Date): ContinuationDriverOutcome {
  const done = saveState(store, state, {
    status: "done",
    active_turn_step: null,
    active_turn_public_key_digest: null,
    active_turn_phase: null,
    active_turn_progress: null,
    active_turn_capture: null,
    pending_barrier: null,
  }, now);
  appendEvent(store, done, snapshot, "done", now);
  return { outcome: "done", turns_started: done.turns_started, snapshot };
}

function finishFailed(store: ContinuationStateStore, state: ContinuationDriverState, snapshot: ContinuationSnapshot, now: () => Date): ContinuationDriverOutcome {
  const failed = saveState(store, state, {
    status: "failed",
    active_turn_step: null,
    active_turn_public_key_digest: null,
    active_turn_phase: null,
    active_turn_progress: null,
    active_turn_capture: null,
    pending_barrier: null,
  }, now);
  return { outcome: "failed", turns_started: failed.turns_started, snapshot };
}

function saveState(
  store: ContinuationStateStore,
  current: ContinuationDriverState,
  patch: Partial<Pick<ContinuationDriverState, "status" | "turns_started" | "active_turn_step" | "active_turn_public_key_digest" | "active_turn_phase" | "active_turn_progress" | "active_turn_capture" | "pending_barrier" | "last_progress" | "prior_progress">>,
  now: () => Date,
): ContinuationDriverState {
  const next = { ...current, ...patch, updated_at: now().toISOString() };
  store.save(next);
  return next;
}

function appendEvent(
  store: ContinuationStateStore,
  state: ContinuationDriverState,
  snapshot: ContinuationSnapshot,
  type: ContinuationDriverEvent["type"],
  now: () => Date,
  extra: Pick<ContinuationDriverEvent, "barrier" | "summary" | "failure_kind" | "progress" | "turn_id"> = {},
): void {
  store.append({
    schema_version: "1.0",
    type,
    run_id: state.run_id,
    definition_id: state.definition_id,
    current_step: snapshot.current_step,
    turns_started: state.turns_started,
    at: now().toISOString(),
    ...(extra.barrier ? { barrier: extra.barrier } : {}),
    ...(extra.summary ? { summary: extra.summary } : {}),
    ...(extra.failure_kind ? { failure_kind: extra.failure_kind } : {}),
    ...(extra.progress ? { progress: structuredClone(extra.progress) } : {}),
    ...(extra.turn_id ? { turn_id: extra.turn_id } : {}),
  });
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 2_000 ? message : `${message.slice(0, 1_997)}...`;
}

function builderContinuationDisposition(nextAction: unknown): ContinuationSnapshot["disposition"] {
  if (!nextAction || typeof nextAction !== "object" || Array.isArray(nextAction)) throw new Error("Builder Flow projection is missing its canonical next action");
  const status = (nextAction as { status?: unknown }).status;
  if (status === "continue") return "continue";
  if (status === "blocked") return "waiting";
  if (status === "done") return "done";
  if (status === "failed") return "failed";
  throw new Error(`Builder Flow projection has unsupported next-action status: ${String(status)}`);
}
