import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, flagString, flagBool } from "../lib/args.js";
import { readJson } from "../lib/fs.js";

const PROJECT_SETTINGS_RELATIVE_PATH = path.join("context", "settings", "backlog-provider-settings.json");
const WORKSPACE_SETTINGS_RELATIVE_PATH = path.join(".kontourai", "settings.json");

function loadSettings(file: string): Record<string, unknown> | null {
  if (!fs.existsSync(file)) return null;
  const data = readJson(file) as Record<string, unknown>;
  if (data.schema_version !== "1.0") throw new Error(`${file}: unsupported schema_version ${String(data.schema_version)}`);
  return data;
}

function repoFromText(text: string): { owner: string; name: string } | null {
  const match = text.trim().match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  return match ? { owner: match[1], name: match[2] } : null;
}

function currentRepo(repoPath: string): { owner: string; name: string } | null {
  try {
    const out = child_process.execFileSync("git", ["-C", repoPath, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const repo = repoFromText(out);
    if (repo) return repo;
  } catch {}
  const packagePath = path.join(repoPath, "package.json");
  if (fs.existsSync(packagePath)) {
    const data = readJson(packagePath) as Record<string, unknown>;
    const repository = data.repository;
    const url = typeof repository === "object" && repository !== null ? (repository as Record<string, unknown>).url : repository;
    if (typeof url === "string") return repoFromText(url);
  }
  return null;
}

function gitRoot(repoPath: string): string | null {
  try {
    return child_process.execFileSync("git", ["-C", repoPath, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function merge(base: unknown, override: unknown): Record<string, unknown> | null {
  if (!base && !override) return null;
  if (!base) return structuredClone(override) as Record<string, unknown>;
  if (!override) return structuredClone(base) as Record<string, unknown>;
  const out = structuredClone(base) as Record<string, unknown>;
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    out[key] = typeof value === "object" && value !== null && typeof out[key] === "object" && out[key] !== null && !Array.isArray(value)
      ? merge(out[key], value)
      : structuredClone(value);
  }
  return out;
}

function findProject(settings: Record<string, unknown> | null, repo: { owner: string; name: string }): Record<string, unknown> | null {
  const projects = settings?.projects;
  if (!Array.isArray(projects)) return null;
  return (projects.find((project) => {
    const projectRepo = (((project as Record<string, unknown>).project as Record<string, unknown> | undefined)?.repo ?? {}) as Record<string, unknown>;
    return projectRepo.owner === repo.owner && projectRepo.name === repo.name;
  }) as Record<string, unknown> | undefined) ?? null;
}

function workspaceRepos(settings: Record<string, unknown> | null): string[] {
  const workspace = settings?.workspace;
  if (typeof workspace !== "object" || workspace === null || Array.isArray(workspace)) return [];
  const repos = (workspace as Record<string, unknown>).repos;
  return Array.isArray(repos) ? repos.flatMap((repo) => typeof repo === "string" && repo.trim() ? [repo.trim()] : []) : [];
}

function hasWorkspaceSettings(repoPath: string): boolean {
  return fs.existsSync(path.join(repoPath, WORKSPACE_SETTINGS_RELATIVE_PATH));
}

function isGitRepoRoot(candidate: string): boolean {
  if (fs.existsSync(path.join(candidate, ".git"))) return true;
  try {
    const root = child_process.execFileSync("git", ["-C", candidate, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return fs.realpathSync(root) === fs.realpathSync(candidate);
  } catch {
    return false;
  }
}

function depthOneGitRepoCount(repoPath: string): number {
  if (!fs.existsSync(repoPath)) return 0;
  let count = 0;
  for (const name of fs.readdirSync(repoPath)) {
    const candidate = path.join(repoPath, name);
    if (!fs.statSync(candidate).isDirectory()) continue;
    if (isGitRepoRoot(candidate)) count += 1;
    if (count >= 2) return count;
  }
  return count;
}

function isWorkspacePath(repoPath: string): boolean {
  return hasWorkspaceSettings(repoPath) || depthOneGitRepoCount(repoPath) >= 2;
}

function defaultProjectSettingsPath(): string {
  let cursor = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = path.join(cursor, PROJECT_SETTINGS_RELATIVE_PATH);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(cursor);
    if (parent === cursor) return path.resolve(PROJECT_SETTINGS_RELATIVE_PATH);
    cursor = parent;
  }
}

function effective(repoPath: string, projectSettings: string, globalSettings: string): [Record<string, unknown>, number] {
  const globalDoc = loadSettings(globalSettings);
  const root = gitRoot(repoPath);
  if (!root && isWorkspacePath(repoPath)) {
    const workspaceSettings = path.join(repoPath, WORKSPACE_SETTINGS_RELATIVE_PATH);
    const workspaceDoc = loadSettings(workspaceSettings);
    const effectiveSettings = merge(globalDoc?.defaults, workspaceDoc?.defaults);
    const repos = workspaceRepos(workspaceDoc);
    if (effectiveSettings) {
      if (repos.length) (effectiveSettings as Record<string, unknown>).workspace = { repos };
      return [{
        status: "configured",
        scope: "workspace",
        workspace: { root: repoPath, settings_path: workspaceSettings, repos },
        source: workspaceDoc?.defaults ? "workspace" : "global",
        precedence: ["workspace.defaults", "global.defaults"],
        settings: effectiveSettings,
      }, 0];
    }
    return [{ status: "ask_user", scope: "workspace", reason: "no_backlog_provider_settings", message: "Ask the user which backlog WorkItemProvider and BoardProvider to use for this workspace.", workspace: { root: repoPath, settings_path: workspaceSettings, repos }, resolution: { workspace_settings_path: workspaceSettings, global_settings_path: globalSettings, checked: ["workspace", "global"] } }, 2];
  }

  const repo = currentRepo(repoPath);
  const projectDoc = loadSettings(projectSettings);
  if (!repo) return [{ status: "ask_user", reason: "could_not_identify_current_repo", message: "Ask the user which backlog WorkItemProvider and BoardProvider to use for this workspace.", resolution: { project_settings_path: projectSettings, global_settings_path: globalSettings } }, 2];
  const effectiveSettings = merge(merge(merge(globalDoc?.defaults, findProject(globalDoc, repo)), projectDoc?.defaults), findProject(projectDoc, repo));
  if (!effectiveSettings) return [{ status: "ask_user", reason: "no_backlog_provider_settings", message: "Ask the user which backlog WorkItemProvider and BoardProvider to use before selecting work.", current_repo: repo, resolution: { project_settings_path: projectSettings, global_settings_path: globalSettings, checked: ["project", "global"] } }, 2];
  return [{ status: "configured", scope: "repo", current_repo: repo, source: findProject(projectDoc, repo) || projectDoc?.defaults ? "project" : "global", precedence: ["project.projects match", "project.defaults", "global.projects match", "global.defaults"], settings: effectiveSettings }, 0];
}

export function main(argv = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  try {
    const [result, code] = effective(
      path.resolve(flagString(args.flags, "repo-path", ".") ?? "."),
      path.resolve(flagString(args.flags, "project-settings", defaultProjectSettingsPath()) ?? ""),
      path.resolve(flagString(args.flags, "global-settings", path.join(os.homedir(), ".config", "flow-agents", "backlog-provider-settings.json")) ?? ""),
    );
    if (flagBool(args.flags, "json")) console.log(JSON.stringify(result, null, 2));
    else console.log(`status: ${String(result.status)}`);
    return code;
  } catch (error) {
    console.error(`error: ${(error as Error).message}`);
    return 1;
  }
}

// Use process.exitCode (not process.exit) to allow stdout to be flushed before exit.
// Resolve real paths to handle symlinks (e.g. /tmp -> /private/tmp on macOS) so the
// entry-point guard fires correctly when the module is loaded directly as a script.
const _selfRealPath = (() => { try { return fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return fileURLToPath(import.meta.url); } })();
const _argv1RealPath = (() => { try { return fs.realpathSync(process.argv[1]); } catch { return process.argv[1]; } })();
if (_selfRealPath === _argv1RealPath) { process.exitCode = main(); }
