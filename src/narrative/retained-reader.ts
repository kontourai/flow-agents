import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type GroundedExecutionNarrative,
  validateGroundedNarrative,
} from "./envelope.js";
import { stableStringify, validateNarrativeRuntimeProjection } from "./projection.js";
import { validateNarrativeSourceManifest, type NarrativeSourceManifest } from "./snapshot.js";
import { decodeGroundedNarrativeRef, type GroundedNarrativeRef } from "./retained-codecs.js";
import { parseSourceId } from "./source-ids.js";

export interface RetainedNarrativeScope {
  /** Server-owned retained snapshot root. This is deliberately absent from the reference. */
  narrativeDir: string;
  /** Server-owned custom directory passed to writeEnvelope({ outDir }). */
  envelopeOutDir?: string;
}

export interface RetainedNarrativeReadLimits {
  maxEnvelopeBytes?: number;
  maxManifestBytes?: number;
  maxSources?: number;
  maxSourceBytes?: number;
  maxAggregateSourceBytes?: number;
}

export type RetainedNarrativeReadFailure =
  | "invalid_reference"
  | "unauthorized"
  | "authorization_revoked"
  | "not_captured"
  | "corrupt"
  | "limits_exceeded"
  | "unsupported_version";

export type ReadGroundedNarrativeResult =
  | { status: "available"; ref: GroundedNarrativeRef; envelope: GroundedExecutionNarrative; manifest: NarrativeSourceManifest }
  | { status: "unavailable"; reason: RetainedNarrativeReadFailure };

export interface ReadGroundedNarrativeInput {
  scope: RetainedNarrativeScope;
  ref: GroundedNarrativeRef;
  limits?: RetainedNarrativeReadLimits;
  /** Checked immediately before and after the bounded native reads. */
  authorize: () => boolean | Promise<boolean>;
}


const DEFAULT_LIMITS: Required<RetainedNarrativeReadLimits> = {
  maxEnvelopeBytes: 4 * 1024 * 1024,
  maxManifestBytes: 4 * 1024 * 1024,
  maxSources: 256,
  maxSourceBytes: 4 * 1024 * 1024,
  maxAggregateSourceBytes: 32 * 1024 * 1024,
};
class ReadFailure extends Error {
  constructor(readonly reason: RetainedNarrativeReadFailure) { super(reason); }
}

function fail(reason: RetainedNarrativeReadFailure): never { throw new ReadFailure(reason); }
function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function limitsFor(input: RetainedNarrativeReadLimits | undefined): Required<RetainedNarrativeReadLimits> {
  const result = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(result) as Array<keyof typeof result>) {
    const supplied = input?.[key];
    if (supplied === undefined) continue;
    // Callers may narrow the owner hard limits, never broaden them.
    if (!Number.isSafeInteger(supplied) || supplied < 0 || supplied > DEFAULT_LIMITS[key]) fail("limits_exceeded");
    result[key] = supplied;
  }
  return result;
}

interface DirectoryFence {
  readonly path: string;
  readonly real: string;
  readonly dev: number;
  readonly ino: number;
}

function safeRoot(root: string): DirectoryFence {
  try {
    const stat = fs.lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("unauthorized");
    const real = fs.realpathSync(root);
    // Canonicalize an otherwise safe supplied directory once. macOS exposes /var
    // through /private/var, so comparing its spelling would reject safe owner scope.
    // From here on every operation uses and fences the canonical directory itself.
    const canonical = fs.lstatSync(real);
    if (canonical.isSymbolicLink() || !canonical.isDirectory()) fail("unauthorized");
    return { path: real, real, dev: canonical.dev, ino: canonical.ino };
  } catch (error) {
    if (error instanceof ReadFailure) throw error;
    fail("not_captured");
  }
}

function assertDirectoryFence(fence: DirectoryFence): void {
  try {
    const stat = fs.lstatSync(fence.path);
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== fence.dev || stat.ino !== fence.ino || fs.realpathSync(fence.path) !== fence.real) {
      fail("corrupt");
    }
  } catch (error) {
    if (error instanceof ReadFailure) throw error;
    fail("corrupt");
  }
}

/** Read one regular file under an explicit root without following components or accepting swaps. */
function readBoundedFile(root: DirectoryFence, relative: string, maxBytes: number): Buffer {
  if (!relative || path.isAbsolute(relative) || relative.split(path.sep).some((part) => !part || part === "." || part === "..")) fail("unauthorized");
  assertDirectoryFence(root);
  const file = path.join(root.path, relative);
  let cursor = root.path;
  const parents: DirectoryFence[] = [];
  for (const part of relative.split(path.sep).slice(0, -1)) {
    cursor = path.join(cursor, part);
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail("corrupt");
      parents.push({ path: cursor, real: fs.realpathSync(cursor), dev: stat.dev, ino: stat.ino });
    } catch (error) {
      if (error instanceof ReadFailure) throw error;
      fail("not_captured");
    }
  }
  let before: fs.Stats;
  try { before = fs.lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("not_captured");
    fail("corrupt");
  }
  if (before.isSymbolicLink() || !before.isFile()) fail("corrupt");
  if (before.size > maxBytes) fail("limits_exceeded");
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  let descriptor: number;
  try { descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow); }
  catch { fail("corrupt"); }
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) fail("corrupt");
    if (opened.size > maxBytes) fail("limits_exceeded");
    // Never allocate/read an unbounded file after the pre-read stat: a concurrent writer may
    // extend the inode. Reading max+1 makes growth a typed limit failure instead of allocation.
    const bounded = Buffer.allocUnsafe(maxBytes + 1);
    const bytesRead = fs.readSync(descriptor, bounded, 0, bounded.length, 0);
    const after = fs.fstatSync(descriptor);
    const pathAfter = fs.lstatSync(file);
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino) fail("corrupt");
    assertDirectoryFence(root);
    for (const parent of parents) assertDirectoryFence(parent);
    if (after.size > maxBytes || bytesRead > maxBytes || bytesRead !== after.size) fail("limits_exceeded");
    return bounded.subarray(0, bytesRead);
  } finally { fs.closeSync(descriptor); }
}

function parseJson(bytes: Buffer): unknown {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { fail("corrupt"); }
}

function sameJson(left: unknown, right: unknown): boolean { return stableStringify(left) === stableStringify(right); }

function assertRuntimeIntegrity(runtime: GroundedExecutionNarrative["sections"][number], manifest: NarrativeSourceManifest, manifestBytes: Buffer): void {
  if (runtime.authority !== "flow-agents") fail("corrupt");
  const embedded = runtime.embedded;
  if (sha256(Buffer.from(stableStringify(embedded))) !== runtime.sha256 || validateNarrativeRuntimeProjection(embedded).length) fail("corrupt");
  if (embedded.narrative_id !== manifest.narrative_id || embedded.provenance.manifest_sha256 !== sha256(manifestBytes)
    || !sameJson(embedded.capture_completeness, manifest.capture_completeness)
    || embedded.coverage.sources !== manifest.sources.length) fail("corrupt");
  const references = new Set<string>();
  for (const statement of [...embedded.document_statements, ...embedded.turns.flatMap((turn) => turn.statements)]) {
    for (const sourceRef of statement.source_refs) references.add(sourceRef);
    for (const sourceRef of statement.rule?.inputs ?? []) references.add(sourceRef);
  }
  const manifestIds = new Set(manifest.sources.map((entry) => entry.source_id));
  if ([...references].some((sourceRef) => !manifestIds.has(sourceRef))) fail("corrupt");
  if (embedded.coverage.cited !== references.size
    || embedded.coverage.unavailable !== manifest.sources.filter((entry) => entry.status === "unavailable").length) fail("corrupt");
}

function assertEnvelopeIntegrity(envelope: GroundedExecutionNarrative, manifest: NarrativeSourceManifest, manifestBytes: Buffer, sourceBytes: ReadonlyMap<string, Buffer>): void {
  if (envelope.narrative_id !== manifest.narrative_id || sha256(manifestBytes) !== envelope.provenance.manifest_sha256) fail("corrupt");
  if (!sameJson(envelope.capture_completeness, manifest.capture_completeness)) fail("corrupt");
  const manifestIds = new Set(manifest.sources.map((entry) => entry.source_id));
  const references = new Set<string>(envelope.unavailable_sources.map((entry) => entry.source_ref));
  for (const section of envelope.sections) if (section.authority !== "flow-agents") for (const sourceRef of section.source_refs) references.add(sourceRef);
  for (const turn of envelope.correlation.turns) for (const transition of turn.placed) {
    for (const sourceRef of transition.source_refs) references.add(sourceRef);
    for (const sourceRef of transition.rule.inputs) references.add(sourceRef);
  }
  for (const transition of envelope.correlation.unplaced) {
    for (const sourceRef of transition.source_refs) references.add(sourceRef);
    for (const sourceRef of transition.rule.inputs) references.add(sourceRef);
  }
  for (const conclusion of envelope.conclusions) references.add(conclusion.grounding.source_ref);
  if ([...references].some((sourceRef) => !manifestIds.has(sourceRef))) fail("corrupt");
  const unavailable = manifest.sources.filter((entry) => entry.status === "unavailable")
    .map((entry) => ({ source_ref: entry.source_id, reason: entry.unavailable_reason }));
  if (envelope.coverage.sources !== manifest.sources.length || envelope.coverage.unavailable !== unavailable.length || !sameJson(envelope.unavailable_sources, unavailable)) fail("corrupt");
  const runtime = envelope.sections.filter((section) => section.authority === "flow-agents");
  if (runtime.length !== 1) fail("corrupt");
  assertRuntimeIntegrity(runtime[0]!, manifest, manifestBytes);
  const expectedForeign = new Set(manifest.sources.filter((entry) => entry.status === "snapshotted"
    && ["flow-report", "surface-explanation"].includes(parseSourceId(entry.source_id).stream)).map((entry) => entry.source_id));
  const actualForeign = new Set<string>();
  let embedded = 0;
  for (const section of envelope.sections) {
    if (section.authority === "flow-agents") {
      continue;
    }
    const sourceRef = section.source_refs[0];
    const parsed = parseSourceId(sourceRef);
    if ((section.authority === "flow" && parsed.stream !== "flow-report")
      || (section.authority === "surface" && parsed.stream !== "surface-explanation") || actualForeign.has(sourceRef)) fail("corrupt");
    actualForeign.add(sourceRef);
    embedded += 1;
    const bytes = Buffer.from(section.embedded_bytes, "utf8");
    if (sha256(bytes) !== section.sha256) fail("corrupt");
    const source = manifest.sources.find((entry) => entry.source_id === section.source_refs[0]);
    if (!source || source.status !== "snapshotted" || !sourceBytes.get(source.source_id)?.equals(bytes)) fail("corrupt");
  }
  if (envelope.coverage.embedded !== embedded || !sameJson([...actualForeign].sort(), [...expectedForeign].sort())) fail("corrupt");
}

function unsupportedRefVersion(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const schemaVersion = (value as Record<string, unknown>).schemaVersion;
  return typeof schemaVersion === "string" && /^grounded-narrative-ref\/v[0-9]+$/.test(schemaVersion)
    && schemaVersion !== "grounded-narrative-ref/v1";
}

function unsupportedEnvelopeVersion(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const schemaVersion = (value as Record<string, unknown>).schema_version;
  return typeof schemaVersion === "string" && /^grounded-execution-narrative\/v[0-9]+$/.test(schemaVersion)
    && schemaVersion !== "grounded-execution-narrative/v1";
}

/**
 * Native retained-envelope reader. It never composes, scans a directory, consults raw origins,
 * or writes; every file is named by the server-owned scope plus the content-addressed ref.
 */
export async function readGroundedNarrative(input: ReadGroundedNarrativeInput): Promise<ReadGroundedNarrativeResult> {
  try {
    // Snapshot every caller-controlled value before the first await so queued callers cannot
    // swap authorization, roots, references, or limits while a read is in progress.
    const scope = { narrativeDir: input.scope.narrativeDir, envelopeOutDir: input.scope.envelopeOutDir };
    const ref = decodeGroundedNarrativeRef(input.ref);
    const authorize = input.authorize;
    if (typeof authorize !== "function") fail("unauthorized");
    if (!ref) fail(unsupportedRefVersion(input.ref) ? "unsupported_version" : "invalid_reference");
    const limits = limitsFor(input.limits);
    if (!(await authorize())) return { status: "unavailable", reason: "unauthorized" };
    const narrativeRoot = safeRoot(scope.narrativeDir);
    const envelopeRoot = safeRoot(scope.envelopeOutDir ?? path.join(narrativeRoot.path, "envelopes"));
    const envelopeBytes = readBoundedFile(envelopeRoot, `${ref.envelopeSha256}.json`, limits.maxEnvelopeBytes);
    if (sha256(envelopeBytes) !== ref.envelopeSha256) fail("corrupt");
    const parsedEnvelope = parseJson(envelopeBytes);
    if (unsupportedEnvelopeVersion(parsedEnvelope)) fail("unsupported_version");
    if (validateGroundedNarrative(parsedEnvelope).length) fail("corrupt");
    const envelope = parsedEnvelope as GroundedExecutionNarrative;
    if (envelope.narrative_id !== ref.narrativeId) fail("corrupt");
    const manifestBytes = readBoundedFile(narrativeRoot, "source-manifest.json", limits.maxManifestBytes);
    const parsedManifest = parseJson(manifestBytes);
    if (validateNarrativeSourceManifest(parsedManifest).length) fail("corrupt");
    const manifest = parsedManifest as NarrativeSourceManifest;
    if (manifest.sources.length > limits.maxSources) fail("limits_exceeded");
    let aggregate = 0;
    const sourceBytes = new Map<string, Buffer>();
    for (const source of manifest.sources) {
      if (source.status !== "snapshotted") continue; // declared capture gaps are not later corruption.
      if (source.bytes > limits.maxSourceBytes || aggregate + source.bytes > limits.maxAggregateSourceBytes) fail("limits_exceeded");
      const remainingAggregate = limits.maxAggregateSourceBytes - aggregate;
      const bytes = readBoundedFile(narrativeRoot, path.join("sources", source.sha256), Math.min(limits.maxSourceBytes, remainingAggregate, source.bytes));
      if (bytes.length !== source.bytes || sha256(bytes) !== source.sha256) fail("corrupt");
      aggregate += bytes.length;
      sourceBytes.set(source.source_id, bytes);
    }
    assertEnvelopeIntegrity(envelope, manifest, manifestBytes, sourceBytes);
    assertDirectoryFence(narrativeRoot);
    assertDirectoryFence(envelopeRoot);
    if (!(await authorize())) return { status: "unavailable", reason: "authorization_revoked" };
    return { status: "available", ref, envelope, manifest };
  } catch (error) {
    if (error instanceof ReadFailure) return { status: "unavailable", reason: error.reason };
    return { status: "unavailable", reason: "corrupt" };
  }
}
