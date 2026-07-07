#!/usr/bin/env bash
# transport.sh — Dual-channel telemetry transport

source "${TELEMETRY_DIR}/lib/redact.sh"

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

console_telemetry_emit() {
  local event="$1"
  local endpoint_url
  endpoint_url=$(console_telemetry_endpoint_url)
  [[ -z "$endpoint_url" ]] && return

  # Attribution: derive a coarse, path-free project label (basename of the working dir) so the
  # hosted console can bucket events by project. The full context.cwd is still redacted below —
  # only this basename-level label leaves the machine, never the full local path. jq-guarded: on
  # any failure the event is relayed unchanged (never blocks or drops telemetry).
  local labeled_event
  labeled_event=$(printf '%s' "$event" | jq -c '
    (.context.cwd // "") as $cwd
    | if ($cwd | length) > 0 and ((.context.project // "") | length) == 0
      then .context.project = ($cwd | rtrimstr("/") | split("/") | last)
      else . end' 2>/dev/null)
  [[ -n "$labeled_event" ]] && event="$labeled_event"

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
