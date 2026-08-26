#!/usr/bin/env bash
# opencode-judge.sh — LLM-rubric judge via opencode (fallback to kiro when opencode judge not configured)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if command -v opencode >/dev/null 2>&1 && [[ -n "${FLOW_AGENTS_OPENCODE_JUDGE_MODEL:-}" ]]; then
  exec bash "$SCRIPT_DIR/opencode-provider.sh" "$@"
else
  # Default judge: reuse kiro judge (promptfoo supports cross-runtime judge variants)
  # Allows opencode subject + kiro judge without requiring an opencode-hosted judge model.
  exec bash "$SCRIPT_DIR/kiro-judge.sh" "$@"
fi
