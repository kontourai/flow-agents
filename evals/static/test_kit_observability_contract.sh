#!/usr/bin/env bash
# Headless conformance: first-party and third-party Kits consume the identical
# observability contribution contract; no Console, Station, or host is installed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
FIXTURE_ROOT="$ROOT/evals/fixtures/kit-observability"

if [[ ! -d "$FIXTURE_ROOT" ]]; then
  echo "missing Kit observability fixture root: $FIXTURE_ROOT" >&2
  exit 1
fi

echo "=== Kit observability contribution contract ==="
npm run build --silent
node --test src/cli/kit-observability-contract.test.mjs
