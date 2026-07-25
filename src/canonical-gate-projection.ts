import type { BuilderFlowRunResult } from "./builder-flow-run-adapter.js";

type JsonRecord = Record<string, unknown>;

export type CanonicalAcceptedException = {
  id: string;
  gate_id: string;
  reason: string;
  authority: string;
  accepted_at: string;
  evidence_refs?: string[];
};

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
  accepted_exceptions: CanonicalAcceptedException[];
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
    accepted_exceptions: (Array.isArray(run.state.exceptions)
      ? structuredClone(run.state.exceptions.filter(isRecord))
      : []) as CanonicalAcceptedException[],
  };
}

export function validateCanonicalGateProjection(value: unknown): CanonicalGateProjection {
  if (!isRecord(value)
    || !hasExactKeys(value, ["schema", "version", "run_id", "definition_id", "definition_version", "definition_digest", "status", "current_step", "gates", "accepted_exceptions"])
    || value.schema !== "kontour.flow-agents.canonical_gate_projection"
    || value.version !== "1.0"
    || !nonEmptyString(value.run_id)
    || !nonEmptyString(value.definition_id)
    || !nonEmptyString(value.definition_version)
    || typeof value.definition_digest !== "string" || !/^[a-f0-9]{64}$/.test(value.definition_digest)
    || !nonEmptyString(value.status)
    || !nonEmptyString(value.current_step)
    || !Array.isArray(value.gates)
    || !Array.isArray(value.accepted_exceptions)
    || value.accepted_exceptions.some((entry) => !isRecord(entry))) {
    throw new Error("canonical gate projection is invalid");
  }
  for (const gate of value.gates) validateProjectedGate(gate);
  if (new Set(value.gates.map((gate) => (gate as JsonRecord).gate_id)).size !== value.gates.length) {
    throw new Error("canonical gate projection contains duplicate gate ids");
  }
  for (const exception of value.accepted_exceptions) validateAcceptedException(exception);
  const exceptionsById = new Map(
    value.accepted_exceptions.map((exception) => [(exception as JsonRecord).id, exception as JsonRecord]),
  );
  if (exceptionsById.size !== value.accepted_exceptions.length) {
    throw new Error("canonical gate projection contains duplicate accepted exception ids");
  }
  for (const gate of value.gates as JsonRecord[]) {
    if (gate.accepted_exception_id === undefined) continue;
    const exception = exceptionsById.get(gate.accepted_exception_id);
    if (!exception || exception.gate_id !== gate.gate_id) {
      throw new Error("canonical gate projection accepted exception does not match its gate");
    }
  }
  return structuredClone(value) as CanonicalGateProjection;
}

function validateProjectedGate(value: unknown): void {
  if (!isRecord(value)) throw new Error("canonical gate projection gate is invalid");
  const keys = ["gate_id", "status", "evidence_refs", "matched_expectations", "diagnostics"];
  if (value.accepted_exception_id !== undefined) keys.push("accepted_exception_id");
  if (!hasExactKeys(value, keys)
    || !nonEmptyString(value.gate_id)
    || !nonEmptyString(value.status)
    || !stringArray(value.evidence_refs)
    || !Array.isArray(value.matched_expectations)
    || !Array.isArray(value.diagnostics)
    || (value.accepted_exception_id !== undefined && !nonEmptyString(value.accepted_exception_id))) {
    throw new Error("canonical gate projection gate is invalid");
  }
  for (const match of value.matched_expectations) {
    if (!isRecord(match) || !hasExactKeys(match, ["expectation_id", "evidence_id"])
      || !nonEmptyString(match.expectation_id) || !nonEmptyString(match.evidence_id)) {
      throw new Error("canonical gate projection expectation match is invalid");
    }
  }
  for (const diagnostic of value.diagnostics) validateProjectedDiagnostic(diagnostic);
}

function validateProjectedDiagnostic(value: unknown): void {
  if (!isRecord(value)) throw new Error("canonical gate projection diagnostic is invalid");
  const keys = ["code"];
  if (value.severity !== undefined) keys.push("severity");
  if (value.path !== undefined) keys.push("path");
  if (!hasExactKeys(value, keys) || !nonEmptyString(value.code)
    || (value.severity !== undefined && !nonEmptyString(value.severity))
    || (value.path !== undefined && !nonEmptyString(value.path))) {
    throw new Error("canonical gate projection diagnostic is invalid");
  }
}

function validateAcceptedException(value: unknown): void {
  if (!isRecord(value)) throw new Error("canonical gate projection accepted exception is invalid");
  const keys = ["id", "gate_id", "reason", "authority", "accepted_at"];
  if (value.evidence_refs !== undefined) keys.push("evidence_refs");
  if (!hasExactKeys(value, keys)
    || !nonEmptyString(value.id)
    || !nonEmptyString(value.gate_id)
    || !nonEmptyString(value.reason)
    || !nonEmptyString(value.authority)
    || !canonicalTimestamp(value.accepted_at)
    || (value.evidence_refs !== undefined && !stringArray(value.evidence_refs))) {
    throw new Error("canonical gate projection accepted exception is invalid");
  }
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

function hasExactKeys(value: JsonRecord, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonEmptyString);
}
