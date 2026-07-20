export const WORKFLOW_CRITIQUE_STATUSES = ["pass", "fail", "not_verified"] as const;
export const WORKFLOW_ACCEPTANCE_STATUSES = ["pending", "pass", "fail", "not_verified", "accepted_gap"] as const;

export const EVIDENCE_REF_KINDS = ["source", "command", "artifact", "provider", "external"] as const;
export const EVIDENCE_REF_FIELD_SCHEMAS = {
  kind: { type: "string", enum: EVIDENCE_REF_KINDS },
  url: { type: "string", minLength: 1 },
  file: { type: "string", minLength: 1 },
  line_start: { type: "integer", minimum: 1 },
  line_end: { type: "integer", minimum: 1 },
  excerpt: { type: "string", minLength: 1 },
  summary: { type: "string", minLength: 1 },
} as const;

export const EVIDENCE_REF_RULES = {
  source: [{ mode: "all", fields: ["file", "line_start", "line_end", "excerpt"] }],
  artifact: [
    { mode: "any", fields: ["file", "url"] },
    { mode: "any", fields: ["summary", "excerpt"] },
  ],
  command: [{ mode: "any", fields: ["summary", "excerpt", "url"] }],
  provider: [{ mode: "all", fields: ["url"] }],
  external: [{ mode: "all", fields: ["url"] }],
} as const;

function evidenceRuleSchema(kind: keyof typeof EVIDENCE_REF_RULES): Record<string, unknown> {
  const clauses = EVIDENCE_REF_RULES[kind].map((clause) => clause.mode === "all"
    ? { required: [...clause.fields] }
    : { anyOf: clause.fields.map((field) => ({ required: [field] })) });
  return {
    if: { properties: { kind: { const: kind } }, required: ["kind"] },
    then: clauses.length === 1 ? clauses[0] : { allOf: clauses },
  };
}

export const EVIDENCE_REF_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: EVIDENCE_REF_FIELD_SCHEMAS,
  allOf: EVIDENCE_REF_KINDS.map((kind) => evidenceRuleSchema(kind)),
  examples: [
    { kind: "artifact", file: "<project-relative-artifact-path>", summary: "<what this artifact proves>" },
    { kind: "command", summary: "<command result and what it proves>" },
  ],
} as const;

export const WORKFLOW_EVIDENCE_PARAMETERS = [
  { name: "status", flag: "--status", required: true, allowed_values: ["pass", "fail", "not_verified"] },
  { name: "summary", flag: "--summary", required: true },
  { name: "evidence_ref_json", flag: "--evidence-ref-json", required: true, repeatable: true, value_schema_ref: "#/public_interfaces/schemas/evidence_ref_json" },
  { name: "route_reason", flag: "--route-reason", required: false },
  { name: "criterion_json", flag: "--criterion-json", required: false, repeatable: true },
  { name: "accepted_gap_reason", flag: "--accepted-gap-reason", required: false },
  { name: "waived_by", flag: "--waived-by", required: false },
  { name: "command", flag: "--command", required: false, repeatable: true },
] as const;

export const WORKFLOW_CRITIQUE_PARAMETERS = [
  { name: "id", flag: "--id", required: false },
  { name: "verdict", flag: "--verdict", required: true, allowed_values: WORKFLOW_CRITIQUE_STATUSES },
  { name: "summary", flag: "--summary", required: true },
  { name: "lane_json", flag: "--lane-json", required: true, repeatable: true },
  { name: "artifact_ref", flag: "--artifact-ref", required: false, repeatable: true, required_when: { parameter: "verdict", equals: "pass" } },
  { name: "finding_json", flag: "--finding-json", required: false, repeatable: true },
  { name: "timestamp", flag: "--timestamp", required: false },
] as const;

export const PUBLISH_CHANGE_OPERATION = "publish-change" as const;

/** Provider-neutral capabilities required to create and authenticate a change record. */
export const CHANGE_PROVIDER_CAPABILITIES = ["change.create", "change.observe"] as const;
export type ChangeProviderCapability = (typeof CHANGE_PROVIDER_CAPABILITIES)[number];

export type ChangeProviderSettings = {
  role: "ChangeProvider";
  kind: "github";
  repository: { owner: string; name: string; url?: string };
  capabilities: ChangeProviderCapability[];
  executor: "gh-cli";
};

export type ChangeProviderSupport =
  | { status: "unconfigured"; reason: "change_provider_not_configured" }
  | { status: "unsupported"; reason: string }
  | { status: "configured"; provider: ChangeProviderSettings };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/**
 * This deliberately accepts configuration only. Authentication is delegated to
 * the adapter process and must never be represented in settings or artifacts.
 */
export function resolveChangeProviderSupport(value: unknown): ChangeProviderSupport {
  if (value === undefined || value === null) return { status: "unconfigured", reason: "change_provider_not_configured" };
  if (!isRecord(value)) return { status: "unsupported", reason: "change_provider_must_be_an_object" };
  if (value.role !== "ChangeProvider") return { status: "unsupported", reason: "change_provider_role_must_be_ChangeProvider" };
  if (value.kind !== "github") return { status: "unsupported", reason: "unsupported_change_provider_kind" };
  if (value.executor !== "gh-cli") return { status: "unsupported", reason: "unsupported_change_provider_executor" };
  if (!hasOnlyKeys(value, ["role", "kind", "repository", "capabilities", "executor"]) || !isRecord(value.repository)
    || !hasOnlyKeys(value.repository, ["owner", "name", "url"]) || !boundedString(value.repository.owner, 255) || !boundedString(value.repository.name, 255)
    || (value.repository.url !== undefined && !boundedString(value.repository.url, 8_192))) {
    return { status: "unsupported", reason: "change_provider_repository_is_invalid" };
  }
  const capabilities = value.capabilities;
  if (!Array.isArray(capabilities)
    || capabilities.some((capability) => !(CHANGE_PROVIDER_CAPABILITIES as readonly string[]).includes(String(capability)))
    || CHANGE_PROVIDER_CAPABILITIES.some((capability) => !capabilities.includes(capability))) {
    return { status: "unsupported", reason: "change_provider_capabilities_are_incomplete" };
  }
  return { status: "configured", provider: structuredClone(value) as ChangeProviderSettings };
}

export type PublishChangeActionBinding = {
  run_id: string;
  definition_id: string;
  definition_version: string;
  step_id: string;
  gate_ids: string[];
  gate_visit_id: string;
};

const PUBLISH_CHANGE_PARAMETERS = [
  { name: "session_dir", flag: "--session-dir", required: true, type: "string", max_length: 4_096 },
  { name: "title", flag: "--title", required: true, type: "string", max_length: 512 },
  { name: "body", flag: "--body", required: true, type: "string", max_length: 65_536 },
  { name: "head_ref", flag: "--head-ref", required: true, type: "string", max_length: 255 },
  { name: "base_ref", flag: "--base-ref", required: true, type: "string", max_length: 255 },
  { name: "draft", flag: "--draft", required: false, type: "boolean" },
] as const;

export const PUBLISH_CHANGE_OPERATION_PROTOCOL = {
  schema_version: "1.0",
  operation: PUBLISH_CHANGE_OPERATION,
  kind: "provider_capability",
  capability: "change.create",
  parameters: PUBLISH_CHANGE_PARAMETERS,
  request: {
    required: ["schema_version", "operation", "binding", "repository", "base_ref", "head_ref", "head_sha", "intent", "assignment_actor", "provider"],
    properties: {
      schema_version: { const: "1.0" },
      operation: { const: PUBLISH_CHANGE_OPERATION },
      binding: { required: ["run_id", "definition_id", "definition_version", "step_id", "gate_ids", "gate_visit_id"] },
      repository: { required: ["owner", "name"] },
      base_ref: { type: "string", max_length: 255 },
      head_ref: { type: "string", max_length: 255 },
      head_sha: { type: "string", pattern: "^[0-9a-f]{40,64}$" },
      intent: { required: ["title", "body"] },
      assignment_actor: { type: "string", max_length: 512 },
      provider: { required: ["kind", "configuration_id"] },
    },
  },
  result: {
    max_bytes: 65_536,
    required: ["schema_version", "operation", "binding", "provider", "repository", "change_ref", "assignment_actor", "provider_actor", "observed_at"],
    properties: {
      schema_version: { const: "1.0" },
      operation: { const: PUBLISH_CHANGE_OPERATION },
      binding: { required: ["run_id", "definition_id", "definition_version", "step_id", "gate_ids", "gate_visit_id"] },
      provider: { required: ["kind", "configuration_id", "adapter"] },
      repository: { required: ["owner", "name"] },
      change_ref: {
        required: ["provider_record_id", "number", "url", "state", "base_ref", "head_ref", "head_sha"],
        properties: {
          provider_record_id: { type: "string", max_length: 1_024 },
          number: { type: "integer", minimum: 1 },
          url: { type: "string", max_length: 8_192 },
          state: { enum: ["open", "merged"] },
          base_ref: { type: "string", max_length: 255 },
          head_ref: { type: "string", max_length: 255 },
          head_sha: { type: "string", pattern: "^[0-9a-f]{40,64}$" },
        },
      },
      assignment_actor: { type: "string", max_length: 512 },
      provider_actor: { type: "string", max_length: 512 },
      observed_at: { type: "string", format: "date-time", max_length: 64 },
    },
    url_protocols: ["https:"],
    persist_as: "publish-change.result.json",
  },
  availability: {
    status: "external_capability_required",
    configuration_status: "unconfigured",
    executable_by_flow_agents: false,
    completion_verification: "authenticated_change_provider_required",
  },
} as const;

export type PublishChangeOperationProtocol = typeof PUBLISH_CHANGE_OPERATION_PROTOCOL | ReturnType<typeof configuredPublishChangeOperationProtocol> | ReturnType<typeof unsupportedPublishChangeOperationProtocol>;

function configuredPublishChangeOperationProtocol(provider: ChangeProviderSettings) {
  return {
    ...PUBLISH_CHANGE_OPERATION_PROTOCOL,
    availability: {
      status: "configured",
      configuration_status: "configured",
      executable_by_flow_agents: true,
      command: ["publish-change", "execute", "--session-dir", "<session-dir>"],
      completion_verification: "authenticated_change_provider_required",
      provider: { kind: provider.kind, repository: structuredClone(provider.repository) },
    },
  } as const;
}

function unsupportedPublishChangeOperationProtocol(reason: string) {
  return {
    ...PUBLISH_CHANGE_OPERATION_PROTOCOL,
    availability: { ...PUBLISH_CHANGE_OPERATION_PROTOCOL.availability, configuration_status: "unsupported", reason },
  } as const;
}

export function publishChangeOperationProtocol(changeProvider?: unknown): PublishChangeOperationProtocol {
  const support = resolveChangeProviderSupport(changeProvider);
  if (support.status === "configured") return configuredPublishChangeOperationProtocol(support.provider);
  if (support.status === "unsupported") return unsupportedPublishChangeOperationProtocol(support.reason);
  return structuredClone(PUBLISH_CHANGE_OPERATION_PROTOCOL);
}

export const NARRATIVE_PROMOTE_OPERATION = "narrative.promote" as const;

export const NARRATIVE_PROMOTE_OPERATION_PROTOCOL = {
  schema_version: "1.0",
  operation: NARRATIVE_PROMOTE_OPERATION,
  kind: "provider_capability",
  capability: NARRATIVE_PROMOTE_OPERATION,
  parameters: [
    { name: "narrative_id", required: true, type: "string", max_length: 255 },
    { name: "envelope_sha256", required: true, type: "string", pattern: "^[a-f0-9]{64}$" },
  ],
  result: {
    required: ["provider", "completion_id", "evidence"],
    properties: {
      provider: { type: "string", max_length: 128 },
      completion_id: { type: "string", max_length: 1_024 },
      evidence: { type: "object" },
    },
    persist_as: "evidence",
  },
  availability: {
    status: "external_capability_required",
    executable_by_flow_agents: false,
    direct_write_allowed: false,
    completion_verification: "authenticated_narrative_provider_required",
  },
} as const;

export const PUBLIC_OPERATION_CONTRACTS = {
  [PUBLISH_CHANGE_OPERATION]: PUBLISH_CHANGE_OPERATION_PROTOCOL,
  [NARRATIVE_PROMOTE_OPERATION]: NARRATIVE_PROMOTE_OPERATION_PROTOCOL,
} as const;

export function publicOperationContracts(changeProvider?: unknown): Record<typeof PUBLISH_CHANGE_OPERATION, PublishChangeOperationProtocol> {
  return { [PUBLISH_CHANGE_OPERATION]: publishChangeOperationProtocol(changeProvider) };
}

export const PUBLIC_OPERATION_IDS = new Set<string>(Object.keys(PUBLIC_OPERATION_CONTRACTS));
