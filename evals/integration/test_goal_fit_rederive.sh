#!/usr/bin/env bash
# test_goal_fit_rederive.sh — Killer test for ADR 0010 Phase 2b re-derive-at-gate hardening.
#
# Proves that:
#   1. A TAMPERED trust.bundle (stored status "verified" but evidence re-derives to
#      "disputed" because evidence[].passing === false) still BLOCKS (exit 2) and emits
#      the "stored status does not match recompute (possible tampered bundle)" warning.
#   2. A LEGITIMATE bundle (stored "verified" AND evidence re-derives to "verified") is
#      ALLOWED (no false-block).
#   3. The existing stored-status path still fires for a stored "disputed" claim (no
#      regression from #133).
#   4. The gate re-derives with the status function stamped in the bundle's `source`, and
#      blocks when the installed Surface cannot evaluate that stamp.
#
# Design: self-cleaning, deterministic (no model spend, no live commands).
# Usage: bash evals/integration/test_goal_fit_rederive.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# #440 FIXTURE-GAP: this suite's fixtures were written before #440's per-actor ownership scoping
# and never establish a per-actor current pointer for the invoking actor -- under a RESOLVED
# ambient actor (ancestry-derived locally, GITHUB_RUN_ID-derived CI-runtime in CI), stop-goal-fit.js's
# analyze() now scopes to that actor's own (nonexistent) pointer and never reaches the
# fixture-under-test at all. This suite is about anti-gaming/gate mechanics, not #440's ownership
# scoping, so forcing the documented test-only unresolved-actor escape hatch restores EXACTLY this
# suite's pre-#440 behavior (D3 compat: an unresolved actor keeps the unchanged legacy-fallback/
# global-scan discovery every assertion below was written against).
export FLOW_AGENTS_ACTOR_TEST_FORCE_UNRESOLVED=1
export NODE_ENV=test
GATE="$ROOT/scripts/hooks/stop-goal-fit.js"

export FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=100000

TMP="$(mktemp -d)"
errors=0
_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# ─── helper: seed a minimal delivered workflow artifact ───────────────────────
seed_repo() { # $1=dir $2=slug
  local p="$1" slug="$2"
  mkdir -p "$p/.kontourai/flow-agents/$slug"
  printf '# Repo\n' > "$p/AGENTS.md"
  printf '%s' "{\"schema_version\":\"1.0\",\"task_slug\":\"$slug\",\"status\":\"delivered\",\"phase\":\"done\",\"updated_at\":\"2026-06-23T00:00:00Z\",\"next_action\":{\"status\":\"done\",\"summary\":\"done\"}}" \
    > "$p/.kontourai/flow-agents/$slug/state.json"
  cat > "$p/.kontourai/flow-agents/$slug/$slug--deliver.md" << MD
# $slug

branch: main
status: delivered
type: deliver

## Definition Of Done
- [x] tests pass

## Goal Fit Gate
- [x] acceptance verified

### Verdict: PASS
MD
}

# ─── Test 1: TAMPERED bundle — stored "verified" but evidence re-derives to disputed ─
# A trust.bundle where the agent wrote claim.status="verified" to bypass the gate,
# but the evidence array has passing:false (a failing command result folded in by
# buildTrustBundle). Surface's deriveClaimStatus must re-derive "disputed" from
# that evidence, and the gate must block with a tamper warning.
echo "Test 1: tampered bundle (stored verified, evidence→disputed) must BLOCK"

TAMPER_DIR="$TMP/tamper"
seed_repo "$TAMPER_DIR" "tampered"

# Build a trust.bundle:
# - claim.status = "verified"   (stored, tampered to look safe)
# - evidence[passing=false]     (real command failed, fold in by sidecar)
# Surface.deriveClaimStatus will see passing:false evidence and return "disputed".
python3 - "$TAMPER_DIR/.kontourai/flow-agents/tampered/trust.bundle" << 'PY'
import json, sys
bundle = {
    "schemaVersion": 5,
    "source": "flow-agents/workflow-sidecar",
    "claims": [{
        "id": "c1",
        "subjectId": "tampered/unit-tests",
        "subjectType": "workflow-check",
        "claimType": "workflow.check.command",
        "fieldOrBehavior": "unit tests",
        "value": "pass",
        "impactLevel": "high",
        "status": "verified",   # tampered: agent edited this from "disputed" → "verified"
        "createdAt": "2026-06-23T00:00:00Z",
        "updatedAt": "2026-06-23T00:00:00Z"
    }],
    "evidence": [{
        "id": "ev1",
        "claimId": "c1",
        "evidenceType": "test_output",
        "method": "validation",
        "sourceRef": "command-log.jsonl",
        "excerptOrSummary": "npm test failed with exit 1",
        "observedAt": "2026-06-23T00:00:00Z",
        "collectedBy": "harness",
        "passing": False,       # the actual command FAILED — surface sees this
        "blocking": True
    }],
    "policies": [],
    "events": [{
        "id": "evt1",
        "claimId": "c1",
        "status": "verified",  # the event says verified (tampered)
        "actor": "agent",
        "method": "workflow-check",
        "evidenceIds": ["ev1"],
        "createdAt": "2026-06-23T00:00:00Z"
    }]
}
json.dump(bundle, open(sys.argv[1], 'w'))
PY

# Run the gate in block mode.
set +e
result_out="$(FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip \
    node "$GATE" 2>&1 <<< "{\"hook_event_name\":\"Stop\",\"cwd\":\"$TAMPER_DIR\"}")"
result_exit="$?"
set -e

if [ "$result_exit" -eq 2 ]; then
  _pass "tampered bundle blocks (exit 2)"
else
  _fail "tampered bundle did NOT block: exit=$result_exit output=$result_out"
fi

if echo "$result_out" | grep -qE "stored status.*does not match recompute|possible tampered bundle"; then
  _pass "tampered bundle emits tamper warning"
else
  _fail "tampered bundle missing tamper warning: $result_out"
fi

if echo "$result_out" | grep -q "caught false-completion"; then
  _pass "tampered bundle emits caught false-completion"
else
  _fail "tampered bundle missing caught false-completion: $result_out"
fi

# ─── Test 2: LEGITIMATE bundle — stored "verified" AND evidence re-derives to "verified" ─
# A bundle where both the stored status and the re-derived status agree on "verified"
# (a passing:true evidence + a "verified" event). Must ALLOW (exit 0 in warn mode).
echo ""
echo "Test 2: legitimate bundle (stored verified, evidence→verified) must ALLOW"

LEGIT_DIR="$TMP/legit"
seed_repo "$LEGIT_DIR" "legit"

python3 - "$LEGIT_DIR/.kontourai/flow-agents/legit/trust.bundle" << 'PY'
import json, sys
bundle = {
    "schemaVersion": 5,
    "source": "flow-agents/workflow-sidecar",
    "claims": [{
        "id": "c2",
        "subjectId": "legit/unit-tests",
        "subjectType": "workflow-check",
        "claimType": "workflow.check.command",
        "fieldOrBehavior": "unit tests",
        "value": "pass",
        "impactLevel": "high",
        "status": "verified",
        "createdAt": "2026-06-23T00:00:00Z",
        "updatedAt": "2026-06-23T00:00:00Z"
    }],
    "evidence": [{
        "id": "ev2",
        "claimId": "c2",
        "evidenceType": "test_output",
        "method": "validation",
        "sourceRef": "command-log.jsonl",
        "excerptOrSummary": "npm test passed",
        "observedAt": "2026-06-23T00:00:00Z",
        "collectedBy": "harness",
        "passing": True,        # command genuinely passed
        "blocking": False
    }],
    "policies": [],
    "events": [{
        "id": "evt2",
        "claimId": "c2",
        "status": "verified",
        "actor": "agent",
        "method": "workflow-check",
        "evidenceIds": ["ev2"],
        "createdAt": "2026-06-23T00:00:00Z"
    }]
}
json.dump(bundle, open(sys.argv[1], 'w'))
PY

set +e
legit_out="$(FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip \
    node "$GATE" 2>&1 <<< "{\"hook_event_name\":\"Stop\",\"cwd\":\"$LEGIT_DIR\"}")"
legit_exit="$?"
set -e

if [ "$legit_exit" -ne 2 ]; then
  _pass "legitimate bundle not blocked (exit $legit_exit)"
else
  _fail "legitimate bundle false-blocked (exit 2): $legit_out"
fi

if echo "$legit_out" | grep -q "caught false-completion"; then
  _fail "legitimate bundle incorrectly emits false-completion: $legit_out"
else
  _pass "legitimate bundle does not emit false-completion"
fi

# ─── Test 3: existing stored-disputed path still fires (no regression from #133) ──
echo ""
echo "Test 3: stored-disputed bundle must still BLOCK (no regression from #133)"

STORED_DIR="$TMP/stored"
seed_repo "$STORED_DIR" "stored"

python3 - "$STORED_DIR/.kontourai/flow-agents/stored/trust.bundle" << 'PY'
import json, sys
bundle = {
    "schemaVersion": 5,
    "source": "flow-agents/workflow-sidecar",
    "claims": [{
        "id": "c3",
        "subjectId": "stored/unit-tests",
        "subjectType": "workflow-check",
        "claimType": "workflow.check.command",
        "fieldOrBehavior": "unit tests",
        "value": "fail",
        "impactLevel": "high",
        "status": "disputed",   # stored as disputed (not tampered — correctly flagged)
        "createdAt": "2026-06-23T00:00:00Z",
        "updatedAt": "2026-06-23T00:00:00Z"
    }],
    "evidence": [],
    "policies": [],
    "events": []
}
json.dump(bundle, open(sys.argv[1], 'w'))
PY

set +e
stored_out="$(FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip \
    node "$GATE" 2>&1 <<< "{\"hook_event_name\":\"Stop\",\"cwd\":\"$STORED_DIR\"}")"
stored_exit="$?"
set -e

if [ "$stored_exit" -eq 2 ]; then
  _pass "stored-disputed bundle blocks (exit 2)"
else
  _fail "stored-disputed bundle did NOT block (exit $stored_exit): $stored_out"
fi

if echo "$stored_out" | grep -q "caught false-completion"; then
  _pass "stored-disputed bundle emits caught false-completion"
else
  _fail "stored-disputed bundle missing caught false-completion: $stored_out"
fi

# ─── Test 4: the gate re-derives with the status function the bundle was stamped with ──
# A bundle's writer stamps the status function it derived with into `source`. The stop gate
# must re-derive with that stamp, not the installed Surface's default (the rule the CI
# reconciler already follows). The fixture's two events are 0.1 ms apart, inside one
# millisecond: status function "3" lets the dispute stand, "4" orders the exact instants and
# lets the later verification win. A stored "verified" is therefore honest under "4" and a
# misassertion under "3". If the gate ignored the stamp it would derive "4" for both.
echo "Test 4: the gate re-derives with the bundle's stamped status function"

seed_stamped_bundle() { # $1=bundle_path $2=slug $3=source
  python3 - "$1" "$2" "$3" << 'PY'
import json, sys
path, slug, source = sys.argv[1], sys.argv[2], sys.argv[3]
bundle = {
    "schemaVersion": 5,
    "source": source,
    "claims": [{
        "id": "c1", "subjectId": slug + "/unit-tests", "subjectType": "workflow-check",
        "claimType": "workflow.check.command", "fieldOrBehavior": "unit tests", "value": "pass",
        "impactLevel": "high", "status": "verified", "verificationPolicyId": "p1",
        "createdAt": "2026-06-23T00:00:00Z", "updatedAt": "2026-06-23T00:00:00Z"
    }],
    "evidence": [{
        "id": "ev1", "claimId": "c1", "evidenceType": "test_output", "method": "validation",
        "sourceRef": "command-log.jsonl", "excerptOrSummary": "npm test passed",
        "observedAt": "2026-06-23T00:00:00Z", "collectedBy": "harness", "passing": True
    }],
    "policies": [{
        "id": "p1", "claimType": "workflow.check.command", "requiredEvidence": ["test_output"],
        "acceptanceCriteria": ["A passing test run supports the claim."], "reviewAuthority": "system",
        "validityRule": {"kind": "manual"}, "stalenessTriggers": [], "conflictRules": [], "impactLevel": "high"
    }],
    "events": [
        {"id": "evt-dispute", "claimId": "c1", "status": "disputed", "actor": "reviewer",
         "method": "workflow-check", "evidenceIds": [], "createdAt": "2026-06-23T00:00:00.0001Z"},
        {"id": "evt-verify", "claimId": "c1", "status": "verified", "actor": "harness",
         "method": "workflow-check", "evidenceIds": ["ev1"], "createdAt": "2026-06-23T00:00:00.0002Z"}
    ]
}
json.dump(bundle, open(path, "w"))
PY
}

run_gate() { # $1=dir
  FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip \
    node "$GATE" 2>&1 <<< "{\"hook_event_name\":\"Stop\",\"cwd\":\"$1\"}"
}

# Pin the premise: the installed Surface really does derive the fixture differently per version.
premise="$(cd "$ROOT" && node --input-type=module - << 'NODE' || true
const surface = await import("@kontourai/surface");
const claim = { id: "c1", claimType: "workflow.check.command", verificationPolicyId: "p1" };
const evidence = [{ id: "ev1", claimId: "c1", evidenceType: "test_output", method: "validation", passing: true, observedAt: "2026-06-23T00:00:00Z" }];
const policies = [{ id: "p1", claimType: "workflow.check.command", requiredEvidence: ["test_output"], validityRule: { kind: "manual" } }];
const events = [
  { id: "evt-dispute", claimId: "c1", status: "disputed", createdAt: "2026-06-23T00:00:00.0001Z" },
  { id: "evt-verify", claimId: "c1", status: "verified", evidenceIds: ["ev1"], createdAt: "2026-06-23T00:00:00.0002Z" },
];
const at = (v) => surface.deriveClaimStatus({ claim, evidence, events, policies, statusFunctionVersion: v }).status;
console.log(`${surface.statusFunctionVersion} 3=${at("3")} 4=${at("4")}`);
NODE
)"
if [ "$premise" = "4 3=disputed 4=verified" ]; then
  _pass "premise: Surface defaults to 4 and derives the fixture disputed under 3, verified under 4"
else
  _fail "premise changed (got: $premise); this test no longer separates the two status functions"
fi

STAMP3_DIR="$TMP/stamp3"
seed_repo "$STAMP3_DIR" "stamp3"
seed_stamped_bundle "$STAMP3_DIR/.kontourai/flow-agents/stamp3/trust.bundle" "stamp3" "flow-agents/workflow-sidecar;statusFunctionVersion=3"
set +e
stamp3_out="$(run_gate "$STAMP3_DIR")"
stamp3_exit="$?"
set -e
if [ "$stamp3_exit" -eq 2 ] && echo "$stamp3_out" | grep -q 'stored status "verified" does not match recompute "disputed"'; then
  _pass "a bundle stamped 3 is re-derived under 3: its stored verified is caught as a misassertion"
else
  _fail "a bundle stamped 3 was not re-derived under 3 (exit $stamp3_exit): $stamp3_out"
fi

STAMP4_DIR="$TMP/stamp4"
seed_repo "$STAMP4_DIR" "stamp4"
seed_stamped_bundle "$STAMP4_DIR/.kontourai/flow-agents/stamp4/trust.bundle" "stamp4" "flow-agents/workflow-sidecar;statusFunctionVersion=4"
set +e
stamp4_out="$(run_gate "$STAMP4_DIR")"
stamp4_exit="$?"
set -e
if [ "$stamp4_exit" -ne 2 ] && ! echo "$stamp4_out" | grep -qE "does not match recompute|cannot re-derive"; then
  _pass "the same bundle stamped 4 is honest and not blocked (exit $stamp4_exit)"
else
  _fail "a bundle stamped 4 was blocked (exit $stamp4_exit): $stamp4_out"
fi

# Same fail-closed class as "surface unavailable": FULL_BLOCK, so it blocks an in-progress
# (execution-phase) stop, which is where the gate decides whether work may end.
STAMP_BAD_DIR="$TMP/stamp-bad"
seed_repo "$STAMP_BAD_DIR" "stamp-bad"
printf '%s' '{"schema_version":"1.0","task_slug":"stamp-bad","status":"in_progress","phase":"execution","updated_at":"2026-06-23T00:00:00Z","next_action":{"status":"in_progress","summary":"Testing"}}' \
  > "$STAMP_BAD_DIR/.kontourai/flow-agents/stamp-bad/state.json"
seed_stamped_bundle "$STAMP_BAD_DIR/.kontourai/flow-agents/stamp-bad/trust.bundle" "stamp-bad" "flow-agents/workflow-sidecar;statusFunctionVersion=99"
set +e
bad_out="$(run_gate "$STAMP_BAD_DIR")"
bad_exit="$?"
set -e
if [ "$bad_exit" -eq 2 ] && echo "$bad_out" | grep -q "surface cannot re-derive this trust.bundle"; then
  _pass "a stamp the installed Surface cannot evaluate blocks instead of re-deriving under another version"
else
  _fail "an unevaluable stamp did not block with the re-derivation warning (exit $bad_exit): $bad_out"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
if [ "$errors" -eq 0 ]; then
  echo "Re-derive-at-gate hardening tests passed."
  exit 0
fi
echo "Re-derive-at-gate hardening tests FAILED: $errors issue(s)."
exit 1
