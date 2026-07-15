#!/usr/bin/env bash
# test_plain_stop_messaging.sh — plain-language stop-hook lead (#659 Slice A+B)
#
# The Builder stop-hook (scripts/hooks/stop-goal-fit.js) prepends a plain-English
# summary to its output so a human — not only an agent — can tell what is paused
# and what their options are. This proves the `plainStopLead` helper:
#   - returns null when there is no active Builder run to explain (no lead noise
#     on unrelated goal-fit warnings);
#   - for an active run, names the task, translates the Flow step to plain words
#     (Slice B vocabulary), states the number of pending sign-offs and the two
#     options (finish / cancel), and lists the pending expectations in plain
#     terms;
#   - never leaks internal vocabulary (`verify-gate`, `clean-critique`, raw
#     expectation IDs) into the human lead.
#
# Presentation-only: the helper reads the same `result` the technical block is
# built from and never mutates it, so reasonsHash / block-dedup / HARD_BLOCK are
# unaffected (covered by the existing goal-fit hook tests).
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$ROOT_DIR/scripts/hooks/stop-goal-fit.js"

pass=0; fail=0
_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }

echo "=== Plain-language stop-hook lead (#659) ==="
echo ""

if [[ ! -f "$HOOK" ]]; then
  _fail "stop-goal-fit.js not found at $HOOK"
  exit 1
fi

# Drive plainStopLead directly (deterministic, no ambient-session/actor coupling).
run_case() {
  node -e '
    const { plainStopLead } = require(process.argv[1]);
    const result = JSON.parse(process.argv[2]);
    const gap = process.argv[3] === "null" ? undefined : Number(process.argv[3]);
    const out = plainStopLead(result, gap);
    process.stdout.write(out === null ? "NULL" : out);
  ' "$HOOK" "$2" "$3" 2>/dev/null
}

# --- 1. No active Builder run → null (no lead) --------------------------------
echo "--- no active Builder run yields no lead ---"
out=$(run_case "x" '{"activeFlowRun":false}' 3)
[[ "$out" == "NULL" ]] && _pass "returns null when there is no active run to explain" || _fail "expected null, got: $out"

# --- 2. Active verify run: full plain lead ------------------------------------
echo ""
echo "--- active verify run: names task, plain step, count, options, pending list ---"
VERIFY_RESULT='{"activeFlowRun":true,"activeFlowCurrentStep":"verify","latestArtifactDir":"/x/.kontourai/flow-agents/kontourai-flow-agents-568","warnings":["kontourai-flow-agents-568 next action: Complete verify-gate by recording: clean-critique (workflow.critique.review), acceptance-criteria (workflow.acceptance.criterion), tests-evidence (builder.verify.tests)"]}'
out=$(run_case "x" "$VERIFY_RESULT" 5)
grep -q 'kontourai-flow-agents-568' <<<"$out" && _pass "names the paused task" || _fail "missing task name: $out"
grep -q 'final review' <<<"$out" && _pass "translates 'verify' step to 'final review' (Slice B)" || _fail "missing plain step phrase: $out"
grep -q '5 sign-offs' <<<"$out" && _pass "states the number of pending sign-offs (5)" || _fail "missing gap count: $out"
grep -qi 'cancel the run to close it now' <<<"$out" && _pass "offers the cancel option in plain terms" || _fail "missing cancel option: $out"
grep -q 'let it finish those checks' <<<"$out" && _pass "offers the finish option in plain terms" || _fail "missing finish option: $out"
grep -q 'a reviewer sign-off' <<<"$out" && _pass "lists 'a reviewer sign-off' (clean-critique translated)" || _fail "missing reviewer sign-off: $out"
grep -q 'the acceptance checks' <<<"$out" && _pass "lists 'the acceptance checks' (acceptance-criteria translated)" || _fail "missing acceptance checks: $out"
grep -q 'test results' <<<"$out" && _pass "lists 'test results' (tests-evidence translated)" || _fail "missing test results: $out"
grep -q 'Nothing else' <<<"$out" && _pass "reassures nothing else is blocked" || _fail "missing reassurance: $out"

# --- 3. No internal vocabulary leaks into the human lead ----------------------
echo ""
echo "--- the human lead never leaks internal vocabulary ---"
! grep -q 'verify-gate' <<<"$out" && _pass "does not leak 'verify-gate'" || _fail "leaked 'verify-gate': $out"
! grep -q 'clean-critique' <<<"$out" && _pass "does not leak 'clean-critique'" || _fail "leaked 'clean-critique': $out"
! grep -q 'workflow.critique.review' <<<"$out" && _pass "does not leak raw expectation IDs" || _fail "leaked raw expectation ID: $out"

# --- 4. Unknown step falls back gracefully; no false 'Still needed' -----------
echo ""
echo "--- unknown step + no recognizable expectations: graceful fallback ---"
UNK='{"activeFlowRun":true,"activeFlowCurrentStep":"some-new-step","latestArtifactDir":"/x/.kontourai/flow-agents/my-task","warnings":["my-task workflow state: canonical Flow run remains active"]}'
out=$(run_case "x" "$UNK" 2)
grep -q 'the "some-new-step" step' <<<"$out" && _pass "unknown step falls back to a quoted step name" || _fail "missing step fallback: $out"
grep -q '2 sign-offs' <<<"$out" && _pass "count still reported for unknown step" || _fail "missing count: $out"
! grep -q 'Still needed' <<<"$out" && _pass "omits the 'Still needed' list when no expectations are recognizable (no fabrication)" || _fail "fabricated a pending list: $out"

# --- 5. Singular grammar for a single sign-off --------------------------------
echo ""
echo "--- singular grammar for a single pending sign-off ---"
out=$(run_case "x" "$VERIFY_RESULT" 1)
grep -q '1 sign-off ' <<<"$out" && _pass "uses singular '1 sign-off'" || _fail "expected singular '1 sign-off': $out"

echo ""
echo "Plain-language stop messaging: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
