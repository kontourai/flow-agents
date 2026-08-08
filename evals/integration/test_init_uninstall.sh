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
# observed to produce by other tooling, using an arbitrary external directory here).
LEGACY_SKILL_NAME="deliver"
LEGACY_EXTERNAL_SKILLS="$TMPDIR_EVAL/external-skills-store"
mkdir -p "$LEGACY_EXTERNAL_SKILLS"
mv "$LEGACY_DEST/.claude/skills/$LEGACY_SKILL_NAME" "$LEGACY_EXTERNAL_SKILLS/$LEGACY_SKILL_NAME"
ln -s "$LEGACY_EXTERNAL_SKILLS/$LEGACY_SKILL_NAME" "$LEGACY_DEST/.claude/skills/$LEGACY_SKILL_NAME"

# Plant a user edit on an existing bundle-managed file (not a novel path) so the legacy diff
# actually visits and compares it, rather than merely never encountering an unrelated path.
LEGACY_MODIFIED_FILE="$LEGACY_DEST/context/coding-standards.md"
if [[ ! -f "$LEGACY_MODIFIED_FILE" ]]; then
  _fail "legacy: fixture context/coding-standards.md was not installed; cannot run scenario"
else
  printf '\nuser edit sentinel\n' >> "$LEGACY_MODIFIED_FILE"

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
echo "==========================="
total=$((pass + fail))
echo "Results: ${pass}/${total} passed, ${fail} failed"
[[ "$fail" -gt 0 ]] && exit 1
exit 0
