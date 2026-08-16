#!/usr/bin/env bash
# #1258: the measurement trend sink records locally, reports CHANGES, and never phones home.
#
# The load-bearing assertion is the last one. Every other property here is visible in the
# output; "did this record leave the machine" is not, so it is proven by stubbing curl and
# showing the stub was never invoked even with an endpoint configured. A silent outbound
# side effect cannot be caught by reading stdout, which is exactly why it needs a test.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RECORD="$ROOT/scripts/telemetry/measurement-record.sh"
TREND="$ROOT/scripts/telemetry/measurement-trend.sh"
errors=0
pass() { printf '  PASS  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; errors=$((errors + 1)); }

printf '\ntest_measurement_trend\n'

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
LOG="$TMP/measurements.jsonl"

reading() { # id, then probe "id:verdict" pairs
  local m="$1"; shift
  local probes=""
  for p in "$@"; do
    [ -n "$probes" ] && probes="$probes,"
    probes="$probes{\"id\":\"${p%%:*}\",\"verdict\":\"${p##*:}\",\"first_line\":\"line for ${p%%:*}\"}"
  done
  printf '{"measurement":"%s","probes":[%s]}' "$m" "$probes"
}

# 1. A well-formed reading is recorded and dated by the sink.
if reading demo a:CLEAN b:CLEAN | bash "$RECORD" --log "$LOG" >/dev/null 2>&1; then
  if [ -s "$LOG" ] && node -e 'const r=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8").trim());process.exit(typeof r.recorded_at==="string"&&r.recorded_at.length>0?0:1)' "$LOG"; then
    pass "a reading is appended and stamped with recorded_at"
  else
    fail "reading was recorded without a recorded_at stamp"
  fi
else
  fail "recording a well-formed reading failed"
fi

# 2. Malformed input is refused rather than silently producing an unkeyable row.
if printf 'not json' | bash "$RECORD" --log "$TMP/bad.jsonl" >/dev/null 2>&1; then
  fail "non-JSON input was accepted"
else
  pass "non-JSON input is refused"
fi
if printf '{"probes":[]}' | bash "$RECORD" --log "$TMP/bad.jsonl" >/dev/null 2>&1; then
  fail "a reading with no measurement id was accepted"
else
  pass "a reading with no measurement id is refused"
fi
if [ -s "$TMP/bad.jsonl" ]; then
  fail "a refused reading still wrote a row"
else
  pass "a refused reading writes nothing"
fi

# 3. One reading is reported as a value, not a trend.
out="$(bash "$TREND" --measurement demo --log "$LOG" 2>&1)"
case "$out" in
  *"nothing to compare against"*) pass "a single reading is not presented as a trend" ;;
  *) fail "single-reading output did not say it has no comparison: $out" ;;
esac

# 4. The report names WHICH probe changed — not a score.
reading demo a:CLEAN b:VAGUE | bash "$RECORD" --log "$LOG" >/dev/null 2>&1
out="$(bash "$TREND" --measurement demo --log "$LOG" 2>&1)"
case "$out" in
  *"CHANGED  b"*) pass "the changed probe is named" ;;
  *) fail "the changed probe was not named: $out" ;;
esac
case "$out" in
  *"CLEAN -> VAGUE"*) pass "the verdict transition is shown" ;;
  *) fail "the verdict transition was not shown" ;;
esac
case "$out" in
  *"CHANGED  a"*) fail "an UNCHANGED probe was reported as changed" ;;
  *) pass "unchanged probes stay silent" ;;
esac
# A percentage would let a reader argue with the number instead of the behaviour.
case "$out" in
  *%*) fail "the change report emitted a percentage; #1258 asks for occurrences, not scores" ;;
  *) pass "no aggregate score in the change report" ;;
esac

# 5. Coverage changes are reported, not absorbed. A probe that vanishes must not read as
#    "nothing to report" — that is how a shrinking corpus looks stable.
reading demo a:CLEAN | bash "$RECORD" --log "$LOG" >/dev/null 2>&1
out="$(bash "$TREND" --measurement demo --log "$LOG" 2>&1)"
case "$out" in
  *"REMOVED  b"*) pass "a probe that disappeared is reported as removed coverage" ;;
  *) fail "a disappeared probe was silently absorbed: $out" ;;
esac

# 6. Advisory only: a worse reading must not fail the command. Gating on a count is the
#    antipattern #1258 exists to avoid.
bash "$TREND" --measurement demo --log "$LOG" >/dev/null 2>&1
if [ "$?" -eq 0 ]; then
  pass "a worse reading is advisory, not a gate"
else
  fail "the trend report exited non-zero on a worse reading"
fi

# 7. THE ONE THAT MATTERS: no network, even with an endpoint configured.
#    curl is stubbed to leave a marker; the marker must never appear.
STUB="$TMP/stub"; mkdir -p "$STUB"
cat > "$STUB/curl" <<EOF
#!/usr/bin/env bash
printf 'curl was invoked with: %s\n' "\$*" >> "$TMP/curl-was-called"
exit 0
EOF
chmod +x "$STUB/curl"

if ! PATH="$STUB:$PATH" \
   TELEMETRY_CHANNELS="console" \
   TELEMETRY_CHANNEL_CONSOLE_LOG_FILE="$TMP/channel.jsonl" \
   TELEMETRY_CHANNEL_CONSOLE_ENDPOINT_URL="http://127.0.0.1:9/should-never-be-called" \
   CONSOLE_TELEMETRY_ENDPOINT_URL="http://127.0.0.1:9/should-never-be-called" \
   bash -c "$(printf '%q' "$(cat "$RECORD")")" 2>/dev/null <<< "$(reading netcheck a:CLEAN)"; then
  : # the invocation form above is best-effort; the real check is the marker below
fi
# Run it the normal way too, with the same hostile environment.
PATH="$STUB:$PATH" \
  TELEMETRY_CHANNELS="console" \
  TELEMETRY_CHANNEL_CONSOLE_LOG_FILE="$TMP/channel.jsonl" \
  TELEMETRY_CHANNEL_CONSOLE_ENDPOINT_URL="http://127.0.0.1:9/should-never-be-called" \
  CONSOLE_TELEMETRY_ENDPOINT_URL="http://127.0.0.1:9/should-never-be-called" \
  bash "$RECORD" --log "$TMP/net.jsonl" >/dev/null 2>&1 <<< "$(reading netcheck a:CLEAN)"

if [ -f "$TMP/curl-was-called" ]; then
  fail "the sink invoked curl despite being local-only: $(cat "$TMP/curl-was-called")"
else
  pass "no network call, even with a channel endpoint configured"
fi
if [ -s "$TMP/net.jsonl" ]; then
  pass "the reading was still recorded locally"
else
  fail "the reading was not recorded"
fi
# And prove the stub itself works, or the assertion above proves nothing.
PATH="$STUB:$PATH" curl https://example.invalid >/dev/null 2>&1
if [ -f "$TMP/curl-was-called" ]; then
  pass "control: the curl stub does fire when curl is actually called"
else
  fail "control: the curl stub never fires — the no-network assertion has no power"
fi

printf '\n  %s failure(s)\n\n' "$errors"
[ "$errors" -eq 0 ] || exit 1
exit 0
