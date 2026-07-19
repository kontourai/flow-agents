import assert from "node:assert/strict";
import test from "node:test";

import {
  assertIssuedPublishChangeAction,
  issuePublishChangeAction,
} from "../../build/src/publish-change-operation-authority.js";

const input = (body) => ({
  binding: {
    run_id: "kontourai-flow-140",
    definition_id: "builder.build",
    definition_version: "1.1",
    step_id: "pr-open",
    gate_ids: ["pr-open-gate"],
    gate_visit_id: "a".repeat(64),
  },
  provider: {
    role: "ChangeProvider",
    kind: "github",
    repository: { owner: "kontourai", name: "flow" },
    capabilities: ["change.create", "change.observe"],
    executor: "gh-cli",
  },
  actor: "codex:test",
  intent: {
    title: "feat(runtime): authorize bounded retry epochs",
    body,
    base_ref: "main",
    head_ref: "agent/blocked-run-recovery-140",
    head_sha: "b".repeat(40),
  },
});

test("publish-change authority accepts and revalidates normal multiline Markdown bodies", () => {
  const action = issuePublishChangeAction(input("## Summary\n\n- first\n- second\n"));
  assert.equal(action.intent.body, "## Summary\n\n- first\n- second\n");
  assert.deepEqual(assertIssuedPublishChangeAction(action), action);
});

test("publish-change authority still rejects carriage returns and other control characters", () => {
  assert.throws(() => issuePublishChangeAction(input("first\r\nsecond")), /rejected intent\.body/);
  assert.throws(() => issuePublishChangeAction(input("first\u0000second")), /rejected intent\.body/);
});

test("publish-change authority bounds bodies by UTF-8 bytes", () => {
  assert.throws(() => issuePublishChangeAction(input("é".repeat(32_769))), /rejected intent\.body/);
});
