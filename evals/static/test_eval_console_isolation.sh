#!/usr/bin/env bash
# test_eval_console_isolation.sh — evals cannot reach a real console by forgetting (#1094 item C).
#
# The hazard, observed for real while building the receipt relay: stubbing HOME
# looks like isolation and is not. config.sh resolves a per-workspace
# `.kontourai/telemetry-console.conf` ahead of the user-global one, and THIS
# REPO HAS ONE carrying a live production endpoint and token. An eval that only
# stubs HOME therefore resolves production and can post real records from a test
# run.
#
# run-baseline defaults TELEMETRY_CONFIG_FILE to a console-free fixture so the
# safe outcome is the one you get by doing nothing. These checks pin that
# default, because a guard nobody asserts is a guard that quietly disappears.
#
# Usage: bash evals/static/test_eval_console_isolation.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_BASELINE="$ROOT/evals/ci/run-baseline.sh"
FIXTURE="$ROOT/evals/fixtures/no-console.telemetry.conf"

PASS=0
FAIL=0
pass() { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

[[ -f "$FIXTURE" ]] && pass "console-free eval fixture exists" \
  || fail "missing $FIXTURE"

# The fixture must not carry a console, or the guard defeats itself.
if grep -qE '^[[:space:]]*console_telemetry_(url|token)[[:space:]]*=' "$FIXTURE" 2>/dev/null; then
  fail "the eval fixture declares a console endpoint or token — it must declare neither"
else
  pass "the eval fixture declares no console endpoint and no token"
fi

grep -q 'TELEMETRY_CONFIG_FILE' "$RUN_BASELINE" \
  && pass "run-baseline pins TELEMETRY_CONFIG_FILE for eval commands" \
  || fail "run-baseline no longer sets TELEMETRY_CONFIG_FILE — evals can resolve a real console"

# Defaulted, not forced: a test that needs its own console conf must still win,
# or test_console_receipt_relay.sh could not exercise a configured hub.
grep -q 'TELEMETRY_CONFIG_FILE:-' "$RUN_BASELINE" \
  && pass "the pin is a default, so a test's own TELEMETRY_CONFIG_FILE still wins" \
  || fail "run-baseline forces TELEMETRY_CONFIG_FILE unconditionally — a test cannot opt into its own stub hub"

# The load-bearing behavioural check, asserted through a real consumer rather
# than by resolving config directly: run the receipt relay under the fixture on
# a machine whose own conf DOES resolve a live console, and prove it queues
# nothing. If isolation ever stops holding, this is the check that fails.
PROBE_HOME="$(mktemp -d)"
PROBE_DATA="$(mktemp -d)"
TELEMETRY_CONFIG_FILE="$FIXTURE" \
  HOME="$PROBE_HOME" \
  TELEMETRY_DATA_DIR="$PROBE_DATA" \
  TELEMETRY_SESSION_DIR="$PROBE_DATA" \
  bash "$ROOT/scripts/console/receipt-relay.sh" \
  '{"session":"isolation-probe","kind":"gate-claim","revision":"1"}' >/dev/null 2>&1
QUEUED=0
[[ -f "$PROBE_DATA/console-outbox/pending.jsonl" ]] \
  && QUEUED="$(wc -l < "$PROBE_DATA/console-outbox/pending.jsonl" | tr -d ' ')"
rm -rf "$PROBE_HOME" "$PROBE_DATA"
[[ "$QUEUED" == "0" ]] \
  && pass "the receipt relay queues nothing under the eval fixture (no console resolved)" \
  || fail "the receipt relay queued $QUEUED record(s) under the eval fixture — isolation is not holding"

printf '\ntest_eval_console_isolation: %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
