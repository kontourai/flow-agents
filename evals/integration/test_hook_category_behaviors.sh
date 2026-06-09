#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

TMPDIR_EVAL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_EVAL"' EXIT

errors=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

echo "=== Hook Category Behavior Checks ==="

run_json() {
  node -e 'const fs=require("fs"); let cur=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); for (const part of process.argv[2].split(".")) cur=Array.isArray(cur) ? cur[Number(part)] : cur[part]; console.log(cur);' "$1" "$2"
}

if node "$ROOT/scripts/hooks/run-hook.js" pre:config-protection config-protection.js standard,strict >"$TMPDIR_EVAL/config.out" 2>"$TMPDIR_EVAL/config.err" <<'JSON'
{"hook_event_name":"PreToolUse","tool_input":{"path":"eslint.config.js"}}
JSON
then
  fail "policy hook blocks protected config through runner"
else
  status=$?
  [[ "$status" -eq 2 ]] && grep -q "Modifying eslint.config.js is not allowed" "$TMPDIR_EVAL/config.err" \
    && pass "policy hook blocks protected config through runner" \
    || fail "policy hook block output is unexpected"
fi

if SA_DISABLED_HOOKS=pre:config-protection node "$ROOT/scripts/hooks/run-hook.js" pre:config-protection config-protection.js standard,strict >"$TMPDIR_EVAL/disabled.out" 2>"$TMPDIR_EVAL/disabled.err" <<'JSON'
{"hook_event_name":"PreToolUse","tool_input":{"path":"eslint.config.js"}}
JSON
then
  if cmp -s "$TMPDIR_EVAL/disabled.out" <(printf '%s\n' '{"hook_event_name":"PreToolUse","tool_input":{"path":"eslint.config.js"}}'); then
    pass "hook runner respects disabled hook ids"
  else
    fail "disabled hook did not pass raw input through"
  fi
else
  fail "disabled hook should pass through"
fi

if SA_HOOK_PROFILE=minimal node "$ROOT/scripts/hooks/run-hook.js" pre:config-protection config-protection.js standard,strict >"$TMPDIR_EVAL/minimal.out" 2>"$TMPDIR_EVAL/minimal.err" <<'JSON'
{"hook_event_name":"PreToolUse","tool_input":{"path":"eslint.config.js"}}
JSON
then
  pass "hook runner respects profile gating"
else
  fail "minimal profile should disable standard/strict hook"
fi

if node "$ROOT/scripts/hooks/run-hook.js" pre:traversal ../telemetry/telemetry.sh standard,strict >"$TMPDIR_EVAL/traversal.out" 2>"$TMPDIR_EVAL/traversal.err" <<'JSON'
{"hook_event_name":"PreToolUse"}
JSON
then
  grep -q "Path traversal rejected" "$TMPDIR_EVAL/traversal.err" && pass "hook runner rejects traversal script paths" || fail "traversal rejection message missing"
else
  fail "traversal rejection should fail open"
fi

if node "$ROOT/scripts/hooks/claude-hook-adapter.js" PreToolUse pre:config-protection config-protection.js standard,strict >"$TMPDIR_EVAL/claude-block.json" 2>"$TMPDIR_EVAL/claude-block.err" <<'JSON'
{"hook_event_name":"PreToolUse","tool_input":{"path":"prettier.config.js"}}
JSON
then
  if [[ "$(run_json "$TMPDIR_EVAL/claude-block.json" "continue")" == "false" ]] \
    && [[ "$(run_json "$TMPDIR_EVAL/claude-block.json" "hookSpecificOutput.permissionDecision")" == "deny" ]]; then
    pass "Claude runtime adapter translates PreToolUse policy block"
  else
    fail "Claude runtime adapter block contract mismatch"
  fi
else
  fail "Claude runtime adapter should exit successfully after translating block"
fi

if node "$ROOT/scripts/hooks/codex-hook-adapter.js" pre:config-protection config-protection.js standard,strict >"$TMPDIR_EVAL/codex-block.json" 2>"$TMPDIR_EVAL/codex-block.err" <<'JSON'
{"hook_event_name":"PreToolUse","tool_input":{"path":"biome.json"}}
JSON
then
  if [[ "$(run_json "$TMPDIR_EVAL/codex-block.json" "hookSpecificOutput.permissionDecision")" == "deny" ]]; then
    pass "Codex runtime adapter translates PreToolUse policy block"
  else
    fail "Codex runtime adapter block contract mismatch"
  fi
else
  fail "Codex runtime adapter should exit successfully after translating block"
fi

if node "$ROOT/scripts/hooks/run-hook.js" pre:report-only-guard report-only-guard.js standard,strict >"$TMPDIR_EVAL/report-only.out" 2>"$TMPDIR_EVAL/report-only.err" <<'JSON'
{"hook_event_name":"PreToolUse","tool_input":{"path":"src/example.ts"}}
JSON
then
  fail "report-only guard should block writes"
else
  status=$?
  [[ "$status" -eq 2 ]] && grep -q "report-only" "$TMPDIR_EVAL/report-only.err" \
    && pass "report-only policy hook blocks production edits" \
    || fail "report-only guard output is unexpected"
fi

if node "$ROOT/scripts/hooks/pre-commit-quality.js" >"$TMPDIR_EVAL/precommit.out" 2>"$TMPDIR_EVAL/precommit.err" <<'JSON'
{"hook_event_name":"PreToolUse","tool_input":{"command":"git status --short"}}
JSON
then
  pass "repo guardrail hook stays quiet for non-commit commands"
else
  fail "repo guardrail hook should not block non-commit commands"
fi

mkdir -p "$TMPDIR_EVAL/repo"
printf '{"name":"fixture"}\n' > "$TMPDIR_EVAL/repo/package.json"
printf 'const value = 1;\n' > "$TMPDIR_EVAL/repo/example.ts"
if (cd "$TMPDIR_EVAL/repo" && node "$ROOT/scripts/hooks/post-edit-accumulator.js" >"$TMPDIR_EVAL/accum.out" <<JSON
{"hook_event_name":"PostToolUse","tool_input":{"path":"$TMPDIR_EVAL/repo/example.ts"}}
JSON
); then
  if (cd "$TMPDIR_EVAL/repo" && node "$ROOT/scripts/hooks/stop-format-typecheck.js" >"$TMPDIR_EVAL/stop.out" 2>"$TMPDIR_EVAL/stop.err" <<JSON
{"hook_event_name":"Stop","cwd":"$TMPDIR_EVAL/repo"}
JSON
  ); then
    pass "post-edit accumulator and stop formatter cooperate without blocking"
  else
    fail "stop formatter should fail open"
  fi
else
  fail "post-edit accumulator should pass through"
fi

if node "$ROOT/scripts/hooks/quality-gate.js" >"$TMPDIR_EVAL/quality.out" 2>"$TMPDIR_EVAL/quality.err" <<JSON
{"hook_event_name":"PostToolUse","tool_input":{"path":"$TMPDIR_EVAL/repo/example.ts"}}
JSON
then
  pass "quality policy hook is non-blocking"
else
  fail "quality policy hook should be non-blocking"
fi

audit_dir="$TMPDIR_EVAL/audit"
mkdir -p "$audit_dir/sessions"
printf '{"session_id":"session-1"}\n' > "$audit_dir/sessions/one.session"
if printf '%s\n' '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo AKIA1234567890ABCDEF && rm -rf /tmp/example"}}' \
  | TELEMETRY_GOVERNANCE=true TELEMETRY_DATA_DIR="$audit_dir" TELEMETRY_SESSION_DIR="$audit_dir/sessions" bash "$ROOT/scripts/hooks/governance-audit.sh" preToolUse dev >"$TMPDIR_EVAL/governance.out" 2>"$TMPDIR_EVAL/governance.err"; then
  sleep 0.2
  if [[ -s "$audit_dir/audit.jsonl" ]] \
    && grep -q '"event_type":"governance.secret_detected"' "$audit_dir/audit.jsonl" \
    && grep -q '"event_type":"governance.destructive_operation"' "$audit_dir/audit.jsonl"; then
    pass "governance audit policy emits audit events through shared libraries"
  else
    fail "governance audit did not emit expected audit events"
  fi
else
  fail "governance audit should fail open"
fi

if printf '%s\n' '{"hook_event_name":"Stop","last_assistant_message":"done"}' \
  | TELEMETRY_NOTIFICATIONS=false bash "$ROOT/scripts/hooks/desktop-notify.sh" stop dev >"$TMPDIR_EVAL/notify.out" 2>"$TMPDIR_EVAL/notify.err"; then
  grep -q '"last_assistant_message":"done"' "$TMPDIR_EVAL/notify.out" \
    && pass "local notification helper passes hook input through when disabled" \
    || fail "notification helper did not pass input through"
else
  fail "notification helper should fail open when disabled"
fi

codex_log="$TMPDIR_EVAL/codex.jsonl"
if printf '%s\n' '{"hook_event_name":"UserPromptSubmit","cwd":"/tmp","prompt":"secret"}' \
  | env TELEMETRY_CONFIG_FILE="$TMPDIR_EVAL/telemetry.conf" TELEMETRY_DATA_DIR="$TMPDIR_EVAL" TELEMETRY_SESSION_DIR="$TMPDIR_EVAL/sessions" TELEMETRY_CHANNEL_FULL_LOG_FILE="$TMPDIR_EVAL/claude.jsonl" FLOW_AGENTS_CLAUDE_TELEMETRY_CHANNELS=full FLOW_AGENTS_CLAUDE_TELEMETRY_FOREGROUND=true node "$ROOT/scripts/hooks/claude-telemetry-hook.js" UserPromptSubmit dev >"$TMPDIR_EVAL/claude-telemetry.json" 2>"$TMPDIR_EVAL/claude-telemetry.err"; then
  [[ "$(run_json "$TMPDIR_EVAL/claude-telemetry.json" "continue")" == "true" ]] \
    && [[ "$(run_json "$TMPDIR_EVAL/claude-telemetry.json" "suppressOutput")" == "true" ]] \
    && pass "Claude telemetry shim emits valid fail-open response" \
    || fail "Claude telemetry shim response mismatch"
else
  fail "Claude telemetry shim should fail open"
fi

if printf '%s\n' '{"hook_event_name":"UserPromptSubmit","cwd":"/tmp","prompt":"secret"}' \
  | env TELEMETRY_CONFIG_FILE="$TMPDIR_EVAL/telemetry.conf" TELEMETRY_DATA_DIR="$TMPDIR_EVAL" TELEMETRY_SESSION_DIR="$TMPDIR_EVAL/sessions" TELEMETRY_CHANNEL_FULL_LOG_FILE="$codex_log" FLOW_AGENTS_CODEX_TELEMETRY_CHANNELS=full FLOW_AGENTS_CODEX_TELEMETRY_FOREGROUND=true node "$ROOT/scripts/hooks/codex-telemetry-hook.js" userPromptSubmit dev >"$TMPDIR_EVAL/codex-telemetry.json" 2>"$TMPDIR_EVAL/codex-telemetry.err"; then
  [[ "$(run_json "$TMPDIR_EVAL/codex-telemetry.json" "continue")" == "true" ]] \
    && pass "Codex telemetry shim emits valid fail-open response" \
    || fail "Codex telemetry shim response mismatch"
else
  fail "Codex telemetry shim should fail open"
fi

if [[ "$errors" -eq 0 ]]; then
  echo "Hook category behavior checks passed"
else
  echo "Hook category behavior checks failed: $errors"
fi

exit "$errors"
