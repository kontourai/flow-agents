import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { startBuilderFlowSession, syncBuilderFlowSession } from "../../build/src/builder-flow-runtime.js";
import { performLocalClaim } from "../../build/src/cli/assignment-provider.js";
import { cancelRun } from "@kontourai/flow";

const require = createRequire(import.meta.url);
const currentPointer = require("../../scripts/hooks/lib/current-pointer.js");
const actorIdentity = require("../../scripts/hooks/lib/actor-identity.js");
const {
  resolveTelemetryRunBinding,
} = require("../../scripts/telemetry/run-correlation-binding.js");

function workspaceFixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-run-binding-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const artifactRoot = path.join(workspace, ".kontourai", "flow-agents");
  fs.mkdirSync(artifactRoot, { recursive: true });
  fs.writeFileSync(path.join(workspace, "package.json"), '{"name":"telemetry-run-binding-fixture","private":true}\n');
  return { workspace, artifactRoot };
}

async function bindRun(fixture, env, runId) {
  const resolved = actorIdentity.resolveActorIdentity(env);
  assert(resolved.actor);
  const sessionDir = path.join(fixture.artifactRoot, runId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "state.json"), `${JSON.stringify({
    schema_version: "1.0",
    task_slug: runId,
    status: "planned",
    phase: "planning",
    updated_at: "2026-07-24T05:00:00.000Z",
    work_item_refs: [`local:work-item/${runId}`],
    next_action: { status: "continue", summary: "Start the telemetry fixture." },
  }, null, 2)}\n`);
  performLocalClaim(fixture.artifactRoot, runId, resolved.actorStruct, {
    ttlSeconds: 1800,
    actorKey: resolved.actor,
    branch: `fixture/${runId}`,
    artifactDir: runId,
    workItemRef: `local:work-item/${runId}`,
    reason: "telemetry run-binding fixture",
  });
  const previous = process.env.FLOW_AGENTS_ACTOR;
  process.env.FLOW_AGENTS_ACTOR = resolved.actor;
  try {
    const started = await startBuilderFlowSession({ sessionDir });
    assert.equal(started.run.correlation.status, "present");
    return { envelope: started.run.correlation.envelope, actorKey: resolved.actor };
  } finally {
    if (previous === undefined) delete process.env.FLOW_AGENTS_ACTOR;
    else process.env.FLOW_AGENTS_ACTOR = previous;
  }
}

test("telemetry binding is explicitly incomplete before Builder activation", async (t) => {
  const fixture = workspaceFixture(t);
  const result = await resolveTelemetryRunBinding({
    cwd: fixture.workspace,
    env: { FLOW_AGENTS_ACTOR: "runtime-one" },
  });
  assert.deepEqual(Object.keys(result), ["run_correlation"]);
  assert.equal(result.run_correlation.status, "incomplete");
  assert.match(result.run_correlation.reason, /no authenticated Builder run/i);
});

test("telemetry binding returns the exact actor-bound envelope and slug", async (t) => {
  const fixture = workspaceFixture(t);
  const env = { FLOW_AGENTS_ACTOR: "runtime-one" };
  const bound = await bindRun(fixture, env, "run-one");
  const result = await resolveTelemetryRunBinding({ cwd: fixture.workspace, env });
  assert.deepEqual(result, {
    run_correlation: bound.envelope,
    task_slug: "run-one",
  });
});

test("two actors in one workspace cannot cross-stamp", async (t) => {
  const fixture = workspaceFixture(t);
  const firstEnv = { FLOW_AGENTS_ACTOR: "runtime-one" };
  const secondEnv = { FLOW_AGENTS_ACTOR: "runtime-two" };
  const first = await bindRun(fixture, firstEnv, "run-one");
  const second = await bindRun(fixture, secondEnv, "run-two");

  assert.deepEqual(
    await resolveTelemetryRunBinding({ cwd: fixture.workspace, env: firstEnv }),
    { run_correlation: first.envelope, task_slug: "run-one" },
  );
  assert.deepEqual(
    await resolveTelemetryRunBinding({ cwd: fixture.workspace, env: secondEnv }),
    { run_correlation: second.envelope, task_slug: "run-two" },
  );
});

test("a sequential Builder binding replaces rather than reuses correlation", async (t) => {
  const fixture = workspaceFixture(t);
  const env = { FLOW_AGENTS_ACTOR: "runtime-one" };
  const first = await bindRun(fixture, env, "run-one");
  const second = await bindRun(fixture, env, "run-two");

  const result = await resolveTelemetryRunBinding({ cwd: fixture.workspace, env });
  assert.equal(result.run_correlation.correlation_id, second.envelope.correlation_id);
  assert.notEqual(result.run_correlation.correlation_id, first.envelope.correlation_id);
  assert.deepEqual(result, {
    run_correlation: second.envelope,
    task_slug: "run-two",
  });
});

test("a substituted task directory cannot supply telemetry correlation", async (t) => {
  const fixture = workspaceFixture(t);
  const env = { FLOW_AGENTS_ACTOR: "runtime-one" };
  const bound = await bindRun(fixture, env, "run-one");

  const sessionDir = path.join(fixture.artifactRoot, "run-one");
  const substituteDir = path.join(fixture.artifactRoot, "substitute");
  fs.renameSync(sessionDir, substituteDir);
  fs.symlinkSync(substituteDir, sessionDir, "dir");

  const result = await resolveTelemetryRunBinding({ cwd: fixture.workspace, env });
  assert.equal(result.run_correlation.status, "incomplete");
  assert.doesNotMatch(JSON.stringify(result), new RegExp(bound.envelope.correlation_id));
});

test("retired, mismatched, and credential-shaped bindings fail closed", async (t) => {
  const fixture = workspaceFixture(t);
  const env = { FLOW_AGENTS_ACTOR: "runtime-one" };
  const bound = await bindRun(fixture, env, "run-one");

  currentPointer.writePerActorCurrent(fixture.artifactRoot, bound.actorKey, {
    schema_version: "1.0",
    active_slug: "run-one",
    artifact_dir: "run-one",
    updated_at: "2026-07-24T05:01:00.000Z",
    owner: "fixture",
    source: "builder-stop",
    active_agents: [],
    binding_id: bound.envelope.correlation_id,
    binding_status: "retired",
    binding_reason: "flow_completed",
  });
  assert.equal(
    (await resolveTelemetryRunBinding({ cwd: fixture.workspace, env })).run_correlation.status,
    "incomplete",
  );

  await bindRun(fixture, env, "run-one");
  const pointerFile = currentPointer.perActorCurrentFile(fixture.artifactRoot, bound.actorKey);
  const pointer = JSON.parse(fs.readFileSync(pointerFile, "utf8"));
  pointer.binding_id = "correlation-other";
  fs.writeFileSync(pointerFile, `${JSON.stringify(pointer, null, 2)}\n`);
  assert.equal(
    (await resolveTelemetryRunBinding({ cwd: fixture.workspace, env })).run_correlation.status,
    "incomplete",
  );

  await bindRun(fixture, env, "run-one");
  const stateFile = path.join(fixture.artifactRoot, "run-one", "state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state.run_correlation.correlation_id = ["github_", "pat_12345678901234567890"].join("");
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  const rejected = await resolveTelemetryRunBinding({ cwd: fixture.workspace, env });
  assert.equal(rejected.run_correlation.status, "incomplete");
  assert.doesNotMatch(JSON.stringify(rejected), /github_pat/);
});

test("only terminal capture may consume an exact actor retirement handoff", async (t) => {
  const fixture = workspaceFixture(t);
  const env = { FLOW_AGENTS_ACTOR: "runtime-one" };
  const bound = await bindRun(fixture, env, "run-one");
  await cancelRun("run-one", {
    cwd: fixture.workspace,
    reason: "terminal telemetry fixture",
    authority: {
      kind: "operator_request",
      actor: "fixture",
      request_ref: "fixture://telemetry-terminal",
      requested_at: "2026-07-24T05:01:00.000Z",
    },
    at: "2026-07-24T05:01:00.000Z",
  });
  await syncBuilderFlowSession({ sessionDir: path.join(fixture.artifactRoot, "run-one") });
  const stateFile = path.join(fixture.artifactRoot, "run-one", "state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));

  assert.equal(
    (await resolveTelemetryRunBinding({ cwd: fixture.workspace, env })).run_correlation.status,
    "incomplete",
  );
  assert.deepEqual(
    await resolveTelemetryRunBinding({
      cwd: fixture.workspace,
      env,
      terminalCapture: true,
      includeSidecars: true,
    }),
    {
      run_correlation: bound.envelope,
      task_slug: "run-one",
      sidecars: {
        state,
        acceptance: null,
        critique: null,
        agent_events: [],
      },
    },
  );

  state.flow_run.status = "blocked";
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  assert.equal(
    (await resolveTelemetryRunBinding({
      cwd: fixture.workspace,
      env,
      terminalCapture: true,
    })).run_correlation.status,
    "incomplete",
  );
});

test("sidecar snapshots include only delegation events stamped with the exact run envelope", async (t) => {
  const fixture = workspaceFixture(t);
  const env = { FLOW_AGENTS_ACTOR: "runtime-one" };
  const bound = await bindRun(fixture, env, "run-one");
  const agentsDir = path.join(fixture.artifactRoot, "run-one", "agents");
  const trustedDir = path.join(agentsDir, "trusted");
  const unboundDir = path.join(agentsDir, "unbound");
  fs.mkdirSync(trustedDir, { recursive: true });
  fs.mkdirSync(unboundDir, { recursive: true });
  fs.writeFileSync(path.join(trustedDir, "events.jsonl"), `${JSON.stringify({
    agent_id: "trusted",
    kind: "delegation",
    role: "delegate-implementation",
    model: "fixture-model",
    run_correlation: bound.envelope,
  })}\n`);
  fs.writeFileSync(path.join(unboundDir, "events.jsonl"), `${JSON.stringify({
    agent_id: "unbound",
    kind: "delegation",
    role: "delegate-implementation",
    model: "fixture-model",
    run_correlation: {
      status: "incomplete",
      reason: "fixture event is not bound",
    },
  })}\n`);

  const result = await resolveTelemetryRunBinding({
    cwd: fixture.workspace,
    env,
    includeSidecars: true,
  });
  assert.deepEqual(result.sidecars.agent_events.map((event) => event.agent_id), ["trusted"]);
});

test("agent event staging is skipped when no current pointer authorizes the target", (t) => {
  const fixture = workspaceFixture(t);
  let staged = false;
  const writes = currentPointer.updateCurrentPointersForBinding(
    fixture.artifactRoot,
    "runtime-one",
    "run-one",
    (payload) => payload,
    () => {
      staged = true;
      return { rollback() {} };
    },
  );
  assert.equal(writes, 0);
  assert.equal(staged, false);
});
