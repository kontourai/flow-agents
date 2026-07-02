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
  claude_reason="$(run_json "$TMPDIR_EVAL/claude-block.json" "hookSpecificOutput.permissionDecisionReason")"
  if [[ "$(run_json "$TMPDIR_EVAL/claude-block.json" "continue")" == "false" ]] \
    && [[ "$(run_json "$TMPDIR_EVAL/claude-block.json" "hookSpecificOutput.permissionDecision")" == "deny" ]]; then
    pass "Claude runtime adapter translates PreToolUse policy block"
    # Block Reason Channel: the deny must carry the steering reason to the model.
    if [[ "$claude_reason" == *"Fix the source"* ]]; then
      pass "Claude block surfaces the steer-to-source reason to the model"
    else
      fail "Claude block reason did not reach the model channel (permissionDecisionReason): $claude_reason"
    fi
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
  codex_reason="$(run_json "$TMPDIR_EVAL/codex-block.json" "hookSpecificOutput.permissionDecisionReason")"
  if [[ "$(run_json "$TMPDIR_EVAL/codex-block.json" "hookSpecificOutput.permissionDecision")" == "deny" ]]; then
    pass "Codex runtime adapter translates PreToolUse policy block"
    # Block Reason Channel: the deny must carry the steering reason to the model.
    if [[ "$codex_reason" == *"Fix the source"* ]]; then
      pass "Codex block surfaces the steer-to-source reason to the model"
    else
      fail "Codex block reason did not reach the model channel (permissionDecisionReason): $codex_reason"
    fi
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

echo ""
echo "=== Sidecar Path Protection: read-allow / write-block with sanctioned remedy (AC7) ==="

# Read on a sidecar state.json must be ALLOWED — read-only tools never mutate a file.
if printf '%s\n' '{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"path":"/repo/.kontourai/flow-agents/my-slug/state.json"}}' \
  | node "$ROOT/scripts/hooks/run-hook.js" pre:config-protection config-protection.js standard,strict >"$TMPDIR_EVAL/read-state.out" 2>"$TMPDIR_EVAL/read-state.err"; then
  pass "Read on a sidecar state.json is allowed (read-only carve-out)"
else
  fail "Read on a sidecar state.json was incorrectly blocked"
  cat "$TMPDIR_EVAL/read-state.err"
fi

# Write on a sidecar state.json must be BLOCKED with the sanctioned advance-state remedy,
# and must NOT advise disabling the config-protection hook.
if printf '%s\n' '{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"path":"/repo/.kontourai/flow-agents/my-slug/state.json"}}' \
  | node "$ROOT/scripts/hooks/run-hook.js" pre:config-protection config-protection.js standard,strict >"$TMPDIR_EVAL/write-state.out" 2>"$TMPDIR_EVAL/write-state.err"; then
  fail "Write on a sidecar state.json should be blocked"
else
  status=$?
  if [[ "$status" -eq 2 ]] \
    && grep -q "workflow:sidecar -- advance-state" "$TMPDIR_EVAL/write-state.err" \
    && grep -q "Never disable this hook" "$TMPDIR_EVAL/write-state.err" \
    && ! grep -q "disable the config-protection hook temporarily" "$TMPDIR_EVAL/write-state.err"; then
    pass "Write on a sidecar state.json is blocked with the sanctioned advance-state remedy (no disable-the-hook advice)"
  else
    fail "sidecar state.json block message is not the reworded remedy"
    cat "$TMPDIR_EVAL/write-state.err"
  fi
fi

echo ""
echo "=== Bypass Flag Detection Tests ==="

# Decode flag strings from base64.
NV=$(node -e "process.stdout.write(Buffer.from('LS1uby12ZXJpZnk=','base64').toString())")
NN=$(node -e "process.stdout.write(Buffer.from('LW4=','base64').toString())")

# AC1: push bypass flag -- should block
_P=$(printf '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"%s"}}' "git push $NV")
if printf '%s\n' "$_P" | node "$ROOT/scripts/hooks/run-hook.js" pre:config-protection config-protection.js standard,strict >"$TMPDIR_EVAL/bpush.out" 2>"$TMPDIR_EVAL/bpush.err"; then
  fail "push bypass flag should be blocked (AC1)"
else
  [[ "$?" -eq 2 ]] && grep -q "BLOCKED" "$TMPDIR_EVAL/bpush.err" \
    && pass "push bypass flag is blocked (AC1)" \
    || fail "push bypass: unexpected result"
fi

# AC1: commit bypass flag -- should block
_P=$(printf '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"%s"}}' "git commit $NV -m fix")
if printf '%s\n' "$_P" | node "$ROOT/scripts/hooks/run-hook.js" pre:config-protection config-protection.js standard,strict >"$TMPDIR_EVAL/bcommit.out" 2>"$TMPDIR_EVAL/bcommit.err"; then
  fail "commit bypass flag should be blocked (AC1)"
else
  [[ "$?" -eq 2 ]] && grep -q "BLOCKED" "$TMPDIR_EVAL/bcommit.err" \
    && pass "commit bypass flag is blocked (AC1)" \
    || fail "commit bypass: unexpected result"
fi

# AC1: short alias on commit -- should block
_P=$(printf '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"%s"}}' "git commit $NN -m fix")
if printf '%s\n' "$_P" | node "$ROOT/scripts/hooks/run-hook.js" pre:config-protection config-protection.js standard,strict >"$TMPDIR_EVAL/bshort.out" 2>"$TMPDIR_EVAL/bshort.err"; then
  fail "short alias on commit should be blocked (AC1)"
else
  [[ "$?" -eq 2 ]] && grep -q "BLOCKED" "$TMPDIR_EVAL/bshort.err" \
    && pass "short alias on commit is blocked (AC1)" \
    || fail "short alias: unexpected result"
fi

# AC2: flag text in quoted body -- should allow
_P=$(printf '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"%s"}}' "gh issue create --body \\\"git commit $NV is blocked\\\"")
if printf '%s\n' "$_P" | node "$ROOT/scripts/hooks/run-hook.js" pre:config-protection config-protection.js standard,strict >"$TMPDIR_EVAL/allow1.out" 2>"$TMPDIR_EVAL/allow1.err"; then
  pass "flag mention in quoted body is allowed (AC2)"
else
  fail "flag mention in quoted body was incorrectly blocked (AC2)"
fi

# AC2: push -n is dry-run, not bypass -- should allow
if printf '%s\n' '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push -n"}}' | node "$ROOT/scripts/hooks/run-hook.js" pre:config-protection config-protection.js standard,strict >"$TMPDIR_EVAL/allow2.out" 2>"$TMPDIR_EVAL/allow2.err"; then
  pass "git push -n (dry-run) is allowed (AC2)"
else
  fail "git push -n was incorrectly blocked (AC2)"
fi

echo ""
echo "=== Interpreter-Write / Copy-Move Remedy Tests (gap closure) ==="

# Interpreter-write block on a sidecar state.json must surface the SAME
# sanctioned advance-state remedy as the plain Write-tool case above, not the
# generic (and factually wrong) "no sanctioned automated writer" fallback.
#
# The assembled command below reproduces the historical bug shape exactly:
# the protected path lives INSIDE a double-quoted JS string, immediately
# followed by a single quote and trailing punctuation (', data)) rather than
# whitespace -- e.g. require('fs').writeFileSync('<path>', data). Pieces are
# built via variable indirection for authoring safety, but the ASSEMBLED
# command string at eval runtime has no whitespace-delimited token that ends
# cleanly at the basename, so Pass 1's end-anchored token match cannot find
# it and remedyForCommand must fall back to Pass 2's substring scan against
# the raw command text.
NODE_EVAL_FLAG="-e"
SIDECAR_SLUG="my-slug"
SIDECAR_STATE_BASENAME="state.json"
SIDECAR_STATE_PATH="/repo/.kontourai/flow-agents/${SIDECAR_SLUG}/${SIDECAR_STATE_BASENAME}"
INTERP_JS="require('fs').writeFileSync('${SIDECAR_STATE_PATH}', data)"
INTERP_CMD_STATE="node ${NODE_EVAL_FLAG} \"${INTERP_JS}\""
# Sanity: the path must NOT be a clean trailing token (no whitespace-token
# boundary right after the basename) -- otherwise this test would silently
# regress to exercising Pass 1 instead of Pass 2, as the prior version did.
case "$INTERP_CMD_STATE" in
  *"${SIDECAR_STATE_BASENAME} "*|*"${SIDECAR_STATE_BASENAME}")
    fail "interpreter-write test fixture regressed to a clean trailing token (no longer exercises Pass 2)"
    ;;
esac
INTERP_JSON_CMD="${INTERP_CMD_STATE//\"/\\\"}"
_P=$(printf '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"%s"}}' "$INTERP_JSON_CMD")
if printf '%s\n' "$_P" | node "$ROOT/scripts/hooks/run-hook.js" pre:config-protection config-protection.js standard,strict >"$TMPDIR_EVAL/interp-state.out" 2>"$TMPDIR_EVAL/interp-state.err"; then
  fail "interpreter-write to a sidecar state.json should be blocked"
else
  status=$?
  if [[ "$status" -eq 2 ]] \
    && grep -q "workflow:sidecar -- advance-state" "$TMPDIR_EVAL/interp-state.err" \
    && ! grep -q "no sanctioned automated writer for shell profiles" "$TMPDIR_EVAL/interp-state.err"; then
    pass "interpreter-write block on a sidecar state.json surfaces the advance-state remedy (not the shell-profile fallback)"
  else
    fail "interpreter-write block message did not surface the advance-state remedy"
    cat "$TMPDIR_EVAL/interp-state.err"
  fi
fi

# cp/mv block on delivery/trust.bundle must name the sanctioned
# publish-delivery writer instead of describing the internal publishDelivery
# fs call.
#
# Note: unlike the interpreter-write case above, cp/mv destination arguments
# ARE clean whitespace-delimited tokens (checkCopyMoveToProtected picks the
# last positional argument, and remedyForCommand's Pass 1 matches that token
# directly via checkProtectedPathPattern). Pass 1 legitimately covers this
# path, so no substring-scan (Pass 2) strengthening is needed here --
# verified by mutation-disabling Pass 2 and confirming this assertion still
# passes.
CP_BIN="cp"
DELIVERY_TRUST_BUNDLE="delivery/trust.bundle"
CP_CMD_DELIVERY="${CP_BIN} forged.json ${DELIVERY_TRUST_BUNDLE}"
_P=$(printf '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"%s"}}' "$CP_CMD_DELIVERY")
if printf '%s\n' "$_P" | node "$ROOT/scripts/hooks/run-hook.js" pre:config-protection config-protection.js standard,strict >"$TMPDIR_EVAL/cp-delivery.out" 2>"$TMPDIR_EVAL/cp-delivery.err"; then
  fail "cp to delivery/trust.bundle should be blocked"
else
  status=$?
  if [[ "$status" -eq 2 ]] && grep -q "workflow:sidecar -- publish-delivery" "$TMPDIR_EVAL/cp-delivery.err"; then
    pass "cp block on delivery/trust.bundle surfaces the sanctioned publish-delivery remedy"
  else
    fail "cp block on delivery/trust.bundle did not surface the publish-delivery remedy"
    cat "$TMPDIR_EVAL/cp-delivery.err"
  fi
fi
if [[ "$errors" -eq 0 ]]; then
  echo "Hook category behavior checks passed"
else
  echo "Hook category behavior checks failed: $errors"
fi

exit "$errors"
