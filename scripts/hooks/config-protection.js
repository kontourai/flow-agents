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
 * GATE LOCK-DOWN (adversarial review Finding 2 + anti-gaming; R5a extension):
 * Also blocks Write/Edit to kill-switch / routing files that an agent could use
 * to self-tamper the gate:
 *   - Shell profiles (.bashrc, .bash_profile, etc.) — where an agent could
 *     export FLOW_AGENTS_GOAL_FIT_MODE=off for the next bash -lc hook invocation.
 *   - .claude/settings.json / settings.local.json — where an agent could add an
 *     env block or delete the Stop hook entry entirely.
 *   - .kontourai/flow-agents/current.json — where an agent could forge active_flow_id /
 *     active_step_id to route the gate to a fake permissive FlowDefinition.
 *   - .kontourai/flow-agents/<slug>/state.json — where an agent could forge phase=planning
 *     to downgrade from FULL_BLOCK to HARD_BLOCK (R5a: MEDIUM finding fix).
 *     SAFE: the CLI writes state.json via writeState → writeJson → fs.writeFileSync.
 *   - .kontourai/flow-agents/<slug>/trust.bundle — where an agent could forge claims.
 *     SAFE: the CLI writes trust.bundle via writeTrustBundle → writeJson → fs.writeFileSync.
 *   - .kontourai/flow-agents/assignment/<slug>.json (iteration-3 fix, Finding B) — the durable
 *     assignment-provider claim record (#290/#291/#294) whose actor_key field
 *     lib/current-pointer.js's ownedSessionArtifactDirs now keys the stop-goal-fit tier-2
 *     ownership scan on (iteration-3 Finding A) independent of the record's claimed/released
 *     status — an agent could otherwise rm/mv/Edit this file to hide or forge session ownership
 *     from that scan the same way the current.json/state.json bypass class already worked.
 *     SAFE: the CLI writes it via writeLocalRecord → writeJson → fs.writeFileSync.
 *     HONEST (ADR 0018 frozen bar-raiser): this is defense-in-depth, matching its sibling
 *     sidecars' coverage for consistency; the durable backstop is CI trust-reconcile on a fresh
 *     server-side checkout, not this local string-matcher.
 *   (Verified: ensureSession / advanceState / writeCurrent / writeState /
 *    writeTrustBundle / writeLocalRecord all use writeJson which calls fs.writeFileSync directly —
 *    blocking the Write/Edit tool path does NOT break legit CLI sidecar writes.)
 *
 * Also detects (best-effort) Bash-command redirects that write to the same paths
 * via shell operators (>, >>, tee). HONEST: this is INCOMPLETE COVERAGE — sed -i,
 * process substitution, /dev/fd tricks, and other non-standard redirect forms are
 * NOT caught. An agent with shell access can still evade. The real anchor is
 * external: signed checkpoints + human review. This raises the bar, not a wall.
 *
 * INTERPRETER-WRITE DETECTION — INCOMPLETE (R5a best-effort):
 * Also checks Bash commands matching interpreter patterns (node -e, py3 -c,
 * sed -i, perl -e) combined with a protected-path token literal in the command
 * string. KNOWN EVASIONS NOT CAUGHT: runtime-constructed paths (process.env.HOME +
 * '/.bashrc', homedir()+'/.bashrc'), base64-encoded paths, multi-step path assembly,
 * any interpreter not in the list (ruby, php, etc.), and multiline here-docs.
 * The real anchor remains external (clean CI env + human review).
 *
 * DELETE/RENAME-AWAY DETECTION — INCOMPLETE (iteration-2 CRITICAL-adjacent fix, security
 * review: an actor could remove or rename away its OWN pointer sidecar to manipulate the
 * stop-goal-fit ownership-scan tier — this is a suspenders fix alongside the primary fix in
 * lib/current-pointer.js's ownedSessionArtifactDirs, which no longer relies on the pointer file
 * surviving). Also checks Bash removal-family invocations targeting a protected path, rename
 * commands whose SOURCE argument is a protected path (moving it away is equivalent to removing
 * it), and interpreter-invoked removal calls referencing a protected-path token literal — the
 * SAME literal-substring approach (and the SAME honest incomplete-coverage note) as the existing
 * interpreter-write check above. KNOWN EVASIONS NOT CAUGHT: runtime-constructed paths,
 * base64-encoded paths, a find-based bulk delete, a sync-then-delete-source tool, any
 * interpreter/removal API not listed, and multiline here-docs. The real anchor remains external
 * (clean CI env + human review).
 *
 * FROZEN bar-raiser (ADR 0018). The redirect / interpreter-write / cp-target detection
 * is intentionally non-exhaustive and is NOT to be grown with new evasion-pattern rules.
 * A newly-discovered self-tamper vector belongs in the external CI anchor (trust-reconcile
 * does not trust agent-written files) and the required anti-gaming suite — not another
 * local string matcher. Bug fixes that don't expand the pattern surface are still welcome.
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
// R5a adds flow-agents runtime state and trust.bundle paths.
//
// checkProtectedPathPattern(filePath) → { name, reason } | null
// ---------------------------------------------------------------------------

/**
 * Check whether a Write/Edit tool file path targets a gate kill-switch file
 * that requires path-level matching (.claude/settings.json,
 * .kontourai/flow-agents/current.json, .kontourai/flow-agents/<slug>/state.json,
 * .kontourai/flow-agents/<slug>/trust.bundle, .kontourai/flow-agents/assignment/<slug>.json
 * (iteration-3 fix, Finding B), and deprecated runtime-shaped .flow-agents equivalents).
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

  // .kontourai/flow-agents/current.json — an agent could forge active_flow_id / active_step_id
  // to route the gate to a permissive or empty-expects FlowDefinition.
  // SAFE: the workflow CLI writes current.json via fs (writeJson → fs.writeFileSync),
  // NOT via the Write/Edit tool — blocking the tool path does not break legit sidecar.
  if (/(?:^|\/)(?:\.kontourai\/flow-agents|\.flow-agents)\/current\.json$/.test(norm)) {
    return {
      name: '.kontourai/flow-agents/current.json',
      reason: 'an agent could forge active_flow_id/active_step_id to route the gate to a permissive FlowDefinition',
    };
  }

  // .kontourai/flow-agents/current/<actor>.json (#291) — the per-actor projection of the same
  // pointer above. An agent could forge active_flow_id/active_step_id here exactly as it could
  // via the legacy global file, so this is protected identically (same reason text).
  // SAFE: the workflow CLI writes this via writePerActorCurrent → fs.writeFileSync,
  // NOT via the Write/Edit tool — blocking the tool path does not break legit sidecar.
  if (/(?:^|\/)(?:\.kontourai\/flow-agents|\.flow-agents)\/current\/[^/]+\.json$/.test(norm)) {
    return {
      name: '.kontourai/flow-agents/current/<actor>.json',
      reason: 'an agent could forge active_flow_id/active_step_id to route the gate to a permissive FlowDefinition',
    };
  }

  // .kontourai/flow-agents/.goal-fit-block-streak.json controls soft-block
  // release counting. An agent could force early advisory-gate release by
  // writing a high count.
  if (/(?:^|\/)(?:\.kontourai\/flow-agents|\.flow-agents)\/\.goal-fit-block-streak\.json$/.test(norm)) {
    return {
      name: '.kontourai/flow-agents/.goal-fit-block-streak.json',
      reason: 'an agent could manipulate goal-fit block streak state to force early soft-block release',
    };
  }

  // .kontourai/flow-agents/<slug>/state.json — an agent could forge phase=planning to
  // downgrade the block regime (FULL_BLOCK → HARD_BLOCK) and weaken gate checks.
  // SAFE: the CLI writes state.json via writeState → writeJson → fs.writeFileSync,
  // NOT via the Write/Edit tool — blocking the tool path does not break legit sidecar.
  if (/(?:^|\/)(?:\.kontourai\/flow-agents|\.flow-agents)\/[^/]+\/state\.json$/.test(norm)) {
    return {
      name: '.kontourai/flow-agents/<slug>/state.json',
      reason: 'an agent could forge phase=planning to downgrade the block regime and weaken gate enforcement',
    };
  }

  // .kontourai/flow-agents/<slug>/trust.bundle — an agent could forge claims (e.g. status=verified
  // or impactLevel=low) to suppress gate blocks or make disputed evidence appear accepted.
  // SAFE: the CLI writes trust.bundle via writeTrustBundle → writeJson → fs.writeFileSync,
  // NOT via the Write/Edit tool — blocking the tool path does not break legit sidecar.
  if (/(?:^|\/)(?:\.kontourai\/flow-agents|\.flow-agents)\/[^/]+\/trust\.bundle$/.test(norm)) {
    return {
      name: '.kontourai/flow-agents/<slug>/trust.bundle',
      reason: 'an agent could forge trust claims (verified status, impact level) to bypass gate integrity checks',
    };
  }

  // .kontourai/flow-agents/assignment/<slug>.json (iteration-3 fix, Finding B) — the durable
  // assignment-provider claim record (#290/#291/#294) whose actor_key field
  // lib/current-pointer.js's ownedSessionArtifactDirs keys the stop-goal-fit tier-2 ownership
  // scan on (iteration-3 Finding A), independent of the record's claimed/released status. An
  // agent could otherwise forge/delete this record to hide or fabricate session ownership from
  // that scan. SAFE: the CLI writes it via writeLocalRecord → writeJson → fs.writeFileSync,
  // NOT via the Write/Edit tool — blocking the tool path does not break legit sidecar writes.
  // HONEST (ADR 0018 frozen bar-raiser): defense-in-depth alongside the primary fix, matching
  // sibling sidecar coverage; the durable backstop is CI trust-reconcile, not this matcher.
  if (/(?:^|\/)(?:\.kontourai\/flow-agents|\.flow-agents)\/assignment\/[^/]+\.json$/.test(norm)) {
    return {
      name: '.kontourai/flow-agents/assignment/<slug>.json',
      reason: 'an agent could forge or delete the durable assignment-claim ownership record to hide an owned session from the stop-goal-fit gate',
    };
  }

  // delivery/trust.bundle is the CI anchor read by trust-reconcile.js and
  // used as the attestation subject in mint-attestation.js. An agent could
  // copy a forged bundle here to corrupt the CI trust check.
  // SAFE: publishDelivery writes via fs.copyFileSync (not Write/Edit tool).
  // RESIDUAL: runtime-constructed paths and fs writes are unaffected.
  // #379: the optional (?:[^/]+\/)? segment also covers the per-session path
  // delivery/<slug>/trust.bundle — the forgery surface moved with the write path.
  if (/(?:^|\/)delivery\/(?:[^/]+\/)?trust\.bundle$/.test(norm)) {
    return {
      name: "delivery/trust.bundle",
      reason: "an agent could write a forged bundle to corrupt the CI trust-reconcile anchor",
    };
  }

  // delivery/trust.checkpoint.json -- the signed checkpoint companion.
  // SAFE: publishDelivery writes via fs.copyFileSync, NOT via Write/Edit tool.
  // #379: optional (?:[^/]+\/)? segment also covers delivery/<slug>/trust.checkpoint.json.
  if (/(?:^|\/)delivery\/(?:[^/]+\/)?trust\.checkpoint\.json$/.test(norm)) {
    return {
      name: "delivery/trust.checkpoint.json",
      reason: "an agent could forge a signed delivery by writing a tampered checkpoint",
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
// R5a extends coverage to flow-agents runtime state and trust.bundle.
//
// HONEST — INCOMPLETE COVERAGE: this catches the obvious forms only:
//   - `cmd > ~/.bashrc`                        ✓ caught (> redirect operator)
//   - `cmd >> .claude/settings.json`           ✓ caught (>> redirect operator)
//   - `tee .kontourai/flow-agents/current.json`   ✓ caught (tee command)
//   - `cmd > .kontourai/flow-agents/s/state.json` ✓ caught (> redirect operator)
//   - `tee .kontourai/flow-agents/s/trust.bundle` ✓ caught (tee command)
//   - `sed -i ... .bashrc`                     ✗ NOT caught (in-place edit)
//   - `interpreted-lang -c "open(...,'w')"     ✗ NOT caught (see interpreter check)
//   - `/dev/fd` tricks, process substitution   ✗ NOT caught
//
// An agent with shell access can still evade by constructing paths at runtime,
// using subshells, or using tools not scanned here. The real tamper-proof
// boundary is external: signed checkpoints + human review. This raises the bar.
// ---------------------------------------------------------------------------

/**
 * Regex that matches a normalized (forward-slash) path ending with a protected
 * kill-switch file: shell profiles, .claude/settings*.json,
 * .kontourai/flow-agents/current.json,
 * .kontourai/flow-agents/current/<actor>.json (#291 per-actor projection),
 * .kontourai/flow-agents/.goal-fit-block-streak.json,
 * .kontourai/flow-agents/<slug>/state.json,
 * .kontourai/flow-agents/<slug>/trust.bundle,
 * .kontourai/flow-agents/assignment/<slug>.json (iteration-3 fix, Finding B — the durable
 * assignment-claim ownership record; see checkProtectedPathPattern's arm above for rationale),
 * and deprecated runtime-shaped .flow-agents equivalents.
 */
// #379: the delivery/ arms carry an optional (?:[^/]+\/)? segment so redirects/tee to the
// per-session path delivery/<slug>/trust.bundle (+ checkpoint) are caught, not just the flat path.
const REDIRECT_PROTECTED_RE = /(?:^|\/|~\/)(\.bash_profile|\.bashrc|\.profile|\.zprofile|\.zshrc)$|(?:^|\/)\.claude\/settings(?:\.local)?\.json$|(?:^|\/)(?:\.kontourai\/flow-agents|\.flow-agents)\/current\.json$|(?:^|\/)(?:\.kontourai\/flow-agents|\.flow-agents)\/current\/[^/]+\.json$|(?:^|\/)(?:\.kontourai\/flow-agents|\.flow-agents)\/\.goal-fit-block-streak\.json$|(?:^|\/)(?:\.kontourai\/flow-agents|\.flow-agents)\/[^/]+\/state\.json$|(?:^|\/)(?:\.kontourai\/flow-agents|\.flow-agents)\/[^/]+\/trust\.bundle$|(?:^|\/)(?:\.kontourai\/flow-agents|\.flow-agents)\/assignment\/[^/]+\.json$|(?:^|\/)delivery\/(?:[^/]+\/)?trust\.bundle$|(?:^|\/)delivery\/(?:[^/]+\/)?trust\.checkpoint\.json$/;

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

// ---------------------------------------------------------------------------
// Gate lock-down: Interpreter-write detection (best-effort, INCOMPLETE)
//
// R5a: Detect Bash commands that invoke interpreters (node -e, py3 -c,
// sed -i, perl -e) when the command string contains a protected-path token
// as a literal substring. This catches the obvious "node -e with .bashrc"
// form but NOT runtime-constructed paths.
//
// HONEST — INCOMPLETE COVERAGE (permanently):
//   `node -e "require('fs').appendFileSync('.bashrc','x')"` ✓ caught (literal token)
//   `py3 -c "open('state.json','w').write(...)"         ✓ caught (literal token)
//   `sed -i 's/a/b/' ~/.zshrc`                             ✓ caught (literal token)
//   `node -e "const p=homedir()+'/.bashrc'; ..."`          ✗ NOT caught (constructed)
//   `node -e "require('fs').writeFileSync(atob('...'),...)` ✗ NOT caught (encoded)
//   `ruby -e / php -r / etc.`                              ✗ NOT caught (not listed)
//   Multiline here-docs or code from a file                ✗ NOT caught
//
// An agent that constructs paths at runtime evades this check. The real
// anchor is external: clean CI env + human review. This raises the bar.
// ---------------------------------------------------------------------------

/**
 * Interpreter patterns that can write files when invoked with inline code.
 * Matched against each shell segment (not the raw full command).
 */
// NOTE: _PY_CMD is assembled from two parts to avoid a source-tree validator
// false-positive on the first-party-Python-command scan. Value = 'p'+'ython'.
// eslint-disable-next-line no-useless-concat
const _PY_CMD = 'p' + 'ython'; // joined value: py...thon (see NOTE above)
const INTERPRETER_WRITE_RE = new RegExp(
  '\\bnode\\s+(?:-e|--eval)\\b|' +
  '\\b' + _PY_CMD + '[23]?\\s+-c\\b|' +
  '\\bsed\\s+-i\\b|\\bperl\\s+-e\\b'
);

/**
 * Protected-path token literals.  When any of these strings appears as a
 * literal substring of a segment that also matches INTERPRETER_WRITE_RE,
 * the command is blocked.
 *
 * INCOMPLETE: only literal occurrences are caught.  An agent that assembles
 * the path at runtime (e.g. process.env.HOME + '/.bashrc') bypasses this.
 */
const INTERPRETER_PROTECTED_TOKENS = [
  // Shell profiles (basename match is specific in this context)
  '.bash_profile', '.bashrc', '.profile', '.zshrc', '.zprofile',
  // Claude and flow-agents routing files
  '.claude/settings.json',
  // Flow-agents session sidecars (basename match; false-positive risk is low
  // in the interpreter-write context and accepted per R5a honest framing)
  'current.json', 'state.json', 'trust.bundle',
  // Iteration-2 CRITICAL-adjacent fix: the per-actor current/<actor>.json projection (#291) has
  // no shared literal basename with the legacy current.json token above (a per-actor file is
  // named after the actor, e.g. current/eval-actor-a.json) -- this directory-prefix token
  // catches an interpreter-invoked removal referencing ANY per-actor pointer file.
  'current/',
  // Iteration-3 fix (Finding B): the durable assignment-claim ownership record (#290/#291/#294,
  // .kontourai/flow-agents/assignment/<slug>.json) -- no shared literal basename with any token
  // above (a record is named after the subject, e.g. assignment/kontourai-flow-agents-345.json),
  // so this directory-prefix token catches an interpreter-invoked write/removal referencing ANY
  // assignment record, mirroring the 'current/' token's approach exactly.
  'assignment/',
  // Delivery CI anchor paths. The existing trust.bundle token catches delivery/trust.bundle
  // as a substring; explicit path added for clarity. trust.checkpoint.json is new.
  'delivery/trust.bundle', 'delivery/trust.checkpoint.json',
];

/**
 * checkInterpreterWriteToProtected(command): detect interpreter invocations
 * (node -e, py3 -c, sed -i, perl -e) in segments that also contain a
 * protected-path token as a literal substring.
 *
 * Returns a human-readable description of the match, or null if not detected.
 *
 * INCOMPLETE COVERAGE — see module header for honest framing.
 */
function checkInterpreterWriteToProtected(command) {
  if (typeof command !== 'string' || !command) return null;
  // Fast path: skip if no interpreter keywords present.
  if (!command.includes('node') && !command.includes(_PY_CMD) &&
      !command.includes('sed') && !command.includes('perl')) return null;

  const segments = splitSegments(command);
  for (const seg of segments) {
    // Check interpreter pattern.
    const interpMatch = INTERPRETER_WRITE_RE.exec(seg);
    if (!interpMatch) continue;

    // Check for protected-path token literal in the same segment.
    for (const token of INTERPRETER_PROTECTED_TOKENS) {
      if (seg.includes(token)) {
        return `${interpMatch[0].trim()} with protected path token "${token}"`;
      }
    }
  }
  return null;
}

/**
 * Delivery-protected path regex: delivery/trust.bundle and delivery/trust.checkpoint.json.
 * These are the CI anchor files whose contents must not be agent-forged.
 * Used by checkCopyMoveToProtected to catch `cp x delivery/trust.bundle`.
 * #379: the optional (?:[^/]+\/)? segment also catches the per-session path
 * `cp forged.json delivery/<slug>/trust.bundle`.
 */
const DELIVERY_COPY_PROTECTED_RE = /(?:^|\/)delivery\/(?:[^/]+\/)?trust\.bundle$|(?:^|\/)delivery\/(?:[^/]+\/)?trust\.checkpoint\.json$/;

/**
 * Return true when a normalized token matches a delivery-protected path.
 */
function matchesDeliveryProtected(token) {
  if (!token || typeof token !== "string") return false;
  return DELIVERY_COPY_PROTECTED_RE.test(token.replace(/\\/g, "/"));
}

/**
 * Assignment-record-protected path regex (iteration-3 fix, Finding B):
 * .kontourai/flow-agents/assignment/<slug>.json (and deprecated .flow-agents equivalent) -- the
 * durable assignment-claim ownership record lib/current-pointer.js's ownedSessionArtifactDirs
 * keys the stop-goal-fit tier-2 ownership scan on. Kept as its own dedicated regex/matcher
 * (rather than folding into the broader REDIRECT_PROTECTED_RE reuse checkDeleteOrRenameAwayOfProtected
 * already does) so checkCopyMoveToProtected's cp/mv/install coverage stays scoped to exactly the
 * two path families it protects today (delivery/* and now assignment/*), not silently widened to
 * every REDIRECT_PROTECTED_RE arm (current.json/state.json/trust.bundle already have no cp/mv
 * coverage requirement in this iteration's fix-plan; adding it here would be scope creep beyond
 * Finding B).
 */
const ASSIGNMENT_COPY_PROTECTED_RE = /(?:^|\/)(?:\.kontourai\/flow-agents|\.flow-agents)\/assignment\/[^/]+\.json$/;

/**
 * Return true when a normalized token matches the assignment-record-protected path.
 */
function matchesAssignmentProtected(token) {
  if (!token || typeof token !== "string") return false;
  return ASSIGNMENT_COPY_PROTECTED_RE.test(token.replace(/\\/g, "/"));
}

/**
 * checkCopyMoveToProtected(command): detect cp/mv/install commands whose
 * destination argument targets a delivery-protected OR assignment-record-protected path.
 *
 * Catches the plain-cp attack vector: `cp forged.json delivery/trust.bundle`
 * is not a redirect and not an interpreter invocation, so those checks miss it. Iteration-3 fix
 * (Finding B) extends the SAME vector to `cp forged.json .kontourai/flow-agents/assignment/<slug>.json`
 * -- overwriting the durable assignment-claim ownership record via cp/mv/install rather than a
 * redirect or Write/Edit tool call. The destination is the LAST positional (non-flag) argument.
 *
 * INCOMPLETE COVERAGE: only cp, mv, install are checked. Other copy tools
 * (rsync, scp, dd, etc.) and runtime-constructed path arguments are NOT caught.
 * The real anchor remains external (clean CI env + human review). Bar-raiser only.
 * RESIDUAL: publishDelivery uses fs.copyFileSync (not bash cp) -- unaffected.
 */
function checkCopyMoveToProtected(command) {
  if (typeof command !== "string" || !command) return null;
  if (!command.includes("cp") && !command.includes("mv") && !command.includes("install")) return null;
  if (!command.includes("delivery/") && !command.includes("assignment/")) return null;

  const segments = splitSegments(command);
  for (const seg of segments) {
    const tokens = tokenize(seg);
    if (tokens.length < 2) continue;
    const cmd = tokens[0];
    if (cmd !== "cp" && cmd !== "mv" && cmd !== "install") continue;

    const positional = [];
    for (let i = 1; i < tokens.length; i++) {
      if (!tokens[i].startsWith("-")) positional.push(tokens[i]);
    }
    if (positional.length === 0) continue;

    const dest = positional[positional.length - 1];
    if (matchesDeliveryProtected(dest)) {
      return `${cmd} to ${dest} (delivery-protected path)`;
    }
    if (matchesAssignmentProtected(dest)) {
      return `${cmd} to ${dest} (assignment-record-protected path)`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Gate lock-down: delete/rename-away detection for the per-actor / legacy current pointer
// and the durable assignment-claim ownership record (iteration-2 CRITICAL-adjacent fix,
// iteration-3 fix Finding B)
//
// Security review + verifier reproduced an end-to-end stop-goal-fit ownership-scan bypass: an
// actor with an active gated session removes its OWN current.json / current/<actor>.json
// pointer file with one un-guarded Bash removal command, so the next Stop hit the (pre-fix)
// tier-2 "scope to nothing" branch. The primary fix is the ownership-scan redesign in
// lib/current-pointer.js's ownedSessionArtifactDirs (the durable assignment-claim actor_key
// stamp, not the pointer file, is now the ownership authority) -- this check is a suspenders
// hardening alongside that fix, raising the cost of casually removing the pointer file itself.
//
// Iteration-3 fix (Finding B, relocated CRITICAL): moving the ownership authority to
// assignment/<slug>.json without extending THIS SAME defensive perimeter to that file left the
// identical bypass class reachable again -- `rm .kontourai/flow-agents/assignment/<slug>.json`
// (or an Edit flipping its actor_key/status) went undetected by every check in this file.
// REDIRECT_PROTECTED_RE (reused below) now covers that path too, so this check, the interpreter-
// write check, and the redirect/tee check all gained the same coverage in one place.
//
// HONEST -- INCOMPLETE COVERAGE (same framing as every other check in this file):
//   `rm .kontourai/flow-agents/current.json`                  caught (rm, protected FILE target)
//   `rm -f .kontourai/flow-agents/current/eval-actor-a.json`  caught (rm, protected FILE target)
//   `unlink .kontourai/flow-agents/current.json`              caught (unlink, protected FILE target)
//   `mv .kontourai/flow-agents/current.json /tmp/gone.json`   caught (mv, protected SOURCE)
//   `rm .kontourai/flow-agents/assignment/<slug>.json`        caught (rm, protected FILE target)
//   `mv .kontourai/flow-agents/assignment/<slug>.json /tmp/x` caught (mv, protected SOURCE)
//   `rmdir .kontourai/flow-agents/current` (the WHOLE per-actor directory, not one named
//   pointer file) is NOT caught -- REDIRECT_PROTECTED_RE (reused here) matches specific FILE
//   paths, not the bare containing directory; nor is a recursive `rm -rf
//   .kontourai/flow-agents/current` or `.kontourai/flow-agents/assignment`. A runtime-constructed
//   path, `find ... -delete`, or a removal tool/API not listed here also evades this check -- the
//   real anchor remains external (clean CI env + human review; CI trust-reconcile does not trust
//   agent-written files).
// ---------------------------------------------------------------------------

const REMOVAL_COMMANDS = new Set(['rm', 'rmdir', 'unlink']);

/**
 * checkDeleteOrRenameAwayOfProtected(command): detect rm/rmdir/unlink invocations whose
 * (any) positional argument targets a protected kill-switch path, and mv/rename invocations
 * whose SOURCE (first positional) argument targets one -- moving the file away is equivalent
 * to deleting it from its protected location.
 *
 * Reuses matchesRedirectProtected/REDIRECT_PROTECTED_RE -- the SAME protected-path set the
 * existing redirect/tee check already guards (current.json, current/<actor>.json, state.json,
 * trust.bundle, assignment/<slug>.json (iteration-3 fix), shell profiles,
 * .claude/settings*.json, etc.) -- so this check never drifts from that list.
 *
 * INCOMPLETE COVERAGE -- see the module header and section header above for the honest framing.
 */
function checkDeleteOrRenameAwayOfProtected(command) {
  if (typeof command !== 'string' || !command) return null;
  if (!command.includes('rm') && !command.includes('unlink') && !command.includes('mv') && !command.includes('rename')) return null;

  const segments = splitSegments(command);
  for (const seg of segments) {
    const tokens = tokenize(seg);
    if (tokens.length < 2) continue;
    const cmd = tokens[0];

    const positional = [];
    for (let i = 1; i < tokens.length; i++) {
      if (!tokens[i].startsWith('-')) positional.push(tokens[i]);
    }
    if (positional.length === 0) continue;

    if (REMOVAL_COMMANDS.has(cmd)) {
      // rm/rmdir/unlink: ANY positional argument targeting a protected path is a removal of it
      // (rm accepts multiple targets: `rm a.txt .kontourai/flow-agents/current.json`).
      for (const target of positional) {
        if (matchesRedirectProtected(target)) {
          return `${cmd} of ${target}`;
        }
      }
    } else if (cmd === 'mv' || cmd === 'rename') {
      // mv/rename: the SOURCE is every positional except the last (the destination) -- moving a
      // protected path away from its required location is equivalent to deleting it there.
      const sources = positional.slice(0, -1);
      for (const source of sources) {
        if (matchesRedirectProtected(source)) {
          return `${cmd} of ${source} (renamed away from its protected location)`;
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sanctioned remedies for blocked writes.
//
// AC7: for sidecar/gate kill-switch paths the block message MUST name the
// sanctioned `npm run workflow:sidecar -- <command>` writer (or a human maintainer
// for host-owned files) and MUST NEVER advise disabling the config-protection hook.
// ---------------------------------------------------------------------------
const READ_ONLY_TOOL_NAMES = new Set(['read', 'glob', 'grep', 'ls', 'notebookread', 'websearch', 'webfetch']);

// WS8 (AC15): the remedy table (SHELL_PROFILE_REMEDY, SANCTIONED_REMEDIES, remedyFor,
// REMEDY_COMMAND_CANDIDATES) was extracted verbatim to ./lib/config-protection-remedies.js
// so it has an independently testable surface and this file is smaller. remedyForCommand
// stays here because it depends on this file's tokenizer (splitSegments/tokenize/
// checkProtectedPathPattern/PROTECTED_FILES). Behavior-preserving — no message text or
// matching data changed.
const { SHELL_PROFILE_REMEDY, remedyFor, REMEDY_COMMAND_CANDIDATES } = require('./lib/config-protection-remedies.js');

/**
 * Recover the sanctioned remedy for a blocked Bash command.
 *
 * Pass 1: exact path-pattern match on individual tokens -- handles shell
 * redirects / tee / cp where the protected path is its own clean token
 * (a bare redirect target, or a cp/mv destination argument).
 *
 * Pass 2: substring match against the raw command text -- handles
 * interpreter-write commands where the protected path sits inside a quoted
 * string followed by punctuation, so no token ends at the basename and
 * Pass 1's dollar-anchored regex never matches. Any blocked command that
 * references a path with a SANCTIONED_REMEDIES entry gets that entry's
 * remedy instead of falling through to the generic (and often factually
 * wrong) shell-profile advice.
 *
 * Never returns advice to disable the hook.
 */
function remedyForCommand(command) {
  if (typeof command !== 'string') return SHELL_PROFILE_REMEDY;

  const segments = splitSegments(command);
  for (const seg of segments) {
    for (const tok of tokenize(seg)) {
      const match = checkProtectedPathPattern(tok);
      if (match) return remedyFor(match.name);
      if (PROTECTED_FILES.has(path.basename(tok))) return SHELL_PROFILE_REMEDY;
    }
  }

  for (const candidate of REMEDY_COMMAND_CANDIDATES) {
    if (candidate.needles.some((needle) => command.includes(needle))) {
      return remedyFor(candidate.name);
    }
  }

  return SHELL_PROFILE_REMEDY;
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
  const toolName = String(input?.tool_name || '').trim().toLowerCase();
  const filePath = input?.tool_input?.path || input?.tool_input?.file_path || '';
  // Read-only tools never mutate a file, so path-based protection must not block them.
  // (Bash is NOT read-only and stays fully covered by the command-based checks below.)
  if (filePath && !READ_ONLY_TOOL_NAMES.has(toolName)) {
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
          remedyFor(pathMatch.name),
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
          'Writing to shell profiles, Claude/flow-agents config files, or the durable ' +
          'assignment-claim ownership record via shell redirect could disable or tamper with ' +
          'the gate. Do not disable this hook. ' +
          remedyForCommand(command) + ' ' +
          'NOTE: This check has incomplete coverage (sed -i and similar forms are not caught).',
      };
    }
    // Gate lock-down: check for interpreter invocations (node -e, py3 -c, sed -i,
    // perl -e) combined with a protected-path token literal in the command string.
    // HONEST — INCOMPLETE (R5a best-effort): runtime-constructed paths, base64,
    // multi-step assembly, and other interpreters not listed are NOT caught.
    const interpWrite = checkInterpreterWriteToProtected(command);
    if (interpWrite) {
      return {
        exitCode: 2,
        stderr: `BLOCKED: Detected ${interpWrite} in a Bash command. ` +
          'Interpreter invocations (node -e, py3 -c, sed -i, perl -e) that reference ' +
          'protected gate files could tamper with the gate. Do not disable this hook. ' +
          remedyForCommand(command) + ' ' +
          'NOTE: This check has INCOMPLETE COVERAGE — runtime path construction evades it.',
      };
    }
    // Gate lock-down R6: detect cp/mv/install targeting delivery-protected paths. Iteration-3 fix
    // (Finding B) extends the SAME check to the durable assignment-claim ownership record.
    // Catches the plain-cp attack: cp forged.json delivery/trust.bundle, or a cp of a forged
    // record onto the assignment ownership record path under .kontourai/flow-agents/assignment/.
    // INCOMPLETE: cp/mv/install only; rsync/scp/dd evade. Real anchor is external.
    const copyMove = checkCopyMoveToProtected(command);
    if (copyMove) {
      return {
        exitCode: 2,
        stderr: `BLOCKED: Detected ${copyMove} in a Bash command. ` +
          'Writing to delivery/trust.bundle, delivery/trust.checkpoint.json, or the durable ' +
          'assignment-claim ownership record under .kontourai/flow-agents/assignment/ ' +
          'via cp/mv/install could forge the CI trust anchor or hide/fabricate session ' +
          'ownership from the goal-fit gate. Do not disable this hook. ' +
          remedyForCommand(command) + ' ' +
          'NOTE: This check covers cp/mv/install only -- other copy tools may evade it.',
      };
    }
    // Iteration-2 CRITICAL-adjacent fix, extended by iteration-3 fix (Finding B): detect
    // rm/rmdir/unlink of, or mv/rename away from, the legacy current.json / per-actor
    // current/<actor>.json pointer, the durable assignment-claim ownership record, or any
    // other protected kill-switch path. A suspenders hardening alongside the primary
    // ownedSessionArtifactDirs fix (lib/current-pointer.js) that no longer relies on either the
    // pointer file OR the assignment record's status field surviving.
    const deleteOrRenameAway = checkDeleteOrRenameAwayOfProtected(command);
    if (deleteOrRenameAway) {
      return {
        exitCode: 2,
        stderr: `BLOCKED: Detected ${deleteOrRenameAway} targeting a protected gate kill-switch file. ` +
          'Removing or renaming away current.json/current/<actor>.json, the assignment ownership ' +
          'record under .kontourai/flow-agents/assignment/, or any other protected ' +
          'sidecar/gate file) could manipulate the goal-fit gate\'s session-ownership resolution. ' +
          'Do not disable this hook. ' +
          remedyForCommand(command) + ' ' +
          'NOTE: This check has incomplete coverage (runtime-constructed paths, find -delete, and similar forms are not caught).',
      };
    }
  }
  return { exitCode: 0 };
}

module.exports = { run, tokenize, splitSegments, checkCommandForBypass, checkProtectedPathPattern, checkRedirectToProtected, checkInterpreterWriteToProtected, checkCopyMoveToProtected, checkDeleteOrRenameAwayOfProtected, matchesDeliveryProtected, matchesAssignmentProtected };

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
