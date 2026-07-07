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
# Failure signals via empty output and a 0 exit — NEVER a non-zero return — so a caller running
# under `set -e` can never have telemetry aborted by this helper (see console_telemetry_emit).
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

  local label="" dir name url cand top
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
      url="${url%/}"; url="${url%.git}"
      cand=$(printf '%s' "$url" | sed -E 's#^.*[/:]([^/:]+/[^/:]+)$#\1#')
      # Accept only a clean two-segment org/repo — no scheme/host leak: exactly one slash,
      # no colon, and the org segment is not a hostname (contains no dot). Anything else
      # (single-segment remote, trailing-slash passthrough) falls through to the next tier.
      if [[ "$cand" =~ ^[^/:]+/[^/:]+$ && "${cand%%/*}" != *.* ]]; then label="$cand"; fi
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

console_telemetry_emit() {
  local event="$1"
  local endpoint_url
  endpoint_url=$(console_telemetry_endpoint_url)
  [[ -z "$endpoint_url" ]] && return
  console_telemetry_endpoint_allowed "$endpoint_url" || return

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

  local curl_config curl_body connect_timeout max_time
  connect_timeout=$(console_telemetry_timeout_seconds "${CONSOLE_TELEMETRY_CONNECT_TIMEOUT_SECONDS:-2}" 2 30)
  max_time=$(console_telemetry_timeout_seconds "${CONSOLE_TELEMETRY_MAX_TIME_SECONDS:-5}" 5 60)
  curl_config=$(mktemp "${TELEMETRY_SESSION_DIR}/console-curl.XXXXXX") || return
  curl_body=$(mktemp "${TELEMETRY_SESSION_DIR}/console-body.XXXXXX") || {
    rm -f "$curl_config"
    return
  }
  chmod 600 "$curl_config" "$curl_body" 2>/dev/null
  printf '%s' "$processed_event" > "$curl_body" || {
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
