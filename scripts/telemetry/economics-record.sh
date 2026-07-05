#!/usr/bin/env bash
# economics-record.sh — per-run kit-economics record emitter (#349, console ADR 0003 calls 1/2/3/6).
#
# Assembles ONE immutable `kontour.console.economics` v0.1 record per run — cost, time, iterations,
# and defects caught — the measurement substrate for the value proof (I32–I35). Modeled byte-for-byte
# on scripts/liveness/relay.sh (#295): source ${TELEMETRY_DIR}/lib/transport.sh, build the record with
# a single `jq -c` filter (valid JSON + \u-escaping of every untrusted field), then hand off to the
# SHARED `console_post_json` core. Do NOT hand-roll a curl; do NOT fork the transport.
#
# LOCAL-FIRST (ADR 0003 call 6): the record is ALWAYS written to the local economics log FIRST. The
# console POST is a detached, opt-in, best-effort fire that can NEVER block or fail a run — every
# failure path is a quiet `exit 0`. flow-agents emits a per-run FACT, never a rollup (call 3);
# aggregation/value is a console projection. Tenancy is stamped console-side from the principal (call
# 2); tenant_id here is self-description only.
#
# Ground-truth tokens/cost come from the `session.usage` event's .usage block (parsed upstream by
# usage_parse_transcript from each assistant message's .message.usage — never re-estimated). Defects
# join from the review sidecar critique.json; verdict/slug from state.json.
#
# Invoked (detached, best-effort) from scripts/telemetry/telemetry.sh after the session.usage event is
# emitted at run end. Usage:
#   economics-record.sh '<session.usage-event-json>' [--state PATH] [--acceptance PATH] [--critique PATH]
#   (the session.usage event may also arrive on stdin instead of $1)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 0

# transport.sh sources ${TELEMETRY_DIR}/lib/redact.sh at load — point it at the telemetry lib dir,
# then reuse the SAME console POST core the telemetry mirror + liveness relay use (#356: one core,
# never forked). config.sh gives us TELEMETRY_DATA_DIR for the local log location.
export TELEMETRY_DIR="${TELEMETRY_DIR:-$SCRIPT_DIR}"
[[ -f "$TELEMETRY_DIR/lib/transport.sh" ]] || exit 0
# shellcheck source=/dev/null
source "$TELEMETRY_DIR/lib/config.sh" 2>/dev/null || true
# shellcheck source=/dev/null
source "$TELEMETRY_DIR/lib/transport.sh" 2>/dev/null || exit 0

# jq is mandatory — it is what guarantees valid JSON + \u-escaping of untrusted fields. No jq ⇒ no-op.
command -v jq >/dev/null 2>&1 || exit 0

# --- parse args: the session.usage event (positional or stdin) + optional sidecar paths -------------
usage_event=""
state_path=""
acceptance_path=""
critique_path=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --state) state_path="${2:-}"; shift 2 ;;
    --acceptance) acceptance_path="${2:-}"; shift 2 ;;
    --critique) critique_path="${2:-}"; shift 2 ;;
    --) shift ;;
    *) [[ -z "$usage_event" ]] && usage_event="$1"; shift ;;
  esac
done
# Fall back to stdin when no positional event was supplied.
if [[ -z "$usage_event" && ! -t 0 ]]; then
  usage_event="$(cat 2>/dev/null || true)"
fi
[[ -z "$usage_event" ]] && exit 0

# --- read sidecars as JSON args (never the token source; join sources only) -------------------------
# Each is `null` when missing/unreadable/unparseable so the jq filter defaults cleanly.
read_json_or_null() {
  local p="$1" out
  [[ -n "$p" && -f "$p" ]] || { printf 'null'; return; }
  out="$(jq -c '.' < "$p" 2>/dev/null)" || { printf 'null'; return; }
  [[ -z "$out" ]] && out='null'
  printf '%s' "$out"
}
state_json="$(read_json_or_null "$state_path")"
critique_json="$(read_json_or_null "$critique_path")"
# acceptance.json is read for future criteria/goal_fit joins; carried but not yet a required field.
acceptance_json="$(read_json_or_null "$acceptance_path")"

tenant_self="${CONSOLE_TENANT_ID:-${FLOW_AGENTS_CONSOLE_TENANT:-}}"

# --- assemble the record with ONE jq -c filter (injection-safe, valid JSON) -------------------------
# Untrusted fields (task_slug, model names, finding text) flow through jq string handling so hostile
# control bytes are \u-escaped rather than emitted raw. NEVER printf/concatenate JSON.
record="$(printf '%s' "$usage_event" | jq -c \
  --argjson state "$state_json" \
  --argjson critique "$critique_json" \
  --argjson acceptance "$acceptance_json" \
  --arg tenant "$tenant_self" '
  . as $e
  | ($e.usage // {}) as $u
  # findings_by_severity: group critique.json .critiques[].findings[] on .severity; missing → low.
  | ([($critique.critiques // [])[].findings[]?
       | (.severity // "low" | ascii_downcase)]
     | reduce .[] as $s (
         {critical:0, high:0, medium:0, low:0};
         if ($s=="critical" or $s=="high" or $s=="medium" or $s=="low")
         then .[$s] += 1 else .low += 1 end)) as $sev
  # distinct caught false-completions: findings flagged as such (category/type/false_completion).
  | ([($critique.critiques // [])[].findings[]?
       | select((.false_completion == true)
                or ((.category // "") | ascii_downcase | test("false[_-]?completion"))
                or ((.type // "")     | ascii_downcase | test("false[_-]?completion")))]
     | length) as $cfc
  # verification verdict: explicit sidecar field wins; else null-derived → NOT_VERIFIED.
  | (($critique.verification_verdict // $acceptance.verification_verdict
        // $state.verification_verdict // $state.verify_verdict) // null) as $vv0
  | (if ($vv0 == "PASS" or $vv0 == "FAIL" or $vv0 == "NOT_VERIFIED") then $vv0 else "NOT_VERIFIED" end) as $vv
  # phase attribution: when state.json carries a phase, one bucket for it; else all → unattributed.
  # The single bucket carries the full cost/time totals so the phase-sum invariant holds by construction.
  | (($state.phase // null) | if . == null or . == "" then "unattributed" else . end) as $phase
  | (($u.input_tokens // 0)) as $it
  | (($u.output_tokens // 0)) as $ot
  | (($u.cache_creation_input_tokens // 0)) as $cc
  | (($u.cache_read_input_tokens // 0)) as $cr
  | (($u.estimated_cost_usd // 0)) as $ec
  | (($u.duration_s // 0)) as $wc
  | {
      schema: "kontour.console.economics",
      version: "0.1",
      run_id: ($e.session_id // "unknown"),
      at: ($e.timestamp // null),
      task_slug: ($state.task_slug // null),
      model: ($u.model // null),
      pricing_version: ($u.pricing_version // null),
      cost: {
        input_tokens: $it,
        output_tokens: $ot,
        cache_creation_input_tokens: $cc,
        cache_read_input_tokens: $cr,
        estimated_cost_usd: $ec,
        by_model: ($u.by_model // [])
      },
      time: {
        wall_clock_s: $wc,
        human_wait_s: (($state.human_wait_s // $e.usage.human_wait_s) // 0)
      },
      phases: [ {
        phase: $phase,
        input_tokens: $it,
        output_tokens: $ot,
        cache_creation_input_tokens: $cc,
        cache_read_input_tokens: $cr,
        estimated_cost_usd: $ec,
        wall_clock_s: $wc
      } ],
      iterations: {
        count: (($state.iterations.count // $state.iteration_count) // 1),
        route_backs: (($state.iterations.route_backs // $state.route_backs) // 0)
      },
      defects: {
        gate_fires: (($critique.gate_fires // $state.gate_fires) // 0),
        findings_by_severity: $sev,
        caught_false_completions: (($critique.caught_false_completions // $cfc) // 0),
        verification_verdict: $vv
      },
      tenant_id: (if $tenant == "" then null else $tenant end)
    }' 2>/dev/null)" || exit 0
[[ -z "$record" || "$record" == "null" ]] && exit 0

# --- LOCAL-FIRST: append the record to the local economics log BEFORE any network attempt -----------
# This write must happen and must NOT depend on the POST. TELEMETRY_DATA_DIR comes from config.sh.
economics_log="${TELEMETRY_ECONOMICS_LOG_FILE:-${TELEMETRY_DATA_DIR:-${TELEMETRY_DIR}/../..}/.kontourai/telemetry/economics.jsonl}"
mkdir -p "$(dirname "$economics_log")" 2>/dev/null || true
printf '%s\n' "$record" >> "$economics_log" 2>/dev/null || true

# --- BEST-EFFORT console relay: opt-in + only when a console endpoint is configured ------------------
# Off by default (local-first). Endpoint resolution copies relay.sh: explicit override, else base + /records.
case "${FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY:-}" in
  1 | true | TRUE | yes | on) ;;
  *) exit 0 ;;
esac

endpoint="${FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL:-}"
if [[ -z "$endpoint" ]]; then
  base="${FLOW_AGENTS_CONSOLE_URL:-${CONSOLE_TELEMETRY_URL:-${CONSOLE_URL:-}}}"
  [[ -z "$base" ]] && exit 0
  endpoint="${base%/}/records"
fi

# Auth reuses the env names console_post_json reads (CONSOLE_TELEMETRY_TOKEN / CONSOLE_TENANT_ID),
# accepting FLOW_AGENTS_CONSOLE_* aliases and an optional token file — never fatal on a missing token.
if [[ -z "${CONSOLE_TELEMETRY_TOKEN:-}" ]]; then
  token_file="${FLOW_AGENTS_CONSOLE_TOKEN_FILE:-${CONSOLE_TELEMETRY_TOKEN_FILE:-}}"
  if [[ -n "$token_file" && -r "$token_file" ]]; then
    CONSOLE_TELEMETRY_TOKEN="$(tr -d '\r\n' < "$token_file" 2>/dev/null || true)"
    export CONSOLE_TELEMETRY_TOKEN
  fi
fi
if [[ -z "${CONSOLE_TENANT_ID:-}" && -n "${FLOW_AGENTS_CONSOLE_TENANT:-}" ]]; then
  export CONSOLE_TENANT_ID="$FLOW_AGENTS_CONSOLE_TENANT"
fi

# Optional field redaction (default none — jq escaping already neutralizes injection), then the shared
# best-effort POST. console_post_json enforces the https/localhost endpoint-allow gate + detached fire.
processed="$(redact_event "$record" "${FLOW_AGENTS_CONSOLE_ECONOMICS_REDACT:-none}")"
console_post_json "$endpoint" "$processed"
exit 0
