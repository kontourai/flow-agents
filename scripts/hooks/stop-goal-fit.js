#!/usr/bin/env node
/**
 * Stop Hook: warn when an active workflow is about to stop short of its goal.
 *
 * The hook reads .flow-agents artifacts, looks for the most recent active
 * delivery/session file, and reports missing Definition Of Done, Goal Fit, or
 * Final Acceptance state.
 *
 * Enforcement is controlled by FLOW_AGENTS_GOAL_FIT_MODE:
 *   - block: return exit code 2 (blocks the Stop) when local goal fit is incomplete.
 *   - warn:  return exit code 0 but still emit the guidance on stderr (default).
 *   - off:   stay silent.
 * The legacy FLOW_AGENTS_GOAL_FIT_STRICT=true is honored as an alias for block.
 * The canonical engine default is warn; shipped runtime configs (e.g. Claude
 * Code at L2) set block so the installed product enforces while the engine
 * default and conformance contract stay warn.
 *
 * Scope: the gate evaluates the session's current task (.flow-agents/current.json)
 * when set, so an unrelated active workflow elsewhere in the repo does not gate
 * this stop. It also never hard-blocks a pre-execution (not-yet-started) task on
 * mere incompleteness — only genuine false-completion signals (a claimed pass the
 * capture log or evidence.json contradicts) block before execution begins.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MAX_STDIN = 1024 * 1024;
const ACTIVE_STATUSES = new Set([
  'planning',
  'planned',
  'executing',
  'executed',
  'reviewing',
  'verifying',
  'failed',
  'needs-decision',
  'in-progress',
  'blocked',
  'partial',
]);
// WORKFLOW_SESSION_TYPES: used for artifact identification only, not for verdict production.
const WORKFLOW_SESSION_TYPES = new Set(['deliver', 'delivery', 'fix-bug', 'execute-plan', 'verify-work']);
const SIDECAR_NAMES = new Set(['state.json', 'acceptance.json', 'evidence.json', 'handoff.json']);
const OPTIONAL_SIDECAR_NAMES = new Set(['critique.json']);

// A workflow that has not started execution is EXPECTED to be incomplete, so the
// Stop gate must not hard-block on its missing DOD / Goal Fit / not-done state.
// Only genuine false-completion signals block a pre-execution task; execution
// onward gates fully.
const PRE_EXECUTION_STATUSES = new Set(['new', 'planning', 'planned', 'backlog']);
const PRE_EXECUTION_PHASES = new Set(['idea', 'backlog', 'pickup', 'planning']);

// Terminal tasks are complete — they must never gate a stop or count as "active".
// A stale current.json pointing at one, or a graveyard of finished states, must
// not block an unrelated session.
const TERMINAL_STATUSES = new Set(['done', 'delivered', 'accepted', 'archived', 'complete', 'completed']);

function parseJson(raw) {
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

function findRepoRoot(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  const root = path.parse(dir).root;
  for (let depth = 0; dir && depth < 40; depth++) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, 'AGENTS.md'))) return dir;
    if (dir === root) break;
    dir = path.dirname(dir);
  }
  return path.resolve(startDir || process.cwd());
}

function walkMarkdown(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'archive') continue;
      walkMarkdown(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

function readArtifact(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const stat = fs.statSync(file);
  const status = (text.match(/^status:\s*([A-Za-z0-9_-]+)/m) || [])[1] || '';
  const type = (text.match(/^type:\s*([A-Za-z0-9_-]+)/m) || [])[1] || '';
  const role = (text.match(/^role:\s*([A-Za-z0-9_-]+)/m) || [])[1] || '';
  return { file, text, status, type, role, mtimeMs: stat.mtimeMs };
}

function hasSidecars(dir) {
  try {
    return fs.readdirSync(dir).some(name => SIDECAR_NAMES.has(name));
  } catch {
    return false;
  }
}

/**
 * Returns true if a line of validator output looks like a validator-environment
 * error (shell/npm error, tsc missing, spawn failure) rather than a real
 * artifact validation message. Environment errors must never block goal-fit.
 */
function isEnvironmentError(line) {
  return /tsc[:\s]|command not found|npm ERR!|npm error|ENOENT|EACCES|Cannot find module|node_modules\/.bin|TypeScript version|version conflict|error TS[0-9]/i.test(line);
}

function sidecarValidation(root, artifactDir) {
  const requireSidecars = String(process.env.FLOW_AGENTS_REQUIRE_SIDECARS || '').toLowerCase() === 'true';
  const requireCritique = String(process.env.FLOW_AGENTS_REQUIRE_CRITIQUE || '').toLowerCase() === 'true';
  if (!requireSidecars && !requireCritique && !hasSidecars(artifactDir)) return [];

  const packageRoot = fs.existsSync(path.join(root, 'package.json'))
    ? root
    : path.resolve(__dirname, '..', '..');

  let sidecarFiles = [];
  try {
    sidecarFiles = fs.readdirSync(artifactDir)
      .filter(name => SIDECAR_NAMES.has(name) || OPTIONAL_SIDECAR_NAMES.has(name))
      .map(name => path.join(artifactDir, name));
  } catch {
    sidecarFiles = [];
  }

  if (requireSidecars || requireCritique) {
    const present = new Set(sidecarFiles.map(file => path.basename(file)));
    const requiredNames = new Set(requireSidecars ? SIDECAR_NAMES : []);
    if (requireCritique) requiredNames.add('critique.json');
    const missing = [...requiredNames].filter(name => !present.has(name)).sort();
    if (missing.length > 0) {
      return missing.map(name => `${relative(root, path.join(artifactDir, name))} sidecar validation: required sidecar is missing`);
    }
  }

  if (sidecarFiles.length === 0) return [];

  // Part 1 fix: invoke the already-built validator directly via `node`, bypassing
  // `npm run build` (tsc). npm-installed packages ship build/ in the package files,
  // so the compiled JS is always available. Only fall back to npm run if build/ is
  // absent (a raw dev checkout that hasn't been built yet).
  const builtValidator = path.join(packageRoot, 'build', 'src', 'cli', 'validate-workflow-artifacts.js');
  const hasBuild = fs.existsSync(builtValidator);

  const validatorArgs = ['--skip-markdown-validation'];
  if (requireSidecars) validatorArgs.push('--require-sidecars');
  if (requireCritique) validatorArgs.push('--require-critique');
  validatorArgs.push(artifactDir);

  let result;
  if (hasBuild) {
    // Direct node invocation: no tsc, no npm build step, works from any npm install.
    result = spawnSync(process.execPath, [builtValidator, ...validatorArgs], {
      cwd: packageRoot,
      encoding: 'utf8',
      timeout: 30000,
    });
  } else {
    // Dev checkout without build/: fall back to npm run (may trigger tsc).
    // If this also fails due to environment issues, Part 2 handles it below.
    const npmArgs = ['run', 'workflow:validate-artifacts', '--silent', '--', ...validatorArgs];
    result = spawnSync('npm', npmArgs, {
      cwd: packageRoot,
      encoding: 'utf8',
      timeout: 30000,
    });
  }

  // Part 2 fix: treat validator-environment failures as SKIP, never as blocking.
  // A spawn error (ENOENT, timeout) means the validator couldn't run at all.
  if (result.error) {
    // Validator couldn't be launched — environment issue, not a goal-fit failure.
    return [`${relative(root, artifactDir)} sidecar validation skipped: validator could not run (${result.error.code || result.error.message})`];
  }

  if (result.status === 0) return [];

  // Validator ran and exited non-zero. Separate real validation errors from
  // environment errors (tsc missing, npm ERR!, shell errors) so that a broken
  // validator environment never blocks goal-fit.
  const allLines = `${result.stdout || ''}\n${result.stderr || ''}`
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  const envLines = allLines.filter(isEnvironmentError);
  const validationLines = allLines.filter(line => !isEnvironmentError(line));

  if (envLines.length > 0 && validationLines.length === 0) {
    // Pure environment failure — skip, do not block.
    return [`${relative(root, artifactDir)} sidecar validation skipped: validator environment error (${envLines[0].slice(0, 120)})`];
  }

  // Real validation errors (possibly mixed with a few env noise lines).
  const output = validationLines.length > 0 ? validationLines : allLines;
  const trimmed = output.slice(0, 12);
  if (trimmed.length === 0) trimmed.push(`validator exited with status ${result.status ?? 'unknown'}`);
  return trimmed.map(line => `${relative(root, artifactDir)} sidecar validation: ${line}`);
}

function isWorkflowArtifact(artifact) {
  if (!artifact) return false;
  if (artifact.role === 'plan' || artifact.role === 'review') return false;
  if (artifact.file.endsWith('-plan.md') || artifact.file.endsWith('-review.md')) return false;
  if (WORKFLOW_SESSION_TYPES.has(artifact.type)) return true;
  return /--(deliver|fix-bug|execute-plan|verify-work)\b/.test(path.basename(artifact.file));
}

function uncheckedInSection(text, heading) {
  const start = text.indexOf(`## ${heading}`);
  if (start < 0) return [];
  const rest = text.slice(start + heading.length + 3);
  const next = rest.search(/\n##\s+/);
  const section = next >= 0 ? rest.slice(0, next) : rest;
  return section
    .split('\n')
    .filter(line => /^\s*-\s+\[\s\]/.test(line))
    .map(line => line.replace(/^\s*-\s+\[\s\]\s*/, '').trim())
    .filter(Boolean);
}

function hasHeading(text, heading) {
  return new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(text);
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// ─── ADR 0010 Phase 2b: re-derive-at-gate via Surface (fail-open) ─────────────
// Surface (@kontourai/surface) is ESM-only; stop-goal-fit.js is CJS.
// Load it via a fail-open dynamic import(), cached after the first attempt.
// If Surface cannot be loaded (package absent, env mismatch), we fall back to
// the stored claim.status check from #133 — no regression for environments that
// lack @kontourai/surface. The module is never written to disk.
let _surfaceModule; // undefined = not tried yet; null = unavailable
async function tryLoadSurface() {
  if (_surfaceModule !== undefined) return _surfaceModule;
  try {
    const m = await import('@kontourai/surface');
    _surfaceModule = m;
    return _surfaceModule;
  } catch {
    _surfaceModule = null;
    return null;
  }
}

function safeOneLine(value, maxLength = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function normalizedStatus(value) {
  return safeOneLine(value, 80).toLowerCase();
}

function sidecarGuidance(root, artifactDir) {
  const warnings = [];
  const state = readJsonFile(path.join(artifactDir, 'state.json'));
  const evidence = readJsonFile(path.join(artifactDir, 'evidence.json'));
  const critique = readJsonFile(path.join(artifactDir, 'critique.json'));
  const base = relative(root, artifactDir);

  if (state) {
    const status = normalizedStatus(state.status || 'unknown');
    const phase = normalizedStatus(state.phase || 'unknown');
    const next = state.next_action && typeof state.next_action === 'object' ? state.next_action : null;
    const nextStatus = next ? normalizedStatus(next.status || 'unknown') : 'unknown';
    // The agent's work is complete when the recorded next action is done — the
    // gate must not block the agent for a remaining human/CI step (e.g. a verified
    // task whose only next_action is "commit the migration").
    const agentComplete = nextStatus === 'done';
    if (!TERMINAL_STATUSES.has(status) && !agentComplete) {
      const nextSummary = next && next.summary ? `; next_action:${nextStatus} "${safeOneLine(next.summary)}"` : '';
      warnings.push(`${base} workflow state: status:${status} phase:${phase}${nextSummary}`);
    }
  }

  if (state && state.next_action && normalizedStatus(state.next_action.status) !== 'done') {
    const next = state.next_action;
    warnings.push(`${base} next action: ${safeOneLine(next.summary)}${next.target_phase ? ` (target phase: ${safeOneLine(next.target_phase, 80)})` : ''}`);
  }

  if (evidence && normalizedStatus(evidence.verdict) && normalizedStatus(evidence.verdict) !== 'pass') {
    warnings.push(`${base} evidence verdict:${safeOneLine(evidence.verdict, 40)}; do not deliver without accepted gap or new evidence.`);
  }
  if (evidence && Array.isArray(evidence.not_verified_gaps) && evidence.not_verified_gaps.length > 0) {
    for (const gap of evidence.not_verified_gaps.slice(0, 3)) {
      warnings.push(`${base} evidence NOT_VERIFIED gap: ${safeOneLine(gap)}`);
    }
  }
  if (evidence && Array.isArray(evidence.checks)) {
    const blockingChecks = evidence.checks.filter(check => {
      const status = normalizedStatus(check && check.status);
      return status === 'fail' || status === 'failed' || status === 'not_verified' || status === 'not-verified';
    });
    for (const check of blockingChecks.slice(0, 4)) {
      const status = safeOneLine(check.status || 'unknown', 40);
      warnings.push(`${base} evidence check ${safeOneLine(check.id || 'unknown', 80)} status:${status}: ${safeOneLine(check.summary)}`);
    }
  }

  if (critique && critique.required === true && normalizedStatus(critique.status) !== 'pass') {
    warnings.push(`${base} critique status:${safeOneLine(critique.status || 'unknown', 40)}; required critique must pass or findings be accepted.`);
    const critiques = Array.isArray(critique.critiques) ? critique.critiques : [];
    let openCount = 0;
    for (const review of critiques) {
      const findings = Array.isArray(review && review.findings) ? review.findings : [];
      for (const finding of findings) {
        if (!finding || normalizedStatus(finding.status) !== 'open') continue;
        warnings.push(`${base} critique open ${safeOneLine(finding.severity || 'unknown', 40)}: ${safeOneLine(finding.description)}`);
        openCount += 1;
        if (openCount >= 3) break;
      }
      if (openCount >= 3) break;
    }
  }

  return warnings;
}

// -----------------------------------------------------------------------
// Capture-first evidence determinism (Part B)
//
// evidence.json is the MODEL transcribing what it thinks happened. The capture
// hook (evidence-capture.js) writes the REAL command results to
// command-log.jsonl at the source. Here at the Stop gate we cross-reference the
// model's claimed-pass command checks against that captured truth, and only fall
// back to re-running a TRUSTED command when the log has no execution for a
// claimed-pass command (i.e. it was never actually run).
// -----------------------------------------------------------------------

function normalizeCommand(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * Read command-log.jsonl into a map of normalized-command -> aggregate outcome.
 * If the same command was run more than once, a single FAIL makes the aggregate
 * a fail (a caught false-completion must not be masked by a later pass-claim).
 */
function readCommandLog(artifactDir) {
  const file = path.join(artifactDir, 'command-log.jsonl');
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return new Map(); }
  const byCommand = new Map();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch { continue; }
    if (!entry || typeof entry.command !== 'string') continue;
    const key = normalizeCommand(entry.command);
    if (!key) continue;
    const failed = entry.observedResult === 'fail' || (Number.isInteger(entry.exitCode) && entry.exitCode !== 0);
    const prev = byCommand.get(key);
    byCommand.set(key, {
      ran: true,
      failed: failed || (prev ? prev.failed : false),
      exitCode: Number.isInteger(entry.exitCode) ? entry.exitCode : (prev ? prev.exitCode : null),
    });
  }
  return byCommand;
}

/**
 * Resolve a TRUSTED command to re-run for a claimed-pass check whose command was
 * never captured. Priority (most trusted first):
 *   (a) the command named by the matching acceptance criterion (acceptance.json
 *       evidence_ref of kind "command", `excerpt`/`command`) — authored upfront.
 *   (b) the project's declared manifest target — package.json scripts.{test,
 *       build,lint}, Makefile target, cargo test, pyproject/tox, just/task.
 *   (c) the model's free-form evidence.checks[].command — ONLY when
 *       FLOW_AGENTS_GOAL_FIT_RECHECK=true (the RCE-risky opt-in path).
 * Returns { argv, cwd, source } or null when nothing trusted resolves.
 */
function resolveTrustedCommand(root, artifactDir, check, acceptance) {
  // (a) acceptance criterion command for the matching criterion.
  const fromAcceptance = acceptanceCommandFor(check, acceptance);
  if (fromAcceptance) return { argv: ['bash', '-lc', fromAcceptance], cwd: root, source: 'acceptance' };

  // (b) declared manifest target. Map the check command/id to a declared script.
  const declared = declaredManifestTarget(root, check);
  if (declared) return { argv: declared.argv, cwd: declared.cwd || root, source: 'manifest' };

  // (c) free-form model command — opt-in only.
  if (String(process.env.FLOW_AGENTS_GOAL_FIT_RECHECK || '').toLowerCase() === 'true') {
    const cmd = normalizeCommand(check && check.command);
    if (cmd) return { argv: ['bash', '-lc', cmd], cwd: root, source: 'model-command (FLOW_AGENTS_GOAL_FIT_RECHECK)' };
  }
  return null;
}

function acceptanceCommandFor(check, acceptance) {
  if (!acceptance || !Array.isArray(acceptance.criteria)) return null;
  const checkId = normalizedStatus(check && check.id);
  const checkCmd = normalizeCommand(check && check.command);
  let firstCommand = null;
  for (const criterion of acceptance.criteria) {
    const refs = Array.isArray(criterion && criterion.evidence_refs) ? criterion.evidence_refs : [];
    for (const ref of refs) {
      if (!ref || typeof ref !== 'object' || ref.kind !== 'command') continue;
      const refCmd = normalizeCommand(ref.excerpt || ref.command);
      if (!refCmd) continue;
      if (!firstCommand) firstCommand = refCmd;
      // Strong match: the criterion id matches the check id, or the commands match.
      const idMatch = checkId && normalizedStatus(criterion.id) === checkId;
      if (idMatch || (checkCmd && refCmd === checkCmd)) return refCmd;
    }
  }
  // No id/command match — only fall back to the first authored command when the
  // check itself names no command (so we still have an upfront-trusted target).
  return checkCmd ? null : firstCommand;
}

/**
 * Map a claimed-pass command check to a project-declared, NAMED manifest target.
 * Never allowlists arbitrary strings: we only run a target the project itself
 * declared (npm script, Makefile target, cargo/tox/just/task). The check's
 * command/id is used to pick WHICH declared target (test|build|lint), not to run
 * the raw string. `veritas readiness` is just one such declared command — no
 * special-casing.
 */
function declaredManifestTarget(root, check) {
  const haystack = `${normalizeCommand(check && check.command)} ${normalizedStatus(check && check.id)} ${normalizedStatus(check && check.kind)}`.toLowerCase();
  let want = null;
  if (/\btest|spec|jest|vitest|pytest\b/.test(haystack)) want = 'test';
  else if (/\bbuild|compile|bundle\b/.test(haystack)) want = 'build';
  else if (/\blint|format|style|typecheck\b/.test(haystack)) want = 'lint';
  if (!want) return null;

  // package.json scripts.{test,build,lint}
  const pkg = readJsonFile(path.join(root, 'package.json'));
  if (pkg && pkg.scripts && typeof pkg.scripts === 'object') {
    const scriptName = pkg.scripts[want] ? want
      : want === 'lint' && pkg.scripts.typecheck ? 'typecheck'
        : null;
    if (scriptName) return { argv: ['npm', 'run', scriptName, '--silent'], cwd: root };
  }
  // Makefile target
  const makefile = ['Makefile', 'makefile', 'GNUmakefile'].map(n => path.join(root, n)).find(p => fs.existsSync(p));
  if (makefile) {
    try {
      const text = fs.readFileSync(makefile, 'utf8');
      if (new RegExp(`^${want}\\s*:`, 'm').test(text)) return { argv: ['make', want], cwd: root };
    } catch { /* ignore */ }
  }
  // cargo
  if (want === 'test' && fs.existsSync(path.join(root, 'Cargo.toml'))) return { argv: ['cargo', 'test'], cwd: root };
  if (want === 'build' && fs.existsSync(path.join(root, 'Cargo.toml'))) return { argv: ['cargo', 'build'], cwd: root };
  // py ecosystem: tox / pyproject (declared test target)
  if (want === 'test' && fs.existsSync(path.join(root, 'tox.ini'))) return { argv: ['tox'], cwd: root };
  if (want === 'test' && fs.existsSync(path.join(root, 'pyproject.toml'))) return { argv: ['pytest'], cwd: root };
  // just / task runners
  for (const runner of [['just', 'justfile'], ['task', 'Taskfile.yml'], ['task', 'Taskfile.yaml']]) {
    if (fs.existsSync(path.join(root, runner[1]))) return { argv: [runner[0], want], cwd: root };
  }
  return null;
}

function resolveBackstopTimeout() {
  const raw = Number.parseInt(process.env.FLOW_AGENTS_GOAL_FIT_BACKSTOP_TIMEOUT_MS || '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 120000;
}

/**
 * Whether the trusted backstop re-run may ride block mode. Default-on so a
 * never-actually-run claimed-pass command is caught, but operator-disablable for
 * latency via FLOW_AGENTS_GOAL_FIT_BACKSTOP=off (re-run becomes warn-only) or
 * =skip (no re-run at all → record NOT_VERIFIED instead).
 */
function resolveBackstopMode() {
  const v = String(process.env.FLOW_AGENTS_GOAL_FIT_BACKSTOP || '').trim().toLowerCase();
  if (v === 'off' || v === 'warn' || v === 'skip' || v === 'block') return v === 'warn' ? 'off' : v;
  return 'block';
}

function runBackstop(trusted) {
  const result = spawnSync(trusted.argv[0], trusted.argv.slice(1), {
    cwd: trusted.cwd,
    encoding: 'utf8',
    timeout: resolveBackstopTimeout(),
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) return { ran: false, error: result.error.code || result.error.message };
  if (result.signal) return { ran: false, error: `killed (${result.signal})`, timedOut: result.signal === 'SIGKILL' || result.signal === 'SIGTERM' };
  return { ran: true, passed: result.status === 0, exitCode: result.status };
}

/**
 * Cross-reference each evidence.checks[] of kind:"command" claiming status:"pass"
 * that carries a command against the capture log, with the trusted backstop as a
 * thin fallback only when the log has no execution for that command.
 *
 * Emits warnings (which feed the existing block/MAX_BLOCKS machinery) when a
 * claimed-pass command actually FAILED (log or backstop), and NOT_VERIFIED notes
 * when nothing trusted can confirm it.
 */
function captureCrossReference(root, artifactDir) {
  const evidence = readJsonFile(path.join(artifactDir, 'evidence.json'));
  if (!evidence || !Array.isArray(evidence.checks)) return [];
  const acceptance = readJsonFile(path.join(artifactDir, 'acceptance.json'));
  const log = readCommandLog(artifactDir);
  const base = relative(root, artifactDir);
  const backstopMode = resolveBackstopMode();
  const warnings = [];

  const claimedPass = evidence.checks.filter(check => {
    if (!check || typeof check !== 'object') return false;
    const kind = normalizedStatus(check.kind);
    const status = normalizedStatus(check.status);
    return kind === 'command' && (status === 'pass' || status === 'passed') && normalizeCommand(check.command);
  });

  for (const check of claimedPass.slice(0, 8)) {
    const cmd = normalizeCommand(check.command);
    const id = safeOneLine(check.id || cmd, 80);
    const logged = log.get(cmd);

    if (logged && logged.ran) {
      // (1) Cross-reference the capture log first.
      if (logged.failed) {
        const exit = Number.isInteger(logged.exitCode) ? ` (exitCode:${logged.exitCode})` : '';
        warnings.push(`${base} evidence check ${id}: capture log CONTRADICTS claimed pass — command "${safeOneLine(cmd, 120)}" was recorded as FAIL${exit}. This is a caught false-completion.`);
      }
      // log shows it ran and passed → satisfied deterministically, no re-run.
      continue;
    }

    // (2) Backstop: the log has NO execution for this claimed-pass command.
    if (backstopMode === 'skip') {
      warnings.push(`${base} evidence check ${id}: claimed pass but NOT_VERIFIED — command "${safeOneLine(cmd, 120)}" was never captured and backstop re-run is disabled (FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip).`);
      continue;
    }
    const trusted = resolveTrustedCommand(root, artifactDir, check, acceptance);
    if (!trusted) {
      warnings.push(`${base} evidence check ${id}: claimed pass but NOT_VERIFIED — command "${safeOneLine(cmd, 120)}" was never captured and no trusted command (acceptance criterion / declared manifest target) resolves to re-run it. Set FLOW_AGENTS_GOAL_FIT_RECHECK=true to opt into re-running the model's free-form command.`);
      continue;
    }
    const outcome = runBackstop(trusted);
    if (!outcome.ran) {
      warnings.push(`${base} evidence check ${id}: claimed pass but NOT_VERIFIED — trusted backstop (${trusted.source}) could not run (${safeOneLine(outcome.error, 80)}).`);
      continue;
    }
    if (!outcome.passed) {
      const note = `${base} evidence check ${id}: trusted backstop (${trusted.source}) re-run of "${trusted.argv.join(' ')}" FAILED with exit ${outcome.exitCode}, contradicting the claimed pass. This is a caught false-completion.`;
      if (backstopMode === 'off') warnings.push(`${note} [backstop in warn mode — not blocking]`);
      else warnings.push(note);
    }
    // backstop passed → claim deterministically confirmed by re-run, no warning.
  }

  return warnings;
}

// ─── ADR 0010 Phase 2: enforce on the canonical Hachure trust.bundle ──────────
// The trust.bundle (emitted by workflow-sidecar via @kontourai/surface) carries
// each claim's Surface-derived status — including capture-authoritative results
// (a claimed-pass whose captured command FAILED is already `disputed` here). A
// high-impact `disputed` claim is the canonical false-completion signal; we gate
// on the bundle the producers already emit, not on bespoke markdown.
//
// ADR 0010 Phase 2b: re-derive-at-gate hardening.
// We re-derive each claim's status from the bundle's own evidence/events/policies
// via Surface's canonical deriveClaimStatus, so editing the stored `claim.status`
// field does not bypass the gate. If the re-derived status is disputed/rejected
// for a high/critical claim, we block. If the re-derived status DIFFERS from the
// stored status (e.g. stored "verified" but evidence re-derives to "disputed"),
// that mismatch is a strong tamper signal — block with an explicit warning.
// Fail-open: if Surface is unavailable, fall back to the stored-status check.
async function bundleEnforcement(artifactDir) {
  const bundle = readJsonFile(path.join(artifactDir, 'trust.bundle'));
  if (!bundle || !Array.isArray(bundle.claims)) return [];

  const surface = await tryLoadSurface();
  const warnings = [];

  const allEvidence = Array.isArray(bundle.evidence) ? bundle.evidence : [];
  const allEvents = Array.isArray(bundle.events) ? bundle.events : [];
  const allPolicies = Array.isArray(bundle.policies) ? bundle.policies : [];

  for (const claim of bundle.claims) {
    if (!claim || typeof claim !== 'object') continue;
    const impact = String(claim.impactLevel || '').toLowerCase();
    const storedStatus = String(claim.status || '').toLowerCase();
    if (impact !== 'high' && impact !== 'critical') continue;

    // Step 1: Re-derive status via Surface when available.
    // This closes the gaming vector: editing the stored status field cannot bypass
    // the gate because we recompute from evidence/events/policies.
    let recomputedStatus = null; // null means re-derive was not attempted or threw
    if (surface && typeof surface.deriveClaimStatus === 'function') {
      const claimId = claim.id;
      const claimEvidence = allEvidence.filter(ev => ev && ev.claimId === claimId);
      const claimEvents = allEvents.filter(evt => evt && evt.claimId === claimId);
      try {
        const result = surface.deriveClaimStatus({
          claim,
          evidence: claimEvidence,
          events: claimEvents,
          policies: allPolicies,
        });
        recomputedStatus = result && typeof result.status === 'string' ? result.status.toLowerCase() : 'unknown';
      } catch {
        // deriveClaimStatus threw (e.g. schema mismatch) — fall back to stored status.
        recomputedStatus = null;
      }
    }

    // Step 2: Compute the effective blocking status.
    // Use the STRICTER of stored vs recomputed so neither can be individually
    // gamed: deleting evidence cannot clear a stored `disputed`, and flipping
    // stored to "verified" cannot hide a recomputed `disputed`.
    const effectiveDisputed = storedStatus === 'disputed' || storedStatus === 'rejected'
      || recomputedStatus === 'disputed' || recomputedStatus === 'rejected';

    if (!effectiveDisputed) continue; // neither stored nor recomputed is blocking

    // Step 3: Emit the appropriate warning.
    // Tamper-detection: stored "verified"/"assumed" but evidence re-derives to
    // "disputed"/"rejected" — the stored status was likely altered to bypass the gate.
    const isTampered = recomputedStatus !== null
      && (storedStatus === 'verified' || storedStatus === 'assumed')
      && (recomputedStatus === 'disputed' || recomputedStatus === 'rejected');

    if (isTampered) {
      warnings.push(`trust.bundle claim tampered: ${safeOneLine(claim.subjectId || claim.id, 80)} (${safeOneLine(claim.claimType, 48)}) — stored status "${storedStatus}" does not match recompute "${recomputedStatus}" (possible tampered bundle); caught false-completion.`);
    } else {
      warnings.push(`trust.bundle claim disputed: ${safeOneLine(claim.subjectId || claim.id, 80)} (${safeOneLine(claim.claimType, 48)}) — Surface recompute shows not verified; caught false-completion.`);
    }
  }
  return warnings;
}

/**
 * Scope to the session's current task when .flow-agents/current.json points at
 * one (mirroring evidence-capture.js). Returns the slug dir, or null to fall back
 * to scanning all of .flow-agents (newest-mtime).
 */
function preferredArtifactDir(flowAgentsDir) {
  const current = readJsonFile(path.join(flowAgentsDir, 'current.json'));
  if (!current) return null;
  const slug = current.artifact_dir || current.active_slug;
  if (typeof slug !== 'string' || !slug.trim()) return null;
  const safe = slug.replace(/\.\.+/g, '').replace(/^[/\\]+/, '');
  const dir = path.join(flowAgentsDir, safe);
  return dir.startsWith(flowAgentsDir + path.sep) && fs.existsSync(dir) ? dir : null;
}

/**
 * A task is pre-execution (work not yet started) when its state.json status/phase
 * is still in the idea→planning band, or (no state.json) its markdown status is.
 */
function isPreExecution(artifactDir, markdownStatus) {
  const state = readJsonFile(path.join(artifactDir, 'state.json'));
  if (state) {
    return PRE_EXECUTION_STATUSES.has(normalizedStatus(state.status))
      || PRE_EXECUTION_PHASES.has(normalizedStatus(state.phase));
  }
  return PRE_EXECUTION_STATUSES.has(normalizedStatus(markdownStatus));
}


// ─── Wave 2c: no-bundle/no-state fallback gate ────────────────────────────────
// Sessions that have NEITHER a trust.bundle NOR a state.json fall through
// both bundleEnforcement (no bundle) and sidecarGuidance (no state). Without the
// old markdown heading checks this would create a silent ungated-session path.
// If a trust.bundle exists, bundleEnforcement handles it. If state.json exists,
// sidecarGuidance handles it. The gap: a session with only a markdown artifact.
//
// Adjustment A (sidecar-driven Final Acceptance): when acceptance.json has
// pending criteria and the task state shows delivered, emit the Final Acceptance
// hygiene warning from the sidecar rather than markdown template parsing.
function missingBundleOrStateSignal(artifactDir) {
  const warnings = [];
  const hasBundle = fs.existsSync(path.join(artifactDir, 'trust.bundle'));
  const state = readJsonFile(path.join(artifactDir, 'state.json'));

  if (!hasBundle && !state) {
    // Neither trust.bundle nor state.json: session is untracked by sidecar path.
    // Emit a NOT_VERIFIED warning so execution-phase sessions remain gated.
    const base = path.basename(artifactDir);
    warnings.push(`${base} NOT_VERIFIED — no trust.bundle or state.json found; run 'workflow-sidecar record-evidence' to build the evidence record before delivery.`);
    return warnings;
  }

  // Adjustment A: sidecar-driven Final Acceptance hygiene.
  // When the task is delivered but acceptance.json still has pending criteria,
  // emit the Final Acceptance reminder from the sidecar (not markdown parsing).
  const acceptance = readJsonFile(path.join(artifactDir, 'acceptance.json'));
  if (acceptance && Array.isArray(acceptance.criteria)) {
    const pendingCriteria = acceptance.criteria.filter(c => {
      const s = normalizedStatus(c && c.status);
      return s === 'pending' || s === 'not_started' || s === '' || s === 'unknown';
    });
    if (pendingCriteria.length > 0) {
      const base = path.basename(artifactDir);
      warnings.push(`${base} Final Acceptance: ${pendingCriteria.length} acceptance criterion/criteria still pending; complete CI/merge/docs before final delivery.`);
    }
  }

  return warnings;
}

async function analyze(root, now = Date.now()) {
  const flowAgentsDir = path.join(root, '.flow-agents');
  // Scope to the session's current task when current.json names one, so an
  // unrelated active workflow elsewhere in the repo does not gate this stop.
  const scoped = preferredArtifactDir(flowAgentsDir);
  const searchDirs = scoped ? [scoped] : [flowAgentsDir];
  const artifacts = searchDirs
    .flatMap(dir => walkMarkdown(dir))
    .map(readArtifact)
    .filter(isWorkflowArtifact)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (artifacts.length === 0) return { warnings: [], blocking: false };

  const latest = artifacts[0];
  const warnings = [];
  const relPath = relative(root, latest.file);
  const status = latest.status || 'unknown';
  const ageMinutes = Math.max(0, Math.round((now - latest.mtimeMs) / 60000));

  if (ACTIVE_STATUSES.has(status)) {
    warnings.push(`${relPath} is still status:${status} (${ageMinutes}m old). Do not final-answer as complete unless the next step is explicit.`);
  }

  // Builder heading completeness checks (hasHeading DOD/Goal Fit Gate) removed in ADR 0010 2c.
  // Verdict is now bundle-driven via bundleEnforcement + sidecarGuidance.
  // Sessions with neither trust.bundle nor state.json are caught by missingBundleOrStateSignal.

  warnings.push(...sidecarValidation(root, path.dirname(latest.file)));
  warnings.push(...sidecarGuidance(root, path.dirname(latest.file)));
  warnings.push(...captureCrossReference(root, path.dirname(latest.file)));
  warnings.push(...(await bundleEnforcement(path.dirname(latest.file))));
  warnings.push(...missingBundleOrStateSignal(path.dirname(latest.file)));

  // A pre-execution task (not started) OR a terminal task (which is itself a
  // completion *claim*) must not block on mere incompleteness — but a FALSE claim
  // (capture/evidence contradiction) still blocks at any phase. This is the whole
  // point of the capture cross-reference: catch a task that falsely claims done.
  const gateState = readJsonFile(path.join(path.dirname(latest.file), 'state.json'));
  const taskStatus = gateState ? normalizedStatus(gateState.status) : normalizedStatus(status);
  const preExecution = isPreExecution(path.dirname(latest.file), status);
  const terminal = TERMINAL_STATUSES.has(taskStatus);
  // Always-block: a claimed pass the capture log or evidence.json contradicts.
  const HARD_BLOCK = /contradicts evidence\.json|caught false-completion|evidence verdict:|evidence check .+ status:|critique status|critique open|required sidecar is missing/;
  // Full gate (execution onward): also completeness/hygiene and not-done state.
  const FULL_BLOCK = /status:|Definition Of Done|Goal Fit|sidecar validation:|contradicts evidence\.json|workflow state|evidence verdict|evidence check|NOT_VERIFIED gap|critique status|critique open|next action|caught false-completion|NOT_VERIFIED —/;
  const blockRe = (preExecution || terminal) ? HARD_BLOCK : FULL_BLOCK;
  const blocking = warnings.some(w => {
    // Capture cross-reference warn-mode notes never block (operator opted out).
    if (/\[backstop in warn mode — not blocking\]/.test(w)) return false;
    return blockRe.test(w);
  });
  return { warnings, blocking, preExecution };
}

/**
 * Resolve the enforcement mode. FLOW_AGENTS_GOAL_FIT_MODE (block|warn|off) wins;
 * the legacy FLOW_AGENTS_GOAL_FIT_STRICT=true maps to block; otherwise the
 * canonical engine default is warn.
 */
function resolveGoalFitMode() {
  const explicit = String(process.env.FLOW_AGENTS_GOAL_FIT_MODE || '').trim().toLowerCase();
  if (explicit === 'block' || explicit === 'warn' || explicit === 'off') return explicit;
  const strict = String(process.env.FLOW_AGENTS_GOAL_FIT_STRICT || '').toLowerCase() === 'true';
  return strict ? 'block' : 'warn';
}

/**
 * Escape hatch: cap how many times block mode may refuse the SAME goal-fit gap
 * in a row, so a genuinely-unsatisfiable goal cannot trap the agent forever.
 * After this many consecutive identical blocks the hook releases (exit 0) with a
 * loud notice. Configurable via FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS (default 3).
 */
function resolveMaxBlocks() {
  const raw = Number.parseInt(process.env.FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS || '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 3;
}

function blockStreakFile(root) {
  return path.join(root, '.flow-agents', '.goal-fit-block-streak.json');
}

function reasonsHash(warnings) {
  const text = (warnings || []).join('\n');
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return String(h);
}

function clearBlockStreak(root) {
  try { fs.rmSync(blockStreakFile(root), { force: true }); } catch { /* best effort */ }
}

function bumpBlockStreak(root, hash) {
  const file = blockStreakFile(root);
  const prev = readJsonFile(file) || {};
  const count = prev.hash === hash ? (Number(prev.count) || 0) + 1 : 1;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ hash, count }));
  } catch { /* best effort */ }
  return count;
}

async function run(rawInput) {
  const input = parseJson(rawInput);
  const root = findRepoRoot(input.cwd || process.cwd());
  const mode = resolveGoalFitMode();
  if (mode === 'off') return rawInput;
  const result = await analyze(root);
  if (result.warnings.length === 0) {
    clearBlockStreak(root);
    return rawInput;
  }

  const message = [
    '[Hook] Goal Fit warning:',
    ...result.warnings.map(w => ` - ${w}`),
  ].join('\n');

  if (mode !== 'block' || !result.blocking) {
    clearBlockStreak(root);
    return { stdout: rawInput, stderr: message, exitCode: 0 };
  }

  const maxBlocks = resolveMaxBlocks();
  const count = bumpBlockStreak(root, reasonsHash(result.warnings));
  if (count >= maxBlocks) {
    clearBlockStreak(root);
    return {
      stdout: rawInput,
      stderr: `${message}\n[Hook] Goal Fit block RELEASED after ${count} consecutive identical blocks (FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=${maxBlocks}): the same gap persists, surfacing to the human instead of looping.`,
      exitCode: 0,
    };
  }
  return {
    stdout: rawInput,
    stderr: `${message}\n[Hook] Goal Fit BLOCK ${count}/${maxBlocks}.`,
    exitCode: 2,
  };
}

if (require.main === module) {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (data.length < MAX_STDIN) data += chunk.substring(0, MAX_STDIN - data.length);
  });
  process.stdin.on('end', () => {
    // run() is now async (Surface load). We wrap in an async IIFE so the
    // stdin/exit flow is preserved and errors are surfaced as warnings (fail-open).
    (async () => {
      let output;
      try {
        output = await run(data);
      } catch (err) {
        // Unexpected failure in the async gate path — fail-open, allow the Stop.
        process.stderr.write(`[Hook] Goal Fit async error (fail-open): ${String(err && err.message || err)}\n`);
        process.stdout.write(data);
        process.exit(0);
        return;
      }
      if (output && typeof output === 'object') {
        if (output.stderr) process.stderr.write(output.stderr.endsWith('\n') ? output.stderr : `${output.stderr}\n`);
        process.stdout.write(String(output.stdout ?? data));
        process.exit(Number.isInteger(output.exitCode) ? output.exitCode : 0);
        return;
      }
      process.stdout.write(String(output));
    })();
  });
}

module.exports = { analyze, run, resolveGoalFitMode, uncheckedInSection, findRepoRoot, sidecarGuidance, safeOneLine, captureCrossReference, bundleEnforcement, readCommandLog, resolveTrustedCommand, declaredManifestTarget };
