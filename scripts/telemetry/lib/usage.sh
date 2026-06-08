#!/usr/bin/env bash
# usage.sh — Session usage metric functions

# Resolve model from agent-spec.json
usage_get_model() {
  local agent_name="$1"
  local agents_dir="${HOME}/.kiro/agents"
  # Try exact match first, then glob for package-prefixed names
  local spec_file="${agents_dir}/${agent_name}.json"
  if [[ ! -f "$spec_file" ]]; then
    spec_file=$(ls "${agents_dir}"/*-"${agent_name}.json" 2>/dev/null | head -n1)
  fi
  [[ -n "$spec_file" && -f "$spec_file" ]] && jq -r '.model // "unknown"' "$spec_file" 2>/dev/null && return
  echo "unknown"
}

# Count tool invocations for a session
usage_count_tool_calls() {
  local session_id="$1" jsonl_path="$2"
  [[ ! -f "$jsonl_path" ]] && echo 0 && return
  grep -c "\"session_id\":\"${session_id}\".*\"event_type\":\"tool.invoke\"" "$jsonl_path" 2>/dev/null || echo 0
}

# Count subagent delegations for a session
usage_count_delegations() {
  local session_id="$1" jsonl_path="$2"
  [[ ! -f "$jsonl_path" ]] && echo 0 && return
  grep -c "\"session_id\":\"${session_id}\".*\"event_type\":\"agent.delegate\"" "$jsonl_path" 2>/dev/null || echo 0
}
