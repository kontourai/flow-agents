#!/usr/bin/env bash
# test_context_map.sh — Generated context map drift and content checks
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MAP="$ROOT/docs/context-map.md"
TMPDIR_EVAL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_EVAL"' EXIT

errors=0
_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

if (cd "$ROOT" && npm run context-map:check) >"$TMPDIR_EVAL/check.out" 2>"$TMPDIR_EVAL/check.err"; then
  _pass "context map is current"
else
  _fail "context map is stale: $(cat "$TMPDIR_EVAL/check.out" "$TMPDIR_EVAL/check.err")"
fi

if (cd "$ROOT" && npm run context-map -- --output "$TMPDIR_EVAL/context-map.md") >"$TMPDIR_EVAL/generate.out" 2>"$TMPDIR_EVAL/generate.err" && cmp -s "$MAP" "$TMPDIR_EVAL/context-map.md"; then
  _pass "context map generation is deterministic"
else
  _fail "context map generation is not deterministic"
fi

if (cd "$ROOT" && npm run context-map -- --include-runtime --output "$TMPDIR_EVAL/runtime-context-map.md") >"$TMPDIR_EVAL/runtime.out" 2>"$TMPDIR_EVAL/runtime.err" &&
  rg -q 'Current Workflow State' "$TMPDIR_EVAL/runtime-context-map.md"; then
  _pass "context map supports optional runtime workflow state"
else
  _fail "runtime context map generation failed"
fi

for expected in \
  'Repository Shape' \
  'Core Commands' \
  'Workflow Sidecars' \
  'Workflow Skills' \
  'Support Skills' \
  'Agents' \
  'Optional Powers' \
  'Context Loading Rules' \
  'npm run context-map:check' \
  'workflow-release.schema.json' \
  'workflow-learning.schema.json' \
  'plan-work' \
  'tool-planner' \
  'Eval-first execution' \
  'Research-before-coding workflow' \
  'Save durable knowledge'; do
  if rg -q "$expected" "$MAP"; then
    _pass "context map includes $expected"
  else
    _fail "context map missing $expected"
  fi
done

if [[ "$errors" -eq 0 ]]; then
  echo "Context map integration passed."
  exit 0
fi

echo "Context map integration failed: $errors issue(s)."
exit 1
