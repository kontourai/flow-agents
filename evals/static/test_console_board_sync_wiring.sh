#!/usr/bin/env bash
# test_console_board_sync_wiring.sh — static wiring checks for the hook-native console
# board sync (#919): scripts/telemetry/telemetry.sh's stop flow must invoke
# console-board-sync.sh in the EXACT same detached, best-effort shape as the
# economics-record step it sits directly after (#349) -- "(cmd) </dev/null >/dev/null 2>&1
# & disown" -- so board sync can never alter telemetry timing or fail the stop hook. The
# script itself must be the thing that gate-checks the console sink config (this file only
# proves the WIRING and SHAPE; functional gating behavior is covered by
# evals/integration/test_console_board_sync.sh). Also covers the independent-review fix
# round's structural findings: HIGH-1 (cwd, not the install root), HIGH-2 (CI lane + manifest
# registration, actually executed here), HIGH-3 (pinned version + --ignore-scripts), HIGH-4
# (single-flight lock), MED-2 (hub URL allowlist reuse), MED-3 (umask), MED-4 (rotation under
# the lock, timeout wrapping), MED-5 (dedicated absence probe).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TELEMETRY_SH="$ROOT_DIR/scripts/telemetry/telemetry.sh"
CONTEXT_TELEMETRY_SH="$ROOT_DIR/context/scripts/telemetry/telemetry.sh"
BOARD_SYNC_SH="$ROOT_DIR/scripts/telemetry/console-board-sync.sh"
CONTEXT_BOARD_SYNC_SH="$ROOT_DIR/context/scripts/telemetry/console-board-sync.sh"
RUN_BASELINE_SH="$ROOT_DIR/evals/ci/run-baseline.sh"
CI_YML="$ROOT_DIR/.github/workflows/ci.yml"

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

# HIGH-1: the target repo is the STOPPED SESSION's cwd, never config.sh's
# TELEMETRY_WORKSPACE_ROOT (the telemetry INSTALL's own location). telemetry.sh must pass
# FLOW_AGENTS_BOARD_SYNC_CWD explicitly, derived the SAME way econ_cwd already is (the usage
# event's own .context.cwd, falling back to $PWD); console-board-sync.sh must read that var
# (falling back to its own $PWD) and must NEVER read TELEMETRY_WORKSPACE_ROOT for REPO_ROOT.
for f in "$TELEMETRY_SH" "$CONTEXT_TELEMETRY_SH"; do
  grep -q 'FLOW_AGENTS_BOARD_SYNC_CWD' "$f" || fail "$f does not pass FLOW_AGENTS_BOARD_SYNC_CWD to console-board-sync.sh"
  grep -q 'board_sync_cwd' "$f" || fail "$f does not derive an explicit cwd for console-board-sync.sh"
done
pass "telemetry.sh (root + context mirror) passes an explicit session cwd via FLOW_AGENTS_BOARD_SYNC_CWD"

for f in "$BOARD_SYNC_SH" "$CONTEXT_BOARD_SYNC_SH"; do
  grep -q 'FLOW_AGENTS_BOARD_SYNC_CWD' "$f" || fail "$f does not read FLOW_AGENTS_BOARD_SYNC_CWD"
  grep -qE 'REPO_ROOT="\$\{FLOW_AGENTS_BOARD_SYNC_CWD:-\$PWD\}"' "$f" || fail "$f does not fall back REPO_ROOT to \$PWD when FLOW_AGENTS_BOARD_SYNC_CWD is unset"
  grep -vE '^[[:space:]]*#' "$f" | grep -q 'TELEMETRY_WORKSPACE_ROOT' && fail "$f still references TELEMETRY_WORKSPACE_ROOT in executable code (HIGH-1 regression: that resolves the telemetry INSTALL root, not the stopped session's project)"
done
pass "HIGH-1: console-board-sync.sh (root + context mirror) resolves REPO_ROOT from the session cwd only, never TELEMETRY_WORKSPACE_ROOT"

# HIGH-2: the new integration eval must be registered in a REQUIRED CI lane (not just the
# CHECKS array -- membership there alone is invisible to find_active_check/manifest under a
# scoped FLOW_AGENTS_CI_LANE, and a continue-on-error CI step would hide that silently), and
# the ci.yml step must live inside that SAME lane's job block. Actually EXECUTES the check
# through the real CI harness invocation (not just a text scan) to prove it truly runs.
awk '
  /^LANE_RUNTIME_AND_KIT=\(/ { in_lane=1; next }
  in_lane && /^\)/ { in_lane=0 }
  in_lane && /"Console board sync integration"/ { found=1 }
  END { exit !found }
' "$RUN_BASELINE_SH" || fail "evals/ci/run-baseline.sh -- 'Console board sync integration' is not a member of LANE_RUNTIME_AND_KIT -- find_active_check/the manifest will never see it under FLOW_AGENTS_CI_LANE=runtime-and-kit"
pass "HIGH-2: 'Console board sync integration' is registered in LANE_RUNTIME_AND_KIT"

awk '
  /^  runtime-and-kit:/ { in_job=1; next }
  in_job && /^  [a-zA-Z0-9_-]+:/ { in_job=0 }
  in_job && /console-board-sync-integration/ { found=1 }
  END { exit !found }
' "$CI_YML" || fail ".github/workflows/ci.yml: the console-board-sync-integration step is not inside the runtime-and-kit job block"
pass "HIGH-2: ci.yml's console-board-sync-integration step lives inside the runtime-and-kit job block"

CI_MANIFEST_LANES="$(FLOW_AGENTS_CI_LANE=runtime-and-kit bash "$RUN_BASELINE_SH" --manifest-json 2>/dev/null | node -e '
  let raw = "";
  process.stdin.on("data", (d) => { raw += d; });
  process.stdin.on("end", () => {
    const manifest = JSON.parse(raw);
    const entry = manifest.find((e) => e.id === "console-board-sync-integration");
    process.stdout.write(entry ? JSON.stringify(entry.lanes) : "MISSING");
  });
')"
[[ "$CI_MANIFEST_LANES" == *'"runtime-and-kit"'* ]]   && pass "HIGH-2: the trust-reconcile manifest lists console-board-sync-integration under lane runtime-and-kit"   || fail "HIGH-2: console-board-sync-integration is missing from the manifest or its lanes, got: $CI_MANIFEST_LANES"

CI_CHECK_RESULTS_DIR="$(mktemp -d)"
trap 'rm -rf "$CI_CHECK_RESULTS_DIR"' EXIT
if FLOW_AGENTS_CI_LANE=runtime-and-kit FLOW_AGENTS_CI_RESULTS_DIR="$CI_CHECK_RESULTS_DIR"   bash "$RUN_BASELINE_SH" --check console-board-sync-integration >"$CI_CHECK_RESULTS_DIR/run.out" 2>&1; then
  pass "HIGH-2: 'bash evals/ci/run-baseline.sh --check console-board-sync-integration' under FLOW_AGENTS_CI_LANE=runtime-and-kit actually runs and passes (the exact invocation ci.yml uses)"
else
  fail "HIGH-2: the real CI harness invocation failed: $(cat "$CI_CHECK_RESULTS_DIR/run.out" 2>/dev/null | tail -20)"
fi

# HIGH-3: an EXACT pinned @kontourai/console version (never the mutable @latest dist-tag),
# and --ignore-scripts on every npx invocation, in both copies.
for f in "$BOARD_SYNC_SH" "$CONTEXT_BOARD_SYNC_SH"; do
  grep -qE 'CONSOLE_PACKAGE_VERSION="[0-9]+\.[0-9]+\.[0-9]+"' "$f" || fail "$f does not pin an exact CONSOLE_PACKAGE_VERSION"
  grep -q '@kontourai/console@latest' "$f" && fail "$f still references the mutable @kontourai/console@latest dist-tag"
  grep -q -- '--ignore-scripts' "$f" || fail "$f does not pass --ignore-scripts to npm/npx"
done
pass "HIGH-3: console-board-sync.sh pins an exact @kontourai/console version and passes --ignore-scripts"

# HIGH-4: an atomic mkdir-based single-flight lock with a documented stale-takeover window.
for f in "$BOARD_SYNC_SH" "$CONTEXT_BOARD_SYNC_SH"; do
  grep -q 'LOCK_DIR=' "$f" || fail "$f does not define a LOCK_DIR"
  grep -qE 'mkdir "\$LOCK_DIR"' "$f" || fail "$f does not take the lock via an atomic mkdir"
  grep -q 'STALE_LOCK_AGE_SECONDS' "$f" || fail "$f has no stale-lock takeover threshold"
done
pass "HIGH-4: console-board-sync.sh takes an atomic mkdir-based lock with a stale-takeover threshold"

# MED-2: the hub URL is validated against the SAME allowlist function the telemetry
# transport itself uses (reused, not reimplemented).
for f in "$BOARD_SYNC_SH" "$CONTEXT_BOARD_SYNC_SH"; do
  grep -q 'console_telemetry_endpoint_allowed' "$f" || fail "$f does not validate the hub URL via console_telemetry_endpoint_allowed"
done
pass "MED-2: console-board-sync.sh reuses transport.sh's own console_telemetry_endpoint_allowed for the hub URL"

# MED-3: operator-private file creation (umask 077).
for f in "$BOARD_SYNC_SH" "$CONTEXT_BOARD_SYNC_SH"; do
  grep -q 'umask 077' "$f" || fail "$f does not set umask 077 before creating its lock/log"
done
pass "MED-3: console-board-sync.sh sets umask 077 before creating its lock/log"

# MED-4: log rotation happens AFTER lock acquisition (under the same lock), and bridge calls
# are wrapped with a timeout binary.
for f in "$BOARD_SYNC_SH" "$CONTEXT_BOARD_SYNC_SH"; do
  awk '
    /acquire_lock \|\| exit 0/ { lock_taken=1 }
    lock_taken && /LOG_MAX_BYTES/ { found=1 }
    END { exit !found }
  ' "$f" || fail "$f: log rotation does not appear to happen after lock acquisition"
  grep -q 'BRIDGE_TIMEOUT_SECONDS' "$f" || fail "$f does not bound bridge invocations with a timeout"
done
pass "MED-4: console-board-sync.sh rotates its log under the lock and bounds bridge invocations with a timeout"

# MED-5: trust-bridge SKIP-vs-FAILED is decided by a dedicated --help probe, not the real
# call's own exit code.
for f in "$BOARD_SYNC_SH" "$CONTEXT_BOARD_SYNC_SH"; do
  grep -qE 'kontour-trust-bridge --help' "$f" || fail "$f does not run a dedicated --help probe for kontour-trust-bridge"
done
pass "MED-5: console-board-sync.sh decides kontour-trust-bridge SKIP-vs-FAILED via a dedicated --help probe"

echo ""
echo "test_console_board_sync_wiring: all checks passed."
