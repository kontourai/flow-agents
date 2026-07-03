#!/usr/bin/env bash
# test_sidecar_field_preservation.sh — CLASS-level regression guard for the #270/#298/#309
# field-loss bug family (silent persistent-field drop on a state.json-writing sidecar command).
#
# #289 introduced `branch:` as a persistent identity field; #309 found init-plan's initSidecars
# rewrite could silently DROP it on a repaired/backfilled session (a live instance of the same
# "state.json fully rewritten, not merged" bug class that #270/#298 already hit for other fields).
# code-review-309 found the SAME class live again: the #309 backfill path silently reset
# created_at on a repaired session, because initSidecars always re-stamps created_at from the
# current call's timestamp instead of preserving an existing session's original creation time.
#
# Rather than adding another one-field regression test, this is an INVARIANT SWEEP: seed one
# fully-populated session, run every state.json-touching mutator subcommand once (in the order a
# real session actually calls them), and after EACH command assert that every persistent identity
# field (branch, task_slug, repo, created_at, and owner when present) is byte-identical to the
# seeded baseline — except the fields a given command explicitly owns (status, phase, updated_at,
# next_action, artifact_paths). Any FUTURE writer that starts fully rewriting state.json instead
# of merging prior contents (the root cause of this whole bug family) fails this sweep immediately,
# naming the offending command — without anyone having to think to add a bespoke field-loss test
# for it first.
#
# Deterministic, no model spend, self-cleaning.
# Usage: bash evals/integration/test_sidecar_field_preservation.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

WRITER="workflow-sidecar"
TMPDIR_EVAL="$(mktemp -d)"
errors=0

cleanup() { rm -rf "$TMPDIR_EVAL"; }
trap cleanup EXIT

_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for this eval's field-identity assertions" >&2
  exit 1
fi

SESSION_ROOT="$TMPDIR_EVAL/repo/.kontourai/flow-agents"
SLUG="sidecar-field-preservation-sweep"
SESSION_DIR="$SESSION_ROOT/$SLUG"
STATE="$SESSION_DIR/state.json"
mkdir -p "$SESSION_ROOT"

# ─── Field-identity assertion helpers ────────────────────────────────────────
# Persistent identity fields captured from the seeded baseline. `owner` is included per the
# schema (schemas/workflow-state.schema.json allows it) even though NO current sidecar writer
# path ever stamps it — no command sets `owner:` on state.json today, so the captured baseline
# value is always the jq sentinel "<absent>" and stays "<absent>" for the whole sweep. That is
# still a real (trivial) assertion: if some future writer starts adding an `owner` field without
# preserving a pre-existing one, this sweep would catch it the same way it catches every other
# persistent field. No fixture forces a synthetic owner value — that would test a code path that
# does not exist today.
FIELDS=(branch task_slug repo created_at owner)
declare -A BASELINE

_field() {
  local file="$1" field="$2"
  jq -r --arg f "$field" '.[$f] // "<absent>"' "$file" 2>/dev/null
}

_capture_baseline() {
  local field
  for field in "${FIELDS[@]}"; do
    BASELINE["$field"]="$(_field "$STATE" "$field")"
  done
}

_assert_preserved() {
  local label="$1"
  local field actual ok=1
  for field in "${FIELDS[@]}"; do
    actual="$(_field "$STATE" "$field")"
    if [[ "$actual" != "${BASELINE[$field]}" ]]; then
      _fail "$label dropped/changed persistent field '$field': expected '${BASELINE[$field]}' got '$actual'"
      ok=0
    fi
  done
  [[ "$ok" -eq 1 ]] && _pass "persistent identity fields (${FIELDS[*]}) survive $label"
}

# ─── Seed: ensure-session with an injected actor (derived branch) and a KNOWN timestamp ──────
SEED_TS="2026-06-20T08:00:00Z"
if ! flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$SESSION_ROOT" \
  --task-slug "$SLUG" \
  --actor sweep-actor \
  --flow-id builder.build \
  --title "Sidecar Field Preservation Sweep" \
  --source-request "Seed a fully-populated session for the field-preservation invariant sweep." \
  --summary "Seed session for the class-level field-preservation sweep." \
  --criterion "Every state.json-touching mutator preserves persistent identity fields" \
  --timestamp "$SEED_TS" >"$TMPDIR_EVAL/seed.out" 2>"$TMPDIR_EVAL/seed.err"; then
  _fail "sweep setup: ensure-session failed: $(cat "$TMPDIR_EVAL/seed.out" "$TMPDIR_EVAL/seed.err")"
  echo ""
  echo "$errors check(s) failed."
  exit 1
fi

if [[ ! -f "$STATE" ]]; then
  _fail "sweep setup: ensure-session did not write state.json"
  echo ""
  echo "$errors check(s) failed."
  exit 1
fi

_capture_baseline
if [[ "${BASELINE[branch]}" != "agent/sweep-actor/$SLUG" || "${BASELINE[created_at]}" != "$SEED_TS" || "${BASELINE[task_slug]}" != "$SLUG" ]]; then
  _fail "sweep setup: seeded baseline did not carry the expected branch/created_at/task_slug (branch=${BASELINE[branch]} created_at=${BASELINE[created_at]} task_slug=${BASELINE[task_slug]})"
fi

# ─── 1. init-plan, run against a BRANCH-LESS plan artifact ───────────────────────────────────
# Mirrors the real tool-planner shape: init-plan is invoked against the plan artifact
# ("<slug>--plan-work.md"), a DIFFERENT file than "<slug>--deliver.md" that ensure-session seeded
# the branch: line into. This is the exact repro shape of the #309 regression.
PLAN_ARTIFACT="$SESSION_DIR/$SLUG--plan-work.md"
cat > "$PLAN_ARTIFACT" <<'MARKDOWN'
---
role: plan
parent: sidecar-field-preservation-sweep--deliver
created: 2026-06-20
---

# Plan: field-preservation sweep fixture

A plan artifact deliberately carrying no `branch:` line (mirrors real tool-planner output).

## Definition Of Done

- **Acceptance criteria:**
  - [ ] init-plan preserves persistent identity fields - Evidence: pending.
MARKDOWN
if flow_agents_node "$WRITER" init-plan "$PLAN_ARTIFACT" \
  --source-request "Plan artifact carries no branch: line (mirrors tool-planner output)." \
  --summary "Planning sidecars initialized from a branch-less plan artifact." \
  --next-action "Advance to execution." \
  --timestamp "2026-06-20T08:05:00Z" >"$TMPDIR_EVAL/init-plan.out" 2>"$TMPDIR_EVAL/init-plan.err"; then
  _assert_preserved "init-plan"
else
  _fail "init-plan failed: $(cat "$TMPDIR_EVAL/init-plan.out" "$TMPDIR_EVAL/init-plan.err")"
fi

# ─── 2. advance-state (--flow-definition builder.build, non-terminal) ────────────────────────
# Moves phase execution -> maps to the "execute" step in builder.build's phase_map, which also
# sets current.json active_step_id so record-gate-claim below has a reachable gate.
if flow_agents_node "$WRITER" advance-state "$SESSION_DIR" \
  --status in_progress \
  --phase execution \
  --summary "Execution started." \
  --next-action "Implement the change." \
  --flow-definition builder.build \
  --timestamp "2026-06-20T08:10:00Z" >"$TMPDIR_EVAL/advance-1.out" 2>"$TMPDIR_EVAL/advance-1.err"; then
  _assert_preserved "advance-state (#1, builder.build execution)"
else
  _fail "advance-state (#1) failed: $(cat "$TMPDIR_EVAL/advance-1.out" "$TMPDIR_EVAL/advance-1.err")"
fi

# ─── 3. record-agent-event ────────────────────────────────────────────────────────────────────
# record-agent-event does not write state.json at all today (only agents/<id>/events.jsonl and
# current.json active_agents) — this still pins that invariant: state.json must stay untouched.
if flow_agents_node "$WRITER" record-agent-event \
  --artifact-root "$SESSION_ROOT" \
  --agent-id tool-worker-sweep \
  --kind evidence \
  --status active \
  --summary "Worker started the sweep's implementation pass." \
  --timestamp "2026-06-20T08:15:00Z" >"$TMPDIR_EVAL/agent-event.out" 2>"$TMPDIR_EVAL/agent-event.err"; then
  _assert_preserved "record-agent-event"
else
  _fail "record-agent-event failed: $(cat "$TMPDIR_EVAL/agent-event.out" "$TMPDIR_EVAL/agent-event.err")"
fi

# ─── 4. record-evidence (one check) ───────────────────────────────────────────────────────────
if flow_agents_node "$WRITER" record-evidence "$SESSION_DIR" \
  --verdict pass \
  --check-json '{"id":"sweep-check","kind":"command","status":"pass","summary":"Sweep fixture command check."}' \
  --timestamp "2026-06-20T08:20:00Z" >"$TMPDIR_EVAL/evidence.out" 2>"$TMPDIR_EVAL/evidence.err"; then
  _assert_preserved "record-evidence"
else
  _fail "record-evidence failed: $(cat "$TMPDIR_EVAL/evidence.out" "$TMPDIR_EVAL/evidence.err")"
fi

# ─── 5. record-critique (one finding) ─────────────────────────────────────────────────────────
if flow_agents_node "$WRITER" record-critique "$SESSION_DIR" \
  --id sweep-review \
  --reviewer tool-code-reviewer \
  --verdict pass \
  --summary "No blocking findings." \
  --finding-json '{"id":"sweep-finding","severity":"low","status":"fixed","description":"No blocking issues found during sweep sanity critique."}' \
  --timestamp "2026-06-20T08:25:00Z" >"$TMPDIR_EVAL/critique.out" 2>"$TMPDIR_EVAL/critique.err"; then
  _assert_preserved "record-critique"
else
  _fail "record-critique failed: $(cat "$TMPDIR_EVAL/critique.out" "$TMPDIR_EVAL/critique.err")"
fi

# ─── 6. record-gate-claim (a builder.build-reachable expectation) ────────────────────────────
# advance-state #1 above (--phase execution) set current.json active_step_id to "execute" via
# builder.build's phase_map. The execute-gate in kits/builder/flows/build.flow.json declares
# exactly ONE expects[] entry ("implementation-scope"), so it auto-resolves without needing
# --expectation. This IS reachable in this scratch fixture (unlike, say, the verify-gate's two
# expects entries, which would need an explicit --expectation and a route-back dance to reach
# cleanly) — so no command in this sweep needed to be skipped.
if flow_agents_node "$WRITER" record-gate-claim "$SESSION_DIR" \
  --status pass \
  --summary "Implementation scope recorded for the sweep fixture." \
  --timestamp "2026-06-20T08:30:00Z" >"$TMPDIR_EVAL/gate-claim.out" 2>"$TMPDIR_EVAL/gate-claim.err"; then
  _assert_preserved "record-gate-claim"
else
  _fail "record-gate-claim failed: $(cat "$TMPDIR_EVAL/gate-claim.out" "$TMPDIR_EVAL/gate-claim.err")"
fi

# ─── 7. record-learning (correction.needed:false shape) ──────────────────────────────────────
if flow_agents_node "$WRITER" record-learning "$SESSION_DIR" \
  --status learned \
  --record-json '{"id":"sweep-learning","source_refs":["state.json","trust.bundle"],"outcome":"success","facts":["Field-preservation sweep completed without a persistent-field regression."],"interpretation":"Every state.json-touching mutator preserved the seeded identity fields.","routing":[{"target":"none","action":"No follow-up required.","status":"completed"}],"correction":{"needed":false,"evidence":"All persistent identity fields matched the seeded baseline after every mutator."}}' \
  --summary "Learning recorded; no follow-up remains." \
  --timestamp "2026-06-20T08:35:00Z" >"$TMPDIR_EVAL/learning.out" 2>"$TMPDIR_EVAL/learning.err"; then
  _assert_preserved "record-learning"
else
  _fail "record-learning failed: $(cat "$TMPDIR_EVAL/learning.out" "$TMPDIR_EVAL/learning.err")"
fi

# ─── 8. advance-state (second call) ──────────────────────────────────────────────────────────
# record-learning above already moved phase to "learning" (writeState), so an accepted/archived
# target here is allowed by advance-state's terminal-jump guard (prev.phase === "learning").
if flow_agents_node "$WRITER" advance-state "$SESSION_DIR" \
  --status archived \
  --phase learning \
  --summary "Sweep session closed out." \
  --next-action "None." \
  --timestamp "2026-06-20T08:40:00Z" >"$TMPDIR_EVAL/advance-2.out" 2>"$TMPDIR_EVAL/advance-2.err"; then
  _assert_preserved "advance-state (#2, close-out)"
else
  _fail "advance-state (#2) failed: $(cat "$TMPDIR_EVAL/advance-2.out" "$TMPDIR_EVAL/advance-2.err")"
fi

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "test_sidecar_field_preservation: all checks passed."
else
  echo "test_sidecar_field_preservation: $errors check(s) failed."
fi
exit "$errors"
