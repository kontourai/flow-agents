import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, createPrivateKey, createPublicKey, verify } from "node:crypto";
import { execFileSync, spawn as spawnChild } from "node:child_process";

export const LIFECYCLE_AUTHORITY_PROTOCOL_VERSION = "1.0";
export const SEALED_EXECUTION_API_REVISION = "flow-agents.sealed-execution-api.v1";
export const LIFECYCLE_AUTHORITY_HELPER_PATH = "/usr/local/libexec/kontourai/flow-agents-lifecycle-authority-v1";
export const LIFECYCLE_AUTHORITY_SUDO_COMMAND = "/usr/bin/sudo";
/** Root-provisioned public half of the coordinator completion signing key. */
export const LIFECYCLE_AUTHORITY_COMPLETION_VERIFICATION_KEY_PATH = "/etc/kontourai/flow-agents-lifecycle-authority-v1/completion-verification-key.pem";
const ACTIONS = new Set(["cancel", "archive", "resolve-critique", "repair-critique-resolution-history", "reseal-verification-evidence", "recover-exact-current-completion", "publish-provisional-delivery", "authorize-workflow-evidence", "execute-sealed-workload", "merge-change"]);

export type ExternalLifecycleAuthorityRequest = Readonly<Record<string, unknown> & { action: string; project_root: string }>;
export interface ExternalLifecycleMutationResult {
  run_id: string;
  operation_status: "applied" | "replayed";
  /** Present for merge-change: the signed action authorized by this response. */
  authorized_action_id?: string;
  /** Immutable coordinator completion, structurally bound by the package without package-side writes. */
  completion: JsonRecord;
  /** A fixed-size execution receipt: bounded policy artifacts, never provider output. */
  safe_result?: SealedExecutionSafeResult;
}
type JsonRecord = Record<string, unknown>;

export interface SealedExecutionSafeResult {
  status: "ok" | "exit_nonzero" | "timeout" | "output_limit" | "spawn_error" | "malformed_result" | "interrupted";
  exit_code: number | null;
  runtime_ms: number;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_sha256: string;
  stderr_sha256: string;
  projection: JsonRecord | null;
  projection_sha256: string | null;
  /** Coordinator-owned, completion-signed sealed-stage provenance. */
  execution_provenance?: SealedExecutionProvenance;
}
export interface SealedExecutionProvenance {
  invocation_manifest_sha256: string | null;
  controller_state_sha256: string | null;
}

const SEALED_SAFE_RESULT_FIELDS = ["status", "exit_code", "runtime_ms", "stdout_bytes", "stderr_bytes", "projection", "projection_sha256", "stdout_sha256", "stderr_sha256"];
const SEALED_PROJECTION_FIELDS = ["schema_version", "kind", "outcome", "metrics", "artifacts", "policy_chain"];
const SEALED_ARTIFACT_FIELDS = ["id", "sha256", "bytes", "media_type", "content_base64"];
const SEALED_POLICY_FIELDS = ["id", "sha256"];
const SEALED_SAFE_MAX_RUNTIME_MS = 30 * 60_000;
const SEALED_SAFE_MAX_OUTPUT_BYTES = 256 * 1024;
const SEALED_SAFE_MAX_ARTIFACT_BYTES = 128 * 1024;
const SEALED_TRANSPORT_CLEANUP_MS = 60_000;
const SEALED_TRANSPORT_HARD_MAX_MS = 30 * 60_000 + SEALED_TRANSPORT_CLEANUP_MS;
const SEALED_ARTIFACT_ENUMS = new Set(["ok", "threshold_fail", "invalid", "execution_error", "pass", "fail", "unknown", "accepted", "rejected", "not_observed", "not_verified"]);

function sealedPrivacySafeJson(value: unknown, depth = 0): void {
  if (depth > 32) throw new Error("sealed execution artifact nesting exceeds its bounded limit");
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
  if (typeof value === "string") {
    if (/^[a-f0-9]{64}$/.test(value) || SEALED_ARTIFACT_ENUMS.has(value)) return;
    throw new Error("sealed execution artifact contains free-form text");
  }
  if (Array.isArray(value)) { value.forEach((item) => sealedPrivacySafeJson(item, depth + 1)); return; }
  if (!record(value)) throw new Error("sealed execution artifact has an unsupported value");
  for (const [key, nested] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) throw new Error("sealed execution artifact key is invalid");
    sealedPrivacySafeJson(nested, depth + 1);
  }
}

/**
 * Validate the coordinator's fixed-size execution receipt before it can be
 * surfaced by a package client. This intentionally repeats the public result
 * contract at the trust boundary: a valid completion signature does not make
 * arbitrary coordinator output safe to retain or display.
 */
export function validateSealedExecutionSafeResult(value: unknown): SealedExecutionSafeResult {
  if (!record(value)) throw new Error("sealed execution result is invalid");
  const hasProvenance = Object.prototype.hasOwnProperty.call(value, "execution_provenance");
  exact(value, hasProvenance ? [...SEALED_SAFE_RESULT_FIELDS, "execution_provenance"] : SEALED_SAFE_RESULT_FIELDS, "sealed execution result");
  if (![
    "ok", "exit_nonzero", "timeout", "output_limit", "spawn_error", "malformed_result", "interrupted",
  ].includes(String(value.status))
      || !(value.exit_code === null || (Number.isSafeInteger(value.exit_code) && Number(value.exit_code) >= 0))
      || !["runtime_ms", "stdout_bytes", "stderr_bytes"].every((key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0)
      || Number(value.runtime_ms) > SEALED_SAFE_MAX_RUNTIME_MS
      || Number(value.stdout_bytes) + Number(value.stderr_bytes) > SEALED_SAFE_MAX_OUTPUT_BYTES
      || !["stdout_sha256", "stderr_sha256"].every((key) => typeof value[key] === "string" && /^[a-f0-9]{64}$/.test(String(value[key])))) {
    throw new Error("sealed execution result is invalid");
  }
  if (hasProvenance) {
    if (!record(value.execution_provenance)) throw new Error("sealed execution provenance is invalid");
    exact(value.execution_provenance, ["invocation_manifest_sha256", "controller_state_sha256"], "sealed execution provenance");
    for (const key of ["invocation_manifest_sha256", "controller_state_sha256"] as const) {
      const digest = value.execution_provenance[key];
      if (digest !== null && (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))) throw new Error("sealed execution provenance is invalid");
    }
  }
  if (value.projection === null) {
    if (value.projection_sha256 !== null) throw new Error("sealed execution result has an inconsistent absent projection");
    return value as unknown as SealedExecutionSafeResult;
  }
  if (!record(value.projection) || typeof value.projection_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.projection_sha256)) {
    throw new Error("sealed execution projection is invalid");
  }
  const projection = value.projection;
  exact(projection, SEALED_PROJECTION_FIELDS, "sealed execution projection");
  if (projection.schema_version !== "1.0" || projection.kind !== "flow-agents.sealed-result.v1"
      || !["ok", "threshold_fail", "invalid", "execution_error"].includes(String(projection.outcome))
      || !record(projection.metrics) || !Array.isArray(projection.artifacts) || !Array.isArray(projection.policy_chain)
      || Object.keys(projection.metrics).length > 128 || projection.artifacts.length > 128 || projection.policy_chain.length > 128) {
    throw new Error("sealed execution projection is invalid");
  }
  for (const [key, metric] of Object.entries(projection.metrics)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || !(typeof metric === "boolean" || (typeof metric === "number" && Number.isFinite(metric)))) {
      throw new Error("sealed execution projection metrics are invalid");
    }
  }
  let artifactBytes = 0;
  for (const artifact of projection.artifacts) {
    if (!record(artifact)) throw new Error("sealed execution artifact is invalid");
    exact(artifact, SEALED_ARTIFACT_FIELDS, "sealed execution artifact");
    if (typeof artifact.id !== "string" || !/^[a-z][a-z0-9_.-]{0,127}$/.test(artifact.id)
        || typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256)
        || !Number.isSafeInteger(artifact.bytes) || Number(artifact.bytes) < 0 || Number(artifact.bytes) > 64 * 1024
        || artifact.media_type !== "application/json" || typeof artifact.content_base64 !== "string") {
      throw new Error("sealed execution artifact is invalid");
    }
    const bytes = Buffer.from(artifact.content_base64, "base64");
    if (bytes.toString("base64") !== artifact.content_base64 || bytes.length !== Number(artifact.bytes)
        || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
      throw new Error("sealed execution artifact content is invalid");
    }
    artifactBytes += bytes.length;
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("sealed execution artifact content must be JSON"); }
    if (!record(parsed) && !Array.isArray(parsed)) throw new Error("sealed execution artifact content must be a structured value");
    sealedPrivacySafeJson(parsed);
  }
  if (artifactBytes > SEALED_SAFE_MAX_ARTIFACT_BYTES) throw new Error("sealed execution projection artifact content exceeds its bounded limit");
  for (const policy of projection.policy_chain) {
    if (!record(policy)) throw new Error("sealed execution policy is invalid");
    exact(policy, SEALED_POLICY_FIELDS, "sealed execution policy");
    if (typeof policy.id !== "string" || !/^[a-z][a-z0-9_.-]{0,127}$/.test(policy.id)
        || typeof policy.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(policy.sha256)) {
      throw new Error("sealed execution policy is invalid");
    }
  }
  if (value.projection_sha256 !== lifecycleAuthorityResultDigest(projection)) throw new Error("sealed execution projection digest is invalid");
  return value as unknown as SealedExecutionSafeResult;
}

/** Read only the coordinator-signed provenance after validating the full receipt. */
export function sealedExecutionProvenance(value: unknown): SealedExecutionProvenance {
  const provenance = validateSealedExecutionSafeResult(value).execution_provenance;
  if (!provenance) throw new Error("sealed execution provenance is unavailable");
  return provenance;
}

/**
 * Compute the exact canonical bytes digest for the sealed stage manifest.
 * This is deliberately public so a sealed client can bind the controller's
 * retained manifest reference to the coordinator-owned preimage.
 */
export function sealedInvocationManifestSha256(workload: JsonRecord, authorization: JsonRecord): string {
  const runtime = record(workload.runtime) ? workload.runtime : null; const controller = record(workload.controller) ? workload.controller : null; const provider = record(workload.provider) ? workload.provider : null;
  if (!record(workload) || !record(authorization) || !runtime || !controller || !provider || !Array.isArray(workload.inputs)
      || typeof runtime.sha256 !== "string" || typeof controller.logical_path !== "string" || typeof controller.sha256 !== "string"
      || typeof provider.sha256 !== "string" || typeof authorization.runner_entrypoint !== "string"
      || !["max_runtime_ms", "max_output_bytes", "max_provider_calls", "max_cost_microusd", "max_tokens"].every((key) => Number.isSafeInteger(authorization[key]))) {
    throw new Error("sealed invocation manifest preimage is invalid");
  }
  const inputs = workload.inputs.map((input) => {
    if (!record(input) || typeof input.id !== "string" || !record(input.source) || typeof input.source.logical_path !== "string" || typeof input.source.sha256 !== "string") throw new Error("sealed invocation manifest preimage is invalid");
    return { id: input.id, logical_path: input.source.logical_path, sha256: input.source.sha256 };
  });
  const manifest = { schema_version: "1.0", kind: "flow-agents.sealed-invocation.v1", authorization_sha256: lifecycleAuthorityResultDigest(authorization), runner: authorization.runner_entrypoint, budgets: { max_runtime_ms: authorization.max_runtime_ms, max_output_bytes: authorization.max_output_bytes, max_provider_calls: authorization.max_provider_calls, max_cost_microusd: authorization.max_cost_microusd, max_tokens: authorization.max_tokens }, runtime_sha256: runtime.sha256, controller: { logical_path: controller.logical_path, sha256: controller.sha256 }, provider_sha256: provider.sha256, inputs };
  return createHash("sha256").update(Buffer.from(`${canonical(manifest)}\n`)).digest("hex");
}

/** Build the exact unsigned request; an external Ed25519 authority signs the separate authorization. */
export function buildUnsignedSealedExecutionRequest(input: {
  projectRoot: string;
  sessionDir: string;
  authorizationFile: string;
  sealedWorkloadFile: string;
}): ExternalLifecycleAuthorityRequest {
  for (const [label, value] of Object.entries(input)) if (typeof value !== "string" || !value) throw new Error(`sealed execution ${label} must be non-empty text`);
  return {
    action: "execute-sealed-workload",
    project_root: input.projectRoot,
    session_dir: input.sessionDir,
    authorization_file: input.authorizationFile,
    sealed_workload_file: input.sealedWorkloadFile,
  };
}

/** Canonical, externally signable authority payload for the closed sealed runner. */
export function buildUnsignedSealedWorkloadAuthorization(input: {
  projectRoot: string; runId: string; subject: string; workloadSha256: string; nonce: string;
  issuedAt: string; expiresAt: string; maxStagedBytes: number; maxRuntimeMs: number; maxOutputBytes: number; maxProviderCalls: number; maxCostMicrousd: number; maxTokens: number;
}): JsonRecord {
  if (!/^[a-f0-9]{64}$/.test(input.workloadSha256) || !input.projectRoot || !input.runId || !input.subject || !input.nonce) throw new Error("sealed execution authorization identity is invalid");
  for (const [name, value] of Object.entries({ maxStagedBytes: input.maxStagedBytes, maxRuntimeMs: input.maxRuntimeMs, maxOutputBytes: input.maxOutputBytes, maxProviderCalls: input.maxProviderCalls, maxCostMicrousd: input.maxCostMicrousd, maxTokens: input.maxTokens })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`sealed execution authorization ${name} is invalid`);
  }
  const issued = Date.parse(input.issuedAt), expires = Date.parse(input.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires < issued || expires - issued > 60 * 60_000) throw new Error("sealed execution authorization time window is invalid");
  return { schema_version: "1.0", operation: "execute-sealed-workload", project_root: input.projectRoot, run_id: input.runId, subject: input.subject,
    workload_sha256: input.workloadSha256, runner_kind: "flow-agents.sealed-exec.v1", runner_schema_version: "1.0", runner_entrypoint: "coordinator:sealed-runner-v1",
    max_staged_bytes: input.maxStagedBytes, max_runtime_ms: input.maxRuntimeMs, max_output_bytes: input.maxOutputBytes, max_provider_calls: input.maxProviderCalls, max_cost_microusd: input.maxCostMicrousd, max_tokens: input.maxTokens,
    issued_at: input.issuedAt, expires_at: input.expiresAt, nonce: input.nonce };
}

export function verifySealedExecutionCompletion(value: unknown, expected: { runId: string; requestSha256: string; authorizationSha256: string; safeResult: SealedExecutionSafeResult }): JsonRecord {
  const safeResult = validateSealedExecutionSafeResult(expected.safeResult);
  const completion = verifyLifecycleAuthorityCompletion(value);
  if (completion.action !== "execute-sealed-workload" || completion.run_id !== expected.runId || completion.request_sha256 !== expected.requestSha256
      || completion.result_core_sha256 !== lifecycleAuthorityResultDigest({ authorization_sha256: expected.authorizationSha256, safe_result: safeResult })) {
    throw new Error("sealed execution completion does not bind the exact request and safe result");
  }
  return completion;
}

/**
 * The small filesystem boundary used while validating the immutable helper
 * installation.  It is injectable only so the installation checks can be
 * exercised without consulting the machine's privileged helper or an
 * authorization file.  `invokeExternalLifecycleAuthority` always supplies
 * the real host and the fixed helper path below.
 */
export interface LifecycleAuthorityHelperHost {
  platform: string;
  getuid?: () => number;
  lstatSync(file: string): { isSymbolicLink(): boolean; isFile(): boolean; uid: number; mode: number };
  accessSync(file: string, mode: number): void;
  openSync(file: string, flags: number): number;
  fstatSync(descriptor: number): { isFile(): boolean; uid: number; mode: number };
  closeSync(descriptor: number): void;
}

/**
 * The read-only filesystem boundary used while validating the immutable
 * completion-verification key. It is deliberately separate from the helper
 * boundary: only this fixed key path may use the narrow Darwin platform alias.
 */
export interface LifecycleAuthorityCompletionVerificationKeyHost {
  platform: string;
  lstatSync(file: string): { isSymbolicLink(): boolean; isFile(): boolean; uid: number; mode: number };
  readlinkSync(file: string): string;
  accessSync(file: string, mode: number): void;
  openSync(file: string, flags: number): number;
  fstatSync(descriptor: number): { isFile(): boolean; uid: number; mode: number; size: number };
  readFileSync(descriptor: number): Buffer;
  closeSync(descriptor: number): void;
}

const lifecycleAuthorityHelperHost: LifecycleAuthorityHelperHost = {
  platform: process.platform,
  getuid: typeof process.getuid === "function" ? () => process.getuid!() : undefined,
  lstatSync: (file) => fs.lstatSync(file),
  accessSync: (file, mode) => fs.accessSync(file, mode),
  openSync: (file, flags) => fs.openSync(file, flags),
  fstatSync: (descriptor) => fs.fstatSync(descriptor),
  closeSync: (descriptor) => fs.closeSync(descriptor),
};

const lifecycleAuthorityCompletionVerificationKeyHost: LifecycleAuthorityCompletionVerificationKeyHost = {
  platform: process.platform,
  lstatSync: (file) => fs.lstatSync(file),
  readlinkSync: (file) => fs.readlinkSync(file),
  accessSync: (file, mode) => fs.accessSync(file, mode),
  openSync: (file, flags) => fs.openSync(file, flags),
  fstatSync: (descriptor) => fs.fstatSync(descriptor),
  readFileSync: (descriptor) => fs.readFileSync(descriptor),
  closeSync: (descriptor) => fs.closeSync(descriptor),
};

function record(value: unknown): value is JsonRecord { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exact(value: JsonRecord, fields: string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...fields].sort())) throw new Error(`${label} contains unexpected or missing fields`);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Canonical digest used by the coordinator to bind a completed mutation result. */
export function lifecycleAuthorityResultDigest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

/**
 * Exact-current predicate for strict lifecycle consumers. Historical bridge
 * evidence is deliberately not an input: callers first authenticate the
 * completion, then require the complete current bundle and ledger core.
 */
export function lifecycleAuthorityCompletionBindsExactState(
  completion: JsonRecord,
  runId: string,
  bundle: JsonRecord,
  resolutionEvents: JsonRecord[],
): boolean {
  return completion.operation_status === "applied"
    && ["resolve-critique", "repair-critique-resolution-history", "reseal-verification-evidence", "recover-exact-current-completion"].includes(String(completion.action))
    && completion.run_id === runId
    && completion.result_core_sha256 === lifecycleAuthorityResultDigest({ ...bundle, critique_resolution_events: resolutionEvents });
}
function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }

/**
 * The package performs read-only binding and verifies the coordinator's
 * immutable completion with the independently provisioned public key. The
 * root-owned coordinator still owns all lifecycle mutations.
 */
function validateSignedCompletion(value: unknown, action: string, requestSha256: string, runId: string, authorizedActionId?: string): JsonRecord {
  if (record(value) && (value.action !== action || value.request_sha256 !== requestSha256 || value.run_id !== runId || !["applied", "replayed"].includes(String(value.operation_status)))) throw new Error("lifecycle authority completion does not bind the requested operation");
  const completion = verifyLifecycleAuthorityCompletion(value);
  if (authorizedActionId !== undefined && completion.authorized_action_id !== authorizedActionId) throw new Error("lifecycle authority completion does not bind the exact merge action");
  return completion;
}

function verifyLifecycleAuthorityCompletionWithStatuses(value: unknown, operationStatuses: readonly string[], label: string): JsonRecord {
  if (!record(value)) throw new Error(`${label} is missing`);
  const fields = ["schema_version", "kind", "action", "request_sha256", "run_id", "operation_status", "result_core_sha256", "coordinator_runtime_sha256", "completed_at", "signature", ...(value.action === "merge-change" ? ["authorized_action_id"] : [])];
  const observed = Object.keys(value).sort();
  if (JSON.stringify(observed) !== JSON.stringify(fields.sort())) throw new Error(`${label} contains unexpected or missing fields`);
  if (value.schema_version !== LIFECYCLE_AUTHORITY_PROTOCOL_VERSION || value.kind !== "kontourai.lifecycle-authority.completion" || !ACTIONS.has(String(value.action)) || typeof value.request_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.request_sha256) || typeof value.run_id !== "string" || !value.run_id || !operationStatuses.includes(String(value.operation_status))) throw new Error(`${label} identity is invalid`);
  for (const key of ["result_core_sha256", "coordinator_runtime_sha256"] as const) if (typeof value[key] !== "string" || !/^[a-f0-9]{64}$/.test(value[key] as string)) throw new Error(`${label} ${key} is invalid`);
  if (value.action === "merge-change" && (typeof value.authorized_action_id !== "string" || !/^[a-f0-9]{64}$/.test(value.authorized_action_id))) throw new Error(`${label} authorized merge action is invalid`);
  if (typeof value.completed_at !== "string" || !Number.isFinite(Date.parse(value.completed_at))) throw new Error(`${label} timestamp is invalid`);
  if (!record(value.signature) || value.signature.algorithm !== "ed25519" || typeof value.signature.value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.signature.value)) throw new Error(`${label} signature is invalid`);
  const signatureValue = value.signature.value;
  const { signature, ...unsigned } = value;
  if (!verify(null, Buffer.from(canonical(unsigned)), trustedCompletionVerificationKey(), Buffer.from(signatureValue, "base64"))) {
    throw new Error(`${label} signature is invalid`);
  }
  return value;
}

/**
 * Verifies an applied coordinator completion without treating it as permission
 * to mutate. Builder, sidecar/final-gate, artifact-validation, and helper
 * response consumers use this strict current-authority verifier.
 */
export function verifyLifecycleAuthorityCompletion(value: unknown): JsonRecord {
  return verifyLifecycleAuthorityCompletionWithStatuses(value, ["applied"], "lifecycle authority completion");
}

export function verifyProvisionalDeliveryLifecycleCompletion(
  value: unknown,
  expected: { runId: string; requestSha256: string; resultCoreSha256: string },
): JsonRecord {
  const completion = verifyLifecycleAuthorityCompletionWithStatuses(value, ["applied"], "provisional delivery lifecycle authority completion");
  if (completion.action !== "publish-provisional-delivery"
    || completion.run_id !== expected.runId
    || completion.request_sha256 !== expected.requestSha256
    || completion.result_core_sha256 !== expected.resultCoreSha256) {
    throw new Error("provisional delivery lifecycle authority completion does not bind the exact request and authority event");
  }
  return completion;
}

/**
 * Authenticates legacy completion history only. A replayed historical receipt
 * never establishes present lifecycle authority; it is accepted exclusively
 * while deriving a signed history-repair bridge.
 */
export function verifyHistoricalLifecycleAuthorityCompletion(value: unknown): JsonRecord {
  return verifyLifecycleAuthorityCompletionWithStatuses(value, ["applied", "replayed"], "historical lifecycle authority completion");
}

function validateProtectedCompletionVerificationKeyPathComponent(file: string, host: LifecycleAuthorityCompletionVerificationKeyHost) {
  let stat: ReturnType<LifecycleAuthorityCompletionVerificationKeyHost["lstatSync"]>;
  try { stat = host.lstatSync(file); } catch { throw new Error(`pinned lifecycle authority completion verification key is not installed at ${LIFECYCLE_AUTHORITY_COMPLETION_VERIFICATION_KEY_PATH}`); }
  if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw new Error("pinned lifecycle authority completion verification key and every parent must be OS-owned and non-writable by group or world");
  try { host.accessSync(file, fs.constants.W_OK); throw new Error("pinned lifecycle authority completion verification key path must not be writable by the runtime user"); }
  catch (error) {
    if (error instanceof Error && error.message.includes("must not be writable")) throw error;
    const code = (error as { code?: unknown })?.code;
    if (code !== "EACCES" && code !== "EPERM" && code !== "EROFS") throw new Error("pinned lifecycle authority completion verification key path runtime-user write protection could not be verified");
  }
  return stat;
}

/**
 * Validate and load the immutable completion-verification key without treating
 * it as authority to mutate. The injectable host exists solely for hermetic
 * fixed-installation checks; production always supplies the real host below.
 */
export function validateLifecycleAuthorityCompletionVerificationKeyInstallation(host: LifecycleAuthorityCompletionVerificationKeyHost = lifecycleAuthorityCompletionVerificationKeyHost) {
  if (host.platform === "win32") throw new Error("secure lifecycle authority completion verification is unavailable without a platform adapter");
  const keyFile = LIFECYCLE_AUTHORITY_COMPLETION_VERIFICATION_KEY_PATH;
  const root = path.posix.parse(keyFile).root;
  let resolvedKeyFile = keyFile;
  const rootStat = validateProtectedCompletionVerificationKeyPathComponent(root, host);
  if (rootStat.isSymbolicLink()) throw new Error("pinned lifecycle authority completion verification key path must not contain symlinks");
  if (host.platform === "darwin") {
    const etcStat = validateProtectedCompletionVerificationKeyPathComponent("/etc", host);
    if (etcStat.isSymbolicLink()) {
      let target: string;
      try { target = host.readlinkSync("/etc"); } catch { throw new Error("pinned lifecycle authority completion verification key Darwin /etc platform alias is unreadable"); }
      if (path.posix.resolve(root, target) !== "/private/etc") throw new Error("pinned lifecycle authority completion verification key Darwin /etc platform alias must resolve exactly to /private/etc");
      resolvedKeyFile = path.posix.join("/private/etc", keyFile.slice("/etc".length));
    }
  }
  let cursor = root;
  for (const component of resolvedKeyFile.slice(root.length).split(path.posix.sep).filter(Boolean)) {
    cursor = path.posix.join(cursor, component);
    const stat = validateProtectedCompletionVerificationKeyPathComponent(cursor, host);
    if (stat.isSymbolicLink()) throw new Error("pinned lifecycle authority completion verification key path must not contain symlinks");
  }
  const descriptor = host.openSync(resolvedKeyFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = host.fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.size === 0 || stat.size > 16 * 1024) throw new Error("pinned lifecycle authority completion verification key must be an OS-owned protected regular file");
    const keyMaterial = host.readFileSync(descriptor);
    let privateKeyMaterial = false;
    try { createPrivateKey(keyMaterial); privateKeyMaterial = true; } catch {
      try { createPrivateKey({ key: keyMaterial, format: "der", type: "pkcs8" }); privateKeyMaterial = true; } catch { /* not private key material */ }
    }
    if (privateKeyMaterial) throw new Error("pinned lifecycle authority completion verification key must not contain private key material");
    const key = createPublicKey(keyMaterial);
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") throw new Error("pinned lifecycle authority completion verification key must be an Ed25519 public key");
    return key;
  } finally { host.closeSync(descriptor); }
}

function trustedCompletionVerificationKey() {
  return validateLifecycleAuthorityCompletionVerificationKeyInstallation();
}

/**
 * Validate a proposed installation location without authorizing an operation.
 * This is deliberately separate from invocation: production invocation always
 * calls it with the immutable `LIFECYCLE_AUTHORITY_HELPER_PATH` and real host.
 */
export function validateLifecycleAuthorityHelperInstallation(helper: string, host: LifecycleAuthorityHelperHost = lifecycleAuthorityHelperHost): string {
  if (host.platform === "win32") throw new Error("secure lifecycle authority helper ownership is unavailable without a platform adapter");
  let cursor = path.parse(helper).root;
  for (const component of helper.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    let stat: ReturnType<LifecycleAuthorityHelperHost["lstatSync"]>;
    try { stat = host.lstatSync(cursor); } catch { throw new Error(`pinned lifecycle authority helper is not installed at ${helper}`); }
    if (stat.isSymbolicLink()) throw new Error("pinned lifecycle authority helper path must not contain symlinks");
    if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw new Error("pinned lifecycle authority helper and every parent must be OS-owned and non-writable by group or world");
    try { host.accessSync(cursor, fs.constants.W_OK); throw new Error("pinned lifecycle authority helper path must not be writable by the runtime user"); }
    catch (error) { if (error instanceof Error && error.message.includes("must not be writable")) throw error; }
  }
  const descriptor = host.openSync(helper, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = host.fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o111) === 0 || stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw new Error("pinned lifecycle authority helper must be an OS-owned protected executable regular file");
  } finally { host.closeSync(descriptor); }
  if (host.getuid?.() === 0) throw new Error("lifecycle authority helper is unavailable to a root caller without a platform privilege adapter");
  return helper;
}

function trustedHelper(): string {
  return validateLifecycleAuthorityHelperInstallation(LIFECYCLE_AUTHORITY_HELPER_PATH);
}

export function validateLifecycleAuthorityResponse(output: string, action: string, requestSha256: string, authorizedActionId?: string): JsonRecord {
  const line = output.endsWith("\n") ? output.slice(0, -1).replace(/\r$/, "") : output;
  if (!line || line.includes("\n") || line.includes("\r") || (output !== line && output !== `${line}\n` && output !== `${line}\r\n`)) throw new Error("lifecycle authority helper must emit exactly one non-empty JSON response line");
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { throw new Error("lifecycle authority helper response must be valid JSON"); }
  if (!record(parsed)) throw new Error("lifecycle authority helper response must be an object");
  exact(parsed, ["schema_version", "action", "request_sha256", "status", "result"], "lifecycle authority helper response");
  if (parsed.schema_version !== LIFECYCLE_AUTHORITY_PROTOCOL_VERSION) throw new Error("lifecycle authority helper response protocol version is invalid");
  if (parsed.action !== action) throw new Error("lifecycle authority helper response action is invalid");
  if (parsed.request_sha256 !== requestSha256) throw new Error("lifecycle authority helper response request digest is invalid");
  if (parsed.status !== "accepted") throw new Error("lifecycle authority helper rejected the request");
  if (!record(parsed.result)) throw new Error("lifecycle authority helper response result must be an object");
  exact(parsed.result, action === "execute-sealed-workload"
    ? ["run_id", "operation_status", "completion", "safe_result"]
    : ["run_id", "operation_status", "completion", ...(action === "merge-change" ? ["authorized_action_id"] : [])], "lifecycle authority mutation result");
  if (typeof parsed.result.run_id !== "string" || !parsed.result.run_id || !["applied", "replayed"].includes(String(parsed.result.operation_status))) throw new Error("lifecycle authority mutation result is invalid");
  if (action === "merge-change" && parsed.result.authorized_action_id !== authorizedActionId) throw new Error("lifecycle authority mutation result does not bind the exact merge action");
  const completion = validateSignedCompletion(parsed.result.completion, action, requestSha256, parsed.result.run_id, authorizedActionId);
  // A replay returns the immutable completion from the original mutation.
  // That completion is necessarily `applied`; the response itself reports
  // `replayed` to describe this invocation. No replayed completion is valid.
  if (completion.operation_status !== "applied") throw new Error("lifecycle authority completion status does not match the response");
  if (action === "execute-sealed-workload") {
    validateSealedExecutionSafeResult(parsed.result.safe_result);
  }
  return parsed.result;
}

/**
 * The helper transport must outlive a signed controller budget. This is only
 * a fail-closed structural read for transport sizing; the root coordinator
 * verifies the registered signature before it acts on the authorization.
 */
export function sealedExecutionTransportTimeout(authorizationFile: string): number {
  const descriptor = fs.openSync(authorizationFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 64 * 1024) throw new Error("sealed execution authorization is not a protected regular file");
    let value: unknown;
    try { value = JSON.parse(fs.readFileSync(descriptor, "utf8")); } catch { throw new Error("sealed execution authorization is invalid"); }
    if (!record(value) || value.schema_version !== "1.0" || value.operation !== "execute-sealed-workload"
      || !Number.isSafeInteger(value.max_runtime_ms) || Number(value.max_runtime_ms) <= 0 || Number(value.max_runtime_ms) > 30 * 60_000
      || !record(value.signature) || value.signature.algorithm !== "ed25519" || typeof value.signature.key_id !== "string" || typeof value.signature.value !== "string") {
      throw new Error("sealed execution authorization is invalid");
    }
    return Math.min(Number(value.max_runtime_ms) + SEALED_TRANSPORT_CLEANUP_MS, SEALED_TRANSPORT_HARD_MAX_MS);
  } finally { fs.closeSync(descriptor); }
}

function prepareExternalLifecycleInvocation(request: ExternalLifecycleAuthorityRequest): { envelope: JsonRecord; helper: string; requestSha256: string; timeout: number } {
  if (!ACTIONS.has(request.action)) throw new Error("unsupported lifecycle authority action");
  const fields = request.action === "resolve-critique" || request.action === "repair-critique-resolution-history"
      ? ["action", "project_root", "session_dir", "authorization_file", "prior_record_id", "resolving_record_id"]
      : request.action === "execute-sealed-workload"
        ? ["action", "project_root", "session_dir", "authorization_file", "sealed_workload_file"]
      : request.action === "merge-change"
        ? ["action", "project_root", "session_dir", "authorization_file", "issued_action_id"]
      : ["action", "project_root", "session_dir", "authorization_file"];
  exact(request as JsonRecord, fields, "lifecycle authority request");
  for (const field of fields.filter((field) => field !== "signature")) if (typeof request[field] !== "string" || !(request[field] as string).length) throw new Error(`lifecycle authority request ${field} must be non-empty text`);
  const requestBody = { ...request };
  const requestSha256 = digest(requestBody);
  const envelope = { schema_version: LIFECYCLE_AUTHORITY_PROTOCOL_VERSION, action: request.action, request_sha256: requestSha256, request: requestBody };
  const helper = trustedHelper();
  const timeout = request.action === "execute-sealed-workload"
    ? sealedExecutionTransportTimeout(String(request.authorization_file))
    : 30_000;
  return { envelope, helper, requestSha256, timeout };
}

function acceptExternalLifecycleOutput(output: string, request: ExternalLifecycleAuthorityRequest, requestSha256: string, authorizedActionId?: string): ExternalLifecycleMutationResult {
  const result = validateLifecycleAuthorityResponse(output, request.action, requestSha256, authorizedActionId) as unknown as ExternalLifecycleMutationResult;
  const expectedRunId = path.basename(String(request.session_dir));
  if (result.run_id !== expectedRunId) throw new Error("lifecycle authority result run_id does not match the requested session identity");
  return result;
}

/** The external helper owns validation, locking, replay/CAS, and every write. */
export function invokeExternalLifecycleAuthority(request: ExternalLifecycleAuthorityRequest): ExternalLifecycleMutationResult {
  if (request.action === "execute-sealed-workload") throw new Error("sealed lifecycle execution requires the cancellable asynchronous transport");
  const { envelope, helper, requestSha256, timeout } = prepareExternalLifecycleInvocation(request);
  let output: string;
  try {
    output = execFileSync(LIFECYCLE_AUTHORITY_SUDO_COMMAND, ["-n", "--", helper], { input: `${canonical(envelope)}\n`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, timeout, killSignal: "SIGTERM", maxBuffer: 256 * 1024 });
  } catch (error) {
    const stderr = typeof (error as { stderr?: unknown })?.stderr === "string" ? (error as { stderr: string }).stderr.trim() : "";
    throw new Error(stderr || "external lifecycle authority rejected the request");
  }
  const expectedActionId = request.action === "merge-change" ? String(request.issued_action_id) : undefined;
  return acceptExternalLifecycleOutput(output, request, requestSha256, expectedActionId);
}

/**
 * Cancellable transport for long-running sealed work. Parent signals are
 * forwarded while Node remains responsive; the coordinator then kills and
 * awaits its process group before returning the signed interrupted receipt.
 */
export async function invokeExternalSealedLifecycleAuthority(request: ExternalLifecycleAuthorityRequest): Promise<ExternalLifecycleMutationResult> {
  if (request.action !== "execute-sealed-workload") throw new Error("cancellable sealed transport only accepts execute-sealed-workload");
  const { envelope, helper, requestSha256, timeout } = prepareExternalLifecycleInvocation(request);
  return new Promise((resolve, reject) => {
    const child = spawnChild(LIFECYCLE_AUTHORITY_SUDO_COMMAND, ["-n", "--", helper], {
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    let outputBytes = 0; let finished = false; let escalation: NodeJS.Timeout | null = null; let runtimeTimer: NodeJS.Timeout | null = null;
    const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
    const forward = (signal: NodeJS.Signals) => {
      if (finished) return;
      child.kill(signal);
      if (escalation === null) escalation = setTimeout(() => child.kill("SIGKILL"), SEALED_TRANSPORT_CLEANUP_MS);
    };
    const handlers = new Map(signals.map((signal) => [signal, () => forward(signal)]));
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const cleanup = () => {
      finished = true;
      if (runtimeTimer !== null) clearTimeout(runtimeTimer);
      if (escalation !== null) clearTimeout(escalation);
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    };
    const append = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 256 * 1024) { forward("SIGTERM"); return; }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.stdin.on("error", () => forward("SIGTERM"));
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("close", (code) => {
      cleanup();
      const stderrText = Buffer.concat(stderr).toString("utf8").trim();
      if (outputBytes > 256 * 1024) { reject(new Error("external lifecycle authority response exceeded its bounded limit")); return; }
      if (code !== 0) { reject(new Error(stderrText || "external lifecycle authority rejected the request")); return; }
      try { resolve(acceptExternalLifecycleOutput(Buffer.concat(stdout).toString("utf8"), request, requestSha256)); }
      catch (error) { reject(error); }
    });
    // `timeout` is the hard runtime+cleanup bound. Begin graceful termination
    // at the signed runtime so the escalation cannot extend beyond that bound.
    runtimeTimer = setTimeout(() => forward("SIGTERM"), Math.max(1, timeout - SEALED_TRANSPORT_CLEANUP_MS));
    child.stdin.end(`${canonical(envelope)}\n`);
  });
}
