import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, createPublicKey, verify } from "node:crypto";
import type { FlowLifecycleRequest } from "@kontourai/flow";
import type { ActorStruct } from "./cli/assignment-provider.js";
import { durableFlowAgentsRoot } from "./lib/local-artifact-root.js";

type JsonRecord = Record<string, unknown>;
export type AuthorizedBuilderLifecycleOperation = "cancel" | "archive";

export interface BuilderLifecycleAuthorization {
  schema_version: "1.0";
  operation: AuthorizedBuilderLifecycleOperation;
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
  run_id: string;
  subject: string;
  prior_bundle_sha256: string;
  prior_record_id: string;
  prior_record_hash: string;
  resolving_record_id: string;
  resolving_record_hash: string;
  expected_resolver: string;
  nonce: string;
  expires_at: string;
  requested_at: string;
  signature: { algorithm: "ed25519"; key_id: string; value: string };
}

type SignedBuilderAuthorization = BuilderLifecycleAuthorization | CritiqueResolutionAuthorization;

export function critiqueResolutionAuthorizationPayload(value: Omit<CritiqueResolutionAuthorization, "signature">): string {
  return JSON.stringify(value);
}

export function buildUnsignedCritiqueResolutionAuthorization(fields: Omit<CritiqueResolutionAuthorization, "schema_version" | "operation" | "signature">): {
  unsigned: Omit<CritiqueResolutionAuthorization, "signature">; signingPayload: string;
} {
  const unsigned = { schema_version: "1.0", operation: "resolve-critique", ...fields } as const;
  return { unsigned, signingPayload: critiqueResolutionAuthorizationPayload(unsigned) };
}

export function loadCritiqueResolutionAuthorization(fileInput: string, expected: {
  projectRoot: string; runId: string; subject: string; priorBundleSha256: string;
  priorRecordId: string; priorRecordHash: string; resolvingRecordId: string;
  resolvingRecordHash: string; now?: string; allowExpired?: boolean;
}): CritiqueResolutionAuthorization {
  const value = readRegularJson(fileInput, "critique resolution authorization", true);
  const fields = ["schema_version", "operation", "run_id", "subject", "prior_bundle_sha256", "prior_record_id", "prior_record_hash", "resolving_record_id", "resolving_record_hash", "expected_resolver", "nonce", "expires_at", "requested_at", "signature"];
  assertExactKeys(value, fields, "authorization");
  if (value.schema_version !== "1.0" || value.operation !== "resolve-critique") throw new Error("critique resolution authorization identity is invalid");
  const exact: Array<[keyof typeof expected, string]> = [["runId", "run_id"], ["subject", "subject"], ["priorBundleSha256", "prior_bundle_sha256"], ["priorRecordId", "prior_record_id"], ["priorRecordHash", "prior_record_hash"], ["resolvingRecordId", "resolving_record_id"], ["resolvingRecordHash", "resolving_record_hash"]];
  for (const [expectedKey, field] of exact) if (value[field] !== expected[expectedKey]) throw new Error(`critique resolution authorization ${field} does not match the current resolution preimage`);
  for (const field of fields.slice(2, 12)) boundedText(value[field], `authorization.${field}`, field === "subject" ? 2048 : 256);
  for (const field of ["prior_bundle_sha256", "prior_record_hash", "resolving_record_hash"]) {
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
  verifySignedAuthorization(authorization, lifecycleAuthorityKeysPath(expected.projectRoot), critiqueResolutionAuthorizationPayload);
  return authorization;
}

export function lifecycleAuthorityKeysPath(projectRoot: string): string {
  return path.join(durableFlowAgentsRoot(projectRoot), "lifecycle-authority-keys.json");
}

export function loadBuilderLifecycleAuthorization(
  fileInput: string,
  expected: { projectRoot: string; operation: AuthorizedBuilderLifecycleOperation; runId: string; subject: string; actorKey: string; now?: string; allowExpired?: boolean },
): BuilderLifecycleAuthorization {
  const value = readRegularJson(fileInput, "lifecycle authorization");
  assertExactKeys(value, ["schema_version", "operation", "run_id", "subject", "assignment_actor_key", "assignment_actor", "nonce", "expires_at", "request", "signature"], "authorization");
  if (value.schema_version !== "1.0") throw new Error("lifecycle authorization schema_version must be 1.0");
  assertEqual(value.operation, expected.operation, "operation");
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
    run_id: expected.runId,
    subject: expected.subject,
    assignment_actor_key: expected.actorKey,
    assignment_actor: assignmentActor,
    nonce,
    expires_at: value.expires_at as string,
    request,
    signature,
  } satisfies BuilderLifecycleAuthorization;
  verifyAuthorizationSignature(authorization, lifecycleAuthorityKeysPath(expected.projectRoot));
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
  run_id: string;
  subject: string;
  assignment_actor_key: string;
  assignment_actor: unknown;
  nonce: string;
  expires_at: string;
  request: unknown;
}): { unsigned: Omit<BuilderLifecycleAuthorization, "signature">; signingPayload: string } {
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

export function assertAuthorizationUnused(artifactRoot: string, authorization: SignedBuilderAuthorization): void {
  if (!readAuthorizationConsumption(artifactRoot, authorization)) return;
  throw new Error("lifecycle authorization nonce has already been consumed");
}

export function readAuthorizationConsumption(artifactRoot: string, authorization: SignedBuilderAuthorization): JsonRecord | null {
  const file = consumedAuthorizationPath(artifactRoot, authorization);
  if (!pathExistsNoFollow(file)) return null;
  const record = readRegularJson(file, "consumed lifecycle authorization record");
  if (record.run_id !== authorization.run_id
    || record.operation !== authorization.operation
    || record.nonce !== authorization.nonce
    || record.key_id !== authorization.signature.key_id
    || record.authorization_sha256 !== authorizationDigest(authorization)) {
    throw new Error("consumed lifecycle authorization record does not match its integrity key");
  }
  return record;
}

export function recordAuthorizationConsumed(artifactRoot: string, authorization: SignedBuilderAuthorization, at = new Date().toISOString()): void {
  const file = consumedAuthorizationPath(artifactRoot, authorization);
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !pathIsWithin(fs.realpathSync(directory), fs.realpathSync(artifactRoot))) throw new Error("lifecycle authorization registry directory is unsafe");
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify({ run_id: authorization.run_id, operation: authorization.operation, nonce: authorization.nonce, key_id: authorization.signature.key_id, authorization_sha256: authorizationDigest(authorization), at })}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.linkSync(temporary, file);
    const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function consumedAuthorizationPath(artifactRoot: string, authorization: SignedBuilderAuthorization): string {
  const integrityKey = createHash("sha256").update(authorization.run_id).update("\0").update(authorization.nonce).digest("hex");
  return path.join(artifactRoot, "lifecycle-authority", "consumed", `${integrityKey}.json`);
}

export function authorizationDigest(authorization: SignedBuilderAuthorization): string {
  return createHash("sha256").update(JSON.stringify(authorization)).digest("hex");
}

function verifyAuthorizationSignature(authorization: BuilderLifecycleAuthorization, keysFile: string): void {
  verifySignedAuthorization(authorization, keysFile, builderLifecycleAuthorizationPayload);
}

function verifySignedAuthorization<T extends SignedBuilderAuthorization>(authorization: T, keysFile: string, payload: (value: Omit<T, "signature">) => string): void {
  const registry = readRegularJson(keysFile, "lifecycle authority key registry", true);
  assertExactKeys(registry, ["schema_version", "keys"], "key registry");
  if (registry.schema_version !== "1.0" || !Array.isArray(registry.keys)) throw new Error("lifecycle authority key registry must contain schema_version 1.0 and keys[]");
  const key = registry.keys.find((candidate) => isRecord(candidate) && candidate.id === authorization.signature.key_id);
  if (!isRecord(key) || key.algorithm !== "ed25519" || typeof key.public_key_pem !== "string" || key.public_key_pem.trim().length === 0) {
    throw new Error(`lifecycle authorization key ${authorization.signature.key_id} is not trusted`);
  }
  const { signature: _signature, ...unsigned } = authorization;
  let verified = false;
  try {
    verified = verify(null, Buffer.from(payload(unsigned as Omit<T, "signature">)), createPublicKey(key.public_key_pem), Buffer.from(authorization.signature.value, "base64"));
  } catch {
    verified = false;
  }
  if (!verified) throw new Error("lifecycle authorization signature is invalid");
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
  if (!Object.prototype.hasOwnProperty.call(value, "human")) throw new Error("lifecycle authorization assignment_actor.human is required");
  for (const field of ["runtime", "session_id", "host"] as const) boundedText(value[field], `assignment_actor.${field}`, 256);
  if (value.human !== undefined && value.human !== null) boundedText(value.human, "assignment_actor.human", 256);
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

function pathExistsNoFollow(candidate: string): boolean {
  try { fs.lstatSync(candidate); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function pathIsWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
