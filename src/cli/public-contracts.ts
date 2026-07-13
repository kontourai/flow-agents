export const WORKFLOW_CRITIQUE_STATUSES = ["pass", "fail", "not_verified"] as const;

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

export const PUBLIC_OPERATION_CONTRACTS = {
  [PUBLISH_CHANGE_OPERATION]: PUBLISH_CHANGE_OPERATION_PROTOCOL,
} as const;

export const PUBLIC_OPERATION_IDS = new Set<string>(Object.keys(PUBLIC_OPERATION_CONTRACTS));
