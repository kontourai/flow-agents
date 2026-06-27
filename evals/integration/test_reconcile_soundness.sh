#!/usr/bin/env bash
# test_reconcile_soundness.sh — Soundness regression evals for trust-reconcile.js.
#
# Proves all Round-5 adversarial gaps are closed:
#
#  A. COMPILE-ONLY-CLOSED:    no trust-reconcile-verify configured (only build fallback)
#     → exits 1 with "refusing to attest a compile-only check" message.
#
#  B. REAL-VERIFY-CLOSED:     build passes but a fake "real verify" (eval:static substitute)
#     fails → trust-reconcile exits 1 (PRE-FIX this would exit 0 because only build ran).
#
#  C. REAL-VERIFY-PASSES:     the comprehensive verify resolves green → exits 0 (legit
#     work is not false-blocked when package.json trust-reconcile-verify is present).
#
#  D. CHECKPOINT-BYPASS-CLOSED: a checkpoint-only bundle (no evidence/claims, statusByClaimId
#     all-passed) → exits 1 with checkpoint-bypass divergence (not a silent skip).
#
#  E. EV-PASSING-NORMALIZED:  bundle with passing:"pass" and passing:1 (non-boolean truthy)
#     evidence items → both are treated as claimed-pass and reconciled.
#
#  F. CLAIM-NO-EVIDENCE:      workflow.check.command claim with no evidence item →
#     not-run divergence, exits 1.
#
#  G. LAUNDERING-OR:          claimed pass for "npm test || exit 0" → laundering, exits 1.
#
#  H. LAUNDERING-ECHO-OK:     claimed pass for "npm test || echo ok" → laundering, exits 1.
#
#  I. LAUNDERING-BIN-TRUE:    claimed pass for "npm test || /bin/true" → laundering, exits 1.
#
#  J. LAUNDERING-SEMI-TRUE:   claimed pass for "npm test; true" → laundering, exits 1.
#
# Deterministic, no model spend, self-cleaning.
# Usage: bash evals/integration/test_reconcile_soundness.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RECONCILE="$ROOT/scripts/ci/trust-reconcile.js"

TMP="$(mktemp -d)"
errors=0

_pass() { echo "  PASS: $1"; }
_fail() { echo "  FAIL: $1"; errors=$((errors + 1)); }

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# ─── Minimal package.json without trust-reconcile-verify ──────────────────────
PKG_NO_VERIFY="$TMP/pkg_no_verify"
mkdir -p "$PKG_NO_VERIFY"
node -e "
const fs = require('fs');
const pkg = { name: 'test-pkg', scripts: { build: 'echo BUILD_ONLY' } };
fs.writeFileSync('$PKG_NO_VERIFY/package.json', JSON.stringify(pkg, null, 2));
"

# ─── Minimal package.json WITH trust-reconcile-verify ─────────────────────────
PKG_WITH_VERIFY="$TMP/pkg_with_verify"
mkdir -p "$PKG_WITH_VERIFY"
node -e "
const fs = require('fs');
const pkg = {
  name: 'test-pkg',
  scripts: {
    build: 'node -e \"process.exit(0)\"',
    'trust-reconcile-verify': 'node -e \"process.exit(0)\"'
  }
};
fs.writeFileSync('$PKG_WITH_VERIFY/package.json', JSON.stringify(pkg, null, 2));
"

# ─── Minimal package.json with failing verify ─────────────────────────────────
PKG_FAIL_VERIFY="$TMP/pkg_fail_verify"
mkdir -p "$PKG_FAIL_VERIFY"
node -e "
const fs = require('fs');
const pkg = {
  name: 'test-pkg',
  scripts: {
    build: 'node -e \"process.exit(0)\"',
    'trust-reconcile-verify': 'node -e \"process.exit(1)\"'
  }
};
fs.writeFileSync('$PKG_FAIL_VERIFY/package.json', JSON.stringify(pkg, null, 2));
"

# ─── Bundle builder helpers ────────────────────────────────────────────────────
# write_bundle_evidence: bundle with evidence[].passing = <passing_val> (any JS value)
write_bundle_evidence() {
  local bundle_path="$1"
  local label="$2"
  local passing_val="$3"   # raw JS value: true, false, "\"pass\"", 1, etc.

  node - "$bundle_path" "$label" "$passing_val" << 'NODE'
const fs = require('fs');
const [,, bundlePath, label, passingVal] = process.argv;
// Evaluate passing value as JS literal
const passing = JSON.parse(passingVal);
const bundle = {
  schemaVersion: 3,
  source: "test-fixture",
  claims: [
    {
      id: "c1",
      claimType: "workflow.check.build",
      value: "pass",
      status: "verified",
      subjectId: "test/build",
      surface: "flow-agents.workflow",
      subjectType: "workflow-check",
      fieldOrBehavior: "build",
      createdAt: "2026-06-27T00:00:00Z",
      updatedAt: "2026-06-27T00:00:00Z",
      impactLevel: "high",
      verificationPolicyId: "policy:workflow.check.build"
    }
  ],
  evidence: [
    {
      id: "ev1",
      claimId: "c1",
      evidenceType: "test_output",
      method: "validation",
      sourceRef: "test/command-log.jsonl",
      excerptOrSummary: "build",
      observedAt: "2026-06-27T00:00:00Z",
      collectedBy: "flow-agents/evidence-capture",
      passing: passing,
      execution: {
        runner: "bash",
        label: label,
        isError: !passing,
        exitCode: passing ? 0 : 1
      }
    }
  ],
  policies: [],
  events: []
};
fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));
NODE
}

# write_checkpoint: checkpoint-only bundle (no evidence[], no claims[])
write_checkpoint() {
  local bundle_path="$1"
  node - "$bundle_path" << 'NODE'
const fs = require('fs');
const [,, bundlePath] = process.argv;
const bundle = {
  schemaVersion: 1,
  source: "checkpoint",
  checkpoint: {
    statusByClaimId: {
      "c1": "passed",
      "c2": "passed",
      "c3": "passed"
    }
  }
};
fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));
NODE
}

# write_bundle_claim_no_evidence: bundle with a workflow.check.command claim but no evidence
write_bundle_claim_no_evidence() {
  local bundle_path="$1"
  node - "$bundle_path" << 'NODE'
const fs = require('fs');
const [,, bundlePath] = process.argv;
const bundle = {
  schemaVersion: 3,
  source: "test-fixture",
  claims: [
    {
      id: "c-no-ev",
      claimType: "workflow.check.command",
      value: "pass",
      status: "verified",
      subjectId: "test/command-never-run",
      surface: "flow-agents.workflow",
      subjectType: "workflow-check",
      fieldOrBehavior: "npm run test-never-ran",
      createdAt: "2026-06-27T00:00:00Z",
      updatedAt: "2026-06-27T00:00:00Z",
      impactLevel: "high",
      verificationPolicyId: "policy:workflow.check.command"
    }
  ],
  evidence: [],
  policies: [],
  events: []
};
fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));
NODE
}

# ═══════════════════════════════════════════════════════════════════════════════
# TEST A: COMPILE-ONLY-CLOSED
# No trust-reconcile-verify in package.json, no TRUST_RECONCILE_COMMANDS → fail-closed
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "=== TEST A: COMPILE-ONLY-CLOSED — no verify script configured → fail-closed ==="

outA=$(node "$RECONCILE" \
    --repo-root "$PKG_NO_VERIFY" 2>&1)
exitA=$?

if [[ $exitA -ne 0 ]]; then
  _pass "COMPILE-ONLY-CLOSED: exits 1 (got $exitA)"
else
  _fail "COMPILE-ONLY-CLOSED: expected exit 1 (compile-only refused), got 0"
fi

if echo "$outA" | grep -qi "refusing to attest a compile-only check\|no comprehensive trust-reconcile-verify"; then
  _pass "COMPILE-ONLY-CLOSED: message explains compile-only refusal"
else
  _fail "COMPILE-ONLY-CLOSED: expected compile-only refusal message, got: $outA"
fi

# Also verify: the message recommends how to fix it
if echo "$outA" | grep -q "trust-reconcile-verify\|TRUST_RECONCILE_COMMANDS"; then
  _pass "COMPILE-ONLY-CLOSED: message references how to fix (declare scripts or env)"
else
  _fail "COMPILE-ONLY-CLOSED: expected fix hint in message, got: $outA"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# TEST B: REAL-VERIFY-CLOSED
# package.json has trust-reconcile-verify but it FAILS (simulates real tests failing)
# PRE-FIX: would have exited 0 (only build ran). POST-FIX: exits 1.
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "=== TEST B: REAL-VERIFY-CLOSED — trust-reconcile-verify fails → exits 1 ==="

outB=$(node "$RECONCILE" \
    --repo-root "$PKG_FAIL_VERIFY" 2>&1)
exitB=$?

if [[ $exitB -ne 0 ]]; then
  _pass "REAL-VERIFY-CLOSED: exits 1 when trust-reconcile-verify fails (got $exitB)"
else
  _fail "REAL-VERIFY-CLOSED: expected exit 1 when real verify fails, got 0 — output: $outB"
fi

if echo "$outB" | grep -q "verification failed in CI"; then
  _pass "REAL-VERIFY-CLOSED: 'verification failed in CI' message present"
else
  _fail "REAL-VERIFY-CLOSED: expected 'verification failed in CI' message, got: $outB"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# TEST C: REAL-VERIFY-PASSES
# package.json has passing trust-reconcile-verify → exits 0 (not false-blocked)
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "=== TEST C: REAL-VERIFY-PASSES — passing verify + no bundle → exits 0 ==="

outC=$(node "$RECONCILE" \
    --repo-root "$PKG_WITH_VERIFY" 2>&1)
exitC=$?

if [[ $exitC -eq 0 ]]; then
  _pass "REAL-VERIFY-PASSES: exits 0 when real verify passes and no bundle (got $exitC)"
else
  _fail "REAL-VERIFY-PASSES: expected exit 0, got $exitC — output: $outC"
fi

if echo "$outC" | grep -q "fresh verify passed"; then
  _pass "REAL-VERIFY-PASSES: 'fresh verify passed' message present"
else
  _fail "REAL-VERIFY-PASSES: expected 'fresh verify passed' in output, got: $outC"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# TEST D: CHECKPOINT-BYPASS-CLOSED
# Checkpoint-only bundle (no evidence/claims, all statusByClaimId=passed) → divergence
# PRE-FIX: exited 0 (silently skipped per-command reconcile). POST-FIX: exits 1.
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "=== TEST D: CHECKPOINT-BYPASS-CLOSED — checkpoint-only bundle → divergence ==="

CHECKPOINT_BUNDLE="$TMP/checkpoint.json"
write_checkpoint "$CHECKPOINT_BUNDLE"

outD=$(TRUST_RECONCILE_COMMANDS="node -e 'process.exit(0)'" \
  node "$RECONCILE" \
    --bundle "$CHECKPOINT_BUNDLE" \
    --repo-root "$TMP" 2>&1)
exitD=$?

if [[ $exitD -ne 0 ]]; then
  _pass "CHECKPOINT-BYPASS-CLOSED: exits 1 (got $exitD)"
else
  _fail "CHECKPOINT-BYPASS-CLOSED: expected exit 1 (checkpoint bypass closed), got 0 — output: $outD"
fi

if echo "$outD" | grep -q "checkpoint-only bundle"; then
  _pass "CHECKPOINT-BYPASS-CLOSED: 'checkpoint-only bundle' message present"
else
  _fail "CHECKPOINT-BYPASS-CLOSED: expected 'checkpoint-only bundle' in output, got: $outD"
fi

if echo "$outD" | grep -q "trust divergence"; then
  _pass "CHECKPOINT-BYPASS-CLOSED: 'trust divergence' emitted for checkpoint bundle"
else
  _fail "CHECKPOINT-BYPASS-CLOSED: expected 'trust divergence' in output, got: $outD"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# TEST E: EV-PASSING-NORMALIZED
# evidence with passing:"pass" is treated as claimed-pass (not dropped)
# evidence with passing:1 is also treated as claimed-pass
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "=== TEST E: EV-PASSING-NORMALIZED — passing:\"pass\" and passing:1 both reconciled ==="

# E1: passing:"pass" — claimed pass, CI re-run also PASSES → reconciled (exit 0)
BUNDLE_E1="$TMP/bundle-pass-string.json"
write_bundle_evidence "$BUNDLE_E1" "node -e 'process.exit(0)'" '"pass"'

outE1=$(TRUST_RECONCILE_COMMANDS="node -e 'process.exit(0)'" \
  node "$RECONCILE" \
    --bundle "$BUNDLE_E1" \
    --repo-root "$TMP" 2>&1)
exitE1=$?

if [[ $exitE1 -eq 0 ]]; then
  _pass "EV-PASSING-NORMALIZED: passing:\"pass\" evidence is reconciled (exit 0)"
else
  _fail "EV-PASSING-NORMALIZED: passing:\"pass\" should exit 0 (reconciled), got $exitE1 — output: $outE1"
fi

if echo "$outE1" | grep -q "RECONCILED"; then
  _pass "EV-PASSING-NORMALIZED: RECONCILED shown for passing:\"pass\" evidence"
else
  _fail "EV-PASSING-NORMALIZED: expected RECONCILED for passing:\"pass\", got: $outE1"
fi

# E2: passing:"pass" — claimed pass, CI re-run FAILS → divergence (exit 1)
BUNDLE_E2="$TMP/bundle-pass-string-fail.json"
write_bundle_evidence "$BUNDLE_E2" "node -e 'process.exit(1)'" '"pass"'

outE2=$(TRUST_RECONCILE_COMMANDS="node -e 'process.exit(1)'" \
  node "$RECONCILE" \
    --bundle "$BUNDLE_E2" \
    --repo-root "$TMP" 2>&1)
exitE2=$?

if [[ $exitE2 -ne 0 ]]; then
  _pass "EV-PASSING-NORMALIZED: passing:\"pass\" evidence triggers divergence when CI fails (exit 1)"
else
  _fail "EV-PASSING-NORMALIZED: passing:\"pass\" should exit 1 (divergence), got 0 — output: $outE2"
fi

# E3: passing:1 — treated as claimed-pass, CI PASSES → reconciled (exit 0)
BUNDLE_E3="$TMP/bundle-pass-int.json"
write_bundle_evidence "$BUNDLE_E3" "node -e 'process.exit(0)'" '1'

outE3=$(TRUST_RECONCILE_COMMANDS="node -e 'process.exit(0)'" \
  node "$RECONCILE" \
    --bundle "$BUNDLE_E3" \
    --repo-root "$TMP" 2>&1)
exitE3=$?

if [[ $exitE3 -eq 0 ]]; then
  _pass "EV-PASSING-NORMALIZED: passing:1 evidence is reconciled (exit 0)"
else
  _fail "EV-PASSING-NORMALIZED: passing:1 should exit 0 (reconciled), got $exitE3 — output: $outE3"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# TEST F: CLAIM-NO-EVIDENCE
# workflow.check.command claim with no evidence item → not-run divergence, exits 1
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "=== TEST F: CLAIM-NO-EVIDENCE — workflow.check.command claim, no evidence → not-run ==="

BUNDLE_F="$TMP/bundle-claim-no-ev.json"
write_bundle_claim_no_evidence "$BUNDLE_F"

outF=$(TRUST_RECONCILE_COMMANDS="node -e 'process.exit(0)'" \
  node "$RECONCILE" \
    --bundle "$BUNDLE_F" \
    --repo-root "$TMP" 2>&1)
exitF=$?

if [[ $exitF -ne 0 ]]; then
  _pass "CLAIM-NO-EVIDENCE: exits 1 (not-run divergence) (got $exitF)"
else
  _fail "CLAIM-NO-EVIDENCE: expected exit 1 (no-evidence divergence), got 0 — output: $outF"
fi

if echo "$outF" | grep -q "trust divergence"; then
  _pass "CLAIM-NO-EVIDENCE: 'trust divergence' emitted"
else
  _fail "CLAIM-NO-EVIDENCE: expected 'trust divergence' in output, got: $outF"
fi

if echo "$outF" | grep -q "no supporting evidence\|never captured"; then
  _pass "CLAIM-NO-EVIDENCE: message describes missing evidence"
else
  _fail "CLAIM-NO-EVIDENCE: expected 'no supporting evidence' or 'never captured' message, got: $outF"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# TEST G: LAUNDERING-OR-EXIT0
# claimed pass for "npm test || exit 0" → laundering, exits 1
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "=== TEST G: LAUNDERING-OR-EXIT0 — \"npm test || exit 0\" → laundering ==="

BUNDLE_G="$TMP/bundle-launder-or-exit0.json"
write_bundle_evidence "$BUNDLE_G" "npm test || exit 0" 'true'

outG=$(TRUST_RECONCILE_COMMANDS="node -e 'process.exit(0)'" \
  node "$RECONCILE" \
    --bundle "$BUNDLE_G" \
    --repo-root "$TMP" 2>&1)
exitG=$?

if [[ $exitG -ne 0 ]]; then
  _pass "LAUNDERING-OR-EXIT0: exits 1"
else
  _fail "LAUNDERING-OR-EXIT0: expected exit 1, got 0 — output: $outG"
fi

if echo "$outG" | grep -q "laundering"; then
  _pass "LAUNDERING-OR-EXIT0: 'laundering' message present"
else
  _fail "LAUNDERING-OR-EXIT0: expected 'laundering' message, got: $outG"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# TEST H: LAUNDERING-OR-ECHO-OK
# claimed pass for "npm test || echo ok" → laundering (any ||), exits 1
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "=== TEST H: LAUNDERING-OR-ECHO-OK — \"npm test || echo ok\" → laundering ==="

BUNDLE_H="$TMP/bundle-launder-or-echo.json"
write_bundle_evidence "$BUNDLE_H" "npm test || echo ok" 'true'

outH=$(TRUST_RECONCILE_COMMANDS="node -e 'process.exit(0)'" \
  node "$RECONCILE" \
    --bundle "$BUNDLE_H" \
    --repo-root "$TMP" 2>&1)
exitH=$?

if [[ $exitH -ne 0 ]]; then
  _pass "LAUNDERING-OR-ECHO-OK: exits 1"
else
  _fail "LAUNDERING-OR-ECHO-OK: expected exit 1, got 0 — output: $outH"
fi

if echo "$outH" | grep -q "laundering"; then
  _pass "LAUNDERING-OR-ECHO-OK: 'laundering' message present"
else
  _fail "LAUNDERING-OR-ECHO-OK: expected 'laundering' message, got: $outH"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# TEST I: LAUNDERING-OR-BIN-TRUE
# claimed pass for "npm test || /bin/true" → laundering (any ||), exits 1
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "=== TEST I: LAUNDERING-OR-BIN-TRUE — \"npm test || /bin/true\" → laundering ==="

BUNDLE_I="$TMP/bundle-launder-or-bintrue.json"
write_bundle_evidence "$BUNDLE_I" "npm test || /bin/true" 'true'

outI=$(TRUST_RECONCILE_COMMANDS="node -e 'process.exit(0)'" \
  node "$RECONCILE" \
    --bundle "$BUNDLE_I" \
    --repo-root "$TMP" 2>&1)
exitI=$?

if [[ $exitI -ne 0 ]]; then
  _pass "LAUNDERING-OR-BIN-TRUE: exits 1"
else
  _fail "LAUNDERING-OR-BIN-TRUE: expected exit 1, got 0 — output: $outI"
fi

if echo "$outI" | grep -q "laundering"; then
  _pass "LAUNDERING-OR-BIN-TRUE: 'laundering' message present"
else
  _fail "LAUNDERING-OR-BIN-TRUE: expected 'laundering' message, got: $outI"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# TEST J: LAUNDERING-SEMI-TRUE
# claimed pass for "npm test; true" → laundering (; true form), exits 1
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "=== TEST J: LAUNDERING-SEMI-TRUE — \"npm test; true\" → laundering ==="

BUNDLE_J="$TMP/bundle-launder-semi-true.json"
write_bundle_evidence "$BUNDLE_J" "npm test; true" 'true'

outJ=$(TRUST_RECONCILE_COMMANDS="node -e 'process.exit(0)'" \
  node "$RECONCILE" \
    --bundle "$BUNDLE_J" \
    --repo-root "$TMP" 2>&1)
exitJ=$?

if [[ $exitJ -ne 0 ]]; then
  _pass "LAUNDERING-SEMI-TRUE: exits 1"
else
  _fail "LAUNDERING-SEMI-TRUE: expected exit 1, got 0 — output: $outJ"
fi

if echo "$outJ" | grep -q "laundering"; then
  _pass "LAUNDERING-SEMI-TRUE: 'laundering' message present"
else
  _fail "LAUNDERING-SEMI-TRUE: expected 'laundering' message, got: $outJ"
fi

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "────────────────────────────────────────────"
if [[ $errors -eq 0 ]]; then
  echo "test_reconcile_soundness: all checks passed."
  exit 0
else
  echo "test_reconcile_soundness: $errors check(s) failed."
  exit 1
fi
