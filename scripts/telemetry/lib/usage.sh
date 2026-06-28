#!/usr/bin/env bash
# usage.sh — Session usage metric functions

# Module directory, resolved once at source time (cwd-independent).
USAGE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Single-source pricing registry loader (local / remote / bundled).
source "${USAGE_LIB_DIR}/pricing.sh"

# Resolve model from agent-spec.json
usage_get_model() {
  local agent_name="$1"
  local agents_dir="${HOME}/.kiro/agents"
  # Try exact match first, then glob for package-prefixed names
  local spec_file="${agents_dir}/${agent_name}.json"
  if [[ ! -f "$spec_file" ]]; then
    spec_file=$(ls "${agents_dir}"/*-"${agent_name}.json" 2>/dev/null | head -n1)
  fi
  [[ -n "$spec_file" && -f "$spec_file" ]] && jq -r '.model // "unknown"' "$spec_file" 2>/dev/null && return
  echo "unknown"
}

# Count tool invocations for a session
usage_count_tool_calls() {
  local session_id="$1" jsonl_path="$2"
  [[ ! -f "$jsonl_path" ]] && echo 0 && return
  grep -c "\"session_id\":\"${session_id}\".*\"event_type\":\"tool.invoke\"" "$jsonl_path" 2>/dev/null || echo 0
}

# Count subagent delegations for a session
usage_count_delegations() {
  local session_id="$1" jsonl_path="$2"
  [[ ! -f "$jsonl_path" ]] && echo 0 && return
  grep -c "\"session_id\":\"${session_id}\".*\"event_type\":\"agent.delegate\"" "$jsonl_path" 2>/dev/null || echo 0
}

# Parse a runtime transcript (JSONL) into real per-model token + cost usage.
# Ground truth lives in each assistant message's `.message.usage` block:
#   input_tokens (uncached), output_tokens, cache_creation_input_tokens,
#   cache_read_input_tokens — plus `.message.model`.
# Cost is derived from the versioned pricing registry: cache writes bill at
# input*write_5m, cache reads at input*read. Cost uses the registry's
# current_version (override with arg $2) and the result stamps `pricing_version`
# so the console can reproduce or recompute it. Emits a compact JSON object:
#   { by_model: [ {model, input_tokens, output_tokens,
#                  cache_creation_input_tokens, cache_read_input_tokens,
#                  estimated_cost_usd} ],
#     input_tokens, output_tokens, cache_creation_input_tokens,
#     cache_read_input_tokens, estimated_cost_usd, pricing_version }
# Prints nothing (non-zero) when the transcript is missing/unparseable so the
# caller can fall back to null usage. Never blocks agent work.
# Expected transcript usage path (Claude Code / Anthropic usage object). Bumped
# if the on-disk schema changes so drift is logged rather than silently zeroed.
USAGE_TRANSCRIPT_SCHEMA="message.usage.input_tokens"

# Append a one-line schema-drift warning (transcript carried usage data we could
# not parse). Goes to TELEMETRY_DRIFT_LOG if set, else stderr. Never fatal.
usage_log_drift() {
  local transcript="$1"
  local msg="[telemetry] pricing/usage drift: ${transcript} has usage data but expected path '${USAGE_TRANSCRIPT_SCHEMA}' parsed 0 tokens — transcript schema may have changed"
  if [[ -n "${TELEMETRY_DRIFT_LOG:-}" ]]; then
    echo "$msg" >> "${TELEMETRY_DRIFT_LOG}" 2>/dev/null || echo "$msg" >&2
  else
    echo "$msg" >&2
  fi
}

usage_parse_transcript() {
  local transcript="$1" version="${2:-}"
  [[ -z "$transcript" || ! -f "$transcript" ]] && return 1
  command -v jq >/dev/null 2>&1 || return 1
  local registry
  registry="$(pricing_registry)" || return 1
  [[ -z "$registry" ]] && return 1

  local out
  out="$(jq -n --argjson registry "$registry" --arg version "$version" '
    $registry as $reg
    | (if $version == "" then ($reg.current_version) else $version end) as $ver
    | ($reg.versions[$ver]) as $p
    | if $p == null then empty else . end
    | ($p.cache_multipliers) as $cm
    | (reduce inputs as $l ({};
        ($l.message.usage) as $u
        | if $u then
            (($l.message.model) // "unknown") as $m
            | .[$m].input          = ((.[$m].input // 0)          + (($u.input_tokens) // 0))
            | .[$m].output         = ((.[$m].output // 0)         + (($u.output_tokens) // 0))
            | .[$m].cache_creation = ((.[$m].cache_creation // 0) + (($u.cache_creation_input_tokens) // 0))
            | .[$m].cache_read     = ((.[$m].cache_read // 0)     + (($u.cache_read_input_tokens) // 0))
          else . end)) as $agg
    | ($agg | to_entries
        | map(
            .key as $m | .value as $u
            | (($p.models[$m]) // $p.default) as $rate
            | (if ([$m] | inside($p.zero_cost_models)) then 0 else 1 end) as $billable
            | {
                model: $m,
                input_tokens: ($u.input // 0),
                output_tokens: ($u.output // 0),
                cache_creation_input_tokens: ($u.cache_creation // 0),
                cache_read_input_tokens: ($u.cache_read // 0),
                estimated_cost_usd: (
                  $billable * (
                    ($u.input // 0)          * $rate.input
                    + ($u.output // 0)         * $rate.output
                    + ($u.cache_creation // 0) * $rate.input * $cm.write_5m
                    + ($u.cache_read // 0)     * $rate.input * $cm.read
                  ) / 1000000
                )
              })) as $by_model
    | {
        by_model: $by_model,
        input_tokens: ([$by_model[].input_tokens] | add // 0),
        output_tokens: ([$by_model[].output_tokens] | add // 0),
        cache_creation_input_tokens: ([$by_model[].cache_creation_input_tokens] | add // 0),
        cache_read_input_tokens: ([$by_model[].cache_read_input_tokens] | add // 0),
        estimated_cost_usd: (([$by_model[].estimated_cost_usd] | add // 0) * 1000000 | round / 1000000),
        pricing_version: $ver
      }
  ' < "$transcript" 2>/dev/null)"

  [[ -z "$out" ]] && return 1

  # Drift / emptiness check: if we parsed zero tokens but the transcript clearly
  # contains usage data, the schema drifted — warn and fall back to null usage.
  local total
  total="$(printf '%s' "$out" | jq -r '((.input_tokens // 0) + (.output_tokens // 0) + (.cache_creation_input_tokens // 0) + (.cache_read_input_tokens // 0))' 2>/dev/null)"
  if [[ -z "$total" || "$total" == "0" ]]; then
    if grep -q '"input_tokens"' "$transcript" 2>/dev/null; then
      usage_log_drift "$transcript"
    fi
    return 1
  fi

  printf '%s\n' "$out"
}
