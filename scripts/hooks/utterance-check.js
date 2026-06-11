#!/usr/bin/env node
/**
 * Utterance Check Hook — ADR 0003 §9 / survey integration.
 *
 * Optionally inspects agent output text for evidence coverage using
 * @kontourai/survey's surveyAgentUtterance. Injects badge guidance into the
 * agent context when concerning statements (unsupported/disputed/rejected) are
 * found.
 *
 * Activation is driven by per-repo policy in context/settings/flow-agents-settings.json:
 *
 *   {
 *     "schema_version": "1.0",
 *     "utteranceCheck": {
 *       "enabled": true,
 *       "mode": "report",         // "report" (default) or "strict"
 *       "extractor": "reference", // "reference" (default) or "anthropic"
 *       "bundlePath": "path/to/trust.bundle.json",
 *       "model": "claude-haiku-4-5",
 *       "agentId": "my-agent"
 *     }
 *   }
 *
 * Environment variable override (force-on / force-off):
 *   FLOW_AGENTS_UTTERANCE_CHECK_ENABLED=true   — force on regardless of config
 *   FLOW_AGENTS_UTTERANCE_CHECK_ENABLED=false  — force off regardless of config
 *
 * Other env vars still accepted as overrides (take precedence over config):
 *   FLOW_AGENTS_UTTERANCE_CHECK_STRICT=true
 *   FLOW_AGENTS_UTTERANCE_CHECK_BUNDLE_PATH=/path/to/bundle.json
 *   FLOW_AGENTS_UTTERANCE_CHECK_AGENT_ID=my-agent
 *   FLOW_AGENTS_UTTERANCE_CHECK_EXTRACTOR=anthropic
 *
 * Hook category: PostToolUse / Stop (non-blocking in report mode, always fails open).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MAX_STDIN = 1024 * 1024;
const CLI_TIMEOUT_MS = 30000;
// Maximum utterance text to pass to the CLI to keep stdin under MAX_STDIN.
const MAX_UTTERANCE_CHARS = 8192;

const SETTINGS_REL_PATH = path.join('context', 'settings', 'flow-agents-settings.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJson(raw) {
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

/**
 * Walk up from startDir to find the repo root.
 * Identified by having .git or AGENTS.md present.
 */
function findRepoRoot(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  const root = path.parse(dir).root;
  for (let depth = 0; depth < 40; depth++) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, 'AGENTS.md'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir || dir === root) break;
    dir = parent;
  }
  return path.resolve(startDir || process.cwd());
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
 * Load per-repo utteranceCheck policy from context/settings/flow-agents-settings.json.
 * Returns the utteranceCheck object (may be empty/undefined) or null if not found.
 */
function loadRepoConfig(repoRoot) {
  const settingsPath = path.join(repoRoot, SETTINGS_REL_PATH);
  try {
    if (!fs.existsSync(settingsPath)) return null;
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.utteranceCheck === 'object' ? parsed.utteranceCheck : null;
  } catch {
    return null;
  }
}

/**
 * Resolve effective hook policy, merging repo config with env var overrides.
 * Priority (highest first): env var overrides > repo config > built-in defaults.
 */
function resolvePolicy(repoRoot) {
  const repoConfig = loadRepoConfig(repoRoot) || {};

  // Env var override: FLOW_AGENTS_UTTERANCE_CHECK_ENABLED forces on/off.
  const envEnabled = process.env.FLOW_AGENTS_UTTERANCE_CHECK_ENABLED;
  let enabled;
  if (envEnabled === 'true') {
    enabled = true;
  } else if (envEnabled === 'false') {
    enabled = false;
  } else {
    // Primary switch is the repo config; default is disabled.
    enabled = repoConfig.enabled === true;
  }

  if (!enabled) return { enabled: false };

  // mode: repo config → default "report"
  let mode = repoConfig.mode === 'strict' ? 'strict' : 'report';
  // Env var override for strict
  if (String(process.env.FLOW_AGENTS_UTTERANCE_CHECK_STRICT || '').toLowerCase() === 'true') {
    mode = 'strict';
  }

  // extractor: repo config → default "reference"
  let extractor = repoConfig.extractor === 'anthropic' ? 'anthropic' : 'reference';
  // Env var override for extractor
  const envExtractor = process.env.FLOW_AGENTS_UTTERANCE_CHECK_EXTRACTOR;
  if (envExtractor === 'anthropic') extractor = 'anthropic';
  else if (envExtractor === 'reference') extractor = 'reference';

  // bundlePath: env var override > repo config
  let bundlePath = process.env.FLOW_AGENTS_UTTERANCE_CHECK_BUNDLE_PATH || repoConfig.bundlePath || '';
  // Resolve repo-relative bundle paths
  if (bundlePath && !path.isAbsolute(bundlePath)) {
    bundlePath = path.join(repoRoot, bundlePath);
  }

  // agentId: env var override > repo config
  const agentId =
    process.env.FLOW_AGENTS_UTTERANCE_CHECK_AGENT_ID ||
    repoConfig.agentId ||
    'flow-agents-hook';

  // model: repo config only (no env var for now)
  const model = repoConfig.model || '';

  return { enabled, mode, extractor, bundlePath, agentId, model };
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
  let input;
  try { input = JSON.parse(rawInput || '{}'); } catch { return rawInput; }

  // Resolve repo root from hook input (Claude Code passes cwd in event).
  const repoRoot = findRepoRoot(input.cwd || process.cwd());
  const policy = resolvePolicy(repoRoot);

  if (!policy.enabled) return rawInput;

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

  if (policy.bundlePath) cliArgs.push('--bundle-path', policy.bundlePath);
  cliArgs.push('--agent-id', policy.agentId);
  if (policy.extractor === 'anthropic') cliArgs.push('--extractor', 'anthropic');
  if (policy.model) cliArgs.push('--model', policy.model);
  if (policy.mode === 'strict') cliArgs.push('--strict');

  const result = spawnSync(process.execPath, [cliPath, ...cliArgs], {
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
    cwd: repoRoot,
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

  if (policy.mode === 'strict' && result.status === 2) {
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

module.exports = { run, extractUtteranceText, findPackageRoot, findRepoRoot, loadRepoConfig, resolvePolicy };
