// Unit tests for src/lib/workflow-process-projection.ts (issue #778): the pure
// workflow-status -> Console ConsoleProcessStatus mapping and blockedReason
// derivation behind the console-process-projection CLI command.
//
// Loaded from the built JS (mirrors src/cli/console-connect-options.test.mjs's
// import-from-build convention, testing a src/lib/ module from src/cli/).
// Run: `npm run test:unit`, or directly after `npm run build`:
//   node --test src/cli/console-process-projection.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import {
  mapWorkflowStatusToConsoleProcessStatus,
  deriveConsoleProcessBlockedReason,
  validateWorkflowStateProjectionSourceShape,
  validateWorkflowHandoffProjectionSourceShape,
  validateWorkflowCritiqueProjectionSourceShape,
  buildWorkflowProcessProjection,
} from "../../build/src/lib/workflow-process-projection.js";

// --- mapWorkflowStatusToConsoleProcessStatus: full status-table coverage (issue #778 AC) ---

const BASE_STATUS_TABLE = [
  ["new", undefined, "not_started"],
  ["planning", "continue", "running"],
  ["planned", "continue", "running"],
  ["in_progress", "continue", "running"],
  ["blocked", "blocked", "blocked"],
  ["verifying", "continue", "running"],
  ["needs_decision", "needs_user", "needs_input"],
  ["not_verified", "needs_user", "needs_input"],
  ["failed", undefined, "failed"],
  ["delivered", "done", "completed"],
  ["canceled", undefined, "cancelled"],
  ["accepted", "done", "completed"],
  ["archived", "done", "completed"],
];

for (const [status, nextActionStatus, expected] of BASE_STATUS_TABLE) {
  test(`mapWorkflowStatusToConsoleProcessStatus: ${status} -> ${expected}`, () => {
    assert.equal(mapWorkflowStatusToConsoleProcessStatus(status, nextActionStatus), expected);
  });
}

test("mapWorkflowStatusToConsoleProcessStatus: verified + next_action.status=continue -> running (not yet terminal)", () => {
  assert.equal(mapWorkflowStatusToConsoleProcessStatus("verified", "continue"), "running");
});

test("mapWorkflowStatusToConsoleProcessStatus: verified + next_action.status=done -> completed", () => {
  assert.equal(mapWorkflowStatusToConsoleProcessStatus("verified", "done"), "completed");
});

test("mapWorkflowStatusToConsoleProcessStatus: a required pending critique overrides a non-terminal status to review_pending", () => {
  assert.equal(mapWorkflowStatusToConsoleProcessStatus("verifying", "continue", "pending", true), "review_pending");
  assert.equal(mapWorkflowStatusToConsoleProcessStatus("in_progress", "continue", "pending", true), "review_pending");
});

test("mapWorkflowStatusToConsoleProcessStatus: a pending critique that is not required does not override", () => {
  assert.equal(mapWorkflowStatusToConsoleProcessStatus("verifying", "continue", "pending", false), "running");
});

test("mapWorkflowStatusToConsoleProcessStatus: a pending required critique never overrides a terminal status", () => {
  assert.equal(mapWorkflowStatusToConsoleProcessStatus("delivered", "done", "pending", true), "completed");
  assert.equal(mapWorkflowStatusToConsoleProcessStatus("failed", undefined, "pending", true), "failed");
  assert.equal(mapWorkflowStatusToConsoleProcessStatus("canceled", undefined, "pending", true), "cancelled");
});

// --- deriveConsoleProcessBlockedReason ---

test("deriveConsoleProcessBlockedReason: blocked prefers handoff.json blockers, joined", () => {
  const reason = deriveConsoleProcessBlockedReason("blocked", {
    nextActionStatus: "blocked",
    nextActionSummary: "generic next-step text",
    workflowStatus: "blocked",
    handoffBlockers: ["Waiting on upstream API", "CI quota exhausted"],
  });
  assert.equal(reason, "Waiting on upstream API; CI quota exhausted");
});

test("deriveConsoleProcessBlockedReason: blocked falls back to next_action.summary when no handoff blockers", () => {
  const reason = deriveConsoleProcessBlockedReason("blocked", {
    nextActionStatus: "blocked",
    nextActionSummary: "Waiting on reviewer sign-off.",
    workflowStatus: "blocked",
    handoffBlockers: [],
  });
  assert.equal(reason, "Waiting on reviewer sign-off.");
});

test("deriveConsoleProcessBlockedReason: blocked is undefined when neither source is available", () => {
  const reason = deriveConsoleProcessBlockedReason("blocked", {
    nextActionStatus: "continue",
    workflowStatus: "blocked",
    handoffBlockers: [],
  });
  assert.equal(reason, undefined);
});

test("deriveConsoleProcessBlockedReason: needs_input sources next_action.summary when next_action.status is needs_user", () => {
  const reason = deriveConsoleProcessBlockedReason("needs_input", {
    nextActionStatus: "needs_user",
    nextActionSummary: "Choose between approach A and approach B.",
    workflowStatus: "needs_decision",
  });
  assert.equal(reason, "Choose between approach A and approach B.");
});

test("deriveConsoleProcessBlockedReason: needs_input falls back to a workflow-status-derived sentence", () => {
  assert.match(
    deriveConsoleProcessBlockedReason("needs_input", { workflowStatus: "needs_decision" }),
    /needs_decision/,
  );
  assert.match(
    deriveConsoleProcessBlockedReason("needs_input", { workflowStatus: "not_verified" }),
    /not_verified/,
  );
});

test("deriveConsoleProcessBlockedReason: review_pending returns a fixed, honest sentence", () => {
  const reason = deriveConsoleProcessBlockedReason("review_pending", {});
  assert.match(reason, /review/i);
  assert.match(reason, /critique\.json/);
});

test("deriveConsoleProcessBlockedReason: clears (undefined) for every non-interactive status, mirroring console#236's own clearing rule", () => {
  for (const status of ["not_started", "running", "completed", "failed", "cancelled", "paused", "waiting"]) {
    assert.equal(
      deriveConsoleProcessBlockedReason(status, {
        nextActionStatus: "blocked",
        nextActionSummary: "stale reason that must not leak",
        workflowStatus: "blocked",
        handoffBlockers: ["stale blocker that must not leak"],
      }),
      undefined,
      `status=${status} must not carry a blockedReason`,
    );
  }
});

// --- source-shape validation ---

test("validateWorkflowStateProjectionSourceShape: accepts a minimal valid state.json", () => {
  const state = validateWorkflowStateProjectionSourceShape({
    schema_version: "1.0",
    task_slug: "demo",
    status: "in_progress",
    phase: "execution",
    updated_at: "2026-07-20T10:00:00Z",
    next_action: { status: "continue", summary: "keep going" },
  });
  assert.equal(state.task_slug, "demo");
  assert.equal(state.status, "in_progress");
});

test("validateWorkflowStateProjectionSourceShape: rejects an unknown status", () => {
  assert.throws(() => validateWorkflowStateProjectionSourceShape({
    schema_version: "1.0",
    task_slug: "demo",
    status: "not-a-real-status",
    phase: "execution",
    next_action: { status: "continue", summary: "x" },
  }));
});

test("validateWorkflowHandoffProjectionSourceShape: accepts blockers array or its absence", () => {
  const withBlockers = validateWorkflowHandoffProjectionSourceShape({
    task_slug: "demo",
    summary: "s",
    blockers: ["a", "b"],
  });
  assert.deepEqual(withBlockers.blockers, ["a", "b"]);
  const withoutBlockers = validateWorkflowHandoffProjectionSourceShape({ task_slug: "demo", summary: "s" });
  assert.equal(withoutBlockers.blockers, undefined);
});

test("validateWorkflowCritiqueProjectionSourceShape: accepts pending/required", () => {
  const critique = validateWorkflowCritiqueProjectionSourceShape({
    task_slug: "demo",
    status: "pending",
    required: true,
  });
  assert.equal(critique.status, "pending");
  assert.equal(critique.required, true);
});

// --- envelope shape / determinism ---

test("buildWorkflowProcessProjection: emits an inert, non-authoritative kontour.console.projection envelope", () => {
  const source = {
    path: "/tmp/x/session-a/state.json",
    relativePath: "session-a/state.json",
    slug: "session-a",
    state: validateWorkflowStateProjectionSourceShape({
      schema_version: "1.0",
      task_slug: "session-a",
      status: "blocked",
      phase: "execution",
      updated_at: "2026-07-20T10:00:00Z",
      next_action: { status: "blocked", summary: "waiting on X" },
    }),
    handoff: validateWorkflowHandoffProjectionSourceShape({
      task_slug: "session-a",
      summary: "blocked",
      blockers: ["waiting on X"],
    }),
  };
  const envelope = buildWorkflowProcessProjection([source], {
    scope: { kind: "repo", id: "demo" },
    generatedAt: "2026-07-20T12:00:00Z",
  });
  assert.equal(envelope.schema, "kontour.console.projection");
  assert.equal(envelope.processes.length, 1);
  const process = envelope.processes[0];
  assert.equal(process.nonAuthority, true);
  assert.equal(process.status, "blocked");
  assert.equal(process.blockedReason, "waiting on X");
});

test("buildWorkflowProcessProjection: output is deterministic across runs with the same generatedAt", () => {
  const source = {
    path: "/tmp/x/session-a/state.json",
    relativePath: "session-a/state.json",
    slug: "session-a",
    state: validateWorkflowStateProjectionSourceShape({
      schema_version: "1.0",
      task_slug: "session-a",
      status: "in_progress",
      phase: "execution",
      next_action: { status: "continue", summary: "keep going" },
    }),
  };
  const options = { scope: { kind: "repo", id: "demo" }, generatedAt: "2026-07-20T12:00:00Z" };
  const first = JSON.stringify(buildWorkflowProcessProjection([source], options));
  const second = JSON.stringify(buildWorkflowProcessProjection([source], options));
  assert.equal(first, second);
});
