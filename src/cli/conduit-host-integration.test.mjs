import assert from "node:assert/strict";
import test from "node:test";

import {
  createClaudeCodeAdapter,
  createStrandsAdapter,
  probeHostConformance,
} from "@kontourai/conduit";
import {
  deriveHostIntegrationLimitations,
  generateHostConformanceEvidence,
} from "../../build/src/index.js";

function localHarness() {
  const writes = new Map();
  const adapter = createClaudeCodeAdapter({
    resolveTarget: (asset) => `virtual/${asset.kind}/${asset.id}`,
    write: (target, content) => writes.set(target, content),
  });
  return { adapter, writes };
}

function inProcessFramework() {
  const installed = [];
  const projected = [];
  const adapter = createStrandsAdapter({
    installAsset: (asset) => installed.push(asset),
    applyOutcome: (event, outcome) => {
      projected.push({ event, outcome });
      return outcome;
    },
  });
  return { adapter, installed, projected };
}

test("local harness consumes portable assets and preserves deny reason and model context", async () => {
  const { adapter, writes } = localHarness();
  const assets = [
    { id: "builder.deliver", kind: "skill", content: "Use the selected build workflow." },
    { id: "config-protection", kind: "hook", content: "Evaluate protected runtime configuration." },
    { id: "gate-awareness", kind: "context", content: "A blocked gate is an actionable state." },
  ];
  const receipt = await adapter.install(assets);
  assert.equal(receipt.installed.length, 3);
  assert.equal(receipt.skipped.length, 0);
  assert.equal(writes.get("virtual/skill/builder.deliver"), assets[0].content);
  assert.equal("content" in receipt.installed[0], false, "receipt must not leak installed content");

  const event = { phase: "before-tool", sessionId: "local-session", context: { tool: "write" } };
  const denied = { decision: "deny", reason: "Protected configuration is server-owned.", modelContext: "Edit the canonical source instead." };
  assert.deepEqual(await adapter.project(event, denied), denied);
  assert.deepEqual((await probeHostConformance(adapter)).filter((result) => result.status === "fail"), []);
});

test("in-process framework consumes lifecycle outcomes without translating Flow Agents policy", async () => {
  const { adapter, installed, projected } = inProcessFramework();
  const asset = { id: "workflow-steering", kind: "prompt", content: "Continue from the persisted workflow state." };
  const receipt = await adapter.install([asset]);
  assert.equal(receipt.installed.length, 1);
  assert.deepEqual(installed, [asset]);

  const event = { phase: "before-model", sessionId: "framework-session", context: { step: "verify" } };
  const outcome = { decision: "observe", modelContext: "The current workflow step is verify." };
  assert.deepEqual(await adapter.project(event, outcome), outcome);
  assert.deepEqual(projected, [{ event, outcome }]);
  assert.deepEqual((await probeHostConformance(adapter)).filter((result) => result.status === "fail"), []);
});

test("conformance evidence derives limitations from executable declarations and results", async () => {
  const { adapter: local } = localHarness();
  const { adapter: embedded } = inProcessFramework();
  const generated = await generateHostConformanceEvidence([
    {
      adapter: local,
      evidenceScope: "adapter-contract",
      adapterVersion: "0.2.1",
      hostId: "flow-agents-local-harness-binding",
      hostVersion: "public-config-binding-v1",
    },
    {
      adapter: embedded,
      evidenceScope: "adapter-contract",
      adapterVersion: "0.2.1",
      hostId: "flow-agents-in-process-binding",
      hostVersion: "caller-bound-hooks-v1",
    },
  ]);

  assert.deepEqual(generated.report.adapters.map((entry) => entry.adapterId), ["claude-code", "strands"]);
  assert.equal(generated.report.adapters.every((entry) => entry.results.every((result) => result.status === "pass")), true);
  assert.deepEqual(generated.report.adapters[0].limitations, [
    "install.context=static-only",
    "lifecycle.before-model=approximated",
  ]);
  assert.deepEqual(generated.report.adapters[1].limitations, [
    "install.agent=approximated",
    "install.command=approximated",
    "install.skill=approximated",
  ]);
  assert.match(generated.json, /flow-agents-local-harness-binding/);
  assert.match(generated.matrix, /claude-code/);
});

test("limitation projection reports failed probes without runtime-specific prose", () => {
  const capabilities = localHarness().adapter.capabilities();
  assert.deepEqual(
    deriveHostIntegrationLimitations(capabilities, [{ check: "deny-fidelity", status: "fail" }]),
    ["conformance.deny-fidelity=fail", "install.context=static-only", "lifecycle.before-model=approximated"],
  );
});
