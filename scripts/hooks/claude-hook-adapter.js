#!/usr/bin/env node
/**
 * Claude Code hook adapter for canonical Flow Agents hooks.
 *
 * Canonical hook scripts use the Kiro convention: exit 0 passes, exit 2 blocks,
 * and stderr/stdout carries human-readable guidance. Claude Code expects JSON
 * hook responses, so this wrapper translates policy blocks while failing open
 * for hook runtime errors.
 *
 * ── Graduated denial escalation (issue #1005) ────────────────────────────────
 *
 * A denied tool call must end THE CALL, not THE TURN. This adapter previously ended the
 * turn by mechanism: every PreToolUse and PostToolUse block emitted `continue: false`,
 * which in the Claude Code hook contract "stops Claude processing entirely after the hook
 * runs" and "takes precedence over any event-specific decision fields" — including the
 * `permissionDecision: "deny"` sitting right beside it. Worse, the reason travelled in
 * `stopReason`, which the contract shows to the USER and explicitly not to Claude. So the
 * model never saw why it was refused and never got the chance to route around: the agent
 * simply stopped mid-turn with no error and no artifact, which is precisely the stall
 * signature catalogued in #962.
 *
 * A deny WITHOUT `continue: false` is the recoverable form: the call is refused, and
 * `permissionDecisionReason` is fed back to the model, which reasons past it exactly like
 * a non-zero exit code or a 404. That is now the default for every denial.
 *
 * `continue: false` is reserved for the third occurrence of the SAME denial identity
 * (rule id + resolved target) within one flow step — see lib/denial-escalation.js. By
 * then the agent has been told the same thing three times inside one step, so the stall
 * is informative rather than noise and a human should see it.
 *
 * Stop keeps its existing contract untouched: it is the one gate the policy permits to be
 * inherently turn-ending, and its own block-streak release (goal-fit's max-blocks hand-off)
 * is what ends a run that cannot make progress.
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { buildDenialResponse } = require('./lib/denial-escalation');
const { resolveActor } = require('./lib/actor-identity');

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

/**
 * Actor key the denial streak is filed under. Resolution failure degrades to an
 * unscoped key rather than an exception — the counter must never break a denial.
 */
function safeActorKey() {
  try {
    return String((resolveActor() || {}).actor || '');
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
  if (event === 'PreToolUse' && context) {
    // #1099: a PreToolUse hook that ALLOWS but has something to say had no channel — the
    // guidance was computed and then dropped here, so the only way to be heard on this event was
    // to deny. That is precisely the pressure that turns an advisory into a block. Carried as
    // `additionalContext` and deliberately WITHOUT a `permissionDecision`: an explicit `allow`
    // would bypass the user's own permission rules as a side effect of wanting to print a line.
    return {
      continue: true,
      suppressOutput: false,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: context,
      },
    };
  }
  return { continue: true, suppressOutput: true };
}

function blockedOutput(event, reason, escalate = false) {
  if (event === 'PreToolUse') {
    return {
      // Only an escalated denial ends the turn. An ordinary refusal omits `continue`
      // entirely so the deny reason reaches the model and the agent can route around.
      ...(escalate ? { continue: false, stopReason: reason } : {}),
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    };
  }
  if (event === 'PostToolUse') {
    // The tool has already run; halting the turn here forfeits the work without
    // preventing anything. Surface the reason as context and let the agent respond.
    return {
      ...(escalate ? { continue: false, stopReason: reason } : {}),
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
    // Stop keeps its own contract (see header): it is not routed through the graduated
    // denial path, so its block message and turn-ending behaviour are unchanged.
    if (event === 'PreToolUse' || event === 'PostToolUse') {
      const denial = buildDenialResponse({
        hookId,
        message: messageFrom(result),
        cwd: process.cwd(),
        actorKey: safeActorKey(),
      });
      process.stdout.write(`${JSON.stringify(blockedOutput(event, denial.message, denial.escalate))}\n`);
      return;
    }
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
