#!/usr/bin/env bash
# test_builder_step_producers.sh — Integration eval for ADR 0016 Abstraction A P-d Increment 2.
#
# Proves for each of the 6 producer-wired gate claims:
#   - record-gate-claim at the correct active step produces the declared claim
#     (correct claimType + subjectType, status=verified in the bundle).
#   - A TAMPERED bundle (stored verified, evidence fail) at that step BLOCKS (exit 2)
#     with the tamper warning naming the declared claimType.
#
# Claims covered:
#   1. builder.pull-work.selected           (step: pull-work,    expectation: selected-work)
#   2. builder.design-probe.pickup-readiness (step: design-probe, expectation: pickup-probe-readiness)
#   3. builder.design-probe.decisions        (step: design-probe, expectation: probe-decisions-or-accepted-gaps)
#   4. builder.pr-open.pull-request          (step: pr-open,      expectation: pull-request-opened)
#   5. builder.learn.decisions               (step: learn,        expectation: decision-evidence)
#   6. builder.learn.evidence                (step: learn,        expectation: learning-evidence)
#
# Flow Definition confirmation:
#   - All 6 claims above are required:true across builder.build and builder.publish-learn.
#   - policy-compliance remains required:false (advisory — no skill producer).
#
# Deterministic, no model spend, self-cleaning.
# Usage: bash evals/integration/test_builder_step_producers.sh

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

# ─── Helper: set active_step_id for a step.
# For steps in the phase_map, use advance-state.
# For design-probe (no phase mapping), use ensure-session --step-id.
# ──────────────────────────────────────────────────────────────────
set_active_step() {
  local aroot="$1" slug="$2" step="$3"
  case "$step" in
    design-probe)
      # design-probe has no lifecycle phase in the phase_map — set via ensure-session --step-id
      flow_agents_node "workflow-sidecar" ensure-session \
        --artifact-root "$aroot" \
        --task-slug "$slug" \
        --title "Producer test: $step" \
        --summary "Test gate-claim producer at $step." \
        --flow-id builder.build \
        --step-id design-probe \
        --timestamp "2026-06-26T00:00:30Z" >/dev/null 2>&1
      ;;
    pull-work)
      flow_agents_node "workflow-sidecar" advance-state "$aroot/$slug" \
        --status in_progress --phase pickup \
        --summary "Testing at $step." --next-action "Record claim." \
        --flow-definition builder.build \
        --timestamp "2026-06-26T00:01:00Z" >/dev/null 2>&1
      ;;
    pr-open)
      flow_agents_node "workflow-sidecar" advance-state "$aroot/$slug" \
        --status in_progress --phase release \
        --summary "Testing at $step." --next-action "Record claim." \
        --flow-definition builder.build \
        --timestamp "2026-06-26T00:01:00Z" >/dev/null 2>&1
      ;;
    learn)
      flow_agents_node "workflow-sidecar" advance-state "$aroot/$slug" \
        --status in_progress --phase learning \
        --summary "Testing at $step." --next-action "Record claim." \
        --flow-definition builder.build \
        --timestamp "2026-06-26T00:01:00Z" >/dev/null 2>&1
      ;;
  esac
}

# ─── Helper: bootstrap a session for produce tests ───────────────────────────
setup_session_for_produce() {
  local aroot="$1" slug="$2" step="$3"
  mkdir -p "$aroot"

  flow_agents_node "workflow-sidecar" ensure-session \
    --artifact-root "$aroot" \
    --task-slug "$slug" \
    --title "Producer test: $step" \
    --summary "Test gate-claim producer at $step." \
    --flow-id builder.build \
    --timestamp "2026-06-26T00:00:00Z" >/dev/null 2>&1

  flow_agents_node "workflow-sidecar" init-plan "$aroot/$slug/$slug--deliver.md" \
    --source-request "Test" --summary "Testing" \
    --timestamp "2026-06-26T00:00:00Z" >/dev/null 2>&1

  set_active_step "$aroot" "$slug" "$step"
}

# ─── Helper: bootstrap a session + AGENTS.md for tamper tests ────────────────
setup_tamper_session() {
  local t_dir="$1" slug="$2" step="$3"
  mkdir -p "$t_dir"
  printf '# Repo\n' > "$t_dir/AGENTS.md"
  mkdir -p "$t_dir/.kontourai/flow-agents/$slug"

  flow_agents_node "workflow-sidecar" ensure-session \
    --artifact-root "$t_dir/.kontourai/flow-agents" \
    --task-slug "$slug" \
    --title "Tamper test: $step" \
    --summary "Testing tamper detection." \
    --flow-id builder.build \
    --timestamp "2026-06-26T00:00:00Z" >/dev/null 2>&1

  flow_agents_node "workflow-sidecar" init-plan "$t_dir/.kontourai/flow-agents/$slug/$slug--deliver.md" \
    --source-request "Test" --summary "Testing" \
    --timestamp "2026-06-26T00:00:00Z" >/dev/null 2>&1

  set_active_step "$t_dir/.kontourai/flow-agents" "$slug" "$step"
}

# ─── Test: produce a gate claim at a given step ───────────────────────────────
test_produce_claim() {
  local label="$1" step="$2" expectation="$3" expected_claim_type="$4" expected_subject_type="$5"
  echo ""
  echo "=== PRODUCE: $label ==="

  local slug
  slug="$(echo "prod-$step-$expectation" | tr '/' '-' | tr '.' '-')"
  local aroot="$TMP/$slug"
  setup_session_for_produce "$aroot" "$slug" "$step"

  if flow_agents_node "workflow-sidecar" record-gate-claim "$aroot/$slug" \
    --status pass \
    --summary "Test claim: $label" \
    --expectation "$expectation" \
    --timestamp "2026-06-26T00:02:00Z" >/dev/null 2>&1; then
    _pass "$label: record-gate-claim exits 0 at $step step"
  else
    _fail "$label: record-gate-claim failed at $step step"
    return
  fi

  node -e "
    const fs = require('fs');
    const bundle = JSON.parse(fs.readFileSync('$aroot/$slug/trust.bundle', 'utf8'));
    const target = (bundle.claims || []).find(c => c.claimType === '$expected_claim_type');
    if (!target) {
      console.error('no $expected_claim_type claim found; claims:', (bundle.claims||[]).map(c=>c.claimType).join(', '));
      process.exit(1);
    }
    if (target.subjectType !== '$expected_subject_type') {
      console.error('expected subjectType=$expected_subject_type, got', target.subjectType);
      process.exit(1);
    }
    if (target.status !== 'verified') {
      console.error('expected status=verified, got', target.status);
      process.exit(1);
    }
  " 2>/dev/null \
    && _pass "$label: bundle contains $expected_claim_type with subjectType=$expected_subject_type, status=verified" \
    || _fail "$label: bundle missing or incorrect $expected_claim_type claim"
}

# ─── Test: tampered bundle at given step BLOCKS ───────────────────────────────
test_tamper_blocks() {
  local label="$1" step="$2" claim_type="$3" subject_type="$4"
  echo ""
  echo "=== TAMPER-BLOCKS: $label ==="

  local slug
  slug="$(echo "tamper-$step-$claim_type" | tr '.' '-' | tr '/' '-')"
  local t_dir="$TMP/$slug"
  setup_tamper_session "$t_dir" "$slug" "$step"

  # Write a TAMPERED trust.bundle: stored verified, evidence passing=false
  python3 - "$t_dir/.kontourai/flow-agents/$slug/trust.bundle" "$claim_type" "$subject_type" << 'PY'
import json, sys
claim_type = sys.argv[2]
subject_type = sys.argv[3]
bundle = {
    "schemaVersion": 5,
    "source": "flow-agents/workflow-sidecar",
    "claims": [{
        "id": "c1",
        "subjectId": "tamper/gate-claim-test",
        "subjectType": subject_type,
        "claimType": claim_type,
        "fieldOrBehavior": "Gate claim test",
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
        "excerptOrSummary": "gate claim FAILED",
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
      node "$GATE" 2>&1 <<< "{\"hook_event_name\":\"Stop\",\"cwd\":\"$t_dir\"}")"
  tamper_exit="$?"
  set -e

  if [ "$tamper_exit" -eq 2 ]; then
    _pass "$label: tampered bundle blocks (exit 2)"
  else
    _fail "$label: tampered bundle did NOT block: exit=$tamper_exit"
  fi

  if echo "$tamper_out" | grep -qE "stored status.*does not match recompute|possible tampered bundle"; then
    _pass "$label: tamper warning emits 'stored status does not match recompute'"
  else
    _fail "$label: tamper warning missing from output: $tamper_out"
  fi

  if echo "$tamper_out" | grep -q "caught false-completion"; then
    _pass "$label: tamper warning emits 'caught false-completion'"
  else
    _fail "$label: tamper warning missing 'caught false-completion': $tamper_out"
  fi

  if echo "$tamper_out" | grep -q "$claim_type"; then
    _pass "$label: tamper warning names declared claimType $claim_type"
  else
    _fail "$label: tamper warning does not name $claim_type: $tamper_out"
  fi
}

# ─── Test 0: Flow Definition required:true confirmation ──────────────────────
echo ""
echo "=== 0. Flow Definitions: confirm required:true for produced gates ==="

node -e "
  const fs = require('fs');
  const flows = [
    JSON.parse(fs.readFileSync('$ROOT/kits/builder/flows/build.flow.json', 'utf8')),
    JSON.parse(fs.readFileSync('$ROOT/kits/builder/flows/publish-learn.flow.json', 'utf8')),
  ];
  const requiredTrue = [
    'selected-work',
    'pickup-probe-readiness',
    'probe-decisions-or-accepted-gaps',
    'pull-request-opened',
    'decision-evidence',
    'learning-evidence',
  ];
  const requiredFalse = ['policy-compliance'];
  let ok = true;
  for (const flow of flows) {
    for (const [gateName, gate] of Object.entries(flow.gates || {})) {
      for (const exp of gate.expects || []) {
      if (requiredTrue.includes(exp.id) && exp.required !== true) {
        console.error('FAIL: ' + exp.id + ' in ' + flow.id + '/' + gateName + ' should be required:true, got ' + exp.required);
        ok = false;
      }
      if (requiredFalse.includes(exp.id) && exp.required !== false) {
        console.error('FAIL: ' + exp.id + ' in ' + flow.id + '/' + gateName + ' should remain required:false (advisory), got ' + exp.required);
        ok = false;
      }
      }
    }
  }
  if (!ok) process.exit(1);
" 2>/dev/null \
  && _pass "Flow Definitions: 6 produced gates are required:true, policy-compliance is required:false" \
  || _fail "Flow Definitions: required flag mismatch"

node -e "
  const fs = require('fs');
  const flows = [
    JSON.parse(fs.readFileSync('$ROOT/kits/builder/flows/build.flow.json', 'utf8')),
    JSON.parse(fs.readFileSync('$ROOT/kits/builder/flows/publish-learn.flow.json', 'utf8')),
  ];
  const producedIds = [
    'selected-work',
    'pickup-probe-readiness',
    'probe-decisions-or-accepted-gaps',
    'pull-request-opened',
    'decision-evidence',
    'learning-evidence',
  ];
  let ok = true;
  for (const flow of flows) {
    for (const [gateName, gate] of Object.entries(flow.gates || {})) {
      for (const exp of gate.expects || []) {
      if (producedIds.includes(exp.id) && exp.explore_hint) {
        console.error('FAIL: ' + exp.id + ' in ' + flow.id + '/' + gateName + ' still has explore_hint (remove when producer exists)');
        ok = false;
      }
      }
    }
  }
  if (!ok) process.exit(1);
" 2>/dev/null \
  && _pass "Flow Definitions: no explore_hint on produced gate entries" \
  || _fail "Flow Definitions: produced gate entries still have explore_hint"

# ─── Tests 1–6: produce + tamper-block for each of the 6 claims ──────────────

# Claim 1: builder.pull-work.selected
test_produce_claim \
  "builder.pull-work.selected" \
  "pull-work" "selected-work" \
  "builder.pull-work.selected" "work-item"
test_tamper_blocks \
  "builder.pull-work.selected" \
  "pull-work" "builder.pull-work.selected" "work-item"

# Claim 2: builder.design-probe.pickup-readiness
test_produce_claim \
  "builder.design-probe.pickup-readiness" \
  "design-probe" "pickup-probe-readiness" \
  "builder.design-probe.pickup-readiness" "work-item"
test_tamper_blocks \
  "builder.design-probe.pickup-readiness" \
  "design-probe" "builder.design-probe.pickup-readiness" "work-item"

# Claim 3: builder.design-probe.decisions
test_produce_claim \
  "builder.design-probe.decisions" \
  "design-probe" "probe-decisions-or-accepted-gaps" \
  "builder.design-probe.decisions" "decision"
test_tamper_blocks \
  "builder.design-probe.decisions" \
  "design-probe" "builder.design-probe.decisions" "decision"

# Claim 4: builder.pr-open.pull-request
test_produce_claim \
  "builder.pr-open.pull-request" \
  "pr-open" "pull-request-opened" \
  "builder.pr-open.pull-request" "pull-request"
test_tamper_blocks \
  "builder.pr-open.pull-request" \
  "pr-open" "builder.pr-open.pull-request" "pull-request"

# Claim 5: builder.learn.decisions
test_produce_claim \
  "builder.learn.decisions" \
  "learn" "decision-evidence" \
  "builder.learn.decisions" "decision"
test_tamper_blocks \
  "builder.learn.decisions" \
  "learn" "builder.learn.decisions" "decision"

# Claim 6: builder.learn.evidence
test_produce_claim \
  "builder.learn.evidence" \
  "learn" "learning-evidence" \
  "builder.learn.evidence" "release"
test_tamper_blocks \
  "builder.learn.evidence" \
  "learn" "builder.learn.evidence" "release"

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$errors" -eq 0 ]; then
  echo "Builder step producer tests passed (6 claims: produce + tamper-block each)."
  exit 0
fi
echo "Builder step producer tests FAILED: $errors issue(s)."
exit 1
