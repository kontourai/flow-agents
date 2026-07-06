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
const { resolveActor, isUnresolvedActor } = require('./lib/actor-identity');
const { flowAgentsArtifactRootsForRead } = require('./lib/local-artifact-paths');
const { readCurrentPointer, hasOtherActorPointer, ownedSessionArtifactDirs } = require('./lib/current-pointer');

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

/**
 * #291 (Conflict #2, Wave 2 Task 2.4): actor-scoped preference consulted BEFORE the global
 * newest-mtime scan below. For each read-root, resolve the "current" pointer via
 * `readCurrentPointer` (per-actor `current/<actor>.json` preferred, legacy global
 * `current.json` fallback — the same single choke point every other Wave 2 consumer uses) and,
 * if it names a session dir whose `state.json` is still in an ACTIVE_STATE_STATUSES status,
 * return that state immediately — so actor A's own ambient steering hint always prefers A's own
 * current task over a globally-newer-mtime `state.json` some other actor (B) happened to touch
 * more recently. Returns null (never throws) when no root yields an actor-scoped resolution,
 * so the caller falls through to the unchanged global scan below — this is the compat-shim
 * guarantee: when `actorKey` is empty/unresolved and/or no per-actor file exists yet, this
 * degrades to the SAME legacy-`current.json`-or-nothing lookup the compat shim already performs
 * for every other Wave 2 reader, so a single-session/CI/legacy-only fixture cannot fail to
 * resolve here in a way it wouldn't already have resolved via the global scan.
 *
 * #345 (field evidence read 2026-07-05) + iteration-2 CRITICAL fix (ownership-scan redesign):
 * applies the SAME three-tier resolution rule as `stop-goal-fit.js`'s `resolveActorScope` —
 * (1) this actor's own per-actor pointer wins, unchanged; (2) no own per-actor pointer but
 * `hasOtherActorPointer` is true (a DIFFERENT actor already has one under this read-root) → the
 * pointer is an INDEX, not the ownership AUTHORITY, so before giving up this actor's OWN
 * sessions are looked up via `ownedSessionArtifactDirs` (the durable local-file
 * assignment-provider claim-record `actor_key` stamp — #291's ownership guard — which survives a
 * deleted `current/<actor>.json` pointer). Any owned dirs found are returned via `ownedDirs`; only
 * when the scan ALSO finds nothing does this actor have no owned steering state for THIS root
 * AND must not fall through to that root's legacy global pointer (which is the OTHER actor's,
 * not this one's) — recorded via the returned `scopedToNothing` flag rather than silently
 * `continue`-ing into the next read-root's legacy pointer; (3) no own pointer AND no other
 * actor's pointer anywhere under this root → fall through to the legacy `current.json`,
 * byte-identical to before. `latestWorkflowState` (below) uses `scopedToNothing` to skip its
 * global newest-mtime scan for an actor that owns no pointer anywhere but for whom at least one
 * read-root already has a DIFFERENT actor's pointer — otherwise that other actor's steering hint
 * would surface via the global scan as if it were this actor's own ambient state.
 *
 * Iteration-2 fix item 3 (code review HIGH): `hasOtherActorPointer`/`ownedSessionArtifactDirs`
 * are gated behind `isUnresolvedActor`, mirroring `readCurrentPointer`'s own gating exactly — an
 * unresolved/empty actor always takes tier 3 (legacy fallback), never tier 2, so
 * `sanitizeSegment('')` → `'unknown'` never mis-scopes an unresolved actor against real pointer
 * files that merely look "foreign" to the synthetic `'unknown'` segment.
 *
 * @param {string} root
 * @param {string} actorKey
 * @returns {{state: {file: string, payload: object, mtimeMs: number}|null, scopedToNothing: boolean, ownedDirs: string[]}}
 */
function actorScopedWorkflowState(root, actorKey) {
  let scopedToNothing = false;
  const ownedDirsAll = [];
  const actorResolved = !!actorKey && !isUnresolvedActor(actorKey);
  for (const flowAgentsDir of flowAgentsArtifactRootsForRead(root)) {
    const { payload: current, source } = readCurrentPointer(flowAgentsDir, actorKey);
    // #345 step 2: no own per-actor pointer, but another actor already has one under THIS
    // read-root — do not adopt its legacy global pointer. Iteration-2: first check whether this
    // actor owns session(s) of its own via the durable assignment-claim stamp (survives a
    // deleted pointer file); if so, record them and move on (a LATER root's own dirs are still
    // gathered too). Only when the ownership scan also finds nothing does this read-root record
    // scopedToNothing and move on to the next read-root (a LATER root could still resolve this
    // actor's own pointer or owned dirs), rather than falling through to a pointer that is not
    // reliably this actor's own.
    if (actorResolved && source !== 'per-actor' && hasOtherActorPointer(flowAgentsDir, actorKey)) {
      const owned = ownedSessionArtifactDirs(flowAgentsDir, actorKey);
      if (owned.length > 0) {
        ownedDirsAll.push(...owned);
      } else {
        scopedToNothing = true;
      }
      continue;
    }
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
    return { state: { file, payload, mtimeMs: stat.mtimeMs }, scopedToNothing: false, ownedDirs: [] };
  }
  // Iteration-2: if any read-root's ownership scan found owned session dir(s), surface the
  // newest-mtime state.json among them (mirroring the same ACTIVE_STATE_STATUSES filter used
  // above) rather than scoping to nothing or falling through to the global scan.
  if (ownedDirsAll.length > 0) {
    const ownedStates = ownedDirsAll
      .map((dir) => {
        const file = path.join(dir, 'state.json');
        let stat;
        try { stat = fs.statSync(file); } catch { return null; }
        const payload = readJson(file);
        if (!payload || !ACTIVE_STATE_STATUSES.has(payload.status)) return null;
        return { file, payload, mtimeMs: stat.mtimeMs };
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { state: ownedStates[0] || null, scopedToNothing: false, ownedDirs: ownedDirsAll };
  }
  return { state: null, scopedToNothing, ownedDirs: [] };
}

function latestWorkflowState(root) {
  const { state: preferred, scopedToNothing, ownedDirs } = actorScopedWorkflowState(root, resolveActor(process.env).actor);
  if (preferred) return preferred;
  // #345: this actor owns no per-actor pointer anywhere, while another actor already has one
  // under at least one read-root, AND the ownership scan (iteration-2) also found no owned
  // session dirs anywhere — no ambient steering hint for this actor, never the global
  // newest-mtime scan (which would otherwise surface that other actor's session state).
  if (scopedToNothing && ownedDirs.length === 0) return null;

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

    // Pull-work route hint
    lines.push('To continue: resume this work. Or run pull-work to assess WIP and start new/parallel work.');

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

    // Every-turn supersession notice (#293): fires on UserPromptSubmit (every turn),
    // not just SessionStart, so a takeover mid-session keeps surfacing the warning.
    if (event === 'UserPromptSubmit' && current) {
      const supersessionHint = supersessionSteering(root, current);
      if (supersessionHint) hints.push(supersessionHint);
    }

    // SessionStart only: append the RESUME block for richer situational awareness
    if (event === 'SessionStart' && current) {
      const resumeBlock = resumeSteering(root, current);
      if (resumeBlock) hints.push(resumeBlock);
      const supersessionHint = supersessionSteering(root, current);
      if (supersessionHint) hints.push(supersessionHint);
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
  supersessionSteering,
  promptText,
  looksLikeBuilderWork,
  builderWorkflowSteering,
};
