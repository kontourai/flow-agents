#!/usr/bin/env bash
# test_claim_lookup.sh — Integration tests for the `claim` subcommand (#162).
#
# Verifies:
#   AC1: status + value + failing evidence (with execution block) + policy + derivation drilldown
#   AC1: --json flag emits structured ClaimExplanation object
#   AC1: unknown claim id exits 1 with clear error listing available ids
#   AC1: missing bundle exits 1 with clear error
#   AC3: gate-hint in stop-goal-fit.js disputed warning contains workflow:sidecar -- claim
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

TMPDIR_EVAL="$(mktemp -d)"
errors=0

cleanup() { rm -rf "$TMPDIR_EVAL"; }
trap cleanup EXIT

_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

echo "=== Claim Lookup Tests (issue #162) ==="

# ── helpers ──────────────────────────────────────────────────────────────────

jq_node() {
  local file="$1"; local expr="$2"
  node -e "
const d=JSON.parse(require('fs').readFileSync('${file}','utf8'));
const r=(${expr})(d);
if(r===undefined||r===null){process.exit(2);}
if(typeof r==='boolean'||typeof r==='number'||typeof r==='string'){
  process.stdout.write(String(r)+'\n');
}else{
  process.stdout.write(JSON.stringify(r)+'\n');
}"
}

# Seed a trust.bundle with a DISPUTED claim including a failing execution block and a policy.
seed_disputed_bundle() {
  local dir="$1" slug="$2"
  local ts="2026-06-25T00:00:00Z"
  local claimId="${slug}/unit-tests.flow-agents.workflow.unit tests pass"
  mkdir -p "$dir"
  cat > "$dir/trust.bundle" <<JSON
{
  "schemaVersion": 3,
  "source": "claim-lookup-test;statusFunctionVersion=1",
  "claims": [
    {
      "id": "$claimId",
      "subjectType": "workflow-check",
      "subjectId": "${slug}/unit-tests",
      "surface": "flow-agents.workflow",
      "claimType": "workflow.check.test",
      "fieldOrBehavior": "unit tests pass",
      "value": "fail",
      "status": "disputed",
      "impactLevel": "high",
      "verificationPolicyId": "policy:workflow.check.test",
      "createdAt": "$ts",
      "updatedAt": "$ts"
    }
  ],
  "evidence": [
    {
      "id": "ev:${claimId}",
      "claimId": "${claimId}",
      "evidenceType": "test_output",
      "label": "npm test output",
      "method": "validation",
      "excerptOrSummary": "8 tests failed",
      "status": "disputed",
      "execution": {
        "runner": "npm test",
        "label": "npm test",
        "isError": true,
        "exitCode": 1
      },
      "sourceRef": "command-log.jsonl",
      "createdAt": "$ts"
    }
  ],
  "events": [
    {
      "id": "evt:${claimId}",
      "claimId": "${claimId}",
      "status": "disputed",
      "actor": "test",
      "method": "validation",
      "evidenceIds": ["ev:${claimId}"],
      "createdAt": "$ts",
      "verifiedAt": "$ts"
    }
  ],
  "policies": [
    {
      "id": "policy:workflow.check.test",
      "claimType": "workflow.check.test",
      "requiredEvidence": ["test_output"],
      "requiredMethods": ["validation"],
      "acceptanceCriteria": ["A verified verification event must support a workflow.check.test claim."],
      "reviewAuthority": "system",
      "validityRule": { "kind": "manual" },
      "stalenessTriggers": [],
      "conflictRules": [],
      "impactLevel": "high"
    }
  ]
}
JSON
}

# ── Test 1: AC1 — text output has status + value + evidence + policy + drilldown ──

echo ""
echo "── Test 1: text output (status + evidence + policy + drilldown) ──"

AC1_DIR="$TMPDIR_EVAL/ac1"
AC1_SLUG="claim-lookup-ac1"
seed_disputed_bundle "$AC1_DIR" "$AC1_SLUG"
AC1_CLAIM_ID="${AC1_SLUG}/unit-tests.flow-agents.workflow.unit tests pass"

AC1_OUT="$TMPDIR_EVAL/ac1.out"
if flow_agents_node workflow-sidecar claim "$AC1_CLAIM_ID" "$AC1_DIR" >"$AC1_OUT" 2>&1; then
  _pass "AC1: claim command exits 0 for known disputed claim"
else
  _fail "AC1: claim command failed: $(cat "$AC1_OUT")"
fi

if grep -q "Status: disputed" "$AC1_OUT"; then
  _pass "AC1: output contains derived status (disputed)"
else
  _fail "AC1: output missing derived status: $(head -3 "$AC1_OUT")"
fi

if grep -q "Value: fail" "$AC1_OUT"; then
  _pass "AC1: output contains raw value"
else
  _fail "AC1: output missing value"
fi

if grep -q "exitCode: 1" "$AC1_OUT" && grep -q "isError: true" "$AC1_OUT"; then
  _pass "AC1: failing evidence execution block shown (exitCode + isError)"
else
  _fail "AC1: execution block missing from evidence output: $(grep -i "exitCode\|isError\|Evidence" "$AC1_OUT" || echo '(not found)')"
fi

if grep -q "Governing Policy (policy:workflow.check.test)" "$AC1_OUT"; then
  _pass "AC1: governing policy section present"
else
  _fail "AC1: governing policy section missing"
fi

if grep -q "requiredEvidence:" "$AC1_OUT" && grep -q "acceptanceCriteria:" "$AC1_OUT" && grep -q "reviewAuthority:" "$AC1_OUT"; then
  _pass "AC1: policy fields (requiredEvidence, acceptanceCriteria, reviewAuthority) present"
else
  _fail "AC1: policy fields incomplete: $(grep -E "required|acceptance|review" "$AC1_OUT" || echo '(not found)')"
fi

if grep -q "Derivation Drilldown:" "$AC1_OUT"; then
  _pass "AC1: derivation drilldown section present"
else
  _fail "AC1: derivation drilldown section missing"
fi

# ── Test 2: AC1 — --json flag emits structured ClaimExplanation ──

echo ""
echo "── Test 2: --json flag emits structured ClaimExplanation object ──"

AC2_JSON="$TMPDIR_EVAL/ac1.json"
if flow_agents_node workflow-sidecar claim "$AC1_CLAIM_ID" "$AC1_DIR" --json >"$AC2_JSON" 2>&1; then
  _pass "AC2: --json exits 0"
else
  _fail "AC2: --json failed: $(cat "$AC2_JSON")"
fi

# Validate JSON structure
FOUND="$(jq_node "$AC2_JSON" 'd => d.found' 2>/dev/null || echo '')"
STATUS="$(jq_node "$AC2_JSON" 'd => d.status' 2>/dev/null || echo '')"
VALUE="$(jq_node "$AC2_JSON" 'd => d.value' 2>/dev/null || echo '')"
HAS_POLICY="$(jq_node "$AC2_JSON" 'd => d.policy !== null && d.policy.id !== undefined' 2>/dev/null || echo '')"
EVIDENCE_LEN="$(jq_node "$AC2_JSON" 'd => d.evidence.length' 2>/dev/null || echo '')"
EXEC_EXITCODE="$(jq_node "$AC2_JSON" 'd => d.evidence[0] && d.evidence[0].execution && d.evidence[0].execution.exitCode' 2>/dev/null || echo '')"
HAS_WHY="$(jq_node "$AC2_JSON" 'd => typeof d.why === "object" && d.why !== null' 2>/dev/null || echo '')"

[[ "$FOUND" == "true" ]] && _pass "AC2: found=true in JSON" || _fail "AC2: expected found=true, got '$FOUND'"
[[ "$STATUS" == "disputed" ]] && _pass "AC2: status=disputed in JSON" || _fail "AC2: expected status=disputed, got '$STATUS'"
[[ "$VALUE" == "fail" ]] && _pass "AC2: value=fail in JSON" || _fail "AC2: expected value=fail, got '$VALUE'"
[[ "$HAS_POLICY" == "true" ]] && _pass "AC2: policy object present in JSON" || _fail "AC2: policy missing: $HAS_POLICY"
[[ "$EVIDENCE_LEN" == "1" ]] && _pass "AC2: evidence array has 1 item" || _fail "AC2: expected 1 evidence item, got '$EVIDENCE_LEN'"
[[ "$EXEC_EXITCODE" == "1" ]] && _pass "AC2: evidence[0].execution.exitCode=1 in JSON" || _fail "AC2: expected exitCode=1, got '$EXEC_EXITCODE'"
[[ "$HAS_WHY" == "true" ]] && _pass "AC2: why object present in JSON" || _fail "AC2: why object missing"

# ── Test 3: AC1 — unknown id exits 1 with clear error listing available ids ──

echo ""
echo "── Test 3: unknown claim id → clear error + list of available ids ──"

AC3_OUT="$TMPDIR_EVAL/ac3.out"
if flow_agents_node workflow-sidecar claim "nonexistent-claim-id" "$AC1_DIR" >"$AC3_OUT" 2>&1; then
  _fail "AC3: expected exit 1 for unknown claim id but got 0"
else
  _pass "AC3: exits 1 for unknown claim id"
fi

if grep -q "unknown claim id: nonexistent-claim-id" "$AC3_OUT"; then
  _pass "AC3: error message names the unknown id"
else
  _fail "AC3: error message missing id: $(cat "$AC3_OUT")"
fi

if grep -q "Available claim ids" "$AC3_OUT"; then
  _pass "AC3: error lists available claim ids"
else
  _fail "AC3: error does not list available ids: $(cat "$AC3_OUT")"
fi

# ── Test 4: AC1 — missing bundle exits 1 ──

echo ""
echo "── Test 4: missing bundle → clear error ──"

AC4_OUT="$TMPDIR_EVAL/ac4.out"
if flow_agents_node workflow-sidecar claim "any-id" "$TMPDIR_EVAL/nonexistent" >"$AC4_OUT" 2>&1; then
  _fail "AC4: expected exit 1 for missing bundle but got 0"
else
  _pass "AC4: exits 1 for missing bundle"
fi

if grep -q "no trust.bundle at" "$AC4_OUT"; then
  _pass "AC4: error message mentions missing trust.bundle"
else
  _fail "AC4: error message missing: $(cat "$AC4_OUT")"
fi

# ── Test 5: AC3 — gate-hint in stop-goal-fit.js warning ──
# Use a bundle with an acceptance criterion claim (not a check claim) so the
# bundleEnforcement warning is not deduplicated by captureCrossReference.
# FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip prevents backstop re-runs for hermeticity.

echo ""
echo "── Test 5: gate-hint appears in stop-goal-fit.js disputed warning ──"

AC5_PROJ="$TMPDIR_EVAL/gate-hint-proj"
AC5_SLUG="gate-hint-test"
AC5_DIR="$AC5_PROJ/.flow-agents/$AC5_SLUG"
mkdir -p "$AC5_DIR"

# Write a minimal bundle with a disputed acceptance criterion claim.
# Using workflow.acceptance.criterion (not workflow.check.*) so the subjectId
# won't match any evidence check id and bundleEnforcement won't be deduped.
cat > "$AC5_DIR/trust.bundle" <<'BUNDLE'
{
  "schemaVersion": 3,
  "source": "claim-lookup-test",
  "claims": [
    {
      "id": "gate-hint-test/AC1.flow-agents.workflow.acceptance criterion verified",
      "subjectType": "workflow-criterion",
      "subjectId": "gate-hint-test/AC1",
      "surface": "flow-agents.workflow",
      "claimType": "workflow.acceptance.criterion",
      "fieldOrBehavior": "acceptance criterion verified",
      "value": "fail",
      "status": "disputed",
      "impactLevel": "high",
      "verificationPolicyId": "policy:workflow.acceptance.criterion",
      "createdAt": "2026-06-25T00:00:00Z",
      "updatedAt": "2026-06-25T00:00:00Z"
    }
  ],
  "evidence": [],
  "events": [
    {
      "id": "evt:gate-hint-test/AC1",
      "claimId": "gate-hint-test/AC1.flow-agents.workflow.acceptance criterion verified",
      "status": "disputed",
      "actor": "test",
      "method": "validation",
      "evidenceIds": [],
      "createdAt": "2026-06-25T00:00:00Z",
      "verifiedAt": "2026-06-25T00:00:00Z"
    }
  ],
  "policies": [
    {
      "id": "policy:workflow.acceptance.criterion",
      "claimType": "workflow.acceptance.criterion",
      "requiredEvidence": ["human_attestation"],
      "acceptanceCriteria": ["A criterion must have a verified event."],
      "reviewAuthority": "system",
      "validityRule": { "kind": "manual" },
      "stalenessTriggers": [],
      "conflictRules": [],
      "impactLevel": "high"
    }
  ]
}
BUNDLE

cat > "$AC5_DIR/state.json" <<'JSON'
{"schema_version":"1.0","task_slug":"gate-hint-test","status":"delivered","phase":"done","updated_at":"2026-06-25T00:00:00Z","next_action":{"status":"done","summary":"done"}}
JSON

cat > "$AC5_DIR/gate-hint-test--deliver.md" <<'MD'
# Gate Hint Test

branch: main
status: delivered
type: deliver

## Definition Of Done
- [x] all tests pass

## Goal Fit Gate
- [x] criteria verified

### Verdict: PASS
MD

AC5_OUT="$TMPDIR_EVAL/ac5.out"
# FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip prevents backstop re-runs for hermeticity.
printf '{"hook_event_name":"Stop","cwd":"%s"}' "$AC5_PROJ" \
  | FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip node "$ROOT/scripts/hooks/stop-goal-fit.js" >"$AC5_OUT" 2>&1 || true

if grep -q "workflow:sidecar -- claim" "$AC5_OUT"; then
  _pass "AC5: gate-hint 'workflow:sidecar -- claim' appears in stop-goal-fit output"
else
  _fail "AC5: gate-hint missing from stop-goal-fit output: $(cat "$AC5_OUT")"
fi

if grep -q "trust.bundle claim disputed" "$AC5_OUT"; then
  _pass "AC5: disputed warning present in stop-goal-fit output"
else
  _fail "AC5: disputed warning missing: $(cat "$AC5_OUT")"
fi

# ── Results ──────────────────────────────────────────────────────────────────

echo ""
echo "──────────────────────────────────"
echo "claim lookup tests: $((errors)) failed"
if [[ "$errors" -eq 0 ]]; then
  echo "ALL PASSED"
  exit 0
else
  exit 1
fi
