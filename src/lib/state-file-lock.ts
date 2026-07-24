import * as fs from "node:fs";
import { randomBytes } from "node:crypto";
import * as path from "node:path";

const WAIT_MS = 30_000;
const STALE_MS = 5 * 60_000;

type FileIdentity = { dev: number; ino: number };
type StateLock = {
  lockDir: string;
  ownerFile: string;
  token: string;
  lockIdentity: FileIdentity;
  ownerIdentity: FileIdentity;
};

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readOwner(file: string): { token: string } | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as { token?: unknown };
    return typeof value.token === "string" && value.token ? { token: value.token } : null;
  } catch {
    return null;
  }
}

function captureStateParentIdentity(file: string): FileIdentity {
  const parent = path.dirname(file);
  const stat = fs.lstatSync(parent);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`state file parent must be a real directory: ${parent}`);
  }
  return { dev: stat.dev, ino: stat.ino };
}

function assertStateParentIdentity(file: string, expected: FileIdentity): void {
  const parent = path.dirname(file);
  const current = fs.lstatSync(parent);
  if (
    current.isSymbolicLink()
    || !current.isDirectory()
    || current.dev !== expected.dev
    || current.ino !== expected.ino
  ) {
    throw new Error(`state file parent changed during locked update: ${parent}`);
  }
}

function sameIdentity(left: fs.Stats, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function removeOwnEmptyLockDirectory(lockDir: string, identity: FileIdentity): void {
  try {
    const current = fs.lstatSync(lockDir);
    if (!current.isSymbolicLink() && current.isDirectory() && sameIdentity(current, identity)) {
      fs.rmdirSync(lockDir);
    }
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw error;
    }
  }
}

function createStateLock(lockDir: string, ownerFile: string, token: string): StateLock {
  fs.mkdirSync(lockDir);
  let lockIdentity: FileIdentity | null = null;
  let ownerIdentity: FileIdentity | null = null;
  try {
    const lock = fs.lstatSync(lockDir);
    lockIdentity = { dev: lock.dev, ino: lock.ino };
    fs.writeFileSync(
      ownerFile,
      `${JSON.stringify({ token, pid: process.pid, acquired_at: new Date().toISOString() })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    const owner = fs.lstatSync(ownerFile);
    ownerIdentity = { dev: owner.dev, ino: owner.ino };
    return {
      lockDir,
      ownerFile,
      token,
      lockIdentity,
      ownerIdentity,
    };
  } catch (error) {
    if (lockIdentity && ownerIdentity) {
      releaseStateLock({ lockDir, ownerFile, token, lockIdentity, ownerIdentity });
    } else if (lockIdentity) {
      removeOwnEmptyLockDirectory(lockDir, lockIdentity);
    }
    throw error;
  }
}

function assertLiveContendedLock(lockDir: string, ownerFile: string): void {
  const owner = readOwner(ownerFile);
  const stat = fs.lstatSync(owner ? ownerFile : lockDir);
  if (stat.isSymbolicLink() || !(owner ? stat.isFile() : stat.isDirectory())) {
    throw new Error(`state file lock has an unsafe owner: ${lockDir}`);
  }
  if (Date.now() - stat.mtimeMs > STALE_MS) {
    throw new Error(`state file lock is stale or malformed and requires explicit operator cleanup: ${lockDir}`);
  }
}

function acquireStateLock(file: string): StateLock {
  const lockDir = `${file}.lockdir`;
  const ownerFile = path.join(lockDir, "owner.json");
  const token = randomBytes(16).toString("hex");
  const deadline = Date.now() + WAIT_MS;
  while (true) {
    try {
      return createStateLock(lockDir, ownerFile, token);
    } catch (error) {
      const lockError = error as NodeJS.ErrnoException;
      if (lockError.code !== "EEXIST") throw lockError;
      try {
        assertLiveContendedLock(lockDir, ownerFile);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for state file lock: ${lockDir}`);
      sleepSync(20);
    }
  }
}

function assertStateLockOwned(file: string, parentIdentity: FileIdentity, lock: StateLock): void {
  assertStateParentIdentity(file, parentIdentity);
  const currentLock = fs.lstatSync(lock.lockDir);
  const currentOwner = fs.lstatSync(lock.ownerFile);
  if (
    currentLock.isSymbolicLink() || !currentLock.isDirectory()
    || !sameIdentity(currentLock, lock.lockIdentity)
    || currentOwner.isSymbolicLink() || !currentOwner.isFile()
    || !sameIdentity(currentOwner, lock.ownerIdentity)
    || readOwner(lock.ownerFile)?.token !== lock.token
  ) {
    throw new Error(`state file lock detached from its protected parent: ${lock.lockDir}`);
  }
}

function releaseStateLock(lock: StateLock): void {
  try {
    const currentLock = fs.lstatSync(lock.lockDir);
    const currentOwner = fs.lstatSync(lock.ownerFile);
    if (
      sameIdentity(currentLock, lock.lockIdentity)
      && sameIdentity(currentOwner, lock.ownerIdentity)
      && readOwner(lock.ownerFile)?.token === lock.token
    ) {
      fs.unlinkSync(lock.ownerFile);
      fs.rmdirSync(lock.lockDir);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function withStateFileLock<T>(
  file: string,
  body: (parentIdentity: FileIdentity) => T,
): T {
  const parentIdentity = captureStateParentIdentity(file);
  const lock = acquireStateLock(file);
  try {
    assertStateLockOwned(file, parentIdentity, lock);
    return body(parentIdentity);
  } finally {
    releaseStateLock(lock);
  }
}

function readExistingState(
  file: string,
  parentIdentity: FileIdentity,
): { raw: string; identity: FileIdentity } {
  assertStateParentIdentity(file, parentIdentity);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`state file must be a regular file: ${file}`);
    const openedPath = fs.lstatSync(file);
    assertStateParentIdentity(file, parentIdentity);
    if (
      openedPath.isSymbolicLink()
      || !openedPath.isFile()
      || openedPath.dev !== stat.dev
      || openedPath.ino !== stat.ino
    ) {
      throw new Error(`state file changed during descriptor open: ${file}`);
    }
    const raw = fs.readFileSync(descriptor, "utf8");
    const current = fs.lstatSync(file);
    assertStateParentIdentity(file, parentIdentity);
    if (
      current.isSymbolicLink()
      || !current.isFile()
      || current.dev !== stat.dev
      || current.ino !== stat.ino
    ) {
      throw new Error(`state file changed during locked update: ${file}`);
    }
    return { raw, identity: { dev: stat.dev, ino: stat.ino } };
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeAll(descriptor: number, content: string): void {
  const bytes = Buffer.from(content);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = fs.writeSync(
      descriptor,
      bytes,
      offset,
      bytes.byteLength - offset,
      offset,
    );
    if (written <= 0) throw new Error("state file replacement made no progress");
    offset += written;
  }
}

function fsyncStateParent(file: string, parentIdentity: FileIdentity): void {
  assertStateParentIdentity(file, parentIdentity);
  const descriptor = fs.openSync(
    path.dirname(file),
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isDirectory() || !sameIdentity(stat, parentIdentity)) {
      throw new Error(`state file parent changed before directory fsync: ${path.dirname(file)}`);
    }
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function atomicReplaceState(
  file: string,
  parentIdentity: FileIdentity,
  expectedIdentity: FileIdentity | null,
  content: string,
): void {
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  assertStateParentIdentity(file, parentIdentity);
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  let descriptorOpen = true;
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`state replacement must be a regular file: ${temporary}`);
    const temporaryIdentity = { dev: stat.dev, ino: stat.ino };
    writeAll(descriptor, content);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptorOpen = false;
    assertStateParentIdentity(file, parentIdentity);
    try {
      const current = fs.lstatSync(file);
      if (
        !expectedIdentity
        || current.isSymbolicLink()
        || !current.isFile()
        || !sameIdentity(current, expectedIdentity)
      ) {
        throw new Error(`state file changed before atomic replacement: ${file}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || expectedIdentity) throw error;
    }
    fs.renameSync(temporary, file);
    const installed = fs.lstatSync(file);
    assertStateParentIdentity(file, parentIdentity);
    if (
      installed.isSymbolicLink()
      || !installed.isFile()
      || !sameIdentity(installed, temporaryIdentity)
    ) {
      throw new Error(`state replacement identity changed during install: ${file}`);
    }
    fsyncStateParent(file, parentIdentity);
  } finally {
    if (descriptorOpen) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function parseStatePayload(raw: string, file: string): Record<string, unknown> {
  const value = JSON.parse(raw) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`state file must contain a JSON object: ${file}`);
  }
  return value as Record<string, unknown>;
}

export function writeStateJson(file: string, payload: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  withStateFileLock(file, (parentIdentity) => {
    const content = `${JSON.stringify(payload, null, 2)}\n`;
    let existing: { identity: FileIdentity } | null = null;
    try {
      existing = readExistingState(file, parentIdentity);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    atomicReplaceState(file, parentIdentity, existing?.identity ?? null, content);
  });
}

export function updateStateJson(
  file: string,
  update: (current: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  return withStateFileLock(file, (parentIdentity) => {
    let existing: { raw: string; identity: FileIdentity } | null = null;
    try {
      existing = readExistingState(file, parentIdentity);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const next = update(existing ? parseStatePayload(existing.raw, file) : {});
    atomicReplaceState(
      file,
      parentIdentity,
      existing?.identity ?? null,
      `${JSON.stringify(next, null, 2)}\n`,
    );
    return next;
  });
}

export function replaceStateIfUnchanged(
  file: string,
  expectedRaw: string,
  nextRaw: string,
): boolean {
  return withStateFileLock(file, (parentIdentity) => {
    const existing = readExistingState(file, parentIdentity);
    if (existing.raw !== expectedRaw) return false;
    atomicReplaceState(file, parentIdentity, existing.identity, nextRaw);
    return true;
  });
}
