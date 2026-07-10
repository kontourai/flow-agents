#!/usr/bin/env bash
# test_assignment_provider_local_file.sh — AssignmentProvider local-file round-trip (#290).
#
# Fully deterministic: exercises `assignment-provider claim|status|supersede|release|list
# --provider local-file` against a temp artifact root and two fixed test-actor fixtures. No
# network, no `gh` process, no live provider. Follows test_pull_work_provider.sh's
# pass/fail/json_query idiom exactly.
#
# Supports AC5 (local-file round-trip), AC6 (list --actor), AC7 (concurrent claim never
# silently overwrites), AC9 (no live gh process — none invoked here at all).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI="$ROOT/build/src/cli.js"
FIXTURES="$ROOT/evals/fixtures/assignment-provider"
ACTOR_A="$FIXTURES/actor-a.json"
ACTOR_B="$FIXTURES/actor-b.json"
SUBJECT_ID="kontourai/flow-agents#9001"
BRANCH_A="agent/claude-code-eval-actor-a-session-eval-host/flow-agents-9001"
ARTIFACT_DIR_A=".kontourai/flow-agents/flow-agents-9001"

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

echo "=== AssignmentProvider: local-file round-trip ==="

# 1. claim writes the exact versioned record shape (Design Decision 2) for a fixed test actor.
node "$CLI" assignment-provider claim \
  --provider local-file --artifact-root "$ARTIFACT_ROOT" \
  --subject-id "$SUBJECT_ID" \
  --actor-json "$ACTOR_A" \
  --branch "$BRANCH_A" \
  --artifact-dir "$ARTIFACT_DIR_A" \
  --ttl-seconds 1800 \
  > "$TMPDIR_EVAL/claim-a.json"
status=$?
[[ "$status" -eq 0 ]] && pass "claim exits successfully" || fail "claim exits successfully"

[[ "$(json_query "$TMPDIR_EVAL/claim-a.json" "record.schema_version")" == "1.0" ]] && pass "claim record schema_version is 1.0" || fail "claim record schema_version is 1.0"
[[ "$(json_query "$TMPDIR_EVAL/claim-a.json" "record.role")" == "AssignmentClaimRecord" ]] && pass "claim record role is AssignmentClaimRecord" || fail "claim record role is AssignmentClaimRecord"
[[ "$(json_query "$TMPDIR_EVAL/claim-a.json" "record.subject_id")" == "$SUBJECT_ID" ]] && pass "claim record subject_id matches" || fail "claim record subject_id matches"
[[ "$(json_query "$TMPDIR_EVAL/claim-a.json" "record.actor.session_id")" == "eval-actor-a-session" ]] && pass "claim record actor matches fixed test actor A" || fail "claim record actor matches fixed test actor A"
[[ "$(json_query "$TMPDIR_EVAL/claim-a.json" "record.ttl_seconds")" == "1800" ]] && pass "claim record ttl_seconds matches" || fail "claim record ttl_seconds matches"
[[ "$(json_query "$TMPDIR_EVAL/claim-a.json" "record.branch")" == "$BRANCH_A" ]] && pass "claim record branch matches" || fail "claim record branch matches"
[[ "$(json_query "$TMPDIR_EVAL/claim-a.json" "record.artifact_dir")" == "$ARTIFACT_DIR_A" ]] && pass "claim record artifact_dir matches" || fail "claim record artifact_dir matches"
[[ "$(json_query "$TMPDIR_EVAL/claim-a.json" "record.status")" == "claimed" ]] && pass "claim record status is claimed" || fail "claim record status is claimed"
[[ "$(json_query "$TMPDIR_EVAL/claim-a.json" "record.audit_trail.0.transition")" == "claim" ]] && pass "claim record audit_trail records the claim transition" || fail "claim record audit_trail records the claim transition"

CLAIMED_AT="$(json_query "$TMPDIR_EVAL/claim-a.json" "record.claimed_at")"

# 2. status returns actor/claimedAt matching what claim wrote.
node "$CLI" assignment-provider status \
  --provider local-file --artifact-root "$ARTIFACT_ROOT" --subject-id "$SUBJECT_ID" \
  > "$TMPDIR_EVAL/status-a.json"
[[ "$(json_query "$TMPDIR_EVAL/status-a.json" "assignment.assignee")" == "claude-code:eval-actor-a-session:eval-host" ]] && pass "status reports actor A as assignee" || fail "status reports actor A as assignee"
[[ "$(json_query "$TMPDIR_EVAL/status-a.json" "assignment.record.claimed_at")" == "$CLAIMED_AT" ]] && pass "status claimed_at matches claim's claimed_at" || fail "status claimed_at matches claim's claimed_at"

# A generic same-actor refresh must preserve exact Builder provenance that an interrupted
# ensure-session recorded, even though the assignment-provider CLI does not accept that field.
PROVENANCE_SUBJECT="builder-provenance"
node "$CLI" assignment-provider claim \
  --provider local-file --artifact-root "$ARTIFACT_ROOT" \
  --subject-id "$PROVENANCE_SUBJECT" \
  --actor-json "$ACTOR_A" \
  --branch "$BRANCH_A" \
  --artifact-dir "$ARTIFACT_DIR_A" \
  --ttl-seconds 1800 \
  > "$TMPDIR_EVAL/provenance-claim.json"
PROVENANCE_FILE="$(node - "$ARTIFACT_ROOT/assignment" "$PROVENANCE_SUBJECT" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [dir, subject] = process.argv.slice(2);
for (const name of fs.readdirSync(dir)) {
  if (!name.endsWith('.json')) continue;
  const file = path.join(dir, name);
  if (JSON.parse(fs.readFileSync(file, 'utf8')).subject_id === subject) {
    process.stdout.write(file);
    process.exit(0);
  }
}
process.exit(1);
NODE
)"
node - "$PROVENANCE_FILE" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const record = JSON.parse(fs.readFileSync(file, 'utf8'));
record.work_item_ref = 'kontourai/flow-agents#9001';
fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
NODE
node "$CLI" assignment-provider claim \
  --provider local-file --artifact-root "$ARTIFACT_ROOT" \
  --subject-id "$PROVENANCE_SUBJECT" \
  --actor-json "$ACTOR_A" \
  --branch "$BRANCH_A" \
  --artifact-dir "$ARTIFACT_DIR_A" \
  --ttl-seconds 1800 \
  > "$TMPDIR_EVAL/provenance-refresh.json"
[[ "$(json_query "$TMPDIR_EVAL/provenance-refresh.json" "record.work_item_ref")" == "$SUBJECT_ID" ]] && pass "same-actor refresh preserves exact Work Item provenance" || fail "same-actor refresh preserves exact Work Item provenance"
node "$CLI" assignment-provider supersede \
  --provider local-file --artifact-root "$ARTIFACT_ROOT" \
  --subject-id "$PROVENANCE_SUBJECT" \
  --from-actor-json "$ACTOR_A" --to-actor-json "$ACTOR_B" \
  --reason "provenance handoff" >"$TMPDIR_EVAL/provenance-supersede.json"
[[ "$(json_query "$TMPDIR_EVAL/provenance-supersede.json" "record.work_item_ref")" == "$SUBJECT_ID" ]] && pass "generic supersede preserves exact Work Item provenance" || fail "generic supersede preserves exact Work Item provenance"
node "$CLI" assignment-provider release \
  --provider local-file --artifact-root "$ARTIFACT_ROOT" \
  --subject-id "$PROVENANCE_SUBJECT" \
  --actor-json "$ACTOR_B" \
  --reason "provenance fixture cleanup" >/dev/null

# 3. supersede A -> B updates the actor and records an audit trail entry.
node "$CLI" assignment-provider supersede \
  --provider local-file --artifact-root "$ARTIFACT_ROOT" --subject-id "$SUBJECT_ID" \
  --from-actor-json "$ACTOR_A" --to-actor-json "$ACTOR_B" --reason "handoff-eval" \
  > "$TMPDIR_EVAL/supersede.json"
status=$?
[[ "$status" -eq 0 ]] && pass "supersede exits successfully" || fail "supersede exits successfully"
[[ "$(json_query "$TMPDIR_EVAL/supersede.json" "record.actor.session_id")" == "eval-actor-b-session" ]] && pass "supersede updates the record's actor to B" || fail "supersede updates the record's actor to B"
[[ "$(json_query "$TMPDIR_EVAL/supersede.json" "record.audit_trail.length")" == "2" ]] && pass "supersede appends to the audit trail (claim + supersede)" || fail "supersede appends to the audit trail (claim + supersede)"
[[ "$(json_query "$TMPDIR_EVAL/supersede.json" "record.audit_trail.1.transition")" == "supersede" ]] && pass "audit trail records the supersede transition" || fail "audit trail records the supersede transition"
[[ "$(json_query "$TMPDIR_EVAL/supersede.json" "record.audit_trail.1.from_actor.session_id")" == "eval-actor-a-session" ]] && pass "audit trail supersede entry records from_actor A" || fail "audit trail supersede entry records from_actor A"
[[ "$(json_query "$TMPDIR_EVAL/supersede.json" "record.audit_trail.1.to_actor.session_id")" == "eval-actor-b-session" ]] && pass "audit trail supersede entry records to_actor B" || fail "audit trail supersede entry records to_actor B"
[[ "$(json_query "$TMPDIR_EVAL/supersede.json" "record.audit_trail.1.reason")" == "handoff-eval" ]] && pass "audit trail supersede entry records reason" || fail "audit trail supersede entry records reason"

node "$CLI" assignment-provider status \
  --provider local-file --artifact-root "$ARTIFACT_ROOT" --subject-id "$SUBJECT_ID" \
  > "$TMPDIR_EVAL/status-b.json"
[[ "$(json_query "$TMPDIR_EVAL/status-b.json" "assignment.assignee")" == "claude-code:eval-actor-b-session:eval-host" ]] && pass "status reports actor B after supersede" || fail "status reports actor B after supersede"

# 4. release clears the claim; subsequent status reports free.
node "$CLI" assignment-provider release \
  --provider local-file --artifact-root "$ARTIFACT_ROOT" --subject-id "$SUBJECT_ID" \
  --actor-json "$ACTOR_B" \
  > "$TMPDIR_EVAL/release.json"
status=$?
[[ "$status" -eq 0 ]] && pass "release exits successfully" || fail "release exits successfully"
[[ "$(json_query "$TMPDIR_EVAL/release.json" "record.status")" == "released" ]] && pass "release sets record status to released" || fail "release sets record status to released"

node "$CLI" assignment-provider status \
  --provider local-file --artifact-root "$ARTIFACT_ROOT" --subject-id "$SUBJECT_ID" \
  --liveness-events-json <(echo '[]') \
  > "$TMPDIR_EVAL/status-free.json"
[[ "$(json_query "$TMPDIR_EVAL/status-free.json" "assignment.assignee")" == "null" ]] && pass "status reports no assignee after release" || fail "status reports no assignee after release"
[[ "$(json_query "$TMPDIR_EVAL/status-free.json" "effective.effective_state")" == "free" ]] && pass "status reports effective_state free after release" || fail "status reports effective_state free after release"

# 5. list --actor returns exactly that actor's claimed subject ids (claim a second subject
#    under actor A, then verify list --actor A returns exactly that one subject).
SUBJECT_ID_2="kontourai/flow-agents#9002"
node "$CLI" assignment-provider claim \
  --provider local-file --artifact-root "$ARTIFACT_ROOT" \
  --subject-id "$SUBJECT_ID_2" \
  --actor-json "$ACTOR_A" \
  --branch "agent/claude-code-eval-actor-a-session-eval-host/flow-agents-9002" \
  --artifact-dir ".kontourai/flow-agents/flow-agents-9002" \
  > /dev/null
node "$CLI" assignment-provider list \
  --provider local-file --artifact-root "$ARTIFACT_ROOT" --actor-json "$ACTOR_A" \
  > "$TMPDIR_EVAL/list-a.json"
[[ "$(json_query "$TMPDIR_EVAL/list-a.json" "subject_ids.length")" == "1" ]] && pass "list --actor A returns exactly one subject id" || fail "list --actor A returns exactly one subject id"
[[ "$(json_query "$TMPDIR_EVAL/list-a.json" "subject_ids.0")" == "$SUBJECT_ID_2" ]] && pass "list --actor A returns actor A's currently-claimed subject (released subject excluded)" || fail "list --actor A returns actor A's currently-claimed subject (released subject excluded)"

node "$CLI" assignment-provider list \
  --provider local-file --artifact-root "$ARTIFACT_ROOT" --actor-json "$ACTOR_B" \
  > "$TMPDIR_EVAL/list-b.json"
[[ "$(json_query "$TMPDIR_EVAL/list-b.json" "subject_ids.length")" == "0" ]] && pass "list --actor B returns no subject ids (its only claim was released)" || fail "list --actor B returns no subject ids (its only claim was released)"

# 6. Two concurrent claims on the same subject from different actors: the second call must
#    fail loud (non-zero exit + holder-identifying error), never silently overwrite the first
#    (AC7; artifact-contract.md's "fail loud, never fail-open" persistence rule).
node "$CLI" assignment-provider claim \
  --provider local-file --artifact-root "$ARTIFACT_ROOT" \
  --subject-id "$SUBJECT_ID_2" \
  --actor-json "$ACTOR_B" \
  --branch "agent/claude-code-eval-actor-b-session-eval-host/flow-agents-9002" \
  --artifact-dir ".kontourai/flow-agents/flow-agents-9002" \
  > "$TMPDIR_EVAL/concurrent-claim.json" 2> "$TMPDIR_EVAL/concurrent-claim.err"
concurrent_status=$?
[[ "$concurrent_status" -ne 0 ]] && pass "second claim from a different actor fails loud (non-zero exit)" || fail "second claim from a different actor fails loud (non-zero exit)"
grep -q "already claimed by a different actor" "$TMPDIR_EVAL/concurrent-claim.err" && pass "second claim's error identifies the existing holder" || fail "second claim's error identifies the existing holder"

node "$CLI" assignment-provider status \
  --provider local-file --artifact-root "$ARTIFACT_ROOT" --subject-id "$SUBJECT_ID_2" \
  > "$TMPDIR_EVAL/status-after-concurrent.json"
[[ "$(json_query "$TMPDIR_EVAL/status-after-concurrent.json" "assignment.assignee")" == "claude-code:eval-actor-a-session:eval-host" ]] && pass "record still shows actor A as holder — no silent overwrite" || fail "record still shows actor A as holder — no silent overwrite"

# Same-actor re-claim (refresh before TTL expiry) is allowed and idempotent — must not error.
node "$CLI" assignment-provider claim \
  --provider local-file --artifact-root "$ARTIFACT_ROOT" \
  --subject-id "$SUBJECT_ID_2" \
  --actor-json "$ACTOR_A" \
  --branch "agent/claude-code-eval-actor-a-session-eval-host/flow-agents-9002" \
  --artifact-dir ".kontourai/flow-agents/flow-agents-9002" \
  > /dev/null 2>&1
[[ $? -eq 0 ]] && pass "same-actor re-claim (refresh) succeeds without error" || fail "same-actor re-claim (refresh) succeeds without error"

echo ""

# 7. F1 fix-plan iteration 1 (CRITICAL): GENUINE OS-process concurrency — two REAL,
#    concurrently-launched `claim` processes (background `&` + `wait`, not the sequential case in
#    section 6 above which never actually races) targeting the SAME fresh subject from DIFFERENT
#    actors. Before the withSubjectLock fix, both processes could read "no existing claim" before
#    either wrote, and one write would silently clobber the other (reproduced 29/40 races against
#    the built CLI pre-fix). Assert EXACTLY ONE process exits 0, and the on-disk record shows
#    exactly one holder with an intact, single-entry audit trail (no lost write).
SUBJECT_ID_RACE="kontourai/flow-agents#9003"
BRANCH_RACE_A="agent/claude-code-eval-actor-a-session-eval-host/flow-agents-9003"
BRANCH_RACE_B="agent/claude-code-eval-actor-b-session-eval-host/flow-agents-9003"
ARTIFACT_DIR_RACE=".kontourai/flow-agents/flow-agents-9003"

(
  node "$CLI" assignment-provider claim \
    --provider local-file --artifact-root "$ARTIFACT_ROOT" \
    --subject-id "$SUBJECT_ID_RACE" \
    --actor-json "$ACTOR_A" \
    --branch "$BRANCH_RACE_A" \
    --artifact-dir "$ARTIFACT_DIR_RACE" \
    > "$TMPDIR_EVAL/race-a.out" 2> "$TMPDIR_EVAL/race-a.err"
  echo $? > "$TMPDIR_EVAL/race-a.rc"
) &
PID_A=$!
(
  node "$CLI" assignment-provider claim \
    --provider local-file --artifact-root "$ARTIFACT_ROOT" \
    --subject-id "$SUBJECT_ID_RACE" \
    --actor-json "$ACTOR_B" \
    --branch "$BRANCH_RACE_B" \
    --artifact-dir "$ARTIFACT_DIR_RACE" \
    > "$TMPDIR_EVAL/race-b.out" 2> "$TMPDIR_EVAL/race-b.err"
  echo $? > "$TMPDIR_EVAL/race-b.rc"
) &
PID_B=$!
wait "$PID_A" "$PID_B"

RACE_RC_A="$(cat "$TMPDIR_EVAL/race-a.rc")"
RACE_RC_B="$(cat "$TMPDIR_EVAL/race-b.rc")"

if { [[ "$RACE_RC_A" -eq 0 && "$RACE_RC_B" -ne 0 ]] || [[ "$RACE_RC_A" -ne 0 && "$RACE_RC_B" -eq 0 ]]; }; then
  pass "genuine concurrent claim race: exactly one process wins (rc_a=$RACE_RC_A rc_b=$RACE_RC_B)"
else
  fail "genuine concurrent claim race: exactly one process wins (rc_a=$RACE_RC_A rc_b=$RACE_RC_B)"
fi

node "$CLI" assignment-provider status \
  --provider local-file --artifact-root "$ARTIFACT_ROOT" --subject-id "$SUBJECT_ID_RACE" \
  > "$TMPDIR_EVAL/status-race.json"
[[ "$(json_query "$TMPDIR_EVAL/status-race.json" "assignment.record.audit_trail.length")" == "1" ]] && pass "race winner's on-disk record has exactly one audit_trail entry (no lost/merged write)" || fail "race winner's on-disk record has exactly one audit_trail entry (no lost/merged write)"

if [[ "$RACE_RC_A" -eq 0 ]]; then
  EXPECTED_RACE_HOLDER="claude-code:eval-actor-a-session:eval-host"
else
  EXPECTED_RACE_HOLDER="claude-code:eval-actor-b-session:eval-host"
fi
[[ "$(json_query "$TMPDIR_EVAL/status-race.json" "assignment.assignee")" == "$EXPECTED_RACE_HOLDER" ]] && pass "on-disk record holder matches the process that actually exited 0 (no silent overwrite by the loser)" || fail "on-disk record holder matches the process that actually exited 0 (no silent overwrite by the loser)"

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "test_assignment_provider_local_file: all checks passed."
else
  echo "test_assignment_provider_local_file: $errors check(s) failed."
fi
exit "$errors"
