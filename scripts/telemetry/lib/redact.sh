#!/usr/bin/env bash
# redact.sh — Field redaction for telemetry events

redact_event() {
  local event="$1" redact_fields="$2"
  [[ -z "$event" || "$redact_fields" == "none" || -z "$redact_fields" ]] && { printf '%s\n' "$event"; return 0; }

  # Pass field paths as data. Never splice configuration into a jq program,
  # including when this function is called with an environment override.
  printf '%s\n' "$event" | jq -c --arg fields "$redact_fields" '
    reduce ($fields | split(",")[] | gsub(" "; "") | select(length > 0) | split(".")) as $path
      (. ; . as $event | try setpath($path; null) catch $event)
  '
}
