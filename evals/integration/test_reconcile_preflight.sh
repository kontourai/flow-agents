#!/usr/bin/env bash
# test_reconcile_preflight.sh — #356 (Local Reconcile-Shape Preflight) proof.
#
# Proves `workflow-sidecar reconcile-preflight <artifact-dir>` catches every documented
# ADR-0020-invalid trust.bundle shape LOCALLY, before git push — reusing (never forking)
# scripts/lib/reconcile-shape.js's own classification (the same module
# scripts/ci/trust-reconcile.js requires), so the local check can never silently drift from
# what CI enforces. Mirrors evals/integration/test_trust_reconcile_negatives.sh's
# fixture-per-case + run_case() helper shape.
#
#   1. non-manifest command-backed claim (reuses trust-reconcile-exploits/no-label-bypass.json)
#      → not-run divergence + fix hint to name the exact manifest command.
#   2. unwaived assumed claim (reuses trust-reconcile-exploits/skip-assumed-bypass.json)
#      → unwaived-assumed divergence + fix hint (also carries Q2's root-cause hint for shape 5).
#   3. un-superseded disputed critique (new fixture: disputed-critique-unsuperseded.json)
#      → session-local-failed divergence (a workflow.critique.review claim, no superseded_by).
#   4. standalone fail/disputed session-local claim, non-critique (#292/#384 variant; new
#      fixture: standalone-disputed-session-local.json) → the SAME session-local-failed
#      divergence type as case 3, proving a disjoint pre-existing failure can never be
#      smuggled in as a standalone claim either way.
#   5. waiver-voided-by-mixed-call — reproduced via the REAL producer CLI (record-evidence),
#      not a hand-built fixture. Confirms the actual current behavior: the command-backed-
#      waiver guard at src/cli/workflow-sidecar.ts's recordEvidence() dies at RECORD time
#      when --accepted-gap-reason/--waived-by is combined with ANY command-backed check in
#      the same call (even alongside other, session-local checks in the same --check-json
#      set) — so there is no "silently voided" bundle to reconcile in this repo's current
#      producer; this is documented, correct, prevention-at-the-source, not a preflight gap.
#   6. dropped waiver metadata round-trip (AC2) — a regression PROOF, not a preflight
#      detection: record-evidence (waiver on a session-local check) → record-critique
#      (rebuilds via checksFromBundle) → the bundle's claim STILL has metadata.waiver.
#
# Plus: CLEAN-BUNDLE (AC4, reuses trust-reconcile-mixed-bundle/mixed-bundle.json) → exit 0,
# no issues. AC5 (local/fast, no CI spawn): a --manifest override naming a sentinel-writing
# command is never invoked by the preflight on the clean bundle.
#
# Deterministic, no model spend, self-cleaning.
# Usage: bash evals/integration/test_reconcile_preflight.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

WRITER="workflow-sidecar"
FX_EXPLOITS="$ROOT/evals/fixtures/trust-reconcile-exploits"
FX_PREFLIGHT="$ROOT/evals/fixtures/reconcile-preflight"
MIXED_BUNDLE="$ROOT/evals/fixtures/trust-reconcile-mixed-bundle/mixed-bundle.json"

TMP="$(mktemp -d)"
errors=0

_pass() { echo "  PASS: $1"; }
_fail() { echo "  FAIL: $1"; errors=$((errors + 1)); }

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# run_case <label> <bundle> <needle...>
# Copies <bundle> into a fresh session dir as trust.bundle, runs reconcile-preflight, and
# asserts: exit non-zero AND stdout/stderr contains EVERY needle passed after <bundle>.
run_case() {
  local label="$1" bundle="$2"
  shift 2
  echo "=== $label ==="
  if [[ ! -f "$bundle" ]]; then _fail "$label: fixture not found at $bundle"; return; fi
  local session="$TMP/case-$RANDOM$RANDOM"
  mkdir -p "$session"
  cp "$bundle" "$session/trust.bundle"
  local out code
  out="$(flow_agents_node "$WRITER" reconcile-preflight "$session" --repo-root "$ROOT" 2>&1)"
  code=$?
  if [[ $code -ne 0 ]]; then
    _pass "$label: reconcile-preflight exits non-zero ($code)"
  else
    _fail "$label: expected non-zero exit, got 0 — output: $out"
  fi
  local needle
  for needle in "$@"; do
    if echo "$out" | grep -qF "$needle"; then
      _pass "$label: output contains \"$needle\""
    else
      _fail "$label: expected \"$needle\" in output — output: $out"
    fi
  done
}

# ==== Case 1: non-manifest command-backed claim (reused fixture) ====================
run_case "case 1: non-manifest command-backed claim" "$FX_EXPLOITS/no-label-bypass.json" \
  "c-fabricated-test" \
  "no manifest-matched execution.label" \
  "FIX: fold this into a non-command summary"

# ==== Case 2: unwaived assumed claim (reused fixture) ================================
run_case "case 2: unwaived assumed claim" "$FX_EXPLOITS/skip-assumed-bypass.json" \
  "c-skipped" \
  "re-derived status 'assumed' but carries no waiver" \
  "requires a documented waiver (--accepted-gap-reason/--waived-by)"

# ==== Case 3: un-superseded disputed critique (new fixture) ==========================
run_case "case 3: un-superseded disputed critique" "$FX_PREFLIGHT/disputed-critique-unsuperseded.json" \
  "c-disputed-critique" \
  "workflow.critique.review" \
  "has re-derived status 'disputed'" \
  "FIX: a disputed/failing claim always blocks reconcile. Document a disjoint pre-existing failure as prose in a WAIVED non-command summary, not as a standalone claim."

# ==== Case 4: standalone fail/disputed session-local claim, non-critique (#292/#384) =
run_case "case 4: standalone disputed session-local claim (non-critique)" "$FX_PREFLIGHT/standalone-disputed-session-local.json" \
  "c-standalone-disputed" \
  "has re-derived status 'disputed'" \
  "FIX: a disputed/failing claim always blocks reconcile. Document a disjoint pre-existing failure as prose in a WAIVED non-command summary, not as a standalone claim."

# ==== Case 5: waiver-voided-by-mixed-call — REAL PRODUCER CLI reproduction ===========
# Q2 resolution: shape #5 is NOT a distinct predicate — per the plan, confirm the ACTUAL
# current behavior first. This repo's guard at record-evidence time (the command-backed-
# waiver check ahead of any bundle write) dies loudly BEFORE a bundle is ever written when
# --accepted-gap-reason/--waived-by is combined with a command-backed check in the same
# call — including when a session-local check is ALSO present in the same call. That is the
# correct prevention (fail at the source, not a silently-voided bundle downstream) — assert
# the die message is clear and that no trust.bundle is produced.
echo "=== case 5: waiver-voided-by-mixed-call (real producer CLI reproduction) ==="

AROOT5="$TMP/repo5/.flow-agents"
SLUG5="case5-mixed-call"
SESSION_DIR5="$AROOT5/$SLUG5"
mkdir -p "$TMP/repo5/kits" "$AROOT5"

flow_agents_node "$WRITER" ensure-session --artifact-root "$AROOT5" --task-slug "$SLUG5" \
  --title "Case 5" --summary "waiver-voided-by-mixed-call repro" --criterion "x" \
  --timestamp "2026-07-04T10:00:00Z" >/dev/null 2>&1
flow_agents_node "$WRITER" init-plan "$SESSION_DIR5/${SLUG5}--deliver.md" \
  --source-request "t" --summary "t" --timestamp "2026-07-04T10:01:00Z" >/dev/null 2>&1

# 5a. Single command-backed check + waiver flags in the SAME call → dies at record time.
case5a_out="$(flow_agents_node "$WRITER" record-evidence "$SESSION_DIR5" --verdict pass \
  --check-json '{"id":"cmdcheck","kind":"test","status":"pass","summary":"cmd ran","command":"npm run validate:source --"}' \
  --accepted-gap-reason "load test env unavailable" --waived-by "brian" \
  --timestamp "2026-07-04T10:02:00Z" 2>&1)"
case5a_code=$?
if [[ $case5a_code -ne 0 ]]; then
  _pass "case 5a: record-evidence dies at RECORD time for a mixed waiver+command-backed call ($case5a_code)"
else
  _fail "case 5a: expected record-evidence to die (non-zero exit), got 0 — output: $case5a_out"
fi
if echo "$case5a_out" | grep -qF "cannot be applied to a command-backed check"; then
  _pass "case 5a: die message clearly names the command-backed-waiver rejection"
else
  _fail "case 5a: expected the command-backed-waiver die message — output: $case5a_out"
fi
if [[ ! -f "$SESSION_DIR5/trust.bundle" ]]; then
  _pass "case 5a: no trust.bundle written (dies BEFORE any bundle write — no silently-voided waiver bundle downstream)"
else
  _fail "case 5a: a trust.bundle was written despite the mixed-call guard firing"
fi

# 5b. TWO checks in the SAME call (one command-backed, one session-local) + waiver flags →
#     the guard scans ALL checks in the call, so this ALSO dies at record time (proves the
#     guard is not scoped only to a single-check call — the exact "mixed call" shape).
case5b_out="$(flow_agents_node "$WRITER" record-evidence "$SESSION_DIR5" --verdict pass \
  --check-json '{"id":"cmdcheck2","kind":"test","status":"pass","summary":"cmd ran","command":"npm run validate:source --"}' \
  --check-json '{"id":"sessioncheck2","kind":"external","status":"skip","summary":"manual load test skip"}' \
  --accepted-gap-reason "load test env unavailable" --waived-by "brian" \
  --timestamp "2026-07-04T10:03:00Z" 2>&1)"
case5b_code=$?
if [[ $case5b_code -ne 0 ]]; then
  _pass "case 5b: record-evidence ALSO dies for a two-check mixed call (command-backed + session-local, one waiver) ($case5b_code)"
else
  _fail "case 5b: expected record-evidence to die (non-zero exit), got 0 — output: $case5b_out"
fi
if echo "$case5b_out" | grep -qF "cannot be applied to a command-backed check"; then
  _pass "case 5b: die message clearly names the command-backed-waiver rejection"
else
  _fail "case 5b: expected the command-backed-waiver die message — output: $case5b_out"
fi
if [[ ! -f "$SESSION_DIR5/trust.bundle" ]]; then
  _pass "case 5b: no trust.bundle written"
else
  _fail "case 5b: a trust.bundle was written despite the mixed-call guard firing"
fi

# 5c. Sanity: the Q2 root-cause hint IS reachable via reconcile-preflight's message for an
#     honest (non-mixed-call) unwaived-assumed divergence — i.e. an agent who DOES end up
#     with an unwaived-assumed claim (by whatever path) gets pointed at the mixed-call guard
#     as a likely root cause. Reuses case 2's fixture; restated here for traceability to
#     shape #5 per Q2's resolution (shape #5 is #2 enriched with a root-cause hint, not a
#     distinct predicate).
Q2_SESSION="$TMP/q2-check"
mkdir -p "$Q2_SESSION"
cp "$FX_EXPLOITS/skip-assumed-bypass.json" "$Q2_SESSION/trust.bundle"
q2_out="$(flow_agents_node "$WRITER" reconcile-preflight "$Q2_SESSION" --repo-root "$ROOT" 2>&1)"
if echo "$q2_out" | grep -qF "voids/rejects the waiver"; then
  _pass "case 5c (Q2 traceability): unwaived-assumed's preflight message carries the mixed-call root-cause hint"
else
  _fail "case 5c (Q2 traceability): expected the mixed-call root-cause hint on an unwaived-assumed divergence — output: $q2_out"
fi

# ==== Case 6 (AC2): dropped waiver metadata round-trip — regression PROOF, not detection ==
echo "=== case 6 (AC2): waiver metadata round-trip survives record-critique rebuild ==="

AROOT6="$TMP/repo6/.flow-agents"
SLUG6="case6-waiver-roundtrip"
SESSION_DIR6="$AROOT6/$SLUG6"
mkdir -p "$TMP/repo6/kits" "$AROOT6"

flow_agents_node "$WRITER" ensure-session --artifact-root "$AROOT6" --task-slug "$SLUG6" \
  --title "Case 6" --summary "waiver round-trip repro" --criterion "x" \
  --timestamp "2026-07-04T10:00:00Z" >/dev/null 2>&1
flow_agents_node "$WRITER" init-plan "$SESSION_DIR6/${SLUG6}--deliver.md" \
  --source-request "t" --summary "t" --timestamp "2026-07-04T10:01:00Z" >/dev/null 2>&1

flow_agents_node "$WRITER" record-evidence "$SESSION_DIR6" --verdict pass \
  --check-json '{"id":"loadtest","kind":"external","status":"skip","summary":"load test skip"}' \
  --accepted-gap-reason "load test env unavailable" --waived-by "brian" \
  --timestamp "2026-07-04T10:02:00Z" >/dev/null 2>&1

flow_agents_node "$WRITER" record-critique "$SESSION_DIR6" --verdict pass --summary "ok." \
  --timestamp "2026-07-04T10:03:00Z" >/dev/null 2>&1

if [[ -f "$SESSION_DIR6/trust.bundle" ]]; then
  _pass "case 6: trust.bundle exists after record-evidence -> record-critique rebuild"
  bundle_json="$(cat "$SESSION_DIR6/trust.bundle")"
  if echo "$bundle_json" | grep -qF '"waiver"'; then
    _pass "case 6: rebuilt trust.bundle's claim STILL carries metadata.waiver (AC2 fix holds — pre-fix this silently dropped)"
  else
    _fail "case 6: rebuilt trust.bundle's claim LOST metadata.waiver — AC2 round-trip regressed. bundle: $bundle_json"
  fi
  if echo "$bundle_json" | grep -qF '"approved_by": "brian"'; then
    _pass "case 6: waiver's approved_by ('brian') survives the rebuild"
  else
    _fail "case 6: expected waiver.approved_by 'brian' to survive the rebuild — bundle: $bundle_json"
  fi
else
  _fail "case 6: trust.bundle was not found at $SESSION_DIR6/trust.bundle after the round-trip sequence"
fi

# Reconcile-preflight must ALSO pass cleanly on the rebuilt (waiver-intact) bundle —
# an accepted-gap waiver on a session-local check is a shape-clean, WAIVED divergence-free
# bundle by ADR 0020's own rules.
preflight6_out="$(flow_agents_node "$WRITER" reconcile-preflight "$SESSION_DIR6" --repo-root "$ROOT" 2>&1)"
preflight6_code=$?
if [[ $preflight6_code -eq 0 ]]; then
  _pass "case 6: reconcile-preflight exits 0 on the round-tripped, waiver-intact bundle"
else
  _fail "case 6: expected reconcile-preflight exit 0 on the round-tripped bundle, got $preflight6_code — output: $preflight6_out"
fi

# ==== CLEAN-BUNDLE (AC4) ==============================================================
echo "=== CLEAN-BUNDLE (AC4): a valid ADR-0020-conformant bundle passes ==="

CLEAN_SESSION="$TMP/clean-bundle"
mkdir -p "$CLEAN_SESSION"
cp "$MIXED_BUNDLE" "$CLEAN_SESSION/trust.bundle"

clean_out="$(flow_agents_node "$WRITER" reconcile-preflight "$CLEAN_SESSION" --repo-root "$ROOT" 2>&1)"
clean_code=$?
if [[ $clean_code -eq 0 ]]; then
  _pass "CLEAN-BUNDLE: reconcile-preflight exits 0 for a valid bundle"
else
  _fail "CLEAN-BUNDLE: expected exit 0, got $clean_code — output: $clean_out"
fi
if echo "$clean_out" | grep -qF "OK — no shape issues found"; then
  _pass "CLEAN-BUNDLE: output reports no issues"
else
  _fail "CLEAN-BUNDLE: expected the no-issues OK line — output: $clean_out"
fi

# ==== AC5: preflight never spawns a manifest command =================================
echo "=== AC5: reconcile-preflight never spawns a fresh manifest command ==="

AC5_SESSION="$TMP/ac5-bundle"
mkdir -p "$AC5_SESSION"
cp "$MIXED_BUNDLE" "$AC5_SESSION/trust.bundle"
SENTINEL="$TMP/ac5-sentinel-should-not-exist"
rm -f "$SENTINEL"

# --manifest override: the mixed bundle's real command ("npm run check:content-boundary --")
# PLUS a second entry whose command WRITES a sentinel file if actually executed. Since
# reconcile-preflight resolves the manifest (a pure, local, no-command-execution lookup) but
# never calls runCommand/spawns a manifest entry's command to prove reconciliation, the
# sentinel must never appear.
AC5_MANIFEST='[{"id":"content-boundary","command":"npm run check:content-boundary --"},{"id":"sentinel","command":"touch '"$SENTINEL"'"}]'

ac5_out="$(flow_agents_node "$WRITER" reconcile-preflight "$AC5_SESSION" --repo-root "$ROOT" --manifest "$AC5_MANIFEST" 2>&1)"
ac5_code=$?
if [[ $ac5_code -eq 0 ]]; then
  _pass "AC5: reconcile-preflight exits 0 on the clean bundle with the sentinel manifest override"
else
  _fail "AC5: expected exit 0, got $ac5_code — output: $ac5_out"
fi
if [[ ! -f "$SENTINEL" ]]; then
  _pass "AC5: sentinel file absent after the preflight run — no manifest command was spawned"
else
  _fail "AC5: sentinel file EXISTS — reconcile-preflight spawned a manifest command (AC5 violated)"
fi

# ---- Summary ----
echo ""
echo "----------------------------------------------"
if [[ $errors -eq 0 ]]; then
  echo "test_reconcile_preflight: all checks passed."
  exit 0
else
  echo "test_reconcile_preflight: $errors check(s) failed."
  exit 1
fi
