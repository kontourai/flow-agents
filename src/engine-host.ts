/** Installed CLI execution, separate from kit semantics and Station interactive sessions. */
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { access, readFile, realpath, stat, readdir, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

export type EngineId = "codex" | "claude" | "kiro" | "cursor" | "opencode" | "copilot" | "muse";
const profiles = {
  codex: { executable: "codex", surfaces: ["cli"] },
  claude: { executable: "claude", surfaces: ["cli"] },
  kiro: { executable: "kiro-cli", surfaces: ["cli", "ide"] },
  cursor: { executable: "cursor-agent", surfaces: ["cli", "ide"] },
  opencode: { executable: "opencode", surfaces: ["cli"] },
  muse: { executable: "muse", surfaces: ["cli"] },
  copilot: { executable: "copilot", surfaces: ["cli", "vscode"] },
} as const;
export function listEngineProfiles() {
  return Object.entries(profiles).map(([id, value]) => ({ id: id as EngineId, executable: value.executable, surfaces: [...value.surfaces], automated_surface: "cli" as const }));
}
function profile(engine: EngineId) {
  if (!Object.hasOwn(profiles, engine)) throw new Error(`Unsupported engine: ${engine}`);
  return profiles[engine];
}
const digest = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
export async function detectEngine(engine: EngineId, options: { environment?: NodeJS.ProcessEnv; executable?: string } = {}) {
  const registered = profile(engine);
  const executable = options.executable ?? registered.executable;
  const environment = { ...process.env, ...options.environment };
  const candidates = path.isAbsolute(executable) ? [executable] : (environment.PATH ?? "").split(path.delimiter).filter(Boolean).map(directory => path.resolve(directory, executable));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const resolved = await realpath(candidate);
      if (!(await stat(resolved)).isFile()) continue;
      // Shell/batch launchers require a platform-owned resolver, never shell interpolation here.
      if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(resolved)) continue;
      let version: string | null = null;
      try {
        const result = await promisify(execFile)(resolved, ["--version"], { env: environment, timeout: 5000, maxBuffer: 16384, encoding: "utf8" });
        version = result.stdout.trim().split(/\r?\n/)[0] || null;
      } catch { /* Installed does not imply successful version/auth/runtime observation. */ }
      return { engine, installed: true as const, executable: resolved, version, entrypoint_digest: digest(await readFile(resolved)), authentication: "NOT_VERIFIED" as const };
    } catch { /* Continue PATH lookup, never change engine. */ }
  }
  return { engine, installed: false as const, executable: null, version: null, entrypoint_digest: null, authentication: "NOT_VERIFIED" as const };
}
export function prepareEngineInvocation(engine: EngineId, prompt: string, options: { model?: string; allowTools?: boolean; workspace?: string } = {}) {
  profile(engine);
  if (!prompt || prompt.includes("\0")) throw new Error("Nonempty NUL-free prompt required");
  if (options.model !== undefined && (!options.model || options.model.includes("\0"))) throw new Error("Nonempty NUL-free model required");
  const model = options.model ? ["--model", options.model] : [];
  switch (engine) {
    case "codex": return { args: ["exec", "--json", "--skip-git-repo-check", ...model, ...(options.allowTools ? ["--dangerously-bypass-approvals-and-sandbox"] : []), "-"], stdin: prompt };
    case "claude": return { args: ["-p", "--output-format", "stream-json", "--verbose", ...model, ...(options.allowTools ? ["--dangerously-skip-permissions"] : []), "--", prompt], stdin: "" };
    case "kiro": return { args: ["chat", "--agent-engine", "v2", "--no-interactive", "--output-format", "stream-json", ...model, ...(options.allowTools ? ["--trust-all-tools"] : []), "--", prompt], stdin: "" };
    case "cursor": return { args: ["-p", "--output-format", "stream-json", ...model, ...(options.allowTools ? ["--force"] : []), "--", prompt], stdin: "" };
    case "opencode": return { args: ["run", "--format", "json", ...model, ...(options.allowTools ? ["--auto"] : []), "--", prompt], stdin: "" };
    case "muse": return { args: ["exec", "--json", ...model, ...(options.workspace ? ["--workspace", options.workspace] : []), ...(options.allowTools ? ["--yolo"] : []), "--", prompt], stdin: "" };
    case "copilot": return { args: ["-p", prompt, "--output-format", "json", "--no-ask-user", ...model, ...(options.allowTools ? ["--allow-all-tools"] : [])], stdin: "" };
  }
}
type Event = Record<string, any>;
export function parseEngineOutput(engine: EngineId, stdout: string, options: { version?: string | null } = {}) {
  profile(engine);
  if (Buffer.byteLength(stdout) > 16 * 1024 * 1024) throw new Error("Engine event stream exceeds protocol bound");
  const events: Event[] = stdout.split(/\r?\n/).filter(line => line.trim()).map(line => {
    const event = JSON.parse(line);
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("Expected JSON event object");
    return event;
  });
  let kiroStarted = false, codexThreads = 0, codexTurns = 0;
  const sessions = new Set<string>();
  let final: string | null = null, sessionId: string | null = null, complete = false, failed = false, terminals = 0;
  let usage: { complete: boolean; input_tokens?: number; output_tokens?: number; source: string } = { complete: false, source: "unavailable" };
  const tokens = (value: any, source: string) => {
    if (Number.isSafeInteger(value?.input_tokens) && value.input_tokens >= 0 && Number.isSafeInteger(value?.output_tokens) && value.output_tokens >= 0) usage = { complete: true, input_tokens: value.input_tokens, output_tokens: value.output_tokens, source };
  };
  let openMessage: string | null = null, openText = "", protocolInvalid = false;
  const openMessages = new Set<string>();
  let museRun: string | null = null, museSequence = 0;
  for (const e of events) {
    const eventSession = e.session_id ?? e.sessionID ?? e.sessionId ?? e.data?.sessionId ?? (e.type === "thread.started" ? e.thread_id : null);
    if (typeof eventSession === "string" && eventSession) sessions.add(eventSession);
    switch (engine) {
      case "codex":
        if (e.type === "thread.started") { codexThreads++; sessionId = e.thread_id; }
        if (e.type === "turn.started") codexTurns++;
        if (e.type === "item.completed" && e.item?.type === "agent_message") final = e.item.text;
        if (e.type === "turn.completed") { terminals++; complete = true; tokens(e.usage, "codex-turn-completed"); }
        if (["turn.failed", "error"].includes(e.type)) failed = true;
        break;
      case "claude": case "cursor":
        if (e.session_id) sessionId = e.session_id;
        if (e.type === "result") { terminals++; final = e.result; complete = true; failed ||= e.is_error === true || (e.subtype !== undefined && e.subtype !== "success"); if (!failed) tokens(e.usage, `${engine}-result`); }
        break;
      case "opencode": {
        if (e.sessionID) sessionId = e.sessionID;
        if (["step_start", "text", "step_finish", "tool_use"].includes(e.type)) {
          const id = e.part?.messageID;
          if (typeof id !== "string" || !id || e.part?.sessionID !== e.sessionID || typeof e.sessionID !== "string" || !e.sessionID || terminals) protocolInvalid = true;
          if (e.type === "step_start") {
            if (openMessage !== null || openMessages.has(id)) protocolInvalid = true;
            openMessage = id; openText = ""; openMessages.add(id);
          } else {
            if (id !== openMessage || openMessage === null) protocolInvalid = true;
            if (e.type === "text") { if (typeof e.part?.text !== "string") protocolInvalid = true; else openText += e.part.text; }
            if (e.type === "step_finish") {
              if (e.part?.reason === "stop") { terminals++; complete = true; final = openText; }
              else if (e.part?.reason !== "tool-calls") protocolInvalid = true;
              openMessage = null; openText = "";
            }
          }
        }
        if (e.type === "error") failed = true;
        break;
      }
      case "muse": {
        if (e.schema_version !== 1 || e.payload_schema_version !== 1 || e.stream?.kind !== "session" || typeof e.stream?.id !== "string" || !e.stream.id || !Number.isSafeInteger(e.sequence) || e.sequence <= museSequence || terminals) protocolInvalid = true;
        museSequence = e.sequence; sessionId = e.stream?.id;
        if (typeof sessionId === "string") sessions.add(sessionId);
        const p = e.payload;
        if (e.payload_type === "run.lifecycle.started") {
          if (museRun !== null || p?.kind !== "run_started" || p.run_stream?.kind !== "run" || typeof p.command_id !== "string" || !p.command_id || p.run_stream.id !== p.command_id || e.causation_id !== p.command_id) protocolInvalid = true;
          museRun = p?.command_id;
        }
        if (e.payload_type?.startsWith("run.terminal.")) {
          terminals++;
          if (!museRun || p?.command_id !== museRun || p.run_stream?.kind !== "run" || p.run_stream.id !== museRun || e.causation_id !== museRun || p.kind !== "run_terminal") protocolInvalid = true;
          complete = options.version === "Muse Code 1.4.4 (1.4.4-R5419.1)" && e.payload_type === "run.terminal.completed" && p.terminal === "completed" && p.reason === null;
          final = typeof p?.text === "string" ? p.text : null;
          failed ||= !complete;
        }
        break;
      }
      case "copilot":
        if (e.type === "assistant.message") final = e.data?.content;
        if (e.type === "result") { terminals++; sessionId = e.sessionId; complete = true; failed ||= e.exitCode !== 0; }
        if (e.type === "session.error") failed = true;
        break;
      case "kiro":
        if (e.data?.sessionId) sessionId = e.data.sessionId;
        if (e.type === "runError") failed = true;
        if (e.type === "runStarted") kiroStarted = e.data?.payloadSchema === "acp" && e.data?.acpProtocolVersion === 1 && e.data?.engine === "v2";
        if (e.type === "runFinished" && options.version === "kiro-cli 2.24.0" && kiroStarted) {
          terminals++;
          complete = e.data?.stopReason === "end_turn" && e.data?.finalTextTruncated === false && typeof e.data?.finalText === "string";
          final = complete ? e.data.finalText : null;
        }
        break;
    }
  }
  complete &&= !protocolInvalid && openMessage === null && sessions.size === 1 && (engine !== "codex" || (codexThreads === 1 && codexTurns === 1)) && terminals === 1 && typeof sessionId === "string" && sessionId.length > 0 && typeof final === "string" && final.length > 0;
  return { final: typeof final === "string" ? final : null, session_id: typeof sessionId === "string" ? sessionId : null, complete, failed, usage };
}
async function readOnlyRevision(workspace: string) {
  const moduleName = "@kontourai/flow-agents/workspace-revision";
  const { workspaceRevision } = await import(moduleName);
  const metadata: [string, number][] = [];
  const visit = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(directory, entry.name);
      const observed = await lstat(child);
      if (observed.isSymbolicLink() || (!observed.isFile() && !observed.isDirectory())) throw new Error("Read-only workspace contains unsupported tree entry");
      metadata.push([path.relative(workspace, child), observed.mode]);
      if (observed.isDirectory()) await visit(child);
    }
  };
  metadata.push([".", (await stat(workspace)).mode]);
  await visit(workspace);
  return digest(JSON.stringify({ content: await workspaceRevision(workspace), metadata }));
}
export type RunEngineOptions = {
  engine: EngineId; workspace: string; prompt: string; model?: string; timeoutMs: number;
  executionProfile: "host-native"; hostAccessGranted: true;
  signal?: AbortSignal; environment?: NodeJS.ProcessEnv; executable?: string;
  allowTools?: boolean; readOnlyWorkspace?: boolean; surface?: "cli" | "ide" | "vscode"; maxOutputBytes?: number; redactValues?: string[];
};
export async function runEngine(options: RunEngineOptions) {
  if (options.executionProfile !== "host-native" || options.hostAccessGranted !== true) throw new Error("Explicit host-native profile and host access grant required; no isolation or credential confinement is provided");
  if ((options.surface ?? "cli") !== "cli") throw new Error("IDE surface requires its native host; headless CLI execution cannot verify IDE behavior");
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2147483647) throw new Error("Positive bounded timeout required");
  const limit = options.maxOutputBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Positive output bound required");
  const workspace = await realpath(options.workspace);
  const invocation = prepareEngineInvocation(options.engine, options.prompt, { ...options, workspace });
  if (!(await stat(workspace)).isDirectory()) throw new Error("Workspace directory required");
  const revision = options.readOnlyWorkspace ? readOnlyRevision : null;
  const workspaceBefore = revision ? await revision(workspace) : null;
  const installed = await detectEngine(options.engine, options);
  if (!installed.installed) throw new Error(`Engine not installed: ${options.engine}`);
  const suppliedSecrets = [...(options.redactValues ?? []), ...Object.values(options.environment ?? {}).filter((value): value is string => typeof value === "string" && value.length > 0)];
  const secrets = [...new Set(suppliedSecrets.flatMap(value => [value, JSON.stringify(value).slice(1, -1)]).filter(Boolean))].sort((a, b) => b.length - a.length);
  const redact = (value: string) => secrets.reduce((text, secret) => text.split(secret).join("[redacted]"), value);
  let stdout = "", stderr = "", bytes = 0, timeout = false, cancelled = options.signal?.aborted ?? false, overflow = false;
  let status: number | null = null, exitSignal: NodeJS.Signals | null = null, spawnError: string | null = null;
  if (!cancelled) await new Promise<void>(resolve => {
    const child = spawn(installed.executable, invocation.args, { cwd: workspace, env: { ...process.env, ...options.environment }, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", shell: false });
    const kill = () => { try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* Already exited. */ } child.stdout.destroy(); child.stderr.destroy(); };
    const abort = () => { cancelled = true; kill(); };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(() => { timeout = true; kill(); }, options.timeoutMs);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    const collect = (chunk: string, stream: "stdout" | "stderr") => {
      bytes += Buffer.byteLength(chunk);
      const available = Math.max(0, limit - Buffer.byteLength(stdout) - Buffer.byteLength(stderr));
      let kept = Buffer.from(chunk).subarray(0, available).toString("utf8");
      while (Buffer.byteLength(kept) > available) kept = kept.slice(0, -1);
      if (stream === "stdout") stdout += kept; else stderr += kept;
      if (bytes > limit) { overflow = true; kill(); }
    };
    child.stdout.on("data", chunk => collect(chunk, "stdout")); child.stderr.on("data", chunk => collect(chunk, "stderr"));
    child.once("error", error => { spawnError = error.message; });
    child.once("close", (code, signal) => { status = code; exitSignal = signal; clearTimeout(timer); options.signal?.removeEventListener("abort", abort); resolve(); });
    child.stdin.on("error", () => {}); child.stdin.end(invocation.stdin);
  });
  let output: ReturnType<typeof parseEngineOutput> | null = null, protocolError: string | null = null;
  if (!timeout && !cancelled && !overflow && !spawnError) try { output = parseEngineOutput(options.engine, stdout, { version: installed.version }); } catch { protocolError = "Invalid engine JSON event stream"; }
  const workspaceAfter = revision ? await revision(workspace) : null;
  const workspaceChanged = workspaceBefore !== workspaceAfter;
  const outcome = workspaceChanged ? "workspace_modified" : cancelled ? "cancelled" : timeout ? "timeout" : overflow ? "output_limit" : spawnError ? "spawn_error" : status !== 0 ? "engine_error" : output?.failed ? "engine_error" : protocolError || !output?.complete ? "protocol_error" : "completed";
  return {
    schema: "kontour.flow-agents.engine_execution_receipt", version: "1.0", invocation_id: randomUUID(),
    observed: { engine: options.engine, surface: "cli", execution_profile: "host-native", isolation: "none", host_access_granted: true, credential_confinement: false, read_only_requested: options.readOnlyWorkspace ?? false, workspace_before: workspaceBefore, workspace_after: workspaceAfter, read_only_observation: "post-execution tree comparison; no OS confinement", executable: installed.executable, harness_version: installed.version ? redact(installed.version) : null, entrypoint_digest: installed.entrypoint_digest, workspace, requested_model: options.model ?? null, model_observation: "CLI request only; physical model unverified", prompt_digest: digest(options.prompt), allow_tools: options.allowTools ?? false },
    outcome, terminal: { status, signal: exitSignal, timeout, cancelled, overflow, spawn_error: spawnError ? redact(spawnError) : null },
    session_id: output?.session_id ? redact(output.session_id) : null, final: output?.final ? redact(output.final) : null,
    usage: output?.usage ?? { complete: false, source: "unavailable" }, protocol_error: protocolError,
    stdout: redact(stdout), stderr: redact(stderr), stdout_digest: digest(redact(stdout)), stderr_digest: digest(redact(stderr)),
  };
}

/** Broker protocol admission is explicit; never fall back to native or another engine. */
export async function runIsolatedEngine(options: {
  engine: EngineId; image: string; workspace: string; sourceRoot: string;
  contextFile: string; providerProxy: { baseUrl: string; capability: string; model: string };
  model: string; timeoutMs: number; artifactRoot: string; runId: string;
  signal?: AbortSignal; [key: string]: unknown;
}) {
  profile(options.engine);
  if (options.engine !== "codex") throw new Error(`Isolated broker protocol not supported: ${options.engine}; no host-native fallback`);
  const moduleName = "@kontourai/flow-agents/docker-worker";
  const { runCodexDockerWorker } = await import(moduleName);
  const { engine: _engine, ...workerOptions } = options;
  const receipt = await runCodexDockerWorker(workerOptions);
  const outcome = options.signal?.aborted ? "cancelled" : receipt.storage_violation ? "storage_violation" : receipt.terminal.timeout ? "timeout" : receipt.terminal.overflow ? "output_limit" : receipt.terminal.status !== 0 ? "engine_error" : !receipt.provider_thread_id || receipt.final === null ? "protocol_error" : "completed";
  return {
    ...receipt,
    outcome,
    observed: { ...receipt.observed, engine: options.engine, surface: "cli", execution_profile: "docker-broker", credential_confinement: receipt.observed.credentials_mounted === false ? true : null, model_observation: receipt.observed.model_observation },
  };
}
