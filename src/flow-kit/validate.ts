import * as fs from "node:fs";
import * as path from "node:path";
import { readJson } from "../lib/fs.js";

const ASSET_CLASSES = ["flows", "skills", "docs", "adapters", "evals", "assets"] as const;

export function validateKitRepository(kitDir: string): string[] {
  const errors: string[] = [];
  const manifestPath = path.join(kitDir, "kit.json");
  let manifest: Record<string, unknown>;
  try {
    manifest = readJson(manifestPath) as Record<string, unknown>;
  } catch (error) {
    errors.push(`${manifestPath}: invalid JSON: ${(error as Error).message}`);
    return errors;
  }
  if (manifest.schema_version !== "1.0") errors.push(`${manifestPath}: .schema_version must be "1.0"`);
  if (typeof manifest.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(manifest.id)) {
    errors.push(`${manifestPath}: .id must be a stable kebab-case string`);
  }
  if (typeof manifest.name !== "string" || !manifest.name.trim()) errors.push(`${manifestPath}: .name must be a non-empty string`);

  for (const section of ASSET_CLASSES) {
    const entries = manifest[section];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) {
      errors.push(`${manifestPath}: .${section} must be a list`);
      continue;
    }
    const seen = new Set<string>();
    entries.forEach((entry, index) => {
      if (typeof entry !== "object" || entry === null) {
        errors.push(`${manifestPath}: ${section}[${index}] must be an object`);
        return;
      }
      const record = entry as Record<string, unknown>;
      const id = record.id;
      const rel = record.path;
      if (typeof id === "string") {
        if (seen.has(id)) errors.push(`${manifestPath}: ${section}[${index}].id duplicates`);
        seen.add(id);
      }
      if (typeof rel !== "string" || !rel) {
        errors.push(`${manifestPath}: ${section}[${index}].path must be a string`);
        return;
      }
      if (path.isAbsolute(rel)) {
        errors.push(`${manifestPath}: ${section}[${index}].path must be relative`);
        return;
      }
      const resolved = path.resolve(kitDir, rel);
      const root = path.resolve(kitDir);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        errors.push(`${manifestPath}: ${section}[${index}].path must stay inside the kit directory`);
        return;
      }
      if (!fs.existsSync(resolved)) {
        const noun = section === "flows" ? "Flow Definition" : "asset";
        errors.push(`${manifestPath}: ${section}[${index}].path points at missing ${noun}: ${rel}`);
      }
    });
  }
  return errors;
}

export function assertKitRepository(kitDir: string): Record<string, unknown> {
  const errors = validateKitRepository(kitDir);
  if (errors.length) {
    const error = new Error("Flow Kit repository validation failed") as Error & { diagnostics?: string[] };
    error.diagnostics = errors;
    throw error;
  }
  return readJson(path.join(kitDir, "kit.json")) as Record<string, unknown>;
}
