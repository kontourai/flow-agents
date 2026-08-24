// #1302 seam enforcement: independent review found the first turnstile (public-wrapper-only)
// bypassed by sidecar record-gate-claim + sync, and TOCTOU-racy on the public path. Every
// advancement path converges on bundleGateEvidence / the no-new-evidence pass in syncAndProject,
// so the guard lives there. These tests drive the REAL seam function with a discriminating pair:
// the identical fixture advances without the flag and is withheld with it, so a null provably
// comes from the turnstile rather than fixture malformation. Run: `npm run test:unit`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { flowRunHead } from "@kontourai/flow";
import { bundleGateEvidence, gateAdvancementFreshnessSatisfied } from "../../build/src/builder-flow-runtime.js";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIDECAR = path.resolve(__dirname, "../../build/src/cli/workflow-sidecar.js");

const SUBJECT = "acme/widgets#11";

function makeUnverifiedSession() {
  // A real synthetic session via the sidecar writer: fresh bundle, no critique, no tests claims —
  // the canonical predicate reads this as stale/unverified.
  const project = makeFixtureDir("seam-");
  spawnSync("git", ["init", "-q", "."], { cwd: project });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: project });
  const artifactRoot = path.join(project, ".kontourai", "flow-agents");
  const ensure = spawnSync(process.execPath, [SIDECAR,
    "ensure-session", "--artifact-root", artifactRoot,
    "--work-item", SUBJECT, "--flow-id", "builder.build",
    "--source-request", "seam fixture", "--summary", "seam fixture",
  ], { cwd: project, encoding: "utf8", env: { ...process.env, FLOW_AGENTS_ACTOR: "seam-fixture-actor" } });
  assert.equal(ensure.status, 0, `fixture ensure-session failed: ${ensure.stderr}`);
  return { project, sessionDir: path.join(artifactRoot, "acme-widgets-11") };
}

function fixture({ requiresCurrent, failing } = {}) {
  const state = {
    current_step: "closeout",
    updated_at: new Date(Date.now() - 5_000).toISOString(),
    transitions: [],
    subject: SUBJECT,
  };
  const gate = {
    id: "closeout-gate",
    step: "closeout",
    ...(requiresCurrent ? { requires_current_verification: true } : {}),
    on_route_back: { missing_evidence: "closeout" },
    route_back_policy: { max_attempts: 3, on_exceeded: "block" },
    expects: [{
      id: "closeout-readiness", kind: "trust.bundle", required: true,
      bundle_claim: { claimType: "fixture.readiness", subjectType: "flow-step", accepted_statuses: ["verified"] },
    }],
  };
  const claim = {
    id: "seam-claim-1",
    claimType: "fixture.readiness",
    subjectType: "flow-step",
    value: failing ? "fail" : "pass",
    status: failing ? "disputed" : "verified",
    createdAt: new Date().toISOString(),
    metadata: {
      origin: "check",
      workflow_subject_ref: SUBJECT,
      gate_claim: {
        expectation_id: "closeout-readiness",
        step_id: "closeout",
        flow_run_head: flowRunHead(state),
        ...(failing ? { route_reason: "missing_evidence" } : {}),
      },
    },
  };
  return { state, gate, bundle: { claims: [claim], evidence: [] } };
}

test("the seam WITHHOLDS a passing claim at a declaring gate while the session is unverified", async () => {
  const { project, sessionDir } = makeUnverifiedSession();
  try {
    const armed = fixture({ requiresCurrent: true });
    const withheld = await bundleGateEvidence(armed.bundle, armed.gate, armed.state, SUBJECT, project, sessionDir, [], {});
    assert.equal(withheld, null, "a passing claim must not produce attachable evidence while verification is stale");

    // discriminating control: the IDENTICAL fixture without the declaration advances — proving
    // the null above came from the turnstile, not from fixture malformation.
    const unarmed = fixture({});
    const advanced = await bundleGateEvidence(unarmed.bundle, unarmed.gate, unarmed.state, SUBJECT, project, sessionDir, [], {});
    assert.ok(advanced, "the identical fixture without the declaration must produce attachable evidence");
    assert.equal(advanced.failed, false);
    assert.deepEqual(advanced.expectationIds, ["closeout-readiness"]);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("a FAILING claim at a declaring gate stays attachable: route-back repair is never blocked", async () => {
  const { project, sessionDir } = makeUnverifiedSession();
  try {
    const armed = fixture({ requiresCurrent: true, failing: true });
    const evidence = await bundleGateEvidence(armed.bundle, armed.gate, armed.state, SUBJECT, project, sessionDir, [], {});
    assert.ok(evidence, "a failing claim with a route reason must remain attachable while stale");
    assert.equal(evidence.failed, true);
    assert.equal(evidence.routeReason, "missing_evidence");
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("gateAdvancementFreshnessSatisfied: undeclared gates never consult the predicate; declared gates do", () => {
  // nonexistent session: if the predicate ran for the undeclared gate, it would throw/false.
  assert.equal(gateAdvancementFreshnessSatisfied({ id: "g", step: "s" }, "/nonexistent/session", "/nonexistent"), true);
  const { project, sessionDir } = makeUnverifiedSession();
  try {
    assert.equal(gateAdvancementFreshnessSatisfied({ id: "g", step: "s", requires_current_verification: true }, sessionDir, project), false);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});
