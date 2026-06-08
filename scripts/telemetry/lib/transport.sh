#!/usr/bin/env bash
# transport.sh — Dual-channel telemetry transport

source "${TELEMETRY_DIR}/lib/redact.sh"

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