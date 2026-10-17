#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
[[ -f "$ROOT/evals/fixtures/ci-compute/lock.json" ]] || { echo "FAIL: immutable callee lock missing" >&2; exit 1; }
node --test evals/ci/compute-policy.test.mjs
