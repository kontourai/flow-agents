#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { coordinatorRuntimeSha256, resolveCritiqueTransition } from "./runtime-v1.mjs";

export const PROTOCOL_VERSION = "1.0";
export const CONFIG_ROOT = "/etc/kontourai/flow-agents-lifecycle-authority-v1";
export const STATE_ROOT = "/var/lib/kontourai/flow-agents-lifecycle-authority-v1";
export const REGISTRY_FILE = `${CONFIG_ROOT}/keys.json`;
export const COMPLETION_PRIVATE_KEY_FILE = `${CONFIG_ROOT}/completion-signing-key.pem`;
const INSTALL_ROOT = path.dirname(fileURLToPath(import.meta.url));
const FLOW_REDUCER_PIN_FILE = path.join(INSTALL_ROOT, "flow-reducer-v1.json");
const FLOW_REDUCER_PACKAGE_ROOT = path.join(INSTALL_ROOT, "flow-reducer", "node_modules", "@kontourai", "flow");
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
export const sha256 = (value) => crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : canonicalJson(value)).digest("hex");
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
function protectedJson(file, label, maxBytes = 4 * 1024 * 1024) {
  return JSON.parse(protectedRegularFile(file, label, maxBytes).toString("utf8"));
}
function sha256File(file, label) { return sha256(protectedRegularFile(file, label, 16 * 1024 * 1024)); }
function exactObject(value, expected, label) {
  if (canonicalJson(value) !== canonicalJson(expected)) throw new Error(`${label} does not match the pinned Flow reducer identity`);
}
async function loadPinnedFlowReducer() {
  const pin = protectedJson(FLOW_REDUCER_PIN_FILE, "Flow reducer pin", 16 * 1024);
  exact(pin, ["package", "package_version", "release_commit", "reducer"], "Flow reducer pin");
  if (pin.package !== "@kontourai/flow" || pin.package_version !== "3.5.0" || pin.release_commit !== "871ed9c" || !record(pin.reducer)) throw new Error("Flow reducer pin is invalid");
  const packageJson = protectedJson(path.join(FLOW_REDUCER_PACKAGE_ROOT, "package.json"), "pinned Flow package metadata", 64 * 1024);
  if (packageJson.name !== pin.package || packageJson.version !== pin.package_version) throw new Error("installed Flow package does not match the pinned reducer package identity");
  const entry = path.join(FLOW_REDUCER_PACKAGE_ROOT, "dist", "index.js");
  protectedRegularFile(entry, "pinned Flow reducer artifact", 8 * 1024 * 1024);
  const flow = await import(pathToFileURL(entry).href);
  for (const name of ["reduceTrustAttachment", "trustAttachmentReducerIdentity", "FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES"]) {
    if (typeof flow[name] !== "function" && !record(flow[name])) throw new Error(`pinned Flow reducer artifact does not export ${name}`);
  }
  const identity = flow.trustAttachmentReducerIdentity(flow.FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES);
  exactObject(identity, pin.reducer, "installed Flow reducer");
  return { flow, pin, artifact_sha256: sha256File(entry, "pinned Flow reducer artifact") };
}
function canonicalFlowPaths(paths) {
  const root = path.join(paths.projectRoot, ".kontourai", "flow", "runs", paths.runId);
  const relative = path.relative(paths.projectRoot, root);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("canonical Flow run escapes the project root");
  return {
    root,
    definition: path.join(root, "definition.json"),
    state: path.join(root, "state.json"),
    manifest: path.join(root, "evidence", "manifest.json"),
    reportJson: path.join(root, "report.json"),
    reportMarkdown: path.join(root, "report.md")
  };
}
function openGateId(definition, state) {
  const matches = Object.entries(definition.gates ?? {}).filter(([, gate]) => record(gate) && gate.step === state.current_step).map(([id]) => id);
  if (matches.length !== 1) throw new Error("canonical Flow run must have exactly one current gate for lifecycle trust synchronization");
  return matches[0];
}
async function synchronizeCanonicalFlow(paths, bundle, envelope) {
  const { flow, pin, artifact_sha256 } = await loadPinnedFlowReducer();
  const files = canonicalFlowPaths(paths);
  const definitionBytes = protectedRegularFile(files.definition, "canonical Flow definition", 4 * 1024 * 1024);
  const stateBytes = protectedRegularFile(files.state, "canonical Flow state", 4 * 1024 * 1024);
  const manifestBytes = protectedRegularFile(files.manifest, "canonical Flow evidence manifest", 4 * 1024 * 1024);
  const definition = JSON.parse(definitionBytes.toString("utf8"));
  const state = JSON.parse(stateBytes.toString("utf8"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const gateId = openGateId(definition, state);
  const attachmentId = `lifecycle-authority:${envelope.request_sha256}`;
  const supersede = (Array.isArray(manifest.evidence) ? manifest.evidence : [])
    .filter((entry) => record(entry) && entry.gate_id === gateId && entry.kind === "trust.bundle" && typeof entry.superseded_by !== "string")
    .map((entry) => entry.id);
  const attachedAt = new Date().toISOString();
  const storedPath = `evidence/${attachmentId}.json`;
  const bundleBytes = Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`);
  const reduced = flow.reduceTrustAttachment({
    run: { definition, state, manifest }, bundle,
    attachment: { id: attachmentId, gate_id: gateId, attached_at: attachedAt, original_path: path.relative(paths.projectRoot, path.join(paths.sessionDir, "trust.bundle")), stored_path: storedPath, sha256: sha256(bundleBytes), ...(supersede.length ? { supersede } : {}) },
    now: attachedAt, dependencies: flow.FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES
  });
  exactObject(reduced.identity, pin.reducer, "Flow reducer result");
  const evidenceFile = path.join(files.root, storedPath);
  fs.mkdirSync(path.dirname(evidenceFile), { recursive: true, mode: 0o700 });
  if (!fs.readFileSync(files.definition).equals(definitionBytes) || !fs.readFileSync(files.state).equals(stateBytes) || !fs.readFileSync(files.manifest).equals(manifestBytes)) throw new Error("canonical Flow preimage changed during lifecycle trust synchronization");
  atomicWrite(evidenceFile, bundleBytes);
  for (const artifact of reduced.write.artifacts) {
    const destination = path.join(files.root, artifact.path);
    atomicWrite(destination, typeof artifact.value === "string" ? artifact.value : `${JSON.stringify(artifact.value, null, 2)}\n`);
  }
  return { reducer: { ...reduced.identity, artifact_sha256 }, attachment_id: attachmentId };
}
function completion(envelope, paths, operationStatus, resultCoreSha256) {
  const unsigned = { schema_version: PROTOCOL_VERSION, kind: "kontourai.lifecycle-authority.completion", action: envelope.action, request_sha256: envelope.request_sha256, run_id: paths.runId, operation_status: operationStatus, result_core_sha256: resultCoreSha256, coordinator_runtime_sha256: coordinatorRuntimeSha256(), completed_at: new Date().toISOString() };
  const privateKey = crypto.createPrivateKey(protectedRegularFile(COMPLETION_PRIVATE_KEY_FILE, "completion signing key", 16 * 1024));
  return { ...unsigned, signature: { algorithm: "ed25519", value: crypto.sign(null, Buffer.from(canonicalJson(unsigned)), privateKey).toString("base64") } };
}
async function withDurableLock(requestSha256, callback) {
  const lock = path.join(STATE_ROOT, "locks", requestSha256);
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  fs.mkdirSync(lock, { mode: 0o700 });
  try { return await callback(); } finally { fs.rmdirSync(lock); }
}
async function processOperation(envelope) {
  const paths = canonicalInputPaths(envelope.request);
  const authorization = verifyAuthorization(paths.authorizationFile);
  if (authorization.operation !== envelope.action || authorization.run_id !== paths.runId) throw new Error("authorization does not bind the requested operation and run");
  const completionFile = path.join(STATE_ROOT, "completions", `${envelope.request_sha256}.json`);
  return withDurableLock(envelope.request_sha256, async () => {
    if (fs.existsSync(completionFile)) return { completionRecord: JSON.parse(protectedRegularFile(completionFile, "completion record").toString("utf8")), replayed: true };
    if (envelope.action === "resolve-critique") {
      const bundleFile = path.join(paths.sessionDir, "trust.bundle");
      const beforeBytes = protectedRegularFile(bundleFile, "trust bundle", 4 * 1024 * 1024);
      const before = JSON.parse(beforeBytes.toString("utf8"));
      if (sha256(beforeBytes) !== authorization.prior_bundle_sha256) throw new Error("critique resolution preimage bundle digest changed");
      const reduced = resolveCritiqueTransition({ bundle: before, authorization, prior_record_id: envelope.request.prior_record_id, resolving_record_id: envelope.request.resolving_record_id });
      const resultCoreSha256 = sha256(reduced);
      const completionRecord = completion(envelope, paths, "applied", resultCoreSha256);
      const finalAfter = { ...reduced, lifecycle_authority_completion: completionRecord };
      await synchronizeCanonicalFlow(paths, finalAfter, envelope);
      // Recheck the exact preimage immediately before the atomic replace.
      if (!fs.readFileSync(bundleFile).equals(beforeBytes)) throw new Error("critique resolution preimage changed during preparation");
      atomicWrite(bundleFile, `${JSON.stringify(finalAfter, null, 2)}\n`);
      atomicWrite(completionFile, `${JSON.stringify(completionRecord, null, 2)}\n`);
      return { completionRecord, replayed: false };
    }
    // Cancel/archive remain fail-closed until their canonical adapters land.
    throw new Error(`reference coordinator ${envelope.action} state transition is not implemented`);
  });
}
function response(envelope, outcome) {
  return { schema_version: PROTOCOL_VERSION, action: envelope.action, request_sha256: envelope.request_sha256, status: "accepted", result: { run_id: outcome.completionRecord.run_id, operation_status: outcome.replayed ? "replayed" : "applied", completion: outcome.completionRecord } };
}
export async function main(input = fs.readFileSync(0, "utf8")) {
  const lines = input.split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) throw new Error("coordinator requires exactly one JSON request line");
  const envelope = validateEnvelope(JSON.parse(lines[0]));
  return response(envelope, await processOperation(envelope));
}
if (path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url))) {
  try { process.stdout.write(`${JSON.stringify(await main())}\n`); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
