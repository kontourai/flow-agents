import type { BuilderFlowRunResult } from "./builder-flow-run-adapter.js";

type JsonRecord = Record<string, unknown>;

export type CanonicalGateProjection = {
  schema: "kontour.flow-agents.canonical_gate_projection";
  version: "1.0";
  run_id: string;
  definition_id: string;
  definition_version: string;
  definition_digest: string;
  status: string;
  current_step: string;
  gates: Array<{
    gate_id: string;
    status: string;
    evidence_refs: string[];
    matched_expectations: Array<{ expectation_id: string; evidence_id: string }>;
    accepted_exception_id?: string;
    diagnostics: Array<{ code: string; severity?: string; path?: string }>;
  }>;
  accepted_exceptions: JsonRecord[];
};

/**
 * Project the synchronized Flow result without re-evaluating gate semantics.
 * The projection is intended for signed host telemetry, not model context.
 */
export function canonicalGateProjection(run: BuilderFlowRunResult): CanonicalGateProjection {
  return {
    schema: "kontour.flow-agents.canonical_gate_projection",
    version: "1.0",
    run_id: run.runId,
    definition_id: run.definitionId,
    definition_version: run.definitionVersion,
    definition_digest: run.definitionDigest,
    status: run.state.status,
    current_step: run.state.current_step,
    gates: run.state.gate_outcomes.map((outcome) => ({
      gate_id: outcome.gate_id,
      status: outcome.status,
      evidence_refs: strings(outcome.evidence_refs),
      matched_expectations: matchedExpectations(outcome.matched_expectations),
      ...(typeof outcome.accepted_exception_id === "string"
        ? { accepted_exception_id: outcome.accepted_exception_id }
        : {}),
      diagnostics: diagnostics(outcome.diagnostics),
    })),
    accepted_exceptions: Array.isArray(run.state.exceptions)
      ? structuredClone(run.state.exceptions.filter(isRecord))
      : [],
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function matchedExpectations(value: unknown): Array<{ expectation_id: string; evidence_id: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => isRecord(entry)
    && typeof entry.expectation_id === "string"
    && typeof entry.evidence_id === "string"
    ? [{ expectation_id: entry.expectation_id, evidence_id: entry.evidence_id }]
    : []);
}

function diagnostics(value: unknown): Array<{ code: string; severity?: string; path?: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.code !== "string") return [];
    return [{
      code: entry.code,
      ...(typeof entry.severity === "string" ? { severity: entry.severity } : {}),
      ...(typeof entry.path === "string" ? { path: entry.path } : {}),
    }];
  });
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
