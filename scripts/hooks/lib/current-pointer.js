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
 * name, so live pointers self-migrate through ordinary use. Removal criterion: once every
 * actively-read `current/` directory in practice contains only new-name pointers — practically,
 * after one full session lifecycle past this fix's rollout, or at the next major version,
 * whichever is a more deliberate cutover point — `legacyPerActorCurrentFile` and its two
 * call sites below can be deleted outright.
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
function readJsonFileTolerant(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
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
 * apply to `current.json` today. This fallback must be EXACTLY equivalent to today's plain
 * `current.json` read for every caller that has no actorKey (or an unresolved one) — that is
 * what makes this a compat shim rather than a behavior change.
 *
 * @param {string} flowAgentsDir
 * @param {string} [actorKey]
 * @returns {{ payload: object|null, source: "per-actor"|"legacy"|"none", file: string|null }}
 */
function readCurrentPointer(flowAgentsDir, actorKey) {
  const key = actorKey == null ? '' : String(actorKey);
  if (key && !isUnresolvedActor(key)) {
    const perActorFile = perActorCurrentFile(flowAgentsDir, key);
    const perActorPayload = readJsonFileTolerant(perActorFile);
    if (perActorPayload !== null) return { payload: perActorPayload, source: 'per-actor', file: perActorFile };
    // #440 fix-wave 2: the new collision-resistant file doesn't exist/parse — fall back to the
    // pre-fix-wave-2 legacy per-actor filename (transition window only; see module header).
    const legacyPerActorFile = legacyPerActorCurrentFile(flowAgentsDir, key);
    const legacyPerActorPayload = readJsonFileTolerant(legacyPerActorFile);
    if (legacyPerActorPayload !== null) return { payload: legacyPerActorPayload, source: 'per-actor', file: legacyPerActorFile };
  }

  const legacyFile = path.join(flowAgentsDir, 'current.json');
  const legacyPayload = readJsonFileTolerant(legacyFile);
  if (legacyPayload !== null) return { payload: legacyPayload, source: 'legacy', file: legacyFile };

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
  const perActorPayload = readJsonFileTolerant(perActorFile);
  if (perActorPayload !== null) return { payload: perActorPayload, source: 'per-actor', file: perActorFile };
  // #440 fix-wave 2: the new collision-resistant file doesn't exist/parse — fall back to the
  // pre-fix-wave-2 legacy per-actor filename (transition window only; see module header). This
  // is still THIS actor's own read (never the shared legacy current.json, never a global scan) —
  // D1 is unaffected, only the per-actor filename resolution gained a second name to try.
  const legacyPerActorFile = legacyPerActorCurrentFile(flowAgentsDir, key);
  const legacyPerActorPayload = readJsonFileTolerant(legacyPerActorFile);
  if (legacyPerActorPayload !== null) return { payload: legacyPerActorPayload, source: 'per-actor', file: legacyPerActorFile };
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
function writePerActorCurrent(flowAgentsDir, actorKey, payload) {
  const file = perActorCurrentFile(flowAgentsDir, actorKey);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
}

module.exports = { perActorCurrentFile, legacyPerActorCurrentFile, readCurrentPointer, readOwnCurrentPointer, writePerActorCurrent };
