#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export KIRO_EVAL_AGENT=dev
exec bash "$SCRIPT_DIR/kiro-provider.sh" "$@"
