#!/usr/bin/env node
/**
 * opencode telemetry hook wrapper.
 *
 * Called by the generated .opencode/plugins/flow-agents.js plugin when it
 * shells out for telemetry recording. This wrapper adapts opencode plugin
 * event payloads to the canonical Flow Agents telemetry script and stays
 * fail-open so telemetry cannot block work.
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
    'session.created': 'agentSpawn',
    'session.idle': 'stop',
    'session.error': 'stop',
    'session.compacted': 'stop',
    'tool.execute.before': 'preToolUse',
    'tool.execute.after': 'postToolUse',
    'permission.asked': 'permissionRequest',
    'permission.replied': 'permissionRequest',
    'file.edited': 'postToolUse',
    'message.updated': 'postToolUse',
    'command.executed': 'postToolUse',
    'input': 'userPromptSubmit',
    agentSpawn: 'agentSpawn',
    userPromptSubmit: 'userPromptSubmit',
    preToolUse: 'preToolUse',
    postToolUse: 'postToolUse',
    stop: 'stop',
  };
  return mapping[event] || event;
}

async function main() {
  const [, , eventArg = 'unknown', agentName = 'dev'] = process.argv;
  const raw = await readStdinRaw();
  const payload = parseJson(raw);
  const canonical = canonicalEvent(eventArg, payload);
  const telemetryScript = path.resolve(__dirname, '..', 'telemetry', 'telemetry.sh');

  if (canonical === 'postToolUse') {
    try {
      require('./lib/liveness-heartbeat').maybeEmitHeartbeat({ cwd: process.cwd(), env: process.env });
    } catch (err) {
      process.stderr.write(`[OpencodeTelemetryHook] liveness heartbeat error: ${err.message}\n`);
    }
  }

  const result = spawnSync('bash', [telemetryScript, canonical, agentName], {
    input: raw,
    encoding: 'utf8',
    cwd: process.cwd(),
    env: {
      ...process.env,
      FLOW_AGENTS_TELEMETRY_RUNTIME: 'opencode',
      FLOW_AGENTS_TELEMETRY_FOREGROUND: process.env.FLOW_AGENTS_OPENCODE_TELEMETRY_FOREGROUND || 'false',
      TELEMETRY_CHANNELS: process.env.FLOW_AGENTS_OPENCODE_TELEMETRY_CHANNELS || 'full,analytics',
      TELEMETRY_CHANNEL_FULL_REDACT: process.env.TELEMETRY_CHANNEL_FULL_REDACT || DEFAULT_FULL_REDACT,
      TELEMETRY_CHANNEL_ANALYTICS_REDACT:
        process.env.TELEMETRY_CHANNEL_ANALYTICS_REDACT ||
        'tool.input,tool.output,turn.prompt_text,delegation.targets.query,context.cwd,hook.raw_input',
      TELEMETRY_CHANNEL_FULL_ENDPOINT_URL: process.env.TELEMETRY_CHANNEL_FULL_ENDPOINT_URL || '',
      TELEMETRY_USAGE_TRACKING: process.env.TELEMETRY_USAGE_TRACKING || 'true',
    },
    timeout: Number(process.env.FLOW_AGENTS_OPENCODE_TELEMETRY_TIMEOUT_MS || 30000),
  });

  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.signal || result.status === null) {
    const detail = result.error ? result.error.message : result.signal ? `signal ${result.signal}` : 'missing exit status';
    process.stderr.write(`[OpencodeTelemetryHook] failed open: ${detail}\n`);
  }
  // opencode plugin calls this as a subprocess; just exit 0 for success
}

main().catch(err => {
  process.stderr.write(`[OpencodeTelemetryHook] wrapper error: ${err.message}\n`);
  process.exit(0);
});
