'use strict';
/**
 * current-pointer.js — shared pure-CJS per-actor "current" pointer reader/writer (#291)
 *
 * Zero external dependencies (only Node core: fs, path, crypto). Consumed by:
 *   - build/src/cli/workflow-sidecar.js  (ESM compiled, via createRequire — Wave 2 Task 2.1)
 *   - build/src/lib/flow-resolver.js     (ESM compiled, via createRequire — Wave 2 Task 2.2)
 *   - scripts/hooks/stop-goal-fit.js, evidence-capture.js, lib/liveness-heartbeat.js,
 *     scripts/statusline/flow-agents-statusline.js (CJS, direct require — Wave 2 Task 2.3)
 *   - scripts/hooks/workflow-steering.js (CJS, direct require — Wave 2 Task 2.4)
 *
 * Purpose (issue #291): today every one of the consumers above hand-rolls its own
 * `fs.readFileSync(path.join(flowAgentsDir, "current.json"))`, so once `ensure-session` starts
 * projecting a per-actor `current/<actor>.json` pointer (Wave 2 Task 2.1's `writeCurrent()` dual
 * write), every reader must gain the SAME actor-aware preference or session A's own "what am I
 * working on" view keeps getting silently overwritten by session B's more-recent legacy write.
 * This module is the single choke point for that preference rule — every reader listed above
 * calls `readCurrentPointer()` instead of hand-rolling its own fallback, so the compat-shim rule
 * (per-actor first, legacy-global fallback) can never drift between call sites.
 *
 * Per-actor filename scheme (#440 fix-wave 2, collision fix): the per-actor filename is
 * `<sanitizeSegment(actorKey) capped at 40 chars>-<first 16 hex chars of sha256(actorKey)>.json`.
 * `sanitizeSegment` is required from `./actor-identity.js` (already reviewed: restricts to
 * `[A-Za-z0-9_.-]`, caps 64 chars) and is reused, not re-implemented, for the readable prefix —
 * but the sanitized-and-capped value ALONE is not collision-resistant: two distinct actor keys
 * that share the first 64 sanitized characters, or differ only in characters `sanitizeSegment`
 * strips (e.g. "a:bc" vs "ab:c", both sanitizing to "abc"), previously mapped onto the SAME file —
 * actor B's dual-write would silently overwrite actor A's pointer, and A's own hook reads would
 * then ground onto B's session. The appended hash of the FULL (untruncated, unsanitized) actor
 * key makes two distinct actor keys collide only on a 64-bit truncated-digest collision (the
 * retained 16 hex chars of sha256, ~2^32-operation birthday bound) — negligible at any real fleet
 * scale (nowhere near the number of distinct actor identities any deployment will ever generate),
 * but NOT cryptographic full-strength collision resistance (that would need the full 256-bit
 * digest); the sanitized prefix keeps the filename human-legible for debugging.
 *
 * Compatibility / transition (#440 fix-wave 2): `writePerActorCurrent` writes ONLY the new
 * collision-resistant filename from here on. `readCurrentPointer`'s per-actor branch and
 * `readOwnCurrentPointer` both try the NEW filename first, then fall back to the LEGACY filename
 * (`legacyPerActorCurrentFile` — the pre-fix-wave-2 `sanitizeSegment(actorKey).slice(0, 64)+".json"`
 * scheme, exported for callers/evals that need to construct it, e.g. to prove the fallback) ONLY
 * when the new file doesn't exist/parse — so a pointer already written by a pre-fix-wave-2 sidecar
 * (e.g. a still-running published-3.9.0-era session) keeps resolving during the rollout window.
 * This legacy-name fallback intentionally retains the OLD (status-quo, pre-fix) collision exposure
 * — but ONLY for that fallback read of a pre-existing file, never for a new write, which always
 * uses the collision-resistant name. The fallback is TRANSITION-WINDOW ONLY, not a permanent
 * feature of this module: every write (including a read-triggered migration via
 * `updateCurrentAgent` in workflow-sidecar.ts, #440 fix-wave 3) upgrades a pointer to the new
 * name, so live pointers self-migrate through ordinary use. Note the migration WRITES the
 * new-name file but never deletes the legacy file — stale legacy files may linger harmlessly
 * (the new name always wins on read). Removal criterion: once no supported/live actor still
 * depends EXCLUSIVELY on a legacy-name pointer (i.e. every live session has written at least
 * once past this fix's rollout) — practically, at the next major version as a deliberate
 * cutover point — `legacyPerActorCurrentFile` and its two call sites below can be deleted
 * outright.
 *
 * Exports:
 *   perActorCurrentFile(flowAgentsDir, actorKey)       → string (NEW collision-resistant path;
 *                                                          existence not implied)
 *   legacyPerActorCurrentFile(flowAgentsDir, actorKey) → string (pre-fix-wave-2 path, read-side
 *                                                          fallback only; existence not implied)
 *   readCurrentPointer(flowAgentsDir, actorKey)       → { payload: object|null,
 *                                                        source: "per-actor"|"legacy"|"none",
 *                                                        file: string|null }
 *   readOwnCurrentPointer(flowAgentsDir, actorKey)    → { payload: object|null,
 *                                                        source: "per-actor"|"legacy"|"none",
 *                                                        file: string|null }  (#440 — ownership-bearing
 *                                                        read; never falls back to the shared legacy
 *                                                        current.json for a RESOLVED actor)
 *   writePerActorCurrent(flowAgentsDir, actorKey, payload) → void
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sanitizeSegment, isUnresolvedActor } = require('./actor-identity.js');

// #440 fix-wave 2: readable-prefix cap for the NEW collision-resistant filename. Generous (not
// the collision boundary — the appended hash below is), just keeps filenames legible for
// debugging. First 16 hex chars of sha256(actorKey) is a 64-bit truncated digest (~2^32-operation
// birthday bound) — negligible at any real fleet scale, though NOT cryptographic full-strength
// collision resistance (that needs the full 256-bit digest) — appended so two distinct actor keys
// collide only on a genuine 64-bit truncated-digest collision, not merely a shared 64-char
// sanitized prefix.
const PER_ACTOR_PREFIX_LEN = 40;
const PER_ACTOR_HASH_LEN = 16;
const POINTER_LOCK_WAIT_MS = 30_000;
const POINTER_LOCK_STALE_MS = 5 * 60_000;
const heldPointerParentIdentities = new Map();

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function readLockOwner(file) {
  try {
    const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
    return owner && typeof owner.token === 'string' && owner.token ? owner : null;
  } catch {
    return null;
  }
}

function sameIdentity(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino;
}

function removeOwnEmptyPointerLock(lockDir, identity) {
  try {
    const current = fs.lstatSync(lockDir);
    if (!current.isSymbolicLink() && current.isDirectory() && sameIdentity(current, identity)) {
      fs.rmdirSync(lockDir);
    }
  } catch (error) {
    if (!error || !['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  }
}

/**
 * Serialize every mutation of one actor's pointer. A contender may wait for a
 * live owner, but stale or malformed residue requires explicit cleanup because
 * portable filesystem APIs cannot safely replace an unknown lock owner.
 */
function createPointerLock(lockDir, ownerFile, token) {
  fs.mkdirSync(lockDir);
  let lockIdentity = null;
  let ownerIdentity = null;
  try {
    lockIdentity = fs.lstatSync(lockDir);
    fs.writeFileSync(
      ownerFile,
      `${JSON.stringify({ token, pid: process.pid, acquired_at: new Date().toISOString() })}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    ownerIdentity = fs.lstatSync(ownerFile);
    return {
      lockDir,
      ownerFile,
      token,
      lockIdentity,
      ownerIdentity,
    };
  } catch (error) {
    if (lockIdentity && ownerIdentity) {
      releasePointerLock({ lockDir, ownerFile, token, lockIdentity, ownerIdentity });
    } else if (lockIdentity) {
      removeOwnEmptyPointerLock(lockDir, lockIdentity);
    }
    throw error;
  }
}

function assertLivePointerLock(lockDir, ownerFile) {
  const owner = readLockOwner(ownerFile);
  const target = owner ? ownerFile : lockDir;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !(owner ? stat.isFile() : stat.isDirectory())) {
    throw new Error(`actor current-pointer lock has an unsafe owner: ${lockDir}`);
  }
  if (Date.now() - stat.mtimeMs > POINTER_LOCK_STALE_MS) {
    throw new Error(`actor current-pointer lock is stale or malformed and requires explicit operator cleanup: ${lockDir}`);
  }
}

function acquirePointerLock(file) {
  const lockDir = `${file}.lockdir`;
  const ownerFile = path.join(lockDir, 'owner.json');
  const token = crypto.randomBytes(16).toString('hex');
  const deadline = Date.now() + POINTER_LOCK_WAIT_MS;
  while (true) {
    try {
      return createPointerLock(lockDir, ownerFile, token);
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        throw new Error(`failed to acquire actor current-pointer lock: ${lockDir}: ${error?.message || String(error)}`);
      }
      try {
        assertLivePointerLock(lockDir, ownerFile);
      } catch (statError) {
        if (statError && statError.code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for actor current-pointer lock: ${lockDir}`);
      }
      sleepSync(20);
    }
  }
}

function assertPointerLockOwned(lockParent, parentIdentity, lock) {
  const currentParent = fs.lstatSync(lockParent);
  const currentLock = fs.lstatSync(lock.lockDir);
  const currentOwner = fs.lstatSync(lock.ownerFile);
  if (!sameIdentity(currentParent, parentIdentity)
      || currentParent.isSymbolicLink() || !currentParent.isDirectory()
      || currentLock.isSymbolicLink()
      || !currentLock.isDirectory()
      || !sameIdentity(currentLock, lock.lockIdentity)
      || currentOwner.isSymbolicLink()
      || !currentOwner.isFile()
      || !sameIdentity(currentOwner, lock.ownerIdentity)
      || readLockOwner(lock.ownerFile)?.token !== lock.token) {
    throw new Error(`actor current-pointer lock detached from its protected parent: ${lock.lockDir}`);
  }
}

function releasePointerLock(lock) {
  try {
    const currentLock = fs.lstatSync(lock.lockDir);
    const currentOwner = fs.lstatSync(lock.ownerFile);
    if (sameIdentity(currentLock, lock.lockIdentity)
      && sameIdentity(currentOwner, lock.ownerIdentity)
      && readLockOwner(lock.ownerFile)?.token === lock.token) {
      fs.unlinkSync(lock.ownerFile);
      fs.rmdirSync(lock.lockDir);
    }
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
}

function withPointerFileLock(file, body) {
  const lockParent = path.resolve(path.dirname(`${file}.lockdir`));
  fs.mkdirSync(lockParent, { recursive: true });
  const parentIdentity = fs.lstatSync(lockParent);
  if (parentIdentity.isSymbolicLink() || !parentIdentity.isDirectory()) {
    throw new Error(`actor current-pointer lock parent must be a real directory: ${lockParent}`);
  }
  const lock = acquirePointerLock(file);
  try {
    assertPointerLockOwned(lockParent, parentIdentity, lock);
    heldPointerParentIdentities.set(lockParent, parentIdentity);
    try {
      return body();
    } finally {
      heldPointerParentIdentities.delete(lockParent);
    }
  } finally {
    releasePointerLock(lock);
  }
}

function withPointerFileLocks(files, body, index = 0) {
  const ordered = [...new Set(files)].sort();
  if (index >= ordered.length) return body();
  return withPointerFileLock(
    ordered[index],
    () => withPointerFileLocks(ordered, body, index + 1),
  );
}

function actorMutationLockFile(flowAgentsDir) {
  return path.join(path.resolve(flowAgentsDir), 'current', '.actor-pointers');
}

function withPointerLock(flowAgentsDir, actorKey, body) {
  const actorRoot = ensureSafeCurrentDirectory(flowAgentsDir);
  const file = perActorCurrentFile(flowAgentsDir, actorKey);
  if (path.dirname(path.resolve(file)) !== actorRoot) {
    throw new Error(`actor-scoped current pointer must remain inside ${actorRoot}`);
  }
  return withPointerFileLock(actorMutationLockFile(flowAgentsDir), () => {
    if (ensureSafeCurrentDirectory(flowAgentsDir) !== actorRoot) {
      throw new Error(`actor current-pointer directory changed while locked: ${actorRoot}`);
    }
    return body();
  });
}

function assertHeldPointerParent(file) {
  const parent = path.resolve(path.dirname(file));
  const expected = heldPointerParentIdentities.get(parent);
  if (!expected) return;
  const current = fs.lstatSync(parent);
  if (current.isSymbolicLink()
    || !current.isDirectory()
    || !sameIdentity(current, expected)) {
    throw new Error(`current pointer parent changed while its mutation lock was held: ${parent}`);
  }
}

function atomicWriteRaw(file, content) {
  const parent = path.dirname(file);
  assertHeldPointerParent(file);
  const parentBefore = fs.lstatSync(parent);
  if (parentBefore.isSymbolicLink() || !parentBefore.isDirectory()) {
    throw new Error(`current pointer parent must be a real directory: ${parent}`);
  }
  const assertParentUnchanged = () => {
    assertHeldPointerParent(file);
    const current = fs.lstatSync(parent);
    if (current.isSymbolicLink()
      || !current.isDirectory()
      || current.dev !== parentBefore.dev
      || current.ino !== parentBefore.ino) {
      throw new Error(`current pointer parent changed during write: ${parent}`);
    }
  };
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  assertParentUnchanged();
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, content);
    fs.closeSync(descriptor);
    assertParentUnchanged();
    fs.renameSync(temporary, file);
    assertParentUnchanged();
  } finally {
    try { fs.closeSync(descriptor); } catch { /* already closed after a successful write */ }
    try { fs.unlinkSync(temporary); } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
}

function atomicWriteJson(file, payload) {
  atomicWriteRaw(file, `${JSON.stringify(payload, null, 2)}\n`);
}

function resolvedPointer(payload, file, source) {
  if (payload?.binding_status === 'retired') {
    return { payload: null, source: 'none', file };
  }
  return { payload, source, file };
}

/**
 * Best-effort tolerant JSON read: missing file or corrupt/unparseable content are BOTH treated
 * as "absent" (returns null), never thrown — this is an advisory read used to decide which
 * pointer file to prefer, not a durable-write persistence path. Mirrors the `readJsonFile`
 * tolerance convention already used by stop-goal-fit.js/evidence-capture.js for this exact file
 * (`current.json`) today.
 *
 * @param {string} file
 * @returns {object|null}
 */
function readJsonFileState(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile()) return { status: 'invalid', payload: null };
    const payload = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    const current = fs.lstatSync(file);
    if (current.isSymbolicLink()
      || !current.isFile()
      || current.dev !== opened.dev
      || current.ino !== opened.ino) {
      return { status: 'invalid', payload: null };
    }
    return { status: 'valid', payload };
  } catch (error) {
    return error && error.code === 'ENOENT'
      ? { status: 'missing', payload: null }
      : { status: 'invalid', payload: null };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readRawPointerState(file) {
  let descriptor;
  try {
    assertHeldPointerParent(file);
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile()) return { status: 'invalid', raw: null };
    const raw = fs.readFileSync(descriptor, 'utf8');
    const current = fs.lstatSync(file);
    assertHeldPointerParent(file);
    if (current.isSymbolicLink()
      || !current.isFile()
      || !sameIdentity(current, opened)) {
      return { status: 'invalid', raw: null };
    }
    return { status: 'valid', raw };
  } catch (error) {
    return error && error.code === 'ENOENT'
      ? { status: 'missing', raw: null }
      : { status: 'invalid', raw: null, error };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function ensureSafeCurrentDirectory(flowAgentsDir) {
  const root = path.resolve(flowAgentsDir);
  const actorRoot = path.join(root, 'current');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(actorRoot, { recursive: true });
  const stat = fs.lstatSync(actorRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`actor current-pointer directory must be a real directory: ${actorRoot}`);
  }
  const realRoot = fs.realpathSync(root);
  const realActorRoot = fs.realpathSync(actorRoot);
  const relative = path.relative(realRoot, realActorRoot);
  if (relative !== 'current' || path.isAbsolute(relative)) {
    throw new Error(`actor current-pointer directory must remain inside its artifact root: ${actorRoot}`);
  }
  return actorRoot;
}

function safeCurrentDirectoryForRead(flowAgentsDir) {
  const root = path.resolve(flowAgentsDir);
  const actorRoot = path.join(root, 'current');
  try {
    const stat = fs.lstatSync(actorRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    const realRoot = fs.realpathSync(root);
    const realActorRoot = fs.realpathSync(actorRoot);
    return path.relative(realRoot, realActorRoot) === 'current' ? actorRoot : null;
  } catch (error) {
    return error && error.code === 'ENOENT' ? undefined : null;
  }
}

function actorDirectoryIdentityForRead(flowAgentsDir) {
  const actorRoot = safeCurrentDirectoryForRead(flowAgentsDir);
  if (actorRoot === null || actorRoot === undefined) return actorRoot;
  try {
    const stat = fs.lstatSync(actorRoot);
    return { path: actorRoot, dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

function readActorJsonFileState(file, identity) {
  if (!identity) return { status: 'missing', payload: null };
  const result = readJsonFileState(file);
  try {
    const current = fs.lstatSync(identity.path);
    if (current.isSymbolicLink()
      || !current.isDirectory()
      || current.dev !== identity.dev
      || current.ino !== identity.ino) {
      return { status: 'invalid', payload: null };
    }
  } catch {
    return { status: 'invalid', payload: null };
  }
  return result;
}

/**
 * Path to the per-actor current pointer file for a given actor key (#440 fix-wave 2:
 * collision-resistant scheme — see module header). The sanitized, 40-char-capped prefix keeps
 * the filename path-traversal-safe (via the shared `sanitizeSegment`, reused not re-implemented,
 * same convention as `assignment-provider.ts`'s `assignmentFilePath()`) and human-legible; the
 * appended hash of the FULL, untruncated, unsanitized actorKey is what actually makes two
 * distinct actor keys map to distinct files.
 *
 * @param {string} flowAgentsDir
 * @param {string} actorKey
 * @returns {string}
 */
function perActorCurrentFile(flowAgentsDir, actorKey) {
  const prefix = sanitizeSegment(actorKey).slice(0, PER_ACTOR_PREFIX_LEN);
  const hash = crypto.createHash('sha256').update(String(actorKey)).digest('hex').slice(0, PER_ACTOR_HASH_LEN);
  return path.join(flowAgentsDir, 'current', `${prefix}-${hash}.json`);
}

/**
 * #440 fix-wave 2 (read-side compat only): the PRE-FIX per-actor filename scheme —
 * `sanitizeSegment(actorKey)` alone, capped at 64 chars, no hash suffix. This is the exact
 * scheme that collided (see module header) and is NEVER written by `writePerActorCurrent`
 * anymore; it exists solely so `readCurrentPointer`/`readOwnCurrentPointer` can fall back to a
 * pointer file already written under this name by a pre-fix-wave-2 sidecar, and so callers/evals
 * that need to construct that legacy path (e.g. to prove the fallback) have one canonical
 * function to call rather than re-deriving the old rule by hand.
 *
 * @param {string} flowAgentsDir
 * @param {string} actorKey
 * @returns {string}
 */
function legacyPerActorCurrentFile(flowAgentsDir, actorKey) {
  return path.join(flowAgentsDir, 'current', `${sanitizeSegment(actorKey)}.json`);
}

/**
 * The ENTIRE compat-shim fallback rule (#291): when `actorKey` is a non-empty, resolved (not
 * `isUnresolvedActor`) string and its per-actor file exists and parses, prefer it
 * (`source: "per-actor"`). Otherwise — no actorKey, an unresolved actor, or no per-actor file yet
 * — fall back to the legacy global `<flowAgentsDir>/current.json`; if THAT exists and parses,
 * return it (`source: "legacy"`). Otherwise return `{ payload: null, source: "none", file: null }`.
 *
 * A missing/corrupt per-actor file is tolerated as absent (falls through to the legacy branch,
 * never throws) — same best-effort tolerance the existing `readJsonFile`-style readers already
 * apply to `current.json` today. A parsed retirement marker is different: it is authoritative
 * absence for that actor and suppresses every fallback, so an ended binding cannot be revived by
 * stale compatibility state. For callers with no actorKey (or an unresolved one), fallback
 * remains equivalent to the original plain `current.json` read.
 *
 * @param {string} flowAgentsDir
 * @param {string} [actorKey]
 * @returns {{ payload: object|null, source: "per-actor"|"legacy"|"none", file: string|null }}
 */
function readCurrentPointer(flowAgentsDir, actorKey) {
  const key = actorKey == null ? '' : String(actorKey);
  if (key && !isUnresolvedActor(key)) {
    const perActorFile = perActorCurrentFile(flowAgentsDir, key);
    const actorIdentity = actorDirectoryIdentityForRead(flowAgentsDir);
    if (actorIdentity === null) {
      return { payload: null, source: 'none', file: perActorFile };
    }
    const perActor = readActorJsonFileState(perActorFile, actorIdentity);
    if (perActor.status === 'valid') return resolvedPointer(perActor.payload, perActorFile, 'per-actor');
    if (perActor.status === 'invalid') return { payload: null, source: 'none', file: perActorFile };
    // #440 fix-wave 2: the new collision-resistant file doesn't exist/parse — fall back to the
    // pre-fix-wave-2 legacy per-actor filename (transition window only; see module header).
    const legacyPerActorFile = legacyPerActorCurrentFile(flowAgentsDir, key);
    const legacyPerActor = readActorJsonFileState(legacyPerActorFile, actorIdentity);
    if (legacyPerActor.status === 'valid') return resolvedPointer(legacyPerActor.payload, legacyPerActorFile, 'per-actor');
    if (legacyPerActor.status === 'invalid') return { payload: null, source: 'none', file: legacyPerActorFile };
  }

  const legacyFile = path.join(flowAgentsDir, 'current.json');
  const legacy = readJsonFileState(legacyFile);
  if (legacy.status === 'valid') return resolvedPointer(legacy.payload, legacyFile, 'legacy');
  if (legacy.status === 'invalid') return { payload: null, source: 'none', file: legacyFile };

  return { payload: null, source: 'none', file: null };
}

/**
 * #440: the ownership-bearing read. Identical inputs/shape to readCurrentPointer, but for a
 * RESOLVED actor NEVER falls back to the shared legacy current.json or (by construction, since
 * this function makes no repo-wide scan) a global mtime scan — only this actor's own per-actor
 * projection counts (D1). An unresolved/empty actorKey delegates unchanged to readCurrentPointer
 * (D3 compat — today's legacy-fallback behavior is preserved exactly for that case).
 *
 * @param {string} flowAgentsDir
 * @param {string} [actorKey]
 * @returns {{ payload: object|null, source: "per-actor"|"none"|"legacy", file: string|null }}
 */
function readOwnCurrentPointer(flowAgentsDir, actorKey) {
  const key = actorKey == null ? '' : String(actorKey);
  if (!key || isUnresolvedActor(key)) {
    return readCurrentPointer(flowAgentsDir, actorKey);
  }
  const perActorFile = perActorCurrentFile(flowAgentsDir, key);
  const actorIdentity = actorDirectoryIdentityForRead(flowAgentsDir);
  if (actorIdentity === null) {
    return { payload: null, source: 'none', file: perActorFile };
  }
  const perActor = readActorJsonFileState(perActorFile, actorIdentity);
  if (perActor.status === 'valid') return resolvedPointer(perActor.payload, perActorFile, 'per-actor');
  if (perActor.status === 'invalid') return { payload: null, source: 'none', file: perActorFile };
  // #440 fix-wave 2: the new collision-resistant file doesn't exist/parse — fall back to the
  // pre-fix-wave-2 legacy per-actor filename (transition window only; see module header). This
  // is still THIS actor's own read (never the shared legacy current.json, never a global scan) —
  // D1 is unaffected, only the per-actor filename resolution gained a second name to try.
  const legacyPerActorFile = legacyPerActorCurrentFile(flowAgentsDir, key);
  const legacyPerActor = readActorJsonFileState(legacyPerActorFile, actorIdentity);
  if (legacyPerActor.status === 'valid') return resolvedPointer(legacyPerActor.payload, legacyPerActorFile, 'per-actor');
  if (legacyPerActor.status === 'invalid') return { payload: null, source: 'none', file: legacyPerActorFile };
  return { payload: null, source: 'none', file: null };
}

/**
 * Durable write-side counterpart to `readCurrentPointer`'s per-actor branch — used only by
 * `workflow-sidecar.ts`'s `writeCurrent()` (Wave 2 Task 2.1), which calls this ALONGSIDE
 * (never instead of) its existing unconditional legacy `current.json` write, so the legacy
 * compat-shim fallback always has a value to read for any caller that never resolves an actor.
 * `fs.mkdirSync` the `current/` subdir with `{ recursive: true }` before writing — this is the
 * ONLY writer of that subdir, so no other caller needs to pre-create it.
 *
 * @param {string} flowAgentsDir
 * @param {string} actorKey
 * @param {object} payload
 * @returns {void}
 */
function rollbackValidatedPointer(file, beforeRaw, writtenRaw, error) {
  if (assertRegularPointerOrMissing(file) !== writtenRaw) {
    throw new Error(`current pointer changed before validation rollback: ${file}`, { cause: error });
  }
  if (beforeRaw === null) fs.unlinkSync(file);
  else atomicWriteRaw(file, beforeRaw);
  throw error;
}

function writePerActorCurrent(flowAgentsDir, actorKey, payload, validate) {
  const file = perActorCurrentFile(flowAgentsDir, actorKey);
  withPointerLock(flowAgentsDir, actorKey, () => {
    const beforeRaw = assertRegularPointerOrMissing(file);
    const writtenRaw = `${JSON.stringify(payload, null, 2)}\n`;
    if (typeof validate === 'function') validate();
    atomicWriteRaw(file, writtenRaw);
    try {
      if (typeof validate === 'function') validate();
    } catch (error) {
      rollbackValidatedPointer(file, beforeRaw, writtenRaw, error);
    }
  });
}

/**
 * Supersede this actor's exact task binding without deleting a newer binding
 * written concurrently for another task.
 *
 * @param {string} flowAgentsDir
 * @param {string} actorKey
 * @param {string} artifactDir
 * @param {string} reason
 * @param {string} updatedAt
 * @returns {"retired"|"not-bound"|"changed"}
 */
function retireOwnCurrentPointer(flowAgentsDir, actorKey, artifactDir, bindingId, reason, updatedAt, validate) {
  return withPointerLock(flowAgentsDir, actorKey, () => {
    if (typeof validate === 'function') validate();
    const own = readOwnCurrentPointer(flowAgentsDir, actorKey);
    if (!own.file || !own.payload || own.payload.artifact_dir !== artifactDir) return 'not-bound';
    if (own.payload.binding_id !== bindingId) return 'changed';
    const raw = assertRegularPointerOrMissing(own.file);
    if (raw === null) return 'changed';
    const payload = JSON.parse(raw);
    if (!payload || payload.artifact_dir !== artifactDir || payload.binding_id !== bindingId) return 'changed';
    const retiredPayload = {
      ...payload,
      updated_at: updatedAt,
      binding_status: 'retired',
      binding_reason: reason,
    };
    const writtenRaw = `${JSON.stringify(retiredPayload, null, 2)}\n`;
    atomicWriteRaw(own.file, writtenRaw);
    try {
      if (typeof validate === 'function') validate();
    } catch (error) {
      rollbackValidatedPointer(own.file, raw, writtenRaw, error);
    }
    return 'retired';
  });
}

/**
 * Compare-and-replace an exact actor pointer under the same lock used by binds
 * and retirement. This supports projection transactions that discover pointer
 * files by directory scan and therefore do not possess the original actor key.
 *
 * @param {string} flowAgentsDir
 * @param {string} file
 * @param {string} expectedRaw
 * @param {object} payload
 * @returns {"updated"|"changed"}
 */
function replacePerActorCurrentIfUnchanged(flowAgentsDir, file, expectedRaw, payload) {
  const actorRoot = ensureSafeCurrentDirectory(flowAgentsDir);
  const resolvedFile = path.resolve(file);
  if (path.dirname(resolvedFile) !== actorRoot || !path.basename(resolvedFile).endsWith('.json')) {
    throw new Error(`actor-scoped current pointer must be a JSON file directly inside ${actorRoot}`);
  }
  return withPointerFileLock(actorMutationLockFile(flowAgentsDir), () => {
    if (ensureSafeCurrentDirectory(flowAgentsDir) !== actorRoot) {
      throw new Error(`actor current-pointer directory changed while locked: ${actorRoot}`);
    }
    if (assertRegularPointerOrMissing(resolvedFile) !== expectedRaw) return 'changed';
    atomicWriteJson(resolvedFile, payload);
    return 'updated';
  });
}

function assertRegularPointerOrMissing(file) {
  const result = readRawPointerState(file);
  if (result.status === 'missing') return null;
  if (result.status === 'valid') return result.raw;
  throw result.error ?? new Error(`current pointer must be a stable regular file: ${file}`);
}

function applyRawPointerWrites(writes) {
  const committed = [];
  try {
    for (const write of writes) {
      atomicWriteRaw(write.file, write.nextRaw);
      committed.push(write);
    }
  } catch (error) {
    for (const write of committed.reverse()) {
      if (write.expectedRaw === null) {
        try { fs.unlinkSync(write.file); } catch (rollbackError) {
          if (!rollbackError || rollbackError.code !== 'ENOENT') throw rollbackError;
        }
      } else {
        atomicWriteRaw(write.file, write.expectedRaw);
      }
    }
    throw error;
  }
}

/**
 * Atomically publish the shared and actor-scoped views used at session start.
 * Both locks remain held through validation, commit, and any rollback.
 */
function publishCurrentPointers(flowAgentsDir, actorKey, payload) {
  const root = path.resolve(flowAgentsDir);
  fs.mkdirSync(root, { recursive: true });
  const globalFile = path.join(root, 'current.json');
  if (!actorKey || isUnresolvedActor(String(actorKey))) {
    return withPointerFileLock(globalFile, () => {
      const expectedRaw = assertRegularPointerOrMissing(globalFile);
      applyRawPointerWrites([{
        file: globalFile,
        expectedRaw,
        nextRaw: `${JSON.stringify(payload, null, 2)}\n`,
      }]);
    });
  }

  const actorRoot = ensureSafeCurrentDirectory(root);
  const actorFile = perActorCurrentFile(root, String(actorKey));
  if (path.dirname(path.resolve(actorFile)) !== actorRoot) {
    throw new Error(`actor-scoped current pointer must remain inside ${actorRoot}`);
  }
  return withPointerFileLocks([globalFile, actorMutationLockFile(root)], () => {
    if (ensureSafeCurrentDirectory(root) !== actorRoot) {
      throw new Error(`actor current-pointer directory changed while locked: ${actorRoot}`);
    }
    const globalRaw = assertRegularPointerOrMissing(globalFile);
    const actorRaw = assertRegularPointerOrMissing(actorFile);
    const nextRaw = `${JSON.stringify(payload, null, 2)}\n`;
    applyRawPointerWrites([
      { file: globalFile, expectedRaw: globalRaw, nextRaw },
      { file: actorFile, expectedRaw: actorRaw, nextRaw },
    ]);
  });
}

/**
 * Compare and replace all existing Builder pointer projections as one locked
 * transaction. No write occurs unless every expected snapshot still matches.
 */
function normalizePointerReplacements(root, replacements) {
  const actorRoot = path.join(root, 'current');
  return replacements.map((replacement) => {
    const file = path.resolve(replacement.file);
    const isGlobal = file === path.join(root, 'current.json');
    const isActor = path.dirname(file) === actorRoot && path.basename(file).endsWith('.json');
    if (!isGlobal && !isActor) {
      throw new Error(`current pointer replacement is outside the artifact root: ${file}`);
    }
    return {
      file,
      expectedRaw: replacement.expectedRaw,
      nextRaw: `${JSON.stringify(replacement.payload, null, 2)}\n`,
      isActor,
    };
  });
}

function actorEntriesUnderLock(root) {
  const actorRoot = path.join(root, 'current');
  if (safeCurrentDirectoryForRead(root) !== actorRoot) return null;
  return fs.readdirSync(actorRoot)
    .filter((entry) => entry !== '.actor-pointers.lockdir')
    .sort();
}

function actorDirectorySnapshotMatches(root, expectedEntries) {
  const currentEntries = actorEntriesUnderLock(root);
  if (expectedEntries === null) {
    if (currentEntries === null) {
      throw new Error(`actor current-pointer directory changed while locked: ${path.join(root, 'current')}`);
    }
    return currentEntries.length === 0;
  }
  if (currentEntries === null) {
    throw new Error(`actor current-pointer directory changed while locked: ${path.join(root, 'current')}`);
  }
  return JSON.stringify(currentEntries) === JSON.stringify(expectedEntries);
}

function pointerSnapshotsMatch(root, normalized, options) {
  if (Object.hasOwn(options, 'expectedGlobalRaw')
    && assertRegularPointerOrMissing(path.join(root, 'current.json')) !== options.expectedGlobalRaw) {
    return false;
  }
  if (Object.hasOwn(options, 'expectedActorEntries')
    && !actorDirectorySnapshotMatches(root, options.expectedActorEntries)) {
    return false;
  }
  if (!Object.hasOwn(options, 'expectedActorEntries')
    && normalized.some((replacement) => replacement.isActor)
    && safeCurrentDirectoryForRead(root) !== path.join(root, 'current')) {
    throw new Error(`actor current-pointer directory changed while locked: ${path.join(root, 'current')}`);
  }
  return normalized.every(
    (replacement) => assertRegularPointerOrMissing(replacement.file) === replacement.expectedRaw,
  );
}

function pointerTransactionLockFiles(root, normalized, options) {
  const validatesActorDirectory = Object.hasOwn(options, 'expectedActorEntries');
  const validatesGlobalPointer = Object.hasOwn(options, 'expectedGlobalRaw');
  return [
    ...(normalized.some((replacement) => !replacement.isActor) || validatesGlobalPointer
      ? [path.join(root, 'current.json')]
      : []),
    ...(normalized.some((replacement) => replacement.isActor) || validatesActorDirectory
      ? [actorMutationLockFile(root)]
      : []),
  ];
}

function replaceCurrentPointersIfUnchanged(
  flowAgentsDir,
  replacements,
  options = {},
  commit,
) {
  if (typeof options === 'function') {
    commit = options;
    options = {};
  }
  const root = path.resolve(flowAgentsDir);
  const normalized = normalizePointerReplacements(root, replacements);
  const validatesActorDirectory = Object.hasOwn(options, 'expectedActorEntries');
  if (normalized.some((replacement) => replacement.isActor)
    || (validatesActorDirectory && options.expectedActorEntries !== null)) {
    ensureSafeCurrentDirectory(root);
  }
  return withPointerFileLocks(pointerTransactionLockFiles(root, normalized, options), () => {
    if (!pointerSnapshotsMatch(root, normalized, options)) return 'changed';
    if (typeof commit === 'function') commit();
    applyRawPointerWrites(normalized);
    return 'updated';
  });
}

/**
 * Apply a binding-preserving update to the shared and actor-scoped projections.
 * Reads happen only after both mutation locks are held, and a concurrent rebind
 * therefore wins without being overwritten by stale agent metadata.
 */
function updateCurrentPointersForBinding(flowAgentsDir, actorKey, artifactDir, update, stage) {
  const root = path.resolve(flowAgentsDir);
  const globalFile = path.join(root, 'current.json');
  const resolvedActor = actorKey && !isUnresolvedActor(String(actorKey))
    ? String(actorKey)
    : null;
  const lockFiles = [globalFile];
  if (resolvedActor) {
    ensureSafeCurrentDirectory(root);
    lockFiles.push(actorMutationLockFile(root));
  }
  return withPointerFileLocks(lockFiles, () => {
    const writes = [];
    const globalRaw = assertRegularPointerOrMissing(globalFile);
    if (globalRaw !== null) {
      const globalPayload = JSON.parse(globalRaw);
      if (globalPayload?.artifact_dir === artifactDir) {
        writes.push({
          file: globalFile,
          expectedRaw: globalRaw,
          nextRaw: `${JSON.stringify(update(globalPayload), null, 2)}\n`,
        });
      }
    }
    if (resolvedActor) {
      const own = readOwnCurrentPointer(root, resolvedActor);
      if (own.payload?.artifact_dir === artifactDir) {
        const canonicalFile = perActorCurrentFile(root, resolvedActor);
        writes.push({
          file: canonicalFile,
          expectedRaw: assertRegularPointerOrMissing(canonicalFile),
          nextRaw: `${JSON.stringify(update(own.payload), null, 2)}\n`,
        });
      }
    }
    const staged = typeof stage === 'function' ? stage() : null;
    try {
      applyRawPointerWrites(writes);
    } catch (error) {
      staged?.rollback?.();
      throw error;
    }
    return writes.length;
  });
}

module.exports = {
  perActorCurrentFile,
  legacyPerActorCurrentFile,
  readCurrentPointer,
  readOwnCurrentPointer,
  writePerActorCurrent,
  retireOwnCurrentPointer,
  replacePerActorCurrentIfUnchanged,
  publishCurrentPointers,
  replaceCurrentPointersIfUnchanged,
  updateCurrentPointersForBinding,
};
