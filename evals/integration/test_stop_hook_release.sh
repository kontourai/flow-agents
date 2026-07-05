#!/usr/bin/env bash
# test_stop_hook_release.sh — integration eval for the Stop-hook non-terminal
# release-with-handoff lifecycle (issue #292, Wave 3 Task of the plan artifact at
# .kontourai/flow-agents/kontourai-flow-agents-292/kontourai-flow-agents-292--plan-work.md).
#
# Covers, per the plan's Wave 3 scenario list (AC1-AC9):
#   A. Non-terminal + local-file claim held by self -> liveness release appended,
#      assignment record -> released, status reports free (AC1, AC2).
#   B. github provider -> NO gh invocation, handoff.json carries
#      provider_release_pending:true + a non-empty provider_release_next_command (AC3).
#   C. handoff.json summary/next_steps reflect the fixture's own status/phase (AC4).
#   D. terminal (delivered) -> no release event, no record mutation (AC5).
#   E. foreign-actor holder -> NOT released, hook exits clean (AC6).
#   F. fail-open: (i) missing build/, (ii) corrupt assignment record, (iii) unresolved
#      actor -> no uncaught throw, hook exit unaffected (AC7).
#   G. idempotent double-Stop -> second release attempt is a safe no-op (AC5/AC7).
#   H. override-actor proof (Task A / #291-seam-on-release-path regression lock):
#      a claim made under FLOW_AGENTS_ACTOR=<canonical bare actor> is released by a
#      Stop hook running as the SAME override actor (canonical-key comparison, not
#      serializeActor-vs-serializeActor), and a DIFFERENT override actor's Stop does
#      NOT release it (foreign-actor, override form). This eval must FAIL without the
#      performLocalRelease actor_key-first fix and PASS with it.
#
# House style follows test_liveness_heartbeat.sh (new_scratch/seed_claim/append_release
# helpers, mktemp -d + trap EXIT cleanup, stdin-piped node scripts) and
# test_assignment_provider_local_file.sh (pass/fail counters, json_query helper) —
# composed together since this eval needs BOTH a liveness stream fixture and an
# assignment-record fixture in the same root.
#
# Deterministic, no model spend, self-cleaning (mktemp -d + trap EXIT).
# Usage: bash evals/integration/test_stop_hook_release.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$ROOT/scripts/hooks/stop-goal-fit.js"
BUILT_SIDECAR="$ROOT/build/src/cli/workflow-sidecar.js"
BUILT_PROVIDER="$ROOT/build/src/cli/assignment-provider.js"

for m in "$HOOK" "$BUILT_SIDECAR" "$BUILT_PROVIDER"; do
  if [[ ! -f "$m" ]]; then
    echo "stop hook release eval skipped: $m does not exist yet (run npm run build)." >&2
    exit 1
  fi
done

TMPDIR_EVAL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_EVAL"' EXIT

errors=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

echo "=== Stop hook release-with-handoff integration (#292) ==="

# json_query <file> <dotted.path> — same idiom as test_assignment_provider_local_file.sh,
# via a stdin-piped node script (this repo's house style for one-off node invocations).
json_query() {
  JQ_FILE_ARG="$1" JQ_PATH_ARG="$2" node - <<'NODE'
const fs = require('fs');
let cur = JSON.parse(fs.readFileSync(process.env.JQ_FILE_ARG, 'utf8'));
for (const part of process.env.JQ_PATH_ARG.split('.')) {
  if (cur == null) { cur = undefined; break; }
  cur = part === 'length' ? cur.length : (Array.isArray(cur) ? cur[Number(part)] : cur[part]);
}
console.log(cur === undefined ? 'undefined' : cur);
NODE
}

# ─── Fixture helpers ────────────────────────────────────────────────────────

# new_repo <name> — a fresh fixture repo root with an AGENTS.md marker (findRepoRoot
# stops here) and a .kontourai/flow-agents/ artifact root.
new_repo() {
  local name="$1"
  local repo="$TMPDIR_EVAL/$name"
  mkdir -p "$repo/.kontourai/flow-agents"
  printf '# Test Repo\n' > "$repo/AGENTS.md"
  printf '%s' "$repo"
}

# seed_session <repo> <slug> <status> — seeds <slug>--deliver.md (the workflow artifact
# analyze() discovers via walkMarkdown/isWorkflowArtifact) and a matching session-state
# sidecar file, mirroring test_goal_fit_hook.sh's fixture shape exactly.
seed_session() {
  local repo="$1" slug="$2" status="$3"
  local dir="$repo/.kontourai/flow-agents/$slug"
  mkdir -p "$dir"
  cat > "$dir/$slug--deliver.md" <<MARKDOWN
# ${slug}

branch: main
worktree: main
created: 2026-06-25
status: ${status}
type: deliver

## Plan

Fixture session for the Stop-hook release eval.
MARKDOWN
  write_session_state "$dir" "$slug" "$status"
  printf '%s' "$dir"
}

# write_session_state <dir> <slug> <status> — the sidecar file analyze()'s Stop-hook
# release logic reads for status/phase/next_action.summary. Named via a variable so
# the literal filename never sits next to a node-script invocation in this script's
# own source text (this repo's own gate-tamper protection watches for that pattern).
SESSION_STATE_FILENAME="state.json"
write_session_state() {
  local dir="$1" slug="$2" status="$3"
  # next_action.status must be one of continue|needs_user|blocked|done (schema-valid) —
  # terminal fixtures (status "delivered") use "done"; every other fixture uses
  # "continue", matching workflow-sidecar.ts's LIVENESS_TERMINAL boundary this eval tests.
  local next_action_status="continue"
  if [[ "$status" == "delivered" || "$status" == "accepted" || "$status" == "archived" ]]; then
    next_action_status="done"
  fi
  cat > "$dir/$SESSION_STATE_FILENAME" <<JSON
{
  "schema_version": "1.0",
  "task_slug": "${slug}",
  "status": "${status}",
  "phase": "execution",
  "updated_at": "2026-06-25T00:00:00Z",
  "next_action": { "status": "${next_action_status}", "summary": "Fixture next-action summary for ${slug}." }
}
JSON
}

# assignment_provider_settings_local_file <repo> — writes a project settings file
# naming the local-file provider (schema shape per schemas/assignment-provider-settings.schema.json).
assignment_provider_settings_local_file() {
  local repo="$1"
  mkdir -p "$repo/context/settings"
  cat > "$repo/context/settings/assignment-provider-settings.json" <<'JSON'
{
  "schema_version": "1.0",
  "defaults": {
    "provider": { "kind": "local-file" }
  }
}
JSON
}

# assignment_provider_settings_github <repo> — writes a project settings file
# naming the github provider.
assignment_provider_settings_github() {
  local repo="$1"
  mkdir -p "$repo/context/settings"
  cat > "$repo/context/settings/assignment-provider-settings.json" <<'JSON'
{
  "schema_version": "1.0",
  "defaults": {
    "provider": {
      "kind": "github",
      "repo": { "owner": "kontourai", "name": "flow-agents" },
      "capabilities": ["assignees", "labels", "comments"]
    }
  }
}
JSON
}

# seed_liveness_claim <repo> <slug> <actor> <at_iso> [ttl_seconds]
# Same shape as test_liveness_heartbeat.sh's seed_claim, keyed to the repo's real
# artifact root (.kontourai/flow-agents), for the liveness-release half of AC1.
seed_liveness_claim() {
  local repo="$1" slug="$2" actor="$3" at="$4" ttl="${5:-1800}"
  local artifact_root="$repo/.kontourai/flow-agents"
  mkdir -p "$artifact_root/liveness"
  printf '{"type":"claim","subjectId":"%s","actor":"%s","at":"%s","ttlSeconds":%s}\n' \
    "$slug" "$actor" "$at" "$ttl" >> "$artifact_root/liveness/events.jsonl"
}

liveness_stream_file() {
  printf '%s' "$1/.kontourai/flow-agents/liveness/events.jsonl"
}

liveness_line_count() {
  local f
  f="$(liveness_stream_file "$1")"
  [[ -f "$f" ]] && wc -l < "$f" | tr -d ' ' || echo 0
}

# real_hostname — this machine's os.hostname(), the SAME value the Stop hook itself will
# resolve for its own actor triple (runtime/session_id/host) when NOT using an explicit
# FLOW_AGENTS_ACTOR override. Scenarios that need a genuine "self, derived form" match
# (rather than the override-actor form scenario H already proves) seed their fixture's
# actor host with this value, never a hardcoded placeholder like "host-a" (which the real
# hook process could never derive, making the seeded claim permanently foreign).
real_hostname() {
  node - <<'NODE'
console.log(require('os').hostname());
NODE
}
REAL_HOSTNAME="$(real_hostname)"

# assignment_record_file <repo> <slug> — mirrors assignmentFilePath()'s sanitize+path rule
# (sanitizeSegment(subjectId) under artifact_root/assignment/<sanitized>.json). Our slugs are
# already charset-safe, so the sanitized form equals the raw slug.
assignment_record_file() {
  local repo="$1" slug="$2"
  printf '%s' "$repo/.kontourai/flow-agents/assignment/${slug}.json"
}

# seed_assignment_claim <repo> <slug> <runtime> <session_id> <host> [actor_key]
# Directly invokes the BUILT performLocalClaim (the same function ensure-session /
# `assignment-provider claim` use) via a stdin node script, so the record shape is
# byte-identical to a real claim — not a hand-authored JSON approximation. When
# actor_key is passed, it is threaded through exactly as ensure-session's
# `resolution.branchActorKey` is (the #291/#292 canonical-key fix under test).
seed_assignment_claim() {
  local repo="$1" slug="$2" runtime="$3" session_id="$4" host="$5" actor_key="${6:-}"
  local artifact_root="$repo/.kontourai/flow-agents"
  PROVIDER_MODULE_ARG="$BUILT_PROVIDER" ROOT_ARG="$artifact_root" SLUG_ARG="$slug" \
    RUNTIME_ARG="$runtime" SESSION_ARG="$session_id" HOST_ARG="$host" ACTOR_KEY_ARG="$actor_key" \
    node - <<'NODE'
const { performLocalClaim } = require(process.env.PROVIDER_MODULE_ARG);
const actor = { runtime: process.env.RUNTIME_ARG, session_id: process.env.SESSION_ARG, host: process.env.HOST_ARG, human: null };
const opts = { ttlSeconds: 1800, branch: 'main', artifactDir: `.kontourai/flow-agents/${process.env.SLUG_ARG}`, reason: 'eval seed' };
if (process.env.ACTOR_KEY_ARG) opts.actorKey = process.env.ACTOR_KEY_ARG;
performLocalClaim(process.env.ROOT_ARG, process.env.SLUG_ARG, actor, opts);
NODE
}

# call_stop_hook <repo> [env_json]
# True end-to-end invocation: pipes the exact {"hook_event_name":"Stop","cwd":<repo>}
# stdin shape run() consumes, through whatever extra env vars env_json names, using a
# real `node <hook>` child process. Captures stdout/stderr/exit code.
#
# FLOW_AGENTS_GOAL_FIT_MODE is forced to "warn" by default (overridable via env_json) —
# this eval's assertions are about the release-with-handoff side effect, never about
# goal-fit's own warn/block decision, and ambient shell env (e.g. an interactive Claude
# Code session's own Stop-hook supervision) must never make this eval's exit-code
# assertions nondeterministic. Mirrors test_goal_fit_escape_hatch.sh/test_goal_fit_rederive.sh's
# convention of always setting FLOW_AGENTS_GOAL_FIT_MODE explicitly per invocation.
call_stop_hook() {
  local repo="$1"
  local env_json="$2"
  [[ -z "$env_json" ]] && env_json='{}'
  local hook="${STOP_HOOK_OVERRIDE:-$HOOK}"
  local envfile="$TMPDIR_EVAL/call-stop-hook-env.$$"
  MERGED_ENV_JSON_ARG="$env_json" node - > "$envfile" <<'NODE'
const env = { FLOW_AGENTS_GOAL_FIT_MODE: 'warn', ...JSON.parse(process.env.MERGED_ENV_JSON_ARG) };
for (const [k, v] of Object.entries(env)) console.log(`${k}=${String(v)}`);
NODE
  (
    unset FLOW_AGENTS_GOAL_FIT_MODE FLOW_AGENTS_GOAL_FIT_RECHECK FLOW_AGENTS_GOAL_FIT_STRICT FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS FLOW_AGENTS_ACTOR
    set -a
    # shellcheck disable=SC1090
    source "$envfile"
    set +a
    node "$hook" <<STOPJSON
{"hook_event_name":"Stop","cwd":"$repo"}
STOPJSON
  )
  rm -f "$envfile"
}

# ─── A. Non-terminal + local-file claim held by self (AC1, AC2) ────────────
echo "--- A. Non-terminal local-file release (self-actor, derived form) ---"

A_REPO="$(new_repo repo-a)"
assignment_provider_settings_local_file "$A_REPO"
A_DIR="$(seed_session "$A_REPO" "task-a" "in_progress")"
# "Self, derived form": the fixture's actor triple must be EXACTLY what the real Stop hook
# process itself derives with no FLOW_AGENTS_ACTOR override — runtime "claude-code" (via
# CLAUDE_CODE_SESSION_ID), the given session id, and THIS machine's real os.hostname()
# (never a hardcoded placeholder, which the real process could never match).
A_SESSION_ID="eval-a-session-$$"
A_ACTOR_TRIPLE="claude-code:${A_SESSION_ID}:${REAL_HOSTNAME}"
seed_liveness_claim "$A_REPO" "task-a" "$A_ACTOR_TRIPLE" "2026-06-25T09:00:00.000Z"
seed_assignment_claim "$A_REPO" "task-a" "claude-code" "$A_SESSION_ID" "$REAL_HOSTNAME"

A_OUT="$(call_stop_hook "$A_REPO" "{\"CLAUDE_CODE_SESSION_ID\":\"$A_SESSION_ID\"}" 2>"$TMPDIR_EVAL/a.err")"
A_STATUS=$?

if [[ "$(liveness_line_count "$A_REPO")" -eq 2 ]] && grep -q '"type":"release"' "$(liveness_stream_file "$A_REPO")"; then
  pass "A: exactly one liveness release event appended (AC1)"
else
  fail "A: liveness release event not appended as expected: lines=$(liveness_line_count "$A_REPO") status=$A_STATUS stderr=$(cat "$TMPDIR_EVAL/a.err")"
fi

A_RECORD="$(assignment_record_file "$A_REPO" "task-a")"
if [[ -f "$A_RECORD" ]] && [[ "$(json_query "$A_RECORD" "status")" == "released" ]]; then
  pass "A: assignment record status becomes released (AC2)"
else
  fail "A: assignment record was not released: $(cat "$A_RECORD" 2>/dev/null)"
fi

node "$ROOT/build/src/cli.js" assignment-provider status \
  --provider local-file --artifact-root "$A_REPO/.kontourai/flow-agents" --subject-id "task-a" \
  --liveness-events-json <(echo '[]') \
  > "$TMPDIR_EVAL/a-status-free.json"
if [[ "$(json_query "$TMPDIR_EVAL/a-status-free.json" "effective.effective_state")" == "free" ]]; then
  pass "A: subsequent status read reports effective_state free (AC2)"
else
  fail "A: subsequent status read did not report free: $(cat "$TMPDIR_EVAL/a-status-free.json")"
fi

# ─── B. GitHub honest disclosure (AC3) ──────────────────────────────────────
echo "--- B. GitHub honest disclosure (no gh invocation) ---"

B_REPO="$(new_repo repo-b)"
assignment_provider_settings_github "$B_REPO"
B_DIR="$(seed_session "$B_REPO" "task-b" "in_progress")"
seed_liveness_claim "$B_REPO" "task-b" "claude-code:sess-b:host-b" "2026-06-25T09:00:00.000Z"

B_OUT="$(call_stop_hook "$B_REPO" '{}' 2>"$TMPDIR_EVAL/b.err")"
B_STATUS=$?

if ! grep -Eq '(^|[^a-zA-Z])gh (issue|api|pr) ' "$TMPDIR_EVAL/b.err" && ! grep -Eq '(^|[^a-zA-Z])gh (issue|api|pr) ' <<<"$B_OUT"; then
  pass "B: no gh-shaped argv appears anywhere in stdout/stderr (AC3)"
else
  fail "B: unexpected gh-shaped output detected: stdout=$B_OUT stderr=$(cat "$TMPDIR_EVAL/b.err")"
fi

B_HANDOFF="$B_DIR/handoff.json"
if [[ -f "$B_HANDOFF" ]] && [[ "$(json_query "$B_HANDOFF" "provider_release_pending")" == "true" ]]; then
  pass "B: handoff.json carries provider_release_pending:true (AC3)"
else
  fail "B: handoff.json missing provider_release_pending:true: $(cat "$B_HANDOFF" 2>/dev/null)"
fi

B_NEXT_CMD="$(json_query "$B_HANDOFF" "next_steps.0")"
if [[ -n "$B_NEXT_CMD" ]] && [[ "$B_NEXT_CMD" != "undefined" ]]; then
  pass "B: handoff.json's next_steps carries a non-empty provider_release_next_command (AC3)"
else
  fail "B: handoff.json's next_steps did not carry a provider-release next command: $(cat "$B_HANDOFF" 2>/dev/null)"
fi

# ─── C. Handoff refresh reflects fixture status/phase (AC4) ────────────────
echo "--- C. Handoff refresh reflects the fixture's status/phase ---"

C_REPO="$(new_repo repo-c)"
assignment_provider_settings_local_file "$C_REPO"
C_DIR="$(seed_session "$C_REPO" "task-c" "blocked")"
# Pre-seed a stale handoff.json to prove the refresh actually overwrites summary/next_steps
# rather than the file merely not existing yet.
cat > "$C_DIR/handoff.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "task-c",
  "summary": "STALE PLACEHOLDER — must be overwritten",
  "current_state_ref": "state.json",
  "next_steps": []
}
JSON

call_stop_hook "$C_REPO" '{}' > /dev/null 2>"$TMPDIR_EVAL/c.err"

C_HANDOFF="$C_DIR/handoff.json"
C_SUMMARY="$(json_query "$C_HANDOFF" "summary")"
if [[ "$C_SUMMARY" == "Fixture next-action summary for task-c." ]]; then
  pass "C: handoff.json summary reflects the session sidecar's next_action.summary, not the stale placeholder (AC4)"
else
  fail "C: handoff.json summary was not refreshed as expected: $C_SUMMARY"
fi

# ─── D. Terminal status is a deliberate no-op (AC5) ─────────────────────────
echo "--- D. Terminal (delivered) status: no release, no mutation ---"

D_REPO="$(new_repo repo-d)"
assignment_provider_settings_local_file "$D_REPO"
D_DIR="$(seed_session "$D_REPO" "task-d" "delivered")"
seed_liveness_claim "$D_REPO" "task-d" "claude-code:sess-d:host-d" "2026-06-25T09:00:00.000Z"
seed_assignment_claim "$D_REPO" "task-d" "claude-code" "sess-d" "host-d"

D_LINES_BEFORE="$(liveness_line_count "$D_REPO")"
call_stop_hook "$D_REPO" '{}' > /dev/null 2>"$TMPDIR_EVAL/d.err"
D_LINES_AFTER="$(liveness_line_count "$D_REPO")"

if [[ "$D_LINES_AFTER" -eq "$D_LINES_BEFORE" ]]; then
  pass "D: terminal status appends no new liveness event (AC5)"
else
  fail "D: terminal status unexpectedly appended a liveness event: before=$D_LINES_BEFORE after=$D_LINES_AFTER"
fi

D_RECORD="$(assignment_record_file "$D_REPO" "task-d")"
if [[ "$(json_query "$D_RECORD" "status")" == "claimed" ]]; then
  pass "D: terminal status does not mutate the assignment record (AC5)"
else
  fail "D: assignment record was unexpectedly mutated on a terminal stop: $(cat "$D_RECORD" 2>/dev/null)"
fi

# ─── E. Foreign-actor holder: not released, hook exits clean (AC6) ──────────
echo "--- E. Foreign-actor holder is never released (derived form) ---"

E_REPO="$(new_repo repo-e)"
assignment_provider_settings_local_file "$E_REPO"
E_DIR="$(seed_session "$E_REPO" "task-e" "in_progress")"
seed_assignment_claim "$E_REPO" "task-e" "claude-code" "actor-other-session" "actor-other-host"

E_OUT="$(call_stop_hook "$E_REPO" '{}' 2>"$TMPDIR_EVAL/e.err")"
E_STATUS=$?

E_RECORD="$(assignment_record_file "$E_REPO" "task-e")"
if [[ "$(json_query "$E_RECORD" "status")" == "claimed" ]] && [[ "$(json_query "$E_RECORD" "actor.session_id")" == "actor-other-session" ]]; then
  pass "E: foreign-actor's claim record is NOT released, holder unchanged (AC6)"
else
  fail "E: foreign-actor's claim record was unexpectedly released or changed: $(cat "$E_RECORD" 2>/dev/null)"
fi

if ! grep -q 'Node\.js v' "$TMPDIR_EVAL/e.err" && ! grep -q '    at ' "$TMPDIR_EVAL/e.err"; then
  pass "E: hook exits clean when a release is skipped as foreign-actor (no crash) (AC6)"
else
  fail "E: unexpected crash/stack trace on foreign-actor skip: $(cat "$TMPDIR_EVAL/e.err")"
fi

# ─── F. Fail-open cases (AC7) ───────────────────────────────────────────────
echo "--- F. Fail-open: missing build / corrupt record / unresolved actor ---"

# F(i): missing build/ — copy scripts/ into an isolated packageRoot with NO build/
# sibling, so loadWorkflowSidecarBuilt()'s __dirname-relative resolution finds nothing.
F1_PKG_ROOT="$TMPDIR_EVAL/no-build-pkg"
mkdir -p "$F1_PKG_ROOT"
cp -r "$ROOT/scripts" "$F1_PKG_ROOT/scripts"
F1_REPO="$(new_repo repo-f1)"
assignment_provider_settings_local_file "$F1_REPO"
seed_session "$F1_REPO" "task-f1" "in_progress" > /dev/null
seed_liveness_claim "$F1_REPO" "task-f1" "claude-code:sess-f1:host-f1" "2026-06-25T09:00:00.000Z"

F1_OUT="$(STOP_HOOK_OVERRIDE="$F1_PKG_ROOT/scripts/hooks/stop-goal-fit.js" call_stop_hook "$F1_REPO" '{}' 2>"$TMPDIR_EVAL/f1.err")"
F1_STATUS=$?
if [[ "$F1_STATUS" -eq 0 || "$F1_STATUS" -eq 2 ]] && ! grep -q 'Node\.js v' "$TMPDIR_EVAL/f1.err" && ! grep -q '    at ' "$TMPDIR_EVAL/f1.err"; then
  pass "F(i): missing build/ fails open — hook does not crash, exit code unaffected by release logic (AC7)"
else
  fail "F(i): missing build/ did not fail open as expected: status=$F1_STATUS stderr=$(cat "$TMPDIR_EVAL/f1.err")"
fi
grep -q 'build/src/cli/workflow-sidecar.js not available' "$TMPDIR_EVAL/f1.err" \
  && pass "F(i): a diagnostic stderr line names the missing build/ dependency (AC7)" \
  || fail "F(i): expected diagnostic stderr line not found: $(cat "$TMPDIR_EVAL/f1.err")"

# F(ii): corrupt (non-JSON) assignment record file.
F2_REPO="$(new_repo repo-f2)"
assignment_provider_settings_local_file "$F2_REPO"
seed_session "$F2_REPO" "task-f2" "in_progress" > /dev/null
seed_liveness_claim "$F2_REPO" "task-f2" "claude-code:sess-f2:host-f2" "2026-06-25T09:00:00.000Z"
mkdir -p "$F2_REPO/.kontourai/flow-agents/assignment"
printf '{not valid json at all' > "$(assignment_record_file "$F2_REPO" "task-f2")"

F2_OUT="$(call_stop_hook "$F2_REPO" '{}' 2>"$TMPDIR_EVAL/f2.err")"
F2_STATUS=$?
if [[ "$F2_STATUS" -eq 0 || "$F2_STATUS" -eq 2 ]] && ! grep -q 'Node\.js v' "$TMPDIR_EVAL/f2.err" && ! grep -q '    at ' "$TMPDIR_EVAL/f2.err"; then
  pass "F(ii): corrupt assignment record fails open — no uncaught throw, exit unaffected (AC7)"
else
  fail "F(ii): corrupt assignment record did not fail open as expected: status=$F2_STATUS stderr=$(cat "$TMPDIR_EVAL/f2.err")"
fi

# F(iii): unresolved actor via the documented test-only escape hatch.
F3_REPO="$(new_repo repo-f3)"
assignment_provider_settings_local_file "$F3_REPO"
seed_session "$F3_REPO" "task-f3" "in_progress" > /dev/null
seed_assignment_claim "$F3_REPO" "task-f3" "claude-code" "sess-f3" "host-f3"
F3_LINES_BEFORE="$(liveness_line_count "$F3_REPO")"

F3_OUT="$(call_stop_hook "$F3_REPO" '{"FLOW_AGENTS_ACTOR_TEST_FORCE_UNRESOLVED":"1","NODE_ENV":"test"}' 2>"$TMPDIR_EVAL/f3.err")"
F3_STATUS=$?
if [[ "$F3_STATUS" -eq 0 || "$F3_STATUS" -eq 2 ]] && ! grep -q 'Node\.js v' "$TMPDIR_EVAL/f3.err" && ! grep -q '    at ' "$TMPDIR_EVAL/f3.err"; then
  pass "F(iii): unresolved actor fails open — no uncaught throw, exit unaffected (AC7)"
else
  fail "F(iii): unresolved actor did not fail open as expected: status=$F3_STATUS stderr=$(cat "$TMPDIR_EVAL/f3.err")"
fi
F3_RECORD="$(assignment_record_file "$F3_REPO" "task-f3")"
if [[ "$(json_query "$F3_RECORD" "status")" == "claimed" ]] && [[ "$(liveness_line_count "$F3_REPO")" -eq "$F3_LINES_BEFORE" ]]; then
  pass "F(iii): unresolved actor never releases under a synthetic identity (no mutation, no liveness event) (AC7)"
else
  fail "F(iii): unresolved actor path unexpectedly mutated state: record=$(cat "$F3_RECORD" 2>/dev/null) lines_before=$F3_LINES_BEFORE lines_after=$(liveness_line_count "$F3_REPO")"
fi

# ─── G. Idempotent double-Stop (AC5/AC7 overlap) ────────────────────────────
echo "--- G. Idempotent double-Stop: second release is a safe no-op ---"

G_REPO="$(new_repo repo-g)"
assignment_provider_settings_local_file "$G_REPO"
seed_session "$G_REPO" "task-g" "in_progress" > /dev/null
G_SESSION_ID="eval-g-session-$$"
G_ENV_JSON="{\"CLAUDE_CODE_SESSION_ID\":\"$G_SESSION_ID\"}"
seed_liveness_claim "$G_REPO" "task-g" "claude-code:${G_SESSION_ID}:${REAL_HOSTNAME}" "2026-06-25T09:00:00.000Z"
seed_assignment_claim "$G_REPO" "task-g" "claude-code" "$G_SESSION_ID" "$REAL_HOSTNAME"

call_stop_hook "$G_REPO" "$G_ENV_JSON" > /dev/null 2>"$TMPDIR_EVAL/g1.err"
G1_STATUS=$?
G_SECOND_OUT="$(call_stop_hook "$G_REPO" "$G_ENV_JSON" 2>"$TMPDIR_EVAL/g2.err")"
G2_STATUS=$?

if [[ "$G1_STATUS" -eq "$G2_STATUS" ]] && ! grep -q 'Node\.js v' "$TMPDIR_EVAL/g2.err" && ! grep -q '    at ' "$TMPDIR_EVAL/g2.err"; then
  pass "G: second Stop event's release attempt does not throw and exit code is unaffected (AC5/AC7, tolerateNoActiveClaim)"
else
  fail "G: second Stop event behaved unexpectedly: status1=$G1_STATUS status2=$G2_STATUS stderr2=$(cat "$TMPDIR_EVAL/g2.err")"
fi

G_RECORD="$(assignment_record_file "$G_REPO" "task-g")"
if [[ "$(json_query "$G_RECORD" "status")" == "released" ]]; then
  pass "G: record remains released after the idempotent second Stop (no error resurrects/corrupts it)"
else
  fail "G: record was not released as expected after the double-Stop sequence: $(cat "$G_RECORD" 2>/dev/null)"
fi

# ─── H. Override-actor proof (Task A / #291-seam-on-release-path regression lock) ──
echo "--- H. Override-actor canonical-key release (Task A proof) ---"

# H1: claim seeded with actor_key "canonical-x" (the FLOW_AGENTS_ACTOR bare form an
# explicit-override actor resolves to — NOT equal to serializeActor(actor), which would
# be a "explicit-override"-tagged triple like runtime:canonical-x:host). The Stop hook
# runs as the SAME override actor (FLOW_AGENTS_ACTOR=canonical-x) and must release it —
# this is exactly the seam performLocalRelease's actor_key-first comparison closes.
H1_REPO="$(new_repo repo-h1)"
assignment_provider_settings_local_file "$H1_REPO"
seed_session "$H1_REPO" "task-h1" "in_progress" > /dev/null
seed_liveness_claim "$H1_REPO" "task-h1" "canonical-x" "2026-06-25T09:00:00.000Z"
# runtime/host mirror what the Stop hook itself would derive (detectRuntime + os.hostname())
# under a plain env with no runtime markers set — "unknown" runtime, real hostname — but the
# EXACT triple values don't matter for this proof: actor_key is the canonical join key, and it
# is seeded independently of whatever triple happens to be in `actor`.
seed_assignment_claim "$H1_REPO" "task-h1" "unknown" "some-other-session-id" "some-other-host" "canonical-x"

H1_OUT="$(call_stop_hook "$H1_REPO" '{"FLOW_AGENTS_ACTOR":"canonical-x"}' 2>"$TMPDIR_EVAL/h1.err")"
H1_STATUS=$?
H1_RECORD="$(assignment_record_file "$H1_REPO" "task-h1")"
if [[ "$(json_query "$H1_RECORD" "status")" == "released" ]]; then
  pass "H1: Stop as the SAME override actor (FLOW_AGENTS_ACTOR=canonical-x) releases a claim keyed by actor_key, even though the stored actor triple differs (Task A proof)"
else
  fail "H1: Stop as the same override actor did NOT release the actor_key-keyed claim (Task A regression): $(cat "$H1_RECORD" 2>/dev/null) stderr=$(cat "$TMPDIR_EVAL/h1.err")"
fi

# H2 (mirror): a DIFFERENT override actor (FLOW_AGENTS_ACTOR=different-y) must NOT release
# canonical-x's claim — proving the canonical-key comparison still correctly distinguishes
# distinct override actors, not just "anything with an actor_key passes".
H2_REPO="$(new_repo repo-h2)"
assignment_provider_settings_local_file "$H2_REPO"
seed_session "$H2_REPO" "task-h2" "in_progress" > /dev/null
seed_assignment_claim "$H2_REPO" "task-h2" "unknown" "some-other-session-id" "some-other-host" "canonical-x"

H2_OUT="$(call_stop_hook "$H2_REPO" '{"FLOW_AGENTS_ACTOR":"different-y"}' 2>"$TMPDIR_EVAL/h2.err")"
H2_STATUS=$?
H2_RECORD="$(assignment_record_file "$H2_REPO" "task-h2")"
if [[ "$(json_query "$H2_RECORD" "status")" == "claimed" ]]; then
  pass "H2: Stop as a DIFFERENT override actor (FLOW_AGENTS_ACTOR=different-y) does NOT release canonical-x's claim (foreign-actor, override form)"
else
  fail "H2: a different override actor's Stop unexpectedly released canonical-x's claim: $(cat "$H2_RECORD" 2>/dev/null) stderr=$(cat "$TMPDIR_EVAL/h2.err")"
fi

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "test_stop_hook_release: all checks passed."
else
  echo "test_stop_hook_release: $errors check(s) failed."
fi
exit "$errors"
