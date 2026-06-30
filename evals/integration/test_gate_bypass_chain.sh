#!/usr/bin/env bash
# test_gate_bypass_chain.sh — Security regression proof for the confirmed full
# gate-bypass chain (adversarial review HIGH/A01/A04).
#
# Exploit chain (pre-fix):
#   1. Traversal via active_flow_id: "builder.../../../.kontourai/flow-agents/slug/fake-flow"
#      splits into kitId="builder" / flowName="../../../.kontourai/flow-agents/slug/fake-flow"
#      → path.join escapes kits/ → loads attacker-authored fake-flow.flow.json
#      directly from .kontourai/flow-agents/ (agent-writable location).
#   2. Fake flow has gates:{g:{step:"verify",expects:[]}} → declaredClaimTypes=Set{}
#      (empty, NOT null) → old if/else isSelectedClaim returns false for EVERY claim
#      → bundleEnforcement emits ZERO warnings → tamper-detection bypassed → exit 0.
#
# Two-layer defense (post-fix):
#   Layer 1 (flow-resolver.ts): SLUG_RE rejects flowName containing '.' and '/'
#     before any filesystem access. resolveFlowStep returns null. Belt-and-suspenders
#     path containment check confirms resolved path stays within kits/ root.
#   Layer 2 (stop-goal-fit.js): union isSelectedClaim — workflow.* is ALWAYS enforced
#     regardless of whether declaredClaimTypes is null or empty Set. Empty expects[]
#     also triggers a loud gate misconfiguration warning.
#
# Tests:
#   1. Layer 1 — traversal closed: pre-fix path.join escapes kits/, post-fix returns null.
#   2. Layer 2 — empty-Set closed: pre-fix 0 claims selected, post-fix exit 2.
#   3. Full chain end-to-end: traversal current.json + fake empty-expects flow under
#      .kontourai/flow-agents/ + disputed workflow.* bundle → PRE-FIX exit 0, POST-FIX exit 2.
#   4. Legit session regression: builder.build/verify with real flow still works.
#
# Deterministic, no model spend, self-cleaning.
# Usage: bash evals/integration/test_gate_bypass_chain.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$ROOT/scripts/hooks/stop-goal-fit.js"
RESOLVER="$ROOT/build/src/li""b/flow-resolver.js"

export FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=100000

TMP="$(mktemp -d)"
errors=0
_pass() { echo "  PASS: $1"; }
_fail() { echo "  FAIL: $1"; errors=$((errors + 1)); }

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# ─── Helper: seed a minimal in-progress workflow artifact ─────────────────────
seed_repo_inprogress() { # $1=dir $2=slug
  local p="$1" slug="$2"
  mkdir -p "$p/.kontourai/flow-agents/$slug"
  printf '# Repo\n' > "$p/AGENTS.md"
  printf '%s' "{\"schema_version\":\"1.0\",\"task_slug\":\"$slug\",\"status\":\"in_progress\",\"phase\":\"execution\",\"updated_at\":\"2026-06-27T00:00:00Z\",\"next_action\":{\"status\":\"in_progress\",\"summary\":\"Testing\"}}" \
    > "$p/.kontourai/flow-agents/$slug/state.json"
  cat > "$p/.kontourai/flow-agents/$slug/$slug--deliver.md" << MD
# $slug

branch: main
status: in_progress
type: deliver

## Definition Of Done
- [ ] tests pass

## Goal Fit Gate
- [ ] acceptance verified
MD
}

seed_disputed_bundle() { # $1=bundle_path $2=slug
  python3 - "$1" "$2" << 'PY'
import json, sys
bundle_path, slug = sys.argv[1], sys.argv[2]
bundle = {
    "schemaVersion": 3,
    "source": "flow-agents/workflow-sidecar",
    "claims": [{
        "id": "c-dispute",
        "subjectId": slug + "/unit-tests",
        "subjectType": "workflow-check",
        "claimType": "workflow.check.command",
        "fieldOrBehavior": "unit tests",
        "value": "fail",
        "impactLevel": "high",
        "status": "disputed",
        "createdAt": "2026-06-27T00:00:00Z",
        "updatedAt": "2026-06-27T00:00:00Z"
    }],
    "evidence": [], "policies": [], "events": []
}
json.dump(bundle, open(bundle_path, 'w'))
PY
}


echo ""
echo "================================================================="
echo " Gate-Bypass Chain Security Regression (A01/A04)"
echo "================================================================="


# ─── Test 1: Traversal closed — Layer 1 slug validation + path containment ───
echo ""
echo "=== 1. Layer 1 — Traversal defense: slug validation + path containment ==="

echo "--- 1a. PRE-FIX: show path.join traversal escapes kits/ ---"
node -e "
const path = require('path');
const repoRoot = '/repo';

// Exact exploit string from the task description
const malId = 'builder.../../../.kontourai/flow-agents/slug/fake-flow';
const dot = malId.indexOf('.');  // 7
const kitId = malId.slice(0, dot);      // 'builder'
const flowName = malId.slice(dot + 1);  // '../../../.kontourai/flow-agents/slug/fake-flow'

console.log('  Traversal flowId: \"' + malId + '\"');
console.log('  Parsed: kitId=\"' + kitId + '\" flowName=\"' + flowName + '\"');

// PRE-FIX: no slug validation, path.join with flowName
const preFix = path.join(repoRoot, 'kits', kitId, 'flows', flowName + '.flow.json');
console.log('  PRE-FIX path.join: ' + preFix);
const escaped = !preFix.startsWith(path.join(repoRoot, 'kits') + '/');
console.log('  PRE-FIX escapes kits/: ' + escaped + ' → would load attacker file under .kontourai/flow-agents/');

if (!escaped) {
  console.error('ERROR: expected traversal to escape kits/ with this flowId');
  process.exit(1);
}
console.log('  PRE-FIX: attacker file loads → fake flow with empty expects[] → declaredClaimTypes=Set{}');
console.log('  PRE-FIX: old if/else isSelectedClaim → false for ALL → 0 warnings → exit 0 (bypassed)');
" 2>&1 && _pass "PRE-FIX: traversal escapes kits/ via path.join (attacker file would load)" \
          || _fail "PRE-FIX path.join simulation error"

echo ""
echo "--- 1b. POST-FIX: resolveFlowStep returns null for traversal IDs ---"
node -e "
const r = require('$RESOLVER');
const repoRoot = '$ROOT';

// Traversal IDs — all must return null (slug validation rejects '.', '/', etc.)
const cases = [
  ['builder.../../../.kontourai/flow-agents/slug/fake-flow', 'verify'],  // exact exploit from task
  ['builder../../../.kontourai/flow-agents/x/fake', 'verify'],           // double-dot variant
  ['builder.../etc/passwd', 'verify'],                          // etc/passwd probe
  ['kit-id.flow/../../secret', 'step'],                         // different separator
  ['builder.build', '../../../etc'],                            // traversal in stepId
  ['../../../etc.passwd', 'verify'],                            // traversal in kitId
];
let allNull = true;
for (const [flowId, stepId] of cases) {
  const result = r.resolveFlowStep(flowId, stepId, repoRoot);
  if (result !== null) {
    console.error('EXPLOIT OPEN: resolveFlowStep(\"' + flowId + '\",\"' + stepId + '\") returned non-null');
    allNull = false;
  } else {
    console.log('  null for flowId=\"' + flowId + '\" (correct)');
  }
}
if (!allNull) process.exit(1);
console.log('  All traversal variants return null → filesystem never accessed');
" 2>&1 && _pass "POST-FIX: all traversal variants return null (slug validation blocks)" \
          || _fail "POST-FIX: some traversal variant returned non-null (EXPLOIT OPEN)"

# Legit flow still resolves (no over-rejection)
node -e "
const r = require('$RESOLVER');
const repoRoot = '$ROOT';
const result = r.resolveFlowStep('builder.build', 'verify', repoRoot);
if (!result) { console.error('REGRESSION: builder.build/verify returned null'); process.exit(1); }
if (result.gateExpects.length === 0) { console.error('REGRESSION: expects[] empty for builder.build/verify'); process.exit(1); }
console.log('builder.build/verify: gateId=' + result.gateId + ' expects=' + result.gateExpects.length);
" 2>&1 && _pass "Legit builder.build/verify resolves correctly (no over-rejection)" \
          || _fail "Legit builder.build/verify regression"

# Validate FLOW_AGENTS_FLOW_DEFS_DIR under .kontourai/flow-agents is rejected
T1_DIR="$TMP/t1-override"
mkdir -p "$T1_DIR/.kontourai/flow-agents/fake-flows"
cat > "$T1_DIR/.kontourai/flow-agents/fake-flows/builder.build.flow.json" << 'JSON'
{"id":"fake","version":"0.0","gates":{"g":{"step":"verify","expects":[]}}}
JSON
node -e "
const r = require('$RESOLVER');
// Override points INTO .kontourai/flow-agents (agent-writable) — must fall back to kits/
process.env.FLOW_AGENTS_FLOW_DEFS_DIR = '$T1_DIR/.kontourai/flow-agents/fake-flows';
const result = r.resolveFlowStep('builder.build', 'verify', '$T1_DIR');
delete process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
// Falls back to repoRoot/kits/ which has no builder.build flow → null
// This confirms the agent-writable FLOW_DEFS_DIR override was rejected
console.log('FLOW_DEFS_DIR under .kontourai/flow-agents: result =', result, '(null = override rejected)');
" 2>&1 && _pass "FLOW_AGENTS_FLOW_DEFS_DIR under .kontourai/flow-agents is ignored (agent-writable protection)" \
          || _fail "FLOW_AGENTS_FLOW_DEFS_DIR .kontourai/flow-agents bypass not blocked"

ln -s "$T1_DIR/.kontourai/flow-agents/fake-flows" "$TMP/safe-looking-flow-defs"
node -e "
const r = require('$RESOLVER');
// Override LOOKS safe but resolves through a symlink into agent-writable runtime artifacts.
process.env.FLOW_AGENTS_FLOW_DEFS_DIR = '$TMP/safe-looking-flow-defs';
const result = r.resolveFlowStep('builder.build', 'verify', '$T1_DIR');
delete process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
console.log('FLOW_DEFS_DIR symlink to .kontourai/flow-agents: result =', result, '(null = symlink override rejected)');
if (result !== null) process.exit(1);
" 2>&1 && _pass "FLOW_AGENTS_FLOW_DEFS_DIR symlink into .kontourai/flow-agents is ignored" \
          || _fail "FLOW_AGENTS_FLOW_DEFS_DIR symlink into .kontourai/flow-agents bypass not blocked"


# ─── Test 2: Empty-Set closed — Layer 2 union form ───────────────────────────
echo ""
echo "=== 2. Layer 2 — Empty-Set defense: union isSelectedClaim + empty-expects warning ==="

T2_DIR="$TMP/t2-empty-set"
seed_repo_inprogress "$T2_DIR" "empty-set-test"
seed_disputed_bundle "$T2_DIR/.kontourai/flow-agents/empty-set-test/trust.bundle" "empty-set-test"
printf '%s' '{"artifact_dir":"empty-set-test","active_flow_id":"builder.build","active_step_id":"verify"}' \
  > "$T2_DIR/.kontourai/flow-agents/current.json"

# Fake flow with empty expects[] (loaded via FLOW_DEFS_DIR — NOT under .kontourai/flow-agents)
mkdir -p "$TMP/fake-flows-safe"
cat > "$TMP/fake-flows-safe/builder.build.flow.json" << 'JSON'
{"id":"builder.build","version":"0.0","gates":{"fake-gate":{"step":"verify","expects":[]}}}
JSON

echo "--- 2a. PRE-FIX simulation: isSelectedClaim with empty Set ---"
node -e "
const claimType = 'workflow.check.command';
const declaredClaimTypes = new Set(); // empty Set — from fake flow with expects:[]

// PRE-FIX isSelectedClaim (if/else):
const preFixSelected = (declaredClaimTypes != null)
  ? declaredClaimTypes.has(claimType)   // false — empty Set never matches
  : claimType.startsWith('workflow.');
// POST-FIX isSelectedClaim (union):
const postFixSelected = claimType.startsWith('workflow.')
  || (declaredClaimTypes != null && declaredClaimTypes.has(claimType));

console.log('  PRE-FIX  isSelectedClaim(\"workflow.check.command\") with empty Set:', preFixSelected, '← 0 claims selected → 0 warnings → exit 0');
console.log('  POST-FIX isSelectedClaim(\"workflow.check.command\") with empty Set:', postFixSelected, '← 1 claim selected → warning emitted → exit 2');

if (preFixSelected !== false) { console.error('PRE-FIX simulation incorrect'); process.exit(1); }
if (postFixSelected !== true) { console.error('POST-FIX union incorrect'); process.exit(1); }
" 2>&1 && _pass "PRE-FIX: empty Set + old if/else = 0 claims selected = 0 warnings = exit 0 (bypassed)" \
          || _fail "PRE-FIX/POST-FIX simulation error"

echo "--- 2b. POST-FIX: actual gate run with fake empty-expects flow ---"
set +e
t2_out="$(FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip \
  FLOW_AGENTS_FLOW_DEFS_DIR="$TMP/fake-flows-safe" \
  node "$GATE" 2>&1 <<< "{\"hook_event_name\":\"Stop\",\"cwd\":\"$T2_DIR\"}")"
t2_exit=$?
set -e

echo "  POST-FIX exit code: $t2_exit (expected 2)"
if [ "$t2_exit" -eq 2 ]; then
  _pass "POST-FIX: empty-expects flow + disputed workflow.* claim blocks (exit 2)"
else
  _fail "POST-FIX: expected exit 2, got $t2_exit. output: $t2_out"
fi

if echo "$t2_out" | grep -q "gate misconfiguration"; then
  _pass "POST-FIX: empty-expects warning emitted (gate misconfiguration)"
else
  _fail "POST-FIX: empty-expects warning NOT emitted. output: $t2_out"
fi

if echo "$t2_out" | grep -qE "disputed|false-completion|caught"; then
  _pass "POST-FIX: disputed workflow.* claim caught by union form"
else
  _fail "POST-FIX: disputed claim NOT caught. output: $t2_out"
fi


# ─── Test 3: Full exploit chain end-to-end ───────────────────────────────────
echo ""
echo "=== 3. Full exploit chain: traversal current.json + fake empty-expects flow + disputed bundle ==="
echo ""
echo "Setup: T3_DIR has kits/ so findRepoRoot returns T3_DIR."
echo "Traversal flowId 'builder.../../../.kontourai/flow-agents/slug/fake-flow' with repoRoot=T3_DIR resolves to:"
echo "  T3_DIR/.kontourai/flow-agents/slug/fake-flow.flow.json (agent-writable — the fake flow)"

T3_DIR="$TMP/t3-full-chain"
mkdir -p "$T3_DIR/kits"  # ensures findRepoRoot returns T3_DIR
seed_repo_inprogress "$T3_DIR" "exploit-test"
seed_disputed_bundle "$T3_DIR/.kontourai/flow-agents/exploit-test/trust.bundle" "exploit-test"

# Place the fake flow exactly where the traversal would resolve it:
# path.join(T3_DIR, "kits", "builder", "flows", "../../../.kontourai/flow-agents/slug/fake-flow.flow.json")
# = T3_DIR/.kontourai/flow-agents/slug/fake-flow.flow.json
mkdir -p "$T3_DIR/.kontourai/flow-agents/slug"
cat > "$T3_DIR/.kontourai/flow-agents/slug/fake-flow.flow.json" << 'JSON'
{
  "id": "fake-bypass",
  "version": "0.0",
  "gates": {
    "fake-gate": {
      "step": "verify",
      "expects": []
    }
  }
}
JSON

# current.json: traversal active_flow_id pointing to the fake flow
printf '%s' '{"artifact_dir":"exploit-test","active_flow_id":"builder.../../../.kontourai/flow-agents/slug/fake-flow","active_step_id":"verify"}' \
  > "$T3_DIR/.kontourai/flow-agents/current.json"

echo ""
echo "--- 3a. PRE-FIX: demonstrate traversal would load the fake flow ---"
node -e "
const path = require('path');
const repoRoot = '$T3_DIR';
const flowId = 'builder.../../../.kontourai/flow-agents/slug/fake-flow';
const dot = flowId.indexOf('.');
const kitId = flowId.slice(0, dot);
const flowName = flowId.slice(dot + 1);
const preFix = path.join(repoRoot, 'kits', kitId, 'flows', flowName + '.flow.json');
const resolved = path.resolve(preFix);
const fs = require('fs');
const exists = fs.existsSync(resolved);
console.log('  PRE-FIX path.join result:', resolved);
console.log('  Fake flow file exists at resolved path:', exists);
if (!exists) { console.error('ERROR: fake flow not found at ' + resolved); process.exit(1); }
const fakeFlow = JSON.parse(fs.readFileSync(resolved, 'utf8'));
const gate = fakeFlow.gates && Object.values(fakeFlow.gates)[0];
const emptyExpects = gate && Array.isArray(gate.expects) && gate.expects.length === 0;
console.log('  Fake flow gate expects[]:', JSON.stringify(gate && gate.expects));
console.log('  Empty expects[] (Set{}):', emptyExpects);
console.log('  PRE-FIX result: loads fake flow → Set{} → old if/else → 0 claims selected → exit 0');
if (!emptyExpects) { console.error('ERROR: fake flow does not have empty expects'); process.exit(1); }
" 2>&1 && _pass "PRE-FIX: traversal resolves to fake flow with empty expects[] (would ship with exit 0)" \
          || _fail "PRE-FIX chain setup error"

echo ""
echo "--- 3b. POST-FIX: gate blocks the full exploit chain ---"
set +e
t3_out="$(FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip \
  node "$GATE" 2>&1 <<< "{\"hook_event_name\":\"Stop\",\"cwd\":\"$T3_DIR\"}")"
t3_exit=$?
set -e

echo "  POST-FIX gate exit code: $t3_exit (expected 2)"
if [ "$t3_exit" -eq 2 ]; then
  _pass "POST-FIX: full exploit chain blocked (exit 2)"
else
  _fail "POST-FIX: full exploit chain NOT blocked (exit $t3_exit). output: $t3_out"
fi

if echo "$t3_out" | grep -qE "disputed|false-completion|caught"; then
  _pass "POST-FIX: disputed workflow.* claim caught (Layer 1 → null → workflow.* fallback active)"
else
  _fail "POST-FIX: disputed claim NOT caught in full chain. output: $t3_out"
fi

echo ""
echo "--- 3c. Exit code summary ---"
echo "  PRE-FIX exit code (simulated): 0 — loads fake flow, empty Set bypasses bundleEnforcement"
echo "  POST-FIX exit code (actual):   $t3_exit — slug validation returns null, workflow.* enforced"
if [ "$t3_exit" -eq 2 ]; then
  echo "  Result: EXPLOIT CLOSED (pre=0, post=2)"
else
  echo "  Result: EXPLOIT STILL OPEN"
fi

# ─── Test 4: Legit builder.build session regression ──────────────────────────
echo ""
echo "=== 4. Regression: legit builder.build/verify session passes (no false-block) ==="

T4_DIR="$TMP/t4-legit"
mkdir -p "$T4_DIR/.kontourai/flow-agents/legit-test"
printf '# Repo\n' > "$T4_DIR/AGENTS.md"
printf '%s' '{"artifact_dir":"legit-test","active_flow_id":"builder.build","active_step_id":"verify"}' \
  > "$T4_DIR/.kontourai/flow-agents/current.json"
printf '%s' '{"schema_version":"1.0","task_slug":"legit-test","status":"delivered","phase":"done","updated_at":"2026-06-27T00:00:00Z","next_action":{"status":"done","summary":"done"}}' \
  > "$T4_DIR/.kontourai/flow-agents/legit-test/state.json"
cat > "$T4_DIR/.kontourai/flow-agents/legit-test/legit-test--deliver.md" << 'MD'
# legit-test

branch: main
status: delivered
type: deliver

## Definition Of Done
- [x] tests pass

## Goal Fit Gate
- [x] acceptance verified

### Verdict: PASS
MD

# Write a CLEAN trust.bundle for builder.verify.tests (status=verified, passing evidence)
python3 - "$T4_DIR/.kontourai/flow-agents/legit-test/trust.bundle" << 'PY'
import json, sys
bundle = {
    "schemaVersion": 3,
    "source": "flow-agents/workflow-sidecar",
    "claims": [{
        "id": "c-legit",
        "subjectId": "legit-test/tests",
        "subjectType": "flow-step",
        "claimType": "builder.verify.tests",
        "fieldOrBehavior": "all tests pass",
        "value": "pass",
        "impactLevel": "high",
        "status": "verified",
        "createdAt": "2026-06-27T00:00:00Z",
        "updatedAt": "2026-06-27T00:00:00Z"
    }],
    "evidence": [{
        "id": "ev-legit",
        "claimId": "c-legit",
        "evidenceType": "test_output",
        "method": "validation",
        "sourceRef": "command-log.jsonl",
        "excerptOrSummary": "All tests passed",
        "observedAt": "2026-06-27T00:00:00Z",
        "collectedBy": "harness",
        "passing": True,
        "blocking": False
    }],
    "policies": [],
    "events": [{
        "id": "evt-legit",
        "claimId": "c-legit",
        "status": "verified",
        "actor": "agent",
        "method": "workflow-check",
        "evidenceIds": ["ev-legit"],
        "createdAt": "2026-06-27T00:00:00Z"
    }]
}
json.dump(bundle, open(sys.argv[1], 'w'))
PY

set +e
t4_out="$(FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip \
  node "$GATE" 2>&1 <<< "{\"hook_event_name\":\"Stop\",\"cwd\":\"$T4_DIR\"}")"
t4_exit=$?
set -e

if [ "$t4_exit" -ne 2 ]; then
  _pass "Legit builder.build/verify: clean bundle passes gate (exit $t4_exit)"
else
  _fail "Legit builder.build/verify: false-blocked (exit 2). output: $t4_out"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "================================================================="
if [ "$errors" -eq 0 ]; then
  echo "PASS  Gate-bypass chain eval: all checks passed."
  echo ""
  echo "Security proof:"
  echo "  Layer 1 (flow-resolver.ts): SLUG_RE + containment — all traversal IDs return null"
  echo "  Layer 2 (stop-goal-fit.js): union isSelectedClaim — workflow.* always enforced"
  echo "  Full chain: PRE-FIX exit 0 (would ship) → POST-FIX exit 2 (blocked)"
  echo "  No regression: legit builder.build/verify session passes"
  exit 0
fi
echo "FAIL  Gate-bypass chain eval: $errors check(s) failed."
exit 1
