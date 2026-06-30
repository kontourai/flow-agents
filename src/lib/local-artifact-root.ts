import * as fs from "node:fs";
import * as path from "node:path";

export const KONTOURAI_DIR = ".kontourai";
export const LEGACY_FLOW_AGENTS_DIR = ".flow-agents";
export const LEGACY_TELEMETRY_DIR = ".telemetry";

export function flowAgentsArtifactRoot(cwd = process.cwd()): string {
  return path.resolve(cwd, KONTOURAI_DIR, "flow-agents");
}

export function legacyFlowAgentsArtifactRoot(cwd = process.cwd()): string {
  return path.resolve(cwd, LEGACY_FLOW_AGENTS_DIR);
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
  return firstExistingPath([flowAgentsArtifactRoot(cwd), legacyFlowAgentsArtifactRoot(cwd)]);
}

export function defaultTelemetryDirForRead(cwd = process.cwd()): string {
  return firstExistingPath([telemetryDataDir(cwd), legacyTelemetryDataDir(cwd)]);
}

export function defaultTelemetryDirsForRead(cwd = process.cwd()): string[] {
  const dirs = [telemetryDataDir(cwd), legacyTelemetryDataDir(cwd)];
  return dirs.filter((dir, index) => dirs.indexOf(dir) === index && fs.existsSync(dir));
}
