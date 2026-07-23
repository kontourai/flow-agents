import { readRunCorrelation, type RunCorrelationPresence } from "./run-correlation.js";

export const TOOL_RESULT_STATUSES = [
  "completed",
  "failed",
  "canceled",
  "blocked",
  "unknown",
] as const;
export const USAGE_SEMANTICS = ["delta", "snapshot"] as const;
export const USAGE_METRICS = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "estimated_cost_usd",
] as const;

export type ToolResultStatus = (typeof TOOL_RESULT_STATUSES)[number];
export type UsageSemantics = (typeof USAGE_SEMANTICS)[number];
export type UsageMetric = (typeof USAGE_METRICS)[number];

export type UsageObservation = {
  stream_id: string;
  sequence: number;
  semantics: UsageSemantics;
  values: Partial<Record<UsageMetric, number>>;
};

export type TelemetryDiagnostic = {
  index: number;
  code: "malformed_record";
  reason: string;
};

export type ValidatedTelemetryRecord = Record<string, unknown> & {
  event_type: string;
  correlation: RunCorrelationPresence;
};

export function validateTelemetryRecord(value: unknown): ValidatedTelemetryRecord {
  if (!isRecord(value) || typeof value.event_type !== "string" || value.event_type.length === 0) {
    throw new Error("record must contain a non-empty event_type");
  }
  if (value.event_type === "tool.result") validateToolResult(value.tool);
  if (value.usage !== undefined) validateUsageObject(value.usage);
  return {
    ...structuredClone(value),
    correlation: readRunCorrelation(value),
  } as ValidatedTelemetryRecord;
}

export function partitionTelemetryRecords(values: readonly unknown[]): {
  valid: ValidatedTelemetryRecord[];
  quarantine: TelemetryDiagnostic[];
} {
  const valid: ValidatedTelemetryRecord[] = [];
  const quarantine: TelemetryDiagnostic[] = [];
  values.forEach((value, index) => {
    try {
      valid.push(validateTelemetryRecord(value));
    } catch (error) {
      quarantine.push({
        index,
        code: "malformed_record",
        reason: error instanceof Error ? error.message : "record validation failed",
      });
    }
  });
  return { valid, quarantine };
}

export function reduceUsageObservations(observations: readonly UsageObservation[]): Record<UsageMetric, number> {
  const deltas: UsageObservation[] = [];
  const snapshots = new Map<string, UsageObservation>();
  for (const observation of observations) {
    validateUsageObservation(observation);
    if (observation.semantics === "delta") {
      deltas.push(observation);
      continue;
    }
    const current = snapshots.get(observation.stream_id);
    if (!current || observation.sequence > current.sequence) snapshots.set(observation.stream_id, observation);
  }
  const totals = Object.fromEntries(USAGE_METRICS.map((metric) => [metric, 0])) as Record<UsageMetric, number>;
  for (const observation of [...deltas, ...snapshots.values()]) {
    for (const metric of USAGE_METRICS) totals[metric] += observation.values[metric] ?? 0;
  }
  return totals;
}

function validateToolResult(value: unknown): void {
  if (!isRecord(value)) throw new Error("tool.result must contain a tool object");
  if (!(TOOL_RESULT_STATUSES as readonly unknown[]).includes(value.status)) {
    throw new Error("tool.result status must be completed, failed, canceled, blocked, or unknown");
  }
  if (value.duration_ms !== null && (!Number.isFinite(value.duration_ms) || Number(value.duration_ms) < 0)) {
    throw new Error("tool.result duration_ms must be a non-negative number or null");
  }
  if (value.exit_code !== null && !Number.isInteger(value.exit_code)) {
    throw new Error("tool.result exit_code must be an integer or null");
  }
}

function validateUsageObject(value: unknown): void {
  if (!isRecord(value) || !(USAGE_SEMANTICS as readonly unknown[]).includes(value.semantics)) {
    throw new Error("usage must declare delta or snapshot semantics");
  }
}

function validateUsageObservation(value: UsageObservation): void {
  if (!isRecord(value) || typeof value.stream_id !== "string" || value.stream_id.length === 0) {
    throw new Error("usage observation requires a stream_id");
  }
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 0) {
    throw new Error("usage observation sequence must be a non-negative safe integer");
  }
  if (!(USAGE_SEMANTICS as readonly unknown[]).includes(value.semantics)) {
    throw new Error("usage observation semantics must be delta or snapshot");
  }
  if (!isRecord(value.values)) throw new Error("usage observation values must be an object");
  for (const [key, metric] of Object.entries(value.values)) {
    if (!(USAGE_METRICS as readonly string[]).includes(key)
      || typeof metric !== "number"
      || !Number.isFinite(metric)
      || metric < 0) {
      throw new Error("usage observation contains an invalid metric");
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
