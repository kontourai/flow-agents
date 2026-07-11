#!/usr/bin/env bash
# Proves first-step workflow entry and provider-neutral local work-item anchoring (#438).

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

TMP="$(mktemp -d)"
errors=0
trap 'rm -rf "$TMP"' EXIT

pass() { printf '  PASS %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; errors=$((errors + 1)); }

WRITER="workflow-sidecar"

echo "=== Builder workflow entry enforcement ==="

NONCANONICAL_ROOT="$TMP/noncanonical-root"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$NONCANONICAL_ROOT" \
  --task-slug noncanonical \
  --title "Noncanonical root" \
  --summary "Builder state must use the product artifact root." \
  --flow-id builder.build >"$TMP/noncanonical.out" 2>&1; then
  fail "noncanonical Builder artifact root should be rejected"
elif [[ ! -e "$NONCANONICAL_ROOT" ]] \
  && grep -q 'requires --artifact-root <project>/.kontourai/flow-agents' "$TMP/noncanonical.out"; then
  pass "noncanonical Builder artifact root is rejected before any sidecar write"
else
  fail "noncanonical Builder root left partial state or the wrong diagnostic: $(cat "$TMP/noncanonical.out")"
fi

SYMLINK_PROJECT="$TMP/symlink-project"
SYMLINK_EXTERNAL="$TMP/symlink-external"
mkdir -p "$SYMLINK_PROJECT/.kontourai" "$SYMLINK_EXTERNAL"
ln -s "$SYMLINK_EXTERNAL" "$SYMLINK_PROJECT/.kontourai/flow-agents"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$SYMLINK_PROJECT/.kontourai/flow-agents" \
  --task-slug symlink-root \
  --title "Symlink root" \
  --summary "Builder state must not escape the project." \
  --flow-id builder.build >"$TMP/symlink-root.out" 2>&1; then
  fail "symlinked Builder artifact root should be rejected"
elif [[ -z "$(find "$SYMLINK_EXTERNAL" -mindepth 1 -print -quit)" ]] \
  && grep -q 'requires a non-symlink Flow Agents artifact root' "$TMP/symlink-root.out"; then
  pass "symlinked Builder artifact root is rejected before any external write"
else
  fail "symlinked Builder root wrote externally or returned the wrong diagnostic: $(cat "$TMP/symlink-root.out")"
fi

SESSION_SYMLINK_PROJECT="$TMP/session-symlink-project"
SESSION_SYMLINK_ROOT="$SESSION_SYMLINK_PROJECT/.kontourai/flow-agents"
SESSION_SYMLINK_EXTERNAL="$TMP/session-symlink-external"
mkdir -p "$SESSION_SYMLINK_ROOT" "$SESSION_SYMLINK_EXTERNAL"
ln -s "$SESSION_SYMLINK_EXTERNAL" "$SESSION_SYMLINK_ROOT/session-symlink"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$SESSION_SYMLINK_ROOT" \
  --task-slug session-symlink \
  --actor builder-entry-session-symlink \
  --title "Session symlink" \
  --summary "Session state must not escape the artifact root." \
  --flow-id builder.build >"$TMP/session-symlink.out" 2>&1; then
  fail "symlinked session directory should be rejected"
elif [[ -z "$(find "$SESSION_SYMLINK_EXTERNAL" -mindepth 1 -print -quit)" ]] \
  && grep -q 'session directory must be a real directory under the artifact root' "$TMP/session-symlink.out"; then
  pass "symlinked session directory is rejected before external reads or writes"
else
  fail "symlinked session directory escaped or returned the wrong diagnostic: $(cat "$TMP/session-symlink.out")"
fi

NESTED_PROJECT="$TMP/nested-symlink-project"
NESTED_ROOT="$NESTED_PROJECT/.kontourai/flow-agents"
NESTED_EXTERNAL="$TMP/nested-symlink-external.json"
mkdir -p "$NESTED_ROOT/assignment"
printf 'external must survive\n' >"$NESTED_EXTERNAL"
ln -s "$NESTED_EXTERNAL" "$NESTED_ROOT/assignment/nested-symlink.json"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$NESTED_ROOT" \
  --task-slug nested-symlink \
  --actor builder-entry-nested-symlink \
  --title "Nested assignment symlink" \
  --summary "Assignment evidence must stay inside the product root." \
  --flow-id builder.build >"$TMP/nested-symlink.out" 2>&1; then
  fail "symlinked assignment record should be rejected"
elif [[ "$(cat "$NESTED_EXTERNAL")" == "external must survive" ]] \
  && [[ ! -e "$NESTED_ROOT/nested-symlink" ]] \
  && grep -q 'assignment record must be a regular file, not a symlink' "$TMP/nested-symlink.out"; then
  pass "nested assignment symlink is rejected before external write or trust evidence"
else
  fail "nested assignment symlink escaped or returned the wrong diagnostic: $(cat "$TMP/nested-symlink.out")"
fi

RACE_PROJECT="$TMP/race-project"
RACE_ROOT="$RACE_PROJECT/.kontourai/flow-agents"
RACE_MOVED="$RACE_PROJECT/.kontourai/flow-agents-acquired"
RACE_EXTERNAL="$TMP/race-external"
mkdir -p "$RACE_ROOT" "$RACE_EXTERNAL"
FLOW_AGENTS_WORKFLOW_SIDECAR_LOCK_DELAY=1 flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$RACE_ROOT" \
  --task-slug lock-swap \
  --title "Lock swap" \
  --summary "Lock cleanup must remain on the acquired root." \
  --flow-id builder.build >"$TMP/lock-swap.out" 2>&1 &
RACE_PID=$!
node - "$RACE_ROOT/.workflow-sidecar.lockdir" <<'NODE'
const fs = require('node:fs');
const lock = process.argv[2];
const deadline = Date.now() + 5000;
(function wait() {
  if (fs.existsSync(lock)) process.exit(0);
  if (Date.now() > deadline) process.exit(1);
  setTimeout(wait, 10);
})();
NODE
mv "$RACE_ROOT" "$RACE_MOVED"
mkdir -p "$RACE_EXTERNAL/.workflow-sidecar.lockdir"
printf 'outside must survive\n' >"$RACE_EXTERNAL/.workflow-sidecar.lockdir/sentinel"
ln -s "$RACE_EXTERNAL" "$RACE_ROOT"
set +e
wait "$RACE_PID"
RACE_STATUS=$?
set -e
if [[ "$RACE_STATUS" -ne 0 ]] \
  && [[ -f "$RACE_EXTERNAL/.workflow-sidecar.lockdir/sentinel" ]] \
  && [[ -d "$RACE_MOVED/.workflow-sidecar.lockdir" ]] \
  && grep -q 'lock cleanup skipped because root or lock identity changed' "$TMP/lock-swap.out"; then
  pass "lock cleanup refuses a swapped root and preserves external content"
else
  fail "lock cleanup followed a swapped root or lost its identity diagnostic: $(cat "$TMP/lock-swap.out")"
fi

RELEASE_STATE="$TMP/release-3.4.2-state.json"
cat >"$RELEASE_STATE" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "release-3-4-2",
  "status": "new",
  "phase": "pickup",
  "updated_at": "2026-07-10T00:00:00Z",
  "next_action": {
    "status": "continue",
    "summary": "Start the canonical Flow run.",
    "command": "flow-agents builder-run start --session-dir .kontourai/flow-agents/release-3-4-2",
    "enforcement": "before_tool_use"
  }
}
JSON
if flow_agents_node "validate-workflow-artifacts" --skip-markdown-validation "$RELEASE_STATE" >/dev/null 2>&1; then
  pass "3.4.2 sidecars remain schema-valid while deprecated enforcement is ignored"
else
  fail "3.4.2 sidecar compatibility regressed"
fi

REFUSED_ROOT="$TMP/refused/.kontourai/flow-agents"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$REFUSED_ROOT" \
  --task-slug refused-plan \
  --title "Refused plan entry" \
  --summary "Must enter through the declared prefix." \
  --flow-id builder.build \
  --step-id plan >"$TMP/refused.out" 2>&1; then
  fail "fresh later-step entry is rejected"
elif [[ ! -e "$REFUSED_ROOT" ]] && grep -q 'must start at first step "pull-work"' "$TMP/refused.out"; then
  pass "fresh later-step entry is rejected before artifact-root creation"
else
  fail "later-step refusal wrote files or returned the wrong diagnostic: $(cat "$TMP/refused.out")"
fi

AD_HOC_ROOT="$TMP/ad-hoc/.kontourai/flow-agents"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$AD_HOC_ROOT" \
  --task-slug refused-ad-hoc \
  --title "Refused ad-hoc entry" \
  --summary "A reason is not workflow authority." \
  --flow-id builder.build \
  --step-id plan \
  --ad-hoc-reason "skip the prefix" >"$TMP/ad-hoc.out" 2>&1; then
  fail "ad-hoc reason cannot authorize later-step entry"
elif [[ ! -e "$AD_HOC_ROOT" ]] && grep -q 'cannot authorize workflow entry' "$TMP/ad-hoc.out"; then
  pass "ad-hoc reason cannot authorize later-step entry or write artifacts"
else
  fail "ad-hoc refusal wrote files or returned the wrong diagnostic: $(cat "$TMP/ad-hoc.out")"
fi

LOCAL_ROOT="$TMP/local/.kontourai/flow-agents"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$LOCAL_ROOT" \
  --task-slug local-request \
  --actor builder-entry-local \
  --title "Local request" \
  --summary "Providerless work still needs an anchor." \
  --flow-id builder.build \
  --timestamp "2026-07-10T00:00:00Z" >"$TMP/local.out" 2>&1; then
  if node - "$LOCAL_ROOT" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const current = JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8'));
const state = JSON.parse(fs.readFileSync(path.join(root, 'local-request', 'state.json'), 'utf8'));
const workItem = JSON.parse(fs.readFileSync(path.join(root, 'local-request', 'work-item.json'), 'utf8'));
const flowState = JSON.parse(fs.readFileSync(path.join(path.dirname(root), 'flow', 'runs', 'local-request', 'state.json'), 'utf8'));
if (current.active_flow_id !== 'builder.build' || current.active_step_id !== 'design-probe') process.exit(1);
if (state.status !== 'in_progress' || state.phase !== 'pickup') process.exit(1);
if (JSON.stringify(state.work_item_refs) !== JSON.stringify(['local:local-request'])) process.exit(1);
if (workItem.id !== 'local-request' || workItem.title !== 'Local request') process.exit(1);
if (workItem.source_provider?.kind !== 'local' || workItem.source_provider?.path !== 'work-item.json') process.exit(1);
if (flowState.current_step !== 'design-probe' || flowState.subject !== 'local:local-request') process.exit(1);
if (state.flow_run?.current_step !== 'design-probe') process.exit(1);
if (JSON.stringify(state.next_action?.skills) !== JSON.stringify(['pickup-probe'])) process.exit(1);
if (!state.next_action?.command?.includes("'workflow' 'status'")) process.exit(1);
if ('enforcement' in state.next_action) process.exit(1);
const bundle = JSON.parse(fs.readFileSync(path.join(root, 'local-request', 'trust.bundle'), 'utf8'));
const selected = (bundle.claims || []).find((claim) => claim.claimType === 'builder.pull-work.selected');
if (selected?.status !== 'verified') process.exit(1);
if (selected?.metadata?.workflow_subject_ref !== 'local:local-request') process.exit(1);
if (!(selected?.metadata?.artifact_refs || []).some((ref) => ref.file === '.kontourai/flow-agents/assignment/local-request.json')) process.exit(1);
NODE
  then
    pass "durably acquired local Work Item satisfies pull-work through the trust bundle and Flow advances"
  else
    fail "local Work Item or first-step state is invalid"
  fi
else
  fail "providerless Builder entry failed: $(cat "$TMP/local.out")"
fi

LOCAL_SESSION="$LOCAL_ROOT/local-request"
FLOW_DIGEST_BEFORE="$(find "$TMP/local/.kontourai/flow/runs/local-request" -type f -print0 | sort -z | xargs -0 shasum -a 256)"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$LOCAL_ROOT" \
  --task-slug local-request \
  --actor builder-entry-local \
  --title "Local request" \
  --summary "Providerless work still needs an anchor." \
  --flow-id builder.build \
  --timestamp "2026-07-10T00:00:00Z" >"$TMP/builder-ensure-again.out" 2>&1 \
  && [[ "$FLOW_DIGEST_BEFORE" == "$(find "$TMP/local/.kontourai/flow/runs/local-request" -type f -print0 | sort -z | xargs -0 shasum -a 256)" ]] \
  && node - "$TMP/local" "$LOCAL_SESSION" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const project = process.argv[2];
const session = process.argv[3];
const flowState = JSON.parse(fs.readFileSync(path.join(project, '.kontourai', 'flow', 'runs', 'local-request', 'state.json'), 'utf8'));
const sidecar = JSON.parse(fs.readFileSync(path.join(session, 'state.json'), 'utf8'));
if (flowState.current_step !== 'design-probe' || flowState.subject !== 'local:local-request') process.exit(1);
if (sidecar.flow_run?.current_step !== 'design-probe') process.exit(1);
if (JSON.stringify(sidecar.next_action?.skills) !== JSON.stringify(['pickup-probe'])) process.exit(1);
if (!sidecar.next_action?.command?.includes("'workflow' 'status'")) process.exit(1);
NODE
then
  pass "repeated ensure-session loads the canonical Flow run without resetting its history"
else
  fail "canonical Builder ensure was not idempotent: $(cat "$TMP/builder-ensure-again.out")"
fi

BROKEN_PROJECT="$TMP/broken-start"
BROKEN_ROOT="$BROKEN_PROJECT/.kontourai/flow-agents"
mkdir -p "$BROKEN_PROJECT/.kontourai"
printf 'not a run-store directory\n' > "$BROKEN_PROJECT/.kontourai/flow"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$BROKEN_ROOT" \
  --task-slug broken-start \
  --actor builder-entry-broken \
  --title "Broken start" \
  --summary "Flow startup must fail visibly." \
  --flow-id builder.build >"$TMP/broken-start.out" 2>&1; then
  fail "invalid canonical Flow startup should fail ensure-session"
elif [[ -f "$BROKEN_ROOT/broken-start/state.json" ]] \
  && [[ ! -e "$BROKEN_PROJECT/.kontourai/flow/runs/broken-start" ]] \
  && grep -q 'canonical Builder Flow entry failed' "$TMP/broken-start.out" \
  && grep -q 'Re-run the same ensure-session command' "$TMP/broken-start.out" \
  && node - "$BROKEN_ROOT/broken-start/state.json" <<'NODE'
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (state.flow_run) process.exit(1);
if (!state.next_action?.command?.includes("'workflow' 'start'")) process.exit(1);
NODE
then
  pass "failed canonical startup is visible and leaves only retryable sidecar guidance"
else
  fail "failed canonical startup forged state or lost recovery guidance: $(cat "$TMP/broken-start.out")"
fi

rm -f "$BROKEN_PROJECT/.kontourai/flow"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$BROKEN_ROOT" \
  --task-slug broken-start \
  --actor builder-entry-broken \
  --title "Broken start" \
  --summary "Flow startup must recover from persisted acquisition provenance." \
  --flow-id builder.build >"$TMP/broken-start-retry.out" 2>&1 \
  && node - "$BROKEN_PROJECT" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const project = process.argv[2];
const flowState = JSON.parse(fs.readFileSync(path.join(project, '.kontourai', 'flow', 'runs', 'broken-start', 'state.json'), 'utf8'));
const bundle = JSON.parse(fs.readFileSync(path.join(project, '.kontourai', 'flow-agents', 'broken-start', 'trust.bundle'), 'utf8'));
if (flowState.current_step !== 'design-probe') process.exit(1);
if (!(bundle.claims || []).some((claim) => claim.claimType === 'builder.pull-work.selected' && claim.status === 'verified')) process.exit(1);
NODE
then
  pass "interrupted Flow startup retries from exact persisted acquisition provenance"
else
  fail "interrupted acquisition could not recover: $(cat "$TMP/broken-start-retry.out")"
fi

if node - "$TMP/local" "$LOCAL_SESSION" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const project = process.argv[2];
const session = process.argv[3];
const flowState = JSON.parse(fs.readFileSync(path.join(project, '.kontourai', 'flow', 'runs', 'local-request', 'state.json'), 'utf8'));
const sidecar = JSON.parse(fs.readFileSync(path.join(session, 'state.json'), 'utf8'));
if (flowState.current_step !== 'design-probe') process.exit(1);
if (sidecar.flow_run?.current_step !== 'design-probe') process.exit(1);
if (JSON.stringify(sidecar.next_action?.skills) !== JSON.stringify(['pickup-probe'])) process.exit(1);
NODE
then
  pass "automatic selected-work claim synchronizes Flow and projects the next skill"
else
  fail "automatic selected-work claim did not advance the canonical run"
fi

SKIPPED_ROOT="$TMP/skipped/.kontourai/flow-agents"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$SKIPPED_ROOT" \
  --task-slug skipped-ownership \
  --actor builder-entry-skipped \
  --skip-ownership-guard \
  --title "Skipped ownership" \
  --summary "Unproven ownership must remain at pull-work." \
  --flow-id builder.build >"$TMP/skipped.out" 2>&1 \
  && node - "$TMP/skipped" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const project = process.argv[2];
const session = path.join(project, '.kontourai', 'flow-agents', 'skipped-ownership');
const flowState = JSON.parse(fs.readFileSync(path.join(project, '.kontourai', 'flow', 'runs', 'skipped-ownership', 'state.json'), 'utf8'));
const sidecar = JSON.parse(fs.readFileSync(path.join(session, 'state.json'), 'utf8'));
if (flowState.current_step !== 'pull-work' || sidecar.flow_run?.current_step !== 'pull-work') process.exit(1);
if (JSON.stringify(sidecar.next_action?.skills) !== JSON.stringify(['pull-work'])) process.exit(1);
if (fs.existsSync(path.join(session, 'trust.bundle'))) process.exit(1);
if (fs.existsSync(path.join(project, '.kontourai', 'flow-agents', 'assignment', 'skipped-ownership.json'))) process.exit(1);
NODE
then
  pass "skipped ownership remains at pull-work without selected-work evidence"
else
  fail "unproven ownership advanced the canonical run: $(cat "$TMP/skipped.out")"
fi

MISMATCH_ROOT="$TMP/mismatched-subject/.kontourai/flow-agents"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$MISMATCH_ROOT" \
  --task-slug arbitrary-session-name \
  --work-item "kontourai/flow-agents#541" \
  --actor builder-entry-mismatch \
  --title "Mismatched assignment subject" \
  --summary "An arbitrary slug is not exact Work Item evidence." \
  --flow-id builder.build >"$TMP/mismatched-subject.out" 2>&1 \
  && node - "$TMP/mismatched-subject" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const project = process.argv[2];
const session = path.join(project, '.kontourai', 'flow-agents', 'arbitrary-session-name');
const flowState = JSON.parse(fs.readFileSync(path.join(project, '.kontourai', 'flow', 'runs', 'arbitrary-session-name', 'state.json'), 'utf8'));
const sidecar = JSON.parse(fs.readFileSync(path.join(session, 'state.json'), 'utf8'));
if (flowState.subject !== 'kontourai/flow-agents#541' || flowState.current_step !== 'pull-work') process.exit(1);
if (sidecar.flow_run?.current_step !== 'pull-work') process.exit(1);
if (fs.existsSync(path.join(session, 'trust.bundle'))) process.exit(1);
if (!fs.existsSync(path.join(project, '.kontourai', 'flow-agents', 'assignment', 'arbitrary-session-name.json'))) process.exit(1);
NODE
then
  pass "assignment subject must canonically match the exact Work Item before pull-work can pass"
else
  fail "mismatched assignment subject was treated as exact Work Item evidence: $(cat "$TMP/mismatched-subject.out")"
fi

COLLISION_ROOT="$TMP/collision/.kontourai/flow-agents"
if ! flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$COLLISION_ROOT" \
  --work-item "owner/a.b#541" \
  --actor builder-entry-collision \
  --title "Collision seed" \
  --summary "Bind the first exact Work Item." >/dev/null 2>&1; then
  fail "collision fixture could not seed the first exact Work Item"
else
  COLLISION_ASSIGNMENT="$COLLISION_ROOT/assignment/owner-a-b-541.json"
  COLLISION_DIGEST="$(shasum -a 256 "$COLLISION_ASSIGNMENT")"
  if flow_agents_node "$WRITER" ensure-session \
    --artifact-root "$COLLISION_ROOT" \
    --work-item "owner/a-b#541" \
    --actor builder-entry-collision \
    --title "Collision attempt" \
    --summary "A colliding slug must not change the exact Work Item." \
    --flow-id builder.build >"$TMP/collision.out" 2>&1; then
    fail "colliding exact Work Item refs should be rejected"
  elif grep -q 'already bound to Work Item "owner/a.b#541", not "owner/a-b#541"' "$TMP/collision.out" \
    && [[ "$COLLISION_DIGEST" == "$(shasum -a 256 "$COLLISION_ASSIGNMENT")" ]] \
    && [[ ! -e "$TMP/collision/.kontourai/flow/runs/owner-a-b-541" ]]; then
    pass "colliding slugs cannot change an existing session's exact Work Item binding"
  else
    fail "slug collision mutated ownership or returned the wrong diagnostic: $(cat "$TMP/collision.out")"
  fi
fi

ASSIGNMENT_ONLY_ROOT="$TMP/assignment-only-collision/.kontourai/flow-agents"
mkdir -p "$ASSIGNMENT_ONLY_ROOT/assignment"
cat >"$ASSIGNMENT_ONLY_ROOT/assignment/owner-a-b-542.json" <<'JSON'
{
  "schema_version": "1.0",
  "role": "AssignmentClaimRecord",
  "subject_id": "owner-a-b-542",
  "actor": { "runtime": "codex", "session_id": "interrupted", "host": "eval-host", "human": null },
  "actor_key": "interrupted",
  "work_item_ref": "owner/a.b#542",
  "claimed_at": "2020-01-01T00:00:00Z",
  "ttl_seconds": 1,
  "branch": "agent/interrupted/owner-a-b-542",
  "artifact_dir": "owner-a-b-542",
  "status": "claimed",
  "audit_trail": []
}
JSON
ASSIGNMENT_ONLY_FILE="$ASSIGNMENT_ONLY_ROOT/assignment/owner-a-b-542.json"
ASSIGNMENT_ONLY_DIGEST="$(shasum -a 256 "$ASSIGNMENT_ONLY_FILE")"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$ASSIGNMENT_ONLY_ROOT" \
  --work-item "owner/a-b#542" \
  --actor builder-entry-assignment-only-collision \
  --supersede-stale \
  --now "2026-07-10T00:00:00Z" \
  --title "Assignment-only collision" \
  --summary "A crash before state creation must preserve exact assignment identity." \
  --flow-id builder.build >"$TMP/assignment-only-collision.out" 2>&1; then
  fail "assignment-only colliding Work Item should be rejected"
elif grep -q 'already bound to Work Item "owner/a.b#542", not "owner/a-b#542"' "$TMP/assignment-only-collision.out" \
  && [[ "$ASSIGNMENT_ONLY_DIGEST" == "$(shasum -a 256 "$ASSIGNMENT_ONLY_FILE")" ]] \
  && [[ ! -e "$ASSIGNMENT_ONLY_ROOT/owner-a-b-542" ]]; then
  pass "assignment provenance blocks slug collisions before session state exists"
else
  fail "assignment-only collision mutated provenance or returned the wrong diagnostic: $(cat "$TMP/assignment-only-collision.out")"
fi

PREEXISTING_ROOT="$TMP/preexisting/.kontourai/flow-agents"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$PREEXISTING_ROOT" \
  --task-slug preexisting-selection \
  --actor builder-entry-preexisting \
  --title "Preexisting selection" \
  --summary "Seed an assignment before the canonical Builder run." >/dev/null 2>&1 \
  && flow_agents_node "$WRITER" ensure-session \
    --artifact-root "$PREEXISTING_ROOT" \
    --task-slug preexisting-selection \
    --actor builder-entry-preexisting \
    --title "Preexisting selection" \
    --summary "An older self-held assignment is not new selection evidence." \
    --flow-id builder.build >"$TMP/preexisting.out" 2>&1 \
  && node - "$TMP/preexisting" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const project = process.argv[2];
const session = path.join(project, '.kontourai', 'flow-agents', 'preexisting-selection');
const flowState = JSON.parse(fs.readFileSync(path.join(project, '.kontourai', 'flow', 'runs', 'preexisting-selection', 'state.json'), 'utf8'));
if (flowState.current_step !== 'pull-work') process.exit(1);
if (fs.existsSync(path.join(session, 'trust.bundle'))) process.exit(1);
NODE
then
  pass "preexisting self-held assignments do not retroactively satisfy pull-work"
else
  fail "preexisting assignment was treated as current selection evidence: $(cat "$TMP/preexisting.out")"
fi

if FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=100000 \
  node "$ROOT/scripts/hooks/stop-goal-fit.js" >"$TMP/stop.out" 2>"$TMP/stop.err" <<JSON
{"hook_event_name":"Stop","cwd":"$TMP/local"}
JSON
then
  fail "active pre-execution Flow run should block Stop"
else
  stop_status=$?
  if [[ "$stop_status" -eq 2 ]] \
    && grep -q 'required skills: pickup-probe' "$TMP/stop.err" \
    && grep -q 'next command: sh -c' "$TMP/stop.err" \
    && grep -q 'release skipped for active Flow run' "$TMP/stop.err" \
    && node - "$LOCAL_SESSION/state.json" <<'NODE'
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (state.flow_run?.status !== 'active' || state.flow_run?.current_step !== 'design-probe') process.exit(1);
if (!state.next_action?.command?.includes("'workflow' 'status'")) process.exit(1);
NODE
  then
    pass "active Flow run blocks Stop, preserves liveness, and exposes executable guidance"
  else
    fail "active Flow Stop enforcement or guidance was incomplete (exit $stop_status): $(cat "$TMP/stop.err")"
  fi
fi

if flow_agents_node "$WRITER" record-gate-claim "$LOCAL_SESSION" \
  --expectation pickup-probe-readiness \
  --status pass \
  --summary "Pickup Probe confirmed scope and planning readiness." \
  --evidence-ref-json '{"kind":"artifact","file":".kontourai/flow-agents/local-request/work-item.json","summary":"Probe fixture evidence."}' >/dev/null 2>&1 \
  && flow_agents_node "$WRITER" record-gate-claim "$LOCAL_SESSION" \
  --expectation probe-decisions-or-accepted-gaps \
  --status pass \
  --summary "Probe decisions and accepted gaps are recorded." \
  --evidence-ref-json '{"kind":"artifact","file":".kontourai/flow-agents/local-request/work-item.json","summary":"Probe decision fixture evidence."}' >/dev/null 2>&1 \
  && flow_agents_node "$WRITER" record-gate-claim "$LOCAL_SESSION" \
  --expectation implementation-plan \
  --status pass \
  --summary "Implementation plan records files, sequence, and evidence." \
  --evidence-ref-json '{"kind":"artifact","file":".kontourai/flow-agents/local-request/work-item.json","summary":"Plan fixture evidence."}' >/dev/null 2>&1 \
  && flow_agents_node "$WRITER" record-gate-claim "$LOCAL_SESSION" \
  --expectation implementation-scope \
  --status pass \
  --summary "Implementation scope and changed files are recorded." \
  --evidence-ref-json '{"kind":"artifact","file":".kontourai/flow-agents/local-request/work-item.json","summary":"Execution fixture evidence."}' >/dev/null 2>&1 \
  && flow_agents_node "$WRITER" record-gate-claim "$LOCAL_SESSION" \
  --expectation tests-evidence \
  --status fail \
  --route-reason implementation_defect \
  --summary "Verification found an implementation defect." \
  --evidence-ref-json '{"kind":"artifact","file":".kontourai/flow-agents/local-request/work-item.json","summary":"Failed verification fixture evidence."}' >"$TMP/route-back.out" 2>&1 \
  && node - "$TMP/local" "$LOCAL_SESSION" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const project = process.argv[2];
const session = process.argv[3];
const flowState = JSON.parse(fs.readFileSync(path.join(project, '.kontourai', 'flow', 'runs', 'local-request', 'state.json'), 'utf8'));
const sidecar = JSON.parse(fs.readFileSync(path.join(session, 'state.json'), 'utf8'));
if (flowState.current_step !== 'execute') process.exit(1);
if (sidecar.flow_run?.route_back_attempt !== 1 || sidecar.flow_run?.route_back_max_attempts !== 3) process.exit(1);
if (JSON.stringify(sidecar.next_action?.skills) !== JSON.stringify(['execute-plan'])) process.exit(1);
if (!sidecar.next_action?.summary?.includes('Route-back history: attempt 1/3')) process.exit(1);
NODE
then
  pass "sidecar failure classifier drives Flow route-back and projects its attempt budget"
else
  fail "route-back classifier did not produce the canonical execute retry: $(cat "$TMP/route-back.out" 2>/dev/null)"
fi

PROVIDER_ROOT="$TMP/provider/.kontourai/flow-agents"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$PROVIDER_ROOT" \
  --work-item "kontourai/flow-agents#438" \
  --title "Provider work item" \
  --summary "Keep the provider reference." \
  --flow-id builder.build \
  --timestamp "2026-07-10T00:01:00Z" >/dev/null 2>&1 \
  && node - "$PROVIDER_ROOT/kontourai-flow-agents-438/state.json" <<'NODE'
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (JSON.stringify(state.work_item_refs) !== JSON.stringify(['kontourai/flow-agents#438'])) process.exit(1);
NODE
then
  pass "provider-backed request preserves its neutral work-item ref"
else
  fail "provider-backed work-item ref was not persisted"
fi

# A direct primitive remains usable without claiming Builder prefix completion.
STANDALONE_ROOT="$TMP/standalone/.kontourai/flow-agents"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$STANDALONE_ROOT" \
  --task-slug standalone-plan \
  --title "Standalone plan" \
  --summary "Direct primitive session." \
  --timestamp "2026-07-10T00:02:00Z" >/dev/null 2>&1 \
  && node - "$STANDALONE_ROOT" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const current = JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8'));
const state = JSON.parse(fs.readFileSync(path.join(root, 'standalone-plan', 'state.json'), 'utf8'));
if ('active_flow_id' in current || 'active_step_id' in current) process.exit(1);
if (state.status !== 'planned' || state.phase !== 'planning') process.exit(1);
if (JSON.stringify(state.work_item_refs) !== JSON.stringify(['local:standalone-plan'])) process.exit(1);
NODE
then
  pass "standalone primitive session remains available without a Builder stamp"
else
  fail "standalone primitive session was incorrectly stamped as Builder"
fi

if [[ "$errors" -gt 0 ]]; then
  printf 'test_builder_entry_enforcement: %d failure(s)\n' "$errors" >&2
  exit 1
fi

echo "test_builder_entry_enforcement: all checks passed"
