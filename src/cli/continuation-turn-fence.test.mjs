import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

import { definitionDigest } from "@kontourai/flow";

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(import.meta.dirname, "..", "..");
const authority = require("../../scripts/hooks/lib/continuation-turn-authority.js");
const fence = require("../../scripts/hooks/continuation-turn-fence.js");
const stopGoalFit = require("../../scripts/hooks/stop-goal-fit.js");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "continuation-turn-fence-"));
  const runId = "turn-fence";
  const sessionDir = path.join(root, ".kontourai", "flow-agents", runId);
  const runDir = path.join(root, ".kontourai", "flow", "runs", runId);
  const locksDir = path.join(sessionDir, "continuation-driver", "locks");
  fs.mkdirSync(locksDir, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Fixture\n");

  const definition = {
    id: "builder.build",
    version: "1.0",
    steps: [{ id: "plan", next: "execute" }, { id: "execute" }],
    gates: {
      "plan-gate": { step: "plan", expects: [] },
      "execute-gate": { step: "execute", expects: [] },
    },
  };
  const stateFile = path.join(runDir, "state.json");
  fs.writeFileSync(path.join(runDir, "definition.json"), `${JSON.stringify(definition)}\n`);
  fs.writeFileSync(stateFile, `${JSON.stringify({
    schema_version: "0.1",
    run_id: runId,
    definition_id: definition.id,
    definition_version: definition.version,
    subject: `local:work-item/${runId}`,
    status: "active",
    current_step: "plan",
    params: { subject: `local:work-item/${runId}` },
    gate_outcomes: [],
    transitions: [],
    lifecycle: [],
    exceptions: [],
  })}\n`);
  fs.writeFileSync(path.join(sessionDir, "state.json"), `${JSON.stringify({
    schema_version: "1.0",
    task_slug: runId,
    status: "planned",
    phase: "planning",
    branch: `agent/test/${runId}`,
    updated_at: new Date().toISOString(),
    flow_run: {
      status: "active",
      run_id: runId,
      definition_id: definition.id,
      definition_version: definition.version,
      current_step: "plan",
      run_ref: path.relative(root, runDir),
      open_gate_ids: ["plan-gate"],
    },
    next_action: { status: "done", summary: "The issued gate is complete." },
  })}\n`);

  const actor = { runtime: "test", session_id: "turn-fence", host: "localhost", human: null };
  const assignmentDir = path.join(root, ".kontourai", "flow-agents", "assignment");
  fs.mkdirSync(assignmentDir, { recursive: true });
  fs.writeFileSync(path.join(assignmentDir, `${runId}.json`), JSON.stringify({
    schema_version: "1.0",
    role: "AssignmentClaimRecord",
    subject_id: runId,
    actor,
    actor_key: "turn-fence-actor",
    artifact_dir: runId,
    status: "claimed",
  }));

  const lock = {
    schema_version: "1.0",
    pid: process.pid,
    token: "turn-fence-lock",
    created_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(locksDir, `${lock.pid}-${lock.token}.lock`), `${JSON.stringify(lock)}\n`);
  fs.writeFileSync(path.join(sessionDir, "continuation-driver", "state.json"), JSON.stringify({
    schema_version: "1.0",
    run_id: runId,
    definition_id: definition.id,
    max_turns: 3,
    adapter_command_identity: "fixture-adapter",
    status: "active",
    turns_started: 1,
    active_turn_step: "plan",
    pending_barrier: null,
  }));

  const issued = authority.issueActiveTurnAuthority({
    sessionDir,
    runId,
    definitionId: definition.id,
    definitionVersion: definition.version,
    definitionDigest: definitionDigest(definition),
    currentStep: "plan",
    iteration: 1,
    maxTurns: 3,
    adapterCommandIdentity: "fixture-adapter",
    assignmentActor: "turn-fence-actor",
    assignmentActorStruct: actor,
    lock,
    timeoutMs: 60_000,
  });
  const missionFile = path.join(sessionDir, "continuation-driver", "state.json");
  const mission = JSON.parse(fs.readFileSync(missionFile, "utf8"));
  fs.writeFileSync(missionFile, JSON.stringify({
    ...mission,
    active_turn_definition_version: definition.version,
    active_turn_definition_digest: definitionDigest(definition),
    active_turn_public_key_digest: issued.publicKeyDigest,
  }));

  return { root, runId, sessionDir, stateFile, issued };
}

function fenceEnv(value) {
  return {
    ...process.env,
    FLOW_AGENTS_CONTINUATION_RUN_ID: value.runId,
    FLOW_AGENTS_CONTINUATION_TURN_SECRET: value.issued.turnSecret,
  };
}

async function withFenceEnv(value, callback) {
  const priorRunId = process.env.FLOW_AGENTS_CONTINUATION_RUN_ID;
  const priorSecret = process.env.FLOW_AGENTS_CONTINUATION_TURN_SECRET;
  Object.assign(process.env, {
    FLOW_AGENTS_CONTINUATION_RUN_ID: value.runId,
    FLOW_AGENTS_CONTINUATION_TURN_SECRET: value.issued.turnSecret,
  });
  try {
    return await callback();
  } finally {
    if (priorRunId === undefined) delete process.env.FLOW_AGENTS_CONTINUATION_RUN_ID;
    else process.env.FLOW_AGENTS_CONTINUATION_RUN_ID = priorRunId;
    if (priorSecret === undefined) delete process.env.FLOW_AGENTS_CONTINUATION_TURN_SECRET;
    else process.env.FLOW_AGENTS_CONTINUATION_TURN_SECRET = priorSecret;
  }
}

function runAdapter(name, event, value, phase = "post") {
  const hookId = `continuation-turn-fence-${phase}`;
  const policyArgs = name === "codex"
    ? [hookId, "continuation-turn-fence.js", "default"]
    : [event, hookId, "continuation-turn-fence.js", "default"];
  const result = spawnSync(process.execPath, [
    path.join(packageRoot, "scripts", "hooks", `${name}-hook-adapter.js`),
    ...policyArgs,
  ], {
    cwd: value.root,
    env: fenceEnv(value),
    input: JSON.stringify({ hook_event_name: event, cwd: value.root }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(result.stdout.trim(), "", `${name} emitted no adapter result; stderr: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test("signed turn remains active while canonical Flow stays on its issued step", async () => {
  const value = fixture();
  try {
    await withFenceEnv(value, async () => {
      const result = await fence.run(JSON.stringify({ hook_event_name: "PostToolUse", cwd: value.root }));
      assert.equal(result.exitCode, 0);
    });
  } finally {
    value.issued.cleanup();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("all runtime adapters return control after canonical Flow advances", async () => {
  const value = fixture();
  try {
    const state = JSON.parse(fs.readFileSync(value.stateFile, "utf8"));
    fs.writeFileSync(value.stateFile, `${JSON.stringify({ ...state, current_step: "execute" })}\n`);
    await withFenceEnv(value, async () => {
      const analyzed = await stopGoalFit.analyze(value.root);
      assert.equal(analyzed.blocking, false, JSON.stringify(analyzed.warnings));
    });

    for (const runtime of ["claude", "codex"]) {
      for (const [phase, event] of [["pre", "PreToolUse"], ["post", "PostToolUse"]]) {
        const output = runAdapter(runtime, event, value, phase);
        assert.equal(output.continue, false, `${runtime} ${phase} must end the adapter turn`);
        assert.match(output.stopReason, /RETURN_CONTROL/);
      }
    }
    for (const [runtime, before, after] of [
      ["opencode", "tool.execute.before", "tool.execute.after"],
      ["pi", "tool_call", "tool_result"],
    ]) {
      for (const [phase, event] of [["pre", before], ["post", after]]) {
        const output = runAdapter(runtime, event, value, phase);
        assert.equal(output.returnControl, true, `${runtime} ${phase} must request native abort`);
        assert.match(output.reason, /RETURN_CONTROL/);
      }
    }
    const receipt = authority.readActiveTurnBoundary({
      sessionDir: value.sessionDir,
      runId: value.runId,
      turnSecret: value.issued.turnSecret,
    });
    assert.equal(receipt.valid, true);
    assert.equal(receipt.record.issued_step, "plan");
    assert.equal(receipt.record.canonical_step, "execute");
  } finally {
    value.issued.cleanup();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("a terminal canonical Flow state produces a verified turn-boundary receipt", async () => {
  const value = fixture();
  try {
    const state = JSON.parse(fs.readFileSync(value.stateFile, "utf8"));
    fs.writeFileSync(value.stateFile, `${JSON.stringify({
      ...state,
      status: "completed",
      current_step: "execute",
    })}\n`);
    const workflowStateFile = path.join(value.sessionDir, "state.json");
    const workflowState = JSON.parse(fs.readFileSync(workflowStateFile, "utf8"));
    fs.writeFileSync(workflowStateFile, `${JSON.stringify({
      ...workflowState,
      flow_run: {
        ...workflowState.flow_run,
        status: "completed",
        current_step: "execute",
        open_gate_ids: [],
      },
    })}\n`);

    await withFenceEnv(value, async () => {
      const analyzed = await stopGoalFit.analyze(value.root);
      assert.equal(analyzed.blocking, false, JSON.stringify(analyzed.warnings));
      const result = await fence.run(JSON.stringify({ hook_event_name: "PostToolUse", cwd: value.root }));
      assert.equal(result.exitCode, 3);
      assert.match(result.stderr, /terminal status "completed"/);
    });

    const receipt = authority.readActiveTurnBoundary({
      sessionDir: value.sessionDir,
      runId: value.runId,
      turnSecret: value.issued.turnSecret,
    });
    assert.equal(receipt.valid, true);
    assert.equal(receipt.record.issued_step, "plan");
    assert.equal(receipt.record.canonical_step, "execute");
    assert.equal(receipt.record.canonical_status, "completed");
  } finally {
    value.issued.cleanup();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("ordinary sessions without signed turn authority retain current behavior", () => {
  const value = fixture();
  try {
    const result = spawnSync(process.execPath, [
      path.join(packageRoot, "scripts", "hooks", "continuation-turn-fence.js"),
    ], {
      cwd: value.root,
      env: {
        ...process.env,
        FLOW_AGENTS_CONTINUATION_RUN_ID: "",
        FLOW_AGENTS_CONTINUATION_TURN_SECRET: "",
      },
      input: JSON.stringify({ hook_event_name: "PostToolUse", cwd: value.root }),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    value.issued.cleanup();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("a signed turn denies a subsequent pre-tool call after the boundary", async () => {
  const value = fixture();
  try {
    const state = JSON.parse(fs.readFileSync(value.stateFile, "utf8"));
    fs.writeFileSync(value.stateFile, `${JSON.stringify({ ...state, current_step: "execute" })}\n`);
    await withFenceEnv(value, async () => {
      const result = await fence.run(JSON.stringify({ hook_event_name: "PreToolUse", cwd: value.root }));
      assert.equal(result.exitCode, 3);
      assert.match(result.stderr, /RETURN_CONTROL/);
    });
  } finally {
    value.issued.cleanup();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("a hard issued-gate acceptance gap remains repairable before the boundary", async () => {
  const value = fixture();
  const acceptanceFile = path.join(value.sessionDir, "acceptance.json");
  try {
    const state = JSON.parse(fs.readFileSync(value.stateFile, "utf8"));
    fs.writeFileSync(value.stateFile, `${JSON.stringify({ ...state, current_step: "execute" })}\n`);
    fs.writeFileSync(acceptanceFile, `${JSON.stringify({
      schema_version: "1.0",
      criteria: [{ id: "plan-contract", status: "pending", description: "Plan contract remains malformed." }],
    })}\n`);
    const pendingBytes = fs.readFileSync(acceptanceFile);

    await withFenceEnv(value, async () => {
      const analyzed = await stopGoalFit.analyze(value.root);
      assert.equal(analyzed.blocking, true);
      assert.match(analyzed.warnings.join("\n"), /sidecar validation/);
      const repair = await fence.run(JSON.stringify({ hook_event_name: "PreToolUse", cwd: value.root }));
      assert.equal(repair.exitCode, 0, "the existing hard-block repair path must remain available");
    });
    assert.deepEqual(fs.readFileSync(acceptanceFile), pendingBytes, "the pre-tool fence never mutates the artifact it guards");

    fs.writeFileSync(acceptanceFile, `${JSON.stringify({
      schema_version: "1.0",
      task_slug: value.runId,
      criteria: [{ id: "plan-contract", status: "pass", description: "Plan contract is valid." }],
      goal_fit: { status: "pass", summary: "Plan contract repaired." },
    })}\n`);
    await withFenceEnv(value, async () => {
      const complete = await fence.run(JSON.stringify({ hook_event_name: "PreToolUse", cwd: value.root }));
      assert.equal(complete.exitCode, 3, "repair completion returns control before next-gate work");
    });
  } finally {
    value.issued.cleanup();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});
