// #1304: route-back cost disclosure at the point of use — observe, don't predict.
//
// The disclosure has two halves split along declared-versus-observed lines. The PRE half
// (routeBackDisclosureLines, shared with the sidecar writer) states only facts that exist before
// the mutation: the DECLARED route map, the PERSISTED attempt history, the invalidation rule, and
// — when a requires_current_verification gate has no provisional delivery record on disk — the
// publish-first ordering rule. It never predicts what evaluation will decide: the first version
// of this change derived routeBackDecision pre-mutation and was blocked by independent review
// because that prediction LIES in the live #1304 scenario (an unpublished not_verified at
// merge-ready-ci is WITHHELD, not routed). The POST half (routeBackOutcomeLines) reports what
// evaluation actually did, verbatim from the transitions the mutation appended.
//
// Layered proof note: the full not_verified-at-merge-ready-ci integration needs an authenticated
// ChangeProvider to reach that step (same gap as the freshness-turnstile tests); here the REAL
// shipped gate declaration drives the helpers, and the success-path route is proven end-to-end on
// a real builder.build run at the execute gate. Run: `npm run test:unit`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { flowRunHead, runDir } from "@kontourai/flow";
import { routeBackDisclosureLines } from "../../build/src/cli/workflow-sidecar.js";
import { assertExecuteFailureRouteBeforeMutation, routeBackOutcomeLines } from "../../build/src/cli/workflow.js";
import { startBuilderFlowSession, syncBuilderFlowSession } from "../../build/src/builder-flow-runtime.js";
import { performLocalClaim, resolveCurrentAssignmentActor } from "../../build/src/cli/assignment-provider.js";

// Each node:test file is its own process: pin the ambient actor before any claim resolution so
// the fixture's assignment holder is deterministic.
process.env.FLOW_AGENTS_ACTOR = "routeback-disclosure-owner";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "../../build/src/cli.js");
const SIDECAR = path.resolve(__dirname, "../../build/src/cli/workflow-sidecar.js");
const KIT_PUBLISH_LEARN = path.resolve(__dirname, "../../kits/builder/flows/publish-learn.flow.json");

// A PRE line may QUOTE the declared map ("reason -> step") but must never assert a route as this
// invocation's outcome — that vocabulary belongs exclusively to the POST half.
const PREDICTION_VOCABULARY = /routed|routes .* back to step|will route|BLOCKS the run/;

// ---------------------------------------------------------------------------
// Real-run fixture: a builder.build session advanced to the execute step (the
// same claim shapes the builder-runtime suite uses).
// ---------------------------------------------------------------------------

function bundleClaim({ expectation, claimType, subjectType, stepId, subject }) {
  const timestamp = new Date().toISOString();
  const claimId = `claim.${expectation}`;
  return {
    claim: {
      id: claimId,
      subjectType,
      subjectId: `routeback-disclosure/gate-claim-${expectation}`,
      claimType,
      fieldOrBehavior: `${expectation} fixture`,
      value: "pass",
      metadata: {
        workflow_subject_ref: subject,
        origin: "check",
        check_kind: "external",
        gate_claim: { expectation_id: expectation, claim_type: claimType, subject_type: subjectType, step_id: stepId, recorded_at: timestamp, identity_version: 2 },
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    evidence: {
      id: `evidence.${expectation}`, claimId, evidenceType: "human_attestation", method: "attestation",
      sourceRef: "src/cli/routeback-disclosure.test.mjs", excerptOrSummary: `${expectation} fixture`,
      observedAt: timestamp, collectedBy: "flow-agents-test",
    },
    event: {
      id: `event.${expectation}`, claimId, status: "verified", actor: "flow-agents-test", method: "attestation",
      evidenceIds: [`evidence.${expectation}`], createdAt: timestamp, verifiedAt: timestamp,
    },
  };
}

async function writeAndSync(session, entries) {
  let canonicalHead = null;
  try {
    canonicalHead = flowRunHead(JSON.parse(fs.readFileSync(path.join(runDir(session.slug, session.projectRoot), "state.json"), "utf8")));
  } catch { /* pre-Flow fixtures remain unstamped */ }
  for (const entry of entries) {
    if (canonicalHead) entry.claim.metadata.gate_claim.flow_run_head = canonicalHead;
  }
  fs.writeFileSync(path.join(session.sessionDir, "trust.bundle"), JSON.stringify({
    schemaVersion: 5,
    source: "flow-agents-routeback-disclosure-test",
    claims: entries.map((entry) => entry.claim),
    evidence: entries.map((entry) => entry.evidence),
    policies: [],
    events: entries.map((entry) => entry.event),
  }, null, 2));
  return syncBuilderFlowSession({ sessionDir: session.sessionDir });
}

async function buildExecuteFixture(slug) {
  const subject = `local:work-item/${slug}`;
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${slug}-`));
  const artifactRoot = path.join(projectRoot, ".kontourai", "flow-agents");
  const sessionDir = path.join(artifactRoot, slug);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "state.json"), JSON.stringify({
    schema_version: "1.0", task_slug: slug, status: "planned", phase: "planning",
    updated_at: new Date().toISOString(), work_item_refs: [subject],
    next_action: { status: "continue", summary: "Start Builder." },
  }, null, 2));
  fs.writeFileSync(path.join(artifactRoot, "current.json"), JSON.stringify({ active_slug: slug, artifact_dir: slug, updated_at: new Date().toISOString() }, null, 2));
  const ambient = resolveCurrentAssignmentActor();
  performLocalClaim(artifactRoot, slug, ambient.actor, {
    ttlSeconds: 1800, actorKey: ambient.actorKey, branch: `agent/${slug}`,
    artifactDir: slug, workItemRef: subject, reason: "routeback disclosure fixture",
  });
  await startBuilderFlowSession({ sessionDir });
  const session = { projectRoot, sessionDir, slug, subject };
  await writeAndSync(session, [bundleClaim({ expectation: "selected-work", claimType: "builder.pull-work.selected", subjectType: "work-item", stepId: "pull-work", subject })]);
  await writeAndSync(session, [
    bundleClaim({ expectation: "pickup-probe-readiness", claimType: "builder.design-probe.pickup-readiness", subjectType: "work-item", stepId: "design-probe", subject }),
    bundleClaim({ expectation: "probe-decisions-or-accepted-gaps", claimType: "builder.design-probe.decisions", subjectType: "decision", stepId: "design-probe", subject }),
  ]);
  const executing = await writeAndSync(session, [bundleClaim({ expectation: "implementation-plan", claimType: "builder.plan.implementation", subjectType: "artifact", stepId: "plan", subject })]);
  assert.equal(executing.run.state.current_step, "execute", "fixture must reach the routed execute gate");
  return session;
}

test("success path: a fail that actually routes reports the observed transition, PRE facts first", async () => {
  const session = await buildExecuteFixture("routeback-disclosure");
  try {
    const result = spawnSync(process.execPath, [CLI, "workflow", "evidence",
      "--session-dir", session.sessionDir,
      "--expectation", "implementation-scope", "--status", "fail",
      "--route-reason", "plan_gap",
      "--summary", "routeback disclosure success-path fixture",
    ], { cwd: session.projectRoot, encoding: "utf8", env: { ...process.env } });
    assert.equal(result.status, 0, `holder-actor route recording must succeed: ${result.stderr}`);

    // PRE half: subjunctive facts only — declared map quoted, persisted history, no outcome claim.
    const preMatch = result.stderr.match(/^\[workflow\] NOTICE: recording fail for implementation-scope at execute-gate can spend a bounded route-back attempt: this gate declares route-backs \(plan_gap -> plan\); route-back attempts already recorded at this gate: 0 of 3; a route-back invalidates current-visit verification evidence \(critique\/tests must be re-recorded\)\.$/m);
    assert.ok(preMatch, `PRE facts line missing or reworded: ${result.stderr}`);
    assert.ok(!PREDICTION_VOCABULARY.test(preMatch[0]), "the PRE line must never claim an outcome");

    // POST half: assert against the STATE, not against the helper — compose the expected line
    // from the route_back transition evaluation actually persisted.
    const state = JSON.parse(fs.readFileSync(path.join(runDir(session.slug, session.projectRoot), "state.json"), "utf8"));
    const routeBacks = state.transitions.filter((transition) => transition.type === "route_back");
    assert.equal(routeBacks.length, 1, "exactly one route_back transition must be persisted");
    const persisted = routeBacks[0];
    assert.equal(state.current_step, persisted.to_step);
    const expectedPost = `[workflow evidence] NOTICE: recorded fail for implementation-scope routed the run back to '${persisted.to_step}' (route-back attempt ${persisted.attempt} of ${persisted.max_attempts}, reason ${persisted.route_reason}); current-visit verification evidence (critique/tests) must be re-recorded.`;
    assert.ok(result.stderr.includes(expectedPost), `POST line must quote the persisted transition verbatim.\nexpected: ${expectedPost}\nstderr: ${result.stderr}`);

    // Ordering: facts before the mutation, observation after it.
    assert.ok(result.stderr.indexOf(preMatch[0]) < result.stderr.indexOf(expectedPost), "PRE facts must precede the observed outcome");
  } finally {
    fs.rmSync(session.projectRoot, { recursive: true, force: true });
  }
});

test("direct sidecar record-gate-claim discloses the same PRE facts before its bundle write", async () => {
  const session = await buildExecuteFixture("routeback-sidecar");
  try {
    const result = spawnSync(process.execPath, [SIDECAR, "record-gate-claim", session.sessionDir,
      "--expectation", "implementation-scope", "--status", "fail",
      "--route-reason", "plan_gap",
      "--summary", "routeback sidecar disclosure fixture",
    ], { cwd: session.projectRoot, encoding: "utf8", env: { ...process.env } });
    assert.equal(result.status, 0, `direct sidecar fail claim must succeed: ${result.stderr}`);
    assert.match(result.stderr, /\[workflow\] NOTICE: recording fail for implementation-scope at execute-gate can spend a bounded route-back attempt: this gate declares route-backs \(plan_gap -> plan\); route-back attempts already recorded at this gate: 0 of 3/);
    assert.ok(!PREDICTION_VOCABULARY.test(result.stderr), "the sidecar PRE line must never claim an outcome");
  } finally {
    fs.rmSync(session.projectRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The live #1304 shape, on the REAL shipped merge-ready-ci gate declaration.
// ---------------------------------------------------------------------------

function kitMergeReadyRun() {
  const publishLearn = JSON.parse(fs.readFileSync(KIT_PUBLISH_LEARN, "utf8"));
  const kitGate = publishLearn.gates["merge-ready-ci-gate"];
  assert.equal(kitGate.requires_current_verification, true, "fixture drift: the kit no longer declares requires_current_verification on merge-ready-ci-gate");
  return {
    definition: { id: "fixture.flow", version: "1.0", steps: [{ id: "merge-ready-ci", next: null }], gates: { "merge-ready-ci-gate": kitGate } },
    state: { status: "active", current_step: "merge-ready-ci", transitions: [] },
  };
}

test("not_verified at merge-ready-ci: no route is claimed, the live-claim truth is reported, publish-first keys off the record's absence", () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "routeback-mrci-"));
  try {
    const run = kitMergeReadyRun();
    // PRE: facts + publish-first (no provisional delivery record exists).
    const withoutRecord = routeBackDisclosureLines(run, "ci-merge-readiness", "not_verified", sessionDir);
    assert.equal(withoutRecord.length, 2);
    assert.match(withoutRecord[0], /declares route-backs \(/);
    assert.match(withoutRecord[0], /missing_evidence -> verify/);
    assert.match(withoutRecord[0], /route-back attempts already recorded at this gate: 0 of 3/);
    assert.ok(!PREDICTION_VOCABULARY.test(withoutRecord[0]), `the PRE line must not claim an outcome: ${withoutRecord[0]}`);
    assert.match(withoutRecord[1], /declares requires_current_verification and no provisional delivery record exists/);
    assert.match(withoutRecord[1], /publish the provisional delivery BEFORE recording this gate; a live non-pass claim here blocks the publish that would resolve it/);

    // With a provisional delivery record on disk the ordering guidance is moot — fs fact, not a
    // gate name, controls the line (kit-generic #1280).
    fs.writeFileSync(path.join(sessionDir, "provisional-delivery.json"), "{}");
    const withRecord = routeBackDisclosureLines(run, "ci-merge-readiness", "not_verified", sessionDir);
    assert.equal(withRecord.length, 1, "the publish-first rule must key off the provisional record's absence");
    assert.ok(!withRecord.some((line) => /publish the provisional delivery/.test(line)));

    // POST: evaluation withheld the claim — no transition appended. The truthful report is the
    // live non-pass claim at the unchanged step, never a route.
    const outcome = routeBackOutcomeLines(run.state, run.state.transitions.length, "ci-merge-readiness", "not_verified");
    assert.equal(outcome.length, 1);
    assert.match(outcome[0], /the run did not route — it remains at 'merge-ready-ci', and a non-pass claim recorded here sits live until superseded/);
    assert.ok(!/routed the run back/.test(outcome[0]));
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Budget-edge honesty and non-firing shapes (hand-shaped, seam-test pattern).
// ---------------------------------------------------------------------------

function handShapedRun({ transitions = [], gateExtras = {} } = {}) {
  return {
    definition: {
      id: "fixture.flow",
      version: "1.0",
      steps: [{ id: "closeout", next: null }],
      gates: {
        "closeout-gate": {
          step: "closeout",
          on_route_back: { implementation_defect: "execute", default: "verify" },
          route_back_policy: { max_attempts: 3, on_exceeded: "block" },
          expects: [{
            id: "closeout-readiness", kind: "trust.bundle", required: true,
            bundle_claim: { claimType: "fixture.readiness", subjectType: "flow-step", accepted_statuses: ["verified"] },
          }],
          ...gateExtras,
        },
      },
    },
    state: { status: "active", current_step: "closeout", transitions },
  };
}

test("budget edges: the PRE half reads persisted history verbatim and stays subjunctive; the POST half derives blocked/routed from the appended transition", () => {
  const routeBack = (attempt) => ({ type: "route_back", gate_id: "closeout-gate", route_reason: "implementation_defect", from_step: "closeout", to_step: "execute", status: "blocked", attempt, retry_epoch: 1, max_attempts: 3, limit_exceeded: false, at: new Date().toISOString() });
  const exhausted = handShapedRun({ transitions: [routeBack(1), routeBack(2), routeBack(3)] });
  const pre = routeBackDisclosureLines(exhausted, "closeout-readiness", "fail", undefined);
  assert.equal(pre.length, 1);
  assert.match(pre[0], /route-back attempts already recorded at this gate: 3 of 3/);
  assert.ok(!PREDICTION_VOCABULARY.test(pre[0]), `even at an exhausted budget the PRE line asserts no outcome: ${pre[0]}`);

  // POST, blocked: evaluation appended a limit_exceeded route_back and blocked the run.
  const blockedTransition = { type: "route_back", gate_id: "closeout-gate", route_reason: "implementation_defect", from_step: "closeout", to_step: "execute", status: "blocked", attempt: 4, retry_epoch: 1, max_attempts: 3, limit_exceeded: true, at: new Date().toISOString() };
  const blockedLines = routeBackOutcomeLines(
    { status: "blocked", current_step: "closeout", transitions: [...exhausted.state.transitions, blockedTransition] },
    exhausted.state.transitions.length,
    "closeout-readiness",
    "fail",
  );
  assert.equal(blockedLines.length, 1);
  assert.match(blockedLines[0], /route-back budget exhausted \(attempt 4 of 3\); the run did not route and is BLOCKED at 'closeout'/);
  assert.ok(!/routed the run back/.test(blockedLines[0]));

  // POST, routed: the reported step/attempt come verbatim from the appended transition.
  const routedLines = routeBackOutcomeLines(
    { status: "active", current_step: "execute", transitions: [routeBack(1)] },
    0,
    "closeout-readiness",
    "fail",
  );
  assert.equal(routedLines.length, 1);
  assert.match(routedLines[0], /routed the run back to 'execute' \(route-back attempt 1 of 3, reason implementation_defect\)/);
});

test("a pass record, a fail at a gate without a route map, and an unknown expectation disclose nothing", () => {
  const routed = handShapedRun();
  assert.deepEqual(routeBackDisclosureLines(routed, "closeout-readiness", "pass", undefined), []);
  assert.deepEqual(routeBackDisclosureLines(routed, "unknown-expectation", "fail", undefined), []);
  const unrouted = handShapedRun();
  delete unrouted.definition.gates["closeout-gate"].on_route_back;
  assert.deepEqual(routeBackDisclosureLines(unrouted, "closeout-readiness", "fail", undefined), []);
});

test("existing route refusal strings stay byte-identical (consumer safety)", () => {
  // Consumers substring-match these pre-#1304 literals; the disclosure is ADDITIVE output. If
  // this test fails, a consumer sweep is required before shipping new text.
  const definition = { gates: { "execute-gate": { step: "execute", on_route_back: { plan_gap: "plan" } } } };
  assert.throws(
    () => assertExecuteFailureRouteBeforeMutation(definition, "execute", "fail", undefined),
    (error) => {
      assert.equal(error.message, "workflow evidence --route-reason is required for failed execute evidence");
      return true;
    },
  );
  assert.throws(
    () => assertExecuteFailureRouteBeforeMutation(definition, "execute", "fail", "undeclared_reason"),
    (error) => {
      assert.equal(error.message, "workflow evidence --route-reason undeclared_reason is not declared by the active execute gate");
      return true;
    },
  );
  // non-triggering shapes still return silently
  assert.doesNotThrow(() => assertExecuteFailureRouteBeforeMutation(definition, "execute", "pass", undefined));
  assert.doesNotThrow(() => assertExecuteFailureRouteBeforeMutation(definition, "verify", "fail", undefined));
});
