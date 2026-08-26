// #1302 freshness turnstile: a gate declaring requires_current_verification refuses a passing
// claim while review/verification evidence is stale, quoting the publish preflight's predicate
// verbatim. Run: `npm run test:unit`.
//
// Layered proof (the composed public path needs an authenticated ChangeProvider to reach
// merge-ready-ci, so it is exercised by the golden-run predicate probes and the next
// provider-backed dogfood run):
//   1. this file — the turnstile's wiring: which gates arm it, which statuses are exempt,
//      and that the refusal quotes the canonical predicate rather than paraphrasing it;
//   2. flow-resolver-composition.test.mjs — the declaration survives scalar and aggregate
//      flow composition into the effective definition the runtime actually consults;
//   3. test_golden_run_e2e.sh — the predicate itself discriminates current-vs-stale on a
//      REAL verified bundle (passes at the verified head, fails after one fixture commit).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { assertGateFreshnessTurnstile } from "../../build/src/cli/workflow.js";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIDECAR = path.resolve(__dirname, "../../build/src/cli/workflow-sidecar.js");

function definitionWith(gate) {
  return {
    id: "fixture.flow",
    version: "1.0",
    steps: [{ id: "closeout", next: null }],
    gates: { "closeout-gate": { step: "closeout", ...gate } },
  };
}

const run = (gate) => ({ definition: definitionWith(gate), state: { status: "active", current_step: "closeout" } });
const EXPECTS = [{ id: "closeout-readiness", kind: "trust.bundle", required: true, bundle_claim: { claimType: "fixture.readiness", subjectType: "flow-step", accepted_statuses: ["verified"] } }];

test("a gate WITHOUT the declaration never runs the predicate", () => {
  // sessionDir is nonexistent on purpose: if the predicate ran, it would throw on the missing
  // session — the no-flag path must return before ever touching the session.
  assert.doesNotThrow(() => assertGateFreshnessTurnstile("/nonexistent/session", run({ expects: EXPECTS }), "closeout-readiness", "pass"));
});

test("failing claims are exempt: they are the repair path the route-back map exists for", () => {
  assert.doesNotThrow(() => assertGateFreshnessTurnstile("/nonexistent/session", run({ expects: EXPECTS, requires_current_verification: true }), "closeout-readiness", "fail"));
});

test("an expectation on a DIFFERENT gate than the declaring one does not arm the turnstile", () => {
  const definition = {
    id: "fixture.flow", version: "1.0",
    steps: [{ id: "closeout", next: null }],
    gates: {
      "closeout-gate": { step: "closeout", expects: EXPECTS },
      "other-gate": { step: "closeout", requires_current_verification: true, expects: [{ ...EXPECTS[0], id: "other" }] },
    },
  };
  assert.doesNotThrow(() => assertGateFreshnessTurnstile("/nonexistent/session", { definition, state: { status: "active", current_step: "closeout" } }, "closeout-readiness", "pass"));
});

test("a declaring gate refuses a passing claim on an unverified session, quoting the canonical predicate", () => {
  // Real synthetic session via the sidecar writer (same fixture pattern as the preflight tests):
  // a fresh session has no check/critique claims, so the canonical predicate finds verification
  // stale — the turnstile must surface that predicate's EXACT vocabulary, not a paraphrase.
  const project = makeFixtureDir("turnstile-");
  try {
    spawnSync("git", ["init", "-q", "."], { cwd: project });
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: project });
    const artifactRoot = path.join(project, ".kontourai", "flow-agents");
    const ensure = spawnSync(process.execPath, [SIDECAR,
      "ensure-session", "--artifact-root", artifactRoot,
      "--work-item", "acme/widgets#9", "--flow-id", "builder.build",
      "--source-request", "turnstile fixture", "--summary", "turnstile fixture",
    ], { cwd: project, encoding: "utf8", env: { ...process.env, FLOW_AGENTS_ACTOR: "turnstile-fixture-actor" } });
    assert.equal(ensure.status, 0, `fixture ensure-session failed: ${ensure.stderr}`);
    const sessionDir = path.join(artifactRoot, "acme-widgets-9");
    assert.throws(
      () => assertGateFreshnessTurnstile(sessionDir, run({ expects: EXPECTS, requires_current_verification: true }), "closeout-readiness", "pass"),
      (error) => {
        assert.match(error.message, /closeout-gate declares requires_current_verification/);
        assert.match(error.message, /cannot advance the cursor past its last verification repair point/);
        // the canonical publish-preflight vocabulary, verbatim (one predicate, quoted everywhere)
        assert.match(error.message, /requires current canonical review and test verification evidence bound to the exact same source snapshot/);
        assert.ok(error.cause instanceof Error, "the underlying predicate error must be preserved as cause");
        return true;
      },
    );
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});
