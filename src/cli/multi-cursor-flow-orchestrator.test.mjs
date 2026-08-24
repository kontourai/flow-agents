import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { claimReadyStep, loadRun, releaseStepClaim, startRun } from "@kontourai/flow";
import {
  FlowMultiCursorOrchestrationError,
  orchestrateBuilderFlowMultiCursor,
  orchestrateFlowMultiCursor,
} from "../../build/src/index.js";
import { startBuilderFlowSession } from "../../build/src/builder-flow-runtime.js";
import { performLocalClaim, resolveCurrentAssignmentActor } from "../../build/src/cli/assignment-provider.js";
import { validateEvidenceRef } from "../../build/src/cli/workflow-sidecar.js";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

function workspace() {
  return makeFixtureDir("flow-agents-multi-cursor-");
}

function writeDefinition(cwd) {
  const file = path.join(cwd, "multi-cursor.flow.json");
  fs.writeFileSync(file, `${JSON.stringify({
    id: "flow-agents-multi-cursor-fixture",
    version: "1",
    execution: { mode: "multi-cursor", claim_contract_version: "1" },
    steps: [
      { id: "shared-first", next: null, mutable_resources: ["generated/shared-root"] },
      { id: "shared-second", next: null, mutable_resources: ["generated/shared-root"] },
      { id: "disjoint", next: null, mutable_resources: ["generated/disjoint-root"] },
    ],
    // Optional expectations make a completed callback settle without inventing
    // test-only evidence. Flow still evaluates and records every gate.
    gates: Object.fromEntries(["shared-first", "shared-second", "disjoint"].map((step) => [
      `${step}-gate`,
      {
        step,
        expects: [{
          id: "optional-observation",
          kind: "trust.bundle",
          required: false,
          description: "Optional fixture observation.",
          bundle_claim: { claimType: "fixture.optional" },
        }],
      },
    ])),
  }, null, 2)}\n`);
  return file;
}

function writeOneStepDefinition(cwd) {
  const file = path.join(cwd, "one-step.flow.json");
  fs.writeFileSync(file, `${JSON.stringify({
    id: "flow-agents-one-step-fixture",
    version: "1",
    execution: { mode: "multi-cursor", claim_contract_version: "1" },
    steps: [{ id: "only", next: null, mutable_resources: ["generated/only"] }],
    gates: {
      "only-gate": {
        step: "only",
        expects: [{
          id: "optional-observation",
          kind: "trust.bundle",
          required: false,
          description: "Optional fixture observation.",
          bundle_claim: { claimType: "fixture.optional" },
        }],
      },
    },
  }, null, 2)}\n`);
  return file;
}

function writeRouteBackDefinition(cwd) {
  const file = path.join(cwd, "route-back.flow.json");
  const optional = (step) => ({
    step,
    expects: [{
      id: `${step}-optional`,
      kind: "trust.bundle",
      required: false,
      description: "Optional fixture observation.",
      bundle_claim: { claimType: "fixture.optional" },
    }],
  });
  fs.writeFileSync(file, `${JSON.stringify({
    id: "flow-agents-route-back-fixture",
    version: "1",
    execution: { mode: "multi-cursor", claim_contract_version: "1" },
    steps: [
      { id: "root", next: null, mutable_resources: [] },
      { id: "route-back", next: null, needs: ["root"], mutable_resources: ["generated/a"] },
      { id: "sibling", next: null, needs: ["root"], mutable_resources: ["generated/b"] },
    ],
    gates: {
      "root-gate": optional("root"),
      "route-back-gate": {
        step: "route-back",
        on_route_back: { missing_evidence: "root" },
        route_back_policy: { max_attempts: 3, on_exceeded: "block" },
        expects: [{
          id: "required-missing",
          kind: "trust.bundle",
          required: true,
          description: "Intentionally missing fixture evidence.",
          bundle_claim: { claimType: "fixture.required" },
        }],
      },
      "sibling-gate": optional("sibling"),
    },
  }, null, 2)}\n`);
  return file;
}

function identity(stepId) {
  return { claimId: `fixture-claim-${stepId}`, livenessId: `fixture-liveness-${stepId}` };
}

test("Builder runtime persists an exact session-bound schedule artifact for workflow evidence", async () => {
  const projectRoot = workspace();
  const slug = "builder-multi-cursor-evidence";
  const sessionDir = path.join(projectRoot, ".kontourai", "flow-agents", slug);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "state.json"), `${JSON.stringify({
    schema_version: "1.0",
    task_slug: slug,
    status: "planned",
    phase: "planning",
    updated_at: "2026-07-25T00:00:00.000Z",
    work_item_refs: ["local:work-item/flow-agents-949"],
    next_action: { status: "continue", summary: "Start Builder." },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(projectRoot, ".kontourai", "flow-agents", "current.json"), `${JSON.stringify({
    active_slug: slug,
    artifact_dir: slug,
    updated_at: "2026-07-25T00:00:00.000Z",
  }, null, 2)}\n`);
  const ambient = resolveCurrentAssignmentActor();
  performLocalClaim(path.join(projectRoot, ".kontourai", "flow-agents"), slug, ambient.actor, {
    ttlSeconds: 1800,
    actorKey: ambient.actorKey,
    branch: `agent/${slug}`,
    artifactDir: slug,
    workItemRef: "local:work-item/flow-agents-949",
    reason: "fixture",
  });
  await startBuilderFlowSession({ sessionDir });
  const planRunId = "builder-verification-plan";
  await startRun(writeDefinition(projectRoot), {
    cwd: projectRoot,
    runId: planRunId,
    params: { subject: "local:work-item/flow-agents-949" },
  });

  const result = await orchestrateBuilderFlowMultiCursor({
    sessionDir,
    runId: planRunId,
    actor: { key: "builder:fixture", kind: "test" },
    identityFactory: identity,
    execute: async () => {},
  });

  assert.equal(result.evidence.kind, "kontourai.builder.multi-cursor-schedule");
  assert.equal(result.evidence.builderRun.runId, slug);
  assert.equal(result.evidence.schedule.runId, planRunId);
  assert.deepEqual(validateEvidenceRef(structuredClone(result.evidenceRef), "schedule evidence", projectRoot), result.evidenceRef);
  const artifact = path.join(projectRoot, result.evidenceRef.file);
  assert.deepEqual(JSON.parse(fs.readFileSync(artifact, "utf8")), result.evidence);
  const firstBytes = fs.readFileSync(artifact);

  const secondRunId = "builder-verification-plan-second";
  await startRun(writeDefinition(projectRoot), {
    cwd: projectRoot,
    runId: secondRunId,
    params: { subject: "local:work-item/flow-agents-949" },
  });
  const second = await orchestrateBuilderFlowMultiCursor({
    sessionDir,
    runId: secondRunId,
    actor: { key: "builder:fixture", kind: "test" },
    identityFactory: identity,
    execute: async () => {},
  });
  assert.notEqual(second.evidenceRef.file, result.evidenceRef.file);
  assert.deepEqual(fs.readFileSync(artifact), firstBytes, "a later schedule cannot rewrite an earlier evidence reference");

  const unrelatedRunId = "builder-verification-plan-unrelated";
  await startRun(writeDefinition(projectRoot), {
    cwd: projectRoot,
    runId: unrelatedRunId,
    params: { subject: "local:work-item/unrelated" },
  });
  await assert.rejects(orchestrateBuilderFlowMultiCursor({
    sessionDir,
    runId: unrelatedRunId,
    actor: { key: "builder:fixture", kind: "test" },
    execute: async () => {},
  }), /subject does not match/);
});

test("Flow claims serialize shared writable roots while the disjoint gate overlaps", async () => {
  const cwd = workspace();
  const runId = "multi-cursor-barrier";
  await startRun(writeDefinition(cwd), { cwd, runId, params: { subject: "flow-agents#949" } });

  let releaseSharedFirst;
  const sharedFirstReleased = new Promise((resolve) => { releaseSharedFirst = resolve; });
  let signalDisjointStarted;
  const disjointStarted = new Promise((resolve) => { signalDisjointStarted = resolve; });
  const lifecycle = [];
  let sharedRootRunning = false;

  const input = {
    cwd,
    runId,
    actor: { key: "fixture-host", kind: "test" },
    identityFactory: identity,
    renewalIntervalMs: 5,
    leaseSeconds: 60,
    execute: async ({ claim }) => {
      lifecycle.push(`started:${claim.step_id}`);
      if (claim.step_id.startsWith("shared-")) {
        sharedRootRunning = true;
        await disjointStarted;
        await sharedFirstReleased;
        sharedRootRunning = false;
        lifecycle.push(`finished:${claim.step_id}`);
        return;
      }
      if (claim.step_id === "disjoint") {
        assert.equal(sharedRootRunning, true, "disjoint work must overlap the admitted shared-root work");
        lifecycle.push("finished:disjoint");
        signalDisjointStarted();
        releaseSharedFirst();
        return;
      }
      assert.fail(`unexpected step ${claim.step_id}`);
    },
  };

  const observation = await orchestrateFlowMultiCursor(input);

  const firstShared = observation.events.find((event) => event.kind === "admitted" && event.mutableResources.includes("generated/shared-root"));
  const deferredShared = observation.events.find((event) => event.kind === "deferred" && event.diagnosticCode === "flow.multi_cursor.claim.resource_conflict");
  assert.ok(firstShared && deferredShared, "Flow admits one shared root and returns its sibling as a typed conflict");
  const firstSettled = observation.events.findIndex((event) => event.kind === "settled" && event.stepId === firstShared.stepId);
  const secondStarted = observation.events.findIndex((event) => event.kind === "started" && event.stepId === deferredShared.stepId);
  assert.ok(firstSettled >= 0, "first shared-root gate must be Flow-settled");
  assert.ok(secondStarted > firstSettled, "the conflicting shared-root gate dispatches only after Flow settles the first claim");
  assert.ok(lifecycle.indexOf("started:disjoint") < lifecycle.indexOf(`finished:${firstShared.stepId}`), "disjoint callback overlaps shared-root callback");
  assert.equal(observation.unsettledSteps.length, 0);
  assert.notEqual(observation.initialRunHead, observation.finalRunHead, "schedule evidence binds the exact Flow head transition");
  assert.equal(observation.definition.id, "flow-agents-multi-cursor-fixture");
  assert.match(observation.definition.digest, /^[a-f0-9]{64}$/);
  const renewalEvents = observation.events.filter((event) => event.kind === "renewed");
  assert.ok(renewalEvents.length <= 3, "renewal evidence is aggregated per claim");
  assert.ok(renewalEvents.every((event) => event.count > 0));

  const run = await loadRun(runId, cwd);
  assert.deepEqual(run.state.multi_cursor.active_claims, [], "Flow, not the host, clears settled claims");
  assert.equal(run.state.multi_cursor.claim_history.filter((entry) => entry.action === "claimed").length, 3);
  assert.equal(run.state.multi_cursor.claim_history.filter((entry) => entry.action === "settled").length, 3);
});

test("maxRounds accepts a schedule that drains the frontier on its final round", async () => {
  const cwd = workspace();
  const runId = "multi-cursor-one-round";
  await startRun(writeOneStepDefinition(cwd), { cwd, runId, params: { subject: "flow-agents#949" } });
  const observation = await orchestrateFlowMultiCursor({
    cwd,
    runId,
    actor: { key: "fixture-host", kind: "test" },
    identityFactory: identity,
    maxRounds: 1,
    execute: async () => {},
  });
  assert.equal(observation.events.some((event) => event.kind === "settled" && event.stepId === "only"), true);
  assert.equal((await loadRun(runId, cwd)).state.status, "completed");
});

test("a callback failure releases the exact Flow claim and fails closed with the schedule observation", async () => {
  const cwd = workspace();
  const runId = "multi-cursor-callback-failure";
  const secret = "sk-secret-must-not-enter-schedule-evidence";
  await startRun(writeDefinition(cwd), { cwd, runId, params: { subject: "flow-agents#949" } });

  await assert.rejects(
    orchestrateFlowMultiCursor({
      cwd,
      runId,
      actor: { key: "fixture-host", kind: "test" },
      identityFactory: identity,
      execute: async () => { throw new Error(`callback failed ${secret}`); },
    }),
    (error) => {
      assert.ok(error instanceof FlowMultiCursorOrchestrationError);
      assert.match(error.message, /orchestration failed/);
      assert.ok(error.observation.events.some((event) => event.kind === "released" && event.reason === "host-execution-failed"));
      assert.equal(JSON.stringify(error.observation).includes(secret), false, "persistable schedule evidence is content-safe");
      return true;
    },
  );

  const run = await loadRun(runId, cwd);
  assert.deepEqual(run.state.multi_cursor.active_claims, []);
  assert.ok(run.state.multi_cursor.claim_history.some((entry) => entry.action === "released"));
});

test("lost liveness aborts the callback and waits for it to stop before failing closed", async () => {
  const cwd = workspace();
  const runId = "multi-cursor-lost-liveness";
  await startRun(writeDefinition(cwd), { cwd, runId, params: { subject: "flow-agents#949" } });
  let aborted = false;
  let stopped = false;

  await assert.rejects(orchestrateFlowMultiCursor({
    cwd,
    runId,
    actor: { key: "fixture-host", kind: "test" },
    identityFactory: identity,
    renewalIntervalMs: 5,
    leaseSeconds: 60,
    execute: async ({ claim, signal }) => {
      await releaseStepClaim(runId, {
        cwd,
        claim_id: claim.claim_id,
        liveness_id: claim.liveness_id,
        actor: claim.actor,
        reason: "fixture-liveness-loss",
      });
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      aborted = true;
      await new Promise((resolve) => setImmediate(resolve));
      stopped = true;
    },
  }), FlowMultiCursorOrchestrationError);

  assert.equal(aborted, true);
  assert.equal(stopped, true, "orchestrator waits for the aborted callback to stop");
  const run = await loadRun(runId, cwd);
  assert.deepEqual(run.state.multi_cursor.active_claims, []);
});

test("a route-back is not evaluated until every admitted sibling callback has stopped", async () => {
  const cwd = workspace();
  const runId = "multi-cursor-route-back-barrier";
  await startRun(writeRouteBackDefinition(cwd), { cwd, runId, params: { subject: "flow-agents#949" } });
  let siblingObservedNoRouteBack = false;

  await assert.rejects(orchestrateFlowMultiCursor({
    cwd,
    runId,
    actor: { key: "fixture-host", kind: "test" },
    identityFactory: identity,
    maxRounds: 2,
    execute: async ({ claim }) => {
      if (claim.step_id !== "sibling") return;
      await new Promise((resolve) => setTimeout(resolve, 25));
      const duringCallback = await loadRun(runId, cwd);
      siblingObservedNoRouteBack = !duringCallback.state.gate_outcomes.some((outcome) => outcome.gate_id === "route-back-gate");
    },
  }), FlowMultiCursorOrchestrationError);

  assert.equal(siblingObservedNoRouteBack, true, "route-back settlement waits at the round callback barrier");
  const run = await loadRun(runId, cwd);
  assert.deepEqual(run.state.multi_cursor.active_claims, []);
  assert.ok(run.state.gate_outcomes.some((outcome) => outcome.gate_id === "route-back-gate" && outcome.status === "route-back"));
});

test("an authorized definition amendment between rounds fails closed and releases the drifted claim", async () => {
  const cwd = workspace();
  const runId = "multi-cursor-definition-drift";
  const definitionFile = writeRouteBackDefinition(cwd);
  await startRun(definitionFile, { cwd, runId, params: { subject: "flow-agents#949" } });
  const successor = JSON.parse(fs.readFileSync(definitionFile, "utf8"));
  successor.version = "2";
  const successorFile = path.join(cwd, "route-back-v2.flow.json");
  fs.writeFileSync(successorFile, `${JSON.stringify(successor, null, 2)}\n`);
  let amended = false;

  await assert.rejects(orchestrateFlowMultiCursor({
    cwd,
    runId,
    actor: { key: "fixture-host", kind: "test" },
    maxRounds: 3,
    identityFactory: (stepId) => {
      if (stepId !== "root" && !amended) {
        amended = true;
        execFileSync(process.execPath, ["--input-type=module", "-e", `
          import fs from "node:fs";
          import { amendRunDefinition, definitionDigest, definitionIdentity, flowRunHead, loadRun } from "@kontourai/flow";
          const current = await loadRun(${JSON.stringify(runId)}, ${JSON.stringify(cwd)});
          const successor = JSON.parse(fs.readFileSync(${JSON.stringify(successorFile)}, "utf8"));
          await amendRunDefinition(${JSON.stringify(runId)}, {
            cwd: ${JSON.stringify(cwd)},
            definition: successor,
            request: {
              reason: "definition drift fixture",
              expected_run_head: flowRunHead(current.state),
              expected_definition: definitionIdentity(current.definition),
              successor_digest: definitionDigest(successor),
              authority: {
                kind: "user_request",
                actor: "definition-drift-test",
                request_ref: "test:definition-drift",
                requested_at: "2026-07-25T00:00:00.000Z"
              }
            }
          });
        `], { cwd, stdio: "pipe" });
      }
      return identity(stepId);
    },
    execute: async () => {},
  }), (error) => {
    assert.ok(error instanceof FlowMultiCursorOrchestrationError);
    assert.equal(error.observation.definition.version, "1");
    return true;
  });

  assert.equal(amended, true);
  assert.deepEqual((await loadRun(runId, cwd)).state.multi_cursor.active_claims, []);
});

test("a non-resource Flow claim error is never converted into deferred work", async () => {
  const cwd = workspace();
  const runId = "multi-cursor-invalid-actor";
  await startRun(writeDefinition(cwd), { cwd, runId, params: { subject: "flow-agents#949" } });
  let dispatched = false;

  await assert.rejects(
    orchestrateFlowMultiCursor({
      cwd,
      runId,
      actor: { key: "", kind: "test" },
      execute: async () => { dispatched = true; },
    }),
    (error) => {
      assert.ok(error instanceof FlowMultiCursorOrchestrationError);
      assert.equal(error.observation.events.some((event) => event.kind === "deferred"), false);
      return true;
    },
  );
  assert.equal(dispatched, false, "a failed Flow admission must not reach the host callback");
});

test("a failed admission round releases every sibling claim before rejecting", async () => {
  const cwd = workspace();
  const runId = "multi-cursor-partial-admission";
  await startRun(writeDefinition(cwd), { cwd, runId, params: { subject: "flow-agents#949" } });
  let dispatched = false;

  await assert.rejects(orchestrateFlowMultiCursor({
    cwd,
    runId,
    actor: { key: "fixture-host", kind: "test" },
    identityFactory: (stepId) => stepId === "shared-second"
      ? { claimId: "invalid/claim", livenessId: `fixture-liveness-${stepId}` }
      : identity(stepId),
    execute: async () => { dispatched = true; },
  }), FlowMultiCursorOrchestrationError);

  const run = await loadRun(runId, cwd);
  assert.equal(dispatched, false, "no callback runs after a partial admission failure");
  assert.deepEqual(run.state.multi_cursor.active_claims, [], "every sibling admission is released");
  assert.ok(run.state.multi_cursor.claim_history.some((entry) => entry.action === "released" && entry.reason === "admission-round-failed"));
});

test("expired Flow leases are recovered before dispatch; recovery is not a host-side ledger", async () => {
  const cwd = workspace();
  const runId = "multi-cursor-recovery";
  await startRun(writeDefinition(cwd), { cwd, runId, params: { subject: "flow-agents#949" } });
  await claimReadyStep(runId, {
    cwd,
    step_id: "shared-first",
    claim_id: "abandoned-claim",
    liveness_id: "abandoned-liveness",
    actor: { key: "abandoned-host", kind: "test" },
    lease_seconds: 60,
    now: "2000-01-01T00:00:00.000Z",
  });

  const observation = await orchestrateFlowMultiCursor({
    cwd,
    runId,
    actor: { key: "fixture-host", kind: "test" },
    identityFactory: identity,
    execute: async () => {},
  });

  assert.ok(observation.events.some((event) => event.kind === "recovered" && event.claimId === "abandoned-claim"));
  const run = await loadRun(runId, cwd);
  assert.deepEqual(run.state.multi_cursor.active_claims, []);
  assert.ok(run.state.multi_cursor.claim_history.some((entry) => entry.action === "expired" && entry.claim_id === "abandoned-claim"));
});
