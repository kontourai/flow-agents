#!/usr/bin/env node
// derive-claim-status.mjs — WS8 (AC1/finding-3) CI-side status re-derivation helper.
//
// The trust reconciler MUST NOT trust a bundle's self-reported `claim.status`. This helper
// re-derives each claim's status from the bundle's OWN evidence/events/policies using
// @kontourai/surface's canonical `deriveClaimStatus` — the exact function the producer used
// — so the reconciler can detect a status-misassertion (asserted status != derived status).
//
// It is a separate ESM module because @kontourai/surface is ESM-only while
// scripts/ci/trust-reconcile.js is CommonJS with a synchronous entrypoint; the reconciler
// invokes this via spawnSync and parses the JSON on stdout. Surface is resolved from THIS
// file's location (the reconciler's own node_modules), NOT the target repo-root, so an
// adopter repo without Surface still gets CI-side re-derivation from the anchor's copy.
//
// #1422: each bundle is re-derived with the status function version it stamped in `source`
// (scripts/lib/status-function-version.js owns that decision, including what an unstamped or
// unsupported stamp means). Surface 5 defaults to status function "3"; re-deriving a bundle the
// writer derived under "2" with "3" would report a status-misassertion against an honest bundle.
// When the stamp cannot be honoured every claim is reported underivable (null), so the CI
// reconciler fails closed on each pass-asserting claim and names the reason on stderr.
//
// Usage: node derive-claim-status.mjs <bundle-path>
// Output (stdout): {"claimId": "<TrustStatus>", ...}  — value is null if that claim threw.
// Exit: 0 on success (Surface loaded); 2 if Surface is unavailable; 3 on bad input.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const { statusFunctionVersionForBundle } = createRequire(import.meta.url)("../lib/status-function-version.js");

async function main() {
  const bundlePath = process.argv[2];
  if (!bundlePath) { process.stderr.write("derive-claim-status: bundle path argument required\n"); return 3; }

  let surface;
  try {
    surface = await import("@kontourai/surface");
  } catch (err) {
    process.stderr.write(`derive-claim-status: @kontourai/surface unavailable: ${err && err.message ? err.message : String(err)}\n`);
    return 2;
  }
  const { deriveClaimStatus } = surface;
  if (typeof deriveClaimStatus !== "function") {
    process.stderr.write("derive-claim-status: @kontourai/surface deriveClaimStatus missing\n");
    return 2;
  }

  let bundle;
  try {
    bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
  } catch (err) {
    process.stderr.write(`derive-claim-status: cannot read bundle: ${err && err.message ? err.message : String(err)}\n`);
    return 3;
  }

  const claims = Array.isArray(bundle.claims) ? bundle.claims : [];
  const allEvidence = Array.isArray(bundle.evidence) ? bundle.evidence : [];
  const allEvents = Array.isArray(bundle.events) ? bundle.events : [];
  const allPolicies = Array.isArray(bundle.policies) ? bundle.policies : [];

  let statusFunctionVersion = null;
  try {
    ({ version: statusFunctionVersion } = statusFunctionVersionForBundle(bundle, surface));
  } catch (err) {
    process.stderr.write(`derive-claim-status: ${err && err.message ? err.message : String(err)}\n`);
  }

  const out = {};
  for (const claim of claims) {
    if (!claim || !claim.id) continue;
    // Filter evidence by claimId (deriveTrustStatus does NOT filter evidence internally — it
    // only filters events — so passing the whole array would let another claim's evidence
    // type/blocking-failure bleed in). Events are filtered internally by claimId; policies are
    // resolved per-claim via verificationPolicyId. This mirrors the producer's per-claim call.
    const evidence = allEvidence.filter((e) => e && e.claimId === claim.id);
    if (statusFunctionVersion === null) { out[claim.id] = null; continue; }
    try {
      const { status } = deriveClaimStatus({ claim, evidence, events: allEvents, policies: allPolicies, statusFunctionVersion });
      out[claim.id] = status;
    } catch {
      out[claim.id] = null;
    }
  }

  process.stdout.write(JSON.stringify(out));
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(`derive-claim-status: ${err && err.message ? err.message : String(err)}\n`);
  process.exit(2);
});
