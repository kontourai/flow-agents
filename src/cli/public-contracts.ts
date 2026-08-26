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

// ─── Accepted-shape derivation (#1358) and one-pass violation collection (#1359) ──────────────
//
// One set of constants, two consumers: `workflow <verb> --explain` renders the accepted shape
// from these, and the sidecar's validators refuse from these. Neither side hand-writes a rule,
// so neither can advertise a shape the other does not enforce. A drift test
// (workflow-explain.test.mjs) binds the two directions executably: every shape --explain prints
// is fed to the real validator and must be accepted, and every clause the validator emits on a
// violation must be the byte-identical clause --explain printed.
//
// Every collector below returns EVERY violation it finds rather than throwing on the first, which
// is the whole of #1359: a caller fixing N problems must not pay N invocations to discover them.

export const EVIDENCE_REF_FIELDS = Object.keys(EVIDENCE_REF_FIELD_SCHEMAS) as ReadonlyArray<keyof typeof EVIDENCE_REF_FIELD_SCHEMAS>;
export const CRITERION_MUTABLE_FIELDS = ["id", "status", "evidence_refs"] as const;
/** The only criterion status a passing tests-evidence claim accepts (`completePassingCriteria`). */
export const PASSING_CRITERION_STATUS = "pass" as const;
export const CRITIQUE_LANE_FIELDS = ["id", "status", "summary", "evidence_refs"] as const;
export const CRITIQUE_LANE_ID_PATTERN = "^[a-z][a-z0-9_-]*$";

type FieldSchema = { type: string; enum?: readonly string[]; minLength?: number; minimum?: number };

/** The human clause for a field schema — the exact words the refusal uses, so help cannot paraphrase. */
export function describeEvidenceRefField(field: string): string {
  const schema = EVIDENCE_REF_FIELD_SCHEMAS[field as keyof typeof EVIDENCE_REF_FIELD_SCHEMAS] as FieldSchema | undefined;
  if (!schema) return "not a supported field";
  if (schema.enum) return `one of: ${schema.enum.join(", ")}`;
  if (schema.type === "integer") return "a positive integer";
  return "a non-empty string";
}

function fieldSatisfiesSchema(field: string, value: unknown): boolean {
  const schema = EVIDENCE_REF_FIELD_SCHEMAS[field as keyof typeof EVIDENCE_REF_FIELD_SCHEMAS] as FieldSchema | undefined;
  if (!schema) return false;
  if (schema.enum) return typeof value === "string" && schema.enum.includes(value);
  if (schema.type === "integer") return Number.isInteger(value) && Number(value) >= (schema.minimum ?? 1);
  return typeof value === "string" && value.length >= (schema.minLength ?? 1);
}

/** The clause text for one `EVIDENCE_REF_RULES` entry: "file, line_start, line_end, and excerpt". */
export function describeEvidenceRefRule(rule: { mode: string; fields: readonly string[] }): string {
  const separator = rule.fields.length > 2 ? ", " : " ";
  const joined = rule.fields.length > 1
    ? `${rule.fields.slice(0, -1).join(separator)}${rule.fields.length > 2 ? "," : ""} or ${rule.fields.at(-1)}`
    : rule.fields[0]!;
  return rule.mode === "all" && rule.fields.length > 1 ? joined.replace(/ or ([^,]+)$/, " and $1") : joined;
}

/**
 * THE REFUSAL BODY TABLE.
 *
 * Round-1 review found the previous design's flaw: `--explain`'s rules were hand-authored strings
 * that RESEMBLED the collector messages. Nine of twenty-six were never emitted verbatim, and a
 * rule added to a collector was invisible to `--explain` because the drift guard only counted
 * `die(` in one function one module away. So the rules are now produced by the SAME functions
 * that emit them: a collector pushes `rule.body` and nothing else, and `--explain` prints exactly
 * the bodies the collectors can produce. Set-equality over a generated corpus is asserted in
 * workflow-explain.test.mjs; it cannot be satisfied by a rule living in the "wrong" function,
 * because the assertion is over emitted OUTPUT, not over source text.
 *
 * A refusal is always `<label> <body>`, where the label identifies the offending object
 * (`--lane-json 0`, `criterion ac-1`, `--evidence-ref-json[2] evidence_refs[0]`). `--explain`
 * prints bodies and says so; it never claims the label is part of the rule.
 */
export type ShapeRule = {
  body: string;
  /** How the rule is enforced — which is also how the drift test proves it is enforced. */
  enforced_by: "object-shape" | "cross-object" | "observed-command";
};

/** Placeholder standing in for a value the body interpolates, so printed and emitted forms match. */
const RULE_VALUE = "<value>";
function canonicalizeInterpolation(body: string): string {
  return body
    .replace(/(contains unsupported fields: ).*$/, `$1${RULE_VALUE}`)
    .replace(/(contain unsupported field: ).*$/, `$1${RULE_VALUE}`)
    .replace(/(exactly once) \(expected: .*$/, "$1");
}
/**
 * The canonical form of an emitted refusal, for comparison against a printed rule: the label is
 * stripped and interpolated values are collapsed. Exported so the drift test cannot use a
 * different notion of "the same rule" than the renderer does.
 */
export function refusalBody(message: string, label: string): string {
  const stripped = message.startsWith(`${label} `) ? message.slice(label.length + 1) : message;
  return canonicalizeInterpolation(stripped);
}

/** Every shape problem with one evidence ref. Empty means the ref satisfies every declared rule. */
export function evidenceRefShapeViolations(ref: Record<string, unknown>, label: string): string[] {
  const violations: string[] = [];
  const kindIsKnown = fieldSatisfiesSchema("kind", ref.kind);
  if (!kindIsKnown) violations.push(`${label} entry kind must be one of: ${EVIDENCE_REF_KINDS.join(", ")}`);
  for (const key of Object.keys(ref)) {
    if (!Object.hasOwn(EVIDENCE_REF_FIELD_SCHEMAS, key)) violations.push(`${label} entries contain unsupported field: ${key}`);
  }
  for (const field of EVIDENCE_REF_FIELDS) {
    if (field === "kind" || ref[field] === undefined) continue;
    if (!fieldSatisfiesSchema(field, ref[field])) violations.push(`${label} entry ${field} must be ${describeEvidenceRefField(field)}`);
  }
  // Clause rules are keyed by kind: an unknown kind selects no clause, so they are skipped rather
  // than reported against an arbitrary kind's requirements.
  if (kindIsKnown) {
    for (const rule of EVIDENCE_REF_RULES[ref.kind as keyof typeof EVIDENCE_REF_RULES]) {
      const satisfied = rule.mode === "all"
        ? rule.fields.every((field) => fieldSatisfiesSchema(field, ref[field]))
        : rule.fields.some((field) => fieldSatisfiesSchema(field, ref[field]));
      if (!satisfied) violations.push(`${label} ${String(ref.kind)} refs require ${describeEvidenceRefRule(rule)}`);
    }
  }
  return violations;
}

/** One candidate entry of an `evidence_refs` array, including "this is not an object at all". */
export function evidenceRefEntryViolations(raw: unknown, label: string): string[] {
  if (typeof raw === "string") return [`${label} entries must be structured evidence reference objects; legacy string refs are not supported`];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [`${label} entries must be objects`];
  return evidenceRefShapeViolations(raw as Record<string, unknown>, label);
}

/** A whole `evidence_refs` array, each violation carrying its own entry index. */
export function evidenceRefListShapeViolations(raw: unknown, label: string): string[] {
  if (!Array.isArray(raw)) return [`${label} must be an array`];
  return raw.flatMap((ref, index) => evidenceRefEntryViolations(ref, `${label}[${index}]`));
}

/** The printable bodies `evidenceRefShapeViolations` + its array wrappers can emit. */
function evidenceRefRuleTable(): ShapeRule[] {
  const object = (body: string): ShapeRule => ({ body, enforced_by: "object-shape" });
  return [
    object(`must be an array`),
    object(`entries must be objects`),
    object(`entries must be structured evidence reference objects; legacy string refs are not supported`),
    object(`entry kind must be one of: ${EVIDENCE_REF_KINDS.join(", ")}`),
    object(`entries contain unsupported field: ${RULE_VALUE}`),
    ...EVIDENCE_REF_FIELDS.filter((field) => field !== "kind").map((field) => object(`entry ${field} must be ${describeEvidenceRefField(field)}`)),
    ...EVIDENCE_REF_KINDS.flatMap((kind) => EVIDENCE_REF_RULES[kind].map((rule) => object(`${kind} refs require ${describeEvidenceRefRule(rule)}`))),
  ];
}

/** "id, status, and evidence_refs" — the prose list form the refusals already used. */
function andList(values: readonly string[]): string {
  return values.length > 1 ? `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}` : values[0] ?? "";
}

/**
 * The fields a criterion's `kind:"command"` ref may carry its command text in, IN PRECEDENCE
 * ORDER. Read by three places that MUST agree: the sidecar's commandFromEvidenceRef (which does
 * the matching), this module's printed rule, and the printed example. Round-1 review caught the
 * example and the rule disagreeing here — #1358's own defect, inside the fix for #1358 — because
 * the example derived its field from EVIDENCE_REF_RULES ("summary" came first) while the rule
 * named `excerpt`. One constant, so they cannot disagree again.
 */
export const CRITERION_COMMAND_MATCH_FIELDS = ["excerpt", "url"] as const;

/** The command text a criterion evidence ref carries, or "" when it carries none. */
export function commandTextFromEvidenceRef(ref: Record<string, unknown>): string {
  for (const field of CRITERION_COMMAND_MATCH_FIELDS) {
    if (typeof ref[field] === "string") return (ref[field] as string).trim();
  }
  return "";
}

/** Shape problems with one `--criterion-json` object, including its nested evidence refs. */
export function criterionShapeViolations(criterion: Record<string, unknown>, id: string): string[] {
  const label = `criterion ${id}`;
  const violations: string[] = [];
  const extras = Object.keys(criterion).filter((key) => !(CRITERION_MUTABLE_FIELDS as readonly string[]).includes(key));
  if (extras.length > 0) violations.push(`${label} may update only ${andList(CRITERION_MUTABLE_FIELDS)}`);
  if (criterion.status !== PASSING_CRITERION_STATUS) violations.push(`${label} must have status ${PASSING_CRITERION_STATUS} for a passing tests-evidence claim`);
  violations.push(...evidenceRefListShapeViolations(criterion.evidence_refs, `${label} evidence_refs`));
  if (Array.isArray(criterion.evidence_refs) && criterion.evidence_refs.length === 0) violations.push(`${label} requires reviewable evidence_refs`);
  return violations;
}

function criterionRuleTable(): ShapeRule[] {
  const object = (body: string): ShapeRule => ({ body, enforced_by: "object-shape" });
  return [
    object(`may update only ${andList(CRITERION_MUTABLE_FIELDS)}`),
    object(`must have status ${PASSING_CRITERION_STATUS} for a passing tests-evidence claim`),
    object(`requires reviewable evidence_refs`),
    { body: `requires a command evidence ref matching a successful observed command`, enforced_by: "observed-command" },
    { body: `command evidence ref must exactly match a successful writer-observed command`, enforced_by: "observed-command" },
    { body: `--criterion-json must cover every declared acceptance criterion exactly once`, enforced_by: "cross-object" },
  ];
}

/** Shape problems with one `--lane-json` object, including its nested evidence refs. */
export function critiqueLaneShapeViolations(lane: Record<string, unknown>, index: number): string[] {
  const label = `--lane-json ${index}`;
  const violations: string[] = [];
  const extras = Object.keys(lane).filter((key) => !(CRITIQUE_LANE_FIELDS as readonly string[]).includes(key));
  if (extras.length > 0) violations.push(`${label} contains unsupported fields: ${extras.join(", ")}`);
  if (!new RegExp(CRITIQUE_LANE_ID_PATTERN).test(String(lane.id ?? ""))) violations.push(`${label} id must be a unique safe identifier matching ${CRITIQUE_LANE_ID_PATTERN}`);
  if (!(WORKFLOW_CRITIQUE_STATUSES as readonly string[]).includes(String(lane.status ?? ""))) violations.push(`${label} status must be one of: ${WORKFLOW_CRITIQUE_STATUSES.join(", ")}`);
  if (typeof lane.summary !== "string" || lane.summary.length === 0) violations.push(`${label} summary must be non-empty`);
  violations.push(...evidenceRefListShapeViolations(lane.evidence_refs, `${label} evidence_refs`));
  if (Array.isArray(lane.evidence_refs) && lane.evidence_refs.length === 0) violations.push(`${label} requires structured reviewable evidence_refs`);
  return violations;
}

function critiqueLaneRuleTable(): ShapeRule[] {
  const object = (body: string): ShapeRule => ({ body, enforced_by: "object-shape" });
  return [
    object(`contains unsupported fields: ${RULE_VALUE}`),
    object(`id must be a unique safe identifier matching ${CRITIQUE_LANE_ID_PATTERN}`),
    object(`status must be one of: ${WORKFLOW_CRITIQUE_STATUSES.join(", ")}`),
    object(`summary must be non-empty`),
    object(`requires structured reviewable evidence_refs`),
    { body: `--lane-json ids must be unique`, enforced_by: "cross-object" },
  ];
}

/**
 * A filled evidence ref of `kind` that satisfies every declared clause for that kind — built by
 * walking EVIDENCE_REF_RULES, never hand-authored, so `--explain`'s example is accepted by
 * construction. `prefer` forces a clause to be satisfied through a specific field when the
 * EMBEDDING context needs that field rather than any acceptable one (a criterion's command ref
 * must carry its command in `excerpt`, not `summary`).
 */
export function exampleEvidenceRef(kind: (typeof EVIDENCE_REF_KINDS)[number], prefer: readonly string[] = []): Record<string, unknown> {
  const placeholders: Record<string, unknown> = {
    url: "https://example.invalid/run/123",
    file: "src/example.ts",
    line_start: 1,
    line_end: 2,
    excerpt: "<verbatim quoted line or the exact command>",
    summary: "<what this reference proves>",
  };
  const example: Record<string, unknown> = { kind };
  for (const rule of EVIDENCE_REF_RULES[kind]) {
    const preferred = rule.mode === "any" ? rule.fields.find((field) => prefer.includes(field)) : undefined;
    const fields = rule.mode === "all" ? rule.fields : [preferred ?? rule.fields[0]!];
    for (const field of fields) example[field] = placeholders[field];
  }
  return example;
}

export function exampleCriterion(): Record<string, unknown> {
  // The command ref is forced onto the field the MATCHER reads, not whichever field the clause
  // happens to list first: an example that the criterion path refuses is the defect this whole
  // change exists to remove.
  const commandRef = exampleEvidenceRef("command", CRITERION_COMMAND_MATCH_FIELDS);
  commandRef[CRITERION_COMMAND_MATCH_FIELDS[0]] = "<the exact --command string, verbatim>";
  return { id: "<declared-acceptance-criterion-id>", status: PASSING_CRITERION_STATUS, evidence_refs: [commandRef] };
}

export function exampleCritiqueLane(): Record<string, unknown> {
  return { id: "correctness", status: WORKFLOW_CRITIQUE_STATUSES[0], summary: "<what this lane reviewed and concluded>", evidence_refs: [exampleEvidenceRef("source")] };
}

export type JsonFlagShape = {
  flag: string;
  description: string;
  /** The refusal bodies this payload's collectors can emit. A refusal is `<label> <body>`. */
  rules: ShapeRule[];
  fields: string[];
  examples: Record<string, unknown>[];
  /** Shape keys this payload nests inside itself, so a verb can explain them without advertising a flag it rejects. */
  embeds: string[];
};

/**
 * The accepted shape of every repeatable JSON flag on the public verbs, derived from the
 * constants above. Keys are flag names without `--`, so a verb can select the shapes it accepts
 * straight from the option set its own `assertOnlyFlags` enforces.
 */
export function publicJsonFlagShapes(): Record<string, JsonFlagShape> {
  return {
    "evidence-ref-json": {
      flag: "--evidence-ref-json",
      description: "One structured evidence reference. Repeat the flag once per reference. `file` is a path relative to the repository root, and a gate-evidence ref must name a file that exists there.",
      rules: evidenceRefRuleTable(),
      fields: [...EVIDENCE_REF_FIELDS],
      examples: EVIDENCE_REF_KINDS.map((kind) => exampleEvidenceRef(kind)),
      embeds: [],
    },
    "criterion-json": {
      flag: "--criterion-json",
      description: `One acceptance-criterion update. A passing tests-evidence claim must cover every declared criterion exactly once, and each criterion needs a kind:"command" ref whose ${CRITERION_COMMAND_MATCH_FIELDS[0]} (or ${CRITERION_COMMAND_MATCH_FIELDS[1]}, when ${CRITERION_COMMAND_MATCH_FIELDS[0]} is absent) equals an observed --command after trimming.`,
      rules: criterionRuleTable(),
      fields: [...CRITERION_MUTABLE_FIELDS],
      examples: [exampleCriterion()],
      embeds: ["evidence-ref-json"],
    },
    "lane-json": {
      flag: "--lane-json",
      description: "One review lane. At least one is required; ids must be unique across lanes.",
      rules: critiqueLaneRuleTable(),
      fields: [...CRITIQUE_LANE_FIELDS],
      examples: [exampleCritiqueLane()],
      embeds: ["evidence-ref-json"],
    },
  };
}

/**
 * FLAG-LEVEL one-pass validation (#1358/#1359, round-2 MEDIUM).
 *
 * The payload one-pass was real but stopped at the payload boundary: `record-critique` still
 * laddered `--verdict` -> `--summary` -> `--lane-json` -> payload, three round-trips before the
 * payload was read at all — the exact burn #1358 names. The requirements were already DATA in
 * WORKFLOW_CRITIQUE_PARAMETERS (`required`, `allowed_values`, `repeatable`, `required_when`);
 * nothing read them. This reads them, so the declaration is the enforcement and `--explain` can
 * print the same table.
 */
export type ParameterSpec = {
  name: string;
  flag: string;
  required?: boolean;
  repeatable?: boolean;
  allowed_values?: readonly string[];
  required_when?: { parameter: string; equals: string };
};

export function parameterViolations(
  parameters: readonly ParameterSpec[],
  valuesFor: (flag: string) => string[],
  subject: string,
): string[] {
  const violations: string[] = [];
  const byName = new Map(parameters.map((parameter) => [parameter.name, parameter]));
  for (const parameter of parameters) {
    const values = valuesFor(parameter.flag);
    const supplied = values.filter((value) => value.length > 0);
    if (parameter.required && supplied.length === 0) {
      violations.push(parameter.repeatable
        ? `${subject} requires at least one ${parameter.flag}`
        : `${subject} requires ${parameter.flag}`);
    }
    if (parameter.allowed_values) {
      for (const value of supplied) {
        if (!parameter.allowed_values.includes(value)) {
          violations.push(`${subject} ${parameter.flag} must be one of: ${parameter.allowed_values.join(", ")}`);
          break;
        }
      }
    }
    const dependency = parameter.required_when;
    if (dependency && supplied.length === 0) {
      const other = byName.get(dependency.parameter);
      if (other && valuesFor(other.flag).includes(dependency.equals)) {
        violations.push(`${subject} requires ${parameter.flag} when ${other.flag} is ${dependency.equals}`);
      }
    }
  }
  return violations;
}

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
export const CHANGE_PROVIDER_CAPABILITIES = ["change.create", "change.observe", "change.merge"] as const;
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
    || ["change.create", "change.observe"].some((capability) => !capabilities.includes(capability as ChangeProviderCapability))) {
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
