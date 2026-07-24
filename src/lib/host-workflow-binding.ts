import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { containsSensitiveCredential } from "../run-correlation.js";

export interface HostWorkflowBindingInput {
  /** Absolute `.kontourai/flow-agents` artifact root owned by the host workspace. */
  artifactRoot: string;
  /** Absolute directory of the task being bound. It must be inside `artifactRoot`. */
  artifactDir: string;
  /** Stable host/session actor key using `[A-Za-z0-9_.-]` (maximum 64 characters). */
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
}

const ACTOR_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
const CANONICAL_ACTOR_KEY = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$/;
const BINDING_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$/;
type DirectoryIdentity = { dev: number; ino: number };
type HostPaths = {
  artifactRoot: string;
  artifactDir: string;
  relativeDir: string;
  rootIdentity: DirectoryIdentity;
  taskIdentity: DirectoryIdentity;
};

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
  const actorKey = requiredText(input.actorKey, "actorKey");
  if (!ACTOR_KEY.test(actorKey) || actorKey.toLowerCase() === "local") {
    throw new TypeError(
      "actorKey must be 1-64 characters from [A-Za-z0-9_.-] and must not be 'local'",
    );
  }

  const branch = readTaskBranch(paths);
  const payload: HostWorkflowBinding = {
    schema_version: "1.0",
    active_slug: path.basename(paths.artifactDir),
    artifact_dir: paths.relativeDir,
    updated_at: validatedTimestamp(input.updatedAt),
    owner: publicMetadata(input.owner, "owner"),
    source: publicMetadata(input.source, "source"),
    active_agents: [],
    binding_id: input.bindingId
      ? validatedBindingId(input.bindingId)
      : `binding-${randomUUID()}`,
    ...(branch ? { branch } : {}),
    ...(input.activeFlowId
      ? { active_flow_id: publicIdentifier(input.activeFlowId, "activeFlowId") }
      : {}),
    ...(input.activeStepId
      ? { active_step_id: publicIdentifier(input.activeStepId, "activeStepId") }
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
  const actorKey = requiredText(input.actorKey, "actorKey");
  if (!CANONICAL_ACTOR_KEY.test(actorKey) || actorKey.toLowerCase() === "local") {
    throw new TypeError(
      "actorKey must be a bounded canonical actor key and must not be 'local'",
    );
  }
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
