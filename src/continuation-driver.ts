import * as fs from "node:fs";
import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { inspectBuilderFlowSession, syncBuilderFlowSession } from "./builder-flow-runtime.js";
import { atomicWriteJson, ensureSafeDirectory } from "./lib/fs.js";

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
};

export type ContinuationTurnRequest = {
  schema_version: "1.0";
  run_id: string;
  definition_id: string;
  current_step: string;
  iteration: number;
  max_turns: number;
  next_action: Record<string, unknown> | null;
};

export type ContinuationTurnResult =
  | { status: "completed"; summary?: string }
  | { status: "wait"; barrier: ContinuationBarrier; summary?: string };

export type ContinuationDriverState = {
  schema_version: "1.0";
  run_id: string;
  definition_id: string;
  max_turns: number;
  adapter_command_identity: string | null;
  status: "active" | "waiting" | "done" | "failed" | "budget_exhausted";
  turns_started: number;
  pending_barrier: ContinuationBarrier | null;
  updated_at: string;
};

export type ContinuationDriverEvent = {
  schema_version: "1.0";
  type: "started" | "turn_started" | "turn_completed" | "turn_failed" | "parked" | "resumed" | "done" | "budget_exhausted";
  run_id: string;
  definition_id: string;
  current_step: string;
  turns_started: number;
  at: string;
  barrier?: ContinuationBarrier;
  summary?: string;
};

export interface ContinuationStateStore {
  load(): ContinuationDriverState | null;
  save(state: ContinuationDriverState): void;
  append(event: ContinuationDriverEvent): void;
}

export interface ContinuationRuntimePort {
  inspect(): Promise<ContinuationSnapshot>;
  synchronize(): Promise<ContinuationSnapshot>;
  execute(request: ContinuationTurnRequest): Promise<ContinuationTurnResult>;
}

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
  now?: () => Date;
}

export interface DriveBuilderFlowSessionInput {
  sessionDir: string;
  maxTurns: number;
  adapterCommandIdentity?: string;
  execute: ContinuationRuntimePort["execute"];
  waitForBarrier?: RunContinuationDriverInput["waitForBarrier"];
  authorizeTurn?: RunContinuationDriverInput["authorizeTurn"];
  now?: () => Date;
}

export async function runContinuationDriver(input: RunContinuationDriverInput): Promise<ContinuationDriverOutcome> {
  assertMaxTurns(input.maxTurns);
  const now = input.now ?? (() => new Date());
  const waitForBarrier = input.waitForBarrier ?? (async () => "pending" as const);
  const authorizeTurn = input.authorizeTurn ?? (async () => {});
  const adapterCommandIdentity = input.adapterCommandIdentity ?? null;
  let snapshot = validateSnapshot(await input.runtime.inspect());
  let state = loadOrCreateState(input.store, snapshot, input.maxTurns, adapterCommandIdentity, now);
  if (state.max_turns !== input.maxTurns) throw new Error(`continuation maxTurns ${input.maxTurns} does not match the persisted mission budget ${state.max_turns}`);
  if (state.adapter_command_identity !== adapterCommandIdentity) throw new Error("continuation adapter command identity does not match the persisted mission adapter");

  const inspectedOutcome = canonicalOutcome(snapshot);
  if (inspectedOutcome === "done") return finishDone(input.store, state, snapshot, now);
  if (inspectedOutcome === "failed") return finishFailed(input.store, state, snapshot, now);

  if (state.pending_barrier) {
    const barrier = state.pending_barrier;
    const readiness = await waitForBarrier(barrier);
    if (readiness === "pending") {
      state = saveState(input.store, state, { status: "waiting" }, now);
      return { outcome: "waiting", turns_started: state.turns_started, snapshot, barrier };
    }
    state = saveState(input.store, state, { status: "active", pending_barrier: null }, now);
    appendEvent(input.store, state, snapshot, "resumed", now, { barrier });
  }

  snapshot = validateSnapshot(await input.runtime.synchronize());
  assertMissionIdentity(state, snapshot);
  const initialOutcome = canonicalOutcome(snapshot);
  if (initialOutcome === "done") return finishDone(input.store, state, snapshot, now);
  if (initialOutcome === "failed") return finishFailed(input.store, state, snapshot, now);
  if (initialOutcome === "waiting") {
    state = saveState(input.store, state, { status: "waiting" }, now);
    return { outcome: "waiting", turns_started: state.turns_started, snapshot };
  }

  while (state.turns_started < input.maxTurns) {
    await authorizeTurn();
    const iteration = state.turns_started + 1;
    state = saveState(input.store, state, { status: "active", turns_started: iteration }, now);
    appendEvent(input.store, state, snapshot, "turn_started", now);
    let result: ContinuationTurnResult;
    try {
      result = validateTurnResult(await input.runtime.execute(Object.freeze({
        schema_version: "1.0",
        run_id: snapshot.run_id,
        definition_id: snapshot.definition_id,
        current_step: snapshot.current_step,
        iteration,
        max_turns: input.maxTurns,
        next_action: snapshot.next_action ? structuredClone(snapshot.next_action) : null,
      })));
    } catch (error) {
      appendEvent(input.store, state, snapshot, "turn_failed", now, { summary: boundedErrorMessage(error) });
      snapshot = validateSnapshot(await input.runtime.synchronize());
      assertMissionIdentity(state, snapshot);
      const outcome = canonicalOutcome(snapshot);
      if (outcome === "done") return finishDone(input.store, state, snapshot, now);
      if (outcome === "failed") return finishFailed(input.store, state, snapshot, now);
      if (outcome === "waiting") {
        state = saveState(input.store, state, { status: "waiting" }, now);
        return { outcome: "waiting", turns_started: state.turns_started, snapshot };
      }
      continue;
    }
    appendEvent(input.store, state, snapshot, "turn_completed", now, { summary: result.summary });

    if (result.status === "wait") {
      state = saveState(input.store, state, { status: "waiting", pending_barrier: result.barrier }, now);
      appendEvent(input.store, state, snapshot, "parked", now, { barrier: result.barrier, summary: result.summary });
      const readiness = await waitForBarrier(result.barrier);
      if (readiness === "pending") {
        return { outcome: "waiting", turns_started: state.turns_started, snapshot, barrier: result.barrier };
      }
      state = saveState(input.store, state, { status: "active", pending_barrier: null }, now);
      appendEvent(input.store, state, snapshot, "resumed", now, { barrier: result.barrier });
    }

    snapshot = validateSnapshot(await input.runtime.synchronize());
    assertMissionIdentity(state, snapshot);
    const outcome = canonicalOutcome(snapshot);
    if (outcome === "done") return finishDone(input.store, state, snapshot, now);
    if (outcome === "failed") return finishFailed(input.store, state, snapshot, now);
    if (outcome === "waiting") {
      state = saveState(input.store, state, { status: "waiting" }, now);
      return { outcome: "waiting", turns_started: state.turns_started, snapshot };
    }
  }

  state = saveState(input.store, state, { status: "budget_exhausted" }, now);
  appendEvent(input.store, state, snapshot, "budget_exhausted", now);
  return { outcome: "budget_exhausted", turns_started: state.turns_started, snapshot };
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
    store: createFileContinuationStore(sessionDir),
    ...(input.waitForBarrier ? { waitForBarrier: input.waitForBarrier } : {}),
    ...(input.authorizeTurn ? { authorizeTurn: input.authorizeTurn } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
}

export async function withContinuationDriverLock<T>(sessionDirInput: string, body: () => Promise<T>): Promise<T> {
  const sessionDir = path.resolve(sessionDirInput);
  const driverDir = path.join(sessionDir, "continuation-driver");
  const locksDir = path.join(driverDir, "locks");
  ensureSafeDirectory(sessionDir, locksDir);
  const token = randomUUID();
  const lockFile = path.join(locksDir, `${process.pid}-${token}.lock`);
  const owner = { schema_version: "1.0" as const, pid: process.pid, token, created_at: new Date().toISOString() };
  acquireDriverLock(locksDir, lockFile, owner);
  try {
    return await body();
  } finally {
    releaseDriverLock(lockFile, token);
  }
}

export function createFileContinuationStore(sessionDirInput: string): ContinuationStateStore {
  const sessionDir = path.resolve(sessionDirInput);
  const driverDir = path.join(sessionDir, "continuation-driver");
  const stateFile = path.join(driverDir, "state.json");
  const eventsFile = path.join(driverDir, "events.jsonl");
  ensureSafeDirectory(sessionDir, driverDir);
  return {
    load(): ContinuationDriverState | null {
      if (!fs.existsSync(stateFile)) {
        if (fs.existsSync(eventsFile) && fs.statSync(eventsFile).size > 0) throw new Error("continuation driver state is missing while mission events exist");
        return null;
      }
      const state = JSON.parse(readRegularFileNoFollow(stateFile, "continuation driver state")) as ContinuationDriverState;
      reconcileStateWithEvents(state, eventsFile);
      return state;
    },
    save(state: ContinuationDriverState): void {
      atomicWriteJson(sessionDir, stateFile, state);
    },
    append(event: ContinuationDriverEvent): void {
      appendJsonLineNoFollow(sessionDir, eventsFile, event);
    },
  };
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
  });
}

function appendJsonLineNoFollow(root: string, file: string, value: unknown): void {
  ensureSafeDirectory(root, path.dirname(file));
  if (fs.existsSync(file)) assertRegularFile(file, "continuation driver event log");
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const fd = fs.openSync(file, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | noFollow, 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function assertRegularFile(file: string, label: string): void {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file`);
}

function readRegularFileNoFollow(file: string, label: string): string {
  assertRegularFile(file, label);
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const fd = fs.openSync(file, fsConstants.O_RDONLY | noFollow);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`${label} must be a regular file`);
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function acquireDriverLock(
  locksDir: string,
  lockFile: string,
  owner: { schema_version: "1.0"; pid: number; token: string; created_at: string },
): void {
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const fd = fs.openSync(lockFile, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  try {
    for (const name of fs.readdirSync(locksDir).sort()) {
      const candidate = path.join(locksDir, name);
      if (candidate === lockFile) continue;
      let existing: { schema_version?: unknown; pid?: unknown; token?: unknown };
      try {
        existing = JSON.parse(readRegularFileNoFollow(candidate, "continuation driver lock")) as typeof existing;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (existing.schema_version !== "1.0" || typeof existing.pid !== "number" || !Number.isSafeInteger(existing.pid) || existing.pid <= 0 || typeof existing.token !== "string") {
        throw new Error("continuation driver lock is invalid");
      }
      if (processAlive(existing.pid)) throw new Error(`continuation driver is already running under pid ${existing.pid}`);
      try {
        fs.unlinkSync(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  } catch (error) {
    try {
      fs.unlinkSync(lockFile);
    } catch {}
    throw error;
  }
}

function releaseDriverLock(lockFile: string, token: string): void {
  try {
    const owner = JSON.parse(readRegularFileNoFollow(lockFile, "continuation driver lock")) as { token?: unknown };
    if (owner.token === token) fs.unlinkSync(lockFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
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

function finishDone(store: ContinuationStateStore, state: ContinuationDriverState, snapshot: ContinuationSnapshot, now: () => Date): ContinuationDriverOutcome {
  const done = saveState(store, state, { status: "done", pending_barrier: null }, now);
  appendEvent(store, done, snapshot, "done", now);
  return { outcome: "done", turns_started: done.turns_started, snapshot };
}

function finishFailed(store: ContinuationStateStore, state: ContinuationDriverState, snapshot: ContinuationSnapshot, now: () => Date): ContinuationDriverOutcome {
  const failed = saveState(store, state, { status: "failed", pending_barrier: null }, now);
  return { outcome: "failed", turns_started: failed.turns_started, snapshot };
}

function saveState(
  store: ContinuationStateStore,
  current: ContinuationDriverState,
  patch: Partial<Pick<ContinuationDriverState, "status" | "turns_started" | "pending_barrier">>,
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
  extra: Pick<ContinuationDriverEvent, "barrier" | "summary"> = {},
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
  });
}

function validateSnapshot(value: ContinuationSnapshot): ContinuationSnapshot {
  if (!value || typeof value !== "object") throw new Error("continuation runtime returned an invalid canonical snapshot");
  for (const field of ["run_id", "definition_id", "status", "current_step"] as const) {
    if (typeof value[field] !== "string" || value[field].length === 0) throw new Error(`continuation snapshot ${field} must be a non-empty string`);
  }
  if (!new Set(["continue", "waiting", "done", "failed"]).has(value.disposition)) throw new Error("continuation snapshot disposition is invalid");
  if (value.next_action !== null && (typeof value.next_action !== "object" || Array.isArray(value.next_action))) {
    throw new Error("continuation snapshot next_action must be an object or null");
  }
  return structuredClone(value);
}

function validateTurnResult(value: ContinuationTurnResult): ContinuationTurnResult {
  if (!value || typeof value !== "object" || (value.status !== "completed" && value.status !== "wait")) {
    throw new Error("continuation adapter must return status completed or wait");
  }
  if (value.status === "wait") validateBarrier(value.barrier);
  if (value.summary !== undefined && typeof value.summary !== "string") throw new Error("continuation adapter summary must be a string");
  const copy = structuredClone(value);
  if (copy.summary && copy.summary.length > 2_000) copy.summary = `${copy.summary.slice(0, 1_997)}...`;
  return copy;
}

function validateBarrier(barrier: ContinuationBarrier): void {
  if (!barrier || typeof barrier !== "object") throw new Error("continuation wait result requires a barrier");
  if (barrier.kind === "pid") {
    if (!Number.isSafeInteger(barrier.pid) || barrier.pid <= 0) throw new Error("continuation pid barrier requires a positive integer pid");
    return;
  }
  if (barrier.kind === "deadline") {
    if (typeof barrier.at !== "string" || !Number.isFinite(Date.parse(barrier.at))) throw new Error("continuation deadline barrier requires an ISO date-time");
    return;
  }
  throw new Error("continuation barrier kind must be pid or deadline");
}

function validateState(state: ContinuationDriverState): void {
  if (state.schema_version !== "1.0") throw new Error("continuation driver state schema_version must be 1.0");
  assertMaxTurns(state.max_turns);
  if (state.adapter_command_identity !== null && (typeof state.adapter_command_identity !== "string" || state.adapter_command_identity.length === 0)) {
    throw new Error("continuation driver adapter_command_identity must be a non-empty string or null");
  }
  if (!Number.isSafeInteger(state.turns_started) || state.turns_started < 0) throw new Error("continuation driver turns_started must be a non-negative integer");
  if (state.turns_started > state.max_turns) throw new Error("continuation driver turns_started cannot exceed max_turns");
  if (!new Set(["active", "waiting", "done", "failed", "budget_exhausted"]).has(state.status)) throw new Error("continuation driver state status is invalid");
  if (state.status === "budget_exhausted" && state.turns_started !== state.max_turns) {
    throw new Error("continuation driver budget_exhausted state must consume max_turns");
  }
  if (state.pending_barrier) validateBarrier(state.pending_barrier);
}

function assertMissionIdentity(state: Pick<ContinuationDriverState, "run_id" | "definition_id">, snapshot: ContinuationSnapshot): void {
  if (state.run_id !== snapshot.run_id || state.definition_id !== snapshot.definition_id) {
    throw new Error("continuation driver mission identity does not match the canonical Flow run");
  }
}

function assertMaxTurns(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new Error("continuation maxTurns must be an integer from 1 through 100");
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 2_000 ? message : `${message.slice(0, 1_997)}...`;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function reconcileStateWithEvents(state: ContinuationDriverState, eventsFile: string): void {
  if (!fs.existsSync(eventsFile)) {
    if (state.turns_started > 0) throw new Error("continuation driver event history is missing for a started mission");
    return;
  }
  const lines = readRegularFileNoFollow(eventsFile, "continuation driver event log").split("\n").filter((line) => line.length > 0);
  let highestStartedTurn = 0;
  let eventBarrier: ContinuationBarrier | null = null;
  for (const line of lines) {
    const event = JSON.parse(line) as Partial<ContinuationDriverEvent>;
    if (event.run_id !== state.run_id || event.definition_id !== state.definition_id) throw new Error("continuation driver event history has a foreign mission identity");
    if (event.type === "turn_started") {
      if (!Number.isSafeInteger(event.turns_started) || (event.turns_started as number) < 1) throw new Error("continuation driver event history has an invalid turn count");
      highestStartedTurn = Math.max(highestStartedTurn, event.turns_started as number);
    }
    if (event.type === "parked") {
      validateBarrier(event.barrier as ContinuationBarrier);
      eventBarrier = structuredClone(event.barrier as ContinuationBarrier);
    }
    if (event.type === "resumed") eventBarrier = null;
  }
  if (highestStartedTurn > state.turns_started) throw new Error("continuation driver state rolled back behind its event history");
  if (state.turns_started > highestStartedTurn + 1) throw new Error("continuation driver state is ahead of its event history");
  if (!state.pending_barrier && eventBarrier) {
    state.pending_barrier = eventBarrier;
    state.status = "waiting";
  }
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
