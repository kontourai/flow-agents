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

# --- 5. record-gate-claim resolves A's own per-actor flow/step, not B's legacy pointer (AC11) --
echo "--- 5. record-gate-claim resolves A's own per-actor flow/step, not B's legacy pointer (AC11) ---"

AC11_ROOT="$TMPDIR_EVAL/ac11-project/.kontourai/flow-agents"

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

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "test_current_json_per_actor: all checks passed."
else
  echo "test_current_json_per_actor: $errors check(s) failed."
fi
exit "$errors"
