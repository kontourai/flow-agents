'use strict';
/**
 * current-pointer.js — shared pure-CJS per-actor "current" pointer reader/writer (#291)
 *
 * Zero external dependencies (only Node core: fs, path). Consumed by:
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
 * `sanitizeSegment` is required from `./actor-identity.js` (already reviewed: restricts to
 * `[A-Za-z0-9_.-]`, caps 64 chars) — this file deliberately does NOT re-implement a second
 * sanitizer; it is the same charset restriction `assignment-provider.ts`'s `assignmentFilePath()`
 * already applies to its own per-subject filenames, so the naming convention is consistent across
 * both per-key-file stores in this repo (`assignment/<subject>.json` and now
 * `current/<actor>.json`).
 *
 * Exports:
 *   perActorCurrentFile(flowAgentsDir, actorKey)     → string (path, unsanitized existence not
 *                                                        implied — caller must still fs.existsSync)
 *   readCurrentPointer(flowAgentsDir, actorKey)       → { payload: object|null,
 *                                                        source: "per-actor"|"legacy"|"none",
 *                                                        file: string|null }
 *   writePerActorCurrent(flowAgentsDir, actorKey, payload) → void
 */

const fs = require('fs');
const path = require('path');
const { sanitizeSegment, isUnresolvedActor } = require('./actor-identity.js');

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
 * Path to the per-actor current pointer file for a given actor key, sanitized via the shared
 * `sanitizeSegment` (reused, not re-implemented) so the filename is path-traversal-safe exactly
 * like `assignment-provider.ts`'s `assignmentFilePath()`.
 *
 * @param {string} flowAgentsDir
 * @param {string} actorKey
 * @returns {string}
 */
function perActorCurrentFile(flowAgentsDir, actorKey) {
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
  }

  const legacyFile = path.join(flowAgentsDir, 'current.json');
  const legacyPayload = readJsonFileTolerant(legacyFile);
  if (legacyPayload !== null) return { payload: legacyPayload, source: 'legacy', file: legacyFile };

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

module.exports = { perActorCurrentFile, readCurrentPointer, writePerActorCurrent };
