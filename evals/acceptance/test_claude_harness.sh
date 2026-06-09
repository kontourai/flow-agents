#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/evals/lib/node.sh"
TMP_WORK=""
pass=0
fail=0
skip=0

cleanup() {
  [[ -n "$TMP_WORK" ]] && rm -rf "$TMP_WORK"
}
trap cleanup EXIT

_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }
_skip() { echo "  ○ $1"; skip=$((skip + 1)); }

wait_for_telemetry() {
  local file="$1"
  local i=0
  while [[ $i -lt 50 ]]; do
    [[ -s "$file" ]] && return 0
    sleep 0.1
    i=$((i + 1))
  done
  return 1
}

echo "=== Harness Acceptance: Claude Code ==="
echo ""
echo "Set FLOW_AGENTS_ACCEPTANCE_CLAUDE_LLM=1 to run prompt-mode Claude checks."
echo "Set FLOW_AGENTS_ACCEPTANCE_REQUIRE_CLAUDE_TELEMETRY=1 to require real Claude CLI hook telemetry."
echo ""

if ! command -v claude >/dev/null 2>&1; then
  _skip "claude CLI not installed"
  echo ""
  echo "Results: ${pass}/$((pass + fail)) passed, ${fail} failed, ${skip} skipped"
  exit 0
fi

cd "$ROOT_DIR"
flow_agents_node scripts/build-universal-bundles.js >/dev/null

TMP_WORK="$(mktemp -d /tmp/claude-acceptance-work.XXXXXX)"
bash dist/claude-code/install.sh "$TMP_WORK" >/dev/null

echo "--- Agent List ---"
list_output="$(cd "$TMP_WORK" && claude agents --setting-sources local,project,user 2>&1 || true)"
if echo "$list_output" | grep -q "Project agents:"; then
  _pass "claude lists project agents"
else
  _fail "claude did not list project agents"
fi

if echo "$list_output" | grep -q "dev ·"; then
  _pass "claude project agent list includes dev"
else
  _fail "claude project agent list did not include dev"
fi

if [[ -f "$TMP_WORK/.claude/settings.json" ]] && grep -q "claude-telemetry-hook.js" "$TMP_WORK/.claude/settings.json"; then
  _pass "claude project settings include telemetry hooks"
else
  _fail "claude project settings missing telemetry hooks"
fi

if [[ "${FLOW_AGENTS_ACCEPTANCE_CLAUDE_LLM:-0}" != "1" ]]; then
  _skip "Claude prompt-mode checks skipped to avoid model usage"
  echo ""
  echo "==========================="
  total=$((pass + fail))
  echo "Results: ${pass}/${total} passed, ${fail} failed, ${skip} skipped"
  [[ "$fail" -gt 0 ]] && exit 1
  exit 0
fi

echo ""
echo "--- Print Smoke ---"
print_output="$(cd "$TMP_WORK" && claude -p --agent dev --permission-mode bypassPermissions --add-dir "$TMP_WORK" --output-format text "Reply with READY only." 2>&1 || true)"
if echo "$print_output" | grep -qx "READY"; then
  _pass "dev agent replied READY in print mode"
else
  _fail "dev agent did not return plain READY in print mode"
fi

echo ""
echo "--- Behavioral Route ---"
route_output="$(cd "$TMP_WORK" && node - <<'NODE'
const { spawnSync } = require("node:child_process");
const result = spawnSync("claude", [
  "-p",
  "--agent",
  "dev",
  "--permission-mode",
  "bypassPermissions",
  "--add-dir",
  ".",
  "--output-format",
  "text",
  "A user asks: 'Explore the codebase and explain what it does.' Which skill should you activate first? Reply with only the skill name or NONE.",
], { encoding: "utf8", timeout: 30000 });
process.stdout.write(result.stdout || "");
process.stdout.write(result.stderr || "");
NODE
)"
route_output_trimmed="$(printf '%s' "$route_output" | tr -d '\r' | tail -n 1 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
if [[ "$route_output_trimmed" == "explore" ]]; then
  _pass "claude dev selects explore for repository exploration"
else
  _fail "claude dev did not select explore (got: $route_output_trimmed)"
fi

echo ""
echo "--- deliver Route ---"
sa_build_output="$(cd "$TMP_WORK" && node - <<'NODE'
const { spawnSync } = require("node:child_process");
const result = spawnSync("claude", [
  "-p",
  "--agent",
  "dev",
  "--permission-mode",
  "bypassPermissions",
  "--add-dir",
  ".",
  "--output-format",
  "text",
  "A user asks: 'Build a CLI tool that converts markdown files to HTML'. Which skill should you activate first? Reply with only the skill name or NONE.",
], { encoding: "utf8", timeout: 30000 });
process.stdout.write(result.stdout || "");
process.stdout.write(result.stderr || "");
NODE
)"
sa_build_trimmed="$(printf '%s' "$sa_build_output" | tr -d '\r' | tail -n 1 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
if [[ "$sa_build_trimmed" == "deliver" ]]; then
  _pass "claude dev selects deliver for broad build requests"
else
  _fail "claude dev did not select deliver (got: $sa_build_trimmed)"
fi

echo ""
echo "--- Live Hook Influence ---"
mkdir -p "$TMP_WORK/.flow-agents/live-hook" "$TMP_WORK/docs"
printf '# Context Map\n' > "$TMP_WORK/docs/context-map.md"
cat > "$TMP_WORK/.flow-agents/live-hook/state.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "live-hook",
  "status": "not_verified",
  "phase": "verification",
  "updated_at": "2026-05-10T00:00:00Z",
  "next_action": {
    "status": "needs_user",
    "summary": "Acknowledge live hook guidance.",
    "target_phase": "verification"
  }
}
JSON
cat > "$TMP_WORK/.flow-agents/live-hook/critique.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "live-hook",
  "status": "fail",
  "required": true,
  "updated_at": "2026-05-10T00:01:00Z",
  "critiques": [
    {
      "id": "live-hook-review",
      "reviewer": "tool-code-reviewer",
      "reviewed_at": "2026-05-10T00:01:00Z",
      "verdict": "fail",
      "summary": "Live hook guidance must be acknowledged.",
      "findings": [
        {
          "id": "open-live-hook",
          "severity": "high",
          "status": "open",
          "description": "Report the unfinished workflow state."
        }
      ]
    }
  ]
}
JSON
hook_output="$(cd "$TMP_WORK" && node - <<'NODE'
const { spawnSync } = require("node:child_process");
const result = spawnSync("claude", [
  "-p",
  "--agent",
  "dev",
  "--permission-mode",
  "bypassPermissions",
  "--add-dir",
  ".",
  "--output-format",
  "text",
  "Use a harmless tool first, such as listing the current directory. After that, if Flow Agents hook guidance mentions WORKFLOW STATE ATTENTION or task live-hook, reply exactly HOOK_GUIDANCE_SEEN live-hook. If no such guidance is visible, reply exactly HOOK_GUIDANCE_MISSING.",
], { encoding: "utf8", timeout: 45000 });
process.stdout.write(result.stdout || "");
process.stdout.write(result.stderr || "");
NODE
)"
hook_output_trimmed="$(printf '%s' "$hook_output" | tr -d '\r' | tail -n 1 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
if [[ "$hook_output_trimmed" == "HOOK_GUIDANCE_SEEN live-hook" ]]; then
  _pass "claude live session responds to workflow hook guidance"
else
  _fail "claude live session did not respond to workflow hook guidance (got: $hook_output_trimmed)"
fi

echo ""
echo "--- Telemetry ---"
telemetry_file="$TMP_WORK/.telemetry/full.jsonl"
if [[ "${FLOW_AGENTS_ACCEPTANCE_REQUIRE_CLAUDE_TELEMETRY:-0}" != "1" ]]; then
  _skip "real Claude CLI telemetry assertion skipped"
else
  if wait_for_telemetry "$telemetry_file"; then
    _pass "claude telemetry log was written"
  else
    _fail "claude telemetry log was not written"
  fi

  if [[ -f "$telemetry_file" ]] && jq -e 'select(.agent.runtime == "claude-code")' "$telemetry_file" >/dev/null 2>&1; then
    _pass "claude telemetry uses normalized claude-code runtime"
  else
    _fail "claude telemetry did not include claude-code runtime"
  fi

  if [[ -f "$telemetry_file" ]] && jq -e 'select(.event_type == "turn.user")' "$telemetry_file" >/dev/null 2>&1; then
    _pass "claude telemetry captures user prompts"
  else
    _fail "claude telemetry did not capture user prompts"
  fi
fi

echo ""
echo "==========================="
total=$((pass + fail))
echo "Results: ${pass}/${total} passed, ${fail} failed, ${skip} skipped"
[[ "$fail" -gt 0 ]] && exit 1
exit 0
