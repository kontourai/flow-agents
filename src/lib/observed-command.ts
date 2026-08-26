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
        // #1369: both ESRCH and EPERM mean "the signal did not land", and neither indicates a
        // fault in the command being observed — so both return false rather than throwing.
        //
        // beginCleanup runs from the child's own `exit` event, so this fires on every successful
        // command against a group whose leader has just died. MEASURED, because the first version
        // of this comment guessed and guessed wrong: over 300 real exit-path teardowns on this
        // platform the result was ESRCH 300/300, EPERM 0/300. EPERM is RARE here, not the common
        // case. It is still worth handling — it was observed in the wild, failing an aggregate
        // verify lane — and its consequence is severe out of proportion to its frequency: the
        // rethrow reached beginCleanup's catch and rejected a completed observation whose exit
        // code and output had already been captured.
        //
        // There is no liveness check to race against — the only guard above is `child.pid` being
        // truthy — so EPERM here means the process group id can no longer be signalled by this
        // process, not that a check went stale.
        //
        // EPERM does not prove the group is gone; it proves this process cannot signal it. On the
        // EXIT path both readings leave the caller the same options and escalating to SIGKILL
        // would fail identically, so completing with the captured result is strictly better than
        // discarding it. On the TIMEOUT path they do NOT coincide — the child is still running and
        // the options are reject-vs-wait-forever — which is why beginCleanup arms a bounded settle
        // below rather than relying on this return value alone.
        //
        // Deliberately NOT a blanket catch: any other errno still throws, because it would
        // indicate something this helper does not understand.
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ESRCH" || code === "EPERM") return false;
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
      if (killTimer) clearTimeout(killTimer);
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
          if (!settled) {
            // #1369 round 2: the group could not be signalled AND the streams are still open, so
            // the child is still running -- this is the TIMEOUT path, not the exit path. complete()
            // can never fire (it needs streamsClosed) and no other timer is armed, so the promise
            // would hang forever on the one mechanism that exists to bound a runaway evidence
            // command. Pre-fix, the EPERM rethrow masked this by rejecting; widening the errno list
            // without this would have converted a loud 400ms failure into a silent unbounded wait.
            // The same hang already existed for ESRCH, so this closes that too rather than only
            // restoring parity.
            killTimer = setTimeout(() => fail(new Error(
              `observed command exceeded ${timeoutMs}ms, its process group could not be signalled, and it did not close its streams within a further ${killGraceMs}ms`,
            )), killGraceMs);
          }
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
