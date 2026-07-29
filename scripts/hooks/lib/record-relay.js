'use strict';
/**
 * record-relay.js — ONE conf-driven, local-first console relay primitive (#1025).
 *
 * Two record families already needed a detached console mirror, and each grew its own copy of the
 * same logic: economics (#469) first, then liveness (#295/#567) explicitly "parity with the
 * economics relay". Both resolve the same conf file, apply the same precedence rule, and spawn a
 * relay script the same detached way. Adding policy records as a third copy would make the
 * duplication a pattern instead of an accident, so this module is the one implementation and the
 * families become parameters.
 *
 * PRECEDENCE (unchanged from config.sh's economics rule, which liveness already mirrors):
 *   explicit `console_<family>_relay` conf key  >  pre-set env var  >  default-ON once any
 *   console url key resolves. Opt-out, never silent-off — an operator who configured a console
 *   gets the records without a second switch, and an operator who wants silence says so.
 *
 * THIS IS A SPAWN PRE-GATE, NOT THE AUTHORITY. It is deliberately lenient (no mode-600 trust gate):
 * the relay script re-sources config.sh, which applies the trust gate and is authoritative for both
 * enablement and the endpoint. Failing lenient here can only spawn a relay that then no-ops; it can
 * never bypass the exfil defense, which lives entirely in that re-resolution.
 *
 * LOCAL-FIRST IS SACRED. Every caller writes durably FIRST and relays after. Nothing here may
 * block, throw, or influence the caller — every failure path is a swallowed no-op.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);
const CONSOLE_URL_KEYS = new Set(['console_telemetry_url', 'console_url', 'console_telemetry_endpoint_url']);

/** Cache keyed by family + the inputs that can change the answer. */
const enabledCache = new Map();

/**
 * Resolve the console conf path. Identical candidate order to the liveness resolver it replaces —
 * an explicit `TELEMETRY_CONFIG_FILE`, the repo-local conf, the user conf, then the bundled default.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string|null}
 */
function resolveConsoleConfPath(env) {
  const candidates = [
    env.TELEMETRY_CONFIG_FILE,
    path.join(__dirname, '..', '..', '..', '.kontourai', 'telemetry-console.conf'),
    path.join(os.homedir(), '.flow-agents', 'telemetry-console.conf'),
    path.join(__dirname, '..', '..', 'telemetry', 'telemetry.conf'),
  ];
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

/** Env var name for a family, e.g. `policy` -> `FLOW_AGENTS_CONSOLE_POLICY_RELAY`. */
function envVarFor(family) {
  return `FLOW_AGENTS_CONSOLE_${family.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_RELAY`;
}

/** Conf key for a family, e.g. `policy` -> `console_policy_relay`. */
function confKeyFor(family) {
  return `console_${family.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_relay`;
}

/**
 * Is the relay for `family` enabled? Best-effort and cheap; never throws.
 *
 * @param {string} family  Record family, e.g. 'liveness' | 'policy' | 'economics'
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
function resolveRelayEnabled(family, env) {
  const envFlag = String(env[envVarFor(family)] || '').toLowerCase();
  const envDecision = TRUTHY.has(envFlag) ? true : FALSY.has(envFlag) ? false : null;
  const cacheKey = `${family}|${envFlag}|${env.TELEMETRY_CONFIG_FILE || ''}`;
  if (enabledCache.has(cacheKey)) return enabledCache.get(cacheKey);

  let enabled;
  try {
    const wanted = confKeyFor(family);
    let explicit = null;
    let hasConsoleUrl = false;
    const confPath = resolveConsoleConfPath(env);
    if (confPath) {
      for (const raw of fs.readFileSync(confPath, 'utf8').split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim().toLowerCase();
        if (key === wanted) {
          if (TRUTHY.has(value)) explicit = true;
          else if (FALSY.has(value)) explicit = false;
        } else if (CONSOLE_URL_KEYS.has(key) && value) {
          hasConsoleUrl = true;
        }
      }
    }
    enabled = explicit !== null ? explicit : envDecision !== null ? envDecision : hasConsoleUrl;
  } catch {
    enabled = envDecision === true; // best-effort: honor only an explicit env-on if the conf read failed
  }
  enabledCache.set(cacheKey, enabled);
  return enabled;
}

/**
 * Mirror one already-durably-written record to the Console. Fully detached, best-effort.
 *
 * The environment is passed through UNCHANGED — the enable flag is deliberately not forced, so the
 * relay script's own trust-gated re-resolution stays authoritative (see the module note).
 *
 * @param {string} family      Record family, selects the conf key / env var.
 * @param {string} relayScript Absolute path to the family's relay.sh.
 * @param {object} record      The record just written locally.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {void}
 */
function relayRecord(family, relayScript, record, env = process.env) {
  try {
    if (!resolveRelayEnabled(family, env)) return;
    if (!fs.existsSync(relayScript)) return;
    const child = spawn('bash', [relayScript, JSON.stringify(record)], { detached: true, stdio: 'ignore', env });
    child.on('error', () => {}); // never surface a spawn failure
    child.unref(); // fully detach — the caller never waits on the relay
  } catch {
    // Best-effort only: the durable local write already succeeded before this was called.
  }
}

module.exports = { resolveRelayEnabled, relayRecord, resolveConsoleConfPath, envVarFor, confKeyFor };
