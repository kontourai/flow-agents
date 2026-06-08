#!/usr/bin/env node
/**
 * Claude Code telemetry hook wrapper.
 *
 * Claude Code hooks send JSON on stdin and accept a permissive JSON response
 * for lifecycle hooks. This wrapper adapts Claude hook events to the canonical
 * Flow Agents telemetry script and stays fail-open so telemetry cannot block work.
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

function parseJson(raw) {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

function canonicalEvent(cliEvent, payload) {
  const event = cliEvent || payload.hook_event_name || 'unknown';
  const mapping = {
    SessionStart: 'agentSpawn',
    UserPromptSubmit: 'userPromptSubmit',
    PreToolUse: 'preToolUse',
    PermissionRequest: 'permissionRequest',
    PostToolUse: 'postToolUse',
    PostToolUseFailure: 'postToolUse',
    Stop: 'stop',
    SessionEnd: 'stop',
    SubagentStart: 'subagentStart',
    SubagentStop: 'subagentStop',
  };
  return mapping[event] || event;
}

function claudeSuccessOutput(event) {
  if (event === 'SessionStart') {
    return {
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'Flow Agents telemetry hooks are active for this Claude Code session.',
      },
    };
  }
  if (event === 'UserPromptSubmit') {
    return { continue: true, suppressOutput: true };
  }
  if (event === 'Stop' || event === 'SubagentStop' || event === 'SessionEnd') {
    return { continue: true, suppressOutput: true };
  }
  return { continue: true, suppressOutput: true };
}

async function main() {
  const [, , eventArg = 'unknown', agentName = 'dev'] = process.argv;
  const raw = await readStdinRaw();
  const payload = parseJson(raw);
  const hookEvent = payload.hook_event_name || eventArg;
  const telemetryScript = path.resolve(__dirname, '..', 'telemetry', 'telemetry.sh');

  const result = spawnSync('bash', [telemetryScript, canonicalEvent(eventArg, payload), agentName], {
    input: raw,
    encoding: 'utf8',
    cwd: process.cwd(),
    env: {
      ...process.env,
      FLOW_AGENTS_TELEMETRY_RUNTIME: 'claude-code',
      FLOW_AGENTS_TELEMETRY_FOREGROUND: process.env.FLOW_AGENTS_CLAUDE_TELEMETRY_FOREGROUND || 'false',
      TELEMETRY_CHANNELS: process.env.FLOW_AGENTS_CLAUDE_TELEMETRY_CHANNELS || 'full,analytics',
      TELEMETRY_CHANNEL_FULL_REDACT: process.env.TELEMETRY_CHANNEL_FULL_REDACT || DEFAULT_FULL_REDACT,
      TELEMETRY_CHANNEL_ANALYTICS_REDACT:
        process.env.TELEMETRY_CHANNEL_ANALYTICS_REDACT ||
        'tool.input,tool.output,turn.prompt_text,delegation.targets.query,context.cwd,hook.raw_input',
      TELEMETRY_CHANNEL_FULL_ENDPOINT_URL: process.env.TELEMETRY_CHANNEL_FULL_ENDPOINT_URL || '',
      TELEMETRY_USAGE_TRACKING: process.env.TELEMETRY_USAGE_TRACKING || 'true',
    },
    timeout: Number(process.env.FLOW_AGENTS_CLAUDE_TELEMETRY_TIMEOUT_MS || 30000),
  });

  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.signal || result.status === null) {
    const detail = result.error ? result.error.message : result.signal ? `signal ${result.signal}` : 'missing exit status';
    process.stderr.write(`[ClaudeTelemetryHook] failed open: ${detail}\n`);
  }

  process.stdout.write(`${JSON.stringify(claudeSuccessOutput(hookEvent))}\n`);
}

main().catch(err => {
  process.stderr.write(`[ClaudeTelemetryHook] wrapper error: ${err.message}\n`);
  process.exit(0);
});
