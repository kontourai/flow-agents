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
  "living-context-input.schema.json",
  "living-context-result.schema.json",
  "memory-claim.schema.json",
  "memory-routing-decision.schema.json",
  "memory-run-metrics.schema.json",
  "node.schema.json",
  "proposal.schema.json",
  "residue.schema.json",
];

test("Knowledge adapters retain package self-resolution and bundles ship an ESM marker boundary", async () => {
  for (const adapter of ["memory-claims", "learning-lifecycle"]) {
    await import(pathToFileURL(path.resolve("kits/knowledge/adapters", adapter, "index.mjs")).href);
  }
  for (const runtime of ["claude-code", "codex"]) {
    const bundle = path.resolve("dist", runtime);
    const dest = tempRoot("flow-marker-bundle-");
    for (const dir of ["scripts/hooks", "scripts/lib", "kits/knowledge"]) {
      fs.mkdirSync(path.dirname(path.join(dest, dir)), { recursive: true });
      fs.cpSync(path.join(bundle, dir), path.join(dest, dir), { recursive: true });
    }
    fs.copyFileSync(path.join(bundle, "scripts/package.json"), path.join(dest, "scripts/package.json"));
    const file = path.join(dest, "kits/knowledge/package.json");
    const probe = childProcess.spawnSync(process.execPath, ["--no-experimental-detect-module", "--input-type=module", "-e", `const m=await import(${JSON.stringify(pathToFileURL(path.join(dest, "kits/knowledge/memory-marker.js")).href)}); if (!m.INJECTED_MEMORY_OPEN) process.exit(1);`], { encoding: "utf8" });
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).type, "module");
  }
});

test("compiled brief fixture contains only presented claim text", async () => {
  const { memoryClaim } = await import("../../build/src/memory-claims.js");
  const { presentMemoryClaims } = await import("../../build/src/memory-routing.js");
  const template = JSON.parse(fs.readFileSync("src/cli/fixtures/memory-claims/claims-sitting-0.json", "utf8")).claims[0];
  const { id, schema_version, ...base } = template;
  const claims = [
    memoryClaim({ ...base, subject: { id: "violet kestrel", label: "violet kestrel", type: "fixture" }, property: "preferred path", value: "bounded river path" }),
    memoryClaim({ ...base, subject: { id: "implementation", label: "implementation", type: "fixture" }, property: "verification", value: "check local code before trusting memory" }),
  ];
  const { presented, withheld } = presentMemoryClaims(claims);
  assert.deepEqual(withheld, []);
  const brief = JSON.parse(fs.readFileSync("evals/fixtures/context-contributors/global.json", "utf8"));
  assert.deepEqual(brief, { version: 1, entries: presented.map(claim => claim.text) });
});

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
