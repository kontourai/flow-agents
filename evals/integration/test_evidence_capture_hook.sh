#!/usr/bin/env bash
# test_evidence_capture_hook.sh — Capture-first evidence determinism contracts.
#
# Part A: evidence-capture.js deterministically records command executions to
#         .kontourai/flow-agents/<slug>/command-log.jsonl (machine-recorded, not model-claimed).
# Part B: stop-goal-fit.js cross-references evidence.json claimed-pass command
#         checks against the capture log, and re-runs a TRUSTED backstop command
#         only when the log has no execution for a claimed-pass command.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CAPTURE="$ROOT/scripts/hooks/evidence-capture.js"
GATE="$ROOT/scripts/hooks/stop-goal-fit.js"

# Disable the block escape hatch so repeated independent assertions never trip it.
export FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=100000

TMP="$(mktemp -d)"
errors=0
_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

# ---- helpers -------------------------------------------------------------
seed_repo() { # $1 dir, $2 slug
  local p="$1" slug="$2"
  mkdir -p "$p/.kontourai/flow-agents/$slug"
  printf '# Repo\n' > "$p/AGENTS.md"
  printf '%s' "{\"schema_version\":\"1.0\",\"task_slug\":\"$slug\",\"status\":\"delivered\",\"phase\":\"done\",\"updated_at\":\"2026-06-23T00:00:00Z\",\"next_action\":{\"status\":\"done\",\"summary\":\"done\"}}" > "$p/.kontourai/flow-agents/$slug/state.json"
  cat > "$p/.kontourai/flow-agents/$slug/$slug--deliver.md" <<MD
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

capture() { # stdin = payload json
  node "$CAPTURE" >/dev/null 2>&1
}

# ============================================================================
# Part A — deterministic capture
# ============================================================================
A="$TMP/capture"; seed_repo "$A" t1
echo "Part A: deterministic capture"

printf '{"hook_event_name":"PostToolUse","tool_name":"Bash","cwd":"%s","tool_input":{"command":"npm test"},"tool_response":{"exitCode":0,"stdout":"ok"}}' "$A" | capture
printf '{"hook_event_name":"PostToolUse","tool_name":"Bash","cwd":"%s","tool_input":{"command":"npm run lint"},"error":"command failed"}' "$A" | capture
printf '{"hook_event_name":"PostToolUse","tool_name":"Bash","cwd":"%s","tool_input":{"command":"make build"},"tool_response":{"exit_code":2}}' "$A" | capture
# #470 rule-3 default: no exit code, no error, no stderr → ambiguous (never pass).
printf '{"hook_event_name":"PostToolUse","tool_name":"Bash","cwd":"%s","tool_input":{"command":"echo status-check"}}' "$A" | capture
# A non-command tool (Write) must NOT be captured.
printf '{"hook_event_name":"PostToolUse","tool_name":"Write","cwd":"%s","tool_input":{"file_path":"/tmp/x"}}' "$A" | capture

LOG="$A/.kontourai/flow-agents/t1/command-log.jsonl"
if [[ -f "$LOG" ]]; then _pass "capture writes command-log.jsonl"; else _fail "capture did not write command-log.jsonl"; fi

lines=$(wc -l < "$LOG" | tr -d ' ')
if [[ "$lines" == "4" ]]; then _pass "capture records 4 command executions (Write tool excluded)"; else _fail "expected 4 log lines, got $lines"; fi

if rg -q '"command":"npm test","observedResult":"pass","exitCode":0' "$LOG"; then
  _pass "clean exit 0 recorded as observedResult:pass exitCode:0"
else _fail "passing command not recorded correctly: $(cat "$LOG")"; fi

if rg -q '"command":"npm run lint","observedResult":"fail","exitCode":null' "$LOG"; then
  _pass "error field with no exit code recorded as fail exitCode:null"
else _fail "errored command not recorded correctly"; fi

if rg -q '"command":"make build","observedResult":"fail","exitCode":2' "$LOG"; then
  _pass "non-zero exit recorded as fail with exitCode"
else _fail "non-zero-exit command not recorded correctly"; fi

# #470 rule-3 default: absent any positive success evidence, observedResult is
# "ambiguous" (never "pass"). The error-bearing case above ("npm run lint" →
# fail, exitCode:null) already proves rule 2 (isFailureIndicated) is unchanged
# by the rule-3 flip.
if rg -q '"command":"echo status-check","observedResult":"ambiguous","exitCode":null' "$LOG"; then
  _pass "no-signal command (no exit code, no error, no stderr) recorded as ambiguous, never pass"
else _fail "no-signal command not recorded as ambiguous: $(cat "$LOG")"; fi

if rg -q '"source":"postToolUse-capture"' "$LOG"; then _pass "records source:postToolUse-capture"; else _fail "missing source field"; fi

# Capture is non-blocking: it always exits 0 and echoes stdin.
out=$(printf '{"hook_event_name":"PostToolUse","tool_name":"Bash","cwd":"%s","tool_input":{"command":"echo hi"},"error":"boom"}' "$A" | node "$CAPTURE"; echo "EXIT=$?")
if rg -q 'EXIT=0' <<<"$out" && rg -q 'echo hi' <<<"$out"; then
  _pass "capture is non-blocking (exit 0, echoes stdin) even on a failing command"
else _fail "capture should be non-blocking and echo stdin"; fi

# ============================================================================
# Part B1 — gate cross-references log: claimed pass but log shows FAIL → block
# ============================================================================
echo "Part B1: log contradicts claimed pass → block"
B="$TMP/contradict"; seed_repo "$B" t1
printf '%s' '{"schema_version":"1.0","task_slug":"t1","verdict":"pass","checks":[{"id":"unit-tests","kind":"command","status":"pass","command":"npm test","summary":"tests passed"}]}' > "$B/.kontourai/flow-agents/t1/evidence.json"
printf '%s\n' '{"command":"npm test","observedResult":"fail","exitCode":1,"capturedAt":"2026-06-23T00:00:00Z","source":"postToolUse-capture"}' > "$B/.kontourai/flow-agents/t1/command-log.jsonl"

if FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip node "$GATE" >/dev/null 2>"$TMP/b1.err" <<JSON
{"hook_event_name":"Stop","cwd":"$B"}
JSON
then _fail "gate should BLOCK when capture log contradicts claimed pass"
else
  status=$?
  if [[ "$status" -eq 2 ]] && rg -q 'capture log CONTRADICTS claimed pass' "$TMP/b1.err" && rg -q 'caught false-completion' "$TMP/b1.err"; then
    _pass "gate blocks (exit 2) caught false-completion via capture log"
  else _fail "gate returned unexpected result: status=$status output=$(cat "$TMP/b1.err")"; fi
fi

# ============================================================================
# Part B2 — gate cross-references log: claimed pass and log shows PASS → no re-run
# ============================================================================
echo "Part B2: log confirms claimed pass → satisfied, no re-run"
C="$TMP/confirm"; seed_repo "$C" t1
printf '%s' '{"schema_version":"1.0","task_slug":"t1","verdict":"pass","checks":[{"id":"unit-tests","kind":"command","status":"pass","command":"npm test","summary":"tests passed"}]}' > "$C/.kontourai/flow-agents/t1/evidence.json"
printf '%s\n' '{"command":"npm test","observedResult":"pass","exitCode":0,"capturedAt":"2026-06-23T00:00:00Z","source":"postToolUse-capture"}' > "$C/.kontourai/flow-agents/t1/command-log.jsonl"
# A poisoned npm on PATH proves the gate does NOT re-run when the log confirms.
POISON="$TMP/poison"; mkdir -p "$POISON"
printf '#!/usr/bin/env bash\necho "npm should not run" >&2\nexit 99\n' > "$POISON/npm"; chmod +x "$POISON/npm"
PATH="$POISON:$PATH" FLOW_AGENTS_GOAL_FIT_MODE=block node "$GATE" >/dev/null 2>"$TMP/b2.err" <<JSON
{"hook_event_name":"Stop","cwd":"$C"}
JSON
if rg -q 'CONTRADICTS|backstop|npm should not run' "$TMP/b2.err"; then
  _fail "gate should NOT re-run or warn when the capture log confirms the pass: $(cat "$TMP/b2.err")"
else _pass "gate trusts the log on a confirmed pass and does not re-run the backstop"; fi

# ============================================================================
# Part B3 — never-captured claimed-pass command → trusted backstop re-run (declared manifest target FAILS) → block
# ============================================================================
echo "Part B3: never-captured claim → trusted manifest backstop catches a fail"
D="$TMP/backstop"; seed_repo "$D" t1
printf '%s' '{"name":"x","scripts":{"test":"exit 7"}}' > "$D/package.json"
printf '%s' '{"schema_version":"1.0","task_slug":"t1","verdict":"pass","checks":[{"id":"unit-tests","kind":"command","status":"pass","command":"npm test","summary":"tests passed"}]}' > "$D/.kontourai/flow-agents/t1/evidence.json"
# command-log.jsonl intentionally absent — the command was never actually run.

if FLOW_AGENTS_GOAL_FIT_MODE=block node "$GATE" >/dev/null 2>"$TMP/b3.err" <<JSON
{"hook_event_name":"Stop","cwd":"$D"}
JSON
then _fail "gate should BLOCK when trusted backstop re-run of declared manifest target fails"
else
  status=$?
  if [[ "$status" -eq 2 ]] && rg -q 'trusted backstop \(manifest\)' "$TMP/b3.err" && rg -q 'FAILED with exit 7' "$TMP/b3.err"; then
    _pass "gate runs trusted declared manifest target as backstop and blocks on its failure"
  else _fail "backstop did not catch declared-target failure: status=$status output=$(cat "$TMP/b3.err")"; fi
fi

# ============================================================================
# Part B4 — never-captured claim, no trusted command resolves → NOT_VERIFIED (never a silent pass)
# ============================================================================
echo "Part B4: never-captured claim, nothing trusted resolves → NOT_VERIFIED"
E="$TMP/notverified"; seed_repo "$E" t1
printf '%s' '{"schema_version":"1.0","task_slug":"t1","status":"in_progress","phase":"verification","updated_at":"2026-06-23T00:00:00Z","next_action":{"status":"continue","summary":"verify command evidence"}}' > "$E/.kontourai/flow-agents/t1/state.json"
printf '%s' '{"schema_version":"1.0","task_slug":"t1","verdict":"pass","checks":[{"id":"custom","kind":"command","status":"pass","command":"./my-thing.sh","summary":"ran custom"}]}' > "$E/.kontourai/flow-agents/t1/evidence.json"

if FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_RECHECK=false node "$GATE" >/dev/null 2>"$TMP/b4.err" <<JSON
{"hook_event_name":"Stop","cwd":"$E"}
JSON
then _fail "gate should not silently pass an un-captured, un-verifiable claimed-pass command"
else
  status=$?
  if [[ "$status" -eq 2 ]] && rg -q 'NOT_VERIFIED' "$TMP/b4.err" && rg -q 'no trusted command' "$TMP/b4.err"; then
    _pass "gate records NOT_VERIFIED (never a guess) when no trusted command resolves"
  else _fail "NOT_VERIFIED path returned unexpected result: status=$status output=$(cat "$TMP/b4.err")"; fi
fi

# ============================================================================
# Part B5 — arbitrary model command is opt-in only (FLOW_AGENTS_GOAL_FIT_RECHECK)
# ============================================================================
echo "Part B5: free-form model command re-run is opt-in only"
F="$TMP/recheck"; seed_repo "$F" t1
printf '%s' '{"schema_version":"1.0","task_slug":"t1","verdict":"pass","checks":[{"id":"custom","kind":"command","status":"pass","command":"exit 5","summary":"ran custom"}]}' > "$F/.kontourai/flow-agents/t1/evidence.json"
# Opt-in ON: the model's free-form "exit 5" is re-run and fails → block.
if FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_RECHECK=true node "$GATE" >/dev/null 2>"$TMP/b5.err" <<JSON
{"hook_event_name":"Stop","cwd":"$F"}
JSON
then _fail "with RECHECK=true the failing model command should block"
else
  status=$?
  if [[ "$status" -eq 2 ]] && rg -q 'FLOW_AGENTS_GOAL_FIT_RECHECK' "$TMP/b5.err"; then
    _pass "FLOW_AGENTS_GOAL_FIT_RECHECK=true opts into re-running the model's free-form command"
  else _fail "recheck opt-in path returned unexpected result: status=$status output=$(cat "$TMP/b5.err")"; fi
fi

if [[ "$errors" -eq 0 ]]; then
  echo "Evidence capture hook integration passed."
  exit 0
fi
echo "Evidence capture hook integration failed: $errors issue(s)."
exit 1
