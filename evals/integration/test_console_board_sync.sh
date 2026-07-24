#!/usr/bin/env bash
# test_console_board_sync.sh — hook-native console board sync (#919): detached,
# cwd-scoped projection+bridge of local flow-agents workflow state onto a hosted Kontour
# console board, gated on the resolved telemetry config carrying BOTH console_telemetry_url
# and a token.
#
# Proves:
#   - no config (or only one of url/token) -> exits 0, ZERO side effects: no
#     console-board-sync.log written, no flow-agents CLI or npx bridge invoked at all.
#   - config present -> attempts the full pipeline: console-process-projection --skip-invalid
#     (#918) then console-trust-projection (via this repo's own build/src/cli.js when
#     present, cwd-scoped to the target repo), then bridges both envelopes via npx
#     kontour-process-bridge/kontour-trust-bridge --no-local --hub <url> [--tenant <id>],
#     with CONSOLE_AUTH_TOKEN set for each bridge subprocess and never logged/echoed.
#   - each pipeline step is fail-soft: a step failure is logged and the pipeline continues;
#     the script's own exit code stays 0.
#   - graceful trust-bridge degradation: an npx "command not found" (bin absent from the
#     resolved @kontourai/console version) is logged as a SKIP, not a FAILURE; any other
#     non-zero trust-bridge exit IS logged as a real failure.
#   - flow-agents CLI resolution: this repo's own build/src/cli.js when present, else a
#     log-skip (not a crash) when no CLI resolves at all.
#   - npx unavailable -> both bridge steps are log-skipped; projections still ran.
#
# Deterministic (a fake flow-agents CLI + a fake npx stand-in on PATH; no real network / npm
# registry access). Uses ONLY scratch tmp dirs -- never the running machine's durable
# .kontourai roots or ~/.flow-agents conf.
# Usage: bash evals/integration/test_console_board_sync.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/telemetry/console-board-sync.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

errors=0
pass() { echo "  [PASS] $1"; }
fail() { echo "  [FAIL] $1"; errors=$((errors + 1)); }

if ! command -v jq >/dev/null 2>&1; then echo "jq not available; skipping console board sync tests"; exit 0; fi

echo "=== console board sync (#919) ==="

# ── fixtures: a scratch "repo" with a fake flow-agents CLI, and a fake npx on PATH ─────────
FAKE_REPO="$TMP/fake-repo"
mkdir -p "$FAKE_REPO/build/src"
CLI_LOG="$TMP/cli-invocations.log"
: > "$CLI_LOG"
cat > "$FAKE_REPO/build/src/cli.js" <<'NODE'
#!/usr/bin/env node
// Fake flow-agents CLI for console-board-sync.sh integration tests. Records its own argv,
// then exits with a controllable per-subcommand code (default 0).
const fs = require('fs');
const logFile = process.env.FAKE_CLI_LOG;
const args = process.argv.slice(2);
fs.appendFileSync(logFile, JSON.stringify(args) + '\n');
const sub = args[0];
let code = 0;
if (sub === 'console-process-projection') code = Number(process.env.FAKE_CLI_PROCESS_EXIT || 0);
if (sub === 'console-trust-projection') code = Number(process.env.FAKE_CLI_TRUST_EXIT || 0);
process.exit(code);
NODE
chmod +x "$FAKE_REPO/build/src/cli.js"

FAKE_BIN="$TMP/fake-bin"
mkdir -p "$FAKE_BIN"
NPX_LOG="$TMP/npx-invocations.log"
: > "$NPX_LOG"
cat > "$FAKE_BIN/npx" <<'SH'
#!/usr/bin/env bash
# Fake npx for console-board-sync.sh integration tests. Records every invocation's argv
# (and whether CONSOLE_AUTH_TOKEN matched the case's expected value -- never its literal
# value) to NPX_LOG, then simulates kontour-process-bridge/kontour-trust-bridge exit
# behavior per FAKE_NPX_* env vars.
LOG="${NPX_LOG:?NPX_LOG not set}"
token_marker="unset"
if [[ -n "${CONSOLE_AUTH_TOKEN:-}" ]]; then
  if [[ "$CONSOLE_AUTH_TOKEN" == "${FAKE_EXPECTED_TOKEN:-}" ]]; then token_marker="expected"; else token_marker="unexpected"; fi
fi
printf '%s|token=%s\n' "$*" "$token_marker" >> "$LOG"
bin=""
for a in "$@"; do
  case "$a" in
    kontour-process-bridge|kontour-trust-bridge) bin="$a" ;;
  esac
done
if [[ "$bin" == "kontour-process-bridge" ]]; then
  exit "${FAKE_NPX_PROCESS_BRIDGE_EXIT:-0}"
elif [[ "$bin" == "kontour-trust-bridge" ]]; then
  case "${FAKE_NPX_TRUST_BRIDGE_MODE:-ok}" in
    ok) exit 0 ;;
    not-found) echo "sh: line 1: kontour-trust-bridge: command not found" >&2; exit 127 ;;
    fail) echo "kontour-trust-bridge: some real runtime error" >&2; exit 1 ;;
  esac
fi
exit 0
SH
chmod +x "$FAKE_BIN/npx"

CLEAN_HOME="$TMP/clean-home"
mkdir -p "$CLEAN_HOME"
EMPTY_CONF="$TMP/empty-telemetry.conf"
: > "$EMPTY_CONF"

# run_sync <case-label> [extra env assignments already exported by caller]
# Runs console-board-sync.sh with the shared hermetic isolation (scratch HOME, scratch
# TELEMETRY_WORKSPACE_ROOT/DATA_DIR/SESSION_DIR -- NEVER this repo's own durable .kontourai
# or the operator's real ~/.flow-agents conf). Callers export case-specific PATH/
# TELEMETRY_CONFIG_FILE/FAKE_*/CONSOLE_TENANT_ID etc. before calling.
run_sync() {
  local data_dir="$1"
  HOME="$CLEAN_HOME" \
  TELEMETRY_WORKSPACE_ROOT="${CASE_REPO:-$FAKE_REPO}" \
  TELEMETRY_DATA_DIR="$data_dir" \
  TELEMETRY_SESSION_DIR="$data_dir/sessions" \
  FAKE_CLI_LOG="$CLI_LOG" \
  NPX_LOG="$NPX_LOG" \
  bash "$SCRIPT"
}

# ── gating: no config at all -> exit 0, zero side effects ──────────────────────────────────
echo "--- gating: no console sink configured -> exit 0, no log file, no CLI/npx invocation ---"
DATA_A="$TMP/data-caseA"
: > "$CLI_LOG"; : > "$NPX_LOG"
( export PATH="$FAKE_BIN:$PATH" TELEMETRY_CONFIG_FILE="$EMPTY_CONF"
  unset CONSOLE_TELEMETRY_URL CONSOLE_TELEMETRY_TOKEN CONSOLE_AUTH_TOKEN CONSOLE_TENANT_ID CONSOLE_URL
  run_sync "$DATA_A" )
rc=$?
[[ "$rc" -eq 0 ]] && pass "no config: exits 0" || fail "no config: exited $rc"
[[ ! -f "$DATA_A/console-board-sync.log" ]] && pass "no config: no console-board-sync.log written" || fail "no config: a log file was written despite no config"
[[ ! -s "$CLI_LOG" ]] && pass "no config: flow-agents CLI never invoked" || fail "no config: CLI was invoked despite no config"
[[ ! -s "$NPX_LOG" ]] && pass "no config: npx bridges never invoked" || fail "no config: npx was invoked despite no config"

# ── gating: URL only, no token -> still gated off ───────────────────────────────────────────
echo "--- gating: console_telemetry_url present but NO token -> still exit 0, no side effects ---"
DATA_B="$TMP/data-caseB"
URL_ONLY_CONF="$TMP/url-only.conf"
printf 'console_telemetry_url=http://127.0.0.1:39001\n' > "$URL_ONLY_CONF"
: > "$CLI_LOG"; : > "$NPX_LOG"
( export PATH="$FAKE_BIN:$PATH" TELEMETRY_CONFIG_FILE="$URL_ONLY_CONF"
  unset CONSOLE_TELEMETRY_TOKEN CONSOLE_AUTH_TOKEN
  run_sync "$DATA_B" )
rc=$?
[[ "$rc" -eq 0 ]] && pass "url-only: exits 0" || fail "url-only: exited $rc"
[[ ! -f "$DATA_B/console-board-sync.log" ]] && pass "url-only: no log file written" || fail "url-only: a log file was written with no token"
[[ ! -s "$CLI_LOG" ]] && pass "url-only: CLI never invoked" || fail "url-only: CLI was invoked with no token"

# ── gating: token only, no URL -> still gated off ───────────────────────────────────────────
echo "--- gating: token present but NO console_telemetry_url -> still exit 0, no side effects ---"
DATA_C="$TMP/data-caseC"
TOKEN_ONLY_CONF="$TMP/token-only.conf"
printf 'console_telemetry_token=some-token\n' > "$TOKEN_ONLY_CONF"
: > "$CLI_LOG"; : > "$NPX_LOG"
( export PATH="$FAKE_BIN:$PATH" TELEMETRY_CONFIG_FILE="$TOKEN_ONLY_CONF"
  unset CONSOLE_TELEMETRY_URL CONSOLE_URL
  run_sync "$DATA_C" )
rc=$?
[[ "$rc" -eq 0 ]] && pass "token-only: exits 0" || fail "token-only: exited $rc"
[[ ! -f "$DATA_C/console-board-sync.log" ]] && pass "token-only: no log file written" || fail "token-only: a log file was written with no URL"
[[ ! -s "$CLI_LOG" ]] && pass "token-only: CLI never invoked" || fail "token-only: CLI was invoked with no URL"

# ── happy path: both configured -> full pipeline attempted, exit 0 ─────────────────────────
echo "--- happy path: console_telemetry_url + token configured -> full pipeline runs ---"
FULL_CONF="$TMP/full.conf"
cat > "$FULL_CONF" <<CONF
console_telemetry_url=http://127.0.0.1:39002
console_telemetry_token=test-token-xyz
console_tenant_id=test-tenant
CONF
DATA_D="$TMP/data-caseD"
: > "$CLI_LOG"; : > "$NPX_LOG"
( export PATH="$FAKE_BIN:$PATH" TELEMETRY_CONFIG_FILE="$FULL_CONF" FAKE_EXPECTED_TOKEN="test-token-xyz"
  unset CONSOLE_AUTH_TOKEN
  run_sync "$DATA_D" )
rc=$?
[[ "$rc" -eq 0 ]] && pass "happy path: exits 0" || fail "happy path: exited $rc"
LOG_D="$DATA_D/console-board-sync.log"
[[ -f "$LOG_D" ]] && pass "happy path: console-board-sync.log written" || fail "happy path: no log file written"
grep -q 'console-process-projection OK' "$LOG_D" && pass "happy path: console-process-projection OK logged" || fail "happy path: console-process-projection OK not logged"
grep -q 'console-trust-projection OK' "$LOG_D" && pass "happy path: console-trust-projection OK logged" || fail "happy path: console-trust-projection OK not logged"
grep -q 'kontour-process-bridge OK' "$LOG_D" && pass "happy path: kontour-process-bridge OK logged" || fail "happy path: kontour-process-bridge OK not logged"
grep -q 'kontour-trust-bridge OK' "$LOG_D" && pass "happy path: kontour-trust-bridge OK logged" || fail "happy path: kontour-trust-bridge OK not logged"
grep -q 'test-token-xyz' "$LOG_D" && fail "happy path: the raw console auth token appears in the log file" || pass "happy path: the console auth token is never written to the log file"

CLI_ARGS_1="$(sed -n '1p' "$CLI_LOG")"
CLI_ARGS_2="$(sed -n '2p' "$CLI_LOG")"
echo "$CLI_ARGS_1" | jq -e '.[0]=="console-process-projection" and (index("--skip-invalid")!=null) and (index("--scope")!=null)' >/dev/null 2>&1 \
  && pass "happy path: console-process-projection invoked with --skip-invalid (#918) and --scope" \
  || fail "happy path: console-process-projection args unexpected: $CLI_ARGS_1"
echo "$CLI_ARGS_2" | jq -e '.[0]=="console-trust-projection" and (index("--scope")!=null)' >/dev/null 2>&1 \
  && pass "happy path: console-trust-projection invoked with --scope" \
  || fail "happy path: console-trust-projection args unexpected: $CLI_ARGS_2"

NPX_ARGS_1="$(sed -n '1p' "$NPX_LOG")"
NPX_ARGS_2="$(sed -n '2p' "$NPX_LOG")"
[[ "$NPX_ARGS_1" == *"kontour-process-bridge"* && "$NPX_ARGS_1" == *"--no-local"* && "$NPX_ARGS_1" == *"--hub http://127.0.0.1:39002"* && "$NPX_ARGS_1" == *"--tenant test-tenant"* ]] \
  && pass "happy path: kontour-process-bridge invoked with --no-local --hub --tenant" \
  || fail "happy path: process bridge args unexpected: $NPX_ARGS_1"
[[ "$NPX_ARGS_1" == *"token=expected"* ]] && pass "happy path: CONSOLE_AUTH_TOKEN set correctly for process bridge subprocess" || fail "happy path: process bridge did not see the expected CONSOLE_AUTH_TOKEN"
[[ "$NPX_ARGS_2" == *"kontour-trust-bridge"* && "$NPX_ARGS_2" == *"--no-local"* ]] \
  && pass "happy path: kontour-trust-bridge invoked with --no-local" \
  || fail "happy path: trust bridge args unexpected: $NPX_ARGS_2"
[[ "$NPX_ARGS_2" == *"token=expected"* ]] && pass "happy path: CONSOLE_AUTH_TOKEN set correctly for trust bridge subprocess" || fail "happy path: trust bridge did not see the expected CONSOLE_AUTH_TOKEN"

# ── graceful degradation: kontour-trust-bridge bin not published yet -> SKIP, not FAILED ───
echo "--- graceful degradation: kontour-trust-bridge absent from this @kontourai/console version -> log-skip, not a failure ---"
DATA_E="$TMP/data-caseE"
: > "$CLI_LOG"; : > "$NPX_LOG"
( export PATH="$FAKE_BIN:$PATH" TELEMETRY_CONFIG_FILE="$FULL_CONF" FAKE_EXPECTED_TOKEN="test-token-xyz" FAKE_NPX_TRUST_BRIDGE_MODE="not-found"
  unset CONSOLE_AUTH_TOKEN
  run_sync "$DATA_E" )
rc=$?
[[ "$rc" -eq 0 ]] && pass "trust-bridge-absent: script still exits 0" || fail "trust-bridge-absent: exited $rc"
LOG_E="$DATA_E/console-board-sync.log"
grep -q 'SKIP kontour-trust-bridge' "$LOG_E" && pass "trust-bridge-absent: logged as a SKIP" || fail "trust-bridge-absent: not logged as a SKIP: $(cat "$LOG_E" 2>/dev/null)"
grep -q 'kontour-trust-bridge FAILED' "$LOG_E" && fail "trust-bridge-absent: wrongly logged as a FAILED" || pass "trust-bridge-absent: not logged as a FAILED"
grep -q 'kontour-process-bridge OK' "$LOG_E" && pass "trust-bridge-absent: process bridge still ran fine" || fail "trust-bridge-absent: process bridge did not run"

# ── real trust-bridge failure -> FAILED, not SKIP, still fail-soft (exit 0) ────────────────
echo "--- real trust-bridge runtime failure -> logged as FAILED (not a SKIP), still fail-soft ---"
DATA_F="$TMP/data-caseF"
: > "$CLI_LOG"; : > "$NPX_LOG"
( export PATH="$FAKE_BIN:$PATH" TELEMETRY_CONFIG_FILE="$FULL_CONF" FAKE_EXPECTED_TOKEN="test-token-xyz" FAKE_NPX_TRUST_BRIDGE_MODE="fail"
  unset CONSOLE_AUTH_TOKEN
  run_sync "$DATA_F" )
rc=$?
[[ "$rc" -eq 0 ]] && pass "trust-bridge-real-failure: script still exits 0 (fail-soft)" || fail "trust-bridge-real-failure: exited $rc"
LOG_F="$DATA_F/console-board-sync.log"
grep -q 'kontour-trust-bridge FAILED' "$LOG_F" && pass "trust-bridge-real-failure: logged as FAILED" || fail "trust-bridge-real-failure: not logged as FAILED: $(cat "$LOG_F" 2>/dev/null)"
grep -q 'SKIP kontour-trust-bridge' "$LOG_F" && fail "trust-bridge-real-failure: wrongly logged as a SKIP" || pass "trust-bridge-real-failure: not logged as a SKIP"

# ── process-projection failure -> logged, pipeline continues to trust-projection + bridges ──
echo "--- console-process-projection failure -> logged, pipeline continues (fail-soft) ---"
DATA_G="$TMP/data-caseG"
: > "$CLI_LOG"; : > "$NPX_LOG"
( export PATH="$FAKE_BIN:$PATH" TELEMETRY_CONFIG_FILE="$FULL_CONF" FAKE_EXPECTED_TOKEN="test-token-xyz" FAKE_CLI_PROCESS_EXIT="1"
  unset CONSOLE_AUTH_TOKEN
  run_sync "$DATA_G" )
rc=$?
[[ "$rc" -eq 0 ]] && pass "process-projection-failure: script still exits 0" || fail "process-projection-failure: exited $rc"
LOG_G="$DATA_G/console-board-sync.log"
grep -q 'console-process-projection FAILED' "$LOG_G" && pass "process-projection-failure: logged as FAILED" || fail "process-projection-failure: not logged as FAILED"
grep -q 'console-trust-projection OK' "$LOG_G" && pass "process-projection-failure: pipeline continued to trust-projection" || fail "process-projection-failure: pipeline did not continue"
grep -q 'kontour-process-bridge OK' "$LOG_G" && pass "process-projection-failure: pipeline continued to the bridge steps" || fail "process-projection-failure: pipeline did not reach the bridge steps"

# ── no flow-agents CLI resolvable -> log-skip, no bridges attempted ────────────────────────
echo "--- no flow-agents CLI resolvable -> log-skip, exit 0, no bridge attempted ---"
NO_CLI_REPO="$TMP/no-cli-repo"
mkdir -p "$NO_CLI_REPO"
NO_FLOW_AGENTS_BIN="$TMP/no-flow-agents-bin"
mkdir -p "$NO_FLOW_AGENTS_BIN"
DATA_H="$TMP/data-caseH"
: > "$CLI_LOG"; : > "$NPX_LOG"
( export CASE_REPO="$NO_CLI_REPO"
  export PATH="$NO_FLOW_AGENTS_BIN:$FAKE_BIN:$PATH" TELEMETRY_CONFIG_FILE="$FULL_CONF" FAKE_EXPECTED_TOKEN="test-token-xyz"
  unset CONSOLE_AUTH_TOKEN
  run_sync "$DATA_H" )
rc=$?
[[ "$rc" -eq 0 ]] && pass "no-cli: script still exits 0" || fail "no-cli: exited $rc"
LOG_H="$DATA_H/console-board-sync.log"
[[ -f "$LOG_H" ]] && grep -q 'SKIP: no flow-agents CLI found' "$LOG_H" && pass "no-cli: logged as a SKIP naming the CLI search" || fail "no-cli: expected SKIP log not found: $(cat "$LOG_H" 2>/dev/null)"
[[ ! -s "$NPX_LOG" ]] && pass "no-cli: npx never invoked (nothing to bridge)" || fail "no-cli: npx was invoked despite no CLI"

# ── npx unavailable -> both bridges log-skipped, projections still ran ─────────────────────
echo "--- npx unavailable -> bridge steps log-skipped; projections still ran ---"
NO_NPX_BIN="$TMP/no-npx-bin"
mkdir -p "$NO_NPX_BIN"
IFS=':' read -ra path_dirs <<< "$PATH"
for d in "${path_dirs[@]}"; do
  [[ -d "$d" ]] || continue
  for f in "$d"/*; do
    [[ -f "$f" && -x "$f" ]] || continue
    name="$(basename "$f")"
    [[ "$name" == "npx" ]] && continue
    [[ -e "$NO_NPX_BIN/$name" ]] && continue
    ln -sf "$f" "$NO_NPX_BIN/$name" 2>/dev/null || true
  done
done
DATA_I="$TMP/data-caseI"
: > "$CLI_LOG"; : > "$NPX_LOG"
( unset CASE_REPO
  export PATH="$NO_NPX_BIN" TELEMETRY_CONFIG_FILE="$FULL_CONF" FAKE_EXPECTED_TOKEN="test-token-xyz"
  unset CONSOLE_AUTH_TOKEN
  run_sync "$DATA_I" )
rc=$?
[[ "$rc" -eq 0 ]] && pass "npx-unavailable: script still exits 0" || fail "npx-unavailable: exited $rc"
LOG_I="$DATA_I/console-board-sync.log"
grep -q 'console-process-projection OK' "$LOG_I" && pass "npx-unavailable: projections still ran" || fail "npx-unavailable: projections did not run: $(cat "$LOG_I" 2>/dev/null)"
grep -q 'npx is not available' "$LOG_I" && pass "npx-unavailable: bridge steps log-skipped" || fail "npx-unavailable: expected npx-unavailable SKIP log not found: $(cat "$LOG_I" 2>/dev/null)"

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "test_console_board_sync: all checks passed."
  exit 0
else
  echo "test_console_board_sync: $errors check(s) failed."
  exit 1
fi
