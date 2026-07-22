#!/usr/bin/env bash
# test_command_log_integrity.sh — Hash-chain tamper-evidence for command-log.jsonl (Increment B2)
#
# Proves that command-log.jsonl's hash-chain makes alteration DETECTABLE:
#   1. Altered entry (flip exitCode/observedResult without fixing hash) → broken → gate blocks.
#   2. Removed/reordered entry → linkage breaks → broken → gate blocks.
#   3. Legit untampered chain → ok → normal behavior; genuine fail still caught.
#   4. Legacy unchained log (pre-B2) → legacy → existing behavior unchanged.
#
# HONEST FRAMING (in comments and code): this is tamper-EVIDENCE, not tamper-PROOF.
# An agent that recomputes the whole chain can forge a valid chain. The real
# tamper-proof boundary is the signed checkpoint (B1, already merged). This chain
# raises the local bar and catches casual/accidental tampering and corruption.
#
# Usage: bash evals/integration/test_command_log_integrity.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# #440 FIXTURE-GAP: this suite's fixtures were written before #440's per-actor ownership scoping
# and never establish a per-actor current pointer for the invoking actor -- under a RESOLVED
# ambient actor (ancestry-derived locally, GITHUB_RUN_ID-derived CI-runtime in CI), stop-goal-fit.js's
# analyze() now scopes to that actor's own (nonexistent) pointer and never reaches the
# fixture-under-test at all. This suite is about anti-gaming/gate mechanics, not #440's ownership
# scoping, so forcing the documented test-only unresolved-actor escape hatch restores EXACTLY this
# suite's pre-#440 behavior (D3 compat: an unresolved actor keeps the unchanged legacy-fallback/
# global-scan discovery every assertion below was written against).
export FLOW_AGENTS_ACTOR_TEST_FORCE_UNRESOLVED=1
export NODE_ENV=test
CAPTURE="$ROOT/scripts/hooks/evidence-capture.js"
GATE="$ROOT/scripts/hooks/stop-goal-fit.js"

export FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=100000

TMP="$(mktemp -d)"
errors=0
_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# ── helper: seed a minimal delivered workflow artifact ────────────────────────
seed_repo() { # $1=dir $2=slug
  local p="$1" slug="$2"
  mkdir -p "$p/.kontourai/flow-agents/$slug"
  printf '# Repo\n' > "$p/AGENTS.md"
  printf '%s' "{\"schema_version\":\"1.0\",\"task_slug\":\"$slug\",\"status\":\"delivered\",\"phase\":\"done\",\"updated_at\":\"2026-06-23T00:00:00Z\",\"next_action\":{\"status\":\"done\",\"summary\":\"done\"}}" \
    > "$p/.kontourai/flow-agents/$slug/state.json"
  cat > "$p/.kontourai/flow-agents/$slug/$slug--deliver.md" << MD
# $slug

branch: main
status: delivered
type: deliver

## Definition Of Done
- [x] tests pass

## Goal Fit Gate
- [x] acceptance verified

### Verdict: PASS
MD
}

# Write two chained entries to command-log.jsonl via evidence-capture.js.
# Returns the log file path.
write_chained_log() { # $1=repo_dir $2=slug
  local p="$1" slug="$2"
  # Entry 0: npm test passes
  printf '{"hook_event_name":"PostToolUse","tool_name":"Bash","cwd":"%s","tool_input":{"command":"npm test"},"tool_response":{"exitCode":0,"stdout":"ok"}}' "$p" \
    | node "$CAPTURE" >/dev/null 2>&1
  # Entry 1: npm run lint FAILS
  printf '{"hook_event_name":"PostToolUse","tool_name":"Bash","cwd":"%s","tool_input":{"command":"npm run lint"},"tool_response":{"exitCode":1,"stderr":"lint errors"}}' "$p" \
    | node "$CAPTURE" >/dev/null 2>&1
}

# ─── Test 1: altered entry detected (flip exitCode/observedResult, keep old hash) ──────
echo "Test 1: altered entry (flip fail→pass without fixing hash) → broken → gate blocks"

T1="$TMP/t1"; seed_repo "$T1" t1
write_chained_log "$T1" t1

LOG="$T1/.kontourai/flow-agents/t1/command-log.jsonl"

if [[ -f "$LOG" ]]; then _pass "T1: command-log.jsonl written"; else _fail "T1: command-log.jsonl missing"; fi

# Verify clean chain (before tamper)
chain_status=$(node -e "const g = require('$GATE'); const r = g.verifyCommandLogChain('$T1/.kontourai/flow-agents/t1'); console.log(r.status);")
if [[ "$chain_status" == "ok" ]]; then
  _pass "T1: untampered chain verifies as ok"
else
  _fail "T1: expected ok, got $chain_status"
fi

# Tamper: flip entry 1 (lint, FAIL) to look like a PASS — change exitCode and observedResult
# but do NOT update _chain.hash → chain is broken.
python3 - "$LOG" << 'PY'
import json, sys
lines = open(sys.argv[1]).read().strip().split('\n')
e1 = json.loads(lines[1])
e1['exitCode'] = 0          # hide the failure
e1['observedResult'] = 'pass'  # claim it passed
# _chain.hash is NOT updated — deliberate, this is the tamper
lines[1] = json.dumps(e1)
open(sys.argv[1], 'w').write('\n'.join(lines) + '\n')
PY

# Verify broken chain
chain_after=$(node -e "const g = require('$GATE'); const r = g.verifyCommandLogChain('$T1/.kontourai/flow-agents/t1'); console.log(r.status + ':' + r.brokenAt);")
if [[ "$chain_after" == "broken:1" ]]; then
  _pass "T1: tampered entry detected → broken at entry 1"
else
  _fail "T1: expected broken:1, got $chain_after"
fi

# Seed evidence.json claiming npm test passed (the untampered entry)
# The tampered entry (lint) was a FAIL flipped to PASS — so the log now shows a false pass.
# Since chain is broken, gate should block with integrity warning and NOT trust log passes.
printf '%s' '{"schema_version":"1.0","task_slug":"t1","verdict":"pass","checks":[{"id":"npm-test","kind":"command","status":"pass","command":"npm test","summary":"passed"}]}' \
  > "$T1/.kontourai/flow-agents/t1/evidence.json"

set +e
gate_out=$(FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip \
  node "$GATE" 2>&1 <<< "{\"hook_event_name\":\"Stop\",\"cwd\":\"$T1\"}")
gate_exit=$?
set -e

if [[ "$gate_exit" -eq 2 ]]; then
  _pass "T1: gate blocks (exit 2) when chain is broken"
else
  _fail "T1: gate should block on broken chain, exit=$gate_exit output=$gate_out"
fi

if echo "$gate_out" | grep -q "command-log integrity check FAILED"; then
  _pass "T1: gate emits integrity-failure warning"
else
  _fail "T1: missing integrity-failure warning: $gate_out"
fi

if echo "$gate_out" | grep -q "NOT trusted"; then
  _pass "T1: gate emits 'NOT trusted' signal for claimed passes"
else
  _fail "T1: missing NOT trusted signal: $gate_out"
fi

# ─── Test 2: removed/reordered entry detected ─────────────────────────────────────
echo ""
echo "Test 2: removed/reordered entry → linkage breaks → broken → gate flags it"

T2="$TMP/t2"; seed_repo "$T2" t2
write_chained_log "$T2" t2

LOG2="$T2/.kontourai/flow-agents/t2/command-log.jsonl"
lines_before=$(wc -l < "$LOG2" | tr -d ' ')

# Reorder: swap entry 0 and entry 1
python3 - "$LOG2" << 'PY'
import sys
lines = open(sys.argv[1]).read().strip().split('\n')
# swap
lines[0], lines[1] = lines[1], lines[0]
open(sys.argv[1], 'w').write('\n'.join(lines) + '\n')
PY

chain_reorder=$(node -e "const g = require('$GATE'); const r = g.verifyCommandLogChain('$T2/.kontourai/flow-agents/t2'); console.log(r.status);")
if [[ "$chain_reorder" == "broken" ]]; then
  _pass "T2: reordered entries detected → broken"
else
  _fail "T2: expected broken on reorder, got $chain_reorder"
fi

# Test: delete a predecessor from a fresh valid two-entry chain. The shared
# append authority correctly refuses to extend the deliberately broken reorder
# above, so reset only this disposable fixture's log before creating the case.
: > "$LOG2"
write_chained_log "$T2" t2
# Delete the first entry, leaving the second with an unreachable parent.
LOG2_FRESH="$T2/.kontourai/flow-agents/t2/command-log.jsonl"
python3 - "$LOG2_FRESH" << 'PY'
import sys
lines = [l for l in open(sys.argv[1]).read().strip().split('\n') if l.strip()]
# Delete entry[0] → only entry[1] remains, whose prevHash is unreachable.
open(sys.argv[1], 'w').write(lines[1] + '\n')
PY

chain_delete=$(node -e "const g = require('$GATE'); const r = g.verifyCommandLogChain('$T2/.kontourai/flow-agents/t2'); console.log(r.status);")
if [[ "$chain_delete" == "broken" ]]; then
  _pass "T2: removed predecessor entry detected → broken (prevHash mismatch)"
else
  _fail "T2: expected broken on removed predecessor, got $chain_delete"
fi

# ─── Test 3: legit untampered chain — ok — genuine fail still caught ─────────────────
echo ""
echo "Test 3: legit untampered chain → ok → genuine fail still caught (capture-teeth)"

T3="$TMP/t3"; seed_repo "$T3" t3
# Write entry 0 (pass) and entry 1 (fail)
printf '{"hook_event_name":"PostToolUse","tool_name":"Bash","cwd":"%s","tool_input":{"command":"npm test"},"tool_response":{"exitCode":0}}' "$T3" \
  | node "$CAPTURE" >/dev/null 2>&1
printf '{"hook_event_name":"PostToolUse","tool_name":"Bash","cwd":"%s","tool_input":{"command":"npm run build"},"tool_response":{"exitCode":1}}' "$T3" \
  | node "$CAPTURE" >/dev/null 2>&1

chain_legit=$(node -e "const g = require('$GATE'); const r = g.verifyCommandLogChain('$T3/.kontourai/flow-agents/t3'); console.log(r.status);")
if [[ "$chain_legit" == "ok" ]]; then
  _pass "T3: untampered chained log verifies ok"
else
  _fail "T3: expected ok, got $chain_legit"
fi

# Evidence claims npm run build passed (it actually failed → capture log shows fail → block)
printf '%s' '{"schema_version":"1.0","task_slug":"t3","verdict":"pass","checks":[{"id":"build","kind":"command","status":"pass","command":"npm run build","summary":"build passed"}]}' \
  > "$T3/.kontourai/flow-agents/t3/evidence.json"

set +e
gate3_out=$(FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip \
  node "$GATE" 2>&1 <<< "{\"hook_event_name\":\"Stop\",\"cwd\":\"$T3\"}")
gate3_exit=$?
set -e

if [[ "$gate3_exit" -eq 2 ]]; then
  _pass "T3: gate blocks on genuine fail caught by capture log (ok chain, capture teeth active)"
else
  _fail "T3: gate should block on captured fail, exit=$gate3_exit output=$gate3_out"
fi

if echo "$gate3_out" | grep -q "capture log CONTRADICTS claimed pass"; then
  _pass "T3: gate emits capture-log contradicts warning (genuine fail caught)"
else
  _fail "T3: missing capture-log contradicts warning: $gate3_out"
fi

if ! echo "$gate3_out" | grep -q "command-log integrity check FAILED"; then
  _pass "T3: no false integrity-failure warning for untampered chain"
else
  _fail "T3: spurious integrity-failure warning emitted: $gate3_out"
fi

# ─── Test 4: backward-compat — legacy unchained log → legacy → existing behavior ────
echo ""
echo "Test 4: legacy unchained log (no _chain) → legacy → existing behavior unchanged"

T4="$TMP/t4"; seed_repo "$T4" t4

# Write a legacy-style log (no _chain field) — exactly like pre-B2 fixtures
printf '%s\n' '{"command":"npm test","observedResult":"fail","exitCode":1,"capturedAt":"2026-06-23T00:00:00Z","source":"postToolUse-capture"}' \
  > "$T4/.kontourai/flow-agents/t4/command-log.jsonl"

chain_legacy=$(node -e "const g = require('$GATE'); const r = g.verifyCommandLogChain('$T4/.kontourai/flow-agents/t4'); console.log(r.status);")
if [[ "$chain_legacy" == "legacy" ]]; then
  _pass "T4: unchained (legacy) log returns legacy status"
else
  _fail "T4: expected legacy, got $chain_legacy"
fi

# Evidence claims npm test passed, but legacy log shows it failed → still blocks
printf '%s' '{"schema_version":"1.0","task_slug":"t4","verdict":"pass","checks":[{"id":"unit-tests","kind":"command","status":"pass","command":"npm test","summary":"passed"}]}' \
  > "$T4/.kontourai/flow-agents/t4/evidence.json"

set +e
gate4_out=$(FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip \
  node "$GATE" 2>&1 <<< "{\"hook_event_name\":\"Stop\",\"cwd\":\"$T4\"}")
gate4_exit=$?
set -e

if [[ "$gate4_exit" -eq 2 ]] && echo "$gate4_out" | grep -q "capture log CONTRADICTS"; then
  _pass "T4: legacy log still catches false-completion (existing behavior preserved)"
else
  _fail "T4: legacy log failed to catch false-completion: exit=$gate4_exit output=$gate4_out"
fi

if ! echo "$gate4_out" | grep -q "command-log integrity check FAILED"; then
  _pass "T4: no integrity-failure warning for legacy (unchained) log"
else
  _fail "T4: spurious integrity warning for legacy log: $gate4_out"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "command-log integrity tests passed."
  exit 0
fi
echo "command-log integrity tests FAILED: $errors issue(s)."
exit 1
