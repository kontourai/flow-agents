import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, flagString, flagBool } from "../lib/args.js";
import { readJson } from "../lib/fs.js";

// Mirrors src/cli/effective-backlog-settings.ts's loadSettings/currentRepo/merge/findProject/
// effective structure and its ask_user/configured result envelope exactly, pointed at the
// AssignmentProvider settings schema/example instead of the backlog equivalents (#290 Wave 2
// Task B). Deliberately NOT extracted into a shared helper with effective-backlog-settings.ts —
// see the #290 plan artifact's Unresolved Questions #3 for the recorded rationale (duplicating
// this file's small merge/repo-detection logic is lower-risk than refactoring a file outside
// this issue's declared scope).

const PROJECT_SETTINGS_RELATIVE_PATH = path.join("context", "settings", "assignment-provider-settings.json");

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
  const repo = currentRepo(repoPath);
  const projectDoc = loadSettings(projectSettings);
  const globalDoc = loadSettings(globalSettings);
  if (!repo) return [{ status: "ask_user", reason: "could_not_identify_current_repo", message: "Ask the user which assignment AssignmentProvider to use for this workspace.", resolution: { project_settings_path: projectSettings, global_settings_path: globalSettings } }, 2];
  const effectiveSettings = merge(merge(merge(globalDoc?.defaults, findProject(globalDoc, repo)), projectDoc?.defaults), findProject(projectDoc, repo));
  if (!effectiveSettings) return [{ status: "ask_user", reason: "no_assignment_provider_settings", message: "Ask the user which assignment AssignmentProvider to use before claiming work.", current_repo: repo, resolution: { project_settings_path: projectSettings, global_settings_path: globalSettings, checked: ["project", "global"] } }, 2];
  return [{ status: "configured", current_repo: repo, source: findProject(projectDoc, repo) || projectDoc?.defaults ? "project" : "global", precedence: ["project.projects match", "project.defaults", "global.projects match", "global.defaults"], settings: effectiveSettings }, 0];
}

export function main(argv = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  try {
    const [result, code] = effective(
      path.resolve(flagString(args.flags, "repo-path", ".") ?? "."),
      path.resolve(flagString(args.flags, "project-settings", defaultProjectSettingsPath()) ?? ""),
      path.resolve(flagString(args.flags, "global-settings", path.join(os.homedir(), ".config", "flow-agents", "assignment-provider-settings.json")) ?? ""),
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
