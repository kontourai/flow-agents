// #1304: route-back cost disclosure at the point of use — observe, don't predict.
//
// The disclosure has two halves split along declared-versus-observed lines. The PRE half
// (routeBackDisclosureLines, shared with the sidecar writer) states only facts that exist before
// the mutation: the DECLARED route map, the PERSISTED attempt history grouped by Flow's real
// budget identity (normalized reason + loop + retry epoch — anything less granular claims an
// accounting Flow does not make), the invalidation rule, and — at requires_current_verification
// gates — the publish-first rule, suppressed ONLY by a VERIFYING provisional delivery record.
// Fresh current verification evidence must never suppress it: that is exactly the pre-trap state
// (recording a non-pass claim makes the evidence stale and blocks the publish that would resolve
// it). The PRE half never predicts what evaluation will decide: the first design derived
// routeBackDecision pre-mutation and was blocked by independent review because that prediction
// LIES in the live #1304 scenario (an unpublished not_verified at merge-ready-ci is WITHHELD,
// not routed). The POST half (routeBackOutcomeLines) reports what evaluation actually did,
// verbatim from the transitions the committed mutation (fresh OR recovered) appended. AC1 was
// amended accordingly (explicitly, per the review's prescription — see the session pull-work
// Decisions).
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
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { flowRunHead, runDir } from "@kontourai/flow";
import { assertCurrentVerifiedWorkspaceEvidence, emitRecordGateClaimRouteBackDisclosure, routeBackDisclosureLines } from "../../build/src/cli/workflow-sidecar.js";
import {
  assertExecuteFailureRouteBeforeMutation,
  assertTerminalDeliveryWorkspaceEvidence,
  assertVerifiedProvisionalDeliveryRecord,
  main as workflowMain,
  routeBackOutcomeLines,
  setWorkflowEvidenceTransactionTestHooksForTest,
} from "../../build/src/cli/workflow.js";
import { captureReviewWorkspaceSnapshot, startBuilderFlowSession, syncBuilderFlowSession } from "../../build/src/builder-flow-runtime.js";
import { CRITIQUE_CHAIN_GENESIS, critiqueRecordHash } from "../../build/src/cli/critique-resolution.js";
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

const EXECUTE_PRE_FACTS = "[workflow] NOTICE: recording fail for implementation-scope at execute-gate can spend a bounded route-back attempt: this gate declares route-backs (plan_gap -> plan); route-back attempts recorded at this gate: none (budget max 3 per route identity); a route-back invalidates current-visit verification evidence (critique/tests must be re-recorded).";

// ---------------------------------------------------------------------------
// Real-run fixture: a builder.build session advanced to the execute (or
// verify) step — the same claim shapes the builder-runtime suite uses.
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

test("a recovered commit reports its observed outcome exactly like a fresh one", async () => {
  // "recovered" means THIS invocation's candidate was canonically attached and only a LATER
  // operation failed — the observed outcome exists and must be reported. Induce a
  // post-attachment failure (beforePostconditions) on a routing fail: evaluation commits the
  // route, the transaction recovers, and the POST line still quotes the persisted transition.
  const session = await buildFixture("routeback-recovered");
  const captured = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => { captured.push(String(chunk)); return true; };
  setWorkflowEvidenceTransactionTestHooksForTest({
    beforePostconditions: () => { throw new Error("induced post-attachment failure"); },
  });
  let exitCode;
  try {
    exitCode = await workflowMain(["evidence",
      "--session-dir", session.sessionDir,
      "--expectation", "implementation-scope", "--status", "fail",
      "--route-reason", "plan_gap",
      "--summary", "routeback recovered fixture",
    ]);
  } finally {
    setWorkflowEvidenceTransactionTestHooksForTest(undefined);
    process.stderr.write = originalWrite;
  }
  try {
    const stderrText = captured.join("");
    assert.equal(exitCode, 0, `a recovered committed mutation must succeed: ${stderrText}`);
    const state = JSON.parse(fs.readFileSync(path.join(runDir(session.slug, session.projectRoot), "state.json"), "utf8"));
    const routeBacks = state.transitions.filter((transition) => transition.type === "route_back");
    assert.equal(routeBacks.length, 1, "the induced failure fires AFTER canonical attachment: the route is committed");
    const persisted = routeBacks[0];
    assert.ok(stderrText.includes(`routed the run back to '${persisted.to_step}' (route-back attempt ${persisted.attempt} of ${persisted.max_attempts}, reason ${persisted.route_reason})`),
      `a recovered commit must report the observed route: ${stderrText}`);
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

test("not_verified at merge-ready-ci: no route is claimed, publish-first keys off the provisional RECORD verifier", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "routeback-mrci-"));
  const sessionDir = path.join(projectRoot, ".kontourai", "flow-agents", "routeback-mrci");
  fs.mkdirSync(sessionDir, { recursive: true });
  try {
    const run = kitMergeReadyRun();
    const recordVerifier = () => assertVerifiedProvisionalDeliveryRecord(sessionDir, projectRoot, "routeback-mrci");

    // No provisional delivery record: the verifier throws, the guidance shows.
    const absent = routeBackDisclosureLines(run, "ci-merge-readiness", "not_verified", recordVerifier);
    assert.equal(absent.length, 2);
    assert.match(absent[0], /declares route-backs \(/);
    assert.match(absent[0], /missing_evidence -> verify/);
    assert.match(absent[0], /route-back attempts recorded at this gate: none/);
    assert.ok(!PREDICTION_VOCABULARY.test(absent[0]), `the PRE line must not claim an outcome: ${absent[0]}`);
    assert.match(absent[1], /declares requires_current_verification and no verifying provisional delivery exists/);
    assert.match(absent[1], /publish the provisional delivery BEFORE recording this gate; a live non-pass claim here blocks the publish that would resolve it/);

    // An INVALID record on disk must KEEP the guidance — existence is not verification.
    fs.writeFileSync(path.join(sessionDir, "provisional-delivery.json"), "{}");
    const invalidRecord = routeBackDisclosureLines(run, "ci-merge-readiness", "not_verified", recordVerifier);
    assert.equal(invalidRecord.length, 2, "an invalid provisional delivery record must not suppress the publish-first guidance");
    assert.match(invalidRecord[1], /publish the provisional delivery BEFORE recording this gate/);

    // Suppressed side (unit seam: a verifying delivery is not fabricable in a fixture — a
    // non-throwing verifier stands in for the record verifier's success).
    const verifying = routeBackDisclosureLines(run, "ci-merge-readiness", "not_verified", () => ({}));
    assert.equal(verifying.length, 1, "only a VERIFYING provisional delivery suppresses the guidance");
    assert.ok(!verifying.some((line) => /publish the provisional delivery/.test(line)));

    // POST: evaluation withheld the claim — no transition appended. The truthful report is the
    // live non-pass claim at the unchanged step, never a route.
    const outcome = routeBackOutcomeLines(run.state, run.state.transitions.length, "ci-merge-readiness", "not_verified");
    assert.equal(outcome.length, 1);
    assert.match(outcome[0], /the run did not route — it remains at 'merge-ready-ci', and a non-pass claim recorded here sits live until superseded/);
    assert.ok(!/routed the run back/.test(outcome[0]));
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("publish-first suppression keys off the provisional RECORD, never the whole evidence predicate", () => {
  // The discriminating fixture: FRESH current verification evidence and NO provisional record —
  // the exact pre-trap state, where recording a non-pass claim would make that evidence stale
  // and block the publish that would resolve it. The whole evidence predicate ACCEPTS this state
  // (its strict branch never examines the record), so keying suppression to it would hide the
  // guidance precisely when it is needed; the record verifier correctly throws.
  const slug = "routeback-fresh";
  const subject = `local:work-item/${slug}`;
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${slug}-`));
  try {
    const sessionDir = path.join(projectRoot, ".kontourai", "flow-agents", slug);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, "review-target"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "review-target", "implementation.txt"), "reviewed implementation\n");
    fs.writeFileSync(path.join(projectRoot, "review-target", "delivery.md"), "reviewed delivery artifact\n");
    fs.writeFileSync(path.join(projectRoot, ".gitignore"), ".kontourai/\n");
    fs.writeFileSync(path.join(sessionDir, "state.json"), JSON.stringify({
      schema_version: "1.0", task_slug: slug, status: "verifying", phase: "verification",
      updated_at: new Date().toISOString(), work_item_refs: [subject],
      next_action: { status: "continue", summary: "fixture" },
    }, null, 2));
    execFileSync("git", ["init", "-q"], { cwd: projectRoot });
    execFileSync("git", ["config", "user.email", "fixture@example.test"], { cwd: projectRoot });
    execFileSync("git", ["config", "user.name", "Fixture"], { cwd: projectRoot });
    execFileSync("git", ["add", "-A"], { cwd: projectRoot });
    execFileSync("git", ["commit", "-q", "-m", "workspace fixture"], { cwd: projectRoot });

    const timestamp = new Date().toISOString();
    const snapshot = captureReviewWorkspaceSnapshot(projectRoot, []);
    assert.equal(snapshot.worktree_clean, true, "the fresh-evidence fixture must capture a clean worktree");
    const critiqueRecord = {
      critique_sequence: 1,
      critique_predecessor_hash: CRITIQUE_CHAIN_GENESIS,
      reviewer: "reviewer-actor",
      reviewed_at: timestamp,
      verdict: "pass",
      summary: "clean critique fixture",
      lanes: [{ id: "code", status: "pass" }],
      review_target: {
        artifacts: [{ file: "review-target/delivery.md", sha256: createHash("sha256").update(fs.readFileSync(path.join(projectRoot, "review-target", "delivery.md"))).digest("hex") }],
        workspace_snapshot: snapshot,
      },
      findings: [],
      workflow_subject_ref: subject,
    };
    const critiqueHash = critiqueRecordHash(critiqueRecord);
    const critique = {
      id: "claim.clean-critique", subjectType: "workflow-critique", subjectId: `${slug}/gate-claim-clean-critique`,
      claimType: "workflow.critique.review", fieldOrBehavior: "clean critique fixture", value: "pass", status: "verified",
      metadata: {
        workflow_subject_ref: subject, origin: "critique", reviewer: "reviewer-actor", findings: [],
        lanes: critiqueRecord.lanes, review_target: critiqueRecord.review_target,
        reviewed_at: timestamp, critique_sequence: 1, critique_predecessor_hash: CRITIQUE_CHAIN_GENESIS,
        critique_record_hash: critiqueHash, critique_record_id: `critique:${critiqueHash}`,
      },
      createdAt: timestamp, updatedAt: timestamp,
    };
    const tests = {
      id: "claim.tests-evidence", subjectType: "flow-step", subjectId: `${slug}/gate-claim-tests-evidence`,
      claimType: "builder.verify.tests", fieldOrBehavior: "tests fixture", value: "pass", status: "verified",
      metadata: {
        workflow_subject_ref: subject, origin: "check", check_kind: "external",
        gate_claim: { expectation_id: "tests-evidence", claim_type: "builder.verify.tests", subject_type: "flow-step", step_id: "verify", recorded_at: timestamp, identity_version: 2 },
        verification_workspace_snapshot: snapshot,
        observed_commands: [{ command: "node --test src/cli/routeback-disclosure.test.mjs", exit_code: 0, test_count: 1, output_sha256: "0".repeat(64), observed_at_commit: snapshot.head_sha, worktree_clean: true, verification_workspace_snapshot: structuredClone(snapshot) }],
      },
      createdAt: timestamp, updatedAt: timestamp,
    };
    fs.writeFileSync(path.join(sessionDir, "trust.bundle"), JSON.stringify({
      schemaVersion: 5, source: "routeback-fresh-fixture",
      claims: [critique, tests],
      evidence: [
        { id: "evidence.clean-critique", claimId: critique.id, evidenceType: "human_attestation", method: "attestation", sourceRef: "fixture", excerptOrSummary: "critique fixture", observedAt: timestamp, collectedBy: "flow-agents-test" },
        { id: "evidence.tests-evidence", claimId: tests.id, evidenceType: "human_attestation", method: "attestation", sourceRef: "fixture", excerptOrSummary: "tests fixture", observedAt: timestamp, collectedBy: "flow-agents-test", passing: true, execution: { runner: "bash", label: tests.metadata.observed_commands[0].command, isError: false, exitCode: 0 } },
      ],
      policies: [],
      events: [
        { id: "event.clean-critique", claimId: critique.id, status: "verified", actor: "flow-agents-test", method: "attestation", evidenceIds: ["evidence.clean-critique"], createdAt: timestamp, verifiedAt: timestamp },
        { id: "event.tests-evidence", claimId: tests.id, status: "verified", actor: "flow-agents-test", method: "attestation", evidenceIds: ["evidence.tests-evidence"], createdAt: timestamp, verifiedAt: timestamp },
      ],
    }, null, 2));

    // Precondition A: the strict branch accepts this session (fresh current verification).
    assert.doesNotThrow(() => assertCurrentVerifiedWorkspaceEvidence(sessionDir), "the fixture must present fresh current verification evidence");
    // Precondition B — the discriminator: the WHOLE evidence predicate accepts this state
    // without ever examining the (absent) provisional record.
    assert.doesNotThrow(() => assertTerminalDeliveryWorkspaceEvidence(sessionDir, projectRoot, slug), "the whole evidence predicate accepts the pre-trap state — which is why it is the wrong suppression key");
    // The RECORD verifier — the actual suppression key — throws: no verifying record exists.
    assert.throws(() => assertVerifiedProvisionalDeliveryRecord(sessionDir, projectRoot, slug), "the record verifier must reject a session without a provisional delivery record");

    // Therefore the guidance is KEPT in exactly the state that springs the trap.
    const lines = routeBackDisclosureLines(kitMergeReadyRun(), "ci-merge-readiness", "not_verified",
      () => assertVerifiedProvisionalDeliveryRecord(sessionDir, projectRoot, slug));
    assert.equal(lines.length, 2, "fresh current verification evidence must NOT suppress the publish-first guidance");
    assert.match(lines[1], /publish the provisional delivery BEFORE recording this gate/);
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

function routeBack({ reason, attempt, toStep = "execute", epoch = 1, limitExceeded = false }) {
  return { type: "route_back", gate_id: "closeout-gate", route_reason: reason, from_step: "closeout", to_step: toStep, status: "blocked", attempt, retry_epoch: epoch, max_attempts: 3, limit_exceeded: limitExceeded, at: new Date().toISOString() };
}

test("budget identity: the PRE half lists attempts per reason/loop/epoch verbatim and stays subjunctive; the POST half derives blocked/routed from the appended transition", () => {
  // Two distinct route identities at different attempt counts: Flow budgets them separately, so
  // the disclosure must list them separately — any aggregate would claim an accounting Flow
  // does not make.
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
  assert.match(pre[0], /route-back attempts recorded at this gate: missing_evidence closeout->closeout epoch 1: 3 attempts; implementation_defect closeout->execute epoch 1: 1 attempt \(budget max 3 per route identity\)/);
  assert.ok(!PREDICTION_VOCABULARY.test(pre[0]), `even at an exhausted budget the PRE line asserts no outcome: ${pre[0]}`);

  // TWO retry epochs for ONE reason/loop: the CURRENT epoch's count is what is named as
  // current; the closed epoch is history, parenthesized — never folded into one number.
  const twoEpochs = handShapedRun({
    transitions: [
      routeBack({ reason: "missing_evidence", attempt: 1, toStep: "closeout", epoch: 1 }),
      routeBack({ reason: "missing_evidence", attempt: 2, toStep: "closeout", epoch: 1 }),
      routeBack({ reason: "missing_evidence", attempt: 3, toStep: "closeout", epoch: 1 }),
      routeBack({ reason: "missing_evidence", attempt: 1, toStep: "closeout", epoch: 2 }),
    ],
  });
  const epochPre = routeBackDisclosureLines(twoEpochs, "closeout-readiness", "fail", undefined);
  assert.equal(epochPre.length, 1);
  assert.match(epochPre[0], /route-back attempts recorded at this gate: missing_evidence closeout->closeout epoch 2: 1 attempt \(epoch 1 closed at 3\) \(budget max 3 per route identity\)/);

  // An undeclared reason collapses to Flow's "default" budget key — never a fresh bucket.
  const undeclared = handShapedRun({ transitions: [routeBack({ reason: "invented_reason", attempt: 1, toStep: "verify" })] });
  const undeclaredPre = routeBackDisclosureLines(undeclared, "closeout-readiness", "fail", undefined);
  assert.match(undeclaredPre[0], /route-back attempts recorded at this gate: default closeout->verify epoch 1: 1 attempt/);

  // The CURRENT epoch consults retry_authorized, exactly as Flow's own epoch derivation does
  // (routeBackEpoch keys off the paired authorization): after epoch 1 exhausts and a retry is
  // authorized, Flow is at epoch 2 with nothing debited — a route_back-only scan would name the
  // CLOSED epoch as current (this assertion is its own discrimination: it reds under that scan).
  const authorized = handShapedRun({
    transitions: [
      routeBack({ reason: "missing_evidence", attempt: 1, toStep: "closeout", epoch: 1 }),
      routeBack({ reason: "missing_evidence", attempt: 2, toStep: "closeout", epoch: 1 }),
      routeBack({ reason: "missing_evidence", attempt: 3, toStep: "closeout", epoch: 1 }),
      routeBack({ reason: "missing_evidence", attempt: 4, toStep: "closeout", epoch: 1, limitExceeded: true }),
      { type: "retry_authorized", status: "retry-authorized", gate_id: "closeout-gate", route_reason: "missing_evidence", from_step: "closeout", to_step: "closeout", retry_epoch: 2, prior_retry_epoch: 1, at: new Date().toISOString() },
    ],
  });
  const authorizedPre = routeBackDisclosureLines(authorized, "closeout-readiness", "fail", undefined);
  assert.equal(authorizedPre.length, 1);
  assert.match(authorizedPre[0], /route-back attempts recorded at this gate: missing_evidence closeout->closeout epoch 2: 0 attempts \(authorized\) \(epoch 1 closed at 4\)/);

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

test("sidecar disclosure degrades loudly on real failures; only proven absence stays silent", async () => {
  // Direct test of the production benign-vs-loud decision (the extracted emission function).
  // Within record-gate-claim, the earlier signal-validation reader consumes the same canonical
  // files more strictly and fails the whole command CLOSED before any write (probed live:
  // EACCES/corrupt definition all die pre-disclosure with no claim written), so the loud line
  // is defense-in-depth for the failure classes that skip that reader — proven here directly.
  const capture = async (fn) => {
    const captured = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk) => { captured.push(String(chunk)); return true; };
    try { await fn(); } finally { process.stderr.write = originalWrite; }
    return captured.join("");
  };

  // LOUD: canonical layout, canonical run present, state.json unreadable (EACCES).
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "routeback-loud-"));
  try {
    const sessionDir = path.join(projectRoot, ".kontourai", "flow-agents", "routeback-loud");
    const flowDir = path.join(projectRoot, ".kontourai", "flow", "runs", "routeback-loud");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(flowDir, { recursive: true });
    fs.writeFileSync(path.join(flowDir, "definition.json"), "{}");
    fs.writeFileSync(path.join(flowDir, "state.json"), "{}");
    fs.chmodSync(path.join(flowDir, "state.json"), 0o000);
    const loud = await capture(() => emitRecordGateClaimRouteBackDisclosure(sessionDir, "routeback-loud", "implementation-scope", "fail"));
    assert.match(loud, /route-back disclosure unavailable \(module load failed\); a non-pass claim here may spend a route-back attempt and sit live/,
      "an unreadable canonical run state must degrade loudly, never read as benign absence");

    // BENIGN 1: canonical layout, run state ENOENT — proven absence stays silent.
    fs.rmSync(flowDir, { recursive: true, force: true });
    const absent = await capture(() => emitRecordGateClaimRouteBackDisclosure(sessionDir, "routeback-loud", "implementation-scope", "fail"));
    assert.equal(absent, "", "a proven-absent canonical run stays silent");
  } finally {
    try { fs.chmodSync(path.join(projectRoot, ".kontourai", "flow", "runs", "routeback-loud", "state.json"), 0o644); } catch { /* already removed */ }
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }

  // BENIGN 2: a non-canonical session layout stays silent (no gate can exist).
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "routeback-noncanonical-"));
  try {
    const silent = await capture(() => emitRecordGateClaimRouteBackDisclosure(path.join(plain, "session"), "x", "implementation-scope", "fail"));
    assert.equal(silent, "", "a non-canonical layout stays silent");
  } finally {
    fs.rmSync(plain, { recursive: true, force: true });
  }
});

test("a non-pass claim that never attaches ROLLS BACK: nothing is recorded, so nothing sits live undisclosed", async () => {
  // Reconciliation of the round-6 review premise: "an ATTACHED claim with zero route
  // transitions is the live-claim case and enters recovery". Reproduced live, it does not:
  // recovery structurally requires canonical attachment of THIS invocation's receipt
  // (classifyCanonicalEvidenceAttachment demands NEW manifest evidence entries), and for a
  // non-pass status every attachment appends a route_back (route, replay, or block) — while an
  // UNATTACHED live claim classifies "unattached" and the transaction rolls back. So the
  // recovered+no-route sub-case cannot arise; the POST helper is state-independent anyway
  // (recovered shares the exact code path — proven by the recovered routing test above). This
  // test pins the rolled-back truth: an induced post-attachment failure on a live not_verified
  // leaves NO canonical claim behind — nothing sits live, disclosed or otherwise.
  const session = await buildFixture("routeback-nv-rollback", "verify");
  const bundleBefore = fs.readFileSync(path.join(session.sessionDir, "trust.bundle"), "utf8");
  const stateFile = path.join(runDir(session.slug, session.projectRoot), "state.json");
  const canonicalBefore = fs.readFileSync(stateFile, "utf8");
  const captured = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => { captured.push(String(chunk)); return true; };
  setWorkflowEvidenceTransactionTestHooksForTest({
    beforePostconditions: () => { throw new Error("induced post-attachment failure"); },
  });
  try {
    await assert.rejects(
      () => workflowMain(["evidence",
        "--session-dir", session.sessionDir,
        "--expectation", "tests-evidence", "--status", "not_verified",
        "--summary", "routeback live nv rollback fixture",
      ]),
      /induced post-attachment failure/,
      "an unattached live claim must roll back, not recover",
    );
  } finally {
    setWorkflowEvidenceTransactionTestHooksForTest(undefined);
    process.stderr.write = originalWrite;
  }
  try {
    assert.equal(fs.readFileSync(stateFile, "utf8"), canonicalBefore, "the canonical run is untouched");
    assert.equal(fs.readFileSync(path.join(session.sessionDir, "trust.bundle"), "utf8"), bundleBefore, "the claim was NOT recorded — nothing sits live");
    // The PRE facts still printed before the refused mutation (disclosure precedes cost).
    assert.ok(captured.join("").includes("route-back attempts recorded at this gate: none"), `PRE facts precede the rolled-back mutation: ${captured.join("")}`);
  } finally {
    fs.rmSync(session.projectRoot, { recursive: true, force: true });
  }
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
