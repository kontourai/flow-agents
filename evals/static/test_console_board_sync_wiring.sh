#!/usr/bin/env bash
# test_console_board_sync_wiring.sh — static wiring checks for the hook-native console
# board sync (#919): scripts/telemetry/telemetry.sh's stop flow must invoke
# console-board-sync.sh in the EXACT same detached, best-effort shape as the
# economics-record step it sits directly after (#349) -- "(cmd) </dev/null >/dev/null 2>&1
# & disown" -- so board sync can never alter telemetry timing or fail the stop hook. The
# script itself must be the thing that gate-checks the console sink config (this file only
# proves the WIRING and SHAPE; functional gating behavior is covered by
# evals/integration/test_console_board_sync.sh).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TELEMETRY_SH="$ROOT_DIR/scripts/telemetry/telemetry.sh"
CONTEXT_TELEMETRY_SH="$ROOT_DIR/context/scripts/telemetry/telemetry.sh"
BOARD_SYNC_SH="$ROOT_DIR/scripts/telemetry/console-board-sync.sh"
CONTEXT_BOARD_SYNC_SH="$ROOT_DIR/context/scripts/telemetry/console-board-sync.sh"

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

echo "=== Console Board Sync Wiring (#919) ==="

[[ -f "$BOARD_SYNC_SH" ]] || fail "scripts/telemetry/console-board-sync.sh is missing"
pass "scripts/telemetry/console-board-sync.sh exists"
[[ -x "$BOARD_SYNC_SH" ]] || fail "scripts/telemetry/console-board-sync.sh is not executable"
pass "scripts/telemetry/console-board-sync.sh is executable"

[[ -f "$CONTEXT_BOARD_SYNC_SH" ]] || fail "context/scripts/telemetry/console-board-sync.sh mirror is missing"
pass "context/scripts/telemetry/console-board-sync.sh mirror exists"

for f in "$TELEMETRY_SH" "$CONTEXT_TELEMETRY_SH"; do
  [[ -f "$f" ]] || fail "$f is missing"
  grep -q 'console-board-sync.sh' "$f" || fail "$f does not reference console-board-sync.sh"
done
pass "telemetry.sh (root + context mirror) references console-board-sync.sh"

# The wiring must sit DIRECTLY AFTER the economics-record detached block, inside the same
# add_stop_data_and_emit_usage function, in the exact "(cmd) </dev/null >/dev/null 2>&1 &"
# + "disown" detached shape economics-record.sh uses.
for f in "$TELEMETRY_SH" "$CONTEXT_TELEMETRY_SH"; do
  awk '
    /economics-record\.sh/ { econ_seen=1 }
    econ_seen && /console-board-sync\.sh/ { board_after_econ=1 }
    END { exit !(board_after_econ) }
  ' "$f" || fail "$f: console-board-sync.sh wiring does not appear after the economics-record.sh wiring"
done
pass "console-board-sync.sh wiring appears directly after economics-record.sh wiring in both copies"

for f in "$TELEMETRY_SH" "$CONTEXT_TELEMETRY_SH"; do
  awk '
    /console-board-sync\.sh/ { seen=1 }
    seen && /<\/dev\/null[[:space:]]*>\/dev\/null[[:space:]]*2>&1[[:space:]]*&/ { detached=1 }
    seen && detached && /disown/ { found=1 }
    END { exit !found }
  ' "$f" || fail "$f: console-board-sync.sh is not invoked in the detached '</dev/null >/dev/null 2>&1 &' + disown shape"
done
pass "console-board-sync.sh is invoked detached (</dev/null >/dev/null 2>&1 & + disown), matching the economics-record precedent"

# The sync script itself must be the thing that gate-checks the console sink config (a
# console telemetry URL AND a token) and exits before doing anything else when either is
# absent -- functional behavior is proven in the integration suite; here we only assert the
# gate exists in source, in both copies.
for f in "$BOARD_SYNC_SH" "$CONTEXT_BOARD_SYNC_SH"; do
  grep -q 'CONSOLE_TELEMETRY_URL' "$f" || fail "$f does not reference CONSOLE_TELEMETRY_URL"
  grep -q 'CONSOLE_TELEMETRY_TOKEN' "$f" || fail "$f does not reference CONSOLE_TELEMETRY_TOKEN"
  grep -q 'exit 0' "$f" || fail "$f has no exit 0 fail-soft/gate path"
done
pass "console-board-sync.sh (root + context mirror) gate-checks console_telemetry_url and a token"

# Never a standing daemon: no launchd/cron/nohup/setsid/while-true polling loop actually
# INVOKED (comment mentions describing what this ISN'T -- e.g. "never a launchd/cron
# daemon" -- are expected and excluded by stripping full-line comments first).
for f in "$BOARD_SYNC_SH" "$CONTEXT_BOARD_SYNC_SH"; do
  if grep -vE '^[[:space:]]*#' "$f" | grep -qE 'launchd|crontab|\bnohup\b|\bsetsid\b|while[[:space:]]+true'; then
    fail "$f invokes daemon-like machinery (launchd/crontab/nohup/setsid/while true) -- #919 is hook-native, not a daemon"
  fi
done
pass "console-board-sync.sh has no daemon/polling-loop machinery"

# #918 dependency: the process-projection call must use --skip-invalid, and both projection
# steps must be scoped to the current repo (never a multi-repo sweep).
for f in "$BOARD_SYNC_SH" "$CONTEXT_BOARD_SYNC_SH"; do
  grep -q 'console-process-projection' "$f" || fail "$f does not call console-process-projection"
  grep -q 'console-trust-projection' "$f" || fail "$f does not call console-trust-projection"
  grep -q -- '--skip-invalid' "$f" || fail "$f does not pass --skip-invalid to console-process-projection (#918)"
  grep -qE -- '--all\b' "$f" && fail "$f references a --all multi-repo sweep flag -- #919 must be cwd-scoped to the current repo only"
done
pass "console-board-sync.sh calls console-process-projection --skip-invalid (#918) and console-trust-projection, cwd-scoped"

# Never echoes the console auth token.
for f in "$BOARD_SYNC_SH" "$CONTEXT_BOARD_SYNC_SH"; do
  if grep -qE 'echo[[:space:]]+.*CONSOLE_(TELEMETRY_)?TOKEN|printf[[:space:]]+.*CONSOLE_(TELEMETRY_)?TOKEN' "$f"; then
    fail "$f appears to echo/printf the console auth token"
  fi
done
pass "console-board-sync.sh never echoes the console auth token"

echo ""
echo "test_console_board_sync_wiring: all checks passed."
