import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  assertRequestMatchesProvider,
  buildChangeProviderResult,
  ChangeProviderError,
  parseChangeProviderRequest,
  type ChangeProvider,
  type ChangeProviderCapability,
  type ChangeProviderRequest,
  type ChangeProviderResult,
} from "./change-provider.js";
import type { ChangeProviderSettings } from "./public-contracts.js";

const ADAPTER_ID = "github-gh-cli" as const;
const MAX_PROVIDER_OUTPUT_BYTES = 256 * 1024;
const EXECUTION_TIMEOUT_MS = 30_000;

export type ArgvExecutionResult = Readonly<{ stdout: string }>;
export type ArgvExecutor = (
  executable: string,
  argv: readonly string[],
  options: Readonly<{ timeoutMs: number; maxOutputBytes: number; env?: NodeJS.ProcessEnv }>,
) => Promise<ArgvExecutionResult>;

export type GithubChangeProviderDependencies = Readonly<{
  /** Explicit in-process test seam; production uses execFileArgv. */
  executor?: ArgvExecutor;
  /** Explicit in-process test seam; production resolves a trusted absolute executable. */
  executable?: string;
  now?: () => string;
}>;

type TrustedExecutable = Readonly<{ candidate: string; path: string; device: number; inode: number; size: number; mtimeMs: number; mode: number }>;
type GithubExecutionDependencies = Required<Pick<GithubChangeProviderDependencies, "executor" | "executable" | "now">> & Readonly<{ trustedExecutable: TrustedExecutable | null; env?: NodeJS.ProcessEnv }>;
type GithubListRecord = Readonly<{ number: number; id: string; baseRefName: string; headRefName: string; headRefOid: string; state: string; title: string; body: string; isDraft: boolean }>;
type GithubProviderRecord = Readonly<{ id: unknown; number: unknown; url: unknown; state: unknown; baseRefName: unknown; headRefName: unknown; headRefOid: unknown; title: unknown; body: unknown; isDraft: unknown }>;

/**
 * Product-owned GitHub implementation. It only returns a verified provider
 * result: canonical Flow mutation is intentionally owned by the Wave 2B
 * transaction, never by this adapter.
 */
export function createGithubChangeProvider(settings: ChangeProviderSettings, configurationId: string, dependencies: GithubChangeProviderDependencies = {}): ChangeProvider {
  if (settings.kind !== "github" || settings.executor !== "gh-cli") {
    throw new ChangeProviderError("invalid_request", "GitHub ChangeProvider requires github gh-cli settings");
  }
  const injectedExecutor = dependencies.executor !== undefined;
  if (!injectedExecutor && dependencies.executable !== undefined) {
    throw new ChangeProviderError("invalid_request", "ChangeProvider executable overrides require an injected executor");
  }
  const trustedExecutable = injectedExecutor ? null : resolveTrustedGithubExecutableIdentity();
  const execution: GithubExecutionDependencies = {
    executor: dependencies.executor ?? execFileArgv,
    executable: injectedExecutor ? validateExecutable(dependencies.executable ?? "gh") : trustedExecutable!.path,
    now: dependencies.now ?? (() => new Date().toISOString()),
    trustedExecutable,
  };
  const provider: ChangeProviderSettings = { ...settings, repository: { ...settings.repository }, capabilities: [...settings.capabilities] };
  const normalizedConfigurationId = validateConfigurationId(configurationId);
  return Object.freeze({
    kind: "github" as const,
    checkCapability: async () => checkGithubCapability(provider, await bindGithubAuthentication(execution)),
    createOrRecover: async (requestInput: ChangeProviderRequest) => {
      const request = parseChangeProviderRequest(requestInput);
      assertRequestMatchesProvider(request, provider, normalizedConfigurationId);
      // The capability check authenticates the configured gh identity, while
      // the result remains bound to the Flow assignment actor in `request`.
      // This lets the Flow-owned completer reject a transferred assignment.
      const authenticatedExecution = await bindGithubAuthentication(execution);
      const capability = await checkGithubCapability(provider, authenticatedExecution);
      return createOrRecoverGithubChange(request, authenticatedExecution, capability.provider_actor);
    },
  });
}

async function bindGithubAuthentication(dependencies: GithubExecutionDependencies): Promise<GithubExecutionDependencies> {
  const token = (await invoke(dependencies, ["auth", "token", "--hostname", "github.com"], "provider_auth_failed")).trim();
  if (!token || /[\0\r\n]/u.test(token) || Buffer.byteLength(token, "utf8") > 16 * 1024) {
    throw new ChangeProviderError("provider_auth_failed", "configured ChangeProvider authentication failed");
  }
  const env: NodeJS.ProcessEnv = { ...process.env, GH_TOKEN: token };
  delete env.GITHUB_TOKEN;
  return Object.freeze({
    ...dependencies,
    // Pin every subsequent gh invocation to the same credential. The token is
    // process-local, never copied into argv, errors, results, or artifacts.
    env,
  });
}

async function checkGithubCapability(settings: ChangeProviderSettings, dependencies: GithubExecutionDependencies): Promise<ChangeProviderCapability> {
  // `auth status` asserts an authenticated gh session, while the two JSON APIs
  // bind that session to a usable actor and the configured repository. Neither
  // command output is exposed outside this module.
  await invoke(dependencies, ["auth", "status", "--hostname", "github.com"], "provider_auth_failed");
  const user = plainObject(parseProviderJson(await invoke(dependencies, ["api", "user"], "provider_auth_failed"), "authenticated actor"), "authenticated actor");
  const actor = providerString(user.login, "authenticated actor login", 512);
  const repo = plainObject(parseProviderJson(await invoke(dependencies, ["api", `repos/${repoSlug(settings)}`]), "configured repository"), "configured repository");
  if (repo.full_name !== repoSlug(settings)) {
    throw new ChangeProviderError("provider_observation_mismatch", "configured repository observation did not match provider settings");
  }
  return Object.freeze({ provider_actor: actor });
}

async function createOrRecoverGithubChange(request: ChangeProviderRequest, dependencies: GithubExecutionDependencies, providerActor: string): Promise<ChangeProviderResult> {
  const before = await listMatchingChanges(request, dependencies);
  const existing = selectExactChange(before, request);
  if (existing) return observeExactChange(request, existing.number, dependencies, providerActor);

  try {
    // gh pr create returns a human URL. Do not parse or retain it; all trusted
    // provider data comes from the bounded JSON re-observation below.
    await invoke(dependencies, createArgv(request));
  } catch (error) {
    if (!(error instanceof ChangeProviderError) || error.code === "invalid_request") throw error;
    // A timeout or transport error can occur after GitHub created the PR.
    // Re-query once before surfacing failure, never retrying create blindly.
    return recoverAfterAmbiguousCreate(request, dependencies, providerActor, error);
  }

  const after = await listMatchingChanges(request, dependencies);
  const created = selectExactChange(after, request);
  if (!created) throw new ChangeProviderError("provider_observation_mismatch", "provider did not return the expected published change after creation");
  return observeExactChange(request, created.number, dependencies, providerActor);
}

async function recoverAfterAmbiguousCreate(request: ChangeProviderRequest, dependencies: GithubExecutionDependencies, providerActor: string, originalError: ChangeProviderError): Promise<ChangeProviderResult> {
  try {
    const after = await listMatchingChanges(request, dependencies);
    const recovered = selectExactChange(after, request);
    if (recovered) return observeExactChange(request, recovered.number, dependencies, providerActor);
  } catch (recoveryError) {
    if (recoveryError instanceof ChangeProviderError && (recoveryError.code === "ambiguous_provider_change" || recoveryError.code === "provider_observation_mismatch" || recoveryError.code === "malformed_provider_output" || recoveryError.code === "oversized_provider_output")) {
      throw recoveryError;
    }
  }
  throw originalError;
}

async function listMatchingChanges(request: ChangeProviderRequest, dependencies: GithubExecutionDependencies): Promise<GithubListRecord[]> {
  const output = await invoke(dependencies, [
    "pr", "list",
    "--repo", repoSlug(request),
    "--state", "all",
    "--head", request.head_ref,
    "--base", request.base_ref,
    "--limit", "100",
    "--json", "id,number,state,baseRefName,headRefName,headRefOid,title,body,isDraft",
  ]);
  const value = parseProviderJson(output, "provider list output");
  if (!Array.isArray(value) || value.length > 100) malformed("provider list output must be an array of at most 100 entries");
  return value.map((entry, index) => parseListRecord(entry, index));
}

function selectExactChange(records: GithubListRecord[], request: ChangeProviderRequest): GithubListRecord | null {
  const sameRefs = records.filter((record) => record.baseRefName === request.base_ref && record.headRefName === request.head_ref);
  if (sameRefs.some((record) => !["open", "merged"].includes(record.state.toLowerCase()))) {
    throw new ChangeProviderError("provider_observation_mismatch", "provider listed an unpublished change state for the canonical request");
  }
  const stale = sameRefs.filter((record) => record.headRefOid.toLowerCase() !== request.head_sha);
  if (stale.length) {
    throw new ChangeProviderError("provider_observation_mismatch", "provider change head SHA does not match the canonical request");
  }
  if (sameRefs.length > 1) throw new ChangeProviderError("ambiguous_provider_change", "provider returned more than one exact published change");
  const candidate = sameRefs[0] ?? null;
  if (candidate && !matchesIntent(candidate, request)) {
    throw new ChangeProviderError("provider_observation_mismatch", "provider change intent does not match the canonical request");
  }
  return candidate;
}

async function observeExactChange(request: ChangeProviderRequest, number: number, dependencies: GithubExecutionDependencies, providerActor: string): Promise<ChangeProviderResult> {
  const output = await invoke(dependencies, ["api", `repos/${repoSlug(request)}/pulls/${number}`]);
  const record = parseProviderRecord(parseProviderJson(output, "provider record output"), request);
  const finalCapability = await checkGithubCapability({
    role: "ChangeProvider", kind: "github", repository: request.repository,
    capabilities: ["change.create", "change.observe"], executor: "gh-cli",
  }, dependencies);
  if (finalCapability.provider_actor !== providerActor) {
    throw new ChangeProviderError("provider_observation_mismatch", "authenticated provider actor changed during provider observation");
  }
  return buildChangeProviderResult({ request, providerRecord: record, adapter: ADAPTER_ID, providerActor: finalCapability.provider_actor, observedAt: dependencies.now() });
}

function createArgv(request: ChangeProviderRequest): string[] {
  return [
    "pr", "create",
    "--repo", repoSlug(request),
    "--title", request.intent.title,
    "--body", request.intent.body,
    "--head", request.head_ref,
    "--base", request.base_ref,
    ...(request.intent.draft ? ["--draft"] : []),
  ];
}

function repoSlug(value: Pick<ChangeProviderRequest, "repository"> | ChangeProviderSettings): string {
  return `${value.repository.owner}/${value.repository.name}`;
}

async function invoke(dependencies: GithubExecutionDependencies, argv: readonly string[], failureCode: "provider_auth_failed" | "provider_failure" = "provider_failure"): Promise<string> {
  try {
    if (dependencies.trustedExecutable) revalidateTrustedGithubExecutable(dependencies.trustedExecutable);
    const result = await dependencies.executor(dependencies.executable, Object.freeze([...argv]), { timeoutMs: EXECUTION_TIMEOUT_MS, maxOutputBytes: MAX_PROVIDER_OUTPUT_BYTES, ...(dependencies.env ? { env: dependencies.env } : {}) });
    if (!result || typeof result.stdout !== "string") malformed("provider executor returned an invalid result");
    if (Buffer.byteLength(result.stdout, "utf8") > MAX_PROVIDER_OUTPUT_BYTES) {
      throw new ChangeProviderError("oversized_provider_output", "provider output exceeded the configured size limit");
    }
    return result.stdout;
  } catch (error) {
    if (error instanceof ChangeProviderError) throw error;
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      throw new ChangeProviderError("provider_unavailable", "configured ChangeProvider executable is unavailable");
    }
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new ChangeProviderError("oversized_provider_output", "provider output exceeded the configured size limit");
    }
    // Never copy error text/stdout/stderr: gh diagnostics may contain tokens.
    throw new ChangeProviderError(failureCode, failureCode === "provider_auth_failed" ? "configured ChangeProvider authentication failed" : "configured ChangeProvider execution failed");
  }
}

function parseProviderJson(output: string, label: string): unknown {
  try {
    return JSON.parse(output) as unknown;
  } catch {
    malformed(`${label} is not valid JSON`);
  }
}

function parseListRecord(value: unknown, index: number): GithubListRecord {
  const record = plainObject(value, `provider list entry ${index}`);
  return Object.freeze({
    id: providerString(record.id, `provider list entry ${index} id`, 1_024),
    number: providerPositiveInteger(record.number, `provider list entry ${index} number`),
    state: providerString(record.state, `provider list entry ${index} state`, 16),
    baseRefName: providerRef(record.baseRefName, `provider list entry ${index} base ref`),
    headRefName: providerRef(record.headRefName, `provider list entry ${index} head ref`),
    headRefOid: providerSha(record.headRefOid, `provider list entry ${index} head SHA`),
    title: providerString(record.title, `provider list entry ${index} title`, 512),
    body: providerString(record.body, `provider list entry ${index} body`, 65_536, true),
    isDraft: providerBoolean(record.isDraft, `provider list entry ${index} draft`),
  });
}

function parseProviderRecord(value: unknown, request: ChangeProviderRequest): GithubProviderRecord {
  const record = plainObject(value, "provider record output");
  const base = plainObject(record.base, "provider record base");
  const baseRepo = plainObject(base.repo, "provider record base repository");
  const head = plainObject(record.head, "provider record head");
  if (baseRepo.full_name !== repoSlug(request)) {
    throw new ChangeProviderError("provider_observation_mismatch", "provider record repository does not match the canonical request");
  }
  return Object.freeze({
    id: record.node_id,
    number: record.number,
    url: record.html_url,
    state: record.merged === true ? "merged" : record.state,
    baseRefName: base.ref,
    headRefName: head.ref,
    headRefOid: head.sha,
    title: record.title,
    body: record.body,
    isDraft: record.draft,
  });
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) malformed(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) malformed(`${label} must be a plain object`);
  return value as Record<string, unknown>;
}

function providerString(value: unknown, label: string, maxBytes: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && (value.length === 0 || value !== value.trim())) || /[\0\r]/u.test(value) || Buffer.byteLength(value, "utf8") > maxBytes) malformed(`${label} is invalid`);
  return value;
}

function providerBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") malformed(`${label} is invalid`);
  return value;
}

function matchesIntent(record: Pick<GithubListRecord, "title" | "body" | "isDraft">, request: ChangeProviderRequest): boolean {
  return record.title === request.intent.title
    && record.body === request.intent.body
    && record.isDraft === Boolean(request.intent.draft);
}

function providerRef(value: unknown, label: string): string {
  const ref = providerString(value, label, 255);
  if (ref.startsWith("-") || ref.startsWith("/") || ref.endsWith("/") || ref.includes("..") || ref.includes("@{") || /[~^:?*[\\\s\x00-\x1f\x7f]/u.test(ref)) malformed(`${label} is invalid`);
  return ref;
}

function providerSha(value: unknown, label: string): string {
  const sha = providerString(value, label, 64).toLowerCase();
  if (!/^[0-9a-f]{40,64}$/u.test(sha)) malformed(`${label} is invalid`);
  return sha;
}

function providerPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) malformed(`${label} is invalid`);
  return Number(value);
}

function validateExecutable(value: string): string {
  if (!value || value !== value.trim() || /[\0\r\n]/u.test(value)) throw new ChangeProviderError("invalid_request", "configured ChangeProvider executable is invalid");
  return value;
}

const TRUSTED_GITHUB_EXECUTABLES = process.platform === "darwin"
  ? ["/run/current-system/sw/bin/gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"]
  : process.platform === "win32"
    ? ["C:\\Program Files\\GitHub CLI\\gh.exe"]
    : ["/run/current-system/sw/bin/gh", "/usr/bin/gh", "/usr/local/bin/gh"];

/** Production never searches PATH: a repository-local shim cannot authenticate Flow. */
export function resolveTrustedGithubExecutable(): string {
  return resolveTrustedGithubExecutableIdentity().path;
}

function resolveTrustedGithubExecutableIdentity(): TrustedExecutable {
  for (const candidate of TRUSTED_GITHUB_EXECUTABLES) {
    try {
      return trustedExecutableIdentity(candidate);
    } catch {
      // Try the next fixed system location. Every candidate is independently verified.
    }
  }
  throw new ChangeProviderError("provider_unavailable", "trusted GitHub CLI executable is unavailable");
}

function trustedExecutableIdentity(candidate: string): TrustedExecutable {
  const resolved = fs.realpathSync(candidate);
  if (!path.isAbsolute(resolved) || !TRUSTED_GITHUB_EXECUTABLES.includes(candidate)) {
    throw new ChangeProviderError("provider_unavailable", "trusted GitHub CLI executable is unavailable");
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o111) === 0)) {
    throw new ChangeProviderError("provider_unavailable", "trusted GitHub CLI executable is unavailable");
  }
  assertSecureSystemPath(resolved, stat);
  return Object.freeze({ candidate, path: resolved, device: stat.dev, inode: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode });
}

function assertSecureSystemPath(resolved: string, stat: fs.Stats): void {
  if (process.platform === "win32") return;
  if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw new Error("untrusted executable ownership");
  let directory = path.dirname(resolved);
  while (true) {
    const directoryStat = fs.statSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.uid !== 0 || (directoryStat.mode & 0o022) !== 0) throw new Error("untrusted executable parent");
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}

function revalidateTrustedGithubExecutable(identity: TrustedExecutable): void {
  const current = trustedExecutableIdentity(identity.candidate);
  if (current.device !== identity.device || current.inode !== identity.inode || current.size !== identity.size || current.mtimeMs !== identity.mtimeMs || current.mode !== identity.mode) {
    throw new ChangeProviderError("provider_unavailable", "trusted GitHub CLI executable changed during provider operation");
  }
}

function validateConfigurationId(value: string): string {
  if (!value || value !== value.trim() || /[\0\r\n]/u.test(value) || Buffer.byteLength(value, "utf8") > 1_024) {
    throw new ChangeProviderError("invalid_request", "ChangeProvider configuration id is invalid");
  }
  return value;
}

function malformed(message: string): never {
  throw new ChangeProviderError("malformed_provider_output", message);
}

const execFileArgv: ArgvExecutor = (executable, argv, options) => new Promise((resolve, reject) => {
  execFile(executable, [...argv], {
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: options.maxOutputBytes,
    shell: false,
    windowsHide: true,
    env: options.env,
  }, (error, stdout) => {
    if (error) reject(error);
    else resolve({ stdout });
  });
});
