import { canonicalJson, invocationDigest } from "@kontourai/relay";
import { containsSensitiveCredential } from "./run-correlation.js";
import type { DelegationSourceBinding } from "./delegation-envelope.js";

export const DELEGATION_GROUP_SCHEMA_VERSION = "1.0" as const;
export const DELEGATION_GROUP_MAX_EVENTS = 16384;
export const DELEGATION_GROUP_MAX_BYTES = 32 * 1024 * 1024;

export type GroupReference = {
  id: string;
  digest: string;
  byte_length: number;
  provenance: string;
};
export type GroupEnvelopeReference = { envelope_id: string; generation: number; digest: string };
export type GroupAllocation = { input_tokens: number; output_tokens: number; cost_micros: number };
export type GroupFence = { controller_id: string; epoch: number };
export type GroupTopology =
  | { kind: "independent" }
  | { kind: "flow"; run_id: string; definition_digest: string };
export type GroupSeat = {
  seat_id: string;
  envelope: GroupEnvelopeReference;
  source: DelegationSourceBinding;
  work: { kind: "independent" } | { kind: "flow"; step_id: string };
};
export type GroupPolicy = {
  revision: string;
  digest: string;
  max_attempts: number;
  max_concurrent: number;
  ceilings: GroupAllocation;
  join: "all_terminal";
};
export type DelegationGroupSpec = {
  schema_version: typeof DELEGATION_GROUP_SCHEMA_VERSION;
  group_id: string;
  parent_envelope: GroupEnvelopeReference;
  source: DelegationSourceBinding;
  policy: GroupPolicy;
  topology: GroupTopology;
  seats: GroupSeat[];
  recursion: { kind: "unsupported" };
  worktree_mode: "shared_read_only";
};

export type GroupAction =
  | { kind: "create"; spec: DelegationGroupSpec }
  | { kind: "reserve"; seat_id: string; attempt_id: string; dispatch_intent_id: string; dispatch_plan: GroupReference; allocation: GroupAllocation }
  | { kind: "invoked"; attempt_id: string; invocation: GroupReference }
  | { kind: "mark_unknown"; attempt_id: string; receipt: GroupReference }
  | { kind: "terminal"; attempt_id: string; outcome: "succeeded" | "failed" | "cancelled"; receipt: GroupReference; outputs: GroupReference[] }
  | { kind: "account"; attempt_id: string; usage: GroupAllocation; receipt: GroupReference }
  | { kind: "cancel" }
  | { kind: "cancellation_confirmed"; receipt: GroupReference }
  | { kind: "join" }
  | { kind: "take_control"; successor: GroupFence };
export type GroupRequest = {
  schema_version: typeof DELEGATION_GROUP_SCHEMA_VERSION;
  group_id: string;
  operation_id: string;
  request_digest: string;
  expected_revision: number;
  fence: GroupFence;
  action: GroupAction;
};
export type GroupReceiptKind = "controller" | "invocation" | "authorization" | "readiness" | "budget_enforcement" | "terminal" | "accounting" | "cancellation";
export type GroupConfirmation = { kind: GroupReceiptKind; reference: GroupReference };
export type GroupOutcome = { status: "applied" | "refused"; revision: number; code: string };
export type GroupEvent = { request: GroupRequest; confirmations: GroupConfirmation[]; outcome: GroupOutcome };
export type DelegationGroupLedger = { schema_version: typeof DELEGATION_GROUP_SCHEMA_VERSION; group_id: string; events: GroupEvent[] };
export type GroupAttempt = {
  seat_id: string;
  attempt_id: string;
  dispatch_intent_id: string;
  allocation: GroupAllocation;
  dispatch_plan: GroupReference;
  execution: "invocation_unknown" | "invoked" | "succeeded" | "failed" | "cancelled";
  invocation?: GroupReference;
  terminal_receipt?: GroupReference;
  outputs: GroupReference[];
  usage?: GroupAllocation;
  accounting_receipt?: GroupReference;
};
export type DelegationGroupProjection = {
  spec: DelegationGroupSpec;
  revision: number;
  fence: GroupFence;
  admission: "open" | "closed";
  cancellation: "none" | "requested" | "confirmed";
  execution: "pending" | "active" | "terminal";
  join: "pending" | "ready" | "joined";
  acceptance: "unassessed";
  attempts: GroupAttempt[];
  spent: GroupAllocation;
  held: GroupAllocation;
};

export class DelegationGroupError extends Error {
  constructor(readonly code: string) {
    super(`Delegation group refused: ${code}`);
    this.name = "DelegationGroupError";
  }
}
function requireGroup(condition: unknown, code: string): asserts condition {
  if (!condition) throw new DelegationGroupError(code);
}
function record(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  requireGroup(typeof value === "object" && value !== null && !Array.isArray(value), "invalid_object");
  const result = value as Record<string, unknown>;
  requireGroup(Object.getPrototypeOf(result) === Object.prototype || Object.getPrototypeOf(result) === null, "invalid_object");
  requireGroup(required.every((key) => Object.hasOwn(result, key)), "missing_property");
  requireGroup(Reflect.ownKeys(result).length === Object.keys(result).length, "invalid_object_keys");
  requireGroup(Object.keys(result).every((key) => required.includes(key) || optional.includes(key)), "unknown_property");
  return result;
}
function identifier(value: unknown): asserts value is string {
  requireGroup(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@#-]{0,127}$/.test(value)
    && !containsSensitiveCredential(value), "invalid_identifier");
}
function digest(value: unknown): asserts value is string {
  requireGroup(typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value), "invalid_digest");
}
function integer(value: unknown, max = 1_000_000_000_000): asserts value is number {
  requireGroup(typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max, "invalid_integer");
}
function reference(value: unknown): asserts value is GroupReference {
  const r = record(value, ["id", "digest", "byte_length", "provenance"]);
  identifier(r.id);
  digest(r.digest);
  integer(r.byte_length, 1_073_741_824);
  identifier(r.provenance);
}
function envelopeReference(value: unknown): asserts value is GroupEnvelopeReference {
  const r = record(value, ["envelope_id", "generation", "digest"]);
  requireGroup(typeof r.envelope_id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(r.envelope_id), "invalid_envelope_id");
  integer(r.generation, 4096);
  digest(r.digest);
}
function source(value: unknown): asserts value is DelegationSourceBinding {
  const r = record(value, ["repository_id", "worktree_id", "source_state_id"], ["dirty_state_fingerprint"]);
  for (const key of ["repository_id", "worktree_id", "source_state_id"]) {
    requireGroup(typeof r[key] === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@#/-]{0,254}$/.test(r[key])
      && !containsSensitiveCredential(r[key]), "invalid_source");
  }
  if (r.dirty_state_fingerprint !== undefined) {
    requireGroup(typeof r.dirty_state_fingerprint === "string" && /^[a-f0-9]{64}$/.test(r.dirty_state_fingerprint), "invalid_source_digest");
  }
}
function allocation(value: unknown): asserts value is GroupAllocation {
  const r = record(value, ["input_tokens", "output_tokens", "cost_micros"]);
  Object.values(r).forEach((v) => integer(v));
}
function fence(value: unknown): asserts value is GroupFence {
  const r = record(value, ["controller_id", "epoch"]);
  identifier(r.controller_id);
  integer(r.epoch);
}

/** Reject non-JSON values before using Relay's public canonical digest contract. */
export function groupDigest(value: unknown): string {
  let nodes = 0;
  function visit(item: unknown, depth: number): void {
    requireGroup(++nodes <= 200000 && depth <= 32, "json_bounds");
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "string") { requireGroup(item.length <= 65536, "json_bounds"); return; }
    if (typeof item === "number") { requireGroup(Number.isFinite(item), "invalid_json"); return; }
    if (Array.isArray(item)) {
      requireGroup(item.length <= DELEGATION_GROUP_MAX_EVENTS && Object.keys(item).length === item.length, "json_bounds");
      for (const child of item) visit(child, depth + 1);
      return;
    }
    const r = record(item, [], typeof item === "object" && item !== null ? Object.keys(item) : []);
    for (const [key, child] of Object.entries(r)) {
      requireGroup(key.length <= 128, "json_bounds");
      visit(child, depth + 1);
    }
  }
  visit(value, 0);
  return invocationDigest(value);
}
export function groupPolicyDigest(policy: Omit<GroupPolicy, "digest">): string {
  return groupDigest(policy);
}
export function groupRequestDigest(request: Omit<GroupRequest, "request_digest">): string {
  return groupDigest(request);
}
export function validateDelegationGroupSpec(value: unknown): DelegationGroupSpec {
  const r = record(value, ["schema_version", "group_id", "parent_envelope", "source", "policy", "topology", "seats", "recursion", "worktree_mode"]);
  requireGroup(r.schema_version === DELEGATION_GROUP_SCHEMA_VERSION, "unsupported_schema");
  identifier(r.group_id);
  envelopeReference(r.parent_envelope);
  requireGroup(r.parent_envelope.generation === 0, "unsupported_ancestry");
  source(r.source);
  const p = record(r.policy, ["revision", "digest", "max_attempts", "max_concurrent", "ceilings", "join"]);
  identifier(p.revision);
  digest(p.digest);
  integer(p.max_attempts, 4096);
  integer(p.max_concurrent, 64);
  requireGroup(p.max_attempts > 0 && p.max_concurrent > 0 && p.max_concurrent <= p.max_attempts, "invalid_policy_limits");
  allocation(p.ceilings);
  requireGroup(p.join === "all_terminal", "unsupported_join");
  const { digest: policyHash, ...policyBody } = p;
  requireGroup(policyHash === groupDigest(policyBody), "policy_digest_mismatch");
  const topology = record(r.topology, ["kind"], ["run_id", "definition_digest"]);
  requireGroup(topology.kind === "independent" || topology.kind === "flow", "unsupported_topology");
  if (topology.kind === "independent") record(topology, ["kind"]);
  if (topology.kind === "flow") {
    record(topology, ["kind", "run_id", "definition_digest"]);
    identifier(topology.run_id);
    digest(topology.definition_digest);
  }
  requireGroup(Array.isArray(r.seats) && r.seats.length > 0 && r.seats.length <= 64, "seat_bounds");
  const seats = new Set<string>();
  const envelopes = new Set<string>();
  const steps = new Set<string>();
  for (const value of r.seats) {
    const seat = record(value, ["seat_id", "envelope", "source", "work"]);
    identifier(seat.seat_id);
    requireGroup(!seats.has(seat.seat_id), "duplicate_seat");
    seats.add(seat.seat_id);
    envelopeReference(seat.envelope);
    requireGroup(seat.envelope.generation === 0, "unsupported_ancestry");
    requireGroup(!envelopes.has(seat.envelope.envelope_id) && seat.envelope.envelope_id !== r.parent_envelope.envelope_id, "duplicate_envelope");
    envelopes.add(seat.envelope.envelope_id);
    source(seat.source);
    requireGroup(canonicalJson(seat.source) === canonicalJson(r.source), "unsupported_source_diversity");
    const work = record(seat.work, ["kind"], topology.kind === "flow" ? ["step_id"] : []);
    requireGroup(work.kind === topology.kind, "topology_binding_mismatch");
    if (work.kind === "flow") {
      identifier(work.step_id);
      requireGroup(!steps.has(work.step_id), "duplicate_flow_step");
      steps.add(work.step_id);
    }
  }
  const recursion = record(r.recursion, ["kind"]);
  requireGroup(recursion.kind === "unsupported", "unsupported_recursion");
  requireGroup(r.worktree_mode === "shared_read_only", "unsupported_writer_isolation");
  groupDigest(r);
  return structuredClone(r) as DelegationGroupSpec;
}
export function validateGroupRequest(value: unknown): GroupRequest {
  const r = record(value, ["schema_version", "group_id", "operation_id", "request_digest", "expected_revision", "fence", "action"]);
  requireGroup(r.schema_version === DELEGATION_GROUP_SCHEMA_VERSION, "unsupported_schema");
  identifier(r.group_id);
  identifier(r.operation_id);
  digest(r.request_digest);
  integer(r.expected_revision, DELEGATION_GROUP_MAX_EVENTS);
  fence(r.fence);
  const a = record(r.action, ["kind"], ["spec", "seat_id", "attempt_id", "dispatch_intent_id", "dispatch_plan", "allocation", "invocation", "outcome", "receipt", "outputs", "usage", "successor"]);
  switch (a.kind) {
    case "create":
      record(a, ["kind", "spec"]);
      requireGroup(validateDelegationGroupSpec(a.spec).group_id === r.group_id, "group_id_mismatch");
      break;
    case "reserve":
      record(a, ["kind", "seat_id", "attempt_id", "dispatch_intent_id", "dispatch_plan", "allocation"]);
      identifier(a.seat_id); identifier(a.attempt_id); identifier(a.dispatch_intent_id); reference(a.dispatch_plan); allocation(a.allocation);
      break;
    case "invoked":
      record(a, ["kind", "attempt_id", "invocation"]);
      identifier(a.attempt_id); reference(a.invocation);
      break;
    case "mark_unknown":
      record(a, ["kind", "attempt_id", "receipt"]);
      identifier(a.attempt_id); reference(a.receipt);
      break;
    case "terminal":
      record(a, ["kind", "attempt_id", "outcome", "receipt", "outputs"]);
      identifier(a.attempt_id); reference(a.receipt);
      requireGroup(["succeeded", "failed", "cancelled"].includes(String(a.outcome)), "invalid_terminal");
      requireGroup(Array.isArray(a.outputs) && a.outputs.length <= 16, "output_bounds");
      a.outputs.forEach(reference);
      break;
    case "account":
      record(a, ["kind", "attempt_id", "usage", "receipt"]);
      identifier(a.attempt_id); allocation(a.usage); reference(a.receipt);
      break;
    case "cancel": case "join": record(a, ["kind"]); break;
    case "cancellation_confirmed": record(a, ["kind", "receipt"]); reference(a.receipt); break;
    case "take_control": record(a, ["kind", "successor"]); fence(a.successor); break;
    default: throw new DelegationGroupError("unsupported_operation");
  }
  const { request_digest: hash, ...body } = r;
  requireGroup(hash === groupDigest(body), "request_digest_mismatch");
  return structuredClone(r) as GroupRequest;
}
function validateConfirmations(value: unknown): GroupConfirmation[] {
  requireGroup(Array.isArray(value) && value.length <= 132, "confirmation_bounds");
  for (const entry of value) {
    const r = record(entry, ["kind", "reference"]);
    requireGroup(["controller", "invocation", "authorization", "readiness", "budget_enforcement", "terminal", "accounting", "cancellation"].includes(String(r.kind)), "invalid_confirmation");
    reference(r.reference);
  }
  return structuredClone(value) as GroupConfirmation[];
}
const allocationKeys = ["input_tokens", "output_tokens", "cost_micros"] as const;
function zero(): GroupAllocation { return { input_tokens: 0, output_tokens: 0, cost_micros: 0 }; }
function add(target: GroupAllocation, value: GroupAllocation): void {
  for (const key of ["input_tokens", "output_tokens", "cost_micros"] as const) target[key] += value[key];
}
function terminal(attempt: GroupAttempt): boolean { return !["invocation_unknown", "invoked"].includes(attempt.execution); }
function settlementSlots(projection: DelegationGroupProjection): number {
  return projection.attempts.reduce((sum, a) => sum + (terminal(a) ? 0 : 1) + (a.usage ? 0 : 1), 0)
    + (projection.cancellation === "none" ? 2 : projection.cancellation === "requested" ? 1 : 0);
}
function decision(projection: DelegationGroupProjection, outcome: GroupOutcome) {
  requireGroup(projection.revision + settlementSlots(projection) <= DELEGATION_GROUP_MAX_EVENTS, "ledger_settlement_capacity");
  return { projection, outcome };
}
function refresh(state: DelegationGroupProjection): void {
  state.spent = zero(); state.held = zero();
  for (const attempt of state.attempts) add(attempt.usage ? state.spent : state.held, attempt.usage ?? attempt.allocation);
  if (state.attempts.some((a) => a.usage && allocationKeys.some((key) => (a.usage?.[key] ?? 0) > a.allocation[key]))
    || allocationKeys.some((key) => state.spent[key] + state.held[key] > state.spec.policy.ceilings[key])) {
    state.admission = "closed";
  }
  const noActive = state.attempts.every(terminal);
  const allTerminal = state.spec.seats.every((seat) => state.attempts.some((a) => a.seat_id === seat.seat_id)) && noActive;
  state.execution = noActive && (allTerminal || state.cancellation !== "none") ? "terminal" : state.attempts.length === 0 ? "pending" : "active";
  if (state.join !== "joined") state.join = allTerminal ? "ready" : "pending";
}
function requiredConfirmations(request: GroupRequest, confirmations: GroupConfirmation[]): void {
  const expected: Partial<Record<GroupReceiptKind, number>> = { controller: 1 };
  if (request.action.kind === "create") expected.authorization = request.action.spec.seats.length + 1;
  if (request.action.kind === "reserve") {
    expected.authorization = 2; expected.readiness = 1; expected.budget_enforcement = 1;
  }
  if (request.action.kind === "invoked" || request.action.kind === "mark_unknown") expected.invocation = 1;
  if (request.action.kind === "terminal") expected.terminal = 1;
  if (request.action.kind === "account") expected.accounting = 1;
  if (request.action.kind === "cancellation_confirmed") expected.cancellation = 1;
  const actual: Partial<Record<GroupReceiptKind, number>> = {};
  for (const confirmation of confirmations) actual[confirmation.kind] = (actual[confirmation.kind] ?? 0) + 1;
  requireGroup(canonicalJson(actual) === canonicalJson(expected), "required_capability_receipts");
}

/** Deterministic ledger transition only: no readiness computation, invocation, or trust derivation. */
export function applyGroupRequest(
  current: DelegationGroupProjection | null,
  request: GroupRequest,
  confirmations: GroupConfirmation[],
): { projection: DelegationGroupProjection; outcome: GroupOutcome } {
  request = validateGroupRequest(request);
  confirmations = validateConfirmations(confirmations);
  requiredConfirmations(request, confirmations);
  requireGroup(request.expected_revision === (current?.revision ?? 0), "revision_conflict");
  const action = request.action;
  if (current === null) {
    requireGroup(action.kind === "create", "group_missing");
    const projection: DelegationGroupProjection = {
      spec: validateDelegationGroupSpec(action.spec), revision: 1, fence: request.fence,
      admission: "open", cancellation: "none", execution: "pending", join: "pending", acceptance: "unassessed",
      attempts: [], spent: zero(), held: zero(),
    };
    return decision(projection, { status: "applied", revision: 1, code: "created" });
  }
  requireGroup(request.group_id === current.spec.group_id, "group_id_mismatch");
  requireGroup(canonicalJson(request.fence) === canonicalJson(current.fence), "controller_fence_conflict");
  const state = structuredClone(current);
  state.revision++;
  const refuse = (code: string) => decision(state, { status: "refused", revision: state.revision, code });
  const attempt = "attempt_id" in action ? state.attempts.find((a) => a.attempt_id === action.attempt_id) : undefined;
  switch (action.kind) {
    case "create": return refuse("group_exists");
    case "reserve": {
      if (state.admission !== "open") return refuse("admission_closed");
      if (!state.spec.seats.some((s) => s.seat_id === action.seat_id)) return refuse("seat_missing");
      if (attempt || state.attempts.some((a) => a.dispatch_intent_id === action.dispatch_intent_id)) return refuse("attempt_identity_conflict");
      if (state.attempts.some((a) => a.seat_id === action.seat_id && (!terminal(a) || !a.usage))) return refuse("seat_unresolved");
      if (state.attempts.length >= state.spec.policy.max_attempts) return refuse("attempt_ceiling");
      if (state.attempts.filter((a) => !terminal(a) || !a.usage).length >= state.spec.policy.max_concurrent) return refuse("concurrency_ceiling");
      for (const key of ["input_tokens", "output_tokens", "cost_micros"] as const) {
        if (state.spent[key] + state.held[key] + action.allocation[key] > state.spec.policy.ceilings[key]) return refuse("budget_ceiling");
      }
      state.attempts.push({ seat_id: action.seat_id, attempt_id: action.attempt_id, dispatch_intent_id: action.dispatch_intent_id,
        allocation: action.allocation, dispatch_plan: action.dispatch_plan, execution: "invocation_unknown", outputs: [] });
      break;
    }
    case "invoked":
      if (!attempt) return refuse("attempt_missing");
      if (attempt.execution !== "invocation_unknown" || attempt.invocation) return refuse("invocation_already_resolved");
      attempt.execution = "invoked"; attempt.invocation = action.invocation;
      break;
    case "mark_unknown":
      if (!attempt) return refuse("attempt_missing");
      if (attempt.execution !== "invoked") return refuse("invocation_not_active");
      attempt.execution = "invocation_unknown";
      break;
    case "terminal":
      if (!attempt) return refuse("attempt_missing");
      if (terminal(attempt)) return refuse("terminal_already_recorded");
      attempt.execution = action.outcome; attempt.terminal_receipt = action.receipt; attempt.outputs = action.outputs;
      break;
    case "account":
      if (!attempt || !terminal(attempt)) return refuse("confirmed_terminal_required");
      if (attempt.usage) return refuse("accounting_already_recorded");
      attempt.usage = action.usage; attempt.accounting_receipt = action.receipt;
      break;
    case "cancel":
      state.admission = "closed";
      if (state.cancellation === "none") state.cancellation = "requested";
      break;
    case "cancellation_confirmed":
      if (state.cancellation !== "requested") return refuse("cancellation_not_pending");
      state.cancellation = "confirmed";
      break;
    case "join":
      if (state.cancellation !== "none") return refuse("group_cancelled");
      if (state.join !== "ready" || state.attempts.some((a) => !a.usage)) return refuse("join_not_accounted");
      state.admission = "closed"; state.join = "joined";
      break;
    case "take_control":
      if (action.successor.epoch <= state.fence.epoch) return refuse("fence_must_advance");
      state.fence = action.successor;
      break;
  }
  refresh(state);
  return decision(state, { status: "applied", revision: state.revision, code: action.kind });
}

export function projectDelegationGroup(value: unknown): DelegationGroupProjection {
  const ledger = record(value, ["schema_version", "group_id", "events"]);
  requireGroup(ledger.schema_version === DELEGATION_GROUP_SCHEMA_VERSION, "unsupported_schema");
  identifier(ledger.group_id);
  requireGroup(Array.isArray(ledger.events) && ledger.events.length > 0 && ledger.events.length <= DELEGATION_GROUP_MAX_EVENTS, "ledger_bounds");
  let state: DelegationGroupProjection | null = null;
  const operations = new Set<string>();
  for (const value of ledger.events) {
    const event = record(value, ["request", "confirmations", "outcome"]);
    record(event.outcome, ["status", "revision", "code"]);
    const request = validateGroupRequest(event.request);
    requireGroup(request.group_id === ledger.group_id, "group_id_mismatch");
    requireGroup(!operations.has(request.operation_id), "duplicate_operation");
    operations.add(request.operation_id);
    const next = applyGroupRequest(state, request, validateConfirmations(event.confirmations));
    requireGroup(canonicalJson(next.outcome) === canonicalJson(event.outcome), "outcome_mismatch");
    state = next.projection;
  }
  requireGroup(state, "group_missing");
  return state;
}
export function validateDelegationGroupLedger(value: unknown): DelegationGroupLedger {
  const projection = projectDelegationGroup(value);
  // Closed terminal/account/cancellation events are each smaller than 16 KiB, including
  // their maximum reference lists. Preserve bytes as well as event slots for settlement.
  requireGroup(Buffer.byteLength(canonicalJson(value), "utf8") + 1 + settlementSlots(projection) * 16384 <= DELEGATION_GROUP_MAX_BYTES, "ledger_byte_bounds");
  return structuredClone(value) as DelegationGroupLedger;
}
