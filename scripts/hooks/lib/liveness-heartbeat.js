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
 * cr-MED): steps run enabled? -> current.json active_slug present? ->
 * resolveActor() -> bounded tail read, in that order, so a repo with liveness
 * disabled or no active session never pays the `resolveActor()` process-
 * ancestry `ps` spawn cost.
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
 *   maybeEmitHeartbeat({ cwd, env, now }) → { emitted: boolean, reason?: string }
 */

const fs = require('fs');
const path = require('path');

const { isLivenessEnabled, resolveHeartbeatThrottleSeconds } = require('./liveness-policy');
const { livenessStreamFile, appendLivenessEvent } = require('./liveness-write');
const { readLivenessEvents, readLivenessEventsTail } = require('./liveness-read');
const { resolveActor, isUnresolvedActor, sanitizeSegment } = require('./actor-identity');
const { flowAgentsArtifactRoot } = require('./local-artifact-paths');

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
 * Read `current.json`'s `active_slug` from the given artifact root, sanitized through the same
 * charset+cap restriction as actor-identity.js's `sanitizeSegment` (F5, #288 fix iteration 1,
 * sec-LOW: `current.json` is a local file that could be hand-edited or otherwise hostile —
 * `active_slug` must never be trusted verbatim before it is used as a JSONL grouping key /
 * emitted `subjectId` or compared against event data). Tolerates a missing file or malformed
 * JSON (returns "").
 *
 * @param {string} root
 * @returns {string}
 */
function readActiveSlug(root) {
  let raw = '';
  try {
    raw = fs.readFileSync(path.join(root, 'current.json'), 'utf8');
  } catch {
    return '';
  }
  try {
    const parsed = JSON.parse(raw);
    const activeSlug = (parsed && parsed.active_slug) || '';
    if (!activeSlug) return '';
    // sanitizeSegment falls back to the literal "unknown" for an all-stripped input; that
    // fallback is not a legitimate slug, so treat it as "no active slug" here rather than
    // matching against a subject that was never really claimed.
    const sanitized = sanitizeSegment(activeSlug);
    return sanitized === 'unknown' ? '' : sanitized;
  } catch {
    return '';
  }
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
 * Emit a throttled tool-activity liveness heartbeat for the resolved
 * actor/subject, if (and only if) a fresh, unreleased claim already exists.
 * Never creates a new claim. Fails open — always resolves to a result
 * object, never throws.
 *
 * See the module header for the full F8(ii) throttle/emit split. Summary:
 *   - enabled? -> slug present? -> resolveActor() -> bounded tail read, in
 *     that order (F3), so a disabled repo or one with no active session
 *     never pays the resolveActor() ancestry `ps` spawn cost.
 *   - THROTTLE decision reads only the bounded tail (never a full read):
 *     a release found there refuses; a fresh event there throttles.
 *   - EMIT decision requires an actual `claim` event for the pair: taken
 *     from the tail when already present there, otherwise exactly one full
 *     read confirms (or refutes) it. No claim anywhere -> 'no-claim'.
 *
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, now?: Date|string}} [opts]
 * @returns {{emitted: boolean, reason?: string}}
 */
function maybeEmitHeartbeat(opts = {}) {
  const { cwd = process.cwd(), env = process.env } = opts || {};
  try {
    if (!isLivenessEnabled(env)) {
      return { emitted: false, reason: 'disabled' };
    }

    const root = flowAgentsArtifactRoot(cwd);
    const slug = readActiveSlug(root);
    if (!slug) {
      return { emitted: false, reason: 'no-current' };
    }

    const { actor } = resolveActor(env);
    if (isUnresolvedActor(actor)) {
      return { emitted: false, reason: 'actor-unresolved' };
    }

    const streamPath = livenessStreamFile(root);
    const nowMs = resolveNowMs(opts.now);
    const throttleMs = resolveHeartbeatThrottleSeconds(env) * 1000;

    // ─── 1. THROTTLE decision — bounded tail only, never a full read (F8(ii)) ──
    let matching = filterMatchingPair(readLivenessEventsTail(streamPath), slug, actor);
    let last = matching.length ? matching[matching.length - 1] : null;
    if (last) {
      if (last.type === 'release') {
        return { emitted: false, reason: 'released' };
      }
      const lastAtMs = Date.parse(last.at);
      if (Number.isFinite(lastAtMs) && nowMs - lastAtMs < throttleMs) {
        return { emitted: false, reason: 'throttled' };
      }
    }

    // ─── 2. EMIT decision — requires actual claim evidence (F8(ii)) ───────────
    // A bare heartbeat (or a release we've already ruled out above) is never sufficient
    // evidence on its own that a claim was ever made — that assumption is exactly the
    // orphan-heartbeat defect this closes. Prefer evidence already visible in the tail
    // (zero extra I/O); only pay for one full read when the tail didn't already settle it
    // (either it had no matching events at all, or it had some but none was a claim).
    let hasClaim = matching.some((e) => e.type === 'claim');
    if (!hasClaim) {
      matching = filterMatchingPair(readLivenessEvents(streamPath), slug, actor);
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
        return { emitted: false, reason: 'throttled' };
      }
    }

    const nowIso = new Date(nowMs).toISOString();
    appendLivenessEvent(root, {
      type: 'heartbeat',
      subjectId: slug,
      actor,
      at: nowIso,
      source: 'tool-activity',
    });
    return { emitted: true };
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
