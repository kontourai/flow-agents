import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import * as flow from "@kontourai/flow";
import { orchestrateFlowMultiCursor } from "../../build/src/index.js";
import { resolveCanonicalFlowRunIdentity } from "../../packaging/lifecycle-authority/coordinator.mjs";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

test("generic SDK and coordinator readers consume authorized pending-forward definitions", async () => {
  const cwd = makeFixtureDir("flow-pending-forward-readers-");
  const runId = "pending-forward-readers";
  const definition = {
    id: "reader-compatibility",
    version: "1",
    execution: { mode: "multi-cursor", claim_contract_version: "1" },
    steps: [
      { id: "current", next: "omitted", needs: [], mutable_resources: [] },
      { id: "omitted", next: "retained", needs: ["current"], mutable_resources: [] },
      { id: "retained", next: null, needs: ["omitted"], mutable_resources: [] },
    ],
    gates: Object.fromEntries(["current", "omitted", "retained"].map(step => [
      `${step}-gate`,
      { step, expects: [{
        id: "optional-observation", kind: "trust.bundle", required: false,
        description: "Optional observed fixture result.",
        bundle_claim: { claimType: "fixture.optional" },
      }] },
    ])),
  };
  const file = path.join(cwd, "definition.json");
  fs.writeFileSync(file, JSON.stringify(definition));
  await flow.startRun(file, { cwd, runId });
  const before = await flow.loadRun(runId, cwd);
  const startBytes = fs.readFileSync(path.join(before.dir, "definition.json"));
  const successor = structuredClone(definition);
  successor.version = "2";
  successor.steps = successor.steps.filter(step => step.id !== "omitted");
  successor.steps[0].next = "retained";
  successor.steps[1].needs = ["current"];
  delete successor.gates["omitted-gate"];
  await flow.amendRunDefinition(runId, {
    cwd, definition: successor,
    request: {
      reason: "Omit only future untouched work.",
      compatibility_mode: "pending_forward",
      expected_run_head: flow.flowRunHead(before.state),
      expected_definition: flow.definitionIdentity(before.definition),
      successor_digest: flow.definitionDigest(successor),
      authority: {
        kind: "operator_request", actor: "reader-compatibility-test",
        request_ref: "test:pending-forward-readers", requested_at: "2026-10-09T20:00:00.000Z",
      },
    },
  });
  const amended = await flow.loadRun(runId, cwd);
  const canonical = resolveCanonicalFlowRunIdentity(flow, definition, amended.state, runId);
  assert.equal(canonical.definition.version, "2");
  assert.equal(flow.definitionDigest(canonical.definition), flow.definitionDigest(successor));
  const dispatched = [];
  const observation = await orchestrateFlowMultiCursor({
    cwd, runId, actor: { key: "reader-test-host", kind: "test" },
    execute: async ({ claim }) => { dispatched.push(claim.step_id); },
  });
  assert.equal(observation.definition.version, "2");
  assert.deepEqual(dispatched, ["current", "retained"]);
  assert.equal((await flow.loadRun(runId, cwd)).state.status, "completed");
  assert.deepEqual(fs.readFileSync(path.join(before.dir, "definition.json")), startBytes);
});
