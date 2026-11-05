/**
 * The purge gate: how a compiled brief stops serving erased content (#671).
 *
 * A brief is a copy of store content that outlives the store transaction that
 * erased it. Corpus's purge cannot reach it (Addendum M of the store contract
 * says the host must rebuild or invalidate every content-bearing projection
 * before it serves again). This module is that obligation for briefs.
 *
 * One small file, `<dreamDir>/purge-gate.json`, holds `{version, generation,
 * state}`. `generation` is an opaque token and `state` is `settled` or `purging`.
 * A brief records the generation it was compiled under (`purgeGeneration`), and
 * the session-start reader serves a brief only when the gate is `settled` and
 * the two tokens are equal. So:
 *
 *   - a brief compiled before a purge carries an old token and is refused, no
 *     matter whether anything managed to delete the file;
 *   - a dream run that read the store before the purge committed, and writes its
 *     brief after, carries the old token too;
 *   - a purge that dies midway leaves `purging`, which refuses every brief until
 *     the purge is run again. Failing closed loses memory until then; it never serves erased text.
 *
 * The fence runs: open the gate (write `purging` with a new token, durably,
 * BEFORE the store is touched), run the purge, then in a `finally` settle it with
 * another new token and delete the brief files. Opening first is what makes a
 * crash safe; settling with a new token is what makes a racing writer safe.
 *
 * No daemon and no store of its own: the gate rides the purge call. Mutual
 * exclusion between two fences is the dream lock protocol (`dream/lock.js`).
 *
 * @module dream/purge-gate
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { acquireDreamLock } from "./lock.js";
import { dreamError, writePrivateAtomic } from "./util.js";

export const PURGE_GATE_VERSION = 1;
export const PURGE_GATE_FILE = "purge-gate.json";
const MAX_GATE_BYTES = 1024;
const TOKEN = /^[0-9a-f]{32}$/;
// What a platform answers when a directory cannot be opened or synced (Windows, some network filesystems).
const DIRECTORY_SYNC_UNSUPPORTED = new Set(["EINVAL", "ENOTSUP", "EPERM", "EISDIR", "EACCES", "ENOSYS"]);
const BRIEF_FILE = /^(?:global|project-[a-z0-9_-]{1,64})\.json$/;

export const purgeGatePath = (dreamDir) => path.join(dreamDir, PURGE_GATE_FILE);
const newToken = () => randomBytes(16).toString("hex");

/**
 * The gate as the writers see it. No file means no purge has ever fenced this
 * directory: `{ generation: null, state: "settled" }`. A file that cannot be read
 * as a gate is `{ generation: null, state: "unreadable" }`, which no brief
 * matches.
 *
 * @returns {{ generation: string|null, state: "settled"|"purging"|"unreadable" }}
 */
export function readPurgeGate(dreamDir) {
  const file = purgeGatePath(dreamDir);
  let text;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_GATE_BYTES) return { generation: null, state: "unreadable" };
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return error?.code === "ENOENT" ? { generation: null, state: "settled" } : { generation: null, state: "unreadable" };
  }
  try {
    const gate = JSON.parse(text);
    if (gate?.version === PURGE_GATE_VERSION && typeof gate.generation === "string" && TOKEN.test(gate.generation) && (gate.state === "settled" || gate.state === "purging")) {
      return { generation: gate.generation, state: gate.state };
    }
  } catch {
    // fall through: not a gate
  }
  return { generation: null, state: "unreadable" };
}

/** True when a dream run may write briefs: the gate is settled. */
export const gateAllowsBrief = (gate) => gate.state === "settled";
/** True when two readings of the gate are identical. */
export const sameGate = (a, b) => a.generation === b.generation && a.state === b.state;

function writeGate(dreamDir, state) {
  const generation = newToken();
  writePrivateAtomic(purgeGatePath(dreamDir), `${JSON.stringify({ version: PURGE_GATE_VERSION, generation, state })}\n`);
  // The rename is only durable once the directory entry is. A platform that cannot open or sync a directory is
  // skipped; a real I/O error is not, because the gate must be durable before the store is touched.
  try {
    const fd = fs.openSync(dreamDir, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (!DIRECTORY_SYNC_UNSUPPORTED.has(error?.code)) throw error;
  }
  return generation;
}

/** Delete every brief file. Returns what was removed and what could not be. Never throws. */
export function scrubBriefs(dreamDir) {
  const briefsDir = path.join(dreamDir, "briefs");
  const removed = [];
  const failed = [];
  let names = [];
  try {
    names = fs.readdirSync(briefsDir).filter((name) => BRIEF_FILE.test(name)).sort();
  } catch (error) {
    if (error?.code !== "ENOENT") failed.push({ name: "briefs", code: error?.code ?? "UNKNOWN" });
  }
  for (const name of names) {
    try {
      fs.rmSync(path.join(briefsDir, name), { force: true });
      removed.push(name);
    } catch (error) {
      failed.push({ name, code: error?.code ?? "UNKNOWN" });
    }
  }
  return { removed, failed };
}

/**
 * A fence to hand a store as its `purgeFence`: `fence(run)` runs the purge `run`
 * inside the gate and resolves to its result. If the gate cannot be opened,
 * `run` is not called.
 *
 * @param {{ dreamDir: string, onScrub?: (report: { removed: string[], failed: {name:string,code:string}[] }) => void }} options
 *   `onScrub` hears what was deleted and what could not be; a failed delete never fails the purge,
 *   because the gate already keeps the stale brief from being served.
 * @returns {<T>(run: () => Promise<T>) => Promise<T>}
 */
export function createPurgeFence({ dreamDir, onScrub } = {}) {
  if (typeof dreamDir !== "string" || !path.isAbsolute(dreamDir)) throw dreamError("DREAM_CONFIG_INVALID", "a purge fence needs an absolute dreamDir");
  return async function fence(run) {
    fs.mkdirSync(dreamDir, { recursive: true, mode: 0o700 });
    let release;
    try {
      release = acquireDreamLock(path.join(dreamDir, "purge-gate.lock"));
    } catch (error) {
      if (error?.code === "DREAM_LOCKED") throw dreamError("PURGE_GATE_BUSY", "another purge holds the brief gate; purge one request at a time");
      throw error;
    }
    try {
      writeGate(dreamDir, "purging"); // before the store is touched; a throw here stops the purge
      let result;
      let failure;
      try {
        result = await run();
      } catch (error) {
        failure = { error };
      }
      // Settled whether the purge returned or threw: a throw does not say whether it committed, and the new token
      // refuses every brief compiled before it either way. Only a process death leaves the gate open.
      try {
        writeGate(dreamDir, "settled");
      } catch (settleError) {
        if (failure) {
          failure.error.gateSettleError = settleError;
          throw failure.error;
        }
        throw dreamError("PURGE_GATE_NOT_SETTLED", "the purge committed but its brief gate could not be settled; briefs stay refused until a purge runs again", { cause: settleError, purgeResult: result });
      }
      const scrubbed = scrubBriefs(dreamDir);
      try {
        onScrub?.(scrubbed);
      } catch {
        // an observer's failure is not the purge's
      }
      if (failure) throw failure.error;
      return result;
    } finally {
      release();
    }
  };
}
