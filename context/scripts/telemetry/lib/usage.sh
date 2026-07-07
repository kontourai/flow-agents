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

# Given the JSON object produced by usage_parse_transcript (has a top-level
# `by_model[]` array), return the runtime-agnostic session model: the model
# with the most total tokens (input+output+cache_creation+cache_read). This
# lets any runtime that exposes a transcript (Claude Code, Codex, ...) resolve
# a real model name instead of the kiro-only ~/.kiro/agents lookup, which
# never matches non-kiro agent names (e.g. Claude Code's fixed "dev" hook
# arg) and falls through to "unknown". Returns empty string when $1 is
# null/empty or has no by_model entries, so the caller falls back to
# usage_get_model().
usage_model_from_transcript_usage() {
  local transcript_usage="$1"
  [[ -z "$transcript_usage" || "$transcript_usage" == "null" ]] && { echo ""; return; }
  echo "$transcript_usage" | jq -r '
    (.by_model // [])
    | map({model, total: ((.input_tokens // 0) + (.output_tokens // 0) + (.cache_creation_input_tokens // 0) + (.cache_read_input_tokens // 0))})
    | sort_by([-.total, .model])
    | .[0].model // empty
  ' 2>/dev/null
}

# Count tool invocations for a session
usage_count_tool_calls() {
  local session_id="$1" jsonl_path="$2"
  [[ ! -f "$jsonl_path" ]] && { echo 0; return; }
  # grep -c prints "0" (not empty) on zero matches but still exits non-zero,
  # so `grep -c ... || echo 0` double-emits "0\n0" here — that malformed
  # value then breaks the caller's `jq --argjson tc "$tool_count"`, silently
  # discarding the *entire* session.usage event whenever a session has no
  # prior tool.invoke lines yet (a common, not-rare case). Capture the count
  # first and only fall back when it's genuinely empty.
  local count
  count=$(grep -c "\"session_id\":\"${session_id}\".*\"event_type\":\"tool.invoke\"" "$jsonl_path" 2>/dev/null)
  echo "${count:-0}"
}

# Count subagent delegations for a session
usage_count_delegations() {
  local session_id="$1" jsonl_path="$2"
  [[ ! -f "$jsonl_path" ]] && { echo 0; return; }
  # See usage_count_tool_calls above for why this can't be `grep -c ... || echo 0`.
  local count
  count=$(grep -c "\"session_id\":\"${session_id}\".*\"event_type\":\"agent.delegate\"" "$jsonl_path" 2>/dev/null)
  echo "${count:-0}"
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
# Tokens are source-of-truth and survive independently of pricing: if the
# pricing registry is unavailable (or an explicit version arg doesn't exist in
# it), by_model[]/input_tokens/output_tokens/etc. are still emitted — only
# estimated_cost_usd and pricing_version degrade to null (the console
# recomputes cost authoritatively from tokens). Prints nothing (non-zero) only
# when the transcript itself is missing/empty/unreadable or truly carries zero
# usage, so the caller can fall back to null usage. Never blocks agent work.
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

# Opt-in persistent diagnostics for usage_parse_transcript's no-usage/degraded
# outcomes (gated by TELEMETRY_USAGE_DEBUG=1 so it never fires by default).
# Goes to TELEMETRY_DRIFT_LOG if set, else stderr. Never fatal, never blocks —
# purely so intermittent live "session.usage has null tokens" reports can be
# distinguished (empty transcript_path vs missing file vs no pricing registry
# vs a real zero-token parse) instead of being an unexplained black box.
usage_log_debug() {
  [[ "${TELEMETRY_USAGE_DEBUG:-}" == "1" ]] || return 0
  local reason="$1"
  local msg="[telemetry] usage_parse_transcript: ${reason}"
  if [[ -n "${TELEMETRY_DRIFT_LOG:-}" ]]; then
    echo "$msg" >> "${TELEMETRY_DRIFT_LOG}" 2>/dev/null || echo "$msg" >&2
  else
    echo "$msg" >&2
  fi
}

usage_parse_transcript() {
  local transcript="$1" version="${2:-}"
  if [[ -z "$transcript" ]]; then
    usage_log_debug "no usage — reason: empty transcript_path"
    return 1
  fi
  if [[ ! -f "$transcript" ]]; then
    usage_log_debug "no usage — reason: transcript file missing (${transcript})"
    return 1
  fi
  if ! command -v jq >/dev/null 2>&1; then
    usage_log_debug "no usage — reason: jq unavailable"
    return 1
  fi

  # Pricing registry is best-effort: when unavailable, tokens are still
  # extracted below and only the cost fields degrade to null (defect #2 fix —
  # previously this hard-returned 1 here, discarding token extraction
  # entirely whenever pricing_registry() failed).
  local registry has_registry
  registry="$(pricing_registry 2>/dev/null)"
  if [[ $? -eq 0 && -n "$registry" ]]; then
    has_registry=true
  else
    has_registry=false
    registry='null'
    usage_log_debug "pricing registry unavailable (${transcript}) — extracting tokens without cost"
  fi
  # A non-empty registry can still be malformed (corrupt/truncated pricing.json,
  # or a bad remote 200) — validate it parses before handing it to `jq -n
  # --argjson`, which would otherwise abort the whole parse and discard tokens
  # (the exact intermittent-null-tokens defect this function exists to fix).
  if [[ "$has_registry" == true ]] && ! jq -e . >/dev/null 2>&1 <<<"$registry"; then
    has_registry=false
    registry='null'
    usage_log_debug "pricing registry unparseable (${transcript}) — extracting tokens without cost"
  fi

  local out
  out="$(jq -n --argjson registry "$registry" --argjson has_registry "$has_registry" --arg version "$version" '
    ($has_registry and ($registry != null)) as $has_reg
    | (if $has_reg then (if $version == "" then $registry.current_version else $version end) else null end) as $ver
    | (if $has_reg and ($ver != null) then ($registry.versions[$ver]) else null end) as $p
    | ($p != null) as $priced
    | (if $priced then $p.cache_multipliers else null end) as $cm
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
            | (if $priced then (($p.models[$m]) // $p.default) else null end) as $rate
            | (if $priced then (if ([$m] | inside($p.zero_cost_models)) then 0 else 1 end) else null end) as $billable
            | {
                model: $m,
                input_tokens: ($u.input // 0),
                output_tokens: ($u.output // 0),
                cache_creation_input_tokens: ($u.cache_creation // 0),
                cache_read_input_tokens: ($u.cache_read // 0),
                estimated_cost_usd: (
                  if $priced then
                    $billable * (
                      ($u.input // 0)          * $rate.input
                      + ($u.output // 0)         * $rate.output
                      + ($u.cache_creation // 0) * $rate.input * $cm.write_5m
                      + ($u.cache_read // 0)     * $rate.input * $cm.read
                    ) / 1000000
                  else null end
                )
              })) as $by_model
    | {
        by_model: $by_model,
        input_tokens: ([$by_model[].input_tokens] | add // 0),
        output_tokens: ([$by_model[].output_tokens] | add // 0),
        cache_creation_input_tokens: ([$by_model[].cache_creation_input_tokens] | add // 0),
        cache_read_input_tokens: ([$by_model[].cache_read_input_tokens] | add // 0),
        estimated_cost_usd: (if $priced then (([$by_model[].estimated_cost_usd] | add // 0) * 1000000 | round / 1000000) else null end),
        pricing_version: (if $priced then $ver else null end)
      }
  ' < "$transcript" 2>/dev/null)"

  if [[ -z "$out" ]]; then
    usage_log_debug "no usage — reason: jq parse failed (${transcript})"
    return 1
  fi

  # Drift / emptiness check: if we parsed zero tokens but the transcript clearly
  # contains usage data, the schema drifted — warn and fall back to null usage.
  # This only discards tokens when there truly are none (total == 0); it never
  # discards a non-zero token extraction, including the pricing-unavailable
  # case above.
  local total
  total="$(printf '%s' "$out" | jq -r '((.input_tokens // 0) + (.output_tokens // 0) + (.cache_creation_input_tokens // 0) + (.cache_read_input_tokens // 0))' 2>/dev/null)"
  if [[ -z "$total" || "$total" == "0" ]]; then
    if grep -q '"input_tokens"' "$transcript" 2>/dev/null; then
      usage_log_drift "$transcript"
    else
      usage_log_debug "no usage — reason: parsed 0 tokens (no usage entries found in ${transcript})"
    fi
    return 1
  fi

  printf '%s\n' "$out"
}
