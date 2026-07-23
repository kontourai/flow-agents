import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  flowRunHead,
  loadRun,
  pauseRun,
  runDir,
  startRun,
} from "@kontourai/flow";
import {
  createServerReviewSessionRecord,
  deriveServerReviewSessionApplyResult,
} from "@kontourai/survey/review-workbench/server-review-session";
import { buildReviewSessionEvents } from "@kontourai/survey/review-workbench";
import {
  continuePausedFlowGateFromSurvey,
  createSurveyFlowGateAdapter,
} from "../../build/src/index.js";

const SUBJECT = "work-item:survey-gate-851";
const GATE = "review-gate";
const TIME = "2026-07-22T12:00:00.000Z";
const EVALUATION_TIME = "2026-07-22T12:01:00.000Z";

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-survey-gate-"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function authority(ref) {
  return {
    kind: "operator_request",
    actor: "operator:survey-gate-test",
    request_ref: ref,
    requested_at: TIME,
  };
}

function definition() {
  return {
    id: "survey-gate-adapter-test",
    version: "1",
    steps: [{ id: "review", next: "complete" }, { id: "complete", next: null }],
    gates: {
      [GATE]: {
        step: "review",
        expects: [{
          id: "accepted-survey-review",
          kind: "trust.bundle",
          required: true,
          description: "A server-derived Survey review was accepted.",
          bundle_claim: {
            claimType: "quality.review",
            subjectType: "work-item",
            subjectId: SUBJECT,
            accepted_statuses: ["verified"],
          },
        }],
      },
    },
  };
}

async function pausedRun(cwd, runId) {
  const definitionPath = path.join(cwd, "flow.json");
  writeJson(definitionPath, definition());
  await startRun(definitionPath, { cwd, runId, params: { subject: SUBJECT } });
  await pauseRun(runId, {
    cwd,
    reason: "Wait for a reviewed decision.",
    authority: authority(`pause:${runId}`),
    at: TIME,
  });
  return loadRun(runId, cwd);
}

function session({ decision = "accept-proposed", name = "survey-gate-session" } = {}) {
  const item = {
    apiVersion: "survey.kontourai.io/v1alpha1",
    kind: "ReviewItem",
    metadata: { name: "gate-review-item" },
    spec: {
      target: "quality.review",
      candidateSetStatus: "conflict",
      candidates: [{
        id: "candidate.accepted",
        role: "proposed",
        value: "accepted",
        source: {
          sourceId: "source.review",
          sourceRef: "review://server/gate-review-item",
          kind: "manual-entry",
          observedAt: TIME,
          locatorScheme: "structured-field",
        },
        extraction: {
          extractionId: "extraction.review",
          target: "quality.review",
          extractor: "survey-gate-test",
          extractedAt: TIME,
        },
        locator: {
          scheme: "structured-field",
        },
        claimTarget: {
          claimId: "claim.review",
          subjectType: "work-item",
          subjectId: SUBJECT,
          facet: "quality",
          claimType: "quality.review",
          fieldOrBehavior: "review acceptance",
          impactLevel: "high",
          collectedBy: "survey-gate-test",
        },
        projection: {
          rawSourceId: "source.review",
          extractionId: "extraction.review",
          candidateSetId: "candidate-set.review",
          candidateId: "candidate.accepted",
          reviewOutcomeId: "review.accepted",
          claimId: "claim.review",
        },
      }],
    },
  };
  const snapshot = {
    items: [item],
    activeItemName: item.metadata.name,
    notesByItemName: { [item.metadata.name]: "A server-side reviewer completed this decision." },
    decisionsByItemName: decision ? { [item.metadata.name]: decision } : {},
    reviewedAt: TIME,
    actorId: "reviewer:server",
  };
  const events = buildReviewSessionEvents(snapshot, name);
  return {
    snapshot,
    events,
    record: createServerReviewSessionRecord({ sessionName: name, snapshot, eventCount: events.length, updatedAt: TIME }),
  };
}

function surveyInput({ status = "verified", subject = SUBJECT, workflowSubject = SUBJECT } = {}) {
  return {
    source: "survey-gate-adapter-test",
    generatedAt: TIME,
    rawSources: [{
      id: "source.review",
      kind: "manual-entry",
      sourceRef: "review://server/gate-review-item",
      observedAt: TIME,
      locatorScheme: "structured-field",
    }],
    extractions: [{
      id: "extraction.review",
      sourceId: "source.review",
      target: "quality.review",
      value: "accepted",
      extractor: "survey-gate-test",
      extractedAt: TIME,
    }],
    candidateSets: [{
      id: "candidate-set.review",
      target: "quality.review",
      candidates: [{ id: "candidate.accepted", extractionId: "extraction.review", value: "accepted" }],
      selectedCandidateId: "candidate.accepted",
      status: "conflict",
    }],
    reviewOutcomes: [{
      id: "review.accepted",
      candidateSetId: "candidate-set.review",
      candidateId: "candidate.accepted",
      status,
      actor: "reviewer:server",
      reviewedAt: TIME,
    }],
    claims: [{
      id: "claim.review",
      candidateSetId: "candidate-set.review",
      candidateId: "candidate.accepted",
      subjectType: "work-item",
      subjectId: subject,
      facet: "quality",
      claimType: "quality.review",
      fieldOrBehavior: "review acceptance",
      impactLevel: "high",
      collectedBy: "survey-gate-test",
      metadata: { workflow_subject_ref: workflowSubject },
    }],
  };
}

function resolvedReview(review, projection = surveyInput()) {
  let derived;
  try {
    derived = deriveServerReviewSessionApplyResult({
      record: review.record,
      events: review.events,
      currentSnapshot: review.currentSnapshot ?? review.snapshot,
      currentEventCount: review.currentEventCount ?? review.events.length,
      requiredResolvedItems: "all",
    });
  } catch {
    derived = undefined;
  }
  if (derived?.ok) {
    for (const outcome of projection.reviewOutcomes) {
      const decision = derived.decisions.find((entry) => entry.spec.projection?.reviewOutcomeId === outcome.id);
      if (!decision) continue;
      for (const field of [
        "attemptEvidenceIds",
        "rationale",
        "evidenceIds",
        "withinComfortZone",
        "comfortZoneNote",
        "authorizing",
      ]) {
        if (decision.spec[field] !== undefined) outcome[field] = structuredClone(decision.spec[field]);
      }
    }
  }
  return {
    ...review,
    currentSnapshot: review.currentSnapshot ?? review.snapshot,
    currentEventCount: review.currentEventCount ?? review.events.length,
    surveyInput: projection,
  };
}

function unrelatedSession(name = "unrelated-review") {
  const original = session({ name });
  const snapshot = structuredClone(original.snapshot);
  const item = snapshot.items[0];
  item.spec.target = "unrelated.target";
  item.spec.candidates[0].claimTarget = {
    ...item.spec.candidates[0].claimTarget,
    subjectType: "unrelated-record",
    subjectId: "unrelated-subject",
    facet: "unrelated",
    claimType: "unrelated.review",
    fieldOrBehavior: "unrelated target",
  };
  item.spec.candidates[0].extraction.target = "unrelated.target";
  const events = buildReviewSessionEvents(snapshot, name);
  return {
    snapshot,
    events,
    record: createServerReviewSessionRecord({ sessionName: name, snapshot, eventCount: events.length, updatedAt: TIME }),
  };
}

function resolver(entries) {
  return {
    reviewSessions: {
      resolve(ref) {
        const value = entries[ref];
        if (!value) throw new Error(`unknown review session: ${ref}`);
        return value;
      },
    },
  };
}

function request(run, reviewSessionRef, overrides = {}) {
  return {
    runId: run.state.run_id,
    cwd: path.dirname(path.dirname(path.dirname(path.dirname(run.dir)))),
    expectedRunHead: flowRunHead(run.state),
    gate: GATE,
    resume: {
      reason: "Resume after server-derived Survey review.",
      authority: authority(`resume:${run.state.run_id}`),
      at: EVALUATION_TIME,
    },
    reviewSessionRef,
    now: EVALUATION_TIME,
    ...overrides,
  };
}

function flowSnapshot(cwd, runId) {
  const dir = runDir(runId, cwd);
  return {
    state: fs.readFileSync(path.join(dir, "state.json"), "utf8"),
    manifest: fs.readFileSync(path.join(dir, "evidence", "manifest.json"), "utf8"),
    evidence: fs.readdirSync(path.join(dir, "evidence")).sort(),
  };
}

test("accepted server review attaches Survey evidence and resumes the paused Flow gate", async () => {
  const cwd = workspace();
  const run = await pausedRun(cwd, "accepted");
  const dependencies = resolver({ accepted: resolvedReview(session()) });
  const result = await continuePausedFlowGateFromSurvey(request(run, "accepted"), dependencies);
  const persisted = await loadRun(run.state.run_id, cwd);

  assert.equal(result.flow.committed, true);
  assert.equal(result.flow.outcomes[0].status, "pass");
  assert.equal(result.review.decisions.length, 1);
  assert.equal(persisted.state.status, "active");
  assert.equal(persisted.state.current_step, "complete");
  assert.equal(persisted.manifest.evidence.length, 1);
});

test("direct and in-process host entry points have identical continuation behavior", async () => {
  const directCwd = workspace();
  const hostCwd = workspace();
  const directRun = await pausedRun(directCwd, "direct");
  const hostRun = await pausedRun(hostCwd, "host");
  const directDependencies = resolver({ direct: resolvedReview(session({ name: "direct-review" })) });
  const hostDependencies = resolver({ host: resolvedReview(session({ name: "host-review" })) });
  const direct = await continuePausedFlowGateFromSurvey(request(directRun, "direct"), directDependencies);
  const hosted = await createSurveyFlowGateAdapter(hostDependencies).continuePausedGate(request(hostRun, "host"));

  assert.deepEqual(
    { committed: direct.flow.committed, status: direct.flow.outcomes[0].status, step: direct.flow.run.state.current_step },
    { committed: hosted.flow.committed, status: hosted.flow.outcomes[0].status, step: hosted.flow.run.state.current_step },
  );
});

test("stale, foreign, mismatched, and fabricated resolver results fail before Flow mutation", async () => {
  const cases = [
    ["stale", (review) => resolvedReview({ ...review, currentSnapshot: { ...review.snapshot, notesByItemName: {} } })],
    ["missing-current", (review) => {
      const resolved = resolvedReview(review);
      delete resolved.currentSnapshot;
      return resolved;
    }],
    ["foreign", (review) => resolvedReview(review, surveyInput({ subject: "work-item:foreign", workflowSubject: SUBJECT }))],
    ["mismatch", (review) => resolvedReview(review, surveyInput({ workflowSubject: "work-item:wrong" }))],
    ["fabricated", () => resolvedReview(session({ decision: null, name: "fabricated" }))],
  ];

  for (const [name, resolveValue] of cases) {
    const cwd = workspace();
    const run = await pausedRun(cwd, name);
    const review = session({ name: `${name}-review` });
    const dependencies = resolver({ [name]: resolveValue(review) });
    const before = flowSnapshot(cwd, run.state.run_id);
    await assert.rejects(
      () => continuePausedFlowGateFromSurvey(request(run, name), dependencies),
      (error) => error?.name !== "TypeError",
      `${name} must fail deliberately`,
    );
    assert.deepEqual(flowSnapshot(cwd, run.state.run_id), before, `${name} must not mutate Flow state or evidence`);
  }
});

test("a server-derived rejected review is inspectable but leaves Flow state mutation-free", async () => {
  const cwd = workspace();
  const run = await pausedRun(cwd, "nonpass");
  const before = flowSnapshot(cwd, run.state.run_id);
  const dependencies = resolver({
    rejected: resolvedReview(session({ decision: "reject-proposed", name: "rejected-review" }), surveyInput({ status: "rejected" })),
  });
  const result = await continuePausedFlowGateFromSurvey(request(run, "rejected"), dependencies);

  assert.equal(result.flow.committed, false);
  assert.notEqual(result.flow.outcomes[0].status, "pass");
  assert.deepEqual(flowSnapshot(cwd, run.state.run_id), before);
});

test("a verified claim override cannot turn a canonical rejection into passing evidence", async () => {
  const cwd = workspace();
  const run = await pausedRun(cwd, "status-override");
  const before = flowSnapshot(cwd, run.state.run_id);
  const projection = surveyInput({ status: "rejected" });
  projection.claims[0].status = "verified";
  const dependencies = resolver({
    rejected: resolvedReview(session({ decision: "reject-proposed", name: "status-override-review" }), projection),
  });

  await assert.rejects(
    () => continuePausedFlowGateFromSurvey(request(run, "rejected"), dependencies),
    /overrides the canonical review status/,
  );
  assert.deepEqual(flowSnapshot(cwd, run.state.run_id), before);
});

test("a stale Flow run head fails before the Survey bundle reaches Flow", async () => {
  const cwd = workspace();
  const run = await pausedRun(cwd, "stale-head");
  const before = flowSnapshot(cwd, run.state.run_id);
  const dependencies = resolver({ stale: resolvedReview(session({ name: "stale-head-review" })) });
  await assert.rejects(
    () => continuePausedFlowGateFromSurvey(request(run, "stale", { expectedRunHead: "0".repeat(64) }), dependencies),
    /expectedRunHead/,
  );
  assert.deepEqual(flowSnapshot(cwd, run.state.run_id), before);
});

test("continuation requests cannot inject authority records, events, or Survey projection", async () => {
  const cwd = workspace();
  const run = await pausedRun(cwd, "payload-injection");
  const canonical = resolvedReview(session({ name: "resolver-selected" }));
  const dependencies = resolver({ canonical });
  const before = flowSnapshot(cwd, run.state.run_id);

  for (const injected of [
    { reviewSession: session({ name: "forged-session" }) },
    { record: session({ name: "forged-record" }).record },
    { surveyInput: surveyInput({ workflowSubject: "work-item:forged" }) },
    { events: [] },
  ]) {
    await assert.rejects(
      () => continuePausedFlowGateFromSurvey(request(run, "canonical", injected), dependencies),
      /authority-bearing data/,
    );
    assert.deepEqual(flowSnapshot(cwd, run.state.run_id), before);
  }

  const result = await createSurveyFlowGateAdapter(dependencies).continuePausedGate(request(run, "canonical"));
  assert.equal(result.flow.committed, true);
  assert.equal(result.review.ref, "canonical");
  assert.equal(result.trustBundle.claims[0].metadata.workflow_subject_ref, SUBJECT);
});

test("a valid unrelated review cannot be repurposed into the gated Survey projection", async () => {
  const cwd = workspace();
  const run = await pausedRun(cwd, "unrelated-projection");
  const before = flowSnapshot(cwd, run.state.run_id);
  const dependencies = resolver({
    unrelated: resolvedReview(unrelatedSession(), surveyInput()),
  });

  await assert.rejects(
    () => continuePausedFlowGateFromSurvey(request(run, "unrelated"), dependencies),
    /canonical replayed ReviewItem/,
  );
  assert.deepEqual(flowSnapshot(cwd, run.state.run_id), before);
});

test("a resolver projection cannot change evidence-affecting candidate or claim fields", async () => {
  const cwd = workspace();
  const run = await pausedRun(cwd, "projection-field-mismatch");
  const before = flowSnapshot(cwd, run.state.run_id);
  const projection = surveyInput();
  projection.candidateSets[0].candidates[0].confidence = 0.99;
  const dependencies = resolver({
    mismatch: resolvedReview(session({ name: "projection-field-mismatch-review" }), projection),
  });

  await assert.rejects(
    () => continuePausedFlowGateFromSurvey(request(run, "mismatch"), dependencies),
    /surveyInput\.candidates\.confidence/,
  );
  assert.deepEqual(flowSnapshot(cwd, run.state.run_id), before);
});

test("a resolver projection cannot change the canonical candidate-set rationale", async () => {
  const cwd = workspace();
  const run = await pausedRun(cwd, "projection-rationale-mismatch");
  const before = flowSnapshot(cwd, run.state.run_id);
  const projection = surveyInput();
  projection.candidateSets[0].rationale = "caller-selected rationale";
  const dependencies = resolver({
    mismatch: resolvedReview(session({ name: "projection-rationale-mismatch-review" }), projection),
  });

  await assert.rejects(
    () => continuePausedFlowGateFromSurvey(request(run, "mismatch"), dependencies),
    /surveyInput\.candidateSets\.rationale/,
  );
  assert.deepEqual(flowSnapshot(cwd, run.state.run_id), before);
});
