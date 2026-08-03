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

cleanup() {
  rm -f "$PROBE"
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

echo ""
if [[ $errors -eq 0 ]]; then
  echo "install identity stamp: all checks passed"
  exit 0
fi
echo "install identity stamp: $errors check(s) failed"
exit 1
