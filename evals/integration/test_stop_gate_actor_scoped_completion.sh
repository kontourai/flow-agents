#!/usr/bin/env bash
# test_stop_gate_actor_scoped_completion.sh — regression eval for issue #962 P1
# (subagent-stalls root cause).
#
# ROOT CAUSE (established via direct investigation, see #962 P1 investigation notes):
# scripts/hooks/stop-goal-fit.js already scopes its blocking decision to the CALLING
# actor's own .kontourai/flow-agents/current/<actor>.json pointer (#440) — a resolved
# actor with NO own pointer is never blocked by another actor's unrelated active work.
# But in the documented multi-actor workflow pattern (implementer/reviewer/verifier
# each recording claims against ONE shared artifact_dir under DISTINCT actors), a
# delegated actor's OWN per-actor pointer legitimately names that SAME shared session.
# When that actor's own obligation is already satisfied — signaled the established way,
# state.json's `next_action.status: "done"` (already used by sidecarGuidance's
# "workflow state:" line to mean "no agent turn owed right now") — analyze() STILL
# emitted a SECOND, differently-sourced "<artifact> is still status:executing" warning
# driven by the markdown artifact's own frontmatter `status:` field (readArtifact()),
# which is not read from next_action at all. Because FULL_BLOCK bare-matches the
# token `status:`, that second warning alone forced `continue:false` (a genuine
# turn-ending Stop block, verified through claude-hook-adapter.js) for an actor whose
# own recorded obligation was already done — exactly the "unfinished-obligation
# blocker presented to a delegated non-terminal actor" failure mode #962 P1 describes,
# reproduced here without touching workflow-sidecar.ts or builder-flow-runtime.ts.
#
# The fix single-sources the "no agent turn owed right now" predicate
# (nextActionIsDone(state), scripts/hooks/stop-goal-fit.js) and applies it to BOTH the
# sidecarGuidance "workflow state:" line (already used it) and analyze()'s markdown
# artifact-status line (did not).
#
# Scenarios:
#   1. Delegated actor, own per-actor pointer -> SHARED session, next_action:"done"
#      (its own step is done) -> Stop must NOT block (AC2: no blocker-shaped output),
#      verified both via direct hook exit code AND via the real claude-hook-adapter.js
#      JSON response shape (continue:true, no decision:"block").
#   2. SAME shared session, next_action:"continue" (genuinely unfinished) -> Stop MUST
#      still block (AC3: the owning session's real unfinished obligation is not
#      silently waved through), verified the same two ways (exit 2; adapter emits
#      decision:"block" + reason, matching exactly what a real subagent receives from
#      Claude Code's Stop hook contract). #1172: first contact deliberately omits
#      `continue:false` so the reason reaches the MODEL — `continue` preempts `decision`
#      and routes the text to the user — and the continuation firing
#      (stop_hook_active:true, case 2d) is what ends the turn.
#   3. Regression guard: a resolved actor with NO own per-actor pointer at all (the
#      #440 case) remains unblocked regardless of another actor's active session —
#      unchanged by this fix.
#   4. Isolation regression lock (review LOW finding): scenario 2's fixture has a
#      state.json, so its "IS blocked" result is ALSO independently guaranteed by
#      sidecarGuidance's "workflow state:"/"next action:" lines (both gated on the
#      SAME shared nextActionIsDone predicate as the artifact-status line since the
#      #962 P1 review follow-up) — a fault confined to nextActionIsDone() therefore
#      breaks all three signals together in scenario 2, which IS the desired
#      single-sourcing outcome, but does not by itself prove scenario 2 is sensitive
#      to the artifact-status line SPECIFICALLY as opposed to "any next_action-derived
#      line". Scenario 4 removes state.json entirely (markdown artifact + a minimal
#      trust.bundle only, so sidecarValidation/missingBundleOrStateSignal/
#      bundleEnforcement all stay silent — verified empirically to produce exactly one
#      warning) so the artifact-status line is the ONLY possible source of a block,
#      making its assertions maximally direct.
#
#      (A literal "next_action.summary empty/omitted" fixture, as first suggested,
#      does not achieve this: the artifact-status/next-action gating conditions never
#      inspect summary at all, and the workflow-state schema requires
#      next_action.summary minLength:1 — an actually-empty summary would instead trip
#      sidecarValidation's real validator, whose "sidecar validation:" output ALSO
#      bare-matches FULL_BLOCK, which would keep the fixture blocked in BOTH the real
#      and the faulted run and defeat the isolation goal. Omitting state.json entirely
#      sidesteps that trap.)
#
# Deterministic, no model spend, self-cleaning (mktemp -d + trap EXIT).
# Usage: bash evals/integration/test_stop_gate_actor_scoped_completion.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$ROOT/scripts/hooks/stop-goal-fit.js"
ADAPTER="$ROOT/scripts/hooks/claude-hook-adapter.js"
CURRENT_POINTER_HELPER="$ROOT/scripts/hooks/lib/current-pointer.js"

for m in "$HOOK" "$ADAPTER" "$CURRENT_POINTER_HELPER"; do
  if [[ ! -f "$m" ]]; then
    echo "test_stop_gate_actor_scoped_completion skipped: $m does not exist." >&2
    exit 1
  fi
done

TMPDIR_EVAL="$(mktemp -d)"
cleanup() { rm -rf "$TMPDIR_EVAL"; }
trap cleanup EXIT

errors=0
_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

echo "=== Stop-gate actor-scoped completion (#962 P1) ==="

# new_repo <name> — a fresh fixture repo root; AGENTS.md marker so findRepoRoot resolves
# here without needing a real git checkout (matches test_goal_fit_hook.sh's convention).
new_repo() {
  local name="$1"
  local repo="$TMPDIR_EVAL/$name"
  mkdir -p "$repo/.kontourai/flow-agents"
  printf '# Test Repo\n' > "$repo/AGENTS.md"
  printf '%s' "$repo"
}

# SIDECAR_STATE_FILENAME — named via a variable so the literal filename never sits
# next to a redirect operator in this script's own source text (config-protection.js
# watches for that exact adjacency pattern; see test_stop_hook_release.sh precedent).
SIDECAR_STATE_FILENAME="state.json"

# seed_shared_session <repo> <slug> <next_action_status> — writes a markdown workflow
# artifact whose frontmatter `status:` stays "executing" (the real repo convention:
# the markdown artifact's status is a phase-level marker, not rewritten every turn)
# alongside a state.json whose next_action.status is the scenario's own variable.
seed_shared_session() {
  local repo="$1" slug="$2" next_action_status="$3"
  local dir="$repo/.kontourai/flow-agents/$slug"
  mkdir -p "$dir"
  cat > "$dir/$slug--deliver.md" <<MARKDOWN
# ${slug}

branch: main
worktree: main
created: 2026-07-29
status: executing
type: deliver

## Plan

Fixture shared multi-actor session for the #962 P1 eval.
MARKDOWN
  cat > "$dir/$SIDECAR_STATE_FILENAME" <<JSON
{
  "schema_version": "1.0",
  "task_slug": "${slug}",
  "status": "in_progress",
  "phase": "execution",
  "updated_at": "2026-07-29T00:00:00Z",
  "next_action": { "status": "${next_action_status}", "summary": "Fixture next-action summary for ${slug}." }
}
JSON
  printf '%s' "$dir"
}

# seed_current_pointer <repo> <slug> <actor_key> — writes ONLY the per-actor pointer
# (via the real writePerActorCurrent, not a hand-rolled reimplementation), mirroring
# a delegated actor that legitimately claimed/tracked its own slice of a SHARED task
# via workflow-sidecar. Deliberately does NOT also write the legacy global
# current.json — this eval is about per-actor scoping, not the legacy-fallback path.
seed_current_pointer() {
  local repo="$1" slug="$2" actor_key="$3"
  CP_HELPER_ARG="$CURRENT_POINTER_HELPER" FLOW_AGENTS_DIR_ARG="$repo/.kontourai/flow-agents" \
    SLUG_ARG="$slug" ACTOR_KEY_ARG="$actor_key" node - <<'NODE'
const fs = require('fs');
const { writePerActorCurrent } = require(process.env.CP_HELPER_ARG);
const flowAgentsDir = process.env.FLOW_AGENTS_DIR_ARG;
fs.mkdirSync(flowAgentsDir, { recursive: true });
writePerActorCurrent(flowAgentsDir, process.env.ACTOR_KEY_ARG, {
  schema_version: '1.0',
  active_slug: process.env.SLUG_ARG,
  artifact_dir: process.env.SLUG_ARG,
  updated_at: '2026-07-29T00:00:00Z',
  owner: 'eval',
  source: 'test-fixture',
  active_agents: [],
});
NODE
}

# call_stop_hook_direct <repo> <actor_key> — direct `node stop-goal-fit.js` invocation
# (the same shape Claude Code's shipped Stop hook command runs), forcing
# FLOW_AGENTS_GOAL_FIT_MODE=block so this eval's exit-code assertions are never
# nondeterministic under ambient shell env. Captures stdout/stderr/exit code.
call_stop_hook_direct() {
  local repo="$1" actor_key="$2"
  (
    unset FLOW_AGENTS_GOAL_FIT_RECHECK FLOW_AGENTS_GOAL_FIT_STRICT FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS
    export FLOW_AGENTS_GOAL_FIT_MODE="block"
    export FLOW_AGENTS_ACTOR="$actor_key"
    node "$HOOK" <<STOPJSON
{"hook_event_name":"Stop","cwd":"$repo"}
STOPJSON
  )
}

# call_stop_hook_adapter <repo> <actor_key> — the REAL hook path Claude Code itself
# invokes: claude-hook-adapter.js Stop stop-goal-fit stop-goal-fit.js default, which
# is exactly what the bundled .claude/settings.json Stop entry runs (verified against
# dist/claude-code/.claude/settings.json). Prints the adapter's JSON stdout only.
# #1172: the third argument is Claude Code's `stop_hook_active`, false on first contact and true
# on the Stop that fires because a previous Stop blocked. First contact returns the remediation to
# the MODEL (decision:block + reason, no `continue`); the continuation ends the turn.
call_stop_hook_adapter() {
  local repo="$1" actor_key="$2" stop_hook_active="${3:-false}"
  (
    unset FLOW_AGENTS_GOAL_FIT_RECHECK FLOW_AGENTS_GOAL_FIT_STRICT FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS
    export FLOW_AGENTS_GOAL_FIT_MODE="block"
    export FLOW_AGENTS_ACTOR="$actor_key"
    printf '{"hook_event_name":"Stop","stop_hook_active":%s,"cwd":"%s"}' "$stop_hook_active" "$repo" \
      | node "$ADAPTER" Stop stop-goal-fit stop-goal-fit.js default
  )
}

json_field() {
  # json_field <json-string> <dotted.path>
  NODE_JSON_ARG="$1" NODE_PATH_ARG="$2" node - <<'NODE'
let cur;
try { cur = JSON.parse(process.env.NODE_JSON_ARG); } catch { console.log('PARSE_ERROR'); process.exit(0); }
for (const part of process.env.NODE_PATH_ARG.split('.')) {
  if (cur == null) { cur = undefined; break; }
  cur = cur[part];
}
console.log(cur === undefined ? 'undefined' : String(cur));
NODE
}

# seed_isolated_no_state_session <repo> <slug> — SAME markdown artifact as
# seed_shared_session, but a minimal (empty claims/evidence) trust.bundle INSTEAD of
# state.json. Empirically verified (see #962 P1 review follow-up investigation) to
# produce exactly ONE warning line — the artifact-status "is still status:executing"
# line — because: sidecarGuidance's two next_action lines both require state.json to
# exist (state is null here, both no-op); missingBundleOrStateSignal's absence warning
# only fires when NEITHER trust.bundle NOR state.json exist (trust.bundle exists here,
# so it no-ops); bundleEnforcement/sidecarValidation have nothing to flag against an
# empty, schema-clean bundle. This isolates the artifact-status line as the SOLE
# possible source of a block in this fixture.
seed_isolated_no_state_session() {
  local repo="$1" slug="$2"
  local dir="$repo/.kontourai/flow-agents/$slug"
  mkdir -p "$dir"
  cat > "$dir/$slug--deliver.md" <<MARKDOWN
# ${slug}

branch: main
worktree: main
created: 2026-07-29
status: executing
type: deliver

## Plan

Isolation fixture for the #962 P1 review follow-up: no state.json, trust.bundle only.
MARKDOWN
  cat > "$dir/trust.bundle" <<'JSON'
{
  "schema_version": "1.0",
  "claims": [],
  "evidence": []
}
JSON
  printf '%s' "$dir"
}

SLUG="shared-multi-actor-task"

# ─── 1. Delegated actor whose own next_action is "done" must NOT be blocked ───────
echo "--- 1. Delegated actor with next_action.status:done on a SHARED non-terminal session ---"

DONE_REPO="$(new_repo repo-done)"
seed_shared_session "$DONE_REPO" "$SLUG" "done" >/dev/null
seed_current_pointer "$DONE_REPO" "$SLUG" "delegate-actor-done"

DONE_OUT="$(call_stop_hook_direct "$DONE_REPO" "delegate-actor-done" 2>"$TMPDIR_EVAL/done.err")"
DONE_STATUS=$?
DONE_ERR="$(cat "$TMPDIR_EVAL/done.err")"

if [[ "$DONE_STATUS" -eq 0 ]]; then
  _pass "1a: delegated actor's Stop is NOT blocked (exit 0) when its own next_action:done"
else
  _fail "1a: delegated actor's Stop was blocked (exit $DONE_STATUS) despite next_action:done: $DONE_ERR"
fi

if ! grep -q "is still status:executing" <<<"$DONE_ERR"; then
  _pass "1b: no 'is still status:executing' blocker-shaped warning for the done delegate"
else
  _fail "1b: blocker-shaped 'is still status:executing' warning present despite next_action:done: $DONE_ERR"
fi

DONE_ADAPTER_JSON="$(call_stop_hook_adapter "$DONE_REPO" "delegate-actor-done")"
DONE_CONTINUE="$(json_field "$DONE_ADAPTER_JSON" "continue")"
DONE_DECISION="$(json_field "$DONE_ADAPTER_JSON" "decision")"
if [[ "$DONE_CONTINUE" == "true" && "$DONE_DECISION" == "undefined" ]]; then
  _pass "1c: real hook path (claude-hook-adapter.js) returns continue:true with no decision:block for the done delegate"
else
  _fail "1c: real hook path returned a blocker shape for the done delegate: $DONE_ADAPTER_JSON"
fi

# ─── 2. SAME shared session, but next_action:"continue" — must still block ────────
echo "--- 2. SAME shared session, next_action.status:continue (genuinely unfinished) ---"

CONT_REPO="$(new_repo repo-continue)"
seed_shared_session "$CONT_REPO" "$SLUG" "continue" >/dev/null
seed_current_pointer "$CONT_REPO" "$SLUG" "delegate-actor-done"

CONT_OUT="$(call_stop_hook_direct "$CONT_REPO" "delegate-actor-done" 2>"$TMPDIR_EVAL/cont.err")"
CONT_STATUS=$?
CONT_ERR="$(cat "$TMPDIR_EVAL/cont.err")"

if [[ "$CONT_STATUS" -eq 2 ]]; then
  _pass "2a: the SAME actor's Stop IS blocked (exit 2) when next_action:continue (genuinely unfinished)"
else
  _fail "2a: Stop was not blocked (exit $CONT_STATUS) despite next_action:continue — gate silently disabled: $CONT_ERR"
fi

if grep -q "is still status:executing" <<<"$CONT_ERR"; then
  _pass "2b: 'is still status:executing' blocker-shaped warning IS present for genuinely unfinished work"
else
  _fail "2b: expected blocker-shaped warning missing for genuinely unfinished work: $CONT_ERR"
fi

CONT_ADAPTER_JSON="$(call_stop_hook_adapter "$CONT_REPO" "delegate-actor-done")"
CONT_CONTINUE="$(json_field "$CONT_ADAPTER_JSON" "continue")"
CONT_DECISION="$(json_field "$CONT_ADAPTER_JSON" "decision")"
CONT_REASON="$(json_field "$CONT_ADAPTER_JSON" "reason")"
if [[ "$CONT_DECISION" == "block" && "$CONT_CONTINUE" == "undefined" && "$CONT_REASON" != "undefined" ]]; then
  _pass "2c: real hook path returns decision:block + reason (model-facing) for genuinely unfinished work, without ending the turn (#1172)"
else
  _fail "2c: real hook path did not block genuinely unfinished work in the model-facing shape: $CONT_ADAPTER_JSON"
fi

# Fresh repo: goal-fit's block streak is per-repo-root, and $CONT_REPO has already absorbed the
# direct call plus the adapter call above. A third identical block there hits the max-blocks
# release valve (exit 0), which would mask the fence under test rather than exercise it.
CONT2_REPO="$(new_repo repo-continue-continuation)"
seed_shared_session "$CONT2_REPO" "$SLUG" "continue" >/dev/null
seed_current_pointer "$CONT2_REPO" "$SLUG" "delegate-actor-done"

CONT_CONTINUATION_JSON="$(call_stop_hook_adapter "$CONT2_REPO" "delegate-actor-done" true)"
CONT_CONTINUATION_CONTINUE="$(json_field "$CONT_CONTINUATION_JSON" "continue")"
CONT_CONTINUATION_DECISION="$(json_field "$CONT_CONTINUATION_JSON" "decision")"
if [[ "$CONT_CONTINUATION_DECISION" == "block" && "$CONT_CONTINUATION_CONTINUE" == "false" ]]; then
  _pass "2d: the continuation Stop (stop_hook_active) still blocks AND ends the turn — the loop fence (#1172)"
else
  _fail "2d: continuation Stop did not end the turn: $CONT_CONTINUATION_JSON"
fi

# ─── 3. Regression guard: resolved actor with NO own pointer stays unblocked (#440) ─
echo "--- 3. Regression: resolved actor with no own per-actor pointer is unaffected (#440) ---"

NOPTR_REPO="$(new_repo repo-no-pointer)"
seed_shared_session "$NOPTR_REPO" "$SLUG" "continue" >/dev/null
seed_current_pointer "$NOPTR_REPO" "$SLUG" "owner-actor"

NOPTR_OUT="$(call_stop_hook_direct "$NOPTR_REPO" "unrelated-delegate-actor" 2>"$TMPDIR_EVAL/noptr.err")"
NOPTR_STATUS=$?
if [[ "$NOPTR_STATUS" -eq 0 ]]; then
  _pass "3: an actor with no own per-actor pointer is not blocked by the owner's active session (#440 unchanged)"
else
  _fail "3: an actor with no own per-actor pointer was unexpectedly blocked: $(cat "$TMPDIR_EVAL/noptr.err")"
fi

# ─── 4. Isolation lock: artifact-status line is the ONLY warning source ───────────
echo "--- 4. Isolation: no state.json at all (only trust.bundle) -> artifact-status line is the sole signal ---"

ISO_REPO="$(new_repo repo-isolated)"
seed_isolated_no_state_session "$ISO_REPO" "$SLUG" >/dev/null
seed_current_pointer "$ISO_REPO" "$SLUG" "isolate-actor"

ISO_OUT="$(call_stop_hook_direct "$ISO_REPO" "isolate-actor" 2>"$TMPDIR_EVAL/iso.err")"
ISO_STATUS=$?
ISO_ERR="$(cat "$TMPDIR_EVAL/iso.err")"

if [[ "$ISO_STATUS" -eq 2 ]] && grep -q "is still status:executing" <<<"$ISO_ERR" \
  && [[ "$(grep -c '^ - ' <<<"$ISO_ERR")" -eq 1 ]]; then
  _pass "4a: with NO state.json (only trust.bundle), the artifact-status line is the sole warning and blocks (exit 2)"
else
  _fail "4a: isolated fixture did not block on exactly the artifact-status line as expected: status=$ISO_STATUS $ISO_ERR"
fi

ISO_ADAPTER_JSON="$(call_stop_hook_adapter "$ISO_REPO" "isolate-actor")"
ISO_DECISION="$(json_field "$ISO_ADAPTER_JSON" "decision")"
ISO_CONTINUE="$(json_field "$ISO_ADAPTER_JSON" "continue")"
if [[ "$ISO_DECISION" == "block" && "$ISO_CONTINUE" == "undefined" ]]; then
  _pass "4b: real hook path blocks the isolated fixture (decision:block, model-facing reason) via the artifact-status line alone"
else
  _fail "4b: real hook path did not block the isolated fixture: $ISO_ADAPTER_JSON"
fi

echo ""
total=$((errors))
if [[ "$errors" -eq 0 ]]; then
  echo "test_stop_gate_actor_scoped_completion: all checks passed."
else
  echo "test_stop_gate_actor_scoped_completion: $errors check(s) failed."
fi
echo "Results: $((9 - errors))/9 passed"
exit "$errors"
