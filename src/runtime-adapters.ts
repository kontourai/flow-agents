import * as fs from "node:fs";
import * as path from "node:path";
import { atomicCopyFile, atomicWriteJson, ensureSafeDirectory, readJson, relPath } from "./lib/fs.js";
import { flowAgentsArtifactRoot } from "./lib/local-artifact-root.js";
import { parseKitDependencies, parseKitHookInfluenceExpectations, parseKitWorkflowTriggers } from "./flow-kit/validate.js";

export type KitAsset = {
  kit_id: string;
  kit_name: string;
  asset_class: string;
  asset_id: string | null;
  relative_path: string;
  source_path: string;
  source_kind: string;
  description?: string;
};

export type KitWorkflowTriggerRef = {
  kit_id: string;
  source_kind: string;
  id: string;
  when: string;
  target_flow_id?: string;
  default_skill?: string;
  conditional_skills?: { when: string; skill: string }[];
  required_sequence?: string[];
  post_verify_targets?: string[];
};
export type KitHookInfluenceExpectationRef = {
  kit_id: string;
  source_kind: string;
  id: string;
  description: string;
  tier: string;
  hook?: string;
  event?: string;
  must_include_guidance: string[];
  must_include_actions: string[];
};

export type KitInventory = {
  assets: KitAsset[];
  dependencies: KitDependencyRef[];
  workflow_triggers: KitWorkflowTriggerRef[];
  hook_influence_expectations: KitHookInfluenceExpectationRef[];
  warnings: string[];
  errors: string[];
};

/** A cross-kit dependency edge discovered while loading a kit manifest. */
export type KitDependencyRef = { from_kit_id: string; kit_id: string; reason?: string };

/** The parsed result of a single kit manifest: its id, activatable assets, and declared dependencies. */
export type LoadedKit = {
  kit_id: string;
  assets: KitAsset[];
  dependencies: KitDependencyRef[];
  workflow_triggers: KitWorkflowTriggerRef[];
  hook_influence_expectations: KitHookInfluenceExpectationRef[];
};

const ASSET_CLASSES = ["flows", "skills", "docs", "adapters", "evals", "assets"];
const KIT_ID_RE = /^[a-z][a-z0-9-]*$/;

function assetPath(root: string, value: string): string | null {
  if (path.isAbsolute(value)) return null;
  const resolved = path.resolve(root, value);
  const absRoot = path.resolve(root);
  return resolved === absRoot || resolved.startsWith(`${absRoot}${path.sep}`) ? resolved : null;
}

function loadKitAssets(kitRoot: string, sourceKind: string, warnings: string[], errors: string[]): LoadedKit {
  const manifestPath = path.join(kitRoot, "kit.json");
  if (!fs.existsSync(manifestPath)) {
    errors.push(`${kitRoot}: missing kit.json`);
    return { kit_id: "", assets: [], dependencies: [], workflow_triggers: [], hook_influence_expectations: [] };
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = readJson(manifestPath) as Record<string, unknown>;
  } catch (error) {
    errors.push(`${manifestPath}: ${(error as Error).message}`);
    return { kit_id: "", assets: [], dependencies: [], workflow_triggers: [], hook_influence_expectations: [] };
  }
  const kitId = typeof manifest.id === "string" ? manifest.id : "";
  const kitName = typeof manifest.name === "string" ? manifest.name : kitId;
  if (!KIT_ID_RE.test(kitId)) {
    errors.push(`${manifestPath}: kit id must be a kebab-case id (^[a-z][a-z0-9-]*$)`);
    return { kit_id: "", assets: [], dependencies: [], workflow_triggers: [], hook_influence_expectations: [] };
  }
  const assets: KitAsset[] = [];
  for (const assetClass of ASSET_CLASSES) {
    const entries = manifest[assetClass];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) {
      warnings.push(`${kitId}: ${assetClass} must be a list; skipping section`);
      continue;
    }
    for (const entry of entries) {
      let rel: string | undefined;
      let assetId: string | null = null;
      let description: string | undefined;
      if (typeof entry === "string") rel = entry;
      else if (typeof entry === "object" && entry !== null) {
        const record = entry as Record<string, unknown>;
        rel = typeof record.path === "string" ? record.path : undefined;
        assetId = typeof record.id === "string" ? record.id : null;
        description = typeof record.description === "string" ? record.description : undefined;
      }
      if (!rel) {
        warnings.push(`${kitId}: ${assetClass} entry missing string path`);
        continue;
      }
      const source = assetPath(kitRoot, rel);
      if (!source) {
        warnings.push(`${kitId}: ${assetClass} asset path is not local: ${rel}`);
        continue;
      }
      if (!fs.existsSync(source)) {
        warnings.push(`${kitId}: ${assetClass} asset path is missing: ${rel}`);
        continue;
      }
      assets.push({ kit_id: kitId, kit_name: kitName, asset_class: assetClass, asset_id: assetId, relative_path: rel, source_path: source, source_kind: sourceKind, description });
    }
  }
  // Parse cross-kit dependency declarations (extension-layer metadata; see
  // docs/adr/0019-kit-dependency-ownership.md). Shape errors surface at
  // install/inspect/validate time via validateKitRepository; here we only collect
  // the edges so activation can enforce presence against the full inventory.
  const dependencyResult = parseKitDependencies(manifest, manifestPath);
  if (dependencyResult.errors.length) {
    errors.push(...dependencyResult.errors);
    warnings.push(`${kitId}: invalid dependencies metadata; skipping dependencies`);
  }
  const dependencies: KitDependencyRef[] = dependencyResult.errors.length ? [] : dependencyResult.entries
    .map((dep) => ({ from_kit_id: kitId, kit_id: dep.kit_id, ...(dep.reason ? { reason: dep.reason } : {}) }));
  const workflowTriggerResult = parseKitWorkflowTriggers(manifest, manifestPath);
  if (workflowTriggerResult.errors.length) {
    errors.push(...workflowTriggerResult.errors);
    warnings.push(`${kitId}: invalid workflow_triggers metadata; skipping workflow_triggers`);
  }
  const workflow_triggers: KitWorkflowTriggerRef[] = workflowTriggerResult.errors.length ? [] : workflowTriggerResult.entries
    .map((trigger) => ({ kit_id: kitId, source_kind: sourceKind, ...trigger }));
  const hookInfluenceResult = parseKitHookInfluenceExpectations(manifest, manifestPath);
  if (hookInfluenceResult.errors.length) {
    errors.push(...hookInfluenceResult.errors);
    warnings.push(`${kitId}: invalid hook_influence_expectations metadata; skipping hook_influence_expectations`);
  }
  const hook_influence_expectations: KitHookInfluenceExpectationRef[] = hookInfluenceResult.errors.length ? [] : hookInfluenceResult.entries
    .map((expectation) => ({ kit_id: kitId, source_kind: sourceKind, ...expectation }));
  return { kit_id: kitId, assets, dependencies, workflow_triggers, hook_influence_expectations };
}

function expandKitIdFilter(requested: Set<string> | undefined, dependencies: KitDependencyRef[], presentKitIds: Set<string>): Set<string> | undefined {
  if (!requested) return undefined;
  const selected = new Set(requested);
  let changed = true;
  while (changed) {
    changed = false;
    for (const dep of dependencies) {
      if (!selected.has(dep.from_kit_id) || selected.has(dep.kit_id) || !presentKitIds.has(dep.kit_id)) continue;
      selected.add(dep.kit_id);
      changed = true;
    }
  }
  return selected;
}

export function readKitInventory(sourceRoot: string, dest: string, options: { kitIdFilter?: string[] } = {}): KitInventory {
  const warnings: string[] = [];
  const errors: string[] = [];
  const assets: KitAsset[] = [];
  const dependencies: KitDependencyRef[] = [];
  const workflow_triggers: KitWorkflowTriggerRef[] = [];
  const hook_influence_expectations: KitHookInfluenceExpectationRef[] = [];
  const loadedKits: LoadedKit[] = [];
  const presentKitIds = new Set<string>();
  const kitIdFilter = options.kitIdFilter ? new Set(options.kitIdFilter) : undefined;
  const catalogPath = path.join(sourceRoot, "kits", "catalog.json");
  if (!fs.existsSync(catalogPath)) warnings.push(`${catalogPath}: built-in Kit Catalog not found; skipping built-in kits (this is normal when running outside a flow-agents checkout)`);
  else {
    const catalog = readJson(catalogPath) as Record<string, unknown>;
    const kits = catalog.kits;
    if (Array.isArray(kits)) {
      kits.forEach((entry, index) => {
        const rel = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>).path : undefined;
        if (typeof rel !== "string") {
          warnings.push(`${catalogPath}: kits[${index}].path missing; skipping`);
          return;
        }
        const kitRoot = assetPath(sourceRoot, rel);
        if (!kitRoot || !fs.existsSync(kitRoot)) warnings.push(`${catalogPath}: kits[${index}].path unavailable: ${rel}`);
        else {
          const loaded = loadKitAssets(kitRoot, "builtin", warnings, errors);
          loadedKits.push(loaded);
          if (loaded.kit_id) presentKitIds.add(loaded.kit_id);
        }
      });
    }
  }
  const registryPath = path.join(dest, "kits", "local", "installed-kits.json");
  if (fs.existsSync(registryPath)) {
    const registry = readJson(registryPath) as Record<string, unknown>;
    const kits = registry.kits;
    if (Array.isArray(kits)) {
      kits.forEach((entry) => {
        if (typeof entry !== "object" || entry === null) return;
        const record = entry as Record<string, unknown>;
        const id = record.id;
        if (typeof id !== "string") return;
        const kitRoot = path.join(dest, "kits", "local", "repositories", id);
        if (!fs.existsSync(kitRoot)) warnings.push(`${id}: installed kit copy missing at ${kitRoot}; skipping`);
        else {
          const loaded = loadKitAssets(kitRoot, "local", warnings, errors);
          loadedKits.push(loaded);
          if (loaded.kit_id) presentKitIds.add(loaded.kit_id);
        }
      });
    }
  }
  const allDependencies = loadedKits.flatMap((kit) => kit.dependencies);
  const selectedKitIds = expandKitIdFilter(kitIdFilter, allDependencies, presentKitIds);
  for (const loaded of loadedKits) {
    if (selectedKitIds && !selectedKitIds.has(loaded.kit_id)) continue;
    assets.push(...loaded.assets);
    dependencies.push(...loaded.dependencies);
    workflow_triggers.push(...loaded.workflow_triggers);
    hook_influence_expectations.push(...loaded.hook_influence_expectations);
  }
  // Activation-time cross-kit dependency enforcement: any declared dependency whose
  // kit_id is not present among the union of built-in catalog kits and locally-installed
  // kits is a hard error (feeds the errors[] -> activation-manifest -> non-zero exit path).
  for (const dep of dependencies) {
    if (!presentKitIds.has(dep.kit_id)) {
      errors.push(`${dep.from_kit_id}: declares a dependency on kit '${dep.kit_id}'${dep.reason ? ` (${dep.reason})` : ""} which is not installed or activated. Install it with 'flow-agents kit install <source>' and re-activate, or remove the dependency declaration if it is no longer needed.`);
    }
  }
  return { assets, dependencies, workflow_triggers, hook_influence_expectations, warnings, errors };
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "") || "asset";
}

// Asset classes that are directly activated (copied to the runtime directory) by both adapters.
// flows: gate definitions read by the adapter's flow-routing layer.
// skills: agent guidance markdown copied to skills/<kit-id>/ for agent discovery.
// docs: documentation markdown copied to docs/<kit-id>/ for agent reference.
const ACTIVATED_ASSET_CLASSES = new Set(["flows", "skills", "docs"]);

export function activateCodexLocal(sourceRoot: string, dest: string, options: { kitIdFilter?: string[] } = {}): Record<string, unknown> {
  const inventory = readKitInventory(sourceRoot, dest, options);
  const runtimeDir = path.join(flowAgentsArtifactRoot(dest), "projections", "codex");
  const writeRoot = path.resolve(runtimeDir, "../../..");
  ensureSafeDirectory(writeRoot, runtimeDir);
  const generated: Record<string, string>[] = [];
  const skipped: Record<string, string | null>[] = [];
  for (const asset of inventory.assets) {
    if (asset.asset_class === "flows") {
      if (!asset.asset_id) {
        skipped.push({ asset_class: asset.asset_class, path: asset.relative_path, kit_id: asset.kit_id, asset_id: null, reason: "flow asset is missing an id" });
        continue;
      }
      const output = path.join(runtimeDir, "flows", safeSegment(asset.kit_id), `${safeSegment(asset.asset_id)}.flow.json`);
      atomicCopyFile(writeRoot, asset.source_path, output);
      generated.push({ asset_class: asset.asset_class, path: relPath(dest, output), kit_id: asset.kit_id, asset_id: asset.asset_id, source_path: asset.source_path.split(path.sep).join("/") });
    } else if (asset.asset_class === "skills" || asset.asset_class === "docs") {
      // Copy skills and docs to runtime/<adapter>/<class>/<kit-id>/<filename> so the
      // agent's guidance index (AGENTS.md) can reference them and they are co-located
      // with flow definitions for the same kit.
      const filename = path.basename(asset.source_path);
      // Namespace skills by BOTH kit id AND the skill's own directory name: every skill
      // file is literally named SKILL.md, so keying only on kit id collides all of a
      // kit's skills onto one .../<kit-id>/SKILL.md file. Docs keep the flat
      // <kit-id>/<filename> layout (no per-directory collision found).
      const output = asset.asset_class === "skills"
        ? path.join(runtimeDir, asset.asset_class, safeSegment(asset.kit_id), safeSegment(path.basename(path.dirname(asset.source_path))), filename)
        : path.join(runtimeDir, asset.asset_class, safeSegment(asset.kit_id), filename);
      atomicCopyFile(writeRoot, asset.source_path, output);
      generated.push({ asset_class: asset.asset_class, path: relPath(dest, output), kit_id: asset.kit_id, asset_id: asset.asset_id ?? "", source_path: asset.source_path.split(path.sep).join("/") });
    } else {
      skipped.push({ asset_class: asset.asset_class, path: asset.relative_path, kit_id: asset.kit_id, asset_id: asset.asset_id, reason: "asset class is not activated by codex-local" });
    }
  }
  const supportedClasses = Array.from(ACTIVATED_ASSET_CLASSES);
  const manifest = { schema_version: "1.0", adapter: "codex-local", supported_asset_classes: supportedClasses, generated_runtime_files: generated, skipped_assets: skipped, warnings: inventory.warnings, errors: inventory.errors };
  const manifestPath = path.join(runtimeDir, "activation.json");
  atomicWriteJson(writeRoot, manifestPath, manifest);
  generated.push({ asset_class: "activation-manifest", path: relPath(dest, manifestPath), kit_id: "runtime", asset_id: "codex-local.activation", source_path: manifestPath.split(path.sep).join("/") });
  return { selected_adapter: "codex-local", supported_asset_classes: supportedClasses, generated_runtime_files: generated, skipped_assets: skipped, warnings: inventory.warnings, errors: inventory.errors };
}

// Decision Q3 (Issue #32): Option (a) — new adapter id "strands-local" rather than
// loading kit flows inside FlowAgentsHooks. Rationale: activation is a workspace-prep
// concern (reads catalog + installed kits, writes runtime files, produces diagnostics).
// Keeping it in the CLI adapter layer maximises reuse of readKitInventory and safeSegment,
// mirrors the codex-local pattern exactly, and keeps framework adapters free of catalog-
// layout knowledge. The Strands steering layer then reads the written runtime files.
export function activateStrandsLocal(sourceRoot: string, dest: string, options: { kitIdFilter?: string[] } = {}): Record<string, unknown> {
  const inventory = readKitInventory(sourceRoot, dest, options);
  // Runtime flows land at .kontourai/flow-agents/projections/strands/flows/<kit-id>/<asset-id>.flow.json
  // so the Strands steering context can glob for *.flow.json under this path.
  // Runtime skills land at .kontourai/flow-agents/projections/strands/skills/<kit-id>/<filename> and
  // docs at .kontourai/flow-agents/projections/strands/docs/<kit-id>/<filename> for system-prompt injection.
  const runtimeDir = path.join(flowAgentsArtifactRoot(dest), "projections", "strands");
  const writeRoot = path.resolve(runtimeDir, "../../..");
  ensureSafeDirectory(writeRoot, runtimeDir);
  const generated: Record<string, string>[] = [];
  const skipped: Record<string, string | null>[] = [];
  for (const asset of inventory.assets) {
    if (asset.asset_class === "flows") {
      if (!asset.asset_id) {
        skipped.push({ asset_class: asset.asset_class, path: asset.relative_path, kit_id: asset.kit_id, asset_id: null, reason: "flow asset is missing an id" });
        continue;
      }
      const output = path.join(runtimeDir, "flows", safeSegment(asset.kit_id), `${safeSegment(asset.asset_id)}.flow.json`);
      atomicCopyFile(writeRoot, asset.source_path, output);
      generated.push({ asset_class: asset.asset_class, path: relPath(dest, output), kit_id: asset.kit_id, asset_id: asset.asset_id, source_path: asset.source_path.split(path.sep).join("/") });
    } else if (asset.asset_class === "skills" || asset.asset_class === "docs") {
      // Mirror the codex-local layout: strands/<class>/<kit-id>/<filename>.
      // The Strands system-prompt injection layer can glob for all *.md files under
      // .kontourai/flow-agents/projections/strands/skills/ to include agent guidance in the context.
      const filename = path.basename(asset.source_path);
      // Namespace skills by BOTH kit id AND the skill's own directory name: every skill
      // file is literally named SKILL.md, so keying only on kit id collides all of a
      // kit's skills onto one .../<kit-id>/SKILL.md file. Docs keep the flat
      // <kit-id>/<filename> layout (no per-directory collision found).
      const output = asset.asset_class === "skills"
        ? path.join(runtimeDir, asset.asset_class, safeSegment(asset.kit_id), safeSegment(path.basename(path.dirname(asset.source_path))), filename)
        : path.join(runtimeDir, asset.asset_class, safeSegment(asset.kit_id), filename);
      atomicCopyFile(writeRoot, asset.source_path, output);
      generated.push({ asset_class: asset.asset_class, path: relPath(dest, output), kit_id: asset.kit_id, asset_id: asset.asset_id ?? "", source_path: asset.source_path.split(path.sep).join("/") });
    } else {
      skipped.push({ asset_class: asset.asset_class, path: asset.relative_path, kit_id: asset.kit_id, asset_id: asset.asset_id, reason: "asset class is not activated by strands-local" });
    }
  }
  const supportedClasses = Array.from(ACTIVATED_ASSET_CLASSES);
  const manifest = { schema_version: "1.0", adapter: "strands-local", supported_asset_classes: supportedClasses, generated_runtime_files: generated, skipped_assets: skipped, warnings: inventory.warnings, errors: inventory.errors };
  const manifestPath = path.join(runtimeDir, "activation.json");
  atomicWriteJson(writeRoot, manifestPath, manifest);
  generated.push({ asset_class: "activation-manifest", path: relPath(dest, manifestPath), kit_id: "runtime", asset_id: "strands-local.activation", source_path: manifestPath.split(path.sep).join("/") });
  return { selected_adapter: "strands-local", supported_asset_classes: supportedClasses, generated_runtime_files: generated, skipped_assets: skipped, warnings: inventory.warnings, errors: inventory.errors };
}
