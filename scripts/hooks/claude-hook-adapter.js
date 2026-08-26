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
 * ending. Turn-ending is not removed, it is moved to where it belongs — and which "where" that
 * is depends on whether the gate can release the block itself:
 *
 *   SOFT block: the adapter NEVER ends the turn. stop-goal-fit.js already owns termination for
 *     this class — after FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS identical refusals its valve fires,
 *     clears the streak and returns exit 0, which never reaches this branch at all. An adapter
 *     fence here would truncate that valve to fewer refusals than the gate advertises and turn
 *     its own promise ("after N identical blocks I stop blocking and hand this to you") into a
 *     false statement. Letting it run is the fix, not a gap.
 *
 *   HARD block (non-releasable — caught false-completion, capture contradiction, tamper
 *     signal, integrity failure, canonical Flow still active): goal-fit's `isHardBlock` branch
 *     returns exit 2 forever, by design. This class has no termination of its own, so the
 *     adapter supplies one: end the turn on the CONTINUATION firing, i.e. when Claude Code
 *     sets `stop_hook_active: true` because a previous Stop blocked. One self-correction
 *     attempt, then a human — which is what "requires a real fix or operator override" means.
 *
 * The adapter learns which class it is holding from a structured control line the hook emits,
 * not from matching its prose; see scripts/hooks/lib/stop-escalation.js for that contract. An
 * absent or malformed line reads as SOFT, because a false "terminal" would truncate the valve.
 *
 * Underneath both sits a runtime-agnostic backstop: a per-actor count of CONSECUTIVE blocking
 * Stops that forces the turn to end at DEFAULT_MAX_STOP_BLOCKS regardless of marker or runtime
 * signal. It exists because `stop_hook_active` is observed in live payloads but is no longer
 * listed in the published hooks reference — if a runtime stops sending it, the hard-block path
 * above silently loses its only termination. The threshold sits above goal-fit's soft valve, so
 * on the normal path the gate's own release always fires first and the backstop is invisible.
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { buildDenialResponse } = require('./lib/denial-escalation');
const { extractEnvDefaults, applyEnvDefaults } = require('./lib/env-defaults');
const { resolveActor } = require('./lib/actor-identity');
const { parseStopControl, stripStopControl, recordStopBlock, clearStopBlocks, stopTurnDecision } = require('./lib/stop-escalation');

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
    // remediation text only ever reached the user. The reason now always reaches the model;
    // `escalate` is resolveStopBlock's verdict and is the ONLY thing that ends the turn.
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
 * Repo the Stop streak is filed against.
 *
 * The payload's own `cwd` is authoritative for the session and is what every canonical hook
 * already grounds on (`findRepoRoot(input.cwd || process.cwd())`), so the streak lands beside
 * the state the block is about rather than beside whatever directory the harness happened to
 * launch the adapter from.
 */
function stopStoreCwd(input) {
  const cwd = typeof input.cwd === 'string' ? input.cwd.trim() : '';
  return cwd || process.cwd();
}

/**
 * Resolve a blocking Stop into the agent-facing message plus the turn-ending decision.
 *
 * Counting the block is a side effect of holding one, so it happens here rather than at the
 * call site: every blocking Stop advances the backstop streak exactly once. Storage failures
 * degrade to "never escalates" inside the lib — they can never suppress the block itself.
 */
function resolveStopBlock(input, rawMessage) {
  const control = parseStopControl(rawMessage);
  const message = stripStopControl(rawMessage) || rawMessage;
  const streak = recordStopBlock({ cwd: stopStoreCwd(input), actorKey: safeActorKey() });
  const decision = stopTurnDecision({ control, stopHookActive: input.stop_hook_active === true, streak });
  return {
    message: decision.note ? `${message}\n${decision.note}` : message,
    endTurn: decision.endTurn,
  };
}

async function main() {
  const { argv, defaults: envDefaults } = extractEnvDefaults(process.argv);
  const [, , eventArg = 'unknown', hookId, relScriptPath, profilesCsv] = argv;
  const { raw, truncated } = await readStdinRaw();
  const input = parseInput(raw);
  const event = eventFrom(input, eventArg);

  // #1172: a new session must not inherit the previous one's Stop strikes. Done before the hook
  // runs, and on every SessionStart invocation (several hooks fire on it), so the reset does not
  // depend on any one hook succeeding. Idempotent.
  if (event === 'SessionStart') clearStopBlocks({ cwd: stopStoreCwd(input), actorKey: safeActorKey() });

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
      ...applyEnvDefaults(process.env, envDefaults),
      SA_HOOK_INPUT_TRUNCATED: truncated ? '1' : '0',
      SA_HOOK_INPUT_MAX_BYTES: String(MAX_STDIN),
      FLOW_AGENTS_HOOK_RUNTIME: 'claude-code',
    },
    timeout: Number(process.env.FLOW_AGENTS_CLAUDE_HOOK_TIMEOUT_MS || 30000),
  });

  if (result.status === 2) {
    // Stop is not routed through the graduated-denial path: that path counts denial IDENTITIES
    // per flow step and reshapes the message as a refused TOOL CALL, neither of which fits a
    // Stop gate that owns its own remediation text. Stop keeps its hook's message verbatim and
    // takes its turn-ending decision from resolveStopBlock (see the header).
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
    if (event === 'Stop') {
      const stop = resolveStopBlock(input, messageFrom(result));
      process.stdout.write(`${JSON.stringify(blockedOutput(event, stop.message, stop.endTurn))}\n`);
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

  // #1172: the streak counts CONSECUTIVE blocking Stops. A Stop that does not block means the
  // obligation cleared (or the gate's own valve released it), so the count starts over.
  if (event === 'Stop') clearStopBlocks({ cwd: stopStoreCwd(input), actorKey: safeActorKey() });

  if (result.stderr) process.stderr.write(result.stderr);
  process.stdout.write(`${JSON.stringify(successOutput(event, guidanceFromStdout(raw, result.stdout)))}\n`);
}

main().catch(err => {
  process.stderr.write(`[ClaudeHook] adapter error: ${err.message}\n`);
  process.exit(0);
});
