/**
 * Small shared helpers for the dream run (#671). Nothing here is a durability
 * layer: files are written with a temp file and a rename, and the run's
 * crash-safety comes from committing the cursor last (see run.js).
 *
 * @module dream/util
 */

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export function dreamError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Write `content` to `file` through a private temp file and a rename. Returns false when the bytes already match. */
export function writePrivateAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    if (fs.readFileSync(file, "utf8") === content) return false;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
  return true;
}

export function assertAbsolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw dreamError("DREAM_CONFIG_INVALID", `${label} must be an absolute path`);
  }
  return value;
}

/** Project id from a scrubbed session cwd (`~/dev/ledger` -> `ledger`). A bare home or root directory is not a project. */
export function projectFromCwd(cwd) {
  if (typeof cwd !== "string") return null;
  const name = path.posix.basename(cwd.replace(/\/+$/, ""));
  if (!name || name === "~" || name === "/") return null;
  const id = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return id || null;
}

/** Truncate to at most `bytes` UTF-8 bytes without splitting a code point; adds an ellipsis when it cuts. */
export function truncateUtf8(text, bytes) {
  const value = String(text);
  if (Buffer.byteLength(value) <= bytes) return value;
  const marker = "…";
  const room = bytes - Buffer.byteLength(marker);
  if (room < 0) return "";
  let out = "";
  let used = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (used + size > room) break;
    out += character;
    used += size;
  }
  return `${out}${marker}`;
}
