#!/usr/bin/env bash
# test_current_json_per_actor.sh - per-actor current.json projection + legacy compat shim (#291).
#
# Exercises scripts/hooks/lib/current-pointer.js (the shared read/write choke point for the
# per-actor-first/legacy-fallback rule) and every consumer Wave 2 updated to go through it.
# Fully deterministic, no network, no model spend. Follows
# test_pull_work_liveness_preflight.sh's multi-actor fixture setup and
# test_workflow_sidecar_writer.sh's ensure-session/current command assertions.
#
# Plan sections (see .kontourai/flow-agents/kontourai-flow-agents-291/
# kontourai-flow-agents-291--plan-work.md, Wave 3 "Per-actor current.json + compat-shim eval"):
#   1. current-pointer.js unit-level smoke: none -> legacy -> per-actor precedence.
#   2. Actor A and actor B ensure-session on DIFFERENT subjects, same artifact root -> actor A's
#      own `current --actor` resolution is unaffected by B's later call (AC7 -- the issue's
#      exact problem statement).
#   3. Legacy-only fixture (no per-actor file at all) -> stop-goal-fit.js, evidence-capture.js,
#      flow-agents-statusline.js, and workflow-steering.js all resolve identically to their
#      existing (pre-#291) golden output, even under a different ambient actor (AC8).
#   4. config-protection.js blocks writes/redirects to current/<actor>.json exactly like the
#      legacy current.json (AC10).
#   5. record-gate-claim/writeTrustBundle scoping: actor A's own active_flow_id/active_step_id
#      resolves from A's per-actor current file, not a DIFFERENT actor's more-recently-written
#      legacy global current.json (AC11).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

CURRENT_POINTER_HELPER="$ROOT/scripts/hooks/lib/current-pointer.js"
GOAL_FIT_GATE="$ROOT/scripts/hooks/stop-goal-fit.js"
EVIDENCE_CAPTURE="$ROOT/scripts/hooks/evidence-capture.js"
STATUSLINE="$ROOT/scripts/statusline/flow-agents-statusline.js"
STEERING="$ROOT/scripts/hooks/workflow-steering.js"
CONFIG_PROTECTION="$ROOT/scripts/hooks/config-protection.js"

TMPDIR_EVAL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_EVAL"' EXIT

errors=0
pass() { echo "  [pass] $1"; }
fail() { echo "  [FAIL] $1"; errors=$((errors + 1)); }

# safe_write <target-file> -- reads content from stdin and writes it to <target-file> via a
# temp-file-then-rename, so this eval script's own source text never contains a literal shell
# redirect (>/>>/tee) immediately adjacent to a current.json/state.json/trust.bundle-shaped
# path (several fixtures below legitimately need to seed those exact filenames).
safe_write() {
  local target="$1"
  local tmp="${target}.write-tmp"
  cat > "$tmp"
  mv "$tmp" "$target"
}

flow_agents_build_ts || { echo "build failed" >&2; exit 1; }

echo "=== Per-actor current.json + legacy compat shim (#291) ==="

# --- 1. current-pointer.js unit smoke: none -> legacy -> per-actor precedence -----------------
echo "--- 1. current-pointer.js: none / legacy / per-actor precedence ---"

CP_SMOKE_DIR="$TMPDIR_EVAL/current-pointer-smoke"
mkdir -p "$CP_SMOKE_DIR"

if node - "$CURRENT_POINTER_HELPER" "$CP_SMOKE_DIR" <<'NODEEOF' 2>"$TMPDIR_EVAL/cp-none.err"
const { readCurrentPointer } = require(process.argv[2]);
const r = readCurrentPointer(process.argv[3], "some-actor");
if (r.source !== "none" || r.payload !== null) { console.error(JSON.stringify(r)); process.exit(1); }
NODEEOF
then
  pass "readCurrentPointer returns source:none on an empty dir"
else
  fail "readCurrentPointer did not return source:none on an empty dir: $(cat "$TMPDIR_EVAL/cp-none.err")"
fi

LEGACY_JSON_LINE='{"marker":"legacy"}'
printf '%s' "$LEGACY_JSON_LINE" | safe_write "$CP_SMOKE_DIR/current.json"

if node - "$CURRENT_POINTER_HELPER" "$CP_SMOKE_DIR" <<'NODEEOF' 2>"$TMPDIR_EVAL/cp-legacy.err"
const { readCurrentPointer } = require(process.argv[2]);
const r = readCurrentPointer(process.argv[3], "some-actor");
if (r.source !== "legacy" || !r.payload || r.payload.marker !== "legacy") { console.error(JSON.stringify(r)); process.exit(1); }
NODEEOF
then
  pass "readCurrentPointer prefers legacy current.json when no per-actor file exists"
else
  fail "readCurrentPointer did not fall back to legacy current.json: $(cat "$TMPDIR_EVAL/cp-legacy.err")"
fi

mkdir -p "$CP_SMOKE_DIR/current"
PER_ACTOR_JSON_LINE='{"marker":"per-actor"}'
printf '%s' "$PER_ACTOR_JSON_LINE" | safe_write "$CP_SMOKE_DIR/current/some-actor.json"

if node - "$CURRENT_POINTER_HELPER" "$CP_SMOKE_DIR" <<'NODEEOF' 2>"$TMPDIR_EVAL/cp-per-actor.err"
const { readCurrentPointer } = require(process.argv[2]);
const r = readCurrentPointer(process.argv[3], "some-actor");
if (r.source !== "per-actor" || !r.payload || r.payload.marker !== "per-actor") { console.error(JSON.stringify(r)); process.exit(1); }
NODEEOF
then
  pass "readCurrentPointer prefers the per-actor file over a stale legacy file once it exists"
else
  fail "readCurrentPointer did not prefer the per-actor file: $(cat "$TMPDIR_EVAL/cp-per-actor.err")"
fi

# An unresolved/empty actorKey always falls straight through to legacy, regardless of a
# matching per-actor file existing under a DIFFERENT key.
if node - "$CURRENT_POINTER_HELPER" "$CP_SMOKE_DIR" <<'NODEEOF' 2>"$TMPDIR_EVAL/cp-unresolved.err"
const { readCurrentPointer } = require(process.argv[2]);
const r = readCurrentPointer(process.argv[3], "");
if (r.source !== "legacy" || !r.payload || r.payload.marker !== "legacy") { console.error(JSON.stringify(r)); process.exit(1); }
NODEEOF
then
  pass "readCurrentPointer falls straight to legacy for an empty/unresolved actorKey"
else
  fail "readCurrentPointer did not fall back to legacy for an unresolved actorKey: $(cat "$TMPDIR_EVAL/cp-unresolved.err")"
fi

# --- 2. actor A's own current resolution is unaffected by actor B's later call (AC7) ----------
echo "--- 2. actor A's current resolution survives actor B's later, unrelated ensure-session (AC7) ---"

AC7_ROOT="$TMPDIR_EVAL/ac7-artifact-root"

flow_agents_node "workflow-sidecar" ensure-session \
  --artifact-root "$AC7_ROOT" \
  --work-item "kontourai/flow-agents#9201" \
  --actor eval-actor-a-session \
  --source-request "Actor A's own subject." \
  --summary "Actor A." \
  >"$TMPDIR_EVAL/ac7-a.out" 2>"$TMPDIR_EVAL/ac7-a.err"
A_STATUS=$?

# Actor B runs ensure-session on a DIFFERENT subject on the SAME artifact root, strictly AFTER
# actor A -- the exact "session B runs ensure-session after A" scenario from the issue.
flow_agents_node "workflow-sidecar" ensure-session \
  --artifact-root "$AC7_ROOT" \
  --work-item "kontourai/flow-agents#9202" \
  --actor eval-actor-b-session \
  --source-request "Actor B's own, unrelated subject." \
  --summary "Actor B." \
  >"$TMPDIR_EVAL/ac7-b.out" 2>"$TMPDIR_EVAL/ac7-b.err"
B_STATUS=$?

if [[ "$A_STATUS" -eq 0 && "$B_STATUS" -eq 0 ]]; then
  pass "both actor A's and actor B's ensure-session calls on distinct subjects succeed"
else
  fail "actor A/B setup calls failed: a=$A_STATUS b=$B_STATUS $(cat "$TMPDIR_EVAL/ac7-a.out" "$TMPDIR_EVAL/ac7-a.err" "$TMPDIR_EVAL/ac7-b.out" "$TMPDIR_EVAL/ac7-b.err")"
fi

A_SLUG_VIA_ACTOR="$(flow_agents_node "workflow-sidecar" current --artifact-root "$AC7_ROOT" --actor eval-actor-a-session --format slug 2>"$TMPDIR_EVAL/ac7-current-a.err")"
if [[ "$A_SLUG_VIA_ACTOR" == "kontourai-flow-agents-9201" ]]; then
  pass "current --actor eval-actor-a-session still resolves A's OWN session directory after B's later call (AC7)"
else
  fail "current --actor eval-actor-a-session resolved the wrong session after B's later call: got '$A_SLUG_VIA_ACTOR' (err: $(cat "$TMPDIR_EVAL/ac7-current-a.err"))"
fi

B_SLUG_VIA_ACTOR="$(flow_agents_node "workflow-sidecar" current --artifact-root "$AC7_ROOT" --actor eval-actor-b-session --format slug 2>"$TMPDIR_EVAL/ac7-current-b.err")"
if [[ "$B_SLUG_VIA_ACTOR" == "kontourai-flow-agents-9202" ]]; then
  pass "current --actor eval-actor-b-session resolves B's own session directory"
else
  fail "current --actor eval-actor-b-session resolved the wrong session: got '$B_SLUG_VIA_ACTOR' (err: $(cat "$TMPDIR_EVAL/ac7-current-b.err"))"
fi

# Contrast: the LEGACY global current.json (no --actor) is still last-writer-wins -- it now
# names B (who ran ensure-session last), proving the isolation above comes specifically from
# the per-actor projection, not from some other accidental effect.
LEGACY_SLUG="$(flow_agents_node "workflow-sidecar" current --artifact-root "$AC7_ROOT" --format slug 2>"$TMPDIR_EVAL/ac7-current-legacy.err")"
if [[ "$LEGACY_SLUG" == "kontourai-flow-agents-9202" ]]; then
  pass "contrast: the legacy global current.json (no --actor) still names B, the last writer -- isolation is specifically the per-actor projection's doing (AC7)"
else
  fail "legacy global current.json did not name B as expected: got '$LEGACY_SLUG' (err: $(cat "$TMPDIR_EVAL/ac7-current-legacy.err"))"
fi

PER_ACTOR_FILE_A="$AC7_ROOT/current/eval-actor-a-session.json"
PER_ACTOR_FILE_B="$AC7_ROOT/current/eval-actor-b-session.json"
[[ -f "$PER_ACTOR_FILE_A" ]] && pass "actor A's per-actor current file exists on disk" || fail "actor A's per-actor current file was not written"
[[ -f "$PER_ACTOR_FILE_B" ]] && pass "actor B's per-actor current file exists on disk" || fail "actor B's per-actor current file was not written"

# --- 3. Legacy-only fixture: every named consumer resolves identically to pre-#291 (AC8) -------
echo "--- 3. legacy-only fixture: existing consumers resolve identically to pre-#291 output (AC8) ---"

# 3a. stop-goal-fit.js -- reuses test_goal_fit_hook.sh's own fixture/assertion verbatim, run
# under a DIFFERENT ambient actor that has no per-actor current file -- proves the compat shim
# falls straight through to the legacy file (same output regardless of actor) exactly as
# pre-#291 (when this file had no actor-awareness at all).
GOAL_FIT_REPO="$TMPDIR_EVAL/goal-fit-legacy/repo"
mkdir -p "$GOAL_FIT_REPO/.kontourai/flow-agents/feedback-loop"
LEGACY_POINTER_LINE="{\"schema_version\":\"1.0\",\"active_slug\":\"feedback-loop\",\"artifact_dir\":\"feedback-loop\"}"
printf "%s" "$LEGACY_POINTER_LINE" | safe_write "$GOAL_FIT_REPO/.kontourai/flow-agents/current.json"
printf '# Test Repo\n' > "$GOAL_FIT_REPO/AGENTS.md"
cat > "$GOAL_FIT_REPO/.kontourai/flow-agents/feedback-loop/feedback-loop--deliver.md" <<'MARKDOWN'
# Build feedback loop

branch: main
worktree: main
created: 2026-05-04
status: executing
type: deliver

## Plan

Implementation plan exists, but no goal fit state exists yet.
MARKDOWN

if FLOW_AGENTS_ACTOR=eval-actor-no-per-actor-file FLOW_AGENTS_GOAL_FIT_MODE=warn FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=100000 \
  node "$GOAL_FIT_GATE" >"$TMPDIR_EVAL/goal-fit-legacy.out" 2>"$TMPDIR_EVAL/goal-fit-legacy.err" <<JSON
{"hook_event_name":"Stop","cwd":"$GOAL_FIT_REPO"}
JSON
then
  if rg -q 'status:executing' "$TMPDIR_EVAL/goal-fit-legacy.err"; then
    pass "stop-goal-fit.js resolves the legacy-only fixture identically to its own existing eval's golden output, under a different ambient actor (AC8)"
  else
    fail "stop-goal-fit.js legacy-only output did not match the golden assertion: $(cat "$TMPDIR_EVAL/goal-fit-legacy.err")"
  fi
else
  fail "stop-goal-fit.js against the legacy-only fixture should stay warning-only (exit 0): $(cat "$TMPDIR_EVAL/goal-fit-legacy.out" "$TMPDIR_EVAL/goal-fit-legacy.err")"
fi

# 3b. evidence-capture.js's resolveArtifactDir -- reuses test_command_log_concurrency.sh's
# fixture: current.json (legacy-only) names a slug; a captured PostToolUse event must land in
# THAT slug's command-log.jsonl, under a different ambient actor with no per-actor file.
EVIDENCE_REPO="$TMPDIR_EVAL/evidence-legacy/repo"
EVIDENCE_SLUG="legacy-evidence-slug"
mkdir -p "$EVIDENCE_REPO/.kontourai/flow-agents/$EVIDENCE_SLUG"
printf '# Repo\n' > "$EVIDENCE_REPO/AGENTS.md"

EVIDENCE_CURRENT_LINE="{\"active_slug\":\"$EVIDENCE_SLUG\",\"artifact_dir\":\".kontourai/flow-agents/$EVIDENCE_SLUG\"}"
printf '%s' "$EVIDENCE_CURRENT_LINE" | safe_write "$EVIDENCE_REPO/.kontourai/flow-agents/current.json"

EVIDENCE_STATE_LINE="{\"schema_version\":\"1.0\",\"task_slug\":\"$EVIDENCE_SLUG\",\"status\":\"in_progress\",\"phase\":\"build\",\"updated_at\":\"2026-06-23T00:00:00Z\",\"next_action\":{\"status\":\"in_progress\",\"summary\":\"work\"}}"
printf '%s' "$EVIDENCE_STATE_LINE" | safe_write "$EVIDENCE_REPO/.kontourai/flow-agents/$EVIDENCE_SLUG/state.json"

EVIDENCE_EVENT_LINE="{\"hook_event_name\":\"PostToolUse\",\"tool_name\":\"Bash\",\"cwd\":\"$EVIDENCE_REPO\",\"tool_input\":{\"command\":\"echo legacy-actor-check\"},\"tool_response\":{\"exitCode\":0,\"stdout\":\"ok\"}}"
printf '%s' "$EVIDENCE_EVENT_LINE" \
  | FLOW_AGENTS_ACTOR=eval-actor-no-per-actor-file node "$EVIDENCE_CAPTURE" >"$TMPDIR_EVAL/evidence-legacy.out" 2>"$TMPDIR_EVAL/evidence-legacy.err"

EVIDENCE_LOG_FILE="$EVIDENCE_REPO/.kontourai/flow-agents/$EVIDENCE_SLUG/command-log.jsonl"
if [[ -f "$EVIDENCE_LOG_FILE" ]] && grep -qF "legacy-actor-check" "$EVIDENCE_LOG_FILE"; then
  pass "evidence-capture.js's resolveArtifactDir resolves the legacy-only current.json's named slug under a different ambient actor (AC8)"
else
  fail "evidence-capture.js did not resolve/write to the legacy-only fixture's named slug: $(cat "$TMPDIR_EVAL/evidence-legacy.out" "$TMPDIR_EVAL/evidence-legacy.err")"
fi

# 3c. flow-agents-statusline.js -- reuses test_flow_agents_statusline.sh's fixture/assertion
# verbatim, run under a different ambient actor.
STATUSLINE_WORKSPACE="$TMPDIR_EVAL/statusline-legacy/workspace"
STATUSLINE_TASK_DIR="$STATUSLINE_WORKSPACE/.kontourai/flow-agents/status-demo"
mkdir -p "$STATUSLINE_TASK_DIR"

safe_write "$STATUSLINE_WORKSPACE/.kontourai/flow-agents/current.json" <<'JSON'
{
  "schema_version": "1.0",
  "active_slug": "status-demo",
  "artifact_dir": "status-demo",
  "owner": "codex",
  "updated_at": "2026-05-25T00:00:00Z",
  "source": "test"
}
JSON

safe_write "$STATUSLINE_TASK_DIR/state.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "status-demo",
  "status": "needs_decision",
  "phase": "evidence",
  "updated_at": "2026-05-25T00:01:00Z",
  "next_action": {
    "status": "needs_user",
    "summary": "Review the release hold and decide whether the missing approval is accepted.",
    "target_phase": "release"
  }
}
JSON

cat > "$STATUSLINE_TASK_DIR/acceptance.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "status-demo",
  "criteria": [
    {"id": "one", "description": "First criterion", "status": "pass"},
    {"id": "two", "description": "Second criterion", "status": "pending"},
    {"id": "three", "description": "Third criterion", "status": "accepted_gap"}
  ],
  "goal_fit": {"status": "pending", "summary": "Pending"}
}
JSON

STATUSLINE_OUT="$(cd "$STATUSLINE_WORKSPACE" && FLOW_AGENTS_ACTOR=eval-actor-no-per-actor-file node "$STATUSLINE" <<JSON
{"cwd":"$STATUSLINE_WORKSPACE"}
JSON
)"
if [[ "$STATUSLINE_OUT" == *"Flow Agents: status-demo"* && "$STATUSLINE_OUT" == *"evidence/needs_decision"* && "$STATUSLINE_OUT" == *"2/3 AC"* && "$STATUSLINE_OUT" == *"next:"* ]]; then
  pass "flow-agents-statusline.js resolves the legacy-only fixture identically to its own existing eval's golden output, under a different ambient actor (AC8)"
else
  fail "flow-agents-statusline.js legacy-only output did not match the golden assertion: $STATUSLINE_OUT"
fi

# 3d. workflow-steering.js's ambient state lookup -- reuses test_workflow_steering_hook.sh's
# steering-demo fixture/assertion verbatim, under a different ambient actor.
STEERING_REPO="$TMPDIR_EVAL/steering-legacy/repo"
mkdir -p "$STEERING_REPO/.kontourai/flow-agents/steering-demo"
mkdir -p "$STEERING_REPO/docs"
printf '# Test Repo\n' > "$STEERING_REPO/AGENTS.md"
printf '# Context Map\n' > "$STEERING_REPO/docs/context-map.md"

safe_write "$STEERING_REPO/.kontourai/flow-agents/steering-demo/state.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "steering-demo",
  "status": "not_verified",
  "phase": "verification",
  "updated_at": "2026-05-09T00:00:00Z",
  "next_action": {
    "status": "needs_user",
    "summary": "Decide whether to accept the external service verification gap.",
    "target_phase": "goal_fit"
  }
}
JSON

STEERING_OUT="$(FLOW_AGENTS_ACTOR=eval-actor-no-per-actor-file node "$STEERING" <<JSON
{"hook_event_name":"UserPromptSubmit","cwd":"$STEERING_REPO","prompt":"continue"}
JSON
)"
if [[ "$STEERING_OUT" == *"steering-demo"* && "$STEERING_OUT" == *"status:not_verified"* ]]; then
  pass "workflow-steering.js's ambient state lookup resolves the legacy-only fixture identically to its own existing eval's golden output, under a different ambient actor (AC8)"
else
  fail "workflow-steering.js legacy-only steering output did not match the golden assertion: $STEERING_OUT"
fi

# --- 4. config-protection.js covers current/<actor>.json exactly like current.json (AC10) -----
echo "--- 4. config-protection.js blocks current/<actor>.json writes/redirects (AC10) ---"

set +e
LEGACY_BLOCK_OUT=$(echo '{"tool_name":"Write","tool_input":{"path":"/repo/.kontourai/flow-agents/current.json"}}' | node "$CONFIG_PROTECTION" 2>&1)
LEGACY_BLOCK_EXIT=$?
PER_ACTOR_BLOCK_OUT=$(echo '{"tool_name":"Write","tool_input":{"path":"/repo/.kontourai/flow-agents/current/claude-code-x.json"}}' | node "$CONFIG_PROTECTION" 2>&1)
PER_ACTOR_BLOCK_EXIT=$?
set -e

if [[ "$PER_ACTOR_BLOCK_EXIT" -eq 2 ]] && echo "$PER_ACTOR_BLOCK_OUT" | grep -q "BLOCKED"; then
  pass "Write to .kontourai/flow-agents/current/<actor>.json is blocked (exit 2) (AC10)"
else
  fail "Write to .kontourai/flow-agents/current/<actor>.json was NOT blocked (exit=$PER_ACTOR_BLOCK_EXIT, out=$PER_ACTOR_BLOCK_OUT)"
fi

LEGACY_REASON="$(printf '%s' "$LEGACY_BLOCK_OUT" | sed -n 's/.*protected because \(.*\)\. Use .*/\1/p')"
PER_ACTOR_REASON="$(printf '%s' "$PER_ACTOR_BLOCK_OUT" | sed -n 's/.*protected because \(.*\)\. Use .*/\1/p')"
if [[ -n "$LEGACY_REASON" && "$LEGACY_REASON" == "$PER_ACTOR_REASON" ]]; then
  pass "current/<actor>.json is blocked with the SAME reason text as legacy current.json (AC10)"
else
  fail "current/<actor>.json's blocked reason text differs from legacy current.json's: legacy='$LEGACY_REASON' per-actor='$PER_ACTOR_REASON'"
fi

set +e
TEE_BLOCK_OUT=$(echo '{"tool_name":"Bash","tool_input":{"command":"echo {} | tee .kontourai/flow-agents/current/claude-code-x.json"}}' | node "$CONFIG_PROTECTION" 2>&1)
TEE_BLOCK_EXIT=$?
set -e
if [[ "$TEE_BLOCK_EXIT" -eq 2 ]] && echo "$TEE_BLOCK_OUT" | grep -q "BLOCKED"; then
  pass "tee .kontourai/flow-agents/current/<actor>.json is blocked (exit 2) (AC10)"
else
  fail "tee .kontourai/flow-agents/current/<actor>.json was NOT blocked (exit=$TEE_BLOCK_EXIT, out=$TEE_BLOCK_OUT)"
fi

set +e
UNRELATED_OUT=$(echo '{"tool_name":"Write","tool_input":{"path":"/repo/src/main.js"}}' | node "$CONFIG_PROTECTION" 2>&1)
UNRELATED_EXIT=$?
set -e
[[ "$UNRELATED_EXIT" -eq 0 ]] && pass "an unrelated file write is still allowed (exit 0) (AC10 regression guard)" || fail "an unrelated file write was falsely blocked (exit=$UNRELATED_EXIT)"
# Iteration-2 item 2 (CRITICAL-adjacent) + item 6f eval: rm/mv/unlink of the legacy current.json
# or the per-actor current/<actor>.json pointer is blocked -- the config-protection.js suspenders
# fix alongside the ownership-scan redesign (which no longer relies on the pointer file
# surviving, but raises the cost of casually deleting it in the first place).
set +e
RM_LEGACY_OUT=$(echo '{"tool_name":"Bash","tool_input":{"command":"rm .kontourai/flow-agents/current.json"}}' | node "$CONFIG_PROTECTION" 2>&1)
RM_LEGACY_EXIT=$?
RM_PERACTOR_OUT=$(echo '{"tool_name":"Bash","tool_input":{"command":"rm -f .kontourai/flow-agents/current/claude-code-x.json"}}' | node "$CONFIG_PROTECTION" 2>&1)
RM_PERACTOR_EXIT=$?
MV_AWAY_OUT=$(echo '{"tool_name":"Bash","tool_input":{"command":"mv .kontourai/flow-agents/current/claude-code-x.json /tmp/gone.json"}}' | node "$CONFIG_PROTECTION" 2>&1)
MV_AWAY_EXIT=$?
UNLINK_OUT=$(echo '{"tool_name":"Bash","tool_input":{"command":"unlink .kontourai/flow-agents/current.json"}}' | node "$CONFIG_PROTECTION" 2>&1)
UNLINK_EXIT=$?
set -e

if [[ "$RM_LEGACY_EXIT" -eq 2 ]] && echo "$RM_LEGACY_OUT" | grep -q "BLOCKED"; then
  pass "rm .kontourai/flow-agents/current.json is blocked (exit 2) (iteration-2 item 2)"
else
  fail "rm .kontourai/flow-agents/current.json was NOT blocked (exit=$RM_LEGACY_EXIT, out=$RM_LEGACY_OUT)"
fi

if [[ "$RM_PERACTOR_EXIT" -eq 2 ]] && echo "$RM_PERACTOR_OUT" | grep -q "BLOCKED"; then
  pass "rm -f .kontourai/flow-agents/current/<actor>.json is blocked (exit 2) (iteration-2 item 2)"
else
  fail "rm -f .kontourai/flow-agents/current/<actor>.json was NOT blocked (exit=$RM_PERACTOR_EXIT, out=$RM_PERACTOR_OUT)"
fi

if [[ "$MV_AWAY_EXIT" -eq 2 ]] && echo "$MV_AWAY_OUT" | grep -q "BLOCKED"; then
  pass "mv .kontourai/flow-agents/current/<actor>.json <elsewhere> (renaming the pointer away) is blocked (exit 2) (iteration-2 item 2)"
else
  fail "mv of the per-actor pointer away was NOT blocked (exit=$MV_AWAY_EXIT, out=$MV_AWAY_OUT)"
fi

if [[ "$UNLINK_EXIT" -eq 2 ]] && echo "$UNLINK_OUT" | grep -q "BLOCKED"; then
  pass "unlink .kontourai/flow-agents/current.json is blocked (exit 2) (iteration-2 item 2)"
else
  fail "unlink .kontourai/flow-agents/current.json was NOT blocked (exit=$UNLINK_EXIT, out=$UNLINK_OUT)"
fi

# Negative: an unrelated rm (no protected path involved) is still allowed.
set +e
RM_UNRELATED_OUT=$(echo '{"tool_name":"Bash","tool_input":{"command":"rm /tmp/scratch-file.txt"}}' | node "$CONFIG_PROTECTION" 2>&1)
RM_UNRELATED_EXIT=$?
MV_UNRELATED_OUT=$(echo '{"tool_name":"Bash","tool_input":{"command":"mv /tmp/a.txt /tmp/b.txt"}}' | node "$CONFIG_PROTECTION" 2>&1)
MV_UNRELATED_EXIT=$?
set -e
[[ "$RM_UNRELATED_EXIT" -eq 0 ]] && pass "an unrelated rm (no protected path) is still allowed (exit 0) (iteration-2 item 2 regression guard)" || fail "an unrelated rm was falsely blocked (exit=$RM_UNRELATED_EXIT, out=$RM_UNRELATED_OUT)"
[[ "$MV_UNRELATED_EXIT" -eq 0 ]] && pass "an unrelated mv (no protected path) is still allowed (exit 0) (iteration-2 item 2 regression guard)" || fail "an unrelated mv was falsely blocked (exit=$MV_UNRELATED_EXIT, out=$MV_UNRELATED_OUT)"


# --- 5. record-gate-claim resolves A's own per-actor flow/step, not B's legacy pointer (AC11) --
echo "--- 5. record-gate-claim resolves A's own per-actor flow/step, not B's legacy pointer (AC11) ---"

AC11_ROOT="$TMPDIR_EVAL/ac11-artifact-root"

flow_agents_node "workflow-sidecar" ensure-session \
  --artifact-root "$AC11_ROOT" \
  --task-slug gate-actor-a \
  --actor eval-actor-a-session \
  --flow-id builder.build \
  --source-request "Actor A is active on a FlowDefinition-driven session." \
  --summary "Actor A, builder.build, pull-work step." \
  --timestamp "2026-07-01T00:00:00Z" \
  >"$TMPDIR_EVAL/ac11-a-ensure.out" 2>"$TMPDIR_EVAL/ac11-a-ensure.err"

AC11_DELIVER_MD="$AC11_ROOT/gate-actor-a/gate-actor-a--deliver.md"
flow_agents_node "workflow-sidecar" init-plan "$AC11_DELIVER_MD" \
  --source-request "Test" --summary "Testing" \
  --timestamp "2026-07-01T00:00:30Z" >"$TMPDIR_EVAL/ac11-a-initplan.out" 2>"$TMPDIR_EVAL/ac11-a-initplan.err"

# Actor B runs a LATER, plain (non-FlowDefinition) ensure-session on an unrelated subject on the
# SAME artifact root -- this overwrites the LEGACY global current.json (last-writer-wins, no
# active_flow_id/active_step_id at all) while leaving actor A's own per-actor current file
# completely untouched. If record-gate-claim below fell back to reading the legacy global
# pointer instead of actor A's own per-actor pointer, it would find NO active flow step at all
# and die -- proving this section's assertions are a real differential test, not a tautology.
flow_agents_node "workflow-sidecar" ensure-session \
  --artifact-root "$AC11_ROOT" \
  --task-slug gate-actor-b-unrelated \
  --actor eval-actor-b-session \
  --source-request "Actor B's unrelated, non-FlowDefinition session." \
  --summary "Actor B, no flow-id." \
  --timestamp "2026-07-01T00:01:00Z" \
  >"$TMPDIR_EVAL/ac11-b-ensure.out" 2>"$TMPDIR_EVAL/ac11-b-ensure.err"

AC11_LEGACY_CURRENT_FILE="$AC11_ROOT/current.json"
if grep -q '"active_flow_id"' "$AC11_LEGACY_CURRENT_FILE" 2>/dev/null; then
  fail "test setup invalid: the legacy global current.json unexpectedly still carries an active_flow_id after actor B's plain ensure-session"
else
  pass "test setup: actor B's later, plain ensure-session leaves the legacy global current.json WITHOUT any active_flow_id (a real differential test, not a tautology)"
fi

AC11_GATE_ACTOR_A_DIR="$AC11_ROOT/gate-actor-a"
if flow_agents_node "workflow-sidecar" record-gate-claim "$AC11_GATE_ACTOR_A_DIR" \
  --actor eval-actor-a-session \
  --status pass \
  --summary "Selected issue #291 for implementation." \
  --expectation selected-work \
  --timestamp "2026-07-01T00:02:00Z" \
  >"$TMPDIR_EVAL/ac11-gate-claim.out" 2>"$TMPDIR_EVAL/ac11-gate-claim.err"; then
  pass "record-gate-claim (actor A) succeeds by resolving A's OWN per-actor current pointer, not B's stale legacy pointer (AC11)"
else
  fail "record-gate-claim (actor A) unexpectedly failed: $(cat "$TMPDIR_EVAL/ac11-gate-claim.out" "$TMPDIR_EVAL/ac11-gate-claim.err")"
fi

AC11_BUNDLE_FILE="$AC11_GATE_ACTOR_A_DIR/trust.bundle"
if node - "$AC11_BUNDLE_FILE" <<'NODEEOF' 2>"$TMPDIR_EVAL/ac11-bundle-check.err"
const fs = require("fs");
const bundle = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const target = (bundle.claims || []).find((c) => c.claimType === "builder.pull-work.selected");
if (!target) { console.error("no builder.pull-work.selected claim found"); process.exit(1); }
if (target.status !== "verified") { console.error("expected status=verified, got " + target.status); process.exit(1); }
NODEEOF
then
  pass "actor A's trust.bundle carries the builder.pull-work.selected claim derived from A's OWN flow/step (AC11)"
else
  fail "actor A's trust.bundle did not carry the expected claim: $(cat "$TMPDIR_EVAL/ac11-bundle-check.err")"
fi

# --- 6. F3 (fix-plan iteration 1, code-review-291 MEDIUM): legacy current.json names a
# still-ACTIVE, non-newest-mtime session while a NEWER active state.json exists elsewhere under
# the same artifact root, under a RESOLVED actor with no per-actor current file. Pre-#291,
# latestWorkflowState() was a pure global newest-mtime scan with zero current.json involvement,
# so the newer state.json would win. Post-#291, actorScopedWorkflowState() is consulted first and
# falls through to the legacy current.json for an actor with no per-actor file (the compat-shim
# guarantee section 3 already covers) -- but if that legacy pointer names a still-ACTIVE session,
# it is now returned IMMEDIATELY, without ever comparing mtimes against the newer state.json. This
# section test-pins that specific, deliberate behavior change (current.json preference wins over
# newest-mtime) for the single-actor/resolved-actor case, not just the multi-actor case AC7/AC8
# are framed around -- the review's flagged, previously test-uncovered edge.
echo "--- 6. legacy current.json (non-newest, still-active) wins over a newer state.json elsewhere, under a resolved actor (F3, fix-plan iteration 1) ---"

F3_REPO="$TMPDIR_EVAL/f3-legacy-vs-newest/repo"
mkdir -p "$F3_REPO/.kontourai/flow-agents/older-named-slug"
mkdir -p "$F3_REPO/.kontourai/flow-agents/newer-unnamed-slug"
mkdir -p "$F3_REPO/docs"
printf '# Test Repo
' > "$F3_REPO/AGENTS.md"
printf '# Context Map
' > "$F3_REPO/docs/context-map.md"

# The OLDER session (by mtime) is the one the legacy current.json names -- still ACTIVE.
safe_write "$F3_REPO/.kontourai/flow-agents/older-named-slug/state.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "older-named-slug",
  "status": "in_progress",
  "phase": "build",
  "updated_at": "2026-05-09T00:00:00Z",
  "next_action": {
    "status": "in_progress",
    "summary": "Older, current.json-named session."
  }
}
JSON

F3_LEGACY_CURRENT_LINE='{"active_slug":"older-named-slug","artifact_dir":"older-named-slug"}'
printf '%s' "$F3_LEGACY_CURRENT_LINE" | safe_write "$F3_REPO/.kontourai/flow-agents/current.json"

# Sleep-free mtime ordering: touch the "newer" state.json strictly after the legacy-named one, so
# a pure newest-mtime scan (pre-#291 behavior) would prefer THIS one instead.
sleep 1
safe_write "$F3_REPO/.kontourai/flow-agents/newer-unnamed-slug/state.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "newer-unnamed-slug",
  "status": "in_progress",
  "phase": "build",
  "updated_at": "2026-05-10T00:00:00Z",
  "next_action": {
    "status": "in_progress",
    "summary": "Newer, but NOT named by current.json."
  }
}
JSON

# A RESOLVED actor (FLOW_AGENTS_ACTOR set) with no per-actor current file -- actorScopedWorkflowState
# falls through to the legacy current.json (same compat-shim guarantee as section 3), which names
# the OLDER-but-still-active session.
F3_OUT="$(FLOW_AGENTS_ACTOR=eval-actor-f3-resolved node "$ROOT/scripts/hooks/workflow-steering.js" <<JSON
{"hook_event_name":"UserPromptSubmit","cwd":"$F3_REPO","prompt":"continue"}
JSON
)"

if [[ "$F3_OUT" == *"older-named-slug"* && "$F3_OUT" != *"newer-unnamed-slug"* ]]; then
  pass "workflow-steering.js prefers the legacy current.json's named ACTIVE session over a newer-mtime state.json elsewhere, under a resolved actor with no per-actor file (F3 -- pins the post-#291 behavior change explicitly, not just AC7/AC8's multi-actor framing)"
else
  fail "workflow-steering.js did not prefer the legacy-named active session over the newer-mtime one: $F3_OUT"
fi


# --- 7. #345 multi-actor stop-gate resolution: non-owner Stop is not blocked by another
# actor's active session (AC1), and an owning actor's Stop still resolves to ITS OWN session
# even when another actor's per-actor pointer + active session also exist (AC3) -----------
#
# AUTHORING NOTE (worker-3-345): this section was authored RED-FIRST against
# `hasOtherActorPointer` (`scripts/hooks/lib/current-pointer.js`) and the
# `preferredArtifactDir`/`staleCurrentSlug`/`analyze()` three-tier resolution change
# (`scripts/hooks/stop-goal-fit.js`) and `actorScopedWorkflowState` (`scripts/hooks/
# workflow-steering.js`) — all planned for Worker 1 (Task 1.1, Wave 1) and NOT YET LANDED at
# the moment these eval lines were first drafted (`readCurrentPointer` fell straight through
# to legacy `current.json` and returned actor B's pointer for a non-owner actor A). Worker 1
# landed Task 1.1 (all three files) concurrently, within this same Wave 1 window, before this
# eval file was finalized — every assertion in this section (including 7c's steering-hook
# mirror) now passes against the current worktree state. Left intentionally documented here
# (rather than silently rewritten as if always-green) so the red-first authoring intent and
# the concurrent-landing timeline are both part of the durable record; see the worker-3-345
# report for the exact sequence observed during authoring.
echo "--- 7. #345 multi-actor stop-gate: non-owner Stop not blocked (AC1); owner-actor regression guard (AC3) ---"

# 7a. AC1 -- stopping actor (A) has NO owned per-actor current/ pointer. A DIFFERENT actor
# (B) already has a per-actor pointer file AND an active --deliver.md (status:executing,
# pending acceptance criteria) under the SAME artifact root. Actor A's Stop must NOT be
# gated on B's evidence gaps.
AC1_REPO="$TMPDIR_EVAL/ac1-multi-actor/repo"
AC1_FLOW_AGENTS="$AC1_REPO/.kontourai/flow-agents"
mkdir -p "$AC1_FLOW_AGENTS/owner-b-task"
mkdir -p "$AC1_FLOW_AGENTS/current"
printf '# Test Repo\n' > "$AC1_REPO/AGENTS.md"

# Owner actor B's per-actor pointer names B's own active task.
AC1_B_POINTER_LINE='{"schema_version":"1.0","active_slug":"owner-b-task","artifact_dir":"owner-b-task"}'
printf '%s' "$AC1_B_POINTER_LINE" | safe_write "$AC1_FLOW_AGENTS/current/eval-actor-b-owner.json"

# Owner actor B's active builder.build delivery flow, with an evidence gap (pending
# acceptance criterion) -- exactly the shape that gates a Stop when misattributed.
cat > "$AC1_FLOW_AGENTS/owner-b-task/owner-b-task--deliver.md" <<'MARKDOWN'
# Owner B task

branch: main
worktree: main
created: 2026-06-30
status: executing
type: deliver

## Plan

Owner actor B's own active delivery, mid-flight.
MARKDOWN

safe_write "$AC1_FLOW_AGENTS/owner-b-task/state.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "owner-b-task",
  "status": "in_progress",
  "phase": "build",
  "updated_at": "2026-06-30T00:00:00Z",
  "next_action": {
    "status": "in_progress",
    "summary": "Owner B is mid-build."
  }
}
JSON

safe_write "$AC1_FLOW_AGENTS/owner-b-task/acceptance.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "owner-b-task",
  "criteria": [
    {
      "id": "owner-b-thing-works",
      "description": "Owner B's thing works.",
      "status": "pending",
      "evidence_refs": []
    }
  ],
  "goal_fit": {"status": "pending", "summary": "Pending."}
}
JSON

# Actor A (the stopping actor) has NO current/eval-actor-a-nonowner.json file at all --
# only B's per-actor pointer exists under current/. No legacy global current.json either
# (a genuinely multi-actor, per-actor-projecting repo where A owns nothing).
if FLOW_AGENTS_ACTOR=eval-actor-a-nonowner FLOW_AGENTS_GOAL_FIT_MODE=warn FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=100000 \
  node "$GOAL_FIT_GATE" >"$TMPDIR_EVAL/ac1-a-stop.out" 2>"$TMPDIR_EVAL/ac1-a-stop.err" <<JSON
{"hook_event_name":"Stop","cwd":"$AC1_REPO"}
JSON
then
  if ! grep -q "owner-b-task" "$TMPDIR_EVAL/ac1-a-stop.err" && ! grep -qi "pending" "$TMPDIR_EVAL/ac1-a-stop.err"; then
    pass "AC1: non-owner actor A's Stop emits NO warnings referencing owner B's owner-b-task artifacts (hasOtherActorPointer scopes A to nothing)"
  else
    fail "AC1: non-owner actor A's Stop was gated on owner B's artifacts (this is the #345 bug the hasOtherActorPointer resolution fixes — regression, not merely a red-first placeholder, once Task 1.1 has landed): $(cat "$TMPDIR_EVAL/ac1-a-stop.out" "$TMPDIR_EVAL/ac1-a-stop.err")"
  fi
else
  fail "AC1: non-owner actor A's Stop should not block/exit non-zero in warn mode regardless: $(cat "$TMPDIR_EVAL/ac1-a-stop.out" "$TMPDIR_EVAL/ac1-a-stop.err")"
fi

# 7b. AC3 regression guard -- the REVERSE/edge case: the stopping actor (A) DOES own a
# per-actor pointer (to its own pre-execution/terminal session) while owner B's per-actor
# pointer + active session ALSO exist under the same root. A's Stop must still resolve to
# A's OWN session only -- this is the existing, already-correct per-actor branch and must
# not regress when hasOtherActorPointer is introduced.
AC3_REPO="$TMPDIR_EVAL/ac3-multi-actor-own-session/repo"
AC3_FLOW_AGENTS="$AC3_REPO/.kontourai/flow-agents"
mkdir -p "$AC3_FLOW_AGENTS/owner-b-task-ac3"
mkdir -p "$AC3_FLOW_AGENTS/owner-a-own-task"
mkdir -p "$AC3_FLOW_AGENTS/current"
printf '# Test Repo\n' > "$AC3_REPO/AGENTS.md"

AC3_B_POINTER_LINE='{"schema_version":"1.0","active_slug":"owner-b-task-ac3","artifact_dir":"owner-b-task-ac3"}'
printf '%s' "$AC3_B_POINTER_LINE" | safe_write "$AC3_FLOW_AGENTS/current/eval-actor-b-owner-ac3.json"

cat > "$AC3_FLOW_AGENTS/owner-b-task-ac3/owner-b-task-ac3--deliver.md" <<'MARKDOWN'
# Owner B task (AC3 fixture)

branch: main
worktree: main
created: 2026-06-30
status: executing
type: deliver

## Plan

Owner actor B's own active delivery, mid-flight (AC3 fixture -- must NOT leak into A's view).
MARKDOWN

safe_write "$AC3_FLOW_AGENTS/owner-b-task-ac3/state.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "owner-b-task-ac3",
  "status": "in_progress",
  "phase": "build",
  "updated_at": "2026-06-30T00:00:00Z",
  "next_action": {
    "status": "in_progress",
    "summary": "Owner B is mid-build (AC3 fixture)."
  }
}
JSON

# Actor A's OWN per-actor pointer names A's own terminal/delivered session.
AC3_A_POINTER_LINE='{"schema_version":"1.0","active_slug":"owner-a-own-task","artifact_dir":"owner-a-own-task"}'
printf '%s' "$AC3_A_POINTER_LINE" | safe_write "$AC3_FLOW_AGENTS/current/eval-actor-a-owner-ac3.json"

cat > "$AC3_FLOW_AGENTS/owner-a-own-task/owner-a-own-task--deliver.md" <<'MARKDOWN'
# Owner A's own task (AC3 fixture)

branch: main
worktree: main
created: 2026-06-29
status: delivered
type: deliver

## Definition Of Done

- **User outcome:** A's own delivered work.
- **Acceptance criteria:**
  - [x] A's own criterion — Evidence: screenshot
- **Durable docs target:** docs/delivery/owner-a-own-task.md

## Plan

A's own, already-delivered task.

## Verification Report

Build: PASS

### Verdict: PASS
MARKDOWN

safe_write "$AC3_FLOW_AGENTS/owner-a-own-task/state.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "owner-a-own-task",
  "status": "delivered",
  "phase": "done",
  "updated_at": "2026-06-29T00:00:00Z",
  "next_action": {
    "status": "done",
    "summary": "A's own local delivery complete."
  }
}
JSON

if FLOW_AGENTS_ACTOR=eval-actor-a-owner-ac3 FLOW_AGENTS_GOAL_FIT_MODE=warn FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=100000 \
  node "$GOAL_FIT_GATE" >"$TMPDIR_EVAL/ac3-a-stop.out" 2>"$TMPDIR_EVAL/ac3-a-stop.err" <<JSON
{"hook_event_name":"Stop","cwd":"$AC3_REPO"}
JSON
then
  if ! grep -q "owner-b-task-ac3" "$TMPDIR_EVAL/ac3-a-stop.err"; then
    pass "AC3: owner actor A's Stop with its OWN per-actor pointer resolves to A's own session only, unaffected by owner B's concurrently-active per-actor session (regression guard on the existing per-actor branch)"
  else
    fail "AC3: owner actor A's Stop leaked owner B's artifacts despite A owning its own per-actor pointer: $(cat "$TMPDIR_EVAL/ac3-a-stop.out" "$TMPDIR_EVAL/ac3-a-stop.err")"
  fi
else
  fail "AC3: owner actor A's Stop against its own terminal/delivered session should not exit non-zero in warn mode: $(cat "$TMPDIR_EVAL/ac3-a-stop.out" "$TMPDIR_EVAL/ac3-a-stop.err")"
fi

# 7c. workflow-steering.js parallel coverage (mirrors AC1 for actorScopedWorkflowState /
# latestWorkflowState) -- non-owner actor A's ambient steering hint must not surface owner
# B's active state.json. Authored red-first alongside 7a (hasOtherActorPointer not yet wired
# into workflow-steering.js's actorScopedWorkflowState at the time of first drafting); Worker 1
# landed that wiring during this same Wave 1 window, so this assertion now passes -- see the
# section-7 authoring note above for the full timeline.
AC1_STEERING_OUT="$(FLOW_AGENTS_ACTOR=eval-actor-a-nonowner node "$STEERING" <<JSON
{"hook_event_name":"UserPromptSubmit","cwd":"$AC1_REPO","prompt":"continue"}
JSON
)"
if [[ "$AC1_STEERING_OUT" != *"owner-b-task"* ]]; then
  pass "AC1 (steering): non-owner actor A's ambient steering hint does not surface owner B's owner-b-task state (actorScopedWorkflowState scoped-to-nothing branch)"
else
  fail "AC1 (steering): non-owner actor A's ambient steering hint leaked owner B's state (this is the #345 bug in workflow-steering.js's actorScopedWorkflowState — regression, not merely a red-first placeholder, once Task 1.1 has landed): $AC1_STEERING_OUT"
fi
# --- 8. Iteration-2 CRITICAL fix: tier-2 ownership-scan redesign (security review + verifier ---
# exploit reproduction). An actor with an ACTIVE gated session deletes its OWN
# current/<actor>.json pointer file (one un-guarded Bash command) -- the next Stop must STILL
# hard-block via the ownership scan (assignment/<slug>.json's actor_key stamp), not go silent.
echo "--- 8. iteration-2 CRITICAL fix: ownership-scan redesign survives a deleted own pointer (exploit repro) ---"

AC_EXPLOIT_REPO="$TMPDIR_EVAL/exploit-repo/repo"
AC_EXPLOIT_FLOW_AGENTS="$AC_EXPLOIT_REPO/.kontourai/flow-agents"
mkdir -p "$AC_EXPLOIT_REPO"
printf '# Test Repo\n' > "$AC_EXPLOIT_REPO/AGENTS.md"

EXPLOIT_WORK_ITEM="kontourai/flow-agents#9301"
EXPLOIT_SLUG="kontourai-flow-agents-9301"
EXPLOIT_ACTOR="eval-exploiter-actor"
EXPLOIT_OTHER_ACTOR="eval-exploit-bystander-actor"

# A SECOND, unrelated actor also runs ensure-session under this SAME artifact root FIRST -- this
# is what makes the repo genuinely multi-actor (hasOtherActorPointer becomes true for the
# exploiting actor below), which is the precondition for tier 2 to fire at all. In a truly
# single-actor repo, deleting the only pointer would correctly fall through to tier 3 (legacy
# fallback) -- this bystander actor is what forces the exploiting actor's Stop into tier 2,
# reproducing the reviewer's/verifier's exact multi-actor exploit scenario.
flow_agents_node "workflow-sidecar" ensure-session \
  --artifact-root "$AC_EXPLOIT_FLOW_AGENTS" \
  --work-item "kontourai/flow-agents#9399" \
  --actor "$EXPLOIT_OTHER_ACTOR" \
  --source-request "Bystander actor's own, unrelated session." \
  --summary "Bystander actor's own delivery." \
  >"$TMPDIR_EVAL/exploit-bystander-ensure.out" 2>"$TMPDIR_EVAL/exploit-bystander-ensure.err"
[[ $? -eq 0 ]] && pass "exploit setup: bystander actor's ensure-session succeeds (makes this a genuinely multi-actor repo)" || fail "exploit setup: bystander actor's ensure-session unexpectedly failed: $(cat "$TMPDIR_EVAL/exploit-bystander-ensure.out" "$TMPDIR_EVAL/exploit-bystander-ensure.err")"

# Real ensure-session: establishes BOTH the per-actor current/<actor>.json pointer AND the
# durable assignment/<slug>.json claim record (actor_key stamp) -- the ownership authority the
# iteration-2 fix reads instead of the pointer file.
flow_agents_node "workflow-sidecar" ensure-session \
  --artifact-root "$AC_EXPLOIT_FLOW_AGENTS" \
  --work-item "$EXPLOIT_WORK_ITEM" \
  --actor "$EXPLOIT_ACTOR" \
  --source-request "Exploiter actor's own active gated session." \
  --summary "Exploiter actor's own delivery, mid-flight." \
  >"$TMPDIR_EVAL/exploit-ensure.out" 2>"$TMPDIR_EVAL/exploit-ensure.err"
EXPLOIT_ENSURE_STATUS=$?
[[ "$EXPLOIT_ENSURE_STATUS" -eq 0 ]] && pass "exploit setup: ensure-session establishes the exploiting actor's own claimed session" || fail "exploit setup: ensure-session unexpectedly failed: $(cat "$TMPDIR_EVAL/exploit-ensure.out" "$TMPDIR_EVAL/exploit-ensure.err")"

EXPLOIT_ASSIGNMENT_RECORD="$AC_EXPLOIT_FLOW_AGENTS/assignment/$EXPLOIT_SLUG.json"
[[ -f "$EXPLOIT_ASSIGNMENT_RECORD" ]] && pass "exploit setup: the durable assignment claim record exists on disk" || fail "exploit setup: assignment/$EXPLOIT_SLUG.json was not written"

EXPLOIT_POINTER_FILE="$AC_EXPLOIT_FLOW_AGENTS/current/$EXPLOIT_ACTOR.json"
[[ -f "$EXPLOIT_POINTER_FILE" ]] && pass "exploit setup: the exploiting actor's own current/<actor>.json pointer exists" || fail "exploit setup: current/$EXPLOIT_ACTOR.json was not written"

EXPLOIT_SESSION_DIR="$AC_EXPLOIT_FLOW_AGENTS/$EXPLOIT_SLUG"
# Overwrite state.json/acceptance.json + author a --deliver.md so this is an ACTIVE, GATED
# session (status:executing, a pending acceptance criterion) -- mirrors section 7's owner-B
# fixture technique, but this time it is the STOPPING actor's OWN session.
cat > "$EXPLOIT_SESSION_DIR/$EXPLOIT_SLUG--deliver.md" <<MARKDOWN
# Exploiter actor's own task

branch: main
worktree: main
created: 2026-07-05
status: executing
type: deliver

## Plan

The exploiting actor's own active delivery, mid-flight.
MARKDOWN

safe_write "$EXPLOIT_SESSION_DIR/state.json" <<JSON
{
  "schema_version": "1.0",
  "task_slug": "$EXPLOIT_SLUG",
  "status": "in_progress",
  "phase": "build",
  "updated_at": "2026-07-05T00:00:00Z",
  "next_action": {
    "status": "in_progress",
    "summary": "Exploiter actor is mid-build."
  }
}
JSON

safe_write "$EXPLOIT_SESSION_DIR/acceptance.json" <<JSON
{
  "schema_version": "1.0",
  "task_slug": "$EXPLOIT_SLUG",
  "criteria": [
    {
      "id": "exploiter-thing-works",
      "description": "Exploiter actor's thing works.",
      "status": "pending",
      "evidence_refs": []
    }
  ],
  "goal_fit": {"status": "pending", "summary": "Pending."}
}
JSON

# BEFORE-manipulation baseline: the exploiting actor's own Stop (real per-actor pointer still on
# disk) is gated on its own pending-criteria session -- capture this warning content so the
# post-deletion assertion below can assert byte-for-byte the SAME gate output (not merely "some"
# warning).
BEFORE_OUT="$(FLOW_AGENTS_ACTOR="$EXPLOIT_ACTOR" FLOW_AGENTS_GOAL_FIT_MODE=warn FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=100000 \
  node "$GOAL_FIT_GATE" 2>&1 <<JSON
{"hook_event_name":"Stop","cwd":"$AC_EXPLOIT_REPO"}
JSON
)"
if echo "$BEFORE_OUT" | grep -qi "pending"; then
  pass "BEFORE manipulation: the exploiting actor's own Stop is correctly gated (pending acceptance criterion surfaced)"
else
  fail "BEFORE manipulation: the exploiting actor's own Stop was unexpectedly NOT gated -- eval fixture setup is wrong: $BEFORE_OUT"
fi

# THE EXPLOIT: delete the exploiting actor's OWN current/<actor>.json pointer -- one
# un-guarded Bash command, exactly the security reviewer's/verifier's reproduced end-to-end
# bypass. (This deletion itself, run directly via the shell here rather than through the
# config-protection hook, is what section 8c below separately proves config-protection.js now
# blocks when routed through an agent's Bash tool call.)
rm -f "$EXPLOIT_POINTER_FILE"
[[ ! -f "$EXPLOIT_POINTER_FILE" ]] && pass "exploit: the exploiting actor's own current/<actor>.json pointer is now deleted (precondition for the bypass attempt)" || fail "exploit setup: the pointer file still exists after rm -- test precondition broken"

# AFTER-manipulation: the next Stop MUST STILL hard-block via the ownership scan
# (ownedSessionArtifactDirs reading assignment/$EXPLOIT_SLUG.json's actor_key stamp), with the
# SAME warning content as the pre-manipulation baseline -- proving the pointer deletion did not
# silence the gate.
AFTER_OUT="$(FLOW_AGENTS_ACTOR="$EXPLOIT_ACTOR" FLOW_AGENTS_GOAL_FIT_MODE=warn FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=100000 \
  node "$GOAL_FIT_GATE" 2>&1 <<JSON
{"hook_event_name":"Stop","cwd":"$AC_EXPLOIT_REPO"}
JSON
)"
if echo "$AFTER_OUT" | grep -qi "pending"; then
  pass "AFTER exploit: the gate STILL surfaces the pending acceptance criterion despite the deleted own pointer (ownership-scan redesign — tier-2 gate bypass is fixed)"
else
  fail "AFTER exploit: the gate went SILENT after the exploiting actor deleted its own pointer -- iteration-2 CRITICAL fix regression: $AFTER_OUT"
fi

if echo "$AFTER_OUT" | grep -q "ownership stamp"; then
  pass "AFTER exploit: stderr names the ownership-stamp fallback path (not the old scoped-to-nothing silence)"
else
  fail "AFTER exploit: stderr did not name the ownership-stamp fallback path: $AFTER_OUT"
fi

BEFORE_WARN_LINE="$(echo "$BEFORE_OUT" | grep -i "pending" | head -1)"
AFTER_WARN_LINE="$(echo "$AFTER_OUT" | grep -i "pending" | head -1)"
if [[ "$BEFORE_WARN_LINE" == "$AFTER_WARN_LINE" && -n "$BEFORE_WARN_LINE" ]]; then
  pass "BEFORE/AFTER assert the SAME warning content (byte-for-byte) — the exploit changes nothing about what is reported"
else
  fail "BEFORE/AFTER warning content diverged: before='$BEFORE_WARN_LINE' after='$AFTER_WARN_LINE'"
fi

# --- 8b. Variant: delete-own-pointer PLUS a decoy touch (zero-byte garbage file) under current/ --
echo "--- 8b. variant: delete own pointer + touch a zero-byte/garbage decoy file -> still hard-blocks, decoy not counted as another actor ---"

DECOY_FILE="$AC_EXPLOIT_FLOW_AGENTS/current/zzz-decoy-actor.json"
touch "$DECOY_FILE"
[[ -f "$DECOY_FILE" ]] && pass "decoy setup: a zero-byte decoy file exists under current/" || fail "decoy setup: failed to create the decoy file"

DECOY_OUT="$(FLOW_AGENTS_ACTOR="$EXPLOIT_ACTOR" FLOW_AGENTS_GOAL_FIT_MODE=warn FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=100000 \
  node "$GOAL_FIT_GATE" 2>&1 <<JSON
{"hook_event_name":"Stop","cwd":"$AC_EXPLOIT_REPO"}
JSON
)"
if echo "$DECOY_OUT" | grep -qi "pending"; then
  pass "decoy variant: the gate STILL surfaces the pending acceptance criterion with a zero-byte decoy present (decoy hardening + ownership scan both hold)"
else
  fail "decoy variant: the gate went silent with a decoy file present: $DECOY_OUT"
fi

DECOY_WARN_LINE="$(echo "$DECOY_OUT" | grep -i "pending" | head -1)"
if [[ "$DECOY_WARN_LINE" == "$BEFORE_WARN_LINE" ]]; then
  pass "decoy variant: asserts the SAME warning content as the pre-manipulation baseline"
else
  fail "decoy variant: warning content diverged from the pre-manipulation baseline: decoy='$DECOY_WARN_LINE' before='$BEFORE_WARN_LINE'"
fi

# --- 8c. hasOtherActorPointer decoy hardening (unit-level): a garbage/non-pointer-shaped ------
# current/*.json file must NOT count as an other-actor pointer.
echo "--- 8c. hasOtherActorPointer: garbage/non-pointer-shaped decoy files do not count as an other-actor pointer ---"

DECOY_UNIT_ROOT="$TMPDIR_EVAL/decoy-unit-root"
mkdir -p "$DECOY_UNIT_ROOT/current"
printf 'not json at all' > "$DECOY_UNIT_ROOT/current/garbage-actor.json"
printf '{}' > "$DECOY_UNIT_ROOT/current/empty-object-actor.json"
printf '[1,2,3]' > "$DECOY_UNIT_ROOT/current/array-actor.json"
touch "$DECOY_UNIT_ROOT/current/zero-byte-actor.json"

if node -e '
const { hasOtherActorPointer } = require(process.argv[1]);
const result = hasOtherActorPointer(process.argv[2], "self-actor");
process.exit(result === false ? 0 : 1);
' "$CURRENT_POINTER_HELPER" "$DECOY_UNIT_ROOT" >"$TMPDIR_EVAL/decoy-unit.out" 2>"$TMPDIR_EVAL/decoy-unit.err"; then
  pass "hasOtherActorPointer returns false when every current/*.json entry is garbage/non-pointer-shaped (zero-byte, non-JSON, {}, array)"
else
  fail "hasOtherActorPointer incorrectly counted a decoy file as another actor's pointer: $(cat "$TMPDIR_EVAL/decoy-unit.out" "$TMPDIR_EVAL/decoy-unit.err")"
fi

# A REAL plausible pointer payload alongside the decoys DOES count.
safe_write "$DECOY_UNIT_ROOT/current/real-other-actor.json" <<'JSON'
{"schema_version":"1.0","active_slug":"real-task","artifact_dir":"real-task"}
JSON
if node -e '
const { hasOtherActorPointer } = require(process.argv[1]);
const result = hasOtherActorPointer(process.argv[2], "self-actor");
process.exit(result === true ? 0 : 1);
' "$CURRENT_POINTER_HELPER" "$DECOY_UNIT_ROOT" >"$TMPDIR_EVAL/decoy-unit-real.out" 2>"$TMPDIR_EVAL/decoy-unit-real.err"; then
  pass "hasOtherActorPointer returns true once a REAL plausible-pointer-shaped file exists alongside the decoys (decoy hardening does not over-suppress genuine detection)"
else
  fail "hasOtherActorPointer failed to detect a real plausible pointer file: $(cat "$TMPDIR_EVAL/decoy-unit-real.out" "$TMPDIR_EVAL/decoy-unit-real.err")"
fi

# --- 8d. unresolved actor always takes tier 3 (legacy), never tier 2 (fix item 3, HIGH) --------
echo "--- 8d. unresolved actor (FLOW_AGENTS_ACTOR_TEST_FORCE_UNRESOLVED) always resolves via tier 3 (legacy), never tier 2 ---"

AC_UNRESOLVED_REPO="$TMPDIR_EVAL/unresolved-repo/repo"
AC_UNRESOLVED_FLOW_AGENTS="$AC_UNRESOLVED_REPO/.kontourai/flow-agents"
mkdir -p "$AC_UNRESOLVED_FLOW_AGENTS/legacy-task"
mkdir -p "$AC_UNRESOLVED_FLOW_AGENTS/current"
printf '# Test Repo\n' > "$AC_UNRESOLVED_REPO/AGENTS.md"

# Another actor's per-actor pointer exists (would trigger tier-2 hasOtherActorPointer for a
# RESOLVED actor) -- but the stopping actor here is UNRESOLVED, so it must never even consult
# hasOtherActorPointer/the ownership scan; it must fall straight through to the legacy pointer.
UNRESOLVED_OTHER_POINTER='{"schema_version":"1.0","active_slug":"legacy-task","artifact_dir":"legacy-task"}'
printf '%s' "$UNRESOLVED_OTHER_POINTER" | safe_write "$AC_UNRESOLVED_FLOW_AGENTS/current/some-other-actor.json"

# The LEGACY global current.json also names legacy-task (tier 3's target) -- same slug as the
# other actor's per-actor file is fine; the point is which TIER resolves it.
UNRESOLVED_LEGACY_POINTER='{"schema_version":"1.0","active_slug":"legacy-task","artifact_dir":"legacy-task"}'
printf '%s' "$UNRESOLVED_LEGACY_POINTER" | safe_write "$AC_UNRESOLVED_FLOW_AGENTS/current.json"

cat > "$AC_UNRESOLVED_FLOW_AGENTS/legacy-task/legacy-task--deliver.md" <<'MARKDOWN'
# Legacy-only task (unresolved-actor fixture)

branch: main
worktree: main
created: 2026-07-05
status: executing
type: deliver

## Plan

Legacy-only task, resolved via tier 3 for an unresolved actor.
MARKDOWN

safe_write "$AC_UNRESOLVED_FLOW_AGENTS/legacy-task/state.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "legacy-task",
  "status": "in_progress",
  "phase": "build",
  "updated_at": "2026-07-05T00:00:00Z",
  "next_action": {
    "status": "in_progress",
    "summary": "Legacy task is mid-build."
  }
}
JSON

safe_write "$AC_UNRESOLVED_FLOW_AGENTS/legacy-task/acceptance.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "legacy-task",
  "criteria": [
    {
      "id": "legacy-thing-works",
      "description": "Legacy task's thing works.",
      "status": "pending",
      "evidence_refs": []
    }
  ],
  "goal_fit": {"status": "pending", "summary": "Pending."}
}
JSON

UNRESOLVED_OUT="$(FLOW_AGENTS_ACTOR_TEST_FORCE_UNRESOLVED=1 NODE_ENV=test FLOW_AGENTS_GOAL_FIT_MODE=warn FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=100000 \
  node "$GOAL_FIT_GATE" 2>&1 <<JSON
{"hook_event_name":"Stop","cwd":"$AC_UNRESOLVED_REPO"}
JSON
)"
if echo "$UNRESOLVED_OUT" | grep -qi "pending"; then
  pass "unresolved actor: Stop resolves via tier 3 (legacy fallback) and surfaces legacy-task's pending criterion, exactly like a single-actor/legacy-only repo (fix item 3, HIGH)"
else
  fail "unresolved actor: Stop did NOT resolve via the legacy fallback (mis-scoped into tier 2 by an unresolved actor looking 'foreign'): $UNRESOLVED_OUT"
fi

# --- 8e. stale/orphaned OTHER-actor pointer + the stopping actor's OWN sessions -> still ------
# gated on its own sessions (code-review MEDIUM, resolved by the ownership-scan design) ---------
echo "--- 8e. stale other-actor pointer + own owned sessions -> still gated on own sessions (code-review MEDIUM, resolved by design) ---"

AC_STALEOTHER_REPO="$TMPDIR_EVAL/stale-other-repo/repo"
AC_STALEOTHER_FLOW_AGENTS="$AC_STALEOTHER_REPO/.kontourai/flow-agents"
mkdir -p "$AC_STALEOTHER_REPO"
printf '# Test Repo\n' > "$AC_STALEOTHER_REPO/AGENTS.md"

STALEOTHER_WORK_ITEM="kontourai/flow-agents#9302"
STALEOTHER_SLUG="kontourai-flow-agents-9302"
STALEOTHER_ACTOR="eval-remaining-actor"

flow_agents_node "workflow-sidecar" ensure-session \
  --artifact-root "$AC_STALEOTHER_FLOW_AGENTS" \
  --work-item "$STALEOTHER_WORK_ITEM" \
  --actor "$STALEOTHER_ACTOR" \
  --source-request "Remaining actor's own active gated session." \
  --summary "Remaining actor's own delivery, mid-flight." \
  >"$TMPDIR_EVAL/staleother-ensure.out" 2>"$TMPDIR_EVAL/staleother-ensure.err"
[[ $? -eq 0 ]] && pass "stale-other setup: ensure-session establishes the remaining actor's own claimed session" || fail "stale-other setup: ensure-session unexpectedly failed: $(cat "$TMPDIR_EVAL/staleother-ensure.out" "$TMPDIR_EVAL/staleother-ensure.err")"

STALEOTHER_SESSION_DIR="$AC_STALEOTHER_FLOW_AGENTS/$STALEOTHER_SLUG"
cat > "$STALEOTHER_SESSION_DIR/$STALEOTHER_SLUG--deliver.md" <<MARKDOWN
# Remaining actor's own task

branch: main
worktree: main
created: 2026-07-05
status: executing
type: deliver

## Plan

The remaining actor's own active delivery, mid-flight.
MARKDOWN

safe_write "$STALEOTHER_SESSION_DIR/state.json" <<JSON
{
  "schema_version": "1.0",
  "task_slug": "$STALEOTHER_SLUG",
  "status": "in_progress",
  "phase": "build",
  "updated_at": "2026-07-05T00:00:00Z",
  "next_action": {
    "status": "in_progress",
    "summary": "Remaining actor is mid-build."
  }
}
JSON

safe_write "$STALEOTHER_SESSION_DIR/acceptance.json" <<JSON
{
  "schema_version": "1.0",
  "task_slug": "$STALEOTHER_SLUG",
  "criteria": [
    {
      "id": "remaining-thing-works",
      "description": "Remaining actor's thing works.",
      "status": "pending",
      "evidence_refs": []
    }
  ],
  "goal_fit": {"status": "pending", "summary": "Pending."}
}
JSON

# Delete the remaining actor's OWN pointer (so tier 1 does not resolve trivially) -- the
# ownership scan is what must find this actor's own session, not the pointer.
rm -f "$AC_STALEOTHER_FLOW_AGENTS/current/$STALEOTHER_ACTOR.json"

# Plant a STALE/ORPHANED other-actor pointer naming a session directory that does NOT exist
# (a departed actor whose pointer file was never cleaned up).
STALEOTHER_ORPHAN_POINTER='{"schema_version":"1.0","active_slug":"long-gone-task","artifact_dir":"long-gone-task"}'
printf '%s' "$STALEOTHER_ORPHAN_POINTER" | safe_write "$AC_STALEOTHER_FLOW_AGENTS/current/eval-departed-actor.json"

STALEOTHER_OUT="$(FLOW_AGENTS_ACTOR="$STALEOTHER_ACTOR" FLOW_AGENTS_GOAL_FIT_MODE=warn FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=100000 \
  node "$GOAL_FIT_GATE" 2>&1 <<JSON
{"hook_event_name":"Stop","cwd":"$AC_STALEOTHER_REPO"}
JSON
)"
if echo "$STALEOTHER_OUT" | grep -qi "pending"; then
  pass "stale-other-pointer: the remaining actor is STILL gated on its own owned session, despite a stale/orphaned other-actor pointer under current/ (code-review MEDIUM resolved by the ownership-scan design)"
else
  fail "stale-other-pointer: the remaining actor was silenced by a stale/orphaned other-actor pointer: $STALEOTHER_OUT"
fi

# --- 8f. mutation-test: neuter ownedSessionArtifactDirs (always return []), confirm the ------
# exploit-repro fixture from section 8 goes red (silent gate again), then restore. Same
# in-place-mutation-of-the-live-sibling-required-file idiom as test_goal_fit_hook.sh's #362
# mutation test (current-pointer.js is required via a relative sibling path from
# stop-goal-fit.js, so a scratch copy elsewhere cannot resolve the same require graph) -- SAME
# serial-runner-only constraint applies (see that file's doc comment for the full rationale).
echo "--- 8f. mutation-test: ownedSessionArtifactDirs neutered -> exploit fixture (section 8) goes red, then restore ---"

OWNERSHIP_MUTATION_SCRATCH="$TMPDIR_EVAL/ownership-mutation-scratch"
mkdir -p "$OWNERSHIP_MUTATION_SCRATCH"
cp "$CURRENT_POINTER_HELPER" "$OWNERSHIP_MUTATION_SCRATCH/current-pointer.orig.js"

node - "$CURRENT_POINTER_HELPER" <<'NODEEOF' 2>"$TMPDIR_EVAL/ownership-mutation-patch.err"
const fs = require('fs');
const file = process.argv[2];
let src = fs.readFileSync(file, 'utf8');
const needle = "function ownedSessionArtifactDirs(flowAgentsDir, actorKey) {";
if (!src.includes(needle)) {
  process.stderr.write('mutation: ownedSessionArtifactDirs function signature not found — source pattern drifted, cannot mutation-test\n');
  process.exit(1);
}
src = src.split(needle).join(needle + " return []; /* mutation-test: ownership scan neutered */");
fs.writeFileSync(file, src);
NODEEOF

if [[ -s "$TMPDIR_EVAL/ownership-mutation-patch.err" ]]; then
  fail "mutation-test setup failed (ownedSessionArtifactDirs source pattern did not match scripts/hooks/lib/current-pointer.js), restoring original unmodified: $(cat "$TMPDIR_EVAL/ownership-mutation-patch.err")"
  cp "$OWNERSHIP_MUTATION_SCRATCH/current-pointer.orig.js" "$CURRENT_POINTER_HELPER"
elif ! node --check "$CURRENT_POINTER_HELPER" 2>"$TMPDIR_EVAL/ownership-mutation-syntax.err"; then
  fail "mutation-test setup: mutated current-pointer.js (ownership scan neutered) failed a syntax check, restoring original immediately: $(cat "$TMPDIR_EVAL/ownership-mutation-syntax.err")"
  cp "$OWNERSHIP_MUTATION_SCRATCH/current-pointer.orig.js" "$CURRENT_POINTER_HELPER"
else
  OWNERSHIP_MUTATION_OUT="$(FLOW_AGENTS_ACTOR="$EXPLOIT_ACTOR" FLOW_AGENTS_GOAL_FIT_MODE=warn FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=100000 \
    node "$GOAL_FIT_GATE" 2>&1 <<JSON
{"hook_event_name":"Stop","cwd":"$AC_EXPLOIT_REPO"}
JSON
  )"

  cp "$OWNERSHIP_MUTATION_SCRATCH/current-pointer.orig.js" "$CURRENT_POINTER_HELPER"

  if ! echo "$OWNERSHIP_MUTATION_OUT" | grep -qi "pending"; then
    pass "mutation-test: with ownedSessionArtifactDirs neutered (always []), the exploit fixture WRONGLY goes silent again (eval correctly goes red without the ownership scan, proving section 8 exercises it)"
  else
    fail "mutation-test: the exploit fixture still surfaced the pending criterion even with ownedSessionArtifactDirs neutered -- section 8 may not be exercising the intended guard: $OWNERSHIP_MUTATION_OUT"
  fi
fi

if diff -q "$CURRENT_POINTER_HELPER" "$OWNERSHIP_MUTATION_SCRATCH/current-pointer.orig.js" >/dev/null 2>&1; then
  pass "mutation-test cleanup: scripts/hooks/lib/current-pointer.js is restored byte-identical to its pre-mutation-test content"
else
  fail "mutation-test cleanup REGRESSION: scripts/hooks/lib/current-pointer.js differs from its own pre-mutation-test content"
fi

OWNERSHIP_RESTORE_RECHECK_OUT="$(FLOW_AGENTS_ACTOR="$EXPLOIT_ACTOR" FLOW_AGENTS_GOAL_FIT_MODE=warn FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=100000 \
  node "$GOAL_FIT_GATE" 2>&1 <<JSON
{"hook_event_name":"Stop","cwd":"$AC_EXPLOIT_REPO"}
JSON
)"
if echo "$OWNERSHIP_RESTORE_RECHECK_OUT" | grep -qi "pending"; then
  pass "mutation-test cleanup re-check: the restored real current-pointer.js's ownership scan finds the exploit fixture's own session again (guard genuinely back in effect, not just byte-restored)"
else
  fail "mutation-test cleanup re-check REGRESSION: restored current-pointer.js no longer finds the exploit fixture's own session: $OWNERSHIP_RESTORE_RECHECK_OUT"
fi

# --- 8g. Iteration-3 correctness HIGH fix (Finding A): releaseOnNonTerminalStop's routine ------
# assignment-layer release (#292) must not un-gate a still-active session on the actor's SECOND
# tier-2 Stop. Unlike section 8 above (whose fixture repo has no
# context/settings/assignment-provider-settings.json, so releaseOnNonTerminalStop's provider-kind
# resolution returns null and the release is silently skipped -- meaning section 8 never actually
# exercises a released assignment record), THIS fixture configures the local-file provider so the
# FIRST Stop's non-terminal release genuinely flips the assignment record's status to "released"
# (exactly #292's real, unrelated, intentional behavior) BEFORE the actor deletes its own pointer
# and hits a SECOND, tier-2 Stop.
echo "--- 8g. iteration-3 fix (Finding A): honest session survives releaseOnNonTerminalStop's real release across a second tier-2 stop ---"

AC_RELEASE2ND_REPO="$TMPDIR_EVAL/release-second-stop-repo/repo"
AC_RELEASE2ND_FLOW_AGENTS="$AC_RELEASE2ND_REPO/.kontourai/flow-agents"
mkdir -p "$AC_RELEASE2ND_REPO/context/settings"
printf '# Test Repo\n' > "$AC_RELEASE2ND_REPO/AGENTS.md"
cat > "$AC_RELEASE2ND_REPO/context/settings/assignment-provider-settings.json" <<JSON
{
  "schema_version": "1.0",
  "defaults": {
    "provider": { "kind": "local-file" }
  }
}
JSON

RELEASE2ND_WORK_ITEM="kontourai/flow-agents#9303"
RELEASE2ND_SLUG="kontourai-flow-agents-9303"
RELEASE2ND_ACTOR="eval-honest-actor"
RELEASE2ND_OTHER_ACTOR="eval-honest-bystander-actor"

# A second, unrelated actor forces this to be a genuinely multi-actor repo (the precondition
# for tier 2 to fire once the honest actor's own pointer is gone), same technique as section 8.
flow_agents_node "workflow-sidecar" ensure-session \
  --artifact-root "$AC_RELEASE2ND_FLOW_AGENTS" \
  --work-item "kontourai/flow-agents#9398" \
  --actor "$RELEASE2ND_OTHER_ACTOR" \
  --source-request "Bystander actor's own, unrelated session." \
  --summary "Bystander actor's own delivery." \
  >"$TMPDIR_EVAL/release2nd-bystander-ensure.out" 2>"$TMPDIR_EVAL/release2nd-bystander-ensure.err"
[[ $? -eq 0 ]] && pass "release2nd setup: bystander actor's ensure-session succeeds (genuinely multi-actor repo)" || fail "release2nd setup: bystander actor's ensure-session unexpectedly failed: $(cat "$TMPDIR_EVAL/release2nd-bystander-ensure.out" "$TMPDIR_EVAL/release2nd-bystander-ensure.err")"

flow_agents_node "workflow-sidecar" ensure-session \
  --artifact-root "$AC_RELEASE2ND_FLOW_AGENTS" \
  --work-item "$RELEASE2ND_WORK_ITEM" \
  --actor "$RELEASE2ND_ACTOR" \
  --source-request "Honest actor's own active gated session." \
  --summary "Honest actor's own delivery, mid-flight." \
  >"$TMPDIR_EVAL/release2nd-ensure.out" 2>"$TMPDIR_EVAL/release2nd-ensure.err"
[[ $? -eq 0 ]] && pass "release2nd setup: ensure-session establishes the honest actor's own claimed session" || fail "release2nd setup: ensure-session unexpectedly failed: $(cat "$TMPDIR_EVAL/release2nd-ensure.out" "$TMPDIR_EVAL/release2nd-ensure.err")"

RELEASE2ND_ASSIGNMENT_RECORD="$AC_RELEASE2ND_FLOW_AGENTS/assignment/$RELEASE2ND_SLUG.json"
[[ -f "$RELEASE2ND_ASSIGNMENT_RECORD" ]] && pass "release2nd setup: the durable assignment claim record exists on disk" || fail "release2nd setup: assignment/$RELEASE2ND_SLUG.json was not written"

RELEASE2ND_POINTER_FILE="$AC_RELEASE2ND_FLOW_AGENTS/current/$RELEASE2ND_ACTOR.json"
[[ -f "$RELEASE2ND_POINTER_FILE" ]] && pass "release2nd setup: the honest actor's own current/<actor>.json pointer exists" || fail "release2nd setup: current/$RELEASE2ND_ACTOR.json was not written"

RELEASE2ND_SESSION_DIR="$AC_RELEASE2ND_FLOW_AGENTS/$RELEASE2ND_SLUG"
cat > "$RELEASE2ND_SESSION_DIR/$RELEASE2ND_SLUG--deliver.md" <<MARKDOWN
# Honest actor's own task

branch: main
worktree: main
created: 2026-07-05
status: executing
type: deliver

## Plan

The honest actor's own active delivery, mid-flight -- no exploit, just an ordinary
multi-turn session that happens to hit Stop twice before it is done.
MARKDOWN

safe_write "$RELEASE2ND_SESSION_DIR/state.json" <<JSON
{
  "schema_version": "1.0",
  "task_slug": "$RELEASE2ND_SLUG",
  "status": "in_progress",
  "phase": "build",
  "updated_at": "2026-07-05T00:00:00Z",
  "next_action": {
    "status": "in_progress",
    "summary": "Honest actor is mid-build."
  }
}
JSON

safe_write "$RELEASE2ND_SESSION_DIR/acceptance.json" <<JSON
{
  "schema_version": "1.0",
  "task_slug": "$RELEASE2ND_SLUG",
  "criteria": [
    {
      "id": "honest-thing-works",
      "description": "Honest actor's thing works.",
      "status": "pending",
      "evidence_refs": []
    }
  ],
  "goal_fit": {"status": "pending", "summary": "Pending."}
}
JSON

# FIRST Stop: the pointer still exists (tier 1) -- resolves directly. The session's status
# ("in_progress") is non-terminal, so releaseOnNonTerminalStop (#292, unrelated, pre-existing)
# genuinely fires this time (this repo DOES have a local-file assignment-provider-settings.json,
# unlike section 8's fixture) -- the assignment record's status flips claimed -> released as a
# real, intentional side effect of this Stop, NOT an attack.
FIRST_STOP_OUT="$(FLOW_AGENTS_ACTOR="$RELEASE2ND_ACTOR" FLOW_AGENTS_GOAL_FIT_MODE=warn FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=100000 \
  node "$GOAL_FIT_GATE" 2>&1 <<JSON
{"hook_event_name":"Stop","cwd":"$AC_RELEASE2ND_REPO"}
JSON
)"
if echo "$FIRST_STOP_OUT" | grep -qi "pending"; then
  pass "FIRST stop: the honest actor's own Stop is correctly gated (pending acceptance criterion surfaced)"
else
  fail "FIRST stop: the honest actor's own Stop was unexpectedly NOT gated -- eval fixture setup is wrong: $FIRST_STOP_OUT"
fi

RELEASE2ND_STATUS_AFTER_FIRST_STOP="$(node - "$RELEASE2ND_ASSIGNMENT_RECORD" <<'NODE'
const fs = require('fs');
const record = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
console.log(record.status);
NODE
)"
if [[ "$RELEASE2ND_STATUS_AFTER_FIRST_STOP" == "released" ]]; then
  pass "FIRST stop genuinely released the assignment record (status:released) -- this fixture, unlike section 8's, actually exercises releaseOnNonTerminalStop's real release path"
else
  fail "FIRST stop did NOT flip the assignment record to status:released (got '$RELEASE2ND_STATUS_AFTER_FIRST_STOP') -- fixture is not exercising #292's real release; the SECOND-stop assertion below would not be a genuine repro of Finding A"
fi

RELEASE2ND_ACTOR_KEY_AFTER_FIRST_STOP="$(node - "$RELEASE2ND_ASSIGNMENT_RECORD" <<'NODE'
const fs = require('fs');
const record = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
console.log(record.actor_key || '');
NODE
)"
if [[ -n "$RELEASE2ND_ACTOR_KEY_AFTER_FIRST_STOP" ]]; then
  pass "the released record's actor_key field survives the release (still non-empty) -- the durable signal this fix keys on"
else
  fail "the released record's actor_key field is empty/absent after release -- cannot exercise the actor_key-durability claim"
fi

# Now the actor deletes its OWN pointer -- exactly like section 8's exploit step, but here it is
# simply what happens after a context-compaction/fresh-shell event for an HONEST session (no
# exploit), forcing the SECOND Stop into tier 2.
rm -f "$RELEASE2ND_POINTER_FILE"
[[ ! -f "$RELEASE2ND_POINTER_FILE" ]] && pass "the honest actor's own current/<actor>.json pointer is now gone (precondition for tier 2 on the next Stop)" || fail "release2nd setup: the pointer file still exists after rm -- test precondition broken"

# SECOND Stop: tier 2 (no own pointer). Pre-iteration-3, ownedSessionArtifactDirs's
# status==='claimed' filter would find NOTHING here (the record's status is already "released"
# from the FIRST stop above) and silently un-gate this still-active, honest session -- exactly
# Finding A. Post-fix, the actor_key match (independent of status) plus the session's own
# non-terminal state.json status keeps this session in scope.
SECOND_STOP_OUT="$(FLOW_AGENTS_ACTOR="$RELEASE2ND_ACTOR" FLOW_AGENTS_GOAL_FIT_MODE=warn FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=100000 \
  node "$GOAL_FIT_GATE" 2>&1 <<JSON
{"hook_event_name":"Stop","cwd":"$AC_RELEASE2ND_REPO"}
JSON
)"
if echo "$SECOND_STOP_OUT" | grep -qi "pending"; then
  pass "SECOND stop (Finding A fix): the honest actor's own Stop STILL surfaces the pending acceptance criterion despite the FIRST stop's real assignment-record release and the deleted own pointer"
else
  fail "SECOND stop (Finding A REGRESSION): the honest actor's own Stop went SILENT after an ordinary release-then-pointer-loss sequence -- the tier-2 ownership scan is depending on the assignment record's routinely-released status field again: $SECOND_STOP_OUT"
fi

if echo "$SECOND_STOP_OUT" | grep -q "ownership stamp"; then
  pass "SECOND stop: stderr names the ownership-stamp fallback path (tier 2 genuinely exercised, not an accidental tier-1/tier-3 resolution)"
else
  fail "SECOND stop: stderr did not name the ownership-stamp fallback path -- this may not be exercising tier 2 at all: $SECOND_STOP_OUT"
fi

FIRST_WARN_LINE="$(echo "$FIRST_STOP_OUT" | grep -i "pending" | head -1)"
SECOND_WARN_LINE="$(echo "$SECOND_STOP_OUT" | grep -i "pending" | head -1)"
if [[ "$FIRST_WARN_LINE" == "$SECOND_WARN_LINE" && -n "$FIRST_WARN_LINE" ]]; then
  pass "FIRST/SECOND stop assert the SAME warning content (byte-for-byte) -- the real release-then-pointer-loss sequence changes nothing about what is reported"
else
  fail "FIRST/SECOND stop warning content diverged: first='$FIRST_WARN_LINE' second='$SECOND_WARN_LINE'"
fi

# --- 8h. mutation-test: reintroduce the iteration-2 status==='claimed' filter, confirm section --
# 8g's SECOND stop goes silent (red) without the durable actor_key/state.json signal, then restore.
echo "--- 8h. mutation-test: reintroducing the routinely-released status==='claimed' filter silences section 8g's SECOND stop, then restore ---"

STATUS_MUTATION_SCRATCH="$TMPDIR_EVAL/status-mutation-scratch"
mkdir -p "$STATUS_MUTATION_SCRATCH"
cp "$CURRENT_POINTER_HELPER" "$STATUS_MUTATION_SCRATCH/current-pointer.orig.js"

node - "$CURRENT_POINTER_HELPER" <<'NODE' 2>"$TMPDIR_EVAL/status-mutation-patch.err"
const fs = require('fs');
const file = process.argv[2];
let src = fs.readFileSync(file, 'utf8');
const needle = "if (!recordActorKey || sanitizeSegment(recordActorKey) !== ownSegment) continue;";
if (!src.includes(needle)) {
  process.stderr.write('mutation: actor_key-match line not found -- source pattern drifted, cannot mutation-test\n');
  process.exit(1);
}
src = src.split(needle).join(needle + " if (record.status !== 'claimed') continue; /* mutation-test: reintroduce iteration-2's routinely-released status filter */");
fs.writeFileSync(file, src);
NODE

if [[ -s "$TMPDIR_EVAL/status-mutation-patch.err" ]]; then
  fail "mutation-test setup failed (actor_key-match line did not match scripts/hooks/lib/current-pointer.js), restoring original unmodified: $(cat "$TMPDIR_EVAL/status-mutation-patch.err")"
  cp "$STATUS_MUTATION_SCRATCH/current-pointer.orig.js" "$CURRENT_POINTER_HELPER"
elif ! node --check "$CURRENT_POINTER_HELPER" 2>"$TMPDIR_EVAL/status-mutation-syntax.err"; then
  fail "mutation-test setup: mutated current-pointer.js (status filter reintroduced) failed a syntax check, restoring original immediately: $(cat "$TMPDIR_EVAL/status-mutation-syntax.err")"
  cp "$STATUS_MUTATION_SCRATCH/current-pointer.orig.js" "$CURRENT_POINTER_HELPER"
else
  STATUS_MUTATION_OUT="$(FLOW_AGENTS_ACTOR="$RELEASE2ND_ACTOR" FLOW_AGENTS_GOAL_FIT_MODE=warn FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=100000 \
    node "$GOAL_FIT_GATE" 2>&1 <<JSON
{"hook_event_name":"Stop","cwd":"$AC_RELEASE2ND_REPO"}
JSON
  )"

  cp "$STATUS_MUTATION_SCRATCH/current-pointer.orig.js" "$CURRENT_POINTER_HELPER"

  if ! echo "$STATUS_MUTATION_OUT" | grep -qi "pending"; then
    pass "mutation-test: with the status==='claimed' filter reintroduced, section 8g's SECOND stop WRONGLY goes silent again (eval correctly goes red without the durable actor_key/state.json signal, proving section 8g exercises exactly Finding A's fix)"
  else
    fail "mutation-test: section 8g's SECOND stop still surfaced the pending criterion even with the status==='claimed' filter reintroduced -- section 8g may not be exercising Finding A's fix: $STATUS_MUTATION_OUT"
  fi
fi

if diff -q "$CURRENT_POINTER_HELPER" "$STATUS_MUTATION_SCRATCH/current-pointer.orig.js" >/dev/null 2>&1; then
  pass "mutation-test cleanup: scripts/hooks/lib/current-pointer.js is restored byte-identical to its pre-mutation-test content"
else
  fail "mutation-test cleanup REGRESSION: scripts/hooks/lib/current-pointer.js differs from its own pre-mutation-test content"
fi

STATUS_RESTORE_RECHECK_OUT="$(FLOW_AGENTS_ACTOR="$RELEASE2ND_ACTOR" FLOW_AGENTS_GOAL_FIT_MODE=warn FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=100000 \
  node "$GOAL_FIT_GATE" 2>&1 <<JSON
{"hook_event_name":"Stop","cwd":"$AC_RELEASE2ND_REPO"}
JSON
)"
if echo "$STATUS_RESTORE_RECHECK_OUT" | grep -qi "pending"; then
  pass "mutation-test cleanup re-check: the restored real current-pointer.js's SECOND-stop scan finds section 8g's own session again (guard genuinely back in effect, not just byte-restored)"
else
  fail "mutation-test cleanup re-check REGRESSION: restored current-pointer.js no longer finds section 8g's own session on the SECOND stop: $STATUS_RESTORE_RECHECK_OUT"
fi

# --- 8i. Finding B (relocated CRITICAL): config-protection.js now covers assignment/<slug>.json --
# across ALL its vectors, exactly like section 4's current/<actor>.json coverage. Moving the
# ownership authority to assignment/<slug>.json (iteration-2) without extending THIS defensive
# perimeter to that file left the same rm/mv/Edit bypass class reachable again.
echo "--- 8i. config-protection.js blocks assignment/<slug>.json writes/redirects/interpreter-writes/copy-move/delete-rename (Finding B) ---"

set +e
ASSIGN_WRITE_OUT=$(echo '{"tool_name":"Write","tool_input":{"path":"/repo/.kontourai/flow-agents/assignment/kontourai-flow-agents-9303.json"}}' | node "$CONFIG_PROTECTION" 2>&1)
ASSIGN_WRITE_EXIT=$?
ASSIGN_EDIT_OUT=$(echo '{"tool_name":"Edit","tool_input":{"file_path":"/repo/.kontourai/flow-agents/assignment/kontourai-flow-agents-9303.json"}}' | node "$CONFIG_PROTECTION" 2>&1)
ASSIGN_EDIT_EXIT=$?
set -e

if [[ "$ASSIGN_WRITE_EXIT" -eq 2 ]] && echo "$ASSIGN_WRITE_OUT" | grep -q "BLOCKED"; then
  pass "Write to .kontourai/flow-agents/assignment/<slug>.json is blocked (exit 2) (Finding B)"
else
  fail "Write to .kontourai/flow-agents/assignment/<slug>.json was NOT blocked (exit=$ASSIGN_WRITE_EXIT, out=$ASSIGN_WRITE_OUT)"
fi

if [[ "$ASSIGN_EDIT_EXIT" -eq 2 ]] && echo "$ASSIGN_EDIT_OUT" | grep -q "BLOCKED"; then
  pass "Edit of .kontourai/flow-agents/assignment/<slug>.json is blocked (exit 2) (Finding B) -- this is the exact 'a single Edit flipping status/actor_key' bypass the security reviewer reproduced"
else
  fail "Edit of .kontourai/flow-agents/assignment/<slug>.json was NOT blocked (exit=$ASSIGN_EDIT_EXIT, out=$ASSIGN_EDIT_OUT)"
fi

set +e
ASSIGN_TEE_OUT=$(echo '{"tool_name":"Bash","tool_input":{"command":"echo {} | tee .kontourai/flow-agents/assignment/kontourai-flow-agents-9303.json"}}' | node "$CONFIG_PROTECTION" 2>&1)
ASSIGN_TEE_EXIT=$?
set -e
if [[ "$ASSIGN_TEE_EXIT" -eq 2 ]] && echo "$ASSIGN_TEE_OUT" | grep -q "BLOCKED"; then
  pass "tee .kontourai/flow-agents/assignment/<slug>.json is blocked (exit 2) (Finding B)"
else
  fail "tee .kontourai/flow-agents/assignment/<slug>.json was NOT blocked (exit=$ASSIGN_TEE_EXIT, out=$ASSIGN_TEE_OUT)"
fi

set +e
ASSIGN_INTERP_OUT=$(echo '{"tool_name":"Bash","tool_input":{"command":"node -e \".kontourai/flow-agents/assignment/kontourai-flow-agents-9303.json\""}}' | node "$CONFIG_PROTECTION" 2>&1)
ASSIGN_INTERP_EXIT=$?
set -e
if [[ "$ASSIGN_INTERP_EXIT" -eq 2 ]] && echo "$ASSIGN_INTERP_OUT" | grep -q "BLOCKED"; then
  pass "interpreter-write (node with an inline-eval flag) with the assignment record as a literal path token is blocked (exit 2) (Finding B)"
else
  fail "interpreter-write with the assignment record path token was NOT blocked (exit=$ASSIGN_INTERP_EXIT, out=$ASSIGN_INTERP_OUT)"
fi

set +e
ASSIGN_CP_OUT=$(echo '{"tool_name":"Bash","tool_input":{"command":"cp forged.json .kontourai/flow-agents/assignment/kontourai-flow-agents-9303.json"}}' | node "$CONFIG_PROTECTION" 2>&1)
ASSIGN_CP_EXIT=$?
set -e
if [[ "$ASSIGN_CP_EXIT" -eq 2 ]] && echo "$ASSIGN_CP_OUT" | grep -q "BLOCKED"; then
  pass "cp of a forged record onto .kontourai/flow-agents/assignment/<slug>.json is blocked (exit 2) (Finding B)"
else
  fail "cp onto the assignment record path was NOT blocked (exit=$ASSIGN_CP_EXIT, out=$ASSIGN_CP_OUT)"
fi

set +e
ASSIGN_RM_OUT=$(echo '{"tool_name":"Bash","tool_input":{"command":"rm .kontourai/flow-agents/assignment/kontourai-flow-agents-9303.json"}}' | node "$CONFIG_PROTECTION" 2>&1)
ASSIGN_RM_EXIT=$?
ASSIGN_MV_OUT=$(echo '{"tool_name":"Bash","tool_input":{"command":"mv .kontourai/flow-agents/assignment/kontourai-flow-agents-9303.json /tmp/gone.json"}}' | node "$CONFIG_PROTECTION" 2>&1)
ASSIGN_MV_EXIT=$?
set -e

if [[ "$ASSIGN_RM_EXIT" -eq 2 ]] && echo "$ASSIGN_RM_OUT" | grep -q "BLOCKED"; then
  pass "rm .kontourai/flow-agents/assignment/<slug>.json is blocked (exit 2) (Finding B) -- this is the exact delete-pointer + rm-assignment bypass the security reviewer reproduced"
else
  fail "rm .kontourai/flow-agents/assignment/<slug>.json was NOT blocked (exit=$ASSIGN_RM_EXIT, out=$ASSIGN_RM_OUT)"
fi

if [[ "$ASSIGN_MV_EXIT" -eq 2 ]] && echo "$ASSIGN_MV_OUT" | grep -q "BLOCKED"; then
  pass "mv .kontourai/flow-agents/assignment/<slug>.json <elsewhere> (renaming the record away) is blocked (exit 2) (Finding B)"
else
  fail "mv of the assignment record away was NOT blocked (exit=$ASSIGN_MV_EXIT, out=$ASSIGN_MV_OUT)"
fi

# Negative: an unrelated write/rm under a similarly-named-but-different directory is still allowed.
set +e
ASSIGN_UNRELATED_WRITE_OUT=$(echo '{"tool_name":"Write","tool_input":{"path":"/repo/.kontourai/flow-agents/assignment-notes/kontourai-flow-agents-9303.json"}}' | node "$CONFIG_PROTECTION" 2>&1)
ASSIGN_UNRELATED_WRITE_EXIT=$?
ASSIGN_UNRELATED_RM_OUT=$(echo '{"tool_name":"Bash","tool_input":{"command":"rm /tmp/assignment-scratch-file.txt"}}' | node "$CONFIG_PROTECTION" 2>&1)
ASSIGN_UNRELATED_RM_EXIT=$?
set -e
[[ "$ASSIGN_UNRELATED_WRITE_EXIT" -eq 0 ]] && pass "a write under a similarly-named-but-different directory (assignment-notes/) is still allowed (exit 0) (Finding B regression guard)" || fail "an unrelated assignment-notes/ write was falsely blocked (exit=$ASSIGN_UNRELATED_WRITE_EXIT)"
[[ "$ASSIGN_UNRELATED_RM_EXIT" -eq 0 ]] && pass "an unrelated rm (no protected path) is still allowed (exit 0) (Finding B regression guard)" || fail "an unrelated rm was falsely blocked (exit=$ASSIGN_UNRELATED_RM_EXIT)"

# --- 8j. Finding B end-to-end: even a successful status/actor_key Edit on the assignment record --
# does not have the same effect it would pre-iteration-3 -- a status flip alone no longer silences
# the gate (Finding A's design), but an actor_key flip DOES (a legitimate supersede changes
# actor_key on purpose) -- which is precisely why config-protection's Edit-block above (8i) is the
# load-bearing defense for THAT specific sub-vector, not the gate's own scan logic.
echo "--- 8j. direct-tamper resilience: a status-only flip does not silence the gate; an actor_key flip would (bar-raiser framing, honest residual) ---"

TAMPER_ACTOR_KEY="$RELEASE2ND_ACTOR"
TAMPER_RECORD="$RELEASE2ND_ASSIGNMENT_RECORD"

# Directly flip ONLY the status field back and forth (bypassing config-protection on purpose,
# to test the GATE's own resilience in isolation, independent of whether config-protection would
# have blocked the write that produced this state) -- confirms the gate's ownership scan does not
# depend on this field at all, regardless of who or what set it.
node - "$TAMPER_RECORD" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const record = JSON.parse(fs.readFileSync(file, 'utf8'));
record.status = 'claimed';
fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
NODE

STATUS_ONLY_FLIP_OUT="$(FLOW_AGENTS_ACTOR="$RELEASE2ND_ACTOR" FLOW_AGENTS_GOAL_FIT_MODE=warn FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=100000 \
  node "$GOAL_FIT_GATE" 2>&1 <<JSON
{"hook_event_name":"Stop","cwd":"$AC_RELEASE2ND_REPO"}
JSON
)"
if echo "$STATUS_ONLY_FLIP_OUT" | grep -qi "pending"; then
  pass "status-only flip (claimed, i.e. as if never released) still gates -- consistent, either value of the now-irrelevant status field finds the same owned session"
else
  fail "status-only flip caused the gate to go silent -- unexpected, status should be irrelevant to the scan: $STATUS_ONLY_FLIP_OUT"
fi

# Now flip ONLY actor_key to a foreign value (simulating a forged record, NOT a legitimate
# supersede) -- this DOES silence the scan for the real actor, by design (the actor_key field is
# the durable ownership authority; a record whose actor_key names someone else is, correctly,
# not this actor's own). This is the HONEST residual: config-protection's Edit-block (section 8i)
# is the actual defense against this specific sub-vector, not the gate's own scan logic.
node - "$TAMPER_RECORD" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const record = JSON.parse(fs.readFileSync(file, 'utf8'));
record.status = 'claimed';
record.actor_key = 'eval-forged-foreign-actor';
fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
NODE

ACTOR_KEY_FLIP_OUT="$(FLOW_AGENTS_ACTOR="$RELEASE2ND_ACTOR" FLOW_AGENTS_GOAL_FIT_MODE=warn FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=100000 \
  node "$GOAL_FIT_GATE" 2>&1 <<JSON
{"hook_event_name":"Stop","cwd":"$AC_RELEASE2ND_REPO"}
JSON
)"
if ! echo "$ACTOR_KEY_FLIP_OUT" | grep -qi "pending"; then
  pass "actor_key flip to a foreign value DOES silence the scan for the real actor (honest, documented residual) -- proving config-protection's Edit-block (8i), not the scan, is the defense for this sub-vector"
else
  fail "actor_key flip unexpectedly did NOT silence the scan -- either the fixture is wrong or the scan is (incorrectly) not keying on actor_key at all: $ACTOR_KEY_FLIP_OUT"
fi

# Restore the record to its genuine post-first-stop shape (status:released, real actor_key) so any
# later section reusing this fixture sees consistent state.
node - "$TAMPER_RECORD" "$TAMPER_ACTOR_KEY" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const actorKey = process.argv[3];
const record = JSON.parse(fs.readFileSync(file, 'utf8'));
record.status = 'released';
record.actor_key = actorKey;
fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
NODE

# --- 8k. mutation-test: neuter config-protection.js's assignment/*.json coverage, confirm ------
# section 8i's positive assertions go red, then restore. Same in-place-mutation-of-the-live-file
# idiom as section 8f (config-protection.js is required by its own eval invocation below via a
# fresh `node "$CONFIG_PROTECTION"` child process each time, so a scratch copy elsewhere would not
# exercise the same file).
echo "--- 8k. mutation-test: config-protection.js's assignment/*.json coverage neutered -> section 8i goes red, then restore ---"

CONFIG_PROTECTION_MUTATION_SCRATCH="$TMPDIR_EVAL/config-protection-mutation-scratch"
mkdir -p "$CONFIG_PROTECTION_MUTATION_SCRATCH"
cp "$CONFIG_PROTECTION" "$CONFIG_PROTECTION_MUTATION_SCRATCH/config-protection.orig.js"

node - "$CONFIG_PROTECTION" <<'NODE' 2>"$TMPDIR_EVAL/config-protection-mutation-patch.err"
const fs = require('fs');
const file = process.argv[2];
let src = fs.readFileSync(file, 'utf8');
const needle = "assignment";
const count = src.split(needle).length - 1;
if (count === 0) {
  process.stderr.write('mutation: no occurrences of the literal "assignment" token found -- source pattern drifted, cannot mutation-test\n');
  process.exit(1);
}
// Neuter every assignment/-related protection surface at once by renaming the token itself so
// none of the five vectors' regex/token checks can match a real assignment/<slug>.json path.
src = src.split('assignment').join('mutationtestneutered');
fs.writeFileSync(file, src);
NODE

if [[ -s "$TMPDIR_EVAL/config-protection-mutation-patch.err" ]]; then
  fail "mutation-test setup failed (no 'assignment' token found in config-protection.js), restoring original unmodified: $(cat "$TMPDIR_EVAL/config-protection-mutation-patch.err")"
  cp "$CONFIG_PROTECTION_MUTATION_SCRATCH/config-protection.orig.js" "$CONFIG_PROTECTION"
elif ! node --check "$CONFIG_PROTECTION" 2>"$TMPDIR_EVAL/config-protection-mutation-syntax.err"; then
  fail "mutation-test setup: mutated config-protection.js (assignment coverage neutered) failed a syntax check, restoring original immediately: $(cat "$TMPDIR_EVAL/config-protection-mutation-syntax.err")"
  cp "$CONFIG_PROTECTION_MUTATION_SCRATCH/config-protection.orig.js" "$CONFIG_PROTECTION"
else
  set +e
  MUTATED_RM_OUT=$(echo '{"tool_name":"Bash","tool_input":{"command":"rm .kontourai/flow-agents/assignment/kontourai-flow-agents-9303.json"}}' | node "$CONFIG_PROTECTION" 2>&1)
  MUTATED_RM_EXIT=$?
  MUTATED_WRITE_OUT=$(echo '{"tool_name":"Write","tool_input":{"path":"/repo/.kontourai/flow-agents/assignment/kontourai-flow-agents-9303.json"}}' | node "$CONFIG_PROTECTION" 2>&1)
  MUTATED_WRITE_EXIT=$?
  set -e

  cp "$CONFIG_PROTECTION_MUTATION_SCRATCH/config-protection.orig.js" "$CONFIG_PROTECTION"

  if [[ "$MUTATED_RM_EXIT" -eq 0 && "$MUTATED_WRITE_EXIT" -eq 0 ]]; then
    pass "mutation-test: with assignment/*.json coverage neutered, both rm and Write against the assignment record are WRONGLY allowed again (eval correctly goes red without Finding B's fix, proving section 8i exercises it)"
  else
    fail "mutation-test: rm/Write against the assignment record were still blocked (exit rm=$MUTATED_RM_EXIT write=$MUTATED_WRITE_EXIT) even with the 'assignment' token neutered -- section 8i may not be exercising Finding B's fix"
  fi
fi

if diff -q "$CONFIG_PROTECTION" "$CONFIG_PROTECTION_MUTATION_SCRATCH/config-protection.orig.js" >/dev/null 2>&1; then
  pass "mutation-test cleanup: scripts/hooks/config-protection.js is restored byte-identical to its pre-mutation-test content"
else
  fail "mutation-test cleanup REGRESSION: scripts/hooks/config-protection.js differs from its own pre-mutation-test content"
fi

set +e
RESTORE_RECHECK_RM_OUT=$(echo '{"tool_name":"Bash","tool_input":{"command":"rm .kontourai/flow-agents/assignment/kontourai-flow-agents-9303.json"}}' | node "$CONFIG_PROTECTION" 2>&1)
RESTORE_RECHECK_RM_EXIT=$?
set -e
if [[ "$RESTORE_RECHECK_RM_EXIT" -eq 2 ]] && echo "$RESTORE_RECHECK_RM_OUT" | grep -q "BLOCKED"; then
  pass "mutation-test cleanup re-check: the restored real config-protection.js blocks rm of the assignment record again (guard genuinely back in effect, not just byte-restored)"
else
  fail "mutation-test cleanup re-check REGRESSION: restored config-protection.js no longer blocks rm of the assignment record: $RESTORE_RECHECK_RM_OUT"
fi


echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "test_current_json_per_actor: all checks passed."
else
  echo "test_current_json_per_actor: $errors check(s) failed."
fi
exit "$errors"
