import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ChangeProviderSettings, PublishChangeActionBinding } from "./cli/public-contracts.js";
import { publishChangeProviderConfigurationId } from "./publish-change-operation-authority.js";

/** The only merge strategies the public ChangeProvider contract permits. */
export const MERGE_CHANGE_STRATEGIES = ["squash", "rebase", "merge-commit", "merge-queue"] as const;
export type MergeChangeStrategy = (typeof MERGE_CHANGE_STRATEGIES)[number];

export type MergeChangeIntent = Readonly<{
  strategy: MergeChangeStrategy;
  change_number: number;
  base_ref: string;
  head_ref: string;
  /** The terminal-delivery commit, not the pre-CI/provisional commit. */
  terminal_head_sha: string;
}>;

export type IssuedMergeChangeAction = Readonly<{
  schema_version: "1.0";
  operation: "merge-change";
  binding: PublishChangeActionBinding;
  repository: { owner: string; name: string };
  intent: MergeChangeIntent;
  assignment_actor: string;
  /** The authenticated provider identity that created the canonical PR record. */
  expected_provider_actor: string;
  provider: { kind: "github"; configuration_id: string };
  action_id: string;
}>;

/**
 * The signed, single-use authority consumed by the externally installed
 * lifecycle coordinator before the provider is allowed to mutate a PR.
 *
 * This deliberately carries the complete issued action instead of a loose set
 * of merge flags.  A signature can therefore never be replayed for another
 * strategy, head, PR, provider configuration, assignment, or provider actor.
 */
export type MergeChangeAuthorization = Readonly<{
  schema_version: "1.0";
  operation: "merge-change";
  project_root: string;
  run_id: string;
  subject: string;
  flow_definition_id: string;
  flow_definition_version: string;
  flow_definition_digest: string;
  flow_run_head: string;
  flow_manifest_sha256: string;
  issued_action: IssuedMergeChangeAction;
  issued_action_sha256: string;
  nonce: string;
  requested_at: string;
  expires_at: string;
  signature: { algorithm: "ed25519"; key_id: string; value: string };
}>;

const MERGE_CHANGE_AUTHORIZATION_FIELDS = [
  "schema_version", "operation", "project_root", "run_id", "subject",
  "flow_definition_id", "flow_definition_version", "flow_definition_digest", "flow_run_head", "flow_manifest_sha256",
  "issued_action", "issued_action_sha256", "nonce", "requested_at", "expires_at", "signature",
] as const;

export type AuthenticatedMergeChangeObservation = Readonly<{
  schema_version: "1.0";
  operation: "merge-change";
  binding: PublishChangeActionBinding;
  repository: { owner: string; name: string };
  intent: MergeChangeIntent;
  provider: { kind: "github"; configuration_id: string; adapter: "github-gh-cli" };
  assignment_actor: string;
  provider_actor: string;
  state: "merged" | "queued";
  /** Present only when GitHub reports the completed merge. */
  merge_sha?: string;
  /** Present only while the exact terminal head is admitted to GitHub's queue. */
  queue_entry?: { id: string; head_sha: string; admitted_merge_group_sha?: string };
  observed_at: string;
}>;

function fail(field: string, reason: string): never {
  throw new Error(`merge-change operation authority rejected ${field}: ${reason}`);
}

function bounded(value: unknown, field: string, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(field, `must be a non-empty bounded string (max ${max})`);
  }
  return value;
}

function sha(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

function immutableSha(value: unknown, field: string): string {
  const result = bounded(value, field, 64).toLowerCase();
  if (!/^[a-f0-9]{40,64}$/u.test(result)) fail(field, "must be an immutable lowercase commit SHA");
  return result;
}

function ref(value: unknown, field: string): string {
  const result = bounded(value, field, 255);
  if (result.startsWith("-") || result.startsWith("/") || result.endsWith("/") || result.includes("..") || result.includes("@{") || /[~^:?*[\\\s]/u.test(result)) fail(field, "must be a git ref");
  return result;
}

function binding(value: unknown): PublishChangeActionBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("binding", "must be an object");
  const entry = value as Record<string, unknown>;
  const keys = ["run_id", "definition_id", "definition_version", "step_id", "gate_ids", "gate_visit_id"];
  if (Object.keys(entry).length !== keys.length || !keys.every((key) => key in entry)) fail("binding", "has an unexpected shape");
  if (!Array.isArray(entry.gate_ids) || entry.gate_ids.length !== 1) fail("binding.gate_ids", "must contain exactly one gate id");
  return {
    run_id: bounded(entry.run_id, "binding.run_id", 255), definition_id: bounded(entry.definition_id, "binding.definition_id", 255),
    definition_version: bounded(entry.definition_version, "binding.definition_version", 255), step_id: bounded(entry.step_id, "binding.step_id", 255),
    gate_ids: [bounded(entry.gate_ids[0], "binding.gate_ids[0]", 255)], gate_visit_id: bounded(entry.gate_visit_id, "binding.gate_visit_id", 255),
  };
}

function repository(value: unknown): { owner: string; name: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("repository", "must be an object");
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).length !== 2 || !("owner" in entry) || !("name" in entry)) fail("repository", "has an unexpected shape");
  return { owner: bounded(entry.owner, "repository.owner", 255), name: bounded(entry.name, "repository.name", 255) };
}

function intent(value: unknown): MergeChangeIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("intent", "must be an object");
  const entry = value as Record<string, unknown>;
  const keys = ["strategy", "change_number", "base_ref", "head_ref", "terminal_head_sha"];
  if (Object.keys(entry).length !== keys.length || !keys.every((key) => key in entry)) fail("intent", "has an unexpected shape");
  if (!(MERGE_CHANGE_STRATEGIES as readonly string[]).includes(String(entry.strategy))) fail("intent.strategy", "is unsupported");
  if (!Number.isSafeInteger(entry.change_number) || Number(entry.change_number) < 1) fail("intent.change_number", "must be a positive integer");
  return { strategy: entry.strategy as MergeChangeStrategy, change_number: Number(entry.change_number), base_ref: ref(entry.base_ref, "intent.base_ref"), head_ref: ref(entry.head_ref, "intent.head_ref"), terminal_head_sha: immutableSha(entry.terminal_head_sha, "intent.terminal_head_sha") };
}

export function issueMergeChangeAction(input: Readonly<{ binding: PublishChangeActionBinding; provider: ChangeProviderSettings; assignment_actor: string; expected_provider_actor: string; intent: MergeChangeIntent }>): IssuedMergeChangeAction {
  const request = {
    schema_version: "1.0" as const, operation: "merge-change" as const, binding: binding(input.binding), repository: repository(input.provider.repository),
    intent: intent(input.intent), assignment_actor: bounded(input.assignment_actor, "assignment_actor"), expected_provider_actor: bounded(input.expected_provider_actor, "expected_provider_actor"),
    provider: { kind: "github" as const, configuration_id: publishChangeProviderConfigurationId(input.provider) },
  };
  return Object.freeze({ ...request, action_id: sha(request) });
}

export function assertIssuedMergeChangeAction(value: unknown): IssuedMergeChangeAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("action", "must be an object");
  const entry = value as Record<string, unknown>;
  const keys = ["schema_version", "operation", "binding", "repository", "intent", "assignment_actor", "expected_provider_actor", "provider", "action_id"];
  if (Object.keys(entry).length !== keys.length || !keys.every((key) => key in entry) || entry.schema_version !== "1.0" || entry.operation !== "merge-change") fail("action", "has an unsupported shape");
  if (!entry.provider || typeof entry.provider !== "object" || Array.isArray(entry.provider)) fail("action.provider", "has an unexpected shape");
  const provider = entry.provider as Record<string, unknown>;
  if (Object.keys(provider).length !== 2 || provider.kind !== "github") fail("action.provider", "has an unexpected shape");
  const request = { schema_version: "1.0" as const, operation: "merge-change" as const, binding: binding(entry.binding), repository: repository(entry.repository), intent: intent(entry.intent), assignment_actor: bounded(entry.assignment_actor, "action.assignment_actor"), expected_provider_actor: bounded(entry.expected_provider_actor, "action.expected_provider_actor"), provider: { kind: "github" as const, configuration_id: bounded(provider.configuration_id, "action.provider.configuration_id", 64) } };
  if (!/^[a-f0-9]{64}$/u.test(request.provider.configuration_id)) fail("action.provider.configuration_id", "must be a SHA-256 identity");
  if (entry.action_id !== sha(request)) fail("action.action_id", "does not match the canonical request");
  return Object.freeze({ ...request, action_id: entry.action_id });
}

function digest64(value: unknown, field: string): string {
  const result = bounded(value, field, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(result)) fail(field, "must be a SHA-256 digest");
  return result;
}

function dateTime(value: unknown, field: string): string {
  const result = bounded(value, field, 128);
  if (!Number.isFinite(Date.parse(result))) fail(field, "must be an ISO timestamp");
  return result;
}

function signature(value: unknown): MergeChangeAuthorization["signature"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("authorization.signature", "must be an object");
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).length !== 3 || entry.algorithm !== "ed25519") fail("authorization.signature", "has an unsupported shape");
  return { algorithm: "ed25519", key_id: bounded(entry.key_id, "authorization.signature.key_id", 256), value: bounded(entry.value, "authorization.signature.value", 1024) };
}

/** Exact bytes a lifecycle-authority operator must sign. */
export function mergeChangeAuthorizationPayload(value: Omit<MergeChangeAuthorization, "signature">): string {
  return JSON.stringify(value);
}

export function buildUnsignedMergeChangeAuthorization(input: Omit<MergeChangeAuthorization, "schema_version" | "operation" | "issued_action_sha256" | "signature">): {
  unsigned: Omit<MergeChangeAuthorization, "signature">;
  signingPayload: string;
} {
  const action = assertIssuedMergeChangeAction(input.issued_action);
  const run_id = bounded(input.run_id, "authorization.run_id", 255);
  if (action.binding.run_id !== run_id) fail("authorization.issued_action.binding.run_id", "does not match authorization.run_id");
  if (input.flow_definition_id !== action.binding.definition_id || input.flow_definition_version !== action.binding.definition_version) fail("authorization.definition", "does not match the issued action binding");
  const requested_at = dateTime(input.requested_at, "authorization.requested_at");
  const expires_at = dateTime(input.expires_at, "authorization.expires_at");
  if (Date.parse(expires_at) < Date.parse(requested_at)) fail("authorization.expires_at", "must not precede requested_at");
  const unsigned = {
    schema_version: "1.0" as const, operation: "merge-change" as const,
    project_root: bounded(input.project_root, "authorization.project_root", 4096), run_id,
    subject: bounded(input.subject, "authorization.subject", 2048),
    flow_definition_id: bounded(input.flow_definition_id, "authorization.flow_definition_id", 255),
    flow_definition_version: bounded(input.flow_definition_version, "authorization.flow_definition_version", 255),
    flow_definition_digest: digest64(input.flow_definition_digest, "authorization.flow_definition_digest"),
    flow_run_head: digest64(input.flow_run_head, "authorization.flow_run_head"),
    flow_manifest_sha256: digest64(input.flow_manifest_sha256, "authorization.flow_manifest_sha256"),
    issued_action: action, issued_action_sha256: sha(action),
    nonce: bounded(input.nonce, "authorization.nonce", 256), requested_at, expires_at,
  } satisfies Omit<MergeChangeAuthorization, "signature">;
  return { unsigned, signingPayload: mergeChangeAuthorizationPayload(unsigned) };
}

export function assertMergeChangeAuthorization(value: unknown): MergeChangeAuthorization {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("authorization", "must be an object");
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).length !== MERGE_CHANGE_AUTHORIZATION_FIELDS.length || !MERGE_CHANGE_AUTHORIZATION_FIELDS.every((field) => field in entry)
    || entry.schema_version !== "1.0" || entry.operation !== "merge-change") fail("authorization", "has an unsupported shape");
  const unsigned = buildUnsignedMergeChangeAuthorization({
    project_root: bounded(entry.project_root, "authorization.project_root", 4096), run_id: bounded(entry.run_id, "authorization.run_id", 255), subject: bounded(entry.subject, "authorization.subject", 2048),
    flow_definition_id: bounded(entry.flow_definition_id, "authorization.flow_definition_id", 255), flow_definition_version: bounded(entry.flow_definition_version, "authorization.flow_definition_version", 255),
    flow_definition_digest: digest64(entry.flow_definition_digest, "authorization.flow_definition_digest"), flow_run_head: digest64(entry.flow_run_head, "authorization.flow_run_head"), flow_manifest_sha256: digest64(entry.flow_manifest_sha256, "authorization.flow_manifest_sha256"),
    issued_action: assertIssuedMergeChangeAction(entry.issued_action), nonce: bounded(entry.nonce, "authorization.nonce", 256), requested_at: dateTime(entry.requested_at, "authorization.requested_at"), expires_at: dateTime(entry.expires_at, "authorization.expires_at"),
  }).unsigned;
  if (entry.issued_action_sha256 !== unsigned.issued_action_sha256) fail("authorization.issued_action_sha256", "does not bind the exact issued action");
  return Object.freeze({ ...unsigned, signature: signature(entry.signature) });
}

export function assertAuthenticatedMergeChangeObservation(actionInput: IssuedMergeChangeAction, value: unknown): AuthenticatedMergeChangeObservation {
  const action = assertIssuedMergeChangeAction(actionInput);
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("provider observation", "must be an object");
  const entry = value as Record<string, unknown>;
  const permitted = ["schema_version", "operation", "binding", "repository", "intent", "provider", "assignment_actor", "provider_actor", "state", "merge_sha", "queue_entry", "observed_at"];
  if (Object.keys(entry).some((key) => !permitted.includes(key)) || ![10, 11, 12].includes(Object.keys(entry).length) || entry.schema_version !== "1.0" || entry.operation !== "merge-change") fail("provider observation", "has an unexpected shape");
  if (!isDeepStrictEqual(binding(entry.binding), action.binding) || !isDeepStrictEqual(repository(entry.repository), action.repository) || !isDeepStrictEqual(intent(entry.intent), action.intent)) fail("provider observation", "does not match the issued action");
  if (bounded(entry.assignment_actor, "provider observation.assignment_actor") !== action.assignment_actor) fail("provider observation.assignment_actor", "does not match the issued action");
  if (!entry.provider || typeof entry.provider !== "object" || Array.isArray(entry.provider)) fail("provider observation.provider", "has an unexpected shape");
  const provider = entry.provider as Record<string, unknown>;
  if (Object.keys(provider).length !== 3 || provider.kind !== "github" || provider.configuration_id !== action.provider.configuration_id || provider.adapter !== "github-gh-cli") fail("provider observation.provider", "does not match the issued action");
  if (entry.state !== "merged" && entry.state !== "queued") fail("provider observation.state", "must be merged or queued");
  const observed_at = bounded(entry.observed_at, "provider observation.observed_at", 64);
  if (!Number.isFinite(Date.parse(observed_at))) fail("provider observation.observed_at", "must be an ISO timestamp");
  const merge_sha = entry.merge_sha === undefined ? undefined : immutableSha(entry.merge_sha, "provider observation.merge_sha");
  let queue_entry: AuthenticatedMergeChangeObservation["queue_entry"];
  if (entry.queue_entry !== undefined) {
    if (!entry.queue_entry || typeof entry.queue_entry !== "object" || Array.isArray(entry.queue_entry)) fail("provider observation.queue_entry", "must be an object");
    const queued = entry.queue_entry as Record<string, unknown>;
    const keys = ["id", "head_sha", "admitted_merge_group_sha"];
    if (Object.keys(queued).some((key) => !keys.includes(key)) || ![2, 3].includes(Object.keys(queued).length)) fail("provider observation.queue_entry", "has an unexpected shape");
    const head_sha = immutableSha(queued.head_sha, "provider observation.queue_entry.head_sha");
    if (head_sha !== action.intent.terminal_head_sha) fail("provider observation.queue_entry.head_sha", "does not match the exact terminal head");
    queue_entry = { id: bounded(queued.id, "provider observation.queue_entry.id", 1024), head_sha, ...(queued.admitted_merge_group_sha === undefined ? {} : { admitted_merge_group_sha: immutableSha(queued.admitted_merge_group_sha, "provider observation.queue_entry.admitted_merge_group_sha") }) };
  }
  if (entry.state === "merged" && !merge_sha) fail("provider observation.merge_sha", "is required for a completed merge");
  if (entry.state === "queued" && merge_sha) fail("provider observation.merge_sha", "must be absent while queued");
  if (entry.state === "merged" && queue_entry) fail("provider observation.queue_entry", "must be absent for a completed merge");
  if (entry.state === "queued" && !queue_entry) fail("provider observation.queue_entry", "is required for an admitted queue result");
  const provider_actor = bounded(entry.provider_actor, "provider observation.provider_actor");
  if (provider_actor !== action.expected_provider_actor) fail("provider observation.provider_actor", "does not match the expected provider actor");
  const state = entry.state as "merged" | "queued";
  return Object.freeze({ schema_version: "1.0" as const, operation: "merge-change" as const, binding: structuredClone(action.binding), repository: structuredClone(action.repository), intent: structuredClone(action.intent), provider: { kind: "github" as const, configuration_id: action.provider.configuration_id, adapter: "github-gh-cli" as const }, assignment_actor: action.assignment_actor, provider_actor, state, ...(merge_sha ? { merge_sha } : {}), ...(queue_entry ? { queue_entry } : {}), observed_at });
}
