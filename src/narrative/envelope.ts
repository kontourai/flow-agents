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
  inputs: string[];
}

export interface GroundedNarrativeFlowTransition {
  kind: "flow-transition";
  from: string;
  to: string;
  at?: string;
  source_refs: [string];
  rule: GroundedNarrativeRule;
}

export interface GroundedNarrativeCorrelation {
  turns: Array<{ turn_ordinal: number; placed: GroundedNarrativeFlowTransition[] }>;
  unplaced: Array<GroundedNarrativeFlowTransition & { reason: "ambiguous_window" | "no_timestamp" | "no_timezone" | "no_turns" }>;
}

export type GroundedNarrativeConclusion =
  | { proposition: string; grounding: { kind: "flow_gate_derivation"; source_ref: string; pointer: string } }
  | { proposition: string; grounding: { kind: "surface_explanation"; source_ref: string } };

export interface GroundedNarrativeForeignSection {
  authority: "flow" | "surface";
  kind: "flow-process-projection" | "claim-explanation";
  source_refs: [string];
  sha256: string;
  embedded_bytes: string;
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

export function validateGroundedNarrative(value: unknown): SchemaIssue[] {
  let schema: JsonSchema;
  try { schema = JSON.parse(fs.readFileSync(schemaPath(), "utf8")) as JsonSchema; }
  catch { return [{ path: "$", message: "grounded execution narrative schema is unavailable" }]; }
  const issues: SchemaIssue[] = [];
  validateSchemaValue(value, schema, "$", issues, schema);
  validateGroundingSemantics(value, issues);
  return issues;
}

function resolveJsonPointer(value: unknown, pointer: string): boolean {
  if (!pointer.startsWith("/")) return false;
  let current = value;
  for (const encoded of pointer.slice(1).split("/")) {
    const token = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(token)) return false;
      const index = Number(token);
      if (index >= current.length) return false;
      current = current[index];
      continue;
    }
    const record = object(current);
    if (!record || !Object.prototype.hasOwnProperty.call(record, token)) return false;
    current = record[token];
  }
  return true;
}

function validateGroundingSemantics(value: unknown, issues: SchemaIssue[]): void {
  const envelope = object(value);
  if (!envelope || !Array.isArray(envelope["sections"]) || !Array.isArray(envelope["conclusions"])) return;
  const sections = envelope["sections"].flatMap((candidate) => object(candidate) ? [candidate as Record<string, unknown>] : []);
  for (const [index, section] of sections.entries()) {
    if (section["authority"] !== "flow" && section["authority"] !== "surface") continue;
    const embeddedBytes = nonEmptyString(section["embedded_bytes"]);
    const declaredSha = nonEmptyString(section["sha256"]);
    if (embeddedBytes && declaredSha && sha256(Buffer.from(embeddedBytes, "utf8")) !== declaredSha) {
      issues.push({ path: `$.sections[${index}].embedded_bytes`, message: "must hash to the section sha256" });
    }
    if (embeddedBytes) {
      try { JSON.parse(embeddedBytes); }
      catch { issues.push({ path: `$.sections[${index}].embedded_bytes`, message: "must contain valid JSON" }); }
    }
  }
  for (const [index, candidate] of (envelope["conclusions"] as unknown[]).entries()) {
    const conclusion = object(candidate);
    const grounding = object(conclusion?.["grounding"]);
    const kind = nonEmptyString(grounding?.["kind"]);
    const sourceRef = nonEmptyString(grounding?.["source_ref"]);
    if (!kind || !sourceRef) continue;
    const authority = kind === "flow_gate_derivation" ? "flow" : kind === "surface_explanation" ? "surface" : undefined;
    if (!authority) continue;
    const matches = sections.filter((section) => section["authority"] === authority
      && Array.isArray(section["source_refs"])
      && (section["source_refs"] as unknown[]).includes(sourceRef));
    if (matches.length !== 1) {
      issues.push({ path: `$.conclusions[${index}].grounding.source_ref`, message: `must resolve to exactly one ${authority} section` });
      continue;
    }
    if (kind !== "flow_gate_derivation") continue;
    const pointer = nonEmptyString(grounding?.["pointer"]);
    const embeddedBytes = nonEmptyString(matches[0]!["embedded_bytes"]);
    if (!pointer || !embeddedBytes) continue;
    let embedded: unknown;
    try { embedded = JSON.parse(embeddedBytes); }
    catch {
      issues.push({ path: `$.sections`, message: `flow section ${sourceRef} embedded_bytes must contain valid JSON` });
      continue;
    }
    if (!resolveJsonPointer(embedded, pointer)) {
      issues.push({ path: `$.conclusions[${index}].grounding.pointer`, message: "must resolve inside the grounded flow section" });
    }
  }
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

type CorrelationTimestamp =
  | { kind: "valid"; value: number }
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "no_timezone" };

function correlationTimestamp(value: unknown): CorrelationTimestamp {
  const record = object(value);
  const raw = nonEmptyString(record?.["timestamp"])
    ?? nonEmptyString(record?.["observed_at"])
    ?? nonEmptyString(record?.["recorded_at"])
    ?? nonEmptyString(record?.["at"]);
  if (!raw) return { kind: "missing" };
  if (!/(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(raw)) return { kind: "no_timezone" };
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(raw);
  if (!match) return { kind: "invalid" };
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = "", zone, sign, offsetHourText = "0", offsetMinuteText = "0"] = match;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = [yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText].map(Number);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return { kind: "invalid" };
  const milliseconds = Number(fraction.padEnd(3, "0"));
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, milliseconds);
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day
    || local.getUTCHours() !== hour || local.getUTCMinutes() !== minute || local.getUTCSeconds() !== second) return { kind: "invalid" };
  const offset = zone === "Z" ? 0 : (offsetHour * 60 + offsetMinute) * (sign === "+" ? 1 : -1);
  return { kind: "valid", value: local.getTime() - offset * 60_000 };
}

function correlationFor(
  narrativeDir: string,
  manifest: NarrativeSourceManifest,
  projection: NarrativeRuntimeProjection,
): GroundedNarrativeCorrelation {
  const timestampsByRef = new Map<string, CorrelationTimestamp>();
  for (const entry of manifest.sources) {
    if (parseSourceId(entry.source_id).stream !== "telemetry") continue;
    const resolved = resolveSource(narrativeDir, entry.source_id);
    if (resolved.status !== "resolved") continue;
    timestampsByRef.set(entry.source_id, correlationTimestamp(parseEmbeddedJson(entry.source_id, resolved.content)));
  }
  const windows = projection.turns.map((turn) => {
    const sourceRefs = [...new Set(turn.statements.flatMap((statement) => statement.source_refs))]
      .filter((sourceRef) => timestampsByRef.has(sourceRef));
    const readings = sourceRefs.map((sourceRef) => ({ sourceRef, timestamp: timestampsByRef.get(sourceRef)! }));
    const valid = readings.flatMap(({ sourceRef, timestamp }) => timestamp.kind === "valid" ? [{ sourceRef, value: timestamp.value }] : []);
    if (valid.length === 0) return {
      ordinal: turn.ordinal,
      timezoneInvalid: readings.some(({ timestamp }) => timestamp.kind === "no_timezone"),
    };
    const start = Math.min(...valid.map(({ value }) => value));
    const end = Math.max(...valid.map(({ value }) => value));
    return {
      ordinal: turn.ordinal,
      start,
      end,
      inputRefs: valid.filter(({ value }) => value === start || value === end).map(({ sourceRef }) => sourceRef),
      timezoneInvalid: readings.some(({ timestamp }) => timestamp.kind === "no_timezone"),
    };
  });
  const turns = projection.turns.map((turn) => ({ turn_ordinal: turn.ordinal, placed: [] as GroundedNarrativeFlowTransition[] }));
  const turnsByOrdinal = new Map(turns.map((turn) => [turn.turn_ordinal, turn]));
  const unplaced: GroundedNarrativeCorrelation["unplaced"] = [];

  for (const entry of manifest.sources) {
    const parsedId = parseSourceId(entry.source_id);
    if (parsedId.stream !== "flow-state") continue;
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
      const source_refs: [string] = [entry.source_id];
      const record: GroundedNarrativeFlowTransition = {
        kind: "flow-transition",
        from,
        to,
        ...(at ? { at } : {}),
        source_refs,
        rule: { id: "flow-turn-correlation/v1", version: "v1", inputs: [...source_refs] },
      };
      if (windows.length === 0) {
        unplaced.push({ ...record, reason: "no_turns" });
        continue;
      }
      const timestamp = correlationTimestamp({ at });
      if (timestamp.kind === "missing" || timestamp.kind === "invalid") {
        unplaced.push({ ...record, reason: "no_timestamp" });
        continue;
      }
      if (timestamp.kind === "no_timezone") {
        unplaced.push({ ...record, reason: "no_timezone" });
        continue;
      }
      if (windows.some((window) => window.timezoneInvalid)) {
        unplaced.push({ ...record, reason: "no_timezone" });
        continue;
      }
      const matches = windows.filter((window) => window.start !== undefined && window.end !== undefined
        && timestamp.value > window.start && timestamp.value < window.end);
      if (matches.length !== 1) {
        const inputs = [...new Set([entry.source_id, ...matches.flatMap((window) => window.inputRefs ?? [])])];
        unplaced.push({ ...record, rule: { ...record.rule, inputs }, reason: "ambiguous_window" });
        continue;
      }
      const inputs = [...new Set([entry.source_id, ...(matches[0]!.inputRefs ?? [])])];
      turnsByOrdinal.get(matches[0]!.ordinal)!.placed.push({ ...record, rule: { ...record.rule, inputs } });
    }
  }
  return { turns, unplaced };
}

function conclusionsFor(sections: readonly GroundedNarrativeSection[]): GroundedNarrativeConclusion[] {
  const conclusions: GroundedNarrativeConclusion[] = [];
  for (const section of sections) {
    if (section.authority === "flow") {
      const report = object(parseEmbeddedJson(section.source_refs[0], Buffer.from(section.embedded_bytes, "utf8")));
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
      const explanation = object(parseEmbeddedJson(section.source_refs[0], Buffer.from(section.embedded_bytes, "utf8")));
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
    parseEmbeddedJson(entry.source_id, resolved.content);
    const embeddedBytes = Buffer.from(resolved.content).toString("utf8");
    const embeddedSha = sha256(Buffer.from(embeddedBytes, "utf8"));
    if (embeddedSha !== resolved.sha256 || entry.status !== "snapshotted" || embeddedSha !== entry.sha256) {
      throw new GroundedNarrativeError(
        "embedded_integrity_failed",
        `embedded bytes for ${entry.source_id} do not reproduce the frozen manifest hash`,
        entry.source_id,
      );
    }
    sections.push(parsedId.stream === "surface-explanation" ? {
      authority: "surface",
      kind: "claim-explanation",
      source_refs: [entry.source_id],
      sha256: embeddedSha,
      embedded_bytes: embeddedBytes,
    } : {
      authority: "flow",
      kind: "flow-process-projection",
      source_refs: [entry.source_id],
      sha256: embeddedSha,
      embedded_bytes: embeddedBytes,
    });
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
