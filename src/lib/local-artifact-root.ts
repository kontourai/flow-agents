import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

export const KONTOURAI_DIR = ".kontourai";
export const FLOW_AGENTS_RUNTIME_SUBDIR = "flow-agents";
export const FLOW_AGENTS_RUNTIME_DIR = `${KONTOURAI_DIR}/${FLOW_AGENTS_RUNTIME_SUBDIR}`;
export const DURABLE_FLOW_AGENTS_DIR = ".flow-agents";
export const LEGACY_TELEMETRY_DIR = ".telemetry";

/**
 * Default Codex home: `$CODEX_HOME` when set, else `~/.codex`.
 *
 * This is the Codex CLI's own config/state root and is conceptually
 * distinct from the Flow Agents global bundle install root (`~/.flow-agents`)
 * and the durable per-destination install record root
 * (`DURABLE_FLOW_AGENTS_DIR`, i.e. `.flow-agents`).
 */
export function defaultCodexHome(): string {
  return process.env["CODEX_HOME"] || path.join(os.homedir(), ".codex");
}

/**
 * #357: resolve the SHARED, git-common-dir-anchored `.kontourai/flow-agents` root for `cwd`.
 *
 * `git rev-parse --git-common-dir` returns the ONE `.git` directory shared by every worktree
 * of a repository (in the primary checkout this is simply `.git` relative to cwd; in a linked
 * worktree it resolves to the primary checkout's real `.git` directory, e.g.
 * `/path/to/primary/.git`, NOT the worktree's own `.git` file). Taking `path.dirname()` of that
 * resolved, absolute path yields the primary checkout's repo root — the one location every
 * worktree of the same repo should treat as the shared `.kontourai/flow-agents` store, so a
 * `liveness claim` or `ensure-session` invoked from ANY worktree's cwd is visible to a reader
 * in any other checkout of the same repo (including the primary one).
 *
 * Returns null (never throws) when git is unavailable, `cwd` is not inside a git working tree,
 * or the command otherwise fails — callers MUST fail open to the existing cwd-based
 * `path.resolve(cwd, FLOW_AGENTS_RUNTIME_DIR)` behavior in that case (see flowAgentsArtifactRoot
 * below), which is also exactly what happens today in the single-checkout case: there,
 * `--git-common-dir` resolves to `.git` under cwd itself, so `path.dirname()` of its absolute
 * form is cwd — byte-identical to today's plain `path.resolve(cwd, ...)` result.
 *
 * #413 iteration-2 Fix 3: strips the ambient GIT_DIR/GIT_COMMON_DIR/GIT_WORK_TREE/
 * GIT_CEILING_DIRECTORIES env vars before shelling out. Any of these, if set in the calling
 * process's environment (e.g. leaked from an outer `git rebase`/hook invocation, or a stray
 * export in a dev shell), can silently redirect `--git-common-dir` to resolve a DIFFERENT
 * repository's `.git` than the one `cwd` is actually inside — which would silently redirect
 * the shared `.kontourai/flow-agents` store to that other repo. Passing an explicit env with
 * those keys deleted makes resolution depend only on `cwd`, never on ambient process state.
 */
export function resolveSharedRepoRoot(cwd: string): string | null {
  try {
    const env = { ...process.env };
    delete env["GIT_DIR"];
    delete env["GIT_COMMON_DIR"];
    delete env["GIT_WORK_TREE"];
    delete env["GIT_CEILING_DIRECTORIES"];
    const out = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
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
 * Walks up from `cwd` (bounded, same 40-level cap the hook-side ancestor walks use) looking for
 * a `.git` entry — a FILE (linked worktree's gitdir pointer) or a DIRECTORY (primary checkout) —
 * without shelling out to git at all, so it stays meaningful even when git itself is the thing
 * that's broken/absent. Never throws; a filesystem error at any level is treated as "no .git
 * found here", not as a crash.
 */
function isInsideGitWorkingTree(cwd: string): boolean {
  try {
    let dir = path.resolve(cwd);
    const root = path.parse(dir).root;
    for (let depth = 0; depth < 40; depth++) {
      if (fs.existsSync(path.join(dir, ".git"))) return true;
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
 * ONLY when `cwd` is genuinely inside a git working tree (per isInsideGitWorkingTree above) AND
 * resolveSharedRepoRoot still returned null — i.e. git resolution was ATTEMPTED and FAILED, not
 * merely "there was no git repo to resolve in the first place". That second, benign case (a
 * scratch dir, a non-git cwd) must stay perfectly silent — this is exactly what
 * evals/integration/test_liveness_worktree_root.sh's AC6 companion case (no git at all) already
 * asserts, and it must remain byte-identical to today.
 *
 * The loud case (corrupted gitlink, bad GIT_DIR-in-cwd's-own-config, git binary missing, a
 * permissions error on .git, etc.) is #357's exact silent-fail-open bug: an actor's
 * liveness/ownership claim lands in an ISOLATED cwd-local store invisible to every other
 * worktree/checkout of the same repo, with no diagnostic at all. A warning (not a hard refuse —
 * this helper sits on read paths too, and a degraded read must still return something usable)
 * gives an operator the signal needed to pass `--artifact-root` explicitly instead of silently
 * losing coordination visibility.
 */
function warnIfFailingOpenInsideGitTree(cwd: string, fallbackPath: string): void {
  if (!isInsideGitWorkingTree(cwd)) return;
  process.stderr.write(
    `[artifact-root] WARNING: inside a git working tree but could not resolve the shared repo root ` +
      `(git rev-parse --git-common-dir failed or returned nothing from ${cwd}); falling back to a ` +
      `cwd-local store at ${fallbackPath} — coordination claims may be invisible to other ` +
      `worktrees/actors. Pass --artifact-root explicitly to fix.\n`
  );
}

/**
 * #413 iteration-2 Fix 2 (documentation only, no behavior change): when `cwd` is a
 * SUBDIRECTORY of a plain (non-worktree) checkout, `git rev-parse --git-common-dir` returns a
 * RELATIVE path (e.g. `../.git` or deeper) that `resolveSharedRepoRoot` walks up to the repo
 * root — so this intentionally resolves to `<repo-root>/.kontourai/flow-agents` regardless of
 * which subdirectory `cwd` is, NOT `<subdir>/.kontourai/flow-agents` (the old plain
 * `path.resolve(cwd, ...)` cwd-anchored behavior). This is the CORRECT shared-store semantics —
 * one store per repo, matching every other cwd (primary checkout, linked worktree) this
 * resolver already unifies — not a regression to guard against. See
 * evals/integration/test_liveness_worktree_root.sh's AC6b for the explicit assertion, and its
 * header docstring for why AC6's "byte-identical" guarantee is scoped to repo-root cwd and
 * non-git cwd only, never to an arbitrary subdirectory cwd.
 */
export function flowAgentsArtifactRoot(cwd = process.cwd()): string {
  const sharedRepoRoot = resolveSharedRepoRoot(cwd);
  if (sharedRepoRoot) return path.resolve(sharedRepoRoot, FLOW_AGENTS_RUNTIME_DIR);
  // Fail-open: not a git repo, git unavailable, or command failed — reproduce today's plain
  // cwd-based behavior unchanged (AC6 backward-compat guarantee). #413 iteration-2 Fix 1: loud,
  // not silent, when cwd IS inside a git working tree (see warnIfFailingOpenInsideGitTree).
  const fallback = path.resolve(cwd, FLOW_AGENTS_RUNTIME_DIR);
  warnIfFailingOpenInsideGitTree(cwd, fallback);
  return fallback;
}

export function durableFlowAgentsRoot(cwd = process.cwd()): string {
  return path.resolve(cwd, DURABLE_FLOW_AGENTS_DIR);
}

export function durableInstallRecordPath(cwd = process.cwd()): string {
  return path.join(durableFlowAgentsRoot(cwd), "install.json");
}

/** Path to the per-skill-file content-hash drift manifest, a sibling of `install.json` under the same durable root. */
export function skillsManifestPath(cwd = process.cwd()): string {
  return path.join(durableFlowAgentsRoot(cwd), "skills-manifest.json");
}

export function telemetryDataDir(cwd = process.cwd()): string {
  return path.resolve(cwd, KONTOURAI_DIR, "telemetry");
}

export function legacyTelemetryDataDir(cwd = process.cwd()): string {
  return path.resolve(cwd, LEGACY_TELEMETRY_DIR);
}

export function firstExistingPath(candidates: string[]): string {
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

export function defaultArtifactRootForRead(cwd = process.cwd()): string {
  return flowAgentsArtifactRoot(cwd);
}

export function defaultTelemetryDirForRead(cwd = process.cwd()): string {
  return firstExistingPath([telemetryDataDir(cwd), legacyTelemetryDataDir(cwd)]);
}

export function defaultTelemetryDirsForRead(cwd = process.cwd()): string[] {
  const dirs = [telemetryDataDir(cwd), legacyTelemetryDataDir(cwd)];
  return dirs.filter((dir, index) => dirs.indexOf(dir) === index && fs.existsSync(dir));
}
