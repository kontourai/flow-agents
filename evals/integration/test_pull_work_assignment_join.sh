#!/usr/bin/env bash
# test_pull_work_assignment_join.sh — Two-session disjoint-selection simulation (#290).
#
# HONESTY NOTE (plan Design Decision / Stop-Short Risks): this eval simulates the assignment ⋈
# liveness join's exclusion property with two actor structs evaluating the same candidate
# subject id fixture in sequence, inside ONE process. It does NOT stand up two real concurrent
# agent runtimes, and does not prove true concurrency (a real race between two simultaneous
# writers). It is the closest *local* proof available for the issue's literal acceptance line
# ("two sessions running pull-work against the same backlog select disjoint issues") without a
# multi-runtime test harness this repo does not have — see the plan's Stop-Short Risks section.
# What IS proven here, deterministically: once session A's assignment claim is recorded (local-
# file or a rendered-then-status-confirmed GitHub fixture), session B's subsequent
# `assignment-provider status` / join check for the SAME subject reports it `held` (excluded),
# never `free` — so `pull-work`'s selection loop (kits/builder/skills/pull-work/SKILL.md,
# "### 1. Read Board State") would skip it for session B.
#
# Supports AC12 (disjoint-selection-simulated), AC10 (docs pointer — see
# docs/workflow-usage-guide.md's new Assignment Ownership subsection).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI="$ROOT/build/src/cli.js"
FIXTURES="$ROOT/evals/fixtures/assignment-provider"
ACTOR_A="$FIXTURES/actor-a.json"
ACTOR_B="$FIXTURES/actor-b.json"
ISSUE_CLAIMED="$FIXTURES/github-issue-claimed.json"
LIVENESS_FRESH="$FIXTURES/liveness-fresh.json"

TMPDIR_EVAL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_EVAL"' EXIT
ARTIFACT_ROOT="$TMPDIR_EVAL/artifact-root"

errors=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

json_query() {
  node -e 'const fs=require("fs"); let cur=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); for (const part of process.argv[2].split(".")) cur=part==="length" ? cur.length : (Array.isArray(cur) ? cur[Number(part)] : cur[part]); console.log(cur);' "$1" "$2"
}

if [[ ! -f "$CLI" ]]; then
  echo "build/src/cli.js not found — run 'npm run build' first" >&2
  exit 1
fi

echo "=== Two-session disjoint-selection simulation (assignment ⋈ liveness join) ==="

EMPTY_LIVENESS="$TMPDIR_EVAL/liveness-empty.json"
echo '[]' > "$EMPTY_LIVENESS"

# --- local-file leg: session A claims, session B's join check on the same subject is excluded ---

SUBJECT_ID="kontourai/flow-agents#9301"

# "Session A" (actor A) evaluates the candidate subject before anyone has claimed it: free.
node "$CLI" assignment-provider status \
  --provider local-file --artifact-root "$ARTIFACT_ROOT" --subject-id "$SUBJECT_ID" \
  --self-actor "claude-code:eval-actor-a-session:eval-host" --liveness-events-json "$EMPTY_LIVENESS" \
  > "$TMPDIR_EVAL/session-a-preclaim.json"
[[ "$(json_query "$TMPDIR_EVAL/session-a-preclaim.json" "effective.effective_state")" == "free" ]] && pass "local-file: candidate subject is free before either session claims" || fail "local-file: candidate subject is free before either session claims"

# Session A selects and claims it (pull-work's "Assignment Claim On Selection" step).
node "$CLI" assignment-provider claim \
  --provider local-file --artifact-root "$ARTIFACT_ROOT" --subject-id "$SUBJECT_ID" \
  --actor-json "$ACTOR_A" --branch "agent/claude-code-eval-actor-a-session-eval-host/flow-agents-9301" \
  --artifact-dir ".kontourai/flow-agents/flow-agents-9301" > /dev/null
status=$?
[[ "$status" -eq 0 ]] && pass "local-file: session A's claim on the candidate subject succeeds" || fail "local-file: session A's claim on the candidate subject succeeds"

# "Session B" (actor B, a distinct actor struct — the second concurrent pull-work session)
# evaluates the SAME candidate subject next. Its own liveness heartbeat is fresh (it is alive),
# but that must not matter: the join is computed against the HOLDER's freshness, not the
# reader's — session B must see the subject excluded.
NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "$TMPDIR_EVAL/liveness-actor-a-fresh.json" <<JSON
[
  {"type":"claim","subjectId":"$SUBJECT_ID","actor":"claude-code:eval-actor-a-session:eval-host","at":"$NOW_ISO","ttlSeconds":1800}
]
JSON
node "$CLI" assignment-provider status \
  --provider local-file --artifact-root "$ARTIFACT_ROOT" --subject-id "$SUBJECT_ID" \
  --self-actor "claude-code:eval-actor-b-session:eval-host" \
  --liveness-events-json "$TMPDIR_EVAL/liveness-actor-a-fresh.json" > "$TMPDIR_EVAL/session-b-postclaim.json"
[[ "$(json_query "$TMPDIR_EVAL/session-b-postclaim.json" "assignment.assignee")" == "claude-code:eval-actor-a-session:eval-host" ]] && pass "local-file: session B's status read shows actor A as the holder" || fail "local-file: session B's status read shows actor A as the holder"
[[ "$(json_query "$TMPDIR_EVAL/session-b-postclaim.json" "effective.effective_state")" == "held" ]] && pass "local-file: session B's join check reports held (excluded) for the same subject session A just claimed" || fail "local-file: session B's join check reports held (excluded) for the same subject session A just claimed"
[[ "$(json_query "$TMPDIR_EVAL/session-b-postclaim.json" "effective.effective_state")" != "free" ]] && pass "local-file: subject is definitively NOT free for session B (disjoint selection holds)" || fail "local-file: subject is definitively NOT free for session B (disjoint selection holds)"

# Session B, correctly excluding the held subject, selects a DIFFERENT subject instead — the
# literal "select disjoint issues" property, one selection loop iteration at a time.
SUBJECT_ID_2="kontourai/flow-agents#9302"
node "$CLI" assignment-provider status \
  --provider local-file --artifact-root "$ARTIFACT_ROOT" --subject-id "$SUBJECT_ID_2" \
  --self-actor "claude-code:eval-actor-b-session:eval-host" --liveness-events-json "$EMPTY_LIVENESS" \
  > "$TMPDIR_EVAL/session-b-alternate.json"
[[ "$(json_query "$TMPDIR_EVAL/session-b-alternate.json" "effective.effective_state")" == "free" ]] && pass "local-file: session B's alternate candidate is free — it can select a disjoint subject" || fail "local-file: session B's alternate candidate is free — it can select a disjoint subject"
node "$CLI" assignment-provider claim \
  --provider local-file --artifact-root "$ARTIFACT_ROOT" --subject-id "$SUBJECT_ID_2" \
  --actor-json "$ACTOR_B" --branch "agent/claude-code-eval-actor-b-session-eval-host/flow-agents-9302" \
  --artifact-dir ".kontourai/flow-agents/flow-agents-9302" > /dev/null
[[ $? -eq 0 ]] && pass "local-file: session B claims the disjoint subject successfully" || fail "local-file: session B claims the disjoint subject successfully"

# Final proof: the two sessions' claimed subject sets are disjoint.
node "$CLI" assignment-provider list --provider local-file --artifact-root "$ARTIFACT_ROOT" --actor-json "$ACTOR_A" > "$TMPDIR_EVAL/list-a.json"
node "$CLI" assignment-provider list --provider local-file --artifact-root "$ARTIFACT_ROOT" --actor-json "$ACTOR_B" > "$TMPDIR_EVAL/list-b.json"
DISJOINT="$(node -e '
const fs = require("fs");
const a = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).subject_ids;
const b = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).subject_ids;
const overlap = a.filter((id) => b.includes(id));
console.log(overlap.length === 0 && a.length === 1 && b.length === 1 ? "yes" : "no");
' "$TMPDIR_EVAL/list-a.json" "$TMPDIR_EVAL/list-b.json")"
[[ "$DISJOINT" == "yes" ]] && pass "session A and session B's claimed subject sets are disjoint (one each, no overlap)" || fail "session A and session B's claimed subject sets are disjoint (one each, no overlap)"

# --- GitHub leg: a rendered-and-status-confirmed claim on a fixture also excludes a second reader ---

# The already-claimed GitHub fixture stands in for "session A already claimed and the render
# was executed + status-confirmed" (SKILL.md's "Assignment Claim On Selection" round trip).
# "Session B" reads the SAME fixture next with a fresh liveness fixture for the holder: held.
node "$CLI" assignment-provider status --provider github --issue-json "$ISSUE_CLAIMED" \
  --self-actor "claude-code:eval-actor-b-session:eval-host" \
  --liveness-events-json "$LIVENESS_FRESH" --now "2026-06-01T12:20:00Z" \
  > "$TMPDIR_EVAL/github-session-b.json"
[[ "$(json_query "$TMPDIR_EVAL/github-session-b.json" "effective.effective_state")" == "held" ]] && pass "github: session B's join check on an already-claimed fixture issue reports held (excluded)" || fail "github: session B's join check on an already-claimed fixture issue reports held (excluded)"
[[ "$(json_query "$TMPDIR_EVAL/github-session-b.json" "effective.effective_state")" != "free" ]] && pass "github: subject is definitively NOT free for session B" || fail "github: subject is definitively NOT free for session B"

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "test_pull_work_assignment_join: all checks passed."
else
  echo "test_pull_work_assignment_join: $errors check(s) failed."
fi
exit "$errors"
