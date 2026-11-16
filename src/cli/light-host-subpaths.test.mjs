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

// Each subpath's runtime exports, pinned here rather than derived, so widening one is a reviewed change.
// They match what the package root exports from the same source module.
const light = [
  ["local-artifact-root", "build/src/lib/local-artifact-root.js", ["DURABLE_FLOW_AGENTS_DIR", "FLOW_AGENTS_RUNTIME_DIR", "FLOW_AGENTS_RUNTIME_SUBDIR", "KONTOURAI_DIR", "LEGACY_TELEMETRY_DIR", "defaultArtifactRootForRead", "defaultCodexHome", "defaultTelemetryDirForRead", "defaultTelemetryDirsForRead", "durableFlowAgentsRoot", "durableInstallRecordPath", "firstExistingPath", "flowAgentsArtifactRoot", "legacyTelemetryDataDir", "telemetryDataDir"]],
  ["run-correlation", "build/src/run-correlation.js", ["CREDENTIAL_PATTERN_SOURCES", "RUNTIME_CORRELATION_IDENTITY_DECLARATIONS", "RUN_CORRELATION_IDENTITY_KEYS", "RUN_CORRELATION_IDENTITY_STATUSES", "RUN_CORRELATION_SCHEMA_VERSION", "RunCorrelationValidationError", "attachRunCorrelation", "containsSensitiveCredential", "createRunCorrelationEnvelope", "readRunCorrelation", "runtimeCorrelationIdentityDeclaration", "validateRunCorrelationEnvelope", "validateRunCorrelationPresence"]],
  ["host-workflow-binding", "build/src/lib/host-workflow-binding.js", ["bindHostWorkflowSession", "buildUnsignedHostWorkflowAuthority", "hostWorkflowAuthorityPayload", "retireHostWorkflowSession", "validateHostWorkflowAuthority"]],
  ["workflow-sidecar-vocabulary", "build/src/lib/workflow-sidecar-vocabulary.js", ["phases", "statuses", "writeJson"]],
  ["narrative-retained-reader", "build/src/narrative/retained-reader.js", ["readGroundedNarrative"]],
];

// Entries a host imports on demand. They need Survey and Flow by design, but not the sidecar or the root barrel.
const onDemand = [
  ["survey-flow-gate-adapter", "build/src/survey-flow-gate-adapter.js", ["SurveyFlowGateInputError", "continuePausedFlowGateFromSurvey", "createSurveyFlowGateAdapter"]],
  ["survey-flow-gate-review-work", "build/src/survey-flow-gate-review-work.js", ["bindSurveyGateReviewItem", "discoverSurveyGateReviewWork", "publishSurveyGateReviewWork"]],
];

function assertEntry(subpath, source, names) {
  const result = importInChild(`@kontourai/flow-agents/${subpath}`);
  const entry = `build/src/subpaths/${subpath}.js`;
  assert.ok(result.own.includes(entry), `${subpath} resolves to ${entry}; loaded ${result.own.join(", ")}`);
  assert.ok(result.own.includes(source), `${subpath} re-exports ${source}`);
  assert.deepEqual([...result.exports].sort(), [...names].sort(), `${subpath} exports exactly its pinned list`);
  for (const module of heavy) assert.ok(!result.own.includes(module), `${subpath} must not load ${module}`);
  return result;
}

for (const [subpath, source, names] of light) {
  test(`@kontourai/flow-agents/${subpath} exports its pinned list without the sidecar graph or any dependency package`, () => {
    const { loaded } = assertEntry(subpath, source, names);
    assert.deepEqual(loaded.filter((url) => url.includes("/node_modules/")), [], `${subpath} must not load dependency packages`);
  });
}

for (const [subpath, source, names] of onDemand) {
  test(`@kontourai/flow-agents/${subpath} exports its pinned list without the root barrel or the sidecar graph`, () => {
    assertEntry(subpath, source, names);
  });
}

test("every subpath export is the package root's own binding of the same name", async () => {
  for (const [subpath, , names] of [...light, ...onDemand]) {
    const entry = await import(`@kontourai/flow-agents/${subpath}`);
    for (const name of names) {
      assert.ok(name in root, `the package root exports ${name}`);
      assert.equal(entry[name], root[name], `${subpath} ${name}`);
    }
  }
});

test("each subpath carries the package root's types for its module", () => {
  const run = spawnSync(process.execPath, [path.join(repoRoot, "node_modules/typescript/bin/tsc"), "--ignoreConfig", "--noEmit", "--skipLibCheck", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", path.join(repoRoot, "evals/fixtures/light-host-subpath-types.mts")], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});

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
