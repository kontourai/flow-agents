#!/usr/bin/env bash
# Observe mode (docs/decisions/observe-mode.md): the reminder engine, check locks, git-diff scope,
# hook-triggered verification and the handoff, through the real Stop hook and public CLI.
# Runs in the required anti-gaming suite so weakening the engine cannot merge silently.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
if [[ ! -f build/src/observe-mode.js ]]; then
  echo "FAIL: build/src/observe-mode.js is missing; run npm run build first"
  exit 1
fi
node --test --import ./src/cli/unit-test-state.mjs src/cli/observe-mode.test.mjs
