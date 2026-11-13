#!/usr/bin/env bash
# Requires build:bundles; runs real, self-cleaning global installs with no model calls.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
node --test src/cli/vendored-runtime-kits.test.mjs
