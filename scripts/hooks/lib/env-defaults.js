/**
 * env-defaults.js — `--env-default=KEY=VALUE` argument support for hook adapters.
 *
 * The bundle emitters used to ship environment defaults as shell prefixes
 * (`FLOW_AGENTS_GOAL_FIT_MODE="${FLOW_AGENTS_GOAL_FIT_MODE:-block}" node …`),
 * which required a shell in the hook path — the exact dependency that made
 * every hook exit 127 on stock Windows (#1098). With hooks now invoked as
 * direct `node` commands, the default travels as an adapter argument instead:
 * apply KEY=VALUE to the child environment only when KEY is unset, so an
 * operator's explicit value always wins — identical semantics, no shell.
 */

'use strict';

const ENV_DEFAULT_PREFIX = '--env-default=';

/**
 * Split `--env-default=KEY=VALUE` arguments out of an argv array.
 *
 * @param {string[]} argv full process.argv
 * @returns {{ argv: string[], defaults: Record<string, string> }} argv with the
 *   flags removed (positional contract preserved for existing destructuring)
 *   and the collected defaults. Malformed values (no KEY, no `=`) are dropped
 *   rather than thrown: a hook must never fail closed on its own plumbing.
 */
function extractEnvDefaults(argv) {
  const filtered = [];
  const defaults = {};
  for (const arg of argv) {
    if (typeof arg === 'string' && arg.startsWith(ENV_DEFAULT_PREFIX)) {
      const pair = arg.slice(ENV_DEFAULT_PREFIX.length);
      const eq = pair.indexOf('=');
      if (eq > 0) defaults[pair.slice(0, eq)] = pair.slice(eq + 1);
      continue;
    }
    filtered.push(arg);
  }
  return { argv: filtered, defaults };
}

/**
 * Return a copy of `env` where each default is applied only if the key is
 * absent or empty — operator overrides always win.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {Record<string, string>} defaults
 * @returns {Record<string, string | undefined>}
 */
function applyEnvDefaults(env, defaults) {
  const result = { ...env };
  for (const [key, value] of Object.entries(defaults)) {
    if (result[key] === undefined || result[key] === '') result[key] = value;
  }
  return result;
}

module.exports = { extractEnvDefaults, applyEnvDefaults };
