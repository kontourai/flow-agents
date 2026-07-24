import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

export const FLOW_RUN_RECOVERY_FENCE_FILE = "recovery-fence.json";
export const FLOW_RUN_RECOVERY_FENCE_PROTOCOL = "flow.run-recovery-fence.v1";

type Fence = {
  protocol: typeof FLOW_RUN_RECOVERY_FENCE_PROTOCOL;
  run_id: string;
  recovery_id: string;
  status: "active" | "open";
  updated_at: string;
  generation: string;
};

type Snapshot = { status: "open"; fingerprint: string; generation: string; directory: string; fence?: Fence };

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function directoryIdentity(projectRoot: string, directory: string): string {
  const fixedParents = [
    path.join(projectRoot, ".kontourai"),
    path.join(projectRoot, ".kontourai", "flow"),
    path.join(projectRoot, ".kontourai", "flow", "runs"),
    directory,
  ];
  let missing = false;
  for (const fixed of fixedParents) {
    try {
      const stat = fs.lstatSync(fixed);
      if (missing || stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Flow recovery fence ancestry is unsafe");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        missing = true;
        continue;
      }
      throw error;
    }
  }
  try {
    const stat = fs.lstatSync(directory);
    return `${stat.dev}:${stat.ino}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}

function readFenceSnapshot(projectRoot: string, runId: string): Snapshot {
  if (!runId || runId.includes("/") || runId.includes("\\")) throw new Error("Flow recovery fence run id is invalid");
  const resolvedProjectRoot = path.resolve(projectRoot);
  const runRoot = path.join(resolvedProjectRoot, ".kontourai", "flow", "runs", runId);
  const beforeDirectory = directoryIdentity(resolvedProjectRoot, runRoot);
  const file = path.join(runRoot, FLOW_RUN_RECOVERY_FENCE_FILE);
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (directoryIdentity(resolvedProjectRoot, runRoot) !== beforeDirectory) throw new Error("Flow run directory changed during recovery fence read");
      return { status: "open", fingerprint: "absent", generation: "absent", directory: beforeDirectory };
    }
    throw new Error("Flow recovery fence could not be opened safely");
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o022) !== 0 || stat.size === 0 || stat.size > 64 * 1024) throw new Error("Flow recovery fence is malformed");
    const bytes = fs.readFileSync(descriptor);
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Flow recovery fence is malformed"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Flow recovery fence is malformed");
    const fence = parsed as Record<string, unknown>;
    if (!exactKeys(fence, ["protocol", "run_id", "recovery_id", "status", "updated_at", "generation"])
        || fence.protocol !== FLOW_RUN_RECOVERY_FENCE_PROTOCOL
        || fence.run_id !== runId
        || !/^[a-f0-9]{64}$/.test(String(fence.recovery_id))
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(fence.generation))
        || !["active", "open"].includes(String(fence.status))
        || typeof fence.updated_at !== "string"
        || !Number.isFinite(Date.parse(fence.updated_at))) {
      throw new Error("Flow recovery fence is malformed or unsupported");
    }
    if (fence.status === "active") throw new Error(`Flow run ${runId} is fenced for recovery ${String(fence.recovery_id)}`);
    if (directoryIdentity(resolvedProjectRoot, runRoot) !== beforeDirectory) throw new Error("Flow run directory changed during recovery fence read");
    return {
      status: "open",
      fingerprint: createHash("sha256").update(bytes).digest("hex"),
      generation: String(fence.generation),
      directory: beforeDirectory,
      fence: fence as Fence,
    };
  } finally { fs.closeSync(descriptor); }
}

export function assertFlowRunRecoveryFenceOpen(projectRoot: string, runId: string): void {
  readFenceSnapshot(projectRoot, runId);
}

export function withFlowRunRecoveryFenceRead<T>(projectRoot: string, runId: string, operation: () => T): T {
  const before = readFenceSnapshot(projectRoot, runId);
  let result: T | undefined;
  let operationError: unknown;
  let operationFailed = false;
  try {
    result = operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  const after = readFenceSnapshot(projectRoot, runId);
  if (before.fingerprint !== after.fingerprint || before.generation !== after.generation || before.directory !== after.directory) {
    throw new Error(`Flow run ${runId} recovery fence changed during read`);
  }
  if (operationFailed) throw operationError;
  return result as T;
}

export async function withFlowRunRecoveryFenceReadAsync<T>(projectRoot: string, runId: string, operation: () => Promise<T>): Promise<T> {
  const before = readFenceSnapshot(projectRoot, runId);
  let result: T | undefined;
  let operationError: unknown;
  let operationFailed = false;
  try {
    result = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  const after = readFenceSnapshot(projectRoot, runId);
  if (before.fingerprint !== after.fingerprint || before.generation !== after.generation || before.directory !== after.directory) {
    throw new Error(`Flow run ${runId} recovery fence changed during read`);
  }
  if (operationFailed) throw operationError;
  return result as T;
}

export function canonicalProjectRootForFlowAgentsSession(sessionDir: string): string {
  const resolved = path.resolve(sessionDir);
  if (path.basename(path.dirname(resolved)) !== "flow-agents" || path.basename(path.dirname(path.dirname(resolved))) !== ".kontourai") {
    throw new Error("Flow Agents session is not in the canonical artifact root");
  }
  return path.dirname(path.dirname(path.dirname(resolved)));
}

export function assertFlowSessionRecoveryFenceOpen(sessionDir: string): void {
  const resolved = path.resolve(sessionDir);
  if (path.basename(path.dirname(resolved)) !== "flow-agents" || path.basename(path.dirname(path.dirname(resolved))) !== ".kontourai") return;
  assertFlowRunRecoveryFenceOpen(canonicalProjectRootForFlowAgentsSession(resolved), path.basename(resolved));
}

export function withFlowSessionRecoveryFenceRead<T>(sessionDir: string, operation: () => T): T {
  const resolved = path.resolve(sessionDir);
  if (path.basename(path.dirname(resolved)) !== "flow-agents" || path.basename(path.dirname(path.dirname(resolved))) !== ".kontourai") return operation();
  return withFlowRunRecoveryFenceRead(canonicalProjectRootForFlowAgentsSession(resolved), path.basename(resolved), operation);
}
