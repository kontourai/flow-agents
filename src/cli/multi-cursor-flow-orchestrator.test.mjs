import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
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

function amendDefinition(cwd, runId, successorFile) {
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
  `], { cwd: process.cwd(), stdio: "pipe" });
}

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
  const executed = [];

  await assert.rejects(orchestrateFlowMultiCursor({
    cwd,
    runId,
    actor: { key: "fixture-host", kind: "test" },
    maxRounds: 3,
    identityFactory: (stepId) => {
      if (stepId !== "root" && !amended) {
        amendDefinition(cwd, runId, successorFile);
        amended = true;
      }
      return identity(stepId);
    },
    execute: async ({ claim }) => { executed.push(claim.step_id); },
  }), (error) => {
    assert.ok(error instanceof FlowMultiCursorOrchestrationError);
    assert.equal(error.observation.definition.version, "1");
    return true;
  });

  assert.equal(amended, true);
  assert.deepEqual(executed, ["root"], "a claim under the amended definition must not reach the host");
  const run = await loadRun(runId, cwd);
  assert.equal(run.definition.version, "2");
  assert.deepEqual(run.state.multi_cursor.active_claims, []);
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

function writeDisjointDefinition(cwd, count = 4) {
  const file = writeOneStepDefinition(cwd);
  const definition = JSON.parse(fs.readFileSync(file, "utf8"));
  definition.steps = Array.from({ length: count }, (_, index) => ({
    id: `step-${index}`, next: null, mutable_resources: [`generated/step-${index}`],
  }));
  definition.gates = Object.fromEntries(definition.steps.map(({ id }) => [
    `${id}-gate`, { ...definition.gates["only-gate"], step: id },
  ]));
  fs.writeFileSync(file, JSON.stringify(definition));
  return file;
}

async function schedulerFixture(runId, count = 1) {
  const cwd = workspace();
  await startRun(writeDisjointDefinition(cwd, count), { cwd, runId, params: { subject: "flow-agents#1113" } });
  return { cwd, runId, actor: { key: "scheduler-host", kind: "test" }, identityFactory: identity };
}

async function waitForRenewal(input, after) {
  const deadline = Date.now() + 5_000;
  do {
    const run = await loadRun(input.runId, input.cwd);
    const count = run.state.multi_cursor.claim_history.filter(({ action }) => action === "renewed").length;
    if (count > after) return run;
    await delay(5);
  } while (Date.now() < deadline);
  assert.fail("Flow did not persist another renewal while the host was stopping");
}

function assertUnusedClaimsReleased(run, count) {
  assert.deepEqual(run.state.multi_cursor.active_claims, []);
  const history = run.state.multi_cursor.claim_history;
  const claimed = history.filter(({ action }) => action === "claimed").map(({ claim_id }) => claim_id).sort();
  const released = history.filter(({ action }) => action === "released").map(({ claim_id }) => claim_id).sort();
  assert.equal(claimed.length, count);
  assert.deepEqual(released, claimed, "only the exact newly admitted claims are released");
  assert.equal(history.some(({ action }) => action === "settled"), false);
  assert.deepEqual(run.state.gate_outcomes, []);
}

for (const maxConcurrent of [1, 2]) {
  test(`bounded ready admission cap ${maxConcurrent} drains independent Flow steps`, async () => {
    const larger = await schedulerFixture(`bounded-frontier-${maxConcurrent}`, 4);
    let running = 0;
    let peak = 0;
    const seen = [];
    await orchestrateFlowMultiCursor({
      ...larger, maxConcurrent,
      execute: async ({ claim }) => {
        running += 1;
        peak = Math.max(peak, running);
        const active = (await loadRun(larger.runId, larger.cwd)).state.multi_cursor.active_claims;
        assert.ok(active.length <= maxConcurrent, "cap applies before Flow claims, not only before callbacks");
        seen.push(claim.step_id);
        await delay(20);
        running -= 1;
      },
    });
    assert.equal(peak, maxConcurrent);
    assert.deepEqual(seen.sort(), ["step-0", "step-1", "step-2", "step-3"]);
    assert.equal((await loadRun(larger.runId, larger.cwd)).state.status, "completed");
  });
}

test("maxConcurrent validates finite integer bounds before any Flow mutation", async () => {
  const input = await schedulerFixture("invalid-cap");
  for (const maxConcurrent of [0, -1, 1.5, NaN, Infinity, 1025]) {
    await assert.rejects(orchestrateFlowMultiCursor({ ...input, maxConcurrent, execute: async () => assert.fail("invalid cap executed") }), /maxConcurrent/);
  }
  assert.equal((await loadRun(input.runId, input.cwd)).state.multi_cursor.claim_history.length, 0);
});

test("already aborted scheduling performs no recovery, admission, or dispatch", async () => {
  const input = await schedulerFixture("pre-aborted");
  await claimReadyStep(input.runId, {
    cwd: input.cwd, step_id: "step-0", claim_id: "expired-before-abort", liveness_id: "expired-liveness",
    actor: input.actor, lease_seconds: 60, now: "2000-01-01T00:00:00.000Z",
  });
  const before = (await loadRun(input.runId, input.cwd)).state;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(orchestrateFlowMultiCursor({
    ...input, signal: controller.signal,
    onEvent: async () => assert.fail("aborted schedule observed a mutation"),
    execute: async () => assert.fail("aborted schedule executed"),
  }), FlowMultiCursorOrchestrationError);
  assert.deepEqual((await loadRun(input.runId, input.cwd)).state, before);
  assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
});

test("abort during a Flow claim cleans up the new claim without dispatch", async () => {
  const input = await schedulerFixture("claim-abort");
  const controller = new AbortController();
  await assert.rejects(orchestrateFlowMultiCursor({
    ...input, signal: controller.signal,
    identityFactory: (step) => { setImmediate(() => controller.abort()); return identity(step); },
    execute: async () => assert.fail("claim-time abort executed"),
  }), FlowMultiCursorOrchestrationError);
  assertUnusedClaimsReleased(await loadRun(input.runId, input.cwd), 1);
  assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
});

for (const boundary of ["admitted", "started"]) {
  test(`durable ${boundary} observation is awaited and rejection prevents dispatch`, async () => {
    const input = await schedulerFixture(`observer-${boundary}`, 2);
    const observerError = new Error(`observer-${boundary}-failed`);
    let callbacks = 0;
    const observed = [];
    await assert.rejects(orchestrateFlowMultiCursor({
      ...input, renewalIntervalMs: 5, leaseSeconds: 60,
      onEvent: async (event) => {
        observed.push(event.kind);
        if (event.kind === boundary) { await delay(20); throw observerError; }
      },
      execute: async () => { callbacks += 1; },
    }), (error) => {
      assert.ok(error instanceof FlowMultiCursorOrchestrationError);
      assert.match(error.observation.finalRunHead, /^[a-f0-9]{64}$/);
      assert.equal(error.observation.events.some(({ kind }) => kind === "settled"), false);
      assert.ok(hasCause(error, observerError), "asynchronous observer failure is retained as a cause");
      return true;
    });
    assert.equal(callbacks, 0);
    assert.ok(observed.includes("released"), "cleanup lifecycle is also observed");
    assertUnusedClaimsReleased(await loadRun(input.runId, input.cwd), 2);
  });
}

test("delayed durable observations precede callback and retain claim renewal", async () => {
  const input = await schedulerFixture("observer-delay");
  const durable = [];
  let renewals = 0;
  let renewed;
  const renewal = new Promise((resolve) => { renewed = resolve; });
  const observation = await orchestrateFlowMultiCursor({
    ...input, renewalIntervalMs: 5, leaseSeconds: 60,
    onEvent: async (event) => {
      if (event.kind === "renewed") { renewals += 1; renewed(); }
      if (event.kind === "admitted") await renewal;
      if (["admitted", "started", "settled"].includes(event.kind)) {
        await delay(20);
        durable.push(event.kind);
      }
    },
    execute: async () => {
      assert.deepEqual(durable, ["admitted", "started"]);
      assert.ok(renewals > 0, "claims stay live while durable admission is pending");
    },
  });
  assert.deepEqual(durable, ["admitted", "started", "settled"]);
  assert.ok(observation.finalRunHead);
});

test("external abort waits for host stop with heartbeat live, then releases without evaluation", async () => {
  const input = await schedulerFixture("execute-abort");
  const controller = new AbortController();
  let stopped = false;
  let abortSeen = false;
  let renewalsAfterAbort = 0;
  const observed = [];
  await assert.rejects(orchestrateFlowMultiCursor({
    ...input, signal: controller.signal, renewalIntervalMs: 5, leaseSeconds: 60,
    onEvent: async (event) => {
      observed.push(event.kind);
      if (event.kind === "renewed" && abortSeen) renewalsAfterAbort += 1;
      if (event.kind === "released") assert.equal(stopped, true, "abort request is not host stop confirmation");
    },
    execute: async ({ claim, signal }) => {
      const aborted = new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      controller.abort();
      await aborted;
      abortSeen = true;
      const before = (await loadRun(input.runId, input.cwd)).state.multi_cursor.claim_history.filter(({ action }) => action === "renewed").length;
      const run = await waitForRenewal(input, before);
      assert.ok(run.state.multi_cursor.active_claims.some(({ claim_id }) => claim_id === claim.claim_id));
      assert.equal(run.state.multi_cursor.claim_history.some(({ action }) => action === "released"), false);
      assert.ok(renewalsAfterAbort > 0, "execution abort must not stop heartbeat while callback is stopping");
      stopped = true;
    },
  }), FlowMultiCursorOrchestrationError);
  assert.equal(stopped, true);
  assertUnusedClaimsReleased(await loadRun(input.runId, input.cwd), 1);
  assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
  const count = observed.length;
  await delay(30);
  assert.equal(observed.length, count, "heartbeat is joined before orchestration rejects");
});

test("abort during durable admission releases unused claims without callback", async () => {
  const input = await schedulerFixture("observer-abort", 2);
  const controller = new AbortController();
  await assert.rejects(orchestrateFlowMultiCursor({
    ...input, signal: controller.signal,
    onEvent: async ({ kind }) => { if (kind === "admitted") { await delay(10); controller.abort(); } },
    execute: async () => assert.fail("admission abort executed"),
  }), FlowMultiCursorOrchestrationError);
  assertUnusedClaimsReleased(await loadRun(input.runId, input.cwd), 2);
});

test("bounded batches preserve maxRounds failure and final-round success", async () => {
  for (const maxRounds of [1, 2]) {
    const input = await schedulerFixture(`bounded-rounds-${maxRounds}`, 2);
    let executed = 0;
    const promise = orchestrateFlowMultiCursor({ ...input, maxConcurrent: 1, maxRounds, execute: async () => { executed += 1; } });
    if (maxRounds === 1) await assert.rejects(promise, FlowMultiCursorOrchestrationError);
    else await promise;
    assert.equal(executed, maxRounds);
    assert.deepEqual((await loadRun(input.runId, input.cwd)).state.multi_cursor.active_claims, []);
  }
});

function hasCause(error, expected) {
  return error === expected || Boolean(error && (
    error.errors?.some((cause) => hasCause(cause, expected)) || hasCause(error.cause, expected)
  ));
}

test("observer admission failure preserves another actor's exact active claim", async () => {
  const input = await schedulerFixture("observer-foreign-claim", 3);
  const foreign = await claimReadyStep(input.runId, {
    cwd: input.cwd, step_id: "step-0", claim_id: "foreign-claim", liveness_id: "foreign-liveness",
    actor: { key: "other-host", kind: "test" }, lease_seconds: 60,
  });
  await assert.rejects(orchestrateFlowMultiCursor({
    ...input,
    onEvent: async ({ kind }) => { if (kind === "admitted") throw new Error("durable write failed"); },
    execute: async () => assert.fail("observer rejection dispatched"),
  }), FlowMultiCursorOrchestrationError);
  const run = await loadRun(input.runId, input.cwd);
  assert.deepEqual(run.state.multi_cursor.active_claims, [foreign.claim]);
  const history = run.state.multi_cursor.claim_history;
  assert.deepEqual(history.filter(({ action }) => action === "released").map(({ claim_id }) => claim_id).sort(), [
    "fixture-claim-step-1", "fixture-claim-step-2",
  ]);
  assert.deepEqual(run.state.gate_outcomes, []);
});

test("renewal observer rejection aborts execution but retains heartbeat until host stops", async () => {
  const input = await schedulerFixture("renewal-observer-failure");
  const durableError = new Error("renewal persistence failed");
  const cleanupError = new Error("release persistence failed");
  let stopped = false;
  let signalObserved = false;
  let observedRenewals = 0;
  await assert.rejects(orchestrateFlowMultiCursor({
    ...input, renewalIntervalMs: 5, leaseSeconds: 60,
    onEvent: async ({ kind }) => {
      if (kind === "renewed") { observedRenewals += 1; throw durableError; }
      if (kind === "released") { assert.ok(stopped); throw cleanupError; }
    },
    execute: async ({ signal }) => {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      signalObserved = true;
      const before = (await loadRun(input.runId, input.cwd)).state.multi_cursor.claim_history.filter(({ action }) => action === "renewed").length;
      const duringStop = await waitForRenewal(input, before);
      assert.equal(duringStop.state.multi_cursor.active_claims.length, 1);
      assert.ok(duringStop.state.multi_cursor.claim_history.filter(({ action }) => action === "renewed").length > before);
      stopped = true;
    },
  }), (error) => {
    assert.ok(error instanceof FlowMultiCursorOrchestrationError);
    assert.ok(hasCause(error, durableError));
    assert.ok(hasCause(error, cleanupError));
    assert.ok(error.observation.finalRunHead);
    assert.ok(error.observation.events.some(({ kind }) => kind === "failed"));
    return true;
  });
  assert.equal(signalObserved, true);
  assert.equal(stopped, true);
  assert.equal(observedRenewals, 1, "failed observer is not retried by heartbeat");
  assertUnusedClaimsReleased(await loadRun(input.runId, input.cwd), 1);
});

test("post-settlement observer failure reports the real Flow terminal state without releasing it again", async () => {
  const input = await schedulerFixture("settled-observer-failure");
  const observerError = new Error("terminal observation failed");
  await assert.rejects(orchestrateFlowMultiCursor({
    ...input,
    onEvent: async ({ kind }) => { if (kind === "settled") { await delay(5); throw observerError; } },
    execute: async () => {},
  }), (error) => {
    assert.ok(hasCause(error, observerError));
    assert.ok(error.observation.events.some(({ kind, settled }) => kind === "settled" && settled));
    assert.equal(error.observation.events.some(({ kind }) => kind === "released"), false);
    assert.ok(error.observation.finalRunHead);
    return true;
  });
  const run = await loadRun(input.runId, input.cwd);
  assert.equal(run.state.status, "completed");
  assert.deepEqual(run.state.multi_cursor.active_claims, []);
  assert.equal(run.state.multi_cursor.claim_history.filter(({ action }) => action === "settled").length, 1);
});

test("default admission is bounded at 64 before claiming and the upper cap is accepted", async () => {
  const input = await schedulerFixture("default-cap", 65);
  let callbacks = 0;
  await assert.rejects(orchestrateFlowMultiCursor({
    ...input, maxRounds: 1,
    execute: async () => { callbacks += 1; },
  }), (error) => {
    assert.ok(error instanceof FlowMultiCursorOrchestrationError);
    return true;
  });
  assert.equal(callbacks, 64);
  const run = await loadRun(input.runId, input.cwd);
  assert.deepEqual(run.state.multi_cursor.active_claims, []);
  assert.equal(run.state.multi_cursor.claim_history.filter(({ action }) => action === "claimed").length, 64);
  assert.equal(run.state.multi_cursor.claim_history.filter(({ action }) => action === "settled").length, 64);
  const upper = await schedulerFixture("upper-cap");
  await orchestrateFlowMultiCursor({ ...upper, maxConcurrent: 1024, execute: async () => {} });
  assert.equal((await loadRun(upper.runId, upper.cwd)).state.status, "completed");
});

test("a capped resource conflict does not hide the remaining disjoint Flow frontier", async () => {
  const cwd = workspace();
  const runId = "bounded-resource-conflict";
  const file = writeDisjointDefinition(cwd, 3);
  const definition = JSON.parse(fs.readFileSync(file, "utf8"));
  definition.steps[1].mutable_resources = definition.steps[0].mutable_resources;
  fs.writeFileSync(file, JSON.stringify(definition));
  await startRun(file, { cwd, runId, params: { subject: "flow-agents#1113" } });
  const actor = { key: "foreign-host", kind: "test" };
  const foreign = await claimReadyStep(runId, {
    cwd, step_id: "step-0", claim_id: "foreign-conflicting", liveness_id: "foreign-live", actor, lease_seconds: 60,
  });
  const executed = [];
  const observation = await orchestrateFlowMultiCursor({
    cwd, runId, actor: { key: "scheduler-host", kind: "test" }, maxConcurrent: 1,
    execute: async ({ claim }) => { executed.push(claim.step_id); },
  });
  assert.deepEqual(executed, ["step-2"]);
  assert.deepEqual(observation.deferredSteps, ["step-1"]);
  assert.deepEqual((await loadRun(runId, cwd)).state.multi_cursor.active_claims, [foreign.claim]);
});

test("slow renewal observation cannot suspend leases while an aborted host is stopping", async () => {
  const input = await schedulerFixture("slow-renewal-observer");
  const controller = new AbortController();
  let notifyRenewing;
  const renewing = new Promise((resolve) => { notifyRenewing = resolve; });
  let confirmed = false;
  let finishObservation;
  const observationFinished = new Promise((resolve) => { finishObservation = resolve; });
  let observations = 0;
  await assert.rejects(orchestrateFlowMultiCursor({
    ...input, signal: controller.signal, renewalIntervalMs: 5, leaseSeconds: 60,
    onEvent: async ({ kind }) => {
      if (kind !== "renewed" || observations++ > 0) return;
      const before = (await loadRun(input.runId, input.cwd)).state.multi_cursor.claim_history.filter(({ action }) => action === "renewed").length;
      notifyRenewing();
      try {
        const during = await waitForRenewal(input, before);
        assert.equal(during.state.multi_cursor.active_claims.length, 1);
        confirmed = true;
      } finally { finishObservation(); }
    },
    execute: async ({ signal }) => {
      await renewing;
      controller.abort();
      assert.ok(signal.aborted);
      await observationFinished;
    },
  }), FlowMultiCursorOrchestrationError);
  assert.ok(confirmed);
  assertUnusedClaimsReleased(await loadRun(input.runId, input.cwd), 1);
});

test("a still-ready claim under an amended definition is released before host dispatch", async () => {
  const cwd = workspace();
  const runId = "claim-definition-drift";
  const file = writeOneStepDefinition(cwd);
  await startRun(file, { cwd, runId, params: { subject: "flow-agents#1113" } });
  const successor = JSON.parse(fs.readFileSync(file, "utf8"));
  successor.version = "2";
  const successorFile = path.join(cwd, "successor.flow.json");
  fs.writeFileSync(successorFile, JSON.stringify(successor));
  let callbacks = 0;
  await assert.rejects(orchestrateFlowMultiCursor({
    cwd, runId, actor: { key: "scheduler-host", kind: "test" },
    identityFactory: (stepId) => {
      amendDefinition(cwd, runId, successorFile);
      return identity(stepId);
    },
    execute: async () => { callbacks += 1; },
  }), (error) => {
    assert.ok(error instanceof FlowMultiCursorOrchestrationError);
    assert.equal(error.observation.definition.version, "1");
    assert.ok(error.observation.finalRunHead);
    return true;
  });
  assert.equal(callbacks, 0);
  const run = await loadRun(runId, cwd);
  assert.equal(run.definition.version, "2");
  assertUnusedClaimsReleased(run, 1);
  assert.ok(run.state.multi_cursor.claim_history.some(({ action, reason }) => action === "released" && reason === "definition-identity-drift"));
});
