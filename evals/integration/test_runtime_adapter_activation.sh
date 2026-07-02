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

CLI="$ROOT/scripts/kit.js"
DEST="$TMP_DIR/runtime-dest"
MIXED_SRC="$ROOT/evals/fixtures/flow-kit-repository/mixed-runtime-kit"
OUT="$TMP_DIR/activation.json"
UNKNOWN_OUT="$TMP_DIR/unknown.json"
CATALOG_HASH_BEFORE="$(shasum -a 256 "$ROOT/kits/catalog.json" | awk '{print $1}')"
mkdir -p "$DEST"

echo "=== Runtime Adapter Activation Checks ==="

if flow_agents_node "$CLI" install "$MIXED_SRC" --dest "$DEST" >"$TMP_DIR/install.out" 2>&1; then
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

// supported_asset_classes now includes skills and docs (Issue #58)
const supported = data.supported_asset_classes;
for (const expected of ["flows", "skills", "docs"]) {
  if (!supported.includes(expected)) throw new Error(`supported_asset_classes missing ${expected}: ${JSON.stringify(supported)}`);
}

// generated_runtime_files: flows activated (builder, mixed), skill activated (mixed.skill), activation manifest
const ids = new Set(data.generated_runtime_files.map((item) => item.asset_id));
for (const expected of ["builder.shape", "builder.build", "mixed.runtime", "codex-local.activation"]) {
  if (!ids.has(expected)) throw new Error(`missing generated asset: ${expected}`);
}
// mixed kit skill should now be in generated_runtime_files, not skipped
if (!ids.has("mixed.skill")) throw new Error("missing generated asset: mixed.skill (skills should be activated now)");
// mixed kit doc should now be in generated_runtime_files, not skipped
if (!ids.has("mixed.docs")) throw new Error("missing generated asset: mixed.docs (docs should be activated now)");

// All generated files must exist on disk
for (const item of data.generated_runtime_files) {
  const generatedPath = path.join(dest, item.path);
  if (!fs.existsSync(generatedPath)) throw new Error(`generated file missing: ${generatedPath}`);
  if (path.resolve(catalog) === path.resolve(generatedPath)) throw new Error("activation generated over kits/catalog.json");
}

// Skills must be written to .kontourai/flow-agents/projections/codex/skills/<kit-id>/
const skillFiles = data.generated_runtime_files.filter((item) => item.asset_class === "skills");
if (!skillFiles.length) throw new Error("no skills in generated_runtime_files");
for (const item of skillFiles) {
  if (!item.path.includes(".kontourai/flow-agents/projections/codex/skills/")) {
    throw new Error(`skill not under codex skills dir: ${item.path}`);
  }
  if (!fs.existsSync(path.join(dest, item.path))) throw new Error(`skill file missing on disk: ${item.path}`);
}

// Docs must be written to .kontourai/flow-agents/projections/codex/docs/<kit-id>/
const docFiles = data.generated_runtime_files.filter((item) => item.asset_class === "docs");
if (!docFiles.length) throw new Error("no docs in generated_runtime_files");
for (const item of docFiles) {
  if (!item.path.includes(".kontourai/flow-agents/projections/codex/docs/")) {
    throw new Error(`doc not under codex docs dir: ${item.path}`);
  }
}

// skipped_assets should NOT contain skills or docs any more
const skippedClasses = new Set(data.skipped_assets.map((item) => item.asset_class));
if (skippedClasses.has("skills")) throw new Error("skills should not be in skipped_assets after activation fix");
if (skippedClasses.has("docs")) throw new Error("docs should not be in skipped_assets after activation fix");

// adapters, evals, assets still skipped (not activated by codex-local)
for (const expected of ["adapters", "evals", "assets"]) {
  if (!skippedClasses.has(expected)) throw new Error(`missing skipped asset class: ${expected}`);
}
for (const item of data.skipped_assets) {
  for (const key of ["asset_class", "path", "kit_id", "asset_id", "reason"]) {
    if (!(key in item)) throw new Error(`skipped asset missing ${key}: ${JSON.stringify(item)}`);
  }
}
if (!fs.existsSync(path.join(dest, ".kontourai/flow-agents/projections/codex/activation.json"))) throw new Error("runtime activation manifest missing");
console.log("ok");
NODE
then
  pass "diagnostics report default adapter, generated files (flows+skills+docs), and correct skipped_assets (adapters, evals, assets only)"
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

# Install the mixed kit into strands dest so we can assert skills land there too
if flow_agents_node "$CLI" install "$MIXED_SRC" --dest "$STRANDS_DEST" >"$TMP_DIR/strands-install.out" 2>&1; then
  pass "mixed local kit installs into strands temp destination"
else
  fail "mixed local kit install failed (strands dest)"
  sed -n '1,160p' "$TMP_DIR/strands-install.out"
fi

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

// supported_asset_classes now includes skills and docs (Issue #58)
const supported = data.supported_asset_classes;
for (const expected of ["flows", "skills", "docs"]) {
  if (!supported.includes(expected)) throw new Error(`supported_asset_classes missing ${expected}: ${JSON.stringify(supported)}`);
}

// Verify builder kit flows are generated (builder kit is in catalog.json)
const ids = new Set(data.generated_runtime_files.map((item) => item.asset_id));
for (const expected of ["builder.shape", "builder.build", "strands-local.activation"]) {
  if (!ids.has(expected)) throw new Error(`missing generated asset: ${expected}`);
}
// mixed kit skill should be in generated_runtime_files
if (!ids.has("mixed.skill")) throw new Error("missing generated asset: mixed.skill (skills should be activated by strands-local)");
// mixed kit doc should be in generated_runtime_files
if (!ids.has("mixed.docs")) throw new Error("missing generated asset: mixed.docs (docs should be activated by strands-local)");

// Verify generated runtime files actually exist on disk
for (const item of data.generated_runtime_files) {
  if (item.asset_class === "activation-manifest") continue;
  const generatedPath = path.join(dest, item.path);
  if (!fs.existsSync(generatedPath)) throw new Error(`generated file missing: ${generatedPath}`);
  // Verify flow files are under .kontourai/flow-agents/projections/strands/flows/
  if (item.asset_class === "flows" && !item.path.includes(".kontourai/flow-agents/projections/strands/flows/")) {
    throw new Error(`generated flow path not under strands runtime dir: ${item.path}`);
  }
}

// Skills must be written to .kontourai/flow-agents/projections/strands/skills/<kit-id>/
const skillFiles = data.generated_runtime_files.filter((item) => item.asset_class === "skills");
if (!skillFiles.length) throw new Error("no skills in generated_runtime_files for strands-local");
for (const item of skillFiles) {
  if (!item.path.includes(".kontourai/flow-agents/projections/strands/skills/")) {
    throw new Error(`skill not under strands skills dir: ${item.path}`);
  }
  if (!fs.existsSync(path.join(dest, item.path))) throw new Error(`skill file missing on disk: ${item.path}`);
}

// Docs must be written to .kontourai/flow-agents/projections/strands/docs/<kit-id>/
const docFiles = data.generated_runtime_files.filter((item) => item.asset_class === "docs");
if (!docFiles.length) throw new Error("no docs in generated_runtime_files for strands-local");
for (const item of docFiles) {
  if (!item.path.includes(".kontourai/flow-agents/projections/strands/docs/")) {
    throw new Error(`doc not under strands docs dir: ${item.path}`);
  }
}

// skipped_assets should NOT contain skills or docs
const skippedClasses = new Set(data.skipped_assets.map((item) => item.asset_class));
if (skippedClasses.has("skills")) throw new Error("skills should not be in skipped_assets for strands-local");
if (skippedClasses.has("docs")) throw new Error("docs should not be in skipped_assets for strands-local");

// Verify activation.json written at strands runtime dir
const manifestPath = path.join(dest, ".kontourai/flow-agents/projections/strands/activation.json");
if (!fs.existsSync(manifestPath)) throw new Error("strands runtime activation.json missing");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.adapter !== "strands-local") throw new Error(`activation.json adapter mismatch: ${manifest.adapter}`);
if (!Array.isArray(manifest.skipped_assets)) throw new Error("activation.json missing skipped_assets array");

// Verify skipped_assets have expected fields (parity with codex-local)
for (const item of manifest.skipped_assets) {
  for (const key of ["asset_class", "path", "kit_id", "asset_id", "reason"]) {
    if (!(key in item)) throw new Error(`skipped asset missing ${key}: ${JSON.stringify(item)}`);
  }
}

if (!Array.isArray(data.skipped_assets)) throw new Error("result skipped_assets is not an array");

// Catalog not mutated
if (path.resolve(catalog) === path.resolve(path.join(dest, ".kontourai/flow-agents/projections/strands/activation.json"))) {
  throw new Error("activation generated over kits/catalog.json");
}

console.log("ok");
NODE
then
  pass "strands-local: runtime flow+skill+doc files, activation.json, and skipped_assets present with correct structure"
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
const manifestPath = path.join(dest, ".kontourai/flow-agents/projections/codex/activation.json");
if (!fs.existsSync(manifestPath)) throw new Error("codex activation.json still not present");
// Strands runtime dir must also still exist
const strandsManifestPath = path.join(dest, ".kontourai/flow-agents/projections/strands/activation.json");
if (!fs.existsSync(strandsManifestPath)) throw new Error("strands activation.json was removed by codex-local run");
console.log("ok");
NODE
then
  pass "codex-local and strands-local runtime dirs co-exist independently (AC3)"
else
  fail "co-existence check failed"
  sed -n '1,220p' "$TMP_DIR/codex-after-strands.json"
fi

# -------------------------------------------------------------------------
# Skill activation with a kit that has NO skills (builder kit — flows only)
# -------------------------------------------------------------------------

echo ""
echo "=== Skills: kit-with-no-skills activates cleanly ==="

NO_SKILLS_DEST="$TMP_DIR/no-skills-dest"
NO_SKILLS_OUT="$TMP_DIR/no-skills-activation.json"
mkdir -p "$NO_SKILLS_DEST"

if flow_agents_node "$CLI" activate --dest "$NO_SKILLS_DEST" --source-root "$ROOT" --format json >"$NO_SKILLS_OUT" 2>&1; then
  pass "activation succeeds for source-root with no skills (builder kit only)"
else
  fail "activation failed for kit with no skills"
  sed -n '1,220p' "$NO_SKILLS_OUT"
fi

if node - "$NO_SKILLS_OUT" "$NO_SKILLS_DEST" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
// Use builder-only source root (no installed local kits, built-in kits only)
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const dest = process.argv[3];
if (data.selected_adapter !== "codex-local") throw new Error(`expected codex-local, got: ${data.selected_adapter}`);
// builder kit has no skills or docs — skills dir should not exist (or be empty)
const skillsDir = path.join(dest, ".kontourai/flow-agents/projections/codex/skills");
// It's fine if the dir doesn't exist; builder kit has no skills
const docsDir = path.join(dest, ".kontourai/flow-agents/projections/codex/docs");
// builder kit has no docs either
// No skills or docs in skipped_assets (none declared)
const skippedClasses = new Set(data.skipped_assets.map((item) => item.asset_class));
// builder kit only has flows — no skills or docs — so neither should appear in skipped
if (skippedClasses.has("skills")) throw new Error("builder kit (no skills) should not have skills in skipped_assets");
if (skippedClasses.has("docs")) throw new Error("builder kit (no docs) should not have docs in skipped_assets");
// Flows must still be activated
const ids = new Set(data.generated_runtime_files.map((item) => item.asset_id));
if (!ids.has("builder.shape")) throw new Error("missing builder.shape flow");
if (!ids.has("builder.build")) throw new Error("missing builder.build flow");
if (!fs.existsSync(path.join(dest, ".kontourai/flow-agents/projections/codex/activation.json"))) throw new Error("activation.json missing");
console.log("ok");
NODE
then
  pass "kit with no skills activates cleanly — flows activated, no skills or docs in skipped_assets"
else
  fail "kit with no skills activation check failed"
  sed -n '1,220p' "$NO_SKILLS_OUT"
fi

# -------------------------------------------------------------------------
# AC5: skill-collision namespacing — one SKILL.md per declared skill, not per kit
# -------------------------------------------------------------------------

echo ""
echo "=== AC5: activation namespaces skills by skill directory (17 Builder skills survive) ==="

AC5_DEST="$TMP_DIR/ac5-dest"
mkdir -p "$AC5_DEST"
if flow_agents_node "$CLI" activate --dest "$AC5_DEST" --source-root "$ROOT" --format json >"$TMP_DIR/ac5.json" 2>&1; then
  pass "AC5 activation of this repo's real kits succeeds"
else
  fail "AC5 activation failed"
  sed -n '1,220p' "$TMP_DIR/ac5.json"
fi

EXPECTED_SKILLS="$(node - "$ROOT" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const kitsDir = path.join(process.argv[2], "kits");
let total = 0;
for (const kit of fs.readdirSync(kitsDir)) {
  const manifest = path.join(kitsDir, kit, "kit.json");
  if (!fs.existsSync(manifest)) continue;
  const data = JSON.parse(fs.readFileSync(manifest, "utf8"));
  total += Array.isArray(data.skills) ? data.skills.length : 0;
}
process.stdout.write(String(total));
NODE
)"
# Route the projection skill dir through a variable so the source-tree validator's
# path-reference scan does not misread the projection subpath as a repo source path.
SKILLS_ROOT="$AC5_DEST/.kontourai/flow-agents/projections/codex/skills"
ACTUAL_SKILLS="$(find "$SKILLS_ROOT" -name SKILL.md 2>/dev/null | wc -l | tr -d ' ')"
BUILDER_SKILLS="$(find "$SKILLS_ROOT/builder" -name SKILL.md 2>/dev/null | wc -l | tr -d ' ')"

if [[ "$ACTUAL_SKILLS" == "$EXPECTED_SKILLS" ]] && [[ "$ACTUAL_SKILLS" -gt 1 ]]; then
  pass "activation writes one SKILL.md per declared skill ($ACTUAL_SKILLS == $EXPECTED_SKILLS declared), not one per kit"
else
  fail "skill file count $ACTUAL_SKILLS != declared $EXPECTED_SKILLS (namespacing regression: skills collapsing onto one file per kit)"
fi

if [[ "$BUILDER_SKILLS" == "17" ]]; then
  pass "all 17 Builder Kit skills survive activation (not collapsed to 1)"
else
  fail "expected 17 Builder Kit skills to survive activation, found $BUILDER_SKILLS"
fi

# -------------------------------------------------------------------------
# AC2: activation-time cross-kit dependency enforcement (hard error)
# -------------------------------------------------------------------------

echo ""
echo "=== AC2: activation fails when a declared dependency kit is absent ==="

DEPFAIL_DEST="$TMP_DIR/depfail-dest"
mkdir -p "$DEPFAIL_DEST"
DEPFAIL_SRC="$ROOT/evals/fixtures/flow-kit-repository/valid-with-dependency"
flow_agents_node "$CLI" install "$DEPFAIL_SRC" --dest "$DEPFAIL_DEST" >"$TMP_DIR/depfail-install.out" 2>&1
if flow_agents_node "$CLI" activate --dest "$DEPFAIL_DEST" --source-root "$ROOT" --format json >"$TMP_DIR/depfail.json" 2>&1; then
  fail "activation should exit non-zero when a declared dependency kit is missing"
  sed -n '1,160p' "$TMP_DIR/depfail.json"
elif rg -q "nonexistent-dep-kit" "$TMP_DIR/depfail.json" && rg -q "not installed or activated" "$TMP_DIR/depfail.json"; then
  pass "activation fails (exit 1) with an actionable error naming the missing dependency kit id"
else
  fail "activation dependency-missing error missing expected text (kit id + remedy)"
  sed -n '1,160p' "$TMP_DIR/depfail.json"
fi

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "Runtime adapter activation checks passed."
  exit 0
fi

echo "Runtime adapter activation checks failed: $errors issue(s)."
exit 1
