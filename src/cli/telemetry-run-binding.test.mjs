import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { createRunCorrelationEnvelope } from "../../build/src/run-correlation.js";

const require = createRequire(import.meta.url);
const currentPointer = require("../../scripts/hooks/lib/current-pointer.js");
const actorIdentity = require("../../scripts/hooks/lib/actor-identity.js");
const {
  resolveTelemetryRunBinding,
} = require("../../scripts/telemetry/run-correlation-binding.js");

function unavailable(reason) {
  return { status: "unavailable", reason };
}

function correlation(correlationId, runId, actorKey) {
  return createRunCorrelationEnvelope({
    correlation_id: correlationId,
    identities: {
      runtime_session: unavailable("runtime session unavailable in fixture"),
      runtime_turn: unavailable("runtime turn unavailable in fixture"),
      flow_run: { status: "present", value: runId },
      flow_step: unavailable("flow step changes during the run"),
      work_item: { status: "present", value: `local:work-item/${runId}` },
      agent: { status: "present", value: actorKey },
      delegation_trace: unavailable("delegation trace unavailable in fixture"),
      delegation_span: unavailable("delegation span unavailable in fixture"),
      terminal_record: unavailable("terminal record unavailable in fixture"),
    },
  });
}

function workspaceFixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-run-binding-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const artifactRoot = path.join(workspace, ".kontourai", "flow-agents");
  fs.mkdirSync(artifactRoot, { recursive: true });
  return { workspace, artifactRoot };
}

function bindRun(fixture, env, runId, correlationId) {
  const resolved = actorIdentity.resolveActorIdentity(env);
  assert(resolved.actor);
  const sessionDir = path.join(fixture.artifactRoot, runId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const envelope = correlation(correlationId, runId, resolved.actor);
  fs.writeFileSync(path.join(sessionDir, "state.json"), `${JSON.stringify({
    schema_version: "1.0",
    task_slug: runId,
    run_correlation: envelope,
    flow_run: { run_id: runId },
    work_item_refs: [`local:work-item/${runId}`],
  }, null, 2)}\n`);
  currentPointer.writePerActorCurrent(fixture.artifactRoot, resolved.actor, {
    schema_version: "1.0",
    active_slug: runId,
    artifact_dir: runId,
    updated_at: "2026-07-24T05:00:00.000Z",
    owner: "fixture",
    source: "builder-start",
    active_agents: [],
    binding_id: correlationId,
  });
  return { envelope, actorKey: resolved.actor };
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
  const bound = bindRun(fixture, env, "run-one", "correlation-one");
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
  const first = bindRun(fixture, firstEnv, "run-one", "correlation-one");
  const second = bindRun(fixture, secondEnv, "run-two", "correlation-two");

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
  bindRun(fixture, env, "run-one", "correlation-one");
  const second = bindRun(fixture, env, "run-two", "correlation-two");

  const result = await resolveTelemetryRunBinding({ cwd: fixture.workspace, env });
  assert.equal(result.run_correlation.correlation_id, "correlation-two");
  assert.notEqual(result.run_correlation.correlation_id, "correlation-one");
  assert.deepEqual(result, {
    run_correlation: second.envelope,
    task_slug: "run-two",
  });
});

test("a substituted task directory cannot supply telemetry correlation", async (t) => {
  const fixture = workspaceFixture(t);
  const env = { FLOW_AGENTS_ACTOR: "runtime-one" };
  bindRun(fixture, env, "run-one", "correlation-one");

  const sessionDir = path.join(fixture.artifactRoot, "run-one");
  const substituteDir = path.join(fixture.artifactRoot, "substitute");
  fs.renameSync(sessionDir, substituteDir);
  fs.symlinkSync(substituteDir, sessionDir, "dir");

  const result = await resolveTelemetryRunBinding({ cwd: fixture.workspace, env });
  assert.equal(result.run_correlation.status, "incomplete");
  assert.doesNotMatch(JSON.stringify(result), /correlation-one/);
});

test("retired, mismatched, and credential-shaped bindings fail closed", async (t) => {
  const fixture = workspaceFixture(t);
  const env = { FLOW_AGENTS_ACTOR: "runtime-one" };
  const bound = bindRun(fixture, env, "run-one", "correlation-one");

  currentPointer.writePerActorCurrent(fixture.artifactRoot, bound.actorKey, {
    schema_version: "1.0",
    active_slug: "run-one",
    artifact_dir: "run-one",
    updated_at: "2026-07-24T05:01:00.000Z",
    owner: "fixture",
    source: "builder-stop",
    active_agents: [],
    binding_id: "correlation-one",
    binding_status: "retired",
    binding_reason: "flow_completed",
  });
  assert.equal(
    (await resolveTelemetryRunBinding({ cwd: fixture.workspace, env })).run_correlation.status,
    "incomplete",
  );

  bindRun(fixture, env, "run-one", "correlation-one");
  const pointerFile = currentPointer.perActorCurrentFile(fixture.artifactRoot, bound.actorKey);
  const pointer = JSON.parse(fs.readFileSync(pointerFile, "utf8"));
  pointer.binding_id = "correlation-other";
  fs.writeFileSync(pointerFile, `${JSON.stringify(pointer, null, 2)}\n`);
  assert.equal(
    (await resolveTelemetryRunBinding({ cwd: fixture.workspace, env })).run_correlation.status,
    "incomplete",
  );

  bindRun(fixture, env, "run-one", "correlation-one");
  const stateFile = path.join(fixture.artifactRoot, "run-one", "state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state.run_correlation.correlation_id = ["github_", "pat_12345678901234567890"].join("");
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  const rejected = await resolveTelemetryRunBinding({ cwd: fixture.workspace, env });
  assert.equal(rejected.run_correlation.status, "incomplete");
  assert.doesNotMatch(JSON.stringify(rejected), /github_pat/);
});
