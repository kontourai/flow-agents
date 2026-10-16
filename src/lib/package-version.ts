import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export function flowAgentsPackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

export function flowAgentsPackageMetadataRelativePath(root = flowAgentsPackageRoot()): string {
  // Standalone homes own metadata under build/, without claiming a user package.json.
  return fs.existsSync(path.join(root, "build/runtime-imports.json")) && fs.existsSync(path.join(root, "build/package.json"))
    ? "build/package.json" : "package.json";
}

export function flowAgentsPackageMetadata(root = flowAgentsPackageRoot()): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, flowAgentsPackageMetadataRelativePath(root)), "utf8"));
}

export function flowAgentsPackageVersion(): string {
  const metadata = flowAgentsPackageMetadata();
  if (typeof metadata.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(metadata.version)) {
    throw new Error("Flow Agents package metadata does not contain a valid version");
  }
  return metadata.version;
}
