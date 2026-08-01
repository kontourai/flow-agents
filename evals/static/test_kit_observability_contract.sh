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
node --test src/cli/kit-observability-conformance.test.mjs

node --input-type=module -e '
import { KIT_OBSERVABILITY_CONFORMANCE_VECTORS, runKitObservabilityConformance } from "@kontourai/flow-agents/kit-observability-conformance";
if (KIT_OBSERVABILITY_CONFORMANCE_VECTORS.length < 4 || !runKitObservabilityConformance().passed) process.exit(1);
'

npm pack --dry-run --json --ignore-scripts | node -e '
import("node:readline").then(({ createInterface }) => {
  const names = new Set();
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const match = line.match(/"path": "(build\/src\/kit-observability-conformance(?:\.d)?\.ts|build\/src\/kit-observability-conformance\.js)"/);
    if (match) names.add(match[1]);
  });
  lines.on("close", () => {
    for (const required of ["build/src/kit-observability-conformance.js", "build/src/kit-observability-conformance.d.ts"]) {
      if (!names.has(required)) process.exitCode = 1;
    }
  });
});
'
