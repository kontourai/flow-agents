#!/usr/bin/env bash
# desktop-notify.sh — macOS desktop notification on agent session stop
# Usage: echo '<hook_event_json>' | bash desktop-notify.sh stop <agent_name>
# Non-blocking: wraps osascript in background subshell

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TELEMETRY_DIR="$(cd "${SCRIPT_DIR}/../telemetry" && pwd)"
source "${TELEMETRY_DIR}/lib/config.sh"

main() {
  # Feature gate
  [[ "$TELEMETRY_NOTIFICATIONS" != "true" ]] && return 0

  # Profile gate
  case "$TELEMETRY_NOTIFICATION_PROFILE" in
    standard|strict) ;;
    *) return 0 ;;
  esac

  local hook_type="${1:-stop}" agent_name="${2:-agent}"
  local stdin_json="$3"

  # Extract summary from last_assistant_message
  local summary
  summary=$(echo "$stdin_json" | jq -r '.last_assistant_message // ""' 2>/dev/null)
  # Take first non-empty line
  summary=$(echo "$summary" | grep -m1 '.' || echo "Session complete")
  # Truncate to 100 chars
  [[ ${#summary} -gt 100 ]] && summary="${summary:0:100}..."

  # Send notification (async, non-blocking)
  osascript -e "display notification \"${summary//\"/\\\"}\" with title \"Kiro — ${agent_name}\"" &>/dev/null &
}

_stdin=$(cat)
echo "$_stdin"
(main "$@" "$_stdin") </dev/null &>/dev/null &
disown 2>/dev/null
exit 0
