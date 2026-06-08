#!/usr/bin/env bash
# eval-provider.sh — Runtime-neutral promptfoo subject provider.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME="${FLOW_AGENTS_EVAL_RUNTIME:-${EVAL_RUNTIME:-kiro}}"
AGENT="${FLOW_AGENTS_EVAL_AGENT:-${KIRO_EVAL_AGENT:-dev}}"

export FLOW_AGENTS_EVAL_AGENT="$AGENT"
export KIRO_EVAL_AGENT="$AGENT"

case "$RUNTIME" in
  kiro|kiro-cli)
    exec bash "$SCRIPT_DIR/kiro-provider.sh" "$@"
    ;;
  codex)
    exec bash "$SCRIPT_DIR/codex-provider.sh" "$@"
    ;;
  claude|claude-code)
    exec bash "$SCRIPT_DIR/claude-provider.sh" "$@"
    ;;
  *)
    echo "Unsupported FLOW_AGENTS_EVAL_RUNTIME='$RUNTIME' (expected kiro, codex, or claude)" >&2
    exit 2
    ;;
esac
