#!/usr/bin/env bash
# test_goal_fit_escape_hatch.sh — block-mode escape hatch contract.
# Block mode must refuse the same goal-fit gap up to N times, then RELEASE
# (exit 0) so a genuinely-unsatisfiable goal cannot trap the agent forever.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

TMPDIR_EVAL="$(mktemp -d)"
errors=0
cleanup() { rm -rf "$TMPDIR_EVAL"; }
trap cleanup EXIT

_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

REPO="$TMPDIR_EVAL/repo"
mkdir -p "$REPO/.flow-agents/stuck"
printf '# Test Repo\n' > "$REPO/AGENTS.md"
printf '# Stuck\n\nbranch: main\nstatus: executing\ntype: deliver\n\n## Plan\n\nTBD.\n' \
  > "$REPO/.flow-agents/stuck/stuck--deliver.md"

PAYLOAD="{\"hook_event_name\":\"Stop\",\"cwd\":\"$REPO\"}"

run_block() {
  printf '%s' "$PAYLOAD" \
    | FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=3 \
      node "$ROOT/scripts/hooks/stop-goal-fit.js" >/dev/null 2>"$1"
  echo $?
}

c1=$(run_block "$TMPDIR_EVAL/b1.err")
c2=$(run_block "$TMPDIR_EVAL/b2.err")
c3=$(run_block "$TMPDIR_EVAL/b3.err")
c4=$(run_block "$TMPDIR_EVAL/b4.err")

[[ "$c1" -eq 2 ]] && rg -q 'BLOCK 1/3' "$TMPDIR_EVAL/b1.err" \
  && _pass "first identical block exits 2 (BLOCK 1/3)" \
  || _fail "first block should exit 2 BLOCK 1/3 (got $c1: $(cat "$TMPDIR_EVAL/b1.err"))"

[[ "$c2" -eq 2 ]] && rg -q 'BLOCK 2/3' "$TMPDIR_EVAL/b2.err" \
  && _pass "second identical block exits 2 (BLOCK 2/3)" \
  || _fail "second block should exit 2 BLOCK 2/3 (got $c2)"

[[ "$c3" -eq 0 ]] && rg -q 'RELEASED after 3 consecutive identical blocks' "$TMPDIR_EVAL/b3.err" \
  && _pass "third identical block RELEASES (exit 0, loud notice)" \
  || _fail "third block should release exit 0 (got $c3: $(cat "$TMPDIR_EVAL/b3.err"))"

[[ "$c4" -eq 2 ]] && rg -q 'BLOCK 1/3' "$TMPDIR_EVAL/b4.err" \
  && _pass "streak resets after release (next block is 1/3 again)" \
  || _fail "post-release block should reset to BLOCK 1/3 (got $c4)"

# A changing goal-fit gap must reset the streak (progress, not a stuck loop).
printf '%s' "$PAYLOAD" | FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=3 node "$ROOT/scripts/hooks/stop-goal-fit.js" >/dev/null 2>/dev/null
# mutate the artifact so the warning set differs
printf '# Stuck\n\nbranch: main\nstatus: verifying\ntype: deliver\n\n## Plan\n\nDifferent.\n' \
  > "$REPO/.flow-agents/stuck/stuck--deliver.md"
cd=$(run_block "$TMPDIR_EVAL/bd.err")
[[ "$cd" -eq 2 ]] && rg -q 'BLOCK 1/3' "$TMPDIR_EVAL/bd.err" \
  && _pass "changed goal-fit gap resets the streak to 1/3" \
  || _fail "changed gap should reset streak (got $cd: $(cat "$TMPDIR_EVAL/bd.err"))"

# warn mode never blocks regardless of streak
wc=$(printf '%s' "$PAYLOAD" | FLOW_AGENTS_GOAL_FIT_MODE=warn node "$ROOT/scripts/hooks/stop-goal-fit.js" >/dev/null 2>/dev/null; echo $?)
[[ "$wc" -eq 0 ]] && _pass "warn mode exits 0 (escape hatch irrelevant)" \
  || _fail "warn mode should exit 0 (got $wc)"

if [[ "$errors" -eq 0 ]]; then
  echo "Goal Fit escape hatch integration passed."
  exit 0
fi
echo "Goal Fit escape hatch integration failed: $errors issue(s)."
exit 1
