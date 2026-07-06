'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const KONTOURAI_DIR = '.kontourai';
const FLOW_AGENTS_RUNTIME_SUBDIR = 'flow-agents';
const FLOW_AGENTS_RUNTIME_DIR = `${KONTOURAI_DIR}/${FLOW_AGENTS_RUNTIME_SUBDIR}`;
const DURABLE_FLOW_AGENTS_DIR = '.flow-agents';

/**
 * #357: resolve the SHARED, git-common-dir-anchored repo root for `cwd`. CJS twin of
 * src/lib/local-artifact-root.ts's resolveSharedRepoRoot — see that file's doc comment for
 * the full rationale (git-common-dir resolves to the SAME primary-checkout .git directory
 * from any linked worktree, so path.dirname() of its absolute form is the one shared repo
 * root every worktree of a repo should read/write .kontourai/flow-agents under). Returns
 * null (never throws) when git is unavailable, cwd is not inside a git working tree, or the
 * command fails — callers MUST fail open to the existing cwd-based behavior in that case.
 *
 * #413 iteration-2 Fix 3: strips the ambient GIT_DIR/GIT_COMMON_DIR/GIT_WORK_TREE/
 * GIT_CEILING_DIRECTORIES env vars before shelling out — see the TS twin's doc comment for
 * the full rationale (an ambient GIT_DIR etc. could otherwise silently redirect resolution to
 * a different repo than the one cwd is actually inside).
 */
function resolveSharedRepoRoot(cwd) {
  try {
    const env = { ...process.env };
    delete env.GIT_DIR;
    delete env.GIT_COMMON_DIR;
    delete env.GIT_WORK_TREE;
    delete env.GIT_CEILING_DIRECTORIES;
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return null;
    const absoluteCommonDir = path.resolve(cwd, out);
    return path.dirname(absoluteCommonDir);
  } catch {
    return null;
  }
}

/**
 * #413 iteration-2 Fix 1: cheap discriminator for the loud-vs-silent fail-open decision below.
 * CJS twin of the TS lib's isInsideGitWorkingTree — see that file's doc comment for the full
 * rationale. Walks up from `cwd` looking for a `.git` entry (file or directory) without
 * shelling out to git, so it stays meaningful even when git itself is broken/absent.
 */
function isInsideGitWorkingTree(cwd) {
  try {
    let dir = path.resolve(cwd);
    const root = path.parse(dir).root;
    for (let depth = 0; depth < 40; depth++) {
      if (fs.existsSync(path.join(dir, '.git'))) return true;
      if (dir === root) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * #413 iteration-2 Fix 1 (HIGH, security): emit a LOUD stderr warning before falling open, but
 * ONLY when `cwd` is genuinely inside a git working tree AND resolveSharedRepoRoot still
 * returned null. See the TS twin's doc comment for the full rationale — the benign case (no
 * git repo at all) must stay perfectly silent; the loud case is #357's exact silent-fail-open
 * bug (an isolated, invisible cwd-local store), and a warning (not a hard refuse, since this
 * sits on read paths too) gives an operator the signal to pass --artifact-root explicitly.
 */
function warnIfFailingOpenInsideGitTree(cwd, fallbackPath) {
  if (!isInsideGitWorkingTree(cwd)) return;
  process.stderr.write(
    `[artifact-root] WARNING: inside a git working tree but could not resolve the shared repo root ` +
      `(git rev-parse --git-common-dir failed or returned nothing from ${cwd}); falling back to a ` +
      `cwd-local store at ${fallbackPath} — coordination claims may be invisible to other ` +
      `worktrees/actors. Pass --artifact-root explicitly to fix.\n`
  );
}

/**
 * #413 iteration-2 Fix 2 (documentation only, no behavior change): CJS twin of the TS lib's own
 * doc comment on flowAgentsArtifactRoot — see that file for the full rationale. A SUBDIRECTORY
 * cwd of a plain checkout intentionally resolves to the shared <repo-root>/.kontourai/flow-agents
 * store (via the git-common-dir walk-up), not a subdir-anchored path.resolve(cwd, ...) — the
 * correct one-store-per-repo semantics, not a regression.
 */
function flowAgentsArtifactRoot(cwd = process.cwd()) {
  const sharedRepoRoot = resolveSharedRepoRoot(cwd);
  if (sharedRepoRoot) return path.resolve(sharedRepoRoot, FLOW_AGENTS_RUNTIME_DIR);
  // Fail-open: not a git repo, git unavailable, or command failed — reproduce today's plain
  // cwd-based behavior unchanged (AC6 backward-compat guarantee). #413 iteration-2 Fix 1: loud,
  // not silent, when cwd IS inside a git working tree (see warnIfFailingOpenInsideGitTree).
  const fallback = path.resolve(cwd, FLOW_AGENTS_RUNTIME_DIR);
  warnIfFailingOpenInsideGitTree(cwd, fallback);
  return fallback;
}

function durableFlowAgentsRoot(cwd = process.cwd()) {
  return path.resolve(cwd, DURABLE_FLOW_AGENTS_DIR);
}

function flowAgentsArtifactRootsForRead(cwd = process.cwd()) {
  const roots = [flowAgentsArtifactRoot(cwd)];
  return roots.filter((root, index) => roots.indexOf(root) === index && fs.existsSync(root));
}

function defaultArtifactRootForRead(cwd = process.cwd()) {
  const roots = flowAgentsArtifactRootsForRead(cwd);
  return roots[0] || flowAgentsArtifactRoot(cwd);
}

module.exports = {
  DURABLE_FLOW_AGENTS_DIR,
  FLOW_AGENTS_RUNTIME_DIR,
  FLOW_AGENTS_RUNTIME_SUBDIR,
  KONTOURAI_DIR,
  durableFlowAgentsRoot,
  flowAgentsArtifactRoot,
  flowAgentsArtifactRootsForRead,
  defaultArtifactRootForRead,
  resolveSharedRepoRoot,
  // #413 iteration-2 Fix 1: exported so findRepoRoot in stop-goal-fit.js/workflow-steering.js
  // can apply the SAME loud-when-in-git-tree warning this lib's own flowAgentsArtifactRoot
  // uses, rather than a second, independently-drifting copy of the discriminator.
  warnIfFailingOpenInsideGitTree,
};
