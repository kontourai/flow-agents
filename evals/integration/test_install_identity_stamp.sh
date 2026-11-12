#!/usr/bin/env bash
# test_install_identity_stamp.sh (#1180 PR 1) — the shipped producer-identity stamp end-to-end.
#
# Proves the artifact that makes per-release effectiveness analysis honest:
#   1. `npm run build` writes build/generated/install-identity.json with the declared schema, and
#      its package_name/package_version are the ones package.json declares (never a stale copy);
#   2. the content fingerprint CHANGES when a covered behavior surface changes — the whole point of
#      the tuple, since a version string alone cannot see a content change;
#   3. the fingerprint is STABLE across a rebuild of an unchanged tree (and returns to its exact
#      prior value once the probe change is removed), so the join key does not churn per build;
#   4. validate:source REJECTS a stamp whose package_version disagrees with package.json — the
#      pack-time truth assertion, so a stale stamp is a pack failure instead of a quiet lie in
#      every telemetry event.
#
# Hermetic: the only tree mutation is one probe file under a covered root, removed by an EXIT trap
# that also rebuilds, so a mid-test failure never leaves the worktree or the stamp mutated.
# Usage: bash evals/integration/test_install_identity_stamp.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAMP="$ROOT/build/generated/install-identity.json"
# Assemble the probe path from components so this eval file never contains a bare
# `<covered-root>/<file>` literal — validate-source-tree's legacy-ref scanner would otherwise flag
# the transient fixture as a missing source path (the same reason test_capability_declarations.sh
# assembles its own source path from components).
PROBE_DIR="$ROOT/prompts"
PROBE="$PROBE_DIR/install-identity-fingerprint-probe.generated.txt"

PKG="$ROOT/package.json"
PKG_BACKUP="$(mktemp)"
cp "$PKG" "$PKG_BACKUP"

cleanup() {
  rm -f "$PROBE"
  # Restore package.json byte-identically: the unsupported-negation case below edits it, and an
  # interrupted run must never leave a mutated manifest behind.
  cp "$PKG_BACKUP" "$PKG"
  rm -f "$PKG_BACKUP"
  (cd "$ROOT" && npm run build) >/dev/null 2>&1 || true
}
trap cleanup EXIT

errors=0
pass() { echo "  [PASS] $1"; }
fail() { echo "  [FAIL] $1"; errors=$((errors + 1)); }

if ! command -v jq >/dev/null 2>&1; then echo "jq not available; skipping install identity stamp tests"; exit 0; fi

echo "=== install identity stamp (#1180) ==="

rebuild() { (cd "$ROOT" && npm run build) >/dev/null 2>&1; }
fingerprint() { jq -r '.content_fingerprint // ""' "$STAMP" 2>/dev/null; }

# ── 1. the build produces the stamp ───────────────────────────────────────────────────────────────
rm -f "$STAMP"
if rebuild && [[ -f "$STAMP" ]]; then
  pass "npm run build writes build/generated/install-identity.json"
else
  fail "npm run build did not write the install-identity stamp"
  echo "Cannot continue without the stamp"
  exit 1
fi

# ── 2. declared schema ────────────────────────────────────────────────────────────────────────────
pkg_name=$(jq -r '.name' "$ROOT/package.json")
pkg_version=$(jq -r '.version' "$ROOT/package.json")
if jq -e --arg n "$pkg_name" --arg v "$pkg_version" '
      .schema_version == "1.0"
      and .package_name == $n
      and .package_version == $v
      and (.content_fingerprint | test("^sha256:[0-9a-f]{64}$"))
      and (.git_sha == null or (.git_sha | test("^[0-9a-f]{40,64}$")))
      and (.git_dirty == null or (.git_dirty | type == "boolean"))
      and (.built_at | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T"))
    ' "$STAMP" >/dev/null 2>&1; then
  pass "stamp declares schema_version, package identity, fingerprint, git state, and built_at"
else
  fail "stamp schema is wrong: $(cat "$STAMP")"
fi

# git_dirty must never claim "clean" about a tree git could not describe.
if jq -e '(.git_sha != null) or (.git_dirty == null)' "$STAMP" >/dev/null 2>&1; then
  pass "git_dirty is null (not a fabricated false) when git_sha is unresolved"
else
  fail "stamp asserts git_dirty without a git_sha to observe it from"
fi

baseline=$(fingerprint)

# ── 3. rebuilding an unchanged tree keeps the fingerprint identical ────────────────────────────────
rebuild
if [[ -n "$baseline" && "$(fingerprint)" == "$baseline" ]]; then
  pass "fingerprint is stable across a rebuild of an unchanged tree"
else
  fail "fingerprint churned on an unchanged rebuild: $baseline -> $(fingerprint)"
fi

# ── 4. a covered behavior surface changes -> the fingerprint changes ───────────────────────────────
# The prompts directory is one of the covered roots. A version string cannot see this change; the
# fingerprint is the field that must.
printf 'install-identity fingerprint probe (%s)\n' "$$" > "$PROBE"
rebuild
probed=$(fingerprint)
if [[ -n "$probed" && "$probed" != "$baseline" ]]; then
  pass "fingerprint changes when a covered file changes"
else
  fail "fingerprint did not change after mutating a covered surface (still $probed)"
fi

rm -f "$PROBE"
rebuild
if [[ "$(fingerprint)" == "$baseline" ]]; then
  pass "fingerprint returns to its exact prior value once the change is reverted"
else
  fail "fingerprint did not restore after reverting the probe: expected $baseline, got $(fingerprint)"
fi

# ── 5. pack-time truth assertion: a stale package_version fails validate:source ────────────────────
# Tamper with the BUILT stamp and run the compiled validator directly. `npm run validate:source`
# rebuilds first (which would regenerate the stamp and erase the tamper), so the direct invocation
# is what actually exercises the stale-stamp branch that protects a pack.
tampered_backup="$(mktemp)"
cp "$STAMP" "$tampered_backup"
jq '.package_version = "0.0.0-stale"' "$tampered_backup" > "$STAMP"
validate_out=$(cd "$ROOT" && node build/src/cli.js validate-source 2>&1)
validate_status=$?
cp "$tampered_backup" "$STAMP"
rm -f "$tampered_backup"
if [[ $validate_status -ne 0 ]] && printf '%s' "$validate_out" | grep -q "install-identity.json: package_version"; then
  pass "validate:source rejects a stamp whose package_version is stale"
else
  fail "validate:source accepted a stale stamp (status=$validate_status)"
fi

# The restored stamp must be the honest one again, so the tamper cannot survive this eval.
if jq -e --arg v "$pkg_version" '.package_version == $v' "$STAMP" >/dev/null 2>&1; then
  pass "stamp restored to the honest package_version after the tamper case"
else
  fail "stamp was left tampered"
fi

# ── 6. an unsupported `files` negation form fails the build loudly ────────────────────────────────
# The fingerprint's exclusions are derived from package.json's `files` negations. The generator
# understands three narrow forms; anything else must STOP the build. The failure mode this guards
# is silent: a negation the parser skipped would leave the digest covering content npm strips from
# the tarball, so the shipped artifact's identity would be a digest of files it does not contain.
jq '.files += ["!kits/*.experimental"]' "$PKG_BACKUP" > "$PKG"
negation_out=$( (cd "$ROOT" && npm run build) 2>&1 )
negation_status=$?
cp "$PKG_BACKUP" "$PKG"
if [[ $negation_status -ne 0 ]] && printf '%s' "$negation_out" | grep -q "uses an exclusion form generate-install-identity.ts does not support"; then
  pass "an unsupported files negation fails the build with a named, actionable message"
else
  fail "the build accepted an unsupported files negation (status=$negation_status)"
fi

# A supported directory-prefix negation must NOT fail — the guard rejects unknown forms, it does not
# reject exclusions in general.
jq '.files += ["!kits/experimental/"]' "$PKG_BACKUP" > "$PKG"
if (cd "$ROOT" && npm run build) >/dev/null 2>&1; then
  pass "a supported directory-prefix negation still builds"
else
  fail "a supported directory-prefix negation broke the build"
fi
cp "$PKG_BACKUP" "$PKG"
rebuild
if [[ "$(fingerprint)" == "$baseline" ]]; then
  pass "package.json restored and the fingerprint is back to baseline"
else
  fail "package.json restore left the fingerprint at $(fingerprint), expected $baseline"
fi

# ── 7. the fingerprint covers exactly what npm packs under its roots ──────────────────────────────
# package.json `files` excludes *.test.* files and lists the kit evals kit.json declares by plain
# path. npm ships a plain file path wherever it appears, and a directory listed after a negation
# re-includes under it. The fingerprint models both, so for each `files` shape below its file set
# must equal the `npm pack --dry-run` file set under FINGERPRINT_ROOTS, in both directions.
# fingerprintLines() reads package.json on each call, so no rebuild is needed per shape. The module
# path goes through the environment, not argv: the generator runs main() (and rewrites the stamp)
# when argv[1] is its own path.
parity() {
  (cd "$ROOT" && npm pack --dry-run --json --ignore-scripts 2>/dev/null | FINGERPRINT_MODULE="$ROOT/build/src/tools/generate-install-identity.js" node --input-type=module -e '
  let raw = ""; for await (const chunk of process.stdin) raw += chunk;
  const { fingerprintLines, FINGERPRINT_ROOTS } = await import(process.env.FINGERPRINT_MODULE);
  const covered = new Set(fingerprintLines().map((line) => line.split("\0")[0]));
  const packed = new Set(JSON.parse(raw)[0].files.map((f) => f.path).filter((p) => FINGERPRINT_ROOTS.some((r) => p.startsWith(`${r}/`))));
  const extra = [...covered].filter((p) => !packed.has(p)), missing = [...packed].filter((p) => !covered.has(p));
  if (packed.size === 0 || extra.length || missing.length) { console.log(JSON.stringify({ packed: packed.size, extra: extra.slice(0, 5), missing: missing.slice(0, 5) })); process.exit(1); }
  console.log(`${covered.size} files`);
') 2>&1
}
check_parity() {
  local label="$1" out
  if out=$(parity); then pass "$label: fingerprint equals the packed file set ($out)"; else fail "$label: fingerprint and npm pack disagree: $out"; fi
}

check_parity "committed files"

# Plain eval paths moved BEFORE the negations: npm still ships them, so the fingerprint must too.
jq '.files as $f | ($f | map(select(test("\\.test\\.[cm]?js$") and (startswith("!") | not)))) as $plain
    | .files = $plain + ($f - $plain)' "$PKG_BACKUP" > "$PKG"
check_parity "plain test paths listed before the negations"

# A directory listed after the negations re-includes the excluded test files under it.
jq '.files += ["kits/knowledge/promote/"]' "$PKG_BACKUP" > "$PKG"
check_parity "directory listed after the negations"
cp "$PKG_BACKUP" "$PKG"

# A wildcard after a negation would re-include its matches, which the generator does not model:
# the build must refuse with the entry named.
jq '.files += ["kits/**/suite.test.js"]' "$PKG_BACKUP" > "$PKG"
wildcard_out=$( (cd "$ROOT" && npm run build) 2>&1 )
wildcard_status=$?
cp "$PKG_BACKUP" "$PKG"
if [[ $wildcard_status -ne 0 ]] && printf '%s' "$wildcard_out" | grep -q "'kits/\*\*/suite.test.js' is a wildcard listed after a negation"; then
  pass "a wildcard re-include after a negation fails the build with the entry named"
else
  fail "the build accepted a wildcard re-include after a negation (status=$wildcard_status)"
fi
rebuild

echo ""
if [[ $errors -eq 0 ]]; then
  echo "install identity stamp: all checks passed"
  exit 0
fi
echo "install identity stamp: $errors check(s) failed"
exit 1
