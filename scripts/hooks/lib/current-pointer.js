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
 *   hasOtherActorPointer(flowAgentsDir, actorKey)     → boolean (#345, added 2026-07-05 field
 *                                                        evidence read — see below; hardened
 *                                                        against decoy files, iteration 2)
 *   ownedSessionArtifactDirs(flowAgentsDir, actorKey)  → string[] (iteration-2 CRITICAL fix +
 *                                                        iteration-3 correctness HIGH fix: the
 *                                                        tier-2 ownership scan — see below)
 */

const fs = require('fs');
const path = require('path');
const { sanitizeSegment, isUnresolvedActor } = require('./actor-identity.js');

/**
 * Terminal `state.json` statuses — a session in one of these is genuinely FINISHED, not merely
 * "assignment claim released". Mirrors `src/cli/workflow-sidecar.ts`'s exported `LIVENESS_TERMINAL`
 * Set (`delivered`/`accepted`/`archived`) EXACTLY. Duplicated as a literal here (not `require`d
 * from the built workflow-sidecar module) because of the require DIRECTION: per this file's own
 * header comment, `build/src/cli/workflow-sidecar.js` (the compiled ESM output) itself `require`s
 * THIS file via `createRequire` — requiring it back here would be circular. If
 * `LIVENESS_TERMINAL` ever changes in `src/cli/workflow-sidecar.ts`, this literal must be updated
 * to match (the same duplication-with-a-cross-reference-comment convention `stop-goal-fit.js`
 * already uses for its own `SIDECAR_NAMES` constant). Used by `ownedSessionArtifactDirs` below
 * (iteration-3 fix) as the durable "is this owned session actually done" signal, replacing a
 * dependence on the assignment record's routinely-released `status` field.
 */
const OWNERSHIP_LIVENESS_TERMINAL = new Set(['delivered', 'accepted', 'archived']);

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

/**
 * Minimally-scoped "is this a plausible current-pointer payload" shape check (iteration-2
 * CRITICAL fix, decoy hardening — security review + verifier both reproduced the pre-fix
 * bypass). `hasOtherActorPointer` below used to count ANY `.json`-named file under `current/`
 * whose basename was not this actor's own sanitized segment — including a zero-byte or
 * garbage `touch`ed decoy file that never parses as JSON, or a JSON file that parses but is not
 * remotely pointer-shaped (e.g. `{}` or `[1,2,3]`). An attacker could therefore either (a) rely
 * on the ABSENCE of any real other-actor file (the original #345 exploit) or (b) `touch` a decoy
 * `current/whatever.json` to manufacture a false "other actor" signal. Neither should count.
 *
 * A payload is "plausible pointer JSON" when it parses to a non-null object with a `slug`-or
 * `artifact`-shaped field — concretely, per `writePerActorCurrent`'s real payload shape
 * (`writeCurrent()` in `src/cli/workflow-sidecar.ts`), a non-empty string `active_slug` OR a
 * non-empty string `artifact_dir`. This is deliberately minimal (not a full schema check) — it
 * only needs to reject "not JSON" and "JSON but obviously not a pointer", not validate every
 * field a real pointer carries.
 *
 * @param {string} file
 * @returns {boolean}
 */
function isPlausiblePointerPayload(file) {
  const payload = readJsonFileTolerant(file);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const hasSlug = typeof payload.active_slug === 'string' && payload.active_slug.trim() !== '';
  const hasArtifactDir = typeof payload.artifact_dir === 'string' && payload.artifact_dir.trim() !== '';
  return hasSlug || hasArtifactDir;
}

/**
 * #345 (field evidence read 2026-07-05): narrowly-scoped signal for the stop-gate/steering
 * resolution rule — does at least one OTHER actor already have a per-actor `current/<actor>.json`
 * pointer under this artifact root? This is the missing piece `readCurrentPointer`'s own
 * deliberate compat-shim contract (doc comment above) does not model: that contract only asks
 * "does THIS actor have a per-actor file", so an actor with no per-actor file (e.g. one that never
 * ran `ensure-session`/`advance-state`) falls straight through to the legacy global `current.json`
 * — which is correct ONLY when this is truly a single-actor/legacy-only repo. When another actor
 * has already graduated to per-actor projection, the legacy global pointer is last-writer-wins and
 * not reliably THIS actor's own, so callers (`stop-goal-fit.js`'s `preferredArtifactDir`/
 * `staleCurrentSlug`, `workflow-steering.js`'s `actorScopedWorkflowState`) use this signal to stop
 * BEFORE falling back to legacy, instead of silently adopting a different session's pointer.
 *
 * Tolerant: a missing `current/` directory (single-actor/legacy-only repo, or a repo that has
 * never seen a per-actor write at all) returns `false`, never throws — this mirrors every other
 * best-effort read in this module. Reads the directory once (no recursion, no stat per entry
 * beyond `readdirSync` itself) and compares each `.json` basename (minus the extension) against
 * `sanitizeSegment(actorKey)` — the exact same sanitized form `perActorCurrentFile` uses to name
 * this actor's own file, so a basename equal to it is excluded (it is THIS actor's own pointer,
 * not an "other" one) and every other `.json` basename counts as an other-actor pointer.
 *
 * Iteration-2 decoy hardening: a candidate entry counts as an "other actor pointer" only when it
 * ALSO passes `isPlausiblePointerPayload` (above) — a zero-byte/garbage/non-pointer-shaped decoy
 * file no longer manufactures a false other-actor signal. This is belt-and-suspenders alongside
 * the ownership-scan redesign (`ownedSessionArtifactDirs` below), which is the primary fix for the
 * tier-2 gate-bypass exploit (deleting one's own pointer no longer silences the gate, regardless
 * of what this function returns).
 *
 * @param {string} flowAgentsDir
 * @param {string} actorKey
 * @returns {boolean}
 */
function hasOtherActorPointer(flowAgentsDir, actorKey) {
  const ownSegment = sanitizeSegment(actorKey);
  const currentDir = path.join(flowAgentsDir, 'current');
  let entries;
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((entry) => {
    if (!entry.isFile() || !entry.name.endsWith('.json')) return false;
    const basename = entry.name.slice(0, -'.json'.length);
    if (basename === '' || basename === ownSegment) return false;
    return isPlausiblePointerPayload(path.join(currentDir, entry.name));
  });
}

/**
 * Iteration-2 CRITICAL fix, iteration-3 correctness HIGH fix — the tier-2 ownership scan.
 *
 * Security review + verifier both reproduced an end-to-end gate bypass: an actor with an ACTIVE
 * gated session runs one un-guarded Bash command (`rm .kontourai/flow-agents/current/<actor
 * segment>.json`) to delete its OWN per-actor pointer file, then its next Stop hits tier 2
 * (no own pointer) and — pre-fix — either fell through to a different actor's legacy pointer (the
 * original #345 bug) or, post-#345-fix, was scoped to NOTHING (`searchDirs = []`) whenever any
 * other actor's pointer existed, silencing the gate entirely for the exploiting session. The
 * pointer file is an INDEX into "what is this actor working on", not the AUTHORITY on which
 * sessions this actor owns — deleting the index must not erase the underlying ownership record.
 *
 * The authoritative, durable owner stamp for a session is NOT the per-actor current pointer — it
 * is the local-file assignment-provider claim record (#290/#291/#294), `assignment/<slug>.json`
 * under this same `flowAgentsDir`, whose `actor_key` field is written by
 * `enforceEnsureSessionOwnership`'s `performLocalClaim`/`performLocalSupersede` calls
 * (`src/cli/workflow-sidecar.ts`) as `resolution.branchActorKey` — the SAME canonical
 * `resolveActor(env).actor` string `sanitizeSegment`/`perActorCurrentFile` use to name this
 * actor's own pointer file. That record lives independent of (and is never deleted by) a
 * `current/<actor>.json` pointer write or removal — an actor cannot erase its own ownership stamp
 * with a single un-guarded `rm` of the pointer file the way it could silence the OLD tier-2 logic.
 *
 * Iteration-3 correctness HIGH fix (three converged gates — security re-review, verifier, code
 * review): the iteration-2 version of this function ALSO required `record.status === "claimed"`
 * as part of the ownership test. That is wrong, and was itself a re-opened gate bypass — a subtler
 * one than the iteration-1/2 bugs, because it fires on an HONEST session with no exploit at all.
 * `scripts/hooks/stop-goal-fit.js`'s `releaseOnNonTerminalStop` (#292, pre-existing, unrelated to
 * this file) flips a session's OWN assignment record from `status: "claimed"` to
 * `status: "released"` on EVERY non-terminal Stop — that is an intentional release of the
 * assignment-LAYER claim (so a different actor could reclaim an abandoned session), not a durable
 * "this session is finished" signal and NOT an ownership transfer. So on an actor's SECOND tier-2
 * Stop (or any tier-2 stop after even one prior non-terminal stop — a completely ordinary
 * multi-turn session, no exploit needed), the `status === "claimed"` filter finds nothing and this
 * scan returns `[]`, silently un-gating an honest, still-active session — defeating this
 * function's entire purpose.
 *
 * The durable signal this function keys on instead:
 *   1. `record.actor_key` match, REGARDLESS of `status`. `actor_key` is written once at
 *      claim/supersede time and is NEVER changed by a release — `performLocalRelease`
 *      (`src/cli/assignment-provider.ts`) spreads `...existing` and only overwrites `status` (plus
 *      appending an audit-trail entry); it does not touch `actor_key`. The ONLY write path that
 *      changes `actor_key` on an existing record is `performLocalSupersede`, which rewrites it to
 *      the NEW owner's key — correctly making the OLD owner stop matching here, which is exactly
 *      right (a superseded session is no longer this actor's). So `actor_key` survives an ordinary
 *      release (the case this fix targets) while still correctly reflecting a real ownership
 *      transfer (supersede) — it is the more durable of the two record fields, unlike `status`.
 *   2. The session's OWN non-terminal task status, read from the artifact dir's OWN `state.json`
 *      — the file that ACTUALLY says whether the session is done, and one of the small set of
 *      sidecars `config-protection.js` already hard-protects from casual agent tampering (Write/
 *      Edit/redirect/interpreter-write/delete-rename-away), unlike the assignment record's
 *      `status` field pre-iteration-3. A `state.json` status in `OWNERSHIP_LIVENESS_TERMINAL`
 *      (mirrors `src/cli/workflow-sidecar.ts`'s exported `LIVENESS_TERMINAL` — delivered/accepted/
 *      archived) means the session is genuinely finished and is excluded; anything else (including
 *      "no state.json yet" — claimed but never advanced) is treated as still owned/active, since
 *      nothing durable says otherwise.
 * This is the more-durable-authority choice the fix-plan asked for: `state.json`'s own status is
 * ALREADY config-protected and is the one place that actually records "is this session done",
 * whereas the assignment record's `status` field is routinely, intentionally flipped by an
 * unrelated release mechanism and was never meant to answer "is the underlying session over".
 * `releaseOnNonTerminalStop`'s release behavior itself is NOT changed by this fix (the fix-plan's
 * investigation found no reason release-while-pending is unsafe) — only this scan's dependence on
 * the released field is removed.
 *
 * A malformed/corrupt individual assignment record is skipped (tolerant, matches every other
 * best-effort read in this module) rather than aborting the whole scan — one bad record must not
 * hide every other legitimately owned session. A missing `assignment/` directory (a repo that has
 * never used the local-file assignment provider) returns `[]`, never throws.
 *
 * Performance note: this scan runs ONLY in tier 2 (this actor has no own per-actor pointer) —
 * the rare path — and reads each candidate assignment record file (plus, now, its resolved
 * session dir's `state.json`) exactly once, so it stays cheap even with many historical assignment
 * records on disk.
 *
 * @param {string} flowAgentsDir
 * @param {string} actorKey
 * @returns {string[]} absolute paths of session artifact dirs owned by actorKey (actor_key match,
 *   own state.json not terminal) — independent of the assignment record's claimed/released status
 */
function ownedSessionArtifactDirs(flowAgentsDir, actorKey) {
  const ownSegment = sanitizeSegment(actorKey);
  const assignmentDir = path.join(flowAgentsDir, 'assignment');
  let entries;
  try {
    entries = fs.readdirSync(assignmentDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const record = readJsonFileTolerant(path.join(assignmentDir, entry.name));
    if (!record || typeof record !== 'object') continue;
    // Iteration-3 fix: NOT gated on record.status any more — see the doc comment above for why
    // the routinely-released assignment status field is not a durable "still owned" signal.
    const recordActorKey = typeof record.actor_key === 'string' ? record.actor_key : '';
    if (!recordActorKey || sanitizeSegment(recordActorKey) !== ownSegment) continue;
    const artifactDir = record.artifact_dir;
    if (typeof artifactDir !== 'string' || !artifactDir.trim()) continue;
    const safe = artifactDir.replace(/\.\.+/g, '').replace(/^[/\\]+/, '');
    const dir = path.join(flowAgentsDir, safe);
    if (!dir.startsWith(flowAgentsDir + path.sep) && dir !== flowAgentsDir) continue;
    try {
      if (!fs.existsSync(dir)) continue;
    } catch {
      continue; // best-effort; skip an unreadable candidate rather than aborting the whole scan.
    }
    // Iteration-3 fix: the durable "is this session actually finished" signal is the session's
    // OWN state.json status, not the assignment record's status. Absent/corrupt state.json is
    // NOT treated as terminal (conservative: nothing durable says the session is done, so it
    // stays in-scope for the gate) — only an explicit terminal status excludes it.
    const state = readJsonFileTolerant(path.join(dir, 'state.json'));
    const ownStatus = state && typeof state.status === 'string' ? state.status.trim().toLowerCase() : '';
    if (ownStatus && OWNERSHIP_LIVENESS_TERMINAL.has(ownStatus)) continue;
    dirs.push(dir);
  }
  return dirs;
}

module.exports = {
  perActorCurrentFile,
  readCurrentPointer,
  writePerActorCurrent,
  hasOtherActorPointer,
  ownedSessionArtifactDirs,
};
