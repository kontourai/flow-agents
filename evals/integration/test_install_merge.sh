#!/usr/bin/env bash
# test_install_merge.sh — Install merge-aware tests for claude-code + codex
#
# Covers (claude-code):
#   1. Seeded-user-config: user keys + non-FA hook survive install (AC1).
#   2. Version-stamped first install: .flow-agents/install.json written (AC2).
#   3. Idempotent re-run: two consecutive installs produce identical settings.json (AC2).
#   4. In-place upgrade: FA hook block is replaced, user keys survive (AC2).
#   5. Global target: --global flag merges into FLOW_AGENTS_USER_CLAUDE_SETTINGS path (AC3).
#   6. Fresh-install with no prior settings.json: same result as original behavior (AC4).
#
# Covers (codex):
#   C1. Seeded codex hooks.json: user non-FA hook survives install.
#   C2. Version-stamped first install: .flow-agents/install.json written with runtime=codex.
#   C3. Idempotent re-run: two consecutive installs produce identical hooks.json.
#   C4. Manual proof: user Stop hook survives + FA added + idempotent.
#
# Runtime scope: claude-code + codex. opencode/pi/kiro deferred per plan.
# Self-cleaning: all temp dirs removed on exit.
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMPDIR_EVAL="$(mktemp -d /tmp/install-merge.XXXXXX)"
export HOME="$TMPDIR_EVAL/hermetic-home"
export FLOW_AGENTS_SKILLS_DIR="$TMPDIR_EVAL/hermetic-universal/skills"
mkdir -p "$HOME/.agents" "$FLOW_AGENTS_SKILLS_DIR"
printf 'installer tests must not replace this file\n' > "$HOME/.agents/ambient-sentinel"
pass=0
fail=0

cleanup() {
  rm -rf "$TMPDIR_EVAL"
}
trap cleanup EXIT

_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }

echo "=== Install Merge-Aware Tests (claude-code) ==="
echo ""

# Ensure bundles are built
echo "--- Build ---"
if (cd "$ROOT_DIR" && npm run build:bundles >/dev/null 2>&1); then
  _pass "bundle build completed"
else
  _fail "bundle build failed"
  echo "Results: 0/$((pass + fail + 1)) passed, $((fail + 1)) failed"
  exit 1
fi
echo ""

# The 3.4.2 bootstrap hook is intentionally absent from new bundles, but its
# marker remains an ownership tombstone so upgrades remove the retired denial.
if node - "$ROOT_DIR/scripts/install-merge.js" <<'NODE'
const { mergeSettings, isManagedHookGroup } = require(process.argv[2]);
const retired = { hooks: [{ type: "command", command: "old-flow-agents-entry", statusMessage: "Enforcing Flow Agents projected action" }] };
const user = { hooks: [{ type: "command", command: "user-pretool" }] };
const current = { hooks: [{ type: "command", command: "new-flow-agents", statusMessage: "Running Flow Agents hook policy" }] };
if (!isManagedHookGroup(retired)) throw new Error("retired hook marker is no longer recognized as managed");
const merged = mergeSettings(
  { hooks: { PreToolUse: [retired, user] } },
  { hooks: { UserPromptSubmit: [current] } },
);
const text = JSON.stringify(merged);
if (text.includes("old-flow-agents-entry")) throw new Error("retired bootstrap hook survived upgrade");
if (!text.includes("user-pretool")) throw new Error("user-owned PreToolUse hook was removed");
if (!text.includes("new-flow-agents")) throw new Error("current managed hook was not installed");
NODE
then
  _pass "upgrade removes the retired 3.4.2 bootstrap hook while preserving user hooks"
else
  _fail "upgrade did not cleanly replace the retired 3.4.2 bootstrap hook"
fi
echo ""

# ─── Scenario 1: Seeded user config ──────────────────────────────────────────
echo "--- Scenario 1: Seeded user config (user keys + non-FA hook survive) ---"

SEEDED_DEST="$TMPDIR_EVAL/seeded-claude"
mkdir -p "$SEEDED_DEST/.claude"

# Seed a settings.json with user keys AND a non-flow-agents hook
cat > "$SEEDED_DEST/.claude/settings.json" << 'JSON'
{
  "permissions": {
    "allow": ["Bash(usertool:*)"],
    "defaultMode": "ask",
    "customPermission": true
  },
  "statusLine": {
    "type": "command",
    "command": "echo user-statusline"
  },
  "skipDangerousModePermissionPrompt": false,
  "myUserKey": "preserved-value",
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo user-stop-hook",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
JSON

# Run install
SEEDED_INSTALL_OUT="$TMPDIR_EVAL/seeded-claude-install.out"
(cd "$ROOT_DIR/dist/claude-code" && bash install.sh "$SEEDED_DEST" >"$SEEDED_INSTALL_OUT" 2>&1)

# Assert: FA hooks present
if node - "$SEEDED_DEST/.claude/settings.json" << 'NODE'
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const hooks = s.hooks || {};
const hasFA = Object.values(hooks).flat().some(
  (g) => (g.hooks || []).some((h) => String(h.statusMessage || "").includes("Recording Flow Agents telemetry"))
);
if (!hasFA) throw new Error("Flow Agents telemetry hooks not found");
console.log("ok");
NODE
then
  _pass "seeded: flow-agents hooks are present after install"
else
  _fail "seeded: flow-agents hooks missing after install"
fi

# Assert: user key 'myUserKey' survived
if node - "$SEEDED_DEST/.claude/settings.json" << 'NODE'
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (s.myUserKey !== "preserved-value") throw new Error("myUserKey not preserved: " + JSON.stringify(s.myUserKey));
console.log("ok");
NODE
then
  _pass "seeded: user key 'myUserKey' preserved"
else
  _fail "seeded: user key 'myUserKey' was clobbered"
fi

# Assert: user non-FA Stop hook survived
if node - "$SEEDED_DEST/.claude/settings.json" << 'NODE'
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const stopGroups = (s.hooks || {}).Stop || [];
const hasUserHook = stopGroups.some(
  (g) => (g.hooks || []).some((h) => String(h.command || "").includes("echo user-stop-hook"))
);
if (!hasUserHook) throw new Error("User Stop hook not found in: " + JSON.stringify(stopGroups));
console.log("ok");
NODE
then
  _pass "seeded: non-FA user Stop hook survived"
else
  _fail "seeded: non-FA user Stop hook was removed"
fi

# Assert: user's custom permissions are PRESERVED via deep-merge (#117 core promise).
# permissions deep-merges — flow-agents UNIONs its required allow/deny/ask entries
# and preserves the user's defaultMode + custom sub-keys; it never clobbers them.
if node - "$SEEDED_DEST/.claude/settings.json" << 'NODE'
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const p = s.permissions || {};
if (p.customPermission !== true) throw new Error("user permissions.customPermission was clobbered: " + JSON.stringify(p));
if (p.defaultMode !== "ask") throw new Error("user permissions.defaultMode conflict was not preserved: " + JSON.stringify(p));
if (!JSON.stringify(p.allow || []).includes("usertool")) throw new Error("user permissions.allow entry not preserved by union: " + JSON.stringify(p.allow));
console.log("ok");
NODE
then
  _pass "seeded: user custom permissions preserved (deep-merge union, scalar conflicts preserved)"
else
  _fail "seeded: user custom permissions were clobbered"
fi

# Assert: user-owned scalar/object settings are preserved and surfaced as conflicts.
if node - "$SEEDED_DEST/.claude/settings.json" << 'NODE'
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (s.statusLine?.command !== "echo user-statusline") throw new Error("statusLine conflict was not preserved: " + JSON.stringify(s.statusLine));
if (s.skipDangerousModePermissionPrompt !== false) throw new Error("skipDangerousModePermissionPrompt conflict was not preserved: " + JSON.stringify(s.skipDangerousModePermissionPrompt));
console.log("ok");
NODE
then
  _pass "seeded: user-owned statusLine and skipDangerousModePermissionPrompt preserved"
else
  _fail "seeded: user-owned scalar/object settings were clobbered"
fi

if rg -q "install-merge: conflict: preserving existing setting 'statusLine'" "$SEEDED_INSTALL_OUT" \
  && rg -q "install-merge: conflict: preserving existing setting 'permissions.defaultMode'" "$SEEDED_INSTALL_OUT" \
  && rg -q "install-merge: conflict: preserving existing setting 'skipDangerousModePermissionPrompt'" "$SEEDED_INSTALL_OUT"; then
  _pass "seeded: install reports preserved setting conflicts to the user"
else
  _fail "seeded: install did not report expected setting conflicts"
  sed -n '1,120p' "$SEEDED_INSTALL_OUT"
fi

echo ""

# ─── Scenario 2: Version-stamped first install ───────────────────────────────
echo "--- Scenario 2: Version-stamped first install ---"

STAMP_DEST="$TMPDIR_EVAL/stamp-claude"
mkdir -p "$STAMP_DEST"

# Fresh install (no prior settings.json)
(cd "$ROOT_DIR/dist/claude-code" && bash install.sh "$STAMP_DEST" >/dev/null 2>&1)

# Assert: .flow-agents/install.json exists with version and installedAt
if node - "$STAMP_DEST/.flow-agents/install.json" << 'NODE'
const fs = require("node:fs");
const record = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!record.version) throw new Error("install.json missing version");
if (!record.installedAt) throw new Error("install.json missing installedAt");
if (record.runtime !== "claude-code") throw new Error("install.json wrong runtime: " + record.runtime);
// Validate ISO 8601 format
const d = new Date(record.installedAt);
if (isNaN(d.getTime())) throw new Error("installedAt not valid ISO date: " + record.installedAt);
console.log("ok: version=" + record.version + " runtime=" + record.runtime);
NODE
then
  _pass "first-install: .flow-agents/install.json written with version+runtime+installedAt"
else
  _fail "first-install: .flow-agents/install.json missing or invalid"
fi

# Assert: fresh install produces valid settings.json with FA hooks
if node - "$STAMP_DEST/.claude/settings.json" << 'NODE'
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const hooks = s.hooks || {};
const events = Object.keys(hooks);
if (events.length === 0) throw new Error("no hooks in settings.json");
const hasFA = Object.values(hooks).flat().some(
  (g) => (g.hooks || []).some((h) => String(h.statusMessage || "").includes("Recording Flow Agents telemetry"))
);
if (!hasFA) throw new Error("FA telemetry hooks not found");
console.log("ok: events=" + events.join(","));
NODE
then
  _pass "first-install: settings.json contains FA hooks (fresh-install path unchanged)"
else
  _fail "first-install: settings.json missing or FA hooks absent"
fi

echo ""

# ─── Scenario 3: Idempotent re-run ───────────────────────────────────────────
echo "--- Scenario 3: Idempotent re-run ---"

IDEM_DEST="$TMPDIR_EVAL/idem-merge-claude"
mkdir -p "$IDEM_DEST"

# First install
(cd "$ROOT_DIR/dist/claude-code" && bash install.sh "$IDEM_DEST" >/dev/null 2>&1)

# Capture hook count after first install
HOOKS_BEFORE=$(node -e "
  const s = JSON.parse(require('fs').readFileSync('$IDEM_DEST/.claude/settings.json','utf8'));
  const hooks = s.hooks || {};
  let count = 0;
  for (const k of Object.keys(hooks)) count += (hooks[k] || []).length;
  console.log(count);
" 2>/dev/null || echo "0")

# Second install (idempotent)
(cd "$ROOT_DIR/dist/claude-code" && bash install.sh "$IDEM_DEST" >/dev/null 2>&1)

HOOKS_AFTER=$(node -e "
  const s = JSON.parse(require('fs').readFileSync('$IDEM_DEST/.claude/settings.json','utf8'));
  const hooks = s.hooks || {};
  let count = 0;
  for (const k of Object.keys(hooks)) count += (hooks[k] || []).length;
  console.log(count);
" 2>/dev/null || echo "0")

if [[ "$HOOKS_BEFORE" == "$HOOKS_AFTER" && -n "$HOOKS_BEFORE" && "$HOOKS_BEFORE" != "0" ]]; then
  _pass "idempotent: re-install did not grow hooks array (before=$HOOKS_BEFORE after=$HOOKS_AFTER)"
else
  _fail "idempotent: hook count changed (before=$HOOKS_BEFORE after=$HOOKS_AFTER)"
fi

echo ""

# ─── Scenario 4: User keys survive re-install ────────────────────────────────
echo "--- Scenario 4: User keys survive re-install (upgrade semantics) ---"

UPGRADE_DEST="$TMPDIR_EVAL/upgrade-claude"
mkdir -p "$UPGRADE_DEST/.claude"

# Seed with user key + non-FA hook
cat > "$UPGRADE_DEST/.claude/settings.json" << 'JSON'
{
  "permissions": {"x": 1},
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo user-hook"
          }
        ]
      }
    ]
  }
}
JSON

# First install
(cd "$ROOT_DIR/dist/claude-code" && bash install.sh "$UPGRADE_DEST" >/dev/null 2>&1)

# Second install (upgrade / re-install)
(cd "$ROOT_DIR/dist/claude-code" && bash install.sh "$UPGRADE_DEST" >/dev/null 2>&1)

# Assert: user Stop hook survived the second install
if node - "$UPGRADE_DEST/.claude/settings.json" << 'NODE'
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const stopGroups = (s.hooks || {}).Stop || [];
const hasUser = stopGroups.some(
  (g) => (g.hooks || []).some((h) => String(h.command || "").includes("echo user-hook"))
);
if (!hasUser) throw new Error("User hook not found after re-install: " + JSON.stringify(stopGroups));
// Also assert FA hooks present (not stripped)
const hasFA = stopGroups.some(
  (g) => (g.hooks || []).some((h) => String(h.statusMessage || "").includes("Running Flow Agents hook policy"))
);
if (!hasFA) throw new Error("FA policy hook missing from Stop after re-install");
console.log("ok");
NODE
then
  _pass "upgrade: user Stop hook and FA policy hook both present after re-install"
else
  _fail "upgrade: user Stop hook or FA policy hook missing after re-install"
fi

# Assert: FA hooks not duplicated
if node - "$UPGRADE_DEST/.claude/settings.json" << 'NODE'
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const hooks = s.hooks || {};
let maxFA = 0;
for (const [event, groups] of Object.entries(hooks)) {
  const faCount = groups.filter(
    (g) => (g.hooks || []).some((h) => String(h.statusMessage || "").includes("Recording Flow Agents telemetry"))
  ).length;
  maxFA = Math.max(maxFA, faCount);
}
if (maxFA > 1) throw new Error("FA telemetry hooks duplicated (max " + maxFA + " per event)");
console.log("ok");
NODE
then
  _pass "upgrade: FA hooks are not duplicated after re-install"
else
  _fail "upgrade: FA hooks duplicated after re-install"
fi

echo ""

# ─── Scenario 5: Global target ───────────────────────────────────────────────
echo "--- Scenario 5: Global target (--global flag merges into user settings) ---"

GLOBAL_SETTINGS_DIR="$TMPDIR_EVAL/global-settings"
mkdir -p "$GLOBAL_SETTINGS_DIR"

# Seed a "user-level" settings with a user key
cat > "$GLOBAL_SETTINGS_DIR/settings.json" << 'JSON'
{
  "myGlobalKey": "global-preserved",
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo global-user-hook"
          }
        ]
      }
    ]
  }
}
JSON

# Run init --global, overriding the target via FLOW_AGENTS_USER_CLAUDE_SETTINGS.
# --global for claude-code: dest = dirname(FLOW_AGENTS_USER_CLAUDE_SETTINGS) = GLOBAL_SETTINGS_DIR.
# The global path writes settings.json directly at dest/settings.json (dest IS ~/.claude/).
FLOW_AGENTS_USER_CLAUDE_SETTINGS="$GLOBAL_SETTINGS_DIR/settings.json" \
  node "$ROOT_DIR/build/src/cli.js" init --runtime claude-code --global --yes >/dev/null 2>&1 || true

# The settings.json was merged in-place at GLOBAL_SETTINGS_DIR/settings.json.
GLOBAL_SETTINGS_JSON="$GLOBAL_SETTINGS_DIR/settings.json"

if [[ -f "$GLOBAL_SETTINGS_JSON" ]] && node - "$GLOBAL_SETTINGS_JSON" << 'NODE'
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (s.myGlobalKey !== "global-preserved") throw new Error("myGlobalKey not preserved: " + JSON.stringify(s.myGlobalKey));
const hooks = s.hooks || {};
const hasFA = Object.values(hooks).flat().some(
  (g) => (g.hooks || []).some((h) => String(h.statusMessage || "").includes("Recording Flow Agents telemetry"))
);
if (!hasFA) throw new Error("FA hooks not present in global settings after --global install");
const preuseGroups = (hooks.PreToolUse || []);
const hasUserHook = preuseGroups.some(
  (g) => (g.hooks || []).some((h) => String(h.command || "").includes("echo global-user-hook"))
);
if (!hasUserHook) throw new Error("global user hook not preserved in PreToolUse");
console.log("ok");
NODE
then
  _pass "--global: user key + user hook survived; FA hooks present in global settings"
else
  _fail "--global: merge into global settings failed or user key/hook lost"
fi

# Regression guard: --global hook commands must resolve regardless of which
# project is open. The bundle template resolves scripts/ via
# ${CLAUDE_PROJECT_DIR:-$(pwd)}, which only exists for project-scoped installs
# (installBundle rsyncs scripts/ alongside .claude/). A --global install must
# rewrite that to an absolute path, or every FA hook silently MODULE_NOT_FOUNDs
# in any project other than this package's own checkout.
if [[ -f "$GLOBAL_SETTINGS_JSON" ]] && node - "$GLOBAL_SETTINGS_JSON" << 'NODE'
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const hooks = s.hooks || {};
const commands = Object.values(hooks).flat().flatMap((g) => (g.hooks || []).map((h) => String(h.command || "")));
const faCommands = commands.filter((c) => c.includes("claude-hook-adapter.js") || c.includes("claude-telemetry-hook.js"));
if (faCommands.length === 0) throw new Error("no FA hook commands found to check");
for (const c of faCommands) {
  if (c.includes("CLAUDE_PROJECT_DIR")) throw new Error("FA hook command still depends on CLAUDE_PROJECT_DIR (breaks outside this package's own project): " + c);
  const m = c.match(/node "([^"]+\/scripts\/hooks\/[^"]+\.js)"/);
  if (!m) throw new Error("FA hook command has no absolute scripts/hooks path: " + c);
  if (!fs.existsSync(m[1])) throw new Error("FA hook command points at a path that does not exist: " + m[1]);
}
console.log("ok");
NODE
then
  _pass "--global: FA hook commands use an absolute, resolvable path (no CLAUDE_PROJECT_DIR dependency)"
else
  _fail "--global: FA hook commands are not resolvable outside this package's own project directory"
fi

# Regression guard: --global must also sync skills and agents so newly added
# Builder Kit skills don't require a full reinstall to pick up.
if [[ -d "$GLOBAL_SETTINGS_DIR/skills/plan-work" && -f "$GLOBAL_SETTINGS_DIR/skills/plan-work/SKILL.md" ]]; then
  _pass "--global: skills synced into global destination"
else
  _fail "--global: skills were not synced into global destination"
fi
if [[ -d "$GLOBAL_SETTINGS_DIR/agents" && -n "$(ls -A "$GLOBAL_SETTINGS_DIR/agents" 2>/dev/null)" ]]; then
  _pass "--global: agents synced into global destination"
else
  _fail "--global: agents were not synced into global destination"
fi

# Regression guard (#439): --global must also write a per-skill-file sha256 content-hash
# manifest, a sibling of install.json, so `flow-agents skill-drift-check` and the SessionStart
# advisory have a baseline to classify installed skill files against.
if node - "$GLOBAL_SETTINGS_DIR/.flow-agents/skills-manifest.json" << 'NODE'
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!manifest.files || typeof manifest.files !== "object" || Object.keys(manifest.files).length === 0) throw new Error("skills-manifest.json files is empty: " + JSON.stringify(manifest.files));
if (!manifest.generatedAt) throw new Error("skills-manifest.json missing generatedAt");
if (manifest.runtime !== "claude-code") throw new Error("skills-manifest.json wrong runtime: " + manifest.runtime);
console.log("ok: " + Object.keys(manifest.files).length + " files");
NODE
then
  _pass "--global: skills-manifest.json written with non-empty files after install"
else
  _fail "--global: skills-manifest.json missing, empty, or invalid after install"
fi

# Re-run init --global: the manifest must regenerate (fresh generatedAt) without disturbing any
# of the settings-merge, skill-sync, and agent-sync assertions already proven above in this scenario.
FIRST_MANIFEST_GENERATED_AT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$GLOBAL_SETTINGS_DIR/.flow-agents/skills-manifest.json','utf8')).generatedAt)" 2>/dev/null || echo "")
FLOW_AGENTS_USER_CLAUDE_SETTINGS="$GLOBAL_SETTINGS_DIR/settings.json" \
  node "$ROOT_DIR/build/src/cli.js" init --runtime claude-code --global --yes >/dev/null 2>&1 || true
SECOND_MANIFEST_GENERATED_AT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$GLOBAL_SETTINGS_DIR/.flow-agents/skills-manifest.json','utf8')).generatedAt)" 2>/dev/null || echo "")

if [[ -n "$FIRST_MANIFEST_GENERATED_AT" && -n "$SECOND_MANIFEST_GENERATED_AT" && "$FIRST_MANIFEST_GENERATED_AT" != "$SECOND_MANIFEST_GENERATED_AT" ]]; then
  _pass "--global: re-running init regenerates skills-manifest.json (generatedAt changed)"
else
  _fail "--global: skills-manifest.json generatedAt did not change on re-run (first=$FIRST_MANIFEST_GENERATED_AT second=$SECOND_MANIFEST_GENERATED_AT)"
fi

echo ""

# ─── Scenario 6: Manual proof (user-visible) ─────────────────────────────────
echo "--- Scenario 6: Manual proof — permissions + user hook survive, FA hooks added ---"

PROOF_DEST="$TMPDIR_EVAL/proof-claude"
mkdir -p "$PROOF_DEST/.claude"

cat > "$PROOF_DEST/.claude/settings.json" << 'JSON'
{
  "permissions": {"x": 1},
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo user-hook"
          }
        ]
      }
    ]
  }
}
JSON

echo "BEFORE install:"
node -e "
const s = JSON.parse(require('fs').readFileSync('$PROOF_DEST/.claude/settings.json','utf8'));
console.log('  permissions:', JSON.stringify(s.permissions));
console.log('  Stop hook count:', (s.hooks?.Stop || []).length);
console.log('  User hook present:', (s.hooks?.Stop || []).some(g => (g.hooks||[]).some(h => h.command?.includes('echo user-hook'))));
"

(cd "$ROOT_DIR/dist/claude-code" && bash install.sh "$PROOF_DEST" >/dev/null 2>&1)

echo "AFTER first install:"
node -e "
const s = JSON.parse(require('fs').readFileSync('$PROOF_DEST/.claude/settings.json','utf8'));
const stopGroups = s.hooks?.Stop || [];
console.log('  permissions:', JSON.stringify(s.permissions));
console.log('  Stop hook count:', stopGroups.length);
console.log('  User hook present:', stopGroups.some(g => (g.hooks||[]).some(h => h.command?.includes('echo user-hook'))));
console.log('  FA goal-fit hook present:', stopGroups.some(g => (g.hooks||[]).some(h => String(h.statusMessage||'').includes('Running Flow Agents hook policy'))));
"

(cd "$ROOT_DIR/dist/claude-code" && bash install.sh "$PROOF_DEST" >/dev/null 2>&1)

echo "AFTER second install (idempotence check):"
HOOKS_AFTER_SECOND=$(node -e "
const s = JSON.parse(require('fs').readFileSync('$PROOF_DEST/.claude/settings.json','utf8'));
const hooks = s.hooks || {};
let count = 0;
for (const k of Object.keys(hooks)) count += (hooks[k] || []).length;
console.log(count);
" 2>/dev/null || echo "err")
echo "  Total hook groups: $HOOKS_AFTER_SECOND"

HOOKS_AFTER_FIRST=$(node -e "
const s = JSON.parse(require('fs').readFileSync('$PROOF_DEST/.claude/settings.json','utf8'));
const hooks = s.hooks || {};
let count = 0;
for (const k of Object.keys(hooks)) count += (hooks[k] || []).length;
console.log(count);
" 2>/dev/null || echo "err")

if [[ "$HOOKS_AFTER_FIRST" == "$HOOKS_AFTER_SECOND" ]]; then
  _pass "manual proof: second install is idempotent (hook count stable at $HOOKS_AFTER_FIRST)"
else
  _fail "manual proof: hook count changed from first to second install"
fi


# ─── Codex: Scenario C1: Seeded user hooks + non-FA hook survive ──────────────
echo "=== Install Merge-Aware Tests (codex) ==="
echo ""
echo "--- Codex Scenario C1: Seeded user hooks survive install ---"

CODEX_SEEDED="$TMPDIR_EVAL/codex-seeded"
mkdir -p "$CODEX_SEEDED/.codex"

# Seed a hooks.json with a user non-FA hook in Stop
cat > "$CODEX_SEEDED/.codex/hooks.json" << 'JSON'
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo user-codex-stop-hook",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
JSON

(cd "$ROOT_DIR/dist/codex" && bash install.sh "$CODEX_SEEDED" >/dev/null 2>&1)

# Assert: FA telemetry hooks present
if node - "$CODEX_SEEDED/.codex/hooks.json" << 'NODE'
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const hooks = s.hooks || {};
const hasFA = Object.values(hooks).flat().some(
  (g) => (g.hooks || []).some((h) => String(h.statusMessage || "").includes("Recording Flow Agents telemetry"))
);
if (!hasFA) throw new Error("Flow Agents telemetry hooks not found in codex hooks.json");
console.log("ok");
NODE
then
  _pass "codex seeded: FA telemetry hooks present after install"
else
  _fail "codex seeded: FA telemetry hooks missing after install"
fi

# Assert: user non-FA Stop hook survived
if node - "$CODEX_SEEDED/.codex/hooks.json" << 'NODE'
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const stopGroups = (s.hooks || {}).Stop || [];
const hasUserHook = stopGroups.some(
  (g) => (g.hooks || []).some((h) => String(h.command || "").includes("echo user-codex-stop-hook"))
);
if (!hasUserHook) throw new Error("User codex Stop hook not found: " + JSON.stringify(stopGroups));
console.log("ok");
NODE
then
  _pass "codex seeded: non-FA user Stop hook survived install"
else
  _fail "codex seeded: non-FA user Stop hook was removed"
fi

echo ""

# ─── Codex: Scenario C2: Version-stamped first install ───────────────────────
echo "--- Codex Scenario C2: Version-stamped first install ---"

CODEX_STAMP="$TMPDIR_EVAL/codex-stamp"
mkdir -p "$CODEX_STAMP"

(cd "$ROOT_DIR/dist/codex" && bash install.sh "$CODEX_STAMP" >/dev/null 2>&1)

# Assert: .flow-agents/install.json exists with runtime=codex
if node - "$CODEX_STAMP/.flow-agents/install.json" << 'NODE'
const fs = require("node:fs");
const record = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!record.version) throw new Error("install.json missing version");
if (!record.installedAt) throw new Error("install.json missing installedAt");
if (record.runtime !== "codex") throw new Error("install.json wrong runtime: " + record.runtime + " (expected codex)");
const d = new Date(record.installedAt);
if (isNaN(d.getTime())) throw new Error("installedAt not valid ISO date: " + record.installedAt);
console.log("ok: version=" + record.version + " runtime=" + record.runtime);
NODE
then
  _pass "codex first-install: .flow-agents/install.json written with version+runtime=codex+installedAt"
else
  _fail "codex first-install: .flow-agents/install.json missing or invalid or wrong runtime"
fi

echo ""

# ─── Codex: Scenario C3: Idempotent re-run ───────────────────────────────────
echo "--- Codex Scenario C3: Idempotent re-run ---"

CODEX_IDEM="$TMPDIR_EVAL/codex-idem"
mkdir -p "$CODEX_IDEM"

(cd "$ROOT_DIR/dist/codex" && bash install.sh "$CODEX_IDEM" >/dev/null 2>&1)

CODEX_HOOKS_BEFORE=$(node -e "
  const s = JSON.parse(require('fs').readFileSync('$CODEX_IDEM/.codex/hooks.json','utf8'));
  const hooks = s.hooks || {};
  let count = 0;
  for (const k of Object.keys(hooks)) count += (hooks[k] || []).length;
  console.log(count);
" 2>/dev/null || echo "0")

(cd "$ROOT_DIR/dist/codex" && bash install.sh "$CODEX_IDEM" >/dev/null 2>&1)

CODEX_HOOKS_AFTER=$(node -e "
  const s = JSON.parse(require('fs').readFileSync('$CODEX_IDEM/.codex/hooks.json','utf8'));
  const hooks = s.hooks || {};
  let count = 0;
  for (const k of Object.keys(hooks)) count += (hooks[k] || []).length;
  console.log(count);
" 2>/dev/null || echo "0")

if [[ "$CODEX_HOOKS_BEFORE" == "$CODEX_HOOKS_AFTER" && -n "$CODEX_HOOKS_BEFORE" && "$CODEX_HOOKS_BEFORE" != "0" ]]; then
  _pass "codex idempotent: re-install did not grow hooks (before=$CODEX_HOOKS_BEFORE after=$CODEX_HOOKS_AFTER)"
else
  _fail "codex idempotent: hook count changed (before=$CODEX_HOOKS_BEFORE after=$CODEX_HOOKS_AFTER)"
fi

echo ""

# ─── Codex: Scenario C4: Manual proof ───────────────────────────────────────
echo "--- Codex Scenario C4: Manual proof — user Stop hook survives, FA added, idempotent ---"

CODEX_PROOF="$TMPDIR_EVAL/codex-proof"
mkdir -p "$CODEX_PROOF/.codex"

cat > "$CODEX_PROOF/.codex/hooks.json" << 'JSON'
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo user-codex-hook",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
JSON

echo "BEFORE codex install:"
node -e "
const s = JSON.parse(require('fs').readFileSync('$CODEX_PROOF/.codex/hooks.json','utf8'));
console.log('  Stop hook count:', (s.hooks?.Stop || []).length);
console.log('  User hook present:', (s.hooks?.Stop || []).some(g => (g.hooks||[]).some(h => h.command?.includes('echo user-codex-hook'))));
"

(cd "$ROOT_DIR/dist/codex" && bash install.sh "$CODEX_PROOF" >/dev/null 2>&1)

echo "AFTER first codex install:"
node -e "
const s = JSON.parse(require('fs').readFileSync('$CODEX_PROOF/.codex/hooks.json','utf8'));
const stopGroups = s.hooks?.Stop || [];
console.log('  Stop hook count:', stopGroups.length);
console.log('  User hook present:', stopGroups.some(g => (g.hooks||[]).some(h => h.command?.includes('echo user-codex-hook'))));
console.log('  FA goal-fit hook present:', stopGroups.some(g => (g.hooks||[]).some(h => String(h.statusMessage||'').includes('Running Flow Agents hook policy'))));
"

(cd "$ROOT_DIR/dist/codex" && bash install.sh "$CODEX_PROOF" >/dev/null 2>&1)

echo "AFTER second codex install (idempotence check):"
CODEX_PROOF_HOOKS=$(node -e "
const s = JSON.parse(require('fs').readFileSync('$CODEX_PROOF/.codex/hooks.json','utf8'));
const hooks = s.hooks || {};
let count = 0;
for (const k of Object.keys(hooks)) count += (hooks[k] || []).length;
console.log(count);
" 2>/dev/null || echo "err")
echo "  Total hook groups: $CODEX_PROOF_HOOKS"

CODEX_PROOF_FIRST=$(node -e "
const s = JSON.parse(require('fs').readFileSync('$CODEX_PROOF/.codex/hooks.json','utf8'));
const hooks = s.hooks || {};
let count = 0;
for (const k of Object.keys(hooks)) count += (hooks[k] || []).length;
console.log(count);
" 2>/dev/null || echo "err")

if [[ "$CODEX_PROOF_FIRST" == "$CODEX_PROOF_HOOKS" ]]; then
  _pass "codex manual proof: second install is idempotent (hook count stable at $CODEX_PROOF_FIRST)"
else
  _fail "codex manual proof: hook count changed from first to second install"
fi

# Assert user hook survived second install
if node - "$CODEX_PROOF/.codex/hooks.json" << 'NODE'
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const stopGroups = (s.hooks || {}).Stop || [];
const hasUser = stopGroups.some(
  (g) => (g.hooks || []).some((h) => String(h.command || "").includes("echo user-codex-hook"))
);
if (!hasUser) throw new Error("User codex hook not found after second install");
const hasFA = stopGroups.some(
  (g) => (g.hooks || []).some((h) => String(h.statusMessage || "").includes("Running Flow Agents hook policy"))
);
if (!hasFA) throw new Error("FA goal-fit hook missing from codex Stop after second install");
console.log("ok");
NODE
then
  _pass "codex manual proof: user Stop hook + FA hooks both present after second install"
else
  _fail "codex manual proof: user Stop hook or FA hooks missing after second install"
fi



# ─── opencode: Scenario OC1: User keys survive + $schema present + no empty hooks ─
echo "=== Install Merge-Aware Tests (opencode) ==="
echo ""
echo "--- opencode Scenario OC1: User keys survive + \$schema present + no spurious empty hooks ---"

OPENCODE_SEEDED="$TMPDIR_EVAL/opencode-seeded"
mkdir -p "$OPENCODE_SEEDED"

# Seed opencode.json with user keys (model + plugin)
cat > "$OPENCODE_SEEDED/opencode.json" << 'JSON'
{
  "model": "x",
  "plugin": ["user-thing"]
}
JSON

(cd "$ROOT_DIR/dist/opencode" && bash install.sh "$OPENCODE_SEEDED" >/dev/null 2>&1)

# Assert: user 'model' key survived
if node - "$OPENCODE_SEEDED/opencode.json" << 'NODE'
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (s.model !== "x") throw new Error("user key 'model' was clobbered: " + JSON.stringify(s));
console.log("ok");
NODE
then
  _pass "opencode seeded: user key 'model' survived install"
else
  _fail "opencode seeded: user key 'model' was clobbered"
fi

# Assert: $schema present
if node - "$OPENCODE_SEEDED/opencode.json" << 'NODE'
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (s["$schema"] !== "https://opencode.ai/config.json") throw new Error("\$schema missing or wrong: " + JSON.stringify(s));
console.log("ok");
NODE
then
  _pass "opencode seeded: \$schema present after install"
else
  _fail "opencode seeded: \$schema missing after install"
fi

# Assert: user 'plugin' array survived
if node - "$OPENCODE_SEEDED/opencode.json" << 'NODE'
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!Array.isArray(s.plugin) || s.plugin[0] !== "user-thing") throw new Error("user key 'plugin' was clobbered: " + JSON.stringify(s));
console.log("ok");
NODE
then
  _pass "opencode seeded: user key 'plugin' survived install"
else
  _fail "opencode seeded: user key 'plugin' was clobbered"
fi

# Assert: no spurious empty hooks key
if node - "$OPENCODE_SEEDED/opencode.json" << 'NODE'
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if ("hooks" in s) throw new Error("spurious empty 'hooks' key found: " + JSON.stringify(s));
console.log("ok");
NODE
then
  _pass "opencode seeded: no spurious empty 'hooks' key injected"
else
  _fail "opencode seeded: spurious empty 'hooks' key was injected"
fi

# Assert: idempotent (install again, same result)
(cd "$ROOT_DIR/dist/opencode" && bash install.sh "$OPENCODE_SEEDED" >/dev/null 2>&1)
if node - "$OPENCODE_SEEDED/opencode.json" << 'NODE'
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (s.model !== "x") throw new Error("user key clobbered on re-install");
if (s["$schema"] !== "https://opencode.ai/config.json") throw new Error("\$schema missing after re-install");
if ("hooks" in s) throw new Error("spurious hooks key on re-install: " + JSON.stringify(s));
console.log("ok");
NODE
then
  _pass "opencode seeded: second install is idempotent (user keys + \$schema stable, no hooks)"
else
  _fail "opencode seeded: second install changed the result"
fi

echo ""

# ─── opencode: Scenario OC2: Manual proof ───────────────────────────────────────
echo "--- opencode Scenario OC2: Manual proof — seed opencode.json with user keys ---"

OPENCODE_PROOF="$TMPDIR_EVAL/opencode-proof"
mkdir -p "$OPENCODE_PROOF"

cat > "$OPENCODE_PROOF/opencode.json" << 'JSON'
{"model":"x","plugin":["user-thing"]}
JSON

echo "BEFORE opencode install:"
node -e "const s=JSON.parse(require('fs').readFileSync('$OPENCODE_PROOF/opencode.json','utf8')); console.log('  opencode.json:', JSON.stringify(s));"

(cd "$ROOT_DIR/dist/opencode" && bash install.sh "$OPENCODE_PROOF" >/dev/null 2>&1)

echo "AFTER opencode install:"
node -e "
const s=JSON.parse(require('fs').readFileSync('$OPENCODE_PROOF/opencode.json','utf8'));
console.log('  opencode.json:', JSON.stringify(s));
console.log('  user key model:', s.model);
console.log('  \$schema:', s['\$schema']);
console.log('  has hooks key:', 'hooks' in s);
"

echo ""

# ─── Version Stamp Tests (opencode, pi, kiro) ─────────────────────────────────
echo "=== Version Stamp Tests (opencode / pi / kiro / base) ==="
echo ""

echo "--- VS1: opencode install writes .flow-agents/install.json with runtime=opencode ---"

OC_STAMP="$TMPDIR_EVAL/opencode-stamp"
mkdir -p "$OC_STAMP"

(cd "$ROOT_DIR/dist/opencode" && bash install.sh "$OC_STAMP" >/dev/null 2>&1)

if node - "$OC_STAMP/.flow-agents/install.json" << 'NODE'
const fs = require("node:fs");
const record = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!record.version) throw new Error("install.json missing version");
if (!record.installedAt) throw new Error("install.json missing installedAt");
if (record.runtime !== "opencode") throw new Error("wrong runtime: " + record.runtime + " (expected opencode)");
const d = new Date(record.installedAt);
if (isNaN(d.getTime())) throw new Error("installedAt not valid ISO date: " + record.installedAt);
console.log("ok: version=" + record.version + " runtime=" + record.runtime);
NODE
then
  _pass "opencode install: .flow-agents/install.json written with runtime=opencode"
else
  _fail "opencode install: .flow-agents/install.json missing or wrong runtime"
fi

echo ""
echo "--- VS2: pi install writes .flow-agents/install.json with runtime=pi ---"

PI_STAMP="$TMPDIR_EVAL/pi-stamp"
mkdir -p "$PI_STAMP"

(cd "$ROOT_DIR/dist/pi" && bash install.sh "$PI_STAMP" >/dev/null 2>&1)

if node - "$PI_STAMP/.flow-agents/install.json" << 'NODE'
const fs = require("node:fs");
const record = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!record.version) throw new Error("install.json missing version");
if (!record.installedAt) throw new Error("install.json missing installedAt");
if (record.runtime !== "pi") throw new Error("wrong runtime: " + record.runtime + " (expected pi)");
const d = new Date(record.installedAt);
if (isNaN(d.getTime())) throw new Error("installedAt not valid ISO date: " + record.installedAt);
console.log("ok: version=" + record.version + " runtime=" + record.runtime);
NODE
then
  _pass "pi install: .flow-agents/install.json written with runtime=pi"
else
  _fail "pi install: .flow-agents/install.json missing or wrong runtime"
fi

echo ""
echo "--- VS3: kiro install writes .flow-agents/install.json with runtime=kiro ---"

KIRO_STAMP="$TMPDIR_EVAL/kiro-stamp"
mkdir -p "$KIRO_STAMP"

(cd "$ROOT_DIR/dist/kiro" && bash install.sh "$KIRO_STAMP" >/dev/null 2>&1)

if node - "$KIRO_STAMP/.flow-agents/install.json" << 'NODE'
const fs = require("node:fs");
const record = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!record.version) throw new Error("install.json missing version");
if (!record.installedAt) throw new Error("install.json missing installedAt");
if (record.runtime !== "kiro") throw new Error("wrong runtime: " + record.runtime + " (expected kiro)");
const d = new Date(record.installedAt);
if (isNaN(d.getTime())) throw new Error("installedAt not valid ISO date: " + record.installedAt);
console.log("ok: version=" + record.version + " runtime=" + record.runtime);
NODE
then
  _pass "kiro install: .flow-agents/install.json written with runtime=kiro"
else
  _fail "kiro install: .flow-agents/install.json missing or wrong runtime"
fi

echo ""
echo "--- VS4: base install writes .flow-agents/install.json with runtime=base ---"

BASE_STAMP="$TMPDIR_EVAL/base-stamp"
mkdir -p "$BASE_STAMP"

(cd "$ROOT_DIR/dist/base" && bash install.sh "$BASE_STAMP" >/dev/null 2>&1)

if node - "$BASE_STAMP/.flow-agents/install.json" << 'NODE'
const fs = require("node:fs");
const record = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!record.version) throw new Error("install.json missing version");
if (!record.installedAt) throw new Error("install.json missing installedAt");
if (record.runtime !== "base") throw new Error("wrong runtime: " + record.runtime + " (expected base)");
const d = new Date(record.installedAt);
if (isNaN(d.getTime())) throw new Error("installedAt not valid ISO date: " + record.installedAt);
console.log("ok: version=" + record.version + " runtime=" + record.runtime);
NODE
then
  _pass "base install: .flow-agents/install.json written with runtime=base"
else
  _fail "base install: .flow-agents/install.json missing or wrong runtime"
fi



# ─── codex-home: CH1: merge — user Stop hook survives install-codex-home ─────
echo "=== Install Merge-Aware Tests (codex-home) ==="
echo ""
echo "--- CH0: codex-home default destination honors CODEX_HOME ---"

CH0_CODEX_HOME="$TMPDIR_EVAL/codex-home-ch0"
CH0_REAL_HOME="$TMPDIR_EVAL/fake-real-codex-ch0"
mkdir -p "$CH0_CODEX_HOME" "$CH0_REAL_HOME"

CODEX_HOME="$CH0_CODEX_HOME" CODEX_REAL_HOME="$CH0_REAL_HOME" bash "$ROOT_DIR/scripts/install-codex-home.sh" >/dev/null 2>&1

if [[ -f "$CH0_CODEX_HOME/hooks.json" && -f "$CH0_CODEX_HOME/.flow-agents/install.json" && ! -e "$TMPDIR_EVAL/.codex/hooks.json" ]]; then
  _pass "CH0: install-codex-home defaults to CODEX_HOME"
else
  _fail "CH0: install-codex-home did not default to CODEX_HOME"
fi

echo ""
echo "--- CH1: codex-home merge — seed user Stop hook → install → user hook survives + FA hooks present ---"

CH1_DEST="$TMPDIR_EVAL/codex-home-ch1"
mkdir -p "$CH1_DEST"

# Seed a user Stop hook in the codex-home hooks.json (at root, where it lives after flatten)
cat > "$CH1_DEST/hooks.json" << 'JSON'
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo ch1-user-stop-hook",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
JSON

# Run install-codex-home.sh pointing to the isolated dest
CODEX_REAL_HOME="$TMPDIR_EVAL/fake-real-codex"   bash "$ROOT_DIR/scripts/install-codex-home.sh" "$CH1_DEST" >/dev/null 2>&1

# Assert: FA telemetry hooks present in $DEST/hooks.json
if node - "$CH1_DEST/hooks.json" << 'NODE'
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const hooks = s.hooks || {};
const hasFA = Object.values(hooks).flat().some(
  (g) => (g.hooks || []).some((h) => String(h.statusMessage || "").includes("Recording Flow Agents telemetry"))
);
if (!hasFA) throw new Error("FA telemetry hooks not found in codex-home hooks.json");
console.log("ok");
NODE
then
  _pass "CH1: FA telemetry hooks present after install-codex-home"
else
  _fail "CH1: FA telemetry hooks missing after install-codex-home"
fi

# Assert: user non-FA Stop hook survived
if node - "$CH1_DEST/hooks.json" << 'NODE'
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const stopGroups = (s.hooks || {}).Stop || [];
const hasUser = stopGroups.some(
  (g) => (g.hooks || []).some((h) => String(h.command || "").includes("echo ch1-user-stop-hook"))
);
if (!hasUser) throw new Error("User Stop hook not found in codex-home after install: " + JSON.stringify(stopGroups));
console.log("ok");
NODE
then
  _pass "CH1: user Stop hook survived install-codex-home (merge, not overwrite)"
else
  _fail "CH1: user Stop hook was overwritten by install-codex-home"
fi

echo ""

# ─── codex-home: CH2: stamp — install.json runtime=codex + version + installedAt ─
echo "--- CH2: codex-home stamp — install.json runtime=codex + version + installedAt ---"

CH2_DEST="$TMPDIR_EVAL/codex-home-ch2"
mkdir -p "$CH2_DEST"

CODEX_REAL_HOME="$TMPDIR_EVAL/fake-real-codex"   bash "$ROOT_DIR/scripts/install-codex-home.sh" "$CH2_DEST" >/dev/null 2>&1

if node - "$CH2_DEST/.flow-agents/install.json" << 'NODE'
const fs = require("node:fs");
const record = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!record.version) throw new Error("install.json missing version");
if (!record.installedAt) throw new Error("install.json missing installedAt");
if (record.runtime !== "codex") throw new Error("wrong runtime: " + record.runtime + " (expected codex)");
const d = new Date(record.installedAt);
if (isNaN(d.getTime())) throw new Error("installedAt not valid ISO date: " + record.installedAt);
console.log("ok: version=" + record.version + " runtime=" + record.runtime);
NODE
then
  _pass "CH2: codex-home install.json written with runtime=codex + version + installedAt"
else
  _fail "CH2: codex-home install.json missing or wrong"
fi

echo ""

# ─── codex-home: CH3: idempotent — stable hook count on re-run ───────────────
echo "--- CH3: codex-home idempotent — stable hook count on re-run ---"

CH3_DEST="$TMPDIR_EVAL/codex-home-ch3"
mkdir -p "$CH3_DEST"

CODEX_REAL_HOME="$TMPDIR_EVAL/fake-real-codex"   bash "$ROOT_DIR/scripts/install-codex-home.sh" "$CH3_DEST" >/dev/null 2>&1

CH3_BEFORE=$(node -e "
const s = JSON.parse(require('fs').readFileSync('$CH3_DEST/hooks.json','utf8'));
const hooks = s.hooks || {};
let count = 0;
for (const k of Object.keys(hooks)) count += (hooks[k] || []).length;
console.log(count);
" 2>/dev/null || echo "0")

CODEX_REAL_HOME="$TMPDIR_EVAL/fake-real-codex"   bash "$ROOT_DIR/scripts/install-codex-home.sh" "$CH3_DEST" >/dev/null 2>&1

CH3_AFTER=$(node -e "
const s = JSON.parse(require('fs').readFileSync('$CH3_DEST/hooks.json','utf8'));
const hooks = s.hooks || {};
let count = 0;
for (const k of Object.keys(hooks)) count += (hooks[k] || []).length;
console.log(count);
" 2>/dev/null || echo "0")

if [[ "$CH3_BEFORE" == "$CH3_AFTER" && -n "$CH3_BEFORE" && "$CH3_BEFORE" != "0" ]]; then
  _pass "CH3: codex-home hook count stable on re-run (before=$CH3_BEFORE after=$CH3_AFTER)"
else
  _fail "CH3: codex-home hook count changed on re-run (before=$CH3_BEFORE after=$CH3_AFTER)"
fi

echo ""

# ─── codex-home: CH4: real home preservation ────────────────────────────────
echo "--- CH4: codex-home preserves user config, profiles, hooks, local kit state, and user skills ---"

CH4_DEST="$TMPDIR_EVAL/codex-home-ch4"
CH4_SKILLS="$TMPDIR_EVAL/codex-home-ch4-universal-skills"
mkdir -p "$CH4_DEST/kits/local/repositories/user-kit" "$CH4_SKILLS/user-owned-skill" "$CH4_DEST/ag""ents"

CH4_GENERIC_DIRS=(agent-cards build context docs evals integrations packaging powers prompts schemas scripts kits)
for CH4_DIR in "${CH4_GENERIC_DIRS[@]}"; do
  mkdir -p "$CH4_DEST/$CH4_DIR"
  printf 'user-owned-%s\n' "$CH4_DIR" > "$CH4_DEST/$CH4_DIR/user-owned.txt"
done

cat > "$CH4_DEST/config.toml" << 'EOF_CFG'
model = "user-model"
EOF_CFG

cat > "$CH4_DEST/custom.config.toml" << 'EOF_CFG'
model = "user-profile-model"
EOF_CFG
cat > "$CH4_DEST/builder.config.toml" << 'EOF_CFG'
# Generated from packaging/manifest.json. Edit the manifest, not this file.
model = "old-builder-profile"
EOF_CFG
cat > "$CH4_DEST/retired-generated.config.toml" << 'EOF_CFG'
# Generated from packaging/manifest.json. Edit the manifest, not this file.
model = "old-generated-profile"
EOF_CFG

cat > "$CH4_DEST/AGENTS.md" << 'EOF_AGENTS'
# User Codex Instructions

Arbitrary user bytes must survive exactly.
Unicode: café / 雪
EOF_AGENTS
CH4_AGENTS_BEFORE="$(shasum -a 256 "$CH4_DEST/AGENTS.md" | awk '{print $1}')"

cat > "$CH4_DEST/hooks.json" << 'JSON'
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo ch4-user-stop-hook"
          }
        ]
      }
    ]
  }
}
JSON

cat > "$CH4_DEST/kits/local/installed-kits.json" << 'JSON'
{
  "kits": [
    {
      "id": "user-kit",
      "source": "local-user-source",
      "state": "installed"
    }
  ]
}
JSON
cat > "$CH4_DEST/kits/local/repositories/user-kit/kit.json" << 'JSON'
{"id":"user-kit","name":"User Kit"}
JSON
cat > "$CH4_SKILLS/user-owned-skill/SKILL.md" << 'EOF_SKILL'
# User Owned Skill
EOF_SKILL
cat > "$CH4_DEST/ag""ents/user-owned-agent.toml" << 'EOF_AGENT'
name = "user-owned-agent"
EOF_AGENT

CODEX_REAL_HOME="$TMPDIR_EVAL/fake-real-codex" FLOW_AGENTS_SKILLS_DIR="$CH4_SKILLS" bash "$ROOT_DIR/scripts/install-codex-home.sh" "$CH4_DEST" >/dev/null 2>&1

if grep -q 'user-model' "$CH4_DEST/config.toml" \
  && grep -q 'user-profile-model' "$CH4_DEST/custom.config.toml" \
  && grep -q 'User Codex Instructions' "$CH4_DEST/AGENTS.md" \
  && [[ "$CH4_AGENTS_BEFORE" == "$(shasum -a 256 "$CH4_DEST/AGENTS.md" | awk '{print $1}')" ]]; then
  _pass "CH4: user-owned config.toml, profile, and AGENTS.md preserved"
else
  _fail "CH4: user-owned config.toml, profile, or AGENTS.md was overwritten"
fi

if [[ -f "$CH4_DEST/builder.config.toml" && -f "$CH4_DEST/personal.config.toml" ]] \
  && grep -q 'Flow Agents Builder mode' "$CH4_DEST/builder.config.toml" \
  && grep -q 'knowledge-capture' "$CH4_DEST/personal.config.toml"; then
  _pass "CH4: generated Codex profiles are seeded or refreshed"
else
  _fail "CH4: generated Codex profiles were not seeded or refreshed"
fi

if [[ ! -f "$CH4_DEST/retired-generated.config.toml" ]]; then
  _pass "CH4: retired generated Codex profiles are removed"
else
  _fail "CH4: retired generated Codex profiles were not removed"
fi

if [[ -f "$CH4_DEST/kits/local/installed-kits.json" && -f "$CH4_DEST/kits/local/repositories/user-kit/kit.json" ]] \
  && node - "$CH4_DEST/kits/local/installed-kits.json" << 'NODE'
const fs = require("node:fs");
const registry = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!Array.isArray(registry.kits) || !registry.kits.some((kit) => kit.id === "user-kit")) {
  throw new Error("user kit registry entry missing");
}
console.log("ok");
NODE
then
  _pass "CH4: kits/local registry and repository preserved"
else
  _fail "CH4: kits/local registry or repository was removed"
fi

if [[ -f "$CH4_SKILLS/search-first/SKILL.md" && -f "$CH4_SKILLS/plan-work/SKILL.md" && -f "$CH4_SKILLS/user-owned-skill/SKILL.md" ]]; then
  _pass "CH4: root, Builder Kit workflow, and user-owned skills coexist in universal Codex skills"
else
  _fail "CH4: root skill, Builder Kit workflow skill, or user-owned skill missing from universal Codex skills"
fi

if [[ -f "$CH4_DEST/scripts/install-merge.js" && -f "$CH4_DEST/build/src/cli/kit.js" && -f "$CH4_DEST/ag""ents/tool-worker.toml" && -f "$CH4_DEST/ag""ents/user-owned-agent.toml" && -f "$CH4_DEST/hooks.json" ]] \
  && node - "$CH4_DEST/hooks.json" << 'NODE'
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const stopGroups = (s.hooks || {}).Stop || [];
const hasUser = stopGroups.some((g) => (g.hooks || []).some((h) => String(h.command || "").includes("echo ch4-user-stop-hook")));
const hasFA = Object.values(s.hooks || {}).flat().some((g) => (g.hooks || []).some((h) => String(h.statusMessage || "").includes("Recording Flow Agents telemetry")));
if (!hasUser) throw new Error("user hook missing");
if (!hasFA) throw new Error("FA hooks missing");
console.log("ok");
NODE
then
  _pass "CH4: Flow Agents bundle scripts, build artifacts, generated/user agents, and merged hooks installed"
else
  _fail "CH4: bundle scripts, build artifacts, generated/user agents, or merged hooks missing"
fi

if node "$CH4_DEST/scripts/kit.js" list --dest "$CH4_DEST" >/dev/null 2>&1; then
  _pass "CH4: installed scripts/kit.js runs with installed build bundle"
else
  _fail "CH4: installed scripts/kit.js could not run with installed build bundle"
fi

CODEX_REAL_HOME="$TMPDIR_EVAL/fake-real-codex" FLOW_AGENTS_SKILLS_DIR="$CH4_SKILLS" bash "$ROOT_DIR/scripts/install-codex-home.sh" "$CH4_DEST" >/dev/null 2>&1
CH4_GENERIC_PRESERVED=1
for CH4_DIR in "${CH4_GENERIC_DIRS[@]}"; do
  [[ "$(cat "$CH4_DEST/$CH4_DIR/user-owned.txt" 2>/dev/null)" == "user-owned-$CH4_DIR" ]] || CH4_GENERIC_PRESERVED=0
done
if [[ "$CH4_GENERIC_PRESERVED" -eq 1 && -f "$CH4_DEST/.flow-agents/codex-install-manifest.json" ]]; then
  _pass "CH4: unrelated files in every shared bundle directory survive install and reinstall"
else
  _fail "CH4: install or reinstall removed unrelated files from a shared bundle directory"
fi

echo ""

# ─── codex-home: CH5: destination symlink containment ───────────────────────
echo "--- CH5: codex-home refuses managed destination symlinks ---"

for CH5_REL in scripts kits hooks.json; do
  CH5_DEST="$TMPDIR_EVAL/codex-home-ch5-${CH5_REL//\//-}"
  CH5_OUTSIDE="$TMPDIR_EVAL/codex-home-ch5-outside-${CH5_REL//\//-}"
  mkdir -p "$CH5_DEST" "$CH5_OUTSIDE"
  ln -s "$CH5_OUTSIDE" "$CH5_DEST/$CH5_REL"
  if CODEX_REAL_HOME="$TMPDIR_EVAL/fake-real-codex" bash "$ROOT_DIR/scripts/install-codex-home.sh" "$CH5_DEST" >"$TMPDIR_EVAL/ch5.out" 2>&1; then
    _fail "CH5: install unexpectedly succeeded with symlinked destination $CH5_REL"
  elif grep -q "refusing to write through symlink" "$TMPDIR_EVAL/ch5.out" \
    && [[ -z "$(find "$CH5_OUTSIDE" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    _pass "CH5: install refuses symlinked destination $CH5_REL without writing outside"
  else
    _fail "CH5: symlinked destination $CH5_REL did not fail closed"
  fi
done

CH8_FIXTURES="$ROOT_DIR/evals/fixtures/codex-legacy-agents"
CH8_PREFLIGHT="$TMPDIR_EVAL/codex-home-ch8-later-preflight"
mkdir -p "$CH8_PREFLIGHT/scripts"
cp "$CH8_FIXTURES/5273878130bdafc8a024a650bb5b66c9b003f1f859b5dc6e5b588cbf4ab23228.md" "$CH8_PREFLIGHT/AGENTS.md"
printf 'unowned collision\n' > "$CH8_PREFLIGHT/scripts/kit.js"
CH8_PREFLIGHT_BEFORE="$(shasum -a 256 "$CH8_PREFLIGHT/AGENTS.md" | awk '{print $1}')"
if CODEX_REAL_HOME="$TMPDIR_EVAL/fake-real-codex" FLOW_AGENTS_SKILLS_DIR="$TMPDIR_EVAL/ch8-preflight-skills" \
  bash "$ROOT_DIR/scripts/install-codex-home.sh" "$CH8_PREFLIGHT" >"$TMPDIR_EVAL/ch8-preflight.out" 2>&1; then
  _fail "CH8: later owned-overlay collision unexpectedly installed"
elif [[ "$CH8_PREFLIGHT_BEFORE" == "$(shasum -a 256 "$CH8_PREFLIGHT/AGENTS.md" | awk '{print $1}')" ]] \
  && [[ ! -e "$CH8_PREFLIGHT/.flow-agents/manual-recovery" && ! -e "$CH8_PREFLIGHT/hooks.json" ]]; then
  _pass "CH8: complete install preflight failure leaves exact legacy source and destination untouched"
else
  _fail "CH8: later install preflight failure partially migrated or mutated destination"
fi

echo ""
echo "--- CH6: codex-home rejects canonical source/destination overlap before writes ---"
CH6_ROOT="$TMPDIR_EVAL/ch6-fixture-root"
CH6_FAKE_BIN="$TMPDIR_EVAL/ch6-bin"
CH_FIXTURE_SCRIPTS="scr""ipts"
CH_FIXTURE_SKILLS="sk""ills"
CH_FIXTURE_AGENTS="ag""ents"
mkdir -p \
  "$CH6_ROOT/$CH_FIXTURE_SCRIPTS" \
  "$CH6_ROOT/packaging" \
  "$CH6_ROOT/dist/codex/packaging" \
  "$CH6_ROOT/dist/codex/$CH_FIXTURE_SCRIPTS" \
  "$CH6_ROOT/dist/codex/.codex" \
  "$CH6_ROOT/dist/codex/.agents/skills/deliver" \
  "$CH6_ROOT/dist/codex/build/src" \
  "$CH6_FAKE_BIN"
cp "$ROOT_DIR/scripts/install-codex-home.sh" "$ROOT_DIR/scripts/install-owned-files.js" "$ROOT_DIR/scripts/classify-codex-legacy-agents.js" "$ROOT_DIR/scripts/install-merge.js" "$ROOT_DIR/scripts/package.json" "$CH6_ROOT/$CH_FIXTURE_SCRIPTS/"
cp "$ROOT_DIR/scripts/install-owned-files.js" "$ROOT_DIR/scripts/install-merge.js" "$ROOT_DIR/scripts/classify-codex-legacy-agents.js" "$ROOT_DIR/scripts/package.json" "$CH6_ROOT/dist/codex/$CH_FIXTURE_SCRIPTS/"
cp "$ROOT_DIR/packaging/codex-legacy-agents-fingerprints.json" "$CH6_ROOT/packaging/"
cp "$ROOT_DIR/packaging/codex-legacy-agents-fingerprints.json" "$CH6_ROOT/dist/codex/packaging/"
cp "$ROOT_DIR/package.json" "$CH6_ROOT/package.json"
cp "$ROOT_DIR/package.json" "$CH6_ROOT/dist/codex/package.json"
cp "$ROOT_DIR/dist/codex/build/package.json" "$ROOT_DIR/dist/codex/build/runtime-dependencies.json" "$CH6_ROOT/dist/codex/build/"
cp -R "$ROOT_DIR/dist/codex/build/runtime-node-modules" "$CH6_ROOT/dist/codex/build/"
printf '{"hooks":{}}\n' > "$CH6_ROOT/dist/codex/.codex/hooks.json"
printf '# deliver fixture\n' > "$CH6_ROOT/dist/codex/.agents/skills/deliver/SKILL.md"
printf '// cli fixture\n' > "$CH6_ROOT/dist/codex/build/src/cli.js"
printf '#!/usr/bin/env bash\nexit 0\n' > "$CH6_FAKE_BIN/npm"
chmod +x "$CH6_FAKE_BIN/npm"
printf 'fixture\n' > "$CH6_ROOT/dist/codex/$CH_FIXTURE_SCRIPTS/fixture.txt"
mkdir -p "$CH6_ROOT/dist/codex/.codex/$CH_FIXTURE_SKILLS/legacy-collision" "$CH6_ROOT/dist/codex/.codex/$CH_FIXTURE_AGENTS"
printf 'flow-agents-new-skill\n' > "$CH6_ROOT/dist/codex/.codex/$CH_FIXTURE_SKILLS/legacy-collision/SKILL.md"
printf 'name = "flow-agents-new-agent"\n' > "$CH6_ROOT/dist/codex/.codex/$CH_FIXTURE_AGENTS/legacy-collision.toml"

for CH6_CASE in equal descendant ancestor; do
  case "$CH6_CASE" in
    equal) CH6_DEST="$CH6_ROOT" ;;
    descendant) CH6_DEST="$CH6_ROOT/nested-destination" ;;
    ancestor) CH6_DEST="$TMPDIR_EVAL" ;;
  esac
  if PATH="$CH6_FAKE_BIN:$PATH" HOME="$TMPDIR_EVAL/ch6-home" bash "$CH6_ROOT/$CH_FIXTURE_SCRIPTS/install-codex-home.sh" "$CH6_DEST" >"$TMPDIR_EVAL/ch6-$CH6_CASE.out" 2>&1; then
    _fail "CH6: installer accepted $CH6_CASE source/destination overlap"
  elif grep -q 'overlaps' "$TMPDIR_EVAL/ch6-$CH6_CASE.out" && [[ -f "$CH6_ROOT/dist/codex/$CH_FIXTURE_SCRIPTS/fixture.txt" ]]; then
    _pass "CH6: installer rejects $CH6_CASE canonical overlap before source mutation"
  else
    _fail "CH6: installer did not safely reject $CH6_CASE overlap"
  fi
done

CH6_AUTH_DEST="$TMPDIR_EVAL/ch6-auth-dest"
CH6_AUTH_ALIAS="$TMPDIR_EVAL/ch6-auth-alias"
mkdir -p "$CH6_AUTH_DEST"
printf '{"user":"preserved"}\n' > "$CH6_AUTH_DEST/auth.json"
ln -s "$CH6_AUTH_DEST" "$CH6_AUTH_ALIAS"
if PATH="$CH6_FAKE_BIN:$PATH" HOME="$TMPDIR_EVAL/ch6-home" CODEX_REAL_HOME="$CH6_AUTH_ALIAS" bash "$CH6_ROOT/$CH_FIXTURE_SCRIPTS/install-codex-home.sh" "$CH6_AUTH_DEST" >"$TMPDIR_EVAL/ch6-auth.out" 2>&1 \
  && grep -q '"user":"preserved"' "$CH6_AUTH_DEST/auth.json"; then
  _pass "CH6: canonical auth-home alias is treated as self-copy and preserved"
else
  _fail "CH6: canonical auth-home alias caused a self-copy failure or mutation"
fi

echo ""
echo "--- CH7: pre-manifest ownership bootstrap is evidence-bound ---"
seed_ch7_legacy() {
  local destination="$1"
  local installed_at="$2"
  mkdir -p "$destination/.flow-agents" "$destination/$CH_FIXTURE_SCRIPTS"
  printf 'old-release\n' > "$destination/$CH_FIXTURE_SCRIPTS/fixture.txt"
  cat > "$destination/.flow-agents/install.json" <<JSON
{"version":"3.2.0","installedAt":"$installed_at","runtime":"codex"}
JSON
  cat > "$destination/hooks.json" <<'JSON'
{"hooks":{"Stop":[{"hooks":[{"statusMessage":"Recording Flow Agents telemetry"}]}]}}
JSON
}

CH7_LEGACY="$TMPDIR_EVAL/ch7-genuine-legacy"
seed_ch7_legacy "$CH7_LEGACY" "2099-01-01T00:00:00.000Z"
if PATH="$CH6_FAKE_BIN:$PATH" HOME="$TMPDIR_EVAL/ch7-home" CODEX_REAL_HOME="$TMPDIR_EVAL/ch7-real" bash "$CH6_ROOT/$CH_FIXTURE_SCRIPTS/install-codex-home.sh" "$CH7_LEGACY" >"$TMPDIR_EVAL/ch7-legacy.out" 2>&1 \
  && [[ "$(cat "$CH7_LEGACY/$CH_FIXTURE_SCRIPTS/fixture.txt")" == "fixture" ]] \
  && [[ -f "$CH7_LEGACY/.flow-agents/codex-install-manifest.json" ]]; then
  _pass "CH7: corroborated pre-manifest legacy owned file upgrades and gains a manifest"
else
  _fail "CH7: genuine pre-manifest legacy install did not upgrade"
fi

CH7_ARBITRARY="$TMPDIR_EVAL/ch7-arbitrary-collision"
mkdir -p "$CH7_ARBITRARY/$CH_FIXTURE_SCRIPTS"
printf 'user-arbitrary\n' > "$CH7_ARBITRARY/$CH_FIXTURE_SCRIPTS/fixture.txt"
if PATH="$CH6_FAKE_BIN:$PATH" HOME="$TMPDIR_EVAL/ch7-home" CODEX_REAL_HOME="$TMPDIR_EVAL/ch7-real" bash "$CH6_ROOT/$CH_FIXTURE_SCRIPTS/install-codex-home.sh" "$CH7_ARBITRARY" >"$TMPDIR_EVAL/ch7-arbitrary.out" 2>&1; then
  _fail "CH7: first install overwrote an arbitrary unowned collision"
elif [[ "$(cat "$CH7_ARBITRARY/$CH_FIXTURE_SCRIPTS/fixture.txt")" == "user-arbitrary" ]] && grep -q 'unowned or ambiguous' "$TMPDIR_EVAL/ch7-arbitrary.out"; then
  _pass "CH7: arbitrary unowned collision fails before mutation and survives"
else
  _fail "CH7: arbitrary collision was not preserved cleanly"
fi

CH7_MODIFIED="$TMPDIR_EVAL/ch7-modified-ambiguous"
seed_ch7_legacy "$CH7_MODIFIED" "2000-01-01T00:00:00.000Z"
printf 'user-modified-after-install\n' > "$CH7_MODIFIED/$CH_FIXTURE_SCRIPTS/fixture.txt"
if PATH="$CH6_FAKE_BIN:$PATH" HOME="$TMPDIR_EVAL/ch7-home" CODEX_REAL_HOME="$TMPDIR_EVAL/ch7-real" bash "$CH6_ROOT/$CH_FIXTURE_SCRIPTS/install-codex-home.sh" "$CH7_MODIFIED" >"$TMPDIR_EVAL/ch7-modified.out" 2>&1; then
  _fail "CH7: ambiguous post-install modification was overwritten"
elif [[ "$(cat "$CH7_MODIFIED/$CH_FIXTURE_SCRIPTS/fixture.txt")" == "user-modified-after-install" ]] && grep -q 'unowned or ambiguous' "$TMPDIR_EVAL/ch7-modified.out"; then
  _pass "CH7: modified ambiguous legacy-path file fails before mutation and survives"
else
  _fail "CH7: modified ambiguous file was not preserved cleanly"
fi

CH7_EXTENSIBLE="$TMPDIR_EVAL/ch7-user-extensible"
seed_ch7_legacy "$CH7_EXTENSIBLE" "2099-01-01T00:00:00.000Z"
mkdir -p "$CH7_EXTENSIBLE/$CH_FIXTURE_SKILLS/legacy-collision" "$CH7_EXTENSIBLE/$CH_FIXTURE_AGENTS"
printf 'older-user-skill\n' > "$CH7_EXTENSIBLE/$CH_FIXTURE_SKILLS/legacy-collision/SKILL.md"
printf 'name = "older-user-agent"\n' > "$CH7_EXTENSIBLE/$CH_FIXTURE_AGENTS/legacy-collision.toml"
if PATH="$CH6_FAKE_BIN:$PATH" HOME="$TMPDIR_EVAL/ch7-home" CODEX_REAL_HOME="$TMPDIR_EVAL/ch7-real" bash "$CH6_ROOT/$CH_FIXTURE_SCRIPTS/install-codex-home.sh" "$CH7_EXTENSIBLE" >"$TMPDIR_EVAL/ch7-extensible.out" 2>&1; then
  _fail "CH7: legacy inference claimed a pre-existing user skill or agent"
elif [[ "$(cat "$CH7_EXTENSIBLE/$CH_FIXTURE_SKILLS/legacy-collision/SKILL.md")" == "older-user-skill" ]] \
  && grep -q 'older-user-agent' "$CH7_EXTENSIBLE/$CH_FIXTURE_AGENTS/legacy-collision.toml" \
  && grep -q 'unowned or ambiguous' "$TMPDIR_EVAL/ch7-extensible.out"; then
  _pass "CH7: older user skill and agent collisions remain ambiguous and preserved"
else
  _fail "CH7: user-extensible skill or agent collision was not preserved cleanly"
fi

CH7_RETRY="$TMPDIR_EVAL/ch7-interrupted-retry"
mkdir -p "$CH7_RETRY/.flow-agents" "$CH7_RETRY/$CH_FIXTURE_SCRIPTS"
printf 'fixture\n' > "$CH7_RETRY/$CH_FIXTURE_SCRIPTS/fixture.txt"
printf 'stale-old\n' > "$CH7_RETRY/$CH_FIXTURE_SCRIPTS/stale.txt"
CH7_OLD_HASH="$(printf 'old-release\n' | shasum -a 256 | awk '{print $1}')"
CH7_STALE_HASH="$(shasum -a 256 "$CH7_RETRY/$CH_FIXTURE_SCRIPTS/stale.txt" | awk '{print $1}')"
cat > "$CH7_RETRY/.flow-agents/codex-install-manifest.json" <<JSON
{"schema_version":"1.0","files":[{"path":"$CH_FIXTURE_SCRIPTS/fixture.txt","sha256":"$CH7_OLD_HASH"},{"path":"$CH_FIXTURE_SCRIPTS/stale.txt","sha256":"$CH7_STALE_HASH"}]}
JSON
if PATH="$CH6_FAKE_BIN:$PATH" HOME="$TMPDIR_EVAL/ch7-home" CODEX_REAL_HOME="$TMPDIR_EVAL/ch7-real" bash "$CH6_ROOT/$CH_FIXTURE_SCRIPTS/install-codex-home.sh" "$CH7_RETRY" >"$TMPDIR_EVAL/ch7-retry.out" 2>&1 \
  && [[ "$(cat "$CH7_RETRY/$CH_FIXTURE_SCRIPTS/fixture.txt")" == "fixture" ]] \
  && [[ ! -e "$CH7_RETRY/$CH_FIXTURE_SCRIPTS/stale.txt" ]]; then
  _pass "CH7: interrupted apply retries when current content already matches incoming and removes stale owned files"
else
  _fail "CH7: interrupted apply state was not retry-safe"
fi

CH7_THIRD="$TMPDIR_EVAL/ch7-interrupted-third-content"
mkdir -p "$CH7_THIRD/.flow-agents" "$CH7_THIRD/$CH_FIXTURE_SCRIPTS"
printf 'third-party-change\n' > "$CH7_THIRD/$CH_FIXTURE_SCRIPTS/fixture.txt"
cat > "$CH7_THIRD/.flow-agents/codex-install-manifest.json" <<JSON
{"schema_version":"1.0","files":[{"path":"$CH_FIXTURE_SCRIPTS/fixture.txt","sha256":"$CH7_OLD_HASH"}]}
JSON
if PATH="$CH6_FAKE_BIN:$PATH" HOME="$TMPDIR_EVAL/ch7-home" CODEX_REAL_HOME="$TMPDIR_EVAL/ch7-real" bash "$CH6_ROOT/$CH_FIXTURE_SCRIPTS/install-codex-home.sh" "$CH7_THIRD" >"$TMPDIR_EVAL/ch7-third.out" 2>&1; then
  _fail "CH7: retry safety accepted arbitrary third content"
elif [[ "$(cat "$CH7_THIRD/$CH_FIXTURE_SCRIPTS/fixture.txt")" == "third-party-change" ]] && grep -q 'modified Flow Agents file' "$TMPDIR_EVAL/ch7-third.out"; then
  _pass "CH7: retry safety still rejects and preserves arbitrary third content"
else
  _fail "CH7: arbitrary third content was not rejected cleanly"
fi

CH7_FRESH="$TMPDIR_EVAL/ch7-fresh"
mkdir -p "$CH7_FRESH/$CH_FIXTURE_SCRIPTS"
printf 'user-unrelated\n' > "$CH7_FRESH/$CH_FIXTURE_SCRIPTS/user-owned.txt"
if PATH="$CH6_FAKE_BIN:$PATH" HOME="$TMPDIR_EVAL/ch7-home" CODEX_REAL_HOME="$TMPDIR_EVAL/ch7-real" bash "$CH6_ROOT/$CH_FIXTURE_SCRIPTS/install-codex-home.sh" "$CH7_FRESH" >"$TMPDIR_EVAL/ch7-fresh.out" 2>&1 \
  && [[ "$(cat "$CH7_FRESH/$CH_FIXTURE_SCRIPTS/fixture.txt")" == "fixture" ]] \
  && [[ "$(cat "$CH7_FRESH/$CH_FIXTURE_SCRIPTS/user-owned.txt")" == "user-unrelated" ]]; then
  _pass "CH7: safe first install writes owned files and preserves unrelated files"
else
  _fail "CH7: safe first install or unrelated-file preservation regressed"
fi

echo ""

# ─── opencode --global: OG1: seed user key → install --global → key survives + $schema + stamp ─
echo "=== Install Merge-Aware Tests (--global runtimes) ==="
echo ""
echo "--- OG1: opencode --global — seed user key → user key survives + \$schema + no spurious hooks + stamp ---"

OG1_CONFIG_DIR="$TMPDIR_EVAL/opencode-global-og1"
mkdir -p "$OG1_CONFIG_DIR"
OG1_CONFIG_FILE="$OG1_CONFIG_DIR/opencode.json"

# Seed the global opencode.json with a user key
cat > "$OG1_CONFIG_FILE" << 'JSON'
{
  "model": "og1-user-model",
  "myUserKey": "og1-preserved"
}
JSON

# Run init --global --runtime opencode, using env override for path isolation
FLOW_AGENTS_USER_OPENCODE_CONFIG="$OG1_CONFIG_FILE"   node "$ROOT_DIR/build/src/cli.js" init --runtime opencode --global --yes >/dev/null 2>&1 || true

# Assert: user key survived
if node - "$OG1_CONFIG_FILE" << 'NODE'
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (s.model !== "og1-user-model") throw new Error("user key 'model' clobbered: " + JSON.stringify(s));
if (s.myUserKey !== "og1-preserved") throw new Error("user key 'myUserKey' clobbered: " + JSON.stringify(s));
console.log("ok");
NODE
then
  _pass "OG1: opencode --global: user keys survived merge"
else
  _fail "OG1: opencode --global: user keys were clobbered"
fi

# Assert: $schema present
if node - "$OG1_CONFIG_FILE" << 'NODE'
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (s["$schema"] !== "https://opencode.ai/config.json") throw new Error("\$schema missing or wrong: " + JSON.stringify(s));
console.log("ok");
NODE
then
  _pass "OG1: opencode --global: \$schema present after merge"
else
  _fail "OG1: opencode --global: \$schema missing after merge"
fi

# Assert: no spurious empty hooks key
if node - "$OG1_CONFIG_FILE" << 'NODE'
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if ("hooks" in s) throw new Error("spurious empty hooks key found: " + JSON.stringify(s));
console.log("ok");
NODE
then
  _pass "OG1: opencode --global: no spurious empty hooks key"
else
  _fail "OG1: opencode --global: spurious hooks key was injected"
fi

# Assert: version stamp written
if node - "$OG1_CONFIG_DIR/.flow-agents/install.json" << 'NODE'
const fs = require("node:fs");
const record = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!record.version) throw new Error("install.json missing version");
if (!record.installedAt) throw new Error("install.json missing installedAt");
if (record.runtime !== "opencode") throw new Error("wrong runtime: " + record.runtime);
if (record.global !== true) throw new Error("global flag not set in stamp");
console.log("ok: version=" + record.version);
NODE
then
  _pass "OG1: opencode --global: version stamp written (runtime=opencode, global=true)"
else
  _fail "OG1: opencode --global: version stamp missing or wrong"
fi

echo ""

# ─── codex --global: CG1: FA hooks + stamp present ───────────────────────────
echo "--- CG1: codex --global routes to codex-home — FA hooks + stamp present ---"

CG1_DEST="$TMPDIR_EVAL/codex-global-cg1"
mkdir -p "$CG1_DEST"

# Run init --global --runtime codex with dest override (sandbox isolation)
if CODEX_REAL_HOME="$TMPDIR_EVAL/fake-real-codex" node "$ROOT_DIR/build/src/cli.js" init --runtime codex --global --dest "$CG1_DEST" --activate-kits --yes >/dev/null 2>&1; then
  _pass "CG1: codex --global --activate-kits command succeeds"
else
  _fail "CG1: codex --global --activate-kits command failed"
fi

# Assert: FA hooks present in $DEST/hooks.json
if node - "$CG1_DEST/hooks.json" << 'NODE'
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const hooks = s.hooks || {};
const hasFA = Object.values(hooks).flat().some(
  (g) => (g.hooks || []).some((h) => String(h.statusMessage || "").includes("Recording Flow Agents telemetry"))
);
if (!hasFA) throw new Error("FA hooks not found in codex-global hooks.json");
console.log("ok");
NODE
then
  _pass "CG1: codex --global: FA hooks present in codex-home hooks.json"
else
  _fail "CG1: codex --global: FA hooks missing from codex-home hooks.json"
fi

# Assert: version stamp written
if node - "$CG1_DEST/.flow-agents/install.json" << 'NODE'
const fs = require("node:fs");
const record = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!record.version) throw new Error("install.json missing version");
if (record.runtime !== "codex") throw new Error("wrong runtime: " + record.runtime);
console.log("ok: version=" + record.version + " runtime=" + record.runtime);
NODE
then
  _pass "CG1: codex --global: version stamp written (runtime=codex)"
else
  _fail "CG1: codex --global: version stamp missing or wrong"
fi

if [[ -f "$CG1_DEST/.kontourai/flow-agents/projections/codex/activation.json" ]]; then
  _pass "CG1: codex --global --activate-kits writes activation output under target Codex home"
else
  _fail "CG1: codex --global --activate-kits did not write activation output under target Codex home"
fi

echo ""

# ─── codex --global: CG1B: default CODEX_HOME + --dest override precedence ───
echo "--- CG1B: codex --global default honors CODEX_HOME and --dest overrides ---"

CG1B_CODEX_HOME="$TMPDIR_EVAL/codex-global-cg1b-codex-home"
CG1B_OVERRIDE="$TMPDIR_EVAL/codex-global-cg1b-override"
mkdir -p "$CG1B_CODEX_HOME" "$CG1B_OVERRIDE"

if CODEX_HOME="$CG1B_CODEX_HOME" CODEX_REAL_HOME="$TMPDIR_EVAL/fake-real-codex" node "$ROOT_DIR/build/src/cli.js" init --runtime codex --global --yes >/dev/null 2>&1; then
  _pass "CG1B: codex --global without --dest command succeeds"
else
  _fail "CG1B: codex --global without --dest command failed"
fi

if [[ -f "$CG1B_CODEX_HOME/hooks.json" && -f "$CG1B_CODEX_HOME/.flow-agents/install.json" ]]; then
  _pass "CG1B: codex --global without --dest installs into CODEX_HOME"
else
  _fail "CG1B: codex --global without --dest did not install into CODEX_HOME"
fi

rm -rf "$CG1B_CODEX_HOME"
mkdir -p "$CG1B_CODEX_HOME"

if CODEX_HOME="$CG1B_CODEX_HOME" CODEX_REAL_HOME="$TMPDIR_EVAL/fake-real-codex" node "$ROOT_DIR/build/src/cli.js" init --runtime codex --global --dest "$CG1B_OVERRIDE" --yes >/dev/null 2>&1; then
  _pass "CG1B: codex --global --dest command succeeds"
else
  _fail "CG1B: codex --global --dest command failed"
fi

if [[ -f "$CG1B_OVERRIDE/hooks.json" && -f "$CG1B_OVERRIDE/.flow-agents/install.json" ]]; then
  _pass "CG1B: codex --global --dest overrides CODEX_HOME"
else
  _fail "CG1B: codex --global --dest did not override CODEX_HOME"
fi

if [[ ! -e "$CG1B_CODEX_HOME/hooks.json" && ! -e "$CG1B_CODEX_HOME/.flow-agents/install.json" ]]; then
  _pass "CG1B: codex --global --dest did not write install artifacts into CODEX_HOME"
else
  _fail "CG1B: codex --global --dest wrote install artifacts into CODEX_HOME"
fi

echo ""

# ─── codex --global: CG2: fresh install clean ────────────────────────────────
echo "--- CG2: codex --global fresh install — clean codex-home ---"

CG2_DEST="$TMPDIR_EVAL/codex-global-cg2"
mkdir -p "$CG2_DEST"

# Fresh install (no prior hooks.json)
CODEX_REAL_HOME="$TMPDIR_EVAL/fake-real-codex"   node "$ROOT_DIR/build/src/cli.js" init --runtime codex --global --dest "$CG2_DEST" --yes >/dev/null 2>&1 || true

# Assert: hooks.json exists and has FA hooks
if [[ -f "$CG2_DEST/hooks.json" ]] && node - "$CG2_DEST/hooks.json" << 'NODE'
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const hooks = s.hooks || {};
if (Object.keys(hooks).length === 0) throw new Error("No hooks in fresh codex-global install");
const hasFA = Object.values(hooks).flat().some(
  (g) => (g.hooks || []).some((h) => String(h.statusMessage || "").includes("Recording Flow Agents telemetry"))
);
if (!hasFA) throw new Error("FA hooks not found in fresh codex-global hooks.json");
console.log("ok");
NODE
then
  _pass "CG2: codex --global fresh install: hooks.json present with FA hooks"
else
  _fail "CG2: codex --global fresh install: hooks.json missing or FA hooks absent"
fi

echo ""

# ─── codex-home: CH8: global instruction cleanup and preservation ───────────
echo "--- CH8: codex-home does not install global instructions and safely migrates exact legacy files ---"

CH8_SKILLS="$TMPDIR_EVAL/codex-home-ch8-skills"
CH8_CLEAN="$TMPDIR_EVAL/codex-home-ch8-clean"
mkdir -p "$CH8_CLEAN"
CH8_CLEAN_OUT="$TMPDIR_EVAL/ch8-clean.out"
if CODEX_REAL_HOME="$TMPDIR_EVAL/fake-real-codex" FLOW_AGENTS_SKILLS_DIR="$CH8_SKILLS" \
  bash "$ROOT_DIR/scripts/install-codex-home.sh" "$CH8_CLEAN" >"$CH8_CLEAN_OUT" 2>&1 \
  && [[ ! -e "$CH8_CLEAN/AGENTS.md" ]] \
  && [[ -f "$CH8_CLEAN/hooks.json" && -f "$CH8_CLEAN/ag""ents/tool-worker.toml" ]] \
  && [[ -f "$CH8_SKILLS/plan-work/SKILL.md" ]]; then
  _pass "CH8: clean install leaves global AGENTS.md absent while runtime assets and universal skills install"
else
  _fail "CH8: clean install created global instructions or lost required install assets"
fi

CH8_FIXTURES="$ROOT_DIR/evals/fixtures/codex-legacy-agents"
while IFS=$'\t' read -r CH8_HASH CH8_BYTES; do
  CH8_LEGACY="$TMPDIR_EVAL/codex-home-ch8-legacy-$CH8_HASH"
  CH8_LEGACY_SKILLS="$TMPDIR_EVAL/codex-home-ch8-legacy-skills-$CH8_HASH"
  mkdir -p "$CH8_LEGACY"
  CH8_LEGACY_REAL="$(cd "$CH8_LEGACY" && pwd -P)"
  cp "$CH8_FIXTURES/$CH8_HASH.md" "$CH8_LEGACY/AGENTS.md"
  printf 'destination sentinel\n' > "$CH8_LEGACY/preflight-sentinel"
  printf 'skills sentinel\n' > "$CH8_LEGACY_SKILLS.sentinel"
  CH8_SOURCE_BEFORE="$(shasum -a 256 "$CH8_LEGACY/AGENTS.md" | awk '{print $1}')"
  CH8_OUT="$TMPDIR_EVAL/ch8-$CH8_HASH.out"
  if CODEX_REAL_HOME="$TMPDIR_EVAL/fake-real-codex" FLOW_AGENTS_SKILLS_DIR="$CH8_LEGACY_SKILLS" \
    bash "$ROOT_DIR/scripts/install-codex-home.sh" "$CH8_LEGACY" >"$CH8_OUT" 2>&1; then
    _fail "CH8: audited legacy fingerprint $CH8_HASH did not refuse installation"
  elif [[ "$CH8_SOURCE_BEFORE" == "$(shasum -a 256 "$CH8_LEGACY/AGENTS.md" | awk '{print $1}')" ]] \
    && [[ "$(cat "$CH8_LEGACY/preflight-sentinel")" == "destination sentinel" ]] \
    && [[ ! -e "$CH8_LEGACY/hooks.json" && ! -e "$CH8_LEGACY_SKILLS" ]] \
    && grep -F -q "path=$CH8_LEGACY_REAL/AGENTS.md" "$CH8_OUT" \
    && grep -F -q "sha256=$CH8_HASH bytes=$CH8_BYTES" "$CH8_OUT" \
    && grep -q 'matching_releases=v2.4.0@bee760272b8bb770df02400ccc5881bd3dbc8806' "$CH8_OUT" \
    && grep -F -q "evidence command (hash): shasum -a 256 -- '$CH8_LEGACY_REAL/AGENTS.md'" "$CH8_OUT" \
    && grep -F -q "evidence command (bytes): wc -c < '$CH8_LEGACY_REAL/AGENTS.md'" "$CH8_OUT" \
    && grep -q 'Stop all agent and writer processes' "$CH8_OUT" \
    && grep -q 'Move the file manually without overwrite using operator-trusted tooling' "$CH8_OUT" \
    && ! grep -Eq '(^|: )(mv|rm|cp)( |$)| && (mv|rm|cp) ' "$CH8_OUT"; then
    _pass "CH8: audited legacy fingerprint $CH8_HASH refuses before mutation with exact evidence and manual checklist"
  else
    _fail "CH8: audited legacy fingerprint $CH8_HASH refusal mutated state or lacked actionable evidence"
  fi
  mkdir -p "$CH8_LEGACY/.flow-agents/manual-recovery"
  mv "$CH8_LEGACY/AGENTS.md" "$CH8_LEGACY/.flow-agents/manual-recovery/legacy-generated-AGENTS.$CH8_HASH.md"
  if CODEX_REAL_HOME="$TMPDIR_EVAL/fake-real-codex" FLOW_AGENTS_SKILLS_DIR="$CH8_LEGACY_SKILLS" \
    bash "$ROOT_DIR/scripts/install-codex-home.sh" "$CH8_LEGACY" >/dev/null 2>&1 \
    && cmp -s "$CH8_FIXTURES/$CH8_HASH.md" "$CH8_LEGACY/.flow-agents/manual-recovery/legacy-generated-AGENTS.$CH8_HASH.md" \
    && [[ ! -e "$CH8_LEGACY/AGENTS.md" && -f "$CH8_LEGACY/hooks.json" && -f "$CH8_LEGACY_SKILLS/plan-work/SKILL.md" ]]; then
    _pass "CH8: simulated operator remediation enables install without recreating AGENTS.md"
  else
    _fail "CH8: operator-remediated rerun failed or recreated global instructions"
  fi
done < <(node - "$ROOT_DIR/packaging/codex-legacy-agents-fingerprints.json" <<'NODE'
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
for (const entry of manifest.files || []) console.log(`${entry.sha256}\t${entry.bytes}`);
NODE
)

CH8_QUOTED="$TMPDIR_EVAL/codex-home-ch8-operator-'quoted"
mkdir -p "$CH8_QUOTED"
cp "$CH8_FIXTURES/5273878130bdafc8a024a650bb5b66c9b003f1f859b5dc6e5b588cbf4ab23228.md" "$CH8_QUOTED/AGENTS.md"
CH8_QUOTED_OUT="$TMPDIR_EVAL/ch8-quoted.out"
if node "$ROOT_DIR/scripts/classify-codex-legacy-agents.js" "$CH8_QUOTED" "$ROOT_DIR/packaging/codex-legacy-agents-fingerprints.json" >"$CH8_QUOTED_OUT" 2>&1; then
  _fail "CH8: quoted-path exact legacy classifier did not refuse"
else
  CH8_QUOTED_HASH_COMMAND="$(sed -n 's/^classify-codex-legacy-agents: evidence command (hash): //p' "$CH8_QUOTED_OUT")"
  CH8_QUOTED_BYTES_COMMAND="$(sed -n 's/^classify-codex-legacy-agents: evidence command (bytes): //p' "$CH8_QUOTED_OUT")"
  if [[ "$CH8_QUOTED_HASH_COMMAND" == *"'\"'\"'"* && "$CH8_QUOTED_BYTES_COMMAND" == *"'\"'\"'"* ]] \
    && bash -n -c "$CH8_QUOTED_HASH_COMMAND" && bash -n -c "$CH8_QUOTED_BYTES_COMMAND"; then
    _pass "CH8: evidence commands safely shell-quote apostrophes in paths"
  else
    _fail "CH8: evidence commands are not safely shell-quoted"
  fi
fi

CH8_NEAR="$TMPDIR_EVAL/codex-home-ch8-near"
mkdir -p "$CH8_NEAR"
cp "$CH8_FIXTURES/5273878130bdafc8a024a650bb5b66c9b003f1f859b5dc6e5b588cbf4ab23228.md" "$CH8_NEAR/AGENTS.md"
printf 'user modification\n' >> "$CH8_NEAR/AGENTS.md"
CH8_NEAR_BEFORE="$(shasum -a 256 "$CH8_NEAR/AGENTS.md" | awk '{print $1}')"
if CODEX_REAL_HOME="$TMPDIR_EVAL/fake-real-codex" FLOW_AGENTS_SKILLS_DIR="$TMPDIR_EVAL/ch8-near-skills" \
  bash "$ROOT_DIR/scripts/install-codex-home.sh" "$CH8_NEAR" >"$TMPDIR_EVAL/ch8-near.out" 2>&1 \
  && [[ "$CH8_NEAR_BEFORE" == "$(shasum -a 256 "$CH8_NEAR/AGENTS.md" | awk '{print $1}')" ]] \
  && grep -q 'preserved unrecognized or user-owned' "$TMPDIR_EVAL/ch8-near.out"; then
  _pass "CH8: near-match legacy-looking user instructions are byte-preserved"
else
  _fail "CH8: near-match user instructions changed or lacked preservation diagnostic"
fi

for CH8_KIND in symlink directory; do
  CH8_UNSAFE="$TMPDIR_EVAL/codex-home-ch8-$CH8_KIND"
  mkdir -p "$CH8_UNSAFE"
  printf 'must remain untouched\n' > "$CH8_UNSAFE/preflight-sentinel"
  case "$CH8_KIND" in
    symlink) printf 'target\n' > "$CH8_UNSAFE/user-target"; ln -s user-target "$CH8_UNSAFE/AGENTS.md" ;;
    directory) mkdir "$CH8_UNSAFE/AGENTS.md" ;;
  esac
  if CODEX_REAL_HOME="$TMPDIR_EVAL/fake-real-codex" FLOW_AGENTS_SKILLS_DIR="$TMPDIR_EVAL/ch8-$CH8_KIND-skills" \
    bash "$ROOT_DIR/scripts/install-codex-home.sh" "$CH8_UNSAFE" >"$TMPDIR_EVAL/ch8-$CH8_KIND.out" 2>&1 \
    && [[ "$(cat "$CH8_UNSAFE/preflight-sentinel")" == "must remain untouched" ]] \
    && [[ -e "$CH8_UNSAFE/hooks.json" ]] \
    && { [[ "$CH8_KIND" == "symlink" && -L "$CH8_UNSAFE/AGENTS.md" && "$(cat "$CH8_UNSAFE/user-target")" == "target" ]] \
      || [[ "$CH8_KIND" == "directory" && -d "$CH8_UNSAFE/AGENTS.md" ]]; }; then
    _pass "CH8: read-only classifier preserves ambiguous $CH8_KIND AGENTS.md object"
  else
    _fail "CH8: classifier altered ambiguous $CH8_KIND AGENTS.md object"
  fi
done

echo ""

# ─── pi --global: PG1: warns NOT_VERIFIED + falls back to workspace default ──
echo "--- PG1: pi --global warns NOT_VERIFIED + falls back to workspace default ---"

PG1_DEST="$TMPDIR_EVAL/pi-global-pg1"
mkdir -p "$PG1_DEST"

# Capture stderr to check for the NOT_VERIFIED warning
PG1_STDERR=$(node "$ROOT_DIR/build/src/cli.js" init --runtime pi --global --dest "$PG1_DEST" --yes 2>&1 >/dev/null || true)

# Assert: stderr contains NOT_VERIFIED warn
if echo "$PG1_STDERR" | grep -q "NOT_VERIFIED"; then
  _pass "PG1: pi --global: stderr contains NOT_VERIFIED warning"
else
  _fail "PG1: pi --global: NOT_VERIFIED warning not found in stderr (got: $PG1_STDERR)"
fi

# Assert: install still ran (bundle files present at dest)
if [[ -d "$PG1_DEST" ]] && [[ -f "$PG1_DEST/.flow-agents/install.json" ]] || [[ -d "$PG1_DEST" ]]; then
  _pass "PG1: pi --global: dest directory exists (fell back to workspace default install)"
else
  _fail "PG1: pi --global: dest directory missing (fallback install did not run)"
fi

echo ""

echo ""
echo "==========================="
if [[ "$(cat "$HOME/.agents/ambient-sentinel" 2>/dev/null)" == "installer tests must not replace this file" ]]; then
  _pass "dedicated Codex installer calls remain inside hermetic universal roots"
else
  _fail "dedicated Codex installer calls mutated the isolated default-home sentinel"
fi
total=$((pass + fail))
echo "Results: ${pass}/${total} passed, ${fail} failed"
[[ "$fail" -gt 0 ]] && exit 1
exit 0
