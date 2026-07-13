#!/usr/bin/env bash
# test_ensure_session_ownership_guard.sh — ensure-session's pre-entry ownership guard (#291).
#
# Exercises `enforceEnsureSessionOwnership()` (src/cli/workflow-sidecar.ts) against a temp
# ARTIFACT_ROOT, reusing #290's local-file assignment ⋈ liveness join
# (`computeEffectiveState`/`performLocalClaim`/`performLocalSupersede`, exported in
# src/cli/assignment-provider.ts). Fully deterministic: two fixed test-actor identities
# (--actor eval-actor-a-session / eval-actor-b-session), no network, no `gh` process. Follows
# test_assignment_provider_local_file.sh's pass/fail/json_query idiom exactly.
#
# Plan sections (see .kontourai/flow-agents/kontourai-flow-agents-291/
# kontourai-flow-agents-291--plan-work.md, Wave 3 "Ownership-guard eval"):
#   1. Actor A ensure-session on a free subject → exit 0; a durable local-file claim is
#      established (AC5).
#   2. Actor B ensure-session on the SAME subject while A's claim is fresh (a real liveness event
#      is manufactured so the join classifies it `held`, not merely `reclaimable`) → exit nonzero,
#      naming A's holder identity (AC1); plus two hostile-string sanitization variants (AC9): a
#      crafted hostile LIVENESS event (liveness-only holder, no assignment record) and the
#      `hostile-effective-state.json` fixture via --effective-state-json (github-style hostile
#      assignee string).
#   3. Actor A re-running ensure-session on its OWN subject → exit 0, no refusal (AC4).
#   4. A manufactured stale claim (real assignment record + a liveness event whose `at` is well
#      past its ttlSeconds) → refuses without --supersede-stale (naming the flag), succeeds with
#      --supersede-stale (AC2, both halves; audit-trail supersede entry confirmed).
#   5. A human-held fixture (assignment record with actor.human set) → any actor's ensure-session
#      → exit nonzero, ask-first remediation, no auto-reclaim (AC3).
#   6. Concurrency: two REAL, concurrently-launched ensure-session processes on the same fresh
#      subject (background `&` + `wait`, genuine OS-process concurrency, not a sequential
#      simulation) → exactly one becomes the confirmed holder; the assignment record stays valid,
#      single-holder, single-audit-entry JSON (no corrupted/partial write, no double claim) (AC6).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

CLI="$ROOT/build/src/cli.js"
FIXTURES="$ROOT/evals/fixtures/assignment-provider"
HOSTILE_EFFECTIVE_STATE_FIXTURE="$FIXTURES/hostile-effective-state.json"
ACTOR_IDENTITY_HELPER="$ROOT/scripts/hooks/lib/actor-identity.js"

TMPDIR_EVAL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_EVAL"' EXIT
ARTIFACT_ROOT="$TMPDIR_EVAL/artifact-root"

errors=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

json_query() {
  node -e 'const fs=require("fs"); let cur=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); for (const part of process.argv[2].split(".")) cur=part==="length" ? cur.length : (Array.isArray(cur) ? cur[Number(part)] : cur[part]); console.log(cur);' "$1" "$2"
}

# actor_key_from_record <assignment-record.json> — recomputes the SAME holderActorKey
# computeEffectiveState (src/cli/assignment-provider.ts) itself derives: record.actor_key when
# present (F1 fix, fix-plan iteration 1 — the canonical resolveActor().actor string
# performLocalClaim/performLocalSupersede now persist), else serializeActor(record.actor) as a
# back-compat fallback for any pre-F1 record with no actor_key field. The eval never hand-derives
# (and risks drifting from) the actual holder-key format ensure-session's guard produces for an
# explicit --actor override.
actor_key_from_record() {
  node -e '
const fs = require("fs");
const { serializeActor } = require(process.argv[1]);
const rec = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
process.stdout.write(rec.actor_key || serializeActor(rec.actor));
' "$ACTOR_IDENTITY_HELPER" "$1"
}

# append_liveness_event <root> <subjectId> <actor> <at-iso> [ttlSeconds]
append_liveness_event() {
  local root="$1" subject="$2" actor="$3" at="$4" ttl="${5:-1800}"
  mkdir -p "$root/liveness"
  node -e '
const fs = require("fs");
const evt = { type: "claim", subjectId: process.argv[1], actor: process.argv[2], at: process.argv[3], ttlSeconds: Number(process.argv[4]) };
fs.appendFileSync(process.argv[5], JSON.stringify(evt) + "\n");
' "$subject" "$actor" "$at" "$ttl" "$root/liveness/events.jsonl"
}

if [[ ! -f "$CLI" ]]; then
  echo "build/src/cli.js not found — run 'npm run build' first" >&2
  exit 1
fi
flow_agents_build_ts || { echo "build failed" >&2; exit 1; }

echo "=== ensure-session ownership guard (#291) ==="

# ─── 1. Actor A claims a free subject via ensure-session (AC5) ─────────────────────────────
echo "--- 1. free subject: ensure-session establishes a durable claim (AC5) ---"

SUBJECT_WORK_ITEM="kontourai/flow-agents#9101"
SLUG="kontourai-flow-agents-9101"

if flow_agents_node "workflow-sidecar" ensure-session \
  --artifact-root "$ARTIFACT_ROOT" \
  --work-item "$SUBJECT_WORK_ITEM" \
  --actor eval-actor-a-session \
  --source-request "Actor A claims a free subject." \
  --summary "Actor A establishes the first claim on a free subject." \
  >"$TMPDIR_EVAL/a-ensure.out" 2>"$TMPDIR_EVAL/a-ensure.err"; then
  pass "actor A's ensure-session on a free subject exits 0 (AC5)"
else
  fail "actor A's ensure-session on a free subject unexpectedly failed: $(cat "$TMPDIR_EVAL/a-ensure.out" "$TMPDIR_EVAL/a-ensure.err")"
fi

node "$CLI" assignment-provider status \
  --provider local-file --artifact-root "$ARTIFACT_ROOT" --subject-id "$SLUG" \
  > "$TMPDIR_EVAL/status-after-a.json"
[[ "$(json_query "$TMPDIR_EVAL/status-after-a.json" "assignment.record.status")" == "claimed" ]] && pass "assignment-provider status confirms a durable claim record exists for actor A (AC5)" || fail "assignment-provider status did not show a durable claim record for actor A: $(cat "$TMPDIR_EVAL/status-after-a.json")"
[[ "$(json_query "$TMPDIR_EVAL/status-after-a.json" "assignment.assignee")" == *"eval-actor-a-session"* ]] && pass "assignment-provider status reports actor A as the claim holder (AC5)" || fail "assignment-provider status did not report actor A as holder: $(cat "$TMPDIR_EVAL/status-after-a.json")"

A_RECORD="$ARTIFACT_ROOT/assignment/$SLUG.json"
[[ -f "$A_RECORD" ]] && pass "ensure-session's free-branch claim wrote assignment/$SLUG.json (AC5)" || fail "ensure-session's free-branch claim did not write assignment/$SLUG.json"
ACTOR_KEY_A="$(actor_key_from_record "$A_RECORD")"
[[ -n "$ACTOR_KEY_A" ]] && pass "actor A's serialized actor key was recovered from the on-disk record" || fail "could not recover actor A's serialized actor key from the on-disk record"

# ─── 2. Actor B refused on A's fresh claim (AC1), plus two AC9 sanitization variants ────────
echo "--- 2. fresh other-actor claim refuses entry (AC1); hostile-string sanitization (AC9) ---"

NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
append_liveness_event "$ARTIFACT_ROOT" "$SLUG" "$ACTOR_KEY_A" "$NOW_ISO" 1800

if flow_agents_node "workflow-sidecar" ensure-session \
  --artifact-root "$ARTIFACT_ROOT" \
  --work-item "$SUBJECT_WORK_ITEM" \
  --actor eval-actor-b-session \
  --source-request "Actor B attempts to enter A's fresh claim." \
  --summary "Actor B should be refused." \
  >"$TMPDIR_EVAL/b-ensure.out" 2>"$TMPDIR_EVAL/b-ensure.err"; then
  fail "actor B's ensure-session on A's fresh-held subject should have exited nonzero (AC1)"
else
  pass "actor B's ensure-session on A's fresh-held subject exits nonzero (AC1)"
fi
grep -qF "eval-actor-a-session" "$TMPDIR_EVAL/b-ensure.err" && pass "refusal message names actor A's holder identity (AC1)" || fail "refusal message did not name actor A's holder identity: $(cat "$TMPDIR_EVAL/b-ensure.err")"
grep -qiF "takeover" "$TMPDIR_EVAL/b-ensure.err" && pass "refusal message offers remediation (pick different work or consider a takeover) (AC1)" || fail "refusal message lacked remediation text: $(cat "$TMPDIR_EVAL/b-ensure.err")"

B_DIR="$ARTIFACT_ROOT/$SLUG"
# A's session dir already legitimately exists (A owns it, from section 1) — a refused entry must
# never leave any trace of actor B's identity in A's own sidecar.
if grep -qF "eval-actor-b-session" "$B_DIR/state.json" 2>/dev/null; then
  fail "actor B's refused entry unexpectedly left a trace in A's state.json"
else
  pass "actor B's refused entry left no trace in A's state.json"
fi

# AC9 variant 1: a crafted HOSTILE liveness event (no assignment record at all — the
# "liveness_claim_present_assignment_lagging" join row) — proves the guard sanitizes a holder
# actor string sourced directly from an attacker-postable liveness stream, not merely from a
# well-formed assignment record.
HOSTILE_LIVENESS_SLUG="ensure-guard-hostile-liveness"
HOSTILE_LIVENESS_ACTOR=$'hostile-liveness-actor\x1b[31;1mFAKE\x07-holder'
append_liveness_event "$ARTIFACT_ROOT" "$HOSTILE_LIVENESS_SLUG" "$HOSTILE_LIVENESS_ACTOR" "$NOW_ISO" 1800

if flow_agents_node "workflow-sidecar" ensure-session \
  --artifact-root "$ARTIFACT_ROOT" \
  --task-slug "$HOSTILE_LIVENESS_SLUG" \
  --actor eval-actor-hostile-reader \
  --source-request "Reader against a hostile liveness-only holder." \
  --summary "Should refuse, sanitized." \
  >"$TMPDIR_EVAL/hostile-liveness.out" 2>"$TMPDIR_EVAL/hostile-liveness.err"; then
  fail "ensure-session against a hostile liveness-only holder should have refused (AC1, AC9)"
else
  pass "ensure-session against a hostile liveness-only holder refuses (AC1 liveness_claim_present_assignment_lagging row, AC9)"
fi
if grep -qF $'\x1b[31;1m' "$TMPDIR_EVAL/hostile-liveness.err" || grep -qF $'\x07' "$TMPDIR_EVAL/hostile-liveness.err"; then
  fail "hostile liveness-event holder actor's raw ANSI/control bytes leaked into the refusal message (AC9)"
else
  pass "hostile liveness-event holder actor's raw ANSI/control bytes never leak into the refusal message (AC9)"
fi
grep -qF "hostile-liveness-actor" "$TMPDIR_EVAL/hostile-liveness.err" && pass "the sanitized (non-control-byte) portion of the hostile holder actor string still appears in the refusal message (AC9)" || fail "sanitized portion of the hostile holder actor string was unexpectedly dropped entirely: $(cat "$TMPDIR_EVAL/hostile-liveness.err")"

# AC9 variant 2: hostile-effective-state.json (github-style hostile assignee string) via
# --effective-state-json — the escape hatch for non-local-file providers (Conflict #5).
HOSTILE_EFFECTIVE_SLUG="ensure-guard-hostile-effective-state"
if flow_agents_node "workflow-sidecar" ensure-session \
  --artifact-root "$ARTIFACT_ROOT" \
  --task-slug "$HOSTILE_EFFECTIVE_SLUG" \
  --actor eval-actor-hostile-reader-2 \
  --effective-state-json "$HOSTILE_EFFECTIVE_STATE_FIXTURE" \
  --source-request "Reader against a hostile precomputed effective-state fixture." \
  --summary "Should refuse, sanitized." \
  >"$TMPDIR_EVAL/hostile-effective.out" 2>"$TMPDIR_EVAL/hostile-effective.err"; then
  fail "ensure-session --effective-state-json against the hostile fixture should have refused (AC3, AC9)"
else
  pass "ensure-session --effective-state-json against the hostile fixture refuses (human-held, AC3, AC9)"
fi
if grep -qF $'\x1b[31;1m' "$TMPDIR_EVAL/hostile-effective.err" || grep -qF $'\x07' "$TMPDIR_EVAL/hostile-effective.err"; then
  fail "hostile --effective-state-json assignee's raw ANSI/control bytes leaked into the refusal message (AC9)"
else
  pass "hostile --effective-state-json assignee's raw ANSI/control bytes never leak into the refusal message (AC9)"
fi
grep -qF "hostile-assignee" "$TMPDIR_EVAL/hostile-effective.err" && pass "the sanitized portion of the hostile --effective-state-json assignee string still appears in the refusal message (AC9)" || fail "sanitized portion of the hostile --effective-state-json assignee string was unexpectedly dropped entirely: $(cat "$TMPDIR_EVAL/hostile-effective.err")"

# ─── 3. Actor A re-entering its own subject succeeds (AC4) ─────────────────────────────────
echo "--- 3. self re-entry succeeds with no spurious refusal (AC4) ---"

if flow_agents_node "workflow-sidecar" ensure-session \
  --artifact-root "$ARTIFACT_ROOT" \
  --work-item "$SUBJECT_WORK_ITEM" \
  --actor eval-actor-a-session \
  --source-request "Actor A resumes its own session." \
  --summary "Actor A resumes." \
  >"$TMPDIR_EVAL/a-reentry.out" 2>"$TMPDIR_EVAL/a-reentry.err"; then
  pass "actor A re-running ensure-session on its own fresh claim succeeds (AC4)"
else
  fail "actor A's self re-entry unexpectedly refused: $(cat "$TMPDIR_EVAL/a-reentry.out" "$TMPDIR_EVAL/a-reentry.err")"
fi

# ─── 3b. F1 (fix-plan iteration 1, HIGH): cross-tool self-recognition for an EXPLICIT-OVERRIDE
# actor (FLOW_AGENTS_ACTOR / --actor). This is the reviewer's exact live repro: a claim
# established via ensure-session under a bare override value must be recognized as self by a
# DIFFERENT tool invocation (`assignment-provider status --self-actor <bare value>`), and a fresh
# liveness heartbeat for that same bare value must join against the claim record too. Before the
# fix, computeEffectiveState keyed everything on serializeActor(record.actor) — a TRIPLE
# (`explicit-override:<value>:<host>`) for an override actor — while every other tool (including
# --self-actor here) uses the BARE value, so this cross-tool check failed even though the guard's
# OWN internal self-check passed (it always re-derives the same wrapped key on both sides).
echo "--- 3b. cross-tool self-recognition for an explicit-override actor: assignment-provider status --self-actor recognizes an ensure-session claim (F1, fix-plan iteration 1) ---"

CANONICAL_WORK_ITEM="kontourai/flow-agents#9103"
CANONICAL_SLUG="kontourai-flow-agents-9103"
CANONICAL_ACTOR="canonical-x"

if FLOW_AGENTS_ACTOR="$CANONICAL_ACTOR" flow_agents_node "workflow-sidecar" ensure-session \
  --artifact-root "$ARTIFACT_ROOT" \
  --work-item "$CANONICAL_WORK_ITEM" \
  --source-request "canonical-x claims a free subject via FLOW_AGENTS_ACTOR (no --actor flag)." \
  --summary "canonical-x establishes the first claim." \
  >"$TMPDIR_EVAL/canonical-ensure.out" 2>"$TMPDIR_EVAL/canonical-ensure.err"; then
  pass "FLOW_AGENTS_ACTOR=canonical-x ensure-session on a free subject exits 0 (F1 setup)"
else
  fail "FLOW_AGENTS_ACTOR=canonical-x ensure-session unexpectedly failed: $(cat "$TMPDIR_EVAL/canonical-ensure.out" "$TMPDIR_EVAL/canonical-ensure.err")"
fi

CANONICAL_RECORD="$ARTIFACT_ROOT/assignment/$CANONICAL_SLUG.json"
[[ -f "$CANONICAL_RECORD" ]] && pass "canonical-x's claim record exists on disk (F1 setup)" || fail "canonical-x's claim record was not written"
CANONICAL_ACTOR_KEY_FIELD="$(json_query "$CANONICAL_RECORD" "actor_key")"
if [[ "$CANONICAL_ACTOR_KEY_FIELD" == "$CANONICAL_ACTOR" ]]; then
  pass "the claim record's actor_key is the canonical BARE value 'canonical-x', not a serialized explicit-override triple (F1)"
else
  fail "the claim record's actor_key was not the expected bare canonical value: got '$CANONICAL_ACTOR_KEY_FIELD'"
fi

# (a) assignment-provider status --self-actor canonical-x (the BARE value, exactly what
# `liveness whoami` / `liveness claim --actor` / pull-work's --self-actor would all use) must
# recognize this claim as self -- effective_state:held, reason:self_is_holder, NOT reclaimable.
node "$CLI" assignment-provider status \
  --provider local-file --artifact-root "$ARTIFACT_ROOT" --subject-id "$CANONICAL_SLUG" \
  --liveness-events-json <(echo '[]') \
  --self-actor "$CANONICAL_ACTOR" \
  > "$TMPDIR_EVAL/status-canonical-self.json"
CANONICAL_SELF_STATE="$(json_query "$TMPDIR_EVAL/status-canonical-self.json" "effective.effective_state")"
CANONICAL_SELF_REASON="$(json_query "$TMPDIR_EVAL/status-canonical-self.json" "effective.reason")"
if [[ "$CANONICAL_SELF_STATE" == "held" && "$CANONICAL_SELF_REASON" == "self_is_holder" ]]; then
  pass "assignment-provider status --self-actor canonical-x (bare value) recognizes the ensure-session claim as self: held/self_is_holder, not reclaimable (F1 -- the reviewer's exact repro, now fixed)"
else
  fail "assignment-provider status --self-actor canonical-x did NOT recognize the claim as self: effective_state=$CANONICAL_SELF_STATE reason=$CANONICAL_SELF_REASON (expected held/self_is_holder): $(cat "$TMPDIR_EVAL/status-canonical-self.json")"
fi

# (b) symmetric case: a FRESH liveness heartbeat for canonical-x (the bare value, exactly what a
# real heartbeat/liveness-claim event would record as `actor`) must join against the SAME record
# via fresh_liveness_heartbeat, with a DIFFERENT (or no) --self-actor -- proving the join itself
# matches on the canonical actor_key, not merely the redundant self-check.
CANONICAL_HEARTBEAT_NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
append_liveness_event "$ARTIFACT_ROOT" "$CANONICAL_SLUG" "$CANONICAL_ACTOR" "$CANONICAL_HEARTBEAT_NOW" 1800

node "$CLI" assignment-provider status \
  --provider local-file --artifact-root "$ARTIFACT_ROOT" --subject-id "$CANONICAL_SLUG" \
  --liveness-stream "$ARTIFACT_ROOT/liveness/events.jsonl" \
  --self-actor "eval-actor-some-other-reader" \
  > "$TMPDIR_EVAL/status-canonical-heartbeat.json"
CANONICAL_HEARTBEAT_STATE="$(json_query "$TMPDIR_EVAL/status-canonical-heartbeat.json" "effective.effective_state")"
CANONICAL_HEARTBEAT_REASON="$(json_query "$TMPDIR_EVAL/status-canonical-heartbeat.json" "effective.reason")"
if [[ "$CANONICAL_HEARTBEAT_STATE" == "held" && "$CANONICAL_HEARTBEAT_REASON" == "fresh_liveness_heartbeat" ]]; then
  pass "a fresh liveness heartbeat for canonical-x (bare value) joins against the ensure-session claim via fresh_liveness_heartbeat, under a DIFFERENT self-actor (F1 -- proves the assignment <-> liveness join itself matches, not just the self-check)"
else
  fail "the fresh liveness heartbeat for canonical-x did not join against the claim: effective_state=$CANONICAL_HEARTBEAT_STATE reason=$CANONICAL_HEARTBEAT_REASON (expected held/fresh_liveness_heartbeat): $(cat "$TMPDIR_EVAL/status-canonical-heartbeat.json")"
fi

# ─── 4. Stale (reclaimable) claim: refuse without the flag, succeed with it (AC2) ──────────
echo "--- 4. reclaimable (stale) claim: refuse without --supersede-stale, succeed with it (AC2) ---"

STALE_SLUG="ensure-guard-stale-takeover"
flow_agents_node "workflow-sidecar" ensure-session \
  --artifact-root "$ARTIFACT_ROOT" \
  --task-slug "$STALE_SLUG" \
  --actor eval-actor-stale-holder \
  --source-request "Establish the original (soon-to-be-stale) claim." \
  --summary "Original holder." \
  >"$TMPDIR_EVAL/stale-setup.out" 2>"$TMPDIR_EVAL/stale-setup.err"
STALE_RECORD="$ARTIFACT_ROOT/assignment/$STALE_SLUG.json"
ACTOR_KEY_STALE_HOLDER="$(actor_key_from_record "$STALE_RECORD")"
# A liveness event whose `at` is well past ttlSeconds (1800s) relative to real wall-clock now —
# matches evals/fixtures/assignment-provider/liveness-stale.json's "well in the past" convention.
append_liveness_event "$ARTIFACT_ROOT" "$STALE_SLUG" "$ACTOR_KEY_STALE_HOLDER" "2026-06-01T10:00:00Z" 1800

if flow_agents_node "workflow-sidecar" ensure-session \
  --artifact-root "$ARTIFACT_ROOT" \
  --task-slug "$STALE_SLUG" \
  --actor eval-actor-b-session \
  --source-request "Actor B attempts a stale takeover without --supersede-stale." \
  --summary "Should refuse, naming the flag." \
  >"$TMPDIR_EVAL/stale-refuse.out" 2>"$TMPDIR_EVAL/stale-refuse.err"; then
  fail "ensure-session on a reclaimable (stale) subject without --supersede-stale should have refused (AC2)"
else
  pass "ensure-session on a reclaimable (stale) subject without --supersede-stale refuses (AC2)"
fi
grep -qF -- "--supersede-stale" "$TMPDIR_EVAL/stale-refuse.err" && pass "stale-claim refusal names --supersede-stale explicitly (AC2)" || fail "stale-claim refusal did not name --supersede-stale: $(cat "$TMPDIR_EVAL/stale-refuse.err")"

if flow_agents_node "workflow-sidecar" ensure-session \
  --artifact-root "$ARTIFACT_ROOT" \
  --task-slug "$STALE_SLUG" \
  --actor eval-actor-b-session \
  --supersede-stale \
  --source-request "Actor B takes over the stale claim explicitly." \
  --summary "Explicit takeover." \
  >"$TMPDIR_EVAL/stale-supersede.out" 2>"$TMPDIR_EVAL/stale-supersede.err"; then
  pass "ensure-session --supersede-stale on a reclaimable (stale) subject succeeds (AC2)"
else
  fail "ensure-session --supersede-stale on a reclaimable (stale) subject unexpectedly failed: $(cat "$TMPDIR_EVAL/stale-supersede.out" "$TMPDIR_EVAL/stale-supersede.err")"
fi

node "$CLI" assignment-provider status \
  --provider local-file --artifact-root "$ARTIFACT_ROOT" --subject-id "$STALE_SLUG" \
  > "$TMPDIR_EVAL/status-after-supersede.json"
[[ "$(json_query "$TMPDIR_EVAL/status-after-supersede.json" "assignment.assignee")" == *"eval-actor-b-session"* ]] && pass "assignment-provider status confirms actor B is the new holder after --supersede-stale takeover (AC2)" || fail "assignment-provider status did not confirm actor B as the new holder: $(cat "$TMPDIR_EVAL/status-after-supersede.json")"
[[ "$(json_query "$TMPDIR_EVAL/status-after-supersede.json" "assignment.record.audit_trail.length")" == "2" ]] && pass "supersede takeover appended a second audit_trail entry (claim + supersede) (AC2)" || fail "supersede takeover did not append a second audit_trail entry: $(cat "$TMPDIR_EVAL/status-after-supersede.json")"
[[ "$(json_query "$TMPDIR_EVAL/status-after-supersede.json" "assignment.record.audit_trail.1.transition")" == "supersede" ]] && pass "audit trail records the supersede transition from the stale-claim takeover (AC2)" || fail "audit trail did not record a supersede transition: $(cat "$TMPDIR_EVAL/status-after-supersede.json")"

# ─── 5. Human-held: never auto-reclaims (AC3) ──────────────────────────────────────────────
echo "--- 5. human-held subject: ask-first refusal, never auto-reclaims (AC3) ---"

HUMAN_SLUG="ensure-guard-human-held"
mkdir -p "$ARTIFACT_ROOT/assignment"
cat > "$ARTIFACT_ROOT/assignment/$HUMAN_SLUG.json" <<HUMANEOF
{
  "schema_version": "1.0",
  "role": "AssignmentClaimRecord",
  "subject_id": "$HUMAN_SLUG",
  "actor": {
    "runtime": "github",
    "session_id": "n-a",
    "host": "n-a",
    "human": "alice-human"
  },
  "claimed_at": "2026-06-15T09:00:00Z",
  "ttl_seconds": 1800,
  "branch": "main",
  "artifact_dir": "$HUMAN_SLUG",
  "status": "claimed",
  "audit_trail": [
    { "at": "2026-06-15T09:00:00Z", "transition": "claim", "from_actor": null, "to_actor": { "runtime": "github", "session_id": "n-a", "host": "n-a", "human": "alice-human" }, "reason": "human assignment" }
  ]
}
HUMANEOF
HUMAN_RECORD_BEFORE="$(cat "$ARTIFACT_ROOT/assignment/$HUMAN_SLUG.json")"

if flow_agents_node "workflow-sidecar" ensure-session \
  --artifact-root "$ARTIFACT_ROOT" \
  --task-slug "$HUMAN_SLUG" \
  --actor eval-actor-c-session \
  --source-request "Any actor attempts entry on a human-held subject." \
  --summary "Should refuse, ask-first." \
  >"$TMPDIR_EVAL/human-held.out" 2>"$TMPDIR_EVAL/human-held.err"; then
  fail "ensure-session on a human-held subject should have refused (AC3)"
else
  pass "ensure-session on a human-held subject refuses (AC3)"
fi
grep -qiF "human" "$TMPDIR_EVAL/human-held.err" && pass "human-held refusal message references the human assignment (AC3)" || fail "human-held refusal message did not reference the human assignment: $(cat "$TMPDIR_EVAL/human-held.err")"
grep -qiF "confirm" "$TMPDIR_EVAL/human-held.err" && pass "human-held refusal message asks for confirmation before proceeding, never auto-reclaims (AC3)" || fail "human-held refusal message lacked ask-first remediation: $(cat "$TMPDIR_EVAL/human-held.err")"
[[ ! -d "$ARTIFACT_ROOT/$HUMAN_SLUG" ]] && pass "human-held refusal never created a session directory (no auto-reclaim side effect) (AC3)" || fail "human-held refusal unexpectedly created a session directory"
HUMAN_RECORD_AFTER="$(cat "$ARTIFACT_ROOT/assignment/$HUMAN_SLUG.json")"
[[ "$HUMAN_RECORD_BEFORE" == "$HUMAN_RECORD_AFTER" ]] && pass "human-held assignment record is byte-identical after the refused attempt (never auto-reclaimed) (AC3)" || fail "human-held assignment record was mutated by a refused ensure-session attempt"

# ─── 6. Concurrency: exactly one holder, no corrupted/partial record (AC6) ─────────────────
echo "--- 6. genuine concurrent ensure-session race: exactly one holder wins (AC6) ---"

RACE_SLUG="ensure-guard-race"
(
  flow_agents_node "workflow-sidecar" ensure-session \
    --artifact-root "$ARTIFACT_ROOT" \
    --task-slug "$RACE_SLUG" \
    --actor eval-race-actor-a \
    --source-request "Race participant A." \
    --summary "Race participant A." \
    >"$TMPDIR_EVAL/race-a.out" 2>"$TMPDIR_EVAL/race-a.err"
  echo $? > "$TMPDIR_EVAL/race-a.rc"
) &
RACE_PID_A=$!
(
  flow_agents_node "workflow-sidecar" ensure-session \
    --artifact-root "$ARTIFACT_ROOT" \
    --task-slug "$RACE_SLUG" \
    --actor eval-race-actor-b \
    --source-request "Race participant B." \
    --summary "Race participant B." \
    >"$TMPDIR_EVAL/race-b.out" 2>"$TMPDIR_EVAL/race-b.err"
  echo $? > "$TMPDIR_EVAL/race-b.rc"
) &
RACE_PID_B=$!
wait "$RACE_PID_A" "$RACE_PID_B"

RACE_RC_A="$(cat "$TMPDIR_EVAL/race-a.rc")"
RACE_RC_B="$(cat "$TMPDIR_EVAL/race-b.rc")"
if { [[ "$RACE_RC_A" -eq 0 && "$RACE_RC_B" -ne 0 ]] || [[ "$RACE_RC_A" -ne 0 && "$RACE_RC_B" -eq 0 ]]; }; then
  pass "genuine concurrent ensure-session race: exactly one process wins (rc_a=$RACE_RC_A rc_b=$RACE_RC_B) (AC6)"
else
  fail "genuine concurrent ensure-session race: exactly one process should win (rc_a=$RACE_RC_A rc_b=$RACE_RC_B) (AC6)"
fi

RACE_RECORD="$ARTIFACT_ROOT/assignment/$RACE_SLUG.json"
if node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$RACE_RECORD" 2>/dev/null; then
  pass "race winner's on-disk assignment record is valid, uncorrupted JSON (AC6)"
else
  fail "race winner's on-disk assignment record is missing or corrupted JSON (AC6)"
fi
node "$CLI" assignment-provider status \
  --provider local-file --artifact-root "$ARTIFACT_ROOT" --subject-id "$RACE_SLUG" \
  > "$TMPDIR_EVAL/status-race.json"
[[ "$(json_query "$TMPDIR_EVAL/status-race.json" "assignment.record.audit_trail.length")" == "1" ]] && pass "race winner's on-disk record has exactly one audit_trail entry (no lost/merged/double claim) (AC6)" || fail "race winner's on-disk record does not have exactly one audit_trail entry: $(cat "$TMPDIR_EVAL/status-race.json")"

if [[ "$RACE_RC_A" -eq 0 ]]; then
  EXPECTED_RACE_HOLDER="eval-race-actor-a"
else
  EXPECTED_RACE_HOLDER="eval-race-actor-b"
fi
[[ "$(json_query "$TMPDIR_EVAL/status-race.json" "assignment.assignee")" == *"$EXPECTED_RACE_HOLDER"* ]] && pass "on-disk record holder matches the process that actually exited 0 (no silent overwrite by the loser) (AC6)" || fail "on-disk record holder does not match the winning process: $(cat "$TMPDIR_EVAL/status-race.json")"

echo ""

# 7. #554: ensure-session consumes the helper-owned safe struct and re-enters as self.
CODEX_PRIVATE_ROOT="$TMPDIR_EVAL/codex-private-root"
CODEX_PRIVATE_RAW='ENSURE-PRIVATE-SENTINEL:thread/value'
CODEX_PRIVATE_WORK="kontourai/flow-agents#9554"
CODEX_PRIVATE_SLUG="kontourai-flow-agents-9554"
if CODEX_THREAD_ID="$CODEX_PRIVATE_RAW" CODEX_SESSION_ID= flow_agents_node "workflow-sidecar" ensure-session \
  --artifact-root "$CODEX_PRIVATE_ROOT" --work-item "$CODEX_PRIVATE_WORK" \
  --source-request "Canonical Codex identity fixture." --summary "Privacy-safe actor fixture." \
  >"$TMPDIR_EVAL/codex-private-first.out" 2>"$TMPDIR_EVAL/codex-private-first.err"; then
  pass "ensure-session succeeds with CODEX_THREAD_ID"
else
  fail "ensure-session failed with CODEX_THREAD_ID: $(cat "$TMPDIR_EVAL/codex-private-first.out" "$TMPDIR_EVAL/codex-private-first.err")"
fi
CODEX_PRIVATE_RECORD="$CODEX_PRIVATE_ROOT/assignment/$CODEX_PRIVATE_SLUG.json"
if node - "$CODEX_PRIVATE_RECORD" "$ROOT/scripts/hooks/lib/actor-identity.js" <<'NODE'
const fs = require('fs');
const record = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { serializeActor } = require(process.argv[3]);
if (record.actor.runtime !== 'codex' || !/^thread-[a-f0-9]{24}$/.test(record.actor.session_id)) throw new Error('unsafe actor struct');
if (record.actor_key !== serializeActor(record.actor)) throw new Error('key/struct mismatch');
NODE
then pass "ensure-session persists a canonical Codex actor struct whose serialization equals actor_key"
else fail "ensure-session persisted a divergent or unsafe Codex actor struct/key"
fi
if rg -qF 'ENSURE-PRIVATE-SENTINEL' "$CODEX_PRIVATE_ROOT" "$TMPDIR_EVAL/codex-private-first.out" "$TMPDIR_EVAL/codex-private-first.err"; then
  fail "raw CODEX_THREAD_ID sentinel leaked into ensure-session artifacts or output"
else
  pass "raw CODEX_THREAD_ID sentinel is absent from the complete ensure-session artifact/output set"
fi
if CODEX_THREAD_ID="$CODEX_PRIVATE_RAW" CODEX_SESSION_ID= flow_agents_node "workflow-sidecar" ensure-session \
  --artifact-root "$CODEX_PRIVATE_ROOT" --work-item "$CODEX_PRIVATE_WORK" \
  --source-request "Canonical Codex identity fixture reentry." --summary "Privacy-safe actor fixture reentry." \
  >"$TMPDIR_EVAL/codex-private-second.out" 2>"$TMPDIR_EVAL/codex-private-second.err"; then
  pass "second ensure-session recognizes the first canonical Codex claim as self"
else
  fail "second ensure-session did not recognize the canonical Codex claim as self: $(cat "$TMPDIR_EVAL/codex-private-second.out" "$TMPDIR_EVAL/codex-private-second.err")"
fi

# 8. #596: a GitHub renderer-produced claim/status can enter the public Builder workflow even
# when the provider login deliberately differs from the runtime actor. Runtime ownership comes
# from actor_key + actor struct + exact Work Item + self_is_holder, never the GitHub login.
echo "--- 8. GitHub renderer status enters Builder with distinct provider/runtime identities (#596) ---"

GITHUB_ACTOR_KEY="github-runtime-actor"
GITHUB_PROVIDER_LOGIN="github-notification-login"
GITHUB_WORK_ITEM="kontourai/flow-agents#9596"
GITHUB_SLUG="kontourai-flow-agents-9596"
GITHUB_PROJECT="$TMPDIR_EVAL/github-builder-project"
GITHUB_ROOT="$GITHUB_PROJECT/.kontourai/flow-agents"
mkdir -p "$GITHUB_ROOT/$GITHUB_SLUG"
printf '# Pull Work\n\nSelected Work Item: %s\n' "$GITHUB_WORK_ITEM" > "$GITHUB_ROOT/$GITHUB_SLUG/$GITHUB_SLUG--pull-work.md"

node - "$TMPDIR_EVAL/github-actor.json" <<'NODE'
const fs = require('node:fs');
const os = require('node:os');
fs.writeFileSync(process.argv[2], JSON.stringify({
  runtime: 'explicit-override', session_id: 'github-runtime-actor', host: os.hostname(), human: null,
}, null, 2));
NODE
cat > "$TMPDIR_EVAL/github-render-input.json" <<JSON
{
  "repo": {"owner": "kontourai", "name": "flow-agents"},
  "issue_number": 9596,
  "assignee_login": "$GITHUB_PROVIDER_LOGIN",
  "actor_key": "$GITHUB_ACTOR_KEY",
  "work_item_ref": "$GITHUB_WORK_ITEM",
  "branch": "agent/$GITHUB_ACTOR_KEY/$GITHUB_SLUG",
  "artifact_dir": ".kontourai/flow-agents/$GITHUB_SLUG"
}
JSON
node "$CLI" assignment-provider render-claim --provider github --subject-id "$GITHUB_SLUG" \
  --input-json "$TMPDIR_EVAL/github-render-input.json" --actor-json "$TMPDIR_EVAL/github-actor.json" \
  > "$TMPDIR_EVAL/github-render.json"
node - "$TMPDIR_EVAL/github-render.json" "$TMPDIR_EVAL/github-issue.json" "$GITHUB_PROVIDER_LOGIN" <<'NODE'
const fs = require('node:fs');
const render = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
fs.writeFileSync(process.argv[3], JSON.stringify({
  number: 9596,
  state: 'OPEN',
  assignees: [{ login: process.argv[4] }],
  labels: [{ name: 'agent:claimed' }],
  comments: [{ id: 'IC_kwDOopaque-9596', createdAt: '2026-07-13T11:00:00Z', author: { login: process.argv[4] }, body: render.claim_comment_body }],
}, null, 2));
NODE
node "$CLI" assignment-provider status --provider github \
  --repo "kontourai/flow-agents" \
  --issue-json "$TMPDIR_EVAL/github-issue.json" --subject-id "$GITHUB_SLUG" \
  --liveness-events-json <(echo '[]') --self-actor "$GITHUB_ACTOR_KEY" \
  > "$TMPDIR_EVAL/github-status.json"

[[ "$(json_query "$TMPDIR_EVAL/github-status.json" "assignment.assignee")" == "$GITHUB_PROVIDER_LOGIN" ]] \
  && pass "GitHub status preserves the raw provider assignee login" \
  || fail "GitHub status replaced the raw provider login with runtime identity"
[[ "$(json_query "$TMPDIR_EVAL/github-status.json" "assignment.claim_comment_author")" == "$GITHUB_PROVIDER_LOGIN" ]] \
  && pass "GitHub status binds the selected claim comment author to the provider assignee" \
  || fail "GitHub status did not expose the selected claim comment author"
[[ "$(json_query "$TMPDIR_EVAL/github-status.json" "assignment.claim_comment_id")" == "IC_kwDOopaque-9596" ]] \
  && pass "GitHub status preserves the selected provider comment's opaque id" \
  || fail "GitHub status did not preserve the selected opaque comment id"
[[ "$(json_query "$TMPDIR_EVAL/github-status.json" "effective.reason")" == "self_is_holder" ]] \
  && pass "renderer-produced status recognizes the canonical runtime actor as self" \
  || fail "renderer-produced status did not recognize the runtime actor: $(cat "$TMPDIR_EVAL/github-status.json")"

if FLOW_AGENTS_ACTOR="$GITHUB_ACTOR_KEY" node "$CLI" workflow start \
  --artifact-root "$GITHUB_ROOT" --flow builder.build --work-item "$GITHUB_WORK_ITEM" \
  --assignment-provider github --effective-state-json "$TMPDIR_EVAL/github-status.json" \
  > "$TMPDIR_EVAL/github-workflow-start.out" 2> "$TMPDIR_EVAL/github-workflow-start.err"; then
  pass "renderer-produced GitHub status enters the public Builder workflow with a distinct provider login"
else
  fail "renderer-produced GitHub status failed public workflow start: $(cat "$TMPDIR_EVAL/github-workflow-start.out" "$TMPDIR_EVAL/github-workflow-start.err")"
fi

# Produce three fail-closed variants without hand-building a positive status: each begins with
# the renderer-produced status above, changes exactly one ownership dimension, and targets a
# fresh canonical artifact root so refusal can be checked for zero session mutation.
node - "$TMPDIR_EVAL/github-status.json" "$TMPDIR_EVAL" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const source = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const variants = {
  actor: value => { value.assignment.record.actor.session_id = 'different-runtime-actor'; },
  work_item: value => { value.assignment.record.work_item_ref = 'kontourai/flow-agents#9999'; },
  effective: value => { value.effective.reason = 'fresh_liveness_heartbeat'; },
};
for (const [name, mutate] of Object.entries(variants)) {
  const value = structuredClone(source);
  mutate(value);
  fs.writeFileSync(path.join(process.argv[3], `github-status-${name}.json`), JSON.stringify(value, null, 2));
}
NODE

# Provider-authorization negatives are themselves produced through `assignment-provider status`
# from distinct GitHub issue documents, rather than hand-editing AssignmentStatus fields.
node - "$TMPDIR_EVAL/github-issue.json" "$TMPDIR_EVAL" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const source = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const variants = {
  forged_author: value => { value.comments[0].author.login = 'unrelated-commenter'; },
  newer_forged_author: value => { value.comments.push({ ...value.comments[0], id: 'IC_kwDOopaque-9596-forged', createdAt: '2026-07-13T11:01:00Z', author: { login: 'unrelated-commenter' } }); },
  missing_author: value => { delete value.comments[0].author; },
  missing_label: value => { value.labels = []; },
  missing_assignee: value => { value.assignees = []; },
  other_assignee: value => { value.assignees = [{ login: 'different-provider-assignee' }]; },
  wrong_number: value => { value.number = 123; },
};
for (const [name, mutate] of Object.entries(variants)) {
  const value = structuredClone(source);
  mutate(value);
  fs.writeFileSync(path.join(process.argv[3], `github-issue-${name}.json`), JSON.stringify(value, null, 2));
}
NODE
for variant in forged_author newer_forged_author missing_author missing_label missing_assignee other_assignee wrong_number; do
  node "$CLI" assignment-provider status --provider github \
    --repo "kontourai/flow-agents" \
    --issue-json "$TMPDIR_EVAL/github-issue-$variant.json" --subject-id "$GITHUB_SLUG" \
    --liveness-events-json <(echo '[]') --self-actor "$GITHUB_ACTOR_KEY" \
    > "$TMPDIR_EVAL/github-status-$variant.json"
done
node "$CLI" assignment-provider status --provider github \
  --repo "kontourai/not-flow-agents" \
  --issue-json "$TMPDIR_EVAL/github-issue.json" --subject-id "$GITHUB_SLUG" \
  --liveness-events-json <(echo '[]') --self-actor "$GITHUB_ACTOR_KEY" \
  > "$TMPDIR_EVAL/github-status-wrong_repository.json"
[[ "$(json_query "$TMPDIR_EVAL/github-status-wrong_number.json" "assignment.issue_number")" == "123" \
  && "$(json_query "$TMPDIR_EVAL/github-status-wrong_number.json" "assignment.record.work_item_ref")" == "$GITHUB_WORK_ITEM" ]] \
  && pass "reviewer repro preserves provider issue #123 beside requested/recorded #9596 so the origin guard is exercised" \
  || fail "reviewer #123 -> #9596 repro status did not preserve both conflicting identities"
[[ "$(json_query "$TMPDIR_EVAL/github-status-wrong_repository.json" "assignment.repository.name")" == "not-flow-agents" ]] \
  && pass "wrong-repository status preserves the trusted provider repository mismatch" \
  || fail "wrong-repository status did not preserve the provider repository mismatch"

for variant in actor work_item effective forged_author newer_forged_author missing_author missing_label missing_assignee other_assignee wrong_number wrong_repository; do
  NEGATIVE_PROJECT="$TMPDIR_EVAL/github-negative-$variant"
  NEGATIVE_ROOT="$NEGATIVE_PROJECT/.kontourai/flow-agents"
  mkdir -p "$NEGATIVE_ROOT/$GITHUB_SLUG"
  printf '# Pull Work\n\nSelected Work Item: %s\n' "$GITHUB_WORK_ITEM" > "$NEGATIVE_ROOT/$GITHUB_SLUG/$GITHUB_SLUG--pull-work.md"
  if FLOW_AGENTS_ACTOR="$GITHUB_ACTOR_KEY" node "$CLI" workflow start \
    --artifact-root "$NEGATIVE_ROOT" --flow builder.build --work-item "$GITHUB_WORK_ITEM" \
    --assignment-provider github --effective-state-json "$TMPDIR_EVAL/github-status-$variant.json" \
    > "$TMPDIR_EVAL/github-negative-$variant.out" 2> "$TMPDIR_EVAL/github-negative-$variant.err"; then
    fail "workflow start accepted mismatched GitHub $variant ownership evidence"
  elif [[ ! -f "$NEGATIVE_ROOT/$GITHUB_SLUG/state.json" ]]; then
    pass "workflow start rejects mismatched GitHub $variant evidence before session mutation"
  else
    fail "workflow start rejected mismatched GitHub $variant evidence only after mutating session state"
  fi
done

if [[ "$errors" -eq 0 ]]; then
  echo "test_ensure_session_ownership_guard: all checks passed."
else
  echo "test_ensure_session_ownership_guard: $errors check(s) failed."
fi
exit "$errors"
