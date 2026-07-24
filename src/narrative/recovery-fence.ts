import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

const FLOW_RUN_RECOVERY_FENCE_FILE = "recovery-fence.json";
const FLOW_RUN_RECOVERY_FENCE_PROTOCOL = "flow.run-recovery-fence.v1";

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

type Snapshot = { fingerprint: string; generation: string; directory: string };

function ancestryIdentity(projectRoot: string, runRoot: string): string {
  let missing = false;
  for (const fixed of [
    path.join(projectRoot, ".kontourai"),
    path.join(projectRoot, ".kontourai", "flow"),
    path.join(projectRoot, ".kontourai", "flow", "runs"),
    runRoot,
  ]) {
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
    const stat = fs.lstatSync(runRoot);
    return `${stat.dev}:${stat.ino}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}

function fenceSnapshot(projectRoot: string, runId: string): Snapshot {
  if (!runId || runId.includes("/") || runId.includes("\\")) throw new Error("Flow recovery fence run id is invalid");
  const resolvedRoot = path.resolve(projectRoot);
  const runRoot = path.join(resolvedRoot, ".kontourai", "flow", "runs", runId);
  const directory = ancestryIdentity(resolvedRoot, runRoot);
  const file = path.join(runRoot, FLOW_RUN_RECOVERY_FENCE_FILE);
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (ancestryIdentity(resolvedRoot, runRoot) !== directory) throw new Error("Flow run directory changed during recovery fence read");
      return { fingerprint: "absent", generation: "absent", directory };
    }
    throw new Error("Flow recovery fence could not be opened safely");
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o022) !== 0 || stat.size === 0 || stat.size > 64 * 1024) throw new Error("Flow recovery fence is malformed");
    const bytes = fs.readFileSync(descriptor);
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("Flow recovery fence is malformed");
    }
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
    if (ancestryIdentity(resolvedRoot, runRoot) !== directory) throw new Error("Flow run directory changed during recovery fence read");
    return {
      fingerprint: createHash("sha256").update(bytes).digest("hex"),
      generation: String(fence.generation),
      directory,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function assertNarrativeFlowRunRecoveryFenceOpen(projectRoot: string, runId: string): void {
  fenceSnapshot(projectRoot, runId);
}

export function assertNarrativeFlowSessionRecoveryFenceOpen(sessionDir: string): void {
  const resolved = path.resolve(sessionDir);
  if (path.basename(path.dirname(resolved)) !== "flow-agents" || path.basename(path.dirname(path.dirname(resolved))) !== ".kontourai") return;
  fenceSnapshot(path.dirname(path.dirname(path.dirname(resolved))), path.basename(resolved));
}

export function withNarrativeFlowRunRecoveryFenceRead<T>(projectRoot: string, runId: string, operation: () => T): T {
  const before = fenceSnapshot(projectRoot, runId);
  let result: T | undefined;
  let operationError: unknown;
  let operationFailed = false;
  try {
    result = operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  const after = fenceSnapshot(projectRoot, runId);
  if (before.fingerprint !== after.fingerprint || before.generation !== after.generation || before.directory !== after.directory) {
    throw new Error(`Flow run ${runId} recovery fence changed during read`);
  }
  if (operationFailed) throw operationError;
  return result as T;
}

export function withNarrativeFlowSessionRecoveryFenceRead<T>(sessionDir: string, operation: () => T): T {
  const resolved = path.resolve(sessionDir);
  if (path.basename(path.dirname(resolved)) !== "flow-agents" || path.basename(path.dirname(path.dirname(resolved))) !== ".kontourai") return operation();
  return withNarrativeFlowRunRecoveryFenceRead(
    path.dirname(path.dirname(path.dirname(resolved))),
    path.basename(resolved),
    operation,
  );
}
