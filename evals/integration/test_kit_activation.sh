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

echo "==========================="
total=$((pass + fail))
echo "Results: ${pass}/${total} passed, ${fail} failed"
[[ "$fail" -gt 0 ]] && exit 1
exit 0
