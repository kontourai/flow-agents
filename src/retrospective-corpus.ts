import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  assertRetrospectiveSourceSnapshotsCurrent,
  type RetrospectiveObservation,
  type RetrospectiveObservationManifest,
} from "./retrospective-observation.js";
import {
  type LoadedRecord,
  type ObservationDiagnostic,
  type RetrospectiveSourceKind,
} from "./retrospective-observation-input.js";
import {
  compileCorrelatedRuns,
  correlateIndexedSources,
  sourceSnapshotForVerification,
} from "./retrospective-corpus-projection.js";
import {
  capturePinnedDirectoryChain,
  confinedSourceFile,
  decodeUtf8Fatal,
  readPinnedFile,
  scanPinnedJsonl,
} from "./retrospective-observation-filesystem.js";
import {
  containsSensitiveCredential,
  readRunCorrelation,
  type RunCorrelationEnvelope,
} from "./run-correlation.js";

type JsonRecord = Record<string, unknown>;

const CORPUS_SCHEMA = "kontour.flow-agents.retrospective-corpus-report";
const WATERMARK_SCHEMA = "kontour.flow-agents.retrospective-corpus-watermark";
const VERSION = "1.0";
const MAX_ROOTS = 32;
const MAX_VISITED_ENTRIES = 200_000;
const MAX_DEPTH = 64;
const MAX_TOTAL_SOURCE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_TOTAL_RECORDS = 5_000_000;
const MAX_CORRELATIONS = 100_000;
const MAX_RETAINED_CORRELATED_RECORDS = 1_000_000;
const MAX_DIAGNOSTICS_PER_SOURCE = 1_000;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_JSONL_LINE_BYTES = 2 * 1024 * 1024;

export type Candidate = {
  root_id: string;
  root: string;
  relative_file: string;
  source_id: string;
  kind: RetrospectiveSourceKind;
};

export type CorrelationMarker = {
  correlation_id: string;
  envelope_sha256: string;
  flow_run_id: string | null;
  trust_sha256: string[];
};

export type IndexedSource = {
  candidate: Candidate;
  size: number;
  mtime_ms: number;
  content_sha256: string;
  total_records: number;
  malformed_records: number;
  invalid_records: number;
  records_with_present_correlation: number;
  records_without_present_correlation: number;
  correlations: CorrelationMarker[];
  correlation_marker_keys: Set<string>;
  flow_run_ids: string[];
  file: string;
  directory_chain: ReturnType<typeof capturePinnedDirectoryChain>;
  records_by_correlation: Map<string, LoadedRecord[]>;
  secondary_records: LoadedRecord[];
  diagnostics: ObservationDiagnostic[];
};

type InventoryBudget = {
  total_bytes: number;
  total_records: number;
  retained_records: number;
  correlation_ids: Set<string>;
  visited_entries: number;
};

type RootSummary = {
  root_id: string;
  source_files: number;
  total_records: number;
  malformed_records: number;
  invalid_records: number;
  records_with_present_correlation: number;
  records_without_present_correlation: number;
};

export type RetrospectiveCorpusWatermark = {
  schema: typeof WATERMARK_SCHEMA;
  version: typeof VERSION;
  roots: Array<{
    root_id: string;
    files: Array<{
      relative_file: string;
      size: number;
      mtime_ms: number;
      content_sha256: string;
    }>;
  }>;
};

export type RetrospectiveCorpusReport = {
  schema: typeof CORPUS_SCHEMA;
  version: typeof VERSION;
  measurement: {
    configured_roots: number;
    source_files: number;
    total_records: number;
    malformed_records: number;
    invalid_records: number;
    records_with_present_correlation: number;
    records_without_present_correlation: number;
    correlation_ids: number;
    manifests_emitted: number;
    observations_compiled: number;
    complete_observations: number;
    partial_observations: number;
    ambiguous_runs: number;
    compile_failures: number;
  };
  roots: RootSummary[];
  runs: Array<{
    correlation_id: string;
    root_id: string | null;
    status: "compiled" | "ambiguous" | "compile_failed";
    completeness: "complete" | "partial" | null;
    present_sources: RetrospectiveSourceKind[];
    missing_sources: RetrospectiveSourceKind[];
    reason: string | null;
  }>;
  watermark_sha256: string;
  interpretation: {
    causal_effect: "NOT_VERIFIED";
    quality_effect: "NOT_VERIFIED";
    statement: "Observational coverage cannot establish that a Kit caused an outcome.";
  };
};

export type RetrospectiveCorpusResult = {
  report: RetrospectiveCorpusReport;
  watermark: RetrospectiveCorpusWatermark;
  manifests: Array<{
    correlation_id: string;
    root_id: string;
    manifest: RetrospectiveObservationManifest;
    observation: RetrospectiveObservation;
  }>;
};

export function compileRetrospectiveCorpus(configuredRoots: string[]): RetrospectiveCorpusResult {
  const inventory = inventoryConfiguredRoots(configuredRoots);
  const correlatedRuns = correlateIndexedSources(inventory.sources);
  const compiled = compileCorrelatedRuns(correlatedRuns);
  assertRetrospectiveSourceSnapshotsCurrent(inventory.sources.map(sourceSnapshotForVerification));
  const watermark = buildWatermark(inventory.sources);
  return {
    watermark,
    manifests: compiled.manifests,
    report: buildReport(inventory, correlatedRuns.size, compiled, watermark),
  };
}

function inventoryConfiguredRoots(configuredRoots: string[]): {
  roots: RootSummary[];
  sources: IndexedSource[];
} {
  const roots = canonicalRoots(configuredRoots);
  const sources: IndexedSource[] = [];
  const summaries: RootSummary[] = [];
  const budget: InventoryBudget = {
    total_bytes: 0,
    total_records: 0,
    retained_records: 0,
    correlation_ids: new Set(),
    visited_entries: 0,
  };
  for (const root of roots) {
    const rootId = stableRootId(root);
    const summary = emptyRootSummary(rootId);
    for (const relativeFile of discoverKnownProducerFiles(root, budget)) {
      const indexed = indexProducerSource(root, rootId, relativeFile, budget);
      sources.push(indexed);
      addSourceSummary(summary, indexed);
    }
    summaries.push(summary);
  }
  return { roots: summaries, sources };
}

function buildReport(
  inventory: { roots: RootSummary[]; sources: IndexedSource[] },
  correlationCount: number,
  compiled: ReturnType<typeof compileCorrelatedRuns>,
  watermark: RetrospectiveCorpusWatermark,
): RetrospectiveCorpusReport {
  const measurement = {
    configured_roots: inventory.roots.length,
    source_files: inventory.sources.length,
    total_records: sum(inventory.roots, "total_records"),
    malformed_records: sum(inventory.roots, "malformed_records"),
    invalid_records: sum(inventory.roots, "invalid_records"),
    records_with_present_correlation: sum(inventory.roots, "records_with_present_correlation"),
    records_without_present_correlation: sum(inventory.roots, "records_without_present_correlation"),
    correlation_ids: correlationCount,
    manifests_emitted: compiled.manifests.length,
    observations_compiled: compiled.manifests.length,
    complete_observations: compiled.manifests.filter((entry) => entry.observation.completeness.status === "complete").length,
    partial_observations: compiled.manifests.filter((entry) => entry.observation.completeness.status === "partial").length,
    ambiguous_runs: compiled.reports.filter((entry) => entry.status === "ambiguous").length,
    compile_failures: compiled.reports.filter((entry) => entry.status === "compile_failed").length,
  };
  return {
    schema: CORPUS_SCHEMA,
    version: VERSION,
    measurement,
    roots: inventory.roots,
    runs: compiled.reports,
    watermark_sha256: sha256(stableStringify(watermark)),
    interpretation: {
      causal_effect: "NOT_VERIFIED",
      quality_effect: "NOT_VERIFIED",
      statement: "Observational coverage cannot establish that a Kit caused an outcome.",
    },
  };
}

function canonicalRoots(values: string[]): string[] {
  if (values.length === 0) throw new Error("at least one configured record root is required");
  if (values.length > MAX_ROOTS) throw new Error(`configured corpus accepts at most ${MAX_ROOTS} roots`);
  return [...new Set(values.map((value) => {
    const resolved = fs.realpathSync(path.resolve(value));
    capturePinnedDirectoryChain(resolved);
    return resolved;
  }))].sort();
}

function stableRootId(root: string): string {
  return `root-${sha256(root).slice(0, 24)}`;
}

function discoverKnownProducerFiles(root: string, budget: InventoryBudget): string[] {
  const starts = [
    path.join(root, ".kontourai", "telemetry"),
    path.join(root, ".kontourai", "flow-agents"),
    path.join(root, ".kontourai", "flow", "runs"),
  ].filter((candidate) => fs.existsSync(candidate));
  const state = { files: [] as string[] };
  for (const start of starts) walkProducerTree(start, root, 0, state, budget);
  return [...new Set(state.files)].sort();
}

function walkProducerTree(
  directory: string,
  root: string,
  depth: number,
  state: { files: string[] },
  budget: InventoryBudget,
): void {
  if (depth > MAX_DEPTH) throw new Error("configured corpus exceeds its traversal depth limit");
  const directoryStat = fs.lstatSync(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) return;
  const entries = fs.opendirSync(directory);
  try {
    while (true) {
      const entry = entries.readSync();
      if (!entry) break;
      budget.visited_entries += 1;
      if (budget.visited_entries > MAX_VISITED_ENTRIES) throw new Error("configured corpus exceeds its traversal entry limit");
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walkProducerTree(absolute, root, depth + 1, state, budget);
      else if (entry.isFile() && classifySource(path.relative(root, absolute))) state.files.push(path.relative(root, absolute));
    }
  } finally {
    entries.closeSync();
  }
}

function classifySource(file: string): RetrospectiveSourceKind | null {
  const normalized = file.split(path.sep).join("/");
  const name = path.basename(file);
  if (name === "full.jsonl" || name.endsWith(".full.jsonl")) return "runtime_events";
  if (name === "economics.jsonl" || name.endsWith(".economics.jsonl")) return "economics";
  if (name === "workflow-outcome.json") return "terminal_outcome";
  if (name === "trust.bundle" && normalized.startsWith(".kontourai/flow-agents/")) return "trust_bundle";
  if (name === "state.json" && normalized.startsWith(".kontourai/flow-agents/")) return "builder_state";
  if (name === "state.json" && normalized.startsWith(".kontourai/flow/runs/")) return "flow_state";
  if (name === "manifest.json" && normalized.startsWith(".kontourai/flow/runs/") && normalized.includes("/evidence/")) {
    return "flow_evidence_manifest";
  }
  return null;
}

function indexProducerSource(
  root: string,
  rootId: string,
  relativeFile: string,
  budget: InventoryBudget,
): IndexedSource {
  const kind = classifySource(relativeFile);
  if (!kind) throw new Error("unsupported retrospective corpus source");
  const sourceId = `source-${sha256(`${rootId}\0${relativeFile}`).slice(0, 24)}`;
  const confined = confinedSourceFile(root, relativeFile, kind);
  const candidate = { root_id: rootId, root, relative_file: relativeFile, source_id: sourceId, kind };
  return kind === "runtime_events" || kind === "economics"
    ? indexJsonlSource(candidate, confined.file, confined.directoryChain, budget)
    : indexJsonSource(candidate, confined.file, confined.directoryChain, budget);
}

function indexJsonlSource(
  candidate: Candidate,
  file: string,
  directoryChain: ReturnType<typeof capturePinnedDirectoryChain>,
  budget: InventoryBudget,
): IndexedSource {
  const accumulator = emptyIndexedSource(candidate, file, directoryChain);
  const remainingBytes = MAX_TOTAL_SOURCE_BYTES - budget.total_bytes;
  if (remainingBytes <= 0) throw new Error("configured corpus exceeds its total source byte limit");
  const scanned = scanPinnedJsonl(file, `${candidate.kind} corpus source`, MAX_JSONL_LINE_BYTES, directoryChain, (line, lineNumber, error, contentSha256) => {
    if (line === "") return;
    consumeRecordBudget(budget);
    accumulator.total_records += 1;
    if (error || line === null) {
      accumulator.malformed_records += 1;
      addDiagnostic(accumulator, lineNumber, contentSha256, "SyntaxError");
      return;
    }
    const parsed = parseRecord(line);
    consumeRecord(accumulator, parsed, {
      value: parsed ?? {},
      line: lineNumber,
      content_sha256: contentSha256,
    }, budget);
  }, remainingBytes);
  budget.total_bytes += scanned.size;
  return {
    ...accumulator,
    size: scanned.size,
    mtime_ms: scanned.mtimeMs,
    content_sha256: scanned.contentSha256,
  };
}

function indexJsonSource(
  candidate: Candidate,
  file: string,
  directoryChain: ReturnType<typeof capturePinnedDirectoryChain>,
  budget: InventoryBudget,
): IndexedSource {
  const remainingBytes = MAX_TOTAL_SOURCE_BYTES - budget.total_bytes;
  if (remainingBytes <= 0) throw new Error("configured corpus exceeds its total source byte limit");
  const bytes = readPinnedFile(file, `${candidate.kind} corpus source`, Math.min(MAX_JSON_BYTES, remainingBytes), directoryChain);
  budget.total_bytes += bytes.length;
  consumeRecordBudget(budget);
  const accumulator = emptyIndexedSource(candidate, file, directoryChain);
  accumulator.total_records = 1;
  let parsed: JsonRecord | null = null;
  try {
    parsed = parseRecord(decodeUtf8Fatal(bytes));
  } catch {
    // Fatal UTF-8 failures are quarantined as malformed source records.
  }
  consumeRecord(accumulator, parsed, {
    value: parsed ?? {},
    line: 1,
    content_sha256: sha256(bytes),
  }, budget);
  return {
    ...accumulator,
    size: bytes.length,
    mtime_ms: 0,
    content_sha256: sha256(bytes),
  };
}

function consumeRecord(
  source: IndexedSource,
  parsed: JsonRecord | null,
  loaded: LoadedRecord | null,
  budget: InventoryBudget,
): void {
  if (!parsed) {
    source.malformed_records += 1;
    addDiagnostic(source, loaded?.line ?? 1, loaded?.content_sha256 ?? sha256(""), "SyntaxError");
    return;
  }
  if (source.candidate.kind === "flow_state") {
    const runId = publicId(parsed.run_id);
    if (runId) source.flow_run_ids.push(runId);
  }
  const extracted = extractCorrelationMarkers(parsed, source.candidate.kind);
  if (extracted.invalid) {
    source.invalid_records += 1;
    addDiagnostic(source, loaded?.line ?? 1, loaded?.content_sha256 ?? sha256(""), "ProducerValidationError");
    return;
  }
  if (extracted.markers.length === 0) {
    source.records_without_present_correlation += 1;
    if (loaded && (source.candidate.kind === "flow_state" || source.candidate.kind === "trust_bundle")) {
      retainRecord(source.secondary_records, loaded, budget);
    }
  }
  else {
    source.records_with_present_correlation += 1;
    const retainedCorrelationIds = new Set<string>();
    for (const marker of extracted.markers) {
      budget.correlation_ids.add(marker.correlation_id);
      if (budget.correlation_ids.size > MAX_CORRELATIONS) throw new Error("configured corpus exceeds its correlation limit");
      const markerKey = stableStringify(marker);
      if (!source.correlation_marker_keys.has(markerKey)) {
        source.correlation_marker_keys.add(markerKey);
        source.correlations.push(marker);
      }
      retainedCorrelationIds.add(marker.correlation_id);
    }
    if (loaded) {
      for (const correlationId of retainedCorrelationIds) {
        const records = source.records_by_correlation.get(correlationId) ?? [];
        retainRecord(records, loaded, budget);
        source.records_by_correlation.set(correlationId, records);
      }
    }
  }
}

function consumeRecordBudget(budget: InventoryBudget): void {
  budget.total_records += 1;
  if (budget.total_records > MAX_TOTAL_RECORDS) throw new Error("configured corpus exceeds its total record limit");
}

function retainRecord(records: LoadedRecord[], loaded: LoadedRecord, budget: InventoryBudget): void {
  budget.retained_records += 1;
  if (budget.retained_records > MAX_RETAINED_CORRELATED_RECORDS) {
    throw new Error("configured corpus exceeds its retained correlated record limit");
  }
  records.push(loaded);
}

function addDiagnostic(
  source: IndexedSource,
  line: number,
  contentSha256: string,
  error: "SyntaxError" | "ProducerValidationError",
): void {
  if (source.diagnostics.length >= MAX_DIAGNOSTICS_PER_SOURCE) return;
  source.diagnostics.push({ source_id: source.candidate.source_id, line, content_sha256: contentSha256, error });
}

function extractCorrelationMarkers(
  record: JsonRecord,
  kind: RetrospectiveSourceKind,
): { markers: CorrelationMarker[]; invalid: boolean } {
  if (kind === "flow_evidence_manifest") return nestedEvidenceMarkers(record);
  if (!Object.hasOwn(record, "run_correlation")) return { markers: [], invalid: false };
  try {
    const result = readRunCorrelation(record);
    if (result.status === "incomplete") return { markers: [], invalid: false };
    return { markers: [markerFromEnvelope(result.envelope)], invalid: false };
  } catch {
    return { markers: [], invalid: true };
  }
}

function nestedEvidenceMarkers(record: JsonRecord): { markers: CorrelationMarker[]; invalid: boolean } {
  if (!Array.isArray(record.evidence)) return { markers: [], invalid: false };
  const markers: CorrelationMarker[] = [];
  let invalid = false;
  for (const entry of record.evidence) {
    if (!isRecord(entry) || !isRecord(entry.analytics) || !Object.hasOwn(entry.analytics, "run_correlation")) continue;
    try {
      const result = readRunCorrelation(entry.analytics);
      if (result.status === "incomplete") {
        continue;
      }
      const marker = markerFromEnvelope(result.envelope);
      if (typeof entry.sha256 === "string" && /^[a-f0-9]{64}$/.test(entry.sha256)) marker.trust_sha256.push(entry.sha256);
      markers.push(marker);
    } catch {
      invalid = true;
    }
  }
  return { markers, invalid };
}

function markerFromEnvelope(envelope: RunCorrelationEnvelope): CorrelationMarker {
  const flow = envelope.identities.flow_run;
  return {
    correlation_id: envelope.correlation_id,
    envelope_sha256: sha256(stableStringify(envelope)),
    flow_run_id: flow.status === "present" ? flow.value : null,
    trust_sha256: [],
  };
}

function buildWatermark(sources: IndexedSource[]): RetrospectiveCorpusWatermark {
  const roots = new Map<string, RetrospectiveCorpusWatermark["roots"][number]["files"]>();
  for (const source of sources) {
    const files = roots.get(source.candidate.root_id) ?? [];
    files.push({
      relative_file: source.candidate.relative_file,
      size: source.size,
      mtime_ms: source.mtime_ms,
      content_sha256: source.content_sha256,
    });
    roots.set(source.candidate.root_id, files);
  }
  return {
    schema: WATERMARK_SCHEMA,
    version: VERSION,
    roots: [...roots.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([rootId, files]) => ({
      root_id: rootId,
      files: files.sort((left, right) => left.relative_file.localeCompare(right.relative_file)),
    })),
  };
}

function emptyIndexedSource(
  candidate: Candidate,
  file: string,
  directoryChain: ReturnType<typeof capturePinnedDirectoryChain>,
): IndexedSource {
  return {
    candidate,
    size: 0,
    mtime_ms: 0,
    content_sha256: "0".repeat(64),
    total_records: 0,
    malformed_records: 0,
    invalid_records: 0,
    records_with_present_correlation: 0,
    records_without_present_correlation: 0,
    correlations: [],
    correlation_marker_keys: new Set(),
    flow_run_ids: [],
    file,
    directory_chain: directoryChain,
    records_by_correlation: new Map(),
    secondary_records: [],
    diagnostics: [],
  };
}

function emptyRootSummary(rootId: string): RootSummary {
  return {
    root_id: rootId,
    source_files: 0,
    total_records: 0,
    malformed_records: 0,
    invalid_records: 0,
    records_with_present_correlation: 0,
    records_without_present_correlation: 0,
  };
}

function addSourceSummary(summary: RootSummary, source: IndexedSource): void {
  summary.source_files += 1;
  summary.total_records += source.total_records;
  summary.malformed_records += source.malformed_records;
  summary.invalid_records += source.invalid_records;
  summary.records_with_present_correlation += source.records_with_present_correlation;
  summary.records_without_present_correlation += source.records_without_present_correlation;
}

function parseRecord(value: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function publicId(value: unknown): string | null {
  if (typeof value !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$/.test(value)
    || containsSensitiveCredential(value)) return null;
  return value;
}

function sum(values: RootSummary[], key: keyof RootSummary): number {
  return values.reduce((total, value) => total + Number(value[key]), 0);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
