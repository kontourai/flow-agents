// #1304: route-back cost disclosure at the point of use — observe, don't predict.
//
// The disclosure has two halves split along declared-versus-observed lines. The PRE half
// (routeBackDisclosureLines, shared with the sidecar writer) states only facts that exist before
// the mutation: the DECLARED route map, the PERSISTED per-reason attempt history (Flow accounts
// attempts per route identity — a single aggregated number would claim an accounting Flow does
// not make), the invalidation rule, and — when a requires_current_verification gate has no
// VERIFYING provisional delivery (production predicate; absent, stale, and invalid records all
// throw) — the publish-first ordering rule. It never predicts what evaluation will decide: the
// first design derived routeBackDecision pre-mutation and was blocked by independent review
// because that prediction LIES in the live #1304 scenario (an unpublished not_verified at
// merge-ready-ci is WITHHELD, not routed). The POST half (routeBackOutcomeLines) reports what
// evaluation actually did, verbatim from the transitions the mutation appended. AC1 was amended
// accordingly (explicitly, per the review's prescription — see the session pull-work Decisions).
//
// Layered proof note: reaching merge-ready-ci in a real run needs an authenticated
// ChangeProvider (same gap as the freshness-turnstile tests); the live no-route truth is proven
// through REAL evaluation at the shipped verify-gate, and the merge-ready-ci declaration drives
// the helpers directly. Run: `npm run test:unit`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { flowRunHead, runDir } from "@kontourai/flow";
import { routeBackDisclosureLines } from "../../build/src/cli/workflow-sidecar.js";
import { assertExecuteFailureRouteBeforeMutation, assertTerminalDeliveryWorkspaceEvidence, routeBackOutcomeLines } from "../../build/src/cli/workflow.js";
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

const EXECUTE_PRE_FACTS = "[workflow] NOTICE: recording fail for implementation-scope at execute-gate can spend a bounded route-back attempt: this gate declares route-backs (plan_gap -> plan); route-back attempts recorded at this gate: none (budget max 3; Flow accounts attempts per route identity — reason/loop/epoch); a route-back invalidates current-visit verification evidence (critique/tests must be re-recorded).";

// ---------------------------------------------------------------------------
// Real-run fixture: a builder.build session advanced to the execute (or
// verify) step — the same claim shapes the builder-runtime suite uses.
// ---------------------------------------------------------------------------

function bundleClaim({ expectation, claimType, subjectType, stepId, subject, status = "pass" }) {
  const timestamp = new Date().toISOString();
  const claimId = `claim.${expectation}`;
  return {
    claim: {
      id: claimId,
      subjectType,
      subjectId: `routeback-disclosure/gate-claim-${expectation}`,
      claimType,
      fieldOrBehavior: `${expectation} fixture`,
      value: status,
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
      id: `event.${expectation}`, claimId, status: status === "pass" ? "verified" : "disputed", actor: "flow-agents-test", method: "attestation",
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

async function buildFixture(slug, toStep = "execute") {
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
  let synced = await writeAndSync(session, [bundleClaim({ expectation: "implementation-plan", claimType: "builder.plan.implementation", subjectType: "artifact", stepId: "plan", subject })]);
  if (toStep === "verify") {
    synced = await writeAndSync(session, [bundleClaim({ expectation: "implementation-scope", claimType: "builder.execute.scope", subjectType: "change", stepId: "execute", subject })]);
  }
  assert.equal(synced.run.state.current_step, toStep, `fixture must reach the ${toStep} step`);
  return session;
}

test("success path: a fail that actually routes reports the observed transition, PRE facts first", async () => {
  const session = await buildFixture("routeback-disclosure");
  try {
    const result = spawnSync(process.execPath, [CLI, "workflow", "evidence",
      "--session-dir", session.sessionDir,
      "--expectation", "implementation-scope", "--status", "fail",
      "--route-reason", "plan_gap",
      "--summary", "routeback disclosure success-path fixture",
    ], { cwd: session.projectRoot, encoding: "utf8", env: { ...process.env } });
    assert.equal(result.status, 0, `holder-actor route recording must succeed: ${result.stderr}`);

    // PRE half: subjunctive facts only — declared map quoted, persisted history, no outcome claim.
    assert.ok(result.stderr.includes(EXECUTE_PRE_FACTS), `PRE facts line missing or reworded: ${result.stderr}`);
    assert.ok(!PREDICTION_VOCABULARY.test(EXECUTE_PRE_FACTS), "the PRE line must never claim an outcome");

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
    assert.ok(result.stderr.indexOf(EXECUTE_PRE_FACTS) < result.stderr.indexOf(expectedPost), "PRE facts must precede the observed outcome");
  } finally {
    fs.rmSync(session.projectRoot, { recursive: true, force: true });
  }
});

test("live not_verified through REAL evaluation at the shipped verify-gate: no route, live-claim truth from actual run state", async () => {
  // The exact #1304 failure shape, recorded via the writer + sync (not a manual helper call):
  // a not_verified claim at a route-mapped shipped gate. Evaluation must not route, and the POST
  // half must report the live non-pass claim from the state evaluation actually left behind.
  const session = await buildFixture("routeback-nv-live", "verify");
  try {
    const result = spawnSync(process.execPath, [CLI, "workflow", "evidence",
      "--session-dir", session.sessionDir,
      "--expectation", "tests-evidence", "--status", "not_verified",
      "--summary", "routeback live not_verified fixture",
    ], { cwd: session.projectRoot, encoding: "utf8", env: { ...process.env } });
    assert.equal(result.status, 0, `recording a live not_verified must succeed: ${result.stderr}`);

    // PRE facts for the shipped verify-gate: full declared map, no history, no outcome claim.
    assert.match(result.stderr, /\[workflow\] NOTICE: recording not_verified for tests-evidence at verify-gate can spend a bounded route-back attempt: this gate declares route-backs \(missing_evidence -> verify, implementation_defect -> execute, plan_gap -> plan, decision_gap -> design-probe, default -> verify\); route-back attempts recorded at this gate: none/);

    // The actual run state: evaluation appended NO route_back and the cursor did not move.
    const state = JSON.parse(fs.readFileSync(path.join(runDir(session.slug, session.projectRoot), "state.json"), "utf8"));
    assert.equal(state.current_step, "verify");
    assert.equal(state.transitions.filter((transition) => transition.type === "route_back").length, 0, "a live not_verified must not spend a route-back");

    // The POST half reports that truth — and never a route.
    assert.match(result.stderr, /\[workflow evidence\] NOTICE: recorded not_verified for tests-evidence; the run did not route — it remains at 'verify', and a non-pass claim recorded here sits live until superseded\./);
    assert.ok(!/routed the run back/.test(result.stderr));
  } finally {
    fs.rmSync(session.projectRoot, { recursive: true, force: true });
  }
});

test("direct sidecar record-gate-claim: the NOTICE precedes the write effect", async () => {
  const session = await buildFixture("routeback-sidecar");
  try {
    // Happy path: the same PRE facts as the public writer.
    const disclosed = spawnSync(process.execPath, [SIDECAR, "record-gate-claim", session.sessionDir,
      "--expectation", "implementation-scope", "--status", "fail",
      "--route-reason", "plan_gap",
      "--summary", "routeback sidecar disclosure fixture",
    ], { cwd: session.projectRoot, encoding: "utf8", env: { ...process.env } });
    assert.equal(disclosed.status, 0, `direct sidecar fail claim must succeed: ${disclosed.stderr}`);
    assert.ok(disclosed.stderr.includes(EXECUTE_PRE_FACTS), `sidecar PRE facts line missing or reworded: ${disclosed.stderr}`);
  } finally {
    fs.rmSync(session.projectRoot, { recursive: true, force: true });
  }

  // Ordering proof: induce a write failure AFTER the emission point (the bundle path is made
  // unreadable/unwritable as a file) — the NOTICE must still print while the write effect is
  // provably absent.
  const failing = await buildFixture("routeback-sidecar-fail");
  try {
    const bundleFile = path.join(failing.sessionDir, "trust.bundle");
    fs.rmSync(bundleFile);
    fs.mkdirSync(bundleFile);
    const refused = spawnSync(process.execPath, [SIDECAR, "record-gate-claim", failing.sessionDir,
      "--expectation", "implementation-scope", "--status", "fail",
      "--route-reason", "plan_gap",
      "--summary", "routeback sidecar write-failure fixture",
    ], { cwd: failing.projectRoot, encoding: "utf8", env: { ...process.env } });
    assert.notEqual(refused.status, 0, "the bundle write must fail");
    assert.ok(refused.stderr.includes(EXECUTE_PRE_FACTS), `the NOTICE must precede the failed write: ${refused.stderr}`);
    assert.ok(fs.statSync(bundleFile).isDirectory(), "no bundle write may have occurred");
  } finally {
    fs.rmSync(failing.projectRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The live #1304 declaration, on the REAL shipped merge-ready-ci gate.
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

test("not_verified at merge-ready-ci: no route is claimed, publish-first runs the PRODUCTION delivery predicate", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "routeback-mrci-"));
  const sessionDir = path.join(projectRoot, ".kontourai", "flow-agents", "routeback-mrci");
  fs.mkdirSync(sessionDir, { recursive: true });
  try {
    const run = kitMergeReadyRun();
    const productionVerifier = () => assertTerminalDeliveryWorkspaceEvidence(sessionDir, projectRoot, "routeback-mrci");

    // No provisional delivery record: the predicate throws, the guidance shows.
    const absent = routeBackDisclosureLines(run, "ci-merge-readiness", "not_verified", productionVerifier);
    assert.equal(absent.length, 2);
    assert.match(absent[0], /declares route-backs \(/);
    assert.match(absent[0], /missing_evidence -> verify/);
    assert.match(absent[0], /route-back attempts recorded at this gate: none/);
    assert.ok(!PREDICTION_VOCABULARY.test(absent[0]), `the PRE line must not claim an outcome: ${absent[0]}`);
    assert.match(absent[1], /declares requires_current_verification and no verifying provisional delivery exists/);
    assert.match(absent[1], /publish the provisional delivery BEFORE recording this gate; a live non-pass claim here blocks the publish that would resolve it/);

    // An INVALID record on disk must KEEP the guidance — existence is not verification; the
    // production predicate still throws (absent, stale, invalid all mean publish-first applies).
    fs.writeFileSync(path.join(sessionDir, "provisional-delivery.json"), "{}");
    const invalidRecord = routeBackDisclosureLines(run, "ci-merge-readiness", "not_verified", productionVerifier);
    assert.equal(invalidRecord.length, 2, "an invalid provisional delivery record must not suppress the publish-first guidance");
    assert.match(invalidRecord[1], /publish the provisional delivery BEFORE recording this gate/);

    // Suppressed side (unit seam: a verifying delivery is not fabricable in a fixture — a
    // non-throwing verifier stands in for the production predicate's success).
    const verifying = routeBackDisclosureLines(run, "ci-merge-readiness", "not_verified", () => ({}));
    assert.equal(verifying.length, 1, "only a VERIFYING provisional delivery suppresses the guidance");
    assert.ok(!verifying.some((line) => /publish the provisional delivery/.test(line)));

    // POST: evaluation withheld the claim — no transition appended. The truthful report is the
    // live non-pass claim at the unchanged step, never a route.
    const outcome = routeBackOutcomeLines(run.state, run.state.transitions.length, "ci-merge-readiness", "not_verified");
    assert.equal(outcome.length, 1);
    assert.match(outcome[0], /the run did not route — it remains at 'merge-ready-ci', and a non-pass claim recorded here sits live until superseded/);
    assert.ok(!/routed the run back/.test(outcome[0]));

    // A recovered replay appends nothing this invocation: the no-route line is suppressed
    // rather than asserted about a mutation this invocation did not perform.
    assert.deepEqual(routeBackOutcomeLines(run.state, run.state.transitions.length, "ci-merge-readiness", "not_verified", { reportNoRoute: false }), []);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
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
          on_route_back: { missing_evidence: "closeout", implementation_defect: "execute", default: "verify" },
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

function routeBack({ reason, attempt, toStep = "execute", limitExceeded = false }) {
  return { type: "route_back", gate_id: "closeout-gate", route_reason: reason, from_step: "closeout", to_step: toStep, status: "blocked", attempt, retry_epoch: 1, max_attempts: 3, limit_exceeded: limitExceeded, at: new Date().toISOString() };
}

test("budget edges: the PRE half lists PER-REASON recorded attempts (no aggregate) and stays subjunctive; the POST half derives blocked/routed from the appended transition", () => {
  // Two distinct route identities at different attempt counts: Flow budgets them separately, so
  // the disclosure must list them separately — a single aggregated number would be a claim the
  // accounting does not make.
  const twoReasons = handShapedRun({
    transitions: [
      routeBack({ reason: "missing_evidence", attempt: 1, toStep: "closeout" }),
      routeBack({ reason: "missing_evidence", attempt: 2, toStep: "closeout" }),
      routeBack({ reason: "missing_evidence", attempt: 3, toStep: "closeout" }),
      routeBack({ reason: "implementation_defect", attempt: 1 }),
    ],
  });
  const pre = routeBackDisclosureLines(twoReasons, "closeout-readiness", "fail", undefined);
  assert.equal(pre.length, 1);
  assert.match(pre[0], /route-back attempts recorded at this gate: missing_evidence 3, implementation_defect 1 \(budget max 3; Flow accounts attempts per route identity — reason\/loop\/epoch\)/);
  assert.ok(!PREDICTION_VOCABULARY.test(pre[0]), `even at an exhausted budget the PRE line asserts no outcome: ${pre[0]}`);

  // POST, blocked: evaluation appended a limit_exceeded route_back and blocked the run.
  const blockedTransition = routeBack({ reason: "implementation_defect", attempt: 4, limitExceeded: true });
  const blockedLines = routeBackOutcomeLines(
    { status: "blocked", current_step: "closeout", transitions: [...twoReasons.state.transitions, blockedTransition] },
    twoReasons.state.transitions.length,
    "closeout-readiness",
    "fail",
  );
  assert.equal(blockedLines.length, 1);
  assert.match(blockedLines[0], /route-back budget exhausted \(attempt 4 of 3\); the run did not route and is BLOCKED at 'closeout'/);
  assert.ok(!/routed the run back/.test(blockedLines[0]));

  // POST, routed: the reported step/attempt come verbatim from the appended transition.
  const routedLines = routeBackOutcomeLines(
    { status: "active", current_step: "execute", transitions: [routeBack({ reason: "implementation_defect", attempt: 1 })] },
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
