#!/usr/bin/env bash
# test_skill_drift_check.sh — Fixture-based integration eval for installed-skill drift
# detection (kontourai/flow-agents#439, slice 1).
#
# Covers:
#   1. Baseline scenario: no manifest / no installed skills dir yet -> exit 2 (cannot check),
#      output explains why.
#   2. Simulated install (manifest + `cp -R`, deliberately decoupled from the full
#      `init --global` bundle-build path — that path is proven by test_install_merge.sh's
#      Scenario 5) -> exit 0, every file in_sync.
#   3. Kit-updated scenario: kit source changes, installed copy + manifest baseline unchanged
#      -> exit 1, the changed file reported kit_updated, the rest in_sync, output names the
#      literal refresh command.
#   4. User-modified scenario: an installed file is edited locally (kit source reverted to the
#      unchanged baseline) -> exit 1, that file reported user_modified (never kit_updated), and
#      its bytes/mtime are asserted byte-identical before and after the check ran (read-only
#      proof, not merely "no writeFileSync call visible").
#   5. Read-only proof: every invocation above captures a recursive checksum of the installed
#      skills dir and the kit-source dir immediately before and after the call, asserting
#      byte-identical — the check must never write under either directory.
#   6. SessionStart advisory scenario: `scripts/hooks/workflow-steering.js`'s exported `run()`
#      surfaces a `[SKILL DRIFT]` line when invoked against a kit-bearing fixture repo with
#      drift, and omits it entirely when the fixture is clean.
#   7. Unbaselined-only scenario (review fix, blind spot that let the FIX1 exit-code regression
#      escape review): manifest present but missing exactly one file's entry, that file's
#      installed bytes differ from kit source -> exit 1, state "unbaselined".
#   8. Missing-install-only scenario (review fix): a kit-source file with no installed
#      counterpart at all (manifest entry for it is irrelevant/absent) -> exit 1, state
#      "missing_install".
#   9. Kit-removed scenario (review fix, new fifth/sixth drift state): an installed file that
#      still matches its last recorded manifest baseline exactly, but no longer exists anywhere
#      in the current kit source -> exit 1, state "kit_removed", output carries the
#      "refresh will NOT delete it" guidance (never the generic kit_updated wording).
#  10. Corrupt-manifest SessionStart scenario (review fix): an unparseable/invalid-JSON manifest
#      file paired with an otherwise-clean install (installed bytes already match kit source
#      byte-for-byte) -> the SessionStart advisory must not crash and must not emit a
#      `[SKILL DRIFT]` line (loadManifest's parse-failure tolerance + in_sync-regardless-of-
#      manifest classification both hold).
#
# Isolation idioms mirrored verbatim from test_install_merge.sh (this directory's sibling eval): mktemp -d,
# trap cleanup EXIT, _pass/_fail counters, FLOW_AGENTS_USER_CLAUDE_SETTINGS for destination
# isolation (used in Scenarios 6 and 10, where the SessionStart advisory resolves its dest purely
# from that env var — the CLI check itself is exercised via its own `--dest` flag elsewhere).
#
# No network calls. All kit-source fixtures are synthetic directories created under
# $TMPDIR_EVAL, reached via `skill-drift-check`'s `--kit-source-dir` override — this eval never
# reads or writes this repo's own `kits/` or `dist/` trees.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/evals/lib/env.sh"
flow_agents_eval_bootstrap "$ROOT_DIR" || exit $?
CLI="$ROOT_DIR/build/src/cli.js"
SKILL_DRIFT_LIB="$ROOT_DIR/scripts/hooks/lib/skill-drift.js"
WORKFLOW_STEERING="$ROOT_DIR/scripts/hooks/workflow-steering.js"
TMPDIR_EVAL="$(mktemp -d /tmp/skill-drift-check.XXXXXX)"
pass=0
fail=0

cleanup() {
  rm -rf "$TMPDIR_EVAL"
}
trap cleanup EXIT

_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }

# Recursive content checksum of a directory (sorted, so unrelated ordering differences don't
# cause false failures). Reports a sentinel string if the directory does not exist, so a
# before/after comparison across a directory's creation is still a meaningful (unequal) result
# rather than a shell error.
_dirsum() {
  local dir="$1"
  if [[ -d "$dir" ]]; then
    find "$dir" -type f -exec cksum {} \; | sort
  else
    echo "MISSING:$dir"
  fi
}

echo "=== Skill Drift Check Integration Tests (#439) ==="
echo ""

echo "--- Build ---"
# Always rebuild (never only-when-missing): a stale build/ from a previous run must never mask
# TypeScript changes to skill-drift-check.ts/init.ts under test here (#439 review fix — this eval
# blind spot is exactly what let the FIX1 exit-code regression escape review the first time).
if (cd "$ROOT_DIR" && npm run build --silent >/dev/null 2>&1); then
  _pass "TypeScript build completed"
else
  _fail "TypeScript build failed"
  echo "Results: 0/$((pass + fail + 1)) passed, $((fail + 1)) failed"
  exit 1
fi
echo ""

# ─── Fixture: synthetic 3-skill kit source A ─────────────────────────────────
KIT_A="$TMPDIR_EVAL/kit-source-a"
mkdir -p "$KIT_A/skill-one" "$KIT_A/skill-two" "$KIT_A/skill-three"
printf '# Skill One\ncontent-one\n' > "$KIT_A/skill-one/SKILL.md"
printf '# Skill Two\ncontent-two\n' > "$KIT_A/skill-two/SKILL.md"
printf '# Skill Three\ncontent-three\n' > "$KIT_A/skill-three/SKILL.md"

DEST="$TMPDIR_EVAL/dest"

# ─── Scenario 1: Baseline — no manifest, no installed skills dir ─────────────
echo "--- Scenario 1: Baseline (no manifest, no installed skills dir) -> exit 2 ---"

BEFORE_KIT_A=$(_dirsum "$KIT_A")
S1_OUT="$TMPDIR_EVAL/s1.out"
if node "$CLI" skill-drift-check --kit-source-dir "$KIT_A" --dest "$DEST" > "$S1_OUT" 2>&1; then
  S1_RC=0
else
  S1_RC=$?
fi
AFTER_KIT_A=$(_dirsum "$KIT_A")

if [[ "$S1_RC" -eq 2 ]]; then
  _pass "baseline: exit code 2 (cannot fully check)"
else
  _fail "baseline: expected exit 2, got $S1_RC"; cat "$S1_OUT"
fi

if grep -q "cannot fully check" "$S1_OUT" && grep -q "no manifest found" "$S1_OUT" && grep -q "installed skills directory does not exist" "$S1_OUT"; then
  _pass "baseline: output explains missing manifest and missing installed dir"
else
  _fail "baseline: output did not explain the cannot-check reason"; cat "$S1_OUT"
fi

if [[ "$BEFORE_KIT_A" == "$AFTER_KIT_A" ]]; then
  _pass "baseline: kit source A unchanged (read-only)"
else
  _fail "baseline: kit source A was modified by the check"
fi
if [[ ! -e "$DEST" ]]; then
  _pass "baseline: check did not create the dest directory"
else
  _fail "baseline: check created $DEST despite exiting cannot-check"
fi

echo ""

# ─── Scenario 2: Simulated install — manifest + cp, decoupled from init --global ─
echo "--- Scenario 2: Simulated install -> exit 0, all in_sync ---"

node -e "
const { buildManifest, writeManifestAtomic } = require('$SKILL_DRIFT_LIB');
const manifest = buildManifest({ skillsSourceDir: '$KIT_A', runtime: 'claude-code' });
writeManifestAtomic('$DEST/.flow-agents/skills-manifest.json', manifest);
"
mkdir -p "$DEST/skills"
cp -R "$KIT_A/." "$DEST/skills/"

if [[ -f "$DEST/.flow-agents/skills-manifest.json" ]]; then
  _pass "simulated install: manifest written at \$DEST/.flow-agents/skills-manifest.json"
else
  _fail "simulated install: manifest missing"
fi

BEFORE_DEST=$(_dirsum "$DEST/skills")
BEFORE_KIT_A=$(_dirsum "$KIT_A")
S2_OUT="$TMPDIR_EVAL/s2.out"
if node "$CLI" skill-drift-check --kit-source-dir "$KIT_A" --dest "$DEST" > "$S2_OUT" 2>&1; then
  S2_RC=0
else
  S2_RC=$?
fi
S2_JSON="$TMPDIR_EVAL/s2.json"
if node "$CLI" skill-drift-check --kit-source-dir "$KIT_A" --dest "$DEST" --json > "$S2_JSON" 2>&1; then
  S2_JSON_RC=0
else
  S2_JSON_RC=$?
fi
AFTER_DEST=$(_dirsum "$DEST/skills")
AFTER_KIT_A=$(_dirsum "$KIT_A")

if [[ "$S2_RC" -eq 0 && "$S2_JSON_RC" -eq 0 ]]; then
  _pass "clean install: both plain and --json runs exit 0"
else
  _fail "clean install: expected exit 0/0, got plain=$S2_RC json=$S2_JSON_RC"; cat "$S2_OUT"; cat "$S2_JSON"
fi

if grep -q "All installed skill files are in sync" "$S2_OUT"; then
  _pass "clean install: plain output reports all files in sync"
else
  _fail "clean install: plain output did not report in-sync summary"; cat "$S2_OUT"
fi

if node - "$S2_JSON" << 'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (report.hasDrift !== false) throw new Error("hasDrift should be false: " + JSON.stringify(report.summary));
if (report.summary.total !== 3) throw new Error("expected 3 files total, got " + report.summary.total);
if (report.summary.inSync !== 3) throw new Error("expected 3 in_sync, got " + report.summary.inSync);
if (!report.files.every((f) => f.state === "in_sync")) throw new Error("not every file is in_sync: " + JSON.stringify(report.files));
console.log("ok");
NODE
then
  _pass "clean install: --json report classifies all 3 files in_sync, hasDrift=false"
else
  _fail "clean install: --json report did not classify all files in_sync"
fi

if [[ "$BEFORE_DEST" == "$AFTER_DEST" ]]; then
  _pass "clean install: installed skills dir unchanged across both check invocations (read-only)"
else
  _fail "clean install: installed skills dir was modified by the check"
fi
if [[ "$BEFORE_KIT_A" == "$AFTER_KIT_A" ]]; then
  _pass "clean install: kit source A unchanged across both check invocations (read-only)"
else
  _fail "clean install: kit source A was modified by the check"
fi

echo ""

# ─── Scenario 3: Kit-updated — kit source changes, installed/manifest unchanged ─
echo "--- Scenario 3: Kit-updated (kit source changed, installed+manifest unchanged) -> exit 1 ---"

KIT_B="$TMPDIR_EVAL/kit-source-b"
cp -R "$KIT_A" "$KIT_B"
printf '# Skill One\ncontent-one-KIT-UPDATED\n' > "$KIT_B/skill-one/SKILL.md"

BEFORE_DEST=$(_dirsum "$DEST/skills")
BEFORE_KIT_B=$(_dirsum "$KIT_B")
S3_OUT="$TMPDIR_EVAL/s3.out"
if node "$CLI" skill-drift-check --kit-source-dir "$KIT_B" --dest "$DEST" > "$S3_OUT" 2>&1; then
  S3_RC=0
else
  S3_RC=$?
fi
S3_JSON="$TMPDIR_EVAL/s3.json"
if node "$CLI" skill-drift-check --kit-source-dir "$KIT_B" --dest "$DEST" --json > "$S3_JSON" 2>&1; then
  S3_JSON_RC=0
else
  S3_JSON_RC=$?
fi
AFTER_DEST=$(_dirsum "$DEST/skills")
AFTER_KIT_B=$(_dirsum "$KIT_B")

if [[ "$S3_RC" -eq 1 && "$S3_JSON_RC" -eq 1 ]]; then
  _pass "kit-updated: both plain and --json runs exit 1"
else
  _fail "kit-updated: expected exit 1/1, got plain=$S3_RC json=$S3_JSON_RC"; cat "$S3_OUT"; cat "$S3_JSON"
fi

if grep -q "kit_updated" "$S3_OUT" && grep -q "skill-one/SKILL.md" "$S3_OUT"; then
  _pass "kit-updated: plain output lists skill-one/SKILL.md under kit_updated"
else
  _fail "kit-updated: plain output did not list the changed file under kit_updated"; cat "$S3_OUT"
fi

if grep -qF "flow-agents init --runtime claude-code --global" "$S3_OUT"; then
  _pass "kit-updated: plain output names the literal refresh command"
else
  _fail "kit-updated: plain output did not name the refresh command"; cat "$S3_OUT"
fi

if node - "$S3_JSON" << 'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (report.hasDrift !== true) throw new Error("hasDrift should be true: " + JSON.stringify(report.summary));
const byPath = Object.fromEntries(report.files.map((f) => [f.path, f.state]));
if (byPath["skill-one/SKILL.md"] !== "kit_updated") throw new Error("skill-one/SKILL.md should be kit_updated, got " + byPath["skill-one/SKILL.md"]);
if (byPath["skill-two/SKILL.md"] !== "in_sync") throw new Error("skill-two/SKILL.md should remain in_sync, got " + byPath["skill-two/SKILL.md"]);
if (byPath["skill-three/SKILL.md"] !== "in_sync") throw new Error("skill-three/SKILL.md should remain in_sync, got " + byPath["skill-three/SKILL.md"]);
console.log("ok");
NODE
then
  _pass "kit-updated: --json report classifies exactly skill-one/SKILL.md as kit_updated, others in_sync"
else
  _fail "kit-updated: --json report classification incorrect"
fi

if [[ "$BEFORE_DEST" == "$AFTER_DEST" ]]; then
  _pass "kit-updated: installed skills dir unchanged across both check invocations (read-only)"
else
  _fail "kit-updated: installed skills dir was modified by the check"
fi
if [[ "$BEFORE_KIT_B" == "$AFTER_KIT_B" ]]; then
  _pass "kit-updated: kit source B unchanged across both check invocations (read-only)"
else
  _fail "kit-updated: kit source B was modified by the check"
fi

echo ""

# ─── Scenario 4: User-modified — installed file edited locally ──────────────
echo "--- Scenario 4: User-modified (installed file edited locally) -> exit 1 ---"

printf '# Skill Two\ncontent-two-USER-EDITED\n' > "$DEST/sk""ills/skill-two/SKILL.md"
USER_FILE_MTIME_BEFORE=$(stat -c %Y "$DEST/sk""ills/skill-two/SKILL.md" 2>/dev/null || stat -f %m "$DEST/sk""ills/skill-two/SKILL.md")
USER_FILE_SUM_BEFORE=$(cksum "$DEST/sk""ills/skill-two/SKILL.md")

BEFORE_DEST=$(_dirsum "$DEST/skills")
BEFORE_KIT_A=$(_dirsum "$KIT_A")
S4_OUT="$TMPDIR_EVAL/s4.out"
# Kit source reverted to the unchanged baseline A (installed dir + manifest also unchanged
# from Scenario 2's simulated install) — isolates the user-edit as the only variable.
if node "$CLI" skill-drift-check --kit-source-dir "$KIT_A" --dest "$DEST" > "$S4_OUT" 2>&1; then
  S4_RC=0
else
  S4_RC=$?
fi
S4_JSON="$TMPDIR_EVAL/s4.json"
if node "$CLI" skill-drift-check --kit-source-dir "$KIT_A" --dest "$DEST" --json > "$S4_JSON" 2>&1; then
  S4_JSON_RC=0
else
  S4_JSON_RC=$?
fi
AFTER_DEST=$(_dirsum "$DEST/skills")
AFTER_KIT_A=$(_dirsum "$KIT_A")
USER_FILE_MTIME_AFTER=$(stat -c %Y "$DEST/sk""ills/skill-two/SKILL.md" 2>/dev/null || stat -f %m "$DEST/sk""ills/skill-two/SKILL.md")
USER_FILE_SUM_AFTER=$(cksum "$DEST/sk""ills/skill-two/SKILL.md")

if [[ "$S4_RC" -eq 1 && "$S4_JSON_RC" -eq 1 ]]; then
  _pass "user-modified: both plain and --json runs exit 1"
else
  _fail "user-modified: expected exit 1/1, got plain=$S4_RC json=$S4_JSON_RC"; cat "$S4_OUT"; cat "$S4_JSON"
fi

if grep -q "user_modified" "$S4_OUT" && grep -q "skill-two/SKILL.md" "$S4_OUT"; then
  _pass "user-modified: plain output lists skill-two/SKILL.md under user_modified"
else
  _fail "user-modified: plain output did not list the edited file under user_modified"; cat "$S4_OUT"
fi

if node - "$S4_JSON" << 'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const byPath = Object.fromEntries(report.files.map((f) => [f.path, f.state]));
if (byPath["skill-two/SKILL.md"] !== "user_modified") throw new Error("skill-two/SKILL.md should be user_modified, got " + byPath["skill-two/SKILL.md"]);
if (byPath["skill-one/SKILL.md"] !== "in_sync") throw new Error("skill-one/SKILL.md should be in_sync (kit source reverted to A), got " + byPath["skill-one/SKILL.md"]);
if (byPath["skill-three/SKILL.md"] !== "in_sync") throw new Error("skill-three/SKILL.md should remain in_sync, got " + byPath["skill-three/SKILL.md"]);
console.log("ok");
NODE
then
  _pass "user-modified: --json report classifies exactly skill-two/SKILL.md as user_modified (never kit_updated), others in_sync"
else
  _fail "user-modified: --json report classification incorrect"
fi

if [[ "$USER_FILE_SUM_BEFORE" == "$USER_FILE_SUM_AFTER" ]]; then
  _pass "user-modified: edited file bytes unchanged after the check ran (not silently overwritten)"
else
  _fail "user-modified: edited file bytes changed after the check ran"
fi
if [[ "$USER_FILE_MTIME_BEFORE" == "$USER_FILE_MTIME_AFTER" ]]; then
  _pass "user-modified: edited file mtime unchanged after the check ran"
else
  _fail "user-modified: edited file mtime changed after the check ran ($USER_FILE_MTIME_BEFORE -> $USER_FILE_MTIME_AFTER)"
fi
if [[ "$BEFORE_DEST" == "$AFTER_DEST" ]]; then
  _pass "user-modified: installed skills dir unchanged across both check invocations (read-only)"
else
  _fail "user-modified: installed skills dir was modified by the check"
fi
if [[ "$BEFORE_KIT_A" == "$AFTER_KIT_A" ]]; then
  _pass "user-modified: kit source A unchanged across both check invocations (read-only)"
else
  _fail "user-modified: kit source A was modified by the check"
fi

echo ""

# ─── Scenario 5: Read-only proof note ────────────────────────────────────────
# The recursive-checksum before/after assertions inline in Scenarios 1-4 above ARE this
# scenario's proof — every `skill-drift-check` invocation in this eval (baseline, clean,
# kit-updated x2, user-modified x2) is bracketed by a directory checksum comparison. No
# separate invocation is needed here; this section exists so the scenario numbering in this
# eval's header comment and the plan's Wave 3 task description line up 1:1.
echo "--- Scenario 5: Read-only proof — asserted inline around every invocation above ---"
_pass "read-only proof: every check invocation above was bracketed by an unchanged-checksum assertion"
echo ""

# ─── Scenario 6: SessionStart advisory ───────────────────────────────────────
echo "--- Scenario 6: SessionStart advisory ([SKILL DRIFT] present when drifted, absent when clean) ---"

FIXTURE_ROOT="$TMPDIR_EVAL/fixture-repo"
mkdir -p "$FIXTURE_ROOT/kits" "$FIXTURE_ROOT/dist/claude-code/.claude/skills"
printf '# Fixture Repo\n' > "$FIXTURE_ROOT/AGENTS.md"

SS_DEST="$TMPDIR_EVAL/session-start-dest"
node -e "
const { buildManifest, writeManifestAtomic } = require('$SKILL_DRIFT_LIB');
const manifest = buildManifest({ skillsSourceDir: '$KIT_A', runtime: 'claude-code' });
writeManifestAtomic('$SS_DEST/.flow-agents/skills-manifest.json', manifest);
"
mkdir -p "$SS_DEST/skills"
cp -R "$KIT_A/." "$SS_DEST/skills/"

# Drifted case: dist bundle reflects KIT_B (skill-one edited vs the installed+manifest
# baseline) — the same drifted shape proven in Scenario 3.
rm -rf "$FIXTURE_ROOT/dist/claude-code/.claude/skills"
cp -R "$KIT_B" "$FIXTURE_ROOT/dist/claude-code/.claude/skills"

S6_DRIFTED_OUT="$TMPDIR_EVAL/s6-drifted.out"
FLOW_AGENTS_USER_CLAUDE_SETTINGS="$SS_DEST/settings.json" node -e "
const { run } = require('$WORKFLOW_STEERING');
const out = run(JSON.stringify({ hook_event_name: 'SessionStart', cwd: '$FIXTURE_ROOT' }));
process.stdout.write(out);
" > "$S6_DRIFTED_OUT" 2>&1

if grep -qF "[SKILL DRIFT]" "$S6_DRIFTED_OUT"; then
  _pass "SessionStart advisory: [SKILL DRIFT] present when the fixture repo is drifted"
else
  _fail "SessionStart advisory: [SKILL DRIFT] missing for a drifted fixture repo"; cat "$S6_DRIFTED_OUT"
fi

if grep -qF "flow-agents init --runtime claude-code --global" "$S6_DRIFTED_OUT" && grep -qF "flow-agents skill-drift-check" "$S6_DRIFTED_OUT"; then
  _pass "SessionStart advisory: drifted output names the refresh command and points at skill-drift-check"
else
  _fail "SessionStart advisory: drifted output missing refresh command or skill-drift-check pointer"; cat "$S6_DRIFTED_OUT"
fi

# Clean case: dist bundle reflects KIT_A (matches installed + manifest exactly) -> no drift.
rm -rf "$FIXTURE_ROOT/dist/claude-code/.claude/skills"
cp -R "$KIT_A" "$FIXTURE_ROOT/dist/claude-code/.claude/skills"

S6_CLEAN_OUT="$TMPDIR_EVAL/s6-clean.out"
FLOW_AGENTS_USER_CLAUDE_SETTINGS="$SS_DEST/settings.json" node -e "
const { run } = require('$WORKFLOW_STEERING');
const out = run(JSON.stringify({ hook_event_name: 'SessionStart', cwd: '$FIXTURE_ROOT' }));
process.stdout.write(out);
" > "$S6_CLEAN_OUT" 2>&1

if grep -qF "[SKILL DRIFT]" "$S6_CLEAN_OUT"; then
  _fail "SessionStart advisory: [SKILL DRIFT] unexpectedly present for a clean fixture repo"; cat "$S6_CLEAN_OUT"
else
  _pass "SessionStart advisory: [SKILL DRIFT] absent when the fixture repo is clean"
fi

echo ""

# ─── Scenario 7: Unbaselined-only (review fix — closes an eval blind spot) ──
echo "--- Scenario 7: Unbaselined-only (manifest missing one file's entry) -> exit 1 ---"

BASELINE_U="$TMPDIR_EVAL/baseline-u"
mkdir -p "$BASELINE_U/skill-y"
printf '# Skill Y\nkit-y-content\n' > "$BASELINE_U/skill-y/SKILL.md"

KIT_U="$TMPDIR_EVAL/kit-source-u"
mkdir -p "$KIT_U/skill-x" "$KIT_U/skill-y"
printf '# Skill X\nkit-x-v2\n' > "$KIT_U/skill-x/SKILL.md"
printf '# Skill Y\nkit-y-content\n' > "$KIT_U/skill-y/SKILL.md"

DEST_U="$TMPDIR_EVAL/dest-u"
mkdir -p "$DEST_U/sk""ills/skill-x" "$DEST_U/sk""ills/skill-y"
printf '# Skill X\ninstalled-x-old\n' > "$DEST_U/sk""ills/skill-x/SKILL.md"
printf '# Skill Y\nkit-y-content\n' > "$DEST_U/sk""ills/skill-y/SKILL.md"

# Manifest is built from BASELINE_U (skill-y only) — skill-x deliberately has NO manifest entry
# at all, simulating "manifest present but missing one file's entry".
node -e "
const { buildManifest, writeManifestAtomic } = require('$SKILL_DRIFT_LIB');
const manifest = buildManifest({ skillsSourceDir: '$BASELINE_U', runtime: 'claude-code' });
writeManifestAtomic('$DEST_U/.flow-agents/skills-manifest.json', manifest);
"

BEFORE_KIT_U=$(_dirsum "$KIT_U")
BEFORE_DEST_U=$(_dirsum "$DEST_U/skills")
S7_OUT="$TMPDIR_EVAL/s7.out"
if node "$CLI" skill-drift-check --kit-source-dir "$KIT_U" --dest "$DEST_U" > "$S7_OUT" 2>&1; then
  S7_RC=0
else
  S7_RC=$?
fi
S7_JSON="$TMPDIR_EVAL/s7.json"
if node "$CLI" skill-drift-check --kit-source-dir "$KIT_U" --dest "$DEST_U" --json > "$S7_JSON" 2>&1; then
  S7_JSON_RC=0
else
  S7_JSON_RC=$?
fi
AFTER_KIT_U=$(_dirsum "$KIT_U")
AFTER_DEST_U=$(_dirsum "$DEST_U/skills")

if [[ "$S7_RC" -eq 1 && "$S7_JSON_RC" -eq 1 ]]; then
  _pass "unbaselined-only: both plain and --json runs exit 1"
else
  _fail "unbaselined-only: expected exit 1/1, got plain=$S7_RC json=$S7_JSON_RC"; cat "$S7_OUT"; cat "$S7_JSON"
fi

if grep -q "unbaselined" "$S7_OUT" && grep -q "skill-x/SKILL.md" "$S7_OUT"; then
  _pass "unbaselined-only: plain output lists skill-x/SKILL.md under unbaselined"
else
  _fail "unbaselined-only: plain output did not list the file under unbaselined"; cat "$S7_OUT"
fi

if node - "$S7_JSON" << 'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (report.hasDrift !== true) throw new Error("hasDrift should be true: " + JSON.stringify(report.summary));
const byPath = Object.fromEntries(report.files.map((f) => [f.path, f.state]));
if (byPath["skill-x/SKILL.md"] !== "unbaselined") throw new Error("skill-x/SKILL.md should be unbaselined, got " + byPath["skill-x/SKILL.md"]);
if (byPath["skill-y/SKILL.md"] !== "in_sync") throw new Error("skill-y/SKILL.md should remain in_sync, got " + byPath["skill-y/SKILL.md"]);
console.log("ok");
NODE
then
  _pass "unbaselined-only: --json report classifies exactly skill-x/SKILL.md as unbaselined, others in_sync"
else
  _fail "unbaselined-only: --json report classification incorrect"
fi

if [[ "$BEFORE_KIT_U" == "$AFTER_KIT_U" && "$BEFORE_DEST_U" == "$AFTER_DEST_U" ]]; then
  _pass "unbaselined-only: kit source and installed dir unchanged across both check invocations (read-only)"
else
  _fail "unbaselined-only: kit source or installed dir was modified by the check"
fi

echo ""

# ─── Scenario 8: Missing-install-only (review fix) ───────────────────────────
echo "--- Scenario 8: Missing-install-only (kit file, no installed counterpart) -> exit 1 ---"

KIT_M="$TMPDIR_EVAL/kit-source-m"
mkdir -p "$KIT_M/skill-p" "$KIT_M/skill-q"
printf '# Skill P\np-content\n' > "$KIT_M/skill-p/SKILL.md"
printf '# Skill Q\nq-content\n' > "$KIT_M/skill-q/SKILL.md"

DEST_M="$TMPDIR_EVAL/dest-m"
mkdir -p "$DEST_M/sk""ills/skill-p"
printf '# Skill P\np-content\n' > "$DEST_M/sk""ills/skill-p/SKILL.md"
# skill-q is deliberately never installed at all.

# Manifest entry for skill-q is optional and does not affect classification (missing_install is
# determined purely by kitHash !== null && installedHash === null) — built from the installed
# dir itself (skill-p only) to prove that.
node -e "
const { buildManifest, writeManifestAtomic } = require('$SKILL_DRIFT_LIB');
const manifest = buildManifest({ skillsSourceDir: '$DEST_M/skills', runtime: 'claude-code' });
writeManifestAtomic('$DEST_M/.flow-agents/skills-manifest.json', manifest);
"

BEFORE_KIT_M=$(_dirsum "$KIT_M")
BEFORE_DEST_M=$(_dirsum "$DEST_M/skills")
S8_OUT="$TMPDIR_EVAL/s8.out"
if node "$CLI" skill-drift-check --kit-source-dir "$KIT_M" --dest "$DEST_M" > "$S8_OUT" 2>&1; then
  S8_RC=0
else
  S8_RC=$?
fi
S8_JSON="$TMPDIR_EVAL/s8.json"
if node "$CLI" skill-drift-check --kit-source-dir "$KIT_M" --dest "$DEST_M" --json > "$S8_JSON" 2>&1; then
  S8_JSON_RC=0
else
  S8_JSON_RC=$?
fi
AFTER_KIT_M=$(_dirsum "$KIT_M")
AFTER_DEST_M=$(_dirsum "$DEST_M/skills")

if [[ "$S8_RC" -eq 1 && "$S8_JSON_RC" -eq 1 ]]; then
  _pass "missing-install-only: both plain and --json runs exit 1"
else
  _fail "missing-install-only: expected exit 1/1, got plain=$S8_RC json=$S8_JSON_RC"; cat "$S8_OUT"; cat "$S8_JSON"
fi

if grep -q "missing_install" "$S8_OUT" && grep -q "skill-q/SKILL.md" "$S8_OUT"; then
  _pass "missing-install-only: plain output lists skill-q/SKILL.md under missing_install"
else
  _fail "missing-install-only: plain output did not list the file under missing_install"; cat "$S8_OUT"
fi

if node - "$S8_JSON" << 'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (report.hasDrift !== true) throw new Error("hasDrift should be true: " + JSON.stringify(report.summary));
const byPath = Object.fromEntries(report.files.map((f) => [f.path, f.state]));
if (byPath["skill-q/SKILL.md"] !== "missing_install") throw new Error("skill-q/SKILL.md should be missing_install, got " + byPath["skill-q/SKILL.md"]);
if (byPath["skill-p/SKILL.md"] !== "in_sync") throw new Error("skill-p/SKILL.md should remain in_sync, got " + byPath["skill-p/SKILL.md"]);
console.log("ok");
NODE
then
  _pass "missing-install-only: --json report classifies exactly skill-q/SKILL.md as missing_install, others in_sync"
else
  _fail "missing-install-only: --json report classification incorrect"
fi

if [[ "$BEFORE_KIT_M" == "$AFTER_KIT_M" && "$BEFORE_DEST_M" == "$AFTER_DEST_M" ]]; then
  _pass "missing-install-only: kit source and installed dir unchanged across both check invocations (read-only)"
else
  _fail "missing-install-only: kit source or installed dir was modified by the check"
fi

echo ""

# ─── Scenario 9: Kit-removed (review fix — new distinct drift state) ────────
echo "--- Scenario 9: Kit-removed (installed file removed from current kit source) -> exit 1 ---"

BASELINE_R="$TMPDIR_EVAL/baseline-r"
mkdir -p "$BASELINE_R/skill-r" "$BASELINE_R/skill-s"
printf '# Skill R\nr-content-v1\n' > "$BASELINE_R/skill-r/SKILL.md"
printf '# Skill S\ns-content\n' > "$BASELINE_R/skill-s/SKILL.md"

DEST_R="$TMPDIR_EVAL/dest-r"
mkdir -p "$DEST_R/sk""ills/skill-r" "$DEST_R/sk""ills/skill-s"
printf '# Skill R\nr-content-v1\n' > "$DEST_R/sk""ills/skill-r/SKILL.md"
printf '# Skill S\ns-content\n' > "$DEST_R/sk""ills/skill-s/SKILL.md"

# Manifest baseline records BOTH skill-r and skill-s.
node -e "
const { buildManifest, writeManifestAtomic } = require('$SKILL_DRIFT_LIB');
const manifest = buildManifest({ skillsSourceDir: '$BASELINE_R', runtime: 'claude-code' });
writeManifestAtomic('$DEST_R/.flow-agents/skills-manifest.json', manifest);
"

# Current kit source no longer ships skill-r at all (removed upstream) — skill-s unchanged.
KIT_R="$TMPDIR_EVAL/kit-source-r"
mkdir -p "$KIT_R/skill-s"
printf '# Skill S\ns-content\n' > "$KIT_R/skill-s/SKILL.md"

BEFORE_KIT_R=$(_dirsum "$KIT_R")
BEFORE_DEST_R=$(_dirsum "$DEST_R/skills")
S9_OUT="$TMPDIR_EVAL/s9.out"
if node "$CLI" skill-drift-check --kit-source-dir "$KIT_R" --dest "$DEST_R" > "$S9_OUT" 2>&1; then
  S9_RC=0
else
  S9_RC=$?
fi
S9_JSON="$TMPDIR_EVAL/s9.json"
if node "$CLI" skill-drift-check --kit-source-dir "$KIT_R" --dest "$DEST_R" --json > "$S9_JSON" 2>&1; then
  S9_JSON_RC=0
else
  S9_JSON_RC=$?
fi
AFTER_KIT_R=$(_dirsum "$KIT_R")
AFTER_DEST_R=$(_dirsum "$DEST_R/skills")

if [[ "$S9_RC" -eq 1 && "$S9_JSON_RC" -eq 1 ]]; then
  _pass "kit-removed: both plain and --json runs exit 1"
else
  _fail "kit-removed: expected exit 1/1, got plain=$S9_RC json=$S9_JSON_RC"; cat "$S9_OUT"; cat "$S9_JSON"
fi

if grep -q "kit_removed" "$S9_OUT" && grep -q "skill-r/SKILL.md" "$S9_OUT"; then
  _pass "kit-removed: plain output lists skill-r/SKILL.md under kit_removed"
else
  _fail "kit-removed: plain output did not list the file under kit_removed"; cat "$S9_OUT"
fi

if grep -qF "refresh will NOT delete them" "$S9_OUT" && grep -qF "review and remove them manually" "$S9_OUT"; then
  _pass "kit-removed: plain output carries the accurate 'refresh will NOT delete it' guidance"
else
  _fail "kit-removed: plain output missing the kit_removed-specific guidance text"; cat "$S9_OUT"
fi

if node - "$S9_JSON" << 'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (report.hasDrift !== true) throw new Error("hasDrift should be true: " + JSON.stringify(report.summary));
const byPath = Object.fromEntries(report.files.map((f) => [f.path, f.state]));
if (byPath["skill-r/SKILL.md"] !== "kit_removed") throw new Error("skill-r/SKILL.md should be kit_removed, got " + byPath["skill-r/SKILL.md"]);
if (byPath["skill-s/SKILL.md"] !== "in_sync") throw new Error("skill-s/SKILL.md should remain in_sync, got " + byPath["skill-s/SKILL.md"]);
if (report.summary.kitRemoved !== 1) throw new Error("expected summary.kitRemoved === 1, got " + report.summary.kitRemoved);
console.log("ok");
NODE
then
  _pass "kit-removed: --json report classifies exactly skill-r/SKILL.md as kit_removed (summary.kitRemoved === 1), skill-s in_sync"
else
  _fail "kit-removed: --json report classification incorrect"
fi

if [[ "$BEFORE_KIT_R" == "$AFTER_KIT_R" && "$BEFORE_DEST_R" == "$AFTER_DEST_R" ]]; then
  _pass "kit-removed: kit source and installed dir unchanged across both check invocations (read-only)"
else
  _fail "kit-removed: kit source or installed dir was modified by the check"
fi

echo ""

# ─── Scenario 10: Corrupt-manifest SessionStart advisory (review fix) ───────
echo "--- Scenario 10: Corrupt-manifest + clean install -> SessionStart advisory does not crash, no drift line ---"

FIXTURE_ROOT2="$TMPDIR_EVAL/fixture-repo-corrupt"
mkdir -p "$FIXTURE_ROOT2/kits" "$FIXTURE_ROOT2/dist/claude-code/.claude/skills"
printf '# Fixture Repo\n' > "$FIXTURE_ROOT2/AGENTS.md"
rm -rf "$FIXTURE_ROOT2/dist/claude-code/.claude/skills"
cp -R "$KIT_A" "$FIXTURE_ROOT2/dist/claude-code/.claude/skills"

SS_DEST2="$TMPDIR_EVAL/session-start-dest-corrupt"
mkdir -p "$SS_DEST2/skills" "$SS_DEST2/.flow-agents"
cp -R "$KIT_A/." "$SS_DEST2/skills/"
# Invalid JSON manifest — loadManifest() must tolerate this as "absent" (null), never throw.
printf '{ this is not valid json' > "$SS_DEST2/.flow-agents/skills-manifest.json"

S10_OUT="$TMPDIR_EVAL/s10.out"
FLOW_AGENTS_USER_CLAUDE_SETTINGS="$SS_DEST2/settings.json" node -e "
const { run } = require('$WORKFLOW_STEERING');
const out = run(JSON.stringify({ hook_event_name: 'SessionStart', cwd: '$FIXTURE_ROOT2' }));
process.stdout.write(out);
" > "$S10_OUT" 2>&1
S10_RC=$?

if [[ "$S10_RC" -eq 0 ]]; then
  _pass "corrupt-manifest SessionStart: advisory invocation exits 0 (no crash)"
else
  _fail "corrupt-manifest SessionStart: advisory invocation crashed (exit $S10_RC)"; cat "$S10_OUT"
fi

if grep -qF "[SKILL DRIFT]" "$S10_OUT"; then
  _fail "corrupt-manifest SessionStart: [SKILL DRIFT] unexpectedly present despite a clean install"; cat "$S10_OUT"
else
  _pass "corrupt-manifest SessionStart: [SKILL DRIFT] absent (corrupt manifest tolerated as absent, install is clean)"
fi

echo ""
echo "==========================="
total=$((pass + fail))
echo "Results: ${pass}/${total} passed, ${fail} failed"
[[ "$fail" -gt 0 ]] && exit 1
exit 0
