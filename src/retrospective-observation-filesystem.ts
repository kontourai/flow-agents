import * as fs from "node:fs";
import * as path from "node:path";

export type DirectoryIdentity = {
  file: string;
  dev: number;
  ino: number;
  mode: number;
  uid: number;
};

export function confinedSourceFile(
  root: string,
  relativeFile: string,
  label: string,
): { file: string; directoryChain: DirectoryIdentity[] } {
  assertRelativeSourcePath(relativeFile, `${label} source file`);
  const candidate = path.resolve(root, relativeFile);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} source must remain inside the configured record root`);
  }
  const directoryChain = capturePinnedDirectoryChain(root);
  let cursor = root;
  try {
    const parts = relative.split(path.sep);
    for (const part of parts.slice(0, -1)) {
      cursor = path.join(cursor, part);
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("unsafe directory");
      assertSafeDirectoryMode(stat, `${label} source directory`);
      assertTrustedOwner(stat, `${label} source directory`);
      directoryChain.push({ file: cursor, dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid });
    }
    const final = fs.lstatSync(candidate);
    if (final.isSymbolicLink() || !final.isFile()) throw new Error("unsafe file");
    assertSafeFile(final, `${label} source file`);
  } catch (error) {
    if (error instanceof Error && ["unsafe directory", "unsafe file"].includes(error.message)) {
      throw new Error(`${label} source path must not contain symbolic links`);
    }
    throw new Error(`${label} source is unavailable (${errorClass(error)})`);
  }
  return { file: candidate, directoryChain };
}

export function readPinnedFile(
  file: string,
  label: string,
  maxBytes: number,
  directoryChain: DirectoryIdentity[] = [],
): Buffer {
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  let descriptor: number;
  try {
    assertDirectoryChain(directoryChain, label);
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    throw new Error(`${label} is unavailable (${errorClass(error)})`);
  }
  try {
    const opened = fs.fstatSync(descriptor);
    const linked = fs.lstatSync(file);
    if (!opened.isFile()
      || opened.size > maxBytes
      || linked.isSymbolicLink()
      || !linked.isFile()
      || opened.dev !== linked.dev
      || opened.ino !== linked.ino) {
      throw new Error(`${label} must be one bounded pinned regular file`);
    }
    assertSafeFile(linked, label);
    const bytes = readDescriptorBounded(descriptor, maxBytes, label);
    const current = fs.lstatSync(file);
    assertDirectoryChain(directoryChain, label);
    if (bytes.length > maxBytes
      || current.isSymbolicLink()
      || !current.isFile()
      || current.dev !== opened.dev
      || current.ino !== opened.ino) {
      throw new Error(`${label} changed during read`);
    }
    assertSafeFile(current, label);
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${label} `)) throw error;
    throw new Error(`${label} read failed (${errorClass(error)})`);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function capturePinnedDirectoryChain(directory: string): DirectoryIdentity[] {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  const chain = [directoryIdentity(parsed.root, "output root")];
  let cursor = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    chain.push(directoryIdentity(cursor, "output directory"));
  }
  assertOperatorBoundary(chain.at(-1)!, "directory boundary");
  return chain;
}

export function assertPinnedDirectoryChain(chain: DirectoryIdentity[]): void {
  assertDirectoryChain(chain, "output directory");
}

function directoryIdentity(file: string, label: string): DirectoryIdentity {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("unsafe directory");
    assertSafeDirectoryMode(stat, label);
    assertTrustedOwner(stat, label);
    return { file, dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid };
  } catch (error) {
    throw new Error(`${label} is unavailable (${errorClass(error)})`);
  }
}

function assertDirectoryChain(chain: DirectoryIdentity[], label: string): void {
  for (const expected of chain) {
    let current: fs.Stats;
    try {
      current = fs.lstatSync(expected.file);
    } catch (error) {
      throw new Error(`${label} directory chain changed (${errorClass(error)})`);
    }
    if (current.isSymbolicLink()
      || !current.isDirectory()
      || current.dev !== expected.dev
      || current.ino !== expected.ino
      || current.mode !== expected.mode
      || current.uid !== expected.uid) {
      throw new Error(`${label} directory chain changed`);
    }
    assertSafeDirectoryMode(current, label);
    assertTrustedOwner(current, label);
  }
}

function assertSafeDirectoryMode(stat: fs.Stats, label: string): void {
  const writableByOthers = (stat.mode & 0o022) !== 0;
  const sticky = (stat.mode & 0o1000) !== 0;
  if (writableByOthers && !sticky) throw new Error(`${label} must be operator-controlled`);
}

function assertTrustedOwner(stat: Pick<fs.Stats, "uid">, label: string): void {
  const operator = typeof process.getuid === "function" ? process.getuid() : null;
  if (operator !== null && stat.uid !== operator && stat.uid !== 0) {
    throw new Error(`${label} has an untrusted owner`);
  }
}

function assertOperatorBoundary(identity: DirectoryIdentity, label: string): void {
  const operator = typeof process.getuid === "function" ? process.getuid() : null;
  if (operator !== null && identity.uid !== operator) {
    throw new Error(`${label} must be owned by the current operator`);
  }
}

function assertSafeFile(
  stat: Pick<fs.Stats, "uid" | "mode">,
  label: string,
): void {
  assertTrustedOwner(stat, label);
  if ((stat.mode & 0o022) !== 0) throw new Error(`${label} must not be group/world writable`);
}

function readDescriptorBounded(descriptor: number, maxBytes: number, label: string): Buffer {
  const bytes = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset <= maxBytes) {
    const read = fs.readSync(descriptor, bytes, offset, maxBytes + 1 - offset, offset);
    if (read === 0) break;
    offset += read;
  }
  if (offset > maxBytes) throw new Error(`${label} exceeds its byte limit`);
  return bytes.subarray(0, offset);
}

function assertRelativeSourcePath(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > 4096
    || value.includes("\0")
    || path.isAbsolute(value)
    || value.split(/[\\/]/).some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} must be a bounded relative path without traversal`);
  }
}

function errorClass(error: unknown): string {
  if (isRecord(error) && typeof error.code === "string" && /^[A-Z0-9_]{1,32}$/.test(error.code)) {
    return error.code;
  }
  return error instanceof Error ? error.name : "UnknownError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
