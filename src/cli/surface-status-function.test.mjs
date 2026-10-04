// surface-status-function.test.mjs — #1422: trust bundles stay honest across Surface's status
// function change ("2" -> "3", Surface 5: omission fails closed).
//
// Three properties, each through the real code path rather than a hand-built bundle:
//   1. A fresh reviewed delivery written by the real sidecar CLI records the reviewer's verdict as
//      evidence its policy requires, so the critique derives `verified` from the bundle's own data,
//      the critique gate accepts it, and the CI reconciler converges on it.
//   2. Every delivery bundle committed in this repository re-derives, through the reconciler's own
//      re-derivation helper and shape check, to exactly the status it recorded.
//   3. `workflow-sidecar claim` renders evidence that reports no result as "no result", never FAIL.
//
// These hold on the installed Surface. On Surface >= 5 properties 1 and 2 are the ones that break
// if the verdict evidence or the stamped-version re-derivation is removed.
//
// Run: `npm run test:unit` (builds first).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { explainClaim, buildTrustReport } from "@kontourai/surface";
import { renderClaimExplanation, claimEvidenceResult } from "../../build/src/cli/workflow-sidecar.js";
import { validateCritiqueResolutionGraph } from "../../build/src/cli/critique-resolution.js";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SIDECAR = path.join(ROOT, "build/src/cli/workflow-sidecar.js");
const DERIVE = path.join(ROOT, "scripts/ci/derive-claim-status.mjs");
const RECONCILE = path.join(ROOT, "scripts/ci/trust-reconcile.js");
const shape = require("../../scripts/lib/reconcile-shape.js");
const { stampedStatusFunctionVersion, statusFunctionVersionForBundle } = require("../../scripts/lib/status-function-version.js");

function sidecar(args) {
  const res = spawnSync(process.execPath, [SIDECAR, ...args], { encoding: "utf8", env: { ...process.env, FLOW_AGENTS_ACTOR: "unit-1422" } });
  assert.equal(res.status, 0, `workflow-sidecar ${args[0]} failed:\n${res.stdout}\n${res.stderr}`);
  return res;
}

/** The reconciler's own re-derivation: the helper trust-reconcile.js spawns, run the same way. */
function derive(bundlePath) {
  const res = spawnSync(process.execPath, [DERIVE, bundlePath], { encoding: "utf8" });
  assert.equal(res.status, 0, `derive-claim-status failed: ${res.stderr}`);
  return { statuses: new Map(Object.entries(JSON.parse(res.stdout))), stderr: res.stderr };
}

/** The status-misassertion / underivable verdict trust-reconcile.js reaches for a bundle's session-local claims. */
function reconcileStatusIssues(bundle, derived) {
  const { sessionLocal } = shape.classifyBundleClaims(bundle);
  return shape.sessionLocalShapeIssues(sessionLocal, derived, { onUnderivable: "fail" }).issues
    .filter((issue) => issue.type === "status-misassertion" || issue.type === "status-underivable");
}

/** A delivery written the way a real reviewed change writes one: evidence, then a passing review. */
function writeReviewedDelivery() {
  const repo = makeFixtureDir("surface-1422-");
  const aroot = path.join(repo, ".kontourai/flow-agents");
  const slug = "reviewed-change";
  const dir = path.join(aroot, slug);
  fs.mkdirSync(aroot, { recursive: true });
  sidecar(["ensure-session", "--artifact-root", aroot, "--task-slug", slug, "--title", "T", "--summary", "S", "--timestamp", "2026-07-01T00:00:00Z"]);
  const plan = path.join(dir, `${slug}--deliver.md`);
  sidecar(["init-plan", plan, "--source-request", "R", "--summary", "S", "--timestamp", "2026-07-01T00:00:00Z"]);
  sidecar(["record-evidence", dir, "--verdict", "pass", "--check-json", JSON.stringify({ id: "diff", kind: "diff", status: "pass", summary: "diff reviewed" }), "--timestamp", "2026-07-01T00:01:00Z"]);
  sidecar([
    "record-critique", dir, "--id", "code-review", "--reviewer", "alice", "--verdict", "pass", "--summary", "looks good",
    "--lane-json", JSON.stringify({ id: "code", status: "pass", summary: "review passed", evidence_refs: [{ kind: "artifact", file: plan, summary: "Reviewed the delivery artifact." }] }),
    "--artifact-ref", plan, "--timestamp", "2026-07-01T00:02:00Z",
  ]);
  const bundlePath = path.join(dir, "trust.bundle");
  return { repo, bundlePath, bundle: JSON.parse(fs.readFileSync(bundlePath, "utf8")) };
}

test("#1422: a fresh reviewed delivery derives verified from the reviewer's verdict evidence", () => {
  const { repo, bundlePath, bundle } = writeReviewedDelivery();
  const critiques = bundle.claims.filter((claim) => claim.metadata?.origin === "critique");
  assert.equal(critiques.length, 1);
  const critique = critiques[0];

  // The verdict is evidence on the claim, collected by the named reviewer, linked from the event.
  const verdictEvidence = bundle.evidence.filter((item) => item.claimId === critique.id);
  assert.deepEqual(verdictEvidence.map((item) => [item.evidenceType, item.method, item.collectedBy, item.passing]), [["attestation", "attestation", "alice", true]]);
  const event = bundle.events.find((item) => item.claimId === critique.id);
  assert.deepEqual(event.evidenceIds, verdictEvidence.map((item) => item.id));
  // ...and the policy requires it, so the verified state rests on something the bundle carries.
  const policy = bundle.policies.find((item) => item.id === critique.verificationPolicyId);
  assert.deepEqual(policy.requiredEvidence, ["attestation"]);

  assert.equal(critique.status, "verified");
  const graph = validateCritiqueResolutionGraph(bundle.claims);
  assert.ok(!graph.errors.includes("critique graph requires a current verified PASS"), `critique gate rejected the review: ${graph.errors.join("; ")}`);
  assert.ok(!graph.errors.includes("critique graph has unresolved live critique records"), `critique gate rejected the review: ${graph.errors.join("; ")}`);

  // CI re-derivation agrees with what the writer recorded, and the real reconciler converges.
  const { statuses } = derive(bundlePath);
  assert.equal(statuses.get(critique.id), "verified");
  assert.deepEqual(reconcileStatusIssues(bundle, statuses), []);
  const recon = spawnSync(process.execPath, [RECONCILE, "--bundle", bundlePath, "--repo-root", repo], { encoding: "utf8", env: { ...process.env, TRUST_RECONCILE_COMMANDS: "true" } });
  assert.equal(recon.status, 0, `trust-reconcile did not converge:\n${recon.stdout}\n${recon.stderr}`);
});

test("#1422: every committed delivery bundle re-derives to the verdict it recorded", () => {
  const deliveryRoot = path.join(ROOT, "delivery");
  const bundles = fs.readdirSync(deliveryRoot)
    .map((name) => path.join(deliveryRoot, name, "trust.bundle"))
    .filter((file) => fs.existsSync(file));
  assert.ok(bundles.length >= 40, `expected the committed delivery corpus, found ${bundles.length} bundle(s)`);
  let compared = 0;
  for (const file of bundles) {
    const bundle = JSON.parse(fs.readFileSync(file, "utf8"));
    // Every flow-agents writer stamps its version; the re-derivation below must use that stamp.
    assert.notEqual(stampedStatusFunctionVersion(bundle), null, `${file} carries no statusFunctionVersion stamp`);
    const { statuses } = derive(file);
    for (const claim of bundle.claims) {
      // Superseded critique history is excluded from reconciliation (reconcile-shape.js) and its
      // stored status is set directly, never derived.
      if (claim.metadata?.superseded_by) continue;
      assert.equal(statuses.get(claim.id), claim.status, `${path.relative(ROOT, file)}: claim ${claim.id} (${claim.claimType}) recorded '${claim.status}' but re-derives '${statuses.get(claim.id)}'`);
      compared += 1;
    }
    assert.deepEqual(reconcileStatusIssues(bundle, statuses).map((issue) => issue.message), [], path.relative(ROOT, file));
  }
  assert.ok(compared > 400, `compared only ${compared} claims`);
});

test("#1422: the status function stamp is parsed as an identity and refused when it cannot be honoured", () => {
  const surface = { statusFunctionVersion: "3", supportedStatusFunctionVersions: ["2", "3"] };
  assert.deepEqual(statusFunctionVersionForBundle({ source: "flow-agents/workflow-sidecar;statusFunctionVersion=2" }, surface), { version: "2", stamped: true });
  // No stamp: the strictest version the installed Surface offers, never the lenient one.
  assert.deepEqual(statusFunctionVersionForBundle({ source: "someone-else" }, surface), { version: "3", stamped: false });
  assert.deepEqual(statusFunctionVersionForBundle({}, surface), { version: "3", stamped: false });
  assert.throws(() => statusFunctionVersionForBundle({ source: "x;statusFunctionVersion=1" }, surface), /cannot evaluate/);
  assert.throws(() => statusFunctionVersionForBundle({ source: "x;statusFunctionVersion=2;statusFunctionVersion=3" }, surface), /2 times/);
  assert.throws(() => statusFunctionVersionForBundle({ source: "x;statusFunctionVersion=" }, surface), /empty/);
  assert.equal(stampedStatusFunctionVersion({ source: "x;statusFunctionVersion=22" }), "22", "a stamp is matched whole, not by prefix");
  // Surface < 5 exposes only its single version.
  assert.deepEqual(statusFunctionVersionForBundle({ source: "x;statusFunctionVersion=2" }, { statusFunctionVersion: "2" }), { version: "2", stamped: true });
  assert.throws(() => statusFunctionVersionForBundle({ source: "x;statusFunctionVersion=3" }, { statusFunctionVersion: "2" }), /cannot evaluate/);
});

test("#1422: a bundle whose stamp cannot be honoured is underivable in CI, so the reconciler fails closed", () => {
  const { repo, bundle } = writeReviewedDelivery();
  const forged = path.join(repo, "unsupported-stamp.bundle");
  fs.writeFileSync(forged, JSON.stringify({ ...bundle, source: "flow-agents/workflow-sidecar;statusFunctionVersion=1" }));
  const { statuses, stderr } = derive(forged);
  assert.ok(statuses.size > 0);
  assert.ok([...statuses.values()].every((status) => status === null), "every claim must be underivable");
  assert.match(stderr, /statusFunctionVersion "1"/);
  const issues = reconcileStatusIssues(bundle, statuses);
  assert.ok(issues.length > 0 && issues.every((issue) => issue.type === "status-underivable"), JSON.stringify(issues));

  // The real reconciler exits non-zero and says why.
  const recon = spawnSync(process.execPath, [RECONCILE, "--bundle", forged, "--repo-root", repo], { encoding: "utf8", env: { ...process.env, TRUST_RECONCILE_COMMANDS: "true" } });
  assert.notEqual(recon.status, 0, `trust-reconcile accepted a bundle it cannot re-derive:\n${recon.stdout}`);
  assert.match(recon.stderr, /statusFunctionVersion "1", which the installed @kontourai\/surface cannot evaluate/);
  assert.match(recon.stdout + recon.stderr, /status-underivable|could not be re-derived/);
});

test("#1422: `workflow-sidecar claim` explains a bundle with its stamped status function and refuses one it cannot honour", () => {
  const { repo, bundle } = writeReviewedDelivery();
  const critique = bundle.claims.find((claim) => claim.metadata?.origin === "critique");
  const claimCli = (dir) => spawnSync(process.execPath, [SIDECAR, "claim", critique.id, dir], { encoding: "utf8" });
  const good = path.join(repo, "explain-good");
  fs.mkdirSync(good);
  fs.writeFileSync(path.join(good, "trust.bundle"), JSON.stringify(bundle));
  const ok = claimCli(good);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Status: verified/);
  assert.match(ok.stdout, /\[pass\] attestation: critique verdict: pass/);
  const bad = path.join(repo, "explain-unsupported");
  fs.mkdirSync(bad);
  fs.writeFileSync(path.join(bad, "trust.bundle"), JSON.stringify({ ...bundle, source: "flow-agents/workflow-sidecar;statusFunctionVersion=1" }));
  const refused = claimCli(bad);
  assert.equal(refused.status, 1, `claim explained a bundle it cannot re-derive:\n${refused.stdout}`);
  assert.match(refused.stderr, /statusFunctionVersion "1"/);
  assert.equal(refused.stdout, "");
});

test("#1422: claim rendering shows evidence with no recorded result as 'no result', never as a failure", () => {
  const { bundle } = writeReviewedDelivery();
  const critique = bundle.claims.find((claim) => claim.metadata?.origin === "critique");
  const explanation = explainClaim(buildTrustReport(bundle), critique.id);
  assert.equal(explanation.found, true);
  assert.equal(explanation.evidence.length, 1);
  // Surface >= 5 reports each item's own result as boolean | null; present all three.
  const [item] = explanation.evidence;
  const three = { ...explanation, evidence: [
    { ...item, label: "passed-item", passing: true },
    { ...item, label: "failed-item", passing: false },
    { ...item, label: "no-result-item", passing: null },
  ] };
  assert.deepEqual(three.evidence.map(claimEvidenceResult), ["pass", "fail", "no-result"]);
  const text = renderClaimExplanation(critique.id, three);
  assert.match(text, /\[pass\] attestation: passed-item/);
  assert.match(text, /\[FAIL\] attestation: failed-item/);
  assert.match(text, /\[no result\] attestation: no-result-item/);
  const failing = text.split("Failing evidence (disputed because):")[1] ?? "";
  assert.match(failing, /failed-item/);
  assert.doesNotMatch(failing, /no-result-item/, "evidence with no result is not a reason the claim is disputed");
  // With no failing item there is no failing section at all.
  const noFailure = renderClaimExplanation(critique.id, { ...explanation, evidence: [{ ...item, passing: null }] });
  assert.doesNotMatch(noFailure, /Failing evidence/);
  assert.doesNotMatch(noFailure, /FAIL/);
});
