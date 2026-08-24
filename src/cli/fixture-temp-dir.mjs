/**
 * fixture-temp-dir — reclaimable fixture temp directories for the node:test units (#1326).
 *
 * Every unit test used to build its fixture root with
 * `fs.mkdtempSync(path.join(os.tmpdir(), "..."))` and almost none removed it, so each corpus
 * run left its whole fixture tree on disk permanently: one `node --test src/cli/*.test.mjs`
 * run leaks 925 directories on origin/main. Accumulated, that exhausted a developer machine's
 * disk (27,446 orphaned directories cleared, 4,871 more / 1.1 GB regrown within a day).
 *
 * Two nets, because a `node:test` `after()` hook only covers the case that was never the
 * problem:
 *
 *  1. `process.on("exit")` reclaims every registered directory on normal completion — which
 *     also covers `process.exit` and an uncaught exception.
 *
 *  2. A per-process journal under `<tmpdir>/.flow-agents-fixture-runs` records each directory
 *     as it is created and is deleted on clean exit. A surviving journal therefore names the
 *     fixtures of a run that DIED — a deadline kill, a host-load kill, a crash — and the next
 *     process to start sweeps it. This is the dominant leak source, and unlike a signal
 *     handler it also reclaims after SIGKILL, which cannot be trapped at all.
 *
 * Deliberately NOT a signal handler. Trapping SIGINT/SIGTERM/SIGHUP in-process is
 * indistinguishable from a synthetic `process.emit("SIGTERM")`, and this corpus contains
 * tests that drive production signal paths that way (see the sealed-transport cancellation
 * test in external-lifecycle-authority.test.mjs, which asserts both the exact sequence of
 * child kills and `process.listenerCount("SIGTERM")`). A trap here reclaims live fixtures
 * mid-test and perturbs those assertions. The journal covers strictly more cases anyway; the
 * only difference is timing — a killed run's directories are reclaimed when the next run
 * starts rather than at the moment of the kill.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const JOURNAL_ROOT = path.join(os.tmpdir(), ".flow-agents-fixture-runs");
// No fixture run lasts a day, so an older journal is orphaned even if its pid has since been
// reused by an unrelated process (which would otherwise read as "still alive" forever).
const STALE_JOURNAL_MS = 24 * 60 * 60 * 1000;
// Bounds the startup cost when a long-neglected temp root holds many journals. Whatever is not
// swept by this process is swept by the next one.
const MAX_SWEEP_PER_PROCESS = 64;

const reclaimable = new Set();
let journalFile;
let installed = false;

function removeQuietly(directory) {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    // Reclaiming a fixture must never turn a green run red, and must never displace the real
    // failure of a red one. A directory that cannot be removed is left on disk instead.
  }
}

function reclaimAll() {
  for (const directory of reclaimable) removeQuietly(directory);
  reclaimable.clear();
  if (journalFile) {
    try {
      fs.rmSync(journalFile, { force: true });
    } catch { /* the next process's sweep will retire it */ }
  }
}

function isRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to another user — alive, and not ours to sweep.
    return error?.code === "EPERM";
  }
}

function drainJournal(file) {
  let contents;
  try {
    contents = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of contents.split("\n")) {
    const directory = line.trim();
    // Only ever reclaim inside the temp root, so a corrupt or truncated journal line can never
    // aim removal at a real path.
    if (!directory || path.dirname(directory) !== os.tmpdir()) continue;
    removeQuietly(directory);
  }
  try {
    fs.rmSync(file, { force: true });
  } catch { /* a later sweep will retire it */ }
}

function sweepDeadRuns() {
  let entries;
  try {
    entries = fs.readdirSync(JOURNAL_ROOT);
  } catch {
    return;
  }
  let swept = 0;
  for (const entry of entries) {
    if (swept >= MAX_SWEEP_PER_PROCESS) return;
    const match = /^(\d+)\.journal$/.exec(entry);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid) continue;
    const file = path.join(JOURNAL_ROOT, entry);
    let age = 0;
    try {
      age = Date.now() - fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (isRunning(pid) && age < STALE_JOURNAL_MS) continue;
    // Claim the journal by renaming it: exactly one sweeper wins, every other concurrent
    // sweeper fails with ENOENT and moves on, so no two processes reclaim the same fixtures.
    const claimed = `${file}.claimed-${process.pid}`;
    try {
      fs.renameSync(file, claimed);
    } catch {
      continue;
    }
    drainJournal(claimed);
    swept += 1;
  }
}

function install() {
  if (installed) return;
  installed = true;
  try {
    fs.mkdirSync(JOURNAL_ROOT, { recursive: true });
    journalFile = path.join(JOURNAL_ROOT, `${process.pid}.journal`);
    // A journal already sitting under our own pid belongs to an earlier run that died; adopt
    // its directories so this process reclaims them too.
    drainJournal(journalFile);
    sweepDeadRuns();
  } catch {
    journalFile = undefined;
  }
  process.on("exit", reclaimAll);
}

function register(directory) {
  reclaimable.add(directory);
  if (!journalFile) return directory;
  try {
    fs.appendFileSync(journalFile, `${directory}\n`);
  } catch {
    // An unwritable journal costs the abnormal-exit net for this run, not the run itself.
  }
  return directory;
}

/**
 * `mkdtemp` a fixture directory under `os.tmpdir()` and register it for reclamation.
 * Drop-in for `fs.mkdtempSync(path.join(os.tmpdir(), prefix))`.
 */
export function makeFixtureDir(prefix) {
  install();
  return register(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/**
 * Async form, for the one fixture that builds its root with `node:fs/promises`.
 */
export async function makeFixtureDirAsync(prefix) {
  install();
  return register(await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix)));
}

/**
 * Register a directory this module did not create — for a fixture whose root comes from a
 * helper we do not own. Removal stays idempotent with any explicit `rmSync` a test already
 * performs, because reclamation is `force: true`.
 */
export function reclaimFixtureDir(directory) {
  install();
  return register(directory);
}
