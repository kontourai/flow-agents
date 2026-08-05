#!/usr/bin/env bash
# test_pr_title_validation.sh — black-box coverage for the required PR-title contract.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VALIDATOR="$ROOT/scripts/ci/validate-pr-title.mjs"
WORKFLOW="$ROOT/.github/workflows/ci.yml"
RUNNER="$ROOT/evals/run.sh"
CONTRIBUTING="$ROOT/CONTRIBUTING.md"

errors=0
passes=0
pass() { passes=$((passes + 1)); echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

expect_valid() {
  local label="$1"
  local title="$2"
  local output status
  if output="$(PR_TITLE="$title" node "$VALIDATOR" 2>&1)"; then
    status=0
  else
    status=$?
  fi
  if [[ "$status" -eq 0 ]]; then
    pass "$label"
  else
    fail "$label (expected exit 0, got $status: $output)"
  fi
}

expect_invalid() {
  local label="$1"
  local title="$2"
  local output status
  if output="$(PR_TITLE="$title" node "$VALIDATOR" 2>&1)"; then
    status=0
  else
    status=$?
  fi
  if [[ "$status" -ne 0 && "$output" == *"Expected PR title format:"* ]]; then
    pass "$label"
  else
    fail "$label (expected a format failure, got exit $status: $output)"
  fi
}

echo "=== Pull request title validation ==="

test -f "$VALIDATOR"
pass "validator exists"

expect_valid "accepts a human-authored fix title" "fix: normalize legacy lifecycle assignment actors"
expect_valid "accepts the exact implementation PR title" "fix(ci): require conventional pull request titles"
expect_valid "accepts a scoped breaking title" "fix(scope)!: describe a breaking correction"
expect_valid "accepts a type-level breaking title" "feat!: describe a breaking correction"
expect_valid "accepts a Release Please title" "chore(main): release 4.6.1"
expect_valid "accepts a Dependabot title" "chore(deps): bump actions/setup-node from 6.4.0 to 7.0.0"
expect_valid "accepts an unlisted lowercase type" "ci: validate the title contract"

expect_invalid "rejects the exact #825 title" "Fix legacy lifecycle actor retry recovery"
expect_invalid "rejects an uppercase type" "Fix: normalize legacy lifecycle assignment actors"
expect_invalid "rejects an empty scope" "fix(): normalize legacy lifecycle assignment actors"
expect_invalid "rejects missing separator spacing" "fix:normalize legacy lifecycle assignment actors"
expect_invalid "rejects extra separator spacing" "fix:  normalize legacy lifecycle assignment actors"
expect_invalid "rejects an empty subject" "fix: "
expect_invalid "rejects a whitespace-only subject" "fix:    "
expect_invalid "rejects a misplaced breaking marker" "fix(scope!): describe a breaking correction"
expect_invalid "rejects a newline in the title" $'fix: one line\nsecond line'
expect_invalid "rejects a TAB in the title" $'fix: a\ttab'
expect_invalid "rejects an ESC character in the title" $'fix: an\eescape'
expect_invalid "rejects a DEL character in the title" $'fix: a\x7fdelete'
expect_invalid "rejects a C1 control character in the title" $'fix: a\xc2\x9fcontrol'
expect_invalid "rejects a Unicode line separator in the title" $'fix: a\xe2\x80\xa8separator'
expect_invalid "rejects a Unicode paragraph separator in the title" $'fix: a\xe2\x80\xa9separator'

if missing_output="$(env -u PR_TITLE node "$VALIDATOR" 2>&1)"; then
  missing_status=0
else
  missing_status=$?
fi
if [[ "$missing_status" -ne 0 && "$missing_output" == *"PR_TITLE is required."* ]]; then
  pass "fails loudly when PR_TITLE is missing"
else
  fail "missing PR_TITLE should fail loudly (exit $missing_status: $missing_output)"
fi

marker="$(mktemp "${TMPDIR:-/tmp}/flow-agents-pr-title-marker.XXXXXX")" || {
  echo "FAIL: could not create injection sentinel" >&2
  exit 1
}
trap 'rm -f -- "$marker"' EXIT
rm -f -- "$marker"
expect_valid "treats injection-looking valid input as inert data" "fix: \$(touch $marker)"
if [[ ! -e "$marker" ]]; then
  pass "never evaluates PR_TITLE content"
else
  fail "PR_TITLE content was unexpectedly evaluated"
fi

source_and_static="$(sed -n '/^  source-and-static:/,/^  workflow-contracts:/p' "$WORKFLOW")"
node_setup_index="$(printf '%s' "$source_and_static" | grep -b -o 'name: Set up Node.js' | head -1 | cut -d: -f1 || true)"
title_step_index="$(printf '%s' "$source_and_static" | grep -b -o 'name: Validate pull request title' | head -1 | cut -d: -f1 || true)"
npm_ci_index="$(printf '%s' "$source_and_static" | grep -b -o 'run: npm ci' | head -1 | cut -d: -f1 || true)"

if [[ -n "$node_setup_index" && -n "$title_step_index" && -n "$npm_ci_index" && "$node_setup_index" -lt "$title_step_index" && "$title_step_index" -lt "$npm_ci_index" ]]; then
  pass "CI validates the title after Node setup and before npm ci"
else
  fail "CI title-validation step is not ordered between Node setup and npm ci"
fi

if [[ "$source_and_static" == *"if: github.event_name == 'pull_request'"* && "$source_and_static" == *'PR_TITLE: ${{ github.event.pull_request.title }}'* && "$source_and_static" == *"run: node scripts/ci/validate-pr-title.mjs"* ]]; then
  pass "CI passes the pull request title through PR_TITLE to Node"
else
  fail "CI does not use the required pull_request-only PR_TITLE-to-Node boundary"
fi

pull_request_trigger="$(sed -n '/^  pull_request:/,/^  push:/p' "$WORKFLOW")"
if [[ "$pull_request_trigger" == *'types: [opened, synchronize, reopened, edited]'* ]]; then
  pass "CI validates opened, synchronized, reopened, and edited pull requests"
else
  fail "CI must explicitly validate the default pull request lifecycle and title edits"
fi

title_step="$(sed -n '/name: Validate pull request title/,/name: Install Node dependencies/p' "$WORKFLOW")"
if [[ "$title_step" != *"github.actor"* && "$title_step" != *"actor"* && "$title_step" != *"continue-on-error: true"* ]]; then
  pass "CI has no actor exemption or soft failure for title validation"
else
  fail "CI title validation contains an actor exemption or soft failure"
fi

static_runner="$(sed -n '/^run_static()/,/^run_integration()/p' "$RUNNER")"
if [[ "$static_runner" == *'bash "$EVAL_DIR/static/test_pr_title_validation.sh"'* ]]; then
  pass "static runner registers the focused title test"
else
  fail "static runner does not register the focused title test"
fi

if grep -qF '<lowercase-type>[optional-scope][!]: <non-empty subject>' "$CONTRIBUTING" \
  && grep -qF 'fix(ci): require conventional pull request titles' "$CONTRIBUTING" \
  && grep -qF 'Humans, Release Please, and Dependabot use the same rule' "$CONTRIBUTING"; then
  pass "CONTRIBUTING documents the grammar, squash-release rationale, and automation parity"
else
  fail "CONTRIBUTING is missing the PR-title contract details"
fi

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "$passes passed"
  echo "PASS: PR title validation contract"
  exit 0
else
  echo "FAIL: $errors PR title validation check(s) failed"
  exit 1
fi
