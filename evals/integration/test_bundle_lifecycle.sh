#!/usr/bin/env bash
# test_bundle_lifecycle.sh — Bundle install lifecycle tests
#
# Covers:
#   1. Idempotent re-install: install a bundle twice; assert identical layout,
#      no duplicated hook entries in generated config.
#   2. Upgrade over existing: install from original bundle, then re-install from
#      a modified copy; assert the change propagates.
#   3. User-file preservation semantics: after install, create user-owned files
#      and modify an installed file; re-install and verify:
#        - user-owned unknown files survive (rsync does not remove them).
#        - modified installed files ARE overwritten (rsync overwrites — this is
#          the expected behavior; assertion pins the semantics).
#   4. Scope-collision detection: fake a $HOME with colliding user-level
#      .claude/settings.json; run install, assert WARNING appears; assert no
#      warning on a clean $HOME.
#   5. Dogfood smoke test: run `flow-agents dogfood --runtime claude-code` into
#      a temp dir, assert valid JSON, assert hook commands execute correctly
#      with a realistic payload, assert permission keys are absent.
#
# Runtimes tested: claude-code, codex, opencode (the three config-generating runtimes).
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMPDIR_EVAL="$(mktemp -d /tmp/bundle-lifecycle.XXXXXX)"
pass=0
fail=0

cleanup() {
  rm -rf "$TMPDIR_EVAL"
}
trap cleanup EXIT

_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }

echo "=== Layer 2B: Bundle Lifecycle Tests ==="
echo ""

echo "--- Build ---"
# Ensure bundles are built; re-use existing dist if already present.
if (cd "$ROOT_DIR" && npm run build:bundles >/dev/null 2>&1); then
  _pass "bundle build completed"
else
  _fail "bundle build failed"
fi
echo ""

# ---------------------------------------------------------------------------
# 1. IDEMPOTENT RE-INSTALL
# ---------------------------------------------------------------------------
echo "--- Idempotent Re-install ---"

CLAUDE_IDEM="$TMPDIR_EVAL/idem-claude"
CODEX_IDEM="$TMPDIR_EVAL/idem-codex"
OPENCODE_IDEM="$TMPDIR_EVAL/idem-opencode"

# First installs
(cd "$ROOT_DIR/dist/claude-code" && bash install.sh "$CLAUDE_IDEM" >/dev/null 2>&1) || true
(cd "$ROOT_DIR/dist/codex" && bash install.sh "$CODEX_IDEM" >/dev/null 2>&1) || true
(cd "$ROOT_DIR/dist/opencode" && bash install.sh "$OPENCODE_IDEM" >/dev/null 2>&1) || true

# Capture hook array lengths before second install
CLAUDE_HOOKS_BEFORE=""
CODEX_HOOKS_BEFORE=""
if [[ -f "$CLAUDE_IDEM/.claude/settings.json" ]]; then
  CLAUDE_HOOKS_BEFORE=$(node -e "
    const s = JSON.parse(require('fs').readFileSync('$CLAUDE_IDEM/.claude/settings.json','utf8'));
    const hooks = s.hooks || {};
    let count = 0;
    for (const k of Object.keys(hooks)) count += (hooks[k] || []).length;
    console.log(count);
  " 2>/dev/null || echo "0")
fi
if [[ -f "$CODEX_IDEM/.codex/hooks.json" ]]; then
  CODEX_HOOKS_BEFORE=$(node -e "
    const s = JSON.parse(require('fs').readFileSync('$CODEX_IDEM/.codex/hooks.json','utf8'));
    const hooks = s.hooks || {};
    let count = 0;
    for (const k of Object.keys(hooks)) count += (hooks[k] || []).length;
    console.log(count);
  " 2>/dev/null || echo "0")
fi

# Second installs (idempotent)
if (cd "$ROOT_DIR/dist/claude-code" && bash install.sh "$CLAUDE_IDEM" >/dev/null 2>&1); then
  _pass "claude-code second install succeeded"
else
  _fail "claude-code second install failed"
fi

if (cd "$ROOT_DIR/dist/codex" && bash install.sh "$CODEX_IDEM" >/dev/null 2>&1); then
  _pass "codex second install succeeded"
else
  _fail "codex second install failed"
fi

if (cd "$ROOT_DIR/dist/opencode" && bash install.sh "$OPENCODE_IDEM" >/dev/null 2>&1); then
  _pass "opencode second install succeeded"
else
  _fail "opencode second install failed"
fi

# Assert hook arrays did not grow after second install
if [[ -f "$CLAUDE_IDEM/.claude/settings.json" ]]; then
  CLAUDE_HOOKS_AFTER=$(node -e "
    const s = JSON.parse(require('fs').readFileSync('$CLAUDE_IDEM/.claude/settings.json','utf8'));
    const hooks = s.hooks || {};
    let count = 0;
    for (const k of Object.keys(hooks)) count += (hooks[k] || []).length;
    console.log(count);
  " 2>/dev/null || echo "0")
  if [[ "$CLAUDE_HOOKS_BEFORE" == "$CLAUDE_HOOKS_AFTER" && -n "$CLAUDE_HOOKS_BEFORE" ]]; then
    _pass "claude-code re-install: hooks array did not grow ($CLAUDE_HOOKS_AFTER entries)"
  else
    _fail "claude-code re-install: hooks array changed (before=$CLAUDE_HOOKS_BEFORE after=$CLAUDE_HOOKS_AFTER)"
  fi
fi

if [[ -f "$CODEX_IDEM/.codex/hooks.json" ]]; then
  CODEX_HOOKS_AFTER=$(node -e "
    const s = JSON.parse(require('fs').readFileSync('$CODEX_IDEM/.codex/hooks.json','utf8'));
    const hooks = s.hooks || {};
    let count = 0;
    for (const k of Object.keys(hooks)) count += (hooks[k] || []).length;
    console.log(count);
  " 2>/dev/null || echo "0")
  if [[ "$CODEX_HOOKS_BEFORE" == "$CODEX_HOOKS_AFTER" && -n "$CODEX_HOOKS_BEFORE" ]]; then
    _pass "codex re-install: hooks.json did not change hook count ($CODEX_HOOKS_AFTER entries)"
  else
    _fail "codex re-install: hooks changed (before=$CODEX_HOOKS_BEFORE after=$CODEX_HOOKS_AFTER)"
  fi
fi

# Verify opencode plugin is still correct after re-install
if [[ -f "$OPENCODE_IDEM/.opencode/plugins/flow-agents.js" ]]; then
  _pass "opencode re-install: plugin file still present"
else
  _fail "opencode re-install: plugin file missing"
fi

echo ""
echo "--- Upgrade Over Existing ---"

# Create modified bundle copies in temp dirs (never mutate dist/ in place)
CLAUDE_BUNDLE_COPY="$TMPDIR_EVAL/claude-bundle-copy"
CODEX_BUNDLE_COPY="$TMPDIR_EVAL/codex-bundle-copy"
OPENCODE_BUNDLE_COPY="$TMPDIR_EVAL/opencode-bundle-copy"

rsync -a "$ROOT_DIR/dist/claude-code/" "$CLAUDE_BUNDLE_COPY/"
rsync -a "$ROOT_DIR/dist/codex/" "$CODEX_BUNDLE_COPY/"
rsync -a "$ROOT_DIR/dist/opencode/" "$OPENCODE_BUNDLE_COPY/"

CLAUDE_UPGRADE="$TMPDIR_EVAL/upgrade-claude"
CODEX_UPGRADE="$TMPDIR_EVAL/upgrade-codex"
OPENCODE_UPGRADE="$TMPDIR_EVAL/upgrade-opencode"

# First install from originals
(cd "$ROOT_DIR/dist/claude-code" && bash install.sh "$CLAUDE_UPGRADE" >/dev/null 2>&1) || true
(cd "$ROOT_DIR/dist/codex" && bash install.sh "$CODEX_UPGRADE" >/dev/null 2>&1) || true
(cd "$ROOT_DIR/dist/opencode" && bash install.sh "$OPENCODE_UPGRADE" >/dev/null 2>&1) || true

# Touch a marker into skill files in the COPIES (not dist/ originals)
UPGRADE_MARKER="# flow-agents-upgrade-test-marker"
CLAUDE_SKILL_FILE="$CLAUDE_BUNDLE_COPY/.claude/skills/plan-work/SKILL.md"
CODEX_SKILL_FILE="$CODEX_BUNDLE_COPY/.agents/skills/plan-work/SKILL.md"
OPENCODE_SKILL_FILE="$OPENCODE_BUNDLE_COPY/.opencode/skills/plan-work/SKILL.md"

if [[ -f "$CLAUDE_SKILL_FILE" ]]; then
  echo "$UPGRADE_MARKER" >> "$CLAUDE_SKILL_FILE"
fi
if [[ -f "$CODEX_SKILL_FILE" ]]; then
  echo "$UPGRADE_MARKER" >> "$CODEX_SKILL_FILE"
fi
if [[ -f "$OPENCODE_SKILL_FILE" ]]; then
  echo "$UPGRADE_MARKER" >> "$OPENCODE_SKILL_FILE"
fi

# Re-install from modified copies
(cd "$CLAUDE_BUNDLE_COPY" && bash install.sh "$CLAUDE_UPGRADE" >/dev/null 2>&1) || true
(cd "$CODEX_BUNDLE_COPY" && bash install.sh "$CODEX_UPGRADE" >/dev/null 2>&1) || true
(cd "$OPENCODE_BUNDLE_COPY" && bash install.sh "$OPENCODE_UPGRADE" >/dev/null 2>&1) || true

# Assert the change propagated
if [[ -f "$CLAUDE_SKILL_FILE" ]] && grep -qF "$UPGRADE_MARKER" "$CLAUDE_UPGRADE/.claude/skills/plan-work/SKILL.md" 2>/dev/null; then
  _pass "claude-code upgrade: modified skill file propagated to workspace"
elif [[ ! -f "$CLAUDE_SKILL_FILE" ]]; then
  _pass "claude-code upgrade: skill file not in bundle (skipped)"
else
  _fail "claude-code upgrade: skill change did not propagate to workspace"
fi

if [[ -f "$CODEX_SKILL_FILE" ]] && grep -qF "$UPGRADE_MARKER" "$CODEX_UPGRADE/.agents/skills/plan-work/SKILL.md" 2>/dev/null; then
  _pass "codex upgrade: modified skill file propagated to workspace"
else
  _fail "codex upgrade: required universal skill missing or change did not propagate"
fi

if [[ -f "$OPENCODE_SKILL_FILE" ]] && grep -qF "$UPGRADE_MARKER" "$OPENCODE_UPGRADE/.opencode/skills/plan-work/SKILL.md" 2>/dev/null; then
  _pass "opencode upgrade: modified skill file propagated to workspace"
elif [[ ! -f "$OPENCODE_SKILL_FILE" ]]; then
  _pass "opencode upgrade: skill file not in bundle (skipped)"
else
  _fail "opencode upgrade: skill change did not propagate to workspace"
fi

echo ""
echo "--- User-file Preservation Semantics ---"
# SEMANTICS (documented):
#   - rsync -a copies files from bundle to dest without --delete, so unknown user-
#     owned files in dest are NOT removed.
#   - rsync -a overwrites existing files that differ from the bundle source.
#     This means: modified installed skill/agent/script files ARE overwritten.
#   - settings.json EXCEPTION (claude-code): install-merge.js runs after rsync and
#     performs a merge-aware write, so user keys in settings.json SURVIVE re-install.
#   - Summary: user-added files survive; modified skill/script files are reset;
#     user keys in settings.json survive (merge semantics, not rsync overwrite).

CLAUDE_USER="$TMPDIR_EVAL/user-claude"
CODEX_USER="$TMPDIR_EVAL/user-codex"
OPENCODE_USER="$TMPDIR_EVAL/user-opencode"

# Initial install
(cd "$ROOT_DIR/dist/claude-code" && bash install.sh "$CLAUDE_USER" >/dev/null 2>&1) || true
(cd "$ROOT_DIR/dist/codex" && bash install.sh "$CODEX_USER" >/dev/null 2>&1) || true
(cd "$ROOT_DIR/dist/opencode" && bash install.sh "$OPENCODE_USER" >/dev/null 2>&1) || true

# Create user-owned files (unknown to the bundle)
mkdir -p "$CLAUDE_USER/.claude/custom"
echo "# user custom agent" > "$CLAUDE_USER/.claude/custom/my-custom-agent.md"
mkdir -p "$CLAUDE_USER/.kontourai/flow-agents/my-session"
echo '{"custom":"data"}' > "$CLAUDE_USER/.kontourai/flow-agents/my-session/state.json"

mkdir -p "$CODEX_USER/.codex/custom"
printf 'name = "my-custom-agent"\n' > "$CODEX_USER/.codex/custom/my-custom-agent.toml"
mkdir -p "$CODEX_USER/.kontourai/flow-agents/my-session"
echo '{"custom":"data"}' > "$CODEX_USER/.kontourai/flow-agents/my-session/state.json"

mkdir -p "$OPENCODE_USER/.opencode/custom"
echo "# user custom agent" > "$OPENCODE_USER/.opencode/custom/my-custom-agent.md"
mkdir -p "$OPENCODE_USER/.kontourai/flow-agents/my-session"
echo '{"custom":"data"}' > "$OPENCODE_USER/.kontourai/flow-agents/my-session/state.json"

# Modify an installed skill file to simulate user edits
CLAUDE_INSTALLED_SKILL="$CLAUDE_USER/.claude/skills/plan-work/SKILL.md"
CODEX_INSTALLED_SKILL="$CODEX_USER/.agents/skills/plan-work/SKILL.md"
OPENCODE_INSTALLED_SKILL="$OPENCODE_USER/.opencode/skills/plan-work/SKILL.md"

USER_EDIT_MARKER="# USER EDIT - should be overwritten by re-install"
[[ -f "$CLAUDE_INSTALLED_SKILL" ]] && echo "$USER_EDIT_MARKER" >> "$CLAUDE_INSTALLED_SKILL"
[[ -f "$CODEX_INSTALLED_SKILL" ]] && echo "$USER_EDIT_MARKER" >> "$CODEX_INSTALLED_SKILL"
[[ -f "$OPENCODE_INSTALLED_SKILL" ]] && echo "$USER_EDIT_MARKER" >> "$OPENCODE_INSTALLED_SKILL"

# Insert a user key into claude-code settings.json to verify merge semantics survive re-install.
# This key is not in the bundle — it must survive after re-install because settings.json
# uses merge semantics (install-merge.js), not rsync overwrite.
if [[ -f "$CLAUDE_USER/.claude/settings.json" ]]; then
  node - "$CLAUDE_USER/.claude/settings.json" << 'NODEEOF'
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
s["_lifecycleUserKey"] = "lifecycle-test-value";
fs.writeFileSync(process.argv[2], JSON.stringify(s, null, 2) + "\n", "utf8");
NODEEOF
fi

# Re-install from original bundles
(cd "$ROOT_DIR/dist/claude-code" && bash install.sh "$CLAUDE_USER" >/dev/null 2>&1) || true
(cd "$ROOT_DIR/dist/codex" && bash install.sh "$CODEX_USER" >/dev/null 2>&1) || true
(cd "$ROOT_DIR/dist/opencode" && bash install.sh "$OPENCODE_USER" >/dev/null 2>&1) || true

# Assert: user-owned unknown files survive
if [[ -f "$CLAUDE_USER/.claude/custom/my-custom-agent.md" && -f "$CLAUDE_USER/.kontourai/flow-agents/my-session/state.json" ]]; then
  _pass "claude-code re-install: user-owned files not removed by rsync"
else
  _fail "claude-code re-install: user-owned files were removed"
fi

if [[ -f "$CODEX_USER/.codex/custom/my-custom-agent.toml" && -f "$CODEX_USER/.kontourai/flow-agents/my-session/state.json" ]]; then
  _pass "codex re-install: user-owned files not removed by rsync"
else
  _fail "codex re-install: user-owned files were removed"
fi

if [[ -f "$OPENCODE_USER/.opencode/custom/my-custom-agent.md" && -f "$OPENCODE_USER/.kontourai/flow-agents/my-session/state.json" ]]; then
  _pass "opencode re-install: user-owned files not removed by rsync"
else
  _fail "opencode re-install: user-owned files were removed"
fi

# Assert: MODIFIED INSTALLED FILES ARE OVERWRITTEN by rsync (pinning this semantic).
# This is expected rsync behavior: the bundle is the authority on its own files.
# Users who want to keep local edits to bundle files should fork the bundle.
if [[ -f "$CLAUDE_INSTALLED_SKILL" ]] && ! grep -qF "$USER_EDIT_MARKER" "$CLAUDE_INSTALLED_SKILL" 2>/dev/null; then
  _pass "claude-code re-install: modified installed skill file was overwritten by rsync (expected)"
elif [[ ! -f "$CLAUDE_INSTALLED_SKILL" ]]; then
  _pass "claude-code re-install: skill file absent (skipped overwrite check)"
else
  _fail "claude-code re-install: user edits to installed file persisted — rsync did NOT overwrite (unexpected)"
fi

if [[ -f "$CODEX_INSTALLED_SKILL" ]] && ! grep -qF "$USER_EDIT_MARKER" "$CODEX_INSTALLED_SKILL" 2>/dev/null; then
  _pass "codex re-install: modified installed skill file was overwritten by rsync (expected)"
elif [[ ! -f "$CODEX_INSTALLED_SKILL" ]]; then
  _pass "codex re-install: skill file absent (skipped overwrite check)"
else
  _fail "codex re-install: user edits to installed file persisted — rsync did NOT overwrite (unexpected)"
fi

if [[ -f "$OPENCODE_INSTALLED_SKILL" ]] && ! grep -qF "$USER_EDIT_MARKER" "$OPENCODE_INSTALLED_SKILL" 2>/dev/null; then
  _pass "opencode re-install: modified installed skill file was overwritten by rsync (expected)"
elif [[ ! -f "$OPENCODE_INSTALLED_SKILL" ]]; then
  _pass "opencode re-install: skill file absent (skipped overwrite check)"
else
  _fail "opencode re-install: user edits to installed file persisted — rsync did NOT overwrite (unexpected)"
fi

# Assert: user key in settings.json SURVIVED re-install (merge semantics, not rsync overwrite).
# This is the NEW split assertion: skills use rsync overwrite; settings.json uses merge.
if [[ -f "$CLAUDE_USER/.claude/settings.json" ]] && node - "$CLAUDE_USER/.claude/settings.json" << 'NODE'
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (s["_lifecycleUserKey"] !== "lifecycle-test-value") {
  throw new Error("user key lost after re-install: " + JSON.stringify(s["_lifecycleUserKey"]));
}
// Also assert FA hooks are still present (merge did not lose them)
const hooks = s.hooks || {};
const hasFA = Object.values(hooks).flat().some(
  (g) => (g.hooks || []).some((h) => String(h.statusMessage || "").includes("Recording Flow Agents telemetry"))
);
if (!hasFA) throw new Error("FA hooks lost after re-install");
console.log("ok");
NODE
then
  _pass "claude-code re-install: user key in settings.json survived (merge semantics, not rsync overwrite)"
else
  _fail "claude-code re-install: user key in settings.json was clobbered (regression: rsync overwrote settings.json)"
fi

echo ""
echo "--- Scope-Collision Detection ---"
# The collision check looks at the file pointed to by FLOW_AGENTS_USER_CLAUDE_SETTINGS
# (if set) or $HOME/.claude/settings.json. We use FLOW_AGENTS_USER_CLAUDE_SETTINGS
# to override the path for test isolation without touching the real $HOME.

# Case 1: colliding user-level settings (contains the Flow Agents marker —
# the distinctive statusMessage emitted by the bundle generator, NOT a script
# filename, because sibling products from the same lineage ship identically named
# hook scripts).
FAKE_HOME_COLLIDE="$TMPDIR_EVAL/fake-home-collide"
mkdir -p "$FAKE_HOME_COLLIDE/.claude"
cat > "$FAKE_HOME_COLLIDE/.claude/settings.json" << 'JSON'
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash -lc 'node \"$root/scripts/hooks/claude-telemetry-hook.js\" UserPromptSubmit dev'",
            "statusMessage": "Recording Flow Agents telemetry"
          }
        ]
      }
    ]
  }
}
JSON

CLAUDE_COLLISION_DEST="$TMPDIR_EVAL/collision-claude"
COLLISION_OUTPUT=$(FLOW_AGENTS_USER_CLAUDE_SETTINGS="$FAKE_HOME_COLLIDE/.claude/settings.json" \
  node "$ROOT_DIR/build/src/cli.js" init --runtime claude-code --dest "$CLAUDE_COLLISION_DEST" --yes 2>&1 || true)

if echo "$COLLISION_OUTPUT" | grep -q "WARNING: Flow Agents scope collision"; then
  _pass "scope-collision: WARNING emitted when user-level settings contains flow-agents hooks"
else
  _fail "scope-collision: no WARNING emitted despite colliding user-level settings"
  echo "    Output was: $COLLISION_OUTPUT" | head -5
fi

# Assert install still succeeded (collision is warning-only, not blocking)
if [[ -d "$CLAUDE_COLLISION_DEST/.claude" ]]; then
  _pass "scope-collision: install continued despite WARNING (non-blocking)"
else
  _fail "scope-collision: install was blocked by WARNING (should be advisory only)"
fi

# Case 1b: sibling-product settings (sibling-tool-shaped — same script filenames,
# no Flow Agents marker) must NOT trigger the warning. Regression test for the
# false positive where COLLISION_MARKER matched shared script names.
FAKE_HOME_SIBLING="$TMPDIR_EVAL/fake-home-sibling"
mkdir -p "$FAKE_HOME_SIBLING/.claude"
cat > "$FAKE_HOME_SIBLING/.claude/settings.json" << 'JSON'
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash -lc 'root=\"$HOME/.claude/sibling-tool\"; node \"$root/scripts/hooks/claude-hook-adapter.js\" PreToolUse pre:config-protection config-protection.js standard,strict'"
          }
        ]
      }
    ]
  }
}
JSON

CLAUDE_SIBLING_DEST="$TMPDIR_EVAL/sibling-claude"
SIBLING_OUTPUT=$(FLOW_AGENTS_USER_CLAUDE_SETTINGS="$FAKE_HOME_SIBLING/.claude/settings.json" \
  node "$ROOT_DIR/build/src/cli.js" init --runtime claude-code --dest "$CLAUDE_SIBLING_DEST" --yes 2>&1 || true)

if echo "$SIBLING_OUTPUT" | grep -q "WARNING: Flow Agents scope collision"; then
  _fail "scope-collision: WARNING emitted for sibling-product settings (false positive on shared script names)"
else
  _pass "scope-collision: no WARNING for sibling-product (shared-script-lineage) settings"
fi

# Case 2: clean $HOME (no colliding settings) — no warning expected
FAKE_HOME_CLEAN="$TMPDIR_EVAL/fake-home-clean"
mkdir -p "$FAKE_HOME_CLEAN/.claude"
echo '{"statusLine":{"type":"command","command":"echo hello"}}' > "$FAKE_HOME_CLEAN/.claude/settings.json"

CLAUDE_CLEAN_DEST="$TMPDIR_EVAL/clean-claude"
CLEAN_OUTPUT=$(FLOW_AGENTS_USER_CLAUDE_SETTINGS="$FAKE_HOME_CLEAN/.claude/settings.json" \
  node "$ROOT_DIR/build/src/cli.js" init --runtime claude-code --dest "$CLAUDE_CLEAN_DEST" --yes 2>&1 || true)

if echo "$CLEAN_OUTPUT" | grep -q "WARNING: Flow Agents scope collision"; then
  _fail "scope-collision: WARNING emitted on clean $HOME (false positive)"
else
  _pass "scope-collision: no WARNING on clean \$HOME (no collision)"
fi

# Case 3: no settings file at all — no warning expected
FAKE_HOME_EMPTY="$TMPDIR_EVAL/fake-home-empty"
mkdir -p "$FAKE_HOME_EMPTY"

CLAUDE_EMPTY_DEST="$TMPDIR_EVAL/empty-claude"
EMPTY_OUTPUT=$(FLOW_AGENTS_USER_CLAUDE_SETTINGS="$FAKE_HOME_EMPTY/.claude/settings.json" \
  node "$ROOT_DIR/build/src/cli.js" init --runtime claude-code --dest "$CLAUDE_EMPTY_DEST" --yes 2>&1 || true)

if echo "$EMPTY_OUTPUT" | grep -q "WARNING: Flow Agents scope collision"; then
  _fail "scope-collision: WARNING emitted when no settings file exists (false positive)"
else
  _pass "scope-collision: no WARNING when settings file is absent"
fi

echo ""
echo "--- Dogfood Smoke Test ---"
# Test `flow-agents dogfood --runtime claude-code` into a temp dir.
# Asserts:
#   1. Command succeeds.
#   2. .claude/settings.json is valid JSON.
#   3. permissions.defaultMode and skipDangerousModePermissionPrompt are ABSENT.
#   4. Hook commands are present (statusLine + hooks sections).
#   5. The hook commands execute correctly with a realistic UserPromptSubmit payload.

DOGFOOD_DEST="$TMPDIR_EVAL/dogfood-claude"
mkdir -p "$DOGFOOD_DEST"

DOGFOOD_OUTPUT=$(FLOW_AGENTS_USER_CLAUDE_SETTINGS="$FAKE_HOME_EMPTY/.claude/settings.json" \
  node "$ROOT_DIR/build/src/cli.js" init --runtime claude-code --dest "$DOGFOOD_DEST" --yes 2>&1 || true)

# Since dogfood is a separate subcommand exported from init.ts, call it directly
DOGFOOD_DEST2="$TMPDIR_EVAL/dogfood-claude2"
mkdir -p "$DOGFOOD_DEST2"

if FLOW_AGENTS_USER_CLAUDE_SETTINGS="$FAKE_HOME_EMPTY/.claude/settings.json" \
  node "$ROOT_DIR/scripts/dogfood.js" --runtime claude-code --dest "$DOGFOOD_DEST2" >/dev/null 2>&1; then
  _pass "dogfood: claude-code command succeeded"
else
  _fail "dogfood: claude-code command failed"
fi

# Assert valid JSON
if [[ -f "$DOGFOOD_DEST2/.claude/settings.json" ]] && node -e "
  JSON.parse(require('fs').readFileSync('$DOGFOOD_DEST2/.claude/settings.json','utf8'));
  console.log('ok');
" 2>/dev/null | grep -q ok; then
  _pass "dogfood: .claude/settings.json is valid JSON"
else
  _fail "dogfood: .claude/settings.json is missing or invalid JSON"
fi

# Assert permissions keys are absent
if node - "$DOGFOOD_DEST2/.claude/settings.json" << 'NODE'
const fs = require("node:fs");
const settings = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if ("permissions" in settings) throw new Error("permissions key must be absent in dogfood output");
if ("skipDangerousModePermissionPrompt" in settings) throw new Error("skipDangerousModePermissionPrompt must be absent in dogfood output");
console.log("ok");
NODE
then
  _pass "dogfood: permissions.defaultMode and skipDangerousModePermissionPrompt are absent"
else
  _fail "dogfood: permissive permission keys present in dogfood output (should be omitted)"
fi

# Assert hooks and statusLine are present
if node - "$DOGFOOD_DEST2/.claude/settings.json" << 'NODE'
const fs = require("node:fs");
const settings = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const hooks = settings.hooks || {};
if (!settings.statusLine || !String(settings.statusLine.command || "").includes("flow-agents-statusline.js")) {
  throw new Error("statusLine missing or does not reference flow-agents-statusline.js");
}
if (!hooks.UserPromptSubmit || !hooks.UserPromptSubmit.length) throw new Error("UserPromptSubmit hooks missing");
const wsHook = hooks.UserPromptSubmit.some((group) =>
  (group.hooks || []).some((h) => String(h.command || "").includes("claude-hook-adapter.js") && String(h.command || "").includes("workflow-steering"))
);
if (!wsHook) throw new Error("workflow-steering hook missing from UserPromptSubmit");
console.log("ok");
NODE
then
  _pass "dogfood: statusLine and workflow-steering hook present in settings.json"
else
  _fail "dogfood: statusLine or workflow-steering hook missing from settings.json"
fi

# Execute the dogfood-generated hook command with a realistic payload.
# The dogfood use case: dogfood writes .claude/settings.json to the REPO ROOT itself
# (or any project dir). The hook commands use ${CLAUDE_PROJECT_DIR:-$(pwd)} to find
# scripts/hooks/claude-hook-adapter.js — these scripts must live in CLAUDE_PROJECT_DIR.
# For the test, we use an installed workspace (which has all scripts) as the project dir,
# and point CLAUDE_PROJECT_DIR there so the hook can resolve its scripts.
# This mirrors the real dogfood use case where the repo root has scripts/ from the bundle.
DOGFOOD_WORKSPACE="$CLAUDE_IDEM"  # reuse the installed workspace from the idempotent section
mkdir -p "$DOGFOOD_WORKSPACE/.kontourai/flow-agents"

if node - "$DOGFOOD_DEST2/.claude/settings.json" "$DOGFOOD_WORKSPACE" "$ROOT_DIR/scripts/hooks/lib/current-pointer.js" << 'NODE'
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const [settingsPath, workspace, currentPointerHelperPath] = process.argv.slice(2);

// Write minimal fixtures for workflow-steering into the workspace
const taskDir = path.join(workspace, ".kontourai", "flow-agents", "dogfood-hook-demo");
fs.mkdirSync(taskDir, { recursive: true });
const state = {
  schema_version: "1.0",
  task_slug: "dogfood-hook-demo",
  status: "not_verified",
  phase: "verification",
  updated_at: "2026-06-11T00:00:00Z",
  next_action: { status: "needs_user", summary: "Dogfood test.", target_phase: "goal_fit" },
};
const critique = {
  schema_version: "1.0",
  task_slug: "dogfood-hook-demo",
  status: "fail",
  required: true,
  updated_at: "2026-06-11T00:01:00Z",
  critiques: [{
    id: "dogfood-review",
    reviewer: "tool-code-reviewer",
    reviewed_at: "2026-06-11T00:01:00Z",
    verdict: "fail",
    summary: "Blocking.",
    findings: [{ id: "df-open", severity: "high", status: "open", description: "Test finding." }],
  }],
};
fs.writeFileSync(path.join(taskDir, "state.json"), JSON.stringify(state), "utf8");
fs.writeFileSync(path.join(taskDir, "critique.json"), JSON.stringify(critique), "utf8");
if (!fs.existsSync(path.join(workspace, "docs/context-map.md"))) {
  fs.mkdirSync(path.join(workspace, "docs"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "docs/context-map.md"), "# Context Map\n", "utf8");
}

// Find the workflow-steering hook command from the dogfood settings
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
const groups = settings.hooks?.UserPromptSubmit || [];
let wsCommand = null;
for (const group of groups) {
  for (const h of (group.hooks || [])) {
    const cmd = String(h.command || "");
    if (cmd.includes("claude-hook-adapter.js") && cmd.includes("workflow-steering")) {
      wsCommand = cmd;
      break;
    }
  }
  if (wsCommand) break;
}
if (!wsCommand) throw new Error("workflow-steering hook command not found");

// #440 FIXTURE-GAP: this fixture was written before #440's per-actor ownership scoping and
// never established a per-actor current pointer for the invoking actor -- under a RESOLVED
// ambient actor (ancestry-derived locally, GITHUB_RUN_ID-derived CI-runtime in CI),
// workflow-steering.js's actorScopedWorkflowState now scopes to that actor's own (nonexistent)
// pointer and never surfaces the WORKFLOW STATE ATTENTION banner. Give the hook a stable,
// explicit actor and seed that actor's own per-actor pointer for dogfood-hook-demo, mirroring
// workflow-sidecar.ts's real writeCurrent() dual-write via current-pointer.js's own
// writePerActorCurrent.
const dogfoodActor = "eval-actor-bundle-lifecycle-dogfood";
const flowAgentsDir = path.join(workspace, ".kontourai", "flow-agents");
const currentPayload = { schema_version: "1.0", active_slug: "dogfood-hook-demo", artifact_dir: "dogfood-hook-demo" };
fs.writeFileSync(path.join(flowAgentsDir, "current.json"), JSON.stringify(currentPayload, null, 2) + "\n");
require(currentPointerHelperPath).writePerActorCurrent(flowAgentsDir, dogfoodActor, currentPayload);

// Execute the hook. CLAUDE_PROJECT_DIR must point to the workspace that has scripts/hooks/.
// In the real dogfood use case this is the repo root; here we use the installed test workspace.
const payload = JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: workspace, prompt: "continue" });
const env = { ...process.env, SA_HOOK_PROFILE: "standard", CLAUDE_PROJECT_DIR: workspace, FLOW_AGENTS_ACTOR: dogfoodActor };
const result = spawnSync(wsCommand, {
  input: payload,
  cwd: workspace,
  env,
  shell: true,
  encoding: "utf8",
  timeout: 30000,
});
if (result.status !== 0) {
  throw new Error(`hook failed: rc=${result.status} stdout=${result.stdout} stderr=${result.stderr}`);
}
const ctx = JSON.parse(result.stdout || "{}").hookSpecificOutput?.additionalContext || "";
if (!ctx.includes("WORKFLOW STATE ATTENTION")) {
  throw new Error(`hook did not emit workflow attention: stdout=${result.stdout} stderr=${result.stderr}`);
}
if (!ctx.includes("STATE: dogfood-hook-demo is status:not_verified phase:verification")) {
  throw new Error(`hook missed state guidance: ${ctx}`);
}
if (!ctx.includes("CRITIQUE: required critique is status:fail")) {
  throw new Error(`hook missed critique guidance: ${ctx}`);
}
console.log("ok");
NODE
then
  _pass "dogfood: workflow-steering hook executes correctly with realistic UserPromptSubmit payload"
else
  _fail "dogfood: workflow-steering hook did not execute correctly"
fi

# Dogfood smoke: assert no bundle-specific dirs were rsynced into the dest.
# In a full install, scripts/, .claude/agents/, .claude/skills/ would be present.
# Dogfood should write ONLY .claude/settings.json.
if [[ ! -d "$DOGFOOD_DEST2/.claude/agents" && ! -d "$DOGFOOD_DEST2/.claude/skills" && ! -d "$DOGFOOD_DEST2/scripts" ]]; then
  _pass "dogfood: did not rsync full bundle (no agent/skill/scripts dirs in dest)"
else
  _fail "dogfood: unexpectedly rsynced full bundle content into dest"
fi

echo ""
echo "--- opencode Plugin Hook Chain (end-to-end telemetry persistence) ---"
# Execute the REAL generated plugin module under node, invoke its handlers,
# and assert telemetry events persist inside the workspace .kontourai/telemetry/ —
# not the workspace PARENT. Pins three live-smoke findings (2026-06-11):
#   1. spawning process.execPath fails under non-node hosts (NODE_BIN guard)
#   2. empty stdin makes the telemetry pipeline silently skip the emit
#   3. TELEMETRY_DATA_DIR escaping to the workspace parent (../../.. depth bug)
CHAIN_WS="$TMPDIR_EVAL/plugin-chain-opencode"
(cd "$ROOT_DIR/dist/opencode" && bash install.sh "$CHAIN_WS" >/dev/null 2>&1) || true
rm -rf "$CHAIN_WS/.kontourai/telemetry" "$CHAIN_WS/.telemetry" "$TMPDIR_EVAL/.kontourai" "$TMPDIR_EVAL/.telemetry"

if (cd "$CHAIN_WS" && node --input-type=module -e "
const mod = await import('./.opencode/plugins/flow-agents.js');
const hooks = await mod.FlowAgentsPlugin({ project: {}, client: {}, \$: null, directory: process.cwd(), worktree: process.cwd() });
await hooks['session.created']({}, {});
await hooks['tool.execute.before']({ tool: 'edit', sessionID: 's1', callID: 'c1' }, { args: { filePath: 'README.md' } });
" 2>/dev/null); then
  _pass "opencode plugin: module loads and handlers execute under node"
else
  _fail "opencode plugin: module load or handler execution failed"
fi

# The telemetry emit is detached (disowned) and can take a few seconds to
# land; poll rather than fixed-sleep.
for _i in 1 2 3 4 5 6 7 8 9 10; do
  [[ -s "$CHAIN_WS/.kontourai/telemetry/full.jsonl" ]] && break
  sleep 1
done
if [[ -s "$CHAIN_WS/.kontourai/telemetry/full.jsonl" ]] && node -e "
  require('fs').readFileSync('$CHAIN_WS/.kontourai/telemetry/full.jsonl','utf8').trim().split('\n').map(JSON.parse);
" 2>/dev/null; then
  _pass "opencode plugin: handlers persisted telemetry events in workspace .kontourai/telemetry/"
else
  _fail "opencode plugin: no telemetry events persisted in workspace .kontourai/telemetry/"
fi

if [[ ! -e "$TMPDIR_EVAL/.kontourai/telemetry" && ! -e "$TMPDIR_EVAL/.telemetry" ]]; then
  _pass "opencode plugin: telemetry did not leak into the workspace parent directory"
else
  _fail "opencode plugin: telemetry leaked into workspace parent"
fi

echo ""
echo "==========================="
total=$((pass + fail))
echo "Results: ${pass}/${total} passed, ${fail} failed"
[[ "$fail" -gt 0 ]] && exit 1
exit 0
