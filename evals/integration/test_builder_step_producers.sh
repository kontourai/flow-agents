#!/usr/bin/env bash
# test_builder_step_producers.sh — Integration eval for ADR 0016 Abstraction A P-d Increment 2.
#
# Proves for each of the 6 producer-wired gate claims:
#   - record-gate-claim at the correct active step produces the declared claim
#     (correct claimType + subjectType, status=verified in the bundle).
#   - A TAMPERED bundle (stored verified, evidence fail) at that step BLOCKS (exit 2)
#     with the tamper warning naming the declared claimType.
#
# Claims covered:
#   1. builder.pull-work.selected           (step: pull-work,    expectation: selected-work)
#   2. builder.design-probe.pickup-readiness (step: design-probe, expectation: pickup-probe-readiness)
#   3. builder.design-probe.decisions        (step: design-probe, expectation: probe-decisions-or-accepted-gaps)
#   4. builder.pr-open.pull-request          (step: pr-open,      expectation: pull-request-opened)
#   5. builder.learn.decisions               (step: learn,        expectation: decision-evidence)
#   6. builder.learn.evidence                (step: learn,        expectation: learning-evidence)
#
# Flow Definition confirmation:
#   - All 6 claims above are required:true across builder.build and builder.publish-learn.
#   - policy-compliance remains required:false (advisory — no skill producer).
#
# Deterministic, no model spend, self-cleaning.
# Usage: bash evals/integration/test_builder_step_producers.sh

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

# ─── Helper: set active_step_id for a step.
# For steps in the phase_map, use advance-state.
# For design-probe (no phase mapping), mutate only the test fixture's current pointer.
# ──────────────────────────────────────────────────────────────────
set_active_step() {
  local aroot="$1" slug="$2" step="$3"
  case "$step" in
    design-probe)
      # The production entry surface cannot select a later step. This producer-focused
      # fixture sets the pointer directly because design-probe has no legacy phase_map key.
      node - "$aroot" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const files = [path.join(root, 'current.json')];
const actorRoot = path.join(root, 'current');
if (fs.existsSync(actorRoot)) {
  files.push(...fs.readdirSync(actorRoot).filter((name) => name.endsWith('.json')).map((name) => path.join(actorRoot, name)));
}
for (const file of files) {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'));
      current.active_flow_id = 'builder.build';
      current.active_step_id = 'design-probe';
  fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
}
NODE
      ;;
    pull-work)
      flow_agents_node "workflow-sidecar" advance-state "$aroot/$slug" \
        --status in_progress --phase pickup \
        --summary "Testing at $step." --next-action "Record claim." \
        --flow-definition builder.build \
        --timestamp "2026-06-26T00:01:00Z" >/dev/null 2>&1
      ;;
    pr-open)
      flow_agents_node "workflow-sidecar" advance-state "$aroot/$slug" \
        --status in_progress --phase release \
        --summary "Testing at $step." --next-action "Record claim." \
        --flow-definition builder.build \
        --timestamp "2026-06-26T00:01:00Z" >/dev/null 2>&1
      ;;
    learn)
      flow_agents_node "workflow-sidecar" advance-state "$aroot/$slug" \
        --status in_progress --phase learning \
        --summary "Testing at $step." --next-action "Record claim." \
        --flow-definition builder.build \
        --timestamp "2026-06-26T00:01:00Z" >/dev/null 2>&1
      ;;
  esac
}

# ─── Helper: bootstrap a session for produce tests ───────────────────────────
setup_session_for_produce() {
  local aroot="$1" slug="$2" step="$3"
  mkdir -p "$aroot/$slug"
  printf '# Pull Work\n\nSelected Work Item: local:%s\n\nFixture probe decisions are reviewable here.\n' "$slug" > "$aroot/$slug/$slug--pull-work.md"
  printf '{"schema_version":"1.0","task_slug":"%s","decision":"hold"}\n' "$slug" > "$aroot/$slug/release.json"
  printf '{"schema_version":"1.0","task_slug":"%s","status":"learned","records":[]}\n' "$slug" > "$aroot/$slug/learning.json"

  flow_agents_node "workflow-sidecar" ensure-session \
    --artifact-root "$aroot" \
    --task-slug "$slug" \
    --title "Producer test: $step" \
    --summary "Test gate-claim producer at $step." \
    --timestamp "2026-06-26T00:00:00Z" >/dev/null 2>&1

  flow_agents_node "workflow-sidecar" init-plan "$aroot/$slug/$slug--deliver.md" \
    --source-request "Test" --summary "Testing" \
    --timestamp "2026-06-26T00:00:00Z" >/dev/null 2>&1

  set_active_step "$aroot" "$slug" "$step"
}

# ─── Helper: bootstrap a session + AGENTS.md for tamper tests ────────────────
setup_tamper_session() {
  local t_dir="$1" slug="$2" step="$3"
  mkdir -p "$t_dir"
  printf '# Repo\n' > "$t_dir/AGENTS.md"
  mkdir -p "$t_dir/.kontourai/flow-agents/$slug"
  printf '# Pull Work\n\nSelected Work Item: local:%s\n' "$slug" > "$t_dir/.kontourai/flow-agents/$slug/$slug--pull-work.md"

  flow_agents_node "workflow-sidecar" ensure-session \
    --artifact-root "$t_dir/.kontourai/flow-agents" \
    --task-slug "$slug" \
    --title "Tamper test: $step" \
    --summary "Testing tamper detection." \
    --timestamp "2026-06-26T00:00:00Z" >/dev/null 2>&1

  flow_agents_node "workflow-sidecar" init-plan "$t_dir/.kontourai/flow-agents/$slug/$slug--deliver.md" \
    --source-request "Test" --summary "Testing" \
    --timestamp "2026-06-26T00:00:00Z" >/dev/null 2>&1

  set_active_step "$t_dir/.kontourai/flow-agents" "$slug" "$step"
}

# ─── Test: produce a gate claim at a given step ───────────────────────────────
test_produce_claim() {
  local label="$1" step="$2" expectation="$3" expected_claim_type="$4" expected_subject_type="$5"
  echo ""
  echo "=== PRODUCE: $label ==="

  local slug
  slug="$(echo "prod-$step-$expectation" | tr '/' '-' | tr '.' '-')"
  local aroot="$TMP/$slug/.kontourai/flow-agents"
  setup_session_for_produce "$aroot" "$slug" "$step"

  local artifact
  case "$expectation" in
    selected-work|pickup-probe-readiness|probe-decisions-or-accepted-gaps) artifact="$aroot/$slug/$slug--pull-work.md" ;;
    pull-request-opened) artifact="$aroot/$slug/release.json" ;;
    decision-evidence|learning-evidence) artifact="$aroot/$slug/learning.json" ;;
    *) _fail "$label: fixture has no declared producer artifact"; return ;;
  esac

  if flow_agents_node "workflow-sidecar" record-gate-claim "$aroot/$slug" \
    --status pass \
    --summary "Test claim: $label" \
    --expectation "$expectation" \
    --evidence-ref-json "{\"kind\":\"artifact\",\"file\":\"$artifact\",\"summary\":\"Durable producer fixture artifact.\"}" \
    --timestamp "2026-06-26T00:02:00Z" >/dev/null 2>&1; then
    _pass "$label: record-gate-claim exits 0 at $step step"
  else
    _fail "$label: record-gate-claim failed at $step step"
    return
  fi

  node -e "
    const fs = require('fs');
    const bundle = JSON.parse(fs.readFileSync('$aroot/$slug/trust.bundle', 'utf8'));
    const target = (bundle.claims || []).find(c => c.claimType === '$expected_claim_type');
    if (!target) {
      console.error('no $expected_claim_type claim found; claims:', (bundle.claims||[]).map(c=>c.claimType).join(', '));
      process.exit(1);
    }
    if (target.subjectType !== '$expected_subject_type') {
      console.error('expected subjectType=$expected_subject_type, got', target.subjectType);
      process.exit(1);
    }
    if (target.status !== 'verified') {
      console.error('expected status=verified, got', target.status);
      process.exit(1);
    }
    if (typeof target.metadata?.expected_producer !== 'string' || typeof target.metadata?.recorded_by !== 'string') {
      console.error('gate claim must distinguish its expected producer from the actor that recorded it');
      process.exit(1);
    }
  " 2>/dev/null \
    && _pass "$label: bundle contains $expected_claim_type with subjectType=$expected_subject_type, status=verified" \
    || _fail "$label: bundle missing or incorrect $expected_claim_type claim"
}

test_operation_claim_rejection() {
  local label="$1" step="$2" expectation="$3" expected_claim_type="$4"
  echo ""
  echo "=== OPERATION REJECTION: $label ==="

  local slug
  slug="$(echo "operation-$step-$expectation" | tr '/' '-' | tr '.' '-')"
  local aroot="$TMP/$slug/.kontourai/flow-agents"
  setup_session_for_produce "$aroot" "$slug" "$step"
  local artifact="$aroot/$slug/publish-change.result.json"
  printf '{"provider":"fixture","repository":"acme/builder","number":1,"url":"https://example.test/acme/builder/pull/1","head_ref":"fixture","base_ref":"main"}\n' > "$artifact"

  if flow_agents_node "workflow-sidecar" record-gate-claim "$aroot/$slug" \
    --status pass \
    --summary "Locally authored operation result must not self-complete." \
    --expectation "$expectation" \
    --evidence-ref-json "{\"kind\":\"artifact\",\"file\":\"$artifact\",\"summary\":\"Locally authored provider-shaped result.\"}" \
    --timestamp "2026-06-26T00:02:00Z" >/dev/null 2>&1; then
    _fail "$label: record-gate-claim accepted operation self-completion"
  else
    _pass "$label: record-gate-claim rejects operation self-completion"
  fi

  node -e "
    const fs = require('fs');
    const current = JSON.parse(fs.readFileSync('$aroot/current.json', 'utf8'));
    if (current.active_step_id !== '$step') throw new Error('expected active step $step, got ' + current.active_step_id);
    const bundleFile = '$aroot/$slug/trust.bundle';
    const bundle = fs.existsSync(bundleFile) ? JSON.parse(fs.readFileSync(bundleFile, 'utf8')) : { claims: [] };
    if ((bundle.claims || []).some((claim) => claim.claimType === '$expected_claim_type')) throw new Error('operation-bound claim was recorded');
  " 2>/dev/null \
    && _pass "$label: no operation claim is recorded and pr-open remains active" \
    || _fail "$label: operation rejection recorded a claim or changed the active step"
}

# ─── Test: tampered bundle at given step BLOCKS ───────────────────────────────
test_tamper_blocks() {
  local label="$1" step="$2" claim_type="$3" subject_type="$4"
  echo ""
  echo "=== TAMPER-BLOCKS: $label ==="

  local slug
  slug="$(echo "tamper-$step-$claim_type" | tr '.' '-' | tr '/' '-')"
  local t_dir="$TMP/$slug"
  setup_tamper_session "$t_dir" "$slug" "$step"

  # Write a TAMPERED trust.bundle: stored verified, evidence passing=false
  python3 - "$t_dir/.kontourai/flow-agents/$slug/trust.bundle" "$claim_type" "$subject_type" << 'PY'
import json, sys
claim_type = sys.argv[2]
subject_type = sys.argv[3]
bundle = {
    "schemaVersion": 5,
    "source": "flow-agents/workflow-sidecar",
    "claims": [{
        "id": "c1",
        "subjectId": "tamper/gate-claim-test",
        "subjectType": subject_type,
        "claimType": claim_type,
        "fieldOrBehavior": "Gate claim test",
        "value": "pass",
        "impactLevel": "high",
        "status": "verified",
        "createdAt": "2026-06-26T00:00:00Z",
        "updatedAt": "2026-06-26T00:00:00Z"
    }],
    "evidence": [{
        "id": "ev1",
        "claimId": "c1",
        "evidenceType": "test_output",
        "method": "validation",
        "sourceRef": "command-log.jsonl",
        "excerptOrSummary": "gate claim FAILED",
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
  tamper_out="$(FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip \
      node "$GATE" 2>&1 <<< "{\"hook_event_name\":\"Stop\",\"cwd\":\"$t_dir\"}")"
  tamper_exit="$?"
  set -e

  if [ "$tamper_exit" -eq 2 ]; then
    _pass "$label: tampered bundle blocks (exit 2)"
  else
    _fail "$label: tampered bundle did NOT block: exit=$tamper_exit"
  fi

  if echo "$tamper_out" | grep -qE "stored status.*does not match recompute|possible tampered bundle"; then
    _pass "$label: tamper warning emits 'stored status does not match recompute'"
  else
    _fail "$label: tamper warning missing from output: $tamper_out"
  fi

  if echo "$tamper_out" | grep -q "caught false-completion"; then
    _pass "$label: tamper warning emits 'caught false-completion'"
  else
    _fail "$label: tamper warning missing 'caught false-completion': $tamper_out"
  fi

  if echo "$tamper_out" | grep -q "$claim_type"; then
    _pass "$label: tamper warning names declared claimType $claim_type"
  else
    _fail "$label: tamper warning does not name $claim_type: $tamper_out"
  fi
}

# ─── Test 0: Flow Definition required:true confirmation ──────────────────────
echo ""
echo "=== 0. Flow Definitions: confirm required:true for produced gates ==="

node -e "
  const fs = require('fs');
  const flows = [
    JSON.parse(fs.readFileSync('$ROOT/kits/builder/flows/build.flow.json', 'utf8')),
    JSON.parse(fs.readFileSync('$ROOT/kits/builder/flows/publish-learn.flow.json', 'utf8')),
  ];
  const requiredTrue = [
    'selected-work',
    'pickup-probe-readiness',
    'probe-decisions-or-accepted-gaps',
    'pull-request-opened',
    'decision-evidence',
    'learning-evidence',
  ];
  const requiredFalse = ['policy-compliance'];
  let ok = true;
  for (const flow of flows) {
    for (const [gateName, gate] of Object.entries(flow.gates || {})) {
      for (const exp of gate.expects || []) {
      if (requiredTrue.includes(exp.id) && exp.required !== true) {
        console.error('FAIL: ' + exp.id + ' in ' + flow.id + '/' + gateName + ' should be required:true, got ' + exp.required);
        ok = false;
      }
      if (requiredFalse.includes(exp.id) && exp.required !== false) {
        console.error('FAIL: ' + exp.id + ' in ' + flow.id + '/' + gateName + ' should remain required:false (advisory), got ' + exp.required);
        ok = false;
      }
      }
    }
  }
  if (!ok) process.exit(1);
" 2>/dev/null \
  && _pass "Flow Definitions: 6 produced gates are required:true, policy-compliance is required:false" \
  || _fail "Flow Definitions: required flag mismatch"

node -e "
  const fs = require('fs');
  const flows = [
    JSON.parse(fs.readFileSync('$ROOT/kits/builder/flows/build.flow.json', 'utf8')),
    JSON.parse(fs.readFileSync('$ROOT/kits/builder/flows/publish-learn.flow.json', 'utf8')),
  ];
  const producedIds = [
    'selected-work',
    'pickup-probe-readiness',
    'probe-decisions-or-accepted-gaps',
    'pull-request-opened',
    'decision-evidence',
    'learning-evidence',
  ];
  let ok = true;
  for (const flow of flows) {
    for (const [gateName, gate] of Object.entries(flow.gates || {})) {
      for (const exp of gate.expects || []) {
      if (producedIds.includes(exp.id) && exp.explore_hint) {
        console.error('FAIL: ' + exp.id + ' in ' + flow.id + '/' + gateName + ' still has explore_hint (remove when producer exists)');
        ok = false;
      }
      }
    }
  }
  if (!ok) process.exit(1);
" 2>/dev/null \
  && _pass "Flow Definitions: no explore_hint on produced gate entries" \
  || _fail "Flow Definitions: produced gate entries still have explore_hint"

# ─── Tests 1–6: produce + tamper-block for each of the 6 claims ──────────────

# Claim 1: builder.pull-work.selected
test_produce_claim \
  "builder.pull-work.selected" \
  "pull-work" "selected-work" \
  "builder.pull-work.selected" "work-item"
test_tamper_blocks \
  "builder.pull-work.selected" \
  "pull-work" "builder.pull-work.selected" "work-item"

# Claim 2: builder.design-probe.pickup-readiness
test_produce_claim \
  "builder.design-probe.pickup-readiness" \
  "design-probe" "pickup-probe-readiness" \
  "builder.design-probe.pickup-readiness" "work-item"
test_tamper_blocks \
  "builder.design-probe.pickup-readiness" \
  "design-probe" "builder.design-probe.pickup-readiness" "work-item"

# Claim 3: builder.design-probe.decisions
test_produce_claim \
  "builder.design-probe.decisions" \
  "design-probe" "probe-decisions-or-accepted-gaps" \
  "builder.design-probe.decisions" "decision"
test_tamper_blocks \
  "builder.design-probe.decisions" \
  "design-probe" "builder.design-probe.decisions" "decision"

# Claim 4: builder.pr-open.pull-request is external-only and generic claims must reject it.
test_operation_claim_rejection \
  "builder.pr-open.pull-request" \
  "pr-open" "pull-request-opened" \
  "builder.pr-open.pull-request"
test_tamper_blocks \
  "builder.pr-open.pull-request" \
  "pr-open" "builder.pr-open.pull-request" "pull-request"

# Claim 5: builder.learn.decisions
test_produce_claim \
  "builder.learn.decisions" \
  "learn" "decision-evidence" \
  "builder.learn.decisions" "decision"
test_tamper_blocks \
  "builder.learn.decisions" \
  "learn" "builder.learn.decisions" "decision"

# Claim 6: builder.learn.evidence
test_produce_claim \
  "builder.learn.evidence" \
  "learn" "learning-evidence" \
  "builder.learn.evidence" "release"
test_tamper_blocks \
  "builder.learn.evidence" \
  "learn" "builder.learn.evidence" "release"

# ─── Public CLI happy path + route-back ─────────────────────────────────────
echo ""
echo "=== PUBLIC CLI: canonical skill path and external operation boundary ==="
flow_agents_build_ts || _fail "public CLI fixture build failed"
PUBLIC_ROOT="$TMP/public/.kontourai/flow-agents"
PUBLIC_SESSION="$PUBLIC_ROOT/acme-builder-901"
mkdir -p "$TMP/public"
git -C "$TMP/public" init -q
git -C "$TMP/public" config user.email builder-producers@example.invalid
git -C "$TMP/public" config user.name "Builder Producer Eval"
printf '.kontourai/\n' > "$TMP/public/.gitignore"
git -C "$TMP/public" add .gitignore
git -C "$TMP/public" commit -qm "seed public producer fixture"

public_flow() {
  env -u CODEX_THREAD_ID CODEX_SESSION_ID=builder-public-producers node "$ROOT/build/src/cli.js" workflow "$@"
}

public_review() {
  env -u CODEX_THREAD_ID CODEX_SESSION_ID=builder-public-reviewer node "$ROOT/build/src/cli.js" workflow "$@"
}

assert_public_step() {
  local step="$1" skills="$2" operations="$3" status="${4:-active}"
  local report
  report="$(public_flow status --session-dir "$PUBLIC_SESSION" --json 2>/dev/null)" || {
    _fail "public status failed at $step"
    return
  }
  if node - "$report" "$step" "$skills" "$operations" "$status" <<'NODE'
const [reportText, step, skills, operations, status] = process.argv.slice(2);
const report = JSON.parse(reportText);
const statusMatches = status === 'active-or-blocked' ? ['active', 'blocked'].includes(report.status) : report.status === status;
if (report.definition_id !== 'builder.build' || report.current_step !== step || !statusMatches) process.exit(1);
if ((report.next_action?.skills || []).join(',') !== skills) process.exit(2);
if ((report.next_action?.operations || []).join(',') !== operations) process.exit(3);
NODE
  then
    _pass "public run projects $step to ${skills:-no skill}${operations:+ / $operations}"
  else
    _fail "public run projection mismatch at $step: $report"
  fi
}

record_public_expectation() {
  local expectation="$1" status="${2:-pass}"
  local artifact slug
  slug="$(basename "$PUBLIC_SESSION")"
  case "$expectation" in
    shaped-problem|shaped-outcome|shaped-constraints|shaped-non-goals|shaped-success|shaped-risk|open-decisions|slices-defined|work-items-filed) artifact="$PUBLIC_SESSION/$slug--idea-to-backlog.md" ;;
    pickup-probe-readiness|probe-decisions-or-accepted-gaps) artifact="$PUBLIC_SESSION/$slug--pull-work.md" ;;
    implementation-plan) artifact="$PUBLIC_SESSION/$slug--plan-work.md" ;;
    implementation-scope) artifact="$PUBLIC_SESSION/$slug--deliver.md" ;;
    tests-evidence) artifact="$PUBLIC_SESSION/$slug--plan-work.md" ;;
    merge-readiness) artifact="$PUBLIC_SESSION/$slug--evidence-gate.md" ;;
    pull-request-opened|ci-merge-readiness) artifact="$PUBLIC_SESSION/release.json" ;;
    decision-evidence|learning-evidence) artifact="$PUBLIC_SESSION/learning.json" ;;
    *) _fail "public producer fixture has no durable artifact for $expectation"; return ;;
  esac
  local -a args=(evidence --session-dir "$PUBLIC_SESSION" --expectation "$expectation" --status "$status" --summary "public producer fixture records a reviewable durable artifact" --evidence-ref-json "{\"kind\":\"artifact\",\"file\":\"$artifact\",\"summary\":\"Fixture artifact for $expectation.\"}")
  if [ "$expectation" = "tests-evidence" ] && [ "$status" = "fail" ]; then
    args+=(--route-reason implementation_defect)
  fi
  if [ "$expectation" = "tests-evidence" ] && [ "$status" = "pass" ]; then
    local test_command criterion_one criterion_two command_ref
    test_command="bash checks/check-public-session.sh .kontourai/flow-agents/$slug/state.json"
    criterion_one="$(node - "$test_command" <<'NODE'
const command = process.argv[2];
process.stdout.write(JSON.stringify({ id: 'AC-1', status: 'pass', evidence_refs: [{ kind: 'command', excerpt: command, summary: 'Substantive fixture assertion for AC-1.' }] }));
NODE
)"
    criterion_two="$(node - "$test_command" <<'NODE'
const command = process.argv[2];
process.stdout.write(JSON.stringify({ id: 'AC-2', status: 'pass', evidence_refs: [{ kind: 'command', excerpt: command, summary: 'Substantive fixture assertion for AC-2.' }] }));
NODE
)"
    command_ref="$(node - "$test_command" <<'NODE'
const command = process.argv[2];
process.stdout.write(JSON.stringify({ kind: 'command', excerpt: command, summary: 'Exact project-local verification command.' }));
NODE
)"
    args+=(--command "$test_command" --evidence-ref-json "$command_ref" --criterion-json "$criterion_one" --criterion-json "$criterion_two")
  fi
  local output
  if ! output="$(public_flow "${args[@]}" 2>&1)"; then
    _fail "public evidence failed for $expectation: $output"
  fi
}

prepare_public_artifacts() {
node - "$PUBLIC_SESSION" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const session = process.argv[2];
const slug = path.basename(session);
const write = (name, body) => fs.writeFileSync(path.join(session, name), body, 'utf8');
const projectRoot = path.dirname(path.dirname(path.dirname(session)));
const checksDir = path.join(projectRoot, 'checks');
fs.mkdirSync(checksDir, { recursive: true });
const checkScript = path.join(checksDir, 'check-public-session.sh');
fs.writeFileSync(checkScript, '#!/usr/bin/env bash\nset -eu\ntest -f "$1"\nprintf "1..1\\nok 1 - session exists\\n"\n', 'utf8');
fs.chmodSync(checkScript, 0o755);
write(`${slug}--idea-to-backlog.md`, '# Idea To Backlog Report\n\nShaped problem, slices, and filed work are reviewable here.\n');
write(`${slug}--pull-work.md`, '# Pull and Probe Report\n\nSelected work, scope, decisions, and accepted gaps are reviewable here.\n');
write(`${slug}--plan-work.md`, '# Plan\n\n## Definition Of Done\n\n- AC-1: The producer fixture records criterion-backed evidence.\n- AC-2: Every accepted criterion is backed by the exact test command.\n');
write(`${slug}--evidence-gate.md`, '# Evidence Gate\n\nAcceptance coverage and scope-integrity decision.\n');
write('acceptance.json', JSON.stringify({ schema_version: '1.0', task_slug: slug, criteria: [{ id: 'AC-1', description: 'The producer fixture records criterion-backed evidence.', status: 'pending', evidence_refs: [] }, { id: 'AC-2', description: 'Every accepted criterion is backed by the exact test command.', status: 'pending', evidence_refs: [] }], goal_fit: { status: 'pending', summary: 'Fixture has not completed Goal Fit review.' } }, null, 2));
write('handoff.json', JSON.stringify({ schema_version: '1.0', task_slug: slug, summary: 'Fixture execution handoff.', next_steps: ['Execute the reviewed plan.'], blockers: [] }, null, 2));
write('release.json', JSON.stringify({ schema_version: '1.0', task_slug: slug, decision: 'hold', updated_at: '2026-06-26T00:00:00Z', scope: 'producer fixture', evidence_ref: `${slug}--evidence-gate.md`, gates: [{ name: 'merge', status: 'hold', summary: 'Fixture is not authorized to merge.' }], rollback_plan: { status: 'not_required', summary: 'No release.', owner: 'fixture' }, observability_plan: { status: 'not_required', summary: 'No release.' }, post_deploy_checks: [], docs: { status: 'not_needed', summary: 'Fixture.' } }, null, 2));
write('learning.json', JSON.stringify({ schema_version: '1.0', task_slug: slug, status: 'learned', updated_at: '2026-06-26T00:00:00Z', records: [{ id: 'fixture-learning', recorded_at: '2026-06-26T00:00:00Z', source_refs: [`${slug}--evidence-gate.md`], outcome: 'success', facts: ['Fixture created reviewable durable artifacts.'], interpretation: 'No workflow correction is needed.', routing: [{ target: 'none', action: 'No follow-up required.', status: 'completed' }], correction: { needed: false, evidence: 'Fixture contract passes.' } }] }, null, 2));
NODE
}

mkdir -p "$PUBLIC_ROOT"
mkdir -p "$PUBLIC_SESSION"
printf 'Selected Work Item: acme/builder#901\n' > "$PUBLIC_SESSION/acme-builder-901--pull-work.md"
public_flow start --artifact-root "$PUBLIC_ROOT" --flow builder.build \
  --work-item acme/builder#901 --assignment-provider local-file --summary "Public producer path" >/dev/null 2>&1 \
  || _fail "public workflow start failed"
prepare_public_artifacts
assert_public_step "design-probe" "pickup-probe" ""
record_public_expectation "pickup-probe-readiness"
assert_public_step "design-probe" "pickup-probe" "" "active-or-blocked"
record_public_expectation "probe-decisions-or-accepted-gaps"
assert_public_step "plan" "plan-work" ""
record_public_expectation "implementation-plan"
assert_public_step "execute" "execute-plan" ""
record_public_expectation "implementation-scope"
assert_public_step "verify" "review-work,verify-work" ""
if public_review critique --session-dir "$PUBLIC_SESSION" --verdict pass --summary "Missing lanes must fail." --artifact-ref "$PUBLIC_SESSION/$(basename "$PUBLIC_SESSION")--deliver.md" >/dev/null 2>&1; then
  _fail "public critique accepted a passing review without lanes"
else
  _pass "public critique rejects a passing review without lanes"
fi
PUBLIC_CRITIQUE_OUTPUT="$(public_review critique --session-dir "$PUBLIC_SESSION" \
  --verdict pass \
  --summary "Authenticated review found no blocking fixture findings." \
  --artifact-ref "$PUBLIC_SESSION/$(basename "$PUBLIC_SESSION")--deliver.md" \
  --lane-json "{\"id\":\"code-review\",\"status\":\"pass\",\"summary\":\"Public fixture code review completed.\",\"evidence_refs\":[{\"kind\":\"artifact\",\"file\":\"$PUBLIC_SESSION/$(basename "$PUBLIC_SESSION")--deliver.md\",\"summary\":\"Reviewed public fixture delivery artifact.\"}]}" 2>&1)" \
  || _fail "public authenticated critique failed before tests-evidence: $PUBLIC_CRITIQUE_OUTPUT"
PUBLIC_TEST_COMMAND="bash checks/check-public-session.sh .kontourai/flow-agents/$(basename "$PUBLIC_SESSION")/state.json"
if public_flow evidence --session-dir "$PUBLIC_SESSION" --expectation tests-evidence --status pass --command "bash -c true" --summary "Wrapped no-op must not count as tests evidence." \
  --criterion-json '{"id":"AC-1","status":"pass","evidence_refs":[{"kind":"command","excerpt":"bash -c true","summary":"Wrapped no-op."}]}' \
  --criterion-json '{"id":"AC-2","status":"pass","evidence_refs":[{"kind":"command","excerpt":"bash -c true","summary":"Wrapped no-op."}]}' >/dev/null 2>&1; then
  _fail "public tests-evidence accepted a wrapped no-op command"
else
  _pass "public tests-evidence rejects a wrapped no-op command"
fi
if public_flow evidence --session-dir "$PUBLIC_SESSION" --expectation tests-evidence --status pass --command "$PUBLIC_TEST_COMMAND" --summary "External-only criterion evidence must not pass." \
  --criterion-json '{"id":"AC-1","status":"pass","evidence_refs":[{"kind":"external","url":"https://example.invalid/ac-1","summary":"External attestation only."}]}' \
  --criterion-json '{"id":"AC-2","status":"pass","evidence_refs":[{"kind":"external","url":"https://example.invalid/ac-2","summary":"External attestation only."}]}' >/dev/null 2>&1; then
  _fail "public tests-evidence accepted external-only passing criterion evidence"
else
  _pass "public tests-evidence rejects external-only passing criterion evidence"
fi
if public_flow evidence --session-dir "$PUBLIC_SESSION" --expectation tests-evidence --status pass --command "$PUBLIC_TEST_COMMAND" --summary "Every criterion must cite the exact command." \
  --criterion-json "{\"id\":\"AC-1\",\"status\":\"pass\",\"evidence_refs\":[{\"kind\":\"command\",\"excerpt\":\"$PUBLIC_TEST_COMMAND\",\"summary\":\"Exact command for AC-1.\"}]}" \
  --criterion-json '{"id":"AC-2","status":"pass","evidence_refs":[{"kind":"command","excerpt":"bash checks/check-public-session.sh .kontourai/flow-agents/missing/state.json","summary":"Different command for AC-2."}]}' >/dev/null 2>&1; then
  _fail "public tests-evidence accepted a criterion without the exact command"
else
  _pass "public tests-evidence requires the exact command for every criterion"
fi
record_public_expectation "tests-evidence"
if node - "$PUBLIC_SESSION/trust.bundle" <<'NODE'
const fs = require('node:fs');
const bundle = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const verified = (claimType, subjectType) => bundle.claims.some((claim) => (
  claim.claimType === claimType
  && claim.subjectType === subjectType
  && claim.status === 'verified'
));
if (!verified('workflow.critique.review', 'workflow-critique')) process.exit(1);
if (!verified('workflow.acceptance.criterion', 'flow-step')) process.exit(2);
if (!verified('builder.verify.tests', 'flow-step')) process.exit(3);
NODE
then
  _pass "public verify gate is backed by current critique, criterion, and test claims"
else
  _fail "public verify gate is missing one or more declared trust-bundle claims"
fi
assert_public_step "merge-ready" "evidence-gate" ""
record_public_expectation "merge-readiness"
assert_public_step "pr-open" "" "publish-change" "active-or-blocked"
PUBLIC_PR_OPEN_REPORT="$(public_flow status --session-dir "$PUBLIC_SESSION" --json 2>/dev/null)"
if node - "$PUBLIC_PR_OPEN_REPORT" <<'NODE'
const report = JSON.parse(process.argv[2]);
const capability = report.next_action?.external_capability;
if (report.current_step !== 'pr-open' || report.next_action?.status !== 'blocked') process.exit(1);
if (capability?.operation !== 'publish-change' || capability?.completion !== 'external_verification_required') process.exit(2);
NODE
then
  _pass "pr-open projects the external publish-change capability block"
else
  _fail "pr-open did not expose the required external capability block: $PUBLIC_PR_OPEN_REPORT"
fi
node - "$PUBLIC_SESSION/publish-change.result.json" <<'NODE'
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], JSON.stringify({ provider: 'fixture', repository: 'acme/builder', number: 901, url: 'https://example.test/acme/builder/pull/901', head_ref: 'fixture', base_ref: 'main' }));
NODE
if public_flow evidence --session-dir "$PUBLIC_SESSION" --expectation pull-request-opened --status pass --summary "Locally authored result must not self-complete publish-change." --evidence-ref-json "{\"kind\":\"artifact\",\"file\":\".kontourai/flow-agents/$(basename "$PUBLIC_SESSION")/publish-change.result.json\",\"summary\":\"Locally authored provider-shaped result.\"}" >/dev/null 2>&1; then
  _fail "generic workflow evidence accepted operation self-completion"
else
  _pass "generic workflow evidence rejects operation self-completion"
fi
assert_public_step "pr-open" "" "publish-change" "active-or-blocked"

echo ""
echo "=== PUBLIC CLI: failed verify route-back remains canonical ==="
ROUTE_SESSION="$PUBLIC_ROOT/acme-builder-902"
PUBLIC_SESSION="$ROUTE_SESSION"
mkdir -p "$ROUTE_SESSION"
printf 'Selected Work Item: acme/builder#902\n' > "$ROUTE_SESSION/acme-builder-902--pull-work.md"
public_flow start --artifact-root "$PUBLIC_ROOT" --flow builder.build \
  --work-item acme/builder#902 --assignment-provider local-file --summary "Public route-back path" >/dev/null 2>&1 \
  || _fail "route-back workflow start failed"
prepare_public_artifacts
for expectation in pickup-probe-readiness probe-decisions-or-accepted-gaps implementation-plan implementation-scope; do
  record_public_expectation "$expectation"
done
ROUTE_CRITIQUE_OUTPUT="$(public_review critique --session-dir "$PUBLIC_SESSION" \
  --verdict pass \
  --summary "Authenticated review completed before failed verification evidence." \
  --artifact-ref "$PUBLIC_SESSION/$(basename "$PUBLIC_SESSION")--deliver.md" \
  --lane-json "{\"id\":\"code-review\",\"status\":\"pass\",\"summary\":\"Public fixture code review completed.\",\"evidence_refs\":[{\"kind\":\"artifact\",\"file\":\"$PUBLIC_SESSION/$(basename "$PUBLIC_SESSION")--deliver.md\",\"summary\":\"Reviewed public fixture delivery artifact.\"}]}" 2>&1)" \
  || _fail "public authenticated critique failed before failed tests-evidence: $ROUTE_CRITIQUE_OUTPUT"
# Seed current verified acceptance prerequisites through the private producer
# without synchronizing Flow. The subsequent public failed tests claim replaces
# the provisional passing tests check, preserves these criteria + the clean
# critique, and is the only attachment/evaluation for this gate visit.
ROUTE_TEST_COMMAND="bash checks/check-public-session.sh .kontourai/flow-agents/$(basename "$PUBLIC_SESSION")/state.json"
ROUTE_COMMAND_REF="$(node - "$ROUTE_TEST_COMMAND" <<'NODE'
const command = process.argv[2];
process.stdout.write(JSON.stringify({ kind: 'command', excerpt: command, summary: 'Current route-back prerequisite command.' }));
NODE
)"
ROUTE_CRITERION_ONE="$(node - "$ROUTE_TEST_COMMAND" <<'NODE'
const command = process.argv[2];
process.stdout.write(JSON.stringify({ id: 'AC-1', status: 'pass', evidence_refs: [{ kind: 'command', excerpt: command, summary: 'Current AC-1 prerequisite.' }] }));
NODE
)"
ROUTE_CRITERION_TWO="$(node - "$ROUTE_TEST_COMMAND" <<'NODE'
const command = process.argv[2];
process.stdout.write(JSON.stringify({ id: 'AC-2', status: 'pass', evidence_refs: [{ kind: 'command', excerpt: command, summary: 'Current AC-2 prerequisite.' }] }));
NODE
)"
ROUTE_OBSERVED="$(node - "$ROUTE_TEST_COMMAND" <<'NODE'
const command = process.argv[2];
process.stdout.write(JSON.stringify({ command, exit_code: 0, test_count: 1, output_sha256: '0'.repeat(64) }));
NODE
)"
CODEX_SESSION_ID=builder-public-producers flow_agents_node "workflow-sidecar" record-gate-claim "$PUBLIC_SESSION" \
  --expectation tests-evidence --status pass --summary "Seed complete current acceptance prerequisites before routed failure." \
  --command "$ROUTE_TEST_COMMAND" --observed-command-json "$ROUTE_OBSERVED" \
  --evidence-ref-json "$ROUTE_COMMAND_REF" --criterion-json "$ROUTE_CRITERION_ONE" --criterion-json "$ROUTE_CRITERION_TWO" >/dev/null 2>&1 \
  || _fail "failed to seed current acceptance prerequisites for routed failure"
record_public_expectation "tests-evidence" "fail"
ROUTE_REPORT="$(public_flow status --session-dir "$PUBLIC_SESSION" --json 2>/dev/null)"
if node - "$ROUTE_REPORT" <<'NODE'
const report = JSON.parse(process.argv[2]);
if (report.current_step !== 'execute') process.exit(1);
if ((report.next_action?.skills || []).join(',') !== 'execute-plan') process.exit(2);
if (!/attempt 1\/3 returned to `execute` for `implementation_defect`/.test(report.next_action?.summary || '')) process.exit(3);
NODE
then
  _pass "complete failed verify evidence routes back through Flow once to execute for implementation_defect"
else
  _fail "public failed-verify route-back was not projected correctly: $ROUTE_REPORT"
fi

echo ""
echo "=== PUBLIC CLI: complete builder.shape path when supported ==="
SHAPE_SESSION="$PUBLIC_ROOT/builder-shape-903"
PUBLIC_SESSION="$SHAPE_SESSION"
SHAPE_START_OUTPUT="$(public_flow start --artifact-root "$PUBLIC_ROOT" --flow builder.shape \
  --task-slug builder-shape-903 --summary "Shape public producer path" 2>&1)"
if [ "$?" -ne 0 ]; then
  if printf '%s' "$SHAPE_START_OUTPUT" | rg -q 'supports only|unsupported.*builder\.shape|Unknown workflow'; then
    _pass "public builder.shape path is deferred until the installed runtime exposes it"
  else
    _fail "public builder.shape start failed unexpectedly: $SHAPE_START_OUTPUT"
  fi
else
  assert_public_shape_step() {
    local step="$1" skills="$2" status="${3:-active}"
    local report
    report="$(public_flow status --session-dir "$SHAPE_SESSION" --json 2>/dev/null)" || {
      _fail "public shape status failed at $step"
      return
    }
    if node - "$report" "$step" "$skills" "$status" <<'NODE'
const [reportText, step, skills, status] = process.argv.slice(2);
const report = JSON.parse(reportText);
const statusMatches = status === 'active-or-completed'
  ? ['active', 'completed'].includes(report.status)
  : status === 'active-or-blocked'
    ? ['active', 'blocked'].includes(report.status)
    : report.status === status;
if (report.definition_id !== 'builder.shape' || report.current_step !== step || !statusMatches) process.exit(1);
if ((report.next_action?.skills || []).join(',') !== skills) process.exit(2);
NODE
    then
      _pass "public shape run projects $step to ${skills:-no skill}"
    else
      _fail "public shape projection mismatch at $step: $report"
    fi
  }

  prepare_public_artifacts
  assert_public_shape_step "shape" "idea-to-backlog" "active-or-blocked"
  for expectation in shaped-problem shaped-outcome shaped-constraints shaped-non-goals shaped-success shaped-risk; do
    record_public_expectation "$expectation"
  done
  assert_public_shape_step "breakdown" "idea-to-backlog"
  record_public_expectation "slices-defined"
  assert_public_shape_step "file-issues" "idea-to-backlog"
  record_public_expectation "work-items-filed"
  assert_public_shape_step "shape-done" "" "active-or-completed"
fi

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$errors" -eq 0 ]; then
  echo "Builder step producer tests passed (legacy tamper checks plus full public happy path and route-back)."
  exit 0
fi
echo "Builder step producer tests FAILED: $errors issue(s)."
exit 1
