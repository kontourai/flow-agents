import * as fs from "node:fs";
import * as path from "node:path";
import { validateKitContainer } from "@kontourai/flow";
import { readJson } from "../lib/fs.js";

// Extension-only asset classes: validated by Flow Agents. Flows are validated by @kontourai/flow.
const EXTENSION_ASSET_CLASSES = ["skills", "docs", "adapters", "evals", "assets"] as const;

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
 * Delegates core Flow Kit container validation to @kontourai/flow's validateKitContainer.
 * The container contract lives once, in Flow. Returns a list of violation messages (empty = valid).
 *
 * The degradation invariant: every Flow Agents Kit MUST remain a valid core
 * Flow Kit container when agent-extension fields are ignored.
 *
 * @param kitDir  Real kit directory path for file-existence checks on flows[].path entries.
 *                Pass the actual kit directory when available; pass "" for structural-only checks.
 */
function delegateCoreContainerValidation(kitDir: string, manifest: Record<string, unknown>): string[] {
  const result = validateKitContainer(kitDir, manifest);
  if (result.valid) return [];
  return result.diagnostics
    .filter((d) => d.severity === "error")
    .map((d) => `${d.path}: ${d.message}`);
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
 *
 * @param manifest  The kit.json manifest object.
 * @param kitDir    Kit directory for flow file-existence checks. Defaults to "" (structural-only).
 *                  Pass the real kit directory from `inspect` to get authoritative K0 validation.
 */
export function deriveKitTargets(manifest: Record<string, unknown>, kitDir = ""): KitTargetsResult {
  const kitId = typeof manifest.id === "string" ? manifest.id : "<unknown>";
  const kitName = typeof manifest.name === "string" ? manifest.name : "<unknown>";

  // Delegate core container validation to @kontourai/flow.
  const coreErrors = delegateCoreContainerValidation(kitDir, manifest);
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

  // Delegate core container validation (schema_version, id, name, flows including file
  // existence) to @kontourai/flow — the container contract lives once, in Flow.
  // This enforces the degradation invariant: a Flow Agents Kit must remain a valid
  // core Flow Kit container when extension fields are stripped.
  const coreErrors = delegateCoreContainerValidation(kitDir, manifest);
  for (const err of coreErrors) errors.push(err);

  // Flow Agents extension validation: skills, docs, adapters, evals, assets.
  // Flows are validated above by @kontourai/flow; only extension classes are checked here.
  for (const section of EXTENSION_ASSET_CLASSES) {
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
        errors.push(`${manifestPath}: ${section}[${index}].path points at missing asset: ${rel}`);
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
