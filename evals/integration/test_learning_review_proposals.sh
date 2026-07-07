#!/usr/bin/env bash
# shellcheck disable=SC2015
# ^ the `<cond> && pass ... || fail ...` assert idiom is deliberate (pass always returns 0).
# test_learning_review_proposals.sh — kit/gate tuning proposals from economics records (#352).
#
# Proves scripts/telemetry/learning-review-proposals.sh turns a window of real
# kontour.console.economics records into ADVISORY, evidence-cited, per-kit/per-gate proposals —
# generalizing scripts/telemetry/routing-efficiency.sh (#415) from per-(role,model) to per-kit/
# per-gate — and that scripts/telemetry/learning-review-decide.sh records human ratify/reject/
# defer decisions in place, never auto-applying anything.
#
# Coverage -> ACs (see docs/specs/learning-review-proposals-contract.md):
#   AC1 (R1) pattern-present fixture's by_kit[]/by_gate[] aggregates match hand-computed values
#            (evals/fixtures/learning-review-proposals/pattern-present/expected-aggregates.json,
#            arithmetic shown in expected-aggregates.md) at exact 4-decimal precision.
#   AC2 (R2) pattern-present yields >=1 evidence-cited proposal (cost+defect paired); balanced
#            fixture (proportional cost/findings movement) yields zero proposals.
#   AC3 (R3) analyzer + decide script make zero mutation to kits/**/.datum/config.json; decide
#            refuses --follow-on-ref without --ratify.
#   AC4 (R4) running twice over an identical window de-dupes (no duplicate proposal_id in the
#            ledger, second run marks already_proposed:true); under-threshold record count
#            yields an explicit "insufficient-data" outcome, never a confident thin call.
#   AC5 (R5) a ratified proposal is linked to a follow_on_ref; a later window's pass over the
#            same target fills in effect_observed (metric/before/after/moved).
#   schema   emitted output validates against learning-review-proposals.schema.json; a doctored
#            cost-only (no defect) proposal FAILS validation (Goodhart-guard co-requirement).
#
# Deterministic (no network, no model spend); fixtures live under
# evals/fixtures/learning-review-proposals/**. Each case uses its own mktemp-sandboxed ledger.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TELEMETRY="$ROOT/scripts/telemetry"
ANALYZER="$TELEMETRY/learning-review-proposals.sh"
DECIDER="$TELEMETRY/learning-review-decide.sh"
SCHEMA="$TELEMETRY/learning-review-proposals.schema.json"
FIX="$ROOT/evals/fixtures/learning-review-proposals"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
errors=0
pass() { echo "  [PASS] $1"; }
fail() { echo "  [FAIL] $1"; errors=$((errors + 1)); }

command -v jq >/dev/null 2>&1 || { echo "jq unavailable; skipping"; exit 0; }

echo "=== learning-review-proposals (#352) ==="

# ── AC1/AC2: pattern-present — hand-computed aggregates + evidence-cited proposals ─────────────────
echo "--- AC1/AC2: pattern-present fixture — hand-computed aggregates match; evidence-cited proposals fire ---"
PP="$FIX/pattern-present"
LEDGER_PP="$TMP/ledger-pattern-present.jsonl"
OUT_PP="$(bash "$ANALYZER" --sessions-root "$PP/sessions" --ledger "$LEDGER_PP" "$PP/economics.jsonl")"

aeq() { # <out-json> <label> <jq-expr> <expected>
  local out="$1" label="$2" expr="$3" exp="$4"
  local got; got="$(printf '%s' "$out" | jq -c "$expr" 2>/dev/null)"
  [[ "$got" == "$exp" ]] && pass "$label ($got)" || fail "$label: expected $exp got $got"
}

aeq "$OUT_PP" "records_considered == 6" '.records_considered' '6'
aeq "$OUT_PP" "outcome == ok" '.outcome' '"ok"'

# by_kit[] — exact 4-decimal-rounded values, hand-computed in expected-aggregates.md
BYKIT='.aggregates.by_kit[] | select(.kit_id=="builder")'
aeq "$OUT_PP" "by_kit[builder].runs == 6" "$BYKIT | .runs" '6'
aeq "$OUT_PP" "by_kit[builder].first_half_avg_cost_usd == 0.1000" "$BYKIT | .first_half_avg_cost_usd" '0.1'
aeq "$OUT_PP" "by_kit[builder].second_half_avg_cost_usd == 0.2000" "$BYKIT | .second_half_avg_cost_usd" '0.2'
aeq "$OUT_PP" "by_kit[builder].cost_trend_pct == 100.0000" "$BYKIT | .cost_trend_pct" '100'
aeq "$OUT_PP" "by_kit[builder].first_half_findings_total == 6" "$BYKIT | .first_half_findings_total" '6'
aeq "$OUT_PP" "by_kit[builder].second_half_findings_total == 6" "$BYKIT | .second_half_findings_total" '6'
aeq "$OUT_PP" "by_kit[builder].findings_delta_pct == 0.0000" "$BYKIT | .findings_delta_pct" '0'
aeq "$OUT_PP" "by_kit[builder].avg_wall_clock_s == 100.0000" "$BYKIT | .avg_wall_clock_s" '100'
aeq "$OUT_PP" "by_kit[builder].avg_human_wait_s == 10.0000" "$BYKIT | .avg_human_wait_s" '10'
aeq "$OUT_PP" "by_kit[builder].route_back_rate == 0.5000" "$BYKIT | .route_back_rate" '0.5'
aeq "$OUT_PP" "by_kit[builder].caught_false_completions_total == 6" "$BYKIT | .caught_false_completions_total" '6'

# by_gate[] — exact 4-decimal-rounded values
BYGATE='.aggregates.by_gate[] | select(.gate_id=="unit tests pass")'
aeq "$OUT_PP" "by_gate[unit tests pass].fire_count == 4" "$BYGATE | .fire_count" '4'
aeq "$OUT_PP" "by_gate[unit tests pass].correct_count == 1" "$BYGATE | .correct_count" '1'
aeq "$OUT_PP" "by_gate[unit tests pass].false_block_count == 3" "$BYGATE | .false_block_count" '3'
aeq "$OUT_PP" "by_gate[unit tests pass].missed_block_count == 0" "$BYGATE | .missed_block_count" '0'
aeq "$OUT_PP" "by_gate[unit tests pass].false_block_rate == 0.7500" "$BYGATE | .false_block_rate" '0.75'
aeq "$OUT_PP" "by_gate[unit tests pass].avg_wall_clock_s_when_fired == 100.0000" "$BYGATE | .avg_wall_clock_s_when_fired" '100'
aeq "$OUT_PP" "by_gate[unit tests pass].avg_human_wait_s_when_fired == 10.0000" "$BYGATE | .avg_human_wait_s_when_fired" '10'

# whole-document by_kit/by_gate equal the independently hand-computed expected-aggregates.json exactly.
EXPECTED_AGG="$(cat "$PP/expected-aggregates.json")"
GOT_BYKIT="$(printf '%s' "$OUT_PP" | jq -c '.aggregates.by_kit')"
EXP_BYKIT="$(printf '%s' "$EXPECTED_AGG" | jq -c '.by_kit')"
[[ "$GOT_BYKIT" == "$EXP_BYKIT" ]] && pass "by_kit[] equals expected-aggregates.json exactly" || fail "by_kit[] drifted from expected-aggregates.json: got=$GOT_BYKIT want=$EXP_BYKIT"
GOT_BYGATE="$(printf '%s' "$OUT_PP" | jq -c '.aggregates.by_gate')"
EXP_BYGATE="$(printf '%s' "$EXPECTED_AGG" | jq -c '.by_gate')"
[[ "$GOT_BYGATE" == "$EXP_BYGATE" ]] && pass "by_gate[] equals expected-aggregates.json exactly" || fail "by_gate[] drifted from expected-aggregates.json: got=$GOT_BYGATE want=$EXP_BYGATE"

# AC2: at least one evidence-cited kit-review-cost-inflation proposal, cost+defect paired.
KIT_PROP="$(printf '%s' "$OUT_PP" | jq -c '.proposals[] | select(.pattern=="kit-review-cost-inflation" and .target.id=="builder")')"
[[ -n "$KIT_PROP" ]] && pass "pattern-present yields a kit-review-cost-inflation proposal for builder" || fail "no kit-review-cost-inflation proposal found"
aeq "$OUT_PP" "kit proposal evidence.cost non-null" '.proposals[] | select(.pattern=="kit-review-cost-inflation") | (.evidence.cost != null)' 'true'
aeq "$OUT_PP" "kit proposal evidence.defect non-null" '.proposals[] | select(.pattern=="kit-review-cost-inflation") | (.evidence.defect != null)' 'true'
aeq "$OUT_PP" "kit proposal evidence.cost.cost_trend_pct == 100" '.proposals[] | select(.pattern=="kit-review-cost-inflation") | .evidence.cost.cost_trend_pct' '100'
aeq "$OUT_PP" "kit proposal evidence.defect.findings_delta_pct == 0" '.proposals[] | select(.pattern=="kit-review-cost-inflation") | .evidence.defect.findings_delta_pct' '0'

# AC2: evidence-cited gate-false-block-review proposal, cost+defect paired.
GATE_PROP="$(printf '%s' "$OUT_PP" | jq -c '.proposals[] | select(.pattern=="gate-false-block-review" and .target.id=="unit tests pass")')"
[[ -n "$GATE_PROP" ]] && pass "pattern-present yields a gate-false-block-review proposal" || fail "no gate-false-block-review proposal found"
aeq "$OUT_PP" "gate proposal evidence.cost non-null" '.proposals[] | select(.pattern=="gate-false-block-review") | (.evidence.cost != null)' 'true'
aeq "$OUT_PP" "gate proposal evidence.defect non-null" '.proposals[] | select(.pattern=="gate-false-block-review") | (.evidence.defect != null)' 'true'
aeq "$OUT_PP" "gate proposal evidence.defect.false_block_count == 3" '.proposals[] | select(.pattern=="gate-false-block-review") | .evidence.defect.false_block_count' '3'
aeq "$OUT_PP" "every proposal is severity advisory" '[.proposals[] | select(.severity != "advisory")] | length' '0'

# ── AC2: balanced — proportional cost+findings movement -> zero proposals ─────────────────────────
echo "--- AC2: balanced fixture — proportional cost+findings rise (30%/30%) yields zero proposals ---"
BAL="$FIX/balanced"
LEDGER_BAL="$TMP/ledger-balanced.jsonl"
OUT_BAL="$(bash "$ANALYZER" --ledger "$LEDGER_BAL" "$BAL/economics.jsonl")"
aeq "$OUT_BAL" "balanced: outcome == ok (enough samples, just no pattern)" '.outcome' '"ok"'
aeq "$OUT_BAL" "balanced: proposals == []" '.proposals' '[]'
aeq "$OUT_BAL" "balanced: by_kit cost_trend_pct == 30 (engineered, not a threshold accident)" '.aggregates.by_kit[0].cost_trend_pct' '30'
aeq "$OUT_BAL" "balanced: by_kit findings_delta_pct == 30 (rising in step with cost -> guarded)" '.aggregates.by_kit[0].findings_delta_pct' '30'

# ── AC4: under-threshold — below LR_MIN_WINDOW_SAMPLE -> explicit insufficient-data ────────────────
echo "--- AC4: under-threshold fixture — below LR_MIN_WINDOW_SAMPLE -> insufficient-data, not a thin confident call ---"
UT="$FIX/under-threshold"
LEDGER_UT="$TMP/ledger-under-threshold.jsonl"
OUT_UT="$(bash "$ANALYZER" --ledger "$LEDGER_UT" "$UT/economics.jsonl")"
aeq "$OUT_UT" "under-threshold: outcome == insufficient-data" '.outcome' '"insufficient-data"'
aeq "$OUT_UT" "under-threshold: proposals == []" '.proposals' '[]'
aeq "$OUT_UT" "under-threshold: aggregates.partial == true" '.aggregates.partial' 'true'
aeq "$OUT_UT" "under-threshold: records_considered == 3 (< default 5)" '.records_considered' '3'

# ── AC4: repeat-window — identical window run twice -> no duplicate proposal_id, already_proposed ─
echo "--- AC4: repeat-window fixture — running twice over the identical window de-dupes ---"
RW="$FIX/repeat-window"
LEDGER_RW="$TMP/ledger-repeat-window.jsonl"
OUT_RW1="$(bash "$ANALYZER" --ledger "$LEDGER_RW" "$RW/economics.jsonl")"
aeq "$OUT_RW1" "repeat-window run1: yields a real proposal to de-dupe" '[.proposals[] | select(.pattern=="kit-review-cost-inflation")] | length' '1'
aeq "$OUT_RW1" "repeat-window run1: already_proposed == false (first time)" '.proposals[] | select(.pattern=="kit-review-cost-inflation") | .already_proposed' 'false'
LINES_AFTER_RUN1=$(wc -l < "$LEDGER_RW" | tr -d ' ')
OUT_RW2="$(bash "$ANALYZER" --ledger "$LEDGER_RW" "$RW/economics.jsonl")"
aeq "$OUT_RW2" "repeat-window run2: already_proposed == true (de-duped)" '.proposals[] | select(.pattern=="kit-review-cost-inflation") | .already_proposed' 'true'
LINES_AFTER_RUN2=$(wc -l < "$LEDGER_RW" | tr -d ' ')
[[ "$LINES_AFTER_RUN1" == "$LINES_AFTER_RUN2" ]] && pass "ledger line count unchanged across the second run ($LINES_AFTER_RUN2 lines)" || fail "ledger grew on the second run: $LINES_AFTER_RUN1 -> $LINES_AFTER_RUN2"
UNIQUE_IDS=$(jq -r '.proposal_id' "$LEDGER_RW" | sort -u | wc -l | tr -d ' ')
TOTAL_IDS=$(jq -r '.proposal_id' "$LEDGER_RW" | wc -l | tr -d ' ')
[[ "$UNIQUE_IDS" == "$TOTAL_IDS" ]] && pass "no duplicate proposal_id in the ledger ($TOTAL_IDS line(s), $UNIQUE_IDS unique)" || fail "duplicate proposal_id found: $TOTAL_IDS lines but $UNIQUE_IDS unique"

# ── AC3: zero mutation to kit/gate/flow config; decide.sh refuses --follow-on-ref w/o --ratify ────
echo "--- AC3: analyzer + decide.sh make zero mutation to kits/**/.datum/config.json ---"
_snapshot() { find "$ROOT/kits" "$ROOT/.datum" -type f 2>/dev/null | sort | xargs shasum 2>/dev/null | shasum | awk '{print $1}'; }
BEFORE_HASH="$(_snapshot)"
# Re-run the analyzer over every fixture (already exercised above) plus a decide.sh call, all
# pointed at TMP-sandboxed ledgers/paths only — never at anything under kits/ or .datum/.
: "$(bash "$ANALYZER" --sessions-root "$PP/sessions" --ledger "$TMP/ledger-ac3-scratch.jsonl" "$PP/economics.jsonl")"
SCRATCH_PID="$(jq -r '.proposal_id' "$TMP/ledger-ac3-scratch.jsonl" | head -1)"
: "$(bash "$DECIDER" "$TMP/ledger-ac3-scratch.jsonl" "$SCRATCH_PID" --ratify --decided-by tester --follow-on-ref "https://example.invalid/1" 2>/dev/null)"
AFTER_HASH="$(_snapshot)"
[[ "$BEFORE_HASH" == "$AFTER_HASH" ]] && pass "kits/ and .datum/ content hash unchanged after analyzer + decide.sh runs" || fail "kits/ or .datum/ content changed (mutation detected!)"

# decide.sh refuses --follow-on-ref without --ratify (checksum-verified no-write).
DECIDE_LEDGER="$TMP/ledger-decide-guard.jsonl"
cp "$LEDGER_RW" "$DECIDE_LEDGER"
GUARD_PID="$(jq -r '.proposal_id' "$DECIDE_LEDGER" | head -1)"
CHECKSUM_BEFORE="$(shasum "$DECIDE_LEDGER" | awk '{print $1}')"
bash "$DECIDER" "$DECIDE_LEDGER" "$GUARD_PID" --reject --decided-by tester --follow-on-ref "https://example.invalid/2" >/dev/null 2>&1
GUARD_RC=$?
CHECKSUM_AFTER="$(shasum "$DECIDE_LEDGER" | awk '{print $1}')"
[[ "$GUARD_RC" -ne 0 ]] && pass "decide.sh exits non-zero for --follow-on-ref without --ratify" || fail "decide.sh should have refused --follow-on-ref without --ratify"
[[ "$CHECKSUM_BEFORE" == "$CHECKSUM_AFTER" ]] && pass "decide.sh wrote nothing when refusing --follow-on-ref without --ratify" || fail "decide.sh wrote despite refusing"

# decide.sh also refuses an unknown proposal-id, and more than one of --ratify/--reject/--defer.
if bash "$DECIDER" "$DECIDE_LEDGER" "no-such-proposal-id" --ratify --decided-by tester >/dev/null 2>&1; then
  fail "decide.sh should refuse an unknown proposal-id"
else
  pass "decide.sh refuses an unknown proposal-id"
fi
if bash "$DECIDER" "$DECIDE_LEDGER" "$GUARD_PID" --ratify --reject --decided-by tester >/dev/null 2>&1; then
  fail "decide.sh should refuse conflicting decision flags"
else
  pass "decide.sh refuses more than one of --ratify/--reject/--defer"
fi

# ── AC5: ratify a pattern-present proposal, then a later window fills in effect_observed ──────────
echo "--- AC5: ratify pattern-present proposal -> follow_on_ref set; later window fills effect_observed ---"
EF="$FIX/effect-follow-up"
LEDGER_AC5="$TMP/ledger-ac5.jsonl"
OUT_AC5_1="$(bash "$ANALYZER" --sessions-root "$PP/sessions" --ledger "$LEDGER_AC5" "$PP/economics.jsonl")"
AC5_PID="$(printf '%s' "$OUT_AC5_1" | jq -r '.proposals[] | select(.pattern=="kit-review-cost-inflation") | .proposal_id')"
FOLLOW_ON_URL="https://github.com/kontourai/flow-agents/issues/99999"
bash "$DECIDER" "$LEDGER_AC5" "$AC5_PID" --ratify --decided-by "eval-tester" --follow-on-ref "$FOLLOW_ON_URL" >/dev/null
RATIFIED_ENTRY="$(jq -c --arg pid "$AC5_PID" 'select(.proposal_id == $pid)' "$LEDGER_AC5")"
[[ "$(printf '%s' "$RATIFIED_ENTRY" | jq -r '.decision.status')" == "ratified" ]] && pass "ledger entry decision.status == ratified after decide.sh --ratify" || fail "decision.status not ratified"
[[ "$(printf '%s' "$RATIFIED_ENTRY" | jq -r '.follow_on_ref')" == "$FOLLOW_ON_URL" ]] && pass "ledger entry follow_on_ref set to the fixture issue URL" || fail "follow_on_ref not set"
[[ "$(printf '%s' "$RATIFIED_ENTRY" | jq -c '.effect_observed')" == "null" ]] && pass "effect_observed still null before the later window pass" || fail "effect_observed should still be null before a later pass"

OUT_AC5_2="$(bash "$ANALYZER" --sessions-root "$EF/sessions" --ledger "$LEDGER_AC5" "$EF/economics.jsonl")"
RATIFIED_ENTRY_2="$(jq -c --arg pid "$AC5_PID" 'select(.proposal_id == $pid)' "$LEDGER_AC5")"
EFFECT="$(printf '%s' "$RATIFIED_ENTRY_2" | jq -c '.effect_observed')"
[[ "$EFFECT" != "null" ]] && pass "effect_observed populated after the later effect-follow-up window ($EFFECT)" || fail "effect_observed still null after the later window pass"
aeq "$RATIFIED_ENTRY_2" "effect_observed.metric == avg_cost_usd" '.effect_observed.metric' '"avg_cost_usd"'
aeq "$RATIFIED_ENTRY_2" "effect_observed.before == 0.2 (original evidence.cost.second_half_avg_cost_usd)" '.effect_observed.before' '0.2'
aeq "$RATIFIED_ENTRY_2" "effect_observed.after == 0.05 (effect-follow-up's second_half_avg_cost_usd)" '.effect_observed.after' '0.05'
aeq "$RATIFIED_ENTRY_2" "effect_observed.moved == improved (cost fell, expected_effect.direction was decrease)" '.effect_observed.moved' '"improved"'
: "$OUT_AC5_2"

# ── regression: --since/--until ISO-8601 (date-only, Z, +00:00) all parse to a real windowed pass ──
# Code-review iteration 2 finding [HIGH]: to_epoch_ms's old `sub("Z$"; "+00:00")` direction broke
# every ISO-8601 input (jq's fromdateiso8601 only understands a literal "Z", never "+00:00"), so a
# genuinely parseable --since/--until silently produced a FALSE "insufficient-data"/fallback-envelope
# outcome instead of a real windowed analysis. pattern-present's fixture .at values all fall on
# 2025-07-02 (23:46:40-45 UTC) — cover date-only, full-ISO-with-Z, and full-ISO-with-+00:00 bounds.
echo "--- regression: ISO-8601 --since/--until (date-only, Z, +00:00) parse correctly (not a false insufficient-data) ---"
OUT_ISO_DATEONLY="$(bash "$ANALYZER" --since 2025-07-02 --until 2025-07-03 --ledger "$TMP/ledger-iso-dateonly.jsonl" "$PP/economics.jsonl")"
aeq "$OUT_ISO_DATEONLY" "date-only --since/--until: outcome == ok (real windowed pass, not a parse-failure fallback)" '.outcome' '"ok"'
aeq "$OUT_ISO_DATEONLY" "date-only --since/--until: records_considered == 6" '.records_considered' '6'

OUT_ISO_Z="$(bash "$ANALYZER" --since 2025-07-02T00:00:00Z --until 2025-07-03T00:00:00Z --ledger "$TMP/ledger-iso-z.jsonl" "$PP/economics.jsonl")"
aeq "$OUT_ISO_Z" "full ISO-8601 with Z: outcome == ok" '.outcome' '"ok"'
aeq "$OUT_ISO_Z" "full ISO-8601 with Z: records_considered == 6" '.records_considered' '6'

OUT_ISO_OFFSET="$(bash "$ANALYZER" --since 2025-07-02T00:00:00+00:00 --until 2025-07-03T00:00:00+00:00 --ledger "$TMP/ledger-iso-offset.jsonl" "$PP/economics.jsonl")"
aeq "$OUT_ISO_OFFSET" "full ISO-8601 with +00:00 offset: outcome == ok" '.outcome' '"ok"'
aeq "$OUT_ISO_OFFSET" "full ISO-8601 with +00:00 offset: records_considered == 6" '.records_considered' '6'

# all three forms resolve to byte-identical effective window bounds.
WIN_DATEONLY="$(printf '%s' "$OUT_ISO_DATEONLY" | jq -c '.window')"
WIN_Z="$(printf '%s' "$OUT_ISO_Z" | jq -c '.window')"
WIN_OFFSET="$(printf '%s' "$OUT_ISO_OFFSET" | jq -c '.window')"
[[ "$WIN_DATEONLY" == "$WIN_Z" && "$WIN_Z" == "$WIN_OFFSET" ]] && pass "date-only / Z / +00:00 all resolve to the identical effective window ($WIN_Z)" || fail "window bounds diverged: dateonly=$WIN_DATEONLY z=$WIN_Z offset=$WIN_OFFSET"

# a record's own ISO .at (not just --since/--until) also parses: reuse balanced fixture's epoch .at
# values by re-deriving an equivalent ISO-stamped record set on the fly (no new fixture file needed).
ISO_AT_LOG="$TMP/iso-at.jsonl"
jq -c '.at |= ((tonumber / 1000) | todateiso8601)' "$PP/economics.jsonl" > "$ISO_AT_LOG"
OUT_ISO_AT="$(bash "$ANALYZER" --ledger "$TMP/ledger-iso-at.jsonl" "$ISO_AT_LOG")"
aeq "$OUT_ISO_AT" "record .at as full ISO-8601 (Z) parses: outcome == ok" '.outcome' '"ok"'
aeq "$OUT_ISO_AT" "record .at as full ISO-8601 (Z) parses: records_considered == 6" '.records_considered' '6'

# ── regression: fractional-second ISO-8601 (.sssZ / .sss+00:00) parses to a real windowed pass ─────
# Code-review iteration 3 finding [MEDIUM]: a JS Date.toISOString()-style fractional-second
# timestamp (e.g. 2025-07-01T00:00:00.123Z) used to hit the old `test("Z$")` branch and throw
# inside fromdateiso8601 (which only understands whole seconds), silently degrading to a false
# insufficient-data/fallback-envelope outcome instead of a real windowed analysis.
echo "--- regression: fractional-second ISO-8601 (.sssZ / .sss+00:00) --since/--until parse correctly ---"
OUT_FRAC_Z="$(bash "$ANALYZER" --since "2025-07-02T00:00:00.000Z" --until "2025-07-03T00:00:00.999Z" --ledger "$TMP/ledger-frac-z.jsonl" "$PP/economics.jsonl")"
aeq "$OUT_FRAC_Z" "fractional-second ISO with Z: outcome == ok" '.outcome' '"ok"'
aeq "$OUT_FRAC_Z" "fractional-second ISO with Z: records_considered == 6" '.records_considered' '6'

OUT_FRAC_OFFSET="$(bash "$ANALYZER" --since "2025-07-02T00:00:00.000+00:00" --until "2025-07-03T00:00:00.999+00:00" --ledger "$TMP/ledger-frac-offset.jsonl" "$PP/economics.jsonl")"
aeq "$OUT_FRAC_OFFSET" "fractional-second ISO with +00:00 offset: outcome == ok" '.outcome' '"ok"'
aeq "$OUT_FRAC_OFFSET" "fractional-second ISO with +00:00 offset: records_considered == 6" '.records_considered' '6'

# ── regression: a garbage --since/--until FAILS LOUD (never masquerades as insufficient-data) ──────
# Code-review iteration 3 finding [MEDIUM] item 2: an unrecognized --since/--until value is
# operator-correctable CLI input and must exit non-zero with a stderr message — NEVER silently
# look like an honest "insufficient-data" result (which would hide a usage error as a data gap).
echo "--- regression: garbage --since exits non-zero with a stderr message, NOT insufficient-data ---"
GARBAGE_STDOUT="$TMP/garbage-since-stdout.txt"
GARBAGE_STDERR="$TMP/garbage-since-stderr.txt"
LEDGER_GARBAGE="$TMP/ledger-garbage-since.jsonl"
bash "$ANALYZER" --since "notadate" --ledger "$LEDGER_GARBAGE" "$PP/economics.jsonl" >"$GARBAGE_STDOUT" 2>"$GARBAGE_STDERR"
GARBAGE_RC=$?
[[ "$GARBAGE_RC" -ne 0 ]] && pass "garbage --since exits non-zero (rc=$GARBAGE_RC)" || fail "garbage --since should have exited non-zero (rc=$GARBAGE_RC)"
[[ ! -s "$GARBAGE_STDOUT" ]] && pass "garbage --since prints no stdout document (never a fabricated insufficient-data envelope)" || fail "garbage --since printed a document: $(cat "$GARBAGE_STDOUT")"
grep -qi "invalid --since" "$GARBAGE_STDERR" && pass "garbage --since prints a clear stderr diagnostic" || fail "garbage --since produced no clear stderr diagnostic: $(cat "$GARBAGE_STDERR")"
[[ ! -e "$LEDGER_GARBAGE" ]] && pass "garbage --since writes no ledger file" || fail "garbage --since unexpectedly created a ledger file"

# ── regression: a corrupted ledger line FAILS LOUD, writes NOTHING, valid entries survive ──────────
# Code-review iteration 2 finding [CRITICAL]: `jq -s` on a malformed ledger line used to fail
# silently, fall back to "[]", and the later mv would overwrite the ledger — silently destroying
# every recorded human ratify/reject/defer decision. Must now exit non-zero with zero bytes written.
echo "--- regression: malformed ledger line -> analyzer exits non-zero, writes nothing, valid entry survives ---"
CORRUPT_LEDGER="$TMP/ledger-corrupt.jsonl"
cat > "$CORRUPT_LEDGER" <<'EOF2'
{"proposal_id":"valid-1","target":{"kind":"kit","id":"builder"},"pattern":"kit-review-cost-inflation","proposed_change":"x","severity":"advisory","evidence":{"cost":{},"defect":{}},"expected_effect":{"metric":"avg_cost_usd","direction":"decrease","description":"x"},"decision":{"status":"ratified","decided_by":"tester","decided_at":"2026-01-01T00:00:00Z","rationale":"r"},"follow_on_ref":"https://example.invalid/1","effect_observed":null,"window":{"since":1000,"until":2000}}
{this line is not valid json at all
EOF2
CORRUPT_BEFORE_HASH="$(shasum "$CORRUPT_LEDGER" | awk '{print $1}')"
EMPTY_LOG="$TMP/empty-for-corrupt.jsonl"
: > "$EMPTY_LOG"
CORRUPT_STDOUT="$(bash "$ANALYZER" --ledger "$CORRUPT_LEDGER" "$EMPTY_LOG" 2>"$TMP/corrupt-stderr.txt")"
CORRUPT_RC=$?
CORRUPT_AFTER_HASH="$(shasum "$CORRUPT_LEDGER" | awk '{print $1}')"
[[ "$CORRUPT_RC" -ne 0 ]] && pass "analyzer exits non-zero on a corrupted ledger (rc=$CORRUPT_RC)" || fail "analyzer should have exited non-zero on a corrupted ledger (rc=$CORRUPT_RC)"
[[ -z "$CORRUPT_STDOUT" ]] && pass "analyzer prints no stdout document on a corrupted ledger (fail loud, not a silent fallback envelope)" || fail "analyzer printed a document despite a corrupted ledger: $CORRUPT_STDOUT"
[[ -s "$TMP/corrupt-stderr.txt" ]] && pass "analyzer prints a stderr diagnostic on a corrupted ledger" || fail "analyzer produced no stderr diagnostic"
[[ "$CORRUPT_BEFORE_HASH" == "$CORRUPT_AFTER_HASH" ]] && pass "corrupted ledger file is byte-identical after the run (zero bytes written)" || fail "corrupted ledger file was mutated (data-loss regression!)"
grep -q '"proposal_id":"valid-1"' "$CORRUPT_LEDGER" && pass "the valid ledger entry (with its ratified decision) survives untouched" || fail "the valid ledger entry was lost"

# ── Schema validation (Ajv, mirroring test_economics_record.sh's approach) ─────────────────────────
echo "--- schema: pattern-present output validates; a doctored cost-only proposal FAILS (Goodhart guard) ---"
if node -e "require.resolve('ajv')" >/dev/null 2>&1; then
  SCHEMA_CHECK="$(node -e '
const Ajv=require("ajv");
const a=new Ajv({allErrors:true,strict:false});
const v=a.compile(require(process.argv[1]));
const doc=JSON.parse(process.argv[2]);
const docOk=v(doc);
const bad=JSON.parse(JSON.stringify(doc));
if (bad.proposals && bad.proposals.length > 0) { delete bad.proposals[0].evidence.defect; }
const badOk=v(bad);
console.log(JSON.stringify({docOk, badOk, errors: v.errors}));
' "$SCHEMA" "$OUT_PP" 2>&1)"
  echo "$SCHEMA_CHECK" | grep -q '"docOk":true' && pass "pattern-present output validates against learning-review-proposals.schema.json" || fail "pattern-present output did NOT validate: $SCHEMA_CHECK"
  echo "$SCHEMA_CHECK" | grep -q '"badOk":false' && pass "cost-only proposal (defect deleted) FAILS validation — Goodhart co-required guard holds" || fail "cost-only proposal wrongly validated: $SCHEMA_CHECK"
else
  echo "  NOT_VERIFIED: ajv module unavailable (no node_modules/ajv) — schema validation skipped. Run \`npm ci\` to enable this check."
fi

# ── static guard: neither script writes to kits/** or .datum/config.json (mirrors #415's guard) ───
echo "--- static guard: neither script references kits/**/.datum/config.json outside a 'never' disclaimer ---"
for f in "$ANALYZER" "$DECIDER"; do
  name="$(basename "$f")"
  if grep -qE '\.datum/config\.json' "$f" && ! grep -qE 'never (writes?|edit|auto-appl)' "$f"; then
    fail "$name references .datum/config.json outside a 'never write' disclaimer"
  else
    pass "$name never writes .datum/config.json (advisory only, human-ratified)"
  fi
  if grep -qE 'kits/\*\*|kits/<' "$f" && ! grep -qE 'never (writes?|edit|auto-appl)' "$f"; then
    fail "$name references kits/** outside a 'never write' disclaimer"
  else
    pass "$name never writes kits/** (advisory only, human-ratified)"
  fi
done

echo ""
if [[ "$errors" -eq 0 ]]; then echo "test_learning_review_proposals: all checks passed."; exit 0
else echo "test_learning_review_proposals: $errors check(s) failed."; exit 1; fi
