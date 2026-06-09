#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
pass=0
fail=0

_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }

echo "=== Layer 1B: Universal Bundle Validation ==="
echo ""

echo "--- Source Tree ---"
if (cd "$ROOT_DIR" && npm run validate:source >/tmp/source-tree-validation.txt 2>&1); then
  _pass "source tree validation passed"
else
  _fail "source tree validation failed (see /tmp/source-tree-validation.txt)"
fi

if (cd "$ROOT_DIR" && npm run typecheck >/tmp/source-tree-typecheck.txt 2>&1); then
  _pass "source tree validator typechecks"
else
  _fail "source tree validator does not typecheck"
fi

echo ""
echo "--- Build ---"
if (cd "$ROOT_DIR" && npm run build:bundles >/dev/null); then
  _pass "bundle build completed"
else
  _fail "bundle build failed"
fi

if (cd "$ROOT_DIR" && npm run typecheck >/tmp/bundle-builder-typecheck.txt 2>&1); then
  _pass "bundle builder typechecks"
else
  _fail "bundle builder does not typecheck"
fi

echo ""
echo "--- Bundle Layout ---"
for dir in "$DIST_DIR/kiro" "$DIST_DIR/claude-code" "$DIST_DIR/codex"; do
  if [[ -d "$dir" ]]; then
    _pass "$(basename "$dir") bundle exists"
  else
    _fail "$(basename "$dir") bundle missing"
  fi
done

source_agents=$(find "$ROOT_DIR/agents" -maxdepth 1 -name '*.json' | wc -l | tr -d ' ')
codex_excluded_agents=$(node - "$ROOT_DIR/packaging/manifest.json" <<'NODE'
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
console.log((data.codex?.excluded_agents || []).length);
NODE
)
expected_codex_agents=$((source_agents - codex_excluded_agents))
kiro_agents=$(find "$DIST_DIR/kiro/agents" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
claude_agents=$(find "$DIST_DIR/claude-code/.claude/agents" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
codex_agents=$(find "$DIST_DIR/codex/.codex/agents" -maxdepth 1 -name '*.toml' 2>/dev/null | wc -l | tr -d ' ')

[[ "$kiro_agents" == "$source_agents" ]] && _pass "Kiro agent count matches source ($kiro_agents)" || _fail "Kiro agent count mismatch: source=$source_agents dist=$kiro_agents"
[[ "$claude_agents" == "$source_agents" ]] && _pass "Claude agent count matches source ($claude_agents)" || _fail "Claude agent count mismatch: source=$source_agents dist=$claude_agents"
[[ "$codex_agents" == "$expected_codex_agents" ]] && _pass "Codex agent count matches source minus manifest exclusions ($codex_agents)" || _fail "Codex agent count mismatch: expected=$expected_codex_agents dist=$codex_agents"

echo ""
echo "--- Kiro JSON ---"
if node - "$DIST_DIR/kiro/agents" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
for (const name of fs.readdirSync(process.argv[2]).filter((file) => file.endsWith(".json"))) {
  const data = JSON.parse(fs.readFileSync(path.join(process.argv[2], name), "utf8"));
  for (const key of ["name", "description", "prompt", "model"]) {
    if (!(key in data)) throw new Error(`${name}: missing ${key}`);
  }
}
console.log("ok");
NODE
then
  _pass "Kiro agent JSON parses with required fields"
else
  _fail "Kiro agent JSON parse/shape check failed"
fi

echo ""
echo "--- Claude Export Shape ---"
if node - "$DIST_DIR/claude-code/.claude/agents" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const required = new Set(["name", "description", "tools", "model"]);
for (const name of fs.readdirSync(process.argv[2]).filter((file) => file.endsWith(".md"))) {
  const text = fs.readFileSync(path.join(process.argv[2], name), "utf8");
  if (!text.startsWith("---\n")) throw new Error(`${name}: missing frontmatter start`);
  const parts = text.split("\n---\n");
  if (parts.length < 2) throw new Error(`${name}: missing frontmatter end`);
  const keys = new Set(parts[0].replace("---\n", "").split(/\r?\n/).filter((line) => line.includes(":")).map((line) => line.split(":", 1)[0].trim()));
  const missing = [...required].filter((key) => !keys.has(key));
  if (missing.length) throw new Error(`${name}: missing frontmatter keys ${missing.join(", ")}`);
  if (!parts.slice(1).join("\n---\n").trim()) throw new Error(`${name}: empty body`);
}
console.log("ok");
NODE
then
  _pass "Claude agent markdown has valid frontmatter/body shape"
else
  _fail "Claude agent markdown shape check failed"
fi

if node - "$DIST_DIR/claude-code/.claude/settings.json" <<'NODE'
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const statusLine = data.statusLine || {};
if (statusLine.type !== "command" || !String(statusLine.command || "").includes("flow-agents-statusline.js")) throw new Error("Claude statusLine command missing Flow Agents statusline");
if (data.permissions?.defaultMode !== "auto") throw new Error("Claude permissions.defaultMode should default to auto");
if (data.skipDangerousModePermissionPrompt !== true) throw new Error("Claude dangerous-mode prompt skip fallback should be enabled");
const hooks = data.hooks || {};
const required = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop", "SessionEnd"];
const missing = required.filter((event) => !(event in hooks));
if (missing.length) throw new Error(`missing Claude hook events: ${missing.join(", ")}`);
for (const event of required) {
  if (!(hooks[event] || []).some((group) => (group.hooks || []).some((hook) => String(hook.command || "").includes("claude-telemetry-hook.js")))) throw new Error(`${event} telemetry hook missing`);
}
if (!(hooks.Stop || []).some((group) => (group.hooks || []).some((hook) => String(hook.command || "").includes("claude-hook-adapter.js") && String(hook.command || "").includes("stop-goal-fit.js")))) throw new Error("Stop goal-fit policy hook missing");
if (!(hooks.UserPromptSubmit || []).some((group) => [undefined, null, "*"].includes(group.matcher) && (group.hooks || []).some((hook) => String(hook.command || "").includes("claude-hook-adapter.js") && String(hook.command || "").includes("workflow-steering.js")))) throw new Error("prompt-submit workflow-steering policy hook missing");
console.log("ok");
NODE
then
  _pass "Claude settings include auto permissions, dangerous prompt fallback, statusLine, telemetry, and policy hooks"
else
  _fail "Claude settings auto permissions, dangerous prompt fallback, statusLine, or telemetry/policy hooks missing"
fi

echo ""
echo "--- Codex Export Shape ---"
if node - "$DIST_DIR/codex/.codex/config.toml" <<'NODE'
const fs = require("node:fs");
const text = fs.readFileSync(process.argv[2], "utf8");
if (text.includes("codex_hooks")) throw new Error("deprecated codex_hooks feature flag exported");
if (!text.includes("hooks = true")) throw new Error("current hooks feature flag missing");
if (!text.includes('approvals_reviewer = "auto_review"')) throw new Error("top-level auto-review approval reviewer missing");
if (!text.includes("[tui]") || !text.includes('status_line = ["model-with-reasoning", "project-name", "git-branch", "task-progress", "context-remaining", "run-state"]')) throw new Error("Codex TUI status_line missing workflow progress items");
if (text.includes("[profiles.") || text.includes("\nprofile = ")) throw new Error("Codex base config contains legacy profile config");
console.log("ok");
NODE
then
  _pass "Codex config uses profile-v2 base shape, current hooks feature flag, auto-review reviewer, and status line"
else
  _fail "Codex config profile-v2 shape, hook feature flag, auto-review reviewer, or status line is stale"
fi

if node - "$DIST_DIR/codex/.codex" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
const expected = ["kdev", "kdev-br"];
const missingFiles = expected.filter((name) => !fs.existsSync(path.join(root, `${name}.config.toml`)));
if (missingFiles.length) throw new Error(`profile-v2 config files missing: ${missingFiles.join(", ")}`);
const missing = expected.filter((name) => !fs.readFileSync(path.join(root, `${name}.config.toml`), "utf8").includes('approvals_reviewer = "auto_review"'));
if (missing.length) throw new Error(`profile auto-review approval reviewer missing: ${missing.join(", ")}`);
console.log("ok");
NODE
then
  _pass "Codex profile-v2 files select auto-review reviewer"
else
  _fail "Codex profile-v2 auto-review reviewer check failed"
fi

if node - "$DIST_DIR/codex/.codex/agents" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
const required = ['name = "', 'description = "', 'model = "', 'model_reasoning_effort = "', 'developer_instructions = '];
for (const name of fs.readdirSync(root).filter((file) => file.endsWith(".toml"))) {
  const text = fs.readFileSync(path.join(root, name), "utf8");
  for (const needle of required) if (!text.includes(needle)) throw new Error(`${name}: missing ${needle}`);
}
console.log("ok");
NODE
then
  _pass "Codex agent TOML has required fields"
else
  _fail "Codex agent TOML required-field check failed"
fi

if node - "$DIST_DIR/codex/.codex/hooks.json" <<'NODE'
const fs = require("node:fs");
const hooks = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).hooks || {};
const required = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop"];
const missing = required.filter((event) => !(event in hooks));
if (missing.length) throw new Error(`missing Codex hook events: ${missing.join(", ")}`);
if (!(hooks.PermissionRequest || []).some((group) => (group.hooks || []).some((hook) => String(hook.command || "").includes("telemetry.sh")))) throw new Error("PermissionRequest telemetry hook missing");
if (!(hooks.Stop || []).some((group) => (group.hooks || []).some((hook) => String(hook.command || "").includes("codex-hook-adapter.js") && String(hook.command || "").includes("stop-goal-fit.js")))) throw new Error("Stop goal-fit policy hook missing");
if (!(hooks.UserPromptSubmit || []).some((group) => [undefined, null, "*"].includes(group.matcher) && (group.hooks || []).some((hook) => String(hook.command || "").includes("codex-hook-adapter.js") && String(hook.command || "").includes("workflow-steering.js")))) throw new Error("prompt-submit workflow-steering policy hook missing");
for (const groups of Object.values(hooks)) {
  for (const group of groups || []) {
    for (const hook of group.hooks || []) {
      const command = String(hook.command || "");
      if (!command.includes('root="${CODEX_HOME:-}"')) throw new Error(`Codex hook does not prefer CODEX_HOME: ${command}`);
      if (command.includes("'root=$(git rev-parse --show-toplevel")) throw new Error(`Codex hook uses stale repo-root-only resolver: ${command}`);
    }
  }
}
console.log("ok");
NODE
then
  _pass "Codex hooks cover telemetry and policy lifecycle events with CODEX_HOME root resolution"
else
  _fail "Codex hooks missing telemetry/policy lifecycle coverage or CODEX_HOME root resolution"
fi

echo ""
echo "--- Shared Task Dirs ---"
for dir in "$DIST_DIR/claude-code/.flow-agents" "$DIST_DIR/codex/.flow-agents"; do
  if [[ -d "$dir" ]]; then
    _pass "$(realpath "$dir" 2>/dev/null || echo "$dir") exists"
  else
    _fail "$dir missing"
  fi
done

echo ""
echo "--- Portability Leaks ---"
if rg -n '/Users/[^/]+/\.flow-agents|~/\.flow-agents' "$DIST_DIR" --glob '!**/evals/**' >/tmp/universal-bundle-leaks.txt 2>/dev/null; then
  _fail "machine-local absolute paths leaked into dist (see /tmp/universal-bundle-leaks.txt)"
else
  _pass "no machine-local absolute paths leaked into dist"
fi

if rg -n '\.kiro/cli_todos/|\.ai/cli_todos/' "$DIST_DIR/claude-code" "$DIST_DIR/codex" --glob '!**/evals/**' >/tmp/universal-bundle-taskdir-leaks.txt 2>/dev/null; then
  _fail "non-Kiro bundles still reference legacy task dirs (see /tmp/universal-bundle-taskdir-leaks.txt)"
else
  _pass "non-Kiro bundles use Flow Agents task dir paths"
fi

echo ""
echo "--- Catalog ---"
if node - "$DIST_DIR/catalog.json" "$source_agents" <<'NODE'
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const expectedAgents = Number(process.argv[3]);
if (data.source_root !== ".") throw new Error("catalog source_root should be '.'");
if ((data.agents || []).length !== expectedAgents) throw new Error("catalog agent count mismatch");
console.log("ok");
NODE
then
  _pass "catalog metadata is sane"
else
  _fail "catalog metadata check failed"
fi

echo ""
echo "==========================="
total=$((pass + fail))
echo "Results: ${pass}/${total} passed, ${fail} failed"
[[ "$fail" -gt 0 ]] && exit 1
exit 0
