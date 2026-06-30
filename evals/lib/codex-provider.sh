#!/usr/bin/env bash
# codex-provider.sh — Promptfoo exec provider that runs Flow Agents through Codex.
set -euo pipefail

PROMPT="${1:-}"
OPTIONS="${2:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
TIMEOUT="${CODEX_EVAL_TIMEOUT:-300}"
FLUSH_SLEEP="${FLOW_AGENTS_EVAL_TELEMETRY_FLUSH_SLEEP:-0.5}"
SNAPSHOT_FILE="${FLOW_AGENTS_EVAL_TELEMETRY_SNAPSHOT:-/tmp/promptfoo-eval-telemetry-snapshot.txt}"
TELEMETRY_FILE_MARKER="${FLOW_AGENTS_EVAL_TELEMETRY_FILE_MARKER:-/tmp/promptfoo-eval-telemetry-file.txt}"

AGENT=""
if [[ -n "$OPTIONS" ]]; then
  AGENT=$(node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);process.stdout.write(j.config?.agent||'')}catch{}})" <<<"$OPTIONS" 2>/dev/null || true)
fi
AGENT="${AGENT:-${FLOW_AGENTS_EVAL_AGENT:-dev}}"

profile_for_agent() {
  case "$1" in
    dev) echo "builder" ;;
    *) echo "" ;;
  esac
}


strip_json_events() {
  node -e "const rl=require('readline').createInterface({input:process.stdin});rl.on('line',l=>{if(!l)return;try{const o=JSON.parse(l);if(o.type==='agent_message'&&typeof o.text==='string')console.log(o.text);else if(o.type==='item.completed'&&o.item?.type==='agent_message'&&typeof o.item.text==='string')console.log(o.item.text)}catch{console.log(l)}})"
}

run_codex() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "$TIMEOUT" "${CODEX_CMD[@]}" "$PROMPT"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$TIMEOUT" "${CODEX_CMD[@]}" "$PROMPT"
  else
    "${CODEX_CMD[@]}" "$PROMPT"
  fi
}

prepare_workdir() {
  local work_root="${CODEX_EVAL_WORK_ROOT:-/tmp/flow-agents-codex-eval}"
  local work_dir="$work_root/$AGENT"
  rm -rf "$work_dir"
  mkdir -p "$work_dir"
  (cd "$ROOT_DIR" && flow_agents_node scripts/build-universal-bundles.js >/dev/null)
  cp -R "$ROOT_DIR/dist/codex/." "$work_dir/"
  cp "$work_dir/.codex/config.toml" "$work_dir/.codex/config-eval.toml"
  for auth_file in auth.json version.json installation_id; do
    if [[ -f "${CODEX_REAL_HOME:-$HOME/.codex}/$auth_file" ]]; then
      cp "${CODEX_REAL_HOME:-$HOME/.codex}/$auth_file" "$work_dir/.codex/$auth_file"
    fi
  done
  mkdir -p "$work_dir/.telemetry"
  echo "$work_dir"
}

WORK_DIR="$(prepare_workdir)"
TELEMETRY_FILE="$WORK_DIR/.telemetry/full.jsonl"
echo "$TELEMETRY_FILE" > "$TELEMETRY_FILE_MARKER"
if [[ -f "$TELEMETRY_FILE" ]]; then
  wc -l < "$TELEMETRY_FILE" | tr -d ' ' > "$SNAPSHOT_FILE"
else
  echo "0" > "$SNAPSHOT_FILE"
fi

PROFILE="$(profile_for_agent "$AGENT")"
if [[ -n "$PROFILE" ]]; then
  CODEX_CMD=(env CODEX_HOME="$WORK_DIR/.codex" codex -p "$PROFILE" exec --skip-git-repo-check -C "$WORK_DIR" --sandbox read-only --json)
else
  CODEX_CMD=(env CODEX_HOME="$WORK_DIR/.codex" codex -c "developer_instructions=$(node -e "const fs=require('fs'),p='$WORK_DIR/.codex/agents/$AGENT.toml';if(!fs.existsSync(p)){process.stdout.write('\"\"');process.exit(0)}const m=fs.readFileSync(p,'utf8').match(/^developer_instructions\\s*=\\s*(.+)$/m);process.stdout.write(m?m[1]:'\"\"')")" exec --skip-git-repo-check -C "$WORK_DIR" --sandbox read-only --json)
fi

set +e
RAW=$(run_codex 2>&1)
STATUS=$?
set -e
sleep "$FLUSH_SLEEP"
echo "$RAW" | strip_json_events | sed $'s/\x1b\[[0-9;]*[a-zA-Z]//g; s/\x1b\[[0-9;]*m//g; s/\x07//g'
exit "$STATUS"
