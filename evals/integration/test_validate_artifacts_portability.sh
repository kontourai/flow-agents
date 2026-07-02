#!/usr/bin/env bash
# test_validate_artifacts_portability.sh — flow-agents-validate-artifacts must resolve its
# JSON Schemas relative to its own installed package, so it runs from any cwd that has no
# local schemas/ directory (the bug reproduced during planning was an uncaught ENOENT).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

errors=0
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

flow_agents_build_ts || { echo "  ✗ build failed (prerequisite)"; exit 1; }
SIDECAR="$ROOT/build/src/cli/workflow-sidecar.js"
VALIDATE="$ROOT/build/src/cli/validate-workflow-artifacts.js"

echo "=== validate-workflow-artifacts portability (foreign cwd, no local schemas/) ==="

FOREIGN="$TMP_DIR/foreign"
mkdir -p "$FOREIGN"

# Create a minimal valid sidecar set from the foreign cwd (no package.json/kits/schemas here).
( cd "$FOREIGN" && node "$SIDECAR" ensure-session --source-request "portability smoke" --summary "smoke" --criterion "c1" --task-slug port-smoke ) >"$TMP_DIR/ensure.out" 2>&1
if [[ -f "$FOREIGN/.kontourai/flow-agents/port-smoke/state.json" ]]; then
  pass "sidecar writer created a sidecar set from a foreign cwd"
else
  fail "ensure-session did not create sidecars in foreign cwd"
  sed -n '1,80p' "$TMP_DIR/ensure.out"
fi

if [[ ! -d "$FOREIGN/schemas" ]]; then
  pass "foreign cwd has no local schemas/ directory (faithful to the bug repro)"
else
  fail "foreign cwd unexpectedly has a schemas/ directory"
fi

# Run validate-artifacts from the foreign cwd; the schema load must resolve package-relative.
if ( cd "$FOREIGN" && node "$VALIDATE" .kontourai/flow-agents/port-smoke ) >"$TMP_DIR/validate.out" 2>&1; then
  if rg -q "Validated" "$TMP_DIR/validate.out"; then
    pass "validate-workflow-artifacts runs from a foreign cwd (schemas resolved package-relative)"
  else
    fail "validate-artifacts exited 0 but printed no validation summary"
    sed -n '1,80p' "$TMP_DIR/validate.out"
  fi
else
  fail "validate-artifacts crashed from a foreign cwd (schema-path ENOENT regression?)"
  sed -n '1,80p' "$TMP_DIR/validate.out"
fi

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "validate-artifacts portability checks passed."
  exit 0
fi
echo "validate-artifacts portability checks failed: $errors issue(s)."
exit 1
