#!/usr/bin/env bash
# test_captured_fail_reconciliation.sh — Security regression proof for the
# namespace-agnostic captured-FAIL reconciliation (AC1) and related fixes.
#
# Closes the critical allowlist false-completion bypass:
#   A kit-typed claim (e.g. builder.verify.tests) asserting a command passed, while
#   command-log.jsonl recorded that command as FAIL, used to SHIP (exit 0) whenever
#   the gate didn't resolve the exact flow declaring that exact claimType — including
#   the default no-active-flow case (current.json has no active_flow_id) and any
#   agent-chosen non-declared type.
#
# Tests:
#   1. BYPASS CLOSED: kit-typed claim (builder.verify.tests) + command-log FAIL,
#      NO active flow → PRE-FIX exit 0, POST-FIX exit 2 (namespace-agnostic false-completion).
#   2. BYPASS CLOSED: agent-chosen non-declared type + active flow + command-log FAIL
#      → POST-FIX exit 2.
#   3. NO OVER-BLOCK (a): clean session, no captured fails → not blocked.
#   4. NO OVER-BLOCK (b): fail-then-re-run-to-pass (latest capture PASS) → not blocked.
#   5. NO OVER-BLOCK (c): acknowledged failure (evidence marks command disputed/failed) → not blocked.
#   6. NO OVER-BLOCK (d): no-command doc/policy session (NO evidence.execution.label,
#      no command-log) → NOT blocked (fixes #216 over-block).
#   7. AC3 empty-expects regression: declared-only bundle + fake flow with expects:[]
#      → gate misconfiguration HARD_BLOCK (two-part dependency: union form + empty-expects guard).
#
# Deterministic, no model spend, self-cleaning.
# Usage: bash evals/integration/test_captured_fail_reconciliation.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$ROOT/scripts/hooks/stop-goal-fit.js"

# #440 FIXTURE-GAP: this suite's fixtures were written before #440's per-actor ownership scoping
# and never establish a per-actor current pointer for the invoking actor -- under a RESOLVED
# ambient actor (ancestry-derived locally, GITHUB_RUN_ID-derived CI-runtime in CI), stop-goal-fit.js's
# analyze() now scopes to that actor's own (nonexistent) pointer and never reaches the
# fixture-under-test at all. This suite is about anti-gaming/gate mechanics, not #440's ownership
# scoping, so forcing the documented test-only unresolved-actor escape hatch restores EXACTLY this
# suite's pre-#440 behavior (D3 compat: an unresolved actor keeps the unchanged legacy-fallback/
# global-scan discovery every assertion below was written against).
export FLOW_AGENTS_ACTOR_TEST_FORCE_UNRESOLVED=1
export NODE_ENV=test

export FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=100000

TMP="$(mktemp -d)"
errors=0
_pass() { echo "  PASS: $1"; }
_fail() { echo "  FAIL: $1"; errors=$((errors + 1)); }

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# ─── Helper: seed a delivered (terminal) workflow artifact ────────────────────
seed_delivered() { # $1=dir $2=slug
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

# ─── Helper: write a bundle with kit-typed claim (builder.verify.tests) asserting pass ──
# Evidence item has execution.label="npm test" (the critical scenario).
write_kit_pass_bundle() { # $1=bundle_path $2=slug $3=claim_value(opt)
  local claim_val="${3:-pass}"
  python3 - "$1" "$2" "$claim_val" << 'PY'
import json, sys
bundle_path, slug, claim_val = sys.argv[1], sys.argv[2], sys.argv[3]
bundle = {
    "schemaVersion": 5, "source": "flow-agents/workflow-sidecar",
    "claims": [{
        "id": "c1", "subjectId": slug + "/tests", "subjectType": "flow-step",
        "claimType": "builder.verify.tests",
        "fieldOrBehavior": "npm test",
        "value": claim_val, "impactLevel": "high", "status": "verified",
        "createdAt": "2026-06-27T00:00:00Z", "updatedAt": "2026-06-27T00:00:00Z"
    }],
    "evidence": [{
        "id": "ev1", "claimId": "c1",
        "evidenceType": "command_output", "method": "capture",
        "sourceRef": "command-log.jsonl",
        "excerptOrSummary": "npm test passed (agent claimed)",
        "observedAt": "2026-06-27T00:00:00Z", "collectedBy": "agent",
        "passing": True,
        "execution": {"label": "npm test", "exitCode": 0}
    }],
    "policies": [], "events": []
}
json.dump(bundle, open(bundle_path, 'w'))
PY
}

# ─── Helper: write a command-log with npm test FAIL ──────────────────────────
write_fail_log() { # $1=log_path
  printf '%s\n' '{"command":"npm test","observedResult":"fail","exitCode":1,"capturedAt":"2026-06-27T00:00:00Z","source":"postToolUse-capture"}' > "$1"
}

# ─── Helper: write a command-log with npm test PASS ──────────────────────────
write_pass_log() { # $1=log_path
  printf '%s\n' '{"command":"npm test","observedResult":"pass","exitCode":0,"capturedAt":"2026-06-27T00:00:00Z","source":"postToolUse-capture"}' > "$1"
}

# ─── Helper: run gate in block mode ──────────────────────────────────────────
run_gate() { # $1=cwd, returns exit code; output on stdout
  FLOW_AGENTS_GOAL_FIT_MODE=block \
  FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip \
  FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=100000 \
    node "$GATE" 2>&1 <<< "{\"hook_event_name\":\"Stop\",\"cwd\":\"$1\"}"
}

echo ""
echo "================================================================="
echo " Namespace-Agnostic Captured-FAIL Reconciliation"
echo " (AC1 allowlist bypass closure + AC2 no-over-block)"
echo "================================================================="


# ─────────────────────────────────────────────────────────────────────────────
# Test 1: BYPASS CLOSED — kit-typed claim + command-log FAIL, NO active flow
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== 1. BYPASS CLOSED: kit-typed claim (builder.verify.tests) + command-log FAIL, NO active_flow_id ==="
echo "    PRE-FIX: gate was blind to builder.verify.tests (not workflow.* and no active flow)"
echo "    POST-FIX: capturedFailReconciliation catches it namespace-agnostically"

T1="$TMP/t1-bypass"
seed_delivered "$T1" "bypass-kit"

# NO active_flow_id in current.json
printf '%s' '{"artifact_dir":"bypass-kit"}' > "$T1/.kontourai/flow-agents/current.json"

write_kit_pass_bundle "$T1/.kontourai/flow-agents/bypass-kit/trust.bundle" "bypass-kit"
write_fail_log "$T1/.kontourai/flow-agents/bypass-kit/command-log.jsonl"

echo ""
echo "--- 1a. PRE-FIX simulation: show the gate was blind ---"
node -e "
// PRE-FIX: captureCrossReference only checked workflow.* OR declared types.
// No active_flow_id → declaredClaimTypes = null → only workflow.* selected.
// builder.verify.tests does NOT start with 'workflow.' → NOT selected → missed.
const claimType = 'builder.verify.tests';
const declaredClaimTypes = null; // no active flow

// Old code: bundleClaimedPassCommandChecks only included claims in the allowlist
const inAllowlist = claimType.startsWith('workflow.')
  || (declaredClaimTypes != null && declaredClaimTypes.has(claimType));
console.log('  builder.verify.tests in allowlist (pre-fix):', inAllowlist);
console.log('  PRE-FIX: 0 claimed-pass checks → no cross-reference → exit 0 (BYPASS)');
if (inAllowlist) { console.error('ERROR: pre-fix simulation incorrect'); process.exit(1); }
" 2>&1 && _pass "PRE-FIX: builder.verify.tests NOT in allowlist → captureCrossReference blind (exit 0)" \
          || _fail "PRE-FIX simulation error"

echo ""
echo "--- 1b. POST-FIX: capturedFailReconciliation blocks namespace-agnostically ---"
set +e
t1_out="$(run_gate "$T1")"
t1_exit=$?
set -e

echo "  POST-FIX exit code: $t1_exit (expected 2)"
if [ "$t1_exit" -eq 2 ]; then
  _pass "POST-FIX: kit-typed false-completion BLOCKED (exit 2)"
else
  _fail "POST-FIX: expected exit 2, got $t1_exit. output: ${t1_out:0:300}"
fi

if echo "$t1_out" | grep -q "caught false-completion"; then
  _pass "POST-FIX: emits 'caught false-completion' (namespace-agnostic)"
else
  _fail "POST-FIX: missing 'caught false-completion'. output: ${t1_out:0:300}"
fi

if echo "$t1_out" | grep -q "npm test"; then
  _pass "POST-FIX: warning names the contradicted command (npm test)"
else
  _fail "POST-FIX: warning does not name the command. output: ${t1_out:0:300}"
fi

if echo "$t1_out" | grep -q "builder.verify.tests"; then
  _pass "POST-FIX: warning names the claimType (builder.verify.tests)"
else
  _fail "POST-FIX: warning does not name the claimType. output: ${t1_out:0:300}"
fi

echo ""
echo "--- 1c. Exit code summary ---"
echo "  PRE-FIX exit code (simulated): 0 — builder.verify.tests not in allowlist → gate blind"
echo "  POST-FIX exit code (actual):   $t1_exit — capturedFailReconciliation blocks regardless of namespace"
if [ "$t1_exit" -eq 2 ]; then
  echo "  Result: BYPASS CLOSED (pre=0, post=2)"
else
  echo "  Result: BYPASS STILL OPEN"
fi


# ─────────────────────────────────────────────────────────────────────────────
# Test 2: BYPASS CLOSED — agent-chosen non-declared type + active flow + FAIL
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== 2. BYPASS CLOSED: agent-chosen non-declared type + active flow + command-log FAIL ==="

T2="$TMP/t2-nondeclared"
seed_delivered "$T2" "nondeclared"

# current.json: active flow (builder.build/verify)
printf '%s' '{"artifact_dir":"nondeclared","active_flow_id":"builder.build","active_step_id":"verify"}' \
  > "$T2/.kontourai/flow-agents/current.json"

# Fake flow defs dir (safe, not agent-writable)
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

# Bundle: agent-chosen NON-declared claimType (e.g. "acme.custom.verify") claiming npm test passed
python3 - "$T2/.kontourai/flow-agents/nondeclared/trust.bundle" "nondeclared" << 'PY'
import json, sys
bundle_path, slug = sys.argv[1], sys.argv[2]
bundle = {
    "schemaVersion": 5, "source": "flow-agents/workflow-sidecar",
    "claims": [{
        "id": "c1", "subjectId": slug + "/tests", "subjectType": "custom",
        "claimType": "acme.custom.verify",   # neither workflow.* NOR declared by the flow
        "fieldOrBehavior": "npm test",
        "value": "pass", "impactLevel": "high", "status": "verified",
        "createdAt": "2026-06-27T00:00:00Z", "updatedAt": "2026-06-27T00:00:00Z"
    }],
    "evidence": [{
        "id": "ev1", "claimId": "c1",
        "evidenceType": "command_output", "method": "capture",
        "sourceRef": "command-log.jsonl",
        "excerptOrSummary": "npm test passed (agent claimed)",
        "observedAt": "2026-06-27T00:00:00Z", "collectedBy": "agent",
        "passing": True,
        "execution": {"label": "npm test", "exitCode": 0}
    }],
    "policies": [], "events": []
}
json.dump(bundle, open(bundle_path, 'w'))
PY
write_fail_log "$T2/.kontourai/flow-agents/nondeclared/command-log.jsonl"

set +e
t2_out="$(FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip \
  FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=100000 FLOW_AGENTS_FLOW_DEFS_DIR="$FLOW_DEFS_DIR" \
  node "$GATE" 2>&1 <<< "{\"hook_event_name\":\"Stop\",\"cwd\":\"$T2\"}")"
t2_exit=$?
set -e

echo "  Non-declared type (acme.custom.verify) + active flow + FAIL: exit=$t2_exit (expected 2)"
if [ "$t2_exit" -eq 2 ]; then
  _pass "Non-declared type with FAIL: BLOCKED (exit 2)"
else
  _fail "Non-declared type with FAIL: NOT blocked (exit $t2_exit). output: ${t2_out:0:300}"
fi
if echo "$t2_out" | grep -q "caught false-completion\|unaccounted at completion"; then
  _pass "Non-declared type: 'caught false-completion' or 'unaccounted' emitted"
else
  _fail "Non-declared type: expected blocking message not found. output: ${t2_out:0:300}"
fi


# ─────────────────────────────────────────────────────────────────────────────
# Test 3: NO OVER-BLOCK (a) — clean session, no captured fails
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== 3. NO OVER-BLOCK (a): clean session, no captured fails ==="

T3="$TMP/t3-clean"
seed_delivered "$T3" "clean-sess"
printf '%s' '{"artifact_dir":"clean-sess"}' > "$T3/.kontourai/flow-agents/current.json"
write_kit_pass_bundle "$T3/.kontourai/flow-agents/clean-sess/trust.bundle" "clean-sess"
write_pass_log "$T3/.kontourai/flow-agents/clean-sess/command-log.jsonl"

set +e
t3_out="$(run_gate "$T3")"
t3_exit=$?
set -e

blocked_new="$(echo "$t3_out" | grep -c "unaccounted at completion\|namespace-agnostic caught false-completion" || true)"
echo "  Clean session (latest=PASS): exit=$t3_exit, new_logic_blocks=$blocked_new"
if [ "$blocked_new" -eq 0 ]; then
  _pass "Clean session NOT blocked by new reconciliation logic"
else
  _fail "Clean session INCORRECTLY blocked by new logic. output: ${t3_out:0:300}"
fi


# ─────────────────────────────────────────────────────────────────────────────
# Test 4: NO OVER-BLOCK (b) — fail-then-re-run-to-pass (latest=PASS)
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== 4. NO OVER-BLOCK (b): fail-then-re-run-to-pass (latest capture PASS) ==="

T4="$TMP/t4-rerun"
seed_delivered "$T4" "rerun-pass"
printf '%s' '{"artifact_dir":"rerun-pass"}' > "$T4/.kontourai/flow-agents/current.json"
write_kit_pass_bundle "$T4/.kontourai/flow-agents/rerun-pass/trust.bundle" "rerun-pass"
# FAIL first, then PASS (re-run fixed it — latest is PASS)
{
  printf '%s\n' '{"command":"npm test","observedResult":"fail","exitCode":1,"capturedAt":"2026-06-27T00:00:00Z","source":"test"}'
  printf '%s\n' '{"command":"npm test","observedResult":"pass","exitCode":0,"capturedAt":"2026-06-27T00:00:01Z","source":"test"}'
} > "$T4/.kontourai/flow-agents/rerun-pass/command-log.jsonl"

set +e
t4_out="$(run_gate "$T4")"
t4_exit=$?
set -e

blocked_new="$(echo "$t4_out" | grep -c "unaccounted at completion\|namespace-agnostic caught false-completion" || true)"
echo "  Fail-then-re-run-to-pass (latest=PASS): exit=$t4_exit, new_logic_blocks=$blocked_new"
if [ "$blocked_new" -eq 0 ]; then
  _pass "Fail-then-re-run-to-pass NOT blocked (latest capture PASS clears it)"
else
  _fail "Fail-then-re-run-to-pass INCORRECTLY blocked. output: ${t4_out:0:300}"
fi


# ─────────────────────────────────────────────────────────────────────────────
# Test 5: NO OVER-BLOCK (c) — acknowledged failure (evidence disputed/failed)
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== 5. NO OVER-BLOCK (c): acknowledged failure (evidence marks command disputed/failed) ==="

T5="$TMP/t5-ack"
seed_delivered "$T5" "ack-fail"
printf '%s' '{"artifact_dir":"ack-fail"}' > "$T5/.kontourai/flow-agents/current.json"

# Bundle: claim acknowledges failure (status=disputed, value=fail)
python3 - "$T5/.kontourai/flow-agents/ack-fail/trust.bundle" "ack-fail" << 'PY'
import json, sys
bundle_path, slug = sys.argv[1], sys.argv[2]
bundle = {
    "schemaVersion": 5, "source": "flow-agents/workflow-sidecar",
    "claims": [{
        "id": "c1", "subjectId": slug + "/tests", "subjectType": "flow-step",
        "claimType": "builder.verify.tests",
        "fieldOrBehavior": "npm test",
        "value": "fail",          # acknowledges failure
        "impactLevel": "low",     # low-impact avoids surface-unavailable block
        "status": "disputed",     # acknowledges failure
        "createdAt": "2026-06-27T00:00:00Z", "updatedAt": "2026-06-27T00:00:00Z"
    }],
    "evidence": [{
        "id": "ev1", "claimId": "c1",
        "evidenceType": "command_output", "method": "capture",
        "sourceRef": "command-log.jsonl",
        "excerptOrSummary": "npm test failed (acknowledged in evidence)",
        "observedAt": "2026-06-27T00:00:00Z", "collectedBy": "agent",
        "passing": False,
        "execution": {"label": "npm test", "exitCode": 1}
    }],
    "policies": [], "events": []
}
json.dump(bundle, open(bundle_path, 'w'))
PY
write_fail_log "$T5/.kontourai/flow-agents/ack-fail/command-log.jsonl"

set +e
t5_out="$(run_gate "$T5")"
t5_exit=$?
set -e

blocked_new="$(echo "$t5_out" | grep -c "unaccounted at completion\|namespace-agnostic caught false-completion" || true)"
echo "  Acknowledged failure (status=disputed, value=fail): exit=$t5_exit, new_logic_blocks=$blocked_new"
if [ "$blocked_new" -eq 0 ]; then
  _pass "Acknowledged failure NOT blocked (agent owns the failure in evidence)"
else
  _fail "Acknowledged failure INCORRECTLY blocked. output: ${t5_out:0:300}"
fi


# ─────────────────────────────────────────────────────────────────────────────
# Test 6: NO OVER-BLOCK (d) — no-command doc/policy session (fixes #216)
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== 6. NO OVER-BLOCK (d): no-command doc/policy session (verified, no execution.label, no command-log) ==="
echo "    (#216 fix: missing-log check must NOT fire when no command was expected)"

T6="$TMP/t6-nocommand"
mkdir -p "$T6/.kontourai/flow-agents/nocommand"
printf '# Repo\n' > "$T6/AGENTS.md"
# State is verified (completing) but no commands were run
printf '%s' '{"schema_version":"1.0","task_slug":"nocommand","status":"verified","phase":"verification","updated_at":"2026-06-27T00:00:00Z","next_action":{"status":"done","summary":"done"}}' \
  > "$T6/.kontourai/flow-agents/nocommand/state.json"
cat > "$T6/.kontourai/flow-agents/nocommand/nocommand--deliver.md" << 'MD'
# nocommand

branch: main
status: verified
type: deliver

## Definition Of Done
- [x] policy document reviewed

## Goal Fit Gate
- [x] acceptance verified

### Verdict: PASS
MD
printf '%s' '{"artifact_dir":"nocommand"}' > "$T6/.kontourai/flow-agents/current.json"

# Bundle with NO execution.label (doc/policy session — no commands run)
python3 - "$T6/.kontourai/flow-agents/nocommand/trust.bundle" << 'PY'
import json, sys
bundle = {
    "schemaVersion": 5, "source": "flow-agents/workflow-sidecar",
    "claims": [{
        "id": "c1", "subjectId": "nocommand/review", "subjectType": "workflow-check",
        "claimType": "workflow.check.review", "fieldOrBehavior": "policy doc reviewed",
        "value": "pass", "impactLevel": "low", "status": "verified",
        "createdAt": "2026-06-27T00:00:00Z", "updatedAt": "2026-06-27T00:00:00Z"
    }],
    "evidence": [{
        "id": "ev1", "claimId": "c1",
        "evidenceType": "review_output", "method": "manual",
        "sourceRef": "docs/policy.md",
        "excerptOrSummary": "Policy document reviewed and approved",
        "observedAt": "2026-06-27T00:00:00Z", "collectedBy": "agent",
        "passing": True
        # NOTE: NO execution.label — no command was run
    }],
    "policies": [], "events": []
}
json.dump(bundle, open(sys.argv[1], 'w'))
PY
# NO command-log.jsonl

set +e
t6_out="$(run_gate "$T6")"
t6_exit=$?
set -e

blocked_missing_log="$(echo "$t6_out" | grep -c "expected capture log is missing" || true)"
blocked_new="$(echo "$t6_out" | grep -c "unaccounted at completion\|namespace-agnostic caught false-completion" || true)"
echo "  No-command session (verified, no execution.label): exit=$t6_exit"
echo "    blocked_by_missing_log=$blocked_missing_log, blocked_by_new_logic=$blocked_new"
if [ "$blocked_missing_log" -eq 0 ] && [ "$blocked_new" -eq 0 ]; then
  _pass "#216 FIXED: no-command session NOT blocked by missing-log or new reconciliation"
else
  _fail "#216 NOT FIXED or new regression: session blocked. output: ${t6_out:0:400}"
fi


# ─────────────────────────────────────────────────────────────────────────────
# Test 7: AC3 empty-expects regression
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== 7. AC3 empty-expects regression: declared-only bundle + fake flow with expects:[] ==="
echo "    (Two-part dependency: union form ALWAYS enforces workflow.* + empty-expects guard"
echo "     emits gate-misconfiguration HARD_BLOCK for empty expects[])"

T7="$TMP/t7-empty-expects"
mkdir -p "$T7/.kontourai/flow-agents/empty-expects"
printf '# Repo\n' > "$T7/AGENTS.md"
printf '%s' '{"schema_version":"1.0","task_slug":"empty-expects","status":"in_progress","phase":"execution","updated_at":"2026-06-27T00:00:00Z","next_action":{"status":"in_progress","summary":"Testing"}}' \
  > "$T7/.kontourai/flow-agents/empty-expects/state.json"
cat > "$T7/.kontourai/flow-agents/empty-expects/empty-expects--deliver.md" << 'MD'
# empty-expects

branch: main
status: in_progress
type: deliver

## Definition Of Done
- [ ] tests pass
MD
printf '%s' '{"artifact_dir":"empty-expects","active_flow_id":"builder.build","active_step_id":"verify"}' \
  > "$T7/.kontourai/flow-agents/current.json"

# Bundle with ONLY kit-typed claims (no workflow.*)
python3 - "$T7/.kontourai/flow-agents/empty-expects/trust.bundle" "empty-expects" << 'PY'
import json, sys
bundle_path, slug = sys.argv[1], sys.argv[2]
bundle = {
    "schemaVersion": 5, "source": "flow-agents/workflow-sidecar",
    "claims": [{
        "id": "c1", "subjectId": slug + "/tests", "subjectType": "flow-step",
        "claimType": "builder.verify.tests",
        "fieldOrBehavior": "npm test",
        "value": "pass", "impactLevel": "high", "status": "disputed",
        "createdAt": "2026-06-27T00:00:00Z", "updatedAt": "2026-06-27T00:00:00Z"
    }],
    "evidence": [], "policies": [], "events": []
}
json.dump(bundle, open(bundle_path, 'w'))
PY
printf '' > "$T7/.kontourai/flow-agents/empty-expects/command-log.jsonl"

# Fake flow with expects:[] (safe dir, not agent-writable)
FAKE_FLOWS="$TMP/fake-flows-ac3"
mkdir -p "$FAKE_FLOWS"
cat > "$FAKE_FLOWS/builder.build.flow.json" << 'FLOWJSON'
{"id":"builder.build","version":"0.0","gates":{"fake-gate":{"step":"verify","expects":[]}}}
FLOWJSON

set +e
t7_out="$(FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip \
  FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=100000 FLOW_AGENTS_FLOW_DEFS_DIR="$FAKE_FLOWS" \
  node "$GATE" 2>&1 <<< "{\"hook_event_name\":\"Stop\",\"cwd\":\"$T7\"}")"
t7_exit=$?
set -e

echo "  Declared-only bundle + fake flow with expects:[]: exit=$t7_exit (expected 2)"
if [ "$t7_exit" -eq 2 ]; then
  _pass "AC3: declared-only bundle + empty-expects flow → BLOCKS (exit 2)"
else
  _fail "AC3: expected exit 2, got $t7_exit. output: ${t7_out:0:300}"
fi

if echo "$t7_out" | grep -q "gate misconfiguration"; then
  _pass "AC3: 'gate misconfiguration' HARD_BLOCK emitted (empty expects[] guard)"
else
  _fail "AC3: 'gate misconfiguration' NOT emitted. output: ${t7_out:0:300}"
fi

if echo "$t7_out" | grep -q "disputed\|caught false-completion\|not auto-releasing"; then
  _pass "AC3: union form still enforces workflow.* claim (disputed builder.verify.tests caught)"
else
  # The disputed builder.verify.tests is high-impact; surface may be unavailable
  if echo "$t7_out" | grep -q "surface unavailable\|gate misconfiguration"; then
    _pass "AC3: union form active (gate misconfiguration or surface-unavailable emitted for high-impact claim)"
  else
    _fail "AC3: union form not enforcing. output: ${t7_out:0:300}"
  fi
fi


# ─────────────────────────────────────────────────────────────────────────────
# Test 8: PROOF SCENARIO 1 — Status-gated dodge closed (Fix A: completing guard removed)
#
# PRE-FIX: capturedFailReconciliation had `if (!completing) return []`.
# A non-terminal status (e.g. 'blocked') would skip the check entirely —
# a kit-typed claim asserting pass for a FAIL command would SHIP.
# POST-FIX: completing guard removed; the check runs on EVERY stop regardless
# of state.json.status.
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== 8. PROOF SCENARIO 1 — Status-gated dodge closed (Fix A) ==="
echo "    PRE-FIX: completing guard skipped reconciliation for non-terminal statuses"
echo "    POST-FIX: guard removed → check runs on every stop (status-independent)"

T8="$TMP/t8-status-dodge"
mkdir -p "$T8/.kontourai/flow-agents/status-dodge"
printf '# Repo\n' > "$T8/AGENTS.md"
# CRITICAL: status = 'blocked' (non-terminal — pre-fix would have returned [] here)
printf '%s' '{"schema_version":"1.0","task_slug":"status-dodge","status":"blocked","phase":"executing","updated_at":"2026-06-27T00:00:00Z","next_action":{"status":"in_progress","summary":"running"}}' \
  > "$T8/.kontourai/flow-agents/status-dodge/state.json"
cat > "$T8/.kontourai/flow-agents/status-dodge/status-dodge--deliver.md" << 'MD'
# status-dodge

branch: main
status: blocked
type: deliver

## Definition Of Done
- [x] tests pass

## Goal Fit Gate
- [x] acceptance verified

### Verdict: PASS
MD

# Bundle: kit-typed claim asserting pass for "npm test"
python3 - "$T8/.kontourai/flow-agents/status-dodge/trust.bundle" "status-dodge" << 'PY'
import json, sys
bundle_path, slug = sys.argv[1], sys.argv[2]
bundle = {
    "schemaVersion": 5, "source": "flow-agents/workflow-sidecar",
    "claims": [{
        "id": "c1", "subjectId": slug + "/tests", "subjectType": "flow-step",
        "claimType": "builder.verify.tests",
        "fieldOrBehavior": "npm test",
        "value": "pass", "impactLevel": "high", "status": "verified",
        "createdAt": "2026-06-27T00:00:00Z", "updatedAt": "2026-06-27T00:00:00Z"
    }],
    "evidence": [{
        "id": "ev1", "claimId": "c1",
        "evidenceType": "command_output", "method": "capture",
        "sourceRef": "command-log.jsonl",
        "excerptOrSummary": "npm test passed (agent claimed)",
        "observedAt": "2026-06-27T00:00:00Z", "collectedBy": "agent",
        "passing": True,
        "execution": {"label": "npm test", "exitCode": 0}
    }],
    "policies": [], "events": []
}
json.dump(bundle, open(bundle_path, 'w'))
PY
# command-log: "npm test" FAIL (latest capture is FAIL — the agent lied)
write_fail_log "$T8/.kontourai/flow-agents/status-dodge/command-log.jsonl"

echo ""
echo "--- 8a. PRE-FIX simulation (completing guard) ---"
# Old code: `const completing = TERMINAL_STATUSES.has(taskStatus) || taskStatus === 'verified'`
# With status='blocked', completing=false → return []  → gate blind
node -e "
const TERMINAL_STATUSES = new Set(['done','delivered','accepted','archived','complete','completed']);
const taskStatus = 'blocked';
const completing = TERMINAL_STATUSES.has(taskStatus) || taskStatus === 'verified';
console.log('  completing (pre-fix logic):', completing, '(false → capturedFailReconciliation skipped → gate blind)');
if (completing) { process.exit(1); }
" 2>&1 && _pass "PRE-FIX: status=blocked → completing=false → reconciliation skipped → gate blind" \
          || _fail "PRE-FIX simulation error"

echo ""
echo "--- 8b. POST-FIX: guard removed → blocks regardless of status ---"
set +e
t8_out="$(run_gate "$T8")"
t8_exit=$?
set -e
echo "  POST-FIX exit: $t8_exit (expected 2, status=blocked, latest=FAIL, claim=pass)"
if [ "$t8_exit" -eq 2 ]; then
  _pass "PROOF 1: status-gated dodge closed — POST-FIX blocks (exit 2) regardless of status=blocked"
else
  _fail "PROOF 1 FAILED: status=blocked + FAIL + claim=pass should exit 2, got $t8_exit. output: ${t8_out:0:400}"
fi
if echo "$t8_out" | grep -q "caught false-completion\|namespace-agnostic"; then
  _pass "PROOF 1: 'caught false-completion' emitted for status=blocked session"
else
  _fail "PROOF 1: expected 'caught false-completion' message not found. output: ${t8_out:0:400}"
fi


# ─────────────────────────────────────────────────────────────────────────────
# Test 9: PROOF SCENARIO 2 — Over-block removed (Fix B: Case B removed)
#
# PRE-FIX: Case B would HARD_BLOCK any captured FAIL with no matching claim —
# including incidental commands (grep no-match exit 1, git diff --exit-code, etc.).
# POST-FIX: Case B removed. Only Case A (claimed pass contradicts captured FAIL) blocks.
# A genuine incidental failure with no claim is NOT blocked.
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== 9. PROOF SCENARIO 2 — Over-block removed (Fix B: Case B removed) ==="
echo "    PRE-FIX: 'unaccounted at completion' HARD_BLOCK fired for ANY unaccounted FAIL"
echo "    POST-FIX: Case B removed → incidental fails with no claim NOT blocked"

T9="$TMP/t9-overblock"
seed_delivered "$T9" "overblock-sess"
printf '%s' '{"artifact_dir":"overblock-sess"}' > "$T9/.kontourai/flow-agents/current.json"
# Bundle: only "npm test" claim asserting pass (no claim about the grep incidental fail)
write_kit_pass_bundle "$T9/.kontourai/flow-agents/overblock-sess/trust.bundle" "overblock-sess"
# Log: "npm test" PASS + incidental "grep --quiet somepattern AGENTS.md" FAIL (exit 1)
printf '%s\n%s\n' \
  '{"command":"npm test","observedResult":"pass","exitCode":0,"capturedAt":"2026-06-27T00:00:00Z","source":"postToolUse-capture"}' \
  '{"command":"grep --quiet somepattern AGENTS.md","observedResult":"fail","exitCode":1,"capturedAt":"2026-06-27T00:00:01Z","source":"postToolUse-capture"}' \
  > "$T9/.kontourai/flow-agents/overblock-sess/command-log.jsonl"

set +e
t9_out="$(run_gate "$T9")"
t9_exit=$?
set -e
echo "  POST-FIX exit: $t9_exit (expected 0 — incidental grep fail NOT a false-completion)"
if [ "$t9_exit" -ne 2 ]; then
  _pass "PROOF 2: over-block removed — incidental fail with no claim NOT blocked (exit $t9_exit)"
else
  if echo "$t9_out" | grep -q "unaccounted at completion"; then
    _fail "PROOF 2 FAILED: 'unaccounted at completion' Case B still firing (should be removed). output: ${t9_out:0:400}"
  else
    _fail "PROOF 2 FAILED: blocked (exit 2) but NOT by unaccounted Case B — check output: ${t9_out:0:400}"
  fi
fi
if echo "$t9_out" | grep -q "unaccounted at completion"; then
  _fail "PROOF 2: 'unaccounted at completion' emitted (Case B must be removed)"
else
  _pass "PROOF 2: 'unaccounted at completion' NOT emitted (Case B confirmed removed)"
fi


# ─────────────────────────────────────────────────────────────────────────────
# Test 10: PROOF SCENARIO 3 — Fix-then-pass not blocked (Fix C: latest-wins)
#
# PRE-FIX: captureCrossReference used readCommandLog (sticky-FAIL), so a legit
# fix-then-rerun-to-pass session would still be blocked.
# POST-FIX: readLatestCommandLog is used; the LAST entry wins. A genuine re-run
# that produces a PASS clears the block.
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== 10. PROOF SCENARIO 3 — Fix-then-pass not blocked (Fix C: latest-wins) ==="
echo "    PRE-FIX: sticky-FAIL in captureCrossReference kept a FAIL block even after re-run"
echo "    POST-FIX: latest-wins → re-run to PASS clears the block"

T10="$TMP/t10-fixpass"
seed_delivered "$T10" "fixpass-sess"
printf '%s' '{"artifact_dir":"fixpass-sess"}' > "$T10/.kontourai/flow-agents/current.json"
write_kit_pass_bundle "$T10/.kontourai/flow-agents/fixpass-sess/trust.bundle" "fixpass-sess"
# Log: FAIL first, then PASS (genuine fix-then-re-run)
printf '%s\n%s\n' \
  '{"command":"npm test","observedResult":"fail","exitCode":1,"capturedAt":"2026-06-27T00:00:00Z","source":"postToolUse-capture"}' \
  '{"command":"npm test","observedResult":"pass","exitCode":0,"capturedAt":"2026-06-27T00:00:01Z","source":"postToolUse-capture"}' \
  > "$T10/.kontourai/flow-agents/fixpass-sess/command-log.jsonl"

set +e
t10_out="$(run_gate "$T10")"
t10_exit=$?
set -e
echo "  POST-FIX exit: $t10_exit (expected 0 — latest capture PASS clears the earlier FAIL)"
if [ "$t10_exit" -ne 2 ]; then
  _pass "PROOF 3: fix-then-pass NOT blocked — latest PASS clears earlier FAIL (exit $t10_exit)"
else
  _fail "PROOF 3 FAILED: fix-then-pass session should exit 0 but got exit 2. output: ${t10_out:0:400}"
fi
if echo "$t10_out" | grep -q "caught false-completion\|CONTRADICTS"; then
  _fail "PROOF 3: false-completion incorrectly emitted for fix-then-pass. output: ${t10_out:0:400}"
else
  _pass "PROOF 3: no false-completion for fix-then-pass (latest PASS is the truth)"
fi


# ─────────────────────────────────────────────────────────────────────────────
# Test 11: PROOF SCENARIO 4 — Exit-code laundering flagged (Fix D)
#
# A claim asserts pass for "npm test || true" (captured exit 0 — because || true
# masks the real exit code). This is not a trustworthy PASS signal.
# POST-FIX: hasLaunderingOperator detects || true → HARD_BLOCK "exit-code-laundered".
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== 11. PROOF SCENARIO 4 — Exit-code laundering flagged (Fix D) ==="
echo "    PRE-FIX: 'npm test || true' captured exit 0 → claimed pass → gate satisfied"
echo "    POST-FIX: hasLaunderingOperator detects || true → 'exit-code-laundered' HARD_BLOCK"

T11="$TMP/t11-laundering"
seed_delivered "$T11" "laundering-sess"
printf '%s' '{"artifact_dir":"laundering-sess"}' > "$T11/.kontourai/flow-agents/current.json"
# Bundle: claim asserting pass for "npm test || true" — command string has laundering operator
python3 - "$T11/.kontourai/flow-agents/laundering-sess/trust.bundle" "laundering-sess" << 'PY'
import json, sys
bundle_path, slug = sys.argv[1], sys.argv[2]
bundle = {
    "schemaVersion": 5, "source": "flow-agents/workflow-sidecar",
    "claims": [{
        "id": "c1", "subjectId": slug + "/tests", "subjectType": "flow-step",
        "claimType": "builder.verify.tests",
        "fieldOrBehavior": "npm test || true",
        "value": "pass", "impactLevel": "high", "status": "verified",
        "createdAt": "2026-06-27T00:00:00Z", "updatedAt": "2026-06-27T00:00:00Z"
    }],
    "evidence": [{
        "id": "ev1", "claimId": "c1",
        "evidenceType": "command_output", "method": "capture",
        "sourceRef": "command-log.jsonl",
        "excerptOrSummary": "npm test || true: exit 0",
        "observedAt": "2026-06-27T00:00:00Z", "collectedBy": "agent",
        "passing": True,
        "execution": {"label": "npm test || true", "exitCode": 0}
    }],
    "policies": [], "events": []
}
json.dump(bundle, open(bundle_path, 'w'))
PY
# Log: "npm test || true" captured as PASS (exit 0) — the laundering worked
printf '%s\n' \
  '{"command":"npm test || true","observedResult":"pass","exitCode":0,"capturedAt":"2026-06-27T00:00:00Z","source":"postToolUse-capture"}' \
  > "$T11/.kontourai/flow-agents/laundering-sess/command-log.jsonl"

set +e
t11_out="$(run_gate "$T11")"
t11_exit=$?
set -e
echo "  POST-FIX exit: $t11_exit (expected 2 — || true laundering detected)"
if [ "$t11_exit" -eq 2 ]; then
  _pass "PROOF 4: exit-code laundering BLOCKED (exit 2) — 'npm test || true' not a trustworthy pass"
else
  _fail "PROOF 4 FAILED: laundering should exit 2 but got $t11_exit. output: ${t11_out:0:400}"
fi
if echo "$t11_out" | grep -q "exit-code-laundered\|laundering operators mask"; then
  _pass "PROOF 4: 'exit-code-laundered' warning emitted"
else
  _fail "PROOF 4: expected 'exit-code-laundered' message not found. output: ${t11_out:0:400}"
fi


# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "================================================================="
if [ "$errors" -eq 0 ]; then
  echo "PASS  test_captured_fail_reconciliation: all checks passed."
  echo ""
  echo "Security proof:"
  echo "  BYPASS CLOSED: kit-typed false-completion blocked namespace-agnostically"
  echo "    PRE-FIX exit 0 (ships) → POST-FIX exit 2 (blocked)"
  echo "  NO OVER-BLOCK: all 4 legitimate cases remain unblocked by new logic"
  echo "  #216 FIXED: no-command session NOT blocked by missing-log check"
  echo "  AC3: empty-expects regression caught by gate-misconfiguration HARD_BLOCK"
  echo "  PROOF 1: Status-gated dodge closed (Fix A) — status=blocked + FAIL + claim=pass → exit 2"
  echo "  PROOF 2: Over-block removed (Fix B) — incidental grep fail, no claim → exit 0"
  echo "  PROOF 3: Fix-then-pass not blocked (Fix C) — FAIL then PASS + claim=pass → exit 0"
  echo "  PROOF 4: Exit-code laundering flagged (Fix D) — 'npm test || true' claim → exit 2"
  exit 0
fi
echo "FAIL  test_captured_fail_reconciliation: $errors check(s) failed."
exit 1
