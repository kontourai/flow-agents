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

// Every leak-reclamation claim is about what survives a process, so the reclaim assertions run
// a real child process and inspect the filesystem afterwards. An in-process assertion could
// only observe the registry, never the removal.
function runChild(source, { signal } = {}) {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const settled = once(child, "exit").then(([code, exitSignal]) => ({ code, exitSignal, stdout, stderr }));
  if (signal) {
    // Wait for the child to report the directory before signalling, so the race is decided by
    // the child's own progress rather than by a sleep.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child never reported a directory: ${stderr}`)), 20000);
      const check = () => {
        if (stdout.includes("\n")) {
          clearTimeout(timer);
          child.kill(signal);
          resolve(settled);
          return;
        }
        setTimeout(check, 10);
      };
      check();
    });
  }
  return settled;
}

test("a fixture directory is created under the temp root and registered under its prefix", () => {
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

test("a registered fixture directory is reclaimed when the process exits normally", async () => {
  const result = await runChild(`
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

test("a registered fixture directory is reclaimed when the run is killed by SIGTERM", async () => {
  // This is the dominant real-world leak source: deadline timeouts and host-load kills, which
  // bypass any node:test after() hook entirely.
  const result = await runChild(`
    import { makeFixtureDir } from ${JSON.stringify(HELPER)};
    import fs from "node:fs";
    import path from "node:path";
    const directory = makeFixtureDir("flow-agents-fixture-temp-dir-sigterm-");
    fs.writeFileSync(path.join(directory, "payload.txt"), "fixture content\\n");
    console.log(directory);
    setInterval(() => {}, 1000);
  `, { signal: "SIGTERM" });
  const directory = result.stdout.trim();
  assert.ok(directory, "the child must report the directory it created");
  assert.equal(result.exitSignal, "SIGTERM", "trapping the signal must not change how the process terminates");
  assert.equal(fs.existsSync(directory), false, `${directory} must not survive a SIGTERM kill`);
});

test("a fixture directory the test already removed itself is reclaimed idempotently", async () => {
  const result = await runChild(`
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
    const result = await runChild(`
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

test("reclaimFixtureDir adopts a directory this module did not create", async () => {
  const result = await runChild(`
    import { reclaimFixtureDir } from ${JSON.stringify(HELPER)};
    import fs from "node:fs";
    import os from "node:os";
    import path from "node:path";
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-fixture-temp-dir-adopted-"));
    reclaimFixtureDir(directory);
    console.log(directory);
  `);
  assert.equal(result.code, 0, `child failed: ${result.stderr}`);
  const directory = result.stdout.trim();
  assert.equal(fs.existsSync(directory), false, `${directory} must be reclaimed after adoption`);
});

test("reclaimFixtureDir returns the directory it adopted", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-fixture-temp-dir-return-"));
  try {
    assert.equal(reclaimFixtureDir(directory), directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
