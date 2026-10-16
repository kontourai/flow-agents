import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export function flowAgentsPackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

export function flowAgentsPackageMetadata(root = flowAgentsPackageRoot()): Record<string, unknown> {
  // Standalone homes own metadata under build/, without claiming a user package.json.
  const bundled = path.join(root, "build/package.json");
  return JSON.parse(fs.readFileSync(fs.existsSync(path.join(root, "build/runtime-imports.json")) && fs.existsSync(bundled) ? bundled : path.join(root, "package.json"), "utf8"));
}

export function flowAgentsPackageVersion(): string {
  const metadata = flowAgentsPackageMetadata();
  if (typeof metadata.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(metadata.version)) {
    throw new Error("Flow Agents package metadata does not contain a valid version");
  }
  return metadata.version;
}
