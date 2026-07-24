#!/usr/bin/env bash
# test_telemetry_tool_outcome.sh — Layer 2: per-tool-result enrichment
# (kontourai/flow-agents#580, split from #568)
#
# Proves that tool.result (postToolUse/PostToolUse/PostToolUseFailure) telemetry
# events carry three new fields on their .tool object:
#   - .tool.duration_ms — non-negative wall-clock ms between this tool's invoke
#     and its result (correlated per tool call), or null when the matching start
#     record is absent (never a fabricated 0 / stale value).
#   - .tool.outcome — a deterministic tri-state pass|fail|ambiguous, a jq port
#     of scripts/hooks/evidence-capture.js observeResult (never from stdout text).
#   - .tool.exit_code — the host exit code int when present, else null.
#
# The highest-value assertion is the DRIFT-GUARD (case j): a shared fixture
# battery is fed through BOTH the emitter jq path AND node observeResult, and
# their {exitCode, observedResult} verdicts must be identical — so the hermetic
# jq re-implementation can never silently diverge from the canonical source.
#
# Uses the same TELEMETRY_DIR resolution and FLOW_AGENTS_TELEMETRY_FOREGROUND
# convention as test_telemetry_tool_usage.sh so assertions never race a
# backgrounded subshell.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -d "$ROOT_DIR/context/scripts/telemetry" ]]; then
  TELEMETRY_DIR="$ROOT_DIR/context/scripts/telemetry"
else
  TELEMETRY_DIR="$HOME/.flow-agents/context/scripts/telemetry"
fi
TELEMETRY_SH="${TELEMETRY_DIR}/telemetry.sh"
SOURCE_TELEMETRY_SH="$ROOT_DIR/scripts/telemetry/telemetry.sh"
FIXTURE_TRANSCRIPT="$ROOT_DIR/evals/fixtures/telemetry/usage-transcript-sample.jsonl"
PRICING_FILE="$ROOT_DIR/scripts/telemetry/pricing.json"
EVIDENCE_CAPTURE="$ROOT_DIR/scripts/hooks/evidence-capture.js"

TMPDIR_EVAL=$(mktemp -d /tmp/eval-telemetry-tool-outcome.XXXXXX)
TMPLOG="${TMPDIR_EVAL}/test-output.jsonl"

pass=0; fail=0
_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }

echo "=== Layer 2: Telemetry Tool-Result Enrichment (#580: duration/outcome/exit_code) ==="
echo ""

if [[ ! -f "$TELEMETRY_SH" ]]; then
  _fail "telemetry.sh not found at $TELEMETRY_SH"
  rm -rf "$TMPDIR_EVAL"; exit 1
fi
if [[ ! -f "$EVIDENCE_CAPTURE" ]]; then
  _fail "evidence-capture.js not found at $EVIDENCE_CAPTURE (needed for drift guard)"
  rm -rf "$TMPDIR_EVAL"; exit 1
fi

# Run one hook event against telemetry.sh (foreground) and return the resulting
# event object (jq-compact, one line) from the full-channel log.
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

  echo "$input" | env "${common_env[@]}" ${extra_env[@]+"${extra_env[@]}"} bash "${RUN_TELEMETRY_SH:-$TELEMETRY_SH}" "$hook_type" dev 2>/dev/null

  tail -n +"$((before_lines + 1))" "$TMPLOG" 2>/dev/null | tail -1
}

# --- (a) invoke -> result: duration_ms is a non-negative number ---------------
echo "--- (a) invoke->result duration_ms is a non-negative number ---"
inv_a=$(jq -nc '{session_id:"dur-a",hook_event_name:"PreToolUse",tool_use_id:"tu-a",tool_name:"Bash",tool_input:{command:"echo hi"}}')
_run_tool_event "preToolUse" "$inv_a" >/dev/null
res_a=$(jq -nc '{session_id:"dur-a",hook_event_name:"PostToolUse",tool_use_id:"tu-a",tool_name:"Bash",tool_input:{command:"echo hi"},tool_response:{exitCode:0}}')
out_a=$(_run_tool_event "postToolUse" "$res_a")
dur_a=$(echo "$out_a" | jq -r '.tool.duration_ms')
if [[ "$dur_a" =~ ^[0-9]+$ ]]; then
  _pass "duration_ms is a non-negative integer ($dur_a) when the matching invoke was recorded"
else
  _fail "expected numeric duration_ms, got '$dur_a'"
fi

# --- (b) result with NO prior invoke -> duration_ms is exactly null -----------
echo ""
echo "--- (b) result with no prior invoke -> duration_ms:null (never 0/stale) ---"
res_b=$(jq -nc '{session_id:"dur-b",hook_event_name:"PostToolUse",tool_use_id:"tu-b-orphan",tool_name:"Bash",tool_input:{command:"echo hi"},tool_response:{exitCode:0}}')
out_b=$(_run_tool_event "postToolUse" "$res_b")
dur_b=$(echo "$out_b" | jq -r '.tool.duration_ms')
[[ "$dur_b" == "null" ]] && _pass "duration_ms is exactly null (not 0) when no invoke start record exists" || _fail "expected duration_ms=null, got '$dur_b'"

# --- (c) exit 0 -> outcome:pass exit_code:0 -------------------------------------
echo ""
echo "--- (c) host exit code 0 -> outcome:pass exit_code:0 ---"
res_c=$(jq -nc '{session_id:"oc-c",hook_event_name:"PostToolUse",tool_use_id:"tu-c",tool_name:"Bash",tool_input:{command:"echo hi"},tool_response:{exitCode:0}}')
out_c=$(_run_tool_event "postToolUse" "$res_c")
oc_c=$(echo "$out_c" | jq -r '.tool.outcome'); st_c=$(echo "$out_c" | jq -r '.tool.exit_code')
[[ "$oc_c" == "pass" ]] && _pass "outcome=pass on exit 0" || _fail "expected outcome=pass, got '$oc_c'"
[[ "$st_c" == "0" ]] && _pass "exit_code=0 on exit 0" || _fail "expected exit_code=0, got '$st_c'"

# --- (d) non-zero exit -> outcome:fail exit_code:<code> -------------------------
echo ""
echo "--- (d) non-zero host exit code -> outcome:fail exit_code:<code> ---"
res_d=$(jq -nc '{session_id:"oc-d",hook_event_name:"PostToolUse",tool_use_id:"tu-d",tool_name:"Bash",tool_input:{command:"false"},tool_response:{exitCode:2}}')
out_d=$(_run_tool_event "postToolUse" "$res_d")
oc_d=$(echo "$out_d" | jq -r '.tool.outcome'); st_d=$(echo "$out_d" | jq -r '.tool.exit_code')
[[ "$oc_d" == "fail" ]] && _pass "outcome=fail on exit 2" || _fail "expected outcome=fail, got '$oc_d'"
[[ "$st_d" == "2" ]] && _pass "exit_code=2 carries the real exit code" || _fail "expected exit_code=2, got '$st_d'"

# --- (e) failure signal, NO clean code -> outcome:fail exit_code:null -----------
echo ""
echo "--- (e) is_error:true / success:false with no exit code -> fail, exit_code:null ---"
res_e1=$(jq -nc '{session_id:"oc-e1",hook_event_name:"PostToolUse",tool_use_id:"tu-e1",tool_name:"Bash",tool_input:{command:"x"},tool_response:{is_error:true,output:"oops"}}')
out_e1=$(_run_tool_event "postToolUse" "$res_e1")
oc_e1=$(echo "$out_e1" | jq -r '.tool.outcome'); st_e1=$(echo "$out_e1" | jq -r '.tool.exit_code')
[[ "$oc_e1" == "fail" ]] && _pass "outcome=fail on is_error:true (no code)" || _fail "expected fail, got '$oc_e1'"
[[ "$st_e1" == "null" ]] && _pass "status=null when no clean exit code is present (never fabricated)" || _fail "expected exit_code=null, got '$st_e1'"
res_e2=$(jq -nc '{session_id:"oc-e2",hook_event_name:"PostToolUse",tool_use_id:"tu-e2",tool_name:"Bash",tool_input:{command:"x"},tool_response:{success:false}}')
out_e2=$(_run_tool_event "postToolUse" "$res_e2")
oc_e2=$(echo "$out_e2" | jq -r '.tool.outcome')
[[ "$oc_e2" == "fail" ]] && _pass "outcome=fail on success:false (no code)" || _fail "expected fail, got '$oc_e2'"

# --- (f) no signal at all -> outcome:ambiguous exit_code:null -------------------
echo ""
echo "--- (f) no exit code and no failure signal -> ambiguous, exit_code:null ---"
res_f=$(jq -nc '{session_id:"oc-f",hook_event_name:"PostToolUse",tool_use_id:"tu-f",tool_name:"Read",tool_input:{file:"a"},tool_response:{output:"contents"}}')
out_f=$(_run_tool_event "postToolUse" "$res_f")
oc_f=$(echo "$out_f" | jq -r '.tool.outcome'); st_f=$(echo "$out_f" | jq -r '.tool.exit_code')
[[ "$oc_f" == "ambiguous" ]] && _pass "outcome=ambiguous when there is no positive success evidence (never pass)" || _fail "expected ambiguous, got '$oc_f'"
[[ "$st_f" == "null" ]] && _pass "status=null in the no-signal case" || _fail "expected exit_code=null, got '$st_f'"

# --- (g) PostToolUseFailure event folds to fail -----------------------------
echo ""
echo "--- (g) PostToolUseFailure event folds to outcome:fail ---"
res_g=$(jq -nc '{session_id:"oc-g",hook_event_name:"PostToolUseFailure",tool_use_id:"tu-g",tool_name:"Bash",tool_input:{command:"x"},tool_response:{output:"partial"}}')
out_g=$(_run_tool_event "PostToolUseFailure" "$res_g")
et_g=$(echo "$out_g" | jq -r '.event_type'); oc_g=$(echo "$out_g" | jq -r '.tool.outcome')
[[ "$et_g" == "tool.result" ]] && _pass "PostToolUseFailure maps to tool.result" || _fail "expected tool.result, got '$et_g'"
[[ "$oc_g" == "fail" ]] && _pass "PostToolUseFailure folds to outcome=fail regardless of payload signal" || _fail "expected fail, got '$oc_g'"

# --- (g2) typed lifecycle status is independent from the raw exit code -------
echo ""
echo "--- (g2) typed tool lifecycle status survives beside exit_code ---"
status_completed=$(echo "$out_c" | jq -r '.tool.status')
status_failed=$(echo "$out_d" | jq -r '.tool.status')
out_canceled=$(_run_tool_event "postToolUse" "$(jq -nc '{tool_name:"Task",tool_response:{canceled:true}}')")
out_blocked=$(_run_tool_event "postToolUse" "$(jq -nc '{tool_name:"Task",tool_response:{denied:true}}')")
[[ "$status_completed" == "completed" ]] && _pass "exit 0 maps to typed completed" || _fail "expected completed, got '$status_completed'"
[[ "$status_failed" == "failed" ]] && _pass "non-zero exit maps to typed failed" || _fail "expected failed, got '$status_failed'"
[[ "$(echo "$out_canceled" | jq -r '.tool.status')" == "canceled" ]] && _pass "explicit host cancellation remains canceled" || _fail "explicit cancellation was lost"
[[ "$(echo "$out_blocked" | jq -r '.tool.status')" == "blocked" ]] && _pass "explicit host denial remains blocked" || _fail "explicit denial was lost"

# --- (h) invoke and permission_request carry NO duration/outcome/exit_code ------
echo ""
echo "--- (h) tool.invoke and tool.permission_request carry no result meta ---"
inv_h=$(jq -nc '{session_id:"h-inv",hook_event_name:"PreToolUse",tool_use_id:"tu-h",tool_name:"Read",tool_input:{file:"a"}}')
out_h_inv=$(_run_tool_event "preToolUse" "$inv_h")
has_dur_inv=$(echo "$out_h_inv" | jq -r '.tool | has("duration_ms")')
has_oc_inv=$(echo "$out_h_inv" | jq -r '.tool | has("outcome")')
[[ "$has_dur_inv" == "false" && "$has_oc_inv" == "false" ]] && _pass "tool.invoke has no duration_ms/outcome/exit_code (invoke has no result yet)" || _fail "tool.invoke unexpectedly carries result meta (duration=$has_dur_inv outcome=$has_oc_inv)"
perm_h=$(jq -nc '{session_id:"h-perm",hook_event_name:"PermissionRequest",tool_use_id:"tu-hp",tool_name:"Bash",tool_input:{command:"x",description:"run"}}')
out_h_perm=$(_run_tool_event "permissionRequest" "$perm_h")
has_oc_perm=$(echo "$out_h_perm" | jq -r '.tool | has("outcome")')
[[ "$has_oc_perm" == "false" ]] && _pass "tool.permission_request carries no outcome (not a tool result)" || _fail "tool.permission_request unexpectedly carries an outcome"

# --- (i) slice-1 .usage still present and correct (no regression) ------------
echo ""
echo "--- (i) slice-1 .usage enrichment still present on tool.result (no regression) ---"
res_i=$(jq -nc --arg tp "$FIXTURE_TRANSCRIPT" '{session_id:"i-usage",transcript_path:$tp,hook_event_name:"PostToolUse",tool_use_id:"tu-i",tool_name:"Bash",tool_input:{command:"echo hi"},tool_response:{exitCode:0}}')
out_i=$(_run_tool_event "postToolUse" "$res_i" TELEMETRY_PRICING_FILE="$PRICING_FILE")
model_i=$(echo "$out_i" | jq -r '.usage.model // empty'); oc_i=$(echo "$out_i" | jq -r '.tool.outcome')
[[ "$model_i" == "claude-fable-5" ]] && _pass "usage.model is still the last-turn model (claude-fable-5) alongside the new fields" || _fail "slice-1 regression: expected usage.model=claude-fable-5, got '$model_i'"
[[ "$oc_i" == "pass" ]] && _pass "new outcome field coexists with slice-1 .usage on the same record" || _fail "expected outcome=pass, got '$oc_i'"

# --- (j) DRIFT-GUARD: emitter jq outcome == node observeResult across battery -
echo ""
echo "--- (j) DRIFT-GUARD: emitter jq outcome/exit_code == node observeResult (shared battery) ---"
# Shared fixture battery: [name, tool_input_json_or_null, tool_response_json_or_null, top_level_extra_json]
# Each row is fed BOTH through the full emitter (postToolUse) and node observeResult.
battery_json=$(cat <<'JSON'
[
  {"name":"exit0","ti":{"command":"echo hi"},"tr":{"exitCode":0},"extra":{}},
  {"name":"exit2","ti":{"command":"false"},"tr":{"exitCode":2},"extra":{}},
  {"name":"str_code_0","ti":{"command":"x"},"tr":{"exit_code":"0"},"extra":{}},
  {"name":"is_error","ti":{"command":"x"},"tr":{"is_error":true},"extra":{}},
  {"name":"success_false","ti":{"command":"x"},"tr":{"success":false},"extra":{}},
  {"name":"error_top","ti":{"command":"x"},"tr":{"output":"ok"},"extra":{"error":"boom"}},
  {"name":"error_top_array","ti":{"command":"x"},"tr":{"output":"ok"},"extra":{"error":["boom"]}},
  {"name":"no_signal","ti":{"file":"a"},"tr":{"output":"contents"},"extra":{}},
  {"name":"grep_absence","ti":{"command":"grep -r foo src"},"tr":{"exitCode":1},"extra":{}},
  {"name":"grep_or_true","ti":{"command":"grep -r foo src || true"},"tr":{"exitCode":1},"extra":{}},
  {"name":"grep_negated","ti":{"command":"! grep foo x"},"tr":{"exitCode":1},"extra":{}},
  {"name":"diff_absence","ti":{"command":"diff a b"},"tr":{"exitCode":1},"extra":{}},
  {"name":"diff_err2","ti":{"command":"diff a b"},"tr":{"exitCode":2},"extra":{}},
  {"name":"bashlc_grep","ti":{"command":"bash -lc 'grep foo x'"},"tr":{"exitCode":1},"extra":{}},
  {"name":"keyval_grep","ti":{"command":"FOO=bar grep foo x"},"tr":{"exitCode":1},"extra":{}},
  {"name":"piped_grep","ti":{"command":"grep foo x | wc -l"},"tr":{"exitCode":1},"extra":{}},
  {"name":"returnCode0","ti":{"command":"x"},"tr":{"returnCode":0},"extra":{}},
  {"name":"top_status1","ti":{"command":"x"},"tr":{"output":"noise"},"extra":{"status":1}},
  {"name":"stderr_nostdout","ti":{"command":"x"},"tr":{"stderr":"boom"},"extra":{}},
  {"name":"stderr_withstdout","ti":{"command":"x"},"tr":{"stderr":"boom","stdout":"ok"},"extra":{}},
  {"name":"plain_string_out","ti":{"command":"x"},"tr":"just a string","extra":{}}
]
JSON
)
battery_count=$(echo "$battery_json" | jq 'length')
drift_ok=0; drift_bad=0
while IFS= read -r fixture; do
  bname=$(echo "$fixture" | jq -r '.name')
  # Build the hook payload (unique tool_use_id so no cross-case duration leak).
  payload=$(echo "$fixture" | jq -c '{session_id:("drift-"+.name),hook_event_name:"PostToolUse",tool_use_id:("tu-drift-"+.name),tool_name:"Bash",tool_input:.ti,tool_response:.tr} + .extra')
  # Emitter path.
  emit_out=$(_run_tool_event "postToolUse" "$payload")
  emit_oc=$(echo "$emit_out" | jq -r '.tool.outcome')
  emit_st=$(echo "$emit_out" | jq -c '.tool.exit_code')
  # Node canonical path — mirror observeResult's exact call shape at the run() site.
  node_json=$(EVCAP="$EVIDENCE_CAPTURE" PAYLOAD="$payload" node -e '
    const {observeResult}=require(process.env.EVCAP);
    const i=JSON.parse(process.env.PAYLOAD);
    const r=observeResult({tool_response:i.tool_response,tool_output:i.tool_output,error:i.error,exitCode:i.exitCode,exit_code:i.exit_code,status:i.status,code:i.code,command:(i.tool_input&&i.tool_input.command)});
    process.stdout.write(JSON.stringify({outcome:r.observedResult,status:(r.exitCode===null?null:r.exitCode)}));
  ' 2>/dev/null)
  node_oc=$(echo "$node_json" | jq -r '.outcome')
  node_st=$(echo "$node_json" | jq -c '.status')
  if [[ "$emit_oc" == "$node_oc" && "$emit_st" == "$node_st" ]]; then
    drift_ok=$((drift_ok+1))
  else
    drift_bad=$((drift_bad+1))
    _fail "DRIFT [$bname]: emitter={outcome:$emit_oc,status:$emit_st} != node={outcome:$node_oc,status:$node_st}"
  fi
done < <(echo "$battery_json" | jq -c '.[]')
if [[ "$drift_bad" -eq 0 ]]; then
  _pass "emitter jq outcome/exit_code matches node observeResult across all $battery_count battery fixtures (no drift)"
else
  _fail "$drift_bad/$battery_count battery fixtures drifted between the emitter jq and node observeResult"
fi

# --- (k) Codex-only host-banner exit-code resolution -------------------------
echo ""
echo "--- (k) codex runtime: exit code resolved from rollout banner (bounded node use) ---"
ROLLOUT="$TMPDIR_EVAL/rollout.jsonl"
jq -nc '{timestamp:"2026-07-06T00:00:00Z",type:"response_item",payload:{type:"function_call_output",call_id:"call-k",output:"Process exited with code 3\nOriginal token count: 25\nOutput:\nProcess exited with code 0\n"}}' > "$ROLLOUT"
res_k=$(jq -nc --arg rp "$ROLLOUT" '{session_id:"codex-k",transcript_path:$rp,hook_event_name:"PostToolUse",call_id:"call-k",tool_name:"Bash",tool_input:{command:"some cmd"},tool_response:{output:"no structured code here"}}')
RUN_TELEMETRY_SH="$SOURCE_TELEMETRY_SH" out_k=$(RUN_TELEMETRY_SH="$SOURCE_TELEMETRY_SH" _run_tool_event "postToolUse" "$res_k" FLOW_AGENTS_TELEMETRY_RUNTIME=codex)
st_k=$(echo "$out_k" | jq -r '.tool.exit_code'); oc_k=$(echo "$out_k" | jq -r '.tool.outcome')
[[ "$st_k" == "3" ]] && _pass "codex status resolved to 3 from the preamble host banner (forged post-Output stdout ignored)" || _fail "expected codex status=3, got '$st_k'"
[[ "$oc_k" == "fail" ]] && _pass "codex outcome=fail derived from the resolved non-zero banner code" || _fail "expected codex outcome=fail, got '$oc_k'"
# Codex, unreadable rollout -> honest ambiguous/null degrade (no fabrication).
res_k2=$(jq -nc '{session_id:"codex-k2",transcript_path:"/nonexistent/rollout.jsonl",hook_event_name:"PostToolUse",call_id:"call-x",tool_name:"Bash",tool_input:{command:"some cmd"},tool_response:{output:"no code"}}')
out_k2=$(RUN_TELEMETRY_SH="$SOURCE_TELEMETRY_SH" _run_tool_event "postToolUse" "$res_k2" FLOW_AGENTS_TELEMETRY_RUNTIME=codex)
st_k2=$(echo "$out_k2" | jq -r '.tool.exit_code'); oc_k2=$(echo "$out_k2" | jq -r '.tool.outcome')
[[ "$st_k2" == "null" && "$oc_k2" == "ambiguous" ]] && _pass "codex with an unreadable rollout degrades to ambiguous/null (never a guess)" || _fail "expected ambiguous/null, got outcome=$oc_k2 status=$st_k2"

# --- (privacy) start record stores only a timestamp, no args/output ----------
echo ""
echo "--- (privacy) tool start record holds a bare timestamp, no command/args ---"
inv_p=$(jq -nc '{session_id:"priv-p",hook_event_name:"PreToolUse",tool_use_id:"tu-priv",tool_name:"Bash",tool_input:{command:"echo SENSITIVE_SECRET_VALUE"}}')
_run_tool_event "preToolUse" "$inv_p" >/dev/null
start_file=$(ls "${TMPDIR_EVAL}/sessions/"toolstart-* 2>/dev/null | head -1)
if [[ -n "$start_file" ]]; then
  contents=$(cat "$start_file")
  if [[ "$contents" =~ ^[0-9]+$ ]]; then
    _pass "start record contains only a numeric timestamp ($contents)"
  else
    _fail "start record is not a bare timestamp: '$contents'"
  fi
  if grep -q "SENSITIVE_SECRET_VALUE" "$start_file" 2>/dev/null; then
    _fail "PRIVACY LEAK: start record contains the command args"
  else
    _pass "start record does not leak command args"
  fi
else
  _fail "no tool start record written on preToolUse"
fi

rm -rf "$TMPDIR_EVAL"

echo ""
echo "Telemetry tool-result enrichment: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
