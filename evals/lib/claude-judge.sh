#!/usr/bin/env bash
# claude-judge.sh — Promptfoo exec provider for llm-rubric judging via Claude Code.
set -euo pipefail

PROMPT="${1:-}"
TIMEOUT="${CLAUDE_EVAL_JUDGE_TIMEOUT:-180}"
MAX_LEN=200000
if [[ ${#PROMPT} -gt $MAX_LEN ]]; then
  PROMPT="${PROMPT:0:$MAX_LEN}... [truncated for eval - output exceeded ${MAX_LEN} chars]"
fi

OUT="$(mktemp /tmp/flow-agents-claude-judge.XXXXXX)"
LOG="$(mktemp /tmp/flow-agents-claude-judge-log.XXXXXX)"
trap 'rm -f "$OUT" "$LOG"' EXIT

if ! command -v claude >/dev/null 2>&1; then
  echo "claude CLI is not installed or not on PATH" >&2
  exit 2
fi

if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD=(timeout "$TIMEOUT")
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD=(gtimeout "$TIMEOUT")
else
  TIMEOUT_CMD=()
fi

"${TIMEOUT_CMD[@]}" claude \
  -p \
  --permission-mode bypassPermissions \
  --add-dir /tmp \
  --output-format text \
  "$PROMPT" >"$OUT" 2>"$LOG" || {
    cat "$OUT" 2>/dev/null
    sed -n '1,120p' "$LOG" >&2
    exit 1
  }

cat "$OUT"
