#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ACCEPT_DIR="$ROOT_DIR/evals/acceptance"
TARGET="${1:-all}"

run_one() {
  local name="$1"
  echo ""
  bash "$ACCEPT_DIR/test_${name}_harness.sh"
}

case "$TARGET" in
  kiro|claude|codex|opencode|pi)
    run_one "$TARGET"
    ;;
  all)
    status=0
    run_one kiro || status=1
    run_one claude || status=1
    run_one codex || status=1
    run_one opencode || status=1
    run_one pi || status=1
    exit "$status"
    ;;
  *)
    echo "Usage: bash evals/acceptance/run.sh [all|kiro|claude|codex|opencode|pi]"
    exit 1
    ;;
esac
