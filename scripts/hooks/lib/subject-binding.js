'use strict';
/**
 * subject-binding.js — shared pure-CJS "is this work bound to a subject?" primitive
 *
 * Zero external dependencies beyond sibling hook libs. Consumed by:
 *   - scripts/hooks/subject-binding.js     (PreToolUse first-write interception)
 *   - scripts/hooks/workflow-steering.js   (every-turn collision notice)
 *
 * WHY (#1099): four pieces of work were duplicated in one night. The enforcement that
 * would have caught it — the SUPERSEDED liveness notice — was wired and firing, and had nothing
 * to key on: it needs a subject, and a subject only exists after someone runs `ensure-session`.
 * Nobody did, because at the moment you pick up a one-line fix, ceremony feels absurd. So the
 * question this module answers is deliberately NOT "does this turn look like builder work?"
 * (a guess about intent) but "is a subject bound right now?" (a fact about state), asked at the
 * moment the work becomes real: the first mutating tool call.
 *
 * ONE KEY, ONE LOOKUP. Because the subject id is derived from the backlog item
 * (subject-identity.js), `subjectStatus()` answers with a single key both of the questions that
 * cause duplicate work:
 *   - "is another actor live on this item?"  → holders (the liveness join)
 *   - "does a session for this item exist?"  → session (the local artifact directory)
 * Had the subject been a chosen string, these would be two mechanisms over two vocabularies.
 * They are one because the identity comes from the backlog, not from the author.
 *
 * Exports:
 *   resolveSubjectBindingMode(env)          → 'off'|'warn'|'block'
 *   ACTIVE_STATE_STATUSES                   → Set<string>
 *   boundSubject(root, actorKey)            → {file, payload, mtimeMs}|null
 *   classifyMutation(input)                 → {mutating: boolean, tool: string, target: string}
 *   backlogCreateCommand(input)             → {repo: string|null}|null
 *   subjectStatus(options)                  → {subjectId, ref, session, holders}|null
 *   noticeCooldownElapsed(root, actorKey, id, nowMs, cooldownSeconds) → boolean
 *   recordNotice(root, actorKey, id, nowMs) → void
 *   installProvenance(moduleFilename)       → {installed: boolean, locallyModified: boolean}
 */

const fs = require('fs');
const path = require('path');
const { readOwnCurrentPointer } = require('./current-pointer');
const { flowAgentsArtifactRootsForRead } = require('./local-artifact-paths');
const { readLivenessEvents, freshHolders } = require('./liveness-read');
const { canonicalSubjectId, canonicalSubjectKeyFromRefs } = require('./subject-identity');

/** Default spacing between repeats of the same advisory, in seconds. */
const DEFAULT_COOLDOWN_SECONDS = 1800;

/**
 * Statuses that count as an active, still-owned session. Mirrors workflow-steering.js's own list
 * (which now consumes this one) — a session in any of these states is a bound subject.
 */
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
  'canceled',
]);

/**
 * Enforcement strength, mirroring FLOW_AGENTS_GOAL_FIT_MODE's shape exactly so operators meet one
 * convention, not two.
 *
 * Default is `warn`, deliberately. This gate sits in front of every file write in every repo that
 * installs the kit; a spurious BLOCK on a trivial edit teaches agents to route around the
 * mechanism, which is a worse outcome than a missed bind (the thing being fixed costs tokens, not
 * correctness). `block` is opt-in for an operator who has decided their repo means it.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {'off'|'warn'|'block'}
 */
function resolveSubjectBindingMode(env = process.env) {
  const raw = String((env && env.FLOW_AGENTS_SUBJECT_BINDING) || '').trim().toLowerCase();
  if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'no' || raw === 'disabled') return 'off';
  if (raw === 'block') return 'block';
  return 'warn';
}

/**
 * Seconds between repeats of the same advisory for one actor.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
function resolveNoticeCooldownSeconds(env = process.env) {
  const raw = Number.parseInt(String((env && env.FLOW_AGENTS_SUBJECT_BINDING_COOLDOWN_SECONDS) || ''), 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_COOLDOWN_SECONDS;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The subject this actor is currently bound to, resolved through its OWN current pointer —
 * never another actor's, and never a global newest-mtime scan (#440). Returns null when the
 * actor has no active session, which is precisely the state that produced #1099.
 *
 * Extracted from workflow-steering.js's `actorScopedWorkflowState`, which now calls this, so the
 * PreToolUse gate and the every-turn steering can never disagree about whether a subject exists.
 *
 * @param {string} root      Repository root
 * @param {string} actorKey  Resolved actor identity
 * @returns {{file: string, payload: object, mtimeMs: number}|null}
 */
function boundSubject(root, actorKey) {
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

/**
 * Tools that mutate repository content. Deliberately an ALLOWLIST of explicit file-writing tools,
 * not an attempt to decide whether an arbitrary Bash command writes.
 *
 * `Bash` is excluded on purpose: `sed -i` and `>` do mutate, but so do `ls`, `git log`, and every
 * read in the session, and no reliable classifier separates them (config-protection's own
 * shell-write detection documents itself as incomplete and frozen for exactly this reason). A
 * missed bind on a `sed -i` is the acceptable failure; a spurious prompt on `git status` is not.
 */
const MUTATING_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'str_replace_editor',
  'apply_patch',
  'create_file',
  'edit_file',
]);

/**
 * Does this tool call mutate repository content?
 *
 * @param {object} input  Parsed hook payload
 * @returns {{mutating: boolean, tool: string, target: string}}
 */
function classifyMutation(input) {
  const tool = String((input && input.tool_name) || '');
  const toolInput = (input && input.tool_input) || {};
  const mutating = MUTATING_TOOLS.has(tool);
  const rawTarget = toolInput.file_path || toolInput.path || toolInput.notebook_path || '';
  return { mutating, tool, target: String(rawTarget || '') };
}

const GH_ISSUE_CREATE_RE = /\bgh\s+issue\s+create\b/;
const GH_REPO_FLAG_RE = /--repo[=\s]+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/;

/**
 * Is this tool call about to file a NEW backlog item?
 *
 * The owner's second ask on #1099: parallel lanes filed ~20 issues in one night with no
 * duplicate check, and produced at least one near-duplicate. Because the subject id IS the backlog
 * identifier, "already filed?" and "already claimed?" are the same lookup against the same key —
 * so the reminder belongs beside the binding gate, not in a separate mechanism.
 *
 * @param {object} input
 * @returns {{repo: string|null}|null}
 */
function backlogCreateCommand(input) {
  const tool = String((input && input.tool_name) || '');
  if (tool !== 'Bash') return null;
  const command = String(((input && input.tool_input) || {}).command || '');
  if (!command || !GH_ISSUE_CREATE_RE.test(command)) return null;
  const repo = GH_REPO_FLAG_RE.exec(command);
  return { repo: repo ? repo[1] : null };
}

/**
 * THE lookup. One key — the backlog-derived subject id — answers both duplication questions.
 *
 * @param {{root: string, ref?: string|null, subjectId?: string|null, selfActor?: string, nowMs?: number}} options
 * @returns {{subjectId: string, ref: string|null, session: {dir: string}|null, holders: object[]}|null}
 */
function subjectStatus(options) {
  const { root, ref = null, subjectId = null, selfActor = '', nowMs = Date.now() } = options || {};
  const id = (ref ? canonicalSubjectId(ref) : null) || subjectId;
  if (!id || !root) return null;
  let session = null;
  const events = [];
  for (const artifactRoot of flowAgentsArtifactRootsForRead(root)) {
    if (!session) {
      const dir = path.join(artifactRoot, id);
      if (fs.existsSync(path.join(dir, 'state.json'))) session = { dir };
    }
    for (const event of readLivenessEvents(path.join(artifactRoot, 'liveness', 'events.jsonl'))) events.push(event);
  }
  // `subjectKey: id` is what makes a legacy-named lane visible here: its writer stamps the same
  // backlog-derived key even though its subjectId is a differently-shaped string.
  const holders = events.length ? freshHolders(events, id, selfActor, nowMs, { subjectKey: id }) : [];
  return { subjectId: id, ref, session, holders };
}

/**
 * Canonical subject key for an already-bound session, from the binding it already records.
 * Null for the free-text (`local:`) namespace.
 *
 * @param {object} statePayload  Parsed state.json
 * @returns {string|null}
 */
function boundSubjectKey(statePayload) {
  if (!statePayload || typeof statePayload !== 'object') return null;
  return canonicalSubjectKeyFromRefs(statePayload.work_item_refs);
}

function noticeFile(root, actorKey) {
  const roots = flowAgentsArtifactRootsForRead(root);
  const base = roots.length ? roots[0] : path.join(root, '.kontourai', 'flow-agents');
  const safeActor = String(actorKey || 'unresolved').replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 64) || 'unresolved';
  return path.join(base, 'subject-binding-notices', `${safeActor}.json`);
}

/**
 * Has enough time passed to repeat this advisory for this actor?
 *
 * Fails OPEN (returns true) on any read problem: a missing or unreadable marker must produce the
 * notice, never suppress it. The cooldown exists so a declined prompt does not become per-write
 * noise — the failure mode that kills a mechanism by making it reflexively dismissible.
 *
 * @returns {boolean}
 */
function noticeCooldownElapsed(root, actorKey, id, nowMs, cooldownSeconds) {
  if (!cooldownSeconds) return true;
  try {
    const payload = readJson(noticeFile(root, actorKey));
    const last = payload && payload[id];
    if (typeof last !== 'number' || !Number.isFinite(last)) return true;
    return nowMs - last >= cooldownSeconds * 1000;
  } catch {
    return true;
  }
}

/**
 * Record that this advisory fired. Best-effort: a write failure is swallowed, which degrades to
 * "notify every time" rather than to silence.
 */
function recordNotice(root, actorKey, id, nowMs) {
  try {
    const file = noticeFile(root, actorKey);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload = readJson(file) || {};
    payload[id] = nowMs;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    /* best-effort only */
  }
}

/**
 * Is this hook running from a PUBLISHED package install, or from a file someone synced in by hand?
 *
 * Syncing a changed hook straight into the global install is the tight feedback loop while
 * iterating (each hook event spawns a fresh `node`, so the next firing picks it up — no session
 * restart, no `npm i -g`). Its hazard is silent divergence: a synced file is invisible to every
 * other machine and is wiped by the next install, so "am I testing the real thing?" becomes
 * something you have to remember. This makes the answer part of the output instead.
 *
 * Signal: npm writes every file of a package during one install, so a package file whose mtime is
 * meaningfully NEWER than the install's own package.json was written afterwards, by hand. Only
 * evaluated for a file that actually lives inside an installed `node_modules/@kontourai/flow-agents`
 * tree — a source checkout is always "modified" and saying so would be noise.
 *
 * @param {string} moduleFilename  Typically `__filename` of the calling hook
 * @returns {{installed: boolean, locallyModified: boolean}}
 */
function installProvenance(moduleFilename) {
  try {
    const file = path.resolve(String(moduleFilename || ''));
    const marker = `${path.sep}node_modules${path.sep}@kontourai${path.sep}flow-agents${path.sep}`;
    const idx = file.indexOf(marker);
    if (idx < 0) return { installed: false, locallyModified: false };
    const packageRoot = file.slice(0, idx + marker.length - 1);
    const manifestMtime = fs.statSync(path.join(packageRoot, 'package.json')).mtimeMs;
    const fileMtime = fs.statSync(file).mtimeMs;
    // 5s slack absorbs ordinary within-install write spread; a hand-sync is minutes or hours later.
    return { installed: true, locallyModified: fileMtime > manifestMtime + 5000 };
  } catch {
    return { installed: false, locallyModified: false };
  }
}

module.exports = {
  DEFAULT_COOLDOWN_SECONDS,
  ACTIVE_STATE_STATUSES,
  MUTATING_TOOLS,
  resolveSubjectBindingMode,
  resolveNoticeCooldownSeconds,
  boundSubject,
  boundSubjectKey,
  classifyMutation,
  backlogCreateCommand,
  subjectStatus,
  noticeCooldownElapsed,
  recordNotice,
  installProvenance,
};
