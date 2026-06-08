#!/usr/bin/env bash
# claude-provider.sh — Promptfoo exec provider that runs Flow Agents through Claude Code.
set -euo pipefail

PROMPT="${1:-}"
OPTIONS="${2:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
TIMEOUT="${CLAUDE_EVAL_TIMEOUT:-300}"
FLUSH_SLEEP="${FLOW_AGENTS_EVAL_TELEMETRY_FLUSH_SLEEP:-0.5}"
SNAPSHOT_FILE="${FLOW_AGENTS_EVAL_TELEMETRY_SNAPSHOT:-/tmp/promptfoo-eval-telemetry-snapshot.txt}"
TELEMETRY_FILE_MARKER="${FLOW_AGENTS_EVAL_TELEMETRY_FILE_MARKER:-/tmp/promptfoo-eval-telemetry-file.txt}"

AGENT=""
if [[ -n "$OPTIONS" ]]; then
  AGENT=$(node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);process.stdout.write(j.config?.agent||'')}catch{}})" <<<"$OPTIONS" 2>/dev/null || true)
fi
AGENT="${AGENT:-${FLOW_AGENTS_EVAL_AGENT:-dev}}"

if ! command -v claude >/dev/null 2>&1; then
  echo "claude CLI is not installed or not on PATH" >&2
  exit 2
fi

run_claude() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "$TIMEOUT" "${CLAUDE_CMD[@]}"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$TIMEOUT" "${CLAUDE_CMD[@]}"
  else
    "${CLAUDE_CMD[@]}"
  fi
}

prepare_workdir() {
  local work_root="${CLAUDE_EVAL_WORK_ROOT:-/tmp/flow-agents-claude-eval}"
  local work_dir="$work_root/$AGENT"
  rm -rf "$work_dir"
  mkdir -p "$work_dir"
  (cd "$ROOT_DIR" && flow_agents_node scripts/build-universal-bundles.js >/dev/null)
  bash "$ROOT_DIR/dist/claude-code/install.sh" "$work_dir" >/dev/null
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

CLAUDE_CMD=(
  env
  FLOW_AGENTS_CLAUDE_TELEMETRY_CHANNELS="${FLOW_AGENTS_CLAUDE_TELEMETRY_CHANNELS:-full,analytics}"
  claude
  -p
  --agent "$AGENT"
  --permission-mode bypassPermissions
  --add-dir "$WORK_DIR"
  --output-format text
  "$PROMPT"
)

set +e
RAW=$(cd "$WORK_DIR" && run_claude 2>&1)
STATUS=$?
set -e
sleep "$FLUSH_SLEEP"
echo "$RAW" | sed $'s/\x1b\[[0-9;]*[a-zA-Z]//g; s/\x1b\[[0-9;]*m//g; s/\x07//g' \
  | grep -v '^\s*$'
exit "$STATUS"
