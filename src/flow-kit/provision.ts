import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { atomicCopyFile, atomicWriteJson, canonicalProspectivePath, walkFiles } from "../lib/fs.js";
import { PROVISION_MANIFEST_DIR, assertKitRepository, type KitProvisionEntry } from "./validate.js";

export type ProvisionedFile = { id: string; target: string };

export type ProvisionPlanEntry = ProvisionedFile & {
  source: string;
  destination: string;
};

export type ProvisionResult = {
  kit_id: string;
  kit_hash?: string;
  files: ProvisionPlanEntry[];
  manifest_path?: string;
  dry_run: boolean;
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
    };
  });
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
  const conflicts = options.force ? [] : files.filter((file) => fs.existsSync(file.destination));
  if (conflicts.length) throw new ProvisionConflictError(conflicts);

  const kitHash = kitContentHash(kitRoot);
  if (options.dryRun || files.length === 0) return { kit_id: kitId, kit_hash: kitHash, files, dry_run: Boolean(options.dryRun) };

  const manifestPath = path.join(targetRoot, ...PROVISION_MANIFEST_DIR.split("/"), `${kitId}.json`);
  assertSafeDestination(targetRoot, manifestPath);
  for (const file of files) atomicCopyFile(targetRoot, file.source, file.destination);
  atomicWriteJson(targetRoot, manifestPath, {
    schema_version: "1.0",
    kit_id: kitId,
    kit_hash: kitHash,
    provisioned_at: new Date().toISOString(),
    files: files.map(({ id, target }) => ({ id, target })),
  });
  return { kit_id: kitId, kit_hash: kitHash, files, manifest_path: manifestPath, dry_run: false };
}
