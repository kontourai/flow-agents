#!/usr/bin/env bash
# test_telemetry_tool_usage.sh — Layer 2: per-tool-call usage enrichment
# (kontourai/flow-agents#568 slice 1)
#
# Proves that tool.invoke (preToolUse) and tool.result (postToolUse) telemetry
# events carry a .usage object sourced from the transcript's LAST assistant
# turn — not the session-cumulative aggregate — with the same fallback tiers
# usage_parse_transcript uses at `stop`: transcript join -> full usage;
# model-only when hook.model is present but the transcript join fails; fully
# null when neither is available. Also proves the bounded tail-read still
# finds the last usage entry behind an oversized filler prefix, and that
# permissionRequest is explicitly excluded from .usage enrichment.
#
# Uses the same TELEMETRY_DIR resolution convention as test_telemetry.sh /
# test_telemetry_usage_pipeline.sh (prefers context/scripts/telemetry when
# present, so this exercises the same copy CI actually runs), the same
# hermetic env variables, and the same FLOW_AGENTS_TELEMETRY_FOREGROUND=true
# convention so assertions don't race a backgrounded subshell.
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
OVERSIZED_TRANSCRIPT="$ROOT_DIR/evals/fixtures/telemetry/usage-transcript-oversized-prefix.jsonl"
ADVERSARIAL_TRANSCRIPT="$ROOT_DIR/evals/fixtures/telemetry/usage-transcript-adversarial.jsonl"
MALFORMED_SANDWICH_TRANSCRIPT="$ROOT_DIR/evals/fixtures/telemetry/usage-transcript-malformed-sandwich.jsonl"
TORN_TRAILING_TRANSCRIPT="$ROOT_DIR/evals/fixtures/telemetry/usage-transcript-torn-trailing.jsonl"
SECRET_MODEL_TRANSCRIPT="$ROOT_DIR/evals/fixtures/telemetry/usage-transcript-secret-model.jsonl"
SECRET_MODEL_JWT_TRANSCRIPT="$ROOT_DIR/evals/fixtures/telemetry/usage-transcript-secret-model-jwt.jsonl"
PREFIXED_SECRET_UPPER_TRANSCRIPT="$ROOT_DIR/evals/fixtures/telemetry/usage-transcript-prefixed-secret-upper.jsonl"
PREFIXED_SECRET_LOWER_TRANSCRIPT="$ROOT_DIR/evals/fixtures/telemetry/usage-transcript-prefixed-secret-lower.jsonl"
NEGATIVE_TOKENS_TRANSCRIPT="$ROOT_DIR/evals/fixtures/telemetry/usage-transcript-negative-tokens.jsonl"
OVERSIZED_TOKENS_TRANSCRIPT="$ROOT_DIR/evals/fixtures/telemetry/usage-transcript-oversized-tokens.jsonl"

TMPDIR_EVAL=$(mktemp -d /tmp/eval-telemetry-tool-usage.XXXXXX)
TMPLOG="${TMPDIR_EVAL}/test-output.jsonl"

pass=0; fail=0
_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }

echo "=== Layer 2: Telemetry Tool-Event Usage Enrichment (#568 slice 1) ==="
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
if [[ ! -f "$OVERSIZED_TRANSCRIPT" ]]; then
  _fail "oversized-prefix fixture not found at $OVERSIZED_TRANSCRIPT"
  rm -rf "$TMPDIR_EVAL"
  exit 1
fi
if [[ ! -f "$ADVERSARIAL_TRANSCRIPT" ]]; then
  _fail "adversarial fixture not found at $ADVERSARIAL_TRANSCRIPT"
  rm -rf "$TMPDIR_EVAL"
  exit 1
fi
if [[ ! -f "$MALFORMED_SANDWICH_TRANSCRIPT" ]]; then
  _fail "malformed-sandwich fixture not found at $MALFORMED_SANDWICH_TRANSCRIPT"
  rm -rf "$TMPDIR_EVAL"
  exit 1
fi
if [[ ! -f "$TORN_TRAILING_TRANSCRIPT" ]]; then
  _fail "torn-trailing fixture not found at $TORN_TRAILING_TRANSCRIPT"
  rm -rf "$TMPDIR_EVAL"
  exit 1
fi
if [[ ! -f "$SECRET_MODEL_TRANSCRIPT" ]]; then
  _fail "secret-model fixture not found at $SECRET_MODEL_TRANSCRIPT"
  rm -rf "$TMPDIR_EVAL"
  exit 1
fi
if [[ ! -f "$SECRET_MODEL_JWT_TRANSCRIPT" ]]; then
  _fail "secret-model-jwt fixture not found at $SECRET_MODEL_JWT_TRANSCRIPT"
  rm -rf "$TMPDIR_EVAL"
  exit 1
fi
if [[ ! -f "$NEGATIVE_TOKENS_TRANSCRIPT" ]]; then
  _fail "negative-tokens fixture not found at $NEGATIVE_TOKENS_TRANSCRIPT"
  rm -rf "$TMPDIR_EVAL"
  exit 1
fi
if [[ ! -f "$OVERSIZED_TOKENS_TRANSCRIPT" ]]; then
  _fail "oversized-tokens fixture not found at $OVERSIZED_TOKENS_TRANSCRIPT"
  rm -rf "$TMPDIR_EVAL"
  exit 1
fi

# Run a single hook event (preToolUse/postToolUse/permissionRequest) against
# telemetry.sh in foreground mode and return the resulting event (jq-compact,
# one line) from the full-channel log.
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

  echo "$input" | env "${common_env[@]}" "${extra_env[@]}" bash "$TELEMETRY_SH" "$hook_type" dev 2>/dev/null

  tail -n +"$((before_lines + 1))" "$TMPLOG" 2>/dev/null | tail -1
}

# --- 1. Per-turn, not aggregate: last-line model/tokens differ from the
#         session-aggregate dominant model (claude-opus-4-8) ------------------
echo "--- preToolUse/postToolUse with fixture transcript: per-turn, not aggregate (AC1) ---"
input1=$(jq -nc --arg tp "$FIXTURE_TRANSCRIPT" '{session_id:"tool-usage-1",transcript_path:$tp,hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:"echo hi"}}')
out1=$(_run_tool_event "preToolUse" "$input1" TELEMETRY_PRICING_FILE="$PRICING_FILE")

if [[ -n "$out1" ]]; then
  event_type1=$(echo "$out1" | jq -r '.event_type // empty')
  model1=$(echo "$out1" | jq -r '.usage.model // empty')
  it1=$(echo "$out1" | jq -r '.usage.input_tokens // empty')
  ot1=$(echo "$out1" | jq -r '.usage.output_tokens // empty')
  cost1=$(echo "$out1" | jq -r '.usage.estimated_cost_usd // empty')
  pv1=$(echo "$out1" | jq -r '.usage.pricing_version // empty')
  semantics1=$(echo "$out1" | jq -r '.usage.semantics // empty')

  [[ "$event_type1" == "tool.invoke" ]] && _pass "preToolUse maps to tool.invoke" || _fail "expected tool.invoke, got $event_type1"
  [[ "$model1" == "claude-fable-5" ]] && _pass "usage.model is the LAST turn's model (claude-fable-5), not the aggregate-dominant model" || _fail "expected usage.model=claude-fable-5 (last turn), got $model1"
  [[ "$it1" == "50" ]] && _pass "usage.input_tokens is the last turn's value (50)" || _fail "expected usage.input_tokens=50, got $it1"
  [[ "$ot1" == "200" ]] && _pass "usage.output_tokens is the last turn's value (200)" || _fail "expected usage.output_tokens=200, got $ot1"
  [[ -n "$cost1" && "$cost1" != "null" ]] && _pass "usage.estimated_cost_usd is non-null (got: $cost1)" || _fail "expected non-null estimated_cost_usd, got $cost1"
  [[ "$pv1" != "null" && -n "$pv1" ]] && _pass "usage.pricing_version is populated" || _fail "expected non-null pricing_version, got $pv1"
  [[ "$semantics1" == "delta" ]] && _pass "per-turn tool usage declares delta semantics" || _fail "expected usage.semantics=delta, got $semantics1"
else
  _fail "no tool.invoke event emitted for fixture transcript"
fi

echo ""
echo "--- postToolUse with fixture transcript: same per-turn usage as preToolUse ---"
input1b=$(jq -nc --arg tp "$FIXTURE_TRANSCRIPT" '{session_id:"tool-usage-1b",transcript_path:$tp,hook_event_name:"PostToolUse",tool_name:"Bash",tool_response:{output:"hi"}}')
out1b=$(_run_tool_event "postToolUse" "$input1b" TELEMETRY_PRICING_FILE="$PRICING_FILE")

if [[ -n "$out1b" ]]; then
  event_type1b=$(echo "$out1b" | jq -r '.event_type // empty')
  model1b=$(echo "$out1b" | jq -r '.usage.model // empty')
  [[ "$event_type1b" == "tool.result" ]] && _pass "postToolUse maps to tool.result" || _fail "expected tool.result, got $event_type1b"
  [[ "$model1b" == "claude-fable-5" ]] && _pass "postToolUse usage.model is also the last turn's model (claude-fable-5)" || _fail "expected usage.model=claude-fable-5, got $model1b"
else
  _fail "no tool.result event emitted for fixture transcript"
fi

# --- 2. Bounded tail-read: oversized filler prefix, still finds the last entry (AC2)
echo ""
echo "--- preToolUse with oversized-prefix transcript: bounded tail-read still finds it (AC2) ---"
input2=$(jq -nc --arg tp "$OVERSIZED_TRANSCRIPT" '{session_id:"tool-usage-2",transcript_path:$tp,hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:"echo hi"}}')
out2=$(_run_tool_event "preToolUse" "$input2" TELEMETRY_PRICING_FILE="$PRICING_FILE")

if [[ -n "$out2" ]]; then
  model2=$(echo "$out2" | jq -r '.usage.model // empty')
  it2=$(echo "$out2" | jq -r '.usage.input_tokens // empty')
  ot2=$(echo "$out2" | jq -r '.usage.output_tokens // empty')

  [[ "$model2" == "claude-oversized-prefix-model" ]] && _pass "bounded tail-read finds the last usage entry behind an oversized filler prefix" || _fail "expected model=claude-oversized-prefix-model, got $model2"
  [[ "$it2" == "777" ]] && _pass "bounded tail-read recovers correct input_tokens (777)" || _fail "expected input_tokens=777, got $it2"
  [[ "$ot2" == "333" ]] && _pass "bounded tail-read recovers correct output_tokens (333)" || _fail "expected output_tokens=333, got $ot2"
else
  _fail "no tool.invoke event emitted for oversized-prefix transcript"
fi

# --- 3. Model-only fallback: no transcript_path, but hook.model present (AC3)
echo ""
echo "--- preToolUse with no transcript_path but hook.model present: model-only fallback (AC3) ---"
input3=$(jq -nc '{session_id:"tool-usage-3",hook_event_name:"PreToolUse","model":"test-model",tool_name:"Bash",tool_input:{command:"echo hi"}}')
out3=$(_run_tool_event "preToolUse" "$input3")

if [[ -n "$out3" ]]; then
  model3=$(echo "$out3" | jq -r '.usage.model // empty')
  it3=$(echo "$out3" | jq -r '.usage.input_tokens')
  ot3=$(echo "$out3" | jq -r '.usage.output_tokens')
  cct3=$(echo "$out3" | jq -r '.usage.cache_creation_input_tokens')
  crt3=$(echo "$out3" | jq -r '.usage.cache_read_input_tokens')
  cost3=$(echo "$out3" | jq -r '.usage.estimated_cost_usd')
  pv3=$(echo "$out3" | jq -r '.usage.pricing_version')

  [[ "$model3" == "test-model" ]] && _pass "usage.model falls back to hook.model (test-model)" || _fail "expected usage.model=test-model, got $model3"
  [[ "$it3" == "null" && "$ot3" == "null" && "$cct3" == "null" && "$crt3" == "null" && "$cost3" == "null" && "$pv3" == "null" ]] && _pass "all token/cost fields are explicitly null (never guessed) in model-only fallback" || _fail "expected all token/cost fields null, got input_tokens=$it3 output_tokens=$ot3 cache_creation=$cct3 cache_read=$crt3 cost=$cost3 pricing_version=$pv3"
else
  _fail "no tool.invoke event emitted for model-only fallback case"
fi

# --- 4. Full-null degradation: neither transcript nor hook.model (AC4) -------
echo ""
echo "--- preToolUse with neither transcript_path nor hook.model: full-null degradation (AC4) ---"
input4='{"session_id":"tool-usage-4","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo hi"}}'
out4=$(_run_tool_event "preToolUse" "$input4")

if [[ -n "$out4" ]]; then
  model4=$(echo "$out4" | jq -r '.usage.model')
  it4=$(echo "$out4" | jq -r '.usage.input_tokens')
  [[ "$model4" == "null" ]] && _pass "usage.model is null when neither transcript nor hook.model is available" || _fail "expected usage.model=null, got $model4"
  [[ "$it4" == "null" ]] && _pass "usage.input_tokens is null when neither source is available" || _fail "expected usage.input_tokens=null, got $it4"
else
  _fail "no tool.invoke event emitted for full-null case (should still emit, just with null usage)"
fi

# --- 6. Adversarial line: crafted model/token strings never leak verbatim ---
echo ""
echo "--- preToolUse with adversarial transcript: sanitized, never leaks raw strings (security review) ---"
input6=$(jq -nc --arg tp "$ADVERSARIAL_TRANSCRIPT" '{session_id:"tool-usage-6",transcript_path:$tp,hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:"echo hi"}}')
out6=$(_run_tool_event "preToolUse" "$input6" TELEMETRY_PRICING_FILE="$PRICING_FILE")

if [[ -n "$out6" ]]; then
  model6=$(echo "$out6" | jq -r '.usage.model // empty')
  it6=$(echo "$out6" | jq -r '.usage.input_tokens')
  ot6=$(echo "$out6" | jq -r '.usage.output_tokens')
  cct6=$(echo "$out6" | jq -r '.usage.cache_creation_input_tokens')
  crt6=$(echo "$out6" | jq -r '.usage.cache_read_input_tokens')
  cost6=$(echo "$out6" | jq -r '.usage.estimated_cost_usd')

  [[ "$model6" == "unknown" ]] && _pass "adversarial model string degrades to 'unknown' (never the leak string)" || _fail "expected usage.model=unknown, got '$model6' (POSSIBLE LEAK)"
  [[ "$it6" == "null" ]] && _pass "adversarial (string-typed) input_tokens degrades to null, not fabricated" || _fail "expected null input_tokens, got $it6"
  [[ "$ot6" == "null" ]] && _pass "adversarial (string-typed) output_tokens degrades to null" || _fail "expected null output_tokens, got $ot6"
  [[ "$cct6" == "null" ]] && _pass "adversarial (object-typed) cache_creation_input_tokens degrades to null" || _fail "expected null cache_creation_input_tokens, got $cct6"
  [[ "$crt6" == "null" ]] && _pass "adversarial (array-typed) cache_read_input_tokens degrades to null" || _fail "expected null cache_read_input_tokens, got $crt6"
  [[ "$cost6" == "null" ]] && _pass "estimated_cost_usd degrades to null when any token field is invalid (no partial/fabricated cost)" || _fail "expected null estimated_cost_usd, got $cost6"
else
  _fail "no tool.invoke event emitted for adversarial transcript"
fi

# --- 7. Malformed lines BEFORE and AFTER the real usage line are skipped, not fatal (HIGH fix) ---
echo ""
echo "--- preToolUse with malformed-sandwich transcript: real line still found despite noise on both sides ---"
input7=$(jq -nc --arg tp "$MALFORMED_SANDWICH_TRANSCRIPT" '{session_id:"tool-usage-7",transcript_path:$tp,hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:"echo hi"}}')
out7=$(_run_tool_event "preToolUse" "$input7" TELEMETRY_PRICING_FILE="$PRICING_FILE")

if [[ -n "$out7" ]]; then
  model7=$(echo "$out7" | jq -r '.usage.model // empty')
  it7=$(echo "$out7" | jq -r '.usage.input_tokens // empty')
  ot7=$(echo "$out7" | jq -r '.usage.output_tokens // empty')

  [[ "$model7" == "claude-malformed-sandwich-safe" ]] && _pass "malformed lines before/after the real line do not abort the parse; real model recovered" || _fail "expected model=claude-malformed-sandwich-safe, got $model7"
  [[ "$it7" == "10" ]] && _pass "real input_tokens recovered despite surrounding malformed noise (10)" || _fail "expected input_tokens=10, got $it7"
  [[ "$ot7" == "20" ]] && _pass "real output_tokens recovered despite surrounding malformed noise (20)" || _fail "expected output_tokens=20, got $ot7"
else
  _fail "no tool.invoke event emitted for malformed-sandwich transcript (a single bad line should never abort the whole parse)"
fi

# --- 8. Torn trailing line (concurrent-append style) after a valid line: prior valid line found ---
echo ""
echo "--- preToolUse with torn-trailing transcript: prior valid line found, torn line skipped ---"
input8=$(jq -nc --arg tp "$TORN_TRAILING_TRANSCRIPT" '{session_id:"tool-usage-8",transcript_path:$tp,hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:"echo hi"}}')
out8=$(_run_tool_event "preToolUse" "$input8" TELEMETRY_PRICING_FILE="$PRICING_FILE")

if [[ -n "$out8" ]]; then
  model8=$(echo "$out8" | jq -r '.usage.model // empty')
  it8=$(echo "$out8" | jq -r '.usage.input_tokens // empty')

  [[ "$model8" == "claude-torn-trailing-safe" ]] && _pass "torn trailing line (no closing brace) is skipped; prior valid line's model found" || _fail "expected model=claude-torn-trailing-safe, got $model8"
  [[ "$it8" == "15" ]] && _pass "torn trailing line does not leak its own tokens (999) -- prior valid line's tokens found (15)" || _fail "expected input_tokens=15, got $it8"
else
  _fail "no tool.invoke event emitted for torn-trailing transcript"
fi

# --- 9. Secret-shaped model (sk-ant-...) never leaks; valid tokens still resolve (HIGH fix) ---
echo ""
echo "--- preToolUse with sk-ant-api03-... as model: sanitized to 'unknown', tokens still resolve ---"
input9=$(jq -nc --arg tp "$SECRET_MODEL_TRANSCRIPT" '{session_id:"tool-usage-9",transcript_path:$tp,hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:"echo hi"}}')
out9=$(_run_tool_event "preToolUse" "$input9" TELEMETRY_PRICING_FILE="$PRICING_FILE")

if [[ -n "$out9" ]]; then
  model9=$(echo "$out9" | jq -r '.usage.model // empty')
  it9=$(echo "$out9" | jq -r '.usage.input_tokens // empty')
  ot9=$(echo "$out9" | jq -r '.usage.output_tokens // empty')

  [[ "$model9" == "unknown" ]] && _pass "sk-ant-api03-... model string is NEVER relayed; degrades to 'unknown'" || _fail "SECRET LEAK: expected usage.model=unknown, got '$model9'"
  [[ "$it9" == "42" ]] && _pass "valid numeric input_tokens still resolves despite invalid model (42)" || _fail "expected input_tokens=42, got $it9"
  [[ "$ot9" == "17" ]] && _pass "valid numeric output_tokens still resolves despite invalid model (17)" || _fail "expected output_tokens=17, got $ot9"
else
  _fail "no tool.invoke event emitted for secret-model transcript"
fi

# --- 10. Secret-shaped model (JWT eyJ...) never leaks --------------------------
echo ""
echo "--- preToolUse with a JWT (eyJ...) as model: sanitized to 'unknown' ---"
input10=$(jq -nc --arg tp "$SECRET_MODEL_JWT_TRANSCRIPT" '{session_id:"tool-usage-10",transcript_path:$tp,hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:"echo hi"}}')
out10=$(_run_tool_event "preToolUse" "$input10" TELEMETRY_PRICING_FILE="$PRICING_FILE")

if [[ -n "$out10" ]]; then
  model10=$(echo "$out10" | jq -r '.usage.model // empty')
  it10=$(echo "$out10" | jq -r '.usage.input_tokens // empty')

  [[ "$model10" == "unknown" ]] && _pass "JWT (eyJ...) model string, with an embedded email, is NEVER relayed; degrades to 'unknown'" || _fail "SECRET/PII LEAK: expected usage.model=unknown, got '$model10'"
  [[ "$it10" == "30" ]] && _pass "valid numeric input_tokens still resolves despite invalid model (30)" || _fail "expected input_tokens=30, got $it10"
else
  _fail "no tool.invoke event emitted for JWT secret-model transcript"
fi

# --- 10c. Vendor-PREFIXED secret (uppercase suffix) never leaks (r4: suffix gap) ---
echo ""
echo "--- preToolUse with 'claude-AKIA...' (vendor-prefixed secret, uppercase): sanitized to 'unknown' ---"
input10c=$(jq -nc --arg tp "$PREFIXED_SECRET_UPPER_TRANSCRIPT" '{session_id:"tool-usage-10c",transcript_path:$tp,hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:"echo hi"}}')
out10c=$(_run_tool_event "preToolUse" "$input10c" TELEMETRY_PRICING_FILE="$PRICING_FILE")
if [[ -n "$out10c" ]]; then
  model10c=$(echo "$out10c" | jq -r '.usage.model // empty')
  it10c=$(echo "$out10c" | jq -r '.usage.input_tokens // empty')
  [[ "$model10c" == "unknown" ]] && _pass "vendor-prefixed uppercase secret (claude-AKIA...) is NEVER relayed; degrades to 'unknown'" || _fail "SECRET LEAK: expected usage.model=unknown, got '$model10c'"
  [[ "$it10c" == "11" ]] && _pass "valid input_tokens still resolves despite prefixed-secret model (11)" || _fail "expected input_tokens=11, got $it10c"
else
  _fail "no tool.invoke event emitted for prefixed-secret-upper transcript"
fi

# --- 10d. Vendor-PREFIXED secret (long lowercase suffix > 16 chars) never leaks ---
echo ""
echo "--- preToolUse with 'claude-<27-char lowercase>' (prefixed, long token): sanitized to 'unknown' ---"
input10d=$(jq -nc --arg tp "$PREFIXED_SECRET_LOWER_TRANSCRIPT" '{session_id:"tool-usage-10d",transcript_path:$tp,hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:"echo hi"}}')
out10d=$(_run_tool_event "preToolUse" "$input10d" TELEMETRY_PRICING_FILE="$PRICING_FILE")
if [[ -n "$out10d" ]]; then
  model10d=$(echo "$out10d" | jq -r '.usage.model // empty')
  it10d=$(echo "$out10d" | jq -r '.usage.input_tokens // empty')
  [[ "$model10d" == "unknown" ]] && _pass "vendor-prefixed long-lowercase secret is NEVER relayed; degrades to 'unknown' (>16-char token cap)" || _fail "SECRET LEAK: expected usage.model=unknown, got '$model10d'"
  [[ "$it10d" == "13" ]] && _pass "valid input_tokens still resolves despite prefixed-secret model (13)" || _fail "expected input_tokens=13, got $it10d"
else
  _fail "no tool.invoke event emitted for prefixed-secret-lower transcript"
fi

# --- 11. Negative token value degrades to null (LOW fix: sign/magnitude bound) ---
echo ""
echo "--- preToolUse with a negative input_tokens value: degrades to null ---"
input11=$(jq -nc --arg tp "$NEGATIVE_TOKENS_TRANSCRIPT" '{session_id:"tool-usage-11",transcript_path:$tp,hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:"echo hi"}}')
out11=$(_run_tool_event "preToolUse" "$input11" TELEMETRY_PRICING_FILE="$PRICING_FILE")

if [[ -n "$out11" ]]; then
  it11=$(echo "$out11" | jq -r '.usage.input_tokens')
  cost11=$(echo "$out11" | jq -r '.usage.estimated_cost_usd')

  [[ "$it11" == "null" ]] && _pass "negative input_tokens (-500) degrades to null, never a negative number" || _fail "expected null input_tokens, got $it11"
  [[ "$cost11" == "null" ]] && _pass "estimated_cost_usd degrades to null when a token field is out of bounds" || _fail "expected null estimated_cost_usd, got $cost11"
else
  _fail "no tool.invoke event emitted for negative-tokens transcript"
fi

# --- 12. Oversized (1e308) token value degrades to null (LOW fix) -----------
echo ""
echo "--- preToolUse with an absurd-magnitude (1e308) input_tokens value: degrades to null ---"
input12=$(jq -nc --arg tp "$OVERSIZED_TOKENS_TRANSCRIPT" '{session_id:"tool-usage-12",transcript_path:$tp,hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:"echo hi"}}')
out12=$(_run_tool_event "preToolUse" "$input12" TELEMETRY_PRICING_FILE="$PRICING_FILE")

if [[ -n "$out12" ]]; then
  it12=$(echo "$out12" | jq -r '.usage.input_tokens')
  cost12=$(echo "$out12" | jq -r '.usage.estimated_cost_usd')

  [[ "$it12" == "null" ]] && _pass "absurd-magnitude input_tokens (1e308) degrades to null, never a fabricated huge number" || _fail "expected null input_tokens, got $it12"
  [[ "$cost12" == "null" ]] && _pass "estimated_cost_usd degrades to null when a token field is out of bounds (oversized case)" || _fail "expected null estimated_cost_usd, got $cost12"
else
  _fail "no tool.invoke event emitted for oversized-tokens transcript"
fi

# --- 5. permissionRequest exclusion: no .usage key at all (AC7) --------------
echo ""
echo "--- permissionRequest with transcript_path present: no .usage enrichment (AC7) ---"
input5=$(jq -nc --arg tp "$FIXTURE_TRANSCRIPT" '{session_id:"tool-usage-5",transcript_path:$tp,hook_event_name:"PermissionRequest",tool_name:"Bash",tool_input:{command:"echo hi", description:"run a command"}}')
out5=$(_run_tool_event "permissionRequest" "$input5" TELEMETRY_PRICING_FILE="$PRICING_FILE")

if [[ -n "$out5" ]]; then
  event_type5=$(echo "$out5" | jq -r '.event_type // empty')
  has_usage5=$(echo "$out5" | jq -r 'has("usage")')
  [[ "$event_type5" == "tool.permission_request" ]] && _pass "permissionRequest maps to tool.permission_request" || _fail "expected tool.permission_request, got $event_type5"
  [[ "$has_usage5" == "false" ]] && _pass "permissionRequest event carries no .usage key (explicit scope boundary preserved)" || _fail "expected permissionRequest to have no .usage key, but has(\"usage\")=$has_usage5"
else
  _fail "no tool.permission_request event emitted"
fi

rm -rf "$TMPDIR_EVAL"

echo ""
echo "Telemetry tool-event usage: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
