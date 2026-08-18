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
    fail "output tokens were $OUTPUT; expected 600 (1600 means the per-block inflation is back)"
  fi
  if [[ "$INPUT" == "15" ]]; then
    pass "input tokens likewise counted once per response (15, not 35)"
  else
    fail "input tokens were $INPUT; expected 15"
  fi

  # Cache read is ~80% of spend by this repo's own measurement, so a dedupe covering
  # only input/output would leave the most expensive class inflated and still pass.
  CACHE_C="$(printf '%s' "$USAGE_JSON" | jq -r '.cache_creation_input_tokens // empty' 2>/dev/null)"
  CACHE_R="$(printf '%s' "$USAGE_JSON" | jq -r '.cache_read_input_tokens // empty' 2>/dev/null)"
  if [[ "$CACHE_C" == "21" && "$CACHE_R" == "32" ]]; then
    pass "cache creation and cache read are deduped too (21/32, not 61/92)"
  else
    fail "cache tokens were creation=$CACHE_C read=$CACHE_R; expected 21/32"
  fi

  # The accumulator must never surface as a model. It lived in the same object as the
  # model keys in the first version of this fix, where a model named for it would have
  # been deleted with it.
  MODELS="$(printf '%s' "$USAGE_JSON" | jq -r '[.by_model[].model] | sort | join(",")' 2>/dev/null)"
  if [[ "$MODELS" == "claude-fable-5" ]]; then
    pass "by_model carries only real models, no bookkeeping key"
  else
    fail "by_model reported models: $MODELS; expected only claude-fable-5"
  fi
fi

# A malformed id must not discard the session. jq raises on a non-string object key, and
# an unguarded has() aborts the whole program — losing every token in the file over one
# bad line, in a format documented as changing between releases.
BADID="$TMP/badid.jsonl"
printf '{"type":"assistant","timestamp":"2026-08-17T12:00:00.000Z","message":{"id":7,"model":"claude-fable-5","usage":{"input_tokens":10,"output_tokens":500,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n' >"$BADID"
printf '{"type":"assistant","timestamp":"2026-08-17T12:00:01.000Z","message":{"id":"good","model":"claude-fable-5","usage":{"input_tokens":1,"output_tokens":9,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n' >>"$BADID"
BAD_JSON="$(usage_parse_transcript "$BADID" 2>/dev/null)"
BAD_OUT="$(printf '%s' "$BAD_JSON" | jq -r '.output_tokens // empty' 2>/dev/null)"
if [[ "$BAD_OUT" == "509" ]]; then
  pass "a non-string message.id costs one line's precision, never the whole session"
else
  fail "a non-string message.id yielded output=$BAD_OUT; expected 509 (empty means the session was discarded)"
fi

# A model whose name collides with internal bookkeeping must keep its tokens.
COLLIDE="$TMP/collide.jsonl"
printf '{"type":"assistant","timestamp":"2026-08-17T12:00:00.000Z","message":{"id":"c1","model":"seen","usage":{"input_tokens":11,"output_tokens":111,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n' >"$COLLIDE"
COLLIDE_OUT="$(usage_parse_transcript "$COLLIDE" 2>/dev/null | jq -r '.output_tokens // empty' 2>/dev/null)"
if [[ "$COLLIDE_OUT" == "111" ]]; then
  pass "a model named after the accumulator keeps its tokens"
else
  fail "a model named 'seen' reported output=$COLLIDE_OUT; expected 111"
fi


# --- the per-phase attributor, which had no coverage at all ---------------------
#
# Independent review proved by mutation that deleting the .mjs dedupe changed nothing:
# every line in both economics fixtures lacks a `message.id`, so they all take the
# fail-open path and the guard was never exercised. This drives it with the real shape.
ENRICH="$ROOT/scripts/telemetry/economics-enrich-tokens.mjs"
if [[ -f "$ENRICH" ]]; then
  MJS_TX="$TMP/mjs-transcript.jsonl"
  MJS_WIN="$TMP/mjs-windows.json"
  printf '[{"phase":"verify","start":"2026-03-01T00:00:00.000Z","end":"2026-03-01T00:01:00.000Z"}]\n' >"$MJS_WIN"
  mjs_block() {
    printf '{"type":"assistant","timestamp":"%s","message":{"id":"%s","model":"claude-fable-5","usage":{"input_tokens":%s,"output_tokens":%s,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n' \
      "$1" "$2" "$3" "$4" >>"$MJS_TX"
  }
  mjs_block "2026-03-01T00:00:10.000Z" mjs_a 10 500
  mjs_block "2026-03-01T00:00:11.000Z" mjs_a 10 500
  mjs_block "2026-03-01T00:00:12.000Z" mjs_a 10 500
  mjs_block "2026-03-01T00:00:20.000Z" mjs_b 5 100

  MJS_OUT="$(node "$ENRICH" --transcript "$MJS_TX" --windows-json "$MJS_WIN" 2>/dev/null)"
  MJS_TOTAL="$(printf '%s' "$MJS_OUT" | jq -r '[.. | objects | select(has("output_tokens")) | .output_tokens] | max // empty' 2>/dev/null)"
  MJS_SKIPPED="$(printf '%s' "$MJS_OUT" | jq -r '.. | objects | select(has("duplicate_usage_lines_skipped")) | .duplicate_usage_lines_skipped' 2>/dev/null | head -1)"

  if [[ "$MJS_TOTAL" == "600" ]]; then
    pass "per-phase attribution counts each response once (600, not 1600)"
  else
    fail "per-phase output tokens were $MJS_TOTAL; expected 600"
  fi
  if [[ "$MJS_SKIPPED" == "2" ]]; then
    pass "the skipped-duplicate count is disclosed, not silent (2)"
  else
    fail "duplicate_usage_lines_skipped was '$MJS_SKIPPED'; expected 2"
  fi
else
  fail "economics-enrich-tokens.mjs not found at $ENRICH"
fi

if [[ "$FAILURES" -gt 0 ]]; then
  printf '\n  %s failure(s)\n' "$FAILURES"
  exit 1
fi
printf '\nTranscript usage dedupe tests passed.\n'
