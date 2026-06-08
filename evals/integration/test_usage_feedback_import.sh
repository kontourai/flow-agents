#!/usr/bin/env bash
# test_usage_feedback_import.sh - Layer 2: Usage feedback Codex import validation
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/evals/lib/node.sh"
USAGE_FEEDBACK="$ROOT_DIR/scripts/usage-feedback.js"
FIXTURE_FULL="$ROOT_DIR/evals/fixtures/usage-feedback/sample-full.jsonl"
TMPDIR_EVAL=$(mktemp -d /tmp/eval-usage-feedback-import.XXXXXX)
pass=0; fail=0

cleanup() { rm -rf "$TMPDIR_EVAL"; }
trap cleanup EXIT

_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }

_sessions_file() {
  local dir="$1"
  if [[ -f "$dir/sessions.jsonl" ]]; then
    echo "$dir/sessions.jsonl"
  elif [[ -f "$dir/normalized-sessions.jsonl" ]]; then
    echo "$dir/normalized-sessions.jsonl"
  else
    find "$dir" -maxdepth 2 -type f \( -name 'sessions.jsonl' -o -name 'normalized-sessions.jsonl' \) 2>/dev/null | head -1
  fi
}

echo "=== Layer 2: Usage Feedback Runtime Import Validation ==="
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
echo "--- Fixtures ---"
if [[ -f "$FIXTURE_FULL" ]]; then
  _pass "sample Codex full.jsonl fixture exists"
else
  _fail "sample Codex full.jsonl fixture missing"
fi

src_claude="$TMPDIR_EVAL/src-claude"
dst_claude="$TMPDIR_EVAL/dst-claude"
mkdir -p "$src_claude" "$dst_claude"
cat > "$src_claude/full.jsonl" <<'JSONL'
{"schema_version":"0.3.0","timestamp":"2026-05-04T12:00:00Z","session_id":"claude-session-1","event_id":"evt-1","event_type":"turn.user","agent":{"name":"dev","runtime":"claude-code"},"turn":{"prompt_text":"hello","prompt_length":5}}
{"schema_version":"0.3.0","timestamp":"2026-05-04T12:00:05Z","session_id":"claude-session-1","event_id":"evt-2","event_type":"tool.invoke","agent":{"name":"dev","runtime":"claude-code"},"tool":{"name":"Agent","normalized_name":"delegate to a specialist agent","input":{"subagent_type":"tool-planner"}}}
{"schema_version":"0.3.0","timestamp":"2026-05-04T12:00:05Z","session_id":"claude-session-1","event_id":"evt-2-delegate","event_type":"agent.delegate","agent":{"name":"dev","runtime":"claude-code"},"delegation":{"targets":["tool-planner"]}}
{"schema_version":"0.3.0","timestamp":"2026-05-04T12:01:00Z","session_id":"claude-session-1","event_id":"evt-3","event_type":"session.usage","agent":{"name":"dev","runtime":"claude-code"},"usage":{"model":"opus","duration_s":60,"tool_invocations":1,"delegations":1,"input_tokens":null,"output_tokens":null,"estimated_cost_usd":null}}
JSONL

src="$TMPDIR_EVAL/src"
dst_a="$TMPDIR_EVAL/dst-a"
dst_b="$TMPDIR_EVAL/dst-b"
mkdir -p "$src" "$dst_a" "$dst_b"
cp "$FIXTURE_FULL" "$src/full.jsonl"

echo ""
echo "--- Import Command ---"
if flow_agents_node "$USAGE_FEEDBACK" import-codex \
  --input-telemetry-dir "$src" \
  --telemetry-dir "$dst_a" \
  --source-id "repo-a" \
  --repo "repo-a" \
  --repo-root "/tmp/repo-a" \
  --profile-id "codex-default" \
  --prompt-id "deliver-v1" \
  --skill-id "deliver" >/dev/null 2>"$TMPDIR_EVAL/import-a.err"; then
  _pass "import-codex imports from input telemetry dir"
else
  _fail "import-codex failed for input dir: $(cat "$TMPDIR_EVAL/import-a.err" 2>/dev/null)"
fi

sessions_a="$(_sessions_file "$dst_a")"
if [[ -n "$sessions_a" && -f "$sessions_a" ]]; then
  _pass "import-codex writes normalized session data"
else
  _fail "import-codex did not write sessions.jsonl or normalized-sessions.jsonl"
fi

session_count=$(jq -s 'length' "$sessions_a" 2>/dev/null)
source_id=$(jq -r 'select(.session_id == "codex-session-1") | .source_id' "$sessions_a" 2>/dev/null | head -1)
repo=$(jq -r 'select(.session_id == "codex-session-1") | .repo' "$sessions_a" 2>/dev/null | head -1)
profile=$(jq -r 'select(.session_id == "codex-session-1") | .profile_id' "$sessions_a" 2>/dev/null | head -1)
prompt=$(jq -r 'select(.session_id == "codex-session-1") | .prompt_id' "$sessions_a" 2>/dev/null | head -1)
skill=$(jq -r 'select(.session_id == "codex-session-1") | .skill_ids[0]' "$sessions_a" 2>/dev/null | head -1)
if [[ "$session_count" -ge 2 && "$source_id" == "repo-a" && "$repo" == "repo-a" && "$profile" == "codex-default" && "$prompt" == "deliver-v1" && "$skill" == "deliver" ]]; then
  _pass "normalized sessions include source/repo/profile/prompt/skill identifiers"
else
  _fail "normalized identifiers mismatch: count='$session_count' source='$source_id' repo='$repo' profile='$profile' prompt='$prompt' skill='$skill'"
fi

turns=$(jq -r 'select(.session_id == "codex-session-1") | .turns' "$sessions_a" 2>/dev/null | head -1)
tools=$(jq -r 'select(.session_id == "codex-session-1") | .tool_invocations' "$sessions_a" 2>/dev/null | head -1)
delegations=$(jq -r 'select(.session_id == "codex-session-1") | .delegations' "$sessions_a" 2>/dev/null | head -1)
permissions=$(jq -r 'select(.session_id == "codex-session-1") | .permission_requests' "$sessions_a" 2>/dev/null | head -1)
if [[ "$turns" == "1" && "$tools" == "2" && "$delegations" == "1" && "$permissions" == "1" ]]; then
  _pass "normalized sessions preserve Codex usage counts"
else
  _fail "usage counts mismatch: turns='$turns' tools='$tools' delegations='$delegations' permissions='$permissions'"
fi

if flow_agents_node "$USAGE_FEEDBACK" import-telemetry \
  --runtime claude-code \
  --input-telemetry-dir "$src_claude" \
  --telemetry-dir "$dst_claude" \
  --source-id "repo-claude" \
  --repo "repo-claude" \
  --profile-id "claude-dev" \
  --prompt-id "deliver-v1" \
  --skill-id "deliver" >/dev/null 2>"$TMPDIR_EVAL/import-claude.err"; then
  _pass "import-telemetry imports Claude Code full.jsonl"
else
  _fail "import-telemetry failed for Claude Code: $(cat "$TMPDIR_EVAL/import-claude.err" 2>/dev/null)"
fi

sessions_claude="$(_sessions_file "$dst_claude")"
claude_runtime=$(jq -r 'select(.session_id == "claude-session-1") | .runtime' "$sessions_claude" 2>/dev/null | head -1)
claude_tools=$(jq -r 'select(.session_id == "claude-session-1") | .tool_invocations' "$sessions_claude" 2>/dev/null | head -1)
claude_delegations=$(jq -r 'select(.session_id == "claude-session-1") | .delegations' "$sessions_claude" 2>/dev/null | head -1)
if [[ "$claude_runtime" == "claude-code" && "$claude_tools" == "1" && "$claude_delegations" == "1" ]]; then
  _pass "normalized sessions preserve Claude Code runtime and usage counts"
else
  _fail "Claude import mismatch: runtime='$claude_runtime' tools='$claude_tools' delegations='$claude_delegations'"
fi

if flow_agents_node "$USAGE_FEEDBACK" import-codex \
  --input-full-jsonl "$src/full.jsonl" \
  --telemetry-dir "$dst_b" \
  --source-id "repo-b" \
  --repo "repo-b" \
  --profile-id "codex-experimental" \
  --prompt-id "deliver-v2" \
  --skill-id "deliver" >/dev/null 2>"$TMPDIR_EVAL/import-b.err"; then
  _pass "import-codex imports from explicit full.jsonl"
else
  _fail "import-codex failed for explicit full.jsonl: $(cat "$TMPDIR_EVAL/import-b.err" 2>/dev/null)"
fi

sessions_b="$(_sessions_file "$dst_b")"
source_b=$(jq -r 'select(.session_id == "codex-session-1") | .source_id' "$sessions_b" 2>/dev/null | head -1)
if [[ "$source_b" == "repo-b" ]]; then
  _pass "same fixture can import with a distinct source_id"
else
  _fail "second import source_id mismatch: '$source_b'"
fi

dst_fallback="$TMPDIR_EVAL/dst-fallback"
mkdir -p "$dst_fallback"
if flow_agents_node "$USAGE_FEEDBACK" import-codex \
  --input-full-jsonl "$src/full.jsonl" \
  --telemetry-dir "$dst_fallback" >/dev/null 2>"$TMPDIR_EVAL/import-fallback.err"; then
  sessions_fallback="$(_sessions_file "$dst_fallback")"
  source_fallback=$(jq -r 'select(.session_id == "codex-session-1") | .source_id' "$sessions_fallback" 2>/dev/null | head -1)
  if [[ "$source_fallback" == "flow-agents" ]]; then
    _pass "import-codex preserves raw repo source fallback when source-id is omitted"
  else
    _fail "omitted source-id fallback mismatch: '$source_fallback'"
  fi
else
  _fail "import-codex failed without source-id: $(cat "$TMPDIR_EVAL/import-fallback.err" 2>/dev/null)"
fi

src_no_metadata="$TMPDIR_EVAL/src-no-metadata"
dst_no_metadata="$TMPDIR_EVAL/dst-no-metadata"
mkdir -p "$src_no_metadata" "$dst_no_metadata"
cat > "$src_no_metadata/full.jsonl" <<'JSONL'
{"session_id":"no-metadata-session","event_type":"turn.user","timestamp":"2026-05-04T12:00:00Z"}
JSONL
if flow_agents_node "$USAGE_FEEDBACK" import-codex \
  --input-telemetry-dir "$src_no_metadata" \
  --telemetry-dir "$dst_no_metadata" >/dev/null 2>"$TMPDIR_EVAL/import-no-metadata.err"; then
  sessions_no_metadata="$(_sessions_file "$dst_no_metadata")"
  source_no_metadata=$(jq -r 'select(.session_id == "no-metadata-session") | .source_id' "$sessions_no_metadata" 2>/dev/null | head -1)
  if [[ "$source_no_metadata" == "src-no-metadata" ]]; then
    _pass "import-codex uses input telemetry dir name when source metadata is absent"
  else
    _fail "input telemetry dir source fallback mismatch: '$source_no_metadata'"
  fi
else
  _fail "import-codex failed for metadata-free input dir: $(cat "$TMPDIR_EVAL/import-no-metadata.err" 2>/dev/null)"
fi

ln -s "$TMPDIR_EVAL/symlink-target" "$TMPDIR_EVAL/symlink-dst"
if flow_agents_node "$USAGE_FEEDBACK" import-codex \
  --input-full-jsonl "$src/full.jsonl" \
  --telemetry-dir "$TMPDIR_EVAL/symlink-dst" >/dev/null 2>"$TMPDIR_EVAL/import-symlink.err"; then
  _fail "import-codex accepted symlinked target telemetry dir"
else
  _pass "import-codex rejects symlinked target telemetry dir"
fi

mkdir -p "$TMPDIR_EVAL/import-intermediate-target"
ln -s "$TMPDIR_EVAL/import-intermediate-target" "$TMPDIR_EVAL/import-intermediate-link"
if flow_agents_node "$USAGE_FEEDBACK" import-codex \
  --input-full-jsonl "$src/full.jsonl" \
  --telemetry-dir "$TMPDIR_EVAL/import-intermediate-link/nested" >/dev/null 2>"$TMPDIR_EVAL/import-symlink-parent.err"; then
  _fail "import-codex accepted target telemetry dir with symlinked parent"
else
  if [[ ! -e "$TMPDIR_EVAL/import-intermediate-target/nested/normalized-sessions.jsonl" ]]; then
    _pass "import-codex rejects symlinked target telemetry parent before creating nested dirs"
  else
    _fail "import-codex wrote through symlinked target telemetry parent"
  fi
fi

if flow_agents_node "$USAGE_FEEDBACK" import-codex \
  --input-telemetry-dir "$TMPDIR_EVAL/missing" \
  --telemetry-dir "$TMPDIR_EVAL/missing-dst" \
  --source-id "missing" \
  --repo "missing" >/dev/null 2>"$TMPDIR_EVAL/missing.err"; then
  _fail "import-codex accepted missing input telemetry"
else
  _pass "import-codex rejects missing input telemetry"
fi

echo ""
echo "Result: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
