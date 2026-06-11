#!/usr/bin/env node
/**
 * Utterance Check Hook — ADR 0003 §9 / survey integration.
 *
 * Optionally inspects agent output text for evidence coverage using
 * @kontourai/survey's surveyAgentUtterance. Injects badge guidance into the
 * agent context when concerning statements (unsupported/disputed/rejected) are
 * found.
 *
 * Disabled by default. Enable with:
 *   FLOW_AGENTS_UTTERANCE_CHECK_ENABLED=true
 *
 * Hook category: PostToolUse / Stop (non-blocking, always exits 0).
 *
 * Strict mode (blocks Stop when concerning badges present):
 *   FLOW_AGENTS_UTTERANCE_CHECK_STRICT=true
 *
 * Bundle path (optional trust bundle for claim resolution):
 *   FLOW_AGENTS_UTTERANCE_CHECK_BUNDLE_PATH=/path/to/bundle.json
 *
 * Agent ID (for provenance):
 *   FLOW_AGENTS_UTTERANCE_CHECK_AGENT_ID=my-agent
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MAX_STDIN = 1024 * 1024;
const CLI_TIMEOUT_MS = 30000;
// Maximum utterance text to pass to the CLI to keep stdin under MAX_STDIN.
const MAX_UTTERANCE_CHARS = 8192;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJson(raw) {
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

/**
 * Walk up from startDir to find the flow-agents package root.
 * Identified by having both package.json and build/src/cli.js present.
 */
function findPackageRoot(startDir) {
  let dir = path.resolve(startDir || __dirname);
  for (let depth = 0; depth < 10; depth++) {
    if (
      fs.existsSync(path.join(dir, 'package.json')) &&
      fs.existsSync(path.join(dir, 'build', 'src', 'cli.js'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: assume hooks dir is scripts/hooks/, so root is two levels up.
  return path.resolve(__dirname, '..', '..');
}

/**
 * Extract agent utterance text from the hook event input.
 * - PostToolUse: tool_response or tool_output field
 * - Stop: stop_reason or agent_message field (varies by harness)
 * - Fallback: returns null (hook passes through)
 */
function extractUtteranceText(input) {
  if (!input || typeof input !== 'object') return null;

  // PostToolUse: agent output is in tool_response or tool_output
  const resp = input.tool_response || input.tool_output;
  if (typeof resp === 'string' && resp.trim()) return resp.trim();

  // Stop: some harnesses expose agent message content
  const agentMsg = input.agent_message || input.message;
  if (typeof agentMsg === 'string' && agentMsg.trim()) return agentMsg.trim();

  // Stop with content array (Claude Code format)
  if (Array.isArray(input.content)) {
    const texts = input.content
      .filter(b => b && b.type === 'text' && typeof b.text === 'string')
      .map(b => String(b.text).trim())
      .filter(Boolean);
    if (texts.length > 0) return texts.join('\n\n');
  }

  return null;
}

function safeOneLineExcerpt(text, max = 120) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

// ---------------------------------------------------------------------------
// Hook runner
// ---------------------------------------------------------------------------

function run(rawInput) {
  const enabled = String(process.env.FLOW_AGENTS_UTTERANCE_CHECK_ENABLED || '').toLowerCase() === 'true';
  if (!enabled) return rawInput;

  let input;
  try { input = JSON.parse(rawInput || '{}'); } catch { return rawInput; }

  const utteranceText = extractUtteranceText(input);
  if (!utteranceText) return rawInput;

  // Truncate very long utterances before passing to CLI.
  const utterance = utteranceText.length > MAX_UTTERANCE_CHARS
    ? utteranceText.slice(0, MAX_UTTERANCE_CHARS)
    : utteranceText;

  const packageRoot = findPackageRoot(__dirname);
  const cliPath = path.join(packageRoot, 'build', 'src', 'cli.js');

  if (!fs.existsSync(cliPath)) {
    process.stderr.write(
      `[UtteranceCheck] CLI not found at ${cliPath}. Run npm run build in the flow-agents checkout.\n`
    );
    return rawInput;
  }

  const cliArgs = ['utterance-check', 'check', '--utterance', utterance];

  const bundlePath = process.env.FLOW_AGENTS_UTTERANCE_CHECK_BUNDLE_PATH;
  if (bundlePath) cliArgs.push('--bundle-path', bundlePath);

  const agentId = process.env.FLOW_AGENTS_UTTERANCE_CHECK_AGENT_ID || 'flow-agents-hook';
  cliArgs.push('--agent-id', agentId);

  const strict = String(process.env.FLOW_AGENTS_UTTERANCE_CHECK_STRICT || '').toLowerCase() === 'true';
  if (strict) cliArgs.push('--strict');

  const result = spawnSync(process.execPath, [cliPath, ...cliArgs], {
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
    cwd: packageRoot,
    env: { ...process.env },
  });

  if (result.error || result.signal || result.status === null) {
    const detail = result.error
      ? result.error.message
      : result.signal
        ? `signal ${result.signal}`
        : 'missing exit status';
    process.stderr.write(`[UtteranceCheck] CLI execution failed (failing open): ${detail}\n`);
    return rawInput;
  }

  // Parse the JSON report from stdout.
  let report = null;
  try { report = JSON.parse(String(result.stdout || '').trim()); } catch { /* pass through */ }

  if (result.stderr) {
    process.stderr.write(String(result.stderr));
  }

  if (!report) return rawInput;

  // If survey is not configured, pass through silently.
  if (report.status === 'not_configured') return rawInput;

  // Build guidance text from the badge report.
  const statements = Array.isArray(report.statements) ? report.statements : [];
  const concerning = statements.filter(s =>
    s && (s.badge === 'unsupported' || s.badge === 'disputed' || s.badge === 'rejected')
  );

  if (concerning.length === 0) return rawInput;

  const lines = [
    `UTTERANCE CHECK: ${concerning.length} statement(s) in this response lack evidence coverage.`,
    `Summary: ${report.summary || 'unknown'}`,
    ...concerning.slice(0, 4).map(s =>
      `  - [${s.badge}] "${safeOneLineExcerpt(s.excerpt)}"`
    ),
    'Evidence note: unsupported = no matching claim in the trust bundle; disputed = conflicting evidence; rejected = claim was rejected.',
    'Cite sources, note gaps, or run survey-utterance-check to record coverage.',
  ];

  // For PostToolUse: append guidance to the raw input as additional context.
  // For Stop: report to stderr (non-blocking warning) unless strict mode.
  const event = input.hook_event_name || '';
  const guidance = '\n\n---\n' + lines.join('\n') + '\n---';

  if (strict && result.status === 2) {
    return {
      stdout: rawInput,
      stderr: lines.join('\n'),
      exitCode: 2,
    };
  }

  if (event === 'PostToolUse') {
    return rawInput + guidance;
  }

  process.stderr.write(`[UtteranceCheck] ${lines.join('\n')}\n`);
  return rawInput;
}

if (require.main === module) {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (data.length < MAX_STDIN) data += chunk.substring(0, MAX_STDIN - data.length);
  });
  process.stdin.on('end', () => {
    const output = run(data);
    if (output && typeof output === 'object') {
      if (output.stderr) process.stderr.write(output.stderr.endsWith('\n') ? output.stderr : `${output.stderr}\n`);
      process.stdout.write(String(output.stdout ?? data));
      process.exit(Number.isInteger(output.exitCode) ? output.exitCode : 0);
    }
    process.stdout.write(String(output));
  });
}

module.exports = { run, extractUtteranceText, findPackageRoot };
