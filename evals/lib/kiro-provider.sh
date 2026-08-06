#!/usr/bin/env bash
# kiro-provider.sh — Promptfoo exec provider that runs kiro-cli agents
# Usage: bash kiro-provider.sh <prompt> <options_json> <context_json>
# Agent is determined from the prompt's {{agent}} variable passed via options JSON
set -o pipefail

PROMPT="$1"
OPTIONS="$2"
SNAPSHOT_FILE="/tmp/promptfoo-eval-telemetry-snapshot.txt"
TIMEOUT="${KIRO_EVAL_TIMEOUT:-300}"

# Kit agent selection — consistent out of the box: default agent via kit hooks, no custom agent required.
# For harnesses that support splitting, set EVALS_KIT_AGENT=builder (or FLOW_AGENTS_KIT_AGENT) to run via custom agent.
# When set, the provider validates via that agent's bundle + hooks; when unset, it validates via default agent.
EVALS_KIT_AGENT="${EVALS_KIT_AGENT:-${FLOW_AGENTS_KIT_AGENT:-}}"
if [[ -n "$OPTIONS" ]]; then
  AGENT=$(node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);process.stdout.write(j.config?.agent||'')}catch{}})" <<<"$OPTIONS" 2>/dev/null)
fi
# Default to EVALS_KIT_AGENT if set, else no custom agent (empty → default)
if [[ -z "$AGENT" || "$AGENT" == "dev" ]]; then
  # Respect explicit EVALS_KIT_AGENT even when OPTIONS is empty; allow 'dev' back-compat
  AGENT="${EVALS_KIT_AGENT:-${KIRO_EVAL_AGENT:-}}"
  # If still empty and no flag, leave AGENT empty to use default agent (consistent)
fi

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

# Run agent — when AGENT is empty, use default agent (no --agent flag) for consistency
if [[ -n "$AGENT" ]]; then
  RAW=$(timeout "$TIMEOUT" kiro-cli chat \
    --agent "$AGENT" \
    --no-interactive \
    --trust-tools "$SAFE_TOOLS" \
    "$PROMPT" 2>/dev/null)
else
  RAW=$(timeout "$TIMEOUT" kiro-cli chat \
    --no-interactive \
    --trust-tools "$SAFE_TOOLS" \
    "$PROMPT" 2>/dev/null)
fi

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
