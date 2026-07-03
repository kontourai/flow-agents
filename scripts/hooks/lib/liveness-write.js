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
  fs.appendFileSync(file, `${JSON.stringify(evt)}\n`);
}

module.exports = { livenessStreamFile, appendLivenessEvent };
