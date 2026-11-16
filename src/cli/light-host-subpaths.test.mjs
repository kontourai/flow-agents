// Small package entries for hosts that need a few bindings without the root barrel, which loads
// cli/workflow-sidecar and with it @kontourai/flow, the flow resolver and the builder runtime.
// Each import runs in a fresh child Node process with a module load hook, so the loaded set is
// exactly what that one subpath pulls in, not what this test file already imported.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import * as vocabulary from "@kontourai/flow-agents/workflow-sidecar-vocabulary";
import * as sidecar from "../../build/src/cli/workflow-sidecar.js";
import * as root from "../../build/src/index.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const repoUrl = pathToFileURL(`${repoRoot}/`).href;

const probe = `
import { registerHooks } from "node:module";
if (typeof registerHooks !== "function") throw new Error("module.registerHooks is unavailable; cannot observe loaded modules");
const loaded = [];
registerHooks({ load(url, context, next) { loaded.push(url); return next(url, context); } });
const mod = await import(process.argv[1]);
process.stdout.write(JSON.stringify({ loaded, exports: Object.keys(mod) }));
`;

function importInChild(specifier) {
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", probe, specifier], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(run.status, 0, `${specifier}: ${run.stderr}`);
  const result = JSON.parse(run.stdout);
  return { ...result, own: result.loaded.filter((url) => url.startsWith(repoUrl)).map((url) => url.slice(repoUrl.length)) };
}

const heavy = ["build/src/index.js", "build/src/cli/workflow-sidecar.js", "build/src/builder-flow-runtime.js", "build/src/lib/flow-resolver.js", "build/src/cli/assignment-provider.js"];

// The entries a host imports at startup: no dependency package at all, and none of the heavy modules.
const light = [
  ["local-artifact-root", "build/src/lib/local-artifact-root.js", ["flowAgentsArtifactRoot", "KONTOURAI_DIR"]],
  ["run-correlation", "build/src/run-correlation.js", ["readRunCorrelation", "validateRunCorrelationEnvelope", "validateRunCorrelationPresence"]],
  ["host-workflow-binding", "build/src/lib/host-workflow-binding.js", ["bindHostWorkflowSession"]],
  ["workflow-sidecar-vocabulary", "build/src/lib/workflow-sidecar-vocabulary.js", ["phases", "statuses", "writeJson"]],
  ["narrative-retained-reader", "build/src/narrative/retained-reader.js", ["readGroundedNarrative"]],
];

for (const [subpath, file, names] of light) {
  test(`@kontourai/flow-agents/${subpath} loads its own module without the sidecar graph or any dependency package`, () => {
    const { loaded, own, exports } = importInChild(`@kontourai/flow-agents/${subpath}`);
    assert.ok(own.includes(file), `${subpath} resolves to ${file}; loaded ${own.join(", ")}`);
    for (const name of names) assert.ok(exports.includes(name), `${subpath} exports ${name}`);
    for (const module of heavy) assert.ok(!own.includes(module), `${subpath} must not load ${module}`);
    const packages = loaded.filter((url) => url.includes("/node_modules/"));
    assert.deepEqual(packages, [], `${subpath} must not load dependency packages`);
  });
}

// The entries a host imports on demand. They need Survey and Flow by design, but not the sidecar or the root barrel.
const onDemand = [
  ["survey-flow-gate-adapter", "build/src/survey-flow-gate-adapter.js", ["createSurveyFlowGateAdapter"]],
  ["survey-flow-gate-review-work", "build/src/survey-flow-gate-review-work.js", ["discoverSurveyGateReviewWork"]],
];

for (const [subpath, file, names] of onDemand) {
  test(`@kontourai/flow-agents/${subpath} loads without the root barrel or the sidecar graph`, () => {
    const { own, exports } = importInChild(`@kontourai/flow-agents/${subpath}`);
    assert.ok(own.includes(file), `${subpath} resolves to ${file}`);
    for (const name of names) assert.ok(exports.includes(name), `${subpath} exports ${name}`);
    for (const module of heavy) assert.ok(!own.includes(module), `${subpath} must not load ${module}`);
  });
}

test("the probe sees the heavy graph when it is there: the package root loads the sidecar and @kontourai/flow", () => {
  const { loaded, own } = importInChild("@kontourai/flow-agents");
  assert.ok(own.includes("build/src/cli/workflow-sidecar.js"));
  assert.ok(loaded.some((url) => url.includes("/node_modules/") && url.includes("@kontourai/flow/")));
});

test("the sidecar and the package root re-export the vocabulary module's own bindings", () => {
  for (const [label, mod] of [["cli/workflow-sidecar", sidecar], ["package root", root]]) {
    assert.equal(mod.phases, vocabulary.phases, `${label} phases`);
    assert.equal(mod.statuses, vocabulary.statuses, `${label} statuses`);
    assert.equal(mod.writeJson, vocabulary.writeJson, `${label} writeJson`);
  }
  assert.ok(vocabulary.statuses instanceof Set && vocabulary.statuses.has("in_progress"));
  assert.ok(Array.isArray(vocabulary.phases) && vocabulary.phases.includes("execution"));
});
