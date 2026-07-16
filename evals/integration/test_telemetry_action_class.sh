#!/usr/bin/env bash
# test_telemetry_action_class.sh — normalized action-class ontology enrichment
# (kontourai/flow-agents#582, final child of #568)
#
# Proves every tool event carries a normalized cross-runtime activity class
# .tool.action ∈ {edit, search, test, git, build, web, read}, mapped from each
# runtime's native tool vocabulary (Claude Code / Codex / Kiro), and present
# ONLY when classifiable — ABSENT (never a fabricated class) otherwise.
#
# Highest-value teeth:
#   - classification correctness + no-guess: every mapped tool -> its exact
#     class; every unmapped/ambiguous tool -> NO .tool.action.
#   - test-vs-build disambiguation table (npm test->test, npm run build->build,
#     bare npm->none).
#   - verb false-positives: gitfoo / /path/git-helper / echo git / X=1 make
#     do not misclassify (whole leading-token match, env-prefix stripped).
#   - cross-runtime: Claude (Edit/Grep/...) AND Codex (apply_patch/fs_read/shell)
#     both classify.
#   - privacy: the raw command string is NOT added by this change (only the enum).
#   - presence honesty: unclassifiable -> no .tool.action key.
#
# Uses the same TELEMETRY_DIR resolution + FLOW_AGENTS_TELEMETRY_FOREGROUND
# convention as test_telemetry_delegation.sh so assertions never race a
# backgrounded subshell.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -d "$ROOT_DIR/context/scripts/telemetry" ]]; then
  TELEMETRY_DIR="$ROOT_DIR/context/scripts/telemetry"
else
  TELEMETRY_DIR="$HOME/.flow-agents/context/scripts/telemetry"
fi
TELEMETRY_SH="${TELEMETRY_DIR}/telemetry.sh"

TMPDIR_EVAL=$(mktemp -d /tmp/eval-telemetry-action-class.XXXXXX)
TMPLOG="${TMPDIR_EVAL}/test-output.jsonl"

pass=0; fail=0
_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }

echo "=== Telemetry Action-Class Ontology (#582: .tool.action) ==="
echo ""

if [[ ! -f "$TELEMETRY_SH" ]]; then
  _fail "telemetry.sh not found at $TELEMETRY_SH"
  rm -rf "$TMPDIR_EVAL"; exit 1
fi

# Run one hook event against telemetry.sh (foreground) and echo the LAST
# full-channel log line (the primary tool event).
_run_tool_event() {
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

# Assert a Bash-family command classifies to $want (or none when $want empty).
_assert_bash() {
  local runtime="$1" tool="$2" cmd="$3" want="$4" label="$5"
  local inv out got
  inv=$(jq -nc --arg t "$tool" --arg c "$cmd" '{session_id:"ac",hook_event_name:"PreToolUse",tool_name:$t,tool_input:{command:$c}}')
  out=$(FLOW_AGENTS_TELEMETRY_RUNTIME="$runtime" _run_tool_event "preToolUse" "$inv" FLOW_AGENTS_TELEMETRY_RUNTIME="$runtime")
  if [[ -z "$want" ]]; then
    got=$(echo "$out" | jq -r 'if (.tool | has("action")) then .tool.action else "ABSENT" end')
    [[ "$got" == "ABSENT" ]] && _pass "$label -> no .tool.action (honest absence)" || _fail "$label expected NO action, got '$got'"
  else
    got=$(echo "$out" | jq -r '.tool.action // "ABSENT"')
    [[ "$got" == "$want" ]] && _pass "$label -> action=='$want'" || _fail "$label expected '$want', got '$got'"
  fi
}

# Assert a non-shell tool (input irrelevant) classifies to $want (or none).
_assert_tool() {
  local tool="$1" want="$2" input="$3" label="$4"
  local inv out got
  inv=$(jq -nc --arg t "$tool" --argjson ti "$input" '{session_id:"ac",hook_event_name:"PreToolUse",tool_name:$t,tool_input:$ti}')
  out=$(_run_tool_event "preToolUse" "$inv")
  if [[ -z "$want" ]]; then
    got=$(echo "$out" | jq -r 'if (.tool | has("action")) then .tool.action else "ABSENT" end')
    [[ "$got" == "ABSENT" ]] && _pass "$label -> no .tool.action (honest absence)" || _fail "$label expected NO action, got '$got'"
  else
    got=$(echo "$out" | jq -r '.tool.action // "ABSENT"')
    [[ "$got" == "$want" ]] && _pass "$label -> action=='$want'" || _fail "$label expected '$want', got '$got'"
  fi
}

# --- (a) Claude Code vocabulary: one representative per class -----------------
echo "--- (a) Claude Code tool vocabulary -> each class ---"
_assert_tool "Edit"     "edit"   '{"file_path":"a.ts"}'         "Edit"
_assert_tool "Write"    "edit"   '{"file_path":"a.ts"}'         "Write"
_assert_tool "MultiEdit" "edit"  '{"file_path":"a.ts"}'         "MultiEdit"
_assert_tool "Grep"     "search" '{"pattern":"foo"}'            "Grep"
_assert_tool "Glob"     "search" '{"pattern":"**/*.ts"}'        "Glob"
_assert_tool "Read"     "read"   '{"file_path":"a.ts"}'         "Read"
_assert_tool "WebFetch" "web"    '{"url":"https://x"}'          "WebFetch"
_assert_tool "WebSearch" "web"   '{"query":"x"}'                "WebSearch"

# --- (b) Bash verb sub-classification ----------------------------------------
echo ""
echo "--- (b) Bash verb sub-classification (leading token) ---"
_assert_bash "claude-code" "Bash" "git status"        "git"   "git status"
_assert_bash "claude-code" "Bash" "git commit -m x"   "git"   "git commit"
_assert_bash "claude-code" "Bash" "npm test"          "test"  "npm test"
_assert_bash "claude-code" "Bash" "pytest -q"         "test"  "pytest -q"
_assert_bash "claude-code" "Bash" "jest"              "test"  "jest"
_assert_bash "claude-code" "Bash" "go test ./..."     "test"  "go test"
_assert_bash "claude-code" "Bash" "cargo test"        "test"  "cargo test"
_assert_bash "claude-code" "Bash" "make test"         "test"  "make test"
_assert_bash "claude-code" "Bash" "npm run test:unit" "test"  "npm run test:unit"
_assert_bash "claude-code" "Bash" "npm run build"     "build" "npm run build"
_assert_bash "claude-code" "Bash" "npm run build:prod" "build" "npm run build:prod"
_assert_bash "claude-code" "Bash" "make"              "build" "make (bare)"
_assert_bash "claude-code" "Bash" "make build"        "build" "make build"
_assert_bash "claude-code" "Bash" "tsc -p ."          "build" "tsc"
_assert_bash "claude-code" "Bash" "go build ./..."    "build" "go build"
_assert_bash "claude-code" "Bash" "vite build"        "build" "vite build"

# --- (c) test-vs-build disambiguation table (the HIGHEST-value teeth) --------
echo ""
echo "--- (c) test-vs-build disambiguation (npm test|npm run build|bare npm) ---"
_assert_bash "claude-code" "Bash" "npm test"       "test"  "npm test"
_assert_bash "claude-code" "Bash" "npm run build"  "build" "npm run build"
_assert_bash "claude-code" "Bash" "npm"            ""      "bare npm (unknown intent)"
_assert_bash "claude-code" "Bash" "npm run lint"   ""      "npm run lint (unknown script)"
_assert_bash "claude-code" "Bash" "pnpm test"      "test"  "pnpm test"
_assert_bash "claude-code" "Bash" "yarn run build" "build" "yarn run build"

# --- (d) cross-runtime: Codex native vocabulary ------------------------------
echo ""
echo "--- (d) cross-runtime: Codex vocabulary (apply_patch/fs_read/shell) ---"
_assert_tool "apply_patch" "edit" '{"patch":"..."}'  "Codex apply_patch"
_assert_tool "fs_read"     "read" '{"path":"a.ts"}'  "Codex fs_read"
_assert_bash "codex" "shell"        "git diff"       "git" "Codex shell 'git diff'"
_assert_bash "codex" "execute_bash" "npm test"       "test" "Codex execute_bash 'npm test'"

# --- (e) NEGATIVES: unclassifiable -> honest absence -------------------------
echo ""
echo "--- (e) negatives: unclassifiable shells + delegation tools -> NO action ---"
_assert_bash "claude-code" "Bash" "ls -la"    "" "ls -la"
_assert_bash "claude-code" "Bash" "cat foo"   "" "cat foo"
_assert_bash "claude-code" "Bash" "echo hi"   "" "echo hi"
_assert_bash "claude-code" "Bash" "npm"       "" "bare npm"
_assert_tool "Task"        "" '{"subagent_type":"code-reviewer"}' "Task delegation"
_assert_tool "use_subagent" "" '{"agent_name":"planner"}'         "use_subagent delegation"
_assert_tool "spawn_agent"  "" '{"agent_type":"worker"}'          "spawn_agent delegation"
_assert_tool "SomeUnknownTool" "" '{"x":1}'                       "unknown tool"

# --- (f) verb FALSE-POSITIVE guard -------------------------------------------
echo ""
echo "--- (f) verb false-positive guard (whole-token match, env-prefix strip) ---"
_assert_bash "claude-code" "Bash" "gitfoo status"        "" "gitfoo status (substring, not git)"
_assert_bash "claude-code" "Bash" "/usr/bin/git-helper x" "" "/usr/bin/git-helper (path, not git)"
_assert_bash "claude-code" "Bash" "echo git"            "" "echo git (git is an arg, not the verb)"
_assert_bash "claude-code" "Bash" "makefoo"             "" "makefoo (substring, not make)"
# env-prefix stripped: X=1 make -> the leading real token is make -> build.
_assert_bash "claude-code" "Bash" "X=1 make"            "build" "X=1 make (env-prefix stripped -> make -> build)"
# bash -lc wrapper peeled: the inner leading token classifies.
_assert_bash "claude-code" "Bash" "bash -lc 'git status'" "git" "bash -lc 'git status' (wrapper peeled)"

# --- (g) all three event branches carry .tool.action -------------------------
echo ""
echo "--- (g) .tool.action stamped on invoke / permission_request / result ---"
inv_g=$(jq -nc '{session_id:"ac-g",hook_event_name:"PreToolUse",tool_name:"Edit",tool_input:{file_path:"a.ts"}}')
out_g=$(_run_tool_event "preToolUse" "$inv_g")
[[ "$(echo "$out_g" | jq -r '.event_type')" == "tool.invoke" && "$(echo "$out_g" | jq -r '.tool.action')" == "edit" ]] \
  && _pass "tool.invoke carries .tool.action==edit" || _fail "invoke branch missing action ($(echo "$out_g" | jq -c '.tool'))"
perm_g=$(jq -nc '{session_id:"ac-g2",hook_event_name:"PermissionRequest",tool_name:"Bash",tool_input:{command:"git status",description:"run git"}}')
out_g2=$(_run_tool_event "permissionRequest" "$perm_g")
[[ "$(echo "$out_g2" | jq -r '.event_type')" == "tool.permission_request" && "$(echo "$out_g2" | jq -r '.tool.action')" == "git" ]] \
  && _pass "tool.permission_request carries .tool.action==git" || _fail "permission_request branch missing action ($(echo "$out_g2" | jq -c '.tool'))"
res_g=$(jq -nc '{session_id:"ac-g3",hook_event_name:"PostToolUse",tool_name:"Bash",tool_input:{command:"npm run build"},tool_response:{output:"ok"}}')
out_g3=$(_run_tool_event "postToolUse" "$res_g")
[[ "$(echo "$out_g3" | jq -r '.event_type')" == "tool.result" && "$(echo "$out_g3" | jq -r '.tool.action')" == "build" ]] \
  && _pass "tool.result carries .tool.action==build" || _fail "result branch missing action ($(echo "$out_g3" | jq -c '.tool'))"

# --- (h) PRESENCE HONESTY: unclassifiable never emits the key ----------------
echo ""
echo "--- (h) presence honesty: unclassifiable -> .tool has NO action key ---"
inv_h=$(jq -nc '{session_id:"ac-h",hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:"ls -la"}}')
out_h=$(_run_tool_event "preToolUse" "$inv_h")
has_h=$(echo "$out_h" | jq -r '.tool | has("action")')
[[ "$has_h" == "false" ]] && _pass "'ls -la' -> .tool has no 'action' key (not action:null, not action:\"\")" || _fail "unclassifiable produced an action key ($(echo "$out_h" | jq -c '.tool'))"
# The rest of the tool object is still intact when action is absent.
[[ "$(echo "$out_h" | jq -r '.tool.name')" == "Bash" ]] && _pass "tool.name still present when action absent" || _fail "tool object degraded when action absent"

# --- (i) no-block: malformed/absent tool_input still emits cleanly -----------
echo ""
echo "--- (i) no-block: absent/malformed tool_input emits the event, no action ---"
inv_i=$(jq -nc '{session_id:"ac-i",hook_event_name:"PreToolUse",tool_name:"Bash"}')
out_i=$(_run_tool_event "preToolUse" "$inv_i")
[[ "$(echo "$out_i" | jq -r '.event_type // empty')" == "tool.invoke" ]] && _pass "absent tool_input still emits tool.invoke (never blackholed)" || _fail "event dropped on absent tool_input"
[[ "$(echo "$out_i" | jq -r '.tool | has("action")')" == "false" ]] && _pass "absent tool_input -> no .tool.action" || _fail "absent tool_input produced an action"

# --- (j) PRIVACY: the raw command string is NOT added by this change ---------
echo ""
echo "--- (j) privacy: .tool.action is a bounded enum; no new raw-command field ---"
SECRET="SENSITIVE_TOKEN_sk_ant_9f3a"
inv_j=$(jq -nc --arg s "$SECRET" '{session_id:"ac-j",hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:("git commit -m \"deploy "+$s+"\"")}}')
out_j=$(_run_tool_event "preToolUse" "$inv_j")
action_j=$(echo "$out_j" | jq -r '.tool.action')
[[ "$action_j" == "git" ]] && _pass "sensitive git command still classifies (action==git)" || _fail "expected git, got '$action_j'"
# .tool.action is exactly the enum — never the raw command.
if echo "$action_j" | grep -q "$SECRET"; then
  _fail "PRIVACY LEAK: .tool.action contains the raw command args"
else
  _pass ".tool.action carries only the enum 'git', not the raw command args"
fi
# The ONLY place the command text appears is the pre-existing .tool.input (this
# change added no new raw-command field). Assert the secret appears solely there.
occurrences=$(echo "$out_j" | jq -c '.tool | del(.input)' | grep -c "$SECRET" || true)
[[ "$occurrences" == "0" ]] && _pass "no NEW field outside the pre-existing .tool.input carries the raw command (this change added only the enum)" || _fail "this change leaked the raw command into a new field"

rm -rf "$TMPDIR_EVAL"

echo ""
echo "Telemetry action-class ontology: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
