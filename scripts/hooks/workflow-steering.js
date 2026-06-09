#!/usr/bin/env node
/**
 * Workflow Steering Hook
 *
 * Injects phase-transition reminders after use_subagent calls complete and
 * ambient workflow-state reminders at the start of the next user turn.
 *
 * Non-blocking — always exits 0.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const STEERING = {
  'tool-planner': [
    '⚡ PLAN COMPLETE — Next: execute-plan (step 3).',
    'Present plan to user. Get approval before executing.',
  ].join(' '),

  'tool-worker': [
    '⚡ EXECUTION COMPLETE — Next: review (step 4) then verify (step 5).',
    'Delegate to review-work for critique (report only — it cannot fix code).',
    'Then delegate to verify-work for evidence (report only — it cannot fix code).',
    'Do NOT deliver until review + verify are both clean.',
    'If this was a VISUAL change (UI, CSS, HTML), you MUST delegate to tool-playwright for screenshot verification before delivering.',
  ].join(' '),

  'tool-code-reviewer': [
    '⚡ REVIEW COMPLETE — Next: verify (step 5).',
    'Reviewer reported findings only — it did NOT fix anything.',
    'If CRITICAL/HIGH findings: route back to execute-plan, then re-review + re-verify.',
    'If clean: proceed to verify-work. If findings exist, route back through execute-plan or a user decision.',
  ].join(' '),

  'tool-security-reviewer': [
    '⚡ SECURITY REVIEW COMPLETE — Check findings.',
    'If CRITICAL security findings: route back to execute-plan, then re-review + re-verify.',
    'If clean: proceed to next step.',
  ].join(' '),

  'tool-verifier': [
    '⚡ VERIFICATION COMPLETE — Route on verdict.',
    'All PASS + no review issues → deliver.',
    'Any FAIL or unfixed findings → route back to execute-plan, then re-review + re-verify.',
    'Loop exits ONLY when review + verify are BOTH clean in the same iteration.',
  ].join(' '),
};

const ACTIVE_STATE_STATUSES = new Set([
  'new',
  'planning',
  'planned',
  'in_progress',
  'blocked',
  'verifying',
  'verified',
  'needs_decision',
  'not_verified',
  'failed',
  'delivered',
]);

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

function walkStateFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'archive') continue;
      walkStateFiles(full, out);
    } else if (entry.isFile() && entry.name === 'state.json') {
      out.push(full);
    }
  }
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function latestWorkflowState(root) {
  const states = walkStateFiles(path.join(root, '.flow-agents'))
    .map(file => {
      let stat;
      try { stat = fs.statSync(file); } catch { return null; }
      const payload = readJson(file);
      if (!payload || !ACTIVE_STATE_STATUSES.has(payload.status)) return null;
      return { file, payload, mtimeMs: stat.mtimeMs };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return states[0] || null;
}

function safeStateText(value, maxLength = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function normalizedStateValue(value) {
  return safeStateText(value, 80).toLowerCase();
}

function stateNeedsAmbientSteering(state) {
  if (!state || typeof state !== 'object') return false;
  const status = normalizedStateValue(state.status);
  const nextStatus = normalizedStateValue(state.next_action && state.next_action.status);
  return (
    status === 'blocked' ||
    status === 'failed' ||
    status === 'needs_decision' ||
    status === 'not_verified' ||
    nextStatus === 'needs_user'
  );
}

function critiqueSteering(workflowDir) {
  const critique = readJson(path.join(workflowDir, 'critique.json'));
  if (!critique || critique.required !== true) return '';
  if (critique.status === 'pass' || critique.status === 'not_required') return '';
  const critiques = Array.isArray(critique.critiques) ? critique.critiques : [];
  const openFindings = [];
  let nonPassReviews = 0;
  for (const review of critiques) {
    if (!review || typeof review !== 'object') continue;
    if (review.verdict === 'fail' || review.verdict === 'not_verified') nonPassReviews += 1;
    const findings = Array.isArray(review.findings) ? review.findings : [];
    for (const finding of findings) {
      if (finding && finding.status === 'open') openFindings.push(finding);
    }
  }
  const parts = [
    `CRITIQUE: required critique is status:${safeStateText(critique.status, 60)}.`,
  ];
  if (nonPassReviews) parts.push(`${nonPassReviews} review(s) have fail/not_verified verdicts.`);
  if (openFindings.length) {
    const severityCounts = openFindings.reduce((acc, finding) => {
      const severity = safeStateText(finding.severity || 'unknown', 30);
      acc[severity] = (acc[severity] || 0) + 1;
      return acc;
    }, {});
    const counts = Object.entries(severityCounts)
      .map(([severity, count]) => `${severity}:${count}`)
      .join(', ');
    parts.push(`Open findings: ${counts}.`);
    parts.push(`First open finding: "${safeStateText(openFindings[0].description)}"`);
  }
  parts.push('Do not deliver as complete until required critique is pass or findings are explicitly accepted.');
  return parts.join(' ');
}

function stateSteering(root) {
  const current = latestWorkflowState(root);
  if (!current) return '';
  const state = current.payload;
  const next = state.next_action || {};
  if (next.status === 'done' || state.status === 'archived' || state.status === 'accepted') return '';
  const parts = [
    `STATE: ${state.task_slug || path.basename(path.dirname(current.file))} is status:${state.status} phase:${state.phase}.`,
  ];
  if (next.summary) parts.push(`Recorded next_action.summary: "${safeStateText(next.summary)}"`);
  if (next.target_phase) parts.push(`Target phase: ${safeStateText(next.target_phase, 80)}.`);
  if (next.status === 'needs_user' || state.status === 'needs_decision' || state.status === 'not_verified') {
    parts.push('Do not deliver as complete until the user decision or accepted gap is recorded.');
  }
  if (state.status === 'failed') {
    parts.push('Route back through execution, then re-review and re-verify.');
  }
  const critiqueHint = critiqueSteering(path.dirname(current.file));
  if (critiqueHint) parts.push(critiqueHint);
  return parts.join(' ');
}

function contextMapSteering(root) {
  const mapPath = path.join(root, 'docs', 'context-map.md');
  if (!fs.existsSync(mapPath)) return '';
  return [
    'CONTEXT MAP: use docs/context-map.md before broad repo rediscovery.',
    'If structure, commands, schemas, skills, agents, or packs changed, run `npm run context-map -- --check`.',
  ].join(' ');
}

function run(rawInput) {
  try {
    const input = JSON.parse(rawInput);
    const event = input.hook_event_name || '';
    const toolOutput = input.tool_response || input.tool_output || '';
    const toolInput = input.tool_input || {};
    const root = findRepoRoot(input.cwd || process.cwd());
    const current = latestWorkflowState(root);
    const hints = [];
    let shouldAppendWorkflowContext = false;

    if (toolInput.command === 'InvokeSubagents') {
      const subagents = toolInput.content?.subagents || [];
      hints.push(...subagents
        .map(s => STEERING[s.agent_name])
        .filter(Boolean));
      shouldAppendWorkflowContext = hints.length > 0;
    }

    if (event === 'UserPromptSubmit' && current && stateNeedsAmbientSteering(current.payload)) {
      hints.push('WORKFLOW STATE ATTENTION: current sidecars show unresolved workflow state at turn start.');
      shouldAppendWorkflowContext = true;
    }

    if (shouldAppendWorkflowContext) {
      const stateHint = stateSteering(root);
      if (stateHint) hints.push(stateHint);
      const contextHint = contextMapSteering(root);
      if (contextHint) hints.push(contextHint);
    }
    if (hints.length === 0) return rawInput;

    const steering = '\n\n---\n' + hints.join('\n') + '\n---';
    return rawInput + steering;
  } catch { /* pass through */ }
  return rawInput;
}

if (require.main === module) {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    data += chunk;
  });
  process.stdin.on('end', () => {
    process.stdout.write(String(run(data)));
  });
}

module.exports = { run, stateSteering, critiqueSteering, contextMapSteering, latestWorkflowState, findRepoRoot, safeStateText, stateNeedsAmbientSteering };
