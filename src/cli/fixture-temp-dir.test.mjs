import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { makeFixtureDir, makeFixtureDirAsync, reclaimFixtureDir } from "./fixture-temp-dir.mjs";

const HELPER = fileURLToPath(new URL("./fixture-temp-dir.mjs", import.meta.url));
const JOURNAL_ROOT = path.join(os.tmpdir(), ".flow-agents-fixture-runs");

// Every reclamation claim is about what survives a process, so the assertions drive real child
// processes and inspect the filesystem afterwards. An in-process assertion could only observe
// the registry, never the removal.
function child(source) {
  const spawned = spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: ["ignore", "pipe", "pipe"] });
  const state = { stdout: "", stderr: "", process: spawned };
  spawned.stdout.on("data", (chunk) => { state.stdout += chunk; });
  spawned.stderr.on("data", (chunk) => { state.stderr += chunk; });
  state.exited = once(spawned, "exit").then(([code, signal]) => ({ code, signal }));
  state.firstLine = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`child never reported a line: ${state.stderr}`)), 20000);
    const poll = () => {
      const newline = state.stdout.indexOf("\n");
      if (newline === -1) { setTimeout(poll, 10); return; }
      clearTimeout(deadline);
      resolve(state.stdout.slice(0, newline).trim());
    };
    poll();
  });
  return state;
}

async function run(source) {
  const spawned = child(source);
  const { code, signal } = await spawned.exited;
  return { code, signal, stdout: spawned.stdout, stderr: spawned.stderr };
}

// A child that creates one fixture directory, reports it, and then never exits on its own.
const holdOpen = (prefix) => `
  import { makeFixtureDir } from ${JSON.stringify(HELPER)};
  import fs from "node:fs";
  import path from "node:path";
  const directory = makeFixtureDir(${JSON.stringify(prefix)});
  fs.writeFileSync(path.join(directory, "payload.txt"), "fixture content\\n");
  console.log(directory);
  setInterval(() => {}, 1000);
`;

// A child that does nothing but start the helper, which is what triggers the dead-run sweep.
const sweepOnly = `
  import { makeFixtureDir } from ${JSON.stringify(HELPER)};
  console.log(makeFixtureDir("flow-agents-fixture-temp-dir-sweeper-"));
`;

async function killedChildDirectory(prefix, signal) {
  const spawned = child(holdOpen(prefix));
  const directory = await spawned.firstLine;
  spawned.process.kill(signal);
  const exit = await spawned.exited;
  assert.equal(exit.signal, signal, `the child must actually die from ${signal}`);
  return directory;
}

test("a fixture directory is created under the temp root under its requested prefix", () => {
  const directory = makeFixtureDir("flow-agents-fixture-temp-dir-unit-");
  try {
    assert.equal(fs.existsSync(directory), true);
    assert.equal(fs.realpathSync(path.dirname(directory)), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(directory), /^flow-agents-fixture-temp-dir-unit-/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the async form creates and registers a directory the same way", async () => {
  const directory = await makeFixtureDirAsync("flow-agents-fixture-temp-dir-async-");
  try {
    assert.equal(fs.existsSync(directory), true);
    assert.match(path.basename(directory), /^flow-agents-fixture-temp-dir-async-/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("reclaimFixtureDir returns the directory it adopted", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-fixture-temp-dir-return-"));
  try {
    assert.equal(reclaimFixtureDir(directory), directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a registered fixture directory is reclaimed when the process exits normally", async () => {
  const result = await run(`
    import { makeFixtureDir } from ${JSON.stringify(HELPER)};
    import fs from "node:fs";
    import path from "node:path";
    const directory = makeFixtureDir("flow-agents-fixture-temp-dir-exit-");
    fs.mkdirSync(path.join(directory, "nested"), { recursive: true });
    fs.writeFileSync(path.join(directory, "nested", "payload.txt"), "fixture content\\n");
    console.log(directory);
  `);
  assert.equal(result.code, 0, `child failed: ${result.stderr}`);
  const directory = result.stdout.trim();
  assert.ok(directory, "the child must report the directory it created");
  assert.equal(fs.existsSync(directory), false, `${directory} must not survive normal completion`);
});

test("a fixture directory registered by an uncaught exception path is still reclaimed", async () => {
  const result = await run(`
    import { makeFixtureDir } from ${JSON.stringify(HELPER)};
    console.log(makeFixtureDir("flow-agents-fixture-temp-dir-throw-"));
    throw new Error("fixture run failed");
  `);
  assert.equal(result.code, 1, "an uncaught exception still fails the run");
  const directory = result.stdout.trim();
  assert.equal(fs.existsSync(directory), false, `${directory} must not survive a crashing run`);
});

test("a clean run leaves no journal behind", async () => {
  const result = await run(`
    import { makeFixtureDir } from ${JSON.stringify(HELPER)};
    console.log(process.pid);
    makeFixtureDir("flow-agents-fixture-temp-dir-journal-");
  `);
  assert.equal(result.code, 0, `child failed: ${result.stderr}`);
  assert.equal(fs.existsSync(path.join(JOURNAL_ROOT, `${result.stdout.trim()}.journal`)), false);
});

for (const signal of ["SIGTERM", "SIGKILL"]) {
  test(`fixtures orphaned by a ${signal} kill are reclaimed by the next run's sweep`, async () => {
    // This is the dominant real-world leak source: deadline kills and host-load kills. SIGKILL
    // cannot be trapped in-process at all, so reclamation is deliberately deferred to the next
    // run's startup sweep rather than attempted from a signal handler.
    const directory = await killedChildDirectory(`flow-agents-fixture-temp-dir-${signal.toLowerCase()}-`, signal);
    assert.equal(fs.existsSync(directory), true, "a killed run cannot reclaim its own fixtures");

    const sweeper = await run(sweepOnly);
    assert.equal(sweeper.code, 0, `sweeper failed: ${sweeper.stderr}`);
    assert.equal(fs.existsSync(directory), false, `${directory} must be reclaimed by the next run`);
  });
}

test("the sweep leaves a live run's fixtures alone", async () => {
  const live = child(holdOpen("flow-agents-fixture-temp-dir-live-"));
  const directory = await live.firstLine;
  try {
    const sweeper = await run(sweepOnly);
    assert.equal(sweeper.code, 0, `sweeper failed: ${sweeper.stderr}`);
    assert.equal(fs.existsSync(directory), true, "a running process's fixtures must never be swept");
  } finally {
    live.process.kill("SIGKILL");
    await live.exited;
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(path.join(JOURNAL_ROOT, `${live.process.pid}.journal`), { force: true });
  }
});

test("a journal line pointing outside the temp root is refused", async () => {
  const outside = makeFixtureDir("flow-agents-fixture-temp-dir-outside-");
  const guarded = path.join(outside, "nested", "must-survive");
  fs.mkdirSync(guarded, { recursive: true });
  const forged = path.join(JOURNAL_ROOT, "999999999.journal");
  try {
    fs.mkdirSync(JOURNAL_ROOT, { recursive: true });
    fs.writeFileSync(forged, `${guarded}\n`);
    const sweeper = await run(sweepOnly);
    assert.equal(sweeper.code, 0, `sweeper failed: ${sweeper.stderr}`);
    // Assert the sweep actually reached the forged journal, so a budget-exhausted sweep cannot
    // let the guard assertion below pass vacuously.
    assert.equal(fs.existsSync(forged), false, "the forged dead-run journal must have been swept");
    assert.equal(fs.existsSync(guarded), true, "reclamation is confined to direct children of the temp root");
  } finally {
    fs.rmSync(forged, { force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("a fixture directory the test already removed itself is reclaimed idempotently", async () => {
  const result = await run(`
    import { makeFixtureDir } from ${JSON.stringify(HELPER)};
    import fs from "node:fs";
    const directory = makeFixtureDir("flow-agents-fixture-temp-dir-double-");
    fs.rmSync(directory, { recursive: true, force: true });
    console.log(directory);
  `);
  assert.equal(result.code, 0, "reclaiming an already-removed fixture must not fail the run");
  assert.equal(result.stderr.trim(), "", `reclamation must stay silent, got: ${result.stderr}`);
});

test("an unremovable fixture directory is left on disk rather than failing the run", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("directory permissions do not deny removal for this user");
    return;
  }
  const outer = makeFixtureDir("flow-agents-fixture-temp-dir-unremovable-");
  const locked = path.join(outer, "locked");
  const trapped = path.join(locked, "fixture");
  fs.mkdirSync(trapped, { recursive: true });
  // Removing `trapped` needs write permission on `locked`. Denying it makes the exit-time
  // rmSync throw EACCES — a cleanup failure must never turn a green run red.
  fs.chmodSync(locked, 0o500);
  try {
    const result = await run(`
      import { reclaimFixtureDir } from ${JSON.stringify(HELPER)};
      reclaimFixtureDir(${JSON.stringify(trapped)});
      console.log("registered");
    `);
    assert.equal(result.code, 0, `a cleanup failure must not change the exit status: ${result.stderr}`);
    assert.equal(result.stderr.trim(), "", `a cleanup failure must stay silent, got: ${result.stderr}`);
    assert.equal(fs.existsSync(trapped), true, "the directory that could not be removed is left on disk");
  } finally {
    fs.chmodSync(locked, 0o700);
    fs.rmSync(outer, { recursive: true, force: true });
  }
});
