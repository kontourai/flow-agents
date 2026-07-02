#!/usr/bin/env bash
# test_veritas_governance_kit.sh — Veritas Governance Kit slice 1 gate demo (agentless).
#
# Proves the kit's readiness-check flow gates a REAL `veritas readiness` verdict, projected
# into a Hachure trust.bundle by the kit adapter (kits/veritas-governance/adapter/
# readiness-to-trust-bundle.mjs):
#   POSITIVE: a ready readiness report -> verified software-readiness-verdict claim ->
#             flow evaluate exits 0 (gate passes).
#   NEGATIVE: a not-ready readiness report (injected Repo Standards violation) -> disputed
#             claim -> flow evaluate --exit-code exits 1 (gate BLOCKS, not silently passed).
#
# The two committed fixtures under kits/veritas-governance/fixtures/readiness/ are REAL,
# captured `veritas readiness --check evidence --working-tree` evidence reports (ready = a
# clean checkout of kontourai/veritas; not-ready = the same tree with a required CLI artifact
# deleted, a Require-enforcement violation). When a Veritas binary is resolvable (VERITAS_BIN,
# or `veritas` on PATH) AND VERITAS_GOVERNED_REPO points at a Veritas-governed repo, the eval
# ALSO runs Veritas live and re-derives both paths; otherwise it prints SKIP for the live leg
# and relies on the captured real-output fixtures (deterministic in CI).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

errors=0
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

KIT="$ROOT/kits/veritas-governance"
ADAPTER="$KIT/adapter/readiness-to-trust-bundle.mjs"
FLOWDEF="$KIT/flows/readiness-check.flow.json"
FLOW_CLI="$ROOT/node_modules/@kontourai/flow/dist/cli.js"

echo "=== Veritas Governance Kit — slice 1 gate demo ==="

# --- Kit container is K0-valid --------------------------------------------------
if node "$FLOW_CLI" kit validate "$KIT" >"$TMP_DIR/kitval.out" 2>&1; then
  pass "kit container validates (flow kit validate)"
else
  fail "kit container failed validation"; sed -n '1,40p' "$TMP_DIR/kitval.out"
fi

# --- No-fork: kit does not vendor/reimplement Veritas rule/claim evaluation ------
# Scope to kit SOURCE (adapter + flows), not fixtures/ — the fixtures are real Veritas
# OUTPUT and legitimately embed Veritas rule ids and check labels.
if rg -q -i 'evaluateRepoStandards|evidence-check-runner\.mjs|class +[A-Za-z]*RuleEngine|repo-standards/default\.repo-standards\.json' "$KIT/adapter" "$KIT/flows" 2>/dev/null; then
  fail "kit source appears to vendor/reimplement Veritas evaluation logic (no-fork violated)"
else
  pass "no-fork: kit source references Veritas recorded output only (no vendored rule/claim engine)"
fi

# --- Gate one readiness fixture; assert the expected evaluate exit code ----------
# $1 fixture path, $2 label, $3 expected exit (0=pass, 1=block)
gate_case() {
  local fixture="$1" label="$2" expect="$3"
  local work="$TMP_DIR/$label"; mkdir -p "$work"; ( cd "$work" && node "$FLOW_CLI" init >/dev/null 2>&1 )
  local bundle="$work/readiness.bundle"
  if ! node "$ADAPTER" --report "$fixture" --out "$bundle" >"$work/adapter.out" 2>&1; then
    fail "[$label] adapter failed to project readiness report"; sed -n '1,20p' "$work/adapter.out"; return
  fi
  ( cd "$work" && node "$FLOW_CLI" start "$FLOWDEF" --run-id "$label" >/dev/null 2>&1 )
  ( cd "$work" && node "$FLOW_CLI" attach-evidence "$label" --gate gate-check-gate --file "$bundle" --bundle >"$work/attach.out" 2>&1 )
  if ! rg -q 'kind: trust.bundle' "$work/attach.out"; then
    fail "[$label] evidence did not attach as kind: trust.bundle"; sed -n '1,20p' "$work/attach.out"; return
  fi
  ( cd "$work" && node "$FLOW_CLI" evaluate "$label" --gate gate-check-gate --exit-code >"$work/eval.out" 2>&1 )
  local got=$?
  if [[ "$got" == "$expect" ]]; then
    pass "[$label] gate evaluate exit $got as expected ($(rg -o '^(pass|block|route-back) gate-check-gate.*' "$work/eval.out" | head -1))"
  else
    fail "[$label] gate evaluate exit $got, expected $expect"; sed -n '1,20p' "$work/eval.out"
  fi
}

echo "--- captured real-veritas-output fixtures ---"
gate_case "$KIT/fixtures/readiness/ready.readiness-report.json"     "positive" 0
gate_case "$KIT/fixtures/readiness/not-ready.readiness-report.json" "negative" 1

# --- Optional live Veritas leg --------------------------------------------------
VBIN="${VERITAS_BIN:-veritas}"
if command -v "$VBIN" >/dev/null 2>&1 && [[ -n "${VERITAS_GOVERNED_REPO:-}" && -d "${VERITAS_GOVERNED_REPO:-}/.veritas" ]]; then
  echo "--- live Veritas leg (VERITAS_GOVERNED_REPO=$VERITAS_GOVERNED_REPO) ---"
  live="$TMP_DIR/live"; mkdir -p "$live"
  rsync -a --exclude .git --exclude node_modules --exclude .kontourai "$VERITAS_GOVERNED_REPO/" "$live/repo/" >/dev/null 2>&1
  ln -s "$VERITAS_GOVERNED_REPO/node_modules" "$live/repo/node_modules" 2>/dev/null || true
  # `veritas readiness --working-tree` diffs against git; the copy needs its own git repo.
  ( cd "$live/repo" && git init -q && git add -A && git -c user.email=eval@local -c user.name=eval commit -qm baseline ) >/dev/null 2>&1
  # live-positive: clean tree
  ( cd "$live/repo" && "$VBIN" readiness --check evidence --working-tree >/dev/null 2>&1 )
  live_rep="$(ls -t "$live/repo/.kontourai/veritas/evidence/"*.json 2>/dev/null | head -1)"
  if [[ -n "$live_rep" ]]; then
    gate_case "$live_rep" "live-positive" 0
  else
    fail "live Veritas clean run produced no evidence report"
  fi
  # live-negative: inject a Require-enforcement violation (delete a required CLI artifact)
  rm -f "$live/repo/bin/veritas-report.mjs"
  ( cd "$live/repo" && "$VBIN" readiness --check evidence --working-tree >/dev/null 2>&1 )
  live_neg="$(ls -t "$live/repo/.kontourai/veritas/evidence/"*.json 2>/dev/null | head -1)"
  if [[ -n "$live_neg" && "$live_neg" != "$live_rep" ]]; then
    gate_case "$live_neg" "live-negative" 1
  else
    fail "live Veritas injected-violation run produced no fresh evidence report"
  fi
else
  echo "  - SKIP live Veritas leg (set VERITAS_BIN + VERITAS_GOVERNED_REPO to enable); fixtures are captured real output"
fi

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "PASS: veritas-governance kit gate demo (positive passes, negative blocks)"
  exit 0
else
  echo "FAIL: $errors check(s) failed"
  exit 1
fi
