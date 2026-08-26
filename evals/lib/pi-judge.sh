#!/usr/bin/env bash
# pi-judge.sh — LLM-rubric judge via pi (fallback to kiro when pi judge not configured)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if command -v pi >/dev/null 2>&1 && [[ -n "${FLOW_AGENTS_PI_JUDGE_MODEL:-}" ]]; then
  exec bash "$SCRIPT_DIR/pi-provider.sh" "$@"
else
  exec bash "$SCRIPT_DIR/kiro-judge.sh" "$@"
fi
