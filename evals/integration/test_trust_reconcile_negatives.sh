#!/usr/bin/env bash
# test_trust_reconcile_negatives.sh — WS8 iteration-2 anti-gaming negative regressions.
#
# Every live exploit the reviewer/verifier reproduced against the WS8 reconciler is frozen
# here as a permanent negative fixture. Each asserts the REAL scripts/ci/trust-reconcile.js
# exits NON-ZERO and emits the SPECIFIC divergence string the fix introduced. If any fix is
# ever regressed, the corresponding exploit passes again and this eval (which runs in the
# required runtime-and-kit lane via antigaming-suite.sh) goes red.
#
#   1. no-label-bypass       (finding 1) → not-run: a test_output claim with no
#      manifest-matched execution.label is a divergence, never session-local.
#   2. skip-assumed-bypass   (finding 2) → unwaived-assumed: 'assumed' alone is not a pass.
#   3. status-misassertion   (finding 3) → status-misassertion: CI re-derives status; a
#      self-reported status that does not match the bundle's own evidence is rejected.
#   4. waived-command-check  (finding 4) → waiver-on-command-check: a command-backed
#      (test_output) check cannot be waived.
#   5. ws3-old-style-bundle  (AC6) → old all-test_output bundle FAILS the same way (exit 1,
#      divergences) under the new reconciler as under the old one — no soundness regression.
#   6. fabricated-attestation (iteration-4, converged iteration-3 finding, both gates) → a
#      fully self-consistent, hand-fabricated no-command 'security' claim+evidence+event
#      triple (indistinguishable from a genuine attestation at the reconciler's own
#      re-derivation layer) MUST still pass (exit 0 — blocking attestations at L0 would break
#      every honest human-attestation use) BUT MUST be loudly, distinctly marked
#      'ATTESTED (not independently verifiable at L0)' plus the summary count line — never a
#      quiet SESSION-LOCAL OK indistinguishable from a reconciled check. See ADR 0020 Residuals.
#
# Fresh-verify (Step 1) is a trivial pass so the proof is focused on the reconcile step; the
# manifest resolves from this repo's live run-baseline.sh registry (--repo-root "$ROOT").
# Deterministic, no model spend, self-cleaning.
# Usage: bash evals/integration/test_trust_reconcile_negatives.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RECONCILE="$ROOT/scripts/ci/trust-reconcile.js"
FX="$ROOT/evals/fixtures/trust-reconcile-exploits"
WS3="$ROOT/evals/fixtures/trust-reconcile-ws3/ws3-bundle.json"

errors=0
_pass() { echo "  PASS: $1"; }
_fail() { echo "  FAIL: $1"; errors=$((errors + 1)); }

# run_case <label> <bundle> <needle>
# Asserts: reconciler exits non-zero AND stdout/stderr contains <needle>.
run_case() {
  local label="$1" bundle="$2" needle="$3"
  echo "=== $label ==="
  if [[ ! -f "$bundle" ]]; then _fail "$label: fixture not found at $bundle"; return; fi
  local out code
  out="$(TRUST_RECONCILE_COMMANDS="node -e 'process.exit(0)'" \
    node "$RECONCILE" --bundle "$bundle" --repo-root "$ROOT" 2>&1)"
  code=$?
  if [[ $code -ne 0 ]]; then
    _pass "$label: reconciler exits non-zero ($code)"
  else
    _fail "$label: expected non-zero exit, got 0 — output: $out"
  fi
  if echo "$out" | grep -qF "$needle"; then
    _pass "$label: emitted the expected divergence (\"$needle\")"
  else
    _fail "$label: expected divergence \"$needle\" not found — output: $out"
  fi
}

# 1. Reviewer's no-label exploit → not-run (test_output must reconcile against the manifest).
run_case "no-label-bypass (finding 1)" "$FX/no-label-bypass.json" \
  "no manifest-matched execution.label"

# 2. Verifier's skip->assumed exploit → unwaived-assumed.
run_case "skip-assumed-bypass (finding 2)" "$FX/skip-assumed-bypass.json" \
  "[unwaived-assumed]"

# 3. Status-misassertion exploit → status re-derived CI-side; asserted != derived.
run_case "status-misassertion (finding 3)" "$FX/status-misassertion.json" \
  "[status-misassertion]"

# 4. Waived command-backed check → waiver-on-command-check.
run_case "waived-command-check (finding 4)" "$FX/waived-command-check.json" \
  "[waiver-on-command-check]"

# 5. AC6 backward-compat regression: the real ws3-kit-dependencies-namespacing/trust.bundle
#    (an old-style all-test_output bundle whose commands are not manifest-matched) FAILS the
#    same way under the new reconciler as under the old one — same FAIL verdict, divergences
#    present, no silent pass introduced.
echo "=== ws3 old-style bundle (AC6 backward compat) ==="
if [[ ! -f "$WS3" ]]; then
  _fail "ws3 fixture not found at $WS3"
else
  ws3_out="$(TRUST_RECONCILE_COMMANDS="node -e 'process.exit(0)'" \
    node "$RECONCILE" --bundle "$WS3" --repo-root "$ROOT" 2>&1)"
  ws3_code=$?
  if [[ $ws3_code -ne 0 ]]; then
    _pass "ws3 old-style bundle FAILS (exit $ws3_code) — same verdict as the old reconciler"
  else
    _fail "ws3 old-style bundle expected non-zero exit, got 0 — output: $ws3_out"
  fi
  if echo "$ws3_out" | grep -qF "[not-run]"; then
    _pass "ws3 old-style bundle emits a not-run divergence (its test_output commands are not manifest-matched)"
  else
    _fail "ws3 old-style bundle expected a not-run divergence — output: $ws3_out"
  fi
  if echo "$ws3_out" | grep -qF "trust divergence"; then
    _pass "ws3 old-style bundle emits trust divergence(s)"
  else
    _fail "ws3 old-style bundle expected trust divergence(s) — output: $ws3_out"
  fi
fi

# 6. Fabricated-attestation (iteration-4): passes (exit 0) but MUST carry the loud ATTESTED
#    marker and the summary count line — NOT the old quiet SESSION-LOCAL OK. This is a
#    visibility assertion, not a divergence assertion (unlike run_case above): a fabricated
#    self-consistent attestation bundle is, by construction, indistinguishable from a genuine
#    one at this layer (see ADR 0020 Residuals) — the fix is disclosure, not a block.
echo "=== fabricated-attestation (iteration-4, converged finding) ==="
FAB="$FX/fabricated-attestation.json"
if [[ ! -f "$FAB" ]]; then
  _fail "fabricated-attestation fixture not found at $FAB"
else
  fab_out="$(TRUST_RECONCILE_COMMANDS="node -e 'process.exit(0)'" \
    node "$RECONCILE" --bundle "$FAB" --repo-root "$ROOT" 2>&1)"
  fab_code=$?
  if [[ $fab_code -eq 0 ]]; then
    _pass "fabricated-attestation bundle passes (exit 0) — attestations are not blocked at L0"
  else
    _fail "fabricated-attestation bundle expected exit 0, got $fab_code — output: $fab_out"
  fi
  if echo "$fab_out" | grep -qF "ATTESTED (not independently verifiable at L0): 'c-fabricated-security' (workflow.check.security) evidenceType=attestation"; then
    _pass "fabricated-attestation bundle emits the loud ATTESTED marker (not a quiet SESSION-LOCAL OK)"
  else
    _fail "expected the ATTESTED (not independently verifiable at L0) marker — output: $fab_out"
  fi
  if echo "$fab_out" | grep -qF "1 attested claim(s) accepted without independent verification"; then
    _pass "fabricated-attestation bundle emits the attested-claim summary count line"
  else
    _fail "expected the attested-claim summary count line — output: $fab_out"
  fi
  if echo "$fab_out" | grep -qF "SESSION-LOCAL OK"; then
    _fail "fabricated-attestation bundle must NOT emit the old quiet SESSION-LOCAL OK line"
  else
    _pass "fabricated-attestation bundle does not emit the old quiet SESSION-LOCAL OK line"
  fi
fi

echo ""
if [[ $errors -eq 0 ]]; then
  echo "test_trust_reconcile_negatives: all checks passed."
  exit 0
else
  echo "test_trust_reconcile_negatives: $errors check(s) failed."
  exit 1
fi
