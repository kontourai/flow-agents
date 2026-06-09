import * as fs from "node:fs";
import * as path from "node:path";
import { readJson, relPath, writeJson } from "./lib/fs.js";

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

export type KitInventory = { assets: KitAsset[]; warnings: string[]; errors: string[] };

const ASSET_CLASSES = ["flows", "skills", "docs", "adapters", "evals", "assets"];

function assetPath(root: string, value: string): string | null {
  if (path.isAbsolute(value)) return null;
  const resolved = path.resolve(root, value);
  const absRoot = path.resolve(root);
  return resolved === absRoot || resolved.startsWith(`${absRoot}${path.sep}`) ? resolved : null;
}

function loadKitAssets(kitRoot: string, sourceKind: string, warnings: string[], errors: string[]): KitAsset[] {
  const manifestPath = path.join(kitRoot, "kit.json");
  if (!fs.existsSync(manifestPath)) {
    errors.push(`${kitRoot}: missing kit.json`);
    return [];
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = readJson(manifestPath) as Record<string, unknown>;
  } catch (error) {
    errors.push(`${manifestPath}: ${(error as Error).message}`);
    return [];
  }
  const kitId = typeof manifest.id === "string" ? manifest.id : "";
  const kitName = typeof manifest.name === "string" ? manifest.name : kitId;
  if (!kitId) {
    errors.push(`${manifestPath}: missing kit id`);
    return [];
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
  return assets;
}

export function readKitInventory(sourceRoot: string, dest: string): KitInventory {
  const warnings: string[] = [];
  const errors: string[] = [];
  const assets: KitAsset[] = [];
  const catalogPath = path.join(sourceRoot, "kits", "catalog.json");
  if (!fs.existsSync(catalogPath)) errors.push(`${catalogPath}: missing Kit Catalog`);
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
        else assets.push(...loadKitAssets(kitRoot, "builtin", warnings, errors));
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
        else assets.push(...loadKitAssets(kitRoot, "local", warnings, errors));
      });
    }
  }
  return { assets, warnings, errors };
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "") || "asset";
}

export function activateCodexLocal(sourceRoot: string, dest: string): Record<string, unknown> {
  const inventory = readKitInventory(sourceRoot, dest);
  const runtimeDir = path.join(dest, ".agents", "flow-agents", "runtime", "codex");
  const generated: Record<string, string>[] = [];
  const skipped: Record<string, string | null>[] = [];
  for (const asset of inventory.assets) {
    if (asset.asset_class !== "flows") {
      skipped.push({ asset_class: asset.asset_class, path: asset.relative_path, kit_id: asset.kit_id, asset_id: asset.asset_id, reason: "asset class is diagnostic-only for codex-local" });
      continue;
    }
    if (!asset.asset_id) {
      skipped.push({ asset_class: asset.asset_class, path: asset.relative_path, kit_id: asset.kit_id, asset_id: null, reason: "flow asset is missing an id" });
      continue;
    }
    const output = path.join(runtimeDir, "flows", safeSegment(asset.kit_id), `${safeSegment(asset.asset_id)}.flow.json`);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(asset.source_path, output);
    generated.push({ asset_class: asset.asset_class, path: relPath(dest, output), kit_id: asset.kit_id, asset_id: asset.asset_id, source_path: asset.source_path.split(path.sep).join("/") });
  }
  fs.mkdirSync(runtimeDir, { recursive: true });
  const manifest = { schema_version: "1.0", adapter: "codex-local", supported_asset_classes: ["flows"], generated_runtime_files: generated, skipped_assets: skipped, warnings: inventory.warnings, errors: inventory.errors };
  const manifestPath = path.join(runtimeDir, "activation.json");
  writeJson(manifestPath, manifest);
  generated.push({ asset_class: "activation-manifest", path: relPath(dest, manifestPath), kit_id: "runtime", asset_id: "codex-local.activation", source_path: manifestPath.split(path.sep).join("/") });
  return { selected_adapter: "codex-local", supported_asset_classes: ["flows"], generated_runtime_files: generated, skipped_assets: skipped, warnings: inventory.warnings, errors: inventory.errors };
}
