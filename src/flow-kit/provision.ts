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

function mergeHooksJson(sourceText: string, existingText: string | undefined, id: string): string {
  const source = hooksConfig(sourceText, `source ${id}`);
  const existing = existingText === undefined ? { hooks: {} as Record<string, unknown[]> } : hooksConfig(existingText, `target ${id}`);
  const hooks: Record<string, unknown[]> = Object.assign(Object.create(null), existing.hooks);
  for (const [event, sourceGroups] of Object.entries(source.hooks)) {
    const currentGroups = [...(hooks[event] ?? [])];
    for (const group of sourceGroups) {
      const commands = handlerCommands(group);
      if (commands.length === 0 || commands.length !== (group as { hooks: unknown[] }).hooks.length || new Set(commands).size !== commands.length) {
        throw new Error(`hooks-json source ${id}:${event} must declare command handlers`);
      }
      if (currentGroups.some((current) => JSON.stringify(current) === JSON.stringify(group))) continue;
      const existingCommands = new Set(currentGroups.flatMap(handlerCommands));
      if (commands.some((command) => existingCommands.has(command))) {
        throw new Error(`hooks-json merge conflicts with an existing command in ${id}:${event}`);
      }
      currentGroups.push(group);
    }
    hooks[event] = currentGroups;
  }
  return `${JSON.stringify({ ...existing, hooks }, null, 2)}\n`;
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
      const installedContent = file.merge === "hooks-json"
        ? mergeHooksJson(content, fs.existsSync(file.destination) ? readHostText(file.destination, file.id) : undefined, file.id)
        : content;
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

  const manifestPath = path.join(targetRoot, ...PROVISION_MANIFEST_DIR.split("/"), `${kitId}.json`);
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
    conduit_receipts: conduitReceipts,
  });
  return { kit_id: kitId, kit_hash: kitHash, files, manifest_path: manifestPath, dry_run: false, conduit_receipts: conduitReceipts };
}
