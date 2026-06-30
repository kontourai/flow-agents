#!/usr/bin/env bash
# test_flow_kit_install_git.sh — Exercise flow-kit install-git with a file:// git URL fixture.
# No network required: the fixture is a bare git repo created from the existing valid-local-kit.
# Implements acceptance criteria for kontourai/flow-agents#56.
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
DEST="$TMP_DIR/install-dest"
mkdir -p "$DEST"

echo "=== install-git Checks (Issue #56) ==="

# --- Fixture setup: create a bare git repo from the valid-local-kit fixture ---
FIXTURE_REPO="$TMP_DIR/fixture-bare-repo"
FIXTURE_WORKING="$TMP_DIR/fixture-working"
cp -R "$VALID_SRC" "$FIXTURE_WORKING"
(cd "$FIXTURE_WORKING" && git init -q && git config user.email "test@test.local" && git config user.name "test" && git add -A && git commit -q -m "init")
git clone -q --bare "$FIXTURE_WORKING" "$FIXTURE_REPO"
FILE_URL="file://$FIXTURE_REPO"

echo "  (fixture repo: $FILE_URL)"

# --- Test 0: default destination honors CODEX_HOME and --dest overrides it ---
DEFAULT_CODEX_HOME="$TMP_DIR/default-codex-home"
OVERRIDE_DEST="$TMP_DIR/override-dest"
mkdir -p "$DEFAULT_CODEX_HOME" "$OVERRIDE_DEST"

default_out="$TMP_DIR/default-dest.out"
if CODEX_HOME="$DEFAULT_CODEX_HOME" flow_agents_node "$CLI" install "$VALID_SRC" >"$default_out" 2>&1 \
  && [[ -f "$DEFAULT_CODEX_HOME/kits/local/installed-kits.json" ]] \
  && [[ -d "$DEFAULT_CODEX_HOME/kits/local/repositories/example-kit" ]]; then
  pass "kit install without --dest defaults to CODEX_HOME"
else
  fail "kit install without --dest did not default to CODEX_HOME"
  sed -n '1,80p' "$default_out"
fi

list_out="$TMP_DIR/default-list.out"
if CODEX_HOME="$DEFAULT_CODEX_HOME" flow_agents_node "$CLI" list >"$list_out" 2>&1 \
  && grep -q "example-kit" "$list_out"; then
  pass "kit list without --dest reads CODEX_HOME"
else
  fail "kit list without --dest did not read CODEX_HOME"
  sed -n '1,80p' "$list_out"
fi

status_out="$TMP_DIR/default-status.out"
if CODEX_HOME="$DEFAULT_CODEX_HOME" flow_agents_node "$CLI" status example-kit >"$status_out" 2>&1 \
  && grep -q '"id": "example-kit"' "$status_out"; then
  pass "kit status without --dest reads CODEX_HOME"
else
  fail "kit status without --dest did not read CODEX_HOME"
  sed -n '1,80p' "$status_out"
fi

activate_out="$TMP_DIR/default-activate.out"
if CODEX_HOME="$DEFAULT_CODEX_HOME" flow_agents_node "$CLI" activate --source-root "$ROOT" >"$activate_out" 2>&1 \
  && [[ -f "$DEFAULT_CODEX_HOME/.kontourai/flow-agents/projections/codex/activation.json" ]]; then
  pass "kit activate without --dest writes CODEX_HOME"
else
  fail "kit activate without --dest did not write CODEX_HOME"
  sed -n '1,80p' "$activate_out"
fi

override_out="$TMP_DIR/override-dest.out"
if CODEX_HOME="$DEFAULT_CODEX_HOME" flow_agents_node "$CLI" install "$VALID_SRC" --dest "$OVERRIDE_DEST" >"$override_out" 2>&1 \
  && [[ -f "$OVERRIDE_DEST/kits/local/installed-kits.json" ]] \
  && [[ -d "$OVERRIDE_DEST/kits/local/repositories/example-kit" ]]; then
  pass "kit install --dest overrides CODEX_HOME"
else
  fail "kit install --dest did not override CODEX_HOME"
  sed -n '1,80p' "$override_out"
fi

# --- Test 1: basic install-git from file:// URL ---
install_out="$TMP_DIR/install-git.out"
if flow_agents_node "$CLI" install "$FILE_URL" --dest "$DEST" >"$install_out" 2>&1; then
  pass "install-git from file:// URL succeeds"
else
  fail "install-git from file:// URL failed"
  sed -n '1,80p' "$install_out"
fi

REGISTRY="$DEST/kits/local/installed-kits.json"
if [[ -f "$REGISTRY" ]]; then
  pass "install-git writes registry file"
else
  fail "install-git did not write registry file"
fi

if node - "$REGISTRY" "$FILE_URL" <<'NODE'
const fs = require("node:fs");
const registry = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const entry = registry.kits[0];
if (!entry) throw new Error("no kits in registry");
for (const key of ["id", "source", "hash", "installed_at", "installed_path", "state"]) {
  if (!(key in entry)) throw new Error(`missing metadata key: ${key}`);
}
if (entry.id !== "example-kit") throw new Error(`unexpected id: ${entry.id}`);
if (!entry.hash.startsWith("sha256:")) throw new Error("hash should include sha256 prefix");
if (Number.isNaN(Date.parse(entry.installed_at))) throw new Error("installed_at should be ISO parseable");
if (!fs.existsSync(entry.installed_path + "/kit.json")) throw new Error("installed kit copy missing kit.json");
const expectedSource = process.argv[3];
if (!entry.source.startsWith(expectedSource.replace(/\/$/, ""))) throw new Error(`source mismatch: ${entry.source}`);
console.log("ok");
NODE
then
  pass "install-git records correct provenance metadata"
else
  fail "install-git metadata is incomplete"
fi

# --- Test 2: idempotent re-install from same URL ---
idempotent_out="$TMP_DIR/idempotent.out"
registry_hash_before="$(shasum -a 256 "$REGISTRY" | awk '{print $1}')"
if flow_agents_node "$CLI" install "$FILE_URL" --dest "$DEST" >"$idempotent_out" 2>&1 \
  && grep -q "already installed" "$idempotent_out" \
  && [[ "$registry_hash_before" == "$(shasum -a 256 "$REGISTRY" | awk '{print $1}')" ]]; then
  pass "install-git same-URL reinstall is idempotent"
else
  fail "install-git same-URL reinstall was not idempotent"
  sed -n '1,80p' "$idempotent_out"
fi

# --- Test 3: #ref fragment syntax ---
ref_out="$TMP_DIR/ref.out"
DEST2="$TMP_DIR/dest-with-ref"
mkdir -p "$DEST2"
# Re-create fixture repo with a tagged commit so we can test #ref
FIXTURE_WORKING2="$TMP_DIR/fixture-working2"
FIXTURE_REPO2="$TMP_DIR/fixture-bare-repo2"
cp -R "$VALID_SRC" "$FIXTURE_WORKING2"
(cd "$FIXTURE_WORKING2" && git init -q && git config user.email "test@test.local" && git config user.name "test" && git add -A && git commit -q -m "init" && git tag v1.0)
git clone -q --bare "$FIXTURE_WORKING2" "$FIXTURE_REPO2"
FILE_URL2="file://$FIXTURE_REPO2"

if flow_agents_node "$CLI" install "${FILE_URL2}#v1.0" --dest "$DEST2" >"$ref_out" 2>&1; then
  pass "install-git with #ref fragment succeeds"
else
  fail "install-git with #ref fragment failed"
  sed -n '1,80p' "$ref_out"
fi

if node - "$DEST2/kits/local/installed-kits.json" "${FILE_URL2}#v1.0" <<'NODE'
const fs = require("node:fs");
const registry = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const entry = registry.kits.find((e) => e.id === "example-kit");
if (!entry) throw new Error("kit not found in registry");
const expectedSource = process.argv[3];
if (entry.source !== expectedSource) throw new Error(`source mismatch: expected ${expectedSource}, got ${entry.source}`);
console.log("ok");
NODE
then
  pass "install-git #ref stored in source metadata"
else
  fail "install-git #ref not stored correctly in source metadata"
fi

# --- Test 4: --ref flag syntax ---
ref_flag_out="$TMP_DIR/ref-flag.out"
DEST3="$TMP_DIR/dest-with-ref-flag"
mkdir -p "$DEST3"
if flow_agents_node "$CLI" install "$FILE_URL2" --ref v1.0 --dest "$DEST3" >"$ref_flag_out" 2>&1; then
  pass "install-git with --ref flag succeeds"
else
  fail "install-git with --ref flag failed"
  sed -n '1,80p' "$ref_flag_out"
fi

# --- Test 5: missing git URL exits non-zero ---
missing_url_out="$TMP_DIR/missing-url.out"
if flow_agents_node "$CLI" install --dest "$DEST" >"$missing_url_out" 2>&1; then
  fail "install-git with no URL should exit non-zero"
  sed -n '1,40p' "$missing_url_out"
else
  pass "install-git with no URL exits non-zero with usage message"
fi

# --- Test 6: invalid git URL exits non-zero ---
invalid_url_out="$TMP_DIR/invalid-url.out"
if flow_agents_node "$CLI" install "file:///nonexistent-repo-that-does-not-exist" --dest "$DEST" >"$invalid_url_out" 2>&1; then
  fail "install-git with invalid URL should exit non-zero"
  sed -n '1,40p' "$invalid_url_out"
else
  pass "install-git with invalid URL exits non-zero"
fi

# --- Test 7: catalog.json not mutated ---
CATALOG_HASH_BEFORE="$(shasum -a 256 "$ROOT/kits/catalog.json" | awk '{print $1}')"
# (all operations above have already run)
if [[ "$CATALOG_HASH_BEFORE" == "$(shasum -a 256 "$ROOT/kits/catalog.json" | awk '{print $1}')" ]]; then
  pass "install-git does not mutate source kits/catalog.json"
else
  fail "source kits/catalog.json changed during install-git test"
fi

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "install-git checks passed."
  exit 0
fi

echo "install-git checks failed: $errors issue(s)."
exit 1
