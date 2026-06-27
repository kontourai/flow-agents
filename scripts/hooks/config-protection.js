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
 * GATE LOCK-DOWN (adversarial review Finding 2 + anti-gaming):
 * Also blocks Write/Edit to kill-switch / routing files that an agent could use
 * to self-tamper the gate:
 *   - Shell profiles (.bashrc, .bash_profile, etc.) — where an agent could
 *     export FLOW_AGENTS_GOAL_FIT_MODE=off for the next bash -lc hook invocation.
 *   - .claude/settings.json / settings.local.json — where an agent could add an
 *     env block or delete the Stop hook entry entirely.
 *   - .flow-agents/current.json — where an agent could forge active_flow_id /
 *     active_step_id to route the gate to a fake permissive FlowDefinition.
 *     SAFE: the workflow CLI writes current.json via fs.writeFileSync (writeJson),
 *     NOT via the Write/Edit tool, so blocking the tool path does NOT break legit
 *     sidecar writes (verified: ensureSession / advanceState / writeCurrent all call
 *     writeJson which calls fs.writeFileSync directly).
 *
 * Also detects (best-effort) Bash-command redirects that write to the same paths
 * via shell operators (>, >>, tee). HONEST: this is INCOMPLETE COVERAGE — sed -i,
 * process substitution, /dev/fd tricks, and other non-standard redirect forms are
 * NOT caught. An agent with shell access can still evade. The real anchor is
 * external: signed checkpoints + human review. This raises the bar, not a wall.
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
  // ── Gate lock-down: shell profiles ────────────────────────────────────────
  // An agent could write `export FLOW_AGENTS_GOAL_FIT_MODE=off` here so the next
  // `bash -lc <hook>` invocation inherits the override and silences the gate.
  // Blocking Write/Edit to these basenames raises the cost without stopping
  // legitimate terminal customization done outside the agent session.
  '.bash_profile', '.bashrc', '.profile', '.zprofile', '.zshrc',
]);

// ---------------------------------------------------------------------------
// Gate lock-down: path-pattern protected files
//
// These files need PATH context (not just basename) to avoid over-matching
// common file names in unrelated projects.
//
// checkProtectedPathPattern(filePath) → { name, reason } | null
// ---------------------------------------------------------------------------

/**
 * Check whether a Write/Edit tool file path targets a gate kill-switch file
 * that requires path-level matching (.claude/settings.json,
 * .flow-agents/current.json).
 *
 * Returns { name, reason } when blocked, null when allowed.
 *
 * BAR-RAISER framing (honest): this is not airtight. An agent that writes the
 * file through a Bash redirect or through a shell call that constructs the path
 * at runtime can still evade. The real anchor is external (signed checkpoints +
 * human review). We raise the cost of casual/direct manipulation.
 */
function checkProtectedPathPattern(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  // Normalize: forward-slashes, strip leading ~/
  const norm = filePath.replace(/\\/g, '/').replace(/^~\//, '');

  // .claude/settings.json — an agent could add an env block or delete the Stop
  // hook to disable gate enforcement for the entire session.
  if (/(?:^|\/)\.claude\/settings\.json$/.test(norm)) {
    return {
      name: '.claude/settings.json',
      reason: 'an agent could add an env block or remove the Stop hook to disable gate enforcement',
    };
  }

  // .claude/settings.local.json — same risk as settings.json (local overrides
  // are loaded alongside the main settings file by Claude Code).
  if (/(?:^|\/)\.claude\/settings\.local\.json$/.test(norm)) {
    return {
      name: '.claude/settings.local.json',
      reason: 'an agent could add an env block or remove the Stop hook to disable gate enforcement',
    };
  }

  // .flow-agents/current.json — an agent could forge active_flow_id / active_step_id
  // to route the gate to a permissive or empty-expects FlowDefinition.
  // SAFE: the workflow CLI writes current.json via fs (writeJson → fs.writeFileSync),
  // NOT via the Write/Edit tool — blocking the tool path does not break legit sidecar.
  if (/(?:^|\/)\.flow-agents\/current\.json$/.test(norm)) {
    return {
      name: '.flow-agents/current.json',
      reason: 'an agent could forge active_flow_id/active_step_id to route the gate to a permissive FlowDefinition',
    };
  }

  return null;
}

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

// ---------------------------------------------------------------------------
// Gate lock-down: Bash-redirect detection for protected kill-switch paths
//
// When the agent uses a Bash tool (tool_input.command), detect redirects that
// write to protected paths via shell redirect operators (> >>) or `tee`.
//
// HONEST — INCOMPLETE COVERAGE: this catches the obvious forms only:
//   - `cmd > ~/.bashrc`          ✓ caught (> redirect operator)
//   - `cmd >> .claude/settings.json`  ✓ caught (>> redirect operator)
//   - `tee .flow-agents/current.json`  ✓ caught (tee command)
//   - `sed -i ... .bashrc`       ✗ NOT caught (in-place edit, complex syntax)
//   - `interpreted-lang -c "open('.bashrc','w').write(...)"` ✗ NOT caught
//   - `/dev/fd` tricks, process substitution, etc. ✗ NOT caught
//
// An agent with shell access can still evade by constructing paths at runtime,
// using subshells, or using tools not scanned here. The real tamper-proof
// boundary is external: signed checkpoints + human review. This raises the bar.
// ---------------------------------------------------------------------------

/**
 * Regex that matches a normalized (forward-slash) path ending with a protected
 * kill-switch file: shell profiles, .claude/settings*.json, .flow-agents/current.json.
 */
const REDIRECT_PROTECTED_RE = /(?:^|\/|~\/)(\.bash_profile|\.bashrc|\.profile|\.zprofile|\.zshrc)$|(?:^|\/)\.claude\/settings(?:\.local)?\.json$|(?:^|\/)\.flow-agents\/current\.json$/;

/**
 * Return true when a token (an unquoted redirect target or tee argument) matches
 * a protected kill-switch path.
 */
function matchesRedirectProtected(token) {
  if (!token || typeof token !== 'string') return false;
  const norm = token.replace(/\\/g, '/');
  return REDIRECT_PROTECTED_RE.test(norm);
}

/**
 * checkRedirectToProtected(command): scan a Bash command string for shell
 * redirects (> >>) or tee invocations that target protected kill-switch paths.
 *
 * Returns a human-readable description of the matched redirect, or null if
 * none found.
 *
 * INCOMPLETE COVERAGE — see module header for honest framing.
 */
function checkRedirectToProtected(command) {
  if (typeof command !== 'string' || !command) return null;
  // Fast path: skip if no redirect indicators present.
  if (!command.includes('>') && !command.includes('tee')) return null;

  const segments = splitSegments(command);
  for (const seg of segments) {
    const tokens = tokenize(seg);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];

      // Redirect operators: > and >>
      if ((t === '>' || t === '>>') && i + 1 < tokens.length) {
        const target = tokens[i + 1];
        if (matchesRedirectProtected(target)) {
          return `shell redirect (${t}) to ${target}`;
        }
      }

      // tee command: `tee [-a] [--] <file> [file2 ...]`
      // tee accepts MULTIPLE output files — check ALL positional args, not just the first.
      if (t === 'tee') {
        let pastDashDash = false;
        for (let j = i + 1; j < tokens.length; j++) {
          const arg = tokens[j];
          if (!pastDashDash && arg === '--') { pastDashDash = true; continue; }
          if (!pastDashDash && arg.startsWith('-')) continue; // skip tee flags (-a, --append, etc.)
          // Check every positional arg — no early break (tee writes to all of them).
          if (matchesRedirectProtected(arg)) return `tee to ${arg}`;
        }
      }
    }
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
    // Gate lock-down: check path-pattern protected files (need path context).
    const pathMatch = checkProtectedPathPattern(filePath);
    if (pathMatch) {
      return {
        exitCode: 2,
        stderr: `BLOCKED: Writing to ${pathMatch.name} is not allowed. ` +
          `This file is protected because ${pathMatch.reason}. ` +
          'If this is a legitimate change, disable the config-protection hook temporarily and document the reason.',
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
    // Gate lock-down: check for shell redirects to protected kill-switch paths.
    // HONEST — INCOMPLETE: only > >> and tee are covered; sed -i and other forms
    // are NOT. An agent with shell access can still evade. Bar-raiser only.
    const redirect = checkRedirectToProtected(command);
    if (redirect) {
      return {
        exitCode: 2,
        stderr: `BLOCKED: Detected ${redirect} targeting a protected gate kill-switch file. ` +
          'Writing to shell profiles or Claude/flow-agents config files via shell redirect could ' +
          'disable or tamper with the gate. If this is a legitimate operation, ' +
          'disable the config-protection hook temporarily and document the reason. ' +
          'NOTE: This check has incomplete coverage (sed -i and similar forms are not caught).',
      };
    }
  }
  return { exitCode: 0 };
}

module.exports = { run, tokenize, splitSegments, checkCommandForBypass, checkProtectedPathPattern, checkRedirectToProtected };

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
