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

echo "=== Harness Acceptance: pi ==="
echo ""

if ! command -v pi >/dev/null 2>&1; then
  _skip "pi CLI not installed"
  echo ""
  echo "Results: ${pass}/$((pass + fail)) passed, ${fail} failed, ${skip} skipped"
  exit 0
fi

cd "$ROOT_DIR"
flow_agents_node scripts/build-universal-bundles.js >/dev/null

TMP_WORK="$(mktemp -d /tmp/pi-acceptance-work.XXXXXX)"
(cd dist/pi && bash install.sh "$TMP_WORK") >/dev/null

echo "--- Telemetry ---"
cd "$TMP_WORK"
rm -rf .telemetry

run_output="$(pi --approve -p \
  "Use your read tool to read the first 5 lines of README.md, then reply: done" 2>&1 || true)"
provider_error=0
if echo "$run_output" | grep -qi "error"; then
  provider_error=1
fi

telemetry_file="$TMP_WORK/.telemetry/full.jsonl"
if [[ "$provider_error" -eq 1 ]]; then
  _skip "pi telemetry assertions skipped (provider/auth error)"
  _skip "pi telemetry event types skipped (provider/auth error)"
  _skip "pi telemetry session events skipped (provider/auth error)"
else
  if wait_for_telemetry "$telemetry_file"; then
    _pass "pi telemetry log was written"
  else
    _fail "pi telemetry log was not written"
  fi

  if [[ -f "$telemetry_file" ]] && \
    node -e "
const fs = require('fs');
const lines = fs.readFileSync('$telemetry_file', 'utf8').trim().split('\n');
const types = lines.map(l => { try { return JSON.parse(l).event_type; } catch(e) { return ''; } });
const required = ['session.start', 'tool.invoke', 'tool.result', 'session.end'];
const missing = required.filter(t => !types.includes(t));
if (missing.length > 0) { process.stderr.write('missing: ' + missing.join(', ') + '\n'); process.exit(1); }
process.exit(0);
" 2>/dev/null; then
    _pass "pi telemetry contains session.start, tool.invoke, tool.result, session.end"
  else
    _fail "pi telemetry missing one or more required event types (session.start, tool.invoke, tool.result, session.end)"
  fi
fi

PARENT_TELEMETRY="$(dirname "$TMP_WORK")/.telemetry"
if [[ -d "$PARENT_TELEMETRY" ]]; then
  _fail "pi wrote .telemetry to workspace parent directory"
else
  _pass "no .telemetry leak to workspace parent directory"
fi

echo ""
echo "==========================="
total=$((pass + fail))
echo "Results: ${pass}/${total} passed, ${fail} failed, ${skip} skipped"
[[ "$fail" -gt 0 ]] && exit 1
exit 0
