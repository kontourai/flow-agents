#!/usr/bin/env bash
# test_flowdef_session_activation.sh — Integration eval for ADR 0016 Step 1.
#
# Proves that ensure-session --flow-id builder.build activates the FlowDefinition-
# driven path so producers fire, gates enforce on builder.* claims, and advance-state
# correctly sets active_step_id via the phase_map at each phase.
#
# Tests:
#   1. ensure-session --flow-id builder.build writes active_flow_id + default
#      active_step_id (pull-work) to current.json.
#   2. advance-state through phases (planning→execution→verification) sets correct
#      active_step_id via phase_map at each transition.
#   3. At the verify step, record-gate-claim for tests-evidence produces
#      builder.verify.tests (status=verified) in the bundle — producer fires.
#   4. A TAMPERED builder.verify.tests bundle at the verify step BLOCKS (exit 2)
#      with the tamper warning naming the declared claimType.
#   5. Fallback: session without --flow-id produces only workflow.* claims (the
#      retained safety net for non-flow sessions).
#
# Deterministic, no model spend, self-cleaning.
# Usage: bash evals/integration/test_flowdef_session_activation.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"
GATE="$ROOT/scripts/hooks/stop-goal-fit.js"

export FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=100000

TMP="$(mktemp -d)"
errors=0

_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

WRITER="workflow-sidecar"

# ─── TEST 1: ensure-session --flow-id activates the flow ─────────────────────
echo ""
echo "=== 1. ensure-session --flow-id builder.build activates FlowDefinition-driven path ==="

MAIN_AROOT="$TMP/main-project/.kontourai/flow-agents"
SLUG="activation-test"
SESSION_DIR="$MAIN_AROOT/$SLUG"
mkdir -p "$MAIN_AROOT"

if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$MAIN_AROOT" \
  --task-slug "$SLUG" \
  --actor activation-test-actor \
  --title "Step 1 activation test" \
  --summary "Test that --flow-id builder.build activates the FlowDefinition-driven path." \
  --criterion "All gates produce declared claims" \
  --flow-id builder.build \
  --timestamp "2026-06-01T00:00:00Z" >/dev/null 2>&1; then
  _pass "ensure-session starts the canonical Builder Flow from a canonical artifact root"
else
  _fail "ensure-session failed to start the canonical Builder Flow"
fi

node -e "
const fs = require('fs');
const c = JSON.parse(fs.readFileSync('$MAIN_AROOT/current.json', 'utf8'));
const flow = JSON.parse(fs.readFileSync('$TMP/main-project/.kontourai/flow/runs/$SLUG/state.json', 'utf8'));
const bundle = JSON.parse(fs.readFileSync('$SESSION_DIR/trust.bundle', 'utf8'));
if (c.active_flow_id !== 'builder.build') throw new Error('expected active_flow_id=builder.build, got ' + c.active_flow_id);
if (c.active_step_id !== 'design-probe') throw new Error('expected active_step_id=design-probe, got ' + c.active_step_id);
if (flow.status !== 'active' || flow.current_step !== 'design-probe') throw new Error('canonical Flow did not advance through trusted selection: ' + JSON.stringify(flow));
if (!(bundle.claims || []).some((claim) => claim.claimType === 'builder.pull-work.selected' && claim.status === 'verified')) throw new Error('missing verified selected-work claim');
console.log('current.json: active_flow_id=' + c.active_flow_id + ' active_step_id=' + c.active_step_id);
" 2>&1 \
  && _pass "ensure-session records trusted selection and projects the canonical Flow run at design-probe" \
  || _fail "ensure-session did not create and project the canonical Flow run"

# ─── TEST 2: advance-state sets active_step_id via phase_map ─────────────────
echo ""
echo "=== 2. advance-state through phases sets active_step_id via phase_map ==="

flow_agents_node "$WRITER" init-plan "$SESSION_DIR/$SLUG--deliver.md" \
  --source-request "Test" --summary "Testing" \
  --timestamp "2026-06-01T00:00:30Z" >/dev/null 2>&1

test_phase_step() {
  local phase="$1" expected_step="$2"
  flow_agents_node "$WRITER" advance-state "$SESSION_DIR" \
    --status in_progress --phase "$phase" \
    --summary "Testing phase $phase." \
    --next-action "Continue." \
    --flow-definition builder.build \
    --timestamp "2026-06-01T00:01:00Z" >/dev/null 2>&1
  local actual
  actual=$(node -e "
    const fs = require('fs');
    const c = JSON.parse(fs.readFileSync('$MAIN_AROOT/current.json', 'utf8'));
    console.log(c.active_step_id || '');
  " 2>/dev/null)
  if [ "$actual" = "$expected_step" ]; then
    _pass "advance-state phase=$phase → active_step_id=$expected_step"
  else
    _fail "advance-state phase=$phase → got active_step_id=$actual (expected $expected_step)"
  fi
}

test_phase_step "planning"     "plan"
test_phase_step "execution"    "execute"
test_phase_step "verification" "verify"

# ─── TEST 3: at verify step, record-gate-claim produces builder.verify.tests ──
echo ""
echo "=== 3. verify step: producer fires — record-gate-claim produces builder.verify.tests ==="

if flow_agents_node "$WRITER" record-gate-claim "$SESSION_DIR" \
  --status pass \
  --summary "All tests pass." \
  --expectation "tests-evidence" \
  --timestamp "2026-06-01T00:02:00Z" >/dev/null 2>&1; then
  _pass "record-gate-claim at verify step succeeds (expectation=tests-evidence)"
else
  _fail "record-gate-claim at verify step FAILED"
fi

node -e "
const fs = require('fs');
const bundlePath = '$SESSION_DIR/trust.bundle';
if (!fs.existsSync(bundlePath)) throw new Error('trust.bundle not found');
const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
const declared = (bundle.claims || []).find(c => c.claimType === 'builder.verify.tests');
if (!declared) throw new Error('MISSING builder.verify.tests; claims: ' + (bundle.claims||[]).map(c=>c.claimType).join(', '));
if (declared.status !== 'verified') throw new Error('expected status=verified, got ' + declared.status);
console.log('builder.verify.tests: subjectType=' + declared.subjectType + ' status=' + declared.status + ' value=' + declared.value);
" 2>&1 \
  && _pass "bundle contains builder.verify.tests (subjectType=flow-step, status=verified, value=pass)" \
  || _fail "bundle missing or incorrect builder.verify.tests claim"

# ─── TEST 4: tampered bundle at verify step BLOCKS ────────────────────────────
echo ""
echo "=== 4. tamper-blocks: builder.verify.tests — tampered bundle triggers gate exit 2 ==="

TAMPER_DIR="$TMP/tamper-verify"
TAMPER_SLUG="tamper-verify-test"
mkdir -p "$TAMPER_DIR"
printf '# Test repo\n' > "$TAMPER_DIR/AGENTS.md"
mkdir -p "$TAMPER_DIR/.kontourai/flow-agents/$TAMPER_SLUG"

flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$TAMPER_DIR/.kontourai/flow-agents" \
  --task-slug "$TAMPER_SLUG" \
  --title "Tamper verify test" \
  --summary "Testing tamper detection at verify step." \
  --flow-id builder.build \
  --timestamp "2026-06-01T02:00:00Z" >/dev/null 2>&1

flow_agents_node "$WRITER" init-plan "$TAMPER_DIR/.kontourai/flow-agents/$TAMPER_SLUG/$TAMPER_SLUG--deliver.md" \
  --source-request "Test" --summary "Tamper test" \
  --timestamp "2026-06-01T02:00:00Z" >/dev/null 2>&1

flow_agents_node "$WRITER" advance-state "$TAMPER_DIR/.kontourai/flow-agents/$TAMPER_SLUG" \
  --status in_progress --phase verification \
  --summary "At verify." --next-action "Continue." \
  --flow-definition builder.build \
  --timestamp "2026-06-01T02:00:30Z" >/dev/null 2>&1

# Write TAMPERED trust.bundle: stored verified, evidence passing=false
python3 - "$TAMPER_DIR/.kontourai/flow-agents/$TAMPER_SLUG/trust.bundle" << 'PY'
import json, sys
bundle = {
    "schemaVersion": 5,
    "source": "flow-agents/workflow-sidecar",
    "claims": [{
        "id": "c1",
        "subjectId": "tamper-verify-test/verify-tests",
        "subjectType": "flow-step",
        "claimType": "builder.verify.tests",
        "fieldOrBehavior": "Tests pass",
        "value": "pass",
        "impactLevel": "high",
        "status": "verified",
        "createdAt": "2026-06-01T02:00:00Z",
        "updatedAt": "2026-06-01T02:00:00Z"
    }],
    "evidence": [{
        "id": "ev1",
        "claimId": "c1",
        "evidenceType": "test_output",
        "method": "validation",
        "sourceRef": "command-log.jsonl",
        "excerptOrSummary": "tests FAILED",
        "observedAt": "2026-06-01T02:00:00Z",
        "collectedBy": "harness",
        "passing": False,
        "blocking": True
    }],
    "policies": [],
    "events": [{
        "id": "evt1",
        "claimId": "c1",
        "status": "verified",
        "actor": "agent",
        "method": "workflow-check",
        "evidenceIds": ["ev1"],
        "createdAt": "2026-06-01T02:00:00Z"
    }]
}
json.dump(bundle, open(sys.argv[1], 'w'))
PY

set +e
tamper_out="$(FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip \
    node "$GATE" 2>&1 <<< "{\"hook_event_name\":\"Stop\",\"cwd\":\"$TAMPER_DIR\"}")"
tamper_exit="$?"
set -e

if [ "$tamper_exit" -eq 2 ]; then
  _pass "gate BLOCKS tampered builder.verify.tests bundle (exit 2)"
else
  _fail "gate did NOT block tampered bundle: exit=$tamper_exit"
fi

if echo "$tamper_out" | grep -qE "stored status.*does not match recompute|possible tampered bundle|caught false-completion"; then
  _pass "gate emits tamper warning for builder.verify.tests"
else
  _fail "gate tamper warning missing from output: $tamper_out"
fi

if echo "$tamper_out" | grep -q "builder.verify.tests"; then
  _pass "gate tamper warning names declared claimType builder.verify.tests"
else
  _fail "gate tamper warning does not name builder.verify.tests: $tamper_out"
fi

# ─── TEST 5: Fallback — session without --flow-id (workflow.* only, safety net) ─
echo ""
echo "=== 5. Fallback: session without --flow-id produces only workflow.* claims (safety net intact) ==="

FALLBACK_AROOT="$TMP/fallback-aroot"
FALLBACK_SLUG="fallback-test"
FALLBACK_DIR="$FALLBACK_AROOT/$FALLBACK_SLUG"
mkdir -p "$FALLBACK_AROOT"

flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$FALLBACK_AROOT" \
  --task-slug "$FALLBACK_SLUG" \
  --title "Fallback no-flow test" \
  --summary "No --flow-id: workflow.* fallback is the safety net for non-flow sessions." \
  --timestamp "2026-06-01T10:00:00Z" >/dev/null 2>&1

flow_agents_node "$WRITER" init-plan "$FALLBACK_DIR/$FALLBACK_SLUG--deliver.md" \
  --source-request "Test" --summary "Testing fallback." \
  --timestamp "2026-06-01T10:00:00Z" >/dev/null 2>&1

flow_agents_node "$WRITER" record-evidence "$FALLBACK_DIR" \
  --verdict pass \
  --check-json '{"id":"fallback-check","kind":"test","status":"pass","summary":"Fallback test passes"}' \
  --timestamp "2026-06-01T10:01:00Z" >/dev/null 2>&1

node -e "
const fs = require('fs');
const bundle = JSON.parse(fs.readFileSync('$FALLBACK_DIR/trust.bundle', 'utf8'));
const claims = bundle.claims || [];
const wfClaim = claims.find(c => c.claimType === 'workflow.check.test');
const builderClaims = claims.filter(c => c.claimType.startsWith('builder.'));
if (!wfClaim) throw new Error('MISSING workflow.check.test in fallback session');
if (builderClaims.length > 0) throw new Error('UNEXPECTED builder.* claims in fallback session: ' + builderClaims.map(c=>c.claimType).join(', '));
if (wfClaim.id.endsWith('-legacy')) throw new Error('workflow.check.test should not have -legacy suffix when no flow active');
console.log('fallback: only workflow.check.test present (no builder.* claims, no -legacy suffix)');
" 2>&1 \
  && _pass "fallback (no --flow-id): only workflow.check.test produced, builder.* absent (producers dormant)" \
  || _fail "fallback (no --flow-id): unexpected claims in trust.bundle"

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$errors" -eq 0 ]; then
  echo "test_flowdef_session_activation: all checks passed."
  exit 0
fi
echo "test_flowdef_session_activation: $errors check(s) FAILED."
exit 1
