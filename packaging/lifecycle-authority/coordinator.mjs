#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import {
  assertAppendOnlyCritiqueHistory,
  coordinatorRuntimeSha256,
  critiqueHistoryProjectionSummary,
  critiqueResolutionEdgeProjectionSummary,
  critiqueResolutionHistoryBridgeDigest,
  recoverExactCurrentCompletionTransition,
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
export const VERIFICATION_RESEAL_ATOMIC_REPLACE_CAPABILITY_FILE = `${CONFIG_ROOT}/verification-reseal-atomic-replace.cjs`;
export const VERIFICATION_RESEAL_ATOMIC_REPLACE_PROTOCOL = "kontourai.atomic-expected-preimage-replace.v1";
const MAX_CANONICAL_FLOW_MANIFEST_BYTES = 16 * 1024 * 1024;
const INSTALL_ROOT = path.dirname(fileURLToPath(import.meta.url));
const FLOW_REDUCER_PIN_FILE = path.join(INSTALL_ROOT, "flow-reducer-v1.json");
const FLOW_REDUCER_PACKAGE_ROOT = path.join(INSTALL_ROOT, "flow-reducer", "node_modules", "@kontourai", "flow");
const CHILD_MODE = process.env.FLOW_AGENTS_LIFECYCLE_MUTATION_WORKER === "1";
const requireHostCapability = createRequire(import.meta.url);
const ACTION_FIELDS = {
  cancel: ["action", "project_root", "session_dir", "authorization_file"],
  archive: ["action", "project_root", "session_dir", "authorization_file"],
  "resolve-critique": ["action", "project_root", "session_dir", "authorization_file", "prior_record_id", "resolving_record_id"],
  "repair-critique-resolution-history": ["action", "project_root", "session_dir", "authorization_file", "prior_record_id", "resolving_record_id"],
  "reseal-verification-evidence": ["action", "project_root", "session_dir", "authorization_file"],
  "publish-provisional-delivery": ["action", "project_root", "session_dir", "authorization_file"],
  "recover-exact-current-completion": ["action", "project_root", "session_dir", "authorization_file"],
  "authorize-workflow-evidence": ["action", "project_root", "session_dir", "authorization_file"],
};
const PROVISIONAL_DELIVERY_AUTHORIZATION_FIELDS = [
  "schema_version", "operation", "project_root", "run_id", "subject", "work_item", "assignment_actor_key", "assignment_generation",
  "published_head_sha", "provider_record_id", "provider_observation_sha256",
  "flow_definition_id", "flow_definition_version", "flow_definition_digest", "flow_run_head", "flow_gate_id", "flow_gate_visit", "workspace_snapshot",
  "checkpoint_slug", "checkpoint_commit_sha", "checkpoint_sha256", "bundle_sha256", "attestation_sha256", "companions",
  "nonce", "expires_at", "requested_at", "signature",
];
const EXACT_CURRENT_COMPLETION_RECOVERY_AUTHORIZATION_FIELDS = [
  "schema_version", "operation", "project_root", "run_id", "subject", "permitted_transition",
  "stale_completion_sha256", "stale_completion_action", "stale_completion_request_sha256", "stale_completion_result_core_sha256", "stale_completion_coordinator_runtime_sha256",
  "current_bundle_sha256", "current_ledger_sha256", "current_ledger_length", "current_ledger_tail_hash",
  "critique_projection_sha256", "resolution_edge_projection_sha256", "resolution_edge_projection_count",
  "flow_definition_id", "flow_definition_sha256", "flow_step_id", "flow_gate_id", "flow_gate_policy_sha256", "flow_run_head", "flow_manifest_sha256",
  "nonce", "expires_at", "requested_at", "signature",
];
const HOST_WORKFLOW_AUTHORIZATION_FIELDS = [
  "schema_version", "operation", "project_root", "run_id", "subject",
  "assignment_generation", "actor_key", "actor", "binding_actor_key", "binding_id", "binding_sha256",
  "flow_run_head", "flow_manifest_sha256", "trust_bundle_sha256", "evidence_request_sha256",
  "nonce", "issued_at", "expires_at", "signature",
];
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
  "assignment_generation_sha256", "assignment_actor_key", "assignment_actor",
  "preimage_bundle_sha256", "candidate_bundle_sha256", "candidate_transaction_id",
  "preimage_ledger_sha256", "preimage_ledger_length", "preimage_ledger_tail_hash",
  "current_completion_sha256", "current_completion_request_sha256", "current_completion_result_core_sha256",
  "flow_definition_id", "flow_step_id", "flow_gate_id", "flow_run_head", "flow_manifest_sha256", "critique_projection_sha256",
  "target_expectation_id", "predecessor_claim_id", "predecessor_claim_status", "predecessor_claim_sha256", "predecessor_claim_index",
  "current_claim_id", "current_claim_status", "current_claim_sha256", "current_claim_index", "claim_delta",
  "acceptance_claim_delta_count", "acceptance_claim_delta_sha256",
  "nonce", "expires_at", "requested_at", "signature",
];
const VERIFICATION_RESEAL_AUTHORIZATION_VERSION = "2.0";

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
function provisionalWorkspaceSnapshot(projectRoot, runId) {
  const excluded = `delivery/${runId}`;
  const git = (args, encoding = "utf8") => {
    const result = spawnSync("git", args, { cwd: projectRoot, encoding, maxBuffer: 32 * 1024 * 1024 });
    if (result.status !== 0) throw new Error("provisional delivery could not inspect the signed Git workspace");
    return result.stdout;
  };
  const root = String(git(["rev-parse", "--show-toplevel"])).trim();
  if (fs.realpathSync(root) !== projectRoot) throw new Error("provisional delivery project root is not the Git worktree root");
  const head = String(git(["rev-parse", "HEAD"])).trim();
  const tracked = git(["diff", "--binary", "--no-ext-diff", "HEAD", "--", ".", `:(exclude)${excluded}/**`], null);
  const untracked = Buffer.from(git(["ls-files", "--others", "--exclude-standard", "-z"], null))
    .toString("utf8").split("\0").filter(Boolean)
    .filter((file) => file !== excluded && !file.startsWith(`${excluded}/`)).sort();
  const hash = crypto.createHash("sha256");
  hash.update("flow-agents:git-worktree:v1\0").update(head).update("\0");
  hash.update("exclude\0").update(excluded).update("\0");
  hash.update(tracked).update("\0");
  for (const file of untracked) {
    const absolute = path.resolve(projectRoot, file);
    if (!within(absolute, projectRoot)) throw new Error("provisional delivery untracked file escapes the project root");
    const descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile()) throw new Error("provisional delivery untracked entry is not a regular file");
      hash.update(file).update("\0").update(fs.readFileSync(descriptor)).update("\0");
    } finally { fs.closeSync(descriptor); }
  }
  return { version: 1, kind: "git-worktree", algorithm: "sha256", digest: hash.digest("hex"), head_sha: head };
}
function protectedRegularFile(file, label, maxBytes = 64 * 1024) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxBytes || (stat.mode & 0o022) !== 0) throw new Error(`${label} must be a protected regular file`);
    return fs.readFileSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}
const ABSENT_HOST_EVIDENCE_TRUST_BUNDLE_SHA256 = sha256("kontourai.host-workflow.absent-trust-bundle.v1");
function hostEvidenceTrustBundleSha256(file) {
  try {
    return sha256(protectedRegularFile(file, "trust bundle", 4 * 1024 * 1024));
  } catch (error) {
    if (error?.code === "ENOENT") return ABSENT_HOST_EVIDENCE_TRUST_BUNDLE_SHA256;
    throw error;
  }
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
  const payload = authorization.operation === "authorize-workflow-evidence" ? canonicalJson(unsigned) : JSON.stringify(unsigned);
  if (signature.algorithm !== "ed25519" || typeof signature.value !== "string" || !crypto.verify(null, Buffer.from(payload), crypto.createPublicKey(key.public_key_pem), Buffer.from(signature.value, "base64"))) throw new Error("authorization signature is invalid");
  if (projectRoot !== null && authorization.project_root !== projectRoot) throw new Error("authorization does not bind the canonical project root");
  if (requireCurrentExpiry && (typeof authorization.expires_at !== "string" || !Number.isFinite(Date.parse(authorization.expires_at)) || Date.now() > Date.parse(authorization.expires_at))) throw new Error("authorization is expired");
  return authorization;
}
function assertExactCurrentRecoveryTimeWindow(authorization, { allowExpiredReplay = false } = {}) {
  const requestedAt = Date.parse(String(authorization.requested_at));
  const expiresAt = Date.parse(String(authorization.expires_at));
  const now = Date.now();
  if (!Number.isFinite(requestedAt) || !Number.isFinite(expiresAt) || expiresAt < requestedAt
      || requestedAt > now + 5 * 60_000 || expiresAt - requestedAt > 8760 * 3_600_000
      || (!allowExpiredReplay && now > expiresAt)) {
    throw new Error("exact-current completion recovery authorization time window is invalid");
  }
}
function assertPrivilegedAuthorizationShape(authorization) {
  const fields = authorization.operation === "repair-critique-resolution-history"
    ? HISTORY_REPAIR_AUTHORIZATION_FIELDS
    : authorization.operation === "reseal-verification-evidence"
      ? VERIFICATION_RESEAL_AUTHORIZATION_FIELDS
      : authorization.operation === "publish-provisional-delivery"
        ? PROVISIONAL_DELIVERY_AUTHORIZATION_FIELDS
      : authorization.operation === "recover-exact-current-completion"
        ? EXACT_CURRENT_COMPLETION_RECOVERY_AUTHORIZATION_FIELDS
      : authorization.operation === "authorize-workflow-evidence"
        ? HOST_WORKFLOW_AUTHORIZATION_FIELDS
      : null;
  if (!fields) return authorization;
  if (authorization.operation === "reseal-verification-evidence"
      && authorization.schema_version !== VERIFICATION_RESEAL_AUTHORIZATION_VERSION) {
    throw new Error("verification evidence reseal authorization schema is obsolete or unsupported; regenerate it with workflow reseal-verification-evidence-request");
  }
  exact(authorization, fields, `privileged ${authorization.operation} authorization`);
  exact(authorization.signature, ["algorithm", "key_id", "value"], `privileged ${authorization.operation} authorization signature`);
  if (authorization.operation !== "recover-exact-current-completion") {
    const issuedAt = Date.parse(
      authorization.operation === "authorize-workflow-evidence"
        ? authorization.issued_at
        : authorization.requested_at,
    );
    const expiresAt = Date.parse(authorization.expires_at);
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
        || expiresAt < issuedAt || issuedAt > Date.now() + 5 * 60_000) {
      throw new Error(`privileged ${authorization.operation} authorization time window is invalid`);
    }
  }
  if (authorization.operation === "authorize-workflow-evidence") {
    exact(authorization.actor, ["runtime", "session_id", "host", "human"], "host workflow authorization actor");
    for (const field of ["assignment_generation", "binding_sha256", "flow_run_head", "flow_manifest_sha256", "trust_bundle_sha256", "evidence_request_sha256"]) {
      if (!/^[a-f0-9]{64}$/.test(String(authorization[field]))) throw new Error(`host workflow authorization ${field} is invalid`);
    }
    for (const field of ["actor_key", "binding_actor_key", "binding_id", "nonce"]) {
      if (typeof authorization[field] !== "string" || !authorization[field]) throw new Error(`host workflow authorization ${field} is invalid`);
    }
  }
  return authorization;
}
export function validateProvisionalDeliveryAuthorizationBinding(authorization, expected) {
  exact(authorization, PROVISIONAL_DELIVERY_AUTHORIZATION_FIELDS, "privileged publish-provisional-delivery authorization");
  exact(authorization.signature, ["algorithm", "key_id", "value"], "provisional delivery authorization signature");
  if (authorization.schema_version !== PROTOCOL_VERSION || authorization.operation !== "publish-provisional-delivery") throw new Error("provisional delivery authorization identity is invalid");
  for (const field of ["project_root", "run_id", "subject", "work_item", "assignment_actor_key", "assignment_generation", "provider_record_id", "flow_definition_id", "flow_definition_version", "flow_gate_id", "flow_gate_visit", "checkpoint_slug"]) {
    if (typeof authorization[field] !== "string" || !authorization[field]) throw new Error(`provisional delivery authorization ${field} is invalid`);
    if (expected[field] !== undefined && authorization[field] !== expected[field]) throw new Error(`provisional delivery authorization ${field} does not match the current session`);
  }
  for (const field of ["flow_definition_digest", "flow_run_head", "published_head_sha", "checkpoint_commit_sha", "provider_observation_sha256", "checkpoint_sha256", "bundle_sha256", "attestation_sha256"]) {
    const pattern = field === "checkpoint_commit_sha" || field === "published_head_sha" ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/;
    if (!pattern.test(String(authorization[field]))) throw new Error(`provisional delivery authorization ${field} is invalid`);
    if (expected[field] !== undefined && authorization[field] !== expected[field]) throw new Error(`provisional delivery authorization ${field} does not match the current session`);
  }
  if (!record(authorization.workspace_snapshot) || (expected.workspace_snapshot !== undefined && canonicalJson(authorization.workspace_snapshot) !== canonicalJson(expected.workspace_snapshot))) throw new Error("provisional delivery authorization workspace snapshot does not match the current session");
  if (!Array.isArray(authorization.companions) || (expected.companions !== undefined && canonicalJson(authorization.companions) !== canonicalJson(expected.companions))) throw new Error("provisional delivery authorization companions do not match the current session");
  if (authorization.subject !== authorization.work_item || authorization.checkpoint_slug !== authorization.run_id || authorization.flow_definition_id !== "builder.build") throw new Error("provisional delivery authorization cross-binding is invalid");
  const requested = Date.parse(authorization.requested_at), expires = Date.parse(authorization.expires_at);
  if (!Number.isFinite(requested) || !Number.isFinite(expires) || expires < requested || Date.now() > expires) throw new Error("provisional delivery authorization time window is invalid");
  return authorization;
}
function loadProvisionalDeliveryLedger(paths) {
  const file = path.join(paths.sessionDir, "lifecycle-authority.provisional-delivery-events.json");
  if (!fs.existsSync(file)) return { file, bytes: null, value: { schema_version: PROTOCOL_VERSION, events: [] } };
  const bytes = protectedRegularFile(file, "provisional delivery authority ledger", 4 * 1024 * 1024);
  const value = JSON.parse(bytes.toString("utf8"));
  exact(value, ["schema_version", "events"], "provisional delivery authority ledger");
  if (value.schema_version !== PROTOCOL_VERSION || !Array.isArray(value.events)) throw new Error("provisional delivery authority ledger is invalid");
  let predecessor = "0".repeat(64);
  let subject = null;
  for (const event of value.events) {
    exact(event, ["schema_version", "kind", "run_id", "subject", "authorization_sha256", "predecessor_hash", "signed_authorization", "event_hash"], "provisional delivery authority event");
    if (event.schema_version !== PROTOCOL_VERSION || event.kind !== "kontourai.lifecycle-authority.provisional-delivery-event"
      || event.run_id !== paths.runId || typeof event.subject !== "string" || !event.subject
      || (subject !== null && event.subject !== subject) || event.predecessor_hash !== predecessor
      || event.authorization_sha256 !== sha256(canonicalJson(event.signed_authorization))) {
      throw new Error("provisional delivery authority event binding is invalid");
    }
    const { event_hash, ...unsigned } = event;
    if (event_hash !== sha256(unsigned)) throw new Error("provisional delivery authority event hash chain is invalid");
    const verified = assertPrivilegedAuthorizationShape(verifySignedAuthorization(event.signed_authorization, { projectRoot: paths.projectRoot, requireCurrentExpiry: false }));
    if (verified.operation !== "publish-provisional-delivery" || verified.run_id !== paths.runId || verified.subject !== event.subject) {
      throw new Error("provisional delivery authority event signature binding is invalid");
    }
    subject = event.subject;
    predecessor = event_hash;
  }
  return { file, bytes, value };
}
function verifyAuthorization(file, options = {}) {
  return assertPrivilegedAuthorizationShape(verifySignedAuthorization(JSON.parse(protectedRegularFile(file, "authorization file").toString("utf8")), options));
}
function atomicWrite(file, bytes, mode = 0o600, hooks = null) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, bytes, { mode, flag: "wx" });
  const temporaryDescriptor = fs.openSync(temporary, fs.constants.O_RDONLY);
  try { fs.fsyncSync(temporaryDescriptor); } finally { fs.closeSync(temporaryDescriptor); }
  hooks?.beforeRename?.(temporary, file);
  fs.renameSync(temporary, file);
  const descriptor = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  hooks?.afterRename?.(file);
}
function transactionJournal(paths) { return path.join(paths.sessionDir, ".lifecycle-authority.transaction.json"); }
const FLOW_MUTATION_LOCK_PATH = ".mutation.lock";
const FLOW_MUTATION_PENDING_PATH_PREFIX = `.${FLOW_MUTATION_LOCK_PATH}.pending-`;
const FLOW_MUTATION_TICKET_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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
const FLOW_RECOVERY_GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GENERATION_BOUND_ACTIONS = new Set(["reseal-verification-evidence", "recover-exact-current-completion"]);
export const EXACT_CURRENT_RECOVERY_PUBLICATION_PROTOCOL = "flow-agents.exact-current-recovery-publication.v1";
export const EXACT_CURRENT_RECOVERY_ARTIFACT_IDS = Object.freeze([
  "flow-manifest",
  "flow-attachment",
  "flow-report-json",
  "flow-report-markdown",
]);
const EXACT_CURRENT_RECOVERY_PLAN_FILE = ".exact-current-recovery.transaction.json";
const FLOW_RECOVERY_FENCE_FILE = "recovery-fence.json";
const FLOW_RECOVERY_FENCE_PROTOCOL = "flow.run-recovery-fence.v1";
function flowMutationPendingPathName(name) {
  return name.startsWith(FLOW_MUTATION_PENDING_PATH_PREFIX)
    && FLOW_MUTATION_TICKET_TOKEN.test(name.slice(FLOW_MUTATION_PENDING_PATH_PREFIX.length));
}
function transactionPathIsExcluded(relative, excludedPaths) {
  const first = relative.split("/")[0];
  if (excludedPaths.includes(FLOW_MUTATION_LOCK_PATH)
      && (first === FLOW_MUTATION_LOCK_PATH || flowMutationPendingPathName(first))) return true;
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
  if ((firstIdentity === FLOW_MUTATION_LOCK_PATH && segments[0] !== FLOW_MUTATION_LOCK_PATH)
      || (flowMutationPendingPathName(firstIdentity) && !flowMutationPendingPathName(segments[0]))) {
    throw new Error(`${label} aliases the protected Flow mutation namespace`);
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
export async function recoverMatchingTransactionWithCanonicalFlowLock(paths, expectedBinding, injectedLock = null) {
  return withCanonicalFlowRunMutationLock(
    paths,
    () => recoverMatchingTransaction(paths, expectedBinding),
    injectedLock,
  );
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
export async function inCanonicalFlowProjectTransaction(paths, binding, action, injectedLock = null) {
  return withCanonicalFlowRunMutationLock(
    paths,
    () => inProjectTransaction(paths, binding, action),
    injectedLock,
  );
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
  validateResolutionEventLedger(ledger.events, { run_id: authorization.run_id, subject: authorization.subject, project_root: paths.projectRoot, bundle, strict_coverage: action === "resolve-critique" || action === "recover-exact-current-completion" });
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
  const generationBound = GENERATION_BOUND_ACTIONS.has(completion?.action);
  const fields = ["schema_version", "kind", "action", "request_sha256", "run_id", "operation_status", "result_core_sha256", "coordinator_runtime_sha256", "completed_at", ...(generationBound ? ["recovery_generation"] : []), "signature"];
  exact(completion, fields, label);
  if (completion.schema_version !== PROTOCOL_VERSION || completion.kind !== "kontourai.lifecycle-authority.completion" || !["resolve-critique", "repair-critique-resolution-history", "reseal-verification-evidence", "recover-exact-current-completion", "publish-provisional-delivery"].includes(completion.action) || completion.run_id !== paths.runId || !operationStatuses.includes(completion.operation_status) || typeof completion.request_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(completion.request_sha256)) throw new Error(`${label} identity is invalid`);
  for (const key of ["result_core_sha256", "coordinator_runtime_sha256"]) if (typeof completion[key] !== "string" || !/^[a-f0-9]{64}$/.test(completion[key])) throw new Error(`${label} ${key} is invalid`);
  if (generationBound && !FLOW_RECOVERY_GENERATION.test(String(completion.recovery_generation))) throw new Error(`${label} recovery_generation is invalid`);
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
async function assertExactCurrentCompletionRecoveryPreimages(paths, authorization, envelope, expected = null, verifyFlow = true) {
  const bundleFile = path.join(paths.sessionDir, "trust.bundle");
  const bundleBytes = protectedRegularFile(bundleFile, "trust bundle", 4 * 1024 * 1024);
  const bundle = JSON.parse(bundleBytes.toString("utf8"));
  const ledger = loadResolutionEventLedger(paths, bundle, authorization, envelope.action);
  const completionBytes = protectedRegularFile(path.join(paths.sessionDir, "lifecycle-authority.completion.json"), "stale lifecycle completion", 256 * 1024);
  const stale = assertLifecycleCompletionIdentity(paths, JSON.parse(completionBytes.toString("utf8")), ["applied"], "stale lifecycle completion");
  if (stale.result_core_sha256 === lifecycleAuthorityResultDigest(bundle, ledger.events)) throw new Error("exact-current completion recovery requires a stale completion");
  if (sha256(completionBytes) !== authorization.stale_completion_sha256
      || stale.action !== authorization.stale_completion_action
      || stale.request_sha256 !== authorization.stale_completion_request_sha256
      || stale.result_core_sha256 !== authorization.stale_completion_result_core_sha256
      || stale.coordinator_runtime_sha256 !== authorization.stale_completion_coordinator_runtime_sha256) {
    throw new Error("exact-current completion recovery authorization does not bind the authenticated stale completion");
  }
  if (!verifyFlow) {
    if (expected && (!bundleBytes.equals(expected.bundleBytes) || !ledger.bytes.equals(expected.ledger.bytes) || !completionBytes.equals(expected.completionBytes))) {
      throw new Error("exact-current completion recovery protected preimage changed during publication");
    }
    return { bundleFile, bundleBytes, bundle, ledger, completionBytes, stale };
  }
  const files = canonicalFlowPaths(paths);
  const manifestBytes = protectedRegularFile(files.manifest, "canonical Flow evidence manifest", MAX_CANONICAL_FLOW_MANIFEST_BYTES);
  const state = protectedJson(files.state, "canonical Flow state", 4 * 1024 * 1024);
  const definition = protectedJson(files.definition, "canonical Flow definition", 4 * 1024 * 1024);
  const gatePolicy = currentGatePolicy(definition, state);
  const { flow } = await loadPinnedFlowReducer();
  const preimage = { run_head: flow.flowRunHead(state), manifest_sha256: sha256(manifestBytes) };
  const definitionSha256 = sha256(protectedRegularFile(files.definition, "canonical Flow definition", 4 * 1024 * 1024));
  const gatePolicySha256 = flowGatePolicyDigest(gatePolicy);
  if (authorization.permitted_transition !== "exact-current-completion-only"
      || authorization.subject !== sessionSubject(paths) || authorization.subject !== state.subject
      || definition.id !== authorization.flow_definition_id || state.current_step !== authorization.flow_step_id
      || (state.definition_digest !== undefined && state.definition_digest !== flow.definitionDigest(definition))
      || definitionSha256 !== authorization.flow_definition_sha256 || gatePolicySha256 !== authorization.flow_gate_policy_sha256
      || gatePolicy.gate_id !== authorization.flow_gate_id || preimage.run_head !== authorization.flow_run_head
      || preimage.manifest_sha256 !== authorization.flow_manifest_sha256) {
    throw new Error("exact-current completion recovery canonical Flow preimage no longer matches the signed authorization");
  }
  const reduced = recoverExactCurrentCompletionTransition({
    bundle, resolution_events: ledger.events, authorization, bundle_bytes: bundleBytes, ledger_bytes: ledger.bytes,
    flow: { definition_id: definition.id, definition_sha256: definitionSha256, step_id: state.current_step, gate_policy_sha256: gatePolicySha256, ...gatePolicy },
  });
  if (expected && (!bundleBytes.equals(expected.bundleBytes) || !ledger.bytes.equals(expected.ledger.bytes) || !completionBytes.equals(expected.completionBytes))) {
    throw new Error("exact-current completion recovery protected preimage changed during publication");
  }
  return { bundleFile, bundleBytes, bundle, ledger, completionBytes, stale, files, preimage, reduced };
}
function sha256File(file, label) { return sha256(protectedRegularFile(file, label, 16 * 1024 * 1024)); }
function exactObject(value, expected, label) {
  if (canonicalJson(value) !== canonicalJson(expected)) throw new Error(`${label} does not match the pinned Flow reducer identity`);
}
async function loadPinnedFlowReducer() {
  const pin = protectedJson(FLOW_REDUCER_PIN_FILE, "Flow reducer pin", 16 * 1024);
  exact(pin, ["package", "package_version", "release_commit", "closure_sha256", "reducer"], "Flow reducer pin");
  if (pin.package !== "@kontourai/flow" || pin.package_version !== "3.12.0" || pin.release_commit !== "b1483cf" || typeof pin.closure_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(pin.closure_sha256) || !record(pin.reducer)) throw new Error("Flow reducer pin is invalid");
  const packageJson = protectedJson(path.join(FLOW_REDUCER_PACKAGE_ROOT, "package.json"), "pinned Flow package metadata", 64 * 1024);
  if (packageJson.name !== pin.package || packageJson.version !== pin.package_version) throw new Error("installed Flow package does not match the pinned reducer package identity");
  const entry = path.join(FLOW_REDUCER_PACKAGE_ROOT, "dist", "index.js");
  protectedRegularFile(entry, "pinned Flow reducer artifact", 8 * 1024 * 1024);
  const flow = await import(pathToFileURL(entry).href);
  for (const name of ["reduceTrustAttachment", "trustAttachmentReducerIdentity", "definitionDigest", "flowRunHead", "FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES", "withRunMutationLock", "withRunRecoveryLock", "writeRunRecoveryFence", "finalizeRunRecoveryFence"]) {
    if (typeof flow[name] !== "function" && !record(flow[name])) throw new Error(`pinned Flow reducer artifact does not export ${name}`);
  }
  if (flow.FLOW_RUN_RECOVERY_FINALIZE_BEFORE_OPEN !== "flow.run-recovery.finalize-before-open.v1") {
    throw new Error("pinned Flow reducer artifact does not support atomic recovery pre-open assertions");
  }
  const identity = flow.trustAttachmentReducerIdentity(flow.FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES);
  exactObject(identity, pin.reducer, "installed Flow reducer");
  return {
    flow,
    withRunMutationLock: flow.withRunMutationLock,
    withRunRecoveryLock: flow.withRunRecoveryLock,
    writeRunRecoveryFence: flow.writeRunRecoveryFence,
    finalizeRunRecoveryFence: flow.finalizeRunRecoveryFence,
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
  loadVerificationResealAtomicReplaceCapability();
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
function exactCurrentRecoveryPlanFile(paths) {
  return path.join(paths.sessionDir, EXACT_CURRENT_RECOVERY_PLAN_FILE);
}
export function exactCurrentRecoveryArtifactFiles(paths, requestSha256, authorizationSha256) {
  if (!/^[a-f0-9]{64}$/.test(String(requestSha256))) throw new Error("exact-current recovery request identity is invalid");
  if (!/^[a-f0-9]{64}$/.test(String(authorizationSha256))) throw new Error("exact-current recovery authorization identity is invalid");
  const files = canonicalFlowPaths(paths);
  return new Map([
    ["flow-manifest", files.manifest],
    ["flow-attachment", path.join(files.root, "evidence", `lifecycle-authority:${requestSha256}:${authorizationSha256}.json`)],
    ["flow-report-json", files.reportJson],
    ["flow-report-markdown", files.reportMarkdown],
  ]);
}
function exactCurrentRecoveryStageFile(file, image) {
  if (!["old", "new"].includes(image)) throw new Error("exact-current recovery stage image is invalid");
  return `${file}.exact-current-recovery-${image}`;
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
function directoryDescriptor(file, label) {
  const directory = path.dirname(file);
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const stat = fs.fstatSync(descriptor);
  const named = fs.lstatSync(directory);
  if (!stat.isDirectory() || named.isSymbolicLink() || !named.isDirectory()
      || stat.dev !== named.dev || stat.ino !== named.ino) {
    fs.closeSync(descriptor);
    throw new Error(`${label} parent directory is not a stable real directory`);
  }
  return { descriptor, identity: { dev: stat.dev, ino: stat.ino } };
}
export function assertVerificationResealAtomicReplaceCapabilityArtifact() {
  try {
    protectedRegularFile(
      VERIFICATION_RESEAL_ATOMIC_REPLACE_CAPABILITY_FILE,
      "verification reseal atomic replacement capability",
      256 * 1024,
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("verification reseal requires an administrator-injected atomic expected-preimage replacement capability; no artifacts were mutated");
    }
    throw error;
  }
  const stat = fs.lstatSync(VERIFICATION_RESEAL_ATOMIC_REPLACE_CAPABILITY_FILE);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
    throw new Error("verification reseal atomic replacement capability is not a protected administrator-owned artifact; no artifacts were mutated");
  }
  return true;
}
export function loadVerificationResealAtomicReplaceCapability() {
  assertVerificationResealAtomicReplaceCapabilityArtifact();
  const capability = requireHostCapability(VERIFICATION_RESEAL_ATOMIC_REPLACE_CAPABILITY_FILE);
  if (!record(capability)
      || capability.protocol !== VERIFICATION_RESEAL_ATOMIC_REPLACE_PROTOCOL
      || typeof capability.atomicReplaceExpectedPreimage !== "function") {
    throw new Error("verification reseal atomic replacement capability is invalid; no artifacts were mutated");
  }
  return capability;
}
function assertAtomicReplacementResult(result, artifact) {
  if (!record(result)
      || result.protocol !== VERIFICATION_RESEAL_ATOMIC_REPLACE_PROTOCOL
      || result.status !== "replaced"
      || canonicalJson(result.preimage) !== canonicalJson(artifact.pre)
      || canonicalJson(result.postimage) !== canonicalJson(artifact.post)) {
    throw new Error(`verification reseal atomic replacement capability returned an invalid result for ${artifact.id}`);
  }
}
export function replaceVerificationResealArtifactCAS(
  file,
  artifact,
  bytes,
  capability = loadVerificationResealAtomicReplaceCapability(),
) {
  if (!record(capability)
      || capability.protocol !== VERIFICATION_RESEAL_ATOMIC_REPLACE_PROTOCOL
      || typeof capability.atomicReplaceExpectedPreimage !== "function") {
    throw new Error("verification reseal atomic replacement capability is invalid; no artifacts were mutated");
  }
  const opened = directoryDescriptor(file, "verification reseal artifact");
  try {
    if (opened.identity.dev !== artifact.parent.dev || opened.identity.ino !== artifact.parent.ino) {
      throw new Error("verification reseal artifact parent directory changed");
    }
    const name = path.basename(file);
    const result = capability.atomicReplaceExpectedPreimage({
      protocol: VERIFICATION_RESEAL_ATOMIC_REPLACE_PROTOCOL,
      parent_descriptor: opened.descriptor,
      parent: artifact.parent,
      target_name: name,
      preimage: artifact.pre,
      postimage: artifact.post,
      postimage_bytes_base64: artifact.post.presence === "present" ? bytes.toString("base64") : null,
    });
    assertAtomicReplacementResult(result, artifact);
    const currentParent = directoryDescriptor(file, `verification reseal artifact ${artifact.id}`);
    try {
      if (currentParent.identity.dev !== opened.identity.dev || currentParent.identity.ino !== opened.identity.ino) {
        throw new Error("verification reseal artifact parent directory changed during atomic replacement");
      }
    } finally { fs.closeSync(currentParent.descriptor); }
    const installed = readVerificationResealArtifact(file, `verification reseal artifact ${artifact.id}`).descriptor;
    if (canonicalJson(installed) !== canonicalJson(artifact.post)) {
      throw new Error(`verification reseal atomic replacement capability installed an invalid postimage for ${artifact.id}`);
    }
    fs.fsyncSync(opened.descriptor);
  } finally { fs.closeSync(opened.descriptor); }
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
    "authorization_key_id", "authorization_nonce", "authorization", "assignment", "reducer", "result_core_sha256", "artifacts",
  ], "verification reseal transaction plan");
  if (plan.schema_version !== PROTOCOL_VERSION || plan.kind !== VERIFICATION_RESEAL_TRANSACTION_PROTOCOL
      || !/^[a-f0-9]{64}$/.test(String(plan.recovery_id)) || typeof plan.run_id !== "string" || !plan.run_id
      || !/^[a-f0-9]{64}$/.test(String(plan.request_sha256))
      || !/^[a-f0-9]{64}$/.test(String(plan.authorization_sha256))
      || typeof plan.authorization_key_id !== "string" || !plan.authorization_key_id
      || typeof plan.authorization_nonce !== "string" || !plan.authorization_nonce
      || !record(plan.authorization)
      || !record(plan.assignment)
      || !record(plan.reducer) || !/^[a-f0-9]{64}$/.test(String(plan.result_core_sha256))
      || !Array.isArray(plan.artifacts) || plan.artifacts.length !== VERIFICATION_RESEAL_ARTIFACT_IDS.length) {
    throw new Error("verification reseal transaction plan identity is invalid");
  }
  exact(plan.assignment, ["generation_sha256", "actor_key", "actor"], "verification reseal transaction assignment");
  if (!/^[a-f0-9]{64}$/.test(String(plan.assignment.generation_sha256))
      || typeof plan.assignment.actor_key !== "string" || !plan.assignment.actor_key
      || !record(plan.assignment.actor)) throw new Error("verification reseal transaction assignment is invalid");
  if (sha256(canonicalJson(plan.authorization)) !== plan.authorization_sha256
      || plan.authorization.signature?.key_id !== plan.authorization_key_id
      || plan.authorization.nonce !== plan.authorization_nonce
      || plan.authorization.assignment_generation_sha256 !== plan.assignment.generation_sha256
      || plan.authorization.assignment_actor_key !== plan.assignment.actor_key
      || !assignmentActorsMatch(plan.authorization.assignment_actor, plan.assignment.actor)) {
    throw new Error("verification reseal transaction authorization binding is invalid");
  }
  const ids = plan.artifacts.map((artifact) => artifact?.id);
  if (canonicalJson(ids) !== canonicalJson(VERIFICATION_RESEAL_ARTIFACT_IDS)) {
    throw new Error("verification reseal transaction plan must enumerate exactly the fixed six artifact ids");
  }
  for (const artifact of plan.artifacts) {
    exact(artifact, ["id", "parent", "pre", "post"], `verification reseal artifact ${artifact?.id}`);
    exact(artifact.parent, ["dev", "ino"], `verification reseal artifact ${artifact?.id} parent`);
    if (!Number.isSafeInteger(artifact.parent.dev) || artifact.parent.dev < 0
        || !Number.isSafeInteger(artifact.parent.ino) || artifact.parent.ino <= 0) throw new Error(`verification reseal artifact ${artifact.id} parent identity is invalid`);
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
  exact(fence, [
    "protocol", "run_id", "recovery_id", "status", "updated_at", "generation",
    ...(fence.status === "open" && Object.prototype.hasOwnProperty.call(fence, "previous_generation") ? ["previous_generation"] : []),
  ], "Flow recovery fence");
  if (fence.protocol !== FLOW_RECOVERY_FENCE_PROTOCOL || fence.run_id !== paths.runId
      || !/^[a-f0-9]{64}$/.test(String(fence.recovery_id))
      || !FLOW_RECOVERY_GENERATION.test(String(fence.generation))
      || (fence.previous_generation !== undefined
        && !FLOW_RECOVERY_GENERATION.test(String(fence.previous_generation)))
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
async function finalizeVerificationResealFence(paths, recoveryId, expectedGeneration, beforeOpen = undefined) {
  if (!/^[a-f0-9]{64}$/.test(String(recoveryId))
      || !FLOW_RECOVERY_GENERATION.test(String(expectedGeneration))) {
    throw new Error("Flow recovery fence finalization is invalid");
  }
  const { finalizeRunRecoveryFence } = await loadPinnedFlowReducer();
  if (typeof finalizeRunRecoveryFence !== "function") throw new Error("canonical Flow recovery fence finalizer is unavailable");
  await finalizeRunRecoveryFence(paths.runId, {
    recovery_id: recoveryId,
    expected_generation: expectedGeneration,
    updated_at: new Date().toISOString(),
  }, paths.projectRoot, { beforeOpen });
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
function stageExactCurrentRecoveryImage(file, bytes, mode, image) {
  const stage = exactCurrentRecoveryStageFile(file, image);
  if (bytes === null) {
    if (fs.existsSync(stage)) fs.unlinkSync(stage);
    return;
  }
  atomicWrite(stage, bytes, mode);
  const reread = readVerificationResealArtifact(stage, `exact-current recovery ${image} stage`);
  if (!reread.bytes?.equals(bytes) || reread.descriptor.mode !== mode) throw new Error(`exact-current recovery ${image} stage reread changed`);
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
function flowGatePolicyDigest(policy) {
  return sha256(canonicalJson({ gate_id: policy.gate_id, requirements: policy.requirements }));
}
async function prepareCanonicalFlowSynchronization(paths, bundle, envelope, expectedPreimage = null, attachmentGeneration = null, evaluationMode = "evaluate") {
  if (!["evaluate", "attach-only"].includes(evaluationMode)) throw new Error("canonical Flow synchronization evaluation mode is invalid");
  const { flow, pin, artifact_sha256 } = await loadPinnedFlowReducer();
  const files = canonicalFlowPaths(paths);
  const definitionBytes = protectedRegularFile(files.definition, "canonical Flow definition", 4 * 1024 * 1024);
  const statePreimage = readVerificationResealArtifact(files.state, "canonical Flow state");
  if (statePreimage.bytes === null) throw new Error("canonical Flow state is missing");
  const stateBytes = statePreimage.bytes;
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
  if (attachmentGeneration !== null && !/^[a-f0-9]{64}$/.test(String(attachmentGeneration))) {
    throw new Error("canonical Flow attachment generation is invalid");
  }
  const attachmentId = `lifecycle-authority:${envelope.request_sha256}${attachmentGeneration === null ? "" : `:${attachmentGeneration}`}`;
  const supersede = (Array.isArray(manifest.evidence) ? manifest.evidence : [])
    .filter((entry) => record(entry) && entry.gate_id === gateId && entry.kind === "trust.bundle" && typeof entry.superseded_by !== "string")
    .map((entry) => entry.id);
  const attachedAt = new Date().toISOString();
  const storedPath = `evidence/${attachmentId}.json`;
  const bundleBytes = Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`);
  const reduced = flow.reduceTrustAttachment({
    run: { definition, state, manifest }, bundle,
    attachment: { id: attachmentId, gate_id: gateId, attached_at: attachedAt, original_path: path.relative(paths.projectRoot, path.join(paths.sessionDir, "trust.bundle")), stored_path: storedPath, sha256: sha256(bundleBytes), ...(supersede.length ? { supersede } : {}) },
    evaluation_mode: evaluationMode,
    now: attachedAt, dependencies: flow.FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES
  });
  exactObject(reduced.identity, pin.reducer, "Flow reducer result");
  if (reduced.evaluation_mode !== evaluationMode) throw new Error("Flow reducer result evaluation mode does not match the requested synchronization mode");
  const writesState = reduced.write?.artifacts?.some((artifact) => artifact?.path === "state.json") === true;
  if (evaluationMode === "attach-only") {
    exactObject(reduced.next_state, state, "attach-only Flow state");
    if (reduced.evaluation !== null || writesState) throw new Error("attach-only Flow synchronization attempted to evaluate or write canonical state");
  } else if (!record(reduced.evaluation) || !writesState) {
    throw new Error("evaluating Flow synchronization omitted evaluation or canonical state");
  }
  const evidenceFile = path.join(files.root, storedPath);
  if (!fs.readFileSync(files.definition).equals(definitionBytes) || !fs.readFileSync(files.state).equals(stateBytes) || !fs.readFileSync(files.manifest).equals(manifestBytes)) throw new Error("canonical Flow preimage changed during lifecycle trust synchronization");
  const postimages = [{ file: evidenceFile, bytes: bundleBytes, label: "canonical Flow stored trust bundle", max_bytes: 4 * 1024 * 1024 }];
  for (const artifact of reduced.write.artifacts) {
    const destination = path.join(files.root, artifact.path);
    const bytes = Buffer.from(typeof artifact.value === "string" ? artifact.value : `${JSON.stringify(artifact.value, null, 2)}\n`);
    postimages.push({ file: destination, bytes, label: artifact.path === "evidence/manifest.json" ? "canonical Flow evidence manifest" : "canonical Flow reducer artifact", max_bytes: artifact.path === "evidence/manifest.json" ? MAX_CANONICAL_FLOW_MANIFEST_BYTES : 16 * 1024 * 1024 });
  }
  return {
    reducer: { ...reduced.identity, artifact_sha256 },
    attachment_id: attachmentId,
    flow_preimage: flowPreimage,
    flow_state_preimage: statePreimage.descriptor,
    postimages,
  };
}
async function synchronizeCanonicalFlow(paths, bundle, envelope, expectedPreimage = null) {
  const prepared = await prepareCanonicalFlowSynchronization(paths, bundle, envelope, expectedPreimage, null, "attach-only");
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
function assignmentLockDir(paths) {
  const segment = String(paths.runId).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64) || "unknown";
  return path.join(paths.projectRoot, ".kontourai", "flow-agents", "assignment", `.${segment}.lockdir`);
}
function assignmentLockOwner(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return record(value) && typeof value.token === "string" ? value : null;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}
async function acquireCoordinatorAssignmentLock(paths) {
  const lockDir = assignmentLockDir(paths);
  fs.mkdirSync(path.dirname(lockDir), { recursive: true, mode: 0o700 });
  const ownerFile = path.join(lockDir, "owner.json");
  const token = crypto.randomBytes(16).toString("hex");
  const deadline = Date.now() + 30_000;
  while (true) {
    let created = false;
    try {
      fs.mkdirSync(lockDir); created = true;
      fs.writeFileSync(ownerFile, `${JSON.stringify({ token, pid: process.pid, acquired_at: new Date().toISOString() })}\n`, { flag: "wx", mode: 0o600 });
      return { lockDir, ownerFile, token };
    } catch (error) {
      if (created) fs.rmSync(lockDir, { recursive: true, force: true });
      if (error?.code !== "EEXIST") throw new Error(`failed to acquire assignment lock: ${error?.message ?? String(error)}`);
      const owner = assignmentLockOwner(ownerFile);
      const target = owner ? ownerFile : lockDir;
      try {
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink() || Date.now() - stat.mtimeMs > 5 * 60_000) throw new Error("assignment lock is unsafe or stale and requires operator cleanup");
      } catch (statError) {
        if (statError?.code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() > deadline) throw new Error("timed out waiting for assignment lock");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}
async function withCoordinatorAssignmentLock(paths, operation) {
  const lock = await acquireCoordinatorAssignmentLock(paths);
  const heartbeat = setInterval(() => {
    try {
      if (assignmentLockOwner(lock.ownerFile)?.token !== lock.token) return;
      const now = new Date(); fs.utimesSync(lock.ownerFile, now, now); fs.utimesSync(lock.lockDir, now, now);
    } catch { /* release owns cleanup */ }
  }, 1_000);
  try { return await operation(); }
  finally {
    clearInterval(heartbeat);
    if (assignmentLockOwner(lock.ownerFile)?.token === lock.token) fs.rmSync(lock.lockDir, { recursive: true, force: true });
  }
}
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
  let state;
  let outcome;
  try {
    state = protectedJson(path.join(paths.sessionDir, "state.json"), "workflow session state", 4 * 1024 * 1024);
    outcome = protectedJson(path.join(paths.sessionDir, "workflow-outcome.json"), "workflow outcome", 4 * 1024 * 1024);
  } catch (error) {
    throw new Error("archive requires a synchronized terminal Flow Agents projection and workflow outcome", { cause: error });
  }
  const projectedOutcome = state.workflow_outcome;
  if (!record(state.flow_run)
      || state.flow_run.run_id !== paths.runId
      || state.flow_run.run_head !== flow.flowRunHead(run.state)
      || state.flow_run.status !== run.state.status
      || state.flow_run.current_step !== run.state.current_step
      || !record(projectedOutcome)
      || projectedOutcome.flow_status !== run.state.status
      || outcome.task_slug !== paths.runId
      || canonicalJson(outcome.run_correlation) !== canonicalJson(state.run_correlation)
      || canonicalJson(outcome.workflow_outcome) !== canonicalJson(projectedOutcome)
      || outcome.process_status !== projectedOutcome.process_status) {
    throw new Error("archive requires a synchronized terminal Flow Agents projection and workflow outcome");
  }
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
function completion(envelope, paths, operationStatus, resultCoreSha256, recoveryGeneration = null) {
  const generationBound = GENERATION_BOUND_ACTIONS.has(envelope.action);
  if (generationBound !== (recoveryGeneration !== null) || (generationBound && !FLOW_RECOVERY_GENERATION.test(String(recoveryGeneration)))) {
    throw new Error("lifecycle completion recovery generation is invalid");
  }
  const unsigned = { schema_version: PROTOCOL_VERSION, kind: "kontourai.lifecycle-authority.completion", action: envelope.action, request_sha256: envelope.request_sha256, run_id: paths.runId, operation_status: operationStatus, result_core_sha256: resultCoreSha256, coordinator_runtime_sha256: coordinatorRuntimeSha256(), completed_at: new Date().toISOString(), ...(generationBound ? { recovery_generation: recoveryGeneration } : {}) };
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
function assertVerificationResealAssignment(paths, authorization) {
  const assignmentBytes = protectedRegularFile(assignmentFile(paths), "canonical assignment", 256 * 1024);
  const assignment = JSON.parse(assignmentBytes.toString("utf8"));
  if (sha256(assignmentBytes) !== authorization.assignment_generation_sha256
      || assignment.status !== "claimed"
      || assignment.artifact_dir !== paths.runId
      || assignment.actor_key !== authorization.assignment_actor_key
      || !assignmentActorsMatch(assignment.actor, authorization.assignment_actor)) {
    throw new Error("verification evidence reseal active assignment generation changed");
  }
}
async function assertVerificationResealCurrentPreimages({ paths, authorization, bundleFile, beforeBytes, candidateFile, candidateBytes, completionBytes, ledger, files }) {
  assertVerificationResealAssignment(paths, authorization);
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

async function assertVerificationResealFinalPublicationBoundary(paths, plan) {
  const authorization = plan.authorization;
  assertVerificationResealAssignment(paths, authorization);
  const bundleBytes = protectedRegularFile(path.join(paths.sessionDir, "trust.bundle"), "trust bundle", 4 * 1024 * 1024);
  if (sha256(bundleBytes) !== authorization.preimage_bundle_sha256) throw new Error("verification evidence reseal trust preimage changed at final publication");
  const candidateFile = path.join(paths.sessionDir, `.workflow-evidence-transaction-${authorization.candidate_transaction_id}`, "trust.bundle.candidate");
  const candidateBytes = protectedRegularFile(candidateFile, "verification evidence candidate", 4 * 1024 * 1024);
  if (sha256(candidateBytes) !== authorization.candidate_bundle_sha256) throw new Error("verification evidence reseal candidate changed at final publication");
  const ledger = loadResolutionEventLedger(paths, JSON.parse(bundleBytes.toString("utf8")), authorization, authorization.operation);
  if (sha256(ledger.bytes) !== authorization.preimage_ledger_sha256) throw new Error("verification evidence reseal ledger changed at final publication");
  const completionBytes = protectedRegularFile(path.join(paths.sessionDir, "lifecycle-authority.completion.json"), "current lifecycle completion", 256 * 1024);
  if (sha256(completionBytes) !== authorization.current_completion_sha256) throw new Error("verification evidence reseal completion changed at final publication");
  const files = canonicalFlowPaths(paths);
  const manifestBytes = protectedRegularFile(files.manifest, "canonical Flow evidence manifest", MAX_CANONICAL_FLOW_MANIFEST_BYTES);
  const state = protectedJson(files.state, "canonical Flow state", 4 * 1024 * 1024);
  const { flow } = await loadPinnedFlowReducer();
  if (flow.flowRunHead(state) !== authorization.flow_run_head || sha256(manifestBytes) !== authorization.flow_manifest_sha256) {
    throw new Error("verification evidence reseal Flow preimage changed at final publication");
  }
  assertVerificationResealStages(paths, plan);
}
async function prepareVerificationResealTransaction(envelope, paths, authorization, { lockHeld = false } = {}) {
  const binding = { request_sha256: envelope.request_sha256, authorization_sha256: sha256(canonicalJson(authorization)) };
  rejectActiveLegacyResealJournal(paths, binding);
  await preflightVerificationResealFlowCapabilities();
  const prepare = async () => {
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
      const parent = directoryDescriptor(file, `verification reseal artifact ${id}`);
      fs.closeSync(parent.descriptor);
      const postBytes = postimageByFile.get(file);
      const post = exactArtifactDescriptor(postBytes, 0o644);
      stageVerificationResealImage(file, preimage.bytes, preimage.descriptor.mode, "old");
      stageVerificationResealImage(file, postBytes, post.mode, "new");
      artifacts.push({ id, parent: parent.identity, pre: preimage.descriptor, post });
    }
    const planCore = {
      schema_version: PROTOCOL_VERSION,
      kind: VERIFICATION_RESEAL_TRANSACTION_PROTOCOL,
      run_id: paths.runId,
      request_sha256: envelope.request_sha256,
      authorization_sha256: binding.authorization_sha256,
      authorization_key_id: authorization.signature.key_id,
      authorization_nonce: authorization.nonce,
      authorization,
      assignment: {
        generation_sha256: authorization.assignment_generation_sha256,
        actor_key: authorization.assignment_actor_key,
        actor: authorization.assignment_actor,
      },
      reducer: synchronized.reducer,
      result_core_sha256: resultCoreSha256,
      artifacts,
    };
    const plan = validateVerificationResealPlan({ ...planCore, recovery_id: sha256(planCore) });
    return { run_id: paths.runId, plan };
  };
  return lockHeld
    ? prepare()
    : withCoordinatorAssignmentLock(paths, () => withCanonicalFlowRunMutationLock(paths, prepare));
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
async function publishVerificationResealTransaction(paths, capability, binding, { lockHeld = false } = {}) {
  const value = verifiedCapability(capability, "reseal-plan-capability");
  if (!record(value.plan)) throw new Error("verification reseal plan capability payload is invalid");
  const plan = assertVerificationResealPlanBinding(value.plan, paths, binding);
  const atomicReplaceCapability = loadVerificationResealAtomicReplaceCapability();
  const observedFence = inspectVerificationResealFence(paths);
  const withLock = observedFence.status === "active"
    ? (operation) => withCanonicalFlowRunRecoveryLock(paths, observedFence.recovery_id, operation)
    : (operation) => withCanonicalFlowRunMutationLock(paths, operation);
  const publish = async () => {
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
      await assertVerificationResealFinalPublicationBoundary(paths, plan);
      const fence = inspectVerificationResealFence(paths);
      if (fence.status === "open") await writeVerificationResealFence(paths, plan.recovery_id, "active");
      else if (fence.recovery_id !== plan.recovery_id) throw new Error("verification reseal recovery fence belongs to another generation");
      const files = verificationResealArtifactFiles(paths, plan.request_sha256);
      for (const artifact of plan.artifacts) {
        const file = files.get(artifact.id);
        try {
          const bytes = readVerificationResealArtifact(verificationResealStageFile(file, "new"), `verification reseal new stage ${artifact.id}`).bytes;
          replaceVerificationResealArtifactCAS(file, artifact, bytes, atomicReplaceCapability);
        } catch (error) {
          quarantineVerificationResealTransaction(paths, plan);
          throw error;
        }
      }
    }
    if (classifyVerificationResealArtifacts(paths, plan) !== "new") throw new Error("verification reseal publication did not install the exact postimages");
    const fence = inspectVerificationResealFence(paths);
    if (fence.status !== "active" || fence.recovery_id !== plan.recovery_id) throw new Error("verification reseal publication lost its active Flow recovery fence");
    return { result_core_sha256: plan.result_core_sha256, run_id: paths.runId, recovery_id: plan.recovery_id, recovery_generation: fence.generation };
  };
  return lockHeld ? publish() : withCoordinatorAssignmentLock(paths, () => withLock(publish));
}
async function recoverVerificationResealTransaction(paths, binding) {
  const observedFence = inspectVerificationResealFence(paths);
  const withLock = observedFence.status === "active"
    ? (operation) => withCanonicalFlowRunRecoveryLock(paths, observedFence.recovery_id, operation)
    : (operation) => withCanonicalFlowRunMutationLock(paths, operation);
  return withCoordinatorAssignmentLock(paths, () => withLock(async () => {
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
      return { run_id: paths.runId, recovered: true, state: "new", result_core_sha256: plan.result_core_sha256, recovery_generation: fence.generation };
    }
    return { run_id: paths.runId, recovered: true, state: "old", capability };
  }));
}
async function finalizeVerificationResealTransaction(paths, completion) {
  return withCoordinatorAssignmentLock(
    paths,
    () => finalizeVerificationResealTransactionLocked(paths, completion),
  );
}
function cleanupFinalizedVerificationResealReplay(paths, plan, completion, observedFence) {
  validateVerificationResealPlan(plan);
  if (observedFence.status !== "open" || observedFence.recovery_id !== plan.recovery_id
      || observedFence.previous_generation !== completion.recovery_generation) {
    throw new Error("verification reseal cleanup replay does not bind the finalized Flow recovery generation");
  }
  if (completion.request_sha256 !== plan.request_sha256 || completion.result_core_sha256 !== plan.result_core_sha256) {
    throw new Error("verification reseal cleanup replay does not bind the signed plan result");
  }
  const receipt = protectedJson(path.join(paths.sessionDir, "lifecycle-authority.completion.json"), "verification reseal completion receipt", 256 * 1024);
  if (canonicalJson(receipt) !== canonicalJson(completion)) throw new Error("verification reseal cleanup replay receipt is not exact");
  // Once Flow has durably finalized this exact generation, ordinary writers may
  // supersede its postimages. Cleanup removes only the signed plan and private
  // stage files, so live Flow and session evidence must remain untouched.
  cleanupVerificationResealTransaction(paths, plan);
  return { run_id: paths.runId, finalized: true, cleanup_replayed: true };
}
async function finalizeVerificationResealTransactionLocked(paths, completion) {
  const observedFence = inspectVerificationResealFence(paths);
  if (observedFence.status !== "active") {
    if (fs.existsSync(verificationResealPlanFile(paths))) {
      const { plan } = readSignedVerificationResealPlan(paths);
      return cleanupFinalizedVerificationResealReplay(paths, plan, completion, observedFence);
    }
    return { run_id: paths.runId, finalized: false };
  }
  const finalized = await withCanonicalFlowRunRecoveryLock(paths, observedFence.recovery_id, async () => {
    const { plan } = readSignedVerificationResealPlan(paths);
    if (completion.request_sha256 !== plan.request_sha256 || completion.result_core_sha256 !== plan.result_core_sha256) {
      throw new Error("verification reseal durable completion does not bind the signed plan result");
    }
    if (completion.recovery_generation !== observedFence.generation) throw new Error("verification reseal completion does not bind the active Flow recovery generation");
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
  await finalizeVerificationResealFence(paths, finalized.plan.recovery_id, finalized.generation, async () => {
    const receipt = protectedJson(path.join(paths.sessionDir, "lifecycle-authority.completion.json"), "verification reseal pre-open completion receipt", 256 * 1024);
    if (canonicalJson(receipt) !== canonicalJson(completion)) throw new Error("verification reseal pre-open completion receipt changed");
    if (classifyVerificationResealArtifacts(paths, finalized.plan) !== "new") throw new Error("verification reseal pre-open postimages changed");
  });
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
export function validateProvisionalDeliveryTransport(destination, expected) {
  if (!Array.isArray(expected) || expected.length !== 4) {
    throw new Error("provisional delivery authorization must bind exactly four companions");
  }
  const names = new Set();
  for (const entry of expected) {
    if (!record(entry) || typeof entry.path !== "string" || !/^[a-z0-9.-]+$/.test(entry.path)
        || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256) || names.has(entry.path)) {
      throw new Error("provisional delivery authorization companions are invalid");
    }
    names.add(entry.path);
    const file = path.join(destination, entry.path);
    if (!within(file, destination)
        || sha256(protectedRegularFile(file, `provisional delivery companion ${entry.path}`, 8 * 1024 * 1024)) !== entry.sha256) {
      throw new Error("provisional delivery transport does not match the signed authorization");
    }
  }
  const fixed = ["trust.bundle", "trust.checkpoint.json", "trust.checkpoint.attestation.json"];
  const transportCompanions = ["trust.checkpoint.sig.json", "trust.checkpoint.intoto.json"].filter((name) => names.has(name));
  if (!fixed.every((name) => names.has(name)) || transportCompanions.length !== 1) {
    throw new Error("provisional delivery authorization must bind the exact bundle, checkpoint, attestation, and one signature or in-toto companion");
  }
  const actual = fs.readdirSync(destination).sort();
  if (canonicalJson(actual) !== canonicalJson([...names].sort())) {
    throw new Error("provisional delivery transport contains an unsigned extra path");
  }
  const selectedCompanion = transportCompanions[0];
  const attestation = protectedJson(path.join(destination, "trust.checkpoint.attestation.json"), "provisional delivery checkpoint attestation", 256 * 1024);
  const expectedStatus = selectedCompanion === "trust.checkpoint.sig.json" ? "signed" : "unsigned";
  if (attestation.path !== selectedCompanion || attestation.status !== expectedStatus) {
    throw new Error("provisional delivery checkpoint attestation does not declare the exact authorized companion");
  }
  return { names, selectedCompanion };
}
function recoverPreparedProvisionalDeliveryEvent(events, authorization) {
  const authorizationBytes = canonicalJson(authorization);
  const authorizationSha256 = sha256(authorizationBytes);
  const authorizationMatches = [];
  for (const [index, currentEvent] of events.entries()) {
    if (currentEvent.authorization_sha256 !== authorizationSha256) continue;
    if (canonicalJson(currentEvent.signed_authorization) !== authorizationBytes) {
      throw new Error("prepared provisional delivery authorization digest conflicts with the durable ledger bytes");
    }
    authorizationMatches.push(index);
  }
  if (authorizationMatches.length === 0) return null;
  const tailIndex = events.length - 1;
  if (authorizationMatches.length !== 1 || authorizationMatches[0] !== tailIndex) {
    throw new Error("prepared provisional delivery authorization is already present before the durable ledger tail");
  }
  return events[tailIndex];
}
function provisionalGateVisit(state) {
  let enteredAt = null;
  for (const transition of state.transitions ?? []) if (transition?.to_step === state.current_step) enteredAt = Date.parse(transition.at);
  if (!Number.isFinite(enteredAt)) enteredAt = Date.parse(state.updated_at);
  if (!Number.isFinite(enteredAt)) throw new Error("canonical Flow gate visit is invalid");
  return new Date(enteredAt).toISOString();
}
function assertProvisionalAuthorizationContext(paths, authorization, context) {
  const { definition, state, flow, assignment, subject, providerObservationBytes, changeRef } = context;
  validateProvisionalDeliveryAuthorizationBinding(authorization, {
    project_root: paths.projectRoot, run_id: paths.runId, checkpoint_slug: paths.runId,
    subject, work_item: subject, assignment_actor_key: assignment.actor_key, assignment_generation: assignment.claimed_at,
    published_head_sha: changeRef.head_sha, provider_record_id: changeRef.provider_record_id,
    provider_observation_sha256: sha256(providerObservationBytes),
    flow_definition_id: "builder.build", flow_definition_version: state.definition_version,
    flow_definition_digest: flow.definitionDigest(definition), flow_run_head: flow.flowRunHead(state),
    flow_gate_id: openGateId(definition, state), flow_gate_visit: provisionalGateVisit(state),
  });
  if (authorization.run_id !== paths.runId || authorization.flow_definition_id !== "builder.build" || definition.id !== "builder.build"
      || state.current_step !== "merge-ready-ci" || state.status !== "active") {
    throw new Error("provisional delivery authorization does not bind the active builder.build merge-ready-ci gate");
  }
  if (assignment.status !== "claimed" || authorization.checkpoint_commit_sha !== authorization.workspace_snapshot.head_sha
      || authorization.published_head_sha !== authorization.checkpoint_commit_sha) {
    throw new Error("provisional delivery authorization does not bind the live assignment and workspace revision");
  }
  for (const field of ["flow_definition_digest", "flow_run_head", "checkpoint_sha256", "bundle_sha256", "attestation_sha256"]) {
    if (!/^[a-f0-9]{64}$/.test(String(authorization[field]))) throw new Error(`provisional delivery authorization ${field} is invalid`);
  }
}
function assertProvisionalCheckpoint(paths, authorization, destination, expected) {
  validateProvisionalDeliveryTransport(destination, expected);
  const checkpoint = protectedJson(path.join(destination, "trust.checkpoint.json"), "provisional delivery checkpoint", 256 * 1024);
  if (checkpoint.status !== "provisional" || checkpoint.phase !== "ci-readiness" || checkpoint.slug !== paths.runId
      || checkpoint.commit_sha !== authorization.checkpoint_commit_sha
      || authorization.checkpoint_sha256 !== expected.find((entry) => entry.path === "trust.checkpoint.json")?.sha256
      || authorization.bundle_sha256 !== expected.find((entry) => entry.path === "trust.bundle")?.sha256
      || authorization.attestation_sha256 !== expected.find((entry) => entry.path === "trust.checkpoint.attestation.json")?.sha256) {
    throw new Error("provisional delivery checkpoint does not match the signed authorization");
  }
}
function assertProvisionalAuthorizationShape(paths, authorization) {
  if (authorization.project_root !== paths.projectRoot || authorization.checkpoint_slug !== paths.runId
      || typeof authorization.subject !== "string" || !authorization.subject || typeof authorization.work_item !== "string" || !authorization.work_item
      || typeof authorization.assignment_actor_key !== "string" || !authorization.assignment_actor_key
      || typeof authorization.assignment_generation !== "string" || !authorization.assignment_generation
      || typeof authorization.flow_definition_version !== "string" || !authorization.flow_definition_version
      || typeof authorization.flow_gate_id !== "string" || !authorization.flow_gate_id
      || typeof authorization.flow_gate_visit !== "string" || !authorization.flow_gate_visit
      || !record(authorization.workspace_snapshot)) throw new Error("provisional delivery authorization binding is invalid");
}
async function prepareProvisionalDeliveryMutation(paths, authorization) {
  const definition = protectedJson(canonicalFlowPaths(paths).definition, "canonical Flow definition", MAX_CANONICAL_FLOW_MANIFEST_BYTES);
  const state = protectedJson(canonicalFlowPaths(paths).state, "canonical Flow state", MAX_CANONICAL_FLOW_MANIFEST_BYTES);
  const { flow } = await loadPinnedFlowReducer();
  const assignment = protectedJson(assignmentFile(paths), "canonical assignment", 256 * 1024);
  const subject = sessionSubject(paths);
  const providerObservationBytes = protectedRegularFile(path.join(paths.sessionDir, "publish-change.result.json"), "authenticated publish-change result", 256 * 1024);
  const providerObservation = JSON.parse(providerObservationBytes.toString("utf8"));
  const changeRef = record(providerObservation.change_ref) ? providerObservation.change_ref : null;
  if (!changeRef) throw new Error("authenticated publish-change result is invalid");
  assertProvisionalAuthorizationContext(paths, authorization, { definition, state, flow, assignment, subject, providerObservationBytes, changeRef });
  assertProvisionalAuthorizationShape(paths, authorization);
  const destination = path.join(paths.projectRoot, "delivery", paths.runId);
  const expected = Array.isArray(authorization.companions) ? authorization.companions : [];
  assertProvisionalCheckpoint(paths, authorization, destination, expected);
  if (canonicalJson(provisionalWorkspaceSnapshot(paths.projectRoot, paths.runId)) !== canonicalJson(authorization.workspace_snapshot)) {
    throw new Error("provisional delivery source changed after authorization");
  }
  return { flow, destination, expected, ledger: loadProvisionalDeliveryLedger(paths) };
}
async function appendOrRecoverProvisionalDeliveryEvent(paths, authorization, prepared, resumePrepared) {
  const { flow, destination, expected, ledger } = prepared;
  const predecessor_hash = ledger.value.events.at(-1)?.event_hash ?? "0".repeat(64);
  const authorizationSha256 = sha256(canonicalJson(authorization));
  const unsigned = { schema_version: PROTOCOL_VERSION, kind: "kontourai.lifecycle-authority.provisional-delivery-event", run_id: paths.runId, subject: authorization.subject, authorization_sha256: authorizationSha256, predecessor_hash, signed_authorization: authorization };
  const event = { ...unsigned, event_hash: sha256(unsigned) };
  return withCanonicalFlowRunMutationLock(paths, async () => {
    const currentLedger = loadProvisionalDeliveryLedger(paths);
    const currentState = protectedJson(canonicalFlowPaths(paths).state, "canonical Flow state", MAX_CANONICAL_FLOW_MANIFEST_BYTES);
    if (flow.flowRunHead(currentState) !== authorization.flow_run_head || currentState.status !== "active" || currentState.current_step !== "merge-ready-ci") {
      throw new Error("canonical Flow state changed before provisional delivery authority append");
    }
    if (canonicalJson(provisionalWorkspaceSnapshot(paths.projectRoot, paths.runId)) !== canonicalJson(authorization.workspace_snapshot)) {
      throw new Error("provisional delivery source changed before authority append");
    }
    validateProvisionalDeliveryTransport(destination, expected);
    if (resumePrepared) {
      const recovered = recoverPreparedProvisionalDeliveryEvent(currentLedger.value.events, authorization);
      if (recovered !== null) return recovered;
    }
    const samePreimage = ledger.bytes === null ? currentLedger.bytes === null : currentLedger.bytes?.equals(ledger.bytes) === true;
    if (!samePreimage) throw new Error("provisional delivery authority ledger changed before append");
    atomicWrite(ledger.file, `${JSON.stringify({ schema_version: PROTOCOL_VERSION, events: [...ledger.value.events, event] }, null, 2)}\n`, 0o644);
    return event;
  });
}
async function executeProvisionalDeliveryMutation(paths, authorization, resumePrepared) {
  const prepared = await prepareProvisionalDeliveryMutation(paths, authorization);
  const durableEvent = await appendOrRecoverProvisionalDeliveryEvent(paths, authorization, prepared, resumePrepared);
  return { result_core_sha256: sha256(durableEvent), run_id: paths.runId };
}
function exactCurrentRecoveryProtectedFiles(paths) {
  return new Map([
    ["trust-bundle", path.join(paths.sessionDir, "trust.bundle")],
    ["resolution-ledger", resolutionEventLedgerFile(paths)],
    ["stale-receipt", path.join(paths.sessionDir, "lifecycle-authority.completion.json")],
    ["flow-state", canonicalFlowPaths(paths).state],
  ]);
}
export function validateExactCurrentRecoveryPlan(plan) {
  exact(plan, [
    "schema_version", "kind", "recovery_id", "run_id", "request_sha256", "authorization_sha256",
    "authorization_key_id", "authorization_nonce", "reducer", "result_core_sha256", "protected_preimages", "artifacts",
  ], "exact-current recovery publication plan");
  if (plan.schema_version !== PROTOCOL_VERSION || plan.kind !== EXACT_CURRENT_RECOVERY_PUBLICATION_PROTOCOL
      || !/^[a-f0-9]{64}$/.test(String(plan.recovery_id)) || typeof plan.run_id !== "string" || !plan.run_id
      || !/^[a-f0-9]{64}$/.test(String(plan.request_sha256))
      || !/^[a-f0-9]{64}$/.test(String(plan.authorization_sha256))
      || typeof plan.authorization_key_id !== "string" || !plan.authorization_key_id
      || typeof plan.authorization_nonce !== "string" || !plan.authorization_nonce
      || !record(plan.reducer) || !/^[a-f0-9]{64}$/.test(String(plan.result_core_sha256))
      || !Array.isArray(plan.protected_preimages) || plan.protected_preimages.length !== 4
      || !Array.isArray(plan.artifacts) || plan.artifacts.length !== EXACT_CURRENT_RECOVERY_ARTIFACT_IDS.length) {
    throw new Error("exact-current recovery publication plan identity is invalid");
  }
  const protectedIds = plan.protected_preimages.map((artifact) => artifact?.id);
  if (canonicalJson(protectedIds) !== canonicalJson(["trust-bundle", "resolution-ledger", "stale-receipt", "flow-state"])) {
    throw new Error("exact-current recovery plan must bind exactly the protected evidence inputs");
  }
  for (const artifact of plan.protected_preimages) {
    exact(artifact, ["id", "pre"], `exact-current recovery protected input ${artifact?.id}`);
    assertVerificationResealDescriptor(artifact.pre, `exact-current recovery protected input ${artifact.id}`);
  }
  const ids = plan.artifacts.map((artifact) => artifact?.id);
  if (canonicalJson(ids) !== canonicalJson(EXACT_CURRENT_RECOVERY_ARTIFACT_IDS)) {
    throw new Error("exact-current recovery plan must enumerate exactly the fixed four Flow artifact ids");
  }
  for (const artifact of plan.artifacts) {
    exact(artifact, ["id", "pre", "post"], `exact-current recovery artifact ${artifact?.id}`);
    assertVerificationResealDescriptor(artifact.pre, `exact-current recovery artifact ${artifact.id} preimage`);
    assertVerificationResealDescriptor(artifact.post, `exact-current recovery artifact ${artifact.id} postimage`);
  }
  return plan;
}
function assertExactCurrentRecoveryPlanBinding(plan, paths, binding) {
  validateExactCurrentRecoveryPlan(plan);
  if (plan.run_id !== paths.runId || plan.request_sha256 !== binding.request_sha256
      || plan.authorization_sha256 !== binding.authorization_sha256) {
    throw new Error("exact-current recovery publication plan does not bind this exact operation");
  }
  return plan;
}
function assertExactCurrentRecoveryProtectedPreimages(paths, plan) {
  const files = exactCurrentRecoveryProtectedFiles(paths);
  for (const artifact of plan.protected_preimages) {
    const actual = readVerificationResealArtifact(files.get(artifact.id), `exact-current recovery protected input ${artifact.id}`).descriptor;
    if (canonicalJson(actual) !== canonicalJson(artifact.pre)) {
      throw new Error(`exact-current recovery protected input ${artifact.id} changed`);
    }
  }
}
function assertExactCurrentRecoveryFinalProtectedInputs(paths, plan) {
  const files = exactCurrentRecoveryProtectedFiles(paths);
  for (const artifact of plan.protected_preimages.filter((candidate) => candidate.id !== "stale-receipt")) {
    const actual = readVerificationResealArtifact(files.get(artifact.id), `exact-current recovery final protected input ${artifact.id}`).descriptor;
    if (canonicalJson(actual) !== canonicalJson(artifact.pre)) {
      throw new Error(`exact-current recovery final protected input ${artifact.id} changed`);
    }
  }
}
function assertExactCurrentRecoveryStages(paths, plan) {
  const files = exactCurrentRecoveryArtifactFiles(paths, plan.request_sha256, plan.authorization_sha256);
  for (const artifact of plan.artifacts) {
    const file = files.get(artifact.id);
    for (const [image, expected] of [["old", artifact.pre], ["new", artifact.post]]) {
      const actual = readVerificationResealArtifact(exactCurrentRecoveryStageFile(file, image), `exact-current recovery ${image} stage`).descriptor;
      if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`exact-current recovery ${image} stage for ${artifact.id} changed`);
    }
  }
}
export function classifyExactCurrentRecoveryArtifacts(paths, plan) {
  const files = exactCurrentRecoveryArtifactFiles(paths, plan.request_sha256, plan.authorization_sha256);
  const states = plan.artifacts.map((artifact) => {
    const actual = readVerificationResealArtifact(files.get(artifact.id), `exact-current recovery artifact ${artifact.id}`).descriptor;
    const pre = canonicalJson(actual) === canonicalJson(artifact.pre);
    const post = canonicalJson(actual) === canonicalJson(artifact.post);
    return pre && post ? "both" : pre ? "pre" : post ? "post" : "unknown";
  });
  if (states.some((state) => state === "unknown")) return "unknown";
  if (states.every((state) => state === "pre" || state === "both")) return "old";
  if (states.every((state) => state === "post" || state === "both")) return "new";
  return "mixed";
}
function readSignedExactCurrentRecoveryPlan(paths) {
  const capability = protectedJson(exactCurrentRecoveryPlanFile(paths), "exact-current recovery signed plan", 1024 * 1024);
  const value = verifiedCapability(capability, "exact-current-recovery-plan-capability");
  if (!record(value.plan)) throw new Error("exact-current recovery signed plan payload is invalid");
  return { capability, plan: validateExactCurrentRecoveryPlan(value.plan) };
}
async function prepareExactCurrentRecoveryPublication(envelope, paths, authorization, { lockHeld = false, afterSynchronization = null } = {}) {
  const binding = { request_sha256: envelope.request_sha256, authorization_sha256: sha256(canonicalJson(authorization)) };
  const prepare = async () => {
    const fence = inspectVerificationResealFence(paths);
    if (fence.status !== "open") throw new Error("exact-current recovery cannot capture artifacts while the Flow recovery fence is active");
    if (fs.existsSync(exactCurrentRecoveryPlanFile(paths))) throw new Error("exact-current recovery found an existing signed plan; recovery is required");
    const initial = await assertExactCurrentCompletionRecoveryPreimages(paths, authorization, envelope);
    const synchronized = await prepareCanonicalFlowSynchronization(paths, initial.reduced.bundle, envelope, {
      definition_id: authorization.flow_definition_id, step_id: authorization.flow_step_id, gate_id: authorization.flow_gate_id,
      subject: authorization.subject, run_head: authorization.flow_run_head, manifest_sha256: authorization.flow_manifest_sha256,
    }, binding.authorization_sha256, "attach-only");
    if (typeof afterSynchronization === "function") await afterSynchronization();
    const artifactFiles = exactCurrentRecoveryArtifactFiles(paths, envelope.request_sha256, binding.authorization_sha256);
    const postimageByFile = new Map(synchronized.postimages.map((postimage) => [postimage.file, postimage.bytes]));
    if (postimageByFile.size !== EXACT_CURRENT_RECOVERY_ARTIFACT_IDS.length
        || [...artifactFiles.values()].some((file) => !postimageByFile.has(file))) {
      throw new Error("exact-current recovery reducer did not produce exactly the fixed four Flow artifacts");
    }
    const artifacts = [];
    for (const id of EXACT_CURRENT_RECOVERY_ARTIFACT_IDS) {
      const file = artifactFiles.get(id);
      const preimage = readVerificationResealArtifact(file, `exact-current recovery artifact ${id}`);
      const postBytes = postimageByFile.get(file);
      const post = exactArtifactDescriptor(postBytes, 0o644);
      stageExactCurrentRecoveryImage(file, preimage.bytes, preimage.descriptor.mode, "old");
      stageExactCurrentRecoveryImage(file, postBytes, post.mode, "new");
      artifacts.push({ id, pre: preimage.descriptor, post });
    }
    const protectedFiles = exactCurrentRecoveryProtectedFiles(paths);
    const protectedPreimages = [...protectedFiles].map(([id, file]) => ({
      id,
      pre: id === "flow-state"
        ? synchronized.flow_state_preimage
        : readVerificationResealArtifact(file, `exact-current recovery protected input ${id}`).descriptor,
    }));
    const planCore = {
      schema_version: PROTOCOL_VERSION,
      kind: EXACT_CURRENT_RECOVERY_PUBLICATION_PROTOCOL,
      run_id: paths.runId,
      request_sha256: envelope.request_sha256,
      authorization_sha256: binding.authorization_sha256,
      authorization_key_id: authorization.signature.key_id,
      authorization_nonce: authorization.nonce,
      reducer: synchronized.reducer,
      result_core_sha256: lifecycleAuthorityResultDigest(initial.reduced.bundle, initial.reduced.resolution_events),
      protected_preimages: protectedPreimages,
      artifacts,
    };
    return { run_id: paths.runId, plan: validateExactCurrentRecoveryPlan({ ...planCore, recovery_id: sha256(planCore) }) };
  };
  return lockHeld ? prepare() : withCanonicalFlowRunMutationLock(paths, prepare);
}
function installExactCurrentRecoveryImage(file, descriptor, stage, label) {
  if (descriptor.presence === "absent") {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return;
  }
  const bytes = readVerificationResealArtifact(stage, label).bytes;
  atomicWrite(file, bytes, descriptor.mode);
}
async function publishExactCurrentRecoveryPublication(paths, capability, binding, { lockHeld = false, after_write = null } = {}) {
  const value = verifiedCapability(capability, "exact-current-recovery-plan-capability");
  if (!record(value.plan)) throw new Error("exact-current recovery plan capability payload is invalid");
  const plan = assertExactCurrentRecoveryPlanBinding(value.plan, paths, binding);
  const observedFence = inspectVerificationResealFence(paths);
  const withLock = observedFence.status === "active"
    ? (operation) => withCanonicalFlowRunRecoveryLock(paths, observedFence.recovery_id, operation)
    : (operation) => withCanonicalFlowRunMutationLock(paths, operation);
  const publish = async () => {
    const planFile = exactCurrentRecoveryPlanFile(paths);
    if (fs.existsSync(planFile)) {
      const current = protectedJson(planFile, "exact-current recovery signed plan", 1024 * 1024);
      if (canonicalJson(current) !== canonicalJson(capability)) throw new Error("exact-current recovery signed plan changed");
    } else atomicWrite(planFile, `${JSON.stringify(capability, null, 2)}\n`, 0o644);
    assertExactCurrentRecoveryStages(paths, plan);
    assertExactCurrentRecoveryProtectedPreimages(paths, plan);
    const classification = classifyExactCurrentRecoveryArtifacts(paths, plan);
    if (classification === "unknown") throw new Error("exact-current recovery found foreign or unknown Flow artifact state");
    const fence = inspectVerificationResealFence(paths);
    if (fence.status === "open") await writeVerificationResealFence(paths, plan.recovery_id, "active");
    else if (fence.recovery_id !== plan.recovery_id) throw new Error("exact-current recovery fence belongs to another generation");
    const activeFence = inspectVerificationResealFence(paths);
    if (activeFence.status !== "active" || activeFence.recovery_id !== plan.recovery_id) {
      throw new Error("exact-current recovery publication lost its active Flow recovery fence");
    }
    if (classification !== "new") {
      const files = exactCurrentRecoveryArtifactFiles(paths, plan.request_sha256, plan.authorization_sha256);
      let writes = 0;
      for (const artifact of plan.artifacts) {
        const file = files.get(artifact.id);
        const actual = readVerificationResealArtifact(file, `exact-current recovery artifact ${artifact.id}`).descriptor;
        if (canonicalJson(actual) === canonicalJson(artifact.post)) continue;
        if (canonicalJson(actual) !== canonicalJson(artifact.pre)) throw new Error(`exact-current recovery artifact ${artifact.id} changed during publication`);
        installExactCurrentRecoveryImage(file, artifact.post, exactCurrentRecoveryStageFile(file, "new"), `exact-current recovery new stage ${artifact.id}`);
        writes += 1;
        await after_write?.({ writes, artifact_id: artifact.id });
      }
    }
    assertExactCurrentRecoveryProtectedPreimages(paths, plan);
    if (classifyExactCurrentRecoveryArtifacts(paths, plan) !== "new") throw new Error("exact-current recovery publication did not install the exact postimages");
    const finalFence = inspectVerificationResealFence(paths);
    if (finalFence.status !== "active" || finalFence.recovery_id !== plan.recovery_id) {
      throw new Error("exact-current recovery publication lost its active Flow recovery fence");
    }
    return { result_core_sha256: plan.result_core_sha256, run_id: paths.runId, recovery_id: plan.recovery_id, recovery_generation: finalFence.generation, state: "new" };
  };
  return lockHeld ? publish() : withLock(publish);
}
async function recoverExactCurrentRecoveryPublication(paths, binding) {
  const observedFence = inspectVerificationResealFence(paths);
  const withLock = observedFence.status === "active"
    ? (operation) => withCanonicalFlowRunRecoveryLock(paths, observedFence.recovery_id, operation)
    : (operation) => withCanonicalFlowRunMutationLock(paths, operation);
  return withLock(async () => {
    if (!fs.existsSync(exactCurrentRecoveryPlanFile(paths))) return { run_id: paths.runId, recovered: false, state: "none" };
    const { capability, plan } = readSignedExactCurrentRecoveryPlan(paths);
    assertExactCurrentRecoveryPlanBinding(plan, paths, binding);
    const fence = inspectVerificationResealFence(paths);
    if (fence.status === "active" && fence.recovery_id !== plan.recovery_id) {
      throw new Error("exact-current recovery fence belongs to another generation");
    }
    assertExactCurrentRecoveryStages(paths, plan);
    assertExactCurrentRecoveryProtectedPreimages(paths, plan);
    const classification = classifyExactCurrentRecoveryArtifacts(paths, plan);
    if (classification === "unknown") throw new Error("exact-current recovery found foreign or unknown Flow artifact state");
    if (classification === "new") {
      if (fence.status !== "active") await writeVerificationResealFence(paths, plan.recovery_id, "active");
      const activeFence = inspectVerificationResealFence(paths);
      return { run_id: paths.runId, recovered: true, state: "new", result_core_sha256: plan.result_core_sha256, recovery_generation: activeFence.generation };
    }
    return publishExactCurrentRecoveryPublication(paths, capability, binding, { lockHeld: true });
  });
}
function cleanupExactCurrentRecoveryPublication(paths, plan) {
  const files = exactCurrentRecoveryArtifactFiles(paths, plan.request_sha256, plan.authorization_sha256);
  for (const file of [...files.values()].flatMap((artifact) => [
    exactCurrentRecoveryStageFile(artifact, "old"),
    exactCurrentRecoveryStageFile(artifact, "new"),
  ])) if (fs.existsSync(file)) fs.unlinkSync(file);
  if (fs.existsSync(exactCurrentRecoveryPlanFile(paths))) fs.unlinkSync(exactCurrentRecoveryPlanFile(paths));
}
async function finalizeExactCurrentRecoveryPublication(paths, completion) {
  return withCoordinatorAssignmentLock(
    paths,
    () => finalizeExactCurrentRecoveryPublicationLocked(paths, completion),
  );
}
async function finalizeExactCurrentRecoveryPublicationLocked(paths, completion) {
  const observedFence = inspectVerificationResealFence(paths);
  if (observedFence.status !== "active") {
    if (!fs.existsSync(exactCurrentRecoveryPlanFile(paths))) return { run_id: paths.runId, finalized: false };
    const { plan } = readSignedExactCurrentRecoveryPlan(paths);
    if (observedFence.status !== "open" || observedFence.recovery_id !== plan.recovery_id
        || observedFence.previous_generation !== completion.recovery_generation) {
      throw new Error("exact-current recovery cleanup replay does not bind the finalized Flow recovery generation");
    }
    if (completion.request_sha256 !== plan.request_sha256 || completion.result_core_sha256 !== plan.result_core_sha256) {
      throw new Error("exact-current recovery cleanup replay does not bind the signed plan result");
    }
    const receipt = protectedJson(path.join(paths.sessionDir, "lifecycle-authority.completion.json"), "exact-current recovery completion receipt", 256 * 1024);
    if (canonicalJson(receipt) !== canonicalJson(completion)) throw new Error("exact-current recovery cleanup replay receipt is not exact");
    // Once Flow has durably finalized this exact recovery generation, ordinary
    // writers may legitimately supersede its postimages before cleanup replay.
    // Cleanup removes only the signed plan and private stage files, never live
    // Flow or session evidence, so do not require stale postimages here.
    cleanupExactCurrentRecoveryPublication(paths, plan);
    return { run_id: paths.runId, finalized: true, cleanup_replayed: true };
  }
  const finalized = await withCanonicalFlowRunRecoveryLock(paths, observedFence.recovery_id, async () => {
    const { plan } = readSignedExactCurrentRecoveryPlan(paths);
    if (completion.request_sha256 !== plan.request_sha256 || completion.result_core_sha256 !== plan.result_core_sha256) {
      throw new Error("exact-current recovery durable completion does not bind the signed plan result");
    }
    if (completion.recovery_generation !== observedFence.generation) throw new Error("exact-current recovery completion does not bind the active Flow recovery generation");
    const receipt = protectedJson(path.join(paths.sessionDir, "lifecycle-authority.completion.json"), "exact-current recovery completion receipt", 256 * 1024);
    if (canonicalJson(receipt) !== canonicalJson(completion)) throw new Error("exact-current recovery exact completion receipt is not installed");
    if (classifyExactCurrentRecoveryArtifacts(paths, plan) !== "new") throw new Error("exact-current recovery cannot finalize without exact postimages");
    const fence = inspectVerificationResealFence(paths);
    if (fence.status !== "active" || fence.recovery_id !== plan.recovery_id
        || fence.generation !== observedFence.generation) {
      throw new Error("exact-current recovery cannot finalize without its exact active Flow recovery fence generation");
    }
    return { plan, generation: fence.generation, result: { run_id: paths.runId, finalized: true } };
  });
  await finalizeVerificationResealFence(paths, finalized.plan.recovery_id, finalized.generation, async () => {
    const receipt = protectedJson(path.join(paths.sessionDir, "lifecycle-authority.completion.json"), "exact-current recovery pre-open completion receipt", 256 * 1024);
    if (canonicalJson(receipt) !== canonicalJson(completion)) throw new Error("exact-current recovery pre-open completion receipt changed");
    assertExactCurrentRecoveryFinalProtectedInputs(paths, finalized.plan);
    if (classifyExactCurrentRecoveryArtifacts(paths, finalized.plan) !== "new") throw new Error("exact-current recovery pre-open postimages changed");
  });
  cleanupExactCurrentRecoveryPublication(paths, finalized.plan);
  return finalized.result;
}
async function executeCritiqueMutation(envelope, paths, authorization, completionRecord, verifiedBridge) {
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
      await inCanonicalFlowProjectTransaction(paths, { request_sha256: envelope.request_sha256, authorization_sha256: sha256(canonicalJson(authorization)) }, async () => {
        const currentBytes = protectedRegularFile(bundleFile, "trust bundle", 4 * 1024 * 1024);
        assertAuthorizedBundlePreimage(currentBytes, envelope.action, authorization);
        if (!currentBytes.equals(beforeBytes)) throw new Error("critique resolution preimage changed during preparation");
        assertResolutionEventLedgerPreimage(paths, ledger);
        const synchronized = await synchronizeCanonicalFlow(paths, sessionBundle, envelope);
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
async function executeMutation(envelope, paths, authorization, completionRecord = null, verifiedBridge = null, resumePrepared = false) {
    if (authorization.project_root !== paths.projectRoot) throw new Error("authorization does not bind the canonical project root");
    if (envelope.action === "reseal-verification-evidence") throw new Error("verification evidence reseal requires the signed prepare/publish protocol");
    if (envelope.action === "recover-exact-current-completion") throw new Error("exact-current completion recovery requires the signed prepare/publish protocol");
    if (envelope.action === "publish-provisional-delivery") return executeProvisionalDeliveryMutation(paths, authorization, resumePrepared);
    if (envelope.action === "authorize-workflow-evidence") {
      const assignmentBytes = protectedRegularFile(assignmentFile(paths), "canonical assignment", 256 * 1024);
      const assignment = JSON.parse(assignmentBytes.toString("utf8"));
      if (sha256(assignmentBytes) !== authorization.assignment_generation
          || assignment.status !== "claimed"
          || assignment.artifact_dir !== paths.runId
          || assignment.actor_key !== authorization.actor_key
          || !assignmentActorsMatch(assignment.actor, authorization.actor)) {
        throw new Error("host workflow authorization active assignment generation changed");
      }
      const files = canonicalFlowPaths(paths);
      const state = protectedJson(files.state, "canonical Flow state", 4 * 1024 * 1024);
      const manifestBytes = protectedRegularFile(files.manifest, "canonical Flow evidence manifest", MAX_CANONICAL_FLOW_MANIFEST_BYTES);
      const bundleSha256 = hostEvidenceTrustBundleSha256(path.join(paths.sessionDir, "trust.bundle"));
      const { flow } = await loadPinnedFlowReducer();
      if (authorization.run_id !== paths.runId
          || authorization.subject !== sessionSubject(paths)
          || authorization.subject !== state.subject
          || authorization.flow_run_head !== flow.flowRunHead(state)
          || authorization.flow_manifest_sha256 !== sha256(manifestBytes)
          || authorization.trust_bundle_sha256 !== bundleSha256) {
        throw new Error("host workflow authorization canonical evidence preimage changed");
      }
      return {
        result_core_sha256: sha256({
          authorization_sha256: sha256(canonicalJson(authorization)),
          evidence_request_sha256: authorization.evidence_request_sha256,
        }),
        run_id: paths.runId,
      };
    }
    if (["resolve-critique", "repair-critique-resolution-history"].includes(envelope.action)) {
      return executeCritiqueMutation(envelope, paths, authorization, completionRecord, verifiedBridge);
    }
    const outcome = envelope.action === "cancel"
      ? await cancelCanonicalFlow(paths, authorization)
      : await withCanonicalFlowRunMutationLock(paths, () => archiveCanonicalSession(paths, authorization));
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
  const generationBound = GENERATION_BOUND_ACTIONS.has(completionRecord?.action);
  const fields = ["schema_version", "kind", "action", "request_sha256", "run_id", "operation_status", "result_core_sha256", "coordinator_runtime_sha256", "completed_at", ...(generationBound ? ["recovery_generation"] : []), "signature"];
  exact(completionRecord, fields, "durable lifecycle completion");
  if (completionRecord.schema_version !== PROTOCOL_VERSION || completionRecord.kind !== "kontourai.lifecycle-authority.completion" || completionRecord.run_id !== identity.runId || completionRecord.action !== envelope.action || !ACTION_FIELDS[completionRecord.action] || completionRecord.request_sha256 !== envelope.request_sha256 || completionRecord.operation_status !== "applied" || completionRecord.result_core_sha256 !== prior.result_core_sha256 || !/^[a-f0-9]{64}$/.test(completionRecord.result_core_sha256) || (generationBound && !FLOW_RECOVERY_GENERATION.test(String(completionRecord.recovery_generation))) || !record(completionRecord.signature) || completionRecord.signature.algorithm !== "ed25519" || typeof completionRecord.signature.value !== "string") throw new Error("durable lifecycle completion record does not match the exact request");
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
async function interactiveResealInvocation(payload, identity, signPlan) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    env: {
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      FLOW_AGENTS_LIFECYCLE_MUTATION_WORKER: "1",
      FLOW_AGENTS_LIFECYCLE_INTERACTIVE_RESEAL: "1",
    },
    uid: identity.uid,
    gid: identity.gid,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (Buffer.byteLength(stderr) > 512 * 1024) child.kill("SIGKILL");
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal }));
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
  const nextLine = async (label) => {
    let timer;
    try {
      const result = await Promise.race([
        lines.next(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`unprivileged lifecycle ${label} timed out`)), 30_000);
        }),
      ]);
      if (result.done || typeof result.value !== "string" || !result.value) {
        throw new Error(`unprivileged lifecycle ${label} returned no response`);
      }
      return JSON.parse(result.value);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  try {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    const preparedPlan = await nextLine("reseal preparation");
    const planCapability = signPlan(preparedPlan);
    child.stdin.end(`${JSON.stringify({ kind: "publish-reseal", capability: planCapability })}\n`);
    const mutation = await nextLine("reseal publication");
    const extra = await lines.next();
    if (!extra.done) throw new Error("unprivileged lifecycle interactive worker returned extra output");
    const outcome = await exited;
    if (outcome.status !== 0) throw new Error(String(stderr || `unprivileged lifecycle interactive worker exited ${outcome.status ?? outcome.signal}`).trim());
    return mutation;
  } catch (error) {
    child.kill("SIGKILL");
    await exited.catch(() => undefined);
    if (stderr) throw new Error(stderr.trim(), { cause: error });
    throw error;
  }
}
async function interactiveExactCurrentRecoveryInvocation(payload, identity, signPlan) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    env: {
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      FLOW_AGENTS_LIFECYCLE_MUTATION_WORKER: "1",
      FLOW_AGENTS_LIFECYCLE_INTERACTIVE_EXACT_CURRENT_RECOVERY: "1",
    },
    uid: identity.uid,
    gid: identity.gid,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (Buffer.byteLength(stderr) > 512 * 1024) child.kill("SIGKILL");
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal }));
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
  const nextLine = async (label) => {
    let timer;
    try {
      const result = await Promise.race([
        lines.next(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`unprivileged lifecycle ${label} timed out`)), 30_000);
        }),
      ]);
      if (result.done || typeof result.value !== "string" || !result.value) throw new Error(`unprivileged lifecycle ${label} returned no response`);
      return JSON.parse(result.value);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  try {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    const preparedPlan = await nextLine("exact-current recovery preparation");
    const planCapability = signPlan(preparedPlan);
    child.stdin.end(`${JSON.stringify({ kind: "publish-exact-current-recovery", capability: planCapability })}\n`);
    const mutation = await nextLine("exact-current recovery publication");
    const extra = await lines.next();
    if (!extra.done) throw new Error("unprivileged lifecycle interactive worker returned extra output");
    const outcome = await exited;
    if (outcome.status !== 0) throw new Error(String(stderr || `unprivileged lifecycle interactive worker exited ${outcome.status ?? outcome.signal}`).trim());
    return mutation;
  } catch (error) {
    child.kill("SIGKILL");
    await exited.catch(() => undefined);
    if (stderr) throw new Error(stderr.trim(), { cause: error });
    throw error;
  }
}
async function processRootOperation(envelope) {
  const authorizationPath = path.resolve(envelope.request.authorization_file);
  // Authenticate and bind before consulting durable state. Expiry is a live
  // permission check, not a reason to lose an exact completed/prepared recovery.
  const authorization = verifyAuthorization(authorizationPath, { requireCurrentExpiry: false });
  const identity = operationIdentity(envelope, authorization);
  if (authorization.operation !== envelope.action || authorization.run_id !== identity.runId) throw new Error("authorization does not bind the requested operation and run");
  if (envelope.action === "reseal-verification-evidence") {
    assertVerificationResealAtomicReplaceCapabilityArtifact();
    const caller = callerIdentity();
    const preflight = childInvocation({
      kind: "preflight-reseal",
      capability: signedCapability("preflight-reseal-capability", { request: envelope.request }),
    }, caller);
    if (!record(preflight) || preflight.run_id !== identity.runId || preflight.available !== true) {
      throw new Error("unprivileged verification reseal capability preflight returned an invalid response");
    }
  }
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
      if (["resolve-critique", "repair-critique-resolution-history", "reseal-verification-evidence", "recover-exact-current-completion", "publish-provisional-delivery"].includes(envelope.action)) childInvocation({ kind: "receipt", capability: signedCapability("receipt-capability", { request: envelope.request, completion: completionRecord }) }, caller);
      if (envelope.action === "reseal-verification-evidence") childInvocation({ kind: "finalize-reseal", capability: signedCapability("finalize-reseal-capability", { request: envelope.request, completion: completionRecord }) }, caller);
      if (envelope.action === "recover-exact-current-completion") childInvocation({ kind: "finalize-exact-current-recovery", capability: signedCapability("finalize-exact-current-recovery-capability", { request: envelope.request, completion: completionRecord }) }, caller);
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
      if (envelope.action === "recover-exact-current-completion") assertExactCurrentRecoveryTimeWindow(authorization);
      // Reject a stale or mismatched live holder before creating any durable
      // nonce state. A prepared nonce is intentionally exempt: it may be
      // recovering a cancel whose child mutation already completed, and the
      // child rechecks/reconciles that exact CAS state below.
      if (envelope.action === "cancel") {
        assertLiveAssignmentHolder(canonicalMutationPaths(envelope.request), authorization);
      }
      if (envelope.action === "repair-critique-resolution-history") verifiedBridge = verifyRootHistoricalBridge(canonicalMutationPaths(envelope.request), authorization);
      if (envelope.action === "recover-exact-current-completion") await assertExactCurrentCompletionRecoveryPreimages(canonicalMutationPaths(envelope.request), authorization, envelope);
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
    if (envelope.action === "recover-exact-current-completion" && !resumePrepared) await assertExactCurrentCompletionRecoveryPreimages(canonicalMutationPaths(envelope.request), authorization, envelope);
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
          mutation = await interactiveResealInvocation({
            kind: "prepare-publish-reseal",
            capability: signedCapability("prepare-reseal-capability", { envelope, authorization }),
          }, caller, (preparedPlan) => {
            if (!record(preparedPlan) || preparedPlan.run_id !== identity.runId || !record(preparedPlan.plan)) throw new Error("unprivileged verification reseal preparation returned an invalid plan");
            const plan = validateVerificationResealPlan(preparedPlan.plan);
            if (plan.request_sha256 !== envelope.request_sha256 || plan.authorization_sha256 !== authorizationSha256
                || plan.authorization_key_id !== identity.keyId || plan.authorization_nonce !== identity.nonce || plan.run_id !== identity.runId) {
              throw new Error("verification reseal plan does not bind the root-authenticated operation");
            }
            return signedCapability("reseal-plan-capability", { request: envelope.request, plan });
          });
        } else {
          mutation = childInvocation({ kind: "publish-reseal", capability: planCapability }, caller);
        }
      }
    } else if (envelope.action === "recover-exact-current-completion") {
      let recovery = null;
      if (resumePrepared) {
        recovery = childInvocation({
          kind: "recover-exact-current-recovery",
          capability: signedCapability("recover-exact-current-recovery-capability", { request: envelope.request, binding: transactionBinding }),
        }, caller);
        if (!record(recovery) || recovery.run_id !== identity.runId || !["none", "new"].includes(recovery.state)) {
          throw new Error("unprivileged exact-current recovery publication recovery returned an invalid response");
        }
      }
      if (recovery?.state === "new") mutation = recovery;
      else {
        mutation = await interactiveExactCurrentRecoveryInvocation({
          kind: "prepare-publish-exact-current-recovery",
          capability: signedCapability("prepare-exact-current-recovery-capability", { envelope, authorization }),
        }, caller, (preparedPlan) => {
          if (!record(preparedPlan) || preparedPlan.run_id !== identity.runId || !record(preparedPlan.plan)) {
            throw new Error("unprivileged exact-current recovery preparation returned an invalid plan");
          }
          const plan = validateExactCurrentRecoveryPlan(preparedPlan.plan);
          if (plan.request_sha256 !== envelope.request_sha256 || plan.authorization_sha256 !== authorizationSha256
              || plan.authorization_key_id !== identity.keyId || plan.authorization_nonce !== identity.nonce || plan.run_id !== identity.runId) {
            throw new Error("exact-current recovery plan does not bind the root-authenticated operation");
          }
          return signedCapability("exact-current-recovery-plan-capability", { request: envelope.request, plan });
        });
      }
    } else {
      mutation = childInvocation({ kind: "mutate", capability: signedCapability("mutation-capability", { envelope, authorization, resume_prepared: resumePrepared, ...(verifiedBridge ? { verified_bridge: verifiedBridge } : {}) }) }, caller);
    }
    const generationBound = GENERATION_BOUND_ACTIONS.has(envelope.action);
    if (!record(mutation) || mutation.run_id !== identity.runId || typeof mutation.result_core_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(mutation.result_core_sha256)
        || (generationBound && !FLOW_RECOVERY_GENERATION.test(String(mutation.recovery_generation)))) throw new Error("unprivileged lifecycle mutation worker result is invalid");
    const completionRecord = completion(envelope, { runId: identity.runId }, "applied", mutation.result_core_sha256, generationBound ? mutation.recovery_generation : null);
    atomicWrite(completionFile, `${JSON.stringify({ authorization_sha256: authorizationSha256, request_sha256: envelope.request_sha256, result_core_sha256: mutation.result_core_sha256, completion: completionRecord })}\n`);
    atomicWrite(nonceFile, `${JSON.stringify(appliedNonceRecord(prepared, mutation.result_core_sha256))}\n`);
    // The root process has already returned to a root-owned boundary. A second
    // unprivileged invocation installs a receipt only where that receipt is a
    // verification-gate input; archive moves the session and has no receipt path.
    if (["resolve-critique", "repair-critique-resolution-history", "reseal-verification-evidence", "recover-exact-current-completion", "publish-provisional-delivery"].includes(envelope.action)) childInvocation({ kind: "receipt", capability: signedCapability("receipt-capability", { request: envelope.request, completion: completionRecord }) }, caller);
    if (envelope.action === "reseal-verification-evidence") childInvocation({ kind: "finalize-reseal", capability: signedCapability("finalize-reseal-capability", { request: envelope.request, completion: completionRecord }) }, caller);
    if (envelope.action === "recover-exact-current-completion") childInvocation({ kind: "finalize-exact-current-recovery", capability: signedCapability("finalize-exact-current-recovery-capability", { request: envelope.request, completion: completionRecord }) }, caller);
    return { completionRecord, replayed: false };
  });
}
function response(envelope, outcome) {
  return { schema_version: PROTOCOL_VERSION, action: envelope.action, request_sha256: envelope.request_sha256, status: "accepted", result: { run_id: outcome.completionRecord.run_id, operation_status: outcome.replayed ? "replayed" : "applied", completion: outcome.completionRecord } };
}
function provisionalReceiptEventIndex(events, paths, completion, label) {
  const index = events.findIndex((event) =>
    record(event) && event.run_id === paths.runId && sha256(event) === completion.result_core_sha256);
  if (index < 0) throw new Error(label);
  return index;
}
function installProvisionalCompletionReceipt(paths, candidate, atomicHooks) {
  const verifiedCandidate = assertCurrentLifecycleCompletionIdentity(paths, candidate);
  const events = loadProvisionalDeliveryLedger(paths).value.events;
  const candidateIndex = provisionalReceiptEventIndex(
    events, paths, verifiedCandidate,
    "provisional delivery completion does not bind a validated durable authority event",
  );
  const tailIndex = events.length - 1;
  const receiptFile = path.join(paths.sessionDir, "provisional-delivery.authority-completion.json");
  if (!fs.existsSync(receiptFile)) {
    if (candidateIndex !== tailIndex) throw new Error("provisional delivery completion cannot install without binding the current validated ledger tail");
    atomicWrite(receiptFile, `${JSON.stringify(verifiedCandidate, null, 2)}\n`, 0o644, atomicHooks);
    return { run_id: paths.runId, receipt: "written" };
  }
  const existing = assertCurrentLifecycleCompletionIdentity(
    paths,
    protectedJson(receiptFile, "provisional delivery authority completion", 256 * 1024),
  );
  const existingIndex = provisionalReceiptEventIndex(
    events, paths, existing,
    "provisional delivery authority completion conflicts with the validated ledger",
  );
  if (canonicalJson(existing) === canonicalJson(verifiedCandidate)) return { run_id: paths.runId, receipt: "present" };
  if (candidateIndex !== tailIndex) {
    if (existingIndex === tailIndex) return { run_id: paths.runId, receipt: "preserved" };
    throw new Error("provisional delivery completion cannot replace a receipt without binding the current validated ledger tail");
  }
  atomicWrite(receiptFile, `${JSON.stringify(verifiedCandidate, null, 2)}\n`, 0o644, atomicHooks);
  return { run_id: paths.runId, receipt: "replaced" };
}
function installResolutionCompletionReceipt(paths, candidate) {
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
function installCompletionReceipt(paths, candidate, atomicHooks = null) {
  return candidate?.action === "publish-provisional-delivery"
    ? installProvisionalCompletionReceipt(paths, candidate, atomicHooks)
    : installResolutionCompletionReceipt(paths, candidate);
}
async function interactiveResealWorker() {
  if (!CHILD_MODE || process.env.FLOW_AGENTS_LIFECYCLE_INTERACTIVE_RESEAL !== "1") {
    throw new Error("interactive verification reseal worker is unavailable");
  }
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
  const first = await lines.next();
  if (first.done || typeof first.value !== "string" || !first.value) throw new Error("interactive verification reseal worker requires one preparation request");
  const payload = JSON.parse(first.value);
  if (!record(payload) || payload.kind !== "prepare-publish-reseal") throw new Error("interactive verification reseal worker request is invalid");
  const value = verifiedCapability(payload.capability, "prepare-reseal-capability");
  if (!record(value.envelope) || !record(value.authorization)) throw new Error("verification reseal preparation request is invalid");
  const envelope = validateEnvelope(value.envelope);
  if (envelope.action !== "reseal-verification-evidence" || value.authorization.operation !== envelope.action) throw new Error("verification reseal preparation operation is invalid");
  const paths = canonicalMutationPaths(envelope.request);
  return withCoordinatorAssignmentLock(paths, () => withCanonicalFlowRunMutationLock(paths, async () => {
    const prepared = await prepareVerificationResealTransaction(envelope, paths, value.authorization, { lockHeld: true });
    process.stdout.write(`${JSON.stringify(prepared)}\n`);
    const second = await lines.next();
    if (second.done || typeof second.value !== "string" || !second.value) throw new Error("interactive verification reseal worker requires one signed publication request");
    const publication = JSON.parse(second.value);
    if (!record(publication) || publication.kind !== "publish-reseal" || !record(publication.capability)) {
      throw new Error("interactive verification reseal publication request is invalid");
    }
    const extra = await lines.next();
    if (!extra.done) throw new Error("interactive verification reseal worker received extra input");
    const mutation = await publishVerificationResealTransaction(paths, publication.capability, {
      request_sha256: prepared.plan.request_sha256,
      authorization_sha256: prepared.plan.authorization_sha256,
    }, { lockHeld: true });
    process.stdout.write(`${JSON.stringify(mutation)}\n`);
  }));
}
async function interactiveExactCurrentRecoveryWorker() {
  if (!CHILD_MODE || process.env.FLOW_AGENTS_LIFECYCLE_INTERACTIVE_EXACT_CURRENT_RECOVERY !== "1") {
    throw new Error("interactive exact-current recovery worker is unavailable");
  }
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
  const first = await lines.next();
  if (first.done || typeof first.value !== "string" || !first.value) throw new Error("interactive exact-current recovery worker requires one preparation request");
  const payload = JSON.parse(first.value);
  if (!record(payload) || payload.kind !== "prepare-publish-exact-current-recovery") throw new Error("interactive exact-current recovery worker request is invalid");
  const value = verifiedCapability(payload.capability, "prepare-exact-current-recovery-capability");
  if (!record(value.envelope) || !record(value.authorization)) throw new Error("exact-current recovery preparation request is invalid");
  const envelope = validateEnvelope(value.envelope);
  if (envelope.action !== "recover-exact-current-completion" || value.authorization.operation !== envelope.action) {
    throw new Error("exact-current recovery preparation operation is invalid");
  }
  const paths = canonicalMutationPaths(envelope.request);
  return withCoordinatorAssignmentLock(paths, () => withCanonicalFlowRunMutationLock(paths, async () => {
    const prepared = await prepareExactCurrentRecoveryPublication(envelope, paths, value.authorization, { lockHeld: true });
    process.stdout.write(`${JSON.stringify(prepared)}\n`);
    const second = await lines.next();
    if (second.done || typeof second.value !== "string" || !second.value) throw new Error("interactive exact-current recovery worker requires one signed publication request");
    const publication = JSON.parse(second.value);
    if (!record(publication) || publication.kind !== "publish-exact-current-recovery" || !record(publication.capability)) {
      throw new Error("interactive exact-current recovery publication request is invalid");
    }
    const extra = await lines.next();
    if (!extra.done) throw new Error("interactive exact-current recovery worker received extra input");
    const mutation = await publishExactCurrentRecoveryPublication(paths, publication.capability, {
      request_sha256: prepared.plan.request_sha256,
      authorization_sha256: prepared.plan.authorization_sha256,
    }, { lockHeld: true });
    process.stdout.write(`${JSON.stringify(mutation)}\n`);
  }));
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
    if (payload.kind === "publish-exact-current-recovery") {
      const value = verifiedCapability(payload.capability, "exact-current-recovery-plan-capability");
      if (!record(value.request) || !record(value.plan)) throw new Error("exact-current recovery publication request is invalid");
      const envelope = validateEnvelope({ schema_version: PROTOCOL_VERSION, action: value.request.action, request_sha256: value.plan.request_sha256, request: value.request });
      if (envelope.action !== "recover-exact-current-completion") throw new Error("exact-current recovery publication operation is invalid");
      return publishExactCurrentRecoveryPublication(canonicalMutationPaths(value.request), payload.capability, {
        request_sha256: value.plan.request_sha256,
        authorization_sha256: value.plan.authorization_sha256,
      });
    }
    if (payload.kind === "recover-exact-current-recovery") {
      const value = verifiedCapability(payload.capability, "recover-exact-current-recovery-capability");
      if (!record(value.request) || !record(value.binding)) throw new Error("exact-current recovery publication recovery request is invalid");
      exact(value.binding, ["request_sha256", "authorization_sha256"], "exact-current recovery publication recovery binding");
      const envelope = validateEnvelope({ schema_version: PROTOCOL_VERSION, action: value.request.action, request_sha256: value.binding.request_sha256, request: value.request });
      if (envelope.action !== "recover-exact-current-completion") throw new Error("exact-current recovery publication recovery operation is invalid");
      return recoverExactCurrentRecoveryPublication(canonicalMutationPaths(value.request), value.binding);
    }
    if (payload.kind === "finalize-exact-current-recovery") {
      const value = verifiedCapability(payload.capability, "finalize-exact-current-recovery-capability");
      if (!record(value.request) || !record(value.completion)) throw new Error("exact-current recovery finalization request is invalid");
      const paths = canonicalMutationPaths(value.request);
      return finalizeExactCurrentRecoveryPublication(paths, assertCurrentLifecycleCompletionIdentity(paths, value.completion));
    }
    if (payload.kind === "rollback") {
      const value = verifiedCapability(payload.capability, "rollback-capability");
      if (!record(value.request) || !record(value.binding)) throw new Error("mutation worker rollback request is invalid");
      exact(value.binding, ["request_sha256", "authorization_sha256"], "mutation worker rollback binding");
      const envelope = validateEnvelope({ schema_version: PROTOCOL_VERSION, action: value.request.action, request_sha256: value.binding.request_sha256, request: value.request });
      if (value.binding.request_sha256 !== sha256(envelope.request) || !/^[a-f0-9]{64}$/.test(String(value.binding.authorization_sha256))) throw new Error("mutation worker rollback binding is invalid");
      const paths = canonicalMutationPaths(value.request);
      if (value.request.action === "reseal-verification-evidence") throw new Error("verification reseal rejects legacy recursive rollback");
      const rolledBack = await recoverMatchingTransactionWithCanonicalFlowLock(paths, value.binding);
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
    return executeMutation(envelope, paths, value.authorization, null, value.verified_bridge ?? null, value.resume_prepared);
  }
  const lines = input.split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) throw new Error("coordinator requires exactly one JSON request line");
  const envelope = validateEnvelope(JSON.parse(lines[0]));
  return response(envelope, await processRootOperation(envelope));
}
if (path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    if (process.env.FLOW_AGENTS_LIFECYCLE_INTERACTIVE_RESEAL === "1") await interactiveResealWorker();
    else if (process.env.FLOW_AGENTS_LIFECYCLE_INTERACTIVE_EXACT_CURRENT_RECOVERY === "1") await interactiveExactCurrentRecoveryWorker();
    else process.stdout.write(`${JSON.stringify(await main())}\n`);
  }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
