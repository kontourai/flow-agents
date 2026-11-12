/**
 * Which sessions belong to "this repository", and whether the learn loop may write its files here.
 *
 * A session belongs to the repository when the working directory its transcript records is inside that repository:
 *   - for a directory that still exists, Git decides: it belongs when `git rev-parse --git-common-dir` there is this
 *     repository's common directory. Subdirectories and every linked worktree of the same repository match, and a
 *     different repository nested under this one's path does not.
 *   - for a directory that no longer exists (a removed worktree, a deleted checkout), only its path can be read: it
 *     belongs when it is this repository's main worktree or a worktree Git still lists, or a directory below one.
 *     A session from a worktree that has since been removed AND lived outside those paths cannot be attributed and
 *     is not counted.
 *
 * The dream run's `projectFromCwd` names a project by its directory's basename, which two repositories can share,
 * so it is not reused here.
 *
 * @module learn/scope
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { scrubResidueText } from "../promote/runtime-redaction.js";
import { learnError } from "./model.js";

function git(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

const real = (dir) => {
  try {
    return fs.realpathSync(dir);
  } catch {
    return null;
  }
};

const within = (child, parent) => child === parent || child.startsWith(`${parent}${path.sep}`);

/** The repository containing `cwd`, or null when `cwd` is not inside a Git work tree. */
export function repoScope(cwd) {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!top || !common) return null;
  const commonDir = real(common) ?? common;
  const worktrees = (git(cwd, ["worktree", "list", "--porcelain"]) ?? "")
    .split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length))
    .map((dir) => real(dir) ?? dir);
  const roots = [...new Set([real(top) ?? top, ...worktrees])];
  const cache = new Map();
  const matches = (sessionCwd) => {
    if (typeof sessionCwd !== "string" || !path.isAbsolute(sessionCwd)) return false;
    if (cache.has(sessionCwd)) return cache.get(sessionCwd);
    const resolved = real(sessionCwd);
    let result;
    if (resolved) {
      const theirs = git(resolved, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
      result = theirs !== null && (real(theirs) ?? theirs) === commonDir;
    } else {
      const normalized = path.resolve(sessionCwd);
      result = roots.some((root) => within(normalized, root));
    }
    cache.set(sessionCwd, result);
    return result;
  };
  // The repository's identity in the ledger: its main worktree path (the common dir's parent for a `.git` common
  // dir, else the common dir itself), scrubbed (home directory -> ~). Every worktree of the repository shares it.
  const mainRoot = path.basename(commonDir) === ".git" ? path.dirname(commonDir) : commonDir;
  // `ledgerRoot` is where the default ledger lives: the main checkout, shared by every worktree, so a proposal is
  // raised once per repository and removing a worktree never removes decisions. A repository whose common directory
  // is not a `.git` inside a checkout (a bare repository with worktrees) has no main checkout; its ledger stays in
  // the worktree the command runs in.
  const ledgerRoot = path.basename(commonDir) === ".git" ? mainRoot : real(top) ?? top;
  return { kind: "repo", root: real(top) ?? top, ledgerRoot, repo: scrubResidueText(mainRoot), matches };
}

/** The scope a ledger entry records, and the key effect measurement and theme history compare. */
export const scopeRecord = (scope) => (scope.kind === "repo" ? { kind: "repo", repo: scope.repo } : { kind: "all-projects" });
/**
 * `all` for an all-projects proposal, `r<8 hex>` (a hash of the repository identity) for a repository's. Part of
 * every proposal id, so one ledger can hold proposals of several scopes without one scope's id answering for another.
 */
export function scopeTag(scope) {
  return scope?.kind === "repo" ? `r${createHash("sha256").update(String(scope.repo)).digest("hex").slice(0, 8)}` : "all";
}

/** `repo:<path>` or `all-projects`; null for anything else, including a repo scope without a non-empty string `repo`. */
export const scopeKey = (record) => (record?.kind === "repo" && typeof record.repo === "string" && record.repo !== "" ? `repo:${record.repo}` : record?.kind === "all-projects" ? "all-projects" : null);

/**
 * Refuse to write `file` where Git would track it. A path outside any work tree is fine; a path inside one must be
 * ignored and not already tracked (`check-ignore` consults the index, so a committed ledger is refused too). This
 * repository's .gitignore ignores `.kontourai/`.
 */
export function assertUntracked(file) {
  let dir = path.dirname(path.resolve(file));
  while (!fs.existsSync(dir)) dir = path.dirname(dir);
  if (git(dir, ["rev-parse", "--is-inside-work-tree"]) !== "true") return;
  try {
    execFileSync("git", ["-C", dir, "check-ignore", "-q", path.resolve(file)], { stdio: "ignore" });
  } catch (error) {
    if (error?.status === 1) {
      throw learnError("LEARN_LEDGER_TRACKED", `${file} is inside a Git work tree and not ignored, so transcript excerpts would be committable; add .kontourai/ to .gitignore or pass --ledger outside the repository`);
    }
    throw learnError("LEARN_CONFIG_INVALID", `could not ask Git whether ${file} is ignored`);
  }
}
