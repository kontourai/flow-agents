import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { evaluateRun, flowRunHead, loadRun, pauseRun, startRun } from "@kontourai/flow";
import {
  bindSurveyGateReviewItem,
  discoverSurveyGateReviewWork,
  publishSurveyGateReviewWork,
} from "../../build/src/index.js";

const SUBJECT = "work-item:review-work-821";
const GATE = "human-review";
const EXPECTATION = "reviewed-quality";
const TIME = "2026-07-22T17:00:00.000Z";

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-review-work-"));
}

function definition() {
  return {
    id: "survey-review-work-test",
    version: "1",
    steps: [{ id: "review", next: "done" }, { id: "done", next: null }],
    gates: {
      [GATE]: {
        step: "review",
        expects: [
          {
            id: EXPECTATION,
            kind: "trust.bundle",
            required: true,
            description: "A human reviewed the proposed quality value.",
            explore_hint: "Open the producer's review queue.",
            bundle_claim: {
              claimType: "quality.review",
              subjectType: "work-item",
              subjectId: SUBJECT,
              accepted_statuses: ["verified"],
            },
          },
          {
            id: "unrelated-proof",
            kind: "trust.bundle",
            required: true,
            description: "An unrelated machine proof exists.",
            bundle_claim: { claimType: "machine.proof" },
          },
          {
            id: "optional-review",
            kind: "trust.bundle",
            required: false,
            description: "Optional review context.",
            bundle_claim: { claimType: "quality.context" },
          },
        ],
      },
    },
  };
}

async function blockedRun({ paused = false } = {}) {
  const cwd = workspace();
  const file = path.join(cwd, "flow.json");
  fs.writeFileSync(file, `${JSON.stringify(definition())}\n`);
  await startRun(file, { cwd, runId: "run-821", params: { subject: SUBJECT } });
  await evaluateRun("run-821", { cwd, now: TIME });
  if (paused) {
    await pauseRun("run-821", {
      cwd,
      reason: "Wait for human review.",
      authority: {
        kind: "operator_request",
        actor: "operator:test",
        request_ref: "request:pause-review",
        requested_at: TIME,
      },
      at: TIME,
    });
  }
  const run = await loadRun("run-821", cwd);
  return { cwd, run };
}

function discoveryInput(cwd, run, overrides = {}) {
  return {
    cwd,
    runId: run.state.run_id,
    gate: GATE,
    expectedRunHead: flowRunHead(run.state),
    reviewExpectationIds: [EXPECTATION],
    ...overrides,
  };
}

function reviewItem(overrides = {}) {
  return {
    apiVersion: "survey.kontourai.io/v1alpha1",
    kind: "ReviewItem",
    metadata: { name: "quality-review" },
    spec: {
      target: "quality.review",
      candidates: [{
        id: "proposal",
        role: "proposed",
        value: "approved",
        source: { sourceRef: "producer://quality/proposal" },
        extraction: { target: "quality.review" },
        claimTarget: {
          subjectType: "work-item",
          subjectId: SUBJECT,
          facet: "quality",
          claimType: "quality.review",
          fieldOrBehavior: "approval",
          impactLevel: "high",
        },
      }],
    },
    ...overrides,
  };
}

test("discovers only explicitly selected missing review work from a persisted block", async () => {
  const { cwd, run } = await blockedRun();
  const [request] = await discoverSurveyGateReviewWork(discoveryInput(cwd, run));
  assert.match(request.id, /^survey-gate-review-[a-f0-9]{64}$/);
  assert.deepEqual(request.flow, {
    runId: "run-821",
    runHead: flowRunHead(run.state),
    blockedTransitionRef: request.flow.blockedTransitionRef,
    definitionId: "survey-review-work-test",
    definitionVersion: "1",
    subject: SUBJECT,
    step: "review",
    gate: GATE,
    expectationId: EXPECTATION,
  });
  assert.deepEqual(request.expectation, {
    description: "A human reviewed the proposed quality value.",
    exploreHint: "Open the producer's review queue.",
    claim: {
      claimType: "quality.review",
      subjectType: "work-item",
      subjectId: SUBJECT,
      acceptedStatuses: ["verified"],
    },
  });
});

test("discovers a persisted block after the host explicitly pauses the run", async () => {
  const { cwd, run: blocked } = await blockedRun();
  const [beforePause] = await discoverSurveyGateReviewWork(discoveryInput(cwd, blocked));
  await pauseRun("run-821", {
    cwd,
    reason: "Wait for human review.",
    authority: {
      kind: "operator_request",
      actor: "operator:test",
      request_ref: "request:pause-review",
      requested_at: TIME,
    },
    at: TIME,
  });
  const paused = await loadRun("run-821", cwd);
  const [afterPause] = await discoverSurveyGateReviewWork(discoveryInput(cwd, paused));
  assert.equal(afterPause.id, beforePause.id, "pause must not create duplicate queue work");
  assert.equal(afterPause.flow.blockedTransitionRef, beforePause.flow.blockedTransitionRef);
  assert.notEqual(afterPause.flow.runHead, beforePause.flow.runHead);
});

test("does not infer review work from claim type names", async () => {
  const { cwd, run } = await blockedRun();
  const requests = await discoverSurveyGateReviewWork(discoveryInput(cwd, run, {
    reviewExpectationIds: ["unrelated-proof"],
  }));
  assert.equal(requests[0].flow.expectationId, "unrelated-proof");
  assert.equal(requests[0].expectation.claim.claimType, "machine.proof");
});

test("fails closed on stale run heads and invalid classifications", async () => {
  const { cwd, run } = await blockedRun();
  await assert.rejects(
    discoverSurveyGateReviewWork(discoveryInput(cwd, run, { expectedRunHead: "0".repeat(64) })),
    /does not match the persisted Flow Run/,
  );
  await assert.rejects(
    discoverSurveyGateReviewWork(discoveryInput(cwd, run, { reviewExpectationIds: ["unknown"] })),
    /unknown expectation unknown/,
  );
  await assert.rejects(
    discoverSurveyGateReviewWork(discoveryInput(cwd, run, { reviewExpectationIds: ["optional-review"] })),
    /optional expectation optional-review/,
  );
});

test("requires a persisted blocking outcome rather than treating an active gate as work", async () => {
  const cwd = workspace();
  const file = path.join(cwd, "flow.json");
  fs.writeFileSync(file, `${JSON.stringify(definition())}\n`);
  await startRun(file, { cwd, runId: "active-run", params: { subject: SUBJECT } });
  const run = await loadRun("active-run", cwd);
  await assert.rejects(
    discoverSurveyGateReviewWork({ ...discoveryInput(cwd, run), runId: "active-run" }),
    /persisted blocking outcome/,
  );
});

test("binds a producer-authored ReviewItem without changing candidates", async () => {
  const { cwd, run } = await blockedRun();
  const [request] = await discoverSurveyGateReviewWork(discoveryInput(cwd, run));
  const supplied = reviewItem();
  const bound = bindSurveyGateReviewItem(request, supplied);
  assert.deepEqual(bound.spec, supplied.spec);
  assert.equal(bound.metadata.annotations["flow.kontourai.io/review-work-id"], request.id);
  assert.equal(bound.metadata.annotations["flow.kontourai.io/run-id"], "run-821");
  assert.equal(bound.metadata.annotations["flow.kontourai.io/workflow-subject-ref"], SUBJECT);
  assert.equal(supplied.metadata.annotations, undefined, "producer input remains unmodified");
});

test("rejects fabricated, mismatched, and producer-spoofed review work", async () => {
  const { cwd, run } = await blockedRun();
  const [request] = await discoverSurveyGateReviewWork(discoveryInput(cwd, run));
  assert.throws(
    () => bindSurveyGateReviewItem(request, reviewItem({ spec: { target: "quality.review", candidates: [] } })),
    /must be supplied by the producer/,
  );
  const mismatched = reviewItem();
  mismatched.spec.candidates[0].claimTarget.claimType = "other.review";
  assert.throws(() => bindSurveyGateReviewItem(request, mismatched), /must match Flow expectation/);
  const spoofed = reviewItem();
  spoofed.metadata.annotations = { "flow.kontourai.io/run-id": "foreign" };
  assert.throws(() => bindSurveyGateReviewItem(request, spoofed), /is adapter-owned/);
});

test("publishes validated work through host-owned producer and queue capabilities", async () => {
  const { cwd, run } = await blockedRun();
  const calls = [];
  const result = await publishSurveyGateReviewWork(discoveryInput(cwd, run), {
    producer: {
      createReviewItem(request) {
        calls.push(["produce", request.id]);
        return reviewItem();
      },
    },
    queue: {
      publish(input) {
        calls.push(["publish", input.idempotencyKey]);
        assert.equal(input.idempotencyKey, input.request.id);
        assert.equal(input.item.metadata.annotations["flow.kontourai.io/gate-id"], GATE);
        return { ref: "queue://review/quality-review" };
      },
    },
  });
  assert.deepEqual(calls, [["produce", result[0].request.id], ["publish", result[0].request.id]]);
  assert.deepEqual(result[0].publication, { ref: "queue://review/quality-review" });
});
