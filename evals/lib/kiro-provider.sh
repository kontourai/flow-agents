#!/usr/bin/env bash
# kiro-provider.sh — Promptfoo exec provider that runs kiro-cli agents
# Usage: bash kiro-provider.sh <prompt> <options_json> <context_json>
# Agent is determined from the prompt's {{agent}} variable passed via options JSON
set -o pipefail

PROMPT="$1"
OPTIONS="$2"
SNAPSHOT_FILE="/tmp/promptfoo-eval-telemetry-snapshot.txt"
TIMEOUT="${KIRO_EVAL_TIMEOUT:-300}"

# Extract agent from options JSON or env var
if [[ -n "$OPTIONS" ]]; then
  AGENT=$(node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);process.stdout.write(j.config?.agent||'')}catch{}})" <<<"$OPTIONS" 2>/dev/null)
fi
AGENT="${AGENT:-${KIRO_EVAL_AGENT:-dev}}"

# Auto-detect telemetry file from installed agent location
_find_telemetry() {
  local agent="$1"
  for f in "$HOME/.kiro/agents/"*"-${agent}.json"; do
    [[ -f "$f" ]] || continue
    local pkg_path
    pkg_path=$(grep -o "$HOME/.flow-agents\"]*" "$f" 2>/dev/null | head -1 | sed 's|/context/.*||')
    if [[ -n "$pkg_path" && -f "$pkg_path/.telemetry/full.jsonl" ]]; then
      echo "$pkg_path/.telemetry/full.jsonl"
      return
    fi
  done
  echo "$HOME/.flow-agents"
}
TELEMETRY_FILE="$(_find_telemetry "$AGENT")"

SAFE_TOOLS="read files,code,grep,glob,knowledge,web_search,web_fetch,delegate to a specialist agent,todo tool,thinking,session,report_issue"

# Snapshot telemetry line count before run
if [[ -f "$TELEMETRY_FILE" ]]; then
  wc -l < "$TELEMETRY_FILE" | tr -d ' ' > "$SNAPSHOT_FILE"
else
  echo "0" > "$SNAPSHOT_FILE"
fi

# Run agent, capture output
RAW=$(timeout "$TIMEOUT" kiro-cli chat \
  --agent "$AGENT" \
  --no-interactive \
  --trust-tools "$SAFE_TOOLS" \
  "$PROMPT" 2>/dev/null)

# Strip ANSI escape codes and bell chars
CLEAN=$(echo "$RAW" | sed $'s/\x1b\[[0-9;]*[a-zA-Z]//g; s/\x1b\[[0-9;]*m//g; s/\x07//g')

# Remove kiro chrome lines but keep the actual response content
echo "$CLEAN" | grep -v '^\s*$' \
  | grep -v 'hooks finished' \
  | grep -v 'Credits:' \
  | grep -v 'WARNING:' \
  | grep -v 'All tools are now trusted' \
  | grep -v 'Checkpoints are not' \
  | grep -v 'Learn more at' \
  | sed 's/^> //' \
  | sed 's/^[[:space:]]*//'
