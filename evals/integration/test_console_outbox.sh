#!/usr/bin/env bash
# test_console_outbox.sh — at-least-once console delivery (#1087 slice A).
#
# Proves the durability property the `console-record-delivery` decision requires
# for receipts, and that the best-effort core is unchanged for everything else.
#
# The case that matters is the one the old projection-file scrape got right by
# accident: a record enqueued while the hub is unreachable must survive and be
# delivered by a LATER flush. Live emission that drops on a network blip is
# strictly worse than the scrape it replaces, because it leaves no artifact to
# replay from and the loss is silent.
#
# Deterministic: a local stub HTTP server, no network or model spend,
# self-cleaning.
# Usage: bash evals/integration/test_console_outbox.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

TMPDIR_EVAL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_EVAL"; [[ -n "${STUB_PID:-}" ]] && kill "$STUB_PID" 2>/dev/null' EXIT

# Hermetic HOME so the resolver never reads the running machine's real console
# conf — this suite controls configuration explicitly.
export HOME="$TMPDIR_EVAL/clean-home"
mkdir -p "$HOME"

PORT=38811
RECV="$TMPDIR_EVAL/recv.jsonl"
: > "$RECV"

export TELEMETRY_DATA_DIR="$TMPDIR_EVAL/data"
export TELEMETRY_SESSION_DIR="$TMPDIR_EVAL/session"
mkdir -p "$TELEMETRY_DATA_DIR" "$TELEMETRY_SESSION_DIR"

# transport.sh sources its siblings via TELEMETRY_DIR, so set it before sourcing.
export TELEMETRY_DIR="$ROOT/scripts/telemetry"
# shellcheck source=/dev/null
source "$ROOT/scripts/telemetry/lib/transport.sh"

PASS=0
FAIL=0
check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    printf '  ✓ %s\n' "$label"
    PASS=$((PASS + 1))
  else
    printf '  ✗ %s (expected %s, got %s)\n' "$label" "$expected" "$actual"
    FAIL=$((FAIL + 1))
  fi
}

start_stub() {
  # Guard against double-binding: a leftover stub makes the next listen fail
  # with EADDRINUSE and the failure surfaces far from its cause.
  [[ -n "${STUB_PID:-}" ]] && return 0
  node -e '
    const fs = require("node:fs");
    const http = require("node:http");
    const out = process.argv[1];
    http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", () => {
        // Only POSTs are recorded: the readiness probe below is a GET, and
        // logging it would inflate every delivered-count assertion by one.
        if (req.method === "POST") fs.appendFileSync(out, body + "\n");
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "persisted" }));
      });
    }).listen(Number(process.argv[2]), "127.0.0.1");
  ' "$RECV" "$PORT" &
  STUB_PID=$!
  for _ in $(seq 1 40); do
    curl -s -o /dev/null "http://127.0.0.1:$PORT/records" && return 0
    sleep 0.1
  done
  return 1
}

stop_stub() {
  [[ -n "${STUB_PID:-}" ]] && kill "$STUB_PID" 2>/dev/null
  wait "$STUB_PID" 2>/dev/null
  STUB_PID=""
}

ENDPOINT="http://127.0.0.1:$PORT/records"

printf 'console outbox — at-least-once delivery\n'

# ── The core property: enqueued while unreachable, delivered later ──────────
# No stub is listening yet, so this send must fail and the record must persist.
console_outbox_enqueue "$ENDPOINT" '{"schema":"kontour.console.event","id":"rec-1"}' "rec-1"
check "record is durable before any send is attempted" "1" "$(console_outbox_pending_count)"

console_outbox_flush
check "stays pending when the hub is unreachable" "1" "$(console_outbox_pending_count)"
check "is not given up on after one failure" "0" "$(console_outbox_undelivered_count)"

start_stub || { printf 'stub failed to start\n'; exit 1; }
console_outbox_flush
check "a later flush delivers the record the outage dropped" "1" "$(wc -l < "$RECV" | tr -d ' ')"
check "and clears it from pending" "0" "$(console_outbox_pending_count)"

# ── No double-send: a delivered record is gone, so re-flushing sends nothing ──
console_outbox_flush
check "re-flushing does not resend a delivered record" "1" "$(wc -l < "$RECV" | tr -d ' ')"

# ── Ordering across an outage: two records queued offline both arrive ────────
stop_stub
: > "$RECV"
console_outbox_enqueue "$ENDPOINT" '{"schema":"kontour.console.event","id":"rec-2"}' "rec-2"
console_outbox_enqueue "$ENDPOINT" '{"schema":"kontour.console.event","id":"rec-3"}' "rec-3"
console_outbox_flush
check "both records survive the outage" "2" "$(console_outbox_pending_count)"

start_stub || { printf 'stub restart failed\n'; exit 1; }
console_outbox_flush
check "both are delivered once the hub returns" "2" "$(wc -l < "$RECV" | tr -d ' ')"
check "pending drains to empty" "0" "$(console_outbox_pending_count)"

# ── Gap detection: give-up is recorded, never silent ─────────────────────────
stop_stub
export CONSOLE_OUTBOX_MAX_ATTEMPTS=2
console_outbox_enqueue "$ENDPOINT" '{"schema":"kontour.console.event","id":"rec-4"}' "rec-4"
console_outbox_flush   # attempt 1
check "still pending after the first failed attempt" "1" "$(console_outbox_pending_count)"
console_outbox_flush   # attempt 2 reaches the cap
check "gives up after the attempt cap" "0" "$(console_outbox_pending_count)"
check "and records it as undelivered rather than dropping it" "1" "$(console_outbox_undelivered_count)"
unset CONSOLE_OUTBOX_MAX_ATTEMPTS

# ── A malformed body is rejected at enqueue, not queued forever ──────────────
BEFORE_PENDING="$(console_outbox_pending_count)"
console_outbox_enqueue "$ENDPOINT" 'not-json' "rec-bad"
check "a non-JSON body is refused at enqueue" "$BEFORE_PENDING" "$(console_outbox_pending_count)"

# ── Regression: enqueue must never REWRITE pending.jsonl (the CRITICAL race) ──
# An unlocked trim on the append path raced the locked flush's rewrite and
# silently dropped records — present in neither pending nor undelivered, never
# sent. The invariant that fixes it: appends are safe unlocked, rewrites are
# not, so enqueue only ever appends and trimming happens under the flush lock.
stop_stub
rm -rf "$TELEMETRY_DATA_DIR/console-outbox"
export CONSOLE_OUTBOX_MAX_ENTRIES=3
for i in 1 2 3 4 5; do
  console_outbox_enqueue "$ENDPOINT" "{\"schema\":\"kontour.console.event\",\"id\":\"over-$i\"}" "over-$i"
done
check "enqueue past the cap does not trim (no unlocked rewrite)" "5" "$(console_outbox_pending_count)"
check "and nothing was retired behind the flush's back" "0" "$(console_outbox_undelivered_count)"

# The bound is still enforced — just under the lock, where it is safe. The hub
# is down, so the 3 survivors stay pending and the 2 oldest retire.
console_outbox_flush
check "flush applies the cap under the lock" "3" "$(console_outbox_pending_count)"
check "overflow retired to undelivered, not dropped" "2" "$(console_outbox_undelivered_count)"
unset CONSOLE_OUTBOX_MAX_ENTRIES

# ── Regression: an orphaned lock must not disable delivery forever (the HIGH) ─
# flush runs detached with nothing supervising it, so a SIGKILL while holding
# the lock left records unsendable with no self-healing.
rm -rf "$TELEMETRY_DATA_DIR/console-outbox"
console_outbox_enqueue "$ENDPOINT" '{"schema":"kontour.console.event","id":"locked-1"}' "locked-1"
mkdir -p "$TELEMETRY_DATA_DIR/console-outbox/.flush.lock"
start_stub || { printf 'stub restart failed\n'; exit 1; }
: > "$RECV"

# A FRESH lock is respected — flush skips rather than double-sending.
console_outbox_flush
check "a fresh lock is respected (flush skips)" "0" "$(wc -l < "$RECV" | tr -d ' ')"
check "and the record is still queued" "1" "$(console_outbox_pending_count)"

# A STALE lock is reclaimed rather than deadlocking delivery. The threshold is
# "older than N seconds" (-gt, matching console-board-sync's precedent), so a
# lock created moments ago has age 0 and is not yet stale even at N=0 — sleep
# past it rather than loosening the production comparison to suit the test.
sleep 1
export CONSOLE_OUTBOX_STALE_LOCK_SECONDS=0
console_outbox_flush
check "a stale lock is reclaimed and the record delivered" "1" "$(wc -l < "$RECV" | tr -d ' ')"
check "pending drains after stale-lock takeover" "0" "$(console_outbox_pending_count)"
unset CONSOLE_OUTBOX_STALE_LOCK_SECONDS

# Hand the port back before the next section starts its own stub — two
# start_stub calls without an intervening stop bind the same port and the
# second silently fails with EADDRINUSE, which then shows up as unrelated
# delivery assertions failing.
stop_stub

# ── The best-effort core is untouched ────────────────────────────────────────
start_stub || { printf 'stub restart failed\n'; exit 1; }
: > "$RECV"
console_post_json "$ENDPOINT" '{"schema":"kontour.console.liveness","id":"beat-1"}'
for _ in $(seq 1 40); do
  [[ "$(wc -l < "$RECV" | tr -d ' ')" == "1" ]] && break
  sleep 0.1
done
check "console_post_json still fires detached and unqueued" "1" "$(wc -l < "$RECV" | tr -d ' ')"
check "and writes nothing to the outbox" "0" "$(console_outbox_pending_count)"

printf '\nResults: %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
