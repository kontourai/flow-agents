import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveEffectiveFlowDefinition, resolveFlowFilePath } from "../../build/src/lib/flow-resolver.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

test("effective Builder definition materializes uses_flow and Flow-native completion", () => {
  const definition = resolveEffectiveFlowDefinition("builder.build", REPO_ROOT);
  assert.ok(definition);
  assert.equal(definition.version, "1.1");
  assert.ok(definition.steps.every((step) => !("uses_flow" in step)));
  assert.ok(!definition.steps.some((step) => step.id === "done"));
  assert.equal(definition.steps.find((step) => step.id === "learn")?.next, null);
  assert.deepEqual(
    definition.gates["builder.publish-learn:pr-open-gate"].expects[0].bundle_claim.accepted_statuses,
    ["verified", "trusted", "accepted"],
  );
});

test("installed package definitions resolve when a consumer repo has no kits directory", () => {
  const consumer = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-consumer-"));
  const resolved = resolveFlowFilePath("builder", "build", "builder.build", consumer, false);
  assert.ok(resolved);
  assert.equal(fs.realpathSync(resolved), fs.realpathSync(path.join(REPO_ROOT, "kits", "builder", "flows", "build.flow.json")));
  assert.equal(resolveEffectiveFlowDefinition("builder.build", consumer, { allowOverride: false })?.version, "1.1");
});

test("consumer-vendored definitions remain authoritative over package fallback", () => {
  const consumer = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-consumer-vendored-"));
  const vendored = path.join(consumer, "kits", "builder", "flows", "build.flow.json");
  writeJson(vendored, { id: "builder.build", version: "consumer", steps: [{ id: "local", next: null }], gates: {} });
  assert.equal(resolveFlowFilePath("builder", "build", "builder.build", consumer, false), fs.realpathSync(vendored));
});

test("unsafe explicit overrides fail closed instead of using package fallback", () => {
  const consumer = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-consumer-unsafe-"));
  const unsafeDefinitions = path.join(consumer, ".kontourai", "flow-agents", "definitions");
  fs.mkdirSync(unsafeDefinitions, { recursive: true });
  const prior = process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
  process.env.FLOW_AGENTS_FLOW_DEFS_DIR = unsafeDefinitions;
  try {
    assert.equal(resolveFlowFilePath("builder", "build", "builder.build", consumer), null);
  } finally {
    if (prior === undefined) delete process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
    else process.env.FLOW_AGENTS_FLOW_DEFS_DIR = prior;
  }
});

test("effective definition compilation rejects uses_flow cycles", () => {
  const definitions = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-composition-cycle-"));
  writeJson(path.join(definitions, "loop.one.flow.json"), {
    id: "loop.one",
    version: "1.0",
    steps: [{ id: "shared", next: null, uses_flow: "loop.two" }],
    gates: {},
    exports: ["loop.one.claim"],
  });
  writeJson(path.join(definitions, "loop.two.flow.json"), {
    id: "loop.two",
    version: "1.0",
    steps: [{ id: "shared", next: null, uses_flow: "loop.one" }],
    gates: {},
    exports: ["loop.two.claim"],
  });
  const prior = process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
  process.env.FLOW_AGENTS_FLOW_DEFS_DIR = definitions;
  try {
    assert.equal(resolveEffectiveFlowDefinition("loop.one", definitions), null);
  } finally {
    if (prior === undefined) delete process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
    else process.env.FLOW_AGENTS_FLOW_DEFS_DIR = prior;
  }
});

test("canonical compilation ignores Flow definition overrides", () => {
  const definitions = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-composition-override-"));
  writeJson(path.join(definitions, "builder.build.flow.json"), {
    id: "builder.build",
    version: "999.0",
    steps: [{ id: "hostile", next: null }],
    gates: {},
  });
  const prior = process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
  process.env.FLOW_AGENTS_FLOW_DEFS_DIR = definitions;
  try {
    assert.equal(resolveEffectiveFlowDefinition("builder.build", REPO_ROOT)?.version, "999.0");
    assert.equal(resolveEffectiveFlowDefinition("builder.build", REPO_ROOT, { allowOverride: false })?.version, "1.1");
  } finally {
    if (prior === undefined) delete process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
    else process.env.FLOW_AGENTS_FLOW_DEFS_DIR = prior;
  }
});
