import type { ChangeProviderSettings, PublishChangeActionBinding } from "./public-contracts.js";

export const CHANGE_PROVIDER_REQUEST_SCHEMA_VERSION = "1.0" as const;
export const CHANGE_PROVIDER_RESULT_SCHEMA_VERSION = "1.0" as const;

const MAX_TITLE_BYTES = 512;
const MAX_BODY_BYTES = 65_536;
const MAX_REF_BYTES = 255;
const MAX_SHA_BYTES = 64;
const MAX_ACTOR_BYTES = 512;
const MAX_CONFIGURATION_ID_BYTES = 1_024;
const MAX_URL_BYTES = 8_192;
const MAX_RECORD_ID_BYTES = 1_024;
const MAX_GATE_IDS = 32;

type PlainObject = Record<string, unknown>;

export type ChangeProviderRequest = Readonly<{
  schema_version: typeof CHANGE_PROVIDER_REQUEST_SCHEMA_VERSION;
  operation: "publish-change";
  binding: Readonly<PublishChangeActionBinding>;
  repository: Readonly<{ owner: string; name: string }>;
  base_ref: string;
  head_ref: string;
  head_sha: string;
  intent: Readonly<{ title: string; body: string; draft?: boolean }>;
  actor: string;
  provider: Readonly<{ kind: "github"; configuration_id: string }>;
}>;

export type ChangeProviderResult = Readonly<{
  schema_version: typeof CHANGE_PROVIDER_RESULT_SCHEMA_VERSION;
  operation: "publish-change";
  binding: Readonly<PublishChangeActionBinding>;
  provider: Readonly<{ kind: "github"; configuration_id: string; adapter: "github-gh-cli" }>;
  repository: Readonly<{ owner: string; name: string }>;
  change_ref: Readonly<{
    provider_record_id: string;
    number: number;
    url: string;
    state: "open";
    base_ref: string;
    head_ref: string;
    head_sha: string;
  }>;
  actor: string;
  observed_at: string;
}>;

export type ChangeProviderCapability = Readonly<{ actor: string }>;

export interface ChangeProvider {
  readonly kind: ChangeProviderSettings["kind"];
  checkCapability(): Promise<ChangeProviderCapability>;
  createOrRecover(request: ChangeProviderRequest): Promise<ChangeProviderResult>;
}

export type ChangeProviderErrorCode =
  | "invalid_request"
  | "provider_unavailable"
  | "provider_auth_failed"
  | "provider_failure"
  | "malformed_provider_output"
  | "oversized_provider_output"
  | "ambiguous_provider_change"
  | "provider_observation_mismatch";

/**
 * Public errors deliberately contain only stable classifications. Provider
 * stderr may include credentials and must never reach artifacts or logs.
 */
export class ChangeProviderError extends Error {
  readonly code: ChangeProviderErrorCode;

  constructor(code: ChangeProviderErrorCode, message: string) {
    super(message);
    this.name = "ChangeProviderError";
    this.code = code;
  }
}

export function parseChangeProviderRequest(value: unknown): ChangeProviderRequest {
  const root = plainObject(value, "request");
  exactKeys(root, ["schema_version", "operation", "binding", "repository", "base_ref", "head_ref", "head_sha", "intent", "actor", "provider"], "request");
  if (root.schema_version !== CHANGE_PROVIDER_REQUEST_SCHEMA_VERSION) invalid("request.schema_version must be 1.0");
  if (root.operation !== "publish-change") invalid("request.operation must be publish-change");

  const bindingValue = plainObject(root.binding, "request.binding");
  exactKeys(bindingValue, ["run_id", "definition_id", "definition_version", "step_id", "gate_ids", "gate_visit_id"], "request.binding");
  if (!Array.isArray(bindingValue.gate_ids) || bindingValue.gate_ids.length < 1 || bindingValue.gate_ids.length > MAX_GATE_IDS) {
    invalid(`request.binding.gate_ids must contain 1-${MAX_GATE_IDS} values`);
  }
  const gateIds = bindingValue.gate_ids.map((gateId, index) => boundedString(gateId, `request.binding.gate_ids[${index}]`, MAX_ACTOR_BYTES));
  if (new Set(gateIds).size !== gateIds.length) invalid("request.binding.gate_ids must be unique");
  const binding = immutable({
    run_id: boundedString(bindingValue.run_id, "request.binding.run_id", MAX_ACTOR_BYTES),
    definition_id: boundedString(bindingValue.definition_id, "request.binding.definition_id", MAX_ACTOR_BYTES),
    definition_version: boundedString(bindingValue.definition_version, "request.binding.definition_version", 128),
    step_id: boundedString(bindingValue.step_id, "request.binding.step_id", MAX_ACTOR_BYTES),
    gate_ids: immutable(gateIds),
    gate_visit_id: boundedString(bindingValue.gate_visit_id, "request.binding.gate_visit_id", MAX_ACTOR_BYTES),
  });

  const repositoryValue = plainObject(root.repository, "request.repository");
  exactKeys(repositoryValue, ["owner", "name"], "request.repository");
  const repository = immutable({
    owner: repositoryPart(repositoryValue.owner, "request.repository.owner"),
    name: repositoryPart(repositoryValue.name, "request.repository.name"),
  });

  const intentValue = plainObject(root.intent, "request.intent");
  exactKeys(intentValue, intentValue.draft === undefined ? ["title", "body"] : ["title", "body", "draft"], "request.intent");
  if (intentValue.draft !== undefined && typeof intentValue.draft !== "boolean") invalid("request.intent.draft must be a boolean");
  const intent = immutable({
    title: boundedString(intentValue.title, "request.intent.title", MAX_TITLE_BYTES),
    body: boundedString(intentValue.body, "request.intent.body", MAX_BODY_BYTES, true),
    ...(intentValue.draft === undefined ? {} : { draft: intentValue.draft }),
  });

  const providerValue = plainObject(root.provider, "request.provider");
  exactKeys(providerValue, ["kind", "configuration_id"], "request.provider");
  if (providerValue.kind !== "github") invalid("request.provider.kind must be github");
  const provider = immutable({
    kind: "github" as const,
    configuration_id: boundedString(providerValue.configuration_id, "request.provider.configuration_id", MAX_CONFIGURATION_ID_BYTES),
  });

  return immutable({
    schema_version: CHANGE_PROVIDER_REQUEST_SCHEMA_VERSION,
    operation: "publish-change" as const,
    binding,
    repository,
    base_ref: gitRef(root.base_ref, "request.base_ref"),
    head_ref: gitRef(root.head_ref, "request.head_ref"),
    head_sha: gitSha(root.head_sha, "request.head_sha"),
    intent,
    actor: boundedString(root.actor, "request.actor", MAX_ACTOR_BYTES),
    provider,
  });
}

export function assertRequestMatchesProvider(request: ChangeProviderRequest, provider: ChangeProviderSettings, configurationId: string): void {
  if (request.provider.kind !== provider.kind || request.provider.configuration_id !== configurationId
    || request.repository.owner !== provider.repository.owner || request.repository.name !== provider.repository.name) {
    throw new ChangeProviderError("provider_observation_mismatch", "provider configuration does not match the canonical request");
  }
}

export function buildChangeProviderResult(input: {
  request: ChangeProviderRequest;
  providerRecord: {
    id: unknown; number: unknown; url: unknown; state: unknown; baseRefName: unknown; headRefName: unknown; headRefOid: unknown;
    title: unknown; body: unknown; isDraft: unknown;
  };
  adapter: "github-gh-cli";
  actor: unknown;
  observedAt: string;
}): ChangeProviderResult {
  const { request, providerRecord } = input;
  const recordId = boundedProviderString(providerRecord.id, "provider record id", MAX_RECORD_ID_BYTES);
  const number = positiveInteger(providerRecord.number, "provider record number");
  const url = httpsUrl(providerRecord.url);
  const state = boundedProviderString(providerRecord.state, "provider record state", 16).toLowerCase();
  const baseRef = gitRefFromProvider(providerRecord.baseRefName, "provider record base ref");
  const headRef = gitRefFromProvider(providerRecord.headRefName, "provider record head ref");
  const headSha = gitShaFromProvider(providerRecord.headRefOid, "provider record head SHA");
  if (state !== "open" || baseRef !== request.base_ref || headRef !== request.head_ref || headSha !== request.head_sha) {
    throw new ChangeProviderError("provider_observation_mismatch", "provider observation does not match the canonical request");
  }
  const title = boundedProviderString(providerRecord.title, "provider record title", MAX_TITLE_BYTES);
  const body = boundedProviderString(providerRecord.body, "provider record body", MAX_BODY_BYTES);
  const isDraft = providerRecord.isDraft;
  if (title !== request.intent.title || body !== request.intent.body || typeof isDraft !== "boolean" || isDraft !== Boolean(request.intent.draft)) {
    throw new ChangeProviderError("provider_observation_mismatch", "provider observation does not match the canonical change intent");
  }
  const observedAt = boundedProviderString(input.observedAt, "provider observation time", 64);
  if (!Number.isFinite(Date.parse(observedAt))) {
    throw new ChangeProviderError("provider_observation_mismatch", "provider observation time is invalid");
  }
  return immutable({
    schema_version: CHANGE_PROVIDER_RESULT_SCHEMA_VERSION,
    operation: "publish-change" as const,
    binding: immutable({ ...request.binding, gate_ids: immutable([...request.binding.gate_ids]) }),
    provider: immutable({ kind: "github" as const, configuration_id: request.provider.configuration_id, adapter: input.adapter }),
    repository: immutable({ ...request.repository }),
    change_ref: immutable({ provider_record_id: recordId, number, url, state: "open" as const, base_ref: baseRef, head_ref: headRef, head_sha: headSha }),
    actor: boundedProviderString(input.actor, "authenticated provider actor", MAX_ACTOR_BYTES),
    observed_at: observedAt,
  });
}

function plainObject(value: unknown, field: string): PlainObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${field} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${field} must be a plain object`);
  return value as PlainObject;
}

function exactKeys(value: PlainObject, expected: string[], field: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) invalid(`${field} contains unsupported or missing fields`);
}

function boundedString(value: unknown, field: string, maxBytes: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.includes("\0") || /\r/u.test(value) || (!allowEmpty && (value.length === 0 || value !== value.trim())) || Buffer.byteLength(value, "utf8") > maxBytes) {
    invalid(`${field} is invalid`);
  }
  return value;
}

function boundedProviderString(value: unknown, field: string, maxBytes: number, allowEmpty = false): string {
  try {
    return boundedString(value, field, maxBytes, allowEmpty);
  } catch {
    throw new ChangeProviderError("provider_observation_mismatch", `${field} is invalid`);
  }
}

function repositoryPart(value: unknown, field: string): string {
  const part = boundedString(value, field, 255);
  if (!/^[A-Za-z0-9_.-]+$/u.test(part)) invalid(`${field} is invalid`);
  return part;
}

function gitRef(value: unknown, field: string): string {
  const ref = boundedString(value, field, MAX_REF_BYTES);
  if (ref.startsWith("-") || ref.startsWith("/") || ref.endsWith("/") || ref.includes("..") || ref.includes("@{") || /[~^:?*[\\\s\x00-\x1f\x7f]/u.test(ref)) invalid(`${field} is invalid`);
  return ref;
}

function gitRefFromProvider(value: unknown, field: string): string {
  try {
    return gitRef(value, field);
  } catch {
    throw new ChangeProviderError("provider_observation_mismatch", `${field} is invalid`);
  }
}

function gitSha(value: unknown, field: string): string {
  const sha = boundedString(value, field, MAX_SHA_BYTES).toLowerCase();
  if (!/^[0-9a-f]{40,64}$/u.test(sha)) invalid(`${field} is invalid`);
  return sha;
}

function gitShaFromProvider(value: unknown, field: string): string {
  try {
    return gitSha(value, field);
  } catch {
    throw new ChangeProviderError("provider_observation_mismatch", `${field} is invalid`);
  }
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new ChangeProviderError("provider_observation_mismatch", `${field} is invalid`);
  return Number(value);
}

function httpsUrl(value: unknown): string {
  const text = boundedProviderString(value, "provider record URL", MAX_URL_BYTES);
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("invalid URL");
    return url.href;
  } catch {
    throw new ChangeProviderError("provider_observation_mismatch", "provider record URL is invalid");
  }
}

function invalid(message: string): never {
  throw new ChangeProviderError("invalid_request", message);
}

function immutable<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) immutable(nested);
  return Object.freeze(value);
}
