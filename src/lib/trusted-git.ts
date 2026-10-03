import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** The synchronous primitive is shared with installed CommonJS hooks on Node 22. */
interface TrustedGit {
  execTrustedGitSync(projectRoot: string, argv: readonly string[], encoding?: "utf8" | "buffer", maxBuffer?: number, timeoutMs?: number): string | Buffer;
  isExactLowercaseCommitSha(value: unknown): boolean;
  readTrustedGitBlobSync(projectRoot: string, commit: string, relativePath: string, maxBytes?: number): Buffer;
  resolveTrustedLocalGitCommit(projectRoot: string, ref: string): string;
  assertTrustedGitAncestor(cwd: string, ancestor: string, descendant: string): void;
  assertTrustedGitAncestorOrEquivalentTree(cwd: string, ancestor: string, descendant: string): void;
}

const require = createRequire(import.meta.url);
const git: TrustedGit = require(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/hooks/lib/trusted-git.js"));

export function execTrustedGitSync(projectRoot: string, argv: readonly string[], encoding: "utf8" | "buffer" = "utf8", maxBuffer = 1024 * 1024, timeoutMs = 0): string | Buffer {
  return git.execTrustedGitSync(projectRoot, argv, encoding, maxBuffer, timeoutMs);
}

export function isExactLowercaseCommitSha(value: unknown): value is string {
  return git.isExactLowercaseCommitSha(value);
}

export function readTrustedGitBlobSync(projectRoot: string, commit: string, relativePath: string, maxBytes = 1024 * 1024): Buffer {
  return git.readTrustedGitBlobSync(projectRoot, commit, relativePath, maxBytes);
}

export function resolveTrustedLocalGitCommit(projectRoot: string, ref: string): string {
  return git.resolveTrustedLocalGitCommit(projectRoot, ref);
}

export function assertTrustedGitAncestor(cwd: string, ancestor: string, descendant: string): void {
  git.assertTrustedGitAncestor(cwd, ancestor, descendant);
}

export function assertTrustedGitAncestorOrEquivalentTree(cwd: string, ancestor: string, descendant: string): void {
  git.assertTrustedGitAncestorOrEquivalentTree(cwd, ancestor, descendant);
}
