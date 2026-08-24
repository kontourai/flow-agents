/**
 * fixture-temp-dir — reclaimable fixture temp directories for the node:test units (#1326).
 *
 * Every unit test used to call `fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-..."))`
 * directly and almost none removed the result, so a corpus run left its fixture trees behind
 * permanently: 27,446 orphaned directories were measured on one developer machine before the
 * disk filled, with another 4,871 (1.1 GB) accumulating over the following day.
 *
 * A `node:test` `after()` hook would only reclaim on NORMAL completion, and the dominant leak
 * source is the opposite case — runs killed by a deadline or by host load. So reclamation is
 * registered on process `"exit"` (which covers normal exit, `process.exit`, and uncaught
 * exceptions) AND on the terminating signals, which bypass `"exit"` entirely.
 *
 * Documented limit: SIGKILL cannot be trapped, so directories from a `kill -9` run remain
 * orphaned. Nothing in-process can close that gap.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const reclaimable = new Set();
let installed = false;

function removeQuietly(directory) {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    // Reclaiming a fixture must never turn a green test red, and must never displace the real
    // failure of a red one. A directory that cannot be removed is left on disk instead.
  }
}

function reclaimAll() {
  for (const directory of reclaimable) removeQuietly(directory);
  reclaimable.clear();
}

function installReclaimHooks() {
  if (installed) return;
  installed = true;
  process.on("exit", reclaimAll);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    // `once`: after reclaiming, re-raising the signal with no listener left restores Node's
    // default terminating behaviour, so trapping never changes the run's exit status.
    process.once(signal, () => {
      reclaimAll();
      process.kill(process.pid, signal);
    });
  }
}

/**
 * `mkdtemp` a fixture directory under `os.tmpdir()` and register it for reclamation.
 * Drop-in for `fs.mkdtempSync(path.join(os.tmpdir(), prefix))`.
 */
export function makeFixtureDir(prefix) {
  installReclaimHooks();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  reclaimable.add(directory);
  return directory;
}

/**
 * Async form, for the one fixture that builds its root with `node:fs/promises`.
 */
export async function makeFixtureDirAsync(prefix) {
  installReclaimHooks();
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  reclaimable.add(directory);
  return directory;
}

/**
 * Register a directory this module did not create — for a fixture whose root is produced by a
 * helper we do not own. Removal stays idempotent with any explicit `rmSync` the test already
 * performs, because reclamation is `force: true`.
 */
export function reclaimFixtureDir(directory) {
  installReclaimHooks();
  reclaimable.add(directory);
  return directory;
}
