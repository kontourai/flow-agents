import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { main as kitMain } from "../../build/src/cli/kit.js";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

const KNOWLEDGE_SCHEMA_FILES = [
  "context-check-input.schema.json",
  "context-check-result.schema.json",
  "edge.schema.json",
  "health-report.schema.json",
  "node.schema.json",
  "proposal.schema.json",
];

test("Knowledge Kit ships exact copies of its canonical root schemas", () => {
  for (const name of KNOWLEDGE_SCHEMA_FILES) {
    assert.equal(
      fs.readFileSync(path.join("kits", "knowledge", "schemas", "knowledge", name), "utf8"),
      fs.readFileSync(path.join("schemas", "knowledge", name), "utf8"),
      `vendored Knowledge Kit schema drifted from schemas/knowledge/${name}`,
    );
  }
});

function tempRoot(prefix) {
  return makeFixtureDir(prefix);
}

test("supported install keeps Knowledge Kit schemas self-contained and every declared eval runnable", async () => {
  const dest = tempRoot("flow-kit-knowledge-vendored-");
  const source = path.resolve("kits/knowledge");
  assert.equal(await kitMain(["install", source, "--dest", dest]), 0);

  const installed = path.join(dest, "kits", "local", "repositories", "knowledge");
  const { loadSchemas } = await import(pathToFileURL(path.join(installed, "providers", "lib", "model.js")).href);
  assert.deepEqual(Object.keys(loadSchemas()).sort(), ["edge", "healthReport", "node", "proposal"]);

  const manifest = JSON.parse(fs.readFileSync(path.join(installed, "kit.json"), "utf8"));
  const declaredEvalPaths = manifest.evals.map((entry) => path.join(installed, entry.path));
  const declaredEvals = childProcess.spawnSync(process.execPath, ["--test", ...declaredEvalPaths], {
    cwd: dest,
    encoding: "utf8",
  });
  assert.equal(declaredEvals.status, 0, `${declaredEvals.stdout}\n${declaredEvals.stderr}`);
});
