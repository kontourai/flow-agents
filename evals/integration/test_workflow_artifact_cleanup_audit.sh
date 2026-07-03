#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="workflow-artifact-cleanup-audit"
TMPDIR_EVAL="$(mktemp -d)"
ARTIFACT_ROOT="$TMPDIR_EVAL/flow-agents"
trap 'rm -rf "$TMPDIR_EVAL"' EXIT

source "$ROOT/evals/lib/node.sh"

errors=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

mkdir -p "$ARTIFACT_ROOT"/{active-wip,terminal-done,stale-verified,learning-followup,delivered-learning-followup,invalid-learning-route,invalid-sidecar,symlink-state,large-learning,missing-state-next-action,missing-learning-records,non-array-learning-records,changes,archive,liveness,.hidden}

cat > "$ARTIFACT_ROOT/liveness/events.jsonl" <<'JSONL'
{"type":"claim","subjectId":"active-wip","actor":"agent-1","at":"2026-06-01T00:00:00Z"}
JSONL

cat > "$ARTIFACT_ROOT/active-wip/state.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "active-wip",
  "status": "in_progress",
  "phase": "execution",
  "updated_at": "2026-06-01T00:00:00Z",
  "next_action": { "status": "continue", "summary": "keep working" }
}
JSON

cat > "$ARTIFACT_ROOT/terminal-done/state.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "terminal-done",
  "status": "accepted",
  "phase": "done",
  "updated_at": "2026-06-01T00:00:00Z",
  "next_action": { "status": "done", "summary": "accepted" }
}
JSON

# Promote-then-archive gate (issue #312): a delivered/accepted session stays terminal_done
# ONLY when its trust.bundle carries a promotion claim (claim.metadata.promotion). Without
# this, terminal-done would (correctly) reclassify as a cleanup_candidate. See the dedicated
# WITHOUT-claim coverage in test_promote_gate.sh.
cat > "$ARTIFACT_ROOT/terminal-done/trust.bundle" <<'JSON'
{ "schemaVersion": 5, "claims": [ { "id": "smoke-promotion.flow-agents-workflow.promoted", "claimType": "workflow.check.policy", "status": "verified", "metadata": { "promotion": { "schema_version": "1.0", "none": false, "targets": ["docs/decisions/promotion-gate.md"], "promoted_at": "2026-06-01T00:00:00Z" } } } ], "evidence": [], "policies": [], "events": [] }
JSON

cat > "$ARTIFACT_ROOT/stale-verified/state.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "stale-verified",
  "status": "verified",
  "phase": "verification",
  "updated_at": "2026-06-01T00:00:00Z",
  "next_action": { "status": "done", "summary": "ready for cleanup" }
}
JSON

cat > "$ARTIFACT_ROOT/learning-followup/state.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "learning-followup",
  "status": "accepted",
  "phase": "learning",
  "updated_at": "2026-06-01T00:00:00Z",
  "next_action": { "status": "done", "summary": "accepted with learning" }
}
JSON

cat > "$ARTIFACT_ROOT/learning-followup/learning.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "learning-followup",
  "status": "followup_required",
  "updated_at": "2026-06-01T00:00:00Z",
  "records": [
    {
      "id": "learn-1",
      "recorded_at": "2026-06-01T00:00:00Z",
      "source_refs": ["verification"],
      "outcome": "mixed",
      "facts": ["Open follow-up remains."],
      "interpretation": "Route this learning before cleanup.",
      "routing": [
        { "target": "doc", "action": "Document lifecycle command.", "status": "open" }
      ]
    }
  ]
}
JSON

cat > "$ARTIFACT_ROOT/delivered-learning-followup/state.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "delivered-learning-followup",
  "status": "delivered",
  "phase": "done",
  "updated_at": "2026-06-01T00:00:00Z",
  "next_action": { "status": "done", "summary": "delivered with unresolved learning" }
}
JSON

cat > "$ARTIFACT_ROOT/delivered-learning-followup/learning.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "delivered-learning-followup",
  "status": "followup_required",
  "updated_at": "2026-06-01T00:00:00Z",
  "records": [
    {
      "id": "learn-delivered",
      "recorded_at": "2026-06-01T00:00:00Z",
      "source_refs": ["release"],
      "outcome": "mixed",
      "facts": ["Delivered work still has an open learning route."],
      "interpretation": "Open learning must win over terminal lifecycle shape.",
      "routing": [
        { "target": "skill", "action": "Update workflow guidance.", "status": "open" }
      ]
    }
  ]
}
JSON

cat > "$ARTIFACT_ROOT/invalid-learning-route/state.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "invalid-learning-route",
  "status": "accepted",
  "phase": "done",
  "updated_at": "2026-06-01T00:00:00Z",
  "next_action": { "status": "done", "summary": "accepted with malformed learning routing" }
}
JSON

cat > "$ARTIFACT_ROOT/invalid-learning-route/learning.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "invalid-learning-route",
  "status": "learned",
  "updated_at": "2026-06-01T00:00:00Z",
  "records": [
    {
      "id": "learn-invalid-route",
      "recorded_at": "2026-06-01T00:00:00Z",
      "source_refs": ["review"],
      "outcome": "unknown",
      "facts": ["A routing entry is missing required status."],
      "interpretation": "Malformed learning routing must make the workflow invalid.",
      "routing": [
        { "target": "doc", "action": "Document missing status handling." }
      ]
    }
  ]
}
JSON

cat > "$ARTIFACT_ROOT/missing-state-next-action/state.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "missing-state-next-action",
  "status": "accepted",
  "phase": "done",
  "updated_at": "2026-06-01T00:00:00Z"
}
JSON

cat > "$ARTIFACT_ROOT/missing-learning-records/state.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "missing-learning-records",
  "status": "accepted",
  "phase": "done",
  "updated_at": "2026-06-01T00:00:00Z",
  "next_action": { "status": "done", "summary": "accepted with malformed learning" }
}
JSON

cat > "$ARTIFACT_ROOT/missing-learning-records/learning.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "missing-learning-records",
  "status": "learned",
  "updated_at": "2026-06-01T00:00:00Z"
}
JSON

cat > "$ARTIFACT_ROOT/non-array-learning-records/state.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "non-array-learning-records",
  "status": "accepted",
  "phase": "done",
  "updated_at": "2026-06-01T00:00:00Z",
  "next_action": { "status": "done", "summary": "accepted with malformed learning" }
}
JSON

cat > "$ARTIFACT_ROOT/non-array-learning-records/learning.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "non-array-learning-records",
  "status": "learned",
  "updated_at": "2026-06-01T00:00:00Z",
  "records": {}
}
JSON

cat > "$ARTIFACT_ROOT/large-learning/state.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "large-learning",
  "status": "accepted",
  "phase": "done",
  "updated_at": "2026-06-01T00:00:00Z",
  "next_action": { "status": "done", "summary": "oversized learning sidecar" }
}
JSON

printf '{ "schema_version": "1.0", "status": ' > "$ARTIFACT_ROOT/invalid-sidecar/state.json"
ln -s "$ARTIFACT_ROOT/active-wip/state.json" "$ARTIFACT_ROOT/symlink-state/state.json"
node -e 'const fs=require("fs"); fs.writeFileSync(process.argv[1], " ".repeat(1024 * 1024 + 1));' "$ARTIFACT_ROOT/large-learning/learning.json"
find "$ARTIFACT_ROOT" -mindepth 1 -maxdepth 1 -type d | sort > "$TMPDIR_EVAL/before.txt"

echo "=== Workflow Artifact Cleanup Audit ==="

flow_agents_node "$SCRIPT" --artifact-root "$ARTIFACT_ROOT" > "$TMPDIR_EVAL/audit.txt"
status=$?
[[ "$status" -eq 0 ]] && pass "text audit exits successfully" || fail "text audit exits successfully"

grep -q "Active WIP: 1" "$TMPDIR_EVAL/audit.txt" && pass "text separates active WIP bucket" || fail "text separates active WIP bucket"
grep -q "Cleanup candidates: 1" "$TMPDIR_EVAL/audit.txt" && pass "text separates cleanup candidate bucket" || fail "text separates cleanup candidate bucket"
grep -q "Active learning follow-ups: 2" "$TMPDIR_EVAL/audit.txt" && pass "text reports learning follow-up bucket" || fail "text reports learning follow-up bucket"
grep -q "Invalid sidecars: 7" "$TMPDIR_EVAL/audit.txt" && pass "text reports invalid bucket" || fail "text reports invalid bucket"

if grep -A3 "Active WIP: 1" "$TMPDIR_EVAL/audit.txt" | grep -q "stale-verified"; then
  fail "verified done fixture is not active WIP"
else
  pass "verified done fixture is not active WIP"
fi

flow_agents_node "$SCRIPT" --artifact-root "$ARTIFACT_ROOT" --json > "$TMPDIR_EVAL/audit.json"
status=$?
[[ "$status" -eq 0 ]] && pass "json audit exits successfully" || fail "json audit exits successfully"

json_query() {
  node -e 'const fs=require("fs"); let cur=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); for (const part of process.argv[2].split(".")) cur=Array.isArray(cur) ? cur[Number(part)] : cur[part]; console.log(cur);' "$1" "$2"
}

[[ "$(json_query "$TMPDIR_EVAL/audit.json" "buckets.active_wip.0.slug")" == "active-wip" ]] && pass "json classifies active fixture" || fail "json classifies active fixture"
[[ "$(json_query "$TMPDIR_EVAL/audit.json" "buckets.terminal_done.0.slug")" == "terminal-done" ]] && pass "json classifies terminal fixture" || fail "json classifies terminal fixture"
grep -q "Cleanup candidates: 1" "$TMPDIR_EVAL/audit.txt" && pass "promoted terminal fixture is not a cleanup candidate" || fail "promoted terminal fixture is not a cleanup candidate"
[[ "$(json_query "$TMPDIR_EVAL/audit.json" "buckets.cleanup_candidate.0.slug")" == "stale-verified" ]] && pass "json classifies stale verified cleanup fixture" || fail "json classifies stale verified cleanup fixture"
[[ "$(json_query "$TMPDIR_EVAL/audit.json" "buckets.active_learning_followup.0.slug")" == "delivered-learning-followup" ]] && pass "json keeps delivered done open learning active" || fail "json keeps delivered done open learning active"
[[ "$(json_query "$TMPDIR_EVAL/audit.json" "buckets.active_learning_followup.1.slug")" == "learning-followup" ]] && pass "json keeps open learning routing active" || fail "json keeps open learning routing active"
[[ "$(json_query "$TMPDIR_EVAL/audit.json" "buckets.invalid.0.slug")" == "invalid-learning-route" ]] && pass "json classifies malformed learning routing invalid" || fail "json classifies malformed learning routing invalid"
[[ "$(json_query "$TMPDIR_EVAL/audit.json" "buckets.invalid.0.reasons.0")" == "learning routing status is missing or invalid" ]] && pass "json reports missing learning routing status" || fail "json reports missing learning routing status"
[[ "$(json_query "$TMPDIR_EVAL/audit.json" "buckets.invalid.1.slug")" == "invalid-sidecar" ]] && pass "json classifies invalid sidecar fixture" || fail "json classifies invalid sidecar fixture"
[[ "$(json_query "$TMPDIR_EVAL/audit.json" "buckets.invalid.2.slug")" == "large-learning" ]] && pass "json classifies oversized learning sidecar invalid" || fail "json classifies oversized learning sidecar invalid"
[[ "$(json_query "$TMPDIR_EVAL/audit.json" "buckets.invalid.3.slug")" == "missing-learning-records" ]] && pass "json classifies missing learning records invalid" || fail "json classifies missing learning records invalid"
[[ "$(json_query "$TMPDIR_EVAL/audit.json" "buckets.invalid.3.reasons.0")" == "learning.records is missing or invalid" ]] && pass "json reports missing learning records" || fail "json reports missing learning records"
[[ "$(json_query "$TMPDIR_EVAL/audit.json" "buckets.invalid.4.slug")" == "missing-state-next-action" ]] && pass "json classifies missing state next_action invalid" || fail "json classifies missing state next_action invalid"
[[ "$(json_query "$TMPDIR_EVAL/audit.json" "buckets.invalid.4.reasons.0")" == "state.next_action is missing or invalid" ]] && pass "json reports missing state next_action" || fail "json reports missing state next_action"
[[ "$(json_query "$TMPDIR_EVAL/audit.json" "buckets.invalid.5.slug")" == "non-array-learning-records" ]] && pass "json classifies non-array learning records invalid" || fail "json classifies non-array learning records invalid"
[[ "$(json_query "$TMPDIR_EVAL/audit.json" "buckets.invalid.5.reasons.0")" == "learning.records is missing or invalid" ]] && pass "json reports non-array learning records" || fail "json reports non-array learning records"
[[ "$(json_query "$TMPDIR_EVAL/audit.json" "buckets.invalid.6.slug")" == "symlink-state" ]] && pass "json classifies symlink state sidecar invalid" || fail "json classifies symlink state sidecar invalid"
[[ "$(json_query "$TMPDIR_EVAL/audit.json" "buckets.invalid.6.reasons.0")" == "state.json must not be a symlink" ]] && pass "json reports symlink rejection without reading target" || fail "json reports symlink rejection without reading target"
[[ "$(json_query "$TMPDIR_EVAL/audit.json" "buckets.cleanup_candidate.0.classification")" == "cleanup_candidate" ]] && pass "json includes stable classification field" || fail "json includes stable classification field"

node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const found = Object.values(data.buckets).some((arr) => Array.isArray(arr) && arr.some((entry) => entry.slug === "liveness"));
process.exit(found ? 1 : 0);
' "$TMPDIR_EVAL/audit.json"
if [[ $? -eq 0 ]]; then
  pass "liveness directory never appears in any bucket"
else
  fail "liveness directory never appears in any bucket"
fi

if flow_agents_node "$SCRIPT" --artifact-root "$TMPDIR_EVAL/missing-root" > "$TMPDIR_EVAL/missing-root.out" 2> "$TMPDIR_EVAL/missing-root.err"; then
  fail "missing artifact root exits nonzero"
else
  pass "missing artifact root exits nonzero"
fi
grep -q "workflow-artifact-cleanup-audit:" "$TMPDIR_EVAL/missing-root.err" && pass "missing artifact root reports controlled error prefix" || fail "missing artifact root reports controlled error prefix"
grep -Eq "ENOENT|no such file|cannot find" "$TMPDIR_EVAL/missing-root.err" && pass "missing artifact root reports missing path" || fail "missing artifact root reports missing path"
grep -q "Error:" "$TMPDIR_EVAL/missing-root.err" && fail "missing artifact root does not print Node stack header" || pass "missing artifact root does not print Node stack header"

flow_agents_node "$SCRIPT" --help > "$TMPDIR_EVAL/help.txt"
if grep -Eq -- "--(apply|delete|archive)" "$TMPDIR_EVAL/help.txt"; then
  fail "help does not advertise apply/delete/archive flags"
else
  pass "help does not advertise apply/delete/archive flags"
fi

find "$ARTIFACT_ROOT" -mindepth 1 -maxdepth 1 -type d | sort > "$TMPDIR_EVAL/after.txt"
cmp -s "$TMPDIR_EVAL/before.txt" "$TMPDIR_EVAL/after.txt" && pass "audit leaves fixture directories in place" || fail "audit leaves fixture directories in place"
[[ -f "$ARTIFACT_ROOT/stale-verified/state.json" ]] && pass "audit leaves fixture files in place" || fail "audit leaves fixture files in place"

if [[ "$errors" -eq 0 ]]; then
  echo "Workflow artifact cleanup audit checks passed"
else
  echo "Workflow artifact cleanup audit checks failed: $errors"
fi

exit "$errors"
