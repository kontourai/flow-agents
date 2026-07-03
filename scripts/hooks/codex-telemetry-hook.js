#!/usr/bin/env node
/**
 * Codex telemetry hook wrapper.
 *
 * Codex command hooks are stricter than Kiro hooks. This wrapper runs the
 * canonical telemetry script with Codex-safe environment overrides, then emits
 * a valid hook response for lifecycle events. Telemetry runs in the background
 * by default so PostToolUse hooks do not stall the chat loop.
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const MAX_STDIN = 1024 * 1024;
const DEFAULT_FULL_REDACT = 'hook.raw_input,turn.prompt_text,tool.input,tool.output';

function readStdinRaw() {
  return new Promise(resolve => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      if (raw.length < MAX_STDIN) {
        raw += chunk.slice(0, MAX_STDIN - raw.length);
      }
    });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', () => resolve(raw));
  });
}

function hookEventName(raw) {
  try {
    return JSON.parse(raw).hook_event_name || '';
  } catch {
    return '';
  }
}

function codexSuccessOutput(event, conflict) {
  if (event === 'SessionStart') {
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'Flow Agents telemetry hooks are active for this session.',
      },
    };
  }
  // Mid-turn conflict injection (issue #320, AC4): fold a detected liveness conflict into the
  // real hookSpecificOutput.additionalContext channel on PostToolUse, matching the precedent
  // codex-hook-adapter.js:69-77 already establishes for policy hooks. Guarded on a well-formed
  // `conflict` shape so a malformed value degrades to the unchanged fixed no-conflict output
  // below, never a thrown error (AC8, fail-open). Subject to the "Codex live hook influence"
  // caveat (docs/spec/runtime-hook-surface.md §2.1): the wrapper still emits this; effectiveness
  // is a separate, already-tracked residual.
  if (
    event === 'PostToolUse' &&
    conflict &&
    typeof conflict.actor === 'string' &&
    typeof conflict.lastAt === 'string'
  ) {
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `[LIVENESS CONFLICT] actor "${conflict.actor}" claimed this subject at "${conflict.lastAt}" — run \`liveness verdict\` and coordinate.`,
      },
    };
  }
  if (event === 'UserPromptSubmit' || event === 'Stop') {
    return { continue: true };
  }
  return null;
}

async function main() {
  const [, , eventType = 'unknown', agentName = 'dev'] = process.argv;
  const raw = await readStdinRaw();
  const event = hookEventName(raw);
  const telemetryScript = path.resolve(__dirname, '..', 'telemetry', 'telemetry.sh');

  let conflict;
  if (eventType === 'PostToolUse') {
    try {
      const heartbeatResult = require('./lib/liveness-heartbeat').maybeEmitHeartbeat({
        cwd: process.cwd(),
        env: process.env,
      });
      conflict = heartbeatResult && heartbeatResult.conflict;
    } catch (err) {
      process.stderr.write(`[CodexTelemetryHook] liveness heartbeat error: ${err.message}\n`);
    }
  }

  const result = spawnSync('bash', [telemetryScript, eventType, agentName], {
    input: raw,
    encoding: 'utf8',
    cwd: process.cwd(),
    env: {
      ...process.env,
      FLOW_AGENTS_TELEMETRY_RUNTIME: 'codex',
      FLOW_AGENTS_TELEMETRY_FOREGROUND: process.env.FLOW_AGENTS_CODEX_TELEMETRY_FOREGROUND || 'false',
      TELEMETRY_CHANNELS: process.env.FLOW_AGENTS_CODEX_TELEMETRY_CHANNELS || 'full,analytics',
      TELEMETRY_CHANNEL_FULL_REDACT: process.env.TELEMETRY_CHANNEL_FULL_REDACT || DEFAULT_FULL_REDACT,
      TELEMETRY_CHANNEL_ANALYTICS_REDACT:
        process.env.TELEMETRY_CHANNEL_ANALYTICS_REDACT ||
        'tool.input,tool.output,turn.prompt_text,delegation.targets.query,context.cwd,hook.raw_input',
      TELEMETRY_CHANNEL_FULL_ENDPOINT_URL: process.env.TELEMETRY_CHANNEL_FULL_ENDPOINT_URL || '',
      TELEMETRY_USAGE_TRACKING: process.env.TELEMETRY_USAGE_TRACKING || 'true',
    },
    timeout: Number(process.env.FLOW_AGENTS_CODEX_TELEMETRY_TIMEOUT_MS || 30000),
  });

  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.signal || result.status === null) {
    const detail = result.error ? result.error.message : result.signal ? `signal ${result.signal}` : 'missing exit status';
    process.stderr.write(`[CodexTelemetryHook] failed open: ${detail}\n`);
  }

  const output = codexSuccessOutput(event, conflict);
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
}

main().catch(err => {
  process.stderr.write(`[CodexTelemetryHook] wrapper error: ${err.message}\n`);
  process.exit(0);
});
