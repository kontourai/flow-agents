import { createHash } from "node:crypto";
import { containsSensitiveCredential } from "./run-correlation.js";
import { RUN_FACT_KINDS } from "./run-reconstruction.js";
import type { RetrospectiveObservation } from "./retrospective-observation.js";

const SOURCE_KINDS = [
  "runtime_events",
  "builder_state",
  "trust_bundle",
  "flow_state",
  "flow_evidence_manifest",
  "economics",
  "terminal_outcome",
] as const;

type JsonRecord = Record<string, unknown>;

export function validateRetrospectiveObservationValue(value: unknown): RetrospectiveObservation {
  if (!isRecord(value)) throw new Error("retrospective observation must be an object");
  assertExactKeys(value, [
    "schema", "version", "observation_id", "correlation_id", "process", "workflow",
    "activity", "quality", "usage", "completeness", "source_refs", "diagnostics",
    "snapshot_sha256",
  ], "retrospective observation");
  if (value.schema !== "kontour.flow-agents.retrospective-observation" || value.version !== "1.0") {
    throw new Error("retrospective observation schema is invalid");
  }
  assertPublicId(value.correlation_id, "retrospective observation correlation_id");
  if (value.observation_id !== observationId(value.correlation_id)) {
    throw new Error("retrospective observation_id is invalid");
  }
  if (!isRecord(value.process)
    || !isRecord(value.workflow)
    || !isRecord(value.activity)
    || !isRecord(value.quality)
    || !isRecord(value.usage)
    || !isRecord(value.completeness)
    || !Array.isArray(value.source_refs)
    || !Array.isArray(value.diagnostics)
    || typeof value.snapshot_sha256 !== "string") {
    throw new Error("retrospective observation projection is invalid");
  }
  validateProcess(value.process);
  validateWorkflow(value.workflow);
  validateActivity(value.activity);
  validateQuality(value.quality);
  validateUsage(value.usage);
  validateCompleteness(value.completeness);
  value.source_refs.forEach((entry, index) => validateSourceRef(entry, index));
  value.diagnostics.forEach((entry, index) => validateDiagnostic(entry, index));
  validateCrossFieldConsistency(value);
  const { snapshot_sha256: snapshot, ...core } = value;
  if (snapshot !== sha256(stableStringify(core))) {
    throw new Error("retrospective observation snapshot hash is invalid");
  }
  if (containsSensitiveCredential(stableStringify(value))) {
    throw new Error("retrospective observation contains sensitive credential material");
  }
  return value as RetrospectiveObservation;
}

function validateProcess(value: JsonRecord): void {
  assertExactKeys(value, ["status", "verification_status"], "retrospective observation process");
  if ((value.status !== null && !isPublicMetadata(value.status))
    || !["PASS", "FAIL", "NOT_VERIFIED"].includes(String(value.verification_status))) {
    throw new Error("retrospective observation process is invalid");
  }
}

function validateWorkflow(value: JsonRecord): void {
  assertExactKeys(value, [
    "flow_status", "gate_outcome_count", "transition_count", "route_back_count",
  ], "retrospective observation workflow");
  if ((value.flow_status !== null && !isPublicMetadata(value.flow_status))
    || !isNullableCount(value.gate_outcome_count)
    || !isNullableCount(value.transition_count)
    || !isNullableCount(value.route_back_count)) {
    throw new Error("retrospective observation workflow is invalid");
  }
}

function validateActivity(value: JsonRecord): void {
  assertExactKeys(value, [
    "turn_count", "tool_result_count", "delegation_event_count",
  ], "retrospective observation activity");
  if (!isNullableCount(value.turn_count)
    || !isNullableCount(value.tool_result_count)
    || !isNullableCount(value.delegation_event_count)) {
    throw new Error("retrospective observation activity is invalid");
  }
}

function validateQuality(value: JsonRecord): void {
  assertExactKeys(value, ["status", "reason"], "retrospective observation quality");
  if (value.status !== "NOT_VERIFIED" || value.reason !== "not_independently_evaluated") {
    throw new Error("retrospective observation quality is invalid");
  }
}

function validateUsage(value: JsonRecord): void {
  assertExactKeys(value, [
    "status", "authority", "semantics", "model", "input_tokens", "output_tokens",
    "estimated_cost_usd", "wall_clock_s", "delegation_count",
  ], "retrospective observation usage");
  if (!["CONFIRMED", "NOT_VERIFIED"].includes(String(value.status))
    || !["authenticated_runtime_binding", "fixture_input", "unavailable"].includes(String(value.authority))
    || !["run_delta", null].includes(value.semantics as null | string)
    || (value.model !== null && !isPublicMetadata(value.model))
    || !isNullableNumber(value.input_tokens)
    || !isNullableNumber(value.output_tokens)
    || !isNullableNumber(value.estimated_cost_usd)
    || !isNullableNumber(value.wall_clock_s)
    || !isNullableCount(value.delegation_count)) {
    throw new Error("retrospective observation usage is invalid");
  }
  if (value.authority === "unavailable") {
    if (value.status !== "NOT_VERIFIED"
      || value.semantics !== null
      || ["model", "input_tokens", "output_tokens", "estimated_cost_usd", "wall_clock_s", "delegation_count"]
        .some((field) => value[field] !== null)) {
      throw new Error("unavailable retrospective usage must not carry attributed metrics");
    }
  } else if (value.semantics !== "run_delta"
    || value.input_tokens === null
    || value.output_tokens === null) {
    throw new Error("attributed retrospective usage requires exact run-delta token totals");
  }
  if (value.status === "CONFIRMED"
    && (value.authority !== "authenticated_runtime_binding"
      || value.model === null
      || value.estimated_cost_usd === null
      || value.wall_clock_s === null
      || value.delegation_count === null)) {
    throw new Error("confirmed retrospective usage requires all authenticated attributes");
  }
}

function validateCompleteness(value: JsonRecord): void {
  assertExactKeys(value, [
    "status", "present_dimensions", "missing_dimensions", "missing_sources",
    "malformed_records", "invalid_records",
  ], "retrospective observation completeness");
  if (!["complete", "partial"].includes(String(value.status))
    || !isUniqueEnumArray(value.present_dimensions, RUN_FACT_KINDS)
    || !isUniqueEnumArray(value.missing_dimensions, RUN_FACT_KINDS)
    || !isUniqueEnumArray(value.missing_sources, SOURCE_KINDS)
    || !isCount(value.malformed_records)
    || !isCount(value.invalid_records)) {
    throw new Error("retrospective observation completeness is invalid");
  }
  const present = new Set(value.present_dimensions as string[]);
  const missing = new Set(value.missing_dimensions as string[]);
  if (RUN_FACT_KINDS.some((kind) => present.has(kind) === missing.has(kind))) {
    throw new Error("retrospective observation dimensions must form a disjoint partition");
  }
  const hasGap = missing.size > 0
    || (value.missing_sources as unknown[]).length > 0
    || Number(value.malformed_records) > 0
    || Number(value.invalid_records) > 0;
  if ((value.status === "complete") === hasGap) {
    throw new Error("retrospective observation completeness status contradicts its gaps");
  }
}

function validateSourceRef(value: unknown, index: number): void {
  if (!isRecord(value)) throw new Error(`retrospective observation source_refs[${index}] is invalid`);
  assertExactKeys(value, [
    "kind", "source_id", "content_sha256", "total_records", "valid_records",
    "malformed_records", "invalid_records",
  ], `retrospective observation source_refs[${index}]`);
  assertPublicId(value.source_id, `retrospective observation source_refs[${index}].source_id`);
  if (!(SOURCE_KINDS as readonly unknown[]).includes(value.kind)
    || !isSha256(value.content_sha256)
    || !isCount(value.total_records)
    || !isCount(value.valid_records)
    || !isCount(value.malformed_records)
    || !isCount(value.invalid_records)
    || Number(value.valid_records) + Number(value.malformed_records) + Number(value.invalid_records)
      !== Number(value.total_records)) {
    throw new Error(`retrospective observation source_refs[${index}] counts are invalid`);
  }
}

function validateDiagnostic(value: unknown, index: number): void {
  if (!isRecord(value)) throw new Error(`retrospective observation diagnostics[${index}] is invalid`);
  assertExactKeys(value, [
    "source_id", "line", "content_sha256", "error",
  ], `retrospective observation diagnostics[${index}]`);
  assertPublicId(value.source_id, `retrospective observation diagnostics[${index}].source_id`);
  if (!Number.isSafeInteger(value.line)
    || Number(value.line) < 1
    || !isSha256(value.content_sha256)
    || !["SyntaxError", "ProducerValidationError"].includes(String(value.error))) {
    throw new Error(`retrospective observation diagnostics[${index}] is invalid`);
  }
}

function validateCrossFieldConsistency(value: JsonRecord): void {
  const completeness = value.completeness as JsonRecord;
  const sourceRefs = value.source_refs as JsonRecord[];
  const sourceKinds = sourceRefs.map((entry) => String(entry.kind));
  const sourceIds = sourceRefs.map((entry) => String(entry.source_id));
  if (new Set(sourceKinds).size !== sourceKinds.length) {
    throw new Error("retrospective observation source_refs kinds must be unique");
  }
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new Error("retrospective observation source_refs source_ids must be unique");
  }
  const presentSources = new Set(sourceKinds);
  const missingSources = new Set(completeness.missing_sources as string[]);
  if (SOURCE_KINDS.some((kind) => presentSources.has(kind) === missingSources.has(kind))) {
    throw new Error("retrospective observation sources must form a disjoint partition");
  }
  const malformed = sourceRefs.reduce((sum, entry) => sum + Number(entry.malformed_records), 0);
  const invalid = sourceRefs.reduce((sum, entry) => sum + Number(entry.invalid_records), 0);
  if (malformed !== completeness.malformed_records || invalid !== completeness.invalid_records) {
    throw new Error("retrospective observation aggregate record counts are inconsistent");
  }
  if ((value.diagnostics as unknown[]).length > malformed + invalid) {
    throw new Error("retrospective observation diagnostics exceed quarantined records");
  }
  const refsBySource = new Map(sourceRefs.map((entry) => [String(entry.source_id), entry]));
  const diagnosticCounts = new Map<string, { malformed: number; invalid: number }>();
  for (const diagnostic of value.diagnostics as JsonRecord[]) {
    const sourceId = String(diagnostic.source_id);
    if (!refsBySource.has(sourceId)) {
      throw new Error("retrospective observation diagnostic has no source reference");
    }
    const counts = diagnosticCounts.get(sourceId) ?? { malformed: 0, invalid: 0 };
    if (diagnostic.error === "SyntaxError") counts.malformed += 1;
    else counts.invalid += 1;
    diagnosticCounts.set(sourceId, counts);
  }
  for (const [sourceId, counts] of diagnosticCounts) {
    const source = refsBySource.get(sourceId)!;
    if (counts.malformed > Number(source.malformed_records)
      || counts.invalid > Number(source.invalid_records)) {
      throw new Error("retrospective observation diagnostics exceed their source counts");
    }
  }
}

function isCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isNullableCount(value: unknown): boolean {
  return value === null || isCount(value);
}

function isNullableNumber(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isSha256(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isUniqueEnumArray(value: unknown, allowed: readonly string[]): boolean {
  return Array.isArray(value)
    && new Set(value).size === value.length
    && value.every((entry) => allowed.includes(String(entry)));
}

function isPublicMetadata(value: unknown): value is string {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:@/+ -]{0,254}$/.test(value)
    && !containsSensitiveCredential(value);
}

function assertPublicId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$/.test(value)
    || containsSensitiveCredential(value)) {
    throw new Error(`${label} must be a bounded non-sensitive opaque identifier`);
  }
}

function assertExactKeys(value: JsonRecord, allowed: readonly string[], label: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new Error(`${label} contains unsupported field ${extras[0]}`);
}

function observationId(correlationId: string): string {
  return `observation:${sha256(`kontour.flow-agents.retrospective-observation:1.0:${correlationId}`)}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
