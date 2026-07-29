#!/usr/bin/env bash
# test_subject_collision_detection.sh - end-to-end proof that two lanes on ONE backlog item
# collide-detect (#1099), including across the legacy subject naming schemes.
#
# Not unit-level: every event here is written by the REAL `liveness claim` CLI path and read by
# the REAL `workflow-steering` hook, so the join being proven is the one a live session uses.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SIDECAR="$ROOT/build/src/cli/workflow-sidecar.js"
STEERING="$ROOT/scripts/hooks/workflow-steering.js"
CURRENT_POINTER_HELPER="$ROOT/scripts/hooks/lib/current-pointer.js"

TMPDIR_EVAL="$(mktemp -d)"
errors=0
trap 'rm -rf "$TMPDIR_EVAL"' EXIT

_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

if [[ ! -f "$SIDECAR" ]]; then
  echo "  ✗ build output missing: $SIDECAR (run npm run build)"
  exit 1
fi

REPO="$TMPDIR_EVAL/repo"
ARTIFACTS="$REPO/.kontourai/flow-agents"
mkdir -p "$ARTIFACTS"
printf '# Test Repo\n' > "$REPO/AGENTS.md"

LANE_A_ACTOR="eval-lane-a"
LANE_B_ACTOR="eval-lane-b"
WORK_ITEM="octo/demo#1254"
CANONICAL="octo-demo-1254"
LEGACY="s1254-tokens"

# Two sessions on the SAME backlog item, deliberately named under two different historical
# schemes: the canonical derived id (scheme A, 34 of the 95 counted) and `s<issue>-<words>`
# (scheme B, also 34). Both record the same Work Item binding, which is what the alias keys off.
write_session() {
  local slug="$1" actor="$2"
  mkdir -p "$ARTIFACTS/$slug"
  cat > "$ARTIFACTS/$slug/state.json" <<JSON
{
  "schema_version": "1.0",
  "task_slug": "$slug",
  "status": "in_progress",
  "phase": "execution",
  "updated_at": "2026-07-29T00:00:00Z",
  "work_item_refs": ["$WORK_ITEM"],
  "next_action": { "status": "continue", "summary": "Keep going." }
}
JSON
  CP_HELPER_ARG="$CURRENT_POINTER_HELPER" FLOW_AGENTS_DIR_ARG="$ARTIFACTS" \
    SLUG_ARG="$slug" ACTOR_ARG="$actor" node - <<'NODE'
const { writePerActorCurrent } = require(process.env.CP_HELPER_ARG);
writePerActorCurrent(process.env.FLOW_AGENTS_DIR_ARG, process.env.ACTOR_ARG, { active_slug: process.env.SLUG_ARG });
NODE
}

write_session "$CANONICAL" "$LANE_A_ACTOR"
write_session "$LEGACY" "$LANE_B_ACTOR"

echo "test_subject_collision_detection"

# ── 1. Lane B claims, under its LEGACY subject name, via the real CLI write path ─────────────
if FLOW_AGENTS_ACTOR="$LANE_B_ACTOR" node "$SIDECAR" liveness claim "$LEGACY" \
    --artifact-root "$ARTIFACTS" --actor "$LANE_B_ACTOR" >/dev/null 2>"$TMPDIR_EVAL/claim.err"; then
  _pass "lane B claimed its legacy subject through the real CLI"
else
  _fail "lane B claim failed: $(cat "$TMPDIR_EVAL/claim.err")"
fi

# The claim event must carry the backlog-derived key -- that stamp is the whole migration story.
if rg -q "\"subjectKey\":\"$CANONICAL\"" "$ARTIFACTS/liveness/events.jsonl"; then
  _pass "the claim event carries the backlog-derived subjectKey ($CANONICAL)"
else
  _fail "claim event is missing subjectKey: $(cat "$ARTIFACTS/liveness/events.jsonl")"
fi

# ── 2. Lane A, on the CANONICAL subject, sees lane B every turn ───────────────────────────────
if FLOW_AGENTS_ACTOR="$LANE_A_ACTOR" node "$STEERING" >"$TMPDIR_EVAL/lane_a.out" 2>/dev/null <<JSON
{"cwd":"$REPO","hook_event_name":"UserPromptSubmit","prompt":"continue the work"}
JSON
then
  if rg -q 'SUPERSEDED' "$TMPDIR_EVAL/lane_a.out" && rg -q "$LANE_B_ACTOR" "$TMPDIR_EVAL/lane_a.out"; then
    _pass "lane A (canonical subject) sees lane B's legacy-named claim as SUPERSEDED"
  else
    _fail "lane A did not surface the collision: $(cat "$TMPDIR_EVAL/lane_a.out")"
  fi
else
  _fail "steering hook failed for lane A"
fi

# ── 3. Symmetry: lane B, on the LEGACY subject, sees lane A's canonical claim ─────────────────
if FLOW_AGENTS_ACTOR="$LANE_A_ACTOR" node "$SIDECAR" liveness claim "$CANONICAL" \
    --artifact-root "$ARTIFACTS" --actor "$LANE_A_ACTOR" >/dev/null 2>&1; then
  :
else
  _fail "lane A claim failed"
fi

if FLOW_AGENTS_ACTOR="$LANE_B_ACTOR" node "$STEERING" >"$TMPDIR_EVAL/lane_b.out" 2>/dev/null <<JSON
{"cwd":"$REPO","hook_event_name":"UserPromptSubmit","prompt":"continue the work"}
JSON
then
  if rg -q 'SUPERSEDED' "$TMPDIR_EVAL/lane_b.out" && rg -q "$LANE_A_ACTOR" "$TMPDIR_EVAL/lane_b.out"; then
    _pass "lane B (legacy subject) sees lane A's canonical claim as SUPERSEDED"
  else
    _fail "lane B did not surface the collision: $(cat "$TMPDIR_EVAL/lane_b.out")"
  fi
else
  _fail "steering hook failed for lane B"
fi

# ── 4. NEGATIVE: a different item must never collide ─────────────────────────────────────────
OTHER_REPO="$TMPDIR_EVAL/other"
OTHER_ARTIFACTS="$OTHER_REPO/.kontourai/flow-agents"
mkdir -p "$OTHER_ARTIFACTS"
printf '# Test Repo\n' > "$OTHER_REPO/AGENTS.md"
mkdir -p "$OTHER_ARTIFACTS/octo-demo-1168"
cat > "$OTHER_ARTIFACTS/octo-demo-1168/state.json" <<'JSON'
{"schema_version":"1.0","task_slug":"octo-demo-1168","status":"in_progress","phase":"execution","updated_at":"2026-07-29T00:00:00Z","work_item_refs":["octo/demo#1168"]}
JSON
CP_HELPER_ARG="$CURRENT_POINTER_HELPER" FLOW_AGENTS_DIR_ARG="$OTHER_ARTIFACTS" \
  SLUG_ARG="octo-demo-1168" ACTOR_ARG="$LANE_A_ACTOR" node - <<'NODE'
const { writePerActorCurrent } = require(process.env.CP_HELPER_ARG);
writePerActorCurrent(process.env.FLOW_AGENTS_DIR_ARG, process.env.ACTOR_ARG, { active_slug: process.env.SLUG_ARG });
NODE
cp "$ARTIFACTS/liveness/events.jsonl" "$TMPDIR_EVAL/events-copy.jsonl"
mkdir -p "$OTHER_ARTIFACTS/liveness"
cp "$TMPDIR_EVAL/events-copy.jsonl" "$OTHER_ARTIFACTS/liveness/events.jsonl"

if FLOW_AGENTS_ACTOR="$LANE_A_ACTOR" node "$STEERING" >"$TMPDIR_EVAL/other.out" 2>/dev/null <<JSON
{"cwd":"$OTHER_REPO","hook_event_name":"UserPromptSubmit","prompt":"continue the work"}
JSON
then
  if rg -q 'SUPERSEDED' "$TMPDIR_EVAL/other.out"; then
    _fail "a claim on issue 1254 wrongly collided with a session on issue 1168"
  else
    _pass "a different backlog item does NOT collide (the alias never widens)"
  fi
else
  _fail "steering hook failed for the negative case"
fi

# ── 5. ensure-session refuses to mint a NEW divergent subject for a provider Work Item ────────
NEW_ARTIFACTS="$TMPDIR_EVAL/new-repo/.kontourai/flow-agents"
mkdir -p "$NEW_ARTIFACTS"
if FLOW_AGENTS_ACTOR="$LANE_A_ACTOR" node "$SIDECAR" ensure-session \
    --artifact-root "$NEW_ARTIFACTS" --work-item "$WORK_ITEM" --task-slug "hand-picked-name" \
    >"$TMPDIR_EVAL/refuse.out" 2>"$TMPDIR_EVAL/refuse.err"; then
  _fail "ensure-session accepted a hand-picked subject id for a provider Work Item"
else
  if rg -q 'derived from the backlog item' "$TMPDIR_EVAL/refuse.err" && rg -q "$CANONICAL" "$TMPDIR_EVAL/refuse.err"; then
    _pass "ensure-session refuses a divergent --task-slug and names the canonical id"
  else
    _fail "refusal did not explain the canonical id: $(cat "$TMPDIR_EVAL/refuse.err")"
  fi
fi

# ── 6. MIGRATION: an EXISTING legacy session is grandfathered, never refused ──────────────────
if FLOW_AGENTS_ACTOR="$LANE_B_ACTOR" node "$SIDECAR" ensure-session \
    --artifact-root "$ARTIFACTS" --work-item "$WORK_ITEM" --task-slug "$LEGACY" \
    >"$TMPDIR_EVAL/legacy.out" 2>"$TMPDIR_EVAL/legacy.err"; then
  if rg -q 'predates deterministic subject identity' "$TMPDIR_EVAL/legacy.err"; then
    _pass "an existing legacy session still resolves, with the canonical id named once"
  else
    _pass "an existing legacy session still resolves"
  fi
else
  _fail "ensure-session refused an EXISTING legacy session (migration break): $(cat "$TMPDIR_EVAL/legacy.err")"
fi

if [[ $errors -gt 0 ]]; then
  echo "  $errors check(s) failed"
  exit 1
fi
exit 0
