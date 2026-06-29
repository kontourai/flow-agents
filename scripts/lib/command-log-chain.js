'use strict';
//
// Single normative source for the command-log hash-chain primitives and the
// exit-code-laundering heuristic.
//
// These were previously copy-pasted across the writer (hooks/evidence-capture.js),
// the verifier (hooks/stop-goal-fit.js), the repair tool (repair-command-log.js),
// and CI reconcile (ci/trust-reconcile.js) under "keep byte-identical" comments —
// the most security-sensitive path in the bundle, since the chain's integrity
// claim rests on writer and verifier canonicalizing identically. The copies had
// ALREADY drifted (ci/trust-reconcile's hasLaunderingOperator was missing the
// trailing `/bin/true` check), which is exactly the failure mode duplication
// invites. Importing from one module makes that divergence structurally impossible.
//
const crypto = require('crypto');

// The genesis prevHash is a FIXED ARBITRARY SENTINEL — NOT the SHA256 of any
// specific input string. (An earlier comment incorrectly claimed it was
// sha256("flow-agents:command-log:genesis"); that is wrong.) Writer and verifier
// MUST share this exact value — existing chained logs depend on it.
//
// HONEST FRAMING: this makes alteration DETECTABLE, not impossible. An agent that
// rewrites all hashes can still forge the chain. The real tamper-proof boundary is
// the signed checkpoint (B1). We do not oversell this boundary.
const CHAIN_GENESIS = 'a3f9e2b7d5c84f1e6a0d2c3b9f7e1a4d8c6b5f2e9a0d3c7b1f4e8a2d6c0b9f3';

/**
 * Stable canonical JSON for a chain link: the record WITHOUT its `_chain` field,
 * keys sorted alphabetically. This makes the hash independent of key insertion
 * order and keeps `_chain` from contributing to its own hash.
 */
function canonicalJsonForChain(record) {
  const keys = Object.keys(record).filter((k) => k !== '_chain').sort();
  const obj = {};
  for (const k of keys) obj[k] = record[k];
  return JSON.stringify(obj);
}

/** Chain link hash: sha256(prevHash + canonicalJsonForChain(record)), hex. */
function computeChainHash(prevHash, record) {
  return crypto
    .createHash('sha256')
    .update(prevHash + canonicalJsonForChain(record), 'utf8')
    .digest('hex');
}

/**
 * True when a claimed verification command contains an exit-code-laundering
 * operator. Legitimate verification commands never need these — their only
 * purpose is to suppress a real non-zero exit:
 *   - ANY `||`             (e.g. `npm test || exit 0`, `|| echo ok`, `|| /bin/true`)
 *   - `| true`             (pipe into true — the pipeline absorbs the exit code)
 *   - trailing `; true` / `; :` / `; exit 0` / `; /bin/true` (and `\n` variants)
 */
function hasLaunderingOperator(cmd) {
  // ANY || in a claimed verification command is an exit-code mask.
  if (/\|\|/.test(cmd)) return true;
  // | true — single-pipe into true always exits 0 regardless of the left side.
  if (/\|\s*true\b/.test(cmd)) return true;
  // Trailing ; or \n followed by an exit-neutralizing command:
  if (/[;\n]\s*true\b/.test(cmd)) return true;
  if (/[;\n]\s*:\s*(?:$|\s|;)/.test(cmd)) return true;
  if (/[;\n]\s*exit\s+0\b/.test(cmd)) return true;
  if (/[;\n]\s*\/bin\/true\b/.test(cmd)) return true;
  return false;
}

module.exports = {
  CHAIN_GENESIS,
  canonicalJsonForChain,
  computeChainHash,
  hasLaunderingOperator,
};
