#!/usr/bin/env bash
# test_flowdef_session_activation.sh — Integration eval for ADR 0016 Step 1.
#
# Proves that ensure-session --flow-id builder.build activates the FlowDefinition-
# driven path so producers fire, gates enforce on builder.* claims, and advance-state
# correctly sets active_step_id via the phase_map at each phase.
#
# Tests:
#   1. Pre-seeded concrete pull-work evidence lets ensure-session --flow-id
#      builder.build bind the local Work Item and project the canonical Flow.
#   2. advance-state through phases (planning→execution→verification) sets correct
#      active_step_id via phase_map at each transition.
#   3. At the verify step, public workflow evidence for tests-evidence produces
#      builder.verify.tests (status=verified) in the bundle — producer fires.
#   4. A TAMPERED builder.verify.tests bundle at the verify step BLOCKS (exit 2)
#      with the tamper warning naming the declared claimType.
#   5. Fallback: session without --flow-id produces only workflow.* claims (the
#      retained safety net for non-flow sessions).
#
# Deterministic, no model spend, self-cleaning.
# Usage: bash evals/integration/test_flowdef_session_activation.sh

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

WRITER="workflow-sidecar"

# ─── TEST 1: ensure-session --flow-id activates the flow ─────────────────────
echo ""
echo "=== 1. ensure-session --flow-id builder.build activates FlowDefinition-driven path ==="

MAIN_AROOT="$TMP/main-project/.kontourai/flow-agents"
SLUG="activation-test"
SESSION_DIR="$MAIN_AROOT/$SLUG"
mkdir -p "$SESSION_DIR"
git -C "$TMP/main-project" init -q
git -C "$TMP/main-project" config user.email flow-activation@example.invalid
git -C "$TMP/main-project" config user.name "Flow Activation Eval"
printf '.kontourai/\n' > "$TMP/main-project/.gitignore"
git -C "$TMP/main-project" add .gitignore
git -C "$TMP/main-project" commit -qm "seed flow activation fixture"
printf 'Selected Work Item: activation:test\n' > "$SESSION_DIR/$SLUG--pull-work.md"

if FLOW_AGENTS_ACTOR=activation-test-actor node "$ROOT/build/src/cli.js" workflow start \
  --artifact-root "$MAIN_AROOT" \
  --flow builder.build \
  --work-item activation:test \
  --assignment-provider local-file \
  --title "Step 1 activation test" \
  --summary "Test that --flow-id builder.build activates the FlowDefinition-driven path." \
  --criterion "All gates produce declared claims" >/dev/null 2>&1; then
  _pass "ensure-session starts the canonical Builder Flow from a canonical artifact root"
else
  _fail "ensure-session failed to start the canonical Builder Flow"
fi

node -e "
const fs = require('fs');
const c = JSON.parse(fs.readFileSync('$MAIN_AROOT/current.json', 'utf8'));
const flow = JSON.parse(fs.readFileSync('$TMP/main-project/.kontourai/flow/runs/$SLUG/state.json', 'utf8'));
const bundle = JSON.parse(fs.readFileSync('$SESSION_DIR/trust.bundle', 'utf8'));
if (c.active_flow_id !== 'builder.build') throw new Error('expected active_flow_id=builder.build, got ' + c.active_flow_id);
if (c.active_step_id !== 'design-probe') throw new Error('expected active_step_id=design-probe, got ' + c.active_step_id);
if (flow.status !== 'active' || flow.current_step !== 'design-probe') throw new Error('canonical Flow did not advance through trusted selection: ' + JSON.stringify(flow));
if (!(bundle.claims || []).some((claim) => claim.claimType === 'builder.pull-work.selected' && claim.status === 'verified')) throw new Error('missing verified selected-work claim');
console.log('current.json: active_flow_id=' + c.active_flow_id + ' active_step_id=' + c.active_step_id);
" 2>&1 \
  && _pass "ensure-session records trusted selection and projects the canonical Flow run at design-probe" \
  || _fail "ensure-session did not create and project the canonical Flow run"

if node - "$ROOT/kits/builder/kit.json" "$ROOT" <<'NODE'
const fs = require('node:fs');
const kit = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { workflowTriggersFor } = require(`${process.argv[3]}/scripts/hooks/lib/kit-catalog.js`);
const roles = new Map(kit.skill_roles.map((entry) => [entry.skill_id.replace(/^builder\./, ''), entry.role]));
const trigger = kit.workflow_triggers.find((entry) => entry.id === 'builder-build-work');
if (roles.get(trigger.default_skill) !== 'entrypoint') process.exit(1);
if (!trigger.conditional_skills.every((entry) => roles.get(entry.skill) === 'profile')) process.exit(2);
const [rendered] = workflowTriggersFor(process.argv[3], 'implementation-work-detected');
if (!rendered?.steering.includes('activate `tdd-workflow`; otherwise activate `deliver`')) process.exit(5);
if (!rendered.steering.includes('public `flow-agents workflow` interface') || rendered.steering.includes('workflow:sidecar')) process.exit(6);
for (const action of kit.flow_step_actions) {
  if (!action.skills.every((skill) => roles.get(skill) === 'step')) process.exit(3);
}
for (const skill of ['design-probe', 'continue-work', 'gate-review', 'fix-bug']) {
  if (kit.flow_step_actions.some((action) => action.skills.includes(skill))) process.exit(4);
  if (rendered.steering.includes(`activate \`${skill}\``)) process.exit(7);
}
NODE
then
  _pass "runtime steering activates the entrypoint/profile and keeps primitives/extensions outside automatic step actions"
else
  _fail "activation metadata blurred entrypoint, profile, step, primitive, or extension roles"
fi

# ─── TEST 2: advance-state sets active_step_id via phase_map ─────────────────
echo ""
echo "=== 2. advance-state through phases sets active_step_id via phase_map ==="

PHASE_AROOT="$TMP/phase-project/.kontourai/flow-agents"
PHASE_SLUG="phase-map-test"
PHASE_DIR="$PHASE_AROOT/$PHASE_SLUG"
mkdir -p "$PHASE_AROOT"

flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$PHASE_AROOT" \
  --task-slug "$PHASE_SLUG" \
  --title "Phase map test" \
  --summary "Test FlowDefinition phase-map projection without an active Flow run." \
  --timestamp "2026-06-01T00:00:30Z" >/dev/null 2>&1

flow_agents_node "$WRITER" init-plan "$PHASE_DIR/$PHASE_SLUG--deliver.md" \
  --source-request "Test" --summary "Testing" \
  --timestamp "2026-06-01T00:00:30Z" >/dev/null 2>&1

test_phase_step() {
  local phase="$1" expected_step="$2"
  flow_agents_node "$WRITER" advance-state "$PHASE_DIR" \
    --status in_progress --phase "$phase" \
    --summary "Testing phase $phase." \
    --next-action "Continue." \
    --flow-definition builder.build \
    --timestamp "2026-06-01T00:01:00Z" >/dev/null 2>&1
  local actual
  actual=$(node -e "
    const fs = require('fs');
    const c = JSON.parse(fs.readFileSync('$PHASE_AROOT/current.json', 'utf8'));
    console.log(c.active_step_id || '');
  " 2>/dev/null)
  if [ "$actual" = "$expected_step" ]; then
    _pass "advance-state phase=$phase → active_step_id=$expected_step"
  else
    _fail "advance-state phase=$phase → got active_step_id=$actual (expected $expected_step)"
  fi
}

test_phase_step "planning"     "plan"
test_phase_step "execution"    "execute"
test_phase_step "verification" "verify"

node - "$SESSION_DIR" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const dir = process.argv[2];
const slug = path.basename(dir);
fs.writeFileSync(path.join(dir, `${slug}--plan-work.md`), '# Plan\n\n- AC-1: Verify FlowDefinition producer evidence.\n', 'utf8');
fs.writeFileSync(path.join(dir, 'acceptance.json'), JSON.stringify({ schema_version: '1.0', task_slug: slug, criteria: [{ id: 'AC-1', description: 'Verify FlowDefinition producer evidence.', status: 'pending', evidence_refs: [] }], goal_fit: { status: 'pending', summary: 'Fixture has not completed Goal Fit review.' } }, null, 2), 'utf8');
NODE
mkdir -p "$TMP/main-project/checks"
cat > "$TMP/main-project/checks/check-flow-step.test.mjs" <<'JS'
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('the canonical Builder run reached verify', () => {
  const state = JSON.parse(fs.readFileSync('.kontourai/flow-agents/activation-test/state.json', 'utf8'));
  assert.equal(state.flow_run?.current_step, 'verify');
});
JS

record_passing_producer_evidence() {
  local expectation="$1" artifact="$2"
  if FLOW_AGENTS_ACTOR=activation-test-actor node "$ROOT/build/src/cli.js" workflow evidence \
    --session-dir "$SESSION_DIR" \
    --status pass \
    --expectation "$expectation" \
    --summary "Fixture records passing $expectation evidence from its declared durable artifact." \
    --evidence-ref-json "{\"kind\":\"artifact\",\"file\":\"$artifact\",\"summary\":\"Declared durable producer artifact for $expectation.\"}" >/dev/null 2>&1; then
    _pass "public workflow evidence records declared durable producer evidence for $expectation"
  else
    _fail "public workflow evidence did not record declared durable producer evidence for $expectation"
  fi
}

# Satisfy the canonical Flow itself. advance-state above tests phase-map projection;
# these producer claims advance the persisted Flow run to verify.
record_passing_producer_evidence "pickup-probe-readiness" "$SESSION_DIR/$SLUG--pull-work.md"
record_passing_producer_evidence "probe-decisions-or-accepted-gaps" "$SESSION_DIR/$SLUG--pull-work.md"
record_passing_producer_evidence "implementation-plan" "$SESSION_DIR/$SLUG--plan-work.md"
record_passing_producer_evidence "implementation-scope" "$SESSION_DIR/$SLUG--deliver.md"

# ─── TEST 3: clean critique + complete tests evidence at verify ───────────────
echo ""
echo "=== 3. verify step: clean critique and criterion-backed producer evidence ==="

if FLOW_AGENTS_ACTOR=activation-reviewer node "$ROOT/build/src/cli.js" workflow critique \
  --session-dir "$SESSION_DIR" \
  --id "activation-review" \
  --verdict pass \
  --summary "Fixture review found no open findings before verification." \
  --artifact-ref "$SESSION_DIR/$SLUG--deliver.md" \
  --lane-json "{\"id\":\"code-review\",\"status\":\"pass\",\"summary\":\"Reviewed the delivered activation fixture.\",\"evidence_refs\":[{\"kind\":\"artifact\",\"file\":\"$SESSION_DIR/$SLUG--deliver.md\",\"summary\":\"Reviewed delivery artifact.\"}]}" >/dev/null 2>&1; then
  _pass "public workflow critique records a clean review before passing tests-evidence"
else
  _fail "public workflow critique did not record a clean review before tests-evidence"
fi

# A same-reviewer revision must retain its predecessor for chain validation
# while only the current critique participates in the clean-review decision.
printf '\nClarified after the first review revision.\n' >> "$SESSION_DIR/$SLUG--deliver.md"
if FLOW_AGENTS_ACTOR=activation-reviewer node "$ROOT/build/src/cli.js" workflow critique \
  --session-dir "$SESSION_DIR" \
  --id "activation-review" \
  --verdict pass \
  --summary "The fixture reviewer verified the clarified bytes as a new review revision." \
  --artifact-ref "$SESSION_DIR/$SLUG--deliver.md" \
  --lane-json "{\"id\":\"code-review\",\"status\":\"pass\",\"summary\":\"Reviewed the clarified activation fixture.\",\"evidence_refs\":[{\"kind\":\"artifact\",\"file\":\"$SESSION_DIR/$SLUG--deliver.md\",\"summary\":\"Reviewed current delivery artifact.\"}]}" >/dev/null 2>&1; then
  _pass "public workflow critique records a superseding same-reviewer revision"
else
  _fail "public workflow critique did not record the superseding review revision"
fi

TEST_COMMAND="node --test checks/check-flow-step.test.mjs"
CRITERION_JSON="$(node - "$TEST_COMMAND" <<'NODE'
const command = process.argv[2];
process.stdout.write(JSON.stringify({
  id: 'AC-1',
  status: 'pass',
  evidence_refs: [{
    kind: 'command',
    excerpt: command,
    summary: 'Asserts the exact session is at the verify Flow step.',
  }],
}));
NODE
)"
COMMAND_REF="$(node - "$TEST_COMMAND" <<'NODE'
const command = process.argv[2];
process.stdout.write(JSON.stringify({ kind: 'command', excerpt: command, summary: 'Runs the project-local verify-step assertion.' }));
NODE
)"

TEST_EVIDENCE_OUTPUT="$(FLOW_AGENTS_ACTOR=activation-test-actor node "$ROOT/build/src/cli.js" workflow evidence \
  --session-dir "$SESSION_DIR" \
  --status pass \
  --summary "The substantive producer fixture command passed for every declared criterion." \
  --expectation "tests-evidence" \
  --command "$TEST_COMMAND" \
  --criterion-json "$CRITERION_JSON" \
  --evidence-ref-json "$COMMAND_REF" 2>&1)"
if [ "$?" -eq 0 ]; then
  _pass "public workflow evidence records passing criterion-backed tests-evidence at verify"
else
  _fail "public workflow evidence did not record passing criterion-backed tests-evidence: $TEST_EVIDENCE_OUTPUT"
fi

node -e "
const fs = require('fs');
const bundlePath = '$SESSION_DIR/trust.bundle';
if (!fs.existsSync(bundlePath)) throw new Error('trust.bundle not found');
const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
const declared = (bundle.claims || []).find(c => c.metadata?.gate_claim?.expectation_id === 'tests-evidence');
if (!declared) throw new Error('MISSING builder.verify.tests; claims: ' + (bundle.claims||[]).map(c=>c.claimType).join(', '));
if (declared.claimType !== 'builder.verify.tests' || declared.status !== 'verified') throw new Error('expected verified builder.verify.tests, got ' + JSON.stringify({ claimType: declared.claimType, status: declared.status }));
const critiques = (bundle.claims || []).filter(c => c.metadata?.origin === 'critique' && c.value === 'pass' && !c.metadata?.superseded_by);
if (critiques.length !== 1) throw new Error('expected one current clean critique, got ' + critiques.length);
const criterion = (bundle.claims || []).find(c => c.metadata?.origin === 'acceptance' && c.metadata?.criterion?.id === 'AC-1');
if (!criterion || criterion.value !== 'pass' || criterion.status !== 'verified') throw new Error('MISSING verified completed AC-1 criterion');
console.log('builder.verify.tests: subjectType=' + declared.subjectType + ' status=' + declared.status + ' value=' + declared.value + '; current clean critique and AC-1 verified');
" 2>&1 \
  && _pass "bundle advances with a current clean critique plus completed AC-1" \
  || _fail "bundle lacks declared tests evidence, current critique, or completed AC-1"

# ─── TEST 4: tampered bundle at verify step BLOCKS ────────────────────────────
echo ""
echo "=== 4. tamper-blocks: builder.verify.tests — tampered bundle triggers gate exit 2 ==="

TAMPER_DIR="$TMP/tamper-verify"
TAMPER_SLUG="tamper-verify-test"
mkdir -p "$TAMPER_DIR"
printf '# Test repo\n' > "$TAMPER_DIR/AGENTS.md"
mkdir -p "$TAMPER_DIR/.kontourai/flow-agents/$TAMPER_SLUG"
printf 'Selected Work Item: local:%s\n' "$TAMPER_SLUG" > "$TAMPER_DIR/.kontourai/flow-agents/$TAMPER_SLUG/$TAMPER_SLUG--pull-work.md"

flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$TAMPER_DIR/.kontourai/flow-agents" \
  --task-slug "$TAMPER_SLUG" \
  --actor tamper-verify-actor \
  --title "Tamper verify test" \
  --summary "Testing tamper detection at verify step." \
  --flow-id builder.build \
  --timestamp "2026-06-01T02:00:00Z" >/dev/null 2>&1

flow_agents_node "$WRITER" init-plan "$TAMPER_DIR/.kontourai/flow-agents/$TAMPER_SLUG/$TAMPER_SLUG--deliver.md" \
  --source-request "Test" --summary "Tamper test" \
  --timestamp "2026-06-01T02:00:00Z" >/dev/null 2>&1

flow_agents_node "$WRITER" advance-state "$TAMPER_DIR/.kontourai/flow-agents/$TAMPER_SLUG" \
  --status in_progress --phase verification \
  --summary "At verify." --next-action "Continue." \
  --flow-definition builder.build \
  --timestamp "2026-06-01T02:00:30Z" >/dev/null 2>&1

# Write TAMPERED trust.bundle: stored verified, evidence passing=false
python3 - "$TAMPER_DIR/.kontourai/flow-agents/$TAMPER_SLUG/trust.bundle" << 'PY'
import json, sys
bundle = {
    "schemaVersion": 5,
    "source": "flow-agents/workflow-sidecar",
    "claims": [{
        "id": "c1",
        "subjectId": "tamper-verify-test/verify-tests",
        "subjectType": "flow-step",
        "claimType": "builder.verify.tests",
        "fieldOrBehavior": "Tests pass",
        "value": "pass",
        "impactLevel": "high",
        "status": "verified",
        "createdAt": "2026-06-01T02:00:00Z",
        "updatedAt": "2026-06-01T02:00:00Z"
    }],
    "evidence": [{
        "id": "ev1",
        "claimId": "c1",
        "evidenceType": "test_output",
        "method": "validation",
        "sourceRef": "command-log.jsonl",
        "excerptOrSummary": "tests FAILED",
        "observedAt": "2026-06-01T02:00:00Z",
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
        "createdAt": "2026-06-01T02:00:00Z"
    }]
}
json.dump(bundle, open(sys.argv[1], 'w'))
PY

set +e
tamper_out="$(FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip \
    node "$GATE" 2>&1 <<< "{\"hook_event_name\":\"Stop\",\"cwd\":\"$TAMPER_DIR\"}")"
tamper_exit="$?"
set -e

if [ "$tamper_exit" -eq 2 ]; then
  _pass "gate BLOCKS tampered builder.verify.tests bundle (exit 2)"
else
  _fail "gate did NOT block tampered bundle: exit=$tamper_exit"
fi

if echo "$tamper_out" | grep -qE "stored status.*does not match recompute|possible tampered bundle|caught false-completion"; then
  _pass "gate emits tamper warning for builder.verify.tests"
else
  _fail "gate tamper warning missing from output: $tamper_out"
fi

if echo "$tamper_out" | grep -q "builder.verify.tests"; then
  _pass "gate tamper warning names declared claimType builder.verify.tests"
else
  _fail "gate tamper warning does not name builder.verify.tests: $tamper_out"
fi

# ─── TEST 5: Fallback — session without --flow-id (workflow.* only, safety net) ─
echo ""
echo "=== 5. Fallback: session without --flow-id produces only workflow.* claims (safety net intact) ==="

FALLBACK_AROOT="$TMP/fallback-aroot"
FALLBACK_SLUG="fallback-test"
FALLBACK_DIR="$FALLBACK_AROOT/$FALLBACK_SLUG"
mkdir -p "$FALLBACK_AROOT"

flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$FALLBACK_AROOT" \
  --task-slug "$FALLBACK_SLUG" \
  --title "Fallback no-flow test" \
  --summary "No --flow-id: workflow.* fallback is the safety net for non-flow sessions." \
  --timestamp "2026-06-01T10:00:00Z" >/dev/null 2>&1

flow_agents_node "$WRITER" init-plan "$FALLBACK_DIR/$FALLBACK_SLUG--deliver.md" \
  --source-request "Test" --summary "Testing fallback." \
  --timestamp "2026-06-01T10:00:00Z" >/dev/null 2>&1

flow_agents_node "$WRITER" record-evidence "$FALLBACK_DIR" \
  --verdict pass \
  --check-json '{"id":"fallback-check","kind":"test","status":"pass","summary":"Fallback test passes"}' \
  --timestamp "2026-06-01T10:01:00Z" >/dev/null 2>&1

node -e "
const fs = require('fs');
const bundle = JSON.parse(fs.readFileSync('$FALLBACK_DIR/trust.bundle', 'utf8'));
const claims = bundle.claims || [];
const wfClaim = claims.find(c => c.claimType === 'workflow.check.test');
const builderClaims = claims.filter(c => c.claimType.startsWith('builder.'));
if (!wfClaim) throw new Error('MISSING workflow.check.test in fallback session');
if (builderClaims.length > 0) throw new Error('UNEXPECTED builder.* claims in fallback session: ' + builderClaims.map(c=>c.claimType).join(', '));
if (wfClaim.id.endsWith('-legacy')) throw new Error('workflow.check.test should not have -legacy suffix when no flow active');
console.log('fallback: only workflow.check.test present (no builder.* claims, no -legacy suffix)');
" 2>&1 \
  && _pass "fallback (no --flow-id): only workflow.check.test produced, builder.* absent (producers dormant)" \
  || _fail "fallback (no --flow-id): unexpected claims in trust.bundle"

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$errors" -eq 0 ]; then
  echo "test_flowdef_session_activation: all checks passed."
  exit 0
fi
echo "test_flowdef_session_activation: $errors check(s) FAILED."
exit 1
