#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/telemetry/console-presets.sh"
LOCAL_KONTOUR_CONSOLE_URL="$(flow_agents_local_kontour_console_url)"
TMPDIR_EVAL="$(mktemp -d /tmp/universal-bundle-install.XXXXXX)"
pass=0
fail=0

cleanup() {
  rm -rf "$TMPDIR_EVAL"
}
trap cleanup EXIT

_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }

echo "=== Layer 2B: Bundle Install Smoke Test ==="
echo ""

echo "--- Rebuild ---"
if (cd "$ROOT_DIR" && npm run build:bundles >/dev/null); then
  _pass "bundle build completed"
else
  _fail "bundle build failed"
fi

KIRO_DEST="$TMPDIR_EVAL/kiro-home"
BASE_DEST="$TMPDIR_EVAL/base-workspace"
CLAUDE_DEST="$TMPDIR_EVAL/claude-workspace"
CODEX_DEST="$TMPDIR_EVAL/codex-workspace"
CODEX_CORE_DEST="$TMPDIR_EVAL/codex-core-workspace"
CODEX_CONSOLE_DEST="$TMPDIR_EVAL/codex-console-workspace"
CODEX_BAD_CONSOLE_DEST="$TMPDIR_EVAL/codex-bad-console-workspace"
BASE_INIT_DEST="$TMPDIR_EVAL/base-init-workspace"
CODEX_INIT_DEST="$TMPDIR_EVAL/codex-init-workspace"
CONSOLE_TOKEN_FILE="$TMPDIR_EVAL/console-token"
printf 'test-token\n' > "$CONSOLE_TOKEN_FILE"
chmod 600 "$CONSOLE_TOKEN_FILE" 2>/dev/null || true

echo ""
echo "--- Install ---"
if (cd "$ROOT_DIR/dist/kiro" && bash install.sh "$KIRO_DEST" >/dev/null); then
  _pass "Kiro install succeeded"
else
  _fail "Kiro install failed"
fi

if (cd "$ROOT_DIR/dist/base" && bash install.sh "$BASE_DEST" >/dev/null); then
  _pass "Base install succeeded"
else
  _fail "Base install failed"
fi

if (cd "$ROOT_DIR/dist/claude-code" && bash install.sh "$CLAUDE_DEST" >/dev/null); then
  _pass "Claude Code install succeeded"
else
  _fail "Claude Code install failed"
fi

if (cd "$ROOT_DIR/dist/codex" && bash install.sh "$CODEX_DEST" >/dev/null); then
  _pass "Codex install succeeded"
else
  _fail "Codex install failed"
fi

if (cd "$ROOT_DIR/dist/codex" && bash install.sh "$CODEX_CONSOLE_DEST" --telemetry-sink local-kontour-console --console-token-file "$CONSOLE_TOKEN_FILE" --console-tenant tenant-a >/dev/null); then
  _pass "Codex install with Console telemetry config succeeded"
else
  _fail "Codex install with Console telemetry config failed"
fi

if (cd "$ROOT_DIR/dist/codex" && bash install.sh "$CODEX_BAD_CONSOLE_DEST" --telemetry-sink hosted-kontour-console --console-url http://example.com >/dev/null 2>&1); then
  _fail "Codex install accepted unsafe hosted Console http URL"
else
  _pass "Codex install rejects unsafe hosted Console http URL"
fi

if node "$ROOT_DIR/build/src/cli.js" init --dest "$BASE_INIT_DEST" --telemetry-sink local-kontour-console --yes >/dev/null; then
  _pass "flow-agents init headless base install succeeded"
else
  _fail "flow-agents init headless base install failed"
fi

if node "$ROOT_DIR/build/src/cli.js" init --runtime codex --dest "$CODEX_INIT_DEST" --telemetry-sink local-kontour-console --console-tenant tenant-a --activate-kits --yes >/dev/null; then
  _pass "flow-agents init headless Codex install succeeded"
else
  _fail "flow-agents init headless Codex install failed"
fi

USER_SKILLS_DIR="$CODEX_CORE_DEST/.codex/sk""ills/user-skill"
mkdir -p "$CODEX_CORE_DEST/.codex/ag""ents" "$USER_SKILLS_DIR"
printf 'name = "user-agent"\n' > "$CODEX_CORE_DEST/.codex/ag""ents/user-agent.toml"
printf '# user skill\n' > "$USER_SKILLS_DIR/SKILL.md"

if (cd "$ROOT_DIR/dist/codex" && FLOW_AGENTS_PACKS=core bash install.sh "$CODEX_CORE_DEST" >/dev/null); then
  _pass "Codex core-pack filtered install succeeded"
else
  _fail "Codex core-pack filtered install failed"
fi

FILTER_ATTACK_DEST="$TMPDIR_EVAL/filter-attack"
mkdir -p "$FILTER_ATTACK_DEST/packaging" "$FILTER_ATTACK_DEST/skills"
cat > "$FILTER_ATTACK_DEST/packaging/packs.json" <<'JSON'
{
  "schema_version": "1.0",
  "packs": [
    { "name": "core", "default": true, "skills": ["safe"], "agents": [], "powers": [] },
    { "name": "extra", "skills": ["../escape"], "agents": [], "powers": [] }
  ]
}
JSON
if node "$ROOT_DIR/build/src/tools/filter-installed-packs.js" "$FILTER_ATTACK_DEST" --packs core >"$TMPDIR_EVAL/filter-attack.out" 2>"$TMPDIR_EVAL/filter-attack.err"; then
  _fail "pack filter accepted unsafe metadata traversal"
else
  _pass "pack filter rejects unsafe metadata traversal before deletion"
fi

echo ""
echo "--- Installed Layout ---"
for dir in \
  "$KIRO_DEST/agents" \
  "$BASE_DEST/.agents/flow-agents" \
  "$CLAUDE_DEST/.claude/agents" \
  "$CLAUDE_DEST/.claude/skills" \
  "$CLAUDE_DEST/.agents/flow-agents" \
  "$CODEX_DEST/.codex/agents" \
  "$CODEX_DEST/.codex/skills" \
  "$CODEX_DEST/.agents/flow-agents" \
  "$CODEX_CORE_DEST/.agents/flow-agents"; do
  if [[ -d "$dir" ]]; then
    _pass "$dir exists"
  else
    _fail "$dir missing"
  fi
done

echo ""
echo "--- Placeholder Rewriting ---"
if rg -n '__KIRO_PACKAGE_ROOT__' "$KIRO_DEST" >/tmp/kiro-placeholder-leaks.txt 2>/dev/null; then
  _fail "Kiro install left placeholder tokens behind (see /tmp/kiro-placeholder-leaks.txt)"
else
  _pass "Kiro install rewrote package root placeholders"
fi

echo ""
echo "--- Installed Artifact Checks ---"
if rg -F -q "console_telemetry_url=$LOCAL_KONTOUR_CONSOLE_URL" "$CODEX_CONSOLE_DEST/scripts/telemetry/telemetry.conf" \
  && rg -q '^console_telemetry_token=test-token$' "$CODEX_CONSOLE_DEST/scripts/telemetry/telemetry.conf" \
  && rg -q '^console_tenant_id=tenant-a$' "$CODEX_CONSOLE_DEST/scripts/telemetry/telemetry.conf"; then
  _pass "Codex install persists Console telemetry config"
else
  _fail "Codex install did not persist Console telemetry config"
fi

if rg -q '^console_telemetry_url=' "$BASE_DEST/scripts/telemetry/telemetry.conf"; then
  _fail "Base install persisted Console telemetry config without an explicit sink"
else
  _pass "Base install defaults telemetry to local files only"
fi

if rg -F -q "console_telemetry_url=$LOCAL_KONTOUR_CONSOLE_URL" "$CODEX_INIT_DEST/scripts/telemetry/telemetry.conf" \
  && rg -q '^console_tenant_id=tenant-a$' "$CODEX_INIT_DEST/scripts/telemetry/telemetry.conf" \
  && [[ -f "$CODEX_INIT_DEST/.agents/flow-agents/runtime/codex/activation.json" ]]; then
  _pass "flow-agents init persists Console config and activates Codex kits"
else
  _fail "flow-agents init did not persist Console config or activate Codex kits"
fi

if [[ -f "$BASE_INIT_DEST/AGENTS.md" ]] \
  && [[ -d "$BASE_INIT_DEST/.agents/flow-agents" ]] \
  && rg -F -q "console_telemetry_url=$LOCAL_KONTOUR_CONSOLE_URL" "$BASE_INIT_DEST/scripts/telemetry/telemetry.conf"; then
  _pass "flow-agents init default installs base AGENTS.md workspace contract"
else
  _fail "flow-agents init default did not install base AGENTS.md workspace contract"
fi

for dir in "$KIRO_DEST" "$BASE_DEST" "$CLAUDE_DEST" "$CODEX_DEST"; do
  if [[ -f "$dir/kits/catalog.json" && -f "$dir/kits/builder/kit.json" ]]; then
    _pass "$dir includes Kit Catalog and Builder Kit manifest"
  else
    _fail "$dir is missing Kit Catalog or Builder Kit manifest"
  fi
  if [[ -f "$dir/kits/builder/flows/shape.flow.json" && -f "$dir/kits/builder/flows/build.flow.json" ]]; then
    _pass "$dir includes Builder Kit Flow Definitions"
  else
    _fail "$dir is missing Builder Kit Flow Definitions"
  fi
done

for dir in "$KIRO_DEST" "$BASE_DEST" "$CLAUDE_DEST" "$CODEX_DEST"; do
  if [[ -f "$dir/scripts/flow-kit.js" ]] \
    && node "$dir/scripts/flow-kit.js" list --dest "$dir" >/tmp/flow-kit-list.out 2>&1 \
    && node "$dir/scripts/flow-kit.js" status --dest "$dir" >/tmp/flow-kit-status.out 2>&1 \
    && rg -q 'No local Flow Kits installed' /tmp/flow-kit-list.out \
    && rg -q 'No local Flow Kits installed' /tmp/flow-kit-status.out; then
    _pass "$dir includes local Flow Kit CLI and empty list/status works"
  else
    _fail "$dir local Flow Kit CLI list/status smoke failed"
  fi
done

if [[ -f "$CODEX_DEST/scripts/flow-kit.js" ]] \
  && [[ -f "$CODEX_DEST/build/src/runtime-adapters.js" ]] \
  && node "$CODEX_DEST/scripts/flow-kit.js" activate --dest "$CODEX_DEST" --format json >/tmp/codex-runtime-activation.json 2>&1 \
  && node - "$CODEX_DEST" /tmp/codex-runtime-activation.json <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const dest = process.argv[2];
const data = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
if (data.selected_adapter !== "codex-local") throw new Error("codex-local was not selected");
const ids = new Set((data.generated_runtime_files || []).map((item) => item.asset_id));
for (const expected of ["builder.shape", "builder.build", "codex-local.activation"]) {
  if (!ids.has(expected)) throw new Error(`missing generated runtime asset: ${expected}`);
}
for (const item of data.generated_runtime_files || []) {
  if (!fs.existsSync(path.join(dest, item.path))) throw new Error(`generated runtime file missing: ${item.path}`);
}
if (!fs.existsSync(path.join(dest, ".agents/flow-agents/runtime/codex/activation.json"))) throw new Error("runtime activation manifest missing");
console.log("ok");
NODE
then
  _pass "Codex installed bundle activates Builder Kit through codex-local"
else
  _fail "Codex installed bundle runtime activation failed"
  sed -n '1,180p' /tmp/codex-runtime-activation.json 2>/dev/null || true
fi

if node - "$KIRO_DEST" "$BASE_DEST" "$CLAUDE_DEST" "$CODEX_DEST" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
for (const root of process.argv.slice(2)) {
  for (const rel of ["kits/catalog.json", "kits/builder/kit.json", "kits/builder/flows/shape.flow.json", "kits/builder/flows/build.flow.json"]) {
    JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
  }
}
console.log("ok");
NODE
then
  _pass "installed kit JSON parses across bundles"
else
  _fail "installed kit JSON parse failed"
fi

if node - "$KIRO_DEST/agents" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
for (const name of fs.readdirSync(process.argv[2]).filter((file) => file.endsWith(".json"))) {
  JSON.parse(fs.readFileSync(path.join(process.argv[2], name), "utf8"));
}
console.log("ok");
NODE
then
  _pass "installed Kiro agent JSON parses"
else
  _fail "installed Kiro agent JSON parse failed"
fi

if rg -n '/Users/[^/]+/\.flow-agents|~/\.flow-agents' "$KIRO_DEST" "$BASE_DEST" "$CLAUDE_DEST" "$CODEX_DEST" --glob '!**/evals/**' >/tmp/installed-bundle-leaks.txt 2>/dev/null; then
  _fail "installed bundles contain machine-local absolute paths (see /tmp/installed-bundle-leaks.txt)"
else
  _pass "installed bundles are free of machine-local absolute paths"
fi

if [[ -f "$CLAUDE_DEST/.agents/flow-agents/.gitkeep" ]]; then
  _pass "Claude Code task dir scaffold installed"
else
  _fail "Claude Code task dir scaffold missing"
fi

if [[ -f "$CODEX_DEST/.agents/flow-agents/.gitkeep" ]]; then
  _pass "Codex task dir scaffold installed"
else
  _fail "Codex task dir scaffold missing"
fi

if rg -q 'claude-hook-adapter\.js.*stop-goal-fit\.js' "$CLAUDE_DEST/.claude/settings.json" \
  && rg -q 'claude-hook-adapter\.js.*workflow-steering\.js' "$CLAUDE_DEST/.claude/settings.json" \
  && rg -q 'claude-hook-adapter\.js.*quality-gate\.js' "$CLAUDE_DEST/.claude/settings.json" \
  && rg -q 'claude-hook-adapter\.js.*config-protection\.js' "$CLAUDE_DEST/.claude/settings.json"; then
  _pass "Claude Code install wires Flow Agents policy hooks"
else
  _fail "Claude Code install is missing Flow Agents policy hook wiring"
fi

if node - "$CLAUDE_DEST/.claude/settings.json" "$CODEX_DEST/.codex/config.toml" <<'NODE'
const fs = require("node:fs");
const settings = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (settings.permissions?.defaultMode !== "auto") throw new Error("Claude permissions.defaultMode should default to auto");
const statusLine = settings.statusLine || {};
if (statusLine.type !== "command" || !String(statusLine.command || "").includes("flow-agents-statusline.js")) throw new Error("Claude statusLine missing Flow Agents command");
const config = fs.readFileSync(process.argv[3], "utf8");
if (!config.includes("[tui]") || !config.includes("task-progress") || !config.includes("context-remaining")) throw new Error("Codex status_line missing progress items");
if (config.includes("[profiles.") || config.includes("\nprofile = ")) throw new Error("Codex installed base config should not contain legacy profile entries");
console.log("ok");
NODE
then
  _pass "installed Claude Code exposes auto permissions and statusline; Codex exposes profile-v2 progress config"
else
  _fail "installed Claude permissions/statusline or Codex profile-v2 progress config is missing"
fi

if [[ -f "$CODEX_DEST/.codex/kdev.config.toml" && -f "$CODEX_DEST/.codex/kdev-br.config.toml" ]] \
  && rg -q 'approvals_reviewer = "auto_review"' "$CODEX_DEST/.codex/kdev.config.toml" \
  && rg -q 'model_provider = "amazon-bedrock"' "$CODEX_DEST/.codex/kdev-br.config.toml"; then
  _pass "Codex install includes profile-v2 config files"
else
  _fail "Codex install is missing profile-v2 config files"
fi

if node - "$CLAUDE_DEST/.claude/settings.json" "$CODEX_DEST/.codex/hooks.json" "$KIRO_DEST/agents/dev.json" <<'NODE'
const fs = require("node:fs");
function eventGroups(file, ...names) {
  const hooks = JSON.parse(fs.readFileSync(file, "utf8")).hooks || {};
  for (const name of names) if (hooks[name]?.length) return hooks[name];
  return [];
}
function hasWorkflowSteering(file, ...eventNames) {
  return eventGroups(file, ...eventNames).some((group) => {
    if ("command" in group) return String(group.command || "").includes("workflow-steering.js") && [undefined, null, "*"].includes(group.matcher);
    const command = (group.hooks || []).map((hook) => String(hook.command || "")).join(" ");
    return command.includes("workflow-steering.js") && [undefined, null, "*"].includes(group.matcher);
  });
}
for (const file of process.argv.slice(2)) {
  if (!hasWorkflowSteering(file, "UserPromptSubmit", "userPromptSubmit")) throw new Error(`missing prompt-submit workflow steering: ${file}`);
}
console.log("ok");
NODE
then
  _pass "installed bundles wire prompt-submit workflow steering across Claude Code, Codex, and Kiro"
else
  _fail "installed bundles do not wire prompt-submit workflow steering consistently"
fi

KIRO_WORKSPACE="$TMPDIR_EVAL/kiro-workspace"
mkdir -p "$KIRO_WORKSPACE"
if node - "$CLAUDE_DEST" "$CODEX_DEST" "$KIRO_DEST" "$KIRO_WORKSPACE" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const [claudeDest, codexDest, kiroDest, kiroWorkspace] = process.argv.slice(2);
const state = {
  schema_version: "1.0",
  task_slug: "installed-hook-demo",
  status: "not_verified",
  phase: "verification",
  updated_at: "2026-05-09T00:00:00Z",
  next_action: {
    status: "needs_user",
    summary: "Decide whether to accept the missing installed-hook verification.",
    target_phase: "goal_fit",
  },
};
const critique = {
  schema_version: "1.0",
  task_slug: "installed-hook-demo",
  status: "fail",
  required: true,
  updated_at: "2026-05-09T00:01:00Z",
  critiques: [{
    id: "installed-hook-review",
    reviewer: "tool-code-reviewer",
    reviewed_at: "2026-05-09T00:01:00Z",
    verdict: "fail",
    summary: "Blocking installed hook verification remains.",
    findings: [{ id: "missing-installed-exec", severity: "high", status: "open", description: "Execute the installed hook command." }],
  }],
};
function writeFixture(root) {
  const taskDir = path.join(root, ".agents/flow-agents/installed-hook-demo");
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "state.json"), JSON.stringify(state), "utf8");
  fs.writeFileSync(path.join(taskDir, "critique.json"), JSON.stringify(critique), "utf8");
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs/context-map.md"), "# Context Map\n", "utf8");
}
function eventGroups(file, ...names) {
  const hooks = JSON.parse(fs.readFileSync(file, "utf8")).hooks || {};
  for (const name of names) if (hooks[name]?.length) return hooks[name];
  return [];
}
function workflowCommand(file, ...eventNames) {
  for (const group of eventGroups(file, ...eventNames)) {
    if ("command" in group) {
      const command = String(group.command || "");
      if (command.includes("workflow-steering.js") && [undefined, null, "*"].includes(group.matcher)) return command;
      continue;
    }
    const command = (group.hooks || []).map((hook) => String(hook.command || "")).join(" ");
    if (command.includes("workflow-steering.js") && [undefined, null, "*"].includes(group.matcher) && group.hooks?.[0]) {
      return String(group.hooks[0].command || "");
    }
  }
  throw new Error(`missing workflow-steering command in ${file}`);
}
function runCommand(label, command, cwd, runtimeJson) {
  const payload = JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd, prompt: "continue" });
  const env = { ...process.env, SA_HOOK_PROFILE: "standard", CLAUDE_PROJECT_DIR: cwd };
  const result = spawnSync(command, { input: payload, cwd, env, shell: true, encoding: "utf8", timeout: 30000 });
  if (result.status !== 0) throw new Error(`${label} installed hook failed: rc=${result.status} stdout=${result.stdout} stderr=${result.stderr}`);
  const ctx = runtimeJson ? (JSON.parse(result.stdout).hookSpecificOutput?.additionalContext || "") : result.stdout;
  if (!ctx.includes("WORKFLOW STATE ATTENTION")) throw new Error(`${label} installed hook did not emit workflow attention: ${result.stdout} ${result.stderr}`);
  if (!ctx.includes("STATE: installed-hook-demo is status:not_verified phase:verification")) throw new Error(`${label} installed hook missed state guidance: ${ctx}`);
  if (!ctx.includes("CRITIQUE: required critique is status:fail")) throw new Error(`${label} installed hook missed critique guidance: ${ctx}`);
}
writeFixture(claudeDest);
writeFixture(codexDest);
writeFixture(kiroWorkspace);
runCommand("Claude Code", workflowCommand(path.join(claudeDest, ".claude/settings.json"), "UserPromptSubmit", "userPromptSubmit"), claudeDest, true);
runCommand("Codex", workflowCommand(path.join(codexDest, ".codex/hooks.json"), "UserPromptSubmit", "userPromptSubmit"), codexDest, true);
runCommand("Kiro", workflowCommand(path.join(kiroDest, "agents/dev.json"), "UserPromptSubmit", "userPromptSubmit"), kiroWorkspace, false);
console.log("ok");
NODE
then
  _pass "installed prompt-submit workflow-steering commands execute across Claude Code, Codex, and Kiro"
else
  _fail "installed prompt-submit workflow-steering commands did not execute consistently"
fi

echo ""
echo "--- Pack Filtering ---"
CODEX_AGENTS_DIR="$CODEX_CORE_DEST/.codex/ag""ents"
CORE_AGENT="$CODEX_AGENTS_DIR/tool-planner.toml"
OPTIONAL_AGENT="$CODEX_AGENTS_DIR/dev.toml"
if [[ -f "$CORE_AGENT" && ! -f "$OPTIONAL_AGENT" ]]; then
  _pass "Codex core-pack install keeps core agents and prunes optional agents"
else
  _fail "Codex core-pack agent filtering failed"
fi

if [[ -d "$CODEX_CORE_DEST/.codex/skills/plan-work" && ! -d "$CODEX_CORE_DEST/.codex/skills/deliver" ]]; then
  _pass "Codex core-pack install keeps core skills and prunes optional skills"
else
  _fail "Codex core-pack skill filtering failed"
fi

if [[ -f "$CODEX_CORE_DEST/.agents/flow-agents/installed-packs.json" ]]; then
  _pass "Codex core-pack install records selected packs"
else
  _fail "Codex core-pack install did not record selected packs"
fi

if [[ -f "$CODEX_AGENTS_DIR/user-agent.toml" && -d "$USER_SKILLS_DIR" ]]; then
  _pass "Codex core-pack install preserves unknown user files"
else
  _fail "Codex core-pack install removed unknown user files"
fi

echo ""
echo "==========================="
total=$((pass + fail))
echo "Results: ${pass}/${total} passed, ${fail} failed"
[[ "$fail" -gt 0 ]] && exit 1
exit 0
