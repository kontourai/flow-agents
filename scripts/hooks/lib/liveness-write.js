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
const { spawn } = require('child_process');

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);
// Cheap per-process memo keyed by the exact env inputs, so a throttled hot path does at most one
// conf read per (env flag, conf path) signature. Keyed inputs make unit tests that vary
// TELEMETRY_CONFIG_FILE independent.
const relayEnabledCache = new Map();

/**
 * The console-conf resolution chain, mirroring scripts/telemetry/lib/config.sh's slot order:
 *   1. TELEMETRY_CONFIG_FILE (env) if set + readable
 *   2. per-workspace override: <workspace-root>/.kontourai/telemetry-console.conf
 *   3. user-global durable override: ~/.flow-agents/telemetry-console.conf
 *   4. the shipped default: scripts/telemetry/telemetry.conf (relative to this file)
 * Slot 4's path is <this file>/../../telemetry/telemetry.conf; the workspace root for slot 2 is
 * three levels up from scripts/hooks/lib. This resolver is only the SPAWN pre-gate — it is
 * intentionally lenient (no mode-600 trust gate). relay.sh re-sources config.sh, which applies the
 * trust gate and is the authoritative decision for both enablement and the POST endpoint, so a
 * lenient "enabled" here at worst spawns a relay.sh that then trust-gates itself to a no-op.
 *
 * ACCEPTED, BY DESIGN (security review LOW, A04): because this pre-gate does NOT re-apply
 * config.sh's mode-600/owner gate, it can read an explicit key from an UNtrusted default-path conf
 * (a mode-644 .kontourai/telemetry-console.conf a local tool dropped) that config.sh would skip.
 * This is fail-toward-no-op, never fail-toward-exfil: the only divergence is (a) we spawn a
 * relay.sh that config.sh then no-ops (harmless), or (b) an untrusted `=0` here suppresses a spawn
 * that a trusted conf would have enabled (a missed pulse — availability only, requiring local FS
 * write access). The pre-gate deliberately does not guarantee relay AVAILABILITY — only that we
 * avoid spawning when nothing plausibly enables it. It NEVER weakens the exfil defense, which lives
 * entirely in relay.sh's authoritative, trust-gated re-resolution.
 * @returns {string|null}  first readable conf path, or null
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

/**
 * Conf-driven liveness relay enablement (#567 — parity with the economics relay #469, so an
 * operator enables via `console_liveness_relay=1` in the console conf, NOT an env var/.profile).
 * Precedence mirrors config.sh's economics rule EXACTLY (config.sh:182-204): an explicit
 * `console_liveness_relay` conf key wins over the env var; absent a key, a pre-set env var is
 * honored; absent both, default ON once a console sink is configured (any console_*url key present)
 * — opt-out, not silent-off. Best-effort and cheap: any FS/parse failure falls back to the env-only
 * decision; never throws. This is the spawn pre-gate; relay.sh+config.sh is authoritative.
 */
function resolveLivenessRelayEnabled(env) {
  const envFlag = String(env.FLOW_AGENTS_CONSOLE_LIVENESS_RELAY || '').toLowerCase();
  const envDecision = TRUTHY.has(envFlag) ? true : FALSY.has(envFlag) ? false : null;
  const cacheKey = `${envFlag}|${env.TELEMETRY_CONFIG_FILE || ''}`;
  if (relayEnabledCache.has(cacheKey)) return relayEnabledCache.get(cacheKey);
  let enabled;
  try {
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
        if (key === 'console_liveness_relay') {
          if (TRUTHY.has(value)) explicit = true;
          else if (FALSY.has(value)) explicit = false;
        } else if (key === 'console_telemetry_url' || key === 'console_url' || key === 'console_telemetry_endpoint_url') {
          if (value) hasConsoleUrl = true;
        }
      }
    }
    // config.sh precedence: explicit conf key > pre-set env var > default-on when a console url resolves.
    enabled = explicit !== null ? explicit : envDecision !== null ? envDecision : hasConsoleUrl;
  } catch {
    enabled = envDecision === true; // best-effort: honor only an explicit env-on if the conf read failed
  }
  relayEnabledCache.set(cacheKey, enabled);
  return enabled;
}

/**
 * OPTIONAL console liveness relay (#295, ADR 0021 §4/§7; conf-driven per #567). Best-effort, FULLY
 * detached mirror of a liveness event to the hosted Console via `scripts/liveness/relay.sh`.
 * Local-first is sacred: this runs AFTER the durable local append and can never block, throw, or
 * affect it — gated on `resolveLivenessRelayEnabled`, the whole thing wrapped so any failure
 * (missing script, spawn error) is swallowed. Not enabled ⇒ a cheap resolve and return (true no-op).
 *
 * @param {object} evt  The liveness event just written locally.
 * @returns {void}
 */
function relayLivenessEvent(evt) {
  try {
    if (!resolveLivenessRelayEnabled(process.env)) return;
    // scripts/hooks/lib/ -> scripts/liveness/relay.sh (same relative layout in dist/* bundles).
    const relay = path.join(__dirname, '..', '..', 'liveness', 'relay.sh');
    if (!fs.existsSync(relay)) return;
    // Pass the environment through UNCHANGED — do not force the enable flag. relay.sh re-sources
    // config.sh, which is the authoritative, trust-gated decision for both enablement (conf key >
    // env > default-on) and the POST endpoint. Our resolve above is only a lenient spawn pre-gate:
    // if we enabled from an untrusted default-path conf, config.sh trust-gates relay.sh to a no-op
    // rather than us bypassing it by forcing the flag on.
    const child = spawn('bash', [relay, JSON.stringify(evt)], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
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

module.exports = { livenessStreamFile, appendLivenessEvent, resolveLivenessRelayEnabled };
