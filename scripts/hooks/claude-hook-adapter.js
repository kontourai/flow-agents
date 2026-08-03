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
 * ── Stop gets the same fix, with the loop fence Stop needs (issue #1172) ─────────────
 *
 * Stop was deliberately left on the old shape when #1005 landed, on the reasoning that it is
 * the one gate the policy permits to be inherently turn-ending and that goal-fit's own
 * block-streak release (the max-blocks hand-off) is what ends a run that cannot make
 * progress. Issue #1172's step-0 experiment measured what that reasoning actually produced:
 * because `continue: false` preempts `decision: "block"` (see the precedence note above), the
 * entire goal-fit remediation block — 250-800 tokens, repeated up to the max-blocks limit —
 * travelled in `stopReason`, which the contract shows to the USER and explicitly not to
 * Claude. Two headless control sessions confirmed it: with `continue: false` the model never
 * received the reason at all; without it, the model received the reason and acted on it. The
 * one gate whose message is written as model-facing remediation was the one gate structurally
 * unable to deliver it.
 *
 * A blocking Stop therefore now returns `decision: "block"` + `reason`, which IS fed back to
 * the model, so the agent can close the evidence gap in-session instead of the turn simply
 * ending. Turn-ending is preserved for exactly one case: the CONTINUATION firing. Claude Code
 * sets `stop_hook_active: true` on the Stop that fires because a previous Stop blocked, so a
 * hook that blocks AGAIN after the model has already been handed the reason once has
 * exhausted in-session self-correction, and the refusal goes to a human.
 *
 * That fence is load-bearing, not ceremony. goal-fit's release valve is deliberately
 * one-sided: an ordinary block auto-releases after FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS identical
 * refusals (exit 0 — never reaches this branch at all), but a HARD block — caught
 * false-completion, capture contradiction, tamper signal, integrity failure, or a canonical
 * Flow run that is still active — never auto-releases by design (stop-goal-fit.js's
 * `isHardBlock` branch keeps returning exit 2 forever). Dropping `continue: false`
 * unconditionally would let precisely that class re-prompt the model without bound. With the
 * fence, a hard block gets one self-correction attempt and then stops, which is what
 * "requires a real fix or operator override" was always meant to mean.
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

/**
 * Parse the raw hook payload once. Returns `{}` on malformed input so every reader below
 * degrades to "field absent" rather than throwing — a hook adapter must never fail closed on
 * a payload it could not read.
 */
function parseInput(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function eventFrom(input, fallback) {
  return input.hook_event_name || fallback || '';
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
  if (event === 'SessionStart' && context) {
    // #1172: no fallback banner. Announcing that hooks are active carries no decision value
    // for the model — it cannot act on it, and the hooks announce themselves by acting. When
    // a hook has real re-grounding context (workflow-steering's RESUME/STATE block) that
    // context is the whole payload; when it has none, SessionStart injects nothing.
    return {
      continue: true,
      suppressOutput: false,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context,
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
    // #1172: `decision`+`reason` is the model-facing channel; `continue:false`+`stopReason` is
    // the user-facing one, and `continue` wins when both are present. Emitting both meant the
    // remediation text only ever reached the user. First contact now carries the reason to the
    // model; only the continuation firing (`escalate`, see stopEndsTurn) ends the turn.
    return {
      decision: 'block',
      reason,
      ...(escalate ? { continue: false, stopReason: reason } : {}),
    };
  }
  // Unknown/unmodelled events (SubagentStop and anything a future runtime adds) keep the
  // conservative turn-ending shape: without an event-specific contract to reason about, the
  // safe default is that a block stops work rather than silently continuing it.
  return {
    decision: 'block',
    reason,
    continue: false,
    stopReason: reason,
  };
}

/**
 * True when a blocking Stop must end the turn rather than hand the reason back to the model.
 *
 * Claude Code sets `stop_hook_active: true` on a Stop that is firing because a previous Stop
 * blocked. So this is exactly "the model was already given this remediation once in this turn
 * and the gate still refuses" — in-session self-correction is exhausted, and the refusal
 * belongs in front of a human. See the header for why the fence is required rather than
 * optional (goal-fit's hard blocks never auto-release).
 */
function stopEndsTurn(input) {
  return input.stop_hook_active === true;
}

async function main() {
  const [, , eventArg = 'unknown', hookId, relScriptPath, profilesCsv] = process.argv;
  const { raw, truncated } = await readStdinRaw();
  const input = parseInput(raw);
  const event = eventFrom(input, eventArg);

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
    // Stop is not routed through the graduated-denial path: that path counts denial IDENTITIES
    // per flow step and reshapes the message as a refused TOOL CALL, neither of which fits a
    // Stop gate whose own hook already owns both the streak accounting and the message. Stop
    // keeps its hook's message verbatim and takes its turn-ending decision from the runtime's
    // own continuation signal instead (see stopEndsTurn / the header).
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
    process.stdout.write(`${JSON.stringify(blockedOutput(event, messageFrom(result), stopEndsTurn(input)))}\n`);
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
