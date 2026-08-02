import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const EXCLUDED_PATH_COMPONENTS = new Set([
  ".git",
  "__pycache__",
  ".pytest_cache",
]);
const KIT_ID_RE = /^[a-z][a-z0-9-]*$/;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;

export type KitContentHashObservation =
  | { state: "observed"; observed_hash: string; diagnostic: null }
  | { state: "missing"; observed_hash: null; diagnostic: string }
  | { state: "invalid"; observed_hash: null; diagnostic: string };

export type InstalledKitIntegrity = {
  state: "installed" | "missing" | "drifted" | "invalid";
  recorded_hash: string | null;
  observed_hash: string | null;
  diagnostic: string | null;
};

function sameIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function excluded(relativePath: string): boolean {
  return relativePath
    .split("/")
    .some((part) => EXCLUDED_PATH_COMPONENTS.has(part));
}

function invalid(message: string): KitContentHashObservation {
  return { state: "invalid", observed_hash: null, diagnostic: message };
}

/**
 * Observe a Kit tree with the same canonical algorithm used at install time.
 *
 * The observer never follows symlinks and only hashes stable regular files. It
 * rejects special files, unreadable paths, and replacements observed while it
 * traverses so callers never mistake a partial or redirected tree for a hash.
 */
export function observeKitContentHash(root: string): KitContentHashObservation {
  const resolvedRoot = path.resolve(root);
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(resolvedRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        state: "missing",
        observed_hash: null,
        diagnostic: `installed kit copy is missing at ${resolvedRoot}`,
      };
    }
    return invalid(
      `cannot inspect kit root ${resolvedRoot}: ${(error as Error).message}`,
    );
  }
  if (rootStat.isSymbolicLink())
    return invalid(`refusing symbolic-link kit root: ${resolvedRoot}`);
  if (!rootStat.isDirectory())
    return invalid(`kit root is not a directory: ${resolvedRoot}`);

  const hash = crypto.createHash("sha256");
  try {
    const visit = (directory: string, relativeDirectory: string): void => {
      const before = fs.lstatSync(directory);
      if (before.isSymbolicLink())
        throw new Error(`refusing symbolic-link directory: ${directory}`);
      if (!before.isDirectory())
        throw new Error(
          `expected directory while observing kit content: ${directory}`,
        );

      const entries = fs
        .readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const file = path.join(directory, entry.name);
        const relative = relativeDirectory
          ? `${relativeDirectory}/${entry.name}`
          : entry.name;
        const fileBefore = fs.lstatSync(file);
        if (fileBefore.isSymbolicLink())
          throw new Error(`refusing symbolic link in kit content: ${relative}`);
        if (fileBefore.isDirectory()) {
          visit(file, relative);
          continue;
        }
        if (!fileBefore.isFile())
          throw new Error(
            `refusing non-regular file in kit content: ${relative}`,
          );
        const bytes = fs.readFileSync(file);
        const fileAfter = fs.lstatSync(file);
        if (!sameIdentity(fileBefore, fileAfter))
          throw new Error(
            `kit path changed while observing content: ${relative}`,
          );
        if (!excluded(relative)) {
          hash.update(relative);
          hash.update("\0");
          hash.update(bytes);
          hash.update("\0");
        }
      }

      const after = fs.lstatSync(directory);
      if (!sameIdentity(before, after))
        throw new Error(
          `kit path changed while observing content: ${relativeDirectory || "."}`,
        );
    };
    visit(resolvedRoot, "");
    const rootAfter = fs.lstatSync(resolvedRoot);
    if (!sameIdentity(rootStat, rootAfter))
      throw new Error(
        `kit root changed while observing content: ${resolvedRoot}`,
      );
    return {
      state: "observed",
      observed_hash: `sha256:${hash.digest("hex")}`,
      diagnostic: null,
    };
  } catch (error) {
    return invalid(
      `cannot safely observe kit content at ${resolvedRoot}: ${(error as Error).message}`,
    );
  }
}

/** Observe an installed registry entry without changing the registry. */
export function observeInstalledKitIntegrity(
  entry: Record<string, unknown>,
  dest: string,
): InstalledKitIntegrity {
  const recorded_hash = typeof entry.hash === "string" ? entry.hash : null;
  const id = typeof entry.id === "string" ? entry.id : null;
  if (!id || !KIT_ID_RE.test(id)) {
    return {
      state: "invalid",
      recorded_hash,
      observed_hash: null,
      diagnostic: "registry entry has an invalid kit id",
    };
  }
  const expectedPath = path.join(
    path.resolve(dest),
    "kits",
    "local",
    "repositories",
    id,
  );
  if (entry.installed_path !== expectedPath) {
    return {
      state: "invalid",
      recorded_hash,
      observed_hash: null,
      diagnostic: `registry installed_path does not match expected local path ${expectedPath}`,
    };
  }
  const observation = observeKitContentHash(expectedPath);
  if (observation.state === "missing") {
    return {
      state: "missing",
      recorded_hash,
      observed_hash: null,
      diagnostic: observation.diagnostic,
    };
  }
  if (observation.state === "invalid") {
    return {
      state: "invalid",
      recorded_hash,
      observed_hash: null,
      diagnostic: observation.diagnostic,
    };
  }
  if (!recorded_hash || !SHA256_RE.test(recorded_hash)) {
    return {
      state: "invalid",
      recorded_hash,
      observed_hash: observation.observed_hash,
      diagnostic: "registry hash is missing or is not a sha256 digest",
    };
  }
  return {
    state:
      recorded_hash === observation.observed_hash ? "installed" : "drifted",
    recorded_hash,
    observed_hash: observation.observed_hash,
    diagnostic:
      recorded_hash === observation.observed_hash
        ? null
        : "installed kit content does not match the registry hash",
  };
}
