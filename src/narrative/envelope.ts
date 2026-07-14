import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSafeDirectory } from "../lib/fs.js";
import { flowAgentsPackageVersion } from "../lib/package-version.js";
import type { CaptureCompleteness, UnavailableReason } from "./integrity.js";
import {
  projectRuntimeNarrative,
  stableStringify,
  type NarrativeRuntimeProjection,
} from "./projection.js";
import { renderGroundedNarrative } from "./render.js";
import { resolveSource, verifyManifest } from "./resolver.js";
import { parseSourceId } from "./source-ids.js";
import {
  validateNarrativeSourceManifest,
  type NarrativeSourceManifest,
} from "./snapshot.js";

export const GROUNDED_EXECUTION_NARRATIVE_SCHEMA_VERSION = "grounded-execution-narrative/v1" as const;
export const GROUNDED_EXECUTION_NARRATIVE_COMPILER_NAME = "flow-agents-narrative-composer" as const;

export type GroundedNarrativeErrorCode =
  | "manifest_invalid"
  | "source_integrity_failed"
  | "malformed_embedded_json"
  | "embedded_integrity_failed"
  | "schema_unavailable"
  | "compiler_unavailable";

export class GroundedNarrativeError extends Error {
  readonly name = "GroundedNarrativeError";

  constructor(
    readonly code: GroundedNarrativeErrorCode,
    message: string,
    readonly sourceId?: string,
  ) {
    super(message);
  }
}

export interface GroundedNarrativeConfig {
  compiledAt: string;
  renderTitle?: string;
}

export interface GroundedNarrativeRule {
  id: "flow-turn-correlation/v1";
  version: "v1";
  inputs: [string, string];
}

export interface GroundedNarrativeFlowTransition {
  kind: "flow-transition";
  from: string;
  to: string;
  at?: string;
  source_refs: [string, string];
  rule: GroundedNarrativeRule;
}

export interface GroundedNarrativeCorrelation {
  turns: Array<{ turn_ordinal: number; placed: GroundedNarrativeFlowTransition[] }>;
  unplaced: Array<GroundedNarrativeFlowTransition & { reason: "ambiguous_window" | "no_timestamp" | "no_turns" }>;
}

export type GroundedNarrativeConclusion =
  | { proposition: string; grounding: { kind: "flow_gate_derivation"; source_ref: string; pointer: string } }
  | { proposition: string; grounding: { kind: "surface_explanation"; source_ref: string } };

export interface GroundedNarrativeForeignSection {
  authority: "flow" | "surface";
  kind: "flow-process-projection" | "claim-explanation";
  source_refs: [string];
  sha256: string;
  embedded: unknown;
}

export interface GroundedNarrativeRuntimeSection {
  authority: "flow-agents";
  kind: "runtime-projection";
  sha256: string;
  embedded: NarrativeRuntimeProjection;
}

export type GroundedNarrativeSection = GroundedNarrativeForeignSection | GroundedNarrativeRuntimeSection;

export interface GroundedExecutionNarrative {
  schema_version: typeof GROUNDED_EXECUTION_NARRATIVE_SCHEMA_VERSION;
  narrative_id: string;
  provenance: {
    compiler: { name: typeof GROUNDED_EXECUTION_NARRATIVE_COMPILER_NAME; version: string };
    compiled_at: string;
    manifest_sha256: string;
    schema_sha256: string;
    config_sha256: string;
    compiler_sha256: string;
  };
  capture_completeness: CaptureCompleteness;
  sections: GroundedNarrativeSection[];
  correlation: GroundedNarrativeCorrelation;
  conclusions: GroundedNarrativeConclusion[];
  coverage: { sources: number; embedded: number; unavailable: number };
  unavailable_sources: Array<{ source_ref: string; reason: UnavailableReason }>;
}

export interface WrittenGroundedNarrative {
  envelopePath: string;
  lineagePath: string;
  envelopeSha256: string;
  renderPath?: string;
}

export interface WriteEnvelopeOptions { render?: boolean; outDir?: string }

export type SchemaIssue = { path: string; message: string };
type JsonSchema = Record<string, any>;
const dateTimeRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function schemaPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../schemas/grounded-execution-narrative.schema.json");
}

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
  if (schema.type === "integer") {
    if (!Number.isInteger(value)) { issues.push({ path: loc, message: "must be integer" }); return; }
    if (typeof schema.minimum === "number" && (value as number) < schema.minimum) issues.push({ path: loc, message: `must be at least ${schema.minimum}` });
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) { issues.push({ path: loc, message: "must be array" }); return; }
    if (typeof schema.minItems === "number" && value.length < schema.minItems) issues.push({ path: loc, message: `must contain at least ${schema.minItems} item(s)` });
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

export function validateGroundedNarrative(value: unknown): SchemaIssue[] {
  let schema: JsonSchema;
  try { schema = JSON.parse(fs.readFileSync(schemaPath(), "utf8")) as JsonSchema; }
  catch { return [{ path: "$", message: "grounded execution narrative schema is unavailable" }]; }
  const issues: SchemaIssue[] = [];
  validateSchemaValue(value, schema, "$", issues, schema);
  return issues;
}

function readVerifiedManifest(narrativeDir: string): { manifest: NarrativeSourceManifest; bytes: Buffer } {
  const manifestPath = path.join(narrativeDir, "source-manifest.json");
  let bytes: Buffer;
  let parsed: unknown;
  try {
    bytes = fs.readFileSync(manifestPath);
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new GroundedNarrativeError("manifest_invalid", "narrative source manifest could not be read after verification");
  }
  if (validateNarrativeSourceManifest(parsed).length > 0) {
    throw new GroundedNarrativeError("manifest_invalid", "narrative source manifest is invalid after verification");
  }
  return { manifest: parsed as NarrativeSourceManifest, bytes };
}

function parseEmbeddedJson(sourceId: string, content: Uint8Array): unknown {
  try { return JSON.parse(Buffer.from(content).toString("utf8")); }
  catch { throw new GroundedNarrativeError("malformed_embedded_json", `${sourceId} does not contain valid JSON`, sourceId); }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function telemetryTimestamp(value: unknown): number | undefined {
  const record = object(value);
  const raw = nonEmptyString(record?.["timestamp"])
    ?? nonEmptyString(record?.["observed_at"])
    ?? nonEmptyString(record?.["recorded_at"])
    ?? nonEmptyString(record?.["at"]);
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function correlationFor(
  narrativeDir: string,
  manifest: NarrativeSourceManifest,
  projection: NarrativeRuntimeProjection,
): GroundedNarrativeCorrelation {
  const timestampsByRef = new Map<string, number>();
  for (const entry of manifest.sources) {
    if (parseSourceId(entry.source_id).stream !== "telemetry") continue;
    const resolved = resolveSource(narrativeDir, entry.source_id);
    if (resolved.status !== "resolved") continue;
    const timestamp = telemetryTimestamp(parseEmbeddedJson(entry.source_id, resolved.content));
    if (timestamp !== undefined) timestampsByRef.set(entry.source_id, timestamp);
  }
  const windows = projection.turns.map((turn) => {
    const values = [...new Set(turn.statements.flatMap((statement) => statement.source_refs))]
      .flatMap((sourceRef) => timestampsByRef.has(sourceRef) ? [timestampsByRef.get(sourceRef)!] : []);
    return values.length === 0
      ? { ordinal: turn.ordinal }
      : { ordinal: turn.ordinal, start: Math.min(...values), end: Math.max(...values) };
  });
  const turns = projection.turns.map((turn) => ({ turn_ordinal: turn.ordinal, placed: [] as GroundedNarrativeFlowTransition[] }));
  const turnsByOrdinal = new Map(turns.map((turn) => [turn.turn_ordinal, turn]));
  const unplaced: GroundedNarrativeCorrelation["unplaced"] = [];

  for (const entry of manifest.sources) {
    const parsedId = parseSourceId(entry.source_id);
    if (parsedId.stream !== "flow-state") continue;
    const reportRef = manifest.sources.find((candidate) => {
      const candidateId = parseSourceId(candidate.source_id);
      return candidateId.stream === "flow-report" && candidateId.scope.runId === parsedId.scope.runId;
    })?.source_id;
    if (!reportRef) continue;
    const resolved = resolveSource(narrativeDir, entry.source_id);
    if (resolved.status !== "resolved") continue;
    const state = object(parseEmbeddedJson(entry.source_id, resolved.content));
    const transitions = Array.isArray(state?.["transitions"]) ? state!["transitions"] as unknown[] : [];
    for (const value of transitions) {
      const transition = object(value);
      const from = nonEmptyString(transition?.["from"]);
      const to = nonEmptyString(transition?.["to"]);
      if (!from || !to) continue;
      const at = nonEmptyString(transition?.["at"]);
      const source_refs: [string, string] = [entry.source_id, reportRef];
      const record: GroundedNarrativeFlowTransition = {
        kind: "flow-transition",
        from,
        to,
        ...(at ? { at } : {}),
        source_refs,
        rule: { id: "flow-turn-correlation/v1", version: "v1", inputs: source_refs },
      };
      if (windows.length === 0) {
        unplaced.push({ ...record, reason: "no_turns" });
        continue;
      }
      const timestamp = at ? Date.parse(at) : Number.NaN;
      if (!at || Number.isNaN(timestamp)) {
        unplaced.push({ ...record, reason: "no_timestamp" });
        continue;
      }
      const matches = windows.filter((window) => window.start !== undefined && window.end !== undefined
        && timestamp > window.start && timestamp < window.end);
      if (matches.length !== 1) {
        unplaced.push({ ...record, reason: "ambiguous_window" });
        continue;
      }
      turnsByOrdinal.get(matches[0]!.ordinal)!.placed.push(record);
    }
  }
  return { turns, unplaced };
}

function conclusionsFor(sections: readonly GroundedNarrativeSection[]): GroundedNarrativeConclusion[] {
  const conclusions: GroundedNarrativeConclusion[] = [];
  for (const section of sections) {
    if (section.authority === "flow") {
      const report = object(section.embedded);
      const summaries = Array.isArray(report?.["gate_summaries"]) ? report!["gate_summaries"] as unknown[] : [];
      summaries.forEach((value, index) => {
        const summary = object(value);
        const gateId = nonEmptyString(summary?.["gate_id"]);
        const status = nonEmptyString(summary?.["status"]);
        if (gateId && status) conclusions.push({
          proposition: `Gate ${gateId} was ${status}.`,
          grounding: { kind: "flow_gate_derivation", source_ref: section.source_refs[0], pointer: `/gate_summaries/${index}` },
        });
      });
      continue;
    }
    if (section.authority === "surface") {
      const explanation = object(section.embedded);
      const status = nonEmptyString(explanation?.["status"]);
      const parsed = parseSourceId(section.source_refs[0]);
      if (status && parsed.stream === "surface-explanation") conclusions.push({
        proposition: `Claim ${parsed.locator.claimId} was ${status}.`,
        grounding: { kind: "surface_explanation", source_ref: section.source_refs[0] },
      });
    }
  }
  return conclusions;
}

/** Compile exclusively from the frozen manifest and its content-addressed blobs. */
export function composeGroundedNarrative(
  narrativeDir: string,
  config: GroundedNarrativeConfig,
): GroundedExecutionNarrative {
  const verification = verifyManifest(narrativeDir);
  if (verification.perSource.some((entry) => entry.sourceId === "manifest")) {
    throw new GroundedNarrativeError("manifest_invalid", "narrative source manifest verification failed");
  }
  const { manifest, bytes: manifestBytes } = readVerifiedManifest(narrativeDir);
  const manifestById = new Map(manifest.sources.map((entry) => [entry.source_id, entry]));
  for (const result of verification.perSource) {
    if (result.status !== "unavailable") continue;
    const declared = manifestById.get(result.sourceId);
    if (!declared || declared.status !== "unavailable" || declared.unavailable_reason !== result.reason) {
      throw new GroundedNarrativeError("source_integrity_failed", `source verification failed for ${result.sourceId}`, result.sourceId);
    }
  }

  const sections: GroundedNarrativeSection[] = [];
  const unavailableSources: GroundedExecutionNarrative["unavailable_sources"] = [];
  let embeddedCount = 0;
  for (const entry of manifest.sources) {
    const resolved = resolveSource(narrativeDir, entry.source_id);
    if (resolved.status === "unavailable") {
      unavailableSources.push({ source_ref: entry.source_id, reason: resolved.reason });
      continue;
    }
    const parsedId = parseSourceId(entry.source_id);
    if (parsedId.stream !== "flow-report" && parsedId.stream !== "surface-explanation") continue;
    const embedded = parseEmbeddedJson(entry.source_id, resolved.content);
    if (parsedId.stream === "surface-explanation") {
      const serialized = Buffer.from(stableStringify(embedded));
      if (sha256(serialized) !== resolved.sha256) {
        throw new GroundedNarrativeError(
          "embedded_integrity_failed",
          `stable serialization of ${entry.source_id} does not reproduce its frozen blob hash`,
          entry.source_id,
        );
      }
      sections.push({
        authority: "surface",
        kind: "claim-explanation",
        source_refs: [entry.source_id],
        sha256: resolved.sha256,
        embedded,
      });
    } else {
      // Flow owns the foreign formatting. The manifest hash pins those raw
      // bytes; parsing is only the envelope representation and is not used to
      // claim that a reserialization preserves the author's whitespace.
      sections.push({
        authority: "flow",
        kind: "flow-process-projection",
        source_refs: [entry.source_id],
        sha256: resolved.sha256,
        embedded,
      });
    }
    embeddedCount += 1;
  }

  const runtimeProjection = projectRuntimeNarrative(narrativeDir, { projectedAt: config.compiledAt });
  sections.push({
    authority: "flow-agents",
    kind: "runtime-projection",
    sha256: sha256(Buffer.from(stableStringify(runtimeProjection))),
    embedded: runtimeProjection,
  });

  let schemaBytes: Buffer;
  let compilerBytes: Buffer;
  try { schemaBytes = fs.readFileSync(schemaPath()); }
  catch { throw new GroundedNarrativeError("schema_unavailable", "grounded execution narrative schema is unavailable"); }
  // This intentionally identifies the built module, not TypeScript source;
  // compiler_sha256 is consequently stable within one build and build-dependent.
  try { compilerBytes = fs.readFileSync(fileURLToPath(import.meta.url)); }
  catch { throw new GroundedNarrativeError("compiler_unavailable", "built narrative compiler module is unavailable"); }

  return {
    schema_version: GROUNDED_EXECUTION_NARRATIVE_SCHEMA_VERSION,
    narrative_id: manifest.narrative_id,
    provenance: {
      compiler: { name: GROUNDED_EXECUTION_NARRATIVE_COMPILER_NAME, version: flowAgentsPackageVersion() },
      compiled_at: config.compiledAt,
      manifest_sha256: sha256(manifestBytes),
      schema_sha256: sha256(schemaBytes),
      config_sha256: sha256(Buffer.from(stableStringify(config))),
      compiler_sha256: sha256(compilerBytes),
    },
    capture_completeness: manifest.capture_completeness,
    sections,
    correlation: correlationFor(narrativeDir, manifest, runtimeProjection),
    conclusions: conclusionsFor(sections),
    coverage: { sources: manifest.sources.length, embedded: embeddedCount, unavailable: unavailableSources.length },
    unavailable_sources: unavailableSources,
  };
}

export function writeEnvelope(
  narrativeDir: string,
  envelope: GroundedExecutionNarrative,
  options: WriteEnvelopeOptions = {},
): WrittenGroundedNarrative {
  const bytes = Buffer.from(stableStringify(envelope));
  const envelopeSha256 = sha256(bytes);
  const envelopesDir = options.outDir ? path.resolve(options.outDir) : path.join(narrativeDir, "envelopes");
  const envelopePath = path.join(envelopesDir, `${envelopeSha256}.json`);
  const lineagePath = path.join(narrativeDir, "envelope-lineage.jsonl");
  ensureSafeDirectory(options.outDir ? envelopesDir : narrativeDir, envelopesDir);
  try {
    fs.writeFileSync(envelopePath, bytes, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stat = fs.lstatSync(envelopePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`refusing unsafe envelope target at ${envelopePath}`);
    const existing = fs.readFileSync(envelopePath);
    if (!existing.equals(bytes)) throw new Error(`content-addressed envelope collision at ${envelopePath}`);
  }
  const lineage = {
    compiled_at: envelope.provenance.compiled_at,
    envelope_sha256: envelopeSha256,
    manifest_sha256: envelope.provenance.manifest_sha256,
  };
  if (fs.existsSync(lineagePath)) {
    const stat = fs.lstatSync(lineagePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`refusing unsafe envelope lineage target at ${lineagePath}`);
  }
  // JSONL requires one compact record per line. The literal's insertion order
  // is lexicographic, matching stableStringify's key discipline without its
  // multi-line indentation.
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const descriptor = fs.openSync(lineagePath, fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | noFollow, 0o600);
  try { fs.writeSync(descriptor, `${JSON.stringify(lineage)}\n`, undefined, "utf8"); }
  finally { fs.closeSync(descriptor); }
  let renderPath: string | undefined;
  if (options.render) {
    renderPath = path.join(envelopesDir, `${envelopeSha256}.md`);
    const rendered = renderGroundedNarrative(envelope);
    try { fs.writeFileSync(renderPath, rendered, { flag: "wx" }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = fs.readFileSync(renderPath, "utf8");
      if (existing !== rendered) throw new Error(`content-addressed rendering collision at ${renderPath}`);
    }
  }
  return { envelopePath, lineagePath, envelopeSha256, ...(renderPath ? { renderPath } : {}) };
}
