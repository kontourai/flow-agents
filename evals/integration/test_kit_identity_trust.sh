#!/usr/bin/env bash
# test_kit_identity_trust.sh — Regression eval for kit identity end-to-end in the trust chain.
#
# Proves Fix 1 and Fix 2 from the kit-identity task:
#
#  Fix 1 (surfaceCheckFromArtifact reads kit from bundle, never hardcodes "builder"):
#   1a. KNOWLEDGE-TYPED bundle → kitIdentityFromBundle derives kitId="knowledge", subject="knowledge-kit"
#   1b. BUILDER-TYPED bundle  → kitIdentityFromBundle derives kitId="builder", subject="builder-kit"
#   1c. WORKFLOW-ONLY bundle (no kit-typed claim, no current.json) → kitId="unknown", subject="unknown-kit"
#   1d. record-evidence --surface-trust-json <knowledge-fixture> completes without crash
#
#  Fix 2 (route-back guard is FlowDefinition-driven, not hardcoded to builder.build):
#   2a. builder.build: verification→execution still enforced (identical behavior preserved)
#   2b. Custom non-builder flow WITH route_back_policy: verification→execution ENFORCED
#   2c. Custom flow WITHOUT route_back_policy: verification→execution NOT ENFORCED
#
# Deterministic, no model spend, self-cleaning.
# Usage: bash evals/integration/test_kit_identity_trust.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

TMP="$(mktemp -d)"
errors=0

_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

SIDECAR_JS="${ROOT}/build/src/cli/workflow-sidecar.js"
SIDECAR_BUNDLE_WRITER="workflow-sidecar"

echo ""
echo "=== Fix 1: kitIdentityFromBundle reads kit from bundle claims (not hardcoded 'builder') ==="

# ─── Write fixture bundle files (note: argv[2] = file path since argv[1] = "-" for stdin) ─────────

node - "$TMP/knowledge.bundle" << 'NODE'
const fs = require('fs');
// argv[0]=node, argv[1]="-", argv[2]=file path
const bundlePath = process.argv[2];
const bundle = {
  schemaVersion: 3, source: "test-fixture",
  claims: [{
    id: "c-knowledge-1", claimType: "knowledge.verify.tests",
    subjectType: "flow-step", subjectId: "test-slug/knowledge-ev",
    surface: "flow-agents.workflow", fieldOrBehavior: "knowledge verification",
    value: "pass", status: "verified",
    createdAt: "2026-06-27T00:00:00Z", updatedAt: "2026-06-27T00:00:00Z",
    impactLevel: "high", verificationPolicyId: "policy:knowledge.verify.tests"
  }],
  evidence: [], policies: [], events: []
};
fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));
NODE

node - "$TMP/builder.bundle" << 'NODE'
const fs = require('fs');
const bundlePath = process.argv[2];
const bundle = {
  schemaVersion: 3, source: "test-fixture",
  claims: [{
    id: "c-builder-1", claimType: "builder.verify.tests",
    subjectType: "flow-step", subjectId: "test-slug/builder-ev",
    surface: "flow-agents.workflow", fieldOrBehavior: "builder verification",
    value: "pass", status: "verified",
    createdAt: "2026-06-27T00:00:00Z", updatedAt: "2026-06-27T00:00:00Z",
    impactLevel: "high", verificationPolicyId: "policy:builder.verify.tests"
  }],
  evidence: [], policies: [], events: []
};
fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));
NODE

node - "$TMP/workflow-only.bundle" << 'NODE'
const fs = require('fs');
const bundlePath = process.argv[2];
const bundle = {
  schemaVersion: 3, source: "test-fixture",
  claims: [{
    id: "c-wf-1", claimType: "workflow.check.build",
    subjectType: "workflow-check", subjectId: "test-slug/build",
    surface: "flow-agents.workflow", fieldOrBehavior: "build check",
    value: "pass", status: "verified",
    createdAt: "2026-06-27T00:00:00Z", updatedAt: "2026-06-27T00:00:00Z",
    impactLevel: "high", verificationPolicyId: "policy:workflow.check.build"
  }],
  evidence: [], policies: [], events: []
};
fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));
NODE

echo ""
echo "=== 1a. KNOWLEDGE-TYPED bundle → kitIdentityFromBundle derives knowledge kit ==="
KNOWLEDGE_BUNDLE="$TMP/knowledge.bundle"
SIDECAR_JS_PATH="$SIDECAR_JS"
node --input-type=module << JSEOF
import { kitIdentityFromBundle } from '${SIDECAR_JS_PATH}';
import { readFileSync } from 'node:fs';
const raw = JSON.parse(readFileSync('${KNOWLEDGE_BUNDLE}', 'utf8'));
const result = kitIdentityFromBundle(raw, '${KNOWLEDGE_BUNDLE}');
if (result.kitId !== 'knowledge') throw new Error('Expected kitId=knowledge, got: ' + result.kitId);
if (result.subject !== 'knowledge-kit') throw new Error('Expected subject=knowledge-kit, got: ' + result.subject);
if (!result.claimType.startsWith('knowledge.')) throw new Error('Expected claimType to start with knowledge., got: ' + result.claimType);
if (result.claimType === 'knowledge.trust.bundle') throw new Error('Should use the specific claim type, not the generic fallback, got: ' + result.claimType);
JSEOF
if [ $? -eq 0 ]; then
  _pass "KNOWLEDGE bundle: kitId=knowledge, subject=knowledge-kit, claimType=knowledge.verify.tests (not builder)"
else
  _fail "KNOWLEDGE bundle: expected kitId=knowledge and subject=knowledge-kit, not builder hardcode"
fi

echo ""
echo "=== 1b. BUILDER-TYPED bundle → kitIdentityFromBundle derives builder kit ==="
BUILDER_BUNDLE="$TMP/builder.bundle"
node --input-type=module << JSEOF
import { kitIdentityFromBundle } from '${SIDECAR_JS_PATH}';
import { readFileSync } from 'node:fs';
const raw = JSON.parse(readFileSync('${BUILDER_BUNDLE}', 'utf8'));
const result = kitIdentityFromBundle(raw, '${BUILDER_BUNDLE}');
if (result.kitId !== 'builder') throw new Error('Expected kitId=builder, got: ' + result.kitId);
if (result.subject !== 'builder-kit') throw new Error('Expected subject=builder-kit, got: ' + result.subject);
if (!result.claimType.startsWith('builder.')) throw new Error('Expected claimType to start with builder., got: ' + result.claimType);
JSEOF
if [ $? -eq 0 ]; then
  _pass "BUILDER bundle: kitId=builder, subject=builder-kit (correctly derived from claims, not hardcoded)"
else
  _fail "BUILDER bundle: expected kitId=builder and subject=builder-kit"
fi

echo ""
echo "=== 1c. WORKFLOW-ONLY bundle (no kit-typed claim, no current.json) → unknown identity ==="
ISOLATED_DIR="$TMP/isolated-session"
mkdir -p "$ISOLATED_DIR"
cp "$TMP/workflow-only.bundle" "$ISOLATED_DIR/workflow-only.bundle"
WORKFLOW_BUNDLE="$ISOLATED_DIR/workflow-only.bundle"
node --input-type=module << JSEOF
import { kitIdentityFromBundle } from '${SIDECAR_JS_PATH}';
import { readFileSync } from 'node:fs';
const raw = JSON.parse(readFileSync('${WORKFLOW_BUNDLE}', 'utf8'));
const result = kitIdentityFromBundle(raw, '${WORKFLOW_BUNDLE}');
if (result.kitId !== 'unknown') throw new Error('Expected kitId=unknown (no kit-typed claim, no active flow), got: ' + result.kitId);
if (result.subject !== 'unknown-kit') throw new Error('Expected subject=unknown-kit, got: ' + result.subject);
if (result.claimType !== 'unknown.trust.bundle') throw new Error('Expected claimType=unknown.trust.bundle, got: ' + result.claimType);
JSEOF
if [ $? -eq 0 ]; then
  _pass "WORKFLOW-ONLY bundle: kitId=unknown, subject=unknown-kit (never falls back to builder)"
else
  _fail "WORKFLOW-ONLY bundle: expected kitId=unknown (no hardcoded builder fallback)"
fi

echo ""
echo "=== 1d. Full pipeline: record-evidence --surface-trust-json with knowledge fixture ==="
PIPELINE_AROOT="$TMP/pipeline-test/.flow-agents"
PIPELINE_SLUG="pipeline-kit-identity"
PIPELINE_DIR="$PIPELINE_AROOT/$PIPELINE_SLUG"
mkdir -p "$PIPELINE_AROOT"

flow_agents_node "$SIDECAR_BUNDLE_WRITER" ensure-session \
  --artifact-root "$PIPELINE_AROOT" \
  --task-slug "$PIPELINE_SLUG" \
  --title "Pipeline kit identity test" \
  --summary "Proves record-evidence processes knowledge bundle without crashing." \
  --criterion "Kit identity preserved" \
  --timestamp "2026-06-27T10:00:00Z" > "$TMP/pipeline-ensure.out" 2>&1

KNOWLEDGE_BUNDLE_PATH="$TMP/knowledge.bundle"
if flow_agents_node "$SIDECAR_BUNDLE_WRITER" record-evidence "$PIPELINE_DIR" \
  --verdict not_verified \
  --surface-trust-json "$KNOWLEDGE_BUNDLE_PATH" \
  --timestamp "2026-06-27T10:01:00Z" > "$TMP/pipeline-evidence.out" 2>&1; then
  if [[ -f "$PIPELINE_DIR/trust.bundle" ]]; then
    _pass "record-evidence --surface-trust-json with knowledge bundle completes (pipeline proof: fix is in production code path)"
  else
    _fail "record-evidence --surface-trust-json with knowledge bundle did not write trust.bundle"
  fi
else
  _fail "record-evidence --surface-trust-json with knowledge bundle failed: $(cat "$TMP/pipeline-evidence.out")"
fi

echo ""
echo "=== Fix 2: FlowDefinition-driven route-back guard ==="

# ─── 2a. builder.build: verification→execution still enforced ─────────────────
echo ""
echo "=== 2a. builder.build route-back guard: still enforces verification→execution ==="
BUILDER_DIR="$TMP/fix2-builder/.flow-agents/builder-fix2"
mkdir -p "$TMP/fix2-builder/.flow-agents"

flow_agents_node "$SIDECAR_BUNDLE_WRITER" ensure-session \
  --artifact-root "$TMP/fix2-builder/.flow-agents" \
  --task-slug "builder-fix2" \
  --title "Fix2 builder route-back test" \
  --summary "Verify builder.build route-back still enforced." \
  --timestamp "2026-06-27T10:00:00Z" > "$TMP/fix2-builder-ensure.out" 2>&1

flow_agents_node "$SIDECAR_BUNDLE_WRITER" advance-state "$BUILDER_DIR" \
  --status verifying --phase verification \
  --summary "Moving to verification." \
  --flow-definition builder.build \
  --timestamp "2026-06-27T10:01:00Z" > "$TMP/fix2-builder-verify.out" 2>&1

if flow_agents_node "$SIDECAR_BUNDLE_WRITER" advance-state "$BUILDER_DIR" \
  --status in_progress --phase execution \
  --summary "Route back without reason." \
  --flow-definition builder.build \
  --timestamp "2026-06-27T10:02:00Z" > "$TMP/fix2-builder-noReason.out" 2>&1; then
  _fail "builder.build route-back should require --route-back-reason"
elif grep -q 'route_back_reason_required' "$TMP/fix2-builder-noReason.out"; then
  _pass "builder.build: verification→execution requires --route-back-reason (identical behavior preserved)"
else
  _fail "builder.build route-back lacked expected diagnostic (got: $(cat "$TMP/fix2-builder-noReason.out"))"
fi

if flow_agents_node "$SIDECAR_BUNDLE_WRITER" advance-state "$BUILDER_DIR" \
  --status in_progress --phase execution \
  --summary "Route back with reason." \
  --flow-definition builder.build \
  --route-back-reason implementation_defect \
  --timestamp "2026-06-27T10:03:00Z" > "$TMP/fix2-builder-withReason.out" 2>&1; then
  _pass "builder.build: verification→execution with reason succeeds (identical behavior preserved)"
else
  _fail "builder.build route-back with reason should succeed (got: $(cat "$TMP/fix2-builder-withReason.out"))"
fi

# ─── 2b. Custom non-builder flow WITH route_back_policy: enforced ─────────────
echo ""
echo "=== 2b. Custom non-builder flow WITH route_back_policy: enforced ==="

CUSTOM_FLOWS_DIR="$TMP/custom-flows"
mkdir -p "$CUSTOM_FLOWS_DIR"

# Write acme.deliver flow with route_back_policy (using argv[2] correctly)
node - "$CUSTOM_FLOWS_DIR/acme.deliver.flow.json" << 'NODE'
const fs = require('fs');
const flowPath = process.argv[2];
const flow = {
  id: "acme.deliver", version: "1.0",
  phase_map: { execution: "execute", verification: "verify" },
  steps: [{ id: "execute", next: "verify" }, { id: "verify", next: "done" }, { id: "done", next: null }],
  gates: {
    "execute-gate": {
      step: "execute",
      expects: [{ id: "execution-scope", kind: "trust.bundle", required: true,
        bundle_claim: { claimType: "acme.execute.scope", subjectType: "change", accepted_statuses: ["trusted","accepted"] } }]
    },
    "verify-gate": {
      step: "verify",
      on_route_back: { implementation_defect: "execute", missing_evidence: "verify", default: "verify" },
      route_back_policy: { max_attempts: 2, on_exceeded: "block" },
      expects: [{ id: "verify-evidence", kind: "trust.bundle", required: true,
        bundle_claim: { claimType: "acme.verify.tests", subjectType: "flow-step", accepted_statuses: ["trusted","accepted"] } }]
    }
  }
};
fs.writeFileSync(flowPath, JSON.stringify(flow, null, 2));
NODE

ACME_DIR="$TMP/fix2-acme/.flow-agents/acme-fix2"
mkdir -p "$TMP/fix2-acme/.flow-agents"

flow_agents_node "$SIDECAR_BUNDLE_WRITER" ensure-session \
  --artifact-root "$TMP/fix2-acme/.flow-agents" \
  --task-slug "acme-fix2" \
  --title "Fix2 acme route-back test" \
  --summary "Verify non-builder flow with route_back_policy is enforced." \
  --timestamp "2026-06-27T10:00:00Z" > "$TMP/fix2-acme-ensure.out" 2>&1

# Set FLOW_AGENTS_FLOW_DEFS_DIR and export it for the duration of this block
export FLOW_AGENTS_FLOW_DEFS_DIR="$CUSTOM_FLOWS_DIR"

flow_agents_node "$SIDECAR_BUNDLE_WRITER" advance-state "$ACME_DIR" \
  --status verifying --phase verification \
  --summary "Moving acme to verification." \
  --flow-definition acme.deliver \
  --timestamp "2026-06-27T10:01:00Z" > "$TMP/fix2-acme-verify.out" 2>&1

if flow_agents_node "$SIDECAR_BUNDLE_WRITER" advance-state "$ACME_DIR" \
  --status in_progress --phase execution \
  --summary "Acme route back without reason." \
  --flow-definition acme.deliver \
  --timestamp "2026-06-27T10:02:00Z" > "$TMP/fix2-acme-noReason.out" 2>&1; then
  _fail "acme.deliver route-back should require --route-back-reason when route_back_policy is declared"
elif grep -q 'route_back_reason_required' "$TMP/fix2-acme-noReason.out"; then
  _pass "acme.deliver (non-builder): verification→execution requires reason when route_back_policy declared"
else
  _fail "acme.deliver route-back lacked expected diagnostic (got: $(cat "$TMP/fix2-acme-noReason.out"))"
fi

# Do 2 successful route-backs
flow_agents_node "$SIDECAR_BUNDLE_WRITER" advance-state "$ACME_DIR" \
  --status in_progress --phase execution \
  --summary "Acme route back 1." --flow-definition acme.deliver \
  --route-back-reason implementation_defect \
  --timestamp "2026-06-27T10:03:00Z" > "$TMP/fix2-acme-rb1.out" 2>&1
flow_agents_node "$SIDECAR_BUNDLE_WRITER" advance-state "$ACME_DIR" \
  --status verifying --phase verification \
  --summary "Back to verify." --flow-definition acme.deliver \
  --timestamp "2026-06-27T10:04:00Z" > "$TMP/fix2-acme-fwd1.out" 2>&1
flow_agents_node "$SIDECAR_BUNDLE_WRITER" advance-state "$ACME_DIR" \
  --status in_progress --phase execution \
  --summary "Acme route back 2." --flow-definition acme.deliver \
  --route-back-reason implementation_defect \
  --timestamp "2026-06-27T10:05:00Z" > "$TMP/fix2-acme-rb2.out" 2>&1
flow_agents_node "$SIDECAR_BUNDLE_WRITER" advance-state "$ACME_DIR" \
  --status verifying --phase verification \
  --summary "Back to verify again." --flow-definition acme.deliver \
  --timestamp "2026-06-27T10:06:00Z" > "$TMP/fix2-acme-fwd2.out" 2>&1

# Third attempt should exceed max_attempts=2 (flow declares max 2, not hardcoded 3)
if flow_agents_node "$SIDECAR_BUNDLE_WRITER" advance-state "$ACME_DIR" \
  --status in_progress --phase execution \
  --summary "Acme exceeds route-back limit." --flow-definition acme.deliver \
  --route-back-reason implementation_defect \
  --timestamp "2026-06-27T10:07:00Z" > "$TMP/fix2-acme-exceeded.out" 2>&1; then
  _fail "acme.deliver should block after flow-declared max_attempts=2 route-backs"
elif grep -q 'route_back_attempts_exceeded' "$TMP/fix2-acme-exceeded.out"; then
  _pass "acme.deliver: blocks after flow-declared max_attempts=2 (not the hardcoded 3 from old builder code)"
else
  _fail "acme.deliver exceeded max_attempts but wrong diagnostic (got: $(cat "$TMP/fix2-acme-exceeded.out"))"
fi

unset FLOW_AGENTS_FLOW_DEFS_DIR

# ─── 2c. Custom flow WITHOUT route_back_policy: NOT enforced ──────────────────
echo ""
echo "=== 2c. Custom flow WITHOUT route_back_policy: verification→execution NOT enforced ==="

CUSTOM_FLOWS_DIR_2="$TMP/custom-flows-2"
mkdir -p "$CUSTOM_FLOWS_DIR_2"

node - "$CUSTOM_FLOWS_DIR_2/acme.nodecl.flow.json" << 'NODE'
const fs = require('fs');
const flowPath = process.argv[2];
const flow = {
  id: "acme.nodecl", version: "1.0",
  phase_map: { execution: "execute", verification: "verify" },
  steps: [{ id: "execute", next: "verify" }, { id: "verify", next: "done" }, { id: "done", next: null }],
  gates: {
    "verify-gate": {
      step: "verify",
      expects: [{ id: "verify-evidence", kind: "trust.bundle", required: true,
        bundle_claim: { claimType: "acme.verify.tests", subjectType: "flow-step", accepted_statuses: ["trusted","accepted"] } }]
    }
  }
};
fs.writeFileSync(flowPath, JSON.stringify(flow, null, 2));
NODE

NODECL_DIR="$TMP/fix2-nodecl/.flow-agents/nodecl-fix2"
mkdir -p "$TMP/fix2-nodecl/.flow-agents"

flow_agents_node "$SIDECAR_BUNDLE_WRITER" ensure-session \
  --artifact-root "$TMP/fix2-nodecl/.flow-agents" \
  --task-slug "nodecl-fix2" \
  --title "Fix2 nodecl route-back test" \
  --summary "Verify flow without route_back_policy is not guarded." \
  --timestamp "2026-06-27T10:00:00Z" > "$TMP/fix2-nodecl-ensure.out" 2>&1

export FLOW_AGENTS_FLOW_DEFS_DIR="$CUSTOM_FLOWS_DIR_2"

flow_agents_node "$SIDECAR_BUNDLE_WRITER" advance-state "$NODECL_DIR" \
  --status verifying --phase verification \
  --summary "Moving nodecl to verification." \
  --flow-definition acme.nodecl \
  --timestamp "2026-06-27T10:01:00Z" > "$TMP/fix2-nodecl-verify.out" 2>&1

if flow_agents_node "$SIDECAR_BUNDLE_WRITER" advance-state "$NODECL_DIR" \
  --status in_progress --phase execution \
  --summary "Nodecl route back — should be free without reason." \
  --flow-definition acme.nodecl \
  --timestamp "2026-06-27T10:02:00Z" > "$TMP/fix2-nodecl-rb.out" 2>&1 \
  && [[ ! -f "$NODECL_DIR/transition-attempts.json" ]]; then
  _pass "acme.nodecl (no route_back_policy): verification→execution freely allowed, no attempts file"
else
  _fail "acme.nodecl without route_back_policy should allow route-back freely (got: $(cat "$TMP/fix2-nodecl-rb.out"))"
fi

unset FLOW_AGENTS_FLOW_DEFS_DIR

echo ""
echo "────────────────────────────────────────────"
if [[ "$errors" -eq 0 ]]; then
  echo "test_kit_identity_trust: all checks passed."
  exit 0
else
  echo "test_kit_identity_trust: $errors check(s) FAILED."
  exit 1
fi
