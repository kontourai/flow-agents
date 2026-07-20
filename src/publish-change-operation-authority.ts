import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ChangeProviderSettings, PublishChangeActionBinding } from "./cli/public-contracts.js";

export type PublishChangeIntent = {
  title: string;
  body: string;
  draft?: boolean;
  base_ref: string;
  head_ref: string;
  head_sha: string;
};

export type PublishChangeRepository = { owner: string; name: string };

export type PublishChangeRequest = {
  schema_version: "1.0";
  operation: "publish-change";
  binding: PublishChangeActionBinding;
  repository: PublishChangeRepository;
  base_ref: string;
  head_ref: string;
  head_sha: string;
  intent: { title: string; body: string; draft?: boolean };
  assignment_actor: string;
  provider: { kind: "github"; configuration_id: string };
};

export type IssuedPublishChangeAction = PublishChangeRequest & {
  action_id: string;
};

export type AuthenticatedPublishChangeObservation = {
  schema_version: "1.0";
  operation: "publish-change";
  binding: PublishChangeActionBinding;
  provider: { kind: "github"; configuration_id: string; adapter: string };
  repository: PublishChangeRepository;
  change_ref: {
    provider_record_id: string;
    number: number;
    url: string;
    state: "open" | "merged";
    base_ref: string;
    head_ref: string;
    head_sha: string;
  };
  assignment_actor: string;
  provider_actor: string;
  observed_at: string;
};

const MAX_TITLE = 512;
const MAX_BODY = 65_536;
const MAX_REF = 255;
const MAX_ID = 1_024;

function fail(field: string, reason: string): never {
  throw new Error(`publish-change operation authority rejected ${field}: ${reason}`);
}

function bounded(value: unknown, max: number, field: string, allowLineFeed = false): string {
  const forbidden = allowLineFeed ? /[\u0000-\u0009\u000b-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > max || forbidden.test(value)) fail(field, `must be a non-empty bounded string (max ${max})`);
  return value;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function repository(value: unknown): PublishChangeRepository {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("repository", "must be an object");
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).length !== 2 || !("owner" in entry) || !("name" in entry)) fail("repository", "must contain only owner and name");
  return { owner: bounded(entry.owner, 255, "repository.owner"), name: bounded(entry.name, 255, "repository.name") };
}

function binding(value: unknown): PublishChangeActionBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("binding", "must be an object");
  const entry = value as Record<string, unknown>;
  const keys = ["run_id", "definition_id", "definition_version", "step_id", "gate_ids", "gate_visit_id"];
  if (Object.keys(entry).length !== keys.length || !keys.every((key) => key in entry)) fail("binding", "has an unexpected shape");
  if (!Array.isArray(entry.gate_ids) || entry.gate_ids.length !== 1 || entry.gate_ids.some((id) => typeof id !== "string" || id.length === 0 || id.length > 255)) fail("binding.gate_ids", "must contain exactly one bounded gate id");
  const output = {
    run_id: bounded(entry.run_id, 255, "binding.run_id"),
    definition_id: bounded(entry.definition_id, 255, "binding.definition_id"),
    definition_version: bounded(entry.definition_version, 255, "binding.definition_version"),
    step_id: bounded(entry.step_id, 255, "binding.step_id"),
    gate_ids: [...entry.gate_ids] as string[],
    gate_visit_id: bounded(entry.gate_visit_id, 64, "binding.gate_visit_id"),
  };
  if (!/^[a-f0-9]{64}$/.test(output.gate_visit_id)) fail("binding.gate_visit_id", "must be a SHA-256 identity");
  return output;
}

export function publishChangeProviderConfigurationId(provider: ChangeProviderSettings): string {
  return sha256({ kind: provider.kind, repository: provider.repository, capabilities: [...provider.capabilities].sort(), executor: provider.executor });
}

/**
 * Produce the opaque identity that the private completion path re-derives under
 * the subject lock. It is intentionally deterministic: a provider success followed
 * by a local crash can be observed again without creating a second operation identity.
 */
export function issuePublishChangeAction(input: {
  binding: PublishChangeActionBinding;
  provider: ChangeProviderSettings;
  assignment_actor: string;
  intent: PublishChangeIntent;
}): IssuedPublishChangeAction {
  const canonicalBinding = binding(input.binding);
  const configuredRepository = repository(input.provider.repository);
  const assignmentActor = bounded(input.assignment_actor, 512, "assignment_actor");
  const request: PublishChangeRequest = {
    schema_version: "1.0",
    operation: "publish-change",
    binding: canonicalBinding,
    repository: configuredRepository,
    base_ref: bounded(input.intent.base_ref, MAX_REF, "base_ref"),
    head_ref: bounded(input.intent.head_ref, MAX_REF, "head_ref"),
    head_sha: bounded(input.intent.head_sha, 64, "head_sha"),
    intent: {
      title: bounded(input.intent.title, MAX_TITLE, "intent.title"),
      body: bounded(input.intent.body, MAX_BODY, "intent.body", true),
      ...(input.intent.draft === undefined ? {} : typeof input.intent.draft === "boolean" ? { draft: input.intent.draft } : fail("intent.draft", "must be a boolean")),
    },
    assignment_actor: assignmentActor,
    provider: { kind: input.provider.kind, configuration_id: publishChangeProviderConfigurationId(input.provider) },
  };
  if (!/^[a-f0-9]{40,64}$/.test(request.head_sha)) fail("head_sha", "must be an immutable lowercase commit SHA");
  return { ...request, action_id: sha256(request) };
}

export function assertIssuedPublishChangeAction(value: unknown): IssuedPublishChangeAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("action", "must be an object");
  const action = value as Record<string, unknown>;
  const keys = ["schema_version", "operation", "binding", "repository", "base_ref", "head_ref", "head_sha", "intent", "assignment_actor", "provider", "action_id"];
  if (Object.keys(action).length !== keys.length || !keys.every((key) => key in action)) fail("action", "has an unexpected shape");
  if (action.schema_version !== "1.0" || action.operation !== "publish-change") fail("action", "has an unsupported protocol");
  if (!action.intent || typeof action.intent !== "object" || Array.isArray(action.intent)
    || ![2, 3].includes(Object.keys(action.intent as object).length)
    || !["title", "body", "draft"].every((key) => key === "draft" ? true : key in (action.intent as object))
    || Object.keys(action.intent as object).some((key) => !["title", "body", "draft"].includes(key))) fail("action.intent", "has an unexpected shape");
  if (!action.provider || typeof action.provider !== "object" || Array.isArray(action.provider) || Object.keys(action.provider as object).length !== 2) fail("action.provider", "has an unexpected shape");
  const provider = action.provider as Record<string, unknown>;
  if (provider.kind !== "github") fail("action.provider.kind", "is unsupported");
  const headSha = bounded(action.head_sha, 64, "action.head_sha");
  if (!/^[a-f0-9]{40,64}$/.test(headSha)) fail("action.head_sha", "must be an immutable lowercase commit SHA");
  // The configuration digest is recomputed by the Flow runtime against its effective
  // configuration. Here we only ensure it has the expected bounded representation.
  const configurationId = bounded(provider.configuration_id, 64, "action.provider.configuration_id");
  if (!/^[a-f0-9]{64}$/.test(configurationId)) fail("action.provider.configuration_id", "must be a SHA-256 identity");
  const candidate: PublishChangeRequest = {
    schema_version: "1.0",
    operation: "publish-change",
    binding: binding(action.binding),
    repository: repository(action.repository),
    base_ref: bounded(action.base_ref, MAX_REF, "action.base_ref"),
    head_ref: bounded(action.head_ref, MAX_REF, "action.head_ref"),
    head_sha: headSha,
    intent: {
      title: bounded((action.intent as Record<string, unknown>).title, MAX_TITLE, "action.intent.title"),
      body: bounded((action.intent as Record<string, unknown>).body, MAX_BODY, "action.intent.body", true),
      ...((action.intent as Record<string, unknown>).draft === undefined ? {} : typeof (action.intent as Record<string, unknown>).draft === "boolean" ? { draft: (action.intent as Record<string, unknown>).draft as boolean } : fail("action.intent.draft", "must be a boolean")),
    },
    assignment_actor: bounded(action.assignment_actor, 512, "action.assignment_actor"),
    provider: { kind: "github", configuration_id: configurationId },
  };
  const actionId = bounded(action.action_id, 64, "action.action_id");
  if (!/^[a-f0-9]{64}$/.test(actionId) || actionId !== sha256(candidate)) fail("action.action_id", "does not match the bound request");
  return { ...candidate, action_id: actionId };
}

export function assertAuthenticatedPublishChangeObservation(action: IssuedPublishChangeAction, value: unknown): AuthenticatedPublishChangeObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("provider observation", "must be an object returned by the authenticated provider adapter");
  const observation = value as Record<string, unknown>;
  const keys = ["schema_version", "operation", "binding", "provider", "repository", "change_ref", "assignment_actor", "provider_actor", "observed_at"];
  if (Object.keys(observation).length !== keys.length || !keys.every((key) => key in observation)) fail("provider observation", "has an unexpected shape");
  if (observation.schema_version !== "1.0" || observation.operation !== "publish-change") fail("provider observation", "has an unsupported protocol");
  if (!isDeepStrictEqual(binding(observation.binding), action.binding)) fail("provider observation.binding", "does not match the issued action");
  if (!isDeepStrictEqual(repository(observation.repository), action.repository)) fail("provider observation.repository", "does not match the issued action");
  if (bounded(observation.assignment_actor, 512, "provider observation.assignment_actor") !== action.assignment_actor) fail("provider observation.assignment_actor", "does not match the issued action");
  const providerActor = bounded(observation.provider_actor, 512, "provider observation.provider_actor");
  if (!observation.provider || typeof observation.provider !== "object" || Array.isArray(observation.provider)) fail("provider observation.provider", "must be an object");
  const provider = observation.provider as Record<string, unknown>;
  if (Object.keys(provider).length !== 3 || provider.kind !== action.provider.kind || bounded(provider.configuration_id, 64, "provider observation.provider.configuration_id") !== action.provider.configuration_id) fail("provider observation.provider", "does not match the issued action");
  const adapter = bounded(provider.adapter, 255, "provider observation.provider.adapter");
  if (!observation.change_ref || typeof observation.change_ref !== "object" || Array.isArray(observation.change_ref)) fail("provider observation.change_ref", "must be an object");
  const change = observation.change_ref as Record<string, unknown>;
  const changeKeys = ["provider_record_id", "number", "url", "state", "base_ref", "head_ref", "head_sha"];
  if (Object.keys(change).length !== changeKeys.length || !changeKeys.every((key) => key in change)) fail("provider observation.change_ref", "has an unexpected shape");
  if ((change.state !== "open" && change.state !== "merged") || change.base_ref !== action.base_ref || change.head_ref !== action.head_ref || change.head_sha !== action.head_sha) fail("provider observation.change_ref", "does not match the issued base/head/published-state binding");
  if (!Number.isSafeInteger(change.number) || (change.number as number) < 1) fail("provider observation.change_ref.number", "must be a positive safe integer");
  const url = bounded(change.url, 8_192, "provider observation.change_ref.url");
  try { if (new URL(url).protocol !== "https:") fail("provider observation.change_ref.url", "must use https"); } catch { fail("provider observation.change_ref.url", "must be a valid https URL"); }
  const observedAt = bounded(observation.observed_at, 64, "provider observation.observed_at");
  if (!Number.isFinite(Date.parse(observedAt))) fail("provider observation.observed_at", "must be an ISO timestamp");
  return {
    schema_version: "1.0", operation: "publish-change", binding: structuredClone(action.binding), provider: { kind: "github", configuration_id: action.provider.configuration_id, adapter }, repository: structuredClone(action.repository),
    change_ref: { provider_record_id: bounded(change.provider_record_id, MAX_ID, "provider observation.change_ref.provider_record_id"), number: change.number as number, url, state: change.state, base_ref: action.base_ref, head_ref: action.head_ref, head_sha: action.head_sha }, assignment_actor: action.assignment_actor, provider_actor: providerActor, observed_at: observedAt,
  };
}
