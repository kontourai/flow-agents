#!/usr/bin/env bash
# test_console_learning_projection.sh - Console learning projection contract and non-mutation guard
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

FIXTURE_DIR="$ROOT/evals/fixtures/console-learning-projection"
TMPDIR_EVAL="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/eval-console-learning-projection.XXXXXX")" && pwd -P)"
ARTIFACT_ROOT="$TMPDIR_EVAL/artifacts"
KONTOUR_ROOT="$TMPDIR_EVAL/.kontour"
GENERATED_AT="2026-06-06T20:00:00Z"
PROJECTION="$KONTOUR_ROOT/projections/flow-agents-learning/repo-fixture-repo.json"
pass=0
fail=0

cleanup() {
  rm -rf "$TMPDIR_EVAL"
}
trap cleanup EXIT

_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }

echo "=== Layer 2: Console Learning Projection ==="
echo ""

mkdir -p "$ARTIFACT_ROOT"
cp -R "$FIXTURE_DIR/artifacts/." "$ARTIFACT_ROOT/"

if flow_agents_build_ts 2>"$TMPDIR_EVAL/build.err"; then
  _pass "TypeScript CLI build is available"
else
  _fail "TypeScript CLI build failed: $(cat "$TMPDIR_EVAL/build.err" 2>/dev/null)"
fi

find "$ARTIFACT_ROOT" -name learning.json -type f -print0 | sort -z | xargs -0 shasum -a 256 >"$TMPDIR_EVAL/before.sha"

cp "$PROJECTION" "$TMPDIR_EVAL/projection-first.json" 2>/dev/null || true
if node "$ROOT/build/src/cli.js" console-learning-projection \
  --artifact-root "$ARTIFACT_ROOT" \
  --kontour-root "$KONTOUR_ROOT" \
  --scope fixture-repo \
  --scope-kind repo \
  --producer flow-agents-learning \
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

if jq -e --arg path "$PROJECTION" \
  '.scanned_learning_file_count == 2 and .emitted_learning_count == 2 and .destination == $path and .producer == "flow-agents-learning" and .scope == {"kind":"repo","id":"fixture-repo"} and .dry_run == false' \
  "$TMPDIR_EVAL/run.json" >/dev/null 2>&1; then
  _pass "JSON summary reports scanned files, emitted learnings, scope, producer, and destination"
else
  _fail "JSON summary missing expected command result"
fi

cp "$PROJECTION" "$TMPDIR_EVAL/projection-first.json" 2>/dev/null || true
if node "$ROOT/build/src/cli.js" console-learning-projection \
  --artifact-root "$ARTIFACT_ROOT" \
  --kontour-root "$KONTOUR_ROOT" \
  --scope fixture-repo \
  --scope-kind repo \
  --producer flow-agents-learning \
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

find "$ARTIFACT_ROOT" -name learning.json -type f -print0 | sort -z | xargs -0 shasum -a 256 >"$TMPDIR_EVAL/after.sha"
if cmp -s "$TMPDIR_EVAL/before.sha" "$TMPDIR_EVAL/after.sha"; then
  _pass "source learning.json files are byte-for-byte unchanged"
else
  _fail "source learning.json checksum changed after projection command"
fi

echo ""
echo "--- Projection Contract ---"

if jq -e --arg generated "$GENERATED_AT" '
  .schema == "kontour.console.projection" and
  .version == "0.1" and
  .generatedAt == $generated and
  .scope == {"kind":"repo","id":"fixture-repo"} and
  .producer == {"id":"flow-agents-learning","product":"flow-agents"} and
  .derivedFrom.mode == "direct_snapshot" and
  .derivedFrom.eventHistory == "unavailable" and
  .derivedFrom.directSnapshot.emittedAt == $generated and
  .derivedFrom.directSnapshot.producer == {"id":"flow-agents-learning","product":"flow-agents"} and
  .derivedFrom.directSnapshot.sourceRef == {"product":"flow-agents","kind":"workflow-learning","id":".flow-agents/*/learning.json","label":"Local workflow learning sidecars"} and
  (.learnings | length) == 2
' "$PROJECTION" >/dev/null 2>&1; then
  _pass "projection envelope includes Console schema, scope, producer, and direct snapshot provenance"
else
  _fail "projection envelope is missing required Console contract fields"
fi

if jq -e '
  all(.learnings[]; .family == "workflow" and .nonAuthority == true) and
  ([paths(scalars) | map(tostring) | join(".") | select(test("(^|\\.)(claims|gates|decisions|actions)(\\.|$)"))] | length) == 0 and
  (has("refs") | not) and
  (has("links") | not)
' "$PROJECTION" >/dev/null 2>&1; then
  _pass "learnings are inert and output has no authoritative fields or invalid top-level refs/links"
else
  _fail "projection contains authority fields, invalid refs/links, or non-inert learnings"
fi

if jq -e '
  .learnings as $learnings |
  ($learnings | map(.id) | unique | length) == 2 and
  all($learnings[]; (.id | test("^learning\\.workflow\\.")) and (.subjectRef.product == "flow-agents") and (.subjectRef.kind == "workflow") and (.sourceRef.product == "flow-agents") and (.sourceRef.kind == "workflow-learning") and (.summary | length > 0)) and
  all($learnings[]; .sourceRef.id != .extensions["flow-agents"].record_id) and
  any($learnings[]; .subjectRef.id == "console-learning-correction" and .sourceRef.id == "console-learning-correction/record-correction-needed" and .sourceRef.label == "console-learning-correction/record-correction-needed" and .extensions["flow-agents"].record_id == "record-correction-needed") and
  any($learnings[]; .subjectRef.id == "console-learning-open-route" and .sourceRef.id == "console-learning-open-route/record-open-route" and .sourceRef.label == "console-learning-open-route/record-open-route" and .extensions["flow-agents"].record_id == "record-open-route")
' "$PROJECTION" >/dev/null 2>&1; then
  _pass "learning ids and subject/source refs include task context while preserving raw record ids"
else
  _fail "learning ids or subject/source refs do not correlate to source records"
fi

if jq -e '
  .learnings[] | select(.sourceRef.id == "console-learning-correction/record-correction-needed") |
  .extensions["flow-agents"] as $ext |
  $ext.task_slug == "console-learning-correction" and
  $ext.record_id == "record-correction-needed" and
  $ext.source_path == "console-learning-correction/learning.json" and
  $ext.source_refs == ["critique.json#/critiques/0/findings/0", "evals/integration/test_console_learning_projection.sh"] and
  $ext.routing.count == 2 and
  $ext.routing.open == 1 and
  $ext.routing.deferred == 1 and
  ($ext.routing.targets | sort) == ["eval", "skill"] and
  ($ext.routing.statuses | sort) == ["deferred", "open"] and
  ($ext.routing.refs | sort) == ["github:kontourai/flow-agents#96", "kits/builder/skills/learning-review/SKILL.md"] and
  $ext.correction.needed == true and
  $ext.correction.type == "workflow" and
  $ext.correction.recurrence_key == "console-learning-projection.recurrence-metadata" and
  $ext.correction.prevention == {"target":"eval","status":"open","ref":"evals/integration/test_console_learning_projection.sh"} and
  $ext.outcome == "mixed" and
  $ext.learning_status == "followup_required"
' "$PROJECTION" >/dev/null 2>&1; then
  _pass "correction-needed extension carries routing, correction, recurrence, and source path details"
else
  _fail "correction-needed extension missing required Flow Agents details"
fi

if jq -e '
  .learnings[] | select(.sourceRef.id == "console-learning-open-route/record-open-route") |
  .extensions["flow-agents"] as $ext |
  $ext.task_slug == "console-learning-open-route" and
  $ext.record_id == "record-open-route" and
  $ext.source_path == "console-learning-open-route/learning.json" and
  $ext.routing.count == 2 and
  $ext.routing.open == 1 and
  $ext.routing.accepted == 1 and
  ($ext.routing.targets | sort) == ["backlog", "doc"] and
  ($ext.routing.statuses | sort) == ["accepted", "open"] and
  $ext.correction == {"needed":false} and
  $ext.outcome == "success" and
  $ext.learning_status == "learned"
' "$PROJECTION" >/dev/null 2>&1; then
  _pass "non-correction open-route extension carries routing and correction state"
else
  _fail "non-correction open-route extension missing required Flow Agents details"
fi

if git diff --quiet -- schemas/workflow-learning.schema.json; then
  _pass "workflow-learning source schema is unchanged"
else
  _fail "schemas/workflow-learning.schema.json has unexpected diff"
fi

echo ""
echo "Result: $pass passed, $fail failed"
if [[ "$fail" -gt 0 ]]; then
  exit 1
fi
