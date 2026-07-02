// veritas-readiness-adapter.test.mjs — direct node:test coverage for the Veritas Governance
// Kit adapter (kits/veritas-governance/adapter/readiness-to-trust-bundle.mjs), specifically
// hasBlockingFailure() and buildReadinessTrustBundle().
//
// WS5 iteration-2 part 2: the adapter-vs-Veritas semantics fork is SETTLED (owner-ratified +
// investigation-confirmed, see .kontourai/flow-agents/ws5-governance-kit-slice1 session
// findings). The adapter's stricter blocking-failure derivation is CORRECT: it matches
// Veritas's own PRIVATE readinessHasBlockingFailure helper (veritas/src/surface/readiness.mjs)
// and Surface's weakest-link claim derivation (tests/surface/readiness-derived-claim.test.mjs
// in veritas). The adapter intentionally does NOT apply record.promotion_allowed as a
// short-circuit — promotion_allowed is a workstream-routing hint, not a safety signal, and
// Veritas's own EXPORTED readinessSurfaceStatus()/readinessVerdict() short-circuiting on it is
// a filed Veritas bug: kontourai/veritas#106
// (https://github.com/kontourai/veritas/issues/106). These tests pin the adapter's
// blocking-failure semantics as the durable contract, and include explicit parity-pinning
// cases (below) asserting the adapter verdict against the documented blocking-failure
// semantics. Once veritas#106 is fixed upstream, Veritas's exported functions will agree with
// this adapter (and with these tests) instead of diverging from them.
//
// GLOB NOTE: `npm run test:unit` only globs `src/cli/*.test.mjs` (see package.json). The
// adapter under test lives in `kits/veritas-governance/adapter/`, which is plain JS (not
// compiled by tsc — see tsconfig.json's `include: ["src/**/*.ts"]`), so it is imported here
// directly by relative path rather than from `build/`. This test file is placed under
// `src/cli/` — not colocated with the adapter under `kits/veritas-governance/` — purely so it
// is picked up by the existing test:unit glob; there is no other test runner wired for
// `kits/**`. If a kit-scoped test glob is added later, this file (or a copy) should move
// there instead.
//
// Run: `npm run test:unit`.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { hasBlockingFailure, buildReadinessTrustBundle } from "../../kits/veritas-governance/adapter/readiness-to-trust-bundle.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, "../../kits/veritas-governance/fixtures/readiness");

function loadFixture(name) {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), "utf8"));
}

// ─── hasBlockingFailure — synthetic minimal records ────────────────────────────────────────

test("hasBlockingFailure: clean record (no blocking signal) returns false", () => {
  assert.equal(hasBlockingFailure({}), false);
  assert.equal(
    hasBlockingFailure({
      uncovered_path_result: "pass",
      policy_results: [{ passed: true, enforcementLevel: "Require", rule_id: "r1" }],
      selected_evidence_checks: [{ id: "c1", evidence_check_result: { passed: true } }],
      external_tool_results: [{ verdict: "pass", blocking: true }],
    }),
    false,
  );
});

test("hasBlockingFailure: uncovered_path_result === 'fail' is blocking", () => {
  assert.equal(hasBlockingFailure({ uncovered_path_result: "fail" }), true);
});

test("hasBlockingFailure: a failed Require-enforcement policy result is blocking", () => {
  assert.equal(
    hasBlockingFailure({
      policy_results: [{ passed: false, enforcementLevel: "Require", rule_id: "required-x" }],
    }),
    true,
  );
});

test("hasBlockingFailure: a failed policy result with a non-Require enforcement level is NOT blocking", () => {
  assert.equal(
    hasBlockingFailure({
      policy_results: [{ passed: false, enforcementLevel: "Recommend", rule_id: "recommend-x" }],
    }),
    false,
  );
});

test("hasBlockingFailure: a failed selected evidence check is blocking", () => {
  assert.equal(
    hasBlockingFailure({
      selected_evidence_checks: [{ id: "c1", evidence_check_result: { passed: false } }],
    }),
    true,
  );
});

test("hasBlockingFailure: a blocking external-tool fail/missing verdict is blocking", () => {
  assert.equal(hasBlockingFailure({ external_tool_results: [{ verdict: "fail", blocking: true }] }), true);
  assert.equal(hasBlockingFailure({ external_tool_results: [{ verdict: "missing" }] }), true); // blocking defaults truthy (only `false` opts out)
});

test("hasBlockingFailure: a NON-blocking external-tool fail (blocking: false) is not blocking", () => {
  assert.equal(hasBlockingFailure({ external_tool_results: [{ verdict: "fail", blocking: false }] }), false);
});

// ─── hasBlockingFailure — settled promotion_allowed non-application ───────────────────────
// SETTLED: unlike Veritas's own EXPORTED readinessSurfaceStatus()/readinessVerdict(), this
// adapter does NOT short-circuit on record.promotion_allowed. A record with
// promotion_allowed: true AND a failing Require rule is still treated as blocking by the
// adapter — this is correct: promotion_allowed is a workstream-routing hint (set only in
// Veritas's src/repo/routing.mjs resolveWorkstream() from file-pattern lane resolution), not a
// safety signal, and Veritas's own short-circuit on it is a filed bug (kontourai/veritas#106).
test("hasBlockingFailure: promotion_allowed=true does NOT suppress a blocking Require failure (settled semantics; veritas#106)", () => {
  const record = {
    promotion_allowed: true,
    policy_results: [{ passed: false, enforcementLevel: "Require", rule_id: "required-veritas-cli-artifacts" }],
  };
  assert.equal(hasBlockingFailure(record), true, "adapter correctly ignores promotion_allowed — see header comment / session findings / veritas#106");
});

test("hasBlockingFailure: promotion_allowed=false with no blocking signal is not blocking (promotion_allowed is ignored either way)", () => {
  const record = {
    promotion_allowed: false,
    uncovered_path_result: "pass",
    policy_results: [{ passed: true, enforcementLevel: "Require", rule_id: "r1" }],
    selected_evidence_checks: [{ id: "c1", evidence_check_result: { passed: true } }],
    external_tool_results: [{ verdict: "pass", blocking: true }],
  };
  assert.equal(hasBlockingFailure(record), false);
});

// ─── buildReadinessTrustBundle — synthetic records ─────────────────────────────────────────

test("buildReadinessTrustBundle: a clean record yields a ready/verified software-readiness-verdict claim", async () => {
  const record = {
    run_id: "test-run-ready",
    timestamp: "2026-07-02T00:00:00.000Z",
    source_ref: "test-subject-ready",
    policy_results: [],
    selected_evidence_checks: [],
    external_tool_results: [],
    uncovered_path_result: "pass",
  };
  const { bundle, verdict, derivedStatus } = await buildReadinessTrustBundle(record);

  assert.equal(verdict, "ready");
  assert.equal(derivedStatus, "verified");
  // schemaVersion stays 3 / facet stays surface deliberately: this bundle is consumed by
  // `flow attach-evidence --bundle`, which validates against hachure@0.5.1's schema (enum
  // [2,3,4], `surface` required) -- see the adapter's DELIBERATE LEGACY WRITE comment.
  assert.equal(bundle.schemaVersion, 3);
  assert.equal(bundle.source, "veritas-governance-kit/readiness-adapter");
  assert.equal(bundle.claims.length, 1);
  const claim = bundle.claims[0];
  assert.equal(claim.claimType, "software-readiness-verdict");
  assert.equal(claim.surface, "veritas.readiness");
  assert.equal(claim.subjectId, "test-subject-ready");
  assert.equal(claim.value.verdict, "ready");
  assert.equal(claim.status, "verified");
  assert.deepEqual(claim.value.blocking, { failedRequirements: [], failedEvidenceChecks: [] });
  assert.equal(bundle.evidence[0].passing, true);
  assert.equal(bundle.events[0].status, "verified");
});

test("buildReadinessTrustBundle: a record with a blocking Require failure yields a not-ready/disputed claim", async () => {
  const record = {
    run_id: "test-run-not-ready",
    timestamp: "2026-07-02T00:00:00.000Z",
    source_ref: "test-subject-not-ready",
    policy_results: [{ passed: false, enforcementLevel: "Require", rule_id: "required-thing" }],
    selected_evidence_checks: [],
    external_tool_results: [],
    uncovered_path_result: "pass",
  };
  const { bundle, verdict, derivedStatus } = await buildReadinessTrustBundle(record);

  assert.equal(verdict, "not-ready");
  assert.equal(derivedStatus, "disputed");
  const claim = bundle.claims[0];
  assert.equal(claim.value.verdict, "not-ready");
  assert.equal(claim.status, "disputed");
  assert.deepEqual(claim.value.blocking.failedRequirements, ["required-thing"]);
  assert.equal(bundle.evidence[0].passing, false);
  assert.equal(bundle.events[0].status, "disputed");
});

test("buildReadinessTrustBundle: --subject-id override wins over record source_ref/integrity.sourceRef", async () => {
  const record = {
    run_id: "test-run-subject",
    timestamp: "2026-07-02T00:00:00.000Z",
    source_ref: "record-source-ref",
    policy_results: [],
  };
  const { bundle } = await buildReadinessTrustBundle(record, { subjectId: "explicit-subject" });
  assert.equal(bundle.claims[0].subjectId, "explicit-subject");
});

// ─── buildReadinessTrustBundle — real captured fixtures (settled semantics) ────────────────
// The two committed fixtures are REAL captured `veritas readiness --check evidence
// --working-tree` output (see kits/veritas-governance/fixtures/readiness/*). Both have
// promotion_allowed: true; not-ready.readiness-report.json also has a failing Require rule.
// Veritas's own EXPORTED readinessSurfaceStatus() would (today) report BOTH as verified/ready
// because it short-circuits on promotion_allowed — that is the filed bug, kontourai/veritas#106
// (https://github.com/kontourai/veritas/issues/106). This adapter correctly disagrees on the
// not-ready fixture. Once #106 is fixed upstream, Veritas's exported functions will agree with
// the adapter (and with these tests) instead of diverging from them.

test("buildReadinessTrustBundle: ready.readiness-report.json fixture -> ready/verified", async () => {
  const record = loadFixture("ready.readiness-report.json");
  const { verdict, derivedStatus } = await buildReadinessTrustBundle(record);
  assert.equal(verdict, "ready");
  assert.equal(derivedStatus, "verified");
});

test("buildReadinessTrustBundle: not-ready.readiness-report.json fixture -> not-ready/disputed despite promotion_allowed=true (settled semantics; veritas#106)", async () => {
  const record = loadFixture("not-ready.readiness-report.json");
  assert.equal(record.promotion_allowed, true, "fixture precondition: promotion_allowed is true");
  const { verdict, derivedStatus } = await buildReadinessTrustBundle(record);
  assert.equal(verdict, "not-ready");
  assert.equal(derivedStatus, "disputed");
});

// ─── Parity pinning (WS5 iteration-2 part 2) ───────────────────────────────────────────────
// Explicit parity assertions: for both shipped fixtures plus two synthetic records, the
// adapter verdict must match the documented blocking-failure semantics (README "Semantics"
// section / adapter header comment) regardless of record.promotion_allowed. Once
// kontourai/veritas#106 (https://github.com/kontourai/veritas/issues/106) is fixed, Veritas's
// own exported readinessSurfaceStatus()/readinessVerdict() will independently agree with these
// same verdicts instead of short-circuiting to verified/ready on promotion_allowed===true.

test("parity: ready.readiness-report.json fixture matches documented blocking-failure semantics -> ready", async () => {
  const record = loadFixture("ready.readiness-report.json");
  const { verdict } = await buildReadinessTrustBundle(record);
  assert.equal(verdict, hasBlockingFailure(record) ? "not-ready" : "ready");
  assert.equal(verdict, "ready");
});

test("parity: not-ready.readiness-report.json fixture matches documented blocking-failure semantics -> not-ready (independent of promotion_allowed=true)", async () => {
  const record = loadFixture("not-ready.readiness-report.json");
  const { verdict } = await buildReadinessTrustBundle(record);
  assert.equal(verdict, hasBlockingFailure(record) ? "not-ready" : "ready");
  assert.equal(verdict, "not-ready");
});

test("parity: synthetic promotion_allowed=true + failing Require matches documented blocking-failure semantics -> not-ready", async () => {
  const record = {
    run_id: "parity-true-failing",
    promotion_allowed: true,
    policy_results: [{ passed: false, enforcementLevel: "Require", rule_id: "required-parity-check" }],
    selected_evidence_checks: [],
    external_tool_results: [],
    uncovered_path_result: "pass",
  };
  const { verdict, derivedStatus } = await buildReadinessTrustBundle(record);
  assert.equal(verdict, hasBlockingFailure(record) ? "not-ready" : "ready");
  assert.equal(verdict, "not-ready");
  assert.equal(derivedStatus, "disputed");
});

test("parity: synthetic promotion_allowed=false + clean record matches documented blocking-failure semantics -> ready", async () => {
  const record = {
    run_id: "parity-false-clean",
    promotion_allowed: false,
    policy_results: [{ passed: true, enforcementLevel: "Require", rule_id: "required-parity-check" }],
    selected_evidence_checks: [{ id: "c1", evidence_check_result: { passed: true } }],
    external_tool_results: [{ verdict: "pass", blocking: true }],
    uncovered_path_result: "pass",
  };
  const { verdict, derivedStatus } = await buildReadinessTrustBundle(record);
  assert.equal(verdict, hasBlockingFailure(record) ? "not-ready" : "ready");
  assert.equal(verdict, "ready");
  assert.equal(derivedStatus, "verified");
});
