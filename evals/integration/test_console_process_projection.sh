#!/usr/bin/env bash
# test_console_process_projection.sh - Console process-state projection contract (issue #778):
# workflow-state -> Console interactive-session process state mapping (needs_input,
# review_pending via AUTHORITATIVE trust.bundle critique state, blocked + blockedReason),
# join-key identity guards (handoff.json / trust.bundle critique refs), the Console-matching
# default kontour root, non-mutation guard, and determinism.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

FIXTURE_DIR="$ROOT/evals/fixtures/console-process-projection"
TMPDIR_EVAL="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/eval-console-process-projection.XXXXXX")" && pwd -P)"
ARTIFACT_ROOT="$TMPDIR_EVAL/artifacts"
KONTOUR_ROOT="$TMPDIR_EVAL/.kontour-explicit"
GENERATED_AT="2026-07-20T12:00:00Z"
PROJECTION="$KONTOUR_ROOT/projections/flow-agents-process/repo-fixture-repo.json"
pass=0
fail=0

cleanup() {
  rm -rf "$TMPDIR_EVAL"
}
trap cleanup EXIT

_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }

echo "=== Layer 2: Console Process Projection ==="
echo ""

mkdir -p "$ARTIFACT_ROOT"
cp -R "$FIXTURE_DIR/artifacts/." "$ARTIFACT_ROOT/"

if flow_agents_build_ts 2>"$TMPDIR_EVAL/build.err"; then
  _pass "TypeScript CLI build is available"
else
  _fail "TypeScript CLI build failed: $(cat "$TMPDIR_EVAL/build.err" 2>/dev/null)"
fi

SIDECAR_NAME="state.json"
BUNDLE_NAME="trust.bundle"
find "$ARTIFACT_ROOT" \( -name "$SIDECAR_NAME" -o -name "$BUNDLE_NAME" \) -type f -print0 | sort -z | xargs -0 shasum -a 256 >"$TMPDIR_EVAL/before.sha"

if node "$ROOT/build/src/cli.js" console-process-projection \
  --artifact-root "$ARTIFACT_ROOT" \
  --kontour-root "$KONTOUR_ROOT" \
  --scope fixture-repo \
  --scope-kind repo \
  --producer flow-agents-process \
  --generated-at "$GENERATED_AT" \
  --json >"$TMPDIR_EVAL/run.json" 2>"$TMPDIR_EVAL/run.err"; then
  _pass "CLI writes projection from fixture artifact root"
else
  _fail "CLI failed: $(cat "$TMPDIR_EVAL/run.err" 2>/dev/null)"
fi

if [[ -f "$PROJECTION" ]]; then
  _pass "projection file exists at expected producer and scope path"
else
  _fail "projection file missing at $PROJECTION"
fi

find "$ARTIFACT_ROOT" \( -name "$SIDECAR_NAME" -o -name "$BUNDLE_NAME" \) -type f -print0 | sort -z | xargs -0 shasum -a 256 >"$TMPDIR_EVAL/after.sha"
if cmp -s "$TMPDIR_EVAL/before.sha" "$TMPDIR_EVAL/after.sha"; then
  _pass "source workflow-state sidecars and trust.bundle files are never mutated by the projector"
else
  _fail "source workflow-state sidecars or trust.bundle changed after running the projector"
fi

if jq -e '.scanned_state_file_count == 7' "$TMPDIR_EVAL/run.json" >/dev/null 2>&1; then
  _pass "JSON summary reports 7 scanned workflow-state fixtures"
else
  _fail "JSON summary scanned_state_file_count unexpected: $(cat "$TMPDIR_EVAL/run.json" 2>/dev/null)"
fi

echo ""
echo "--- Projection Contract ---"

if jq -e --arg generated "$GENERATED_AT" '
  .schema == "kontour.console.projection" and
  .version == "0.1" and
  .generatedAt == $generated and
  .scope == {"kind":"repo","id":"fixture-repo"} and
  .producer == {"id":"flow-agents-process","product":"flow-agents"} and
  .derivedFrom.mode == "direct_snapshot" and
  .derivedFrom.eventHistory == "unavailable" and
  (.processes | length) == 7 and
  all(.processes[]; .family == "workflow" and .nonAuthority == true)
' "$PROJECTION" >/dev/null 2>&1; then
  _pass "projection envelope includes Console schema/scope/producer/provenance and 7 non-authoritative workflow processes"
else
  _fail "projection envelope is missing required Console contract fields"
fi

echo ""
echo "--- Status Mapping Table Coverage (issue #778 AC) ---"

if jq -e '
  .processes[] | select(.extensions["flow-agents"].task_slug == "session-blocked") |
  .status == "blocked" and
  .blockedReason == "Upstream API credentials not provisioned; CI runner quota exhausted"
' "$PROJECTION" >/dev/null 2>&1; then
  _pass "workflow status blocked -> Console status blocked, blockedReason sourced from handoff.json blockers (joined)"
else
  _fail "session-blocked did not project to blocked with the expected joined blockedReason"
fi

if jq -e '
  .processes[] | select(.extensions["flow-agents"].task_slug == "session-needs-decision") |
  .status == "needs_input" and
  .blockedReason == "Choose between approach A and approach B before continuing."
' "$PROJECTION" >/dev/null 2>&1; then
  _pass "workflow status needs_decision -> Console status needs_input, blockedReason sourced from next_action.summary"
else
  _fail "session-needs-decision did not project to needs_input with the expected blockedReason"
fi

if jq -e '
  .processes[] | select(.extensions["flow-agents"].task_slug == "session-running") |
  .status == "running" and (has("blockedReason") | not)
' "$PROJECTION" >/dev/null 2>&1; then
  _pass "workflow status in_progress -> Console status running, with no blockedReason emitted"
else
  _fail "session-running did not project to running with no blockedReason"
fi

echo ""
echo "--- review_pending reads the AUTHORITATIVE trust.bundle, never critique.json (review finding 1) ---"

if jq -e '
  .processes[] | select(.extensions["flow-agents"].task_slug == "session-review-pending") |
  .status == "review_pending" and
  .extensions["flow-agents"].has_unresolved_critique == true and
  (.blockedReason | test("trust\\.bundle")) and
  (.blockedReason | test("critique\\.json") | not)
' "$PROJECTION" >/dev/null 2>&1; then
  _pass "a live, non-passing trust.bundle critique claim -> Console status review_pending (blockedReason references trust.bundle, not critique.json)"
else
  _fail "session-review-pending did not project to review_pending from its trust.bundle critique claim"
fi

if jq -e '
  .processes[] | select(.extensions["flow-agents"].task_slug == "session-review-resolved") |
  .status == "running" and
  .extensions["flow-agents"].has_unresolved_critique == false and
  (has("blockedReason") | not)
' "$PROJECTION" >/dev/null 2>&1; then
  _pass "NEGATIVE: a superseded (resolved) critique claim does NOT yield review_pending even though its own verdict was fail"
else
  _fail "session-review-resolved incorrectly carried review_pending / an unresolved-critique signal from its SUPERSEDED prior critique"
fi

echo ""
echo "--- Join-key identity guards (review finding 3): mismatched sidecars are skipped, not trusted ---"

if jq -e '
  .processes[] | select(.extensions["flow-agents"].task_slug == "session-critique-mismatch") |
  .status == "running" and
  .extensions["flow-agents"].has_unresolved_critique == false
' "$PROJECTION" >/dev/null 2>&1; then
  _pass "NEGATIVE: a trust.bundle critique whose workflow_subject_ref names a DIFFERENT session does not force review_pending"
else
  _fail "session-critique-mismatch was wrongly driven to review_pending by another session's critique claim"
fi

if grep -q "session-critique-mismatch" "$TMPDIR_EVAL/run.err" && grep -q "some-other-session" "$TMPDIR_EVAL/run.err"; then
  _pass "a mismatched trust.bundle critique workflow_subject_ref is reported as a loud warning, not silently trusted or silently dropped"
else
  _fail "no warning was reported for the critique workflow_subject_ref mismatch: $(cat "$TMPDIR_EVAL/run.err" 2>/dev/null)"
fi

if jq -e '
  .processes[] | select(.extensions["flow-agents"].task_slug == "session-handoff-mismatch") |
  .status == "blocked" and
  .blockedReason == "This session'"'"'s own next_action.summary is the honest fallback reason." and
  (.blockedReason | test("must never leak") | not)
' "$PROJECTION" >/dev/null 2>&1; then
  _pass "NEGATIVE: a handoff.json whose own task_slug disagrees with its directory's state.json is never trusted for blockedReason"
else
  _fail "session-handoff-mismatch leaked a foreign handoff.json's blockers into blockedReason"
fi

if grep -q "session-handoff-mismatch" "$TMPDIR_EVAL/run.err" && grep -q "some-other-slug" "$TMPDIR_EVAL/run.err"; then
  _pass "a mismatched handoff.json task_slug is reported as a loud warning, not silently trusted"
else
  _fail "no warning was reported for the handoff.json task_slug mismatch: $(cat "$TMPDIR_EVAL/run.err" 2>/dev/null)"
fi

if jq -e '(.warnings | length) == 2' "$TMPDIR_EVAL/run.json" >/dev/null 2>&1; then
  _pass "JSON summary's warnings array reports exactly the 2 expected join-key mismatches"
else
  _fail "JSON summary warnings array unexpected: $(jq -c '.warnings' "$TMPDIR_EVAL/run.json" 2>/dev/null)"
fi

echo ""
echo "--- Default kontour root matches Console's actual local runtime root (review finding 4) ---"

DEFAULT_KONTOUR_PROJECTION="$ARTIFACT_ROOT/../default-cwd/.kontourai/console/projections/flow-agents-process/repo-default-scope.json"
mkdir -p "$ARTIFACT_ROOT/../default-cwd"
if (cd "$ARTIFACT_ROOT/../default-cwd" && node "$ROOT/build/src/cli.js" console-process-projection \
  --artifact-root "$ARTIFACT_ROOT" \
  --scope default-scope \
  --scope-kind repo \
  --generated-at "$GENERATED_AT" \
  --json >"$TMPDIR_EVAL/default-run.json" 2>"$TMPDIR_EVAL/default-run.err"); then
  _pass "CLI runs with no --kontour-root override"
else
  _fail "CLI failed with default --kontour-root: $(cat "$TMPDIR_EVAL/default-run.err" 2>/dev/null)"
fi

if [[ -f "$DEFAULT_KONTOUR_PROJECTION" ]]; then
  _pass "with no --kontour-root override, the projection lands under .kontourai/console/projections/ (Console's actual local runtime root), not the retired .kontour/ tree"
else
  _fail "projection did not land under the expected .kontourai/console/projections/ default path"
fi

if [[ ! -e "$ARTIFACT_ROOT/../default-cwd/.kontour" ]]; then
  _pass "the retired .kontour/ tree is never created by a default (no-override) run"
else
  _fail "a default run still created the retired .kontour/ tree"
fi

echo ""
echo "--- Determinism ---"

cp "$PROJECTION" "$TMPDIR_EVAL/projection-first.json"
if node "$ROOT/build/src/cli.js" console-process-projection \
  --artifact-root "$ARTIFACT_ROOT" \
  --kontour-root "$KONTOUR_ROOT" \
  --scope fixture-repo \
  --scope-kind repo \
  --producer flow-agents-process \
  --generated-at "$GENERATED_AT" \
  --json >"$TMPDIR_EVAL/run-second.json" 2>"$TMPDIR_EVAL/run-second.err"; then
  if cmp -s "$TMPDIR_EVAL/projection-first.json" "$PROJECTION"; then
    _pass "projection output is byte-stable with fixed generated-at"
  else
    _fail "projection output changed across fixed-timestamp runs"
  fi
else
  _fail "second deterministic run failed: $(cat "$TMPDIR_EVAL/run-second.err" 2>/dev/null)"
fi

echo ""
echo "Passed: $pass, Failed: $fail"
if [[ $fail -gt 0 ]]; then
  exit 1
fi
exit 0
