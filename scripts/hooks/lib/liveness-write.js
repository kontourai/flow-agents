'use strict';
/**
 * liveness-write.js — shared pure-CJS liveness stream writer
 *
 * Zero external dependencies. Consumed by:
 *   - scripts/hooks/lib/liveness-heartbeat.js  (CJS, direct require)
 *   - build/src/cli/workflow-sidecar.js        (ESM compiled, via createRequire)
 *
 * Purpose (issue #288): the ONE writer for `liveness/events.jsonl`, lifted
 * verbatim from `src/cli/workflow-sidecar.ts`'s inline `livenessStreamFile`/
 * `appendLivenessEvent` so both the CLI and the hook wrappers share one
 * implementation (mirroring the existing `liveness-read.js`/`actor-identity.js`
 * sharing pattern) instead of forking the append shape a second time.
 *
 * Exports:
 *   livenessStreamFile(root)   → string  (absolute path to liveness/events.jsonl)
 *   appendLivenessEvent(root, evt)  → void  (mkdir -p parent, append one JSON line)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { relayRecord, resolveRelayEnabled } = require('./record-relay');

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);
// Cheap per-process memo keyed by the exact env inputs, so a throttled hot path does at most one
// conf read per (env flag, conf path) signature. Keyed inputs make unit tests that vary
// TELEMETRY_CONFIG_FILE independent.
const relayEnabledCache = new Map();

/**
 * Liveness relay enablement — now a thin alias over the shared, family-parameterized primitive in
 * `record-relay.js` (#1025). This module used to carry its own conf resolver, precedence rule, and
 * detached spawn; economics (#469) carried a second copy and policy records would have been a
 * third. The behavior and the precedence are unchanged — conf key > env var > default-on once a
 * console url resolves — only the ownership moved. Kept exported because evals and callers name it.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
function resolveLivenessRelayEnabled(env) {
  return resolveRelayEnabled('liveness', env);
}

/**
 * OPTIONAL console liveness relay (#295, ADR 0021 sections 4/7; conf-driven per #567). Best-effort,
 * fully detached mirror of a liveness event, delegated to the shared relay primitive. Local-first is
 * sacred: this runs AFTER the durable local append and can never block, throw, or affect it.
 *
 * @param {object} evt  The liveness event just written locally.
 * @returns {void}
 */
function relayLivenessEvent(evt) {
  // scripts/hooks/lib/ -> scripts/liveness/relay.sh (same relative layout in dist/* bundles).
  relayRecord('liveness', path.join(__dirname, '..', '..', 'liveness', 'relay.sh'), evt);
}

/**
 * Resolve the path to the shared liveness event stream for a given artifact root.
 *
 * @param {string} root  Artifact root (e.g. `.kontourai/flow-agents`)
 * @returns {string}  `<root>/liveness/events.jsonl`
 */
function livenessStreamFile(root) {
  return path.join(root, 'liveness', 'events.jsonl');
}

/**
 * Append one liveness event to the shared stream, creating the parent directory if needed.
 *
 * @param {string} root  Artifact root (e.g. `.kontourai/flow-agents`)
 * @param {object} evt   Event object (written as one JSON line, newline-terminated)
 * @returns {void}
 */
function appendLivenessEvent(root, evt) {
  const file = livenessStreamFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(evt)}\n`); // local-first: the durable write happens first
  relayLivenessEvent(evt); // then optionally mirror to the Console — best-effort, detached, off by default
}

module.exports = { livenessStreamFile, appendLivenessEvent, resolveLivenessRelayEnabled };
