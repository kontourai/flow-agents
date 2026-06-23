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
const DELIVERY_TYPES = new Set(['deliver', 'delivery', 'fix-bug', 'execute-plan', 'verify-work']);
const SIDECAR_NAMES = new Set(['state.json', 'acceptance.json', 'evidence.json', 'handoff.json']);
const OPTIONAL_SIDECAR_NAMES = new Set(['critique.json']);

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
  if (DELIVERY_TYPES.has(artifact.type)) return true;
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
    if (!['done', 'delivered', 'archived', 'accepted', 'complete', 'completed'].includes(status)) {
      const nextStatus = next ? normalizedStatus(next.status || 'unknown') : 'unknown';
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

function markdownVerdict(text) {
  const verdict = (/###\s+Verdict:\s*([A-Za-z_ -]+)/i.exec(text) || [])[1]
    || (/^Build:\s*\[?([A-Za-z_ -]+)\]?/im.exec(text) || [])[1]
    || '';
  return normalizedStatus(verdict).replace(/[^a-z_ -].*$/, '').trim();
}

function analyze(root, now = Date.now()) {
  const dirs = [path.join(root, '.flow-agents')];
  const artifacts = dirs
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

  if (!hasHeading(latest.text, 'Definition Of Done')) {
    warnings.push(`${relPath} is missing ## Definition Of Done, so the user-facing finish line is not explicit.`);
  }

  if (!hasHeading(latest.text, 'Goal Fit Gate')) {
    warnings.push(`${relPath} is missing ## Goal Fit Gate, so local acceptance has not been checked.`);
  } else {
    for (const item of uncheckedInSection(latest.text, 'Goal Fit Gate').slice(0, 6)) {
      warnings.push(`${relPath} Goal Fit unchecked: ${item}`);
    }
  }

  if (status === 'delivered' && hasHeading(latest.text, 'Final Acceptance')) {
    const uncheckedFinal = uncheckedInSection(latest.text, 'Final Acceptance');
    if (uncheckedFinal.length > 0) {
      warnings.push(`${relPath} local delivery is marked delivered, but Final Acceptance still has ${uncheckedFinal.length} open item(s) for CI/merge/docs promotion.`);
    }
  }

  warnings.push(...sidecarValidation(root, path.dirname(latest.file)));
  const evidence = readJsonFile(path.join(path.dirname(latest.file), 'evidence.json'));
  if (evidence && markdownVerdict(latest.text) === 'pass' && normalizedStatus(evidence.verdict) === 'fail') {
    warnings.push(`${relPath} Markdown PASS contradicts evidence.json verdict fail.`);
  }
  warnings.push(...sidecarGuidance(root, path.dirname(latest.file)));

  const blocking = warnings.some(w => /status:|Definition Of Done|Goal Fit|sidecar validation:|contradicts evidence\.json|workflow state|evidence verdict|evidence check|NOT_VERIFIED gap|critique status|critique open|next action/.test(w));
  return { warnings, blocking };
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

function run(rawInput) {
  const input = parseJson(rawInput);
  const root = findRepoRoot(input.cwd || process.cwd());
  const mode = resolveGoalFitMode();
  if (mode === 'off') return rawInput;
  const result = analyze(root);
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
    const output = run(data);
    if (output && typeof output === 'object') {
      if (output.stderr) process.stderr.write(output.stderr.endsWith('\n') ? output.stderr : `${output.stderr}\n`);
      process.stdout.write(String(output.stdout ?? data));
      process.exit(Number.isInteger(output.exitCode) ? output.exitCode : 0);
    }
    process.stdout.write(String(output));
  });
}

module.exports = { analyze, run, resolveGoalFitMode, uncheckedInSection, findRepoRoot, sidecarGuidance, safeOneLine };
