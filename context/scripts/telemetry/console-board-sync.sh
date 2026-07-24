#!/usr/bin/env bash
# console-board-sync.sh — hook-native, detached, cwd-scoped console board sync (#919).
#
# Best-effort projection+bridge of THIS repo's local flow-agents workflow state onto a
# hosted Kontour console board. Invoked (detached, best-effort) from telemetry.sh's stop
# flow immediately after the economics-record step, mirroring economics-record.sh's EXACT
# "(cmd) </dev/null >/dev/null 2>&1 & disown" detached best-effort pattern (#349) -- board
# transparency rides the existing session harness, never a launchd/cron daemon, and can
# never alter telemetry timing or fail the stop hook. This script runs ONCE per invocation
# and exits; it is not a standing process.
#
# Pipeline (current repo only, cwd-scoped -- never sweeps other repos):
#   1. console-process-projection --skip-invalid  (#918: warn+skip a malformed legacy
#      state.json/handoff.json instead of aborting the whole projection)
#   2. console-trust-projection
#   3. kontour-process-bridge --no-local, ONLY if step 1 succeeded THIS run (review MED-1:
#      never re-bridge a stale pre-existing envelope when the fresh projection failed).
#   4. kontour-trust-bridge   --no-local, ONLY if step 2 succeeded THIS run, AND only if a
#      dedicated `--help` probe proves the bin resolves in the pinned @kontourai/console
#      version -- @kontourai/console@2.8.0's published bin map predates kontour-trust-bridge
#      (rides next release); its confirmed absence is a log-skip, not a failure (review
#      MED-5: any OTHER probe failure is a real FAILED, never silently downgraded to skip).
#
# Gated: runs ONLY when config.sh's resolved telemetry config (same resolution the rest of
# telemetry.sh uses, including ~/.flow-agents/telemetry-console.conf) carries BOTH a
# console_telemetry_url and a token. Otherwise this script exits 0 silently with zero side
# effects of its own -- board sync must never nag an operator who never opted into a hosted
# console. (Sourcing config.sh itself may create the shared TELEMETRY_DATA_DIR/SESSION_DIR
# scaffold unconditionally -- that is config.sh's own long-standing behavior, shared by
# every telemetry.sh hook event in the session, not something this script introduces or
# extends when gated off; "zero side effects" below means no console-board-sync.log, no
# lock, no CLI invocation, no npx invocation.)
#
# Single-flight (review HIGH-4): an atomic mkdir-based lock at
# ${TELEMETRY_DATA_DIR}/console-board-sync.lock serializes concurrent detached Stops so two
# runs never truncate/read the shared projection files mid-write. A lock held by a live
# concurrent run is respected by exiting 0 quietly (no log line -- the NEXT Stop's whole-
# state sync reconciles, so skipping is always safe); a lock older than
# STALE_LOCK_AGE_SECONDS is treated as an orphaned lock from a crashed/killed prior run and
# is taken over (logged, since that IS worth knowing about).
#
# Fail-soft everywhere: each step's failure is logged (output capped per step -- review
# MED-3 -- to the telemetry data dir) and the pipeline continues to the next step. This
# script's own exit code is always 0 once the gate is passed. Read-only over
# .kontourai/flow-agents (workflow state); .kontourai/console/projections is this pipeline's
# own generated, gitignored output. Never writes/fixes/deletes workflow state, never
# commits, and NEVER echoes the console auth token (scoped only into each bridge
# subprocess's own environment via the `env` binary, never exported into this shell).
#
# Supply-chain trust boundary (review HIGH-3): CONSOLE_PACKAGE_VERSION below is an EXACT,
# pinned @kontourai/console release, never the mutable `@latest` dist-tag -- a compromised
# `latest` publish would otherwise execute arbitrary code with CONSOLE_AUTH_TOKEN in its
# environment on every single Stop. `--ignore-scripts` additionally suppresses the pinned
# package's own npm install-time lifecycle scripts. To adopt a newer verified release: (1)
# confirm the new version's `kontour-process-bridge`/`kontour-trust-bridge` behavior against
# a real hosted console, (2) bump CONSOLE_PACKAGE_VERSION below in BOTH this file and its
# context/ mirror, (3) re-run evals/integration/test_console_board_sync.sh.
set -uo pipefail

# Portability note: every possibly-empty array below is expanded as
# "${ARR[@]+"${ARR[@]}"}" rather than plain "${ARR[@]}" -- macOS's stock /bin/bash (3.2,
# pre-GPLv3) treats a zero-element array as unbound under `set -u` and aborts with
# "unbound variable" on plain expansion; bash >= 4.4 does not, but this script's shebang
# resolves whichever `bash` PATH finds first, which is not guaranteed to be a modern one.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 0
export TELEMETRY_DIR="${TELEMETRY_DIR:-$SCRIPT_DIR}"
# shellcheck source=/dev/null
source "$TELEMETRY_DIR/lib/config.sh" 2>/dev/null || exit 0

# --- gate: silently exit 0 (no log line, no side effect of this script's own) unless BOTH a
# console telemetry URL and a token are configured. ---
CONSOLE_HUB_URL="${CONSOLE_TELEMETRY_URL:-}"
CONSOLE_TOKEN="${CONSOLE_TELEMETRY_TOKEN:-}"
[[ -z "$CONSOLE_HUB_URL" || -z "$CONSOLE_TOKEN" ]] && exit 0

# Review HIGH-1: REPO_ROOT is the STOPPED SESSION's own cwd, passed explicitly by
# telemetry.sh (FLOW_AGENTS_BOARD_SYNC_CWD) -- NEVER config.sh's TELEMETRY_WORKSPACE_ROOT,
# which resolves relative to TELEMETRY_DIR (the telemetry SCRIPT's install location). For a
# per-project install those happen to coincide; for a globally-installed hook they do not,
# and using TELEMETRY_WORKSPACE_ROOT there would silently project the install's own state
# (station reproduced: 0 vs 57 processes) and never the project that actually stopped.
REPO_ROOT="${FLOW_AGENTS_BOARD_SYNC_CWD:-$PWD}"
[[ -d "$REPO_ROOT" ]] || exit 0

CONSOLE_PACKAGE_VERSION="2.8.0"
LOG_FILE="${TELEMETRY_DATA_DIR}/console-board-sync.log"
LOG_MAX_BYTES=$((5 * 1024 * 1024))
LOG_STEP_MAX_BYTES=$((64 * 1024))
STALE_LOCK_AGE_SECONDS=600
BRIDGE_TIMEOUT_SECONDS=120
LOCK_DIR="${TELEMETRY_DATA_DIR}/console-board-sync.lock"

# Review MED-3: everything this script creates from here on (lock dir, log file) is
# operator-private.
umask 077

# --- single-flight lock (review HIGH-4): atomic mkdir, stale-takeover, quiet skip. ---
LOCK_STATE="none"
acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    LOCK_STATE="fresh"
    printf '%s\n' "$$" >"$LOCK_DIR/pid" 2>/dev/null || true
    return 0
  fi
  local lock_epoch now age
  # BUG FIX (real-CI-caught): each stat variant MUST be its own separate assignment+||,
  # never combined inside one $(cmd1 || cmd2) command substitution. GNU stat's `-f` means
  # "filesystem status" (not BSD/macOS's `-f FORMAT`), so on Linux `stat -f%m X` treats `%m`
  # as a SECOND bogus file argument; if X still resolves, stat prints a real (but wrong-mode)
  # dump for X and then exits NONZERO overall (because the `%m` "file" failed) -- which,
  # inside a single combined $(... || ...), lets the second command's output get APPENDED
  # after the first command's partial stdout instead of cleanly replacing it. Three
  # independent assignments (mirroring lib/config.sh's telemetry_conf_trusted) avoid this.
  lock_epoch=$(stat -f%m "$LOCK_DIR" 2>/dev/null) || lock_epoch=$(stat -c%Y "$LOCK_DIR" 2>/dev/null) || lock_epoch=0
  now=$(date +%s)
  age=$((now - lock_epoch))
  if [[ "$lock_epoch" -gt 0 && "$age" -gt "$STALE_LOCK_AGE_SECONDS" ]]; then
    rm -rf "$LOCK_DIR" 2>/dev/null || true
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      LOCK_STATE="stale-recovered"
      printf '%s\n' "$$" >"$LOCK_DIR/pid" 2>/dev/null || true
      return 0
    fi
  fi
  return 1
}
acquire_lock || exit 0

PROBE_OUT=""
cleanup() {
  [[ -n "$PROBE_OUT" ]] && rm -f "$PROBE_OUT" 2>/dev/null
  rm -rf "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG_FILE" 2>/dev/null; }

# --- log rotation (review MED-4: performed under the same lock): truncate (not delete --
# keeps the file identity stable for tailing) once past LOG_MAX_BYTES, same convention as
# the reference ~/.flow-agents console-board-runner.sh rotation. ---
if [[ -f "$LOG_FILE" ]]; then
  # Same fix as lock_epoch above: independent assignments, never combined in one $(...).
  log_size=$(stat -f%z "$LOG_FILE" 2>/dev/null) || log_size=$(stat -c%s "$LOG_FILE" 2>/dev/null) || log_size=0
  [[ "$log_size" -gt "$LOG_MAX_BYTES" ]] && : >"$LOG_FILE"
fi
[[ "$LOCK_STATE" == "stale-recovered" ]] && log "recovered a stale lock older than ${STALE_LOCK_AGE_SECONDS}s (an interrupted/crashed prior run) -- proceeding"

# --- review MED-2: refuse to send the console auth token anywhere outside the SAME
# scheme/host allowlist the telemetry transport itself enforces (https://, or
# http://localhost|127.0.0.1). Reuses transport.sh's own console_telemetry_endpoint_allowed
# rather than re-implementing an allowlist. ---
# shellcheck source=/dev/null
if ! source "$TELEMETRY_DIR/lib/transport.sh" 2>/dev/null; then
  log "SKIP: lib/transport.sh unavailable -- cannot validate the console hub URL scheme"
  exit 0
fi
if ! console_telemetry_endpoint_allowed "$CONSOLE_HUB_URL"; then
  log "REFUSED: console hub URL is not in the allowed scheme list (must be https://, or http://localhost|127.0.0.1): $CONSOLE_HUB_URL"
  exit 0
fi

# --- locate the flow-agents CLI: this repo's own dev build when running inside a
# flow-agents checkout, else an installed/bundled `flow-agents` bin. Mirrors
# scripts/hooks/utterance-check.js's findPackageRoot convention: build/src/cli.js sitting
# next to package.json identifies an in-repo checkout; otherwise fall back to a locally
# installed dependency's node_modules/.bin, then a globally installed bin on PATH. ---
FLOW_AGENTS_CLI=()
if [[ -f "$REPO_ROOT/build/src/cli.js" ]]; then
  FLOW_AGENTS_CLI=(node "$REPO_ROOT/build/src/cli.js")
elif [[ -x "$REPO_ROOT/node_modules/.bin/flow-agents" ]]; then
  FLOW_AGENTS_CLI=("$REPO_ROOT/node_modules/.bin/flow-agents")
elif command -v flow-agents >/dev/null 2>&1; then
  FLOW_AGENTS_CLI=(flow-agents)
else
  log "SKIP: no flow-agents CLI found (checked $REPO_ROOT/build/src/cli.js, $REPO_ROOT/node_modules/.bin/flow-agents, and PATH) -- cannot project"
  exit 0
fi

SCOPE_ID="$(basename "$REPO_ROOT")"
log "RUN start (repo=$REPO_ROOT scope=$SCOPE_ID)"

# Review MED-3: caps a step's combined stdout+stderr to LOG_STEP_MAX_BYTES before appending
# to the log (never an unbounded child dump), and returns the REAL command exit code (not
# `head`'s) via PIPESTATUS[0] -- a pipeline's own exit status would otherwise reflect `head`,
# which almost always exits 0.
run_step_capped() { # <repo_root> -- <argv...>
  local repo="$1"
  shift
  (cd "$repo" && "$@") 2>&1 | head -c "$LOG_STEP_MAX_BYTES" >>"$LOG_FILE"
  return "${PIPESTATUS[0]}"
}

# Same as run_step_capped, but ALSO writes the (uncapped) raw output to <out_file> for the
# caller to inspect (e.g. the trust-bridge absence probe's stderr text), in addition to the
# capped log append.
run_step_captured() { # <out_file> <repo_root> -- <argv...>
  local out_file="$1" repo="$2"
  shift 2
  (cd "$repo" && "$@") >"$out_file" 2>&1
  local status=$?
  head -c "$LOG_STEP_MAX_BYTES" "$out_file" >>"$LOG_FILE"
  return "$status"
}

# 1. process projection (#918: --skip-invalid so one malformed legacy sidecar never zeroes
# the whole repo's projection).
PROCESS_PROJECTION_OK=0
if run_step_capped "$REPO_ROOT" "${FLOW_AGENTS_CLI[@]+"${FLOW_AGENTS_CLI[@]}"}" console-process-projection --skip-invalid --scope "$SCOPE_ID"; then
  log "console-process-projection OK"
  PROCESS_PROJECTION_OK=1
else
  log "console-process-projection FAILED (see above) -- continuing"
fi

# 2. trust projection.
TRUST_PROJECTION_OK=0
if run_step_capped "$REPO_ROOT" "${FLOW_AGENTS_CLI[@]+"${FLOW_AGENTS_CLI[@]}"}" console-trust-projection --scope "$SCOPE_ID"; then
  log "console-trust-projection OK"
  TRUST_PROJECTION_OK=1
else
  log "console-trust-projection FAILED (see above) -- continuing"
fi

# --- bridge both envelopes to the hosted console. CONSOLE_AUTH_TOKEN is passed only via the
# `env` binary directly into each bridge subprocess's own argv/environment (never exported
# into this shell, never printed, never logged). ---
if ! command -v npx >/dev/null 2>&1; then
  log "SKIP kontour-process-bridge and kontour-trust-bridge: npx is not available"
  log "RUN end"
  exit 0
fi

# Review MED-4: bound every npx/bridge invocation so a hung registry/network call can never
# accumulate as an orphaned detached process. `timeout` (GNU coreutils) or its macOS/BSD
# `gtimeout` alias; if neither is available the call proceeds unbounded (best-effort, same
# as every other step here).
TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN="gtimeout"
fi
BRIDGE_TIMEOUT_PREFIX=()
[[ -n "$TIMEOUT_BIN" ]] && BRIDGE_TIMEOUT_PREFIX=("$TIMEOUT_BIN" "$BRIDGE_TIMEOUT_SECONDS")

TENANT_ARGS=()
[[ -n "${CONSOLE_TENANT_ID:-}" ]] && TENANT_ARGS=(--tenant "$CONSOLE_TENANT_ID")

# 3. process bridge: only if THIS run's process projection actually succeeded (review MED-1
# -- never re-bridge a stale pre-existing envelope on a run where the fresh projection
# failed). Published in every @kontourai/console release so far, so no absence probe needed.
if [[ "$PROCESS_PROJECTION_OK" -eq 1 ]]; then
  if run_step_capped "$REPO_ROOT" "${BRIDGE_TIMEOUT_PREFIX[@]+"${BRIDGE_TIMEOUT_PREFIX[@]}"}" env CONSOLE_AUTH_TOKEN="$CONSOLE_TOKEN" npx --ignore-scripts -y -p "@kontourai/console@${CONSOLE_PACKAGE_VERSION}" kontour-process-bridge --no-local --hub "$CONSOLE_HUB_URL" "${TENANT_ARGS[@]+"${TENANT_ARGS[@]}"}"; then
    log "kontour-process-bridge OK"
  else
    log "kontour-process-bridge FAILED (see above) -- continuing"
  fi
else
  log "SKIP kontour-process-bridge: console-process-projection did not succeed this run -- refusing to bridge a stale/pre-existing envelope"
fi

# 4. trust bridge: only if THIS run's trust projection succeeded (review MED-1, same
# rationale as step 3). Graceful degradation (review MED-5): a DEDICATED `--help` probe --
# never the real bridge call's own exit code -- decides SKIP vs FAILED. @kontourai/console's
# pinned version's published bin map may predate kontour-trust-bridge (rides a later
# release); that specific, confirmed absence (probe exit 127 AND its stderr names the bin)
# is a log-skip. ANY other probe outcome that is not a clean success is a real FAILED --
# never silently downgraded to a skip just because SOME error occurred.
if [[ "$TRUST_PROJECTION_OK" -eq 1 ]]; then
  PROBE_OUT="$(mktemp "${TMPDIR:-/tmp}/console-board-sync-probe.XXXXXX" 2>/dev/null || true)"
  if [[ -z "$PROBE_OUT" ]]; then
    log "kontour-trust-bridge FAILED: could not create a scratch probe file"
  else
    probe_status=0
    run_step_captured "$PROBE_OUT" "$REPO_ROOT" "${BRIDGE_TIMEOUT_PREFIX[@]+"${BRIDGE_TIMEOUT_PREFIX[@]}"}" npx --ignore-scripts -y -p "@kontourai/console@${CONSOLE_PACKAGE_VERSION}" kontour-trust-bridge --help || probe_status=$?
    probe_output="$(cat "$PROBE_OUT" 2>/dev/null || true)"
    rm -f "$PROBE_OUT" 2>/dev/null || true
    PROBE_OUT=""
    if [[ "$probe_status" -eq 127 && "$probe_output" == *"kontour-trust-bridge"* ]]; then
      log "SKIP kontour-trust-bridge: not published in this @kontourai/console version yet (rides next release; probe confirmed the bin does not resolve)"
    elif [[ "$probe_status" -ne 0 ]]; then
      log "kontour-trust-bridge FAILED (absence probe exited $probe_status, see above) -- continuing"
    elif run_step_capped "$REPO_ROOT" "${BRIDGE_TIMEOUT_PREFIX[@]+"${BRIDGE_TIMEOUT_PREFIX[@]}"}" env CONSOLE_AUTH_TOKEN="$CONSOLE_TOKEN" npx --ignore-scripts -y -p "@kontourai/console@${CONSOLE_PACKAGE_VERSION}" kontour-trust-bridge --no-local --hub "$CONSOLE_HUB_URL" "${TENANT_ARGS[@]+"${TENANT_ARGS[@]}"}"; then
      log "kontour-trust-bridge OK"
    else
      log "kontour-trust-bridge FAILED (see above) -- continuing"
    fi
  fi
else
  log "SKIP kontour-trust-bridge: console-trust-projection did not succeed this run -- refusing to bridge a stale/pre-existing envelope"
fi

log "RUN end"
exit 0
