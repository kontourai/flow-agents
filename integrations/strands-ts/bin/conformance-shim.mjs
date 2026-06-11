#!/usr/bin/env node
/**
 * conformance-shim.mjs — Adapter shim for run-conformance.js --adapter-cmd.
 *
 * Receives a canonical JSON payload on stdin (one JSON object, the fixture payload).
 * Invokes the Flow Agents policy engine via native import for preToolUse,
 * and via subprocess for other hook types — matching the adapter's production behavior.
 *
 * Exits 0 (allow) or 2 (block) per the engine contract §8.3.
 *
 * Routing table (matches HOOK_MAP in production adapter):
 *   PreToolUse     → config-protection.js (NATIVE import — no subprocess)
 *   PostToolUse    → quality-gate.js + workflow-steering.js (both via subprocess)
 *   UserPromptSubmit → workflow-steering.js
 *   Stop           → stop-goal-fit.js
 *
 * For PostToolUse, workflow-steering.js is checked first (for InvokeSubagents).
 * If it injects content (non-empty injection), that's included in stdout.
 */

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve repo root: walk up from __dirname looking for scripts/hooks/run-hook.js
function findRepoRoot(start) {
  let current = start;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(current, 'scripts', 'hooks', 'run-hook.js');
    if (fs.existsSync(candidate)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

const repoRoot = findRepoRoot(__dirname);
const hooksDir = repoRoot ? path.join(repoRoot, 'scripts', 'hooks') : null;
const runHookPath = hooksDir ? path.join(hooksDir, 'run-hook.js') : null;

// ---------------------------------------------------------------------------
// Read stdin
// ---------------------------------------------------------------------------

const MAX_STDIN = 1024 * 1024;

async function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    let truncated = false;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
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

// ---------------------------------------------------------------------------
// Invoke a hook script via subprocess (for non-blocking hooks)
// Returns the subprocess result object
// ---------------------------------------------------------------------------

function invokeViaSubprocess(hookId, hookScript, raw) {
  if (!runHookPath || !fs.existsSync(runHookPath)) {
    return { status: 0, stdout: raw, stderr: '' };
  }
  const result = spawnSync(
    process.execPath,
    [runHookPath, hookId, hookScript],
    {
      input: raw,
      encoding: 'utf8',
      env: { ...process.env, FLOW_AGENTS_HOOK_RUNTIME: 'strands-ts' },
      timeout: 15000,
      cwd: repoRoot,
    }
  );
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { raw, truncated } = await readStdin();

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stdout.write(raw);
    process.exit(0);
  }

  const hookEventName = (payload.hook_event_name || '').toLowerCase();

  // -------------------------------------------------------------------------
  // PreToolUse → config-protection.js via NATIVE import (no subprocess)
  // -------------------------------------------------------------------------

  if (hookEventName === 'pretooluse') {
    if (!hooksDir) {
      process.stdout.write(raw);
      process.exit(0);
    }

    const require = createRequire(import.meta.url);
    const configProtectionPath = path.join(hooksDir, 'config-protection.js');

    if (!fs.existsSync(configProtectionPath)) {
      process.stdout.write(raw);
      process.exit(0);
    }

    let mod;
    try {
      mod = require(configProtectionPath);
    } catch {
      process.stdout.write(raw);
      process.exit(0);
    }

    if (mod && typeof mod.run === 'function') {
      let result;
      try {
        result = mod.run(raw, { truncated, maxStdin: MAX_STDIN });
      } catch {
        process.stdout.write(raw);
        process.exit(0);
      }

      if (typeof result === 'string') {
        process.stdout.write(result);
        process.exit(0);
      }
      if (result && typeof result === 'object') {
        if (result.stderr) {
          process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : result.stderr + '\n');
        }
        const exitCode = typeof result.exitCode === 'number' ? result.exitCode : 0;
        if (exitCode === 2) {
          process.exit(2);
        }
        if (Object.prototype.hasOwnProperty.call(result, 'stdout')) {
          process.stdout.write(String(result.stdout ?? ''));
        } else {
          process.stdout.write(raw);
        }
        process.exit(0);
      }
    }

    process.stdout.write(raw);
    process.exit(0);
  }

  // -------------------------------------------------------------------------
  // PostToolUse → run workflow-steering.js first (handles InvokeSubagents),
  //               then quality-gate.js
  //
  // The conformance runner checks stdout_contains for the workflow-steering
  // fixture so we must return the output of workflow-steering when it fires.
  // -------------------------------------------------------------------------

  if (hookEventName === 'posttooluse') {
    if (!runHookPath) {
      process.stdout.write(raw);
      process.exit(0);
    }

    // Run workflow-steering first — may inject EXECUTION COMPLETE for subagent calls
    const steeringResult = invokeViaSubprocess('workflow-steering', 'workflow-steering.js', raw);
    const steeringOut = steeringResult.stdout || '';
    if (steeringResult.stderr) process.stderr.write(steeringResult.stderr);

    // Then run quality-gate (always non-blocking, exit 0)
    // Use whatever output workflow-steering produced as input for quality-gate
    // so both hooks chain correctly.
    const steeringChainInput = steeringOut || raw;
    const qualityResult = invokeViaSubprocess('quality-gate', 'quality-gate.js', steeringChainInput);
    const qualityOut = qualityResult.stdout || '';
    if (qualityResult.stderr) process.stderr.write(qualityResult.stderr);

    // Return the final output (quality-gate output, which includes steering output)
    process.stdout.write(qualityOut || steeringOut || raw);
    process.exit(0);
  }

  // -------------------------------------------------------------------------
  // UserPromptSubmit → workflow-steering.js
  // -------------------------------------------------------------------------

  if (hookEventName === 'userpromptsubmit') {
    if (!runHookPath) {
      process.stdout.write(raw);
      process.exit(0);
    }

    const result = invokeViaSubprocess('workflow-steering', 'workflow-steering.js', raw);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (!result.stdout) process.stdout.write(raw);

    if (result.error || result.signal || result.status === null) {
      process.exit(0);
    }
    process.exit(typeof result.status === 'number' ? result.status : 0);
  }

  // -------------------------------------------------------------------------
  // Stop → stop-goal-fit.js
  // -------------------------------------------------------------------------

  if (hookEventName === 'stop') {
    if (!runHookPath) {
      process.stdout.write(raw);
      process.exit(0);
    }

    const result = invokeViaSubprocess('stop-goal-fit', 'stop-goal-fit.js', raw);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (!result.stdout) process.stdout.write(raw);

    if (result.error || result.signal || result.status === null) {
      process.exit(0);
    }
    process.exit(typeof result.status === 'number' ? result.status : 0);
  }

  // Unknown hook event — pass through
  process.stdout.write(raw);
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[conformance-shim] error: ${err.message}\n`);
  process.stdout.write('{}');
  process.exit(0);
});
