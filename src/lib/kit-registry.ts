import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteJson } from "./fs.js";
import { durableInstallRecordPath } from "./local-artifact-root.js";
import { parseKitDependencies } from "../flow-kit/validate.js";

/**
 * Built-in kit activation lifecycle (kontourai/flow-agents kit activation registry).
 *
 * Shared by:
 *   - `flow-agents init` (src/cli/init.ts), which populates a fresh install's `active_kits`
 *     durable-record field to RECORD what is actually installed (today: every catalog kit for
 *     claude-code, whatever `--activate-kit`/`--activate-kits` selected for other runtimes).
 *   - `flow-agents kit activate <id>` / `flow-agents kit deactivate <id>` (src/cli/kit.ts), which
 *     mutate `active_kits` for a single built-in kit after installing/removing its skill files.
 *   - `scripts/hooks/lib/kit-catalog.js`, which consults `active_kits` (when present) to decide
 *     whether a deactivated built-in kit's `workflow_triggers` should still steer a session.
 *
 * Deliberately reads the built-in Kit Catalog (`kits/catalog.json`) from the CURRENTLY EXECUTING
 * package's own root (`packageRoot`, e.g. `src/tools/common.js`'s `root`), never from `dest` --
 * the catalog is package-shipped metadata, not per-destination state (mirrors the existing
 * `resolveCatalogKitSource`/`catalogKitIds`/`kitPathForInit` pattern already used by
 * src/cli/kit.ts and src/cli/init.ts).
 */

export type KitScope = "global" | "project";

export type ActiveKitEntry = {
  id: string;
  version: string;
  activated_at: string;
  scope: KitScope;
};

type CatalogKitEntry = { id: string; path: string };

/** Read the built-in Kit Catalog (`kits/catalog.json`) relative to `packageRoot`. Never throws. */
export function loadCatalog(packageRoot: string): CatalogKitEntry[] {
  const catalogPath = path.join(packageRoot, "kits", "catalog.json");
  if (!fs.existsSync(catalogPath)) return [];
  let catalog: { kits?: unknown[] };
  try {
    catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as { kits?: unknown[] };
  } catch {
    return [];
  }
  if (!Array.isArray(catalog.kits)) return [];
  const entries: CatalogKitEntry[] = [];
  for (const raw of catalog.kits) {
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id) continue;
    if (typeof record.path !== "string" || !record.path) continue;
    entries.push({ id: record.id, path: record.path });
  }
  return entries;
}

export function catalogKitIds(packageRoot: string): string[] {
  return loadCatalog(packageRoot).map((entry) => entry.id);
}

export function resolveCatalogKitDir(packageRoot: string, kitId: string): string | null {
  const entry = loadCatalog(packageRoot).find((candidate) => candidate.id === kitId);
  return entry ? path.resolve(packageRoot, entry.path) : null;
}

export type LoadedCatalogKit = { manifest: Record<string, unknown>; manifestPath: string; kitDir: string };

/** Load and parse a built-in kit's `kit.json` by catalog id. Returns null (never throws) when the
 * id is not in the catalog, the kit directory is missing, or `kit.json` is missing/invalid. */
export function loadCatalogKitManifest(packageRoot: string, kitId: string): LoadedCatalogKit | null {
  const kitDir = resolveCatalogKitDir(packageRoot, kitId);
  if (!kitDir) return null;
  const manifestPath = path.join(kitDir, "kit.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    return { manifest, manifestPath, kitDir };
  } catch {
    return null;
  }
}

/** Declared dependency kit ids for a built-in kit's manifest -- reuses `parseKitDependencies`
 * (src/flow-kit/validate.ts), the single existing shape-validated reader of `kit.json`'s
 * `dependencies` field, instead of re-parsing the same field a second way. */
export function kitDependencyIds(manifest: Record<string, unknown>, manifestPath: string): string[] {
  return parseKitDependencies(manifest, manifestPath).entries.map((entry) => entry.kit_id);
}

/**
 * Skill directory (install) names a built-in kit declares, derived exactly the way
 * `src/tools/build-universal-bundles.ts`'s `collectAllSkills()` derives a kit-owned skill's
 * install name: the basename of the directory containing the declared `SKILL.md`, resolved
 * relative to the kit's own directory. Compiled host bundles ship skills flat
 * (`.claude/skills/<name>/SKILL.md`), so this is also exactly the directory name a kit's skills
 * live under at any claude-code install destination.
 */
export function catalogKitSkillNames(packageRoot: string, kitId: string): string[] {
  const loaded = loadCatalogKitManifest(packageRoot, kitId);
  if (!loaded) return [];
  const skills = Array.isArray(loaded.manifest.skills) ? (loaded.manifest.skills as unknown[]) : [];
  const names = new Set<string>();
  for (const entry of skills) {
    if (typeof entry !== "object" || entry === null) continue;
    const relPath = (entry as Record<string, unknown>).path;
    if (typeof relPath !== "string" || !relPath) continue;
    const absPath = path.resolve(loaded.kitDir, relPath);
    names.add(path.basename(path.dirname(absPath)));
  }
  return [...names].sort();
}

export function readPackageVersion(packageRoot: string): string {
  try {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as Record<string, unknown>;
    return typeof pkgJson.version === "string" && pkgJson.version ? pkgJson.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ─── Durable install record: active_kits ───────────────────────────────────────────────────

/** Read the durable install record (`.flow-agents/install.json`) at `dest`, or null (never
 * throws) when absent/unreadable. */
export function readInstallRecord(dest: string): Record<string, unknown> | null {
  const recordPath = durableInstallRecordPath(dest);
  if (!fs.existsSync(recordPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(recordPath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Parse `install.json`'s `active_kits` field into well-shaped entries. Returns null (distinct
 * from an empty array) when the record is absent or the field itself is absent/malformed --
 * callers use this to distinguish "legacy record, no activation data available" (null: leave
 * existing behavior unchanged) from "recorded and genuinely empty" ([]: no active kits). */
export function readActiveKits(dest: string): ActiveKitEntry[] | null {
  const record = readInstallRecord(dest);
  if (!record || !Array.isArray(record.active_kits)) return null;
  const entries: ActiveKitEntry[] = [];
  for (const raw of record.active_kits) {
    if (typeof raw !== "object" || raw === null) continue;
    const candidate = raw as Record<string, unknown>;
    if (typeof candidate.id !== "string" || !candidate.id) continue;
    entries.push({
      id: candidate.id,
      version: typeof candidate.version === "string" ? candidate.version : "",
      activated_at: typeof candidate.activated_at === "string" ? candidate.activated_at : "",
      scope: candidate.scope === "global" ? "global" : "project",
    });
  }
  return entries;
}

/** Structural + catalog validation for an `active_kits` array: every entry must be well-shaped
 * and reference a kit id present in `validKitIds` (unknown kits rejected). Returns an empty
 * array when valid. */
export function validateActiveKitEntries(entries: ActiveKitEntry[], validKitIds: Set<string>): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry.id !== "string" || !entry.id) {
      errors.push("active_kits entry missing a valid id");
      continue;
    }
    if (seen.has(entry.id)) {
      errors.push(`active_kits duplicate id '${entry.id}'`);
      continue;
    }
    seen.add(entry.id);
    if (!validKitIds.has(entry.id)) {
      errors.push(`active_kits references unknown kit id '${entry.id}'`);
      continue;
    }
    if (entry.scope !== "global" && entry.scope !== "project") {
      errors.push(`active_kits entry '${entry.id}' has invalid scope '${String(entry.scope)}'`);
    }
    if (typeof entry.activated_at !== "string" || !entry.activated_at || Number.isNaN(Date.parse(entry.activated_at))) {
      errors.push(`active_kits entry '${entry.id}' has invalid activated_at`);
    }
    if (typeof entry.version !== "string") {
      errors.push(`active_kits entry '${entry.id}' has invalid version`);
    }
  }
  return errors;
}

/**
 * Atomic read-modify-write of `install.json`'s `active_kits` field only -- every other field on
 * the record (version, installedAt, runtime, global, active_kit_ids, ...) is preserved verbatim.
 * Schema-validates (shape + catalog membership) before writing; throws rather than persisting an
 * invalid record. Requires the durable install record to already exist (created by `flow-agents
 * init`) -- `kit activate`/`kit deactivate` are extensions to an existing install, not a
 * substitute for one.
 */
export function writeActiveKits(dest: string, packageRoot: string, activeKits: ActiveKitEntry[]): void {
  const validIds = new Set(catalogKitIds(packageRoot));
  const errors = validateActiveKitEntries(activeKits, validIds);
  if (errors.length) throw new Error(`refusing to write invalid active_kits: ${errors.join("; ")}`);
  const recordPath = durableInstallRecordPath(dest);
  if (!fs.existsSync(recordPath)) {
    throw new Error(`no durable install record found at ${recordPath}; run 'flow-agents init' first`);
  }
  let existing: Record<string, unknown>;
  try {
    existing = JSON.parse(fs.readFileSync(recordPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`existing install record is not valid JSON, refusing to modify it: ${recordPath}: ${(error as Error).message}`);
  }
  const next = { ...existing, active_kits: activeKits };
  atomicWriteJson(dest, recordPath, next);
}
