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
 * sed -i, perl -e) that name a protected path in the command string. #682: "names a
 * protected path" means a PATH recovered on component boundaries and resolved against cwd --
 * never a bare filename substring, so a file whose name merely CONTAINS a protected token
 * (`x-trust.bundle.json`, `effective-state.json`) and paths outside every declared artifact
 * root are no longer matched. KNOWN EVASIONS NOT CAUGHT: runtime-constructed paths (process.env.HOME +
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
// #799: narrow, conservative allowlist for interpreter one-liners that are PROVABLY read-only
// (e.g. `py3 -c "print(json.load(open('trust.bundle'))['claims'][0])"`) -- see that
// module's header comment for the full grammar and fail-closed contract. Consulted ONLY by
// checkInterpreterWriteToProtected; the redirect/tee and cp/mv/install detectors key off an
// actual write TARGET and have no read-only false-positive class to fix.
const { isProvablyReadOnlyCommand } = require('./lib/read-only-grammar.js');

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

// #799: named once so every Bash-detector block message below can point a legitimate READ
// attempt at a command shape that is never blocked, instead of leaving the agent to guess (or
// to construct a runtime path to evade the hook, which is the false-positive cost #799 exists
// to cut). `cat <file> | py3 -m json.tool` / `py3 -m json.tool <file>` is a recognized
// fast-pass grammar (see lib/read-only-grammar.js) and is never blocked by this hook.
// (Interpreter name built by concatenation per this file's INTERPRETER_TOKEN convention so
// the hint text does not trip validate-source-tree's first-party-Python-command scan.)
const PY_CMD = 'p' + 'ython3';
const READ_REMEDIATION_HINT =
  'If you only need to READ this file: `' + PY_CMD + ' -m json.tool <file>` (or `cat <file> | ' + PY_CMD +
  ' -m json.tool`) is never blocked by this hook; for a trust.bundle specifically, ' +
  '`npm run workflow:sidecar -- render-trust-panel <dir>` renders a human-readable summary.';

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
  // Confirmation-review F1 variant: defended filesystems are commonly case-insensitive,
  // so compare a lowercased normalization (patterns below are written lowercase).
  const norm = filePath.replace(/\\/g, '/').replace(/^~\//, '').toLowerCase();

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
const ARTIFACT_BASENAME_RE = /(?:^|\/)(state\.json|current\.json|trust\.bundle|trust\.checkpoint\.json|\.goal-fit-block-streak\.json)$|(?:^|\/)current\/[^/]+\.json$/i;

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

/** Builtins that move the shell's working directory. */
const DIRECTORY_CHANGING_COMMANDS = new Set(['cd', 'pushd', 'popd']);

// Words that may precede the real command word without being it. Skipping a word can only
// expose MORE `cd`s to the check, never fewer, so this list errs toward fail-closed.
// `eval` is deliberately ABSENT — see UNMODELLED_COMMAND_WORDS.
const COMMAND_POSITION_PREFIXES = new Set([
  'do', 'then', 'else', 'elif', '!', 'time', 'command', 'builtin', 'exec', 'nohup',
]);

// Command words whose effect this scanner cannot model, so their mere presence in command
// position fails closed. `eval`/`source`/`.` re-interpret their operand AS a command line --
// "one quoted token = one word" is right for ordinary commands and wrong for exactly these,
// so `eval "cd /x"` really does move the shell while the tokenizer sees one non-`cd` token.
// `case`/`esac`/`coproc`/`function` introduce compound syntax (pattern `)` arms, function
// bodies) that splitSegments does not parse into command positions at all.
const UNMODELLED_COMMAND_WORDS = new Set(['eval', 'source', '.', 'case', 'esac', 'coproc', 'function']);

// A redirection may legally precede the command word without consuming command position:
// `>/dev/null cd /x` really does change directory. Recognized so the scan keeps looking for
// the command word instead of concluding "something else runs here".
const REDIRECT_TOKEN_RE = /^(?:[0-9]*(?:>>|>|<)|&>>|&>|<<<|<<|>&|<&)/;
const REDIRECT_OPERATOR_ONLY_RE = /^(?:[0-9]*(?:>>|>|<)|&>>|&>|<<<|<<|>&|<&)$/;

/**
 * True when the command contains a construct this scanner does not fully model, in which case
 * the caller must fail closed rather than trust a structural verdict.
 *
 * #1004 targeted review: the structural scan is precise for what it models, but
 * `splitSegments` only recognizes `&&`, `||`, `;` and `|` as connectors. Anything after an
 * unrecognized connector is invisible to it — `true & cd /repo && …` and a `cd` on its own
 * LINE both slipped past, because the scan stops at the first segment's command word and never
 * sees the later `cd`. Rather than adding connectors one at a time (the enumeration that has
 * already produced two rounds of bypasses), any connector-shaped text this tokenizer does not
 * model returns true here.
 *
 * Quote-aware, so the round-3 over-block stays fixed: the `;cd;` inside
 * `sed -i '' 's/replace me;cd; also/updated/' <path>` is quoted data, not a connector.
 */
/**
 * The command with every quoted region blanked out, so a lexical test can distinguish shell
 * SYNTAX from identical characters appearing as data. `grep "(" file` must not read as a
 * function definition; `f(){ …}` must.
 */
function maskQuotedRegions(command) {
  const out = command.split('');
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '\\') { i++; continue; }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out[i] = ' ';
      i++;
      while (i < command.length && command[i] !== quote) {
        if (quote === '"' && command[i] === '\\') { out[i] = ' '; i++; }
        if (i < command.length) out[i] = ' ';
        i++;
      }
      if (i < command.length) out[i] = ' ';
    }
  }
  return out.join('');
}

// #1009 round 5: the keyword-less function definition `f(){ cd /x;}` hides a command position
// inside a body this scanner does not parse. Unlike the rest of that finding's class it HAS a
// literal signal -- `IDENT ( )` is a command definition and nothing else in sh -- so it is
// enumerable and costs no measured relief. (The `function f {…}` spelling is covered by
// UNMODELLED_COMMAND_WORDS.) Tested against the quote-masked command so `grep "(" file` and
// `sed 's/f()/x/'` are unaffected.
const FUNCTION_DEFINITION_RE = /(?:^|[\s;&|(])[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\)/;

function containsUnmodelledShellConstruct(command) {
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '\\') { i++; continue; } // escaped char (incl. line continuation) is data
    if (ch === "'") { i++; while (i < command.length && command[i] !== "'") i++; continue; }
    if (ch === '"') {
      i++;
      while (i < command.length) {
        if (command[i] === '\\') { i += 2; continue; }
        if (command[i] === '"') break;
        i++;
      }
      continue;
    }
    // A raw newline separates commands exactly as `;` does, and splitSegments ignores it.
    if (ch === '\n' || ch === '\r') return true;
    // ANSI-C / locale quoting: `$'cd'` executes as the word `cd`, but this tokenizer yields
    // `$cd`. The quoting model does not cover it, so it fails closed.
    if (ch === '$' && (command[i + 1] === "'" || command[i + 1] === '"')) return true;
    if (ch === '&') {
      if (command[i + 1] === '&') { i++; continue; }              // `&&` is modelled
      if (command[i - 1] === '>' || command[i - 1] === '<') continue; // `2>&1`, `>&2` redirection
      if (command[i + 1] === '>') { i++; continue; }              // `&>` redirect-both
      return true; // bare `&` (and `|&`): a real connector splitSegments does not split on
    }
  }
  return false;
}

/**
 * BAR-RAISER, NOT A BOUNDARY (#1009). Read this before treating a `false` from this function
 * as an assurance: it is a best-effort lexical scan of an unexecuted command string, in the
 * same spirit as the redirect / interpreter-write / cp-target detectors described in this
 * file's header, and it is defeated by a residual class that CANNOT be closed lexically.
 *
 * The residual class is commands whose command word is not literal, so no local signal exists:
 *   - variable command words     `X=cd; $X /repo`
 *   - array elements             `A=(cd /repo); "${A[@]}"`
 *   - positional parameters      `set -- cd /repo; "$@"`
 *   - `printf -v` assembly, and any other indirection that materializes the word at runtime
 * `X=cd; $X /repo` is character-for-character identical to `X=notcd; $X /repo`, which does not
 * change directory. Deciding between them requires runtime variable values, which may come
 * from command substitution — undecidable, not merely under-enumerated. Adding cases here
 * cannot fix it; that is why #1009 tracks the architectural answer (post-execution
 * verification / an authoritative cwd from the harness) rather than more scanning.
 *
 * What this function IS good for: raising the cost of casual and accidental evasion, and
 * keeping the declared-root scoping honest for the ordinary command shapes agents actually
 * write. The real anchor remains external — signed checkpoints, CI trust-reconcile, and human
 * review — exactly as for every other detector in this file.
 *
 * #783 review F2: any in-command directory change makes token-vs-cwd resolution unsound —
 * the shell resolves later relative paths against a cwd we did not model. Fail closed:
 * commands that change directory get NO root-scoping relief on artifact-shaped targets.
 *
 * #1004 re-review: this asks "does a directory-changing builtin run here?", and only text in
 * COMMAND POSITION can answer it. The previous implementation scanned a de-quoted copy of the
 * whole command, so incidental prose inside a string literal tripped it —
 * `sed -i '' 's/replace me;cd; also/updated/' <path>` was blocked with no `cd` anywhere in the
 * command. Narrowing the character class again would only move that seam, so the scan is now
 * scoped structurally: split on connectors and tokenize (both already quote-aware, so a `;` or
 * a `cd` inside quotes cannot open a segment or become a command word), then inspect only the
 * command word of each segment. The quote-concatenation case this guard was written for still
 * works, because the tokenizer joins adjacent fragments: `c""d` yields the token `cd`.
 *
 * #1004 targeted review: structural precision is only sound for the shapes this tokenizer
 * actually models, and it models less of sh than it appears to. The rule is therefore
 * two-part, and the first part dominates: FAIL CLOSED on any construct the scanner does not
 * fully model (unrecognized connectors, re-interpretation builtins, ANSI-C quoting), and only
 * then trust the structural verdict. This keeps the old regex's fail-closed posture for the
 * unmodelled remainder while keeping the precision that removed the `'…;cd;…'` over-block.
 */
function commandChangesDirectory(command) {
  if (typeof command !== 'string' || !command) return false;
  if (containsUnmodelledShellConstruct(command)) return true;
  if (FUNCTION_DEFINITION_RE.test(maskQuotedRegions(command))) return true;
  for (const segment of splitSegments(command)) {
    const tokens = tokenize(segment);
    for (let i = 0; i < tokens.length; i++) {
      // Subshell/group punctuation glues to the word it opens: `(cd`, `{cd`, `(cd)`.
      const word = tokens[i].replace(/^[({]+/, '').replace(/[)}]+$/, '');
      if (word === '') continue;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue; // `FOO=bar cd …` env prefix
      if (REDIRECT_TOKEN_RE.test(word)) {
        // `>/dev/null cd /x` and `> /dev/null cd /x` both leave command position unconsumed;
        // a detached operator also swallows the following filename token.
        if (REDIRECT_OPERATOR_ONLY_RE.test(word)) i++;
        continue;
      }
      if (COMMAND_POSITION_PREFIXES.has(word)) continue;
      if (UNMODELLED_COMMAND_WORDS.has(word)) return true;
      if (DIRECTORY_CHANGING_COMMANDS.has(word)) return true;
      break; // this segment runs something else; its arguments are not command position
    }
  }
  return false;
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
  if (!artifactShaped) {
    // Symlink-laundering check (F4, third-pass closure): the visible spelling can be FULLY
    // innocent (a symlink named anything pointing at a protected anchor), so any token that
    // resolves at all gets one canonicalization + shape re-test against where it REALLY
    // lands. Bare basenames stay ambiguous in resolveCandidatePath and are skipped here —
    // they are handled by the interpreter detector's fail-closed rules instead.
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

// #799 v2 verify finding: `py -m json.tool <infile> <OUTFILE>` is a WRITE (json.tool's second
// positional operand is an output file), but INTERPRETER_WRITE_RE only recognizes `-c` forms,
// so the outfile shape previously fell through unblocked. Because this hook's own
// READ_REMEDIATION_HINT advertises json.tool as the sanctioned read idiom, the write-capable
// form of the advertised tool must be detected here — this is a correctness closure of the
// #799 change itself, not new bar-raising surface (the read-only grammar already refuses to
// fast-pass it; this makes the fall-through block instead of allow).
const _PY_NAME_RE = new RegExp('^' + _PY_CMD + '[23]?$');
function isJsonToolWriteShape(seg) {
  const tokens = tokenize(seg);
  for (let i = 0; i + 2 < tokens.length; i++) {
    if (_PY_NAME_RE.test(tokens[i]) && tokens[i + 1] === '-m' && tokens[i + 2] === 'json.tool') {
      // Fail-closed operand count: tokens are only discounted when POSITIVELY recognized as a
      // json.tool option. `--` terminates options (everything after is positional, including
      // dash-prefixed filenames); any unrecognized dash token classifies the segment as
      // write-suspicious rather than being skipped as a presumed flag.
      const NO_VALUE_OPTIONS = new Set(['--sort-keys', '--no-ensure-ascii', '--json-lines', '--compact', '--tab', '--no-indent']);
      let operands = 0;
      let afterTerminator = false;
      for (let j = i + 3; j < tokens.length; j++) {
        const t = tokens[j];
        if (!afterTerminator) {
          if (t === '--') { afterTerminator = true; continue; }
          if (t === '--indent') {
            // The only value-taking json.tool option. Its value must be a literal integer:
            // an expansion-capable value ('--indent {1,2}') becomes multiple tokens at
            // execution and shifts a later path into the outfile slot.
            const v = tokens[j + 1];
            if (typeof v !== 'string' || !/^[0-9]+$/.test(v)) return true;
            j++; continue;
          }
          if (NO_VALUE_OPTIONS.has(t)) continue;
          if (t.startsWith('-') && t !== '-') return true; // unrecognized option-like token: fail closed
        }
        // Operand counting happens pre-expansion: one lexical token carrying brace expansion,
        // a glob, or a variable/command substitution can become MULTIPLE operands (including
        // json.tool's write-capable outfile) at execution. Any operand that is not a plain
        // literal path therefore classifies as write-suspicious rather than being counted.
        if (t !== '-' && !/^[A-Za-z0-9._/-]+$/.test(t)) return true;
        operands++; // '-' alone is the stdin operand and counts
      }
      return operands >= 2; // second positional operand is json.tool's write-capable outfile
    }
  }
  return false;
}

/**
 * Protected-path token literals.  A segment that matches INTERPRETER_WRITE_RE is blocked when
 * one of these appears in it as a whole trailing PATH TAIL -- #682: on path-component
 * boundaries, with the surrounding path resolved and scoped (extractTokenPathCandidates /
 * interpreterCandidateBlocks below), never as a bare filename substring.
 *
 * INCOMPLETE: only literal occurrences are caught.  An agent that assembles
 * the path at runtime (e.g. process.env.HOME + '/.bashrc') bypasses this.
 */
const INTERPRETER_PROTECTED_TOKENS = [
  // Shell profiles (basename match is specific in this context)
  '.bash_profile', '.bashrc', '.profile', '.zshrc', '.zprofile',
  // Claude and flow-agents routing files
  '.claude/settings.json', '.claude/settings.local.json',
  // Flow-agents session sidecars. A basename alone carries no location, so it fails closed
  // (blocked) unless the command spells out a directory that provably lands outside every
  // declared artifact root -- see interpreterCandidateBlocks.
  'current.json', 'state.json', 'trust.bundle',
  // Delivery CI anchor paths. The existing trust.bundle token catches delivery/trust.bundle
  // as a path tail; explicit path added for clarity. trust.checkpoint.json is new.
  'delivery/trust.bundle', 'delivery/trust.checkpoint.json',
];

// #783 review F1: tokens in this set are GLOBAL kill switches — blocked on segment match
// alone, never root-scoped (see protectedTargetBlocks for the same split on redirect targets).
const INTERPRETER_GLOBAL_TOKENS = new Set([
  '.bash_profile', '.bashrc', '.profile', '.zshrc', '.zprofile',
  '.claude/settings.json', '.claude/settings.local.json',
]);

// ---------------------------------------------------------------------------
// #682: protected-path token matching resolves PATHS, not filename substrings.
//
// Before #682 the interpreter detector asked two questions that a substring cannot answer:
//   1. "does the segment CONTAIN the token?" -- so `notes-trust.bundle.json` (a different
//      file that merely ends with the token text) and `build/effective-state.json` matched;
//   2. "is <the bare token literal> inside a declared root?" -- it passed the TOKEN, not the
//      path from the command, to isCandidateWithinDeclaredRoots, which reports a bare
//      basename as ambiguous, so EVERY match failed closed regardless of where the real path
//      pointed. A read of a scratch file outside the repo entirely was blocked.
//
// The fix recovers the actual path candidate around each token occurrence and hands THAT to
// the same fail-closed resolver/shape decision the redirect and cp/mv detectors already use
// (protectedTargetBlocks). This narrows a false-positive class only; it adds no new
// evasion-pattern rule, so the ADR 0018 FROZEN bar-raiser is unaffected.
// ---------------------------------------------------------------------------

// Characters that may appear in a path candidate recovered from a segment. `$`, `{` and `}`
// are INCLUDED on purpose: a candidate carrying an expansion must reach resolveCandidatePath
// so it is reported ambiguous and fails closed, rather than being silently truncated into an
// innocent-looking prefix.
const PATH_CANDIDATE_CHAR_RE = /[A-Za-z0-9._/~${}-]/;
// Characters that continue a path COMPONENT. A protected token must both start and end a
// component: `.../x-trust.bundle.json` and `.../effective-state.json` name other files.
const PATH_COMPONENT_CHAR_RE = /[A-Za-z0-9._-]/;
// A recovered candidate is trustworthy ONLY when it provably STARTS A WORD. Leftward expansion
// stops at the first character outside PATH_CANDIDATE_CHAR_RE, and that stop is the whole
// problem: the character that stopped it may be a separator that DETERMINES where the write
// lands -- a brace-expansion comma (`{slug,other}/state.json` truncates to `other}/state.json`,
// which looks like an ordinary relative path), a glob, a command substitution's closing paren,
// a runtime concatenation `+`, or a quoted expansion glued to the path (`"$D"/…`).
//
// SECURITY REVIEW (#1004): enumerating those separators one at a time is how the next one gets
// missed -- the comma was missed exactly that way. So this is a strict WHITELIST of the only
// two contexts in which an UNQUOTED path literal legitimately begins: whitespace, or the `=` of
// a `--flag=<path>` value. Every other stop character means the prefix was truncated by
// something meaningful, the destination is unknowable, and the candidate fails closed.
//
// A quote is handled one level up: the quote itself must open a word, so `'…'` after `(` or a
// comma-separated argument counts, while the closing `"` of `"$D"` and the `+` of `dir+'…'`
// do not. Both lists are minimal by construction -- adding a character can only ALLOW more,
// so anything not proven necessary stays out.
const UNQUOTED_CANDIDATE_OPENS_WORD_RE = /[\s=]/;
const QUOTED_CANDIDATE_OPENS_WORD_RE = /[\s(,=[{:]/;

/**
 * True when the character(s) left of a recovered candidate do NOT prove it begins a fresh path
 * literal -- i.e. the candidate was truncated by something that decides where it lands.
 */
function candidatePrefixIsAmbiguous(seg, start) {
  const prefix = seg[start - 1];
  if (prefix === undefined) return false; // the candidate starts the segment
  if (prefix === "'" || prefix === '"') {
    const beforeQuote = seg[start - 2];
    return beforeQuote !== undefined && !QUOTED_CANDIDATE_OPENS_WORD_RE.test(beforeQuote);
  }
  return !UNQUOTED_CANDIDATE_OPENS_WORD_RE.test(prefix);
}

/**
 * extractTokenPathCandidates(seg, token) -> [{ path, ambiguousPrefix }]
 *
 * Every occurrence of `token` in `seg` that sits on path-component boundaries, expanded
 * leftwards over path characters into the path the command actually names. Occurrences that
 * are merely part of a longer filename component yield nothing (that is the #682 bug).
 */
function extractTokenPathCandidates(seg, token) {
  const hay = seg.toLowerCase();
  const needle = token.toLowerCase();
  const candidates = [];
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at === -1) break;
    from = at + 1;
    // The token must END the path: `trust.bundle.json` / `state.jsonx` are other files.
    const after = seg[at + token.length];
    if (after !== undefined && (PATH_COMPONENT_CHAR_RE.test(after) || after === '/')) continue;
    // ...and START a component: `notes-state.json` / `effective-state.json` are other files.
    const before = seg[at - 1];
    if (before !== undefined && PATH_COMPONENT_CHAR_RE.test(before)) continue;
    let start = at;
    while (start > 0 && PATH_CANDIDATE_CHAR_RE.test(seg[start - 1])) start--;
    candidates.push({
      path: seg.slice(start, at + token.length),
      ambiguousPrefix: candidatePrefixIsAmbiguous(seg, start),
    });
  }
  return candidates;
}

/**
 * Decide one recovered interpreter path candidate. Fails closed on every form whose
 * destination cannot be established (truncating substitution, shell expansion, bare basename
 * with no directory context, relative path under an in-command `cd`); otherwise defers to the
 * shared shape + declared-root decision used by the redirect/tee and cp/mv detectors.
 */
function interpreterCandidateBlocks(candidate, ambiguousPrefix, cwd, command) {
  if (ambiguousPrefix) return true;
  const resolved = resolveCandidatePath(candidate, cwd);
  // Ambiguous == a bare basename (proves nothing about location, #783) or an unresolvable
  // shell construct. Both keep the pre-#682 block.
  if (resolved.ambiguous || !resolved.path) return true;
  // #783 review F2: an in-command directory change makes RELATIVE resolution unsound -- the
  // shell resolves against a cwd we did not model. Rooted candidates are unaffected.
  const rooted = candidate.startsWith('/') || candidate.startsWith('~/');
  if (!rooted && commandChangesDirectory(command)) return true;
  // An interpreter body is not a syntactically unambiguous write target the way a redirect
  // target or a cp destination is, so this detector deliberately stays STRICTER than
  // protectedTargetBlocks: a gate-file SHAPE blocks on its own, with no declared-root relief.
  // That is pre-#682 parity for the sidecar tokens (which never received #783 scoping relief,
  // because the token literal handed to the resolver was always a bare basename), and it keeps
  // `node -e ... '/repo/.kontourai/flow-agents/<slug>/state.json'` blocked even when that root
  // does not exist on this machine. Fixture authoring has a sanctioned affordance (the sidecar
  // fixture writer, named in the block message); an interpreter one-liner is not it.
  const norm = candidate.replace(/\\/g, '/');
  if (REDIRECT_ARTIFACT_RE.test(norm) || REDIRECT_GLOBAL_RE.test(norm)) return true;
  // Not lexically gate-shaped: the shared decision still canonicalizes it, so a symlink
  // laundering an innocent spelling into a declared root cannot slip past.
  return protectedTargetBlocks(candidate, cwd, command);
}

/**
 * checkInterpreterWriteToProtected(command, cwd): detect interpreter invocations
 * (see INTERPRETER_WRITE_RE) in segments that name a protected path.
 *
 * Returns a human-readable description of the match, or null if not detected.
 *
 * #682: "name a protected path" is decided per PATH, not per substring. Each token occurrence
 * must sit on path-component boundaries (so `x-trust.bundle.json` and `effective-state.json`
 * -- different files that merely contain the token text -- match nothing), and the path
 * recovered around it is what gets resolved and scoped by interpreterCandidateBlocks. Root
 * scoping (issue 783 follow-up) therefore now runs on the path the command actually names
 * instead of on the token literal, which was always a bare basename and so always ambiguous:
 * before #682 that made every occurrence fail closed, blocking reads of unrelated files and
 * of files outside the repo entirely. Candidates whose destination genuinely cannot be
 * established (bare basename, shell expansion, truncating command substitution, relative path
 * under an in-command `cd`) still fail closed exactly as before.
 *
 * #799: BEFORE any block decision, checks isProvablyReadOnlyCommand(command, {tokenize,
 * splitSegments}) -- a narrow, POSITIVE-match grammar (see lib/read-only-grammar.js) that
 * recognizes only two exact templates -- `py(2|3)? -m json.tool <path>` and
 * `cat <path> | py(2|3)? -m json.tool` -- under a raw charset gate that excludes quotes,
 * expansions, redirections, and every separator except a single `|`. Interpreter BODIES are
 * never analyzed (a v1 body heuristic was removed after adversarial review showed it was a
 * deny-list, not a proof). Anything else is NOT fast-passed and falls through to the
 * substring-match detection below exactly as before.
 *
 * INCOMPLETE COVERAGE — see module header for honest framing.
 */
function checkInterpreterWriteToProtected(command, cwd) {
  if (typeof command !== 'string' || !command) return null;
  // Fast path: skip if no interpreter keywords present.
  if (!command.includes('node') && !command.includes(_PY_CMD) &&
      !command.includes('sed') && !command.includes('perl')) return null;

  // #799: a command that is PROVABLY read-only (see lib/read-only-grammar.js) never blocks
  // here, regardless of which protected-path token it happens to mention as a literal
  // substring below. Ambiguous/unparseable commands are NOT covered by this grammar and fall
  // through to the substring-match detection unchanged.
  if (isProvablyReadOnlyCommand(command, { tokenize, splitSegments })) return null;

  const segments = splitSegments(command);
  for (const seg of segments) {
    // Check interpreter pattern (plus the json.tool outfile write shape, which the `-c`-only
    // regex cannot see -- see isJsonToolWriteShape above).
    const interpMatch = INTERPRETER_WRITE_RE.exec(seg);
    const jsonToolWrite = !interpMatch && isJsonToolWriteShape(seg);
    if (!interpMatch && !jsonToolWrite) continue;
    const matchLabel = interpMatch ? interpMatch[0].trim() : _PY_CMD + '3 -m json.tool <outfile form>';

    // Check for protected-path tokens in the same segment. #682: a bare SUBSTRING match is not
    // a path — every occurrence must sit on path-component boundaries, and the decision is made
    // against the PATH recovered around it, not against the token literal.
    // #783 review F1: GLOBAL kill-switch tokens (shell profiles, .claude settings) still block
    // on a boundary match alone — they have no fixture use and must not receive root-scoping
    // relief. Artifact tokens go through the fail-closed resolver (bare basenames stay
    // ambiguous → blocked; the cd-in-command guard applies as everywhere else).
    // Case-insensitive segment match (confirmation-review F1 variant): the defended
    // filesystems are commonly case-insensitive, so '.CLAUDE/Settings.json' is the same file.
    const segLower = seg.toLowerCase();
    for (const token of INTERPRETER_PROTECTED_TOKENS) {
      if (!segLower.includes(token.toLowerCase())) continue;
      const candidates = extractTokenPathCandidates(seg, token);
      if (candidates.length === 0) continue; // token text only ever appeared inside another name
      if (INTERPRETER_GLOBAL_TOKENS.has(token)) {
        return `${matchLabel} with protected path token "${token}"`;
      }
      for (const candidate of candidates) {
        if (interpreterCandidateBlocks(candidate.path, candidate.ambiguousPrefix, cwd, command)) {
          return `${matchLabel} with protected path token "${token}"`;
        }
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
const DELIVERY_COPY_PROTECTED_RE = /(?:^|\/)delivery\/(?:[^/]+\/)?trust\.bundle$|(?:^|\/)delivery\/(?:[^/]+\/)?trust\.checkpoint\.json$/i;

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
  // #783 fourth-pass closure: NO textual content gate — an innocent-name symlink destination
  // carries neither the delivery/ spelling nor a trust-anchor basename, so the only sound
  // fast path is the command-name check above. protectedTargetBlocks canonicalizes each
  // destination candidate (one realpath walk per cp/mv/install command — negligible).

  const segments = splitSegments(command);
  for (const seg of segments) {
    const tokens = tokenize(seg);
    if (tokens.length < 2) continue;
    const cmd = tokens[0];
    if (cmd !== "cp" && cmd !== "mv" && cmd !== "install") continue;

    // #783 fifth-pass closure: option-aware destination parsing. `-t DIR` /
    // `--target-directory[=DIR]` name the destination explicitly; value-taking flags
    // (install -m 0644, cp --suffix .bak, ...) must not have their VALUES mistaken for the
    // destination positional.
    const VALUE_FLAGS = new Set(["-t", "-m", "-o", "-g", "-S", "--mode", "--owner", "--group", "--suffix", "--backup", "--target-directory", "--context"]);
    const positional = [];
    let targetDir = null;
    for (let i = 1; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok === "--") { for (let j = i + 1; j < tokens.length; j++) positional.push(tokens[j]); break; }
      if (tok.startsWith("--target-directory=")) { targetDir = tok.slice("--target-directory=".length); continue; }
      if (tok === "-t" || tok === "--target-directory") { if (i + 1 < tokens.length) { targetDir = tokens[i + 1]; i++; } continue; }
      // GNU attached short form: -tDIR (sixth-pass closure).
      if (tok.startsWith("-t") && !tok.startsWith("--") && tok.length > 2) { targetDir = tok.slice(2); continue; }
      if (tok.startsWith("--") && tok.includes("=")) continue;
      if (tok.startsWith("-") && tok !== "-") { if (VALUE_FLAGS.has(tok) && i + 1 < tokens.length) i++; continue; }
      positional.push(tok);
    }
    if (targetDir !== null) {
      // Every positional is a SOURCE; effective destination = targetDir/<basename(src)>.
      const dirClean = targetDir.replace(/\/+$/, "");
      const candidates = [targetDir, ...positional.map((src) => `${dirClean}/${path.basename(src.replace(/\\/g, '/'))}`)];
      for (const candidate of candidates) {
        if (protectedTargetBlocks(candidate, cwd, command) || (matchesDeliveryProtected(candidate) && (commandChangesDirectory(command) || isCandidateWithinDeclaredRoots(candidate, cwd)))) {
          return `${cmd} into ${targetDir} (delivery-protected destination)`;
        }
      }
      continue;
    }
    if (positional.length === 0) continue;

    const dest = positional[positional.length - 1];
    if (protectedTargetBlocks(dest, cwd, command) || (matchesDeliveryProtected(dest) && (commandChangesDirectory(command) || isCandidateWithinDeclaredRoots(dest, cwd)))) {
      return `${cmd} to ${dest} (delivery-protected path)`;
    }
    // Third-pass closure: `cp /tmp/trust.bundle delivery/` writes dest/<source-basename> —
    // when a SOURCE carries a trust-anchor basename, test the effective destination path too.
    for (let s = 0; s < positional.length - 1; s++) {
      const srcBase = path.basename(positional[s].replace(/\\/g, '/'));
      if (!/^(trust\.bundle|trust\.checkpoint\.json|state\.json|current\.json)$/i.test(srcBase)) continue;
      const effective = `${dest.replace(/\/+$/, '')}/${srcBase}`;
      if (protectedTargetBlocks(effective, cwd, command) || (matchesDeliveryProtected(effective) && (commandChangesDirectory(command) || isCandidateWithinDeclaredRoots(effective, cwd)))) {
        return `${cmd} of ${srcBase} into ${dest} (delivery-protected destination)`;
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
    const basename = path.basename(filePath).toLowerCase();
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
          FIXTURE_AFFORDANCE_HINT + ' ' + READ_REMEDIATION_HINT,
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
          FIXTURE_AFFORDANCE_HINT + ' ' + READ_REMEDIATION_HINT,
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
          FIXTURE_AFFORDANCE_HINT + ' ' + READ_REMEDIATION_HINT,
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
