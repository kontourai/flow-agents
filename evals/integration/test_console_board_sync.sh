#!/usr/bin/env bash
# test_console_board_sync.sh — hook-native console board sync (#919), covering the
# independent-review fix round (4 HIGH, 5 MEDIUM, 1 LOW -- see file header comments in
# scripts/telemetry/console-board-sync.sh and scripts/telemetry/telemetry.sh for the
# per-finding rationale). Proves:
#
#   HIGH-1  the target repo is the STOPPED SESSION's cwd (FLOW_AGENTS_BOARD_SYNC_CWD, set by
#           telemetry.sh), never config.sh's TELEMETRY_WORKSPACE_ROOT (the telemetry
#           INSTALL's own location) -- a regression case proves the install root is never
#           consulted even when it points at a real, CLI-bearing directory.
#   HIGH-2  covered by evals/static/test_console_board_sync_wiring.sh (CI lane + manifest
#           registration) -- not re-proven here.
#   HIGH-3  covered by evals/static/test_console_board_sync_wiring.sh (pinned version,
#           --ignore-scripts) -- cross-checked here via the fake-npx-captured argv too.
#   HIGH-4  single-flight mkdir lock: concurrent invocations -- exactly one runs the
#           pipeline, the other exits 0 quietly; a stale lock is taken over (logged).
#   MED-1   a bridge step is SKIPPED (never re-bridges a stale envelope) when its own
#           projection step failed THIS run.
#   MED-2   a hub URL outside the https/localhost/127.0.0.1 allowlist is refused before any
#           token is ever passed anywhere.
#   MED-3   log file permissions are operator-private (umask 077); a step's captured output
#           is capped, never unbounded.
#   MED-4   log rotation happens under the lock; bridge invocations carry a timeout prefix
#           when a timeout binary is available.
#   MED-5   trust-bridge SKIP vs FAILED is decided by a DEDICATED --help probe: 127 + bin
#           name in stderr -> SKIP; any other probe outcome -> FAILED; the real bridge call
#           only ever runs after a successful probe.
#   LOW     (comment-only fix in the script; not independently testable here.)
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
// then exits with a controllable per-subcommand code (default 0). FAKE_CLI_SLEEP_MS busy-
// waits before exiting (used to widen the HIGH-4 concurrency test's contention window).
const fs = require('fs');
const logFile = process.env.FAKE_CLI_LOG;
const args = process.argv.slice(2);
fs.appendFileSync(logFile, JSON.stringify(args) + '\n');
const sleepMs = Number(process.env.FAKE_CLI_SLEEP_MS || 0);
if (sleepMs > 0) {
  const end = Date.now() + sleepMs;
  while (Date.now() < end) { /* busy-wait */ }
}
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
TIMEOUT_LOG="$TMP/timeout-invocations.log"
: > "$TIMEOUT_LOG"
cat > "$FAKE_BIN/npx" <<'SH'
#!/usr/bin/env bash
# Fake npx for console-board-sync.sh integration tests. Records every invocation's argv
# (and whether CONSOLE_AUTH_TOKEN matched the case's expected value -- never its literal
# value) to NPX_LOG, then simulates kontour-process-bridge/kontour-trust-bridge behavior per
# FAKE_NPX_* env vars. kontour-trust-bridge is dispatched differently for a `--help` PROBE
# call vs the real bridging call, mirroring the script's own MED-5 two-step discrimination.
LOG="${NPX_LOG:?NPX_LOG not set}"
token_marker="unset"
if [[ -n "${CONSOLE_AUTH_TOKEN:-}" ]]; then
  if [[ "$CONSOLE_AUTH_TOKEN" == "${FAKE_EXPECTED_TOKEN:-}" ]]; then token_marker="expected"; else token_marker="unexpected"; fi
fi
printf '%s|token=%s\n' "$*" "$token_marker" >> "$LOG"
bin="" is_help=0
for a in "$@"; do
  case "$a" in
    kontour-process-bridge|kontour-trust-bridge) bin="$a" ;;
    --help) is_help=1 ;;
  esac
done
if [[ "$bin" == "kontour-process-bridge" ]]; then
  exit "${FAKE_NPX_PROCESS_BRIDGE_EXIT:-0}"
elif [[ "$bin" == "kontour-trust-bridge" && "$is_help" -eq 1 ]]; then
  case "${FAKE_NPX_TRUST_BRIDGE_PROBE_MODE:-ok}" in
    ok) exit 0 ;;
    not-found) echo "sh: line 1: kontour-trust-bridge: command not found" >&2; exit 127 ;;
    not-found-other-bin) echo "sh: line 1: some-unrelated-bin: command not found" >&2; exit 127 ;;
    fail) echo "getaddrinfo ENOTFOUND registry.npmjs.org" >&2; exit 1 ;;
  esac
elif [[ "$bin" == "kontour-trust-bridge" ]]; then
  case "${FAKE_NPX_TRUST_BRIDGE_REAL_MODE:-ok}" in
    ok) exit 0 ;;
    fail) echo "kontour-trust-bridge: some real runtime error" >&2; exit 1 ;;
  esac
fi
exit 0
SH
chmod +x "$FAKE_BIN/npx"

# Fake `timeout` (review MED-4): records its OWN invocation (duration + wrapped command) to
# TIMEOUT_LOG -- proving the script actually wrapped the call -- then transparently execs
# the wrapped command (dropping its own leading duration arg). npx's own recorded argv can
# never show "timeout" itself (a real `timeout` replaces its own process image via exec, so
# the wrapped command never sees it either); TIMEOUT_LOG is the only place this is visible.
# Deterministic on every machine this suite runs on, never dependent on whether the real GNU
# coreutils `timeout` (or macOS's `gtimeout`) happens to be installed on the host.
cat > "$FAKE_BIN/timeout" <<SH
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$TIMEOUT_LOG"
shift
exec "\$@"
SH
chmod +x "$FAKE_BIN/timeout"

CLEAN_HOME="$TMP/clean-home"
mkdir -p "$CLEAN_HOME"
EMPTY_CONF="$TMP/empty-telemetry.conf"
: > "$EMPTY_CONF"

# run_sync <data_dir> — runs console-board-sync.sh with the shared hermetic isolation
# (scratch HOME, scratch TELEMETRY_DATA_DIR/SESSION_DIR -- NEVER this repo's own durable
# .kontourai or the operator's real ~/.flow-agents conf). Review HIGH-1: deliberately does
# NOT pre-set TELEMETRY_WORKSPACE_ROOT (that masked the original bug); the target repo is
# controlled ONLY via FLOW_AGENTS_BOARD_SYNC_CWD (or its absence, for the PWD-fallback
# tests), exactly like telemetry.sh's real detached invocation. Callers export case-specific
# PATH/TELEMETRY_CONFIG_FILE/FAKE_*/CONSOLE_TENANT_ID/FLOW_AGENTS_BOARD_SYNC_CWD before
# calling.
run_sync() {
  local data_dir="$1"
  HOME="$CLEAN_HOME" \
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
( export PATH="$FAKE_BIN:$PATH" TELEMETRY_CONFIG_FILE="$EMPTY_CONF" FLOW_AGENTS_BOARD_SYNC_CWD="$FAKE_REPO"
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
( export PATH="$FAKE_BIN:$PATH" TELEMETRY_CONFIG_FILE="$URL_ONLY_CONF" FLOW_AGENTS_BOARD_SYNC_CWD="$FAKE_REPO"
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
( export PATH="$FAKE_BIN:$PATH" TELEMETRY_CONFIG_FILE="$TOKEN_ONLY_CONF" FLOW_AGENTS_BOARD_SYNC_CWD="$FAKE_REPO"
  unset CONSOLE_TELEMETRY_URL CONSOLE_URL
  run_sync "$DATA_C" )
rc=$?
[[ "$rc" -eq 0 ]] && pass "token-only: exits 0" || fail "token-only: exited $rc"
[[ ! -f "$DATA_C/console-board-sync.log" ]] && pass "token-only: no log file written" || fail "token-only: a log file was written with no URL"
[[ ! -s "$CLI_LOG" ]] && pass "token-only: CLI never invoked" || fail "token-only: CLI was invoked with no URL"

FULL_CONF="$TMP/full.conf"
cat > "$FULL_CONF" <<CONF
console_telemetry_url=http://127.0.0.1:39002
console_telemetry_token=test-token-xyz
console_tenant_id=test-tenant
CONF

# ── HIGH-1: the stopped session's cwd drives the target repo, NEVER the telemetry install
# root -- proven with TELEMETRY_WORKSPACE_ROOT left UNSET (config.sh will resolve it from
# TELEMETRY_DIR, i.e. THIS repo's own scripts/telemetry, which DOES have a real
# build/src/cli.js) and only FLOW_AGENTS_BOARD_SYNC_CWD pointing at the fake repo. If the
# script regressed to reading TELEMETRY_WORKSPACE_ROOT, this run would silently invoke the
# REAL flow-agents CLI against the REAL repo instead of the fake one -- caught by asserting
# the CLI/scope actually used is the fake repo's, not this repo's own.
echo "--- HIGH-1: target repo comes from the session's cwd (FLOW_AGENTS_BOARD_SYNC_CWD), never the telemetry install root ---"
DATA_H1="$TMP/data-caseH1"
: > "$CLI_LOG"; : > "$NPX_LOG"
( export PATH="$FAKE_BIN:$PATH" TELEMETRY_CONFIG_FILE="$FULL_CONF" FAKE_EXPECTED_TOKEN="test-token-xyz"
  export FLOW_AGENTS_BOARD_SYNC_CWD="$FAKE_REPO"
  unset TELEMETRY_WORKSPACE_ROOT CONSOLE_AUTH_TOKEN
  run_sync "$DATA_H1" )
rc=$?
[[ "$rc" -eq 0 ]] && pass "HIGH-1: exits 0" || fail "HIGH-1: exited $rc"
LOG_H1="$DATA_H1/console-board-sync.log"
grep -q "repo=$FAKE_REPO" "$LOG_H1" 2>/dev/null && pass "HIGH-1: RUN start logs the fake repo (cwd), not the telemetry install root" || fail "HIGH-1: RUN start did not log the fake repo: $(cat "$LOG_H1" 2>/dev/null)"
grep -q "scope=fake-repo" "$LOG_H1" 2>/dev/null && pass "HIGH-1: scope id derives from the cwd repo's basename" || fail "HIGH-1: scope id did not derive from the fake repo"
[[ -s "$CLI_LOG" ]] && jq -e '.[0]=="console-process-projection"' <<<"$(sed -n '1p' "$CLI_LOG")" >/dev/null 2>&1 \
  && pass "HIGH-1: the FAKE cli.js (fake repo) was invoked, not this repo's own build/src/cli.js" \
  || fail "HIGH-1: the fake CLI log is empty or unexpected -- the real repo's own CLI may have been invoked instead: $(cat "$CLI_LOG" 2>/dev/null)"

echo "--- HIGH-1 (PWD fallback): with no FLOW_AGENTS_BOARD_SYNC_CWD at all, the script falls back to ITS OWN \$PWD, never the install root ---"
DATA_H1B="$TMP/data-caseH1b"
: > "$CLI_LOG"; : > "$NPX_LOG"
( cd "$FAKE_REPO"
  export PATH="$FAKE_BIN:$PATH" TELEMETRY_CONFIG_FILE="$FULL_CONF" FAKE_EXPECTED_TOKEN="test-token-xyz"
  unset TELEMETRY_WORKSPACE_ROOT CONSOLE_AUTH_TOKEN FLOW_AGENTS_BOARD_SYNC_CWD
  run_sync "$DATA_H1B" )
rc=$?
[[ "$rc" -eq 0 ]] && pass "HIGH-1 PWD fallback: exits 0" || fail "HIGH-1 PWD fallback: exited $rc"
LOG_H1B="$DATA_H1B/console-board-sync.log"
grep -q "repo=$FAKE_REPO" "$LOG_H1B" 2>/dev/null && pass "HIGH-1 PWD fallback: RUN start logs \$PWD (fake repo), not the telemetry install root" || fail "HIGH-1 PWD fallback: RUN start did not log the fake repo: $(cat "$LOG_H1B" 2>/dev/null)"

# ── happy path: both configured -> full pipeline attempted, exit 0 ─────────────────────────
echo "--- happy path: console_telemetry_url + token configured -> full pipeline runs ---"
DATA_D="$TMP/data-caseD"
: > "$CLI_LOG"; : > "$NPX_LOG"; : > "$TIMEOUT_LOG"
( export PATH="$FAKE_BIN:$PATH" TELEMETRY_CONFIG_FILE="$FULL_CONF" FAKE_EXPECTED_TOKEN="test-token-xyz" FLOW_AGENTS_BOARD_SYNC_CWD="$FAKE_REPO"
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

# Process bridge is line 1 of NPX_LOG; trust bridge probe is line 2; trust bridge real call is line 3.
NPX_ARGS_1="$(sed -n '1p' "$NPX_LOG")"
NPX_ARGS_2="$(sed -n '2p' "$NPX_LOG")"
NPX_ARGS_3="$(sed -n '3p' "$NPX_LOG")"
[[ "$NPX_ARGS_1" == *"kontour-process-bridge"* && "$NPX_ARGS_1" == *"--no-local"* && "$NPX_ARGS_1" == *"--hub http://127.0.0.1:39002"* && "$NPX_ARGS_1" == *"--tenant test-tenant"* ]] \
  && pass "happy path: kontour-process-bridge invoked with --no-local --hub --tenant" \
  || fail "happy path: process bridge args unexpected: $NPX_ARGS_1"
[[ "$NPX_ARGS_1" == *"token=expected"* ]] && pass "happy path: CONSOLE_AUTH_TOKEN set correctly for process bridge subprocess" || fail "happy path: process bridge did not see the expected CONSOLE_AUTH_TOKEN"
# HIGH-3: pinned exact version, never the mutable @latest dist-tag; --ignore-scripts present.
[[ "$NPX_ARGS_1" == *"--ignore-scripts"* ]] && pass "HIGH-3: kontour-process-bridge invoked with --ignore-scripts" || fail "HIGH-3: --ignore-scripts missing from process bridge invocation: $NPX_ARGS_1"
[[ "$NPX_ARGS_1" != *"@kontourai/console@latest"* ]] && pass "HIGH-3: process bridge does NOT use the mutable @latest dist-tag" || fail "HIGH-3: process bridge still uses @latest: $NPX_ARGS_1"
echo "$NPX_ARGS_1" | grep -qE '@kontourai/console@[0-9]+\.[0-9]+\.[0-9]+' && pass "HIGH-3: process bridge uses an exact pinned semver" || fail "HIGH-3: no exact pinned semver found: $NPX_ARGS_1"
[[ "$NPX_ARGS_2" == *"kontour-trust-bridge"* && "$NPX_ARGS_2" == *"--help"* ]] \
  && pass "MED-5: kontour-trust-bridge is probed with --help BEFORE the real bridging call" \
  || fail "MED-5: expected a --help probe as npx invocation #2: $NPX_ARGS_2"
[[ "$NPX_ARGS_3" == *"kontour-trust-bridge"* && "$NPX_ARGS_3" == *"--no-local"* && "$NPX_ARGS_3" != *"--help"* ]] \
  && pass "happy path: kontour-trust-bridge's real call (--no-local, no --help) follows a successful probe" \
  || fail "happy path: trust bridge real-call args unexpected: $NPX_ARGS_3"
[[ "$NPX_ARGS_3" == *"token=expected"* ]] && pass "happy path: CONSOLE_AUTH_TOKEN set correctly for trust bridge subprocess" || fail "happy path: trust bridge did not see the expected CONSOLE_AUTH_TOKEN"
[[ "$NPX_ARGS_2" != *"token=expected"* && "$NPX_ARGS_2" != *"token=unexpected"* ]] \
  && pass "MED-2/token hygiene: the --help PROBE call carries no auth token at all (not needed to check bin presence)" \
  || fail "the --help probe unexpectedly carried an auth token: $NPX_ARGS_2"

# MED-4: bridge invocations are wrapped with a timeout binary -- deterministic via the fake
# `timeout` on PATH above (which records its own invocation to TIMEOUT_LOG before exec'ing
# the wrapped command away), regardless of what the host machine happens to have installed.
TIMEOUT_INVOCATIONS="$(wc -l < "$TIMEOUT_LOG" | tr -d ' ')"
[[ "$TIMEOUT_INVOCATIONS" -eq 3 ]] \
  && pass "MED-4: all 3 npx/bridge invocations this run (process bridge, trust probe, trust real call) were timeout-wrapped ($TIMEOUT_INVOCATIONS)" \
  || fail "MED-4: expected 3 timeout-wrapped invocations, got $TIMEOUT_INVOCATIONS: $(cat "$TIMEOUT_LOG")"
grep -q "120 env CONSOLE_AUTH_TOKEN" "$TIMEOUT_LOG" && pass "MED-4: the timeout duration matches BRIDGE_TIMEOUT_SECONDS (120)" || fail "MED-4: expected a 120s timeout duration, got: $(cat "$TIMEOUT_LOG")"

# MED-3: the log file is operator-private (umask 077 -> mode 600), and the lock directory
# no longer exists once the run has completed (released).
# Independent assignments (never combined in one $(cmd1 || cmd2) substitution): GNU stat's
# `-f` means "filesystem status", not BSD/macOS's `-f FORMAT` -- combined inside one command
# substitution, a partial-success-then-nonzero-exit on Linux would APPEND the fallback's
# output after the first command's own (wrong-mode) stdout instead of cleanly replacing it.
LOG_MODE="$(stat -f '%Lp' "$LOG_D" 2>/dev/null)" || LOG_MODE="$(stat -c '%a' "$LOG_D" 2>/dev/null)"
[[ "$LOG_MODE" == "600" ]] && pass "MED-3: console-board-sync.log is created with mode 600 (umask 077)" || fail "MED-3: expected log mode 600, got $LOG_MODE"
[[ ! -d "$DATA_D/console-board-sync.lock" ]] && pass "HIGH-4: the lock directory is released after a completed run" || fail "HIGH-4: the lock directory was left behind after a completed run"

# ── MED-3: a step's captured output is capped, never unbounded ─────────────────────────────
echo "--- MED-3: an oversized child output is capped, never written to the log unbounded ---"
FAKE_REPO_BIG="$TMP/fake-repo-big"
mkdir -p "$FAKE_REPO_BIG/build/src"
cat > "$FAKE_REPO_BIG/build/src/cli.js" <<'NODE'
#!/usr/bin/env node
// Emits far more than the script's LOG_STEP_MAX_BYTES cap on stdout, then exits 0.
process.stdout.write('X'.repeat(2 * 1024 * 1024));
process.exit(0);
NODE
chmod +x "$FAKE_REPO_BIG/build/src/cli.js"
DATA_BIG="$TMP/data-caseBig"
: > "$CLI_LOG"; : > "$NPX_LOG"
( export PATH="$FAKE_BIN:$PATH" TELEMETRY_CONFIG_FILE="$FULL_CONF" FAKE_EXPECTED_TOKEN="test-token-xyz"
  export FLOW_AGENTS_BOARD_SYNC_CWD="$FAKE_REPO_BIG"
  unset CONSOLE_AUTH_TOKEN
  run_sync "$DATA_BIG" )
rc=$?
[[ "$rc" -eq 0 ]] && pass "MED-3 cap: script still exits 0 despite a huge child output" || fail "MED-3 cap: exited $rc"
LOG_BIG="$DATA_BIG/console-board-sync.log"
LOG_BIG_SIZE="$(stat -f%z "$LOG_BIG" 2>/dev/null)" || LOG_BIG_SIZE="$(stat -c%s "$LOG_BIG" 2>/dev/null)"
[[ -n "$LOG_BIG_SIZE" && "$LOG_BIG_SIZE" -lt $((1024 * 1024)) ]] \
  && pass "MED-3 cap: the log stayed well under the 2MB child output (actual: ${LOG_BIG_SIZE} bytes)" \
  || fail "MED-3 cap: the log grew unbounded from the child's output (actual: ${LOG_BIG_SIZE:-unknown} bytes)"

# ── graceful degradation (MED-5): kontour-trust-bridge bin not published yet -> SKIP ────────
echo "--- MED-5: probe 127 + bin name in stderr -> SKIP (not a failure); no real bridge call attempted ---"
DATA_E="$TMP/data-caseE"
: > "$CLI_LOG"; : > "$NPX_LOG"
( export PATH="$FAKE_BIN:$PATH" TELEMETRY_CONFIG_FILE="$FULL_CONF" FAKE_EXPECTED_TOKEN="test-token-xyz" FLOW_AGENTS_BOARD_SYNC_CWD="$FAKE_REPO"
  export FAKE_NPX_TRUST_BRIDGE_PROBE_MODE="not-found"
  unset CONSOLE_AUTH_TOKEN
  run_sync "$DATA_E" )
rc=$?
[[ "$rc" -eq 0 ]] && pass "MED-5 absent: script still exits 0" || fail "MED-5 absent: exited $rc"
LOG_E="$DATA_E/console-board-sync.log"
grep -q 'SKIP kontour-trust-bridge' "$LOG_E" && pass "MED-5 absent: logged as a SKIP" || fail "MED-5 absent: not logged as a SKIP: $(cat "$LOG_E" 2>/dev/null)"
grep -q 'kontour-trust-bridge FAILED' "$LOG_E" && fail "MED-5 absent: wrongly logged as a FAILED" || pass "MED-5 absent: not logged as a FAILED"
[[ "$(grep -c 'kontour-trust-bridge' "$NPX_LOG")" -eq 1 ]] \
  && pass "MED-5 absent: only the --help PROBE ran -- no real bridging call attempted for a confirmed-absent bin" \
  || fail "MED-5 absent: expected exactly one kontour-trust-bridge npx invocation (the probe), got: $(cat "$NPX_LOG")"
grep -q 'kontour-process-bridge OK' "$LOG_E" && pass "MED-5 absent: process bridge still ran fine" || fail "MED-5 absent: process bridge did not run"

echo "--- MED-5: probe 127 but stderr does NOT mention the bin name -> FAILED, not SKIP (tight discrimination) ---"
DATA_E2="$TMP/data-caseE2"
: > "$CLI_LOG"; : > "$NPX_LOG"
( export PATH="$FAKE_BIN:$PATH" TELEMETRY_CONFIG_FILE="$FULL_CONF" FAKE_EXPECTED_TOKEN="test-token-xyz" FLOW_AGENTS_BOARD_SYNC_CWD="$FAKE_REPO"
  export FAKE_NPX_TRUST_BRIDGE_PROBE_MODE="not-found-other-bin"
  unset CONSOLE_AUTH_TOKEN
  run_sync "$DATA_E2" )
rc=$?
[[ "$rc" -eq 0 ]] && pass "MED-5 tight discrimination: script still exits 0" || fail "MED-5 tight discrimination: exited $rc"
LOG_E2="$DATA_E2/console-board-sync.log"
grep -q 'kontour-trust-bridge FAILED' "$LOG_E2" && pass "MED-5 tight discrimination: a 127 whose stderr does NOT name the bin is logged FAILED" || fail "MED-5 tight discrimination: expected FAILED, got: $(cat "$LOG_E2" 2>/dev/null)"
grep -q 'SKIP kontour-trust-bridge' "$LOG_E2" && fail "MED-5 tight discrimination: wrongly downgraded to a SKIP" || pass "MED-5 tight discrimination: not wrongly downgraded to a SKIP"

echo "--- MED-5: probe fails for a non-127 reason -> FAILED, not SKIP ---"
DATA_E3="$TMP/data-caseE3"
: > "$CLI_LOG"; : > "$NPX_LOG"
( export PATH="$FAKE_BIN:$PATH" TELEMETRY_CONFIG_FILE="$FULL_CONF" FAKE_EXPECTED_TOKEN="test-token-xyz" FLOW_AGENTS_BOARD_SYNC_CWD="$FAKE_REPO"
  export FAKE_NPX_TRUST_BRIDGE_PROBE_MODE="fail"
  unset CONSOLE_AUTH_TOKEN
  run_sync "$DATA_E3" )
rc=$?
[[ "$rc" -eq 0 ]] && pass "MED-5 non-127 probe failure: script still exits 0" || fail "MED-5 non-127 probe failure: exited $rc"
LOG_E3="$DATA_E3/console-board-sync.log"
grep -q 'kontour-trust-bridge FAILED' "$LOG_E3" && pass "MED-5 non-127 probe failure: logged as FAILED" || fail "MED-5 non-127 probe failure: expected FAILED, got: $(cat "$LOG_E3" 2>/dev/null)"

# ── real trust-bridge REAL-CALL failure (probe succeeds, real call fails) -> FAILED ────────
echo "--- real trust-bridge runtime failure (probe OK, real call fails) -> logged as FAILED, still fail-soft ---"
DATA_F="$TMP/data-caseF"
: > "$CLI_LOG"; : > "$NPX_LOG"
( export PATH="$FAKE_BIN:$PATH" TELEMETRY_CONFIG_FILE="$FULL_CONF" FAKE_EXPECTED_TOKEN="test-token-xyz" FLOW_AGENTS_BOARD_SYNC_CWD="$FAKE_REPO"
  export FAKE_NPX_TRUST_BRIDGE_REAL_MODE="fail"
  unset CONSOLE_AUTH_TOKEN
  run_sync "$DATA_F" )
rc=$?
[[ "$rc" -eq 0 ]] && pass "trust-bridge-real-failure: script still exits 0 (fail-soft)" || fail "trust-bridge-real-failure: exited $rc"
LOG_F="$DATA_F/console-board-sync.log"
grep -q 'kontour-trust-bridge FAILED' "$LOG_F" && pass "trust-bridge-real-failure: logged as FAILED" || fail "trust-bridge-real-failure: not logged as FAILED: $(cat "$LOG_F" 2>/dev/null)"
grep -q 'SKIP kontour-trust-bridge' "$LOG_F" && fail "trust-bridge-real-failure: wrongly logged as a SKIP" || pass "trust-bridge-real-failure: not logged as a SKIP"

# ── MED-1: a step's projection failure THIS run skips bridging that family (never re-bridges
# a stale pre-existing envelope) -- the OTHER family (whose projection succeeded) still
# bridges normally. ──────────────────────────────────────────────────────────────────────
echo "--- MED-1: console-process-projection failure THIS run -> its bridge is SKIPPED, not attempted; trust still bridges ---"
DATA_G="$TMP/data-caseG"
: > "$CLI_LOG"; : > "$NPX_LOG"
( export PATH="$FAKE_BIN:$PATH" TELEMETRY_CONFIG_FILE="$FULL_CONF" FAKE_EXPECTED_TOKEN="test-token-xyz" FLOW_AGENTS_BOARD_SYNC_CWD="$FAKE_REPO"
  export FAKE_CLI_PROCESS_EXIT="1"
  unset CONSOLE_AUTH_TOKEN
  run_sync "$DATA_G" )
rc=$?
[[ "$rc" -eq 0 ]] && pass "MED-1: script still exits 0" || fail "MED-1: exited $rc"
LOG_G="$DATA_G/console-board-sync.log"
grep -q 'console-process-projection FAILED' "$LOG_G" && pass "MED-1: process-projection logged as FAILED" || fail "MED-1: not logged as FAILED"
grep -q 'console-trust-projection OK' "$LOG_G" && pass "MED-1: pipeline continued to trust-projection" || fail "MED-1: pipeline did not continue to trust-projection"
grep -q 'SKIP kontour-process-bridge: console-process-projection did not succeed' "$LOG_G" \
  && pass "MED-1: kontour-process-bridge is SKIPPED (never re-bridges a stale envelope) when its own projection failed this run" \
  || fail "MED-1: expected a process-bridge SKIP naming the failed projection, got: $(cat "$LOG_G" 2>/dev/null)"
grep -q 'kontour-process-bridge OK' "$LOG_G" && fail "MED-1: process bridge wrongly ran despite the failed projection" || pass "MED-1: process bridge never ran"
grep -q 'kontour-trust-bridge OK' "$LOG_G" && pass "MED-1: the OTHER family (trust, whose projection succeeded) still bridges normally" || fail "MED-1: trust bridge unexpectedly did not run despite its own projection succeeding"
[[ ! -s "$NPX_LOG" ]] && fail "MED-1: npx was never invoked at all (trust bridge should still have run)" || pass "MED-1: npx was invoked for the still-succeeding family"
grep -q 'kontour-process-bridge' "$NPX_LOG" && fail "MED-1: npx was invoked for kontour-process-bridge despite the SKIP" || pass "MED-1: npx was never invoked for kontour-process-bridge"

echo "--- MED-1 (mirror case): console-trust-projection failure THIS run -> ITS bridge is SKIPPED; process still bridges ---"
DATA_G2="$TMP/data-caseG2"
: > "$CLI_LOG"; : > "$NPX_LOG"
( export PATH="$FAKE_BIN:$PATH" TELEMETRY_CONFIG_FILE="$FULL_CONF" FAKE_EXPECTED_TOKEN="test-token-xyz" FLOW_AGENTS_BOARD_SYNC_CWD="$FAKE_REPO"
  export FAKE_CLI_TRUST_EXIT="1"
  unset CONSOLE_AUTH_TOKEN
  run_sync "$DATA_G2" )
rc=$?
[[ "$rc" -eq 0 ]] && pass "MED-1 mirror: script still exits 0" || fail "MED-1 mirror: exited $rc"
LOG_G2="$DATA_G2/console-board-sync.log"
grep -q 'console-trust-projection FAILED' "$LOG_G2" && pass "MED-1 mirror: trust-projection logged as FAILED" || fail "MED-1 mirror: not logged as FAILED"
grep -q 'SKIP kontour-trust-bridge: console-trust-projection did not succeed' "$LOG_G2" \
  && pass "MED-1 mirror: kontour-trust-bridge is SKIPPED when its own projection failed this run" \
  || fail "MED-1 mirror: expected a trust-bridge SKIP naming the failed projection, got: $(cat "$LOG_G2" 2>/dev/null)"
grep -q 'kontour-process-bridge OK' "$LOG_G2" && pass "MED-1 mirror: the process family still bridges normally" || fail "MED-1 mirror: process bridge unexpectedly did not run"

# ── MED-2: a hub URL outside the allowlist is refused before the token is ever passed ──────
echo "--- MED-2: a hub URL outside the https/localhost/127.0.0.1 allowlist is refused ---"
DATA_M2="$TMP/data-caseM2"
BAD_SCHEME_CONF="$TMP/bad-scheme.conf"
cat > "$BAD_SCHEME_CONF" <<CONF
console_telemetry_url=ftp://attacker.example.com
console_telemetry_token=test-token-xyz
CONF
: > "$CLI_LOG"; : > "$NPX_LOG"
( export PATH="$FAKE_BIN:$PATH" TELEMETRY_CONFIG_FILE="$BAD_SCHEME_CONF" FAKE_EXPECTED_TOKEN="test-token-xyz" FLOW_AGENTS_BOARD_SYNC_CWD="$FAKE_REPO"
  unset CONSOLE_AUTH_TOKEN
  run_sync "$DATA_M2" )
rc=$?
[[ "$rc" -eq 0 ]] && pass "MED-2: script still exits 0" || fail "MED-2: exited $rc"
LOG_M2="$DATA_M2/console-board-sync.log"
grep -q 'REFUSED' "$LOG_M2" && pass "MED-2: the disallowed-scheme hub URL is logged as REFUSED" || fail "MED-2: no REFUSED log line: $(cat "$LOG_M2" 2>/dev/null)"
[[ ! -s "$CLI_LOG" ]] && pass "MED-2: no CLI projection is attempted for a refused hub URL" || fail "MED-2: CLI was invoked despite a refused hub URL"
[[ ! -s "$NPX_LOG" ]] && pass "MED-2: no bridge/token is ever sent for a refused hub URL" || fail "MED-2: npx was invoked despite a refused hub URL"

echo "--- MED-2: an http://127.0.0.1 hub URL (allowed) still runs the pipeline ---"
DATA_M2B="$TMP/data-caseM2b"
: > "$CLI_LOG"; : > "$NPX_LOG"
( export PATH="$FAKE_BIN:$PATH" TELEMETRY_CONFIG_FILE="$FULL_CONF" FAKE_EXPECTED_TOKEN="test-token-xyz" FLOW_AGENTS_BOARD_SYNC_CWD="$FAKE_REPO"
  unset CONSOLE_AUTH_TOKEN
  run_sync "$DATA_M2B" )
rc=$?
grep -q 'console-process-projection OK' "$DATA_M2B/console-board-sync.log" 2>/dev/null \
  && pass "MED-2: an allowed http://127.0.0.1 hub URL still runs the full pipeline" \
  || fail "MED-2: an allowed hub URL was wrongly refused"

# ── no flow-agents CLI resolvable -> log-skip, no bridges attempted ────────────────────────
echo "--- no flow-agents CLI resolvable -> log-skip, exit 0, no bridge attempted ---"
NO_CLI_REPO="$TMP/no-cli-repo"
mkdir -p "$NO_CLI_REPO"
NO_FLOW_AGENTS_BIN="$TMP/no-flow-agents-bin"
mkdir -p "$NO_FLOW_AGENTS_BIN"
DATA_H="$TMP/data-caseH"
: > "$CLI_LOG"; : > "$NPX_LOG"
( export PATH="$NO_FLOW_AGENTS_BIN:$FAKE_BIN:$PATH" TELEMETRY_CONFIG_FILE="$FULL_CONF" FAKE_EXPECTED_TOKEN="test-token-xyz"
  export FLOW_AGENTS_BOARD_SYNC_CWD="$NO_CLI_REPO"
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
( export PATH="$NO_NPX_BIN" TELEMETRY_CONFIG_FILE="$FULL_CONF" FAKE_EXPECTED_TOKEN="test-token-xyz" FLOW_AGENTS_BOARD_SYNC_CWD="$FAKE_REPO"
  unset CONSOLE_AUTH_TOKEN
  run_sync "$DATA_I" )
rc=$?
[[ "$rc" -eq 0 ]] && pass "npx-unavailable: script still exits 0" || fail "npx-unavailable: exited $rc"
LOG_I="$DATA_I/console-board-sync.log"
grep -q 'console-process-projection OK' "$LOG_I" && pass "npx-unavailable: projections still ran" || fail "npx-unavailable: projections did not run: $(cat "$LOG_I" 2>/dev/null)"
grep -q 'npx is not available' "$LOG_I" && pass "npx-unavailable: bridge steps log-skipped" || fail "npx-unavailable: expected npx-unavailable SKIP log not found: $(cat "$LOG_I" 2>/dev/null)"

# ── HIGH-4: single-flight lock -- concurrent invocations, one syncs, one skips quietly ─────
echo "--- HIGH-4: two concurrent invocations -- exactly one runs the pipeline, the other exits 0 quietly ---"
DATA_LOCK="$TMP/data-caseLock"
: > "$CLI_LOG"; : > "$NPX_LOG"
(
  export PATH="$FAKE_BIN:$PATH" TELEMETRY_CONFIG_FILE="$FULL_CONF" FAKE_EXPECTED_TOKEN="test-token-xyz" FLOW_AGENTS_BOARD_SYNC_CWD="$FAKE_REPO"
  export FAKE_CLI_SLEEP_MS=800
  unset CONSOLE_AUTH_TOKEN
  run_sync "$DATA_LOCK" > "$TMP/lock-run-1.out" 2>&1
  echo "$?" > "$TMP/lock-run-1.status"
) &
RUN1_PID=$!
sleep 0.15
(
  export PATH="$FAKE_BIN:$PATH" TELEMETRY_CONFIG_FILE="$FULL_CONF" FAKE_EXPECTED_TOKEN="test-token-xyz" FLOW_AGENTS_BOARD_SYNC_CWD="$FAKE_REPO"
  unset CONSOLE_AUTH_TOKEN FAKE_CLI_SLEEP_MS
  run_sync "$DATA_LOCK" > "$TMP/lock-run-2.out" 2>&1
  echo "$?" > "$TMP/lock-run-2.status"
) &
RUN2_PID=$!
wait "$RUN1_PID" "$RUN2_PID"

RUN1_STATUS="$(cat "$TMP/lock-run-1.status" 2>/dev/null)"
RUN2_STATUS="$(cat "$TMP/lock-run-2.status" 2>/dev/null)"
[[ "$RUN1_STATUS" == "0" && "$RUN2_STATUS" == "0" ]] \
  && pass "HIGH-4: both concurrent invocations exit 0 (the loser is never treated as an error)" \
  || fail "HIGH-4: expected both to exit 0, got run1=$RUN1_STATUS run2=$RUN2_STATUS"
LOG_LOCK="$DATA_LOCK/console-board-sync.log"
RUN_START_COUNT="$(grep -c 'RUN start' "$LOG_LOCK" 2>/dev/null || echo 0)"
[[ "$RUN_START_COUNT" -eq 1 ]] \
  && pass "HIGH-4: exactly ONE concurrent invocation actually ran the pipeline (RUN start logged once)" \
  || fail "HIGH-4: expected exactly 1 'RUN start', got $RUN_START_COUNT: $(cat "$LOG_LOCK" 2>/dev/null)"
CLI_INVOCATION_COUNT="$(wc -l < "$CLI_LOG" | tr -d ' ')"
[[ "$CLI_INVOCATION_COUNT" -eq 2 ]] \
  && pass "HIGH-4: the flow-agents CLI was invoked exactly twice total (one winner's 2 projection steps, the loser made zero calls)" \
  || fail "HIGH-4: expected exactly 2 CLI invocations (the single winner's), got $CLI_INVOCATION_COUNT"
[[ ! -d "$DATA_LOCK/console-board-sync.lock" ]] \
  && pass "HIGH-4: the lock is released after the winning run completes" \
  || fail "HIGH-4: the lock directory was left behind after both runs completed"

# ── HIGH-4: a stale lock (older than the staleness threshold) is taken over, not respected
# forever -- simulates an orphaned lock from a crashed/killed prior run. ───────────────────
echo "--- HIGH-4: a stale lock (simulated crashed prior run) is taken over and logged ---"
DATA_STALE="$TMP/data-caseStale"
mkdir -p "$DATA_STALE"
mkdir "$DATA_STALE/console-board-sync.lock"
STALE_TS="$(date -v-20M +%Y%m%d%H%M.%S 2>/dev/null || date -d '-20 minutes' +%Y%m%d%H%M.%S 2>/dev/null)"
if [[ -n "$STALE_TS" ]]; then
  touch -t "$STALE_TS" "$DATA_STALE/console-board-sync.lock" 2>/dev/null || true
fi
: > "$CLI_LOG"; : > "$NPX_LOG"
( export PATH="$FAKE_BIN:$PATH" TELEMETRY_CONFIG_FILE="$FULL_CONF" FAKE_EXPECTED_TOKEN="test-token-xyz" FLOW_AGENTS_BOARD_SYNC_CWD="$FAKE_REPO"
  unset CONSOLE_AUTH_TOKEN
  run_sync "$DATA_STALE" )
rc=$?
[[ "$rc" -eq 0 ]] && pass "HIGH-4 stale takeover: script exits 0" || fail "HIGH-4 stale takeover: exited $rc"
LOG_STALE="$DATA_STALE/console-board-sync.log"
grep -q 'recovered a stale lock' "$LOG_STALE" 2>/dev/null \
  && pass "HIGH-4 stale takeover: the stale lock recovery is logged (unlike a live-contention skip, this IS worth knowing about)" \
  || fail "HIGH-4 stale takeover: no stale-lock recovery log line: $(cat "$LOG_STALE" 2>/dev/null)"
grep -q 'RUN start' "$LOG_STALE" 2>/dev/null \
  && pass "HIGH-4 stale takeover: the pipeline actually ran after taking over the stale lock" \
  || fail "HIGH-4 stale takeover: the pipeline never ran despite the stale lock takeover"

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "test_console_board_sync: all checks passed."
  exit 0
else
  echo "test_console_board_sync: $errors check(s) failed."
  exit 1
fi
