import * as fs from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { execTrustedGitSync, isExactLowercaseCommitSha } from "./trusted-git.js";

type ReviewedFile = { file: string; sha256: string };

/**
 * A snapshot is an authorization input, so Git and filesystem reads must have
 * finite resource costs.  These limits allow ordinary source worktrees while
 * refusing inputs that cannot be represented as one bounded observation.
 */
export const MAX_TRACKED_DIFF_BYTES = 16 * 1024 * 1024;
export const MAX_UNTRACKED_LIST_BYTES = 4 * 1024 * 1024;
export const MAX_TRACKED_INDEX_BYTES = 4 * 1024 * 1024;
export const MAX_UNTRACKED_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_UNTRACKED_TOTAL_BYTES = 64 * 1024 * 1024;
const HASH_READ_CHUNK_BYTES = 64 * 1024;

type WorkspaceSnapshotTestHooks = {
  afterInitialInputsRead?: () => void;
};

let workspaceSnapshotTestHooks: WorkspaceSnapshotTestHooks | null = null;

/** Test-only seam for deterministic mutations between the two snapshot reads. */
export function setWorkspaceSnapshotTestHooksForTest(hooks: WorkspaceSnapshotTestHooks | null): void {
  workspaceSnapshotTestHooks = hooks;
}

export type GitWorktreeSnapshot = {
  version: 1;
  kind: "git-worktree";
  algorithm: "sha256";
  digest: string;
  head_sha: string;
  /**
   * Derived from the same tracked diff and untracked-file enumeration hashed
   * into `digest`; this must never be computed by a separate Git query.
   */
  worktree_clean: boolean;
};

export function isGitWorktreeSnapshot(value: Record<string, unknown>): value is GitWorktreeSnapshot {
  return value.kind === "git-worktree"
    && typeof value.head_sha === "string"
    && typeof value.worktree_clean === "boolean";
}

export function captureReviewWorkspaceSnapshot(projectRoot: string, reviewedFiles: ReviewedFile[], excludedRoots: string[] = []): Record<string, unknown> {
  return gitWorktreeSnapshot(projectRoot, excludedRoots) ?? reviewedFilesSnapshot(projectRoot, reviewedFiles);
}

function gitWorktreeSnapshot(projectRoot: string, excludedRoots: string[]): GitWorktreeSnapshot | null {
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
    const headSha = readHeadSha(root);
    assertOrdinaryTrackedIndex(root);
    const pathspecs = exclusions.length === 0 ? [] : [".", ...exclusions.map((entry) => `:(exclude)${entry}/**`)];
    const trackedDiff = readBoundedGitBuffer(root, ["diff", "--binary", "HEAD", "--", ...pathspecs], MAX_TRACKED_DIFF_BYTES, "tracked diff");
    const untrackedBytes = readBoundedGitBuffer(root, ["ls-files", "--others", "--exclude-standard", "-z"], MAX_UNTRACKED_LIST_BYTES, "untracked-file list");
    const untracked = untrackedBytes.toString("utf8").split("\0").filter(Boolean)
      .filter((file) => !exclusions.some((entry) => file === entry || file.startsWith(`${entry}/`)))
      .sort();
    const hash = createHash("sha256");
    hash.update("flow-agents:git-worktree:v1\0").update(headSha).update("\0");
    for (const exclusion of exclusions) hash.update("exclude\0").update(exclusion).update("\0");
    hash.update(trackedDiff).update("\0");
    let untrackedTotalBytes = 0;
    for (const file of untracked) {
      const absolute = path.resolve(root, file);
      if (!pathIsWithin(absolute, root)) throw new Error("untracked file escapes repository root");
      untrackedTotalBytes = hashUntrackedFile(hash, file, absolute, untrackedTotalBytes);
    }
    workspaceSnapshotTestHooks?.afterInitialInputsRead?.();
    const settledTrackedDiff = readBoundedGitBuffer(root, ["diff", "--binary", "HEAD", "--", ...pathspecs], MAX_TRACKED_DIFF_BYTES, "settled tracked diff");
    const settledUntrackedBytes = readBoundedGitBuffer(root, ["ls-files", "--others", "--exclude-standard", "-z"], MAX_UNTRACKED_LIST_BYTES, "settled untracked-file list");
    if (!settledTrackedDiff.equals(trackedDiff) || !settledUntrackedBytes.equals(untrackedBytes)) {
      throw new Error("Git workspace inputs changed while collecting the workspace snapshot");
    }
    // An index flag can hide bytes from diff output. Check again after all
    // content reads and settle checks so the snapshot cannot confirm across
    // a transition to a nonordinary index state.
    assertOrdinaryTrackedIndex(root);
    if (readHeadSha(root) !== headSha) throw new Error("Git HEAD changed while collecting the workspace snapshot");
    return {
      version: 1,
      kind: "git-worktree",
      algorithm: "sha256",
      digest: hash.digest("hex"),
      head_sha: headSha,
      worktree_clean: trackedDiff.length === 0 && untracked.length === 0,
    };
  } catch (error) {
    throw new Error(`could not inspect the Git worktree: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readHeadSha(root: string): string {
  const headSha = readBoundedGitBuffer(root, ["rev-parse", "--verify", "HEAD^{commit}"], 256, "HEAD")
    .toString("utf8").trim().toLowerCase();
  if (!isExactLowercaseCommitSha(headSha)) throw new Error("Git HEAD is not an immutable commit");
  return headSha;
}

function readBoundedGitBuffer(root: string, argv: readonly string[], maxBytes: number, label: string): Buffer {
  const output = execTrustedGitSync(root, argv, "buffer", maxBytes + 1);
  if (!Buffer.isBuffer(output) || output.length > maxBytes) throw new Error(`${label} exceeds the workspace snapshot limit`);
  return output;
}

function assertOrdinaryTrackedIndex(root: string): void {
  const entries = readBoundedGitBuffer(root, ["ls-files", "-v", "-z"], MAX_TRACKED_INDEX_BYTES, "tracked-index list")
    .toString("utf8").split("\0").filter(Boolean);
  for (const entry of entries) {
    // `H` is Git's ordinary cached-entry tag. Lowercase tags identify
    // assume-unchanged entries and `S` identifies skip-worktree; every other
    // tag is rejected rather than risking a diff that omits tracked bytes.
    if (!entry.startsWith("H ")) throw new Error("tracked index contains a nonordinary ls-files tag");
  }
}

function hashUntrackedFile(hash: ReturnType<typeof createHash>, file: string, absolute: string, totalBytes: number): number {
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | noFollow);
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()) throw new Error("untracked entry is not a regular file");
    if (before.size > MAX_UNTRACKED_FILE_BYTES) throw new Error("untracked file exceeds the workspace snapshot per-file limit");
    if (totalBytes + before.size > MAX_UNTRACKED_TOTAL_BYTES) throw new Error("untracked files exceed the workspace snapshot total limit");
    hash.update(file).update("\0");
    const buffer = Buffer.allocUnsafe(HASH_READ_CHUNK_BYTES);
    let remaining = before.size;
    let position = 0;
    while (remaining > 0) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, remaining), position);
      if (bytesRead <= 0) throw new Error("untracked file changed while collecting the workspace snapshot");
      hash.update(buffer.subarray(0, bytesRead));
      remaining -= bytesRead;
      position += bytesRead;
    }
    const after = fs.fstatSync(descriptor);
    if (!sameFileIdentity(before, after)) throw new Error("untracked file changed while collecting the workspace snapshot");
    hash.update("\0");
    return totalBytes + before.size;
  } finally {
    fs.closeSync(descriptor);
  }
}

function sameFileIdentity(before: fs.Stats, after: fs.Stats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
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
