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
const crypto = require('crypto');
const { readLivenessEvents, freshHolders } = require('./lib/liveness-read');
const { resolveActor, isUnresolvedActor } = require('./lib/actor-identity');
const { flowAgentsArtifactRootsForRead, resolveSharedRepoRoot, warnIfFailingOpenInsideGitTree } = require('./lib/local-artifact-paths');
const { readOwnCurrentPointer } = require('./lib/current-pointer');
const { readKitManifests, workflowTriggersFor } = require('./lib/kit-catalog');
const { canonicalFlowState } = require('./stop-goal-fit');

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
  const resolvedStartDir = path.resolve(startDir || process.cwd());
  // #357: prefer git's SHARED common-dir root (the primary checkout's repo root, resolved
  // identically from any linked worktree) before falling back to the plain `.git`/AGENTS.md
  // ancestor walk below. Without this, a worktree's OWN `.git` FILE (not the shared `.git`
  // DIRECTORY) satisfies `fs.existsSync(path.join(dir, '.git'))` at the very first directory
  // checked, so the walk always stopped at the worktree root instead of resolving to the
  // shared primary checkout — see src/lib/local-artifact-root.ts's resolveSharedRepoRoot doc
  // comment for the full rationale. Fails open to the walk below (unchanged) when git is
  // unavailable, `resolvedStartDir` is not inside a git working tree, or the command fails —
  // this is also exactly today's behavior in the single-checkout case, where
  // `--git-common-dir` resolves to `.git` under `resolvedStartDir` itself.
  const sharedRoot = resolveSharedRepoRoot(resolvedStartDir);
  if (sharedRoot) return sharedRoot;
  let dir = resolvedStartDir;
  const root = path.parse(dir).root;
  for (let depth = 0; dir && depth < 40; depth++) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      // #413 iteration-2 Fix 1: resolveSharedRepoRoot failed above even though a `.git` entry
      // exists right here — git resolution was ATTEMPTED and FAILED (corrupted gitlink, bad
      // GIT_DIR, git unavailable, etc.), not merely "no git repo at all". Loud, not silent —
      // see warnIfFailingOpenInsideGitTree's own doc comment for the full rationale. This walk
      // still returns `dir` (the ancestor-walk fallback is preserved unchanged) after warning.
      warnIfFailingOpenInsideGitTree(resolvedStartDir, dir);
      return dir;
    }
    if (fs.existsSync(path.join(dir, 'AGENTS.md'))) return dir;
    if (dir === root) break;
    dir = path.dirname(dir);
  }
  return resolvedStartDir;
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

/**
 * #291 (Conflict #2, Wave 2 Task 2.4): actor-scoped preference consulted BEFORE the global
 * newest-mtime scan below. For each read-root, resolve the "current" pointer via
 * `readOwnCurrentPointer` and, if it names a session dir whose `state.json` is still in an
 * ACTIVE_STATE_STATUSES status, return that state immediately — so actor A's own ambient
 * steering hint always prefers A's own current task over a globally-newer-mtime `state.json`
 * some other actor (B) happened to touch more recently. Returns null (never throws) when no root
 * yields an actor-scoped resolution.
 *
 * #440: for a RESOLVED `actorKey`, `readOwnCurrentPointer` reads ONLY that actor's own per-actor
 * `current/<actor>.json` projection — it never falls back to the shared legacy `current.json`.
 * The caller (`latestWorkflowState`) gates its own global-scan fallback below to UNRESOLVED
 * actors only (D1) — so a resolved actor with no own per-actor pointer yet now correctly returns
 * null all the way up (no banner) rather than grounding onto another actor's globally-newer
 * `state.json`, the exact cross-actor steering bug #440 fixes. Only for an empty/unresolved
 * `actorKey` does `readOwnCurrentPointer` delegate to `readCurrentPointer`, which DOES fall back
 * to the legacy global file — that compat-shim degrade (D3) is unchanged from before #291/#440.
 *
 * @param {string} root
 * @param {string} actorKey
 * @returns {{file: string, payload: object, mtimeMs: number}|null}
 */
function actorScopedWorkflowState(root, actorKey) {
  for (const flowAgentsDir of flowAgentsArtifactRootsForRead(root)) {
    const { payload: current } = readOwnCurrentPointer(flowAgentsDir, actorKey);
    if (!current) continue;
    const slug = current.artifact_dir || current.active_slug;
    if (typeof slug !== 'string' || !slug.trim()) continue;
    const safe = slug.replace(/\.\.+/g, '').replace(/^[/\\]+/, '');
    const dir = path.join(flowAgentsDir, safe);
    if (!dir.startsWith(flowAgentsDir + path.sep) || !fs.existsSync(dir)) continue;
    const file = path.join(dir, 'state.json');
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    const payload = readJson(file);
    if (!payload || !ACTIVE_STATE_STATUSES.has(payload.status)) continue;
    return { file, payload, mtimeMs: stat.mtimeMs };
  }
  return null;
}

function latestWorkflowState(root) {
  const actorKey = resolveActor(process.env).actor;
  const preferred = actorScopedWorkflowState(root, actorKey);
  if (preferred) return preferred;

  // #440 D1/D2: a resolved actor's RESUME/STATE/SUPERSESSION banners never re-ground onto
  // another actor's session via the global newest-mtime scan below — that fallback is
  // legacy/unresolved-actor compat only (D3). No own active state this turn -> no banner.
  if (!isUnresolvedActor(actorKey)) return null;

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

// #293 AC7 (injection discipline): strips C0 (0x00-0x1F), DEL (0x7F), and C1 (0x80-0x9F,
// which includes ANSI-CSI-adjacent bytes) BEFORE whitespace-collapse/truncation — mirroring
// src/cli/workflow-sidecar.ts's stripControlCharsForDisplay / assignment-provider.ts's
// sanitizeDisplayField exactly (same charset, same rationale: holder/actor/assignee strings
// sourced from the shared multi-writer liveness stream or an attacker-postable GitHub comment
// are untrusted display input). Previously this function only collapsed whitespace, so a raw
// ESC/BEL byte embedded in a hostile actor string passed through unstripped into every steering
// notice that calls safeStateText (resumeSteering's LIVENESS WARNING block, supersessionSteering's
// SUPERSEDED notice) — fixed here, in the one shared helper, rather than in each call site.
function safeStateText(value, maxLength = 240) {
  // Whitespace-collapse FIRST (so an embedded newline/tab becomes a joining space, preserving
  // the existing multiline-summary neutralization behavior), THEN strip control/ANSI bytes
  // (#293 AC7) — reversing this order would strip \n before the collapse ever sees it, losing
  // the join-space between sentences. Only C0/DEL/C1 bytes THAT SURVIVE the collapse (ESC, BEL,
  // and other non-whitespace control bytes — real \s already became a plain space above) are
  // stripped, mirroring src/cli/workflow-sidecar.ts's stripControlCharsForDisplay /
  // assignment-provider.ts's sanitizeDisplayField charset exactly.
  const collapsed = String(value || '').replace(/\s+/g, ' ').trim();
  const text = collapsed.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
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

const CANONICAL_NONTERMINAL_STATUSES = new Set(['active', 'blocked', 'needs_decision', 'paused']);
const CANONICAL_TERMINAL_STATUSES = new Set(['completed', 'canceled', 'failed', 'accepted_by_exception']);
const ACTION_ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

function flowStepAction(flowId, stepId) {
  const packageRoot = path.resolve(__dirname, '..', '..');
  const inventory = readKitManifests(packageRoot);
  if (inventory.warnings.length) return { action: null, error: 'installed kit metadata is unavailable or malformed' };
  const matches = [];
  for (const kit of inventory.kits) {
    const actions = kit.manifest && kit.manifest.flow_step_actions;
    if (!Array.isArray(actions)) continue;
    for (const action of actions) {
      if (action && action.flow_id === flowId && action.step_id === stepId) matches.push({ ...action, kit_id: kit.kit_id });
    }
  }
  if (matches.length !== 1) return { action: null, error: `expected one installed step action for ${flowId}/${stepId}; found ${matches.length}` };
  const action = matches[0];
  const skills = action.skills === undefined ? [] : action.skills;
  const operations = action.operations === undefined ? [] : action.operations;
  if (!Array.isArray(skills) || !skills.every(value => ACTION_ID_RE.test(value))
    || !Array.isArray(operations) || !operations.every(value => ACTION_ID_RE.test(value))
    || typeof action.implementation_allowed !== 'boolean') {
    return { action: null, error: `installed step action for ${flowId}/${stepId} is malformed` };
  }
  return {
    action: {
      kit_id: action.kit_id,
      flow_id: action.flow_id,
      step_id: action.step_id,
      skills,
      operations,
      implementation_allowed: action.implementation_allowed,
    },
    error: null,
  };
}

function guidanceConflict(reason) {
  return { kind: 'conflict', code: 'GUIDANCE_CONFLICT', reason: safeStateText(reason, 240) };
}

function canonicalGuidance(root, current) {
  const sidecar = current && current.payload;
  const projected = sidecar && sidecar.flow_run;
  if (!projected) return { kind: 'legacy' };
  if (typeof projected !== 'object' || Array.isArray(projected)) return guidanceConflict('Flow Agents flow_run projection is malformed');

  const canonical = canonicalFlowState(root, path.dirname(current.file));
  if (canonical.error || !canonical.state || !canonical.definition) {
    return guidanceConflict(canonical.error || 'canonical Flow state is unavailable');
  }
  const state = canonical.state;
  const expected = {
    run_id: state.run_id,
    definition_id: state.definition_id,
    definition_version: state.definition_version,
    status: state.status,
    current_step: state.current_step,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (projected[field] !== value) return guidanceConflict(`Flow Agents ${field} does not match canonical Flow state`);
  }
  if (!CANONICAL_NONTERMINAL_STATUSES.has(state.status) && !CANONICAL_TERMINAL_STATUSES.has(state.status)) {
    return guidanceConflict(`canonical Flow status ${state.status} is unsupported for guidance`);
  }

  const resolved = flowStepAction(state.definition_id, state.current_step);
  if (resolved.error) return guidanceConflict(resolved.error);
  const identityPayload = { state, definition: canonical.definition, action: resolved.action };
  const identity = crypto.createHash('sha256').update(JSON.stringify(identityPayload)).digest('hex');
  return {
    kind: CANONICAL_TERMINAL_STATUSES.has(state.status) ? 'terminal' : 'canonical',
    state,
    action: resolved.action,
    identity,
  };
}

function canonicalGuidanceLines(guidance) {
  if (guidance.kind === 'conflict') {
    return [
      `${guidance.code}: ${guidance.reason}.`,
      'No executable workflow recommendation is available until canonical Flow and Flow Agents state agree.',
    ];
  }
  const { state, action } = guidance;
  const lines = [
    `Canonical Flow: ${safeStateText(state.definition_id, 120)}@${safeStateText(state.definition_version, 80)}/${safeStateText(state.run_id, 120)} status:${state.status} current_step:${safeStateText(state.current_step, 120)}.`,
    `Canonical guidance identity: sha256:${guidance.identity}.`,
    `Gate action source: installed kit ${safeStateText(action.kit_id, 80)}.`,
  ];
  if (action.skills.length) lines.push(`Gate skills: ${action.skills.join(' -> ')}.`);
  if (action.operations.length) lines.push(`Gate operations: ${action.operations.join(' -> ')}.`);
  if (!action.skills.length && !action.operations.length) lines.push('Gate action: no skill or operation declared.');
  lines.push(`Implementation allowed: ${action.implementation_allowed ? 'yes' : 'no'}.`);
  if (guidance.kind === 'terminal') lines.push('This canonical run is terminal; do not execute another workflow action.');
  else if (state.status === 'blocked') lines.push('The run is blocked; clear or route the blocker before executing the gate action.');
  else if (state.status === 'needs_decision') lines.push('The run needs a decision; record it before executing the gate action.');
  else if (state.status === 'paused') lines.push('The run is paused; resume it before executing the gate action.');
  else lines.push(`Continue only with the declared action for ${safeStateText(state.current_step, 120)}; do not restart or route to another step.`);
  return lines;
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

function stateSteering(root, currentState = null, resolvedGuidance = null) {
  const current = currentState || latestWorkflowState(root);
  if (!current) return '';
  const state = current.payload;
  const guidance = resolvedGuidance || canonicalGuidance(root, current);
  if (guidance.kind !== 'legacy') return canonicalGuidanceLines(guidance).join(' ');
  const next = state.next_action || {};
  if (next.status === 'done' || state.status === 'archived' || state.status === 'accepted') return '';
  const parts = [
    `STATE: ${state.task_slug || path.basename(path.dirname(current.file))} is status:${state.status} phase:${state.phase}.`,
  ];
  if (next.summary) parts.push(`Recorded next_action.summary: "${safeStateText(next.summary)}"`);
  if (Array.isArray(next.skills) && next.skills.length) parts.push(`Required skills: ${next.skills.map(skill => safeStateText(skill, 80)).join(' -> ')}.`);
  if (Array.isArray(next.operations) && next.operations.length) parts.push(`Required operations: ${next.operations.map(operation => safeStateText(operation, 80)).join(' -> ')}.`);
  if (next.command) parts.push(`Run: ${safeStateText(next.command, 240)}`);
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

/**
 * Compose the SessionStart advisory line for installed-skill drift (#439). Fires only inside a
 * kit-bearing checkout (repo has `kits/` AND a built `dist/claude-code/.claude/skills` bundle) —
 * never triggers a build itself, staying read-only and cheap on every SessionStart. Returns ''
 * (never throws past this function) in every other case: not kit-bearing, no manifest yet, no
 * drift found, or any internal error.
 *
 * Reuses the SINGLE shared classification choke point, `scripts/hooks/lib/skill-drift.js`'s
 * `compareSkillDrift()` — this function must never hand-roll its own drift comparison (same
 * convention the CLI check and the manifest writer follow, see #439 plan).
 *
 * @param {string} root  Repository root
 * @returns {string}
 */
function skillDriftSteering(root) {
  try {
    if (!fs.existsSync(path.join(root, 'kits'))) return '';
    if (!fs.existsSync(path.join(root, 'dist', 'claude-code', '.claude', 'skills'))) return '';

    const { loadManifest, compareSkillDrift, resolveClaudeGlobalSkillsDir } = require('./lib/skill-drift');

    const destDir = resolveClaudeGlobalSkillsDir(process.env);
    // Sibling layout: <destDir>/.flow-agents/skills-manifest.json — mirrors
    // src/lib/local-artifact-root.ts's durableFlowAgentsRoot(destDir)/skillsManifestPath exactly
    // (durableFlowAgentsRoot(cwd) resolves to `${cwd}/.flow-agents`, no parent traversal).
    const manifestPath = path.join(destDir, '.flow-agents', 'skills-manifest.json');
    const manifest = loadManifest(manifestPath);

    const installedDir = path.join(destDir, 'skills');
    const kitSourceDir = path.join(root, 'dist', 'claude-code', '.claude', 'skills');
    const report = compareSkillDrift({ installedDir, kitSourceDir, manifest });
    if (!report.hasDrift) return '';

    const { kitUpdated, userModified, unbaselined, missingInstall, kitRemoved } = report.summary;
    // kit_removed (#439 review fix) folds into staleCount alongside the other non-in_sync
    // states — this advisory line only ever surfaces kit-updated/user-modified counts by name
    // (see the template string below), so kit_removed does not get its own named count here; it
    // is still reflected in the total. Full per-state detail is always available via
    // `flow-agents skill-drift-check`.
    const staleCount = kitUpdated + userModified + unbaselined + missingInstall + kitRemoved;
    return `[SKILL DRIFT] ${staleCount} installed Claude Code skill file(s) are stale vs this kit (${kitUpdated} kit-updated, ${userModified} user-modified). Run \`flow-agents init --runtime claude-code --global\` to refresh (user-modified files are reported, not overwritten). See \`flow-agents skill-drift-check\` for details.`;
  } catch {
    return '';
  }
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

function looksLikeImplementationWork(text) {
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

function looksLikeKnowledgeWork(text) {
  const normalized = safeStateText(text, 2000).toLowerCase();
  if (!normalized) return false;
  return /\b(remember|capture|save|file|bookmark)\s+(this|that|the|my|our)\b/.test(normalized) ||
    /\bcapture\s+(this\s+)?(decision|learning|lesson|note|context)\b/.test(normalized) ||
    /\bwhat did we learn about\b/.test(normalized);
}

function kitWorkflowSteering(input, root) {
  const prompt = promptText(input);
  const categories = [];
  if (looksLikeImplementationWork(prompt)) categories.push('implementation-work-detected');
  if (looksLikeKnowledgeWork(prompt)) categories.push('knowledge-capture-detected');
  if (!categories.length) return '';
  try {
    return categories
      .flatMap(category => workflowTriggersFor(root, category))
      .map(trigger => trigger.steering)
      .filter(Boolean)
      .join('\n');
  } catch {
    return '';
  }
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
function resumeSteering(root, current, resolvedGuidance = null) {
  try {
    const state = current.payload;
    const workflowDir = path.dirname(current.file);
    const slug = state.task_slug || path.basename(workflowDir);
    const next = state.next_action || {};

    const guidance = resolvedGuidance || canonicalGuidance(root, current);
    if (guidance.kind !== 'legacy') {
      return [`RESUME: ${slug} status:${safeStateText(state.status, 60)} phase:${safeStateText(state.phase, 60)}`]
        .concat(canonicalGuidanceLines(guidance))
        .join('\n');
    }
    if (next.status === 'done' || state.status === 'archived' || state.status === 'accepted') return '';

    const lines = [];

    // Header line
    lines.push(`RESUME: ${slug} status:${safeStateText(state.status, 60)} phase:${safeStateText(state.phase, 60)}`);
    lines.push('Guidance source: NON-CANONICAL FALLBACK.');

    // Full next action (240-char display path, not the 80-char normalization)
    const nextSummary = next.summary ? safeStateText(next.summary, 240) : 'none';
    lines.push(`Next action: ${nextSummary}`);
    if (Array.isArray(next.skills) && next.skills.length) {
      lines.push(`Required skills: ${next.skills.map(skill => safeStateText(skill, 80)).join(' -> ')}`);
    }
    if (Array.isArray(next.operations) && next.operations.length) {
      lines.push(`Required operations: ${next.operations.map(operation => safeStateText(operation, 80)).join(' -> ')}`);
    }
    if (next.command) lines.push(`Run: ${safeStateText(next.command, 240)}`);
    if (next.target_phase) lines.push(`Target phase: ${safeStateText(next.target_phase, 80)}`);
    if (stateNeedsAmbientSteering(state)) {
      lines.push('WORKFLOW STATE ATTENTION: unresolved workflow state must be addressed before completion.');
    }
    if (next.status === 'needs_user' || state.status === 'needs_decision' || state.status === 'not_verified') {
      lines.push('Do not deliver as complete until the user decision or accepted gap is recorded.');
    }
    if (state.status === 'failed') lines.push('Route back through execution, then re-review and re-verify.');
    const critiqueHint = critiqueSteering(workflowDir);
    if (critiqueHint) lines.push(critiqueHint);

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

    // Legacy sessions use handoff.next_steps as a noncanonical compatibility fallback.
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
      const resolved = resolveActor(process.env);
      const selfActor = resolved.actor || 'local';
      const events = flowAgentsArtifactRootsForRead(root)
        .flatMap(artifactRoot => readLivenessEvents(path.join(artifactRoot, 'liveness', 'events.jsonl')));
      if (events.length > 0) {
        // selfActor (for exclusion matching) stays raw here; only the display strings pushed
        // into `lines` are sanitized below, since holders come from the shared multi-writer
        // liveness stream and must be treated as untrusted display input (#287 fix iteration 1).
        const holders = freshHolders(events, slug, selfActor, Date.now());
        for (const h of holders) {
          lines.push(`[LIVENESS WARNING: another agent appears live on this work: actor ${safeStateText(h.actor)}, last seen ${h.lastAt}]`);
        }
      }
      lines.push(`ACTOR: ${safeStateText(selfActor)} (${resolved.source})`);
    } catch { /* skip */ }

    lines.push('To continue (noncanonical fallback): resume this work. Or run pull-work to assess WIP and start new/parallel work.');

    return lines.join('\n');
  } catch {
    return '';
  }
}

/**
 * Compose the every-turn SUPERSEDED steering notice (issue #293).
 *
 * Unlike resumeSteering()'s RESUME block (SessionStart only), this notice must
 * surface on EVERY turn (UserPromptSubmit as well as SessionStart) once another
 * actor holds a fresh liveness claim on the caller's own subject — the
 * "don't publish, you may be stale" signal the verify-hold gate backstops at
 * publish time. Reuses the SAME liveness-only join resumeSteering()'s liveness
 * advisory block already performs (freshHolders(events, slug, selfActor, now)),
 * not a second computation.
 *
 * freshHolders() already excludes selfActor internally (see
 * scripts/hooks/lib/liveness-read.js), so any holder returned here is by
 * definition another actor — no additional self-filter is required.
 *
 * Fully fail-open: any error anywhere in this function returns '' rather than
 * throwing, matching every other steering helper in this file.
 *
 * @param {string} root     Repository root
 * @param {{ file: string, payload: object }} current  Latest active state entry (this actor's own)
 * @returns {string}
 */
function supersessionSteering(root, current) {
  try {
    const state = current.payload;
    const workflowDir = path.dirname(current.file);
    const slug = state.task_slug || path.basename(workflowDir);

    const resolved = resolveActor(process.env);
    const selfActor = resolved.actor || 'local';

    const events = flowAgentsArtifactRootsForRead(root)
      .flatMap(artifactRoot => readLivenessEvents(path.join(artifactRoot, 'liveness', 'events.jsonl')));
    if (events.length === 0) return '';

    const holders = freshHolders(events, slug, selfActor, Date.now());
    if (holders.length === 0) return '';

    const holder = holders[0];
    return `[SUPERSEDED: another agent appears live on this work: actor ${safeStateText(holder.actor)}, last seen ${holder.lastAt}. Your claim on this subject may be stale — do not publish until you re-verify hold (see verify-hold gate) or hand off.]`;
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
    const guidance = current ? canonicalGuidance(root, current) : { kind: 'legacy' };
    const hints = [];
    let shouldAppendWorkflowContext = false;

    if (toolInput.command === 'InvokeSubagents') {
      if (guidance.kind === 'legacy') {
        const subagents = toolInput.content?.subagents || [];
        hints.push(...subagents
          .map(s => STEERING[s.agent_name])
          .filter(Boolean));
        shouldAppendWorkflowContext = hints.length > 0;
      } else {
        hints.push(canonicalGuidanceLines(guidance).join(' '));
        const contextHint = contextMapSteering(root);
        if (contextHint) hints.push(contextHint);
      }
    }

    if (event === 'UserPromptSubmit' && current) {
      const stateHint = stateSteering(root, current, guidance);
      if (stateHint) {
        hints.push(stateNeedsAmbientSteering(current.payload)
          ? 'WORKFLOW STATE ATTENTION: current sidecars show unresolved workflow state at turn start.'
          : 'WORKFLOW STATE: an active task is in progress — re-ground the recorded goal and resume the next step before doing anything else.');
        hints.push(stateHint);
        const contextHint = contextMapSteering(root);
        if (contextHint) hints.push(contextHint);
      }
    }

    if (event === 'UserPromptSubmit' && guidance.kind === 'legacy') {
      const kitHint = kitWorkflowSteering(input, root);
      if (kitHint) {
        hints.push(kitHint);
        const contextHint = contextMapSteering(root);
        if (contextHint) hints.push(contextHint);
      }
    }

    // Every-turn supersession notice (#293): fires on UserPromptSubmit (every turn),
    // not just SessionStart, so a takeover mid-session keeps surfacing the warning.
    if (event === 'UserPromptSubmit' && current) {
      const supersessionHint = supersessionSteering(root, current);
      if (supersessionHint) hints.push(supersessionHint);
    }

    // SessionStart only: append the RESUME block for richer situational awareness
    if (event === 'SessionStart' && current) {
      const resumeBlock = resumeSteering(root, current, guidance);
      if (resumeBlock) hints.push(resumeBlock);
      const contextHint = contextMapSteering(root);
      if (contextHint) hints.push(contextHint);
      const supersessionHint = supersessionSteering(root, current);
      if (supersessionHint) hints.push(supersessionHint);
    }

    // SessionStart only, unconditional of `current` (#439): the installed-skill drift advisory
    // fires on every SessionStart inside a kit-bearing checkout, independent of whether an active
    // workflow session exists — do NOT fold this into the `current`-gated block above.
    if (event === 'SessionStart') {
      const driftHint = skillDriftSteering(root);
      if (driftHint) hints.push(driftHint);
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
  skillDriftSteering,
  latestWorkflowState,
  findRepoRoot,
  safeStateText,
  stateNeedsAmbientSteering,
  resumeSteering,
  supersessionSteering,
  promptText,
  looksLikeImplementationWork,
  kitWorkflowSteering,
  flowStepAction,
  canonicalGuidance,
};
