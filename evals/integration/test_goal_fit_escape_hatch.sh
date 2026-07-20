#!/usr/bin/env bash
# test_goal_fit_escape_hatch.sh — block-mode escape hatch contract.
# Block mode must refuse the same goal-fit gap up to N times, then RELEASE
# (exit 0) so a genuinely-unsatisfiable goal cannot trap the agent forever.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CURRENT_POINTER_HELPER="$ROOT/scripts/hooks/lib/current-pointer.js"

TMPDIR_EVAL="$(mktemp -d)"
errors=0
cleanup() { rm -rf "$TMPDIR_EVAL"; }
trap cleanup EXIT

_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

REPO="$TMPDIR_EVAL/repo"
mkdir -p "$REPO/.kontourai/flow-agents/stuck"
printf '# Test Repo\n' > "$REPO/AGENTS.md"
printf '# Stuck\n\nbranch: main\nstatus: executing\ntype: deliver\n\n## Plan\n\nTBD.\n' \
  > "$REPO/.kontourai/flow-agents/stuck/stuck--deliver.md"

PAYLOAD="{\"hook_event_name\":\"Stop\",\"cwd\":\"$REPO\"}"

# This is deliberately a legacy unresolved-actor fixture: its assertions exercise the
# global-current-pointer fallback. Pin that test-only identity state for every hook
# process so a Codex/Claude/CI/explicit/ancestry identity inherited from the wrapper
# cannot turn this into a resolved actor with no owned pointer (#440).
run_legacy_unresolved_hook() {
  NODE_ENV=test FLOW_AGENTS_ACTOR_TEST_FORCE_UNRESOLVED=1 \
    node "$ROOT/scripts/hooks/stop-goal-fit.js"
}

run_block() {
  printf '%s' "$PAYLOAD" \
    | FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=3 \
      run_legacy_unresolved_hook >/dev/null 2>"$1"
  echo $?
}

c1=$(run_block "$TMPDIR_EVAL/b1.err")
c2=$(run_block "$TMPDIR_EVAL/b2.err")
c3=$(run_block "$TMPDIR_EVAL/b3.err")
c4=$(run_block "$TMPDIR_EVAL/b4.err")

[[ "$c1" -eq 2 ]] && rg -q 'Stop blocked .* \(block 1; after 3 identical blocks' "$TMPDIR_EVAL/b1.err" \
  && _pass "first identical block exits 2 (block 1; after 3 identical blocks)" \
  || _fail "first block should exit 2, block 1/3 shape (got $c1: $(cat "$TMPDIR_EVAL/b1.err"))"

[[ "$c2" -eq 2 ]] && rg -q 'Stop blocked .* \(block 2; after 3 identical blocks' "$TMPDIR_EVAL/b2.err" \
  && _pass "second identical block exits 2 (block 2; after 3 identical blocks)" \
  || _fail "second block should exit 2, block 2/3 shape (got $c2)"

[[ "$c3" -eq 0 ]] && rg -q 'released — the same gap\(s\) blocked 3x without progress' "$TMPDIR_EVAL/b3.err" \
  && _pass "third identical block RELEASES (exit 0, loud notice)" \
  || _fail "third block should release exit 0 (got $c3: $(cat "$TMPDIR_EVAL/b3.err"))"

[[ "$c4" -eq 2 ]] && rg -q 'Stop blocked .* \(block 1; after 3 identical blocks' "$TMPDIR_EVAL/b4.err" \
  && _pass "streak resets after release (next block is 1/3 again)" \
  || _fail "post-release block should reset to block 1/3 shape (got $c4)"

# A changing goal-fit gap must reset the streak (progress, not a stuck loop).
printf '%s' "$PAYLOAD" | FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=3 run_legacy_unresolved_hook >/dev/null 2>/dev/null
# mutate the artifact so the warning set differs
printf '# Stuck\n\nbranch: main\nstatus: verifying\ntype: deliver\n\n## Plan\n\nDifferent.\n' \
  > "$REPO/.kontourai/flow-agents/stuck/stuck--deliver.md"
cd=$(run_block "$TMPDIR_EVAL/bd.err")
[[ "$cd" -eq 2 ]] && rg -q 'Stop blocked .* \(block 1; after 3 identical blocks' "$TMPDIR_EVAL/bd.err" \
  && _pass "changed goal-fit gap resets the streak to 1/3" \
  || _fail "changed gap should reset streak (got $cd: $(cat "$TMPDIR_EVAL/bd.err"))"

# warn mode never blocks regardless of streak
wc=$(printf '%s' "$PAYLOAD" | FLOW_AGENTS_GOAL_FIT_MODE=warn run_legacy_unresolved_hook >/dev/null 2>/dev/null; echo $?)
[[ "$wc" -eq 0 ]] && _pass "warn mode exits 0 (escape hatch irrelevant)" \
  || _fail "warn mode should exit 0 (got $wc)"

# A resolved actor must never be gated by another actor's globally-current session.
# Seed the legacy pointer AND the foreign actor's own pointer so a regression to global
# fallback would block this intentionally incomplete session. The acting actor has no
# per-actor pointer and must receive the #440 informational-only outcome instead.
ISOLATION_REPO="$TMPDIR_EVAL/actor-isolation-repo"
ISOLATION_SLUG="foreign-stuck"
ISOLATION_ACTOR="goal-fit-isolation-actor"
FOREIGN_ACTOR="goal-fit-foreign-actor"
mkdir -p "$ISOLATION_REPO/.kontourai/flow-agents/$ISOLATION_SLUG"
printf '# Test Repo\n' > "$ISOLATION_REPO/AGENTS.md"
printf '# Foreign Stuck\n\nbranch: main\nstatus: executing\ntype: deliver\n\n## Plan\n\nTBD.\n' \
  > "$ISOLATION_REPO/.kontourai/flow-agents/$ISOLATION_SLUG/$ISOLATION_SLUG--deliver.md"

if CP_HELPER_ARG="$CURRENT_POINTER_HELPER" FLOW_AGENTS_DIR_ARG="$ISOLATION_REPO/.kontourai/flow-agents" \
  SLUG_ARG="$ISOLATION_SLUG" ACTOR_KEY_ARG="$FOREIGN_ACTOR" node - <<'NODE' 2>"$TMPDIR_EVAL/isolation-seed.err"
const fs = require('node:fs');
const path = require('node:path');
const { writePerActorCurrent } = require(process.env.CP_HELPER_ARG);
const flowAgentsDir = process.env.FLOW_AGENTS_DIR_ARG;
const payload = { active_slug: process.env.SLUG_ARG, artifact_dir: process.env.SLUG_ARG };
fs.writeFileSync(path.join(flowAgentsDir, 'current.json'), `${JSON.stringify(payload)}\n`);
writePerActorCurrent(flowAgentsDir, process.env.ACTOR_KEY_ARG, payload);
NODE
then
  :
else
  _fail "could not seed the foreign actor's current-pointer fixture: $(cat \"$TMPDIR_EVAL/isolation-seed.err\")"
fi

ISOLATION_PAYLOAD="{\"hook_event_name\":\"Stop\",\"cwd\":\"$ISOLATION_REPO\"}"
isolation_status=$(printf '%s' "$ISOLATION_PAYLOAD" \
  | env -u NODE_ENV -u FLOW_AGENTS_ACTOR_TEST_FORCE_UNRESOLVED \
      FLOW_AGENTS_ACTOR="$ISOLATION_ACTOR" FLOW_AGENTS_GOAL_FIT_MODE=block \
      node "$ROOT/scripts/hooks/stop-goal-fit.js" >/dev/null 2>"$TMPDIR_EVAL/isolation.err"; echo $?)
[[ "$isolation_status" -eq 0 ]] \
  && rg -q "no per-actor current-pointer for actor \"$ISOLATION_ACTOR\"" "$TMPDIR_EVAL/isolation.err" \
  && ! rg -q 'Stop blocked' "$TMPDIR_EVAL/isolation.err" \
  && _pass "resolved actor ignores another actor's current session without its own pointer" \
  || _fail "actor isolation should ignore the foreign session (got $isolation_status: $(cat "$TMPDIR_EVAL/isolation.err"))"

if [[ "$errors" -eq 0 ]]; then
  echo "Goal Fit escape hatch integration passed."
  exit 0
fi
echo "Goal Fit escape hatch integration failed: $errors issue(s)."
exit 1
