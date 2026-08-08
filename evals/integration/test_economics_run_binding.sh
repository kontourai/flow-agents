#!/usr/bin/env bash
# test_economics_run_binding.sh — flow-agents#922/#925 phase A: economics records derived directly
# from the canonical Flow run store (.kontourai/flow/runs/<run-id>/state.json), not the
# session.usage event / Builder sidecar path evals/integration/test_economics_record.sh already
# covers.
#
# Proves:
#   AC1  scripts/telemetry/flow-run-economics.mjs walks real transitions and sums route-back
#        re-entries onto the SAME phase bucket; wall-clock matches hand-computed fixture timestamps
#        exactly.
#   AC2  iterations.route_backs / iterations.count derive from transitions[].type=="route_back".
#   AC3  defects.gate_fires / defects.verification_verdict derive honestly (NOT_VERIFIED when
#        "verify" was never reached).
#   AC4  terminal_status honesty (#925): a still-active run is NEVER reported "completed" — RED/GREEN
#        fault-injection proof that this specific assertion has power.
#   AC5  time.human_wait_s derives from real lifecycle pause/resume intervals (canceled run).
#   AC6  economics-record.sh --flow-run-dir assembles a schema-valid kontour.console.economics
#        record from the above, with tokens null + tokens_unattributed:true (never fabricated), and
#        writes it local-first WITHOUT any console relay (producer_authority "flow_run_record" is
#        local-only).
#   AC7  economics-enrich-tokens.mjs sums real transcript usage into the exact phase windows,
#        skips malformed lines with an honest count, and never reports a line outside every window
#        as belonging to one.
#
# Deterministic: fixed fixtures under evals/fixtures/economics/run-binding/, --now pinned, no
# network, no model spend.
# Usage: bash evals/integration/test_economics_run_binding.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TELEMETRY="$ROOT/scripts/telemetry"
FLOW_RUN_ECON="$TELEMETRY/flow-run-economics.mjs"
ENRICH="$TELEMETRY/economics-enrich-tokens.mjs"
EMITTER="$TELEMETRY/economics-record.sh"
SCHEMA="$TELEMETRY/economics-record.schema.json"
FIX="$ROOT/evals/fixtures/economics/run-binding"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

errors=0
pass() { echo "  [PASS] $1"; }
fail() { echo "  [FAIL] $1"; errors=$((errors + 1)); }

if ! command -v jq >/dev/null 2>&1; then echo "jq not available; skipping economics run-binding tests"; exit 0; fi
if ! command -v node >/dev/null 2>&1; then echo "node not available; skipping economics run-binding tests"; exit 0; fi

echo "=== economics run binding (#922/#925 phase A) ==="

jget() { # <json-file-or-string-via-stdin> <jq-filter>
  jq -r "$2"
}

# ── AC1/AC2/AC3: routeback-completed fixture — phase sums, route-backs, verdict ─────────────────
echo "--- AC1/AC2/AC3: phase-window summation, route-backs, verify verdict ---"
DERIVED1="$TMP/derived1.json"
node "$FLOW_RUN_ECON" --flow-run-dir "$FIX/routeback-completed" > "$DERIVED1"
EXP1="$FIX/routeback-completed/expected.json"

ok="$(jq -e '.ok == true' "$DERIVED1" >/dev/null 2>&1 && echo true || echo false)"
[[ "$ok" == "true" ]] && pass "flow-run-economics.mjs derives successfully from a real-shaped fixture" \
  || fail "flow-run-economics.mjs did not return ok:true for routeback-completed"

run_id_actual="$(jq -r '.run_id' "$DERIVED1")"
run_id_expected="$(jq -r '.run_id' "$EXP1")"
[[ "$run_id_actual" == "$run_id_expected" ]] && pass "run_id is the Flow run id (joinable), not a session id ($run_id_actual)" \
  || fail "run_id mismatch: got $run_id_actual want $run_id_expected"

terminal_actual="$(jq -r '.terminal_status' "$DERIVED1")"
terminal_expected="$(jq -r '.terminal_status' "$EXP1")"
[[ "$terminal_actual" == "$terminal_expected" ]] && pass "terminal_status == completed for a genuinely completed run ($terminal_actual)" \
  || fail "terminal_status mismatch: got $terminal_actual want $terminal_expected"

for phase in design-probe plan execute verify merge-ready pr-open; do
  actual_wc="$(jq -r --arg p "$phase" '.phases[] | select(.phase == $p) | .wall_clock_s' "$DERIVED1")"
  expected_wc="$(jq -r --arg p "$phase" '.phase_wall_clock_s[$p]' "$EXP1")"
  if [[ "$actual_wc" == "$expected_wc" ]]; then
    pass "phase '$phase' wall_clock_s == $expected_wc (route-back re-entries accumulate onto one bucket)"
  else
    fail "phase '$phase' wall_clock_s: got $actual_wc want $expected_wc"
  fi
done

total_actual="$(jq -r '.time.wall_clock_s' "$DERIVED1")"
total_expected="$(jq -r '.total_wall_clock_s' "$EXP1")"
[[ "$total_actual" == "$total_expected" ]] && pass "time.wall_clock_s == sum(phases[].wall_clock_s) == $total_expected (phase-sum invariant)" \
  || fail "time.wall_clock_s mismatch: got $total_actual want $total_expected"

rb_actual="$(jq -r '.iterations.route_backs' "$DERIVED1")"
rb_expected="$(jq -r '.iterations.route_backs' "$EXP1")"
[[ "$rb_actual" == "$rb_expected" ]] && pass "iterations.route_backs == $rb_expected (counts transitions[].type==route_back)" \
  || fail "iterations.route_backs mismatch: got $rb_actual want $rb_expected"

it_actual="$(jq -r '.iterations.count' "$DERIVED1")"
it_expected="$(jq -r '.iterations.count' "$EXP1")"
[[ "$it_actual" == "$it_expected" ]] && pass "iterations.count == route_backs+1 == $it_expected" \
  || fail "iterations.count mismatch: got $it_actual want $it_expected"

gf_actual="$(jq -r '.defects.gate_fires' "$DERIVED1")"
gf_expected="$(jq -r '.defects.gate_fires' "$EXP1")"
[[ "$gf_actual" == "$gf_expected" ]] && pass "defects.gate_fires == $gf_expected" \
  || fail "defects.gate_fires mismatch: got $gf_actual want $gf_expected"

verdict_actual="$(jq -r '.defects.verification_verdict' "$DERIVED1")"
verdict_expected="$(jq -r '.defects.verification_verdict' "$EXP1")"
[[ "$verdict_actual" == "$verdict_expected" ]] && pass "defects.verification_verdict == $verdict_expected (last verify departure)" \
  || fail "defects.verification_verdict mismatch: got $verdict_actual want $verdict_expected"

# ── AC3 (continued): verify never reached -> NOT_VERIFIED, never guessed as PASS -----------------
echo "--- AC3: verify never reached -> NOT_VERIFIED (active-mid-flight) ---"
NOW1="$(cat "$FIX/active-mid-flight/now.txt")"
DERIVED2="$TMP/derived2.json"
node "$FLOW_RUN_ECON" --flow-run-dir "$FIX/active-mid-flight" --now "$NOW1" > "$DERIVED2"
EXP2="$FIX/active-mid-flight/expected.json"
verdict2_actual="$(jq -r '.defects.verification_verdict' "$DERIVED2")"
[[ "$verdict2_actual" == "NOT_VERIFIED" ]] && pass "verify never reached -> NOT_VERIFIED, not guessed as PASS or FAIL" \
  || fail "expected NOT_VERIFIED, got $verdict2_actual"

for phase in design-probe plan execute; do
  actual_wc="$(jq -r --arg p "$phase" '.phases[] | select(.phase == $p) | .wall_clock_s' "$DERIVED2")"
  expected_wc="$(jq -r --arg p "$phase" '.phase_wall_clock_s[$p]' "$EXP2")"
  [[ "$actual_wc" == "$expected_wc" ]] && pass "active-run phase '$phase' wall_clock_s == $expected_wc (tail bounded by --now, not fabricated)" \
    || fail "active-run phase '$phase' wall_clock_s: got $actual_wc want $expected_wc"
done

# ── AC4: terminal_status honesty — RED/GREEN fault-injection power proof -------------------------
echo "--- AC4: terminal_status honesty — a still-active run is NEVER 'completed' (RED/GREEN) ---"
terminal2_actual="$(jq -r '.terminal_status' "$DERIVED2")"
[[ "$terminal2_actual" == "active_abandoned" ]] && pass "GREEN: current code reports active_abandoned for a mid-flight run, never completed" \
  || fail "GREEN case failed: got $terminal2_actual, expected active_abandoned"

# RED proof: inject the exact defect this AC guards against — a naive terminal-status mapping
# that folds every non-terminal Flow status into "completed" — and prove the assertion above
# WOULD catch it. If this broken copy also reported active_abandoned, the assertion above would
# have no power to catch a real regression.
BROKEN="$TMP/flow-run-economics.broken.mjs"
sed -E "s/case 'active':\$/case '__never_matches__':/; s/return 'active_abandoned';/return 'completed';/" \
  "$FLOW_RUN_ECON" > "$BROKEN"
if ! diff -q "$FLOW_RUN_ECON" "$BROKEN" >/dev/null 2>&1; then
  BROKEN_OUT="$TMP/derived2-broken.json"
  node "$BROKEN" --flow-run-dir "$FIX/active-mid-flight" --now "$NOW1" > "$BROKEN_OUT" 2>/dev/null
  broken_terminal="$(jq -r '.terminal_status // "ERROR"' "$BROKEN_OUT" 2>/dev/null)"
  if [[ "$broken_terminal" == "completed" ]]; then
    pass "RED: a naive 'always completed' mapping IS caught (would fail the AC4 GREEN assertion above)"
  else
    fail "RED proof inconclusive: broken copy produced '$broken_terminal', expected 'completed' — injection did not take"
  fi
else
  fail "RED fault injection did not modify the script (sed pattern no longer matches source)"
fi

# ── AC5: human_wait_s from real lifecycle pause/resume intervals (canceled run) -------------------
echo "--- AC5: time.human_wait_s from lifecycle pause/resume (canceled-with-pause) ---"
DERIVED3="$TMP/derived3.json"
node "$FLOW_RUN_ECON" --flow-run-dir "$FIX/canceled-with-pause" > "$DERIVED3"
EXP3="$FIX/canceled-with-pause/expected.json"
hw_actual="$(jq -r '.time.human_wait_s' "$DERIVED3")"
hw_expected="$(jq -r '.human_wait_s' "$EXP3")"
[[ "$hw_actual" == "$hw_expected" ]] && pass "time.human_wait_s == $hw_expected (real pause->resume interval, not estimated)" \
  || fail "time.human_wait_s mismatch: got $hw_actual want $hw_expected"

terminal3_actual="$(jq -r '.terminal_status' "$DERIVED3")"
[[ "$terminal3_actual" == "canceled" ]] && pass "terminal_status == canceled (lifecycle cancel event)" \
  || fail "terminal_status mismatch: got $terminal3_actual want canceled"

# ── AC6: economics-record.sh --flow-run-dir assembles a schema-valid, honest record ---------------
echo "--- AC6: economics-record.sh --flow-run-dir end-to-end assembly ---"
LOG1="$TMP/econ-flow-run.jsonl"
TELEMETRY_ECONOMICS_LOG_FILE="$LOG1" bash "$EMITTER" --flow-run-dir "$FIX/routeback-completed" --task-slug "econ-fixture-routeback-completed"
n="$(wc -l < "$LOG1" 2>/dev/null | tr -d ' ')"
[[ "${n:-0}" == "1" ]] && pass "exactly one record written to the local economics log" \
  || fail "expected exactly one record, log has ${n:-0} lines"

RECORD1="$TMP/record1.json"
tail -n1 "$LOG1" > "$RECORD1" 2>/dev/null || : > "$RECORD1"

pa="$(jq -r '.producer_authority' "$RECORD1" 2>/dev/null)"
[[ "$pa" == "flow_run_record" ]] && pass "producer_authority == flow_run_record" \
  || fail "producer_authority mismatch: got $pa"

rid="$(jq -r '.run_id' "$RECORD1" 2>/dev/null)"
[[ "$rid" == "econ-fixture-routeback-completed" ]] && pass "record run_id is the Flow run id ($rid)" \
  || fail "record run_id mismatch: got $rid"

ts="$(jq -r '.terminal_status' "$RECORD1" 2>/dev/null)"
[[ "$ts" == "completed" ]] && pass "record terminal_status == completed" \
  || fail "record terminal_status mismatch: got $ts"

tu="$(jq -r '.tokens_unattributed' "$RECORD1" 2>/dev/null)"
[[ "$tu" == "true" ]] && pass "tokens_unattributed == true (no transcript was supplied; never fabricated as 0-cost)" \
  || fail "tokens_unattributed mismatch: got $tu"

allnull="$(jq -e '[.phases[] | select(.input_tokens != null)] | length == 0' "$RECORD1" >/dev/null 2>&1 && echo true || echo false)"
[[ "$allnull" == "true" ]] && pass "every phase's token fields are null, not 0 (absence of signal never looks like a real zero)" \
  || fail "some phase carried a non-null token field with no attribution source"

srcs="$(jq -r '[.phases[].source] | unique | join(",")' "$RECORD1" 2>/dev/null)"
[[ "$srcs" == "flow-run-record" ]] && pass "every phase is tagged source: flow-run-record" \
  || fail "unexpected phase source tags: $srcs"

corr_status="$(jq -r '.run_correlation.status' "$RECORD1" 2>/dev/null)"
[[ "$corr_status" == "incomplete" ]] && pass "run_correlation stays explicitly incomplete (no session identity fabricated in this mode)" \
  || fail "run_correlation.status unexpected: got $corr_status"

# Schema validity (ajv, 2020-12, resolving the run-correlation $ref).
schema_valid="$(node -e '
const Ajv=require("ajv/dist/2020").default; const a=new Ajv({allErrors:true,strict:false});
a.addSchema(require(process.argv[1]));
const validate=a.compile(require(process.argv[2]));
const record=require(process.argv[3]);
const ok=validate(record);
if(!ok) console.error(JSON.stringify(validate.errors));
console.log(ok);
' "$ROOT/schemas/run-correlation-envelope.schema.json" "$SCHEMA" "$RECORD1" 2>"$TMP/ajv-err.log")"
[[ "$schema_valid" == "true" ]] && pass "flow-run-record-mode record validates against economics-record.schema.json (v0.2)" \
  || fail "schema validation failed: $(cat "$TMP/ajv-err.log" 2>/dev/null)"

# ── AC6 (continued): local-only — this mode NEVER attempts a console relay -------------------------
echo "--- AC6: flow_run_record producer_authority never relays to console (local-only) ---"
STUB_LOG="$TMP/stub-received.jsonl"
: > "$STUB_LOG"
PORT=38911
node -e '
const http = require("http");
const fs = require("fs");
const port = Number(process.argv[2]);
const outFile = process.argv[3];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    fs.appendFileSync(outFile, body + "\n");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
});
server.listen(port, "127.0.0.1", () => { process.stdout.write("READY\n"); });
' "$PORT" "$STUB_LOG" > "$TMP/stub.log" 2>&1 &
STUB_PID=$!
for _ in $(seq 1 50); do grep -q READY "$TMP/stub.log" 2>/dev/null && break; sleep 0.1; done

LOG2="$TMP/econ-flow-run-relay-attempt.jsonl"
FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY=true \
FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL="http://127.0.0.1:$PORT/records" \
TELEMETRY_ECONOMICS_LOG_FILE="$LOG2" \
  bash "$EMITTER" --flow-run-dir "$FIX/routeback-completed" >/dev/null 2>&1
sleep 0.3
kill "$STUB_PID" 2>/dev/null || true

n2="$(wc -l < "$LOG2" 2>/dev/null | tr -d ' ')"
[[ "${n2:-0}" == "1" ]] && pass "local write still happens even with relay env vars set (local-first)" \
  || fail "local write missing under relay env vars"

stub_lines="$(wc -l < "$STUB_LOG" 2>/dev/null | tr -d ' ')"
[[ "${stub_lines:-0}" == "0" ]] && pass "console stub received NOTHING — flow_run_record mode never relays, regardless of env" \
  || fail "console stub received ${stub_lines:-0} record(s); flow_run_record mode must never relay"

# ── AC6 (continued): missing/unreadable flow-run-dir -> no-op, never a fabricated record ----------
echo "--- AC6: missing flow-run-dir -> no record (never fabricated) ---"
LOG3="$TMP/econ-missing.jsonl"
bash "$EMITTER" --flow-run-dir "$TMP/does-not-exist-$$" >/dev/null 2>&1
TELEMETRY_ECONOMICS_LOG_FILE="$LOG3" bash "$EMITTER" --flow-run-dir "$TMP/does-not-exist-$$" >/dev/null 2>&1
[[ ! -e "$LOG3" ]] && pass "a missing flow-run-dir writes nothing (no-op, never a guessed/incomplete record)" \
  || fail "a missing flow-run-dir unexpectedly wrote a record"

# ── AC7: economics-enrich-tokens.mjs — exact sums, malformed-line accounting ----------------------
echo "--- AC7: economics-enrich-tokens.mjs transcript slicing ---"
ENRICHED="$TMP/enriched.json"
node "$ENRICH" --transcript "$FIX/transcript.jsonl" --windows-json "$FIX/transcript-windows.json" > "$ENRICHED"

ok7="$(jq -e '.ok == true' "$ENRICHED" >/dev/null 2>&1 && echo true || echo false)"
[[ "$ok7" == "true" ]] && pass "economics-enrich-tokens.mjs returns ok:true for a readable transcript" \
  || fail "economics-enrich-tokens.mjs did not return ok:true"

dp_in="$(jq -r '.phases[] | select(.phase=="design-probe") | .input_tokens' "$ENRICHED")"
dp_out="$(jq -r '.phases[] | select(.phase=="design-probe") | .output_tokens' "$ENRICHED")"
[[ "$dp_in" == "10" && "$dp_out" == "40" ]] && pass "design-probe window sums exactly (input=10, output=40)" \
  || fail "design-probe sums wrong: input=$dp_in output=$dp_out"

plan_in="$(jq -r '.phases[] | select(.phase=="plan") | .input_tokens' "$ENRICHED")"
plan_out="$(jq -r '.phases[] | select(.phase=="plan") | .output_tokens' "$ENRICHED")"
plan_cc="$(jq -r '.phases[] | select(.phase=="plan") | .cache_creation_input_tokens' "$ENRICHED")"
plan_cr="$(jq -r '.phases[] | select(.phase=="plan") | .cache_read_input_tokens' "$ENRICHED")"
if [[ "$plan_in" == "320" && "$plan_out" == "230" && "$plan_cc" == "5" && "$plan_cr" == "100" ]]; then
  pass "plan window sums exactly across TWO lines in the same window (input=320, output=230, cc=5, cr=100)"
else
  fail "plan sums wrong: input=$plan_in output=$plan_out cc=$plan_cc cr=$plan_cr"
fi

malformed="$(jq -r '.malformed_lines_skipped' "$ENRICHED")"
[[ "$malformed" == "2" ]] && pass "malformed_lines_skipped == 2 (invalid JSON + missing timestamp), never fatal" \
  || fail "malformed_lines_skipped mismatch: got $malformed want 2"

outside="$(jq -r '.lines_outside_windows' "$ENRICHED")"
[[ "$outside" == "1" ]] && pass "lines_outside_windows == 1 (a real usage line outside every window is disclosed, not silently dropped or misattributed)" \
  || fail "lines_outside_windows mismatch: got $outside want 1"

# Missing transcript -> ok:false, never a fabricated zero-token phase set.
MISSING_OUT="$TMP/enrich-missing.json"
node "$ENRICH" --transcript "$TMP/no-such-transcript.jsonl" --windows-json "$FIX/transcript-windows.json" > "$MISSING_OUT"
mok="$(jq -r '.ok' "$MISSING_OUT")"
[[ "$mok" == "false" ]] && pass "missing transcript -> ok:false, no phases[] fabricated" \
  || fail "missing transcript did not degrade to ok:false: $(cat "$MISSING_OUT")"

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "test_economics_run_binding: all checks passed."
  exit 0
else
  echo "test_economics_run_binding: $errors check(s) FAILED."
  exit 1
fi
