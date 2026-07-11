import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export function flowAgentsPackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

export function flowAgentsPackageVersion(): string {
  const metadata = JSON.parse(fs.readFileSync(path.join(flowAgentsPackageRoot(), "package.json"), "utf8")) as { version?: unknown };
  if (typeof metadata.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(metadata.version)) {
    throw new Error("Flow Agents package metadata does not contain a valid version");
  }
  return metadata.version;
}
