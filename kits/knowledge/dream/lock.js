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
 *   `<lock>/<n>`. The owner is whoever made the HIGHEST epoch.
 *
 *   An epoch appears whole: its owner record is written into a private
 *   directory, which is then `rename`d to `<lock>/<n>`. A rename onto an existing
 *   non-empty directory fails, so of any number of callers only one can create
 *   epoch `n`, and nobody can ever see an epoch without its owner. (There is no
 *   "being made" state to mistake for debris, however long a caller pauses.)
 *
 *   To acquire, read the highest epoch N. If its owner process is alive, the lock
 *   is held. If there is none, or it was released, or its owner is gone, make
 *   epoch N+1, then re-read: if a higher epoch exists the caller was passed by
 *   others, so it removes only its own epoch and reports the lock held. Only the
 *   winner removes older epochs (best effort), and the highest epoch is never
 *   removed, so the number only grows and a slow caller can never take one that
 *   was already used.
 *
 *   A live pid is never evicted for being old: a long run is alive. Release marks
 *   the epoch released; it does not delete it. A pid that was reused by an
 *   unrelated process keeps the lock until that process exits.
 *
 * @module dream/lock
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { dreamError } from "./util.js";

const MAX_ATTEMPTS = 8;
// Fifteen digits stay exact as a number (below 2^53), so epochs compare and increment without rounding.
const EPOCH = /^[1-9][0-9]{0,14}$/;
const TAKEN = new Set(["EEXIST", "ENOTEMPTY"]);

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
    return fs.readdirSync(lock).filter((name) => EPOCH.test(name)).map(Number).sort((a, b) => a - b);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

/** Held means a live owner. An epoch with no readable owner cannot be made by this protocol, so it is corrupt, not live. */
function epochHeld(lock, epoch) {
  const dir = path.join(lock, String(epoch));
  if (fs.existsSync(path.join(dir, "released"))) return false;
  const owner = readJson(path.join(dir, "owner.json"));
  return owner ? pidAlive(owner.pid) : false;
}

/**
 * @param {string} lock absolute path of the lock directory
 * @param {{ now?: () => number, pid?: number, lockedCode?: string, holder?: string }} [options]
 *   `pid` is the process the epoch names as owner (default this one): a short-lived helper can take the lock on behalf
 *   of the shell script that started it, and the lock goes stale when that script exits.
 * @returns {(() => void) & { epoch: number, token: string }} release (never throws), carrying the epoch and token so
 *   another process can release it with `releaseLockEpoch`.
 */
export function acquireDreamLock(lock, { now = Date.now, pid = process.pid, lockedCode = "DREAM_LOCKED", holder = "another dream run" } = {}) {
  fs.mkdirSync(lock, { recursive: true, mode: 0o700 });
  const token = randomBytes(12).toString("hex");
  const held = () => dreamError(lockedCode, `${holder} holds the lock (${lock})`);
  const started = now();
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const top = epochs(lock).at(-1) ?? 0;
    if (top > 0 && epochHeld(lock, top)) throw held();
    if (top >= Number.MAX_SAFE_INTEGER / 10) throw dreamError("DREAM_LOCK_EXHAUSTED", "the lock's epoch counter is exhausted; remove the lock directory");
    const mine = top + 1;
    const dir = path.join(lock, String(mine));
    const staging = path.join(lock, `.stage-${token}-${attempt}`);
    fs.mkdirSync(staging, { mode: 0o700 });
    try {
      fs.writeFileSync(path.join(staging, "owner.json"), `${JSON.stringify({ pid, started_at: started, token })}\n`, { mode: 0o600 });
      fs.renameSync(staging, dir); // atomic, and fails if the epoch exists
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      if (TAKEN.has(error?.code)) continue; // another caller made this epoch: look again
      throw error;
    }
    // Others may have moved past us while we were slow. Owning means being the highest.
    const after = epochs(lock);
    if (after.at(-1) !== mine) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw held();
    }
    for (const older of after.filter((n) => n < mine)) {
      try {
        fs.rmSync(path.join(lock, String(older)), { recursive: true, force: true });
      } catch {
        // Old epochs are housekeeping. Failing to remove one never costs us the lock we already hold.
      }
    }
    return Object.assign(() => releaseLockEpoch(lock, mine, token), { epoch: mine, token });
  }
  throw held();
}

/** Release epoch `epoch` of `lock` if `token` still owns it. Never throws. */
export function releaseLockEpoch(lock, epoch, token) {
  if (!EPOCH.test(String(epoch))) return;
  const dir = path.join(lock, String(epoch));
  // Mark, never delete: the highest epoch must stay so that numbers cannot be reused.
  if (readJson(path.join(dir, "owner.json"))?.token !== token) return;
  try {
    fs.writeFileSync(path.join(dir, "released"), "\n", { mode: 0o600 });
  } catch {
    // An unreleased epoch names its owner pid, so it goes stale the moment that process exits.
  }
}
