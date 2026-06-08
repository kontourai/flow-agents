#!/usr/bin/env bash
# redact.sh — Field redaction for telemetry events

redact_event() {
  local event="$1"
  local redact_fields="$2"
  
  [[ -z "$event" || "$redact_fields" == "none" ]] && echo "$event" && return
  
  local result="$event"
  IFS=',' read -ra fields <<< "$redact_fields"
  
  for field in "${fields[@]}"; do
    field=$(echo "$field" | tr -d ' ')
    [[ -z "$field" ]] && continue
    
    # Use jq to null out the field
    result=$(echo "$result" | jq -c ".$field = null" 2>/dev/null || echo "$result")
  done
  
  echo "$result"
}