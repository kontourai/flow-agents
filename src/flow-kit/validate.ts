import * as fs from "node:fs";
import * as path from "node:path";
import { readJson } from "../lib/fs.js";

const ASSET_CLASSES = ["flows", "skills", "docs", "adapters", "evals", "assets"] as const;

// Core container fields owned by kontourai/flow (flow-kit-container.schema.json).
// agent-extension fields are skills, docs, adapters, evals, assets.
const CORE_CONTAINER_FIELDS = new Set(["schema_version", "id", "name", "description", "product_name", "flows"]);
const AGENT_EXTENSION_CLASSES = new Set(["skills", "docs", "adapters", "evals", "assets"]);

export type KitTargetConsumer =
  | "flow"
  | "flow-agents"
  | string; // third-party extension namespaces listed verbatim

export interface KitConformanceLevel {
  /** K0: valid core Flow Kit container with at least one flow (gates evaluable agentlessly). */
  k0: boolean;
  /** K1: K0 + at least one Flow Agents extension asset class present (skills/docs/adapters/evals/assets). */
  k1: boolean;
  /** K2: K1 + evals present (live evidence layer). */
  k2: boolean;
}

export interface KitTargetsResult {
  kit_id: string;
  kit_name: string;
  conformance: KitConformanceLevel;
  /** Derived consumer targets based on observable asset classes. */
  targets: KitTargetConsumer[];
  /** Extension field namespaces that are not Flow or Flow Agents-owned. */
  third_party_extensions: string[];
}

/**
 * Validates that the manifest satisfies the core Flow Kit container contract
 * (as specified by kontourai/flow PR #67) with all agent-extension fields stripped.
 * Returns a list of violation messages (empty = valid).
 *
 * The degradation invariant: every Flow Agents Kit MUST remain a valid core
 * Flow Kit container when agent-extension fields are ignored.
 */
export function validateCoreContainer(manifest: Record<string, unknown>, label: string): string[] {
  const errors: string[] = [];
  if (manifest.schema_version !== "1.0") {
    errors.push(`${label}: .schema_version must be "1.0"`);
  }
  if (typeof manifest.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(manifest.id)) {
    errors.push(`${label}: .id must be a stable kebab-case string`);
  }
  if (typeof manifest.name !== "string" || !manifest.name.trim()) {
    errors.push(`${label}: .name must be a non-empty string`);
  }
  if (!Array.isArray(manifest.flows) || manifest.flows.length === 0) {
    errors.push(`${label}: .flows must be a non-empty list`);
  } else {
    manifest.flows.forEach((entry: unknown, index: number) => {
      if (typeof entry !== "object" || entry === null) {
        errors.push(`${label}: flows[${index}] must be an object`);
        return;
      }
      const flow = entry as Record<string, unknown>;
      if (typeof flow.id !== "string" || !flow.id) {
        errors.push(`${label}: flows[${index}].id must be a string`);
      }
      if (typeof flow.path !== "string" || !flow.path) {
        errors.push(`${label}: flows[${index}].path must be a string`);
      }
    });
  }
  return errors;
}

/**
 * Derives the consumer-target level (K0/K1/K2) and target audience list from
 * observable asset classes in the kit manifest. Does not require file I/O.
 *
 * Derivation rules (from kontourai/flow-agents#52 and Brian's layering review):
 *  - K0: valid core container (schema_version, id, name, flows non-empty).
 *  - K1: K0 + any Flow Agents extension field present (skills/docs/adapters/evals/assets).
 *  - K2: K1 + evals present.
 *  - targets.flow: always present when K0 (any Flow consumer can evaluate gates).
 *  - targets.flow-agents: present when K1 (agent extension assets activate in >=1 harness).
 *  - third-party: any top-level keys that are not core fields and not Flow Agents extension classes.
 */
export function deriveKitTargets(manifest: Record<string, unknown>): KitTargetsResult {
  const kitId = typeof manifest.id === "string" ? manifest.id : "<unknown>";
  const kitName = typeof manifest.name === "string" ? manifest.name : "<unknown>";

  const coreErrors = validateCoreContainer(manifest, "kit.json");
  const k0 = coreErrors.length === 0;

  const hasAgentExtension = AGENT_EXTENSION_CLASSES.size > 0 &&
    [...AGENT_EXTENSION_CLASSES].some((cls) => Array.isArray(manifest[cls]) && (manifest[cls] as unknown[]).length > 0);

  const hasEvals = Array.isArray(manifest["evals"]) && (manifest["evals"] as unknown[]).length > 0;

  const k1 = k0 && hasAgentExtension;
  const k2 = k1 && hasEvals;

  // Detect third-party extension namespaces: top-level keys that are neither
  // core fields nor Flow Agents extension classes.
  const thirdPartyExtensions: string[] = Object.keys(manifest)
    .filter((key) => !CORE_CONTAINER_FIELDS.has(key) && !AGENT_EXTENSION_CLASSES.has(key))
    .sort();

  const targets: KitTargetConsumer[] = [];
  if (k0) targets.push("flow");
  if (k1) targets.push("flow-agents");
  for (const ns of thirdPartyExtensions) targets.push(ns);

  return {
    kit_id: kitId,
    kit_name: kitName,
    conformance: { k0, k1, k2 },
    targets,
    third_party_extensions: thirdPartyExtensions,
  };
}

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

  // Degradation invariant: every Flow Agents Kit must remain a valid core Flow Kit container
  // when agent-extension fields are stripped. Strip extensions and re-validate core contract.
  const coreManifest: Record<string, unknown> = {};
  for (const key of Object.keys(manifest)) {
    if (CORE_CONTAINER_FIELDS.has(key)) coreManifest[key] = manifest[key];
  }
  const coreErrors = validateCoreContainer(coreManifest, manifestPath);
  for (const err of coreErrors) {
    // Deduplicate: only add if not already covered by top-level checks above.
    if (!errors.some((existing) => existing === err)) errors.push(err);
  }

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
