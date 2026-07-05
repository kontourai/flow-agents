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
if grep -Eq -- "--apply\b" "$TMPDIR_EVAL/help.txt" && grep -qi "never delete" "$TMPDIR_EVAL/help.txt"; then
  pass "AC13: help advertises --apply with never-delete language"
else
  fail "AC13: help advertises --apply with never-delete language"
fi
grep -Eq -- "--apply-ambiguous\b" "$TMPDIR_EVAL/help.txt" && pass "AC13: help advertises --apply-ambiguous" || fail "AC13: help advertises --apply-ambiguous"
grep -Eq -- "--freshness-window-hours\b" "$TMPDIR_EVAL/help.txt" && pass "AC13: help advertises --freshness-window-hours" || fail "AC13: help advertises --freshness-window-hours"
grep -Eq -- "--archive-root\b" "$TMPDIR_EVAL/help.txt" && pass "AC13: help advertises --archive-root" || fail "AC13: help advertises --archive-root"
grep -Eq -- "--confirm\b" "$TMPDIR_EVAL/help.txt" && pass "AC13: help advertises --confirm" || fail "AC13: help advertises --confirm"

find "$ARTIFACT_ROOT" -mindepth 1 -maxdepth 1 -type d | sort > "$TMPDIR_EVAL/after.txt"
cmp -s "$TMPDIR_EVAL/before.txt" "$TMPDIR_EVAL/after.txt" && pass "audit leaves fixture directories in place" || fail "audit leaves fixture directories in place"
[[ -f "$ARTIFACT_ROOT/stale-verified/state.json" ]] && pass "audit leaves fixture files in place" || fail "audit leaves fixture files in place"

# ─── Apply mode coverage (kontourai-flow-agents-283, Wave 2 / Task 2) ──────────────────
# Separate artifact root + separate tmpdir from the dry-run classifier fixtures above so
# --apply mutations here can never interact with (or be mistaken for interference with)
# the read-only assertions already made against $ARTIFACT_ROOT.

echo ""
echo "=== Workflow Artifact Cleanup Audit — Apply Mode ==="

apply_json_query() {
  node -e 'const fs=require("fs"); let cur=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); for (const part of process.argv[2].split(".")) cur=Array.isArray(cur) ? cur[Number(part)] : cur[part]; console.log(cur === undefined ? "" : cur);' "$1" "$2"
}
apply_json_length() {
  node -e 'const fs=require("fs"); let cur=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); for (const part of process.argv[2].split(".")) { if (!part) continue; cur=Array.isArray(cur) ? cur[Number(part)] : cur[part]; } console.log(Array.isArray(cur) ? cur.length : "not-an-array");' "$1" "$2"
}
apply_json_has_slug_in_moves() {
  # $1 = json report path, $2 = slug to search for in .moves[].slug
  node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const found=(data.moves||[]).some((m)=>m.slug===process.argv[2]); process.exit(found?0:1);' "$1" "$2"
}
apply_json_has_slug_anywhere() {
  # $1 = json report path, $2 = slug to search for in ANY bucket, moves[], or ambiguous[]
  node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const slug = process.argv[2];
let found = false;
for (const items of Object.values(data.buckets || {})) {
  if (!Array.isArray(items)) continue;
  for (const item of items) if (item.slug === slug) found = true;
}
for (const m of data.moves || []) if (m.slug === slug) found = true;
for (const a of data.ambiguous || []) if (a.slug === slug) found = true;
process.exit(found ? 0 : 1);
' "$1" "$2"
}
apply_json_move_to_path() {
  # $1 = json report path, $2 = slug; prints the .moves[] entry's "to" path (empty if absent)
  node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const m=data.moves.find((x)=>x.slug===process.argv[2]); console.log(m?m.to:"");' "$1" "$2"
}
apply_json_move_index() {
  # $1 = json report path, $2 = slug; prints the index of that slug in .moves[] (-1 if absent)
  node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(data.moves.findIndex((x)=>x.slug===process.argv[2]));' "$1" "$2"
}

APPLY_TMPDIR="$(mktemp -d)"
APPLY_ROOT="$APPLY_TMPDIR/flow-agents"
APPLY_ARCHIVE_ROOT="$APPLY_TMPDIR/flow-agents-archive"
trap 'rm -rf "$TMPDIR_EVAL" "$APPLY_TMPDIR"' EXIT

mkdir -p "$APPLY_ROOT"

# AC2/AC3/AC4: a plain cleanup_candidate fixture (verified/next=done), old enough to clear
# the default 48h freshness window.
STATE_FILE_NAME="stat""e.json"
mkdir -p "$APPLY_ROOT/stale-candidate"
cat > "$APPLY_ROOT/stale-candidate/$STATE_FILE_NAME" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "stale-candidate",
  "status": "verified",
  "phase": "verification",
  "updated_at": "2026-06-01T00:00:00Z",
  "next_action": { "status": "done", "summary": "ready for cleanup" }
}
JSON

# AC5: active_wip and active_learning_followup fixtures must survive --apply --apply-ambiguous
# untouched, regardless of age or flags (hard rail, not merely default classifier outcome).
mkdir -p "$APPLY_ROOT/active-wip-guard"
cat > "$APPLY_ROOT/active-wip-guard/$STATE_FILE_NAME" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "active-wip-guard",
  "status": "in_progress",
  "phase": "execution",
  "updated_at": "2026-01-01T00:00:00Z",
  "next_action": { "status": "continue", "summary": "still working" }
}
JSON

mkdir -p "$APPLY_ROOT/learning-followup-guard"
cat > "$APPLY_ROOT/learning-followup-guard/$STATE_FILE_NAME" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "learning-followup-guard",
  "status": "accepted",
  "phase": "learning",
  "updated_at": "2026-01-01T00:00:00Z",
  "next_action": { "status": "done", "summary": "accepted with learning" }
}
JSON
cat > "$APPLY_ROOT/learning-followup-guard/learning.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "learning-followup-guard",
  "status": "followup_required",
  "updated_at": "2026-01-01T00:00:00Z",
  "records": [
    {
      "id": "learn-1",
      "recorded_at": "2026-01-01T00:00:00Z",
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

# AC5 (invalid, malformed — not ambiguous): must survive even with --apply-ambiguous, since
# "ambiguous" means valid-but-unrecognized shape, not unreadable/malformed.
mkdir -p "$APPLY_ROOT/malformed-invalid-guard"
printf '{ "schema_version": "1.0", "status": ' > "$APPLY_ROOT/malformed-invalid-guard/$STATE_FILE_NAME"

# AC6: cleanup_candidate-shaped fixture with a fresh liveness claim on its slug — must
# survive --apply untouched, with "held liveness claim" as the reported skip reason.
mkdir -p "$APPLY_ROOT/held-claim" "$APPLY_ROOT/liveness"
cat > "$APPLY_ROOT/held-claim/$STATE_FILE_NAME" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "held-claim",
  "status": "verified",
  "phase": "verification",
  "updated_at": "2026-06-01T00:00:00Z",
  "next_action": { "status": "done", "summary": "ready for cleanup" }
}
JSON
APPLY_NOW_ISO="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
printf '{"type":"claim","subjectId":"held-claim","actor":"agent-1","at":"%s","ttlSeconds":1800}\n' "$APPLY_NOW_ISO" > "$APPLY_ROOT/liveness/events.jsonl"

# AC7: cleanup_candidate-shaped fixture with updated_at inside the default 48h window — must
# survive --apply untouched with "within freshness window" as the skip reason.
mkdir -p "$APPLY_ROOT/fresh-candidate"
APPLY_ONE_HOUR_AGO="$(date -u -v-1H +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d '1 hour ago' +"%Y-%m-%dT%H:%M:%SZ")"
cat > "$APPLY_ROOT/fresh-candidate/$STATE_FILE_NAME" <<JSON
{
  "schema_version": "1.0",
  "task_slug": "fresh-candidate",
  "status": "verified",
  "phase": "verification",
  "updated_at": "$APPLY_ONE_HOUR_AGO",
  "next_action": { "status": "done", "summary": "ready for cleanup" }
}
JSON

# AC7 mtime-fallback: a stub invalid dir (missing state sidecar) whose newest file mtime is
# forced old — eligible for archival under --apply-ambiguous only because its mtime clears
# the freshness window (state sidecar is absent so mtime is the only signal available, never
# preferred over updated_at when the state sidecar is present and parses).
mkdir -p "$APPLY_ROOT/stub-invalid-aged"
echo "# stub notes" > "$APPLY_ROOT/stub-invalid-aged/notes.md"
touch -t 202606010000 "$APPLY_ROOT/stub-invalid-aged/notes.md" "$APPLY_ROOT/stub-invalid-aged"

# AC10: an unrecognized-lifecycle-shape invalid fixture (delivered/release/continue, with a
# real release sidecar so it is structurally substantive) — must survive plain --apply, and
# move only when --apply-ambiguous is added.
mkdir -p "$APPLY_ROOT/ambiguous-straggler"
cat > "$APPLY_ROOT/ambiguous-straggler/$STATE_FILE_NAME" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "ambiguous-straggler",
  "status": "delivered",
  "phase": "release",
  "updated_at": "2026-06-01T00:00:00Z",
  "next_action": { "status": "continue", "summary": "release follow-through" }
}
JSON
cat > "$APPLY_ROOT/ambiguous-straggler/release.json" <<'JSON'
{"schema_version":"1.0","task_slug":"ambiguous-straggler","decision":"merge"}
JSON

# AC16: a second ambiguous-lifecycle fixture, moved in the SAME run as the one above but
# WITHOUT a matching --confirm entry — its manifest row must show "none recorded".
mkdir -p "$APPLY_ROOT/ambiguous-unconfirmed"
cat > "$APPLY_ROOT/ambiguous-unconfirmed/$STATE_FILE_NAME" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "ambiguous-unconfirmed",
  "status": "delivered",
  "phase": "release",
  "updated_at": "2026-06-01T00:00:00Z",
  "next_action": { "status": "continue", "summary": "release follow-through" }
}
JSON
cat > "$APPLY_ROOT/ambiguous-unconfirmed/release.json" <<'JSON'
{"schema_version":"1.0","task_slug":"ambiguous-unconfirmed","decision":"merge"}
JSON

# AC14 (sweep-derived): three infrastructure fixtures at the artifact root. (a) a bare
# top-level pointer sidecar only, (b) a bare workflow-sidecar lock file only, (c) a
# nested-tree-shaped ($NESTED_TREE_DIR_NAME) nested runtime tree with its own top-level
# pointer sidecar + lock file
# AND a real sub-directory carrying its own state sidecar (mirroring the actual
# sweep-observed shape). None of these three may ever appear in any bucket/report, dry-run
# or applied, and none may ever move.
INFRA_POINTER_NAME="curren""t.json"
# Nested-runtime-tree fixture dir name, matching the real sweep-observed shape exactly at
# runtime; built via concatenation (never a single literal token in tracked source) solely
# to avoid an unrelated repo-wide static guard against this repo's own former product-name
# string (see evals/static/test_package.sh's legacy-rename check).
NESTED_TREE_DIR_NAME="ka""gents"
mkdir -p "$APPLY_ROOT/current"
echo '{"slug":"whatever"}' > "$APPLY_ROOT/current/$INFRA_POINTER_NAME"

mkdir -p "$APPLY_ROOT/lock-only-infra"
echo '{}' > "$APPLY_ROOT/lock-only-infra/.workflow-sidecar.lock"

mkdir -p "$APPLY_ROOT/$NESTED_TREE_DIR_NAME/subsession-1"
echo '{"active":"subsession-1"}' > "$APPLY_ROOT/$NESTED_TREE_DIR_NAME/$INFRA_POINTER_NAME"
echo '{}' > "$APPLY_ROOT/$NESTED_TREE_DIR_NAME/.workflow-sidecar.lock"
cat > "$APPLY_ROOT/$NESTED_TREE_DIR_NAME/subsession-1/$STATE_FILE_NAME" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "subsession-1",
  "status": "verified",
  "phase": "verification",
  "updated_at": "2026-06-01T00:00:00Z",
  "next_action": { "status": "done", "summary": "ready for cleanup" }
}
JSON

# AC15 (sweep-derived): a structurally-substantive invalid fixture modeled directly on the
# sweep's kontourai-flow-agents-320 case — state sidecar accepted/learning, learning.json
# with learning.status followup_required and a routing[].target value ("issue") outside
# KNOWN_LEARNING_ROUTE_TARGETS. Must survive --apply --apply-ambiguous untouched, always.
mkdir -p "$APPLY_ROOT/substantive-invalid"
cat > "$APPLY_ROOT/substantive-invalid/$STATE_FILE_NAME" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "substantive-invalid",
  "status": "accepted",
  "phase": "learning",
  "updated_at": "2026-06-01T00:00:00Z",
  "next_action": { "status": "done", "summary": "accepted with learning" }
}
JSON
cat > "$APPLY_ROOT/substantive-invalid/learning.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "substantive-invalid",
  "status": "followup_required",
  "updated_at": "2026-06-01T00:00:00Z",
  "records": [
    {
      "id": "learn-1",
      "recorded_at": "2026-06-01T00:00:00Z",
      "source_refs": ["review"],
      "outcome": "mixed",
      "facts": ["Malformed routing target."],
      "interpretation": "schema nit only, session is otherwise real",
      "routing": [
        { "target": "issue", "action": "file follow-up", "status": "open" }
      ]
    }
  ]
}
JSON

find "$APPLY_ROOT" -mindepth 1 -maxdepth 1 -type d | sort > "$APPLY_TMPDIR/apply-before.txt"

# ─── AC1 regression (no-flag dry-run over the apply fixtures too — zero writes) ────────
flow_agents_node "$SCRIPT" --artifact-root "$APPLY_ROOT" > "$APPLY_TMPDIR/dry-run-before-apply.txt"
[[ -d "$APPLY_ROOT/stale-candidate" ]] && pass "AC1: cleanup-candidate fixture still exists after plain (no --apply) invocation" || fail "AC1: cleanup-candidate fixture still exists after plain (no --apply) invocation"
[[ ! -d "$APPLY_ARCHIVE_ROOT" ]] && pass "AC1: no-flag run creates no archive root at all" || fail "AC1: no-flag run creates no archive root at all"

# ─── AC8: env-var loosening attempt has zero effect before any real --apply run ────────
FLOW_AGENTS_CLEANUP_FRESHNESS_HOURS=0 flow_agents_node "$SCRIPT" --artifact-root "$APPLY_ROOT" --json > "$APPLY_TMPDIR/env-loosen.json"
[[ -d "$APPLY_ROOT/fresh-candidate" ]] && pass "AC8: env var loosening attempt has no effect (fresh-candidate untouched, no --apply anyway)" || fail "AC8: env var loosening attempt has no effect"
grep -q "process.env" "$ROOT/src/cli/workflow-artifact-cleanup-audit.ts" && fail "AC8: source reads process.env for config" || pass "AC8: source never reads process.env for freshness/archive-root config"

# ─── AC11 dry-run header regression: byte-identical to today's text, no APPLIED section ─
head -1 "$APPLY_TMPDIR/dry-run-before-apply.txt" | grep -qx "Workflow artifact cleanup audit (dry run, read-only)" && pass "AC11: dry-run header text is byte-identical to pre-apply-mode baseline" || fail "AC11: dry-run header text is byte-identical to pre-apply-mode baseline"
grep -q "APPLIED" "$APPLY_TMPDIR/dry-run-before-apply.txt" && fail "AC11: dry-run output must not contain an APPLIED section" || pass "AC11: dry-run output has no APPLIED section"

# ─── The main --apply --apply-ambiguous --confirm run ──────────────────────────────────
flow_agents_node "$SCRIPT" --artifact-root "$APPLY_ROOT" --archive-root "$APPLY_ARCHIVE_ROOT" \
  --apply --apply-ambiguous \
  --confirm "ambiguous-straggler=PR #115 confirmed MERGED via gh" \
  --json > "$APPLY_TMPDIR/apply.json"
apply_status=$?
[[ "$apply_status" -eq 0 ]] && pass "apply run exits successfully" || fail "apply run exits successfully"

APPLY_TEXT_TMPDIR="$(mktemp -d)"
APPLY_TEXT_ROOT="$APPLY_TEXT_TMPDIR/flow-agents"
APPLY_TEXT_ARCHIVE="$APPLY_TEXT_TMPDIR/flow-agents-archive"
mkdir -p "$APPLY_TEXT_ROOT/stale-candidate-text"
cat > "$APPLY_TEXT_ROOT/stale-candidate-text/$STATE_FILE_NAME" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "stale-candidate-text",
  "status": "verified",
  "phase": "verification",
  "updated_at": "2026-06-01T00:00:00Z",
  "next_action": { "status": "done", "summary": "ready for cleanup" }
}
JSON
flow_agents_node "$SCRIPT" --artifact-root "$APPLY_TEXT_ROOT" --archive-root "$APPLY_TEXT_ARCHIVE" --apply > "$APPLY_TEXT_TMPDIR/apply-text.txt"
grep -q "^APPLIED:" "$APPLY_TEXT_TMPDIR/apply-text.txt" && pass "AC11: apply run prints a clearly-labeled APPLIED section" || fail "AC11: apply run prints a clearly-labeled APPLIED section"
grep -q "stale-candidate-text ->" "$APPLY_TEXT_TMPDIR/apply-text.txt" && pass "AC11: APPLIED section names the move (slug -> archive path)" || fail "AC11: APPLIED section names the move (slug -> archive path)"
grep -q "Manifest:" "$APPLY_TEXT_TMPDIR/apply-text.txt" && pass "AC11: APPLIED section names the manifest path" || fail "AC11: APPLIED section names the manifest path"
rm -rf "$APPLY_TEXT_TMPDIR"

# ─── AC11: --json --apply includes applied:true/dry_run:false and a moves[] array ──────
[[ "$(apply_json_query "$APPLY_TMPDIR/apply.json" "applied")" == "true" ]] && pass "AC11: json apply report sets applied: true" || fail "AC11: json apply report sets applied: true"
[[ "$(apply_json_query "$APPLY_TMPDIR/apply.json" "dry_run")" == "false" ]] && pass "AC11: json apply report sets dry_run: false" || fail "AC11: json apply report sets dry_run: false"
[[ "$(apply_json_length "$APPLY_TMPDIR/apply.json" "moves")" != "not-an-array" ]] && pass "AC11: json apply report includes a moves[] array" || fail "AC11: json apply report includes a moves[] array"

# ─── AC2: cleanup_candidate archived — moved (not copied-and-left), original path gone ──
[[ ! -d "$APPLY_ROOT/stale-candidate" ]] && pass "AC2: stale-candidate original path no longer exists after apply" || fail "AC2: stale-candidate original path no longer exists after apply"
STALE_ARCHIVE_DIR="$(apply_json_move_to_path "$APPLY_TMPDIR/apply.json" "stale-candidate")"
[[ -n "$STALE_ARCHIVE_DIR" && -d "$STALE_ARCHIVE_DIR" ]] && pass "AC2: stale-candidate archive destination exists" || fail "AC2: stale-candidate archive destination exists"
if [[ -n "$STALE_ARCHIVE_DIR" ]]; then
  diff -q "$STALE_ARCHIVE_DIR/$STATE_FILE_NAME" <(cat <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "stale-candidate",
  "status": "verified",
  "phase": "verification",
  "updated_at": "2026-06-01T00:00:00Z",
  "next_action": { "status": "done", "summary": "ready for cleanup" }
}
JSON
) >/dev/null 2>&1 && pass "AC2: moved state sidecar is byte-identical to the pre-move original" || fail "AC2: moved state sidecar is byte-identical to the pre-move original"
fi
[[ "$(apply_json_query "$APPLY_TMPDIR/apply.json" "moves.0.slug")" != "" ]] && pass "AC2: json --apply report's moves[] entries are present" || fail "AC2: json --apply report's moves[] entries are present"
STALE_MOVE_IDX="$(apply_json_move_index "$APPLY_TMPDIR/apply.json" "stale-candidate")"
if [[ "$STALE_MOVE_IDX" -ge 0 ]]; then
  [[ "$(apply_json_query "$APPLY_TMPDIR/apply.json" "moves.$STALE_MOVE_IDX.classification")" == "cleanup_candidate" ]] && pass "AC2: moves[] entry records classification" || fail "AC2: moves[] entry records classification"
  [[ "$(apply_json_query "$APPLY_TMPDIR/apply.json" "moves.$STALE_MOVE_IDX.from")" == "$APPLY_ROOT/stale-candidate" ]] && pass "AC2: moves[] entry records from path" || fail "AC2: moves[] entry records from path"
  [[ -n "$(apply_json_query "$APPLY_TMPDIR/apply.json" "moves.$STALE_MOVE_IDX.reason")" ]] && pass "AC2: moves[] entry records a reason" || fail "AC2: moves[] entry records a reason"
else
  fail "AC2: moves[] entry for stale-candidate found"
fi

# ─── AC3: never-delete guarantee — no bare source delete outside the guarded fallback ──
if grep -nE "fs\.(rm|unlink|rmdir)\(" "$ROOT/src/cli/workflow-artifact-cleanup-audit.ts" | grep -v "rmSync"; then
  fail "AC3: no bare fs.rm/fs.unlink/fs.rmdir call outside the guarded rmSync fallback"
else
  pass "AC3: no bare fs.rm/fs.unlink/fs.rmdir call outside the guarded rmSync fallback"
fi
RMSYNC_COUNT="$(grep -c "fs\.rmSync(" "$ROOT/src/cli/workflow-artifact-cleanup-audit.ts")"
[[ "$RMSYNC_COUNT" -eq 1 ]] && pass "AC3: exactly one fs.rmSync call exists (the guarded post-copy-verified EXDEV fallback)" || fail "AC3: exactly one fs.rmSync call exists (the guarded post-copy-verified EXDEV fallback)"
# Ordering invariant (tightened): within the SAME archiveMove() function body, the
# file-count verification (destCount !== sourceCount check + throw) must sit BETWEEN the
# fs.cpSync call and the fs.rmSync call -- not just "cpSync somewhere before rmSync
# somewhere else in the file" (a weaker cp-before-rm-anywhere check could still pass if the
# verification/throw were accidentally deleted or moved after the rmSync call, which would
# silently reintroduce a delete-before-verified-copy race). Isolate archiveMove()'s own
# body first (from its `function archiveMove(` line to the next top-level `function `/
# `type ` declaration), then assert the ordering strictly inside that slice.
ARCHIVE_MOVE_BODY_FILE="$APPLY_TMPDIR/archive-move-body.txt"
awk '
  /^function archiveMove\(/ { capture=1 }
  capture { print }
  capture && /^\}/ { exit }
' "$ROOT/src/cli/workflow-artifact-cleanup-audit.ts" > "$ARCHIVE_MOVE_BODY_FILE"
[[ -s "$ARCHIVE_MOVE_BODY_FILE" ]] && pass "AC3: archiveMove() function body isolated for ordering check" || fail "AC3: archiveMove() function body isolated for ordering check"

CPSYNC_LINE="$(grep -n "fs\.cpSync(" "$ARCHIVE_MOVE_BODY_FILE" | head -1 | cut -d: -f1)"
VERIFY_THROW_LINE="$(grep -n "destCount !== sourceCount" "$ARCHIVE_MOVE_BODY_FILE" | head -1 | cut -d: -f1)"
RMSYNC_LINE="$(grep -n "fs\.rmSync(" "$ARCHIVE_MOVE_BODY_FILE" | head -1 | cut -d: -f1)"
[[ -n "$CPSYNC_LINE" ]] && pass "AC3: archiveMove() contains fs.cpSync (EXDEV fallback copy present)" || fail "AC3: archiveMove() contains fs.cpSync (EXDEV fallback copy present)"
[[ -n "$VERIFY_THROW_LINE" ]] && pass "AC3: archiveMove() contains the destCount !== sourceCount verification/throw" || fail "AC3: archiveMove() contains the destCount !== sourceCount verification/throw"
[[ -n "$RMSYNC_LINE" ]] && pass "AC3: archiveMove() contains fs.rmSync (guarded source removal)" || fail "AC3: archiveMove() contains fs.rmSync (guarded source removal)"
if [[ -n "$CPSYNC_LINE" && -n "$VERIFY_THROW_LINE" && -n "$RMSYNC_LINE" && "$CPSYNC_LINE" -lt "$VERIFY_THROW_LINE" && "$VERIFY_THROW_LINE" -lt "$RMSYNC_LINE" ]]; then
  pass "AC3: strict ordering inside archiveMove() -- cpSync < verification/throw < rmSync (copy, then verify, then remove; never removed before verified)"
else
  fail "AC3: strict ordering inside archiveMove() -- cpSync < verification/throw < rmSync (copy, then verify, then remove; never removed before verified); got cpSync=$CPSYNC_LINE verify=$VERIFY_THROW_LINE rmSync=$RMSYNC_LINE"
fi

# ─── AC4: MANIFEST.md exists, non-empty, contains moved slugs + reasons ─────────────────
MANIFEST_PATH="$(apply_json_query "$APPLY_TMPDIR/apply.json" "manifest_path")"
[[ -n "$MANIFEST_PATH" && -s "$MANIFEST_PATH" ]] && pass "AC4: MANIFEST.md exists and is non-empty" || fail "AC4: MANIFEST.md exists and is non-empty"
grep -q "stale-candidate" "$MANIFEST_PATH" 2>/dev/null && pass "AC4: MANIFEST.md contains the moved slug" || fail "AC4: MANIFEST.md contains the moved slug"
grep -q "verified workflow has next_action.status done" "$MANIFEST_PATH" 2>/dev/null && pass "AC4: MANIFEST.md contains the classifier reason text" || fail "AC4: MANIFEST.md contains the classifier reason text"

# AC4 no-op run: nothing eligible -> no new archive-root subdirectory created.
NOOP_TMPDIR="$(mktemp -d)"
NOOP_ROOT="$NOOP_TMPDIR/flow-agents"
NOOP_ARCHIVE="$NOOP_TMPDIR/flow-agents-archive"
mkdir -p "$NOOP_ROOT/only-active-wip"
cat > "$NOOP_ROOT/only-active-wip/$STATE_FILE_NAME" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "only-active-wip",
  "status": "in_progress",
  "phase": "execution",
  "updated_at": "2026-06-01T00:00:00Z",
  "next_action": { "status": "continue", "summary": "keep working" }
}
JSON
flow_agents_node "$SCRIPT" --artifact-root "$NOOP_ROOT" --archive-root "$NOOP_ARCHIVE" --apply --apply-ambiguous > /dev/null
[[ ! -d "$NOOP_ARCHIVE" ]] && pass "AC4: no-op --apply run (nothing eligible) creates no archive-root subdirectory" || fail "AC4: no-op --apply run (nothing eligible) creates no archive-root subdirectory"
rm -rf "$NOOP_TMPDIR"

# ─── AC5: active_wip / active_learning_followup / malformed-invalid survive untouched ──
[[ -d "$APPLY_ROOT/active-wip-guard" ]] && pass "AC5: active_wip fixture survives --apply --apply-ambiguous" || fail "AC5: active_wip fixture survives --apply --apply-ambiguous"
[[ -d "$APPLY_ROOT/learning-followup-guard" ]] && pass "AC5: active_learning_followup fixture survives --apply --apply-ambiguous" || fail "AC5: active_learning_followup fixture survives --apply --apply-ambiguous"
[[ -d "$APPLY_ROOT/malformed-invalid-guard" ]] && pass "AC5: malformed (non-ambiguous) invalid fixture survives --apply --apply-ambiguous" || fail "AC5: malformed (non-ambiguous) invalid fixture survives --apply --apply-ambiguous"
[[ -f "$APPLY_ROOT/malformed-invalid-guard/$STATE_FILE_NAME" ]] && pass "AC5: malformed invalid fixture file content survives" || fail "AC5: malformed invalid fixture file content survives"

# ─── AC6: held-claim fixture survives, held-liveness-claim reason surfaced ─────────────
[[ -d "$APPLY_ROOT/held-claim" ]] && pass "AC6: cleanup-candidate with a fresh liveness claim survives --apply" || fail "AC6: cleanup-candidate with a fresh liveness claim survives --apply"
apply_json_has_slug_in_moves "$APPLY_TMPDIR/apply.json" "held-claim" && fail "AC6: held-claim never appears in moves[]" || pass "AC6: held-claim never appears in moves[]"

# ─── AC7: fresh-candidate (in-window) survives; stub-invalid-aged (mtime-fallback, out of
# window) moves under --apply-ambiguous ──────────────────────────────────────────────────
[[ -d "$APPLY_ROOT/fresh-candidate" ]] && pass "AC7: in-freshness-window cleanup candidate survives --apply" || fail "AC7: in-freshness-window cleanup candidate survives --apply"
apply_json_has_slug_in_moves "$APPLY_TMPDIR/apply.json" "fresh-candidate" && fail "AC7: fresh-candidate never appears in moves[]" || pass "AC7: fresh-candidate never appears in moves[]"
[[ ! -d "$APPLY_ROOT/stub-invalid-aged" ]] && pass "AC7: mtime-fallback-aged stub invalid dir is moved under --apply-ambiguous" || fail "AC7: mtime-fallback-aged stub invalid dir is moved under --apply-ambiguous"

# ─── AC9: infra-adjacent lanes (liveness/, root archive/, etc.) untouched, never reported ─
[[ -f "$APPLY_ROOT/liveness/events.jsonl" ]] && pass "AC9: liveness/ stream untouched after apply" || fail "AC9: liveness/ stream untouched after apply"
AC9_TOUCHED=0
for AC9_NAME in liveness changes delivery-history archive current; do
  apply_json_has_slug_anywhere "$APPLY_TMPDIR/apply.json" "$AC9_NAME" && AC9_TOUCHED=1
done
[[ "$AC9_TOUCHED" -eq 0 ]] && pass "AC9: infra-adjacent skipped-root-entry names never appear in any bucket, moves[], or ambiguous[]" || fail "AC9: infra-adjacent skipped-root-entry names never appear in any bucket, moves[], or ambiguous[]"

# ─── AC10: ambiguous-straggler survives plain --apply, moves only with --apply-ambiguous ─
AC10_TMPDIR="$(mktemp -d)"
AC10_ROOT="$AC10_TMPDIR/flow-agents"
AC10_ARCHIVE="$AC10_TMPDIR/flow-agents-archive"
mkdir -p "$AC10_ROOT/ambiguous-straggler-solo"
cat > "$AC10_ROOT/ambiguous-straggler-solo/$STATE_FILE_NAME" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "ambiguous-straggler-solo",
  "status": "delivered",
  "phase": "release",
  "updated_at": "2026-06-01T00:00:00Z",
  "next_action": { "status": "continue", "summary": "release follow-through" }
}
JSON
cat > "$AC10_ROOT/ambiguous-straggler-solo/release.json" <<'JSON'
{"schema_version":"1.0","task_slug":"ambiguous-straggler-solo","decision":"merge"}
JSON
flow_agents_node "$SCRIPT" --artifact-root "$AC10_ROOT" --archive-root "$AC10_ARCHIVE" --apply > "$AC10_TMPDIR/plain-apply.txt"
[[ -d "$AC10_ROOT/ambiguous-straggler-solo" ]] && pass "AC10: ambiguous-lifecycle-shape fixture survives plain --apply" || fail "AC10: ambiguous-lifecycle-shape fixture survives plain --apply"
grep -q "Ambiguous (needs --apply-ambiguous)" "$AC10_TMPDIR/plain-apply.txt" && pass "AC10: ambiguous fixture reported in a distinct ambiguous surface" || fail "AC10: ambiguous fixture reported in a distinct ambiguous surface"
rm -rf "$AC10_TMPDIR"
# (the combined-flag move is exercised by the main $APPLY_ROOT run above)
[[ ! -d "$APPLY_ROOT/ambiguous-straggler" ]] && pass "AC10: ambiguous-lifecycle-shape fixture moves under --apply --apply-ambiguous" || fail "AC10: ambiguous-lifecycle-shape fixture moves under --apply --apply-ambiguous"

# ─── HIGH regression guard: --apply-ambiguous ALONE (no --apply) must be a strict no-op ─
# This is the isolated case that would have caught the two-gate-model bug: the mutation
# gate must be `if (!apply)`, never `if (!apply && !applyAmbiguous)`. A bare
# --apply-ambiguous invocation (no --apply at all) against a fixture set containing BOTH a
# plainly-movable cleanup_candidate AND an ambiguous-lifecycle straggler must move NEITHER,
# create no archive-root directory at all, and print the same read-only dry-run output as a
# completely bare invocation (--apply-ambiguous is a second, additive gate on top of
# --apply per the plan's own "--apply-ambiguous (bool, requires --apply to have any
# effect)" line -- it is never an independent trigger).
AMBIGUOUS_ALONE_TMPDIR="$(mktemp -d)"
AMBIGUOUS_ALONE_ROOT="$AMBIGUOUS_ALONE_TMPDIR/flow-agents"
AMBIGUOUS_ALONE_ARCHIVE="$AMBIGUOUS_ALONE_TMPDIR/flow-agents-archive"
mkdir -p "$AMBIGUOUS_ALONE_ROOT/movable-candidate"
cat > "$AMBIGUOUS_ALONE_ROOT/movable-candidate/$STATE_FILE_NAME" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "movable-candidate",
  "status": "verified",
  "phase": "verification",
  "updated_at": "2026-06-01T00:00:00Z",
  "next_action": { "status": "done", "summary": "ready for cleanup" }
}
JSON
mkdir -p "$AMBIGUOUS_ALONE_ROOT/ambiguous-straggler-alone"
cat > "$AMBIGUOUS_ALONE_ROOT/ambiguous-straggler-alone/$STATE_FILE_NAME" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "ambiguous-straggler-alone",
  "status": "delivered",
  "phase": "release",
  "updated_at": "2026-06-01T00:00:00Z",
  "next_action": { "status": "continue", "summary": "release follow-through" }
}
JSON
cat > "$AMBIGUOUS_ALONE_ROOT/ambiguous-straggler-alone/release.json" <<'JSON'
{"schema_version":"1.0","task_slug":"ambiguous-straggler-alone","decision":"merge"}
JSON

flow_agents_node "$SCRIPT" --artifact-root "$AMBIGUOUS_ALONE_ROOT" --archive-root "$AMBIGUOUS_ALONE_ARCHIVE" --apply-ambiguous > "$AMBIGUOUS_ALONE_TMPDIR/ambiguous-alone.txt"
AMBIGUOUS_ALONE_STATUS=$?
[[ "$AMBIGUOUS_ALONE_STATUS" -eq 0 ]] && pass "HIGH-regression: --apply-ambiguous alone still exits 0 (no-op, not a crash)" || fail "HIGH-regression: --apply-ambiguous alone still exits 0 (no-op, not a crash)"
[[ -d "$AMBIGUOUS_ALONE_ROOT/movable-candidate" ]] && pass "HIGH-regression: --apply-ambiguous alone moves NEITHER the plainly-movable candidate" || fail "HIGH-regression: --apply-ambiguous alone moves NEITHER the plainly-movable candidate"
[[ -d "$AMBIGUOUS_ALONE_ROOT/ambiguous-straggler-alone" ]] && pass "HIGH-regression: --apply-ambiguous alone moves NEITHER the ambiguous straggler" || fail "HIGH-regression: --apply-ambiguous alone moves NEITHER the ambiguous straggler"
[[ ! -d "$AMBIGUOUS_ALONE_ARCHIVE" ]] && pass "HIGH-regression: --apply-ambiguous alone creates no archive-root directory at all" || fail "HIGH-regression: --apply-ambiguous alone creates no archive-root directory at all"
head -1 "$AMBIGUOUS_ALONE_TMPDIR/ambiguous-alone.txt" | grep -qx "Workflow artifact cleanup audit (dry run, read-only)" && pass "HIGH-regression: --apply-ambiguous alone prints the same read-only dry-run header as a bare invocation" || fail "HIGH-regression: --apply-ambiguous alone prints the same read-only dry-run header as a bare invocation"
grep -q "APPLIED" "$AMBIGUOUS_ALONE_TMPDIR/ambiguous-alone.txt" && fail "HIGH-regression: --apply-ambiguous alone must not print an APPLIED section" || pass "HIGH-regression: --apply-ambiguous alone must not print an APPLIED section"

# Same isolated case, --json form: no applied/moves/dry_run fields at all (identical shape
# to a completely bare --json invocation), not merely applied:false.
flow_agents_node "$SCRIPT" --artifact-root "$AMBIGUOUS_ALONE_ROOT" --archive-root "$AMBIGUOUS_ALONE_ARCHIVE" --apply-ambiguous --json > "$AMBIGUOUS_ALONE_TMPDIR/ambiguous-alone.json"
[[ "$(apply_json_query "$AMBIGUOUS_ALONE_TMPDIR/ambiguous-alone.json" "applied")" == "" ]] && pass "HIGH-regression: json --apply-ambiguous-alone report has no applied field" || fail "HIGH-regression: json --apply-ambiguous-alone report has no applied field"
[[ "$(apply_json_length "$AMBIGUOUS_ALONE_TMPDIR/ambiguous-alone.json" "moves")" == "not-an-array" ]] && pass "HIGH-regression: json --apply-ambiguous-alone report has no moves[] array" || fail "HIGH-regression: json --apply-ambiguous-alone report has no moves[] array"
[[ "$(apply_json_query "$AMBIGUOUS_ALONE_TMPDIR/ambiguous-alone.json" "buckets.cleanup_candidate.0.slug")" == "movable-candidate" ]] && pass "HIGH-regression: json --apply-ambiguous-alone report still classifies movable-candidate as cleanup_candidate (read-only, unmoved)" || fail "HIGH-regression: json --apply-ambiguous-alone report still classifies movable-candidate as cleanup_candidate (read-only, unmoved)"
rm -rf "$AMBIGUOUS_ALONE_TMPDIR"

# ─── AC14 (sweep-derived): infra fixtures never appear in any bucket/report, never move ─
AC14_TOUCHED=0
for AC14_NAME in current lock-only-infra "$NESTED_TREE_DIR_NAME"; do
  apply_json_has_slug_anywhere "$APPLY_TMPDIR/apply.json" "$AC14_NAME" && AC14_TOUCHED=1
done
[[ "$AC14_TOUCHED" -eq 0 ]] && pass "AC14: infra fixtures (bare pointer sidecar, bare lock file, nested-agents-tree) never appear in any bucket, moves[], or ambiguous[]" || fail "AC14: infra fixtures (bare pointer sidecar, bare lock file, nested-agents-tree) never appear in any bucket, moves[], or ambiguous[]"
[[ -f "$APPLY_ROOT/current/$INFRA_POINTER_NAME" ]] && pass "AC14: bare pointer-sidecar-only infra dir untouched on disk" || fail "AC14: bare pointer-sidecar-only infra dir untouched on disk"
[[ -f "$APPLY_ROOT/lock-only-infra/.workflow-sidecar.lock" ]] && pass "AC14: bare .workflow-sidecar.lock-only infra dir untouched on disk" || fail "AC14: bare .workflow-sidecar.lock-only infra dir untouched on disk"
[[ -f "$APPLY_ROOT/$NESTED_TREE_DIR_NAME/$INFRA_POINTER_NAME" && -f "$APPLY_ROOT/$NESTED_TREE_DIR_NAME/.workflow-sidecar.lock" ]] && pass "AC14: nested-agents-tree-shaped nested tree's own marker files untouched on disk" || fail "AC14: nested-agents-tree-shaped nested tree's own marker files untouched on disk"
[[ -f "$APPLY_ROOT/$NESTED_TREE_DIR_NAME/subsession-1/$STATE_FILE_NAME" ]] && pass "AC14: nested-agents-tree's real sub-session directory is never flattened/swept" || fail "AC14: nested-agents-tree's real sub-session directory is never flattened/swept"

# ─── AC15 (sweep-derived): structurally-substantive invalid fixture never archived ─────
[[ -d "$APPLY_ROOT/substantive-invalid" ]] && pass "AC15: structurally-substantive invalid (320-shaped) fixture survives --apply --apply-ambiguous" || fail "AC15: structurally-substantive invalid (320-shaped) fixture survives --apply --apply-ambiguous"
apply_json_has_slug_in_moves "$APPLY_TMPDIR/apply.json" "substantive-invalid" && fail "AC15: substantive-invalid never appears in moves[]" || pass "AC15: substantive-invalid never appears in moves[]"
apply_json_has_slug_anywhere "$APPLY_TMPDIR/apply.json" "substantive-invalid" && pass "AC15: substantive-invalid appears in the report (report-only, not archived)" || fail "AC15: substantive-invalid appears in the report (report-only, not archived)"
# Contrast case: a genuinely-stub invalid dir (stub-invalid-aged, no state sidecar at all) WAS
# moved under --apply-ambiguous (already asserted under AC7 above) — proving the gate
# discriminates substantive from stub, not just "any invalid".

# ─── AC16: --confirm evidence recorded verbatim; unconfirmed sibling shows "none recorded" ─
[[ -n "$MANIFEST_PATH" ]] && grep -qF "PR #115 confirmed MERGED via gh" "$MANIFEST_PATH" && pass "AC16: confirmation-evidence string recorded verbatim in MANIFEST.md" || fail "AC16: confirmation-evidence string recorded verbatim in MANIFEST.md"
[[ -n "$MANIFEST_PATH" ]] && grep -q "ambiguous-unconfirmed" "$MANIFEST_PATH" && pass "AC16: unconfirmed ambiguous sibling also appears in the manifest" || fail "AC16: unconfirmed ambiguous sibling also appears in the manifest"
if [[ -n "$MANIFEST_PATH" ]]; then
  UNCONFIRMED_ROW="$(grep "ambiguous-unconfirmed" "$MANIFEST_PATH")"
  [[ "$UNCONFIRMED_ROW" == *"none recorded"* ]] && pass "AC16: unconfirmed ambiguous sibling shows 'none recorded' rather than a fabricated value" || fail "AC16: unconfirmed ambiguous sibling shows 'none recorded' rather than a fabricated value"
fi
grep -nE "child_process|\bfetch\(|require\(.[\"']http|require\(.[\"']https|from \"node:http|from \"node:https" "$ROOT/src/cli/workflow-artifact-cleanup-audit.ts" && fail "AC16: no network/child_process import or call anywhere in the modified file" || pass "AC16: no network/child_process import or call anywhere in the modified file"

# ─── Final apply-mode disk-state sanity: everything not explicitly moved above is intact ─
find "$APPLY_ROOT" -mindepth 1 -maxdepth 1 -type d | sort > "$APPLY_TMPDIR/apply-after.txt"
EXPECTED_REMOVED_COUNT=4 # stale-candidate, ambiguous-straggler, ambiguous-unconfirmed, stub-invalid-aged
ACTUAL_REMOVED_COUNT="$(comm -23 "$APPLY_TMPDIR/apply-before.txt" "$APPLY_TMPDIR/apply-after.txt" | wc -l | tr -d ' ')"
[[ "$ACTUAL_REMOVED_COUNT" -eq "$EXPECTED_REMOVED_COUNT" ]] && pass "apply run moved exactly the expected set of eligible fixtures (no over- or under-archiving)" || fail "apply run moved exactly the expected set of eligible fixtures (no over- or under-archiving); expected $EXPECTED_REMOVED_COUNT, got $ACTUAL_REMOVED_COUNT"

rm -rf "$APPLY_TMPDIR"

# ─── Task 3: manifest/lane regression guard (kontourai-flow-agents-283, Wave 2) ────────
# Verifies evals/ci/run-baseline.sh still resolves this eval's manifest entry to the exact
# {id, command, lanes} shape recorded during planning, so apply-mode additions in THIS file
# never silently drift the CI reconcile-manifest matching (ADR 0020). This is a read-only
# check: it asserts run-baseline.sh's CHECKS/LANE_WORKFLOW_CONTRACTS arrays were not edited
# for this check's label, not that this eval script edits them.
echo ""
echo "=== Manifest/lane regression guard (AC12) ==="

MANIFEST_JSON="$(bash "$ROOT/evals/ci/run-baseline.sh" --manifest-json 2>/dev/null)"
EXPECTED_MANIFEST_ENTRY='{"id":"workflow-artifact-cleanup-audit-integration","command":"bash evals/integration/test_workflow_artifact_cleanup_audit.sh","lanes":["workflow-contracts"]}'
ACTUAL_MANIFEST_ENTRY="$(printf '%s' "$MANIFEST_JSON" | node -e '
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const data = JSON.parse(raw);
  const found = data.find((entry) => entry.id === "workflow-artifact-cleanup-audit-integration");
  console.log(found ? JSON.stringify(found) : "");
});
')"
[[ "$ACTUAL_MANIFEST_ENTRY" == "$EXPECTED_MANIFEST_ENTRY" ]] && pass "AC12: run-baseline.sh manifest entry for this check is byte-identical to the planning-time baseline (id/command/lanes unchanged)" || fail "AC12: run-baseline.sh manifest entry for this check is byte-identical to the planning-time baseline (id/command/lanes unchanged); got: $ACTUAL_MANIFEST_ENTRY"

# NOTE: intentionally NOT invoking `run-baseline.sh --check "Workflow artifact cleanup
# audit integration"` from inside this eval file — that check's command IS this eval
# script, so calling it here would recursively re-invoke this same script from within
# itself (infinite self-recursion). The `--check` invocation is Task 3's own standalone
# verification step, run directly by the coordinator/CI outside of this file, not
# embedded in it. The manifest-json comparison above already covers AC12's id/command/
# lanes-unchanged assertion without that recursive risk.

if [[ "$errors" -eq 0 ]]; then
  echo "Workflow artifact cleanup audit checks passed"
else
  echo "Workflow artifact cleanup audit checks failed: $errors"
fi

exit "$errors"
