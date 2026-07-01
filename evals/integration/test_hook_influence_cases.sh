#!/usr/bin/env bash
# test_hook_influence_cases.sh - behavioral hook-influence fixture contracts
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

errors=0

_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

CASES="$ROOT/evals/fixtures/hook-influence/cases.json"
VALIDATOR="$ROOT/scripts/validate-hook-influence-cases.js"

if [[ -f "$CASES" ]]; then
  _pass "hook influence case fixture exists"
else
  _fail "hook influence case fixture missing"
fi

if [[ -f "$VALIDATOR" ]]; then
  _pass "hook influence case validator exists"
else
  _fail "hook influence case validator missing"
fi

if flow_agents_node "$VALIDATOR" "$CASES" > /tmp/flow-agents-hook-influence.out 2> /tmp/flow-agents-hook-influence.err; then
  _pass "hook influence behavioral cases validate"
else
  _fail "hook influence behavioral cases failed validation: $(cat /tmp/flow-agents-hook-influence.out /tmp/flow-agents-hook-influence.err)"
fi

if rg -q '"tier": "adapter"' "$CASES" \
  && rg -q '"tier": "live-acceptance"' "$CASES" \
  && rg -q '"tier": "installed-command"' "$CASES" \
  && rg -q '"tier": "documented-runtime-gap"' "$CASES" \
  && rg -q '"tier": "design-target"' "$CASES"; then
  _pass "hook influence cases distinguish adapter, live, installed-command, documented runtime-gap, and design-target evidence"
else
  _fail "hook influence cases do not distinguish required evidence tiers"
fi

if rg -q 'FLOW_AGENTS_ACCEPTANCE_CLAUDE_LLM=1' "$CASES" \
  && rg -q '"runtime_scope": \["kiro-cli"\]' "$CASES" \
  && rg -q 'codex exec exposes project hook guidance' "$CASES"; then
  _pass "hook influence cases cover Claude, Kiro, and Codex runtime boundaries"
else
  _fail "hook influence cases miss a runtime boundary"
fi

if rg -q 'dev-builder-build-requires-pickup-probe-before-plan' "$CASES" \
  && rg -q 'dev-builder-review-before-verify-after-execute' "$CASES" \
  && rg -q 'dev-builder-route-fresh-coding-prompt' "$CASES" \
  && rg -q 'dev-verify-fail-preserves-trace-before-rework' "$CASES" \
  && rg -q 'codex-claude-strict-stop-adapter-contract' "$CASES"; then
  _pass "hook influence cases cover #62 Builder Kit loop categories"
else
  _fail "hook influence cases miss a required #62 Builder Kit loop category"
fi

rm -f /tmp/flow-agents-hook-influence.out /tmp/flow-agents-hook-influence.err

if [[ "$errors" -eq 0 ]]; then
  echo "Hook influence case integration passed."
  exit 0
fi

echo "Hook influence case integration failed: $errors issue(s)."
exit 1
