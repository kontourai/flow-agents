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
  supersedes?: string[];
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
      ...(Array.isArray(record.supersedes) ? { supersedes: record.supersedes.map(String) } : {}),
    };
  });
}

function hooksConfig(text: string, label: string, { allowMissingHooks = false } = {}): Record<string, unknown> & { hooks: Record<string, unknown[]> } {
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
  // A host settings file without hooks yet (for example a Claude settings.json
  // holding only permissions) has nothing to merge into, not malformed hooks.
  if (record.hooks === undefined && allowMissingHooks) return { ...record, hooks: {} };
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** JSON with object keys sorted, so identity does not depend on key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** A group's own fields (matcher and the like), without its handlers. */
function groupFields(group: unknown): Record<string, unknown> {
  const { hooks: _handlers, ...fields } = group as Record<string, unknown>;
  return fields;
}

const handlerKey = (event: string, group: Record<string, unknown>, handler: unknown): string =>
  canonicalJson([event, group, handler]);

/**
 * One hook handler a kit provisioned into a hooks-json target, recorded in its
 * provision manifest. `group` holds the group's own fields (such as `matcher`)
 * and `handler` the exact handler object, so a user handler that reuses the
 * command under another matcher or with other settings is not the kit's.
 */
export type ProvisionedHookHandler = {
  id: string;
  target: string;
  event: string;
  command: string;
  group: Record<string, unknown>;
  handler: Record<string, unknown>;
};

/** A handler removed because the kit's provision declared its command in `supersedes`. */
export type SupersededHookHandler = { id: string; target: string; event: string; command: string };

/**
 * What this kit's previous provision manifest proves about a hooks-json target:
 * - `recorded`: the exact handlers it provisioned there;
 * - `legacy`: a manifest written before handler provenance existed lists the
 *   target, so a handler with a currently declared command in a group with the
 *   same fields as the kit's declared group is the kit's;
 * - `none`: the kit never provisioned the target, so every handler there
 *   belongs to someone else.
 */
type HookOwnership =
  | { kind: "recorded"; records: ProvisionedHookHandler[] }
  | { kind: "legacy" }
  | { kind: "none" };

type MergedHooks = {
  content: string;
  handlers: Omit<ProvisionedHookHandler, "id" | "target">[];
  previousHandlers: Omit<ProvisionedHookHandler, "id" | "target">[];
  superseded: { event: string; command: string }[];
};

function mergeHooksJson(
  sourceText: string,
  existingText: string | undefined,
  id: string,
  ownership: HookOwnership,
  supersedes: readonly string[],
  otherKitCommands: (event: string) => ReadonlySet<string>,
): MergedHooks {
  const source = hooksConfig(sourceText, `source ${id}`);
  const existing = existingText === undefined
    ? { hooks: {} as Record<string, unknown[]> }
    : hooksConfig(existingText, `target ${id}`, { allowMissingHooks: true });
  const hooks: Record<string, unknown[]> = Object.assign(Object.create(null), existing.hooks);
  const handlers: MergedHooks["handlers"] = [];
  const previousHandlers: MergedHooks["previousHandlers"] = [];
  const superseded: MergedHooks["superseded"] = [];
  const recordedKeys = new Set(ownership.kind === "recorded"
    ? ownership.records.map((record) => handlerKey(record.event, record.group, record.handler))
    : []);
  const declaredCommands = new Set<string>();
  for (const [event, sourceGroups] of Object.entries(source.hooks)) {
    for (const group of sourceGroups) {
      const commands = handlerCommands(group);
      if (commands.length === 0 || commands.length !== (group as { hooks: unknown[] }).hooks.length || new Set(commands).size !== commands.length) {
        throw new Error(`hooks-json source ${id}:${event} must declare command handlers`);
      }
      for (const command of commands) declaredCommands.add(command);
    }
  }
  const stillDeclared = supersedes.filter((command) => declaredCommands.has(command));
  if (stillDeclared.length > 0) {
    throw new Error(`hooks-json provision ${id} supersedes a command it still declares: ${stillDeclared.join(", ")}`);
  }
  const events = new Set([
    ...Object.keys(source.hooks),
    ...(ownership.kind === "recorded" ? ownership.records.map((record) => record.event) : []),
  ]);
  for (const event of events) {
    const sourceGroups = source.hooks[event] ?? [];
    const sourceKeys = new Set(sourceGroups.map(canonicalJson));
    const protectedCommands = otherKitCommands(event);
    // Supersedes reaches only the events this provision declares.
    const supersededHere = new Set(sourceGroups.length > 0 ? supersedes : []);
    const ownedBefore = (group: unknown, handler: unknown): boolean => {
      if (ownership.kind === "recorded") return recordedKeys.has(handlerKey(event, groupFields(group), handler));
      if (ownership.kind !== "legacy") return false;
      const command = (handler as { command?: unknown })?.command;
      const fields = canonicalJson(groupFields(group));
      return sourceGroups.some((declared) => canonicalJson(groupFields(declared)) === fields && handlerCommands(declared).includes(command as string));
    };
    if (ownership.kind === "legacy") {
      for (const group of hooks[event] ?? []) {
        for (const handler of (group as { hooks: Record<string, unknown>[] }).hooks) {
          if (ownedBefore(group, handler)) {
            previousHandlers.push({ event, command: handler.command as string, group: groupFields(group), handler });
          }
        }
      }
    }
    let removed = false;
    // Replace only what this kit provisioned or explicitly supersedes, never a
    // command another kit records here. A group already exactly what the kit
    // declares stays in place, which keeps re-provisioning byte-stable.
    const currentGroups = (hooks[event] ?? []).flatMap((group) => {
      if (sourceKeys.has(canonicalJson(group))) return [group];
      const groupHandlers = (group as { hooks: unknown[] }).hooks;
      const kept = groupHandlers.filter((handler) => {
        const command = (handler as { command?: unknown })?.command;
        if (typeof command !== "string" || protectedCommands.has(command)) return true;
        if (ownedBefore(group, handler)) return false;
        if (supersededHere.has(command)) {
          superseded.push({ event, command });
          return false;
        }
        return true;
      });
      if (kept.length === groupHandlers.length) return [group];
      removed = true;
      return kept.length > 0 ? [{ ...(group as Record<string, unknown>), hooks: kept }] : [];
    });
    for (const group of sourceGroups) {
      const groupHandlers = (group as { hooks: Record<string, unknown>[] }).hooks;
      const record = () => handlers.push(...groupHandlers.map((handler) => ({
        event, command: handler.command as string, group: groupFields(group), handler,
      })));
      if (currentGroups.some((current) => canonicalJson(current) === canonicalJson(group))) {
        // An identical group already present is the kit's when its own record
        // (or legacy manifest) says so, and shared when another kit records
        // it. Otherwise a user wrote it first and it is not claimed.
        if (groupHandlers.every((handler) => ownedBefore(group, handler) || protectedCommands.has(handler.command as string))) record();
        continue;
      }
      const existingCommands = new Set(currentGroups.flatMap(handlerCommands));
      if (groupHandlers.some((handler) => existingCommands.has(handler.command as string))) {
        throw new Error(`hooks-json merge conflicts with an existing command in ${id}:${event}`);
      }
      currentGroups.push(group);
      record();
    }
    if (currentGroups.length === 0 && removed) delete hooks[event];
    else if (currentGroups.length > 0 || event in hooks) hooks[event] = currentGroups;
  }
  return { content: `${JSON.stringify({ ...existing, hooks }, null, 2)}\n`, handlers, previousHandlers, superseded };
}

type PreviousHookHandlers = {
  ownership: (target: string) => HookOwnership;
  recorded: ProvisionedHookHandler[];
  superseded: SupersededHookHandler[];
  manifest?: Record<string, unknown>;
};

const NO_PREVIOUS_HOOK_HANDLERS: PreviousHookHandlers = { ownership: () => ({ kind: "none" }), recorded: [], superseded: [] };

function readProvisionManifest(manifestPath: string, label: string): Record<string, unknown> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readHostText(manifestPath, label));
  } catch (error) {
    throw new Error(`${label} is unreadable, so hook handler ownership cannot be determined safely: ${manifestPath} (${(error as Error).message})`);
  }
  if (!isPlainObject(manifest)) throw new Error(`${label} is not a JSON object: ${manifestPath}`);
  return manifest;
}

/**
 * Reads this kit's previous provision manifest to learn which hooks-json
 * handlers it provisioned. A missing manifest means the kit never provisioned
 * here; an unreadable one fails closed rather than guessing ownership.
 */
function previousHookHandlers(manifestPath: string, kitId: string, targetRoot: string): PreviousHookHandlers {
  assertSafeDestination(targetRoot, manifestPath);
  if (!fs.existsSync(manifestPath)) return NO_PREVIOUS_HOOK_HANDLERS;
  const label = `provision manifest for kit '${kitId}'`;
  const record = readProvisionManifest(manifestPath, label);
  if (record.kit_id !== kitId) throw new Error(`${label} does not describe kit '${kitId}': ${manifestPath}`);
  const superseded: SupersededHookHandler[] = [];
  if (record.superseded_handlers !== undefined) {
    if (!Array.isArray(record.superseded_handlers)) throw new Error(`${label} has malformed superseded_handlers: ${manifestPath}`);
    for (const entry of record.superseded_handlers) {
      if (!isPlainObject(entry) || ["id", "target", "event", "command"].some((key) => typeof entry[key] !== "string")) {
        throw new Error(`${label} has malformed superseded_handlers: ${manifestPath}`);
      }
      superseded.push({ id: entry.id as string, target: entry.target as string, event: entry.event as string, command: entry.command as string });
    }
  }
  if (record.hook_handlers === undefined) {
    const files = Array.isArray(record.files) ? record.files : [];
    const targets = new Set(files.map((file) => (file as { target?: unknown })?.target).filter((target) => typeof target === "string"));
    return { ownership: (target) => (targets.has(target) ? { kind: "legacy" } : { kind: "none" }), recorded: [], superseded, manifest: record };
  }
  if (!Array.isArray(record.hook_handlers)) throw new Error(`${label} has malformed hook_handlers: ${manifestPath}`);
  const recorded: ProvisionedHookHandler[] = [];
  for (const entry of record.hook_handlers) {
    if (
      !isPlainObject(entry)
      || ["id", "target", "event", "command"].some((key) => typeof entry[key] !== "string")
      || (entry.command as string).length === 0
      || !isPlainObject(entry.group)
      || !isPlainObject(entry.handler)
      || entry.handler.command !== entry.command
    ) {
      throw new Error(`${label} has malformed hook_handlers: ${manifestPath}`);
    }
    recorded.push({
      id: entry.id as string,
      target: entry.target as string,
      event: entry.event as string,
      command: entry.command as string,
      group: entry.group,
      handler: entry.handler,
    });
  }
  return {
    ownership: (target) => ({ kind: "recorded", records: recorded.filter((handler) => handler.target === target) }),
    recorded,
    superseded,
    manifest: record,
  };
}

/**
 * Commands that other kits' provision manifests record, per target and event.
 * Re-provisioning one kit never removes them. An unreadable manifest fails
 * closed, because it could be protecting any handler.
 */
function otherKitHookCommands(targetRoot: string, kitId: string): (target: string, event: string) => ReadonlySet<string> {
  const directory = path.join(targetRoot, ...PROVISION_MANIFEST_DIR.split("/"));
  const byKey = new Map<string, Set<string>>();
  if (fs.existsSync(directory)) {
    for (const name of fs.readdirSync(directory).sort()) {
      if (!name.endsWith(".json") || name === `${kitId}.json`) continue;
      const manifestPath = path.join(directory, name);
      assertSafeDestination(targetRoot, manifestPath);
      const label = `provision manifest '${name}'`;
      const record = readProvisionManifest(manifestPath, label);
      if (record.hook_handlers === undefined) continue;
      if (!Array.isArray(record.hook_handlers)) throw new Error(`${label} has malformed hook_handlers: ${manifestPath}`);
      for (const entry of record.hook_handlers) {
        if (!isPlainObject(entry) || ["target", "event", "command"].some((key) => typeof entry[key] !== "string")) {
          throw new Error(`${label} has malformed hook_handlers: ${manifestPath}`);
        }
        const key = JSON.stringify([entry.target, entry.event]);
        const commands = byKey.get(key) ?? new Set<string>();
        commands.add(entry.command as string);
        byKey.set(key, commands);
      }
    }
  }
  return (target, event) => byKey.get(JSON.stringify([target, event])) ?? new Set();
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
    ...(entry.supersedes ? { supersedes: entry.supersedes } : {}),
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
  const supersededHandlers: SupersededHookHandler[] = [...previousHooks.superseded];
  const recoveryHandlers: ProvisionedHookHandler[] = [...previousHooks.recorded];
  const otherKitCommands = hookTargets.size > 0 ? otherKitHookCommands(targetRoot, kitId) : () => new Set<string>();

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
        const merged = mergeHooksJson(
          content,
          existing,
          file.id,
          previousHooks.ownership(file.target),
          file.supersedes ?? [],
          (event) => otherKitCommands(file.target, event),
        );
        installedContent = merged.content;
        recoveryHandlers.push(...merged.previousHandlers.map((handler) => ({ id: file.id, target: file.target, ...handler })));
        hookHandlers.push(...merged.handlers.map((handler) => ({ id: file.id, target: file.target, ...handler })));
        supersededHandlers.push(...merged.superseded.map((handler) => ({ id: file.id, target: file.target, ...handler })));
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
  if (hookTargets.size > 0) {
    // Record the handlers about to be written before writing any of them. If a
    // later write fails, the next provisioning still recognises both the
    // previous and the new handlers as this kit's instead of leaving the new
    // ones unowned for good. The final manifest below narrows the record.
    const pending = new Map<string, ProvisionedHookHandler>();
    for (const handler of [...recoveryHandlers, ...hookHandlers]) {
      pending.set(canonicalJson([handler.target, handler.event, handler.group, handler.handler]), handler);
    }
    atomicWriteJson(targetRoot, manifestPath, {
      schema_version: "1.0",
      kit_id: kitId,
      files: files.map(({ id, target }) => ({ id, target })),
      conduit_receipts: [],
      ...previousHooks.manifest,
      provisioned_at: new Date().toISOString(),
      hook_handlers: [...pending.values()],
      superseded_handlers: supersededHandlers,
    });
  }
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
    // Handlers removed because a provision declared their command in
    // `supersedes`, kept as a cumulative audit trail.
    superseded_handlers: supersededHandlers,
    conduit_receipts: conduitReceipts,
  });
  return { kit_id: kitId, kit_hash: kitHash, files, manifest_path: manifestPath, dry_run: false, conduit_receipts: conduitReceipts };
}
