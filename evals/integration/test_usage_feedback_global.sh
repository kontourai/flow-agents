#!/usr/bin/env bash
# test_usage_feedback_global.sh - Layer 2: global usage registry/dashboard validation
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/evals/lib/node.sh"
USAGE_FEEDBACK="$ROOT_DIR/scripts/usage-feedback.js"
TMPDIR_EVAL=$(mktemp -d /tmp/eval-usage-feedback-global.XXXXXX)
pass=0; fail=0

cleanup() { rm -rf "$TMPDIR_EVAL"; }
trap cleanup EXIT

_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }

echo "=== Layer 2: Usage Feedback Global Validation ==="
echo ""

global="$TMPDIR_EVAL/global"
repo_a="$TMPDIR_EVAL/repo-a"
repo_b="$TMPDIR_EVAL/repo-b"
mkdir -p "$repo_a/.agents/flow-agents/alpha" "$repo_b/.agents/flow-agents/beta"

cat > "$repo_a/.agents/flow-agents/alpha/alpha--deliver.md" <<'MARKDOWN'
# Deliver Alpha

status: delivered
type: deliver
MARKDOWN

cat > "$repo_b/.agents/flow-agents/beta/beta--verify.md" <<'MARKDOWN'
# Verify Beta

status: failed
type: verify-work
MARKDOWN

echo "--- Registration ---"
if flow_agents_node "$USAGE_FEEDBACK" register-project \
  --global-dir "$global" \
  --repo-root "$repo_a" \
  --name alpha \
  --profile-id codex-default \
  --prompt-id deliver-v1 \
  --skill-id deliver >"$TMPDIR_EVAL/register.out" 2>"$TMPDIR_EVAL/register.err"; then
  _pass "register-project writes global project registry"
else
  _fail "register-project failed: $(cat "$TMPDIR_EVAL/register.err" 2>/dev/null)"
fi

if [[ -f "$global/projects.json" ]] && jq -e '.projects[] | select(.name == "alpha" and .profile_id == "codex-default")' "$global/projects.json" >/dev/null 2>&1; then
  _pass "registered project preserves profile metadata"
else
  _fail "registered project metadata missing"
fi

echo ""
echo "--- Sync Projects ---"
if flow_agents_node "$USAGE_FEEDBACK" sync-projects \
  --global-dir "$global" \
  --repo-root "$repo_b" \
  --name beta \
  --profile-id codex-experimental \
  --prompt-id verify-v1 \
  --skill-id verify-work >"$TMPDIR_EVAL/sync.out" 2>"$TMPDIR_EVAL/sync.err"; then
  _pass "sync-projects syncs explicit project into global root"
else
  _fail "sync-projects failed: $(cat "$TMPDIR_EVAL/sync.err" 2>/dev/null)"
fi

if [[ -f "$global/projects/beta/outcomes.jsonl" ]] && jq -e 'select(.repo == "beta" and .result == "failure" and .profile_id == "codex-experimental")' "$global/projects/beta/outcomes.jsonl" >/dev/null 2>&1; then
  _pass "global project store contains synced outcome with labels"
else
  _fail "global project store missing synced labeled outcome"
fi

echo ""
echo "--- Global Dashboard ---"
if flow_agents_node "$USAGE_FEEDBACK" global-dashboard \
  --global-dir "$global" \
  --force >"$TMPDIR_EVAL/global-dashboard.out" 2>"$TMPDIR_EVAL/global-dashboard.err"; then
  _pass "global-dashboard syncs registered projects and writes HTML"
else
  _fail "global-dashboard failed: $(cat "$TMPDIR_EVAL/global-dashboard.err" 2>/dev/null)"
fi

dashboard="$global/reports/global-dashboard.html"
if [[ -f "$dashboard" ]] && grep -q "Usage Dashboard" "$dashboard" && grep -q "alpha" "$dashboard" && grep -q "beta" "$dashboard"; then
  _pass "global dashboard includes multiple project groups"
else
  _fail "global dashboard missing expected project groups"
fi

discover_root="$TMPDIR_EVAL/discover-root"
repo_c="$discover_root/gamma"
mkdir -p "$repo_c/.agents/flow-agents/gamma"
cat > "$repo_c/.agents/flow-agents/gamma/gamma--deliver.md" <<'MARKDOWN'
# Deliver Gamma

status: delivered
type: deliver
MARKDOWN

if flow_agents_node "$USAGE_FEEDBACK" global-dashboard \
  --global-dir "$global" \
  --discover "$discover_root" \
  --force >/dev/null 2>"$TMPDIR_EVAL/discover.err" && \
   [[ -f "$global/projects/gamma/outcomes.jsonl" ]]; then
  _pass "global-dashboard can discover child project directories"
else
  _fail "global-dashboard discovery failed: $(cat "$TMPDIR_EVAL/discover.err" 2>/dev/null)"
fi

echo ""
echo "Result: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
