#!/usr/bin/env bash
# pi-provider.sh — Promptfoo exec provider that runs pi agents with Flow Agents kit
# Usage: bash pi-provider.sh <prompt> <options_json> <context_json>
set -o pipefail

PROMPT="$1"
OPTIONS="$2"
TIMEOUT="${PI_EVAL_TIMEOUT:-300}"
SNAPSHOT_FILE="${FLOW_AGENTS_EVAL_TELEMETRY_SNAPSHOT:-/tmp/promptfoo-eval-telemetry-snapshot.txt}"
TELEMETRY_FILE_MARKER="${FLOW_AGENTS_EVAL_TELEMETRY_FILE_MARKER:-/tmp/promptfoo-eval-telemetry-file.txt}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [[ -n "$OPTIONS" ]]; then
  AGENT=$(node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);process.stdout.write(j.config?.agent||'')}catch{}})" <<<"$OPTIONS" 2>/dev/null || true)
fi
AGENT="${AGENT:-${FLOW_AGENTS_EVAL_AGENT:-dev}}"

prepare_workdir() {
  local work_root="${PI_EVAL_WORK_ROOT:-/tmp/flow-agents-pi-eval}"
  local work_dir="$work_root/$AGENT"
  rm -rf "$work_dir"
  mkdir -p "$work_dir"
  (cd "$ROOT_DIR" && flow_agents_node scripts/build-universal-bundles.js >/dev/null 2>&1) || true
  if [[ -d "$ROOT_DIR/dist/pi" ]]; then
    bash "$ROOT_DIR/dist/pi/install.sh" "$work_dir" >/dev/null 2>&1 || true
  fi
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

if ! command -v pi >/dev/null 2>&1; then
  echo "[SKIP] pi CLI not installed on this host — kit engagement not measured (harness-blind, not a failure)"
  exit 0
fi

set +e
if command -v timeout >/dev/null 2>&1; then
  RAW=$(timeout "$TIMEOUT" pi --approve -p "$PROMPT" 2>&1)
  STATUS=$?
elif command -v gtimeout >/dev/null 2>&1; then
  RAW=$(gtimeout "$TIMEOUT" pi --approve -p "$PROMPT" 2>&1)
  STATUS=$?
else
  RAW=$(pi --approve -p "$PROMPT" 2>&1)
  STATUS=$?
fi
set -e

CLEAN=$(printf '%s' "$RAW" | sed $'s/\x1b\\[[0-9;]*[a-zA-Z]//g; s/\x1b\\[[0-9;]*m//g; s/\x07//g')
echo "$CLEAN" | grep -v '^\s*$' || true
exit "$STATUS"
