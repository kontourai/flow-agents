import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FLOW_RUN_EVIDENCE_MANIFEST_PATH, runDir } from "@kontourai/flow";
import {
  startBuilderFlowSession,
  syncBuilderFlowSession,
} from "../../build/src/builder-flow-runtime.js";

const SUBJECT = "local:work-item/runtime-projection";
const NOW = "2026-07-09T20:00:00.000Z";

function makeSession(slug = "runtime-projection") {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-builder-runtime-"));
  const artifactRoot = path.join(projectRoot, ".kontourai", "flow-agents");
  const sessionDir = path.join(artifactRoot, slug);
  writeJson(path.join(sessionDir, "state.json"), {
    schema_version: "1.0",
    task_slug: slug,
    status: "planned",
    phase: "planning",
    updated_at: NOW,
    work_item_refs: [SUBJECT],
    next_action: { status: "continue", summary: "Start Builder." },
  });
  writeJson(path.join(artifactRoot, "current.json"), {
    active_slug: slug,
    artifact_dir: `.kontourai/flow-agents/${slug}`,
    updated_at: NOW,
  });
  return { projectRoot, artifactRoot, sessionDir, slug };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function bundleClaim({ expectation, claimType, subjectType, status = "pass", routeReason, subject = SUBJECT }) {
  const claimId = `claim.${expectation}`;
  return {
    claim: {
      id: claimId,
      subjectType,
      subjectId: `runtime-projection/gate-claim-${expectation}`,
      claimType,
      fieldOrBehavior: `${expectation} fixture`,
      value: status,
      metadata: {
        workflow_subject_ref: subject,
        gate_claim: {
          expectation_id: expectation,
          claim_type: claimType,
          subject_type: subjectType,
          ...(routeReason ? { route_reason: routeReason } : {}),
        },
      },
      createdAt: NOW,
      updatedAt: NOW,
    },
    evidence: {
      id: `evidence.${expectation}`,
      claimId,
      evidenceType: "human_attestation",
      method: "attestation",
      sourceRef: "src/cli/builder-flow-runtime.test.mjs",
      excerptOrSummary: `${expectation} fixture`,
      observedAt: NOW,
      collectedBy: "flow-agents-test",
    },
    event: {
      id: `event.${expectation}`,
      claimId,
      status: status === "pass" ? "verified" : "disputed",
      actor: "flow-agents-test",
      method: "attestation",
      evidenceIds: [`evidence.${expectation}`],
      createdAt: NOW,
      verifiedAt: NOW,
    },
  };
}

function writeBundle(sessionDir, entries) {
  writeJson(path.join(sessionDir, "trust.bundle"), {
    schemaVersion: 5,
    source: "flow-agents-builder-runtime-test",
    claims: entries.map((entry) => entry.claim),
    evidence: entries.map((entry) => entry.evidence),
    policies: [],
    events: entries.map((entry) => entry.event),
  });
}

async function writeAndSync(session, entries) {
  writeBundle(session.sessionDir, entries);
  return syncBuilderFlowSession({ sessionDir: session.sessionDir });
}

test("small-model client can start and advance from projected actions without choosing Flow steps", async () => {
  const session = makeSession();
  const started = await startBuilderFlowSession({ sessionDir: session.sessionDir });

  assert.equal(started.run.state.current_step, "pull-work");
  assert.deepEqual(started.projection.next_action.skills, ["pull-work"]);
  assert.deepEqual(started.projection.next_action.operations, []);
  assert.equal(started.projection.next_action.command, `flow-agents builder-run sync --session-dir .kontourai/flow-agents/${session.slug}`);
  assert.ok(fs.existsSync(runDir(session.slug, session.projectRoot)));
  assert.ok(!fs.existsSync(path.join(session.projectRoot, ".flow", "runs")), "retired runtime path must not be created");

  const advanced = await writeAndSync(session, [bundleClaim({
    expectation: "selected-work",
    claimType: "builder.pull-work.selected",
    subjectType: "work-item",
  })]);

  assert.equal(advanced.attached, true);
  assert.equal(advanced.run.state.current_step, "design-probe");
  assert.deepEqual(advanced.projection.next_action.skills, ["pickup-probe"]);
  assert.equal(readJson(path.join(session.artifactRoot, "current.json")).active_step_id, "design-probe");

  const duplicate = await syncBuilderFlowSession({ sessionDir: session.sessionDir });
  assert.equal(duplicate.attached, false);
  assert.equal(duplicate.run.manifest.evidence.length, advanced.run.manifest.evidence.length);
});

test("wrong workflow subject is rejected before canonical Flow mutation", async () => {
  const session = makeSession("wrong-subject");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  const beforeState = readJson(path.join(runDir(session.slug, session.projectRoot), "state.json"));
  const beforeManifest = readJson(path.join(runDir(session.slug, session.projectRoot), FLOW_RUN_EVIDENCE_MANIFEST_PATH));
  writeBundle(session.sessionDir, [bundleClaim({
    expectation: "selected-work",
    claimType: "builder.pull-work.selected",
    subjectType: "work-item",
    subject: "local:work-item/other",
  })]);

  await assert.rejects(
    () => syncBuilderFlowSession({ sessionDir: session.sessionDir }),
    /workflow_subject_ref.*persisted run subject/,
  );
  assert.deepEqual(readJson(path.join(runDir(session.slug, session.projectRoot), "state.json")), beforeState);
  assert.deepEqual(readJson(path.join(runDir(session.slug, session.projectRoot), FLOW_RUN_EVIDENCE_MANIFEST_PATH)), beforeManifest);
});

test("failed verification projects Flow-owned route-back attempt and budget", async () => {
  const session = makeSession("route-back-projection");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  await writeAndSync(session, [bundleClaim({ expectation: "selected-work", claimType: "builder.pull-work.selected", subjectType: "work-item" })]);
  await writeAndSync(session, [
    bundleClaim({ expectation: "pickup-probe-readiness", claimType: "builder.design-probe.pickup-readiness", subjectType: "work-item" }),
    bundleClaim({ expectation: "probe-decisions-or-accepted-gaps", claimType: "builder.design-probe.decisions", subjectType: "decision" }),
  ]);
  await writeAndSync(session, [bundleClaim({ expectation: "implementation-plan", claimType: "builder.plan.implementation", subjectType: "artifact" })]);
  const verify = await writeAndSync(session, [bundleClaim({ expectation: "implementation-scope", claimType: "builder.execute.scope", subjectType: "change" })]);
  assert.equal(verify.run.state.current_step, "verify");

  const routed = await writeAndSync(session, [bundleClaim({
    expectation: "tests-evidence",
    claimType: "builder.verify.tests",
    subjectType: "flow-step",
    status: "fail",
    routeReason: "implementation_defect",
  })]);

  assert.equal(routed.run.state.current_step, "execute");
  assert.equal(routed.projection.flow_run.route_back_attempt, 1);
  assert.equal(routed.projection.flow_run.route_back_max_attempts, 3);
  assert.match(routed.projection.next_action.summary, /Route-back history: attempt 1\/3 returned to `execute` for `implementation_defect`/);
  assert.deepEqual(routed.projection.next_action.skills, ["execute-plan"]);
});

test("verified sidecar claims drive the composed publish and learning prefix to completion", async () => {
  const session = makeSession("composed-completion");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  const steps = [
    [bundleClaim({ expectation: "selected-work", claimType: "builder.pull-work.selected", subjectType: "work-item" })],
    [
      bundleClaim({ expectation: "pickup-probe-readiness", claimType: "builder.design-probe.pickup-readiness", subjectType: "work-item" }),
      bundleClaim({ expectation: "probe-decisions-or-accepted-gaps", claimType: "builder.design-probe.decisions", subjectType: "decision" }),
    ],
    [bundleClaim({ expectation: "implementation-plan", claimType: "builder.plan.implementation", subjectType: "artifact" })],
    [bundleClaim({ expectation: "implementation-scope", claimType: "builder.execute.scope", subjectType: "change" })],
    [bundleClaim({ expectation: "tests-evidence", claimType: "builder.verify.tests", subjectType: "flow-step" })],
    [bundleClaim({ expectation: "merge-readiness", claimType: "builder.merge-ready.readiness", subjectType: "change" })],
  ];
  for (const entries of steps) await writeAndSync(session, entries);

  const prOpen = readJson(path.join(session.sessionDir, "state.json"));
  assert.equal(prOpen.flow_run.current_step, "pr-open");
  assert.deepEqual(prOpen.next_action.skills, []);
  assert.deepEqual(prOpen.next_action.operations, ["publish-change"]);

  await writeAndSync(session, [bundleClaim({ expectation: "pull-request-opened", claimType: "builder.pr-open.pull-request", subjectType: "pull-request" })]);
  await writeAndSync(session, [bundleClaim({ expectation: "ci-merge-readiness", claimType: "builder.merge-ready-ci.readiness", subjectType: "pull-request" })]);
  const completed = await writeAndSync(session, [
    bundleClaim({ expectation: "decision-evidence", claimType: "builder.learn.decisions", subjectType: "decision" }),
    bundleClaim({ expectation: "learning-evidence", claimType: "builder.learn.evidence", subjectType: "release" }),
  ]);

  assert.equal(completed.run.state.current_step, "learn", JSON.stringify(completed.run.state.gate_outcomes, null, 2));
  assert.equal(completed.run.state.status, "completed");
  assert.equal(completed.projection.status, "delivered");
  assert.deepEqual(completed.projection.next_action, { status: "done", summary: "Canonical Flow run is complete." });
});
