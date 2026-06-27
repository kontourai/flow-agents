#!/usr/bin/env bash
# test_flowdef_session_history_preservation.sh — Integration eval for ADR 0016 Step 0.
#
# Proves:
#   1. A FlowDefinition-driven session (ensure-session --flow-id builder.build, step=verify)
#      records a check via the declared builder.verify.tests path, then record-critique and
#      record-learning PRESERVE the prior declared check + critique claims in the rebuilt
#      bundle (no history loss).
#   2. A workflow.* session (no --flow-id) record-critique/record-learning round-trip is
#      UNCHANGED — only workflow.check.* and workflow.critique.review claims survive.
#   3. evidenceClean/critiqueClean return correct results for a builder.* bundle:
#      checked by running dogfood-pass --verdict pass on a clean builder.build session.
#
# Deterministic, no model spend, self-cleaning.
# Usage: bash evals/integration/test_flowdef_session_history_preservation.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

TMP="$(mktemp -d)"
errors=0

_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

WRITER="workflow-sidecar"

# ─── TEST 1: FlowDefinition-driven session round-trip (no history loss) ────────
echo ""
echo "=== 1. FlowDefinition-driven session: record-critique/record-learning preserve declared claims ==="

FLOW_AROOT="$TMP/flow-aroot"
SLUG="history-flow-test"
SESSION_DIR="$FLOW_AROOT/$SLUG"
mkdir -p "$FLOW_AROOT"

# Create a FlowDefinition-driven session at the verify step (builder.verify.tests is declared)
flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$FLOW_AROOT" \
  --task-slug "$SLUG" \
  --title "History preservation test" \
  --summary "Test that declared builder.* claims survive round-trips." \
  --flow-id builder.build \
  --step-id verify \
  --timestamp "2026-06-01T00:00:00Z" >/dev/null 2>&1

flow_agents_node "$WRITER" init-plan "$SESSION_DIR/$SLUG--deliver.md" \
  --source-request "Test" --summary "Testing" \
  --timestamp "2026-06-01T00:00:00Z" >/dev/null 2>&1

# Record a passing check (produces builder.verify.tests declared claim + legacy shadow)
flow_agents_node "$WRITER" record-evidence "$SESSION_DIR" \
  --verdict pass \
  --check-json '{"id":"unit-tests","kind":"test","status":"pass","summary":"Unit tests pass"}' \
  --timestamp "2026-06-01T00:01:00Z" >/dev/null 2>&1

# Verify declared claim is in bundle before round-trip
node -e "
const fs = require('fs');
const bundle = JSON.parse(fs.readFileSync('$SESSION_DIR/trust.bundle', 'utf8'));
const declared = (bundle.claims || []).find(c => c.claimType === 'builder.verify.tests');
if (!declared) throw new Error('MISSING builder.verify.tests before round-trip; claims: ' + (bundle.claims||[]).map(c=>c.claimType).join(', '));
console.log('before round-trip: builder.verify.tests status=' + declared.status);
" 2>&1 \
  && _pass "builder.verify.tests declared claim present before round-trip" \
  || _fail "builder.verify.tests declared claim MISSING before round-trip"

# Now do record-critique (the round-trip: checksFromBundle + critiquesFromBundle rebuild)
flow_agents_node "$WRITER" record-critique "$SESSION_DIR" \
  --id "code-review" \
  --verdict pass \
  --summary "Code review passed." \
  --timestamp "2026-06-01T00:02:00Z" >/dev/null 2>&1

# Assert builder.verify.tests survived the record-critique round-trip
node -e "
const fs = require('fs');
const bundle = JSON.parse(fs.readFileSync('$SESSION_DIR/trust.bundle', 'utf8'));
const declared = (bundle.claims || []).find(c => c.claimType === 'builder.verify.tests');
if (!declared) throw new Error('HISTORY LOSS: builder.verify.tests MISSING after record-critique; claims: ' + (bundle.claims||[]).map(c=>c.claimType).join(', '));
console.log('after record-critique: builder.verify.tests status=' + declared.status);
" 2>&1 \
  && _pass "builder.verify.tests declared claim preserved after record-critique (no history loss)" \
  || _fail "builder.verify.tests declared claim LOST after record-critique (history loss)"

# Also verify the critique claim itself is present
node -e "
const fs = require('fs');
const bundle = JSON.parse(fs.readFileSync('$SESSION_DIR/trust.bundle', 'utf8'));
const crit = (bundle.claims || []).find(c => c.claimType === 'workflow.critique.review');
if (!crit) throw new Error('MISSING workflow.critique.review after record-critique');
console.log('critique claim: claimType=' + crit.claimType + ' value=' + crit.value);
" 2>&1 \
  && _pass "workflow.critique.review claim present after record-critique" \
  || _fail "workflow.critique.review claim MISSING after record-critique"

# Now do record-learning (second round-trip)
flow_agents_node "$WRITER" record-learning "$SESSION_DIR" \
  --status learned \
  --record-json '{
    "outcome": "success",
    "source_refs": [],
    "facts": ["Tests passed clean."],
    "routing": [{"target":"none","status":"completed","summary":"No routing needed."}],
    "correction": {"needed": false, "evidence": "All checks passed cleanly."}
  }' \
  --summary "Learning recorded." \
  --timestamp "2026-06-01T00:03:00Z" >/dev/null 2>&1

# Assert builder.verify.tests survived the record-learning round-trip
node -e "
const fs = require('fs');
const bundle = JSON.parse(fs.readFileSync('$SESSION_DIR/trust.bundle', 'utf8'));
const declared = (bundle.claims || []).find(c => c.claimType === 'builder.verify.tests');
if (!declared) throw new Error('HISTORY LOSS: builder.verify.tests MISSING after record-learning; claims: ' + (bundle.claims||[]).map(c=>c.claimType).join(', '));
console.log('after record-learning: builder.verify.tests status=' + declared.status);
" 2>&1 \
  && _pass "builder.verify.tests declared claim preserved after record-learning (no history loss)" \
  || _fail "builder.verify.tests declared claim LOST after record-learning (history loss)"

# ─── TEST 2: workflow.* session round-trip is UNCHANGED ────────────────────────
echo ""
echo "=== 2. workflow.* session (no --flow-id): round-trip unchanged ==="

NOFLOW_AROOT="$TMP/noflow-aroot"
NOFLOW_SLUG="history-noflow-test"
NOFLOW_DIR="$NOFLOW_AROOT/$NOFLOW_SLUG"
mkdir -p "$NOFLOW_AROOT"

flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$NOFLOW_AROOT" \
  --task-slug "$NOFLOW_SLUG" \
  --title "No-flow session history test" \
  --summary "Baseline: no FlowDefinition. Round-trip must be unchanged." \
  --timestamp "2026-06-01T10:00:00Z" >/dev/null 2>&1

flow_agents_node "$WRITER" init-plan "$NOFLOW_DIR/$NOFLOW_SLUG--deliver.md" \
  --source-request "Test" --summary "Testing" \
  --timestamp "2026-06-01T10:00:00Z" >/dev/null 2>&1

# Record a check (produces only workflow.check.test — no declared claims)
flow_agents_node "$WRITER" record-evidence "$NOFLOW_DIR" \
  --verdict pass \
  --check-json '{"id":"noflow-unit-tests","kind":"test","status":"pass","summary":"No-flow tests pass"}' \
  --timestamp "2026-06-01T10:01:00Z" >/dev/null 2>&1

# record-critique round-trip
flow_agents_node "$WRITER" record-critique "$NOFLOW_DIR" \
  --id "noflow-review" \
  --verdict pass \
  --summary "Review passed." \
  --timestamp "2026-06-01T10:02:00Z" >/dev/null 2>&1

# Assert only workflow.* claims survived (no builder.* contamination)
node -e "
const fs = require('fs');
const bundle = JSON.parse(fs.readFileSync('$NOFLOW_DIR/trust.bundle', 'utf8'));
const claims = bundle.claims || [];
const wfCheck = claims.find(c => c.claimType === 'workflow.check.test');
const wfCritique = claims.find(c => c.claimType === 'workflow.critique.review');
const builderClaims = claims.filter(c => c.claimType.startsWith('builder.'));
if (!wfCheck) throw new Error('MISSING workflow.check.test after record-critique');
if (!wfCritique) throw new Error('MISSING workflow.critique.review after record-critique');
if (builderClaims.length > 0) throw new Error('UNEXPECTED builder.* claims in no-flow session after round-trip: ' + builderClaims.map(c=>c.claimType).join(', '));
console.log('after record-critique: workflow.check.test + workflow.critique.review, no builder.*');
" 2>&1 \
  && _pass "no-flow session: workflow.* only after record-critique round-trip (unchanged)" \
  || _fail "no-flow session: unexpected claims after record-critique round-trip"

# ─── TEST 3: evidenceClean/critiqueClean correct for builder.* bundle ──────────
echo ""
echo "=== 3. evidenceClean/critiqueClean correct for builder.* bundle ==="

# Create a fresh builder.build session at verify step for dogfood-pass test
DOGFOOD_AROOT="$TMP/dogfood-aroot"
DOGFOOD_SLUG="dogfood-clean-test"
DOGFOOD_DIR="$DOGFOOD_AROOT/$DOGFOOD_SLUG"
mkdir -p "$DOGFOOD_AROOT"

flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$DOGFOOD_AROOT" \
  --task-slug "$DOGFOOD_SLUG" \
  --title "Dogfood clean test" \
  --summary "Test evidenceClean/critiqueClean on builder.build session." \
  --flow-id builder.build \
  --step-id verify \
  --timestamp "2026-06-01T20:00:00Z" >/dev/null 2>&1

flow_agents_node "$WRITER" init-plan "$DOGFOOD_DIR/$DOGFOOD_SLUG--deliver.md" \
  --source-request "Test" --summary "Testing" \
  --timestamp "2026-06-01T20:00:00Z" >/dev/null 2>&1

# Record pass evidence (produces builder.verify.tests declared claim, status=verified)
flow_agents_node "$WRITER" record-evidence "$DOGFOOD_DIR" \
  --verdict pass \
  --check-json '{"id":"ev-check","kind":"test","status":"pass","summary":"Evidence check passes"}' \
  --timestamp "2026-06-01T20:01:00Z" >/dev/null 2>&1

# Record pass critique
flow_agents_node "$WRITER" record-critique "$DOGFOOD_DIR" \
  --id "ev-critique" \
  --verdict pass \
  --summary "Critique passed." \
  --timestamp "2026-06-01T20:02:00Z" >/dev/null 2>&1

# dogfood-pass --verdict pass should succeed: evidenceClean=true (builder.verify.tests passes)
# and critiqueClean=true (workflow.critique.review passes).
flow_agents_node "$WRITER" dogfood-pass \
  --artifact-root "$DOGFOOD_AROOT" \
  --artifact-dir "$DOGFOOD_DIR" \
  --verdict pass \
  --check-json '{"id":"dogfood-ev-check","kind":"test","status":"pass","summary":"Dogfood evidence check"}' \
  --summary "Dogfood pass for builder.build session." \
  --timestamp "2026-06-01T20:03:00Z" >/dev/null 2>&1 \
  && _pass "dogfood-pass succeeds: evidenceClean returns true for builder.verify.tests declared claim" \
  || _fail "dogfood-pass FAILED: evidenceClean did not recognize builder.verify.tests as passing evidence"

# Verify directly that the bundle has builder.verify.tests as the evidence claim
node -e "
const fs = require('fs');
const bundle = JSON.parse(fs.readFileSync('$DOGFOOD_DIR/trust.bundle', 'utf8'));
const claims = bundle.claims || [];
const builderCheck = claims.find(c => c.claimType === 'builder.verify.tests' && c.value === 'pass');
if (!builderCheck) throw new Error('MISSING builder.verify.tests (pass) in bundle; claims: ' + claims.map(c=>c.claimType+'='+c.value).join(', '));
console.log('builder.verify.tests evidence claim present with value=pass, status=' + builderCheck.status);
" 2>&1 \
  && _pass "bundle contains builder.verify.tests with value=pass (declared claim recognized by evidenceClean)" \
  || _fail "bundle missing builder.verify.tests with value=pass"

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$errors" -eq 0 ]; then
  echo "test_flowdef_session_history_preservation: all checks passed."
  exit 0
fi
echo "test_flowdef_session_history_preservation: $errors check(s) FAILED."
exit 1
