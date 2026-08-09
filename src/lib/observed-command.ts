import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { captureReviewWorkspaceSnapshot, isGitWorktreeSnapshot, type GitWorktreeSnapshot } from "./review-workspace-snapshot.js";

export type ObservedWorkspaceState =
  | {
    status: "captured";
    observed_at_commit: string;
    worktree_clean: boolean;
    verification_workspace_snapshot: GitWorktreeSnapshot;
  }
  | {
    /** Git state could not be derived, so this execution is non-confirming. */
    status: "unavailable";
    reason: string;
  };

export type ObservedProcessResult = {
  command: string;
  exit_code: number | null;
  output_sha256: string;
  output: string;
  observation: ObservedWorkspaceState;
};

function configuredTimeout(variable: string, fallback: number): number {
  const value = Number(process.env[variable] ?? fallback);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export async function runObservedCommand(command: string, projectRoot: string): Promise<ObservedProcessResult> {
  const timeoutMs = configuredTimeout("FLOW_AGENTS_EVIDENCE_COMMAND_TIMEOUT_MS", 600000);
  const killGraceMs = configuredTimeout("FLOW_AGENTS_EVIDENCE_COMMAND_KILL_GRACE_MS", 5000);
  const result = await new Promise<{ code: number | null; outputSha256: string; output: string }>((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], {
      cwd: projectRoot,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutHash = createHash("sha256");
    const stderrHash = createHash("sha256");
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let cleanupStarted = false;
    let cleanupComplete = false;
    let streamsClosed = false;
    let closedCode: number | null = null;
    let output = "";
    const captureOutput = (chunk: Buffer): void => {
      if (output.length >= 64 * 1024) return;
      output += chunk.toString("utf8").slice(0, 64 * 1024 - output.length);
    };
    const terminateProcessGroup = (signal: NodeJS.Signals): boolean => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw error;
      }
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    };
    const complete = (): void => {
      if (settled || !cleanupComplete || !streamsClosed) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      const outputHash = createHash("sha256")
        .update("stdout\0").update(stdoutHash.digest())
        .update("stderr\0").update(stderrHash.digest());
      resolve({ code: closedCode, outputSha256: outputHash.digest("hex"), output });
    };
    const beginCleanup = (): void => {
      if (settled || cleanupStarted) return;
      cleanupStarted = true;
      try {
        if (!terminateProcessGroup("SIGTERM")) {
          cleanupComplete = true;
          complete();
          return;
        }
        killTimer = setTimeout(() => {
          killTimer = undefined;
          try {
            terminateProcessGroup("SIGKILL");
            cleanupComplete = true;
            complete();
          } catch (error) {
            fail(error as Error);
          }
        }, killGraceMs);
      } catch (error) {
        fail(error as Error);
      }
    };
    timeout = setTimeout(beginCleanup, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdoutHash.update(chunk); captureOutput(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderrHash.update(chunk); captureOutput(chunk); });
    child.once("error", fail);
    child.once("exit", (code) => { closedCode = code; beginCleanup(); });
    child.once("close", () => { streamsClosed = true; complete(); });
  });
  // This must follow the process's `close` event, which is the point at which
  // its stdout/stderr streams have settled. The resulting snapshot is the
  // observation boundary for both the command result and its Git provenance.
  return {
    command,
    exit_code: result.code,
    output_sha256: result.outputSha256,
    output: result.output,
    observation: captureObservedWorkspaceState(projectRoot),
  };
}

function captureObservedWorkspaceState(projectRoot: string): ObservedWorkspaceState {
  try {
    const snapshot = captureReviewWorkspaceSnapshot(projectRoot, []);
    if (!isGitWorktreeSnapshot(snapshot)) {
      return { status: "unavailable", reason: "canonical Git workspace state is unavailable" };
    }
    return {
      status: "captured",
      observed_at_commit: snapshot.head_sha,
      worktree_clean: snapshot.worktree_clean,
      verification_workspace_snapshot: snapshot,
    };
  } catch {
    // The completed process observation remains useful for an observed failure,
    // but cannot confirm a pass without the matching Git workspace state.
    return { status: "unavailable", reason: "canonical Git workspace state could not be captured" };
  }
}
