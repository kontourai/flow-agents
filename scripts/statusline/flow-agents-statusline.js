#!/usr/bin/env node
/**
 * Compact Flow Agents workflow status for runtimes with status bar support.
 *
 * Reads optional runtime JSON from stdin, discovers `.agents/flow-agents`, and
 * prints one ASCII line suitable for Claude Code statusLine or Pi setStatus.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MAX_SUMMARY = 72;

function readStdin() {
  return new Promise(resolve => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      raw += chunk;
    });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', () => resolve(raw));
  });
}

function parseJson(raw) {
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function runtimeCwd(input) {
  return (
    input.cwd ||
    input.current_dir ||
    input.workspace?.current_dir ||
    input.workspace?.cwd ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.env.PWD ||
    process.cwd()
  );
}

function findWorkflowRoot(startDir) {
  let current = path.resolve(startDir || process.cwd());
  for (;;) {
    const candidate = path.join(current, '.agents', 'flow-agents');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function stateFiles(workflowRoot) {
  try {
    return fs.readdirSync(workflowRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(workflowRoot, entry.name, 'state.json'))
      .filter(file => fs.existsSync(file));
  } catch {
    return [];
  }
}

function chooseWorkflow(workflowRoot) {
  const current = readJson(path.join(workflowRoot, 'current.json'));
  if (current?.active_slug || current?.artifact_dir) {
    const slug = current.active_slug || current.artifact_dir;
    const dir = path.join(workflowRoot, slug);
    const state = readJson(path.join(dir, 'state.json'));
    if (state) return { dir, state };
  }

  const unresolved = new Set([
    'new',
    'planning',
    'planned',
    'in_progress',
    'blocked',
    'verifying',
    'needs_decision',
    'not_verified',
    'failed',
  ]);

  return stateFiles(workflowRoot)
    .map(file => ({ file, state: readJson(file), mtime: fs.statSync(file).mtimeMs }))
    .filter(item => item.state)
    .sort((a, b) => {
      const aOpen = unresolved.has(a.state.status) ? 1 : 0;
      const bOpen = unresolved.has(b.state.status) ? 1 : 0;
      return bOpen - aOpen || b.mtime - a.mtime;
    })
    .map(item => ({ dir: path.dirname(item.file), state: item.state }))[0] || null;
}

function acceptanceProgress(dir) {
  const acceptance = readJson(path.join(dir, 'acceptance.json'));
  const criteria = Array.isArray(acceptance?.criteria) ? acceptance.criteria : [];
  if (criteria.length > 0) {
    const done = criteria.filter(item => ['pass', 'accepted_gap'].includes(item.status)).length;
    return `${done}/${criteria.length} AC`;
  }

  const evidence = readJson(path.join(dir, 'evidence.json'));
  const checks = Array.isArray(evidence?.checks) ? evidence.checks : [];
  if (checks.length > 0) {
    const done = checks.filter(item => ['pass', 'skip'].includes(item.status)).length;
    return `${done}/${checks.length} checks`;
  }

  return '';
}

function compact(text, maxLength = MAX_SUMMARY) {
  const singleLine = String(text || '').replace(/\s+/g, ' ').trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxLength - 3))}...`;
}

function render(workflow) {
  if (!workflow) return 'Flow Agents: no active workflow';

  const { dir, state } = workflow;
  const slug = state.task_slug || path.basename(dir);
  const phaseStatus = [state.phase, state.status].filter(Boolean).join('/');
  const progress = acceptanceProgress(dir);
  const next = compact(state.next_action?.summary || '');
  const parts = [`Flow Agents: ${slug}`];
  if (phaseStatus) parts.push(phaseStatus);
  if (progress) parts.push(progress);
  if (next) parts.push(`next: ${next}`);
  return parts.join(' | ');
}

async function main() {
  const input = parseJson(await readStdin());
  const workflowRoot = findWorkflowRoot(runtimeCwd(input));
  process.stdout.write(`${render(workflowRoot ? chooseWorkflow(workflowRoot) : null)}\n`);
}

main().catch(() => {
  process.stdout.write('Flow Agents: status unavailable\n');
});
