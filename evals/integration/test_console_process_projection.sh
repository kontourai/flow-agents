#!/usr/bin/env bash
# test_console_process_projection.sh - Console process-state projection contract (issue #778):
# workflow-state -> Console interactive-session process state mapping (needs_input,
# review_pending, blocked + blockedReason), non-mutation guard, and determinism.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

FIXTURE_DIR="$ROOT/evals/fixtures/console-process-projection"
TMPDIR_EVAL="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/eval-console-process-projection.XXXXXX")" && pwd -P)"
ARTIFACT_ROOT="$TMPDIR_EVAL/artifacts"
KONTOUR_ROOT="$TMPDIR_EVAL/.kontour"
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
find "$ARTIFACT_ROOT" -name "$SIDECAR_NAME" -type f -print0 | sort -z | xargs -0 shasum -a 256 >"$TMPDIR_EVAL/before.sha"

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

find "$ARTIFACT_ROOT" -name "$SIDECAR_NAME" -type f -print0 | sort -z | xargs -0 shasum -a 256 >"$TMPDIR_EVAL/after.sha"
if cmp -s "$TMPDIR_EVAL/before.sha" "$TMPDIR_EVAL/after.sha"; then
  _pass "source workflow-state sidecars are never mutated by the projector"
else
  _fail "source workflow-state sidecars changed after running the projector"
fi

if jq -e '.scanned_state_file_count == 4' "$TMPDIR_EVAL/run.json" >/dev/null 2>&1; then
  _pass "JSON summary reports 4 scanned workflow-state fixtures"
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
  (.processes | length) == 4 and
  all(.processes[]; .family == "workflow" and .nonAuthority == true)
' "$PROJECTION" >/dev/null 2>&1; then
  _pass "projection envelope includes Console schema/scope/producer/provenance and 4 non-authoritative workflow processes"
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
  .processes[] | select(.extensions["flow-agents"].task_slug == "session-review-pending") |
  .status == "review_pending" and
  (.blockedReason | test("critique\\.json"))
' "$PROJECTION" >/dev/null 2>&1; then
  _pass "a required pending critique.json overrides workflow status verifying -> Console status review_pending"
else
  _fail "session-review-pending did not project to review_pending"
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
