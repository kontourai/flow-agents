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
if (!fs.existsSync(path.join(dest, ".agents/flow-agents/runtime/codex/activation.json"))) throw new Error("runtime activation manifest missing");
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
if (!data.errors?.length) throw new Error("unknown adapter did not report errors");
console.log("ok");
NODE
then
  pass "unknown adapter reports available adapters"
else
  fail "unknown adapter diagnostics missing"
  sed -n '1,120p' "$UNKNOWN_OUT"
fi

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "Runtime adapter activation checks passed."
  exit 0
fi

echo "Runtime adapter activation checks failed: $errors issue(s)."
exit 1
