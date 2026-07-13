import * as fs from "node:fs";
import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { atomicWriteJson, ensureSafeDirectory } from "./lib/fs.js";
import type { ContinuationAcceptedTurn, ContinuationAcceptedTurnJournal, ContinuationBarrier, ContinuationDriverEvent, ContinuationDriverLockLease, ContinuationDriverState, ContinuationStateStore } from "./continuation-driver.js";

export const MAX_CONTINUATION_TURNS = 100;
const MAX_STATE_BYTES = 1_048_576;
const MAX_LOCK_BYTES = 16_384;
const MAX_EVENT_LINE_BYTES = 16_384;
const MAX_EVENT_LINES = MAX_CONTINUATION_TURNS * 6 + 16;
const MAX_EVENT_LOG_BYTES = MAX_EVENT_LINE_BYTES * MAX_EVENT_LINES;
const MAX_ACCEPTED_TURN_LINE_BYTES = 196_608;
const MAX_ACCEPTED_TURN_LOG_BYTES = MAX_ACCEPTED_TURN_LINE_BYTES * MAX_CONTINUATION_TURNS;

export async function withContinuationDriverLock<T>(sessionDirInput: string, body: (lease: ContinuationDriverLockLease) => Promise<T>): Promise<T> {
  const sessionDir = path.resolve(sessionDirInput);
  const locksDir = path.join(sessionDir, "continuation-driver", "locks");
  ensureSafeDirectory(sessionDir, locksDir);
  const token = randomUUID();
  const lockFile = path.join(locksDir, `${process.pid}-${token}.lock`);
  const lease: ContinuationDriverLockLease = { pid: process.pid, token, created_at: new Date().toISOString() };
  acquireDriverLock(locksDir, lockFile, { schema_version: "1.0", ...lease });
  try { return await body(lease); }
  finally { releaseDriverLock(lockFile, token); }
}

export function createFileContinuationStore(sessionDirInput: string): ContinuationStateStore & ContinuationAcceptedTurnJournal {
  const sessionDir = path.resolve(sessionDirInput);
  const driverDir = path.join(sessionDir, "continuation-driver");
  const stateFile = path.join(driverDir, "state.json");
  const eventsFile = path.join(driverDir, "events.jsonl");
  const acceptedFile = path.join(driverDir, "accepted-turns.jsonl");
  ensureSafeDirectory(sessionDir, driverDir);
  return {
    load(): ContinuationDriverState | null {
      const stateBytes = readStableBoundedFile(stateFile, "continuation driver state", MAX_STATE_BYTES, false);
      const events = readEventLog(eventsFile);
      if (!stateBytes) {
        if (events.length > 0) throw new Error("continuation driver state is missing while mission events exist");
        return null;
      }
      const state = JSON.parse(stateBytes.toString("utf8")) as ContinuationDriverState;
      reconcileStateWithEvents(state, events);
      return state;
    },
    save(state): void {
      if (Buffer.byteLength(JSON.stringify(state), "utf8") > MAX_STATE_BYTES) throw new Error(`continuation driver state exceeds ${MAX_STATE_BYTES} bytes`);
      atomicWriteJson(sessionDir, stateFile, state);
    },
    append(event): void {
      const events = readEventLog(eventsFile);
      if (event.turn_id && events.some((entry) => entry.type === event.type && entry.turn_id === event.turn_id)) return;
      appendBoundedJsonLine(sessionDir, eventsFile, event, "continuation driver event log", MAX_EVENT_LINE_BYTES, MAX_EVENT_LOG_BYTES, events.length, MAX_EVENT_LINES);
    },
    captureAcceptedTurn(turn): void {
      const accepted = readAcceptedTurns(acceptedFile);
      const prior = accepted.find((entry) => entry.turn_id === turn.turn_id);
      if (prior) {
        if (!isDeepStrictEqual(prior, turn)) throw new Error(`continuation accepted-turn '${turn.turn_id}' conflicts with its durable capture`);
        return;
      }
      appendBoundedJsonLine(sessionDir, acceptedFile, turn, "continuation accepted-turn log", MAX_ACCEPTED_TURN_LINE_BYTES, MAX_ACCEPTED_TURN_LOG_BYTES, accepted.length, MAX_CONTINUATION_TURNS);
    },
    acceptedTurns(): ContinuationAcceptedTurn[] {
      const accepted = readAcceptedTurns(acceptedFile);
      assertAcceptedTurnCoverage(accepted, readEventLog(eventsFile));
      return structuredClone(accepted);
    },
  };
}

function readEventLog(file: string): ContinuationDriverEvent[] {
  return readBoundedJsonLines<ContinuationDriverEvent>(file, "continuation driver event log", MAX_EVENT_LOG_BYTES, MAX_EVENT_LINE_BYTES, MAX_EVENT_LINES);
}

function readAcceptedTurns(file: string): ContinuationAcceptedTurn[] {
  return readBoundedJsonLines<ContinuationAcceptedTurn>(file, "continuation accepted-turn log", MAX_ACCEPTED_TURN_LOG_BYTES, MAX_ACCEPTED_TURN_LINE_BYTES, MAX_CONTINUATION_TURNS);
}

function readBoundedJsonLines<T>(file: string, label: string, maxFileBytes: number, maxLineBytes: number, maxLines: number): T[] {
  const bytes = readStableBoundedFile(file, label, maxFileBytes, false);
  if (!bytes || bytes.length === 0) return [];
  const lines = bytes.toString("utf8").split("\n");
  if (lines.at(-1) !== "") throw new Error(`${label} must end with a complete line`);
  lines.pop();
  if (lines.length > maxLines) throw new Error(`${label} exceeds ${maxLines} lines`);
  return lines.map((line) => {
    if (Buffer.byteLength(line, "utf8") > maxLineBytes) throw new Error(`${label} line exceeds ${maxLineBytes} bytes`);
    return JSON.parse(line) as T;
  });
}

function appendBoundedJsonLine(root: string, file: string, value: unknown, label: string, maxLineBytes: number, maxFileBytes: number, currentLines: number, maxLines: number): void {
  const line = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (line.length - 1 > maxLineBytes) throw new Error(`${label} line exceeds ${maxLineBytes} bytes`);
  if (currentLines >= maxLines) throw new Error(`${label} exceeds ${maxLines} lines`);
  ensureSafeDirectory(root, path.dirname(file));
  const parent = stableParent(path.dirname(file), label);
  const fd = fs.openSync(file, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | noFollowFlag(), 0o600);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size + line.length > maxFileBytes) throw new Error(`${label} exceeds ${maxFileBytes} bytes`);
    fs.writeSync(fd, line, 0, line.length);
    const after = fs.fstatSync(fd);
    if (!sameIdentity(before, after) || after.size !== before.size + line.length) throw new Error(`${label} changed while appending`);
    assertPathAndParentIdentity(file, after, parent, label);
  } finally { fs.closeSync(fd); }
}

function readStableBoundedFile(file: string, label: string, maxBytes: number, required: boolean): Buffer | null {
  let fd: number | undefined;
  try {
    const parent = stableParent(path.dirname(file), label);
    fd = fs.openSync(file, fsConstants.O_RDONLY | noFollowFlag());
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > maxBytes) throw new Error(`${label} must be a regular file no larger than ${maxBytes} bytes`);
    assertPathAndParentIdentity(file, before, parent, label);
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read === 0) throw new Error(`${label} changed while reading`);
      offset += read;
    }
    const after = fs.fstatSync(fd);
    if (!sameIdentity(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error(`${label} changed while reading`);
    assertPathAndParentIdentity(file, after, parent, label);
    return bytes;
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

type ParentIdentity = { real: string; stat: fs.Stats };

function stableParent(parentPath: string, label: string): ParentIdentity {
  const lexical = fs.lstatSync(parentPath);
  if (lexical.isSymbolicLink() || !lexical.isDirectory()) throw new Error(`${label} parent must be a non-symlink directory`);
  const real = fs.realpathSync(parentPath);
  const stat = fs.statSync(real);
  if (!stat.isDirectory() || !sameIdentity(lexical, stat)) throw new Error(`${label} parent changed identity`);
  return { real, stat };
}

function assertPathAndParentIdentity(file: string, opened: fs.Stats, parent: ParentIdentity, label: string): void {
  const pathStat = fs.lstatSync(file);
  if (pathStat.isSymbolicLink() || !sameIdentity(opened, pathStat)) throw new Error(`${label} changed identity while reading`);
  const parentAfter = stableParent(path.dirname(file), label);
  if (parentAfter.real !== parent.real || !sameIdentity(parentAfter.stat, parent.stat)) throw new Error(`${label} parent changed identity while reading`);
}

function assertAcceptedTurnCoverage(accepted: ContinuationAcceptedTurn[], events: ContinuationDriverEvent[]): void {
  const acceptedIds = new Set(accepted.map((entry) => entry.turn_id));
  if (acceptedIds.size !== accepted.length) throw new Error("continuation accepted-turn log contains duplicate turn ids");
  const terminalEvents = events.filter((event) => event.type === "turn_completed" || event.type === "parked" || (event.type === "turn_failed" && event.turn_id));
  if (events.some((event) => (event.type === "turn_completed" || event.type === "parked") && !event.turn_id)) {
    throw new Error("continuation attestation coverage is incomplete for legacy accepted turns");
  }
  if (terminalEvents.some((event) => !event.turn_id || !acceptedIds.has(event.turn_id))) throw new Error("continuation attestation coverage is missing a persisted accepted turn");
  const eventIds = new Set(terminalEvents.flatMap((event) => event.turn_id ? [event.turn_id] : []));
  if (accepted.some((entry) => !eventIds.has(entry.turn_id))) throw new Error("continuation persisted accepted turn has no durable completion event");
}

function acquireDriverLock(locksDir: string, lockFile: string, owner: { schema_version: "1.0"; pid: number; token: string; created_at: string }): void {
  const fd = fs.openSync(lockFile, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(), 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8"); } finally { fs.closeSync(fd); }
  try { reclaimDeadDriverLocks(locksDir, lockFile); }
  catch (error) { try { fs.unlinkSync(lockFile); } catch {} throw error; }
}

function reclaimDeadDriverLocks(locksDir: string, lockFile: string): void {
  for (const name of fs.readdirSync(locksDir).sort()) {
    const candidate = path.join(locksDir, name);
    if (candidate === lockFile) continue;
    let existing: { schema_version?: unknown; pid?: unknown; token?: unknown };
    try { existing = JSON.parse(String(readStableBoundedFile(candidate, "continuation driver lock", MAX_LOCK_BYTES, true))) as typeof existing; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (existing.schema_version !== "1.0" || typeof existing.pid !== "number" || !Number.isSafeInteger(existing.pid) || existing.pid <= 0 || typeof existing.token !== "string") throw new Error("continuation driver lock is invalid");
    if (processAlive(existing.pid)) throw new Error(`continuation driver is already running under pid ${existing.pid}`);
    try { fs.unlinkSync(candidate); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

function releaseDriverLock(lockFile: string, token: string): void {
  try {
    const owner = JSON.parse(String(readStableBoundedFile(lockFile, "continuation driver lock", MAX_LOCK_BYTES, true))) as { token?: unknown };
    if (owner.token === token) fs.unlinkSync(lockFile);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function reconcileStateWithEvents(state: ContinuationDriverState, events: ContinuationDriverEvent[]): void {
  if (events.length === 0) {
    if (state.turns_started > 0) throw new Error("continuation driver event history is missing for a started mission");
    return;
  }
  let highestStartedTurn = 0;
  let eventBarrier: ContinuationBarrier | null = null;
  for (const event of events) {
    if (event.run_id !== state.run_id || event.definition_id !== state.definition_id) throw new Error("continuation driver event history has a foreign mission identity");
    if (event.type === "turn_started") {
      if (!Number.isSafeInteger(event.turns_started) || Number(event.turns_started) < 1) throw new Error("continuation driver event history has an invalid turn count");
      highestStartedTurn = Math.max(highestStartedTurn, Number(event.turns_started));
    }
    if (event.type === "parked") { validateStoredBarrier(event.barrier); eventBarrier = structuredClone(event.barrier as ContinuationBarrier); }
    if (event.type === "resumed") eventBarrier = null;
  }
  if (highestStartedTurn > state.turns_started) throw new Error("continuation driver state rolled back behind its event history");
  if (state.turns_started > highestStartedTurn + 1) throw new Error("continuation driver state is ahead of its event history");
  if (!state.pending_barrier && eventBarrier) { state.pending_barrier = eventBarrier; state.status = "waiting"; }
}

function validateStoredBarrier(value: unknown): void {
  const barrier = value as Partial<ContinuationBarrier> | null;
  const validPid = barrier?.kind === "pid" && Number.isSafeInteger(barrier.pid) && Number(barrier.pid) > 0;
  const validDeadline = barrier?.kind === "deadline" && typeof barrier.at === "string" && Number.isFinite(Date.parse(barrier.at));
  if (!validPid && !validDeadline) throw new Error("continuation driver event history has an invalid barrier");
}

function sameIdentity(left: fs.Stats, right: fs.Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } }
function noFollowFlag(): number {
  if (typeof fsConstants.O_NOFOLLOW !== "number") throw new Error("continuation persistence requires O_NOFOLLOW");
  return fsConstants.O_NOFOLLOW;
}
