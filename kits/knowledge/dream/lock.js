/**
 * Single-writer lock for a dream run (#671).
 *
 * Mutual exclusion only: a hook trigger can fire while a scheduled run is still
 * going, and two runs must not interleave their reads of the cursor. It records
 * no run progress. Crash-safety is the cursor-last design plus Corpus proposals
 * (see run.js); owner liveness is what `@kontourai/monument` will provide once
 * it is published, and this file is the piece to delete then.
 *
 * @module dream/lock
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { dreamError } from "./util.js";

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readOwner(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * @param {string} file absolute lock path
 * @param {{ now?: () => number, maxAgeMs?: number }} [options]
 *   `maxAgeMs` frees a lock whose owner is alive but older than this (a reused pid).
 * @returns {() => void} release
 */
export function acquireDreamLock(file, { now = Date.now, maxAgeMs = 6 * 60 * 60 * 1000 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = `${process.pid}:${now()}:${Math.random().toString(36).slice(2)}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, started_at: now(), token })}\n`);
      } finally {
        fs.closeSync(fd);
      }
      return () => {
        if (readOwner(file)?.token === token) fs.rmSync(file, { force: true });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = readOwner(file);
      const stale = !owner || !pidAlive(owner.pid) || now() - Number(owner.started_at) > maxAgeMs;
      if (!stale || attempt === 1) throw dreamError("DREAM_LOCKED", "another dream run holds the lock");
      fs.rmSync(file, { force: true });
    }
  }
  throw dreamError("DREAM_LOCKED", "another dream run holds the lock");
}
