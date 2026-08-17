#!/usr/bin/env bash
# #1258: the measurement trend sink records locally and reports CHANGES, not scores.
#
# Scope of the network assertion, stated precisely because an earlier version overclaimed:
# the curl-stub test proves the sink does not invoke curl, even with channel endpoints
# configured. It cannot prove the absence of every outbound path (BASH_ENV preloads run
# before any script line; a hostile PATH or wrapped interpreter is out of scope) — those
# are disclosed limits of the whole repo, not properties any single test can grant.
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

# 8. Review round 1 returned BLOCK. Every assertion below covers a claim it REFUTED.

# 8a. Writer and reader enforce ONE id contract. The first version of this comment claimed
# a spaced id "could never match" — false, argv passes spaces fine; the real defect was the
# two sides disagreeing about what is valid. Both directions are pinned.
if printf '{"measurement":"has space","probes":[]}' | bash "$RECORD" --log "$TMP/r.jsonl" >/dev/null 2>&1; then
  fail "the writer accepted an id outside the shared charset"
else
  pass "the writer refuses an id outside the shared charset"
fi
if bash "$TREND" --measurement "has space" --log "$LOG" >/dev/null 2>&1; then
  fail "the reader accepted an id the writer refuses — split contract"
else
  pass "the reader refuses the same ids the writer refuses"
fi

# 8b. A shape the reader cannot process must be refused by the writer, not found a day later.
if printf '{"measurement":"demo","probes":{}}' | bash "$RECORD" --log "$TMP/r.jsonl" >/dev/null 2>&1; then
  fail "non-array probes accepted (this crashed the reporter with .map is not a function)"
else
  pass "non-array probes refused at write time"
fi

# 8c. Duplicates were collapsed by the reporter's index — corpus shrinkage, silently.
dup='{"measurement":"demo","probes":[{"id":"a","verdict":"CLEAN"},{"id":"a","verdict":"VAGUE"}]}'
if printf '%s' "$dup" | bash "$RECORD" --log "$TMP/r.jsonl" >/dev/null 2>&1; then
  fail "duplicate probe ids accepted (silently collapsed on read)"
else
  pass "duplicate probe ids refused"
fi

# 8d. THE ONE THAT DEFEATED THE NO-SCORE TEST. Verdicts were printed verbatim, so verdicts
#     of 80%/70% produced "80% -> 70%" out of a report whose whole purpose is to avoid a score.
pct='{"measurement":"demo","probes":[{"id":"a","verdict":"80%"}]}'
if printf '%s' "$pct" | bash "$RECORD" --log "$TMP/r.jsonl" >/dev/null 2>&1; then
  fail "a percentage verdict was accepted; the no-score property is defeatable"
else
  pass "a percentage verdict is refused"
fi

# 8d2. Percent can also arrive through a probe ID, which the report prints verbatim.
pctid='{"measurement":"demo","probes":[{"id":"80%","verdict":"CLEAN"}]}'
if printf '%s' "$pctid" | bash "$RECORD" --log "$TMP/r.jsonl" >/dev/null 2>&1; then
  fail "a percent-bearing probe id was accepted; the no-score property is defeatable via ids"
else
  pass "a percent-bearing probe id is refused"
fi

# 8e. A corrupt newest row must not render as reassurance.
CORRUPT="$TMP/corrupt.jsonl"
reading corr a:CLEAN b:CLEAN | bash "$RECORD" --log "$CORRUPT" >/dev/null 2>&1
reading corr a:CLEAN b:CLEAN | bash "$RECORD" --log "$CORRUPT" >/dev/null 2>&1
printf '{"measurement":"corr","probes":[{"id":"a","verdi\n' >> "$CORRUPT"
out="$(bash "$TREND" --measurement corr --log "$CORRUPT" 2>&1)"
case "$out" in
  *"unreadable row"*) pass "a corrupt row is reported, not silently dropped" ;;
  *) fail "a corrupt newest row was silently discarded: $out" ;;
esac

# 8e2. --list was the remaining silent-discard route: an unreadable file listed
# "no readings recorded" at exit 0, and a parseable scalar row crashed it.
printf 'not json at all\n42\n' > "$TMP/listcorrupt.jsonl"
out="$(bash "$TREND" --list --log "$TMP/listcorrupt.jsonl" 2>&1)"
case "$out" in
  *WARNING*unreadable*) pass "--list reports unreadable rows instead of discarding them" ;;
  *) fail "--list silently discarded unreadable rows: $out" ;;
esac

# 8f. umask governs only files this script creates; a pre-existing loose log kept leaking.
LOOSE="$TMP/loose.jsonl"; : > "$LOOSE"; chmod 644 "$LOOSE"
if reading demo a:CLEAN | bash "$RECORD" --log "$LOOSE" >/dev/null 2>&1; then
  fail "appended to a world-readable log without complaint"
else
  pass "refuses to append to an over-permissive existing log"
fi

# 8f2. The positive half, without which 8f has no power: a broken mode probe that refused
# EVERYTHING would pass 8f. An existing 0600 log must still take appends, and a refused
# append must preserve the reading in an owner-only sidecar.
chmod 600 "$LOOSE"
if reading demo a:CLEAN | bash "$RECORD" --log "$LOOSE" >/dev/null 2>&1; then
  pass "an existing 0600 log still accepts appends"
else
  fail "a 0600 log was refused — the mode check refuses everything"
fi
chmod 644 "$LOOSE"
reading demo a:CLEAN | bash "$RECORD" --log "$LOOSE" >/dev/null 2>&1
if ls "$LOOSE".refused.* >/dev/null 2>&1; then
  pass "a refused reading is preserved in a sidecar, not destroyed"
else
  fail "the refusal destroyed the piped reading"
fi

# 8g. The inherited-preload vector a stubbed curl can never observe. Asserted behaviourally:
#     an unusable NODE_OPTIONS preload would break the run if it still reached node.
reading demo a:CLEAN | NODE_OPTIONS="--require /nonexistent-preload-should-be-scrubbed" \
  bash "$RECORD" --log "$TMP/scrub.jsonl" >/dev/null 2>&1
if [ -s "$TMP/scrub.jsonl" ]; then
  pass "NODE_OPTIONS is scrubbed (a broken preload did not reach node)"
else
  fail "NODE_OPTIONS reached node — a preload can run code the curl stub cannot see"
fi

printf '\n  %s failure(s)\n\n' "$errors"
[ "$errors" -eq 0 ] || exit 1
exit 0
