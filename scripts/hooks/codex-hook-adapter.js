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

async function main() {
  const [, , hookId, relScriptPath, profilesCsv] = process.argv;
  const { raw, truncated } = await readStdinRaw();
  const event = eventName(raw);

  if (!hookId || !relScriptPath) {
    const output = successOutput(event);
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
    return;
  }

  const runHookPath = path.resolve(__dirname, 'run-hook.js');
  const result = spawnSync(process.execPath, [runHookPath, hookId, relScriptPath, profilesCsv || ''], {
    input: raw,
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
  const output = successOutput(event, guidanceFromStdout(raw, result.stdout));
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
}

main().catch(err => {
  process.stderr.write(`[CodexHook] adapter error: ${err.message}\n`);
  process.exit(0);
});
