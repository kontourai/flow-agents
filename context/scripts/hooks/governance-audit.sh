#!/usr/bin/env bash
# governance-audit.sh — Governance detection hook for preToolUse/postToolUse
# Usage: echo '<hook_event_json>' | bash governance-audit.sh <hookType> <agentName>
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TELEMETRY_DIR="$(cd "${SCRIPT_DIR}/../telemetry" && pwd)"

source "${TELEMETRY_DIR}/lib/config.sh"
source "${SCRIPT_DIR}/lib/patterns.sh"
source "${SCRIPT_DIR}/lib/audit-transport.sh"

# Max input size to inspect (bytes) — truncate beyond this
MAX_INSPECT_SIZE=50000

_build_event() {
  local finding_type="$1" severity="$2" tool_name="$3" hook_phase="$4" details="$5"
  local session_id agent_name="$6"
  session_id=$(ls -t "${TELEMETRY_SESSION_DIR}"/*.session 2>/dev/null | head -n1 | xargs -I{} jq -r '.session_id' {} 2>/dev/null || echo "no-session")
  local event_id timestamp_ms
  event_id="gov-$(date +%s)-$(head -c4 /dev/urandom 2>/dev/null | od -An -tx1 | tr -d ' \n' || echo $$)"
  timestamp_ms=$(date +%s)000

  jq -nc \
    --arg sv "0.3.0" \
    --arg ts "$timestamp_ms" \
    --arg sid "$session_id" \
    --arg eid "$event_id" \
    --arg et "governance.${finding_type}" \
    --arg an "$agent_name" \
    --arg ft "$finding_type" \
    --arg sev "$severity" \
    --arg tn "$tool_name" \
    --arg hp "$hook_phase" \
    --argjson det "$details" \
    '{
      schema_version: $sv,
      timestamp: $ts,
      session_id: $sid,
      event_id: $eid,
      event_type: $et,
      agent: {name: $an, runtime: "kiro-cli"},
      governance: {finding_type: $ft, severity: $sev, tool_name: $tn, hook_phase: $hp, details: $det}
    }'
}

main() {
  [[ "$TELEMETRY_GOVERNANCE" != "true" ]] && return 0

  local hook_type="${1:-preToolUse}" agent_name="${2:-unknown}"
  local stdin_json="$3"
  local hook_phase
  case "$hook_type" in
    preToolUse) hook_phase="pre" ;;
    postToolUse) hook_phase="post" ;;
    *) return 0 ;;
  esac

  local tool_name text
  tool_name=$(echo "$stdin_json" | jq -r '.tool_name // ""' 2>/dev/null)

  # Combine tool_input and tool_response for scanning
  local tool_input tool_response
  tool_input=$(echo "$stdin_json" | jq -r '.tool_input // "" | if type == "object" then tostring else . end' 2>/dev/null)
  tool_response=$(echo "$stdin_json" | jq -r '.tool_response // "" | if type == "object" then tostring else . end' 2>/dev/null)
  text="${tool_input}${tool_response}"

  # Truncation check
  if [[ ${#text} -gt $MAX_INSPECT_SIZE ]]; then
    local trunc_event
    trunc_event=$(_build_event "audit_input_truncated" "warning" "$tool_name" "$hook_phase" \
      "{\"original_size\":${#text},\"max_size\":${MAX_INSPECT_SIZE}}" "$agent_name")
    audit_emit "$trunc_event"
    text="${text:0:$MAX_INSPECT_SIZE}"
  fi

  # Secret detection
  local secrets
  secrets=$(_detect_secrets "$text")
  if [[ -n "$secrets" ]]; then
    local types_json location
    types_json=$(echo "$secrets" | jq -Rsc 'split("\n") | map(select(. != ""))')
    [[ "$hook_phase" == "pre" ]] && location="input" || location="output"
    local evt
    evt=$(_build_event "secret_detected" "critical" "$tool_name" "$hook_phase" \
      "{\"secret_types\":${types_json},\"location\":\"${location}\"}" "$agent_name")
    audit_emit "$evt"
  fi

  # AWS policy violations
  local violations
  violations=$(_detect_aws_violations "$text")
  if [[ -n "$violations" ]]; then
    local vtypes_json
    vtypes_json=$(echo "$violations" | jq -Rsc 'split("\n") | map(select(. != ""))')
    local evt
    evt=$(_build_event "aws_policy_violation" "critical" "$tool_name" "$hook_phase" \
      "{\"violation_types\":${vtypes_json}}" "$agent_name")
    audit_emit "$evt"
  fi

  # Destructive operations (primarily preToolUse on bash commands)
  if _detect_destructive_ops "$text"; then
    local evt
    evt=$(_build_event "destructive_operation" "high" "$tool_name" "$hook_phase" \
      '{"location":"command"}' "$agent_name")
    audit_emit "$evt"
  fi

  # Sensitive file access (preToolUse on file writes)
  local file_path
  file_path=$(echo "$stdin_json" | jq -r '.tool_input.path // .tool_input.file_path // ""' 2>/dev/null)
  if [[ -n "$file_path" ]] && _detect_sensitive_paths "$file_path"; then
    local evt
    evt=$(_build_event "sensitive_file_access" "warning" "$tool_name" "$hook_phase" \
      "{\"path\":\"${file_path}\"}" "$agent_name")
    audit_emit "$evt"
  fi

  # Elevated privilege
  if _detect_elevated_privilege "$text"; then
    local evt
    evt=$(_build_event "elevated_privilege" "medium" "$tool_name" "$hook_phase" \
      '{"location":"command"}' "$agent_name")
    audit_emit "$evt"
  fi

  audit_maybe_rotate
}

_stdin=$(cat)
echo "$_stdin"
(main "$@" "$_stdin") </dev/null &>/dev/null &
disown 2>/dev/null
exit 0
