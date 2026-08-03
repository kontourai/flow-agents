import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { main as kitMain } from "../../build/src/cli/kit.js";

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("supported install keeps Knowledge Kit schemas self-contained", async () => {
  const dest = tempRoot("flow-kit-knowledge-vendored-");
  const source = path.resolve("kits/knowledge");
  assert.equal(await kitMain(["install", source, "--dest", dest]), 0);

  const installed = path.join(dest, "kits", "local", "repositories", "knowledge");
  const { loadSchemas } = await import(pathToFileURL(path.join(installed, "providers", "lib", "model.js")).href);
  assert.deepEqual(Object.keys(loadSchemas()).sort(), ["edge", "healthReport", "node", "proposal"]);

  const contextCheck = childProcess.spawnSync(process.execPath, ["--test", path.join(installed, "context-check", "context-check.test.js")], {
    cwd: dest,
    encoding: "utf8",
  });
  assert.equal(contextCheck.status, 0, `${contextCheck.stdout}\n${contextCheck.stderr}`);
});
