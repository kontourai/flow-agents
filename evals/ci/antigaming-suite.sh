#!/usr/bin/env bash
# Anti-gaming + trust regression suite — the tests that prove the gate, the CI
# anchor, and their protections actually work. These MUST run in a required CI
# lane so that weakening the gate code (stop-goal-fit.js, trust-reconcile.js,
# config-protection.js, evidence-capture.js, flow-resolver.ts, the producer) is
# caught: if any of these fail, the lane goes red and the change cannot merge.
#
# Convergence red-team (Round 5/7) found these ran in NO required check, so an
# agent could edit the gate and the proof-tests never ran. This closes that.
set -uo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

TESTS=(
  "evals/acceptance/prove-capture-teeth.sh"
  "evals/acceptance/prove-capture-teeth-declared.sh"
  "evals/integration/test_gate_lockdown.sh"
  "evals/integration/test_gate_bypass_chain.sh"
  "evals/integration/test_reconcile_soundness.sh"
  "evals/integration/test_captured_fail_reconciliation.sh"
  "evals/integration/test_command_log_integrity.sh"
  "evals/integration/test_command_log_fork_classification.sh"
  "evals/integration/test_command_log_concurrency.sh"
  "evals/integration/test_resolvefirststep_security.sh"
  "evals/integration/test_enforcer_expects_driven.sh"
  "evals/integration/test_goal_fit_rederive.sh"
  "evals/integration/test_flowdef_session_activation.sh"
  "evals/integration/test_builder_entry_enforcement.sh"
  "evals/integration/test_flowdef_union_floor_regression.sh"
  "evals/integration/test_trust_reconcile.sh"
  "evals/integration/test_trust_checkpoint.sh"
  "evals/integration/test_checkpoint_signing.sh"
  "evals/integration/test_mint_attestation.sh"
  "evals/integration/test_publish_delivery.sh"
  "evals/integration/test_phase_map_and_gate_claim.sh"
  "evals/integration/test_trust_reconcile_manifest.sh"
  "evals/integration/test_trust_reconcile_mixed_bundle.sh"
  "evals/integration/test_trust_reconcile_negatives.sh"
  "evals/integration/test_reconcile_preflight.sh"
  "evals/integration/test_goal_fit_ghost_session.sh"
)

fail=0
for t in "${TESTS[@]}"; do
  if [[ ! -f "$t" ]]; then
    echo "MISSING anti-gaming test: $t — refusing to pass (a removed regression test is a red flag)"
    fail=1
    continue
  fi
  echo "=== anti-gaming: $t ==="
  if bash "$t"; then
    echo "  PASS: $t"
  else
    echo "  FAIL: $t"
    fail=1
  fi
done

if [[ "$fail" -ne 0 ]]; then
  echo "ANTI-GAMING SUITE FAILED — the gate / CI anchor / protections regressed or a regression test was removed."
  exit 1
fi
echo "ANTI-GAMING SUITE PASSED (${#TESTS[@]} tests)."
