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
const path = require('path');
const { spawn } = require('child_process');

/**
 * OPTIONAL console liveness relay (#295, ADR 0021 §4/§7). Best-effort, FULLY detached mirror of a
 * liveness event to the hosted Console via `scripts/liveness/relay.sh`. Local-first is sacred: this
 * runs AFTER the durable local append and can never block, throw, or affect it — gated on
 * `FLOW_AGENTS_CONSOLE_LIVENESS_RELAY`, the whole thing wrapped so any failure (missing script,
 * spawn error) is swallowed. No flag ⇒ a single cheap env read and return (true no-op).
 *
 * @param {object} evt  The liveness event just written locally.
 * @returns {void}
 */
function relayLivenessEvent(evt) {
  try {
    const flag = String(process.env.FLOW_AGENTS_CONSOLE_LIVENESS_RELAY || '').toLowerCase();
    if (flag !== '1' && flag !== 'true' && flag !== 'yes' && flag !== 'on') return;
    // scripts/hooks/lib/ -> scripts/liveness/relay.sh (same relative layout in dist/* bundles).
    const relay = path.join(__dirname, '..', '..', 'liveness', 'relay.sh');
    if (!fs.existsSync(relay)) return;
    const child = spawn('bash', [relay, JSON.stringify(evt)], { detached: true, stdio: 'ignore' });
    child.on('error', () => {}); // never surface a spawn failure
    child.unref(); // fully detach — the parent never waits on the relay
  } catch {
    // Best-effort only: the durable local write already succeeded above.
  }
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

module.exports = { livenessStreamFile, appendLivenessEvent };
