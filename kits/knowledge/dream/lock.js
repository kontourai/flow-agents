/**
 * Single-writer lock for a dream run (#671).
 *
 * Mutual exclusion only: a hook trigger can fire while a scheduled run is still
 * going, and two runs must not interleave their reads of the cursor and the
 * store. It records no run progress. Crash-safety is the cursor-last design plus
 * Corpus proposals (see run.js); owner liveness is what `@kontourai/monument`
 * will provide once it is published, and this file is the piece to delete then.
 *
 * The lock file appears whole or not at all: its owner record is written to a
 * private temp file and hard-linked into place, which fails if the lock exists.
 * A reader therefore never sees a half-written lock. An owner is stale only when
 * its process is gone. Age alone proves nothing (a long run is alive), so a live
 * pid is never evicted. A lock that cannot be read is held until it is old
 * enough to be debris from a crash.
 *
 * @module dream/lock
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { dreamError } from "./util.js";

const UNREADABLE_GRACE_MS = 60_000;

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
    const owner = JSON.parse(fs.readFileSync(file, "utf8"));
    return owner && typeof owner === "object" ? owner : null;
  } catch {
    return null;
  }
}

function isStale(file, owner, now) {
  if (owner) return !pidAlive(owner.pid);
  try {
    return now() - fs.statSync(file).mtimeMs > UNREADABLE_GRACE_MS;
  } catch {
    return false; // gone already: the next attempt will find it free
  }
}

/**
 * @param {string} file absolute lock path
 * @param {{ now?: () => number }} [options]
 * @returns {() => void} release
 */
export function acquireDreamLock(file, { now = Date.now } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = randomBytes(12).toString("hex");
  const temp = `${file}.${process.pid}.${token}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ pid: process.pid, started_at: now(), token })}\n`, { flag: "wx", mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        fs.linkSync(temp, file); // atomic, and fails if the lock exists
        return () => {
          if (readOwner(file)?.token === token) fs.rmSync(file, { force: true });
        };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      const owner = readOwner(file);
      if (!isStale(file, owner, now)) throw dreamError("DREAM_LOCKED", "another dream run holds the lock");
      // Take a stale lock by renaming it away, then check what we took. A rename cannot tell whether the file is
      // still the one we judged stale, so if it is someone else's fresh lock, put it back and give way.
      const aside = `${file}.stale.${token}`;
      try {
        fs.renameSync(file, aside);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      const taken = readOwner(aside);
      if ((taken?.token ?? null) !== (owner?.token ?? null)) {
        try {
          fs.linkSync(aside, file);
        } catch {
          // Someone else already took the free lock; either way we give way.
        }
        fs.rmSync(aside, { force: true });
        throw dreamError("DREAM_LOCKED", "another dream run holds the lock");
      }
      fs.rmSync(aside, { force: true });
    }
    throw dreamError("DREAM_LOCKED", "another dream run holds the lock");
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
