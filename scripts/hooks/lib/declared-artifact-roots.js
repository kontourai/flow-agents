#!/usr/bin/env node
/**
 * declared-artifact-roots.js — computes the set of DECLARED artifact roots a path must be
 * inside for config-protection.js's Bash-command detectors (redirect / interpreter-write /
 * cp-move) to treat it as a real flow-agents runtime artifact, per #783.
 *
 * Before #783, config-protection.js's redirect/interpreter/cp-move detectors matched any
 * command referencing a `state.json`/`current.json`/`trust.bundle`-SHAPED path anywhere on the
 * filesystem, including test-fixture scratch dirs with no real session (issue #783). This module
 * scopes that matching: a shape match only blocks when the resolved path is inside one of:
 *
 *   1. `cwd`'s OWN git working-tree root (the nearest ancestor with a `.git` entry) -- this is
 *      where a LITERAL, cwd-relative shell command target actually lands, regardless of any
 *      cross-worktree sharing.
 *   2. The SHARED repo root `resolveSharedRepoRoot` resolves for `cwd` (in a linked worktree
 *      this is the PRIMARY checkout, matching `flowAgentsArtifactRoot`'s own resolution and thus
 *      the location the real sidecar CLI treats as canonical). Root 1 and root 2 are often the
 *      SAME directory (the common single-checkout case) and are de-duplicated; when they differ
 *      (a linked worktree) BOTH are protected -- strictly more conservative than picking one.
 *   3. Any CONFIGURED workspace root (`SA_PROTECTED_WORKSPACE_ROOTS`, a comma-separated list of
 *      absolute paths) -- for sessions that legitimately span more than one checkout/workspace
 *      in a single agent run.
 *
 * Each root above contributes three flow-agents-owned sub-roots: `.kontourai/flow-agents`,
 * `.flow-agents`, `delivery`.
 *
 * FAIL-CLOSED CONTRACT (do not weaken): `declaredArtifactRoots` returns `{ ambiguous: true }`
 * whenever `cwd` is genuinely inside a git working tree (a `.git` entry was found) but the
 * shared-repo-root resolution (`resolveSharedRepoRoot`) failed -- i.e. root detection was
 * ATTEMPTED and FAILED (corrupted gitlink, bad GIT_DIR, git binary missing), not "there is no
 * repo here at all". Callers MUST treat `ambiguous: true` as "keep blocking" (the pre-#783
 * global behavior for that invocation), never as "no roots, so nothing is protected". Genuinely
 * no git repo at `cwd` is NOT ambiguous -- it mirrors `flowAgentsArtifactRoot`'s own cwd
 * fallback, so a real sidecar session invoked from that same cwd would write to exactly the
 * declared root this module reports.
 *
 * `resolveCandidatePath` similarly fails closed: a token containing an unresolvable shell
 * construct (`$(...)`, backticks, `${...}`) or carrying NO directory context at all (a bare
 * filename with no path separator) returns `{ ambiguous: true }` rather than guessing -- a bare
 * basename alone proves nothing about location, so "provably outside every declared root" can
 * never be established for it.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { resolveSharedRepoRoot } = require('./local-artifact-paths.js');

const WORKSPACE_ROOTS_ENV = 'SA_PROTECTED_WORKSPACE_ROOTS';

/** The three flow-agents-owned sub-roots under a single repo/workspace root. */
function subRootsFor(root) {
  return [
    path.join(root, '.kontourai', 'flow-agents'),
    path.join(root, '.flow-agents'),
    path.join(root, 'delivery'),
  ];
}

/**
 * Nearest ancestor of `startDir` containing a `.git` entry (a directory for a primary checkout,
 * or a file for a linked worktree's gitdir pointer), or null if none found within the bounded
 * walk. Never throws -- a filesystem error at any level is treated as "no .git found here".
 */
function walkForGitMarker(startDir) {
  try {
    let dir = path.resolve(startDir);
    const root = path.parse(dir).root;
    for (let depth = 0; depth < 40; depth++) {
      if (fs.existsSync(path.join(dir, '.git'))) return dir;
      if (dir === root) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}

function configuredWorkspaceRoots() {
  const raw = String(process.env[WORKSPACE_ROOTS_ENV] || '');
  if (!raw.trim()) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(entry));
}

/**
 * declaredArtifactRoots(cwd) -> { roots: string[], ambiguous: boolean, repoRoots: string[] }
 *
 * `roots` is always an absolute-path array. When `ambiguous` is true, `roots` is deliberately
 * empty -- callers must treat ambiguous as "keep blocking regardless of path", never fall back
 * to scoping against an empty root list (which would mean "nothing is protected").
 */
function declaredArtifactRoots(cwd) {
  const resolvedCwd = path.resolve(cwd || process.cwd());
  const worktreeOwnRoot = walkForGitMarker(resolvedCwd);
  const repoRoots = new Set();
  let ambiguous = false;

  if (worktreeOwnRoot) {
    // Genuinely inside a git working tree. Always protect cwd's OWN root -- this is where a
    // literal, cwd-relative shell command target actually lands.
    repoRoots.add(worktreeOwnRoot);
    const sharedRoot = resolveSharedRepoRoot(resolvedCwd);
    if (sharedRoot) {
      // May be the SAME directory (single checkout) or the PRIMARY checkout root (linked
      // worktree) -- protecting both means neither the canonical shared store nor a literal
      // cwd-relative shell target escapes protection.
      repoRoots.add(sharedRoot);
    } else {
      // A `.git` entry exists (git resolution was ATTEMPTED) but resolveSharedRepoRoot FAILED
      // -- corrupted gitlink, bad GIT_DIR, git binary missing, etc. We cannot trust ANY root
      // boundary here. FAIL CLOSED.
      ambiguous = true;
    }
  } else {
    // Genuinely no git repo anywhere above cwd: mirror flowAgentsArtifactRoot's own cwd
    // fallback so the declared root matches what a real sidecar session invoked from this same
    // cwd would actually write to.
    repoRoots.add(resolvedCwd);
  }

  const roots = [];
  if (!ambiguous) {
    for (const root of repoRoots) roots.push(...subRootsFor(root));
    for (const extra of configuredWorkspaceRoots()) roots.push(...subRootsFor(extra));
  }

  return { roots: [...new Set(roots)], ambiguous, repoRoots: [...repoRoots] };
}

/**
 * resolveCandidatePath(token, cwd) -> { path: string|null, ambiguous: boolean }
 *
 * Resolves a shell-command path token to an absolute path for containment checking.
 * Returns `{ path: null, ambiguous: true }` when:
 *   - the token contains an unresolvable shell construct (command substitution, unexpanded
 *     parameter expansion) -- we cannot know where the write will actually land;
 *   - the token carries NO directory context at all (no `/`, not `~`-rooted) -- a bare
 *     basename proves nothing about location, so "provably outside" can never be established.
 */
function resolveCandidatePath(token, cwd) {
  if (typeof token !== 'string' || token.length === 0) return { path: null, ambiguous: true };
  if (/\$\(|`|\$\{/.test(token)) return { path: null, ambiguous: true };

  let expanded = token;
  if (expanded === '~' || expanded.startsWith('~/')) {
    expanded = path.join(os.homedir(), expanded.slice(1));
  } else if (/^~[^/]/.test(expanded)) {
    // `~otheruser/...` -- a different home directory we cannot resolve without a passwd
    // lookup. Fail closed rather than guessing.
    return { path: null, ambiguous: true };
  } else if (!expanded.includes('/')) {
    // A bare filename with no directory context at all. Fail closed: see doc comment above.
    return { path: null, ambiguous: true };
  }

  const resolvedCwd = path.resolve(cwd || process.cwd());
  const abs = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(resolvedCwd, expanded);
  return { path: abs, ambiguous: false };
}

/** True when `absPath` equals, or is nested under, one of `roots`. */
function isWithinAnyRoot(absPath, roots) {
  if (!absPath) return false;
  return roots.some((root) => absPath === root || absPath.startsWith(root + path.sep));
}

/**
 * isCandidateWithinDeclaredRoots(candidateToken, cwd) -> boolean
 *
 * The single fail-closed decision point config-protection.js's Bash detectors use for a
 * SCOPED (flow-agents-shaped) path token: true when the token resolves to a path inside a
 * declared root, OR when either the root set or the token itself is ambiguous (fail closed).
 * False only when the token provably resolves OUTSIDE every declared root.
 */
function isCandidateWithinDeclaredRoots(candidateToken, cwd) {
  const { roots, ambiguous } = declaredArtifactRoots(cwd);
  if (ambiguous) return true;
  if (!candidateToken) return true; // no isolable candidate -- fail closed
  const resolved = resolveCandidatePath(candidateToken, cwd);
  if (resolved.ambiguous || resolved.path === null) return true;
  return isWithinAnyRoot(resolved.path, roots);
}

module.exports = {
  WORKSPACE_ROOTS_ENV,
  declaredArtifactRoots,
  resolveCandidatePath,
  isWithinAnyRoot,
  isCandidateWithinDeclaredRoots,
};
