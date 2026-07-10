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

/** Copy through a verified sibling directory, then swap with rollback. */
export function copyDirAtomic(root: string, src: string, dest: string): void {
  assertPathsDisjoint(src, dest);
  const parent = ensureSafeDirectory(root, path.dirname(dest));
  if (fs.existsSync(dest)) {
    const stat = fs.lstatSync(dest);
    if (stat.isSymbolicLink()) throw new Error(`refusing to replace symlink: ${dest}`);
    if (!stat.isDirectory()) throw new Error(`destination is not a directory: ${dest}`);
  }
  const nonce = `${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const temp = path.join(parent, `.${path.basename(dest)}.flow-agents-${nonce}.tmp`);
  const backup = path.join(parent, `.${path.basename(dest)}.flow-agents-${nonce}.old`);
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
    fs.rmSync(backup, { recursive: true, force: true });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    if (fs.existsSync(backup) && !fs.existsSync(dest)) fs.renameSync(backup, dest);
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
    if (stat.isDirectory()) out.push(...walkFiles(file));
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
