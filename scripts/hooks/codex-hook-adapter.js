#!/usr/bin/env node
/**
 * Codex hook adapter.
 *
 * The canonical hook scripts in this repo were originally written for Kiro:
 * exit 0 passes through, exit 2 blocks, and stdout often echoes the hook input.
 * Codex has a stricter event-specific JSON contract, so this adapter runs the
 * canonical hook and translates its result into the Codex hook protocol.
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { extractExitCodeFromBanner, readExitCodeFromRollout } = require('./lib/codex-exit-code');

const MAX_STDIN = 1024 * 1024;

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

function eventName(raw) {
  try {
    return JSON.parse(raw).hook_event_name || '';
  } catch {
    return '';
  }
}

function messageFrom(result) {
  const stderr = String(result.stderr || '').trim();
  const stdout = String(result.stdout || '').trim();
  return stderr || stdout || 'Blocked by Flow Agents hook policy.';
}

function guidanceFromStdout(rawInput, stdout) {
  const text = String(stdout || '');
  if (!text.trim()) return '';
  const guidance = text.startsWith(rawInput) ? text.slice(rawInput.length) : text;
  return guidance.trim();
}

function successOutput(event, additionalContext = '') {
  const context = String(additionalContext || '').trim();
  if (event === 'SessionStart') {
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context || 'Flow Agents Codex hooks are active for this workspace.',
      },
    };
  }
  if (event === 'PostToolUse' && context) {
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: context,
      },
    };
  }
  if (event === 'UserPromptSubmit' && context) {
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: context,
      },
    };
  }
  if (event === 'UserPromptSubmit' || event === 'Stop') {
    return { continue: true };
  }
  return null;
}

function blockedOutput(event, reason) {
  if (event === 'PreToolUse') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    };
  }
  if (event === 'PermissionRequest') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'deny',
          message: reason,
        },
      },
    };
  }
  if (event === 'PostToolUse') {
    return {
      continue: false,
      stopReason: reason,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: reason,
      },
    };
  }
  return {
    decision: 'block',
    reason,
  };
}

/**
 * enrichEvidenceCapturePayload(raw, hookId, event) → string
 *
 * Codex-only, evidence-capture-only enrichment (#470): codex's PostToolUse
 * payload carries no structured exit code, so `evidence-capture.js`'s rule 3
 * (no signal) would otherwise fire on every codex command, including
 * genuinely failing ones. This injects a deterministic `tool_response.exitCode`
 * extracted from the codex host banner (`Process exited with code N`) BEFORE
 * the payload reaches evidence-capture, so capture stays host-agnostic and
 * never itself scans narration (docs/spec/runtime-hook-surface.md §2.5).
 *
 * Narrowly gated to hookId === 'evidence-capture' && event === 'PostToolUse'
 * so every other codex hook (quality-gate, workflow-steering, stop-goal-fit,
 * ...) is byte-unchanged. Fail-open: any parse error, missing field, or
 * missing/oversized/unreadable rollout returns `raw` unchanged — a hook must
 * never crash the agent, and a miss simply lets evidence-capture's own rule 3
 * (ambiguous default) apply.
 */
function enrichEvidenceCapturePayload(raw, hookId, event) {
  if (hookId !== 'evidence-capture' || event !== 'PostToolUse') return raw;
  try {
    const payload = JSON.parse(raw);
    if (!payload || typeof payload !== 'object') return raw;

    // Tier 1: a payload output field, if codex ever surfaces one directly
    // (cheap; observed absent on codex today — checked defensively).
    const outputFields = [
      payload.tool_response && payload.tool_response.output,
      payload.tool_response && payload.tool_response.stdout,
      payload.tool_output && payload.tool_output.output,
      payload.tool_output && payload.tool_output.stdout,
      payload.output,
    ];
    let exitCode = null;
    for (const field of outputFields) {
      if (typeof field !== 'string' || !field) continue;
      const found = extractExitCodeFromBanner(field);
      if (found !== null) { exitCode = found; break; }
    }

    // Tier 2: bounded tail read of the session rollout at transcript_path.
    if (exitCode === null && typeof payload.transcript_path === 'string' && payload.transcript_path) {
      // No documented codex field correlates a PostToolUse payload to a
      // rollout function_call_output's call_id today; try the plausible
      // candidates defensively and fall back to "last banner in the tail"
      // when none are present (see codex-exit-code.js doc comment). `command`
      // is passed alongside for the command cross-check correlation (Decision
      // B, #470 iteration 2): absent a call_id match, it lets the helper
      // decline (rather than mis-attribute) when the newest rollout banner's
      // paired call doesn't match the command that triggered this PostToolUse.
      const callId = payload.call_id || payload.tool_call_id || payload.id || null;
      const command = payload.tool_input && payload.tool_input.command;
      exitCode = readExitCodeFromRollout(payload.transcript_path, { callId, command });
    }

    if (exitCode === null) return raw;

    const existingResponse = payload.tool_response && typeof payload.tool_response === 'object'
      ? payload.tool_response
      : {};
    payload.tool_response = { ...existingResponse, exitCode };
    return JSON.stringify(payload);
  } catch {
    return raw; // fail-open: malformed payload or helper throw — pass through unchanged
  }
}

async function main() {
  const [, , hookId, relScriptPath, profilesCsv] = process.argv;
  const { raw, truncated } = await readStdinRaw();
  const event = eventName(raw);

  if (!hookId || !relScriptPath) {
    const output = successOutput(event);
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
    return;
  }

  // Enrich only the evidence-capture PostToolUse invocation with a structured
  // exit code extracted from the codex host banner (#470). `effectiveRaw` is
  // used for BOTH the spawn input and the stdout echo-diff below so the two
  // stay consistent (an enriched-vs-original mismatch would leak the raw JSON
  // as additionalContext via guidanceFromStdout).
  const effectiveRaw = enrichEvidenceCapturePayload(raw, hookId, event);

  const runHookPath = path.resolve(__dirname, 'run-hook.js');
  const result = spawnSync(process.execPath, [runHookPath, hookId, relScriptPath, profilesCsv || ''], {
    input: effectiveRaw,
    encoding: 'utf8',
    cwd: process.cwd(),
    env: {
      ...process.env,
      SA_HOOK_INPUT_TRUNCATED: truncated ? '1' : '0',
      SA_HOOK_INPUT_MAX_BYTES: String(MAX_STDIN),
      FLOW_AGENTS_HOOK_RUNTIME: 'codex',
    },
    timeout: Number(process.env.FLOW_AGENTS_CODEX_HOOK_TIMEOUT_MS || 30000),
  });

  if (result.status === 2) {
    process.stdout.write(`${JSON.stringify(blockedOutput(event, messageFrom(result)))}\n`);
    return;
  }

  if (result.error || result.signal || result.status === null) {
    const detail = result.error ? result.error.message : result.signal ? `signal ${result.signal}` : 'missing exit status';
    const output = successOutput(event);
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
    process.stderr.write(`[CodexHook] ${hookId} failed open: ${detail}\n`);
    return;
  }

  if (result.stderr) process.stderr.write(result.stderr);
  const output = successOutput(event, guidanceFromStdout(effectiveRaw, result.stdout));
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
}

main().catch(err => {
  process.stderr.write(`[CodexHook] adapter error: ${err.message}\n`);
  process.exit(0);
});
