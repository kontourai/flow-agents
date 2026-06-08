#!/usr/bin/env bash
# sync-agents.sh — Inject telemetry hooks into matching agent configs
# Usage: bash sync-agents.sh [--dry-run] [--restore]
set -euo pipefail

TELEMETRY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${TELEMETRY_DIR}/lib/config.sh"

MODE="apply"
[[ "${1:-}" == "--dry-run" ]] && MODE="dry-run"
[[ "${1:-}" == "--restore" ]] && MODE="restore"

AGENTS_DIR="${HOME}/.kiro/agents"
MARKER="telemetry.sh"
NOTIFY_MARKER="desktop-notify.sh"
GOVERNANCE_MARKER="governance-audit.sh"
HOOKS_DIR="$(cd "${TELEMETRY_DIR}/../hooks" && pwd)"

# Check if agent name matches any pattern in a comma-separated list
_matches_any() {
  local name="$1" patterns="$2"
  local old_ifs="$IFS" pat
  IFS=','
  set -f
  for pat in $patterns; do
    pat="${pat## }"; pat="${pat%% }"
    case "$name" in $pat) IFS="$old_ifs"; set +f; return 0 ;; esac
  done
  IFS="$old_ifs"
  set +f
  return 1
}

# Build the telemetry hook entry for a given hook type and agent
_hook_entry() {
  local hook_type="$1" agent_name="$2"
  local cmd="bash ${TELEMETRY_DIR}/telemetry.sh ${hook_type} ${agent_name}"
  case "$hook_type" in
    preToolUse|postToolUse)
      jq -nc --arg c "$cmd" '{matcher:"*",command:$c,timeout_ms:10000}'
      ;;
    *)
      jq -nc --arg c "$cmd" '{command:$c,timeout_ms:10000}'
      ;;
  esac
}

# Build desktop notification hook entry (stop only)
_notify_hook_entry() {
  local agent_name="$1"
  local cmd="bash ${HOOKS_DIR}/desktop-notify.sh stop ${agent_name}"
  jq -nc --arg c "$cmd" '{command:$c,timeout_ms:5000}'
}

# Build governance hook entry (preToolUse/postToolUse only)
_governance_hook_entry() {
  local hook_type="$1" agent_name="$2"
  local cmd="bash ${HOOKS_DIR}/governance-audit.sh ${hook_type} ${agent_name}"
  jq -nc --arg c "$cmd" '{matcher:"*",command:$c,timeout_ms:5000}'
}

# Merge all hooks into an agent's existing hooks
_merge_hooks() {
  local agent_file="$1" agent_name="$2"
  local hook_types=("agentSpawn" "userPromptSubmit" "preToolUse" "postToolUse" "stop")

  # Build the telemetry hooks object
  local all_hooks='{}'
  for ht in "${hook_types[@]}"; do
    local entry
    entry=$(_hook_entry "$ht" "$agent_name")
    all_hooks=$(echo "$all_hooks" | jq --arg ht "$ht" --argjson e "$entry" '.[$ht] = (.[$ht] // []) + [$e]')
  done

  # Add desktop notification hook to stop
  if [[ "$TELEMETRY_NOTIFICATIONS" == "true" ]]; then
    local notify_entry
    notify_entry=$(_notify_hook_entry "$agent_name")
    all_hooks=$(echo "$all_hooks" | jq --argjson e "$notify_entry" '.stop = (.stop // []) + [$e]')
  fi

  # Add governance hooks to preToolUse and postToolUse
  if [[ "$TELEMETRY_GOVERNANCE" == "true" ]]; then
    for ht in preToolUse postToolUse; do
      local gov_entry
      gov_entry=$(_governance_hook_entry "$ht" "$agent_name")
      all_hooks=$(echo "$all_hooks" | jq --arg ht "$ht" --argjson e "$gov_entry" '.[$ht] = (.[$ht] // []) + [$e]')
    done
  fi

  # Read existing agent JSON, merge hooks (preserve non-managed entries)
  local m1="$MARKER" m2="$NOTIFY_MARKER" m3="$GOVERNANCE_MARKER"
  jq --argjson th "$all_hooks" --arg m1 "$m1" --arg m2 "$m2" --arg m3 "$m3" '
    .hooks //= {} |
    .hooks = reduce ($th | keys[]) as $ht (
      .hooks;
      .[$ht] = (
        ([.[$ht] // [] | .[] | select(
          (.command | contains($m1) | not) and
          (.command | contains($m2) | not) and
          (.command | contains($m3) | not)
        )])
        + $th[$ht]
      )
    )
  ' "$agent_file"
}

# Remove all managed hooks from an agent
_strip_hooks() {
  local agent_file="$1"
  local m1="$MARKER" m2="$NOTIFY_MARKER" m3="$GOVERNANCE_MARKER"
  jq --arg m1 "$m1" --arg m2 "$m2" --arg m3 "$m3" '
    if .hooks then
      .hooks |= with_entries(
        .value |= map(select(
          (.command | contains($m1) | not) and
          (.command | contains($m2) | not) and
          (.command | contains($m3) | not)
        ))
      )
    else . end
  ' "$agent_file"
}

# Main
echo "Telemetry Hook Sync — mode: ${MODE}"
echo "Include: ${TELEMETRY_SYNC_INCLUDE}"
echo "Exclude: ${TELEMETRY_SYNC_EXCLUDE}"
echo "---"

synced=0
skipped=0

for agent_file in "${AGENTS_DIR}"/*.json; do
  [[ -f "$agent_file" ]] || continue
  fname=$(basename "$agent_file" .json)

  # Apply include/exclude
  if ! _matches_any "$fname" "$TELEMETRY_SYNC_INCLUDE"; then
    skipped=$((skipped + 1))
    continue
  fi
  if _matches_any "$fname" "$TELEMETRY_SYNC_EXCLUDE"; then
    skipped=$((skipped + 1))
    continue
  fi

  # Get agent name from JSON or filename
  agent_name=$(jq -r '.name // ""' "$agent_file" 2>/dev/null)
  [[ -z "$agent_name" ]] && agent_name="$fname"

  case "$MODE" in
    dry-run)
      echo "[DRY-RUN] Would update: ${fname} (agent: ${agent_name})"
      ;;
    restore)
      result=$(_strip_hooks "$agent_file")
      echo "$result" > "${agent_file}.tmp" && mv "${agent_file}.tmp" "$agent_file"
      echo "[RESTORED] ${fname} — telemetry hooks removed"
      synced=$((synced + 1))
      ;;
    apply)
      result=$(_merge_hooks "$agent_file" "$agent_name")
      echo "$result" > "${agent_file}.tmp" && mv "${agent_file}.tmp" "$agent_file"
      echo "[SYNCED] ${fname} (agent: ${agent_name})"
      synced=$((synced + 1))
      ;;
  esac
done

echo "---"
echo "Done. ${synced} synced, ${skipped} skipped."