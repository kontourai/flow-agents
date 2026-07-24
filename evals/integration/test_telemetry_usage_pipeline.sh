#!/usr/bin/env bash
# test_telemetry_usage_pipeline.sh — Layer 2: hermetic Stop-hook usage pipeline
#
# Proves the full telemetry.sh Stop path (add_stop_data_and_emit_usage) yields
# a session.usage event with real tokens, a concrete (non-"unknown") model,
# and a non-null estimated_cost_usd when a runtime transcript is supplied —
# and that tokens still survive (with estimated_cost_usd null) when the
# pricing registry is forced unavailable. Also guards the kiro-cli
# non-regression case: with no transcript, model still resolves via the
# existing usage_get_model() kiro lookup (unaffected by this fix).
#
# Uses the same TELEMETRY_DIR resolution convention as test_telemetry.sh
# (prefers context/scripts/telemetry when present) so this exercises the same
# copy CI actually runs, while explicitly pointing TELEMETRY_PRICING_FILE at
# the canonical bundled registry so pricing resolves regardless of which copy
# is under test (context/scripts/telemetry ships no bundled pricing.json).
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -d "$ROOT_DIR/context/scripts/telemetry" ]]; then
  TELEMETRY_DIR="$ROOT_DIR/context/scripts/telemetry"
else
  TELEMETRY_DIR="$HOME/.flow-agents/context/scripts/telemetry"
fi
TELEMETRY_SH="${TELEMETRY_DIR}/telemetry.sh"
PRICING_FILE="$ROOT_DIR/scripts/telemetry/pricing.json"
FIXTURE_TRANSCRIPT="$ROOT_DIR/evals/fixtures/telemetry/usage-transcript-sample.jsonl"

TMPDIR_EVAL=$(mktemp -d /tmp/eval-telemetry-usage-pipeline.XXXXXX)
TMPLOG="${TMPDIR_EVAL}/test-output.jsonl"
FAKE_HOME="${TMPDIR_EVAL}/home"
mkdir -p "$FAKE_HOME" "$TMPDIR_EVAL/sessions"

pass=0; fail=0
_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }

echo "=== Layer 2: Telemetry Usage Pipeline (hermetic fixture) ==="
echo ""

if [[ ! -f "$TELEMETRY_SH" ]]; then
  _fail "telemetry.sh not found at $TELEMETRY_SH"
  echo "Cannot continue without telemetry script"
  rm -rf "$TMPDIR_EVAL"
  exit 1
fi
if [[ ! -f "$FIXTURE_TRANSCRIPT" ]]; then
  _fail "fixture transcript not found at $FIXTURE_TRANSCRIPT"
  rm -rf "$TMPDIR_EVAL"
  exit 1
fi

# Wait for a new line to land in TMPLOG (telemetry.sh's Stop path emits
# asynchronously even in foreground mode's background-adjacent callers).
_wait_for_line() {
  local before_lines="$1" i=0 current_lines
  while [[ $i -lt 50 ]]; do
    current_lines=$(wc -l < "$TMPLOG" 2>/dev/null | tr -d ' ')
    [[ "${current_lines:-0}" -gt "$before_lines" ]] && break
    sleep 0.1; i=$((i + 1))
  done
}

_wait_for_file_line() {
  local file="$1" i=0 current_lines
  while [[ $i -lt 50 ]]; do
    current_lines=$(wc -l < "$file" 2>/dev/null | tr -d ' ')
    [[ "${current_lines:-0}" -gt 0 ]] && break
    sleep 0.1; i=$((i + 1))
  done
}

# Run a real Stop event against a freshly-established session (agentSpawn
# first, matching real usage — Claude Code always sends SessionStart before
# Stop). Returns the emitted session.usage event (jq-compact, one line).
_run_stop() {
  local input="$1"; shift
  local extra_env_count="$#"
  local extra_env=("$@")
  local common_env=(
    HOME="$FAKE_HOME"
    TELEMETRY_ENABLED=true
    TELEMETRY_CHANNELS=full
    TELEMETRY_CHANNEL_FULL_LOG_FILE="$TMPLOG"
    FLOW_AGENTS_TELEMETRY_FOREGROUND=true
    TELEMETRY_CONFIG_FILE="$TMPDIR_EVAL/telemetry.conf"
    TELEMETRY_DATA_DIR="$TMPDIR_EVAL"
    TELEMETRY_SESSION_DIR="$TMPDIR_EVAL/sessions"
  )

  local before_lines
  touch "$TMPLOG"
  before_lines=$(wc -l < "$TMPLOG" | tr -d ' ')
  echo '{"cwd":"/tmp"}' | env "${common_env[@]}" bash "$TELEMETRY_SH" agentSpawn dev >/dev/null 2>&1
  _wait_for_line "$before_lines"

  before_lines=$(wc -l < "$TMPLOG" | tr -d ' ')
  if [[ "$extra_env_count" -gt 0 ]]; then
    echo "$input" | env "${common_env[@]}" TELEMETRY_USAGE_TRACKING=true "${extra_env[@]}" \
      bash "$TELEMETRY_SH" Stop dev 2>/dev/null
  else
    echo "$input" | env "${common_env[@]}" TELEMETRY_USAGE_TRACKING=true \
      bash "$TELEMETRY_SH" Stop dev 2>/dev/null
  fi
  _wait_for_line "$before_lines"

  tail -n +"$((before_lines + 1))" "$TMPLOG" 2>/dev/null | jq -c 'select(.event_type=="session.usage")' | tail -1
}

# --- 1. With transcript + pricing available: real tokens, cost, concrete model
echo "--- Fixture transcript, pricing available ---"
input1=$(jq -nc --arg tp "$FIXTURE_TRANSCRIPT" '{session_id:"pipeline-1",transcript_path:$tp,hook_event_name:"Stop"}')
out1=$(_run_stop "$input1" TELEMETRY_PRICING_FILE="$PRICING_FILE")

if [[ -n "$out1" ]]; then
  model=$(echo "$out1" | jq -r '.usage.model')
  it=$(echo "$out1" | jq -r '.usage.input_tokens')
  ot=$(echo "$out1" | jq -r '.usage.output_tokens')
  cost=$(echo "$out1" | jq -r '.usage.estimated_cost_usd')
  by_model_len=$(echo "$out1" | jq -r '.usage.by_model | length')
  semantics=$(echo "$out1" | jq -r '.usage.semantics // empty')

  [[ "$model" != "unknown" && "$model" != "null" && -n "$model" ]] && _pass "model is concrete (got: $model)" || _fail "model should not be unknown (got: $model)"
  [[ "$model" == "claude-opus-4-8" ]] && _pass "model is the dominant-by-tokens model (claude-opus-4-8)" || _fail "expected dominant model claude-opus-4-8, got $model"
  [[ "$it" != "null" && "$it" -gt 0 ]] && _pass "input_tokens is real and non-null (got: $it)" || _fail "input_tokens should be non-null/positive (got: $it)"
  [[ "$ot" != "null" && "$ot" -gt 0 ]] && _pass "output_tokens is real and non-null (got: $ot)" || _fail "output_tokens should be non-null/positive (got: $ot)"
  cost_positive=$(echo "$out1" | jq -r '(.usage.estimated_cost_usd // 0) > 0')
  [[ "$semantics" == "snapshot" ]] && _pass "session usage declares cumulative snapshot semantics" || _fail "expected usage.semantics=snapshot, got $semantics"
  [[ "$cost" != "null" && "$cost_positive" == "true" ]] && _pass "estimated_cost_usd is real and non-null (got: $cost)" || _fail "estimated_cost_usd should be non-null/positive (got: $cost)"
  [[ "$by_model_len" == "2" ]] && _pass "by_model has 2 entries" || _fail "expected 2 by_model entries, got $by_model_len"
else
  _fail "no session.usage event emitted for fixture transcript"
fi

# --- 1b. Economics attribution: canonical current pointer beats stale legacy
echo ""
echo "--- Economics attribution uses canonical current pointer ---"
ATTR_CWD="${TMPDIR_EVAL}/workspace"
CANON_SLUG="canonical-task"
LEGACY_SLUG="legacy-task"
ECON_LOG="${TMPDIR_EVAL}/economics.jsonl"
mkdir -p "$ATTR_CWD/.kontourai/flow-agents/$CANON_SLUG" "$ATTR_CWD/.flow-agents/$LEGACY_SLUG"
: > "$ECON_LOG"
printf '%s\n' "{\"active_slug\":\"$CANON_SLUG\"}" > "$ATTR_CWD/.kontourai/flow-agents/current.json"
printf '%s\n' "{\"active_slug\":\"$LEGACY_SLUG\"}" > "$ATTR_CWD/.flow-agents/current.json"
printf '%s\n' '{"schema_version":"1.0","task_slug":"canonical-task","phase":"execution","verification_verdict":"PASS"}' > "$ATTR_CWD/.kontourai/flow-agents/$CANON_SLUG/state.json"
printf '%s\n' '{"schema_version":"1.0","task_slug":"legacy-task","phase":"execution","verification_verdict":"PASS"}' > "$ATTR_CWD/.flow-agents/$LEGACY_SLUG/state.json"
input_attr=$(jq -nc --arg tp "$FIXTURE_TRANSCRIPT" --arg cwd "$ATTR_CWD" '{session_id:"pipeline-attribution",transcript_path:$tp,hook_event_name:"Stop",cwd:$cwd}')
TELEMETRY_SH_SAVED="$TELEMETRY_SH"
TELEMETRY_SH="$ROOT_DIR/scripts/telemetry/telemetry.sh"
out_attr=$(_run_stop "$input_attr" TELEMETRY_PRICING_FILE="$PRICING_FILE" TELEMETRY_ECONOMICS_LOG_FILE="$ECON_LOG")
TELEMETRY_SH="$TELEMETRY_SH_SAVED"
_wait_for_file_line "$ECON_LOG"

if [[ -n "$out_attr" && -s "$ECON_LOG" ]]; then
  attr_task=$(tail -1 "$ECON_LOG" | jq -r '.task_slug')
  attr_phase=$(tail -1 "$ECON_LOG" | jq -r '.phases[0].phase')
  [[ "$attr_task" == "$CANON_SLUG" ]] && _pass "economics record task_slug comes from canonical .kontourai current pointer" || _fail "expected canonical task_slug '$CANON_SLUG', got '$attr_task'"
  [[ "$attr_phase" == "execution" ]] && _pass "economics record phase comes from canonical state.json" || _fail "expected canonical phase execution, got '$attr_phase'"
else
  _fail "economics attribution record was not emitted for canonical-current test"
fi

# --- 2. Pricing forced unavailable: tokens survive, cost is null ------------
echo ""
echo "--- Fixture transcript, pricing forced unavailable ---"
input2=$(jq -nc --arg tp "$FIXTURE_TRANSCRIPT" '{session_id:"pipeline-2",transcript_path:$tp,hook_event_name:"Stop"}')
out2=$(_run_stop "$input2" TELEMETRY_PRICING_FILE=/nonexistent/pricing.json TELEMETRY_PRICING_URL="" FLOW_AGENTS_PRICING_FILE="" FLOW_AGENTS_PRICING_URL="")

if [[ -n "$out2" ]]; then
  it2=$(echo "$out2" | jq -r '.usage.input_tokens')
  ot2=$(echo "$out2" | jq -r '.usage.output_tokens')
  cost2=$(echo "$out2" | jq -r '.usage.estimated_cost_usd')
  pv2=$(echo "$out2" | jq -r '.usage.pricing_version')
  model2=$(echo "$out2" | jq -r '.usage.model')

  [[ "$it2" != "null" && "$it2" -gt 0 ]] && _pass "tokens survive when pricing unavailable (input_tokens=$it2)" || _fail "tokens should survive when pricing unavailable (got input_tokens=$it2)"
  [[ "$ot2" != "null" && "$ot2" -gt 0 ]] && _pass "output_tokens survive when pricing unavailable (got: $ot2)" || _fail "output_tokens should survive when pricing unavailable (got: $ot2)"
  [[ "$cost2" == "null" ]] && _pass "estimated_cost_usd is null when pricing unavailable (cost degrades, tokens don't)" || _fail "estimated_cost_usd should be null when pricing unavailable (got: $cost2)"
  [[ "$pv2" == "null" ]] && _pass "pricing_version is null when pricing unavailable" || _fail "pricing_version should be null when pricing unavailable (got: $pv2)"
  [[ "$model2" == "claude-opus-4-8" ]] && _pass "model still resolves from transcript when pricing unavailable" || _fail "expected model claude-opus-4-8, got $model2"
else
  _fail "no session.usage event emitted when pricing forced unavailable"
fi

# --- 3. No transcript (kiro-cli style): model still resolves via kiro fallback, no regression
echo ""
echo "--- No transcript (kiro-cli non-regression) ---"
input3='{"session_id":"pipeline-3","hook_event_name":"Stop"}'
out3=$(_run_stop "$input3")

if [[ -n "$out3" ]]; then
  model3=$(echo "$out3" | jq -r '.usage.model')
  it3=$(echo "$out3" | jq -r '.usage.input_tokens')
  by_model3=$(echo "$out3" | jq -r '.usage.by_model')

  # FAKE_HOME has no ~/.kiro/agents spec, so usage_get_model's kiro lookup
  # falls through to "unknown" — this is the pre-existing, unfixed kiro path
  # and must be untouched by the transcript-model override (transcript_usage
  # is null here, so model is never overridden).
  [[ "$model3" == "unknown" ]] && _pass "no-transcript path still resolves via usage_get_model kiro fallback (unknown, no regression)" || _fail "expected kiro fallback 'unknown' with no transcript, got $model3"
  [[ "$it3" == "null" ]] && _pass "input_tokens is null with no transcript (expected)" || _fail "expected null input_tokens with no transcript, got $it3"
  [[ "$by_model3" == "null" ]] && _pass "by_model is null with no transcript (expected)" || _fail "expected null by_model with no transcript, got $by_model3"
else
  _fail "no session.usage event emitted for no-transcript case"
fi

# --- 4. Empty transcript + TELEMETRY_USAGE_DEBUG=1: debug reason is emitted -
echo ""
echo "--- Empty transcript, TELEMETRY_USAGE_DEBUG=1 (debug path) ---"
EMPTY_TRANSCRIPT="${TMPDIR_EVAL}/empty-transcript.jsonl"
: > "$EMPTY_TRANSCRIPT"
DEBUG_DRIFT_LOG="${TMPDIR_EVAL}/debug-drift.log"
input4=$(jq -nc --arg tp "$EMPTY_TRANSCRIPT" '{session_id:"pipeline-4",transcript_path:$tp,hook_event_name:"Stop"}')
out4=$(_run_stop "$input4" TELEMETRY_USAGE_DEBUG=1 TELEMETRY_DRIFT_LOG="$DEBUG_DRIFT_LOG")

if grep -q '\[telemetry\] usage_parse_transcript:' "$DEBUG_DRIFT_LOG" 2>/dev/null; then
  _pass "debug reason line emitted for empty-transcript no-usage scenario"
else
  _fail "expected a usage_parse_transcript debug reason line in $DEBUG_DRIFT_LOG"
fi

model4=$(echo "$out4" | jq -r '.usage.model // "unknown"' 2>/dev/null)
[[ -z "$out4" || "$model4" == "unknown" ]] && _pass "empty-transcript path emits no real usage (no regression)" || _fail "expected no/unknown usage for empty transcript, got model=$model4"

rm -rf "$TMPDIR_EVAL"

echo ""
echo "Telemetry usage pipeline: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
