#!/usr/bin/env bash
# test_trust_reconcile_mixed_bundle.sh — WS8 (ADR 0020) END-TO-END PROOF.
#
# The literal capability PR #264 could not demonstrate: a single trust.bundle carrying
# honest, granular, MIXED evidence passes the REAL Trust Reconcile entrypoint:
#   - one CI-reconcilable claim  (evidenceType test_output; execution.label is a real
#     reconcile-manifest command — run-baseline.sh's "Content boundary" check),
#   - one honest session-local claim (human_attestation, Surface-verified, never claimed
#     to be CI-re-runnable, no waiver needed),
#   - one explicitly-waived accepted_gap claim (metadata.waiver, printed loudly).
#
# Runs the REAL scripts/ci/trust-reconcile.js (not a mock), resolving the manifest from
# THIS repo's live run-baseline.sh registry (--repo-root at the repo root). The manifest
# command is re-run FRESH by the reconciler; the session-local claim is accepted on its
# Surface status; the waiver is printed on a distinct WAIVED line. Exit 0.
#
# The fresh-verify (Step 1) command is a trivial pass so the proof is fast and focused on
# the reconcile/classification/waiver behavior (same pattern as the other reconcile evals);
# the manifest-matched command is genuinely re-run against the real checkout.
#
# Deterministic, no model spend, self-cleaning.
# Usage: bash evals/integration/test_trust_reconcile_mixed_bundle.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RECONCILE="$ROOT/scripts/ci/trust-reconcile.js"
FIXTURE="$ROOT/evals/fixtures/trust-reconcile-mixed-bundle/mixed-bundle.json"

errors=0
_pass() { echo "  PASS: $1"; }
_fail() { echo "  FAIL: $1"; errors=$((errors + 1)); }

echo "=== WS8 end-to-end proof: mixed-evidence bundle passes the real Trust Reconcile ==="

if [[ ! -f "$FIXTURE" ]]; then _fail "fixture not found at $FIXTURE"; fi

# Real reconciler entrypoint. Fresh-verify is a trivial pass; the manifest is resolved
# from this repo's live run-baseline.sh registry (via --repo-root "$ROOT").
out="$(TRUST_RECONCILE_COMMANDS="node -e 'process.exit(0)'" \
  node "$RECONCILE" --bundle "$FIXTURE" --repo-root "$ROOT" 2>&1)"
exit_code=$?

echo "----- reconciler output -----"
echo "$out"
echo "-----------------------------"

if [[ $exit_code -eq 0 ]]; then
  _pass "mixed-evidence bundle passes the real Trust Reconcile (exit 0) — the capability PR #264 lacked"
else
  _fail "expected exit 0, got $exit_code"
fi

if echo "$out" | grep -q "RECONCILED: 'npm run check:content-boundary --'"; then
  _pass "the test_output claim reconciled against its manifest command (fresh CI re-run)"
else
  _fail "expected a RECONCILED line for the manifest-matched command"
fi

if echo "$out" | grep -q "ATTESTED (not independently verifiable at L0): 'c-session-local' (workflow.check.external) evidenceType=human_attestation"; then
  _pass "the human_attestation claim was accepted as session-local, loudly marked ATTESTED (not flagged not-run)"
else
  _fail "expected an ATTESTED (not independently verifiable at L0) line for the human_attestation claim"
fi

# WS8 iteration-4 (converged finding): the honest mixed bundle's ATTESTED claim must also be
# counted in the loud summary line, not just printed inline — proves the count is real, not
# just cosmetic per-claim decoration.
if echo "$out" | grep -q "1 attested claim(s) accepted without independent verification"; then
  _pass "the attested-claim summary count line is present and correct (1)"
else
  _fail "expected the '1 attested claim(s) accepted without independent verification' summary line"
fi

if echo "$out" | grep -q "WAIVED:"; then
  _pass "the accepted_gap claim was printed on a distinct, loud WAIVED line"
else
  _fail "expected a WAIVED line for the waived accepted_gap claim"
fi

# Guard: the manifest must have resolved from the live run-baseline.sh registry, not the
# legacy single-command fallback (proves the resolver is wired to the real registry).
if echo "$out" | grep -qE "manifest: [0-9]+ entries \(source: (package.json:trust-reconcile-manifest|evals/ci/run-baseline.sh)"; then
  _pass "manifest resolved from the live run-baseline.sh registry (not a synthetic one)"
else
  _fail "manifest did not resolve from the live registry: $(echo "$out" | grep -i manifest | head -1)"
fi

echo ""
if [[ $errors -eq 0 ]]; then
  echo "test_trust_reconcile_mixed_bundle: all checks passed."
  exit 0
else
  echo "test_trust_reconcile_mixed_bundle: $errors check(s) failed."
  exit 1
fi
