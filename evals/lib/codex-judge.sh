#!/usr/bin/env bash
# codex-judge.sh — Promptfoo exec provider for llm-rubric judging via Codex.
set -euo pipefail

PROMPT="${1:-}"
TIMEOUT="${CODEX_EVAL_JUDGE_TIMEOUT:-180}"
MAX_LEN=200000
if [[ ${#PROMPT} -gt $MAX_LEN ]]; then
  PROMPT="${PROMPT:0:$MAX_LEN}... [truncated for eval - output exceeded ${MAX_LEN} chars]"
fi

OUT="$(mktemp /tmp/flow-agents-codex-judge.XXXXXX)"
LOG="$(mktemp /tmp/flow-agents-codex-judge-log.XXXXXX)"
trap 'rm -f "$OUT" "$LOG"' EXIT

if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD=(timeout "$TIMEOUT")
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD=(gtimeout "$TIMEOUT")
else
  TIMEOUT_CMD=()
fi

"${TIMEOUT_CMD[@]}" codex exec \
  --ignore-user-config \
  --skip-git-repo-check \
  -C /tmp \
  --sandbox read-only \
  --json \
  -c model='"gpt-5.5"' \
  -c model_reasoning_effort='"medium"' \
  --output-last-message "$OUT" \
  "$PROMPT" >"$LOG" 2>&1 || {
    cat "$OUT" 2>/dev/null
    sed -n '1,120p' "$LOG" >&2
    exit 1
  }

cat "$OUT"
