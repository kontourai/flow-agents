#!/usr/bin/env bash
# prove-capture-teeth-declared.sh — Permanent regression proof that the
# capture cross-reference gate BLOCKS declared-type false-completions.
#
# Bug closed: captureCrossReference previously called bundleClaimedPassCommandChecks
# WITHOUT declaredClaimTypes, so sessions with a FlowDefinition active (e.g.
# builder.build / verify step) could emit declared-type claims (builder.verify.tests)
# that the cross-reference was completely blind to. A command-log recording FAIL for
# "npm test" would NOT block even though the trust.bundle evidence claimed it passed.
# ADR 0016 P-c fix: captureCrossReference now accepts activeFlowStep and threads
# declaredClaimTypes into bundleClaimedPassCommandChecks, mirroring bundleEnforcement
# and sidecarGuidance.
#
# This eval:
#   1. Proves the fix BLOCKS (exit 2): declared-type evidence claims pass, command-log
#      says FAIL → gate emits "caught false-completion".
#   2. Proves the control case SHIPS (exit 0): same fixture with a PASS log.
#   3. Proves the workflow.check.* path still BLOCKS (no regression on original case).
#
# Deterministic — no model spend, no bundle install required.
# Usage: bash evals/acceptance/prove-capture-teeth-declared.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# #440 FIXTURE-GAP: this suite's fixtures were written before #440's per-actor ownership scoping
# and never establish a per-actor current pointer for the invoking actor -- under a RESOLVED
# ambient actor (ancestry-derived locally, GITHUB_RUN_ID-derived CI-runtime in CI), stop-goal-fit.js's
# analyze() (and evidence-capture.js's resolveArtifactDir) now scope to that actor's own
# (nonexistent) pointer and never reach the fixture-under-test at all. This suite is about
# anti-gaming/capture-teeth mechanics, not #440's ownership scoping, so forcing the documented
# test-only unresolved-actor escape hatch restores EXACTLY this suite's pre-#440 behavior (D3
# compat: an unresolved actor keeps the unchanged legacy-fallback/global-scan discovery every
# assertion below was written against). `env`-prefixed subprocess invocations below inherit this
# exported pair (env without -i does not clear the parent environment).
export FLOW_AGENTS_ACTOR_TEST_FORCE_UNRESOLVED=1
export NODE_ENV=test

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
  printf '%s' "{\"schema_version\":\"1.0\",\"task_slug\":\"$slug\",\"status\":\"delivered\",\"phase\":\"done\",\"updated_at\":\"2026-06-27T00:00:00Z\",\"next_action\":{\"status\":\"done\",\"summary\":\"done\"}}" \
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

# ─── helper: write the declared-type trust.bundle ─────────────────────────────
# Evidence item has execution.label="npm test" linked to a builder.verify.tests claim
# that asserts pass. The cross-reference must catch the command-log contradiction.
write_declared_bundle() { # $1=bundle-path
  python3 - "$1" << 'PY'
import json, sys
bundle = {
    "schemaVersion": 5,
    "source": "flow-agents/workflow-sidecar",
    "claims": [{
        "id": "c1",
        "subjectId": "declared-false/tests",
        "subjectType": "flow-step",
        "claimType": "builder.verify.tests",
        "fieldOrBehavior": "npm test",
        "value": "pass",
        "impactLevel": "high",
        "status": "verified",
        "createdAt": "2026-06-27T00:00:00Z",
        "updatedAt": "2026-06-27T00:00:00Z"
    }],
    "evidence": [{
        "id": "ev1",
        "claimId": "c1",
        "evidenceType": "command_output",
        "method": "capture",
        "sourceRef": "command-log.jsonl",
        "excerptOrSummary": "npm test passed (agent claimed)",
        "observedAt": "2026-06-27T00:00:00Z",
        "collectedBy": "agent",
        "passing": True,
        "execution": {
            "label": "npm test",
            "exitCode": 0
        }
    }],
    "policies": [],
    "events": []
}
json.dump(bundle, open(sys.argv[1], 'w'))
PY
}

# Minimal FlowDefinition: verify-gate expects builder.verify.tests
# Using FLOW_AGENTS_FLOW_DEFS_DIR so the test is self-contained (no kits/ needed).
FLOW_DEFS_DIR="$TMP/flows"
mkdir -p "$FLOW_DEFS_DIR"
cat > "$FLOW_DEFS_DIR/builder.build.flow.json" << 'FLOWJSON'
{
  "id": "builder.build",
  "version": "1.0",
  "gates": {
    "verify-gate": {
      "step": "verify",
      "expects": [
        {
          "id": "tests-evidence",
          "kind": "trust.bundle",
          "required": true,
          "bundle_claim": {
            "claimType": "builder.verify.tests",
            "subjectType": "flow-step",
            "accepted_statuses": ["trusted", "accepted"]
          }
        }
      ]
    }
  }
}
FLOWJSON

# ─── Test 1: declared-type false-completion MUST BLOCK ────────────────────────
echo "Test 1: declared-type evidence claims pass, command-log records FAIL → must BLOCK"
echo "  (This is the hole: pre-fix the gate was blind to builder.verify.tests claims)"

T1="$TMP/t1"
seed_repo "$T1" "declared-false"

# current.json: active FlowDefinition
printf '%s' '{"artifact_dir":"declared-false","active_flow_id":"builder.build","active_step_id":"verify"}' \
  > "$T1/.kontourai/flow-agents/current.json"

write_declared_bundle "$T1/.kontourai/flow-agents/declared-false/trust.bundle"

# command-log: npm test recorded as FAIL — the independent truth source says FAILED
printf '%s\n' '{"command":"npm test","observedResult":"fail","exitCode":1,"capturedAt":"2026-06-27T00:00:00Z","source":"postToolUse-capture"}' \
  > "$T1/.kontourai/flow-agents/declared-false/command-log.jsonl"

set +e
t1_out="$(FLOW_AGENTS_GOAL_FIT_MODE=block \
    FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip \
    FLOW_AGENTS_FLOW_DEFS_DIR="$FLOW_DEFS_DIR" \
    node "$GATE" 2>&1 <<< "{\"hook_event_name\":\"Stop\",\"cwd\":\"$T1\"}")"
t1_exit="$?"
set -e

if [ "$t1_exit" -eq 2 ]; then
  _pass "declared-type false-completion BLOCKED (exit 2)"
else
  _fail "declared-type false-completion NOT blocked: exit=$t1_exit output=$t1_out"
fi

if echo "$t1_out" | grep -q "caught false-completion"; then
  _pass "emits 'caught false-completion' message"
else
  _fail "missing 'caught false-completion' in output: $t1_out"
fi

if echo "$t1_out" | grep -q "capture log CONTRADICTS claimed pass"; then
  _pass "emits 'capture log CONTRADICTS claimed pass' message"
else
  _fail "missing contradicts message in output: $t1_out"
fi

if echo "$t1_out" | grep -q "npm test"; then
  _pass "warning names the contradicted command (npm test)"
else
  _fail "warning does not name the command: $t1_out"
fi

# ─── Test 2: control — matching PASS log should SHIP (no false-block) ─────────
echo ""
echo "Test 2: same fixture but command-log records PASS → must SHIP (exit 0)"

T2="$TMP/t2"
seed_repo "$T2" "declared-pass"

printf '%s' '{"artifact_dir":"declared-pass","active_flow_id":"builder.build","active_step_id":"verify"}' \
  > "$T2/.kontourai/flow-agents/current.json"

# Reuse same bundle (trusts pass) but command-log confirms pass
python3 - "$T2/.kontourai/flow-agents/declared-pass/trust.bundle" << 'PY'
import json, sys
bundle = {
    "schemaVersion": 5,
    "source": "flow-agents/workflow-sidecar",
    "claims": [{
        "id": "c2",
        "subjectId": "declared-pass/tests",
        "subjectType": "flow-step",
        "claimType": "builder.verify.tests",
        "fieldOrBehavior": "npm test",
        "value": "pass",
        "impactLevel": "high",
        "status": "verified",
        "createdAt": "2026-06-27T00:00:00Z",
        "updatedAt": "2026-06-27T00:00:00Z"
    }],
    "evidence": [{
        "id": "ev2",
        "claimId": "c2",
        "evidenceType": "command_output",
        "method": "capture",
        "sourceRef": "command-log.jsonl",
        "excerptOrSummary": "npm test passed",
        "observedAt": "2026-06-27T00:00:00Z",
        "collectedBy": "agent",
        "passing": True,
        "execution": {
            "label": "npm test",
            "exitCode": 0
        }
    }],
    "policies": [],
    "events": []
}
json.dump(bundle, open(sys.argv[1], 'w'))
PY

# command-log: npm test recorded as PASS — confirming evidence
printf '%s\n' '{"command":"npm test","observedResult":"pass","exitCode":0,"capturedAt":"2026-06-27T00:00:00Z","source":"postToolUse-capture"}' \
  > "$T2/.kontourai/flow-agents/declared-pass/command-log.jsonl"

set +e
t2_out="$(FLOW_AGENTS_GOAL_FIT_MODE=block \
    FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip \
    FLOW_AGENTS_FLOW_DEFS_DIR="$FLOW_DEFS_DIR" \
    node "$GATE" 2>&1 <<< "{\"hook_event_name\":\"Stop\",\"cwd\":\"$T2\"}")"
t2_exit="$?"
set -e

if [ "$t2_exit" -ne 2 ]; then
  _pass "confirming log clears the cross-reference (no false-block, exit $t2_exit)"
else
  _fail "confirming log incorrectly blocked (exit 2): $t2_out"
fi

if echo "$t2_out" | grep -q "caught false-completion"; then
  _fail "confirming log incorrectly emits false-completion: $t2_out"
else
  _pass "confirming log does not emit false-completion"
fi

# ─── Test 3: workflow.check.* path still BLOCKS (regression guard) ────────────
echo ""
echo "Test 3: workflow.check.* false-completion still BLOCKS (no regression on original case)"

T3="$TMP/t3"
seed_repo "$T3" "wf-false"

# No current.json active flow → loadActiveFlowStep returns null → workflow.* fallback
printf '%s' '{"artifact_dir":"wf-false"}' \
  > "$T3/.kontourai/flow-agents/current.json"

python3 - "$T3/.kontourai/flow-agents/wf-false/trust.bundle" << 'PY'
import json, sys
bundle = {
    "schemaVersion": 5,
    "source": "flow-agents/workflow-sidecar",
    "claims": [{
        "id": "c3",
        "subjectId": "wf-false/unit-tests",
        "subjectType": "workflow-check",
        "claimType": "workflow.check.command",
        "fieldOrBehavior": "npm test",
        "value": "pass",
        "impactLevel": "high",
        "status": "verified",
        "createdAt": "2026-06-27T00:00:00Z",
        "updatedAt": "2026-06-27T00:00:00Z"
    }],
    "evidence": [{
        "id": "ev3",
        "claimId": "c3",
        "evidenceType": "command_output",
        "method": "capture",
        "sourceRef": "command-log.jsonl",
        "excerptOrSummary": "npm test passed (agent claimed)",
        "observedAt": "2026-06-27T00:00:00Z",
        "collectedBy": "agent",
        "passing": True,
        "execution": {
            "label": "npm test",
            "exitCode": 0
        }
    }],
    "policies": [],
    "events": []
}
json.dump(bundle, open(sys.argv[1], 'w'))
PY

# command-log: npm test recorded as FAIL
printf '%s\n' '{"command":"npm test","observedResult":"fail","exitCode":1,"capturedAt":"2026-06-27T00:00:00Z","source":"postToolUse-capture"}' \
  > "$T3/.kontourai/flow-agents/wf-false/command-log.jsonl"

set +e
t3_out="$(FLOW_AGENTS_GOAL_FIT_MODE=block \
    FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip \
    FLOW_AGENTS_FLOW_DEFS_DIR="$FLOW_DEFS_DIR" \
    node "$GATE" 2>&1 <<< "{\"hook_event_name\":\"Stop\",\"cwd\":\"$T3\"}")"
t3_exit="$?"
set -e

if [ "$t3_exit" -eq 2 ]; then
  _pass "workflow.check.* false-completion still BLOCKS (no regression)"
else
  _fail "workflow.check.* false-completion NOT blocked: exit=$t3_exit output=$t3_out"
fi

if echo "$t3_out" | grep -q "caught false-completion"; then
  _pass "workflow.check.* path still emits 'caught false-completion'"
else
  _fail "workflow.check.* path missing 'caught false-completion': $t3_out"
fi

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$errors" -eq 0 ]; then
  echo "prove-capture-teeth-declared: all tests passed."
  echo "PROOF: declared-type false-completions are blocked; workflow.check.* path unaffected."
  exit 0
fi
echo "prove-capture-teeth-declared: FAILED ($errors issue(s))."
exit 1
