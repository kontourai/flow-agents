import * as fs from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { execTrustedGitSync } from "./trusted-git.js";

type ReviewedFile = { file: string; sha256: string };
export type ReviewWorkspaceSnapshot = Record<string, unknown>;

export function captureReviewWorkspaceSnapshot(projectRoot: string, reviewedFiles: ReviewedFile[], excludedRoots: string[] = []): ReviewWorkspaceSnapshot {
  return gitWorktreeSnapshot(projectRoot, excludedRoots) ?? reviewedFilesSnapshot(projectRoot, reviewedFiles);
}

/**
 * A passing gate can only be reused when its recorded workspace authority is
 * structurally valid and exactly matches a fresh trusted capture. The fallback
 * reviewed-files form is retained for genuine non-Git projects; Git roots are
 * always captured through the trusted Git path above.
 */
export function workspaceSnapshotMatches(projectRoot: string, snapshot: unknown): boolean {
  if (!isReviewWorkspaceSnapshot(snapshot)) return false;
  try {
    const reviewedFiles = snapshot.kind === "reviewed-files"
      ? snapshot.files as ReviewedFile[]
      : [];
    return isDeepStrictEqual(snapshot, captureReviewWorkspaceSnapshot(projectRoot, reviewedFiles));
  } catch {
    return false;
  }
}

export function isReviewWorkspaceSnapshot(snapshot: unknown): snapshot is ReviewWorkspaceSnapshot & { kind: "git-worktree" | "reviewed-files"; files?: ReviewedFile[] } {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
  const value = snapshot as Record<string, unknown>;
  if (value.version !== 1 || value.algorithm !== "sha256" || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/i.test(value.digest)) return false;
  if (value.kind === "git-worktree") return typeof value.head_sha === "string" && /^[a-f0-9]{40,64}$/i.test(value.head_sha);
  // Execute scope supplies no reviewed artifacts to the fallback strategy. A
  // genuine non-Git project therefore has an explicitly empty, still
  // canonical snapshot; Git worktrees never take this branch.
  if (value.kind !== "reviewed-files" || !Array.isArray(value.files)) return false;
  const files = value.files as unknown[];
  return files.every((file) => file && typeof file === "object" && !Array.isArray(file)
    && typeof (file as Record<string, unknown>).file === "string"
    && typeof (file as Record<string, unknown>).sha256 === "string"
    && /^[a-f0-9]{64}$/i.test(String((file as Record<string, unknown>).sha256)))
    && new Set(files.map((file) => String((file as Record<string, unknown>).file))).size === files.length;
}

function gitWorktreeSnapshot(projectRoot: string, excludedRoots: string[]): Record<string, unknown> | null {
  const root = fs.realpathSync(projectRoot);
  const hasGitMarker = fs.existsSync(path.join(root, ".git"));
  let gitRoot: string;
  try {
    gitRoot = String(execTrustedGitSync(root, ["rev-parse", "--show-toplevel"])).trim();
  } catch (error) {
    if (!hasGitMarker) return null;
    throw new Error(`could not inspect the Git worktree: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    if (!gitRoot || fs.realpathSync(gitRoot) !== root) throw new Error("canonical project root must match the Git worktree root");
    const exclusions = excludedRoots.map((entry) => normalizeExcludedRoot(entry)).sort();
    const headSha = String(execTrustedGitSync(root, ["rev-parse", "HEAD"])).trim();
    const pathspecs = exclusions.length === 0 ? [] : [".", ...exclusions.map((entry) => `:(exclude)${entry}/**`)];
    const trackedDiff = execTrustedGitSync(root, ["diff", "--binary", "--no-ext-diff", "HEAD", "--", ...pathspecs], "buffer") as Buffer;
    const untracked = (execTrustedGitSync(root, ["ls-files", "--others", "--exclude-standard", "-z"], "buffer") as Buffer)
      .toString("utf8").split("\0").filter(Boolean)
      .filter((file) => !exclusions.some((entry) => file === entry || file.startsWith(`${entry}/`)))
      .sort();
    const hash = createHash("sha256");
    hash.update("flow-agents:git-worktree:v1\0").update(headSha).update("\0");
    for (const exclusion of exclusions) hash.update("exclude\0").update(exclusion).update("\0");
    hash.update(trackedDiff).update("\0");
    for (const file of untracked) {
      const absolute = path.resolve(root, file);
      if (!pathIsWithin(absolute, root)) throw new Error("untracked file escapes repository root");
      const stat = fs.lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("untracked entry is not a regular file");
      hash.update(file).update("\0").update(fs.readFileSync(absolute)).update("\0");
    }
    return { version: 1, kind: "git-worktree", algorithm: "sha256", digest: hash.digest("hex"), head_sha: headSha };
  } catch (error) {
    throw new Error(`could not inspect the Git worktree: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeExcludedRoot(entry: string): string {
  const normalized = entry.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error("workspace snapshot excluded root must remain within the repository");
  }
  return normalized;
}

function reviewedFilesSnapshot(projectRoot: string, reviewedFiles: ReviewedFile[]): Record<string, unknown> {
  const files = reviewedFiles.map((file) => ({ ...file }));
  const hash = createHash("sha256");
  hash.update("flow-agents:reviewed-files:v1\0");
  for (const artifact of files) {
    const absolute = safeReviewedArtifactPath(projectRoot, artifact.file);
    hash.update(artifact.file).update("\0").update(fs.readFileSync(absolute)).update("\0");
  }
  return { version: 1, kind: "reviewed-files", algorithm: "sha256", digest: hash.digest("hex"), files };
}

function safeReviewedArtifactPath(projectRoot: string, file: string): string {
  const canonicalRoot = fs.realpathSync(projectRoot);
  const candidate = path.resolve(canonicalRoot, file);
  if (!pathIsWithin(candidate, canonicalRoot)) throw new Error("reviewed artifact escapes the canonical project root");
  const canonicalArtifact = fs.realpathSync(candidate);
  if (!pathIsWithin(canonicalArtifact, canonicalRoot) || !fs.statSync(canonicalArtifact).isFile()) throw new Error("reviewed artifact is not a regular file within the canonical project root");
  return canonicalArtifact;
}

function pathIsWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
