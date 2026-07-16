#!/usr/bin/env node
// readiness-to-trust-bundle.mjs — Veritas Governance Kit adapter (slice 1).
//
// PURPOSE (the "trust-bundle format gap" fix, kept in the KIT adapter layer — NOT in
// @kontourai/veritas). `veritas readiness --check evidence --working-tree` writes a legacy
// evidence-report record (`.kontourai/veritas/evidence/veritas-<runId>.json`). The Flow gate
// in flows/readiness-check.flow.json expects `kind: "trust.bundle"` — a Hachure trust.bundle
// carrying a `software-readiness-verdict` claim whose Surface-derived status the gate checks.
// This adapter projects Veritas's own recorded readiness record into that trust.bundle using
// @kontourai/surface (the same open-format bundle vocabulary Flow Agents' own delivery bundle
// and kits/builder/flows/build.flow.json use). It does NOT re-evaluate Repo Standards — Veritas
// already did that; the adapter only reads Veritas's recorded per-check results and aggregates
// the blocking-failure signal, so no Veritas rule/claim logic is forked or reimplemented.
//
// BLOCKING-FAILURE definition (SETTLED — owner-ratified + investigation-confirmed, see
// .kontourai/flow-agents/ws5-governance-kit-slice1 session findings). This adapter derives the
// readiness gate verdict from the readiness record's blocking failures: a Require-enforcement
// policy failure, an uncovered-path `fail`, a failed selected evidence check, or a blocking
// external-tool `fail`/`missing` (mirrors veritas/src/surface/readiness.mjs's own PRIVATE
// `readinessHasBlockingFailure` helper, and matches Surface's `buildTrustReport` weakest-link
// derivation, which downgrades a readiness claim to `rejected` on any rejected Require —
// tests/surface/readiness-derived-claim.test.mjs:256-278). It does NOT treat Veritas's
// `promotion_allowed` flag as a safety signal: promotion_allowed is a workstream-routing hint
// from src/repo/routing.mjs `resolveWorkstream()` (file-pattern lane resolution) — it never
// reads policy_results, evidence checks, uncovered paths, or external tools, so it cannot
// account for blocking failures. The divergence this originally guarded against —
// kontourai/veritas#106 (https://github.com/kontourai/veritas/issues/106), Veritas's exported
// readinessVerdict/readinessSurfaceStatus honoring promotion_allowed before checking blocking
// failures — is FIXED: veritas src/surface/readiness.mjs now checks
// readinessHasBlockingFailure() before the promotion_allowed short-circuit (regression-tested
// in veritas tests/surface/readiness-verdict.test.mjs), so this adapter and Veritas's exported
// functions now agree. The adapter keeps its own derivation because kit code consumes the
// recorded artifact, not Veritas library exports; the record fields and blocking-failure
// semantics it reads are frozen in veritas docs/architecture/engine-surface-seam.md
// (flow-agents#646 Slice 1). Ready (no blocking failure) -> Surface derives `verified` -> gate
// passes. Not-ready -> Surface derives a non-`verified` status -> gate blocks.
//
// Usage: node readiness-to-trust-bundle.mjs --report <veritas-evidence-report.json> \
//          --out <bundle.json> [--subject-id <id>]
// Exit: 0 on success (bundle written), 2 on bad args, 3 on unreadable/invalid report.

import { readFileSync, writeFileSync } from "node:fs";
import * as surface from "@kontourai/surface";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--report") out.report = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--subject-id") out.subjectId = argv[++i];
  }
  return out;
}

// Mirrors veritas/src/surface/readiness.mjs's readinessHasBlockingFailure — reads Veritas's
// OWN recorded results; does not evaluate standards. Ignores promotion_allowed (a routing hint,
// not a safety signal — see header comment above); since veritas#106 was fixed, Veritas's own
// verdict functions (src/surface/readiness.mjs) apply this same blocking-failure-first semantics.
export function hasBlockingFailure(record) {
  if (record.uncovered_path_result === "fail") return true;
  if ((record.policy_results ?? []).some((r) => r.passed === false && r.enforcementLevel === "Require")) return true;
  if ((record.selected_evidence_checks ?? []).some((c) => c.evidence_check_result?.passed === false)) return true;
  if ((record.external_tool_results ?? []).some((r) => r.blocking !== false && ["fail", "missing"].includes(r.verdict))) return true;
  return false;
}

export function buildReadinessTrustBundle(record, opts = {}) {
  const { deriveClaimStatus, generateClaimId } = surface;
  const ts = record.timestamp || new Date().toISOString();
  const runId = record.run_id || "veritas-run";
  const sourceRef = record.integrity?.sourceRef ?? record.source_ref ?? runId;
  const subjectId = opts.subjectId || sourceRef;
  const blocking = hasBlockingFailure(record);
  const ready = !blocking;

  const claimType = "software-readiness-verdict";
  const surfaceName = "veritas.readiness";
  const claimId = generateClaimId(subjectId, surfaceName, "mergeReadiness");
  const evId = `ev:${claimId}`;
  const evidenceType = "policy_rule"; // readiness is a governance/policy result (auditability)

  const policy = {
    id: `policy:${claimType}`,
    claimType,
    requiredEvidence: [evidenceType],
    acceptanceCriteria: ["A verified Veritas readiness evidence event supports the readiness verdict."],
    reviewAuthority: "system",
    validityRule: { kind: "manual" },
    stalenessTriggers: [],
    conflictRules: [],
    impactLevel: "high",
  };

  const failedRules = (record.policy_results ?? [])
    .filter((r) => r.passed === false && r.enforcementLevel === "Require")
    .map((r) => r.rule_id);
  const failedChecks = (record.selected_evidence_checks ?? [])
    .filter((c) => c.evidence_check_result?.passed === false)
    .map((c) => c.id);
  const summary = ready
    ? `Veritas readiness verdict is ready (run ${runId}); no blocking requirements or evidence failed.`
    : `Veritas readiness verdict is not ready (run ${runId}). Blocking: ${[...failedRules, ...failedChecks].join(", ") || record.uncovered_path_result}.`;

  const evItem = {
    id: evId,
    claimId,
    evidenceType,
    method: "auditability",
    sourceRef: `veritas:readiness:${runId}`,
    excerptOrSummary: summary,
    observedAt: ts,
    collectedBy: "veritas-governance-kit/readiness-adapter",
    passing: ready,
  };
  const evt = {
    id: `evt:${claimId}`,
    claimId,
    status: ready ? "verified" : "disputed",
    actor: "veritas-governance-kit/readiness-adapter",
    method: "auditability",
    evidenceIds: [evId],
    createdAt: ts,
    verifiedAt: ts,
  };
  const claim = {
    id: claimId,
    subjectType: "repository-change",
    subjectId,
    facet: surfaceName,
    claimType,
    fieldOrBehavior: "mergeReadiness",
    value: { verdict: ready ? "ready" : "not-ready", sourceRef, blocking: { failedRequirements: failedRules, failedEvidenceChecks: failedChecks } },
    createdAt: ts,
    updatedAt: ts,
    impactLevel: "high",
    verificationPolicyId: policy.id,
    currentIntegrityRef: sourceRef,
    metadata: { producer: "veritas", source: "readiness", runId },
  };
  const { status } = deriveClaimStatus({ claim, evidence: [evItem], events: [evt], policies: [policy] });

  return {
    bundle: {
      schemaVersion: 5,
      source: "veritas-governance-kit/readiness-adapter",
      claims: [{ ...claim, status }],
      evidence: [evItem],
      events: [evt],
      policies: [policy],
    },
    verdict: ready ? "ready" : "not-ready",
    derivedStatus: status,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.report || !args.out) {
    process.stderr.write("usage: readiness-to-trust-bundle.mjs --report <veritas-evidence-report.json> --out <bundle.json> [--subject-id <id>]\n");
    return 2;
  }
  let record;
  try {
    record = JSON.parse(readFileSync(args.report, "utf8"));
  } catch (err) {
    process.stderr.write(`cannot read Veritas evidence report: ${err && err.message ? err.message : String(err)}\n`);
    return 3;
  }
  const { bundle, verdict, derivedStatus } = buildReadinessTrustBundle(record, { subjectId: args.subjectId });
  writeFileSync(args.out, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  process.stdout.write(`readiness verdict: ${verdict}; software-readiness-verdict claim status: ${derivedStatus}; bundle: ${args.out}\n`);
  return 0;
}

const isEntry = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isEntry) process.exitCode = main();
