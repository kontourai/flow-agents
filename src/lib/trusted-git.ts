import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

type ExecutableIdentity = Readonly<{ candidate: string; path: string; device: number; inode: number; size: number; mtimeMs: number; mode: number }>;

const TRUSTED_GIT_EXECUTABLES = process.platform === "darwin"
  ? ["/usr/bin/git", "/run/current-system/sw/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"]
  : process.platform === "win32"
    ? ["C:\\Program Files\\Git\\cmd\\git.exe"]
    : ["/usr/bin/git", "/run/current-system/sw/bin/git", "/usr/local/bin/git"];

/** Execute bounded Git argv with replacement objects and caller configuration disabled. */
export function execTrustedGitSync(projectRoot: string, argv: readonly string[], encoding: "utf8" | "buffer" = "utf8"): string | Buffer {
  const executable = resolveTrustedGitIdentity();
  revalidateTrustedGitIdentity(executable);
  const output = execFileSync(executable.path, ["--no-replace-objects", "-C", projectRoot, ...argv], {
    encoding: encoding === "buffer" ? "buffer" : "utf8",
    env: trustedGitEnvironment(),
    stdio: ["ignore", "pipe", "ignore"],
  });
  revalidateTrustedGitIdentity(executable);
  return output;
}

export function resolveTrustedLocalGitCommit(projectRoot: string, ref: string): string {
  try {
    const sha = String(execTrustedGitSync(projectRoot, ["rev-parse", "--verify", `${ref}^{commit}`])).trim().toLowerCase();
    if (!/^[0-9a-f]{40,64}$/u.test(sha)) throw new Error("not an immutable commit");
    return sha;
  } catch { throw new Error("could not resolve ref to an immutable local commit with trusted Git"); }
}

export function assertTrustedGitAncestor(cwd: string, ancestor: string, descendant: string): void {
  execTrustedGitSync(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
}

function trustedGitEnvironment(): NodeJS.ProcessEnv {
  return {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    LANG: "C",
    LC_ALL: "C",
    PATH: process.platform === "win32"
      ? "C:\\Program Files\\Git\\cmd;C:\\Windows\\System32;C:\\Windows"
      : "/run/current-system/sw/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    ...(process.platform === "win32" ? { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" } : {}),
  };
}

function resolveTrustedGitIdentity(): ExecutableIdentity {
  for (const candidate of TRUSTED_GIT_EXECUTABLES) {
    try { return trustedGitIdentity(candidate); } catch { /* try next fixed system path */ }
  }
  throw new Error("trusted Git executable is unavailable");
}

function trustedGitIdentity(candidate: string): ExecutableIdentity {
  const resolved = fs.realpathSync(candidate);
  const stat = fs.statSync(resolved);
  if (!path.isAbsolute(resolved) || !stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o111) === 0)) throw new Error("untrusted Git executable");
  assertSecureSystemPath(resolved, stat);
  return Object.freeze({ candidate, path: resolved, device: stat.dev, inode: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode });
}

function assertSecureSystemPath(resolved: string, stat: fs.Stats): void {
  if (process.platform === "win32") return;
  if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw new Error("untrusted Git executable ownership");
  let cursor = path.dirname(resolved);
  while (true) {
    const parentStat = fs.statSync(cursor);
    if (!parentStat.isDirectory() || parentStat.uid !== 0 || (parentStat.mode & 0o022) !== 0) throw new Error("untrusted Git executable parent");
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

function revalidateTrustedGitIdentity(identity: ExecutableIdentity): void {
  const current = trustedGitIdentity(identity.candidate);
  if (current.device !== identity.device || current.inode !== identity.inode || current.size !== identity.size || current.mtimeMs !== identity.mtimeMs || current.mode !== identity.mode) {
    throw new Error("trusted Git executable changed during operation");
  }
}
