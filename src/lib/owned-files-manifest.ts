import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ownedFilesManifestPath } from "./local-artifact-root.js";

/**
 * Ownership manifest written by a claude-code install (global or project-scoped) recording
 * every regular file it copied onto disk, keyed by dest-relative POSIX path with a sha256
 * content hash. `flow-agents init --uninstall` reads this back to remove exactly the files
 * still byte-identical to what was installed, while preserving anything a user has since
 * modified (see readOwnedFilesManifest / the uninstall module's manifest-backed removal path).
 *
 * Deliberately does NOT cover `settings.json` (a merged file, never wholly owned -- see
 * uninstall's marker-based hook/statusLine stripping) or the durable `.flow-agents/*` stamp
 * files themselves (handled as a fixed, always-known list by the uninstaller).
 */
export type OwnedFileEntry = { path: string; sha256: string };

export type OwnedFilesManifest = {
  schema_version: "1.0";
  generated_at: string;
  runtime: string;
  version: string;
  global: boolean;
  files: OwnedFileEntry[];
  // Reserved for forward-compatibility with installers that create symlinks directly; the
  // current claude-code writer never does (copyDirMerge and the bundle rsync both write plain
  // files), so this is always empty for a fresh manifest. Legacy pre-manifest symlink chains
  // (e.g. ~/.claude/skills/<name> -> ~/.agents/skills/<name>) are detected and reported by the
  // uninstaller's separate legacy-inference path, not recorded here.
  symlinks: { path: string; target: string }[];
};

export function hashFile(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Recursively list every regular-file relative path under `dir` (POSIX-separated, sorted),
 * plus every symlink encountered as a separate `{ rel, target }` entry (never followed into
 * its target's own tree). Used both to walk a bundle source tree (which must never contain
 * symlinks -- see buildOwnedFilesManifest's guard) and, by the uninstaller, to walk a legacy
 * destination tree that may.
 */
export function listOwnedTree(dir: string): { files: string[]; symlinks: { rel: string; target: string }[] } {
  const files: string[] = [];
  const symlinks: { rel: string; target: string }[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full).split(path.sep).join("/");
      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = fs.realpathSync(full);
        } catch {
          continue;
        }
        symlinks.push({ rel, target });
        continue;
      }
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.isFile()) files.push(rel);
    }
  };
  walk(dir);
  return { files, symlinks };
}

/**
 * One (bundle source tree -> installed dest tree) mapping contributing to a single ownership
 * manifest. `prefix` (may be "") is prepended to every relative path recorded in the manifest,
 * so multiple mappings (e.g. skills/ and agents/ for a --global install) can be combined into
 * one flat manifest with unambiguous, non-colliding relative paths.
 */
export type OwnedFilesMapping = { sourceDir: string; destDir: string; prefix: string };

/**
 * Build an ownership manifest by walking each mapping's SOURCE tree (the bundle content that
 * was installed -- never the destination) to derive the exact set of relative paths the
 * install wrote, then hashing the corresponding DEST file for each. Deriving the path set from
 * the bundle rather than the destination is deliberate: it bounds every walk to a small,
 * controlled tree (never an arbitrary user workspace or an unrelated pre-existing dest
 * subtree) and it never misattributes ownership of a file the installer did not itself place
 * there (e.g. a legacy symlink already sitting in a --global skills directory).
 *
 * `excludeRel` is matched against the prefixed relative path and skips both hashing and
 * inclusion (used for files a caller manages separately, such as `.claude/settings.json`).
 */
export function buildOwnedFilesManifest(params: {
  mappings: OwnedFilesMapping[];
  excludeRel?: Set<string>;
  runtime: string;
  version: string;
  global: boolean;
}): OwnedFilesManifest {
  const exclude = params.excludeRel ?? new Set<string>();
  const files: OwnedFileEntry[] = [];
  for (const mapping of params.mappings) {
    if (!fs.existsSync(mapping.sourceDir)) continue;
    const { files: relFiles, symlinks: relSymlinks } = listOwnedTree(mapping.sourceDir);
    if (relSymlinks.length > 0) {
      throw new Error(
        `Flow Agents install source unexpectedly contains symlink(s) under ${mapping.sourceDir}: ${relSymlinks.map((s) => s.rel).join(", ")}`
      );
    }
    for (const rel of relFiles) {
      const combined = mapping.prefix ? `${mapping.prefix}/${rel}` : rel;
      if (exclude.has(combined)) continue;
      const destPath = path.join(mapping.destDir, ...rel.split("/"));
      if (!fs.existsSync(destPath)) continue;
      files.push({ path: combined, sha256: hashFile(destPath) });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    schema_version: "1.0",
    generated_at: new Date().toISOString(),
    runtime: params.runtime,
    version: params.version,
    global: params.global,
    files,
    symlinks: [],
  };
}

export function writeOwnedFilesManifest(dest: string, manifest: OwnedFilesManifest): void {
  const manifestPath = ownedFilesManifestPath(dest);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const tmp = `${manifestPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, manifestPath);
}

/** Returns null (never throws) when the manifest is absent, unreadable, or an unsupported schema. */
export function readOwnedFilesManifest(dest: string): OwnedFilesManifest | null {
  const manifestPath = ownedFilesManifestPath(dest);
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    if (parsed["schema_version"] !== "1.0" || !Array.isArray(parsed["files"])) return null;
    return parsed as unknown as OwnedFilesManifest;
  } catch {
    return null;
  }
}
