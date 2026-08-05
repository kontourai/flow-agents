import { createHash } from "node:crypto";
import { validateTrustBundle } from "@kontourai/surface";
import {
  reconstructRun,
  type RunFact,
  type RunFactKind,
} from "./run-reconstruction.js";
import {
  containsSensitiveCredential,
  readRunCorrelation,
  type RunCorrelationEnvelope,
} from "./run-correlation.js";
import { validateTelemetryRecord } from "./telemetry-semantics.js";
import {
  deriveWorkflowOutcome,
  verificationStatusFromFlowGateOutcomes,
} from "./workflow-outcome.js";
import {
  assertPinnedFilePrefix,
  readPinnedFile,
} from "./retrospective-observation-filesystem.js";
import { validateRetrospectiveObservationValue } from "./retrospective-observation-validation.js";
import {
  RETROSPECTIVE_SOURCE_KINDS,
  loadRetrospectiveSources,
  quarantineLoadedRecord,
  sortedObservationDiagnostics,
  type LoadedRecord,
  type LoadedSource,
  type ObservationDiagnostic,
  type RetrospectiveObservationManifest,
  type RetrospectiveSourceKind,
} from "./retrospective-observation-input.js";

export {
  assertPinnedDirectoryChain,
  capturePinnedDirectoryChain,
} from "./retrospective-observation-filesystem.js";
export { readRetrospectiveObservationManifest } from "./retrospective-observation-input.js";
export type {
  ObservationDiagnostic,
  RetrospectiveObservationManifest,
} from "./retrospective-observation-input.js";

const SOURCE_KINDS = RETROSPECTIVE_SOURCE_KINDS;
type SourceKind = RetrospectiveSourceKind;
type JsonRecord = Record<string, unknown>;

type SourceReference = {
  kind: SourceKind;
  source_id: string;
  content_sha256: string;
  total_records: number;
  valid_records: number;
  malformed_records: number;
  invalid_records: number;
};

export type RetrospectiveObservation = {
  schema: "kontour.flow-agents.retrospective-observation";
  version: "1.0";
  observation_id: string;
  correlation_id: string;
  process: {
    status: string | null;
    verification_status: "PASS" | "FAIL" | "NOT_VERIFIED";
  };
  workflow: {
    flow_status: string | null;
    gate_outcome_count: number | null;
    transition_count: number | null;
    route_back_count: number | null;
  };
  activity: {
    turn_count: number | null;
    tool_result_count: number | null;
    delegation_event_count: number | null;
  };
  quality: {
    status: "NOT_VERIFIED";
    reason: "not_independently_evaluated";
  };
  usage: {
    status: "CONFIRMED" | "NOT_VERIFIED";
    authority: "authenticated_runtime_binding" | "fixture_input" | "unavailable";
    semantics: "run_delta" | null;
    model: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    estimated_cost_usd: number | null;
    wall_clock_s: number | null;
    delegation_count: number | null;
  };
  completeness: {
    status: "complete" | "partial";
    present_dimensions: RunFactKind[];
    missing_dimensions: RunFactKind[];
    missing_sources: SourceKind[];
    malformed_records: number;
    invalid_records: number;
  };
  source_refs: SourceReference[];
  diagnostics: ObservationDiagnostic[];
  snapshot_sha256: string;
};


type RuntimeProjection = {
  facts: RunFact[];
  records: JsonRecord[];
  terminalUsage: JsonRecord | null;
};

type FlowProjection = {
  facts: RunFact[];
  state: JsonRecord | null;
  runId: string | null;
};

type TerminalProjection = {
  fact: RunFact | null;
  record: JsonRecord | null;
};

type EconomicsProjection = {
  fact: RunFact | null;
  record: JsonRecord | null;
};

export function compileRetrospectiveObservation(
  manifest: RetrospectiveObservationManifest,
  recordRoot: string,
): RetrospectiveObservation {
  const sources = loadRetrospectiveSources(manifest, recordRoot);
  const observation = compileRetrospectiveObservationFromSources(manifest, sources);
  assertRetrospectiveSourceSnapshotsCurrent(sources);
  return observation;
}

export function compileRetrospectiveObservationFromSources(
  manifest: RetrospectiveObservationManifest,
  sources: LoadedSource[],
): RetrospectiveObservation {
  const byKind = new Map(sources.map((source) => [source.kind, source]));
  const canonical = selectCanonicalEnvelope(byKind, manifest.correlation_id);
  if (!canonical) throw new Error("no producer record carries the manifest correlation_id");
  const runtime = projectRuntime(byKind.get("runtime_events"), canonical);
  const builder = exactCorrelatedRecord(byKind.get("builder_state"), canonical);
  const flow = projectFlow(byKind.get("flow_state"), builder, canonical);
  const terminal = projectTerminal(byKind.get("terminal_outcome"), canonical, builder, flow.state);
  const trustFact = projectTrust(
    byKind.get("trust_bundle"),
    byKind.get("flow_evidence_manifest"),
    flow.runId,
    canonical,
  );
  const economics = projectEconomics(byKind.get("economics"), canonical);
  const facts = [
    ...runtime.facts,
    ...flow.facts,
    ...(trustFact ? [trustFact] : []),
    ...(economics.fact ? [economics.fact] : []),
    ...(terminal.fact ? [terminal.fact] : []),
  ];
  return projectObservation({
    manifest,
    sources,
    runtime,
    flow,
    economics,
    terminal,
    facts,
  });
}

function selectCanonicalEnvelope(
  sources: Map<SourceKind, LoadedSource>,
  correlationId: string,
): RunCorrelationEnvelope | null {
  const candidates: Array<[SourceKind, (record: JsonRecord) => boolean]> = [
    ["terminal_outcome", () => true],
    ["builder_state", () => true],
    ["runtime_events", (record) => record.event_type === "session.usage"],
    ["economics", () => true],
  ];
  for (const [kind, eligible] of candidates) {
    const records = [...(sources.get(kind)?.records ?? [])].reverse();
    for (const loaded of records) {
      if (!eligible(loaded.value)) continue;
      try {
        const correlation = requiredCorrelation(loaded.value, correlationId, kind);
        return correlation;
      } catch {
        // Producer validation records a content-free diagnostic in its own adapter.
      }
    }
  }
  return null;
}

function projectRuntime(source: LoadedSource | undefined, canonical: RunCorrelationEnvelope): RuntimeProjection {
  if (!source) return { facts: [], records: [], terminalUsage: null };
  const facts: RunFact[] = [];
  const records: JsonRecord[] = [];
  let terminalUsage: JsonRecord | null = null;
  for (const loaded of source.records) {
    try {
      const record = validateTelemetryRecord(loaded.value);
      if (record.correlation.status !== "present") continue;
      if (record.correlation.envelope.correlation_id !== canonical.correlation_id) continue;
      assertExactEnvelope(record.correlation.envelope, canonical, "runtime event");
      const eventId = publicRecordId(record.event_id, `${source.source_id}:${loaded.line}`);
      records.push(record);
      if (record.event_type === "session.usage") {
        validateTerminalUsage(record);
        terminalUsage = record;
        facts.push(fact("runtime_session", eventId, record));
      } else if (record.event_type === "turn.user") {
        facts.push(fact("runtime_turn", eventId, record));
      } else if (record.event_type === "tool.result") {
        facts.push(fact("tool", eventId, record));
      } else if (record.event_type === "agent.delegate") {
        facts.push(fact("delegation", eventId, record, childCorrelation(record)));
      }
    } catch (error) {
      quarantineLoadedRecord(source, loaded, error);
    }
  }
  return { facts, records, terminalUsage };
}

function projectFlow(
  source: LoadedSource | undefined,
  builderState: JsonRecord | null,
  canonical: RunCorrelationEnvelope,
): FlowProjection {
  if (!source || !builderState) return { facts: [], state: null, runId: null };
  const flowRunId = presentFlowRunIdentity(builderState, canonical, source);
  if (!flowRunId) return { facts: [], state: null, runId: null };
  const loaded = source.records[0];
  if (!loaded) return { facts: [], state: null, runId: null };
  try {
    validateFlowState(loaded.value, flowRunId);
    const correlation = requiredExactCorrelation(builderState, canonical, "builder_state");
    return {
      facts: [
        { kind: "flow_gate", record_id: `flow-gates:${flowRunId}`, run_correlation: correlation },
        { kind: "route_back", record_id: `route-backs:${flowRunId}`, run_correlation: correlation },
      ],
      state: loaded.value,
      runId: flowRunId,
    };
  } catch (error) {
    quarantineLoadedRecord(source, loaded, error);
    return { facts: [], state: null, runId: null };
  }
}

function projectTrust(
  trustSource: LoadedSource | undefined,
  manifestSource: LoadedSource | undefined,
  flowRunId: string | null,
  canonical: RunCorrelationEnvelope,
): RunFact | null {
  if (!trustSource || !manifestSource || !flowRunId) return null;
  const trust = trustSource.records[0];
  const evidenceManifest = manifestSource.records[0];
  if (!trust || !evidenceManifest) return null;
  try {
    validateTrustBundle(trust.value);
    const evidence = evidenceManifest.value.evidence;
    if (evidenceManifest.value.run_id !== flowRunId || !Array.isArray(evidence)) {
      throw new Error("Flow evidence manifest does not match the exact Flow run");
    }
    const matches = evidence.filter((entry) => exactTrustAttachment(
      entry,
      trust,
      canonical,
    ));
    if (matches.length !== 1) throw new Error("Flow evidence manifest must contain one exact trust attachment");
    const correlation = correlationFromNestedAttachment(matches[0], canonical);
    return {
      kind: "trust",
      record_id: `trust:${flowRunId}`,
      run_correlation: correlation,
    };
  } catch (error) {
    quarantineLoadedRecord(trustSource, trust, error);
    return null;
  }
}

function projectEconomics(
  source: LoadedSource | undefined,
  canonical: RunCorrelationEnvelope,
): EconomicsProjection {
  if (!source) return { fact: null, record: null };
  let selected: JsonRecord | null = null;
  for (const loaded of source.records) {
    try {
      validateEconomicsRecord(loaded.value, canonical);
      selected = loaded.value;
    } catch (error) {
      quarantineLoadedRecord(source, loaded, error);
    }
  }
  return {
    fact: selected ? fact("economics", publicRecordId(selected.run_id, "economics"), selected) : null,
    record: selected,
  };
}

function projectTerminal(
  source: LoadedSource | undefined,
  canonical: RunCorrelationEnvelope,
  builderState: JsonRecord | null,
  flowState: JsonRecord | null,
): TerminalProjection {
  if (!source) return { fact: null, record: null };
  const loaded = source.records[0];
  if (!loaded) return { fact: null, record: null };
  try {
    validateTerminalOutcome(loaded.value, canonical);
    validateTerminalConsistency(loaded.value, builderState, flowState);
    return {
      fact: fact("terminal", publicRecordId(loaded.value.record_id, "terminal"), loaded.value, {
        process_status: String(loaded.value.process_status),
      }),
      record: loaded.value,
    };
  } catch (error) {
    quarantineLoadedRecord(source, loaded, error);
    return { fact: null, record: null };
  }
}

function projectObservation(input: {
  manifest: RetrospectiveObservationManifest;
  sources: LoadedSource[];
  runtime: RuntimeProjection;
  flow: FlowProjection;
  economics: EconomicsProjection;
  terminal: TerminalProjection;
  facts: RunFact[];
}): RetrospectiveObservation {
  const reconstructed = reconstructRun(input.facts, input.manifest.correlation_id);
  const diagnostics = sortedObservationDiagnostics(input.sources.flatMap((source) => source.diagnostics));
  const workflowOutcome = isRecord(input.terminal.record?.workflow_outcome)
    ? input.terminal.record.workflow_outcome
    : null;
  const usage = projectUsage(input.runtime.terminalUsage, input.economics.record);
  const missingSources = SOURCE_KINDS.filter((kind) => !input.sources.some((source) => source.kind === kind));
  const complete = missingSources.length === 0
    && reconstructed.missing_kinds.length === 0
    && input.sources.every((source) => source.malformed_records === 0 && source.invalid_records === 0)
    && diagnostics.length === 0;
  const core = observationCore(input, reconstructed, workflowOutcome, usage, missingSources, diagnostics, complete);
  const observation = { ...core, snapshot_sha256: sha256(stableStringify(core)) };
  validateRetrospectiveObservation(observation);
  return observation;
}

function observationCore(
  input: Parameters<typeof projectObservation>[0],
  reconstructed: ReturnType<typeof reconstructRun>,
  workflowOutcome: JsonRecord | null,
  usage: RetrospectiveObservation["usage"],
  missingSources: SourceKind[],
  diagnostics: ObservationDiagnostic[],
  complete: boolean,
): Omit<RetrospectiveObservation, "snapshot_sha256"> {
  const transitions = Array.isArray(input.flow.state?.transitions) ? input.flow.state.transitions : null;
  const gateOutcomes = Array.isArray(input.flow.state?.gate_outcomes) ? input.flow.state.gate_outcomes : null;
  return {
    schema: "kontour.flow-agents.retrospective-observation",
    version: "1.0",
    observation_id: observationId(input.manifest.correlation_id),
    correlation_id: input.manifest.correlation_id,
    process: {
      status: reconstructed.process_status,
      verification_status: verificationStatus(workflowOutcome?.verification_status),
    },
    workflow: {
      flow_status: publicMetadata(input.flow.state?.status),
      gate_outcome_count: gateOutcomes?.length ?? null,
      transition_count: transitions?.length ?? null,
      route_back_count: transitions?.filter((entry) => isRecord(entry)
        && (entry.type === "route_back" || entry.type === "route-back" || entry.status === "route-back")).length ?? null,
    },
    activity: {
      turn_count: countRuntime(input.runtime.records, "turn.user"),
      tool_result_count: countRuntime(input.runtime.records, "tool.result"),
      delegation_event_count: countRuntime(input.runtime.records, "agent.delegate"),
    },
    quality: { status: "NOT_VERIFIED", reason: "not_independently_evaluated" },
    usage,
    completeness: {
      status: complete ? "complete" : "partial",
      present_dimensions: presentFactKinds(reconstructed),
      missing_dimensions: reconstructed.missing_kinds,
      missing_sources: missingSources,
      malformed_records: input.sources.reduce((count, source) => count + source.malformed_records, 0),
      invalid_records: input.sources.reduce((count, source) => count + source.invalid_records, 0),
    },
    source_refs: sourceReferences(input.sources),
    diagnostics,
  };
}

function projectUsage(
  terminalUsage: JsonRecord | null,
  economics: JsonRecord | null,
): RetrospectiveObservation["usage"] {
  const unavailable = unavailableUsage();
  if (!terminalUsage || !economics || !isRecord(terminalUsage.usage)) return unavailable;
  const usage = terminalUsage.usage;
  const cost = isRecord(economics.cost) ? economics.cost : null;
  const time = isRecord(economics.time) ? economics.time : null;
  const authority = economics.producer_authority;
  const exactRun = usage.scope === "run"
    && usage.semantics === "delta"
    && usage.baseline_status === "present"
    && economics.at === terminalUsage.timestamp
    && cost !== null
    && usageMetricMatches(cost, usage, "input_tokens")
    && usageMetricMatches(cost, usage, "output_tokens");
  if (!exactRun || !["authenticated_runtime_binding", "fixture_input"].includes(String(authority))) {
    return unavailable;
  }
  const modelConfirmed = economics.model === usage.model;
  const timeConfirmed = time !== null && time.wall_clock_s === usage.duration_s;
  const delegationConfirmed = Array.isArray(economics.delegations)
    && economics.delegations.length === usage.delegations;
  const costConfirmed = usageMetricMatches(cost, usage, "estimated_cost_usd");
  const fullyConfirmed = authority === "authenticated_runtime_binding"
    && modelConfirmed
    && timeConfirmed
    && delegationConfirmed
    && costConfirmed;
  return {
    status: fullyConfirmed ? "CONFIRMED" : "NOT_VERIFIED",
    authority: authority as "authenticated_runtime_binding" | "fixture_input",
    semantics: "run_delta",
    model: modelConfirmed ? publicMetadata(usage.model) : null,
    input_tokens: nonNegativeNumber(cost.input_tokens),
    output_tokens: nonNegativeNumber(cost.output_tokens),
    estimated_cost_usd: costConfirmed ? nonNegativeNumber(cost.estimated_cost_usd) : null,
    wall_clock_s: timeConfirmed ? nonNegativeNumber(usage.duration_s) : null,
    delegation_count: delegationConfirmed ? Number(usage.delegations) : null,
  };
}

function validateTerminalUsage(record: JsonRecord): void {
  if (!isRecord(record.usage)
    || record.usage.scope !== "run"
    || record.usage.semantics !== "delta"
    || record.usage.baseline_status !== "present") {
    throw new Error("terminal usage must declare a present run delta baseline");
  }
  if (!isPublicMetadata(record.timestamp)
    || !isPublicMetadata(record.usage.model)
    || nonNegativeNumber(record.usage.duration_s) === null
    || !Number.isSafeInteger(record.usage.delegations)
    || Number(record.usage.delegations) < 0) {
    throw new Error("terminal usage attribution is invalid");
  }
  for (const field of ["input_tokens", "output_tokens"]) {
    if (nonNegativeNumber(record.usage[field]) === null) throw new Error("terminal usage metric is invalid");
  }
  if (record.usage.estimated_cost_usd !== null
    && nonNegativeNumber(record.usage.estimated_cost_usd) === null) {
    throw new Error("terminal usage cost metric is invalid");
  }
}

function validateFlowState(value: JsonRecord, flowRunId: string): void {
  if (value.run_id !== flowRunId
    || !isPublicMetadata(value.status)
    || !Array.isArray(value.gate_outcomes)
    || !value.gate_outcomes.every((entry) => isRecord(entry)
      && isPublicMetadata(entry.gate_id)
      && isPublicMetadata(entry.status))
    || !Array.isArray(value.transitions)
    || !value.transitions.every((entry) => isRecord(entry)
      && isPublicMetadata(entry.from_step)
      && (entry.to_step === null || isPublicMetadata(entry.to_step))
      && isPublicMetadata(entry.status)
      && (entry.type === undefined || isPublicMetadata(entry.type)))) {
    throw new Error("Flow state does not provide a valid exact-run gate and transition projection");
  }
}

function validateEconomicsRecord(value: JsonRecord, canonical: RunCorrelationEnvelope): void {
  requiredExactCorrelation(value, canonical, "economics");
  const cost = isRecord(value.cost) ? value.cost : null;
  const time = isRecord(value.time) ? value.time : null;
  if (value.schema !== "kontour.console.economics"
    || value.version !== "0.2"
    || value.run_id !== canonical.correlation_id
    || value.observation_semantics !== "snapshot"
    || !["authenticated_runtime_binding", "fixture_input", "unavailable"].includes(String(value.producer_authority))
    || !cost
    || !time) {
    throw new Error("economics record shape or authority is invalid");
  }
  for (const metric of ["input_tokens", "output_tokens", "estimated_cost_usd"]) {
    if (nonNegativeNumber(cost[metric]) === null) throw new Error("economics cost metric is invalid");
  }
  if (nonNegativeNumber(time.wall_clock_s) === null) throw new Error("economics wall clock is invalid");
}

function validateTerminalOutcome(value: JsonRecord, canonical: RunCorrelationEnvelope): void {
  requiredExactCorrelation(value, canonical, "terminal_outcome");
  const outcome = isRecord(value.workflow_outcome) ? value.workflow_outcome : null;
  if (value.schema !== "kontour.flow-agents.workflow-outcome"
    || value.version !== "1.0"
    || value.kind !== "terminal"
    || !isPublicMetadata(value.record_id)
    || !["completed", "blocked", "canceled", "failed", "not_verified"].includes(String(value.process_status))
    || !outcome
    || outcome.schema_version !== "1.0"
    || outcome.source !== "canonical_flow_projection"
    || outcome.process_status !== value.process_status
    || !["PASS", "FAIL", "NOT_VERIFIED"].includes(String(outcome.verification_status))
    || outcome.quality_status !== "not_independently_evaluated") {
    throw new Error("terminal workflow outcome is invalid");
  }
}

function validateTerminalConsistency(
  terminal: JsonRecord,
  builderState: JsonRecord | null,
  flowState: JsonRecord | null,
): void {
  const terminalOutcome = isRecord(terminal.workflow_outcome) ? terminal.workflow_outcome : null;
  const builderOutcome = isRecord(builderState?.workflow_outcome) ? builderState.workflow_outcome : null;
  if (!terminalOutcome || !builderOutcome || stableStringify(terminalOutcome) !== stableStringify(builderOutcome)) {
    throw new Error("terminal outcome does not match the exact Builder projection");
  }
  if (!flowState || !isPublicMetadata(flowState.status)) {
    throw new Error("terminal outcome lacks an exact Flow projection");
  }
  const gateStatus = verificationStatusFromFlowGateOutcomes(flowState.gate_outcomes);
  const expected = deriveWorkflowOutcome(flowState.status, gateStatus);
  if (stableStringify(terminalOutcome) !== stableStringify(expected)) {
    throw new Error("terminal outcome contradicts canonical Flow state");
  }
}

function exactCorrelatedRecord(
  source: LoadedSource | undefined,
  canonical: RunCorrelationEnvelope,
): JsonRecord | null {
  if (!source) return null;
  const matches: LoadedRecord[] = [];
  for (const loaded of source.records) {
    try {
      requiredExactCorrelation(loaded.value, canonical, source.kind);
      matches.push(loaded);
    } catch (error) {
      quarantineLoadedRecord(source, loaded, error);
    }
  }
  if (matches.length === 1) return matches[0]!.value;
  if (matches.length > 1) {
    for (const loaded of matches) {
      quarantineLoadedRecord(source, loaded, new Error("source contains ambiguous exact correlated records"));
    }
  }
  return null;
}

function presentFlowRunIdentity(
  builderState: JsonRecord,
  canonical: RunCorrelationEnvelope,
  diagnosticSource: LoadedSource,
): string | null {
  try {
    const correlation = requiredExactCorrelation(builderState, canonical, "builder_state");
    const identity = correlation.identities.flow_run;
    if (identity.status !== "present") throw new Error("Builder correlation has no authoritative Flow run identity");
    return identity.value;
  } catch (error) {
    const loaded = diagnosticSource.records[0];
    if (loaded) quarantineLoadedRecord(diagnosticSource, loaded, error);
    return null;
  }
}

function exactTrustAttachment(
  value: unknown,
  trust: LoadedRecord,
  canonical: RunCorrelationEnvelope,
): boolean {
  if (!isRecord(value)
    || value.kind !== "trust.bundle"
    || value.sha256 !== trust.content_sha256
    || stableStringify(value.bundle) !== stableStringify(trust.value)) return false;
  try {
    validateTrustBundle(value.bundle);
    correlationFromNestedAttachment(value, canonical);
    return true;
  } catch {
    return false;
  }
}

function correlationFromNestedAttachment(
  value: unknown,
  canonical: RunCorrelationEnvelope,
): RunCorrelationEnvelope {
  if (!isRecord(value) || !isRecord(value.analytics)) {
    throw new Error("trust attachment lacks correlation analytics");
  }
  return requiredExactCorrelation(value.analytics, canonical, "trust attachment");
}

function usageMetricMatches(cost: JsonRecord, usage: JsonRecord, metric: string): boolean {
  return nonNegativeNumber(cost[metric]) !== null
    && nonNegativeNumber(usage[metric]) !== null
    && cost[metric] === usage[metric];
}

export function assertRetrospectiveSourceSnapshotsCurrent(sources: LoadedSource[]): void {
  for (const source of sources) {
    if (source.kind === "runtime_events" || source.kind === "economics") {
      assertPinnedFilePrefix(
        source.file,
        `${source.kind} source`,
        source.snapshot_bytes,
        source.content_sha256,
        source.directory_chain,
      );
      continue;
    }
    const contentSha256 = sha256(readPinnedFile(
        source.file,
        `${source.kind} source`,
        16 * 1024 * 1024,
        source.directory_chain,
      ));
    if (contentSha256 !== source.content_sha256) {
      throw new Error(`${source.kind} source changed during compilation`);
    }
  }
}

function sourceReferences(sources: LoadedSource[]): SourceReference[] {
  return sources.map((source) => {
    return {
      kind: source.kind,
      source_id: source.source_id,
      content_sha256: source.content_sha256,
      total_records: source.total_records,
      valid_records: Math.max(0, source.total_records - source.malformed_records - source.invalid_records),
      malformed_records: source.malformed_records,
      invalid_records: source.invalid_records,
    };
  });
}

function fact(
  kind: RunFactKind,
  recordId: string,
  record: JsonRecord,
  extra: Partial<RunFact> = {},
): RunFact {
  return {
    kind,
    record_id: recordId,
    run_correlation: requiredCorrelation(record, undefined, kind),
    ...extra,
  };
}

function childCorrelation(record: JsonRecord): Partial<RunFact> {
  const delegation = isRecord(record.delegation) ? record.delegation : null;
  const child = delegation?.child_correlation_id;
  if (child === undefined) return {};
  assertPublicId(child, "delegation child_correlation_id");
  return { child_correlation_id: child };
}

function requiredCorrelation(
  record: JsonRecord,
  expected: string | undefined,
  label: string,
): RunCorrelationEnvelope {
  const correlation = readRunCorrelation(record);
  if (correlation.status !== "present") throw new Error(`${label} lacks a complete run correlation`);
  if (expected && correlation.envelope.correlation_id !== expected) {
    throw new Error(`${label} correlation_id does not match the manifest`);
  }
  return correlation.envelope;
}

function requiredExactCorrelation(
  record: JsonRecord,
  canonical: RunCorrelationEnvelope,
  label: string,
): RunCorrelationEnvelope {
  const correlation = requiredCorrelation(record, canonical.correlation_id, label);
  assertExactEnvelope(correlation, canonical, label);
  return correlation;
}

function assertExactEnvelope(
  candidate: RunCorrelationEnvelope,
  canonical: RunCorrelationEnvelope,
  label: string,
): void {
  if (stableStringify(candidate) !== stableStringify(canonical)) {
    throw new Error(`${label} does not carry the exact canonical run correlation envelope`);
  }
}

function unavailableUsage(): RetrospectiveObservation["usage"] {
  return {
    status: "NOT_VERIFIED",
    authority: "unavailable",
    semantics: null,
    model: null,
    input_tokens: null,
    output_tokens: null,
    estimated_cost_usd: null,
    wall_clock_s: null,
    delegation_count: null,
  };
}

function presentFactKinds(
  reconstructed: ReturnType<typeof reconstructRun>,
): RunFactKind[] {
  return (Object.keys(reconstructed.facts_by_kind) as RunFactKind[])
    .filter((kind) => reconstructed.facts_by_kind[kind].length > 0);
}

function countRuntime(records: JsonRecord[], eventType: string): number | null {
  return records.length === 0 ? null : records.filter((record) => record.event_type === eventType).length;
}

function verificationStatus(value: unknown): "PASS" | "FAIL" | "NOT_VERIFIED" {
  return value === "PASS" || value === "FAIL" ? value : "NOT_VERIFIED";
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function publicMetadata(value: unknown): string | null {
  return isPublicMetadata(value) ? value : null;
}

function isPublicMetadata(value: unknown): value is string {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:@/+ -]{0,254}$/.test(value)
    && !containsSensitiveCredential(value);
}

function publicRecordId(value: unknown, fallback: string): string {
  return isPublicMetadata(value) ? value : `record:${sha256(fallback)}`;
}

function assertPublicId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$/.test(value)
    || containsSensitiveCredential(value)) {
    throw new Error(`${label} must be a bounded non-sensitive opaque identifier`);
  }
}

export function validateRetrospectiveObservation(value: unknown): RetrospectiveObservation {
  return validateRetrospectiveObservationValue(value);
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

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
