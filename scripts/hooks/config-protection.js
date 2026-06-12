#!/usr/bin/env node
/**
 * Config Protection Hook
 *
 * Blocks modifications to linter/formatter config files.
 * Steers the agent to fix source code instead of weakening configs.
 *
 * Also blocks git verification-bypass flags in actual flag positions only.
 * Text that merely mentions the flag inside quoted strings or prose is allowed.
 *
 * Exit codes: 0 = allow, 2 = block
 */

'use strict';

const path = require('path');

const MAX_STDIN = 1024 * 1024;

const PROTECTED_FILES = new Set([
  '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml',
  'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', 'eslint.config.mts', 'eslint.config.cts',
  '.prettierrc', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.json', '.prettierrc.yml', '.prettierrc.yaml',
  'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs',
  'biome.json', 'biome.jsonc',
  '.ruff.toml', 'ruff.toml',
  '.shellcheckrc', '.stylelintrc', '.stylelintrc.json', '.stylelintrc.yml',
  '.markdownlint.json', '.markdownlint.yaml', '.markdownlintrc',
]);

// ---------------------------------------------------------------------------
// Shell-aware tokenizer
//
// Splits a shell command string into tokens, respecting single/double quotes
// and backslash escapes.  Quoted content stays inside its parent token so
// flag text inside a -m argument string is never matched as a flag.
// ---------------------------------------------------------------------------

/**
 * tokenize(cmd) -- shell-aware tokenizer for a single command segment.
 * Returns an array of unquoted token strings.
 */
function tokenize(cmd) {
  const tokens = [];
  let i = 0;
  const len = cmd.length;

  while (i < len) {
    // Skip whitespace between tokens.
    while (i < len && /\s/.test(cmd[i])) i++;
    if (i >= len) break;

    let token = '';

    // Consume one token -- stop at unquoted whitespace.
    while (i < len) {
      const ch = cmd[i];

      if (ch === '\\') {
        // Backslash escape outside of quotes.
        i++;
        if (i < len) token += cmd[i++];
      } else if (ch === "'") {
        // Single-quoted string: no escape processing, read until closing quote.
        i++;
        while (i < len && cmd[i] !== "'") token += cmd[i++];
        i++; // consume closing quote
      } else if (ch === '"') {
        // Double-quoted string: honour \" and \\ escape sequences.
        i++;
        while (i < len && cmd[i] !== '"') {
          if (cmd[i] === '\\' && i + 1 < len && (cmd[i + 1] === '"' || cmd[i + 1] === '\\')) {
            i++; // skip the backslash
            token += cmd[i++];
          } else {
            token += cmd[i++];
          }
        }
        i++; // consume closing quote
      } else if (/\s/.test(ch)) {
        break; // end of token
      } else {
        token += ch;
        i++;
      }
    }

    if (token.length > 0) tokens.push(token);
  }

  return tokens;
}

/**
 * splitSegments(cmd) -- split on shell connectors && || ; | outside of quotes.
 */
function splitSegments(cmd) {
  const segments = [];
  let i = 0;
  const len = cmd.length;
  let segStart = 0;

  while (i < len) {
    const ch = cmd[i];

    if (ch === '\\') {
      i += 2; // skip escaped character
    } else if (ch === "'") {
      i++;
      while (i < len && cmd[i] !== "'") i++;
      i++; // skip closing quote
    } else if (ch === '"') {
      i++;
      while (i < len) {
        if (cmd[i] === '\\' && i + 1 < len) { i += 2; continue; }
        if (cmd[i] === '"') { i++; break; }
        i++;
      }
    } else if (ch === '&' && i + 1 < len && cmd[i + 1] === '&') {
      segments.push(cmd.slice(segStart, i).trim());
      i += 2; segStart = i;
    } else if (ch === '|' && i + 1 < len && cmd[i + 1] === '|') {
      segments.push(cmd.slice(segStart, i).trim());
      i += 2; segStart = i;
    } else if (ch === ';') {
      segments.push(cmd.slice(segStart, i).trim());
      i++; segStart = i;
    } else if (ch === '|') {
      // single pipe
      segments.push(cmd.slice(segStart, i).trim());
      i++; segStart = i;
    } else {
      i++;
    }
  }

  const tail = cmd.slice(segStart).trim();
  if (tail.length > 0) segments.push(tail);
  return segments.filter(s => s.length > 0);
}

// Git global flags that consume a following argument value.
const GIT_GLOBAL_FLAGS_WITH_ARG = new Set(['-C', '-c', '--exec-path', '--git-dir', '--work-tree', '--namespace']);
// Git global flags that are standalone (no following argument).
const GIT_GLOBAL_FLAGS_STANDALONE = new Set([
  '--version', '--help', '--html-path', '--man-path', '--info-path',
  '-p', '--paginate', '-P', '--no-pager', '--no-replace-objects',
  '--bare', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs',
  '--icase-pathspecs', '--no-optional-locks', '--list-cmds',
]);

/**
 * resolveGitSubcommand(tokens) -- walk past global git flags and return the
 * subcommand token, or null if not determinable.
 */
function resolveGitSubcommand(tokens) {
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (GIT_GLOBAL_FLAGS_WITH_ARG.has(t)) {
      i += 2;
    } else if (GIT_GLOBAL_FLAGS_STANDALONE.has(t)) {
      i += 1;
    } else if (t.startsWith('-')) {
      i += 1; // unknown global flag -- skip conservatively
    } else {
      return { subcommand: t, flagsStart: i + 1 };
    }
  }
  return null;
}

// Flags for git commit that consume the immediately following token as a value.
const COMMIT_FLAGS_WITH_VALUE = new Set([
  '-m', '--message', '-F', '--file', '-C', '-c',
  '--author', '--date', '--fixup', '--squash', '--pathspec-from-file',
]);

// Flags for git push that consume the following token as a value.
const PUSH_FLAGS_WITH_VALUE = new Set([
  '--receive-pack', '--repo', '--push-option', '-o', '--recurse-submodules',
]);

const BYPASS_NV = '--no-verify';
const BYPASS_N = '-n'; // short alias (commit only; on push -n means --dry-run)

function checkSegmentForBypass(tokens) {
  if (tokens.length === 0 || tokens[0] !== 'git') return null;
  const resolved = resolveGitSubcommand(tokens);
  if (!resolved) return null;
  const { subcommand, flagsStart } = resolved;
  if (subcommand === 'commit') {
    for (let i = flagsStart; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === BYPASS_NV || t === BYPASS_N) return `git ${subcommand} ${t}`;
      if (COMMIT_FLAGS_WITH_VALUE.has(t)) i++;
    }
  } else if (subcommand === 'push') {
    for (let i = flagsStart; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === BYPASS_NV) return `git ${subcommand} ${t}`;
      if (PUSH_FLAGS_WITH_VALUE.has(t)) i++;
    }
  }
  return null;
}

function checkCommandForBypass(command) {
  if (typeof command !== 'string' || !command) return null;
  if (!command.includes('git')) return null;
  const segments = splitSegments(command);
  for (const seg of segments) {
    const tokens = tokenize(seg);
    const result = checkSegmentForBypass(tokens);
    if (result) return result;
  }
  return null;
}

function run(inputOrRaw, options = {}) {
  if (options.truncated) {
    return {
      exitCode: 2,
      stderr: `BLOCKED: Hook input exceeded ${options.maxStdin || MAX_STDIN} bytes. ` +
        'Refusing to bypass config-protection on a truncated payload.',
    };
  }
  let input;
  try {
    input = typeof inputOrRaw === 'string' ? JSON.parse(inputOrRaw) : inputOrRaw;
  } catch { return { exitCode: 0 }; }
  const filePath = input?.tool_input?.path || input?.tool_input?.file_path || '';
  if (filePath) {
    const basename = path.basename(filePath);
    if (PROTECTED_FILES.has(basename)) {
      return {
        exitCode: 2,
        stderr: `BLOCKED: Modifying ${basename} is not allowed. ` +
          'Fix the source code to satisfy linter/formatter rules instead of ' +
          'weakening the config. If this is a legitimate config change, ' +
          'disable the config-protection hook temporarily.',
      };
    }
  }
  const command = input?.tool_input?.command || '';
  if (command) {
    const bypass = checkCommandForBypass(command);
    if (bypass) {
      return {
        exitCode: 2,
        stderr: `BLOCKED: "${bypass}" bypasses git verification hooks. ` +
          'Verification hooks enforce project quality gates and must not be opted out. ' +
          'Fix the failing check instead of skipping it. ' +
          'If the hook is genuinely misconfigured, correct the hook configuration directly.',
      };
    }
  }
  return { exitCode: 0 };
}

module.exports = { run, tokenize, splitSegments, checkCommandForBypass };

// Stdin fallback for spawnSync execution
if (require.main === module) {
  let raw = '';
  let truncated = /^(1|true|yes)$/i.test(String(process.env.SA_HOOK_INPUT_TRUNCATED || ''));
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (raw.length < MAX_STDIN) {
      const remaining = MAX_STDIN - raw.length;
      raw += chunk.substring(0, remaining);
      if (chunk.length > remaining) truncated = true;
    } else { truncated = true; }
  });
  process.stdin.on('end', () => {
    const result = run(raw, { truncated, maxStdin: Number(process.env.SA_HOOK_INPUT_MAX_BYTES) || MAX_STDIN });
    if (result.stderr) process.stderr.write(result.stderr + '\n');
    if (result.exitCode === 2) process.exit(2);
    process.stdout.write(raw);
  });
}
