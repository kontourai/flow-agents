#!/usr/bin/env bash
# session.sh — Session lifecycle management

session_start() {
  local agent_name="$1"
  local session_id start_time pid tty
  
  session_id=$(uuidgen 2>/dev/null || echo "s-$(date +%s)-$$")
  start_time=$(date +%s)
  pid="${PPID:-$$}"
  tty=$(ps -o tty= -p "$pid" 2>/dev/null | tr -d ' ' || echo "unknown")
  
  local session_file="${TELEMETRY_SESSION_DIR}/${session_id}.session"
  jq -nc \
    --arg sid "$session_id" \
    --arg an "$agent_name" \
    --argjson st "$start_time" \
    --argjson pid "$pid" \
    --arg tty "$tty" \
    '{
      session_id: $sid,
      agent_name: $an,
      start_time: $st,
      pid: $pid,
      tty: $tty
    }' > "$session_file"
  
  echo "$session_id"
}

session_get() {
  local latest_session
  latest_session=$(ls -t "${TELEMETRY_SESSION_DIR}"/*.session 2>/dev/null | head -n1)
  [[ -f "$latest_session" ]] && jq -r '.session_id' "$latest_session" 2>/dev/null
}

session_get_tty() {
  local latest_session
  latest_session=$(ls -t "${TELEMETRY_SESSION_DIR}"/*.session 2>/dev/null | head -n1)
  [[ -f "$latest_session" ]] && jq -r '.tty // "unknown"' "$latest_session" 2>/dev/null
}

session_end() {
  local session_id
  session_id=$(session_get)
  [[ -z "$session_id" ]] && return
  
  local session_file="${TELEMETRY_SESSION_DIR}/${session_id}.session"
  [[ ! -f "$session_file" ]] && return
  
  local start_time end_time duration_s
  start_time=$(jq -r '.start_time' "$session_file" 2>/dev/null)
  end_time=$(date +%s)
  duration_s=$((end_time - start_time))
  
  jq --argjson et "$end_time" --argjson ds "$duration_s" \
    '. + {end_time: $et, duration_s: $ds}' \
    "$session_file" > "${session_file}.tmp" && mv "${session_file}.tmp" "$session_file"
}

session_cleanup() {
  find "${TELEMETRY_SESSION_DIR}" -name "*.session" -mtime +1 -delete 2>/dev/null || true
}