#!/usr/bin/env bash
# test_kit_activation.sh — `flow-agents kit activate <id>` / `flow-agents kit deactivate <id>`
# built-in kit activation lifecycle, and the `active_kits` durable-record field.
#
# Covers:
#   A. Fresh --global install populates `active_kits` with every catalog kit (current physical
#      behavior, now recorded rather than implicit): {id, version, activated_at, scope}.
#   B. Fresh project-scoped install populates `active_kits` the same way, with scope="project".
#   C. `kit deactivate builder --global` removes builder's skill files + its `active_kits` entry,
#      while the knowledge kit's skill (knowledge-capture) and the ENGINE (settings.json hooks)
#      are untouched.
#   D. `kit activate builder --global` re-activates: restores builder's skill files + entry.
#   E. Idempotency: activate-when-active is a no-op (exit 0, message, no changes); deactivate-
#      when-inactive exits 3 (uninstall.ts's "nothing to do" precedent).
#   F. Dependency awareness: deactivating a dependency (`knowledge`) of an active kit (`builder`)
#      is blocked (exit 1) without --force, and proceeds with a warning when --force is given.
#      Activating a kit whose dependency is inactive prints a non-blocking suggestion.
#   G. Unknown kit id -> exit 2 for both verbs; missing --dest/--global -> exit 2.
#   H. --dry-run changes nothing on disk.
#   I. Catalog-level steering: scripts/hooks/lib/kit-catalog.js's workflowTriggersFor omits a
#      deactivated built-in kit's workflow_triggers, restores them on reactivation, and leaves
#      trigger loading UNCHANGED when the install record has no `active_kits` field at all
#      (legacy-record fail-open).
#
# r1 review fix-round scenarios (kit-activation-review-r1.md):
#   J. HIGH: `kit activate` no longer clobbers a file `kit deactivate` preserved -- it preserves
#      + reports the same conflict on reactivation, and --force is required to overwrite it.
#   K. HIGH: scripts/hooks/lib/kit-catalog.js's steering filter fails OPEN (not silently closed)
#      when active_kits is present but every entry is malformed, with a stderr diagnostic; a
#      partially-malformed array honors its valid entries and skips the bad ones silently.
#   L. MEDIUM: deactivate's apply-time containment re-check (TOCTOU) catches a skill directory
#      swapped for an escaping symlink between planning and removal (mirrors
#      test_init_uninstall.sh's Scenario H4).
#   M. MEDIUM: `kit deactivate --dry-run` reports the exact same removed/preserved split the real
#      run performs (no longer overclaims removal of a file that would actually be preserved).
#   N. MEDIUM: `active_kit_ids` stays the exact string[] projection of `active_kits`' ids after
#      every activate/deactivate call.
#   O. MEDIUM: a corrupt (duplicate-id) active_kits entry unrelated to the kit being acted on
#      makes activate/deactivate refuse cleanly, naming the bad entry, BEFORE touching any file.
#   P. MEDIUM (eval power): a locally-installed third-party kit's workflow_triggers are never
#      filtered by active_kits (which only ever lists built-in kits), before and after a built-in
#      kit is deactivated.
#
# r2 delta review fix-round scenarios (kit-activation-review-r2-delta.md):
#   Q. HIGH: `kit activate` has parent-directory containment parity with `kit deactivate` -- a
#      symlinked skill DIRECTORY (planted where a file does not yet exist) makes activate abort
#      cleanly before any write, naming the entry; the external tree is never touched.
#   R. HIGH-adjacent: `--force` on a symlinked destination FILE never follows the symlink -- it
#      replaces the symlink with a regular file INSIDE dest and reports truthfully what happened;
#      the external target the symlink pointed at is untouched.
#   S. MEDIUM: a poisoned manifest entry (parent resolves outside dest, e.g. a byproduct of the Q
#      hole before this fix) makes `kit deactivate`'s plan-time containment check fail with a
#      clean CLI error, not a raw stack trace, touching zero files.
#   T. LOW: the fully-malformed-active_kits stderr diagnostic prints at most once per process
#      invocation, even when `workflowTriggersFor` is called more than once (matching
#      `kitWorkflowSteering`'s multi-category call pattern).
#
# CI-fallout regression (caught by src/cli/kit-provisioning.test.mjs, not by this eval):
#   U. `flow-agents init --activate-kit <id>` with a mix of a built-in catalog kit id and a
#      locally-installed THIRD-PARTY kit id no longer crashes ("active_kits references unknown
#      kit id"). `active_kits` (the built-in-only registry) contains only the catalog kit;
#      `active_kit_ids` (the legacy, unfiltered field) contains both; the third-party kit's own
#      local registry entry is unaffected.
#
# Isolation: every scenario runs against its own fixture $HOME / project dest under a private
# TMPDIR_EVAL; the real $HOME is never touched.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMPDIR_EVAL="$(mktemp -d /tmp/kit-activation.XXXXXX)"
pass=0
fail=0

cleanup() {
  rm -rf "$TMPDIR_EVAL"
}
trap cleanup EXIT

_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }

FA="node $ROOT_DIR/build/src/cli.js"

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

# ─── Scenario A: fresh --global install populates active_kits ────────────────────────────────
echo "--- Scenario A: fresh --global install populates active_kits with every catalog kit ---"

GLOBAL_HOME="$TMPDIR_EVAL/global-home"
mkdir -p "$GLOBAL_HOME"
HOME="$GLOBAL_HOME" $FA init --runtime claude-code --global --yes >/dev/null 2>&1

if node - "$GLOBAL_HOME/.claude/.flow-agents/install.json" << 'NODE'
const fs = require("node:fs");
const record = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!Array.isArray(record.active_kits)) throw new Error("active_kits missing or not an array");
const ids = record.active_kits.map((k) => k.id).sort();
const expected = ["builder", "knowledge", "release-evidence"];
if (JSON.stringify(ids) !== JSON.stringify(expected)) throw new Error("unexpected active_kits ids: " + JSON.stringify(ids));
for (const entry of record.active_kits) {
  if (typeof entry.version !== "string" || !entry.version) throw new Error("entry missing version: " + JSON.stringify(entry));
  if (typeof entry.activated_at !== "string" || Number.isNaN(Date.parse(entry.activated_at))) throw new Error("entry missing/invalid activated_at: " + JSON.stringify(entry));
  if (entry.scope !== "global") throw new Error("entry scope should be 'global': " + JSON.stringify(entry));
}
// active_kit_ids (pre-existing field) must stay untouched/backward-compatible.
if (!Array.isArray(record.active_kit_ids)) throw new Error("active_kit_ids field regressed");
console.log("ok");
NODE
then
  _pass "global install: active_kits records all 3 built-in kits with valid {id,version,activated_at,scope=global}"
else
  _fail "global install: active_kits shape/content wrong"
fi
echo ""

# ─── Scenario B: fresh project-scoped install populates active_kits (scope=project) ──────────
echo "--- Scenario B: fresh project-scoped install populates active_kits (scope=project) ---"

PROJECT_DEST="$TMPDIR_EVAL/project-dest"
mkdir -p "$PROJECT_DEST"
(cd "$PROJECT_DEST" && git init -q)
$FA init --runtime claude-code --dest "$PROJECT_DEST" --yes >/dev/null 2>&1

if node - "$PROJECT_DEST/.flow-agents/install.json" << 'NODE'
const fs = require("node:fs");
const record = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const ids = (record.active_kits || []).map((k) => k.id).sort();
if (JSON.stringify(ids) !== JSON.stringify(["builder", "knowledge", "release-evidence"])) throw new Error("unexpected ids: " + JSON.stringify(ids));
if (record.active_kits.some((k) => k.scope !== "project")) throw new Error("expected scope=project for every entry");
console.log("ok");
NODE
then
  _pass "project-scoped install: active_kits records all 3 built-in kits with scope=project"
else
  _fail "project-scoped install: active_kits shape/content wrong"
fi
echo ""

# ─── Scenario C: deactivate builder removes its skills + entry; knowledge/engine untouched ───
echo "--- Scenario C: kit deactivate builder removes builder skills + active_kits entry only ---"

DEACT_HOME="$TMPDIR_EVAL/deact-home"
mkdir -p "$DEACT_HOME"
HOME="$DEACT_HOME" $FA init --runtime claude-code --global --yes >/dev/null 2>&1

SETTINGS_BEFORE="$(cat "$DEACT_HOME/.claude/settings.json")"
KNOWLEDGE_SKILL_HASH_BEFORE="$(shasum -a 256 "$DEACT_HOME/.claude/skills/knowledge-capture/SKILL.md" | awk '{print $1}')"

DEACT_OUT="$TMPDIR_EVAL/deactivate-builder.out"
set +e
HOME="$DEACT_HOME" $FA kit deactivate builder --global >"$DEACT_OUT" 2>&1
DEACT_RC=$?
set -e

if [[ "$DEACT_RC" -eq 0 ]]; then
  _pass "deactivate builder: exits 0"
else
  _fail "deactivate builder: expected exit 0, got $DEACT_RC"
  cat "$DEACT_OUT"
fi

if [[ ! -d "$DEACT_HOME/.claude/skills/deliver" && ! -d "$DEACT_HOME/.claude/skills/pull-work" ]]; then
  _pass "deactivate builder: builder skill directories removed from disk"
else
  _fail "deactivate builder: builder skill directories still present"
fi

if [[ -f "$DEACT_HOME/.claude/skills/knowledge-capture/SKILL.md" ]]; then
  KNOWLEDGE_SKILL_HASH_AFTER="$(shasum -a 256 "$DEACT_HOME/.claude/skills/knowledge-capture/SKILL.md" | awk '{print $1}')"
  if [[ "$KNOWLEDGE_SKILL_HASH_BEFORE" == "$KNOWLEDGE_SKILL_HASH_AFTER" ]]; then
    _pass "deactivate builder: knowledge kit's skill (knowledge-capture) is untouched"
  else
    _fail "deactivate builder: knowledge-capture content changed"
  fi
else
  _fail "deactivate builder: knowledge-capture skill was removed (should never happen)"
fi

SETTINGS_AFTER="$(cat "$DEACT_HOME/.claude/settings.json")"
if [[ "$SETTINGS_BEFORE" == "$SETTINGS_AFTER" ]]; then
  _pass "deactivate builder: settings.json (ENGINE hooks) is byte-identical, untouched"
else
  _fail "deactivate builder: settings.json changed (engine must stay untouched)"
fi

if node - "$DEACT_HOME/.claude/.flow-agents/install.json" << 'NODE'
const fs = require("node:fs");
const record = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const ids = record.active_kits.map((k) => k.id);
if (ids.includes("builder")) throw new Error("builder still in active_kits: " + JSON.stringify(ids));
if (!ids.includes("knowledge") || !ids.includes("release-evidence")) throw new Error("other kits unexpectedly removed: " + JSON.stringify(ids));
console.log("ok");
NODE
then
  _pass "deactivate builder: active_kits entry removed for builder only"
else
  _fail "deactivate builder: active_kits not updated correctly"
fi

if node - "$DEACT_HOME/.claude/.flow-agents/owned-files.json" << 'NODE'
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (manifest.files.some((f) => f.path === "skills/deliver/SKILL.md")) throw new Error("stale manifest entry for removed builder skill");
if (!manifest.files.some((f) => f.path === "skills/knowledge-capture/SKILL.md")) throw new Error("knowledge-capture manifest entry missing");
console.log("ok");
NODE
then
  _pass "deactivate builder: ownership manifest no longer claims builder's files, still claims knowledge's"
else
  _fail "deactivate builder: ownership manifest not updated correctly"
fi
echo ""

# ─── Scenario D: reactivating builder restores skills + active_kits entry ────────────────────
echo "--- Scenario D: kit activate builder restores skill files + active_kits entry ---"

REACT_OUT="$TMPDIR_EVAL/activate-builder.out"
set +e
HOME="$DEACT_HOME" $FA kit activate builder --global >"$REACT_OUT" 2>&1
REACT_RC=$?
set -e

if [[ "$REACT_RC" -eq 0 ]]; then
  _pass "activate builder: exits 0"
else
  _fail "activate builder: expected exit 0, got $REACT_RC"
  cat "$REACT_OUT"
fi

if [[ -f "$DEACT_HOME/.claude/skills/deliver/SKILL.md" ]]; then
  _pass "activate builder: builder skill files restored on disk"
else
  _fail "activate builder: builder skill files missing after reactivation"
fi

if node - "$DEACT_HOME/.claude/.flow-agents/install.json" << 'NODE'
const fs = require("node:fs");
const record = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const ids = record.active_kits.map((k) => k.id).sort();
if (JSON.stringify(ids) !== JSON.stringify(["builder", "knowledge", "release-evidence"])) throw new Error("unexpected ids: " + JSON.stringify(ids));
console.log("ok");
NODE
then
  _pass "activate builder: active_kits restored to all 3 kits"
else
  _fail "activate builder: active_kits not restored"
fi
echo ""

# ─── Scenario E: idempotency ───────────────────────────────────────────────────────────────
echo "--- Scenario E: idempotency (activate-when-active, deactivate-when-inactive) ---"

set +e
HOME="$DEACT_HOME" $FA kit activate builder --global >"$TMPDIR_EVAL/reactivate-idempotent.out" 2>&1
REACT_IDEMPOTENT_RC=$?
set -e
if [[ "$REACT_IDEMPOTENT_RC" -eq 0 ]] && grep -q "already active" "$TMPDIR_EVAL/reactivate-idempotent.out"; then
  _pass "activate builder (already active): exit 0 with 'already active' message"
else
  _fail "activate builder (already active): expected exit 0 + 'already active' message, got exit $REACT_IDEMPOTENT_RC"
  cat "$TMPDIR_EVAL/reactivate-idempotent.out"
fi

IDLE_HOME="$TMPDIR_EVAL/idle-home"
mkdir -p "$IDLE_HOME"
HOME="$IDLE_HOME" $FA init --runtime claude-code --global --yes >/dev/null 2>&1
HOME="$IDLE_HOME" $FA kit deactivate builder --global >/dev/null 2>&1

set +e
HOME="$IDLE_HOME" $FA kit deactivate builder --global >"$TMPDIR_EVAL/deactivate-idempotent.out" 2>&1
DEACT_IDEMPOTENT_RC=$?
set -e
if [[ "$DEACT_IDEMPOTENT_RC" -eq 3 ]]; then
  _pass "deactivate builder (already inactive): exit 3, matching uninstall.ts's nothing-to-do precedent"
else
  _fail "deactivate builder (already inactive): expected exit 3, got $DEACT_IDEMPOTENT_RC"
  cat "$TMPDIR_EVAL/deactivate-idempotent.out"
fi
echo ""

# ─── Scenario F: dependency awareness ─────────────────────────────────────────────────────
echo "--- Scenario F: dependency awareness (deactivate blocked/forced; activate suggests) ---"

DEP_HOME="$TMPDIR_EVAL/dep-home"
mkdir -p "$DEP_HOME"
HOME="$DEP_HOME" $FA init --runtime claude-code --global --yes >/dev/null 2>&1

set +e
HOME="$DEP_HOME" $FA kit deactivate knowledge --global >"$TMPDIR_EVAL/dep-blocked.out" 2>&1
DEP_BLOCKED_RC=$?
set -e
if [[ "$DEP_BLOCKED_RC" -eq 1 ]] && grep -q "dependency of active kit(s): builder" "$TMPDIR_EVAL/dep-blocked.out"; then
  _pass "deactivate knowledge (builder depends on it): blocked with exit 1 and a clear message"
else
  _fail "deactivate knowledge (builder depends on it): expected exit 1 + dependency message, got exit $DEP_BLOCKED_RC"
  cat "$TMPDIR_EVAL/dep-blocked.out"
fi

if [[ -f "$DEP_HOME/.claude/skills/knowledge-capture/SKILL.md" ]]; then
  _pass "deactivate knowledge (blocked): knowledge-capture skill was NOT removed"
else
  _fail "deactivate knowledge (blocked): knowledge-capture skill was removed despite the block"
fi

set +e
HOME="$DEP_HOME" $FA kit deactivate knowledge --global --force >"$TMPDIR_EVAL/dep-forced.out" 2>&1
DEP_FORCED_RC=$?
set -e
if [[ "$DEP_FORCED_RC" -eq 0 ]] && grep -q "warning:.*deactivating 'knowledge'" "$TMPDIR_EVAL/dep-forced.out"; then
  _pass "deactivate knowledge --force: succeeds (exit 0) and prints a warning naming the dependent"
else
  _fail "deactivate knowledge --force: expected exit 0 + warning, got exit $DEP_FORCED_RC"
  cat "$TMPDIR_EVAL/dep-forced.out"
fi

HOME="$DEP_HOME" $FA kit deactivate builder --global --force >/dev/null 2>&1
set +e
HOME="$DEP_HOME" $FA kit activate builder --global >"$TMPDIR_EVAL/dep-suggest.out" 2>&1
DEP_SUGGEST_RC=$?
set -e
if [[ "$DEP_SUGGEST_RC" -eq 0 ]] && grep -q "suggestion:.*dependency on 'knowledge'" "$TMPDIR_EVAL/dep-suggest.out"; then
  _pass "activate builder (knowledge inactive): succeeds and prints a non-blocking suggestion"
else
  _fail "activate builder (knowledge inactive): expected exit 0 + suggestion, got exit $DEP_SUGGEST_RC"
  cat "$TMPDIR_EVAL/dep-suggest.out"
fi
echo ""

# ─── Scenario G: unknown kit id / missing dest ────────────────────────────────────────────
echo "--- Scenario G: unknown kit id and missing --dest/--global both fail with exit 2 ---"

set +e
HOME="$GLOBAL_HOME" $FA kit activate bogus-kit --global >"$TMPDIR_EVAL/unknown-activate.out" 2>&1
UNKNOWN_ACTIVATE_RC=$?
HOME="$GLOBAL_HOME" $FA kit deactivate bogus-kit --global >"$TMPDIR_EVAL/unknown-deactivate.out" 2>&1
UNKNOWN_DEACTIVATE_RC=$?
HOME="$GLOBAL_HOME" $FA kit activate builder >"$TMPDIR_EVAL/missing-dest.out" 2>&1
MISSING_DEST_RC=$?
set -e

if [[ "$UNKNOWN_ACTIVATE_RC" -eq 2 ]] && grep -q "unknown built-in kit 'bogus-kit'" "$TMPDIR_EVAL/unknown-activate.out"; then
  _pass "activate bogus-kit: exit 2 with a clear 'unknown built-in kit' message"
else
  _fail "activate bogus-kit: expected exit 2 + message, got exit $UNKNOWN_ACTIVATE_RC"
fi
if [[ "$UNKNOWN_DEACTIVATE_RC" -eq 2 ]]; then
  _pass "deactivate bogus-kit: exit 2"
else
  _fail "deactivate bogus-kit: expected exit 2, got $UNKNOWN_DEACTIVATE_RC"
fi
if [[ "$MISSING_DEST_RC" -eq 2 ]]; then
  _pass "activate builder (no --dest/--global): exit 2"
else
  _fail "activate builder (no --dest/--global): expected exit 2, got $MISSING_DEST_RC"
fi
echo ""

# ─── Scenario H: --dry-run changes nothing ────────────────────────────────────────────────
echo "--- Scenario H: --dry-run leaves the destination byte-identical ---"

DRYRUN_HOME="$TMPDIR_EVAL/dryrun-home"
mkdir -p "$DRYRUN_HOME"
HOME="$DRYRUN_HOME" $FA init --runtime claude-code --global --yes >/dev/null 2>&1
DRYRUN_BEFORE="$(tree_snapshot "$DRYRUN_HOME")"
HOME="$DRYRUN_HOME" $FA kit deactivate builder --global --dry-run >"$TMPDIR_EVAL/dryrun-deactivate.out" 2>&1
DRYRUN_AFTER="$(tree_snapshot "$DRYRUN_HOME")"

if [[ "$DRYRUN_BEFORE" == "$DRYRUN_AFTER" ]]; then
  _pass "kit deactivate --dry-run: destination is byte-identical before/after"
else
  _fail "kit deactivate --dry-run: destination changed"
  diff <(echo "$DRYRUN_BEFORE") <(echo "$DRYRUN_AFTER") || true
fi
if grep -q "would remove" "$TMPDIR_EVAL/dryrun-deactivate.out"; then
  _pass "kit deactivate --dry-run: reports the removal plan"
else
  _fail "kit deactivate --dry-run: did not report a plan"
fi
echo ""

# ─── Scenario I: catalog-level steering respects active_kits ─────────────────────────────────
echo "--- Scenario I: kit-catalog.js workflowTriggersFor respects active_kits (project-scoped) ---"

STEER_PROJECT="$TMPDIR_EVAL/steer-project"
mkdir -p "$STEER_PROJECT"
(cd "$STEER_PROJECT" && git init -q)
$FA init --runtime claude-code --dest "$STEER_PROJECT" --yes >/dev/null 2>&1

TRIGGERS_ACTIVE="$(node -e "
const { workflowTriggersFor } = require('$STEER_PROJECT/scripts/hooks/lib/kit-catalog.js');
console.log(JSON.stringify(workflowTriggersFor('$STEER_PROJECT', 'implementation-work-detected').map((t) => t.kit_id)));
")"
if [[ "$TRIGGERS_ACTIVE" == '["builder"]' ]]; then
  _pass "kit-catalog.js: builder's workflow_triggers fire while builder is active"
else
  _fail "kit-catalog.js: expected [\"builder\"] with builder active, got $TRIGGERS_ACTIVE"
fi

$FA kit deactivate builder --dest "$STEER_PROJECT" >/dev/null 2>&1
TRIGGERS_DEACTIVATED="$(node -e "
const { workflowTriggersFor } = require('$STEER_PROJECT/scripts/hooks/lib/kit-catalog.js');
console.log(JSON.stringify(workflowTriggersFor('$STEER_PROJECT', 'implementation-work-detected').map((t) => t.kit_id)));
")"
if [[ "$TRIGGERS_DEACTIVATED" == '[]' ]]; then
  _pass "kit-catalog.js: a deactivated builder kit's workflow_triggers are NOT loaded"
else
  _fail "kit-catalog.js: expected [] with builder deactivated, got $TRIGGERS_DEACTIVATED"
fi

$FA kit activate builder --dest "$STEER_PROJECT" >/dev/null 2>&1
TRIGGERS_RESTORED="$(node -e "
const { workflowTriggersFor } = require('$STEER_PROJECT/scripts/hooks/lib/kit-catalog.js');
console.log(JSON.stringify(workflowTriggersFor('$STEER_PROJECT', 'implementation-work-detected').map((t) => t.kit_id)));
")"
if [[ "$TRIGGERS_RESTORED" == '["builder"]' ]]; then
  _pass "kit-catalog.js: reactivating builder restores its workflow_triggers"
else
  _fail "kit-catalog.js: expected [\"builder\"] after reactivation, got $TRIGGERS_RESTORED"
fi

# Legacy record (no active_kits field at all): filtering must fail OPEN -- unchanged behavior.
node - "$STEER_PROJECT/.flow-agents/install.json" << 'NODE'
const fs = require("node:fs");
const p = process.argv[2];
const record = JSON.parse(fs.readFileSync(p, "utf8"));
delete record.active_kits;
fs.writeFileSync(p, `${JSON.stringify(record, null, 2)}\n`, "utf8");
NODE
# Also remove builder's active_kits-derived state has no other effect; builder's skills are
# still on disk (reactivated above), only the record field disappears.
TRIGGERS_LEGACY="$(node -e "
const { workflowTriggersFor } = require('$STEER_PROJECT/scripts/hooks/lib/kit-catalog.js');
console.log(JSON.stringify(workflowTriggersFor('$STEER_PROJECT', 'implementation-work-detected').map((t) => t.kit_id)));
")"
if [[ "$TRIGGERS_LEGACY" == '["builder"]' ]]; then
  _pass "kit-catalog.js: a legacy record (no active_kits field) leaves trigger loading unchanged (fail-open)"
else
  _fail "kit-catalog.js: legacy no-active_kits record unexpectedly changed trigger loading, got $TRIGGERS_LEGACY"
fi
echo ""

# ─── Scenario J: activate preserves a user-modified file across deactivate<->activate ─────────
echo "--- Scenario J: kit activate preserves (never silently clobbers) a file deactivate preserved; --force overwrites ---"

J_HOME="$TMPDIR_EVAL/j-home"
mkdir -p "$J_HOME"
HOME="$J_HOME" $FA init --runtime claude-code --global --yes >/dev/null 2>&1
J_TARGET="$J_HOME/.claude/skills/deliver/SKILL.md"
if [[ ! -f "$J_TARGET" ]]; then
  _fail "activate-preserve: fixture skill deliver/SKILL.md was not installed; cannot run scenario"
else
  printf '\nMY USER EDIT\n' >> "$J_TARGET"
  HOME="$J_HOME" $FA kit deactivate builder --global >/dev/null 2>&1

  J_REACT_OUT="$TMPDIR_EVAL/j-reactivate.out"
  HOME="$J_HOME" $FA kit activate builder --global >"$J_REACT_OUT" 2>&1
  J_REACT_RC=$?

  if [[ "$J_REACT_RC" -eq 0 ]]; then
    _pass "activate (no --force) after deactivate-preserve: exits 0"
  else
    _fail "activate (no --force): expected exit 0, got $J_REACT_RC"
    cat "$J_REACT_OUT"
  fi
  if [[ -f "$J_TARGET" ]] && grep -q 'MY USER EDIT' "$J_TARGET"; then
    _pass "activate (no --force): user's edit to deliver/SKILL.md was NOT clobbered"
  else
    _fail "activate (no --force): user's edit was silently overwritten"
  fi
  if grep -q 'preserved: skills/deliver/SKILL.md' "$J_REACT_OUT" && grep -qi 'NOT overwritten' "$J_REACT_OUT"; then
    _pass "activate (no --force): reports the conflict using uninstall's preserved vocabulary"
  else
    _fail "activate (no --force): did not report the preserved-file conflict"
    cat "$J_REACT_OUT"
  fi

  # Second cycle: deactivate again (still preserves the modified file), then reactivate --force.
  HOME="$J_HOME" $FA kit deactivate builder --global >/dev/null 2>&1
  J_FORCE_OUT="$TMPDIR_EVAL/j-force-activate.out"
  HOME="$J_HOME" $FA kit activate builder --global --force >"$J_FORCE_OUT" 2>&1
  J_FORCE_RC=$?

  if [[ "$J_FORCE_RC" -eq 0 ]]; then
    _pass "activate --force: exits 0"
  else
    _fail "activate --force: expected exit 0, got $J_FORCE_RC"
    cat "$J_FORCE_OUT"
  fi
  if [[ -f "$J_TARGET" ]] && ! grep -q 'MY USER EDIT' "$J_TARGET"; then
    _pass "activate --force: overwrote the user-modified file with canonical content"
  else
    _fail "activate --force: user's edit is still present (force did not overwrite)"
  fi
  if grep -qi "overwritten (--force): skills/deliver/SKILL.md" "$J_FORCE_OUT"; then
    _pass "activate --force: reports the forced overwrite"
  else
    _fail "activate --force: did not report the forced overwrite"
    cat "$J_FORCE_OUT"
  fi
fi
echo ""

# ─── Scenario K: steering filter fail-open on malformed active_kits (+ diagnostic) ────────────
echo "--- Scenario K: kit-catalog.js steering filter fails OPEN on fully-malformed active_kits (with diagnostic); honors valid entries when partially-malformed ---"

K_PROJECT="$TMPDIR_EVAL/k-project"
mkdir -p "$K_PROJECT"
(cd "$K_PROJECT" && git init -q)
$FA init --runtime claude-code --dest "$K_PROJECT" --yes >/dev/null 2>&1

# All-malformed: every active_kits entry lacks a usable id.
node - "$K_PROJECT/.flow-agents/install.json" << 'NODE'
const fs = require("node:fs");
const p = process.argv[2];
const record = JSON.parse(fs.readFileSync(p, "utf8"));
record.active_kits = [{ kit_id: "builder" }, { kit_id: "knowledge" }, {}];
fs.writeFileSync(p, `${JSON.stringify(record, null, 2)}\n`, "utf8");
NODE

K_ALL_MALFORMED_ERR="$TMPDIR_EVAL/k-all-malformed.err"
K_ALL_MALFORMED_OUT="$(node -e "
const { workflowTriggersFor } = require('$K_PROJECT/scripts/hooks/lib/kit-catalog.js');
console.log(JSON.stringify(workflowTriggersFor('$K_PROJECT', 'implementation-work-detected').map((t) => t.kit_id)));
" 2>"$K_ALL_MALFORMED_ERR")"

if [[ "$K_ALL_MALFORMED_OUT" == '["builder"]' ]]; then
  _pass "kit-catalog.js: fully-malformed active_kits fails OPEN -- builder's triggers still load"
else
  _fail "kit-catalog.js: expected [\"builder\"] (fail-open) with fully-malformed active_kits, got $K_ALL_MALFORMED_OUT"
fi
if grep -qi 'WARNING' "$K_ALL_MALFORMED_ERR" && grep -q 'active_kits' "$K_ALL_MALFORMED_ERR"; then
  _pass "kit-catalog.js: fully-malformed active_kits prints a stderr diagnostic naming the corruption"
else
  _fail "kit-catalog.js: no stderr diagnostic for fully-malformed active_kits"
  cat "$K_ALL_MALFORMED_ERR"
fi

# Partially-malformed: one valid entry (builder) alongside malformed ones -- valid entry honored,
# malformed ones skipped individually, and (since a valid decision WAS made) no diagnostic.
node - "$K_PROJECT/.flow-agents/install.json" << 'NODE'
const fs = require("node:fs");
const p = process.argv[2];
const record = JSON.parse(fs.readFileSync(p, "utf8"));
record.active_kits = [
  { id: "builder", version: "0.0.0", activated_at: new Date().toISOString(), scope: "project" },
  { kit_id: "garbage-shape" },
  {},
];
fs.writeFileSync(p, `${JSON.stringify(record, null, 2)}\n`, "utf8");
NODE

K_PARTIAL_ERR="$TMPDIR_EVAL/k-partial.err"
K_PARTIAL_OUT="$(node -e "
const { workflowTriggersFor } = require('$K_PROJECT/scripts/hooks/lib/kit-catalog.js');
console.log(JSON.stringify(workflowTriggersFor('$K_PROJECT', 'implementation-work-detected').map((t) => t.kit_id)));
" 2>"$K_PARTIAL_ERR")"

if [[ "$K_PARTIAL_OUT" == '["builder"]' ]]; then
  _pass "kit-catalog.js: partially-malformed active_kits honors its one valid entry (builder)"
else
  _fail "kit-catalog.js: expected [\"builder\"] with a partially-malformed active_kits, got $K_PARTIAL_OUT"
fi
if [[ ! -s "$K_PARTIAL_ERR" ]]; then
  _pass "kit-catalog.js: partially-malformed active_kits prints no diagnostic (a valid decision was made)"
else
  _fail "kit-catalog.js: unexpected stderr for a partially-malformed active_kits with a valid entry present"
  cat "$K_PARTIAL_ERR"
fi
echo ""

# ─── Scenario L: deactivate apply-time containment re-check (TOCTOU) ─────────────────────────
echo "--- Scenario L: a skill directory swapped for an escaping symlink AFTER planning is preserved, never followed (mirrors test_init_uninstall.sh H4) ---"

L_HOME="$TMPDIR_EVAL/l-home"
mkdir -p "$L_HOME"
HOME="$L_HOME" $FA init --runtime claude-code --global --yes >/dev/null 2>&1

L_SKILL_DIR="$L_HOME/.claude/skills/deliver"
if [[ ! -d "$L_SKILL_DIR" ]]; then
  _fail "deactivate-apply-containment: fixture skill deliver was not installed; cannot run scenario"
else
  L_SAFE_DIR="$TMPDIR_EVAL/l-external-safe"
  mkdir -p "$L_SAFE_DIR"
  cp -a "$L_SKILL_DIR/." "$L_SAFE_DIR/"

  L_OUT="$TMPDIR_EVAL/l-deactivate.out"
  # TEST-ONLY hook: replaces the deliver skill directory -- a plain directory at plan time,
  # captured as a normal removable entry -- with a symlink escaping dest, after planning but
  # before the removal loop runs.
  HOME="$L_HOME" FLOW_AGENTS_KIT_TEST_TOCTOU_SYMLINK_SWAP_PATH="$L_SKILL_DIR" FLOW_AGENTS_KIT_TEST_TOCTOU_SYMLINK_SWAP_TARGET="$L_SAFE_DIR" \
    $FA kit deactivate builder --global >"$L_OUT" 2>&1
  L_RC=$?

  if [[ "$L_RC" -eq 0 ]]; then
    _pass "deactivate-apply-containment: run still exits 0 (a correctly-blocked preserve is not a failure)"
  else
    _fail "deactivate-apply-containment: run exited $L_RC, expected 0"
    cat "$L_OUT"
  fi
  if [[ -f "$L_SAFE_DIR/SKILL.md" ]]; then
    _pass "deactivate-apply-containment: the external directory the symlink now points to survived untouched"
  else
    _fail "deactivate-apply-containment: the external directory was deleted through the swapped symlink"
  fi
  if grep -q 'preserved: skills/deliver/SKILL.md' "$L_OUT" && grep -q 'outside the install root through a symlink' "$L_OUT"; then
    _pass "deactivate-apply-containment: report names the entry as preserved due to the apply-time containment re-check"
  else
    _fail "deactivate-apply-containment: report does not explain why the entry was preserved"
    cat "$L_OUT"
  fi
fi
echo ""

# ─── Scenario M: dry-run accuracy matches the real removed/preserved split ────────────────────
echo "--- Scenario M: kit deactivate --dry-run reports the same removed/preserved split as the real run ---"

M_HOME="$TMPDIR_EVAL/m-home"
mkdir -p "$M_HOME"
HOME="$M_HOME" $FA init --runtime claude-code --global --yes >/dev/null 2>&1
M_TARGET="$M_HOME/.claude/skills/deliver/SKILL.md"
if [[ ! -f "$M_TARGET" ]]; then
  _fail "dry-run-accuracy: fixture skill deliver/SKILL.md was not installed; cannot run scenario"
else
  printf '\nMY USER EDIT\n' >> "$M_TARGET"

  M_DRY_OUT="$TMPDIR_EVAL/m-dry-run.out"
  HOME="$M_HOME" $FA kit deactivate builder --global --dry-run >"$M_DRY_OUT" 2>&1
  M_DRY_REMOVE_COUNT="$(grep -c '^would remove:' "$M_DRY_OUT" || true)"
  M_DRY_PRESERVE_COUNT="$(grep -c '^  would preserve:' "$M_DRY_OUT" || true)"

  if grep -q '^  would preserve: skills/deliver/SKILL.md' "$M_DRY_OUT"; then
    _pass "dry-run-accuracy: dry-run reports the modified file as would-preserve, not would-remove"
  else
    _fail "dry-run-accuracy: dry-run did not report deliver/SKILL.md as preserved"
    cat "$M_DRY_OUT"
  fi
  if ! grep -q '^would remove: skills/deliver/SKILL.md' "$M_DRY_OUT"; then
    _pass "dry-run-accuracy: dry-run does NOT claim it would remove the modified file"
  else
    _fail "dry-run-accuracy: dry-run incorrectly claims it would remove the modified file"
  fi

  M_REAL_OUT="$TMPDIR_EVAL/m-real.out"
  HOME="$M_HOME" $FA kit deactivate builder --global >"$M_REAL_OUT" 2>&1
  M_REAL_REMOVED="$(node -e "const m = '$M_REAL_OUT'; const fs=require('fs'); const t=fs.readFileSync(m,'utf8'); const line = t.split('\n').find((l) => l.startsWith('deactivated kit')); console.log((line.match(/removed (\d+) file/) || [,'?'])[1]);")"
  M_REAL_PRESERVED="$(node -e "const m = '$M_REAL_OUT'; const fs=require('fs'); const t=fs.readFileSync(m,'utf8'); const line = t.split('\n').find((l) => l.startsWith('deactivated kit')); console.log((line.match(/preserved (\d+) modified/) || [,'?'])[1]);")"

  if [[ "$M_DRY_REMOVE_COUNT" == "$M_REAL_REMOVED" && "$M_DRY_PRESERVE_COUNT" == "$M_REAL_PRESERVED" ]]; then
    _pass "dry-run-accuracy: dry-run counts ($M_DRY_REMOVE_COUNT remove / $M_DRY_PRESERVE_COUNT preserve) match the real run ($M_REAL_REMOVED removed / $M_REAL_PRESERVED preserved)"
  else
    _fail "dry-run-accuracy: dry-run counts ($M_DRY_REMOVE_COUNT/$M_DRY_PRESERVE_COUNT) do not match the real run ($M_REAL_REMOVED/$M_REAL_PRESERVED)"
  fi
  if [[ "$M_DRY_PRESERVE_COUNT" -ge 1 ]]; then
    _pass "dry-run-accuracy: at least one file is genuinely reported as preserved (test exercises the real gap)"
  else
    _fail "dry-run-accuracy: no preserved file reported at all -- scenario is not exercising anything"
  fi
fi
echo ""

# ─── Scenario N: active_kit_ids stays coherent with active_kits after each verb ───────────────
echo "--- Scenario N: active_kit_ids stays the exact string[] projection of active_kits' ids after activate/deactivate ---"

assert_ids_coherent() {
  local install_json="$1" label="$2"
  if node - "$install_json" << 'NODE'
const fs = require("node:fs");
const record = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const fromIds = [...record.active_kit_ids].sort();
const fromKits = record.active_kits.map((k) => k.id).sort();
if (JSON.stringify(fromIds) !== JSON.stringify(fromKits)) {
  throw new Error(`active_kit_ids ${JSON.stringify(fromIds)} != active_kits ids ${JSON.stringify(fromKits)}`);
}
console.log("ok");
NODE
  then
    _pass "active_kit_ids/active_kits coherence: $label"
  else
    _fail "active_kit_ids/active_kits coherence: $label"
  fi
}

N_HOME="$TMPDIR_EVAL/n-home"
mkdir -p "$N_HOME"
# Explicit --activate-kit selection at init (matching the r1 review's own live repro): the
# pre-existing default-flags asymmetry (active_kit_ids stays [] while active_kits lists every
# catalog kit) is disclosed in the review as pre-dating this fix and out of its scope -- this
# scenario tests coherence ACROSS activate/deactivate calls, starting from a state where both
# fields already agree.
HOME="$N_HOME" $FA init --runtime claude-code --global --activate-kit builder --activate-kit knowledge --activate-kit release-evidence --yes >/dev/null 2>&1
assert_ids_coherent "$N_HOME/.claude/.flow-agents/install.json" "after fresh init (explicit kit selection)"

HOME="$N_HOME" $FA kit deactivate builder --global >/dev/null 2>&1
assert_ids_coherent "$N_HOME/.claude/.flow-agents/install.json" "after kit deactivate builder"
if node - "$N_HOME/.claude/.flow-agents/install.json" << 'NODE'
const fs = require("node:fs");
const record = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (record.active_kit_ids.includes("builder")) throw new Error("active_kit_ids still lists builder after deactivate");
console.log("ok");
NODE
then
  _pass "active_kit_ids: no longer lists builder after deactivate"
else
  _fail "active_kit_ids: still lists builder after deactivate (stale)"
fi

HOME="$N_HOME" $FA kit activate builder --global >/dev/null 2>&1
assert_ids_coherent "$N_HOME/.claude/.flow-agents/install.json" "after kit activate builder"
echo ""

# ─── Scenario O: corrupt registry entry refuses cleanly BEFORE any file operation ─────────────
echo "--- Scenario O: an unrelated corrupt active_kits entry makes activate/deactivate refuse cleanly, touching zero files ---"

O_DEST="$TMPDIR_EVAL/o-project"
mkdir -p "$O_DEST"
(cd "$O_DEST" && git init -q)
$FA init --runtime claude-code --dest "$O_DEST" --activate-kit builder --yes >/dev/null 2>&1

# Hand-corrupt: duplicate 'builder' entry appended (simulates a bad hand-edit/merge), unrelated
# to 'knowledge', the kit we are about to try to activate.
node - "$O_DEST/.flow-agents/install.json" << 'NODE'
const fs = require("node:fs");
const p = process.argv[2];
const record = JSON.parse(fs.readFileSync(p, "utf8"));
record.active_kits.push({ ...record.active_kits[0] });
fs.writeFileSync(p, `${JSON.stringify(record, null, 2)}\n`, "utf8");
NODE

O_SNAPSHOT_BEFORE="$(tree_snapshot "$O_DEST")"

O_OUT="$TMPDIR_EVAL/o-activate.out"
set +e
$FA kit activate knowledge --dest "$O_DEST" >"$O_OUT" 2>&1
O_RC=$?
set -e

if [[ "$O_RC" -eq 1 ]]; then
  _pass "corrupt-registry: kit activate refuses with a clean, defined exit code (1), not an unhandled exception"
else
  _fail "corrupt-registry: expected exit 1, got $O_RC"
  cat "$O_OUT"
fi
if grep -qi "corrupt" "$O_OUT" && grep -q "duplicate" "$O_OUT" && grep -q "builder" "$O_OUT"; then
  _pass "corrupt-registry: error message names the bad entry (duplicate 'builder') before any change"
else
  _fail "corrupt-registry: error message does not clearly name the corruption"
  cat "$O_OUT"
fi
if grep -Eqi "at .*kit-registry|at .*kit\.js|    at " "$O_OUT"; then
  _fail "corrupt-registry: raw stack trace leaked to output (not a clean error)"
else
  _pass "corrupt-registry: no raw stack trace in the output"
fi

O_SNAPSHOT_AFTER="$(tree_snapshot "$O_DEST")"
if [[ "$O_SNAPSHOT_BEFORE" == "$O_SNAPSHOT_AFTER" ]]; then
  _pass "corrupt-registry: destination is byte-identical before/after -- ZERO files touched"
else
  _fail "corrupt-registry: destination changed despite the refusal"
  diff <(echo "$O_SNAPSHOT_BEFORE") <(echo "$O_SNAPSHOT_AFTER") || true
fi
echo ""

# ─── Scenario P: third-party/local kit steering is never filtered by active_kits ──────────────
echo "--- Scenario P: a locally-installed third-party kit's workflow_triggers are never filtered by active_kits ---"

P_PROJECT="$TMPDIR_EVAL/p-project"
mkdir -p "$P_PROJECT"
(cd "$P_PROJECT" && git init -q)
$FA init --runtime claude-code --dest "$P_PROJECT" --yes >/dev/null 2>&1

mkdir -p "$P_PROJECT/kits/local/repositories/thirdparty-kit"
cat > "$P_PROJECT/kits/local/repositories/thirdparty-kit/kit.json" << 'JSON'
{
  "schema_version": "1.0",
  "id": "thirdparty-kit",
  "name": "Third Party Kit",
  "workflow_triggers": [
    { "id": "thirdparty-trigger", "when": "implementation-work-detected", "target_flow_id": "thirdparty.build" }
  ]
}
JSON
cat > "$P_PROJECT/kits/local/installed-kits.json" << 'JSON'
{
  "schema_version": "1.0",
  "kits": [
    { "id": "thirdparty-kit", "source": "local-fixture", "hash": "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "installed_at": "2026-01-01T00:00:00.000Z", "installed_path": "kits/local/repositories/thirdparty-kit", "state": "installed" }
  ]
}
JSON

P_BEFORE="$(node -e "
const { workflowTriggersFor } = require('$P_PROJECT/scripts/hooks/lib/kit-catalog.js');
console.log(JSON.stringify(workflowTriggersFor('$P_PROJECT', 'implementation-work-detected').map((t) => t.kit_id).sort()));
")"
if [[ "$P_BEFORE" == '["builder","thirdparty-kit"]' ]]; then
  _pass "third-party steering: both the active built-in kit and the local kit's triggers load"
else
  _fail "third-party steering: expected [\"builder\",\"thirdparty-kit\"], got $P_BEFORE"
fi

$FA kit deactivate builder --dest "$P_PROJECT" >/dev/null 2>&1
P_AFTER="$(node -e "
const { workflowTriggersFor } = require('$P_PROJECT/scripts/hooks/lib/kit-catalog.js');
console.log(JSON.stringify(workflowTriggersFor('$P_PROJECT', 'implementation-work-detected').map((t) => t.kit_id).sort()));
")"
if [[ "$P_AFTER" == '["thirdparty-kit"]' ]]; then
  _pass "third-party steering: after deactivating builder, the local kit's trigger STILL loads (never filtered by active_kits)"
else
  _fail "third-party steering: expected [\"thirdparty-kit\"] after deactivating builder, got $P_AFTER"
fi
echo ""

# ─── Scenario Q: symlinked skill DIRECTORY makes activate abort cleanly, never write outside dest ──
echo "--- Scenario Q: kit activate has parent-directory containment parity with kit deactivate (symlinked skill directory) ---"

Q_HOME="$TMPDIR_EVAL/q-home"
mkdir -p "$Q_HOME"
HOME="$Q_HOME" $FA init --runtime claude-code --global --yes >/dev/null 2>&1
HOME="$Q_HOME" $FA kit deactivate builder --global >/dev/null 2>&1

Q_OUTSIDE="$TMPDIR_EVAL/q-outside"
mkdir -p "$Q_OUTSIDE"
# Plant the symlink where deactivate just removed the skill directory -- the directory does not
# exist yet, only the symlink pointing at an external, currently-empty location.
ln -s "$Q_OUTSIDE" "$Q_HOME/.claude/skills/deliver"

Q_SNAPSHOT_BEFORE="$(tree_snapshot "$Q_OUTSIDE")"
Q_OUT="$TMPDIR_EVAL/q-activate.out"
set +e
HOME="$Q_HOME" $FA kit activate builder --global >"$Q_OUT" 2>&1
Q_RC=$?
set -e

if [[ "$Q_RC" -eq 2 ]]; then
  _pass "symlinked-dir activate: clean, defined exit code (2), aborting before any write"
else
  _fail "symlinked-dir activate: expected exit 2, got $Q_RC"
  cat "$Q_OUT"
fi
if grep -q "skills/deliver/SKILL.md" "$Q_OUT" && grep -q "escapes the install root through a symlinked parent directory" "$Q_OUT"; then
  _pass "symlinked-dir activate: error message names the entry and the containment violation"
else
  _fail "symlinked-dir activate: error message does not clearly name the corruption"
  cat "$Q_OUT"
fi
Q_SNAPSHOT_AFTER="$(tree_snapshot "$Q_OUTSIDE")"
if [[ "$Q_SNAPSHOT_BEFORE" == "$Q_SNAPSHOT_AFTER" ]]; then
  _pass "symlinked-dir activate: external tree is byte-identical before/after -- nothing was written outside dest"
else
  _fail "symlinked-dir activate: external tree changed -- a write escaped dest"
  diff <(echo "$Q_SNAPSHOT_BEFORE") <(echo "$Q_SNAPSHOT_AFTER") || true
fi
if node - "$Q_HOME/.claude/.flow-agents/install.json" << 'NODE'
const fs = require("node:fs");
const record = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (record.active_kits.some((k) => k.id === "builder")) throw new Error("builder incorrectly recorded active after an aborted activate");
console.log("ok");
NODE
then
  _pass "symlinked-dir activate: builder is NOT recorded active after the aborted call"
else
  _fail "symlinked-dir activate: builder was incorrectly recorded active despite the abort"
fi
echo ""

# ─── Scenario R: --force on a symlinked destination FILE never follows it ────────────────────
echo "--- Scenario R: --force on a symlinked destination file replaces the symlink with a regular file inside dest, and never follows it externally ---"

R_HOME="$TMPDIR_EVAL/r-home"
mkdir -p "$R_HOME"
HOME="$R_HOME" $FA init --runtime claude-code --global --yes >/dev/null 2>&1
HOME="$R_HOME" $FA kit deactivate builder --global >/dev/null 2>&1

R_VICTIM_DIR="$TMPDIR_EVAL/r-victim"
mkdir -p "$R_VICTIM_DIR"
printf 'SENTINEL-DO-NOT-OVERWRITE\n' > "$R_VICTIM_DIR/victim.txt"
mkdir -p "$R_HOME/.claude/skills/deliver"
R_TARGET="$R_HOME/.claude/skills/deliver/SKILL.md"
ln -s "$R_VICTIM_DIR/victim.txt" "$R_TARGET"

R_OUT="$TMPDIR_EVAL/r-activate-force.out"
set +e
HOME="$R_HOME" $FA kit activate builder --global --force >"$R_OUT" 2>&1
R_RC=$?
set -e

if [[ "$R_RC" -eq 0 ]]; then
  _pass "force-symlinked-file activate: exits 0"
else
  _fail "force-symlinked-file activate: expected exit 0, got $R_RC"
  cat "$R_OUT"
fi
if [[ "$(cat "$R_VICTIM_DIR/victim.txt")" == "SENTINEL-DO-NOT-OVERWRITE" ]]; then
  _pass "force-symlinked-file activate: external victim file the symlink pointed at is untouched"
else
  _fail "force-symlinked-file activate: external victim file was overwritten through the symlink"
fi
if [[ -f "$R_TARGET" && ! -L "$R_TARGET" ]]; then
  _pass "force-symlinked-file activate: destination is now a REAL file (symlink replaced), never followed"
else
  _fail "force-symlinked-file activate: destination is still a symlink (or missing)"
fi
if [[ -f "$R_TARGET" ]] && ! grep -q 'SENTINEL' "$R_TARGET"; then
  _pass "force-symlinked-file activate: destination holds canonical skill content, not the sentinel"
else
  _fail "force-symlinked-file activate: destination does not hold canonical skill content"
fi
if grep -q 'replaced symlink with a regular file (--force): skills/deliver/SKILL.md' "$R_OUT"; then
  _pass "force-symlinked-file activate: report line truthfully names the symlink replacement, not a bare 'overwritten' claim"
else
  _fail "force-symlinked-file activate: report line does not truthfully describe what happened"
  cat "$R_OUT"
fi
echo ""

# ─── Scenario S: poisoned manifest entry makes deactivate fail cleanly, not with a stack trace ─
echo "--- Scenario S: a poisoned manifest entry (parent resolves outside dest) makes kit deactivate fail cleanly, no stack trace, zero files touched ---"

S_HOME="$TMPDIR_EVAL/s-home"
mkdir -p "$S_HOME"
HOME="$S_HOME" $FA init --runtime claude-code --global --yes >/dev/null 2>&1

S_OUTSIDE="$TMPDIR_EVAL/s-outside"
mkdir -p "$S_OUTSIDE"
printf 'poisoned\n' > "$S_OUTSIDE/SKILL.md"
rm -rf "$S_HOME/.claude/skills/deliver"
ln -s "$S_OUTSIDE" "$S_HOME/.claude/skills/deliver"
# Poison the manifest's recorded sha256 for skills/deliver/SKILL.md to any well-formed hex value:
# the plan-time containment check fires before any hash comparison, so the value's correctness is
# irrelevant here -- only its shape needs to pass resolveManifestEntrySha256's format check.
node - "$S_HOME/.claude/.flow-agents/owned-files.json" << 'NODE'
const fs = require("node:fs");
const p = process.argv[2];
const m = JSON.parse(fs.readFileSync(p, "utf8"));
const entry = m.files.find((f) => f.path === "skills/deliver/SKILL.md");
if (!entry) throw new Error("fixture assumption broken: manifest missing skills/deliver/SKILL.md");
entry.sha256 = "0".repeat(64);
fs.writeFileSync(p, `${JSON.stringify(m, null, 2)}\n`, "utf8");
NODE

S_OUT="$TMPDIR_EVAL/s-deactivate.out"
set +e
HOME="$S_HOME" $FA kit deactivate builder --global >"$S_OUT" 2>&1
S_RC=$?
set -e

if [[ "$S_RC" -eq 2 ]]; then
  _pass "poisoned-manifest deactivate: clean, defined exit code (2), matching uninstall.ts's malformed-manifest-entry precedent"
else
  _fail "poisoned-manifest deactivate: expected exit 2, got $S_RC"
  cat "$S_OUT"
fi
if grep -q 'escapes the install root through a symlinked parent directory' "$S_OUT"; then
  _pass "poisoned-manifest deactivate: error message names the containment violation"
else
  _fail "poisoned-manifest deactivate: error message does not explain the failure"
  cat "$S_OUT"
fi
if grep -Eqi "at .*kit-registry|at .*kit\.js|    at " "$S_OUT"; then
  _fail "poisoned-manifest deactivate: raw stack trace leaked to output"
else
  _pass "poisoned-manifest deactivate: no raw stack trace in the output"
fi
if [[ -f "$S_OUTSIDE/SKILL.md" ]] && grep -q 'poisoned' "$S_OUTSIDE/SKILL.md"; then
  _pass "poisoned-manifest deactivate: external tree survived untouched"
else
  _fail "poisoned-manifest deactivate: external tree was touched"
fi
echo ""

# ─── Scenario T: the fully-malformed active_kits diagnostic prints at most once per process ────
echo "--- Scenario T: fully-malformed active_kits stderr diagnostic prints at most once per process invocation ---"

T_PROJECT="$TMPDIR_EVAL/t-project"
mkdir -p "$T_PROJECT"
(cd "$T_PROJECT" && git init -q)
$FA init --runtime claude-code --dest "$T_PROJECT" --yes >/dev/null 2>&1
node - "$T_PROJECT/.flow-agents/install.json" << 'NODE'
const fs = require("node:fs");
const p = process.argv[2];
const record = JSON.parse(fs.readFileSync(p, "utf8"));
record.active_kits = [{ kit_id: "builder" }, {}];
fs.writeFileSync(p, `${JSON.stringify(record, null, 2)}\n`, "utf8");
NODE

T_ERR="$TMPDIR_EVAL/t-dedupe.err"
node -e "
const { workflowTriggersFor } = require('$T_PROJECT/scripts/hooks/lib/kit-catalog.js');
// Mirrors kitWorkflowSteering's multi-category call pattern (workflow-steering.js): a single
// prompt matching BOTH implementation-work-detected and knowledge-capture-detected calls
// workflowTriggersFor (and therefore readActiveBuiltinKitIds) more than once in ONE process.
workflowTriggersFor('$T_PROJECT', 'implementation-work-detected');
workflowTriggersFor('$T_PROJECT', 'knowledge-capture-detected');
workflowTriggersFor('$T_PROJECT', 'implementation-work-detected');
" 2>"$T_ERR"

T_WARNING_COUNT="$(grep -c 'WARNING' "$T_ERR" || true)"
if [[ "$T_WARNING_COUNT" -eq 1 ]]; then
  _pass "dedupe diagnostic: exactly one WARNING printed across 3 workflowTriggersFor calls in the same process"
else
  _fail "dedupe diagnostic: expected exactly 1 WARNING, got $T_WARNING_COUNT"
  cat "$T_ERR"
fi
echo ""

# ─── Scenario U: init with a mixed catalog + third-party --activate-kit selection ─────────────
echo "--- Scenario U: init --activate-kit <catalog-id> --activate-kit <local-third-party-id> succeeds; active_kits holds only catalog ids ---"

U_KIT_SRC="$TMPDIR_EVAL/u-thirdparty-kit-src"
mkdir -p "$U_KIT_SRC/flows"
cat > "$U_KIT_SRC/flows/review.flow.json" << 'JSON'
{"id":"fixture-u.review","version":"1.0","steps":[{"id":"review","next":"done"},{"id":"done","next":null}],"gates":{}}
JSON
cat > "$U_KIT_SRC/kit.json" << 'JSON'
{"schema_version":"1.0","id":"fixture-u","name":"Fixture U","flows":[{"id":"fixture-u.review","path":"flows/review.flow.json"}]}
JSON

U_DEST="$TMPDIR_EVAL/u-project"
mkdir -p "$U_DEST"
(cd "$U_DEST" && git init -q)
U_INSTALL_OUT="$TMPDIR_EVAL/u-kit-install.out"
$FA kit install "$U_KIT_SRC" --dest "$U_DEST" >"$U_INSTALL_OUT" 2>&1
U_INSTALL_RC=$?
if [[ "$U_INSTALL_RC" -eq 0 ]]; then
  _pass "mixed-activate-kit init: local third-party kit installs cleanly (fixture setup)"
else
  _fail "mixed-activate-kit init: local third-party kit install failed, cannot run scenario"
  cat "$U_INSTALL_OUT"
fi

U_INIT_OUT="$TMPDIR_EVAL/u-init.out"
set +e
$FA init --runtime claude-code --dest "$U_DEST" --telemetry-sink local-files --activate-kit builder --activate-kit fixture-u --yes >"$U_INIT_OUT" 2>&1
U_INIT_RC=$?
set -e

if [[ "$U_INIT_RC" -eq 0 ]]; then
  _pass "mixed-activate-kit init: exits 0 (does not crash on the third-party id)"
else
  _fail "mixed-activate-kit init: expected exit 0, got $U_INIT_RC"
  cat "$U_INIT_OUT"
fi
if node - "$U_DEST/.flow-agents/install.json" << 'NODE'
const fs = require("node:fs");
const record = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const activeKitIds = [...record.active_kit_ids].sort();
const activeKitsIds = record.active_kits.map((k) => k.id).sort();
if (JSON.stringify(activeKitIds) !== JSON.stringify(["builder", "fixture-u"])) {
  throw new Error("active_kit_ids should keep the raw unfiltered selection: " + JSON.stringify(activeKitIds));
}
if (JSON.stringify(activeKitsIds) !== JSON.stringify(["builder"])) {
  throw new Error("active_kits should contain ONLY the catalog kit id: " + JSON.stringify(activeKitsIds));
}
console.log("ok");
NODE
then
  _pass "mixed-activate-kit init: active_kit_ids keeps the raw selection, active_kits holds only the catalog id"
else
  _fail "mixed-activate-kit init: active_kits/active_kit_ids do not match the expected catalog-only filtering"
fi

if [[ -f "$U_DEST/kits/local/repositories/fixture-u/kit.json" ]]; then
  _pass "mixed-activate-kit init: the third-party kit's own local registry/repository is unaffected"
else
  _fail "mixed-activate-kit init: the third-party kit's local repository is missing after init"
fi
echo ""

# ─── Scenario V: multi-kit set planning, ordering, no-op, and truthful stop ──────────────────
echo "--- Scenario V: multi-kit activate/deactivate sets are atomic at validation and dependency ordered ---"

V_HOME="$TMPDIR_EVAL/v-home"
mkdir -p "$V_HOME"
HOME="$V_HOME" $FA init --runtime claude-code --global --yes >/dev/null 2>&1
V_DEST="$V_HOME/.claude"

# RED/GREEN power: old single-id dependency logic rejects this exact pair because builder is
# still active when knowledge is considered. The set's POST-state has neither active, so it must
# succeed without --force and report dependent-first ordering.
V_DEACT_OUT="$TMPDIR_EVAL/v-deactivate-pair.out"
set +e
HOME="$V_HOME" $FA kit deactivate knowledge builder --global >"$V_DEACT_OUT" 2>&1
V_DEACT_RC=$?
set -e
if [[ "$V_DEACT_RC" -eq 0 ]] && grep -q "kit deactivate 'builder' (1/2)" "$V_DEACT_OUT" && grep -q "kit deactivate 'knowledge' (2/2)" "$V_DEACT_OUT"; then
  _pass "multi-set POST-state dependency rule: deactivate knowledge+builder succeeds without --force, dependents first (RED/GREEN guard)"
else
  _fail "multi-set POST-state dependency rule/order failed (expected builder then knowledge, rc 0)"
  cat "$V_DEACT_OUT"
fi

V_ACT_OUT="$TMPDIR_EVAL/v-activate-pair.out"
set +e
HOME="$V_HOME" $FA kit activate builder knowledge --global >"$V_ACT_OUT" 2>&1
V_ACT_RC=$?
set -e
if [[ "$V_ACT_RC" -eq 0 ]] && grep -q "kit activate 'knowledge' (1/2)" "$V_ACT_OUT" && grep -q "kit activate 'builder' (2/2)" "$V_ACT_OUT"; then
  _pass "multi-set activate order is dependencies first (knowledge then builder)"
else
  _fail "multi-set activate ordering failed"
  cat "$V_ACT_OUT"
fi

V_SNAPSHOT_BEFORE="$(tree_snapshot "$V_DEST")"
V_INVALID_OUT="$TMPDIR_EVAL/v-invalid.out"
set +e
HOME="$V_HOME" $FA kit deactivate builder not-a-kit --global >"$V_INVALID_OUT" 2>&1
V_INVALID_RC=$?
set -e
V_SNAPSHOT_AFTER="$(tree_snapshot "$V_DEST")"
if [[ "$V_INVALID_RC" -eq 2 ]] && grep -q "not-a-kit" "$V_INVALID_OUT" && [[ "$V_SNAPSHOT_BEFORE" == "$V_SNAPSHOT_AFTER" ]]; then
  _pass "multi-set invalid member refuses the entire set with byte-identical destination (RED/GREEN guard)"
else
  _fail "multi-set invalid-member atomicity failed"
  cat "$V_INVALID_OUT"
fi

# An already-inactive member is skipped while the active member is applied.
HOME="$V_HOME" $FA kit deactivate builder --global >/dev/null 2>&1
V_SKIP_OUT="$TMPDIR_EVAL/v-skip.out"
set +e
HOME="$V_HOME" $FA kit deactivate builder release-evidence --global >"$V_SKIP_OUT" 2>&1
V_SKIP_RC=$?
set -e
if [[ "$V_SKIP_RC" -eq 0 ]] && grep -q "builder.*inactive.*skipped" "$V_SKIP_OUT" && grep -q "deactivated kit 'release-evidence'" "$V_SKIP_OUT"; then
  _pass "multi-set idempotent inactive member is skipped while another member applies"
else
  _fail "multi-set idempotent-member behavior failed"
  cat "$V_SKIP_OUT"
fi

# Restore the fixture then make the second ordered member fail DURING real filesystem removal.
# The earlier member is committed; the failing member must remain registered because its disk
# work is only partial (the old synthetic coordinator stop could not prove this).
HOME="$V_HOME" $FA kit activate builder release-evidence --global >/dev/null 2>&1
V_FAIL_OUT="$TMPDIR_EVAL/v-mid-failure.out"
set +e
HOME="$V_HOME" FLOW_AGENTS_KIT_TEST_FAIL_REMOVE_AFTER=builder $FA kit deactivate release-evidence builder --global >"$V_FAIL_OUT" 2>&1
V_FAIL_RC=$?
set -e
if [[ "$V_FAIL_RC" -eq 4 ]] && grep -q "1 committed, 1 partially_applied, 0 not attempted" "$V_FAIL_OUT" && grep -q "remains registered as active" "$V_FAIL_OUT" && node - "$V_DEST/.flow-agents/install.json" <<'NODE'
const fs = require("node:fs");
const ids = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).active_kits.map((entry) => entry.id);
if (ids.includes("release-evidence") || !ids.includes("builder")) throw new Error(JSON.stringify(ids));
NODE
then
  _pass "multi-set real mid-member removal failure stops the queue and keeps the partial kit registered"
else
  _fail "multi-set real mid-member failure reporting/registry coherence failed"
  cat "$V_FAIL_OUT"
fi

# Restore the partial member before exercising argument and all-noop semantics.
HOME="$V_HOME" $FA kit activate release-evidence --global >/dev/null 2>&1
HOME="$V_HOME" $FA kit deactivate builder --global >/dev/null 2>&1
HOME="$V_HOME" $FA kit activate builder --global >/dev/null 2>&1

set +e
HOME="$V_HOME" $FA kit deactivate builder builder --global >"$TMPDIR_EVAL/v-duplicate.out" 2>&1
V_DUP_RC=$?
HOME="$V_HOME" $FA kit deactivate builder --all --global >"$TMPDIR_EVAL/v-all-positional.out" 2>&1
V_ALL_POSITIONAL_RC=$?
set -e
if [[ "$V_DUP_RC" -eq 2 ]] && grep -q "duplicate kit ids" "$TMPDIR_EVAL/v-duplicate.out"; then
  _pass "multi-set duplicate ids are rejected before apply"
else
  _fail "multi-set duplicate-id rejection failed"
fi
if [[ "$V_ALL_POSITIONAL_RC" -eq 2 ]] && grep -q -- "--all cannot be combined" "$TMPDIR_EVAL/v-all-positional.out"; then
  _pass "kit deactivate --all combined with positional ids is rejected (surviving-mutation guard)"
else
  _fail "kit deactivate --all plus positional id was not rejected"
fi

V_THROW_OUT="$TMPDIR_EVAL/v-throw.out"
set +e
HOME="$V_HOME" FLOW_AGENTS_KIT_TEST_THROW_APPLY_KIT=builder $FA kit deactivate release-evidence builder --global >"$V_THROW_OUT" 2>&1
V_THROW_RC=$?
set -e
if [[ "$V_THROW_RC" -eq 4 ]] && grep -q "apply threw: test-injected apply exception" "$V_THROW_OUT" && grep -q "1 committed, 1 partially_applied" "$V_THROW_OUT"; then
  _pass "multi-set thrown member exception is caught and reported in the structured summary"
else
  _fail "multi-set thrown member exception escaped the structured summary"
  cat "$V_THROW_OUT"
fi

V_ALL_OUT="$TMPDIR_EVAL/v-all.out"
set +e
HOME="$V_HOME" $FA kit deactivate --all --global >"$V_ALL_OUT" 2>&1
V_ALL_RC=$?
set -e
if [[ "$V_ALL_RC" -eq 0 ]] && node - "$V_DEST/.flow-agents/install.json" <<'NODE'
const fs = require("node:fs");
if (JSON.parse(fs.readFileSync(process.argv[2], "utf8")).active_kits.length !== 0) throw new Error("active kits remain");
NODE
then
  _pass "kit deactivate --all deactivates every currently active built-in kit"
else
  _fail "kit deactivate --all failed"
  cat "$V_ALL_OUT"
fi

set +e
HOME="$V_HOME" $FA kit deactivate --all --global >"$TMPDIR_EVAL/v-all-noop.out" 2>&1
V_ALL_NOOP_RC=$?
set -e
if [[ "$V_ALL_NOOP_RC" -eq 3 ]]; then
  _pass "kit deactivate --all exits 3 when every member is already inactive"
else
  _fail "kit deactivate --all noop expected exit 3, got $V_ALL_NOOP_RC"
fi
echo ""

echo "==========================="
total=$((pass + fail))
echo "Results: ${pass}/${total} passed, ${fail} failed"
[[ "$fail" -gt 0 ]] && exit 1
exit 0
