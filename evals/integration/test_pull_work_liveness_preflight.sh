#!/usr/bin/env bash
# test_pull_work_liveness_preflight.sh — integration eval for the pull-work liveness
# selection preflight (issue #166, extended by ADR 0021 §1/§3; plan artifact at
# .kontourai/flow-agents/kontourai-flow-agents-166/kontourai-flow-agents-166--plan-work.md,
# Wave 2). Deterministic, no model spend, self-cleaning (mktemp -d + trap EXIT).
#
# Covers, per the plan's Wave 2 eval tasks (writer-shape unit checks + two-actor CLI-level
# exclusion simulation + static skill-text assertions, folded into one file):
#   A. `liveness whoami` / `resolve-slug` CLI unit shapes (AC7):
#      derived-actor fallback (ancestry/env chain), explicit --actor override, forced-unresolved
#      non-throwing shape (contrasted with `liveness claim`'s still-fail-loud behavior), and
#      resolve-slug's deterministic slug format + malformed-ref rejection (proving no duplicate
#      validation logic exists outside workItemSlug()).
#   B. resolve-slug parity with the workItemSlug()-derived `ensure-session --work-item` session
#      directory (AC4).
#   C. The deterministic two-actor CLI-level classification simulation (AC1, AC2, AC3, AC5):
#      held (other-actor verified) / mine (self-actor verified) / reclaimable (stale, raw status
#      not label) / free (no rows) / claim-emit-on-selection / force-write unconstrained at the
#      CLI layer (Design Decision 4 — no holder-conflict check to override).
#   D. Static skill-text require_text/reject_text assertions against the plan's prescribed
#      sentences in kits/builder/skills/pull-work/SKILL.md and
#      kits/builder/skills/pickup-probe/SKILL.md (AC6, AC8), including that the existing
#      no-provider-mutation sentence is present and unchanged.
#
# Usage: bash evals/integration/test_pull_work_liveness_preflight.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

WRITER="workflow-sidecar"
SIDECAR_SRC="$ROOT/src/cli/workflow-sidecar.ts"
PULL="$ROOT/kits/builder/skills/pull-work/SKILL.md"
PICKUP_PROBE="$ROOT/kits/builder/skills/pickup-probe/SKILL.md"

for m in "$SIDECAR_SRC" "$PULL" "$PICKUP_PROBE"; do
  if [[ ! -f "$m" ]]; then
    echo "pull-work liveness preflight eval skipped: $m does not exist yet." >&2
    exit 1
  fi
done

TMPDIR_EVAL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_EVAL"' EXIT

errors=0
_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

require_text() {
  local path="$1" pattern="$2" label="$3"
  if rg -q -- "$pattern" "$path"; then _pass "$label"; else _fail "$label"; fi
}

reject_text() {
  local path="$1" pattern="$2" label="$3"
  if rg -q -- "$pattern" "$path"; then _fail "$label"; else _pass "$label"; fi
}

# new_scratch — fresh scratch artifact-root under the eval's own tmpdir.
new_scratch() {
  mktemp -d "$TMPDIR_EVAL/scratch-XXXXXX"
}

echo "=== Pull work liveness preflight (#166) ==="

# ─── A. `liveness whoami` / `resolve-slug` CLI unit shapes (AC7) ────────────
echo "--- A. whoami / resolve-slug unit shapes ---"

A_ROOT="$(new_scratch)/.kontourai/flow-agents"

# A1: derived-actor fallback — no explicit --actor/--json flag beyond a CLAUDE_CODE_SESSION_ID
# env override (mirrors the two-holders env-injection pattern from
# evals/integration/test_workflow_sidecar_writer.sh) — returns a JSON object with non-empty
# actor/source fields, exit 0.
A1_OUT="$(CLAUDE_CODE_SESSION_ID=sess-a flow_agents_node "$WRITER" liveness whoami --json --artifact-root "$A_ROOT" 2>"$TMPDIR_EVAL/a1.err")"
A1_STATUS=$?
if [[ "$A1_STATUS" -eq 0 ]] && node -e '
const o = JSON.parse(process.argv[1]);
if (typeof o.actor !== "string" || !o.actor) throw new Error("actor missing/empty");
if (typeof o.source !== "string" || !o.source) throw new Error("source missing/empty");
' "$A1_OUT" 2>"$TMPDIR_EVAL/a1-check.err"; then
  _pass "liveness whoami --json (derived-actor fallback) exits 0 with non-empty actor/source (AC7)"
else
  _fail "liveness whoami derived-actor fallback did not return the expected shape: out=$A1_OUT status=$A1_STATUS err=$(cat "$TMPDIR_EVAL/a1.err" "$TMPDIR_EVAL/a1-check.err" 2>/dev/null)"
fi

# A2: explicit --actor override, after sanitizeSegment.
A2_OUT="$(flow_agents_node "$WRITER" liveness whoami --actor custom-name --json --artifact-root "$A_ROOT" 2>"$TMPDIR_EVAL/a2.err")"
if [[ "$A2_OUT" == '{"actor":"custom-name","source":"explicit-override"}' ]]; then
  _pass "liveness whoami --actor custom-name --json returns {actor, source: explicit-override} (AC7)"
else
  _fail "liveness whoami --actor override mismatch: out=$A2_OUT err=$(cat "$TMPDIR_EVAL/a2.err")"
fi

# A3: forced-unresolved actor — whoami never dies / never exits nonzero (read-only, advisory,
# non-enforcing contract), even though the actor could not be resolved.
if A3_OUT="$(FLOW_AGENTS_ACTOR_TEST_FORCE_UNRESOLVED=1 NODE_ENV=test flow_agents_node "$WRITER" liveness whoami --json --artifact-root "$A_ROOT" 2>"$TMPDIR_EVAL/a3.err")" \
  && [[ "$A3_OUT" == '{"actor":"","source":"test-forced-unresolved"}' ]]; then
  _pass "liveness whoami never dies under a forced-unresolved actor — prints {actor:\"\", source:\"test-forced-unresolved\"} and exits 0 (AC7, read-only contract)"
else
  _fail "liveness whoami under forced-unresolved actor did not behave as expected: out=$A3_OUT err=$(cat "$TMPDIR_EVAL/a3.err")"
fi

# A4: contrast — `liveness claim` under the SAME forced-unresolved env still fails loud (dies),
# proving the enforcement point stays at the write path, not whoami.
if FLOW_AGENTS_ACTOR_TEST_FORCE_UNRESOLVED=1 NODE_ENV=test flow_agents_node "$WRITER" liveness claim forced-unresolved-preflight-subj --artifact-root "$A_ROOT" >"$TMPDIR_EVAL/a4.out" 2>"$TMPDIR_EVAL/a4.err"; then
  _fail "liveness claim under a forced-unresolved actor should have exited nonzero (contrast with whoami)"
elif rg -q -- '--actor' "$TMPDIR_EVAL/a4.err" && rg -q -- 'FLOW_AGENTS_ACTOR' "$TMPDIR_EVAL/a4.err"; then
  _pass "liveness claim still fails loud (nonzero exit, remediation naming --actor/FLOW_AGENTS_ACTOR) under the same forced-unresolved env whoami tolerates (AC7 contrast)"
else
  _fail "liveness claim forced-unresolved rejection lacked expected remediation: $(cat "$TMPDIR_EVAL/a4.out" "$TMPDIR_EVAL/a4.err")"
fi

# A5: resolve-slug deterministic slug format.
A5_OUT="$(flow_agents_node "$WRITER" resolve-slug 'kontourai/flow-agents#166' 2>"$TMPDIR_EVAL/a5.err")"
A5_STATUS=$?
if [[ "$A5_STATUS" -eq 0 ]] && [[ "$A5_OUT" == "kontourai-flow-agents-166" ]]; then
  _pass "resolve-slug kontourai/flow-agents#166 prints kontourai-flow-agents-166 and exits 0 (AC4, AC7)"
else
  _fail "resolve-slug deterministic format mismatch: out=$A5_OUT status=$A5_STATUS err=$(cat "$TMPDIR_EVAL/a5.err")"
fi

# A6: malformed ref (no #id) is rejected with workItemSlug()'s existing message — proves no
# duplicate validation logic was introduced for resolve-slug.
if flow_agents_node "$WRITER" resolve-slug 'owner/repo' >"$TMPDIR_EVAL/a6.out" 2>"$TMPDIR_EVAL/a6.err"; then
  _fail "resolve-slug should reject a ref with no # separator"
elif rg -q -- 'provider-neutral provider:id ref or owner/repo#numeric-id' "$TMPDIR_EVAL/a6.err"; then
  _pass "resolve-slug rejects a ref with no # separator using workItemSlug()'s existing message (AC7)"
else
  _fail "resolve-slug malformed-ref rejection message mismatch: $(cat "$TMPDIR_EVAL/a6.out" "$TMPDIR_EVAL/a6.err")"
fi

# A7: non-numeric id is rejected with workItemSlug()'s existing message.
if flow_agents_node "$WRITER" resolve-slug 'owner/repo#abc' >"$TMPDIR_EVAL/a7.out" 2>"$TMPDIR_EVAL/a7.err"; then
  _fail "resolve-slug should reject a non-numeric issue id"
elif rg -q -- 'numeric issue number' "$TMPDIR_EVAL/a7.err"; then
  _pass "resolve-slug rejects a non-numeric issue id using workItemSlug()'s existing message (AC7)"
else
  _fail "resolve-slug non-numeric-id rejection message mismatch: $(cat "$TMPDIR_EVAL/a7.out" "$TMPDIR_EVAL/a7.err")"
fi

# ─── B. resolve-slug parity with ensure-session --work-item session dir (AC4) ───
echo "--- B. resolve-slug parity with ensure-session --work-item ---"

B_ROOT="$(new_scratch)/.kontourai/flow-agents"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$B_ROOT" \
  --work-item 'owner/repo#42' \
  --title "Parity Check" \
  --summary "resolve-slug parity fixture." \
  --timestamp "2026-07-01T00:00:00Z" >"$TMPDIR_EVAL/b-ensure.out" 2>"$TMPDIR_EVAL/b-ensure.err"; then
  # #291: ensure-session (when an ambient actor resolves, even without an explicit --actor)
  # now also creates artifact-root-level "assignment/" (the ownership-guard's durable local-file
  # claim record dir) and "current/" (the per-actor current.json projection dir) sibling
  # directories, alongside the pre-existing "liveness/" dir -- all three must be excluded here so
  # this find still lands on the real session slug directory, not a sibling artifact dir.
  B_SESSION_DIR="$(find "$B_ROOT" -mindepth 1 -maxdepth 1 -type d ! -name liveness ! -name assignment ! -name current | head -n1)"
  B_SLUG_FROM_DIR="$(basename "$B_SESSION_DIR")"
  B_SLUG_FROM_RESOLVE="$(flow_agents_node "$WRITER" resolve-slug 'owner/repo#42' 2>"$TMPDIR_EVAL/b-resolve.err")"
  if [[ -n "$B_SESSION_DIR" ]] && [[ "$B_SLUG_FROM_DIR" == "$B_SLUG_FROM_RESOLVE" ]]; then
    _pass "resolve-slug owner/repo#42 ($B_SLUG_FROM_RESOLVE) matches the ensure-session --work-item session directory name ($B_SLUG_FROM_DIR) (AC4)"
  else
    _fail "resolve-slug/ensure-session session-dir parity mismatch: dir=$B_SLUG_FROM_DIR resolve-slug=$B_SLUG_FROM_RESOLVE err=$(cat "$TMPDIR_EVAL/b-resolve.err")"
  fi
else
  _fail "ensure-session --work-item owner/repo#42 fixture setup failed: $(cat "$TMPDIR_EVAL/b-ensure.out" "$TMPDIR_EVAL/b-ensure.err")"
fi

# ─── C. Two-actor CLI-level classification simulation (AC1, AC2, AC3, AC5) ──
echo "--- C. Two-actor classification simulation ---"

C_ROOT="$(new_scratch)/.kontourai/flow-agents"

# status_row_json <root> <subjectId> <now_iso> — prints the raw `liveness status --json --subject`
# array for the given subject (the preflight's exact read shape: full row set, one call).
status_row_json() {
  local root="$1" subject="$2" now="$3"
  flow_agents_node "$WRITER" liveness status --json --subject "$subject" --now "$now" --artifact-root "$root"
}

# C1/C2: Held-exclusion + own-actor mine — actor agent-a claims subject subj-held.
flow_agents_node "$WRITER" liveness claim subj-held --actor agent-a --at "2026-07-01T12:00:00Z" --ttl 1800 --artifact-root "$C_ROOT" >/dev/null 2>"$TMPDIR_EVAL/c-claim-a.err"
C1_STATUS="$(status_row_json "$C_ROOT" subj-held "2026-07-01T12:10:00Z")"
C1_ROW_ACTOR="$(printf '%s' "$C1_STATUS" | node -e 'const rows=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(rows[0] ? rows[0].actor : "");')"
C1_ROW_STATUS="$(printf '%s' "$C1_STATUS" | node -e 'const rows=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(rows[0] ? rows[0].status : "");')"
C1_WHOAMI_B="$(flow_agents_node "$WRITER" liveness whoami --actor agent-b --json --artifact-root "$C_ROOT" | node -e 'const o=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(o.actor);')"
C1_WHOAMI_A="$(flow_agents_node "$WRITER" liveness whoami --actor agent-a --json --artifact-root "$C_ROOT" | node -e 'const o=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(o.actor);')"

if [[ "$C1_ROW_STATUS" == "verified" ]] && [[ "$C1_ROW_ACTOR" == "agent-a" ]] && [[ "$C1_ROW_ACTOR" != "$C1_WHOAMI_B" ]]; then
  _pass "held-exclusion: a verified row for agent-a, read as agent-b's whoami, classifies subj-held as held (row actor != self) (AC1, AC2)"
else
  _fail "held-exclusion classification failed: row_status=$C1_ROW_STATUS row_actor=$C1_ROW_ACTOR whoami_b=$C1_WHOAMI_B raw=$C1_STATUS"
fi

if [[ "$C1_ROW_STATUS" == "verified" ]] && [[ "$C1_ROW_ACTOR" == "agent-a" ]] && [[ "$C1_ROW_ACTOR" == "$C1_WHOAMI_A" ]]; then
  _pass "own-actor mine: the SAME verified row, read as agent-a's own whoami, classifies subj-held as mine, not held (AC5)"
else
  _fail "own-actor mine classification failed: row_status=$C1_ROW_STATUS row_actor=$C1_ROW_ACTOR whoami_a=$C1_WHOAMI_A raw=$C1_STATUS"
fi

# C3: Reclaimable — actor agent-c's claim is seeded far enough in the past (beyond ttlSeconds)
# that `--now` places it past TTL expiry. Assert the row's RAW `status` field reads `stale`
# (never `label`, which collapses stale to the coarser "free" and would lose the distinction —
# proving the "consume status, not label" design decision is real and observable).
flow_agents_node "$WRITER" liveness claim subj-stale --actor agent-c --at "2026-06-25T11:00:00Z" --ttl 1800 --artifact-root "$C_ROOT" >/dev/null 2>"$TMPDIR_EVAL/c-claim-c.err"
C3_STATUS="$(status_row_json "$C_ROOT" subj-stale "2026-07-01T12:10:00Z")"
C3_ROW_STATUS="$(printf '%s' "$C3_STATUS" | node -e 'const rows=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(rows[0] ? rows[0].status : "");')"
C3_ROW_LABEL="$(printf '%s' "$C3_STATUS" | node -e 'const rows=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(rows[0] ? rows[0].label : "");')"
if [[ "$C3_ROW_STATUS" == "stale" ]] && [[ "$C3_ROW_LABEL" == "free" ]]; then
  _pass "reclaimable: raw status field reads 'stale' (distinct from the coarser label 'free') — proves 'consume status, not label' is real, not just documented (AC3)"
else
  _fail "reclaimable classification failed: raw status=$C3_ROW_STATUS label=$C3_ROW_LABEL raw=$C3_STATUS"
fi

# C4: Free — a subject with no liveness events at all returns an empty row set.
C4_STATUS="$(status_row_json "$C_ROOT" subj-never-claimed "2026-07-01T12:10:00Z")"
if [[ "$C4_STATUS" == "[]" ]]; then
  _pass "free: a never-claimed subject returns an empty row set for liveness status --json --subject (AC1)"
else
  _fail "free-case status was not empty: $C4_STATUS"
fi

# C5: Claim-emit-on-selection — subjectId derived via resolve-slug; a "selection" runs
# `liveness claim <subjectId>` exactly once, appending exactly one new claim event for that
# (subjectId, actor) pair, and a subsequent status read shows that actor verified/held.
C5_SUBJECT_ID="$(flow_agents_node "$WRITER" resolve-slug 'owner/repo#77' 2>"$TMPDIR_EVAL/c5-resolve.err")"
C5_STREAM="$C_ROOT/liveness/events.jsonl"
C5_LINES_BEFORE=0
[[ -f "$C5_STREAM" ]] && C5_LINES_BEFORE="$(wc -l <"$C5_STREAM" | tr -d ' ')"
flow_agents_node "$WRITER" liveness claim "$C5_SUBJECT_ID" --actor agent-selector --artifact-root "$C_ROOT" >/dev/null 2>"$TMPDIR_EVAL/c5-claim.err"
C5_LINES_AFTER="$(wc -l <"$C5_STREAM" | tr -d ' ')"
C5_APPENDED=$((C5_LINES_AFTER - C5_LINES_BEFORE))
C5_STATUS_AFTER="$(status_row_json "$C_ROOT" "$C5_SUBJECT_ID" "2026-07-01T12:10:00Z")"
C5_ROW_STATUS_AFTER="$(printf '%s' "$C5_STATUS_AFTER" | node -e 'const rows=JSON.parse(require("fs").readFileSync(0,"utf8")); const r=rows.find(x=>x.actor==="agent-selector"); process.stdout.write(r ? r.status : "");')"
if [[ "$C5_SUBJECT_ID" == "owner-repo-77" ]] && [[ "$C5_APPENDED" -eq 1 ]] && [[ "$C5_ROW_STATUS_AFTER" == "verified" ]]; then
  _pass "claim-emit-on-selection: liveness claim <resolve-slug-derived subjectId> appends exactly one event and shows verified/held for that actor thereafter (AC4)"
else
  _fail "claim-emit-on-selection failed: subjectId=$C5_SUBJECT_ID appended=$C5_APPENDED row_status_after=$C5_ROW_STATUS_AFTER raw=$C5_STATUS_AFTER"
fi

# C6: Force-write unconstrained at the CLI layer — `liveness claim` on subj-held (already held
# fresh by agent-a, per C1/C2) succeeds unconditionally for a different actor. Proves --force
# needs no CLI-side change: the write path has no holder-conflict check to override (Design
# Decision 4).
if flow_agents_node "$WRITER" liveness claim subj-held --actor agent-force --artifact-root "$C_ROOT" >"$TMPDIR_EVAL/c6.out" 2>"$TMPDIR_EVAL/c6.err"; then
  C6_STATUS="$(status_row_json "$C_ROOT" subj-held "2026-07-01T12:15:00Z")"
  C6_BOTH_HELD="$(printf '%s' "$C6_STATUS" | node -e '
const rows = JSON.parse(require("fs").readFileSync(0, "utf8"));
const a = rows.find((r) => r.actor === "agent-a");
const f = rows.find((r) => r.actor === "agent-force");
process.stdout.write(a && f && a.status === "verified" && f.status === "verified" ? "yes" : "no");
')"
  if [[ "$C6_BOTH_HELD" == "yes" ]]; then
    _pass "force-write unconstrained: liveness claim on an already-held subject succeeds unconditionally for a different actor (no CLI-side holder-conflict check) (Design Decision 4)"
  else
    _fail "force-write left an unexpected status row set: $C6_STATUS"
  fi
else
  _fail "liveness claim on an already-held subject unexpectedly failed (CLI should have no holder-conflict check): $(cat "$TMPDIR_EVAL/c6.out" "$TMPDIR_EVAL/c6.err")"
fi

# ─── E. F1 (fix-plan iteration 1) — liveness whoami never touches the workflow-sidecar
# lock, regardless of artifact-root state (mirrors resolve-slug's empty lockRoot) ──────────
echo "--- E. F1: liveness whoami lock-bypass proof ---"

# E1: existing artifact root + FLOW_AGENTS_WORKFLOW_SIDECAR_LOCK_DELAY set -> whoami never
# creates .workflow-sidecar.lockdir (polled live during the delay window, not just checked
# post-hoc — a post-hoc-only check could not distinguish "never locked" from "locked, delayed,
# then cleaned up before we looked") -> exits 0.
E1_ROOT="$(new_scratch)/.kontourai/flow-agents"
mkdir -p "$E1_ROOT"
FLOW_AGENTS_WORKFLOW_SIDECAR_LOCK_DELAY=3 flow_agents_node "$WRITER" liveness whoami --json --artifact-root "$E1_ROOT" >"$TMPDIR_EVAL/e1.out" 2>"$TMPDIR_EVAL/e1.err" &
E1_PID=$!
E1_LOCKDIR_SEEN="no"
E1_POLL_DEADLINE=$(( $(date +%s%N) + 1500000000 ))
while [[ "$(date +%s%N)" -lt "$E1_POLL_DEADLINE" ]]; do
  if [[ -e "$E1_ROOT/.workflow-sidecar.lockdir" ]]; then E1_LOCKDIR_SEEN="yes"; break; fi
  if ! kill -0 "$E1_PID" 2>/dev/null; then break; fi
  sleep 0.05
done
wait "$E1_PID"
E1_STATUS=$?
if [[ "$E1_STATUS" -eq 0 ]] && [[ "$E1_LOCKDIR_SEEN" == "no" ]]; then
  _pass "liveness whoami against an EXISTING artifact root with FLOW_AGENTS_WORKFLOW_SIDECAR_LOCK_DELAY set never creates .workflow-sidecar.lockdir (polled live) and exits 0 (F1)"
else
  _fail "liveness whoami lock-bypass failed: status=$E1_STATUS lockdir_seen=$E1_LOCKDIR_SEEN out=$(cat "$TMPDIR_EVAL/e1.out") err=$(cat "$TMPDIR_EVAL/e1.err")"
fi

# E2: existing but non-writable (555) artifact root -> whoami still exits 0 (no lock attempt,
# so no mkdir-under-a-read-only-dir failure is even possible).
E2_ROOT="$(new_scratch)/.kontourai/flow-agents"
mkdir -p "$E2_ROOT"
chmod 555 "$E2_ROOT"
E2_STATUS=0
flow_agents_node "$WRITER" liveness whoami --json --artifact-root "$E2_ROOT" >"$TMPDIR_EVAL/e2.out" 2>"$TMPDIR_EVAL/e2.err" || E2_STATUS=$?
chmod 755 "$E2_ROOT"
if [[ "$E2_STATUS" -eq 0 ]]; then
  _pass "liveness whoami against a non-writable (555) EXISTING artifact root still exits 0 (F1)"
else
  _fail "liveness whoami under a 555 artifact root unexpectedly failed: status=$E2_STATUS out=$(cat "$TMPDIR_EVAL/e2.out") err=$(cat "$TMPDIR_EVAL/e2.err")"
fi

# E3: contrast — `liveness status` (out of scope for F1, pre-existing lock behavior preserved)
# still acquires the lock against an existing root with the delay set. Proves F1's bypass is
# scoped to the `whoami` action only, not a blanket change to `liveness` command lock routing.
E3_ROOT="$(new_scratch)/.kontourai/flow-agents"
mkdir -p "$E3_ROOT"
FLOW_AGENTS_WORKFLOW_SIDECAR_LOCK_DELAY=1.5 flow_agents_node "$WRITER" liveness status --json --artifact-root "$E3_ROOT" >"$TMPDIR_EVAL/e3.out" 2>"$TMPDIR_EVAL/e3.err" &
E3_PID=$!
E3_LOCKDIR_SEEN="no"
E3_POLL_DEADLINE=$(( $(date +%s%N) + 1200000000 ))
while [[ "$(date +%s%N)" -lt "$E3_POLL_DEADLINE" ]]; do
  if [[ -e "$E3_ROOT/.workflow-sidecar.lockdir" ]]; then E3_LOCKDIR_SEEN="yes"; break; fi
  if ! kill -0 "$E3_PID" 2>/dev/null; then break; fi
  sleep 0.05
done
wait "$E3_PID"
if [[ "$E3_LOCKDIR_SEEN" == "yes" ]]; then
  _pass "liveness status (out of scope for F1) still acquires .workflow-sidecar.lockdir against an existing root — proves F1's bypass is action-scoped to whoami, not a blanket liveness-command change"
else
  _fail "liveness status unexpectedly did not acquire the lock — F1's bypass may have leaked beyond the whoami action: out=$(cat "$TMPDIR_EVAL/e3.out") err=$(cat "$TMPDIR_EVAL/e3.err")"
fi

# ─── D. Provider-neutral skill contract assertions ─────────────────────────
echo "--- D. Provider-neutral skill contract assertions ---"

require_text "$PULL" 'Assignment And Liveness Selection Preflight' "pull-work documents assignment/liveness preflight"
require_text "$PULL" 'AssignmentProvider\.status' "pull-work consumes assignment status through the provider"
require_text "$PULL" 'classify the subject, not individual observation rows' "pull-work classifies grouped subject state"
require_text "$PULL" 'in this precedence' "pull-work documents ordered ownership states"
require_text "$PULL" 'raw provider status' "pull-work consumes raw status instead of display labels"
require_text "$PULL" 'double-hold conflict' "pull-work detects own/other live conflicts"
require_text "$PULL" 'Exclude it by default' "pull-work excludes held work by default"
require_text "$PULL" 'explicit recorded opt-in' "pull-work requires explicit reclaimable takeover"
require_text "$PULL" 'reclaimable_override' "pull-work records reclaimable overrides"
require_text "$PULL" 'takeover is resumption, not restart' "pull-work preserves incumbent continuation"
require_text "$PULL" 'AssignmentProvider\.claim' "pull-work claims through the provider boundary"
require_text "$PULL" 'After .AssignmentProvider\.claim' "pull-work rechecks ownership after claim"
require_text "$PULL" 'post-claim' "pull-work records post-claim conflicts"
require_text "$PULL" 'does not imply universal mutual exclusion' "pull-work does not overclaim race prevention"
require_text "$PULL" 'local-file provider' "pull-work scopes serialized claims to capable providers"
require_text "$PULL" 'without compare-and-swap' "pull-work treats non-atomic remote providers honestly"
require_text "$PULL" 'unrelated provider state' "pull-work limits provider mutation"
require_text "$PICKUP_PROBE" 're-confirm the recorded takeover opt-in' "pickup-probe re-confirms reclaimable takeover after drift"

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "Pull work liveness preflight integration passed."
  exit 0
fi

echo "Pull work liveness preflight integration failed: $errors issue(s)."
exit 1
