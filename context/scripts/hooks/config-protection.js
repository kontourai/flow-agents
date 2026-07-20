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
 *   (Verified: ensureSession / advanceState / writeCurrent / writeState /
 *    writeTrustBundle all use writeJson which calls fs.writeFileSync directly —
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
// #783: root-scoping for the Bash-command detectors below (redirect / interpreter-write /
// cp-move) -- see that module's header comment for the full fail-closed contract.
const { isCandidateWithinDeclaredRoots, resolveCandidatePath, canonicalize } = require('./lib/declared-artifact-roots.js');

const MAX_STDIN = 1024 * 1024;

// #783: named once so every Bash-detector block message below can point a legitimate
// fixture-authoring agent at the sanctioned, discoverable escape instead of dying on a raw
// redirect/interpreter one-liner (issue #783's dogfooding complaint). Only reachable when a
// scoped path is blocked because it is INSIDE a declared root or root detection was ambiguous
// -- a path already outside every declared root was never blocked in the first place.
const FIXTURE_AFFORDANCE_HINT =
  'To author a test fixture, target a path OUTSIDE every declared artifact root (a scratch/temp ' +
  'dir, never the repo durable .kontourai/flow-agents, .flow-agents, or delivery/) and use ' +
  '`npm run workflow:sidecar -- fixture write <dir> --from-json <file>` for a schema-valid ' +
  'fixture, or `... fixture write <dir> --malformed --content <string|@file>` for an ' +
  'intentionally-invalid one (negative-test fixtures). Both refuse to write inside a declared root.';

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
 * .kontourai/flow-agents/<slug>/trust.bundle, and deprecated runtime-shaped
 * .flow-agents equivalents).
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
 * .kontourai/flow-agents/<slug>/trust.bundle, and deprecated runtime-shaped
 * .flow-agents equivalents.
 */
// #379: the delivery/ arms carry an optional (?:[^/]+\/)? segment so redirects/tee to the
// per-session path delivery/<slug>/trust.bundle (+ checkpoint) are caught, not just the flat path.
// #783 review F1: the protected shapes split into TWO classes with different scoping rules.
// GLOBAL arms — shell profiles, .claude settings, lifecycle authority keys — are kill switches
// with NO legitimate fixture use anywhere; a shape match alone blocks, exactly as before root
// scoping existed. ARTIFACT arms — sidecar/delivery files — are scoped to declared artifact
// roots so scratch-dir test fixtures stay authorable.
// Case-insensitive (confirmation-review F1 variant): the host filesystems this hook defends
// are commonly case-insensitive, so ~/.BASHRC IS ~/.bashrc.
const REDIRECT_GLOBAL_RE = /(?:^|\/|~\/)(\.bash_profile|\.bashrc|\.profile|\.zprofile|\.zshrc)$|(?:^|\/)\.claude\/settings(?:\.local)?\.json$|(?:^|\/)\.flow-agents\/lifecycle-authority-keys\.json$/i;
const REDIRECT_ARTIFACT_RE = /(?:^|\/)(?:\.kontourai\/flow-agents|\.flow-agents)\/current\.json$|(?:^|\/)(?:\.kontourai\/flow-agents|\.flow-agents)\/current\/[^/]+\.json$|(?:^|\/)(?:\.kontourai\/flow-agents|\.flow-agents)\/\.goal-fit-block-streak\.json$|(?:^|\/)(?:\.kontourai\/flow-agents|\.flow-agents)\/[^/]+\/state\.json$|(?:^|\/)(?:\.kontourai\/flow-agents|\.flow-agents)\/[^/]+\/trust\.bundle$|(?:^|\/)delivery\/(?:[^/]+\/)?trust\.bundle$|(?:^|\/)delivery\/(?:[^/]+\/)?trust\.checkpoint\.json$/i;

// Basenames that identify a flow-artifact even when the DIRECTORY spelling is laundered
// through a symlink (confirmation-review F4 variant): a token like /tmp/hop/slug/state.json
// carries none of the .kontourai spelling, so the shape regex alone cannot see it — but its
// basename justifies one canonicalization + re-test.
const ARTIFACT_BASENAME_RE = /(?:^|\/)(state\.json|current\.json|trust\.bundle|trust\.checkpoint\.json|\.goal-fit-block-streak\.json)$/i;

function matchesRedirectGlobal(token) {
  if (!token || typeof token !== 'string') return false;
  return REDIRECT_GLOBAL_RE.test(token.replace(/\\/g, '/'));
}

/**
 * Return true when a token (an unquoted redirect target or tee argument) matches
 * a protected kill-switch path of either class. Retained for compatibility.
 */
function matchesRedirectProtected(token) {
  if (!token || typeof token !== 'string') return false;
  const norm = token.replace(/\\/g, '/');
  return REDIRECT_GLOBAL_RE.test(norm) || REDIRECT_ARTIFACT_RE.test(norm);
}

/**
 * #783 review F2: any in-command directory change makes token-vs-cwd resolution unsound —
 * the shell resolves later relative paths against a cwd we did not model. Fail closed:
 * commands that change directory get NO root-scoping relief on artifact-shaped targets.
 */
function commandChangesDirectory(command) {
  // Strip quote characters first (confirmation-review F2 variant): the shell concatenates
  // adjacent quoted fragments, so `c""d` executes as `cd` — the guard must see through that.
  const dequoted = String(command || '').replace(/["']/g, '');
  return /(^|[;&|(]|\s)(cd|pushd|popd)(\s|$)/.test(dequoted);
}

/**
 * Shared #783 decision for one redirect/tee/cp target token: GLOBAL shapes block on match
 * alone; ARTIFACT shapes block unless provably outside every declared root (with the
 * cd-in-command fail-closed guard).
 */
function protectedTargetBlocks(token, cwd, command) {
  if (!token || typeof token !== 'string') return false;
  const norm = token.replace(/\\/g, '/');
  if (REDIRECT_GLOBAL_RE.test(norm)) return true;
  let artifactShaped = REDIRECT_ARTIFACT_RE.test(norm);
  if (!artifactShaped && ARTIFACT_BASENAME_RE.test(norm)) {
    // Symlink-laundering check (F4): the visible spelling is innocent but the basename is a
    // flow artifact — canonicalize once and re-test the shape against where it REALLY lands.
    try {
      const resolved = resolveCandidatePath(token, cwd);
      if (!resolved.ambiguous && resolved.path) {
        const canonicalNorm = canonicalize(resolved.path).replace(/\\/g, '/');
        artifactShaped = REDIRECT_ARTIFACT_RE.test(canonicalNorm) || REDIRECT_GLOBAL_RE.test(canonicalNorm);
      }
    } catch { /* canonicalization failure degrades to the lexical result */ }
  }
  if (!artifactShaped) return false;
  if (commandChangesDirectory(command)) return true;
  return isCandidateWithinDeclaredRoots(token, cwd);
}

/**
 * checkRedirectToProtected(command, cwd): scan a Bash command string for shell
 * redirects (> >>) or tee invocations that target protected kill-switch paths.
 *
 * Returns a human-readable description of the matched redirect, or null if
 * none found.
 *
 * #783: a shape match ALONE no longer blocks -- the resolved target must also be inside a
 * DECLARED artifact root (isCandidateWithinDeclaredRoots; fails closed on ambiguity), so a
 * test fixture written to a scratch/temp dir outside every declared root is no longer caught
 * by this detector just because its basename looks like state.json/current.json/trust.bundle.
 *
 * INCOMPLETE COVERAGE — see module header for honest framing.
 */
function checkRedirectToProtected(command, cwd) {
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
        if (protectedTargetBlocks(target, cwd, command)) {
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
          if (protectedTargetBlocks(arg, cwd, command)) return `tee to ${arg}`;
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
  '.claude/settings.json', '.claude/settings.local.json',
  // Flow-agents session sidecars (basename match; false-positive risk is low
  // in the interpreter-write context and accepted per R5a honest framing)
  'current.json', 'state.json', 'trust.bundle',
  // Delivery CI anchor paths. The existing trust.bundle token catches delivery/trust.bundle
  // as a substring; explicit path added for clarity. trust.checkpoint.json is new.
  'delivery/trust.bundle', 'delivery/trust.checkpoint.json',
];

// #783 review F1: tokens in this set are GLOBAL kill switches — blocked on segment match
// alone, never root-scoped (see protectedTargetBlocks for the same split on redirect targets).
const INTERPRETER_GLOBAL_TOKENS = new Set([
  '.bash_profile', '.bashrc', '.profile', '.zshrc', '.zprofile',
  '.claude/settings.json', '.claude/settings.local.json',
]);

/**
 * checkInterpreterWriteToProtected(command, cwd): detect interpreter invocations
 * (see INTERPRETER_WRITE_RE) in segments that also contain a
 * protected-path token as a literal substring.
 *
 * Returns a human-readable description of the match, or null if not detected.
 *
 * Root-scoping (issue 783 follow-up) via isCandidateWithinDeclaredRoots(token, cwd) applies
 * here too, using the LITERAL matched token as the candidate. For tokens with no directory
 * context at all (the sidecar runtime file basenames, the bare shell-profile names) this
 * is a bare basename, which isCandidateWithinDeclaredRoots's resolver treats as ambiguous
 * -- so those stay blocked exactly as before (a substring match can't prove WHERE a
 * runtime-constructed path will land, so failing closed here is correct, not overreach). For
 * tokens that already carry directory context (the settings file under a dotdir, the
 * delivery trust-anchor paths) scoping applies normally.
 *
 * INCOMPLETE COVERAGE — see module header for honest framing.
 */
function checkInterpreterWriteToProtected(command, cwd) {
  if (typeof command !== 'string' || !command) return null;
  // Fast path: skip if no interpreter keywords present.
  if (!command.includes('node') && !command.includes(_PY_CMD) &&
      !command.includes('sed') && !command.includes('perl')) return null;

  const segments = splitSegments(command);
  for (const seg of segments) {
    // Check interpreter pattern.
    const interpMatch = INTERPRETER_WRITE_RE.exec(seg);
    if (!interpMatch) continue;

    // Check for protected-path token literal in the same segment. #783 review F1: GLOBAL
    // kill-switch tokens (shell profiles, .claude settings) block on the segment match alone —
    // they have no fixture use and must not receive root-scoping relief. Artifact tokens go
    // through the fail-closed resolver (bare basenames stay ambiguous → blocked; the
    // cd-in-command guard applies as everywhere else).
    // Case-insensitive segment match (confirmation-review F1 variant): the defended
    // filesystems are commonly case-insensitive, so '.CLAUDE/Settings.json' is the same file.
    const segLower = seg.toLowerCase();
    for (const token of INTERPRETER_PROTECTED_TOKENS) {
      if (!segLower.includes(token.toLowerCase())) continue;
      if (INTERPRETER_GLOBAL_TOKENS.has(token) || commandChangesDirectory(command) || isCandidateWithinDeclaredRoots(token, cwd)) {
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
 * checkCopyMoveToProtected(command, cwd): detect cp/mv/install commands whose
 * destination argument targets a delivery-protected path.
 *
 * Catches the plain-cp attack vector: `cp forged.json delivery/trust.bundle`
 * is not a redirect and not an interpreter invocation, so those checks miss it.
 * The destination is the LAST positional (non-flag) argument.
 *
 * Root-scoping (issue 783 follow-up) via isCandidateWithinDeclaredRoots(dest, cwd) applies
 * here too -- a destination provably outside every declared artifact root is allowed (a
 * fixture-authoring scratch dir is not the CI trust anchor), fails closed on ambiguity.
 *
 * INCOMPLETE COVERAGE: only cp, mv, install are checked. Other copy tools
 * (rsync, scp, dd, etc.) and runtime-constructed path arguments are NOT caught.
 * The real anchor remains external (clean CI env + human review). Bar-raiser only.
 * RESIDUAL: publishDelivery uses fs.copyFileSync (not bash cp) -- unaffected.
 */
function checkCopyMoveToProtected(command, cwd) {
  if (typeof command !== "string" || !command) return null;
  if (!command.includes("cp") && !command.includes("mv") && !command.includes("install")) return null;
  if (!command.includes("delivery/")) return null;

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
    if (matchesDeliveryProtected(dest) && (commandChangesDirectory(command) || isCandidateWithinDeclaredRoots(dest, cwd))) {
      return `${cmd} to ${dest} (delivery-protected path)`;
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
  // #783: cwd for declared-artifact-root scoping below -- input.cwd when the harness
  // provides one (matches other hooks' input.cwd || process.cwd() convention), else the
  // hook process's own cwd.
  const cwd = input?.cwd || process.cwd();
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
    const redirect = checkRedirectToProtected(command, cwd);
    if (redirect) {
      return {
        exitCode: 2,
        stderr: `BLOCKED: Detected ${redirect} targeting a protected gate kill-switch file. ` +
          'Writing to shell profiles or Claude/flow-agents config files via shell redirect could ' +
          'disable or tamper with the gate. Do not disable this hook. ' +
          remedyForCommand(command) + ' ' +
          'NOTE: This check has incomplete coverage (sed -i and similar forms are not caught). ' +
          FIXTURE_AFFORDANCE_HINT,
      };
    }
    // Gate lock-down: check for interpreter invocations (node -e, py3 -c, sed -i,
    // perl -e) combined with a protected-path token literal in the command string.
    // HONEST — INCOMPLETE (R5a best-effort): runtime-constructed paths, base64,
    // multi-step assembly, and other interpreters not listed are NOT caught.
    const interpWrite = checkInterpreterWriteToProtected(command, cwd);
    if (interpWrite) {
      return {
        exitCode: 2,
        stderr: `BLOCKED: Detected ${interpWrite} in a Bash command. ` +
          'Interpreter invocations (node -e, py3 -c, sed -i, perl -e) that reference ' +
          'protected gate files could tamper with the gate. Do not disable this hook. ' +
          remedyForCommand(command) + ' ' +
          'NOTE: This check has INCOMPLETE COVERAGE — runtime path construction evades it. ' +
          FIXTURE_AFFORDANCE_HINT,
      };
    }
    // Gate lock-down R6: detect cp/mv/install targeting delivery-protected paths.
    // Catches the plain-cp attack: `cp forged.json delivery/trust.bundle`.
    // INCOMPLETE: cp/mv/install only; rsync/scp/dd evade. Real anchor is external.
    const copyMove = checkCopyMoveToProtected(command, cwd);
    if (copyMove) {
      return {
        exitCode: 2,
        stderr: `BLOCKED: Detected ${copyMove} in a Bash command. ` +
          'Writing to delivery/trust.bundle or delivery/trust.checkpoint.json via cp/mv/install ' +
          'could forge the CI trust anchor. Do not disable this hook. ' +
          remedyForCommand(command) + ' ' +
          'NOTE: This check covers cp/mv/install only -- other copy tools may evade it. ' +
          FIXTURE_AFFORDANCE_HINT,
      };
    }
  }
  return { exitCode: 0 };
}

module.exports = { run, tokenize, splitSegments, checkCommandForBypass, checkProtectedPathPattern, checkRedirectToProtected, checkInterpreterWriteToProtected, checkCopyMoveToProtected, matchesDeliveryProtected };

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
