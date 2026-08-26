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
        // command against a group whose leader has just died.
        //
        // WHEN DOES kill(-pgid) RETURN EPERM? When the group still holds a child that has EXITED
        // BUT NOT YET BEEN REAPED — a zombie's credentials are cleared, so it cannot be signalled.
        // Not load, not concurrency. Measured here, sequentially, on an otherwise ordinary host:
        //
        //   bash -c "printf x"             leader only          x200 : ESRCH 200                      EPERM  0%
        //   bash -c "sleep 0.05 & printf x" leader + LIVE child x200 : SIGNALLED 200                  EPERM  0%
        //   bash -c "true & printf x"      leader + ZOMBIE      x200 : ESRCH 143, EPERM 48, SIG 9     EPERM 24%
        //
        // A group whose extra member is LIVE never shows it; a group with no children never shows
        // it. That is why simple probes read clean while real evidence commands — which all spawn
        // AND reap children — hit it routinely, and it is why this failed a live aggregate lane.
        //
        // THIS COMMENT HAS BEEN WRONG THREE TIMES, so the retractions are kept rather than tidied
        // away. It claimed EPERM was "the common case" (it is not); it claimed the leader was
        // reaped "between the liveness check and the signal" (there is no liveness check, and the
        // causality is inverted — it is the CHILD going unreaped); it claimed EPERM appears
        // whenever the group has "more than one member" (a live second member gives 0/200); and it
        // asserted a loop over `bash -lc true` "will never show it", which is exactly the sentence
        // a future reader would cite to dismiss a valid probe. Independent review measured that
        // very command at 3/3200 (~0.09%); this run got 0/1600, which at that rate is unremarkable
        // and does NOT contradict it. Neither observation supports the word "never".
        //
        // Earlier rate figures (1.75% from review, 2/800 from here) are retracted AS RATES — both
        // were shapes that only incidentally produced zombies. The phenomenon and the mechanism
        // above are what survive, and `bash -c "true & printf x"` is the reproducer to use.
        //
        // It is worth handling because its consequence is severe out of proportion to its
        // frequency: the rethrow reached beginCleanup's catch and rejected a completed observation
        // whose exit code and output had already been captured.
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
    // ROUND-3 BLOCKER: this runs from BOTH the timeout and the child's own `exit`, and round 2
    // armed the bounded settle from either — so a command that exited 0 in ~50ms but left an
    // out-of-group process holding its inherited stdout was REJECTED at killGraceMs, blaming a
    // timeout that never happened. Measured against origin/main on the same probe: main RESOLVED
    // exit_code=0 at 8168ms, round 2 REJECTED at 5074ms. The entry path is the discriminator and
    // was already known here, so it is passed explicitly rather than inferred.
    const beginCleanup = (reason: "timeout" | "exit"): void => {
      if (settled || cleanupStarted) return;
      cleanupStarted = true;
      try {
        if (!terminateProcessGroup("SIGTERM")) {
          cleanupComplete = true;
          complete();
          // Only the TIMEOUT path may bound this. On the exit path the command has already
          // finished, its streams will close on their own, and waiting is both correct and what
          // main does — there is no runaway left to bound, so rejecting there would discard a
          // successful observation. (An exit-path stream holder that NEVER closes still hangs;
          // that is pre-existing, untouched here, and filed rather than silently absorbed.)
          if (reason === "timeout" && !settled) {
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
    timeout = setTimeout(() => beginCleanup("timeout"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdoutHash.update(chunk); captureOutput(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderrHash.update(chunk); captureOutput(chunk); });
    child.once("error", fail);
    child.once("exit", (code) => { closedCode = code; beginCleanup("exit"); });
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
