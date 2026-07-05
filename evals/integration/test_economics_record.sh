#!/usr/bin/env bash
# test_economics_record.sh — per-run kit-economics record (#349, console ADR 0003).
#
# Proves scripts/telemetry/economics-record.sh assembles exactly one immutable
# `kontour.console.economics` v0.1 fact per run — cost, time, iterations, defects caught — from the
# session.usage event's usage block (TRANSCRIPT ground truth, never re-estimated), the review sidecar
# critique.json (defects), and state.json (verdict / phase / iterations). And — non-negotiable —
# local-first holds (ADR 0003 call 6): the record is written to the local economics log FIRST, the
# console POST is opt-in + detached + fail-open, and a failing/absent console never blocks the run.
#
# Coverage → ACs:
#   AC1/AC6 (R1,R7)  schema: golden fixture validates; a cost-only doctored record (no defects) FAILS.
#   AC2 (R2,R8)      cost.* equals the session.usage usage block; exactly one record; local write.
#   AC3 (R3)         phase-sum invariant, phase-known AND phase-unknown (→ unattributed).
#   AC4 (R4,R6)      route-back / verdict: iterations.count==2, route_backs==1, verdict PASS, human_wait>0.
#   AC5 (R5)         gate_fires, per-severity findings_by_severity, caught_false_completions==1 (distinct).
#   AC7 (R8)         telemetry-disabled + console-500 fail-open: run unaffected, local record still exists.
#   injection        hostile task_slug/finding text → jq \u-escaped, never raw control bytes in the POST.
#
# Deterministic (a local stub HTTP server, no network / model spend, self-cleaning). The relay POST is
# detached/async so stub-received assertions poll with a timeout.
# Usage: bash evals/integration/test_economics_record.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TELEMETRY="$ROOT/scripts/telemetry"
EMITTER="$TELEMETRY/economics-record.sh"
SCHEMA="$TELEMETRY/economics-record.schema.json"
FIX="$ROOT/evals/fixtures/economics"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; [[ -n "${STUB_PID:-}" ]] && kill "$STUB_PID" 2>/dev/null' EXIT
PORT=38812
RECV="$TMP/recv.jsonl"

errors=0
pass() { echo "  [PASS] $1"; }
fail() { echo "  [FAIL] $1"; errors=$((errors + 1)); }

if ! command -v jq >/dev/null 2>&1; then echo "jq not available; skipping economics record tests"; exit 0; fi

echo "=== economics record (#349) ==="

# ── Build the session.usage event from the fixture transcript via the REAL usage parser ────────────
# This is what wires "tokens come from transcript ground truth" into the test: the usage block is
# produced by usage_parse_transcript reading each assistant message's .message.usage — not hand-set.
# shellcheck source=/dev/null
source "$ROOT/scripts/telemetry/lib/usage.sh"
TU="$(usage_parse_transcript "$FIX/transcript.jsonl")" || { fail "usage_parse_transcript returned empty"; }
USAGE_EVENT="$(jq -cn --argjson tu "$TU" --arg model "claude-opus-4-8" '{
  schema_version:"0.3.0", timestamp:"1751731200000",
  session_id:"kontourai-flow-agents-349-run-01", event_id:"evt-01-usage",
  event_type:"session.usage", agent:{name:"dev",runtime:"claude-code",version:"1"},
  context:{cwd:"/workspace/flow-agents"},
  usage:{ model:$model, duration_s:420, tool_invocations:12, delegations:3,
    input_tokens:$tu.input_tokens, output_tokens:$tu.output_tokens,
    cache_creation_input_tokens:$tu.cache_creation_input_tokens,
    cache_read_input_tokens:$tu.cache_read_input_tokens,
    estimated_cost_usd:$tu.estimated_cost_usd, pricing_version:$tu.pricing_version,
    by_model:$tu.by_model }
}')"

# Run the emitter with an isolated local economics log; echo the assembled record.
run_emitter() { # <local_log> [extra emitter args...]
  local log="$1"; shift
  TELEMETRY_ECONOMICS_LOG_FILE="$log" bash "$EMITTER" "$USAGE_EVENT" "$@"
}

# ── AC2 + AC5 + AC4: full fixture (phase-known) → assert every field's source value ────────────────
echo "--- AC2/AC4/AC5: full fixture record — cost from usage, defects from critique, verdict from state ---"
LOG1="$TMP/econ1.jsonl"; : > "$LOG1"
run_emitter "$LOG1" --state "$FIX/state.json" --acceptance "$FIX/acceptance.json" --critique "$FIX/critique.json"
n=$(wc -l < "$LOG1" | tr -d ' ')
[[ "$n" == "1" ]] && pass "exactly one record written to the local log (local-first)" || fail "expected 1 record, got $n"
REC="$(cat "$LOG1")"

# cost.* == session.usage .usage.* (ground truth, verbatim)
assert_eq() { # <label> <jq-expr-on-REC> <expected>
  local got; got="$(printf '%s' "$REC" | jq -c "$2" 2>/dev/null)"
  [[ "$got" == "$3" ]] && pass "$1 ($got)" || fail "$1: expected $3 got $got"
}
assert_eq "cost.input_tokens == usage.input_tokens" '.cost.input_tokens' "$(printf '%s' "$USAGE_EVENT" | jq -c '.usage.input_tokens')"
assert_eq "cost.output_tokens == usage.output_tokens" '.cost.output_tokens' "$(printf '%s' "$USAGE_EVENT" | jq -c '.usage.output_tokens')"
assert_eq "cost.cache_read_input_tokens == usage" '.cost.cache_read_input_tokens' "$(printf '%s' "$USAGE_EVENT" | jq -c '.usage.cache_read_input_tokens')"
assert_eq "cost.estimated_cost_usd == usage" '.cost.estimated_cost_usd' "$(printf '%s' "$USAGE_EVENT" | jq -c '.usage.estimated_cost_usd')"
assert_eq "cost.by_model == usage.by_model verbatim" '.cost.by_model' "$(printf '%s' "$USAGE_EVENT" | jq -c '.usage.by_model')"
assert_eq "model == usage.model" '.model' '"claude-opus-4-8"'
assert_eq "pricing_version carried" '.pricing_version' '"2026-06-28"'
assert_eq "run_id == session_id" '.run_id' '"kontourai-flow-agents-349-run-01"'
assert_eq "task_slug from state.json" '.task_slug' '"kontourai-flow-agents-349"'
# AC5: defects from critique.json (severity grouping, missing→low; distinct false-completion)
assert_eq "findings_by_severity.critical" '.defects.findings_by_severity.critical' '1'
assert_eq "findings_by_severity.high" '.defects.findings_by_severity.high' '2'
assert_eq "findings_by_severity.medium" '.defects.findings_by_severity.medium' '1'
assert_eq "findings_by_severity.low (incl. missing-severity default)" '.defects.findings_by_severity.low' '2'
assert_eq "caught_false_completions == 1 (distinct)" '.defects.caught_false_completions' '1'
assert_eq "gate_fires from state.json" '.defects.gate_fires' '3'
# AC4: iterations + verdict + human_wait from state.json
assert_eq "iterations.count == 2" '.iterations.count' '2'
assert_eq "iterations.route_backs == 1" '.iterations.route_backs' '1'
assert_eq "verification_verdict == PASS" '.defects.verification_verdict' '"PASS"'
assert_eq "human_wait_s > 0 (decision pause present)" '.time.human_wait_s' '45'
assert_eq "wall_clock_s == usage.duration_s" '.time.wall_clock_s' '420'

# ── AC1/AC6: schema validation — golden validates; cost-only (no defects) FAILS (R7 Goodhart) ─────
echo "--- AC1/AC6: schema — golden validates positive; a cost-only record FAILS (co-required cost+defects) ---"
SCHEMA_CHECK="$(node -e '
const Ajv=require("ajv");
const a=new Ajv({allErrors:true,strict:false});
const v=a.compile(require(process.argv[1]));
const golden=require(process.argv[2]);
const good=v(golden);
const cur=JSON.parse(require("fs").readFileSync(process.argv[3],"utf8"));
const curOk=v(cur);
const bad=JSON.parse(JSON.stringify(golden)); delete bad.defects;
const badOk=v(bad);
console.log(JSON.stringify({good, curOk, badOk}));
' "$SCHEMA" "$FIX/expected-record.json" "$LOG1" 2>&1)"
echo "$SCHEMA_CHECK" | grep -q '"good":true' && pass "golden fixture validates against economics-record.schema.json" || fail "golden did NOT validate: $SCHEMA_CHECK"
echo "$SCHEMA_CHECK" | grep -q '"curOk":true' && pass "freshly-emitted record validates against the schema" || fail "emitted record did NOT validate: $SCHEMA_CHECK"
echo "$SCHEMA_CHECK" | grep -q '"badOk":false' && pass "cost-only record (defects removed) FAILS validation — R7 co-required guard holds" || fail "cost-only record wrongly validated: $SCHEMA_CHECK"

# ── golden parity: the emitted record equals the committed golden (sorted) ─────────────────────────
if diff <(jq -S . "$LOG1") <(jq -S . "$FIX/expected-record.json") >/dev/null 2>&1; then
  pass "emitted record byte-equals the committed golden fixture (expected-record.json)"
else
  fail "emitted record drifted from golden: $(diff <(jq -S . "$LOG1") <(jq -S . "$FIX/expected-record.json") | head -20)"
fi

# ── AC3: phase-sum invariant — phase-known AND phase-unknown → unattributed ────────────────────────
echo "--- AC3: phase-sum invariant holds (phase-known → its bucket; phase-unknown → unattributed) ---"
check_phase_sum() { # <record> <expected_phase_label>
  local rec="$1" want="$2"
  local ok
  ok="$(printf '%s' "$rec" | jq -c '
    (.phases | map(.input_tokens) | add) as $pi
    | (.phases | map(.output_tokens) | add) as $po
    | (.phases | map(.cache_read_input_tokens) | add) as $pcr
    | (.phases | map(.wall_clock_s) | add) as $pw
    | ($pi == .cost.input_tokens and $po == .cost.output_tokens
       and $pcr == .cost.cache_read_input_tokens and $pw == .time.wall_clock_s)')"
  [[ "$ok" == "true" ]] && pass "phase-sum invariant holds ($want)" || fail "phase-sum invariant BROKEN ($want): $ok"
  local lbl; lbl="$(printf '%s' "$rec" | jq -r '.phases[0].phase')"
  [[ "$lbl" == "$want" ]] && pass "phase label is '$want'" || fail "phase label expected '$want' got '$lbl'"
}
check_phase_sum "$REC" "verify"
# phase-unknown: state.json with NO phase → single unattributed bucket, still sums.
STATE_NOPHASE="$TMP/state-nophase.json"
jq 'del(.phase)' "$FIX/state.json" > "$STATE_NOPHASE"
LOG2="$TMP/econ2.jsonl"; : > "$LOG2"
run_emitter "$LOG2" --state "$STATE_NOPHASE" --critique "$FIX/critique.json"
check_phase_sum "$(cat "$LOG2")" "unattributed"

# ── injection: hostile task_slug + finding text → jq-escaped, never raw control bytes ─────────────
echo "--- injection: hostile task_slug/finding text are \\u-escaped, never raw control bytes ---"
HOSTILE_STATE="$TMP/hostile-state.json"
HOSTILE_CRIT="$TMP/hostile-crit.json"
node -e '
const fs=require("fs");const esc=String.fromCharCode(27),bel=String.fromCharCode(7);
fs.writeFileSync(process.argv[1], JSON.stringify({schema_version:"1.0",task_slug:"slug"+esc+"[31m"+bel+"EVIL",phase:"exec"+esc+"ute",verification_verdict:"PASS"}));
fs.writeFileSync(process.argv[2], JSON.stringify({critiques:[{findings:[{severity:"high",description:"finding"+esc+"[2J"+bel+"text"}]}]}));
' "$HOSTILE_STATE" "$HOSTILE_CRIT"
LOG3="$TMP/econ3.jsonl"; : > "$LOG3"
run_emitter "$LOG3" --state "$HOSTILE_STATE" --critique "$HOSTILE_CRIT"
# Scan for raw control bytes via node (cross-platform; macOS grep lacks -P). ESCAPED ⇒ jq \u-escaped.
INJ="$(node -e '
const fs=require("fs");const raw=fs.readFileSync(process.argv[1],"utf8");
if(!raw.trim()){console.log("EMPTY");process.exit(0)}
console.log(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(raw)?"RAW":"ESCAPED");
' "$LOG3" 2>&1)"
[[ "$INJ" == "ESCAPED" ]] && pass "hostile task_slug/finding control bytes are JSON-escaped, never raw in the record (injection discipline)" || fail "raw control bytes reached the record ($INJ)"
printf '%s' "$(cat "$LOG3")" | jq -e . >/dev/null 2>&1 && pass "record with hostile fields is still valid JSON" || fail "hostile fields produced invalid JSON"

# ── Stub Console endpoint (200 / 500) for the relay + fail-open cases ──────────────────────────────
start_stub() {
  local mode="$1"
  STUB_MODE="$mode" node -e '
const http=require("http"),fs=require("fs");
const out=process.argv[1], mode=process.env.STUB_MODE||"ok";
const s=http.createServer((req,res)=>{let b="";req.on("data",d=>b+=d);req.on("end",()=>{
  fs.appendFileSync(out, JSON.stringify({method:req.method,headers:req.headers,body:b})+"\n");
  res.writeHead(mode==="fail"?500:200); res.end(mode==="fail"?"err":"ok");
});});
s.listen(Number(process.argv[2]),"127.0.0.1");
setTimeout(()=>process.exit(0),30000);
' "$RECV" "$PORT" >/dev/null 2>&1 &
  STUB_PID=$!
  for _ in $(seq 1 20); do
    if node -e 'const n=require("net");const s=n.connect(Number(process.argv[1]),"127.0.0.1");s.on("connect",()=>{s.end();process.exit(0)});s.on("error",()=>process.exit(1))' "$PORT" 2>/dev/null; then return 0; fi
    sleep 0.2
  done
  return 1
}
stop_stub() { [[ -n "${STUB_PID:-}" ]] && kill "$STUB_PID" 2>/dev/null; STUB_PID=""; }
wait_for_post() { for _ in $(seq 1 25); do [[ -s "$RECV" ]] && return 0; sleep 0.2; done; return 1; }
ENDPOINT="http://127.0.0.1:${PORT}/records"

# ── local-first: NO console configured → local write happens, nothing POSTed ──────────────────────
echo "--- local-first: no console configured → local record written, nothing POSTed ---"
: > "$RECV"; start_stub ok || fail "stub server did not start"
LOG4="$TMP/econ4.jsonl"; : > "$LOG4"
(
  unset FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL \
        FLOW_AGENTS_CONSOLE_URL CONSOLE_TELEMETRY_URL CONSOLE_URL
  run_emitter "$LOG4" --state "$FIX/state.json" --critique "$FIX/critique.json"
)
sleep 1
[[ -s "$LOG4" ]] && pass "local economics record written with NO console configured (local-first)" || fail "local record missing with no console"
[[ ! -s "$RECV" ]] && pass "NO POST when no console endpoint is configured (opt-in respected)" || fail "a POST happened with no console configured"
stop_stub

# ── console configured + relay ON → POST lands with the record + auth headers ─────────────────────
echo "--- relay on+configured: record mirrors to the Console over the shared transport with auth ---"
: > "$RECV"; start_stub ok
LOG5="$TMP/econ5.jsonl"; : > "$LOG5"
(
  export FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY=1
  export FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL="$ENDPOINT"
  export CONSOLE_TELEMETRY_TOKEN="tok-econ-123"
  export CONSOLE_TENANT_ID="tenant-econ"
  run_emitter "$LOG5" --state "$FIX/state.json" --critique "$FIX/critique.json"
)
[[ -s "$LOG5" ]] && pass "local record written even when relay is ON (local-first, still first)" || fail "local record missing with relay on"
if wait_for_post; then pass "record POSTed to the Console endpoint (opt-in relay)"; else fail "relay did NOT POST within timeout"; fi
node -e '
const fs=require("fs"); const raw=fs.readFileSync(process.argv[1],"utf8").trim();
if(!raw){console.log("NO_POST");process.exit(0)}
const r=JSON.parse(raw.split("\n")[0]); const b=JSON.parse(r.body);
const checks=[
  ["method POST", r.method==="POST"],
  ["authorization bearer", r.headers["authorization"]==="Bearer tok-econ-123"],
  ["tenant header", r.headers["x-console-tenant-id"]==="tenant-econ"],
  ["schema kontour.console.economics", b.schema==="kontour.console.economics"],
  ["version 0.1", b.version==="0.1"],
  ["cost.input_tokens 1000", b.cost.input_tokens===1000],
  ["defects present (R7 pair shipped)", !!b.defects && typeof b.defects.gate_fires==="number"],
];
for(const [n,ok] of checks) console.log((ok?"OK ":"BAD ")+n);
' "$RECV" > "$TMP/checks.txt" 2>&1
while IFS= read -r line; do
  [[ "$line" == OK* ]] && pass "POST body ${line#OK }" || fail "POST body ${line#BAD } — $(cat "$TMP/checks.txt")"
done < <(grep -E '^(OK|BAD) ' "$TMP/checks.txt")
stop_stub

# ── AC7: fail-open — console returns 500 → emitter exits 0, local record intact ───────────────────
echo "--- AC7: console 500 (detached) → emitter exits 0, local record still exists (fail-open) ---"
: > "$RECV"; start_stub fail
LOG6="$TMP/econ6.jsonl"; : > "$LOG6"
(
  export FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY=1
  export FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL="$ENDPOINT"
  run_emitter "$LOG6" --state "$FIX/state.json" --critique "$FIX/critique.json"
)
rc=$?
[[ "$rc" -eq 0 ]] && pass "emitter exits 0 even when the console endpoint fails (non-fatal)" || fail "emitter exited non-zero ($rc) on console failure"
[[ -s "$LOG6" ]] && pass "local record written despite console 500 (local-first)" || fail "local record missing on console failure"
stop_stub

# ── AC7: telemetry disabled at the stop-hook → no economics call, run unaffected ──────────────────
echo "--- AC7: telemetry disabled (TELEMETRY_USAGE_TRACKING!=true) → stop hook emits no economics record ---"
# The wiring in telemetry.sh guards the economics call behind TELEMETRY_USAGE_TRACKING == true; the
# emitter itself is unconditional (it is only ever invoked from inside that guard). Assert the guard.
if grep -q 'economics-record.sh' "$TELEMETRY/telemetry.sh" \
   && awk '/TELEMETRY_USAGE_TRACKING.*==.*true/{g=1} g&&/economics-record.sh/{found=1} END{exit !found}' "$TELEMETRY/telemetry.sh"; then
  pass "stop-hook economics emission is nested under the TELEMETRY_USAGE_TRACKING==true guard (disabled ⇒ no emit)"
else
  fail "economics emission is NOT guarded by TELEMETRY_USAGE_TRACKING in telemetry.sh"
fi

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "test_economics_record: all checks passed."
  exit 0
else
  echo "test_economics_record: $errors check(s) failed."
  exit 1
fi
