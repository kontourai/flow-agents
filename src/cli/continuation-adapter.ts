import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { ContinuationAdapterTimeoutError } from "../continuation-driver.js";
import type { ContinuationBarrier, ContinuationTurnRequest, ContinuationTurnResult } from "../continuation-driver.js";

export type ContinuationAdapterCommand = {
  argv: string[];
  identity: string;
  integrity: Array<{ file: string; sha256: string }>;
};

export function continuationAdapterCommandIdentity(commandFileInput: string): string {
  return loadContinuationAdapterCommand(commandFileInput).identity;
}

export function loadContinuationAdapterCommand(commandFileInput: string): ContinuationAdapterCommand {
  const commandFile = path.resolve(commandFileInput);
  const command = validateAdapterCommand(JSON.parse(readRegularFileNoFollow(commandFile, "continuation adapter command file")) as unknown);
  if (!path.isAbsolute(command.argv[0]!)) throw new Error("continuation adapter executable must be an absolute path");
  const integrity = [...new Set(command.argv.filter((entry) => path.isAbsolute(entry) && regularFileExists(entry)))]
    .map((file) => ({ file, sha256: sha256File(file, "continuation adapter integrity file") }));
  if (!integrity.some((entry) => entry.file === command.argv[0])) throw new Error("continuation adapter executable must be a regular file");
  const identity = createHash("sha256").update(JSON.stringify({ ...command, integrity })).digest("hex");
  return { ...command, identity, integrity };
}

export async function executeContinuationAdapter(
  commandFileInput: string,
  request: ContinuationTurnRequest,
  options: ContinuationAdapterOptions,
): Promise<ContinuationTurnResult> {
  const command = loadContinuationAdapterCommand(commandFileInput);
  return executeLoadedContinuationAdapter(command, request, options);
}

export async function executeLoadedContinuationAdapter(
  command: ContinuationAdapterCommand,
  request: ContinuationTurnRequest,
  options: ContinuationAdapterOptions,
): Promise<ContinuationTurnResult> {
  assertLoadedContinuationAdapterIntegrity(command);
  assertPositiveInteger(options.timeoutMs, "continuation adapter timeoutMs", 1, 86_400_000);
  return await spawnAdapter(command, request, options);
}

export function assertLoadedContinuationAdapterIntegrity(command: ContinuationAdapterCommand): void {
  for (const entry of command.integrity) {
    if (sha256File(entry.file, "continuation adapter integrity file") !== entry.sha256) {
      throw new Error(`continuation adapter integrity changed after mission binding: ${entry.file}`);
    }
  }
}

export async function waitForContinuationBarrier(
  barrier: ContinuationBarrier,
  options: { maxWaitMs: number; pollMs: number; now?: () => number; sleep?: (ms: number) => Promise<void> },
): Promise<"ready" | "pending"> {
  assertPositiveInteger(options.maxWaitMs, "continuation barrier maxWaitMs", 0, 86_400_000);
  assertPositiveInteger(options.pollMs, "continuation barrier pollMs", 1, 60_000);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const stopAt = now() + options.maxWaitMs;

  if (barrier.kind === "deadline") {
    const deadline = Date.parse(barrier.at);
    if (deadline <= now()) return "ready";
    const waitMs = Math.min(deadline - now(), Math.max(0, stopAt - now()));
    if (waitMs > 0) await sleep(waitMs);
    return Date.parse(barrier.at) <= now() ? "ready" : "pending";
  }

  while (pidAlive(barrier.pid)) {
    const remaining = stopAt - now();
    if (remaining <= 0) return "pending";
    await sleep(Math.min(options.pollMs, remaining));
  }
  return "ready";
}

function spawnAdapter(
  command: ContinuationAdapterCommand,
  request: ContinuationTurnRequest,
  options: ContinuationAdapterOptions,
): Promise<ContinuationTurnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.argv[0]!, command.argv.slice(1), {
      cwd: options.cwd,
      env: adapterEnvironment(options),
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let termination: Promise<void> | undefined;
    const terminate = () => termination ??= terminateOwnedProcessGroup(child.pid);
    const finish = async (error?: Error, result?: ContinuationTurnResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        if (error || !isValidWaitResult(result!)) await terminate();
        if (error) reject(error);
        else resolve(result!);
      } catch (cleanupError) { reject(cleanupError); }
    };
    let terminationError: Error | undefined;
    const maxBytes = 4 * 1024 * 1024;
    const timeout = setTimeout(() => {
      if (settled) return;
      terminationError = new ContinuationAdapterTimeoutError(options.timeoutMs);
      void terminate().catch((error: Error) => { void finish(error); });
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) {
        if (!terminationError) {
          terminationError = new Error("continuation adapter stdout exceeded 4 MiB");
          clearTimeout(timeout);
          void terminate().catch((error: Error) => { void finish(error); });
        }
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxBytes) stderr.push(chunk);
    });
    child.on("error", (error) => { void finish(error); });
    child.on("close", (code, signal) => {
      if (settled) return;
      if (terminationError) { void finish(terminationError); return; }
      const stderrText = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        void finish(new Error(`continuation adapter exited ${code ?? signal ?? "unknown"}${stderrText ? `: ${stderrText}` : ""}`));
        return;
      }
      const output = Buffer.concat(stdout).toString("utf8").trim();
      try {
        const result = JSON.parse(output) as ContinuationTurnResult;
        void finish(undefined, result);
      } catch {
        void finish(new Error("continuation adapter must emit exactly one JSON result on stdout"));
      }
    });
    child.stdin.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "EPIPE") void finish(error);
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

type ContinuationAdapterOptions = {
  cwd: string;
  timeoutMs: number;
  continuationTurnSecret?: string;
  continuationRunId?: string;
};

function adapterEnvironment(options: ContinuationAdapterOptions): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.FLOW_AGENTS_CONTINUATION_TURN_SECRET;
  delete env.FLOW_AGENTS_CONTINUATION_RUN_ID;
  delete env.FLOW_AGENTS_CONTINUATION_TURN_NONCE;
  delete env.FLOW_AGENTS_CONTINUATION_TURN_PUBLIC_KEY_DIGEST;
  delete env.FLOW_AGENTS_CONTINUATION_ACTOR_B64;
  const { continuationTurnSecret: turnSecret, continuationRunId: runId } = options;
  if (!turnSecret || !runId) return env;
  env.FLOW_AGENTS_CONTINUATION_TURN_SECRET = turnSecret;
  env.FLOW_AGENTS_CONTINUATION_RUN_ID = runId;
  return env;
}

function validateAdapterCommand(value: unknown): Pick<ContinuationAdapterCommand, "argv"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("continuation adapter command file must contain an object");
  const argv = (value as { argv?: unknown }).argv;
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > 128 || argv.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.includes("\0"))) {
    throw new Error("continuation adapter command argv must contain 1 through 128 non-empty strings");
  }
  return { argv: [...argv] as string[] };
}

function assertRegularFile(file: string, label: string): void {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file`);
}

function readRegularFileNoFollow(file: string, label: string): string {
  return readRegularFileBufferNoFollow(file, label).toString("utf8");
}

function readRegularFileBufferNoFollow(file: string, label: string): Buffer {
  assertRegularFile(file, label);
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`${label} must be a regular file`);
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function assertPositiveInteger(value: number, label: string, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer from ${min} through ${max}`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function terminateProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function isValidWaitResult(result: ContinuationTurnResult): boolean {
  if (result?.status !== "wait" || !result.barrier || typeof result.barrier !== "object") return false;
  if (result.barrier.kind === "pid") return Number.isSafeInteger(result.barrier.pid) && result.barrier.pid > 0;
  return result.barrier.kind === "deadline" && typeof result.barrier.at === "string" && Number.isFinite(Date.parse(result.barrier.at));
}

// A POSIX group can outlive its leader. Retain the escalation until completion,
// and bind it to members observed before TERM so a recycled group ID is not killed.
async function terminateOwnedProcessGroup(pid: number | undefined): Promise<void> {
  if (!pid) return;
  if (process.platform === "win32") { terminateProcessGroup(pid, "SIGTERM"); return; }
  const members = processGroupMembers(pid);
  if (members.size === 0) return;
  terminateProcessGroup(pid, "SIGTERM");
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  const current = processGroupMembers(pid);
  if ([...members].some(([member, identity]) => current.get(member) === identity)) {
    terminateProcessGroup(pid, "SIGKILL");
  }
}

function processGroupMembers(group: number): Map<number, string> {
  const output = execFileSync("/bin/ps", ["-eo", "pid=,pgid=,lstart="], { encoding: "utf8", timeout: 5_000, maxBuffer: 4 * 1024 * 1024 });
  const members = new Map<number, string>();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match && Number(match[2]) === group) members.set(Number(match[1]), match[3]!);
  }
  return members;
}

function regularFileExists(file: string): boolean {
  try {
    const stat = fs.lstatSync(file);
    return !stat.isSymbolicLink() && stat.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function sha256File(file: string, label: string): string {
  return createHash("sha256").update(readRegularFileBufferNoFollow(file, label)).digest("hex");
}
