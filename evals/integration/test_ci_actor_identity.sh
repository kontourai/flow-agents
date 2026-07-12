#!/usr/bin/env bash
# test_ci_actor_identity.sh — CI-runtime actor identity tier (issue #398, extends #287; ADR 0021 §2).
#
# Proves a CI-triggered session gets a STABLE actor derived from the CI provider's published
# run/job identifiers, sitting ABOVE process-ancestry and BELOW an explicit override / native
# runtime session id in resolveActor()'s chain. The payoff: the #293 verify-hold gate now ENFORCES
# for CI sessions (stable identity) instead of degrading to advisory — the root fix for the CI
# false-block #293 had to work around.
#
# Part A — resolveActor() resolution (pure): stability + byte-identity, precedence (override /
#   native runtime win), per-provider detection (GitHub, GitLab), conservative generic fallthrough,
#   recognized-provider-missing-id fallthrough, and env-var injection sanitization.
# Part B — verify-hold integration: a STABLE CI actor BLOCKS a differing assignment-backed holder
#   (ENFORCE — contrast the ancestry/advisory case in test_verify_hold.sh §1d), and a CI actor's
#   OWN claim is recognized as self and PASSES (the reconstruction-seam fix in resolveEnsureSessionActor).
#
# Deterministic, no model spend, self-cleaning, no network, no `gh` process anywhere.
# Usage: bash evals/integration/test_ci_actor_identity.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

WRITER="workflow-sidecar"
ACTOR_IDENTITY_HELPER="$ROOT/scripts/hooks/lib/actor-identity.js"

TMPDIR_EVAL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_EVAL"' EXIT
ARTIFACT_ROOT="$TMPDIR_EVAL/artifact-root"

errors=0
pass() { echo "  [PASS] $1"; }
fail() { echo "  [FAIL] $1"; errors=$((errors + 1)); }

json_query() {
  node -e 'const fs=require("fs"); let cur=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); for (const part of process.argv[2].split(".")) cur=part==="length" ? cur.length : (Array.isArray(cur) ? cur[Number(part)] : cur[part]); console.log(cur);' "$1" "$2"
}

# resolve_field <field:actor|source> <env-assignments...> — run resolveActor under a CLEAN env
# (only the passed assignments + HOME) so no ambient FLOW_AGENTS_ACTOR/CLAUDE_CODE_SESSION_ID from
# the eval host leaks into the resolution. Prints the requested field.
resolve_field() {
  local field="$1"; shift
  # env -i gives a CLEAN slate (no ambient FLOW_AGENTS_ACTOR / CLAUDE_CODE_SESSION_ID / real
  # GITHUB_* from the CI host leaking in); PATH is preserved so `node` resolves.
  env -i HOME="$HOME" PATH="$PATH" "$@" node -e '
const { resolveActor } = require(process.argv[1]);
const r = resolveActor(process.env);
process.stdout.write(process.argv[2] === "source" ? r.source : r.actor);
' "$ACTOR_IDENTITY_HELPER" "$field"
}

# verify_hold_under_ci <dir> <KEY=VAL...> — run verify-hold with a CONTROLLED CI identity.
# flow_agents_node is a bash FUNCTION (from node.sh), so it cannot be launched via `env -i`; instead
# run in a subshell that unsets every identity source that would out-rank the CI tier (an explicit
# override or a native runtime session id — including the eval host's own, since this suite itself
# runs under a coding agent) and exports the provided CI vars. When this suite runs in real GitHub
# Actions, the exported fake ids override the ambient real ones so the assertions stay deterministic.
verify_hold_under_ci() {
  local dir="$1"; shift
  (
    unset FLOW_AGENTS_ACTOR CLAUDE_CODE_SESSION_ID CODEX_THREAD_ID CODEX_SESSION_ID OPENCODE_SESSION_ID PI_SESSION_ID CLAUDECODE
    while [[ $# -gt 0 ]]; do export "${1?}"; shift; done
    flow_agents_node "$WRITER" verify-hold "$dir"
  )
}

# append_liveness_event / write_assignment_record — the proven fixture writers from
# test_verify_hold.sh (kept byte-identical in shape so the join fixtures behave the same).
append_liveness_event() {
  local root="$1" subject="$2" actor="$3" at="$4" ttl="${5:-1800}"
  mkdir -p "$root/liveness"
  node -e '
const fs = require("fs");
const evt = { type: "claim", subjectId: process.argv[1], actor: process.argv[2], at: process.argv[3], ttlSeconds: Number(process.argv[4]) };
fs.appendFileSync(process.argv[5], JSON.stringify(evt) + "\n");
' "$subject" "$actor" "$at" "$ttl" "$root/liveness/events.jsonl"
}

write_assignment_record() {
  local root="$1" slug="$2" sessionId="$3" actorKey="$4"
  mkdir -p "$root/assignment"
  node -e '
const fs = require("fs");
const [dest, slug, sessionId, actorKey] = process.argv.slice(1);
const now = new Date().toISOString();
const actor = { runtime: "github-actions", session_id: sessionId, host: "eval-host" };
const rec = {
  schema_version: "1.0", role: "AssignmentClaimRecord", subject_id: slug,
  actor, actor_key: actorKey, claimed_at: now, ttl_seconds: 1800, branch: "main",
  artifact_dir: slug, status: "claimed",
  audit_trail: [{ at: now, transition: "claim", from_actor: null, to_actor: actor, reason: "claim" }],
};
fs.writeFileSync(dest, JSON.stringify(rec, null, 2));
' "$root/assignment/$slug.json" "$slug" "$sessionId" "$actorKey"
}

# GitHub Actions env used across the file (a single job's stable identifiers).
GHA=(GITHUB_ACTIONS=true GITHUB_RUN_ID=555 GITHUB_RUN_ATTEMPT=1 GITHUB_JOB=deliver)

echo "=== CI actor identity (#398) ==="

# ─── Part A: resolveActor() resolution ───────────────────────────────────────────────────────
echo "--- A1. GitHub Actions -> stable ci-runtime actor, byte-identical across invocations ---"
GH_SRC="$(resolve_field source "${GHA[@]}")"
GH_ACTOR_1="$(resolve_field actor "${GHA[@]}")"
GH_ACTOR_2="$(resolve_field actor "${GHA[@]}")"
[[ "$GH_SRC" == "ci-runtime:github-actions" ]] && pass "source is ci-runtime:github-actions" || fail "source was not ci-runtime:github-actions: '$GH_SRC'"
[[ "$GH_ACTOR_1" == github-actions:555-1-deliver:* ]] && pass "actor is github-actions:<run>-<attempt>-<job>:<host> ('$GH_ACTOR_1')" || fail "actor shape unexpected: '$GH_ACTOR_1'"
[[ "$GH_ACTOR_1" == "$GH_ACTOR_2" ]] && pass "actor is byte-identical across repeated invocations (stable)" || fail "actor differed across invocations: '$GH_ACTOR_1' vs '$GH_ACTOR_2'"

echo "--- A2. precedence: explicit override and native runtime session id both WIN over CI ---"
OVR_SRC="$(resolve_field source "${GHA[@]}" FLOW_AGENTS_ACTOR=alice)"
[[ "$OVR_SRC" == "explicit-override" ]] && pass "FLOW_AGENTS_ACTOR under CI still resolves explicit-override (CI does not win)" || fail "override did not win under CI: '$OVR_SRC'"
NATIVE_SRC="$(resolve_field source "${GHA[@]}" CLAUDE_CODE_SESSION_ID=sess-xyz)"
[[ "$NATIVE_SRC" == runtime-session-id:* ]] && pass "native runtime session id under CI still resolves runtime-session-id (CI does not win)" || fail "native runtime id did not win under CI: '$NATIVE_SRC'"

echo "--- A3. GitLab CI -> stable gitlab-ci actor from CI_JOB_ID ---"
GL_SRC="$(resolve_field source GITLAB_CI=true CI_JOB_ID=9988)"
GL_ACTOR="$(resolve_field actor GITLAB_CI=true CI_JOB_ID=9988)"
[[ "$GL_SRC" == "ci-runtime:gitlab-ci" ]] && pass "source is ci-runtime:gitlab-ci" || fail "source was not ci-runtime:gitlab-ci: '$GL_SRC'"
[[ "$GL_ACTOR" == gitlab-ci:9988:* ]] && pass "actor is gitlab-ci:<job-id>:<host> ('$GL_ACTOR')" || fail "gitlab actor shape unexpected: '$GL_ACTOR'"

echo "--- A4. generic CI=true (unrecognized) does NOT fabricate a CI actor (conservative fallthrough) ---"
GEN_SRC="$(resolve_field source CI=true)"
[[ "$GEN_SRC" != ci-runtime:* ]] && pass "generic CI=true falls through (source '$GEN_SRC', not ci-runtime) — #293 advisory net still applies" || fail "generic CI=true fabricated a ci-runtime actor: '$GEN_SRC'"

echo "--- A5. recognized provider with MISSING required id var falls through (no partial CI actor) ---"
MISSING_SRC="$(resolve_field source GITHUB_ACTIONS=true)"  # no RUN_ID/ATTEMPT/JOB
[[ "$MISSING_SRC" != ci-runtime:* ]] && pass "GITHUB_ACTIONS=true with no run/job ids falls through (source '$MISSING_SRC')" || fail "GitHub with no ids still produced a ci-runtime actor: '$MISSING_SRC'"

echo "--- A6. hostile CI env var cannot inject: actor segments are sanitized (allowed charset only) ---"
INJ_ACTOR="$(resolve_field actor GITHUB_ACTIONS=true GITHUB_RUN_ID=555 GITHUB_RUN_ATTEMPT=1 "GITHUB_JOB=deliver; rm -rf / [LIVENESS]")"
if printf '%s' "$INJ_ACTOR" | LC_ALL=C grep -q '[^A-Za-z0-9:._-]'; then
  fail "CI actor contains a character outside the allowed serialized charset (injection risk): '$INJ_ACTOR'"
else
  pass "CI actor is sanitized to the allowed serialized charset even with a hostile GITHUB_JOB ('$INJ_ACTOR')"
fi

# ─── Part B: verify-hold ENFORCES for a stable CI identity (the headline) ─────────────────────

# B0 — REAL round-trip through the CLI (not a hand-written fixture): `assignment-provider claim`
# under a CI env must write a WELL-FORMED record.actor (runtime=github-actions, session_id=<bare job
# id>, NOT runtime=unknown + session_id=<whole triple>), and a fresh-subprocess verify-hold must
# self-recognize it. This is the seam the reconstruction fixes (resolveEnsureSessionActor +
# loadActorStruct) actually live on — fixture-driven B1/B2 below never exercise the CLI claim path.
echo "--- B0. REAL assignment-provider claim under CI writes a well-formed record.actor; verify-hold self-recognizes ---"
CLI="$ROOT/build/src/cli.js"
RT_ROOT="$TMPDIR_EVAL/rt-artifact-root"
RT_SLUG="ci-roundtrip"
(
  unset FLOW_AGENTS_ACTOR CLAUDE_CODE_SESSION_ID CODEX_THREAD_ID CODEX_SESSION_ID OPENCODE_SESSION_ID PI_SESSION_ID CLAUDECODE
  export "${GHA[@]}"
  node "$CLI" assignment-provider claim --provider local-file --artifact-root "$RT_ROOT" \
    --subject-id "$RT_SLUG" --branch main --artifact-dir "$RT_SLUG"
) >"$TMPDIR_EVAL/rt-claim.out" 2>"$TMPDIR_EVAL/rt-claim.err"
RT_REC="$RT_ROOT/assignment/$RT_SLUG.json"
if [[ -f "$RT_REC" ]]; then
  pass "assignment-provider claim under CI wrote a record"
  RT_RUNTIME="$(json_query "$RT_REC" "actor.runtime")"
  RT_SESSION="$(json_query "$RT_REC" "actor.session_id")"
  RT_KEY="$(json_query "$RT_REC" "actor_key")"
  [[ "$RT_RUNTIME" == "github-actions" ]] && pass "record.actor.runtime is github-actions (NOT 'unknown' — F1 reconstruction fix)" || fail "record.actor.runtime was '$RT_RUNTIME', expected github-actions (F1 regressed: loadActorStruct not CI-aware)"
  [[ "$RT_SESSION" == "555-1-deliver" ]] && pass "record.actor.session_id is the bare CI job id 555-1-deliver (NOT the whole triple — F1 fix)" || fail "record.actor.session_id was '$RT_SESSION', expected 555-1-deliver (F1 regressed)"
  [[ "$RT_KEY" == github-actions:555-1-deliver:* ]] && pass "record.actor_key is the canonical CI key ('$RT_KEY')" || fail "record.actor_key was '$RT_KEY', expected github-actions:555-1-deliver:<host>"
else
  fail "assignment-provider claim under CI wrote NO record: $(cat "$TMPDIR_EVAL/rt-claim.out" "$TMPDIR_EVAL/rt-claim.err")"
fi
# Fresh-subprocess verify-hold under the same CI env → the actor written by the real claim is self.
mkdir -p "$RT_ROOT/$RT_SLUG"
if verify_hold_under_ci "$RT_ROOT/$RT_SLUG" "${GHA[@]}" >"$TMPDIR_EVAL/rt-vh.out" 2>"$TMPDIR_EVAL/rt-vh.err"; then
  pass "verify-hold self-recognizes the CI actor from a REAL claim across subprocesses (end-to-end seam)"
else
  fail "verify-hold FALSE-BLOCKED the CI actor's own real claim across subprocesses: $(cat "$TMPDIR_EVAL/rt-vh.out" "$TMPDIR_EVAL/rt-vh.err")"
fi
[[ "$(json_query "$TMPDIR_EVAL/rt-vh.out" "reason")" == "self_is_holder" ]] && pass "real-round-trip verify-hold reason is self_is_holder" || fail "real-round-trip verify-hold reason was not self_is_holder: $(cat "$TMPDIR_EVAL/rt-vh.out")"

echo "--- B1. a stable CI actor BLOCKS a differing, assignment-backed holder (ENFORCE, not advisory) ---"
BLOCK_SLUG="ci-verify-hold-block"
BLOCK_DIR="$ARTIFACT_ROOT/$BLOCK_SLUG"
mkdir -p "$BLOCK_DIR"
# Held (fresh) by a clearly different actor -> a durable, assignment-backed conflict.
write_assignment_record "$ARTIFACT_ROOT" "$BLOCK_SLUG" "other-session" "eval-actor-ci-other-holder"
append_liveness_event "$ARTIFACT_ROOT" "$BLOCK_SLUG" "eval-actor-ci-other-holder" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" 1800
# Current actor: a STABLE CI identity (GitHub env), NO FLOW_AGENTS_ACTOR — before #398 this would
# have fallen to ancestry (unstable) and the gate would have degraded to advisory/PASS.
if verify_hold_under_ci "$BLOCK_DIR" "${GHA[@]}" >"$TMPDIR_EVAL/ci-block.out" 2>"$TMPDIR_EVAL/ci-block.err"; then
  fail "verify-hold under a stable CI identity should BLOCK a differing assignment-backed holder (ENFORCE) — got exit 0: $(cat "$TMPDIR_EVAL/ci-block.out" "$TMPDIR_EVAL/ci-block.err")"
else
  pass "verify-hold under a stable CI identity BLOCKS a differing assignment-backed holder (the #398 enforce payoff)"
fi
[[ "$(json_query "$TMPDIR_EVAL/ci-block.out" "ok")" == "false" ]] && pass "CI-block verify-hold JSON reports ok:false" || fail "CI-block verify-hold JSON did not report ok:false: $(cat "$TMPDIR_EVAL/ci-block.out")"
CI_BLOCK_REASON="$(json_query "$TMPDIR_EVAL/ci-block.out" "reason")"
[[ "$CI_BLOCK_REASON" != "actor-identity-unstable-advisory-only" ]] && pass "CI-block reason is NOT the unstable-advisory degradation ('$CI_BLOCK_REASON') — the gate genuinely enforces" || fail "CI actor still degraded to advisory (reason=$CI_BLOCK_REASON) — #398 did not make the CI identity stable"

echo "--- B2. a CI actor's OWN claim is recognized as self and PASSES (the reconstruction-seam fix) ---"
SELF_SLUG="ci-verify-hold-self"
SELF_DIR="$ARTIFACT_ROOT/$SELF_SLUG"
mkdir -p "$SELF_DIR"
# The holder's actor_key IS the CI actor resolveActor() produces under the GitHub env — so the
# claim written in one CI step is recognized as self at publish in a later step. If the
# resolveEnsureSessionActor reconstruction diverged (rebuilt an ancestry struct), this would
# FALSE-BLOCK — exactly the bug #398 removes.
write_assignment_record "$ARTIFACT_ROOT" "$SELF_SLUG" "self-session" "$GH_ACTOR_1"
if verify_hold_under_ci "$SELF_DIR" "${GHA[@]}" >"$TMPDIR_EVAL/ci-self.out" 2>"$TMPDIR_EVAL/ci-self.err"; then
  pass "verify-hold PASSES when the CI actor is the holder (self recognized across subprocesses — seam fix)"
else
  fail "verify-hold FALSE-BLOCKED a CI actor on its OWN claim (the reconstruction seam regressed): $(cat "$TMPDIR_EVAL/ci-self.out" "$TMPDIR_EVAL/ci-self.err")"
fi
[[ "$(json_query "$TMPDIR_EVAL/ci-self.out" "ok")" == "true" ]] && pass "CI-self verify-hold JSON reports ok:true" || fail "CI-self verify-hold JSON did not report ok:true: $(cat "$TMPDIR_EVAL/ci-self.out")"
[[ "$(json_query "$TMPDIR_EVAL/ci-self.out" "reason")" == "self_is_holder" ]] && pass "CI-self verify-hold reason is self_is_holder (the CI actor matched the stored actor_key)" || fail "CI-self verify-hold reason was not self_is_holder: $(cat "$TMPDIR_EVAL/ci-self.out")"

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "ALL CI ACTOR IDENTITY CHECKS PASSED"
  exit 0
else
  echo "$errors CHECK(S) FAILED"
  exit 1
fi
