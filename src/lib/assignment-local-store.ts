/**
 * The local-file assignment store and provider: durable claim records under
 * `<artifact-root>/assignment/<subject>.json`, written with full read-modify-write under a
 * per-subject directory lock. Published as `@kontourai/flow-agents/assignment-local-file`.
 *
 * This is the one assignment module that does real I/O (`fs`), which is why it is a separate entry
 * from the pure `assignment-contract`: a host that supplies its own store imports only the
 * contract, and a host that wants to read and write the SAME store Flow's CLI uses imports this.
 * The record format is the contract's codec, so both sides see the same claims.
 *
 * Builder Kit policy is not here: nothing in this module decides when a session claims or
 * releases. The CLI, the Stop hook and `ensure-session` call these functions at the moments they
 * own.
 *
 * @module
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { atomicWriteJson, readJson, isoNow } from "./fs.js";
import {
  canonicalHolderActorKey,
  decodeAssignmentClaimRecord,
  sanitizeSegment,
  serializeActor,
  type ActorStruct,
  type AssignmentClaimMeta,
  type AssignmentClaimRecord,
  type AssignmentProvider,
  type AssignmentReleaseMeta,
  type AssignmentStatus,
  type AssignmentSupersedeMeta,
} from "./assignment-model.js";

export function assignmentFilePath(artifactRoot: string, subjectId: string): string {
  const sanitized = sanitizeSegment(subjectId);
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
  const decoded = decodeAssignmentClaimRecord(data);
  if (!decoded.ok) {
    if (decoded.code === "unsupported_schema_version") throw new Error(`${file}: unsupported schema_version ${decoded.found}`);
    throw new Error(`assignment record is not an object: ${file}`);
  }
  return decoded.record;
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
  const sanitized = sanitizeSegment(subjectId);
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
  const reason = opts.reason ?? "claim";

  // F1 fix (fix-plan iteration 1, CRITICAL): the existing-claim check AND the write must happen
  // atomically with respect to any other `assignment-provider` invocation on the same subject —
  // see withSubjectLock()'s doc comment for the full rationale.
  return withSubjectLock(artifactRoot, subjectId, (): AssignmentClaimRecord => {
    const existing = readLocalRecord(artifactRoot, subjectId);
    if (existing && existing.status === "claimed") {
      const existingActorKey = serializeActor(existing.actor);
      const newActorKey = serializeActor(actor);
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
 *   `record.actor_key || serializeActor(record.actor)` canonical-key preference EXACTLY
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
      const holderActorKey = existing.actor_key || serializeActor(existing.actor);
      const releasedByActorKey = opts.actorKey || serializeActor(releasedBy);
      // Pre-3.7 lifecycle events could persist the derived ancestry actor before
      // sanitizeSegment removed ':' separators. Modern explicit/env release paths
      // always use the sanitized form. Accept only that one-way legacy migration;
      // never normalize two modern keys or relax ownership to a prefix match.
      const sameActorStruct = existing.actor.runtime === releasedBy.runtime
        && existing.actor.session_id === releasedBy.session_id
        && existing.actor.host === releasedBy.host
        && (existing.actor.human ?? null) === (releasedBy.human ?? null);
      const legacyActorKeyMatches = holderActorKey.includes(":")
        && holderActorKey === serializeActor(existing.actor)
        && sanitizeSegment(holderActorKey) === releasedByActorKey
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
  const reason = opts.reason ?? "supersede";

  // F1 fix (fix-plan iteration 1, CRITICAL): supersede mutates the same record file claim/release
  // do, under the same per-subject lock (see withSubjectLock()'s doc comment).
  return withSubjectLock(artifactRoot, subjectId, (): AssignmentClaimRecord => {
    const existing = readLocalRecord(artifactRoot, subjectId);
    if (!existing || existing.status !== "claimed") throw new Error(`no active claim to supersede for subject: ${subjectId}`);

    if (serializeActor(existing.actor) !== serializeActor(fromActor)) {
      throw new Error(`--from-actor-json does not match the current holder (${serializeActor(existing.actor)}); refusing to supersede a claim held by someone else`);
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

/**
 * Wave 1 (#291) extraction: the local-file branch of statusCommand's assignment-layer read,
 * mirrored exactly so ensure-session's ownership guard (workflow-sidecar.ts, Wave 2) derives an
 * AssignmentStatus identically to the `assignment-provider status` CLI command — a single
 * implementation, not a second parallel local-file read.
 */
export function readLocalAssignmentStatus(artifactRoot: string, subjectId: string): AssignmentStatus {
  const record = readLocalRecord(artifactRoot, subjectId);
  const active = record && record.status === "claimed" ? record : null;
  return { subject_id: subjectId, provider: "local-file", assignee: active ? serializeActor(active.actor) : null, record: active };
}


/**
 * Enumerate subject ids with an active (`status: "claimed"`) local-file assignment record,
 * optionally filtered to one actor's CANONICAL actor key (`canonicalHolderActorKey`, the same rule
 * the join uses for self-recognition, so `list` and the join cannot diverge for an
 * explicit-override actor whose stored `actor_key` differs from a re-serialized `actor`).
 */
export function listLocalAssignedSubjects(artifactRoot: string, actorKey?: string): string[] {
  const dir = path.join(artifactRoot, "assignment");
  if (!fs.existsSync(dir)) return [];
  const subjectIds: string[] = [];
  for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith(".json")).sort()) {
    const record = readJson(path.join(dir, name)) as AssignmentClaimRecord;
    if (record.status !== "claimed") continue;
    if (actorKey && canonicalHolderActorKey(record) !== actorKey) continue;
    subjectIds.push(record.subject_id);
  }
  return subjectIds;
}

/**
 * Local-file-adapter-specific capability extension (#777 review finding 1): the record-returning
 * counterparts to `AssignmentProvider`'s void-returning `claim`/`release`/`supersede`, for hosts
 * that specifically want the local-file adapter's synchronously-written `AssignmentClaimRecord`
 * instead of a second `status()` round trip. This interface is intentionally NOT part of
 * `AssignmentProvider` itself — it is a capability only an adapter with direct, synchronous
 * storage access (the local-file adapter) can honestly provide; a GitHub-backed adapter cannot
 * implement it without fabricating a record the render-don't-execute split does not actually
 * produce. A host must explicitly opt in by checking for/depending on this extension (e.g. `if
 * ("claimReturning" in provider) ...`) rather than this leaking into the general contract every
 * `AssignmentProvider` consumer is typed against. `createLocalFileAssignmentProvider`
 * (`local-file-provider-adapters.ts`) returns an object satisfying `AssignmentProvider &
 * LocalAssignmentProviderExt`.
 */
export interface LocalAssignmentProviderExt {
  /** Record-returning counterpart to `AssignmentProvider.claim` — see that method's doc comment
   * and `performLocalClaim`'s return value. */
  claimReturning(subjectId: string, actor: ActorStruct, meta: AssignmentClaimMeta): AssignmentClaimRecord | Promise<AssignmentClaimRecord>;
  /** Record-returning counterpart to `AssignmentProvider.release` — see that method's doc comment
   * and `performLocalRelease`'s return value (`null` for a tolerated no-op). */
  releaseReturning(
    subjectId: string,
    releasedBy: ActorStruct | null,
    meta?: AssignmentReleaseMeta,
  ): AssignmentClaimRecord | null | Promise<AssignmentClaimRecord | null>;
  /** Record-returning counterpart to `AssignmentProvider.supersede` — see that method's doc
   * comment and `performLocalSupersede`'s return value. */
  supersedeReturning(
    subjectId: string,
    from: ActorStruct,
    to: ActorStruct,
    meta?: AssignmentSupersedeMeta,
  ): AssignmentClaimRecord | Promise<AssignmentClaimRecord>;
}


/**
 * `AssignmentProvider` (+ `LocalAssignmentProviderExt`) over the local-file record store rooted at
 * `artifactRoot`.
 *
 * The neutral `claim`/`release`/`supersede` methods delegate to the same
 * `performLocalClaim`/`performLocalRelease`/`performLocalSupersede` as their `*Returning`
 * counterparts, discarding the return value to match `AssignmentProvider`'s ADR-0021-faithful
 * `void` surface (#777 review finding 1): one write path per operation, never two.
 */
export function createLocalFileAssignmentProvider(artifactRoot: string): AssignmentProvider & LocalAssignmentProviderExt {
  return {
    claim: (subjectId, actor, meta) => {
      performLocalClaim(artifactRoot, subjectId, actor, meta);
    },
    release: (subjectId, releasedBy, meta) => {
      performLocalRelease(artifactRoot, subjectId, releasedBy, meta ?? {});
    },
    supersede: (subjectId, from, to, meta) => {
      performLocalSupersede(artifactRoot, subjectId, from, to, meta ?? {});
    },
    status: (subjectId) => readLocalAssignmentStatus(artifactRoot, subjectId),
    list: (actorKey) => listLocalAssignedSubjects(artifactRoot, actorKey),
    claimReturning: (subjectId, actor, meta) => performLocalClaim(artifactRoot, subjectId, actor, meta),
    releaseReturning: (subjectId, releasedBy, meta) => performLocalRelease(artifactRoot, subjectId, releasedBy, meta ?? {}),
    supersedeReturning: (subjectId, from, to, meta) => performLocalSupersede(artifactRoot, subjectId, from, to, meta ?? {}),
  } satisfies AssignmentProvider & LocalAssignmentProviderExt;
}
