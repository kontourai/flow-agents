import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main as mergeChangeMain } from "../../build/src/cli/merge-change.js";
import { issueMergeChangeAction } from "../../build/src/merge-change-operation-authority.js";

const SHA = "a".repeat(40);
const provider = { role: "ChangeProvider", kind: "github", repository: { owner: "kontourai", name: "flow-agents" }, capabilities: ["change.create", "change.observe", "change.merge"], executor: "gh-cli" };
const binding = { run_id: "merge-transaction-fixture", definition_id: "builder.build", definition_version: "1.3", step_id: "done", gate_ids: ["learn-gate"], gate_visit_id: "f".repeat(64) };

function action(terminalHead = SHA) {
  return issueMergeChangeAction({
    binding,
    provider,
    assignment_actor: "codex:fixture:Kontour",
    expected_provider_actor: "fixture",
    intent: { strategy: "squash", change_number: 1000, base_ref: "main", head_ref: "fixture", terminal_head_sha: terminalHead },
  });
}

function mergedObservation(issued, observedAt) {
  return {
    schema_version: "1.0",
    operation: "merge-change",
    binding: issued.binding,
    repository: issued.repository,
    intent: issued.intent,
    provider: { kind: "github", configuration_id: issued.provider.configuration_id, adapter: "github-gh-cli" },
    assignment_actor: issued.assignment_actor,
    provider_actor: "fixture",
    state: "merged",
    merge_sha: "c".repeat(40),
    observed_at: observedAt,
  };
}

function fixtureSession() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-merge-transaction-"));
  const sessionDir = path.join(root, ".kontourai", "flow-agents", binding.run_id);
  fs.mkdirSync(sessionDir, { recursive: true });
  return { root, sessionDir, lockDir: path.join(root, ".kontourai", "flow-agents", "assignment", `.${binding.run_id}.lockdir`) };
}

async function runExecute(sessionDir, dependencies) {
  const originalError = console.error;
  console.error = () => {};
  try {
    return await mergeChangeMain(["execute", "--session-dir", sessionDir, "--strategy", "squash", "--authorization-file", path.join(sessionDir, "signed-merge-authorization.json")], {
      authorizeOperation: () => ({ run_id: binding.run_id, operation_status: "applied", completion: {} }),
      ...dependencies,
    });
  } finally {
    console.error = originalError;
  }
}

test("session-bound merge execution holds its subject lock across provider mutation and revalidates afterward", async () => {
  const fixture = fixtureSession();
  const issued = action();
  const changed = action("b".repeat(40));
  let actionReads = 0;
  try {
    const result = await runExecute(fixture.sessionDir, {
      provider,
      currentAction: async () => (++actionReads === 1 ? issued : changed),
      executeProvider: async () => {
        assert.equal(fs.existsSync(fixture.lockDir), true, "provider mutation must remain under the session subject lock");
        return mergedObservation(issued, "2026-07-26T00:00:00.000Z");
      },
    });
    assert.equal(result, 1);
    assert.equal(actionReads, 2, "the action must be re-derived after provider mutation");
    assert.equal(fs.existsSync(path.join(fixture.sessionDir, "merge-change.result.json")), false, "a changed action must not persist the provider result");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("session-bound merge execution reobserves a forged persisted merged result", async () => {
  const fixture = fixtureSession();
  const issued = action();
  let providerCalls = 0;
  try {
    // This payload has a valid action id and valid observation shape, so only a
    // fresh authenticated provider read can distinguish it from a real replay.
    fs.writeFileSync(path.join(fixture.sessionDir, "merge-change.result.json"), `${JSON.stringify({ action: issued, observation: mergedObservation(issued, "2026-07-26T00:00:00.000Z") })}\n`);
    const result = await runExecute(fixture.sessionDir, {
      provider,
      currentAction: async () => issued,
      executeProvider: async () => {
        providerCalls += 1;
        return mergedObservation(issued, "2026-07-26T00:01:00.000Z");
      },
    });
    assert.equal(result, 0);
    assert.equal(providerCalls, 1, "persisted merged state is not merge authority");
    const persisted = JSON.parse(fs.readFileSync(path.join(fixture.sessionDir, "merge-change.result.json"), "utf8"));
    assert.equal(persisted.observation.observed_at, "2026-07-26T00:01:00.000Z", "only the fresh provider observation is persisted");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("session-bound merge execution refuses terminal validation before provider invocation", async () => {
  const fixture = fixtureSession();
  let providerCalls = 0;
  try {
    const result = await runExecute(fixture.sessionDir, {
      provider,
      currentAction: async () => { throw new Error("terminal delivery refused"); },
      executeProvider: async () => {
        providerCalls += 1;
        return mergedObservation(action(), "2026-07-26T00:00:00.000Z");
      },
    });
    assert.equal(result, 1);
    assert.equal(providerCalls, 0, "terminal refusal must happen before provider invocation");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("session-bound merge execution consumes signed authorization under the lock before provider mutation", async () => {
  const fixture = fixtureSession();
  const issued = action();
  let providerCalls = 0;
  try {
    const result = await runExecute(fixture.sessionDir, {
      provider,
      currentAction: async () => issued,
      authorizeOperation: (_context, observed, file) => {
        assert.equal(fs.existsSync(fixture.lockDir), true, "authority consumption must occur under the subject lock");
        assert.equal(observed.action_id, issued.action_id);
        assert.match(file, /signed-merge-authorization\.json$/);
        return { run_id: binding.run_id, operation_status: "replayed", completion: {} };
      },
      executeProvider: async () => {
        providerCalls += 1;
        return mergedObservation(issued, "2026-07-26T00:00:00.000Z");
      },
    });
    assert.equal(result, 0);
    assert.equal(providerCalls, 1, "an exact replay may retry only the same action");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("merge execution requires a signed authorization before it can reach the provider", async () => {
  const fixture = fixtureSession();
  let providerCalls = 0;
  try {
    const originalError = console.error;
    console.error = () => {};
    let result;
    try {
      result = await mergeChangeMain(["execute", "--session-dir", fixture.sessionDir, "--strategy", "squash"], {
        provider,
        currentAction: async () => action(),
        executeProvider: async () => { providerCalls += 1; return mergedObservation(action(), "2026-07-26T00:00:00.000Z"); },
      });
    } finally { console.error = originalError; }
    assert.equal(result, 1);
    assert.equal(providerCalls, 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
