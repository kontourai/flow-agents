import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { atomicWriteFile, ensureSafeDirectory } from "../lib/fs.js";
import type { CaptureCompleteness, IntegrityClass, UnavailableReason } from "./integrity.js";
import { integrityClassForSource } from "./integrity.js";
import { filterNarrativeRecord } from "./policy-filter.js";
import {
  NarrativeReaderError,
  readAgentEventCandidate,
  readCommandLogCandidate,
  readDelegationCandidate,
  readFileCandidate,
  readFlowReportCandidate,
  readFlowStateCandidate,
  readFlowTransitionCandidate,
  readTelemetryCandidates,
  readSurfaceExplanationCandidate,
  readTranscriptCandidate,
  readTrustClaimCandidate,
  readTrustEvidenceCandidate,
  type ReadCandidate,
} from "./readers.js";
import { formatSourceId, type NarrativeSourceId } from "./source-ids.js";

export interface NarrativeSourceRoots {
  telemetryDir?: string;
  sessionDir?: string;
  flowRoot?: string;
  transcriptPath?: string;
  repoRoot?: string;
}

export interface NarrativeLineageEvent { at: string; event: string }

export interface NarrativeSourceRequest {
  source: NarrativeSourceId;
  roots: NarrativeSourceRoots;
  lineage?: NarrativeLineageEvent[];
}

export interface NarrativeSourceOrigin {
  store: string;
  path_class: string;
  path?: string;
  chain?: { seq: number; prevHash: string; hash: string };
  package?: { name: string; version: string };
}

interface NarrativeSourceBase {
  source_id: string;
  integrity_class: IntegrityClass;
  captured_at: string;
  origin: NarrativeSourceOrigin;
  redactions?: string[];
  lineage: NarrativeLineageEvent[];
}

export type NarrativeSourceManifestEntry =
  | (NarrativeSourceBase & { status: "snapshotted"; sha256: string; bytes: number })
  | (NarrativeSourceBase & { status: "unavailable"; unavailable_reason: UnavailableReason });

export interface NarrativeSourceManifest {
  schema_version: "1.0";
  narrative_id: string;
  captured_at: string;
  compiler: { name: string; version: string; policy_hash: string };
  capture_completeness: CaptureCompleteness;
  sources: NarrativeSourceManifestEntry[];
}

export interface SnapshotNarrativeInput {
  narrativeDir: string;
  narrativeId: string;
  requests: NarrativeSourceRequest[];
  redactionFields: readonly string[];
  compiler: NarrativeSourceManifest["compiler"];
  captureCompleteness: CaptureCompleteness;
  /**
   * Transcript content is DEFAULT-DENY: transcripts are arbitrary runtime
   * payloads that whole-field policy cannot meaningfully filter, so without
   * this explicit grant a transcript request is recorded path_only as
   * unavailable/redacted and no content is snapshotted.
   */
  allowTranscriptContent?: boolean;
}

export interface SnapshotNarrativeDependencies {
  now?: () => string;
  writeBlob?: (root: string, file: string, data: Buffer) => void;
  writeManifest?: (root: string, file: string, value: unknown) => void;
}

type SchemaIssue = { path: string; message: string };
type JsonSchema = Record<string, any>;
const dateTimeRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function schemaMatches(value: unknown, schema: JsonSchema, root: JsonSchema): boolean {
  const issues: SchemaIssue[] = [];
  validateSchemaValue(value, schema, "$", issues, root);
  return issues.length === 0;
}

function resolveSchemaRef(ref: string, root: JsonSchema): JsonSchema | undefined {
  if (!ref.startsWith("#/$defs/")) return undefined;
  return root.$defs?.[ref.slice("#/$defs/".length)];
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
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in object)) issues.push({ path: `${loc}.${key}`, message: "is required" });
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(object)) if (!(key in properties)) issues.push({ path: `${loc}.${key}`, message: "is not allowed" });
    } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      for (const key of Object.keys(object)) if (!(key in properties)) validateSchemaValue(object[key], schema.additionalProperties, `${loc}.${key}`, issues, root);
    }
    for (const [key, child] of Object.entries<JsonSchema>(properties)) if (key in object) validateSchemaValue(object[key], child, `${loc}.${key}`, issues, root);
  }
}

function schemaPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../schemas/narrative-source-manifest.schema.json");
}

export function validateNarrativeSourceManifest(value: unknown): SchemaIssue[] {
  let schema: JsonSchema;
  try { schema = JSON.parse(fs.readFileSync(schemaPath(), "utf8")) as JsonSchema; }
  catch { return [{ path: "$", message: "narrative source manifest schema is unavailable" }]; }
  const issues: SchemaIssue[] = [];
  validateSchemaValue(value, schema, "$", issues, schema);
  return issues;
}

function requiredRoot(root: string | undefined, sourceId: string, label: string): string {
  if (!root) throw new NarrativeReaderError("not_captured", sourceId, `${sourceId} requires ${label}`);
  return root;
}

function originFor(request: NarrativeSourceRequest): NarrativeSourceOrigin {
  const { source, roots } = request;
  const store = source.stream;
  if (source.stream === "telemetry") return { store, path_class: "telemetry_root", ...(roots.telemetryDir ? { path: roots.telemetryDir } : {}) };
  if (["cmdlog", "agent-event", "delegation", "trust-claim", "trust-evidence", "surface-explanation"].includes(source.stream)) return { store, path_class: "session_root", ...(roots.sessionDir ? { path: roots.sessionDir } : {}) };
  if (source.stream === "flow-state" || source.stream === "flow-report" || source.stream === "flow-transition") return { store, path_class: "flow_root", ...(roots.flowRoot ? { path: roots.flowRoot } : {}) };
  if (source.stream === "transcript") return { store, path_class: "external_path", ...(roots.transcriptPath ? { path: roots.transcriptPath } : {}) };
  return { store, path_class: "repository", ...(roots.repoRoot ? { path: roots.repoRoot } : {}) };
}

function sessionRootForSlug(roots: NarrativeSourceRoots, slug: string, sourceId: string): string {
  const sessionDir = requiredRoot(roots.sessionDir, sourceId, "session root");
  // A session-scoped ID names its slug; the supplied root must BE that session,
  // not merely any directory the caller controls.
  if (path.basename(path.resolve(sessionDir)) !== slug) {
    throw new NarrativeReaderError("unauthorized", sourceId, `${sourceId} names slug ${slug} but the session root does not`);
  }
  return sessionDir;
}

function locate(request: NarrativeSourceRequest): ReadCandidate | Buffer {
  const sourceId = formatSourceId(request.source);
  const { source, roots } = request;
  switch (source.stream) {
    case "telemetry": {
      const matches = readTelemetryCandidates({ telemetryDir: requiredRoot(roots.telemetryDir, sourceId, "telemetry root"), channel: source.scope.channel, sessionId: source.scope.sessionId, eventId: source.locator.eventId, sha8: source.locator.sha8, ordinal: source.ordinal });
      if (matches.length === 0) throw new NarrativeReaderError("not_captured", sourceId, `${sourceId} was not captured`);
      if (matches.length > 1) throw new NarrativeReaderError("corrupt", sourceId, `${sourceId} requires an ordinal because it is not unique`);
      return matches[0];
    }
    case "cmdlog": return readCommandLogCandidate({ sessionDir: sessionRootForSlug(roots, source.scope.slug, sourceId), locator: source.locator });
    case "agent-event": return readAgentEventCandidate({ sessionDir: sessionRootForSlug(roots, source.scope.slug, sourceId), agentId: source.scope.agentId, lineIndex: source.locator.lineIndex, sha8: source.locator.sha8 });
    case "delegation": return readDelegationCandidate({ sessionDir: sessionRootForSlug(roots, source.scope.slug, sourceId), agentId: source.scope.agentId, lineIndex: source.locator.lineIndex, sha8: source.locator.sha8 });
    case "trust-claim": return readTrustClaimCandidate({ sessionDir: sessionRootForSlug(roots, source.scope.slug, sourceId), bundleSha8: source.scope.bundleSha8, id: source.locator.id });
    case "trust-evidence": return readTrustEvidenceCandidate({ sessionDir: sessionRootForSlug(roots, source.scope.slug, sourceId), bundleSha8: source.scope.bundleSha8, id: source.locator.id });
    case "flow-state": return readFlowStateCandidate({ flowRoot: requiredRoot(roots.flowRoot, sourceId, "flow root"), runId: source.scope.runId, sha8: source.locator.sha8 });
    case "flow-report": return readFlowReportCandidate({ flowRoot: requiredRoot(roots.flowRoot, sourceId, "flow root"), runId: source.scope.runId, sha8: source.locator.sha8 });
    case "flow-transition": return readFlowTransitionCandidate({ flowRoot: requiredRoot(roots.flowRoot, sourceId, "flow root"), runId: source.scope.runId, index: source.locator.index, sha8: source.locator.sha8 });
    case "surface-explanation": return readSurfaceExplanationCandidate({ sessionDir: sessionRootForSlug(roots, source.scope.slug, sourceId), bundleSha8: source.scope.bundleSha8, claimId: source.locator.claimId });
    case "transcript": {
      const absolutePath = path.resolve(requiredRoot(roots.transcriptPath, sourceId, "transcript path"));
      // The ID's scope pin names one exact path; a mismatched root is a rebind.
      const pathSha8 = createHash("sha256").update(absolutePath, "utf8").digest("hex").slice(0, 8);
      if (pathSha8 !== source.scope.pathSha8) throw new NarrativeReaderError("corrupt", sourceId, `${sourceId} path pin does not match the supplied transcript path`);
      return readTranscriptCandidate({ absolutePath, byteStart: source.locator.byteStart, byteEnd: source.locator.byteEnd });
    }
    case "file": return readFileCandidate({ repoRoot: requiredRoot(roots.repoRoot, sourceId, "repository root"), repoRelativePath: source.scope.repoRelativePath, hash: source.locator.hash });
  }
}

function chainFrom(candidate: ReadCandidate | Buffer): NarrativeSourceOrigin["chain"] | undefined {
  if (Buffer.isBuffer(candidate) || !candidate.record || typeof candidate.record !== "object" || Buffer.isBuffer(candidate.record)) return undefined;
  const chain = (candidate.record as Record<string, unknown>)["_chain"] as Record<string, unknown> | undefined;
  if (!chain || !Number.isSafeInteger(chain.seq) || typeof chain.prevHash !== "string" || typeof chain.hash !== "string") return undefined;
  return { seq: chain.seq as number, prevHash: chain.prevHash, hash: chain.hash };
}

function lineageFor(request: NarrativeSourceRequest, capturedAt: string): NarrativeLineageEvent[] {
  return request.lineage ?? [{ at: capturedAt, event: "source_snapshotted" }];
}

function unavailableEntry(request: NarrativeSourceRequest, capturedAt: string, reason: UnavailableReason, redactions?: string[]): NarrativeSourceManifestEntry {
  return {
    source_id: formatSourceId(request.source), integrity_class: integrityClassForSource(request.source), captured_at: capturedAt,
    origin: originFor(request), status: "unavailable", unavailable_reason: reason,
    ...(redactions?.length ? { redactions } : {}), lineage: lineageFor(request, capturedAt),
  };
}

function createOnlyWriteManifest(root: string, file: string, value: unknown): void {
  // Creation-only publication: link(2) fails with EEXIST if any concurrent
  // writer published first, so a frozen manifest can never be replaced by a
  // second racer (a replace-style atomic rename would let the loser win).
  const temp = path.join(root, `.source-manifest.${process.pid}.${Date.now().toString(36)}.tmp`);
  atomicWriteFile(root, temp, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
  try {
    fs.linkSync(temp, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("narrative source manifest already exists");
    throw error;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export function snapshotNarrative(input: SnapshotNarrativeInput, dependencies: SnapshotNarrativeDependencies = {}): { narrativeDir: string; manifest: NarrativeSourceManifest } {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const writeBlob = dependencies.writeBlob ?? atomicWriteFile;
  const writeManifest = dependencies.writeManifest ?? createOnlyWriteManifest;
  const capturedAt = now();
  const sources: NarrativeSourceManifestEntry[] = [];
  const written = new Set<string>();
  if (fs.existsSync(path.join(input.narrativeDir, "source-manifest.json"))) throw new Error("narrative source manifest already exists");
  ensureSafeDirectory(input.narrativeDir, path.join(input.narrativeDir, "sources"));

  for (const request of input.requests) {
    const sourceCapturedAt = now();
    if (request.source.stream === "transcript" && input.allowTranscriptContent !== true) {
      sources.push(unavailableEntry(request, sourceCapturedAt, "redacted"));
      continue;
    }
    let candidate: ReadCandidate | Buffer;
    try { candidate = locate(request); }
    catch (error) {
      const reason = error instanceof NarrativeReaderError ? error.reason : "corrupt";
      sources.push(unavailableEntry(request, sourceCapturedAt, reason));
      continue;
    }
    const origin = {
      ...originFor(request),
      ...(!Buffer.isBuffer(candidate) && candidate.originPackage ? { package: candidate.originPackage } : {}),
      ...(chainFrom(candidate) ? { chain: chainFrom(candidate) } : {}),
    };
    if (request.source.stream === "flow-report" || request.source.stream === "surface-explanation") {
      // These streams are already authority-authored capture products. Preserve
      // Flow's foreign formatting and Surface's stableStringify bytes exactly.
      const bytes = Buffer.from((candidate as ReadCandidate).raw);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (!written.has(digest)) {
        writeBlob(input.narrativeDir, path.join(input.narrativeDir, "sources", digest), bytes);
        written.add(digest);
      }
      sources.push({
        source_id: formatSourceId(request.source), integrity_class: integrityClassForSource(request.source), captured_at: sourceCapturedAt,
        origin, status: "snapshotted", sha256: digest, bytes: bytes.length, lineage: lineageFor(request, sourceCapturedAt),
      });
      continue;
    }
    const record = Buffer.isBuffer(candidate) ? candidate : candidate.record;
    const filtered = filterNarrativeRecord(record, input.redactionFields);
    if (filtered.kind === "redacted") {
      sources.push({ ...unavailableEntry(request, sourceCapturedAt, "redacted", filtered.fields), origin });
      continue;
    }
    const bytes = Buffer.from(JSON.stringify(filtered.record));
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (!written.has(digest)) {
      writeBlob(input.narrativeDir, path.join(input.narrativeDir, "sources", digest), bytes);
      written.add(digest);
    }
    sources.push({
      source_id: formatSourceId(request.source), integrity_class: integrityClassForSource(request.source), captured_at: sourceCapturedAt,
      origin, status: "snapshotted", sha256: digest, bytes: bytes.length,
      ...(filtered.redactions.length ? { redactions: filtered.redactions } : {}), lineage: lineageFor(request, sourceCapturedAt),
    });
  }

  const manifest: NarrativeSourceManifest = {
    schema_version: "1.0", narrative_id: input.narrativeId, captured_at: capturedAt,
    compiler: input.compiler, capture_completeness: input.captureCompleteness, sources,
  };
  const issues = validateNarrativeSourceManifest(manifest);
  if (issues.length) throw new Error(`narrative source manifest validation failed: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
  writeManifest(input.narrativeDir, path.join(input.narrativeDir, "source-manifest.json"), manifest);
  return { narrativeDir: input.narrativeDir, manifest };
}
