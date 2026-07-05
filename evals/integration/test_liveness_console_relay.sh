#!/usr/bin/env bash
# test_liveness_console_relay.sh — optional console liveness relay (#295, ADR 0021 §4/§7).
#
# Proves the flow-agents EMIT half of the fleet relay: when opted in + configured, a liveness event
# is mirrored to the Console as a `kontour.console.liveness` record over the SAME transport core the
# telemetry mirror uses (Bearer + tenant auth). And — non-negotiable — local-first holds: with the
# relay off or unconfigured, or when the relay POST fails, the durable local `liveness/events.jsonl`
# write always succeeds and nothing propagates.
#
# Deterministic (a local stub HTTP server, no network/model spend, self-cleaning). The relay POST is
# detached+async, so the stub-received assertions poll with a timeout.
# Usage: bash evals/integration/test_liveness_console_relay.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

TMPDIR_EVAL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_EVAL"; [[ -n "${STUB_PID:-}" ]] && kill "$STUB_PID" 2>/dev/null' EXIT
PORT=38795
RECV="$TMPDIR_EVAL/recv.jsonl"

errors=0
pass() { echo "  [PASS] $1"; }
fail() { echo "  [FAIL] $1"; errors=$((errors + 1)); }

# Stub Console endpoint: append each received {method, headers, body} as one JSON line. `mode` env
# controls the response — "ok" (200) or "fail" (500) — to exercise the relay-failure path.
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
  # wait for bind
  for _ in $(seq 1 20); do
    if node -e 'const n=require("net");const s=n.connect(Number(process.argv[1]),"127.0.0.1");s.on("connect",()=>{s.end();process.exit(0)});s.on("error",()=>process.exit(1))' "$PORT" 2>/dev/null; then return 0; fi
    sleep 0.2
  done
  return 1
}
stop_stub() { [[ -n "${STUB_PID:-}" ]] && kill "$STUB_PID" 2>/dev/null; STUB_PID=""; }

# Emit a liveness event through the REAL wire-in (appendLivenessEvent), inheriting the caller's env.
emit_event() {
  local root="$1" evt_json="$2"
  node -e 'const {appendLivenessEvent}=require(process.argv[1]);appendLivenessEvent(process.argv[2], JSON.parse(process.argv[3]));' \
    "$ROOT/scripts/hooks/lib/liveness-write.js" "$root" "$evt_json"
}

# Poll the stub's received file for at least one POST (the relay is detached/async).
wait_for_post() { for _ in $(seq 1 25); do [[ -s "$RECV" ]] && return 0; sleep 0.2; done; return 1; }

ENDPOINT="http://127.0.0.1:${PORT}/records"

echo "=== console liveness relay (#295) ==="

# ─── 1. Relay ON + configured: POST a kontour.console.liveness record with auth ────────────────
echo "--- 1. relay on+configured: liveness emit mirrors to the Console with Bearer + tenant ---"
: > "$RECV"; start_stub ok || { fail "stub server did not start"; }
ROOT_A="$TMPDIR_EVAL/a"
EVT1='{"type":"claim","subjectId":"relay-subj-1","actor":"claude-code:sessA:host","actor_key":"claude-code:sessA:host","at":"2026-07-05T00:00:00Z","ttlSeconds":1800,"host":"host","branch":"agent/a/relay-subj-1","artifact_dir":"relay-subj-1"}'
(
  export FLOW_AGENTS_CONSOLE_LIVENESS_RELAY=1
  export FLOW_AGENTS_CONSOLE_LIVENESS_ENDPOINT_URL="$ENDPOINT"
  export CONSOLE_TELEMETRY_TOKEN="tok-abc123"
  export CONSOLE_TENANT_ID="tenant-1"
  emit_event "$ROOT_A" "$EVT1"
)
[[ -s "$ROOT_A/liveness/events.jsonl" ]] && pass "local liveness/events.jsonl written (local-first)" || fail "local liveness write did not happen"
if wait_for_post; then pass "relay POSTed to the Console endpoint"; else fail "relay did NOT POST within timeout"; fi
node -e '
const fs=require("fs"); const raw=fs.readFileSync(process.argv[1],"utf8").trim();
if(!raw){console.log("NO_POST");process.exit(0)}
const r=JSON.parse(raw.split("\n")[0]); const b=JSON.parse(r.body);
const checks=[
  ["method POST", r.method==="POST"],
  ["content-type json", (r.headers["content-type"]||"").includes("application/json")],
  ["authorization bearer", r.headers["authorization"]==="Bearer tok-abc123"],
  ["tenant header", r.headers["x-console-tenant-id"]==="tenant-1"],
  ["schema kontour.console.liveness", b.schema==="kontour.console.liveness"],
  ["version 0.1", b.version==="0.1"],
  ["type claim", b.type==="claim"],
  ["subjectId", b.subjectId==="relay-subj-1"],
  ["actor", b.actor==="claude-code:sessA:host"],
  ["branch", b.branch==="agent/a/relay-subj-1"],
];
for(const [name,ok] of checks) console.log((ok?"OK ":"BAD ")+name);
' "$RECV" > "$TMPDIR_EVAL/checks.txt" 2>&1
while IFS= read -r line; do
  [[ "$line" == OK* ]] && pass "record ${line#OK }" || fail "record ${line#BAD } — $(cat "$TMPDIR_EVAL/checks.txt")"
done < <(grep -E '^(OK|BAD) ' "$TMPDIR_EVAL/checks.txt")
stop_stub

# ─── 2. Relay OFF (no flag): local write happens, NO POST (local-first) ────────────────────────
echo "--- 2. relay OFF: local write still happens, nothing is POSTed ---"
: > "$RECV"; start_stub ok
ROOT_B="$TMPDIR_EVAL/b"
( export FLOW_AGENTS_CONSOLE_LIVENESS_ENDPOINT_URL="$ENDPOINT"; unset FLOW_AGENTS_CONSOLE_LIVENESS_RELAY; emit_event "$ROOT_B" '{"type":"claim","subjectId":"off-1","actor":"a","at":"t"}' )
sleep 1
[[ -s "$ROOT_B/liveness/events.jsonl" ]] && pass "local write happened with relay OFF" || fail "local write missing with relay OFF"
[[ ! -s "$RECV" ]] && pass "NO POST when the relay flag is off (opt-in respected)" || fail "a POST happened with the relay off"
stop_stub

# ─── 3. Relay ON but NO endpoint configured: no-op, local write intact ──────────────────────────
echo "--- 3. relay on but unconfigured (no endpoint): no-op, local write intact ---"
: > "$RECV"; start_stub ok
ROOT_C="$TMPDIR_EVAL/c"
( export FLOW_AGENTS_CONSOLE_LIVENESS_RELAY=1; unset FLOW_AGENTS_CONSOLE_LIVENESS_ENDPOINT_URL FLOW_AGENTS_CONSOLE_URL CONSOLE_TELEMETRY_URL CONSOLE_URL; emit_event "$ROOT_C" '{"type":"claim","subjectId":"noep-1","actor":"a","at":"t"}' )
sleep 1
[[ -s "$ROOT_C/liveness/events.jsonl" ]] && pass "local write happened with no endpoint configured" || fail "local write missing with no endpoint"
[[ ! -s "$RECV" ]] && pass "NO POST when no console endpoint is configured (no-op)" || fail "a POST happened with no endpoint configured"
stop_stub

# ─── 4. Relay FAILURE (endpoint returns 500): local emit still succeeds, non-fatal ─────────────
echo "--- 4. relay failure (endpoint 500 / detached): local emit exit unaffected ---"
: > "$RECV"; start_stub fail
ROOT_D="$TMPDIR_EVAL/d"
(
  export FLOW_AGENTS_CONSOLE_LIVENESS_RELAY=1
  export FLOW_AGENTS_CONSOLE_LIVENESS_ENDPOINT_URL="$ENDPOINT"
  emit_event "$ROOT_D" '{"type":"heartbeat","subjectId":"fail-1","actor":"a","at":"t"}'
)
rc=$?
[[ "$rc" -eq 0 ]] && pass "liveness emit exits 0 even when the relay endpoint fails (non-fatal)" || fail "liveness emit exited non-zero ($rc) on relay failure"
[[ -s "$ROOT_D/liveness/events.jsonl" ]] && pass "local write happened despite relay 500 (local-first)" || fail "local write missing on relay failure"
stop_stub

# ─── 5. Injection: a hostile actor/branch is JSON-escaped, never raw in the POST body ──────────
echo "--- 5. injection: hostile control bytes in actor/branch are escaped, not raw ---"
: > "$RECV"; start_stub ok
ROOT_E="$TMPDIR_EVAL/e"
# Build the hostile event in node (embed ESC 0x1b + BEL 0x07) so no control bytes enter the shell.
HOSTILE_EVT="$(node -e 'const esc=String.fromCharCode(27),bel=String.fromCharCode(7);process.stdout.write(JSON.stringify({type:"claim",subjectId:"inj-1",actor:"actor"+esc+"[31m"+bel+"EVIL",at:"t",branch:"agent/"+esc+"x/inj-1"}))')"
(
  export FLOW_AGENTS_CONSOLE_LIVENESS_RELAY=1
  export FLOW_AGENTS_CONSOLE_LIVENESS_ENDPOINT_URL="$ENDPOINT"
  emit_event "$ROOT_E" "$HOSTILE_EVT"
)
wait_for_post || true
node -e '
const fs=require("fs"); const raw=fs.readFileSync(process.argv[1],"utf8").trim();
if(!raw){console.log("NO_POST");process.exit(0)}
const body=JSON.parse(raw.split("\n")[0]).body;
const hasRawCtl=/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(body);
console.log(hasRawCtl?"RAW":"ESCAPED");
' "$RECV" > "$TMPDIR_EVAL/inj.txt" 2>&1
if grep -q ESCAPED "$TMPDIR_EVAL/inj.txt"; then pass "hostile actor/branch control bytes are JSON-escaped, never raw in the POST body (injection discipline)"; else fail "raw control bytes reached the POST body: $(cat "$TMPDIR_EVAL/inj.txt")"; fi
stop_stub

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "test_liveness_console_relay: all checks passed."
  exit 0
else
  echo "test_liveness_console_relay: $errors check(s) failed."
  exit 1
fi
