'use strict';

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

class GitExecutableTrustError extends Error {}

const TRUSTED_GIT_EXECUTABLES = process.platform === "darwin"
  ? ["/usr/bin/git", "/run/current-system/sw/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"]
  : process.platform === "win32"
    ? ["C:\\Program Files\\Git\\cmd\\git.exe"]
    : ["/usr/bin/git", "/run/current-system/sw/bin/git", "/usr/local/bin/git"];

const TRUSTED_GIT_NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

/** A Git object format is fixed-width: SHA-1 is 40 lowercase hex and SHA-256 is 64. */
function isExactLowercaseCommitSha(value) {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);
}

/** Execute bounded Git argv with replacement objects and caller configuration disabled. */
function execTrustedGitSync(projectRoot, argv, encoding = "utf8", maxBuffer = 1024 * 1024, timeoutMs = 0) {
  const executable = resolveTrustedGitIdentity();
  revalidateTrustedGitIdentity(executable);
  const output = execFileSync(executable.path, trustedGitArgv(projectRoot, argv), {
    encoding: encoding === "buffer" ? "buffer" : "utf8",
    env: trustedGitEnvironment(),
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer,
    timeout: timeoutMs,
  });
  revalidateTrustedGitIdentity(executable);
  return output;
}

/** Read a bounded blob addressed by an already-resolved immutable commit. */
function readTrustedGitBlobSync(projectRoot, commit, relativePath, maxBytes = 1024 * 1024) {
  if (!isExactLowercaseCommitSha(commit) || !isSafeGitRelativePath(relativePath)) {
    throw new Error("unsafe immutable Git blob reference");
  }
  try {
    const output = execTrustedGitSync(projectRoot, ["cat-file", "blob", `${commit}:${relativePath}`], "buffer", maxBytes + 1);
    if (!Buffer.isBuffer(output) || output.length > maxBytes) throw new Error("immutable Git blob exceeds size limit");
    return output;
  } catch {
    throw new Error("could not read immutable Git blob with trusted Git");
  }
}

function isSafeGitRelativePath(value) {
  return value.length > 0
    && value.length <= 240
    && !value.startsWith("/")
    && !value.includes("\\")
    && value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".." && !part.includes("\0"));
}

/**
 * Repository config is untrusted input for every caller of this helper. Keep
 * executable configuration disabled even for read-only commands: fsmonitor is
 * consulted by status, diff drivers can launch external commands, and a future
 * caller must not gain hook execution merely by adding a mutating Git verb.
 */
function trustedGitArgv(projectRoot, argv) {
  const command = argv[0];
  if (command === "diff" && argv.some((argument) => argument === "--ext-diff" || argument === "--textconv")) {
    throw new Error("trusted Git refuses external diff and text conversion options");
  }
  const hardened = command === "diff" ? appendSafeDiffOptions(argv) : [...argv];
  return [
    "--no-replace-objects",
    "-c", "core.fsmonitor=false",
    "-c", `core.hooksPath=${TRUSTED_GIT_NULL_DEVICE}`,
    "-c", "diff.external=",
    "-C", projectRoot,
    ...hardened,
  ];
}

function appendSafeDiffOptions(argv) {
  return [argv[0], "--no-ext-diff", "--no-textconv", ...argv.slice(1)];
}

function resolveTrustedLocalGitCommit(projectRoot, ref) {
  try {
    const sha = String(execTrustedGitSync(projectRoot, ["rev-parse", "--verify", `${ref}^{commit}`])).trim().toLowerCase();
    if (!isExactLowercaseCommitSha(sha)) throw new Error("not an immutable commit");
    return sha;
  } catch (error) {
    const reason = error instanceof GitExecutableTrustError ? `: ${error.message}` : "";
    throw new Error(`could not resolve ref to an immutable local commit with trusted Git${reason}`);
  }
}

function assertTrustedGitAncestor(cwd, ancestor, descendant) {
  execTrustedGitSync(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
}

/**
 * Prove that a commit remains reachable after a squash merge without trusting
 * branch names or replacement objects. A direct ancestor is always accepted.
 * Otherwise, a reachable commit with the exact same Git tree is the narrow
 * squash bridge: the reviewed bytes survived under a new commit identity.
 */
function assertTrustedGitAncestorOrEquivalentTree(cwd, ancestor, descendant) {
  if (!isExactLowercaseCommitSha(ancestor) || !isExactLowercaseCommitSha(descendant)) throw new Error("invalid immutable Git commit");
  try {
    assertTrustedGitAncestor(cwd, ancestor, descendant);
    return;
  } catch { /* A squash merge deliberately breaks commit ancestry. */ }
  const tree = String(execTrustedGitSync(cwd, ["rev-parse", "--verify", `${ancestor}^{tree}`])).trim().toLowerCase();
  if (!isExactLowercaseCommitSha(tree)) throw new Error("could not resolve immutable Git tree");
  // A bounded traversal prevents a malformed fixture/repository from turning
  // validation into an unbounded history scan. The 1 MiB output cap is also
  // enforced by execTrustedGitSync.
  const reachableTrees = String(execTrustedGitSync(cwd, ["log", "--format=%T", "--max-count=10000", descendant]));
  if (reachableTrees.split(/\r?\n/u).some((candidate) => candidate === tree)) return;
  throw new Error("commit is neither an ancestor nor an equivalent-tree squash predecessor");
}

function trustedGitEnvironment() {
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

function resolveTrustedGitIdentity() {
  const failures = [];
  for (const candidate of TRUSTED_GIT_EXECUTABLES) {
    try { return trustedGitIdentity(candidate); } catch (error) {
      const code = error.code;
      const reason = error instanceof GitExecutableTrustError ? error.message
        : typeof code === "string" && /^[A-Z0-9_]{1,24}$/u.test(code) ? `filesystem inspection failed (${code})`
        : "executable inspection failed";
      failures.push(`${candidate}: ${reason}`);
    }
  }
  throw new GitExecutableTrustError(`trusted Git executable is unavailable (${failures.join("; ")})`);
}

function trustedGitIdentity(candidate) {
  const resolved = fs.realpathSync(candidate);
  const stat = fs.statSync(resolved);
  if (!path.isAbsolute(resolved) || !stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o111) === 0)) throw new GitExecutableTrustError("untrusted Git executable");
  assertSecureSystemPath(candidate, resolved);
  return Object.freeze({ candidate, path: resolved, device: stat.dev, inode: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, mode: stat.mode, uid: stat.uid, gid: stat.gid });
}

/**
 * Namespace stat ownership is lossy: unmapped host owners become overflowuid.
 * Trust fixed host-provisioned system paths, not a reconstructed host root UID.
 * A single caller mapping plus kernel write denial protects those paths from
 * caller replacement; signed lifecycle helper/key authority remains separate.
 */
function systemPathTrust() {
  if (process.platform !== "linux") return { owner: 0, namespace: false };
  const mapping = fs.readFileSync("/proc/self/uid_map", "utf8").trim();
  if (mapping === "" || mapping.length > 4096) throw new GitExecutableTrustError("unsupported Git executable UID mapping");
  const rows = mapping.split(/\n/u).map((line) => line.trim().split(/\s+/u));
  if (rows.length !== 1 || rows[0].length !== 3 || rows[0].some((value) => !/^(?:0|[1-9][0-9]*)$/u.test(value))) {
    throw new GitExecutableTrustError("unsupported Git executable UID mapping");
  }
  const [inside, outside, count] = rows[0].map(Number) ;
  if (![inside, outside, count].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff)) {
    throw new GitExecutableTrustError("unsupported Git executable UID mapping");
  }
  if (inside === 0 && outside === 0 && count === 0xffffffff) return { owner: 0, namespace: false };
  const uid = process.getuid();
  if (count !== 1 || inside !== uid || outside === 0xffffffff
    || process.geteuid() !== uid || process.getgid() !== process.getegid()) {
    throw new GitExecutableTrustError("unsupported Git executable caller mapping");
  }
  const overflowText = fs.readFileSync("/proc/sys/kernel/overflowuid", "utf8").trim();
  if (!/^(?:0|[1-9][0-9]*)$/u.test(overflowText)) throw new GitExecutableTrustError("invalid Git executable overflow UID");
  const overflow = Number(overflowText);
  if (!Number.isSafeInteger(overflow) || overflow < 0 || overflow >= 0xffffffff || overflow === uid) {
    throw new GitExecutableTrustError("Git executable overflow UID is mapped to the caller");
  }
  return { owner: overflow, namespace: true };
}

function assertSecureSystemPath(candidate, resolved) {
  if (process.platform === "win32") return;
  const trust = systemPathTrust();
  const inspected = new Set();
  let symlinks = 0;
  const inspect = (absolutePath) => {
    let cursor = path.parse(absolutePath).root;
    for (const part of ["", ...absolutePath.slice(cursor.length).split(path.sep).filter(Boolean)]) {
      cursor = path.join(cursor, part);
      if (inspected.has(cursor)) continue;
      inspected.add(cursor);
      const stat = fs.lstatSync(cursor);
      if (stat.uid !== trust.owner || (!stat.isSymbolicLink() && (stat.mode & 0o022) !== 0)) {
        throw new GitExecutableTrustError("untrusted Git executable path ownership or permissions");
      }
      if (stat.isSymbolicLink()) {
        if (++symlinks > 40) throw new GitExecutableTrustError("untrusted Git executable symlink route");
        inspect(path.resolve(path.dirname(cursor), fs.readlinkSync(cursor)));
      } else {
        if (!stat.isDirectory() && !stat.isFile()) throw new GitExecutableTrustError("untrusted Git executable path type");
        if (trust.namespace) assertCallerCannotWrite(cursor);
      }
    }
  };
  inspect(candidate);
  inspect(resolved);
}

function assertCallerCannotWrite(file) {
  try {
    fs.accessSync(file, fs.constants.W_OK);
  } catch (error) {
    const code = error.code;
    if (code === "EACCES" || code === "EROFS" || code === "EPERM") return;
    throw error;
  }
  throw new GitExecutableTrustError("Git executable system path is writable by the caller");
}

function revalidateTrustedGitIdentity(identity) {
  const current = trustedGitIdentity(identity.candidate);
  if (current.path !== identity.path || current.device !== identity.device || current.inode !== identity.inode || current.size !== identity.size || current.mtimeMs !== identity.mtimeMs || current.ctimeMs !== identity.ctimeMs || current.mode !== identity.mode || current.uid !== identity.uid || current.gid !== identity.gid) {
    throw new GitExecutableTrustError("trusted Git executable changed during operation");
  }
}

module.exports = { execTrustedGitSync, isExactLowercaseCommitSha, readTrustedGitBlobSync, resolveTrustedLocalGitCommit, assertTrustedGitAncestor, assertTrustedGitAncestorOrEquivalentTree };
