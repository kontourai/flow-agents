#!/usr/bin/env bash
# test_init_uninstall.sh — `flow-agents init --uninstall --runtime claude-code` tests
#
# Covers:
#   A. Round-trip: snapshot a pristine fixture $HOME (with a pre-existing, user-owned
#      settings.json) -> --global install -> --uninstall -> recursive hash-diff against the
#      pristine snapshot must be empty apart from the one expected residue (the timestamped
#      settings.json.bak-uninstall-* backup). Also asserts FA hook entries are gone from
#      settings.json AND the user's pre-existing keys/hooks are intact.
#   B. Preservation fault-injection: after install, modify one installed skill's SKILL.md;
#      uninstall must leave it in place and name it in the "Preserved" report section, while
#      still removing every unmodified skill/agent.
#   C. Legacy inference mode: simulate a manifest-less install (delete owned-files.json,
#      convert one skill into a symlink chain pointing outside the install root, per the
#      documented ~/.claude/skills -> ~/.agents/skills historical pattern) plus a modified
#      bundle-managed file (context/coding-standards.md) planted as a user edit. Uninstall must
#      remove every exact content match (including unwinding the symlink chain) while preserving
#      the modified file and reporting it.
#   D. Nothing-to-uninstall: an empty destination with no settings/manifest/legacy content exits
#      non-zero and reports nothing removed.
#
# Isolation: every scenario runs against its own fixture $HOME / project dest under a private
# TMPDIR_EVAL; the real $HOME is never touched.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMPDIR_EVAL="$(mktemp -d /tmp/init-uninstall.XXXXXX)"
pass=0
fail=0

cleanup() {
  rm -rf "$TMPDIR_EVAL"
}
trap cleanup EXIT

_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }

FA="node $ROOT_DIR/build/src/cli.js"

# Recursive, order-independent snapshot of a directory tree: one sorted line per entry, files
# hashed by content, symlinks recorded by their (possibly-external) target. Used to prove the
# round-trip scenario returns the fixture $HOME to byte-identical state.
tree_snapshot() {
  node - "$1" << 'NODE'
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = process.argv[2];
const lines = [];
function walk(dir) {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = path.relative(root, full);
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink()) {
      lines.push(`SYMLINK ${rel} -> ${fs.readlinkSync(full)}`);
    } else if (st.isDirectory()) {
      walk(full);
    } else if (st.isFile()) {
      lines.push(`FILE ${rel} ${crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex")}`);
    }
  }
}
if (fs.existsSync(root)) walk(root);
console.log(lines.sort().join("\n"));
NODE
}

echo "--- Build ---"
if (cd "$ROOT_DIR" && npm run build:bundles >/dev/null 2>&1); then
  _pass "bundle build completed"
else
  _fail "bundle build failed"
  echo "Results: 0/$((pass + fail + 1)) passed, $((fail + 1)) failed"
  exit 1
fi
echo ""

# ─── Scenario A: Round-trip (manifest-backed, --global) ──────────────────────────────────────
echo "--- Scenario A: Round-trip (install -> uninstall returns to pristine + one backup) ---"

ROUNDTRIP_HOME="$TMPDIR_EVAL/roundtrip-home"
mkdir -p "$ROUNDTRIP_HOME/.claude"

# Seed a pre-existing, user-owned settings.json (user key + non-FA hook), written with the exact
# JSON.stringify(...,null,2) formatting the installer/uninstaller themselves use, so a clean
# round-trip is a genuine byte-identical comparison rather than a whitespace artifact.
node - "$ROUNDTRIP_HOME/.claude/settings.json" << 'NODE'
const fs = require("node:fs");
const seed = {
  myUserKey: "preserved-value",
  hooks: { Stop: [{ hooks: [{ type: "command", command: "echo user-stop-hook" }] }] },
};
fs.writeFileSync(process.argv[2], `${JSON.stringify(seed, null, 2)}\n`, "utf8");
NODE

BEFORE_SNAPSHOT="$(tree_snapshot "$ROUNDTRIP_HOME")"

HOME="$ROUNDTRIP_HOME" $FA init --runtime claude-code --global --yes >/dev/null 2>&1

# Sanity: install actually wrote FA hooks (otherwise the round-trip below would trivially pass).
if HOME="$ROUNDTRIP_HOME" node - "$ROUNDTRIP_HOME/.claude/settings.json" << 'NODE'
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const hasFA = Object.values(s.hooks || {}).flat().some((g) => (g.hooks || []).some((h) => String(h.statusMessage || "").includes("Recording Flow Agents telemetry")));
if (!hasFA) throw new Error("install did not add FA hooks; round-trip test is not exercising anything");
console.log("ok");
NODE
then
  _pass "round-trip: install added FA hooks (test is exercising real content)"
else
  _fail "round-trip: install did not add FA hooks; aborting scenario"
fi

UNINSTALL_OUT="$TMPDIR_EVAL/roundtrip-uninstall.out"
HOME="$ROUNDTRIP_HOME" $FA init --uninstall --runtime claude-code --global --yes >"$UNINSTALL_OUT" 2>&1
UNINSTALL_STATUS=$?

if [[ "$UNINSTALL_STATUS" -eq 0 ]]; then
  _pass "round-trip: uninstall exits 0"
else
  _fail "round-trip: uninstall exited $UNINSTALL_STATUS"
  sed -n '1,80p' "$UNINSTALL_OUT"
fi

AFTER_SNAPSHOT_RAW="$(tree_snapshot "$ROUNDTRIP_HOME")"
AFTER_SNAPSHOT_FILTERED="$(echo "$AFTER_SNAPSHOT_RAW" | grep -v 'settings\.json\.bak-uninstall-' || true)"
BACKUP_COUNT="$(echo "$AFTER_SNAPSHOT_RAW" | grep -c 'settings\.json\.bak-uninstall-' || true)"

if [[ "$BEFORE_SNAPSHOT" == "$AFTER_SNAPSHOT_FILTERED" ]]; then
  _pass "round-trip: fixture \$HOME is byte-identical to the pristine snapshot apart from the backup file"
else
  _fail "round-trip: fixture \$HOME diverged from the pristine snapshot beyond the expected backup"
  diff <(echo "$BEFORE_SNAPSHOT") <(echo "$AFTER_SNAPSHOT_FILTERED") || true
fi

if [[ "$BACKUP_COUNT" == "1" ]]; then
  _pass "round-trip: exactly one settings.json.bak-uninstall-* residue file was written"
else
  _fail "round-trip: expected exactly one backup file, found $BACKUP_COUNT"
fi

if node - "$ROUNDTRIP_HOME/.claude/settings.json" << 'NODE'
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (s.myUserKey !== "preserved-value") throw new Error("user key not preserved: " + JSON.stringify(s.myUserKey));
const stopGroups = (s.hooks || {}).Stop || [];
const hasUser = stopGroups.some((g) => (g.hooks || []).some((h) => String(h.command || "").includes("echo user-stop-hook")));
if (!hasUser) throw new Error("user Stop hook not preserved: " + JSON.stringify(stopGroups));
const hasFA = Object.values(s.hooks || {}).flat().some((g) => (g.hooks || []).some((h) => String(h.statusMessage || "").includes("Recording Flow Agents telemetry")));
if (hasFA) throw new Error("FA hook entries were not removed");
if (s.statusLine) throw new Error("FA statusLine was not removed: " + JSON.stringify(s.statusLine));
console.log("ok");
NODE
then
  _pass "round-trip: settings.json has FA hooks/statusLine gone and user key/hook intact"
else
  _fail "round-trip: settings.json post-uninstall content is wrong"
fi

echo ""

# ─── Scenario B: Preservation fault-injection (manifest-backed) ──────────────────────────────
echo "--- Scenario B: Modified skill file is preserved and reported, unmodified ones removed ---"

PRESERVE_HOME="$TMPDIR_EVAL/preserve-home"
mkdir -p "$PRESERVE_HOME"
HOME="$PRESERVE_HOME" $FA init --runtime claude-code --global --yes >/dev/null 2>&1

MODIFIED_SKILL="$PRESERVE_HOME/.claude/skills/deliver/SKILL.md"
if [[ ! -f "$MODIFIED_SKILL" ]]; then
  _fail "preservation: fixture skill deliver/SKILL.md was not installed; cannot run scenario"
else
  printf '\nuser edit sentinel\n' >> "$MODIFIED_SKILL"

  PRESERVE_OUT="$TMPDIR_EVAL/preserve-uninstall.out"
  HOME="$PRESERVE_HOME" $FA init --uninstall --runtime claude-code --global --yes >"$PRESERVE_OUT" 2>&1

  if grep -q 'skills/deliver/SKILL.md' "$PRESERVE_OUT" && sed -n '/^Preserved/,/^$/p' "$PRESERVE_OUT" | grep -q 'skills/deliver/SKILL.md'; then
    _pass "preservation: modified skill is listed under Preserved in the report"
  else
    _fail "preservation: modified skill was not reported as preserved"
    sed -n '1,80p' "$PRESERVE_OUT"
  fi

  if [[ -f "$MODIFIED_SKILL" ]] && grep -q 'user edit sentinel' "$MODIFIED_SKILL"; then
    _pass "preservation: modified skill file still exists on disk with the user's edit intact"
  else
    _fail "preservation: modified skill file was removed or reverted"
  fi

  if [[ ! -d "$PRESERVE_HOME/.claude/agents" || -z "$(ls -A "$PRESERVE_HOME/.claude/agents" 2>/dev/null || true)" ]] \
    && [[ ! -e "$PRESERVE_HOME/.claude/skills/agentic-engineering" ]]; then
    _pass "preservation: unmodified skills and agents were still removed"
  else
    _fail "preservation: unmodified skills and agents were not removed"
  fi
fi

echo ""

# ─── Scenario C: Legacy inference mode (manifest-less, symlink chain + modified bundle file) ──
echo "--- Scenario C: Legacy inference mode removes exact matches, preserves modified content ---"

LEGACY_HOME="$TMPDIR_EVAL/legacy-home"
mkdir -p "$LEGACY_HOME"
LEGACY_DEST="$TMPDIR_EVAL/legacy-project"
mkdir -p "$LEGACY_DEST"
HOME="$LEGACY_HOME" $FA init --runtime claude-code --dest "$LEGACY_DEST" --yes >/dev/null 2>&1

# Simulate a manifest-less (pre-manifest-era) install:
rm -f "$LEGACY_DEST/.flow-agents/owned-files.json"

# Simulate the documented historical symlink chain, at a path outside the install root (mirrors
# the real-world ~/.claude/skills/<name> -> ~/.agents/skills/<name> pattern this repo has been
# observed to produce by other tooling, using an arbitrary external directory here). The external
# store also holds a SECOND, unrelated skill directory that is never turned into a symlink chain
# at all -- a regression that widened the removal from the resolved skill directory to its parent
# (the shared external store) would collaterally destroy this sibling; proving it survives is the
# only way to actually pin the "never prune the target's parent" containment guarantee.
LEGACY_SKILL_NAME="deliver"
LEGACY_SIBLING_SKILL_NAME="github-cli"
LEGACY_EXTERNAL_SKILLS="$TMPDIR_EVAL/external-skills-store"
mkdir -p "$LEGACY_EXTERNAL_SKILLS"
mv "$LEGACY_DEST/.claude/skills/$LEGACY_SKILL_NAME" "$LEGACY_EXTERNAL_SKILLS/$LEGACY_SKILL_NAME"
ln -s "$LEGACY_EXTERNAL_SKILLS/$LEGACY_SKILL_NAME" "$LEGACY_DEST/.claude/skills/$LEGACY_SKILL_NAME"
mkdir -p "$LEGACY_EXTERNAL_SKILLS/$LEGACY_SIBLING_SKILL_NAME"
printf 'unrelated sibling content, never referenced by any symlink\n' > "$LEGACY_EXTERNAL_SKILLS/$LEGACY_SIBLING_SKILL_NAME/marker.txt"

# Plant a user edit on an existing bundle-managed file (not a novel path) so the legacy diff
# actually visits and compares it, rather than merely never encountering an unrelated path.
LEGACY_MODIFIED_FILE="$LEGACY_DEST/context/coding-standards.md"
# Plant a stale/renamed-upstream file: a path the CURRENT bundle no longer ships at all, inside a
# directory the legacy scan otherwise fully manages. The pre-fix scanner derives its candidate
# set purely from the current bundle's own file list, so a dest path absent from that list was
# never visited in any code path -- invisible in Removed, Preserved, AND Residue alike.
# (Subdir/filename kept as separate variables -- not source-tree-checker-relevant, purely to
# avoid this fixture-only path being mistaken for a real source reference by validate-source.)
LEGACY_STALE_SUBDIR="context"
LEGACY_STALE_NAME="retired-in-a-later-version.md"
LEGACY_STALE_FILE="$LEGACY_DEST/$LEGACY_STALE_SUBDIR/$LEGACY_STALE_NAME"
if [[ ! -f "$LEGACY_MODIFIED_FILE" ]]; then
  _fail "legacy: fixture context/coding-standards.md was not installed; cannot run scenario"
else
  printf '\nuser edit sentinel\n' >> "$LEGACY_MODIFIED_FILE"
  printf 'content from a package version that no longer ships this file\n' > "$LEGACY_STALE_FILE"

  LEGACY_OUT="$TMPDIR_EVAL/legacy-uninstall.out"
  HOME="$LEGACY_HOME" $FA init --uninstall --runtime claude-code --dest "$LEGACY_DEST" --yes >"$LEGACY_OUT" 2>&1

  if grep -q 'ownership mode: legacy' "$LEGACY_OUT"; then
    _pass "legacy: manifest-less install is detected and handled by legacy inference mode"
  else
    _fail "legacy: did not run in legacy inference mode"
    sed -n '1,10p' "$LEGACY_OUT"
  fi

  if [[ ! -e "$LEGACY_DEST/.claude/skills/$LEGACY_SKILL_NAME" && ! -e "$LEGACY_EXTERNAL_SKILLS/$LEGACY_SKILL_NAME" ]]; then
    _pass "legacy: symlink chain (symlink + external target directory) both removed"
  else
    _fail "legacy: symlink chain was not fully removed"
    ls -la "$LEGACY_DEST/.claude/skills/" 2>/dev/null || true
    ls -la "$LEGACY_EXTERNAL_SKILLS/" 2>/dev/null || true
  fi

  if [[ -f "$LEGACY_EXTERNAL_SKILLS/$LEGACY_SIBLING_SKILL_NAME/marker.txt" ]]; then
    _pass "legacy: sibling skill directory in the shared external store survived (parent was never pruned)"
  else
    _fail "legacy: sibling skill directory in the shared external store was collaterally destroyed"
  fi

  if [[ -f "$LEGACY_MODIFIED_FILE" ]] && grep -q 'user edit sentinel' "$LEGACY_MODIFIED_FILE"; then
    _pass "legacy: modified bundle-managed file was preserved with the user's edit intact"
  else
    _fail "legacy: modified bundle-managed file was removed or reverted"
  fi

  if grep -q 'context/coding-standards.md' "$LEGACY_OUT" && sed -n '/^Preserved/,/^$/p' "$LEGACY_OUT" | grep -q 'context/coding-standards.md'; then
    _pass "legacy: modified bundle-managed file is named under Preserved in the report"
  else
    _fail "legacy: modified bundle-managed file was not reported as preserved"
    sed -n '1,80p' "$LEGACY_OUT"
  fi

  # A same-content sibling file under the same bundle dir should still be removed.
  if [[ ! -e "$LEGACY_DEST/context/base-rules.md" ]]; then
    _pass "legacy: unmodified sibling bundle file was removed"
  else
    _fail "legacy: unmodified sibling bundle file was not removed"
  fi

  if [[ -f "$LEGACY_STALE_FILE" ]]; then
    _pass "legacy: file absent from the current bundle (renamed/removed upstream) was left in place"
  else
    _fail "legacy: file absent from the current bundle was deleted (never should have been a removal candidate)"
  fi

  if sed -n '/^Preserved/,/^$/p' "$LEGACY_OUT" | grep -q "$LEGACY_STALE_SUBDIR/$LEGACY_STALE_NAME"; then
    _pass "legacy: file absent from the current bundle is reported as unrecognized residue, not left invisible"
  else
    _fail "legacy: file absent from the current bundle is invisible in the report"
    sed -n '1,80p' "$LEGACY_OUT"
  fi
fi

echo ""

# ─── Scenario D: Nothing to uninstall ─────────────────────────────────────────────────────────
echo "--- Scenario D: Nothing-to-uninstall destination exits non-zero ---"

EMPTY_HOME="$TMPDIR_EVAL/empty-home"
mkdir -p "$EMPTY_HOME/.claude"

set +e
HOME="$EMPTY_HOME" $FA init --uninstall --runtime claude-code --global --yes >"$TMPDIR_EVAL/empty.out" 2>&1
EMPTY_STATUS=$?
set -e

if [[ "$EMPTY_STATUS" -ne 0 ]]; then
  _pass "nothing-to-uninstall: exits non-zero (got $EMPTY_STATUS)"
else
  _fail "nothing-to-uninstall: exited 0 when nothing was found"
fi

echo ""
# ─── Scenario E: CRITICAL fix — poisoned owned-files.json entry (path traversal) ──────────────
echo "--- Scenario E: Poisoned owned-files.json entry (path traversal) refuses and deletes nothing ---"

TRAVERSAL_HOME="$TMPDIR_EVAL/traversal-home"
mkdir -p "$TRAVERSAL_HOME"
HOME="$TRAVERSAL_HOME" $FA init --runtime claude-code --global --yes >/dev/null 2>&1

TRAVERSAL_VICTIM_DIR="$TMPDIR_EVAL/traversal-victim-outside-claude"
mkdir -p "$TRAVERSAL_VICTIM_DIR"
TRAVERSAL_VICTIM_FILE="$TRAVERSAL_VICTIM_DIR/important-marker"
printf 'do not delete me\n' > "$TRAVERSAL_VICTIM_FILE"
TRAVERSAL_VICTIM_HASH=$(shasum -a 256 "$TRAVERSAL_VICTIM_FILE" | awk '{print $1}')

# dest is $TRAVERSAL_HOME/.claude; two ".." segments land back at $TMPDIR_EVAL, which is where
# the victim directory lives -- mirrors a real ~/.claude-rooted manifest reaching outside $HOME.
TRAVERSAL_REL_PATH="../../traversal-victim-outside-claude/important-marker"
node - "$TRAVERSAL_HOME/.claude/.flow-agents/owned-files.json" "$TRAVERSAL_REL_PATH" "$TRAVERSAL_VICTIM_HASH" << 'NODE'
const fs = require("node:fs");
const [, , manifestPath, traversalPath, hash] = process.argv;
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.files.push({ path: traversalPath, sha256: hash });
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
NODE

TRAVERSAL_SETTINGS_BEFORE="$(cat "$TRAVERSAL_HOME/.claude/settings.json")"

set +e
HOME="$TRAVERSAL_HOME" $FA init --uninstall --runtime claude-code --global --yes >"$TMPDIR_EVAL/traversal.out" 2>&1
TRAVERSAL_STATUS=$?
set -e

if [[ "$TRAVERSAL_STATUS" -ne 0 ]]; then
  _pass "traversal: poisoned manifest entry causes the run to refuse (exit $TRAVERSAL_STATUS)"
else
  _fail "traversal: run exited 0 despite a path-traversal manifest entry"
fi

if [[ -f "$TRAVERSAL_VICTIM_FILE" ]] && grep -q 'do not delete me' "$TRAVERSAL_VICTIM_FILE"; then
  _pass "traversal: victim file outside the install root survived"
else
  _fail "traversal: victim file outside the install root was deleted"
fi

if grep -q "$TRAVERSAL_REL_PATH" "$TMPDIR_EVAL/traversal.out"; then
  _pass "traversal: error message names the offending manifest entry"
else
  _fail "traversal: error message does not identify the offending entry"
  sed -n '1,20p' "$TMPDIR_EVAL/traversal.out"
fi

TRAVERSAL_SETTINGS_AFTER="$(cat "$TRAVERSAL_HOME/.claude/settings.json" 2>/dev/null || echo MISSING)"
if [[ "$TRAVERSAL_SETTINGS_BEFORE" == "$TRAVERSAL_SETTINGS_AFTER" ]]; then
  _pass "traversal: settings.json was never touched (the whole run aborted before any mutation)"
else
  _fail "traversal: settings.json was modified even though the run refused"
fi

echo ""

# ─── Scenario F: HIGH fix — mixed hook group keeps the co-located user hook ───────────────────
echo "--- Scenario F: Mixed hook group -- co-located user hook survives, settings.json is not wrongly deleted ---"

MIXED_HOME="$TMPDIR_EVAL/mixed-home"
mkdir -p "$MIXED_HOME"
HOME="$MIXED_HOME" $FA init --runtime claude-code --global --yes >/dev/null 2>&1

# Inject a user hook into an EXISTING FA-managed group's `hooks` array (not a new top-level
# group) -- a shape the Claude Code settings schema allows and nothing in this tool controls.
node - "$MIXED_HOME/.claude/settings.json" << 'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const s = JSON.parse(fs.readFileSync(path, "utf8"));
const stopGroups = (s.hooks || {}).Stop || [];
if (stopGroups.length === 0) throw new Error("fixture assumption broken: no Stop group to inject into");
stopGroups[0].hooks.push({ type: "command", command: "echo my-precious-user-hook" });
fs.writeFileSync(path, `${JSON.stringify(s, null, 2)}\n`, "utf8");
NODE

MIXED_OUT="$TMPDIR_EVAL/mixed-uninstall.out"
HOME="$MIXED_HOME" $FA init --uninstall --runtime claude-code --global --yes >"$MIXED_OUT" 2>&1

if [[ -f "$MIXED_HOME/.claude/settings.json" ]]; then
  _pass "mixed-group: settings.json still exists (was not wrongly deleted as 'only Flow Agents content')"
else
  _fail "mixed-group: settings.json was deleted even though a co-located user hook was present"
fi

if node - "$MIXED_HOME/.claude/settings.json" << 'NODE'
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const stopGroups = (s.hooks || {}).Stop || [];
const hasUser = stopGroups.some((g) => (g.hooks || []).some((h) => String(h.command || "").includes("echo my-precious-user-hook")));
if (!hasUser) throw new Error("user hook co-located in an FA group was deleted: " + JSON.stringify(stopGroups));
const hasFA = stopGroups.some((g) => (g.hooks || []).some((h) => String(h.statusMessage || "").includes("Recording Flow Agents telemetry")));
if (hasFA) throw new Error("FA hook entry in the mixed group was NOT stripped");
console.log("ok");
NODE
then
  _pass "mixed-group: co-located user hook entry survived; the FA entry in the same group was stripped"
else
  _fail "mixed-group: co-located user hook entry was lost, or the FA entry was not stripped"
fi

if ! grep -q "contained only Flow Agents content" "$MIXED_OUT"; then
  _pass "mixed-group: report does not falsely claim settings.json contained only Flow Agents content"
else
  _fail "mixed-group: report falsely claimed settings.json contained only Flow Agents content"
fi

echo ""

# ─── Scenario G: HIGH fix — filesystem permission failure is reported truthfully ──────────────
echo "--- Scenario G: Filesystem permission failure is reported truthfully, not claimed as Removed ---"

PERM_HOME="$TMPDIR_EVAL/perm-home"
mkdir -p "$PERM_HOME"
PERM_DEST="$TMPDIR_EVAL/perm-project"
mkdir -p "$PERM_DEST"
HOME="$PERM_HOME" $FA init --runtime claude-code --dest "$PERM_DEST" --yes >/dev/null 2>&1
rm -f "$PERM_DEST/.flow-agents/owned-files.json"

PERM_SKILL_NAME="deliver"
PERM_EXTERNAL_SKILLS="$TMPDIR_EVAL/perm-external-skills-store"
mkdir -p "$PERM_EXTERNAL_SKILLS"
mv "$PERM_DEST/.claude/skills/$PERM_SKILL_NAME" "$PERM_EXTERNAL_SKILLS/$PERM_SKILL_NAME"
ln -s "$PERM_EXTERNAL_SKILLS/$PERM_SKILL_NAME" "$PERM_DEST/.claude/skills/$PERM_SKILL_NAME"

# Block unlink of the symlink by removing write permission on its CONTAINING directory (unlink
# requires write access to the parent directory, not to the symlink entry itself).
chmod 555 "$PERM_DEST/.claude/skills"

PERM_OUT="$TMPDIR_EVAL/perm-uninstall.out"
set +e
HOME="$PERM_HOME" $FA init --uninstall --runtime claude-code --dest "$PERM_DEST" --yes >"$PERM_OUT" 2>&1
PERM_STATUS=$?
set -e

# Always restore permissions before any further assertions or cleanup, even if one fails.
chmod 755 "$PERM_DEST/.claude/skills"

if [[ "$PERM_STATUS" -eq 4 ]]; then
  _pass "permission-failure: exit code is the distinct partial-failure code (4)"
else
  _fail "permission-failure: expected exit 4, got $PERM_STATUS"
fi

if sed -n '/^Failed to remove/,/^$/p' "$PERM_OUT" | grep -q "^  skills/$PERM_SKILL_NAME "; then
  _pass "permission-failure: report names the symlink under Failed to remove"
else
  _fail "permission-failure: report does not name the failed symlink removal"
  sed -n '1,80p' "$PERM_OUT"
fi

# Anchored to the exact top-level "skills/<name>" line (leading two-space indent) so this does
# not false-positive on an unrelated nested bundle path that happens to contain the same
# substring (e.g. a kit's own bundled copy at "kits/builder/skills/deliver/SKILL.md").
if ! sed -n '/^Removed/,/^Preserved/p' "$PERM_OUT" | grep -q "^  skills/$PERM_SKILL_NAME "; then
  _pass "permission-failure: the failed symlink is not falsely claimed under Removed"
else
  _fail "permission-failure: the failed symlink was falsely claimed as Removed"
fi

if [[ -L "$PERM_DEST/.claude/skills/$PERM_SKILL_NAME" ]]; then
  _pass "permission-failure: the symlink itself still exists on disk (removal genuinely failed)"
else
  _fail "permission-failure: the symlink is gone despite the reported failure"
fi

echo ""

# ─── Scenario H: HIGH fix — TOCTOU: a file changed between plan and apply is preserved ────────
echo "--- Scenario H: TOCTOU -- a file that changes between plan and apply is preserved, not deleted ---"

TOCTOU_HOME="$TMPDIR_EVAL/toctou-home"
mkdir -p "$TOCTOU_HOME"
HOME="$TOCTOU_HOME" $FA init --runtime claude-code --global --yes >/dev/null 2>&1

TOCTOU_TARGET_FILE="$TOCTOU_HOME/.claude/skills/deliver/SKILL.md"
if [[ ! -f "$TOCTOU_TARGET_FILE" ]]; then
  _fail "toctou: fixture skill deliver/SKILL.md was not installed; cannot run scenario"
else
  TOCTOU_OUT="$TMPDIR_EVAL/toctou-uninstall.out"
  # TEST-ONLY hook (see uninstall.ts main()): mutates the target file AFTER buildPlan() computed
  # the removal plan (which includes this file, matching its plan-time hash) but BEFORE apply --
  # simulating a real edit landing during the confirmation window this env var stands in for.
  HOME="$TOCTOU_HOME" FLOW_AGENTS_UNINSTALL_TEST_TOCTOU_MUTATE_FILE="$TOCTOU_TARGET_FILE" \
    $FA init --uninstall --runtime claude-code --global --yes >"$TOCTOU_OUT" 2>&1

  if [[ -f "$TOCTOU_TARGET_FILE" ]] && grep -q 'TOCTOU-test-mutation' "$TOCTOU_TARGET_FILE"; then
    _pass "toctou: file mutated between plan and apply survived with its new content intact"
  else
    _fail "toctou: file mutated between plan and apply was deleted anyway"
  fi

  if sed -n '/^Preserved/,/^$/p' "$TOCTOU_OUT" | grep -q 'skills/deliver/SKILL.md' && grep -q 're-checked immediately before removal' "$TOCTOU_OUT"; then
    _pass "toctou: report names the file as preserved due to the apply-time re-check"
  else
    _fail "toctou: report does not explain why the mutated file was preserved"
    sed -n '1,80p' "$TOCTOU_OUT"
  fi

  # An unrelated, untouched file must still have been removed normally.
  if [[ ! -e "$TOCTOU_HOME/.claude/skills/plan-work/SKILL.md" ]]; then
    _pass "toctou: an unrelated unmutated file was still removed normally"
  else
    _fail "toctou: an unrelated unmutated file was not removed"
  fi
fi

echo ""

# ─── Scenario I: HIGH fix — uninstall without confirmation deletes nothing ────────────────────
echo "--- Scenario I: Uninstall without confirmation (--yes) deletes nothing ---"

NOCONFIRM_HOME="$TMPDIR_EVAL/noconfirm-home"
mkdir -p "$NOCONFIRM_HOME"
HOME="$NOCONFIRM_HOME" $FA init --runtime claude-code --global --yes >/dev/null 2>&1

NOCONFIRM_MANIFEST="$NOCONFIRM_HOME/.claude/.flow-agents/owned-files.json"
NOCONFIRM_SETTINGS_BEFORE="$(cat "$NOCONFIRM_HOME/.claude/settings.json")"

set +e
HOME="$NOCONFIRM_HOME" $FA init --uninstall --runtime claude-code --global < /dev/null >"$TMPDIR_EVAL/noconfirm.out" 2>&1
NOCONFIRM_STATUS=$?
set -e

if [[ "$NOCONFIRM_STATUS" -ne 0 ]]; then
  _pass "no-confirm: exits non-zero when --yes/--headless is not given (got $NOCONFIRM_STATUS)"
else
  _fail "no-confirm: exited 0 without confirmation"
fi

if [[ -f "$NOCONFIRM_MANIFEST" ]]; then
  _pass "no-confirm: owned-files.json still exists (nothing was removed)"
else
  _fail "no-confirm: owned-files.json was removed without confirmation"
fi

NOCONFIRM_SETTINGS_AFTER="$(cat "$NOCONFIRM_HOME/.claude/settings.json" 2>/dev/null || echo MISSING)"
if [[ "$NOCONFIRM_SETTINGS_BEFORE" == "$NOCONFIRM_SETTINGS_AFTER" ]]; then
  _pass "no-confirm: settings.json is byte-identical to before the attempted uninstall"
else
  _fail "no-confirm: settings.json was modified without confirmation"
fi

echo ""

# ─── Scenario J: MEDIUM fix — malformed settings.json fails closed ────────────────────────────
echo "--- Scenario J: Malformed settings.json fails closed with a clear error, nothing else touched ---"

MALFORMED_SETTINGS_HOME="$TMPDIR_EVAL/malformed-settings-home"
mkdir -p "$MALFORMED_SETTINGS_HOME/.claude"
printf '{ not valid json' > "$MALFORMED_SETTINGS_HOME/.claude/settings.json"

set +e
HOME="$MALFORMED_SETTINGS_HOME" $FA init --uninstall --runtime claude-code --global --yes >"$TMPDIR_EVAL/malformed-settings.out" 2>&1
MALFORMED_SETTINGS_STATUS=$?
set -e

if [[ "$MALFORMED_SETTINGS_STATUS" -eq 2 ]]; then
  _pass "malformed-settings: fails closed with the usage/validation exit code (2)"
else
  _fail "malformed-settings: expected exit 2, got $MALFORMED_SETTINGS_STATUS"
fi

if grep -qi 'not valid json' "$TMPDIR_EVAL/malformed-settings.out"; then
  _pass "malformed-settings: error message names the JSON parse failure"
else
  _fail "malformed-settings: error message does not explain the failure"
  sed -n '1,10p' "$TMPDIR_EVAL/malformed-settings.out"
fi

if grep -q 'not valid json' "$MALFORMED_SETTINGS_HOME/.claude/settings.json"; then
  _pass "malformed-settings: the unparseable file itself was left untouched"
else
  _fail "malformed-settings: the unparseable file was modified despite failing closed"
fi

echo ""

# ─── Scenario K: MEDIUM fix — malformed manifest entry fails closed ───────────────────────────
echo "--- Scenario K: Malformed owned-files.json entry (invalid sha256) fails closed with a clear error ---"

MALFORMED_MANIFEST_HOME="$TMPDIR_EVAL/malformed-manifest-home"
mkdir -p "$MALFORMED_MANIFEST_HOME"
HOME="$MALFORMED_MANIFEST_HOME" $FA init --runtime claude-code --global --yes >/dev/null 2>&1
MALFORMED_MANIFEST_SETTINGS_BEFORE="$(cat "$MALFORMED_MANIFEST_HOME/.claude/settings.json")"

# Corrupt the sha256 of an EXISTING manifest entry in place (no new path literal needed).
node - "$MALFORMED_MANIFEST_HOME/.claude/.flow-agents/owned-files.json" << 'NODE'
const fs = require("node:fs");
const manifestPath = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.files.length === 0) throw new Error("fixture assumption broken: empty manifest");
manifest.files[0].sha256 = "not-a-real-hash";
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
NODE

set +e
HOME="$MALFORMED_MANIFEST_HOME" $FA init --uninstall --runtime claude-code --global --yes >"$TMPDIR_EVAL/malformed-manifest.out" 2>&1
MALFORMED_MANIFEST_STATUS=$?
set -e

if [[ "$MALFORMED_MANIFEST_STATUS" -eq 2 ]]; then
  _pass "malformed-manifest: fails closed with the usage/validation exit code (2)"
else
  _fail "malformed-manifest: expected exit 2, got $MALFORMED_MANIFEST_STATUS"
fi

if grep -q 'invalid sha256' "$TMPDIR_EVAL/malformed-manifest.out"; then
  _pass "malformed-manifest: error message identifies the malformed sha256"
else
  _fail "malformed-manifest: error message does not explain the failure"
  sed -n '1,10p' "$TMPDIR_EVAL/malformed-manifest.out"
fi

MALFORMED_MANIFEST_SETTINGS_AFTER="$(cat "$MALFORMED_MANIFEST_HOME/.claude/settings.json" 2>/dev/null || echo MISSING)"
if [[ "$MALFORMED_MANIFEST_SETTINGS_BEFORE" == "$MALFORMED_MANIFEST_SETTINGS_AFTER" ]]; then
  _pass "malformed-manifest: nothing was deleted or modified (whole run aborted before mutation)"
else
  _fail "malformed-manifest: settings.json was modified despite the malformed manifest entry"
fi

echo ""
echo "==========================="
total=$((pass + fail))
echo "Results: ${pass}/${total} passed, ${fail} failed"
[[ "$fail" -gt 0 ]] && exit 1
exit 0
