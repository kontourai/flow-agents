#!/usr/bin/env bash
# transport.sh — Dual-channel telemetry transport

source "${TELEMETRY_DIR}/lib/redact.sh"
# Shared usage.model / numeric-bound validation constants (security review
# HIGH + LOW findings) -- single source, also used by usage.sh's extractor.
source "${TELEMETRY_DIR}/lib/usage_model_guard.sh"

console_telemetry_endpoint_url() {
  if [[ -n "${CONSOLE_TELEMETRY_ENDPOINT_URL:-}" ]]; then
    echo "$CONSOLE_TELEMETRY_ENDPOINT_URL"
    return
  fi
  [[ -z "${CONSOLE_TELEMETRY_URL:-}" ]] && return
  local base="${CONSOLE_TELEMETRY_URL%/}"
  case "$base" in
    */api/telemetry/records) echo "$base" ;;
    */api/telemetry) echo "${base}/records" ;;
    *) echo "${base}/api/telemetry/records" ;;
  esac
}

console_telemetry_endpoint_allowed() {
  local endpoint_url="$1"
  [[ -z "$endpoint_url" || "$endpoint_url" == *$'\n'* || "$endpoint_url" == *$'\r'* || "$endpoint_url" == *'"'* ]] && return 1
  case "$endpoint_url" in
    https://*) return 0 ;;
    http://127.0.0.1|http://127.0.0.1/*|http://127.0.0.1:*|http://localhost|http://localhost/*|http://localhost:*) return 0 ;;
    *) return 1 ;;
  esac
}

console_telemetry_safe_token() {
  local value="$1"
  [[ ${#value} -ge 1 && ${#value} -le 4096 && "$value" =~ ^[A-Za-z0-9._~+/=-]+$ ]]
}

console_telemetry_safe_tenant() {
  local value="$1"
  [[ ${#value} -ge 1 && ${#value} -le 128 && "$value" =~ ^[A-Za-z0-9._:-]+$ ]]
}

console_telemetry_timeout_seconds() {
  local value="$1" fallback="$2" max="$3"
  if [[ "$value" =~ ^[0-9]+$ ]] && [[ "$value" -ge 1 && "$value" -le "$max" ]]; then
    echo "$value"
  else
    echo "$fallback"
  fi
}

# console_post_json <endpoint_url> <body> [connect_timeout] [max_time] [tmp_dir]
# Shared best-effort JSON POST to a Console records endpoint. BOTH the telemetry mirror
# (console_telemetry_emit) and the liveness relay (#295, scripts/liveness/relay.sh) go through this
# ONE core so endpoint-allow, auth (Bearer + tenant), timeouts, temp-file handling, and the detached
# fire can never drift between the two paths (the #356 shared-not-forked discipline). Reads
# CONSOLE_TELEMETRY_TOKEN / CONSOLE_TENANT_ID from the environment. Never blocks or fails the caller.
console_post_json() {
  local endpoint_url="$1"
  local body="$2"
  local connect_timeout max_time tmp_dir curl_config curl_body
  [[ -z "$endpoint_url" ]] && return
  if ! console_telemetry_endpoint_allowed "$endpoint_url"; then
    # Dropped silently before today's change (no signal that the event never
    # left the machine). Warn once per shell process (guarded by a plain,
    # non-local var so it survives across repeated console_post_json calls
    # within the same sourced shell) without changing the drop itself.
    if [[ -z "${_CONSOLE_TELEMETRY_ENDPOINT_WARNED:-}" ]]; then
      printf 'warning: transport.sh: console endpoint dropped by the allowlist (must be https://, or http://localhost|127.0.0.1): %s\n' "$endpoint_url" >&2
      _CONSOLE_TELEMETRY_ENDPOINT_WARNED=1
    fi
    return
  fi
  connect_timeout=$(console_telemetry_timeout_seconds "${3:-2}" 2 30)
  max_time=$(console_telemetry_timeout_seconds "${4:-5}" 5 60)
  tmp_dir="${5:-${TELEMETRY_SESSION_DIR:-${TMPDIR:-/tmp}}}"
  curl_config=$(mktemp "${tmp_dir%/}/console-curl.XXXXXX") || return
  curl_body=$(mktemp "${tmp_dir%/}/console-body.XXXXXX") || {
    rm -f "$curl_config"
    return
  }
  chmod 600 "$curl_config" "$curl_body" 2>/dev/null
  printf '%s' "$body" > "$curl_body" || {
    rm -f "$curl_config" "$curl_body"
    return
  }

  {
    printf 'url = "%s"\n' "$endpoint_url"
    printf 'request = "POST"\n'
    printf 'connect-timeout = "%s"\n' "$connect_timeout"
    printf 'max-time = "%s"\n' "$max_time"
    printf 'header = "Content-Type: application/json"\n'
    if [[ -n "${CONSOLE_TELEMETRY_TOKEN:-}" ]] && console_telemetry_safe_token "$CONSOLE_TELEMETRY_TOKEN"; then
      printf 'header = "Authorization: Bearer %s"\n' "$CONSOLE_TELEMETRY_TOKEN"
    fi
    if [[ -n "${CONSOLE_TENANT_ID:-}" ]] && console_telemetry_safe_tenant "$CONSOLE_TENANT_ID"; then
      printf 'header = "x-console-tenant-id: %s"\n' "$CONSOLE_TENANT_ID"
    fi
    printf 'data-binary = "@%s"\n' "$curl_body"
  } > "$curl_config" || {
    rm -f "$curl_config" "$curl_body"
    return
  }

  (
    curl -s --proto =https,http --proto-redir =https,http --config "$curl_config" >/dev/null 2>&1
    rm -f "$curl_config" "$curl_body"
  ) &
}

# Derive a coarse, path-free project label for console attribution, most-stable-first so the SAME
# project resolves to the SAME label across developers and machines (folder names differ between
# clones and worktrees; the project manifest and git remote do not). Precedence:
#   1. FLOW_AGENTS_PROJECT       — explicit operator override, always wins
#   2. nearest package.json name — walking up from cwd (monorepo-granular, committed => consistent)
#   3. git remote origin org/repo — repo-level identity, stable across clones
#   4. git toplevel dir basename  — repo dir even from a worktree/subdir
#   5. cwd basename               — last resort
# Path-free by construction (never the full local path). Cached per cwd under the telemetry data
# dir so the git/manifest reads run once per project, not per event; session_cleanup bounds the
# cache lifetime so a project rename (package.json name / git remote) self-heals within a day.
# Failure signals via empty output; the sole caller wraps the call as `$(...) || proj=""` so even if
# an internal command fails under `set -e`, telemetry is relayed unchanged (see
# console_telemetry_emit). Do not call this unwrapped from a `set -e` context.
console_project_label() {
  local cwd="$1"
  [[ -z "$cwd" || ! -d "$cwd" ]] && return 0
  [[ -n "${FLOW_AGENTS_PROJECT:-}" ]] && { printf '%s' "$FLOW_AGENTS_PROJECT"; return 0; }

  local cache="" key
  if [[ -n "${TELEMETRY_SESSION_DIR:-}" && -d "${TELEMETRY_SESSION_DIR:-}" ]]; then
    key=$(printf '%s' "$cwd" | cksum | cut -d' ' -f1)
    cache="${TELEMETRY_SESSION_DIR%/}/project-label.${key}"
    [[ -s "$cache" ]] && { cat "$cache"; return 0; }
  fi

  local label="" dir name url top after path repo rest org
  dir="$cwd"
  while [[ -n "$dir" && "$dir" != "/" ]]; do
    if [[ -f "$dir/package.json" ]]; then
      name=$(jq -r '.name // empty' "$dir/package.json" 2>/dev/null) || name=""
      [[ -n "$name" ]] && { label="$name"; break; }
    fi
    dir=$(dirname "$dir")
  done
  if [[ -z "$label" ]]; then
    url=$(git -C "$cwd" config --get remote.origin.url 2>/dev/null) || url=""
    if [[ -n "$url" ]]; then
      # Reduce a git remote to a coarse, host-free org/repo. Strip scheme+host STRUCTURALLY (not by
      # a dot-in-host heuristic) so a self-hosted or dot-less host, a port, or a user@ prefix can
      # never leak into the label; a remote with no org tier (single path segment) falls through.
      url="${url%/}"; url="${url%.git}"
      path=""
      if [[ "$url" == *"://"* ]]; then
        # Only network VCS schemes carry an org/repo path; file:// and other local schemes fall through.
        if [[ "$url" =~ ^(https?|ssh|git|ftps?):// ]]; then
          after="${url#*://}"                       # [user@]host[:port]/org/repo
          [[ "$after" == */* ]] && path="${after#*/}" # drop host[:port] (and any user@), keep path
        fi
      elif [[ "$url" == *:* && "${url%%:*}" != */* ]]; then
        path="${url#*:}"                            # scp form [user@]host:org/repo
      elif [[ "$url" != /* ]]; then
        path="$url"                                 # bare relative org/repo shorthand (not a local abs path)
      fi
      if [[ "$path" == */* ]]; then
        repo="${path##*/}"; rest="${path%/*}"; org="${rest##*/}"  # last two path segments
        [[ -n "$org" && -n "$repo" ]] && label="$org/$repo"
      fi
    fi
  fi
  if [[ -z "$label" ]]; then
    top=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || top=""
    [[ -n "$top" ]] && label=$(basename "$top")
  fi
  [[ -z "$label" ]] && label=$(basename "$cwd")

  if [[ -n "$cache" ]]; then
    printf '%s' "$label" > "${cache}.tmp.$$" 2>/dev/null && mv "${cache}.tmp.$$" "$cache" 2>/dev/null
  fi
  printf '%s' "$label"
}

# Defense-in-depth sanitize backstop (#568 slice 1 security review, MEDIUM,
# hardened per HIGH + LOW follow-up findings): nulls any
# usage.{input_tokens,output_tokens,cache_creation_input_tokens,
# cache_read_input_tokens,estimated_cost_usd} that isn't a JSON number within
# [USAGE_NUMERIC_MIN, USAGE_NUMERIC_MAX] (negative/absurd-magnitude values are
# as untrusted as a wrong-typed one), and bounds/validates usage.model against
# the SAME shared vendor-prefix allowlist (USAGE_MODEL_REGEX/
# USAGE_MODEL_MAX_LEN, from usage_model_guard.sh) usage_last_turn_usage
# enforces at extraction time -- a charset-only check here would be, and
# previously was, a strict superset of secret/credential shapes (API keys,
# JWTs) that a regression in the primary extractor could otherwise relay
# verbatim. FAILS CLOSED: if `.usage` is present but is not a JSON object (a
# raw string/number/array -- e.g. a future caller populating it wrong), the
# whole `.usage` is nulled rather than left unsanitized (a naive
# `.usage? != null` + `?`-chained field check on a non-object silently
# produces NO jq output at all, which the caller would then treat as "sanitize
# failed" and fall through to the ORIGINAL unsanitized event -- exactly the
# fail-OPEN bug this branch exists to close). This exists so a FUTURE
# extractor regression (a new caller populating .usage from a less-trusted
# source, a refactor that drops a type/shape guard, etc.) can never again
# relay an untyped/oversized/malformed/secret-shaped value to the console; it
# is not the primary defense (usage_last_turn_usage already type-guards and
# allowlists every field) but a last-resort net right before the POST. One jq
# pass, no extra process spawned beyond the jq call already needed here.
console_telemetry_sanitize_usage() {
  local event="$1"
  # FAIL CLOSED if the shared guard constants didn't resolve (e.g. a partial
  # dist/ sync dropped usage_model_guard.sh): null .usage entirely rather than
  # running a broken/empty jq that would return nothing and let the caller relay
  # the ORIGINAL unsanitized event. Never fail open on a packaging defect.
  if [[ -z "$USAGE_MODEL_REGEX" || -z "$USAGE_MODEL_MAX_LEN" || -z "$USAGE_NUMERIC_MIN" || -z "$USAGE_NUMERIC_MAX" ]]; then
    printf '%s' "$event" | jq -c 'if has("usage") then .usage = null else . end'
    return
  fi
  printf '%s' "$event" | jq -c \
    --arg model_regex "$USAGE_MODEL_REGEX" \
    --argjson model_max_len "$USAGE_MODEL_MAX_LEN" \
    --argjson numeric_min "$USAGE_NUMERIC_MIN" \
    --argjson numeric_max "$USAGE_NUMERIC_MAX" '
    def bounded_number($v):
      if ($v | type) == "number" and $v >= $numeric_min and $v <= $numeric_max then $v else null end;
    if (.usage? == null) then .
    elif ((.usage | type) != "object") then (.usage = null)
    else
      .usage.input_tokens = bounded_number(.usage.input_tokens?)
      | .usage.output_tokens = bounded_number(.usage.output_tokens?)
      | .usage.cache_creation_input_tokens = bounded_number(.usage.cache_creation_input_tokens?)
      | .usage.cache_read_input_tokens = bounded_number(.usage.cache_read_input_tokens?)
      | .usage.estimated_cost_usd = bounded_number(.usage.estimated_cost_usd?)
      | .usage.model = (
          if ((.usage.model? | type) == "string")
             and ((.usage.model | length) <= $model_max_len)
             and (.usage.model | test($model_regex))
          then .usage.model
          else null
          end
        )
    end
  ' 2>/dev/null
}

console_telemetry_emit() {
  local event="$1"
  local endpoint_url
  endpoint_url=$(console_telemetry_endpoint_url)
  [[ -z "$endpoint_url" ]] && return

  # Sanitize backstop runs before anything else so labeling/redaction/POST all
  # see the already-bounded event. FAIL CLOSED: console_telemetry_sanitize_usage
  # yields empty output only when it cannot produce a sanitized event — an
  # unparseable (non-JSON) event, or the degenerate case of a bare non-object
  # top-level JSON (`42`, `[]`) which no real call path constructs. Every event
  # relayed here is a JSON *object* built via jq `. + {…}` merges, and a JSON
  # object always sanitizes to *something* (at worst `.usage` nulled), so a
  # well-formed event is never dropped. Relaying the raw, unsanitized original
  # on empty output would defeat the backstop and is exactly the fail-OPEN hole
  # the function's own docstring says must never exist — so drop instead of
  # leaking. Losing one unsanitizable event is the safe failure mode.
  local sanitized_event
  sanitized_event=$(console_telemetry_sanitize_usage "$event") || sanitized_event=""
  [[ -z "$sanitized_event" ]] && return
  event="$sanitized_event"

  # Attribution: stamp a coarse, path-free project label (see console_project_label) before redaction
  # so the console buckets by project consistently across developers. The full context.cwd is still
  # redacted below — only the label leaves the machine. Every substitution is `|| var=""`-guarded so
  # that even under `set -e` any failure (bad JSON, missing cwd, no git) relays the event unchanged.
  local ev_cwd proj labeled_event
  ev_cwd=$(printf '%s' "$event" | jq -r '.context.cwd // empty' 2>/dev/null) || ev_cwd=""
  if [[ -n "$ev_cwd" ]]; then
    proj=$(console_project_label "$ev_cwd" 2>/dev/null) || proj=""
    if [[ -n "$proj" ]]; then
      labeled_event=$(printf '%s' "$event" | jq -c --arg p "$proj" '
        if ((.context.project // "") | length) == 0 then .context.project = $p else . end' 2>/dev/null) || labeled_event=""
      [[ -n "$labeled_event" ]] && event="$labeled_event"
    fi
  fi

  local processed_event
  processed_event=$(redact_event "$event" "${CONSOLE_TELEMETRY_REDACT:-${TELEMETRY_CHANNEL_ANALYTICS_REDACT:-}}")

  # Delegate the endpoint-allow gate, auth, timeouts, temp files, and detached POST to the shared
  # core. Timeouts/tmp-dir are passed explicitly so telemetry behavior is byte-for-byte unchanged.
  console_post_json \
    "$endpoint_url" \
    "$processed_event" \
    "${CONSOLE_TELEMETRY_CONNECT_TIMEOUT_SECONDS:-2}" \
    "${CONSOLE_TELEMETRY_MAX_TIME_SECONDS:-5}" \
    "${TELEMETRY_SESSION_DIR:-}"
}

transport_emit() {
  local event="$1"
  [[ -z "$event" ]] && return
  
  # Process each channel
  IFS=',' read -ra channels <<< "$TELEMETRY_CHANNELS"
  for channel in "${channels[@]}"; do
    channel=$(echo "$channel" | tr -d ' ')
    [[ -z "$channel" ]] && continue
    
    # Get channel config
    channel_upper=$(echo "$channel" | tr '[:lower:]' '[:upper:]')
    log_file_var="TELEMETRY_CHANNEL_${channel_upper}_LOG_FILE"
    redact_var="TELEMETRY_CHANNEL_${channel_upper}_REDACT"
    endpoint_var="TELEMETRY_CHANNEL_${channel_upper}_ENDPOINT_URL"
    
    local log_file="${!log_file_var}"
    local redact_fields="${!redact_var}"
    local endpoint_url="${!endpoint_var}"
    
    [[ -z "$log_file" ]] && continue
    
    # Apply redaction
    local processed_event
    processed_event=$(redact_event "$event" "$redact_fields")
    
    # Write to log file
    echo "$processed_event" >> "$log_file" 2>/dev/null
    
    # POST to endpoint if configured
    if [[ -n "$endpoint_url" ]]; then
      curl -s --connect-timeout 2 --max-time 5 -X POST \
        -H "Content-Type: application/json" \
        -d "$processed_event" \
        "$endpoint_url" >/dev/null 2>&1 &
    fi
  done

  console_telemetry_emit "$event"
}

transport_maybe_rotate() {
  # Only rotate if no active sessions
  local active_sessions
  active_sessions=$(ls "${TELEMETRY_SESSION_DIR}"/*.session 2>/dev/null | wc -l | tr -d ' ')
  [[ "$active_sessions" -gt 0 ]] && return
  
  IFS=',' read -ra channels <<< "$TELEMETRY_CHANNELS"
  for channel in "${channels[@]}"; do
    channel=$(echo "$channel" | tr -d ' ')
    [[ -z "$channel" ]] && continue
    
    channel_upper=$(echo "$channel" | tr '[:lower:]' '[:upper:]')
    log_file_var="TELEMETRY_CHANNEL_${channel_upper}_LOG_FILE"
    local log_file="${!log_file_var}"
    [[ ! -f "$log_file" ]] && continue
    
    # Check file size - try GNU stat first, then BSD
    local file_size_bytes=0
    if stat -c %s "$log_file" >/dev/null 2>&1; then
      file_size_bytes=$(stat -c %s "$log_file")
    else
      file_size_bytes=$(stat -f %z "$log_file" 2>/dev/null || echo "0")
    fi
    
    local file_size_mb=$((file_size_bytes / 1024 / 1024))
    [[ "$file_size_mb" -lt "$TELEMETRY_MAX_LOG_SIZE_MB" ]] && continue
    
    # Rotate logs
    local base_name="${log_file%.*}"
    local extension="${log_file##*.}"
    
    # Remove oldest log if at limit
    local oldest_log="${base_name}.$((TELEMETRY_MAX_LOG_FILES - 1)).${extension}"
    [[ -f "$oldest_log" ]] && rm -f "$oldest_log"
    
    # Shift existing logs
    for ((i = TELEMETRY_MAX_LOG_FILES - 2; i >= 1; i--)); do
      local current_log="${base_name}.${i}.${extension}"
      local next_log="${base_name}.$((i + 1)).${extension}"
      [[ -f "$current_log" ]] && mv "$current_log" "$next_log"
    done
    
    # Move current log to .1
    mv "$log_file" "${base_name}.1.${extension}"
  done
}

# ── At-least-once delivery (console-record-delivery decision, #1087 slice A) ──
#
# `console_post_json` above is the best-effort core: it fires curl detached and
# never observes the result. That is the CORRECT posture for high-frequency
# observation (per-tool-use hooks, liveness heartbeats) where loss is
# immaterial and an outbox would put I/O on the interactive path of every tool
# call.
#
# It is the wrong posture for receipts — gate claims, critiques, verdicts,
# releases. There, loss is both silent and material: nothing distinguishes "no
# verdict was recorded" from "the verdict was lost". Those need at-least-once,
# which `/records`' idempotent upsert on (tenant_id, record_id) makes safe to
# retry.
#
# Delivery class is a declared property of the record class, not a per-caller
# choice — one core, two modes.
#
# Durability order is deliberate: the outbox append happens SYNCHRONOUSLY and
# before any send is attempted, so a crash, an offline machine, or a hub outage
# leaves a replayable artifact rather than a silent hole. This is what the old
# projection-file scrape got right by accident and what live emission must not
# lose.

console_outbox_dir() {
  printf '%s' "${TELEMETRY_DATA_DIR:-${TELEMETRY_SESSION_DIR:-${TMPDIR:-/tmp}}}/console-outbox"
}

# One JSON line per undelivered record. Never contains a token: the auth header
# is applied at send time from the resolved conf.
console_outbox_file() { printf '%s/pending.jsonl' "$(console_outbox_dir)"; }

# Records that exhausted their attempts. Kept, not deleted — this file IS the
# gap-detection surface. At-least-once without a way to answer "which records
# never acked" is theatre.
console_outbox_dead_file() { printf '%s/undelivered.jsonl' "$(console_outbox_dir)"; }

console_outbox_max_attempts() {
  local raw="${CONSOLE_OUTBOX_MAX_ATTEMPTS:-5}"
  [[ "$raw" =~ ^[0-9]+$ ]] && [[ "$raw" -ge 1 ]] && [[ "$raw" -le 50 ]] || raw=5
  printf '%s' "$raw"
}

# Bounded so a long outage cannot fill the disk. On overflow the OLDEST entries
# are moved to the dead file rather than dropped, so overflow is reportable
# instead of invisible.
console_outbox_max_entries() {
  local raw="${CONSOLE_OUTBOX_MAX_ENTRIES:-1000}"
  [[ "$raw" =~ ^[0-9]+$ ]] && [[ "$raw" -ge 1 ]] || raw=1000
  printf '%s' "$raw"
}

# Enqueue a record for at-least-once delivery. Returns 0 always: telemetry must
# never fail, slow, or block the caller's real work.
# Usage: console_outbox_enqueue <endpoint_url> <body_json> <record_id>
console_outbox_enqueue() {
  local endpoint_url="$1" body="$2" record_id="$3"
  local dir file line
  [[ -z "$endpoint_url" || -z "$body" || -z "$record_id" ]] && return 0
  dir="$(console_outbox_dir)"
  mkdir -p "$dir" 2>/dev/null || return 0
  chmod 700 "$dir" 2>/dev/null
  file="$(console_outbox_file)"
  # Single-line append: small writes to a local file are atomic enough that
  # concurrent hooks interleave whole lines rather than corrupting one.
  line=$(printf '%s' "$body" | node -e '
    let b = "";
    process.stdin.on("data", (d) => { b += d; });
    process.stdin.on("end", () => {
      try {
        JSON.parse(b);
      } catch {
        process.exit(1);
      }
      process.stdout.write(JSON.stringify({
        id: process.argv[1],
        endpoint: process.argv[2],
        attempts: 0,
        body: b,
      }));
    });
  ' "$record_id" "$endpoint_url" 2>/dev/null) || return 0
  [[ -z "$line" ]] && return 0
  printf '%s\n' "$line" >> "$file" 2>/dev/null || return 0
  chmod 600 "$file" 2>/dev/null
  console_outbox_trim
  return 0
}

# Overflow protection. Oldest-first to the dead file so the newest receipts —
# the ones most likely still actionable — survive.
console_outbox_trim() {
  local file dead max count keep
  file="$(console_outbox_file)"
  [[ -f "$file" ]] || return 0
  max="$(console_outbox_max_entries)"
  count=$(wc -l < "$file" 2>/dev/null | tr -d ' ')
  [[ "$count" =~ ^[0-9]+$ ]] || return 0
  [[ "$count" -le "$max" ]] && return 0
  dead="$(console_outbox_dead_file)"
  keep=$((count - max))
  head -n "$keep" "$file" >> "$dead" 2>/dev/null
  tail -n "$max" "$file" > "$file.trim" 2>/dev/null && mv "$file.trim" "$file" 2>/dev/null
  chmod 600 "$file" "$dead" 2>/dev/null
  return 0
}

# Synchronous POST that OBSERVES the result — unlike console_post_json's
# detached fire. Returns 0 only on a 2xx.
console_outbox_send_one() {
  local endpoint_url="$1" body="$2"
  local connect_timeout max_time tmp_dir curl_config curl_body status
  console_telemetry_endpoint_allowed "$endpoint_url" || return 1
  connect_timeout=$(console_telemetry_timeout_seconds "${CONSOLE_OUTBOX_CONNECT_TIMEOUT:-2}" 2 30)
  max_time=$(console_telemetry_timeout_seconds "${CONSOLE_OUTBOX_MAX_TIME:-10}" 10 60)
  tmp_dir="${TELEMETRY_SESSION_DIR:-${TMPDIR:-/tmp}}"
  curl_config=$(mktemp "${tmp_dir%/}/console-outbox-curl.XXXXXX") || return 1
  curl_body=$(mktemp "${tmp_dir%/}/console-outbox-body.XXXXXX") || { rm -f "$curl_config"; return 1; }
  chmod 600 "$curl_config" "$curl_body" 2>/dev/null
  printf '%s' "$body" > "$curl_body" || { rm -f "$curl_config" "$curl_body"; return 1; }
  {
    printf 'url = "%s"\n' "$endpoint_url"
    printf 'request = "POST"\n'
    printf 'connect-timeout = "%s"\n' "$connect_timeout"
    printf 'max-time = "%s"\n' "$max_time"
    printf 'header = "Content-Type: application/json"\n'
    if [[ -n "${CONSOLE_TELEMETRY_TOKEN:-}" ]] && console_telemetry_safe_token "$CONSOLE_TELEMETRY_TOKEN"; then
      printf 'header = "Authorization: Bearer %s"\n' "$CONSOLE_TELEMETRY_TOKEN"
    fi
    if [[ -n "${CONSOLE_TENANT_ID:-}" ]] && console_telemetry_safe_tenant "$CONSOLE_TENANT_ID"; then
      printf 'header = "x-console-tenant-id: %s"\n' "$CONSOLE_TENANT_ID"
    fi
    printf 'data-binary = "@%s"\n' "$curl_body"
  } > "$curl_config" || { rm -f "$curl_config" "$curl_body"; return 1; }
  status=$(curl -s -o /dev/null -w '%{http_code}' --proto =https,http --proto-redir =https,http \
    --config "$curl_config" 2>/dev/null)
  rm -f "$curl_config" "$curl_body"
  [[ "$status" =~ ^2[0-9][0-9]$ ]]
}

# Flush the outbox. Lock-guarded so concurrent hooks cannot double-send or
# corrupt the file; a held lock is simply skipped (the next run flushes).
console_outbox_flush() {
  local dir file dead lock line id endpoint body attempts max survivors
  dir="$(console_outbox_dir)"
  file="$(console_outbox_file)"
  dead="$(console_outbox_dead_file)"
  [[ -f "$file" ]] || return 0
  lock="$dir/.flush.lock"
  mkdir "$lock" 2>/dev/null || return 0
  # shellcheck disable=SC2064
  trap "rmdir '$lock' 2>/dev/null" RETURN
  max="$(console_outbox_max_attempts)"
  survivors="$file.flush"
  : > "$survivors" 2>/dev/null || { rmdir "$lock" 2>/dev/null; return 0; }
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" ]] && continue
    id=$(printf '%s' "$line" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(b).id??""))}catch{}})' 2>/dev/null)
    endpoint=$(printf '%s' "$line" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(b).endpoint??""))}catch{}})' 2>/dev/null)
    body=$(printf '%s' "$line" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(b).body??""))}catch{}})' 2>/dev/null)
    attempts=$(printf '%s' "$line" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(b).attempts??0))}catch{process.stdout.write("0")}})' 2>/dev/null)
    [[ "$attempts" =~ ^[0-9]+$ ]] || attempts=0
    if [[ -z "$endpoint" || -z "$body" ]]; then
      # Unparseable entry: retire it to the dead file rather than retrying it
      # forever or dropping it silently.
      printf '%s\n' "$line" >> "$dead" 2>/dev/null
      continue
    fi
    if console_outbox_send_one "$endpoint" "$body"; then
      continue  # delivered; drop from pending
    fi
    attempts=$((attempts + 1))
    if [[ "$attempts" -ge "$max" ]]; then
      printf '%s\n' "$line" >> "$dead" 2>/dev/null
      continue
    fi
    printf '%s' "$line" | node -e '
      let b = "";
      process.stdin.on("data", (d) => { b += d; });
      process.stdin.on("end", () => {
        try {
          const e = JSON.parse(b);
          e.attempts = Number(process.argv[1]);
          process.stdout.write(JSON.stringify(e) + "\n");
        } catch {}
      });
    ' "$attempts" >> "$survivors" 2>/dev/null
  done < "$file"
  mv "$survivors" "$file" 2>/dev/null || rm -f "$survivors" 2>/dev/null
  chmod 600 "$file" 2>/dev/null
  [[ -f "$dead" ]] && chmod 600 "$dead" 2>/dev/null
  rmdir "$lock" 2>/dev/null
  trap - RETURN
  return 0
}

# Gap detection: how many records have not been acknowledged, and how many gave
# up entirely. Without this, at-least-once is unverifiable.
console_outbox_pending_count() {
  local file; file="$(console_outbox_file)"
  [[ -f "$file" ]] && wc -l < "$file" 2>/dev/null | tr -d ' ' || printf '0'
}

console_outbox_undelivered_count() {
  local dead; dead="$(console_outbox_dead_file)"
  [[ -f "$dead" ]] && wc -l < "$dead" 2>/dev/null | tr -d ' ' || printf '0'
}

# The at-least-once entry point. Durable first, then a detached flush so the
# caller is never blocked on the network.
# Usage: console_post_json_durable <endpoint_url> <body_json> <record_id>
console_post_json_durable() {
  console_outbox_enqueue "$1" "$2" "$3" || return 0
  ( console_outbox_flush >/dev/null 2>&1 ) &
  return 0
}
