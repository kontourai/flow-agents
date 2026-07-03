'use strict';
/**
 * liveness-policy.js — shared pure-CJS liveness policy predicates
 *
 * Zero external dependencies. Consumed by:
 *   - scripts/hooks/lib/liveness-heartbeat.js  (CJS, direct require)
 *   - build/src/cli/workflow-sidecar.js        (ESM compiled, via createRequire)
 *
 * Purpose (issue #288): the ONE definition of the liveness on/off predicate,
 * the claim TTL default, and the heartbeat throttle default, so
 * `livenessEnabled()`/the claim-path TTL literal in workflow-sidecar.ts and
 * the new tool-activity heartbeat (liveness-heartbeat.js) can never disagree
 * about what "enabled" or "default TTL" means — the same consume-never-fork
 * discipline already used for actor resolution (actor-identity.js) and
 * liveness-stream reads (liveness-read.js).
 *
 * Default-on / opt-out (#288 supersedes #166's opt-in default per ADR 0021
 * §3): presence is ambient unless explicitly disabled via one of
 * `off|0|false|no|disabled` (case-insensitive, whitespace-trimmed, and with
 * zero-width/format characters — U+200B/U+200C/U+200D/U+FEFF — stripped
 * before comparison, F4 #288 fix iteration 1, sec-LOW: `"off\u200B"` must
 * still disable, not silently stay enabled by comparing unequal to the
 * `"off"` token). Every other value — including unset/empty — is treated as
 * enabled.
 *
 * Exports:
 *   DEFAULT_TTL_SECONDS                    = 1800
 *   DEFAULT_HEARTBEAT_THROTTLE_SECONDS     = 60
 *   isLivenessEnabled(env)                 → boolean
 *   resolveTtlSeconds(env)                 → number
 *   resolveHeartbeatThrottleSeconds(env)   → number
 */

/** Explicit opt-out tokens (case-insensitive, trimmed). Everything else — including
 * unset/empty — is enabled. */
const DISABLED_TOKENS = new Set(['off', '0', 'false', 'no', 'disabled']);

/**
 * Zero-width/format characters (U+200B ZERO WIDTH SPACE, U+200C ZERO WIDTH NON-JOINER,
 * U+200D ZERO WIDTH JOINER, U+FEFF ZERO WIDTH NO-BREAK SPACE / BOM) that render invisibly but
 * would otherwise make an opt-out token compare unequal to its canonical form (F4, #288 fix
 * iteration 1, sec-LOW).
 */
const ZERO_WIDTH_CHARS_RE = /[\u200B-\u200D\uFEFF]/g;

/** Default liveness claim TTL, in seconds (30 minutes). */
const DEFAULT_TTL_SECONDS = 1800;

/** Default minimum spacing between tool-activity heartbeats for one subject+actor, in seconds. */
const DEFAULT_HEARTBEAT_THROTTLE_SECONDS = 60;

/**
 * Default-on / opt-out predicate for `FLOW_AGENTS_LIVENESS`. Takes `env` as an explicit
 * param (mirroring actor-identity.js's style) rather than reading `process.env` internally,
 * so it stays unit-testable.
 *
 * @param {NodeJS.ProcessEnv} [env]  Environment to inspect (default process.env)
 * @returns {boolean}  false only when FLOW_AGENTS_LIVENESS is an explicit off-token; true otherwise
 */
function isLivenessEnabled(env = process.env) {
  env = env || {};
  const value = String(env.FLOW_AGENTS_LIVENESS ?? '')
    .replace(ZERO_WIDTH_CHARS_RE, '')
    .trim()
    .toLowerCase();
  return !DISABLED_TOKENS.has(value);
}

/** Strict positive-integer literal: one or more ASCII digits, nothing else (F7, #287/#288 fix
 * iterations: rejects hex (`0x10`), exponential (`1e3`), decimal, signed, and whitespace-padded
 * coercions that JS's `Number()` would otherwise silently accept). */
const STRICT_POSITIVE_INT_RE = /^[0-9]+$/;

/**
 * Parse a positive-integer env override, falling back to a default when the raw value is
 * missing, non-numeric, or not strictly positive. Uses a strict `/^[0-9]+$/` literal match
 * (F7) rather than `Number()` coercion, so inputs like `"0x10"` (16) or `"1e3"` (1000) — valid
 * per `Number()` but not a plain positive-integer literal — fall back to the default instead of
 * silently being accepted.
 *
 * @param {*} rawValue
 * @param {number} fallback
 * @returns {number}
 */
function parsePositiveIntOr(rawValue, fallback) {
  const trimmed = String(rawValue ?? '').trim();
  if (!STRICT_POSITIVE_INT_RE.test(trimmed)) return fallback;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

/**
 * Resolve the liveness claim TTL, in seconds: `FLOW_AGENTS_LIVENESS_TTL_SECONDS` if set to a
 * positive number, else DEFAULT_TTL_SECONDS.
 *
 * @param {NodeJS.ProcessEnv} [env]  Environment to inspect (default process.env)
 * @returns {number}
 */
function resolveTtlSeconds(env = process.env) {
  env = env || {};
  return parsePositiveIntOr(env.FLOW_AGENTS_LIVENESS_TTL_SECONDS, DEFAULT_TTL_SECONDS);
}

/**
 * Resolve the heartbeat throttle window, in seconds: minimum spacing between tool-activity
 * heartbeats for one subject+actor pair. `FLOW_AGENTS_LIVENESS_HEARTBEAT_THROTTLE_SECONDS` if
 * set to a positive number, else DEFAULT_HEARTBEAT_THROTTLE_SECONDS.
 *
 * @param {NodeJS.ProcessEnv} [env]  Environment to inspect (default process.env)
 * @returns {number}
 */
function resolveHeartbeatThrottleSeconds(env = process.env) {
  env = env || {};
  return parsePositiveIntOr(
    env.FLOW_AGENTS_LIVENESS_HEARTBEAT_THROTTLE_SECONDS,
    DEFAULT_HEARTBEAT_THROTTLE_SECONDS
  );
}

module.exports = {
  DEFAULT_TTL_SECONDS,
  DEFAULT_HEARTBEAT_THROTTLE_SECONDS,
  isLivenessEnabled,
  resolveTtlSeconds,
  resolveHeartbeatThrottleSeconds,
};
