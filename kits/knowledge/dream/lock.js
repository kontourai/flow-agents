/**
 * Single-writer lock for a dream run (#671).
 *
 * Mutual exclusion only: a hook trigger can fire while a scheduled run is still
 * going, and two runs must not interleave their reads of the cursor and the
 * store. It records no run progress. Crash-safety is the cursor-last design plus
 * Corpus proposals (see run.js); owner liveness is what `@kontourai/monument`
 * will provide once it is published, and this file is the piece to delete then.
 *
 * Protocol, with nothing ever removed from under a live owner:
 *
 *   The lock is a directory `<lock>` holding numbered epoch directories
 *   `<lock>/<n>`. The owner is whoever created the HIGHEST epoch. To acquire,
 *   read the highest epoch N: if it is held by a live process, the lock is held.
 *   If there is none, or it was released, or its process is gone, `mkdir` epoch
 *   N+1. `mkdir` of one name succeeds for exactly one caller, so two callers can
 *   never both take the same epoch. A caller that wins then re-reads the
 *   directory: if a higher epoch exists (it was slow, and others have moved on),
 *   it was never the owner, backs out and reports the lock held. Only the winner
 *   removes older epochs, and it never removes the highest, so the epoch number
 *   only grows and a slow caller can never take an epoch that was already used.
 *
 * An epoch's owner record is written right after its `mkdir`. An epoch with no
 * readable record is held until it is old enough to be debris from a crash. A
 * live pid is never evicted for being old: a long run is alive. Release marks the
 * epoch released; it does not delete it.
 *
 * @module dream/lock
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { dreamError } from "./util.js";

const UNREADABLE_GRACE_MS = 60_000;
const MAX_ATTEMPTS = 8;

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

const readJson = (file) => {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
};

function epochs(lock) {
  try {
    return fs.readdirSync(lock).filter((name) => /^[1-9][0-9]{0,15}$/.test(name)).map(Number).sort((a, b) => a - b);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

/** True when the epoch is held by a live owner, or is too fresh to call debris. */
function epochHeld(lock, epoch, now) {
  const dir = path.join(lock, String(epoch));
  if (fs.existsSync(path.join(dir, "released"))) return false;
  const owner = readJson(path.join(dir, "owner.json"));
  if (owner) return pidAlive(owner.pid);
  try {
    return now() - fs.statSync(dir).mtimeMs <= UNREADABLE_GRACE_MS;
  } catch {
    return false;
  }
}

/**
 * @param {string} lock absolute path of the lock directory
 * @param {{ now?: () => number }} [options]
 * @returns {() => void} release
 */
export function acquireDreamLock(lock, { now = Date.now } = {}) {
  fs.mkdirSync(lock, { recursive: true, mode: 0o700 });
  const token = randomBytes(12).toString("hex");
  const held = () => dreamError("DREAM_LOCKED", "another dream run holds the lock");
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const seen = epochs(lock);
    const top = seen.at(-1) ?? 0;
    if (top > 0 && epochHeld(lock, top, now)) throw held();
    const mine = top + 1;
    const dir = path.join(lock, String(mine));
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
      if (error?.code === "EEXIST") continue; // another caller took this epoch: look again
      throw error;
    }
    fs.writeFileSync(path.join(dir, "owner.json"), `${JSON.stringify({ pid: process.pid, started_at: now(), token })}\n`, { mode: 0o600 });
    // Slow callers may have created lower epochs, and others may have moved past us. Owning means being the highest.
    const after = epochs(lock);
    if (after.at(-1) !== mine) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw held();
    }
    for (const older of after.filter((n) => n < mine)) fs.rmSync(path.join(lock, String(older)), { recursive: true, force: true });
    return () => {
      // Mark, never delete: the highest epoch must stay so that numbers cannot be reused.
      if (readJson(path.join(dir, "owner.json"))?.token !== token) return;
      try {
        fs.writeFileSync(path.join(dir, "released"), "\n", { mode: 0o600 });
      } catch {
        // An unreleased epoch names this process, so it goes stale the moment the process exits.
      }
    };
  }
  throw held();
}
