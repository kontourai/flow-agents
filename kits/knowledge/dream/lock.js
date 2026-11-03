/**
 * Single-writer lock for a dream run (#671).
 *
 * Mutual exclusion only: a hook trigger can fire while a scheduled run is still
 * going, and two runs must not interleave their reads of the cursor and the
 * store. It records no run progress. Crash-safety is the cursor-last design plus
 * Corpus proposals (see run.js); owner liveness is what `@kontourai/monument`
 * will provide once it is published, and this file is the piece to delete then.
 *
 * Installing: the lock file appears whole or not at all. Its owner record is
 * written to a private temp file and hard-linked into place, which fails if the
 * lock exists, so a reader never sees a half-written lock.
 *
 * Staleness: an owner is stale only when its process is gone. Age alone proves
 * nothing (a long run is alive), so a live pid is never evicted. A lock that
 * cannot be read is held until it is old enough to be debris from a crash.
 *
 * Taking over a stale lock is the one step that removes a file another process
 * may be about to replace, so it is serialized: a takeover holds a second
 * exclusive file (`<lock>.takeover`), re-reads the lock while holding it, and
 * removes it only if it is still the exact stale owner judged earlier. With one
 * remover at a time, the lock file is only ever absent because its stale owner
 * was just removed, and installing it is the same exclusive link. A process that
 * loses any of these races gives way and reports the lock held.
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

const sameOwner = (a, b) => (a?.token ?? null) === (b?.token ?? null);

/** Hold the takeover guard, or return null if another process has it. */
function takeGuard(guard, now) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(guard, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, started_at: now() })}\n`);
      } finally {
        fs.closeSync(fd);
      }
      return () => fs.rmSync(guard, { force: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      // A guard left by a crashed takeover must not wedge the lock forever.
      if (!isStale(guard, readOwner(guard), now)) return null;
      fs.rmSync(guard, { force: true });
    }
  }
  return null;
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
  const held = () => dreamError("DREAM_LOCKED", "another dream run holds the lock");
  fs.writeFileSync(temp, `${JSON.stringify({ pid: process.pid, started_at: now(), token })}\n`, { flag: "wx", mode: 0o600 });
  const install = () => {
    try {
      fs.linkSync(temp, file); // atomic, and fails if the lock exists
      return true;
    } catch (error) {
      if (error?.code === "EEXIST") return false;
      throw error;
    }
  };
  try {
    if (install()) return release(file, token);

    const judged = readOwner(file);
    if (!isStale(file, judged, now)) throw held();
    const unguard = takeGuard(`${file}.takeover`, now);
    if (!unguard) throw held();
    try {
      // Re-judge while holding the guard: the lock may have changed hands since the first look.
      const current = readOwner(file);
      if (!sameOwner(current, judged) || !isStale(file, current, now)) throw held();
      fs.rmSync(file, { force: true });
      if (!install()) throw held(); // a fresh acquirer won the vacancy; it is the owner
      return release(file, token);
    } finally {
      unguard();
    }
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function release(file, token) {
  return () => {
    if (readOwner(file)?.token === token) fs.rmSync(file, { force: true });
  };
}
