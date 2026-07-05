#!/usr/bin/env bash
# test_takeover_protocol.sh — takeover protocol integration eval (issue #294, ADR 0021 §5).
#
# Exercises `runTakeoverPreflight()`/`takeover-preflight` CLI subcommand and its companion
# `ensure-session --supersede-stale` takeover-as-resumption path (src/cli/workflow-sidecar.ts),
# reusing the SAME assignment ⋈ liveness join #290/#291 already built (computeEffectiveState/
# readLocalAssignmentStatus/freshHolders) — no second computation is invented here.
#
# Follows evals/integration/test_verify_hold.sh's harness conventions VERBATIM (set -uo
# pipefail / ROOT / node.sh / WRITER / TMPDIR_EVAL / trap / ARTIFACT_ROOT / pass|fail|errors /
# json_query / flow_agents_node) and reuses its write_assignment_record / append_liveness_event
# fixture-writer helpers verbatim — no new plumbing invented where an existing helper already
# does the job.
#
# Sections (1-to-1 with the plan's acceptance criteria):
#   1. AC1 — takeover offered + continues the incumbent's branch (the headline): a STALE record
#      with a specific branch resolves `grace-then-supersede`/`reclaimable`; `--supersede-stale`
#      as a different successor prints SupersedeTakeover with resumed_branch == the incumbent's
#      branch (NOT a new branch) and records a `supersede` audit entry ("resuming from trust
#      bundle").
#   2. AC2a — revive during grace -> back off: a fresh incumbent liveness heartbeat flips the
#      same fixture to `back-off`/`held`/ok:false; a follow-on `--supersede-stale` REFUSES.
#   3. AC2b — a superseded incumbent is blocked at publish (compose with verify-hold, #293): the
#      woken zombie incumbent's verify-hold on the AC1 subject exits non-zero.
#   4. free / self / human quick cases: no record -> `claim`/free; self+fresh -> `proceed`.
#   5. Injection discipline: hostile control bytes + >64 chars in actor_key/branch never leak raw
#      into holder.actor / resume_branch, and are length-capped (<=64). Modeled on
#      test_verify_hold.sh's AC7 / section-6 injection check.
#
# Deterministic, no model spend, self-cleaning, no network, no `gh` process anywhere.
# Usage: bash evals/integration/test_takeover_protocol.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
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

# append_liveness_event <root> <subjectId> <actor> <at-iso> [ttlSeconds]
# Reused verbatim from test_verify_hold.sh's own helper.
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
# Reused verbatim from test_verify_hold.sh's own helper. Writes a minimal, well-formed,
# ALREADY-CLAIMED assignment record directly (branch:"main", claimed_at defaults to now). For a
# staleness fixture with NO liveness event, computeEffectiveState classifies it reclaimable.
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

# patch_record_branch <assignmentRecord.json> <branch> — read/modify/write the record's `branch`
# field so takeover-preflight/SupersedeTakeover surface a SPECIFIC resume branch (write_assignment_record
# always sets branch:"main"). This is the incumbent's branch the successor must CONTINUE (AC1).
patch_record_branch() {
  node -e '
const fs = require("fs");
const [file, branch] = process.argv.slice(1);
const rec = JSON.parse(fs.readFileSync(file, "utf8"));
rec.branch = branch;
fs.writeFileSync(file, JSON.stringify(rec, null, 2));
' "$1" "$2"
}

if [[ ! -f "$CLI" ]]; then
  echo "build/src/cli.js not found — run 'npm run build' first" >&2
  exit 1
fi
flow_agents_build_ts || { echo "build failed" >&2; exit 1; }

echo "=== takeover protocol (#294) ==="

# ─── 1. AC1 — takeover offered + continues the incumbent's branch (the headline) ───────────
echo "--- 1. AC1: stale claim -> grace-then-supersede; --supersede-stale continues the incumbent's branch (not a new one) ---"

AC1_SLUG="takeover-ac1-resume-branch"
AC1_DIR="$ARTIFACT_ROOT/$AC1_SLUG"
INCUMBENT_ACTOR="eval-actor-incumbent-a"
SUCCESSOR_ACTOR="eval-actor-successor"
AC1_BRANCH="agent/a/$AC1_SLUG"
AC1_RECORD="$ARTIFACT_ROOT/assignment/$AC1_SLUG.json"

# Seed a STALE reclaimable record: write_assignment_record (branch:"main", claimed_at=now) then
# patch its branch to the incumbent's real branch. NO liveness event -> no fresh heartbeat, so
# the join classifies it reclaimable (assignment_present_liveness_stale_or_absent).
write_assignment_record "$ARTIFACT_ROOT" "$AC1_SLUG" "incumbent-a-session" "$INCUMBENT_ACTOR"
patch_record_branch "$AC1_RECORD" "$AC1_BRANCH"
mkdir -p "$AC1_DIR"

if flow_agents_node "$WRITER" takeover-preflight "$AC1_DIR" --actor "$SUCCESSOR_ACTOR" \
  >"$TMPDIR_EVAL/tp-ac1.out" 2>"$TMPDIR_EVAL/tp-ac1.err"; then
  pass "takeover-preflight on a reclaimable subject exits 0 (ok:true — a takeover is offered) (AC1)"
else
  fail "takeover-preflight on a reclaimable subject should have exited 0: $(cat "$TMPDIR_EVAL/tp-ac1.out" "$TMPDIR_EVAL/tp-ac1.err")"
fi
[[ "$(json_query "$TMPDIR_EVAL/tp-ac1.out" "role")" == "TakeoverPreflight" ]] && pass "takeover-preflight JSON role is TakeoverPreflight (AC1)" || fail "takeover-preflight JSON role was not TakeoverPreflight: $(cat "$TMPDIR_EVAL/tp-ac1.out")"
[[ "$(json_query "$TMPDIR_EVAL/tp-ac1.out" "action")" == "grace-then-supersede" ]] && pass "takeover-preflight action is grace-then-supersede for a reclaimable subject (AC1)" || fail "takeover-preflight action was not grace-then-supersede: $(cat "$TMPDIR_EVAL/tp-ac1.out")"
[[ "$(json_query "$TMPDIR_EVAL/tp-ac1.out" "effective_state")" == "reclaimable" ]] && pass "takeover-preflight effective_state is reclaimable (AC1)" || fail "takeover-preflight effective_state was not reclaimable: $(cat "$TMPDIR_EVAL/tp-ac1.out")"
[[ "$(json_query "$TMPDIR_EVAL/tp-ac1.out" "resume_branch")" == "$AC1_BRANCH" ]] && pass "takeover-preflight resume_branch is the incumbent's branch ($AC1_BRANCH), never a new one (AC1 headline)" || fail "takeover-preflight resume_branch was not the incumbent's branch: $(cat "$TMPDIR_EVAL/tp-ac1.out")"
AC1_GRACE="$(json_query "$TMPDIR_EVAL/tp-ac1.out" "grace_seconds")"
if [[ "$AC1_GRACE" =~ ^[0-9]+$ && "$AC1_GRACE" -gt 0 ]]; then
  pass "takeover-preflight grace_seconds is a positive number ($AC1_GRACE) (AC1)"
else
  fail "takeover-preflight grace_seconds was not a positive number: '$AC1_GRACE'"
fi
[[ "$(json_query "$TMPDIR_EVAL/tp-ac1.out" "holder.actor")" == "$INCUMBENT_ACTOR" ]] && pass "takeover-preflight holder.actor names the incumbent ($INCUMBENT_ACTOR) (AC1)" || fail "takeover-preflight holder.actor did not name the incumbent: $(cat "$TMPDIR_EVAL/tp-ac1.out")"

# Now the successor takes over via ensure-session --supersede-stale — takeover-as-resumption:
# resumed_branch must be the incumbent's branch (NOT a fresh branch), and a `supersede` audit
# entry naming the incumbent + "resuming from trust bundle" must be recorded.
flow_agents_node "$WRITER" ensure-session \
  --flow-id builder.build \
  --task-slug "$AC1_SLUG" \
  --work-item "kontourai/flow-agents#294" \
  --title "Takeover AC1" \
  --artifact-root "$ARTIFACT_ROOT" \
  --supersede-stale \
  --actor "$SUCCESSOR_ACTOR" \
  >"$TMPDIR_EVAL/tp-ac1-supersede.out" 2>"$TMPDIR_EVAL/tp-ac1-supersede.err"
AC1_SUPERSEDE_EXIT=$?
[[ $AC1_SUPERSEDE_EXIT -eq 0 ]] && pass "ensure-session --supersede-stale as the successor exits 0 (AC1)" || fail "ensure-session --supersede-stale unexpectedly failed: $(cat "$TMPDIR_EVAL/tp-ac1-supersede.out" "$TMPDIR_EVAL/tp-ac1-supersede.err")"
# ensure-session's stdout carries the single-line SupersedeTakeover JSON AND a trailing
# `console.log(dir)` line — isolate the JSON object line (printJson emits it single-line) before
# json_query'ing it.
grep -F '"role": "SupersedeTakeover"' "$TMPDIR_EVAL/tp-ac1-supersede.out" > "$TMPDIR_EVAL/tp-ac1-supersede.json" || true
[[ "$(json_query "$TMPDIR_EVAL/tp-ac1-supersede.json" "role")" == "SupersedeTakeover" ]] && pass "supersede stdout JSON role is SupersedeTakeover (AC1)" || fail "supersede stdout JSON role was not SupersedeTakeover: $(cat "$TMPDIR_EVAL/tp-ac1-supersede.out")"
[[ "$(json_query "$TMPDIR_EVAL/tp-ac1-supersede.json" "resumed_branch")" == "$AC1_BRANCH" ]] && pass "supersede resumed_branch is the incumbent's branch ($AC1_BRANCH), NOT a new branch (AC1 headline)" || fail "supersede resumed_branch was not the incumbent's branch: $(cat "$TMPDIR_EVAL/tp-ac1-supersede.out")"
[[ "$(json_query "$TMPDIR_EVAL/tp-ac1-supersede.json" "superseded_actor")" == "$INCUMBENT_ACTOR" ]] && pass "supersede superseded_actor names the incumbent ($INCUMBENT_ACTOR) (AC1)" || fail "supersede superseded_actor did not name the incumbent: $(cat "$TMPDIR_EVAL/tp-ac1-supersede.out")"

# The record now carries a `supersede` audit_trail entry whose reason resumes from the trust
# bundle and names the superseded incumbent.
AC1_SUPERSEDE_REASON="$(node -e '
const fs = require("fs");
const rec = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const trail = Array.isArray(rec.audit_trail) ? rec.audit_trail : [];
const entry = trail.find((e) => e && e.transition === "supersede");
process.stdout.write(entry && typeof entry.reason === "string" ? entry.reason : "");
' "$AC1_RECORD")"
[[ -n "$AC1_SUPERSEDE_REASON" ]] && pass "the assignment record now contains a supersede audit_trail entry (AC1)" || fail "no supersede audit_trail entry found on the record: $(cat "$AC1_RECORD")"
[[ "$AC1_SUPERSEDE_REASON" == *"resuming from trust bundle"* ]] && pass "the supersede audit reason contains 'resuming from trust bundle' (AC1)" || fail "supersede audit reason did not contain 'resuming from trust bundle': '$AC1_SUPERSEDE_REASON'"
[[ "$AC1_SUPERSEDE_REASON" == *"$INCUMBENT_ACTOR"* ]] && pass "the supersede audit reason names the superseded incumbent ($INCUMBENT_ACTOR) (AC1)" || fail "supersede audit reason did not name the superseded incumbent: '$AC1_SUPERSEDE_REASON'"

# ─── 2. AC2a — revive during grace -> back off; --supersede-stale then REFUSES ─────────────
echo "--- 2. AC2a: a fresh incumbent liveness heartbeat flips reclaimable -> back-off/held; --supersede-stale then refuses ---"

AC2A_SLUG="takeover-ac2a-revive"
AC2A_DIR="$ARTIFACT_ROOT/$AC2A_SLUG"
AC2A_INCUMBENT="eval-actor-incumbent-revived"
write_assignment_record "$ARTIFACT_ROOT" "$AC2A_SLUG" "incumbent-revived-session" "$AC2A_INCUMBENT"
mkdir -p "$AC2A_DIR"

# A FRESH liveness heartbeat for the INCUMBENT — the incumbent revived during the grace window,
# so the join now classifies the subject held(holder=incumbent), not reclaimable.
append_liveness_event "$ARTIFACT_ROOT" "$AC2A_SLUG" "$AC2A_INCUMBENT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" 1800

if flow_agents_node "$WRITER" takeover-preflight "$AC2A_DIR" --actor "$SUCCESSOR_ACTOR" \
  >"$TMPDIR_EVAL/tp-ac2a.out" 2>"$TMPDIR_EVAL/tp-ac2a.err"; then
  fail "takeover-preflight against a revived incumbent should have exited non-zero (back off) (AC2a)"
else
  pass "takeover-preflight against a revived incumbent exits non-zero — do NOT supersede a live holder (AC2a)"
fi
[[ "$(json_query "$TMPDIR_EVAL/tp-ac2a.out" "ok")" == "false" ]] && pass "takeover-preflight reports ok:false for the revived incumbent (AC2a)" || fail "takeover-preflight did not report ok:false: $(cat "$TMPDIR_EVAL/tp-ac2a.out")"
[[ "$(json_query "$TMPDIR_EVAL/tp-ac2a.out" "action")" == "back-off" ]] && pass "takeover-preflight action is back-off for the revived incumbent (AC2a)" || fail "takeover-preflight action was not back-off: $(cat "$TMPDIR_EVAL/tp-ac2a.out")"
[[ "$(json_query "$TMPDIR_EVAL/tp-ac2a.out" "effective_state")" == "held" ]] && pass "takeover-preflight effective_state is held (incumbent revived) (AC2a)" || fail "takeover-preflight effective_state was not held: $(cat "$TMPDIR_EVAL/tp-ac2a.out")"

# The successor's --supersede-stale must now REFUSE (the state is held, not reclaimable) and never
# write a supersede audit entry.
flow_agents_node "$WRITER" ensure-session \
  --flow-id builder.build \
  --task-slug "$AC2A_SLUG" \
  --work-item "kontourai/flow-agents#294" \
  --title "Takeover AC2a" \
  --artifact-root "$ARTIFACT_ROOT" \
  --supersede-stale \
  --actor "$SUCCESSOR_ACTOR" \
  >"$TMPDIR_EVAL/tp-ac2a-supersede.out" 2>"$TMPDIR_EVAL/tp-ac2a-supersede.err"
AC2A_SUPERSEDE_EXIT=$?
[[ $AC2A_SUPERSEDE_EXIT -ne 0 ]] && pass "ensure-session --supersede-stale as the successor REFUSES (exits non-zero) because the incumbent revived (AC2a)" || fail "ensure-session --supersede-stale should have refused against a revived incumbent: $(cat "$TMPDIR_EVAL/tp-ac2a-supersede.out" "$TMPDIR_EVAL/tp-ac2a-supersede.err")"
AC2A_HAS_SUPERSEDE="$(node -e '
const fs = require("fs");
const rec = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const trail = Array.isArray(rec.audit_trail) ? rec.audit_trail : [];
process.stdout.write(trail.some((e) => e && e.transition === "supersede") ? "yes" : "no");
' "$ARTIFACT_ROOT/assignment/$AC2A_SLUG.json")"
[[ "$AC2A_HAS_SUPERSEDE" == "no" ]] && pass "no supersede audit entry was written for the refused takeover — the live incumbent's record is untouched (AC2a)" || fail "a supersede audit entry was written despite the refusal (AC2a)"

# ─── 3. AC2b — a superseded incumbent is blocked at publish (compose with verify-hold, #293) ─
echo "--- 3. AC2b: the woken zombie incumbent is blocked by verify-hold on the AC1 subject (takeover + #293 gate compose) ---"

# After AC1's takeover the AC1 record is held by the successor (successor's actor_key). The
# original incumbent, if it wakes, is no longer the holder — verify-hold (#293) must block it.
if flow_agents_node "$WRITER" verify-hold "$AC1_DIR" --actor "$INCUMBENT_ACTOR" \
  >"$TMPDIR_EVAL/tp-ac2b.out" 2>"$TMPDIR_EVAL/tp-ac2b.err"; then
  fail "verify-hold for the superseded (zombie) incumbent should have exited non-zero — it no longer holds the subject (AC2b)"
else
  pass "verify-hold blocks the woken zombie incumbent (exit non-zero) — takeover + the #293 gate compose (AC2b)"
fi
[[ "$(json_query "$TMPDIR_EVAL/tp-ac2b.out" "ok")" == "false" ]] && pass "verify-hold reports ok:false for the superseded incumbent (AC2b)" || fail "verify-hold did not report ok:false for the superseded incumbent: $(cat "$TMPDIR_EVAL/tp-ac2b.out")"

# ─── 4. free / self quick cases ────────────────────────────────────────────────────────────
echo "--- 4. free (no record) -> claim; self+fresh -> proceed ---"

# free: no assignment record at all for this fresh slug.
FREE_SLUG="takeover-free-subject"
FREE_DIR="$ARTIFACT_ROOT/$FREE_SLUG"
mkdir -p "$FREE_DIR"
if flow_agents_node "$WRITER" takeover-preflight "$FREE_DIR" --actor "$SUCCESSOR_ACTOR" \
  >"$TMPDIR_EVAL/tp-free.out" 2>"$TMPDIR_EVAL/tp-free.err"; then
  pass "takeover-preflight on a free subject (no record) exits 0 (AC free)"
else
  fail "takeover-preflight on a free subject unexpectedly refused: $(cat "$TMPDIR_EVAL/tp-free.out" "$TMPDIR_EVAL/tp-free.err")"
fi
[[ "$(json_query "$TMPDIR_EVAL/tp-free.out" "action")" == "claim" ]] && pass "takeover-preflight action is claim for a free subject (AC free)" || fail "takeover-preflight action was not claim: $(cat "$TMPDIR_EVAL/tp-free.out")"
[[ "$(json_query "$TMPDIR_EVAL/tp-free.out" "effective_state")" == "free" ]] && pass "takeover-preflight effective_state is free for a free subject (AC free)" || fail "takeover-preflight effective_state was not free: $(cat "$TMPDIR_EVAL/tp-free.out")"

# self_is_holder: a fresh record + fresh liveness for the SAME actor passed as --actor.
SELF_SLUG="takeover-self-holder"
SELF_DIR="$ARTIFACT_ROOT/$SELF_SLUG"
SELF_ACTOR="eval-actor-self-holder"
write_assignment_record "$ARTIFACT_ROOT" "$SELF_SLUG" "self-holder-session" "$SELF_ACTOR"
append_liveness_event "$ARTIFACT_ROOT" "$SELF_SLUG" "$SELF_ACTOR" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" 1800
mkdir -p "$SELF_DIR"
if flow_agents_node "$WRITER" takeover-preflight "$SELF_DIR" --actor "$SELF_ACTOR" \
  >"$TMPDIR_EVAL/tp-self.out" 2>"$TMPDIR_EVAL/tp-self.err"; then
  pass "takeover-preflight when the current actor IS the fresh holder exits 0 (AC self)"
else
  fail "takeover-preflight for the self holder unexpectedly refused: $(cat "$TMPDIR_EVAL/tp-self.out" "$TMPDIR_EVAL/tp-self.err")"
fi
[[ "$(json_query "$TMPDIR_EVAL/tp-self.out" "action")" == "proceed" ]] && pass "takeover-preflight action is proceed when self is the holder (AC self)" || fail "takeover-preflight action was not proceed: $(cat "$TMPDIR_EVAL/tp-self.out")"

# ─── 5. Injection discipline — hostile control bytes + >64 chars are stripped AND capped ─────
echo "--- 5. injection: hostile actor_key/branch never leak raw control/ANSI bytes; holder.actor & resume_branch are length-capped (<=64) ---"

HOSTILE_SLUG="takeover-hostile-injection"
HOSTILE_DIR="$ARTIFACT_ROOT/$HOSTILE_SLUG"
HOSTILE_RECORD="$ARTIFACT_ROOT/assignment/$HOSTILE_SLUG.json"
# actor_key and branch: embed raw ESC (\x1b) + BEL (\x07) control bytes AND >64 chars each.
HOSTILE_ACTOR=$'hostile-actor\x1b[31;1mFAKE\x07-admin-'"$(printf 'A%.0s' {1..300})"
HOSTILE_BRANCH=$'agent/hostile\x1b[31;1mFAKE\x07-branch-'"$(printf 'B%.0s' {1..300})"
write_assignment_record "$ARTIFACT_ROOT" "$HOSTILE_SLUG" "hostile-session" "$HOSTILE_ACTOR"
patch_record_branch "$HOSTILE_RECORD" "$HOSTILE_BRANCH"
mkdir -p "$HOSTILE_DIR"

# No liveness event -> reclaimable, so both holder.actor (from the record's actor_key) and
# resume_branch (from the record's branch) are populated and pass through sanitize().
flow_agents_node "$WRITER" takeover-preflight "$HOSTILE_DIR" --actor eval-actor-hostile-reader \
  >"$TMPDIR_EVAL/tp-hostile.out" 2>"$TMPDIR_EVAL/tp-hostile.err"

if grep -qF $'\x1b[31;1m' "$TMPDIR_EVAL/tp-hostile.out" "$TMPDIR_EVAL/tp-hostile.err" || grep -qF $'\x07' "$TMPDIR_EVAL/tp-hostile.out" "$TMPDIR_EVAL/tp-hostile.err"; then
  fail "hostile actor_key/branch's raw ANSI/control bytes leaked into takeover-preflight's output (stdout+stderr) (injection AC)"
else
  pass "hostile actor_key/branch's raw ANSI/control bytes never leak into takeover-preflight's output (injection AC)"
fi

HOSTILE_HOLDER_ACTOR="$(json_query "$TMPDIR_EVAL/tp-hostile.out" "holder.actor")"
if [[ "$HOSTILE_HOLDER_ACTOR" == *$'\x1b'* || "$HOSTILE_HOLDER_ACTOR" == *$'\x07'* ]]; then
  fail "holder.actor leaked raw control/ANSI bytes (injection AC): $HOSTILE_HOLDER_ACTOR"
else
  pass "holder.actor is control-char-stripped (injection AC)"
fi
HOSTILE_HOLDER_ACTOR_LEN="${#HOSTILE_HOLDER_ACTOR}"
[[ "$HOSTILE_HOLDER_ACTOR_LEN" -le 64 ]] && pass "holder.actor is length-capped at <=64 chars despite a 300+ char source (len=$HOSTILE_HOLDER_ACTOR_LEN) (injection AC)" || fail "holder.actor exceeded the 64-char cap (len=$HOSTILE_HOLDER_ACTOR_LEN): $HOSTILE_HOLDER_ACTOR"

HOSTILE_RESUME_BRANCH="$(json_query "$TMPDIR_EVAL/tp-hostile.out" "resume_branch")"
if [[ "$HOSTILE_RESUME_BRANCH" == *$'\x1b'* || "$HOSTILE_RESUME_BRANCH" == *$'\x07'* ]]; then
  fail "resume_branch leaked raw control/ANSI bytes (injection AC): $HOSTILE_RESUME_BRANCH"
else
  pass "resume_branch is control-char-stripped (injection AC)"
fi
HOSTILE_RESUME_BRANCH_LEN="${#HOSTILE_RESUME_BRANCH}"
# Branch uses the 240-char FREE-TEXT tier (not the 64-char id tier holder.actor uses): a realistic
# `agent/<actor>/<slug>` branch legitimately exceeds 64 chars, so capping the branch at 64 would
# truncate a VALID branch into a non-existent `git checkout` target (review finding #2). It is still
# capped (bounded at 240) and control-stripped (asserted above).
[[ "$HOSTILE_RESUME_BRANCH_LEN" -le 240 ]] && pass "resume_branch is length-capped at <=240 (free-text tier) despite a 300+ char source (len=$HOSTILE_RESUME_BRANCH_LEN) (injection AC)" || fail "resume_branch exceeded the 240-char free-text cap (len=$HOSTILE_RESUME_BRANCH_LEN): $HOSTILE_RESUME_BRANCH"

# ─── 6. A legitimate LONG branch (>64 chars, no control bytes) survives INTACT (review finding #2) ─
echo "--- 6. a realistic >64-char branch is NOT truncated (resume path would otherwise checkout a bad target) ---"
LONG_SLUG="takeover-long-branch"
LONG_DIR="$ARTIFACT_ROOT/$LONG_SLUG"
LONG_RECORD="$ARTIFACT_ROOT/assignment/$LONG_SLUG.json"
# 78 chars, well over 64, entirely valid git-branch charset — the exact case that would break AC1 if
# the branch were capped at 64.
LONG_BRANCH="agent/claude-code-sess-abcdef0123456789-hostname/flow-agents-294-takeover-xyz"
write_assignment_record "$ARTIFACT_ROOT" "$LONG_SLUG" "long-session" "long-actor-key"
patch_record_branch "$LONG_RECORD" "$LONG_BRANCH"
mkdir -p "$LONG_DIR"
flow_agents_node "$WRITER" takeover-preflight "$LONG_DIR" --actor eval-actor-long-reader \
  >"$TMPDIR_EVAL/tp-long.out" 2>"$TMPDIR_EVAL/tp-long.err"
LONG_RESUME_BRANCH="$(json_query "$TMPDIR_EVAL/tp-long.out" "resume_branch")"
[[ "$LONG_RESUME_BRANCH" == "$LONG_BRANCH" ]] && pass "a legitimate ${#LONG_BRANCH}-char branch survives INTACT in resume_branch (never truncated into a bad checkout target — AC1 / review finding #2)" || fail "a legitimate long branch was altered/truncated in resume_branch: got '$LONG_RESUME_BRANCH' expected '$LONG_BRANCH'"
# And through the real supersede (resumed_branch) path.
flow_agents_node "$WRITER" ensure-session --flow-id builder.build --task-slug "$LONG_SLUG" --work-item 294 --title t --artifact-root "$ARTIFACT_ROOT" --supersede-stale --actor eval-actor-long-reader \
  >"$TMPDIR_EVAL/tp-long-supersede.out" 2>"$TMPDIR_EVAL/tp-long-supersede.err"
grep -F '"role": "SupersedeTakeover"' "$TMPDIR_EVAL/tp-long-supersede.out" >"$TMPDIR_EVAL/tp-long-supersede.json"
[[ "$(json_query "$TMPDIR_EVAL/tp-long-supersede.json" "resumed_branch")" == "$LONG_BRANCH" ]] && pass "supersede resumed_branch preserves the full ${#LONG_BRANCH}-char incumbent branch (review finding #2)" || fail "supersede resumed_branch truncated the long branch: $(cat "$TMPDIR_EVAL/tp-long-supersede.json")"

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "test_takeover_protocol: all checks passed."
else
  echo "test_takeover_protocol: $errors check(s) failed."
fi
exit "$errors"
