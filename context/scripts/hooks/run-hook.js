#!/usr/bin/env node
/**
 * Hook runner — checks profile/disable flags before executing the actual hook.
 *
 * Usage:
 *   node run-hook.js <hookId> <scriptRelativePath> [profilesCsv]
 *
 * Exit codes:
 *   0 = allow (pass through)
 *   2 = block (preToolUse only)
 *   other = error (non-blocking)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { isHookEnabled } = require('./lib/hook-flags');
const { buildPolicyRecord, writePolicyRecord } = require('./lib/policy-record');
const { flowAgentsArtifactRoot } = require('./lib/local-artifact-paths');

const MAX_STDIN = 1024 * 1024;
const CONTRACT_VERSION = '1.0';


/**
 * #1025: emit one `kontour.console.policy` record for this hook's decision.
 *
 * Placed here, at the runtime-neutral runner, rather than in the four per-runtime adapters: this is
 * the single path all of them funnel through, and the only place the decision exists as a value.
 * Wrapped whole and swallowed — a telemetry concern must never be able to change a gate's verdict,
 * so this returns the exit code it was handed, always.
 *
 * @param {string} hookId
 * @param {string} raw       the hook's raw stdin payload (host-native JSON)
 * @param {number} exitCode
 * @returns {number} exitCode, unchanged
 */
function recordPolicyDecision(hookId, raw, exitCode) {
  try {
    let payload = {};
    try { payload = JSON.parse(raw) || {}; } catch { /* host payload may not be JSON; record what we can */ }
    const record = buildPolicyRecord({
      hookId,
      event: typeof payload.hook_event_name === 'string' ? payload.hook_event_name : null,
      runtime: typeof payload.runtime === 'string' ? payload.runtime : (process.env.FLOW_AGENTS_RUNTIME || null),
      exitCode,
      at: new Date().toISOString(),
      toolName: typeof payload.tool_name === 'string' ? payload.tool_name : null,
      sessionId: typeof payload.session_id === 'string' ? payload.session_id : null,
      cwd: typeof payload.cwd === 'string' ? payload.cwd : process.cwd(),
    });
    writePolicyRecord(flowAgentsArtifactRoot(process.cwd()), record);
  } catch {
    /* best-effort: never let recording affect the decision */
  }
  return exitCode;
}

function readStdinRaw() {
  return new Promise(resolve => {
    let raw = '';
    let truncated = false;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      if (raw.length < MAX_STDIN) {
        const remaining = MAX_STDIN - raw.length;
        raw += chunk.substring(0, remaining);
        if (chunk.length > remaining) truncated = true;
      } else {
        truncated = true;
      }
    });
    process.stdin.on('end', () => resolve({ raw, truncated }));
    process.stdin.on('error', () => resolve({ raw, truncated }));
  });
}

function emitHookResult(raw, output) {
  if (typeof output === 'string' || Buffer.isBuffer(output)) {
    process.stdout.write(String(output));
    return 0;
  }
  if (output && typeof output === 'object') {
    if (output.stderr) {
      process.stderr.write(output.stderr.endsWith('\n') ? output.stderr : `${output.stderr}\n`);
    }
    if (Object.prototype.hasOwnProperty.call(output, 'stdout')) {
      process.stdout.write(String(output.stdout ?? ''));
    } else if (!Number.isInteger(output.exitCode) || output.exitCode === 0) {
      process.stdout.write(raw);
    }
    return Number.isInteger(output.exitCode) ? output.exitCode : 0;
  }
  process.stdout.write(raw);
  return 0;
}

async function main() {
  const [, , hookId, relScriptPath, profilesCsv] = process.argv;
  const { raw, truncated } = await readStdinRaw();

  if (!hookId || !relScriptPath) {
    process.stdout.write(raw);
    process.exit(0);
  }

  if (!isHookEnabled(hookId, { profiles: profilesCsv })) {
    process.stdout.write(raw);
    process.exit(0);
  }

  const hooksDir = __dirname;
  const scriptPath = path.resolve(hooksDir, relScriptPath);

  if (!scriptPath.startsWith(hooksDir + path.sep)) {
    process.stderr.write(`[Hook] Path traversal rejected for ${hookId}: ${scriptPath}\n`);
    process.stdout.write(raw);
    process.exit(0);
  }

  if (!fs.existsSync(scriptPath)) {
    process.stderr.write(`[Hook] Script not found for ${hookId}: ${scriptPath}\n`);
    process.stdout.write(raw);
    process.exit(0);
  }

  // Prefer direct require() when the hook exports run() — saves ~50-100ms
  let hookModule;
  const src = fs.readFileSync(scriptPath, 'utf8');
  if (/\bmodule\.exports\b/.test(src) && /\brun\b/.test(src)) {
    try { hookModule = require(scriptPath); } catch (e) {
      process.stderr.write(`[Hook] require() failed for ${hookId}: ${e.message}\n`);
    }
  }

  if (hookModule && typeof hookModule.run === 'function') {
    try {
      const outputOrPromise = hookModule.run(raw, { truncated, maxStdin: MAX_STDIN });
      // Support async run() (returns a Promise): await before emitting result.
      // Synchronous run() returns a plain value — Promise.resolve wraps it safely.
      const output = (outputOrPromise && typeof outputOrPromise.then === 'function')
        ? await outputOrPromise
        : outputOrPromise;
      process.exit(recordPolicyDecision(hookId, raw, emitHookResult(raw, output)));
    } catch (e) {
      process.stderr.write(`[Hook] run() error for ${hookId}: ${e.message}\n`);
      process.stdout.write(raw);
      process.exit(0);
    }
  }

  // Legacy fallback: spawn child process
  const result = spawnSync(process.execPath, [scriptPath], {
    input: raw,
    encoding: 'utf8',
    env: { ...process.env, SA_HOOK_INPUT_TRUNCATED: truncated ? '1' : '0', SA_HOOK_INPUT_MAX_BYTES: String(MAX_STDIN) },
    cwd: process.cwd(),
    timeout: 30000,
  });

  if (result.stdout) process.stdout.write(result.stdout);
  else if (Number.isInteger(result.status) && result.status === 0) process.stdout.write(raw);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.error || result.signal || result.status === null) {
    const detail = result.error ? result.error.message : result.signal ? `signal ${result.signal}` : 'missing exit status';
    process.stderr.write(`[Hook] legacy execution failed for ${hookId}: ${detail}\n`);
    process.exit(1);
  }

  process.exit(recordPolicyDecision(hookId, raw, Number.isInteger(result.status) ? result.status : 0));
}

// Additive: --contract-version prints the engine contract version and exits.
// Backward-compatible: existing callers never pass this flag.
if (process.argv.includes('--contract-version')) {
  process.stdout.write(JSON.stringify({ contract_version: CONTRACT_VERSION, runner: 'run-hook.js' }) + '\n');
  process.exit(0);
}

main().catch(err => {
  process.stderr.write(`[Hook] run-hook error: ${err.message}\n`);
  process.exit(0);
});
