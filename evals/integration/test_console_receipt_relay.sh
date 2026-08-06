#!/usr/bin/env bash
# test_console_receipt_relay.sh — console receipt relay (#1087 slice B).
#
# Proves a recorded receipt is mirrored to the Console as a
# `kontour.console.event` on the AT-LEAST-ONCE class, and that the relay is a
# silent no-op when no console is configured.
#
# ISOLATION MATTERS HERE, and a hermetic HOME alone is NOT enough. config.sh
# resolves a per-workspace `.kontourai/telemetry-console.conf` before the
# user-global one, and this repo has such a file carrying the real production
# endpoint and token — so a test that only stubs HOME will happily aim a
# synthetic receipt at production Console. (Observed while developing this
# slice; the record did not land, but it could have.) Every case below pins
# TELEMETRY_CONFIG_FILE, which config.sh honours ahead of both.
#
# Deterministic: a local stub HTTP server, no network or model spend.
# Usage: bash evals/integration/test_console_receipt_relay.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RELAY="$ROOT/scripts/console/receipt-relay.sh"

TMPDIR_EVAL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_EVAL"; [[ -n "${STUB_PID:-}" ]] && kill "$STUB_PID" 2>/dev/null' EXIT

export HOME="$TMPDIR_EVAL/clean-home"
mkdir -p "$HOME"

PORT=38821
RECV="$TMPDIR_EVAL/recv.jsonl"
: > "$RECV"

export TELEMETRY_DATA_DIR="$TMPDIR_EVAL/data"
export TELEMETRY_SESSION_DIR="$TMPDIR_EVAL/session"
mkdir -p "$TELEMETRY_DATA_DIR" "$TELEMETRY_SESSION_DIR"

PASS=0
FAIL=0
check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    printf '  ✓ %s\n' "$label"; PASS=$((PASS + 1))
  else
    printf '  ✗ %s (expected %s, got %s)\n' "$label" "$expected" "$actual"; FAIL=$((FAIL + 1))
  fi
}

start_stub() {
  node -e '
    const fs = require("node:fs");
    const http = require("node:http");
    const out = process.argv[1];
    http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", () => {
        // POST only: the readiness probe below is a GET and would otherwise
        // inflate every delivered-count assertion by one.
        if (req.method === "POST") fs.appendFileSync(out, body + "\n");
        res.writeHead(202, { "content-type": "application/json" });
        res.end("{}");
      });
    }).listen(Number(process.argv[2]), "127.0.0.1");
  ' "$RECV" "$PORT" &
  STUB_PID=$!
  for _ in $(seq 1 40); do
    curl -s -o /dev/null "http://127.0.0.1:$PORT/" && return 0
    sleep 0.1
  done
  return 1
}

# A conf pointing at the local stub — never the machine's real console.
CONF_CONFIGURED="$TMPDIR_EVAL/configured.conf"
cat > "$CONF_CONFIGURED" <<CONF
enabled=true
console_telemetry_url=http://127.0.0.1:$PORT
console_telemetry_token=test-token
console_tenant_id=test-tenant
CONF
chmod 600 "$CONF_CONFIGURED"

# A conf with no console at all.
CONF_UNCONFIGURED="$TMPDIR_EVAL/unconfigured.conf"
printf 'enabled=true\n' > "$CONF_UNCONFIGURED"
chmod 600 "$CONF_UNCONFIGURED"

RECEIPT='{"session":"sess-1","kind":"gate-claim","revision":"7","summary":"tests-evidence"}'

printf 'console receipt relay\n'

# ── No console configured ⇒ silent no-op, and nothing queued ────────────────
TELEMETRY_CONFIG_FILE="$CONF_UNCONFIGURED" bash "$RELAY" "$RECEIPT"
check "exits 0 with no console configured" "0" "$?"
check "queues nothing when unconfigured" "0" \
  "$([[ -f "$TELEMETRY_DATA_DIR/console-outbox/pending.jsonl" ]] && wc -l < "$TELEMETRY_DATA_DIR/console-outbox/pending.jsonl" | tr -d ' ' || echo 0)"

# ── Malformed input is refused, not queued ──────────────────────────────────
TELEMETRY_CONFIG_FILE="$CONF_CONFIGURED" bash "$RELAY" 'not-json'
check "refuses a non-JSON receipt" "0" \
  "$([[ -f "$TELEMETRY_DATA_DIR/console-outbox/pending.jsonl" ]] && wc -l < "$TELEMETRY_DATA_DIR/console-outbox/pending.jsonl" | tr -d ' ' || echo 0)"

TELEMETRY_CONFIG_FILE="$CONF_CONFIGURED" bash "$RELAY" '{"kind":"gate-claim"}'
check "refuses a receipt missing session/revision" "0" \
  "$([[ -f "$TELEMETRY_DATA_DIR/console-outbox/pending.jsonl" ]] && wc -l < "$TELEMETRY_DATA_DIR/console-outbox/pending.jsonl" | tr -d ' ' || echo 0)"

# ── Configured + hub reachable ⇒ delivered as a console event ────────────────
start_stub || { printf 'stub failed to start\n'; exit 1; }
TELEMETRY_CONFIG_FILE="$CONF_CONFIGURED" bash "$RELAY" "$RECEIPT"
for _ in $(seq 1 50); do
  [[ "$(wc -l < "$RECV" | tr -d ' ')" -ge 1 ]] && break
  sleep 0.1
done
check "delivers the receipt" "1" "$(wc -l < "$RECV" | tr -d ' ')"

BODY="$(head -1 "$RECV")"
check "as a kontour.console.event" "kontour.console.event" \
  "$(printf '%s' "$BODY" | node -e 'let r="";process.stdin.on("data",d=>r+=d).on("end",()=>{try{process.stdout.write(JSON.parse(r).schema)}catch{}})')"
check "typed by receipt kind" "workflow.receipt.gate-claim" \
  "$(printf '%s' "$BODY" | node -e 'let r="";process.stdin.on("data",d=>r+=d).on("end",()=>{try{process.stdout.write(JSON.parse(r).type)}catch{}})')"
check "with a content-derived id so retries upsert" "receipt:sess-1:gate-claim:7" \
  "$(printf '%s' "$BODY" | node -e 'let r="";process.stdin.on("data",d=>r+=d).on("end",()=>{try{process.stdout.write(JSON.parse(r).id)}catch{}})')"
check "subject is the workflow session" "sess-1" \
  "$(printf '%s' "$BODY" | node -e 'let r="";process.stdin.on("data",d=>r+=d).on("end",()=>{try{process.stdout.write(JSON.parse(r).subject.id)}catch{}})')"
check "carries no token in the body" "0" "$(printf '%s' "$BODY" | grep -c 'test-token')"

# ── On the durable class: an outage queues rather than drops ─────────────────
kill "$STUB_PID" 2>/dev/null; wait "$STUB_PID" 2>/dev/null; STUB_PID=""
rm -rf "$TELEMETRY_DATA_DIR/console-outbox"
TELEMETRY_CONFIG_FILE="$CONF_CONFIGURED" bash "$RELAY" \
  '{"session":"sess-2","kind":"critique","revision":"1"}'
for _ in $(seq 1 30); do
  [[ -f "$TELEMETRY_DATA_DIR/console-outbox/pending.jsonl" ]] && break
  sleep 0.1
done
check "a receipt sent during an outage is queued, not lost" "1" \
  "$([[ -f "$TELEMETRY_DATA_DIR/console-outbox/pending.jsonl" ]] && wc -l < "$TELEMETRY_DATA_DIR/console-outbox/pending.jsonl" | tr -d ' ' || echo 0)"

printf '\nResults: %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
