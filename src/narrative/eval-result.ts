/**
 * Consolidated narrative eval-result schema + ajv-free validator (#612 / D2).
 *
 * The grounded-narrative eval suite (evals/fixtures/narrative-evals/scorer.mjs)
 * emits ONE `narrative-eval-result/v1` object per run: per-fixture verdicts,
 * aggregate faithfulness metrics with an explicit uncertainty block (results are
 * per-corpus MEASUREMENTS, not proofs — R7), the DECLARED cross-runtime
 * capability-parity block (#620, asserted not discovered — R7/AC3), documented
 * known_gaps (contradiction detection, #568/#425), and per-fixture raw source
 * links for audit (AC5). The schema is versioned + self-describing so kontourai/
 * evals#95 can ingest it unmodified (R6/AC6).
 *
 * Validation mirrors the repo's established ajv-free recursive walker (see
 * envelope.ts / projection.ts / snapshot.ts) paired with a draft-07
 * schemas/narrative-eval-result.schema.json. No new dependency; PURE aside from
 * reading the shipped schema file. Stays inside the #619 narrative import
 * boundary (node builtins + ./-relative narrative files only).
 *
 * @module
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const NARRATIVE_EVAL_RESULT_SCHEMA_VERSION = "narrative-eval-result/v1" as const;

export type NarrativeEvalVerdict = "accept" | "reject" | "known_gap";

export interface NarrativeEvalRawSourceLink {
  source_id: string;
  manifest_path: string;
}

export interface NarrativeEvalFixtureResult {
  id: string;
  case_class: string;
  expected: NarrativeEvalVerdict;
  actual: NarrativeEvalVerdict;
  pass: boolean;
  raw_source_links: NarrativeEvalRawSourceLink[];
}

export interface NarrativeEvalMetrics {
  unsupported_claim_rate: number;
  citation_precision: number;
  citation_recall: number;
  citation_resolvability: number;
  material_claim_coverage: number;
  omission_rate_by_class: Record<string, number>;
  epistemic_classification_accuracy: number;
}

export interface NarrativeEvalMetricUncertainty {
  sample_n: number;
  /** Observed [lower, upper] bound for the metric; a deterministic corpus yields a point range. */
  range: [number, number];
  basis: string;
}

export interface NarrativeEvalCapabilityParity {
  runtime: string;
  capability: string;
  declared_status: "supported" | "partial" | "unsupported";
}

export interface NarrativeEvalKnownGap {
  code: string;
  detail: string;
  ref?: string;
}

export interface NarrativeEvalResult {
  schema_version: typeof NARRATIVE_EVAL_RESULT_SCHEMA_VERSION;
  work_item: string;
  measurement_note: string;
  results: NarrativeEvalFixtureResult[];
  metrics: NarrativeEvalMetrics;
  uncertainty: Record<string, NarrativeEvalMetricUncertainty>;
  capability_parity: NarrativeEvalCapabilityParity[];
  known_gaps: NarrativeEvalKnownGap[];
}

export type SchemaIssue = { path: string; message: string };
type JsonSchema = Record<string, any>;
const dateTimeRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function resolveSchemaRef(ref: string, root: JsonSchema): JsonSchema | undefined {
  if (!ref.startsWith("#/$defs/")) return undefined;
  return root.$defs?.[ref.slice("#/$defs/".length)];
}

function schemaMatches(value: unknown, schema: JsonSchema, root: JsonSchema): boolean {
  const issues: SchemaIssue[] = [];
  validateSchemaValue(value, schema, "$", issues, root);
  return issues.length === 0;
}

function validateSchemaValue(value: unknown, schema: JsonSchema, loc: string, issues: SchemaIssue[], root = schema): void {
  if (schema.$ref) {
    const resolved = resolveSchemaRef(schema.$ref, root);
    if (!resolved) issues.push({ path: loc, message: `unsupported schema ref ${schema.$ref}` });
    else validateSchemaValue(value, resolved, loc, issues, root);
    return;
  }
  if (schema.anyOf && !schema.anyOf.some((sub: JsonSchema) => schemaMatches(value, sub, root))) issues.push({ path: loc, message: "must match at least one allowed schema" });
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((sub: JsonSchema) => schemaMatches(value, sub, root)).length;
    if (matches !== 1) issues.push({ path: loc, message: "must match exactly one allowed schema" });
  }
  if (schema.not && schemaMatches(value, schema.not, root)) issues.push({ path: loc, message: "must not match forbidden schema" });
  for (const sub of schema.allOf ?? []) validateSchemaValue(value, sub, loc, issues, root);
  if (schema.const !== undefined && value !== schema.const) issues.push({ path: loc, message: `must equal ${String(schema.const)}` });
  if (schema.enum && !schema.enum.includes(value)) issues.push({ path: loc, message: `must be one of ${schema.enum.join(", ")}` });
  if (schema.type === "string") {
    if (typeof value !== "string") { issues.push({ path: loc, message: "must be string" }); return; }
    if (typeof schema.minLength === "number" && value.length < schema.minLength) issues.push({ path: loc, message: "must not be empty" });
    if (schema.pattern && !(new RegExp(schema.pattern)).test(value)) issues.push({ path: loc, message: "has invalid format" });
    if (schema.format === "date-time" && (!dateTimeRe.test(value) || Number.isNaN(Date.parse(value)))) issues.push({ path: loc, message: "must be date-time" });
    return;
  }
  if (schema.type === "number") {
    if (typeof value !== "number" || Number.isNaN(value)) { issues.push({ path: loc, message: "must be number" }); return; }
    if (typeof schema.minimum === "number" && value < schema.minimum) issues.push({ path: loc, message: `must be at least ${schema.minimum}` });
    if (typeof schema.maximum === "number" && value > schema.maximum) issues.push({ path: loc, message: `must be at most ${schema.maximum}` });
    return;
  }
  if (schema.type === "integer") {
    if (!Number.isInteger(value)) { issues.push({ path: loc, message: "must be integer" }); return; }
    if (typeof schema.minimum === "number" && (value as number) < schema.minimum) issues.push({ path: loc, message: `must be at least ${schema.minimum}` });
    return;
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") issues.push({ path: loc, message: "must be boolean" });
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) { issues.push({ path: loc, message: "must be array" }); return; }
    if (typeof schema.minItems === "number" && value.length < schema.minItems) issues.push({ path: loc, message: `must contain at least ${schema.minItems} item(s)` });
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) issues.push({ path: loc, message: `must contain at most ${schema.maxItems} item(s)` });
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) issues.push({ path: loc, message: "must contain unique items" });
    if (schema.items) value.forEach((item, index) => validateSchemaValue(item, schema.items, `${loc}[${index}]`, issues, root));
    return;
  }
  if (schema.type === "object" || schema.required || schema.properties) {
    if (!value || typeof value !== "object" || Array.isArray(value)) { issues.push({ path: loc, message: "must be object" }); return; }
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in obj)) issues.push({ path: `${loc}.${key}`, message: "is required" });
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) if (!(key in properties)) issues.push({ path: `${loc}.${key}`, message: "is not allowed" });
    } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      for (const key of Object.keys(obj)) if (!(key in properties)) validateSchemaValue(obj[key], schema.additionalProperties, `${loc}.${key}`, issues, root);
    }
    for (const [key, child] of Object.entries<JsonSchema>(properties)) if (key in obj) validateSchemaValue(obj[key], child, `${loc}.${key}`, issues, root);
  }
}

function schemaPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../schemas/narrative-eval-result.schema.json");
}

/**
 * Validate a value against the shipped `narrative-eval-result/v1` schema. Returns
 * an empty array for a conforming value; one `{path, message}` issue per defect
 * otherwise (missing required field, wrong `schema_version`, extra property, an
 * out-of-range rate, and so on).
 */
export function validateNarrativeEvalResult(value: unknown): SchemaIssue[] {
  let schema: JsonSchema;
  try { schema = JSON.parse(fs.readFileSync(schemaPath(), "utf8")) as JsonSchema; }
  catch { return [{ path: "$", message: "narrative eval result schema is unavailable" }]; }
  const issues: SchemaIssue[] = [];
  validateSchemaValue(value, schema, "$", issues, schema);
  return issues;
}
