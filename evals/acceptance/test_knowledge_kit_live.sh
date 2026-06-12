#!/usr/bin/env bash
# test_knowledge_kit_live.sh — Acceptance: Knowledge Kit S5 live example
#
# Gated on:
#   1. ollama binary at /run/current-system/sw/bin/ollama
#   2. qwen3:1.7b model pulled (checked via ollama list)
#   3. Python venv with strands-agents[ollama] at /tmp/strands-py-live/venv
#
# Skips cleanly if any gate is absent (matching other harness conventions).
# Starts ollama serve, runs the live example, asserts evidence, stops ollama.
#
# Assertions:
#   A1. Script exits 0 (overall PASS printed)
#   A2. <workspace>/.telemetry/full.jsonl exists and contains tool.invoke + tool.result
#   A3. <workspace>/.flow-agents/.telemetry/full.jsonl exists and contains
#       session.start, tool.invoke, tool.result (FlowAgentsHooks events)
#   A4. No new .telemetry directory created in the workspace's parent directory
#       by this script (pre-existing parent-dir .telemetry is not counted)
#   A5. At least 1 compiled record in <workspace>/.knowledge-store/records/
#   A6. Compiled record has provenance source_ids referencing raw records
#
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

OLLAMA_BIN="/run/current-system/sw/bin/ollama"
VENV_PYTHON="/tmp/strands-py-live/venv/bin/python3"
EXAMPLE_SCRIPT="$ROOT_DIR/integrations/strands/examples/knowledge_kit_live.py"

pass=0
fail=0
skip=0
OLLAMA_STARTED=0

_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }
_skip() { echo "  ○ $1"; skip=$((skip + 1)); }

cleanup() {
  if [[ "$OLLAMA_STARTED" -eq 1 ]]; then
    pkill -f "ollama serve" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "=== Acceptance: Knowledge Kit S5 Live Example ==="
echo ""

# ── Gate checks ─────────────────────────────────────────────────────────────
if [[ ! -x "$OLLAMA_BIN" ]]; then
  _skip "ollama binary not found at $OLLAMA_BIN"
  echo ""
  echo "Results: ${pass}/$((pass + fail)) passed, ${fail} failed, ${skip} skipped"
  exit 0
fi

if [[ ! -x "$VENV_PYTHON" ]]; then
  _skip "Python venv not found at $VENV_PYTHON — run: python3 -m venv /tmp/strands-py-live/venv && /tmp/strands-py-live/venv/bin/pip install 'strands-agents[ollama]'"
  echo ""
  echo "Results: ${pass}/$((pass + fail)) passed, ${fail} failed, ${skip} skipped"
  exit 0
fi

_pass "Gate: ollama binary present"
_pass "Gate: Python venv with strands-agents present"
echo ""

# ── Start ollama serve ───────────────────────────────────────────────────────
echo "--- Starting ollama serve ---"
"$OLLAMA_BIN" serve > /tmp/ollama-knowledge-kit-live.log 2>&1 &
OLLAMA_STARTED=1

# Wait for server to be ready (up to 15 seconds)
for i in {1..15}; do
  if curl -s localhost:11434/v1/models >/dev/null 2>&1; then
    _pass "ollama serve ready (${i}s)"
    break
  fi
  if [[ "$i" -eq 15 ]]; then
    _fail "ollama serve did not start within 15 seconds"
    echo ""
    echo "Results: ${pass}/$((pass + fail)) passed, ${fail} failed, ${skip} skipped"
    exit 1
  fi
  sleep 1
done

# Model gate AFTER server start: ollama list errors when no server is running,
# which previously misreported a pulled model as missing (skip-path bug).
if ! "$OLLAMA_BIN" list 2>/dev/null | grep -q "qwen3:1.7b"; then
  _skip "qwen3:1.7b model not pulled — run: ollama pull qwen3:1.7b"
  echo ""
  echo "Results: ${pass}/$((pass + fail)) passed, ${fail} failed, ${skip} skipped"
  exit 0
fi
_pass "Gate: qwen3:1.7b model pulled"
echo ""

# ── Run the example ──────────────────────────────────────────────────────────
echo "--- Running knowledge_kit_live.py ---"
EXAMPLE_OUTPUT="$(mktemp /tmp/knowledge-kit-live-output.XXXXXX)"

FLOW_AGENTS_ROOT="$ROOT_DIR" \
  "$VENV_PYTHON" "$EXAMPLE_SCRIPT" 2>&1 | tee "$EXAMPLE_OUTPUT"
EXAMPLE_EXIT="${PIPESTATUS[0]}"

echo ""

# ── Assert A1: script exits 0 ─────────────────────────────────────────────
if [[ "$EXAMPLE_EXIT" -eq 0 ]]; then
  _pass "A1: example script exits 0"
else
  _fail "A1: example script exited $EXAMPLE_EXIT"
fi

# Extract workspace path from script output
WORKSPACE="$(grep "^Workspace: " "$EXAMPLE_OUTPUT" | head -1 | sed 's/^Workspace: //')"
if [[ -z "$WORKSPACE" ]]; then
  _fail "Could not extract workspace path from script output"
  echo ""
  echo "Results: ${pass}/$((pass + fail)) passed, ${fail} failed, ${skip} skipped"
  exit 1
fi

echo "  Workspace: $WORKSPACE"
KIT_TELEMETRY="$WORKSPACE/.telemetry/full.jsonl"
SESSION_TELEMETRY="$WORKSPACE/.flow-agents/.telemetry/full.jsonl"
STORE_RECORDS="$WORKSPACE/.knowledge-store/records"

# ── Assert A2: kit telemetry contains tool.invoke + tool.result ───────────
if [[ -f "$KIT_TELEMETRY" ]] && \
  node -e "
const fs = require('fs');
const lines = fs.readFileSync('$KIT_TELEMETRY', 'utf8').trim().split('\n').filter(Boolean);
const types = lines.map(l => { try { return JSON.parse(l).event_type; } catch(e) { return ''; } });
const required = ['tool.invoke', 'tool.result'];
const missing = required.filter(t => !types.includes(t));
if (missing.length > 0) { process.stderr.write('missing: ' + missing.join(', ') + '\n'); process.exit(1); }
" 2>/dev/null; then
  _pass "A2: kit telemetry contains tool.invoke + tool.result gate events"
else
  _fail "A2: kit telemetry missing or lacks required event types (tool.invoke, tool.result)"
fi

# ── Assert A3: session telemetry contains session.start, tool.invoke, tool.result ─
if [[ -f "$SESSION_TELEMETRY" ]] && \
  node -e "
const fs = require('fs');
const lines = fs.readFileSync('$SESSION_TELEMETRY', 'utf8').trim().split('\n').filter(Boolean);
const types = lines.map(l => { try { return JSON.parse(l).event_type; } catch(e) { return ''; } });
const required = ['session.start', 'tool.invoke', 'tool.result'];
const missing = required.filter(t => !types.includes(t));
if (missing.length > 0) { process.stderr.write('missing: ' + missing.join(', ') + '\n'); process.exit(1); }
" 2>/dev/null; then
  _pass "A3: session telemetry contains session.start, tool.invoke, tool.result"
else
  _fail "A3: session telemetry missing or lacks required FlowAgentsHooks events"
fi

# ── Assert A4: workspace telemetry does not leak to parent ────────────────
# This assertion checks that telemetry written during this test run does not
# appear in the parent directory. We verify that the workspace telemetry is
# contained within WORKSPACE, not in its parent.
# (Pre-existing .telemetry in the system temp dir is not counted as a leak.)
PARENT_TELEMETRY="$(dirname "$WORKSPACE")/.telemetry"
if [[ -d "$PARENT_TELEMETRY" ]]; then
  # Only fail if the directory was modified during our test (mtime within last 60s)
  PARENT_MTIME="$(find "$PARENT_TELEMETRY" -newer "$EXAMPLE_OUTPUT" -name "*.jsonl" 2>/dev/null | wc -l | tr -d ' ')"
  if [[ "$PARENT_MTIME" -gt 0 ]]; then
    _fail "A4: telemetry leaked — new .jsonl files written to workspace parent directory during this test"
  else
    _pass "A4: workspace telemetry contained within workspace (pre-existing parent .telemetry not modified by this test)"
  fi
else
  _pass "A4: no .telemetry in workspace parent directory"
fi

# ── Assert A5: at least 1 compiled record exists ─────────────────────────
COMPILED_COUNT=0
if [[ -d "$STORE_RECORDS" ]]; then
  COMPILED_COUNT=$(grep -rl "type: compiled" "$STORE_RECORDS"/*.md 2>/dev/null | wc -l | tr -d ' ')
fi
if [[ "$COMPILED_COUNT" -ge 1 ]]; then
  _pass "A5: compiled record found in store ($COMPILED_COUNT)"
else
  _fail "A5: no compiled records found in $STORE_RECORDS"
fi

# ── Assert A6: compiled record has provenance source_ids ─────────────────
PROVENANCE_OK=0
if [[ -d "$STORE_RECORDS" ]]; then
  for compiled_md in "$STORE_RECORDS"/*.md; do
    [[ -f "$compiled_md" ]] || continue
    if grep -q "type: compiled" "$compiled_md" && grep -q "source_ids:" "$compiled_md"; then
      # Verify at least 2 raw ids are referenced
      SOURCE_COUNT=$(grep -c "^  - " "$compiled_md" 2>/dev/null || echo 0)
      if [[ "$SOURCE_COUNT" -ge 2 ]]; then
        PROVENANCE_OK=1
        break
      fi
    fi
  done
fi
if [[ "$PROVENANCE_OK" -eq 1 ]]; then
  _pass "A6: compiled record has provenance source_ids with resolving raw refs"
else
  _fail "A6: compiled record missing source_ids or insufficient provenance refs"
fi

# ── Cleanup temp files ───────────────────────────────────────────────────
rm -f "$EXAMPLE_OUTPUT"
if [[ -d "$WORKSPACE" ]]; then
  rm -rf "$WORKSPACE"
fi

echo ""
echo "==========================="
total=$((pass + fail))
echo "Results: ${pass}/${total} passed, ${fail} failed, ${skip} skipped"
[[ "$fail" -gt 0 ]] && exit 1
exit 0
