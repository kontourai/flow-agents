// trust-bundle-policy-order.test.mjs — WS8 (AC1, iteration 2) policy-cache order regression.
//
// The verifier found that ensurePolicy cached the first-seen requiredEvidence per legacy
// claimType, so two checks of the SAME kind that differ in command-presence (browser/security/
// runtime with vs without a command) collided: the first-recorded requiredEvidence won and
// corrupted the SECOND claim's derived status (verified -> proposed) depending on record order.
//
// This proves the fix: policy construction is keyed by (claimType, requiredEvidence), so two
// same-kind checks differing in command-presence produce IDENTICAL bundles in BOTH record
// orders (and each claim's derived status is order-independent).
//
// Run: `npm run test:unit`. Requires @kontourai/surface (the bundle producer's dependency).
import test from "node:test";
import assert from "node:assert/strict";

import { buildTrustBundle } from "../../build/src/cli/workflow-sidecar.js";

const TS = "2026-07-02T00:00:00Z";

// A command-backed browser check (-> test_output) and a no-command browser check
// (-> crawl_observation): SAME legacy claimType (workflow.check.browser), DIFFERENT
// requiredEvidence. This is the exact collision the verifier reproduced.
const checkCmd = { id: "browser-cmd", kind: "browser", status: "pass", summary: "e2e smoke via command", command: "npm run e2e" };
const checkNoCmd = { id: "browser-nocmd", kind: "browser", status: "pass", summary: "manual crawl observation" };

/** Deep-sort every array-of-objects-with-id so ordering never affects equality. */
function canonicalize(bundle) {
  const clone = JSON.parse(JSON.stringify(bundle));
  const byId = (a, b) => String(a.id).localeCompare(String(b.id));
  for (const key of ["claims", "evidence", "events", "policies"]) {
    if (Array.isArray(clone[key])) clone[key].sort(byId);
  }
  return clone;
}

function statusByClaimId(bundle) {
  const m = {};
  for (const c of bundle.claims) m[c.id] = c.status;
  return m;
}

test("buildTrustBundle: two same-kind checks differing in command-presence produce identical bundles in both record orders", async () => {
  const forward = await buildTrustBundle("perm", TS, [checkCmd, checkNoCmd], [], []);
  const reverse = await buildTrustBundle("perm", TS, [checkNoCmd, checkCmd], [], []);

  // Surface is a hard dependency of the producer; if it is genuinely unavailable the whole
  // bundle-write path is skipped elsewhere, so a null here is a real environment failure.
  assert.ok(forward, "buildTrustBundle returned null (is @kontourai/surface installed?)");
  assert.ok(reverse, "buildTrustBundle returned null (is @kontourai/surface installed?)");

  // The whole bundle is order-independent once canonicalized (arrays sorted by id).
  assert.deepEqual(
    canonicalize(forward),
    canonicalize(reverse),
    "bundles differ by record order — policy-cache collision has regressed",
  );

  // And, specifically, each claim's derived status is order-independent (the defect's symptom
  // was the second same-kind claim flipping verified -> proposed depending on order).
  assert.deepEqual(statusByClaimId(forward), statusByClaimId(reverse));
});

test("buildTrustBundle: same-kind checks with different command-presence get DISTINCT policies (not a colliding shared one)", async () => {
  const bundle = await buildTrustBundle("perm", TS, [checkCmd, checkNoCmd], [], []);
  assert.ok(bundle, "buildTrustBundle returned null (is @kontourai/surface installed?)");

  const browserPolicies = bundle.policies.filter((p) => p.claimType === "workflow.check.browser");
  // Two distinct required-evidence signatures -> two distinct policies (keyed, not merged).
  assert.equal(browserPolicies.length, 2, "expected two distinct workflow.check.browser policies");
  const reqSets = browserPolicies.map((p) => p.requiredEvidence.slice().sort().join(",")).sort();
  assert.deepEqual(reqSets, ["crawl_observation", "test_output"]);

  // requiredEvidence is all-of in Surface, so the sets must NOT have been merged into one
  // over-constrained policy requiring BOTH types.
  for (const p of browserPolicies) {
    assert.equal(p.requiredEvidence.length, 1, `policy ${p.id} must require exactly one evidence type (not a merged union)`);
  }

  // Each claim references its own policy, and both derive 'verified' (neither corrupted).
  const statuses = statusByClaimId(bundle);
  const cmdClaim = bundle.claims.find((c) => c.subjectId === "perm/browser-cmd");
  const noCmdClaim = bundle.claims.find((c) => c.subjectId === "perm/browser-nocmd");
  assert.ok(cmdClaim && noCmdClaim);
  assert.notEqual(cmdClaim.verificationPolicyId, noCmdClaim.verificationPolicyId);
  assert.equal(statuses[cmdClaim.id], "verified");
  assert.equal(statuses[noCmdClaim.id], "verified");
});
