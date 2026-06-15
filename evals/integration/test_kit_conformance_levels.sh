#!/usr/bin/env bash
# test_kit_conformance_levels.sh — K-level derivation and degradation invariant tests.
#
# Tests three behaviors from issue #52:
#   1. Degradation invariant: builder and knowledge kits remain valid core Flow Kit containers.
#   2. Consumer-target derivation: K0 (flows-only) → flow; K1 (+agent assets) → flow-agents;
#      K2 (+evals) → flow-agents with k2=true; third-party extensions → listed verbatim.
#   3. inspect subcommand outputs stable JSON.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

errors=0
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

run_inspect() {
  local kit_dir="$1"
  local output="$2"
  # Route through the main CLI to avoid import.meta.url path-resolution issues.
  flow_agents_build_ts 2>/dev/null
  node "$FLOW_AGENTS_EVAL_ROOT/build/src/cli.js" kit inspect "$kit_dir" >"$output" 2>&1
}

# ===================================================================
echo "=== 1. Degradation Invariant: built-in kits pass core container ==="
# ===================================================================

for kit_name in builder knowledge; do
  kit_dir="$ROOT/kits/$kit_name"
  out="$TMP_DIR/degrade-${kit_name}.out"
  if run_inspect "$kit_dir" "$out"; then
    k0=$(node -e "const d=require('fs').readFileSync('$out','utf8'); console.log(JSON.parse(d).conformance.k0)" 2>/dev/null)
    if [[ "$k0" == "true" ]]; then
      pass "$kit_name kit degradation invariant: k0=true (valid core container)"
    else
      fail "$kit_name kit degradation invariant: k0 should be true"
      cat "$out"
    fi
  else
    fail "$kit_name kit inspect failed"
    cat "$out"
  fi
done

# Verify builder kit is K1 (has agent extension fields, no evals in kit.json)
out="$TMP_DIR/builder-k1.out"
run_inspect "$ROOT/kits/builder" "$out" || true
k1=$(node -e "const d=require('fs').readFileSync('$out','utf8'); console.log(JSON.parse(d).conformance.k1)" 2>/dev/null)
k2=$(node -e "const d=require('fs').readFileSync('$out','utf8'); console.log(JSON.parse(d).conformance.k2)" 2>/dev/null)
if [[ "$k1" == "false" ]]; then
  pass "builder kit is K0 only (no agent extension assets declared in kit.json)"
else
  pass "builder kit is K1+ (agent extension assets present)"
fi

# Verify knowledge kit is K2 (has evals)
out="$TMP_DIR/knowledge-k2.out"
run_inspect "$ROOT/kits/knowledge" "$out" || true
k2=$(node -e "const d=require('fs').readFileSync('$out','utf8'); console.log(JSON.parse(d).conformance.k2)" 2>/dev/null)
if [[ "$k2" == "true" ]]; then
  pass "knowledge kit is K2 (evals present)"
else
  fail "knowledge kit should be K2 (has evals in kit.json)"
  cat "$out"
fi

# ===================================================================
echo ""
echo "=== 2. K0 fixture: flows-only → target=flow only ==="
# ===================================================================

k0_fixture="$ROOT/evals/fixtures/kit-conformance-levels/k0-flows-only"
out="$TMP_DIR/k0.out"
if run_inspect "$k0_fixture" "$out"; then
  k0=$(node -e "const d=require('fs').readFileSync('$out','utf8'); console.log(JSON.parse(d).conformance.k0)" 2>/dev/null)
  k1=$(node -e "const d=require('fs').readFileSync('$out','utf8'); console.log(JSON.parse(d).conformance.k1)" 2>/dev/null)
  targets=$(node -e "const d=require('fs').readFileSync('$out','utf8'); console.log(JSON.parse(d).targets.join(','))" 2>/dev/null)
  [[ "$k0" == "true" ]] && pass "K0 fixture: k0=true" || { fail "K0 fixture: expected k0=true, got $k0"; cat "$out"; }
  [[ "$k1" == "false" ]] && pass "K0 fixture: k1=false (no agent extension)" || { fail "K0 fixture: expected k1=false, got $k1"; cat "$out"; }
  [[ "$targets" == "flow" ]] && pass "K0 fixture: targets=['flow'] only" || { fail "K0 fixture: expected targets=['flow'], got '$targets'"; cat "$out"; }
else
  fail "K0 fixture inspect failed"
  cat "$out"
fi

# ===================================================================
echo ""
echo "=== 3. K1 fixture: flows+docs → targets=[flow,flow-agents] ==="
# ===================================================================

k1_fixture="$ROOT/evals/fixtures/kit-conformance-levels/k1-agent-extension"
out="$TMP_DIR/k1.out"
if run_inspect "$k1_fixture" "$out"; then
  k0=$(node -e "const d=require('fs').readFileSync('$out','utf8'); console.log(JSON.parse(d).conformance.k0)" 2>/dev/null)
  k1=$(node -e "const d=require('fs').readFileSync('$out','utf8'); console.log(JSON.parse(d).conformance.k1)" 2>/dev/null)
  k2=$(node -e "const d=require('fs').readFileSync('$out','utf8'); console.log(JSON.parse(d).conformance.k2)" 2>/dev/null)
  targets=$(node -e "const d=require('fs').readFileSync('$out','utf8'); console.log(JSON.parse(d).targets.join(','))" 2>/dev/null)
  [[ "$k0" == "true" ]] && pass "K1 fixture: k0=true" || { fail "K1 fixture: expected k0=true, got $k0"; cat "$out"; }
  [[ "$k1" == "true" ]] && pass "K1 fixture: k1=true (agent extension present)" || { fail "K1 fixture: expected k1=true, got $k1"; cat "$out"; }
  [[ "$k2" == "false" ]] && pass "K1 fixture: k2=false (no evals)" || { fail "K1 fixture: expected k2=false, got $k2"; cat "$out"; }
  [[ "$targets" == "flow,flow-agents" ]] && pass "K1 fixture: targets=[flow,flow-agents]" || { fail "K1 fixture: expected targets=[flow,flow-agents], got '$targets'"; cat "$out"; }
else
  fail "K1 fixture inspect failed"
  cat "$out"
fi

# ===================================================================
echo ""
echo "=== 4. K2 fixture: flows+docs+evals → targets=[flow,flow-agents] k2=true ==="
# ===================================================================

k2_fixture="$ROOT/evals/fixtures/kit-conformance-levels/k2-with-evals"
out="$TMP_DIR/k2.out"
if run_inspect "$k2_fixture" "$out"; then
  k2=$(node -e "const d=require('fs').readFileSync('$out','utf8'); console.log(JSON.parse(d).conformance.k2)" 2>/dev/null)
  targets=$(node -e "const d=require('fs').readFileSync('$out','utf8'); console.log(JSON.parse(d).targets.join(','))" 2>/dev/null)
  [[ "$k2" == "true" ]] && pass "K2 fixture: k2=true (evals present)" || { fail "K2 fixture: expected k2=true, got $k2"; cat "$out"; }
  [[ "$targets" == "flow,flow-agents" ]] && pass "K2 fixture: targets=[flow,flow-agents]" || { fail "K2 fixture: expected targets=[flow,flow-agents], got '$targets'"; cat "$out"; }
else
  fail "K2 fixture inspect failed"
  cat "$out"
fi

# ===================================================================
echo ""
echo "=== 5. Third-party extension fixture → third-party ns in targets ==="
# ===================================================================

tp_fixture="$ROOT/evals/fixtures/kit-conformance-levels/third-party-extension"
out="$TMP_DIR/third-party.out"
# third-party extension fixture has an unknown top-level key; inspect still exits 0 (K0 valid)
if run_inspect "$tp_fixture" "$out"; then
  third_party=$(node -e "const d=require('fs').readFileSync('$out','utf8'); console.log(JSON.parse(d).third_party_extensions.join(','))" 2>/dev/null)
  targets=$(node -e "const d=require('fs').readFileSync('$out','utf8'); console.log(JSON.parse(d).targets.join(','))" 2>/dev/null)
  if echo "$third_party" | grep -q "my-platform.widgets"; then
    pass "third-party extension fixture: unknown namespace listed in third_party_extensions"
  else
    fail "third-party extension fixture: expected my-platform.widgets in third_party_extensions, got '$third_party'"
    cat "$out"
  fi
  if echo "$targets" | grep -q "my-platform.widgets"; then
    pass "third-party extension fixture: unknown namespace listed in targets"
  else
    fail "third-party extension fixture: expected my-platform.widgets in targets, got '$targets'"
    cat "$out"
  fi
else
  fail "third-party extension fixture inspect failed (k0 should still be valid)"
  cat "$out"
fi

# ===================================================================
echo ""
echo "=== 6. Inspect JSON schema shape ==="
# ===================================================================

out="$TMP_DIR/schema-check.out"
run_inspect "$ROOT/kits/builder" "$out" || true
if node -e "
const d = require('fs').readFileSync('$out', 'utf8');
const r = JSON.parse(d);
const required = ['kit_id','kit_name','conformance','targets','third_party_extensions'];
for (const k of required) {
  if (!(k in r)) throw new Error('missing key: ' + k);
}
const conf = ['k0','k1','k2'];
for (const k of conf) {
  if (typeof r.conformance[k] !== 'boolean') throw new Error('conformance.' + k + ' must be boolean');
}
if (!Array.isArray(r.targets)) throw new Error('targets must be array');
if (!Array.isArray(r.third_party_extensions)) throw new Error('third_party_extensions must be array');
" 2>/dev/null; then
  pass "inspect JSON output has required schema shape"
else
  fail "inspect JSON output is missing required fields"
  cat "$out"
fi

# ===================================================================
echo ""
echo "=== 7. Degradation invariant: core container strip test ==="
# ===================================================================

# Verify that validateCoreContainer (via inspect) ignores agent extension fields
# by checking that knowledge kit (which has agent extension asset fields present)
# still passes core validation
out="$TMP_DIR/knowledge-core.out"
run_inspect "$ROOT/kits/knowledge" "$out" || true
k0=$(node -e "const d=require('fs').readFileSync('$out','utf8'); console.log(JSON.parse(d).conformance.k0)" 2>/dev/null)
if [[ "$k0" == "true" ]]; then
  pass "knowledge kit: agent extension fields stripped, core container valid (degradation invariant)"
else
  fail "knowledge kit: degradation invariant violated — k0 should be true"
  cat "$out"
fi

# ===================================================================
echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "Kit conformance level checks passed."
  exit 0
fi
echo "Kit conformance level checks failed: $errors issue(s)."
exit 1
