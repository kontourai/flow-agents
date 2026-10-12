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
cleanup() { stop_stub; rm -rf "$TMPDIR_EVAL"; }
trap cleanup EXIT

# Hermetic HOME: the conf-driven relay resolver (#567) reads ~/.flow-agents/telemetry-console.conf
# as a resolution slot. Point HOME at an empty dir so these tests never read the running machine's
# real console conf — enablement here is controlled only by the env flag / an explicit
# TELEMETRY_CONFIG_FILE, exactly as each case sets up.
export HOME="$TMPDIR_EVAL/clean-home"
mkdir -p "$HOME"
PORT=0
STUB_GENERATION=0
USED_PORTS=""
RECV="$TMPDIR_EVAL/recv.jsonl"

errors=0
pass() { echo "  [PASS] $1"; }
fail() { echo "  [FAIL] $1"; errors=$((errors + 1)); }

# Stub Console endpoint: append each received {method, headers, body} as one JSON line. `mode` env
# controls the response — "ok" (200) or "fail" (500) — to exercise the relay-failure path.
start_stub() {
  local mode="$1"
  STUB_GENERATION=$((STUB_GENERATION + 1))
  RECV="$TMPDIR_EVAL/recv-${STUB_GENERATION}.jsonl"
  local ready="$TMPDIR_EVAL/stub-${STUB_GENERATION}.ready.json"
  local log="$TMPDIR_EVAL/stub-${STUB_GENERATION}.log"
  : > "$RECV"
  # The bound child publishes its own PID+OS-assigned port. A TCP probe of a
  # fixed port can accept another listener even after our child failed to bind.
  # Never reuse a prior case port: detached late deliveries remain isolated.
  STUB_MODE="$mode" node -e '
const http=require("http"),fs=require("fs");
const out=process.argv[1], ready=process.argv[2], used=new Set(process.argv[3].split(",").filter(Boolean).map(Number)),mode=process.env.STUB_MODE||"ok";
const s=http.createServer((req,res)=>{let b="";req.on("data",d=>b+=d);req.on("end",()=>{
  res.on("finish",()=>fs.appendFileSync(out,JSON.stringify({method:req.method,headers:req.headers,body:b,response_status:res.statusCode})+"\n"));
  res.writeHead(mode==="fail"?500:200);res.end(mode==="fail"?"err":"ok");
});});
s.on("error",error=>{console.error(error);process.exit(1)});
let attempts=0;
function bind(){if(++attempts>32)throw new Error("Could not allocate a distinct fixture port");s.listen(0,"127.0.0.1",()=>{const port=s.address().port;if(used.has(port)){s.close(bind);return;}fs.writeFileSync(ready,JSON.stringify({pid:process.pid,port}));});}
bind();process.on("SIGTERM",()=>s.close(()=>process.exit(0)));
setTimeout(()=>process.exit(0),30000);
' "$RECV" "$ready" "$USED_PORTS" >"$log" 2>&1 &
  STUB_PID=$!
  for _ in $(seq 1 20); do
    if [[ -s "$ready" ]] && kill -0 "$STUB_PID" 2>/dev/null; then
      PORT="$(node -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(r.pid!==Number(process.argv[2])||!Number.isInteger(r.port)||r.port<=0||r.port>65535)process.exit(1);process.stdout.write(String(r.port));' "$ready" "$STUB_PID")" || continue
      USED_PORTS="${USED_PORTS:+$USED_PORTS,}$PORT"
      ENDPOINT="http://127.0.0.1:${PORT}/records"
      return 0
    fi
    sleep 0.2
  done
  fail "owned stub did not bind: $(cat "$log")"
  stop_stub
  return 1
}
stop_stub() {
  if [[ -n "${STUB_PID:-}" ]]; then
    kill "$STUB_PID" 2>/dev/null || true
    wait "$STUB_PID" 2>/dev/null || true
  fi
  STUB_PID=""
}

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
EVT1='{"type":"claim","subjectId":"relay-subj-1","actor":"claude-code:sessA:host","actor_key":"claude-code:sessA:host","at":"2026-07-05T00:00:00Z","ttlSeconds":1800,"host":"host","branch":"agent/a/relay-subj-1","artifact_dir":"relay-subj-1","source":"tool-activity","activity":{"tool":"Bash"}}'
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
  ["source tool-activity", b.source==="tool-activity"],
  ["activity.tool Bash (richer real-liveness rides to the Console)", !!b.activity && b.activity.tool==="Bash"],
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
[[ -s "$ROOT_D/liveness/events.jsonl" ]] && pass "local write happened before the detached relay result (local-first)" || fail "local write missing on relay failure"
if wait_for_post && node -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8").trim().split("\n")[0]);if(r.response_status!==500||JSON.parse(r.body).subjectId!=="fail-1")process.exit(1);' "$RECV"; then
  pass "the owned failing endpoint received this relay and completed its HTTP 500 response"
else
  fail "HTTP 500 relay was not observed before fixture shutdown"
fi
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
if wait_for_post; then
node -e '
const fs=require("fs"); const raw=fs.readFileSync(process.argv[1],"utf8").trim();
if(!raw){console.log("NO_POST");process.exit(0)}
const body=JSON.parse(raw.split("\n")[0]).body;
const hasRawCtl=/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(body);
const expected=JSON.parse(process.argv[2]);
let actual;try{actual=JSON.parse(body)}catch{console.log("INVALID_JSON");process.exit(0)}
const matches=actual.subjectId==="inj-1"&&actual.actor===expected.actor&&actual.branch===expected.branch;
console.log(hasRawCtl?"RAW":matches?"ESCAPED":"MISMATCHED_POST");
' "$RECV" "$HOSTILE_EVT" > "$TMPDIR_EVAL/inj.txt" 2>&1
if grep -q ESCAPED "$TMPDIR_EVAL/inj.txt"; then pass "hostile actor/branch control bytes are JSON-escaped, never raw in the POST body (injection discipline)"; else fail "hostile payload escaping or correlation failed: $(cat "$TMPDIR_EVAL/inj.txt")"; fi
else
  fail "NO_POST: hostile payload delivery was not observed; escaping is NOT_VERIFIED"
fi
stop_stub

# ─── 6. CONF-DRIVEN enablement (#567): NO env flag, `console_liveness_relay=1` in the conf → POST ─
echo "--- 6. conf-driven (#567): console_liveness_relay=1 in the conf relays with NO env var ---"
: > "$RECV"; start_stub ok
ROOT_F="$TMPDIR_EVAL/f"
CONF6="$TMPDIR_EVAL/conf6.conf"
printf 'console_telemetry_url=https://example.invalid\nconsole_liveness_relay=1\n' > "$CONF6"
(
  unset FLOW_AGENTS_CONSOLE_LIVENESS_RELAY   # the whole point: no env var
  export TELEMETRY_CONFIG_FILE="$CONF6"
  export FLOW_AGENTS_CONSOLE_LIVENESS_ENDPOINT_URL="$ENDPOINT"   # POST target (stub)
  emit_event "$ROOT_F" '{"type":"claim","subjectId":"conf-on-1","actor":"a","at":"t"}'
)
[[ -s "$ROOT_F/liveness/events.jsonl" ]] && pass "local write happened (conf-driven case)" || fail "local write missing (conf-driven)"
if wait_for_post; then pass "conf-driven relay POSTed with NO env var (console_liveness_relay=1)"; else fail "conf-driven relay did NOT POST (env-var-free enablement broken)"; fi
stop_stub

# ─── 7. CONF-DRIVEN auto-on parity (#469): a console url with no explicit key defaults ON ────────
echo "--- 7. conf-driven auto-on: a console url with no explicit key relays; explicit =0 suppresses ---"
: > "$RECV"; start_stub ok
ROOT_G="$TMPDIR_EVAL/g"
CONF7="$TMPDIR_EVAL/conf7.conf"
printf 'console_telemetry_url=https://example.invalid\n' > "$CONF7"   # url only, no explicit key
(
  unset FLOW_AGENTS_CONSOLE_LIVENESS_RELAY
  export TELEMETRY_CONFIG_FILE="$CONF7"
  export FLOW_AGENTS_CONSOLE_LIVENESS_ENDPOINT_URL="$ENDPOINT"
  emit_event "$ROOT_G" '{"type":"claim","subjectId":"auto-on-1","actor":"a","at":"t"}'
)
if wait_for_post; then pass "auto-on: a configured console url defaults the relay ON (#469 parity)"; else fail "auto-on did NOT POST (console-url default-on broken)"; fi
stop_stub

: > "$RECV"; start_stub ok
ROOT_H="$TMPDIR_EVAL/h"
CONF8="$TMPDIR_EVAL/conf8.conf"
printf 'console_telemetry_url=https://example.invalid\nconsole_liveness_relay=0\n' > "$CONF8"   # explicit off wins
(
  unset FLOW_AGENTS_CONSOLE_LIVENESS_RELAY
  export TELEMETRY_CONFIG_FILE="$CONF8"
  export FLOW_AGENTS_CONSOLE_LIVENESS_ENDPOINT_URL="$ENDPOINT"
  emit_event "$ROOT_H" '{"type":"claim","subjectId":"conf-off-1","actor":"a","at":"t"}'
)
sleep 1
[[ -s "$ROOT_H/liveness/events.jsonl" ]] && pass "local write happened (explicit conf off)" || fail "local write missing (explicit conf off)"
[[ ! -s "$RECV" ]] && pass "explicit console_liveness_relay=0 suppresses the relay even with a url (opt-out wins)" || fail "a POST happened despite console_liveness_relay=0"
stop_stub

# ─── 8. EXFIL DEFENSE: an UNTRUSTED (mode 644) default-path conf must NOT relay (trust gate) ─────
# The cases above drive enablement through TELEMETRY_CONFIG_FILE, which is trusted BY DESIGN (an
# explicit env override bypasses the mode-600 gate). This case exercises the actual supply-chain
# defense end-to-end: a conf planted at the user-global default slot (~/.flow-agents/…, reached via
# the hermetic HOME set at the top) pointing at an attacker stub with console_liveness_relay=1, but
# mode 644 — exactly what a non-operator drop (clone/tarball/local tool) can produce, since git can
# only ship 644/755, never 600. relay.sh re-sources config.sh, whose telemetry_conf_trusted gate
# (mode 600 + owner + not-a-symlink) rejects it, so no URL resolves and nothing is POSTed — while
# the durable local write still happens. NO env flag, NO TELEMETRY_CONFIG_FILE, NO endpoint env:
# the untrusted conf is the ONLY possible signal, so a POST here would be a real exfil regression.
echo "--- 8. exfil defense: an untrusted (mode 644) ~/.flow-agents conf with an attacker url never relays ---"
: > "$RECV"; start_stub ok
ROOT_X="$TMPDIR_EVAL/x"
mkdir -p "$HOME/.flow-agents"
UNTRUSTED_CONF="$HOME/.flow-agents/telemetry-console.conf"
printf 'console_telemetry_url=http://127.0.0.1:%s\nconsole_liveness_relay=1\n' "$PORT" > "$UNTRUSTED_CONF"
chmod 644 "$UNTRUSTED_CONF"
(
  unset FLOW_AGENTS_CONSOLE_LIVENESS_RELAY
  unset TELEMETRY_CONFIG_FILE
  unset FLOW_AGENTS_CONSOLE_LIVENESS_ENDPOINT_URL
  emit_event "$ROOT_X" '{"type":"claim","subjectId":"exfil-x","actor":"a","at":"t"}'
)
sleep 1
[[ -s "$ROOT_X/liveness/events.jsonl" ]] && pass "local write happened (untrusted-conf case, local-first intact)" || fail "local write missing (untrusted conf)"
[[ ! -s "$RECV" ]] && pass "an untrusted (644) default-path conf naming an attacker url NEVER relays (trust gate holds, no exfil)" || fail "EXFIL: a POST reached the attacker stub from an untrusted 644 conf"
rm -f "$UNTRUSTED_CONF"
stop_stub

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "test_liveness_console_relay: all checks passed."
  exit 0
else
  echo "test_liveness_console_relay: $errors check(s) failed."
  exit 1
fi
