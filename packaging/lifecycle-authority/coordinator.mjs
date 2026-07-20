#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const PROTOCOL_VERSION = "1.0";
export const CONFIG_ROOT = "/etc/kontourai/flow-agents-lifecycle-authority-v1";
export const STATE_ROOT = "/var/lib/kontourai/flow-agents-lifecycle-authority-v1";
export const REGISTRY_FILE = `${CONFIG_ROOT}/keys.json`;
export const COMPLETION_PRIVATE_KEY_FILE = `${CONFIG_ROOT}/completion-signing-key.pem`;
const ACTION_FIELDS = {
  cancel: ["action", "project_root", "session_dir", "authorization_file"],
  archive: ["action", "project_root", "session_dir", "authorization_file"],
  "resolve-critique": ["action", "project_root", "session_dir", "authorization_file", "prior_record_id", "resolving_record_id"],
};

const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export const sha256 = (value) => crypto.createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
function exact(value, fields, label) {
  if (!record(value) || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...fields].sort())) throw new Error(`${label} contains unexpected or missing fields`);
}
function within(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function protectedRegularFile(file, label, maxBytes = 64 * 1024) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxBytes || (stat.mode & 0o022) !== 0) throw new Error(`${label} must be a protected regular file`);
    return fs.readFileSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}
function canonicalInputPaths(request) {
  const projectRoot = fs.realpathSync(request.project_root);
  const sessionDir = fs.realpathSync(request.session_dir);
  const expectedSessionRoot = path.join(projectRoot, ".kontourai", "flow-agents");
  if (!within(sessionDir, expectedSessionRoot) || path.dirname(sessionDir) !== expectedSessionRoot) throw new Error("session_dir must identify one direct canonical Flow Agents session");
  const authorizationFile = fs.realpathSync(request.authorization_file);
  if (within(authorizationFile, projectRoot)) throw new Error("authorization_file must be outside the project and worktree");
  protectedRegularFile(authorizationFile, "authorization file");
  return { projectRoot, sessionDir, authorizationFile, runId: path.basename(sessionDir) };
}
export function validateEnvelope(value) {
  exact(value, ["schema_version", "action", "request_sha256", "request"], "coordinator envelope");
  if (value.schema_version !== PROTOCOL_VERSION || typeof value.action !== "string" || !ACTION_FIELDS[value.action]) throw new Error("unsupported coordinator protocol or action");
  exact(value.request, ACTION_FIELDS[value.action], "coordinator request");
  if (value.request.action !== value.action || sha256(value.request) !== value.request_sha256) throw new Error("coordinator request identity or digest is invalid");
  for (const field of ACTION_FIELDS[value.action]) if (typeof value.request[field] !== "string" || !value.request[field]) throw new Error(`coordinator request ${field} must be non-empty text`);
  return value;
}
function authorityRegistry() {
  const parsed = JSON.parse(protectedRegularFile(REGISTRY_FILE, "authority registry").toString("utf8"));
  exact(parsed, ["schema_version", "keys"], "authority registry");
  if (parsed.schema_version !== PROTOCOL_VERSION || !Array.isArray(parsed.keys)) throw new Error("authority registry is invalid");
  return parsed;
}
function verifyAuthorization(file) {
  const authorization = JSON.parse(protectedRegularFile(file, "authorization file").toString("utf8"));
  if (!record(authorization.signature)) throw new Error("authorization signature is required");
  const key = authorityRegistry().keys.find((candidate) => record(candidate) && candidate.id === authorization.signature.key_id);
  if (!record(key) || key.algorithm !== "ed25519" || typeof key.public_key_pem !== "string" || /PRIVATE KEY/.test(key.public_key_pem)) throw new Error("authorization key is not trusted");
  const { signature, ...unsigned } = authorization;
  if (signature.algorithm !== "ed25519" || typeof signature.value !== "string" || !crypto.verify(null, Buffer.from(JSON.stringify(unsigned)), crypto.createPublicKey(key.public_key_pem), Buffer.from(signature.value, "base64"))) throw new Error("authorization signature is invalid");
  return authorization;
}
function atomicWrite(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, file);
  const descriptor = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}
function completion(envelope, paths, operationStatus) {
  const unsigned = { schema_version: PROTOCOL_VERSION, kind: "kontourai.lifecycle-authority.completion", action: envelope.action, request_sha256: envelope.request_sha256, run_id: paths.runId, operation_status: operationStatus, completed_at: new Date().toISOString() };
  const privateKey = crypto.createPrivateKey(protectedRegularFile(COMPLETION_PRIVATE_KEY_FILE, "completion signing key", 16 * 1024));
  return { ...unsigned, signature: { algorithm: "ed25519", value: crypto.sign(null, Buffer.from(canonicalJson(unsigned)), privateKey).toString("base64") } };
}
function withDurableLock(requestSha256, callback) {
  const lock = path.join(STATE_ROOT, "locks", requestSha256);
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  fs.mkdirSync(lock, { mode: 0o700 });
  try { return callback(); } finally { fs.rmdirSync(lock); }
}
function processOperation(envelope) {
  const paths = canonicalInputPaths(envelope.request);
  const authorization = verifyAuthorization(paths.authorizationFile);
  if (authorization.operation !== envelope.action || authorization.run_id !== paths.runId) throw new Error("authorization does not bind the requested operation and run");
  const completionFile = path.join(STATE_ROOT, "completions", `${envelope.request_sha256}.json`);
  return withDurableLock(envelope.request_sha256, () => {
    if (fs.existsSync(completionFile)) return JSON.parse(protectedRegularFile(completionFile, "completion record").toString("utf8"));
    // State-transition adapters are intentionally fail-closed until their canonical
    // Flow/bundle CAS implementations land; never emit a completion before mutation.
    throw new Error(`reference coordinator ${envelope.action} state transition is not implemented`);
  });
}
function response(envelope, completionRecord) {
  return { schema_version: PROTOCOL_VERSION, action: envelope.action, request_sha256: envelope.request_sha256, status: "accepted", result: { run_id: completionRecord.run_id, operation_status: "replayed" } };
}
export function main(input = fs.readFileSync(0, "utf8")) {
  const lines = input.split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) throw new Error("coordinator requires exactly one JSON request line");
  const envelope = validateEnvelope(JSON.parse(lines[0]));
  return response(envelope, processOperation(envelope));
}
if (path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url))) {
  try { process.stdout.write(`${JSON.stringify(main())}\n`); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
