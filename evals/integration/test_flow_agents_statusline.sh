#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMPDIR_EVAL="$(mktemp -d /tmp/flow-agents-statusline.XXXXXX)"
pass=0
fail=0

cleanup() {
  rm -rf "$TMPDIR_EVAL"
}
trap cleanup EXIT

_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }

echo "=== Layer 2: Flow Agents Statusline ==="
echo ""

WORKSPACE="$TMPDIR_EVAL/workspace"
TASK_DIR="$WORKSPACE/.flow-agents/status-demo"
mkdir -p "$TASK_DIR"

cat >"$WORKSPACE/.flow-agents/current.json" <<'JSON'
{
  "schema_version": "1.0",
  "active_slug": "status-demo",
  "artifact_dir": "status-demo",
  "owner": "codex",
  "updated_at": "2026-05-25T00:00:00Z",
  "source": "test"
}
JSON

cat >"$TASK_DIR/state.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "status-demo",
  "status": "needs_decision",
  "phase": "evidence",
  "updated_at": "2026-05-25T00:01:00Z",
  "next_action": {
    "status": "needs_user",
    "summary": "Review the release hold and decide whether the missing approval is accepted.",
    "target_phase": "release"
  }
}
JSON

cat >"$TASK_DIR/acceptance.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "status-demo",
  "criteria": [
    {"id": "one", "description": "First criterion", "status": "pass"},
    {"id": "two", "description": "Second criterion", "status": "pending"},
    {"id": "three", "description": "Third criterion", "status": "accepted_gap"}
  ],
  "goal_fit": {"status": "pending", "summary": "Pending"}
}
JSON

if output="$(cd "$WORKSPACE" && node "$ROOT_DIR/scripts/statusline/flow-agents-statusline.js" <<JSON
{"cwd":"$WORKSPACE"}
JSON
)"; then
  if [[ "$output" == *"Flow Agents: status-demo"* && "$output" == *"evidence/needs_decision"* && "$output" == *"2/3 AC"* && "$output" == *"next:"* ]]; then
    _pass "statusline renders active workflow, phase/status, progress, and next action"
  else
    _fail "statusline output missing expected fields: $output"
  fi
else
  _fail "statusline command failed"
fi

EMPTY="$TMPDIR_EVAL/empty"
mkdir -p "$EMPTY"
if output="$(cd "$EMPTY" && node "$ROOT_DIR/scripts/statusline/flow-agents-statusline.js" <<JSON
{"cwd":"$EMPTY"}
JSON
)"; then
  if [[ "$output" == "Flow Agents: no active workflow" ]]; then
    _pass "statusline handles workspaces without workflow state"
  else
    _fail "statusline empty-workspace output was unexpected: $output"
  fi
else
  _fail "statusline empty-workspace command failed"
fi

echo ""
echo "Statusline results: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
