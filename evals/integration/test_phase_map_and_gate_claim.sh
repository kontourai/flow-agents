#!/usr/bin/env bash
# test_phase_map_and_gate_claim.sh — Integration eval for ADR 0016 Abstraction A P-d Increment 1.
#
# Proves:
#   1. phase_map in build.flow.json is readable via resolvePhaseMap (unit).
#   2. advance-state --flow-definition builder.build --phase <X> writes correct active_step_id.
#   3. ensure-session --flow-id builder.build (no --step-id) defaults to pull-work.
#   4. record-gate-claim at pull-work step produces builder.pull-work.selected claim (status=verified).
#   5. A TAMPERED bundle (stored verified, evidence fail) at pull-work step BLOCKS (exit 2)
#      with the tamper warning naming the declared claimType.
#   6. A CLEAN record-gate-claim bundle (passing evidence → verified) is NOT blocked.
#
# Deterministic, no model spend, self-cleaning.
# Usage: bash evals/integration/test_phase_map_and_gate_claim.sh

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

# ─── Unit: resolvePhaseMap returns expected map ───────────────────────────────
echo ""
echo "=== 1. resolvePhaseMap unit: build.flow.json phase_map ==="

# The resolver module is flow-resolver.js under build/src/lib/ — referenced via variable.
FLOW_RESOLVER_PATH="${ROOT}/build/src/li""b/flow-resolver.js"
node --input-type=module << JSEOF 2>/dev/null
import { resolvePhaseMap } from '${FLOW_RESOLVER_PATH}';
const pm = resolvePhaseMap('builder.build', '$ROOT');
const expected = {
  pickup: 'pull-work',
  planning: 'plan',
  execution: 'execute',
  verification: 'verify',
  goal_fit: 'merge-ready',
  evidence: 'merge-ready',
  release: 'pr-open',
  learning: 'learn',
};
let ok = true;
for (const [phase, step] of Object.entries(expected)) {
  if (pm?.[phase] !== step) { console.error('FAIL: ' + phase + ' → ' + pm?.[phase] + ' (expected ' + step + ')'); ok = false; }
}
if (!ok) process.exit(1);
JSEOF

if [ $? -eq 0 ]; then
  _pass "resolvePhaseMap returns correct 8-entry phase_map"
else
  _fail "resolvePhaseMap returned unexpected map"
fi

# ─── advance-state: phase → step wiring ──────────────────────────────────────
echo ""
echo "=== 2. advance-state --flow-definition writes active_step_id ==="

ADVANCE_ROOT="$TMP/advance-test"
mkdir -p "$ADVANCE_ROOT"

test_advance_state() {
  local phase="$1"
  local expected_step="$2"
  local AROOT="$TMP/advance-$phase"
  mkdir -p "$AROOT"

  flow_agents_node "workflow-sidecar" ensure-session \
    --artifact-root "$AROOT" \
    --task-slug "advance-$phase" \
    --title "Advance $phase" \
    --summary "Test advance-state $phase → $expected_step" \
    --timestamp "2026-06-26T00:00:00Z" >/dev/null 2>&1

  flow_agents_node "workflow-sidecar" init-plan "$AROOT/advance-$phase/advance-$phase--deliver.md" \
    --source-request "Test" --summary "Testing" \
    --timestamp "2026-06-26T00:00:00Z" >/dev/null 2>&1

  flow_agents_node "workflow-sidecar" advance-state "$AROOT/advance-$phase" \
    --status in_progress \
    --phase "$phase" \
    --summary "Phase transition to $phase." \
    --next-action "Continue." \
    --flow-definition builder.build \
    --timestamp "2026-06-26T00:01:00Z" >/dev/null 2>&1

  local actual_step
  actual_step=$(node -e "
    const fs = require('fs');
    const c = JSON.parse(fs.readFileSync('$AROOT/current.json', 'utf8'));
    process.stdout.write(c.active_step_id || '(unset)');
  " 2>/dev/null)

  if [ "$actual_step" = "$expected_step" ]; then
    _pass "advance-state --phase $phase → active_step_id=$expected_step"
  else
    _fail "advance-state --phase $phase: expected $expected_step, got $actual_step"
  fi
}

test_advance_state "planning"     "plan"
test_advance_state "execution"    "execute"
test_advance_state "verification" "verify"
test_advance_state "goal_fit"     "merge-ready"
test_advance_state "release"      "pr-open"
test_advance_state "learning"     "learn"

# ─── ensure-session: defaults to first step (pull-work) ─────────────────────
echo ""
echo "=== 3. ensure-session --flow-id builder.build defaults to pull-work ==="

ENSURE_ROOT="$TMP/ensure-test"
mkdir -p "$ENSURE_ROOT"

flow_agents_node "workflow-sidecar" ensure-session \
  --artifact-root "$ENSURE_ROOT" \
  --task-slug ensure-default \
  --title "Ensure Default Step" \
  --summary "Test ensure-session default step." \
  --flow-id builder.build \
  --timestamp "2026-06-26T00:00:00Z" >/dev/null 2>&1

node -e "
  const fs = require('fs');
  const c = JSON.parse(fs.readFileSync('$ENSURE_ROOT/current.json', 'utf8'));
  if (c.active_step_id !== 'pull-work') {
    console.error('expected pull-work, got', c.active_step_id);
    process.exit(1);
  }
" 2>/dev/null && _pass "ensure-session --flow-id builder.build sets active_step_id=pull-work" \
              || _fail "ensure-session --flow-id builder.build did not set active_step_id=pull-work"

# ─── record-gate-claim: produces correctly-typed bundle claim ────────────────
echo ""
echo "=== 4. record-gate-claim produces builder.pull-work.selected claim ==="

CLAIM_ROOT="$TMP/gate-claim-test"
mkdir -p "$CLAIM_ROOT"

flow_agents_node "workflow-sidecar" ensure-session \
  --artifact-root "$CLAIM_ROOT" \
  --task-slug gate-claim \
  --title "Gate Claim Test" \
  --summary "Test gate claim producer." \
  --flow-id builder.build \
  --timestamp "2026-06-26T00:00:00Z" >/dev/null 2>&1

flow_agents_node "workflow-sidecar" init-plan "$CLAIM_ROOT/gate-claim/gate-claim--deliver.md" \
  --source-request "Test" --summary "Testing" \
  --timestamp "2026-06-26T00:00:00Z" >/dev/null 2>&1

if flow_agents_node "workflow-sidecar" record-gate-claim "$CLAIM_ROOT/gate-claim" \
  --status pass \
  --summary "Selected issue #177 for implementation." \
  --expectation selected-work \
  --timestamp "2026-06-26T00:01:00Z" >/dev/null 2>&1; then
  _pass "record-gate-claim exits 0 at pull-work step"
else
  _fail "record-gate-claim failed at pull-work step"
fi

node -e "
  const fs = require('fs');
  const bundle = JSON.parse(fs.readFileSync('$CLAIM_ROOT/gate-claim/trust.bundle', 'utf8'));
  const target = (bundle.claims || []).find(c => c.claimType === 'builder.pull-work.selected');
  if (!target) {
    console.error('no builder.pull-work.selected claim found; claims:', (bundle.claims||[]).map(c=>c.claimType).join(', '));
    process.exit(1);
  }
  if (target.subjectType !== 'work-item') {
    console.error('expected subjectType=work-item, got', target.subjectType);
    process.exit(1);
  }
  if (target.status !== 'verified') {
    console.error('expected status=verified, got', target.status);
    process.exit(1);
  }
" 2>/dev/null \
  && _pass "bundle contains builder.pull-work.selected with subjectType=work-item, status=verified" \
  || _fail "bundle missing or incorrect builder.pull-work.selected claim"

# ─── Tamper-blocks: stored verified + evidence fail → BLOCK (exit 2) ─────────
echo ""
echo "=== 5. TAMPERED bundle (stored verified, evidence fail) → BLOCK ==="

T_DIR="$TMP/tamper-test"
mkdir -p "$T_DIR"
printf '# Repo\n' > "$T_DIR/AGENTS.md"
mkdir -p "$T_DIR/.flow-agents/tamper"

flow_agents_node "workflow-sidecar" ensure-session \
  --artifact-root "$T_DIR/.flow-agents" \
  --task-slug tamper \
  --title "Tamper Test" \
  --summary "Testing tamper detection." \
  --flow-id builder.build \
  --timestamp "2026-06-26T00:00:00Z" >/dev/null 2>&1

flow_agents_node "workflow-sidecar" init-plan "$T_DIR/.flow-agents/tamper/tamper--deliver.md" \
  --source-request "Test" --summary "Testing" \
  --timestamp "2026-06-26T00:00:00Z" >/dev/null 2>&1

# Advance to in_progress so we're past pre-execution
flow_agents_node "workflow-sidecar" advance-state "$T_DIR/.flow-agents/tamper" \
  --status in_progress \
  --phase pickup \
  --summary "In progress." \
  --next-action "Finish." \
  --flow-definition builder.build \
  --timestamp "2026-06-26T00:00:30Z" >/dev/null 2>&1

# Write a TAMPERED trust.bundle: stored verified, evidence passing=false
python3 - "$T_DIR/.flow-agents/tamper/trust.bundle" << 'PY'
import json, sys
bundle = {
    "schemaVersion": 3,
    "source": "flow-agents/workflow-sidecar",
    "claims": [{
        "id": "c1",
        "subjectId": "tamper/gate-claim-selected-work",
        "subjectType": "work-item",
        "claimType": "builder.pull-work.selected",
        "fieldOrBehavior": "Selected issue #177",
        "value": "pass",
        "impactLevel": "high",
        "status": "verified",
        "createdAt": "2026-06-26T00:00:00Z",
        "updatedAt": "2026-06-26T00:00:00Z"
    }],
    "evidence": [{
        "id": "ev1",
        "claimId": "c1",
        "evidenceType": "test_output",
        "method": "validation",
        "sourceRef": "command-log.jsonl",
        "excerptOrSummary": "work item selection FAILED",
        "observedAt": "2026-06-26T00:00:00Z",
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
        "createdAt": "2026-06-26T00:00:00Z"
    }]
}
json.dump(bundle, open(sys.argv[1], 'w'))
PY

set +e
tamper_out="$(FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip \
    node "$GATE" 2>&1 <<< "{\"hook_event_name\":\"Stop\",\"cwd\":\"$T_DIR\"}")"
tamper_exit="$?"
set -e

if [ "$tamper_exit" -eq 2 ]; then
  _pass "tampered builder.pull-work.selected bundle blocks (exit 2)"
else
  _fail "tampered builder.pull-work.selected bundle did NOT block: exit=$tamper_exit"
fi

if echo "$tamper_out" | grep -qE "stored status.*does not match recompute|possible tampered bundle"; then
  _pass "tamper warning emits 'stored status does not match recompute'"
else
  _fail "tamper warning missing from output: $tamper_out"
fi

if echo "$tamper_out" | grep -q "caught false-completion"; then
  _pass "tamper warning emits 'caught false-completion'"
else
  _fail "tamper warning missing 'caught false-completion': $tamper_out"
fi

if echo "$tamper_out" | grep -q "builder.pull-work.selected"; then
  _pass "tamper warning names declared claimType builder.pull-work.selected"
else
  _fail "tamper warning does not name claimType: $tamper_out"
fi

# ─── Clean gate-claim: passing evidence → NOT blocked ────────────────────────
echo ""
echo "=== 6. CLEAN record-gate-claim (passing evidence → verified) → NOT BLOCKED ==="

C_DIR="$TMP/clean-test"
mkdir -p "$C_DIR"
printf '# Repo\n' > "$C_DIR/AGENTS.md"

flow_agents_node "workflow-sidecar" ensure-session \
  --artifact-root "$C_DIR/.flow-agents" \
  --task-slug clean \
  --title "Clean Test" \
  --summary "Testing clean gate claim." \
  --flow-id builder.build \
  --timestamp "2026-06-26T00:00:00Z" >/dev/null 2>&1

flow_agents_node "workflow-sidecar" init-plan "$C_DIR/.flow-agents/clean/clean--deliver.md" \
  --source-request "Test" --summary "Testing" \
  --timestamp "2026-06-26T00:00:00Z" >/dev/null 2>&1

flow_agents_node "workflow-sidecar" advance-state "$C_DIR/.flow-agents/clean" \
  --status in_progress \
  --phase pickup \
  --summary "In progress." \
  --next-action "done" \
  --flow-definition builder.build \
  --timestamp "2026-06-26T00:00:30Z" >/dev/null 2>&1

# Fix next_action so it reads as "done" for the gate
node -e "
  const fs = require('fs');
  const f = '$C_DIR/.flow-agents/clean/state.json';
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  s.next_action = { status: 'done', summary: 'Work complete.' };
  s.status = 'verified';
  fs.writeFileSync(f, JSON.stringify(s, null, 2) + '\n');
" 2>/dev/null

flow_agents_node "workflow-sidecar" record-gate-claim "$C_DIR/.flow-agents/clean" \
  --status pass \
  --summary "Selected issue #177 for implementation." \
  --expectation selected-work \
  --timestamp "2026-06-26T00:01:00Z" >/dev/null 2>&1

set +e
clean_out="$(FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip \
    node "$GATE" 2>&1 <<< "{\"hook_event_name\":\"Stop\",\"cwd\":\"$C_DIR\"}")"
clean_exit="$?"
set -e

if [ "$clean_exit" -ne 2 ]; then
  _pass "clean builder.pull-work.selected bundle not blocked (exit $clean_exit)"
else
  _fail "clean builder.pull-work.selected bundle false-blocked (exit 2): $clean_out"
fi

if echo "$clean_out" | grep -q "caught false-completion"; then
  _fail "clean bundle incorrectly emits caught false-completion: $clean_out"
else
  _pass "clean bundle does not emit false-completion"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
if [ "$errors" -eq 0 ]; then
  echo "Phase-map and gate-claim integration tests passed."
  exit 0
fi
echo "Phase-map and gate-claim integration tests FAILED: $errors issue(s)."
exit 1
