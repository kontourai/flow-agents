#!/usr/bin/env bash
# usage.sh — Session usage metric functions

# Module directory, resolved once at source time (cwd-independent).
USAGE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Single-source pricing registry loader (local / remote / bundled).
source "${USAGE_LIB_DIR}/pricing.sh"
# Shared usage.model / numeric-bound validation constants (security review
# HIGH + LOW findings) -- single source, also used by transport.sh's backstop.
source "${USAGE_LIB_DIR}/usage_model_guard.sh"

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

# Bounded tail-read size for usage_last_turn_usage (per-tool-call join), in
# bytes. Overridable via env for tuning; default 256 KiB is large enough to
# reliably contain the most recent assistant usage block even with sizeable
# tool-output content nearby, small enough to bound per-call latency (this
# function runs once per tool call, unlike usage_parse_transcript which runs
# once per session at stop).
TELEMETRY_USAGE_TAIL_BYTES="${TELEMETRY_USAGE_TAIL_BYTES:-262144}"

# Shared pricing/cache-multiplier formula — the ONE place the per-model cost
# arithmetic is defined. Both usage_parse_transcript (whole-session aggregate,
# at `stop`) and usage_last_turn_usage (single-turn, per tool call) prepend
# this jq `def` to their program text and call price_one(...), rather than
# each hand-copying the formula (see #356 shared-not-forked discipline in
# transport.sh — a duplicated formula is exactly the kind of drift that
# invites). Given a model id ($m), a token breakdown ($u — object with
# input/output/cache_creation/cache_read keys), the resolved pricing registry
# ($registry), whether it's usable ($has_registry), and a requested pricing
# version ($version, empty string = registry's current_version), returns
# {estimated_cost_usd, pricing_version} — both null when no registry/version
# resolves (never invents a cost from unpriced data).
USAGE_PRICE_ONE_JQ_DEF='
def price_one($m; $u; $registry; $has_registry; $version):
  ($has_registry and ($registry != null)) as $has_reg
  | (if $has_reg then (if $version == "" then $registry.current_version else $version end) else null end) as $ver
  | (if $has_reg and ($ver != null) then ($registry.versions[$ver]) else null end) as $p
  | ($p != null) as $priced
  | (if $priced then $p.cache_multipliers else null end) as $cm
  | (if $priced then (($p.models[$m]) // $p.default) else null end) as $rate
  | (if $priced then (if ([$m] | inside($p.zero_cost_models)) then 0 else 1 end) else null end) as $billable
  | {
      estimated_cost_usd: (
        if $priced then
          $billable * (
            ($u.input // 0)          * $rate.input
            + ($u.output // 0)         * $rate.output
            + ($u.cache_creation // 0) * $rate.input * $cm.write_5m
            + ($u.cache_read // 0)     * $rate.input * $cm.read
          ) / 1000000
        else null end
      ),
      pricing_version: (if $priced then $ver else null end)
    };
'

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

# Shared registry resolution (DRY fix, review finding MEDIUM/code): both
# usage_parse_transcript and usage_last_turn_usage need {registry, has_registry}
# before invoking price_one() -- resolve it in exactly one place instead of
# hand-copying the resolve+validate block in each caller.
#   $1 = name of the caller's variable to receive the registry JSON (or the
#        literal string "null" when unavailable/unparseable)
#   $2 = name of the caller's variable to receive has_registry ("true"/"false")
#   $3 = mode: "" (default -- pricing_registry() may hit network/local/bundled
#        sources, used by usage_parse_transcript's once-per-session stop path)
#        | "cache_only" (never perform a network fetch -- see
#        usage_last_turn_usage's per-tool-call latency/race note below; a
#        cold/stale cache degrades straight to the bundled snapshot)
#   $4 = optional log context (e.g. transcript path) for usage_log_debug parity
#        with the pre-refactor per-caller messages
usage_resolve_registry() {
  local __usage_reg_var="$1" __usage_has_var="$2" __usage_mode="${3:-}" __usage_log_ctx="${4:-}"
  # Double-underscore-prefixed locals throughout (matching this function's own
  # parameter convention, code review LOW finding) to harden against a future
  # third caller's variable-name collision -- these never leak into the
  # caller's scope (output is returned only via printf -v into the caller's
  # named variables above), but a plain `_registry`/`_has_registry` name is
  # exactly the kind of generic local name a future edit could accidentally
  # shadow.
  local __registry __has_registry
  if [[ "$__usage_mode" == "cache_only" ]]; then
    __registry="$(TELEMETRY_PRICING_CACHE_ONLY=1 pricing_registry 2>/dev/null)"
  else
    __registry="$(pricing_registry 2>/dev/null)"
  fi
  if [[ $? -eq 0 && -n "$__registry" ]]; then
    __has_registry=true
  else
    __has_registry=false
    __registry='null'
    [[ -n "$__usage_log_ctx" ]] && usage_log_debug "pricing registry unavailable (${__usage_log_ctx}) — extracting tokens without cost"
  fi
  # A non-empty registry can still be malformed (corrupt/truncated pricing.json,
  # or a bad remote 200) — validate it parses before handing it to `jq -n
  # --argjson`, which would otherwise abort the whole parse and discard tokens.
  if [[ "$__has_registry" == true ]] && ! jq -e . >/dev/null 2>&1 <<<"$__registry"; then
    __has_registry=false
    __registry='null'
    [[ -n "$__usage_log_ctx" ]] && usage_log_debug "pricing registry unparseable (${__usage_log_ctx}) — extracting tokens without cost"
  fi
  printf -v "$__usage_reg_var" '%s' "$__registry"
  printf -v "$__usage_has_var" '%s' "$__has_registry"
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
  # entirely whenever pricing_registry() failed). Resolution itself is shared
  # with usage_last_turn_usage via usage_resolve_registry (DRY fix).
  local registry has_registry
  usage_resolve_registry registry has_registry "" "$transcript"

  local out
  out="$(jq -n --argjson registry "$registry" --argjson has_registry "$has_registry" --arg version "$version" "${USAGE_PRICE_ONE_JQ_DEF}"'
    ($has_registry and ($registry != null)) as $has_reg
    | (if $has_reg then (if $version == "" then $registry.current_version else $version end) else null end) as $ver
    | (if $has_reg and ($ver != null) then ($registry.versions[$ver]) else null end) as $p
    | ($p != null) as $priced
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
            | price_one($m; $u; $registry; $has_registry; $version) as $price
            | {
                model: $m,
                input_tokens: ($u.input // 0),
                output_tokens: ($u.output // 0),
                cache_creation_input_tokens: ($u.cache_creation // 0),
                cache_read_input_tokens: ($u.cache_read // 0),
                estimated_cost_usd: $price.estimated_cost_usd
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

# Bounded, single-turn usage extractor — the tool-event (preToolUse/
# postToolUse) counterpart to usage_parse_transcript's whole-session
# aggregate (used only at `stop`). This runs once per tool call, so unlike
# usage_parse_transcript it MUST NOT scan the whole transcript: a large
# session can fire hundreds of tool calls, and a full-file jq scan per call
# would add real, cumulative latency to every tool invocation.
#
# Reads only the last TELEMETRY_USAGE_TAIL_BYTES bytes of the transcript,
# drops the (possibly partial) first line of that tail window, and returns
# the LAST well-formed `type=="assistant"` line with a `message.usage` object.
# Because tool execution is synchronous — the CLI appends the requesting
# assistant message (including its tool_use blocks) before firing PreToolUse
# for each block, and no new assistant turn can be appended mid-tool-call —
# that last assistant/usage entry at hook-fire time is exactly the turn that
# produced this specific tool call, for both PreToolUse and PostToolUse of the
# same call.
#
# Hardened line selection (security review findings CRITICAL/HIGH): the tail
# window is parsed in `jq -R` RAW mode, one line at a time, with `fromjson?`
# per line — a torn/malformed line ANYWHERE in the window (e.g. a concurrent
# writer's partial trailing write, or noise before/after the real line) is
# SKIPPED, never fatal, and never masks a real usage line elsewhere in the
# window (previously a single malformed line anywhere in the tail aborted the
# whole `jq -n` JSON-mode parse, silently discarding a present, findable usage
# line). Every extracted field is independently type-guarded AND bound-checked
# before it is ever emitted: a token/cost field is emitted ONLY if it is a
# JSON number within [USAGE_NUMERIC_MIN, USAGE_NUMERIC_MAX] (never a string,
# object, array, negative, or absurd magnitude like 1e308 — never
# "0-as-fabrication" when the source type/range is wrong; see
# usage_model_guard.sh). `model` is emitted ONLY if it is a string, <=
# USAGE_MODEL_MAX_LEN chars, AND matches USAGE_MODEL_REGEX — a small,
# case-insensitive VENDOR-PREFIX ALLOWLIST (claude/gpt/o<digit>/gemini/glm/
# llama/mistral/deepseek/qwen/grok/command/codestral), NOT a bare charset
# check (security review HIGH finding: a charset-only check like
# `^[A-Za-z0-9._:-]+$` is a strict SUPERSET of common secret/credential
# shapes — an Anthropic API key `sk-ant-api03-...`, an AWS key `AKIA...`, or a
# JWT `eyJ...` all satisfy that charset and would pass through verbatim).
# Anything that doesn't match the allowlist resolves to "unknown". This is
# what stops a crafted transcript line (e.g. {"message":{"model":"<secret or
# arbitrary text>","usage":{"input_tokens":"<arbitrary text>"}}}) from ever
# landing a raw string in the emitted record (previously `// 0` /
# `// "unknown"` copied a wrong-typed value through verbatim, which then
# relayed to the console unredacted since usage.* isn't on the redact
# deny-list). estimated_cost_usd/pricing_version are computed ONLY when every
# token field for that turn is a valid, bounded number — a turn with any
# invalid/out-of-range token field degrades to null cost too, never a cost
# computed from partly-zeroed untrusted data; the computed cost itself is
# then also bound-checked before being emitted (defense-in-depth against an
# implausible pricing-registry rate).
#
# Prints a compact JSON object on success:
#   {model, input_tokens, output_tokens, cache_creation_input_tokens,
#    cache_read_input_tokens, estimated_cost_usd, pricing_version}
# and returns 0. Prints nothing and returns 1 when the transcript is
# missing/unreadable, jq is unavailable, or no assistant/usage line is found
# within the tail window (e.g. transcript not Anthropic-message-shaped, or a
# huge preceding blob pushed the last assistant entry outside the bound) —
# the caller degrades to its own model-only/null fallback; this function
# never invents a number. Reuses the exact pricing/cache-multiplier formula
# usage_parse_transcript uses, via the shared USAGE_PRICE_ONE_JQ_DEF/
# price_one() helper above (one source, two call sites), and the shared
# usage_resolve_registry() registry-resolution helper (also one source, two
# call sites — review finding MEDIUM/code DRY fix).
#
# Pricing resolution here is deliberately CACHE-ONLY (review finding
# MEDIUM/code latency+race): this function runs once per tool call, so a
# cold/stale local pricing cache must never trigger a blocking
# `curl --max-time 5` (and race pricing.sh's fixed `${cache}.tmp` path)
# per tool call. `usage_resolve_registry ... cache_only` skips the network
# branch entirely; session.usage (usage_parse_transcript, once per session at
# `stop`) remains the authoritative cost source and still resolves the
# registry normally (network-eligible). A cold cache here just means
# estimated_cost_usd/pricing_version are null for this tool event — tokens
# still survive.
usage_last_turn_usage() {
  local transcript="$1" version="${2:-}"
  if [[ -z "$transcript" ]]; then
    usage_log_debug "usage_last_turn_usage: no usage — reason: empty transcript_path"
    return 1
  fi
  if [[ ! -f "$transcript" || ! -r "$transcript" ]]; then
    usage_log_debug "usage_last_turn_usage: no usage — reason: transcript file missing/unreadable (${transcript})"
    return 1
  fi
  if ! command -v jq >/dev/null 2>&1; then
    usage_log_debug "usage_last_turn_usage: no usage — reason: jq unavailable"
    return 1
  fi

  local file_size
  file_size="$(wc -c < "$transcript" 2>/dev/null | tr -d ' ')"
  [[ "$file_size" =~ ^[0-9]+$ ]] || file_size=0

  # Bounded tail-read: only the last N bytes when the file exceeds the bound,
  # then drop the first (possibly partial/truncated-mid-JSON) line of that
  # window. This is a cheap belt-and-suspenders trim, not a correctness
  # requirement any more — the jq program below tolerates a malformed line
  # anywhere in the window (see the hardened-parsing note above) — but there
  # is no reason to hand jq a line we already know is certainly truncated.
  local tail_text
  if [[ "$file_size" -gt "$TELEMETRY_USAGE_TAIL_BYTES" ]]; then
    tail_text="$(tail -c "$TELEMETRY_USAGE_TAIL_BYTES" "$transcript" 2>/dev/null | tail -n +2)"
  else
    tail_text="$(cat "$transcript" 2>/dev/null)"
  fi
  if [[ -z "$tail_text" ]]; then
    usage_log_debug "usage_last_turn_usage: no usage — reason: empty tail window (${transcript})"
    return 1
  fi

  # Pricing registry — cache-only (see function header): never a network
  # fetch per tool call. Missing/unparseable registry degrades cost/
  # pricing_version to null but never blocks token extraction.
  local registry has_registry
  usage_resolve_registry registry has_registry cache_only "$transcript"

  local jq_program
  jq_program="${USAGE_PRICE_ONE_JQ_DEF}"'
    def bounded_number($v):
      if ($v | type) == "number" and $v >= $numeric_min and $v <= $numeric_max then $v else null end;
    (
      [inputs]
      | map(try fromjson catch null)
      | map(select(. != null))
      | map(select(
          (.type? == "assistant")
          and ((.message?.usage?) != null)
          and ((.message.usage | type) == "object")
        ))
      | last
    ) as $turn
    | if $turn == null then empty else
        ($turn.message.usage) as $raw
        | (
            (($turn.message.model?) | type) == "string"
            and (($turn.message.model | length) <= $model_max_len)
            and ($turn.message.model | test($model_regex))
          ) as $model_valid
        | (if $model_valid then $turn.message.model else "unknown" end) as $m
        | bounded_number($raw.input_tokens?) as $input
        | bounded_number($raw.output_tokens?) as $output
        | bounded_number($raw.cache_creation_input_tokens?) as $cache_creation
        | bounded_number($raw.cache_read_input_tokens?) as $cache_read
        | ($input != null and $output != null and $cache_creation != null and $cache_read != null) as $tokens_all_valid
        | (if $tokens_all_valid then
             price_one($m; {input: $input, output: $output, cache_creation: $cache_creation, cache_read: $cache_read}; $registry; $has_registry; $version)
           else
             {estimated_cost_usd: null, pricing_version: null}
           end) as $price
        | bounded_number($price.estimated_cost_usd?) as $cost_bounded
        | {
            model: $m,
            input_tokens: $input,
            output_tokens: $output,
            cache_creation_input_tokens: $cache_creation,
            cache_read_input_tokens: $cache_read,
            estimated_cost_usd: $cost_bounded,
            pricing_version: $price.pricing_version
          }
      end
  '

  local out
  out="$(jq -R -n -c \
    --argjson registry "$registry" \
    --argjson has_registry "$has_registry" \
    --arg version "$version" \
    --arg model_regex "$USAGE_MODEL_REGEX" \
    --argjson model_max_len "$USAGE_MODEL_MAX_LEN" \
    --argjson numeric_min "$USAGE_NUMERIC_MIN" \
    --argjson numeric_max "$USAGE_NUMERIC_MAX" \
    "$jq_program" <<<"$tail_text" 2>/dev/null)"

  if [[ -z "$out" ]]; then
    usage_log_debug "usage_last_turn_usage: no usage — reason: no assistant/usage entry in tail window (${transcript})"
    return 1
  fi

  printf '%s\n' "$out"
}
