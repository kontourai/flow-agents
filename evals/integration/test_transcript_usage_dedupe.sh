#!/usr/bin/env bash
# test_transcript_usage_dedupe.sh — one API response is counted once (#1275)
#
# A single assistant response is written to the transcript as SEVERAL lines — one per
# content block (thinking, text, each tool_use) — every one carrying the SAME
# `message.id` and the IDENTICAL usage totals. Summing per line therefore counts a
# response once per block it happened to emit.
#
# Measured before this guard existed: 2.14x and 2.72x inflation on two real transcripts.
# The multiplier tracks block count, so it varies per session and cannot be corrected
# after the fact — which is why a fixture, not a ratio, is the right test.
#
# This is the shape that matters: identical usage under one id, plus a distinct second
# response, so a broken dedupe fails loudly in EITHER direction (over-count if it stops
# deduping, under-count if it collapses distinct responses).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FAILURES=0
pass() { printf '  PASS  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

TRANSCRIPT="$TMP/transcript.jsonl"
block() {
  printf '{"type":"assistant","timestamp":"%s","message":{"id":"%s","model":"claude-fable-5","usage":{"input_tokens":%s,"output_tokens":%s,"cache_creation_input_tokens":%s,"cache_read_input_tokens":%s}}}\n' \
    "$1" "$2" "$3" "$4" "$5" "$6" >>"$TRANSCRIPT"
}
# One response, three content blocks, identical usage on each.
block "2026-08-17T12:00:00.000Z" msg_a 10 500 20 30
block "2026-08-17T12:00:00.100Z" msg_a 10 500 20 30
block "2026-08-17T12:00:00.200Z" msg_a 10 500 20 30
# A genuinely distinct second response.
block "2026-08-17T12:00:05.000Z" msg_b 5 100 1 2

# shellcheck source=/dev/null
source "$ROOT/scripts/telemetry/lib/usage.sh"

RAW_LINES="$(wc -l <"$TRANSCRIPT" | tr -d ' ')"
[[ "$RAW_LINES" == "4" ]] || fail "fixture should hold 4 lines, found $RAW_LINES"

USAGE_JSON="$(usage_parse_transcript "$TRANSCRIPT" 2>/dev/null)"
if [[ -z "$USAGE_JSON" ]]; then
  fail "usage_parse_transcript produced nothing for the fixture"
else
  OUTPUT="$(printf '%s' "$USAGE_JSON" | jq -r '.output_tokens // empty' 2>/dev/null)"
  INPUT="$(printf '%s' "$USAGE_JSON" | jq -r '.input_tokens // empty' 2>/dev/null)"
  if [[ "$OUTPUT" == "600" ]]; then
    pass "three blocks of one response contribute their output once (600, not 1500)"
  else
    fail "output tokens were $OUTPUT; expected 600 (1500 means the per-block inflation is back)"
  fi
  if [[ "$INPUT" == "15" ]]; then
    pass "input tokens likewise counted once per response (15, not 35)"
  else
    fail "input tokens were $INPUT; expected 15"
  fi
fi

if [[ "$FAILURES" -gt 0 ]]; then
  printf '\n  %s failure(s)\n' "$FAILURES"
  exit 1
fi
printf '\nTranscript usage dedupe tests passed.\n'
