import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
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
import type { AuthenticatedMergeChangeObservation, IssuedMergeChangeAction } from "../merge-change-operation-authority.js";
import { publishChangeProviderConfigurationId } from "../publish-change-operation-authority.js";

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

export type GithubMergedChangeObservation = Readonly<{
  state: "merged";
  mergeSha: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  providerActor: string;
  observedAt: string;
}>;

type TrustedExecutable = Readonly<{ candidate: string; path: string; device: number; inode: number; size: number; mtimeMs: number; mode: number }>;
type GithubExecutionDependencies = Required<Pick<GithubChangeProviderDependencies, "executor" | "executable" | "now">> & Readonly<{ trustedExecutable: TrustedExecutable | null; env?: NodeJS.ProcessEnv; authConfigDir?: string }>;
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
    checkCapability: async () => {
      const authenticatedExecution = await bindGithubAuthentication(execution);
      try { return await checkGithubCapability(provider, authenticatedExecution); }
      finally { releaseGithubAuthentication(authenticatedExecution); }
    },
    createOrRecover: async (requestInput: ChangeProviderRequest) => {
      const request = parseChangeProviderRequest(requestInput);
      assertRequestMatchesProvider(request, provider, normalizedConfigurationId);
      // The capability check authenticates the configured gh identity, while
      // the result remains bound to the Flow assignment actor in `request`.
      // This lets the Flow-owned completer reject a transferred assignment.
      const authenticatedExecution = await bindGithubAuthentication(execution);
      try {
        const capability = await checkGithubCapability(provider, authenticatedExecution);
        return await createOrRecoverGithubChange(request, authenticatedExecution, capability.provider_actor);
      } finally {
        releaseGithubAuthentication(authenticatedExecution);
      }
    },
  });
}

/**
 * Re-observe an already-published change for destructive closeout. This is
 * intentionally narrower than createOrRecover: it can only confirm a merged
 * record already bound to the configured repository, refs, and immutable head
 * SHA. It never creates, edits, closes, or merges a provider record.
 */
export async function observeGithubMergedChange(input: Readonly<{
  settings: ChangeProviderSettings;
  configurationId: string;
  expected: Readonly<{
    number: number;
    repository: { owner: string; name: string };
    baseRef: string;
    headRef: string;
    headSha: string;
    providerActor: string;
  }>;
}>, dependencies: GithubChangeProviderDependencies = {}): Promise<GithubMergedChangeObservation> {
  const { settings, expected } = input;
  if (settings.kind !== "github" || settings.executor !== "gh-cli"
    || settings.repository.owner !== expected.repository.owner
    || settings.repository.name !== expected.repository.name) {
    throw new ChangeProviderError("invalid_request", "merged-change observation does not match the configured GitHub provider");
  }
  validateConfigurationId(input.configurationId);
  if (!Number.isSafeInteger(expected.number) || expected.number < 1) {
    throw new ChangeProviderError("invalid_request", "merged-change provider record number is invalid");
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
  const authenticatedExecution = await bindGithubAuthentication(execution);
  try {
    const capability = await checkGithubCapability(settings, authenticatedExecution);
    if (capability.provider_actor !== expected.providerActor) {
      throw new ChangeProviderError("provider_observation_mismatch", "authenticated provider actor changed before worktree closeout");
    }
    const raw = plainObject(parseProviderJson(
      await invoke(authenticatedExecution, ["api", `repos/${expected.repository.owner}/${expected.repository.name}/pulls/${expected.number}`]),
      "merged-change provider record output",
    ), "merged-change provider record output");
    const base = plainObject(raw.base, "merged-change provider base");
    const head = plainObject(raw.head, "merged-change provider head");
    const baseRepo = plainObject(base.repo, "merged-change provider base repository");
    const headSha = providerSha(head.sha, "merged-change provider head SHA");
    const mergeSha = providerSha(raw.merge_commit_sha, "merged-change provider merge SHA");
    if (raw.merged !== true
      || baseRepo.full_name !== `${expected.repository.owner}/${expected.repository.name}`
      || base.ref !== expected.baseRef
      || head.ref !== expected.headRef
      || headSha !== expected.headSha.toLowerCase()) {
      throw new ChangeProviderError("provider_observation_mismatch", "provider did not confirm the exact merged change bound to this worktree");
    }
    return Object.freeze({
      state: "merged" as const,
      mergeSha,
      headSha,
      headRef: expected.headRef,
      baseRef: expected.baseRef,
      providerActor: capability.provider_actor,
      observedAt: execution.now(),
    });
  } finally {
    releaseGithubAuthentication(authenticatedExecution);
  }
}

/**
 * Authenticated destructive merge primitive.  It re-observes the exact terminal
 * PR head and its checks immediately before the mutation.  The caller cannot
 * substitute a SHA, strategy, or provider observation after action issuance.
 */
export async function mergeGithubChangeExactHead(
  settings: ChangeProviderSettings,
  action: IssuedMergeChangeAction,
  dependencies: GithubChangeProviderDependencies = {},
): Promise<AuthenticatedMergeChangeObservation> {
  if (settings.kind !== "github" || settings.executor !== "gh-cli"
    || settings.repository.owner !== action.repository.owner || settings.repository.name !== action.repository.name) {
    throw new ChangeProviderError("invalid_request", "merge-change does not match the configured GitHub provider");
  }
  if (publishChangeProviderConfigurationId(settings) !== action.provider.configuration_id) {
    throw new ChangeProviderError("provider_observation_mismatch", "merge-change provider configuration changed after action issuance");
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
  const authenticated = await bindGithubAuthentication(execution);
  try {
    const capability = await checkGithubCapability(settings, authenticated);
    assertExpectedProviderActor(action, capability.provider_actor);
    const before = await mergeProviderRecord(action, authenticated);
    assertExactMergeHead(before, action);
    await assertExactHeadChecks(action, authenticated);

    // Required checks are associated with a PR, not an immutable request
    // object. Re-observe its exact head immediately after the check query so a
    // force-push cannot turn a passing observation into a later mutation.
    const checked = await mergeProviderRecord(action, authenticated);
    assertExactMergeHead(checked, action);
    if (checked.merged === true) {
      return { schema_version: "1.0", operation: "merge-change", binding: structuredClone(action.binding), repository: structuredClone(action.repository), intent: structuredClone(action.intent), provider: { kind: "github", configuration_id: action.provider.configuration_id, adapter: ADAPTER_ID }, assignment_actor: action.assignment_actor, provider_actor: capability.provider_actor, state: "merged", merge_sha: providerSha(checked.merge_commit_sha, "existing merge SHA"), observed_at: execution.now() };
    }

    if (action.intent.strategy === "merge-queue") {
      const admitted = await observeExactMergeQueueEntry(action, authenticated);
      if (admitted) return queuedMergeObservation(action, capability.provider_actor, admitted, execution.now());
      await assertMergeMutationPolicy(settings, action, authenticated);
      // GitHub routes --auto through a configured merge queue.  The match-head
      // guard is the server-side compare-and-mutate fence; re-observation below
      // proves that the queue accepted the very same terminal source head.
      await invoke(authenticated, ["pr", "merge", String(action.intent.change_number), "--repo", repoSlug(action), "--auto", "--match-head-commit", action.intent.terminal_head_sha]);
      const queued = await mergeProviderRecord(action, authenticated);
      assertExactMergeHead(queued, action);
      if (queued.merged === true) {
        const mergeSha = providerSha(queued.merge_commit_sha, "merge queue merge SHA");
        return { schema_version: "1.0", operation: "merge-change", binding: structuredClone(action.binding), repository: structuredClone(action.repository), intent: structuredClone(action.intent), provider: { kind: "github", configuration_id: action.provider.configuration_id, adapter: ADAPTER_ID }, assignment_actor: action.assignment_actor, provider_actor: capability.provider_actor, state: "merged", merge_sha: mergeSha, observed_at: execution.now() };
      }
      const queueEntry = await assertMergeQueueAccepted(action, authenticated);
      return queuedMergeObservation(action, capability.provider_actor, queueEntry, execution.now());
    }

    const mergeMethod = action.intent.strategy === "merge-commit" ? "merge" : action.intent.strategy;
    await assertMergeMutationPolicy(settings, action, authenticated);
    const result = plainObject(parseProviderJson(await invoke(authenticated, ["api", "--method", "PUT", `repos/${repoSlug(action)}/pulls/${action.intent.change_number}/merge`, "-f", `sha=${action.intent.terminal_head_sha}`, "-f", `merge_method=${mergeMethod}`]), "merge provider result"), "merge provider result");
    if (result.merged !== true) throw new ChangeProviderError("provider_observation_mismatch", "provider did not merge the exact terminal change head");
    const after = await mergeProviderRecord(action, authenticated);
    assertExactMergeHead(after, action);
    if (after.merged !== true) throw new ChangeProviderError("provider_observation_mismatch", "provider did not confirm the exact merged change");
    return { schema_version: "1.0", operation: "merge-change", binding: structuredClone(action.binding), repository: structuredClone(action.repository), intent: structuredClone(action.intent), provider: { kind: "github", configuration_id: action.provider.configuration_id, adapter: ADAPTER_ID }, assignment_actor: action.assignment_actor, provider_actor: capability.provider_actor, state: "merged", merge_sha: providerSha(after.merge_commit_sha ?? result.sha, "merge provider result SHA"), observed_at: execution.now() };
  } finally {
    releaseGithubAuthentication(authenticated);
  }
}

/** `headCommit` is GitHub's immutable merge-group candidate, not the PR source commit. */
type QueueEntry = Readonly<{ id: string; headSha: string; admittedMergeGroupSha?: string }>;

function queuedMergeObservation(action: IssuedMergeChangeAction, providerActor: string, entry: QueueEntry, observedAt: string): AuthenticatedMergeChangeObservation {
  return {
    schema_version: "1.0", operation: "merge-change", binding: structuredClone(action.binding), repository: structuredClone(action.repository), intent: structuredClone(action.intent), provider: { kind: "github", configuration_id: action.provider.configuration_id, adapter: ADAPTER_ID }, assignment_actor: action.assignment_actor, provider_actor: providerActor,
    state: "queued", queue_entry: { id: entry.id, head_sha: entry.headSha, ...(entry.admittedMergeGroupSha ? { admitted_merge_group_sha: entry.admittedMergeGroupSha } : {}) }, observed_at: observedAt,
  };
}

async function observeExactMergeQueueEntry(action: IssuedMergeChangeAction, dependencies: GithubExecutionDependencies): Promise<QueueEntry | null> {
  return await queryMergeQueueEntry(action, dependencies, false);
}

async function assertMergeQueueAccepted(action: IssuedMergeChangeAction, dependencies: GithubExecutionDependencies): Promise<QueueEntry> {
  const entry = await queryMergeQueueEntry(action, dependencies, true);
  if (!entry) throw new ChangeProviderError("provider_observation_mismatch", "provider did not return an immutable merge queue entry for the exact terminal head; run flow-agents workflow publish-delivery, then refresh the exact-head provider checks and retry");
  return entry;
}

async function queryMergeQueueEntry(action: IssuedMergeChangeAction, dependencies: GithubExecutionDependencies, required: boolean): Promise<QueueEntry | null> {
  const query = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid mergeQueueEntry{id state headCommit{oid}}}}}";
  const response = plainObject(parseProviderJson(await invoke(dependencies, [
    "api", "graphql",
    "-f", `query=${query}`,
    "-f", `owner=${action.repository.owner}`,
    "-f", `name=${action.repository.name}`,
    "-F", `number=${action.intent.change_number}`,
  ]), "merge queue observation"), "merge queue observation");
  const data = plainObject(response.data, "merge queue observation data");
  const repository = plainObject(data.repository, "merge queue observation repository");
  const pullRequest = plainObject(repository.pullRequest, "merge queue observation pull request");
  if (providerSha(pullRequest.headRefOid, "merge queue pull request head SHA") !== action.intent.terminal_head_sha) {
    throw new ChangeProviderError("provider_observation_mismatch", "merge queue pull request head no longer matches the exact terminal head; run flow-agents workflow publish-delivery, then refresh the exact-head provider checks and retry");
  }
  if (pullRequest.mergeQueueEntry === null || pullRequest.mergeQueueEntry === undefined) {
    if (required) throw new ChangeProviderError("provider_observation_mismatch", "provider did not return an immutable merge queue entry for the exact terminal head; run flow-agents workflow publish-delivery, then refresh the exact-head provider checks and retry");
    return null;
  }
  const entry = plainObject(pullRequest.mergeQueueEntry, "merge queue entry");
  if (!["AWAITING_CHECKS", "LOCKED", "MERGEABLE", "QUEUED"].includes(String(entry.state))) {
    throw new ChangeProviderError("provider_observation_mismatch", "provider did not confirm admission of the exact terminal head to its merge queue; run flow-agents workflow publish-delivery, then refresh the exact-head provider checks and retry");
  }
  const headCommit = entry.headCommit === null || entry.headCommit === undefined ? undefined : plainObject(entry.headCommit, "merge queue merge-group commit");
  return Object.freeze({ id: providerString(entry.id, "merge queue entry id", 1024), headSha: action.intent.terminal_head_sha, ...(headCommit ? { admittedMergeGroupSha: providerSha(headCommit.oid, "merge queue merge-group SHA") } : {}) });
}

async function mergeProviderRecord(action: IssuedMergeChangeAction, dependencies: GithubExecutionDependencies): Promise<Record<string, unknown>> {
  return plainObject(parseProviderJson(await invoke(dependencies, ["api", `repos/${repoSlug(action)}/pulls/${action.intent.change_number}`]), "merge provider record"), "merge provider record");
}

function assertExactMergeHead(record: Record<string, unknown>, action: IssuedMergeChangeAction): void {
  const base = plainObject(record.base, "merge provider base");
  const baseRepo = plainObject(base.repo, "merge provider base repository");
  const head = plainObject(record.head, "merge provider head");
  const headRepo = plainObject(head.repo, "merge provider head repository");
  if (baseRepo.full_name !== repoSlug(action) || headRepo.full_name !== repoSlug(action) || base.ref !== action.intent.base_ref || head.ref !== action.intent.head_ref
    || providerSha(head.sha, "merge provider head SHA") !== action.intent.terminal_head_sha) {
    throw new ChangeProviderError("provider_observation_mismatch", "provider head no longer matches the exact terminal merge action");
  }
}

async function assertExactHeadChecks(action: IssuedMergeChangeAction, dependencies: GithubExecutionDependencies): Promise<void> {
  // `gh pr checks --required` is GitHub's authenticated required-check view;
  // Check Runs alone omit legacy commit-status contexts and cannot identify
  // which checks branch protection actually requires. Zero required checks is
  // ambiguous for a destructive operation, so fail closed rather than assume
  // an unprotected branch is authorization.
  const checks = parseProviderJson(await invoke(dependencies, ["pr", "checks", String(action.intent.change_number), "--repo", repoSlug(action), "--required", "--json", "bucket,name,link"]), "required terminal-head checks");
  if (!Array.isArray(checks) || checks.length === 0) {
    throw new ChangeProviderError("provider_observation_mismatch", "no required provider checks were returned for the exact terminal head");
  }
  for (const [index, check] of checks.entries()) {
    const entry = plainObject(check, `terminal-head check ${index}`);
    if (entry.bucket !== "pass") {
      throw new ChangeProviderError("provider_observation_mismatch", "required provider checks are not passing for the exact terminal head");
    }
  }
}

/**
 * Destructive merge authorization is intentionally stricter than a one-time
 * `gh auth status`: the actor that publishes the canonical change is part of
 * the signed merge action and must still be the actor making the mutation.
 */
function assertExpectedProviderActor(action: IssuedMergeChangeAction, providerActor: string): void {
  if (action.expected_provider_actor !== providerActor) {
    throw new ChangeProviderError("provider_observation_mismatch", "authenticated provider actor changed after canonical publish-change observation");
  }
}

/**
 * Re-observe the effective branch policy before a destructive call. This
 * refuses an absent/ambiguous policy rather than treating a passing check as
 * authorization to bypass review or branch protection.
 */
async function assertMergeMutationPolicy(settings: ChangeProviderSettings, action: IssuedMergeChangeAction, dependencies: GithubExecutionDependencies): Promise<void> {
  const repository = plainObject(parseProviderJson(
    await invoke(dependencies, ["api", `repos/${repoSlug(action)}`]),
    "merge repository policy",
  ), "merge repository policy");
  const strategyFlag = action.intent.strategy === "squash"
    ? "allow_squash_merge"
    : action.intent.strategy === "rebase"
      ? "allow_rebase_merge"
      : action.intent.strategy === "merge-commit"
        ? "allow_merge_commit"
        : "allow_auto_merge";
  if (repository[strategyFlag] !== true) {
    throw new ChangeProviderError("provider_observation_mismatch", `provider policy does not permit the selected ${action.intent.strategy} merge strategy`);
  }

  // The branch-protection resource is GitHub's provider-authenticated policy
  // view for this exact target ref. Requiring enforced-admin protection and a
  // positive approval threshold rejects both no-policy and admin-bypass
  // ambiguity. Ruleset-only configurations that do not expose an equivalent
  // no-bypass policy remain deliberately unsupported rather than guessed.
  const protection = plainObject(parseProviderJson(
    await invoke(dependencies, ["api", `repos/${repoSlug(action)}/branches/${encodeURIComponent(action.intent.base_ref)}/protection`]),
    "merge branch protection policy",
  ), "merge branch protection policy");
  const enforceAdmins = plainObject(protection.enforce_admins, "merge branch protection enforce-admins");
  const reviewPolicy = plainObject(protection.required_pull_request_reviews, "merge branch protection review policy");
  if (enforceAdmins.enabled !== true
    || !Number.isSafeInteger(reviewPolicy.required_approving_review_count)
    || Number(reviewPolicy.required_approving_review_count) < 1) {
    throw new ChangeProviderError("provider_observation_mismatch", "provider branch protection does not establish an enforced no-bypass approval policy");
  }

  // Rulesets can add or supersede classic branch protection. GitHub's
  // effective-rules endpoint is the provider's branch-specific projection, so
  // do not infer a ruleset from repository configuration or an older cached
  // protection response. Requiring a review rule keeps an unobservable bypass
  // or policy-removal from becoming implicit merge authority.
  const effectiveRules = plainObject(parseProviderJson(
    await invoke(dependencies, ["api", `repos/${repoSlug(action)}/rules/branches/${encodeURIComponent(action.intent.base_ref)}`]),
    "merge effective ruleset policy",
  ), "merge effective ruleset policy");
  if (!Array.isArray(effectiveRules.rules) || !effectiveRules.rules.some((rule) => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) return false;
    const entry = rule as Record<string, unknown>;
    const parameters = entry.parameters;
    return entry.type === "pull_request"
      && parameters !== null
      && typeof parameters === "object"
      && !Array.isArray(parameters)
      && Number.isSafeInteger((parameters as Record<string, unknown>).required_approving_review_count)
      && Number((parameters as Record<string, unknown>).required_approving_review_count) >= 1;
  })) {
    throw new ChangeProviderError("provider_observation_mismatch", "provider effective ruleset does not establish a review policy for the terminal target branch");
  }

  // This is deliberately the final provider observation before mutation: the
  // same authenticated GraphQL response binds the current actor, source head,
  // review decision, and provider mergeability state. A dismissed or stale
  // approval resolves to a non-APPROVED reviewDecision and is rejected.
  const query = "query($owner:String!,$name:String!,$number:Int!){viewer{login} repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid isDraft merged mergeable mergeStateStatus reviewDecision}}}";
  const response = plainObject(parseProviderJson(await invoke(dependencies, [
    "api", "graphql",
    "-f", `query=${query}`,
    "-f", `owner=${settings.repository.owner}`,
    "-f", `name=${settings.repository.name}`,
    "-F", `number=${action.intent.change_number}`,
  ]), "terminal merge policy observation"), "terminal merge policy observation");
  const viewer = plainObject(response.data, "terminal merge policy data");
  const actor = plainObject(viewer.viewer, "terminal merge policy actor");
  assertExpectedProviderActor(action, providerString(actor.login, "terminal merge policy actor login", 512));
  const repositoryData = plainObject(viewer.repository, "terminal merge policy repository");
  const pullRequest = plainObject(repositoryData.pullRequest, "terminal merge policy pull request");
  if (providerSha(pullRequest.headRefOid, "terminal merge policy head SHA") !== action.intent.terminal_head_sha
    || pullRequest.isDraft === true
    || pullRequest.merged === true
    || pullRequest.reviewDecision !== "APPROVED"
    || pullRequest.mergeable !== "MERGEABLE"
    || pullRequest.mergeStateStatus !== "CLEAN") {
    throw new ChangeProviderError("provider_observation_mismatch", "provider terminal-head review, mergeability, or policy observation does not permit merge");
  }
}

async function bindGithubAuthentication(dependencies: GithubExecutionDependencies): Promise<GithubExecutionDependencies> {
  const trustedHome = os.userInfo().homedir;
  const bootstrapEnv: NodeJS.ProcessEnv = {
    HOME: trustedHome,
    PATH: process.platform === "win32"
      ? "C:\\Program Files\\GitHub CLI;C:\\Program Files\\Git\\cmd;C:\\Windows\\System32;C:\\Windows"
      : "/run/current-system/sw/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    ...(process.platform === "win32" ? {
      USERPROFILE: trustedHome,
      APPDATA: path.win32.join(trustedHome, "AppData", "Roaming"),
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
    } : {}),
  };
  const token = (await invoke({ ...dependencies, env: bootstrapEnv }, ["auth", "token", "--hostname", "github.com"], "provider_auth_failed")).trim();
  if (!token || /[\0\r\n]/u.test(token) || Buffer.byteLength(token, "utf8") > 16 * 1024) {
    throw new ChangeProviderError("provider_auth_failed", "configured ChangeProvider authentication failed");
  }
  // Use an allowlist instead of inheriting gh's evolving environment surface.
  // In particular, GH_CONFIG_DIR and http_unix_socket must not redirect a
  // token-bearing request to a caller-controlled transport.
  const env: NodeJS.ProcessEnv = {
    GH_TOKEN: token,
    PATH: process.platform === "win32"
      ? "C:\\Program Files\\GitHub CLI;C:\\Program Files\\Git\\cmd;C:\\Windows\\System32;C:\\Windows"
      : "/run/current-system/sw/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    ...(process.platform === "win32" ? { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" } : {}),
  };
  const authConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-gh-auth-"));
  fs.chmodSync(authConfigDir, 0o700);
  env.GH_CONFIG_DIR = authConfigDir;
  return Object.freeze({
    ...dependencies,
    // Pin every subsequent gh invocation to the same credential. The token is
    // process-local, never copied into argv, errors, results, or artifacts.
    env,
    authConfigDir,
  });
}

function releaseGithubAuthentication(dependencies: GithubExecutionDependencies): void {
  if (dependencies.authConfigDir) fs.rmSync(dependencies.authConfigDir, { recursive: true, force: true });
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
    const writableWithoutStickyOwnership = (directoryStat.mode & 0o022) !== 0 && (directoryStat.mode & 0o1000) === 0;
    if (!directoryStat.isDirectory() || directoryStat.uid !== 0 || writableWithoutStickyOwnership) throw new Error("untrusted executable parent");
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
