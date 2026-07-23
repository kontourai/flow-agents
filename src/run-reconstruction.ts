import {
  readRunCorrelation,
  validateRunCorrelationEnvelope,
  type RunCorrelationEnvelope,
} from "./run-correlation.js";

export const RUN_FACT_KINDS = [
  "runtime_session",
  "runtime_turn",
  "tool",
  "flow_gate",
  "route_back",
  "delegation",
  "trust",
  "economics",
  "terminal",
] as const;

export type RunFactKind = (typeof RUN_FACT_KINDS)[number];

export type RunFact = {
  kind: RunFactKind;
  record_id: string;
  run_correlation: RunCorrelationEnvelope;
  child_correlation_id?: string;
  process_status?: string;
};

export type ReconstructedRun = {
  correlation_id: string;
  facts: RunFact[];
  facts_by_kind: Record<RunFactKind, RunFact[]>;
  missing_kinds: RunFactKind[];
  child_correlation_ids: string[];
  process_status: string | null;
};

export type IndependentEvaluation = {
  correlation_id: string;
  eval_cell_id: string;
  attempt_id: string;
  grade_status: "accepted" | "rejected" | "not_verified";
  score?: number;
};

export type EvaluatedRun = {
  run: ReconstructedRun;
  evaluation: IndependentEvaluation;
  process_complete: boolean;
  task_quality_accepted: boolean;
};

export function reconstructRun(facts: readonly unknown[], correlationId: string): ReconstructedRun {
  if (!isSafeId(correlationId)) throw new Error("correlationId must be a bounded opaque identifier");
  const selected: RunFact[] = [];
  for (const value of facts) {
    const fact = validateRunFact(value);
    const correlation = readRunCorrelation(fact);
    if (correlation.status === "present" && correlation.envelope.correlation_id === correlationId) {
      selected.push(fact);
    }
  }
  const factsByKind = Object.fromEntries(RUN_FACT_KINDS.map((kind) => [
    kind,
    selected.filter((fact) => fact.kind === kind),
  ])) as Record<RunFactKind, RunFact[]>;
  const missingKinds = RUN_FACT_KINDS.filter((kind) => factsByKind[kind].length === 0);
  const childIds = [...new Set(factsByKind.delegation
    .map((fact) => fact.child_correlation_id)
    .filter((value): value is string => typeof value === "string"))];
  const terminal = factsByKind.terminal.at(-1);
  return {
    correlation_id: correlationId,
    facts: selected,
    facts_by_kind: factsByKind,
    missing_kinds: missingKinds,
    child_correlation_ids: childIds,
    process_status: terminal?.process_status ?? null,
  };
}

export function joinIndependentEvaluation(
  run: ReconstructedRun,
  evaluation: IndependentEvaluation,
): EvaluatedRun {
  validateEvaluation(evaluation);
  if (evaluation.correlation_id !== run.correlation_id) {
    throw new Error("evaluation correlation_id does not match the reconstructed run");
  }
  return {
    run: structuredClone(run),
    evaluation: structuredClone(evaluation),
    process_complete: ["completed", "failed", "canceled"].includes(run.process_status ?? ""),
    task_quality_accepted: evaluation.grade_status === "accepted",
  };
}

function validateRunFact(value: unknown): RunFact {
  if (!isRecord(value) || !(RUN_FACT_KINDS as readonly unknown[]).includes(value.kind)) {
    throw new Error("run fact kind is invalid");
  }
  if (!isSafeId(value.record_id)) throw new Error("run fact record_id is invalid");
  validateRunCorrelationEnvelope(value.run_correlation);
  if (value.child_correlation_id !== undefined && !isSafeId(value.child_correlation_id)) {
    throw new Error("run fact child_correlation_id is invalid");
  }
  if (value.process_status !== undefined && !isSafeId(value.process_status)) {
    throw new Error("run fact process_status is invalid");
  }
  for (const forbidden of ["eval_cell_id", "attempt_id", "experiment_arm", "grade_status", "score"]) {
    if (forbidden in value) throw new Error(`run fact must not contain evaluation field ${forbidden}`);
  }
  return structuredClone(value) as RunFact;
}

function validateEvaluation(value: IndependentEvaluation): void {
  if (!isRecord(value)
    || !isSafeId(value.correlation_id)
    || !isSafeId(value.eval_cell_id)
    || !isSafeId(value.attempt_id)
    || !["accepted", "rejected", "not_verified"].includes(String(value.grade_status))) {
    throw new Error("independent evaluation is invalid");
  }
  if (value.score !== undefined && (!Number.isFinite(value.score) || value.score < 0 || value.score > 1)) {
    throw new Error("independent evaluation score must be between 0 and 1");
  }
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
