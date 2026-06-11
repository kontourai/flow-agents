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
  while [[ $i -lt 150 ]]; do
    [[ -s "$file" ]] && return 0
    sleep 0.1
    i=$((i + 1))
  done
  return 1
}

echo "=== Harness Acceptance: opencode ==="
echo ""

if ! command -v opencode >/dev/null 2>&1; then
  _skip "opencode CLI not installed"
  echo ""
  echo "Results: ${pass}/$((pass + fail)) passed, ${fail} failed, ${skip} skipped"
  exit 0
fi

cd "$ROOT_DIR"
flow_agents_node scripts/build-universal-bundles.js >/dev/null

TMP_WORK="$(mktemp -d /tmp/opencode-acceptance-work.XXXXXX)"
(cd dist/opencode && bash install.sh "$TMP_WORK") >/dev/null

echo "--- Plugin Load + Telemetry ---"
cd "$TMP_WORK"
rm -rf .telemetry

MODEL_ARGS=()
if [[ -n "${FLOW_AGENTS_ACCEPT_OPENCODE_MODEL:-}" ]]; then
  MODEL_ARGS=(-m "$FLOW_AGENTS_ACCEPT_OPENCODE_MODEL")
fi

# Models sometimes answer without calling the tool (nondeterminism), which
# would void the tool.invoke/tool.result assertions — force the tool call
# and retry once if no tool events landed.
ACCEPT_PROMPT="You MUST call the read tool before replying — answering from memory is a failure. Read the first 5 lines of README.md with the read tool, then reply: done"
run_output=""
provider_error=0
for _attempt in 1 2; do
  run_output="$(opencode run "${MODEL_ARGS[@]}" "$ACCEPT_PROMPT" 2>&1 || true)"
  if echo "$run_output" | grep -qi "error"; then
    provider_error=1
    break
  fi
  provider_error=0
  for _i in $(seq 1 50); do
    [[ -s "$TMP_WORK/.telemetry/full.jsonl" ]] && grep -q '"tool.invoke"' "$TMP_WORK/.telemetry/full.jsonl" 2>/dev/null && break
    sleep 0.3
  done
  grep -q '"tool.invoke"' "$TMP_WORK/.telemetry/full.jsonl" 2>/dev/null && break
done

LATEST_LOG="$(ls -t ~/.local/share/opencode/log/*.log 2>/dev/null | head -1 || true)"
if [[ -n "$LATEST_LOG" ]] && grep -q "plugins/flow-agents.js loading plugin" "$LATEST_LOG" 2>/dev/null; then
  _pass "opencode log confirms flow-agents plugin loaded"
else
  _fail "opencode log did not confirm flow-agents plugin loaded"
fi

telemetry_file="$TMP_WORK/.telemetry/full.jsonl"
if [[ "$provider_error" -eq 1 ]]; then
  _skip "opencode telemetry assertions skipped (provider/auth error)"
  _skip "opencode telemetry tool events skipped (provider/auth error)"
else
  if wait_for_telemetry "$telemetry_file"; then
    _pass "opencode telemetry log was written"
  else
    _fail "opencode telemetry log was not written"
  fi

  if [[ -f "$telemetry_file" ]] && \
    node -e "
const fs = require('fs');
const lines = fs.readFileSync('$telemetry_file', 'utf8').trim().split('\n');
const types = lines.map(l => { try { return JSON.parse(l).event_type; } catch(e) { return ''; } });
const hasInvoke = types.some(t => t === 'tool.invoke');
const hasResult = types.some(t => t === 'tool.result');
process.exit(hasInvoke && hasResult ? 0 : 1);
" 2>/dev/null; then
    _pass "opencode telemetry contains tool.invoke and tool.result events"
  else
    _fail "opencode telemetry missing tool.invoke or tool.result events"
  fi
fi

PARENT_TELEMETRY="$(dirname "$TMP_WORK")/.telemetry"
if [[ -d "$PARENT_TELEMETRY" ]]; then
  _fail "opencode wrote .telemetry to workspace parent directory"
else
  _pass "no .telemetry leak to workspace parent directory"
fi

echo ""
echo "==========================="
total=$((pass + fail))
echo "Results: ${pass}/${total} passed, ${fail} failed, ${skip} skipped"
[[ "$fail" -gt 0 ]] && exit 1
exit 0
