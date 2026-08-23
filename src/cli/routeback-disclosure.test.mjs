// #1304: route-back cost disclosure at the point of use. A route-triggering status (fail /
// not_verified) at a gate with an `on_route_back` map commits the run to a route whose cost —
// destination step, bounded attempt budget, and re-recording of current-visit verification
// evidence — was previously visible only AFTER the mutation. The disclosure is emitted to stderr
// BEFORE the canonical mutation; gates declaring `requires_current_verification` add the
// publish-first ordering rule (the run-4 trap), keyed off the declaration, never a gate name.
// Existing refusal strings stay byte-identical (consumers substring-match them). Run:
// `npm run test:unit`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { flowRunHead, runDir } from "@kontourai/flow";
import { assertExecuteFailureRouteBeforeMutation, routeBackDisclosureLines } from "../../build/src/cli/workflow.js";
import { startBuilderFlowSession, syncBuilderFlowSession } from "../../build/src/builder-flow-runtime.js";
import { performLocalClaim, resolveCurrentAssignmentActor } from "../../build/src/cli/assignment-provider.js";

// Each node:test file is its own process: pin the ambient actor before any claim resolution so
// the fixture's assignment holder is deterministic.
process.env.FLOW_AGENTS_ACTOR = "routeback-disclosure-owner";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "../../build/src/cli.js");
const KIT_PUBLISH_LEARN = path.resolve(__dirname, "../../kits/builder/flows/publish-learn.flow.json");

// ---------------------------------------------------------------------------
// Hand-shaped fixtures for the pure disclosure derivation (the real run adapter
// is too heavy to reach every gate shape; same pattern as the #1302 seam tests).
// ---------------------------------------------------------------------------

function runFixture(gate, { currentStep = "closeout", transitions = [] } = {}) {
  return {
    definition: {
      id: "fixture.flow",
      version: "1.0",
      steps: [{ id: currentStep, next: null }],
      gates: { [`${currentStep}-gate`]: { step: currentStep, ...gate } },
    },
    state: { status: "active", current_step: currentStep, transitions },
  };
}

const EXPECTS = [{
  id: "closeout-readiness", kind: "trust.bundle", required: true,
  bundle_claim: { claimType: "fixture.readiness", subjectType: "flow-step", accepted_statuses: ["verified"] },
}];
const ROUTES = { implementation_defect: "execute", default: "verify" };
const POLICY = { max_attempts: 3, on_exceeded: "block" };

test("a route-triggering status derives destination, attempt budget, and the evidence re-record cost", () => {
  const run = runFixture({ expects: EXPECTS, on_route_back: ROUTES, route_back_policy: POLICY });
  const fail = routeBackDisclosureLines(run, "closeout-readiness", "fail", "implementation_defect");
  assert.equal(fail.length, 1);
  assert.match(fail[0], /routes closeout-gate back to step 'execute'/);
  assert.match(fail[0], /route-back attempt 1 of 3/);
  assert.match(fail[0], /verification evidence \(critique\/tests\).*re-recorded/);

  // not_verified is route-triggering too (the run-4 shape: a non-accepted claim status derives a
  // failed evidence entry, and with no declared reason the flow takes the default route).
  const notVerified = routeBackDisclosureLines(run, "closeout-readiness", "not_verified", undefined);
  assert.equal(notVerified.length, 1);
  assert.match(notVerified[0], /routes closeout-gate back to step 'verify'/);

  // an exhausted budget BLOCKS instead of routing — the disclosure must not claim a route the
  // derivation refuses (label-vs-derivation).
  const routeBack = (at) => ({ type: "route_back", gate_id: "closeout-gate", route_reason: "implementation_defect", from_step: "closeout", to_step: "execute", retry_epoch: 1, failed_evidence_refs: [`ev-${at}`], at: new Date().toISOString() });
  const reentry = () => ({ type: "route_back", status: "allowed", from_step: "execute", to_step: "closeout", at: new Date().toISOString() });
  const exhausted = runFixture(
    { expects: EXPECTS, on_route_back: ROUTES, route_back_policy: POLICY },
    { transitions: [routeBack(1), reentry(), routeBack(2), reentry(), routeBack(3), reentry()] },
  );
  const blocked = routeBackDisclosureLines(exhausted, "closeout-readiness", "fail", "implementation_defect");
  assert.equal(blocked.length, 1);
  assert.match(blocked[0], /exceeds closeout-gate's route-back budget \(attempt 4 of 3\) and BLOCKS the run/);
  assert.ok(!/routes closeout-gate back/.test(blocked[0]));
});

test("a pass record, and a fail at a gate without a route map, print no disclosure", () => {
  const routed = runFixture({ expects: EXPECTS, on_route_back: ROUTES, route_back_policy: POLICY });
  assert.deepEqual(routeBackDisclosureLines(routed, "closeout-readiness", "pass", undefined), []);
  const unrouted = runFixture({ expects: EXPECTS });
  assert.deepEqual(routeBackDisclosureLines(unrouted, "closeout-readiness", "fail", undefined), []);
  // an expectation that is not at any open gate discloses nothing rather than inventing a route
  assert.deepEqual(routeBackDisclosureLines(routed, "unknown-expectation", "fail", undefined), []);
});

test("requires_current_verification adds the publish-first rule, keyed off the declaration — proven on the real kit gate", () => {
  // The REAL shipped merge-ready-ci-gate declaration (not a paraphrase): the publish-first text
  // must fire for it, and stripping ONLY the declaration from the same gate must lose the text —
  // proving the key is the declaration, never the gate name (#1280 kit-generic boundary).
  const publishLearn = JSON.parse(fs.readFileSync(KIT_PUBLISH_LEARN, "utf8"));
  const kitGate = publishLearn.gates["merge-ready-ci-gate"];
  assert.equal(kitGate.requires_current_verification, true, "fixture drift: the kit no longer declares requires_current_verification on merge-ready-ci-gate");
  const declared = {
    definition: { id: "fixture.flow", version: "1.0", steps: [{ id: "merge-ready-ci", next: null }], gates: { "merge-ready-ci-gate": kitGate } },
    state: { status: "active", current_step: "merge-ready-ci", transitions: [] },
  };
  const lines = routeBackDisclosureLines(declared, "ci-merge-readiness", "not_verified", undefined);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /routes merge-ready-ci-gate back to step 'verify'/);
  assert.match(lines[1], /publish the provisional delivery BEFORE recording this gate; a live non-pass claim here blocks the publish that would resolve it/);

  const undeclared = structuredClone(declared);
  delete undeclared.definition.gates["merge-ready-ci-gate"].requires_current_verification;
  const withoutDeclaration = routeBackDisclosureLines(undeclared, "ci-merge-readiness", "not_verified", undefined);
  assert.equal(withoutDeclaration.length, 1, "the publish-first rule must key off the declaration, not the gate name");
  assert.ok(!withoutDeclaration.some((line) => /publish the provisional delivery/.test(line)));
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

// ---------------------------------------------------------------------------
// Ordering: the disclosure precedes the canonical mutation. Proven on a REAL
// builder.build run advanced to the execute step: the disclosure appears on
// stderr even when the mutation is subsequently REFUSED for an independent
// reason (non-holder actor), and the canonical state is untouched.
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

test("the disclosure precedes the mutation: it prints even when the mutation is refused for an independent reason", async () => {
  const slug = "routeback-disclosure";
  const subject = `local:work-item/${slug}`;
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "routeback-disclosure-"));
  try {
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
    const session = { projectRoot, sessionDir, slug };
    await writeAndSync(session, [bundleClaim({ expectation: "selected-work", claimType: "builder.pull-work.selected", subjectType: "work-item", stepId: "pull-work", subject })]);
    await writeAndSync(session, [
      bundleClaim({ expectation: "pickup-probe-readiness", claimType: "builder.design-probe.pickup-readiness", subjectType: "work-item", stepId: "design-probe", subject }),
      bundleClaim({ expectation: "probe-decisions-or-accepted-gaps", claimType: "builder.design-probe.decisions", subjectType: "decision", stepId: "design-probe", subject }),
    ]);
    const executing = await writeAndSync(session, [bundleClaim({ expectation: "implementation-plan", claimType: "builder.plan.implementation", subjectType: "artifact", stepId: "plan", subject })]);
    assert.equal(executing.run.state.current_step, "execute", "fixture must reach the routed execute gate");

    const stateFile = path.join(runDir(slug, projectRoot), "state.json");
    const canonicalBefore = fs.readFileSync(stateFile, "utf8");
    const result = spawnSync(process.execPath, [CLI, "workflow", "evidence",
      "--session-dir", sessionDir,
      "--expectation", "implementation-scope", "--status", "fail",
      "--route-reason", "plan_gap",
      "--summary", "routeback disclosure ordering fixture",
    ], { cwd: projectRoot, encoding: "utf8", env: { ...process.env, FLOW_AGENTS_ACTOR: "routeback-disclosure-intruder" } });

    // the mutation was refused for an INDEPENDENT reason (non-holder actor)...
    assert.notEqual(result.status, 0, `expected the non-holder mutation to be refused: ${result.stderr}`);
    assert.match(result.stderr, /requires the session's active, matching assignment actor/);
    // ...and the disclosure still printed, BEFORE any mutation was attempted
    assert.match(result.stderr, /NOTICE: recording fail for implementation-scope routes execute-gate back to step 'plan' \(route-back attempt 1 of 3\)/);
    assert.match(result.stderr, /verification evidence \(critique\/tests\).*re-recorded/);
    // the canonical run is byte-identical: disclosed, then refused, never mutated
    assert.equal(fs.readFileSync(stateFile, "utf8"), canonicalBefore, "a refused mutation must leave the canonical state untouched");
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
