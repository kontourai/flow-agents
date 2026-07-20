import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type ExecutableIdentity = Readonly<{ candidate: string; path: string; device: number; inode: number; size: number; mtimeMs: number; mode: number }>;

const TRUSTED_GIT_EXECUTABLES = process.platform === "darwin"
  ? ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git", "/run/current-system/sw/bin/git"]
  : process.platform === "win32"
    ? ["C:\\Program Files\\Git\\cmd\\git.exe"]
    : ["/usr/bin/git", "/usr/local/bin/git", "/run/current-system/sw/bin/git"];

/** Resolve a local ref without consulting caller-controlled PATH. */
export function resolveTrustedLocalGitCommit(projectRoot: string, ref: string): string {
  try {
    const sha = String(execTrustedGitSync(projectRoot, ["rev-parse", "--verify", `${ref}^{commit}`], "utf8")).trim().toLowerCase();
    if (!/^[0-9a-f]{40,64}$/u.test(sha)) throw new Error("not an immutable commit SHA");
    return sha;
  } catch {
    throw new Error("could not resolve ref to an immutable local commit with trusted Git");
  }
}

/** Execute bounded Git argv through a fixed system binary with identity checks. */
export function execTrustedGitSync(projectRoot: string, argv: readonly string[], encoding: "utf8" | "buffer"): string | Buffer {
  const executable = resolveTrustedGitIdentity();
  revalidateTrustedGitIdentity(executable);
  const output = execFileSync(executable.path, ["-C", projectRoot, ...argv], {
    encoding: encoding === "buffer" ? "buffer" : "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: trustedGitEnvironment(),
  });
  revalidateTrustedGitIdentity(executable);
  return output;
}

function resolveTrustedGitIdentity(): ExecutableIdentity {
  for (const candidate of TRUSTED_GIT_EXECUTABLES) {
    try { return trustedGitIdentity(candidate); } catch { /* try next fixed system location */ }
  }
  throw new Error("trusted Git executable is unavailable");
}

function trustedGitIdentity(candidate: string): ExecutableIdentity {
  const resolved = fs.realpathSync(candidate);
  if (!path.isAbsolute(resolved) || !TRUSTED_GIT_EXECUTABLES.includes(candidate)) throw new Error("untrusted Git executable");
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o111) === 0)) throw new Error("untrusted Git executable");
  assertTrustedPathAncestors(candidate, resolved);
  return Object.freeze({ candidate, path: resolved, device: stat.dev, inode: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode });
}

/**
 * Git accepts repository/config routing through many GIT_* variables.  Local
 * commit binding must never inherit those caller-controlled overrides.
 */
export function trustedGitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: os.homedir(),
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  };
  return Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === "string"));
}

function assertTrustedPathAncestors(candidate: string, resolved: string): void {
  if (process.platform === "win32") return;
  for (const start of [path.dirname(candidate), path.dirname(resolved)]) {
    for (let cursor = start;; cursor = path.dirname(cursor)) {
      const stat = fs.statSync(cursor);
      if (!stat.isDirectory() || (stat.mode & 0o022) !== 0 || !trustedOwner(stat.uid)) {
        throw new Error("untrusted Git executable path ownership or permissions");
      }
      if (path.dirname(cursor) === cursor) break;
    }
  }
}

function trustedOwner(uid: number): boolean {
  return uid === 0 || (typeof process.getuid !== "function" ? false : uid === process.getuid());
}

function revalidateTrustedGitIdentity(identity: ExecutableIdentity): void {
  const current = trustedGitIdentity(identity.candidate);
  if (current.device !== identity.device || current.inode !== identity.inode || current.size !== identity.size || current.mtimeMs !== identity.mtimeMs || current.mode !== identity.mode) {
    throw new Error("trusted Git executable changed during operation");
  }
}
