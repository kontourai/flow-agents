#!/usr/bin/env node
/**
 * Workflow Steering Hook
 *
 * Injects phase-transition reminders after use_subagent calls complete and
 * re-grounds the active workflow state at the start of every user turn and on
 * SessionStart. SessionStart fires after context compaction and on resume, so
 * re-injecting the goal/phase/next-step there is what makes an in-flight goal
 * survive context loss instead of relying on the model voluntarily re-reading
 * the sidecar.
 *
 * Non-blocking — always exits 0.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { readLivenessEvents, freshHolders } = require('./lib/liveness-read');
const { flowAgentsArtifactRootsForRead } = require('./lib/local-artifact-paths');

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
  const states = flowAgentsArtifactRootsForRead(root)
    .flatMap(artifactRoot => walkStateFiles(artifactRoot))
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

function promptText(input) {
  const candidates = [
    input && input.prompt,
    input && input.user_prompt,
    input && input.message,
    input && input.text,
    input && input.tool_input && input.tool_input.prompt,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return '';
}

function looksLikeBuilderWork(text) {
  const normalized = safeStateText(text, 2000).toLowerCase();
  if (!normalized) return false;
  const readOnlyIntent = /\b(read[- ]only|review[- ]only|no (source |code |file )?(changes?|edits?|modifications?)|do not (modify|edit|change|write|fix|implement|touch)|don't (modify|edit|change|write|fix|implement|touch)|dont (modify|edit|change|write|fix|implement|touch))\b/.test(normalized);
  if (readOnlyIntent) return false;
  const questionOnlyIntent = /^(what|which|who|when|where|why|how)\b/.test(normalized);
  if (questionOnlyIntent) return false;
  const noCodeQuestion = /\b(explain|describe|summari[sz]e|what is|how does|how do i|why does|review|critique)\b/.test(normalized)
    && !/\b(build|create|implement|ship|deliver|fix|debug|refactor|add|update|change|modify|wire|migrate|install|scaffold|write|code)\b/.test(normalized);
  if (noCodeQuestion) return false;
  const verificationOnlyIntent = /\b(validate|test|verify|check)\b/.test(normalized)
    && !/\b(build|create|implement|ship|deliver|fix|debug|refactor|add|update|change|modify|wire|migrate|install|scaffold|write|code)\b/.test(normalized);
  if (verificationOnlyIntent) return false;
  const hasWorkVerb = /\b(build|create|implement|ship|deliver|fix|debug|refactor|add|update|change|modify|wire|migrate|install|scaffold|write|code)\b/.test(normalized);
  const hasWorkObject = /\b(api|endpoint|component|feature|bug|failing test|regression|integration|hook|script|cli|config|schema|migration)\b/.test(normalized);
  const hasRequestLanguage = /\b(can you|please|let's|lets|need|should|make|ensure|support|add|update|fix|work on)\b/.test(normalized);
  return hasWorkVerb || (hasWorkObject && hasRequestLanguage);
}

function builderWorkflowSteering(input) {
  if (!looksLikeBuilderWork(promptText(input))) return '';
  return [
    'BUILDER WORKFLOW ROUTE: this user prompt looks like coding/build work.',
    'Builder lifecycle: shape raw ideas -> build selected work -> publish verified branch/PR -> learn correction feedback.',
    'Before source edits or implementation commands, activate Builder Kit delivery workflow.',
    'If the user explicitly requested TDD, activate `tdd-workflow`; otherwise activate `deliver` and keep the session on `builder.build`.',
    'Use `npm run workflow:sidecar -- ensure-session --flow-id builder.build ...` when the repo provides the sidecar writer.',
    'After local verification, continue to publish/release-readiness and learning-review; do not treat local verification as terminal delivery.',
    'Do not bypass plan-work -> execute-plan -> review-work -> verify-work for coding tasks; direct implementation is only acceptable when the user explicitly asks for no workflow or explanation-only help.',
  ].join(' ');
}

/**
 * Compose the RESUME block for SessionStart.
 *
 * Reads trust.bundle, handoff.json, and the liveness stream beside state.json;
 * all reads are fail-open (errors → skip that section, never throw).
 *
 * Returns a multi-line string starting with "RESUME: <slug> status:<s> phase:<p>"
 * or '' if the current state has status 'done', 'archived', or 'accepted'.
 *
 * @param {string} root     Repository root
 * @param {{ file: string, payload: object }} current  Latest active state entry
 * @returns {string}
 */
function resumeSteering(root, current) {
  try {
    const state = current.payload;
    const workflowDir = path.dirname(current.file);
    const slug = state.task_slug || path.basename(workflowDir);
    const next = state.next_action || {};

    if (next.status === 'done' || state.status === 'archived' || state.status === 'accepted') return '';

    const lines = [];

    // Header line
    lines.push(`RESUME: ${slug} status:${safeStateText(state.status, 60)} phase:${safeStateText(state.phase, 60)}`);

    // Full next action (240-char display path, not the 80-char normalization)
    const nextSummary = next.summary ? safeStateText(next.summary, 240) : 'none';
    lines.push(`Next action: ${nextSummary}`);

    // Plan artifact path
    let planPath = 'not found';
    try {
      const artifactPaths = Array.isArray(state.artifact_paths) ? state.artifact_paths : [];
      const planEntry = artifactPaths.find(p => typeof p === 'string' && p.endsWith('--plan-work.md'));
      if (planEntry) {
        planPath = planEntry;
      } else {
        const candidate = path.join(workflowDir, `${slug}--plan-work.md`);
        if (fs.existsSync(candidate)) planPath = candidate;
      }
    } catch { /* skip */ }
    lines.push(`Plan: ${planPath}`);

    // Handoff: next_steps[0] and blockers
    let nextStep = 'none';
    let blockers = 'none';
    try {
      const handoff = readJson(path.join(workflowDir, 'handoff.json'));
      if (handoff) {
        const steps = Array.isArray(handoff.next_steps) ? handoff.next_steps : [];
        if (steps.length > 0) nextStep = safeStateText(String(steps[0]), 240);
        const bArr = Array.isArray(handoff.blockers) ? handoff.blockers : [];
        if (bArr.length > 0) blockers = bArr.map(b => safeStateText(String(b), 120)).join(', ');
      }
    } catch { /* skip */ }
    lines.push(`Next step: ${nextStep}`);
    lines.push(`Blockers: ${blockers}`);

    // Trust bundle
    try {
      const bundle = readJson(path.join(workflowDir, 'trust.bundle'));
      if (bundle) {
        const claims = Array.isArray(bundle.claims) ? bundle.claims : [];
        let verified = 0;
        let disputed = 0;
        const unresolved = [];
        for (const claim of claims) {
          if (!claim || typeof claim !== 'object') continue;
          const status = String(claim.status || '');
          if (status === 'verified') {
            verified++;
          } else if (status === 'disputed' || status === 'unknown') {
            disputed++;
            unresolved.push(claim);
          }
        }
        const total = claims.length;
        lines.push(`Trust: ${verified} verified / ${disputed} disputed / ${total} total`);
        for (const claim of unresolved) {
          const id = safeStateText(String(claim.id || ''), 120);
          const st = safeStateText(String(claim.status || ''), 30);
          lines.push(`  - ${id} (${st}) → npm run workflow:sidecar -- claim ${id} ${workflowDir}`);
        }
      } else {
        lines.push('Trust: no trust data available');
      }
    } catch { /* skip */ }

    // Liveness advisory
    try {
      const events = flowAgentsArtifactRootsForRead(root)
        .flatMap(artifactRoot => readLivenessEvents(path.join(artifactRoot, 'liveness', 'events.jsonl')));
      if (events.length > 0) {
        const selfActor = (process.env.FLOW_AGENTS_ACTOR || '').trim() || 'local';
        const holders = freshHolders(events, slug, selfActor, Date.now());
        for (const h of holders) {
          lines.push(`[LIVENESS WARNING: another agent appears live on this work: actor ${h.actor}, last seen ${h.lastAt}]`);
        }
      }
    } catch { /* skip */ }

    // Pull-work route hint
    lines.push('To continue: resume this work. Or run pull-work to assess WIP and start new/parallel work.');

    return lines.join('\n');
  } catch {
    return '';
  }
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

    if ((event === 'UserPromptSubmit' || event === 'SessionStart') && current) {
      const stateHint = stateSteering(root);
      if (stateHint) {
        hints.push(stateNeedsAmbientSteering(current.payload)
          ? 'WORKFLOW STATE ATTENTION: current sidecars show unresolved workflow state at turn start.'
          : 'WORKFLOW STATE: an active task is in progress — re-ground the recorded goal and resume the next step before doing anything else.');
        hints.push(stateHint);
        const contextHint = contextMapSteering(root);
        if (contextHint) hints.push(contextHint);
      }
    }

    if (event === 'UserPromptSubmit') {
      const builderHint = builderWorkflowSteering(input);
      if (builderHint) {
        hints.push(builderHint);
        const contextHint = contextMapSteering(root);
        if (contextHint) hints.push(contextHint);
      }
    }

    // SessionStart only: append the RESUME block for richer situational awareness
    if (event === 'SessionStart' && current) {
      const resumeBlock = resumeSteering(root, current);
      if (resumeBlock) hints.push(resumeBlock);
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

module.exports = {
  run,
  stateSteering,
  critiqueSteering,
  contextMapSteering,
  latestWorkflowState,
  findRepoRoot,
  safeStateText,
  stateNeedsAmbientSteering,
  resumeSteering,
  promptText,
  looksLikeBuilderWork,
  builderWorkflowSteering,
};
