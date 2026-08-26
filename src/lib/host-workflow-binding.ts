import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { containsSensitiveCredential } from "../run-correlation.js";
import type { ActorStruct } from "../cli/assignment-provider.js";

/** Exact, one-preimage authority for an ordinary workflow-evidence mutation. */
export interface HostWorkflowAuthority {
  schema_version: "1.0";
  operation: "authorize-workflow-evidence";
  project_root: string;
  run_id: string;
  subject: string;
  assignment_generation: string;
  /** Canonical key on the active implementation assignment. */
  actor_key: string;
  /** Exact actor struct on the active implementation assignment. */
  actor: ActorStruct;
  /** Host/session key that owns the routing binding. May differ from actor_key. */
  binding_actor_key: string;
  binding_id: string;
  binding_sha256: string;
  flow_run_head: string;
  flow_manifest_sha256: string;
  trust_bundle_sha256: string;
  evidence_request_sha256: string;
  nonce: string;
  issued_at: string;
  expires_at: string;
  signature: { algorithm: "ed25519"; key_id: string; value: string };
}

export interface HostWorkflowBindingInput {
  /** Absolute `.kontourai/flow-agents` artifact root owned by the host workspace. */
  artifactRoot: string;
  /** Absolute directory of the task being bound. It must be inside `artifactRoot`. */
  artifactDir: string;
  /**
   * Canonical host/session actor key. Host routing accepts the reversible
   * runtime form (including `:` and `@`, maximum 255 characters); ordinary
   * user-selected actor keys retain their separate 64-character contract.
   */
  actorKey: string;
  /** Public identifier for the embedding host. */
  owner: string;
  /** Host lifecycle event that established or refreshed the binding. */
  source: string;
  updatedAt?: string;
  activeFlowId?: string;
  activeStepId?: string;
  /** Unique generation returned to the host and required for retirement. */
  bindingId?: string;
  /**
   * The exact assignment actor struct for recovery-capable bindings. The host
   * must obtain this from the assignment it is resuming; it is not derived
   * from `actorKey`.
   */
  actor?: ActorStruct;
  /**
   * Expiry for a recovery-capable binding. Hosts must refresh the binding
   * while their session remains active rather than creating an indefinite
   * local recovery capability.
   */
  expiresAt?: string;
}

export interface HostWorkflowBinding {
  schema_version: "1.0";
  active_slug: string;
  artifact_dir: string;
  updated_at: string;
  owner: string;
  source: string;
  active_agents: unknown[];
  branch?: string;
  active_flow_id?: string;
  active_step_id?: string;
  binding_id: string;
  binding_status?: "retired";
  binding_reason?: string;
  actor_key?: string;
  actor?: ActorStruct;
  expires_at?: string;
}

export interface RecoverHostWorkflowSessionActorInput {
  /** Absolute `.kontourai/flow-agents` artifact root containing the binding. */
  artifactRoot: string;
  /** Absolute directory of the session attempting a workflow mutation. */
  artifactDir: string;
  /** The caller's currently resolved canonical actor key. */
  actorKey: string;
  /** The active assignment actor that the recovery binding must exactly match. */
  assignmentActor: ActorStruct;
  /** Exact assignment generation accepted under the subject assignment lock. */
  assignmentSnapshot: {
    file: string;
    identity: DirectoryIdentity;
    rawSha256: string;
  };
}

export interface HostWorkflowRecoveryCapability {
  actorKey: string;
  actor: ActorStruct;
  bindingId: string;
  expiresAt: string;
  pointerFile: string;
  pointerIdentity: DirectoryIdentity;
  pointerDigest: string;
}

export interface RetireHostWorkflowBindingInput {
  artifactRoot: string;
  artifactDir: string;
  actorKey: string;
  bindingId: string;
  reason: string;
  updatedAt?: string;
}

interface CurrentPointerHelper {
  writePerActorCurrent(
    artifactRoot: string,
    actorKey: string,
    payload: HostWorkflowBinding,
    validate?: () => void,
  ): void;
  retireOwnCurrentPointer(
    artifactRoot: string,
    actorKey: string,
    activeSlug: string,
    bindingId: string,
    reason: string,
    updatedAt: string,
    validate?: () => void,
  ): "retired" | "not-bound" | "changed";
  readOwnCurrentPointerSnapshot(
    artifactRoot: string,
    actorKey: string,
  ): {
    payload: unknown | null;
    source: "per-actor" | "none";
    file: string | null;
    identity: DirectoryIdentity | null;
    rawSha256: string | null;
  };
  withActorCurrentPointerLockAsync(
    artifactRoot: string,
    actorKey: string,
    body: () => Promise<unknown>,
  ): Promise<unknown>;
}

const CANONICAL_ACTOR_KEY = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$/;
const BINDING_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$/;
const MAX_RECOVERY_TTL_MS = 60 * 60_000;
const MAX_UPDATED_AT_FUTURE_SKEW_MS = 5 * 60_000;
export type DirectoryIdentity = { dev: number; ino: number };
type HostPaths = {
  artifactRoot: string;
  artifactDir: string;
  relativeDir: string;
  rootIdentity: DirectoryIdentity;
  taskIdentity: DirectoryIdentity;
  projectRoot: string;
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Exact production signing payload accepted by the lifecycle coordinator. */
export function hostWorkflowAuthorityPayload(value: Omit<HostWorkflowAuthority, "signature">): string {
  return canonicalJson(value);
}

export function buildUnsignedHostWorkflowAuthority(
  fields: Omit<HostWorkflowAuthority, "schema_version" | "operation" | "signature">,
): { unsigned: Omit<HostWorkflowAuthority, "signature">; signingPayload: string } {
  const unsigned = { schema_version: "1.0", operation: "authorize-workflow-evidence", ...fields } as const;
  return { unsigned, signingPayload: hostWorkflowAuthorityPayload(unsigned) };
}

export function validateHostWorkflowAuthority(
  value: unknown,
  expected: Omit<HostWorkflowAuthority, "schema_version" | "operation" | "nonce" | "issued_at" | "expires_at" | "signature">,
): HostWorkflowAuthority {
  if (!isRecord(value)) throw new Error("host workflow authority must be an object");
  const fields = [
    "schema_version", "operation", "project_root", "run_id", "subject",
    "assignment_generation", "actor_key", "actor", "binding_actor_key", "binding_id", "binding_sha256",
    "flow_run_head", "flow_manifest_sha256", "trust_bundle_sha256", "evidence_request_sha256",
    "nonce", "issued_at", "expires_at", "signature",
  ];
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson(fields.sort())) {
    throw new Error("host workflow authority contains unexpected or missing fields");
  }
  if (value.schema_version !== "1.0" || value.operation !== "authorize-workflow-evidence") {
    throw new Error("host workflow authority identity is invalid");
  }
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (canonicalJson(value[field]) !== canonicalJson(expectedValue)) {
      throw new Error(`host workflow authority ${field} does not match the current evidence preimage`);
    }
  }
  for (const field of ["assignment_generation", "binding_sha256", "flow_run_head", "flow_manifest_sha256", "trust_bundle_sha256", "evidence_request_sha256"]) {
    if (!/^[a-f0-9]{64}$/.test(String(value[field]))) throw new Error(`host workflow authority ${field} is invalid`);
  }
  if (typeof value.nonce !== "string" || !/^[A-Za-z0-9._:@-]{16,255}$/.test(value.nonce)) throw new Error("host workflow authority nonce is invalid");
  const issuedAt = validatedTimestamp(String(value.issued_at));
  const expiresAt = validatedTimestamp(String(value.expires_at));
  const now = Date.now();
  if (Date.parse(expiresAt) < Date.parse(issuedAt) || Date.parse(issuedAt) > now + MAX_UPDATED_AT_FUTURE_SKEW_MS || now > Date.parse(expiresAt)) {
    throw new Error("host workflow authority time window is invalid or expired");
  }
  if (!isRecord(value.signature)
      || value.signature.algorithm !== "ed25519"
      || typeof value.signature.key_id !== "string"
      || typeof value.signature.value !== "string") throw new Error("host workflow authority signature is invalid");
  return value as unknown as HostWorkflowAuthority;
}

function currentPointerHelper(): CurrentPointerHelper {
  const require = createRequire(import.meta.url);
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  return require(
    path.join(packageRoot, "scripts", "hooks", "lib", "current-pointer.js"),
  ) as CurrentPointerHelper;
}

function requiredText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must be a non-empty string`);
  return normalized;
}

function validatedBindingId(value: string): string {
  const bindingId = requiredText(value, "bindingId");
  if (!BINDING_ID.test(bindingId) || containsSensitiveCredential(bindingId)) {
    throw new TypeError("bindingId must be a bounded, non-sensitive opaque identifier");
  }
  return bindingId;
}

function publicMetadata(value: string, name: string): string {
  const normalized = requiredText(value, name);
  if (
    normalized.length > 255
    || /[\u0000-\u001f\u007f]/.test(normalized)
    || /^(?:\/|[A-Za-z]:[\\/]|\\\\|[A-Za-z][A-Za-z0-9+.-]*:\/\/)/.test(normalized)
    || containsSensitiveCredential(normalized)
  ) {
    throw new TypeError(`${name} must be bounded public metadata without paths or credentials`);
  }
  return normalized;
}

function publicIdentifier(value: string, name: string): string {
  const normalized = publicMetadata(value, name);
  if (!BINDING_ID.test(normalized)) {
    throw new TypeError(`${name} must be a bounded public identifier`);
  }
  return normalized;
}

function validatedTimestamp(value?: string): string {
  if (value === undefined) return new Date().toISOString();
  const normalized = publicMetadata(value, "updatedAt");
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError("updatedAt must be a valid date-time");
  return parsed.toISOString();
}

function validateRecoveryWindow(updatedAt: string, expiresAt: string, context: string): void {
  const now = Date.now();
  const updatedAtMs = Date.parse(updatedAt);
  const expiresAtMs = Date.parse(expiresAt);
  if (updatedAtMs > now + MAX_UPDATED_AT_FUTURE_SKEW_MS) {
    throw new TypeError(`${context} updatedAt must not be more than 5 minutes in the future`);
  }
  if (expiresAtMs <= now) {
    throw new TypeError(`${context} expiresAt must still be active`);
  }
  if (expiresAtMs <= updatedAtMs) {
    throw new TypeError(`${context} expiresAt must be later than updatedAt`);
  }
  if (expiresAtMs - updatedAtMs > MAX_RECOVERY_TTL_MS) {
    throw new TypeError(`${context} must not exceed a 1 hour TTL`);
  }
}

function validatedCanonicalActorKey(value: string, name: string): string {
  const actorKey = requiredText(value, name);
  if (!CANONICAL_ACTOR_KEY.test(actorKey) || actorKey.toLowerCase() === "local") {
    throw new TypeError(`${name} must be a bounded canonical actor key and must not be 'local'`);
  }
  return actorKey;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validatedActorStruct(value: unknown, name: string): ActorStruct {
  if (!isRecord(value)) throw new TypeError(`${name} must be an actor object`);
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["host", "human", "runtime", "session_id"])) {
    throw new TypeError(`${name} must contain exactly runtime, session_id, host, and human`);
  }
  const { runtime, session_id: sessionId, host, human } = value;
  if (typeof runtime !== "string" || typeof sessionId !== "string" || typeof host !== "string") {
    throw new TypeError(`${name}.runtime, ${name}.session_id, and ${name}.host must be strings`);
  }
  if (human !== null && typeof human !== "string") {
    throw new TypeError(`${name}.human must be a string or null`);
  }
  for (const [field, fieldValue] of [[`${name}.runtime`, runtime], [`${name}.session_id`, sessionId], [`${name}.host`, host], [`${name}.human`, human]] as const) {
    if (typeof fieldValue === "string" && fieldValue.trim() !== fieldValue) {
      throw new TypeError(`${field} must not contain surrounding whitespace`);
    }
  }
  return {
    runtime: publicMetadata(runtime, `${name}.runtime`),
    session_id: publicMetadata(sessionId, `${name}.session_id`),
    host: publicMetadata(host, `${name}.host`),
    human: human === null ? null : publicMetadata(human, `${name}.human`),
  };
}

function sameActor(left: ActorStruct, right: ActorStruct): boolean {
  return left.runtime === right.runtime
    && left.session_id === right.session_id
    && left.host === right.host
    && (left.human ?? null) === (right.human ?? null);
}

function validatedBranch(value: string): string {
  const branch = publicMetadata(value, "branch");
  if (
    /\s|\\|\.\.|@\{|\/\/|^\//.test(branch)
    || branch.endsWith(".")
    || branch.endsWith("/")
    || branch.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
  ) {
    throw new TypeError("branch must be a bounded git-ref-shaped value");
  }
  return branch;
}

function directoryIdentity(directory: string, name: string): DirectoryIdentity {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new TypeError(`${name} must be a real directory`);
  }
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(left: fs.Stats, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertAssignmentSnapshot(
  paths: HostPaths,
  snapshot: RecoverHostWorkflowSessionActorInput["assignmentSnapshot"],
): void {
  const expectedFile = path.join(paths.artifactRoot, "assignment", `${path.basename(paths.artifactDir)}.json`);
  if (fs.realpathSync(snapshot.file) !== fs.realpathSync(expectedFile)) throw new Error("host workflow assignment snapshot path changed");
  const descriptor = fs.openSync(expectedFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(descriptor);
    const named = fs.lstatSync(expectedFile);
    const raw = fs.readFileSync(descriptor);
    if (!opened.isFile() || named.isSymbolicLink() || !named.isFile()
        || opened.dev !== named.dev || opened.ino !== named.ino
        || opened.dev !== snapshot.identity.dev || opened.ino !== snapshot.identity.ino
        || createHash("sha256").update(raw).digest("hex") !== snapshot.rawSha256) {
      throw new Error("host workflow assignment generation changed");
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function resolveHostPaths(rootInput: string, taskInput: string): HostPaths {
  if (!path.isAbsolute(rootInput) || !path.isAbsolute(taskInput)) {
    throw new TypeError("artifactRoot and artifactDir must be absolute paths");
  }
  const artifactRoot = fs.realpathSync(rootInput);
  const artifactDir = fs.realpathSync(taskInput);
  const relativeDir = path.relative(artifactRoot, artifactDir);
  if (
    relativeDir === "" || relativeDir === "." || relativeDir === ".."
    || relativeDir.startsWith(`..${path.sep}`) || path.isAbsolute(relativeDir)
  ) {
    throw new TypeError("artifactDir must identify a task directory inside artifactRoot");
  }
  return {
    artifactRoot,
    artifactDir,
    relativeDir,
    rootIdentity: directoryIdentity(artifactRoot, "artifactRoot"),
    taskIdentity: directoryIdentity(artifactDir, "artifactDir"),
    projectRoot: fs.realpathSync(path.dirname(path.dirname(artifactRoot))),
  };
}

function assertHostPaths(paths: HostPaths): void {
  const root = fs.lstatSync(paths.artifactRoot);
  const task = fs.lstatSync(paths.artifactDir);
  if (
    root.isSymbolicLink() || !root.isDirectory() || !sameIdentity(root, paths.rootIdentity)
    || task.isSymbolicLink() || !task.isDirectory() || !sameIdentity(task, paths.taskIdentity)
  ) {
    throw new Error("host workflow artifact directories changed during binding");
  }
}

function readTaskBranch(paths: HostPaths): string | null {
  const stateFile = path.join(paths.artifactDir, "state.json");
  let descriptor: number;
  try {
    descriptor = fs.openSync(stateFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const opened = fs.fstatSync(descriptor);
    const named = fs.lstatSync(stateFile);
    assertHostPaths(paths);
    if (
      !opened.isFile() || named.isSymbolicLink() || !named.isFile()
      || !sameIdentity(named, { dev: opened.dev, ino: opened.ino })
    ) {
      throw new Error("host workflow state changed during binding");
    }
    const state = JSON.parse(fs.readFileSync(descriptor, "utf8")) as { branch?: unknown };
    return typeof state.branch === "string" && state.branch ? validatedBranch(state.branch) : null;
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Bind an embedding host's stable actor to one active Flow Agents task.
 *
 * This is the public write-side companion to the actor-scoped resolution used
 * by Flow Agents hooks. It writes only `current/<actor>.json`; it deliberately
 * does not update the shared legacy `current.json`, claim assignment, or
 * create workflow state. Hosts remain responsible for their own lifecycle and
 * call this function whenever that lifecycle selects or resumes a task.
 */
export function bindHostWorkflowSession(
  input: HostWorkflowBindingInput,
): HostWorkflowBinding {
  const artifactRootInput = requiredText(input.artifactRoot, "artifactRoot");
  const artifactDirInput = requiredText(input.artifactDir, "artifactDir");
  const paths = resolveHostPaths(artifactRootInput, artifactDirInput);
  const actorKey = validatedCanonicalActorKey(input.actorKey, "actorKey");

  const branch = readTaskBranch(paths);
  const updatedAt = validatedTimestamp(input.updatedAt);
  const hasRecoveryActor = input.actor !== undefined;
  const hasExpiry = input.expiresAt !== undefined;
  if (hasRecoveryActor !== hasExpiry) {
    throw new TypeError("actor and expiresAt must be supplied together for a host recovery routing binding");
  }
  const actor = hasRecoveryActor ? validatedActorStruct(input.actor, "actor") : undefined;
  const expiresAt = hasExpiry ? validatedTimestamp(input.expiresAt) : undefined;
  const requestedBindingId = input.bindingId
    ? validatedBindingId(input.bindingId)
    : `binding-${randomUUID()}`;
  if (expiresAt) {
    validateRecoveryWindow(updatedAt, expiresAt, "recovery-capable host binding");
  }
  const payload: HostWorkflowBinding = {
    schema_version: "1.0",
    active_slug: path.basename(paths.artifactDir),
    artifact_dir: paths.relativeDir,
    updated_at: updatedAt,
    owner: publicMetadata(input.owner, "owner"),
    source: publicMetadata(input.source, "source"),
    active_agents: [],
    binding_id: requestedBindingId,
    ...(branch ? { branch } : {}),
    ...(input.activeFlowId
      ? { active_flow_id: publicIdentifier(input.activeFlowId, "activeFlowId") }
      : {}),
    ...(input.activeStepId
      ? { active_step_id: publicIdentifier(input.activeStepId, "activeStepId") }
      : {}),
    ...(actor && expiresAt
      ? { actor_key: actorKey, actor, expires_at: expiresAt }
      : {}),
  };

  assertHostPaths(paths);
  currentPointerHelper().writePerActorCurrent(
    paths.artifactRoot,
    actorKey,
    payload,
    () => assertHostPaths(paths),
  );
  return payload;
}

export function retireHostWorkflowSession(
  input: RetireHostWorkflowBindingInput,
): "retired" | "not-bound" | "changed" {
  const paths = resolveHostPaths(
    requiredText(input.artifactRoot, "artifactRoot"),
    requiredText(input.artifactDir, "artifactDir"),
  );
  const actorKey = validatedCanonicalActorKey(input.actorKey, "actorKey");
  assertHostPaths(paths);
  return currentPointerHelper().retireOwnCurrentPointer(
    paths.artifactRoot,
    actorKey,
    paths.relativeDir,
    validatedBindingId(input.bindingId),
    publicMetadata(input.reason, "reason"),
    validatedTimestamp(input.updatedAt),
    () => assertHostPaths(paths),
  );
}

/**
 * Return the assignment actor bound by this host for the caller's exact actor
 * key and task, or `null` when no recovery-capable binding exists. This is an
 * internal workflow-mutation recovery seam: it never scans other actors,
 * reads the shared legacy pointer, or derives a struct from a flat key.
 */
export function recoverHostWorkflowSessionActor(
  input: RecoverHostWorkflowSessionActorInput,
): HostWorkflowRecoveryCapability | null {
  return readHostWorkflowSessionActor(input);
}

function parseHostRecoveryBinding(paths: HostPaths, binding: Record<string, unknown>) {
  if (binding.schema_version !== "1.0"
      || binding.active_slug !== path.basename(paths.artifactDir)
      || binding.artifact_dir !== paths.relativeDir
      || binding.binding_status !== undefined) {
    throw new Error("host workflow recovery binding does not identify this active session");
  }
  if (typeof binding.updated_at !== "string" || typeof binding.owner !== "string"
      || typeof binding.source !== "string" || !Array.isArray(binding.active_agents)
      || typeof binding.binding_id !== "string") {
    throw new Error("host workflow recovery binding has an invalid canonical shape");
  }
  const updatedAt = validatedTimestamp(binding.updated_at);
  publicMetadata(binding.owner, "host workflow recovery owner");
  publicMetadata(binding.source, "host workflow recovery source");
  const bindingId = validatedBindingId(binding.binding_id);
  if (binding.branch !== undefined) {
    if (typeof binding.branch !== "string") throw new Error("host workflow recovery binding branch is invalid");
    validatedBranch(binding.branch);
  }
  if (binding.active_flow_id !== undefined) {
    if (typeof binding.active_flow_id !== "string") throw new Error("host workflow recovery binding active_flow_id is invalid");
    publicIdentifier(binding.active_flow_id, "host workflow recovery active_flow_id");
  }
  if (binding.active_step_id !== undefined) {
    if (typeof binding.active_step_id !== "string") throw new Error("host workflow recovery binding active_step_id is invalid");
    publicIdentifier(binding.active_step_id, "host workflow recovery active_step_id");
  }
  if (typeof binding.actor_key !== "string") throw new Error("host workflow recovery binding requires actor_key");
  if (typeof binding.expires_at !== "string") throw new Error("host workflow recovery binding requires expires_at");
  const actorKey = validatedCanonicalActorKey(binding.actor_key, "host workflow recovery actor_key");
  const actor = validatedActorStruct(binding.actor, "host workflow recovery actor");
  const expiresAt = validatedTimestamp(binding.expires_at);
  validateRecoveryWindow(updatedAt, expiresAt, "host workflow recovery binding");
  return { actorKey, actor, bindingId, expiresAt };
}

function assertExpectedHostBinding(
  current: ReturnType<typeof parseHostRecoveryBinding>,
  pointer: NonNullable<ReturnType<CurrentPointerHelper["readOwnCurrentPointerSnapshot"]>>,
  expected?: HostWorkflowRecoveryCapability,
): void {
  if (!expected) return;
  if (current.bindingId !== expected.bindingId || current.expiresAt !== expected.expiresAt
      || current.actorKey !== expected.actorKey || !sameActor(current.actor, expected.actor)
      || path.resolve(pointer.file!) !== path.resolve(expected.pointerFile)
      || pointer.identity!.dev !== expected.pointerIdentity.dev
      || pointer.identity!.ino !== expected.pointerIdentity.ino
      || pointer.rawSha256 !== expected.pointerDigest) {
    throw new Error("host workflow recovery binding generation changed before canonical mutation");
  }
}

function readHostWorkflowSessionActor(
  input: RecoverHostWorkflowSessionActorInput,
  expected?: HostWorkflowRecoveryCapability,
): HostWorkflowRecoveryCapability | null {
  const paths = resolveHostPaths(
    requiredText(input.artifactRoot, "artifactRoot"),
    requiredText(input.artifactDir, "artifactDir"),
  );
  const actorKey = validatedCanonicalActorKey(input.actorKey, "actorKey");
  const assignmentActor = validatedActorStruct(input.assignmentActor, "assignmentActor");
  assertAssignmentSnapshot(paths, input.assignmentSnapshot);
  assertHostPaths(paths);
  const pointer = currentPointerHelper().readOwnCurrentPointerSnapshot(paths.artifactRoot, actorKey);
  assertAssignmentSnapshot(paths, input.assignmentSnapshot);
  assertHostPaths(paths);
  if (
    pointer.source !== "per-actor"
    || !pointer.payload
    || !pointer.file
    || !pointer.identity
    || !pointer.rawSha256
  ) return null;
  if (!isRecord(pointer.payload)) {
    throw new Error("host workflow recovery binding must be an object");
  }
  const binding = pointer.payload;
  const hasRecoveryFields = Object.hasOwn(binding, "actor_key")
    || Object.hasOwn(binding, "actor")
    || Object.hasOwn(binding, "expires_at");
  if (!hasRecoveryFields) return null;
  const current = parseHostRecoveryBinding(paths, binding);
  if (current.actorKey !== actorKey || !sameActor(current.actor, assignmentActor)) {
    throw new Error("host workflow recovery binding does not match the active assignment actor pair");
  }
  assertExpectedHostBinding(current, pointer, expected);
  assertHostPaths(paths);
  return {
    actorKey: current.actorKey,
    actor: current.actor,
    bindingId: current.bindingId,
    expiresAt: current.expiresAt,
    pointerFile: pointer.file,
    pointerIdentity: pointer.identity,
    pointerDigest: pointer.rawSha256,
  };
}

/**
 * Revalidate and hold one exact host binding generation across the canonical
 * evidence mutation boundary. Callers must already hold the subject lock;
 * nested current-pointer publication reuses this asynchronously scoped lock.
 */
export async function withHostWorkflowSessionActorBinding<T>(
  input: RecoverHostWorkflowSessionActorInput,
  expected: HostWorkflowRecoveryCapability,
  body: (assertCurrent: () => void) => Promise<T>,
): Promise<T> {
  const helper = currentPointerHelper();
  return await helper.withActorCurrentPointerLockAsync(
    requiredText(input.artifactRoot, "artifactRoot"),
    validatedCanonicalActorKey(input.actorKey, "actorKey"),
    async () => {
      const current = readHostWorkflowSessionActor(input, expected);
      if (!current) throw new Error("host workflow recovery binding is no longer active");
      const assertCurrent = (): void => {
        const revalidated = readHostWorkflowSessionActor(input, expected);
        if (!revalidated) throw new Error("host workflow recovery binding is no longer active");
      };
      return await body(assertCurrent);
    },
  ) as T;
}
