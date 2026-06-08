#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export FLOW_AGENTS_EVAL_AGENT=dev
export KIRO_EVAL_AGENT=dev
exec bash "$SCRIPT_DIR/eval-provider.sh" "$@"
