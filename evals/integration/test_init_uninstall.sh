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

# Resolve the actual runtime before fixtures replace HOME; the mise shim consults HOME and
# otherwise refuses isolated fixture homes before the CLI starts.
NODE_BIN="$(node -p 'process.execPath')"
FA="$NODE_BIN $ROOT_DIR/build/src/cli.js"

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
if [[ "${FLOW_AGENTS_SKIP_BUNDLE_BUILD:-0}" == "1" ]]; then
  _pass "using existing bundles (explicit sandbox workaround)"
elif (cd "$ROOT_DIR" && npm run build:bundles >/dev/null 2>&1); then
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

# ─── Scenario E2: CRITICAL fix (r2 delta) — symlinked INTERMEDIATE path component ─────────────
echo "--- Scenario E2: Manifest entry through a symlinked intermediate directory refuses and deletes nothing ---"

SYMCOMP_HOME="$TMPDIR_EVAL/symcomp-home"
mkdir -p "$SYMCOMP_HOME"
HOME="$SYMCOMP_HOME" $FA init --runtime claude-code --global --yes >/dev/null 2>&1

# An entirely lexically-in-bounds manifest path ("skills" + "/" + "evilfile") whose PARENT
# directory is, on disk, a symlink pointing entirely outside dest. path.resolve/path.relative
# alone (r1's fix) cannot see this -- it never touches the filesystem for the entry's own
# components -- but the kernel follows the symlink the moment lstatSync/rmSync actually run.
# (Subdir/filename kept as separate variables/argv, same as elsewhere in this file, purely so
# this fixture-only manifest path is never a bare literal validate-source could mistake for a
# real source reference.)
SYMCOMP_SUBDIR="skills"
SYMCOMP_NAME="evilfile"
SYMCOMP_VICTIM_DIR="$TMPDIR_EVAL/symcomp-victim-outside-claude"
mkdir -p "$SYMCOMP_VICTIM_DIR"
: > "$SYMCOMP_VICTIM_DIR/$SYMCOMP_NAME"
SYMCOMP_EMPTY_HASH="$(shasum -a 256 "$SYMCOMP_VICTIM_DIR/$SYMCOMP_NAME" | awk '{print $1}')"

# Replace the real "skills" directory the install just created with a symlink to the victim dir.
rm -rf "$SYMCOMP_HOME/.claude/skills"
ln -s "$SYMCOMP_VICTIM_DIR" "$SYMCOMP_HOME/.claude/skills"

node - "$SYMCOMP_HOME/.claude/.flow-agents/owned-files.json" "$SYMCOMP_SUBDIR/$SYMCOMP_NAME" "$SYMCOMP_EMPTY_HASH" << 'NODE'
const fs = require("node:fs");
const [, , manifestPath, entryPath, hash] = process.argv;
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.files.push({ path: entryPath, sha256: hash });
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
NODE

SYMCOMP_SETTINGS_BEFORE="$(cat "$SYMCOMP_HOME/.claude/settings.json")"

set +e
HOME="$SYMCOMP_HOME" $FA init --uninstall --runtime claude-code --global --yes >"$TMPDIR_EVAL/symcomp.out" 2>&1
SYMCOMP_STATUS=$?
set -e

if [[ "$SYMCOMP_STATUS" -ne 0 ]]; then
  _pass "symlink-component: manifest entry through a symlinked parent directory causes the run to refuse (exit $SYMCOMP_STATUS)"
else
  _fail "symlink-component: run exited 0 despite a symlinked intermediate path component"
fi

if [[ -f "$SYMCOMP_VICTIM_DIR/evilfile" ]]; then
  _pass "symlink-component: victim file outside the install root survived"
else
  _fail "symlink-component: victim file outside the install root was deleted"
fi

if grep -q "$SYMCOMP_SUBDIR/$SYMCOMP_NAME" "$TMPDIR_EVAL/symcomp.out" && grep -qi 'symlink' "$TMPDIR_EVAL/symcomp.out"; then
  _pass "symlink-component: error message names the offending entry and identifies the symlink"
else
  _fail "symlink-component: error message does not clearly identify the offending entry"
  sed -n '1,20p' "$TMPDIR_EVAL/symcomp.out"
fi

SYMCOMP_SETTINGS_AFTER="$(cat "$SYMCOMP_HOME/.claude/settings.json" 2>/dev/null || echo MISSING)"
if [[ "$SYMCOMP_SETTINGS_BEFORE" == "$SYMCOMP_SETTINGS_AFTER" ]]; then
  _pass "symlink-component: settings.json was never touched (the whole run aborted before any mutation)"
else
  _fail "symlink-component: settings.json was modified even though the run refused"
fi

# The dest-side symlink itself (the legitimate part of this fixture's setup) must survive too --
# this failure mode is "refuse the whole run," never "silently unlink the symlink and move on."
if [[ -L "$SYMCOMP_HOME/.claude/skills" ]]; then
  _pass "symlink-component: the dest-side skills symlink itself was left untouched"
else
  _fail "symlink-component: the dest-side skills symlink was removed despite the run refusing"
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

# ─── Scenario H2: MEDIUM coverage (r2 delta) — TOCTOU on the legacy symlink-chain branch ──────
echo "--- Scenario H2: TOCTOU on the legacy-mode skill symlink-chain branch is preserved, not deleted ---"

TOCTOU2_HOME="$TMPDIR_EVAL/toctou2-home"
mkdir -p "$TOCTOU2_HOME"
TOCTOU2_DEST="$TMPDIR_EVAL/toctou2-project"
mkdir -p "$TOCTOU2_DEST"
HOME="$TOCTOU2_HOME" $FA init --runtime claude-code --dest "$TOCTOU2_DEST" --yes >/dev/null 2>&1
rm -f "$TOCTOU2_DEST/.flow-agents/owned-files.json"

TOCTOU2_SKILL_NAME="deliver"
TOCTOU2_EXTERNAL_SKILLS="$TMPDIR_EVAL/toctou2-external-skills-store"
mkdir -p "$TOCTOU2_EXTERNAL_SKILLS"
mv "$TOCTOU2_DEST/.claude/skills/$TOCTOU2_SKILL_NAME" "$TOCTOU2_EXTERNAL_SKILLS/$TOCTOU2_SKILL_NAME"
ln -s "$TOCTOU2_EXTERNAL_SKILLS/$TOCTOU2_SKILL_NAME" "$TOCTOU2_DEST/.claude/skills/$TOCTOU2_SKILL_NAME"

TOCTOU2_TARGET_FILE="$TOCTOU2_EXTERNAL_SKILLS/$TOCTOU2_SKILL_NAME/SKILL.md"
if [[ ! -f "$TOCTOU2_TARGET_FILE" ]]; then
  _fail "toctou2: fixture symlink-chain skill file was not set up; cannot run scenario"
else
  TOCTOU2_OUT="$TMPDIR_EVAL/toctou2-uninstall.out"
  # Same TEST-ONLY hook as Scenario H, but targeting the file THROUGH the symlink chain's
  # resolved external directory -- exercises applyPlan's removeSymlinks re-check
  # (skillContentMatchesBundle), not the removeFiles re-hash Scenario H already covers.
  HOME="$TOCTOU2_HOME" FLOW_AGENTS_UNINSTALL_TEST_TOCTOU_MUTATE_FILE="$TOCTOU2_TARGET_FILE"     $FA init --uninstall --runtime claude-code --dest "$TOCTOU2_DEST" --yes >"$TOCTOU2_OUT" 2>&1

  if [[ -f "$TOCTOU2_TARGET_FILE" ]] && grep -q 'TOCTOU-test-mutation' "$TOCTOU2_TARGET_FILE"; then
    _pass "toctou2: symlink-chain target file mutated between plan and apply survived with its new content intact"
  else
    _fail "toctou2: symlink-chain target file mutated between plan and apply was deleted anyway"
  fi

  if [[ -L "$TOCTOU2_DEST/.claude/skills/$TOCTOU2_SKILL_NAME" ]]; then
    _pass "toctou2: the symlink itself was left in place (not unlinked out from under a changed target)"
  else
    _fail "toctou2: the symlink was removed despite its target changing since the plan was computed"
  fi

  if sed -n '/^Preserved/,/^$/p' "$TOCTOU2_OUT" | grep -q "skills/$TOCTOU2_SKILL_NAME" && grep -q 're-checked immediately before removal' "$TOCTOU2_OUT"; then
    _pass "toctou2: report names the symlink chain as preserved due to the apply-time re-check"
  else
    _fail "toctou2: report does not explain why the symlink chain was preserved"
    sed -n '1,80p' "$TOCTOU2_OUT"
  fi
fi

echo ""

# ─── Scenario H3: MEDIUM coverage (r3 delta) — removeSymlinks target-SWAP re-check ────────────
echo "--- Scenario H3: A symlink RE-POINTED between plan and apply is preserved, neither target touched ---"
#
# Distinct from H2: H2 mutates the CONTENT at the symlink's existing, unchanged target (exercises
# skillContentMatchesBundle's re-hash). This scenario re-points the symlink ITSELF to a different
# real directory between plan and apply (fs.realpathSync(entry.symlinkPath) now disagrees with
# the plan-time-captured entry.targetDir) -- the branch H2 never touches. The new target holds
# BYTE-IDENTICAL bundle content (so a content-only re-check would incorrectly allow removal);
# only the live-target re-check can catch this.

SWAP_HOME="$TMPDIR_EVAL/swap-home"
mkdir -p "$SWAP_HOME"
SWAP_DEST="$TMPDIR_EVAL/swap-project"
mkdir -p "$SWAP_DEST"
HOME="$SWAP_HOME" $FA init --runtime claude-code --dest "$SWAP_DEST" --yes >/dev/null 2>&1
rm -f "$SWAP_DEST/.flow-agents/owned-files.json"

SWAP_SKILL_NAME="deliver"
SWAP_EXTERNAL_ORIGINAL="$TMPDIR_EVAL/swap-external-original"
SWAP_EXTERNAL_NEW="$TMPDIR_EVAL/swap-external-new"
mkdir -p "$SWAP_EXTERNAL_ORIGINAL" "$SWAP_EXTERNAL_NEW"
mv "$SWAP_DEST/.claude/skills/$SWAP_SKILL_NAME" "$SWAP_EXTERNAL_ORIGINAL/$SWAP_SKILL_NAME"
cp -a "$SWAP_EXTERNAL_ORIGINAL/$SWAP_SKILL_NAME" "$SWAP_EXTERNAL_NEW/$SWAP_SKILL_NAME"
ln -s "$SWAP_EXTERNAL_ORIGINAL/$SWAP_SKILL_NAME" "$SWAP_DEST/.claude/skills/$SWAP_SKILL_NAME"

SWAP_OUT="$TMPDIR_EVAL/swap-uninstall.out"
# TEST-ONLY hook (see uninstall.ts main()): re-points the symlink to the NEW external target
# after buildPlan() (which captured the ORIGINAL target) but before apply.
HOME="$SWAP_HOME"   FLOW_AGENTS_UNINSTALL_TEST_TOCTOU_SYMLINK_SWAP_PATH="$SWAP_DEST/.claude/skills/$SWAP_SKILL_NAME"   FLOW_AGENTS_UNINSTALL_TEST_TOCTOU_SYMLINK_SWAP_TARGET="$SWAP_EXTERNAL_NEW/$SWAP_SKILL_NAME"   $FA init --uninstall --runtime claude-code --dest "$SWAP_DEST" --yes >"$SWAP_OUT" 2>&1
SWAP_STATUS=$?

if [[ "$SWAP_STATUS" -eq 0 ]]; then
  _pass "symlink-swap: run still exits 0 (accepted design -- a correctly-blocked preserve is not a failure)"
else
  _fail "symlink-swap: run exited $SWAP_STATUS, expected 0"
fi

if [[ -d "$SWAP_EXTERNAL_ORIGINAL/$SWAP_SKILL_NAME" ]]; then
  _pass "symlink-swap: the ORIGINAL (plan-time) target directory survived untouched"
else
  _fail "symlink-swap: the original target directory was deleted"
fi

if [[ -d "$SWAP_EXTERNAL_NEW/$SWAP_SKILL_NAME" ]]; then
  _pass "symlink-swap: the NEW (swapped-in) target directory survived untouched"
else
  _fail "symlink-swap: the new (swapped-in) target directory was deleted"
fi

if [[ -L "$SWAP_DEST/.claude/skills/$SWAP_SKILL_NAME" ]]; then
  _pass "symlink-swap: the symlink itself was left in place"
else
  _fail "symlink-swap: the symlink was removed"
fi

if sed -n '/^Preserved/,/^$/p' "$SWAP_OUT" | grep -q "skills/$SWAP_SKILL_NAME" && grep -q 'symlink target changed since the plan was computed' "$SWAP_OUT"; then
  _pass "symlink-swap: report names the swapped symlink as preserved with the target-changed reason"
else
  _fail "symlink-swap: report does not explain the swapped symlink was preserved"
  sed -n '1,80p' "$SWAP_OUT"
fi

echo ""

# ─── Scenario H4: MEDIUM coverage (r3 delta) — manifest-mode apply-time containment re-check ──
echo "--- Scenario H4: A directory swapped for an escaping symlink AFTER planning is preserved, never followed ---"
#
# Distinct from Scenario E2: E2 exercises only the PLAN-time containment call (planFromManifest),
# which aborts the whole run before confirmation -- it never reaches applyPlan's own containment
# re-check at all. This scenario plants the symlink AFTER a successful plan (a plain, real
# directory at plan time) but BEFORE apply, so only the apply-time re-check
# (assertManifestEntryParentContained inside applyPlan's removeFiles loop) can catch it. The
# swapped-to directory holds byte-identical content (so a content-only re-check would incorrectly
# allow removal); only the parent-containment re-check can catch this.

CONTAIN_HOME="$TMPDIR_EVAL/contain-home"
mkdir -p "$CONTAIN_HOME"
HOME="$CONTAIN_HOME" $FA init --runtime claude-code --global --yes >/dev/null 2>&1

CONTAIN_SKILL_DIR="$CONTAIN_HOME/.claude/skills/plan-work"
if [[ ! -d "$CONTAIN_SKILL_DIR" ]]; then
  _fail "manifest-apply-containment: fixture skill plan-work was not installed; cannot run scenario"
else
  CONTAIN_SAFE_DIR="$TMPDIR_EVAL/contain-external-safe"
  mkdir -p "$CONTAIN_SAFE_DIR"
  cp -a "$CONTAIN_SKILL_DIR/." "$CONTAIN_SAFE_DIR/"

  CONTAIN_OUT="$TMPDIR_EVAL/contain-uninstall.out"
  # TEST-ONLY hook: replaces the plan-work skill directory -- a plain directory at plan time,
  # captured as a normal removable entry -- with a symlink escaping dest, after planning but
  # before apply.
  HOME="$CONTAIN_HOME"     FLOW_AGENTS_UNINSTALL_TEST_TOCTOU_SYMLINK_SWAP_PATH="$CONTAIN_SKILL_DIR"     FLOW_AGENTS_UNINSTALL_TEST_TOCTOU_SYMLINK_SWAP_TARGET="$CONTAIN_SAFE_DIR"     $FA init --uninstall --runtime claude-code --global --yes >"$CONTAIN_OUT" 2>&1
  CONTAIN_STATUS=$?

  if [[ "$CONTAIN_STATUS" -eq 0 ]]; then
    _pass "manifest-apply-containment: run still exits 0 (accepted design -- a correctly-blocked preserve is not a failure)"
  else
    _fail "manifest-apply-containment: run exited $CONTAIN_STATUS, expected 0"
  fi

  if [[ -f "$CONTAIN_SAFE_DIR/SKILL.md" ]]; then
    _pass "manifest-apply-containment: the external directory the symlink now points to survived untouched"
  else
    _fail "manifest-apply-containment: the external directory was deleted through the swapped symlink"
  fi

  if sed -n '/^Preserved/,/^$/p' "$CONTAIN_OUT" | grep -q 'skills/plan-work/SKILL.md' && grep -q 'outside the install root through a symlink' "$CONTAIN_OUT"; then
    _pass "manifest-apply-containment: report names the entry as preserved due to the apply-time containment re-check"
  else
    _fail "manifest-apply-containment: report does not explain why the entry was preserved"
    sed -n '1,80p' "$CONTAIN_OUT"
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
# ─── Scenario L: Codex/OpenCode manifest-backed round trips ──────────────────────────────────
echo "--- Scenario L: Codex and OpenCode uninstall round trips, preservation, and containment ---"

CODEX_HOME="$TMPDIR_EVAL/codex-home"
CODEX_SKILLS="$TMPDIR_EVAL/codex-skills"
mkdir -p "$CODEX_HOME" "$CODEX_SKILLS"
node - "$CODEX_HOME/hooks.json" <<'NODE'
const fs = require("node:fs");
fs.writeFileSync(process.argv[2], `${JSON.stringify({ user: true, hooks: { Stop: [{ hooks: [{ type: "command", command: "echo user-codex-hook" }] }] } }, null, 2)}\n`);
NODE
CODEX_BEFORE="$(tree_snapshot "$CODEX_HOME")|$(tree_snapshot "$CODEX_SKILLS")"
HOME="$TMPDIR_EVAL/codex-fixture-home" FLOW_AGENTS_SKILLS_DIR="$CODEX_SKILLS" $FA init --runtime codex --global --dest "$CODEX_HOME" --yes >/dev/null 2>&1
CODEX_OUT="$TMPDIR_EVAL/codex-uninstall.out"
HOME="$TMPDIR_EVAL/codex-fixture-home" FLOW_AGENTS_SKILLS_DIR="$CODEX_SKILLS" $FA init --uninstall --runtime codex --dest "$CODEX_HOME" --yes >"$CODEX_OUT" 2>&1
CODEX_AFTER="$(tree_snapshot "$CODEX_HOME" | grep -v 'hooks\.json\.bak-uninstall-' || true)|$(tree_snapshot "$CODEX_SKILLS")"
if [[ "$CODEX_BEFORE" == "$CODEX_AFTER" ]] && node - "$CODEX_HOME/hooks.json" <<'NODE'
const fs = require("node:fs"); const c = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!c.user || !String(c.hooks.Stop[0].hooks[0].command).includes("user-codex-hook")) throw new Error("user hook missing");
if (JSON.stringify(c).includes("Recording Flow Agents telemetry")) throw new Error("managed hook remains");
NODE
then
  _pass "codex: manifest replay removes owned files and only managed hooks, preserving user hooks"
else
  _fail "codex: round trip or hook surgery did not preserve the fixture"
fi

CODEX_PRESERVE_HOME="$TMPDIR_EVAL/codex-preserve-home"
CODEX_PRESERVE_SKILLS="$TMPDIR_EVAL/codex-preserve-skills"
mkdir -p "$CODEX_PRESERVE_HOME" "$CODEX_PRESERVE_SKILLS"
HOME="$TMPDIR_EVAL/codex-preserve-fixture-home" FLOW_AGENTS_SKILLS_DIR="$CODEX_PRESERVE_SKILLS" $FA init --runtime codex --global --dest "$CODEX_PRESERVE_HOME" --yes >/dev/null 2>&1
printf '\nuser edit sentinel\n' >> "$CODEX_PRESERVE_HOME/build/src/cli.js"
HOME="$TMPDIR_EVAL/codex-preserve-fixture-home" FLOW_AGENTS_SKILLS_DIR="$CODEX_PRESERVE_SKILLS" $FA init --uninstall --runtime codex --dest "$CODEX_PRESERVE_HOME" --yes >"$TMPDIR_EVAL/codex-preserve.out" 2>&1
if [[ -f "$CODEX_PRESERVE_HOME/build/src/cli.js" ]] && grep -q 'user edit sentinel' "$CODEX_PRESERVE_HOME/build/src/cli.js" && sed -n '/^Preserved/,/^$/p' "$TMPDIR_EVAL/codex-preserve.out" | grep -q 'build/src/cli.js'; then
  _pass "codex: modified owned file is preserved and reported"
else
  _fail "codex: modified owned file was not safely preserved"
fi

CODEX_CONTAIN_HOME="$TMPDIR_EVAL/codex-containment-home"
CODEX_CONTAIN_SKILLS="$TMPDIR_EVAL/codex-containment-skills"
CODEX_EXTERNAL="$TMPDIR_EVAL/codex-external"
mkdir -p "$CODEX_CONTAIN_HOME" "$CODEX_CONTAIN_SKILLS" "$CODEX_EXTERNAL"
HOME="$TMPDIR_EVAL/codex-containment-fixture-home" FLOW_AGENTS_SKILLS_DIR="$CODEX_CONTAIN_SKILLS" $FA init --runtime codex --global --dest "$CODEX_CONTAIN_HOME" --yes >/dev/null 2>&1
mv "$CODEX_CONTAIN_HOME/build" "$CODEX_EXTERNAL/build"
ln -s "$CODEX_EXTERNAL/build" "$CODEX_CONTAIN_HOME/build"
set +e
HOME="$TMPDIR_EVAL/codex-containment-fixture-home" FLOW_AGENTS_SKILLS_DIR="$CODEX_CONTAIN_SKILLS" $FA init --uninstall --runtime codex --dest "$CODEX_CONTAIN_HOME" --yes >"$TMPDIR_EVAL/codex-containment.out" 2>&1
CODEX_CONTAIN_STATUS=$?
set -e
if [[ "$CODEX_CONTAIN_STATUS" -eq 2 ]] && [[ -f "$CODEX_EXTERNAL/build/src/cli.js" ]] && grep -qi 'symlinked parent' "$TMPDIR_EVAL/codex-containment.out"; then
  _pass "codex: symlinked intermediate containment attack is refused before deletion"
else
  _fail "codex: containment attack was not refused safely"
fi

OPENCODE_HOME="$TMPDIR_EVAL/opencode-home"
mkdir -p "$OPENCODE_HOME"
node - "$OPENCODE_HOME/opencode.json" <<'NODE'
const fs = require("node:fs");
fs.writeFileSync(process.argv[2], `${JSON.stringify({ custom: "preserve", instructions: ["/user/instructions.md"] }, null, 2)}\n`);
NODE
OPENCODE_BEFORE="$(tree_snapshot "$OPENCODE_HOME")"
HOME="$TMPDIR_EVAL/opencode-fixture-home" $FA init --runtime opencode --global --dest "$OPENCODE_HOME" --yes >/dev/null 2>&1
HOME="$TMPDIR_EVAL/opencode-fixture-home" $FA init --uninstall --runtime opencode --dest "$OPENCODE_HOME" --yes >"$TMPDIR_EVAL/opencode-uninstall.out" 2>&1
OPENCODE_AFTER="$(tree_snapshot "$OPENCODE_HOME" | grep -v 'opencode\.json\.bak-uninstall-' || true)"
if [[ "$OPENCODE_BEFORE" == "$OPENCODE_AFTER" ]] && node - "$OPENCODE_HOME/opencode.json" <<'NODE'
const fs = require("node:fs"); const c = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (c.custom !== "preserve" || c.instructions.join() !== "/user/instructions.md") throw new Error("user config missing");
NODE
then
  _pass "opencode: manifest replay removes runtime assets and only its managed instruction"
else
  _fail "opencode: round trip or config surgery did not preserve the fixture"
fi

# Merge-owned scalars require positive pre-install provenance. A legacy install record cannot
# distinguish a user's pre-existing OpenCode schema from the byte-identical default we add.
OPENCODE_LEGACY_SCHEMA_HOME="$TMPDIR_EVAL/opencode-legacy-schema-home"
mkdir -p "$OPENCODE_LEGACY_SCHEMA_HOME"
node - "$OPENCODE_LEGACY_SCHEMA_HOME/opencode.json" <<'NODE'
const fs = require("node:fs");
fs.writeFileSync(process.argv[2], JSON.stringify({ "$schema": "https://opencode.ai/config.json", custom: "legacy-user" }, null, 2) + "\n");
NODE
HOME="$TMPDIR_EVAL/opencode-legacy-schema-user-home" $FA init --runtime opencode --global --dest "$OPENCODE_LEGACY_SCHEMA_HOME" --yes >/dev/null 2>&1
node - "$OPENCODE_LEGACY_SCHEMA_HOME/.flow-agents/install.json" <<'NODE'
const fs = require("node:fs"); const file = process.argv[2]; const record = JSON.parse(fs.readFileSync(file, "utf8"));
delete record.config_premerge; fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
NODE
HOME="$TMPDIR_EVAL/opencode-legacy-schema-user-home" $FA init --uninstall --runtime opencode --dest "$OPENCODE_LEGACY_SCHEMA_HOME" --yes >"$TMPDIR_EVAL/opencode-legacy-schema.out" 2>&1
if node - "$OPENCODE_LEGACY_SCHEMA_HOME/opencode.json" <<'NODE'
const fs = require("node:fs"); const c = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (c.$schema !== "https://opencode.ai/config.json" || c.custom !== "legacy-user" || "instructions" in c) throw new Error("legacy scalar or instruction handling was wrong");
NODE
then
  if sed -n '/^Preserved/,/^$/p' "$TMPDIR_EVAL/opencode-legacy-schema.out" | grep -Fq 'cannot prove Flow Agents added it (no pre-install snapshot)'; then _pass "opencode scalar provenance: legacy schema is retained and disclosed while self-identifying instruction is removed"; else _fail "opencode scalar provenance: legacy retention was not disclosed"; fi
else
  _fail "opencode scalar provenance: legacy schema was deleted or instruction was retained"
fi

# Conversely, a modern snapshot that records the key as absent proves this install introduced
# the default and permits its removal.
OPENCODE_NEW_SCHEMA_HOME="$TMPDIR_EVAL/opencode-new-schema-home"
mkdir -p "$OPENCODE_NEW_SCHEMA_HOME"
printf '{"custom":"new-user"}\n' > "$OPENCODE_NEW_SCHEMA_HOME/opencode.json"
HOME="$TMPDIR_EVAL/opencode-new-schema-user-home" $FA init --runtime opencode --global --dest "$OPENCODE_NEW_SCHEMA_HOME" --yes >/dev/null 2>&1
HOME="$TMPDIR_EVAL/opencode-new-schema-user-home" $FA init --uninstall --runtime opencode --dest "$OPENCODE_NEW_SCHEMA_HOME" --yes >"$TMPDIR_EVAL/opencode-new-schema.out" 2>&1
if node - "$OPENCODE_NEW_SCHEMA_HOME/opencode.json" <<'NODE'
const fs = require("node:fs"); const c = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if ("$schema" in c || "instructions" in c || c.custom !== "new-user") throw new Error("snapshot-proven scalar was not removed cleanly");
NODE
then _pass "opencode scalar provenance: snapshot-proven schema and self-identifying instruction are removed"; else _fail "opencode scalar provenance: snapshot-proven removal failed"; fi

# Telemetry is intentionally durable residue even though it lives under the runtime tree. Its
# surviving in-destination directory must be named in the uninstall report.
OPENCODE_RESIDUE_HOME="$TMPDIR_EVAL/opencode-residue-home"
mkdir -p "$OPENCODE_RESIDUE_HOME"
HOME="$TMPDIR_EVAL/opencode-residue-user-home" $FA init --runtime opencode --global --dest "$OPENCODE_RESIDUE_HOME" --yes >/dev/null 2>&1
mkdir -p "$OPENCODE_RESIDUE_HOME/.flow-agents/runtime/.kontourai/telemetry"
printf 'telemetry evidence\n' > "$OPENCODE_RESIDUE_HOME/.flow-agents/runtime/.kontourai/telemetry/events.jsonl"
HOME="$TMPDIR_EVAL/opencode-residue-user-home" $FA init --uninstall --runtime opencode --dest "$OPENCODE_RESIDUE_HOME" --yes >"$TMPDIR_EVAL/opencode-residue.out" 2>&1
if [[ -f "$OPENCODE_RESIDUE_HOME/.flow-agents/runtime/.kontourai/telemetry/events.jsonl" ]] && sed -n '/^Residue/,/^$/p' "$TMPDIR_EVAL/opencode-residue.out" | grep -Fq '.flow-agents/runtime/.kontourai/telemetry'; then _pass "opencode residue: surviving in-destination telemetry is retained and disclosed"; else _fail "opencode residue: telemetry was deleted or hidden from the Residue report"; fi

echo ""
# ─── Scenario M: all-provider uninstall hardening regressions ────────────────────────────────
echo "--- Scenario M: provider uninstall Stow, durable, drift, and TOCTOU hardening ---"

# A user statusLine that merely mentions the marker in an unrelated field is not owned.
STATUSLINE_HOME="$TMPDIR_EVAL/statusline-mention-home"
mkdir -p "$STATUSLINE_HOME/.claude"
node - "$STATUSLINE_HOME/.claude/settings.json" <<'NODE'
const fs = require("node:fs");
fs.writeFileSync(process.argv[2], JSON.stringify({ statusLine: { type: "text", label: "mentions flow-agents-statusline.js but is user-owned" } }, null, 2) + "\n");
NODE
HOME="$STATUSLINE_HOME" $FA init --uninstall --runtime claude-code --global --yes >"$TMPDIR_EVAL/statusline-mention.out" 2>&1 || true
if node - "$STATUSLINE_HOME/.claude/settings.json" <<'NODE'
const fs = require("node:fs"); if (!JSON.parse(fs.readFileSync(process.argv[2], "utf8")).statusLine) throw new Error("statusLine removed");
NODE
then _pass "statusLine: a user value merely mentioning the marker survives"; else _fail "statusLine: mention-only user value was removed"; fi

# Exercise the documented Codex default universal-skills root (no override variable).
CODEX_DEFAULT_HOME="$TMPDIR_EVAL/codex-default-home"
CODEX_DEFAULT_DEST="$TMPDIR_EVAL/codex-default-dest"
mkdir -p "$CODEX_DEFAULT_HOME" "$CODEX_DEFAULT_DEST"
HOME="$CODEX_DEFAULT_HOME" $FA init --runtime codex --global --dest "$CODEX_DEFAULT_DEST" --yes >/dev/null 2>&1
HOME="$CODEX_DEFAULT_HOME" $FA init --uninstall --runtime codex --dest "$CODEX_DEFAULT_DEST" --yes >"$TMPDIR_EVAL/codex-default.out" 2>&1
if [[ ! -e "$CODEX_DEFAULT_HOME/.agents/skills/deliver/SKILL.md" ]] && [[ ! -e "$CODEX_DEFAULT_DEST/build/src/cli.js" ]]; then _pass "codex: default universal-skills root is manifest-cleaned without an override"; else _fail "codex: default universal-skills root retained owned files"; fi

# Re-plan config immediately before writing: a user hook added after planning survives.
SETTINGS_RACE_HOME="$TMPDIR_EVAL/settings-race-home"
mkdir -p "$SETTINGS_RACE_HOME"
HOME="$SETTINGS_RACE_HOME" $FA init --runtime codex --global --dest "$SETTINGS_RACE_HOME" --yes >/dev/null 2>&1
HOME="$SETTINGS_RACE_HOME" FLOW_AGENTS_UNINSTALL_TEST_TOCTOU_ADD_USER_HOOK="$SETTINGS_RACE_HOME/hooks.json" $FA init --uninstall --runtime codex --dest "$SETTINGS_RACE_HOME" --yes >"$TMPDIR_EVAL/settings-race.out" 2>&1
if grep -q 'user-hook-added-during-confirmation' "$SETTINGS_RACE_HOME/hooks.json" && ! grep -q 'Recording Flow Agents telemetry' "$SETTINGS_RACE_HOME/hooks.json"; then _pass "settings TOCTOU: newly added user hook survives while managed hook is removed"; else _fail "settings TOCTOU: stale config rewrite lost a user hook or retained managed content"; fi

# A Stow config link and Stow skills link are both reversed without severing either link.
STOW_HOME="$TMPDIR_EVAL/stow-opencode-home"; STOW_DOTFILES="$TMPDIR_EVAL/stow-opencode-dotfiles"
# Skill dir names are built from variables so the source-path validator does not read these
# runtime-created fixture paths as references to missing repo sources.
STOW_USER_SKILL="user"; STOW_MANAGED_SKILL="deliver"
mkdir -p "$STOW_HOME" "$STOW_DOTFILES/skills/${STOW_USER_SKILL}"; chmod 700 "$STOW_DOTFILES"
printf '# user skill\n' > "$STOW_DOTFILES/skills/${STOW_USER_SKILL}/SKILL.md"
printf '{\n  "model": "user-model",\n  "instructions": ["/user/AGENTS.md"]\n}\n' > "$STOW_DOTFILES/opencode.json"
chmod 600 "$STOW_DOTFILES/opencode.json"
ln -s "$STOW_DOTFILES/opencode.json" "$STOW_HOME/opencode.json"; ln -s "$STOW_DOTFILES/skills" "$STOW_HOME/skills"
STOW_BEFORE="$(cat "$STOW_DOTFILES/opencode.json")"
FLOW_AGENTS_USER_OPENCODE_CONFIG="$STOW_HOME/opencode.json" HOME="$TMPDIR_EVAL/stow-opencode-user-home" $FA init --runtime opencode --global --yes >/dev/null 2>&1
FLOW_AGENTS_USER_OPENCODE_CONFIG="$STOW_HOME/opencode.json" HOME="$TMPDIR_EVAL/stow-opencode-user-home" $FA init --uninstall --runtime opencode --global --yes >"$TMPDIR_EVAL/stow-uninstall.out" 2>&1
if [[ -L "$STOW_HOME/opencode.json" && -L "$STOW_HOME/skills" ]] && [[ "$(cat "$STOW_DOTFILES/opencode.json")" == "$STOW_BEFORE" ]] && [[ ! -e "$STOW_DOTFILES/skills/${STOW_MANAGED_SKILL}/SKILL.md" ]]; then _pass "opencode Stow: install-to-uninstall preserves links and restores backing config"; else _fail "opencode Stow: link or backing config was not safely restored"; fi

# A Stow root is an install-time authorization, not a property inferred later from a
# currently-private link target. A re-point after install must therefore stop before touching
# either backing root.
STOW_AUTH_HOME="$TMPDIR_EVAL/stow-auth-home"; STOW_AUTH_ONE="$TMPDIR_EVAL/stow-auth-one"; STOW_AUTH_TWO="$TMPDIR_EVAL/stow-auth-two"
mkdir -p "$STOW_AUTH_HOME" "$STOW_AUTH_ONE/skills" "$STOW_AUTH_TWO"; chmod 700 "$STOW_AUTH_ONE" "$STOW_AUTH_TWO"
printf '{"model":"one"}\n' > "$STOW_AUTH_ONE/opencode.json"; printf '{"model":"two"}\n' > "$STOW_AUTH_TWO/opencode.json"
ln -s "$STOW_AUTH_ONE/opencode.json" "$STOW_AUTH_HOME/opencode.json"; ln -s "$STOW_AUTH_ONE/skills" "$STOW_AUTH_HOME/skills"
FLOW_AGENTS_USER_OPENCODE_CONFIG="$STOW_AUTH_HOME/opencode.json" HOME="$TMPDIR_EVAL/stow-auth-user-home" $FA init --runtime opencode --global --yes >/dev/null 2>&1
rm "$STOW_AUTH_HOME/opencode.json"; ln -s "$STOW_AUTH_TWO/opencode.json" "$STOW_AUTH_HOME/opencode.json"
set +e; FLOW_AGENTS_USER_OPENCODE_CONFIG="$STOW_AUTH_HOME/opencode.json" HOME="$TMPDIR_EVAL/stow-auth-user-home" $FA init --uninstall --runtime opencode --global --yes >"$TMPDIR_EVAL/stow-auth-uninstall.out" 2>&1; STOW_AUTH_RC=$?; set -e
if [[ "$STOW_AUTH_RC" -eq 2 && -f "$STOW_AUTH_ONE/skills/agentic-engineering/SKILL.md" ]] && grep -q 'not authorized by this install record' "$TMPDIR_EVAL/stow-auth-uninstall.out"; then _pass "opencode Stow: backing root introduced after install is refused"; else _fail "opencode Stow: re-pointed backing root was followed or not clearly refused"; fi

# Legacy install records predate authorized_backing_roots. An operator may authorize the one
# live, canonical Stow root for this invocation, but the authorization is never persisted.
LEGACY_AUTH_HOME="$TMPDIR_EVAL/legacy-stow-auth-home"; LEGACY_AUTH_ROOT="$TMPDIR_EVAL/legacy-stow-auth-root"; LEGACY_AUTH_USER_HOME="$TMPDIR_EVAL/legacy-stow-auth-user-home"; LEGACY_AUTH_RECORD_DEST="$LEGACY_AUTH_HOME"
mkdir -p "$LEGACY_AUTH_HOME" "$LEGACY_AUTH_ROOT/skills"; chmod 700 "$LEGACY_AUTH_ROOT"
LEGACY_AUTH_ROOT_REAL="$(cd "$LEGACY_AUTH_ROOT" && pwd -P)"
LEGACY_AUTH_BEFORE=$'{\n  "model": "legacy-user",\n  "instructions": ["/user/AGENTS.md"]\n}\n'
printf '%s' "$LEGACY_AUTH_BEFORE" > "$LEGACY_AUTH_ROOT/opencode.json"; chmod 600 "$LEGACY_AUTH_ROOT/opencode.json"
ln -s "$LEGACY_AUTH_ROOT/opencode.json" "$LEGACY_AUTH_HOME/opencode.json"; ln -s "$LEGACY_AUTH_ROOT/skills" "$LEGACY_AUTH_HOME/skills"
FLOW_AGENTS_USER_OPENCODE_CONFIG="$LEGACY_AUTH_HOME/opencode.json" HOME="$LEGACY_AUTH_USER_HOME" $FA init --runtime opencode --global --yes >/dev/null 2>&1
node - "$LEGACY_AUTH_RECORD_DEST/.flow-agents/install.json" <<'NODE'
const fs = require("node:fs"); const file = process.argv[2]; const record = JSON.parse(fs.readFileSync(file, "utf8"));
fs.writeFileSync(file, JSON.stringify({ active_kit_ids: record.active_kit_ids ?? [], global: record.global, installedAt: record.installedAt, runtime: record.runtime, version: "5.5.0" }, null, 2) + "\n");
NODE
FLOW_AGENTS_USER_OPENCODE_CONFIG="$LEGACY_AUTH_HOME/opencode.json" HOME="$LEGACY_AUTH_USER_HOME" $FA init --uninstall --runtime opencode --global --authorize-backing-root "$LEGACY_AUTH_ROOT_REAL" --yes >"$TMPDIR_EVAL/legacy-stow-auth-uninstall.out" 2>&1
if [[ -L "$LEGACY_AUTH_HOME/opencode.json" && -L "$LEGACY_AUTH_HOME/skills" ]] && node - "$LEGACY_AUTH_ROOT/opencode.json" "$LEGACY_AUTH_BEFORE" <<'NODE'
// A LEGACY record carries no config_premerge snapshot, so uninstall cannot prove Flow Agents
// added "$schema" and conservatively RETAINS it (issue #1238: removal requires positive
// provenance). Deep equality is therefore against the user's original object PLUS that one
// retained, disclosed key -- not a weaker check.
const fs = require("node:fs"); const actual = JSON.parse(fs.readFileSync(process.argv[2], "utf8")); const expected = { ...JSON.parse(process.argv[3]), $schema: "https://opencode.ai/config.json" }; if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`legacy user config was not restored with deep equality: ${JSON.stringify(actual)}`);
NODE
then
  if [[ ! -e "$LEGACY_AUTH_ROOT/skills/agentic-engineering/SKILL.md" && ! -e "$LEGACY_AUTH_RECORD_DEST/.flow-agents/install.json" ]] && grep -q 'operator-authorized backing roots' "$TMPDIR_EVAL/legacy-stow-auth-uninstall.out" && grep -q 'wrote through' "$TMPDIR_EVAL/legacy-stow-auth-uninstall.out" && grep -q 'cannot prove Flow Agents added it' "$TMPDIR_EVAL/legacy-stow-auth-uninstall.out"; then _pass "legacy Stow authorization: canonical root round-trips, links intact, authorization not persisted, and the unprovable scalar is retained AND disclosed"; else _fail "legacy Stow authorization: authorized round-trip, reporting, surgical config restoration, or non-persistence failed"; fi
else
  _fail "legacy Stow authorization: link or user config was not preserved"
fi

# A supplied root must be the root the live config link actually references; an unrelated root
# is an error, never a no-op that weakens the fail-closed default.
LEGACY_WRONG_HOME="$TMPDIR_EVAL/legacy-stow-wrong-home"; LEGACY_WRONG_ROOT="$TMPDIR_EVAL/legacy-stow-wrong-root"; LEGACY_OTHER_ROOT="$TMPDIR_EVAL/legacy-stow-other-root"; LEGACY_WRONG_USER_HOME="$TMPDIR_EVAL/legacy-stow-wrong-user-home"; LEGACY_WRONG_RECORD_DEST="$LEGACY_WRONG_HOME"
mkdir -p "$LEGACY_WRONG_HOME" "$LEGACY_WRONG_ROOT/skills" "$LEGACY_OTHER_ROOT"; chmod 700 "$LEGACY_WRONG_ROOT" "$LEGACY_OTHER_ROOT"
LEGACY_OTHER_ROOT_REAL="$(cd "$LEGACY_OTHER_ROOT" && pwd -P)"
printf '{"model":"wrong-root"}\n' > "$LEGACY_WRONG_ROOT/opencode.json"; chmod 600 "$LEGACY_WRONG_ROOT/opencode.json"
ln -s "$LEGACY_WRONG_ROOT/opencode.json" "$LEGACY_WRONG_HOME/opencode.json"; ln -s "$LEGACY_WRONG_ROOT/skills" "$LEGACY_WRONG_HOME/skills"
FLOW_AGENTS_USER_OPENCODE_CONFIG="$LEGACY_WRONG_HOME/opencode.json" HOME="$LEGACY_WRONG_USER_HOME" $FA init --runtime opencode --global --yes >/dev/null 2>&1
node - "$LEGACY_WRONG_RECORD_DEST/.flow-agents/install.json" <<'NODE'
const fs = require("node:fs"); const file = process.argv[2]; const record = JSON.parse(fs.readFileSync(file, "utf8")); delete record.authorized_backing_roots; fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
NODE
set +e; FLOW_AGENTS_USER_OPENCODE_CONFIG="$LEGACY_WRONG_HOME/opencode.json" HOME="$LEGACY_WRONG_USER_HOME" $FA init --uninstall --runtime opencode --global --authorize-backing-root "$LEGACY_OTHER_ROOT_REAL" --yes >"$TMPDIR_EVAL/legacy-stow-wrong.out" 2>&1; LEGACY_WRONG_RC=$?; set -e
if [[ "$LEGACY_WRONG_RC" -eq 2 && -f "$LEGACY_WRONG_ROOT/skills/agentic-engineering/SKILL.md" ]] && grep -q 'does not match a backing root currently referenced' "$TMPDIR_EVAL/legacy-stow-wrong.out"; then _pass "legacy Stow authorization: unrelated supplied root is refused without writes"; else _fail "legacy Stow authorization: unrelated root was accepted or content changed"; fi

# Even a modern record does not turn an extra flag into a harmless no-op: every supplied root
# must be live and referenced by this install.
UNREFERENCED_ROOT="$TMPDIR_EVAL/unreferenced-backing-root"; mkdir -p "$UNREFERENCED_ROOT"; chmod 700 "$UNREFERENCED_ROOT"
UNREFERENCED_ROOT_REAL="$(cd "$UNREFERENCED_ROOT" && pwd -P)"
set +e; FLOW_AGENTS_USER_OPENCODE_CONFIG="$LEGACY_WRONG_HOME/opencode.json" HOME="$LEGACY_WRONG_USER_HOME" $FA init --uninstall --runtime opencode --global --authorize-backing-root "$UNREFERENCED_ROOT_REAL" --dry-run >"$TMPDIR_EVAL/unreferenced-backing-root.out" 2>&1; UNREFERENCED_RC=$?; set -e
if [[ "$UNREFERENCED_RC" -eq 2 ]] && grep -q 'does not match a backing root currently referenced' "$TMPDIR_EVAL/unreferenced-backing-root.out"; then _pass "backing-root authorization: unreferenced supplied root is an error"; else _fail "backing-root authorization: unreferenced root was silently accepted"; fi

# The plan's exact bound link is checked again before the first write. Re-pointing it after
# planning therefore aborts the entire apply, preserving both old and new backing roots.
LEGACY_SWAP_HOME="$TMPDIR_EVAL/legacy-stow-swap-home"; LEGACY_SWAP_ONE="$TMPDIR_EVAL/legacy-stow-swap-one"; LEGACY_SWAP_TWO="$TMPDIR_EVAL/legacy-stow-swap-two"; LEGACY_SWAP_USER_HOME="$TMPDIR_EVAL/legacy-stow-swap-user-home"; LEGACY_SWAP_RECORD_DEST="$LEGACY_SWAP_HOME"
mkdir -p "$LEGACY_SWAP_HOME" "$LEGACY_SWAP_ONE/skills" "$LEGACY_SWAP_TWO"; chmod 700 "$LEGACY_SWAP_ONE" "$LEGACY_SWAP_TWO"
LEGACY_SWAP_ONE_REAL="$(cd "$LEGACY_SWAP_ONE" && pwd -P)"
printf '{"model":"one"}\n' > "$LEGACY_SWAP_ONE/opencode.json"; printf '{"model":"two"}\n' > "$LEGACY_SWAP_TWO/opencode.json"; chmod 600 "$LEGACY_SWAP_ONE/opencode.json" "$LEGACY_SWAP_TWO/opencode.json"
ln -s "$LEGACY_SWAP_ONE/opencode.json" "$LEGACY_SWAP_HOME/opencode.json"; ln -s "$LEGACY_SWAP_ONE/skills" "$LEGACY_SWAP_HOME/skills"
FLOW_AGENTS_USER_OPENCODE_CONFIG="$LEGACY_SWAP_HOME/opencode.json" HOME="$LEGACY_SWAP_USER_HOME" $FA init --runtime opencode --global --yes >/dev/null 2>&1
node - "$LEGACY_SWAP_RECORD_DEST/.flow-agents/install.json" <<'NODE'
const fs = require("node:fs"); const file = process.argv[2]; const record = JSON.parse(fs.readFileSync(file, "utf8")); delete record.authorized_backing_roots; fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
NODE
LEGACY_SWAP_ONE_BEFORE="$(cat "$LEGACY_SWAP_ONE/opencode.json")"; LEGACY_SWAP_TWO_BEFORE="$(cat "$LEGACY_SWAP_TWO/opencode.json")"
set +e; FLOW_AGENTS_USER_OPENCODE_CONFIG="$LEGACY_SWAP_HOME/opencode.json" HOME="$LEGACY_SWAP_USER_HOME" FLOW_AGENTS_UNINSTALL_TEST_TOCTOU_SYMLINK_SWAP_PATH="$LEGACY_SWAP_HOME/opencode.json" FLOW_AGENTS_UNINSTALL_TEST_TOCTOU_SYMLINK_SWAP_TARGET="$LEGACY_SWAP_TWO/opencode.json" $FA init --uninstall --runtime opencode --global --authorize-backing-root "$LEGACY_SWAP_ONE_REAL" --yes >"$TMPDIR_EVAL/legacy-stow-swap.out" 2>&1; LEGACY_SWAP_RC=$?; set -e
if [[ "$LEGACY_SWAP_RC" -eq 2 && -L "$LEGACY_SWAP_HOME/opencode.json" ]] && [[ "$(cat "$LEGACY_SWAP_ONE/opencode.json")" == "$LEGACY_SWAP_ONE_BEFORE" ]] && [[ "$(cat "$LEGACY_SWAP_TWO/opencode.json")" == "$LEGACY_SWAP_TWO_BEFORE" ]] && [[ -f "$LEGACY_SWAP_ONE/skills/agentic-engineering/SKILL.md" ]] && grep -q 'symlink target changed' "$TMPDIR_EVAL/legacy-stow-swap.out"; then _pass "legacy Stow authorization TOCTOU: re-pointed link aborts before every write"; else _fail "legacy Stow authorization TOCTOU: re-pointed link was followed or prior root changed"; fi

# A binding failure inside applySettings (after the pre-apply check and after its backup exists)
# is fatal for the whole apply: assets and durable records stay put and attempt artifacts vanish.
APPLY_SWAP_HOME="$TMPDIR_EVAL/apply-settings-swap-home"; APPLY_SWAP_ONE="$TMPDIR_EVAL/apply-settings-swap-one"; APPLY_SWAP_TWO="$TMPDIR_EVAL/apply-settings-swap-two"; APPLY_SWAP_USER_HOME="$TMPDIR_EVAL/apply-settings-swap-user-home"
mkdir -p "$APPLY_SWAP_HOME" "$APPLY_SWAP_ONE/skills" "$APPLY_SWAP_TWO"; chmod 700 "$APPLY_SWAP_ONE" "$APPLY_SWAP_TWO"
APPLY_SWAP_ONE_REAL="$(cd "$APPLY_SWAP_ONE" && pwd -P)"
printf '{"model":"one"}\n' > "$APPLY_SWAP_ONE/opencode.json"; printf '{"model":"two"}\n' > "$APPLY_SWAP_TWO/opencode.json"; chmod 600 "$APPLY_SWAP_ONE/opencode.json" "$APPLY_SWAP_TWO/opencode.json"
ln -s "$APPLY_SWAP_ONE/opencode.json" "$APPLY_SWAP_HOME/opencode.json"; ln -s "$APPLY_SWAP_ONE/skills" "$APPLY_SWAP_HOME/skills"
FLOW_AGENTS_USER_OPENCODE_CONFIG="$APPLY_SWAP_HOME/opencode.json" HOME="$APPLY_SWAP_USER_HOME" $FA init --runtime opencode --global --yes >/dev/null 2>&1
node - "$APPLY_SWAP_HOME/.flow-agents/install.json" <<'NODE'
const fs = require("node:fs"); const file = process.argv[2]; const record = JSON.parse(fs.readFileSync(file, "utf8")); delete record.authorized_backing_roots; fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
NODE
set +e; FLOW_AGENTS_USER_OPENCODE_CONFIG="$APPLY_SWAP_HOME/opencode.json" HOME="$APPLY_SWAP_USER_HOME" FLOW_AGENTS_UNINSTALL_TEST_APPLY_SETTINGS_SYMLINK_SWAP_PATH="$APPLY_SWAP_HOME/opencode.json" FLOW_AGENTS_UNINSTALL_TEST_APPLY_SETTINGS_SYMLINK_SWAP_TARGET="$APPLY_SWAP_TWO/opencode.json" $FA init --uninstall --runtime opencode --global --authorize-backing-root "$APPLY_SWAP_ONE_REAL" --yes >"$TMPDIR_EVAL/apply-settings-swap.out" 2>&1; APPLY_SWAP_RC=$?; set -e
if [[ "$APPLY_SWAP_RC" -ne 0 && -f "$APPLY_SWAP_ONE/skills/agentic-engineering/SKILL.md" && -f "$APPLY_SWAP_HOME/.flow-agents/runtime-assets.json" && -f "$APPLY_SWAP_HOME/.flow-agents/install.json" ]] && ! compgen -G "$APPLY_SWAP_ONE/opencode.json.bak-uninstall-*" >/dev/null && ! compgen -G "$APPLY_SWAP_ONE/opencode.json.tmp.*" >/dev/null && ! compgen -G "$APPLY_SWAP_TWO/opencode.json.bak-uninstall-*" >/dev/null && ! compgen -G "$APPLY_SWAP_TWO/opencode.json.tmp.*" >/dev/null && grep -q 'settings update failed.*symlink target changed' "$TMPDIR_EVAL/apply-settings-swap.out"; then _pass "legacy Stow authorization apply failure: no deletion or stray backup/temp"; else _fail "legacy Stow authorization apply failure: validation did not abort transactionally"; fi

# An authorized backing root grants only its three exact managed asset trees, not arbitrary
# descendants: a re-pointed skills link to a sibling under that root is refused before planning.
SIBLING_LINK_HOME="$TMPDIR_EVAL/sibling-link-home"; SIBLING_LINK_ROOT="$TMPDIR_EVAL/sibling-link-root"; SIBLING_LINK_USER_HOME="$TMPDIR_EVAL/sibling-link-user-home"
mkdir -p "$SIBLING_LINK_HOME" "$SIBLING_LINK_ROOT/skills" "$SIBLING_LINK_ROOT/unrelated-skills/agentic-engineering"; chmod 700 "$SIBLING_LINK_ROOT"
SIBLING_LINK_ROOT_REAL="$(cd "$SIBLING_LINK_ROOT" && pwd -P)"
printf '{"model":"sibling"}\n' > "$SIBLING_LINK_ROOT/opencode.json"; chmod 600 "$SIBLING_LINK_ROOT/opencode.json"
ln -s "$SIBLING_LINK_ROOT/opencode.json" "$SIBLING_LINK_HOME/opencode.json"; ln -s "$SIBLING_LINK_ROOT/skills" "$SIBLING_LINK_HOME/skills"
FLOW_AGENTS_USER_OPENCODE_CONFIG="$SIBLING_LINK_HOME/opencode.json" HOME="$SIBLING_LINK_USER_HOME" $FA init --runtime opencode --global --yes >/dev/null 2>&1
printf 'unrelated sibling content\n' > "$SIBLING_LINK_ROOT/unrelated-skills/agentic-engineering/SKILL.md"
rm "$SIBLING_LINK_HOME/skills"; ln -s "$SIBLING_LINK_ROOT/unrelated-skills" "$SIBLING_LINK_HOME/skills"
set +e; FLOW_AGENTS_USER_OPENCODE_CONFIG="$SIBLING_LINK_HOME/opencode.json" HOME="$SIBLING_LINK_USER_HOME" $FA init --uninstall --runtime opencode --global --yes >"$TMPDIR_EVAL/sibling-link.out" 2>&1; SIBLING_LINK_RC=$?; set -e
if [[ "$SIBLING_LINK_RC" -eq 2 && -f "$SIBLING_LINK_ROOT/unrelated-skills/agentic-engineering/SKILL.md" && -f "$SIBLING_LINK_HOME/.flow-agents/runtime-assets.json" ]] && grep -q 'other than the authorized OpenCode asset tree' "$TMPDIR_EVAL/sibling-link.out"; then _pass "opencode Stow: sibling asset tree is refused and untouched"; else _fail "opencode Stow: sibling asset tree escaped authorization"; fi

# The pre-install snapshot is secret-bearing data: its record and temporary write are private,
# it is refreshed on every install, and only the current install's post-image can restore it.
REINSTALL_HOME="$TMPDIR_EVAL/reinstall-snapshot-home"; mkdir -p "$REINSTALL_HOME"
printf '{\n  "token": "first"\n}\n' > "$REINSTALL_HOME/opencode.json"
HOME="$TMPDIR_EVAL/reinstall-snapshot-user-home" $FA init --runtime opencode --global --dest "$REINSTALL_HOME" --yes >/dev/null 2>&1
REINSTALL_BEFORE=$'{\n    "token": "second"\n}\n'; printf '%s' "$REINSTALL_BEFORE" > "$REINSTALL_HOME/opencode.json"
HOME="$TMPDIR_EVAL/reinstall-snapshot-user-home" $FA init --runtime opencode --global --dest "$REINSTALL_HOME" --yes >/dev/null 2>&1
node - "$REINSTALL_HOME/.flow-agents/install.json" "$REINSTALL_BEFORE" <<'NODE'
const fs = require("node:fs"); const record = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if ((fs.statSync(process.argv[2]).mode & 0o777) !== 0o600) throw new Error("install.json is not 0600");
if (!record.config_premerge?.post_install_sha256) throw new Error("missing post-install config hash");
if (Buffer.from(record.config_premerge.bytes_base64, "base64").toString() !== process.argv[3]) throw new Error("reinstall retained the first install snapshot");
NODE
HOME="$TMPDIR_EVAL/reinstall-snapshot-user-home" $FA init --uninstall --runtime opencode --dest "$REINSTALL_HOME" --yes >"$TMPDIR_EVAL/reinstall-snapshot.out" 2>&1
if node - "$REINSTALL_HOME/opencode.json" "$REINSTALL_BEFORE" <<'NODE'
const fs = require("node:fs"); if (fs.readFileSync(process.argv[2], "utf8") !== process.argv[3]) throw new Error("not byte-exact");
NODE
then
  if [[ ! -e "$REINSTALL_HOME/.flow-agents/install.json" ]]; then _pass "opencode snapshot: current install baseline restores byte-exactly and secret snapshot is removed"; else _fail "opencode snapshot: reinstall snapshot was retained"; fi
else
  _fail "opencode snapshot: reinstall baseline was stale or non-exact"
fi

# Durable runtime content is manifest-owned file-by-file; an edit survives and is reported.
DURABLE_HOME="$TMPDIR_EVAL/durable-preserve-home"; mkdir -p "$DURABLE_HOME"
HOME="$TMPDIR_EVAL/durable-preserve-user-home" $FA init --runtime opencode --global --dest "$DURABLE_HOME" --yes >/dev/null 2>&1
printf '\nuser durable edit\n' >> "$DURABLE_HOME/.flow-agents/runtime/AGENTS.md"
HOME="$TMPDIR_EVAL/durable-preserve-user-home" $FA init --uninstall --runtime opencode --dest "$DURABLE_HOME" --yes >"$TMPDIR_EVAL/durable-preserve.out" 2>&1
if grep -q 'user durable edit' "$DURABLE_HOME/.flow-agents/runtime/AGENTS.md" && sed -n '/^Preserved/,/^$/p' "$TMPDIR_EVAL/durable-preserve.out" | grep -q '.flow-agents/runtime/AGENTS.md'; then _pass "durable: edited runtime file survives and is truthfully preserved"; else _fail "durable: recursive cleanup deleted or hid an edited runtime file"; fi

# An escaping durable-root symlink aborts before any removal.
DURABLE_ESCAPE_HOME="$TMPDIR_EVAL/durable-escape-home"; DURABLE_OUTSIDE="$TMPDIR_EVAL/durable-escape-outside"
mkdir -p "$DURABLE_ESCAPE_HOME" "$DURABLE_OUTSIDE"
HOME="$TMPDIR_EVAL/durable-escape-user-home" $FA init --runtime opencode --global --dest "$DURABLE_ESCAPE_HOME" --yes >/dev/null 2>&1
mv "$DURABLE_ESCAPE_HOME/.flow-agents" "$DURABLE_OUTSIDE/.flow-agents"; ln -s "$DURABLE_OUTSIDE/.flow-agents" "$DURABLE_ESCAPE_HOME/.flow-agents"
set +e; HOME="$TMPDIR_EVAL/durable-escape-user-home" $FA init --uninstall --runtime opencode --dest "$DURABLE_ESCAPE_HOME" --yes >"$TMPDIR_EVAL/durable-escape.out" 2>&1; DURABLE_ESCAPE_RC=$?; set -e
if [[ "$DURABLE_ESCAPE_RC" -eq 2 && -f "$DURABLE_OUTSIDE/.flow-agents/runtime/AGENTS.md" ]] && grep -qi 'symlinked parent' "$TMPDIR_EVAL/durable-escape.out"; then _pass "durable: symlinked .flow-agents escape is refused before deletion"; else _fail "durable: escaping durable root was not safely refused"; fi

# Exact instruction ownership: user AGENTS.md stays; a lexical drift that still targets the
# runtime instruction is reported and protects the referenced runtime file.
INSTRUCTION_HOME="$TMPDIR_EVAL/instruction-drift-home"; mkdir -p "$INSTRUCTION_HOME"
node - "$INSTRUCTION_HOME/opencode.json" <<'NODE'
const fs = require("node:fs"); fs.writeFileSync(process.argv[2], JSON.stringify({ instructions: ["/user/AGENTS.md"] }, null, 2) + "\n");
NODE
HOME="$TMPDIR_EVAL/instruction-drift-user-home" $FA init --runtime opencode --global --dest "$INSTRUCTION_HOME" --yes >/dev/null 2>&1
node - "$INSTRUCTION_HOME/opencode.json" "$INSTRUCTION_HOME" <<'NODE'
const fs = require("node:fs"), path = require("node:path"); const file = process.argv[2], root = process.argv[3], c = JSON.parse(fs.readFileSync(file, "utf8"));
// String concat, NOT path.join: path.join would normalize the ".." away and produce the exact
// installed string, making this fixture assert nothing about drift (caught in review).
c.instructions = c.instructions.map(x => x.endsWith(".flow-agents/runtime/AGENTS.md") ? `${root}/.flow-agents/runtime/../runtime/AGENTS.md` : x); c.$schema = "https://user.example/schema"; fs.writeFileSync(file, JSON.stringify(c, null, 2) + "\n");
NODE
HOME="$TMPDIR_EVAL/instruction-drift-user-home" $FA init --uninstall --runtime opencode --dest "$INSTRUCTION_HOME" --yes >"$TMPDIR_EVAL/instruction-drift.out" 2>&1
# Contract (two cases, both asserted):
#  (a) A managed instruction edited to a PATH-EQUIVALENT variant is treated as a USER edit: it is
#      retained, reported, and the runtime file it references is protected from removal (safe
#      direction -- we cannot distinguish a deliberate rewrite from tooling normalization).
#  (b) A managed entry re-pointed at a user-owned file is likewise retained with that file untouched.
if grep -q '"/user/AGENTS.md"' "$INSTRUCTION_HOME/opencode.json" && grep -q '\.\./runtime/AGENTS.md' "$INSTRUCTION_HOME/opencode.json" && [[ -f "$INSTRUCTION_HOME/.flow-agents/runtime/AGENTS.md" ]] && sed -n '/^Preserved/,/^$/p' "$TMPDIR_EVAL/instruction-drift.out" | grep -q 'instruction was edited' && sed -n '/^Preserved/,/^$/p' "$TMPDIR_EVAL/instruction-drift.out" | grep -q 'still references this runtime file'; then _pass "opencode instructions (a): path-equivalent drift is retained, reported, and its runtime file protected"; else _fail "opencode instructions (a): drift retention, reporting, or runtime-file protection failed"; fi

INSTRUCTION_DIVERGE_HOME="$TMPDIR_EVAL/instruction-diverge-home"; mkdir -p "$INSTRUCTION_DIVERGE_HOME/custom"
node - "$INSTRUCTION_DIVERGE_HOME/opencode.json" <<'NODE'
const fs = require("node:fs"); fs.writeFileSync(process.argv[2], JSON.stringify({ instructions: ["/user/AGENTS.md"] }, null, 2) + "\n");
NODE
HOME="$TMPDIR_EVAL/instruction-diverge-user-home" $FA init --runtime opencode --global --dest "$INSTRUCTION_DIVERGE_HOME" --yes >/dev/null 2>&1
printf '# my own agents file\n' > "$INSTRUCTION_DIVERGE_HOME/custom/MY-AGENTS.md"
node - "$INSTRUCTION_DIVERGE_HOME/opencode.json" "$INSTRUCTION_DIVERGE_HOME" <<'NODE'
const fs = require("node:fs"), path = require("node:path"); const file = process.argv[2], root = process.argv[3], c = JSON.parse(fs.readFileSync(file, "utf8"));
c.instructions = c.instructions.map(x => x === path.join(root, ".flow-agents", "runtime", "AGENTS.md") ? path.join(root, "custom", "MY-AGENTS.md") : x); fs.writeFileSync(file, JSON.stringify(c, null, 2) + "\n");
NODE
HOME="$TMPDIR_EVAL/instruction-diverge-user-home" $FA init --uninstall --runtime opencode --dest "$INSTRUCTION_DIVERGE_HOME" --yes >"$TMPDIR_EVAL/instruction-diverge.out" 2>&1
if grep -q '"/user/AGENTS.md"' "$INSTRUCTION_DIVERGE_HOME/opencode.json" && grep -q 'custom/MY-AGENTS.md' "$INSTRUCTION_DIVERGE_HOME/opencode.json" && [[ -f "$INSTRUCTION_DIVERGE_HOME/custom/MY-AGENTS.md" ]]; then _pass "opencode instructions (b): a managed entry re-pointed at a user-owned file is retained and that file is never touched"; else _fail "opencode instructions (b): divergent user edit or its target file was not protected"; fi

echo ""
echo "==========================="
total=$((pass + fail))
echo "Results: ${pass}/${total} passed, ${fail} failed"
[[ "$fail" -gt 0 ]] && exit 1
exit 0
