#!/usr/bin/env bash
# test_enforcer_expects_driven.sh — Integration eval for ADR 0016 Abstraction A P-c.
#
# Proves:
#   1. A TAMPERED declared-type bundle BLOCKS (exit 2) with the tamper/disputed
#      warning. Session has current.json with active_flow_id=builder.build,
#      active_step_id=verify. trust.bundle has a builder.verify.tests claim with
#      stored status "verified" but evidence passing=false (re-derives to disputed).
#      This exercises the expects[] claim-selection path in bundleEnforcement.
#   2. A CLEAN declared-type bundle PASSES (exit 0). Same session, same claimType,
#      but passing evidence → re-derives to verified.
#   3. A NO-ACTIVE-FLOW bundle uses the workflow.* fallback (the workflow.check.*
#      path): a tampered workflow.check.command claim still BLOCKS. current.json
#      has no active_flow_id/active_step_id.
#
# Deterministic, no model spend, self-cleaning.
# Usage: bash evals/integration/test_enforcer_expects_driven.sh

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
  mkdir -p "$p/.kontourai/flow-agents/$slug"
  printf '# Repo\n' > "$p/AGENTS.md"
  printf '%s' "{\"schema_version\":\"1.0\",\"task_slug\":\"$slug\",\"status\":\"delivered\",\"phase\":\"done\",\"updated_at\":\"2026-06-26T00:00:00Z\",\"next_action\":{\"status\":\"done\",\"summary\":\"done\"}}" \
    > "$p/.kontourai/flow-agents/$slug/state.json"
  cat > "$p/.kontourai/flow-agents/$slug/$slug--deliver.md" << MD
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

# ─── Test 1: TAMPERED declared-type bundle BLOCKS via expects[] path ─────────
# current.json has active_flow_id=builder.build, active_step_id=verify.
# The trust.bundle has builder.verify.tests (declared by verify-gate expects[]),
# stored status "verified" but evidence passing=false → re-derives to "disputed".
# The enforcer must use the expects[] path and BLOCK with the tamper warning.
echo "Test 1: tampered declared-type bundle (builder.verify.tests, stored verified, evidence→disputed) must BLOCK via expects[] path"

T1_DIR="$TMP/t1"
seed_repo "$T1_DIR" "declares-tampered"

# current.json: active flow
printf '%s' '{"artifact_dir":"declares-tampered","active_flow_id":"builder.build","active_step_id":"verify"}' \
  > "$T1_DIR/.kontourai/flow-agents/current.json"

python3 - "$T1_DIR/.kontourai/flow-agents/declares-tampered/trust.bundle" << 'PY'
import json, sys
bundle = {
    "schemaVersion": 3,
    "source": "flow-agents/workflow-sidecar",
    "claims": [{
        "id": "c1",
        "subjectId": "declares-tampered/tests",
        "subjectType": "flow-step",
        "claimType": "builder.verify.tests",
        "fieldOrBehavior": "build/verify tests",
        "value": "pass",
        "impactLevel": "high",
        "status": "verified",   # tampered: edited from "disputed" → "verified"
        "createdAt": "2026-06-26T00:00:00Z",
        "updatedAt": "2026-06-26T00:00:00Z"
    }],
    "evidence": [{
        "id": "ev1",
        "claimId": "c1",
        "evidenceType": "test_output",
        "method": "validation",
        "sourceRef": "command-log.jsonl",
        "excerptOrSummary": "npm test failed with exit 1",
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
t1_out="$(FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip \
    node "$GATE" 2>&1 <<< "{\"hook_event_name\":\"Stop\",\"cwd\":\"$T1_DIR\"}")"
t1_exit="$?"
set -e

if [ "$t1_exit" -eq 2 ]; then
  _pass "tampered declared-type bundle blocks (exit 2)"
else
  _fail "tampered declared-type bundle did NOT block: exit=$t1_exit output=$t1_out"
fi

if echo "$t1_out" | grep -qE "stored status.*does not match recompute|possible tampered bundle"; then
  _pass "tampered declared-type bundle emits tamper warning"
else
  _fail "tampered declared-type bundle missing tamper warning: $t1_out"
fi

if echo "$t1_out" | grep -q "caught false-completion"; then
  _pass "tampered declared-type bundle emits caught false-completion"
else
  _fail "tampered declared-type bundle missing caught false-completion: $t1_out"
fi

if echo "$t1_out" | grep -q "builder.verify.tests"; then
  _pass "tampered declared-type bundle warning names the declared claimType"
else
  _fail "tampered declared-type bundle warning does not mention builder.verify.tests: $t1_out"
fi

# ─── Test 2: CLEAN declared-type bundle PASSES ───────────────────────────────
# Same session, same claimType, but passing evidence → re-derives to verified.
# Must NOT block.
echo ""
echo "Test 2: clean declared-type bundle (builder.verify.tests, passing evidence→verified) must ALLOW"

T2_DIR="$TMP/t2"
seed_repo "$T2_DIR" "declares-clean"

printf '%s' '{"artifact_dir":"declares-clean","active_flow_id":"builder.build","active_step_id":"verify"}' \
  > "$T2_DIR/.kontourai/flow-agents/current.json"

python3 - "$T2_DIR/.kontourai/flow-agents/declares-clean/trust.bundle" << 'PY'
import json, sys
bundle = {
    "schemaVersion": 3,
    "source": "flow-agents/workflow-sidecar",
    "claims": [{
        "id": "c2",
        "subjectId": "declares-clean/tests",
        "subjectType": "flow-step",
        "claimType": "builder.verify.tests",
        "fieldOrBehavior": "build/verify tests",
        "value": "pass",
        "impactLevel": "high",
        "status": "verified",
        "createdAt": "2026-06-26T00:00:00Z",
        "updatedAt": "2026-06-26T00:00:00Z"
    }],
    "evidence": [{
        "id": "ev2",
        "claimId": "c2",
        "evidenceType": "test_output",
        "method": "validation",
        "sourceRef": "command-log.jsonl",
        "excerptOrSummary": "npm test passed",
        "observedAt": "2026-06-26T00:00:00Z",
        "collectedBy": "harness",
        "passing": True,
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
        "createdAt": "2026-06-26T00:00:00Z"
    }]
}
json.dump(bundle, open(sys.argv[1], 'w'))
PY

set +e
t2_out="$(FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip \
    node "$GATE" 2>&1 <<< "{\"hook_event_name\":\"Stop\",\"cwd\":\"$T2_DIR\"}")"
t2_exit="$?"
set -e

if [ "$t2_exit" -ne 2 ]; then
  _pass "clean declared-type bundle not blocked (exit $t2_exit)"
else
  _fail "clean declared-type bundle false-blocked (exit 2): $t2_out"
fi

if echo "$t2_out" | grep -q "caught false-completion"; then
  _fail "clean declared-type bundle incorrectly emits false-completion: $t2_out"
else
  _pass "clean declared-type bundle does not emit false-completion"
fi

# ─── Test 3: NO-ACTIVE-FLOW bundle uses workflow.* fallback path ─────────────
# current.json has NO active_flow_id/active_step_id (or no current.json at all).
# The trust.bundle has workflow.check.command claims with stored "disputed".
# Must still BLOCK via the workflow.* path (no regression from #133).
echo ""
echo "Test 3: no-active-flow bundle must use workflow.* fallback and still BLOCK"

T3_DIR="$TMP/t3"
seed_repo "$T3_DIR" "no-flow"

# No current.json flow keys (empty current.json that is still valid)
printf '%s' '{"artifact_dir":"no-flow"}' \
  > "$T3_DIR/.kontourai/flow-agents/current.json"

python3 - "$T3_DIR/.kontourai/flow-agents/no-flow/trust.bundle" << 'PY'
import json, sys
bundle = {
    "schemaVersion": 3,
    "source": "flow-agents/workflow-sidecar",
    "claims": [{
        "id": "c3",
        "subjectId": "no-flow/unit-tests",
        "subjectType": "workflow-check",
        "claimType": "workflow.check.command",
        "fieldOrBehavior": "unit tests",
        "value": "fail",
        "impactLevel": "high",
        "status": "disputed",   # stored as disputed (not tampered — correctly flagged)
        "createdAt": "2026-06-26T00:00:00Z",
        "updatedAt": "2026-06-26T00:00:00Z"
    }],
    "evidence": [],
    "policies": [],
    "events": []
}
json.dump(bundle, open(sys.argv[1], 'w'))
PY

set +e
t3_out="$(FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip \
    node "$GATE" 2>&1 <<< "{\"hook_event_name\":\"Stop\",\"cwd\":\"$T3_DIR\"}")"
t3_exit="$?"
set -e

if [ "$t3_exit" -eq 2 ]; then
  _pass "no-active-flow bundle still blocks via workflow.* fallback (exit 2)"
else
  _fail "no-active-flow bundle did NOT block (exit $t3_exit): $t3_out"
fi

if echo "$t3_out" | grep -q "caught false-completion"; then
  _pass "no-active-flow bundle emits caught false-completion"
else
  _fail "no-active-flow bundle missing caught false-completion: $t3_out"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
if [ "$errors" -eq 0 ]; then
  echo "P-c enforcer expects-driven tests passed."
  exit 0
fi
echo "P-c enforcer expects-driven tests FAILED: $errors issue(s)."
exit 1
