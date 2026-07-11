import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

export type ObservedProcessResult = {
  command: string;
  exit_code: number | null;
  output_sha256: string;
  output: string;
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
  return { command, exit_code: result.code, output_sha256: result.outputSha256, output: result.output };
}
