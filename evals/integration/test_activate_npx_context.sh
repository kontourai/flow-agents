#!/usr/bin/env bash
# test_activate_npx_context.sh — Verify that activate exits 0 in an npx-like context
# where there is no kits/catalog.json at the source-root.
# Implements acceptance criteria for kontourai/flow-agents#57.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

errors=0
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

CLI="$ROOT/scripts/kit.js"
MIXED_SRC="$ROOT/evals/fixtures/flow-kit-repository/mixed-runtime-kit"

echo "=== activate npx-context Checks (Issue #57) ==="

# Simulate the npx context: an empty source-root (no kits/catalog.json present).
NPX_SIMULATED_ROOT="$TMP_DIR/simulated-npx-root"
mkdir -p "$NPX_SIMULATED_ROOT"
DEST="$TMP_DIR/dest"
mkdir -p "$DEST"

# Install a kit into the destination workspace first.
install_out="$TMP_DIR/install.out"
if flow_agents_node "$CLI" install "$MIXED_SRC" --dest "$DEST" >"$install_out" 2>&1; then
  pass "mixed-runtime-kit installs into workspace"
else
  fail "install failed (prerequisite step)"
  sed -n '1,80p' "$install_out"
fi

# --- Test 1: activate with no catalog.json at source-root exits 0 ---
# This simulates the npx context: source-root points at an npm cache dir with no kits/catalog.json.
activate_out="$TMP_DIR/activate-npx.out"
if flow_agents_node "$CLI" activate --dest "$DEST" --source-root "$NPX_SIMULATED_ROOT" >"$activate_out" 2>&1; then
  pass "activate exits 0 when source-root has no catalog.json (npx context)"
else
  fail "activate exits non-zero when source-root has no catalog.json — false failure in npx context"
  sed -n '1,120p' "$activate_out"
fi

# --- Test 2: missing catalog warning appears but not as an error ---
if node - "$activate_out" <<'NODE'
const fs = require("node:fs");
const raw = fs.readFileSync(process.argv[2], "utf8").trim();
const data = JSON.parse(raw);
// errors must be empty — missing catalog is not an error
if (Array.isArray(data.errors) && data.errors.length > 0) {
  throw new Error(`activate reported errors: ${JSON.stringify(data.errors)}`);
}
// warnings may mention catalog (but must not be errors)
const catalogWarning = Array.isArray(data.warnings) && data.warnings.some((w) => w.includes("catalog") || w.includes("Catalog"));
// It's fine either way — the key invariant is errors=[].
console.log(`warnings: ${JSON.stringify(data.warnings)}`);
console.log(`catalog mentioned in warnings: ${catalogWarning}`);
console.log("ok");
NODE
then
  pass "activate with missing catalog produces no errors (warnings only)"
else
  fail "activate diagnostic structure incorrect"
  sed -n '1,120p' "$activate_out"
fi

# --- Test 3: user-installed kits ARE activated even without catalog.json ---
if node - "$activate_out" "$DEST" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const raw = fs.readFileSync(process.argv[2], "utf8").trim();
const data = JSON.parse(raw);
const dest = process.argv[3];
// mixed-runtime-kit has a flow with id "mixed.runtime" — it should be in generated_runtime_files
const ids = new Set(data.generated_runtime_files.map((item) => item.asset_id));
if (!ids.has("mixed.runtime")) {
  throw new Error(`user-installed kit flow not activated; generated ids: ${[...ids].join(", ")}`);
}
// The generated file must exist on disk
for (const item of data.generated_runtime_files) {
  if (item.asset_class === "activation-manifest") continue;
  const generatedPath = path.join(dest, item.path);
  if (!fs.existsSync(generatedPath)) throw new Error(`generated file missing on disk: ${generatedPath}`);
}
console.log("ok");
NODE
then
  pass "user-installed kits are activated correctly even without catalog.json"
else
  fail "user-installed kit flows missing from activation output"
  sed -n '1,120p' "$activate_out"
fi

# --- Test 4: built-in kits also activate when catalog.json IS present (regression guard) ---
activate_builtin_out="$TMP_DIR/activate-builtin.out"
if flow_agents_node "$CLI" activate --dest "$DEST" --source-root "$ROOT" >"$activate_builtin_out" 2>&1; then
  pass "activate with catalog.json present still exits 0 (regression guard)"
else
  fail "activate with catalog.json present failed (regression)"
  sed -n '1,120p' "$activate_builtin_out"
fi

if node - "$activate_builtin_out" <<'NODE'
const fs = require("node:fs");
const raw = fs.readFileSync(process.argv[2], "utf8").trim();
const data = JSON.parse(raw);
if (Array.isArray(data.errors) && data.errors.length > 0) {
  throw new Error(`regression: activate with catalog.json reported errors: ${JSON.stringify(data.errors)}`);
}
// Should have builder kit flows from catalog
const ids = new Set(data.generated_runtime_files.map((item) => item.asset_id));
if (!ids.has("builder.shape") && !ids.has("builder.build")) {
  throw new Error(`built-in kit flows missing when catalog.json is present`);
}
console.log("ok");
NODE
then
  pass "built-in kit flows present when catalog.json is available (regression)"
else
  fail "built-in kit flows missing — regression introduced"
  sed -n '1,120p' "$activate_builtin_out"
fi

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "activate npx-context checks passed."
  exit 0
fi

echo "activate npx-context checks failed: $errors issue(s)."
exit 1
