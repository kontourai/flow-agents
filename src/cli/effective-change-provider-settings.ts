import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { flagBool, flagString, parseArgs } from "../lib/args.js";
import { readJson } from "../lib/fs.js";
import { execTrustedGitSync } from "../lib/trusted-git.js";
import { resolveChangeProviderSupport } from "./public-contracts.js";

const PROJECT_SETTINGS_RELATIVE_PATH = path.join("context", "settings", "change-provider-settings.json");

type Repo = { owner: string; name: string };
type SettingsDocument = Record<string, unknown>;

function loadSettings(file: string): SettingsDocument | null {
  if (!fs.existsSync(file)) return null;
  const data = readJson(file) as SettingsDocument;
  if (data.schema_version !== "1.0") throw new Error(`${file}: unsupported schema_version ${String(data.schema_version)}; regenerate settings with flow-agents configuration guidance`);
  return data;
}

function repoFromText(text: string): Repo | null {
  const match = text.trim().match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
  return match ? { owner: match[1]!, name: match[2]! } : null;
}

function currentRepo(repoPath: string): Repo | null {
  try {
    const remote = String(execTrustedGitSync(repoPath, ["remote", "get-url", "origin"], "utf8"));
    const repo = repoFromText(remote);
    if (repo) return repo;
  } catch {}
  const packagePath = path.join(repoPath, "package.json");
  if (!fs.existsSync(packagePath)) return null;
  const data = readJson(packagePath) as Record<string, unknown>;
  const repository = typeof data.repository === "object" && data.repository !== null ? (data.repository as Record<string, unknown>).url : data.repository;
  return typeof repository === "string" ? repoFromText(repository) : null;
}

function merge(base: unknown, override: unknown): Record<string, unknown> | null {
  if (!base && !override) return null;
  if (!base) return structuredClone(override) as Record<string, unknown>;
  if (!override) return structuredClone(base) as Record<string, unknown>;
  const out = structuredClone(base) as Record<string, unknown>;
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    out[key] = typeof value === "object" && value !== null && !Array.isArray(value) && typeof out[key] === "object" && out[key] !== null && !Array.isArray(out[key])
      ? merge(out[key], value)
      : structuredClone(value);
  }
  return out;
}

function findProject(settings: SettingsDocument | null, repo: Repo): Record<string, unknown> | null {
  if (!Array.isArray(settings?.projects)) return null;
  return (settings.projects.find((project) => {
    const projectRepo = ((project as Record<string, unknown>).project as Record<string, unknown> | undefined)?.repo as Record<string, unknown> | undefined;
    return projectRepo?.owner === repo.owner && projectRepo?.name === repo.name;
  }) as Record<string, unknown> | undefined) ?? null;
}

function defaultProjectSettingsPath(repoPath: string): string {
  return path.join(path.resolve(repoPath), PROJECT_SETTINGS_RELATIVE_PATH);
}

export function resolveEffectiveChangeProviderSettings(repoPath: string, projectSettings = defaultProjectSettingsPath(repoPath), globalSettings = path.join(os.homedir(), ".config", "flow-agents", "change-provider-settings.json")): Record<string, unknown> {
  const repo = currentRepo(repoPath);
  const projectDoc = loadSettings(projectSettings);
  const globalDoc = loadSettings(globalSettings);
  if (!repo) return { status: "unconfigured", reason: "could_not_identify_current_repo", resolution: { project_settings_path: projectSettings, global_settings_path: globalSettings } };
  const effectiveSettings = merge(merge(merge(globalDoc?.defaults, findProject(globalDoc, repo)), projectDoc?.defaults), findProject(projectDoc, repo));
  const provider = effectiveSettings?.provider;
  const support = resolveChangeProviderSupport(provider);
  if (support.status === "configured") {
    return { status: "configured", current_repo: repo, source: findProject(projectDoc, repo) || projectDoc?.defaults ? "project" : "global", precedence: ["project.projects match", "project.defaults", "global.projects match", "global.defaults"], provider: support.provider };
  }
  return { status: support.status, reason: support.reason, current_repo: repo, resolution: { project_settings_path: projectSettings, global_settings_path: globalSettings, checked: ["project", "global"] } };
}

export function main(argv = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  try {
    const repoPath = path.resolve(flagString(args.flags, "repo-path", ".") ?? ".");
    const result = resolveEffectiveChangeProviderSettings(
      repoPath,
      path.resolve(flagString(args.flags, "project-settings", defaultProjectSettingsPath(repoPath)) ?? ""),
      path.resolve(flagString(args.flags, "global-settings", path.join(os.homedir(), ".config", "flow-agents", "change-provider-settings.json")) ?? ""),
    );
    if (flagBool(args.flags, "json")) console.log(JSON.stringify(result, null, 2));
    else console.log(`status: ${String(result.status)}`);
    return result.status === "configured" ? 0 : 2;
  } catch (error) {
    console.error(`error: ${(error as Error).message}`);
    return 1;
  }
}

const selfPath = (() => { try { return fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return fileURLToPath(import.meta.url); } })();
const argvPath = (() => { try { return fs.realpathSync(process.argv[1]); } catch { return process.argv[1]; } })();
if (selfPath === argvPath) process.exitCode = main();
