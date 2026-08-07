#!/usr/bin/env bash
# eval-judge.sh — Runtime-neutral promptfoo rubric judge provider.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME="${FLOW_AGENTS_EVAL_JUDGE_RUNTIME:-${FLOW_AGENTS_EVAL_RUNTIME:-${EVAL_RUNTIME:-kiro}}}"

case "$RUNTIME" in
  kiro|kiro-cli)
    exec bash "$SCRIPT_DIR/kiro-judge.sh" "$@"
    ;;
  codex)
    exec bash "$SCRIPT_DIR/codex-judge.sh" "$@"
    ;;
  claude|claude-code)
    exec bash "$SCRIPT_DIR/claude-judge.sh" "$@"
    ;;
  opencode)
    exec bash "$SCRIPT_DIR/opencode-judge.sh" "$@"
    ;;
  pi)
    exec bash "$SCRIPT_DIR/pi-judge.sh" "$@"
    ;;
  strands|strands-local)
    exec bash "$SCRIPT_DIR/strands-provider.sh" "$@"
    ;;
  *)
    echo "Unsupported FLOW_AGENTS_EVAL_JUDGE_RUNTIME='$RUNTIME' (expected kiro, codex, claude, opencode, pi, strands)" >&2
    exit 2
    ;;
esac
