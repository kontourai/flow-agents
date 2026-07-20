import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, createPublicKey, verify } from "node:crypto";
import { execFileSync } from "node:child_process";

export const LIFECYCLE_AUTHORITY_PROTOCOL_VERSION = "1.0";
export const LIFECYCLE_AUTHORITY_HELPER_PATH = "/usr/local/libexec/kontourai/flow-agents-lifecycle-authority-v1";
export const LIFECYCLE_AUTHORITY_SUDO_COMMAND = "/usr/bin/sudo";
/** Root-provisioned public half of the coordinator completion signing key. */
export const LIFECYCLE_AUTHORITY_COMPLETION_VERIFICATION_KEY_PATH = "/etc/kontourai/flow-agents-lifecycle-authority-v1/completion-verification-key.pem";
const ACTIONS = new Set(["cancel", "archive", "resolve-critique"]);

export type ExternalLifecycleAuthorityRequest = Readonly<Record<string, unknown> & { action: string; project_root: string }>;
export interface ExternalLifecycleMutationResult {
  run_id: string;
  operation_status: "applied" | "replayed";
  /** Immutable coordinator completion, structurally bound by the package without package-side writes. */
  completion: JsonRecord;
}
type JsonRecord = Record<string, unknown>;

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
function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }

export function isAllowedLifecycleAuthoritySystemAlias(requestedPath: string, canonicalPath: string, platform = process.platform): boolean {
  return platform === "darwin"
    && requestedPath.startsWith("/etc/")
    && canonicalPath === `/private${requestedPath}`;
}

/**
 * The package performs read-only binding and verifies the coordinator's
 * immutable completion with the independently provisioned public key. The
 * root-owned coordinator still owns all lifecycle mutations.
 */
function validateSignedCompletion(value: unknown, action: string, requestSha256: string, runId: string): JsonRecord {
  if (record(value) && (value.action !== action || value.request_sha256 !== requestSha256 || value.run_id !== runId || !["applied", "replayed"].includes(String(value.operation_status)))) throw new Error("lifecycle authority completion does not bind the requested operation");
  const completion = verifyLifecycleAuthorityCompletion(value);
  return completion;
}

/**
 * Verifies a coordinator completion without treating it as permission to mutate.
 * Consumers which already have an immutable completion (such as artifact
 * validation) use this to establish that the root-owned coordinator signed it.
 */
export function verifyLifecycleAuthorityCompletion(value: unknown): JsonRecord {
  if (!record(value)) throw new Error("lifecycle authority completion is missing");
  const fields = ["schema_version", "kind", "action", "request_sha256", "run_id", "operation_status", "result_core_sha256", "coordinator_runtime_sha256", "completed_at", "signature"];
  const observed = Object.keys(value).sort();
  if (JSON.stringify(observed) !== JSON.stringify(fields.sort())) throw new Error("lifecycle authority completion contains unexpected or missing fields");
  if (value.schema_version !== LIFECYCLE_AUTHORITY_PROTOCOL_VERSION || value.kind !== "kontourai.lifecycle-authority.completion" || !ACTIONS.has(String(value.action)) || typeof value.request_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.request_sha256) || typeof value.run_id !== "string" || !value.run_id || !["applied", "replayed"].includes(String(value.operation_status))) throw new Error("lifecycle authority completion identity is invalid");
  for (const key of ["result_core_sha256", "coordinator_runtime_sha256"] as const) if (typeof value[key] !== "string" || !/^[a-f0-9]{64}$/.test(value[key] as string)) throw new Error(`lifecycle authority completion ${key} is invalid`);
  if (typeof value.completed_at !== "string" || !Number.isFinite(Date.parse(value.completed_at))) throw new Error("lifecycle authority completion timestamp is invalid");
  if (!record(value.signature) || value.signature.algorithm !== "ed25519" || typeof value.signature.value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.signature.value)) throw new Error("lifecycle authority completion signature is invalid");
  const signatureValue = value.signature.value;
  const { signature, ...unsigned } = value;
  if (!verify(null, Buffer.from(canonical(unsigned)), trustedCompletionVerificationKey(), Buffer.from(signatureValue, "base64"))) {
    throw new Error("lifecycle authority completion signature is invalid");
  }
  return value;
}

function trustedCompletionVerificationKey() {
  if (process.platform === "win32") throw new Error("secure lifecycle authority completion verification is unavailable without a platform adapter");
  const keyFile = LIFECYCLE_AUTHORITY_COMPLETION_VERIFICATION_KEY_PATH;
  let canonicalKeyFile: string;
  try { canonicalKeyFile = (fs.realpathSync.native ?? fs.realpathSync)(keyFile); }
  catch { throw new Error(`pinned lifecycle authority completion verification key is not installed at ${keyFile}`); }
  if (canonicalKeyFile !== keyFile) {
    if (!isAllowedLifecycleAuthoritySystemAlias(keyFile, canonicalKeyFile)) {
      throw new Error("pinned lifecycle authority completion verification key path must not contain symlinks");
    }
    const alias = fs.lstatSync("/etc");
    if (!alias.isSymbolicLink() || alias.uid !== 0 || fs.readlinkSync("/etc") !== "private/etc") {
      throw new Error("pinned lifecycle authority completion verification key path uses an untrusted system alias");
    }
  }
  let cursor = path.parse(canonicalKeyFile).root;
  for (const component of canonicalKeyFile.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(cursor); } catch { throw new Error(`pinned lifecycle authority completion verification key is not installed at ${keyFile}`); }
    if (stat.isSymbolicLink()) throw new Error("pinned lifecycle authority completion verification key path must not contain symlinks");
    if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw new Error("pinned lifecycle authority completion verification key and every parent must be OS-owned and non-writable by group or world");
    try { fs.accessSync(cursor, fs.constants.W_OK); throw new Error("pinned lifecycle authority completion verification key path must not be writable by the runtime user"); }
    catch (error) { if (error instanceof Error && error.message.includes("must not be writable")) throw error; }
  }
  const descriptor = fs.openSync(canonicalKeyFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.size === 0 || stat.size > 16 * 1024) throw new Error("pinned lifecycle authority completion verification key must be an OS-owned protected regular file");
    const key = createPublicKey(fs.readFileSync(descriptor));
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") throw new Error("pinned lifecycle authority completion verification key must be an Ed25519 public key");
    return key;
  } finally { fs.closeSync(descriptor); }
}

function trustedHelper(): string {
  if (process.platform === "win32") throw new Error("secure lifecycle authority helper ownership is unavailable without a platform adapter");
  const helper = LIFECYCLE_AUTHORITY_HELPER_PATH;
  let cursor = path.parse(helper).root;
  for (const component of helper.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(cursor); } catch { throw new Error(`pinned lifecycle authority helper is not installed at ${helper}`); }
    if (stat.isSymbolicLink()) throw new Error("pinned lifecycle authority helper path must not contain symlinks");
    if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw new Error("pinned lifecycle authority helper and every parent must be OS-owned and non-writable by group or world");
    try { fs.accessSync(cursor, fs.constants.W_OK); throw new Error("pinned lifecycle authority helper path must not be writable by the runtime user"); }
    catch (error) { if (error instanceof Error && error.message.includes("must not be writable")) throw error; }
  }
  const descriptor = fs.openSync(helper, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o111) === 0 || stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw new Error("pinned lifecycle authority helper must be an OS-owned protected executable regular file");
  } finally { fs.closeSync(descriptor); }
  if (typeof process.getuid === "function" && process.getuid() === 0) throw new Error("lifecycle authority helper is unavailable to a root caller without a platform privilege adapter");
  return helper;
}

export function validateLifecycleAuthorityResponse(output: string, action: string, requestSha256: string): JsonRecord {
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
  exact(parsed.result, ["run_id", "operation_status", "completion"], "lifecycle authority mutation result");
  if (typeof parsed.result.run_id !== "string" || !parsed.result.run_id || !["applied", "replayed"].includes(String(parsed.result.operation_status))) throw new Error("lifecycle authority mutation result is invalid");
  const completion = validateSignedCompletion(parsed.result.completion, action, requestSha256, parsed.result.run_id);
  if (completion.operation_status !== parsed.result.operation_status) throw new Error("lifecycle authority completion status does not match the response");
  return parsed.result;
}

/** The external helper owns validation, locking, replay/CAS, and every write. */
export function invokeExternalLifecycleAuthority(request: ExternalLifecycleAuthorityRequest): ExternalLifecycleMutationResult {
  if (!ACTIONS.has(request.action)) throw new Error("unsupported lifecycle authority action");
  const fields = request.action === "resolve-critique"
      ? ["action", "project_root", "session_dir", "authorization_file", "prior_record_id", "resolving_record_id"]
      : ["action", "project_root", "session_dir", "authorization_file"];
  exact(request as JsonRecord, fields, "lifecycle authority request");
  for (const field of fields.filter((field) => field !== "signature")) if (typeof request[field] !== "string" || !(request[field] as string).length) throw new Error(`lifecycle authority request ${field} must be non-empty text`);
  const requestBody = { ...request };
  const requestSha256 = digest(requestBody);
  const envelope = { schema_version: LIFECYCLE_AUTHORITY_PROTOCOL_VERSION, action: request.action, request_sha256: requestSha256, request: requestBody };
  const helper = trustedHelper();
  let output: string;
  try {
    output = execFileSync(LIFECYCLE_AUTHORITY_SUDO_COMMAND, ["-n", "--", helper], { input: `${canonical(envelope)}\n`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, timeout: 30_000, maxBuffer: 256 * 1024 });
  } catch (error) {
    const stderr = typeof (error as { stderr?: unknown })?.stderr === "string" ? (error as { stderr: string }).stderr.trim() : "";
    throw new Error(stderr || "external lifecycle authority rejected the request");
  }
  const result = validateLifecycleAuthorityResponse(output, request.action, requestSha256) as unknown as ExternalLifecycleMutationResult;
  const expectedRunId = request.action === "resolve-critique" ? path.basename(String(request.session_dir)) : path.basename(String(request.session_dir));
  if (result.run_id !== expectedRunId) throw new Error("lifecycle authority result run_id does not match the requested session identity");
  return result;
}
