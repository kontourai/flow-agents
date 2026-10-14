import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createClaudeCodeAdapter,
  createCodexAdapter,
  createOpenCodeAdapter,
  type AgentHostAdapter,
  type InstallationReceipt,
  type PortableAsset,
} from "@kontourai/conduit";
import { createKiroAdapter } from "@kontourai/conduit/kiro";
import { createPiAdapter } from "@kontourai/conduit/pi";
import { atomicCopyFile, atomicWriteFile, atomicWriteJson, canonicalProspectivePath, walkFiles } from "../lib/fs.js";
import { PROVISION_MANIFEST_DIR, assertKitRepository, type KitProvisionEntry } from "./validate.js";

const MAX_HOST_ASSET_BYTES = 1_000_000;

export type ProvisionedFile = { id: string; target: string };

export type ProvisionPlanEntry = ProvisionedFile & {
  source: string;
  destination: string;
  host?: KitProvisionEntry["host"];
  kind?: KitProvisionEntry["kind"];
  merge?: KitProvisionEntry["merge"];
};

export type ProvisionResult = {
  kit_id: string;
  kit_hash?: string;
  files: ProvisionPlanEntry[];
  manifest_path?: string;
  dry_run: boolean;
  conduit_receipts?: InstallationReceipt[];
};

export class ProvisionConflictError extends Error {
  readonly conflicts: ProvisionPlanEntry[];

  constructor(conflicts: ProvisionPlanEntry[]) {
    super(`provisioning conflicts with ${conflicts.length} existing destination(s)`);
    this.name = "ProvisionConflictError";
    this.conflicts = conflicts;
  }
}

function kitContentHash(kitDir: string): string {
  const hash = crypto.createHash("sha256");
  for (const file of walkFiles(kitDir)) {
    const rel = path.relative(kitDir, file).split(path.sep).join("/");
    if (rel.split("/").some((part) => [".git", "__pycache__", ".pytest_cache"].includes(part))) continue;
    hash.update(rel);
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function assertSafeDestination(rootReal: string, destination: string): void {
  const prospective = canonicalProspectivePath(destination);
  if (!isContained(rootReal, prospective)) throw new Error(`provision target escapes consumer repository: ${destination}`);
  if (!fs.existsSync(destination)) return;
  const stat = fs.lstatSync(destination);
  if (stat.isSymbolicLink()) throw new Error(`refusing provision target symlink: ${destination}`);
  if (!stat.isFile()) throw new Error(`provision target is not a regular file: ${destination}`);
}

function manifestProvisions(manifest: Record<string, unknown>): KitProvisionEntry[] {
  if (!Array.isArray(manifest.provisions)) return [];
  return manifest.provisions.map((entry) => {
    const record = entry as Record<string, unknown>;
    return {
      id: String(record.id),
      path: String(record.path),
      target: path.posix.normalize(String(record.target).replace(/\\/g, "/")),
      ...(typeof record.description === "string" ? { description: record.description } : {}),
      ...(typeof record.host === "string" ? { host: record.host as KitProvisionEntry["host"] } : {}),
      ...(typeof record.kind === "string" ? { kind: record.kind as KitProvisionEntry["kind"] } : {}),
      ...(record.merge === "hooks-json" ? { merge: "hooks-json" as const } : {}),
    };
  });
}

function hooksConfig(text: string, label: string): Record<string, unknown> & { hooks: Record<string, unknown[]> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`hooks-json merge requires valid JSON in ${label}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`hooks-json merge requires a JSON object in ${label}`);
  }
  const record = parsed as Record<string, unknown>;
  if (!record.hooks || typeof record.hooks !== "object" || Array.isArray(record.hooks)) {
    throw new Error(`hooks-json merge requires a hooks object in ${label}`);
  }
  for (const [event, groups] of Object.entries(record.hooks)) {
    if (!Array.isArray(groups) || groups.some((group) => !group || typeof group !== "object" || !Array.isArray(group.hooks))) {
      throw new Error(`hooks-json merge requires hook groups in ${label}:${event}`);
    }
  }
  return record as Record<string, unknown> & { hooks: Record<string, unknown[]> };
}

function handlerCommands(group: unknown): string[] {
  const handlers = (group as { hooks: unknown[] }).hooks;
  return handlers.flatMap((handler) => {
    const command = (handler as { command?: unknown })?.command;
    return typeof command === "string" && command.length > 0 ? [command] : [];
  });
}

/** One hook handler a kit provisioned into a hooks-json target, recorded in its provision manifest. */
export type ProvisionedHookHandler = { id: string; target: string; event: string; command: string };

/**
 * What this kit's previous provision manifest proves about a hooks-json target:
 * - `recorded`: the exact commands it provisioned there, per event;
 * - `legacy`: a manifest written before handler provenance existed lists the
 *   target, so a group identical to the kit's current declaration is the kit's;
 * - `none`: the kit never provisioned the target, so every handler there
 *   belongs to someone else.
 */
type HookOwnership =
  | { kind: "recorded"; commands: Map<string, Set<string>> }
  | { kind: "legacy" }
  | { kind: "none" };

function mergeHooksJson(
  sourceText: string,
  existingText: string | undefined,
  id: string,
  ownership: HookOwnership,
): { content: string; handlers: { event: string; command: string }[] } {
  const source = hooksConfig(sourceText, `source ${id}`);
  const existing = existingText === undefined ? { hooks: {} as Record<string, unknown[]> } : hooksConfig(existingText, `target ${id}`);
  const hooks: Record<string, unknown[]> = Object.assign(Object.create(null), existing.hooks);
  const handlers: { event: string; command: string }[] = [];
  const events = new Set([
    ...Object.keys(source.hooks),
    ...(ownership.kind === "recorded" ? ownership.commands.keys() : []),
  ]);
  for (const event of events) {
    const sourceGroups = source.hooks[event] ?? [];
    for (const group of sourceGroups) {
      const commands = handlerCommands(group);
      if (commands.length === 0 || commands.length !== (group as { hooks: unknown[] }).hooks.length || new Set(commands).size !== commands.length) {
        throw new Error(`hooks-json source ${id}:${event} must declare command handlers`);
      }
    }
    const sourceKeys = new Set(sourceGroups.map((group) => JSON.stringify(group)));
    const previous = ownership.kind === "recorded" ? ownership.commands.get(event) ?? new Set<string>() : new Set<string>();
    let removed = false;
    // Replace only what this kit provisioned before: drop each handler whose
    // command it recorded, unless the group is already exactly what the kit
    // declares now (keeping it in place keeps re-provisioning byte-stable).
    const currentGroups = (hooks[event] ?? []).flatMap((group) => {
      if (sourceKeys.has(JSON.stringify(group))) return [group];
      const groupHandlers = (group as { hooks: unknown[] }).hooks;
      const kept = groupHandlers.filter((handler) => {
        const command = (handler as { command?: unknown })?.command;
        return !(typeof command === "string" && previous.has(command));
      });
      if (kept.length === groupHandlers.length) return [group];
      removed = true;
      return kept.length > 0 ? [{ ...(group as Record<string, unknown>), hooks: kept }] : [];
    });
    for (const group of sourceGroups) {
      const commands = handlerCommands(group);
      if (currentGroups.some((current) => JSON.stringify(current) === JSON.stringify(group))) {
        // An identical group already present is the kit's only when the kit's
        // own record says so; otherwise a user or another kit wrote it first.
        const owned = ownership.kind === "legacy" || commands.every((command) => previous.has(command));
        if (owned) handlers.push(...commands.map((command) => ({ event, command })));
        continue;
      }
      const existingCommands = new Set(currentGroups.flatMap(handlerCommands));
      if (commands.some((command) => existingCommands.has(command))) {
        throw new Error(`hooks-json merge conflicts with an existing command in ${id}:${event}`);
      }
      currentGroups.push(group);
      handlers.push(...commands.map((command) => ({ event, command })));
    }
    if (currentGroups.length === 0 && removed) delete hooks[event];
    else if (currentGroups.length > 0 || event in hooks) hooks[event] = currentGroups;
  }
  return { content: `${JSON.stringify({ ...existing, hooks }, null, 2)}\n`, handlers };
}

type PreviousHookHandlers = { ownership: (target: string) => HookOwnership; recorded: ProvisionedHookHandler[] };

const NO_PREVIOUS_HOOK_HANDLERS: PreviousHookHandlers = { ownership: () => ({ kind: "none" }), recorded: [] };

/**
 * Reads this kit's previous provision manifest to learn which hooks-json
 * handlers it provisioned. A missing manifest means the kit never provisioned
 * here; an unreadable one fails closed rather than guessing ownership.
 */
function previousHookHandlers(manifestPath: string, kitId: string, targetRoot: string): PreviousHookHandlers {
  assertSafeDestination(targetRoot, manifestPath);
  if (!fs.existsSync(manifestPath)) return NO_PREVIOUS_HOOK_HANDLERS;
  const label = `provision manifest for kit '${kitId}'`;
  let manifest: unknown;
  try {
    manifest = JSON.parse(readHostText(manifestPath, label));
  } catch (error) {
    throw new Error(`${label} is unreadable, so its hook handlers cannot be replaced safely: ${manifestPath} (${(error as Error).message})`);
  }
  const record = manifest as Record<string, unknown> | null;
  if (!record || typeof record !== "object" || Array.isArray(record) || record.kit_id !== kitId) {
    throw new Error(`${label} does not describe kit '${kitId}': ${manifestPath}`);
  }
  if (record.hook_handlers === undefined) {
    const files = Array.isArray(record.files) ? record.files : [];
    const targets = new Set(files.map((file) => (file as { target?: unknown })?.target).filter((target) => typeof target === "string"));
    return { ownership: (target) => (targets.has(target) ? { kind: "legacy" } : { kind: "none" }), recorded: [] };
  }
  if (!Array.isArray(record.hook_handlers)) throw new Error(`${label} has malformed hook_handlers: ${manifestPath}`);
  const byTarget = new Map<string, Map<string, Set<string>>>();
  const recorded: ProvisionedHookHandler[] = [];
  for (const entry of record.hook_handlers) {
    const handler = entry as Partial<ProvisionedHookHandler> | null;
    if (!handler || typeof handler.id !== "string" || typeof handler.target !== "string" || typeof handler.event !== "string" || typeof handler.command !== "string" || handler.command.length === 0) {
      throw new Error(`${label} has malformed hook_handlers: ${manifestPath}`);
    }
    recorded.push({ id: handler.id, target: handler.target, event: handler.event, command: handler.command });
    const events = byTarget.get(handler.target) ?? new Map<string, Set<string>>();
    const commands = events.get(handler.event) ?? new Set<string>();
    commands.add(handler.command);
    events.set(handler.event, commands);
    byTarget.set(handler.target, events);
  }
  return { ownership: (target) => ({ kind: "recorded", commands: byTarget.get(target) ?? new Map() }), recorded };
}

function readHostText(filePath: string, id: string): string {
  if (fs.statSync(filePath).size > MAX_HOST_ASSET_BYTES) {
    throw new Error(`Conduit host asset exceeds ${MAX_HOST_ASSET_BYTES} bytes: ${id}`);
  }
  const bytes = fs.readFileSync(filePath);
  const content = bytes.toString("utf8");
  if (!Buffer.from(content, "utf8").equals(bytes)) {
    throw new Error(`Conduit host asset must be UTF-8: ${id}`);
  }
  return content;
}

export async function provisionKit(
  kitDir: string,
  targetDir: string,
  options: { force?: boolean; dryRun?: boolean } = {},
): Promise<ProvisionResult> {
  const kitRoot = fs.realpathSync(path.resolve(kitDir));
  const targetPath = path.resolve(targetDir);
  if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
    throw new Error(`provision target must exist and be a directory: ${targetPath}`);
  }
  const targetRoot = fs.realpathSync(targetPath);
  const manifest = await assertKitRepository(kitRoot);
  const kitId = String(manifest.id);
  const files = manifestProvisions(manifest).map((entry) => ({
    id: entry.id,
    target: entry.target,
    source: path.resolve(kitRoot, entry.path),
    destination: path.resolve(targetRoot, ...entry.target.split("/")),
    ...(entry.host ? { host: entry.host } : {}),
    ...(entry.kind ? { kind: entry.kind } : {}),
    ...(entry.merge ? { merge: entry.merge } : {}),
  }));

  for (const file of files) assertSafeDestination(targetRoot, file.destination);
  // Defense in depth against a source swapped to a link after validation: re-assert the
  // link-resolved source stays inside the kit before we read and copy its bytes.
  for (const file of files) {
    const realSource = fs.realpathSync(file.source);
    if (realSource !== kitRoot && !realSource.startsWith(`${kitRoot}${path.sep}`)) {
      throw new Error(`provision source escapes the kit directory: ${file.id}`);
    }
  }
  const conflicts = options.force ? [] : files.filter((file) => fs.existsSync(file.destination) && file.merge !== "hooks-json");
  if (conflicts.length) throw new ProvisionConflictError(conflicts);

  const manifestPath = path.join(targetRoot, ...PROVISION_MANIFEST_DIR.split("/"), `${kitId}.json`);
  const hookTargets = new Set(files.filter((file) => file.merge === "hooks-json").map((file) => file.target));
  let previousHooks: PreviousHookHandlers;
  try {
    previousHooks = previousHookHandlers(manifestPath, kitId, targetRoot);
  } catch (error) {
    // A kit that merges no hooks now needs the old record only to carry it
    // forward, so an unreadable one is replaced as before.
    if (hookTargets.size > 0) throw error;
    previousHooks = NO_PREVIOUS_HOOK_HANDLERS;
  }
  // A kit that stops declaring a hooks-json target leaves its handlers there,
  // as it leaves any provisioned file. Keep their record so a later
  // provisioning of that target still replaces them.
  const hookHandlers: ProvisionedHookHandler[] = previousHooks.recorded.filter((handler) => !hookTargets.has(handler.target));

  const hostAssets = files.filter((file) => file.host && file.kind);
  const hostGroups = new Map<string, ProvisionPlanEntry[]>();
  for (const file of hostAssets) {
    const group = hostGroups.get(file.host!) ?? [];
    group.push(file);
    hostGroups.set(file.host!, group);
  }
  const adapterFactories = {
    codex: createCodexAdapter,
    "claude-code": createClaudeCodeAdapter,
    opencode: createOpenCodeAdapter,
    kiro: createKiroAdapter,
    pi: createPiAdapter,
  };
  const hostPlans: { adapter: AgentHostAdapter; assets: PortableAsset[] }[] = [];
  for (const [host, group] of hostGroups) {
    const factory = adapterFactories[host as keyof typeof adapterFactories];
    if (!factory) throw new Error(`unsupported Conduit host: ${host}`);
    const byId = new Map(group.map((file) => [file.id, file]));
    const byTarget = new Map(group.map((file) => [file.destination, file]));
    const assets = group.map((file) => {
      const content = readHostText(file.source, file.id);
      let installedContent = content;
      if (file.merge === "hooks-json") {
        const existing = fs.existsSync(file.destination) ? readHostText(file.destination, file.id) : undefined;
        const merged = mergeHooksJson(content, existing, file.id, previousHooks.ownership(file.target));
        installedContent = merged.content;
        hookHandlers.push(...merged.handlers.map((handler) => ({ id: file.id, target: file.target, ...handler })));
      }
      if (Buffer.byteLength(installedContent, "utf8") > MAX_HOST_ASSET_BYTES) {
        throw new Error(`Conduit host asset exceeds ${MAX_HOST_ASSET_BYTES} bytes after merge: ${file.id}`);
      }
      return {
        id: file.id,
        kind: file.kind!,
        content: installedContent,
      };
    });
    const adapter = factory({
      resolveTarget: (asset) => byId.get(asset.id)?.destination,
      write: (target, content) => {
        const file = byTarget.get(target);
        if (!file || assets.find((asset) => asset.id === file.id)?.content !== content) {
          throw new Error(`Conduit returned unbound host asset content for ${host}`);
        }
        if (fs.existsSync(target) && fs.readFileSync(target, "utf8") === content) return;
        atomicWriteFile(targetRoot, target, content);
      },
    });
    for (const asset of assets) {
      if (adapter.capabilities().install[asset.kind] === "unavailable") {
        throw new Error(`Conduit host ${host} cannot install ${asset.kind}: ${asset.id}`);
      }
    }
    hostPlans.push({ adapter, assets });
  }

  const kitHash = kitContentHash(kitRoot);
  if (options.dryRun || files.length === 0) return { kit_id: kitId, kit_hash: kitHash, files, dry_run: Boolean(options.dryRun) };

  assertSafeDestination(targetRoot, manifestPath);
  const conduitReceipts: InstallationReceipt[] = [];
  for (const plan of hostPlans) {
    const receipt = await plan.adapter.install(plan.assets);
    if (receipt.skipped.length > 0 || receipt.installed.length !== plan.assets.length) {
      throw new Error(`Conduit did not install every declared host asset for ${receipt.hostId}`);
    }
    conduitReceipts.push(receipt);
  }
  for (const file of files.filter((entry) => !entry.host)) {
    atomicCopyFile(targetRoot, file.source, file.destination);
  }
  atomicWriteJson(targetRoot, manifestPath, {
    schema_version: "1.0",
    kit_id: kitId,
    kit_hash: kitHash,
    provisioned_at: new Date().toISOString(),
    files: files.map(({ id, target }) => ({ id, target })),
    // Provenance for hooks-json merges: the next provisioning of this kit
    // replaces exactly these handlers and leaves every other handler alone.
    hook_handlers: hookHandlers,
    conduit_receipts: conduitReceipts,
  });
  return { kit_id: kitId, kit_hash: kitHash, files, manifest_path: manifestPath, dry_run: false, conduit_receipts: conduitReceipts };
}
