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
  hasUnresolvedLiveCritique,
  filterCritiquesForSlug,
  validateWorkflowStateProjectionSourceShape,
  validateWorkflowHandoffProjectionSourceShape,
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

test("mapWorkflowStatusToConsoleProcessStatus: an unresolved bundle critique overrides a non-terminal status to review_pending", () => {
  assert.equal(mapWorkflowStatusToConsoleProcessStatus("verifying", "continue", true), "review_pending");
  assert.equal(mapWorkflowStatusToConsoleProcessStatus("in_progress", "continue", true), "review_pending");
});

test("mapWorkflowStatusToConsoleProcessStatus: no unresolved critique does not override", () => {
  assert.equal(mapWorkflowStatusToConsoleProcessStatus("verifying", "continue", false), "running");
  assert.equal(mapWorkflowStatusToConsoleProcessStatus("verifying", "continue", undefined), "running");
});

test("mapWorkflowStatusToConsoleProcessStatus: an unresolved critique never overrides a terminal status", () => {
  assert.equal(mapWorkflowStatusToConsoleProcessStatus("delivered", "done", true), "completed");
  assert.equal(mapWorkflowStatusToConsoleProcessStatus("failed", undefined, true), "failed");
  assert.equal(mapWorkflowStatusToConsoleProcessStatus("canceled", undefined, true), "cancelled");
});

// --- hasUnresolvedLiveCritique (issue #778 review finding 1: reads trust.bundle-shaped
// critique claims, i.e. critiquesFromBundle() output, never critique.json) ---

test("hasUnresolvedLiveCritique: a live (non-superseded) fail/not_verified critique is unresolved", () => {
  assert.equal(hasUnresolvedLiveCritique([{ verdict: "fail" }]), true);
  assert.equal(hasUnresolvedLiveCritique([{ verdict: "not_verified" }]), true);
});

test("hasUnresolvedLiveCritique: a live passing critique is resolved (false)", () => {
  assert.equal(hasUnresolvedLiveCritique([{ verdict: "pass" }]), false);
});

test("hasUnresolvedLiveCritique: no critiques at all is resolved (false) -- absence is not a pending signal", () => {
  assert.equal(hasUnresolvedLiveCritique([]), false);
});

test("hasUnresolvedLiveCritique: a superseded/resolved critique does NOT count, even with a failing verdict (negative test, review finding 1)", () => {
  assert.equal(hasUnresolvedLiveCritique([{ verdict: "fail", superseded_by: "critique-2" }]), false);
  assert.equal(hasUnresolvedLiveCritique([{ verdict: "not_verified", superseded_by: "critique-2" }]), false);
});

test("hasUnresolvedLiveCritique: a resolved-then-reopened history (superseded fail + live pass) is resolved (false)", () => {
  assert.equal(
    hasUnresolvedLiveCritique([
      { verdict: "fail", superseded_by: "critique-2" },
      { verdict: "pass" },
    ]),
    false,
  );
});

test("hasUnresolvedLiveCritique: any live non-passing critique among several is unresolved (true)", () => {
  assert.equal(
    hasUnresolvedLiveCritique([
      { verdict: "pass", superseded_by: "critique-2" },
      { verdict: "fail" },
    ]),
    true,
  );
});

// --- filterCritiquesForSlug (issue #778 review finding 3: join-key identity) ---

test("filterCritiquesForSlug: a session-URI workflow_subject_ref matching the slug is kept, no warning", () => {
  const result = filterCritiquesForSlug([{ verdict: "fail", workflow_subject_ref: "flow-agents://session/session-a" }], "session-a");
  assert.equal(result.critiques.length, 1);
  assert.deepEqual(result.warnings, []);
});

test("filterCritiquesForSlug: a session-URI workflow_subject_ref naming a DIFFERENT slug is dropped with a warning (negative test, review finding 3)", () => {
  const result = filterCritiquesForSlug([{ verdict: "fail", workflow_subject_ref: "flow-agents://session/other-session" }], "session-a");
  assert.equal(result.critiques.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /other-session/);
  assert.match(result.warnings[0], /session-a/);
});

test("filterCritiquesForSlug: a work-item-bound (non-session-URI) ref is passed through unchanged -- cannot be confidently compared", () => {
  const result = filterCritiquesForSlug([{ verdict: "fail", workflow_subject_ref: "github:kontourai/flow-agents#778" }], "session-a");
  assert.equal(result.critiques.length, 1);
  assert.deepEqual(result.warnings, []);
});

test("filterCritiquesForSlug: an absent workflow_subject_ref is passed through unchanged", () => {
  const result = filterCritiquesForSlug([{ verdict: "fail" }], "session-a");
  assert.equal(result.critiques.length, 1);
  assert.deepEqual(result.warnings, []);
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

test("deriveConsoleProcessBlockedReason: review_pending returns a fixed, honest sentence referencing trust.bundle, not critique.json", () => {
  const reason = deriveConsoleProcessBlockedReason("review_pending", {});
  assert.match(reason, /review/i);
  assert.match(reason, /trust\.bundle/);
  assert.doesNotMatch(reason, /critique\.json/);
});

test("deriveConsoleProcessBlockedReason: clears (undefined) for every status OUTSIDE console#236's blocked/needs_input/review_pending/waiting/paused contract", () => {
  for (const status of ["not_started", "running", "completed", "failed", "cancelled"]) {
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

// Issue #778 review finding 2: waiting/paused are IN console#236's retained-reason
// contract (blockedReason is cleared only when status is NOT one of blocked/needs_input/
// review_pending/waiting/paused) -- they must not be force-cleared just because today's
// mapper has no concrete signal that produces them yet. Locks in the CORRECT behavior
// (a prior version of this test wrongly asserted these two cleared to undefined).
test("deriveConsoleProcessBlockedReason: waiting/paused RETAIN an available reason, per console#236's contract (review finding 2)", () => {
  for (const status of ["waiting", "paused"]) {
    const reason = deriveConsoleProcessBlockedReason(status, {
      nextActionStatus: "needs_user",
      nextActionSummary: "a reason that must be retained",
      workflowStatus: "needs_decision",
      handoffBlockers: [],
    });
    assert.equal(reason, "a reason that must be retained", `status=${status} must retain its reason`);
  }
});

test("deriveConsoleProcessBlockedReason: waiting/paused fall back to undefined when no reason source is available at all", () => {
  for (const status of ["waiting", "paused"]) {
    assert.equal(deriveConsoleProcessBlockedReason(status, {}), undefined);
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

test("buildWorkflowProcessProjection: a source with hasUnresolvedCritique=true projects to review_pending", () => {
  const source = {
    path: "/tmp/x/session-b/state.json",
    relativePath: "session-b/state.json",
    slug: "session-b",
    state: validateWorkflowStateProjectionSourceShape({
      schema_version: "1.0",
      task_slug: "session-b",
      status: "verifying",
      phase: "verification",
      next_action: { status: "continue", summary: "awaiting review" },
    }),
    hasUnresolvedCritique: true,
  };
  const envelope = buildWorkflowProcessProjection([source], { scope: { kind: "repo", id: "demo" }, generatedAt: "2026-07-20T12:00:00Z" });
  assert.equal(envelope.processes[0].status, "review_pending");
  assert.equal(envelope.processes[0].extensions["flow-agents"].has_unresolved_critique, true);
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
