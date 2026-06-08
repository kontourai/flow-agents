#!/usr/bin/env bash
set -euo pipefail

if [[ "${VERITAS_ARGV_LOG:-}" != "" ]]; then
  printf '%s\n' "$*" > "$VERITAS_ARGV_LOG"
fi

expected='readiness --check evidence --working-tree'
if [[ "${VERITAS_EXPECT_ROOT:-}" != "" ]]; then
  expected="$expected --root $VERITAS_EXPECT_ROOT"
fi

if [[ "$*" != "$expected" ]]; then
  echo "unexpected argv: $*" >&2
  exit 70
fi

echo "fixture Veritas readiness passed"
