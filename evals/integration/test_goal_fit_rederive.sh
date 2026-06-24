#!/usr/bin/env bash
# test_goal_fit_rederive.sh — Killer test for ADR 0010 Phase 2b re-derive-at-gate hardening.
#
# Proves that:
#   1. A TAMPERED trust.bundle (stored status "verified" but evidence re-derives to
#      "disputed" because evidence[].passing === false) still BLOCKS (exit 2) and emits
#      the "stored status does not match recompute (possible tampered bundle)" warning.
#   2. A LEGITIMATE bundle (stored "verified" AND evidence re-derives to "verified") is
#      ALLOWED (no false-block).
#   3. The existing stored-status path still fires for a stored "disputed" claim (no
#      regression from #133).
#
# Design: self-cleaning, deterministic (no model spend, no live commands).
# Usage: bash evals/integration/test_goal_fit_rederive.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$ROOT/scripts/hooks/stop-goal-fit.js"

export FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=100000

TMP="$(mktemp -d)"
errors=0
_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# ─── helper: seed a minimal delivered workflow artifact ───────────────────────
seed_repo() { # $1=dir $2=slug
  local p="$1" slug="$2"
  mkdir -p "$p/.flow-agents/$slug"
  printf '# Repo\n' > "$p/AGENTS.md"
  printf '%s' "{\"schema_version\":\"1.0\",\"task_slug\":\"$slug\",\"status\":\"delivered\",\"phase\":\"done\",\"updated_at\":\"2026-06-23T00:00:00Z\",\"next_action\":{\"status\":\"done\",\"summary\":\"done\"}}" \
    > "$p/.flow-agents/$slug/state.json"
  cat > "$p/.flow-agents/$slug/$slug--deliver.md" << MD
# $slug

branch: main
status: delivered
type: deliver

## Definition Of Done
- [x] tests pass

## Goal Fit Gate
- [x] acceptance verified

### Verdict: PASS
MD
}

# ─── Test 1: TAMPERED bundle — stored "verified" but evidence re-derives to disputed ─
# A trust.bundle where the agent wrote claim.status="verified" to bypass the gate,
# but the evidence array has passing:false (a failing command result folded in by
# buildTrustBundle). Surface's deriveClaimStatus must re-derive "disputed" from
# that evidence, and the gate must block with a tamper warning.
echo "Test 1: tampered bundle (stored verified, evidence→disputed) must BLOCK"

TAMPER_DIR="$TMP/tamper"
seed_repo "$TAMPER_DIR" "tampered"

# Build a trust.bundle:
# - claim.status = "verified"   (stored, tampered to look safe)
# - evidence[passing=false]     (real command failed, fold in by sidecar)
# Surface.deriveClaimStatus will see passing:false evidence and return "disputed".
python3 - "$TAMPER_DIR/.flow-agents/tampered/trust.bundle" << 'PY'
import json, sys
bundle = {
    "schemaVersion": 3,
    "source": "flow-agents/workflow-sidecar",
    "claims": [{
        "id": "c1",
        "subjectId": "tampered/unit-tests",
        "subjectType": "workflow-check",
        "claimType": "workflow.check.command",
        "fieldOrBehavior": "unit tests",
        "value": "pass",
        "impactLevel": "high",
        "status": "verified",   # tampered: agent edited this from "disputed" → "verified"
        "createdAt": "2026-06-23T00:00:00Z",
        "updatedAt": "2026-06-23T00:00:00Z"
    }],
    "evidence": [{
        "id": "ev1",
        "claimId": "c1",
        "evidenceType": "test_output",
        "method": "validation",
        "sourceRef": "command-log.jsonl",
        "excerptOrSummary": "npm test failed with exit 1",
        "observedAt": "2026-06-23T00:00:00Z",
        "collectedBy": "harness",
        "passing": False,       # the actual command FAILED — surface sees this
        "blocking": True
    }],
    "policies": [],
    "events": [{
        "id": "evt1",
        "claimId": "c1",
        "status": "verified",  # the event says verified (tampered)
        "actor": "agent",
        "method": "workflow-check",
        "evidenceIds": ["ev1"],
        "createdAt": "2026-06-23T00:00:00Z"
    }]
}
json.dump(bundle, open(sys.argv[1], 'w'))
PY

# Run the gate in block mode.
set +e
result_out="$(FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip \
    node "$GATE" 2>&1 <<< "{\"hook_event_name\":\"Stop\",\"cwd\":\"$TAMPER_DIR\"}")"
result_exit="$?"
set -e

if [ "$result_exit" -eq 2 ]; then
  _pass "tampered bundle blocks (exit 2)"
else
  _fail "tampered bundle did NOT block: exit=$result_exit output=$result_out"
fi

if echo "$result_out" | grep -qE "stored status.*does not match recompute|possible tampered bundle"; then
  _pass "tampered bundle emits tamper warning"
else
  _fail "tampered bundle missing tamper warning: $result_out"
fi

if echo "$result_out" | grep -q "caught false-completion"; then
  _pass "tampered bundle emits caught false-completion"
else
  _fail "tampered bundle missing caught false-completion: $result_out"
fi

# ─── Test 2: LEGITIMATE bundle — stored "verified" AND evidence re-derives to "verified" ─
# A bundle where both the stored status and the re-derived status agree on "verified"
# (a passing:true evidence + a "verified" event). Must ALLOW (exit 0 in warn mode).
echo ""
echo "Test 2: legitimate bundle (stored verified, evidence→verified) must ALLOW"

LEGIT_DIR="$TMP/legit"
seed_repo "$LEGIT_DIR" "legit"

python3 - "$LEGIT_DIR/.flow-agents/legit/trust.bundle" << 'PY'
import json, sys
bundle = {
    "schemaVersion": 3,
    "source": "flow-agents/workflow-sidecar",
    "claims": [{
        "id": "c2",
        "subjectId": "legit/unit-tests",
        "subjectType": "workflow-check",
        "claimType": "workflow.check.command",
        "fieldOrBehavior": "unit tests",
        "value": "pass",
        "impactLevel": "high",
        "status": "verified",
        "createdAt": "2026-06-23T00:00:00Z",
        "updatedAt": "2026-06-23T00:00:00Z"
    }],
    "evidence": [{
        "id": "ev2",
        "claimId": "c2",
        "evidenceType": "test_output",
        "method": "validation",
        "sourceRef": "command-log.jsonl",
        "excerptOrSummary": "npm test passed",
        "observedAt": "2026-06-23T00:00:00Z",
        "collectedBy": "harness",
        "passing": True,        # command genuinely passed
        "blocking": False
    }],
    "policies": [],
    "events": [{
        "id": "evt2",
        "claimId": "c2",
        "status": "verified",
        "actor": "agent",
        "method": "workflow-check",
        "evidenceIds": ["ev2"],
        "createdAt": "2026-06-23T00:00:00Z"
    }]
}
json.dump(bundle, open(sys.argv[1], 'w'))
PY

set +e
legit_out="$(FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip \
    node "$GATE" 2>&1 <<< "{\"hook_event_name\":\"Stop\",\"cwd\":\"$LEGIT_DIR\"}")"
legit_exit="$?"
set -e

if [ "$legit_exit" -ne 2 ]; then
  _pass "legitimate bundle not blocked (exit $legit_exit)"
else
  _fail "legitimate bundle false-blocked (exit 2): $legit_out"
fi

if echo "$legit_out" | grep -q "caught false-completion"; then
  _fail "legitimate bundle incorrectly emits false-completion: $legit_out"
else
  _pass "legitimate bundle does not emit false-completion"
fi

# ─── Test 3: existing stored-disputed path still fires (no regression from #133) ──
echo ""
echo "Test 3: stored-disputed bundle must still BLOCK (no regression from #133)"

STORED_DIR="$TMP/stored"
seed_repo "$STORED_DIR" "stored"

python3 - "$STORED_DIR/.flow-agents/stored/trust.bundle" << 'PY'
import json, sys
bundle = {
    "schemaVersion": 3,
    "source": "flow-agents/workflow-sidecar",
    "claims": [{
        "id": "c3",
        "subjectId": "stored/unit-tests",
        "subjectType": "workflow-check",
        "claimType": "workflow.check.command",
        "fieldOrBehavior": "unit tests",
        "value": "fail",
        "impactLevel": "high",
        "status": "disputed",   # stored as disputed (not tampered — correctly flagged)
        "createdAt": "2026-06-23T00:00:00Z",
        "updatedAt": "2026-06-23T00:00:00Z"
    }],
    "evidence": [],
    "policies": [],
    "events": []
}
json.dump(bundle, open(sys.argv[1], 'w'))
PY

set +e
stored_out="$(FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip \
    node "$GATE" 2>&1 <<< "{\"hook_event_name\":\"Stop\",\"cwd\":\"$STORED_DIR\"}")"
stored_exit="$?"
set -e

if [ "$stored_exit" -eq 2 ]; then
  _pass "stored-disputed bundle blocks (exit 2)"
else
  _fail "stored-disputed bundle did NOT block (exit $stored_exit): $stored_out"
fi

if echo "$stored_out" | grep -q "caught false-completion"; then
  _pass "stored-disputed bundle emits caught false-completion"
else
  _fail "stored-disputed bundle missing caught false-completion: $stored_out"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
if [ "$errors" -eq 0 ]; then
  echo "Re-derive-at-gate hardening tests passed."
  exit 0
fi
echo "Re-derive-at-gate hardening tests FAILED: $errors issue(s)."
exit 1
