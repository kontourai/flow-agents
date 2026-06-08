#!/usr/bin/env bash
# audit-transport.sh — Audit-specific JSONL transport (separate from telemetry channels)

audit_emit() {
  local event_json="$1"
  [[ -z "$event_json" ]] && return
  local audit_file="${TELEMETRY_DATA_DIR}/audit.jsonl"
  echo "$event_json" >> "$audit_file" 2>/dev/null
}

audit_maybe_rotate() {
  local audit_file="${TELEMETRY_DATA_DIR}/audit.jsonl"
  [[ ! -f "$audit_file" ]] && return

  local file_size_bytes=0
  if stat -c %s "$audit_file" >/dev/null 2>&1; then
    file_size_bytes=$(stat -c %s "$audit_file")
  else
    file_size_bytes=$(stat -f %z "$audit_file" 2>/dev/null || echo "0")
  fi

  local max_bytes=$(( TELEMETRY_GOVERNANCE_AUDIT_MAX_SIZE_MB * 1024 * 1024 ))
  [[ "$file_size_bytes" -lt "$max_bytes" ]] && return

  local base="${audit_file%.*}"
  local ext="${audit_file##*.}"

  # Remove oldest
  local oldest="${base}.$((TELEMETRY_GOVERNANCE_AUDIT_MAX_FILES - 1)).${ext}"
  [[ -f "$oldest" ]] && rm -f "$oldest"

  # Shift existing
  for ((i = TELEMETRY_GOVERNANCE_AUDIT_MAX_FILES - 2; i >= 1; i--)); do
    local cur="${base}.${i}.${ext}"
    local nxt="${base}.$((i + 1)).${ext}"
    [[ -f "$cur" ]] && mv "$cur" "$nxt"
  done

  mv "$audit_file" "${base}.1.${ext}"
}
