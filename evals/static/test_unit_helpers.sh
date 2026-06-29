#!/usr/bin/env bash
# test_unit_helpers.sh — Layer 1: TypeScript-layer unit tests for the PURE
# workflow-sidecar helpers (ops#22).
#
# Historically every assertion covering workflow-sidecar was black-box bash driving
# the CLI. These node:test units exercise the pure projection/validation helpers
# directly against the built JS — fast, deterministic, isolated — and complement
# (do not replace) the bash evals.
set -uo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "── TS pure-helper unit tests (node --test) ──"

# The units import the build output. CI builds before evals; build here too when run
# standalone so the test is self-sufficient.
if [[ ! -f build/src/cli/workflow-sidecar.js ]]; then
  npm run build --silent
fi

if node --test src/cli/*.test.mjs; then
  echo "  PASS: workflow-sidecar pure-helper unit tests"
else
  echo "  FAIL: workflow-sidecar pure-helper unit tests"
  exit 1
fi
