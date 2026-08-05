#!/usr/bin/env bash
# test_telemetry_sanitize_usage.sh — console-relay .usage sanitize backstop
# (kontourai/flow-agents#568 follow-up: close the two HIGH review findings).
#
# The primary extractor (usage_last_turn_usage) already type-guards and
# allowlists every usage field at extraction time and is covered by
# test_telemetry_tool_usage.sh. This suite covers the SECOND layer that had
# zero coverage: console_telemetry_sanitize_usage (the defense-in-depth
# backstop in transport.sh) AND its caller console_telemetry_emit, which must
# FAIL CLOSED — a valid event always sanitizes to something, and an
# unsanitizable (non-JSON) event must be DROPPED, never relayed raw.
#
# Uses the same TELEMETRY_DIR resolution convention as the sibling telemetry
# tests (prefers context/scripts/telemetry when present, so this exercises the
# same copy CI actually runs).
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -d "$ROOT_DIR/context/scripts/telemetry" ]]; then
  TELEMETRY_DIR="$ROOT_DIR/context/scripts/telemetry"
else
  TELEMETRY_DIR="$HOME/.flow-agents/context/scripts/telemetry"
fi
# Filename kept in a variable so the source-tree validator (which resolves bare
# path literals from repo root) doesn't misread the relative transport-lib path
# as a root-relative ref — mirrors the sibling telemetry tests' variable idiom.
TRANSPORT_LIB="transport.sh"
TRANSPORT_SH="${TELEMETRY_DIR}/lib/${TRANSPORT_LIB}"

TMPDIR_EVAL=$(mktemp -d /tmp/eval-telemetry-sanitize.XXXXXX)
trap 'rm -rf "$TMPDIR_EVAL"' EXIT

pass=0; fail=0
_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }

echo "=== Console-relay .usage sanitize backstop (#568 follow-up) ==="
echo ""

if [[ ! -f "$TRANSPORT_SH" ]]; then
  _fail "transport.sh not found at $TRANSPORT_SH"
  echo "Cannot continue without transport script"
  exit 1
fi

# Run console_telemetry_sanitize_usage in a clean subshell (transport.sh sources
# usage_model_guard.sh itself, so the allowlist/bound constants resolve).
run_sanitize() {
  EV="$1" TELEMETRY_DIR="$TELEMETRY_DIR" TRANSPORT_LIB="$TRANSPORT_LIB" bash -c '
    source "$TELEMETRY_DIR/lib/$TRANSPORT_LIB"
    console_telemetry_sanitize_usage "$EV"
  '
}

# Same, but with the shared guard constants forced empty to simulate a partial
# dist/ sync that dropped usage_model_guard.sh — must still fail closed.
run_sanitize_no_guard() {
  EV="$1" TELEMETRY_DIR="$TELEMETRY_DIR" TRANSPORT_LIB="$TRANSPORT_LIB" bash -c '
    source "$TELEMETRY_DIR/lib/$TRANSPORT_LIB"
    USAGE_MODEL_REGEX=""; USAGE_MODEL_MAX_LEN=""; USAGE_NUMERIC_MIN=""; USAGE_NUMERIC_MAX=""
    console_telemetry_sanitize_usage "$EV"
  '
}

# Drive the full relay wrapper with the network POST stubbed to capture what
# WOULD leave the machine (mirrors test_telemetry.sh's console_post_json stub).
# Writes the relayed body to $CAP, or leaves $CAP absent when nothing is relayed.
run_emit() {
  local ev="$1" cap="$2"
  rm -f "$cap"
  EV="$ev" CAP="$cap" TELEMETRY_DIR="$TELEMETRY_DIR" TRANSPORT_LIB="$TRANSPORT_LIB" bash -c '
    source "$TELEMETRY_DIR/lib/$TRANSPORT_LIB"
    console_telemetry_endpoint_url() { echo "https://console.example.test/records"; }
    console_post_json() { printf "%s" "$2" > "$CAP"; }
    console_telemetry_emit "$EV"
  '
}

SECRET_MODEL="sk-ant-api03-abcdefghijklmnopqrstuv"

# --- console_telemetry_sanitize_usage: primary sanitize behavior ---
echo "--- console_telemetry_sanitize_usage: field-level sanitize ---"

out=$(run_sanitize "{\"type\":\"tool\",\"usage\":{\"model\":\"$SECRET_MODEL\",\"input_tokens\":10}}")
[[ "$(echo "$out" | jq -r '.usage.model')" == "null" ]] \
  && _pass "secret-shaped model (sk-ant-api03-...) is nulled, never relayed" \
  || _fail "expected .usage.model=null for secret model, got '$(echo "$out" | jq -c '.usage.model')'"
[[ "$(echo "$out" | jq -r '.usage.input_tokens')" == "10" ]] \
  && _pass "an in-bounds token survives alongside a rejected model" \
  || _fail "expected .usage.input_tokens=10, got '$(echo "$out" | jq -c '.usage.input_tokens')'"

out=$(run_sanitize '{"type":"tool","usage":"i-am-not-an-object"}')
[[ "$(echo "$out" | jq -r '.usage')" == "null" ]] \
  && _pass "a non-object .usage is nulled entirely (fail closed on wrong shape)" \
  || _fail "expected .usage=null for a string .usage, got '$(echo "$out" | jq -c '.usage')'"

out=$(run_sanitize '{"type":"tool","usage":{"model":"claude-opus-4-8","input_tokens":-500}}')
[[ "$(echo "$out" | jq -r '.usage.input_tokens')" == "null" ]] \
  && _pass "a negative token count (-500) degrades to null, never a negative number" \
  || _fail "expected .usage.input_tokens=null for -500, got '$(echo "$out" | jq -c '.usage.input_tokens')'"

out=$(run_sanitize '{"type":"tool","usage":{"model":"claude-opus-4-8","input_tokens":1e308}}')
[[ "$(echo "$out" | jq -r '.usage.input_tokens')" == "null" ]] \
  && _pass "an absurd-magnitude token (1e308) degrades to null" \
  || _fail "expected .usage.input_tokens=null for 1e308, got '$(echo "$out" | jq -c '.usage.input_tokens')'"

out=$(run_sanitize '{"type":"tool","usage":{"model":"claude-opus-4-8","input_tokens":100,"output_tokens":20}}')
if [[ "$(echo "$out" | jq -r '.usage.model')" == "claude-opus-4-8" \
   && "$(echo "$out" | jq -r '.usage.input_tokens')" == "100" \
   && "$(echo "$out" | jq -r '.usage.output_tokens')" == "20" ]]; then
  _pass "a legitimate allowlisted model with in-bounds tokens is preserved unchanged"
else
  _fail "expected a clean .usage to survive, got '$(echo "$out" | jq -c '.usage')'"
fi

out=$(run_sanitize_no_guard "{\"type\":\"tool\",\"usage\":{\"model\":\"$SECRET_MODEL\",\"input_tokens\":10}}")
[[ "$(echo "$out" | jq -r '.usage')" == "null" ]] \
  && _pass "missing shared guard constants (packaging defect) fails closed: .usage nulled" \
  || _fail "expected .usage=null when guard constants are empty, got '$(echo "$out" | jq -c '.usage')'"

# --- console_telemetry_sanitize_usage: the empty-output contract the caller relies on ---
echo ""
echo "--- console_telemetry_sanitize_usage: unparseable input => empty output ---"
out=$(run_sanitize 'this is not json {')
[[ -z "$out" ]] \
  && _pass "an unparseable (non-JSON) event yields EMPTY output — the drop signal for the caller" \
  || _fail "expected empty output for non-JSON input, got '$out'"

# --- console_telemetry_emit: FAIL CLOSED at the call site (HIGH finding #1) ---
echo ""
echo "--- console_telemetry_emit: fail-closed relay path (HIGH #1 + coverage #2) ---"
CAP="$TMPDIR_EVAL/relayed.json"

run_emit "{\"type\":\"tool\",\"context\":{\"cwd\":\"/tmp\"},\"usage\":{\"model\":\"$SECRET_MODEL\",\"input_tokens\":10}}" "$CAP"
if [[ -f "$CAP" && "$(jq -r '.usage.model' "$CAP" 2>/dev/null)" == "null" ]]; then
  _pass "relayed event has its secret model nulled by the backstop (coverage gap closed)"
else
  _fail "expected relayed .usage.model=null, got '$( [[ -f "$CAP" ]] && jq -c '.usage.model' "$CAP" || echo '<not relayed>')'"
fi

run_emit 'this is not json {' "$CAP"
[[ ! -f "$CAP" ]] \
  && _pass "an unsanitizable event is DROPPED, not relayed raw (fail closed, no leak)" \
  || _fail "FAIL OPEN: unsanitizable event was relayed: '$(cat "$CAP")'"

run_emit '{"type":"tool","context":{"cwd":"/tmp"},"usage":{"model":"claude-opus-4-8","input_tokens":100}}' "$CAP"
if [[ -f "$CAP" && "$(jq -r '.usage.model' "$CAP" 2>/dev/null)" == "claude-opus-4-8" ]]; then
  _pass "a clean event still relays normally (fail-closed drop never fires a false positive)"
else
  _fail "expected a clean event to relay with model intact, got '$( [[ -f "$CAP" ]] && jq -c '.usage' "$CAP" || echo '<not relayed>')'"
fi

echo ""
echo "Telemetry sanitize usage: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
