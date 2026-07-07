#!/usr/bin/env bash
# learning-review-proposals.sh — turn recorded kontour.console.economics outcomes into per-kit/per-gate
# tuning PROPOSALS (#352), generalizing the routing-efficiency.sh (#415) shape from per-(role,model) to
# per-kit/per-gate.
#
# Reads a window of economics.jsonl records, joins each record's kit identity (trust.bundle
# claims[].claimType prefix) and gate identity (gate-review.inquiries.json InquiryRecord calibration),
# computes per-kit/per-gate aggregates, and emits ADVISORY proposals into a durable, idempotent ledger.
# NEVER writes to kits/**, .datum/config.json, or any gate/flow config file (ADR 0002/0003 call 5,
# ADR 0008/0010 consume-never-fork) — this is a pure downstream consumer of fa#349's record and
# gate-review's InquiryRecord output; neither is ever invoked or modified by this script.
#
# See docs/specs/learning-review-proposals-contract.md for the full formula/ledger/effect-fill spec.
#
# Usage:
#   learning-review-proposals.sh [economics.jsonl ...]      # defaults to the local economics log
#   cat economics.jsonl | learning-review-proposals.sh -    # records on stdin
#   learning-review-proposals.sh --since ISO_OR_EPOCH --until ISO_OR_EPOCH \
#     --sessions-root DIR --ledger PATH
#
# Tunables (env): LR_MIN_WINDOW_SAMPLE (5), LR_MIN_KIT_SAMPLE (6), LR_MIN_GATE_SAMPLE (3),
#   LR_COST_RISE_PCT (25), LR_FLAT_FINDINGS_PCT (10), LR_GATE_FALSE_BLOCK_RATE (0.5),
#   LR_GATE_WELL_CALIBRATED_RATE (0.9).
set -uo pipefail

usage() {
  cat <<'USAGE'
Usage: learning-review-proposals.sh [economics.jsonl ...] [--since VAL] [--until VAL]
                                     [--sessions-root DIR] [--ledger PATH]
       cat economics.jsonl | learning-review-proposals.sh -

  --since VAL           ISO-8601 (no fractional seconds) or epoch-ms lower bound on record .at
  --until VAL           ISO-8601 (no fractional seconds) or epoch-ms upper bound on record .at
  --sessions-root DIR   root for <task_slug>/trust.bundle + <task_slug>/gate-review.inquiries.json
                        joins (default: .kontourai/flow-agents)
  --ledger PATH         proposal ledger path (default: .kontourai/telemetry/learning-review-proposals.jsonl,
                        override via LEARNING_REVIEW_PROPOSALS_LEDGER)
  -h, --help            show this help

Advisory only — never writes kits/**, .datum/config.json, or any gate/flow config file.
See docs/specs/learning-review-proposals-contract.md for the full contract.
USAGE
}

command -v jq >/dev/null 2>&1 || {
  echo '{"schema":"kontour.learning-review-proposals","version":"0.1","window":{"since":null,"until":null},"records_considered":0,"outcome":"insufficient-data","aggregates":{"by_kit":[],"by_gate":[],"partial":true},"proposals":[],"notes":["jq unavailable — no analysis"]}'
  exit 0
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 0
default_log="${TELEMETRY_ECONOMICS_LOG_FILE:-${TELEMETRY_DATA_DIR:-${SCRIPT_DIR}/../..}/.kontourai/telemetry/economics.jsonl}"
default_sessions_root="${SCRIPT_DIR}/../../.kontourai/flow-agents"
default_ledger="${LEARNING_REVIEW_PROPOSALS_LEDGER:-${TELEMETRY_DATA_DIR:-${SCRIPT_DIR}/../..}/.kontourai/telemetry/learning-review-proposals.jsonl}"

since_arg=""
until_arg=""
sessions_root="$default_sessions_root"
ledger_path="$default_ledger"
sources=()

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --since) since_arg="${2:-}"; shift 2 ;;
    --until) until_arg="${2:-}"; shift 2 ;;
    --sessions-root) sessions_root="${2:-}"; shift 2 ;;
    --ledger) ledger_path="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    --) shift; while [[ "$#" -gt 0 ]]; do sources+=("$1"); shift; done ;;
    *) sources+=("$1"); shift ;;
  esac
done

min_window_sample="${LR_MIN_WINDOW_SAMPLE:-5}"
min_kit_sample="${LR_MIN_KIT_SAMPLE:-6}"
min_gate_sample="${LR_MIN_GATE_SAMPLE:-3}"
cost_rise_pct="${LR_COST_RISE_PCT:-25}"
flat_findings_pct="${LR_FLAT_FINDINGS_PCT:-10}"
gate_false_block_rate="${LR_GATE_FALSE_BLOCK_RATE:-0.5}"
gate_well_calibrated_rate="${LR_GATE_WELL_CALIBRATED_RATE:-0.9}"

# Shared to_epoch_ms jq def (single source of truth, reused by both the --since/--until
# pre-validation below and the main analysis pipeline, so the two can never drift out of sync).
# Parses (in order): epoch-ms number/digit-string, date-only (YYYY-MM-DD, normalized to midnight
# UTC), full ISO-8601 with optional fractional seconds and a literal "Z" offset, full ISO-8601
# with optional fractional seconds and an explicit "+00:00" UTC offset (fractional seconds and
# the offset are both stripped/converted before parsing, since fromdateiso8601 only understands
# a bare "%Y-%m-%dT%H:%M:%SZ" — never the other direction, which would silently turn a parseable
# value into an unparseable one). Any other string raises an explicit jq error (never a silent
# wrong epoch, never swallowed into a fabricated result).
to_epoch_ms_def="$(cat <<'JQDEF'
  def to_epoch_ms:
    if . == null or . == "" then null
    elif (. | type) == "number" then .
    elif (. | test("^[0-9]+$")) then (. | tonumber)
    elif (. | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")) then (. + "T00:00:00Z" | fromdateiso8601 * 1000)
    elif (. | test("\\.[0-9]+Z$")) then (. | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601 * 1000)
    elif (. | test("Z$")) then (. | fromdateiso8601 * 1000)
    elif (. | test("\\.[0-9]+\\+00:00$")) then (. | sub("\\.[0-9]+\\+00:00$"; "+00:00") | sub("\\+00:00$"; "Z") | fromdateiso8601 * 1000)
    elif (. | test("\\+00:00$")) then (. | sub("\\+00:00$"; "Z") | fromdateiso8601 * 1000)
    else error("unrecognized timestamp format: \\(.)")
    end;
JQDEF
)"

# FAIL LOUD on a malformed --since/--until BEFORE any analysis or ledger I/O: a bad CLI window
# argument is operator-correctable input and must never masquerade as "insufficient-data" (which
# would look like an honest thin-data result rather than a usage error).
validate_time_arg() {
  local label="$1" val="$2"
  [[ -z "$val" ]] && return 0
  if ! jq -e -n --arg v "$val" "${to_epoch_ms_def}
    (\$v | to_epoch_ms) != null" >/dev/null 2>&1; then
    echo "learning-review-proposals: invalid --${label} value: '${val}' (expected epoch-ms, YYYY-MM-DD, or full ISO-8601 with a Z or +00:00 offset; fractional seconds optional)" >&2
    exit 1
  fi
}
validate_time_arg "since" "$since_arg"
validate_time_arg "until" "$until_arg"

# Gather records: explicit args (a '-' means stdin), else stdin when piped, else the default local log.
records=""
if [[ "${#sources[@]}" -gt 0 ]]; then
  for src in "${sources[@]}"; do
    if [[ "$src" == "-" ]]; then records+="$(cat 2>/dev/null)"$'\n'
    elif [[ -f "$src" ]]; then records+="$(cat "$src" 2>/dev/null)"$'\n'; fi
  done
elif [[ ! -t 0 ]]; then
  records="$(cat 2>/dev/null)"
elif [[ -f "$default_log" ]]; then
  records="$(cat "$default_log" 2>/dev/null)"
fi

fallback_envelope() {
  echo '{"schema":"kontour.learning-review-proposals","version":"0.1","window":{"since":null,"until":null},"records_considered":0,"outcome":"insufficient-data","aggregates":{"by_kit":[],"by_gate":[],"partial":true},"proposals":[],"notes":["no parseable records"]}'
}

records_json="$(printf '%s' "$records" | jq -s -c '[ .[] | select(type == "object" and .schema == "kontour.console.economics") ]' 2>/dev/null)"
[[ -n "$records_json" ]] || { fallback_envelope; exit 0; }

# Distinct, non-null task_slugs present in the gathered records — the join keys we need to resolve.
slugs="$(printf '%s' "$records_json" | jq -r '[ .[] | .task_slug | select(. != null) ] | unique[]' 2>/dev/null)"

# Build the session join array: one entry per distinct task_slug, {task_slug, kit_id, gate_rows}.
session_join="[]"
if [[ -n "$slugs" ]]; then
  join_entries=()
  while IFS= read -r slug; do
    [[ -n "$slug" ]] || continue
    bundle="${sessions_root}/${slug}/trust.bundle"
    inquiries="${sessions_root}/${slug}/gate-review.inquiries.json"
    kit_id="unattributed"
    if [[ -f "$bundle" ]]; then
      resolved="$(jq -r '
        [ .claims[]?.claimType | select(. != null) | split(".")[0] ]
        | if length == 0 then "unattributed"
          else (group_by(.) | max_by(length) | .[0]) end
      ' "$bundle" 2>/dev/null)"
      [[ -n "$resolved" && "$resolved" != "null" ]] && kit_id="$resolved"
    fi
    gate_rows="[]"
    if [[ -f "$inquiries" ]]; then
      resolved_rows="$(jq -c '
        [ .[]? | select(.inquiry.target.fieldOrBehavior != null) |
          { gate_id: .inquiry.target.fieldOrBehavior,
            outcome: .answer.value.calibration,
            fired: (.answer.value.gateFired // false) } ]
      ' "$inquiries" 2>/dev/null)"
      [[ -n "$resolved_rows" ]] && gate_rows="$resolved_rows"
    fi
    join_entries+=("$(jq -c -n --arg slug "$slug" --arg kit_id "$kit_id" --argjson gate_rows "$gate_rows" \
      '{task_slug: $slug, kit_id: $kit_id, gate_rows: $gate_rows}')")
  done <<< "$slugs"
  if [[ "${#join_entries[@]}" -gt 0 ]]; then
    session_join="$(printf '%s\n' "${join_entries[@]}" | jq -s -c '.')"
  fi
fi

now_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Main analysis pass: window filter, kit/gate join, aggregates, proposal rules. The filter text is
# assembled from the shared $to_epoch_ms_def (single source of truth with the pre-validation
# above) concatenated with the rest of the program, then passed as ONE filter argument to jq
# (jq only accepts a single FILTER argument; passing the def as a separate positional argument
# would be mis-parsed as an input FILE, not appended to the filter).
main_jq_program="$to_epoch_ms_def"
# shellcheck disable=SC2016
# ^ this and every other single-quoted append below is a literal jq program fragment (its "$vars"
#   are jq variables, bound later via --arg/--argjson) — never intended for bash expansion, the
#   same deliberate idiom every other jq invocation in this file already uses as a direct argument.
main_jq_program+='
  def round4: (. * 10000 | round) / 10000;

  ($since_raw | to_epoch_ms) as $since_ms
  | ($until_raw | to_epoch_ms) as $until_ms

  # window-filtered records, each carrying its kit_id + gate_rows join
  | [ $recs[]
      | select(
          (try (.at | to_epoch_ms) catch null) as $at_ms
          | ($since_ms == null or $at_ms == null or $at_ms >= $since_ms)
          and ($until_ms == null or $at_ms == null or $at_ms <= $until_ms)
        )
      | . as $rec
      | ( [ $sessions[] | select(.task_slug == $rec.task_slug) ] | first ) as $join
      | {
          rec: $rec,
          at_ms: (try (.at | to_epoch_ms) catch null),
          kit_id: ($join.kit_id // "unattributed"),
          gate_rows: ($join.gate_rows // [])
        }
    ] as $windowed

  | ($windowed | length) as $records_considered
  | (if $records_considered < $min_window_sample then "insufficient-data" else "ok" end) as $outcome

  # effective window bounds: explicit arg else observed min/max .at
  | ( [ $windowed[] | .at_ms | select(. != null) ] ) as $at_values
  | (if $since_ms != null then $since_ms elif ($at_values | length) > 0 then ($at_values | min) else null end) as $eff_since
  | (if $until_ms != null then $until_ms elif ($at_values | length) > 0 then ($at_values | max) else null end) as $eff_until

  # ---- by_kit aggregates ----
  | ( $windowed
      | group_by(.kit_id)
      | map(
          . as $g
          | ($g[0].kit_id) as $kit_id
          | ($g | length) as $runs
          | ($g | sort_by(.at_ms // 0)) as $sorted
          | (($runs / 2) | floor) as $half_point
          | ($sorted[0:$half_point]) as $first_half
          | ($sorted[$half_point:$runs]) as $second_half
          | (if ($first_half | length) > 0 then (($first_half | map(.rec.cost.estimated_cost_usd // 0) | add) / ($first_half | length)) else null end) as $fh_cost
          | (if ($second_half | length) > 0 then (($second_half | map(.rec.cost.estimated_cost_usd // 0) | add) / ($second_half | length)) else null end) as $sh_cost
          | (if $fh_cost == null or $fh_cost == 0 then null else (((($sh_cost // 0) - $fh_cost) / $fh_cost) * 100) end) as $cost_trend_pct
          | ($first_half | map(.rec.defects.findings_by_severity as $f | ($f.critical // 0) + ($f.high // 0) + ($f.medium // 0) + ($f.low // 0)) | add // 0) as $fh_findings
          | ($second_half | map(.rec.defects.findings_by_severity as $f | ($f.critical // 0) + ($f.high // 0) + ($f.medium // 0) + ($f.low // 0)) | add // 0) as $sh_findings
          | (if $fh_findings == 0 then (if $sh_findings == 0 then 0 else null end) else ((($sh_findings - $fh_findings) / $fh_findings) * 100) end) as $findings_delta_pct
          | ($g | map(.rec.time.wall_clock_s // 0) | add / $runs) as $avg_wall_clock_s
          | ($g | map(.rec.time.human_wait_s // 0) | add / $runs) as $avg_human_wait_s
          | ($g | map(.rec.iterations.count // 0) | add) as $count_sum
          | ($g | map(.rec.iterations.route_backs // 0) | add) as $route_back_sum
          | (if $count_sum == 0 then null else ($route_back_sum / $count_sum) end) as $route_back_rate
          | ($g | map(.rec.defects.caught_false_completions // 0) | add) as $caught_false_completions_total
          | {
              kit_id: $kit_id,
              runs: $runs,
              first_half_avg_cost_usd: ($fh_cost | if . == null then null else round4 end),
              second_half_avg_cost_usd: ($sh_cost | if . == null then null else round4 end),
              cost_trend_pct: ($cost_trend_pct | if . == null then null else round4 end),
              first_half_findings_total: $fh_findings,
              second_half_findings_total: $sh_findings,
              findings_delta_pct: ($findings_delta_pct | if . == null then null else round4 end),
              avg_wall_clock_s: ($avg_wall_clock_s | round4),
              avg_human_wait_s: ($avg_human_wait_s | round4),
              route_back_rate: ($route_back_rate | if . == null then null else round4 end),
              caught_false_completions_total: $caught_false_completions_total
            }
        )
      | sort_by(.kit_id)
    ) as $by_kit

  # ---- by_gate aggregates ----
  # Each flattened gate row carries the ORIGINAL record'\''s index in $windowed (._idx) as a stable
  # per-record identity key for the "when fired" dedupe below — never a (value-tuple) key, which
  # would wrongly collapse distinct records that happen to share identical timing values.
  | ( [ $windowed | to_entries[] | .key as $idx | .value as $w
        | $w.gate_rows[] | . + { _idx: $idx, _wall_clock_s: $w.rec.time.wall_clock_s, _human_wait_s: $w.rec.time.human_wait_s } ]
    ) as $gate_rows_flat
  | ( $gate_rows_flat
      | group_by(.gate_id)
      | map(
          . as $g
          | ($g[0].gate_id) as $gate_id
          | ($g | length) as $fire_count
          | ([ $g[] | select(.outcome == "correct") ] | length) as $correct_count
          | ([ $g[] | select(.outcome == "false_block") ] | length) as $false_block_count
          | ([ $g[] | select(.outcome == "missed_block") ] | length) as $missed_block_count
          | (if $fire_count == 0 then null else ($false_block_count / $fire_count) end) as $false_block_rate
          | ( [ $g[] | select(.fired == true) | { idx: ._idx, wall_clock_s: ._wall_clock_s, human_wait_s: ._human_wait_s } ] | unique_by(.idx) ) as $fired_records
          | (if ($fired_records | length) > 0 then (($fired_records | map(.wall_clock_s // 0) | add) / ($fired_records | length)) else null end) as $avg_wall_clock_s_when_fired
          | (if ($fired_records | length) > 0 then (($fired_records | map(.human_wait_s // 0) | add) / ($fired_records | length)) else null end) as $avg_human_wait_s_when_fired
          | {
              gate_id: $gate_id,
              fire_count: $fire_count,
              correct_count: $correct_count,
              false_block_count: $false_block_count,
              missed_block_count: $missed_block_count,
              false_block_rate: ($false_block_rate | if . == null then null else round4 end),
              avg_wall_clock_s_when_fired: ($avg_wall_clock_s_when_fired | if . == null then null else round4 end),
              avg_human_wait_s_when_fired: ($avg_human_wait_s_when_fired | if . == null then null else round4 end)
            }
        )
      | sort_by(.gate_id)
    ) as $by_gate

  | (if $outcome == "insufficient-data" then [] else (
      ($by_kit | map(
        select(.runs >= $min_kit_sample and .cost_trend_pct != null and .cost_trend_pct >= $cost_rise_pct
               and .findings_delta_pct != null and .findings_delta_pct <= $flat_findings_pct)
        | {
            target: { kind: "kit", id: .kit_id },
            pattern: "kit-review-cost-inflation",
            proposed_change: ("Review " + .kit_id + "'\''s recent-run review depth/scope: cost per run rose " + (.cost_trend_pct | tostring) + "% while findings caught stayed flat/declined (" + (.findings_delta_pct | tostring) + "%)."),
            severity: "advisory",
            evidence: {
              cost: { first_half_avg_cost_usd: .first_half_avg_cost_usd, second_half_avg_cost_usd: .second_half_avg_cost_usd, cost_trend_pct: .cost_trend_pct },
              defect: { first_half_findings_total: .first_half_findings_total, second_half_findings_total: .second_half_findings_total, findings_delta_pct: .findings_delta_pct, caught_false_completions_total: .caught_false_completions_total }
            },
            expected_effect: { metric: "avg_cost_usd", direction: "decrease", description: "cost should come back down without a corresponding rise in escaped defects" }
          }
      ))
      + ($by_gate | map(
        select(.fire_count >= $min_gate_sample and .false_block_rate != null and .false_block_rate >= $gate_false_block_rate)
        | {
            target: { kind: "gate", id: .gate_id },
            pattern: "gate-false-block-review",
            proposed_change: ("Review gate \"" + .gate_id + "\": false_block_rate is " + (.false_block_rate | tostring) + " over " + (.fire_count | tostring) + " fires — it is blocking on already-passing claims more often than not."),
            severity: "advisory",
            evidence: {
              cost: { avg_wall_clock_s_when_fired: .avg_wall_clock_s_when_fired, avg_human_wait_s_when_fired: .avg_human_wait_s_when_fired },
              defect: { fire_count: .fire_count, correct_count: .correct_count, false_block_count: .false_block_count, missed_block_count: .missed_block_count }
            },
            expected_effect: { metric: "false_block_rate", direction: "decrease", description: "false_block_rate should fall toward correctly-calibrated blocking" }
          }
      ))
      + ($by_gate | map(
        select(.fire_count >= $min_gate_sample and .correct_count != null and .fire_count > 0
               and (.correct_count / .fire_count) >= $gate_well_calibrated_rate
               and .false_block_count == 0 and .missed_block_count == 0)
        | {
            target: { kind: "gate", id: .gate_id },
            pattern: "gate-well-calibrated",
            proposed_change: ("Gate \"" + .gate_id + "\" is well-calibrated over " + (.fire_count | tostring) + " fires (" + (.correct_count | tostring) + " correct, 0 false-block, 0 missed-block) — no change needed."),
            severity: "advisory",
            evidence: {
              cost: { avg_wall_clock_s_when_fired: .avg_wall_clock_s_when_fired, avg_human_wait_s_when_fired: .avg_human_wait_s_when_fired },
              defect: { fire_count: .fire_count, correct_count: .correct_count, false_block_count: .false_block_count, missed_block_count: .missed_block_count }
            },
            expected_effect: { metric: "false_block_rate", direction: "maintain", description: "gate is well-calibrated; no change expected or needed" }
          }
      ))
    ) end) as $raw_proposals

  | ($raw_proposals | map(
      . as $p
      | ("\($since_label)_\($until_label)_\($p.target.kind)-\($p.target.id)_\($p.pattern)"
         | ascii_downcase
         | gsub("[^a-z0-9]+"; "-")
         | sub("^-"; "") | sub("-$"; "")) as $proposal_id
      | $p + {
          proposal_id: $proposal_id,
          decision: { status: "proposed", decided_by: null, decided_at: null, rationale: null },
          follow_on_ref: null,
          effect_observed: null,
          window: { since: $eff_since, until: $eff_until }
        }
    )) as $proposals

  | ( [ $windowed[] | select((.rec.task_slug != null) and (.gate_rows | length) == 0) ] | length ) as $sessions_without_gate_join

  | {
      schema: "kontour.learning-review-proposals",
      version: "0.1",
      window: { since: $eff_since, until: $eff_until },
      records_considered: $records_considered,
      outcome: $outcome,
      aggregates: { by_kit: $by_kit, by_gate: $by_gate, partial: ($outcome == "insufficient-data") },
      proposals: $proposals,
      notes: (
        ["Advisory only — human-ratified via learning-review-decide.sh; never auto-applied to kits/**, .datum/config.json, or any gate/flow config."]
        + (if $outcome == "insufficient-data" then ["records_considered (\($records_considered)) below LR_MIN_WINDOW_SAMPLE (\($min_window_sample)) — insufficient data for proposals; aggregates shown for transparency only."] else [] end)
        + (if $sessions_without_gate_join > 0 then ["\($sessions_without_gate_join) record(s) with a task_slug but no gate-review.inquiries.json join (sessions without a gate-review pass)."] else [] end)
      )
    }
'

current_output="$(jq -c -n \
  --argjson recs "$records_json" \
  --argjson sessions "$session_join" \
  --arg since_raw "$since_arg" \
  --arg until_raw "$until_arg" \
  --argjson min_window_sample "$min_window_sample" \
  --argjson min_kit_sample "$min_kit_sample" \
  --argjson min_gate_sample "$min_gate_sample" \
  --argjson cost_rise_pct "$cost_rise_pct" \
  --argjson flat_findings_pct "$flat_findings_pct" \
  --argjson gate_false_block_rate "$gate_false_block_rate" \
  --argjson gate_well_calibrated_rate "$gate_well_calibrated_rate" \
  --arg since_label "${since_arg:-all}" \
  --arg until_label "${until_arg:-all}" \
  --arg now_iso "$now_iso" \
  "$main_jq_program" 2>/dev/null)"

[[ -n "$current_output" ]] || { fallback_envelope; exit 0; }

# ---- Ledger read + de-dupe + effect-fill (shell + jq per-line, not a single jq pass) ----
ledger_dir="$(dirname "$ledger_path")"
mkdir -p "$ledger_dir" 2>/dev/null || true

existing_ledger="[]"
if [[ -s "$ledger_path" ]]; then
  # FAIL LOUD, NO WRITE on a corrupted ledger: a malformed line here must never be silently
  # treated as "[]" (which would make the later mv overwrite and destroy the entire durable
  # ledger, including recorded human decisions). Only a genuinely empty/absent ledger is "[]".
  if ! existing_ledger="$(jq -s -c '.' "$ledger_path" 2>/dev/null)"; then
    echo "learning-review-proposals: ledger at '$ledger_path' failed to parse (jq -s) — refusing to run to avoid destroying existing decisions. Inspect/repair the ledger file and retry; nothing was written." >&2
    exit 1
  fi
fi

new_proposals="$(printf '%s' "$current_output" | jq -c '.proposals')"
aggregates="$(printf '%s' "$current_output" | jq -c '.aggregates')"
eff_since="$(printf '%s' "$current_output" | jq -c '.window.since')"

ledger_result="$(jq -c -n \
  --argjson existing "$existing_ledger" \
  --argjson new_proposals "$new_proposals" \
  --argjson aggregates "$aggregates" \
  --argjson eff_since "$eff_since" \
  --arg now_iso "$now_iso" \
'
  def moved_dir($direction; $before; $after):
    if $before == null or $after == null then null
    elif $after == $before then "unchanged"
    elif $direction == "decrease" then (if $after < $before then "improved" else "worsened" end)
    elif $direction == "increase" then (if $after > $before then "improved" else "worsened" end)
    else "worsened"
    end;

  ($existing | map(.proposal_id)) as $existing_ids

  | ($existing | map(
      if (.decision.status == "ratified") and (.effect_observed == null)
         and ($eff_since != null) and (.window.until != null) and (.window.until < $eff_since)
      then
        . as $entry
        | ( if $entry.target.kind == "kit"
            then ($aggregates.by_kit[]? | select(.kit_id == $entry.target.id) | .second_half_avg_cost_usd)
            else ($aggregates.by_gate[]? | select(.gate_id == $entry.target.id) | .false_block_rate)
            end ) as $after
        | (if $after == null then $entry else (
            ( if $entry.target.kind == "kit"
              then $entry.evidence.cost.second_half_avg_cost_usd
              else (if ($entry.evidence.defect.fire_count // 0) > 0 then ($entry.evidence.defect.false_block_count / $entry.evidence.defect.fire_count) else null end)
              end ) as $before
            | $entry + {
                effect_observed: {
                  measured_at: $now_iso,
                  metric: (if $entry.target.kind == "kit" then "avg_cost_usd" else "false_block_rate" end),
                  before: $before,
                  after: $after,
                  moved: moved_dir($entry.expected_effect.direction; $before; $after)
                }
              }
          ) end)
      else .
      end
    )) as $updated_existing

  | ($new_proposals | map(. + { already_proposed: ((.proposal_id as $pid | ($existing_ids | index($pid))) != null) })) as $annotated_new
  | ($annotated_new | map(select(.already_proposed == false) | del(.already_proposed))) as $to_append

  | { ledger_lines: ($updated_existing + $to_append), final_proposals: $annotated_new }
' 2>/dev/null)"

if [[ -z "$ledger_result" ]]; then
  # Ledger stage failed to parse (should not happen); fall back to the unledgered current output.
  printf '%s\n' "$current_output"
  exit 0
fi

ledger_lines="$(printf '%s' "$ledger_result" | jq -c '.ledger_lines[]' 2>/dev/null)"
final_proposals="$(printf '%s' "$ledger_result" | jq -c '.final_proposals')"

if [[ -n "$ledger_lines" ]]; then
  tmp_ledger="$(mktemp "${ledger_dir}/.learning-review-proposals.XXXXXX")" || tmp_ledger=""
  if [[ -n "$tmp_ledger" ]]; then
    printf '%s\n' "$ledger_lines" > "$tmp_ledger" && mv "$tmp_ledger" "$ledger_path"
  fi
else
  : > "$ledger_path"
fi

printf '%s' "$current_output" | jq -c --argjson proposals "$final_proposals" '.proposals = $proposals'
