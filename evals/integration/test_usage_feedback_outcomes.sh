#!/usr/bin/env bash
# test_usage_feedback_outcomes.sh - Layer 2: Usage feedback outcome validation
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/evals/lib/node.sh"
USAGE_FEEDBACK="$ROOT_DIR/scripts/usage-feedback.js"
TMPDIR_EVAL=$(mktemp -d /tmp/eval-usage-feedback-outcomes.XXXXXX)
pass=0; fail=0

cleanup() { rm -rf "$TMPDIR_EVAL"; }
trap cleanup EXIT

_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }

echo "=== Layer 2: Usage Feedback Outcome Validation ==="
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
echo "--- Outcome Recording ---"
if TELEMETRY_DATA_DIR="$TMPDIR_EVAL" flow_agents_node "$USAGE_FEEDBACK" record-outcome \
  --session-id "session-success" \
  --runtime "codex" \
  --repo "flow-agents" \
  --agent "dev" \
  --profile-id "codex-default" \
  --prompt-id "deliver-v1" \
  --skill-id "deliver" \
  --result "success" \
  --quality-score 5 \
  --task-type "deliver" \
  --task-slug "usage-feedback-success" \
  --human-minutes-saved 12 \
  --evidence ".flow-agents/agent-usage-feedback-loop/agent-usage-feedback-loop--deliver.md" >/dev/null 2>"$TMPDIR_EVAL/success.err"; then
  _pass "record-outcome accepts success with profile/prompt/skill ids"
else
  _fail "record-outcome rejected success: $(cat "$TMPDIR_EVAL/success.err" 2>/dev/null)"
fi

if TELEMETRY_DATA_DIR="$TMPDIR_EVAL" flow_agents_node "$USAGE_FEEDBACK" record-outcome \
  --session-id "session-failure" \
  --runtime "codex" \
  --repo "flow-agents-docs" \
  --agent "dev" \
  --profile-id "codex-experimental" \
  --prompt-id "deliver-v2" \
  --skill-id "deliver" \
  --skill-id "verify-work" \
  --result "failure" \
  --quality-score 2 \
  --task-type "verify" \
  --task-slug "usage-feedback-failure" \
  --rework-required \
  --notes "Fixture failure" >/dev/null 2>"$TMPDIR_EVAL/failure.err"; then
  _pass "record-outcome accepts failure with multiple skill ids"
else
  _fail "record-outcome rejected failure: $(cat "$TMPDIR_EVAL/failure.err" 2>/dev/null)"
fi

OUTCOMES="$TMPDIR_EVAL/outcomes.jsonl"
line_count=$(wc -l < "$OUTCOMES" 2>/dev/null | tr -d ' ')
if [[ "$line_count" == "2" ]]; then
  _pass "record-outcome appends two outcome records"
else
  _fail "expected 2 outcome records, found ${line_count:-0}"
fi

success_profile=$(jq -r 'select(.session_id == "session-success") | .profile_id' "$OUTCOMES" 2>/dev/null)
success_prompt=$(jq -r 'select(.session_id == "session-success") | .prompt_id' "$OUTCOMES" 2>/dev/null)
success_skill=$(jq -r 'select(.session_id == "session-success") | .skill_ids[0]' "$OUTCOMES" 2>/dev/null)
if [[ "$success_profile" == "codex-default" && "$success_prompt" == "deliver-v1" && "$success_skill" == "deliver" ]]; then
  _pass "success outcome preserves profile, prompt, and skill ids"
else
  _fail "success identifiers mismatch: profile='$success_profile' prompt='$success_prompt' skill='$success_skill'"
fi

failure_rework=$(jq -r 'select(.session_id == "session-failure") | .rework_required' "$OUTCOMES" 2>/dev/null)
failure_skill_count=$(jq -r 'select(.session_id == "session-failure") | .skill_ids | length' "$OUTCOMES" 2>/dev/null)
if [[ "$failure_rework" == "true" && "$failure_skill_count" == "2" ]]; then
  _pass "failure outcome preserves rework flag and multiple skill ids"
else
  _fail "failure fields mismatch: rework='$failure_rework' skill_count='$failure_skill_count'"
fi

before_invalid=$(wc -l < "$OUTCOMES" 2>/dev/null | tr -d ' ')
if TELEMETRY_DATA_DIR="$TMPDIR_EVAL" flow_agents_node "$USAGE_FEEDBACK" record-outcome \
  --session-id "session-invalid" \
  --runtime "codex" \
  --repo "flow-agents" \
  --agent "dev" \
  --profile-id "codex-default" \
  --prompt-id "deliver-v1" \
  --skill-id "deliver" \
  --result "excellent" >/dev/null 2>"$TMPDIR_EVAL/invalid-result.err"; then
  _fail "record-outcome accepted invalid result"
else
  after_invalid=$(wc -l < "$OUTCOMES" 2>/dev/null | tr -d ' ')
  if [[ "$after_invalid" == "$before_invalid" ]]; then
    _pass "record-outcome rejects invalid result without appending"
  else
    _fail "invalid result changed outcomes.jsonl line count from $before_invalid to $after_invalid"
  fi
fi

if TELEMETRY_DATA_DIR="$TMPDIR_EVAL" flow_agents_node "$USAGE_FEEDBACK" record-outcome \
  --runtime "codex" \
  --repo "flow-agents" \
  --agent "dev" \
  --result "success" >/dev/null 2>"$TMPDIR_EVAL/missing-session.err"; then
  _fail "record-outcome accepted missing session_id"
else
  _pass "record-outcome rejects missing session_id"
fi

ln -s "$TMPDIR_EVAL/symlink-target" "$TMPDIR_EVAL/symlink-telemetry"
if flow_agents_node "$USAGE_FEEDBACK" record-outcome \
  --telemetry-dir "$TMPDIR_EVAL/symlink-telemetry" \
  --session-id "session-symlink-dir" \
  --result "success" >/dev/null 2>"$TMPDIR_EVAL/symlink-dir.err"; then
  _fail "record-outcome accepted symlinked telemetry dir"
else
  _pass "record-outcome rejects symlinked telemetry dir"
fi

mkdir -p "$TMPDIR_EVAL/intermediate-target"
ln -s "$TMPDIR_EVAL/intermediate-target" "$TMPDIR_EVAL/intermediate-link"
if flow_agents_node "$USAGE_FEEDBACK" record-outcome \
  --telemetry-dir "$TMPDIR_EVAL/intermediate-link/nested" \
  --session-id "session-symlink-parent" \
  --result "success" >/dev/null 2>"$TMPDIR_EVAL/symlink-parent.err"; then
  _fail "record-outcome accepted telemetry dir with symlinked parent"
else
  if [[ ! -e "$TMPDIR_EVAL/intermediate-target/nested/outcomes.jsonl" ]]; then
    _pass "record-outcome rejects symlinked telemetry parent before creating nested dirs"
  else
    _fail "record-outcome wrote through symlinked telemetry parent"
  fi
fi

target_file_dir="$TMPDIR_EVAL/symlink-file-telemetry"
mkdir -p "$target_file_dir"
ln -s "$TMPDIR_EVAL/symlink-outcomes-target.jsonl" "$target_file_dir/outcomes.jsonl"
if flow_agents_node "$USAGE_FEEDBACK" record-outcome \
  --telemetry-dir "$target_file_dir" \
  --session-id "session-symlink-file" \
  --result "success" >/dev/null 2>"$TMPDIR_EVAL/symlink-file.err"; then
  _fail "record-outcome accepted symlinked outcomes target"
else
  _pass "record-outcome rejects symlinked outcomes target"
fi

echo ""
echo "Result: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
