import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

export type ExternalLifecycleAuthorityRequest = Readonly<Record<string, unknown> & { action: string; project_root: string }>;

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function trustedHelper(projectRoot: string): string {
  const configured = process.env.FLOW_AGENTS_LIFECYCLE_AUTHORITY_HELPER;
  if (!configured || !path.isAbsolute(configured)) throw new Error("lifecycle authority requires an absolute externally provisioned helper path");
  const helper = path.resolve(configured);
  const canonicalProject = fs.realpathSync(projectRoot);
  if (isWithin(helper, canonicalProject)) throw new Error("lifecycle authority helper must be outside the project, package, and worktree");
  if (process.platform === "win32") throw new Error("secure lifecycle authority helper ownership is unavailable without a platform adapter");
  let cursor = path.parse(helper).root;
  for (const component of helper.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error("lifecycle authority helper path must not contain symlinks");
    if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw new Error("lifecycle authority helper and every parent must be OS-owned and non-writable by group or world");
    try { fs.accessSync(cursor, fs.constants.W_OK); throw new Error("lifecycle authority helper path must not be writable by the runtime user"); }
    catch (error) { if (error instanceof Error && error.message.includes("must not be writable")) throw error; }
  }
  const descriptor = fs.openSync(helper, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o111) === 0 || stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw new Error("lifecycle authority helper must be an OS-owned, protected executable regular file");
  } finally { fs.closeSync(descriptor); }
  if (typeof process.getuid === "function" && process.getuid() === 0) throw new Error("lifecycle authority helper is unavailable to a root caller without a platform privilege adapter");
  return helper;
}

/**
 * Submit-only boundary. The helper owns authorization, locking, replay/CAS, and
 * every persistent write. Callers must never mutate based on this return value.
 */
export function invokeExternalLifecycleAuthority(request: ExternalLifecycleAuthorityRequest): unknown {
  const helper = trustedHelper(request.project_root);
  try {
    const output = execFileSync(helper, [], {
      input: `${JSON.stringify(request)}\n`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, timeout: 30_000, maxBuffer: 256 * 1024,
    });
    return output.trim() ? JSON.parse(output) : null;
  } catch (error) {
    const stderr = typeof (error as { stderr?: unknown })?.stderr === "string" ? (error as { stderr: string }).stderr.trim() : "";
    throw new Error(stderr || "external lifecycle authority rejected the request");
  }
}
