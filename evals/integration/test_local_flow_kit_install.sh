#!/usr/bin/env bash
# test_local_flow_kit_install.sh — Exercise local Flow Kit install/list/status behavior.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

errors=0
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

CLI="$ROOT/scripts/kit.js"
VALID_SRC="$ROOT/evals/fixtures/flow-kit-repository/valid-local-kit"
INVALID_SRC="$ROOT/evals/fixtures/flow-kit-repository/invalid-missing-flow"
DEST="$TMP_DIR/install-dest"
REGISTRY="$DEST/kits/local/installed-kits.json"
CATALOG_HASH_BEFORE="$(shasum -a 256 "$ROOT/kits/catalog.json" | awk '{print $1}')"
mkdir -p "$DEST"

echo "=== Local Flow Kit Install Checks ==="

install_output="$TMP_DIR/install.out"
if flow_agents_node "$CLI" install "$VALID_SRC" --dest "$DEST" >"$install_output" 2>&1; then
  pass "valid local kit installs into temp destination"
else
  fail "valid local kit install failed"
  sed -n '1,160p' "$install_output"
fi

if node - "$REGISTRY" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const registry = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const entry = registry.kits[0];
for (const key of ["id", "source", "hash", "installed_at", "installed_path", "state"]) {
  if (!(key in entry)) throw new Error(`missing metadata key: ${key}`);
}
if (entry.id !== "example-kit") throw new Error(`unexpected id: ${entry.id}`);
if (!entry.hash.startsWith("sha256:")) throw new Error("hash should include sha256 prefix");
if (Number.isNaN(Date.parse(entry.installed_at))) throw new Error("installed_at should be ISO parseable");
if (!fs.existsSync(path.join(entry.installed_path, "kit.json"))) throw new Error("installed kit copy missing kit.json");
console.log("ok");
NODE
then
  pass "install records required provenance metadata"
else
  fail "install metadata is incomplete"
fi

registry_hash_before_invalid="$(shasum -a 256 "$REGISTRY" | awk '{print $1}')"
invalid_output="$TMP_DIR/invalid.out"
if flow_agents_node "$CLI" install "$INVALID_SRC" --dest "$DEST" >"$invalid_output" 2>&1; then
  fail "invalid local kit install should fail"
  sed -n '1,160p' "$invalid_output"
elif rg -q 'Flow Kit repository validation failed' "$invalid_output" \
  && [[ "$registry_hash_before_invalid" == "$(shasum -a 256 "$REGISTRY" | awk '{print $1}')" ]]; then
  pass "invalid kit fails validation before registry mutation"
else
  fail "invalid kit failure did not preserve registry or diagnostic"
  sed -n '1,160p' "$invalid_output"
fi

registry_hash_before_idempotent="$(shasum -a 256 "$REGISTRY" | awk '{print $1}')"
idempotent_output="$TMP_DIR/idempotent.out"
if flow_agents_node "$CLI" install "$VALID_SRC" --dest "$DEST" >"$idempotent_output" 2>&1 \
  && rg -q "already installed" "$idempotent_output" \
  && [[ "$registry_hash_before_idempotent" == "$(shasum -a 256 "$REGISTRY" | awk '{print $1}')" ]]; then
  pass "same-source reinstall is idempotent"
else
  fail "same-source reinstall was not idempotent"
  sed -n '1,160p' "$idempotent_output"
fi

CONFLICT_SRC="$TMP_DIR/conflict-source"
cp -R "$VALID_SRC" "$CONFLICT_SRC"
printf '\nconflict copy\n' >> "$CONFLICT_SRC/docs/README.md"
conflict_output="$TMP_DIR/conflict.out"
registry_hash_before_conflict="$(shasum -a 256 "$REGISTRY" | awk '{print $1}')"
if flow_agents_node "$CLI" install "$CONFLICT_SRC" --dest "$DEST" >"$conflict_output" 2>&1; then
  fail "different source with existing kit id should conflict"
  sed -n '1,160p' "$conflict_output"
elif rg -q 'conflict: kit' "$conflict_output" \
  && [[ "$registry_hash_before_conflict" == "$(shasum -a 256 "$REGISTRY" | awk '{print $1}')" ]]; then
  pass "different-source duplicate id conflicts without mutation"
else
  fail "duplicate id conflict did not preserve registry or diagnostic"
  sed -n '1,160p' "$conflict_output"
fi

force_conflict_output="$TMP_DIR/force-conflict.out"
if flow_agents_node "$CLI" install "$CONFLICT_SRC" --dest "$DEST" --force >"$force_conflict_output" 2>&1; then
  fail "--force should not replace a different-source duplicate id"
  sed -n '1,160p' "$force_conflict_output"
elif rg -q 'conflict: kit' "$force_conflict_output" \
  && [[ "$registry_hash_before_conflict" == "$(shasum -a 256 "$REGISTRY" | awk '{print $1}')" ]]; then
  pass "--force preserves different-source duplicate id conflict"
else
  fail "--force duplicate id conflict did not preserve registry or diagnostic"
  sed -n '1,160p' "$force_conflict_output"
fi

update_output="$TMP_DIR/update.out"
if flow_agents_node "$CLI" install "$CONFLICT_SRC" --dest "$DEST" --update >"$update_output" 2>&1 \
  && rg -q "updated local kit" "$update_output" \
  && rg -q "$CONFLICT_SRC" "$REGISTRY"; then
  pass "explicit update replaces duplicate id source"
else
  fail "explicit update did not replace duplicate id source"
  sed -n '1,160p' "$update_output"
fi

list_output="$TMP_DIR/list.out"
status_output="$TMP_DIR/status.out"
if flow_agents_node "$CLI" list --dest "$DEST" >"$list_output" 2>&1 \
  && flow_agents_node "$CLI" status --dest "$DEST" example-kit >"$status_output" 2>&1 \
  && rg -q 'example-kit' "$list_output" \
  && rg -q 'source=' "$list_output" \
  && rg -q 'installed_at=' "$list_output" \
  && rg -q '"id": "example-kit"' "$status_output" \
  && rg -q '"state": "installed"' "$status_output"; then
  pass "list and status expose installed kit provenance without mutation"
else
  fail "list/status output missing expected provenance"
  sed -n '1,160p' "$list_output"
  sed -n '1,160p' "$status_output"
fi

# Cross-kit dependency: install-time non-blocking warning (AC1).
# valid-with-dependency declares a dependency on a kit that is never installed.
DEP_SRC="$ROOT/evals/fixtures/flow-kit-repository/valid-with-dependency"
DEP_DEST="$TMP_DIR/dep-dest"
mkdir -p "$DEP_DEST"
dep_output="$TMP_DIR/dep-install.out"
if flow_agents_node "$CLI" install "$DEP_SRC" --dest "$DEP_DEST" >"$dep_output" 2>&1 \
  && rg -q "declares a dependency on 'nonexistent-dep-kit'" "$dep_output" \
  && rg -q "not installed" "$dep_output"; then
  pass "kit with a missing declared dependency installs (exit 0) with a non-blocking warning"
else
  fail "missing-dependency install did not warn or exited non-zero"
  sed -n '1,160p' "$dep_output"
fi

CATALOG_HASH_AFTER="$(shasum -a 256 "$ROOT/kits/catalog.json" | awk '{print $1}')"
if [[ "$CATALOG_HASH_BEFORE" == "$CATALOG_HASH_AFTER" ]]; then
  pass "local installs do not mutate source kits/catalog.json"
else
  fail "source kits/catalog.json changed during local install test"
fi

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "Local Flow Kit install checks passed."
  exit 0
fi

echo "Local Flow Kit install checks failed: $errors issue(s)."
exit 1
