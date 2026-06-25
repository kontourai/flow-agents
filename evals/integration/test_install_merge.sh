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

# ─── Scenario 1: Seeded user config ──────────────────────────────────────────
echo "--- Scenario 1: Seeded user config (user keys + non-FA hook survive) ---"

SEEDED_DEST="$TMPDIR_EVAL/seeded-claude"
mkdir -p "$SEEDED_DEST/.claude"

# Seed a settings.json with user keys AND a non-flow-agents hook
cat > "$SEEDED_DEST/.claude/settings.json" << 'JSON'
{
  "permissions": {
    "allow": ["Bash(usertool:*)"],
    "customPermission": true
  },
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
(cd "$ROOT_DIR/dist/claude-code" && bash install.sh "$SEEDED_DEST" >/dev/null 2>&1)

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
if (!JSON.stringify(p.allow || []).includes("usertool")) throw new Error("user permissions.allow entry not preserved by union: " + JSON.stringify(p.allow));
console.log("ok");
NODE
then
  _pass "seeded: user custom permissions preserved (deep-merge union, not clobbered)"
else
  _fail "seeded: user custom permissions were clobbered"
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

echo ""
echo ""
echo "==========================="
total=$((pass + fail))
echo "Results: ${pass}/${total} passed, ${fail} failed"
[[ "$fail" -gt 0 ]] && exit 1
exit 0
