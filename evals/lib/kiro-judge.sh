#!/usr/bin/env bash
# kiro-judge.sh — Promptfoo exec provider for llm-rubric judging via kiro-cli
set -o pipefail
PROMPT="$1"

# Truncate if too large for shell args (macOS limit ~262144 bytes)
MAX_LEN=200000
if [[ ${#PROMPT} -gt $MAX_LEN ]]; then
  PROMPT="${PROMPT:0:$MAX_LEN}... [truncated for eval — output exceeded ${MAX_LEN} chars]"
fi

RAW=$(kiro-cli chat --no-interactive --trust-tools "" "$PROMPT" 2>/dev/null)
echo "$RAW" | sed $'s/\x1b\[[0-9;]*[a-zA-Z]//g; s/\x1b\[[0-9;]*m//g; s/\x07//g' \
  | grep -v '^\s*$' | grep -v 'hooks finished' | grep -v 'Credits:' \
  | grep -v 'WARNING:' | grep -v 'All tools are now trusted' \
  | grep -v 'Checkpoints are not' | grep -v 'Learn more at' \
  | sed 's/^> //' | sed 's/^[[:space:]]*//'
