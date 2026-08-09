import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { durableFlowAgentsRoot, ownedFilesManifestPath } from "./local-artifact-root.js";

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

/**
 * Merge additional owned-file entries into an existing manifest, replacing any existing entry at
 * the same path and keeping the result sorted by path. Used by `flow-agents kit activate` to add
 * a built-in kit's newly-installed skill files to the durable ownership manifest incrementally,
 * without discarding entries the manifest already carries for unrelated files (other kits,
 * agents/, other skills).
 */
export function mergeOwnedFilesManifestEntries(manifest: OwnedFilesManifest, newEntries: OwnedFileEntry[]): OwnedFilesManifest {
  const byPath = new Map(manifest.files.map((entry) => [entry.path, entry]));
  for (const entry of newEntries) byPath.set(entry.path, entry);
  return { ...manifest, generated_at: new Date().toISOString(), files: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}

/**
 * Remove owned-file entries whose path is in `removePaths` from an existing manifest. Used by
 * `flow-agents kit deactivate` after successfully removing a built-in kit's skill files from
 * disk, so the durable ownership manifest never keeps claiming ownership of a file that is no
 * longer there.
 */
export function removeOwnedFilesManifestEntries(manifest: OwnedFilesManifest, removePaths: Set<string>): OwnedFilesManifest {
  return { ...manifest, generated_at: new Date().toISOString(), files: manifest.files.filter((entry) => !removePaths.has(entry.path)) };
}

export function writeOwnedFilesManifest(dest: string, manifest: OwnedFilesManifest): void {
  const manifestPath = ownedFilesManifestPath(dest);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const tmp = `${manifestPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, manifestPath);
}

/** Returns null (never throws) when the manifest is absent, unreadable, or an unsupported schema. */
export function readOwnedFilesManifest(dest: string, manifestName = "owned-files.json"): OwnedFilesManifest | null {
  const manifestPath = path.join(durableFlowAgentsRoot(dest), manifestName);
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    if (parsed["schema_version"] !== "1.0" || !Array.isArray(parsed["files"])) return null;
    return parsed as unknown as OwnedFilesManifest;
  } catch {
    return null;
  }
}

/**
 * Resolve one manifest file entry's relative path to a safe absolute path under `dest`, or
 * throw a clear, entry-naming error. This is the LEXICAL half of the containment check every
 * manifest-backed removal MUST go through before touching the filesystem -- a manifest is not a
 * trusted input (it can be hand-edited, corrupted, or -- for project-scoped installs -- committed
 * to a shared repo and edited by anyone with write access), and an unvalidated
 * `path.join(dest, ...)` lets a `"../../victim"` entry resolve and delete files anywhere the
 * process can reach.
 *
 * This function alone is NOT sufficient: it never touches the filesystem for the entry's own
 * path components, so it cannot detect an INTERMEDIATE directory that is on-disk a symlink
 * pointing outside `dest` (a lexically-in-bounds entry like "skills/evilfile" still resolves to a
 * physically out-of-bounds file when `dest/skills` is itself a symlink -- the kernel follows it
 * at the moment `fs.lstatSync`/`fs.rmSync` actually touch the path). Every caller MUST also call
 * `assertManifestEntryParentContained` immediately before touching the entry -- see that
 * function's docstring for why this is a second, separate check rather than folded in here.
 *
 * Deliberately throws rather than skip-and-continue: a manifest containing even one unsafe entry
 * is treated as untrustworthy as a whole, not partially honored. Resolves `dest` itself through
 * `realpathSync` first so containment is checked against the REAL install root, not a symlink
 * placed at `dest` that could otherwise be used to redirect the containment check itself.
 */
export function resolveManifestEntryPath(dest: string, relPath: unknown): string {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new Error(`owned-files.json entry has an invalid path: ${JSON.stringify(relPath)}`);
  }
  if (relPath.startsWith("/") || relPath.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(relPath)) {
    throw new Error(`owned-files.json entry has an absolute path, refusing to use it: "${relPath}"`);
  }
  const parts = relPath.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`owned-files.json entry escapes the install root (unsafe path segment): "${relPath}"`);
  }
  let destReal: string;
  try {
    destReal = fs.realpathSync(dest);
  } catch {
    destReal = path.resolve(dest);
  }
  const realTarget = path.resolve(destReal, ...parts);
  const relative = path.relative(destReal, realTarget);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`owned-files.json entry escapes the install root: "${relPath}" resolves outside ${destReal}`);
  }
  // Containment is proven against the REAL (symlink-resolved) root above, but the path this
  // function RETURNS is built from the original, unresolved `dest` -- every other part of the
  // uninstall plan (pruneEmptyDirs' root, the durable artifact root, residue checks, etc.)
  // consistently uses the unresolved `dest` too, and mixing the two bases here would make
  // dest-relative containment/pruning logic elsewhere silently stop matching (a real regression
  // caught while testing this fix: pruneEmptyDirs' prefix check failed silently whenever `dest`
  // crosses a symlink, e.g. macOS's /tmp -> /private/tmp, leaving emptied directories behind).
  return path.resolve(dest, ...parts);
}

/** Validate a manifest entry's `sha256` field is a well-formed hex digest, or throw naming the entry. */
export function resolveManifestEntrySha256(entryPathForError: string, sha256: unknown): string {
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(sha256)) {
    throw new Error(`owned-files.json entry "${entryPathForError}" has an invalid sha256: ${JSON.stringify(sha256)}`);
  }
  return sha256;
}

/**
 * The FILESYSTEM half of manifest entry containment: verify `absPath`'s PARENT directory, once
 * resolved through any symlinks (`fs.realpathSync`, which resolves every intermediate component
 * in the chain, not just the last one), still sits inside `dest`'s own resolved root.
 *
 * Deliberately checks only the PARENT, never `absPath` itself: the final path component is the
 * removal target, and for a manifest-mode entry that target is refused/preserved (never removed)
 * the moment it turns out to be a symlink at all (see planFromManifest's `stat.isSymbolicLink()`
 * check) -- so the final component reaching this function is always either a plain file or
 * already absent, and requiring IT to resolve inside `dest` would be redundant. (The unrelated,
 * legitimate legacy-mode skill-symlink-chain feature -- `dest/skills/<name>` as a symlink to
 * `~/.agents/skills/<name>` -- is handled entirely by a different code path,
 * `diffSkillsForLegacyRemoval`/`skillContentMatchesBundle`, which resolves and re-verifies that
 * symlink's target explicitly; it never goes through `resolveManifestEntryPath` at all, since a
 * manifest never legitimately references a path through that chain -- the manifest writer itself
 * never creates symlinks. This check cannot collide with that feature.)
 *
 * Must be called immediately before every removal that used `resolveManifestEntryPath`, at BOTH
 * plan time (`planFromManifest`, so a poisoned or coincidentally-symlinked path is never even
 * planned -- throws, aborting the whole run) and again at apply time (`applyPlan`'s `removeFiles`
 * loop, treated as a TOCTOU-class re-check -- preserve, don't delete, don't abort the rest of the
 * run -- since a symlink could be swapped into an intermediate directory during the window
 * between planning and confirmation, same class as the content-hash TOCTOU check).
 *
 * A parent directory that does not exist at all is not a containment violation (nothing to escape
 * through) -- the caller's normal "entry already gone" handling takes over via the subsequent
 * `lstatSync` on the entry itself.
 */
/**
 * Thrown by `assertManifestEntryParentContained` only for a genuine containment violation (the
 * parent directory really does resolve outside `dest`). Distinct from any other error the same
 * function can propagate (e.g. an `fs.realpathSync` failure such as `ELOOP`/`EACCES` on a
 * component other than a missing leaf) so callers can tell "we detected an escape" from "we
 * could not determine containment because of an unrelated I/O error" and report each accurately
 * -- both are still always treated as fail-safe (preserve, never delete), only the REASON text
 * shown to the user differs.
 */
export class ManifestContainmentViolationError extends Error {}

export function assertManifestEntryParentContained(dest: string, absPath: string, relPathForError: string): void {
  const parent = path.dirname(absPath);
  let parentReal: string;
  try {
    parentReal = fs.realpathSync(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let destReal: string;
  try {
    destReal = fs.realpathSync(dest);
  } catch {
    destReal = path.resolve(dest);
  }
  const relative = path.relative(destReal, parentReal);
  if (relative !== "" && (relative.startsWith("..") || path.isAbsolute(relative))) {
    throw new ManifestContainmentViolationError(
      `owned-files.json entry escapes the install root through a symlinked parent directory: "${relPathForError}" (parent resolves to ${parentReal}, outside ${destReal})`
    );
  }
}
