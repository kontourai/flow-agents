#!/usr/bin/env bash
# test_unit_helpers.sh — TypeScript-layer contract and CLI integration tests.
#
# Historically every assertion covering workflow-sidecar was black-box bash driving
# the CLI. These node:test units exercise the pure projection/validation helpers
# directly against the built JS — fast, deterministic, isolated — and complement
# (do not replace) the bash evals.
set -uo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "── TS contract and CLI integration tests (node --test) ──"

# The units import the build output. CI builds before evals; build here too when run
# standalone so the test is self-sufficient.
if [[ ! -f build/src/cli/workflow-sidecar.js ]]; then
  npm run build --silent
fi

node scripts/build-test-support.mjs

# Files include process-heavy CLI fixtures; bound file workers to avoid host oversubscription.
if node --test --test-concurrency=4 --import ./src/cli/unit-test-state.mjs src/cli/*.test.mjs; then
  echo "  PASS: TypeScript contract and CLI integration tests"
else
  echo "  FAIL: TypeScript contract and CLI integration tests"
  exit 1
fi
