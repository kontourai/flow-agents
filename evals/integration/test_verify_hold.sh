#!/usr/bin/env bash
# test_verify_hold.sh — verify-hold gate integration eval (issue #293, ADR 0021 §3).
#
# Exercises `runVerifyHold()`/`NotFreshHolderError`/`verify-hold` CLI subcommand and its
# composition into `publishDelivery()` (src/cli/workflow-sidecar.ts), reusing the SAME
# assignment ⋈ liveness join #290/#291 already built (computeEffectiveState/
# readLocalAssignmentStatus/freshHolders) — no second computation is invented here, and this
# eval never asserts a second one either. Also exercises `supersessionSteering()`
# (scripts/hooks/workflow-steering.js), the every-turn companion to the CLI/skill hard-stop.
#
# Follows evals/integration/test_ensure_session_ownership_guard.sh's actor/fixture idiom
# (pass/fail/json_query helpers, append_liveness_event, actor_key_from_record) and
# evals/integration/test_publish_delivery.sh's bundle-fixture-builder idiom (write_bundle_to)
# exactly — no new plumbing invented where an existing helper already does the job.
#
# AC5 (steering surfaces supersession every turn) is asserted HERE (not duplicated into
# test_workflow_steering_hook.sh) by driving scripts/hooks/workflow-steering.js directly via
# stdin JSON, matching that file's own existing direct-invocation convention
# (`node scripts/hooks/workflow-steering.js <<JSON ... JSON`).
#
# Sections (1-to-1 with the plan's Wave 4 task + acceptance.json's 8 ACs):
#   1. Superseded A->B (AC1): actor A's verify-hold blocks (held, holder=B); a manufactured
#      STALE self-claim (reclaimable) ALSO blocks for its own original actor (the Stop-short
#      risk regression — reclaimable is never silently treated as pass).
#   2. Composition (AC1, AC3 partial): publish-delivery / record-release called as actor A on
#      the superseded fixture exit non-zero and never write delivery/<slug>/.
#   3. Fresh holder + free subject pass (AC2): actor B's verify-hold passes; a free subject
#      passes for any actor.
#   4. #356 shape-gate composition ordering (AC3): shape-invalid AND not-held -> the SHAPE
#      error specifically; shape-valid AND not-held -> the HOLD error specifically. Both
#      reachable, distinct, and delivery/<slug>/ is never created in either case.
#   5. github-provider precomputed gate (AC6): --effective-state-json evaluates without any
#      `gh` process; absent both local-file and github fixture -> not_evaluated, exit 0.
#   6. Injection discipline (AC7): hostile liveness holder string never leaks raw control/ANSI
#      bytes into verify-hold's JSON/stderr or the steering supersession notice.
#   7. Steering every-turn (AC5): supersessionSteering fires on UserPromptSubmit AND
#      SessionStart for a fixture with a fresh other-actor holder; absent for a fixture with
#      none.
#   8. Registration (AC8) is verified by diffs of evals/run.sh, evals/ci/run-baseline.sh, and
#      .github/workflows/ci.yml (not by this file) plus the parity check in
#      test_trust_reconcile_manifest.sh.
#
# Deterministic, no model spend, self-cleaning, no network, no `gh` process anywhere.
# Usage: bash evals/integration/test_verify_hold.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CURRENT_POINTER_HELPER="$ROOT/scripts/hooks/lib/current-pointer.js"
source "$ROOT/evals/lib/node.sh"

CLI="$ROOT/build/src/cli.js"
WRITER="workflow-sidecar"

TMPDIR_EVAL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_EVAL"' EXIT
ARTIFACT_ROOT="$TMPDIR_EVAL/artifact-root"

errors=0
pass() { echo "  [PASS] $1"; }
fail() { echo "  [FAIL] $1"; errors=$((errors + 1)); }

json_query() {
  node -e 'const fs=require("fs"); let cur=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); for (const part of process.argv[2].split(".")) cur=part==="length" ? cur.length : (Array.isArray(cur) ? cur[Number(part)] : cur[part]); console.log(cur);' "$1" "$2"
}

ACTOR_IDENTITY_HELPER="$ROOT/scripts/hooks/lib/actor-identity.js"
# actor_key_from_record <assignment-record.json> — recomputes the SAME holderActorKey
# computeEffectiveState (src/cli/assignment-provider.ts) itself derives (record.actor_key when
# present, else serializeActor(record.actor) back-compat fallback). Reused verbatim from
# test_ensure_session_ownership_guard.sh's own helper — never hand-derived.
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

# write_assignment_record <artifactRoot> <slug> <sessionId> <actorKey> [claimedAt]
# Writes a minimal, well-formed, ALREADY-CLAIMED assignment record directly (bypassing
# assignment-provider claim's --branch/--artifact-dir plumbing where the eval only needs a
# fixed actor_key/holder shape for runVerifyHold's join, matching how
# test_ensure_session_ownership_guard.sh's own human-held fixture writes a record directly).
# [claimedAt] (F1 fix, fix-plan iteration 1): optional override for `claimed_at` -- defaults to
# real wall-clock `now` (unchanged behavior for every existing caller) so section 6b below can
# inject a hostile/oversized value into this exact attacker-writable field without adding a
# second, parallel fixture-writer helper.
write_assignment_record() {
  local root="$1" slug="$2" sessionId="$3" actorKey="$4" claimedAt="${5:-}"
  mkdir -p "$root/assignment"
  node -e '
const fs = require("fs");
const [dest, slug, sessionId, actorKey, claimedAtOverride] = process.argv.slice(1);
const now = new Date().toISOString();
const claimedAt = claimedAtOverride || now;
const actor = { runtime: "claude-code", session_id: sessionId, host: "eval-host" };
const rec = {
  schema_version: "1.0", role: "AssignmentClaimRecord", subject_id: slug,
  actor, actor_key: actorKey, claimed_at: claimedAt, ttl_seconds: 1800, branch: "main",
  artifact_dir: slug, status: "claimed",
  audit_trail: [{ at: now, transition: "claim", from_actor: null, to_actor: actor, reason: "claim" }],
};
fs.writeFileSync(dest, JSON.stringify(rec, null, 2));
' "$root/assignment/$slug.json" "$slug" "$sessionId" "$actorKey" "$claimedAt"
}

# write_bundle_to <dest> <label> <passing> — minimal bundle fixture, reused verbatim from
# test_publish_delivery.sh's own helper (a command-backed claim naming <label> as the
# evidence.execution.label; shape-VALID only when <label> resolves against the manifest, e.g.
# via TRUST_RECONCILE_COMMANDS).
write_bundle_to() {
  local dest="$1" label="$2" passing="$3"
  local helper="$TMPDIR_EVAL/bundle-writer.js"
  if [[ ! -f "$helper" ]]; then
    python3 - "$helper" << 'PY'
import sys
out = sys.argv[1]
code_lines = [
  "const fs = require('fs');",
  "const [,, dest, label, passingStr] = process.argv;",
  "const passing = passingStr === 'true';",
  "const b = { schemaVersion: 5, source: 'test-fixture',",
  "  claims: [{ id: 'c1', claimType: 'workflow.check.build',",
  "    value: passing ? 'pass' : 'fail', status: passing ? 'verified' : 'disputed',",
  "    subjectId: 'ts/build', facet: 'flow-agents.workflow',",
  "    subjectType: 'workflow-check', fieldOrBehavior: 'build',",
  "    createdAt: '2026-06-27T00:00:00Z', updatedAt: '2026-06-27T00:00:00Z',",
  "    impactLevel: 'high', verificationPolicyId: 'policy:wf.build' }],",
  "  evidence: [{ id: 'ev1', claimId: 'c1', evidenceType: 'test_output',",
  "    method: 'validation', sourceRef: 'ts/cmd.jsonl',",
  "    excerptOrSummary: 'build', observedAt: '2026-06-27T00:00:00Z',",
  "    collectedBy: 'flow-agents', passing: passing,",
  "    execution: { runner: 'bash', label: label, isError: !passing, exitCode: passing ? 0 : 1 } }],",
  "  policies: [], events: [] };",
  "fs.writeFileSync(dest, JSON.stringify(b, null, 2));",
]
with open(out, 'w') as fh:
  fh.write('\n'.join(code_lines) + '\n')
PY
  fi
  node "$helper" "$dest" "$label" "$passing"
}

# setup_session <artifactRoot> <slug> <bundleSrc> — a minimal deliverable session, reused from
# test_publish_delivery.sh's own helper.
setup_session() {
  local aroot="$1" slug="$2" bundle_src="$3"
  local session_dir="$aroot/$slug"
  mkdir -p "$aroot"
  flow_agents_node "$WRITER" ensure-session \
    --artifact-root "$aroot" --task-slug "$slug" \
    --title "Verify Hold Test" \
    --summary "Test verify-hold gate." \
    --criterion "Bundle published" \
    --timestamp "2026-07-04T10:00:00Z" >/dev/null 2>&1
  flow_agents_node "$WRITER" init-plan "$session_dir/${slug}--deliver.md" \
    --source-request "Test" --summary "Test" \
    --timestamp "2026-07-04T10:01:00Z" >/dev/null 2>&1
  flow_agents_node "$WRITER" record-evidence "$session_dir" \
    --verdict pass \
    --check-json '{"id":"build","kind":"build","status":"pass","summary":"ok"}' \
    --timestamp "2026-07-04T10:02:00Z" >/dev/null 2>&1
  flow_agents_node "$WRITER" record-critique "$session_dir" \
    --verdict pass --summary "ok." \
    --timestamp "2026-07-04T10:03:00Z" >/dev/null 2>&1
  if [[ -n "$bundle_src" && -f "$bundle_src" ]]; then
    cp "$bundle_src" "$session_dir/trust.bundle"
  fi
}

# write_steering_fixture_repo <repoRoot> <slug> <statusJsonUpdatedAt>
# Minimal repo scaffold + a bare in_progress state.json so workflow-steering.js's
# latestWorkflowState() finds an active `current` sidecar for the given slug. Writes the JSON
# via a node helper (never a raw shell heredoc) matching this file's other fixture-writer
# helpers above.
write_steering_fixture_repo() {
  local repoRoot="$1" slug="$2" updatedAt="$3"
  mkdir -p "$repoRoot/.kontourai/flow-agents/$slug" "$repoRoot/docs"
  printf '# Repo\n' > "$repoRoot/AGENTS.md"
  printf '# Context Map\n' > "$repoRoot/docs/context-map.md"
  node "$ROOT_SCRATCH_STATE_WRITER" \
    "$repoRoot/.kontourai/flow-agents/$slug/state.dot.json.tmp" \
    "$slug" "in_progress" "execution" "$updatedAt" "Continue work."
  mv "$repoRoot/.kontourai/flow-agents/$slug/state.dot.json.tmp" "$repoRoot/.kontourai/flow-agents/$slug/state.json"
}

# seed_current_pointer <repo_root> <slug> <actor> — #440 FIXTURE-GAP: this suite's
# write_steering_fixture_repo fixtures were written before #440's per-actor ownership scoping and
# never establish a per-actor current pointer for the invoking actor -- under a RESOLVED
# FLOW_AGENTS_ACTOR override, workflow-steering.js's actorScopedWorkflowState now scopes to that
# actor's own (nonexistent) pointer and never reaches the fixture-under-test. Seeds BOTH the
# legacy current.json AND the per-actor current/<actor>.json pointer with the SAME payload,
# mirroring workflow-sidecar.ts's real writeCurrent() dual-write via current-pointer.js's own
# writePerActorCurrent.
seed_current_pointer() {
  local repoRoot="$1" slug="$2" actor="$3"
  local flowAgentsDir="$repoRoot/.kontourai/flow-agents"
  CP_HELPER_ARG="$CURRENT_POINTER_HELPER" DIR_ARG="$flowAgentsDir" SLUG_ARG="$slug" ACTOR_ARG="$actor" node - <<'NODE'
const fs = require('fs');
const path = require('path');
const { writePerActorCurrent } = require(process.env.CP_HELPER_ARG);
const dir = process.env.DIR_ARG;
const slug = process.env.SLUG_ARG;
const actor = process.env.ACTOR_ARG;
const payload = { schema_version: '1.0', active_slug: slug, artifact_dir: slug };
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify(payload, null, 2) + '\n');
writePerActorCurrent(dir, actor, payload);
NODE
}

ROOT_SCRATCH_STATE_WRITER="$TMPDIR_EVAL/write-state-json.js"
cat > "$ROOT_SCRATCH_STATE_WRITER" << 'JSEOF'
const fs = require("fs");
const [,, dest, slug, status, phase, updatedAt, summary] = process.argv;
const state = {
  schema_version: "1.0",
  task_slug: slug,
  status,
  phase,
  updated_at: updatedAt,
  next_action: { status, summary },
};
fs.writeFileSync(dest, JSON.stringify(state, null, 2));
JSEOF

if [[ ! -f "$CLI" ]]; then
  echo "build/src/cli.js not found — run 'npm run build' first" >&2
  exit 1
fi
flow_agents_build_ts || { echo "build failed" >&2; exit 1; }

echo "=== verify-hold gate (#293) ==="

# ─── 1. Superseded A->B blocks A; a stale self-claim (reclaimable) also blocks (AC1) ───────
echo "--- 1. superseded A->B blocks actor A (held, holder=B); stale self-claim (reclaimable) also blocks (AC1) ---"

SUPERSEDE_SLUG="verify-hold-superseded"
SUPERSEDE_DIR="$ARTIFACT_ROOT/$SUPERSEDE_SLUG"

flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$ARTIFACT_ROOT" \
  --task-slug "$SUPERSEDE_SLUG" \
  --actor eval-actor-a-hold \
  --source-request "Actor A establishes the original claim." \
  --summary "Actor A original holder." \
  >"$TMPDIR_EVAL/vh-a-ensure.out" 2>"$TMPDIR_EVAL/vh-a-ensure.err"
A_RECORD="$ARTIFACT_ROOT/assignment/$SUPERSEDE_SLUG.json"
ACTOR_KEY_A="$(actor_key_from_record "$A_RECORD")"
[[ -n "$ACTOR_KEY_A" ]] && pass "actor A's claim established (setup)" || fail "actor A's claim setup failed: $(cat "$TMPDIR_EVAL/vh-a-ensure.out" "$TMPDIR_EVAL/vh-a-ensure.err")"

# Manufacture staleness for A's own claim (an "at" well in the past, past the 1800s ttl), then
# actor B supersedes A via --supersede-stale (the same mechanism
# test_ensure_session_ownership_guard.sh's stale-takeover section already establishes) —
# performLocalSupersede writes B's actor_key as the canonical bare value (F1 fix), so
# runVerifyHold's join sees a genuinely fresh, non-self holder for A's re-check.
append_liveness_event "$ARTIFACT_ROOT" "$SUPERSEDE_SLUG" "$ACTOR_KEY_A" "2026-06-01T10:00:00Z" 1800

flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$ARTIFACT_ROOT" \
  --task-slug "$SUPERSEDE_SLUG" \
  --actor eval-actor-b-hold \
  --supersede-stale \
  --source-request "Actor B takes over the stale claim." \
  --summary "Actor B takeover." \
  >"$TMPDIR_EVAL/vh-b-supersede.out" 2>"$TMPDIR_EVAL/vh-b-supersede.err"
B_SUPERSEDE_EXIT=$?
[[ $B_SUPERSEDE_EXIT -eq 0 ]] && pass "actor B's --supersede-stale takeover succeeds (setup)" || fail "actor B's takeover unexpectedly failed: $(cat "$TMPDIR_EVAL/vh-b-supersede.out" "$TMPDIR_EVAL/vh-b-supersede.err")"

B_RECORD="$ARTIFACT_ROOT/assignment/$SUPERSEDE_SLUG.json"
ACTOR_KEY_B="$(actor_key_from_record "$B_RECORD")"
[[ -n "$ACTOR_KEY_B" ]] && pass "actor B's canonical actor_key recovered from the superseded record (setup)" || fail "could not recover actor B's actor_key"

# Fresh liveness heartbeat for B so the join classifies A's re-check as held(holder=B), not
# merely reclaimable (the un-ambiguous "someone else has a fresh claim" row of the mapping
# table) — matches Conflict #3's resolution (no literal "superseded" state; a superseded-away
# actor's own re-check naturally resolves to held/holder=successor).
NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
append_liveness_event "$ARTIFACT_ROOT" "$SUPERSEDE_SLUG" "$ACTOR_KEY_B" "$NOW_ISO" 1800

mkdir -p "$SUPERSEDE_DIR"
if flow_agents_node "$WRITER" verify-hold "$SUPERSEDE_DIR" --actor "$ACTOR_KEY_A" \
  >"$TMPDIR_EVAL/vh-a-check.out" 2>"$TMPDIR_EVAL/vh-a-check.err"; then
  fail "actor A's verify-hold on the superseded subject should have exited non-zero (AC1)"
else
  pass "actor A's verify-hold on the superseded subject exits non-zero (AC1)"
fi
[[ "$(json_query "$TMPDIR_EVAL/vh-a-check.out" "ok")" == "false" ]] && pass "verify-hold JSON reports ok:false for actor A (AC1)" || fail "verify-hold JSON did not report ok:false: $(cat "$TMPDIR_EVAL/vh-a-check.out")"
[[ "$(json_query "$TMPDIR_EVAL/vh-a-check.out" "effective_state")" == "held" ]] && pass "verify-hold JSON reports effective_state:held (holder=B) for actor A (AC1)" || fail "verify-hold JSON did not report held: $(cat "$TMPDIR_EVAL/vh-a-check.out")"
GUIDANCE_LEN_A="$(json_query "$TMPDIR_EVAL/vh-a-check.out" "guidance.length")"
[[ "$GUIDANCE_LEN_A" -gt 0 ]] && pass "verify-hold's guidance array is non-empty for actor A's block (AC1)" || fail "verify-hold's guidance array was empty for actor A's block"
grep -qF "$ACTOR_KEY_B" "$TMPDIR_EVAL/vh-a-check.out" && pass "verify-hold JSON names actor B as the current holder (AC1)" || fail "verify-hold JSON did not name actor B as holder: $(cat "$TMPDIR_EVAL/vh-a-check.out")"
grep -qiF -- "--supersede-stale" "$TMPDIR_EVAL/vh-a-check.out" && pass "verify-hold's guidance names --supersede-stale as the reconcile path (AC1)" || fail "verify-hold's guidance did not name --supersede-stale: $(cat "$TMPDIR_EVAL/vh-a-check.out")"

# ─── 1b. A manufactured STALE claim (reclaimable) ALSO blocks a re-checking actor (Stop-short risk) ─
echo "--- 1b. stale claim (reclaimable) blocks a re-checking actor, never a silent pass (AC1) ---"

# computeEffectiveState's self-check (record.actor_key === selfActor) is checked BEFORE
# freshness (assignment-provider.ts around line 366) — so the ORIGINAL claimant's own re-check
# always self-recognizes as self_is_holder regardless of staleness (matching
# enforceEnsureSessionOwnership's own precedent: its reclaimable-takeover eval section always
# has a DIFFERENT actor re-check the stale claim, never the same stale actor checking itself).
# The Stop-short risk this guards against is therefore: a DIFFERENT, not-yet-superseded re-checking
# actor (e.g. a monitoring/handoff tool, or a second session considering takeover) must see
# reclaimable and be BLOCKED — never silently treated as "no one holds this, proceed" — until an
# explicit --supersede-stale takeover happens. This is exactly what "reclaimable is never PASS"
# protects: it would be wrong to auto-pass verify-hold for a reclaimable subject just because the
# original holder's liveness went stale.
RECLAIMABLE_SLUG="verify-hold-reclaimable"
RECLAIMABLE_DIR="$ARTIFACT_ROOT/$RECLAIMABLE_SLUG"
flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$ARTIFACT_ROOT" \
  --task-slug "$RECLAIMABLE_SLUG" \
  --actor eval-actor-stale-original \
  --source-request "Actor establishes the soon-to-be-stale claim." \
  --summary "Original holder." \
  >"$TMPDIR_EVAL/vh-stale-setup.out" 2>"$TMPDIR_EVAL/vh-stale-setup.err"
RECLAIMABLE_RECORD="$ARTIFACT_ROOT/assignment/$RECLAIMABLE_SLUG.json"
ACTOR_KEY_STALE="$(actor_key_from_record "$RECLAIMABLE_RECORD")"
# A liveness event whose `at` is well past ttlSeconds (1800s) relative to real wall-clock now,
# with NO fresher heartbeat — the record exists but is no longer backed by a fresh liveness
# claim, so a DIFFERENT actor's re-check join classifies it reclaimable (not held/free).
append_liveness_event "$ARTIFACT_ROOT" "$RECLAIMABLE_SLUG" "$ACTOR_KEY_STALE" "2026-06-01T10:00:00Z" 1800

mkdir -p "$RECLAIMABLE_DIR"
if flow_agents_node "$WRITER" verify-hold "$RECLAIMABLE_DIR" --actor eval-actor-stale-rechecker \
  >"$TMPDIR_EVAL/vh-reclaimable.out" 2>"$TMPDIR_EVAL/vh-reclaimable.err"; then
  fail "verify-hold on a reclaimable (stale) claim, re-checked by a DIFFERENT actor, should have exited non-zero — reclaimable must never be silently treated as pass (AC1)"
else
  pass "verify-hold on a reclaimable (stale) claim, re-checked by a different actor, exits non-zero — reclaimable is never treated as pass (AC1)"
fi
[[ "$(json_query "$TMPDIR_EVAL/vh-reclaimable.out" "effective_state")" == "reclaimable" ]] && pass "verify-hold JSON reports effective_state:reclaimable for the stale claim's re-check (AC1)" || fail "verify-hold JSON did not report reclaimable: $(cat "$TMPDIR_EVAL/vh-reclaimable.out")"
RECLAIMABLE_GUIDANCE_LEN="$(json_query "$TMPDIR_EVAL/vh-reclaimable.out" "guidance.length")"
[[ "$RECLAIMABLE_GUIDANCE_LEN" -gt 0 ]] && pass "verify-hold's guidance array is non-empty for the reclaimable block (AC1)" || fail "verify-hold's guidance array was empty for the reclaimable block"

# Regression: the ORIGINAL claimant's own re-check still self-recognizes (self_is_holder wins
# over staleness by design — this is NOT the reclaimable case; asserted here so the eval does not
# accidentally rely on the wrong actor identity to prove the reclaimable-blocks assertion above).
if flow_agents_node "$WRITER" verify-hold "$RECLAIMABLE_DIR" --actor "$ACTOR_KEY_STALE" \
  >"$TMPDIR_EVAL/vh-reclaimable-self.out" 2>"$TMPDIR_EVAL/vh-reclaimable-self.err"; then
  pass "the original claimant's own re-check on its stale claim still self-recognizes (self_is_holder), confirming reclaimable only applies to a re-check by a DIFFERENT actor (AC1 regression)"
else
  fail "the original claimant's own re-check unexpectedly refused: $(cat "$TMPDIR_EVAL/vh-reclaimable-self.out" "$TMPDIR_EVAL/vh-reclaimable-self.err")"
fi

# ─── 1c. Liveness-only presence (NO durable assignment record) never blocks a mismatched actor
# (bug fix, #397) ───────────────────────────────────────────────────────────────────────────
echo "--- 1c. liveness claim by another actor with NO assignment record passes for a mismatched actor (#397 fix) ---"

# This is the exact CI-reproduced false-block: computeEffectiveState's `!isAssigned` branch
# (assignment-provider.ts) returns held/liveness_claim_present_assignment_lagging when there is
# a fresh liveness `claim` event for the subject but NO assignment record was ever written
# (never claimed via ensure-session/assignment-provider claim -- e.g. a liveness-only heartbeat
# with no durable follow-through, exactly what antigaming-suite.sh's own liveness-seeding does
# for its own unrelated tests). runVerifyHold must PASS this case: liveness alone is advisory
# everywhere else in the system, and this is the ONE hard gate, so it must fence the durable
# ASSIGNMENT hold, never ambient liveness presence.
LIVENESS_ONLY_SLUG="verify-hold-liveness-only-no-assignment"
LIVENESS_ONLY_DIR="$ARTIFACT_ROOT/$LIVENESS_ONLY_SLUG"
mkdir -p "$LIVENESS_ONLY_DIR"

# Fresh liveness `claim` event by "other-actor" -- NO write_assignment_record call at all, so
# readLocalAssignmentStatus resolves no record/no assignee for this slug (isAssigned === false).
append_liveness_event "$ARTIFACT_ROOT" "$LIVENESS_ONLY_SLUG" "other-actor" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" 1800

if flow_agents_node "$WRITER" verify-hold "$LIVENESS_ONLY_DIR" --actor "ci-mismatched-actor" \
  >"$TMPDIR_EVAL/vh-liveness-only.out" 2>"$TMPDIR_EVAL/vh-liveness-only.err"; then
  pass "verify-hold PASSES for a mismatched actor when only ambient liveness (no assignment record) exists (#397 fix)"
else
  fail "verify-hold false-blocked a mismatched actor on liveness-only presence (NO assignment record) -- #397 regression: $(cat "$TMPDIR_EVAL/vh-liveness-only.out" "$TMPDIR_EVAL/vh-liveness-only.err")"
fi
[[ "$(json_query "$TMPDIR_EVAL/vh-liveness-only.out" "ok")" == "true" ]] && pass "verify-hold JSON reports ok:true for the liveness-only, no-assignment case (#397 fix)" || fail "verify-hold JSON did not report ok:true for the liveness-only case: $(cat "$TMPDIR_EVAL/vh-liveness-only.out")"
[[ "$(json_query "$TMPDIR_EVAL/vh-liveness-only.out" "effective_state")" == "held" ]] && pass "verify-hold JSON still reports effective_state:held for the liveness-only case (computeEffectiveState's own label is unchanged -- only the publish-decision mapping changed) (#397 fix)" || fail "verify-hold JSON did not report held: $(cat "$TMPDIR_EVAL/vh-liveness-only.out")"
[[ "$(json_query "$TMPDIR_EVAL/vh-liveness-only.out" "reason")" == "liveness_claim_present_assignment_lagging" ]] && pass "verify-hold JSON's reason is liveness_claim_present_assignment_lagging (the precise reason this fix targets) (#397 fix)" || fail "verify-hold JSON's reason was not liveness_claim_present_assignment_lagging: $(cat "$TMPDIR_EVAL/vh-liveness-only.out")"

# ─── 1d. Unstable (ancestry/unresolved) current actor is advisory-only, never hard-blocked;
# the SAME seed still hard-blocks a STABLE, differing FLOW_AGENTS_ACTOR (SECOND CI-blocking
# false-block fix, this iteration) ──────────────────────────────────────────────────────────
echo "--- 1d. unstable current actor (ancestry fallback) is advisory-only (ok:true); a STABLE differing actor still BLOCKS (AC1) ---"

# This pins the advisory-degradation path for an UNSTABLE actor identity: with no explicit override,
# no native runtime session id, AND no CI-provider identity (#398), resolveActor() falls through to
# the process-ancestry (or unresolved) layer -- an identity that is NOT guaranteed to match the
# identity that created the claim below, so the gate must degrade to advisory (never hard-block).
# NOTE (#398): this case must EXPLICITLY neutralize the CI-provider markers. When this suite runs in
# real CI (GitHub Actions etc.), those markers are set and resolveActor() would now resolve a STABLE
# `ci-runtime:*` actor -- which correctly ENFORCES (that IS the #398 payoff, covered by
# test_ci_actor_identity.sh). Reproducing the ancestry/unstable scenario therefore requires the test
# to control ALL identity inputs, not rely on the ambient absence of CI env vars. Seed a fresh
# assignment claim held by a clearly different, stable actor ("eval-actor-unstable-holder"), then:
#   (a) run verify-hold with NO override, NO native session id, and NO CI markers (ancestry fallback)
#       -- must be advisory-only: ok:true, exit 0, reason actor-identity-unstable-advisory-only.
#   (b) run verify-hold with a STABLE FLOW_AGENTS_ACTOR that legitimately differs from the holder
#       -- must still BLOCK exactly as before (zombie protection intact under a stable identity).
UNSTABLE_SLUG="verify-hold-unstable-actor"
UNSTABLE_DIR="$ARTIFACT_ROOT/$UNSTABLE_SLUG"
write_assignment_record "$ARTIFACT_ROOT" "$UNSTABLE_SLUG" "unstable-holder-session" "eval-actor-unstable-holder"
append_liveness_event "$ARTIFACT_ROOT" "$UNSTABLE_SLUG" "eval-actor-unstable-holder" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" 1800
mkdir -p "$UNSTABLE_DIR"

# (a) Unstable current actor: unset the explicit override, the native runtime session id, AND every
# CI-provider marker (#398) so resolveActor() genuinely falls through to process-ancestry/unresolved
# regardless of whether this suite is running inside a CI job.
if (unset FLOW_AGENTS_ACTOR CLAUDE_CODE_SESSION_ID CODEX_THREAD_ID CODEX_SESSION_ID OPENCODE_SESSION_ID PI_SESSION_ID CLAUDECODE \
      GITHUB_ACTIONS GITLAB_CI CIRCLECI JENKINS_URL TF_BUILD BUILDKITE; \
    flow_agents_node "$WRITER" verify-hold "$UNSTABLE_DIR") >"$TMPDIR_EVAL/vh-unstable.out" 2>"$TMPDIR_EVAL/vh-unstable.err"; then
  pass "verify-hold with an unstable (ancestry/unresolved) current actor does NOT hard-block a subject held by a different actor (advisory-only, AC1 SECOND fix)"
else
  fail "verify-hold with an unstable current actor incorrectly hard-blocked -- this IS the CI false-block this fix targets: $(cat "$TMPDIR_EVAL/vh-unstable.out" "$TMPDIR_EVAL/vh-unstable.err")"
fi
[[ "$(json_query "$TMPDIR_EVAL/vh-unstable.out" "ok")" == "true" ]] && pass "unstable-actor verify-hold JSON reports ok:true (AC1 SECOND fix)" || fail "unstable-actor verify-hold JSON did not report ok:true: $(cat "$TMPDIR_EVAL/vh-unstable.out")"
[[ "$(json_query "$TMPDIR_EVAL/vh-unstable.out" "reason")" == "actor-identity-unstable-advisory-only" ]] && pass "unstable-actor verify-hold JSON's reason is actor-identity-unstable-advisory-only (AC1 SECOND fix)" || fail "unstable-actor verify-hold JSON's reason was not actor-identity-unstable-advisory-only: $(cat "$TMPDIR_EVAL/vh-unstable.out")"
grep -qiF "advisory only for unstable identities" "$TMPDIR_EVAL/vh-unstable.err" && pass "unstable-actor verify-hold logs a visible stderr advisory note, never silent (AC1 SECOND fix)" || fail "unstable-actor verify-hold did not log the advisory stderr note: $(cat "$TMPDIR_EVAL/vh-unstable.err")"

# (b) STABLE but differing actor (explicit FLOW_AGENTS_ACTOR override) on the SAME seed -- must
# still hard-block exactly as before this fix (zombie protection intact under a stable identity).
if FLOW_AGENTS_ACTOR="eval-actor-unstable-rechecker" flow_agents_node "$WRITER" verify-hold "$UNSTABLE_DIR"   >"$TMPDIR_EVAL/vh-stable-differs.out" 2>"$TMPDIR_EVAL/vh-stable-differs.err"; then
  fail "verify-hold with a STABLE, differing FLOW_AGENTS_ACTOR should have hard-blocked on the same seed (AC1 SECOND fix, zombie-protection regression)"
else
  pass "verify-hold with a STABLE, differing FLOW_AGENTS_ACTOR still hard-blocks on the same seed (AC1, zombie protection intact under stable identity)"
fi
[[ "$(json_query "$TMPDIR_EVAL/vh-stable-differs.out" "ok")" == "false" ]] && pass "stable-differing-actor verify-hold JSON reports ok:false (AC1 SECOND fix regression guard)" || fail "stable-differing-actor verify-hold JSON did not report ok:false: $(cat "$TMPDIR_EVAL/vh-stable-differs.out")"
grep -qF "eval-actor-unstable-holder" "$TMPDIR_EVAL/vh-stable-differs.out" && pass "stable-differing-actor verify-hold JSON still names the current holder (AC1 SECOND fix regression guard)" || fail "stable-differing-actor verify-hold JSON did not name the holder: $(cat "$TMPDIR_EVAL/vh-stable-differs.out")"

# ─── 2. Composition: record-release / publish-delivery as actor A refuse, no delivery/ write (AC1, AC3) ─
echo "--- 2. publishDelivery()/record-release as actor A (superseded) refuse with NotFreshHolderError, never write delivery/ (AC1, AC3) ---"

REPO_A="$TMPDIR_EVAL/repo-a"
mkdir -p "$REPO_A/kits"
AROOT_A="$REPO_A/.kontourai/flow-agents"
COMPOSE_SLUG="verify-hold-compose-block"
COMPOSE_DIR="$AROOT_A/$COMPOSE_SLUG"

BUNDLE_A="$TMPDIR_EVAL/bundle-a.json"
write_bundle_to "$BUNDLE_A" "node --version" "true"
setup_session "$AROOT_A" "$COMPOSE_SLUG" "$BUNDLE_A"

# Seed a fresh, un-ambiguous superseded-A->B fixture directly (write_assignment_record +
# append_liveness_event, matching section 1's shape), then run record-release/publish-delivery
# AS ACTOR A (FLOW_AGENTS_ACTOR override) with a manifest that makes the bundle shape-VALID —
# isolating the hold gate specifically here (the shape gate's ordering is proven separately in
# section 4 below).
write_assignment_record "$AROOT_A" "$COMPOSE_SLUG" "eval-actor-b-compose" "eval-actor-b-compose"
append_liveness_event "$AROOT_A" "$COMPOSE_SLUG" "eval-actor-b-compose" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" 1800

rr_out=$(FLOW_AGENTS_ACTOR="eval-actor-a-compose" TRUST_RECONCILE_COMMANDS="node --version" flow_agents_node "$WRITER" record-release "$COMPOSE_DIR" \
  --decision merge \
  --gate-json '{"name":"merge","status":"pass","summary":"Ready."}' \
  --summary "Release." --repo-root "$REPO_A" \
  --timestamp "2026-07-04T10:04:00Z" 2>&1)
rr_exit=$?
if [[ $rr_exit -ne 0 ]]; then
  pass "record-release as superseded-away actor A exits non-zero (AC1)"
else
  fail "record-release as superseded-away actor A should have exited non-zero: $rr_out"
fi
echo "$rr_out" | grep -qiF "verify-hold gate" && pass "record-release's refusal names the verify-hold gate (AC1, AC3)" || fail "record-release's refusal did not name the verify-hold gate: $rr_out"
[[ ! -d "$REPO_A/delivery/$COMPOSE_SLUG" ]] && pass "record-release's verify-hold refusal never created delivery/$COMPOSE_SLUG/ (AC1)" || fail "delivery/$COMPOSE_SLUG/ was created despite the verify-hold refusal"

pd_out=$(FLOW_AGENTS_ACTOR="eval-actor-a-compose" TRUST_RECONCILE_COMMANDS="node --version" flow_agents_node "$WRITER" publish-delivery "$COMPOSE_DIR" --repo-root "$REPO_A" 2>&1)
pd_exit=$?
if [[ $pd_exit -ne 0 ]]; then
  pass "publish-delivery as superseded-away actor A exits non-zero (AC1, AC3)"
else
  fail "publish-delivery as superseded-away actor A should have exited non-zero: $pd_out"
fi
echo "$pd_out" | grep -qiF "verify-hold refused publish" && pass "publish-delivery's thrown error message is the NotFreshHolderError text (AC3)" || fail "publish-delivery's error was not the NotFreshHolderError message: $pd_out"
[[ ! -d "$REPO_A/delivery/$COMPOSE_SLUG" ]] && pass "publish-delivery's verify-hold refusal never created delivery/$COMPOSE_SLUG/ (AC1)" || fail "delivery/$COMPOSE_SLUG/ was created despite the publish-delivery refusal"

# ─── 3. Fresh holder + free subject pass (AC2) ─────────────────────────────────────────────
echo "--- 3. actor B (fresh holder) passes; a free subject passes for any actor (AC2) ---"

if flow_agents_node "$WRITER" verify-hold "$SUPERSEDE_DIR" --actor "$ACTOR_KEY_B" \
  >"$TMPDIR_EVAL/vh-b-check.out" 2>"$TMPDIR_EVAL/vh-b-check.err"; then
  pass "actor B's (fresh holder) verify-hold on the same subject exits 0 (AC2)"
else
  fail "actor B's verify-hold unexpectedly refused: $(cat "$TMPDIR_EVAL/vh-b-check.out" "$TMPDIR_EVAL/vh-b-check.err")"
fi
[[ "$(json_query "$TMPDIR_EVAL/vh-b-check.out" "ok")" == "true" ]] && pass "verify-hold JSON reports ok:true for actor B (AC2)" || fail "verify-hold JSON did not report ok:true for actor B: $(cat "$TMPDIR_EVAL/vh-b-check.out")"

FREE_SLUG="verify-hold-free-subject"
FREE_DIR="$ARTIFACT_ROOT/$FREE_SLUG"
mkdir -p "$FREE_DIR"
if flow_agents_node "$WRITER" verify-hold "$FREE_DIR" --actor "eval-actor-any-reader" \
  >"$TMPDIR_EVAL/vh-free.out" 2>"$TMPDIR_EVAL/vh-free.err"; then
  pass "verify-hold on a free (no assignment record) subject exits 0 for any actor (AC2)"
else
  fail "verify-hold on a free subject unexpectedly refused: $(cat "$TMPDIR_EVAL/vh-free.out" "$TMPDIR_EVAL/vh-free.err")"
fi
[[ "$(json_query "$TMPDIR_EVAL/vh-free.out" "effective_state")" == "free" ]] && pass "verify-hold JSON reports effective_state:free for the untracked subject (AC2)" || fail "verify-hold JSON did not report free: $(cat "$TMPDIR_EVAL/vh-free.out")"

# ─── 4. #356 shape-gate composition ordering: shape runs BEFORE hold (AC3) ─────────────────
echo "--- 4. composition ordering: shape-invalid+not-held -> InvalidBundleShapeError; shape-valid+not-held -> NotFreshHolderError (AC3) ---"

REPO4="$TMPDIR_EVAL/repo4"
mkdir -p "$REPO4/kits"
AROOT4="$REPO4/.kontourai/flow-agents"

# 4a. BOTH shape-invalid AND not-held: no TRUST_RECONCILE_COMMANDS env, so "node --version"
# resolves to no manifest entry (shape-invalid, matching test_publish_delivery.sh TEST 6's own
# not-run fixture); PLUS not-held via a superseded-away FLOW_AGENTS_ACTOR override.
SLUG_4A="verify-hold-both-invalid"
DIR_4A="$AROOT4/$SLUG_4A"
BUNDLE_4A="$TMPDIR_EVAL/bundle-4a.json"
write_bundle_to "$BUNDLE_4A" "node --version" "true"
setup_session "$AROOT4" "$SLUG_4A" "$BUNDLE_4A"

write_assignment_record "$AROOT4" "$SLUG_4A" "eval-actor-holder-4a" "eval-actor-holder-4a"
append_liveness_event "$AROOT4" "$SLUG_4A" "eval-actor-holder-4a" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" 1800

both_invalid_out=$(FLOW_AGENTS_ACTOR="eval-actor-not-holder-4a" flow_agents_node "$WRITER" publish-delivery "$DIR_4A" --repo-root "$REPO4" 2>&1)
both_invalid_exit=$?
if [[ $both_invalid_exit -ne 0 ]]; then
  pass "shape-invalid+not-held bundle: publish-delivery exits non-zero (AC3)"
else
  fail "shape-invalid+not-held bundle should have exited non-zero: $both_invalid_out"
fi
echo "$both_invalid_out" | grep -qiF "reconcile-preflight shape check" && pass "shape-invalid+not-held bundle: SHAPE error fires specifically (InvalidBundleShapeError text), never the hold error (AC3, ordering proof)" || fail "shape-invalid+not-held bundle did not surface the shape-check error text: $both_invalid_out"
if echo "$both_invalid_out" | grep -qiF "verify-hold refused publish"; then
  fail "shape-invalid+not-held bundle incorrectly surfaced the NotFreshHolderError text — the shape gate must run FIRST and refuse before the hold gate is ever reached (AC3 ordering violation)"
else
  pass "shape-invalid+not-held bundle never surfaces the NotFreshHolderError text — confirms the shape gate runs strictly before the hold gate (AC3)"
fi
[[ ! -d "$REPO4/delivery/$SLUG_4A" ]] && pass "shape-invalid+not-held bundle: delivery/$SLUG_4A/ was never created (AC3)" || fail "delivery/$SLUG_4A/ was created despite the shape refusal"

# 4b. shape-VALID (manifest-matched) but not-held: proves the hold gate IS reachable once the
# shape gate passes — genuinely exercises the SECOND, distinct error type, not just "shape
# always wins".
SLUG_4B="verify-hold-shape-valid-not-held"
DIR_4B="$AROOT4/$SLUG_4B"
BUNDLE_4B="$TMPDIR_EVAL/bundle-4b.json"
write_bundle_to "$BUNDLE_4B" "node --version" "true"
setup_session "$AROOT4" "$SLUG_4B" "$BUNDLE_4B"

write_assignment_record "$AROOT4" "$SLUG_4B" "eval-actor-holder-4b" "eval-actor-holder-4b"
append_liveness_event "$AROOT4" "$SLUG_4B" "eval-actor-holder-4b" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" 1800

shape_valid_not_held_out=$(FLOW_AGENTS_ACTOR="eval-actor-not-holder-4b" TRUST_RECONCILE_COMMANDS="node --version" flow_agents_node "$WRITER" publish-delivery "$DIR_4B" --repo-root "$REPO4" 2>&1)
shape_valid_not_held_exit=$?
if [[ $shape_valid_not_held_exit -ne 0 ]]; then
  pass "shape-valid+not-held bundle: publish-delivery exits non-zero (AC3)"
else
  fail "shape-valid+not-held bundle should have exited non-zero: $shape_valid_not_held_out"
fi
echo "$shape_valid_not_held_out" | grep -qiF "verify-hold refused publish" && pass "shape-valid+not-held bundle: HOLD error fires specifically (NotFreshHolderError text) — the hold gate IS reachable once shape passes (AC3, ordering proof)" || fail "shape-valid+not-held bundle did not surface the NotFreshHolderError text: $shape_valid_not_held_out"
if echo "$shape_valid_not_held_out" | grep -qiF "reconcile-preflight shape check"; then
  fail "shape-valid+not-held bundle incorrectly surfaced the shape-check error text — the bundle is shape-valid, only the hold gate should fire"
else
  pass "shape-valid+not-held bundle never surfaces the shape-check error text — confirms the two gates are genuinely distinct, not conflated (AC3)"
fi
[[ ! -d "$REPO4/delivery/$SLUG_4B" ]] && pass "shape-valid+not-held bundle: delivery/$SLUG_4B/ was never created (AC3)" || fail "delivery/$SLUG_4B/ was created despite the hold refusal"

# ─── 4c. AC3 composition distinctness via .code/.instanceof (F3 fix, fix-plan iteration 1) ──
# The plan's own Stop-short risks section named this exact gap: the two error classes could be
# collapsed into one while keeping distinct message text, and a pure stderr string-match (4a/4b
# above) would never catch it. This harness imports the COMPILED build/src/cli/workflow-sidecar.js
# directly (never re-implements a parallel check) and calls the exported publishDelivery()
# against the SAME two fixtures 4a/4b already built above, asserting the CAUGHT error's `.code`
# discriminator and `instanceof` — a genuine type-discriminator defense, not a message-text match.
echo "--- 4c. composition distinctness: .code/instanceof assertion on the SAME 4a/4b fixtures (F3, AC3) ---"

# Compiled output is a real ES module (package.json "type": "module") -- require() cannot
# load it. Use dynamic import() via a file:// URL, matching this repo's own established
# dynamic-import-of-build-output convention (test_bundle_lifecycle.sh / test_checkpoint_signing.sh).
CODE_HARNESS="$TMPDIR_EVAL/verify-hold-code-harness.mjs"
python3 - "$CODE_HARNESS" << 'PY'
import sys
out = sys.argv[1]
code_lines = [
  "import { pathToFileURL } from 'node:url';",
  "",
  "async function run() {",
  "  const buildJsPath = process.env.WORKFLOW_SIDECAR_BUILD_JS;",
  "  const mod = await import(pathToFileURL(buildJsPath).href);",
  "  const { publishDelivery, InvalidBundleShapeError, NotFreshHolderError } = mod;",
  "  const dir = process.argv[2];",
  "  const repoRoot = process.argv[3];",
  "  try {",
  "    await publishDelivery(dir, repoRoot);",
  "    console.log(JSON.stringify({ threw: false }));",
  "  } catch (err) {",
  "    console.log(JSON.stringify({",
  "      threw: true,",
  "      code: err && err.code,",
  "      name: err && err.name,",
  "      isInvalidBundleShapeError: err instanceof InvalidBundleShapeError,",
  "      isNotFreshHolderError: err instanceof NotFreshHolderError,",
  "    }));",
  "  }",
  "}",
  "",
  "run();",
]
with open(out, "w") as f:
    f.write("\n".join(code_lines) + "\n")
PY

WORKFLOW_SIDECAR_BUILD_JS="$ROOT/build/src/cli/workflow-sidecar.js"
export WORKFLOW_SIDECAR_BUILD_JS

# extract_json_field <jsonLine> <fieldName> -- the harness prints exactly one JSON line to
# stdout; parse it with a tiny inline node -p (no fragile shell string-splitting).
extract_json_field() {
  node -p "(() => { try { return JSON.parse(process.argv[1])[process.argv[2]]; } catch (e) { return ''; } })()" "$1" "$2" 2>/dev/null
}

code_4a_out=$(FLOW_AGENTS_ACTOR="eval-actor-not-holder-4a" node "$CODE_HARNESS" "$DIR_4A" "$REPO4" 2>&1)
code_4a_json=$(echo "$code_4a_out" | tail -1)
code_4a_code=$(extract_json_field "$code_4a_json" code)
code_4a_is_shape=$(extract_json_field "$code_4a_json" isInvalidBundleShapeError)
if [[ "$code_4a_code" == "RECONCILE_PREFLIGHT_INVALID_SHAPE" ]]; then
  pass "shape-invalid+not-held bundle: caught error .code === RECONCILE_PREFLIGHT_INVALID_SHAPE (F3, AC3 type-discriminator)"
else
  fail "shape-invalid+not-held bundle: caught error .code was '$code_4a_code', expected RECONCILE_PREFLIGHT_INVALID_SHAPE: $code_4a_out"
fi
if [[ "$code_4a_is_shape" == "true" ]]; then
  pass "shape-invalid+not-held bundle: caught error is instanceof InvalidBundleShapeError (F3, AC3)"
else
  fail "shape-invalid+not-held bundle: caught error is NOT instanceof InvalidBundleShapeError: $code_4a_out"
fi

code_4b_out=$(FLOW_AGENTS_ACTOR="eval-actor-not-holder-4b" TRUST_RECONCILE_COMMANDS="node --version" node "$CODE_HARNESS" "$DIR_4B" "$REPO4" 2>&1)
code_4b_json=$(echo "$code_4b_out" | tail -1)
code_4b_code=$(extract_json_field "$code_4b_json" code)
code_4b_is_hold=$(extract_json_field "$code_4b_json" isNotFreshHolderError)
if [[ "$code_4b_code" == "VERIFY_HOLD_NOT_FRESH_HOLDER" ]]; then
  pass "shape-valid+not-held bundle: caught error .code === VERIFY_HOLD_NOT_FRESH_HOLDER (F3, AC3 type-discriminator)"
else
  fail "shape-valid+not-held bundle: caught error .code was '$code_4b_code', expected VERIFY_HOLD_NOT_FRESH_HOLDER: $code_4b_out"
fi
if [[ "$code_4b_is_hold" == "true" ]]; then
  pass "shape-valid+not-held bundle: caught error is instanceof NotFreshHolderError (F3, AC3)"
else
  fail "shape-valid+not-held bundle: caught error is NOT instanceof NotFreshHolderError: $code_4b_out"
fi
[[ "$code_4a_code" != "$code_4b_code" ]] && pass "F3: the two composition-gate error codes are genuinely distinct strings ('$code_4a_code' != '$code_4b_code'), not the same class with different message text" || fail "F3: the two composition-gate error codes are IDENTICAL — this is exactly the stop-short risk the plan named"

# ─── 5. github-provider precomputed gate (AC6) ─────────────────────────────────────────────
echo "--- 5. github-provider read-only precomputed gate: no gh process, not_evaluated fallback (AC6) ---"

GITHUB_NOT_HELD_FIXTURE="$TMPDIR_EVAL/github-not-held.json"
node -e '
const fs = require("fs");
const fixture = { effective: { effective_state: "held", reason: "fresh_liveness_heartbeat", holder: { actor: "github-holder-actor", idle_days: 0 } } };
fs.writeFileSync(process.argv[1], JSON.stringify(fixture, null, 2));
' "$GITHUB_NOT_HELD_FIXTURE"
GITHUB_DIR="$ARTIFACT_ROOT/verify-hold-github-not-held"
mkdir -p "$GITHUB_DIR"
if flow_agents_node "$WRITER" verify-hold "$GITHUB_DIR" \
  --actor eval-actor-github-reader \
  --assignment-provider github \
  --effective-state-json "$GITHUB_NOT_HELD_FIXTURE" \
  >"$TMPDIR_EVAL/vh-github-not-held.out" 2>"$TMPDIR_EVAL/vh-github-not-held.err"; then
  fail "verify-hold --assignment-provider github with a not-held precomputed state should have exited non-zero (AC6)"
else
  pass "verify-hold --assignment-provider github with a not-held precomputed state exits non-zero (AC6)"
fi
[[ "$(json_query "$TMPDIR_EVAL/vh-github-not-held.out" "ok")" == "false" ]] && pass "github-provider precomputed not-held state reports ok:false (AC6)" || fail "github-provider precomputed not-held state did not report ok:false: $(cat "$TMPDIR_EVAL/vh-github-not-held.out")"

GITHUB_HELD_SELF_FIXTURE="$TMPDIR_EVAL/github-held-self.json"
node -e '
const fs = require("fs");
const fixture = { effective: { effective_state: "held", reason: "self_is_holder", holder: { actor: "eval-actor-github-reader", idle_days: 0 } } };
fs.writeFileSync(process.argv[1], JSON.stringify(fixture, null, 2));
' "$GITHUB_HELD_SELF_FIXTURE"
if flow_agents_node "$WRITER" verify-hold "$GITHUB_DIR" \
  --actor eval-actor-github-reader \
  --assignment-provider github \
  --effective-state-json "$GITHUB_HELD_SELF_FIXTURE" \
  >"$TMPDIR_EVAL/vh-github-held-self.out" 2>"$TMPDIR_EVAL/vh-github-held-self.err"; then
  pass "verify-hold --assignment-provider github with a held-self precomputed state exits 0 (AC6)"
else
  fail "verify-hold --assignment-provider github with a held-self precomputed state unexpectedly refused: $(cat "$TMPDIR_EVAL/vh-github-held-self.out" "$TMPDIR_EVAL/vh-github-held-self.err")"
fi

# No `gh` process is ever spawned by this eval's own invocations (the fixtures above are read
# directly from disk via --effective-state-json — render-don't-execute). Additionally assert
# the CLI source itself never shells `gh` from workflow-sidecar.ts's build output (matching the
# render-don't-execute convention's own self-check pattern): only fail if a literal live-process
# invocation (execFileSync/spawn/exec) targets "gh" — a "gh" token elsewhere (e.g. render-claim's
# emitted gh_commands prose) is not itself a live invocation.
if grep -qE '(execFileSync|spawnSync|spawn|execFile|exec)\(\s*["'"'"']gh["'"'"']' "$ROOT/build/src/cli/workflow-sidecar.js" 2>/dev/null; then
  fail "workflow-sidecar.js contains a live 'gh' process invocation — violates render-don't-execute (AC6)"
else
  pass "workflow-sidecar.js never shells out to a live 'gh' process (render-don't-execute preserved) (AC6)"
fi

# Neither github handling (no --effective-state-json) nor a resolvable local-file join
# (--assignment-provider github, no local assignment record for this fresh slug) -> not_evaluated,
# never a silent block.
NOT_EVAL_DIR="$ARTIFACT_ROOT/verify-hold-not-evaluated"
mkdir -p "$NOT_EVAL_DIR"
if flow_agents_node "$WRITER" verify-hold "$NOT_EVAL_DIR" --actor eval-actor-not-eval --assignment-provider github \
  >"$TMPDIR_EVAL/vh-not-evaluated.out" 2>"$TMPDIR_EVAL/vh-not-evaluated.err"; then
  pass "verify-hold with neither github fixture nor local-file resolution exits 0 (not_evaluated, never a silent block) (AC6)"
else
  fail "verify-hold with no resolvable join should PASS-through (not_evaluated), not block: $(cat "$TMPDIR_EVAL/vh-not-evaluated.out" "$TMPDIR_EVAL/vh-not-evaluated.err")"
fi
[[ "$(json_query "$TMPDIR_EVAL/vh-not-evaluated.out" "effective_state")" == "not_evaluated" ]] && pass "verify-hold JSON reports effective_state:not_evaluated for the unresolvable-provider case (AC6)" || fail "verify-hold JSON did not report not_evaluated: $(cat "$TMPDIR_EVAL/vh-not-evaluated.out")"
grep -qiF "not evaluated" "$TMPDIR_EVAL/vh-not-evaluated.err" && pass "verify-hold's not_evaluated case logs a visible stderr reason (AC6)" || fail "verify-hold's not_evaluated case did not log a visible stderr reason: $(cat "$TMPDIR_EVAL/vh-not-evaluated.err")"

# ─── 6. Injection discipline (AC7) ─────────────────────────────────────────────────────────
echo "--- 6. hostile holder actor string never leaks raw control/ANSI bytes (AC7) ---"

HOSTILE_SLUG="verify-hold-hostile-liveness"
HOSTILE_DIR="$ARTIFACT_ROOT/$HOSTILE_SLUG"
HOSTILE_HOLDER_ACTOR=$'hostile-holder-actor\x1b[31;1mFAKE\x07-admin'
write_assignment_record "$ARTIFACT_ROOT" "$HOSTILE_SLUG" "hostile-session" "$HOSTILE_HOLDER_ACTOR"
append_liveness_event "$ARTIFACT_ROOT" "$HOSTILE_SLUG" "$HOSTILE_HOLDER_ACTOR" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" 1800
mkdir -p "$HOSTILE_DIR"

if flow_agents_node "$WRITER" verify-hold "$HOSTILE_DIR" --actor eval-actor-hostile-reader \
  >"$TMPDIR_EVAL/vh-hostile.out" 2>"$TMPDIR_EVAL/vh-hostile.err"; then
  fail "verify-hold against a hostile holder should have refused (AC1 shape, AC7)"
else
  pass "verify-hold against a hostile holder actor refuses (held, not-self) (AC7 setup)"
fi
if grep -qF $'\x1b[31;1m' "$TMPDIR_EVAL/vh-hostile.out" "$TMPDIR_EVAL/vh-hostile.err" || grep -qF $'\x07' "$TMPDIR_EVAL/vh-hostile.out" "$TMPDIR_EVAL/vh-hostile.err"; then
  fail "hostile holder actor's raw ANSI/control bytes leaked into verify-hold's JSON output or stderr (AC7)"
else
  pass "hostile holder actor's raw ANSI/control bytes never leak into verify-hold's JSON output or stderr (AC7)"
fi
grep -qF "hostile-holder-actor" "$TMPDIR_EVAL/vh-hostile.out" && pass "the sanitized (non-control-byte) portion of the hostile holder actor string still appears in verify-hold's output (AC7)" || fail "sanitized portion of the hostile holder actor string was unexpectedly dropped entirely: $(cat "$TMPDIR_EVAL/vh-hostile.out")"

# Steering hook side of AC7: the SAME hostile holder, surfaced via the supersession notice.
STEERING_REPO="$TMPDIR_EVAL/steering-hostile-repo"
STEERING_HOSTILE_NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
write_steering_fixture_repo "$STEERING_REPO" "$HOSTILE_SLUG" "$STEERING_HOSTILE_NOW"
append_liveness_event "$STEERING_REPO/.kontourai/flow-agents" "$HOSTILE_SLUG" "$HOSTILE_HOLDER_ACTOR" "$STEERING_HOSTILE_NOW" 1800

if FLOW_AGENTS_ACTOR="eval-actor-hostile-reader" node "$ROOT/scripts/hooks/workflow-steering.js" \
  >"$TMPDIR_EVAL/steering-hostile.out" 2>"$TMPDIR_EVAL/steering-hostile.err" <<STEERJSON
{"hook_event_name":"UserPromptSubmit","cwd":"$STEERING_REPO","prompt":"continue"}
STEERJSON
then
  pass "steering hook processes the hostile-holder fixture without failing (AC7 setup)"
else
  fail "steering hook should not fail for the hostile-holder fixture"
fi
if grep -qF $'\x1b[31;1m' "$TMPDIR_EVAL/steering-hostile.out" || grep -qF $'\x07' "$TMPDIR_EVAL/steering-hostile.out"; then
  fail "hostile holder actor's raw ANSI/control bytes leaked into the steering supersession notice (AC7)"
else
  pass "hostile holder actor's raw ANSI/control bytes never leak into the steering supersession notice (AC7)"
fi

# ─── 6b. holder.last_at injection via claimed_at/liveness `at` (F1 fix, fix-plan iteration 1) ──
# Section 6 above only injects hostile bytes into the ACTOR field -- it would pass even with
# the F1 bug present (runVerifyHold's held/reclaimable/human-held branches spread
# effective.holder and only sanitized actor/assignee, leaving last_at raw+uncapped). This
# section injects a hostile+oversized value into (a) the assignment record's claimed_at
# (forcing `reclaimable`, no fresh liveness event) and (b) a liveness event's `at` (forcing
# `held`), asserting the resulting `holder.last_at` in verify-hold's JSON is BOTH control-char-
# stripped AND length-capped (<=64, matching sanitize()'s stripControlCharsForDisplay(...).slice(0,64)).
echo "--- 6b. holder.last_at (claimed_at / liveness 'at') never leaks raw/oversized bytes (F1, AC7) ---"

HOSTILE_LAST_AT_RAW=$'2026-07-04T23:59:00Z-INJECTED-\x1b[31;1mFAKE\x07-'"$(printf 'Z%.0s' {1..300})"

# 6b-i. reclaimable: hostile claimed_at, NO liveness event at all (assignment present, no fresh
# heartbeat -> reclaimable per computeEffectiveState).
RECLAIM_INJECT_SLUG="verify-hold-hostile-claimed-at"
RECLAIM_INJECT_DIR="$ARTIFACT_ROOT/$RECLAIM_INJECT_SLUG"
write_assignment_record "$ARTIFACT_ROOT" "$RECLAIM_INJECT_SLUG" "hostile-claimed-at-session" "eval-actor-hostile-claimed-at-holder" "$HOSTILE_LAST_AT_RAW"
mkdir -p "$RECLAIM_INJECT_DIR"

if flow_agents_node "$WRITER" verify-hold "$RECLAIM_INJECT_DIR" --actor eval-actor-hostile-claimed-at-reader \
  >"$TMPDIR_EVAL/vh-hostile-claimed-at.out" 2>"$TMPDIR_EVAL/vh-hostile-claimed-at.err"; then
  fail "verify-hold against a hostile claimed_at fixture should have refused (reclaimable) (F1 setup)"
else
  pass "verify-hold against a hostile claimed_at fixture refuses (reclaimable, not-self) (F1 setup)"
fi
[[ "$(json_query "$TMPDIR_EVAL/vh-hostile-claimed-at.out" "effective_state")" == "reclaimable" ]] && pass "hostile claimed_at fixture classifies reclaimable, exercising the claimed_at->last_at path specifically (F1 setup)" || fail "hostile claimed_at fixture did not classify reclaimable: $(cat "$TMPDIR_EVAL/vh-hostile-claimed-at.out")"
RECLAIM_LAST_AT="$(json_query "$TMPDIR_EVAL/vh-hostile-claimed-at.out" "holder.last_at")"
if [[ "$RECLAIM_LAST_AT" == *$'\x1b'* || "$RECLAIM_LAST_AT" == *$'\x07'* ]]; then
  fail "holder.last_at (from claimed_at) leaked raw control/ANSI bytes into verify-hold's JSON (F1 HIGH regression): $RECLAIM_LAST_AT"
else
  pass "holder.last_at (from claimed_at) is control-char-stripped in verify-hold's JSON (F1)"
fi
RECLAIM_LAST_AT_LEN="${#RECLAIM_LAST_AT}"
if [[ "$RECLAIM_LAST_AT_LEN" -le 64 ]]; then
  pass "holder.last_at (from claimed_at) is length-capped at <=64 chars in verify-hold's JSON (F1) (len=$RECLAIM_LAST_AT_LEN)"
else
  fail "holder.last_at (from claimed_at) exceeded the 64-char cap in verify-hold's JSON (F1 HIGH regression): len=$RECLAIM_LAST_AT_LEN value=$RECLAIM_LAST_AT"
fi
if grep -qF $'\x1b[31;1m' "$TMPDIR_EVAL/vh-hostile-claimed-at.out" "$TMPDIR_EVAL/vh-hostile-claimed-at.err" || grep -qF $'\x07' "$TMPDIR_EVAL/vh-hostile-claimed-at.out" "$TMPDIR_EVAL/vh-hostile-claimed-at.err"; then
  fail "hostile claimed_at's raw ANSI/control bytes leaked ANYWHERE in verify-hold's output (stdout+stderr) (F1 HIGH regression)"
else
  pass "hostile claimed_at's raw ANSI/control bytes never leak anywhere in verify-hold's output (F1)"
fi

# 6b-ii. held: OVERSIZED (but Date.parse-valid) liveness event `at`, no assignment record at
# all (liveness-only -> `held`/`liveness_claim_present_assignment_lagging` per
# computeEffectiveState's no-assignment branch), exercising the SECOND last_at source (the
# liveness event, not claimed_at). Unlike 6b-i's claimed_at (copied through with NO freshness
# gate -- control chars and any length pass straight through to reclaimable), this `at` value
# MUST survive freshHolders()'s `Date.parse(g.lastAt)` freshness check to remain in the fresh
# set and reach the `held` branch at all -- embedding raw control/ANSI bytes here makes
# Date.parse return NaN, which drops the event as stale/absent (verified directly: the fixture
# then resolves free/not-held, never reaching this code path, so control bytes are not a
# reachable injection vector via THIS source). What IS reachable and still exercises the exact
# length-cap half of the AC7 sanitize() contract on this second last_at source: an
# oversized-but-parseable timestamp (300+ garbage digits crammed into the fractional-seconds
# field, which Date.parse tolerates and rounds into a valid instant) -- proving the cap applies
# regardless of which of the two last_at sources fed it.
#
# NOTE (#397 fix): this fixture has NO assignment record at all (liveness-only), so per the
# #397 fix runVerifyHold now PASSES it (reason liveness_claim_present_assignment_lagging is no
# longer a publish-block -- liveness alone is never a durable ownership conflict). The
# effective_state/holder shape is UNCHANGED by that fix (computeEffectiveState's own
# classification and holder payload are untouched; only the publish-decision mapping in
# runVerifyHold changed) -- so the AC7 sanitize()/length-cap assertions on holder.last_at below
# remain fully valid and are asserted unchanged, just against an `ok:true` result now instead of
# `ok:false`.
HELD_INJECT_SLUG="verify-hold-hostile-liveness-at"
HELD_INJECT_DIR="$ARTIFACT_ROOT/$HELD_INJECT_SLUG"
OVERSIZED_FRESH_AT="$(node -e 'const iso = new Date().toISOString(); process.stdout.write(iso.replace(/\.\d+Z$/, "." + "1".repeat(300) + "Z"));')"
append_liveness_event "$ARTIFACT_ROOT" "$HELD_INJECT_SLUG" "eval-actor-hostile-liveness-at-holder" "$OVERSIZED_FRESH_AT" 1800
mkdir -p "$HELD_INJECT_DIR"

if flow_agents_node "$WRITER" verify-hold "$HELD_INJECT_DIR" --actor eval-actor-hostile-liveness-at-reader \
  >"$TMPDIR_EVAL/vh-hostile-liveness-at.out" 2>"$TMPDIR_EVAL/vh-hostile-liveness-at.err"; then
  pass "verify-hold against an oversized-liveness-at, no-assignment-record fixture PASSES (liveness-only is never a publish block) (#397 fix)"
else
  fail "verify-hold against an oversized-liveness-at, no-assignment-record fixture should have PASSED (liveness-only, no durable assignment -- #397 regression): $(cat "$TMPDIR_EVAL/vh-hostile-liveness-at.out" "$TMPDIR_EVAL/vh-hostile-liveness-at.err")"
fi
[[ "$(json_query "$TMPDIR_EVAL/vh-hostile-liveness-at.out" "effective_state")" == "held" ]] && pass "oversized-liveness-at fixture classifies held, exercising the liveness-event->last_at path specifically (F1 setup)" || fail "oversized-liveness-at fixture did not classify held (Date.parse-valid timestamp should stay in the fresh set): $(cat "$TMPDIR_EVAL/vh-hostile-liveness-at.out")"
HELD_LAST_AT="$(json_query "$TMPDIR_EVAL/vh-hostile-liveness-at.out" "holder.last_at")"
if [[ "$HELD_LAST_AT" == *$'\x1b'* || "$HELD_LAST_AT" == *$'\x07'* ]]; then
  fail "holder.last_at (from liveness 'at') leaked raw control/ANSI bytes into verify-hold's JSON (F1 HIGH regression): $HELD_LAST_AT"
else
  pass "holder.last_at (from liveness 'at') has no raw control/ANSI bytes in verify-hold's JSON (F1, regression guard -- this source is Date.parse-gated so control bytes are unreachable here, see comment above)"
fi
HELD_LAST_AT_LEN="${#HELD_LAST_AT}"
if [[ "$HELD_LAST_AT_LEN" -le 64 ]]; then
  pass "holder.last_at (from liveness 'at') is length-capped at <=64 chars in verify-hold's JSON despite a 300+ char source value (F1) (len=$HELD_LAST_AT_LEN)"
else
  fail "holder.last_at (from liveness 'at') exceeded the 64-char cap in verify-hold's JSON (F1 HIGH regression): len=$HELD_LAST_AT_LEN value=$HELD_LAST_AT"
fi
if grep -qF $'\x1b[31;1m' "$TMPDIR_EVAL/vh-hostile-liveness-at.out" "$TMPDIR_EVAL/vh-hostile-liveness-at.err" || grep -qF $'\x07' "$TMPDIR_EVAL/vh-hostile-liveness-at.out" "$TMPDIR_EVAL/vh-hostile-liveness-at.err"; then
  fail "oversized liveness 'at' leaked raw control/ANSI bytes ANYWHERE in verify-hold's output (stdout+stderr) (F1 HIGH regression)"
else
  pass "oversized liveness 'at' never leaks raw control/ANSI bytes anywhere in verify-hold's output (F1, regression guard)"
fi

# ─── 7. Steering surfaces supersession on EVERY turn, not just SessionStart (AC5) ──────────
echo "--- 7. supersessionSteering fires on UserPromptSubmit AND SessionStart; absent with no other-actor holder (AC5) ---"

STEERING_SUP_REPO="$TMPDIR_EVAL/steering-supersede-repo"
SUP_SLUG="steering-superseded-demo"
SUP_NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
write_steering_fixture_repo "$STEERING_SUP_REPO" "$SUP_SLUG" "$SUP_NOW"
seed_current_pointer "$STEERING_SUP_REPO" "$SUP_SLUG" "eval-actor-steering-self-a"
append_liveness_event "$STEERING_SUP_REPO/.kontourai/flow-agents" "$SUP_SLUG" "eval-actor-steering-holder-b" "$SUP_NOW" 1800

# 7a. UserPromptSubmit on a SECOND, unrelated turn (not the takeover turn itself) — the
# every-turn requirement (AC5's core assertion, distinguishing this from SessionStart-only).
if FLOW_AGENTS_ACTOR="eval-actor-steering-self-a" node "$ROOT/scripts/hooks/workflow-steering.js" \
  >"$TMPDIR_EVAL/steering-sup-prompt.out" 2>"$TMPDIR_EVAL/steering-sup-prompt.err" <<STEERJSON
{"hook_event_name":"UserPromptSubmit","cwd":"$STEERING_SUP_REPO","prompt":"what is the status of this work?"}
STEERJSON
then
  pass "steering hook processes UserPromptSubmit for the superseded fixture without failing (AC5 setup)"
else
  fail "steering hook should not fail for UserPromptSubmit on the superseded fixture"
fi
grep -qF "[SUPERSEDED:" "$TMPDIR_EVAL/steering-sup-prompt.out" && pass "supersession notice appears at UserPromptSubmit (every-turn, not just SessionStart) (AC5)" || fail "supersession notice missing at UserPromptSubmit: $(cat "$TMPDIR_EVAL/steering-sup-prompt.out")"
grep -qF "eval-actor-steering-holder-b" "$TMPDIR_EVAL/steering-sup-prompt.out" && pass "UserPromptSubmit supersession notice names the current (other-actor) holder (AC5)" || fail "UserPromptSubmit supersession notice did not name the holder: $(cat "$TMPDIR_EVAL/steering-sup-prompt.out")"
grep -qiF "verify-hold" "$TMPDIR_EVAL/steering-sup-prompt.out" && pass "UserPromptSubmit supersession notice references the verify-hold gate (AC5)" || fail "UserPromptSubmit supersession notice did not reference verify-hold: $(cat "$TMPDIR_EVAL/steering-sup-prompt.out")"

# 7b. SessionStart — regression check: still present there too.
if FLOW_AGENTS_ACTOR="eval-actor-steering-self-a" node "$ROOT/scripts/hooks/workflow-steering.js" \
  >"$TMPDIR_EVAL/steering-sup-start.out" 2>"$TMPDIR_EVAL/steering-sup-start.err" <<STEERJSON
{"hook_event_name":"SessionStart","cwd":"$STEERING_SUP_REPO"}
STEERJSON
then
  pass "steering hook processes SessionStart for the superseded fixture without failing (AC5 setup)"
else
  fail "steering hook should not fail for SessionStart on the superseded fixture"
fi
grep -qF "[SUPERSEDED:" "$TMPDIR_EVAL/steering-sup-start.out" && pass "supersession notice still appears at SessionStart (regression check) (AC5)" || fail "supersession notice missing at SessionStart: $(cat "$TMPDIR_EVAL/steering-sup-start.out")"

# 7c. No other-actor fresh holder -> no notice at either event (no false positive).
NO_SUP_REPO="$TMPDIR_EVAL/steering-no-supersede-repo"
NO_SUP_SLUG="steering-not-superseded-demo"
NO_SUP_NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
write_steering_fixture_repo "$NO_SUP_REPO" "$NO_SUP_SLUG" "$NO_SUP_NOW"
# No liveness stream at all for this repo — no other-actor holder can exist.

if FLOW_AGENTS_ACTOR="eval-actor-steering-self-a" node "$ROOT/scripts/hooks/workflow-steering.js" \
  >"$TMPDIR_EVAL/steering-no-sup-prompt.out" 2>"$TMPDIR_EVAL/steering-no-sup-prompt.err" <<STEERJSON
{"hook_event_name":"UserPromptSubmit","cwd":"$NO_SUP_REPO","prompt":"what is the status of this work?"}
STEERJSON
then
  pass "steering hook processes UserPromptSubmit for the non-superseded fixture without failing (AC5 setup)"
else
  fail "steering hook should not fail for UserPromptSubmit on the non-superseded fixture"
fi
if grep -qF "[SUPERSEDED:" "$TMPDIR_EVAL/steering-no-sup-prompt.out"; then
  fail "supersession notice incorrectly appeared at UserPromptSubmit with no other-actor fresh holder (false positive) (AC5)"
else
  pass "no supersession notice at UserPromptSubmit when there is no other-actor fresh holder (AC5, no false positive)"
fi

if FLOW_AGENTS_ACTOR="eval-actor-steering-self-a" node "$ROOT/scripts/hooks/workflow-steering.js" \
  >"$TMPDIR_EVAL/steering-no-sup-start.out" 2>"$TMPDIR_EVAL/steering-no-sup-start.err" <<STEERJSON
{"hook_event_name":"SessionStart","cwd":"$NO_SUP_REPO"}
STEERJSON
then
  pass "steering hook processes SessionStart for the non-superseded fixture without failing (AC5 setup)"
else
  fail "steering hook should not fail for SessionStart on the non-superseded fixture"
fi
if grep -qF "[SUPERSEDED:" "$TMPDIR_EVAL/steering-no-sup-start.out"; then
  fail "supersession notice incorrectly appeared at SessionStart with no other-actor fresh holder (false positive) (AC5)"
else
  pass "no supersession notice at SessionStart when there is no other-actor fresh holder (AC5, no false positive)"
fi

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "test_verify_hold: all checks passed."
else
  echo "test_verify_hold: $errors check(s) failed."
fi
exit "$errors"
