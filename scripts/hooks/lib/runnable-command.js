'use strict';
/**
 * runnable-command.js — shared pure-CJS runnable-command-text heuristic (#412)
 *
 * Zero external dependencies (only string ops). Consumed by:
 *   - scripts/hooks/stop-goal-fit.js     (CJS, direct require)
 *   - build/src/cli/workflow-sidecar.js  (ESM compiled, via createRequire)
 *
 * Extracted verbatim (no logic change) from stop-goal-fit.js's former inline
 * `isRunnableCommandText`, so the heuristic has exactly one source of truth
 * instead of drifting between the hook (Stop-time backstop) and the sidecar
 * (record-time rejection).
 *
 * Exports:
 *   isRunnableCommandText(text) → boolean
 */

// WS8 (AC10b): a kind:"command" evidence ref's excerpt/command must be a literally runnable
// shell command, not a prose description of a manual verification step. This heuristic
// rejects prose so the goal-fit backstop never spawns `bash -lc "<a sentence>"` and
// misreports the resulting shell error as a caught false-completion. Pairs with the rule
// stated in context/contracts/planning-contract.md (AC11).
function isRunnableCommandText(text) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s) return false;
  // Sentence-like prose (a . ! or ? followed by more words) is not a single command.
  if (/[.!?]\s+\S/.test(s)) return false;
  const first = s.split(/\s+/)[0] || '';
  // WS8 (AC10b, iteration 2): the first-token allowlist is broadened to the common
  // real-world verify binaries a project's runnable evidence names (git, tsc, eslint,
  // python/python3, docker, curl, jq, diff, grep, test) so honest command evidence is not
  // misclassified as prose. Still fail-closed for genuinely non-command prose: a bare
  // sentence whose first token is none of these (and carries no path prefix or shell
  // metacharacter) is rejected rather than executed.
  const knownBinary = /^(npm|npx|pnpm|yarn|node|bash|sh|zsh|make|just|task|cargo|go|pytest|tox|deno|bun|ruby|rake|mvn|gradle|dotnet|swift|flutter|dart|git|tsc|eslint|python|python3|docker|curl|jq|diff|grep|test)$/.test(first)
    || first.startsWith('./') || first.startsWith('/') || first.includes('/');
  const hasShellMeta = /[|&;<>()$`]/.test(s);
  return knownBinary || hasShellMeta;
}

module.exports = { isRunnableCommandText };
