#!/usr/bin/env bash
# test_canonical_command_laundering.sh — the canonical verify command must not be
# exit-code-masked (flow-agents#1088).
#
# Step 1 of trust-reconcile re-runs the canonical verify command and treats its exit
# code as authoritative CI truth. If that command's exit code can be masked, the
# anchor attests a PASS it never observed.
#
# `hasLaunderingOperator` (ADR 0018, frozen) catches `||`, `| true`, `; true`, `; :`,
# `; exit 0`, `; /bin/true`. It does NOT catch a pipe into any other command that
# exits 0 on its own — `| tail`, `| head`, `| tee`. A pipeline reports the RIGHT-most
# command's exit code, so `npm test | tail` exits 0 whenever `tail` succeeds.
#
# That is not a hypothetical shape. It is the shape recorded repeatedly as a real
# operator incident in this workspace: `git push ... | tail -1 && echo PUSHED`
# reporting success for a failed push, and `npm run verify:static | tail` reporting
# green for a red gate.
#
# ADR 0018 directs new laundering shapes to the external CI anchor rather than to the
# frozen local rule set. `hasUnattributablePipeline` in scripts/ci/trust-reconcile.js
# is that anchor, scoped to CANONICAL commands only (repo-controlled config, never
# agent claim text) so it cannot over-block an agent's own commands.
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

# reject_case <label> <canonical-command> <needle>
# Asserts the reconciler refuses to run at all with the given canonical command.
reject_case() {
  local label="$1" cmd="$2" needle="$3"
  echo "=== $label ==="
  local out code
  out="$(TRUST_RECONCILE_COMMANDS="$cmd" node "$RECONCILE" --repo-root "$ROOT" 2>&1)"
  code=$?
  if [[ $code -ne 0 ]]; then
    _pass "$label: reconciler exits non-zero ($code)"
  else
    _fail "$label: expected non-zero exit, got 0 — a masked canonical command was accepted. Output: $out"
  fi
  if echo "$out" | grep -qF "$needle"; then
    _pass "$label: emitted the expected refusal (\"$needle\")"
  else
    _fail "$label: expected \"$needle\" not found — output: $out"
  fi
}

# accept_case <label> <canonical-command>
# Asserts the reconciler does NOT refuse on laundering grounds. It may still exit
# non-zero for unrelated reasons (no bundle present); we assert only that neither
# laundering refusal fired — this is the false-positive guard.
accept_case() {
  local label="$1" cmd="$2"
  echo "=== $label ==="
  local out
  out="$(TRUST_RECONCILE_COMMANDS="$cmd" node "$RECONCILE" --repo-root "$ROOT" 2>&1)"
  if echo "$out" | grep -qE "command is laundered|pipes into another command"; then
    _fail "$label: legitimate canonical command was rejected as laundered — output: $out"
  else
    _pass "$label: not rejected as laundered"
  fi
}

echo "## Pipe-into-exit-0 masking (flow-agents#1088) — the real-incident shapes"
reject_case "pipe-tail"  "npm test | tail"          "pipes into another command"
reject_case "pipe-tail-n" "npm test | tail -20"     "pipes into another command"
reject_case "pipe-head"  "npm test | head -5"       "pipes into another command"
reject_case "pipe-tee"   "npm test | tee out.log"   "pipes into another command"

echo
echo "## Regression guard: the six frozen shapes must still be refused"
reject_case "or-true"    "npm test || true"         "is laundered"
reject_case "semi-exit0" "npm test ; exit 0"        "is laundered"
reject_case "pipe-true"  "npm test | true"          "is laundered"

echo
echo "## False-positive guard: legitimate canonical commands must NOT be refused"
accept_case "plain"        "npm test"
accept_case "and-chain"    "npm run build && npm test"
accept_case "quoted-alt"   "grep -E 'a|b' package.json"

echo
if [[ $errors -eq 0 ]]; then
  echo "test_canonical_command_laundering: all checks passed."
  exit 0
fi
echo "test_canonical_command_laundering: $errors check(s) failed."
exit 1
