#!/usr/bin/env bash
# test_telemetry_task_slug.sh — Layer 2: work-item (task_slug) attribution
# (console#176 / flow-agents emitter substrate)
#
# Proves that every telemetry event stamps a top-level `task_slug` sourced from
# the active Builder run's current.json .active_slug (the same file the
# economics relay reads), so tool/turn/agent events can be grouped per work
# item downstream (Console "Cost by work-item"). The slug is:
#   - read from "$cwd/.kontourai/flow-agents/current.json" .active_slug, else
#     "$cwd/.flow-agents/current.json" (fallback location), else
#   - .artifact_dir when .active_slug is absent, else
#   - OMITTED entirely (no task_slug key) — never fabricated — for a non-Builder
#     session with no current.json.
#
# Only the slug STRING is stored; no prompt/args/file content. Uses the same
# TELEMETRY_DIR resolution convention as test_telemetry_tool_usage.sh (prefers
# context/scripts/telemetry when present, so this exercises the copy CI runs),
# the same hermetic env, and FLOW_AGENTS_TELEMETRY_FOREGROUND=true so
# assertions don't race a backgrounded subshell.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -d "$ROOT_DIR/context/scripts/telemetry" ]]; then
  TELEMETRY_DIR="$ROOT_DIR/context/scripts/telemetry"
else
  TELEMETRY_DIR="$HOME/.flow-agents/context/scripts/telemetry"
fi
TELEMETRY_SH="${TELEMETRY_DIR}/telemetry.sh"

TMPDIR_EVAL=$(mktemp -d /tmp/eval-telemetry-task-slug.XXXXXX)
TMPLOG="${TMPDIR_EVAL}/test-output.jsonl"

pass=0; fail=0
_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }

echo "=== Layer 2: Telemetry Work-Item (task_slug) Attribution (console#176) ==="
echo ""

if [[ ! -f "$TELEMETRY_SH" ]]; then
  _fail "telemetry.sh not found at $TELEMETRY_SH"
  echo "Cannot continue without telemetry script"
  rm -rf "$TMPDIR_EVAL"
  exit 1
fi

# Run a single hook event against telemetry.sh in foreground mode and return the
# resulting event (jq-compact, one line) from the full-channel log.
_run_event() {
  local hook_type="$1" input="$2"; shift 2
  local extra_env=("$@")
  local common_env=(
    HOME="${TMPDIR_EVAL}/home"
    TELEMETRY_ENABLED=true
    TELEMETRY_CHANNELS=full
    TELEMETRY_CHANNEL_FULL_LOG_FILE="$TMPLOG"
    FLOW_AGENTS_TELEMETRY_FOREGROUND=true
    TELEMETRY_CONFIG_FILE="$TMPDIR_EVAL/telemetry.conf"
    TELEMETRY_DATA_DIR="$TMPDIR_EVAL"
    TELEMETRY_SESSION_DIR="$TMPDIR_EVAL/sessions"
    TELEMETRY_USAGE_TRACKING=true
  )
  mkdir -p "${TMPDIR_EVAL}/home" "${TMPDIR_EVAL}/sessions"

  local before_lines
  touch "$TMPLOG"
  before_lines=$(wc -l < "$TMPLOG" | tr -d ' ')

  echo "$input" | env "${common_env[@]}" ${extra_env[@]+"${extra_env[@]}"} bash "$TELEMETRY_SH" "$hook_type" dev 2>/dev/null

  tail -n +"$((before_lines + 1))" "$TMPLOG" 2>/dev/null | tail -1
}

# --- 1. Canonical: cwd/.kontourai/flow-agents/current.json .active_slug -------
echo "--- preToolUse in a Builder cwd (.kontourai/flow-agents/current.json .active_slug) stamps task_slug ---"
CWD1="${TMPDIR_EVAL}/builder-cwd"
mkdir -p "$CWD1/.kontourai/flow-agents"
echo '{"active_slug":"kontourai-flow-agents-568","artifact_dir":"/some/dir"}' > "$CWD1/.kontourai/flow-agents/current.json"
input1=$(jq -nc --arg cwd "$CWD1" '{session_id:"task-slug-1",cwd:$cwd,hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:"echo hi"}}')
out1=$(_run_event "preToolUse" "$input1")

if [[ -n "$out1" ]]; then
  ts1=$(echo "$out1" | jq -r '.task_slug // empty')
  et1=$(echo "$out1" | jq -r '.event_type // empty')
  [[ "$et1" == "tool.invoke" ]] && _pass "preToolUse maps to tool.invoke" || _fail "expected tool.invoke, got $et1"
  [[ "$ts1" == "kontourai-flow-agents-568" ]] && _pass "task_slug is the active_slug from .kontourai/flow-agents/current.json" || _fail "expected task_slug=kontourai-flow-agents-568, got '$ts1'"
else
  _fail "no tool.invoke event emitted for Builder-cwd case"
fi

# --- 2. Fallback location: cwd/.flow-agents/current.json ----------------------
echo ""
echo "--- preToolUse with only the .flow-agents/current.json fallback location ---"
CWD2="${TMPDIR_EVAL}/builder-cwd-fallback"
mkdir -p "$CWD2/.flow-agents"
echo '{"active_slug":"fallback-slug"}' > "$CWD2/.flow-agents/current.json"
input2=$(jq -nc --arg cwd "$CWD2" '{session_id:"task-slug-2",cwd:$cwd,hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:"echo hi"}}')
out2=$(_run_event "preToolUse" "$input2")

if [[ -n "$out2" ]]; then
  ts2=$(echo "$out2" | jq -r '.task_slug // empty')
  [[ "$ts2" == "fallback-slug" ]] && _pass "task_slug reads from the .flow-agents/current.json fallback when .kontourai/... is absent" || _fail "expected task_slug=fallback-slug, got '$ts2'"
else
  _fail "no tool.invoke event emitted for fallback-location case"
fi

# --- 3. artifact_dir fallback when .active_slug is absent ---------------------
echo ""
echo "--- preToolUse where current.json has no active_slug: falls back to artifact_dir ---"
CWD3="${TMPDIR_EVAL}/builder-cwd-artifactdir"
mkdir -p "$CWD3/.kontourai/flow-agents"
echo '{"artifact_dir":"only-artifact-dir"}' > "$CWD3/.kontourai/flow-agents/current.json"
input3=$(jq -nc --arg cwd "$CWD3" '{session_id:"task-slug-3",cwd:$cwd,hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:"echo hi"}}')
out3=$(_run_event "preToolUse" "$input3")

if [[ -n "$out3" ]]; then
  ts3=$(echo "$out3" | jq -r '.task_slug // empty')
  [[ "$ts3" == "only-artifact-dir" ]] && _pass "task_slug falls back to artifact_dir when active_slug is absent" || _fail "expected task_slug=only-artifact-dir, got '$ts3'"
else
  _fail "no tool.invoke event emitted for artifact_dir-fallback case"
fi

# --- 4. Non-Builder session: NO current.json => NO task_slug key (never fabricated) ---
echo ""
echo "--- preToolUse in a non-Builder cwd (no current.json): no task_slug key at all ---"
CWD4="${TMPDIR_EVAL}/plain-cwd"
mkdir -p "$CWD4"
input4=$(jq -nc --arg cwd "$CWD4" '{session_id:"task-slug-4",cwd:$cwd,hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:"echo hi"}}')
out4=$(_run_event "preToolUse" "$input4")

if [[ -n "$out4" ]]; then
  has_ts4=$(echo "$out4" | jq -r 'has("task_slug")')
  [[ "$has_ts4" == "false" ]] && _pass "no task_slug key when there is no current.json (never fabricated)" || _fail "expected no task_slug key, but has(\"task_slug\")=$has_ts4"
else
  _fail "no tool.invoke event emitted for non-Builder case (should still emit, just without task_slug)"
fi

# --- 5. Empty active_slug/artifact_dir => still no task_slug key --------------
echo ""
echo "--- preToolUse where current.json exists but active_slug/artifact_dir are empty: no task_slug key ---"
CWD5="${TMPDIR_EVAL}/builder-cwd-empty"
mkdir -p "$CWD5/.kontourai/flow-agents"
echo '{"active_slug":"","artifact_dir":""}' > "$CWD5/.kontourai/flow-agents/current.json"
input5=$(jq -nc --arg cwd "$CWD5" '{session_id:"task-slug-5",cwd:$cwd,hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:"echo hi"}}')
out5=$(_run_event "preToolUse" "$input5")

if [[ -n "$out5" ]]; then
  has_ts5=$(echo "$out5" | jq -r 'has("task_slug")')
  [[ "$has_ts5" == "false" ]] && _pass "empty active_slug/artifact_dir yields no task_slug key (not an empty string)" || _fail "expected no task_slug key for empty slug, but has(\"task_slug\")=$has_ts5"
else
  _fail "no tool.invoke event emitted for empty-slug case"
fi

rm -rf "$TMPDIR_EVAL"

echo ""
echo "Telemetry task_slug attribution: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
