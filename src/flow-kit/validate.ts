import fs from "node:fs";
import * as path from "node:path";
import { readJson } from "../lib/fs.js";
import { parseKitFlowStepActions, workflowTriggerIdentifier } from "./action-metadata.js";
import { validateActionRepositoryMetadata } from "./action-repository-validation.js";
export { isObservableBuilderArtifactRef, isSafeBuilderArtifactRef, parseKitFlowStepActions } from "./action-metadata.js";
export type { KitFlowStepActionEntry, KitFlowStepArtifactBinding, KitFlowStepExpectationBinding } from "./action-metadata.js";

// Extension-only asset classes: validated by Flow Agents. Flows are validated by @kontourai/flow.
const EXTENSION_ASSET_CLASSES = ["skills", "docs", "adapters", "evals", "assets"] as const;

// Core container fields owned by kontourai/flow (flow-kit-container.schema.json).
// agent-extension fields are skills, docs, adapters, evals, assets.
const CORE_CONTAINER_FIELDS = new Set(["schema_version", "id", "name", "description", "product_name", "flows"]);
const AGENT_EXTENSION_CLASSES = new Set(["skills", "docs", "adapters", "evals", "assets"]);

// Flow Agents-recognized metadata fields that are neither core container fields nor
// agent-extension asset classes. Recognized here so they are never misreported as
// unknown third-party extension namespaces. `dependencies` declares cross-kit skill
// dependencies (extension-layer ownership; see docs/adr/0019-kit-dependency-ownership.md),
// workflow_triggers / hook_influence_expectations declare kit-owned runtime influence,
// and first_party is legacy catalog/marketplace metadata. It does not grant runtime
// capability or steering privilege.
const KNOWN_METADATA_FIELDS = new Set(["dependencies", "workflow_triggers", "hook_influence_expectations", "flow_step_actions", "skill_roles", "first_party"]);

export interface KitDependencyEntry {
  kit_id: string;
  reason?: string;
}

export interface KitWorkflowTriggerEntry {
  id: string;
  when: string;
  target_flow_id?: string;
  default_skill?: string;
  conditional_skills?: { when: string; skill: string }[];
  required_sequence?: string[];
  post_verify_targets?: string[];
}

export interface KitHookInfluenceExpectationEntry {
  id: string;
  description: string;
  tier: string;
  hook?: string;
  event?: string;
  must_include_guidance: string[];
  must_include_actions: string[];
}

export type KitSkillRole = "entrypoint" | "profile" | "step" | "shared-primitive" | "extension";

export interface KitSkillRoleEntry {
  skill_id: string;
  role: KitSkillRole;
  flow_id?: string;
  step_ids: string[];
  artifacts: string[];
  expectation_ids: string[];
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

function nonEmptyStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function optionalWorkflowTriggerIdentifier(value: unknown): value is string | undefined {
  return value === undefined || workflowTriggerIdentifier(value);
}

function optionalWorkflowTriggerIdentifierList(value: unknown): value is string[] | undefined {
  return value === undefined || (Array.isArray(value) && value.length > 0 && value.every(workflowTriggerIdentifier));
}

function optionalConditionalSkills(value: unknown): value is { when: string; skill: string }[] | undefined {
  return value === undefined ||
    (Array.isArray(value) && value.every((item) =>
      typeof item === "object" && item !== null &&
      workflowTriggerIdentifier((item as Record<string, unknown>).when) &&
      workflowTriggerIdentifier((item as Record<string, unknown>).skill)
    ));
}

export function parseKitWorkflowTriggers(manifest: Record<string, unknown>, manifestPath: string): { entries: KitWorkflowTriggerEntry[]; errors: string[] } {
  const entries: KitWorkflowTriggerEntry[] = [];
  const errors: string[] = [];
  const raw = manifest.workflow_triggers;
  if (raw === undefined) return { entries, errors };
  if (!Array.isArray(raw)) {
    errors.push(`${manifestPath}: .workflow_triggers must be a list`);
    return { entries, errors };
  }
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      errors.push(`${manifestPath}: workflow_triggers[${index}] must be an object`);
      return;
    }
    const record = entry as Record<string, unknown>;
    const id = record.id;
    const when = record.when;
    if (!workflowTriggerIdentifier(id)) {
      errors.push(`${manifestPath}: workflow_triggers[${index}].id must match ^[a-z0-9]+(?:[.-][a-z0-9]+)*$`);
      return;
    }
    if (seen.has(id)) errors.push(`${manifestPath}: workflow_triggers[${index}].id duplicates '${id}'`);
    seen.add(id);
    if (!workflowTriggerIdentifier(when)) {
      errors.push(`${manifestPath}: workflow_triggers[${index}].when must match ^[a-z0-9]+(?:[.-][a-z0-9]+)*$`);
      return;
    }
    if (record.hint !== undefined) {
      errors.push(`${manifestPath}: workflow_triggers[${index}].hint is retired; use structured steering fields`);
      return;
    }
    if (record.display_name !== undefined) {
      errors.push(`${manifestPath}: workflow_triggers[${index}].display_name is not supported in workflow_triggers; use catalog/listing metadata for human-readable names`);
      return;
    }
    if (!optionalWorkflowTriggerIdentifier(record.target_flow_id)) {
      errors.push(`${manifestPath}: workflow_triggers[${index}].target_flow_id must match ^[a-z0-9]+(?:[.-][a-z0-9]+)*$ when present`);
      return;
    }
    if (!optionalWorkflowTriggerIdentifier(record.default_skill)) {
      errors.push(`${manifestPath}: workflow_triggers[${index}].default_skill must match ^[a-z0-9]+(?:[.-][a-z0-9]+)*$ when present`);
      return;
    }
    if (!optionalConditionalSkills(record.conditional_skills)) {
      errors.push(`${manifestPath}: workflow_triggers[${index}].conditional_skills must be a list of { when, skill } identifiers matching ^[a-z0-9]+(?:[.-][a-z0-9]+)*$ when present`);
      return;
    }
    if (!optionalWorkflowTriggerIdentifierList(record.required_sequence)) {
      errors.push(`${manifestPath}: workflow_triggers[${index}].required_sequence must be a non-empty identifier list matching ^[a-z0-9]+(?:[.-][a-z0-9]+)*$ when present`);
      return;
    }
    if (!optionalWorkflowTriggerIdentifierList(record.post_verify_targets)) {
      errors.push(`${manifestPath}: workflow_triggers[${index}].post_verify_targets must be a non-empty identifier list matching ^[a-z0-9]+(?:[.-][a-z0-9]+)*$ when present`);
      return;
    }
    entries.push({
      id,
      when,
      ...(typeof record.target_flow_id === "string" ? { target_flow_id: record.target_flow_id } : {}),
      ...(typeof record.default_skill === "string" ? { default_skill: record.default_skill } : {}),
      ...(Array.isArray(record.conditional_skills) ? { conditional_skills: record.conditional_skills as { when: string; skill: string }[] } : {}),
      ...(Array.isArray(record.required_sequence) ? { required_sequence: record.required_sequence as string[] } : {}),
      ...(Array.isArray(record.post_verify_targets) ? { post_verify_targets: record.post_verify_targets as string[] } : {}),
    });
  });
  return { entries, errors };
}

export function parseKitHookInfluenceExpectations(manifest: Record<string, unknown>, manifestPath: string): { entries: KitHookInfluenceExpectationEntry[]; errors: string[] } {
  const entries: KitHookInfluenceExpectationEntry[] = [];
  const errors: string[] = [];
  const raw = manifest.hook_influence_expectations;
  if (raw === undefined) return { entries, errors };
  if (!Array.isArray(raw)) {
    errors.push(`${manifestPath}: .hook_influence_expectations must be a list`);
    return { entries, errors };
  }
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      errors.push(`${manifestPath}: hook_influence_expectations[${index}] must be an object`);
      return;
    }
    const record = entry as Record<string, unknown>;
    const id = record.id;
    const description = record.description;
    const tier = record.tier;
    if (typeof id !== "string" || !id.trim()) {
      errors.push(`${manifestPath}: hook_influence_expectations[${index}].id must be a non-empty string`);
      return;
    }
    if (seen.has(id)) errors.push(`${manifestPath}: hook_influence_expectations[${index}].id duplicates '${id}'`);
    seen.add(id);
    if (typeof description !== "string" || !description.trim()) {
      errors.push(`${manifestPath}: hook_influence_expectations[${index}].description must be a non-empty string`);
      return;
    }
    if (typeof tier !== "string" || !tier.trim()) {
      errors.push(`${manifestPath}: hook_influence_expectations[${index}].tier must be a non-empty string`);
      return;
    }
    if (record.hook !== undefined && (typeof record.hook !== "string" || !record.hook.trim())) {
      errors.push(`${manifestPath}: hook_influence_expectations[${index}].hook must be a non-empty string when present`);
      return;
    }
    if (record.event !== undefined && (typeof record.event !== "string" || !record.event.trim())) {
      errors.push(`${manifestPath}: hook_influence_expectations[${index}].event must be a non-empty string when present`);
      return;
    }
    if (!nonEmptyStringList(record.must_include_guidance)) {
      errors.push(`${manifestPath}: hook_influence_expectations[${index}].must_include_guidance must be a non-empty string list`);
      return;
    }
    if (!nonEmptyStringList(record.must_include_actions)) {
      errors.push(`${manifestPath}: hook_influence_expectations[${index}].must_include_actions must be a non-empty string list`);
      return;
    }
    entries.push({
      id,
      description,
      tier,
      ...(typeof record.hook === "string" ? { hook: record.hook } : {}),
      ...(typeof record.event === "string" ? { event: record.event } : {}),
      must_include_guidance: record.must_include_guidance,
      must_include_actions: record.must_include_actions,
    });
  });
  return { entries, errors };
}

export function parseKitSkillRoles(manifest: Record<string, unknown>, manifestPath: string): { entries: KitSkillRoleEntry[]; errors: string[] } {
  const entries: KitSkillRoleEntry[] = [];
  const errors: string[] = [];
  const raw = manifest.skill_roles;
  if (raw === undefined) return { entries, errors };
  if (!Array.isArray(raw)) {
    errors.push(`${manifestPath}: .skill_roles must be a list`);
    return { entries, errors };
  }
  const roles = new Set<KitSkillRole>(["entrypoint", "profile", "step", "shared-primitive", "extension"]);
  const fields = new Set(["skill_id", "role", "flow_id", "step_ids", "artifacts", "expectation_ids"]);
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      errors.push(`${manifestPath}: skill_roles[${index}] must be an object`);
      return;
    }
    const record = entry as Record<string, unknown>;
    const unknown = Object.keys(record).filter((field) => !fields.has(field));
    if (unknown.length > 0) errors.push(`${manifestPath}: skill_roles[${index}] contains unsupported field(s): ${unknown.join(", ")}`);
    if (!workflowTriggerIdentifier(record.skill_id)) {
      errors.push(`${manifestPath}: skill_roles[${index}].skill_id must be an identifier`);
      return;
    }
    if (seen.has(record.skill_id)) errors.push(`${manifestPath}: skill_roles[${index}].skill_id duplicates '${record.skill_id}'`);
    seen.add(record.skill_id);
    if (typeof record.role !== "string" || !roles.has(record.role as KitSkillRole)) {
      errors.push(`${manifestPath}: skill_roles[${index}].role must be entrypoint, profile, step, shared-primitive, or extension`);
      return;
    }
    const role = record.role as KitSkillRole;
    if (record.flow_id !== undefined && !workflowTriggerIdentifier(record.flow_id)) {
      errors.push(`${manifestPath}: skill_roles[${index}].flow_id must be a Flow identifier when present`);
    }
    for (const field of ["step_ids", "expectation_ids"] as const) {
      const value = record[field];
      if (!Array.isArray(value) || !value.every(workflowTriggerIdentifier) || new Set(value).size !== value.length) {
        errors.push(`${manifestPath}: skill_roles[${index}].${field} must be a unique identifier list`);
      }
    }
    if (!Array.isArray(record.artifacts) || !record.artifacts.every((artifact) => typeof artifact === "string" && artifact.trim().length > 0) || new Set(record.artifacts).size !== record.artifacts.length) {
      errors.push(`${manifestPath}: skill_roles[${index}].artifacts must be a unique non-empty string list`);
    }
    const stepIds = Array.isArray(record.step_ids) ? record.step_ids.filter(workflowTriggerIdentifier) : [];
    const expectationIds = Array.isArray(record.expectation_ids) ? record.expectation_ids.filter(workflowTriggerIdentifier) : [];
    const artifacts = Array.isArray(record.artifacts) ? record.artifacts.filter((artifact): artifact is string => typeof artifact === "string" && artifact.trim().length > 0) : [];
    const flowId = typeof record.flow_id === "string" && workflowTriggerIdentifier(record.flow_id) ? record.flow_id : undefined;
    if ((role === "entrypoint" || role === "profile") && (!flowId || stepIds.length > 0 || expectationIds.length > 0 || artifacts.length > 0)) {
      errors.push(`${manifestPath}: skill_roles[${index}] ${role} must select one flow and own no steps, artifacts, or expectations`);
    }
    if (role === "step" && (!flowId || stepIds.length === 0 || artifacts.length === 0)) {
      errors.push(`${manifestPath}: skill_roles[${index}] step must bind one flow, at least one step, and at least one artifact`);
    }
    if (role === "shared-primitive" && (flowId || stepIds.length > 0 || expectationIds.length > 0 || artifacts.length === 0)) {
      errors.push(`${manifestPath}: skill_roles[${index}] ${role} must own artifacts but no Builder flow, steps, or expectations`);
    }
    if (role === "extension" && (flowId || stepIds.length > 0 || expectationIds.length > 0)) {
      errors.push(`${manifestPath}: skill_roles[${index}] extension must own no Builder flow, steps, or expectations`);
    }
    entries.push({ skill_id: record.skill_id, role, ...(flowId ? { flow_id: flowId } : {}), step_ids: stepIds, artifacts, expectation_ids: expectationIds });
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
 * Runtime steering and capability decisions do not branch on official/built-in provenance.
 */
export type KitTrustLevel = "verified" | "unverified";

export type KitSourceKind = "builtin" | "local" | "unknown";

export interface KitTrustOptions {
  source_kind?: KitSourceKind;
  kitDir?: string;
  sourceRoot?: string;
}

/**
 * Derive the trust level for a kit id.
 * "verified" is reserved for future third-party verification.
 */
export function deriveKitTrust(kitId: string, manifest?: Record<string, unknown>, options: KitTrustOptions = {}): KitTrustLevel {
  void kitId;
  void manifest;
  void options;
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
   * "verified" = reserved (future); "unverified" = default.
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
 * Trust derivation:
 *  - "unverified": all current kits (default; "verified" is reserved for a future process).
 *    kit.json `first_party` is catalog metadata and is not trusted for runtime privilege.
 *
 * @param manifest  The kit.json manifest object.
 * @param kitDir    Kit directory for flow file-existence checks. Defaults to "" (structural-only).
 *                  Pass the real kit directory from `inspect` to get authoritative K0 validation.
 */
export async function deriveKitTargets(manifest: Record<string, unknown>, kitDir = "", sourceRoot = process.cwd()): Promise<KitTargetsResult> {
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
  const trust = deriveKitTrust(kitId, manifest, { kitDir, sourceRoot });

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

  errors.push(...await delegateCoreContainerValidation(kitDir, manifest));
  errors.push(...validateExtensionAssets(kitDir, manifestPath, manifest));
  errors.push(...validateAgentMetadata(kitDir, manifestPath, manifest));
  if (manifest.first_party !== undefined && typeof manifest.first_party !== "boolean") errors.push(`${manifestPath}: .first_party must be a boolean when present`);
  return errors;
}

function validateExtensionAssets(kitDir: string, manifestPath: string, manifest: Record<string, unknown>): string[] {
  const errors: string[] = [];
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

function validateAgentMetadata(kitDir: string, manifestPath: string, manifest: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const depResult = parseKitDependencies(manifest, manifestPath);
  for (const err of depResult.errors) errors.push(err);
  const workflowTriggerResult = parseKitWorkflowTriggers(manifest, manifestPath);
  for (const err of workflowTriggerResult.errors) errors.push(err);
  const hookExpectationResult = parseKitHookInfluenceExpectations(manifest, manifestPath);
  for (const err of hookExpectationResult.errors) errors.push(err);
  const flowStepActionResult = parseKitFlowStepActions(manifest, manifestPath);
  for (const err of flowStepActionResult.errors) errors.push(err);
  const skillRoleResult = parseKitSkillRoles(manifest, manifestPath);
  for (const err of skillRoleResult.errors) errors.push(err);
  if ((manifest.skill_roles !== undefined || manifest.flow_step_actions !== undefined) && skillRoleResult.errors.length === 0) {
    errors.push(...validateActionRepositoryMetadata({ kitDir, manifestPath, manifest, actions: flowStepActionResult.entries, skillRoles: skillRoleResult.entries }));
  }
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
