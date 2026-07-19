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

export const PUBLISH_CHANGE_OPERATION_PROTOCOL = {
  schema_version: "1.0",
  operation: PUBLISH_CHANGE_OPERATION,
  kind: "provider_capability",
  capability: "pull_request.create",
  parameters: [
    { name: "title", required: true, type: "string", max_length: 512 },
    { name: "body", required: true, type: "string", max_length: 65_536 },
    { name: "head_ref", required: true, type: "string", max_length: 255 },
    { name: "base_ref", required: true, type: "string", max_length: 255 },
    { name: "draft", required: false, type: "boolean" },
  ],
  result: {
    required: ["provider", "repository", "number", "url", "head_ref", "base_ref"],
    properties: {
      provider: { type: "string", max_length: 128 },
      repository: { type: "string", max_length: 1_024 },
      number: { type: "integer", minimum: 1 },
      url: { type: "string", max_length: 8_192 },
      head_ref: { type: "string", max_length: 255 },
      base_ref: { type: "string", max_length: 255 },
    },
    url_protocols: ["https:"],
    persist_as: "publish-change.result.json",
  },
  availability: {
    status: "external_capability_required",
    executable_by_flow_agents: false,
    completion_verification: "authenticated_change_provider_required",
  },
} as const;

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

export const PUBLIC_OPERATION_IDS = new Set<string>(Object.keys(PUBLIC_OPERATION_CONTRACTS));
