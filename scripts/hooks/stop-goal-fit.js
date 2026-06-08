#!/usr/bin/env node
/**
 * Stop Hook: warn when an active workflow is about to stop short of its goal.
 *
 * The hook reads .agents/flow-agents artifacts, looks for the most recent active
 * delivery/session file, and reports missing Definition Of Done, Goal Fit, or
 * Final Acceptance state. It is warning-only by default. Set
 * FLOW_AGENTS_GOAL_FIT_STRICT=true to return exit code 2 when local goal fit is
 * incomplete.
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

function sidecarValidation(root, artifactDir) {
  const requireSidecars = String(process.env.FLOW_AGENTS_REQUIRE_SIDECARS || '').toLowerCase() === 'true';
  const requireCritique = String(process.env.FLOW_AGENTS_REQUIRE_CRITIQUE || '').toLowerCase() === 'true';
  if (!requireSidecars && !requireCritique && !hasSidecars(artifactDir)) return [];

  const packageRoot = fs.existsSync(path.join(root, 'package.json'))
    ? root
    : path.resolve(__dirname, '..', '..');
  const packageJson = path.join(packageRoot, 'package.json');
  if (!fs.existsSync(packageJson)) return [`${relative(root, artifactDir)} sidecar validation: package.json is missing; cannot run TypeScript workflow validator.`];

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

  const args = ['run', 'workflow:validate-artifacts', '--silent', '--'];
  args.push('--skip-markdown-validation');
  if (requireSidecars) args.push('--require-sidecars');
  if (requireCritique) args.push('--require-critique');
  args.push(artifactDir);

  const result = spawnSync('npm', args, {
    cwd: packageRoot,
    encoding: 'utf8',
    timeout: 30000,
  });

  if (result.status === 0) return [];
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 12);
  if (output.length === 0) output.push(`validator exited with status ${result.status ?? 'unknown'}`);
  return output.map(line => `${relative(root, artifactDir)} sidecar validation: ${line}`);
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
  const dirs = [path.join(root, '.agents', 'flow-agents')];
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

  const blocking = warnings.some(w => /status:|Definition Of Done|Goal Fit|sidecar validation|contradicts evidence\.json|workflow state|evidence verdict|evidence check|NOT_VERIFIED gap|critique status|critique open|next action/.test(w));
  return { warnings, blocking };
}

function run(rawInput) {
  const input = parseJson(rawInput);
  const root = findRepoRoot(input.cwd || process.cwd());
  const result = analyze(root);
  if (result.warnings.length === 0) return rawInput;

  const message = [
    '[Hook] Goal Fit warning:',
    ...result.warnings.map(w => ` - ${w}`),
  ].join('\n');
  const strict = String(process.env.FLOW_AGENTS_GOAL_FIT_STRICT || '').toLowerCase() === 'true';
  return {
    stdout: rawInput,
    stderr: message,
    exitCode: strict && result.blocking ? 2 : 0,
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

module.exports = { analyze, run, uncheckedInSection, findRepoRoot, sidecarGuidance, safeOneLine };
