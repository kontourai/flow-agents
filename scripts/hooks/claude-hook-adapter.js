#!/usr/bin/env node
/**
 * Claude Code hook adapter for canonical Flow Agents hooks.
 *
 * Canonical hook scripts use the Kiro convention: exit 0 passes, exit 2 blocks,
 * and stderr/stdout carries human-readable guidance. Claude Code expects JSON
 * hook responses, so this wrapper translates policy blocks while failing open
 * for hook runtime errors.
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

function parseEvent(raw, fallback) {
  try {
    return JSON.parse(raw || '{}').hook_event_name || fallback || '';
  } catch {
    return fallback || '';
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
      suppressOutput: !context,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context || 'Flow Agents hooks are active for this Claude Code session.',
      },
    };
  }
  if (event === 'PostToolUse' && context) {
    return {
      continue: true,
      suppressOutput: false,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: context,
      },
    };
  }
  if (event === 'UserPromptSubmit' && context) {
    return {
      continue: true,
      suppressOutput: false,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: context,
      },
    };
  }
  return { continue: true, suppressOutput: true };
}

function blockedOutput(event, reason) {
  if (event === 'PreToolUse') {
    return {
      continue: false,
      stopReason: reason,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
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
  if (event === 'Stop') {
    return {
      decision: 'block',
      reason,
      continue: false,
      stopReason: reason,
    };
  }
  return {
    decision: 'block',
    reason,
    continue: false,
    stopReason: reason,
  };
}

async function main() {
  const [, , eventArg = 'unknown', hookId, relScriptPath, profilesCsv] = process.argv;
  const { raw, truncated } = await readStdinRaw();
  const event = parseEvent(raw, eventArg);

  if (!hookId || !relScriptPath) {
    process.stdout.write(`${JSON.stringify(successOutput(event))}\n`);
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
      FLOW_AGENTS_HOOK_RUNTIME: 'claude-code',
    },
    timeout: Number(process.env.FLOW_AGENTS_CLAUDE_HOOK_TIMEOUT_MS || 30000),
  });

  if (result.status === 2) {
    process.stdout.write(`${JSON.stringify(blockedOutput(event, messageFrom(result)))}\n`);
    return;
  }

  if (result.error || result.signal || result.status === null) {
    const detail = result.error ? result.error.message : result.signal ? `signal ${result.signal}` : 'missing exit status';
    process.stderr.write(`[ClaudeHook] ${hookId} failed open: ${detail}\n`);
    process.stdout.write(`${JSON.stringify(successOutput(event))}\n`);
    return;
  }

  if (result.stderr) process.stderr.write(result.stderr);
  process.stdout.write(`${JSON.stringify(successOutput(event, guidanceFromStdout(raw, result.stdout)))}\n`);
}

main().catch(err => {
  process.stderr.write(`[ClaudeHook] adapter error: ${err.message}\n`);
  process.exit(0);
});
