'use strict';
/**
 * liveness-heartbeat.js — shared pure-CJS tool-activity liveness heartbeat
 *
 * Zero external dependencies (only Node core: fs, path). Consumed by:
 *   - scripts/hooks/{claude,codex,opencode,pi}-telemetry-hook.js  (CJS, direct require)
 *
 * Purpose (issue #288): ride the one hook event every supported runtime
 * already fires per tool call (postToolUse) to keep a liveness claim fresh
 * via ordinary tool activity, not just workflow phase transitions. Throttled
 * to >=`resolveHeartbeatThrottleSeconds(env)` (default 60s) per subject+actor,
 * derived from the existing actor-keyed `liveness/events.jsonl` stream tail —
 * deliberately NOT a new mutable throttle-state file, since a shared
 * last-heartbeat-timestamp file keyed by anything less specific than the
 * actor would reintroduce the last-writer-wins race ADR 0021 exists to close
 * (see plan artifact for kontourai-flow-agents-288). Each actor only ever
 * contends with its own prior writes, so deriving the throttle straight from
 * the actor-scoped stream has no shared-write race.
 *
 * Hot-path ordering + bounded read (F3, #288 fix iteration 1, sec-MED +
 * cr-MED; restored by F4, fix-plan iteration 1): steps run enabled? ->
 * mightHaveActiveSession() peek -> resolveActor() -> current.json
 * active_slug present? -> bounded tail read, in that order, so a repo with
 * liveness disabled OR no active session never pays the `resolveActor()`
 * process-ancestry `ps` spawn cost. (#291 initially moved resolveActor()
 * ahead of the active_slug check unconditionally, since the current-pointer
 * read became actor-aware and needs the resolved actor to choose per-actor
 * vs. legacy `current.json` — this silently dropped the "no active session"
 * half of the short-circuit for every liveness-enabled call, not just the
 * "disabled" half. F4 restores it: `mightHaveActiveSession()` is a plain,
 * actor-free `fs.existsSync` peek of the legacy `current.json` file and the
 * `current/` per-actor directory — when NEITHER exists, no actor could
 * possibly have an active session (per-actor files only ever live under
 * `current/`), so resolveActor() is skipped entirely, exactly restoring the
 * pre-#291 short-circuit for the common "enabled, no session yet" case. Only
 * once a current-pointer file might exist does resolveActor() run, still
 * exactly once, reused for both the actor-scoped current-pointer read and the
 * actor-unresolved gate below.)
 *
 * Orphan-heartbeat invariant (F8(ii), #288 fix iteration 2): a heartbeat must
 * never be treated as its own evidence of a claim. The reviewer-reproduced
 * defect was that a bare heartbeat sitting in the bounded tail (with no claim
 * event anywhere nearby) was accepted as sufficient "claim evidence" to keep
 * emitting further heartbeats — perpetuating a phantom holder that was never
 * legitimately claimed. The fix splits the two decisions this module makes:
 *
 *   1. THROTTLE decision — stays bounded-tail only (cheap, unchanged). The
 *      tail is a suffix of an append-only stream, so when it contains ANY
 *      event for the (subjectId, actor) pair, that event is necessarily the
 *      pair's true most-recent entry (nothing for this pair could exist
 *      later in the file without also being in the tail). A release found
 *      there refuses immediately; a fresh (within-throttle) event there
 *      throttles immediately. Neither outcome ever pays for a full read.
 *
 *   2. EMIT decision — requires actual claim evidence (an event whose
 *      `type === 'claim'`) for the pair, not merely "some matching event
 *      exists". That evidence is read from the tail when the tail already
 *      contains a `claim` event for the pair (zero extra I/O); otherwise
 *      exactly ONE full read runs to confirm one way or the other (paid at
 *      most once per throttle window per session, never on throttled
 *      checks). No claim found anywhere -> skip with reason 'no-claim'. This
 *      also neutralizes pre-existing orphan heartbeats already sitting in
 *      old streams (a stream containing only heartbeats for a pair, with no
 *      claim ever recorded, now always resolves to 'no-claim').
 *
 * Fails open: never throws, never blocks the calling hook, stderr diagnostic
 * on error only (mirrors the #287 fail-open convention already used by
 * actor-identity.js / liveness-read.js consumers).
 *
 * Exports:
 *   maybeEmitHeartbeat({ cwd, env, now }) → { emitted: boolean, reason?: string,
 *     conflict?: { actor: string, lastAt: string, ttlSeconds: number } }
 *
 * Mid-turn conflict detection (issue #320, AC3/AC5): every call already reads a bounded
 * tail of the liveness stream to throttle/emit our OWN heartbeat. That same in-memory tail
 * (or, on the rare full-read fallback path, that full read) is additionally passed through
 * `freshHolders()` (./liveness-read) to detect another actor's fresh claim on OUR OWN held
 * subject — zero added I/O. The optional `conflict` field is attached whenever we've
 * confirmed we hold a live claim on the subject (regardless of whether our own heartbeat
 * emits or throttles this call) and some other actor's most recent event for the subject is
 * strictly newer than OUR OWN last recorded event for it prior to this call — a
 * stream-derived episode watermark, not a wall-clock timer, so a still-fresh conflicting
 * claim already seen on a prior call never re-fires; only a genuinely newer event from the
 * conflicting actor does (our own heartbeat write, once appended, becomes the new watermark
 * for the next call). Never treated as evidence for OUR OWN claim/throttle decisions above —
 * this only ADDS a field, it never changes the existing `emitted`/`reason` semantics.
 */

const fs = require('fs');
const path = require('path');
const { isLivenessEnabled, resolveHeartbeatThrottleSeconds } = require('./liveness-policy');
const { livenessStreamFile, appendLivenessEvent } = require('./liveness-write');
const { readLivenessEvents, readLivenessEventsTail, freshHolders } = require('./liveness-read');
const { resolveActor, isUnresolvedActor, sanitizeSegment } = require('./actor-identity');
const { flowAgentsArtifactRoot } = require('./local-artifact-paths');
const { readOwnCurrentPointer } = require('./current-pointer');

/**
 * Resolve a caller-supplied `now` (Date, ISO string, or omitted) to epoch ms.
 * Falls back to `Date.now()` for anything that does not parse cleanly.
 *
 * @param {Date|string|undefined} now
 * @returns {number}
 */
function resolveNowMs(now) {
  if (now instanceof Date) {
    const ms = now.getTime();
    return Number.isFinite(ms) ? ms : Date.now();
  }
  if (typeof now === 'string' && now.trim()) {
    const ms = Date.parse(now);
    return Number.isFinite(ms) ? ms : Date.now();
  }
  return Date.now();
}

/**
 * Read the active_slug from the actor-scoped "current" pointer, via `readOwnCurrentPointer` — the
 * single choke point for that preference rule. #440: for a RESOLVED actorKey this reads ONLY
 * that actor's own per-actor `current/<actor>.json` projection — it never falls back to the
 * shared legacy global `current.json`, so a session co-located with another actor's work never
 * emits a heartbeat naming that other actor's subject (D1). When `actorKey` is empty/unresolved,
 * `readOwnCurrentPointer` delegates unchanged to `readCurrentPointer`, which DOES fall straight
 * to the legacy global file — behavior for that case is unchanged from before #291/#440 (D3
 * compat). The returned `active_slug` is sanitized through the same charset+cap restriction as
 * actor-identity.js's `sanitizeSegment` (F5, #288 fix iteration 1, sec-LOW: this is a local file
 * that could be hand-edited or otherwise hostile — `active_slug` must never be trusted verbatim
 * before it is used as a JSONL grouping key / emitted `subjectId` or compared against event
 * data). Tolerates a missing file or malformed JSON (returns "") exactly like the plain-
 * `fs.readFileSync` read this replaces.
 *
 * @param {string} root
 * @param {string} [actorKey]
 * @returns {string}
 */
/**
 * F4 fix (fix-plan iteration 1, MED): a cheap, actor-free existence peek restoring the module's
 * documented "no active session never pays resolveActor()" invariant. `readCurrentPointer`'s
 * actor-aware preference genuinely needs a resolved actor to choose per-actor vs. legacy — but
 * that choice is only ever relevant when SOME current-pointer file might exist at all. When
 * neither the legacy global `<root>/current.json` file NOR the `<root>/current/` per-actor
 * directory exists, there is provably no active session for any actor (per-actor files are only
 * ever written into that directory — see current-pointer.js's writePerActorCurrent), so this
 * function returns false without calling resolveActor() at all, exactly restoring the pre-#291
 * short-circuit for the common "liveness enabled, no session yet" case. Two plain fs.existsSync
 * calls — no ps/proc ancestry cost, no JSON parse.
 *
 * @param {string} root
 * @returns {boolean}
 */
function mightHaveActiveSession(root) {
  return fs.existsSync(path.join(root, 'current.json')) || fs.existsSync(path.join(root, 'current'));
}

function readActiveSlug(root, actorKey) {
  const { payload: current } = readOwnCurrentPointer(root, actorKey);
  if (!current) return '';
  const activeSlug = (current && current.active_slug) || '';
  if (!activeSlug) return '';
  // sanitizeSegment falls back to the literal "unknown" for an all-stripped input; that
  // fallback is not a legitimate slug, so treat it as "no active slug" here rather than
  // matching against a subject that was never really claimed.
  const sanitized = sanitizeSegment(activeSlug);
  return sanitized === 'unknown' ? '' : sanitized;
}

/**
 * Sanitize an optional caller-supplied `activity` descriptor into a clean, bounded shape suitable
 * for embedding in the emitted heartbeat event (issue: richer "real liveness" signals). The point
 * is to make each pulse say WHAT the agent is doing right now — the tool it just ran — not merely
 * that it is alive. Every field flows both into the local append-only JSONL and (via relay.sh) into
 * the hosted Console record, so each value is passed through the same allowlist+64-cap
 * `sanitizeSegment` the write side already applies to actors/slugs: a hostile or oversized tool
 * name (a custom MCP tool string, a hand-edited hook payload) can never inject control bytes or
 * unbounded text downstream. Returns `undefined` when there is no usable activity, so the caller
 * omits the field entirely rather than emitting `activity: {}` noise.
 *
 * @param {{tool?: string}|undefined} activity
 * @returns {{tool: string}|undefined}
 */
function sanitizeActivity(activity) {
  if (!activity || typeof activity !== 'object') return undefined;
  const out = {};
  if (activity.tool != null && String(activity.tool).trim()) {
    const tool = sanitizeSegment(activity.tool);
    if (tool && tool !== 'unknown') out.tool = tool;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Filter a list of parsed liveness events down to the ones matching a given
 * (subjectId, actor) pair. Shared by the bounded tail read and the full-read
 * fallback so both filter identically.
 *
 * @param {object[]} events
 * @param {string} slug
 * @param {string} actor
 * @returns {object[]}
 */
function filterMatchingPair(events, slug, actor) {
  return events.filter(
    (e) => e && typeof e === 'object' && e.subjectId === slug && e.actor === actor
  );
}

/**
 * Detect another actor's fresher claim on the SAME subject as our own, using an
 * already-loaded events array — the bounded tail in the common case, or the full-read
 * fallback array in the rare case the EMIT decision already paid for one — never an
 * additional `fs` call (issue #320, AC3). Reuses the canonical `freshHolders()` grouping/
 * freshness rules from `./liveness-read` (the same helper `workflow-steering.js`'s ambient
 * per-turn digest already relies on) instead of re-deriving freshness logic here.
 *
 * Episode-throttled per AC5: a holder is only reported when its `lastAt` is strictly newer
 * than `ourLastAt` (our own last recorded event for this subject, captured BEFORE this call
 * potentially appends its own heartbeat) — an unchanged, still-fresh conflicting claim already
 * surfaced on a prior call never re-fires; only a genuinely new event from the conflicting
 * actor does. This is a stream-derived watermark comparison, never a wall-clock timer. When
 * more than one other actor qualifies, the single most-recently-updated one is reported.
 *
 * Known, disclosed limitation (mirrors this module's own orphan-heartbeat caveat above): if
 * the conflicting actor's own `claim` event (carrying `ttlSeconds`) has scrolled outside the
 * 64KB tail window, `freshHolders` defaults that holder's `ttlSeconds` to 1800s using only the
 * heartbeat events visible in the tail — the same accepted-and-disclosed class of limitation
 * the module header already names for the caller's OWN pair.
 *
 * @param {object[]} events
 * @param {string} slug
 * @param {string} actor
 * @param {number} nowMs
 * @param {string} ourLastAt
 * @returns {{actor: string, lastAt: string, ttlSeconds: number}|undefined}
 */
function computeConflict(events, slug, actor, nowMs, ourLastAt) {
  const ourLastAtMs = Date.parse(ourLastAt);
  const others = freshHolders(events, slug, actor, nowMs).filter((h) => {
    const holderAtMs = Date.parse(h.lastAt);
    return Number.isFinite(holderAtMs) && Number.isFinite(ourLastAtMs) && holderAtMs > ourLastAtMs;
  });
  if (!others.length) return undefined;
  const winner = others.reduce((a, b) => (Date.parse(b.lastAt) > Date.parse(a.lastAt) ? b : a));
  // Sanitize at this single choke point (issue #320 fix iteration 1, sec-CRITICAL/HIGH F1/F2):
  // `winner.actor`/`winner.lastAt` are read straight off the multi-writer append-only
  // liveness/events.jsonl stream, which ANY process can append to (a second agent's shell, a
  // hand-edit) bypassing the CLI write-side `sanitizeSegment` entirely. These values flow
  // UNSANITIZED into agent-facing channels (hookSpecificOutput.additionalContext / stderr) in
  // all four wrapper hooks below — the exact #287 injection class in a new, more directly
  // agent-facing channel. Sanitizing once here, at the sole place `conflict` is constructed,
  // means every caller (all four wrappers) inherits clean values with no per-wrapper defense
  // to forget. `actor` reuses the same allowlist+64-char-cap `sanitizeSegment` the write side
  // already applies to legitimate actors (a no-op on them); `lastAt` is structurally
  // eliminated by re-serializing through Date.parse/toISOString — a timestamp can never carry
  // control chars once canonicalized this way. `ttlSeconds` is already a Number — left as-is.
  const winnerLastAtMs = Date.parse(winner.lastAt);
  const sanitizedLastAt = Number.isFinite(winnerLastAtMs) ? new Date(winnerLastAtMs).toISOString() : '';
  return { actor: sanitizeSegment(winner.actor), lastAt: sanitizedLastAt, ttlSeconds: winner.ttlSeconds };
}

/**
 * Attach an optional `conflict` field to a result object, omitting the key entirely when no
 * conflict was detected (rather than an explicit `conflict: undefined`), so callers can rely
 * on a plain `if (result.conflict)` check.
 *
 * @param {object} result
 * @param {{actor: string, lastAt: string, ttlSeconds: number}|undefined} conflict
 * @returns {object}
 */
function attachConflictField(result, conflict) {
  return conflict ? { ...result, conflict } : result;
}

/**
 * Emit a throttled tool-activity liveness heartbeat for the resolved
 * actor/subject, if (and only if) a fresh, unreleased claim already exists.
 * Never creates a new claim. Fails open — always resolves to a result
 * object, never throws.
 *
 * See the module header for the full F8(ii) throttle/emit split. Summary:
 *   - enabled? -> mightHaveActiveSession() peek -> resolveActor() -> slug
 *     present? -> bounded tail read, in that order (F3, restored by F4), so
 *     a disabled repo or one with no active session never pays the
 *     resolveActor() ancestry `ps` spawn cost.
 *   - THROTTLE decision reads only the bounded tail (never a full read):
 *     a release found there refuses; a fresh event there throttles.
 *   - EMIT decision requires an actual `claim` event for the pair: taken
 *     from the tail when already present there, otherwise exactly one full
 *     read confirms (or refutes) it. No claim anywhere -> 'no-claim'.
 *   - CONFLICT check (issue #320, AC3/AC5) reuses whichever events array (tail, or the rare
 *     full-read fallback) already confirmed OUR OWN live claim — zero added I/O — and passes
 *     it through `freshHolders()` to find another actor's claim on the SAME subject. Only
 *     surfaced when that other actor's most recent event is strictly newer than our own last
 *     recorded event for the subject prior to this call (a stream-derived watermark, not a
 *     wall-clock timer), so it fires once per genuinely new conflicting event, independent of
 *     whether our own heartbeat emits or throttles this call.
 *
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, now?: Date|string, activity?: {tool?: string}}} [opts]
 *   `activity` is an optional descriptor of what the agent is doing right now (e.g. the tool this
 *   postToolUse pulse rode in on); when present + usable it is sanitized and embedded in the emitted
 *   heartbeat so the fleet view shows WHAT, not just aliveness. Purely additive — never affects the
 *   throttle/emit/conflict decisions.
 * @returns {{emitted: boolean, reason?: string, conflict?: {actor: string, lastAt: string, ttlSeconds: number}}}
 */
function maybeEmitHeartbeat(opts = {}) {
  const { cwd = process.cwd(), env = process.env } = opts || {};
  try {
    if (!isLivenessEnabled(env)) {
      return { emitted: false, reason: 'disabled' };
    }

    const root = flowAgentsArtifactRoot(cwd);
    // F4 fix (fix-plan iteration 1, MED): restore the "no active session never pays
    // resolveActor()" invariant. mightHaveActiveSession() is a plain fs.existsSync peek of the
    // LEGACY current.json / current/ dir — no actor needed — so a repo with liveness enabled but
    // no session at all (the common case this invariant exists for) short-circuits here, exactly
    // like pre-#291. Only once a current-pointer file MIGHT exist do we pay for resolveActor(),
    // needed to decide per-actor vs. legacy preference via readActiveSlug/readCurrentPointer.
    if (!mightHaveActiveSession(root)) {
      return { emitted: false, reason: 'no-current' };
    }

    const { actor } = resolveActor(env);
    const slug = readActiveSlug(root, actor);
    if (!slug) {
      return { emitted: false, reason: 'no-current' };
    }

    if (isUnresolvedActor(actor)) {
      return { emitted: false, reason: 'actor-unresolved' };
    }

    const streamPath = livenessStreamFile(root);
    const nowMs = resolveNowMs(opts.now);
    const throttleMs = resolveHeartbeatThrottleSeconds(env) * 1000;

    // ─── 1. THROTTLE decision — bounded tail only, never a full read (F8(ii)) ──
    // Capture the unfiltered tail buffer once (issue #320, AC3) so the CONFLICT check below
    // can reuse the exact same in-memory array on every return path — zero additional `fs`
    // calls beyond what the throttle/emit decisions already pay for.
    const tailEvents = readLivenessEventsTail(streamPath);
    let matching = filterMatchingPair(tailEvents, slug, actor);
    let last = matching.length ? matching[matching.length - 1] : null;
    if (last) {
      if (last.type === 'release') {
        return { emitted: false, reason: 'released' };
      }
      const lastAtMs = Date.parse(last.at);
      if (Number.isFinite(lastAtMs) && nowMs - lastAtMs < throttleMs) {
        // CONFLICT check (issue #320, AC3/AC5): only attached here when the tail ALREADY
        // shows a genuine `claim` for our own pair — zero extra I/O, never a full read on
        // this hot, most-common return path (preserving the "neither outcome ever pays for a
        // full read" invariant documented above). When our own claim history has scrolled
        // outside the tail window, this rare edge case simply omits the conflict field on
        // THIS call rather than paying for a read; a subsequent call (once genuinely out of
        // our own throttle window, or once the EMIT decision's full-read fallback runs) will
        // confirm it as usual.
        const ourClaimVisibleInTail = matching.some((e) => e.type === 'claim');
        const conflict = ourClaimVisibleInTail
          ? computeConflict(tailEvents, slug, actor, nowMs, last.at)
          : undefined;
        return attachConflictField({ emitted: false, reason: 'throttled' }, conflict);
      }
    }

    // ─── 2. EMIT decision — requires actual claim evidence (F8(ii)) ───────────
    // A bare heartbeat (or a release we've already ruled out above) is never sufficient
    // evidence on its own that a claim was ever made — that assumption is exactly the
    // orphan-heartbeat defect this closes. Prefer evidence already visible in the tail
    // (zero extra I/O); only pay for one full read when the tail didn't already settle it
    // (either it had no matching events at all, or it had some but none was a claim).
    let hasClaim = matching.some((e) => e.type === 'claim');
    // `holderEvents` is whichever events array (tail, or the full read below) already
    // confirmed our own claim — reused by the CONFLICT check (issue #320, AC3) below with no
    // additional `fs` call of its own.
    let holderEvents = tailEvents;
    if (!hasClaim) {
      const fullEvents = readLivenessEvents(streamPath);
      holderEvents = fullEvents;
      matching = filterMatchingPair(fullEvents, slug, actor);
      last = matching.length ? matching[matching.length - 1] : null;
      if (!last) {
        return { emitted: false, reason: 'no-claim' };
      }
      if (last.type === 'release') {
        return { emitted: false, reason: 'released' };
      }
      hasClaim = matching.some((e) => e.type === 'claim');
      if (!hasClaim) {
        return { emitted: false, reason: 'no-claim' };
      }
      // The tail was entirely empty for this pair (the only case reachable here with the
      // throttle decision above never having run against `last`) — re-check the throttle
      // window now that the full read has supplied the true last event.
      const lastAtMs = Date.parse(last.at);
      if (Number.isFinite(lastAtMs) && nowMs - lastAtMs < throttleMs) {
        return attachConflictField(
          { emitted: false, reason: 'throttled' },
          computeConflict(holderEvents, slug, actor, nowMs, last.at)
        );
      }
    }

    // ─── 3. CONFLICT check — same in-memory buffer as above, zero added I/O (issue #320,
    // AC3/AC5) ──────────────────────────────────────────────────────────────────────────
    // Reached only once `hasClaim` is confirmed true (a live, unreleased claim on `slug`) and
    // we are about to emit our own heartbeat. `last.at` here is OUR OWN last recorded event
    // for this subject BEFORE this call's write below — the watermark AC5's stream-derived
    // episode throttle compares against, so an unchanged, still-fresh conflicting claim seen
    // on a prior call never re-fires; only a genuinely newer event from the conflicting actor
    // does, because our own heartbeat write below becomes the new watermark for the next call.
    const conflict = computeConflict(holderEvents, slug, actor, nowMs, last.at);

    const nowIso = new Date(nowMs).toISOString();
    const activity = sanitizeActivity(opts.activity);
    appendLivenessEvent(root, {
      type: 'heartbeat',
      subjectId: slug,
      actor,
      at: nowIso,
      source: 'tool-activity',
      // Richer "real liveness": name the tool this pulse rode in on, so the fleet view shows WHAT
      // each agent is doing, not just that it is alive. Omitted entirely when no usable activity.
      ...(activity ? { activity } : {}),
    });
    return attachConflictField({ emitted: true }, conflict);
  } catch (err) {
    try {
      process.stderr.write(`[liveness-heartbeat] skipped: ${err.message}\n`);
    } catch {
      /* best-effort diagnostic only */
    }
    return { emitted: false, reason: 'error' };
  }
}

module.exports = { maybeEmitHeartbeat };
