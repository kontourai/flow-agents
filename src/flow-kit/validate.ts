import * as fs from "node:fs";
import * as path from "node:path";
import { readJson } from "../lib/fs.js";

// Extension-only asset classes: validated by Flow Agents. Flows are validated by @kontourai/flow.
const EXTENSION_ASSET_CLASSES = ["skills", "docs", "adapters", "evals", "assets"] as const;

// Core container fields owned by kontourai/flow (flow-kit-container.schema.json).
// agent-extension fields are skills, docs, adapters, evals, assets.
const CORE_CONTAINER_FIELDS = new Set(["schema_version", "id", "name", "description", "product_name", "flows"]);
const AGENT_EXTENSION_CLASSES = new Set(["skills", "docs", "adapters", "evals", "assets"]);

// Flow Agents-recognized metadata fields that are neither core container fields nor
// agent-extension asset classes. Recognized here so they are never misreported as
// unknown third-party extension namespaces. `dependencies` declares cross-kit skill
// dependencies (extension-layer ownership; see docs/adr/0019-kit-dependency-ownership.md).
const KNOWN_METADATA_FIELDS = new Set(["dependencies"]);

export interface KitDependencyEntry {
  kit_id: string;
  reason?: string;
}

/**
 * Parse and shape-validate a kit manifest's `dependencies` field (Flow Agents
 * extension-layer metadata; see docs/adr/0019-kit-dependency-ownership.md).
 *
 * Shape rules:
 *  - `dependencies` (if present) must be an array.
 *  - each entry must be an object with a `kit_id` string matching ^[a-z][a-z0-9-]*$.
 *  - `kit_id` must not equal the declaring kit's own id (no self-reference).
 *  - no duplicate `kit_id` across entries.
 *  - `reason` is an optional string.
 *
 * Returns the parsed entries plus any shape errors (empty errors = valid). This is
 * a sibling shape check, not a member of the file-path-oriented EXTENSION_ASSET_CLASSES
 * loop, because dependency entries have no `path`/file to check.
 */
export function parseKitDependencies(manifest: Record<string, unknown>, manifestPath: string): { entries: KitDependencyEntry[]; errors: string[] } {
  const entries: KitDependencyEntry[] = [];
  const errors: string[] = [];
  const raw = manifest.dependencies;
  if (raw === undefined) return { entries, errors };
  if (!Array.isArray(raw)) {
    errors.push(`${manifestPath}: .dependencies must be a list`);
    return { entries, errors };
  }
  const ownId = typeof manifest.id === "string" ? manifest.id : "";
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      errors.push(`${manifestPath}: dependencies[${index}] must be an object`);
      return;
    }
    const record = entry as Record<string, unknown>;
    const kitId = record.kit_id;
    if (typeof kitId !== "string" || !/^[a-z][a-z0-9-]*$/.test(kitId)) {
      errors.push(`${manifestPath}: dependencies[${index}].kit_id must be a kebab-case kit id (^[a-z][a-z0-9-]*$)`);
      return;
    }
    if (ownId && kitId === ownId) {
      errors.push(`${manifestPath}: dependencies[${index}].kit_id must not reference the declaring kit itself ('${kitId}')`);
      return;
    }
    if (seen.has(kitId)) {
      errors.push(`${manifestPath}: dependencies[${index}].kit_id duplicates '${kitId}'`);
      return;
    }
    seen.add(kitId);
    if (record.reason !== undefined && typeof record.reason !== "string") {
      errors.push(`${manifestPath}: dependencies[${index}].reason must be a string when present`);
    }
    const reason = typeof record.reason === "string" ? record.reason : undefined;
    entries.push({ kit_id: kitId, ...(reason ? { reason } : {}) });
  });
  return { entries, errors };
}

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

/**
 * Kit trust level — WHO vouches for a kit, orthogonal to the K-level capability axis.
 *
 * - "first-party": the kit is authored and published by Kontour (kontourai); its id is in the
 *   FIRST_PARTY_KIT_IDS allowlist maintained in this repository. These kits are built, tested,
 *   and distributed with the flow-agents package.
 * - "verified": reserved for a future third-party verification process (e.g. self-certification
 *   via the conformance kit + cryptographic attestation / Veritas claims). Not yet implemented.
 * - "unverified": default for all kits not in the first-party allowlist. This says nothing about
 *   the kit's quality — it only means Kontour has not vouched for it.
 *
 * The v2 path for "verified": cryptographic signing / attestation against the conformance kit
 * and Veritas claims substrate is the natural next step and is intentionally deferred.
 */
export type KitTrustLevel = "first-party" | "verified" | "unverified";

/**
 * Allowlist of kit IDs that Kontour authors, tests, and ships with the flow-agents package.
 *
 * Criteria for inclusion:
 *   1. The kit directory lives under kits/ in the kontourai/flow-agents repository.
 *   2. The kit is published by @kontourai (npm package @kontourai/flow-agents).
 *   3. Kontour owns and maintains the kit's content and release lifecycle.
 *
 * To add a new first-party kit: add its id here AND ensure it lives under kits/ in this repo.
 * Third-party forks or community kits published elsewhere are NOT first-party, even if they
 * share a similar id — first-party is tied to provenance in this specific repository.
 */
export const FIRST_PARTY_KIT_IDS: ReadonlySet<string> = new Set(["builder", "knowledge"]);

/**
 * Derive the trust level for a kit id.
 *
 * v1 determination: allowlist check against FIRST_PARTY_KIT_IDS.
 * "verified" is reserved for future third-party verification (not yet granted to any kit).
 */
export function deriveKitTrust(kitId: string): KitTrustLevel {
  if (FIRST_PARTY_KIT_IDS.has(kitId)) return "first-party";
  return "unverified";
}

export interface KitTargetsResult {
  kit_id: string;
  kit_name: string;
  conformance: KitConformanceLevel;
  /** Derived consumer targets based on observable asset classes. */
  targets: KitTargetConsumer[];
  /** Extension field namespaces that are not Flow or Flow Agents-owned. */
  third_party_extensions: string[];
  /**
   * Trust level: who vouches for this kit. Orthogonal to the K-level capability axis.
   * "first-party" = Kontour-published; "verified" = reserved (future); "unverified" = default.
   */
  trust: KitTrustLevel;
}

// Lazy-loaded cache for validateKitContainer from @kontourai/flow.
// list/status/activate are runtime ops that never call validation and must NOT load
// @kontourai/flow (it is unresolvable in a standalone installed bundle).
// Only validate/inspect (authoring ops) trigger this load.
type ValidateKitContainerFn = (kitDir: string, manifest: Record<string, unknown>) => { valid: boolean; diagnostics: { severity: string; path: string; message: string }[] };
let _validateKitContainerCache: ValidateKitContainerFn | null = null;

async function loadValidateKitContainer(): Promise<ValidateKitContainerFn> {
  if (_validateKitContainerCache) return _validateKitContainerCache;
  let mod: { validateKitContainer?: unknown };
  try {
    mod = await import("@kontourai/flow") as { validateKitContainer?: unknown };
  } catch (err) {
    throw new Error(
      "container validation requires @kontourai/flow; run from an npm-installed flow-agents workspace " +
      `or use 'flow kit validate' (original error: ${(err as Error).message})`
    );
  }
  if (typeof mod.validateKitContainer !== "function") {
    throw new Error("@kontourai/flow did not export validateKitContainer");
  }
  _validateKitContainerCache = mod.validateKitContainer as ValidateKitContainerFn;
  return _validateKitContainerCache;
}

/**
 * Delegates core Flow Kit container validation to @kontourai/flow's validateKitContainer.
 * The container contract lives once, in Flow. Returns a list of violation messages (empty = valid).
 *
 * The degradation invariant: every Flow Agents Kit MUST remain a valid core
 * Flow Kit container when agent-extension fields are ignored.
 *
 * Loads @kontourai/flow lazily (on first call) so that runtime ops (list/status/activate)
 * that never invoke validation can run in standalone installed bundles where
 * @kontourai/flow is not present.
 *
 * @param kitDir  Real kit directory path for file-existence checks on flows[].path entries.
 *                Pass the actual kit directory when available; pass "" for structural-only checks.
 */
async function delegateCoreContainerValidation(kitDir: string, manifest: Record<string, unknown>): Promise<string[]> {
  const validateKitContainer = await loadValidateKitContainer();
  const result = validateKitContainer(kitDir, manifest);
  if (result.valid) return [];
  return result.diagnostics
    .filter((d) => d.severity === "error")
    .map((d) => `${d.path}: ${d.message}`);
}

/**
 * Derives the consumer-target level (K0/K1/K2), target audience list, and trust level from
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
 * Trust derivation (from kontourai/flow-agents#79):
 *  - "first-party": kit id is in FIRST_PARTY_KIT_IDS (Kontour-authored kits in this repo).
 *  - "unverified": all other kits (default; "verified" is reserved for a future process).
 *
 * @param manifest  The kit.json manifest object.
 * @param kitDir    Kit directory for flow file-existence checks. Defaults to "" (structural-only).
 *                  Pass the real kit directory from `inspect` to get authoritative K0 validation.
 */
export async function deriveKitTargets(manifest: Record<string, unknown>, kitDir = ""): Promise<KitTargetsResult> {
  const kitId = typeof manifest.id === "string" ? manifest.id : "<unknown>";
  const kitName = typeof manifest.name === "string" ? manifest.name : "<unknown>";

  // Delegate core container validation to @kontourai/flow.
  const coreErrors = await delegateCoreContainerValidation(kitDir, manifest);
  const k0 = coreErrors.length === 0;

  const hasAgentExtension = AGENT_EXTENSION_CLASSES.size > 0 &&
    [...AGENT_EXTENSION_CLASSES].some((cls) => Array.isArray(manifest[cls]) && (manifest[cls] as unknown[]).length > 0);

  const hasEvals = Array.isArray(manifest["evals"]) && (manifest["evals"] as unknown[]).length > 0;

  const k1 = k0 && hasAgentExtension;
  const k2 = k1 && hasEvals;

  // Detect third-party extension namespaces: top-level keys that are neither
  // core fields nor Flow Agents extension classes.
  const thirdPartyExtensions: string[] = Object.keys(manifest)
    .filter((key) => !CORE_CONTAINER_FIELDS.has(key) && !AGENT_EXTENSION_CLASSES.has(key) && !KNOWN_METADATA_FIELDS.has(key))
    .sort();

  const targets: KitTargetConsumer[] = [];
  if (k0) targets.push("flow");
  if (k1) targets.push("flow-agents");
  for (const ns of thirdPartyExtensions) targets.push(ns);

  // Derive trust level orthogonally to the K-level capability axis.
  const trust = deriveKitTrust(kitId);

  return {
    kit_id: kitId,
    kit_name: kitName,
    conformance: { k0, k1, k2 },
    targets,
    third_party_extensions: thirdPartyExtensions,
    trust,
  };
}

export async function validateKitRepository(kitDir: string): Promise<string[]> {
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
  const coreErrors = await delegateCoreContainerValidation(kitDir, manifest);
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

  // Flow Agents metadata: cross-kit dependency declarations (extension-layer;
  // see docs/adr/0019-kit-dependency-ownership.md). Shape-only here — presence is
  // checked separately (non-blocking at install, hard error at activation).
  const depResult = parseKitDependencies(manifest, manifestPath);
  for (const err of depResult.errors) errors.push(err);

  return errors;
}

export async function assertKitRepository(kitDir: string): Promise<Record<string, unknown>> {
  const errors = await validateKitRepository(kitDir);
  if (errors.length) {
    const error = new Error("Flow Kit repository validation failed") as Error & { diagnostics?: string[] };
    error.diagnostics = errors;
    throw error;
  }
  return readJson(path.join(kitDir, "kit.json")) as Record<string, unknown>;
}
