import {
  compileRetrospectiveObservationFromSources,
  type RetrospectiveObservationManifest,
} from "./retrospective-observation.js";
import {
  RETROSPECTIVE_SOURCE_KINDS,
  type LoadedRecord,
  type LoadedSource,
  type RetrospectiveSourceKind,
} from "./retrospective-observation-input.js";
import type {
  CorrelationMarker,
  IndexedSource,
  RetrospectiveCorpusReport,
  RetrospectiveCorpusResult,
} from "./retrospective-corpus.js";

const MAX_CORRELATIONS = 100_000;

type CorrelatedRun = {
  correlation_id: string;
  envelope_sha256: string;
  flow_run_ids: Set<string>;
  trust_sha256: Set<string>;
  sources: Map<RetrospectiveSourceKind, IndexedSource[]>;
  source_keys: Map<RetrospectiveSourceKind, Set<string>>;
};

type SecondaryBucket =
  | { status: "unique"; source: IndexedSource }
  | { status: "ambiguous"; witnesses: [IndexedSource, IndexedSource] };

export function correlateIndexedSources(sources: IndexedSource[]): Map<string, CorrelatedRun> {
  const runs = new Map<string, CorrelatedRun>();
  for (const source of sources) {
    for (const marker of source.correlations) registerCorrelation(runs, marker, source);
  }
  if (runs.size > MAX_CORRELATIONS) throw new Error("configured corpus exceeds its correlation limit");
  attachSecondarySources(runs, sources);
  return runs;
}

export function compileCorrelatedRuns(runs: Map<string, CorrelatedRun>): {
  manifests: RetrospectiveCorpusResult["manifests"];
  reports: RetrospectiveCorpusReport["runs"];
} {
  const manifests: RetrospectiveCorpusResult["manifests"] = [];
  const reports: RetrospectiveCorpusReport["runs"] = [];
  for (const correlationId of [...runs.keys()].sort()) {
    const selected = selectRootLocalSources(runs.get(correlationId)!);
    if (!selected) {
      reports.push(runReport(correlationId, null, "ambiguous", null, [], "sources are absent, conflicting, or span configured roots"));
      continue;
    }
    const manifest = manifestFor(correlationId, selected.sources);
    try {
      const loaded = [...selected.sources.values()].map((source) => sourceForCorrelation(source, correlationId));
      const observation = compileRetrospectiveObservationFromSources(manifest, loaded);
      manifests.push({ correlation_id: correlationId, root_id: selected.rootId, manifest, observation });
      reports.push(runReport(correlationId, selected.rootId, "compiled", observation.completeness.status, [...selected.sources.keys()], null));
    } catch (error) {
      reports.push(runReport(correlationId, selected.rootId, "compile_failed", null, [...selected.sources.keys()], errorClass(error)));
    }
  }
  return { manifests, reports };
}

export function sourceSnapshotForVerification(source: IndexedSource): LoadedSource {
  return loadedSource(source, []);
}

function registerCorrelation(
  runs: Map<string, CorrelatedRun>,
  marker: CorrelationMarker,
  source: IndexedSource,
): void {
  const run = runs.get(marker.correlation_id) ?? {
    correlation_id: marker.correlation_id,
    envelope_sha256: marker.envelope_sha256,
    flow_run_ids: new Set<string>(),
    trust_sha256: new Set<string>(),
    sources: new Map<RetrospectiveSourceKind, IndexedSource[]>(),
    source_keys: new Map<RetrospectiveSourceKind, Set<string>>(),
  };
  addSource(run, source);
  if (run.envelope_sha256 !== marker.envelope_sha256) {
    addSource(run, {
      ...source,
      candidate: { ...source.candidate, root_id: `${source.candidate.root_id}-identity-conflict` },
    });
  }
  if (marker.flow_run_id) run.flow_run_ids.add(marker.flow_run_id);
  for (const digest of marker.trust_sha256) run.trust_sha256.add(digest);
  runs.set(marker.correlation_id, run);
}

function attachSecondarySources(runs: Map<string, CorrelatedRun>, sources: IndexedSource[]): void {
  const flowSources = new Map<string, SecondaryBucket>();
  const trustSources = new Map<string, SecondaryBucket>();
  for (const source of sources) {
    if (source.candidate.kind === "flow_state") {
      for (const runId of new Set(source.flow_run_ids)) {
        indexSecondarySource(flowSources, `${source.candidate.root_id}\0${runId}`, source);
      }
    } else if (source.candidate.kind === "trust_bundle") {
      indexSecondarySource(trustSources, `${source.candidate.root_id}\0${source.content_sha256}`, source);
    }
  }
  for (const run of runs.values()) {
    const roots = new Set([...run.sources.values()].flat().map((source) => source.candidate.root_id));
    for (const rootId of roots) {
      for (const runId of run.flow_run_ids) {
        attachSecondaryBucket(run, flowSources.get(`${rootId}\0${runId}`));
      }
      for (const digest of run.trust_sha256) {
        attachSecondaryBucket(run, trustSources.get(`${rootId}\0${digest}`));
      }
    }
  }
}

function indexSecondarySource(index: Map<string, SecondaryBucket>, key: string, source: IndexedSource): void {
  const existing = index.get(key);
  if (!existing) {
    index.set(key, { status: "unique", source });
  } else if (existing.status === "unique") {
    index.set(key, { status: "ambiguous", witnesses: [existing.source, source] });
  }
}

function attachSecondaryBucket(run: CorrelatedRun, bucket: SecondaryBucket | undefined): void {
  if (!bucket) return;
  if (bucket.status === "unique") {
    addSource(run, bucket.source);
    return;
  }
  addSource(run, bucket.witnesses[0]);
  addSource(run, bucket.witnesses[1]);
}

function addSource(run: CorrelatedRun, source: IndexedSource): void {
  const candidate = source.candidate;
  const key = `${candidate.root_id}\0${candidate.relative_file}`;
  const values = run.sources.get(candidate.kind) ?? [];
  const keys = run.source_keys.get(candidate.kind) ?? new Set<string>();
  if (!keys.has(key)) {
    keys.add(key);
    values.push(source);
  }
  run.sources.set(candidate.kind, values);
  run.source_keys.set(candidate.kind, keys);
}

function selectRootLocalSources(run: CorrelatedRun): {
  rootId: string;
  sources: Map<RetrospectiveSourceKind, IndexedSource>;
} | null {
  const roots = new Set([...run.sources.values()].flat().map((source) => source.candidate.root_id));
  if (roots.size !== 1) return null;
  const sources = new Map<RetrospectiveSourceKind, IndexedSource>();
  for (const kind of RETROSPECTIVE_SOURCE_KINDS) {
    const candidates = run.sources.get(kind) ?? [];
    if (candidates.length > 1) return null;
    if (candidates.length === 1) sources.set(kind, candidates[0]);
  }
  return sources.size > 0 ? { rootId: [...roots][0], sources } : null;
}

function manifestFor(
  correlationId: string,
  sources: Map<RetrospectiveSourceKind, IndexedSource>,
): RetrospectiveObservationManifest {
  return {
    schema_version: "1.0",
    correlation_id: correlationId,
    sources: Object.fromEntries([...sources.entries()].map(([kind, source]) => [
      kind,
      { source_id: source.candidate.source_id, file: source.candidate.relative_file },
    ])),
  };
}

function sourceForCorrelation(source: IndexedSource, correlationId: string): LoadedSource {
  return loadedSource(
    source,
    source.records_by_correlation.get(correlationId) ?? source.secondary_records,
  );
}

function loadedSource(source: IndexedSource, records: LoadedRecord[]): LoadedSource {
  return {
    kind: source.candidate.kind,
    source_id: source.candidate.source_id,
    file: source.file,
    content_sha256: source.content_sha256,
    snapshot_bytes: source.size,
    total_records: source.total_records,
    records: [...records],
    diagnostics: [],
    directory_chain: source.directory_chain,
    malformed_records: source.malformed_records,
    invalid_records: source.invalid_records,
  };
}

function runReport(
  correlationId: string,
  rootId: string | null,
  status: "compiled" | "ambiguous" | "compile_failed",
  completeness: "complete" | "partial" | null,
  presentSources: RetrospectiveSourceKind[],
  reason: string | null,
): RetrospectiveCorpusReport["runs"][number] {
  const present = [...presentSources].sort();
  return {
    correlation_id: correlationId,
    root_id: rootId,
    status,
    completeness,
    present_sources: present,
    missing_sources: RETROSPECTIVE_SOURCE_KINDS.filter((kind) => !present.includes(kind)),
    reason,
  };
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
