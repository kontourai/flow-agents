#!/usr/bin/env bash
# test_verify_gate_incremental_head.sh — kontourai/flow-agents#974 AC4.
#
# Proves the current-gate `flow_run_head` check on a head-bound claim was
# narrowed from cross-claim identity (every claim in the gate must share one
# IDENTICAL head equal to flowRunHead(state) at validation time) to per-claim
# presence (every head-bound claim must simply carry a non-null
# flow_run_head). Visit-scoping -- the actual property the old check reached
# for -- remains fully enforced by claimIsCurrent (prior-visit claim ids and
# out-of-window timestamps), independent of the state hash.
#
#   AC1 — a multi-expectation gate (verify-gate: clean-critique,
#         acceptance-criteria, tests-evidence) records incrementally (claim 1,
#         then claim 2) and completes, including after an earlier rejected
#         (routed-back) attempt at the same gate.
#   AC2 — a claim from a PREVIOUS VISIT to the same gate is still rejected:
#         driving a run that leaves (route-back) and re-enters verify-gate,
#         then relying on the stale visit-1 critique claim (never
#         re-recorded) to satisfy visit 2 does NOT complete the gate.
#   AC3 — a claim whose timestamps fall outside the current visit window is
#         still rejected: a tests-evidence claim stamped decades before the
#         visit's enteredAt does not complete the gate, while an identical
#         claim at the real "now" does.
#   Also — not_verified can be recorded for an expectation whose passing
#         claim was just rejected (the OTHER historical symptom: the old
#         defect blocked not_verified recording too, since it is equally
#         head-bound).
#
# Deterministic, no model spend, self-cleaning.
# Usage: bash evals/integration/test_verify_gate_incremental_head.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"
source "$ROOT/evals/lib/verify-gate-fixture.sh"

errors=0
_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

TMP="$(mktemp -d)"
# A cleanup failure must never clobber the eval's real exit code (see
# evals/ci hygiene notes elsewhere in this suite).
cleanup() { rm -rf "$TMP" 2>/dev/null || true; }
trap cleanup EXIT

flow_agents_build_ts || { echo "build failed"; exit 1; }

bundle_flow_run_heads() {
  # Prints one flow_run_head per line for claims matching the given
  # claimType in the session's trust.bundle (heredoc + argv path: never a
  # literal protected-token interpreter invocation).
  local session_dir="$1" claim_type="$2"
  node - "$session_dir/trust.bundle" "$claim_type" <<'NODE'
const fs = require('fs');
const bundle = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const claimType = process.argv[3];
for (const claim of bundle.claims || []) {
  if (claim.claimType !== claimType) continue;
  console.log(claim.metadata?.gate_claim?.flow_run_head ?? '');
}
NODE
}

echo ""
echo "=== AC1: incremental multi-expectation-gate recording completes, including after a rejected attempt ==="

PUBLIC_ROOT="$(vgf_new_public_root "$TMP")"
SESSION_DIR="$(vgf_drive_to_verify producer-ac1 "$PUBLIC_ROOT" "acme/ac1#1")"
if [ -n "$SESSION_DIR" ] && [ "$(vgf_current_step producer-ac1 "$SESSION_DIR")" = "verify" ]; then
  _pass "AC1 setup: session reaches verify-gate (visit 1)"
else
  _fail "AC1 setup: did not reach verify-gate"
fi

# design-probe-gate (2 required, both head-bound "check" expectations) is
# where the removed cross-claim identity check actually broke: recording two
# claims on the same gate back-to-back (nothing else touching Flow state in
# between) leaves them with the SAME head, so the historical defect needed an
# unrelated intervening mutation (vgf_drive_to_verify inserts a pause/resume
# between the two claims) to manifest -- and the gate still had to complete.
PROBE_HEAD_1="$(bundle_flow_run_heads "$SESSION_DIR" "builder.design-probe.pickup-readiness" | tail -1)"
PROBE_HEAD_2="$(bundle_flow_run_heads "$SESSION_DIR" "builder.design-probe.decisions" | tail -1)"
if [ -n "$PROBE_HEAD_1" ] && [ -n "$PROBE_HEAD_2" ] && [ "$PROBE_HEAD_1" != "$PROBE_HEAD_2" ]; then
  _pass "AC1: design-probe-gate's two head-bound claims carry DIFFERENT flow_run_head values ($PROBE_HEAD_1 vs $PROBE_HEAD_2) after an intervening pause/resume, yet the gate already completed (fixture reached verify)"
else
  _fail "AC1: expected design-probe's two claims to carry different flow_run_head values (claim1=$PROBE_HEAD_1, claim2=$PROBE_HEAD_2)"
fi

# Visit 1, claim 1: critique alone must NOT complete a 3-expectation gate.
# (workflow critique never syncs by itself -- record-critique writes trust.bundle
# then only recoverBuilderFlowSession, never syncBuilderFlowSession -- so
# vgf_trigger_sync explicitly asks Flow to evaluate the gate here.)
vgf_record_critique reviewer-ac1 "$SESSION_DIR" >/dev/null 2>&1
vgf_trigger_sync producer-ac1 "$PUBLIC_ROOT" "acme/ac1#1"
STEP="$(vgf_current_step producer-ac1 "$SESSION_DIR")"
[ "$STEP" = "verify" ] && _pass "AC1: claim 1 (critique) alone does not complete the gate (sync attempted)" \
  || _fail "AC1: unexpected step after claim 1: $STEP"

# Visit 1, claim 2: a FAILING tests-evidence claim (with a declared route
# reason) is a complete, but REJECTED (routed-back), attempt at this gate.
vgf_record_tests_evidence producer-ac1 "$SESSION_DIR" fail implementation_defect >/dev/null 2>&1
STEP="$(vgf_current_step producer-ac1 "$SESSION_DIR")"
[ "$STEP" = "execute" ] && _pass "AC1: claim 2 (failing tests-evidence) routes the first attempt back to execute" \
  || _fail "AC1: expected route-back to execute, got: $STEP"

# Re-enter execute -> verify: this is now VISIT 2 of verify-gate.
vgf_reenter_execute_to_verify producer-ac1 "$SESSION_DIR"
STEP="$(vgf_current_step producer-ac1 "$SESSION_DIR")"
[ "$STEP" = "verify" ] && _pass "AC1: re-entering execute returns to verify-gate (visit 2)" \
  || _fail "AC1: did not re-enter verify-gate: $STEP"

# Visit 2, claim 1: a fresh critique. Still insufficient alone.
vgf_record_critique reviewer-ac1 "$SESSION_DIR" pass "Fixture: visit-2 clean review." >/dev/null 2>&1
vgf_trigger_sync producer-ac1 "$PUBLIC_ROOT" "acme/ac1#1"
STEP="$(vgf_current_step producer-ac1 "$SESSION_DIR")"
[ "$STEP" = "verify" ] && _pass "AC1: visit-2 claim 1 (critique) alone does not complete the gate (sync attempted)" \
  || _fail "AC1: unexpected step after visit-2 claim 1: $STEP"

# Visit 2, claim 2: passing tests-evidence (bundles acceptance-criteria +
# tests-evidence together) completes the gate incrementally, after an
# earlier rejected attempt at this SAME gate. (clean-critique's claim
# carries no flow_run_head at all -- reviewer-authored "critique"-origin
# claims are exempt from head-binding entirely, see bundleGateEvidence's
# origin allowlist -- so verify-gate's own head-bound writes number exactly
# one per visit; design-probe-gate above is where two claims on ONE gate are
# both head-bound.)
vgf_record_tests_evidence producer-ac1 "$SESSION_DIR" pass >/dev/null 2>&1
STEP="$(vgf_current_step producer-ac1 "$SESSION_DIR")"
[ "$STEP" = "merge-ready" ] && _pass "AC1: claim 2 (passing tests-evidence) incrementally completes the gate after an earlier rejected attempt" \
  || _fail "AC1: gate did not complete: $STEP"

echo ""
echo "=== AC2: a claim from a PREVIOUS VISIT to the same gate is still rejected ==="

PUBLIC_ROOT2="$(vgf_new_public_root "$TMP")"
SESSION_DIR2="$(vgf_drive_to_verify producer-ac2 "$PUBLIC_ROOT2" "acme/ac2#1")"
vgf_record_critique reviewer-ac2 "$SESSION_DIR2" >/dev/null 2>&1
vgf_record_tests_evidence producer-ac2 "$SESSION_DIR2" fail implementation_defect >/dev/null 2>&1
STEP="$(vgf_current_step producer-ac2 "$SESSION_DIR2")"
[ "$STEP" = "execute" ] && _pass "AC2 setup: first attempt at verify-gate is routed back (visit 1 ends)" \
  || _fail "AC2 setup: expected route-back, got: $STEP"

vgf_reenter_execute_to_verify producer-ac2 "$SESSION_DIR2"
STEP="$(vgf_current_step producer-ac2 "$SESSION_DIR2")"
[ "$STEP" = "verify" ] && _pass "AC2 setup: re-entered verify-gate (visit 2)" \
  || _fail "AC2 setup: did not re-enter verify-gate: $STEP"

# Visit 2: rely on the STALE visit-1 critique claim (never re-recorded at
# visit 2) plus a fresh passing tests-evidence claim. If the runtime
# correctly narrowed (rather than disabled) the head check, the prior-visit
# critique claim must still be rejected by claimIsCurrent's visit-scoping,
# so the gate must NOT complete.
REUSE_OUTPUT="$(vgf_record_tests_evidence producer-ac2 "$SESSION_DIR2" pass 2>&1)"
STEP="$(vgf_current_step producer-ac2 "$SESSION_DIR2")"
if [ "$STEP" = "verify" ]; then
  _pass "AC2: reusing the stale visit-1 critique claim at visit 2 does NOT complete the gate (current_step stays verify)"
else
  _fail "AC2: prior-visit claim incorrectly satisfied the gate: current_step=$STEP"
fi
if printf '%s' "$REUSE_OUTPUT" | grep -q 'awaiting the remaining gate expectations'; then
  _pass "AC2: evidence report confirms the run is awaiting the remaining gate expectations after the prior-visit-claim reuse attempt"
else
  _fail "AC2: evidence report did not confirm the rejection: $REUSE_OUTPUT"
fi
REUSE_STATUS_JSON="$(vgf_flow producer-ac2 status --session-dir "$SESSION_DIR2" --json 2>/dev/null)"
if printf '%s' "$REUSE_STATUS_JSON" | grep -q '"attached":false\|clean-critique'; then
  _pass "AC2: status report still lists clean-critique as an outstanding requirement (the stale claim was not counted)"
else
  _fail "AC2: status report no longer lists clean-critique as outstanding: $REUSE_STATUS_JSON"
fi

# Contrast: recording a FRESH critique at visit 2 (instead of relying on the
# stale one) DOES complete the gate (tests-evidence was already recorded
# passing above) -- proving the rejection above is specifically about
# visit-scoping, not some unrelated malfunction.
vgf_record_critique reviewer-ac2 "$SESSION_DIR2" pass "Fixture: visit-2 fresh critique after the AC2 reuse probe." >/dev/null 2>&1
vgf_trigger_sync producer-ac2 "$PUBLIC_ROOT2" "acme/ac2#1"
STEP="$(vgf_current_step producer-ac2 "$SESSION_DIR2")"
[ "$STEP" = "merge-ready" ] && _pass "AC2 contrast: recording a FRESH visit-2 critique (instead of reusing the stale one) completes the gate" \
  || _fail "AC2 contrast: fresh critique did not complete the gate: $STEP"

echo ""
echo "=== AC3: a claim whose timestamps fall outside the current visit window is still rejected ==="

BUILD="$ROOT/build"

# --- AC3a: an out-of-window (decades-stale) tests-evidence claim does not complete the gate ---
PUBLIC_ROOT3A="$(vgf_new_public_root "$TMP")"
SESSION_DIR3A="$(vgf_drive_to_verify producer-ac3a "$PUBLIC_ROOT3A" "acme/ac3a#1")"
vgf_record_critique reviewer-ac3a "$SESSION_DIR3A" >/dev/null 2>&1
TEST_COMMAND_3A="$(vgf_test_command "$SESSION_DIR3A")"
CRIT1_3A="$(vgf_criterion_json AC-1 pass "$TEST_COMMAND_3A")"
CRIT2_3A="$(vgf_criterion_json AC-2 pass "$TEST_COMMAND_3A")"
node "$BUILD/src/cli/workflow-sidecar.js" record-gate-claim "$SESSION_DIR3A" \
  --expectation tests-evidence --status pass --summary "AC3a: out-of-window tests-evidence claim" \
  --timestamp "2000-01-01T00:00:00.000Z" \
  --command "$TEST_COMMAND_3A" \
  --evidence-ref-json "{\"kind\":\"command\",\"excerpt\":\"$TEST_COMMAND_3A\",\"summary\":\"Fixture command evidence.\"}" \
  --criterion-json "$CRIT1_3A" --criterion-json "$CRIT2_3A" >/dev/null 2>&1
RECORD_EXIT=$?
[ "$RECORD_EXIT" -eq 0 ] && _pass "AC3a: private record-gate-claim accepts a decades-stale --timestamp claim into the bundle (unsynced)" \
  || _fail "AC3a: record-gate-claim unexpectedly rejected the stale claim at write time (exit $RECORD_EXIT)"
# Trigger sync WITHOUT writing a new claim (workflow start is idempotent and
# always re-syncs the existing trust.bundle; see startBuilderFlowSession).
vgf_flow producer-ac3a start --artifact-root "$PUBLIC_ROOT3A" --flow builder.build \
  --work-item "acme/ac3a#1" --assignment-provider local-file --summary "AC3a: trigger sync" >/dev/null 2>&1
STEP="$(vgf_current_step producer-ac3a "$SESSION_DIR3A")"
[ "$STEP" = "verify" ] && _pass "AC3a: the out-of-window tests-evidence claim does NOT complete the gate (current_step stays verify)" \
  || _fail "AC3a: out-of-window claim incorrectly completed the gate: current_step=$STEP"

# --- AC3b (contrast): an identical claim at the real "now" DOES complete the gate ---
PUBLIC_ROOT3B="$(vgf_new_public_root "$TMP")"
SESSION_DIR3B="$(vgf_drive_to_verify producer-ac3b "$PUBLIC_ROOT3B" "acme/ac3b#1")"
vgf_record_critique reviewer-ac3b "$SESSION_DIR3B" >/dev/null 2>&1
TEST_COMMAND_3B="$(vgf_test_command "$SESSION_DIR3B")"
CRIT1_3B="$(vgf_criterion_json AC-1 pass "$TEST_COMMAND_3B")"
CRIT2_3B="$(vgf_criterion_json AC-2 pass "$TEST_COMMAND_3B")"
node "$BUILD/src/cli/workflow-sidecar.js" record-gate-claim "$SESSION_DIR3B" \
  --expectation tests-evidence --status pass --summary "AC3b: in-window (real now) tests-evidence claim" \
  --command "$TEST_COMMAND_3B" \
  --evidence-ref-json "{\"kind\":\"command\",\"excerpt\":\"$TEST_COMMAND_3B\",\"summary\":\"Fixture command evidence.\"}" \
  --criterion-json "$CRIT1_3B" --criterion-json "$CRIT2_3B" >/dev/null 2>&1
vgf_flow producer-ac3b start --artifact-root "$PUBLIC_ROOT3B" --flow builder.build \
  --work-item "acme/ac3b#1" --assignment-provider local-file --summary "AC3b: trigger sync" >/dev/null 2>&1
STEP="$(vgf_current_step producer-ac3b "$SESSION_DIR3B")"
[ "$STEP" = "merge-ready" ] && _pass "AC3b contrast: an identical claim recorded at the real 'now' DOES complete the gate" \
  || _fail "AC3b contrast: in-window claim did not complete the gate: current_step=$STEP"

echo ""
echo "=== not_verified can be recorded for an expectation whose passing claim was just rejected ==="

PUBLIC_ROOT4="$(vgf_new_public_root "$TMP")"
SESSION_DIR4="$(vgf_drive_to_verify producer-nv "$PUBLIC_ROOT4" "acme/nv1#1")"
vgf_record_critique reviewer-nv "$SESSION_DIR4" >/dev/null 2>&1
vgf_record_tests_evidence producer-nv "$SESSION_DIR4" fail implementation_defect >/dev/null 2>&1
vgf_reenter_execute_to_verify producer-nv "$SESSION_DIR4"
# Rejected passing reuse of the stale visit-1 critique (same as AC2), leaving
# tests-evidence's PASSING claim recorded but the gate incomplete.
vgf_record_tests_evidence producer-nv "$SESSION_DIR4" pass >/dev/null 2>&1
STEP="$(vgf_current_step producer-nv "$SESSION_DIR4")"
[ "$STEP" = "verify" ] || _fail "not_verified setup: expected the passing claim to be rejected (still verify), got: $STEP"

NOT_VERIFIED_OUTPUT="$(vgf_flow producer-nv evidence --session-dir "$SESSION_DIR4" --expectation tests-evidence --status not_verified \
  --summary "Fixture: not_verified recorded after a rejected passing claim for the same expectation." 2>&1)"
NOT_VERIFIED_EXIT=$?
[ "$NOT_VERIFIED_EXIT" -eq 0 ] && _pass "not_verified recording succeeds for an expectation whose passing claim was just rejected" \
  || _fail "not_verified recording unexpectedly failed (exit $NOT_VERIFIED_EXIT): $NOT_VERIFIED_OUTPUT"

echo ""
if [ "$errors" -eq 0 ]; then
  echo "Results: verify-gate incremental head narrowing (AC4) checks passed."
  exit 0
fi
echo "Results: verify-gate incremental head narrowing FAILED: $errors issue(s)."
exit 1
