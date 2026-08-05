'use strict';

/**
 * Unstarted-delivery Stop advisory (never blocking).
 *
 * The Stop gate enforces ADHERENCE to a workflow session once one exists. It has never had an
 * opinion about work that never started one: with no session artifacts and no scoped session,
 * analyze() returns `{ warnings: [], blocking: false }` and the Stop is silent. A night of
 * agent-delivered source changes across several repos therefore produced no bundles and no local
 * signal — only CI's Trust Reconcile caught it, after the merge.
 *
 * This module closes that seam as narrowly as possible. It fires only when ALL of:
 *
 *   1. the repo is Kit-configured for implementation routing — it declares at least one
 *      `implementation-work-detected` workflow trigger, resolved through the SAME
 *      `workflowTriggersFor()` seam the UserPromptSubmit steering uses. The advisory therefore
 *      arms exactly where the steering it backs is configured, and stays silent everywhere else;
 *   2. the turn left MODIFIED TRACKED SOURCE in the working tree (see isSourcePath) — a
 *      docs/markdown tweak, an untracked scratch file, or a read-only turn is not delivery;
 *   3. the caller established there is no workflow session to scope to (the caller owns this
 *      condition — this module is only invoked from Stop's no-session path);
 *   4. no well-formed, in-scope `delivery/DECLARED` no-agent-delivery exemption covers the
 *      current branch/actor (ADR 0022 §2).
 *
 * It NEVER blocks and NEVER creates a session. Auto-creating one on a kit-configured repo is the
 * tempting reading of "activate when configured" and it is wrong: it would spawn a session for
 * every typo fix, which is precisely the ceremony that teaches agents which gates are ceremony.
 * The warning names the two ways out and stops there.
 *
 * ROOT ASYMMETRY (deliberate): the Kit-configured check uses the caller's `root`
 * (findRepoRoot → git's SHARED common-dir root, #357) so it agrees byte-for-byte with the
 * steering hook's view of "is this repo configured" — repo-level policy is shared across linked
 * worktrees. The working-tree scan and the DECLARED lookup use the CALLER'S OWN worktree
 * toplevel, because the change set and the exemption that covers it are branch-level facts that
 * belong to the worktree the agent is actually in, not to whatever branch the primary checkout
 * happens to have out.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { workflowTriggersFor } = require('./kit-catalog');
const { resolveActor } = require('./actor-identity');

/** Distinguishing marker for the advisory. Kept out of HARD_BLOCK/FULL_BLOCK vocabulary. */
const UNSTARTED_DELIVERY_PATTERN = / delivery not started — /;

/** Bound on the git calls so a slow/locked repo can never hang a Stop. */
const GIT_TIMEOUT_MS = 5000;

/** How many changed paths to name in the message before summarising the remainder. */
const MAX_NAMED_PATHS = 3;

/** Required, non-empty-string fields on every delivery/DECLARED entry (ADR 0022 §2). */
const DECLARED_REQUIRED_FIELDS = ['scope', 'reason', 'approved_by', 'declared_at'];

function git(cwd, args) {
  try {
    const res = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (!res || res.error || res.status !== 0 || typeof res.stdout !== 'string') return null;
    return res.stdout;
  } catch {
    return null;
  }
}

/** The git worktree the session is actually in (NOT the shared primary checkout). */
function worktreeToplevel(cwd) {
  const out = git(cwd, ['rev-parse', '--show-toplevel']);
  const top = out ? out.trim() : '';
  return top || null;
}

/** Current branch name, or '' when detached/underivable (never matches a scope condition). */
function currentBranch(cwd) {
  const out = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = out ? out.trim() : '';
  return branch && branch !== 'HEAD' ? branch : '';
}

/**
 * Paths this advisory treats as NOT source. Being wrong in this direction is cheap (the advisory
 * stays quiet); being wrong the other way trains people to ignore it. Documentation, delivery
 * records, and runtime artifact areas are excluded outright.
 */
function isSourcePath(rel) {
  if (!rel) return false;
  const normalized = rel.split(path.sep).join('/');
  if (normalized.startsWith('docs/')) return false;
  if (normalized.startsWith('delivery/')) return false;
  if (normalized.startsWith('.kontourai/')) return false;
  if (normalized.startsWith('.flow-agents/')) return false;
  if (normalized.startsWith('.claude/')) return false;
  if (normalized.startsWith('.github/ISSUE_TEMPLATE/')) return false;
  if (/\.(md|mdx|markdown|txt|rst|adoc)$/i.test(normalized)) return false;
  return true;
}

/**
 * Tracked, modified paths in `worktree`. `-uno` excludes untracked files entirely, so a scratch
 * file or an unstaged new file never arms the advisory; only changes to files git already tracks
 * count as "modified tracked source". Returns [] when git is unavailable or the scan fails —
 * fail-open is mandatory in a Stop hook.
 */
function modifiedTrackedPaths(worktree) {
  const out = git(worktree, ['status', '--porcelain=v1', '-uno', '--no-renames']);
  if (out === null) return [];
  const paths = [];
  for (const line of out.split('\n')) {
    if (line.length < 4) continue;
    // Porcelain v1: XY<space><path>. Quoted paths (core.quotepath) are left as-is; they still
    // count as a change, and the message only ever displays them.
    const rel = line.slice(3).trim();
    if (rel) paths.push(rel);
  }
  return paths;
}

/** Parse delivery/DECLARED into its well-formed entries. Malformed entries are ignored, never fatal. */
function wellFormedDeclaredEntries(worktree) {
  const markerPath = path.join(worktree, 'delivery', 'DECLARED');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    return [];
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  return entries.filter(entry => DECLARED_REQUIRED_FIELDS.every(field => {
    const value = entry && typeof entry === 'object' ? entry[field] : undefined;
    return typeof value === 'string' && value.trim() !== '';
  }));
}

/**
 * Local evaluation of a DECLARED scope condition. String equality/prefix only — no RegExp is
 * ever constructed from marker content (delivery/README.md's matching-semantics note).
 *
 * Only the three conditions that are DERIVABLE LOCALLY are honored: `ref:`, `branch-prefix:`,
 * and `author:`. `commit:` scopes are CI-shaped (they range over a pushed sha) and are treated
 * as non-matching here, so a `commit:`-scoped entry never silences a local Stop — the strict
 * direction. An empty context value never matches, so an empty scope segment cannot become an
 * accidental wildcard (same rule as scripts/ci/trust-reconcile.js's resolveScopeContext).
 */
function matchesLocalScopeCondition(condition, ctx) {
  const s = typeof condition === 'string' ? condition : '';
  if (s.startsWith('ref:')) {
    const want = s.slice('ref:'.length);
    return !!want && !!ctx.ref && ctx.ref === want;
  }
  if (s.startsWith('branch-prefix:')) {
    const want = s.slice('branch-prefix:'.length);
    return !!want && !!ctx.ref && ctx.ref.startsWith(want);
  }
  if (s.startsWith('author:')) {
    const want = s.slice('author:'.length);
    return !!want && !!ctx.actor && ctx.actor === want;
  }
  return false;
}

/** Compound scopes are space-separated and ANDed — every condition must match (ADR 0022 §2). */
function matchesLocalScope(scope, ctx) {
  const conditions = String(scope || '').split(' ').map(c => c.trim()).filter(Boolean);
  if (conditions.length === 0) return false;
  return conditions.every(condition => matchesLocalScopeCondition(condition, ctx));
}

function hasScopedDeliveryExemption(worktree, env) {
  const entries = wellFormedDeclaredEntries(worktree);
  if (entries.length === 0) return false;
  const ctx = { ref: currentBranch(worktree), actor: resolveActor(env).actor || '' };
  return entries.some(entry => matchesLocalScope(entry.scope, ctx));
}

function describePaths(paths) {
  const named = paths.slice(0, MAX_NAMED_PATHS).join(', ');
  const extra = paths.length - Math.min(paths.length, MAX_NAMED_PATHS);
  return extra > 0 ? `${named}, +${extra} more` : named;
}

/**
 * @param {{ root: string, cwd: string, env?: object }} options
 * @returns {string|null} the advisory line, or null when it must stay silent
 */
function unstartedDeliveryWarning({ root, cwd, env = process.env } = {}) {
  try {
    if (!root || !cwd) return null;

    // (1) Kit-configured for implementation routing? Same seam as the steering hook.
    let triggers;
    try {
      triggers = workflowTriggersFor(root, 'implementation-work-detected');
    } catch {
      return null;
    }
    if (!Array.isArray(triggers) || triggers.length === 0) return null;

    // (2) Modified tracked SOURCE in the caller's own worktree?
    const worktree = worktreeToplevel(cwd);
    if (!worktree) return null;
    const changed = modifiedTrackedPaths(worktree).filter(isSourcePath);
    if (changed.length === 0) return null;

    // (4) A well-formed, in-scope DECLARED exemption covers this branch/actor?
    if (hasScopedDeliveryExemption(worktree, env)) return null;

    const flowId = triggers.map(t => t && t.target_flow_id).find(Boolean) || 'builder.build';
    const fileWord = changed.length === 1 ? 'file' : 'files';
    return `delivery not started — ${changed.length} tracked source ${fileWord} changed (${describePaths(changed)}) `
      + 'but this session never opened a workflow session, and this repo\'s Kit routes implementation work through '
      + `\`${flowId}\`. Either open one (\`workflow-sidecar ensure-session --task-slug <slug> --flow-id ${flowId}\`), `
      + 'or record a scoped no-agent-delivery exemption in `delivery/DECLARED` (ADR 0022 §2). '
      + 'Advisory only — this never blocks a stop.';
  } catch {
    return null;
  }
}

module.exports = {
  unstartedDeliveryWarning,
  UNSTARTED_DELIVERY_PATTERN,
  isSourcePath,
  matchesLocalScope,
};
