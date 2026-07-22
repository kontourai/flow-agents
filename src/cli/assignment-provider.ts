import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseArgs, flagString, type ParsedArgs } from "../lib/args.js";
import { atomicWriteJson, readJson, isoNow } from "../lib/fs.js";

// ─── AssignmentProvider CLI (#290) ──────────────────────────────────────────
// context/contracts/assignment-provider-contract.md is the governing vocabulary doc for this
// module. Read it first if the shapes below are unclear — it documents the five operations, the
// assignment ⋈ liveness join table, the lazy-correction transition table, and the versioned
// claim-record format this file implements.
//
// Three distinct "claim" concepts exist in this repo (see the contract doc's terminology
// callout): this file implements the *assignment* claim only — never the ADR 0012 *liveness*
// claim (workflow-sidecar.ts `liveness claim` / `freshHolders`) or the Hachure *trust* claim
// (workflow-sidecar.ts `claim <id> <dir>` / `claimLookup`). Always qualify "claim" in prose here.
//
// GitHub mutation path is render-don't-execute (Design Decision 1): every `render-*` subcommand
// is a pure function — no I/O beyond reading its `--input-json`/`--actor-json` inputs — that
// emits the exact `gh` argv the calling skill must run verbatim via its Bash tool. This file must
// never itself shell out to `gh` (no execFileSync/spawn/exec to `gh` anywhere below).

type AnyObj = Record<string, unknown>;

export type ActorStruct = {
  runtime: string;
  session_id: string;
  host: string;
  human?: string | null;
};

type AssignmentClaimRecordStatus = "claimed" | "released" | "superseded";

type AssignmentAuditEntry = {
  at: string;
  transition: "claim" | "release" | "supersede";
  from_actor?: ActorStruct | null;
  to_actor?: ActorStruct | null;
  reason?: string;
};

/**
 * The versioned claim-record shape from the contract doc's "Versioned claim-record format"
 * section (Design Decision 2). `schema_version` is bumped only on an incompatible change, per
 * artifact-contract.md's existing sidecar rule.
 *
 * `actor_key` (F1 fix, fix-plan iteration 1, HIGH — additive field, schema_version unchanged):
 * the canonical `resolveActor(env).actor` string for the claiming actor — the SAME flat/bare
 * token every other tool (`liveness whoami`, `liveness claim --actor`, per-actor current.json,
 * pull-work's `--self-actor`) already uses. Optional so every pre-fix record and every #290 eval
 * fixture with no `actor_key` still parses; `computeEffectiveState` falls back to
 * `serializeActor(record.actor)` (today's behavior) whenever it's absent. Present, it is the ONLY
 * correct self-recognition/liveness-join key — see computeEffectiveState's holderActorKey.
 */
export type AssignmentClaimRecord = {
  schema_version: "1.0";
  role: "AssignmentClaimRecord";
  subject_id: string;
  actor: ActorStruct;
  actor_key?: string;
  work_item_ref?: string;
  claimed_at: string;
  ttl_seconds: number;
  branch: string;
  artifact_dir: string;
  status: AssignmentClaimRecordStatus;
  audit_trail?: AssignmentAuditEntry[];
};

export type FreshHolder = { actor: string; lastAt: string; ttlSeconds: number; fresh: boolean };

export type EffectiveState = "held" | "reclaimable" | "human-held" | "free";

/** Provider-neutral assignment-layer read, before any liveness join (contract doc's status()). */
export type AssignmentStatus = {
  subject_id: string;
  provider: "local-file" | "github";
  assignee: string | null;
  record: AssignmentClaimRecord | null;
  has_claim_label?: boolean;
  claim_comment_author?: string | null;
  claim_comment_id?: string | null;
  repository?: { owner: string; name: string } | null;
  issue_number?: number | null;
};

type GithubIssueDoc = {
  number?: number;
  assignees?: Array<{ login?: string } | string>;
  labels?: Array<{ name?: string } | string>;
  comments?: Array<{ id?: string | number; body?: string; author?: { login?: string } | string; createdAt?: string }>;
  state?: string;
};

type RenderClaimInput = {
  repo?: { owner?: string; name?: string };
  issue_number?: number;
  assignee_login?: string;
  existing_assignee_login?: string;
  label_name?: string;
  claim_comment_marker?: string;
  ttl_seconds?: number;
  branch?: string;
  artifact_dir?: string;
  actor_key?: string;
  work_item_ref?: string;
  existing_comment_id?: number;
  previous_record?: AssignmentClaimRecord;
  reason?: string;
};

const DEFAULT_LABEL_NAME = "agent:claimed";
const CLAIM_COMMENT_MARKER_DEFAULT = "<!-- flow-agents:assignment-claim -->";

/**
 * Delegate to the shared pure-CJS resolver (scripts/hooks/lib/actor-identity.js), mirroring the
 * exact createRequire pattern `workflow-sidecar.ts`'s loadActorIdentityHelper() already uses for
 * this module. Deliberately NO inline duplicate fallback — same rationale as that function: if
 * the module fails to load, that failure must surface loudly, never silently degrade to a forked
 * actor concept or a second sanitizer.
 */
function loadActorIdentityHelper(): {
  resolveActor: (env: NodeJS.ProcessEnv) => { actor: string; source: string };
  resolveActorIdentity: (env: NodeJS.ProcessEnv) => { actor: string; source: string; actorStruct: ActorStruct | null };
  serializeActor: (actor: Partial<ActorStruct> | undefined) => string;
  isUnresolvedActor: (actor: string) => boolean;
  sanitizeSegment: (value: unknown) => string;
} {
  const _req = createRequire(import.meta.url);
  const helperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/hooks/lib/actor-identity.js");
  return _req(helperPath) as {
    resolveActor: (env: NodeJS.ProcessEnv) => { actor: string; source: string };
    resolveActorIdentity: (env: NodeJS.ProcessEnv) => { actor: string; source: string; actorStruct: ActorStruct | null };
    serializeActor: (actor: Partial<ActorStruct> | undefined) => string;
    isUnresolvedActor: (actor: string) => boolean;
    sanitizeSegment: (value: unknown) => string;
  };
}

/**
 * Delegate to the shared pure-CJS liveness reader (scripts/hooks/lib/liveness-read.js), same
 * createRequire idiom as loadActorIdentityHelper() above. Used only for the join computation —
 * this module never writes liveness events (that stays the ADR 0012 lifecycle's job).
 */
function loadLivenessReadHelper(): {
  readLivenessEvents: (streamPath: string) => AnyObj[];
  freshHolders: (events: AnyObj[], slug: string, selfActor: string, nowMs: number) => FreshHolder[];
} {
  const _req = createRequire(import.meta.url);
  const helperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/hooks/lib/liveness-read.js");
  return _req(helperPath) as {
    readLivenessEvents: (streamPath: string) => AnyObj[];
    freshHolders: (events: AnyObj[], slug: string, selfActor: string, nowMs: number) => FreshHolder[];
  };
}

function loadJsonInput(file: string): unknown {
  return file === "-" ? JSON.parse(fs.readFileSync(0, "utf8")) : readJson(file);
}

function requireFlag(args: ParsedArgs, name: string): string {
  const value = flagString(args.flags, name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

/**
 * Build an ActorStruct from an already-loaded JSON value (used for --actor-json,
 * --from-actor-json, --to-actor-json). Fails loud on a malformed/incomplete struct — a
 * durable claim record must never carry a partial actor identity.
 */
function actorStructFromJson(data: unknown, sourceLabel: string): ActorStruct {
  if (typeof data !== "object" || data === null) throw new Error(`${sourceLabel} must contain an object`);
  const struct = data as Partial<ActorStruct>;
  if (!struct.runtime || !struct.session_id || !struct.host) throw new Error(`${sourceLabel} must include runtime, session_id, and host`);
  return {
    runtime: String(struct.runtime),
    session_id: String(struct.session_id),
    host: String(struct.host),
    human: struct.human != null && String(struct.human).trim() !== "" ? String(struct.human) : null,
  };
}

function loadActorStructFromFile(file: string): ActorStruct {
  return actorStructFromJson(loadJsonInput(file), `actor JSON (${file})`);
}

/**
 * Resolve the acting actor for a local-file mutation: --actor-json is the deterministic,
 * fixture-friendly path (used by evals and any caller that already knows its own struct);
 * when omitted, auto-derive from the live environment via the shared resolver, mirroring
 * (never forking) the exact struct fields serializeActor() already defines.
 *
 * F1 fix (fix-plan iteration 1, HIGH): also returns `actorKey` — set to the canonical
 * `resolveActor(env).actor` string ONLY on the auto-derive path (pull-work's real path, and any
 * other caller with no --actor-json), so a claim made via `assignment-provider claim` and one
 * made via ensure-session share the same canonical key. `--actor-json` explicit fixtures leave
 * `actorKey` unset — `performLocalClaim`/`performLocalSupersede` then fall back to
 * `serializeActor(actor)` for the record's `actor_key`, preserving existing fixture behavior.
 */
function loadActorStruct(args: ParsedArgs): { actor: ActorStruct; actorKey?: string } {
  const actorJsonPath = flagString(args.flags, "actor-json");
  if (actorJsonPath) return { actor: loadActorStructFromFile(actorJsonPath) };
  return resolveCurrentAssignmentActor();
}

export function resolveCurrentAssignmentActor(): { actor: ActorStruct; actorKey: string } {
  const helper = loadActorIdentityHelper();
  const resolved = helper.resolveActorIdentity(process.env);
  if (helper.isUnresolvedActor(resolved.actor)) throw new Error("could not resolve an actor identity (no --actor-json and no resolvable environment actor); pass --actor-json explicitly");
  if (!resolved.actorStruct) throw new Error("actor identity resolved without a canonical actor struct");
  return { actor: { ...resolved.actorStruct, human: resolved.actorStruct.human ?? null }, actorKey: resolved.actor };
}

export function assignmentFilePath(artifactRoot: string, subjectId: string): string {
  const sanitized = loadActorIdentityHelper().sanitizeSegment(subjectId);
  return path.join(artifactRoot, "assignment", `${sanitized}.json`);
}

function localAssignmentDir(artifactRoot: string, create: boolean): string | null {
  const dir = path.join(artifactRoot, "assignment");
  if (create) fs.mkdirSync(dir, { recursive: true });
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`assignment directory must be a real directory, not a symlink: ${dir}`);
  }
  const realRoot = fs.realpathSync(artifactRoot);
  if (fs.realpathSync(dir) !== path.join(realRoot, "assignment")) {
    throw new Error(`assignment directory escapes the artifact root: ${dir}`);
  }
  return dir;
}

export function readLocalRecord(artifactRoot: string, subjectId: string): AssignmentClaimRecord | null {
  if (!localAssignmentDir(artifactRoot, false)) return null;
  const file = assignmentFilePath(artifactRoot, subjectId);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`assignment record must be a regular file, not a symlink: ${file}`);
  }
  let data: unknown;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    data = JSON.parse(fs.readFileSync(descriptor, "utf8"));
  } catch (error) {
    // Fail loud: a corrupt claim record must never be silently treated as "no claim" — that
    // would be a fail-open path that could let a second claim silently overwrite a real one.
    throw new Error(`assignment record is corrupt, refusing to proceed: ${file}: ${(error as Error).message}`);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
  if (typeof data !== "object" || data === null) throw new Error(`assignment record is not an object: ${file}`);
  const record = data as AssignmentClaimRecord;
  if (record.schema_version !== "1.0") throw new Error(`${file}: unsupported schema_version ${String((record as AnyObj).schema_version)}`);
  return record;
}

export function writeLocalRecord(artifactRoot: string, subjectId: string, record: AssignmentClaimRecord): void {
  // writeJson throws on any mkdir/writeFileSync failure; that error is intentionally allowed to
  // propagate to main()'s top-level try/catch and exit non-zero. Durable writes must fail loud,
  // never fail open (artifact-contract.md).
  atomicWriteJson(artifactRoot, assignmentFilePath(artifactRoot, subjectId), record);
}

/**
 * Synchronous busy-sleep via Atomics.wait on a throwaway SharedArrayBuffer — Node.js (unlike
 * browser engines) permits Atomics.wait on the main thread, so this gives withSubjectLock() a
 * true blocking sleep without going async. Kept to a small, bounded delay (see withSubjectLock's
 * spin loop) — never used outside the lock-acquire spin below.
 */
function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  Atomics.wait(ia, 0, 0, ms);
}

function subjectLockDir(artifactRoot: string, subjectId: string): string {
  const assignmentDir = localAssignmentDir(artifactRoot, true)!;
  const sanitized = loadActorIdentityHelper().sanitizeSegment(subjectId);
  return path.join(assignmentDir, `.${sanitized}.lockdir`);
}

// Lock age is adjudicated by the current contender, never by metadata written
// by the lock owner. The environment is only an operator tuning input; clamp it
// so a caller cannot turn a transient owner-file write into immediate takeover.
const SUBJECT_LOCK_STALE_MIN_MS = 1_000;
const SUBJECT_LOCK_STALE_MAX_MS = 30 * 60 * 1_000;
const SUBJECT_LOCK_STALE_DEFAULT_MS = 5 * 60 * 1_000;

function trustedSubjectLockStaleMs(): number {
  const configured = Number(process.env.FLOW_AGENTS_ASSIGNMENT_STALE_LOCK_MS);
  if (!Number.isFinite(configured)) return SUBJECT_LOCK_STALE_DEFAULT_MS;
  return Math.min(SUBJECT_LOCK_STALE_MAX_MS, Math.max(SUBJECT_LOCK_STALE_MIN_MS, Math.floor(configured)));
}

/**
 * F1 fix (fix-plan iteration 1, CRITICAL): claimLocalFile/releaseLocalFile/supersedeLocalFile were
 * a plain read -> compare-actor -> write with no lock, so two concurrently-launched OS processes
 * could both read "no conflicting claim" before either wrote, and the second write would silently
 * clobber the first with zero error and zero audit-trail entry for the loser (reproduced 29/40
 * races against the built CLI). Atomic directory creation establishes ownership before metadata
 * is written; contenders treat even an ownerless directory as held. Live contention waits with a
 * bounded deadline; stale or malformed residue fails closed for explicit operator cleanup because portable Node
 * filesystem APIs cannot compare-and-swap a directory identity safely. Deliberately synchronous (sleepSync's
 * Atomics.wait spin, not setTimeout/await) so claim/release/supersede can stay sync `number`
 * -returning functions and the CLI dispatcher (src/cli.ts, `number | Promise<number>`) does not
 * need any ripple to async. On lock-acquire failure (any error other than a live contested lock,
 * or a timeout waiting one out) this THROWS — never a silent no-op — "fail loud, never fail-open"
 * (artifact-contract.md). Wrap the ENTIRE read-modify-write body (the existing-claim check AND
 * the write) of all three local-file mutators in this, since all three mutate the same record
 * file for a given subject.
 */
export function withSubjectLock<T>(artifactRoot: string, subjectId: string, body: () => T): T {
  const lockDir = subjectLockDir(artifactRoot, subjectId);
  const staleMs = trustedSubjectLockStaleMs();
  const token = randomBytes(16).toString("hex");
  const ownerFile = path.join(lockDir, "owner.json");
  const deadline = Date.now() + 30000;
  while (true) {
    let createdLockDir = false;
    try {
      fs.mkdirSync(lockDir);
      createdLockDir = true;
      fs.writeFileSync(ownerFile, `${JSON.stringify({ token, pid: process.pid, acquired_at: isoNow() })}\n`, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      const lockError = error as NodeJS.ErrnoException;
      if (createdLockDir) fs.rmSync(lockDir, { recursive: true, force: true });
      if (lockError.code !== "EEXIST") {
        throw new Error(`failed to acquire assignment lock for subject ${subjectId}: ${lockDir}: ${lockError.message || lockError.code || String(lockError)}`);
      }
      try {
        const owner = readSubjectLockOwner(ownerFile);
        const stat = fs.lstatSync(owner?.token ? ownerFile : lockDir);
        if (stat.isSymbolicLink() || !(owner?.token ? stat.isFile() : stat.isDirectory())) {
          throw new Error(`assignment lock has an unsafe ${owner?.token ? "owner file" : "directory"}: ${lockDir}`);
        }
        if (Date.now() - stat.mtimeMs > staleMs) {
          throw new Error(`assignment lock is stale or malformed and requires explicit operator cleanup after confirming no owner is active: ${lockDir}`);
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue; // lock released between mkdir/EEXIST and stat; retry immediately
        throw statError;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for assignment lock for subject ${subjectId}: ${lockDir}`);
      }
      sleepSync(20);
    }
  }
  let heartbeat: NodeJS.Timeout | undefined;
  const ownsLock = (): boolean => readSubjectLockOwner(ownerFile)?.token === token;
  const release = (): void => {
    if (heartbeat) clearInterval(heartbeat);
    if (ownsLock()) fs.rmSync(lockDir, { recursive: true, force: true });
  };
  let result: T;
  try {
    result = body();
  } catch (error) {
    release();
    throw error;
  }
  if (result && typeof (result as { then?: unknown }).then === "function") {
    // An async owner can legitimately hold the lock longer than the stale-lock
    // threshold while an authority-bound command is running. Keep its mtime fresh
    // so lifecycle operations and takeovers continue to observe the live lock.
    const heartbeatMs = Math.max(10, Math.min(1_000, Math.floor(staleMs > 0 ? staleMs / 3 : 1_000)));
    heartbeat = setInterval(() => {
      try {
        if (!ownsLock()) return;
        const timestamp = new Date();
        fs.utimesSync(ownerFile, timestamp, timestamp);
        fs.utimesSync(lockDir, timestamp, timestamp);
      } catch { /* release, reclamation, or process teardown owns cleanup */ }
    }, heartbeatMs);
    return Promise.resolve(result).finally(release) as T;
  }
  release();
  return result;
}

/**
 * Async counterpart for transactions whose body awaits I/O or whose contenders
 * may run in the same event loop. Unlike the legacy synchronous mutator lock,
 * contention yields with a timer so the current async owner can settle,
 * heartbeat, and release its lock.
 */
export async function withSubjectLockAsync<T>(artifactRoot: string, subjectId: string, body: () => T | Promise<T>): Promise<T> {
  const lockDir = subjectLockDir(artifactRoot, subjectId);
  const staleMs = trustedSubjectLockStaleMs();
  const token = randomBytes(16).toString("hex");
  const ownerFile = path.join(lockDir, "owner.json");
  const deadline = Date.now() + 30000;
  while (true) {
    let createdLockDir = false;
    try {
      fs.mkdirSync(lockDir);
      createdLockDir = true;
      fs.writeFileSync(ownerFile, `${JSON.stringify({ token, pid: process.pid, acquired_at: isoNow() })}\n`, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      const lockError = error as NodeJS.ErrnoException;
      if (createdLockDir) fs.rmSync(lockDir, { recursive: true, force: true });
      if (lockError.code !== "EEXIST") {
        throw new Error(`failed to acquire assignment lock for subject ${subjectId}: ${lockDir}: ${lockError.message || lockError.code || String(lockError)}`);
      }
      try {
        const owner = readSubjectLockOwner(ownerFile);
        const stat = fs.lstatSync(owner?.token ? ownerFile : lockDir);
        if (stat.isSymbolicLink() || !(owner?.token ? stat.isFile() : stat.isDirectory())) {
          throw new Error(`assignment lock has an unsafe ${owner?.token ? "owner file" : "directory"}: ${lockDir}`);
        }
        if (Date.now() - stat.mtimeMs > staleMs) {
          throw new Error(`assignment lock is stale or malformed and requires explicit operator cleanup after confirming no owner is active: ${lockDir}`);
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for assignment lock for subject ${subjectId}: ${lockDir}`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }
  let heartbeat: NodeJS.Timeout | undefined;
  const ownsLock = (): boolean => readSubjectLockOwner(ownerFile)?.token === token;
  const heartbeatMs = Math.max(10, Math.min(1_000, Math.floor(staleMs > 0 ? staleMs / 3 : 1_000)));
  heartbeat = setInterval(() => {
    try {
      if (!ownsLock()) return;
      const timestamp = new Date();
      fs.utimesSync(ownerFile, timestamp, timestamp);
      fs.utimesSync(lockDir, timestamp, timestamp);
    } catch { /* release, reclamation, or process teardown owns cleanup */ }
  }, heartbeatMs);
  try {
    return await body();
  } finally {
    clearInterval(heartbeat);
    if (ownsLock()) fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

function readSubjectLockOwner(file: string): { token?: string } | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as { token?: string }
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

/**
 * The assignment ⋈ liveness join (contract doc's "assignment ⋈ liveness join" section, ADR 0021
 * §1). Pure function: `{ assignment, freshHoldersList, selfActor, nowMs }` -> one of five
 * effective states (held/reclaimable/human-held/free — "held" covers both the plain and
 * assignment-lagging rows, matching the contract table's own repeated "held" label).
 *
 * The human-assignee gate (AC11, Design Decision 3) reads `record.actor.human` being *present*,
 * never a username heuristic — an idle human assignment is always `human-held`, regardless of
 * idle duration, and is never auto-reclaimable by this function.
 *
 * `nowMs` (F3 fix, fix-plan iteration 1) is the SAME resolved "now" the caller already threads
 * into `freshHolders()` (the `--now` override, when passed, else `Date.now()`) — passing it
 * through here too means `--now` deterministically governs idle_days as well as liveness
 * freshness, rather than idle_days silently reading the real wall clock regardless of `--now`.
 */
/**
 * The canonical holder actor key for a claim record: `record.actor_key` when present (the
 * canonical `resolveActor(env).actor` string every actor-key consumer in this repository already
 * compares against — `liveness whoami`, `liveness claim --actor`, per-actor `current.json`,
 * pull-work's `--self-actor`), falling back to `serializeActor(record.actor)` for pre-actor_key
 * records. Single-sourced here (#777 review finding 3) so `computeEffectiveState`'s
 * self-recognition/liveness-join comparison and any OTHER holder-identity comparison (e.g.
 * `local-file-provider-adapters.ts`'s `list()` actor filter) can never diverge by each
 * re-deriving their own, potentially inconsistent, holder key. See the assignment-provider-
 * contract.md `actor_key` field doc for why `serializeActor(record.actor)` alone is NOT a valid
 * holder key for an explicit-override actor (a bare canonical token vs. a re-derived
 * `explicit-override:<value>:<host>` triple diverge for that one actor shape).
 */
export function canonicalHolderActorKey(record: AssignmentClaimRecord): string {
  return record.actor_key || loadActorIdentityHelper().serializeActor(record.actor);
}

export function computeEffectiveState(assignment: AssignmentStatus, freshHoldersList: FreshHolder[], selfActor: string | undefined, nowMs: number): {
  effective_state: EffectiveState;
  reason: string;
  holder?: { actor?: string; assignee?: string | null; idle_days?: number | null; last_at?: string };
} {
  const record = assignment.record && assignment.record.status === "claimed" ? assignment.record : null;
  const isAssigned = Boolean(assignment.assignee) || Boolean(record);

  if (!isAssigned) {
    if (freshHoldersList.length > 0) {
      const holder = freshHoldersList[0];
      return { effective_state: "held", reason: "liveness_claim_present_assignment_lagging", holder: { actor: holder.actor, last_at: holder.lastAt } };
    }
    return { effective_state: "free", reason: "no_assignment_no_liveness" };
  }

  if (record && record.actor && record.actor.human != null && String(record.actor.human).trim() !== "") {
    // F3 fix (fix-plan iteration 1): idle_days is computed from the SAME resolved `now` the
    // caller already threads into freshHolders() (the `--now` override, when passed), not a
    // second, independent Date.now() read — so `--now` governs both liveness freshness AND
    // idle-based classification deterministically, rather than only the former.
    const idleMs = nowMs - Date.parse(record.claimed_at);
    const idleDays = Number.isFinite(idleMs) ? Math.floor(idleMs / 86_400_000) : null;
    return { effective_state: "human-held", reason: "assignee_is_human", holder: { actor: assignment.assignee ?? undefined, idle_days: idleDays } };
  }

  if (!record) {
    // Assignee present (e.g. a raw GitHub assignee) with no parseable machine claim record: we
    // cannot positively identify this as a stale agent session, so the conservative ask-first
    // default treats it the same as an explicit human assignment rather than risk reclaiming a
    // human's work (Design Decision 3 / ADR 0021 §6's "never auto-reclaim" non-goal).
    return { effective_state: "human-held", reason: "assignee_without_claim_record", holder: { assignee: assignment.assignee } };
  }

  // F1 fix (fix-plan iteration 1, HIGH): prefer the canonical actor_key over re-serializing
  // record.actor. record.actor_key IS resolveActor(env).actor for records written by the fixed
  // performLocalClaim/performLocalSupersede paths (below) — the same flat/bare string liveness
  // whoami, `liveness claim --actor`, per-actor current.json, and pull-work's --self-actor all
  // use — so for an explicit-override actor the self-check and the liveness join now agree with
  // every other tool. BACK-COMPAT: records with no actor_key (every pre-fix record, every #290
  // eval fixture) fall back to serializeActor(record.actor) exactly as before this fix.
  const holderActorKey = canonicalHolderActorKey(record);
  if (selfActor && holderActorKey === selfActor) return { effective_state: "held", reason: "self_is_holder", holder: { actor: holderActorKey } };

  const fresh = freshHoldersList.find((holder) => holder.actor === holderActorKey);
  if (fresh) return { effective_state: "held", reason: "fresh_liveness_heartbeat", holder: { actor: holderActorKey, last_at: fresh.lastAt } };
  return { effective_state: "reclaimable", reason: "assignment_present_liveness_stale_or_absent", holder: { actor: holderActorKey, last_at: record.claimed_at } };
}

function namesOf(list: unknown, key: string): string[] {
  if (!Array.isArray(list)) return [];
  return list.map((item) => typeof item === "string" ? item : (item && typeof item === "object" ? String((item as AnyObj)[key] ?? "") : "")).filter(Boolean);
}

/**
 * F2 fix (fix-plan iteration 1, HIGH): every string field on a GitHub claim record is sourced
 * from a parsed, attacker-postable issue comment (any GitHub user who can comment can forge a
 * claim-marker comment with a hostile fenced JSON block — commenting requires no elevated
 * access, unlike the assignee/label mutations this contract otherwise gates). Mirrors
 * workflow-sidecar.ts's `stripControlCharsForDisplay` (the established #287/#320 mitigation for
 * exactly this class of untrusted multi-writer/attacker-postable display input): strips C0
 * (0x00-0x1F), DEL (0x7F), and C1 (0x80-0x9F, which includes ANSI-CSI-adjacent bytes), then caps
 * length (this repo's 64/240 convention: 64 for id-like fields, 240 for free text). Display-only
 * — sanitizing the string CONTENT never changes presence/emptiness for any well-formed value, so
 * it does not perturb computeEffectiveState()'s human-assignee presence gate or any equality
 * check downstream.
 */
function sanitizeDisplayField(value: unknown, maxLength: number): string {
  const stripped = String(value ?? "").replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
  return stripped.length > maxLength ? stripped.slice(0, maxLength) : stripped;
}

function sanitizeActorForDisplay(actor: ActorStruct): ActorStruct {
  return {
    runtime: sanitizeDisplayField(actor.runtime, 64),
    session_id: sanitizeDisplayField(actor.session_id, 64),
    host: sanitizeDisplayField(actor.host, 64),
    human: actor.human != null ? sanitizeDisplayField(actor.human, 240) : (actor.human ?? null),
  };
}

function sanitizeAuditEntryForDisplay(entry: AssignmentAuditEntry): AssignmentAuditEntry {
  return {
    ...entry,
    from_actor: entry.from_actor ? sanitizeActorForDisplay(entry.from_actor) : (entry.from_actor ?? null),
    to_actor: entry.to_actor ? sanitizeActorForDisplay(entry.to_actor) : (entry.to_actor ?? null),
    reason: entry.reason != null ? sanitizeDisplayField(entry.reason, 240) : entry.reason,
  };
}

/**
 * The single choke point (per the code review's explicit recommendation) every parsed GitHub
 * claim record passes through before any string in it leaves this module in any form — both
 * `status`/`list`'s JSON output (this fix) and any future consumer of `extractClaimRecord`'s
 * return value inherit clean values from here, mirroring the #320 `computeConflict()` precedent
 * of sanitizing once at construction rather than at each print site.
 */
function sanitizeClaimRecordForDisplay(record: AssignmentClaimRecord): AssignmentClaimRecord {
  return {
    ...record,
    subject_id: sanitizeDisplayField(record.subject_id, 64),
    actor_key: record.actor_key != null ? sanitizeDisplayField(record.actor_key, 260) : record.actor_key,
    work_item_ref: record.work_item_ref != null ? sanitizeDisplayField(record.work_item_ref, 240) : record.work_item_ref,
    branch: sanitizeDisplayField(record.branch, 240),
    artifact_dir: sanitizeDisplayField(record.artifact_dir, 240),
    actor: sanitizeActorForDisplay(record.actor),
    audit_trail: Array.isArray(record.audit_trail) ? record.audit_trail.map(sanitizeAuditEntryForDisplay) : record.audit_trail,
  };
}

/**
 * Locate the machine-readable claim comment among human comments (via the fixed marker) and
 * extract/validate its fenced JSON block. Fails loud on an unparseable or misversioned record —
 * never silently treats a corrupt comment as "no claim" (same rationale as readLocalRecord()).
 * The returned record's display-surfaced string fields are sanitized (F2 fix, above) before
 * return — this is the single choke point, so schema/role/status checks above still validate
 * the RAW parsed shape (never weakened), and only the string fields are transformed afterward.
 */
function extractClaimRecord(issue: GithubIssueDoc, marker: string): {
  record: AssignmentClaimRecord;
  author: string | null;
  commentId: string | null;
} | null {
  const comments = Array.isArray(issue.comments) ? issue.comments : [];
  const candidates = comments.filter((comment) => String(comment.body ?? "").includes(marker));
  if (candidates.length === 0) return null;
  let selected = candidates[0];
  if (candidates.length > 1) {
    const timestamped = candidates.map((comment) => {
      const timestamp = typeof comment.createdAt === "string" ? Date.parse(comment.createdAt) : Number.NaN;
      if (!Number.isFinite(timestamp)) {
        throw new Error(`multiple claim comments require a valid createdAt timestamp on every marker comment (id ${comment.id ?? "?"})`);
      }
      return { comment, timestamp };
    });
    const latestTimestamp = Math.max(...timestamped.map(({ timestamp }) => timestamp));
    const latest = timestamped.filter(({ timestamp }) => timestamp === latestTimestamp);
    if (latest.length !== 1) {
      throw new Error(`multiple claim comments share the latest createdAt timestamp ${new Date(latestTimestamp).toISOString()}; claim selection is ambiguous`);
    }
    selected = latest[0].comment;
  }

  const body = String(selected.body ?? "");
  const markerIndex = body.indexOf(marker);
  const fenceMatch = body.slice(markerIndex).match(/```json\s*([\s\S]*?)```/);
  if (!fenceMatch) throw new Error(`claim comment (id ${selected.id ?? "?"}) has the claim marker but no fenced JSON block`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenceMatch[1]);
  } catch (error) {
    throw new Error(`claim comment (id ${selected.id ?? "?"}) fenced JSON is unparseable: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error(`claim comment (id ${selected.id ?? "?"}) fenced JSON is not an object`);
  const record = parsed as AssignmentClaimRecord;
  if (record.schema_version !== "1.0") throw new Error(`claim comment (id ${selected.id ?? "?"}) has unsupported schema_version ${String((record as AnyObj).schema_version)}`);
  if (record.role !== "AssignmentClaimRecord") throw new Error(`claim comment (id ${selected.id ?? "?"}) has unexpected role ${String((record as AnyObj).role)}`);
  const author = typeof selected.author === "string" ? selected.author : selected.author?.login;
  return {
    record: sanitizeClaimRecordForDisplay(record),
    author: author ? String(author) : null,
    commentId: selected.id != null ? String(selected.id) : null,
  };
}

function githubAssignmentStatus(issue: GithubIssueDoc, labelName: string, marker: string): AssignmentStatus {
  const assignees = namesOf(issue.assignees, "login");
  const labels = namesOf(issue.labels, "name");
  const selectedClaim = extractClaimRecord(issue, marker);
  const record = selectedClaim?.record ?? null;
  return {
    subject_id: record?.subject_id ?? "",
    provider: "github",
    assignee: assignees[0] ?? null,
    record,
    has_claim_label: labels.map((label) => label.toLowerCase()).includes(labelName.toLowerCase()),
    claim_comment_author: selectedClaim?.author ?? null,
    claim_comment_id: selectedClaim?.commentId ?? null,
  };
}

function loadLivenessInputs(args: ParsedArgs): { events: AnyObj[] | null; selfActor: string | undefined } {
  const eventsJsonPath = flagString(args.flags, "liveness-events-json");
  const streamPath = flagString(args.flags, "liveness-stream");
  const selfActor = flagString(args.flags, "self-actor");
  if (eventsJsonPath) {
    const data = loadJsonInput(eventsJsonPath);
    if (!Array.isArray(data)) throw new Error(`--liveness-events-json must contain a JSON array: ${eventsJsonPath}`);
    return { events: data as AnyObj[], selfActor };
  }
  if (streamPath) return { events: loadLivenessReadHelper().readLivenessEvents(streamPath), selfActor };
  return { events: null, selfActor };
}

// ─── local-file: claim | release | supersede (the durable-write path; real I/O by design — no
// external mutation to defer to a skill for this provider kind, per Design Decision 1) ─────────

/**
 * Wave 1 (#291) extraction: the durable-write body previously inlined inside claimLocalFile's
 * withSubjectLock() closure, now a parameter-driven pure function so ensure-session's ownership
 * guard (workflow-sidecar.ts, Wave 2) can reuse the EXACT same claim logic — same-actor idempotent
 * refresh, different-actor throw, atomic write under withSubjectLock — rather than reimplementing
 * a second, parallel claim path. claimLocalFile (CLI wrapper, below) is now a thin
 * parse-args/print-envelope shell around this.
 */
export function performLocalClaim(
  artifactRoot: string,
  subjectId: string,
  actor: ActorStruct,
  opts: { ttlSeconds: number; branch: string; artifactDir: string; reason?: string; actorKey?: string; workItemRef?: string },
): AssignmentClaimRecord {
  const helper = loadActorIdentityHelper();
  const reason = opts.reason ?? "claim";

  // F1 fix (fix-plan iteration 1, CRITICAL): the existing-claim check AND the write must happen
  // atomically with respect to any other `assignment-provider` invocation on the same subject —
  // see withSubjectLock()'s doc comment for the full rationale.
  return withSubjectLock(artifactRoot, subjectId, (): AssignmentClaimRecord => {
    const existing = readLocalRecord(artifactRoot, subjectId);
    if (existing && existing.status === "claimed") {
      const existingActorKey = helper.serializeActor(existing.actor);
      const newActorKey = helper.serializeActor(actor);
      // AC7: a second claim from a different actor must never silently overwrite the first.
      // Same actor re-claiming (refresh before TTL expiry) is allowed and idempotent.
      if (existingActorKey !== newActorKey) {
        throw new Error(`subject already claimed by a different actor: ${existingActorKey} (claimed_at ${existing.claimed_at}); refusing to overwrite — use supersede to reassign`);
      }
    }

    const record: AssignmentClaimRecord = {
      schema_version: "1.0",
      role: "AssignmentClaimRecord",
      subject_id: subjectId,
      actor,
      ...(opts.actorKey ? { actor_key: opts.actorKey } : {}),
      ...((opts.workItemRef ?? existing?.work_item_ref) ? { work_item_ref: opts.workItemRef ?? existing?.work_item_ref } : {}),
      claimed_at: isoNow(),
      ttl_seconds: opts.ttlSeconds,
      branch: opts.branch,
      artifact_dir: opts.artifactDir,
      status: "claimed",
      audit_trail: [...(existing?.audit_trail ?? []), { at: isoNow(), transition: "claim", from_actor: null, to_actor: actor, reason }],
    };
    writeLocalRecord(artifactRoot, subjectId, record);
    return record;
  });
}

function claimLocalFile(argv: string[]): number {
  const args = parseArgs(argv);
  const provider = flagString(args.flags, "provider", "local-file");
  if (provider !== "local-file") throw new Error(`claim: --provider must be local-file (use render-claim for github); got ${provider}`);
  const artifactRoot = requireFlag(args, "artifact-root");
  const subjectId = requireFlag(args, "subject-id");
  const { actor, actorKey } = loadActorStruct(args);

  const ttlSecondsRaw = flagString(args.flags, "ttl-seconds", "1800") ?? "1800";
  const ttlSeconds = Number(ttlSecondsRaw);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) throw new Error(`--ttl-seconds must be a positive number; got ${ttlSecondsRaw}`);
  const branch = requireFlag(args, "branch");
  const artifactDir = requireFlag(args, "artifact-dir");
  const reason = flagString(args.flags, "reason") ?? "claim";

  const record = performLocalClaim(artifactRoot, subjectId, actor, { ttlSeconds, branch, artifactDir, reason, actorKey });
  console.log(JSON.stringify({ role: "AssignmentClaimResult", subject_id: subjectId, record }, null, 2));
  return 0;
}

/**
 * Wave 1 (#292) extraction: the durable-write body previously inlined inside releaseLocalFile's
 * withSubjectLock() closure, now a parameter-driven pure function so the Stop hook's non-terminal
 * release lifecycle (scripts/hooks/stop-goal-fit.js, #292 Wave 2) can reuse the EXACT same release
 * logic — actor-ownership verification, audit-trail append, atomic write under withSubjectLock —
 * rather than reimplementing a second, parallel release path. releaseLocalFile (CLI wrapper,
 * below) is now a thin parse-args/print-envelope shell around this, mirroring the
 * performLocalSupersede/supersedeLocalFile extraction shape exactly.
 *
 * Two behaviors are deliberately DIFFERENT from a naive inline release, both required for the
 * Stop hook's idempotent, actor-scoped lifecycle release (never for the interactive CLI, which
 * keeps `tolerateNoActiveClaim` unset/false and therefore 100% of its prior throw-on-error shape):
 *
 * - `opts.tolerateNoActiveClaim === true` and there is no existing record, or the existing
 *   record's status is not `"claimed"`: return `null` (a tolerated no-op) instead of throwing
 *   "no active claim to release". This is the one deliberate idempotency change vs today's
 *   releaseLocalFile — a second release call (e.g. a double Stop event) must be a safe no-op.
 * - `releasedBy` is provided and does not match the existing record's holder: never force-release
 *   a claim held by a different actor — return `null` (if tolerateNoActiveClaim) or throw
 *   (otherwise), same as the no-active-claim case. The comparison mirrors computeEffectiveState()'s
 *   `record.actor_key || helper.serializeActor(record.actor)` canonical-key preference EXACTLY
 *   (actor_key-first, falling back to serializeActor only when actor_key is absent) — the read
 *   path (status/effective-state) and this write path (release) must use the identical
 *   canonical-key comparison, or a claim written under an explicit-override actor (`actor_key`
 *   bare, e.g. `"canonical-x"`, but `serializeActor(record.actor)` a DIFFERENT triple, e.g.
 *   `"explicit-override:canonical-x:host"`) can be self-recognized by computeEffectiveState() yet
 *   fail to release here because the releaser's canonical key was compared against the wrong
 *   (re-derived, triple) form instead of the stored actor_key. Comparing two serializeActor()
 *   calls unconditionally — as a prior version of this function did — is NOT correct for override
 *   actors and reintroduces the exact #291 seam on the release path.
 *
 * Contract: when `releasedBy` is provided AND the existing record is `actor_key`-stamped,
 * `opts.actorKey` is REQUIRED (the canonical `resolveActor(env).actor` string) — otherwise
 * ownership cannot be verified. A caller that passes `releasedBy` without `opts.actorKey` against
 * an `actor_key`-stamped record would have its ownership compared as
 * `existing.actor_key` (bare canonical) vs `serializeActor(releasedBy)` (re-derived triple), which
 * can NEVER match even for the legitimate holder — a silent-failure trap, not a real ownership
 * check. This is refused loudly (see the guard at the top of the `releasedBy` branch below) rather
 * than allowed to silently no-op or wrongly refuse.
 */
export function performLocalRelease(
  artifactRoot: string,
  subjectId: string,
  releasedBy: ActorStruct | null,
  opts: { reason?: string; actorKey?: string; tolerateNoActiveClaim?: boolean } = {},
): AssignmentClaimRecord | null {
  return withSubjectLock(artifactRoot, subjectId, () => performLocalReleaseUnderLock(artifactRoot, subjectId, releasedBy, opts));
}

/** Caller must already hold this subject's assignment lock through withSubjectLock(). */
export function performLocalReleaseUnderLock(
  artifactRoot: string,
  subjectId: string,
  releasedBy: ActorStruct | null,
  opts: { reason?: string; actorKey?: string; tolerateNoActiveClaim?: boolean } = {},
): AssignmentClaimRecord | null {
  const helper = loadActorIdentityHelper();
  const reason = opts.reason ?? "released";
  const tolerateNoActiveClaim = opts.tolerateNoActiveClaim ?? false;

  const existing = readLocalRecord(artifactRoot, subjectId);
    if (!existing || existing.status !== "claimed") {
      if (tolerateNoActiveClaim) return null;
      throw new Error(`no active claim to release for subject: ${subjectId}`);
    }

    if (releasedBy) {
      // Contract guard (hardening fix, #292 review): a caller that supplies `releasedBy` but NOT
      // `opts.actorKey` against a record that already carries `actor_key` cannot reliably prove
      // ownership — see this function's doc comment. This is the ONLY combination that fires: it
      // does NOT fire when `existing.actor_key` is absent (the CLI/fixture path, where both sides
      // fall back to serializeActor() and legitimately compare equal). Fail loudly rather than
      // silently no-op (tolerant callers) or wrongly refuse (throwing callers) — never silent.
      if (!opts.actorKey && existing.actor_key) {
        if (tolerateNoActiveClaim) {
          console.error(
            `[performLocalRelease] cannot verify ownership of an actor_key-stamped record without opts.actorKey; skipping release for ${subjectId}`,
          );
          return null;
        }
        throw new Error(
          "performLocalRelease: pass opts.actorKey (the canonical resolveActor().actor string) when releasedBy is set and the record carries actor_key — serializeActor(releasedBy) is not a valid ownership key for actor_key-stamped records",
        );
      }

      // AC6: never force-release a claim held by a different actor. Mirrors
      // computeEffectiveState()'s canonical self-recognition comparison EXACTLY —
      // `holderActorKey` prefers the stored `actor_key` (the canonical resolveActor(env).actor
      // string, present on records written by the fixed performLocalClaim/performLocalSupersede
      // paths) and only falls back to `serializeActor(existing.actor)` when `actor_key` is
      // absent (every pre-fix record, every #290 eval fixture). The releaser's side must use the
      // SAME canonical form: `opts.actorKey` (the caller's resolveActor(env).actor string, e.g.
      // scripts/hooks/stop-goal-fit.js's Stop hook) when provided, else re-derived via
      // serializeActor(releasedBy) — never serializeActor() unconditionally on both sides, which
      // would compare the bare actor_key form against a re-derived triple form for an
      // explicit-override actor and spuriously reject a legitimate same-actor release (the #291
      // seam, relocated to this write path).
      const holderActorKey = existing.actor_key || helper.serializeActor(existing.actor);
      const releasedByActorKey = opts.actorKey || helper.serializeActor(releasedBy);
      // Pre-3.7 lifecycle events could persist the derived ancestry actor before
      // sanitizeSegment removed ':' separators. Modern explicit/env release paths
      // always use the sanitized form. Accept only that one-way legacy migration;
      // never normalize two modern keys or relax ownership to a prefix match.
      const sameActorStruct = existing.actor.runtime === releasedBy.runtime
        && existing.actor.session_id === releasedBy.session_id
        && existing.actor.host === releasedBy.host
        && (existing.actor.human ?? null) === (releasedBy.human ?? null);
      const legacyActorKeyMatches = holderActorKey.includes(":")
        && holderActorKey === helper.serializeActor(existing.actor)
        && helper.sanitizeSegment(holderActorKey) === releasedByActorKey
        && sameActorStruct;
      if (holderActorKey !== releasedByActorKey && !legacyActorKeyMatches) {
        if (tolerateNoActiveClaim) return null;
        throw new Error(`--actor-json does not match the current holder (${holderActorKey}); refusing to release a claim held by someone else`);
      }
    }

    const record: AssignmentClaimRecord = {
      ...existing,
      ...(opts.actorKey ? { actor_key: opts.actorKey } : {}),
      status: "released",
      audit_trail: [...(existing.audit_trail ?? []), { at: isoNow(), transition: "release", from_actor: existing.actor, to_actor: releasedBy, reason }],
    };
    writeLocalRecord(artifactRoot, subjectId, record);
  return record;
}

function releaseLocalFile(argv: string[]): number {
  const args = parseArgs(argv);
  const provider = flagString(args.flags, "provider", "local-file");
  if (provider !== "local-file") throw new Error(`release: --provider must be local-file (use render-release for github); got ${provider}`);
  const artifactRoot = requireFlag(args, "artifact-root");
  const subjectId = requireFlag(args, "subject-id");
  const releasedBy = flagString(args.flags, "actor-json") ? loadActorStructFromFile(requireFlag(args, "actor-json")) : null;
  const reason = flagString(args.flags, "reason") ?? "released";

  const record = performLocalRelease(artifactRoot, subjectId, releasedBy, { reason, tolerateNoActiveClaim: false });
  console.log(JSON.stringify({ role: "AssignmentReleaseResult", subject_id: subjectId, record }, null, 2));
  return 0;
}

/**
 * Wave 1 (#291) extraction: the durable-write body previously inlined inside supersedeLocalFile's
 * withSubjectLock() closure, now a parameter-driven pure function so ensure-session's
 * `--supersede-stale` takeover path (workflow-sidecar.ts, Wave 2) can reuse the EXACT same
 * supersede logic — from-actor holder verification, ttl/branch/artifact_dir carry-forward,
 * audit-trail append, atomic write under withSubjectLock — rather than reimplementing a second,
 * parallel supersede path. supersedeLocalFile (CLI wrapper, below) is now a thin
 * parse-args/print-envelope shell around this.
 */
export function performLocalSupersede(
  artifactRoot: string,
  subjectId: string,
  fromActor: ActorStruct,
  toActor: ActorStruct,
  opts: { ttlSeconds?: number; branch?: string; artifactDir?: string; reason?: string; actorKey?: string; workItemRef?: string } = {},
): AssignmentClaimRecord {
  const helper = loadActorIdentityHelper();
  const reason = opts.reason ?? "supersede";

  // F1 fix (fix-plan iteration 1, CRITICAL): supersede mutates the same record file claim/release
  // do, under the same per-subject lock (see withSubjectLock()'s doc comment).
  return withSubjectLock(artifactRoot, subjectId, (): AssignmentClaimRecord => {
    const existing = readLocalRecord(artifactRoot, subjectId);
    if (!existing || existing.status !== "claimed") throw new Error(`no active claim to supersede for subject: ${subjectId}`);

    if (helper.serializeActor(existing.actor) !== helper.serializeActor(fromActor)) {
      throw new Error(`--from-actor-json does not match the current holder (${helper.serializeActor(existing.actor)}); refusing to supersede a claim held by someone else`);
    }

    const ttlSecondsRaw = opts.ttlSeconds != null ? String(opts.ttlSeconds) : String(existing.ttl_seconds);
    const ttlSeconds = Number(ttlSecondsRaw);
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) throw new Error(`--ttl-seconds must be a positive number; got ${ttlSecondsRaw}`);

    const record: AssignmentClaimRecord = {
      schema_version: "1.0",
      role: "AssignmentClaimRecord",
      subject_id: subjectId,
      actor: toActor,
      ...(opts.actorKey ? { actor_key: opts.actorKey } : {}),
      ...((opts.workItemRef ?? existing.work_item_ref) ? { work_item_ref: opts.workItemRef ?? existing.work_item_ref } : {}),
      claimed_at: isoNow(),
      ttl_seconds: ttlSeconds,
      branch: opts.branch ?? existing.branch,
      artifact_dir: opts.artifactDir ?? existing.artifact_dir,
      status: "claimed",
      audit_trail: [...(existing.audit_trail ?? []), { at: isoNow(), transition: "supersede", from_actor: fromActor, to_actor: toActor, reason }],
    };
    writeLocalRecord(artifactRoot, subjectId, record);
    return record;
  });
}

function supersedeLocalFile(argv: string[]): number {
  const args = parseArgs(argv);
  const provider = flagString(args.flags, "provider", "local-file");
  if (provider !== "local-file") throw new Error(`supersede: --provider must be local-file (use render-supersede for github); got ${provider}`);
  const artifactRoot = requireFlag(args, "artifact-root");
  const subjectId = requireFlag(args, "subject-id");
  const fromActor = loadActorStructFromFile(requireFlag(args, "from-actor-json"));
  const toActor = loadActorStructFromFile(requireFlag(args, "to-actor-json"));
  const reason = flagString(args.flags, "reason") ?? "supersede";
  const ttlSecondsOverride = flagString(args.flags, "ttl-seconds");
  const branchOverride = flagString(args.flags, "branch");
  const artifactDirOverride = flagString(args.flags, "artifact-dir");

  const record = performLocalSupersede(artifactRoot, subjectId, fromActor, toActor, {
    ttlSeconds: ttlSecondsOverride != null ? Number(ttlSecondsOverride) : undefined,
    branch: branchOverride ?? undefined,
    artifactDir: artifactDirOverride ?? undefined,
    reason,
  });
  console.log(JSON.stringify({ role: "AssignmentSupersedeResult", subject_id: subjectId, record }, null, 2));
  return 0;
}

// ─── GitHub: render-claim | render-release | render-supersede (render, don't execute — Design
// Decision 1). Pure functions: no I/O beyond reading --input-json/--actor-json. Never invoke
// `gh` (or any process) here — the calling skill runs the emitted argv verbatim. ────────────────

function requireRepo(input: RenderClaimInput): { owner: string; name: string } {
  const repo = input.repo;
  if (!repo || !repo.owner || !repo.name) throw new Error("input-json.repo.owner and input-json.repo.name are required");
  return { owner: repo.owner, name: repo.name };
}

function requireIssueNumber(input: RenderClaimInput): number {
  const issueNumber = input.issue_number;
  if (!Number.isFinite(issueNumber)) throw new Error("input-json.issue_number is required");
  return Number(issueNumber);
}

function githubRepositoryIdentity(value: string | undefined): { owner: string; name: string } | null {
  if (value == null) return null;
  const match = value.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match) throw new Error("status --provider github --repo must be an exact owner/repo identity");
  return { owner: match[1], name: match[2] };
}

function requireRenderedClaimProvenance(
  input: RenderClaimInput,
  actor: ActorStruct,
  repo: { owner: string; name: string },
  issueNumber: number,
): { actorKey: string; workItemRef: string } {
  const actorKey = input.actor_key;
  if (typeof actorKey !== "string" || !actorKey || actorKey !== actorKey.trim()) {
    throw new Error("input-json.actor_key is required and must be the exact canonical actor key");
  }
  const helper = loadActorIdentityHelper();
  const expectedActorKey = actor.runtime === "explicit-override"
    ? helper.sanitizeSegment(actor.session_id)
    : helper.serializeActor(actor);
  if (actorKey !== expectedActorKey) {
    throw new Error(`input-json.actor_key must exactly match the canonical actor JSON identity (${expectedActorKey})`);
  }

  const workItemRef = input.work_item_ref;
  const expectedWorkItemRef = `${repo.owner}/${repo.name}#${issueNumber}`;
  if (typeof workItemRef !== "string" || workItemRef !== expectedWorkItemRef) {
    throw new Error(`input-json.work_item_ref must exactly match ${expectedWorkItemRef}`);
  }
  return { actorKey, workItemRef };
}

function renderClaimCommentBody(record: AssignmentClaimRecord, marker: string): string {
  const humanNote = record.actor.human ? `Assigned to human ${record.actor.human}.` : `Claimed by an automated agent session (${record.actor.runtime}).`;
  return [
    marker,
    `**Assignment claim** — ${humanNote}`,
    "",
    `- actor: \`${loadActorIdentityHelper().serializeActor(record.actor)}\``,
    `- claimed_at: ${record.claimed_at}`,
    `- ttl_seconds: ${record.ttl_seconds}`,
    `- branch: \`${record.branch}\``,
    "",
    "```json",
    JSON.stringify(record, null, 2),
    "```",
  ].join("\n");
}

function renderHandoffCommentBody(subjectId: string, input: RenderClaimInput): string {
  const marker = input.claim_comment_marker ?? CLAIM_COMMENT_MARKER_DEFAULT;
  const record = input.previous_record
    ? {
      ...input.previous_record,
      status: "released" as const,
      audit_trail: [...(input.previous_record.audit_trail ?? []), { at: isoNow(), transition: "release" as const, from_actor: input.previous_record.actor, to_actor: null, reason: input.reason ?? "released" }],
    }
    : null;
  const lines = [marker, `**Assignment released** — subject \`${subjectId}\` is free.`];
  if (record) lines.push("", "```json", JSON.stringify(record, null, 2), "```");
  return lines.join("\n");
}

function renderClaim(argv: string[]): number {
  const args = parseArgs(argv);
  const provider = flagString(args.flags, "provider", "github");
  if (provider !== "github") throw new Error(`render-claim: --provider must be github; got ${provider}`);
  const subjectId = requireFlag(args, "subject-id");
  const input = loadJsonInput(requireFlag(args, "input-json")) as RenderClaimInput;
  const actor = loadActorStructFromFile(requireFlag(args, "actor-json"));
  const repo = requireRepo(input);
  const issueNumber = requireIssueNumber(input);
  const { actorKey, workItemRef } = requireRenderedClaimProvenance(input, actor, repo, issueNumber);
  const labelName = input.label_name ?? DEFAULT_LABEL_NAME;
  const marker = input.claim_comment_marker ?? CLAIM_COMMENT_MARKER_DEFAULT;
  const ttlSeconds = input.ttl_seconds ?? 1800;
  const branch = input.branch;
  const artifactDir = input.artifact_dir;
  if (!branch) throw new Error("input-json.branch is required for render-claim");
  if (!artifactDir) throw new Error("input-json.artifact_dir is required for render-claim");

  const record: AssignmentClaimRecord = {
    schema_version: "1.0",
    role: "AssignmentClaimRecord",
    subject_id: subjectId,
    actor,
    actor_key: actorKey,
    work_item_ref: workItemRef,
    claimed_at: isoNow(),
    ttl_seconds: ttlSeconds,
    branch,
    artifact_dir: artifactDir,
    status: "claimed",
  };
  const repoSlug = `${repo.owner}/${repo.name}`;
  const commentBody = renderClaimCommentBody(record, marker);
  const ghCommands: string[][] = [];
  if (input.assignee_login) ghCommands.push(["gh", "issue", "edit", String(issueNumber), "--repo", repoSlug, "--add-assignee", input.assignee_login]);
  ghCommands.push(["gh", "issue", "edit", String(issueNumber), "--repo", repoSlug, "--add-label", labelName]);
  ghCommands.push(
    input.existing_comment_id
      ? ["gh", "api", "--method", "PATCH", `repos/${repoSlug}/issues/comments/${input.existing_comment_id}`, "-f", `body=${commentBody}`]
      : ["gh", "issue", "comment", String(issueNumber), "--repo", repoSlug, "--body", commentBody],
  );
  console.log(JSON.stringify({ role: "AssignmentRenderResult", transition: "claim", subject_id: subjectId, gh_commands: ghCommands, claim_comment_body: commentBody, record }, null, 2));
  return 0;
}

function renderRelease(argv: string[]): number {
  const args = parseArgs(argv);
  const provider = flagString(args.flags, "provider", "github");
  if (provider !== "github") throw new Error(`render-release: --provider must be github; got ${provider}`);
  const subjectId = requireFlag(args, "subject-id");
  const input = loadJsonInput(requireFlag(args, "input-json")) as RenderClaimInput;
  const repo = requireRepo(input);
  const issueNumber = requireIssueNumber(input);
  const labelName = input.label_name ?? DEFAULT_LABEL_NAME;
  const repoSlug = `${repo.owner}/${repo.name}`;
  const ghCommands: string[][] = [];
  const assigneeLogin = input.existing_assignee_login ?? input.assignee_login;
  if (assigneeLogin) ghCommands.push(["gh", "issue", "edit", String(issueNumber), "--repo", repoSlug, "--remove-assignee", assigneeLogin]);
  ghCommands.push(["gh", "issue", "edit", String(issueNumber), "--repo", repoSlug, "--remove-label", labelName]);
  const handoffBody = renderHandoffCommentBody(subjectId, input);
  ghCommands.push(
    input.existing_comment_id
      ? ["gh", "api", "--method", "PATCH", `repos/${repoSlug}/issues/comments/${input.existing_comment_id}`, "-f", `body=${handoffBody}`]
      : ["gh", "issue", "comment", String(issueNumber), "--repo", repoSlug, "--body", handoffBody],
  );
  console.log(JSON.stringify({ role: "AssignmentRenderResult", transition: "release", subject_id: subjectId, gh_commands: ghCommands, claim_comment_body: handoffBody }, null, 2));
  return 0;
}

function renderSupersede(argv: string[]): number {
  const args = parseArgs(argv);
  const provider = flagString(args.flags, "provider", "github");
  if (provider !== "github") throw new Error(`render-supersede: --provider must be github; got ${provider}`);
  const subjectId = requireFlag(args, "subject-id");
  const input = loadJsonInput(requireFlag(args, "input-json")) as RenderClaimInput;
  const toActor = loadActorStructFromFile(requireFlag(args, "actor-json"));
  const repo = requireRepo(input);
  const issueNumber = requireIssueNumber(input);
  const { actorKey, workItemRef } = requireRenderedClaimProvenance(input, toActor, repo, issueNumber);
  const labelName = input.label_name ?? DEFAULT_LABEL_NAME;
  const marker = input.claim_comment_marker ?? CLAIM_COMMENT_MARKER_DEFAULT;
  const ttlSeconds = input.ttl_seconds ?? 1800;
  const branch = input.branch;
  const artifactDir = input.artifact_dir;
  if (!branch) throw new Error("input-json.branch is required for render-supersede");
  if (!artifactDir) throw new Error("input-json.artifact_dir is required for render-supersede");
  // Wave 4 AC: render-supersede must edit the existing claim comment in place, never duplicate it.
  if (!input.existing_comment_id) throw new Error("input-json.existing_comment_id is required for render-supersede (edits the claim comment in place; never duplicates it)");

  const previousActor = input.previous_record?.actor ?? null;
  const record: AssignmentClaimRecord = {
    schema_version: "1.0",
    role: "AssignmentClaimRecord",
    subject_id: subjectId,
    actor: toActor,
    actor_key: actorKey,
    work_item_ref: workItemRef,
    claimed_at: isoNow(),
    ttl_seconds: ttlSeconds,
    branch,
    artifact_dir: artifactDir,
    status: "claimed",
    audit_trail: [...(input.previous_record?.audit_trail ?? []), { at: isoNow(), transition: "supersede", from_actor: previousActor, to_actor: toActor, reason: input.reason ?? "supersede" }],
  };
  const repoSlug = `${repo.owner}/${repo.name}`;
  const commentBody = renderClaimCommentBody(record, marker);
  const ghCommands: string[][] = [];
  const previousAssignee = input.existing_assignee_login;
  if (previousAssignee && previousAssignee !== input.assignee_login) ghCommands.push(["gh", "issue", "edit", String(issueNumber), "--repo", repoSlug, "--remove-assignee", previousAssignee]);
  if (input.assignee_login) ghCommands.push(["gh", "issue", "edit", String(issueNumber), "--repo", repoSlug, "--add-assignee", input.assignee_login]);
  ghCommands.push(["gh", "issue", "edit", String(issueNumber), "--repo", repoSlug, "--add-label", labelName]);
  ghCommands.push(["gh", "api", "--method", "PATCH", `repos/${repoSlug}/issues/comments/${input.existing_comment_id}`, "-f", `body=${commentBody}`]);
  console.log(JSON.stringify({ role: "AssignmentRenderResult", transition: "supersede", subject_id: subjectId, gh_commands: ghCommands, claim_comment_body: commentBody, record }, null, 2));
  return 0;
}

// ─── status | list (both provider kinds) ────────────────────────────────────────────────────

/**
 * Wave 1 (#291) extraction: the local-file branch of statusCommand's assignment-layer read,
 * mirrored exactly so ensure-session's ownership guard (workflow-sidecar.ts, Wave 2) derives an
 * AssignmentStatus identically to the `assignment-provider status` CLI command — a single
 * implementation, not a second parallel local-file read.
 */
export function readLocalAssignmentStatus(artifactRoot: string, subjectId: string): AssignmentStatus {
  const record = readLocalRecord(artifactRoot, subjectId);
  const active = record && record.status === "claimed" ? record : null;
  return { subject_id: subjectId, provider: "local-file", assignee: active ? loadActorIdentityHelper().serializeActor(active.actor) : null, record: active };
}

function statusCommand(argv: string[]): number {
  const args = parseArgs(argv);
  const provider = requireFlag(args, "provider");
  const requestedSubjectId = flagString(args.flags, "subject-id");
  let assignment: AssignmentStatus;

  if (provider === "local-file") {
    const artifactRoot = requireFlag(args, "artifact-root");
    if (!requestedSubjectId) throw new Error("--subject-id is required for status --provider local-file");
    assignment = readLocalAssignmentStatus(artifactRoot, requestedSubjectId);
  } else if (provider === "github") {
    const issueJsonPath = requireFlag(args, "issue-json");
    const issue = loadJsonInput(issueJsonPath) as GithubIssueDoc;
    const repository = githubRepositoryIdentity(flagString(args.flags, "repo"));
    const labelName = flagString(args.flags, "label-name", DEFAULT_LABEL_NAME) ?? DEFAULT_LABEL_NAME;
    const marker = flagString(args.flags, "claim-comment-marker", CLAIM_COMMENT_MARKER_DEFAULT) ?? CLAIM_COMMENT_MARKER_DEFAULT;
    assignment = githubAssignmentStatus(issue, labelName, marker);
    if (requestedSubjectId && assignment.record && assignment.record.subject_id !== requestedSubjectId) {
      throw new Error(`claim record subject_id ${assignment.record.subject_id} does not match requested --subject-id ${requestedSubjectId}`);
    }
    if (requestedSubjectId) assignment.subject_id = requestedSubjectId;
    const issueNumber = Number(issue.number);
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
      throw new Error("status --provider github issue JSON must expose a positive safe-integer issue number");
    }
    assignment.repository = repository;
    assignment.issue_number = issueNumber;
  } else {
    throw new Error(`status: unsupported --provider ${provider}`);
  }

  const { events, selfActor } = loadLivenessInputs(args);
  const nowMs = flagString(args.flags, "now") ? Date.parse(flagString(args.flags, "now") as string) : Date.now();
  const freshList = events !== null ? loadLivenessReadHelper().freshHolders(events, assignment.subject_id, selfActor ?? "", nowMs) : [];
  const effective = events !== null
    ? computeEffectiveState(assignment, freshList, selfActor, nowMs)
    : { effective_state: null, reason: "liveness input not provided (pass --liveness-events-json or --liveness-stream); effective state not computed" };
  console.log(JSON.stringify({ role: "AssignmentStatus", provider, assignment, effective }, null, 2));
  return 0;
}

function listCommand(argv: string[]): number {
  const args = parseArgs(argv);
  const provider = requireFlag(args, "provider");
  const actorJsonFilter = flagString(args.flags, "actor-json");
  const actorFilter = actorJsonFilter ? loadActorIdentityHelper().serializeActor(loadActorStructFromFile(actorJsonFilter)) : flagString(args.flags, "actor");
  const subjectIds: string[] = [];

  if (provider === "local-file") {
    const artifactRoot = requireFlag(args, "artifact-root");
    const dir = path.join(artifactRoot, "assignment");
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort() : [];
    for (const name of files) {
      const record = readJson(path.join(dir, name)) as AssignmentClaimRecord;
      if (record.status !== "claimed") continue;
      // #777 review: filter on the CANONICAL holder key (stored actor_key first, serialized
      // actor as fallback) — explicit-override actors deliberately diverge between the two.
      if (actorFilter && canonicalHolderActorKey(record) !== actorFilter) continue;
      subjectIds.push(record.subject_id);
    }
  } else if (provider === "github") {
    const issuesJsonPath = requireFlag(args, "issues-json");
    const doc = loadJsonInput(issuesJsonPath);
    const issues = Array.isArray(doc) ? doc as GithubIssueDoc[] : ((doc as AnyObj).items as GithubIssueDoc[] ?? []);
    const labelName = flagString(args.flags, "label-name", DEFAULT_LABEL_NAME) ?? DEFAULT_LABEL_NAME;
    const marker = flagString(args.flags, "claim-comment-marker", CLAIM_COMMENT_MARKER_DEFAULT) ?? CLAIM_COMMENT_MARKER_DEFAULT;
    for (const issue of issues) {
      const assignment = githubAssignmentStatus(issue, labelName, marker);
      if (!assignment.record || assignment.record.status !== "claimed") continue;
      // #777 review: same canonical-key rule as the local-file branch above.
      if (actorFilter && canonicalHolderActorKey(assignment.record) !== actorFilter) continue;
      subjectIds.push(assignment.record.subject_id);
    }
  } else {
    throw new Error(`list: unsupported --provider ${provider}`);
  }

  console.log(JSON.stringify({ role: "AssignmentList", provider, actor: actorFilter ?? null, subject_ids: subjectIds }, null, 2));
  return 0;
}

export function main(argv = process.argv.slice(2)): number {
  try {
    const [command, ...rest] = argv;
    if (command === "claim") return claimLocalFile(rest);
    if (command === "release") return releaseLocalFile(rest);
    if (command === "supersede") return supersedeLocalFile(rest);
    if (command === "render-claim") return renderClaim(rest);
    if (command === "render-release") return renderRelease(rest);
    if (command === "render-supersede") return renderSupersede(rest);
    if (command === "status") return statusCommand(rest);
    if (command === "list") return listCommand(rest);
    console.error("usage: assignment-provider <claim|release|supersede|render-claim|render-release|render-supersede|status|list> [flags]");
    return 2;
  } catch (error) {
    console.error(`assignment-provider: ${(error as Error).message}`);
    return 1;
  }
}

// Use process.exitCode (not process.exit) to allow stdout to be flushed before exit.
// Resolve real paths to handle symlinks (e.g. /tmp -> /private/tmp on macOS) so the
// entry-point guard fires correctly when the module is loaded directly as a script.
const _selfRealPath = (() => { try { return fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return fileURLToPath(import.meta.url); } })();
const _argv1RealPath = (() => { try { return fs.realpathSync(process.argv[1]); } catch { return process.argv[1]; } })();
if (_selfRealPath === _argv1RealPath) { process.exitCode = main(); }
