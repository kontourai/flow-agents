#!/usr/bin/env bash
# test_console_tenant_isolation.sh — multi-tenant install proof (console epic fa#410 item #5).
#
# Closes the gap that `test_telemetry.sh` §7 (fake-curl capture) and
# `test_liveness_console_relay.sh` (real HTTP stub) leave open: both already prove
# single-tenant header injection, but neither proves that TWO DISTINCT tenants, each installed
# through the REAL config-writer path (`install-console-config.sh` -> `telemetry.conf` ->
# `config.sh` -> `transport.sh`), get correctly separated `x-console-tenant-id` /
# `Authorization: Bearer` headers on the wire with no cross-tenant leakage.
#
# IMPORTANT SCOPE BOUNDARY: this eval proves the CLIENT-SIDE WIRE CONTRACT only — that a
# correctly configured tenant-a install and a correctly configured tenant-b install each send
# their own (and never each other's) tenant/token headers to the network layer. It does NOT
# prove server-side Console tenant enforcement (that a token cannot be replayed against another
# tenant's data, that a misconfigured/malicious client can't spoof a tenant header, etc.) — that
# is Console-repo scope (console #98-#100 tenant hardening). Do not read a green run here as
# proof of end-to-end multi-tenant security.
#
# Deterministic (a local stub HTTP server, no network/model spend, self-cleaning). The Console
# POST fires in a detached/backgrounded subshell (transport.sh's console_post_json), so the
# stub-received assertions poll for the captured file rather than assuming synchronous delivery
# (mirrors test_liveness_console_relay.sh's wait_for_post).
# Usage: bash evals/integration/test_console_tenant_isolation.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

TMPDIR_EVAL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_EVAL"; [[ -n "${STUB_PID:-}" ]] && kill "$STUB_PID" 2>/dev/null' EXIT
PORT=38796
RECV="$TMPDIR_EVAL/recv.jsonl"

errors=0
pass() { echo "  [PASS] $1"; }
fail() { echo "  [FAIL] $1"; errors=$((errors + 1)); }

# Stub Console endpoint: append each received {method, headers, body} as one JSON line, shared
# across both tenant phases so the isolation assertions can positively confirm no cross-tenant
# header leaked into the OTHER tenant's captured request (not just that each phase's own header
# is correct in isolation).
start_stub() {
  node -e '
const http=require("http"),fs=require("fs");
const out=process.argv[1];
const s=http.createServer((req,res)=>{let b="";req.on("data",d=>b+=d);req.on("end",()=>{
  fs.appendFileSync(out, JSON.stringify({method:req.method,headers:req.headers,body:b})+"\n");
  res.writeHead(200); res.end("ok");
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

# Poll the stub's received file for at least N lines (the POST is detached/async).
wait_for_lines() {
  local n="$1" lines
  for _ in $(seq 1 25); do
    lines="$(wc -l <"$RECV" 2>/dev/null | tr -d ' ')"
    [[ -n "$lines" && "$lines" -ge "$n" ]] && return 0
    sleep 0.2
  done
  return 1
}

ENDPOINT="http://127.0.0.1:${PORT}/records"

# Install a tenant's real telemetry.conf via the REAL config writer, then emit one synthetic
# event through the REAL runtime path (config.sh's conf-key-to-env mapping, exercised by
# sourcing it, followed by transport.sh's console_telemetry_emit) — not a re-implementation of
# either.
install_and_emit() {
  local tenant="$1" token_value="$2"
  local work="$TMPDIR_EVAL/$tenant"
  mkdir -p "$work"
  local conf="$work/telemetry.conf"
  local token_file="$work/token"
  printf '%s' "$token_value" >"$token_file"

  bash "$ROOT/scripts/telemetry/install-console-config.sh" "$conf" \
    --console-endpoint "$ENDPOINT" \
    --console-token-file "$token_file" \
    --console-tenant "$tenant" >/dev/null

  (
    export TELEMETRY_CONFIG_FILE="$conf"
    export TELEMETRY_DATA_DIR="$work/data"
    export TELEMETRY_SESSION_DIR="$work/data/sessions"
    unset TELEMETRY_DIR
    source "$ROOT/scripts/telemetry/lib/config.sh"
    source "$ROOT/scripts/telemetry/lib/transport.sh"
    console_telemetry_emit '{"type":"test","note":"tenant-isolation-eval"}'
  )
}

# Assert the Nth captured request (1-indexed) carries this tenant's own headers and never the
# other tenant's tenant-id/token — the actual "no cross-tenant leakage" proof.
check_capture() {
  local line_no="$1" label="$2" own_tenant="$3" own_token="$4" other_tenant="$5" other_token="$6"
  node -e '
const fs = require("fs");
const [recvPath, lineNoStr, ownTenant, ownToken, otherTenant, otherToken] = process.argv.slice(1);
const lineNo = Number(lineNoStr);
const lines = fs.readFileSync(recvPath, "utf8").trim().split("\n");
if (lines.length < lineNo) { console.log("BAD missing-captured-request"); process.exit(0); }
const r = JSON.parse(lines[lineNo - 1]);
const h = r.headers || {};
const raw = JSON.stringify(r);
const checks = [
  ["method-post", r.method === "POST"],
  ["own-tenant-header", h["x-console-tenant-id"] === ownTenant],
  ["own-auth-header", h["authorization"] === ("Bearer " + ownToken)],
  ["no-other-tenant-id-in-header", h["x-console-tenant-id"] !== otherTenant],
  ["no-other-token-in-header", h["authorization"] !== ("Bearer " + otherToken)],
  ["no-other-tenant-id-anywhere", !raw.includes(otherTenant)],
  ["no-other-token-anywhere", !raw.includes(otherToken)],
];
for (const [name, ok] of checks) console.log((ok ? "OK " : "BAD ") + name);
' "$RECV" "$line_no" "$own_tenant" "$own_token" "$other_tenant" "$other_token" >"$TMPDIR_EVAL/checks-$line_no.txt" 2>&1
  while IFS= read -r line; do
    [[ "$line" == OK* ]] && pass "$label: ${line#OK }" || fail "$label: ${line#BAD } — $(cat "$TMPDIR_EVAL/checks-$line_no.txt")"
  done < <(grep -E '^(OK|BAD) ' "$TMPDIR_EVAL/checks-$line_no.txt")
}

echo "=== console tenant isolation (multi-tenant install proof, fa#410 item #5) ==="

: >"$RECV"
start_stub || fail "stub server did not start"

TOKEN_A="tok-a-alnum-111"
TOKEN_B="tok-b-alnum-222"

# ─── Phase 1 (tenant-a): install + emit, assert its own headers ────────────────────────────────
echo "--- 1. tenant-a: real install-console-config.sh writes telemetry.conf; emit carries tenant-a headers ---"
install_and_emit "tenant-a" "$TOKEN_A"
if wait_for_lines 1; then pass "tenant-a event POSTed to the stub"; else fail "tenant-a event did NOT POST within timeout"; fi
check_capture 1 "tenant-a" "tenant-a" "$TOKEN_A" "tenant-b" "$TOKEN_B"

# ─── Phase 2 (tenant-b): fresh conf + distinct token, assert its own headers ───────────────────
echo "--- 2. tenant-b: fresh conf + distinct token; emit carries tenant-b headers ---"
install_and_emit "tenant-b" "$TOKEN_B"
if wait_for_lines 2; then pass "tenant-b event POSTed to the stub"; else fail "tenant-b event did NOT POST within timeout"; fi
check_capture 2 "tenant-b" "tenant-b" "$TOKEN_B" "tenant-a" "$TOKEN_A"

# ─── Isolation: re-check phase 1's record after phase 2 ran, to catch any late cross-write ─────
echo "--- 3. isolation: tenant-a's captured request still never carries tenant-b's values (and vice versa, above) ---"
check_capture 1 "tenant-a (post phase-2 recheck)" "tenant-a" "$TOKEN_A" "tenant-b" "$TOKEN_B"

stop_stub

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "test_console_tenant_isolation: all checks passed."
  exit 0
else
  echo "test_console_tenant_isolation: $errors check(s) failed."
  exit 1
fi
