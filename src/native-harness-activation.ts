import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { atomicWriteFile, atomicWriteJson, ensureSafeDirectory } from "./lib/fs.js";
import { withStateFileLock } from "./lib/state-file-lock.js";
import { readKitInventory, type KitAsset, type KitInventory, type RuntimeAdapterTestHooks } from "./runtime-adapters.js";

/** Project-local discovery surfaces. These do not install hooks or select models. */
export const NATIVE_HARNESS_SURFACES = ["claude-code", "codex", "kiro-cli", "kiro-ide", "cursor", "opencode", "copilot-cli", "vscode"] as const;
export type NativeHarnessSurface = typeof NATIVE_HARNESS_SURFACES[number];
const SKILLS: Record<NativeHarnessSurface, string> = {
  "claude-code": ".claude/skills", codex: ".agents/skills", "kiro-cli": ".kiro/skills",
  "kiro-ide": ".kiro/skills", cursor: ".cursor/skills", opencode: ".opencode/skills",
  "copilot-cli": ".github/skills", vscode: ".github/skills",
};
const MANIFEST = ".flow-agents/native-harness-activation.json";
type Owned = { kit_id: string; path: string; sha256: string; surfaces: NativeHarnessSurface[] };
type Manifest = { schema_version: "1.0"; files: Owned[] };
type Planned = { path: string; bytes: Buffer; kit_id: string; asset_class: string };
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const segment = (value: string): string => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) throw new Error(`invalid native asset name '${value}'`);
  return value;
};

function exists(file: string): boolean {
  try { fs.lstatSync(file); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Preflight without creating directories; reject even dangling or internal symlinks. */
function safeTarget(root: string, rel: string): string {
  if (path.isAbsolute(rel) || rel.includes("\\") || rel.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`invalid projection path '${rel}'`);
  if (exists(root) && (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink())) throw new Error("native activation destination must be a regular directory");
  let current = root;
  const parts = rel.split("/");
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    if (!exists(current)) continue;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`refusing native projection symlink: ${current}`);
    if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) throw new Error(`invalid native projection destination: ${current}`);
  }
  return current;
}

function ownedPathForSurface(rel: string, surface: NativeHarnessSurface): boolean {
  return rel.startsWith(`${SKILLS[surface]}/`) || rel.startsWith(`.kontourai/flow-agents/projections/${surface}/`)
    || ((surface === "kiro-cli" || surface === "kiro-ide") && /^\.kiro\/agents\/flow-agents-[a-zA-Z0-9_-]+\.(json|md)$/.test(rel))
    || (surface === "cursor" && /^\.cursor\/rules\/flow-agents-[a-zA-Z0-9_-]+\.mdc$/.test(rel));
}

function readManifest(root: string): Manifest {
  const file = safeTarget(root, MANIFEST);
  if (!exists(file)) return { schema_version: "1.0", files: [] };
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as Manifest;
  if (value.schema_version !== "1.0" || !Array.isArray(value.files)) throw new Error("invalid native projection ownership manifest");
  const seen = new Set<string>();
  for (const entry of value.files) {
    if (!entry || typeof entry.kit_id !== "string" || !/^[a-z][a-z0-9-]*$/.test(entry.kit_id) || typeof entry.path !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Array.isArray(entry.surfaces)
      || entry.surfaces.length === 0 || entry.surfaces.some((surface) => !NATIVE_HARNESS_SURFACES.includes(surface) || !ownedPathForSurface(entry.path, surface))
      || seen.has(entry.path)) throw new Error("invalid native projection ownership entry");
    safeTarget(root, entry.path);
    seen.add(entry.path);
  }
  return value;
}

function sourcePath(asset: KitAsset): string {
  return (asset as KitAsset & { activation_source_path?: string }).activation_source_path ?? asset.source_path;
}

function skillFiles(source: string): { rel: string; bytes: Buffer }[] {
  if (path.basename(source) !== "SKILL.md") throw new Error(`native skill must point to SKILL.md: ${source}`);
  const root = path.dirname(source);
  const files: { rel: string; bytes: Buffer }[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`native skill source contains symlink: ${file}`);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.push({ rel: path.relative(root, file).split(path.sep).join("/"), bytes: fs.readFileSync(file) });
      else throw new Error(`native skill source is not a regular file: ${file}`);
    }
  };
  walk(root);
  return files;
}

/** Activate installed content using the canonical kit inventory; legacy adapters stay intact.
 * The receipt attests only asset placement, never GUI discovery, auth, hooks, or execution.
 */
export function activateNativeHarness(sourceRoot: string, destination: string, options: {
  surface: NativeHarnessSurface; kitIdFilter?: string[]; testHooks?: RuntimeAdapterTestHooks;
}): Record<string, unknown> {
  const surface = options.surface;
  const root = path.resolve(destination);
  const errors: string[] = [];
  const generated: { path: string; kit_id: string; asset_class: string; sha256: string }[] = [];
  const removed: string[] = [];
  const inventory: KitInventory = (() => {
    try {
      safeTarget(root, "kits/local/installed-kits.json");
      return readKitInventory(sourceRoot, root, { ...options, snapshotLocalKits: true, strictInstalledIntegrity: true });
    }
    catch (error) { return { assets: [], dependencies: [], workflow_triggers: [], hook_influence_expectations: [], warnings: [], errors: [(error as Error).message], dispose() {} }; }
  })();
  const affectedSurfaces = new Set<NativeHarnessSurface>();
  errors.push(...inventory.errors);
  const receipt = (): Record<string, unknown> => ({ selected_adapter: surface, projection_scope: "project", evidence_scope: "native-configuration-placement",
    runtime_execution: "NOT_VERIFIED", hook_enforcement: "NOT_INSTALLED", authentication: "NOT_VERIFIED",
    supported_asset_classes: ["skills", "flows", "docs"], generated_runtime_files: generated, removed_owned_files: removed,
    skipped_assets: inventory.assets.filter((asset) => !["skills", "flows", "docs"].includes(asset.asset_class)).map((asset) => ({ kit_id: asset.kit_id, path: asset.relative_path, asset_class: asset.asset_class })),
    warnings: inventory.warnings, affected_surfaces: [...affectedSurfaces], errors });
  try {
    if (!NATIVE_HARNESS_SURFACES.includes(surface)) throw new Error(`unknown native harness surface '${surface}'`);
    if (root === path.parse(root).root || root === path.resolve(os.homedir())) throw new Error("native activation requires a project destination, not a user home or filesystem root");
    if (errors.length) return receipt();
    safeTarget(root, MANIFEST);
    ensureSafeDirectory(root, path.dirname(path.join(root, MANIFEST)));
    return withStateFileLock(path.join(root, MANIFEST), () => {
      const manifest = readManifest(root);
      const previous = new Map(manifest.files.map((entry) => [entry.path, entry]));
      const plans = new Map<string, Planned>();
      const add = (rel: string, bytes: Buffer, asset: KitAsset): void => {
        if (plans.has(rel)) throw new Error(`native projection collision at '${rel}'`);
        safeTarget(root, rel);
        plans.set(rel, { path: rel, bytes, kit_id: asset.kit_id, asset_class: asset.asset_class });
      };
      const kits = new Map<string, KitAsset[]>();
      for (const asset of inventory.assets) {
        const kitAssets = kits.get(asset.kit_id) ?? [];
        kitAssets.push(asset); kits.set(asset.kit_id, kitAssets);
        if (asset.asset_class === "skills") {
          const name = segment(path.basename(path.dirname(sourcePath(asset))));
          for (const file of skillFiles(sourcePath(asset))) add(`${SKILLS[surface]}/${name}/${file.rel}`, file.bytes, asset);
        } else if (asset.asset_class === "flows" || asset.asset_class === "docs") {
          add(`.kontourai/flow-agents/projections/${surface}/${segment(asset.kit_id)}/${asset.relative_path}`, fs.readFileSync(sourcePath(asset)), asset);
        }
      }
      for (const [kitId, assets] of kits) {
        const skills = assets.filter((asset) => asset.asset_class === "skills");
        if (!skills.length) continue;
        const guidance = `Follow the installed ${kitId} skills when relevant. Read the skill before acting. Skills invoke their documented ordinary CLI tools; these projections install no enforcement hooks.\n${skills.map((asset) => `- ${SKILLS[surface]}/${path.basename(path.dirname(sourcePath(asset)))}/SKILL.md`).join("\n")}\n`;
        const agentName = `flow-agents-${segment(kitId)}`;
        if (surface === "kiro-cli") {
          const agent = { name: agentName, description: `Installed ${kitId} kit guidance`, prompt: guidance,
            tools: ["fs_read", "fs_write", "execute_bash"], allowedTools: ["fs_read"], resources: skills.map((asset) => `skill://${SKILLS[surface]}/${path.basename(path.dirname(sourcePath(asset)))}/SKILL.md`) };
          add(`.kiro/agents/${agentName}.json`, Buffer.from(`${JSON.stringify(agent, null, 2)}\n`), skills[0]);
        } else if (surface === "kiro-ide") {
          add(`.kiro/agents/${agentName}.md`, Buffer.from(`---\nname: ${agentName}\ndescription: Installed ${kitId} kit guidance\ntools: ["read", "write", "shell"]\n---\n${guidance}`), skills[0]);
        } else if (surface === "cursor") {
          add(`.cursor/rules/${agentName}.mdc`, Buffer.from(`---\ndescription: Installed ${kitId} kit guidance\nalwaysApply: false\n---\n${guidance}`), skills[0]);
        }
      }
      // Preflight the whole plan. User modifications and unowned destinations refuse activation.
      for (const plan of plans.values()) {
        const file = safeTarget(root, plan.path);
        const old = previous.get(plan.path);
        if (exists(file) && (!old || digest(fs.readFileSync(file)) !== old.sha256)) throw new Error(`native projection conflict; preserve user file '${plan.path}'`);
        if (old && old.kit_id !== plan.kit_id) throw new Error(`native projection ownership belongs to another kit at '${plan.path}'`);
      }
      const selectedKits = options.kitIdFilter ? new Set([...options.kitIdFilter, ...inventory.assets.map((asset) => asset.kit_id)]) : null;
      const stale = manifest.files.filter((entry) => entry.surfaces.includes(surface) && !plans.has(entry.path)
        && (!selectedKits || selectedKits.has(entry.kit_id)));
      for (const entry of stale) {
        const file = safeTarget(root, entry.path);
        if (exists(file) && digest(fs.readFileSync(file)) !== entry.sha256) throw new Error(`modified stale native projection; preserve '${entry.path}'`);
      }
      const next = new Map(previous);
      for (const plan of plans.values()) {
        const file = safeTarget(root, plan.path);
        const old = previous.get(plan.path);
        if (exists(file) && (!old || digest(fs.readFileSync(file)) !== old.sha256)) throw new Error(`native projection changed during activation: '${plan.path}'`);
        atomicWriteFile(root, file, plan.bytes);
        const sha256 = digest(plan.bytes);
        if (old && old.sha256 !== sha256) for (const owner of old.surfaces) affectedSurfaces.add(owner);
        affectedSurfaces.add(surface);
        next.set(plan.path, { kit_id: plan.kit_id, path: plan.path, sha256, surfaces: [...new Set([...(old?.surfaces ?? []), surface])] });
        // Persist custody after each write so interrupted runs retain ownership of landed files.
        atomicWriteJson(root, path.join(root, MANIFEST), { schema_version: "1.0", files: [...next.values()] });
        generated.push({ path: plan.path, kit_id: plan.kit_id, asset_class: plan.asset_class, sha256 });
      }
      for (const entry of stale) {
        const others = entry.surfaces.filter((candidate) => candidate !== surface);
        if (others.length) next.set(entry.path, { ...entry, surfaces: others });
        else {
          const file = safeTarget(root, entry.path);
          if (exists(file)) {
            if (digest(fs.readFileSync(file)) !== entry.sha256) throw new Error(`stale native projection changed during activation: '${entry.path}'`);
            fs.unlinkSync(file); removed.push(entry.path);
          }
          next.delete(entry.path);
        }
        atomicWriteJson(root, path.join(root, MANIFEST), { schema_version: "1.0", files: [...next.values()] });
      }
      return receipt();
    });
  } catch (error) {
    errors.push((error as Error).message);
    return receipt();
  } finally { inventory.dispose(); }
}
