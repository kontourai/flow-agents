import * as fs from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { execTrustedGitSync } from "./trusted-git.js";

type ReviewedFile = { file: string; sha256: string };

export function captureReviewWorkspaceSnapshot(projectRoot: string, reviewedFiles: ReviewedFile[], excludedRoots: string[] = []): Record<string, unknown> {
  return gitWorktreeSnapshot(projectRoot, excludedRoots) ?? reviewedFilesSnapshot(projectRoot, reviewedFiles);
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
