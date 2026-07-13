import { MAX_CONTINUATION_TURNS } from "./continuation-persistence.js";
import type { GateActionEnvelope, GateActionPriorProgress, GateActionProgressSnapshot } from "./builder-gate-action-envelope.js";
import type { ContinuationAcceptedTurn, ContinuationBarrier, ContinuationDriverState, ContinuationSnapshot, ContinuationTurnResult } from "./continuation-driver.js";

export const MAX_CONTINUATION_ADAPTER_EVIDENCE_BYTES = 65_536;
export const MAX_CONTINUATION_TURN_RESULT_BYTES = 74_000;

export function validateSnapshot(value: ContinuationSnapshot): ContinuationSnapshot {
  if (!value || typeof value !== "object") throw new Error("continuation runtime returned an invalid canonical snapshot");
  for (const field of ["run_id", "definition_id", "status", "current_step"] as const) if (typeof value[field] !== "string" || value[field].length === 0) throw new Error(`continuation snapshot ${field} must be a non-empty string`);
  if (!new Set(["continue", "waiting", "done", "failed"]).has(value.disposition)) throw new Error("continuation snapshot disposition is invalid");
  if (value.next_action !== null && (typeof value.next_action !== "object" || Array.isArray(value.next_action))) throw new Error("continuation snapshot next_action must be an object or null");
  if (value.gate_action_envelope !== undefined) validateGateActionEnvelope(value.gate_action_envelope);
  return structuredClone(value);
}

function validateGateActionEnvelope(value: GateActionEnvelope): void {
  if (!value || typeof value !== "object" || value.schema_version !== "1.0" || !value.flow || typeof value.flow.current_step !== "string"
    || !value.progress || !Array.isArray(value.progress.canonical_evidence) || !Array.isArray(value.progress.observed_artifacts)) throw new Error("continuation snapshot gate-action envelope is malformed");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 65_536) throw new Error("continuation snapshot gate-action envelope exceeds 65536 bytes");
}

export function validateTurnResult(value: ContinuationTurnResult): ContinuationTurnResult {
  if (!value || typeof value !== "object" || (value.status !== "completed" && value.status !== "wait")) throw new Error("continuation adapter must return status completed or wait");
  if (value.status === "wait") validateBarrier(value.barrier);
  if (value.summary !== undefined && typeof value.summary !== "string") throw new Error("continuation adapter summary must be a string");
  if (value.status === "completed" && value.evidence !== undefined) validateAdapterEvidence(value.evidence);
  if (value.status === "wait" && Object.hasOwn(value, "evidence")) throw new Error("continuation wait results must not include evidence");
  const copy = structuredClone(value);
  if (copy.summary) {
    const characters = Array.from(copy.summary);
    if (characters.length > 2_000) copy.summary = `${characters.slice(0, 1_997).join("")}...`;
  }
  if (Buffer.byteLength(JSON.stringify(copy), "utf8") > MAX_CONTINUATION_TURN_RESULT_BYTES) throw new Error(`continuation adapter result must not exceed ${MAX_CONTINUATION_TURN_RESULT_BYTES} bytes`);
  return copy;
}

function validateAdapterEvidence(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("continuation adapter evidence must be a JSON object");
  let encoded: string;
  try { encoded = JSON.stringify(value); }
  catch { throw new Error("continuation adapter evidence must be JSON-serializable"); }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_CONTINUATION_ADAPTER_EVIDENCE_BYTES) throw new Error(`continuation adapter evidence must not exceed ${MAX_CONTINUATION_ADAPTER_EVIDENCE_BYTES} bytes`);
  const parsed = JSON.parse(encoded) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("continuation adapter evidence must be a JSON object");
}

export function validateBarrier(barrier: ContinuationBarrier): void {
  if (!barrier || typeof barrier !== "object") throw new Error("continuation wait result requires a barrier");
  if (barrier.kind === "pid") {
    if (!Number.isSafeInteger(barrier.pid) || barrier.pid <= 0) throw new Error("continuation pid barrier requires a positive integer pid");
    return;
  }
  if (barrier.kind === "deadline") {
    if (typeof barrier.at !== "string" || !Number.isFinite(Date.parse(barrier.at))) throw new Error("continuation deadline barrier requires an ISO date-time");
    return;
  }
  throw new Error("continuation barrier kind must be pid or deadline");
}

export function validateState(state: ContinuationDriverState): void {
  if (state.schema_version !== "1.0") throw new Error("continuation driver state schema_version must be 1.0");
  assertMaxTurns(state.max_turns);
  if (state.adapter_command_identity !== null && (typeof state.adapter_command_identity !== "string" || state.adapter_command_identity.length === 0)) throw new Error("continuation driver adapter_command_identity must be a non-empty string or null");
  if (!Number.isSafeInteger(state.turns_started) || state.turns_started < 0 || state.turns_started > state.max_turns) throw new Error("continuation driver turns_started is outside its mission budget");
  if (state.active_turn_step !== undefined && state.active_turn_step !== null && (typeof state.active_turn_step !== "string" || state.active_turn_step.length === 0)) throw new Error("continuation driver active_turn_step must be a non-empty string or null");
  if (state.active_turn_public_key_digest !== undefined && state.active_turn_public_key_digest !== null && (typeof state.active_turn_public_key_digest !== "string" || !/^[a-f0-9]{64}$/.test(state.active_turn_public_key_digest))) throw new Error("continuation driver active_turn_public_key_digest must be a SHA-256 hex digest or null");
  if (state.active_turn_phase !== undefined && state.active_turn_phase !== null && !new Set(["prepared", "started", "measured"]).has(state.active_turn_phase)) throw new Error("continuation driver active_turn_phase must be prepared, started, measured, or null");
  if (state.active_turn_progress) validateProgressSnapshot(state.active_turn_progress);
  if (state.active_turn_capture) validateAcceptedTurn(state.active_turn_capture);
  if (state.active_turn_phase === "measured" && !state.active_turn_capture) throw new Error("continuation measured turn must retain its accepted capture");
  if (state.last_progress) validateProgressSnapshot(state.last_progress);
  if (state.prior_progress) validatePriorProgress(state.prior_progress);
  if (!new Set(["active", "waiting", "done", "failed", "budget_exhausted"]).has(state.status)) throw new Error("continuation driver state status is invalid");
  if (state.status === "budget_exhausted" && state.turns_started !== state.max_turns) throw new Error("continuation driver budget_exhausted state must consume max_turns");
  if (state.pending_barrier) validateBarrier(state.pending_barrier);
}

function validateAcceptedTurn(value: ContinuationAcceptedTurn): void {
  if (!value || typeof value !== "object" || value.schema_version !== "1.0" || typeof value.turn_id !== "string" || !Number.isSafeInteger(value.iteration)
    || value.iteration < 1 || value.request?.iteration !== value.iteration || typeof value.captured_at !== "string" || !Number.isFinite(Date.parse(value.captured_at))) throw new Error("continuation accepted-turn capture is malformed");
  validateTurnResult(value.result);
  if (value.progress !== null) validatePriorProgress(value.progress);
}

function validateProgressSnapshot(value: GateActionProgressSnapshot): void {
  if (!value || typeof value !== "object" || typeof value.current_step !== "string" || value.current_step.length === 0
    || !Array.isArray(value.canonical_evidence) || !value.canonical_evidence.every((entry) => typeof entry === "string")
    || !Array.isArray(value.observed_artifacts) || !value.observed_artifacts.every((entry) => typeof entry === "string")) throw new Error("continuation driver progress snapshot is malformed");
}

function validatePriorProgress(value: GateActionPriorProgress): void {
  if (!value || typeof value !== "object" || typeof value.step_advanced !== "boolean" || typeof value.no_progress !== "boolean"
    || !Array.isArray(value.evidence_added) || !value.evidence_added.every((entry) => typeof entry === "string")
    || !Array.isArray(value.artifact_changes) || !value.artifact_changes.every((entry) => typeof entry === "string")
    || !Number.isSafeInteger(value.consecutive_no_progress) || value.consecutive_no_progress < 0 || !new Set(["none", "possible", "stagnant"]).has(value.stagnation)) throw new Error("continuation driver prior progress is malformed");
}

export function assertMissionIdentity(state: Pick<ContinuationDriverState, "run_id" | "definition_id">, snapshot: ContinuationSnapshot): void {
  if (state.run_id !== snapshot.run_id || state.definition_id !== snapshot.definition_id) throw new Error("continuation driver mission identity does not match the canonical Flow run");
}

export function assertMaxTurns(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CONTINUATION_TURNS) throw new Error(`continuation maxTurns must be an integer from 1 through ${MAX_CONTINUATION_TURNS}`);
}
