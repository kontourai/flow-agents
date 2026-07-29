#!/usr/bin/env bash
# test_canonical_command_laundering.sh — a pipeline can never hide a failure from the
# CI anchor (flow-agents#1088).
#
# Step 1 of trust-reconcile re-runs the canonical verify command and treats its exit
# code as authoritative CI truth. A pipeline reports its RIGHT-most command's status,
# so `npm test | tail` exits 0 whenever `tail` succeeds — the anchor would attest a
# PASS it never observed. That is the shape behind this workspace's repeated real
# incidents (`git push ... | tail -1 && echo PUSHED`, `npm run verify:static | tail`).
#
# The fix is structural, not another evasion pattern: every command whose exit code
# the anchor attests runs under `set -o pipefail; export SHELLOPTS;`. An earlier
# revision of this change tried pattern-matching the command string and was defeated
# in one token by `bash -c "false | tail"` — the pipe lives inside a quoted argument
# the outer shell never parses as a pipeline, so no amount of regex sees it. ADR 0018
# calls pattern lists a losing race; this suite exists partly to keep that lesson.
#
# Note the behaviour these assert: a laundered pipeline is NOT refused up front, it
# RUNS and FAILS honestly. A legitimate `| tail` for log trimming keeps working — it
# just can no longer hide a failure. `||` masking is different (it genuinely discards
# the status rather than misreporting it) and remains refused by the frozen
# hasLaunderingOperator heuristic.
#
# Deterministic, no model spend, no fixtures required.
# Usage: bash evals/integration/test_canonical_command_laundering.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"
RECONCILE="$ROOT/scripts/ci/trust-reconcile.js"

errors=0
_pass() { echo "  PASS: $1"; }
_fail() { echo "  FAIL: $1"; errors=$((errors + 1)); }

# blocks_case <label> <canonical-command>
# The command's left side genuinely fails. Assert the anchor reports FAIL for it —
# i.e. the pipeline did not hide the failure.
blocks_case() {
  local label="$1" cmd="$2"
  echo "=== $label ==="
  local out
  out="$(TRUST_RECONCILE_COMMANDS="$cmd" node "$RECONCILE" --repo-root "$ROOT" 2>&1)"
  if echo "$out" | grep -qF "FAIL: $cmd"; then
    _pass "$label: failure surfaced through the pipeline"
  else
    _fail "$label: a failing command reported PASS through a pipe — exit code was masked. Output: $out"
  fi
}

# refused_case <label> <canonical-command> <needle>
# `||`-style masking discards the status entirely; assert it is still refused up front.
refused_case() {
  local label="$1" cmd="$2" needle="$3"
  echo "=== $label ==="
  local out code
  out="$(TRUST_RECONCILE_COMMANDS="$cmd" node "$RECONCILE" --repo-root "$ROOT" 2>&1)"
  code=$?
  if [[ $code -ne 0 ]] && echo "$out" | grep -qF "$needle"; then
    _pass "$label: refused up front (\"$needle\")"
  else
    _fail "$label: expected refusal \"$needle\", got exit $code — output: $out"
  fi
}

# honest_case <label> <canonical-command>
# A genuinely passing command, piped or not, must still report PASS.
honest_case() {
  local label="$1" cmd="$2"
  echo "=== $label ==="
  local out
  out="$(TRUST_RECONCILE_COMMANDS="$cmd" node "$RECONCILE" --repo-root "$ROOT" 2>&1)"
  if echo "$out" | grep -qF "PASS: $cmd"; then
    _pass "$label: honest success still reported as PASS"
  else
    _fail "$label: a passing command was not reported as PASS — over-block. Output: $out"
  fi
}

echo "## A pipeline cannot hide a failure — the real-incident shapes"
blocks_case "pipe-tail"        'false | tail'
blocks_case "pipe-tail-n"      'false | tail -20'
blocks_case "pipe-head"        'false | head -5'
blocks_case "pipe-multi"       'false | cat | tail'

echo
echo "## ...including when the pipe hides inside a nested shell"
# Regression guard for the review BLOCKER: quote-stripping regexes cannot see this,
# which is why the fix is pipefail rather than pattern-matching.
blocks_case "nested-bash-c"    'bash -c "false | tail"'
blocks_case "nested-sh-c"      'sh -c "false | tail"'

echo
echo "## || masking discards the status entirely and is still refused up front"
refused_case "or-true"    'false || true'      "is laundered"
refused_case "semi-exit0" 'false ; exit 0'     "is laundered"
refused_case "pipe-true"  'false | true'       "is laundered"

echo
echo "## Honest commands must still pass — no over-block"
honest_case "plain-pass"   'true'
honest_case "piped-pass"   'true | tail'
honest_case "and-chain"    'true && true'

echo
if [[ $errors -eq 0 ]]; then
  echo "test_canonical_command_laundering: all checks passed."
  exit 0
fi
echo "test_canonical_command_laundering: $errors check(s) failed."
exit 1
