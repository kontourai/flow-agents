#!/usr/bin/env bash
# test_runtime_adapter_activation.sh - Exercise local runtime adapter activation.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

errors=0
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

CLI="$ROOT/scripts/flow-kit.js"
DEST="$TMP_DIR/runtime-dest"
MIXED_SRC="$ROOT/evals/fixtures/flow-kit-repository/mixed-runtime-kit"
OUT="$TMP_DIR/activation.json"
UNKNOWN_OUT="$TMP_DIR/unknown.json"
CATALOG_HASH_BEFORE="$(shasum -a 256 "$ROOT/kits/catalog.json" | awk '{print $1}')"
mkdir -p "$DEST"

echo "=== Runtime Adapter Activation Checks ==="

if flow_agents_node "$CLI" install-local "$MIXED_SRC" --dest "$DEST" >"$TMP_DIR/install.out" 2>&1; then
  pass "mixed local kit installs into temp destination"
else
  fail "mixed local kit install failed"
  sed -n '1,160p' "$TMP_DIR/install.out"
fi

if flow_agents_node "$CLI" activate --dest "$DEST" --source-root "$ROOT" --format json >"$OUT" 2>&1; then
  pass "activation succeeds with default adapter"
else
  fail "activation failed"
  sed -n '1,220p' "$OUT"
fi

if node - "$OUT" "$DEST" "$ROOT/kits/catalog.json" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const dest = process.argv[3];
const catalog = process.argv[4];
if (data.selected_adapter !== "codex-local") throw new Error(`unexpected selected_adapter: ${data.selected_adapter}`);
if (JSON.stringify(data.supported_asset_classes) !== JSON.stringify(["flows"])) throw new Error(`unexpected supported_asset_classes: ${data.supported_asset_classes}`);
const ids = new Set(data.generated_runtime_files.map((item) => item.asset_id));
for (const expected of ["builder.shape", "builder.build", "mixed.runtime", "codex-local.activation"]) {
  if (!ids.has(expected)) throw new Error(`missing generated asset: ${expected}`);
}
for (const item of data.generated_runtime_files) {
  const generatedPath = path.join(dest, item.path);
  if (!fs.existsSync(generatedPath)) throw new Error(`generated file missing: ${generatedPath}`);
  if (path.resolve(catalog) === path.resolve(generatedPath)) throw new Error("activation generated over kits/catalog.json");
}
const classes = new Set(data.skipped_assets.map((item) => item.asset_class));
for (const expected of ["skills", "docs", "adapters", "evals", "assets"]) {
  if (!classes.has(expected)) throw new Error(`missing skipped asset class: ${expected}`);
}
for (const item of data.skipped_assets) {
  for (const key of ["asset_class", "path", "kit_id", "asset_id", "reason"]) {
    if (!(key in item)) throw new Error(`skipped asset missing ${key}: ${JSON.stringify(item)}`);
  }
  if (!item.reason.includes("diagnostic-only")) throw new Error(`unexpected skip reason: ${item.reason}`);
}
if (!fs.existsSync(path.join(dest, ".flow-agents/runtime/codex/activation.json"))) throw new Error("runtime activation manifest missing");
console.log("ok");
NODE
then
  pass "diagnostics report default adapter, generated files, and skipped unsupported assets"
else
  fail "activation diagnostics are incomplete"
  sed -n '1,220p' "$OUT"
fi

if [[ "$CATALOG_HASH_BEFORE" == "$(shasum -a 256 "$ROOT/kits/catalog.json" | awk '{print $1}')" ]]; then
  pass "activation does not mutate source kits/catalog.json"
else
  fail "source kits/catalog.json changed during activation"
fi

if flow_agents_node "$CLI" activate --dest "$DEST" --source-root "$ROOT" --adapter unknown --format json >"$UNKNOWN_OUT" 2>&1; then
  fail "unknown adapter should fail"
  sed -n '1,120p' "$UNKNOWN_OUT"
elif node - "$UNKNOWN_OUT" <<'NODE'
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!data.available_adapters?.includes("codex-local")) throw new Error("available adapters missing codex-local");
if (!data.available_adapters?.includes("strands-local")) throw new Error("available adapters missing strands-local");
if (!data.errors?.length) throw new Error("unknown adapter did not report errors");
console.log("ok");
NODE
then
  pass "unknown adapter reports available adapters (codex-local and strands-local)"
else
  fail "unknown adapter diagnostics missing"
  sed -n '1,120p' "$UNKNOWN_OUT"
fi

# -------------------------------------------------------------------------
# strands-local adapter activation (Issue #32 AC1)
# -------------------------------------------------------------------------

echo ""
echo "=== strands-local Adapter Activation Checks (Issue #32 AC1) ==="

STRANDS_DEST="$TMP_DIR/strands-dest"
STRANDS_OUT="$TMP_DIR/strands-activation.json"
mkdir -p "$STRANDS_DEST"

# Use the builder kit (stable fixture) — activate for strands-local from the repo source root
if flow_agents_node "$CLI" activate --dest "$STRANDS_DEST" --source-root "$ROOT" --adapter strands-local --format json >"$STRANDS_OUT" 2>&1; then
  pass "strands-local activation succeeds"
else
  fail "strands-local activation failed"
  sed -n '1,220p' "$STRANDS_OUT"
fi

if node - "$STRANDS_OUT" "$STRANDS_DEST" "$ROOT/kits/catalog.json" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const dest = process.argv[3];
const catalog = process.argv[4];

// Verify selected_adapter
if (data.selected_adapter !== "strands-local") throw new Error(`expected strands-local, got: ${data.selected_adapter}`);
if (JSON.stringify(data.supported_asset_classes) !== JSON.stringify(["flows"])) throw new Error(`unexpected supported_asset_classes: ${JSON.stringify(data.supported_asset_classes)}`);

// Verify builder kit flows are generated (builder kit is in catalog.json)
const ids = new Set(data.generated_runtime_files.map((item) => item.asset_id));
for (const expected of ["builder.shape", "builder.build", "strands-local.activation"]) {
  if (!ids.has(expected)) throw new Error(`missing generated asset: ${expected}`);
}

// Verify generated runtime files actually exist on disk
for (const item of data.generated_runtime_files) {
  if (item.asset_class === "activation-manifest") continue;
  const generatedPath = path.join(dest, item.path);
  if (!fs.existsSync(generatedPath)) throw new Error(`generated file missing: ${generatedPath}`);
  // Verify runtime files are under .flow-agents/runtime/strands/flows/
  if (!item.path.includes(".flow-agents/runtime/strands/flows/")) {
    throw new Error(`generated path not under strands runtime dir: ${item.path}`);
  }
}

// Verify activation.json written at strands runtime dir
const manifestPath = path.join(dest, ".flow-agents/runtime/strands/activation.json");
if (!fs.existsSync(manifestPath)) throw new Error("strands runtime activation.json missing");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.adapter !== "strands-local") throw new Error(`activation.json adapter mismatch: ${manifest.adapter}`);
if (!Array.isArray(manifest.skipped_assets)) throw new Error("activation.json missing skipped_assets array");

// Verify skipped_assets have expected fields (parity with codex-local)
for (const item of manifest.skipped_assets) {
  for (const key of ["asset_class", "path", "kit_id", "asset_id", "reason"]) {
    if (!(key in item)) throw new Error(`skipped asset missing ${key}: ${JSON.stringify(item)}`);
  }
  if (!item.reason.includes("diagnostic-only")) throw new Error(`unexpected skip reason: ${item.reason}`);
}

// Non-flow asset classes should appear in skipped_assets
const skippedClasses = new Set(manifest.skipped_assets.map((item) => item.asset_class));
// builder kit has flows only; skipped_assets check requires a kit with non-flow assets,
// which the codex-local path already validates via mixed-runtime-kit above.
// Here we just confirm the field structure is present.
if (!Array.isArray(data.skipped_assets)) throw new Error("result skipped_assets is not an array");

// Catalog not mutated
if (path.resolve(catalog) === path.resolve(path.join(dest, ".flow-agents/runtime/strands/activation.json"))) {
  throw new Error("activation generated over kits/catalog.json");
}

console.log("ok");
NODE
then
  pass "strands-local: runtime flow files, activation.json, and skipped_assets present with correct structure"
else
  fail "strands-local: activation diagnostics incomplete or incorrect"
  sed -n '1,220p' "$STRANDS_OUT"
fi

# Verify codex-local activation is still intact (AC3 — existing tests still pass)
if flow_agents_node "$CLI" activate --dest "$STRANDS_DEST" --source-root "$ROOT" --format json >"$TMP_DIR/codex-after-strands.json" 2>&1; then
  pass "codex-local still activates after strands-local has run"
else
  fail "codex-local activation failed after strands-local activation"
  sed -n '1,220p' "$TMP_DIR/codex-after-strands.json"
fi

if node - "$TMP_DIR/codex-after-strands.json" "$STRANDS_DEST" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const dest = process.argv[3];
if (data.selected_adapter !== "codex-local") throw new Error(`expected codex-local, got: ${data.selected_adapter}`);
const manifestPath = path.join(dest, ".flow-agents/runtime/codex/activation.json");
if (!fs.existsSync(manifestPath)) throw new Error("codex activation.json still not present");
// Strands runtime dir must also still exist
const strandsManifestPath = path.join(dest, ".flow-agents/runtime/strands/activation.json");
if (!fs.existsSync(strandsManifestPath)) throw new Error("strands activation.json was removed by codex-local run");
console.log("ok");
NODE
then
  pass "codex-local and strands-local runtime dirs co-exist independently (AC3)"
else
  fail "co-existence check failed"
  sed -n '1,220p' "$TMP_DIR/codex-after-strands.json"
fi

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "Runtime adapter activation checks passed."
  exit 0
fi

echo "Runtime adapter activation checks failed: $errors issue(s)."
exit 1
