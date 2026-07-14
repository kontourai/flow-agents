import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import {
  defaultArtifactRootForRead,
  defaultCodexHome,
  durableFlowAgentsRoot,
  durableInstallRecordPath,
  DURABLE_FLOW_AGENTS_DIR,
  FLOW_AGENTS_RUNTIME_DIR,
  FLOW_AGENTS_RUNTIME_SUBDIR,
  flowAgentsArtifactRoot,
  KONTOURAI_DIR,
} from "../../build/src/index.js";

test("public API exports local artifact root helpers", () => {
  const cwd = path.resolve("/tmp/flow-agents-public-api");

  assert.equal(KONTOURAI_DIR, ".kontourai");
  assert.equal(FLOW_AGENTS_RUNTIME_SUBDIR, "flow-agents");
  assert.equal(FLOW_AGENTS_RUNTIME_DIR, path.join(".kontourai", "flow-agents"));
  assert.equal(DURABLE_FLOW_AGENTS_DIR, ".flow-agents");
  assert.equal(flowAgentsArtifactRoot(cwd), path.join(cwd, FLOW_AGENTS_RUNTIME_DIR));
  assert.equal(durableFlowAgentsRoot(cwd), path.join(cwd, ".flow-agents"));
  assert.equal(durableInstallRecordPath(cwd), path.join(cwd, ".flow-agents", "install.json"));
  assert.equal(defaultArtifactRootForRead(cwd), path.join(cwd, FLOW_AGENTS_RUNTIME_DIR));
  assert.notEqual(defaultArtifactRootForRead(cwd), durableFlowAgentsRoot(cwd));
});

test("public API retains the documented native-host compatibility surface", async () => {
  const lib = await import("../../build/src/index.js");
  for (const name of [
    "startBuilderBuildRun", "evaluateBuilderBuildRun", "startBuilderFlowSession",
    "pauseBuilderFlowSession", "resumeBuilderFlowSession", "cancelBuilderFlowSession",
    "archiveBuilderFlowSession", "recoverBuilderFlowSession", "releaseBuilderFlowAssignment",
    "ContinuationAdapterTimeoutError",
    "writeJson", "appendJsonl", "sidecarBase", "writeState", "writeSidecar",
  ]) {
    assert.equal(typeof lib[name], "function", `${name} must remain package-root exported`);
  }
  assert.equal(typeof lib.loadJson, "function");
  assert.equal(typeof lib.validateTrustBundle, "function");
  assert.equal(typeof lib.builderLifecycleAuthorizationPayload, "function");
});

test("public API exports the pure narrative source contract", async () => {
  const lib = await import("../../build/src/index.js");
  for (const name of [
    "parseSourceId", "formatSourceId", "compareSourceIds",
    "integrityClassForSource", "buildCaptureCompleteness",
    "effectiveNarrativeRedactionFields", "filterNarrativeRecord",
  ]) {
    assert.equal(typeof lib[name], "function", `${name} must be package-root exported`);
  }
  assert.equal(lib.NARRATIVE_SOURCE_ID_VERSION, "fa1");
});

test("TS and CJS artifact helpers stay in parity without durable-root fallback", () => {
  const require = createRequire(import.meta.url);
  const cjs = require("../../scripts/hooks/lib/local-artifact-paths.js");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-paths-"));

  fs.mkdirSync(path.join(cwd, DURABLE_FLOW_AGENTS_DIR, "previous-session"), { recursive: true });
  fs.writeFileSync(path.join(cwd, DURABLE_FLOW_AGENTS_DIR, "current.json"), "{}\n");

  assert.equal(cjs.KONTOURAI_DIR, KONTOURAI_DIR);
  assert.equal(cjs.FLOW_AGENTS_RUNTIME_SUBDIR, FLOW_AGENTS_RUNTIME_SUBDIR);
  assert.equal(cjs.FLOW_AGENTS_RUNTIME_DIR, FLOW_AGENTS_RUNTIME_DIR);
  assert.equal(cjs.DURABLE_FLOW_AGENTS_DIR, DURABLE_FLOW_AGENTS_DIR);

  assert.equal(cjs.flowAgentsArtifactRoot(cwd), flowAgentsArtifactRoot(cwd));
  assert.equal(cjs.defaultArtifactRootForRead(cwd), defaultArtifactRootForRead(cwd));
  assert.equal(cjs.durableFlowAgentsRoot(cwd), durableFlowAgentsRoot(cwd));
  assert.deepEqual(cjs.flowAgentsArtifactRootsForRead(cwd), []);
});

test("defaultCodexHome honors CODEX_HOME env override", () => {
  const previous = process.env["CODEX_HOME"];
  try {
    process.env["CODEX_HOME"] = "/custom/codex-home";
    assert.equal(defaultCodexHome(), "/custom/codex-home");
  } finally {
    if (previous === undefined) delete process.env["CODEX_HOME"];
    else process.env["CODEX_HOME"] = previous;
  }
});

test("defaultCodexHome falls back to ~/.codex when CODEX_HOME is unset", () => {
  const previous = process.env["CODEX_HOME"];
  try {
    delete process.env["CODEX_HOME"];
    assert.equal(defaultCodexHome(), path.join(os.homedir(), ".codex"));
  } finally {
    if (previous === undefined) delete process.env["CODEX_HOME"];
    else process.env["CODEX_HOME"] = previous;
  }
});
