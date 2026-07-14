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
  correlation: { turns: Record<string, unknown>[]; unplaced: Record<string, unknown>[] };
  conclusions: Record<string, unknown>[];
  coverage: { sources: number; embedded: number; unavailable: number };
  unavailable_sources: Array<{ source_ref: string; reason: UnavailableReason }>;
}

export interface WrittenGroundedNarrative {
  envelopePath: string;
  lineagePath: string;
  envelopeSha256: string;
}

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
    correlation: { turns: [], unplaced: [] },
    conclusions: [],
    coverage: { sources: manifest.sources.length, embedded: embeddedCount, unavailable: unavailableSources.length },
    unavailable_sources: unavailableSources,
  };
}

export function writeEnvelope(narrativeDir: string, envelope: GroundedExecutionNarrative): WrittenGroundedNarrative {
  const bytes = Buffer.from(stableStringify(envelope));
  const envelopeSha256 = sha256(bytes);
  const envelopesDir = path.join(narrativeDir, "envelopes");
  const envelopePath = path.join(envelopesDir, `${envelopeSha256}.json`);
  const lineagePath = path.join(narrativeDir, "envelope-lineage.jsonl");
  ensureSafeDirectory(narrativeDir, envelopesDir);
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
  return { envelopePath, lineagePath, envelopeSha256 };
}
