import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

export function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function existingAncestor(file: string): { ancestor: string; missing: string[] } {
  let current = path.resolve(file);
  const missing: string[] = [];
  while (!fs.existsSync(current)) {
    missing.unshift(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { ancestor: current, missing };
}

/** Resolve a possibly-missing path through its nearest existing ancestor. */
export function canonicalProspectivePath(file: string): string {
  const { ancestor, missing } = existingAncestor(file);
  return path.resolve(fs.realpathSync(ancestor), ...missing);
}

function isContained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Reject equality and either-direction containment after canonical resolution. */
export function assertPathsDisjoint(first: string, second: string): void {
  const firstReal = canonicalProspectivePath(first);
  const secondReal = canonicalProspectivePath(second);
  if (isContained(firstReal, secondReal) || isContained(secondReal, firstReal)) {
    throw new Error(`refusing overlapping paths: ${firstReal} and ${secondReal}`);
  }
}

/**
 * Create a directory below root without following any symlink that already
 * exists at or below the root. Ambient aliases above root (for example macOS
 * /tmp -> /private/tmp) are resolved once and are not treated as destination
 * components.
 */
export function ensureSafeDirectory(root: string, directory: string): string {
  const rootPath = path.resolve(root);
  if (fs.existsSync(rootPath)) {
    const rootStat = fs.lstatSync(rootPath);
    if (rootStat.isSymbolicLink()) throw new Error(`refusing symlink destination root: ${rootPath}`);
    if (!rootStat.isDirectory()) throw new Error(`destination root is not a directory: ${rootPath}`);
  } else {
    const { ancestor, missing } = existingAncestor(rootPath);
    let current = fs.realpathSync(ancestor);
    for (const part of missing) {
      current = path.join(current, part);
      if (fs.existsSync(current)) {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) throw new Error(`refusing to write through symlink: ${current}`);
        if (!stat.isDirectory()) throw new Error(`destination component is not a directory: ${current}`);
      } else {
        fs.mkdirSync(current);
      }
    }
  }

  const rootReal = fs.realpathSync(rootPath);
  const target = path.resolve(directory);
  const prospective = canonicalProspectivePath(target);
  if (!isContained(rootReal, prospective)) throw new Error(`path escapes root: ${target}`);
  const relative = path.relative(rootReal, prospective);
  let current = rootReal;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`refusing to write through symlink: ${current}`);
      if (!stat.isDirectory()) throw new Error(`destination component is not a directory: ${current}`);
    } else {
      fs.mkdirSync(current);
    }
  }
  return prospective;
}

function assertSafeFileTarget(root: string, file: string): string {
  const target = path.resolve(file);
  ensureSafeDirectory(root, path.dirname(target));
  const rootReal = fs.realpathSync(path.resolve(root));
  const prospective = canonicalProspectivePath(target);
  if (!isContained(rootReal, prospective) || prospective === rootReal) throw new Error(`path escapes root: ${target}`);
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`refusing to replace symlink: ${target}`);
    if (!stat.isFile()) throw new Error(`destination is not a regular file: ${target}`);
  }
  return target;
}

/** Atomically replace a regular file without following a final-component symlink. */
export function atomicWriteFile(root: string, file: string, data: string | Buffer): void {
  const target = assertSafeFileTarget(root, file);
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.flow-agents-${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temp, data, { flag: "wx" });
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export function atomicWriteJson(root: string, file: string, value: unknown): void {
  atomicWriteFile(root, file, `${JSON.stringify(value, null, 2)}\n`);
}

export function atomicCopyFile(root: string, source: string, target: string): void {
  atomicWriteFile(root, target, fs.readFileSync(source));
}

export function copyDir(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (source) => !source.split(path.sep).some((part) => [".git", "__pycache__", ".pytest_cache"].includes(part)),
  });
}

/**
 * Additively copy every file under srcDir into destDir, creating directories as needed and
 * overwriting files whose content changed. Never deletes files in destDir that srcDir does not
 * own -- destDir may contain unrelated content (other kits, other tools) that this sync must not
 * touch. Shared by `flow-agents init`'s --global skills/agents sync and `flow-agents kit
 * activate`'s built-in kit skill install -- deliberately kept in this dependency-light module
 * (no esbuild/build-tooling imports) rather than in src/cli/init.ts, so a consumer that must stay
 * runnable from a stripped install destination (no node_modules, no dist/) -- e.g. src/cli/kit.ts,
 * shipped standalone into a Codex home install -- can use it without pulling in
 * build-universal-bundles.ts's esbuild dependency through init.ts's module graph.
 */
export function copyDirMerge(srcDir: string, destDir: string): { added: number; updated: number } {
  let added = 0;
  let updated = 0;
  if (!fs.existsSync(srcDir)) return { added, updated };
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      const nested = copyDirMerge(srcPath, destPath);
      added += nested.added;
      updated += nested.updated;
      continue;
    }
    if (!entry.isFile()) continue;
    const content = fs.readFileSync(srcPath);
    if (fs.existsSync(destPath)) {
      if (Buffer.compare(fs.readFileSync(destPath), content) === 0) continue;
      updated += 1;
    } else {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      added += 1;
    }
    fs.writeFileSync(destPath, content);
  }
  return { added, updated };
}

/**
 * Walk up from every entry in `startDirs`, removing each now-empty directory until reaching
 * `root` (exclusive) or a non-empty directory. Shared by `flow-agents init --uninstall` and
 * `flow-agents kit deactivate`'s manifest-backed skill removal, both of which need to prune a
 * skill's now-empty directory after removing its files without touching anything still occupied.
 * Kept in this dependency-light module for the same reason as copyDirMerge above.
 */
export function pruneEmptyDirs(root: string, startDirs: Iterable<string>): void {
  const rootResolved = path.resolve(root);
  const sorted = [...new Set(startDirs)].sort((a, b) => b.length - a.length);
  for (const start of sorted) {
    let current = path.resolve(start);
    while (current !== rootResolved && current.startsWith(`${rootResolved}${path.sep}`)) {
      try {
        fs.rmdirSync(current);
      } catch {
        break; // not empty, or already gone -- stop walking up this branch
      }
      current = path.dirname(current);
    }
  }
}

function copiedTreeDigest(root: string): string {
  const hash = crypto.createHash("sha256");
  for (const file of walkFiles(root)) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (rel.split("/").some((part) => [".git", "__pycache__", ".pytest_cache"].includes(part))) continue;
    hash.update(rel);
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export type DirectoryCopyTransaction<T> = {
  value: T | undefined;
  commit(): Error | undefined;
  rollback(): void;
};

export type DirectoryCopyTransactionOptions = {
  removeBackup?: (backup: string) => void;
};

function directoryCopyLockPath(parent: string, dest: string): string {
  return path.join(parent, `.${path.basename(dest)}.flow-agents.lock`);
}

function acquireDirectoryCopyLock(parent: string, dest: string): () => Error | undefined {
  const lock = directoryCopyLockPath(parent, dest);
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
      const error = new Error(`directory copy transaction is active or requires recovery: ${lock}`) as Error & { code?: string };
      error.code = "DIRECTORY_COPY_LOCKED";
      throw error;
    }
    const error = cause instanceof Error ? cause : new Error(String(cause));
    throw error;
  }
  return () => {
    try {
      fs.rmdirSync(lock);
      return undefined;
    } catch (cause) {
      return cause instanceof Error ? cause : new Error(String(cause));
    }
  };
}

/**
 * Remove only old backups from a completed directory-copy transaction. The
 * caller must first prove its registry still binds the installed target. A
 * live copy transaction owns the same lock, so cleanup skips rather than
 * touching a rollback backup while a replacement is in flight.
 */
export function cleanupDirectoryCopyBackups(root: string, dest: string): Error[] {
  const parent = ensureSafeDirectory(root, path.dirname(dest));
  const escapedName = path.basename(dest).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const artifact = new RegExp(`^\\.${escapedName}\\.flow-agents-[0-9]+-[0-9a-f]{12}\\.old$`);
  let releaseLock: (() => Error | undefined) | undefined;
  try {
    releaseLock = acquireDirectoryCopyLock(parent, dest);
  } catch (cause) {
    return [cause instanceof Error ? cause : new Error(String(cause))];
  }
  const errors: Error[] = [];
  try {
    for (const name of fs.readdirSync(parent)) {
      if (!artifact.test(name)) continue;
      try { fs.rmSync(path.join(parent, name), { recursive: true, force: true }); }
      catch (cause) { errors.push(cause instanceof Error ? cause : new Error(String(cause))); }
    }
  } finally {
    const releaseError = releaseLock();
    if (releaseError) errors.push(releaseError);
  }
  return errors;
}

/**
 * Copy through a verified sibling directory, then swap with an explicit
 * commit/rollback boundary. Callers that persist related metadata can retain
 * the prior directory until that metadata write has succeeded.
 */
export function copyDirAtomicTransaction<T = void>(root: string, src: string, dest: string, verify?: (target: string) => T, options?: DirectoryCopyTransactionOptions): DirectoryCopyTransaction<T> {
  assertPathsDisjoint(src, dest);
  const parent = ensureSafeDirectory(root, path.dirname(dest));
  if (fs.existsSync(dest)) {
    const stat = fs.lstatSync(dest);
    if (stat.isSymbolicLink()) throw new Error(`refusing to replace symlink: ${dest}`);
    if (!stat.isDirectory()) throw new Error(`destination is not a directory: ${dest}`);
  }
  const releaseLock = acquireDirectoryCopyLock(parent, dest);
  const nonce = `${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const temp = path.join(parent, `.${path.basename(dest)}.flow-agents-${nonce}.tmp`);
  const backup = path.join(parent, `.${path.basename(dest)}.flow-agents-${nonce}.old`);
  let transactionOpen = false;
  const restore = (): void => {
    fs.rmSync(dest, { recursive: true, force: true });
    if (fs.existsSync(backup)) fs.renameSync(backup, dest);
  };
  try {
    fs.cpSync(src, temp, {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: (source) => !source.split(path.sep).some((part) => [".git", "__pycache__", ".pytest_cache"].includes(part)),
    });
    if (copiedTreeDigest(src) !== copiedTreeDigest(temp)) throw new Error(`copied kit verification failed: ${src}`);
    if (fs.existsSync(dest)) fs.renameSync(dest, backup);
    try {
      fs.renameSync(temp, dest);
    } catch (error) {
      if (fs.existsSync(backup)) fs.renameSync(backup, dest);
      throw error;
    }
    let verified: T | undefined;
    try {
      verified = verify?.(dest);
    } catch (error) {
      restore();
      throw error;
    }
    transactionOpen = true;
    return {
      value: verified,
      commit(): Error | undefined {
        if (!transactionOpen) return undefined;
        transactionOpen = false;
        let cleanupError: Error | undefined;
        try {
          if (options?.removeBackup) options.removeBackup(backup);
          else fs.rmSync(backup, { recursive: true, force: true });
        } catch (cause) {
          cleanupError = cause instanceof Error ? cause : new Error(String(cause));
        }
        const releaseError = releaseLock();
        if (!cleanupError && releaseError) cleanupError = releaseError;
        return cleanupError;
      },
      rollback(): void {
        if (!transactionOpen) return;
        try {
          restore();
          transactionOpen = false;
        } finally {
          releaseLock();
        }
      },
    };
  } finally {
    try {
      fs.rmSync(temp, { recursive: true, force: true });
      if (!transactionOpen && fs.existsSync(backup) && !fs.existsSync(dest)) fs.renameSync(backup, dest);
    } finally {
      if (!transactionOpen) releaseLock();
    }
  }
}

/** Copy through a verified sibling directory, then swap with rollback. */
export function copyDirAtomic<T = void>(root: string, src: string, dest: string, verify?: (target: string) => T): T | undefined {
  const transaction = copyDirAtomicTransaction(root, src, dest, verify);
  try {
    return transaction.value;
  } finally {
    const cleanupError = transaction.commit();
    if (cleanupError) throw cleanupError;
  }
}

export function assertPathContained(root: string, target: string): void {
  const rootReal = fs.realpathSync(root);
  let existingParent = path.dirname(target);
  const missingParts = [path.basename(target)];
  while (!fs.existsSync(existingParent)) {
    missingParts.unshift(path.basename(existingParent));
    const next = path.dirname(existingParent);
    if (next === existingParent) break;
    existingParent = next;
  }
  const parentReal = fs.realpathSync(existingParent);
  const resolved = path.resolve(parentReal, ...missingParts);
  const relative = path.relative(rootReal, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`path escapes root: ${target}`);
  if (fs.existsSync(target)) {
    const targetReal = fs.realpathSync(target);
    const targetRelative = path.relative(rootReal, targetReal);
    if (!targetRelative || targetRelative.startsWith("..") || path.isAbsolute(targetRelative)) throw new Error(`path escapes root: ${target}`);
  }
}

export function walkFiles(root: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(root)) return out;
  for (const name of fs.readdirSync(root).sort()) {
    const file = path.join(root, name);
    const stat = fs.statSync(file);
    // Push individually rather than spreading: a spread passes one argument per path
    // and overflows the engine's argument limit on large subtrees. See src/tools/common.ts.
    if (stat.isDirectory()) for (const nested of walkFiles(file)) out.push(nested);
    else if (stat.isFile()) out.push(file);
  }
  return out;
}

export function relPath(root: string, file: string): string {
  const rel = path.relative(root, file);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : file.split(path.sep).join("/");
}

export function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
