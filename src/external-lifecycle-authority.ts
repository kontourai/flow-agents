import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export const LIFECYCLE_AUTHORITY_PROTOCOL_VERSION = "1.0";
export const LIFECYCLE_AUTHORITY_HELPER_PATH = "/usr/local/libexec/kontourai/flow-agents-lifecycle-authority-v1";
const ACTIONS = new Set(["verify-authorization", "cancel", "archive", "resolve-critique"]);

export type ExternalLifecycleAuthorityRequest = Readonly<Record<string, unknown> & { action: string; project_root: string }>;
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
function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }

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
  if (action === "verify-authorization") {
    exact(parsed.result, ["verified"], "lifecycle authority verification result");
    if (parsed.result.verified !== true) throw new Error("lifecycle authority helper did not verify the authorization");
  } else {
    exact(parsed.result, ["run_id", "operation_status"], "lifecycle authority mutation result");
    if (typeof parsed.result.run_id !== "string" || !parsed.result.run_id || !["applied", "replayed"].includes(String(parsed.result.operation_status))) throw new Error("lifecycle authority mutation result is invalid");
  }
  return parsed.result;
}

/** The external helper owns validation, locking, replay/CAS, and every write. */
export function invokeExternalLifecycleAuthority(request: ExternalLifecycleAuthorityRequest): JsonRecord {
  if (!ACTIONS.has(request.action)) throw new Error("unsupported lifecycle authority action");
  const fields = request.action === "verify-authorization"
    ? ["action", "project_root", "payload", "signature"]
    : request.action === "resolve-critique"
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
    output = execFileSync(helper, [], { input: `${canonical(envelope)}\n`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, timeout: 30_000, maxBuffer: 256 * 1024 });
  } catch (error) {
    const stderr = typeof (error as { stderr?: unknown })?.stderr === "string" ? (error as { stderr: string }).stderr.trim() : "";
    throw new Error(stderr || "external lifecycle authority rejected the request");
  }
  return validateLifecycleAuthorityResponse(output, request.action, requestSha256);
}
