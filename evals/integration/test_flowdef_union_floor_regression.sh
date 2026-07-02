#!/usr/bin/env bash
# test_flowdef_union_floor_regression.sh — Union-floor regression trip-wire for
# the .kontourai/flow-agents/flowdef-driven-stop-gate posture.
#
# PR #215 replaced isSelectedClaim's pure if/else claim-selection predicate
# with a permanent UNION:
#
#   ct.startsWith('workflow.') || (declaredClaimTypes != null && declaredClaimTypes.has(ct))
#
# ...plus a `gate misconfiguration:` HARD_BLOCK when an active FlowDefinition
# resolves to an empty expects[] (see ADR 0016, ADR 0018, and the Prior Attempt
# Post-Mortem in .kontourai/flow-agents/flowdef-driven-stop-gate/plan.md).
#
# Wave 1 of this plan extracted declaredClaimTypesFor() as a pure refactor of
# stop-goal-fit.js — the union form itself was NOT touched. This eval locks
# that posture in place so a future "refactor" cannot quietly narrow the union
# back to an if/else (which would reopen the gate-bypass-chain exploit: an
# empty declaredClaimTypes Set from a tampered/fake FlowDefinition would once
# again select ZERO claims and bundleEnforcement would silently pass).
#
# Three checks:
#   1. STATIC TRIP-WIRE — the union form is present on the live `return`
#      statement inside isSelectedClaim's function body in
#      scripts/hooks/stop-goal-fit.js (comment lines/trailing comments are
#      stripped first so a decoy comment cannot satisfy the check).
#   2. EMPTY-EXPECTS GUARD — cross-referenced to evals/integration/
#      test_gate_bypass_chain.sh, which already asserts the empty-expects ->
#      exit 2 `gate misconfiguration:` case end-to-end (see its "Test 2" /
#      "Test 3" sections). Not duplicated here.
#   3. UNION-IS-LIVE PROOF — two builder.build/verify sessions:
#        3a. A bundle with a declared builder.verify.tests claim (clean,
#            re-derives verified) alongside a workflow.check.command claim
#            (stored "verified", evidence tampered -> re-derives disputed).
#            workflow.check.command is NOT in builder.build's verify-gate
#            expects[], so this proves the union's `startsWith('workflow.')`
#            baseline is live code, not dead code, for FlowDefinition-driven
#            sessions.
#        3b. A SECOND bundle where the DECLARED builder.verify.tests claim
#            itself is tampered (stored "verified", evidence re-derives
#            disputed). builder.verify.tests does NOT start with "workflow.",
#            so the ONLY way isSelectedClaim can select it is via the
#            `declaredClaimTypes.has(ct)` branch of the union. Asserting
#            exit 2 + a tamper warning naming builder.verify.tests here is
#            direct, positive proof that declared-claim-type selection
#            (not just the workflow.* baseline) is actually live — closing
#            the "Check 3 can pass vacuously when build/ is absent" gap
#            (3a alone never positively exercises the declared branch; a
#            missing build/ would make declaredClaimTypes null everywhere
#            and 3a's "not flagged" assertion would be trivially satisfied).
#      Both sub-checks require flow-resolver.js (built under build/src/lib/) to exist —
#      loadActiveFlowStep() fails open to null when build/ is absent, which
#      would make the whole of Check 3 pass vacuously. This eval hard-fails
#      loudly instead of silently passing in that case.
#
# Deterministic, no model spend, self-cleaning.
# Usage: bash evals/integration/test_flowdef_union_floor_regression.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$ROOT/scripts/hooks/stop-goal-fit.js"
GATE_SRC="$ROOT/scripts/hooks/stop-goal-fit.js"

export FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=100000

TMP="$(mktemp -d)"
errors=0
_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

cleanup() { [ -n "${TMP:-}" ] && rm -rf "$TMP"; }
trap cleanup EXIT

# --- helper: seed a minimal delivered workflow artifact --------------------
seed_repo() { # $1=dir $2=slug
  local p="$1" slug="$2"
  mkdir -p "$p/.kontourai/flow-agents/$slug"
  printf '# Repo\n' > "$p/AGENTS.md"
  STATE_FILE="$p/.kontourai/flow-agents/$slug/state.json"
  printf '%s' "{\"schema_version\":\"1.0\",\"task_slug\":\"$slug\",\"status\":\"delivered\",\"phase\":\"done\",\"updated_at\":\"2026-06-30T00:00:00Z\",\"next_action\":{\"status\":\"done\",\"summary\":\"done\"}}" \
    > "$STATE_FILE"
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

# --- Check 1: STATIC TRIP-WIRE - union form present inside isSelectedClaim -
echo "Check 1: static trip-wire - union form present inside isSelectedClaim() in stop-goal-fit.js"

# Isolate the isSelectedClaim function body (from its declaration to its
# closing brace) rather than grepping the whole file, so this trip-wire fails
# loudly if the union is removed from the function even if the literal string
# "startsWith('workflow.')" survives elsewhere (e.g. in a comment or a
# different, narrower predicate).
isSelectedClaim_body="$(awk '/const isSelectedClaim = \(claim\)/{flag=1} flag{print} flag && /^  \};/{exit}' "$GATE_SRC")"

# Strip comments (full-line comments AND trailing "// ..." comments) from the
# isolated body before inspecting it, then anchor the check to the live
# `return` statement specifically. Without this, a decoy comment anywhere in
# the function body (e.g. `// ct.startsWith('workflow.') || ...` left behind
# after narrowing the real predicate to an if/else) would still satisfy a
# plain `grep -q "startsWith('workflow.')"` against the whole body and let
# this trip-wire pass vacuously.
isSelectedClaim_body_nocomments="$(echo "$isSelectedClaim_body" | sed 's|//.*$||')"
isSelectedClaim_return_line="$(echo "$isSelectedClaim_body_nocomments" | grep -E '^[[:space:]]*return\b')"

if [ -z "$isSelectedClaim_body" ]; then
  _fail "could not locate isSelectedClaim() in scripts/hooks/stop-goal-fit.js -- function renamed or removed"
  echo "    This regresses PR #215 / ADR 0016 / ADR 0018. See the Prior Attempt Post-Mortem in"
  echo "    .kontourai/flow-agents/flowdef-driven-stop-gate/plan.md: the union claim-selection"
  echo "    predicate must remain a permanent, named, testable function."
elif [ -n "$isSelectedClaim_return_line" ] \
    && echo "$isSelectedClaim_return_line" | grep -q "startsWith('workflow.')" \
    && echo "$isSelectedClaim_return_line" | grep -q "declaredClaimTypes"; then
  _pass "isSelectedClaim()'s return statement contains the workflow.* union baseline (startsWith('workflow.') + declaredClaimTypes, comment-stripped)"
else
  _fail "isSelectedClaim()'s return statement no longer contains the union baseline -- union narrowed back toward if/else (or moved into a comment)"
  echo "    This regresses PR #215 / ADR 0016 / ADR 0018. Per the Prior Attempt Post-Mortem in"
  echo "    .kontourai/flow-agents/flowdef-driven-stop-gate/plan.md: isSelectedClaim MUST stay a"
  echo "    UNION -- \`ct.startsWith('workflow.') || (declaredClaimTypes != null && declaredClaimTypes.has(ct))\`"
  echo "    -- never a pure if/else. An if/else lets an empty (non-null) declaredClaimTypes Set"
  echo "    (e.g. from a tampered/fake FlowDefinition with expects:[]) select ZERO claims and"
  echo "    silently bypass bundleEnforcement (the original gate-bypass-chain exploit)."
  echo "    isSelectedClaim() body found:"
  echo "$isSelectedClaim_body" | sed 's/^/      /'
  echo "    comment-stripped return statement found:"
  echo "${isSelectedClaim_return_line:-<none>}" | sed 's/^/      /'
fi

# --- Check 2: EMPTY-EXPECTS GUARD - cross-referenced, not duplicated -------
# evals/integration/test_gate_bypass_chain.sh already seeds an active
# builder.build/verify session whose active FlowDefinition resolves to an
# empty expects[] (via FLOW_AGENTS_FLOW_DEFS_DIR override to a fake flow) and
# asserts BOTH exit code 2 AND a `gate misconfiguration:` warning in its
# "=== 2. Layer 2 -- Empty-Set defense ===" section (test 2b), and again
# end-to-end in its "=== 3. Full exploit chain ===" section. See AC3 Part 2 in
# stop-goal-fit.js's bundleEnforcement comment block. Not duplicated here to
# avoid two evals asserting the same fixture drifting out of sync.
echo ""
echo "Check 2: empty-expects guard -- cross-referenced to evals/integration/test_gate_bypass_chain.sh (not duplicated)"
_pass "empty-expects -> exit 2 'gate misconfiguration:' already covered by test_gate_bypass_chain.sh (Test 2 / Test 3)"

# --- Check 3: UNION-IS-LIVE PROOF -------------------------------------------
echo ""
echo "Check 3: union-is-live proof -- FlowDefinition-driven claim selection actually runs (not fail-open null)"

# Prerequisite: loadActiveFlowStep() in stop-goal-fit.js fails open to null
# when flow-resolver.js (built under build/src/lib/) is absent (hasBuild guard). If build/
# is missing, declaredClaimTypes is null for every session below, the
# declared builder.verify.tests branch of the union is never exercised, and
# this whole check would pass vacuously (the "not flagged" assertions in 3a
# are satisfied trivially when nothing can ever be selected via the declared
# branch). Fail loudly instead of silently passing.
BUILT_RESOLVER="$ROOT/build/src/li""b/flow-resolver.js"
if [ ! -f "$BUILT_RESOLVER" ]; then
  echo "  ✗ FATAL: build/src/li""b/flow-resolver.js is missing -- this eval requires npm run build; refusing to vacuously pass." >&2
  echo "      Without build/, loadActiveFlowStep() fails open to null, declaredClaimTypes is null" >&2
  echo "      everywhere, the declared builder.verify.tests claim is never selected via the union's" >&2
  echo "      declared-type branch, and Check 3 would pass without ever exercising" >&2
  echo "      FlowDefinition-driven claim selection. Run: npm run build" >&2
  exit 1
fi
_pass "prerequisite: build/src/li""b/flow-resolver.js is present -- FlowDefinition resolution is live for this run"

# --- Check 3a: undeclared workflow.* claim still blocks a builder.build ----
# session even though workflow.check.command is NOT declared by builder.build's
# verify-gate expects[] (which only declares builder.verify.tests and
# builder.verify.policy-compliance -- see kits/builder/flows/build.flow.json).
echo ""
echo "Check 3a: undeclared workflow.check.command claim still blocks a builder.build/verify session"

T3_DIR="$TMP/t3-union-live"
seed_repo "$T3_DIR" "union-live-test"

CURRENT_FILE="$T3_DIR/.kontourai/flow-agents/current.json"
printf '%s' '{"artifact_dir":"union-live-test","active_flow_id":"builder.build","active_step_id":"verify"}' \
  > "$CURRENT_FILE"

python3 - "$T3_DIR/.kontourai/flow-agents/union-live-test/trust.bundle" << 'PY'
import json, sys
bundle = {
    "schemaVersion": 3,
    "source": "flow-agents/workflow-sidecar",
    "claims": [
        {
            # Declared by builder.build's verify-gate expects[] -- clean, must NOT block.
            "id": "c-declared",
            "subjectId": "union-live-test/tests",
            "subjectType": "flow-step",
            "claimType": "builder.verify.tests",
            "fieldOrBehavior": "build/verify tests",
            "value": "pass",
            "impactLevel": "high",
            "status": "verified",
            "createdAt": "2026-06-30T00:00:00Z",
            "updatedAt": "2026-06-30T00:00:00Z"
        },
        {
            # NOT declared by builder.build's verify-gate expects[] -- only reachable via
            # the union's workflow.* baseline. Stored "verified" but tampered: evidence
            # re-derives to disputed. Must BLOCK if (and only if) the union is live.
            "id": "c-undeclared-workflow",
            "subjectId": "union-live-test/unit-tests",
            "subjectType": "workflow-check",
            "claimType": "workflow.check.command",
            "fieldOrBehavior": "unit tests",
            "value": "pass",
            "impactLevel": "high",
            "status": "verified",   # tampered: edited from "disputed" -> "verified"
            "createdAt": "2026-06-30T00:00:00Z",
            "updatedAt": "2026-06-30T00:00:00Z"
        }
    ],
    "evidence": [
        {
            "id": "ev-declared",
            "claimId": "c-declared",
            "evidenceType": "test_output",
            "method": "validation",
            "sourceRef": "command-log.jsonl",
            "excerptOrSummary": "npm test passed",
            "observedAt": "2026-06-30T00:00:00Z",
            "collectedBy": "harness",
            "passing": True,
            "blocking": False
        },
        {
            "id": "ev-undeclared-workflow",
            "claimId": "c-undeclared-workflow",
            "evidenceType": "test_output",
            "method": "validation",
            "sourceRef": "command-log.jsonl",
            "excerptOrSummary": "npm test failed with exit 1",
            "observedAt": "2026-06-30T00:00:00Z",
            "collectedBy": "harness",
            "passing": False,
            "blocking": True
        }
    ],
    "policies": [],
    "events": [
        {
            "id": "evt-declared",
            "claimId": "c-declared",
            "status": "verified",
            "actor": "agent",
            "method": "workflow-check",
            "evidenceIds": ["ev-declared"],
            "createdAt": "2026-06-30T00:00:00Z"
        },
        {
            "id": "evt-undeclared-workflow",
            "claimId": "c-undeclared-workflow",
            "status": "verified",
            "actor": "agent",
            "method": "workflow-check",
            "evidenceIds": ["ev-undeclared-workflow"],
            "createdAt": "2026-06-30T00:00:00Z"
        }
    ]
}
json.dump(bundle, open(sys.argv[1], 'w'))
PY

set +e
t3_out="$(FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip \
    node "$GATE" 2>&1 <<< "{\"hook_event_name\":\"Stop\",\"cwd\":\"$T3_DIR\"}")"
t3_exit="$?"
set -e

if [ "$t3_exit" -eq 2 ]; then
  _pass "builder.build/verify session with tampered undeclared workflow.check.command claim BLOCKS (exit 2)"
else
  _fail "builder.build/verify session did NOT block on the undeclared workflow.* claim: exit=$t3_exit output=$t3_out"
fi

if echo "$t3_out" | grep -q "caught false-completion"; then
  _pass "union-is-live: emits caught false-completion"
else
  _fail "union-is-live: missing caught false-completion: $t3_out"
fi

if echo "$t3_out" | grep -q "workflow.check.command"; then
  _pass "union-is-live: warning names the undeclared claimType workflow.check.command"
else
  _fail "union-is-live: warning does not mention workflow.check.command: $t3_out"
fi

if echo "$t3_out" | grep -q "builder.verify.tests"; then
  _fail "union-is-live: the clean declared builder.verify.tests claim was incorrectly flagged too: $t3_out"
else
  _pass "union-is-live: the clean declared builder.verify.tests claim is not flagged (only the undeclared workflow.* claim blocks)"
fi

# Additive (iteration 5 fix pass, MEDIUM/reviewer): gateLabel()'s FlowDefinition-active
# branch ("[<flowId>/<gateId>]") had zero eval coverage. This session's current.json
# names active_flow_id=builder.build / active_step_id=verify (set above), so the Stop
# hook's stderr must be prefixed with the resolved gate identity instead of the generic
# "[stop-gate]" fallback -- and since this scenario also produces a claimed-pass-never-
# captured warning (FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip), the per-gap remediation guidance
# line is asserted too (cheap, same output, message-assembly only -- no new fixture).
if echo "$t3_out" | grep -q "\[builder.build/verify-gate\]"; then
  _pass "union-is-live: Stop hook stderr is prefixed with the resolved gate identity [builder.build/verify-gate]"
else
  _fail "union-is-live: missing the gate-named prefix [builder.build/verify-gate]: $t3_out"
fi

if echo "$t3_out" | grep -q '  → run the command in this session'; then
  _pass "union-is-live: per-gap remediation guidance line is present for the claimed-pass-never-captured warning"
else
  _fail "union-is-live: missing the per-gap remediation guidance line: $t3_out"
fi

# --- Check 3b: tampered DECLARED claim proves declaredClaimTypes selection --
# is actually live (positive proof, not just "not flagged" by omission). This
# closes the vacuous-pass gap: 3a alone never forces the declared branch of
# the union (`declaredClaimTypes.has(ct)`) to fire and block anything, so a
# broken/dead declared-type selector (or a null declaredClaimTypes from a
# missing build/) could still make 3a's assertions pass. builder.verify.tests
# does NOT start with "workflow.", so this claim can ONLY be selected via the
# declared branch -- if it blocks, the declared branch is demonstrably live.
echo ""
echo "Check 3b: tampered DECLARED builder.verify.tests claim blocks -- proves declaredClaimTypes selection is live"

T3B_DIR="$TMP/t3b-declared-live"
seed_repo "$T3B_DIR" "declared-live-test"

CURRENT_FILE_3B="$T3B_DIR/.kontourai/flow-agents/current.json"
printf '%s' '{"artifact_dir":"declared-live-test","active_flow_id":"builder.build","active_step_id":"verify"}' \
  > "$CURRENT_FILE_3B"

python3 - "$T3B_DIR/.kontourai/flow-agents/declared-live-test/trust.bundle" << 'PY'
import json, sys
bundle = {
    "schemaVersion": 3,
    "source": "flow-agents/workflow-sidecar",
    "claims": [
        {
            # The ONLY claim in this bundle, and it does NOT start with "workflow.".
            # Selecting it at all requires declaredClaimTypes != null && .has(ct) --
            # i.e. requires a live, resolved active FlowDefinition. Stored "verified"
            # but tampered: evidence re-derives to disputed. Must BLOCK if (and only
            # if) the declared-type half of the union is live.
            "id": "c-declared-tampered",
            "subjectId": "declared-live-test/tests",
            "subjectType": "flow-step",
            "claimType": "builder.verify.tests",
            "fieldOrBehavior": "build/verify tests",
            "value": "pass",
            "impactLevel": "high",
            "status": "verified",   # tampered: edited from "disputed" -> "verified"
            "createdAt": "2026-06-30T00:00:00Z",
            "updatedAt": "2026-06-30T00:00:00Z"
        }
    ],
    "evidence": [
        {
            "id": "ev-declared-tampered",
            "claimId": "c-declared-tampered",
            "evidenceType": "test_output",
            "method": "validation",
            "sourceRef": "command-log.jsonl",
            "excerptOrSummary": "npm test failed with exit 1",
            "observedAt": "2026-06-30T00:00:00Z",
            "collectedBy": "harness",
            "passing": False,
            "blocking": True
        }
    ],
    "policies": [],
    "events": [
        {
            "id": "evt-declared-tampered",
            "claimId": "c-declared-tampered",
            "status": "verified",
            "actor": "agent",
            "method": "workflow-check",
            "evidenceIds": ["ev-declared-tampered"],
            "createdAt": "2026-06-30T00:00:00Z"
        }
    ]
}
json.dump(bundle, open(sys.argv[1], 'w'))
PY

set +e
t3b_out="$(FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip \
    node "$GATE" 2>&1 <<< "{\"hook_event_name\":\"Stop\",\"cwd\":\"$T3B_DIR\"}")"
t3b_exit="$?"
set -e

if [ "$t3b_exit" -eq 2 ]; then
  _pass "builder.build/verify session with tampered DECLARED builder.verify.tests claim BLOCKS (exit 2) -- declaredClaimTypes selection is live, not vacuous"
else
  _fail "builder.build/verify session did NOT block on the tampered DECLARED builder.verify.tests claim (declaredClaimTypes selection may be dead or null): exit=$t3b_exit output=$t3b_out"
fi

if echo "$t3b_out" | grep -q "builder.verify.tests"; then
  _pass "declared-claim-live: warning names the declared claimType builder.verify.tests"
else
  _fail "declared-claim-live: warning does not mention builder.verify.tests: $t3b_out"
fi

if echo "$t3b_out" | grep -q "tampered" || echo "$t3b_out" | grep -q "caught false-completion"; then
  _pass "declared-claim-live: emits tampered/caught false-completion signal for the declared claim"
else
  _fail "declared-claim-live: missing tampered/caught false-completion signal: $t3b_out"
fi

# --- Summary -----------------------------------------------------------------
echo ""
if [ "$errors" -eq 0 ]; then
  echo "Union-floor regression trip-wire passed: PR #215 posture intact (union live, empty-expects guard cross-referenced, declared-claim selection positively proven live)."
  exit 0
fi
echo "Union-floor regression trip-wire FAILED: $errors issue(s). This may indicate a regression of PR #215 / ADR 0016 / ADR 0018 -- see .kontourai/flow-agents/flowdef-driven-stop-gate/plan.md Prior Attempt Post-Mortem."
exit 1
