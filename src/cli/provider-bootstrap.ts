import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { flagBool, flagString, parseArgs } from "../lib/args.js";
import { validateSchemaValue, type Issue } from "../lib/mini-json-schema.js";
import { githubWorkItemIdentity } from "../lib/work-item-identity.js";
import { renderGithubClaim, resolveCurrentAssignmentActor, type AssignmentRenderResult } from "./assignment-provider.js";

export type ProviderScope = "project" | "global";

export type ProviderBootstrapOptions = {
  scope: ProviderScope;
  repoPath: string;
  projectSettingsRoot?: string;
  globalSettingsRoot?: string;
  projectNumber?: number;
  online?: boolean;
  ghBin?: string;
  workItemRef?: string;
  providerLogin?: string;
  providerBranch?: string;
  artifactRoot?: string;
};

type Repo = { owner: string; name: string; url: string };
type Project = { number: number; title?: string; url?: string };
type ProviderPickupPreflight = {
  identity: ReturnType<typeof githubWorkItemIdentity>;
  branch: string;
  actor: ReturnType<typeof resolveCurrentAssignmentActor>;
  login?: string;
  requestedArtifactRoot: string;
};

export type ProviderPickupPlan = {
  schema_version: "1.0";
  role: "ProviderPickupPlan";
  work_item_ref: string;
  slug: string;
  artifact_root: string;
  session_dir: string;
  provider_branch: string;
  actor: ReturnType<typeof resolveCurrentAssignmentActor>;
  claim: AssignmentRenderResult;
  artifacts: {
    plan_file: string;
    actor_file: string;
    claim_input_file: string;
    issue_snapshot_file: string;
    liveness_events_file: string;
    effective_state_file: string;
  };
  operations: {
    claim: string[][];
    observe_issue: { argv: string[]; stdout_file: string };
    derive_effective_state: { argv: string[]; stdout_file: string };
    start_workflow: { argv: string[] };
  };
};

type PreparedProviderPickup = {
  plan: ProviderPickupPlan;
  claimInput: {
    repo: { owner: string; name: string };
    issue_number: number;
    assignee_login: string;
    label_name: string;
    claim_comment_marker: string;
    actor_key: string;
    work_item_ref: string;
    branch: string;
    artifact_dir: string;
  };
};

const SETTINGS = [
  ["backlog-provider-settings.json", "backlog-provider-settings.schema.json"],
  ["assignment-provider-settings.json", "assignment-provider-settings.schema.json"],
  ["change-provider-settings.json", "change-provider-settings.schema.json"],
] as const;

function schemaRoot(): string {
  let cursor = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = path.join(cursor, "schemas");
    if (fs.existsSync(path.join(candidate, "backlog-provider-settings.schema.json"))) return candidate;
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error("unable to locate Flow Agents provider schemas");
    cursor = parent;
  }
}

function parseRepoRemote(remote: string): Repo | null {
  const match = remote.trim().match(
    /^(?:(?:https:\/\/github\.com\/)|(?:ssh:\/\/git@github\.com\/)|(?:git@github\.com:))([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?$/u,
  );
  if (!match) return null;
  return { owner: match[1]!, name: match[2]!, url: `https://github.com/${match[1]}/${match[2]}` };
}

export function detectGitHubRepo(repoPath: string): Repo {
  let remote: string;
  try {
    remote = execFileSync("git", ["-C", repoPath, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    throw new Error(`cannot detect a GitHub repository from ${repoPath}; pass --provider-repo-path for a checkout with an origin remote`);
  }
  const repo = parseRepoRemote(remote);
  if (!repo) throw new Error("origin is not a supported github.com HTTPS or SSH remote");
  return repo;
}

function githubEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, GH_HOST: "github.com" };
}

function ghJson(ghBin: string, args: string[]): unknown {
  try {
    return JSON.parse(execFileSync(ghBin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: githubEnvironment() }));
  } catch {
    throw new Error(`GitHub provider discovery failed (${ghBin} ${args.join(" ")})`);
  }
}

function ensureGhAuth(ghBin: string): void {
  try {
    execFileSync(ghBin, ["auth", "status", "--hostname", "github.com"], { stdio: "ignore", env: githubEnvironment() });
  } catch {
    throw new Error(`GitHub CLI is not authenticated; run '${ghBin} auth login' and retry provider setup`);
  }
}

function currentGitBranch(repoPath: string): string {
  let branch: string;
  try {
    branch = execFileSync("git", ["-C", repoPath, "symbolic-ref", "--quiet", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error("provider pickup requires a named Git worktree branch; detached HEAD is not a safe assignment authority");
  }
  if (!branch || branch === "HEAD") throw new Error("provider pickup requires a named Git worktree branch");
  return branch;
}

function currentGitHubLogin(ghBin: string): string {
  const value = ghJson(ghBin, ["api", "user"]) as Record<string, unknown>;
  if (typeof value.login !== "string" || !value.login) throw new Error("GitHub provider discovery did not return the authenticated login");
  return value.login;
}

function writeJsonIfAbsentOrExact(file: string, value: unknown): void {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${file}: provider pickup artifact must be a regular file`);
    if (fs.readFileSync(file, "utf8") !== bytes) throw new Error(`${file}: existing provider pickup artifact does not match the exact canonical inputs`);
    return;
  }
  fs.writeFileSync(file, bytes, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

function assertJsonAbsentOrExact(file: string, value: unknown): void {
  if (!fs.existsSync(file)) return;
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${file}: provider pickup artifact must be a regular file`);
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  if (fs.readFileSync(file, "utf8") !== bytes) throw new Error(`${file}: existing provider pickup artifact does not match the exact canonical inputs`);
}

function preflightProviderPickup(options: ProviderBootstrapOptions, repo: Repo): ProviderPickupPreflight | null {
  if (!options.workItemRef) return null;
  const identity = githubWorkItemIdentity(options.workItemRef);
  if (identity.owner !== repo.owner || identity.name !== repo.name) {
    throw new Error(`Work Item ${options.workItemRef} does not belong to detected repository ${repo.owner}/${repo.name}`);
  }
  const branch = currentGitBranch(options.repoPath);
  if (options.providerBranch !== undefined && options.providerBranch !== branch) {
    throw new Error(`provider branch ${JSON.stringify(options.providerBranch)} does not match the actual Git worktree branch ${JSON.stringify(branch)}`);
  }
  const actor = resolveCurrentAssignmentActor();
  const requestedArtifactRoot = path.resolve(options.artifactRoot ?? path.join(options.repoPath, ".kontourai", "flow-agents"));
  const repository = path.resolve(options.repoPath);
  const canonicalArtifactRoot = path.join(repository, ".kontourai", "flow-agents");
  if (requestedArtifactRoot !== canonicalArtifactRoot) {
    throw new Error("provider pickup artifact root must be the canonical <repository>/.kontourai/flow-agents path");
  }
  const relative = path.relative(repository, requestedArtifactRoot);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("provider pickup artifact root must stay inside the repository");
  }
  let cursor = repository;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) break;
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`provider pickup artifact path contains a symbolic link: ${cursor}`);
  }
  const sessionDir = path.join(requestedArtifactRoot, identity.slug);
  if (fs.existsSync(sessionDir)) {
    const stat = fs.lstatSync(sessionDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("provider pickup session target must be a regular directory");
  }
  const existingPlan = path.join(sessionDir, "provider-pickup.json");
  if (fs.existsSync(existingPlan)) {
    const stat = fs.lstatSync(existingPlan);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${existingPlan}: provider pickup artifact must be a regular file`);
    const existing = JSON.parse(fs.readFileSync(existingPlan, "utf8")) as Partial<ProviderPickupPlan>;
    if (existing.role !== "ProviderPickupPlan"
        || existing.work_item_ref !== identity.ref
        || existing.provider_branch !== branch
        || existing.actor?.actorKey !== actor.actorKey
        || typeof existing.claim?.record?.claimed_at !== "string") {
      throw new Error("existing provider pickup plan does not match the current Work Item, branch, and actor");
    }
  }
  return { identity, branch, actor, login: options.providerLogin, requestedArtifactRoot };
}

function completeProviderPickupPreflight(options: ProviderBootstrapOptions, preflight: ProviderPickupPreflight | null): ProviderPickupPreflight | null {
  if (!preflight) return null;
  const login = preflight.login ?? (options.online ? currentGitHubLogin(options.ghBin ?? "gh") : undefined);
  if (!login) throw new Error("provider pickup requires --provider-login when --online is not enabled");
  return { ...preflight, login };
}

function providerPickupPlan(repo: Repo, preflight: ProviderPickupPreflight): PreparedProviderPickup {
  const { identity, branch, actor, login } = preflight;
  if (!login) throw new Error("provider pickup requires a resolved provider login");
  const artifactRoot = preflight.requestedArtifactRoot;
  const sessionDir = path.join(artifactRoot, identity.slug);
  const artifacts = {
    plan_file: path.join(sessionDir, "provider-pickup.json"),
    actor_file: path.join(sessionDir, "provider-pickup.actor.json"),
    claim_input_file: path.join(sessionDir, "provider-pickup.claim-input.json"),
    issue_snapshot_file: path.join(sessionDir, "provider-pickup.issue.json"),
    liveness_events_file: path.join(sessionDir, "provider-pickup.liveness.json"),
    effective_state_file: path.join(sessionDir, "provider-pickup.effective-state.json"),
  };
  const claimInput = {
    repo: { owner: repo.owner, name: repo.name },
    issue_number: identity.issueNumber,
    assignee_login: login,
    label_name: "agent:claimed",
    claim_comment_marker: "<!-- flow-agents:assignment-claim -->",
    actor_key: actor.actorKey,
    work_item_ref: identity.ref,
    branch,
    artifact_dir: `.kontourai/flow-agents/${identity.slug}`,
  };
  let claimedAt: string | undefined;
  if (fs.existsSync(artifacts.plan_file)) claimedAt = (JSON.parse(fs.readFileSync(artifacts.plan_file, "utf8")) as ProviderPickupPlan).claim.record.claimed_at;
  const claim = renderGithubClaim(identity.slug, claimInput, actor.actor, claimedAt);
  const flowAgents = "flow-agents";
  const plan: ProviderPickupPlan = {
    schema_version: "1.0",
    role: "ProviderPickupPlan",
    work_item_ref: identity.ref,
    slug: identity.slug,
    artifact_root: artifactRoot,
    session_dir: sessionDir,
    provider_branch: branch,
    actor,
    claim,
    artifacts,
    operations: {
      claim: claim.gh_commands,
      observe_issue: {
        argv: ["gh", "issue", "view", String(identity.issueNumber), "--repo", `${repo.owner}/${repo.name}`, "--json", "number,state,assignees,labels,comments"],
        stdout_file: artifacts.issue_snapshot_file,
      },
      derive_effective_state: {
        argv: [
          flowAgents, "assignment-provider", "status",
          "--provider", "github",
          "--repo", `${repo.owner}/${repo.name}`,
          "--issue-json", artifacts.issue_snapshot_file,
          "--subject-id", identity.slug,
          "--liveness-events-json", artifacts.liveness_events_file,
          "--self-actor", actor.actorKey,
        ],
        stdout_file: artifacts.effective_state_file,
      },
      start_workflow: {
        argv: [
          flowAgents, "workflow", "start",
          "--artifact-root", artifactRoot,
          "--flow", "builder.build",
          "--work-item", identity.ref,
          "--assignment-provider", "github",
          "--effective-state-json", artifacts.effective_state_file,
        ],
      },
    },
  };
  return { plan, claimInput };
}

function assertProviderPickupArtifactCompatibility(prepared: PreparedProviderPickup): void {
  const { plan, claimInput } = prepared;
  assertJsonAbsentOrExact(plan.artifacts.actor_file, plan.actor.actor);
  assertJsonAbsentOrExact(plan.artifacts.claim_input_file, claimInput);
  assertJsonAbsentOrExact(plan.artifacts.liveness_events_file, []);
  assertJsonAbsentOrExact(plan.artifacts.plan_file, plan);
}

function persistProviderPickup(prepared: PreparedProviderPickup | null): ProviderPickupPlan | null {
  if (!prepared) return null;
  const { plan, claimInput } = prepared;
  const { session_dir: sessionDir, artifacts } = plan;
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
  writeJsonIfAbsentOrExact(artifacts.actor_file, plan.actor.actor);
  writeJsonIfAbsentOrExact(artifacts.claim_input_file, claimInput);
  writeJsonIfAbsentOrExact(artifacts.liveness_events_file, []);
  writeJsonIfAbsentOrExact(artifacts.plan_file, plan);
  return plan;
}

export function prepareProviderPickup(options: ProviderBootstrapOptions, repo: Repo): ProviderPickupPlan | null {
  const preflight = completeProviderPickupPreflight(options, preflightProviderPickup(options, repo));
  const prepared = preflight ? providerPickupPlan(repo, preflight) : null;
  if (prepared) assertProviderPickupArtifactCompatibility(prepared);
  return persistProviderPickup(prepared);
}

function discoverProject(ghBin: string, owner: string, requested?: number): Project {
  const result = ghJson(ghBin, ["project", "list", "--owner", owner, "--limit", "100", "--format", "json"]) as { projects?: unknown };
  const projects = Array.isArray(result.projects)
    ? result.projects.flatMap((entry): Project[] => {
        if (!entry || typeof entry !== "object") return [];
        const value = entry as Record<string, unknown>;
        if (!Number.isInteger(value.number) || Number(value.number) < 1) return [];
        let url: string | undefined;
        if (typeof value.url === "string") {
          try {
            const parsed = new URL(value.url);
            if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") throw new Error();
            url = parsed.toString();
          } catch {
            throw new Error(`GitHub Project ${String(value.number)} returned a non-GitHub URL; refusing to persist it`);
          }
        }
        return [{ number: Number(value.number), title: typeof value.title === "string" ? value.title : undefined, url }];
      })
    : [];
  if (requested !== undefined) {
    const match = projects.find((project) => project.number === requested);
    if (!match) throw new Error(`GitHub Project ${owner}#${requested} was not found; run '${ghBin} project list --owner ${owner}' and choose an accessible project`);
    return match;
  }
  if (projects.length === 1) return projects[0]!;
  if (projects.length === 0) throw new Error(`no accessible GitHub Project was found for ${owner}; create one or retry with --provider-project NUMBER`);
  throw new Error(`multiple GitHub Projects are available for ${owner}; retry with --provider-project NUMBER`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function validateLabelName(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 50 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("assignment policy label_name must be 1-50 characters without control characters");
  }
  return value;
}

function ensureClaimLabel(ghBin: string, repo: Repo, labelName: string): void {
  const repository = `${repo.owner}/${repo.name}`;
  const labels = ghJson(ghBin, ["label", "list", "--repo", repository, `--search=${labelName}`, "--limit", "100", "--json", "name"]) as unknown[];
  const exists = Array.isArray(labels) && labels.some((label) => label && typeof label === "object" && (label as Record<string, unknown>).name === labelName);
  if (exists) return;
  try {
    execFileSync(ghBin, [
      "label", "create",
      "--repo", repository,
      "--color", "5319E7",
      "--description", "Work item currently claimed by an agent",
      "--", labelName,
    ], { stdio: "ignore", env: githubEnvironment() });
  } catch {
    throw new Error(`required label ${JSON.stringify(labelName)} is missing and could not be created; run ${shellQuote(ghBin)} label create --repo ${shellQuote(repository)} -- ${shellQuote(labelName)}`);
  }
}

function projectEntry(repo: Repo, project: Project): Record<string, unknown> {
  const repoRef = { owner: repo.owner, name: repo.name, url: repo.url };
  return {
    project: { repo: repoRef },
    work_item_provider: {
      role: "WorkItemProvider", kind: "github", repo: repoRef,
      capabilities: ["issues", "labels", "assignees", "pr_links", "comments"],
    },
    board_provider: {
      role: "BoardProvider", kind: "github", repo: repoRef,
      board: {
        type: "github_project", owner: repo.owner, number: project.number,
        ...(project.url ? { url: project.url } : {}),
      },
      capabilities: ["projects_boards", "status_fields", "custom_fields"],
    },
    selection: {
      filters: {
        issue_state: "open", include_labels: [], ready_statuses: ["ready"],
        exclude_statuses: ["triage", "in_progress", "blocked", "review", "verification", "done"],
      },
      wip_policy: {
        prefer_finishing_active_work: true,
        active_statuses: ["in_progress", "review", "verification"],
        block_new_work_when_active_count_exceeds: 0,
      },
    },
  };
}

function assignmentEntry(repo: Repo): Record<string, unknown> {
  const repoRef = { owner: repo.owner, name: repo.name, url: repo.url };
  return {
    project: { repo: repoRef },
    provider: { kind: "github", repo: repoRef, capabilities: ["assignees", "labels", "comments"] },
    policy: {
      label_name: "agent:claimed",
      claim_comment_marker: "<!-- flow-agents:assignment-claim -->",
      human_assignee_policy: { behavior: "ask_first", idle_threshold_days: 3 },
      comment_refresh_on_phase_transition: false,
    },
  };
}

function changeEntry(repo: Repo): Record<string, unknown> {
  return {
    project: { repo: { owner: repo.owner, name: repo.name } },
    provider: {
      role: "ChangeProvider", kind: "github",
      repository: { owner: repo.owner, name: repo.name },
      capabilities: ["change.create", "change.observe"], executor: "gh-cli",
    },
  };
}

function readDocument(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return { schema_version: "1.0", projects: [] };
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${file}: settings target must be a regular file; refusing to follow or replace it`);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  if (parsed.schema_version !== "1.0") throw new Error(`${file}: expected schema_version 1.0; refusing to overwrite`);
  if (parsed.projects !== undefined && !Array.isArray(parsed.projects)) throw new Error(`${file}: projects must be an array; refusing to overwrite`);
  return { ...parsed, projects: parsed.projects ?? [] };
}

function matchingRepo(candidate: unknown, repo: Repo): candidate is Record<string, unknown> {
  if (!candidate || typeof candidate !== "object") return false;
  const project = (candidate as Record<string, unknown>).project as Record<string, unknown> | undefined;
  const match = project?.repo as Record<string, unknown> | undefined;
  return match?.owner === repo.owner && match?.name === repo.name;
}

function matchingRootRepo(candidate: unknown, repo: Repo): candidate is Record<string, unknown> {
  if (!matchingRepo(candidate, repo)) return false;
  const project = candidate.project as Record<string, unknown>;
  return !Array.isArray(project.paths) || project.paths.length === 0;
}

function mergeProject(document: Record<string, unknown>, entry: Record<string, unknown>, repo: Repo, kind: typeof SETTINGS[number][0]): Record<string, unknown> {
  const projects = document.projects as unknown[];
  const existing = projects.find((candidate) => matchingRootRepo(candidate, repo));
  let merged = entry;
  if (existing) {
    if (kind === "backlog-provider-settings.json") {
      const prior = existing as Record<string, unknown>;
      const priorWorkItem = prior.work_item_provider as Record<string, unknown> | undefined;
      const priorBoard = prior.board_provider as Record<string, unknown> | undefined;
      merged = {
        ...entry,
        ...(prior.selection ? { selection: prior.selection } : {}),
        ...(prior.mutation_policy ? { mutation_policy: prior.mutation_policy } : {}),
        work_item_provider: {
          ...(entry.work_item_provider as Record<string, unknown>),
          ...(priorWorkItem?.capabilities ? { capabilities: priorWorkItem.capabilities } : {}),
        },
        board_provider: {
          ...(entry.board_provider as Record<string, unknown>),
          ...(priorBoard?.capabilities ? { capabilities: priorBoard.capabilities } : {}),
        },
      };
    } else if (kind === "assignment-provider-settings.json") {
      const prior = existing as Record<string, unknown>;
      const priorProvider = prior.provider as Record<string, unknown> | undefined;
      merged = {
        ...entry,
        ...(prior.policy ? { policy: prior.policy } : {}),
        provider: {
          ...(entry.provider as Record<string, unknown>),
          ...(priorProvider?.capabilities ? { capabilities: priorProvider.capabilities } : {}),
        },
      };
    }
  }
  return { ...document, projects: [merged, ...projects.filter((candidate) => !matchingRootRepo(candidate, repo))] };
}

function validateDocument(file: string, schemaFile: string, document: Record<string, unknown>): void {
  const schema = JSON.parse(fs.readFileSync(path.join(schemaRoot(), schemaFile), "utf8"));
  const issues: Issue[] = [];
  validateSchemaValue(file, document, schema, "$", issues, schema);
  if (issues.length) throw new Error(`${file}: generated settings failed schema validation: ${issues.map((issue) => issue.message).join("; ")}`);
}

function assertProjectSettingsRoot(repoPath: string, requestedRoot: string): string {
  const repository = path.resolve(repoPath);
  const root = path.resolve(requestedRoot);
  const relative = path.relative(repository, root);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`project settings root must stay inside the repository: ${root}`);
  }
  let cursor = repository;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) break;
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`project settings path contains a symbolic link: ${cursor}`);
  }
  fs.mkdirSync(root, { recursive: true });
  const canonicalRepository = fs.realpathSync(repository);
  const canonicalRoot = fs.realpathSync(root);
  const canonicalRelative = path.relative(canonicalRepository, canonicalRoot);
  if (canonicalRelative === ".." || canonicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRelative)) {
    throw new Error("project settings root resolves outside the repository");
  }
  return canonicalRoot;
}

function acquireProviderLock(root: string): { lock: string; rootStat: fs.Stats } {
  fs.mkdirSync(root, { recursive: true });
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`provider settings root must be a regular directory: ${root}`);
  const lock = path.join(root, ".provider-bootstrap.lock");
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch {
    throw new Error(`provider settings are locked by another setup or an interrupted run: ${lock}`);
  }
  return { lock, rootStat };
}

function publishDocuments(root: string, lock: string, rootStat: fs.Stats, pending: Array<{ file: string; document: Record<string, unknown> }>): void {
  const backups = new Map<string, { bytes: Buffer; mode: number } | null>();
  const published: string[] = [];
  try {
    for (const item of pending) {
      if (fs.existsSync(item.file)) {
        const stat = fs.lstatSync(item.file);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${item.file}: settings target must be a regular file`);
        backups.set(item.file, { bytes: fs.readFileSync(item.file), mode: stat.mode & 0o777 });
      } else {
        backups.set(item.file, null);
      }
      const staged = path.join(lock, `${path.basename(item.file)}.${randomUUID()}`);
      fs.writeFileSync(staged, `${JSON.stringify(item.document, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      const currentRoot = fs.lstatSync(root);
      if (!currentRoot.isDirectory() || currentRoot.isSymbolicLink() || currentRoot.dev !== rootStat.dev || currentRoot.ino !== rootStat.ino) {
        throw new Error("provider settings root identity changed during publication");
      }
      fs.renameSync(staged, item.file);
      published.push(item.file);
    }
  } catch (error) {
    for (const file of published.reverse()) {
      const backup = backups.get(file);
      if (backup) {
        const restore = path.join(lock, `${path.basename(file)}.restore.${randomUUID()}`);
        fs.writeFileSync(restore, backup.bytes, { mode: backup.mode, flag: "wx" });
        fs.renameSync(restore, file);
      } else {
        try { fs.unlinkSync(file); } catch {}
      }
    }
    throw error;
  }
}

export function bootstrapProviders(options: ProviderBootstrapOptions): { repo: Repo; project: Project; files: string[]; offlineRemediation?: string; pickup?: ProviderPickupPlan } {
  const repoPath = path.resolve(options.repoPath);
  const repo = detectGitHubRepo(repoPath);
  const ghBin = options.ghBin ?? "gh";
  // Validate pickup identity and any already-present pickup plan before settings roots,
  // provider labels, or other mutable setup state are touched.
  const pickupIdentityPreflight = preflightProviderPickup(options, repo);
  let project: Project;
  let offlineRemediation: string | undefined;
  if (options.online) {
    ensureGhAuth(ghBin);
    project = discoverProject(ghBin, repo.owner, options.projectNumber);
  } else {
    if (!options.projectNumber || options.projectNumber < 1) {
      throw new Error("offline provider setup requires --provider-project NUMBER; use --online to discover accessible projects");
    }
    project = { number: options.projectNumber };
  }
  const pickupPreflight = completeProviderPickupPreflight(options, pickupIdentityPreflight);
  const preparedPickup = pickupPreflight ? providerPickupPlan(repo, pickupPreflight) : null;
  if (preparedPickup) assertProviderPickupArtifactCompatibility(preparedPickup);

  const requestedRoot = options.scope === "global"
    ? path.resolve(options.globalSettingsRoot ?? path.join(os.homedir(), ".config", "flow-agents"))
    : path.resolve(options.projectSettingsRoot ?? path.join(repoPath, "context", "settings"));
  const root = options.scope === "project"
    ? assertProjectSettingsRoot(repoPath, requestedRoot)
    : requestedRoot;
  if (options.scope === "global") fs.mkdirSync(root, { recursive: true });
  const { lock, rootStat } = acquireProviderLock(root);
  try {
    const entries = [projectEntry(repo, project), assignmentEntry(repo), changeEntry(repo)];
    const pending: Array<{ file: string; document: Record<string, unknown> }> = [];
    for (let index = 0; index < SETTINGS.length; index += 1) {
      const [name, schema] = SETTINGS[index]!;
      const file = path.join(root, name);
      const document = mergeProject(readDocument(file), entries[index]!, repo, name);
      validateDocument(file, schema, document);
      pending.push({ file, document });
    }
    // Validate every local document before the explicit online mutation so a
    // malformed existing settings file cannot create remote state on a failed run.
    const assignmentDocument = pending.find((item) => path.basename(item.file) === "assignment-provider-settings.json")!.document;
    const assignmentProject = (assignmentDocument.projects as unknown[]).find((candidate) => matchingRootRepo(candidate, repo)) as Record<string, unknown>;
    const labelName = validateLabelName((assignmentProject.policy as Record<string, unknown>).label_name);
    if (options.online) ensureClaimLabel(ghBin, repo, labelName);
    else offlineRemediation = `Provider settings were written without remote checks. Run ${shellQuote(ghBin)} auth status --hostname github.com, ${shellQuote(ghBin)} project view ${project.number} --owner ${shellQuote(repo.owner)}, and ${shellQuote(ghBin)} label list --repo ${shellQuote(`${repo.owner}/${repo.name}`)} ${shellQuote(`--search=${labelName}`)}; create the label only if absent.`;
    publishDocuments(root, lock, rootStat, pending);
    const files = pending.map((item) => item.file);
    const pickup = persistProviderPickup(preparedPickup);
    return { repo, project, files, offlineRemediation, ...(pickup ? { pickup } : {}) };
  } finally {
    try {
      const currentRoot = fs.lstatSync(root);
      if (currentRoot.isDirectory() && !currentRoot.isSymbolicLink() && currentRoot.dev === rootStat.dev && currentRoot.ino === rootStat.ino) {
        fs.rmSync(lock, { recursive: true, force: true });
      }
    } catch {}
  }
}

function usage(): void {
  console.error(`usage: flow-agents provider-bootstrap --scope project|global [options]

Options:
  --repo-path PATH          Git checkout whose origin identifies the repository.
  --project-settings-root   Project settings directory (default: <repo>/context/settings).
  --global-settings-root    Global settings directory (default: ~/.config/flow-agents).
  --provider-project NUMBER GitHub Project number.
  --online                  Verify gh auth, discover/verify the project, and create the claim label if missing.
  --work-item OWNER/REPO#N  Prepare exact provider claim, observation, status, and workflow-start inputs.
  --provider-login LOGIN    Authenticated provider login (required offline with --work-item).
  --provider-branch BRANCH  Assert the provider branch equals the actual Git worktree branch.
  --artifact-root PATH      Runtime artifact root (default: <repo>/.kontourai/flow-agents).
  --json
`);
}

export function main(argv = process.argv.slice(2)): number {
  if (argv.includes("--help") || argv.includes("-h")) { usage(); return 0; }
  const args = parseArgs(argv);
  try {
    const scopeText = flagString(args.flags, "scope") ?? flagString(args.flags, "provider-scope");
    if (scopeText !== "project" && scopeText !== "global") throw new Error("--scope must be project or global");
    const numberText = flagString(args.flags, "provider-project");
    const projectNumber = numberText === undefined ? undefined : Number(numberText);
    if (projectNumber !== undefined && (!Number.isInteger(projectNumber) || projectNumber < 1)) throw new Error("--provider-project must be a positive integer");
    const result = bootstrapProviders({
      scope: scopeText,
      repoPath: path.resolve(flagString(args.flags, "repo-path", ".") ?? "."),
      projectSettingsRoot: flagString(args.flags, "project-settings-root"),
      globalSettingsRoot: flagString(args.flags, "global-settings-root"),
      projectNumber,
      online: flagBool(args.flags, "online"),
      workItemRef: flagString(args.flags, "work-item"),
      providerLogin: flagString(args.flags, "provider-login"),
      providerBranch: flagString(args.flags, "provider-branch"),
      artifactRoot: flagString(args.flags, "artifact-root"),
    });
    if (flagBool(args.flags, "json")) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Configured GitHub workflow providers for ${result.repo.owner}/${result.repo.name} (Project ${result.project.number})`);
      for (const file of result.files) console.log(`  ${file}`);
      if (result.offlineRemediation) console.warn(result.offlineRemediation);
    }
    return 0;
  } catch (error) {
    console.error(`flow-agents provider-bootstrap: ${(error as Error).message}`);
    return 2;
  }
}

const self = (() => { try { return fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return fileURLToPath(import.meta.url); } })();
const invoked = (() => { try { return fs.realpathSync(process.argv[1]); } catch { return process.argv[1]; } })();
if (self === invoked) process.exitCode = main();
