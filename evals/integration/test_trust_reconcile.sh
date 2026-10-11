#!/usr/bin/env bash
# test_trust_reconcile.sh — Integration eval for the CI trust anchor (Phase 1).
#
# Proves that scripts/ci/trust-reconcile.js correctly:
#   1. DIVERGENCE-CAUGHT:  bundle claims a command passed; CI re-runs it and it FAILS.
#      Exit 1 with "trust divergence" message naming the command.
#   2. MATCHING-PASSES:    bundle claims a command passed; CI re-runs it and it PASSES.
#      Exit 0 (no divergence).
#   3. NO-CHECKPOINT:      no bundle present, no delivery/DECLARED marker; canonical
#      verify passes. Exit 1 — bundle required by default (ADR 0022 §1); the
#      'bundle-required-no-declared-marker' issue fires (no more fail-open on absence).
#   4. LAUNDERING-CAUGHT:  bundle claims "something || true" passed.
#      Exit 1 with laundering message (checked before "CI never ran" check).
#
# The CI workflow and trust-verify action that ran this reconciler were retired
# (2026-10-11); the workflow/action YAML checks went with them.
#
# Deterministic, no model spend, self-cleaning.
# Usage: bash evals/integration/test_trust_reconcile.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RECONCILE="$ROOT/scripts/ci/trust-reconcile.js"

TMP="$(mktemp -d)"
errors=0

_pass() { echo "  PASS: $1"; }
_fail() { echo "  FAIL: $1"; errors=$((errors + 1)); }

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# ─── Fixture bundle builder ───────────────────────────────────────────────────
# Writes a minimal trust.bundle fixture to a path.
# Usage: write_bundle <path> <label> <passing>
#   <label>   — the execution.label command string in the evidence item
#   <passing> — true or false
write_bundle() {
  local bundle_path="$1"
  local label="$2"
  local passing="$3"

  node - "$bundle_path" "$label" "$passing" << 'NODE'
const fs = require('fs');
const [,, bundlePath, label, passingStr] = process.argv;
const passing = passingStr === 'true';
const bundle = {
  schemaVersion: 5,
  source: "test-fixture",
  claims: [
    {
      id: "c1",
      claimType: "workflow.check.build",
      value: passing ? "pass" : "fail",
      status: passing ? "verified" : "disputed",
      subjectId: "test-slug/build",
      facet: "flow-agents.workflow",
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
      sourceRef: "test-slug/command-log.jsonl",
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

# ─── TEST 1: DIVERGENCE-CAUGHT ────────────────────────────────────────────────
echo ""
echo "=== TEST 1: DIVERGENCE-CAUGHT — claimed pass, CI re-run FAILS ==="

BUNDLE1="$TMP/bundle-diverge.json"
write_bundle "$BUNDLE1" "node -e 'process.exit(1)'" "true"

# canonical command is "node -e 'process.exit(1)'" — it fails
# bundle claims that same command passed → divergence
GITHUB_OUTPUT_FILE="$TMP/github-output"
out1=$(GITHUB_OUTPUT="$GITHUB_OUTPUT_FILE" TRUST_RECONCILE_COMMANDS="node -e 'process.exit(1)'" \
  node "$RECONCILE" \
    --bundle "$BUNDLE1" \
    --repo-root "$TMP" 2>&1)
exit1=$?

if [[ $exit1 -ne 0 ]]; then
  _pass "DIVERGENCE-CAUGHT: exits 1 (got $exit1)"
else
  _fail "DIVERGENCE-CAUGHT: expected exit 1, got 0"
fi

if echo "$out1" | grep -q "trust divergence"; then
  _pass "DIVERGENCE-CAUGHT: output contains 'trust divergence'"
else
  _fail "DIVERGENCE-CAUGHT: expected 'trust divergence' in output, got: $out1"
fi

# Verify the divergent command name appears in the message
if echo "$out1" | grep -q "process.exit(1)"; then
  _pass "DIVERGENCE-CAUGHT: output names the divergent command"
else
  _fail "DIVERGENCE-CAUGHT: expected command name in output, got: $out1"
fi

if grep -q '^failure-summary<<trust_reconcile_' "$GITHUB_OUTPUT_FILE" &&
   grep -q '\[fresh-fail\] verification failed in CI' "$GITHUB_OUTPUT_FILE"; then
  _pass "DIVERGENCE-CAUGHT: exposes structured failure-summary output"
else
  _fail "DIVERGENCE-CAUGHT: expected structured failure-summary output, got: $(cat "$GITHUB_OUTPUT_FILE" 2>/dev/null)"
fi

# ─── TEST 2: MATCHING-PASSES ──────────────────────────────────────────────────
echo ""
echo "=== TEST 2: MATCHING-PASSES — claimed pass, CI re-run also PASSES ==="

BUNDLE2="$TMP/bundle-match.json"
write_bundle "$BUNDLE2" "node -e 'process.exit(0)'" "true"

out2=$(TRUST_RECONCILE_COMMANDS="node -e 'process.exit(0)'" \
  node "$RECONCILE" \
    --bundle "$BUNDLE2" \
    --repo-root "$TMP" 2>&1)
exit2=$?

if [[ $exit2 -eq 0 ]]; then
  _pass "MATCHING-PASSES: exits 0"
else
  _fail "MATCHING-PASSES: expected exit 0, got $exit2 — output: $out2"
fi

if echo "$out2" | grep -q "RECONCILED"; then
  _pass "MATCHING-PASSES: output shows RECONCILED"
else
  _fail "MATCHING-PASSES: expected 'RECONCILED' in output, got: $out2"
fi

# ─── TEST 3: NO-CHECKPOINT ────────────────────────────────────────────────────
echo ""
echo "=== TEST 3: NO-CHECKPOINT — no bundle present, fresh verify only ==="

out3=$(TRUST_RECONCILE_COMMANDS="node -e 'process.exit(0)'" \
  node "$RECONCILE" \
    --repo-root "$TMP" 2>&1)
exit3=$?

if [[ $exit3 -ne 0 ]]; then
  _pass "NO-CHECKPOINT: exits 1 (bundle required by default, no bundle, no marker) — got $exit3"
else
  _fail "NO-CHECKPOINT: expected exit 1 (bundle-required by default, ADR 0022 §1), got 0 — output: $out3"
fi

if echo "$out3" | grep -q "bundle-required-no-declared-marker"; then
  _pass "NO-CHECKPOINT: output contains 'bundle-required-no-declared-marker'"
else
  _fail "NO-CHECKPOINT: expected 'bundle-required-no-declared-marker' in output, got: $out3"
fi

# Also verify: no-bundle + failing fresh verify still exits 1
out3b=$(TRUST_RECONCILE_COMMANDS="node -e 'process.exit(1)'" \
  node "$RECONCILE" \
    --repo-root "$TMP" 2>&1)
exit3b=$?

if [[ $exit3b -ne 0 ]]; then
  _pass "NO-CHECKPOINT: exits 1 when fresh verify fails (no bundle)"
else
  _fail "NO-CHECKPOINT: expected exit 1 when fresh verify fails, got 0 — output: $out3b"
fi

if echo "$out3b" | grep -q "verification failed in CI"; then
  _pass "NO-CHECKPOINT: 'verification failed in CI' message when fresh verify fails"
else
  _fail "NO-CHECKPOINT: expected 'verification failed in CI' message, got: $out3b"
fi

# ─── TEST 4: LAUNDERING-CAUGHT ────────────────────────────────────────────────
echo ""
echo "=== TEST 4: LAUNDERING-CAUGHT — claimed pass for a laundered command ==="

# Bundle claims 'npm run build || true' passed.
# Canonical verify is a passing command (unrelated).
# Laundering check fires first — before "CI never ran" check.
BUNDLE4="$TMP/bundle-launder.json"
write_bundle "$BUNDLE4" "npm run build || true" "true"

out4=$(TRUST_RECONCILE_COMMANDS="node -e 'process.exit(0)'" \
  node "$RECONCILE" \
    --bundle "$BUNDLE4" \
    --repo-root "$TMP" 2>&1)
exit4=$?

if [[ $exit4 -ne 0 ]]; then
  _pass "LAUNDERING-CAUGHT: exits 1"
else
  _fail "LAUNDERING-CAUGHT: expected exit 1, got 0 — output: $out4"
fi

if echo "$out4" | grep -q "laundering"; then
  _pass "LAUNDERING-CAUGHT: output contains 'laundering'"
else
  _fail "LAUNDERING-CAUGHT: expected 'laundering' in output, got: $out4"
fi

if echo "$out4" | grep -q "trust divergence"; then
  _pass "LAUNDERING-CAUGHT: output contains 'trust divergence'"
else
  _fail "LAUNDERING-CAUGHT: expected 'trust divergence' in output, got: $out4"
fi

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "────────────────────────────────────────────"
if [[ $errors -eq 0 ]]; then
  echo "test_trust_reconcile: all checks passed."
  exit 0
else
  echo "test_trust_reconcile: $errors check(s) failed."
  exit 1
fi
