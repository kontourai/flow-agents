import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  assertNoSymlinkAncestry,
  runtimeError,
  sameFile,
  sha256,
} from "./runtime-session-core.js";

const CURSOR_SCHEMA_VERSION = "1.0";
const MAX_CURSOR_BYTES = 1024 * 1024;

function canonicalTargetPath(target) {
  const absolute = path.resolve(target);
  if (fs.existsSync(absolute) && fs.lstatSync(absolute).isSymbolicLink()) {
    throw runtimeError("PATH_SYMLINK_REJECTED", "runtime-session target is a symbolic link");
  }
  const suffix = [];
  let existing = path.dirname(absolute);
  suffix.unshift(path.basename(absolute));
  while (!fs.existsSync(existing)) {
    suffix.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) {
      throw runtimeError("PATH_UNRESOLVED", "runtime-session path could not be resolved");
    }
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...suffix);
}

function readTelemetrySafely(telemetryFile, maxBytes) {
  let descriptor;
  try {
    const realFile = fs.realpathSync(telemetryFile);
    assertNoSymlinkAncestry(realFile);
    descriptor = fs.openSync(
      realFile,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || !sameFile(stat, fs.statSync(realFile))) {
      throw runtimeError(
        "TELEMETRY_NOT_REGULAR",
        "telemetry source is not a stable regular file",
      );
    }
    if (stat.size > maxBytes) {
      throw runtimeError("TELEMETRY_TOO_LARGE", "telemetry source exceeds the byte limit");
    }
    const telemetry = fs.readFileSync(descriptor);
    if (telemetry.length > maxBytes || fs.realpathSync(telemetryFile) !== realFile) {
      throw runtimeError("TELEMETRY_CHANGED", "telemetry source changed while it was being read");
    }
    const identity = sha256(`telemetry-generation\u0000${stat.dev}\u0000${stat.ino}`);
    return { telemetry, identity };
  } catch (error) {
    if (error?.code && String(error.code).startsWith("TELEMETRY_")) throw error;
    if (error?.code === "PATH_SYMLINK_REJECTED") throw error;
    throw runtimeError("TELEMETRY_UNREADABLE", "telemetry source could not be read");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function assertCursorOwnership(stat, isFile) {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  const wrongOwner = currentUid !== null && stat.uid !== currentUid;
  const unsafeMode = (stat.mode & (isFile ? 0o077 : 0o022)) !== 0;
  if (wrongOwner || unsafeMode) {
    throw runtimeError(
      "CURSOR_OWNERSHIP_INVALID",
      "runtime-session cursor ownership or permissions are unsafe",
    );
  }
}

function readCursorFile(cursorFile) {
  if (!fs.existsSync(cursorFile)) return null;
  assertNoSymlinkAncestry(cursorFile);
  let descriptor;
  try {
    assertCursorOwnership(fs.statSync(path.dirname(cursorFile)), false);
    descriptor = fs.openSync(
      cursorFile,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_CURSOR_BYTES) throw new Error("invalid cursor file");
    assertCursorOwnership(stat, true);
    return JSON.parse(fs.readFileSync(descriptor, "utf8"));
  } catch (error) {
    if (error?.code === "CURSOR_OWNERSHIP_INVALID") throw error;
    throw runtimeError("CURSOR_INVALID", "runtime-session cursor is invalid");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function validateCursor(cursor) {
  const validSessions = cursor?.seen_sessions === undefined ||
    (Array.isArray(cursor.seen_sessions) && cursor.seen_sessions.length <= 2_000 &&
      cursor.seen_sessions.every((entry) => entry &&
        typeof entry.key_sha256 === "string" &&
        typeof entry.transcript_sha256 === "string"));
  if (cursor?.schema_version !== CURSOR_SCHEMA_VERSION ||
      typeof cursor.source_sha256 !== "string" ||
      typeof cursor.prefix_sha256 !== "string" ||
      !Number.isInteger(cursor.byte_offset) || cursor.byte_offset < 0 || !validSessions) {
    throw runtimeError("CURSOR_INVALID", "runtime-session cursor has an invalid contract");
  }
}

function loadCursor(cursorFile, identity, telemetry) {
  const cursor = readCursorFile(cursorFile);
  if (!cursor) return { cursor: null, reset: false };
  validateCursor(cursor);
  const prefixMatches = cursor.byte_offset <= telemetry.length &&
    cursor.prefix_sha256 === sha256(telemetry.subarray(0, cursor.byte_offset));
  const reset = cursor.source_sha256 !== identity || !prefixMatches;
  if (!reset && cursor.byte_offset > 0 && telemetry[cursor.byte_offset - 1] !== 0x0a) {
    throw runtimeError("CURSOR_INVALID", "runtime-session cursor is not on a JSONL boundary");
  }
  return { cursor, reset };
}

export function writeCursor(cursorFile, cursor) {
  const directory = path.dirname(cursorFile);
  assertNoSymlinkAncestry(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertNoSymlinkAncestry(directory);
  assertCursorOwnership(fs.statSync(directory), false);
  const temporary = `${cursorFile}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`;
  let descriptor;
  try {
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW || 0);
    descriptor = fs.openSync(temporary, flags, 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(cursor, null, 2)}\n`, "utf8");
    const temporaryStat = fs.fstatSync(descriptor);
    if (!temporaryStat.isFile()) throw new Error("cursor temporary is not regular");
    assertCursorOwnership(temporaryStat, true);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, cursorFile);
    return true;
  } catch {
    throw runtimeError("CURSOR_WRITE_FAILED", "runtime-session cursor could not be committed");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch {}
  }
}

export function emptyCursor(identity = "unresolved") {
  return {
    schema_version: CURSOR_SCHEMA_VERSION,
    source_sha256: identity,
    prefix_sha256: sha256(Buffer.alloc(0)),
    byte_offset: 0,
    last_event_id: null,
    seen_sessions: [],
    updated_at: null,
  };
}

export function loadSource(options) {
  const cursorFile = canonicalTargetPath(options.cursorFile);
  const source = readTelemetrySafely(options.telemetryFile, options.maxTelemetryBytes);
  const loaded = loadCursor(cursorFile, source.identity, source.telemetry);
  if (!loaded.reset) {
    return { ...source, cursorFile, priorCursor: loaded.cursor, reset: false };
  }
  const extension = path.extname(options.telemetryFile);
  const telemetryBase = extension
    ? options.telemetryFile.slice(0, -extension.length)
    : options.telemetryFile;
  const predecessorFile = `${telemetryBase}.1${extension}`;
  if (fs.existsSync(predecessorFile)) {
    const predecessor = readTelemetrySafely(predecessorFile, options.maxTelemetryBytes);
    const predecessorCursor = loadCursor(cursorFile, predecessor.identity, predecessor.telemetry);
    if (!predecessorCursor.reset) {
      return {
        ...source,
        cursorFile,
        priorCursor: loaded.cursor,
        reset: true,
        predecessor: {
          ...predecessor,
          cursorFile,
          priorCursor: predecessorCursor.cursor,
          reset: false,
        },
      };
    }
  }
  throw runtimeError(
    "TELEMETRY_CONTINUITY_GAP",
    "telemetry changed without a matching rotated predecessor",
  );
}
