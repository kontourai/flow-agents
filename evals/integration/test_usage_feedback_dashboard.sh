#!/usr/bin/env bash
# test_usage_feedback_dashboard.sh - Layer 2: automatic artifact sync + HTML dashboard validation
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/evals/lib/node.sh"
USAGE_FEEDBACK="$ROOT_DIR/scripts/usage-feedback.js"
TMPDIR_EVAL=$(mktemp -d /tmp/eval-usage-feedback-dashboard.XXXXXX)
pass=0; fail=0

cleanup() { rm -rf "$TMPDIR_EVAL"; }
trap cleanup EXIT

_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }

echo "=== Layer 2: Usage Feedback Dashboard Validation ==="
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

telemetry="$TMPDIR_EVAL/telemetry"
artifacts="$TMPDIR_EVAL/.flow-agents"
mkdir -p "$telemetry" "$artifacts/auto-feedback" "$artifacts/open-feedback"
cat > "$artifacts/auto-feedback/auto-feedback--deliver.md" <<'MARKDOWN'
# Auto Feedback Delivery

branch: main
worktree: /tmp/example
created: 2026-05-04
status: delivered
type: deliver
iteration: 1
MARKDOWN

cat > "$artifacts/open-feedback/open-feedback--deliver.md" <<'MARKDOWN'
# Open Feedback Delivery

branch: main
worktree: /tmp/example
created: 2026-05-04
status: verifying
type: deliver
iteration: 0
MARKDOWN
mkdir -p "$artifacts/html-feedback"
cat > "$artifacts/html-feedback/html-feedback--deliver.md" <<'MARKDOWN'
# <script>alert(1)</script>

branch: main
worktree: /tmp/example
created: 2026-05-04
status: delivered
type: deliver
iteration: 1
MARKDOWN

echo ""
echo "--- Artifact Sync ---"
if flow_agents_node "$USAGE_FEEDBACK" sync-artifacts \
  --telemetry-dir "$telemetry" \
  --artifact-dir "$artifacts" \
  --repo flow-agents \
  --profile-id codex-default \
  --prompt-id deliver-v1 \
  --skill-id deliver >"$TMPDIR_EVAL/sync.out" 2>"$TMPDIR_EVAL/sync.err"; then
  _pass "sync-artifacts derives terminal artifact outcomes"
else
  _fail "sync-artifacts failed: $(cat "$TMPDIR_EVAL/sync.err" 2>/dev/null)"
fi

if [[ -f "$telemetry/outcomes.jsonl" ]] && \
   jq -e 'select(.result == "success" and .task_type == "deliver" and .quality_score == null)' "$telemetry/outcomes.jsonl" >/dev/null 2>&1; then
  _pass "synced outcome records success without invented quality score"
else
  _fail "synced outcome missing expected success/null-quality fields"
fi

before_count=$(wc -l < "$telemetry/outcomes.jsonl" | tr -d ' ')
flow_agents_node "$USAGE_FEEDBACK" sync-artifacts \
  --telemetry-dir "$telemetry" \
  --artifact-dir "$artifacts" \
  --repo flow-agents \
  --profile-id codex-default \
  --prompt-id deliver-v1 \
  --skill-id deliver >/dev/null 2>"$TMPDIR_EVAL/sync-second.err"
after_count=$(wc -l < "$telemetry/outcomes.jsonl" | tr -d ' ')
if [[ "$before_count" == "$after_count" ]]; then
  _pass "sync-artifacts is idempotent by artifact outcome id"
else
  _fail "sync-artifacts duplicated outcomes on second run"
fi

if flow_agents_node "$USAGE_FEEDBACK" sync-artifacts \
  --telemetry-dir "$telemetry" \
  --artifact-dir "$artifacts" \
  --include-open \
  --repo flow-agents >/dev/null 2>"$TMPDIR_EVAL/sync-open.err" && \
   jq -e 'select(.result == "not_verified" and .task_slug == "open-feedback-delivery")' "$telemetry/outcomes.jsonl" >/dev/null 2>&1; then
  _pass "sync-artifacts can include open artifacts as not_verified"
else
  _fail "sync-artifacts --include-open did not record open artifact"
fi

cat >> "$telemetry/outcomes.jsonl" <<'JSONL'
{"schema_version":"1","outcome_id":"xss-outcome","recorded_at":"2026-05-04T11:30:00Z","session_id":"xss-session","runtime":"codex","repo":"flow-agents","task_type":"deliver","task_slug":"<script>alert(1)</script>","result":"success","quality_score":null,"human_minutes_saved":null,"rework_required":false,"evidence":[]}
JSONL

echo ""
echo "--- Dashboard ---"
dashboard="$telemetry/reports/dashboard.html"
if flow_agents_node "$USAGE_FEEDBACK" dashboard \
  --telemetry-dir "$telemetry" \
  --artifact-dir "$artifacts" \
  --repo flow-agents \
  --profile-id codex-default \
  --prompt-id deliver-v1 \
  --skill-id deliver \
  --force >"$TMPDIR_EVAL/dashboard.out" 2>"$TMPDIR_EVAL/dashboard.err"; then
  _pass "dashboard syncs artifacts and writes HTML"
else
  _fail "dashboard failed: $(cat "$TMPDIR_EVAL/dashboard.err" 2>/dev/null)"
fi

if [[ -f "$dashboard" ]] && \
   grep -q "<!doctype html>" "$dashboard" && \
   grep -q "Usage Dashboard" "$dashboard" && \
   grep -q "What Needs Attention" "$dashboard" && \
   grep -q "Measurement state" "$dashboard" && \
   grep -q "Data Coverage" "$dashboard" && \
   grep -q "Outcome Mix" "$dashboard" && \
   grep -q "Missing Label Drilldown" "$dashboard" && \
   grep -q "auto-feedback-delivery" "$dashboard" && \
   grep -q '&lt;script&gt;alert(1)&lt;/script&gt;' "$dashboard" && \
   ! grep -q '<script>alert(1)</script>' "$dashboard"; then
  _pass "dashboard HTML contains expected sections and escapes artifact labels"
else
  _fail "dashboard HTML missing expected content or escaping"
fi

if flow_agents_node "$USAGE_FEEDBACK" dashboard \
  --telemetry-dir "$telemetry" \
  --artifact-dir "$artifacts" >/dev/null 2>"$TMPDIR_EVAL/dashboard-overwrite.err"; then
  _fail "dashboard overwrote existing output without --force"
else
  _pass "dashboard rejects existing output without --force"
fi

if flow_agents_node "$USAGE_FEEDBACK" report \
  --telemetry-dir "$telemetry" \
  --format html \
  --output reports/report.html >"$TMPDIR_EVAL/report-html.out" 2>"$TMPDIR_EVAL/report-html.err" && \
   grep -q "Usage Dashboard" "$telemetry/reports/report.html"; then
  _pass "report --format html writes dashboard-style HTML"
else
  _fail "report --format html failed: $(cat "$TMPDIR_EVAL/report-html.err" 2>/dev/null)"
fi

echo ""
echo "Result: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
