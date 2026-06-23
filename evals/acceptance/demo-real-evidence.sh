#!/usr/bin/env bash
# demo-real-evidence.sh — the convincing version of the false-completion demo.
#
# Instead of a hand-seeded "fail", the evidence comes from ACTUALLY RUNNING a real
# test suite. We show the goal-fit gate is bound to reality:
#   - real tests FAIL  -> agent's "done" is BLOCKED   (can't ship a false completion)
#   - real tests PASS  -> agent's "done" is ALLOWED   (gate clears when work is genuinely done)
#
# Same gate, opposite outcomes, driven only by the real test result. Deterministic,
# no model spend. Runs the installed Stop hook for BOTH Claude Code and Codex.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pass=0; fail=0
_p(){ echo "  ✓ $1"; pass=$((pass+1)); }
_f(){ echo "  ✗ $1"; fail=$((fail+1)); }

# This harness invokes the Stop hook several times against the same state as
# independent checks (not a real agent loop), so disable the block escape hatch.
export FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=100000

echo "Building bundles..."; (cd "$ROOT" && npm run build:bundles >/dev/null 2>&1) || { echo "build failed"; exit 1; }

# ---- a real (tiny) project with a real, runnable test suite ----
PROJ="$(mktemp -d)"
printf '# Calc service\n' > "$PROJ/AGENTS.md"
mkdir -p "$PROJ/.flow-agents/calc"
# BUGGY implementation: multiply is wrong
cat > "$PROJ/calculator.js" <<'JS'
const add = (a, b) => a + b;
const multiply = (a, b) => a + b;   // BUG: should be a * b
module.exports = { add, multiply };
JS
cat > "$PROJ/calculator.test.js" <<'JS'
const { add, multiply } = require('./calculator');
let failed = 0;
const check = (name, got, want) => {
  if (got !== want) { console.error(`FAIL ${name}: got ${got}, want ${want}`); failed++; }
  else { console.log(`ok ${name}`); }
};
check('add(2,3)', add(2, 3), 5);
check('multiply(2,3)', multiply(2, 3), 6);
process.exit(failed ? 1 : 0);
JS
# the delivery artifact claims the work is done
cat > "$PROJ/.flow-agents/calc/calc--deliver.md" <<'MD'
# Implement calculator

status: executing
type: deliver

## Definition Of Done
- [x] add and multiply implemented and all tests pass

## Goal Fit Gate
- [x] acceptance criteria verified

### Verdict: PASS
MD
printf '%s' '{"schema_version":"1.0","task_slug":"calc","status":"in_progress","phase":"verification","updated_at":"2026-06-18T00:00:00Z","next_action":{"status":"continue","summary":"Make all calculator tests pass."}}' > "$PROJ/.flow-agents/calc/state.json"

# ---- the verify step: run the REAL tests, write evidence.json from the REAL result ----
run_verify(){
  local verdict status summary
  if node "$PROJ/calculator.test.js" > "$PROJ/test.out" 2>&1; then verdict=pass; status=pass; else verdict=fail; status=fail; fi
  summary="$(grep -E '^(FAIL|ok) ' "$PROJ/test.out" | tr '\n' ';' | sed 's/"/ /g')"
  printf '{"schema_version":"1.0","task_slug":"calc","verdict":"%s","checks":[{"id":"calc-tests","kind":"test","status":"%s","summary":"%s"}]}' \
    "$verdict" "$status" "$summary" > "$PROJ/.flow-agents/calc/evidence.json"
  echo "$verdict"
}

# ---- invoke the installed Stop hook for a runtime, return exit code ----
WC="$(mktemp -d)"; bash "$ROOT/dist/claude-code/install.sh" "$WC" >/dev/null 2>&1   # claude scripts+config
CXH="$(mktemp -d)"; bash "$ROOT/dist/codex/install.sh" "$CXH" >/dev/null 2>&1        # codex scripts
stop_claude(){ printf '{"hook_event_name":"Stop","cwd":"%s"}' "$PROJ" | FLOW_AGENTS_GOAL_FIT_MODE=block CLAUDE_PROJECT_DIR="$WC" node "$WC/scripts/hooks/claude-hook-adapter.js" Stop stop-goal-fit stop-goal-fit.js default 2>/dev/null; }
stop_codex(){  printf '{"hook_event_name":"Stop","cwd":"%s"}' "$PROJ" | FLOW_AGENTS_GOAL_FIT_MODE=block CODEX_HOME="$CXH" node "$CXH/scripts/hooks/codex-hook-adapter.js" stop-goal-fit stop-goal-fit.js default 2>/dev/null; }
is_block(){ grep -q '"decision":"block"'; }

echo ""
echo "════ PHASE 1: real tests FAIL (multiply is buggy) ════"
v="$(run_verify)"; echo "  verify ran the real suite -> verdict: $v"
[ "$v" = "fail" ] && _p "real test suite genuinely fails (multiply 2*3 returns 5)" || _f "expected real tests to fail, got $v"
stop_claude | is_block && _p "Claude Code BLOCKS 'done' while real tests fail" || _f "Claude did not block on real failure"
stop_codex  | is_block && _p "Codex BLOCKS 'done' while real tests fail" || _f "Codex did not block on real failure"
echo "  refusal the agent receives:"
printf '{"hook_event_name":"Stop","cwd":"%s"}' "$PROJ" | FLOW_AGENTS_GOAL_FIT_MODE=block node "$ROOT/scripts/hooks/stop-goal-fit.js" >/dev/null 2>/tmp/calc-block.txt
sed 's/^/    /' /tmp/calc-block.txt

echo ""
echo "════ PHASE 2: fix the bug, real tests PASS, task genuinely complete ════"
# 1) actually fix the implementation
sed -i.bak 's#const multiply = (a, b) => a + b;.*#const multiply = (a, b) => a * b;#' "$PROJ/calculator.js"; rm -f "$PROJ/calculator.js.bak"
# 2) the workflow state reflects real completion (as the deliver step would after verify passes)
sed -i.bak 's/^status: executing/status: delivered/' "$PROJ/.flow-agents/calc/calc--deliver.md"; rm -f "$PROJ/.flow-agents/calc/calc--deliver.md.bak"
printf '%s' '{"schema_version":"1.0","task_slug":"calc","status":"delivered","phase":"done","updated_at":"2026-06-18T00:00:00Z","next_action":{"status":"done","summary":"Calculator implemented; all tests pass."}}' > "$PROJ/.flow-agents/calc/state.json"
v="$(run_verify)"; echo "  verify re-ran the real suite -> verdict: $v"
[ "$v" = "pass" ] && _p "real test suite genuinely passes after the fix" || _f "expected real tests to pass, got $v"
stop_claude | is_block && _f "Claude still blocked after real tests pass" || _p "Claude Code ALLOWS 'done' once real tests pass (gate cleared)"
stop_codex  | is_block && _f "Codex still blocked after real tests pass" || _p "Codex ALLOWS 'done' once real tests pass (gate cleared)"

echo ""
echo "──────────────────────────────────"
echo "demo-real-evidence: $pass passed, $fail failed"
[ "$fail" -eq 0 ] && echo "PROOF: the goal-fit gate is bound to REAL test results — blocks a false 'done', clears when the work is genuinely done, on both runtimes." || true
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
