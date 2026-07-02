#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/evals/lib/node.sh"
TMP_HOME=""
TMP_WORK=""
TMP_TELEMETRY=""
pass=0
fail=0
skip=0

cleanup() {
  [[ -n "$TMP_HOME" ]] && rm -rf "$TMP_HOME"
  [[ -n "$TMP_WORK" ]] && rm -rf "$TMP_WORK"
  [[ -n "$TMP_TELEMETRY" ]] && rm -rf "$TMP_TELEMETRY"
}
trap cleanup EXIT

_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }
_skip() { echo "  ○ $1"; skip=$((skip + 1)); }
strip_ansi() {
  perl -pe 's/\e\[[0-9;?]*[ -\/]*[@-~]//g; s/\e\(B//g'
}

echo "=== Harness Acceptance: Kiro ==="
echo ""

if ! command -v kiro-cli >/dev/null 2>&1; then
  _skip "kiro-cli not installed"
  echo ""
  echo "Results: ${pass}/$((pass + fail)) passed, ${fail} failed, ${skip} skipped"
  exit 0
fi

cd "$ROOT_DIR"
flow_agents_node scripts/build-universal-bundles.js >/dev/null

TMP_HOME="$(mktemp -d /tmp/kiro-acceptance-home.XXXXXX)"
TMP_WORK="$(mktemp -d /tmp/kiro-acceptance-work.XXXXXX)"
TMP_TELEMETRY="$(mktemp -d /tmp/kiro-acceptance-telemetry.XXXXXX)"
bash dist/kiro/install.sh "$TMP_HOME" >/dev/null
mkdir -p "$TMP_WORK/.kiro"
ln -s "$TMP_HOME/agents" "$TMP_WORK/.kiro/agents"

echo "--- Agent List ---"
list_output="$(cd "$TMP_WORK" && kiro-cli agent list 2>&1 || true)"
if echo "$list_output" | grep -q "dev[[:space:]]\+Workspace"; then
  _pass "workspace agent list includes dev"
else
  _fail "workspace agent list did not include dev"
fi

echo ""
echo "--- Chat Smoke ---"
chat_output="$(cd "$TMP_WORK" && kiro-cli chat --agent dev --no-interactive "Reply with READY only." 2>&1 || true)"
if echo "$chat_output" | grep -q "READY"; then
  _pass "dev agent replied to chat smoke prompt"
else
  _fail "dev agent did not reply READY"
fi

echo ""
echo "--- Explore Behavior ---"
explore_output="$(cd "$TMP_WORK" && TELEMETRY_ENABLED=true TELEMETRY_DATA_DIR="$TMP_TELEMETRY" TELEMETRY_SESSION_DIR="$TMP_TELEMETRY/sessions" TELEMETRY_CHANNELS=full TELEMETRY_CHANNEL_FULL_LOG_FILE="$TMP_TELEMETRY/full.jsonl" node - <<'NODE'
const { spawnSync } = require("node:child_process");
const result = spawnSync("kiro-cli", [
  "chat",
  "--agent",
  "dev",
  "--no-interactive",
  "--trust-all-tools",
  "Explore the codebase and explain what it does.",
], { encoding: "utf8", timeout: 30000 });
process.stdout.write(result.stdout || "");
process.stdout.write(result.stderr || "");
NODE
)"
explore_clean="$(printf '%s' "$explore_output" | strip_ansi)"
if echo "$explore_clean" | grep -q "Activating skill: explore"; then
  _pass "dev activates the explore skill on a plain explore prompt"
else
  _fail "dev did not activate the explore skill on a plain explore prompt"
fi

if echo "$explore_clean" | grep -q "Tool validation failed"; then
  _fail "explore workflow exceeded harness delegation limits"
else
  _pass "explore workflow stayed within harness delegation limits"
fi

if [[ -f "$TMP_TELEMETRY/full.jsonl" ]] && rg -q '"event_type":"agent.delegate"' "$TMP_TELEMETRY/full.jsonl"; then
  _pass "telemetry confirms delegated explore execution"
else
  _fail "telemetry did not confirm delegated explore execution"
fi

echo ""
echo "--- Strict Stop Gate ---"
mkdir -p "$TMP_WORK/.flow-agents/live-stop"
cat > "$TMP_WORK/.flow-agents/live-stop/live-stop--deliver.md" <<'MARKDOWN'
# Live Stop Gate

status: executing
type: deliver

## Plan

This delivery artifact is intentionally incomplete so the strict stop hook must surface Goal Fit guidance.
MARKDOWN

stop_output="$(cd "$TMP_WORK" && FLOW_AGENTS_GOAL_FIT_STRICT=true kiro-cli chat --agent dev --no-interactive "Reply with READY only." 2>&1 || true)"
stop_clean="$(printf '%s' "$stop_output" | strip_ansi)"
if echo "$stop_clean" | grep -q 'stop "node .*stop:goal-fit stop-goal-fit.js standard,strict" failed with exit code: 2' \
  && echo "$stop_clean" | grep -q '\[stop-gate\] Goal Fit warning:' \
  && echo "$stop_clean" | grep -q 'live-stop--deliver.md is still status:executing'; then
  _pass "strict Goal Fit stop hook surfaces live Kiro stop gate"
else
  _fail "strict Goal Fit stop hook did not surface live Kiro stop gate"
fi

echo ""
echo "==========================="
total=$((pass + fail))
echo "Results: ${pass}/${total} passed, ${fail} failed, ${skip} skipped"
[[ "$fail" -gt 0 ]] && exit 1
exit 0
