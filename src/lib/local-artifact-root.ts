import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const KONTOURAI_DIR = ".kontourai";
export const FLOW_AGENTS_RUNTIME_SUBDIR = "flow-agents";
export const FLOW_AGENTS_RUNTIME_DIR = `${KONTOURAI_DIR}/${FLOW_AGENTS_RUNTIME_SUBDIR}`;
export const DURABLE_FLOW_AGENTS_DIR = ".flow-agents";
export const LEGACY_TELEMETRY_DIR = ".telemetry";

/**
 * Default Codex home: `$CODEX_HOME` when set, else `~/.codex`.
 *
 * This is the Codex CLI's own config/state root and is conceptually
 * distinct from the Flow Agents global bundle install root (`~/.flow-agents`)
 * and the durable per-destination install record root
 * (`DURABLE_FLOW_AGENTS_DIR`, i.e. `.flow-agents`).
 */
export function defaultCodexHome(): string {
  return process.env["CODEX_HOME"] || path.join(os.homedir(), ".codex");
}

export function flowAgentsArtifactRoot(cwd = process.cwd()): string {
  return path.resolve(cwd, FLOW_AGENTS_RUNTIME_DIR);
}

export function durableFlowAgentsRoot(cwd = process.cwd()): string {
  return path.resolve(cwd, DURABLE_FLOW_AGENTS_DIR);
}

export function durableInstallRecordPath(cwd = process.cwd()): string {
  return path.join(durableFlowAgentsRoot(cwd), "install.json");
}

export function telemetryDataDir(cwd = process.cwd()): string {
  return path.resolve(cwd, KONTOURAI_DIR, "telemetry");
}

export function legacyTelemetryDataDir(cwd = process.cwd()): string {
  return path.resolve(cwd, LEGACY_TELEMETRY_DIR);
}

export function firstExistingPath(candidates: string[]): string {
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

export function defaultArtifactRootForRead(cwd = process.cwd()): string {
  return flowAgentsArtifactRoot(cwd);
}

export function defaultTelemetryDirForRead(cwd = process.cwd()): string {
  return firstExistingPath([telemetryDataDir(cwd), legacyTelemetryDataDir(cwd)]);
}

export function defaultTelemetryDirsForRead(cwd = process.cwd()): string[] {
  const dirs = [telemetryDataDir(cwd), legacyTelemetryDataDir(cwd)];
  return dirs.filter((dir, index) => dirs.indexOf(dir) === index && fs.existsSync(dir));
}
