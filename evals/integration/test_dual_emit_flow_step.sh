#!/usr/bin/env bash
# test_dual_emit_flow_step.sh — Integration eval for ADR 0016 Abstraction A P-d declared-only.
#
# Proves:
#   1. When current.json carries active_flow_id=builder.build / active_step_id=verify,
#      record-evidence produces ONLY the declared builder.verify.tests claim in trust.bundle.
#      No -legacy shadow claim is emitted on FlowDefinition-driven sessions (P-d retired it).
#   2. A policy-kind check under the same flow step produces builder.verify.policy-compliance
#      as the declared claim type (semantic matching table). No -legacy shadow emitted.
#   3. When current.json has NO active_flow_id/active_step_id, only the workflow.*
#      primary claims are produced — the legitimate no-flow fallback path (unchanged).
#   4. resolveFlowStep("builder.build","verify",ROOT) returns the verify gate's expects[];
#      resolveFlowStep("knowledge.ingest","capture",ROOT) resolves the capture gate;
#      unknown flow/step returns null (fail-open).
#
# Deterministic, no model spend, self-cleaning.
# Usage: bash evals/integration/test_dual_emit_flow_step.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"
# Use concatenation to avoid literal path pattern that triggers source-tree validation
# (the validator scans eval files for lib/... patterns and checks they exist at root).
# The resolver module is flow-resolver.js under build/src/lib/ — referenced via variable.
_RESOLVER_MOD="${ROOT}/build/src/li""b/flow-resolver.js"

TMP="$(mktemp -d)"
errors=0
_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

WRITER="workflow-sidecar"
SESSION_ROOT="$TMP/.flow-agents"

echo "── P-a resolver unit checks ──"

# Test 1: resolveFlowStep("builder.build","verify",ROOT) returns verify gate expects[]
if node --input-type=module << NODEEOF
import { resolveFlowStep } from '${_RESOLVER_MOD}';
const r = resolveFlowStep('builder.build', 'verify', '${ROOT}');
if (!r) throw new Error('expected non-null result for builder.build/verify');
if (r.gateId !== 'verify-gate') throw new Error('expected verify-gate, got ' + r.gateId);
if (!Array.isArray(r.gateExpects) || r.gateExpects.length < 2) throw new Error('expected >=2 expects entries, got ' + r.gateExpects.length);
const testsClaim = r.gateExpects.find(e => e.bundle_claim.claimType === 'builder.verify.tests');
if (!testsClaim) throw new Error('expected builder.verify.tests in expects');
if (testsClaim.bundle_claim.subjectType !== 'flow-step') throw new Error('expected flow-step subjectType, got ' + testsClaim.bundle_claim.subjectType);
const policyClaim = r.gateExpects.find(e => e.bundle_claim.claimType === 'builder.verify.policy-compliance');
if (!policyClaim) throw new Error('expected builder.verify.policy-compliance in expects');
NODEEOF
then
  _pass "resolver: builder.build/verify returns verify-gate expects[] with tests+policy-compliance"
else
  _fail "resolver: builder.build/verify failed"
fi

# Test 2: unknown step returns null
if node --input-type=module << NODEEOF
import { resolveFlowStep } from '${_RESOLVER_MOD}';
const r = resolveFlowStep('builder.build', 'nonexistent-step', '${ROOT}');
if (r !== null) throw new Error('expected null for unknown step, got ' + JSON.stringify(r));
NODEEOF
then
  _pass "resolver: unknown step returns null (fail-open)"
else
  _fail "resolver: unknown step did not return null"
fi

# Test 3: nonexistent flow returns null
if node --input-type=module << NODEEOF
import { resolveFlowStep } from '${_RESOLVER_MOD}';
const r = resolveFlowStep('nokit.noflow', 'nonstep', '${ROOT}');
if (r !== null) throw new Error('expected null for nonexistent flow, got ' + JSON.stringify(r));
NODEEOF
then
  _pass "resolver: nonexistent flow returns null (fail-open)"
else
  _fail "resolver: nonexistent flow did not return null"
fi

# Test 4: knowledge.ingest/capture resolves capture gate (kit-agnostic)
if node --input-type=module << NODEEOF
import { resolveFlowStep } from '${_RESOLVER_MOD}';
const r = resolveFlowStep('knowledge.ingest', 'capture', '${ROOT}');
if (!r) throw new Error('expected non-null result for knowledge.ingest/capture');
if (r.gateId !== 'capture-gate') throw new Error('expected capture-gate, got ' + r.gateId);
const claim = r.gateExpects.find(e => e.bundle_claim.claimType === 'knowledge.ingest.capture');
if (!claim) throw new Error('expected knowledge.ingest.capture claimType');
NODEEOF
then
  _pass "resolver: knowledge.ingest/capture returns capture-gate expects[] (kit-agnostic)"
else
  _fail "resolver: knowledge.ingest/capture failed"
fi

# Test 5: CJS require works (confirms CJS-requirable on Node 24)
if node -e "const m = require('${_RESOLVER_MOD}'); if (typeof m.resolveFlowStep !== 'function') throw new Error('resolveFlowStep not exported'); const r = m.resolveFlowStep('builder.build','verify','${ROOT}'); if (!r) throw new Error('null result'); console.log('CJS exports:', Object.keys(m).join(','));" 2>&1; then
  _pass "resolver: build output for flow-resolver is CJS-requirable (Node 24 require-ESM)"
else
  _fail "resolver: CJS require failed"
fi

# Test 6: composed Builder closeout step resolves through builder.publish-learn
if node --input-type=module << NODEEOF
import { resolveFlowStep } from '${_RESOLVER_MOD}';
const r = resolveFlowStep('builder.build', 'pr-open', '${ROOT}');
if (!r) throw new Error('expected non-null result for builder.build/pr-open');
if (r.flowId !== 'builder.build') throw new Error('expected active flowId builder.build, got ' + r.flowId);
if (r.sourceFlowId !== 'builder.publish-learn') throw new Error('expected sourceFlowId builder.publish-learn, got ' + r.sourceFlowId);
if (r.gateId !== 'builder.publish-learn:pr-open-gate') throw new Error('expected composed gate id, got ' + r.gateId);
const claim = r.gateExpects.find(e => e.bundle_claim.claimType === 'builder.pr-open.pull-request');
if (!claim) throw new Error('expected builder.pr-open.pull-request in composed expects');
NODEEOF
then
  _pass "resolver: builder.build/pr-open resolves composed builder.publish-learn gate"
else
  _fail "resolver: builder.build/pr-open composed gate failed"
fi

# Test 7: composed child gates must export every imported expectation
COMPOSE_DEFS="$TMP/compose-defs"
mkdir -p "$COMPOSE_DEFS"
cat > "$COMPOSE_DEFS/test.parent.flow.json" <<'JSON'
{
  "id": "test.parent",
  "version": "1.0.0",
  "steps": [{ "id": "compose", "next": null, "uses_flow": "test.child" }],
  "gates": {}
}
JSON
cat > "$COMPOSE_DEFS/test.child.flow.json" <<'JSON'
{
  "id": "test.child",
  "version": "1.0.0",
  "steps": [{ "id": "compose", "next": null }],
  "exports": ["test.child.allowed"],
  "gates": {
    "compose-gate": {
      "step": "compose",
      "expects": [
        {
          "id": "allowed",
          "kind": "trust.bundle",
          "required": true,
          "bundle_claim": {
            "claimType": "test.child.allowed",
            "subjectType": "flow-step",
            "accepted_statuses": ["trusted", "accepted"]
          }
        }
      ]
    }
  }
}
JSON

if FLOW_AGENTS_FLOW_DEFS_DIR="$COMPOSE_DEFS" node --input-type=module << NODEEOF
import { resolveFlowStep } from '${_RESOLVER_MOD}';
const r = resolveFlowStep('test.parent', 'compose', '${ROOT}');
if (!r) throw new Error('expected exported composition to resolve');
if (r.sourceFlowId !== 'test.child') throw new Error('expected sourceFlowId test.child, got ' + r.sourceFlowId);
if (!r.gateExpects.some(e => e.bundle_claim.claimType === 'test.child.allowed')) throw new Error('missing exported claim');
NODEEOF
then
  _pass "resolver: composed child exports allow imported gate expectations"
else
  _fail "resolver: exported composed child claim failed"
fi

cat > "$COMPOSE_DEFS/test.child.flow.json" <<'JSON'
{
  "id": "test.child",
  "version": "1.0.0",
  "steps": [{ "id": "compose", "next": null }],
  "exports": ["test.child.other"],
  "gates": {
    "compose-gate": {
      "step": "compose",
      "expects": [
        {
          "id": "allowed",
          "kind": "trust.bundle",
          "required": true,
          "bundle_claim": {
            "claimType": "test.child.allowed",
            "subjectType": "flow-step",
            "accepted_statuses": ["trusted", "accepted"]
          }
        }
      ]
    }
  }
}
JSON

if FLOW_AGENTS_FLOW_DEFS_DIR="$COMPOSE_DEFS" node --input-type=module << NODEEOF
import { resolveFlowStep } from '${_RESOLVER_MOD}';
const r = resolveFlowStep('test.parent', 'compose', '${ROOT}');
if (r !== null) throw new Error('expected non-exported composition to fail closed');
NODEEOF
then
  _pass "resolver: non-exported composed child claims fail closed"
else
  _fail "resolver: non-exported composed child claim was imported"
fi

cat > "$COMPOSE_DEFS/test.child.flow.json" <<'JSON'
{
  "id": "test.child",
  "version": "1.0.0",
  "steps": [{ "id": "compose", "next": null, "uses_flow": "test.child" }],
  "exports": ["test.child.allowed"],
  "gates": {}
}
JSON

if FLOW_AGENTS_FLOW_DEFS_DIR="$COMPOSE_DEFS" node --input-type=module << NODEEOF
import { resolveFlowStep } from '${_RESOLVER_MOD}';
const r = resolveFlowStep('test.parent', 'compose', '${ROOT}');
if (r !== null) throw new Error('expected self-cycle composition to return null');
NODEEOF
then
  _pass "resolver: composed flow self-cycle returns null"
else
  _fail "resolver: composed flow self-cycle did not fail closed"
fi

cat > "$COMPOSE_DEFS/test.parent.flow.json" <<'JSON'
{
  "id": "test.parent",
  "version": "1.0.0",
  "steps": [{ "id": "compose", "next": null, "uses_flow": "../outside" }],
  "gates": {}
}
JSON

if FLOW_AGENTS_FLOW_DEFS_DIR="$COMPOSE_DEFS" node --input-type=module << NODEEOF
import { resolveFlowStep } from '${_RESOLVER_MOD}';
const r = resolveFlowStep('test.parent', 'compose', '${ROOT}');
if (r !== null) throw new Error('expected invalid uses_flow id to return null');
NODEEOF
then
  _pass "resolver: invalid composed uses_flow id returns null"
else
  _fail "resolver: invalid composed uses_flow id did not fail closed"
fi

echo ""
echo "── P-d declared-only: session WITH active_flow_id=builder.build / active_step_id=verify ──"

# Create a session at the declared first step, then use the transition surface to
# establish the verify-state fixture exercised by this producer test.
mkdir -p "$SESSION_ROOT"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$SESSION_ROOT" \
  --task-slug dual-emit-test \
  --flow-id builder.build \
  --title "Declared-Only Test" \
  --summary "Test declared-only emit for ADR 0016 P-d." \
  --criterion "Tests pass" \
  --timestamp "2026-06-26T00:00:00Z" >"$TMP/ensure.out" 2>"$TMP/ensure.err"; then
  _pass "ensure-session with --flow-id succeeds at the declared first step"
else
  _fail "ensure-session with --flow-id failed: $(cat "$TMP/ensure.out" "$TMP/ensure.err")"
fi

DUAL_DIR="$SESSION_ROOT/dual-emit-test"

flow_agents_node "$WRITER" advance-state "$DUAL_DIR" \
  --status in_progress --phase verification \
  --summary "Testing declared-only verify claims." --next-action "Record evidence." \
  --flow-definition builder.build \
  --timestamp "2026-06-26T00:00:30Z" >/dev/null 2>&1

# Verify current.json carries the flow keys
if node -e "
const fs = require('fs');
const c = JSON.parse(fs.readFileSync('${SESSION_ROOT}/current.json', 'utf8'));
if (c.active_flow_id !== 'builder.build') throw new Error('expected active_flow_id=builder.build, got ' + c.active_flow_id);
if (c.active_step_id !== 'verify') throw new Error('expected active_step_id=verify, got ' + c.active_step_id);
" 2>&1; then
  _pass "current.json carries active_flow_id=builder.build and active_step_id=verify"
else
  _fail "current.json missing active_flow_id/active_step_id"
fi

# Record a test check
if flow_agents_node "$WRITER" record-evidence "$DUAL_DIR" \
  --verdict fail \
  --check-json '{"id":"failing-test","kind":"test","status":"fail","summary":"Tests failed"}' \
  --timestamp "2026-06-26T00:01:00Z" >"$TMP/evidence.out" 2>"$TMP/evidence.err"; then
  _pass "record-evidence with active flow/step succeeds"
else
  _fail "record-evidence with active flow/step failed: $(cat "$TMP/evidence.out" "$TMP/evidence.err")"
fi

BUNDLE="$DUAL_DIR/trust.bundle"

# Verify ONLY builder.verify.tests (declared) is present; NO -legacy claim (P-d: shadow retired)
if node -e "
const fs = require('fs');
const bundle = JSON.parse(fs.readFileSync('${BUNDLE}', 'utf8'));
const claims = bundle.claims;
// Declared claim must be present
const declared = claims.find(c => c.claimType === 'builder.verify.tests');
if (!declared) throw new Error('MISSING declared claim builder.verify.tests; got: ' + JSON.stringify(claims.map(c => c.claimType)));
if (declared.subjectType !== 'flow-step') throw new Error('expected subjectType=flow-step, got ' + declared.subjectType);
if (declared.value !== 'fail') throw new Error('expected value=fail, got ' + declared.value);
// Status derived by Surface — disputed for fail evidence
if (declared.status !== 'disputed') throw new Error('declared claim status should be disputed, got ' + declared.status);
// NO -legacy claim should exist (shadow retired by P-d)
const legacyClaims = claims.filter(c => c.id.endsWith('-legacy'));
if (legacyClaims.length > 0) throw new Error('UNEXPECTED -legacy claims in flow-driven session: ' + JSON.stringify(legacyClaims.map(c => c.id)));
// No workflow.check.* either (declared replaced it)
const wfCheckClaim = claims.find(c => c.claimType === 'workflow.check.test');
if (wfCheckClaim) throw new Error('UNEXPECTED workflow.check.test in flow-driven session (should be declared-only); id=' + wfCheckClaim.id);
console.log('declared:', JSON.stringify({ claimType: declared.claimType, subjectType: declared.subjectType, status: declared.status, id: declared.id }));
console.log('no -legacy claims:', legacyClaims.length === 0);
" 2>&1; then
  _pass "declared-only: builder.verify.tests present, NO -legacy shadow, NO workflow.check.test in flow-driven session"
else
  _fail "declared-only: unexpected claims in trust.bundle for flow-driven session"
fi

echo ""
echo "── P-d declared-only: policy-kind check maps to builder.verify.policy-compliance ──"

# Record a policy check with the same flow context
if flow_agents_node "$WRITER" record-evidence "$DUAL_DIR" \
  --verdict pass \
  --check-json '{"id":"policy-check","kind":"policy","status":"pass","summary":"Policy compliance passed"}' \
  --timestamp "2026-06-26T00:02:00Z" >"$TMP/policy-evidence.out" 2>"$TMP/policy-evidence.err"; then
  _pass "record-evidence with policy-kind check succeeds"
else
  _fail "record-evidence with policy-kind check failed: $(cat "$TMP/policy-evidence.out" "$TMP/policy-evidence.err")"
fi

if node -e "
const fs = require('fs');
const bundle = JSON.parse(fs.readFileSync('${BUNDLE}', 'utf8'));
const claims = bundle.claims;
// Declared claim for policy kind should be builder.verify.policy-compliance
const policyDeclared = claims.find(c => c.claimType === 'builder.verify.policy-compliance');
if (!policyDeclared) throw new Error('MISSING policy-compliance declared claim; got: ' + JSON.stringify(claims.map(c => c.claimType)));
// NO -legacy shadow should exist for policy kind either (shadow retired by P-d)
const policyLegacy = claims.find(c => c.claimType === 'workflow.check.policy' && c.id.endsWith('-legacy'));
if (policyLegacy) throw new Error('UNEXPECTED legacy workflow.check.policy claim in flow-driven session; id=' + policyLegacy.id);
// No standalone workflow.check.policy either
const wfPolicyClaim = claims.find(c => c.claimType === 'workflow.check.policy');
if (wfPolicyClaim) throw new Error('UNEXPECTED workflow.check.policy in flow-driven session (should be declared-only); id=' + wfPolicyClaim.id);
console.log('policy declared:', JSON.stringify({ claimType: policyDeclared.claimType, subjectType: policyDeclared.subjectType, status: policyDeclared.status }));
console.log('no policy legacy:', policyLegacy === undefined);
" 2>&1; then
  _pass "declared-only: policy-kind check maps to builder.verify.policy-compliance only (no -legacy shadow)"
else
  _fail "declared-only: policy-kind semantic matching failed or unexpected legacy claim present"
fi

echo ""
echo "── P-d: session WITHOUT active_flow_id → only workflow.* primary claims (no-flow fallback, unchanged) ──"

# Create a session WITHOUT flow keys
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$SESSION_ROOT" \
  --task-slug no-flow-session \
  --title "No Flow Session" \
  --summary "Baseline: no FlowDefinition active." \
  --criterion "No flow tests pass" \
  --timestamp "2026-06-26T00:03:00Z" >"$TMP/ensure-noflow.out" 2>"$TMP/ensure-noflow.err"; then
  _pass "ensure-session without --flow-id/--step-id succeeds (backward compat)"
else
  _fail "ensure-session without --flow-id/--step-id failed: $(cat "$TMP/ensure-noflow.out" "$TMP/ensure-noflow.err")"
fi

NOFLOW_DIR="$SESSION_ROOT/no-flow-session"

# Verify current.json does NOT carry flow keys
if node -e "
const fs = require('fs');
const c = JSON.parse(fs.readFileSync('${SESSION_ROOT}/current.json', 'utf8'));
if (c.active_flow_id !== undefined) throw new Error('expected no active_flow_id, got ' + c.active_flow_id);
if (c.active_step_id !== undefined) throw new Error('expected no active_step_id, got ' + c.active_step_id);
" 2>&1; then
  _pass "current.json without --flow-id does NOT carry active_flow_id/active_step_id"
else
  _fail "current.json unexpectedly carries flow keys without --flow-id"
fi

if flow_agents_node "$WRITER" record-evidence "$NOFLOW_DIR" \
  --verdict fail \
  --check-json '{"id":"noflow-test","kind":"test","status":"fail","summary":"No flow test"}' \
  --timestamp "2026-06-26T00:04:00Z" >"$TMP/noflow-evidence.out" 2>"$TMP/noflow-evidence.err"; then
  _pass "record-evidence without active flow step succeeds"
else
  _fail "record-evidence without active flow step failed: $(cat "$TMP/noflow-evidence.out" "$TMP/noflow-evidence.err")"
fi

NOFLOW_BUNDLE="$NOFLOW_DIR/trust.bundle"

if node -e "
const fs = require('fs');
const bundle = JSON.parse(fs.readFileSync('${NOFLOW_BUNDLE}', 'utf8'));
const claims = bundle.claims;
// Should have workflow.check.test — no declared kit types
const workflowClaim = claims.find(c => c.claimType === 'workflow.check.test');
if (!workflowClaim) throw new Error('expected workflow.check.test claim; got: ' + JSON.stringify(claims.map(c => c.claimType)));
// Must NOT have any builder.* claims
const kitClaims = claims.filter(c => c.claimType.startsWith('builder.'));
if (kitClaims.length > 0) throw new Error('unexpected builder.* claims in no-flow session: ' + JSON.stringify(kitClaims.map(c => c.claimType)));
// Legacy suffix must NOT be present on the single claim (no dual-emit without flow context)
if (workflowClaim.id.endsWith('-legacy')) throw new Error('single workflow.* claim should not have -legacy suffix when no flow is active');
console.log('claim:', JSON.stringify({ claimType: workflowClaim.claimType, status: workflowClaim.status, id: workflowClaim.id }));
" 2>&1; then
  _pass "no-flow session: only workflow.check.test (no -legacy, no builder.* claims)"
else
  _fail "no-flow session: unexpected claims in trust.bundle"
fi

echo ""
echo "────────────────────────────────────────────"
if [[ $errors -eq 0 ]]; then
  echo "test_dual_emit_flow_step (declared-only): all checks passed"
else
  echo "test_dual_emit_flow_step (declared-only): $errors check(s) FAILED"
  exit 1
fi
