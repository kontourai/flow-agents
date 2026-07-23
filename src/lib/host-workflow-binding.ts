import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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
}

interface CurrentPointerHelper {
  writePerActorCurrent(
    artifactRoot: string,
    actorKey: string,
    payload: HostWorkflowBinding,
  ): void;
}

const ACTOR_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

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
  if (!path.isAbsolute(artifactRootInput) || !path.isAbsolute(artifactDirInput)) {
    throw new TypeError("artifactRoot and artifactDir must be absolute paths");
  }
  const artifactRoot = fs.realpathSync(artifactRootInput);
  const artifactDir = fs.realpathSync(artifactDirInput);
  const relativeDir = path.relative(artifactRoot, artifactDir);
  if (
    relativeDir === "" ||
    relativeDir === "." ||
    relativeDir.startsWith(`..${path.sep}`) ||
    relativeDir === ".." ||
    path.isAbsolute(relativeDir)
  ) {
    throw new TypeError("artifactDir must identify a task directory inside artifactRoot");
  }

  const actorKey = requiredText(input.actorKey, "actorKey");
  if (!ACTOR_KEY.test(actorKey) || actorKey.toLowerCase() === "local") {
    throw new TypeError(
      "actorKey must be 1-64 characters from [A-Za-z0-9_.-] and must not be 'local'",
    );
  }

  const state = (() => {
    try {
      const stateFile = path.join(artifactDir, "state.json");
      if (fs.lstatSync(stateFile).isSymbolicLink()) return {};
      return JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
        branch?: unknown;
      };
    } catch {
      return {};
    }
  })();
  const payload: HostWorkflowBinding = {
    schema_version: "1.0",
    active_slug: path.basename(artifactDir),
    artifact_dir: relativeDir,
    updated_at: input.updatedAt ?? new Date().toISOString(),
    owner: requiredText(input.owner, "owner"),
    source: requiredText(input.source, "source"),
    active_agents: [],
    ...(typeof state.branch === "string" && state.branch
      ? { branch: state.branch }
      : {}),
    ...(input.activeFlowId
      ? { active_flow_id: requiredText(input.activeFlowId, "activeFlowId") }
      : {}),
    ...(input.activeStepId
      ? { active_step_id: requiredText(input.activeStepId, "activeStepId") }
      : {}),
  };

  currentPointerHelper().writePerActorCurrent(artifactRoot, actorKey, payload);
  return payload;
}
