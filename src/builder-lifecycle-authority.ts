import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { FlowLifecycleRequest } from "@kontourai/flow";
import type { ActorStruct } from "./cli/assignment-provider.js";

type JsonRecord = Record<string, unknown>;
export type AuthorizedBuilderLifecycleOperation = "cancel" | "archive";

export interface BuilderLifecycleAuthorization {
  schema_version: "1.0";
  operation: AuthorizedBuilderLifecycleOperation;
  project_root: string;
  run_id: string;
  subject: string;
  assignment_actor_key: string;
  assignment_actor: ActorStruct;
  nonce: string;
  expires_at: string;
  request: FlowLifecycleRequest;
  signature: { algorithm: "ed25519"; key_id: string; value: string };
}

export interface CritiqueResolutionAuthorization {
  schema_version: "1.0";
  operation: "resolve-critique";
  project_root: string;
  run_id: string;
  subject: string;
  prior_bundle_sha256: string;
  prior_record_id: string;
  prior_record_hash: string;
  resolving_record_id: string;
  resolving_record_hash: string;
  expected_resolver: string;
  resolved_lane_ids: string[];
  resolved_finding_ids: string[];
  prior_snapshot_sha256: string;
  resolving_snapshot_sha256: string;
  prior_head_sha: string;
  resolving_head_sha: string;
  nonce: string;
  expires_at: string;
  requested_at: string;
  signature: { algorithm: "ed25519"; key_id: string; value: string };
}

export interface CritiqueResolutionHistoryRepairAuthorization {
  schema_version: "1.0";
  operation: "repair-critique-resolution-history";
  project_root: string;
  run_id: string;
  subject: string;
  prior_record_id: string;
  prior_record_hash: string;
  resolving_record_id: string;
  resolving_record_hash: string;
  expected_resolver: string;
  prior_snapshot_sha256: string;
  resolving_snapshot_sha256: string;
  prior_head_sha: string;
  resolving_head_sha: string;
  preimage_bundle_sha256: string;
  preimage_ledger_sha256: string;
  preimage_ledger_length: number;
  preimage_ledger_tail_hash: string;
  current_completion_sha256: string;
  historical_completion_sha256: string;
  historical_completion_request_sha256: string;
  historical_completion_action: "resolve-critique" | "repair-critique-resolution-history";
  historical_completion_result_core_sha256: string;
  historical_attachment_id: string;
  historical_manifest_entry_sha256: string;
  historical_stored_path: string;
  historical_stored_raw_sha256: string;
  historical_stored_bundle_sha256: string;
  historical_durable_operation_id: string;
  historical_durable_completion_record_sha256: string;
  historical_ledger_prefix_length: number;
  historical_ledger_prefix_raw_sha256: string;
  historical_ledger_prefix_canonical_sha256: string;
  historical_ledger_prefix_tail_hash: string;
  historical_critique_projection_version: "1.0";
  historical_critique_projection_sha256: string;
  historical_critique_projection_length: number;
  historical_critique_projection_tail_hash: string;
  current_critique_projection_version: "1.0";
  current_critique_projection_sha256: string;
  current_critique_projection_length: number;
  current_critique_projection_tail_hash: string;
  historical_resolution_edge_projection_sha256: string;
  historical_resolution_edge_projection_count: number;
  current_resolution_edge_projection_sha256: string;
  current_resolution_edge_projection_count: number;
  current_bundle_sha256: string;
  current_ledger_sha256: string;
  current_ledger_length: number;
  current_ledger_tail_hash: string;
  historical_bridge_sha256: string;
  preserved_resolution_sha256: string;
  missing_resolution_event_id: string;
  missing_authorization_sha256: string;
  reason_code: "coordinator-external-ledger-overwrite-v1";
  nonce: string;
  expires_at: string;
  requested_at: string;
  signature: { algorithm: "ed25519"; key_id: string; value: string };
}

type SignedBuilderAuthorization = BuilderLifecycleAuthorization | CritiqueResolutionAuthorization | CritiqueResolutionHistoryRepairAuthorization;

export function critiqueResolutionAuthorizationPayload(value: Omit<CritiqueResolutionAuthorization, "signature">): string {
  return JSON.stringify(value);
}

export function buildUnsignedCritiqueResolutionAuthorization(fields: Omit<CritiqueResolutionAuthorization, "schema_version" | "operation" | "signature">): {
  unsigned: Omit<CritiqueResolutionAuthorization, "signature">; signingPayload: string;
} {
  const unsigned = { schema_version: "1.0", operation: "resolve-critique", ...fields } as const;
  return { unsigned, signingPayload: critiqueResolutionAuthorizationPayload(unsigned) };
}

export function critiqueResolutionHistoryRepairAuthorizationPayload(value: Omit<CritiqueResolutionHistoryRepairAuthorization, "signature">): string {
  return JSON.stringify(value);
}

type LegacyCritiqueResolutionHistoryRepairFields = Omit<CritiqueResolutionHistoryRepairAuthorization,
  "schema_version" | "operation" | "signature"
  | "historical_completion_sha256" | "historical_completion_request_sha256" | "historical_completion_action" | "historical_completion_result_core_sha256"
  | "historical_attachment_id" | "historical_manifest_entry_sha256" | "historical_stored_path" | "historical_stored_raw_sha256" | "historical_stored_bundle_sha256"
  | "historical_durable_operation_id" | "historical_durable_completion_record_sha256"
  | "historical_ledger_prefix_length" | "historical_ledger_prefix_raw_sha256" | "historical_ledger_prefix_canonical_sha256" | "historical_ledger_prefix_tail_hash"
  | "historical_critique_projection_version" | "historical_critique_projection_sha256" | "historical_critique_projection_length" | "historical_critique_projection_tail_hash"
  | "current_critique_projection_version" | "current_critique_projection_sha256" | "current_critique_projection_length" | "current_critique_projection_tail_hash"
  | "historical_resolution_edge_projection_sha256" | "historical_resolution_edge_projection_count"
  | "current_resolution_edge_projection_sha256" | "current_resolution_edge_projection_count"
  | "current_bundle_sha256" | "current_ledger_sha256" | "current_ledger_length" | "current_ledger_tail_hash" | "historical_bridge_sha256"
>;

const HISTORY_REPAIR_BRIDGE_FIELDS = [
  "historical_completion_sha256", "historical_completion_request_sha256", "historical_completion_action", "historical_completion_result_core_sha256",
  "historical_attachment_id", "historical_manifest_entry_sha256", "historical_stored_path", "historical_stored_raw_sha256", "historical_stored_bundle_sha256",
  "historical_durable_operation_id", "historical_durable_completion_record_sha256",
  "historical_ledger_prefix_length", "historical_ledger_prefix_raw_sha256", "historical_ledger_prefix_canonical_sha256", "historical_ledger_prefix_tail_hash",
  "historical_critique_projection_version", "historical_critique_projection_sha256", "historical_critique_projection_length", "historical_critique_projection_tail_hash",
  "current_critique_projection_version", "current_critique_projection_sha256", "current_critique_projection_length", "current_critique_projection_tail_hash",
  "historical_resolution_edge_projection_sha256", "historical_resolution_edge_projection_count",
  "current_resolution_edge_projection_sha256", "current_resolution_edge_projection_count",
  "current_bundle_sha256", "current_ledger_sha256", "current_ledger_length", "current_ledger_tail_hash",
] as const;

export function critiqueResolutionHistoryBridgeDigest(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(Object.fromEntries(HISTORY_REPAIR_BRIDGE_FIELDS.map((field) => [field, value[field]])))).digest("hex");
}

export function buildUnsignedCritiqueResolutionHistoryRepairAuthorization(fields: Omit<CritiqueResolutionHistoryRepairAuthorization, "schema_version" | "operation" | "signature">): {
  unsigned: Omit<CritiqueResolutionHistoryRepairAuthorization, "signature">; signingPayload: string;
};
/** Transitional overload retained only until the later public-request integration wave supplies bridge fields. */
export function buildUnsignedCritiqueResolutionHistoryRepairAuthorization(fields: LegacyCritiqueResolutionHistoryRepairFields): {
  unsigned: Readonly<Record<string, unknown>>; signingPayload: string;
};
export function buildUnsignedCritiqueResolutionHistoryRepairAuthorization(fields: Record<string, unknown>): {
  unsigned: Omit<CritiqueResolutionHistoryRepairAuthorization, "signature">; signingPayload: string;
} {
  if (Object.hasOwn(fields, "historical_bridge_sha256") && fields.historical_bridge_sha256 !== critiqueResolutionHistoryBridgeDigest(fields)) {
    throw new Error("history repair authorization historical_bridge_sha256 does not bind the exact bridge fields");
  }
  const unsigned = { schema_version: "1.0", operation: "repair-critique-resolution-history", ...fields } as const;
  return { unsigned: unsigned as Omit<CritiqueResolutionHistoryRepairAuthorization, "signature">, signingPayload: JSON.stringify(unsigned) };
}

const HISTORY_REPAIR_AUTHORIZATION_FIELDS = [
  "schema_version", "operation", "project_root", "run_id", "subject", "prior_record_id", "prior_record_hash", "resolving_record_id", "resolving_record_hash",
  "expected_resolver", "prior_snapshot_sha256", "resolving_snapshot_sha256", "prior_head_sha", "resolving_head_sha",
  "preimage_bundle_sha256", "preimage_ledger_sha256", "preimage_ledger_length", "preimage_ledger_tail_hash", "current_completion_sha256",
  ...HISTORY_REPAIR_BRIDGE_FIELDS, "historical_bridge_sha256",
  "preserved_resolution_sha256", "missing_resolution_event_id", "missing_authorization_sha256", "reason_code",
  "nonce", "expires_at", "requested_at", "signature",
] as const;

export function loadCritiqueResolutionHistoryRepairAuthorization(fileInput: string, expected: {
  projectRoot: string; runId: string; subject: string; now?: string; allowExpired?: boolean; bindings?: Record<string, unknown>;
}): CritiqueResolutionHistoryRepairAuthorization {
  return validateCritiqueResolutionHistoryRepairAuthorization(readRegularJson(fileInput, "critique resolution history repair authorization", true), expected);
}

export function validateCritiqueResolutionHistoryRepairAuthorization(value: JsonRecord, expected: {
  projectRoot: string; runId: string; subject: string; now?: string; allowExpired?: boolean; bindings?: Record<string, unknown>;
}): CritiqueResolutionHistoryRepairAuthorization {
  const observed = Object.keys(value).sort();
  const required = [...HISTORY_REPAIR_AUTHORIZATION_FIELDS].sort();
  if (JSON.stringify(observed) !== JSON.stringify(required)) throw new Error("critique resolution history repair authorization contains unexpected or missing fields");
  if (value.schema_version !== "1.0" || value.operation !== "repair-critique-resolution-history") throw new Error("critique resolution history repair authorization identity is invalid");
  if (value.project_root !== expected.projectRoot || value.run_id !== expected.runId || value.subject !== expected.subject) throw new Error("critique resolution history repair authorization does not bind the canonical project, run, and subject");
  if (!["resolve-critique", "repair-critique-resolution-history"].includes(String(value.historical_completion_action))) throw new Error("historical completion action is invalid");
  if (value.historical_critique_projection_version !== "1.0" || value.current_critique_projection_version !== "1.0") throw new Error("critique projection version is invalid");
  for (const field of HISTORY_REPAIR_AUTHORIZATION_FIELDS.filter((field) => field.endsWith("_sha256") || field.endsWith("_tail_hash"))) {
    if (!/^[a-f0-9]{64}$/.test(String(value[field]))) throw new Error(`critique resolution history repair authorization ${field} must be a SHA-256 digest`);
  }
  for (const field of HISTORY_REPAIR_AUTHORIZATION_FIELDS.filter((field) => field.endsWith("_length") || field.endsWith("_count"))) {
    if (!Number.isSafeInteger(value[field]) || Number(value[field]) < 0) throw new Error(`critique resolution history repair authorization ${field} must be a non-negative safe integer`);
  }
  for (const field of ["project_root", "run_id", "subject", "prior_record_id", "resolving_record_id", "expected_resolver", "historical_attachment_id", "historical_stored_path", "historical_durable_operation_id", "missing_resolution_event_id", "reason_code", "nonce"]) {
    boundedText(value[field], `authorization.${field}`, field === "subject" ? 2048 : 4096);
  }
  if (value.reason_code !== "coordinator-external-ledger-overwrite-v1") throw new Error("history repair authorization reason is invalid");
  if (value.historical_bridge_sha256 !== critiqueResolutionHistoryBridgeDigest(value)) throw new Error("history repair authorization bridge digest is invalid");
  for (const [field, binding] of Object.entries(expected.bindings ?? {})) if (value[field] !== binding) throw new Error(`history repair authorization ${field} does not match the expected bridge`);
  const requestedAt = dateTime(value.requested_at, "requested_at");
  const expiresAt = dateTime(value.expires_at, "expires_at");
  const now = Date.parse(expected.now ?? new Date().toISOString());
  if (expiresAt < requestedAt) throw new Error("critique resolution history repair authorization expires before it was requested");
  if (now > expiresAt && !expected.allowExpired) throw new Error("critique resolution history repair authorization is expired");
  if (requestedAt > now + 5 * 60_000) throw new Error("critique resolution history repair authorization request time is in the future");
  const signature = validateSignature(value.signature);
  const authorization = { ...Object.fromEntries(HISTORY_REPAIR_AUTHORIZATION_FIELDS.slice(0, -1).map((field) => [field, value[field]])), signature } as unknown as CritiqueResolutionHistoryRepairAuthorization;
  verifySignedAuthorization(authorization, expected.projectRoot, critiqueResolutionHistoryRepairAuthorizationPayload);
  return authorization;
}

export function loadCritiqueResolutionAuthorization(fileInput: string, expected: {
  projectRoot: string; runId: string; subject: string; priorBundleSha256: string;
  priorRecordId: string; priorRecordHash: string; resolvingRecordId: string;
  resolvingRecordHash: string; resolvedLaneIds?: string[]; resolvedFindingIds?: string[];
  priorSnapshotSha256?: string; resolvingSnapshotSha256?: string; priorHeadSha?: string; resolvingHeadSha?: string;
  now?: string; allowExpired?: boolean;
}): CritiqueResolutionAuthorization {
  const value = readRegularJson(fileInput, "critique resolution authorization", true);
  return validateCritiqueResolutionAuthorization(value, expected);
}

export function validateCritiqueResolutionAuthorization(value: JsonRecord, expected: {
  projectRoot: string; runId: string; subject: string; priorBundleSha256: string;
  priorRecordId: string; priorRecordHash: string; resolvingRecordId: string;
  resolvingRecordHash: string; resolvedLaneIds?: string[]; resolvedFindingIds?: string[];
  priorSnapshotSha256?: string; resolvingSnapshotSha256?: string; priorHeadSha?: string; resolvingHeadSha?: string;
  now?: string; allowExpired?: boolean;
}): CritiqueResolutionAuthorization {
  const fields = ["schema_version", "operation", "project_root", "run_id", "subject", "prior_bundle_sha256", "prior_record_id", "prior_record_hash", "resolving_record_id", "resolving_record_hash", "expected_resolver", "resolved_lane_ids", "resolved_finding_ids", "prior_snapshot_sha256", "resolving_snapshot_sha256", "prior_head_sha", "resolving_head_sha", "nonce", "expires_at", "requested_at", "signature"];
  assertExactKeys(value, fields, "authorization");
  if (value.schema_version !== "1.0" || value.operation !== "resolve-critique") throw new Error("critique resolution authorization identity is invalid");
  const exact: Array<[keyof typeof expected, string]> = [["runId", "run_id"], ["subject", "subject"], ["priorBundleSha256", "prior_bundle_sha256"], ["priorRecordId", "prior_record_id"], ["priorRecordHash", "prior_record_hash"], ["resolvingRecordId", "resolving_record_id"], ["resolvingRecordHash", "resolving_record_hash"]];
  if (value.project_root !== expected.projectRoot) throw new Error("critique resolution authorization project_root does not match the canonical project");
  for (const [expectedKey, field] of exact) if (value[field] !== expected[expectedKey]) throw new Error(`critique resolution authorization ${field} does not match the current resolution preimage`);
  const semantic: Array<[keyof typeof expected, string]> = [["resolvedLaneIds", "resolved_lane_ids"], ["resolvedFindingIds", "resolved_finding_ids"]];
  for (const [expectedKey, field] of semantic) {
    const actual = boundedStringArray(value[field], `authorization.${field}`);
    if (expected[expectedKey] && JSON.stringify(actual) !== JSON.stringify(expected[expectedKey])) throw new Error(`critique resolution authorization ${field} does not match the intended resolution edge`);
  }
  for (const [expectedKey, field] of [["priorSnapshotSha256", "prior_snapshot_sha256"], ["resolvingSnapshotSha256", "resolving_snapshot_sha256"], ["priorHeadSha", "prior_head_sha"], ["resolvingHeadSha", "resolving_head_sha"]] as const) {
    boundedText(value[field], `authorization.${field}`, 256);
    if (expected[expectedKey] && value[field] !== expected[expectedKey]) throw new Error(`critique resolution authorization ${field} does not match the intended resolution edge`);
  }
  for (const field of ["project_root", "run_id", "subject", "prior_bundle_sha256", "prior_record_id", "prior_record_hash", "resolving_record_id", "resolving_record_hash", "expected_resolver", "nonce", "expires_at", "requested_at"]) boundedText(value[field], `authorization.${field}`, field === "subject" ? 2048 : 4096);
  for (const field of ["prior_bundle_sha256", "prior_record_hash", "resolving_record_hash", "prior_snapshot_sha256", "resolving_snapshot_sha256"]) {
    if (!/^[a-f0-9]{64}$/.test(String(value[field]))) throw new Error(`critique resolution authorization ${field} must be a SHA-256 digest`);
  }
  const requestedAt = dateTime(value.requested_at, "requested_at");
  const expiresAt = dateTime(value.expires_at, "expires_at");
  const now = Date.parse(expected.now ?? new Date().toISOString());
  if (expiresAt < requestedAt) throw new Error("critique resolution authorization expires before it was requested");
  if (now > expiresAt && !expected.allowExpired) throw new Error("critique resolution authorization is expired");
  if (requestedAt > now + 5 * 60_000) throw new Error("critique resolution authorization request time is in the future");
  const signature = validateSignature(value.signature);
  const authorization = { ...Object.fromEntries(fields.slice(0, -1).map((field) => [field, value[field]])), signature } as unknown as CritiqueResolutionAuthorization;
  verifySignedAuthorization(authorization, expected.projectRoot, critiqueResolutionAuthorizationPayload);
  return authorization;
}

function boundedStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error(`lifecycle authorization ${field} must be an array`);
  const result = value.map((entry, index) => boundedText(entry, `${field}[${index}]`, 256));
  if (new Set(result).size !== result.length || JSON.stringify(result) !== JSON.stringify([...result].sort())) throw new Error(`lifecycle authorization ${field} must contain unique sorted ids`);
  return result;
}

export function loadBuilderLifecycleAuthorization(
  fileInput: string,
  expected: { projectRoot: string; operation: AuthorizedBuilderLifecycleOperation; runId: string; subject: string; actorKey: string; now?: string; allowExpired?: boolean },
): BuilderLifecycleAuthorization {
  const value = readRegularJson(fileInput, "lifecycle authorization");
  assertExactKeys(value, ["schema_version", "operation", "project_root", "run_id", "subject", "assignment_actor_key", "assignment_actor", "nonce", "expires_at", "request", "signature"], "authorization");
  if (value.schema_version !== "1.0") throw new Error("lifecycle authorization schema_version must be 1.0");
  assertEqual(value.operation, expected.operation, "operation");
  assertEqual(value.project_root, expected.projectRoot, "project_root");
  assertEqual(value.run_id, expected.runId, "run_id");
  assertEqual(value.subject, expected.subject, "subject");
  assertEqual(value.assignment_actor_key, expected.actorKey, "assignment_actor_key");
  const assignmentActor = validateActor(value.assignment_actor);
  const request = validateRequest(value.request);
  const nonce = boundedText(value.nonce, "nonce", 256);
  const expiresAt = dateTime(value.expires_at, "expires_at");
  const requestedAt = Date.parse(request.authority.requested_at);
  const now = Date.parse(expected.now ?? new Date().toISOString());
  if (expiresAt < requestedAt) throw new Error("lifecycle authorization expires_at must not precede request.authority.requested_at");
  if (now > expiresAt && !expected.allowExpired) throw new Error("lifecycle authorization is expired");
  if (requestedAt > now + 5 * 60_000) throw new Error("lifecycle authorization request time is in the future");
  const signature = validateSignature(value.signature);
  const authorization = {
    schema_version: "1.0",
    operation: expected.operation,
    project_root: expected.projectRoot,
    run_id: expected.runId,
    subject: expected.subject,
    assignment_actor_key: expected.actorKey,
    assignment_actor: assignmentActor,
    nonce,
    expires_at: value.expires_at as string,
    request,
    signature,
  } satisfies BuilderLifecycleAuthorization;
  verifySignedAuthorization(authorization, expected.projectRoot, builderLifecycleAuthorizationPayload);
  return authorization;
}

export function builderLifecycleAuthorizationPayload(value: Omit<BuilderLifecycleAuthorization, "signature">): string {
  return JSON.stringify(value);
}

/**
 * Build the canonical UNSIGNED authorization for a lifecycle operation, plus the
 * exact bytes an operator must sign (#659 Slice C — "friendly cancel").
 *
 * The whole point is signing-payload parity: `verifyAuthorizationSignature`
 * recomputes the signed bytes from the *loaded* authorization, after normalizing
 * `assignment_actor`/`request` through `validateActor`/`validateRequest` and
 * re-assembling the top-level keys in a fixed order. So we build the unsigned
 * object here through the *same* validators and the *same* key order, and derive
 * `signingPayload` from it — guaranteeing that a signature produced over
 * `signingPayload` will verify. (The validators are idempotent, so re-running
 * them on this already-canonical object at load time yields identical bytes.)
 */
export function buildUnsignedLifecycleAuthorization(fields: {
  operation: AuthorizedBuilderLifecycleOperation;
  project_root: string;
  run_id: string;
  subject: string;
  assignment_actor_key: string;
  assignment_actor: unknown;
  nonce: string;
  expires_at: string;
  request: unknown;
}): { unsigned: Omit<BuilderLifecycleAuthorization, "signature">; signingPayload: string } {
  boundedText(fields.project_root, "project_root", 4096);
  boundedText(fields.run_id, "run_id", 256);
  boundedText(fields.subject, "subject", 2048);
  boundedText(fields.assignment_actor_key, "assignment_actor_key", 256);
  boundedText(fields.nonce, "nonce", 256);
  const assignment_actor = validateActor(fields.assignment_actor);
  const request = validateRequest(fields.request);
  const expiresAt = dateTime(fields.expires_at, "expires_at");
  const requestedAt = Date.parse(request.authority.requested_at);
  if (expiresAt < requestedAt) {
    throw new Error("lifecycle authorization expires_at must not precede request.authority.requested_at");
  }
  const unsigned = {
    schema_version: "1.0",
    operation: fields.operation,
    project_root: fields.project_root,
    run_id: fields.run_id,
    subject: fields.subject,
    assignment_actor_key: fields.assignment_actor_key,
    assignment_actor,
    nonce: fields.nonce,
    expires_at: fields.expires_at,
    request,
  } satisfies Omit<BuilderLifecycleAuthorization, "signature">;
  return { unsigned, signingPayload: builderLifecycleAuthorizationPayload(unsigned) };
}

export function authorizationDigest(authorization: SignedBuilderAuthorization): string {
  return createHash("sha256").update(JSON.stringify(authorization)).digest("hex");
}

function verifySignedAuthorization<T extends SignedBuilderAuthorization>(authorization: T, projectRoot: string, payload: (value: Omit<T, "signature">) => string): void {
  void authorization; void projectRoot; void payload;
  throw new Error("lifecycle authorization is NOT_VERIFIED by package-side validation; the external authority must own the complete transition");
}

function readRegularJson(fileInput: string, label: string, requireProtected = false): JsonRecord {
  const file = path.resolve(fileInput);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
    if (stat.size > 64 * 1024) throw new Error(`${label} exceeds 64 KiB`);
    if (requireProtected && (stat.mode & 0o022) !== 0) throw new Error(`${label} must not be group- or world-writable`);
    const value = JSON.parse(fs.readFileSync(descriptor, "utf8")) as unknown;
    if (!isRecord(value)) throw new Error(`${label} must be a JSON object`);
    return value;
  } finally {
    fs.closeSync(descriptor);
  }
}

function validateActor(value: unknown): ActorStruct {
  if (!isRecord(value)) throw new Error("lifecycle authorization assignment_actor must be an object");
  assertExactKeys(value, ["runtime", "session_id", "host", "human"], "assignment_actor");
  for (const field of ["runtime", "session_id", "host"] as const) boundedText(value[field], `assignment_actor.${field}`, 256);
  if (value.human !== undefined && value.human !== null) boundedText(value.human, "assignment_actor.human", 256);
  // Claims persisted before explicit-null canonicalization omit `human`. Keep
  // that record untouched, but sign the canonical semantic identity.
  return { runtime: value.runtime as string, session_id: value.session_id as string, host: value.host as string, human: value.human == null ? null : value.human as string };
}

function validateRequest(value: unknown): FlowLifecycleRequest {
  if (!isRecord(value)) throw new Error("lifecycle authorization request must be an object");
  assertExactKeys(value, ["reason", "authority"], "request");
  const reason = boundedText(value.reason, "request.reason", 4096);
  if (!isRecord(value.authority)) throw new Error("lifecycle authorization request.authority must be an object");
  assertExactKeys(value.authority, ["kind", "actor", "request_ref", "requested_at"], "request.authority");
  if (value.authority.kind !== "user_request" && value.authority.kind !== "operator_request") throw new Error("lifecycle authorization request.authority.kind must be user_request or operator_request");
  const actor = boundedText(value.authority.actor, "request.authority.actor", 256);
  const requestRef = boundedText(value.authority.request_ref, "request.authority.request_ref", 2048);
  dateTime(value.authority.requested_at, "request.authority.requested_at");
  return { reason, authority: { kind: value.authority.kind, actor, request_ref: requestRef, requested_at: value.authority.requested_at as string } };
}

function validateSignature(value: unknown): BuilderLifecycleAuthorization["signature"] {
  if (!isRecord(value)) throw new Error("lifecycle authorization signature must be an object");
  assertExactKeys(value, ["algorithm", "key_id", "value"], "signature");
  if (value.algorithm !== "ed25519") throw new Error("lifecycle authorization signature.algorithm must be ed25519");
  return { algorithm: "ed25519", key_id: boundedText(value.key_id, "signature.key_id", 256), value: boundedText(value.value, "signature.value", 1024) };
}

function assertEqual(actual: unknown, expected: string, field: string): void {
  if (actual !== expected) throw new Error(`lifecycle authorization ${field} does not match the requested Builder operation`);
}

function assertExactKeys(value: JsonRecord, allowed: string[], field: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) throw new Error(`lifecycle authorization ${field} contains unsupported field ${unexpected[0]}`);
}

function dateTime(value: unknown, field: string): number {
  const text = boundedText(value, field, 128);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`lifecycle authorization ${field} must be a date-time`);
  return Date.parse(text);
}

function boundedText(value: unknown, field: string, limit: number): string {
  if (!nonEmpty(value) || [...value].length > limit) throw new Error(`lifecycle authorization ${field} must be a non-empty string of at most ${limit} characters`);
  return value;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
