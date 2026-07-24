#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import {
  assertAppendOnlyCritiqueHistory,
  coordinatorRuntimeSha256,
  critiqueHistoryProjectionSummary,
  critiqueResolutionEdgeProjectionSummary,
  critiqueResolutionHistoryBridgeDigest,
  repairCritiqueResolutionHistoryTransition,
  resealVerificationEvidenceTransition,
  resolveCritiqueTransition,
  selectUniqueHistoricalLedgerPrefix,
  validateResolutionEventLedger,
} from "./runtime-v1.mjs";

export const PROTOCOL_VERSION = "1.0";
export const CONFIG_ROOT = "/etc/kontourai/flow-agents-lifecycle-authority-v1";
export const STATE_ROOT = "/var/lib/kontourai/flow-agents-lifecycle-authority-v1";
export const REGISTRY_FILE = `${CONFIG_ROOT}/keys.json`;
export const COMPLETION_PRIVATE_KEY_FILE = `${CONFIG_ROOT}/completion-signing-key.pem`;
export const COMPLETION_PUBLIC_KEY_FILE = `${CONFIG_ROOT}/completion-verification-key.pem`;
const MAX_CANONICAL_FLOW_MANIFEST_BYTES = 16 * 1024 * 1024;
const INSTALL_ROOT = path.dirname(fileURLToPath(import.meta.url));
const FLOW_REDUCER_PIN_FILE = path.join(INSTALL_ROOT, "flow-reducer-v1.json");
const FLOW_REDUCER_PACKAGE_ROOT = path.join(INSTALL_ROOT, "flow-reducer", "node_modules", "@kontourai", "flow");
const CHILD_MODE = process.env.FLOW_AGENTS_LIFECYCLE_MUTATION_WORKER === "1";
const ACTION_FIELDS = {
  cancel: ["action", "project_root", "session_dir", "authorization_file"],
  archive: ["action", "project_root", "session_dir", "authorization_file"],
  "resolve-critique": ["action", "project_root", "session_dir", "authorization_file", "prior_record_id", "resolving_record_id"],
  "repair-critique-resolution-history": ["action", "project_root", "session_dir", "authorization_file", "prior_record_id", "resolving_record_id"],
  "reseal-verification-evidence": ["action", "project_root", "session_dir", "authorization_file"],
};
const HISTORY_REPAIR_AUTHORIZATION_FIELDS = [
  "schema_version", "operation", "project_root", "run_id", "subject", "prior_record_id", "prior_record_hash", "resolving_record_id", "resolving_record_hash",
  "expected_resolver", "prior_snapshot_sha256", "resolving_snapshot_sha256", "prior_head_sha", "resolving_head_sha",
  "preimage_bundle_sha256", "preimage_ledger_sha256", "preimage_ledger_length", "preimage_ledger_tail_hash", "current_completion_sha256",
  "historical_completion_sha256", "historical_completion_request_sha256", "historical_completion_action", "historical_completion_result_core_sha256",
  "historical_attachment_id", "historical_manifest_entry_sha256", "historical_stored_path", "historical_stored_raw_sha256", "historical_stored_bundle_sha256",
  "historical_durable_operation_id", "historical_durable_completion_record_sha256",
  "historical_ledger_prefix_length", "historical_ledger_prefix_raw_sha256", "historical_ledger_prefix_canonical_sha256", "historical_ledger_prefix_tail_hash",
  "historical_critique_projection_version", "historical_critique_projection_sha256", "historical_critique_projection_length", "historical_critique_projection_tail_hash",
  "current_critique_projection_version", "current_critique_projection_sha256", "current_critique_projection_length", "current_critique_projection_tail_hash",
  "historical_resolution_edge_projection_sha256", "historical_resolution_edge_projection_count",
  "current_resolution_edge_projection_sha256", "current_resolution_edge_projection_count",
  "current_bundle_sha256", "current_ledger_sha256", "current_ledger_length", "current_ledger_tail_hash",
  "historical_bridge_sha256", "preserved_resolution_sha256", "missing_resolution_event_id", "missing_authorization_sha256", "reason_code",
  "nonce", "expires_at", "requested_at", "signature",
];
const VERIFICATION_RESEAL_AUTHORIZATION_FIELDS = [
  "schema_version", "operation", "project_root", "run_id", "subject",
  "preimage_bundle_sha256", "candidate_bundle_sha256", "candidate_transaction_id",
  "preimage_ledger_sha256", "preimage_ledger_length", "preimage_ledger_tail_hash",
  "current_completion_sha256", "current_completion_request_sha256", "current_completion_result_core_sha256",
  "flow_definition_id", "flow_step_id", "flow_gate_id", "flow_run_head", "flow_manifest_sha256", "critique_projection_sha256",
  "target_expectation_id", "predecessor_claim_id", "predecessor_claim_status", "predecessor_claim_sha256", "predecessor_claim_index",
  "current_claim_id", "current_claim_status", "current_claim_sha256", "current_claim_index", "claim_delta",
  "nonce", "expires_at", "requested_at", "signature",
];

const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function assignmentActorsMatch(current, authorized) {
  if (!record(current) || !record(authorized)) return false;
  const canonicalizeLegacyHuman = (actor) => Object.prototype.hasOwnProperty.call(actor, "human")
    ? actor
    : { ...actor, human: null };
  return canonicalJson(canonicalizeLegacyHuman(current)) === canonicalJson(canonicalizeLegacyHuman(authorized));
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
function canonicalMutationPaths(request) {
  const projectRoot = fs.realpathSync(request.project_root);
  const sessionDir = fs.realpathSync(request.session_dir);
  const expectedSessionRoot = path.join(projectRoot, ".kontourai", "flow-agents");
  if (!within(sessionDir, expectedSessionRoot) || path.dirname(sessionDir) !== expectedSessionRoot) throw new Error("session_dir must identify one direct canonical Flow Agents session");
  return { projectRoot, sessionDir, runId: path.basename(sessionDir) };
}
function canonicalInputPaths(request) {
  const paths = canonicalMutationPaths(request);
  const authorizationFile = fs.realpathSync(request.authorization_file);
  if (within(authorizationFile, paths.projectRoot)) throw new Error("authorization_file must be outside the project and worktree");
  protectedRegularFile(authorizationFile, "authorization file");
  return { ...paths, authorizationFile };
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
function verifySignedAuthorization(authorization, { projectRoot = null, requireCurrentExpiry = true } = {}) {
  if (!record(authorization.signature)) throw new Error("authorization signature is required");
  const key = authorityRegistry().keys.find((candidate) => record(candidate) && candidate.id === authorization.signature.key_id);
  if (!record(key) || key.algorithm !== "ed25519" || typeof key.public_key_pem !== "string" || /PRIVATE KEY/.test(key.public_key_pem)) throw new Error("authorization key is not trusted");
  const { signature, ...unsigned } = authorization;
  if (signature.algorithm !== "ed25519" || typeof signature.value !== "string" || !crypto.verify(null, Buffer.from(JSON.stringify(unsigned)), crypto.createPublicKey(key.public_key_pem), Buffer.from(signature.value, "base64"))) throw new Error("authorization signature is invalid");
  if (projectRoot !== null && authorization.project_root !== projectRoot) throw new Error("authorization does not bind the canonical project root");
  if (requireCurrentExpiry && (typeof authorization.expires_at !== "string" || !Number.isFinite(Date.parse(authorization.expires_at)) || Date.now() > Date.parse(authorization.expires_at))) throw new Error("authorization is expired");
  return authorization;
}
function assertPrivilegedAuthorizationShape(authorization) {
  const fields = authorization.operation === "repair-critique-resolution-history"
    ? HISTORY_REPAIR_AUTHORIZATION_FIELDS
    : authorization.operation === "reseal-verification-evidence"
      ? VERIFICATION_RESEAL_AUTHORIZATION_FIELDS
      : null;
  if (!fields) return authorization;
  exact(authorization, fields, `privileged ${authorization.operation} authorization`);
  exact(authorization.signature, ["algorithm", "key_id", "value"], `privileged ${authorization.operation} authorization signature`);
  return authorization;
}
function verifyAuthorization(file, options = {}) {
  return assertPrivilegedAuthorizationShape(verifySignedAuthorization(JSON.parse(protectedRegularFile(file, "authorization file").toString("utf8")), options));
}
function atomicWrite(file, bytes, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, bytes, { mode, flag: "wx" });
  const temporaryDescriptor = fs.openSync(temporary, fs.constants.O_RDONLY);
  try { fs.fsyncSync(temporaryDescriptor); } finally { fs.closeSync(temporaryDescriptor); }
  fs.renameSync(temporary, file);
  const descriptor = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}
function transactionJournal(paths) { return path.join(paths.sessionDir, ".lifecycle-authority.transaction.json"); }
const FLOW_MUTATION_LOCK_PATH = ".mutation.lock";
const FLOW_TRANSACTION_EXCLUDED_PATHS = [FLOW_MUTATION_LOCK_PATH];
export const VERIFICATION_RESEAL_TRANSACTION_PROTOCOL = "flow-agents.verification-reseal-transaction.v1";
export const VERIFICATION_RESEAL_ARTIFACT_IDS = Object.freeze([
  "session-trust-bundle",
  "flow-manifest",
  "flow-state",
  "flow-attachment",
  "flow-report-json",
  "flow-report-markdown",
]);
const VERIFICATION_RESEAL_PLAN_FILE = ".verification-reseal.transaction.json";
const FLOW_RECOVERY_FENCE_FILE = "recovery-fence.json";
const FLOW_RECOVERY_FENCE_PROTOCOL = "flow.run-recovery-fence.v1";
function transactionPathIsExcluded(relative, excludedPaths) {
  return excludedPaths.some((excluded) => relative === excluded || relative.startsWith(`${excluded}/`));
}
function transactionNamespaceIdentity(relative) {
  return relative.normalize("NFC").replace(/[A-Z]/g, (character) => String.fromCharCode(character.charCodeAt(0) + 0x20));
}
function canonicalTransactionSnapshotPath(root, relative, label) {
  if (typeof relative !== "string" || relative.length === 0 || relative.includes("\0") || relative.includes("\\")) {
    throw new Error(`${label} path must be a nonempty canonical relative POSIX path`);
  }
  for (let index = 0; index < relative.length; index += 1) {
    if (relative.charCodeAt(index) > 0x7f) throw new Error(`${label} path must contain only ASCII code units`);
  }
  if (path.posix.isAbsolute(relative) || path.win32.parse(relative).root !== "") {
    throw new Error(`${label} path must remain relative to its transaction root`);
  }
  const segments = relative.split("/");
  const firstIdentity = transactionNamespaceIdentity(segments[0]);
  if (firstIdentity === FLOW_MUTATION_LOCK_PATH && segments[0] !== FLOW_MUTATION_LOCK_PATH) {
    throw new Error(`${label} aliases the protected ${FLOW_MUTATION_LOCK_PATH} namespace`);
  }
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..") || path.posix.normalize(relative) !== relative) {
    throw new Error(`${label} path is not canonical`);
  }
  const absoluteRoot = path.resolve(root);
  const resolved = path.resolve(absoluteRoot, ...segments);
  const withinRoot = path.relative(absoluteRoot, resolved);
  if (withinRoot === "" || withinRoot === ".." || withinRoot.startsWith(`..${path.sep}`) || path.isAbsolute(withinRoot)) {
    throw new Error(`${label} path escapes its transaction root`);
  }
  return { relative, identity: transactionNamespaceIdentity(relative) };
}
function validateTransactionSnapshot(root, snapshot, label) {
  if (!Array.isArray(snapshot)) throw new Error(`${label} must be an array`);
  const seen = new Set();
  return snapshot.map((entry, index) => {
    const entryLabel = `${label} entry ${index}`;
    if (!record(entry) || canonicalJson(Object.keys(entry).sort()) !== canonicalJson(["bytes", "mode", "path"])) {
      throw new Error(`${entryLabel} must contain exactly path, bytes, and mode`);
    }
    const { relative, identity } = canonicalTransactionSnapshotPath(root, entry.path, entryLabel);
    if (seen.has(identity)) throw new Error(`${label} contains duplicate path identity ${relative}`);
    seen.add(identity);
    if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777
        || (entry.mode & 0o400) === 0 || (entry.mode & 0o133) !== 0) {
      throw new Error(`${entryLabel} mode is not a safe regular-file mode`);
    }
    if (typeof entry.bytes !== "string") throw new Error(`${entryLabel} bytes must be canonical base64`);
    const bytes = Buffer.from(entry.bytes, "base64");
    if (bytes.toString("base64") !== entry.bytes) throw new Error(`${entryLabel} bytes must be canonical base64`);
    return { path: relative, bytes: entry.bytes, mode: entry.mode };
  });
}
function validateTransactionJournalSnapshots(paths, journal) {
  if (!record(journal)) throw new Error("lifecycle transaction journal is invalid");
  const flowRoot = canonicalFlowPaths(paths).root;
  const session = validateTransactionSnapshot(paths.sessionDir, journal.session, "lifecycle transaction session snapshot");
  const flow = validateTransactionSnapshot(flowRoot, journal.flow, "lifecycle transaction Flow snapshot");
  return { session, flow };
}
export function snapshotTree(root, relative = "", excludedPaths = []) {
  if (transactionPathIsExcluded(relative, excludedPaths)) return [];
  const target = relative === "" ? root : path.join(root, ...relative.split("/")); const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error("lifecycle transaction refuses symlinked artifact paths");
  if (stat.isFile()) return [{ path: relative, bytes: fs.readFileSync(target).toString("base64"), mode: stat.mode & 0o777 }];
  if (!stat.isDirectory()) throw new Error("lifecycle transaction requires regular artifact paths");
  return fs.readdirSync(target).flatMap((entry) => entry === ".lifecycle-authority.transaction.json"
    ? []
    : snapshotTree(root, relative === "" ? entry : path.posix.join(relative, entry), excludedPaths));
}
export function restoreTree(root, snapshot, excludedPaths = []) {
  const validated = validateTransactionSnapshot(root, snapshot, "lifecycle transaction restore snapshot");
  const restorable = validated.filter((entry) => !transactionPathIsExcluded(entry.path, excludedPaths));
  const original = new Map(restorable.map((entry) => [entry.path, entry]));
  const current = snapshotTree(root, "", excludedPaths);
  for (const entry of current.filter((entry) => !original.has(entry.path))) fs.unlinkSync(path.join(root, ...entry.path.split("/")));
  for (const entry of restorable) atomicWrite(path.join(root, ...entry.path.split("/")), Buffer.from(entry.bytes, "base64"), entry.mode);
}
export function recoverTransaction(paths, expectedBinding = null) {
  const file = transactionJournal(paths); if (!fs.existsSync(file)) return false;
  const journal = protectedJson(file, "lifecycle transaction journal", 64 * 1024 * 1024);
  if (journal.status !== "prepared") return false;
  if (expectedBinding !== null && canonicalJson(journal.binding) !== canonicalJson(expectedBinding)) return false;
  const snapshots = validateTransactionJournalSnapshots(paths, journal);
  restoreTree(paths.sessionDir, snapshots.session); restoreTree(canonicalFlowPaths(paths).root, snapshots.flow, FLOW_TRANSACTION_EXCLUDED_PATHS);
  atomicWrite(file, `${JSON.stringify({ ...journal, status: "rolled_back", recovered_at: new Date().toISOString() })}\n`);
  return true;
}
export function rollbackCommittedTransaction(paths, expectedBinding) {
  const file = transactionJournal(paths); if (!fs.existsSync(file)) return false;
  const journal = protectedJson(file, "lifecycle transaction journal", 64 * 1024 * 1024);
  if (journal.status !== "committed") return false;
  if (canonicalJson(journal.binding) !== canonicalJson(expectedBinding)) return false;
  const snapshots = validateTransactionJournalSnapshots(paths, journal);
  restoreTree(paths.sessionDir, snapshots.session); restoreTree(canonicalFlowPaths(paths).root, snapshots.flow, FLOW_TRANSACTION_EXCLUDED_PATHS);
  atomicWrite(file, `${JSON.stringify({ ...journal, status: "rolled_back", recovered_at: new Date().toISOString() })}\n`);
  return true;
}
export function assertPreparedNonceRecord(prior, prepared) {
  if (canonicalJson(prior) !== canonicalJson(prepared)) throw new Error("lifecycle authorization nonce has already been consumed");
  return prepared;
}
export function recoverMatchingTransaction(paths, expectedBinding) {
  const file = transactionJournal(paths);
  if (!fs.existsSync(file)) return false;
  const journal = protectedJson(file, "lifecycle transaction journal", 64 * 1024 * 1024);
  if (!["prepared", "committed"].includes(journal.status)) return false;
  if (canonicalJson(journal.binding) !== canonicalJson(expectedBinding)) throw new Error("prepared lifecycle recovery found a transaction for another operation");
  const recovered = journal.status === "committed"
    ? rollbackCommittedTransaction(paths, expectedBinding)
    : recoverTransaction(paths, expectedBinding);
  if (!recovered) throw new Error("prepared lifecycle transaction changed during recovery");
  return true;
}
function recoverPreparedTransactionForEntry(paths, expectedBinding) {
  const file = transactionJournal(paths);
  if (!fs.existsSync(file)) return false;
  const journal = protectedJson(file, "lifecycle transaction journal", 64 * 1024 * 1024);
  // A committed or rolled-back journal is inert history at ordinary transaction
  // entry and will be replaced by the next prepared transaction. Only an
  // interrupted prepared generation requires entry-time recovery.
  if (journal.status !== "prepared") return false;
  if (canonicalJson(journal.binding) !== canonicalJson(expectedBinding)) throw new Error("prepared lifecycle recovery found a transaction for another operation");
  if (!recoverTransaction(paths, expectedBinding)) throw new Error("prepared lifecycle transaction changed during recovery");
  return true;
}
export async function inProjectTransaction(paths, binding, action) {
  recoverPreparedTransactionForEntry(paths, binding);
  const captured = { schema_version: PROTOCOL_VERSION, status: "prepared", binding, created_at: new Date().toISOString(), session: snapshotTree(paths.sessionDir), flow: snapshotTree(canonicalFlowPaths(paths).root, "", FLOW_TRANSACTION_EXCLUDED_PATHS) };
  const snapshots = validateTransactionJournalSnapshots(paths, captured);
  const journal = { ...captured, ...snapshots };
  atomicWrite(transactionJournal(paths), `${JSON.stringify(journal)}\n`);
  try {
    const result = await action();
    atomicWrite(transactionJournal(paths), `${JSON.stringify({ ...journal, status: "committed", committed_at: new Date().toISOString() })}\n`);
    return result;
  } catch (error) {
    const snapshots = validateTransactionJournalSnapshots(paths, journal);
    restoreTree(paths.sessionDir, snapshots.session); restoreTree(canonicalFlowPaths(paths).root, snapshots.flow, FLOW_TRANSACTION_EXCLUDED_PATHS);
    atomicWrite(transactionJournal(paths), `${JSON.stringify({ ...journal, status: "rolled_back", rolled_back_at: new Date().toISOString() })}\n`);
    throw error;
  }
}
function protectedJson(file, label, maxBytes = 4 * 1024 * 1024) {
  return JSON.parse(protectedRegularFile(file, label, maxBytes).toString("utf8"));
}
function resolutionEventLedgerFile(paths) { return path.join(paths.sessionDir, "lifecycle-authority.resolution-events.json"); }
function hasCrossReviewerEdge(bundle) {
  return Array.isArray(bundle?.claims) && bundle.claims.some((claim) => claim?.metadata?.origin === "critique" && claim.metadata?.critique_resolution?.kind === "cross-reviewer");
}
function loadResolutionEventLedger(paths, bundle, authorization, action = authorization.operation) {
  const file = resolutionEventLedgerFile(paths);
  if (!fs.existsSync(file)) {
    if (hasCrossReviewerEdge(bundle) && action !== "repair-critique-resolution-history") throw new Error("resolution event ledger is required after a cross-reviewer edge; repair is required");
    return { events: [], bytes: Buffer.alloc(0), absent: true };
  }
  const bytes = protectedRegularFile(file, "lifecycle authority resolution event ledger", 4 * 1024 * 1024);
  const ledger = JSON.parse(bytes.toString("utf8"));
  exact(ledger, ["schema_version", "events"], "lifecycle authority resolution event ledger");
  if (ledger.schema_version !== PROTOCOL_VERSION || !Array.isArray(ledger.events)) throw new Error("lifecycle authority resolution event ledger is invalid");
  validateResolutionEventLedger(ledger.events, { run_id: authorization.run_id, subject: authorization.subject, project_root: paths.projectRoot, bundle, strict_coverage: action === "resolve-critique" });
  for (const event of ledger.events) verifySignedAuthorization(event.signed_authorization, { projectRoot: paths.projectRoot, requireCurrentExpiry: false });
  return { events: ledger.events, bytes, absent: false };
}
function assertResolutionEventLedgerPreimage(paths, initial) {
  const file = resolutionEventLedgerFile(paths);
  if (initial.absent) {
    if (fs.existsSync(file)) throw new Error("resolution event ledger appeared during mutation preparation");
    return;
  }
  if (!fs.existsSync(file)) throw new Error("resolution event ledger disappeared during mutation preparation");
  const current = protectedRegularFile(file, "lifecycle authority resolution event ledger", 4 * 1024 * 1024);
  if (!current.equals(initial.bytes)) throw new Error("resolution event ledger bytes changed during mutation preparation");
}
function writeResolutionEventLedger(paths, events, initial) {
  assertResolutionEventLedgerPreimage(paths, initial);
  validateResolutionEventLedger(events);
  atomicWrite(resolutionEventLedgerFile(paths), `${JSON.stringify({ schema_version: PROTOCOL_VERSION, events }, null, 2)}\n`, 0o644);
}
function assertAuthorizedBundlePreimage(bytes, action, authorization) {
  const field = action === "resolve-critique"
    ? "prior_bundle_sha256"
    : action === "repair-critique-resolution-history"
      ? "preimage_bundle_sha256"
      : null;
  if (!field) throw new Error("bundle preimage verification is unsupported for this action");
  if (sha256(bytes) !== authorization[field]) {
    throw new Error(action === "resolve-critique" ? "critique resolution preimage bundle digest changed" : "history repair preimage bundle digest changed");
  }
}
function jsonSha256(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function lifecycleAuthorityResultDigest(bundle, resolutionEvents) {
  // The ledger persists beside the Trust Bundle, but completions retain the
  // established synthetic-bundle shape for compatibility with prior receipts.
  return sha256({ ...bundle, critique_resolution_events: resolutionEvents });
}
function assertLifecycleCompletionIdentity(paths, completion, operationStatuses, label) {
  const fields = ["schema_version", "kind", "action", "request_sha256", "run_id", "operation_status", "result_core_sha256", "coordinator_runtime_sha256", "completed_at", "signature"];
  exact(completion, fields, label);
  if (completion.schema_version !== PROTOCOL_VERSION || completion.kind !== "kontourai.lifecycle-authority.completion" || !["resolve-critique", "repair-critique-resolution-history", "reseal-verification-evidence"].includes(completion.action) || completion.run_id !== paths.runId || !operationStatuses.includes(completion.operation_status) || typeof completion.request_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(completion.request_sha256)) throw new Error(`${label} identity is invalid`);
  for (const key of ["result_core_sha256", "coordinator_runtime_sha256"]) if (typeof completion[key] !== "string" || !/^[a-f0-9]{64}$/.test(completion[key])) throw new Error(`${label} ${key} is invalid`);
  if (typeof completion.completed_at !== "string" || !Number.isFinite(Date.parse(completion.completed_at))) throw new Error(`${label} timestamp is invalid`);
  if (!record(completion.signature) || completion.signature.algorithm !== "ed25519" || typeof completion.signature.value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(completion.signature.value)) throw new Error(`${label} signature is invalid`);
  const { signature, ...unsigned } = completion;
  const publicKey = crypto.createPublicKey(protectedRegularFile(COMPLETION_PUBLIC_KEY_FILE, "completion verification key", 16 * 1024));
  if (!crypto.verify(null, Buffer.from(canonicalJson(unsigned)), publicKey, Buffer.from(signature.value, "base64"))) throw new Error(`${label} signature is invalid`);
  return completion;
}
function assertCurrentLifecycleCompletionIdentity(paths, completion) {
  return assertLifecycleCompletionIdentity(paths, completion, ["applied"], "current lifecycle completion");
}
function assertCurrentLifecycleCompletion(paths, completion, bundle, resolutionEvents) {
  const verifiedCompletion = assertCurrentLifecycleCompletionIdentity(paths, completion);
  if (verifiedCompletion.result_core_sha256 !== lifecycleAuthorityResultDigest(bundle, resolutionEvents)) throw new Error("current lifecycle completion does not bind the exact bundle and resolution ledger");
  return verifiedCompletion;
}
function verifyCurrentLifecycleCompletion(paths, bundle, resolutionEvents) {
  return assertCurrentLifecycleCompletion(
    paths,
    protectedJson(path.join(paths.sessionDir, "lifecycle-authority.completion.json"), "current lifecycle completion", 256 * 1024),
    bundle,
    resolutionEvents,
  );
}
function verifyHistoricalLifecycleCompletion(paths, completion) {
  return assertLifecycleCompletionIdentity(paths, completion, ["applied", "replayed"], "historical lifecycle completion");
}
function sha256File(file, label) { return sha256(protectedRegularFile(file, label, 16 * 1024 * 1024)); }
function exactObject(value, expected, label) {
  if (canonicalJson(value) !== canonicalJson(expected)) throw new Error(`${label} does not match the pinned Flow reducer identity`);
}
async function loadPinnedFlowReducer() {
  const pin = protectedJson(FLOW_REDUCER_PIN_FILE, "Flow reducer pin", 16 * 1024);
  exact(pin, ["package", "package_version", "release_commit", "closure_sha256", "reducer"], "Flow reducer pin");
  if (pin.package !== "@kontourai/flow" || pin.package_version !== "3.5.0" || pin.release_commit !== "871ed9c" || typeof pin.closure_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(pin.closure_sha256) || !record(pin.reducer)) throw new Error("Flow reducer pin is invalid");
  const packageJson = protectedJson(path.join(FLOW_REDUCER_PACKAGE_ROOT, "package.json"), "pinned Flow package metadata", 64 * 1024);
  if (packageJson.name !== pin.package || packageJson.version !== pin.package_version) throw new Error("installed Flow package does not match the pinned reducer package identity");
  const entry = path.join(FLOW_REDUCER_PACKAGE_ROOT, "dist", "index.js");
  const runStoreEntry = path.join(FLOW_REDUCER_PACKAGE_ROOT, "dist", "runtime", "flow-run-store.js");
  protectedRegularFile(entry, "pinned Flow reducer artifact", 8 * 1024 * 1024);
  protectedRegularFile(runStoreEntry, "pinned Flow run mutation store", 8 * 1024 * 1024);
  const flow = await import(pathToFileURL(entry).href);
  const runStore = await import(pathToFileURL(runStoreEntry).href);
  for (const name of ["reduceTrustAttachment", "trustAttachmentReducerIdentity", "flowRunHead", "FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES"]) {
    if (typeof flow[name] !== "function" && !record(flow[name])) throw new Error(`pinned Flow reducer artifact does not export ${name}`);
  }
  const identity = flow.trustAttachmentReducerIdentity(flow.FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES);
  exactObject(identity, pin.reducer, "installed Flow reducer");
  if (typeof runStore.withRunMutationLock !== "function") throw new Error("pinned Flow run store does not export withRunMutationLock");
  return {
    flow,
    withRunMutationLock: runStore.withRunMutationLock,
    withRunRecoveryLock: runStore.withRunRecoveryLock,
    writeRunRecoveryFence: runStore.writeRunRecoveryFence,
    finalizeRunRecoveryFence: runStore.finalizeRunRecoveryFence,
    pin,
    artifact_sha256: sha256File(entry, "pinned Flow reducer artifact"),
  };
}
export function assertVerificationResealFlowCapabilities(runStore) {
  for (const name of ["withRunMutationLock", "withRunRecoveryLock", "writeRunRecoveryFence", "finalizeRunRecoveryFence"]) {
    if (typeof runStore?.[name] !== "function") throw new Error(`canonical Flow verification reseal capability ${name} is unavailable`);
  }
  return true;
}
async function preflightVerificationResealFlowCapabilities() {
  const runStore = await loadPinnedFlowReducer();
  assertVerificationResealFlowCapabilities(runStore);
  return { available: true };
}

export async function withCanonicalFlowRunMutationLock(paths, operation, injectedLock = null) {
  const withRunMutationLock = injectedLock ?? (await loadPinnedFlowReducer()).withRunMutationLock;
  if (typeof withRunMutationLock !== "function") throw new Error("canonical Flow run mutation lock is unavailable");
  return withRunMutationLock(paths.runId, paths.projectRoot, operation);
}
export async function withCanonicalFlowRunRecoveryLock(paths, recoveryId, operation, injectedLock = null) {
  const withRunRecoveryLock = injectedLock ?? (await loadPinnedFlowReducer()).withRunRecoveryLock;
  if (typeof withRunRecoveryLock !== "function") throw new Error("canonical Flow run recovery lock is unavailable");
  return withRunRecoveryLock(paths.runId, recoveryId, paths.projectRoot, operation);
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
function verificationResealPlanFile(paths) {
  return path.join(paths.sessionDir, VERIFICATION_RESEAL_PLAN_FILE);
}
export function verificationResealArtifactFiles(paths, requestSha256) {
  if (!/^[a-f0-9]{64}$/.test(String(requestSha256))) throw new Error("verification reseal request identity is invalid");
  const files = canonicalFlowPaths(paths);
  return new Map([
    ["session-trust-bundle", path.join(paths.sessionDir, "trust.bundle")],
    ["flow-manifest", files.manifest],
    ["flow-state", files.state],
    ["flow-attachment", path.join(files.root, "evidence", `lifecycle-authority:${requestSha256}.json`)],
    ["flow-report-json", files.reportJson],
    ["flow-report-markdown", files.reportMarkdown],
  ]);
}
function verificationResealStageFile(file, image) {
  if (!["old", "new"].includes(image)) throw new Error("verification reseal stage image is invalid");
  return `${file}.verification-reseal-${image}`;
}
function verificationResealFenceFile(paths) {
  return path.join(canonicalFlowPaths(paths).root, FLOW_RECOVERY_FENCE_FILE);
}
function exactArtifactDescriptor(bytes, mode) {
  if (bytes === null) return { presence: "absent", mode: null, size: 0, sha256: null };
  return { presence: "present", mode, size: bytes.length, sha256: sha256(bytes) };
}
function readVerificationResealArtifact(file, label) {
  try {
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.size > MAX_CANONICAL_FLOW_MANIFEST_BYTES || (stat.mode & 0o022) !== 0) {
        throw new Error(`${label} must be a protected regular file`);
      }
      const bytes = fs.readFileSync(descriptor);
      return { bytes, descriptor: exactArtifactDescriptor(bytes, stat.mode & 0o777) };
    } finally { fs.closeSync(descriptor); }
  } catch (error) {
    if (error?.code === "ENOENT") return { bytes: null, descriptor: exactArtifactDescriptor(null, null) };
    throw error;
  }
}
function assertVerificationResealDescriptor(value, label) {
  exact(value, ["presence", "mode", "size", "sha256"], label);
  if (value.presence === "absent") {
    if (value.mode !== null || value.size !== 0 || value.sha256 !== null) throw new Error(`${label} absent descriptor is invalid`);
  } else if (value.presence === "present") {
    if (!Number.isInteger(value.mode) || value.mode < 0 || value.mode > 0o777
        || !Number.isSafeInteger(value.size) || value.size < 0
        || !/^[a-f0-9]{64}$/.test(String(value.sha256))) throw new Error(`${label} present descriptor is invalid`);
  } else throw new Error(`${label} presence is invalid`);
  return value;
}
export function validateVerificationResealPlan(plan) {
  exact(plan, [
    "schema_version", "kind", "recovery_id", "run_id", "request_sha256", "authorization_sha256",
    "authorization_key_id", "authorization_nonce", "reducer", "result_core_sha256", "artifacts",
  ], "verification reseal transaction plan");
  if (plan.schema_version !== PROTOCOL_VERSION || plan.kind !== VERIFICATION_RESEAL_TRANSACTION_PROTOCOL
      || !/^[a-f0-9]{64}$/.test(String(plan.recovery_id)) || typeof plan.run_id !== "string" || !plan.run_id
      || !/^[a-f0-9]{64}$/.test(String(plan.request_sha256))
      || !/^[a-f0-9]{64}$/.test(String(plan.authorization_sha256))
      || typeof plan.authorization_key_id !== "string" || !plan.authorization_key_id
      || typeof plan.authorization_nonce !== "string" || !plan.authorization_nonce
      || !record(plan.reducer) || !/^[a-f0-9]{64}$/.test(String(plan.result_core_sha256))
      || !Array.isArray(plan.artifacts) || plan.artifacts.length !== VERIFICATION_RESEAL_ARTIFACT_IDS.length) {
    throw new Error("verification reseal transaction plan identity is invalid");
  }
  const ids = plan.artifacts.map((artifact) => artifact?.id);
  if (canonicalJson(ids) !== canonicalJson(VERIFICATION_RESEAL_ARTIFACT_IDS)) {
    throw new Error("verification reseal transaction plan must enumerate exactly the fixed six artifact ids");
  }
  for (const artifact of plan.artifacts) {
    exact(artifact, ["id", "pre", "post"], `verification reseal artifact ${artifact?.id}`);
    assertVerificationResealDescriptor(artifact.pre, `verification reseal artifact ${artifact.id} preimage`);
    assertVerificationResealDescriptor(artifact.post, `verification reseal artifact ${artifact.id} postimage`);
  }
  return plan;
}
function assertVerificationResealPlanBinding(plan, paths, binding) {
  validateVerificationResealPlan(plan);
  if (plan.run_id !== paths.runId || plan.request_sha256 !== binding.request_sha256
      || plan.authorization_sha256 !== binding.authorization_sha256) {
    throw new Error("verification reseal transaction plan does not bind this exact operation");
  }
  return plan;
}
function inspectVerificationResealFence(paths) {
  const file = verificationResealFenceFile(paths);
  if (!fs.existsSync(file)) return { status: "open", absent: true };
  const fence = protectedJson(file, "Flow recovery fence", 64 * 1024);
  exact(fence, ["protocol", "run_id", "recovery_id", "status", "updated_at", "generation"], "Flow recovery fence");
  if (fence.protocol !== FLOW_RECOVERY_FENCE_PROTOCOL || fence.run_id !== paths.runId
      || !/^[a-f0-9]{64}$/.test(String(fence.recovery_id))
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(fence.generation))
      || !["active", "open"].includes(fence.status)
      || typeof fence.updated_at !== "string" || !Number.isFinite(Date.parse(fence.updated_at))) {
    throw new Error("Flow recovery fence is malformed or unsupported");
  }
  return fence;
}
async function writeVerificationResealFence(paths, recoveryId, status) {
  if (!/^[a-f0-9]{64}$/.test(String(recoveryId)) || status !== "active") {
    throw new Error("Flow recovery fence update is invalid");
  }
  const { writeRunRecoveryFence } = await loadPinnedFlowReducer();
  if (typeof writeRunRecoveryFence !== "function") throw new Error("canonical Flow recovery fence writer is unavailable");
  await writeRunRecoveryFence(paths.runId, {
    protocol: FLOW_RECOVERY_FENCE_PROTOCOL,
    run_id: paths.runId,
    recovery_id: recoveryId,
    status,
    updated_at: new Date().toISOString(),
  }, paths.projectRoot);
}
async function finalizeVerificationResealFence(paths, recoveryId, expectedGeneration) {
  if (!/^[a-f0-9]{64}$/.test(String(recoveryId))
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(expectedGeneration))) {
    throw new Error("Flow recovery fence finalization is invalid");
  }
  const { finalizeRunRecoveryFence } = await loadPinnedFlowReducer();
  if (typeof finalizeRunRecoveryFence !== "function") throw new Error("canonical Flow recovery fence finalizer is unavailable");
  await finalizeRunRecoveryFence(paths.runId, {
    recovery_id: recoveryId,
    expected_generation: expectedGeneration,
    updated_at: new Date().toISOString(),
  }, paths.projectRoot);
}
function stageVerificationResealImage(file, bytes, mode, image) {
  const stage = verificationResealStageFile(file, image);
  if (bytes === null) {
    if (fs.existsSync(stage)) fs.unlinkSync(stage);
    return;
  }
  atomicWrite(stage, bytes, mode);
  const reread = readVerificationResealArtifact(stage, `verification reseal ${image} stage`);
  if (!reread.bytes?.equals(bytes) || reread.descriptor.mode !== mode) throw new Error(`verification reseal ${image} stage reread changed`);
}
function readSignedVerificationResealPlan(paths) {
  const capability = protectedJson(verificationResealPlanFile(paths), "verification reseal signed plan", 1024 * 1024);
  const value = verifiedCapability(capability, "reseal-plan-capability");
  if (!record(value.plan)) throw new Error("verification reseal signed plan payload is invalid");
  return { capability, plan: validateVerificationResealPlan(value.plan) };
}
export function classifyVerificationResealArtifacts(paths, plan) {
  const files = verificationResealArtifactFiles(paths, plan.request_sha256);
  const states = [];
  for (const artifact of plan.artifacts) {
    const actual = readVerificationResealArtifact(files.get(artifact.id), `verification reseal artifact ${artifact.id}`).descriptor;
    const pre = canonicalJson(actual) === canonicalJson(artifact.pre);
    const post = canonicalJson(actual) === canonicalJson(artifact.post);
    states.push(pre && post ? "both" : pre ? "pre" : post ? "post" : "unknown");
  }
  if (states.every((state) => state === "pre" || state === "both")) return "old";
  if (states.every((state) => state === "post" || state === "both")) return "new";
  return "unknown";
}
export function rejectActiveLegacyResealJournal(paths, _binding) {
  const file = transactionJournal(paths);
  if (!fs.existsSync(file)) return;
  const bytes = protectedRegularFile(file, "legacy lifecycle transaction journal", 64 * 1024 * 1024);
  const journal = protectedJson(file, "legacy lifecycle transaction journal", 64 * 1024 * 1024);
  if (["prepared", "committed"].includes(journal.status)) {
    const quarantine = `${file}.quarantine-legacy-${sha256(bytes)}`;
    if (fs.existsSync(quarantine)) throw new Error("active legacy recursive reseal transaction quarantine target already exists");
    fs.renameSync(file, quarantine);
    throw new Error("active legacy recursive reseal transaction requires offline quarantine; automatic tree restore is forbidden");
  }
}
function quarantineVerificationResealTransaction(paths, plan) {
  const files = verificationResealArtifactFiles(paths, plan.request_sha256);
  for (const file of [verificationResealPlanFile(paths), ...[...files.values()].flatMap((artifact) => [
    verificationResealStageFile(artifact, "old"),
    verificationResealStageFile(artifact, "new"),
  ])]) {
    if (!fs.existsSync(file)) continue;
    const quarantine = `${file}.quarantine-${plan.recovery_id}`;
    if (fs.existsSync(quarantine)) throw new Error("verification reseal quarantine target already exists");
    fs.renameSync(file, quarantine);
  }
}
function historicalAttachment(paths, authorization, completion, { expectedSupersededBy = null } = {}) {
  const files = canonicalFlowPaths(paths);
  const manifestBytes = protectedRegularFile(files.manifest, "canonical Flow evidence manifest", MAX_CANONICAL_FLOW_MANIFEST_BYTES);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (!Array.isArray(manifest.evidence)) throw new Error("canonical Flow evidence manifest is invalid");
  const attachmentId = `lifecycle-authority:${completion.request_sha256}`;
  if (authorization.historical_attachment_id !== attachmentId) throw new Error("history repair authorization does not bind the historical Flow attachment");
  const entries = manifest.evidence.filter((entry) => record(entry) && entry.id === attachmentId);
  if (entries.length !== 1) throw new Error("historical Flow attachment must occur exactly once");
  const entry = entries[0];
  const { superseded_by: supersededBy, ...signedEntry } = entry;
  if (expectedSupersededBy === null ? supersededBy !== undefined : supersededBy !== expectedSupersededBy) throw new Error("historical Flow attachment supersession does not match the expected transition");
  const expectedPath = `evidence/${attachmentId}.json`;
  if (entry.kind !== "trust.bundle" || entry.stored_path !== expectedPath || authorization.historical_stored_path !== expectedPath || entry.sha256 !== authorization.historical_stored_raw_sha256 || sha256(canonicalJson(signedEntry)) !== authorization.historical_manifest_entry_sha256) throw new Error("historical Flow attachment does not match the signed bridge");
  const evidenceRoot = path.join(files.root, "evidence");
  const storedFile = path.resolve(files.root, entry.stored_path);
  if (!within(storedFile, evidenceRoot) || storedFile !== path.join(evidenceRoot, `${attachmentId}.json`)) throw new Error("historical Flow stored path escapes the canonical evidence directory");
  const bytes = protectedRegularFile(storedFile, "historical Flow stored trust bundle", 4 * 1024 * 1024);
  if (sha256(bytes) !== authorization.historical_stored_raw_sha256) throw new Error("historical Flow stored trust bundle digest does not match the signed bridge");
  const bundle = JSON.parse(bytes.toString("utf8"));
  if (!record(bundle) || !Array.isArray(bundle.claims) || sha256(bundle) !== authorization.historical_stored_bundle_sha256) throw new Error("historical Flow stored trust bundle semantic digest does not match the signed bridge");
  return { id: attachmentId, entry, stored_path: expectedPath, bytes, bundle };
}
function historicalCompletionForBridge(paths, authorization) {
  const completion = verifyHistoricalLifecycleCompletion(paths, protectedJson(path.join(paths.sessionDir, "lifecycle-authority.completion.json"), "historical lifecycle completion", 256 * 1024));
  const digest = jsonSha256(completion);
  if (authorization.historical_completion_sha256 !== digest || authorization.historical_completion_request_sha256 !== completion.request_sha256 || authorization.historical_completion_action !== completion.action || authorization.historical_completion_result_core_sha256 !== completion.result_core_sha256 || authorization.current_completion_sha256 !== digest) throw new Error("history repair authorization does not bind the authenticated historical completion");
  return { completion, digest };
}
function exactBridgeSummary(summary, currentClaims, authorization, prefix) {
  const field = (name) => authorization[`historical_${name}`];
  if (field("critique_projection_version") !== summary.historical.version || field("critique_projection_sha256") !== summary.historical.digest || field("critique_projection_length") !== summary.historical.length || field("critique_projection_tail_hash") !== summary.historical.tail_hash || authorization.current_critique_projection_version !== summary.current.version || authorization.current_critique_projection_sha256 !== summary.current.digest || authorization.current_critique_projection_length !== summary.current.length || authorization.current_critique_projection_tail_hash !== summary.current.tail_hash || authorization.historical_resolution_edge_projection_sha256 !== summary.historical_edges.digest || authorization.historical_resolution_edge_projection_count !== summary.historical_edges.count) throw new Error("history repair authorization critique projection binding changed");
  const currentEdges = critiqueResolutionEdgeProjectionSummary(currentClaims);
  if (authorization.current_resolution_edge_projection_sha256 !== currentEdges.digest || authorization.current_resolution_edge_projection_count !== currentEdges.count) throw new Error("history repair authorization current resolution-edge projection changed");
  if (authorization.historical_ledger_prefix_length !== prefix.length || authorization.historical_ledger_prefix_raw_sha256 !== prefix.raw_sha256 || authorization.historical_ledger_prefix_canonical_sha256 !== prefix.canonical_sha256 || authorization.historical_ledger_prefix_tail_hash !== prefix.tail_hash) throw new Error("history repair authorization historical ledger prefix changed");
}
function deriveHistoricalRepairBridge(paths, authorization, bundleBytes, bundle, ledger, options = {}) {
  if (authorization.operation !== "repair-critique-resolution-history" || authorization.current_bundle_sha256 !== sha256(bundleBytes) || authorization.current_ledger_sha256 !== sha256(ledger.bytes) || authorization.current_ledger_length !== ledger.events.length || authorization.current_ledger_tail_hash !== (ledger.events.at(-1)?.event_hash ?? "0".repeat(64))) throw new Error("history repair authorization does not bind the exact current preimages");
  const historical = historicalCompletionForBridge(paths, authorization);
  const attachment = historicalAttachment(paths, authorization, historical.completion, options);
  const prefix = selectUniqueHistoricalLedgerPrefix(attachment.bundle, ledger.events, historical.completion.result_core_sha256);
  // A durable operation identity comes only from the signed authority event in
  // the unique reproducing prefix. A zero-length prefix has no such anchor.
  const historicalEvent = prefix.events.at(-1);
  if (!record(historicalEvent?.signed_authorization) || historicalEvent.operation !== historical.completion.action || historicalEvent.run_id !== paths.runId || historicalEvent.signed_authorization.project_root !== paths.projectRoot) throw new Error("historical completion has no matching signed ledger authorization");
  const identity = operationIdentity({ action: historical.completion.action, request: { project_root: paths.projectRoot, session_dir: paths.sessionDir } }, historicalEvent.signed_authorization);
  if (authorization.historical_durable_operation_id !== identity.id) throw new Error("history repair authorization durable operation identity changed");
  const summary = assertAppendOnlyCritiqueHistory(attachment.bundle.claims, bundle.claims);
  exactBridgeSummary(summary, bundle.claims, authorization, prefix);
  if (authorization.historical_bridge_sha256 !== critiqueResolutionHistoryBridgeDigest(authorization)) throw new Error("history repair authorization bridge digest is invalid");
  return { digest: authorization.historical_bridge_sha256, completion_sha256: historical.digest, durable_operation_id: identity.id, durable_key_id: identity.keyId, durable_nonce: identity.nonce, historical_completion: historical.completion, historical_event: historicalEvent };
}
function verifyHistoricalDurableAnchor(bridge, authorization, historicalCompletion) {
  const completionFile = path.join(STATE_ROOT, "completions", `${bridge.durable_operation_id}.json`);
  const durableCompletion = durableJson(completionFile, "historical durable completion record");
  const historicalAuthorizationSha256 = sha256(canonicalJson(historicalCompletion.event.signed_authorization));
  const expectedCompletion = { authorization_sha256: historicalAuthorizationSha256, request_sha256: historicalCompletion.completion.request_sha256, result_core_sha256: historicalCompletion.completion.result_core_sha256, completion: historicalCompletion.completion };
  if (canonicalJson(durableCompletion) !== canonicalJson(expectedCompletion) || sha256(canonicalJson(durableCompletion)) !== authorization.historical_durable_completion_record_sha256) throw new Error("historical durable completion record does not match the signed bridge");
  const nonceFile = path.join(STATE_ROOT, "nonces", `${sha256(`${bridge.durable_key_id}\u0000${bridge.durable_nonce}`)}.json`);
  const nonce = durableJson(nonceFile, "historical durable nonce record");
  const expectedNonce = { schema_version: PROTOCOL_VERSION, operation_id: bridge.durable_operation_id, authorization_sha256: historicalAuthorizationSha256, key_id: bridge.durable_key_id, nonce: bridge.durable_nonce, request_sha256: historicalCompletion.completion.request_sha256, status: "applied", result_core_sha256: historicalCompletion.completion.result_core_sha256 };
  if (canonicalJson(nonce) !== canonicalJson(expectedNonce)) throw new Error("historical durable nonce record does not match the signed bridge");
}
function verifyRootHistoricalBridge(paths, authorization) {
  const bundleBytes = protectedRegularFile(path.join(paths.sessionDir, "trust.bundle"), "trust bundle", 4 * 1024 * 1024);
  const bundle = JSON.parse(bundleBytes.toString("utf8"));
  const ledger = loadResolutionEventLedger(paths, bundle, authorization, authorization.operation);
  const bridge = deriveHistoricalRepairBridge(paths, authorization, bundleBytes, bundle, ledger);
  verifyHistoricalDurableAnchor(bridge, authorization, { completion: bridge.historical_completion, event: bridge.historical_event });
  return publicBridge(bridge);
}
function openGateId(definition, state) {
  const matches = Object.entries(definition.gates ?? {}).filter(([, gate]) => record(gate) && gate.step === state.current_step).map(([id]) => id);
  if (matches.length !== 1) throw new Error("canonical Flow run must have exactly one current gate for lifecycle trust synchronization");
  return matches[0];
}
function currentGatePolicy(definition, state) {
  const gateId = openGateId(definition, state);
  const gate = definition.gates?.[gateId];
  if (!record(gate) || !Array.isArray(gate.expects)) throw new Error("canonical Flow current gate has no protected expectation requirements");
  return { gate_id: gateId, requirements: structuredClone(gate.expects) };
}
async function prepareCanonicalFlowSynchronization(paths, bundle, envelope, expectedPreimage = null) {
  const { flow, pin, artifact_sha256 } = await loadPinnedFlowReducer();
  const files = canonicalFlowPaths(paths);
  const definitionBytes = protectedRegularFile(files.definition, "canonical Flow definition", 4 * 1024 * 1024);
  const stateBytes = protectedRegularFile(files.state, "canonical Flow state", 4 * 1024 * 1024);
  const manifestBytes = protectedRegularFile(files.manifest, "canonical Flow evidence manifest", MAX_CANONICAL_FLOW_MANIFEST_BYTES);
  const definition = JSON.parse(definitionBytes.toString("utf8"));
  const state = JSON.parse(stateBytes.toString("utf8"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (definition.id !== "builder.build" || state.definition_id !== "builder.build" || state.current_step !== "verify") {
    throw new Error("critique resolution is authorized only for the canonical builder.build verify step");
  }
  const flowPreimage = { run_head: flow.flowRunHead(state), manifest_sha256: sha256(manifestBytes) };
  if (expectedPreimage !== null && (
    definition.id !== expectedPreimage.definition_id
    || state.current_step !== expectedPreimage.step_id
    || state.subject !== expectedPreimage.subject
    || flowPreimage.run_head !== expectedPreimage.run_head
    || flowPreimage.manifest_sha256 !== expectedPreimage.manifest_sha256
  )) throw new Error("canonical Flow preimage no longer matches the signed lifecycle authorization");
  const gateId = openGateId(definition, state);
  if (expectedPreimage !== null && expectedPreimage.gate_id !== gateId) throw new Error("canonical Flow gate no longer matches the signed lifecycle authorization");
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
  if (!fs.readFileSync(files.definition).equals(definitionBytes) || !fs.readFileSync(files.state).equals(stateBytes) || !fs.readFileSync(files.manifest).equals(manifestBytes)) throw new Error("canonical Flow preimage changed during lifecycle trust synchronization");
  const postimages = [{ file: evidenceFile, bytes: bundleBytes, label: "canonical Flow stored trust bundle", max_bytes: 4 * 1024 * 1024 }];
  for (const artifact of reduced.write.artifacts) {
    const destination = path.join(files.root, artifact.path);
    const bytes = Buffer.from(typeof artifact.value === "string" ? artifact.value : `${JSON.stringify(artifact.value, null, 2)}\n`);
    postimages.push({ file: destination, bytes, label: artifact.path === "evidence/manifest.json" ? "canonical Flow evidence manifest" : "canonical Flow reducer artifact", max_bytes: artifact.path === "evidence/manifest.json" ? MAX_CANONICAL_FLOW_MANIFEST_BYTES : 16 * 1024 * 1024 });
  }
  return { reducer: { ...reduced.identity, artifact_sha256 }, attachment_id: attachmentId, flow_preimage: flowPreimage, postimages };
}
async function synchronizeCanonicalFlow(paths, bundle, envelope, expectedPreimage = null) {
  const prepared = await prepareCanonicalFlowSynchronization(paths, bundle, envelope, expectedPreimage);
  for (const postimage of prepared.postimages) atomicWrite(postimage.file, postimage.bytes, 0o644);
  return prepared;
}
function assertCanonicalFlowPostimages(synchronized) {
  if (!record(synchronized) || !Array.isArray(synchronized.postimages) || synchronized.postimages.length === 0) throw new Error("canonical Flow synchronization postimages are missing");
  for (const postimage of synchronized.postimages) {
    if (!record(postimage) || !Buffer.isBuffer(postimage.bytes) || typeof postimage.file !== "string") throw new Error("canonical Flow synchronization postimage is invalid");
    const current = protectedRegularFile(postimage.file, postimage.label, postimage.max_bytes);
    if (!current.equals(postimage.bytes)) throw new Error("canonical Flow postimage changed after lifecycle trust synchronization");
  }
}
function sessionSubject(paths) {
  const state = protectedJson(path.join(paths.sessionDir, "state.json"), "workflow session state", 4 * 1024 * 1024);
  if (!Array.isArray(state.work_item_refs) || state.work_item_refs.length !== 1 || typeof state.work_item_refs[0] !== "string" || !state.work_item_refs[0]) {
    throw new Error("workflow session must bind exactly one Work Item");
  }
  return state.work_item_refs[0];
}
function assignmentFile(paths) { return path.join(paths.projectRoot, ".kontourai", "flow-agents", "assignment", `${paths.runId}.json`); }
function assertAuthorizationBinding(paths, authorization, run) {
  if (authorization.project_root !== paths.projectRoot) throw new Error("authorization does not bind the canonical project root");
  if (authorization.subject !== sessionSubject(paths) || authorization.subject !== run.state.subject) throw new Error("authorization subject does not bind the canonical Flow run and session");
  if (!record(authorization.request) || !record(authorization.assignment_actor) || typeof authorization.assignment_actor_key !== "string") throw new Error("lifecycle authorization is malformed");
}
function releaseAssignment(paths, authorization) {
  const file = assignmentFile(paths);
  if (!fs.existsSync(file)) return false;
  const current = protectedJson(file, "canonical assignment", 256 * 1024);
  if (current.status === "released") return false;
  if (current.status !== "claimed" || current.actor_key !== authorization.assignment_actor_key || !assignmentActorsMatch(current.actor, authorization.assignment_actor)) {
    throw new Error("authorization does not bind the canonical assignment holder");
  }
  const at = new Date().toISOString();
  const released = { ...current, status: "released", audit_trail: [...(Array.isArray(current.audit_trail) ? current.audit_trail : []), { at, transition: "release", from_actor: current.actor, to_actor: authorization.assignment_actor, reason: authorization.request.reason }] };
  atomicWrite(file, `${JSON.stringify(released, null, 2)}\n`, 0o644);
  return true;
}
function assertLiveAssignmentHolder(paths, authorization) {
  const file = assignmentFile(paths);
  if (!fs.existsSync(file)) throw new Error("canonical assignment holder is required before Flow cancellation");
  const current = protectedJson(file, "canonical assignment", 256 * 1024);
  if (current.status !== "claimed" || current.actor_key !== authorization.assignment_actor_key || !assignmentActorsMatch(current.actor, authorization.assignment_actor)) {
    throw new Error("authorization does not bind the live canonical assignment holder");
  }
}
async function cancelCanonicalFlow(paths, authorization) {
  const { flow } = await loadPinnedFlowReducer();
  const run = await flow.loadRun(paths.runId, paths.projectRoot);
  assertAuthorizationBinding(paths, authorization, run);
  // Check the exact active holder before the irreversible canonical transition.
  // A stale or released assignment must leave the Flow run untouched.
  assertLiveAssignmentHolder(paths, authorization);
  const result = await flow.cancelRun(paths.runId, { cwd: paths.projectRoot, ...authorization.request });
  const assignmentReleased = releaseAssignment(paths, authorization);
  return { result_core_sha256: sha256({ state: result.state, assignment_released: assignmentReleased }), assignmentReleased };
}
async function reconcileCanceledFlow(paths, authorization) {
  const { flow } = await loadPinnedFlowReducer(); const run = await flow.loadRun(paths.runId, paths.projectRoot);
  assertAuthorizationBinding(paths, authorization, run);
  const assignment = protectedJson(assignmentFile(paths), "canonical assignment", 256 * 1024);
  if (run.state.status !== "canceled" || assignment.status !== "released" || assignment.actor_key !== authorization.assignment_actor_key || !assignmentActorsMatch(assignment.actor, authorization.assignment_actor)) return null;
  return { result_core_sha256: sha256({ state: run.state, assignment_released: true }), run_id: paths.runId };
}
async function archiveCanonicalSession(paths, authorization) {
  const { flow } = await loadPinnedFlowReducer();
  const run = await flow.loadRun(paths.runId, paths.projectRoot);
  assertAuthorizationBinding(paths, authorization, run);
  if (!['canceled', 'completed'].includes(run.state.status)) throw new Error("only canceled or completed canonical Flow runs may be archived");
  const archiveRoot = path.join(paths.projectRoot, ".kontourai", "flow-agents", "archive");
  if (fs.existsSync(archiveRoot)) {
    const stat = fs.lstatSync(archiveRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("workflow archive root must be a real directory");
  } else {
    fs.mkdirSync(archiveRoot, { recursive: true, mode: 0o755 });
  }
  const destination = path.join(archiveRoot, paths.runId);
  if (fs.existsSync(destination)) throw new Error("workflow archive destination already exists");
  fs.renameSync(paths.sessionDir, destination);
  return { result_core_sha256: sha256({ canonical_status: run.state.status, archived_session: path.relative(paths.projectRoot, destination) }) };
}
function completion(envelope, paths, operationStatus, resultCoreSha256) {
  const unsigned = { schema_version: PROTOCOL_VERSION, kind: "kontourai.lifecycle-authority.completion", action: envelope.action, request_sha256: envelope.request_sha256, run_id: paths.runId, operation_status: operationStatus, result_core_sha256: resultCoreSha256, coordinator_runtime_sha256: coordinatorRuntimeSha256(), completed_at: new Date().toISOString() };
  const privateKey = crypto.createPrivateKey(protectedRegularFile(COMPLETION_PRIVATE_KEY_FILE, "completion signing key", 16 * 1024));
  return { ...unsigned, signature: { algorithm: "ed25519", value: crypto.sign(null, Buffer.from(canonicalJson(unsigned)), privateKey).toString("base64") } };
}
function signedCapability(kind, value) {
  const unsigned = { schema_version: PROTOCOL_VERSION, kind: `kontourai.lifecycle-authority.${kind}`, value };
  const privateKey = crypto.createPrivateKey(protectedRegularFile(COMPLETION_PRIVATE_KEY_FILE, "completion signing key", 16 * 1024));
  return { ...unsigned, signature: { algorithm: "ed25519", value: crypto.sign(null, Buffer.from(canonicalJson(unsigned)), privateKey).toString("base64") } };
}
function verifiedCapability(capability, kind) {
  if (!record(capability) || capability.schema_version !== PROTOCOL_VERSION || capability.kind !== `kontourai.lifecycle-authority.${kind}` || !record(capability.value) || !record(capability.signature) || capability.signature.algorithm !== "ed25519" || typeof capability.signature.value !== "string") throw new Error("mutation worker capability is invalid");
  const { signature, ...unsigned } = capability;
  const publicKey = crypto.createPublicKey(protectedRegularFile(COMPLETION_PUBLIC_KEY_FILE, "completion verification key", 16 * 1024));
  if (!crypto.verify(null, Buffer.from(canonicalJson(unsigned)), publicKey, Buffer.from(signature.value, "base64"))) throw new Error("mutation worker capability signature is invalid");
  return capability.value;
}
async function withDurableLock(requestSha256, callback) {
  const lock = path.join(STATE_ROOT, "locks", requestSha256);
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  fs.mkdirSync(lock, { mode: 0o700 });
  try { return await callback(); } finally { fs.rmdirSync(lock); }
}
function publicBridge(bridge) {
  return { digest: bridge.digest, completion_sha256: bridge.completion_sha256, durable_operation_id: bridge.durable_operation_id, durable_key_id: bridge.durable_key_id, durable_nonce: bridge.durable_nonce };
}
async function assertVerificationResealCurrentPreimages({ paths, authorization, bundleFile, beforeBytes, candidateFile, candidateBytes, completionBytes, ledger, files }) {
  if (!protectedRegularFile(bundleFile, "trust bundle", 4 * 1024 * 1024).equals(beforeBytes)
      || !protectedRegularFile(candidateFile, "verification evidence candidate", 4 * 1024 * 1024).equals(candidateBytes)) {
    throw new Error("verification evidence reseal bundle or candidate changed during preparation");
  }
  assertResolutionEventLedgerPreimage(paths, ledger);
  const currentCompletionBytes = protectedRegularFile(path.join(paths.sessionDir, "lifecycle-authority.completion.json"), "current lifecycle completion", 256 * 1024);
  if (!currentCompletionBytes.equals(completionBytes)) throw new Error("verification evidence reseal current completion changed during preparation");
  const currentCompletion = assertCurrentLifecycleCompletion(paths, JSON.parse(currentCompletionBytes.toString("utf8")), JSON.parse(beforeBytes.toString("utf8")), ledger.events);
  if (sha256(currentCompletionBytes) !== authorization.current_completion_sha256
      || currentCompletion.request_sha256 !== authorization.current_completion_request_sha256
      || currentCompletion.result_core_sha256 !== authorization.current_completion_result_core_sha256) {
    throw new Error("verification evidence reseal current completion no longer matches the signed authorization");
  }
  const manifestBytes = protectedRegularFile(files.manifest, "canonical Flow evidence manifest", MAX_CANONICAL_FLOW_MANIFEST_BYTES);
  const state = protectedJson(files.state, "canonical Flow state", 4 * 1024 * 1024);
  const definition = protectedJson(files.definition, "canonical Flow definition", 4 * 1024 * 1024);
  const gatePolicy = currentGatePolicy(definition, state);
  const { flow } = await loadPinnedFlowReducer();
  const flowPreimage = { run_head: flow.flowRunHead(state), manifest_sha256: sha256(manifestBytes) };
  if (authorization.subject !== sessionSubject(paths) || authorization.subject !== state.subject
      || definition.id !== authorization.flow_definition_id || state.current_step !== authorization.flow_step_id
      || gatePolicy.gate_id !== authorization.flow_gate_id
      || flowPreimage.run_head !== authorization.flow_run_head || flowPreimage.manifest_sha256 !== authorization.flow_manifest_sha256) {
    throw new Error("verification evidence reseal canonical Flow preimage no longer matches the signed authorization");
  }
  return { ...flowPreimage, gate_policy: gatePolicy };
}

function assertVerificationResealFinalPublicationBoundary({ paths, authorization, bundleFile, beforeBytes, candidateFile, candidateBytes, completionBytes, ledger, synchronized }) {
  if (!protectedRegularFile(bundleFile, "trust bundle", 4 * 1024 * 1024).equals(beforeBytes)
      || !protectedRegularFile(candidateFile, "verification evidence candidate", 4 * 1024 * 1024).equals(candidateBytes)) {
    throw new Error("verification evidence reseal bundle or candidate changed at final publication");
  }
  const currentCompletionBytes = protectedRegularFile(path.join(paths.sessionDir, "lifecycle-authority.completion.json"), "current lifecycle completion", 256 * 1024);
  if (!currentCompletionBytes.equals(completionBytes)) throw new Error("verification evidence reseal current completion changed at final publication");
  const currentCompletion = assertCurrentLifecycleCompletion(paths, JSON.parse(currentCompletionBytes.toString("utf8")), JSON.parse(beforeBytes.toString("utf8")), ledger.events);
  if (sha256(currentCompletionBytes) !== authorization.current_completion_sha256
      || currentCompletion.request_sha256 !== authorization.current_completion_request_sha256
      || currentCompletion.result_core_sha256 !== authorization.current_completion_result_core_sha256) {
    throw new Error("verification evidence reseal final publication completion is stale");
  }
  if (!record(synchronized?.flow_preimage)
      || synchronized.flow_preimage.run_head !== authorization.flow_run_head
      || synchronized.flow_preimage.manifest_sha256 !== authorization.flow_manifest_sha256) {
    throw new Error("verification evidence reseal final publication does not retain the signed Flow preimage");
  }
  assertCanonicalFlowPostimages(synchronized);
  assertResolutionEventLedgerPreimage(paths, ledger);
}
async function prepareVerificationResealTransaction(envelope, paths, authorization) {
  const binding = { request_sha256: envelope.request_sha256, authorization_sha256: sha256(canonicalJson(authorization)) };
  rejectActiveLegacyResealJournal(paths, binding);
  await preflightVerificationResealFlowCapabilities();
  return withCanonicalFlowRunMutationLock(paths, async () => {
    const fence = inspectVerificationResealFence(paths);
    if (fence.status !== "open") throw new Error("verification reseal cannot capture artifacts while the Flow recovery fence is active");
    if (fs.existsSync(verificationResealPlanFile(paths))) throw new Error("verification reseal found an existing signed plan; recovery is required");
    const bundleFile = path.join(paths.sessionDir, "trust.bundle");
    const beforeBytes = protectedRegularFile(bundleFile, "trust bundle", 4 * 1024 * 1024);
    const before = JSON.parse(beforeBytes.toString("utf8"));
    const ledger = loadResolutionEventLedger(paths, before, authorization, envelope.action);
    const candidateFile = path.join(paths.sessionDir, `.workflow-evidence-transaction-${authorization.candidate_transaction_id}`, "trust.bundle.candidate");
    if (!within(candidateFile, paths.sessionDir) || path.dirname(path.dirname(candidateFile)) !== paths.sessionDir) throw new Error("verification evidence candidate path is invalid");
    const candidateBytes = protectedRegularFile(candidateFile, "verification evidence candidate", 4 * 1024 * 1024);
    const candidate = JSON.parse(candidateBytes.toString("utf8"));
    const completionBytes = protectedRegularFile(path.join(paths.sessionDir, "lifecycle-authority.completion.json"), "current lifecycle completion", 256 * 1024);
    const currentCompletion = assertCurrentLifecycleCompletion(paths, JSON.parse(completionBytes.toString("utf8")), before, ledger.events);
    if (sha256(completionBytes) !== authorization.current_completion_sha256
        || currentCompletion.request_sha256 !== authorization.current_completion_request_sha256
        || currentCompletion.result_core_sha256 !== authorization.current_completion_result_core_sha256) {
      throw new Error("verification evidence reseal authorization does not bind the exact current completion");
    }
    const files = canonicalFlowPaths(paths);
    const manifestBytes = protectedRegularFile(files.manifest, "canonical Flow evidence manifest", MAX_CANONICAL_FLOW_MANIFEST_BYTES);
    const state = protectedJson(files.state, "canonical Flow state", 4 * 1024 * 1024);
    const definition = protectedJson(files.definition, "canonical Flow definition", 4 * 1024 * 1024);
    const gatePolicy = currentGatePolicy(definition, state);
    const { flow } = await loadPinnedFlowReducer();
    if (authorization.subject !== sessionSubject(paths) || authorization.subject !== state.subject
        || definition.id !== authorization.flow_definition_id || state.current_step !== authorization.flow_step_id
        || gatePolicy.gate_id !== authorization.flow_gate_id
        || flow.flowRunHead(state) !== authorization.flow_run_head || sha256(manifestBytes) !== authorization.flow_manifest_sha256) {
      throw new Error("verification evidence reseal authorization does not bind the exact canonical Flow preimage");
    }
    if (critiqueHistoryProjectionSummary(before.claims).digest !== authorization.critique_projection_sha256) throw new Error("verification evidence reseal authorization critique projection is stale");
    const lockedPreimage = await assertVerificationResealCurrentPreimages({
      paths, authorization, bundleFile, beforeBytes, candidateFile, candidateBytes, completionBytes, ledger, files,
    });
    const reduced = resealVerificationEvidenceTransition({
      current_bundle: before, candidate_bundle: candidate, resolution_events: ledger.events, authorization,
      current_bundle_bytes: beforeBytes, candidate_bundle_bytes: candidateBytes, ledger_bytes: ledger.bytes,
      flow: { definition_id: definition.id, step_id: state.current_step, ...lockedPreimage.gate_policy },
    });
    const resultCoreSha256 = lifecycleAuthorityResultDigest(reduced.bundle, reduced.resolution_events);
    const synchronized = await prepareCanonicalFlowSynchronization(paths, reduced.bundle, envelope, {
      definition_id: authorization.flow_definition_id,
      step_id: authorization.flow_step_id,
      gate_id: authorization.flow_gate_id,
      subject: authorization.subject,
      run_head: authorization.flow_run_head,
      manifest_sha256: authorization.flow_manifest_sha256,
    });
    const artifactFiles = verificationResealArtifactFiles(paths, envelope.request_sha256);
    const postimageByFile = new Map([
      [bundleFile, candidateBytes],
      ...synchronized.postimages.map((postimage) => [postimage.file, postimage.bytes]),
    ]);
    if (postimageByFile.size !== VERIFICATION_RESEAL_ARTIFACT_IDS.length
        || [...artifactFiles.values()].some((file) => !postimageByFile.has(file))) {
      throw new Error("verification reseal reducer did not produce exactly the fixed six artifacts");
    }
    const artifacts = [];
    for (const id of VERIFICATION_RESEAL_ARTIFACT_IDS) {
      const file = artifactFiles.get(id);
      const preimage = readVerificationResealArtifact(file, `verification reseal artifact ${id}`);
      const postBytes = postimageByFile.get(file);
      const post = exactArtifactDescriptor(postBytes, 0o644);
      stageVerificationResealImage(file, preimage.bytes, preimage.descriptor.mode, "old");
      stageVerificationResealImage(file, postBytes, post.mode, "new");
      artifacts.push({ id, pre: preimage.descriptor, post });
    }
    const planCore = {
      schema_version: PROTOCOL_VERSION,
      kind: VERIFICATION_RESEAL_TRANSACTION_PROTOCOL,
      run_id: paths.runId,
      request_sha256: envelope.request_sha256,
      authorization_sha256: binding.authorization_sha256,
      authorization_key_id: authorization.signature.key_id,
      authorization_nonce: authorization.nonce,
      reducer: synchronized.reducer,
      result_core_sha256: resultCoreSha256,
      artifacts,
    };
    const plan = validateVerificationResealPlan({ ...planCore, recovery_id: sha256(planCore) });
    return { run_id: paths.runId, plan };
  });
}
function assertVerificationResealStages(paths, plan) {
  const files = verificationResealArtifactFiles(paths, plan.request_sha256);
  for (const artifact of plan.artifacts) {
    const file = files.get(artifact.id);
    for (const [image, expected] of [["old", artifact.pre], ["new", artifact.post]]) {
      const actual = readVerificationResealArtifact(verificationResealStageFile(file, image), `verification reseal ${image} stage`).descriptor;
      if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`verification reseal ${image} stage for ${artifact.id} changed`);
    }
  }
}
async function publishVerificationResealTransaction(paths, capability, binding) {
  const value = verifiedCapability(capability, "reseal-plan-capability");
  if (!record(value.plan)) throw new Error("verification reseal plan capability payload is invalid");
  const plan = assertVerificationResealPlanBinding(value.plan, paths, binding);
  const observedFence = inspectVerificationResealFence(paths);
  const withLock = observedFence.status === "active"
    ? (operation) => withCanonicalFlowRunRecoveryLock(paths, observedFence.recovery_id, operation)
    : (operation) => withCanonicalFlowRunMutationLock(paths, operation);
  return withLock(async () => {
    rejectActiveLegacyResealJournal(paths, binding);
    const planFile = verificationResealPlanFile(paths);
    if (fs.existsSync(planFile)) {
      const current = protectedJson(planFile, "verification reseal signed plan", 1024 * 1024);
      if (canonicalJson(current) !== canonicalJson(capability)) throw new Error("verification reseal signed plan changed");
    } else atomicWrite(planFile, `${JSON.stringify(capability, null, 2)}\n`, 0o644);
    assertVerificationResealStages(paths, plan);
    const classification = classifyVerificationResealArtifacts(paths, plan);
    if (classification === "unknown") {
      const fence = inspectVerificationResealFence(paths);
      if (fence.status === "open") await writeVerificationResealFence(paths, plan.recovery_id, "active");
      else if (fence.recovery_id !== plan.recovery_id) throw new Error("verification reseal recovery fence belongs to another generation");
      quarantineVerificationResealTransaction(paths, plan);
      throw new Error("verification reseal artifacts are mixed or unknown and were quarantined");
    }
    if (classification === "old") {
      const fence = inspectVerificationResealFence(paths);
      if (fence.status === "open") await writeVerificationResealFence(paths, plan.recovery_id, "active");
      else if (fence.recovery_id !== plan.recovery_id) throw new Error("verification reseal recovery fence belongs to another generation");
      const files = verificationResealArtifactFiles(paths, plan.request_sha256);
      for (const artifact of plan.artifacts) {
        const file = files.get(artifact.id);
        const bytes = readVerificationResealArtifact(verificationResealStageFile(file, "new"), `verification reseal new stage ${artifact.id}`).bytes;
        if (artifact.post.presence === "present") atomicWrite(file, bytes, artifact.post.mode);
        else if (fs.existsSync(file)) fs.unlinkSync(file);
      }
    }
    if (classifyVerificationResealArtifacts(paths, plan) !== "new") throw new Error("verification reseal publication did not install the exact postimages");
    const fence = inspectVerificationResealFence(paths);
    if (fence.status !== "active" || fence.recovery_id !== plan.recovery_id) throw new Error("verification reseal publication lost its active Flow recovery fence");
    return { result_core_sha256: plan.result_core_sha256, run_id: paths.runId, recovery_id: plan.recovery_id };
  });
}
async function recoverVerificationResealTransaction(paths, binding) {
  const observedFence = inspectVerificationResealFence(paths);
  const withLock = observedFence.status === "active"
    ? (operation) => withCanonicalFlowRunRecoveryLock(paths, observedFence.recovery_id, operation)
    : (operation) => withCanonicalFlowRunMutationLock(paths, operation);
  return withLock(async () => {
    rejectActiveLegacyResealJournal(paths, binding);
    if (!fs.existsSync(verificationResealPlanFile(paths))) {
      const fence = inspectVerificationResealFence(paths);
      if (fence.status === "active") throw new Error("active Flow recovery fence has no signed verification reseal plan");
      return { run_id: paths.runId, recovered: false, state: "none" };
    }
    const { capability, plan } = readSignedVerificationResealPlan(paths);
    assertVerificationResealPlanBinding(plan, paths, binding);
    const classification = classifyVerificationResealArtifacts(paths, plan);
    if (classification === "unknown") {
      const fence = inspectVerificationResealFence(paths);
      if (fence.status === "open") await writeVerificationResealFence(paths, plan.recovery_id, "active");
      else if (fence.recovery_id !== plan.recovery_id) throw new Error("verification reseal recovery fence belongs to another generation");
      quarantineVerificationResealTransaction(paths, plan);
      throw new Error("verification reseal recovery found mixed or unknown artifacts and quarantined them");
    }
    if (classification === "new") {
      const fence = inspectVerificationResealFence(paths);
      if (fence.status !== "active" || fence.recovery_id !== plan.recovery_id) throw new Error("published verification reseal generation is missing its active recovery fence");
      return { run_id: paths.runId, recovered: true, state: "new", result_core_sha256: plan.result_core_sha256 };
    }
    return { run_id: paths.runId, recovered: true, state: "old", capability };
  });
}
async function finalizeVerificationResealTransaction(paths, completion) {
  const observedFence = inspectVerificationResealFence(paths);
  if (observedFence.status !== "active") {
    if (fs.existsSync(verificationResealPlanFile(paths))) {
      const { plan } = readSignedVerificationResealPlan(paths);
      if (completion.request_sha256 !== plan.request_sha256 || completion.result_core_sha256 !== plan.result_core_sha256) {
        throw new Error("verification reseal cleanup replay does not bind the signed plan result");
      }
      const receipt = protectedJson(path.join(paths.sessionDir, "lifecycle-authority.completion.json"), "verification reseal completion receipt", 256 * 1024);
      if (canonicalJson(receipt) !== canonicalJson(completion)) throw new Error("verification reseal cleanup replay receipt is not exact");
      if (classifyVerificationResealArtifacts(paths, plan) !== "new") throw new Error("verification reseal cleanup replay does not retain exact postimages");
      cleanupVerificationResealTransaction(paths, plan);
      return { run_id: paths.runId, finalized: true, cleanup_replayed: true };
    }
    return { run_id: paths.runId, finalized: false };
  }
  const finalized = await withCanonicalFlowRunRecoveryLock(paths, observedFence.recovery_id, async () => {
    const { plan } = readSignedVerificationResealPlan(paths);
    if (completion.request_sha256 !== plan.request_sha256 || completion.result_core_sha256 !== plan.result_core_sha256) {
      throw new Error("verification reseal durable completion does not bind the signed plan result");
    }
    const receipt = protectedJson(path.join(paths.sessionDir, "lifecycle-authority.completion.json"), "verification reseal completion receipt", 256 * 1024);
    if (canonicalJson(receipt) !== canonicalJson(completion)) throw new Error("verification reseal exact completion receipt is not installed");
    if (classifyVerificationResealArtifacts(paths, plan) !== "new") throw new Error("verification reseal cannot finalize without exact postimages");
    const fence = inspectVerificationResealFence(paths);
    if (fence.status !== "active" || fence.recovery_id !== plan.recovery_id
        || fence.generation !== observedFence.generation) {
      throw new Error("verification reseal cannot finalize without its exact active Flow recovery fence generation");
    }
    return { plan, generation: fence.generation, result: { run_id: paths.runId, finalized: true } };
  });
  await finalizeVerificationResealFence(paths, finalized.plan.recovery_id, finalized.generation);
  cleanupVerificationResealTransaction(paths, finalized.plan);
  return finalized.result;
}
export function cleanupVerificationResealTransaction(paths, plan, hooks = {}) {
  const files = verificationResealArtifactFiles(paths, plan.request_sha256);
  const stages = [...files.values()].flatMap((artifact) => [
    verificationResealStageFile(artifact, "old"),
    verificationResealStageFile(artifact, "new"),
  ]);
  for (const file of stages) {
    hooks.before_unlink?.(file);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  const planFile = verificationResealPlanFile(paths);
  hooks.before_unlink?.(planFile);
  if (fs.existsSync(planFile)) fs.unlinkSync(planFile);
}
async function executeMutation(envelope, paths, authorization, completionRecord = null, verifiedBridge = null) {
    if (authorization.project_root !== paths.projectRoot) throw new Error("authorization does not bind the canonical project root");
    if (envelope.action === "reseal-verification-evidence") throw new Error("verification evidence reseal requires the signed prepare/publish protocol");
    if (["resolve-critique", "repair-critique-resolution-history"].includes(envelope.action)) {
      const bundleFile = path.join(paths.sessionDir, "trust.bundle");
      const beforeBytes = protectedRegularFile(bundleFile, "trust bundle", 4 * 1024 * 1024);
      assertAuthorizedBundlePreimage(beforeBytes, envelope.action, authorization);
      const before = JSON.parse(beforeBytes.toString("utf8"));
      const ledger = loadResolutionEventLedger(paths, before, authorization, envelope.action);
      const resolutionEvents = ledger.events;
      const bridge = envelope.action === "repair-critique-resolution-history"
        ? deriveHistoricalRepairBridge(paths, authorization, beforeBytes, before, ledger)
        : null;
      if (bridge && (!record(verifiedBridge) || canonicalJson(publicBridge(bridge)) !== canonicalJson(verifiedBridge))) throw new Error("history repair bridge was not verified by the protected coordinator");
      const reduced = envelope.action === "resolve-critique"
        ? resolveCritiqueTransition({ bundle: before, resolution_events: resolutionEvents, authorization, prior_record_id: envelope.request.prior_record_id, resolving_record_id: envelope.request.resolving_record_id })
        : repairCritiqueResolutionHistoryTransition({
          bundle: before, resolution_events: resolutionEvents, authorization,
          prior_record_id: envelope.request.prior_record_id, resolving_record_id: envelope.request.resolving_record_id,
          current_completion_sha256: bridge.completion_sha256, ledger_bytes_sha256: sha256(ledger.bytes),
        });
      const sessionBundle = reduced.bundle;
      const nextResolutionEvents = reduced.resolution_events;
      const resultCoreSha256 = lifecycleAuthorityResultDigest(sessionBundle, nextResolutionEvents);
      await inProjectTransaction(paths, { request_sha256: envelope.request_sha256, authorization_sha256: sha256(canonicalJson(authorization)) }, async () => {
        // Keep the signed request bound to the exact protected bytes at the
        // mutation boundary, not to a parsed and reserialized object.
        const currentBytes = protectedRegularFile(bundleFile, "trust bundle", 4 * 1024 * 1024);
        assertAuthorizedBundlePreimage(currentBytes, envelope.action, authorization);
        if (!currentBytes.equals(beforeBytes)) throw new Error("critique resolution preimage changed during preparation");
        assertResolutionEventLedgerPreimage(paths, ledger);
        const synchronized = await synchronizeCanonicalFlow(paths, sessionBundle, envelope);
        // Recheck the exact preimage immediately before the session mutation.
        const finalBytes = protectedRegularFile(bundleFile, "trust bundle", 4 * 1024 * 1024);
        assertAuthorizedBundlePreimage(finalBytes, envelope.action, authorization);
        if (!finalBytes.equals(beforeBytes)) throw new Error("critique resolution preimage changed during preparation");
        assertResolutionEventLedgerPreimage(paths, ledger);
        assertCanonicalFlowPostimages(synchronized);
        if (bridge && canonicalJson(publicBridge(deriveHistoricalRepairBridge(paths, authorization, finalBytes, JSON.parse(finalBytes.toString("utf8")), loadResolutionEventLedger(paths, JSON.parse(finalBytes.toString("utf8")), authorization, envelope.action), { expectedSupersededBy: synchronized.attachment_id }))) !== canonicalJson(verifiedBridge)) throw new Error("history repair bridge changed during mutation preparation");
        if (envelope.action === "resolve-critique") atomicWrite(bundleFile, `${JSON.stringify(sessionBundle, null, 2)}\n`, 0o644);
        writeResolutionEventLedger(paths, nextResolutionEvents, ledger);
        if (completionRecord) atomicWrite(path.join(paths.sessionDir, "lifecycle-authority.completion.json"), `${JSON.stringify(completionRecord, null, 2)}\n`, 0o644);
      });
      return { result_core_sha256: resultCoreSha256, run_id: paths.runId };
    }
    const outcome = envelope.action === "cancel"
      ? await cancelCanonicalFlow(paths, authorization)
      : await archiveCanonicalSession(paths, authorization);
    return { result_core_sha256: outcome.result_core_sha256, run_id: paths.runId };
}
function callerIdentity() {
  const uid = Number(process.env.SUDO_UID); const gid = Number(process.env.SUDO_GID);
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid <= 0 || gid <= 0) throw new Error("lifecycle authority requires validated non-root SUDO_UID and SUDO_GID");
  return { uid, gid };
}
function operationIdentity(envelope, authorization) {
  const project = path.resolve(envelope.request.project_root);
  const runId = path.basename(path.resolve(envelope.request.session_dir));
  if (!runId || runId === "." || runId === path.sep) throw new Error("lifecycle authority request has an invalid session identity");
  const keyId = authorization.signature?.key_id;
  if (typeof keyId !== "string" || typeof authorization.nonce !== "string") throw new Error("authorization does not contain a durable key and nonce identity");
  return { project, runId, keyId, nonce: authorization.nonce, id: sha256({ project, run_id: runId, action: envelope.action, key_id: keyId, nonce: authorization.nonce }) };
}
function durableJson(file, label) { return JSON.parse(protectedRegularFile(file, label, 256 * 1024).toString("utf8")); }
function durableCompletionRecord(prior, envelope, identity, authorizationSha256) {
  exact(prior, ["authorization_sha256", "request_sha256", "result_core_sha256", "completion"], "completion record");
  if (prior.authorization_sha256 !== authorizationSha256 || prior.request_sha256 !== envelope.request_sha256 || !/^[a-f0-9]{64}$/.test(String(prior.result_core_sha256))) throw new Error("consumed lifecycle authorization record does not match the exact request");
  const completionRecord = prior.completion;
  const fields = ["schema_version", "kind", "action", "request_sha256", "run_id", "operation_status", "result_core_sha256", "coordinator_runtime_sha256", "completed_at", "signature"];
  exact(completionRecord, fields, "durable lifecycle completion");
  if (completionRecord.schema_version !== PROTOCOL_VERSION || completionRecord.kind !== "kontourai.lifecycle-authority.completion" || completionRecord.run_id !== identity.runId || completionRecord.action !== envelope.action || !ACTION_FIELDS[completionRecord.action] || completionRecord.request_sha256 !== envelope.request_sha256 || completionRecord.operation_status !== "applied" || completionRecord.result_core_sha256 !== prior.result_core_sha256 || !/^[a-f0-9]{64}$/.test(completionRecord.result_core_sha256) || !record(completionRecord.signature) || completionRecord.signature.algorithm !== "ed25519" || typeof completionRecord.signature.value !== "string") throw new Error("durable lifecycle completion record does not match the exact request");
  const { signature, ...unsigned } = completionRecord;
  const publicKey = crypto.createPublicKey(protectedRegularFile(COMPLETION_PUBLIC_KEY_FILE, "completion verification key", 16 * 1024));
  if (!crypto.verify(null, Buffer.from(canonicalJson(unsigned)), publicKey, Buffer.from(signature.value, "base64"))) throw new Error("durable lifecycle completion signature is invalid");
  return completionRecord;
}
function appliedNonceRecord(prepared, resultCoreSha256) {
  return { ...prepared, status: "applied", result_core_sha256: resultCoreSha256 };
}
function reconcileCompletedNonce(nonceFile, prepared, resultCoreSha256) {
  const applied = appliedNonceRecord(prepared, resultCoreSha256);
  if (!fs.existsSync(nonceFile)) throw new Error("durable lifecycle authorization nonce record is missing");
  const prior = durableJson(nonceFile, "nonce record");
  if (prior.status === "prepared") {
    assertPreparedNonceRecord(prior, prepared);
    atomicWrite(nonceFile, `${JSON.stringify(applied)}\n`);
  } else if (canonicalJson(prior) !== canonicalJson(applied)) throw new Error("consumed lifecycle authorization nonce record does not match the exact completion");
  return applied;
}
function childInvocation(payload, identity) {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { input: `${JSON.stringify(payload)}\n`, encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", FLOW_AGENTS_LIFECYCLE_MUTATION_WORKER: "1" }, uid: identity.uid, gid: identity.gid, timeout: 30_000, maxBuffer: 512 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(String(result.stderr || "unprivileged lifecycle mutation worker rejected the request").trim());
  const line = String(result.stdout).trim(); if (!line || line.includes("\n")) throw new Error("unprivileged lifecycle mutation worker returned an invalid response");
  return JSON.parse(line);
}
async function processRootOperation(envelope) {
  const authorizationPath = path.resolve(envelope.request.authorization_file);
  // Authenticate and bind before consulting durable state. Expiry is a live
  // permission check, not a reason to lose an exact completed/prepared recovery.
  const authorization = verifyAuthorization(authorizationPath, { requireCurrentExpiry: false });
  const identity = operationIdentity(envelope, authorization);
  if (authorization.operation !== envelope.action || authorization.run_id !== identity.runId) throw new Error("authorization does not bind the requested operation and run");
  const authorizationSha256 = sha256(canonicalJson(authorization));
  const completionFile = path.join(STATE_ROOT, "completions", `${identity.id}.json`);
  const nonceFile = path.join(STATE_ROOT, "nonces", `${sha256(`${identity.keyId}\u0000${identity.nonce}`)}.json`);
  const prepared = { schema_version: PROTOCOL_VERSION, operation_id: identity.id, authorization_sha256: authorizationSha256, key_id: identity.keyId, nonce: identity.nonce, request_sha256: envelope.request_sha256, status: "prepared" };
  const runLockId = sha256({ project: identity.project, run_id: identity.runId });
  return withDurableLock(runLockId, async () => {
    const caller = callerIdentity();
    if (fs.existsSync(completionFile)) {
      const prior = durableJson(completionFile, "completion record");
      const completionRecord = durableCompletionRecord(prior, envelope, identity, authorizationSha256);
      reconcileCompletedNonce(nonceFile, prepared, prior.result_core_sha256);
      if (["resolve-critique", "repair-critique-resolution-history", "reseal-verification-evidence"].includes(envelope.action)) childInvocation({ kind: "receipt", capability: signedCapability("receipt-capability", { request: envelope.request, completion: completionRecord }) }, caller);
      if (envelope.action === "reseal-verification-evidence") childInvocation({ kind: "finalize-reseal", capability: signedCapability("finalize-reseal-capability", { request: envelope.request, completion: completionRecord }) }, caller);
      return { completionRecord, replayed: true };
    }
    const transactionBinding = { request_sha256: envelope.request_sha256, authorization_sha256: authorizationSha256 };
    let resumePrepared = false;
    let verifiedBridge = null;
    if (fs.existsSync(nonceFile)) {
      const prior = durableJson(nonceFile, "nonce record");
      assertPreparedNonceRecord(prior, prepared);
      resumePrepared = true;
      if (["resolve-critique", "repair-critique-resolution-history"].includes(envelope.action)) {
        const recovery = childInvocation({ kind: "rollback", capability: signedCapability("rollback-capability", { request: envelope.request, binding: transactionBinding }) }, caller);
        if (!record(recovery) || recovery.run_id !== identity.runId || typeof recovery.rolled_back !== "boolean") throw new Error("unprivileged lifecycle transaction recovery returned an invalid response");
      }
    } else {
      verifySignedAuthorization(authorization, { requireCurrentExpiry: true });
      // Reject a stale or mismatched live holder before creating any durable
      // nonce state. A prepared nonce is intentionally exempt: it may be
      // recovering a cancel whose child mutation already completed, and the
      // child rechecks/reconciles that exact CAS state below.
      if (envelope.action === "cancel") {
        assertLiveAssignmentHolder(canonicalMutationPaths(envelope.request), authorization);
      }
      if (envelope.action === "repair-critique-resolution-history") verifiedBridge = verifyRootHistoricalBridge(canonicalMutationPaths(envelope.request), authorization);
      if (envelope.action === "reseal-verification-evidence") {
        const preflight = childInvocation({
          kind: "preflight-reseal",
          capability: signedCapability("preflight-reseal-capability", { request: envelope.request }),
        }, caller);
        if (!record(preflight) || preflight.run_id !== identity.runId || preflight.available !== true) {
          throw new Error("unprivileged verification reseal capability preflight returned an invalid response");
        }
      }
      atomicWrite(nonceFile, `${JSON.stringify(prepared)}\n`);
    }
    if (envelope.action === "repair-critique-resolution-history" && verifiedBridge === null) verifiedBridge = verifyRootHistoricalBridge(canonicalMutationPaths(envelope.request), authorization);
    // The child rechecks all worktree inputs immediately before publication. Do
    // the matching root-only completion/nonce read immediately before handing
    // it the mutation capability, so a changed durable anchor cannot be used
    // by a prepared recovery or race between the two root passes.
    if (envelope.action === "repair-critique-resolution-history") {
      const secondBridge = verifyRootHistoricalBridge(canonicalMutationPaths(envelope.request), authorization);
      if (canonicalJson(secondBridge) !== canonicalJson(verifiedBridge)) throw new Error("history repair bridge changed between root verification passes");
      verifiedBridge = secondBridge;
    }
    let mutation;
    if (envelope.action === "reseal-verification-evidence") {
      let recovery = null;
      if (resumePrepared) {
        recovery = childInvocation({ kind: "recover-reseal", capability: signedCapability("recover-reseal-capability", { request: envelope.request, binding: transactionBinding }) }, caller);
        if (!record(recovery) || recovery.run_id !== identity.runId || !["none", "old", "new"].includes(recovery.state)) {
          throw new Error("unprivileged verification reseal recovery returned an invalid response");
        }
      }
      if (recovery?.state === "new") mutation = recovery;
      else {
        let planCapability = recovery?.state === "old" ? recovery.capability : null;
        if (planCapability === null) {
          const preparedPlan = childInvocation({ kind: "prepare-reseal", capability: signedCapability("prepare-reseal-capability", { envelope, authorization }) }, caller);
          if (!record(preparedPlan) || preparedPlan.run_id !== identity.runId || !record(preparedPlan.plan)) throw new Error("unprivileged verification reseal preparation returned an invalid plan");
          const plan = validateVerificationResealPlan(preparedPlan.plan);
          if (plan.request_sha256 !== envelope.request_sha256 || plan.authorization_sha256 !== authorizationSha256
              || plan.authorization_key_id !== identity.keyId || plan.authorization_nonce !== identity.nonce || plan.run_id !== identity.runId) {
            throw new Error("verification reseal plan does not bind the root-authenticated operation");
          }
          planCapability = signedCapability("reseal-plan-capability", { request: envelope.request, plan });
        }
        mutation = childInvocation({ kind: "publish-reseal", capability: planCapability }, caller);
      }
    } else {
      mutation = childInvocation({ kind: "mutate", capability: signedCapability("mutation-capability", { envelope, authorization, resume_prepared: resumePrepared, ...(verifiedBridge ? { verified_bridge: verifiedBridge } : {}) }) }, caller);
    }
    if (!record(mutation) || mutation.run_id !== identity.runId || typeof mutation.result_core_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(mutation.result_core_sha256)) throw new Error("unprivileged lifecycle mutation worker result is invalid");
    const completionRecord = completion(envelope, { runId: identity.runId }, "applied", mutation.result_core_sha256);
    atomicWrite(completionFile, `${JSON.stringify({ authorization_sha256: authorizationSha256, request_sha256: envelope.request_sha256, result_core_sha256: mutation.result_core_sha256, completion: completionRecord })}\n`);
    atomicWrite(nonceFile, `${JSON.stringify(appliedNonceRecord(prepared, mutation.result_core_sha256))}\n`);
    // The root process has already returned to a root-owned boundary. A second
    // unprivileged invocation installs a receipt only where that receipt is a
    // verification-gate input; archive moves the session and has no receipt path.
    if (["resolve-critique", "repair-critique-resolution-history", "reseal-verification-evidence"].includes(envelope.action)) childInvocation({ kind: "receipt", capability: signedCapability("receipt-capability", { request: envelope.request, completion: completionRecord }) }, caller);
    if (envelope.action === "reseal-verification-evidence") childInvocation({ kind: "finalize-reseal", capability: signedCapability("finalize-reseal-capability", { request: envelope.request, completion: completionRecord }) }, caller);
    return { completionRecord, replayed: false };
  });
}
function response(envelope, outcome) {
  return { schema_version: PROTOCOL_VERSION, action: envelope.action, request_sha256: envelope.request_sha256, status: "accepted", result: { run_id: outcome.completionRecord.run_id, operation_status: outcome.replayed ? "replayed" : "applied", completion: outcome.completionRecord } };
}
function installCompletionReceipt(paths, candidate) {
  const bundle = protectedJson(path.join(paths.sessionDir, "trust.bundle"), "trust bundle", 4 * 1024 * 1024);
  const ledgerFile = resolutionEventLedgerFile(paths);
  const events = fs.existsSync(ledgerFile) ? protectedJson(ledgerFile, "lifecycle authority resolution event ledger", 4 * 1024 * 1024).events : [];
  if (!Array.isArray(events)) throw new Error("lifecycle completion receipt resolution event ledger is invalid");
  const verifiedCandidate = assertCurrentLifecycleCompletionIdentity(paths, candidate);
  const currentResultCore = lifecycleAuthorityResultDigest(bundle, events);
  const receiptFile = path.join(paths.sessionDir, "lifecycle-authority.completion.json");
  if (fs.existsSync(receiptFile)) {
    const existing = protectedJson(receiptFile, "current lifecycle completion", 256 * 1024);
    try {
      // A valid different exact-current receipt is newer state and remains
      // authoritative even when the replay candidate is stale.
      const verifiedExisting = assertCurrentLifecycleCompletion(paths, existing, bundle, events);
      if (canonicalJson(verifiedExisting) !== canonicalJson(verifiedCandidate)) return { run_id: paths.runId, receipt: "preserved" };
      return { run_id: paths.runId, receipt: "present" };
    } catch (error) {
      // Committed recovery can leave an authenticated pre-operation receipt
      // beside the new bundle and ledger. It is replaceable only after the
      // root-issued candidate binds this exact current state.
      const historicalExisting = verifyHistoricalLifecycleCompletion(paths, existing);
      if (historicalExisting.result_core_sha256 === currentResultCore) throw error;
      const exactCurrentCandidate = assertCurrentLifecycleCompletion(paths, verifiedCandidate, bundle, events);
      atomicWrite(receiptFile, `${JSON.stringify(exactCurrentCandidate, null, 2)}\n`, 0o644);
      return { run_id: paths.runId, receipt: "replaced" };
    }
  }
  const exactCurrentCandidate = assertCurrentLifecycleCompletion(paths, verifiedCandidate, bundle, events);
  atomicWrite(receiptFile, `${JSON.stringify(exactCurrentCandidate, null, 2)}\n`, 0o644);
  return { run_id: paths.runId, receipt: "written" };
}
export async function main(input = fs.readFileSync(0, "utf8")) {
  if (CHILD_MODE) {
    const payload = JSON.parse(input);
    if (!record(payload) || typeof payload.kind !== "string") throw new Error("mutation worker request is invalid");
    if (payload.kind === "prepare-reseal") {
      const value = verifiedCapability(payload.capability, "prepare-reseal-capability");
      if (!record(value.envelope) || !record(value.authorization)) throw new Error("verification reseal preparation request is invalid");
      const envelope = validateEnvelope(value.envelope);
      if (envelope.action !== "reseal-verification-evidence" || value.authorization.operation !== envelope.action) throw new Error("verification reseal preparation operation is invalid");
      const paths = canonicalMutationPaths(envelope.request);
      return prepareVerificationResealTransaction(envelope, paths, value.authorization);
    }
    if (payload.kind === "preflight-reseal") {
      const value = verifiedCapability(payload.capability, "preflight-reseal-capability");
      const paths = canonicalMutationPaths(value.request);
      rejectActiveLegacyResealJournal(paths, null);
      await preflightVerificationResealFlowCapabilities();
      return { run_id: paths.runId, available: true };
    }
    if (payload.kind === "publish-reseal") {
      const value = verifiedCapability(payload.capability, "reseal-plan-capability");
      if (!record(value.request) || !record(value.plan)) throw new Error("verification reseal publication request is invalid");
      const envelope = validateEnvelope({ schema_version: PROTOCOL_VERSION, action: value.request.action, request_sha256: value.plan.request_sha256, request: value.request });
      if (envelope.action !== "reseal-verification-evidence") throw new Error("verification reseal publication operation is invalid");
      const paths = canonicalMutationPaths(value.request);
      return publishVerificationResealTransaction(paths, payload.capability, {
        request_sha256: value.plan.request_sha256,
        authorization_sha256: value.plan.authorization_sha256,
      });
    }
    if (payload.kind === "recover-reseal") {
      const value = verifiedCapability(payload.capability, "recover-reseal-capability");
      if (!record(value.request) || !record(value.binding)) throw new Error("verification reseal recovery request is invalid");
      exact(value.binding, ["request_sha256", "authorization_sha256"], "verification reseal recovery binding");
      const envelope = validateEnvelope({ schema_version: PROTOCOL_VERSION, action: value.request.action, request_sha256: value.binding.request_sha256, request: value.request });
      if (envelope.action !== "reseal-verification-evidence") throw new Error("verification reseal recovery operation is invalid");
      return recoverVerificationResealTransaction(canonicalMutationPaths(value.request), value.binding);
    }
    if (payload.kind === "finalize-reseal") {
      const value = verifiedCapability(payload.capability, "finalize-reseal-capability");
      if (!record(value.request) || !record(value.completion)) throw new Error("verification reseal finalization request is invalid");
      const paths = canonicalMutationPaths(value.request);
      return finalizeVerificationResealTransaction(paths, assertCurrentLifecycleCompletionIdentity(paths, value.completion));
    }
    if (payload.kind === "rollback") {
      const value = verifiedCapability(payload.capability, "rollback-capability");
      if (!record(value.request) || !record(value.binding)) throw new Error("mutation worker rollback request is invalid");
      exact(value.binding, ["request_sha256", "authorization_sha256"], "mutation worker rollback binding");
      const envelope = validateEnvelope({ schema_version: PROTOCOL_VERSION, action: value.request.action, request_sha256: value.binding.request_sha256, request: value.request });
      if (value.binding.request_sha256 !== sha256(envelope.request) || !/^[a-f0-9]{64}$/.test(String(value.binding.authorization_sha256))) throw new Error("mutation worker rollback binding is invalid");
      const paths = canonicalMutationPaths(value.request);
      if (value.request.action === "reseal-verification-evidence") throw new Error("verification reseal rejects legacy recursive rollback");
      const rolledBack = recoverMatchingTransaction(paths, value.binding);
      return { run_id: paths.runId, rolled_back: rolledBack };
    }
    if (payload.kind === "receipt") {
      const value = verifiedCapability(payload.capability, "receipt-capability");
      if (!record(value.request) || !record(value.completion)) throw new Error("mutation worker receipt is invalid");
      const paths = canonicalMutationPaths(value.request);
      return installCompletionReceipt(paths, value.completion);
    }
    if (payload.kind !== "mutate") throw new Error("mutation worker request is invalid");
    const value = verifiedCapability(payload.capability, "mutation-capability");
    if (!record(value.envelope) || !record(value.authorization) || typeof value.resume_prepared !== "boolean" || (value.verified_bridge !== undefined && !record(value.verified_bridge))) throw new Error("mutation worker request is invalid");
    const envelope = validateEnvelope(value.envelope);
    if (value.authorization.operation !== envelope.action || value.authorization.run_id !== path.basename(path.resolve(envelope.request.session_dir))) throw new Error("mutation worker authorization does not bind the request");
    if (value.resume_prepared && envelope.action === "archive" && !fs.existsSync(envelope.request.session_dir)) {
      const projectRoot = fs.realpathSync(envelope.request.project_root), runId = path.basename(path.resolve(envelope.request.session_dir));
      const archived = path.join(projectRoot, ".kontourai", "flow-agents", "archive", runId);
      const paths = { projectRoot, sessionDir: fs.realpathSync(archived), runId };
      const { flow } = await loadPinnedFlowReducer(); const run = await flow.loadRun(runId, projectRoot); assertAuthorizationBinding(paths, value.authorization, run);
      return { result_core_sha256: sha256({ canonical_status: run.state.status, archived_session: path.relative(projectRoot, archived) }), run_id: runId };
    }
    const paths = canonicalMutationPaths(envelope.request);
    if (value.resume_prepared && envelope.action === "cancel") { const reconciled = await reconcileCanceledFlow(paths, value.authorization); if (reconciled) return reconciled; }
    return executeMutation(envelope, paths, value.authorization, null, value.verified_bridge ?? null);
  }
  const lines = input.split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) throw new Error("coordinator requires exactly one JSON request line");
  const envelope = validateEnvelope(JSON.parse(lines[0]));
  return response(envelope, await processRootOperation(envelope));
}
if (path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url))) {
  try { process.stdout.write(`${JSON.stringify(await main())}\n`); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
