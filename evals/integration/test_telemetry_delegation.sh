#!/usr/bin/env bash
# test_telemetry_delegation.sh — Layer 2: per-tool-event delegation enrichment
# (kontourai/flow-agents#581, split from #568)
#
# Proves that a tool event whose invoked tool DELEGATES carries a .delegation
# object on the record (sibling to .tool):
#   - .delegation.targets[] — the delegation target identities (mirrors the
#     existing agent.delegate event shape).
#   - .delegation.target — the primary (first) target; the Console
#     delegationTarget maps from this.
# Covered vocabulary:
#   - Subagent tools: Task/Agent, InvokeSubagents, spawn_agent,
#     use_subagent/subagent/"delegate to a specialist agent".
#   - Direct-CLI Codex: a Bash/execute_bash tool whose command's leading shell
#     token is exactly `codex` -> .delegation.target == "codex".
# The field is present ONLY when the tool actually delegates (never fabricated).
#
# The HIGHEST-value assertion is the PARITY TEETH: the separate agent.delegate
# event's targets, now sourced from the shared resolve_delegation_targets helper,
# must be byte-identical to the values the pre-refactor inline code produced for
# every existing vocabulary case — so factoring the vocabulary into one helper
# can never silently drift the agent.delegate stream.
#
# Uses the same TELEMETRY_DIR resolution and FLOW_AGENTS_TELEMETRY_FOREGROUND
# convention as test_telemetry_tool_outcome.sh so assertions never race a
# backgrounded subshell.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -d "$ROOT_DIR/context/scripts/telemetry" ]]; then
  TELEMETRY_DIR="$ROOT_DIR/context/scripts/telemetry"
else
  TELEMETRY_DIR="$HOME/.flow-agents/context/scripts/telemetry"
fi
TELEMETRY_SH="${TELEMETRY_DIR}/telemetry.sh"

TMPDIR_EVAL=$(mktemp -d /tmp/eval-telemetry-delegation.XXXXXX)
TMPLOG="${TMPDIR_EVAL}/test-output.jsonl"

pass=0; fail=0
_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }

echo "=== Layer 2: Telemetry Delegation Enrichment (#581: .delegation.target/targets) ==="
echo ""

if [[ ! -f "$TELEMETRY_SH" ]]; then
  _fail "telemetry.sh not found at $TELEMETRY_SH"
  rm -rf "$TMPDIR_EVAL"; exit 1
fi

# Run one hook event against telemetry.sh (foreground) and append all resulting
# events to $TMPLOG. Returns the LAST full-channel log line (the primary event;
# a separate agent.delegate line, when emitted, precedes it in the log).
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

# Emit an event and return the FIRST event of a given event_type from the lines
# this run appended (used to grab the agent.delegate event, which precedes the
# primary tool.invoke line).
_run_and_grab() {
  local want_type="$1" hook_type="$2" input="$3"; shift 3
  local before_lines
  touch "$TMPLOG"
  before_lines=$(wc -l < "$TMPLOG" | tr -d ' ')
  _run_tool_event "$hook_type" "$input" "$@" >/dev/null
  tail -n +"$((before_lines + 1))" "$TMPLOG" 2>/dev/null \
    | jq -c --arg t "$want_type" 'select(.event_type==$t)' 2>/dev/null | head -1
}

# --- (a) Task -> .delegation.target / targets on tool.invoke -----------------
echo "--- (a) Task invoke -> .delegation.target == subagent_type, .delegation.targets ---"
inv_a=$(jq -nc '{session_id:"del-a",hook_event_name:"PreToolUse",tool_name:"Task",tool_input:{subagent_type:"code-reviewer"}}')
out_a=$(_run_tool_event "preToolUse" "$inv_a")
et_a=$(echo "$out_a" | jq -r '.event_type')
tgt_a=$(echo "$out_a" | jq -r '.delegation.target')
tgts_a=$(echo "$out_a" | jq -c '.delegation.targets')
[[ "$et_a" == "tool.invoke" ]] && _pass "preToolUse -> tool.invoke" || _fail "expected tool.invoke, got '$et_a'"
[[ "$tgt_a" == "code-reviewer" ]] && _pass ".delegation.target == 'code-reviewer'" || _fail "expected target=code-reviewer, got '$tgt_a'"
[[ "$tgts_a" == '["code-reviewer"]' ]] && _pass ".delegation.targets == [\"code-reviewer\"]" || _fail "expected targets=[\"code-reviewer\"], got '$tgts_a'"

# --- (a2) Task result (postToolUse) also carries .delegation ------------------
echo ""
echo "--- (a2) Task result (postToolUse) also carries .delegation ---"
res_a2=$(jq -nc '{session_id:"del-a2",hook_event_name:"PostToolUse",tool_name:"Task",tool_input:{subagent_type:"code-reviewer"},tool_response:{output:"done"}}')
out_a2=$(_run_tool_event "postToolUse" "$res_a2")
et_a2=$(echo "$out_a2" | jq -r '.event_type')
tgt_a2=$(echo "$out_a2" | jq -r '.delegation.target')
[[ "$et_a2" == "tool.result" && "$tgt_a2" == "code-reviewer" ]] && _pass "tool.result carries .delegation.target==code-reviewer (invoke AND result)" || _fail "expected tool.result target=code-reviewer, got et=$et_a2 target=$tgt_a2"

# --- (b) use_subagent multi-target array -------------------------------------
echo ""
echo "--- (b) use_subagent -> multi-target .delegation.targets array ---"
inv_b=$(jq -nc '{session_id:"del-b",hook_event_name:"PreToolUse",tool_name:"use_subagent",tool_input:{subagents:[{agent_name:"planner"},{agent:"builder"}]}}')
out_b=$(_run_tool_event "preToolUse" "$inv_b")
tgts_b=$(echo "$out_b" | jq -c '.delegation.targets')
tgt_b=$(echo "$out_b" | jq -r '.delegation.target')
[[ "$tgts_b" == '["planner","builder"]' ]] && _pass ".delegation.targets == [\"planner\",\"builder\"] (multi-target)" || _fail "expected [\"planner\",\"builder\"], got '$tgts_b'"
[[ "$tgt_b" == "planner" ]] && _pass ".delegation.target is the primary (first) target 'planner'" || _fail "expected target=planner, got '$tgt_b'"

# --- (c) spawn_agent ---------------------------------------------------------
echo ""
echo "--- (c) spawn_agent -> .delegation.target == agent_type ---"
inv_c=$(jq -nc '{session_id:"del-c",hook_event_name:"PreToolUse",tool_name:"spawn_agent",tool_input:{agent_type:"worker"}}')
out_c=$(_run_tool_event "preToolUse" "$inv_c")
tgt_c=$(echo "$out_c" | jq -r '.delegation.target')
[[ "$tgt_c" == "worker" ]] && _pass ".delegation.target == 'worker'" || _fail "expected target=worker, got '$tgt_c'"

# --- (d) InvokeSubagents -----------------------------------------------------
echo ""
echo "--- (d) InvokeSubagents -> .delegation.targets from .targets ---"
inv_d=$(jq -nc '{session_id:"del-d",hook_event_name:"PreToolUse",tool_name:"InvokeSubagents",tool_input:{targets:["alpha","beta"]}}')
out_d=$(_run_tool_event "preToolUse" "$inv_d")
tgts_d=$(echo "$out_d" | jq -c '.delegation.targets')
tgt_d=$(echo "$out_d" | jq -r '.delegation.target')
[[ "$tgts_d" == '["alpha","beta"]' ]] && _pass ".delegation.targets == [\"alpha\",\"beta\"]" || _fail "expected [\"alpha\",\"beta\"], got '$tgts_d'"
[[ "$tgt_d" == "alpha" ]] && _pass ".delegation.target == 'alpha' (first)" || _fail "expected target=alpha, got '$tgt_d'"

# --- (e) Direct-CLI Codex: `codex exec ...` -> "codex" -----------------------
echo ""
echo "--- (e) Codex Bash 'codex exec ...' -> .delegation.target == 'codex' ---"
inv_e=$(jq -nc '{session_id:"del-e",hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:"codex exec --cd /repo \"do the thing\""}}')
out_e=$(_run_tool_event "preToolUse" "$inv_e")
tgt_e=$(echo "$out_e" | jq -r '.delegation.target')
tgts_e=$(echo "$out_e" | jq -c '.delegation.targets')
[[ "$tgt_e" == "codex" ]] && _pass ".delegation.target == 'codex' for a leading-token codex command" || _fail "expected target=codex, got '$tgt_e'"
[[ "$tgts_e" == '["codex"]' ]] && _pass ".delegation.targets == [\"codex\"]" || _fail "expected [\"codex\"], got '$tgts_e'"
# env-prefix + bash -lc wrapper still resolves the leading codex token
inv_e2=$(jq -nc '{session_id:"del-e2",hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:"FOO=bar codex resume abc"}}')
out_e2=$(_run_tool_event "preToolUse" "$inv_e2")
tgt_e2=$(echo "$out_e2" | jq -r '.delegation.target')
[[ "$tgt_e2" == "codex" ]] && _pass "leading VAR=val env-assignment is stripped before matching (FOO=bar codex ... -> codex)" || _fail "expected target=codex through env prefix, got '$tgt_e2'"
inv_e3=$(jq -nc '{session_id:"del-e3",hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:"bash -lc '"'"'codex exec run'"'"'"}}')
out_e3=$(_run_tool_event "preToolUse" "$inv_e3")
tgt_e3=$(echo "$out_e3" | jq -r '.delegation.target')
[[ "$tgt_e3" == "codex" ]] && _pass "a bash -lc '...' wrapper is peeled before matching (bash -lc 'codex ...' -> codex)" || _fail "expected target=codex through bash -lc wrapper, got '$tgt_e3'"

# --- (f) Codex false-positive guard ------------------------------------------
echo ""
echo "--- (f) Codex false-positive guard: substring/path 'codex' MUST NOT match ---"
for pair in \
  "codexfoo run|codexfoo (substring)" \
  "/usr/bin/codex-wrapper go|/usr/bin/codex-wrapper (path)" \
  "mycodex build|mycodex (prefix)" \
  "./codex-helper x|./codex-helper (relative path)"; do
  cmd="${pair%%|*}"; label="${pair#*|}"
  inv_f=$(jq -nc --arg c "$cmd" '{session_id:"del-f",hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:$c}}')
  out_f=$(_run_tool_event "preToolUse" "$inv_f")
  has_f=$(echo "$out_f" | jq -r 'has("delegation")')
  [[ "$has_f" == "false" ]] && _pass "no .delegation for $label" || _fail "$label unexpectedly produced .delegation"
done

# --- (g) Non-delegation Bash -------------------------------------------------
echo ""
echo "--- (g) non-delegation Bash ('npm test') carries no .delegation ---"
inv_g=$(jq -nc '{session_id:"del-g",hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:"npm test"}}')
out_g=$(_run_tool_event "preToolUse" "$inv_g")
has_g=$(echo "$out_g" | jq -r 'has("delegation")')
[[ "$has_g" == "false" ]] && _pass "'npm test' -> no .delegation (present ONLY when the tool delegates)" || _fail "'npm test' unexpectedly produced .delegation"
# A plain Read tool likewise never delegates.
inv_g2=$(jq -nc '{session_id:"del-g2",hook_event_name:"PreToolUse",tool_name:"Read",tool_input:{file:"a.txt"}}')
out_g2=$(_run_tool_event "preToolUse" "$inv_g2")
has_g2=$(echo "$out_g2" | jq -r 'has("delegation")')
[[ "$has_g2" == "false" ]] && _pass "Read tool -> no .delegation" || _fail "Read tool unexpectedly produced .delegation"

# --- (h) no-block: malformed/absent tool_input -------------------------------
echo ""
echo "--- (h) no-block: malformed/absent tool_input emits the event with no .delegation ---"
inv_h=$(jq -nc '{session_id:"del-h",hook_event_name:"PreToolUse",tool_name:"Task"}')
out_h=$(_run_tool_event "preToolUse" "$inv_h")
et_h=$(echo "$out_h" | jq -r '.event_type // empty')
# Task with no tool_input -> subagent_type//...//"general-purpose" fallback -> still a delegation.
tgt_h=$(echo "$out_h" | jq -r '.delegation.target // "ABSENT"')
[[ "$et_h" == "tool.invoke" ]] && _pass "event still emits cleanly with absent tool_input (never blackholed)" || _fail "expected tool.invoke, got '$et_h'"
[[ "$tgt_h" == "general-purpose" ]] && _pass "Task with no input falls back to the pre-existing 'general-purpose' default" || _fail "expected general-purpose, got '$tgt_h'"

# --- (i) PARITY TEETH: agent.delegate targets identical to pre-refactor -------
echo ""
echo "--- (i) PARITY TEETH: agent.delegate 'targets' byte-identical to pre-refactor inline values ---"
# Known pre-refactor values derived from the inline emit_delegation_event code:
#   Task{subagent_type}        -> [subagent_type]
#   Task{} (no input)          -> ["general-purpose"]
#   Agent{agent}               -> [agent]
#   spawn_agent{agent_type}    -> [agent_type]
#   spawn_agent{} (no input)   -> ["default"]
#   InvokeSubagents{targets}   -> targets (verbatim)
#   use_subagent{subagents[]}  -> map(agent_name//agent//subagent_type//name//"subagent")
#   use_subagent{agent_name}   -> [agent_name]
#   subagent{agent}            -> [agent]
#   "delegate to a specialist agent"{agent_name:""} -> ["subagent"] (else default)
parity_json=$(cat <<'JSON'
[
  {"name":"task_type","tn":"Task","ti":{"subagent_type":"code-reviewer"},"want":["code-reviewer"]},
  {"name":"task_empty","tn":"Task","ti":{},"want":["general-purpose"]},
  {"name":"agent_agent","tn":"Agent","ti":{"agent":"librarian"},"want":["librarian"]},
  {"name":"spawn_type","tn":"spawn_agent","ti":{"agent_type":"worker"},"want":["worker"]},
  {"name":"spawn_empty","tn":"spawn_agent","ti":{},"want":["default"]},
  {"name":"invoke_targets","tn":"InvokeSubagents","ti":{"targets":["alpha","beta"]},"want":["alpha","beta"]},
  {"name":"use_subagents_arr","tn":"use_subagent","ti":{"subagents":[{"agent_name":"planner"},{"agent":"builder"}]},"want":["planner","builder"]},
  {"name":"use_agent_name","tn":"use_subagent","ti":{"agent_name":"solo"},"want":["solo"]},
  {"name":"subagent_agent","tn":"subagent","ti":{"agent":"scribe"},"want":["scribe"]},
  {"name":"delegate_default","tn":"delegate to a specialist agent","ti":{"agent_name":""},"want":["subagent"]}
]
JSON
)
parity_count=$(echo "$parity_json" | jq 'length')
parity_bad=0
while IFS= read -r row; do
  pn=$(echo "$row" | jq -r '.name')
  ptn=$(echo "$row" | jq -r '.tn')
  pti=$(echo "$row" | jq -c '.ti')
  want=$(echo "$row" | jq -c '.want')
  payload=$(jq -nc --arg tn "$ptn" --argjson ti "$pti" '{session_id:("parity-"+$tn),hook_event_name:"PreToolUse",tool_name:$tn,tool_input:$ti}')
  ad=$(_run_and_grab "agent.delegate" "preToolUse" "$payload")
  got=$(echo "$ad" | jq -c '.delegation.targets')
  # The agent.delegate event must NOT carry the on-record convenience .target key
  # (that is additive to the tool event only) -> delegation has exactly {targets}.
  keys=$(echo "$ad" | jq -c '.delegation | keys')
  if [[ "$got" == "$want" && "$keys" == '["targets"]' ]]; then
    :
  else
    parity_bad=$((parity_bad+1))
    _fail "PARITY [$pn]: agent.delegate targets=$got keys=$keys (expected targets=$want keys=[\"targets\"])"
  fi
done < <(echo "$parity_json" | jq -c '.[]')
if [[ "$parity_bad" -eq 0 ]]; then
  _pass "agent.delegate targets byte-identical to pre-refactor across all $parity_count vocabulary cases (no drift); .delegation carries exactly {targets}"
else
  _fail "$parity_bad/$parity_count vocabulary cases drifted the agent.delegate stream"
fi

# --- (i2) parity: Codex Bash does NOT emit a NEW agent.delegate event --------
echo ""
echo "--- (i2) direct-CLI codex is surfaced only on-record, never as a new agent.delegate event ---"
ad_codex=$(_run_and_grab "agent.delegate" "preToolUse" "$(jq -nc '{session_id:"parity-codex",hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:"codex exec run"}}')")
[[ -z "$ad_codex" ]] && _pass "codex Bash emits NO agent.delegate event (agent.delegate stream + delegation COUNTS unchanged)" || _fail "codex Bash unexpectedly emitted an agent.delegate event: $ad_codex"

# --- (j) PRIVACY: raw command/prompt args never appear in .delegation --------
echo ""
echo "--- (j) PRIVACY: raw codex command + subagent prompt args absent from .delegation ---"
SECRET="SENSITIVE_TOKEN_sk_ant_9f3a"
inv_j=$(jq -nc --arg s "$SECRET" '{session_id:"del-j",hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:("codex exec --cd /r \"deploy with "+$s+"\"")}}')
out_j=$(_run_tool_event "preToolUse" "$inv_j")
deleg_j=$(echo "$out_j" | jq -c '.delegation')
if echo "$deleg_j" | grep -q "$SECRET"; then
  _fail "PRIVACY LEAK: .delegation contains the raw codex command args ($deleg_j)"
else
  _pass ".delegation carries only the target identity, not the raw codex command args ($deleg_j)"
fi
# subagent prompt args (Task with a sensitive prompt field) must not leak into .delegation.
PROMPT_SECRET="PROMPT_SECRET_do_not_leak_42"
inv_j2=$(jq -nc --arg s "$PROMPT_SECRET" '{session_id:"del-j2",hook_event_name:"PreToolUse",tool_name:"Task",tool_input:{subagent_type:"code-reviewer",prompt:("review "+$s),description:$s}}')
out_j2=$(_run_tool_event "preToolUse" "$inv_j2")
deleg_j2=$(echo "$out_j2" | jq -c '.delegation')
if echo "$deleg_j2" | grep -q "$PROMPT_SECRET"; then
  _fail "PRIVACY LEAK: .delegation contains the subagent prompt args ($deleg_j2)"
else
  _pass ".delegation carries only the target identity, not the subagent prompt/description args ($deleg_j2)"
fi
# Sanity: the target IS still correctly resolved in both privacy cases.
[[ "$(echo "$out_j" | jq -r '.delegation.target')" == "codex" && "$(echo "$out_j2" | jq -r '.delegation.target')" == "code-reviewer" ]] \
  && _pass "targets still resolve correctly (codex / code-reviewer) while args stay private" \
  || _fail "target resolution regressed in the privacy cases"

rm -rf "$TMPDIR_EVAL"

echo ""
echo "Telemetry delegation enrichment: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
