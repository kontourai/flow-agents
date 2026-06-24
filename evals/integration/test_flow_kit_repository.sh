#!/usr/bin/env bash
# test_flow_kit_repository.sh — Validate local Flow Kit repository fixtures and diagnostics.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

errors=0
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

run_validator() {
  local fixture="$1"
  local output="$2"
  flow_agents_node "$ROOT/scripts/validate-source-tree.js" --kit "$ROOT/evals/fixtures/flow-kit-repository/$fixture" >"$output" 2>&1
}

expect_pass() {
  local fixture="$1"
  local output="$TMP_DIR/$fixture.out"
  if run_validator "$fixture" "$output"; then
    if rg -q 'Flow Kit repository validation passed' "$output"; then
      pass "$fixture passes local kit repository validation"
    else
      fail "$fixture did not print pass diagnostic"
      sed -n '1,120p' "$output"
    fi
  else
    fail "$fixture should pass local kit repository validation"
    sed -n '1,120p' "$output"
  fi
}

expect_fail() {
  local fixture="$1"
  local pattern="$2"
  local output="$TMP_DIR/$fixture.out"
  if run_validator "$fixture" "$output"; then
    fail "$fixture should fail local kit repository validation"
    sed -n '1,120p' "$output"
    return
  fi
  if rg -q "$pattern" "$output"; then
    pass "$fixture fails with actionable diagnostic"
  else
    fail "$fixture diagnostic missing pattern: $pattern"
    sed -n '1,160p' "$output"
  fi
}

echo "=== Flow Kit Repository Fixture Checks ==="
expect_pass "valid-local-kit"
expect_pass "valid-unknown-extension"
expect_fail "invalid-schema-version" '\.schema_version must be "1\.0"'
expect_fail "invalid-missing-schema-version" '\.schema_version must be "1\.0"'
expect_fail "invalid-id" '\.id must be a kebab-case string'
expect_fail "invalid-missing-id" '\.id must be a kebab-case string'
expect_fail "invalid-name" '\.name must be a non-empty string'
expect_fail "invalid-missing-flow" 'flows\[0\]\.path points at missing Flow Definition'
expect_fail "invalid-absolute-path" 'flows\[0\]\.path must be relative'
expect_fail "invalid-traversal" "flows\\[0\\]\\.path must not contain"
expect_fail "invalid-malformed-json" 'invalid JSON'
expect_fail "invalid-asset-section" '\.docs must be a list'
expect_fail "invalid-missing-extension-asset" 'docs\[0\]\.path points at missing asset'
expect_fail "invalid-duplicate-flow" "flows\\[1\\]\\.path duplicates"

echo ""
echo "=== Builder Kit Shared Validation Check ==="
builder_output="$TMP_DIR/source-tree.out"
if flow_agents_node "$ROOT/scripts/validate-source-tree.js" >"$builder_output" 2>&1; then
  if rg -q 'Source tree validation passed' "$builder_output"; then
    pass "source-tree validation keeps Builder Kit on shared validation path"
  else
    fail "source-tree validation did not print pass diagnostic"
    sed -n '1,160p' "$builder_output"
  fi
else
  fail "source-tree validation failed while checking Builder Kit"
  sed -n '1,220p' "$builder_output"
fi

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "Flow Kit repository fixture checks passed."
  exit 0
fi

echo "Flow Kit repository fixture checks failed: $errors issue(s)."
exit 1
