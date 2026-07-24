#!/usr/bin/env bash
# test_usage_feedback_report.sh - Layer 2: Usage feedback report validation
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/evals/lib/node.sh"
USAGE_FEEDBACK="$ROOT_DIR/scripts/usage-feedback.js"
FIXTURE_DIR="$ROOT_DIR/evals/fixtures/usage-feedback"
TMPDIR_EVAL=$(mktemp -d /tmp/eval-usage-feedback-report.XXXXXX)
pass=0; fail=0

cleanup() { rm -rf "$TMPDIR_EVAL"; }
trap cleanup EXIT

_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }

echo "=== Layer 2: Usage Feedback Report Validation ==="
echo ""

echo "--- Script Existence ---"
if [[ -f "$USAGE_FEEDBACK" ]]; then
  _pass "usage-feedback.js exists"
else
  _fail "usage-feedback.js not found at $USAGE_FEEDBACK"
  echo ""
  echo "Result: $pass passed, $fail failed"
  exit 1
fi

echo ""
tmp_a="$TMPDIR_EVAL/repo-a"
tmp_b="$TMPDIR_EVAL/repo-b"
mkdir -p "$tmp_a" "$tmp_b"
cp "$FIXTURE_DIR/sample-full.jsonl" "$tmp_a/full.jsonl"
cp "$FIXTURE_DIR/sample-outcomes.jsonl" "$tmp_a/outcomes.jsonl"
cat > "$tmp_b/normalized-sessions.jsonl" <<'JSONL'
{"schema_version":"1","session_id":"codex-session-3","runtime_session_id":"codex-session-3","source_id":"repo-b","runtime":"codex","repo":"repo-b","agent":"dev","profile_id":"codex-experimental","prompt_id":"deliver-v2","prompt_variant":"concise","skill_ids":["deliver","verify-work"],"turns":1,"tool_invocations":1,"delegations":0,"permission_requests":0}
JSONL
cat > "$tmp_b/outcomes.jsonl" <<'JSONL'
{"schema_version":"1","outcome_id":"outcome-2","recorded_at":"2026-05-04T11:30:00Z","session_id":"codex-session-3","runtime":"codex","repo":"repo-b","agent":"dev","profile_id":"codex-experimental","prompt_id":"deliver-v2","prompt_variant":"concise","skill_ids":["deliver","verify-work"],"task_type":"verify","task_slug":"usage-feedback-report","result":"failure","quality_score":2,"human_minutes_saved":0,"rework_required":true,"notes":"Fixture failure outcome","evidence":["evals/integration/test_usage_feedback_report.sh"]}
{"schema_version":"1","outcome_id":"artifact:legacy-success","recorded_at":"2026-05-04T11:31:00Z","session_id":"legacy-success-slug","runtime":"codex","repo":"repo-b","task_type":"deliver","task_slug":"legacy-success-slug","result":"success","quality_score":null,"human_minutes_saved":null,"rework_required":false,"evidence":["legacy-artifact.md"]}
JSONL

echo "--- JSON Report ---"
json_report="$TMPDIR_EVAL/report.json"
if flow_agents_node "$USAGE_FEEDBACK" report \
  --telemetry-dir "$tmp_a" \
  --telemetry-dir "$tmp_b" \
  --format json \
  --group-by repo >"$json_report" 2>"$TMPDIR_EVAL/report-json.err"; then
  _pass "report emits JSON for multiple telemetry dirs"
else
  _fail "JSON report failed: $(cat "$TMPDIR_EVAL/report-json.err" 2>/dev/null)"
fi

if jq -e '.summary.sessions == 3 and
  .summary.sessions_with_joined_outcomes == 2 and
  .summary.joined_outcome_records == 2 and
  .summary.joined_outcome_result_counts == {"success":1,"partial":0,"failure":1,"not_verified":0,"unknown":0} and
  .summary.joined_outcome_success_rate == 0.5 and
  .measurement.outcome_identity.total_records == 3 and
  .measurement.outcome_identity.joined_records == 2 and
  .measurement.outcome_identity.unjoined_records == 1 and
  .measurement.outcome_identity.unjoined_by_reason.no_match == 1 and
  .measurement.partial == true and
  (.measurement.partial_reasons | index("unjoined_outcomes")) != null and
  (.sources | length) == 3' "$json_report" >/dev/null 2>&1; then
  _pass "JSON report separates joined quality evidence from unjoined outcomes"
else
  _fail "JSON report did not preserve explicit joined and unjoined denominators"
fi

if jq -e '.groups[]? | select((.key == "flow-agents") or (.group == "flow-agents") or (.name == "flow-agents"))' "$json_report" >/dev/null 2>&1; then
  _pass "JSON report groups by repo"
else
  _fail "JSON report did not include repo group"
fi

if jq -e '([.groups[].joined_outcome_records] | add) == .summary.joined_outcome_records and
  .summary.sessions > .summary.sessions_with_joined_outcomes' "$json_report" >/dev/null 2>&1; then
  _pass "group and summary joined denominators reconcile while usage retains sessions without outcomes"
else
  _fail "group and summary joined denominators did not reconcile"
fi

echo ""
echo "--- Markdown Report ---"
markdown_report="$tmp_a/reports/usage.md"
if flow_agents_node "$USAGE_FEEDBACK" report \
  --telemetry-dir "$tmp_a" \
  --group-by profile_id \
  --output "$markdown_report" >/dev/null 2>"$TMPDIR_EVAL/report-md.err"; then
  _pass "report writes Markdown output file"
else
  _fail "Markdown report failed: $(cat "$TMPDIR_EVAL/report-md.err" 2>/dev/null)"
fi

if [[ -f "$markdown_report" ]]; then
  _pass "Markdown report output file exists"
else
  _fail "Markdown report output file missing"
fi

if grep -q "# Agent Usage Feedback Report" "$markdown_report" && \
   grep -q "Joined-outcome success rate" "$markdown_report" && \
   grep -q "Unjoined outcome records: 0" "$markdown_report" && \
   grep -q "Avg tool invocations" "$markdown_report" && \
   grep -q "Joined-outcome rework rate" "$markdown_report" && \
   grep -q "codex-default" "$markdown_report"; then
  _pass "Markdown report names joined denominators and profile group"
else
  _fail "Markdown report missing required content"
fi

echo ""
echo "--- Ambiguous Identity Quarantine ---"
tmp_ambiguous_a="$TMPDIR_EVAL/ambiguous-a"
tmp_ambiguous_b="$TMPDIR_EVAL/ambiguous-b"
mkdir -p "$tmp_ambiguous_a" "$tmp_ambiguous_b"
cat > "$tmp_ambiguous_a/normalized-sessions.jsonl" <<'JSONL'
{"schema_version":"1","session_id":"duplicate-session","runtime":"codex","source_id":"a","tool_invocations":0}
JSONL
cat > "$tmp_ambiguous_b/normalized-sessions.jsonl" <<'JSONL'
{"schema_version":"1","session_id":"duplicate-session","runtime":"codex","source_id":"b","tool_invocations":0}
JSONL
cat > "$tmp_ambiguous_a/outcomes.jsonl" <<'JSONL'
{"schema_version":"1","outcome_id":"ambiguous-success","session_id":"duplicate-session","runtime":"codex","result":"success","rework_required":false}
{"schema_version":"1","outcome_id":"missing-identity-success","result":"success","rework_required":false}
{"schema_version":"1","outcome_id":"invalid-correlation-success","session_id":"duplicate-session","runtime":"codex","run_correlation":{"schema_version":"broken"},"result":"success","rework_required":false}
JSONL
ambiguous_report="$TMPDIR_EVAL/ambiguous-report.json"
if flow_agents_node "$USAGE_FEEDBACK" report \
  --telemetry-dir "$tmp_ambiguous_a" \
  --telemetry-dir "$tmp_ambiguous_b" \
  --format json >"$ambiguous_report" 2>"$TMPDIR_EVAL/ambiguous-report.err" && \
  jq -e '.measurement.outcome_identity.total_records == 3 and
    .measurement.outcome_identity.joined_records == 0 and
    .measurement.outcome_identity.unjoined_records == 3 and
    .measurement.outcome_identity.unjoined_by_reason.ambiguous_match == 1 and
    .measurement.outcome_identity.unjoined_by_reason.missing_identity == 1 and
    .measurement.outcome_identity.unjoined_by_reason.invalid_correlation == 1 and
    .summary.sessions_with_joined_outcomes == 0 and
    .summary.joined_outcome_records == 0 and
    .summary.joined_outcome_success_rate == null' "$ambiguous_report" >/dev/null 2>&1; then
  _pass "ambiguous exact identities remain unjoined and produce no success claim"
else
  _fail "ambiguous identity handling produced a quality claim"
fi

relative_report="$tmp_a/reports/relative.md"
if (cd "$TMPDIR_EVAL" && flow_agents_node "$USAGE_FEEDBACK" report \
  --telemetry-dir "$tmp_a" \
  --group-by profile_id \
  --output reports/relative.md >/dev/null 2>"$TMPDIR_EVAL/report-relative.err") && [[ -f "$relative_report" ]]; then
  _pass "report writes reports/name.md relative to telemetry reports directory"
else
  _fail "relative reports/name.md output failed: $(cat "$TMPDIR_EVAL/report-relative.err" 2>/dev/null)"
fi

nested_guard_report="$tmp_a/reports/usage-feedback.md"
if (cd "$TMPDIR_EVAL" && flow_agents_node "$USAGE_FEEDBACK" report \
  --telemetry-dir "$tmp_a" \
  --group-by profile_id \
  --output "$(basename "$tmp_a")/reports/usage-feedback.md" >/dev/null 2>"$TMPDIR_EVAL/report-nested-guard.err") && \
   [[ -f "$nested_guard_report" && ! -e "$tmp_a/reports/$(basename "$tmp_a")/reports/usage-feedback.md" ]]; then
  _pass "report prevents nested telemetry reports duplication for relative output"
else
  _fail "nested report output guard failed: $(cat "$TMPDIR_EVAL/report-nested-guard.err" 2>/dev/null)"
fi

if flow_agents_node "$USAGE_FEEDBACK" report \
  --telemetry-dir "$tmp_a" \
  --group-by profile_id \
  --output "$markdown_report" >/dev/null 2>"$TMPDIR_EVAL/report-overwrite.err"; then
  _fail "report overwrote existing output without --force"
else
  _pass "report rejects existing output without --force"
fi

if flow_agents_node "$USAGE_FEEDBACK" report \
  --telemetry-dir "$tmp_a" \
  --group-by profile_id \
  --output "$markdown_report" \
  --force >/dev/null 2>"$TMPDIR_EVAL/report-force.err"; then
  _pass "report overwrites existing output with --force"
else
  _fail "report --force failed: $(cat "$TMPDIR_EVAL/report-force.err" 2>/dev/null)"
fi

if flow_agents_node "$USAGE_FEEDBACK" report \
  --telemetry-dir "$tmp_a" \
  --output "$TMPDIR_EVAL/outside.md" >/dev/null 2>"$TMPDIR_EVAL/report-outside.err"; then
  _fail "report accepted output outside telemetry reports directory"
else
  _pass "report rejects output outside telemetry reports directory"
fi

ln -s "$TMPDIR_EVAL/symlink-report-target.md" "$tmp_a/reports/symlink.md"
if flow_agents_node "$USAGE_FEEDBACK" report \
  --telemetry-dir "$tmp_a" \
  --output "$tmp_a/reports/symlink.md" \
  --force >/dev/null 2>"$TMPDIR_EVAL/report-symlink.err"; then
  _fail "report accepted symlinked output target"
else
  _pass "report rejects symlinked output target"
fi

tmp_symlink_reports="$TMPDIR_EVAL/symlink-reports"
mkdir -p "$tmp_symlink_reports"
cp "$FIXTURE_DIR/sample-full.jsonl" "$tmp_symlink_reports/full.jsonl"
ln -s "$TMPDIR_EVAL/report-parent-target" "$tmp_symlink_reports/reports"
if flow_agents_node "$USAGE_FEEDBACK" report \
  --telemetry-dir "$tmp_symlink_reports" \
  --output usage.md >/dev/null 2>"$TMPDIR_EVAL/report-symlink-parent.err"; then
  _fail "report accepted symlinked reports directory"
else
  _pass "report rejects symlinked reports directory"
fi

mkdir -p "$TMPDIR_EVAL/report-intermediate-target"
ln -s "$TMPDIR_EVAL/report-intermediate-target" "$TMPDIR_EVAL/report-intermediate-link"
if flow_agents_node "$USAGE_FEEDBACK" report \
  --telemetry-dir "$TMPDIR_EVAL/report-intermediate-link/nested" \
  --output usage.md >/dev/null 2>"$TMPDIR_EVAL/report-symlink-telemetry-parent.err"; then
  _fail "report accepted telemetry dir with symlinked parent"
else
  if [[ ! -e "$TMPDIR_EVAL/report-intermediate-target/nested/reports/usage.md" ]]; then
    _pass "report rejects symlinked telemetry parent before creating report dirs"
  else
    _fail "report wrote through symlinked telemetry parent"
  fi
fi

tmp_raw="$TMPDIR_EVAL/raw-source-name"
mkdir -p "$tmp_raw"
cat > "$tmp_raw/full.jsonl" <<'JSONL'
{"session_id":"raw-session","event_type":"turn.user","timestamp":"2026-05-04T12:00:00Z"}
JSONL
raw_report="$TMPDIR_EVAL/raw-report.json"
if flow_agents_node "$USAGE_FEEDBACK" report \
  --telemetry-dir "$tmp_raw" \
  --format json >"$raw_report" 2>"$TMPDIR_EVAL/report-raw.err" && \
   jq -e '.sources == ["raw-source-name"]' "$raw_report" >/dev/null 2>&1; then
  _pass "raw telemetry without source metadata groups by telemetry directory name"
else
  _fail "raw telemetry source fallback failed: $(cat "$TMPDIR_EVAL/report-raw.err" 2>/dev/null)"
fi

tmp_malformed="$TMPDIR_EVAL/malformed-source"
mkdir -p "$tmp_malformed"
cat > "$tmp_malformed/full.jsonl" <<'JSONL'
{"session_id":"valid-before","event_type":"turn.user","timestamp":"2026-05-04T12:00:00Z"}
{"session_id":"secret-session","payload":"DO_NOT_ECHO"
{"session_id":"valid-after","event_type":"session.end","timestamp":"2026-05-04T12:01:00Z"}
JSONL
malformed_report="$TMPDIR_EVAL/malformed-report.json"
if flow_agents_node "$USAGE_FEEDBACK" report \
  --telemetry-dir "$tmp_malformed" \
  --format json >"$malformed_report" 2>"$TMPDIR_EVAL/malformed-report.err" && \
   jq -e '.measurement.partial == true and
   .measurement.total_records == 3 and
   .measurement.valid_records == 2 and
   .measurement.malformed_records == 1 and
   (.measurement.diagnostics | length) == 1 and
   .measurement.diagnostics[0].source == "malformed-source/full.jsonl" and
   .measurement.diagnostics[0].line == 2 and
   .measurement.diagnostics[0].error == "SyntaxError" and
   (.measurement.diagnostics[0].content_sha256 | test("^[a-f0-9]{64}$")) and
   .summary.sessions == 2' "$malformed_report" >/dev/null 2>&1 && \
   grep -q 'quarantined 1 malformed record(s) from malformed-source/full.jsonl' "$TMPDIR_EVAL/malformed-report.err" && \
   ! grep -q 'DO_NOT_ECHO' "$malformed_report" "$TMPDIR_EVAL/malformed-report.err" && \
   ! grep -q "$TMPDIR_EVAL" "$malformed_report" "$TMPDIR_EVAL/malformed-report.err"; then
  _pass "report quarantines malformed source records with content-free partial-data diagnostics"
else
  _fail "malformed source quarantine failed: $(cat "$TMPDIR_EVAL/malformed-report.err" 2>/dev/null)"
fi

tmp_escape="$TMPDIR_EVAL/escape-source"
mkdir -p "$tmp_escape"
cat > "$tmp_escape/normalized-sessions.jsonl" <<'JSONL'
{"schema_version":"1","source_id":"escape-source","runtime":"codex","session_id":"escape-session","profile_id":"alpha|beta\nbreak <tag> & value","skill_ids":[],"turns":0,"tool_invocations":0,"delegations":0,"permission_requests":0}
JSONL
escape_report="$TMPDIR_EVAL/escape.md"
if flow_agents_node "$USAGE_FEEDBACK" report \
  --telemetry-dir "$tmp_escape" \
  --group-by profile_id >"$escape_report" 2>"$TMPDIR_EVAL/report-escape.err" && \
   grep -q 'alpha\\|beta break &lt;tag&gt; &amp; value' "$escape_report"; then
  _pass "Markdown report escapes table labels, HTML chars, and strips newlines"
else
  _fail "Markdown report label escaping failed: $(cat "$TMPDIR_EVAL/report-escape.err" 2>/dev/null)"
fi

escape_html="$tmp_escape/reports/escape.html"
if flow_agents_node "$USAGE_FEEDBACK" report \
  --telemetry-dir "$tmp_escape" \
  --group-by profile_id \
  --format html \
  --output "$escape_html" >"$TMPDIR_EVAL/report-html-escape.out" 2>"$TMPDIR_EVAL/report-html-escape.err" && \
   grep -q '&lt;tag&gt; &amp; value' "$escape_html" && \
   ! grep -q '<tag>' "$escape_html"; then
  _pass "HTML report escapes local telemetry labels"
else
  _fail "HTML report escaping failed: $(cat "$TMPDIR_EVAL/report-html-escape.err" 2>/dev/null)"
fi

echo ""
echo "--- Fixture Report Smoke ---"
fixture_report="$TMPDIR_EVAL/fixture-runtime.md"
if flow_agents_node "$USAGE_FEEDBACK" report \
  --telemetry-dir "$tmp_a" \
  --group-by runtime >"$fixture_report" 2>"$TMPDIR_EVAL/fixture.err"; then
  _pass "report works against copied fixture telemetry"
else
  _fail "fixture report failed: $(cat "$TMPDIR_EVAL/fixture.err" 2>/dev/null)"
fi

direct_fixture_report="$TMPDIR_EVAL/direct-fixture-repo.md"
if flow_agents_node "$USAGE_FEEDBACK" report \
  --telemetry-dir "$FIXTURE_DIR" \
  --group-by repo >"$direct_fixture_report" 2>"$TMPDIR_EVAL/direct-fixture-repo.err" && \
   grep -q "Sessions: 2" "$direct_fixture_report" && \
   grep -q "flow-agents-docs" "$direct_fixture_report"; then
  _pass "report reads sample fixture names directly for repo groups"
else
  _fail "direct fixture repo report failed: $(cat "$TMPDIR_EVAL/direct-fixture-repo.err" 2>/dev/null)"
fi

direct_profile_report="$TMPDIR_EVAL/direct-fixture-profile.md"
if flow_agents_node "$USAGE_FEEDBACK" report \
  --telemetry-dir "$FIXTURE_DIR" \
  --group-by profile_id >"$direct_profile_report" 2>"$TMPDIR_EVAL/direct-fixture-profile.err" && \
   grep -q "Sessions: 2" "$direct_profile_report" && \
   grep -q "codex-default" "$direct_profile_report" && \
   grep -q "codex-experimental" "$direct_profile_report"; then
  _pass "report reads sample fixture names directly for profile groups"
else
  _fail "direct fixture profile report failed: $(cat "$TMPDIR_EVAL/direct-fixture-profile.err" 2>/dev/null)"
fi

echo ""
echo "Result: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
