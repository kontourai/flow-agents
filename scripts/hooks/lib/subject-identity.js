'use strict';
/**
 * subject-identity.js — the ONE deterministic subject-identity derivation
 *
 * Zero external dependencies. Consumed by:
 *   - scripts/hooks/workflow-steering.js       (CJS, direct require)
 *   - scripts/hooks/lib/liveness-heartbeat.js  (CJS, direct require)
 *   - build/src/lib/work-item-identity.js      (ESM compiled, via createRequire)
 *   - build/src/cli/workflow-sidecar.js        (ESM compiled, via createRequire)
 *
 * WHY THIS EXISTS (#1099): the liveness collision join (`freshHolders`, see
 * liveness-read.js) matches on the subject *string*. That makes the subject id the
 * collision key — so two lanes working the same backlog item only see each other if
 * they independently produce the SAME string. Counted in one repo's artifact root, 95
 * existing subjects used four incompatible schemes (`owner-repo-<n>`, `s<n>-<words>`,
 * `<words>-<n>`, and free text with no backlog reference at all). Two agents on the
 * same issue could reasonably land on two of them and never collide-detect.
 *
 * The fix is not a new convention — it is removing the choice. The subject id is
 * DERIVED from the backlog item (`workItemSlugResult`), never picked, so every lane
 * working an item computes the same key mechanically. This module is that derivation,
 * shared as pure CJS so the hooks (which cannot import TypeScript) and the CLI cannot
 * drift apart: a divergence here would silently un-join the collision check, which is
 * exactly the defect class being closed. src/lib/work-item-identity.ts delegates here
 * rather than keeping a second copy (consume, never fork).
 *
 * TWO NAMESPACES, deliberately separate:
 *   - work-item : id derived from a provider backlog ref (`owner/repo#123` or
 *                 `provider:id`). Deterministic, joinable, the default path.
 *   - local     : free text, for work with genuinely no backlog item. Joinable only
 *                 with itself — by construction, not by accident.
 *
 * Exports:
 *   workItemSlugResult(ref)                  → { slug, error }
 *   parseGitHubWorkItemRefResult(ref)        → { parsed, error }
 *   canonicalSubjectId(ref)                  → string|null   (never throws)
 *   subjectNamespace(ref)                    → 'work-item'|'local'
 *   canonicalSubjectKeyFromRefs(refs)        → string|null
 *   sessionWorkItemRef(artifactRoot, slug)   → string|null
 *   canonicalSubjectKey(artifactRoot, slug)  → string|null
 *   readOriginRepo(repoRoot, env)            → 'owner/name'|null
 *   backlogRefsInText(text, defaultRepo)     → string[]  (canonical owner/repo#N refs)
 */

const fs = require('fs');
const path = require('path');

/** Max backlog references lifted out of one prompt (bounded output, bounded work). */
const MAX_TEXT_REFS = 3;

/** Max prompt characters scanned for backlog references. */
const MAX_TEXT_SCAN = 4000;

/**
 * Lowercase/collapse a value into a slug segment. Byte-for-byte the same rule
 * src/lib/work-item-identity.ts used before it delegated here — changing it would
 * rename every existing derived subject, so it does not change.
 */
function slugPart(value, fallback) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || fallback;
}

const GITHUB_REF_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9]\d*)$/;
const PROVIDER_REF_RE = /^[a-z][a-z0-9-]*:[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * Parse an `owner/repo#123` reference.
 *
 * Result-shaped (never throws) so hook code can call it on untrusted text. The TS
 * wrapper re-throws `error` verbatim, which is why the message strings live here and
 * must not be reworded independently.
 *
 * @param {string} ref
 * @returns {{ parsed: {owner: string, name: string, issueNumber: number}|null, error: string|null }}
 */
function parseGitHubWorkItemRefResult(ref) {
  const match = GITHUB_REF_RE.exec(String(ref === undefined || ref === null ? '' : ref));
  if (!match) return { parsed: null, error: '--work-item must be an exact owner/repo#positive-numeric-id reference with a numeric issue number' };
  const issueNumber = Number(match[3]);
  if (!Number.isSafeInteger(issueNumber)) return { parsed: null, error: '--work-item issue number exceeds the safe integer range' };
  return { parsed: { owner: match[1], name: match[2], issueNumber }, error: null };
}

/**
 * Derive the canonical subject id for a work-item reference.
 *
 * `owner/repo#123` → `owner-repo-123`; a provider-neutral `provider:id` → its slugged
 * form. This IS the collision key: same backlog item ⇒ same string, from any lane, on
 * any machine, with no coordination.
 *
 * @param {string} ref
 * @returns {{ slug: string|null, error: string|null }}
 */
function workItemSlugResult(ref) {
  const value = String(ref === undefined || ref === null ? '' : ref);
  const hashIdx = value.indexOf('#');
  if (hashIdx < 0) {
    if (!PROVIDER_REF_RE.test(value) || value.includes('..')) {
      return { slug: null, error: '--work-item must be a provider-neutral provider:id ref or owner/repo#numeric-id' };
    }
    return { slug: slugPart(value, 'work-item'), error: null };
  }
  const { parsed, error } = parseGitHubWorkItemRefResult(value);
  if (error) return { slug: null, error };
  return { slug: slugPart(`${parsed.owner}-${parsed.name}-${parsed.issueNumber}`, 'work-item'), error: null };
}

/**
 * Non-throwing convenience wrapper: the canonical subject id, or null when `ref` is not
 * a usable work-item reference.
 *
 * @param {string} ref
 * @returns {string|null}
 */
function canonicalSubjectId(ref) {
  return workItemSlugResult(ref).slug;
}

/**
 * Which namespace a work-item reference belongs to. `local:<id>` refs are the free-text
 * namespace ensure-session mints for work with no backlog item; everything else that
 * parses is a joinable backlog subject.
 *
 * @param {string} ref
 * @returns {'work-item'|'local'}
 */
function subjectNamespace(ref) {
  const value = String(ref === undefined || ref === null ? '' : ref);
  if (value.startsWith('local:')) return 'local';
  return canonicalSubjectId(value) ? 'work-item' : 'local';
}

/**
 * The canonical collision key implied by a session's recorded Work Item binding.
 *
 * Returns null for the `local:` namespace (free-text work, joinable only with itself)
 * and for a session with no usable binding. This is the MIGRATION path for the 95
 * legacy subjects: a session directory keeps its historical name forever — nothing is
 * renamed — and still collide-detects against a canonically-named lane, because the key
 * is derived from the binding the session already records, not guessed from its name.
 *
 * @param {unknown} refs  state.json `work_item_refs`
 * @returns {string|null}
 */
function canonicalSubjectKeyFromRefs(refs) {
  if (!Array.isArray(refs)) return null;
  const ref = refs.find((value) => typeof value === 'string' && value);
  if (!ref || ref.startsWith('local:')) return null;
  return canonicalSubjectId(ref);
}

/** True when `slug` is usable as a single directory name (no separators, no traversal). */
function isSafeSessionSlug(slug) {
  if (typeof slug !== 'string' || !slug) return false;
  if (slug === '.' || slug === '..') return false;
  if (slug.includes('/') || slug.includes('\\')) return false;
  return path.basename(slug) === slug;
}

/**
 * Read a session's first recorded Work Item ref from `<artifactRoot>/<slug>/state.json`.
 * Fail-open: any missing/unreadable/malformed input yields null.
 *
 * @param {string} artifactRoot
 * @param {string} slug
 * @returns {string|null}
 */
function sessionWorkItemRef(artifactRoot, slug) {
  if (!artifactRoot || !isSafeSessionSlug(slug)) return null;
  try {
    const payload = JSON.parse(fs.readFileSync(path.join(artifactRoot, slug, 'state.json'), 'utf8'));
    const refs = payload && payload.work_item_refs;
    if (!Array.isArray(refs)) return null;
    const ref = refs.find((value) => typeof value === 'string' && value);
    return ref || null;
  } catch {
    return null;
  }
}

/**
 * Per-process memo for canonicalSubjectKey. The tool-activity heartbeat calls it on a
 * hot path; a session's Work Item binding is immutable once written (ensure-session
 * refuses to rebind, see sessionWorkItem in workflow-sidecar.ts), so caching within one
 * short-lived hook process cannot go stale in a way that matters.
 */
const subjectKeyCache = new Map();

/**
 * The canonical collision key for an existing session directory, or null when the
 * session is free-text/local or has no readable binding.
 *
 * @param {string} artifactRoot
 * @param {string} slug
 * @returns {string|null}
 */
function canonicalSubjectKey(artifactRoot, slug) {
  const cacheKey = `${artifactRoot} ${slug}`;
  if (subjectKeyCache.has(cacheKey)) return subjectKeyCache.get(cacheKey);
  const ref = sessionWorkItemRef(artifactRoot, slug);
  const key = ref && !ref.startsWith('local:') ? canonicalSubjectId(ref) : null;
  subjectKeyCache.set(cacheKey, key);
  return key;
}

const REMOTE_SSH_RE = /^git@[^:]+:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const REMOTE_URL_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/]*\/(?:.*\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const OWNER_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Resolve this checkout's `owner/name` so a bare `#123` in a prompt can be turned into a
 * canonical subject id.
 *
 * `FLOW_AGENTS_REPO` wins (same precedence workflow-sidecar.ts's repoIdentifier uses, and
 * the seam tests set), then `<repoRoot>/.git/config`'s origin URL — parsed with fs, never
 * by shelling out to git, because this runs on every UserPromptSubmit. Returns null rather
 * than guessing.
 *
 * @param {string} repoRoot
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
function readOriginRepo(repoRoot, env = process.env) {
  const explicit = String((env && env.FLOW_AGENTS_REPO) || '').trim().replace(/\.git$/, '');
  if (explicit && OWNER_REPO_RE.test(explicit)) return explicit;
  try {
    const gitPath = path.join(repoRoot, '.git');
    let gitDir = gitPath;
    const stat = fs.statSync(gitPath);
    if (!stat.isDirectory()) {
      // Linked worktree: `.git` is a file containing `gitdir: <path>`. Callers normally
      // pass the SHARED repo root (a real .git directory), so this is only a fallback.
      const pointer = fs.readFileSync(gitPath, 'utf8').trim();
      const match = /^gitdir:\s*(.+)$/m.exec(pointer);
      if (!match) return null;
      gitDir = path.resolve(repoRoot, match[1].trim());
    }
    const config = fs.readFileSync(path.join(gitDir, 'config'), 'utf8');
    let inOrigin = false;
    for (const rawLine of config.split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('[')) {
        inOrigin = /^\[remote\s+"origin"\]$/.test(line);
        continue;
      }
      if (!inOrigin) continue;
      const urlMatch = /^url\s*=\s*(.+)$/.exec(line);
      if (!urlMatch) continue;
      const url = urlMatch[1].trim().replace(/\.git$/, '');
      const ssh = REMOTE_SSH_RE.exec(url);
      if (ssh) return `${ssh[1]}/${ssh[2]}`;
      const http = REMOTE_URL_RE.exec(url);
      if (http) return `${http[1]}/${http[2]}`;
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

const EXPLICIT_REF_RE = /(^|[^A-Za-z0-9_./-])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d{0,6})(?![0-9A-Za-z])/g;
const BARE_REF_RE = /(^|[^A-Za-z0-9_.#/-])#([1-9]\d{0,6})(?![0-9A-Za-z])/g;

/**
 * Lift backlog references out of prompt text, normalised to `owner/repo#N`.
 *
 * Explicit `owner/repo#123` always resolves. A bare `#123` resolves only when
 * `defaultRepo` is known — this is the deliberate accepted false-positive surface
 * (a prompt saying "the #1 priority" yields `owner/repo#1`), and it is why the caller
 * only ever renders these as an advisory that names the reference it read, never as a
 * block and never as an automatic binding.
 *
 * @param {string} text
 * @param {string|null} [defaultRepo]  `owner/name` for bare `#N` resolution
 * @returns {string[]}  deduped, at most MAX_TEXT_REFS
 */
function backlogRefsInText(text, defaultRepo = null) {
  const value = String(text === undefined || text === null ? '' : text).slice(0, MAX_TEXT_SCAN);
  if (!value) return [];
  const out = [];
  const seen = new Set();
  const push = (ref) => {
    if (seen.has(ref) || out.length >= MAX_TEXT_REFS) return;
    if (!canonicalSubjectId(ref)) return;
    seen.add(ref);
    out.push(ref);
  };
  for (const match of value.matchAll(EXPLICIT_REF_RE)) push(`${match[2]}#${match[3]}`);
  if (defaultRepo && OWNER_REPO_RE.test(defaultRepo)) {
    for (const match of value.matchAll(BARE_REF_RE)) push(`${defaultRepo}#${match[2]}`);
  }
  return out;
}

module.exports = {
  MAX_TEXT_REFS,
  workItemSlugResult,
  parseGitHubWorkItemRefResult,
  canonicalSubjectId,
  subjectNamespace,
  canonicalSubjectKeyFromRefs,
  sessionWorkItemRef,
  canonicalSubjectKey,
  readOriginRepo,
  backlogRefsInText,
};
