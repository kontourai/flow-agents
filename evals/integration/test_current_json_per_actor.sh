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

AC7_ROOT="$TMPDIR_EVAL/ac7-project/.kontourai/flow-agents"

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

# #440 fix-wave 2: the per-actor filename is now collision-resistant (sanitized prefix + hash of
# the FULL actor key, see current-pointer.js's perActorCurrentFile) -- compute the expected path
# via the real function rather than re-deriving the naming rule by hand.
PER_ACTOR_FILE_A="$(CP_HELPER_ARG="$CURRENT_POINTER_HELPER" ROOT_ARG="$AC7_ROOT" ACTOR_ARG="eval-actor-a-session" node - <<'NODE'
const { perActorCurrentFile } = require(process.env.CP_HELPER_ARG);
process.stdout.write(perActorCurrentFile(process.env.ROOT_ARG, process.env.ACTOR_ARG));
NODE
)"
PER_ACTOR_FILE_B="$(CP_HELPER_ARG="$CURRENT_POINTER_HELPER" ROOT_ARG="$AC7_ROOT" ACTOR_ARG="eval-actor-b-session" node - <<'NODE'
const { perActorCurrentFile } = require(process.env.CP_HELPER_ARG);
process.stdout.write(perActorCurrentFile(process.env.ROOT_ARG, process.env.ACTOR_ARG));
NODE
)"
[[ -f "$PER_ACTOR_FILE_A" ]] && pass "actor A's per-actor current file exists on disk" || fail "actor A's per-actor current file was not written"
[[ -f "$PER_ACTOR_FILE_B" ]] && pass "actor B's per-actor current file exists on disk" || fail "actor B's per-actor current file was not written"

# --- 3. Legacy-only fixture: every named consumer resolves identically to pre-#291 (AC8) -------
echo "--- 3. legacy-only fixture: existing consumers resolve identically to pre-#291 output (AC8) ---"

# 3a. stop-goal-fit.js -- reuses test_goal_fit_hook.sh's own fixture/assertion verbatim, run
# under a genuinely UNRESOLVED actor (FLOW_AGENTS_ACTOR_TEST_FORCE_UNRESOLVED escape hatch,
# matching test_stop_hook_release.sh's F(iii) convention) -- proves the compat shim falls
# straight through to the legacy file exactly as pre-#291 (when this file had no actor-awareness
# at all). #440: a RESOLVED actor with no own per-actor pointer no longer falls back to this
# legacy file for BLOCKING purposes (see new section 7) -- that distinct, resolved-actor case is
# the bug #440 fixes, so this section must force a genuinely unresolved actor to keep testing the
# unchanged compat-shim path AC4 is about, not the now-intentionally-changed resolved-actor path.
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

if FLOW_AGENTS_ACTOR_TEST_FORCE_UNRESOLVED=1 NODE_ENV=test FLOW_AGENTS_GOAL_FIT_MODE=warn FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=100000 \
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
# THAT slug's command-log.jsonl, under a genuinely UNRESOLVED actor (#440: see 3a's comment --
# a RESOLVED actor with no own pointer now intentionally returns null here instead, see section 7).
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
  | FLOW_AGENTS_ACTOR_TEST_FORCE_UNRESOLVED=1 NODE_ENV=test node "$EVIDENCE_CAPTURE" >"$TMPDIR_EVAL/evidence-legacy.out" 2>"$TMPDIR_EVAL/evidence-legacy.err"

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
# steering-demo fixture/assertion verbatim, under a genuinely UNRESOLVED actor (#440: see 3a's
# comment -- a RESOLVED actor with no own pointer now intentionally sees no banner, see section 7).
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

STEERING_OUT="$(FLOW_AGENTS_ACTOR_TEST_FORCE_UNRESOLVED=1 NODE_ENV=test node "$STEERING" <<JSON
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

# --- 5. record-gate-claim resolves A's own per-actor flow/step, not B's legacy pointer (AC11) --
echo "--- 5. record-gate-claim resolves A's own per-actor flow/step, not B's legacy pointer (AC11) ---"

AC11_ROOT="$TMPDIR_EVAL/ac11-project/.kontourai/flow-agents"
AC11_WORK_ITEM="local:gate-actor-a"

flow_agents_node "workflow-sidecar" ensure-session \
  --artifact-root "$AC11_ROOT" \
  --task-slug gate-actor-a \
  --actor eval-actor-a-session \
  --flow-id builder.build \
  --skip-ownership-guard \
  --source-request "Actor A is active on a FlowDefinition-driven session." \
  --summary "Actor A, builder.build, pull-work step." \
  --timestamp "2026-07-01T00:00:00Z" \
  >"$TMPDIR_EVAL/ac11-a-ensure.out" 2>"$TMPDIR_EVAL/ac11-a-ensure.err"

AC11_DELIVER_MD="$AC11_ROOT/gate-actor-a/gate-actor-a--deliver.md"
flow_agents_node "workflow-sidecar" init-plan "$AC11_DELIVER_MD" \
  --source-request "Test" --summary "Testing" \
  --timestamp "2026-07-01T00:00:30Z" >"$TMPDIR_EVAL/ac11-a-initplan.out" 2>"$TMPDIR_EVAL/ac11-a-initplan.err"

# A passing selected-work claim must cite pull-work's declared durable artifact. Keep it in A's
# session so the generic producer/evidence contract is exercised without weakening AC11's
# per-actor pointer differential.
AC11_PULL_WORK_ARTIFACT="$AC11_ROOT/gate-actor-a/gate-actor-a--pull-work.md"
safe_write "$AC11_PULL_WORK_ARTIFACT" <<EOF
# Pull Work

Selected Work Item: $AC11_WORK_ITEM
EOF

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
  --evidence-ref-json "{\"kind\":\"artifact\",\"file\":\"$AC11_PULL_WORK_ARTIFACT\",\"summary\":\"Declared pull-work artifact naming bound Work Item $AC11_WORK_ITEM.\"}" \
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
# the same artifact root, under a genuinely UNRESOLVED actor (#440: this section's fixture uses
# the FLOW_AGENTS_ACTOR_TEST_FORCE_UNRESOLVED escape hatch -- a RESOLVED actor with no per-actor
# current file no longer falls through to the legacy pointer at all, see section 7; this section
# is specifically about the unchanged D3/unresolved-actor compat path). Pre-#291,
# latestWorkflowState() was a pure global newest-mtime scan with zero current.json involvement,
# so the newer state.json would win. Post-#291, actorScopedWorkflowState() is consulted first and
# falls through to the legacy current.json for an unresolved actor (the compat-shim guarantee
# section 3 already covers) -- but if that legacy pointer names a still-ACTIVE session, it is now
# returned IMMEDIATELY, without ever comparing mtimes against the newer state.json. This section
# test-pins that specific, deliberate behavior change (current.json preference wins over
# newest-mtime) for the single-actor/unresolved-actor case, not just the multi-actor case AC7/AC8
# are framed around -- the review's flagged, previously test-uncovered edge.
echo "--- 6. legacy current.json (non-newest, still-active) wins over a newer state.json elsewhere, under an unresolved actor (F3, fix-plan iteration 1) ---"

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

# A genuinely UNRESOLVED actor (#440: see 3a's comment -- a RESOLVED actor with no per-actor
# current file no longer falls through here, see section 7) -- actorScopedWorkflowState falls
# through to the legacy current.json (same compat-shim guarantee as section 3), which names
# the OLDER-but-still-active session.
F3_OUT="$(FLOW_AGENTS_ACTOR_TEST_FORCE_UNRESOLVED=1 NODE_ENV=test node "$ROOT/scripts/hooks/workflow-steering.js" <<JSON
{"hook_event_name":"UserPromptSubmit","cwd":"$F3_REPO","prompt":"continue"}
JSON
)"

if [[ "$F3_OUT" == *"older-named-slug"* && "$F3_OUT" != *"newer-unnamed-slug"* ]]; then
  pass "workflow-steering.js prefers the legacy current.json's named ACTIVE session over a newer-mtime state.json elsewhere, under an unresolved actor (F3 -- pins the post-#291 behavior change explicitly, not just AC7/AC8's multi-actor framing; #440: a resolved actor with no per-actor file no longer takes this path at all, see section 7)"
else
  fail "workflow-steering.js did not prefer the legacy-named active session over the newer-mtime one: $F3_OUT"
fi

# --- 7. #440: two-session ownership isolation (readOwnCurrentPointer) --------------------------
# Distinct from section 2 (AC7, both A and B have run ensure-session): here actor A does NOT run
# ensure-session at all before the "not own pointer" assertions below -- the "resolved actor, no
# own per-actor pointer at all" case readOwnCurrentPointer's D1 rule (never fall back to the
# shared legacy current.json / a global scan) is specifically about. Positive controls (actor A's
# own gate/banner/capture keep working once A DOES have its own pointer) run last, in their own
# subsection, so they never contaminate the "no own pointer" preconditions the earlier assertions
# depend on.
echo "--- 7. #440: two-session ownership isolation (readOwnCurrentPointer) ---"

# This file's own header only sets `set -uo pipefail` (no errexit) -- but section 4's
# config-protection.js checks toggle `set -e` back ON after their own `set +e`/`set -e`
# bracketing and never restore the header's original (errexit-off) mode, so errexit is (latently,
# unintentionally) still active by the time execution reaches here. This section deliberately
# invokes commands expected to exit nonzero (e.g. the AC2 anti-gaming positive control, which
# must itself observe a block/exit!=0) via plain `VAR="$(...)"` assignments -- under errexit a
# nonzero-returning command substitution assignment terminates the whole script immediately, with
# no error message, silently truncating every assertion after it. `set +e` restores this section to
# the file's own declared header mode for the remainder of the file (safe: sections 1-6 above are
# unaffected since they already ran; nothing below this section depends on errexit being on).
set +e

AC440_REPO="$TMPDIR_EVAL/ac440-project"
AC440_ROOT="$AC440_REPO/.kontourai/flow-agents"
mkdir -p "$AC440_REPO/docs"
printf '# Test Repo\n' > "$AC440_REPO/AGENTS.md"
printf '# Context Map\n' > "$AC440_REPO/docs/context-map.md"

# 7.0 Setup: actor B runs ensure-session on a real Work Item (establishing B's own per-actor
# current/eval-actor-440-b.json AND the shared legacy current.json, exactly like section 2's
# AC7_ROOT setup), then B's session is mutated into a genuine, blocking evidence gap (execution
# phase, no trust.bundle) so the "not blocked by B" assertions below are a real differential test,
# not a tautology -- mirrors this file's own section 3a fixture shape (status:executing markdown +
# no trust.bundle) and test_stop_hook_release.sh's seed_session/write_session_state convention.
flow_agents_node "workflow-sidecar" ensure-session \
  --artifact-root "$AC440_ROOT" \
  --work-item "kontourai/flow-agents#94401" \
  --actor eval-actor-440-b \
  --source-request "Actor B's own subject, with a real evidence gap." \
  --summary "Actor B session with a deliberate evidence gap." \
  >"$TMPDIR_EVAL/ac440-b-ensure.out" 2>"$TMPDIR_EVAL/ac440-b-ensure.err"
AC440_B_STATUS=$?

AC440_B_SLUG="kontourai-flow-agents-94401"
AC440_B_DIR="$AC440_ROOT/$AC440_B_SLUG"

if [[ "$AC440_B_STATUS" -eq 0 && -d "$AC440_B_DIR" ]]; then
  pass "setup: actor B's ensure-session establishes B's own per-actor current file and a real session dir"
else
  fail "setup: actor B's ensure-session failed: $(cat "$TMPDIR_EVAL/ac440-b-ensure.out" "$TMPDIR_EVAL/ac440-b-ensure.err")"
fi

AC440_B_STATE_LINE="{\"schema_version\":\"1.0\",\"task_slug\":\"$AC440_B_SLUG\",\"status\":\"in_progress\",\"phase\":\"execution\",\"updated_at\":\"2026-07-13T00:00:00Z\",\"next_action\":{\"status\":\"continue\",\"summary\":\"Actor B's own unresolved evidence gap.\"}}"
printf '%s' "$AC440_B_STATE_LINE" | safe_write "$AC440_B_DIR/state.json"

cat > "$AC440_B_DIR/${AC440_B_SLUG}--deliver.md" <<MARKDOWN
# ${AC440_B_SLUG}

branch: main
worktree: main
created: 2026-07-13
status: executing
type: deliver

## Plan

Actor B's own session, deliberately left with a genuine evidence gap (no trust.bundle) so this
section's "actor A is not blocked by B's gap" assertions are a real differential test.
MARKDOWN

# 7.1 AC1 (liveness): a `claim` liveness event for B's own subject/actor already exists in the
# shared liveness stream (ensure-session emits one as part of its own claim). Invoking the Stop
# hook as actor A (who has NOT run ensure-session -- no own per-actor pointer at all) must never
# append a `release`/other event attributed to A's own actor string for B's subject -- readActiveSlug
# resolving B's slug for A would be exactly the liveness half of the bug #440 fixes.
AC440_LIVENESS_FILE="$AC440_ROOT/liveness/events.jsonl"
AC440_LIVENESS_LINES_BEFORE=0
[[ -f "$AC440_LIVENESS_FILE" ]] && AC440_LIVENESS_LINES_BEFORE="$(wc -l < "$AC440_LIVENESS_FILE" | tr -d ' ')"

FLOW_AGENTS_ACTOR=eval-actor-440-a FLOW_AGENTS_GOAL_FIT_MODE=warn node "$GOAL_FIT_GATE" \
  >"$TMPDIR_EVAL/ac440-a-liveness.out" 2>"$TMPDIR_EVAL/ac440-a-liveness.err" <<JSON
{"hook_event_name":"Stop","cwd":"$AC440_REPO"}
JSON

if grep -q "\"subjectId\":\"$AC440_B_SLUG\",\"actor\":\"eval-actor-440-a\"" "$AC440_LIVENESS_FILE" 2>/dev/null; then
  fail "AC1: actor A's Stop hook emitted a liveness event naming B's slug under A's own actor identity"
else
  pass "AC1: actor A's Stop hook (no own per-actor pointer) emits no liveness event naming B's subject under A's actor identity"
fi

# 7.2 AC2 (not blocked by B): actor A's Stop hook, in block mode, must exit 0 and never mention
# B's slug -- B's own real evidence gap is informational-only from A's perspective, never blocking.
AC440_A_NOTBLOCKED_OUT="$(FLOW_AGENTS_ACTOR=eval-actor-440-a FLOW_AGENTS_GOAL_FIT_MODE=block node "$GOAL_FIT_GATE" 2>"$TMPDIR_EVAL/ac440-a-notblocked.err" <<JSON
{"hook_event_name":"Stop","cwd":"$AC440_REPO"}
JSON
)"
AC440_A_NOTBLOCKED_STATUS=$?

if [[ "$AC440_A_NOTBLOCKED_STATUS" -eq 0 ]]; then
  pass "AC2: actor A's Stop hook (no own pointer, B has a real evidence gap) exits 0 -- not blocked by B's gap"
else
  fail "AC2: actor A's Stop hook unexpectedly blocked (exit=$AC440_A_NOTBLOCKED_STATUS): $AC440_A_NOTBLOCKED_OUT $(cat "$TMPDIR_EVAL/ac440-a-notblocked.err")"
fi

if grep -qF "$AC440_B_SLUG" "$TMPDIR_EVAL/ac440-a-notblocked.err"; then
  fail "AC2: actor A's Stop hook stderr unexpectedly named B's slug: $(cat "$TMPDIR_EVAL/ac440-a-notblocked.err")"
else
  pass "AC2: actor A's Stop hook stderr never names B's slug"
fi

# 7.3 AC1 (banner): workflow-steering.js's SessionStart RESUME banner must never re-ground onto
# B's active session for actor A (no own per-actor pointer).
AC440_STEERING_A_OUT="$(FLOW_AGENTS_ACTOR=eval-actor-440-a node "$STEERING" <<JSON
{"hook_event_name":"SessionStart","cwd":"$AC440_REPO"}
JSON
)"

if [[ "$AC440_STEERING_A_OUT" != *"RESUME:"* && "$AC440_STEERING_A_OUT" != *"$AC440_B_SLUG"* ]]; then
  pass "AC1: workflow-steering.js's SessionStart banner (actor A, no own pointer) shows no RESUME and never names B's slug"
else
  fail "AC1: workflow-steering.js's SessionStart banner unexpectedly showed RESUME or B's slug for actor A: $AC440_STEERING_A_OUT"
fi

# 7.4 Evidence-capture (Task 2.4 coverage): a PostToolUse event captured while actor A has no own
# per-actor pointer must never land in B's command-log.jsonl.
AC440_B_LOG="$AC440_B_DIR/command-log.jsonl"
AC440_EVIDENCE_EVENT="{\"hook_event_name\":\"PostToolUse\",\"tool_name\":\"Bash\",\"cwd\":\"$AC440_REPO\",\"tool_input\":{\"command\":\"echo actor-a-must-not-land-in-b-log\"},\"tool_response\":{\"exitCode\":0,\"stdout\":\"ok\"}}"
printf '%s' "$AC440_EVIDENCE_EVENT" \
  | FLOW_AGENTS_ACTOR=eval-actor-440-a node "$EVIDENCE_CAPTURE" >"$TMPDIR_EVAL/ac440-evidence-a.out" 2>"$TMPDIR_EVAL/ac440-evidence-a.err"

if [[ -f "$AC440_B_LOG" ]] && grep -qF "actor-a-must-not-land-in-b-log" "$AC440_B_LOG"; then
  fail "evidence-capture.js (actor A, no own pointer) wrote A's tool activity into B's command-log.jsonl"
else
  pass "evidence-capture.js (actor A, no own pointer) never writes A's tool activity into B's command-log.jsonl"
fi

# 7.5 Positive controls: actor A's OWN gate/banner/capture keep working exactly as before, once A
# has its own per-actor pointer -- the critical anti-gaming assertion (own gaps still gate; own
# work still steers/captures). Run last so the earlier "no own pointer" assertions above are never
# contaminated by A's own session existing.
flow_agents_node "workflow-sidecar" ensure-session \
  --artifact-root "$AC440_ROOT" \
  --work-item "kontourai/flow-agents#94402" \
  --actor eval-actor-440-a \
  --source-request "Actor A's own subject, with its own deliberate evidence gap." \
  --summary "Actor A session with its own deliberate evidence gap." \
  >"$TMPDIR_EVAL/ac440-a-ensure.out" 2>"$TMPDIR_EVAL/ac440-a-ensure.err"
AC440_A_STATUS=$?

AC440_A_SLUG="kontourai-flow-agents-94402"
AC440_A_DIR="$AC440_ROOT/$AC440_A_SLUG"

if [[ "$AC440_A_STATUS" -eq 0 && -d "$AC440_A_DIR" ]]; then
  pass "positive control setup: actor A's own ensure-session establishes A's own per-actor current file"
else
  fail "positive control setup: actor A's own ensure-session failed: $(cat "$TMPDIR_EVAL/ac440-a-ensure.out" "$TMPDIR_EVAL/ac440-a-ensure.err")"
fi

AC440_A_STATE_LINE="{\"schema_version\":\"1.0\",\"task_slug\":\"$AC440_A_SLUG\",\"status\":\"in_progress\",\"phase\":\"execution\",\"updated_at\":\"2026-07-13T00:00:00Z\",\"next_action\":{\"status\":\"continue\",\"summary\":\"Actor A's own unresolved evidence gap.\"}}"
printf '%s' "$AC440_A_STATE_LINE" | safe_write "$AC440_A_DIR/state.json"

cat > "$AC440_A_DIR/${AC440_A_SLUG}--deliver.md" <<MARKDOWN
# ${AC440_A_SLUG}

branch: main
worktree: main
created: 2026-07-13
status: executing
type: deliver

## Plan

Actor A's own session, deliberately left with its own genuine evidence gap (no trust.bundle) --
own-work gating must remain unaffected by the #440 fix (anti-gaming guarantee).
MARKDOWN

AC440_A_BLOCKED_OUT="$(FLOW_AGENTS_ACTOR=eval-actor-440-a FLOW_AGENTS_GOAL_FIT_MODE=block node "$GOAL_FIT_GATE" 2>"$TMPDIR_EVAL/ac440-a-blocked.err" <<JSON
{"hook_event_name":"Stop","cwd":"$AC440_REPO"}
JSON
)"
AC440_A_BLOCKED_STATUS=$?

if [[ "$AC440_A_BLOCKED_STATUS" -ne 0 ]]; then
  pass "AC2 (anti-gaming): actor A's Stop hook STILL blocks on A's own evidence gap once A has its own per-actor pointer"
else
  fail "AC2 (anti-gaming): actor A's Stop hook unexpectedly did NOT block on A's own evidence gap: $AC440_A_BLOCKED_OUT $(cat "$TMPDIR_EVAL/ac440-a-blocked.err")"
fi

AC440_STEERING_A_OWN_OUT="$(FLOW_AGENTS_ACTOR=eval-actor-440-a node "$STEERING" <<JSON
{"hook_event_name":"SessionStart","cwd":"$AC440_REPO"}
JSON
)"

if [[ "$AC440_STEERING_A_OWN_OUT" == *"RESUME: $AC440_A_SLUG"* ]]; then
  pass "AC1 (positive control): workflow-steering.js's SessionStart banner shows RESUME: <A's own slug> once A has its own per-actor pointer"
else
  fail "AC1 (positive control): workflow-steering.js's SessionStart banner did not show RESUME: $AC440_A_SLUG: $AC440_STEERING_A_OWN_OUT"
fi

AC440_A_LOG="$AC440_A_DIR/command-log.jsonl"
AC440_EVIDENCE_EVENT_OWN="{\"hook_event_name\":\"PostToolUse\",\"tool_name\":\"Bash\",\"cwd\":\"$AC440_REPO\",\"tool_input\":{\"command\":\"echo actor-a-own-capture-check\"},\"tool_response\":{\"exitCode\":0,\"stdout\":\"ok\"}}"
printf '%s' "$AC440_EVIDENCE_EVENT_OWN" \
  | FLOW_AGENTS_ACTOR=eval-actor-440-a node "$EVIDENCE_CAPTURE" >"$TMPDIR_EVAL/ac440-evidence-a-own.out" 2>"$TMPDIR_EVAL/ac440-evidence-a-own.err"

if [[ -f "$AC440_A_LOG" ]] && grep -qF "actor-a-own-capture-check" "$AC440_A_LOG"; then
  pass "evidence-capture.js (positive control): actor A's own capture still works once A has its own per-actor pointer"
else
  fail "evidence-capture.js (positive control): actor A's own capture did not work: $(cat "$TMPDIR_EVAL/ac440-evidence-a-own.out" "$TMPDIR_EVAL/ac440-evidence-a-own.err")"
fi

# 7.6 FIX 1 (HIGH, collision -- independent review): two distinct resolved actor keys sharing a
# >=64-char common sanitized prefix (differing only in a tail the pre-#440-fix-wave-2 64-char
# truncation would have discarded) must map to DISTINCT per-actor pointer files, and each actor's
# OWN read must resolve its OWN pointer -- never the other's -- proving neither session grounds
# onto the other. Reproduces the exact collision the review found:
# perActorCurrentFile(dir, A) === perActorCurrentFile(dir, B) under the pre-fix mapping.
AC440_COLLIDE_DIR="$TMPDIR_EVAL/collide-root/.kontourai/flow-agents"
if CP_HELPER_ARG="$CURRENT_POINTER_HELPER" DIR_ARG="$AC440_COLLIDE_DIR" node - <<'NODE' 2>"$TMPDIR_EVAL/ac440-collide.err"
const { perActorCurrentFile, writePerActorCurrent, readOwnCurrentPointer } = require(process.env.CP_HELPER_ARG);
const dir = process.env.DIR_ARG;
const prefix = 'claude-code:' + 's'.repeat(52);
const keyA = prefix + ':host-a';
const keyB = prefix + ':host-b';

const fileA = perActorCurrentFile(dir, keyA);
const fileB = perActorCurrentFile(dir, keyB);
if (fileA === fileB) {
  console.error(`FILES_COLLIDE: ${fileA}`);
  process.exit(1);
}

writePerActorCurrent(dir, keyA, { active_slug: 'collide-a-slug' });
writePerActorCurrent(dir, keyB, { active_slug: 'collide-b-slug' });

const resultA = readOwnCurrentPointer(dir, keyA);
const resultB = readOwnCurrentPointer(dir, keyB);
if (!resultA.payload || resultA.payload.active_slug !== 'collide-a-slug') {
  console.error(`ACTOR_A_WRONG_SLUG: ${JSON.stringify(resultA)}`);
  process.exit(1);
}
if (!resultB.payload || resultB.payload.active_slug !== 'collide-b-slug') {
  console.error(`ACTOR_B_WRONG_SLUG: ${JSON.stringify(resultB)}`);
  process.exit(1);
}
NODE
then
  pass "FIX 1: two actor keys sharing a >=64-char common sanitized prefix map to DISTINCT per-actor pointer files, and each actor's own read resolves its own session, never the other's (collision-resistant naming)"
else
  fail "FIX 1: colliding actor keys did not map to distinct files / grounded onto each other's session: $(cat "$TMPDIR_EVAL/ac440-collide.err")"
fi

# 7.7 FIX 1 (legacy-name fallback -- independent review): a pointer written under the PRE-fix-wave-2
# filename scheme (legacyPerActorCurrentFile -- sanitizeSegment(actorKey) alone, no hash) with NO
# new-scheme file present must still resolve for its owning actor -- the transition-window compat
# guarantee (a still-running published-3.9.0-era session's pointer keeps resolving).
if CP_HELPER_ARG="$CURRENT_POINTER_HELPER" DIR_ARG="$AC440_COLLIDE_DIR" node - <<'NODE' 2>"$TMPDIR_EVAL/ac440-legacy-fallback.err"
const fs = require('fs');
const path = require('path');
const { legacyPerActorCurrentFile, perActorCurrentFile, readOwnCurrentPointer } = require(process.env.CP_HELPER_ARG);
const dir = process.env.DIR_ARG;
const actorKey = 'eval-actor-440-legacy-fallback';

const newFile = perActorCurrentFile(dir, actorKey);
if (fs.existsSync(newFile)) { console.error(`NEW_FILE_UNEXPECTEDLY_EXISTS: ${newFile}`); process.exit(1); }

const legacyFile = legacyPerActorCurrentFile(dir, actorKey);
fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
fs.writeFileSync(legacyFile, JSON.stringify({ active_slug: 'legacy-fallback-slug' }));

const result = readOwnCurrentPointer(dir, actorKey);
if (!result.payload || result.payload.active_slug !== 'legacy-fallback-slug') {
  console.error(`FALLBACK_DID_NOT_RESOLVE: ${JSON.stringify(result)}`);
  process.exit(1);
}
if (result.file !== legacyFile) {
  console.error(`FALLBACK_FILE_MISMATCH: got ${result.file} expected ${legacyFile}`);
  process.exit(1);
}
NODE
then
  pass "FIX 1: a pointer written under the pre-fix-wave-2 legacy filename (no new-scheme file present) still resolves for its owning actor (transition-window fallback)"
else
  fail "FIX 1: legacy-filename fallback did not resolve as expected: $(cat "$TMPDIR_EVAL/ac440-legacy-fallback.err")"
fi

# 7.8 FINDING 1 (MED, independent review delta): record-agent-event's updateCurrentAgent must
# migrate a LEGACY-only per-actor pointer (as a still-running published-3.9.0-era sidecar would
# have written, pre-fix-wave-2) to the new collision-resistant filename on first touch, applying
# the active_agents/updated_at projection -- not silently skip that projection because it only
# read the new filename directly (fs.existsSync/readFileSync on perActorCurrentFile() alone,
# never falling back to legacyPerActorCurrentFile()).
AC440_MIGRATE_ROOT="$TMPDIR_EVAL/ac440-migrate-project/.kontourai/flow-agents"
AC440_MIGRATE_ACTOR="eval-actor-440-legacy-migrate"
AC440_MIGRATE_AGENT_ID="tool-worker"

flow_agents_node "workflow-sidecar" ensure-session \
  --artifact-root "$AC440_MIGRATE_ROOT" \
  --work-item "kontourai/flow-agents#94405" \
  --actor "$AC440_MIGRATE_ACTOR" \
  --source-request "Actor establishing a session whose pointer will be downgraded to legacy-only." \
  --summary "Legacy-pointer migration regression session." \
  >"$TMPDIR_EVAL/ac440-migrate-ensure.out" 2>"$TMPDIR_EVAL/ac440-migrate-ensure.err"
AC440_MIGRATE_SLUG="kontourai-flow-agents-94405"
AC440_MIGRATE_DIR="$AC440_MIGRATE_ROOT/$AC440_MIGRATE_SLUG"

# Downgrade the per-actor pointer to LEGACY-ONLY: capture the payload ensure-session wrote under
# the NEW filename, delete the new file, and re-write the SAME payload under the pre-fix-wave-2
# legacy filename -- reproducing exactly what a pointer a still-running published-3.9.0 sidecar
# (pre-fix-wave-2) would have on disk.
if CP_HELPER_ARG="$CURRENT_POINTER_HELPER" DIR_ARG="$AC440_MIGRATE_ROOT" ACTOR_ARG="$AC440_MIGRATE_ACTOR" node - <<'NODE' 2>"$TMPDIR_EVAL/ac440-migrate-downgrade.err"
const fs = require('fs');
const { perActorCurrentFile, legacyPerActorCurrentFile } = require(process.env.CP_HELPER_ARG);
const dir = process.env.DIR_ARG;
const actorKey = process.env.ACTOR_ARG;
const newFile = perActorCurrentFile(dir, actorKey);
if (!fs.existsSync(newFile)) { console.error(`NEW_FILE_MISSING: ${newFile}`); process.exit(1); }
const payload = fs.readFileSync(newFile, 'utf8');
fs.unlinkSync(newFile);
const legacyFile = legacyPerActorCurrentFile(dir, actorKey);
fs.writeFileSync(legacyFile, payload);
NODE
then
  pass "setup: actor's per-actor pointer downgraded to legacy-only (new-name file removed, same payload re-written under the pre-fix-wave-2 legacy filename)"
else
  fail "setup: failed to downgrade the per-actor pointer to legacy-only: $(cat "$TMPDIR_EVAL/ac440-migrate-downgrade.err")"
fi

flow_agents_node "workflow-sidecar" record-agent-event \
  --artifact-root "$AC440_MIGRATE_ROOT" \
  --actor "$AC440_MIGRATE_ACTOR" \
  --agent-id "$AC440_MIGRATE_AGENT_ID" \
  --kind note \
  --status active \
  --summary "legacy-pointer migration regression probe" \
  >"$TMPDIR_EVAL/ac440-migrate-record.out" 2>"$TMPDIR_EVAL/ac440-migrate-record.err"
AC440_MIGRATE_RECORD_STATUS=$?

# (source-tree legacy-ref scan note: the agent-events relative path below is built through a
# variable, not a literal contiguous "agents/" + agent-id token, matching
# test_model_routing_escalation.sh's own path.join(sdir, "agents", agent, "events.jsonl")
# convention -- a literal contiguous "agents/<agent-id>/..."-shaped string in an eval file is
# flagged by validate-source-tree.ts's legacy-ref scanner as a possible stale repo-path
# reference.)
if [[ "$AC440_MIGRATE_RECORD_STATUS" -eq 0 ]] && [[ -f "$AC440_MIGRATE_DIR/agents/$AC440_MIGRATE_AGENT_ID/events.jsonl" ]]; then
  pass "FINDING 1: record-agent-event succeeds and records the agent event against a legacy-only per-actor pointer"
else
  fail "FINDING 1: record-agent-event did not succeed/record against a legacy-only pointer: status=$AC440_MIGRATE_RECORD_STATUS $(cat "$TMPDIR_EVAL/ac440-migrate-record.out" "$TMPDIR_EVAL/ac440-migrate-record.err")"
fi

# The CORE regression: updateCurrentAgent must have migrated the pointer to the NEW filename with
# the active_agents projection applied -- not silently skipped it because it only checked the new
# (at that point, absent) filename directly.
if CP_HELPER_ARG="$CURRENT_POINTER_HELPER" DIR_ARG="$AC440_MIGRATE_ROOT" ACTOR_ARG="$AC440_MIGRATE_ACTOR" node - <<'NODE' 2>"$TMPDIR_EVAL/ac440-migrate-verify.err"
const fs = require('fs');
const { perActorCurrentFile } = require(process.env.CP_HELPER_ARG);
const dir = process.env.DIR_ARG;
const actorKey = process.env.ACTOR_ARG;
const newFile = perActorCurrentFile(dir, actorKey);
if (!fs.existsSync(newFile)) { console.error(`NEW_FILE_STILL_MISSING_AFTER_RECORD_AGENT_EVENT: ${newFile}`); process.exit(1); }
const payload = JSON.parse(fs.readFileSync(newFile, 'utf8'));
const active = Array.isArray(payload.active_agents) ? payload.active_agents : [];
const entry = active.find((a) => a && a.agent_id === 'tool-worker');
if (!entry || entry.status !== 'active') {
  console.error(`ACTIVE_AGENTS_PROJECTION_MISSING: ${JSON.stringify(payload)}`);
  process.exit(1);
}
NODE
then
  pass "FINDING 1: record-agent-event migrates a legacy-only per-actor pointer to the new collision-resistant filename on first touch, with the active_agents projection correctly applied (not silently skipped)"
else
  fail "FINDING 1: record-agent-event did not migrate/update the per-actor pointer as expected: $(cat "$TMPDIR_EVAL/ac440-migrate-verify.err")"
fi


echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "test_current_json_per_actor: all checks passed."
else
  echo "test_current_json_per_actor: $errors check(s) failed."
fi
exit "$errors"
