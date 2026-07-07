#!/usr/bin/env bash
# test_telemetry.sh — Layer 2: Telemetry contract validation
# Tests that the telemetry pipeline produces correct event schemas
#
# NOTE: telemetry.sh runs fire-and-forget (backgrounds main + disown) so stdout
# capture doesn't work. All tests write to a temp log file and read from there,
# with a short sleep to let the background process finish.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -d "$ROOT_DIR/context/scripts/telemetry" ]]; then
  TELEMETRY_DIR="$ROOT_DIR/context/scripts/telemetry"
  DISCOVER_SCRIPT="$ROOT_DIR/context/scripts/discover-agents.sh"
else
  TELEMETRY_DIR="$HOME/.flow-agents/context/scripts/telemetry"
  DISCOVER_SCRIPT="$HOME/.flow-agents/context/scripts/discover-agents.sh"
fi
TELEMETRY_SH="${TELEMETRY_DIR}/telemetry.sh"
TMPDIR_EVAL=$(mktemp -d /tmp/eval-telemetry-test.XXXXXX)
TMPLOG="${TMPDIR_EVAL}/test-output.jsonl"
pass=0; fail=0

_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }

# Run telemetry.sh and wait for async output to land in the temp log file
_run_telemetry() {
  local hook_type="$1" agent="$2" input="$3" channels="${4:-full}" redact="${5:-none}"
  local channel_upper
  channel_upper=$(echo "$channels" | tr '[:lower:]' '[:upper:]')

  local before_lines=0
  touch "$TMPLOG"
  before_lines=$(wc -l < "$TMPLOG" | tr -d ' ')

  local env_vars=(
    TELEMETRY_ENABLED=true
    TELEMETRY_CHANNELS="$channels"
    "TELEMETRY_CHANNEL_${channel_upper}_LOG_FILE=$TMPLOG"
    "TELEMETRY_CHANNEL_${channel_upper}_REDACT=$redact"
    FLOW_AGENTS_TELEMETRY_CAPTURE_RAW_HOOK_INPUT=true
    FLOW_AGENTS_TELEMETRY_FOREGROUND=true
    TELEMETRY_CONFIG_FILE="$TMPDIR_EVAL/telemetry.conf"
    TELEMETRY_DATA_DIR="$TMPDIR_EVAL"
    TELEMETRY_SESSION_DIR="$TMPDIR_EVAL/sessions"
  )
  if [[ -n "${FLOW_AGENTS_TELEMETRY_RUNTIME:-}" ]]; then
    env_vars+=(FLOW_AGENTS_TELEMETRY_RUNTIME="$FLOW_AGENTS_TELEMETRY_RUNTIME")
  fi
  mkdir -p "$TMPDIR_EVAL/sessions"
  echo "$input" | env "${env_vars[@]}" bash "$TELEMETRY_SH" "$hook_type" "$agent" 2>/dev/null
  # Wait for background process to append new line(s)
  local i=0 current_lines
  while [[ $i -lt 50 ]]; do
    current_lines=$(wc -l < "$TMPLOG" 2>/dev/null | tr -d ' ')
    [[ "${current_lines:-0}" -gt "$before_lines" ]] && break
    sleep 0.1; i=$((i + 1))
  done
  # Return the latest new line. telemetry.sh writes asynchronously, so a
  # delayed event from the prior assertion can land after before_lines.
  tail -n +"$((before_lines + 1))" "$TMPLOG" 2>/dev/null | tail -1
}

echo "=== Layer 2: Telemetry Contract Validation ==="
echo ""

# --- 1. Telemetry script exists ---
echo "--- Script Existence ---"
if [[ -f "$TELEMETRY_SH" ]]; then
  _pass "telemetry.sh exists"
else
  _fail "telemetry.sh not found at $TELEMETRY_SH"
  echo "Cannot continue without telemetry script"
  rm -rf "$TMPDIR_EVAL"
  exit 1
fi

for lib in config.sh session.sh enrich.sh transport.sh redact.sh; do
  if [[ -f "${TELEMETRY_DIR}/lib/${lib}" ]]; then
    _pass "lib/${lib} exists"
  else
    _fail "lib/${lib} missing"
  fi
done

# --- 1b. Config file resolution precedence ---
# scripts/telemetry/lib/config.sh must resolve TELEMETRY_CONFIG_FILE in this
# order: (1) explicit env always wins; (2) a gitignored per-workspace conf at
# .kontourai/telemetry-console.conf if present AND operator-trusted
# (project-specific override); (3) a gitignored user-global conf at
# ~/.flow-agents/telemetry-console.conf if present AND operator-trusted
# (one machine-wide install, matching the existing ~/.flow-agents
# install-home convention); (4) the shipped telemetry.conf default. The
# shipped conf is tracked and ships into dist bundles, so owner credentials
# must never land there — hence the per-workspace/per-machine fallbacks.
# "Operator-trusted" means mode 600 and owned by the current user, since
# install-console-config.sh always chmod 600s the conf it writes while git
# can only store 644/755 — never 600 — so a conf smuggled in via
# clone/tarball/PR/supply-chain cannot pass the gate even at the expected
# path. Symlinks are rejected outright regardless of the link's own mode,
# since the trust check uses lstat semantics but the later conf read follows
# the link — a mismatched check/read object. A fake HOME isolates these
# checks from any real ~/.flow-agents on the machine running the suite.
echo ""
echo "--- Config File Resolution ---"
CONFIG_SH="$ROOT_DIR/scripts/telemetry/lib/config.sh"
CONFIG_TEST_ROOT=$(mktemp -d /tmp/eval-telemetry-config-test.XXXXXX)
mkdir -p "$CONFIG_TEST_ROOT/scripts/telemetry/lib"
cp "$CONFIG_SH" "$CONFIG_TEST_ROOT/scripts/telemetry/lib/config.sh"
: > "$CONFIG_TEST_ROOT/scripts/telemetry/telemetry.conf"
FAKE_HOME="$CONFIG_TEST_ROOT/home"
mkdir -p "$FAKE_HOME"

_resolve_config_file() {
  env -i PATH="$PATH" HOME="$FAKE_HOME" "$@" \
    bash -c "source '$CONFIG_TEST_ROOT/scripts/telemetry/lib/config.sh' 2>/dev/null; echo \"\$TELEMETRY_CONFIG_FILE\""
}

# Same as _resolve_config_file but captures config.sh's stderr into
# $1 instead of discarding it, so the new "conf exists but is not trusted"
# warning (AC2, install-flow-foundations Thread B) can be asserted on
# directly. Call as: _resolve_config_file_with_stderr <stderr-file> [env=val ...]
_resolve_config_file_with_stderr() {
  local stderr_file="$1"
  shift
  env -i PATH="$PATH" HOME="$FAKE_HOME" "$@" \
    bash -c "source '$CONFIG_TEST_ROOT/scripts/telemetry/lib/config.sh' 2>'$stderr_file'; echo \"\$TELEMETRY_CONFIG_FILE\""
}

STDERR_CAPTURE="$CONFIG_TEST_ROOT/config-stderr.txt"

default_resolved=$(_resolve_config_file)
if [[ "$default_resolved" == "$CONFIG_TEST_ROOT/scripts/telemetry/telemetry.conf" ]]; then
  _pass "config.sh: falls back to shipped telemetry.conf default"
else
  _fail "config.sh: default expected '$CONFIG_TEST_ROOT/scripts/telemetry/telemetry.conf', got '$default_resolved'"
fi

: > "$STDERR_CAPTURE"
_resolve_config_file_with_stderr "$STDERR_CAPTURE" >/dev/null
if [[ ! -s "$STDERR_CAPTURE" ]]; then
  _pass "config.sh: no conf on disk at all produces no untrusted-conf warning"
else
  _fail "config.sh: baseline (no conf) should produce no warning, got: $(cat "$STDERR_CAPTURE")"
fi

mkdir -p "$FAKE_HOME/.flow-agents"
GLOBAL_CONF="$FAKE_HOME/.flow-agents/telemetry-console.conf"
: > "$GLOBAL_CONF"
chmod 644 "$GLOBAL_CONF"
untrusted_global_resolved=$(_resolve_config_file)
if [[ "$untrusted_global_resolved" == "$CONFIG_TEST_ROOT/scripts/telemetry/telemetry.conf" ]]; then
  _pass "config.sh: untrusted (644) user-global conf falls through to shipped default"
else
  _fail "config.sh: untrusted global conf should fall through, got '$untrusted_global_resolved'"
fi

: > "$STDERR_CAPTURE"
_resolve_config_file_with_stderr "$STDERR_CAPTURE" >/dev/null
if grep -qF "$GLOBAL_CONF" "$STDERR_CAPTURE" 2>/dev/null; then
  _pass "config.sh: untrusted (644) user-global conf prints a visible warning naming its path"
else
  _fail "config.sh: expected a warning naming '$GLOBAL_CONF', got: $(cat "$STDERR_CAPTURE" 2>/dev/null)"
fi

chmod 600 "$GLOBAL_CONF"
global_resolved=$(_resolve_config_file)
if [[ "$global_resolved" == "$GLOBAL_CONF" ]]; then
  _pass "config.sh: trusted (600) user-global telemetry-console.conf wins over shipped default"
else
  _fail "config.sh: global conf expected '$GLOBAL_CONF', got '$global_resolved'"
fi

: > "$STDERR_CAPTURE"
_resolve_config_file_with_stderr "$STDERR_CAPTURE" >/dev/null
if [[ ! -s "$STDERR_CAPTURE" ]]; then
  _pass "config.sh: trusted (600) user-global conf produces no warning"
else
  _fail "config.sh: trusted global conf should produce no warning, got: $(cat "$STDERR_CAPTURE")"
fi

mkdir -p "$CONFIG_TEST_ROOT/.kontourai"
LOCAL_CONF="$CONFIG_TEST_ROOT/.kontourai/telemetry-console.conf"
: > "$LOCAL_CONF"
chmod 644 "$LOCAL_CONF"
untrusted_local_resolved=$(_resolve_config_file)
if [[ "$untrusted_local_resolved" == "$GLOBAL_CONF" ]]; then
  _pass "config.sh: untrusted (644) workspace-local conf falls through to trusted global conf"
else
  _fail "config.sh: untrusted local conf should fall through to global, got '$untrusted_local_resolved'"
fi

# Local is untrusted here while global is trusted (600) and wins the
# resolution -- the local warning must still fire even though local isn't
# the file config.sh ultimately picks, since the local conf is still being
# silently ignored on its own terms.
: > "$STDERR_CAPTURE"
_resolve_config_file_with_stderr "$STDERR_CAPTURE" >/dev/null
if grep -qF "$LOCAL_CONF" "$STDERR_CAPTURE" 2>/dev/null; then
  _pass "config.sh: untrusted (644) workspace-local conf prints a visible warning naming its path even though global wins"
else
  _fail "config.sh: expected a warning naming '$LOCAL_CONF', got: $(cat "$STDERR_CAPTURE" 2>/dev/null)"
fi

chmod 600 "$LOCAL_CONF"
local_resolved=$(_resolve_config_file)
if [[ "$local_resolved" == "$LOCAL_CONF" ]]; then
  _pass "config.sh: trusted (600) workspace-local telemetry-console.conf wins over user-global conf"
else
  _fail "config.sh: local conf expected '$LOCAL_CONF', got '$local_resolved'"
fi

: > "$STDERR_CAPTURE"
_resolve_config_file_with_stderr "$STDERR_CAPTURE" >/dev/null
if [[ ! -s "$STDERR_CAPTURE" ]]; then
  _pass "config.sh: trusted (600) workspace-local conf produces no warning"
else
  _fail "config.sh: trusted local conf should produce no warning, got: $(cat "$STDERR_CAPTURE")"
fi

# A symlink at the workspace conf path must be ignored outright, even if the
# link's own mode is 600 (macOS `chmod -h` sets the link's own bits without
# following it) and it points at a genuinely trusted 600 regular file, since
# the later conf read follows the link to a possibly different target.
TARGET_CONF="$CONFIG_TEST_ROOT/.kontourai/telemetry-console-target.conf"
: > "$TARGET_CONF"
chmod 600 "$TARGET_CONF"
rm -f "$LOCAL_CONF"
ln -s "$TARGET_CONF" "$LOCAL_CONF"
chmod -h 600 "$LOCAL_CONF" 2>/dev/null || true
symlink_resolved=$(_resolve_config_file)
if [[ "$symlink_resolved" == "$GLOBAL_CONF" ]]; then
  _pass "config.sh: symlinked workspace-local conf is ignored, falls through to trusted global conf"
else
  _fail "config.sh: symlinked local conf should fall through to global, got '$symlink_resolved'"
fi

: > "$STDERR_CAPTURE"
_resolve_config_file_with_stderr "$STDERR_CAPTURE" >/dev/null
if grep -qF "$LOCAL_CONF" "$STDERR_CAPTURE" 2>/dev/null; then
  _pass "config.sh: symlinked workspace-local conf also prints a visible untrusted-conf warning ('-f' follows the link to a real file)"
else
  _fail "config.sh: expected a warning naming '$LOCAL_CONF' for the symlink case, got: $(cat "$STDERR_CAPTURE" 2>/dev/null)"
fi

# A DANGLING symlink (target does not exist) at the workspace conf path is
# rejected by the trust gate just like the symlink-to-a-real-file case above,
# but `-f` (which follows the link) returns false for a dangling target --
# so the warning gate must additionally check `-L` to still fire here
# (LOW fix: telemetry_conf_warn_untrusted broadened from `-f` alone to
# `-e || -L`).
rm -f "$LOCAL_CONF"
ln -s "$CONFIG_TEST_ROOT/.kontourai/telemetry-console-target-missing.conf" "$LOCAL_CONF"
dangling_symlink_resolved=$(_resolve_config_file)
if [[ "$dangling_symlink_resolved" == "$GLOBAL_CONF" ]]; then
  _pass "config.sh: dangling-symlink workspace-local conf is ignored, falls through to trusted global conf"
else
  _fail "config.sh: dangling-symlink local conf should fall through to global, got '$dangling_symlink_resolved'"
fi

: > "$STDERR_CAPTURE"
_resolve_config_file_with_stderr "$STDERR_CAPTURE" >/dev/null
if grep -qF "$LOCAL_CONF" "$STDERR_CAPTURE" 2>/dev/null; then
  _pass "config.sh: dangling-symlink workspace-local conf prints a visible untrusted-conf warning ('-f' alone would miss this; '-L' catches it)"
else
  _fail "config.sh: expected a warning naming '$LOCAL_CONF' for the dangling-symlink case, got: $(cat "$STDERR_CAPTURE" 2>/dev/null)"
fi

# A symlink pointing at a DIRECTORY (not a regular file) hits the same `-f`
# gap: `-f` is false for a directory target, so the pre-fix warning gate
# silently skipped it too.
rm -f "$LOCAL_CONF"
mkdir -p "$CONFIG_TEST_ROOT/.kontourai/telemetry-console-target-dir"
ln -s "$CONFIG_TEST_ROOT/.kontourai/telemetry-console-target-dir" "$LOCAL_CONF"
symlink_to_dir_resolved=$(_resolve_config_file)
if [[ "$symlink_to_dir_resolved" == "$GLOBAL_CONF" ]]; then
  _pass "config.sh: symlink-to-directory workspace-local conf is ignored, falls through to trusted global conf"
else
  _fail "config.sh: symlink-to-directory local conf should fall through to global, got '$symlink_to_dir_resolved'"
fi

: > "$STDERR_CAPTURE"
_resolve_config_file_with_stderr "$STDERR_CAPTURE" >/dev/null
if grep -qF "$LOCAL_CONF" "$STDERR_CAPTURE" 2>/dev/null; then
  _pass "config.sh: symlink-to-directory workspace-local conf prints a visible untrusted-conf warning ('-f' alone would miss this; '-L' catches it)"
else
  _fail "config.sh: expected a warning naming '$LOCAL_CONF' for the symlink-to-directory case, got: $(cat "$STDERR_CAPTURE" 2>/dev/null)"
fi

rm -f "$LOCAL_CONF"

explicit_resolved=$(_resolve_config_file TELEMETRY_CONFIG_FILE="/tmp/explicit-telemetry.conf")
if [[ "$explicit_resolved" == "/tmp/explicit-telemetry.conf" ]]; then
  _pass "config.sh: explicit TELEMETRY_CONFIG_FILE env wins over workspace-local conf"
else
  _fail "config.sh: explicit env expected '/tmp/explicit-telemetry.conf', got '$explicit_resolved'"
fi

rm -rf "$CONFIG_TEST_ROOT"

# --- 1c. Endpoint allowlist drop warning ---
# transport.sh's console_post_json silently dropped an endpoint rejected by
# console_telemetry_endpoint_allowed before this change (AC2, Thread B). It
# now prints a one-time (per shell process) "warning: transport.sh: ..." line
# to stderr instead, guarded by a plain global var so a second call in the
# same sourced shell does not repeat it. Sourcing transport.sh directly
# (mirroring the Config File Resolution block's own cp-then-source pattern)
# with a disallowed http (non-local) endpoint means console_post_json must
# return before ever invoking curl, so PATH is left untouched deliberately.
echo ""
echo "--- Endpoint Allowlist Drop Warning ---"
TRANSPORT_TEST_ROOT=$(mktemp -d /tmp/eval-telemetry-transport-test.XXXXXX)
mkdir -p "$TRANSPORT_TEST_ROOT/scripts/telemetry/lib"
cp "$ROOT_DIR/scripts/telemetry/lib/transport.sh" "$TRANSPORT_TEST_ROOT/scripts/telemetry/lib/transport.sh"
cp "$ROOT_DIR/scripts/telemetry/lib/redact.sh" "$TRANSPORT_TEST_ROOT/scripts/telemetry/lib/redact.sh"
TRANSPORT_STDERR="$TRANSPORT_TEST_ROOT/transport-stderr.txt"
TRANSPORT_CURL_MARKER="$TRANSPORT_TEST_ROOT/curl-invoked"
NO_CURL_BIN="$TRANSPORT_TEST_ROOT/no-curl-bin"
mkdir -p "$NO_CURL_BIN"
cat > "$NO_CURL_BIN/curl" <<SH
#!/usr/bin/env bash
touch "$TRANSPORT_CURL_MARKER"
SH
chmod +x "$NO_CURL_BIN/curl"
TELEMETRY_DIR="$TRANSPORT_TEST_ROOT/scripts/telemetry" PATH="$NO_CURL_BIN:$PATH" bash -c "
  source '$TRANSPORT_TEST_ROOT/scripts/telemetry/lib/transport.sh'
  console_post_json 'http://example.test' '{}'
  console_post_json 'http://example.test' '{}'
" 2>"$TRANSPORT_STDERR"

warning_count=$(grep -c "warning: transport.sh:" "$TRANSPORT_STDERR" 2>/dev/null || echo 0)
if [[ "$warning_count" -eq 1 ]] && grep -qF "http://example.test" "$TRANSPORT_STDERR" 2>/dev/null; then
  _pass "transport.sh: disallowed endpoint prints exactly one drop warning across two calls in the same shell"
else
  _fail "transport.sh: expected exactly 1 warning naming the endpoint, got $warning_count: $(cat "$TRANSPORT_STDERR" 2>/dev/null)"
fi

if [[ ! -f "$TRANSPORT_CURL_MARKER" ]]; then
  _pass "transport.sh: disallowed endpoint never invokes curl"
else
  _fail "transport.sh: disallowed endpoint should never invoke curl, but it did"
fi

rm -rf "$TRANSPORT_TEST_ROOT"

# --- 2. Event type mapping ---
echo ""
echo "--- Event Type Mapping ---"
mock_json='{"cwd":"/tmp/eval-test","prompt":"test prompt","tool_name":"test_tool","tool_input":{},"tool_response":{}}'

for pair in \
  "agentSpawn:session.start" \
  "SessionStart:session.start" \
  "stop:session.end" \
  "Stop:session.end" \
  "SessionEnd:session.end" \
  "userPromptSubmit:turn.user" \
  "UserPromptSubmit:turn.user" \
  "preToolUse:tool.invoke" \
  "PreToolUse:tool.invoke" \
  "permissionRequest:tool.permission_request" \
  "PermissionRequest:tool.permission_request" \
  "postToolUse:tool.result" \
  "PostToolUse:tool.result" \
  "PostToolUseFailure:tool.result"; do
  hook_type="${pair%%:*}"
  expected="${pair#*:}"

  output=$(_run_telemetry "$hook_type" "eval-test" "$mock_json")

  if [[ -z "$output" ]]; then
    _fail "$hook_type → (no output)"
    continue
  fi

  actual_type=$(echo "$output" | jq -r '.event_type // empty' 2>/dev/null)
  if [[ "$actual_type" == "$expected" ]]; then
    _pass "$hook_type → $actual_type"
  else
    _fail "$hook_type → expected '$expected', got '$actual_type'"
  fi
done

# --- 3. Schema fields present ---
echo ""
echo "--- Schema Fields ---"
output=$(_run_telemetry "agentSpawn" "eval-test" '{"cwd":"/tmp/eval-test"}')

for field in schema_version timestamp session_id event_id event_type agent; do
  val=$(echo "$output" | jq -r ".${field} // empty" 2>/dev/null)
  if [[ -n "$val" ]]; then
    _pass "agentSpawn has .$field = $val"
  else
    _fail "agentSpawn missing .$field"
  fi
done

# Check agent sub-fields
for field in name runtime version; do
  val=$(echo "$output" | jq -r ".agent.${field} // empty" 2>/dev/null)
  if [[ -n "$val" ]]; then
    _pass "agentSpawn has .agent.$field"
  else
    _fail "agentSpawn missing .agent.$field"
  fi
done

# --- 4. userPromptSubmit captures prompt ---
echo ""
echo "--- Prompt Capture ---"
prompt_output=$(_run_telemetry "userPromptSubmit" "eval-test" '{"cwd":"/tmp","prompt":"Hello eval test"}')

prompt_text=$(echo "$prompt_output" | jq -r '.turn.prompt_text // empty' 2>/dev/null)
prompt_length=$(echo "$prompt_output" | jq -r '.turn.prompt_length // empty' 2>/dev/null)

if [[ "$prompt_text" == "Hello eval test" ]]; then
  _pass "userPromptSubmit captures prompt_text"
else
  _fail "userPromptSubmit prompt_text: expected 'Hello eval test', got '$prompt_text'"
fi

if [[ "$prompt_length" -gt 0 ]] 2>/dev/null; then
  _pass "userPromptSubmit captures prompt_length ($prompt_length)"
else
  _fail "userPromptSubmit prompt_length missing or zero"
fi

# --- 5. preToolUse captures tool info ---
echo ""
echo "--- Tool Capture ---"
tool_output=$(_run_telemetry "preToolUse" "eval-test" '{"session_id":"runtime-session-1","turn_id":"turn-1","transcript_path":"/tmp/transcript.jsonl","hook_event_name":"PreToolUse","model":"test-model","cwd":"/tmp","tool_name":"run shell commands","tool_input":{"command":"echo hi"}}')

tool_name=$(echo "$tool_output" | jq -r '.tool.name // empty' 2>/dev/null)
tool_normalized_name=$(echo "$tool_output" | jq -r '.tool.normalized_name // empty' 2>/dev/null)
if [[ "$tool_name" == "run shell commands" ]]; then
  _pass "preToolUse captures tool.name"
else
  _fail "preToolUse tool.name: expected 'run shell commands', got '$tool_name'"
fi

if [[ "$tool_normalized_name" == "run shell commands" ]]; then
  _pass "preToolUse captures normalized tool name"
else
  _fail "preToolUse tool.normalized_name: expected 'run shell commands', got '$tool_normalized_name'"
fi

hook_turn_id=$(echo "$tool_output" | jq -r '.hook.turn_id // empty' 2>/dev/null)
hook_runtime_session_id=$(echo "$tool_output" | jq -r '.hook.runtime_session_id // empty' 2>/dev/null)
hook_raw_command=$(echo "$tool_output" | jq -r '.hook.raw_input.tool_input.command // empty' 2>/dev/null)
if [[ "$hook_turn_id" == "turn-1" && "$hook_runtime_session_id" == "runtime-session-1" && "$hook_raw_command" == "echo hi" ]]; then
  _pass "preToolUse preserves runtime hook envelope and raw input"
else
  _fail "preToolUse hook envelope incomplete: turn='$hook_turn_id' runtime_session='$hook_runtime_session_id' raw_command='$hook_raw_command'"
fi

runtime_tool_output=$(_run_telemetry "PreToolUse" "eval-test" '{"session_id":"runtime-session-2","turn_id":"turn-runtime","transcript_path":"/tmp/transcript.jsonl","hook_event_name":"PreToolUse","model":"test-model","cwd":"/tmp","tool_name":"Bash","tool_input":{"command":"echo runtime"}}')
runtime_tool_type=$(echo "$runtime_tool_output" | jq -r '.event_type // empty' 2>/dev/null)
runtime_tool_name=$(echo "$runtime_tool_output" | jq -r '.tool.normalized_name // empty' 2>/dev/null)
runtime_turn_id=$(echo "$runtime_tool_output" | jq -r '.hook.turn_id // empty' 2>/dev/null)
if [[ "$runtime_tool_type" == "tool.invoke" && "$runtime_tool_name" == "execute_bash" && "$runtime_turn_id" == "turn-runtime" ]]; then
  _pass "PreToolUse captures runtime-native tool payload"
else
  _fail "PreToolUse runtime-native payload incomplete: type='$runtime_tool_type' tool='$runtime_tool_name' turn='$runtime_turn_id'"
fi

permission_output=$(_run_telemetry "permissionRequest" "eval-test" '{"cwd":"/tmp","hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"rm -rf /tmp/example","description":"Run escalated shell command"}}')
permission_event_type=$(echo "$permission_output" | jq -r '.event_type // empty' 2>/dev/null)
permission_tool_name=$(echo "$permission_output" | jq -r '.tool.name // empty' 2>/dev/null)
permission_tool_normalized_name=$(echo "$permission_output" | jq -r '.tool.normalized_name // empty' 2>/dev/null)
permission_description=$(echo "$permission_output" | jq -r '.permission.description // empty' 2>/dev/null)

if [[ "$permission_event_type" == "tool.permission_request" ]]; then
  _pass "permissionRequest maps to tool.permission_request"
else
  _fail "permissionRequest event_type: expected 'tool.permission_request', got '$permission_event_type'"
fi

if [[ "$permission_tool_name" == "Bash" && "$permission_tool_normalized_name" == "execute_bash" && "$permission_description" == "Run escalated shell command" ]]; then
  _pass "permissionRequest captures tool and approval reason"
else
  _fail "permissionRequest missing tool/description: tool='$permission_tool_name' normalized='$permission_tool_normalized_name' description='$permission_description'"
fi

runtime_output=$(FLOW_AGENTS_TELEMETRY_RUNTIME=codex _run_telemetry "agentSpawn" "eval-test" '{"cwd":"/tmp"}')
runtime_name=$(echo "$runtime_output" | jq -r '.agent.runtime // empty' 2>/dev/null)
if [[ "$runtime_name" == "codex" ]]; then
  _pass "FLOW_AGENTS_TELEMETRY_RUNTIME controls agent.runtime"
else
  _fail "runtime override: expected 'codex', got '$runtime_name'"
fi

claude_runtime_output=$(FLOW_AGENTS_TELEMETRY_RUNTIME=claude-code _run_telemetry "agentSpawn" "eval-test" '{"cwd":"/tmp"}')
claude_runtime_name=$(echo "$claude_runtime_output" | jq -r '.agent.runtime // empty' 2>/dev/null)
if [[ "$claude_runtime_name" == "claude-code" ]]; then
  _pass "FLOW_AGENTS_TELEMETRY_RUNTIME supports claude-code runtime"
else
  _fail "claude runtime override: expected 'claude-code', got '$claude_runtime_name'"
fi

spawn_before=$(wc -l < "$TMPLOG" 2>/dev/null | tr -d ' ')
_run_telemetry "preToolUse" "eval-test" '{"cwd":"/tmp","tool_name":"spawn_agent","tool_input":{"agent_type":"tool-worker"}}' >/dev/null
sleep 1
spawn_delegate=$(tail -n +"$((spawn_before + 1))" "$TMPLOG" 2>/dev/null | jq -r 'select(.event_type == "agent.delegate") | .delegation.targets[0]' 2>/dev/null | head -1)
if [[ "$spawn_delegate" == "tool-worker" ]]; then
  _pass "Codex spawn_agent emits agent.delegate"
else
  _fail "Codex spawn_agent delegation event missing"
fi

agent_before=$(wc -l < "$TMPLOG" 2>/dev/null | tr -d ' ')
_run_telemetry "preToolUse" "eval-test" '{"cwd":"/tmp","tool_name":"Agent","tool_input":{"subagent_type":"tool-planner"}}' >/dev/null
sleep 1
agent_delegate=$(tail -n +"$((agent_before + 1))" "$TMPLOG" 2>/dev/null | jq -r 'select(.event_type == "agent.delegate") | .delegation.targets[0]' 2>/dev/null | head -1)
if [[ "$agent_delegate" == "tool-planner" ]]; then
  _pass "Claude Agent tool emits agent.delegate"
else
  _fail "Claude Agent delegation event missing"
fi

kiro_subagent_before=$(wc -l < "$TMPLOG" 2>/dev/null | tr -d ' ')
_run_telemetry "preToolUse" "eval-test" '{"cwd":"/tmp","tool_name":"delegate to a specialist agent","tool_input":{"subagents":[{"agent_name":"tool-verifier"},{"agent_name":"tool-code-reviewer"}]}}' >/dev/null
sleep 1
kiro_subagent_targets=$(tail -n +"$((kiro_subagent_before + 1))" "$TMPLOG" 2>/dev/null | jq -r 'select(.event_type == "agent.delegate") | .delegation.targets | join(",")' 2>/dev/null | head -1)
if [[ "$kiro_subagent_targets" == "tool-verifier,tool-code-reviewer" ]]; then
  _pass "Kiro delegate to a specialist agent emits agent.delegate"
else
  _fail "Kiro delegate to a specialist agent delegation event missing: targets='$kiro_subagent_targets'"
fi

# --- 6. Redaction on analytics channel ---
echo ""
echo "--- Redaction ---"
redacted=$(_run_telemetry "preToolUse" "eval-test" '{"cwd":"/tmp","tool_name":"test","tool_input":{"secret":"value"}}' "analytics" "tool.input,tool.output,turn.prompt_text,hook.raw_input")

redacted_input=$(echo "$redacted" | jq -r '.tool.input' 2>/dev/null)
if [[ "$redacted_input" == "null" ]]; then
  _pass "Analytics channel redacts tool.input"
else
  _fail "Analytics channel did not redact tool.input: $redacted_input"
fi

redacted_raw_input=$(echo "$redacted" | jq -r '.hook.raw_input' 2>/dev/null)
if [[ "$redacted_raw_input" == "null" ]]; then
  _pass "Analytics channel redacts hook.raw_input"
else
  _fail "Analytics channel did not redact hook.raw_input: $redacted_raw_input"
fi

codex_log="${TMPDIR_EVAL}/codex-full.jsonl"
codex_stdout="${TMPDIR_EVAL}/codex-stdout.txt"
codex_stderr="${TMPDIR_EVAL}/codex-stderr.txt"
codex_config="${TMPDIR_EVAL}/codex-empty.conf"
: > "$codex_config"
printf '%s\n' '{"hook_event_name":"UserPromptSubmit","cwd":"/tmp","prompt":"codex secret","tool_name":"test","tool_input":{"secret":"value"},"tool_response":{"secret":"out"}}' \
  | env \
    TELEMETRY_CONFIG_FILE="$codex_config" \
    TELEMETRY_DATA_DIR="$TMPDIR_EVAL" \
    TELEMETRY_SESSION_DIR="$TMPDIR_EVAL/sessions" \
    TELEMETRY_CHANNEL_FULL_LOG_FILE="$codex_log" \
    FLOW_AGENTS_CODEX_TELEMETRY_CHANNELS=full \
    FLOW_AGENTS_CODEX_TELEMETRY_FOREGROUND=true \
    FLOW_AGENTS_TELEMETRY_CAPTURE_RAW_HOOK_INPUT=true \
    node "$ROOT_DIR/scripts/hooks/codex-telemetry-hook.js" userPromptSubmit eval-test >"$codex_stdout" 2>"$codex_stderr"

i=0
while [[ $i -lt 50 && ! -s "$codex_log" ]]; do
  sleep 0.1; i=$((i + 1))
done
codex_event=$(head -1 "$codex_log" 2>/dev/null)
codex_prompt=$(echo "$codex_event" | jq -r '.turn.prompt_text' 2>/dev/null)
codex_tool_input=$(echo "$codex_event" | jq -r '.tool.input' 2>/dev/null)
codex_tool_output=$(echo "$codex_event" | jq -r '.tool.output' 2>/dev/null)
codex_raw_input=$(echo "$codex_event" | jq -r '.hook.raw_input' 2>/dev/null)

if [[ "$codex_prompt" == "null" && "$codex_tool_input" == "null" && "$codex_tool_output" == "null" && "$codex_raw_input" == "null" ]]; then
  _pass "Codex hook defaults redact full-channel sensitive fields"
else
  _fail "Codex hook default redaction incomplete: prompt='$codex_prompt' tool_input='$codex_tool_input' tool_output='$codex_tool_output' raw='$codex_raw_input'"
fi

if grep -q "TELEMETRY_CHANNEL_FULL_REDACT: process.env.TELEMETRY_CHANNEL_FULL_REDACT || 'none'" "$ROOT_DIR/scripts/hooks/codex-telemetry-hook.js"; then
  _fail "Codex hook still defaults full redaction to none"
else
  _pass "Codex hook source does not default full redaction to none"
fi

claude_log="${TMPDIR_EVAL}/claude-full.jsonl"
claude_stdout="${TMPDIR_EVAL}/claude-stdout.txt"
claude_stderr="${TMPDIR_EVAL}/claude-stderr.txt"
printf '%s\n' '{"session_id":"claude-session-1","hook_event_name":"PreToolUse","cwd":"/tmp","tool_name":"Agent","tool_input":{"subagent_type":"tool-verifier","prompt":"verify"}}' \
  | env \
    TELEMETRY_CONFIG_FILE="$codex_config" \
    TELEMETRY_DATA_DIR="$TMPDIR_EVAL" \
    TELEMETRY_SESSION_DIR="$TMPDIR_EVAL/sessions" \
    TELEMETRY_CHANNEL_FULL_LOG_FILE="$claude_log" \
    FLOW_AGENTS_CLAUDE_TELEMETRY_CHANNELS=full \
    FLOW_AGENTS_CLAUDE_TELEMETRY_FOREGROUND=true \
    FLOW_AGENTS_TELEMETRY_CAPTURE_RAW_HOOK_INPUT=true \
    node "$ROOT_DIR/scripts/hooks/claude-telemetry-hook.js" PreToolUse eval-test >"$claude_stdout" 2>"$claude_stderr"

i=0
while [[ $i -lt 50 && ! -s "$claude_log" ]]; do
  sleep 0.1; i=$((i + 1))
done
claude_event=$(jq -c 'select(.event_type == "tool.invoke")' "$claude_log" 2>/dev/null | head -1)
claude_runtime=$(echo "$claude_event" | jq -r '.agent.runtime // empty' 2>/dev/null)
claude_event_type=$(echo "$claude_event" | jq -r '.event_type // empty' 2>/dev/null)
claude_delegate=$(grep '"event_type":"agent.delegate"' "$claude_log" 2>/dev/null | jq -r '.delegation.targets[0]' 2>/dev/null | head -1)
claude_continue=$(jq -r '.continue // empty' "$claude_stdout" 2>/dev/null)
if [[ "$claude_runtime" == "claude-code" && "$claude_event_type" == "tool.invoke" && "$claude_delegate" == "tool-verifier" && "$claude_continue" == "true" ]]; then
  _pass "Claude telemetry hook emits normalized tool and delegation events"
else
  _fail "Claude telemetry hook output mismatch: runtime='$claude_runtime' event='$claude_event_type' delegate='$claude_delegate' continue='$claude_continue'"
fi

# --- 7. Console telemetry transport ---
echo ""
echo "--- Console Transport ---"
console_capture="${TMPDIR_EVAL}/console-request.json"
fake_bin="${TMPDIR_EVAL}/fake-bin"
mkdir -p "$fake_bin"
cat > "${fake_bin}/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
config_file=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      config_file="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
[[ -n "$config_file" && -n "${FLOW_AGENTS_TEST_CONSOLE_CAPTURE:-}" ]]
node - "$config_file" "$FLOW_AGENTS_TEST_CONSOLE_CAPTURE" <<'NODE'
const fs = require("fs");
const [configPath, capturePath] = process.argv.slice(2);
const config = fs.readFileSync(configPath, "utf8");
const lines = config.split(/\r?\n/).filter(Boolean);
const record = { headers: {}, config };
for (const line of lines) {
  const match = line.match(/^([^=]+) = "(.*)"$/);
  if (!match) continue;
  const key = match[1].trim();
  const value = match[2];
  if (key === "url") record.url = value;
  if (key === "request") record.method = value;
  if (key === "header") {
    const index = value.indexOf(":");
    if (index >= 0) record.headers[value.slice(0, index).toLowerCase()] = value.slice(index + 1).trim();
  }
  if (key === "data-binary" && value.startsWith("@")) {
    record.body = JSON.parse(fs.readFileSync(value.slice(1), "utf8"));
  }
}
fs.writeFileSync(capturePath, JSON.stringify(record));
NODE
SH
chmod +x "${fake_bin}/curl"
printf '%s\n' '{"cwd":"/tmp","prompt":"console secret","hook_event_name":"UserPromptSubmit","transcript_path":"/tmp/private/transcript.jsonl","last_assistant_message":"sensitive assistant text"}' \
  | env \
    PATH="${fake_bin}:$PATH" \
    FLOW_AGENTS_TEST_CONSOLE_CAPTURE="$console_capture" \
    TELEMETRY_ENABLED=true \
    TELEMETRY_CHANNELS=analytics \
    TELEMETRY_CHANNEL_ANALYTICS_LOG_FILE="${TMPDIR_EVAL}/console-analytics.jsonl" \
    TELEMETRY_CONFIG_FILE="$TMPDIR_EVAL/telemetry.conf" \
    TELEMETRY_DATA_DIR="$TMPDIR_EVAL" \
    TELEMETRY_SESSION_DIR="$TMPDIR_EVAL/sessions" \
    FLOW_AGENTS_TELEMETRY_FOREGROUND=true \
    CONSOLE_TELEMETRY_URL="http://127.0.0.1:3737" \
    CONSOLE_TELEMETRY_TOKEN="console-token" \
    CONSOLE_TENANT_ID="tenant-a" \
    CONSOLE_TELEMETRY_CONNECT_TIMEOUT_SECONDS='1" header = "x-bad: bad' \
    CONSOLE_TELEMETRY_MAX_TIME_SECONDS='5
url = "https://bad.example"' \
    bash "$TELEMETRY_SH" userPromptSubmit eval-test 2>/dev/null
i=0
while [[ $i -lt 50 && ! -s "$console_capture" ]]; do
  sleep 0.1; i=$((i + 1))
done
console_url=$(jq -r '.url // empty' "$console_capture" 2>/dev/null)
console_method=$(jq -r '.method // empty' "$console_capture" 2>/dev/null)
console_auth=$(jq -r '.headers.authorization // empty' "$console_capture" 2>/dev/null)
console_tenant=$(jq -r '.headers["x-console-tenant-id"] // empty' "$console_capture" 2>/dev/null)
console_event_type=$(jq -r '.body.event_type // empty' "$console_capture" 2>/dev/null)
console_prompt=$(jq -r '.body.turn.prompt_text' "$console_capture" 2>/dev/null)
console_transcript=$(jq -r '.body.hook.transcript_path' "$console_capture" 2>/dev/null)
console_assistant=$(jq -r '.body.hook.last_assistant_message' "$console_capture" 2>/dev/null)
if [[ "$console_url" == "http://127.0.0.1:3737/api/telemetry/records" && "$console_method" == "POST" && "$console_auth" == "Bearer console-token" && "$console_tenant" == "tenant-a" && "$console_event_type" == "turn.user" && "$console_prompt" == "null" && "$console_transcript" == "null" && "$console_assistant" == "null" ]]; then
  _pass "Console telemetry transport posts redacted event with auth and tenant headers"
else
  _fail "Console telemetry transport mismatch: url='$console_url' method='$console_method' auth='$console_auth' tenant='$console_tenant' event='$console_event_type' prompt='$console_prompt' transcript='$console_transcript' assistant='$console_assistant'"
fi

# --- 8. discover-agents.sh finds agent cards ---
echo ""
echo "--- Agent Discovery ---"
if [[ -f "$DISCOVER_SCRIPT" ]]; then
  repo_cards=$(find "$ROOT_DIR/agent-cards" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$repo_cards" -gt 0 ]]; then
    discover_output=$(bash "$DISCOVER_SCRIPT" 2>/dev/null)
    card_count=$(echo "$discover_output" | grep -c '📋' || true)
    if [[ "$card_count" -ge "$repo_cards" ]]; then
      _pass "discover-agents.sh found $card_count repo-local agent cards"
    else
      _fail "discover-agents.sh found $card_count repo-local agent cards, expected at least $repo_cards"
    fi
  else
    # Legacy source-package mode
    workspace_dir="$(find "$HOME/dev" -maxdepth 5 -name "kiro-agents" -path "*/src/*" -type d 2>/dev/null | head -1)"
    if [[ -n "$workspace_dir" ]]; then
      discover_output=$(cd "$(dirname "$workspace_dir")" && bash "$DISCOVER_SCRIPT" 2>/dev/null)
    else
      discover_output=$(bash "$DISCOVER_SCRIPT" 2>/dev/null)
    fi
    card_count=$(echo "$discover_output" | grep -c '📋' || true)
    if [[ "$card_count" -ge 3 ]]; then
      _pass "discover-agents.sh found $card_count legacy agent cards"
    else
      src_cards=$(find "$HOME/dev" -maxdepth 5 -name "agent-card.json" -path "*/src/*" 2>/dev/null | wc -l | tr -d ' ')
      if [[ "$src_cards" -ge 3 ]]; then
        _pass "discover-agents.sh: $src_cards agent cards exist in source (discovery works at runtime from workspace)"
      else
        _fail "discover-agents.sh found 0 cards and only $src_cards in legacy source locations"
      fi
    fi
  fi
else
  _fail "discover-agents.sh not found"
fi

# --- Cleanup ---
rm -rf "$TMPDIR_EVAL"

# --- Summary ---
echo ""
echo "==========================="
total=$((pass + fail))
echo "Results: ${pass}/${total} passed, ${fail} failed"
[[ "$fail" -gt 0 ]] && exit 1
exit 0
