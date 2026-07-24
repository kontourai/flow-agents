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
#   3. kontour-process-bridge --no-local  (npx -y -p @kontourai/console@latest)
#   4. kontour-trust-bridge   --no-local, ONLY if that bin resolves in the installed
#      @kontourai/console version -- @kontourai/console@2.8.0's published bin map predates
#      kontour-trust-bridge (rides next release); its absence is a log-skip, not a failure.
#
# Gated: runs ONLY when config.sh's resolved telemetry config (same resolution the rest of
# telemetry.sh uses, including ~/.flow-agents/telemetry-console.conf) carries BOTH a
# console_telemetry_url and a token. Otherwise this script exits 0 silently with zero side
# effects -- board sync must never nag an operator who never opted into a hosted console.
#
# Fail-soft everywhere: each step's failure is logged (at most a few lines, to the
# telemetry data dir) and the pipeline continues to the next step. This script's own exit
# code is always 0 once the gate is passed. Read-only over .kontourai/flow-agents (workflow
# state); .kontourai/console/projections is this pipeline's own generated, gitignored
# output. Never writes/fixes/deletes workflow state, never commits, and NEVER echoes the
# console auth token.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 0
export TELEMETRY_DIR="${TELEMETRY_DIR:-$SCRIPT_DIR}"
# shellcheck source=/dev/null
source "$TELEMETRY_DIR/lib/config.sh" 2>/dev/null || exit 0

REPO_ROOT="${TELEMETRY_WORKSPACE_ROOT}"
LOG_FILE="${TELEMETRY_DATA_DIR}/console-board-sync.log"
LOG_MAX_BYTES=$((5 * 1024 * 1024))

# --- gate: silently exit 0 (no log line, no side effect at all) unless BOTH a console
# telemetry URL and a token are configured. ---
CONSOLE_HUB_URL="${CONSOLE_TELEMETRY_URL:-}"
CONSOLE_TOKEN="${CONSOLE_TELEMETRY_TOKEN:-}"
[[ -z "$CONSOLE_HUB_URL" || -z "$CONSOLE_TOKEN" ]] && exit 0

# --- log rotation: truncate (not delete -- keeps the file identity stable for tailing)
# once past LOG_MAX_BYTES, same convention as the reference ~/.flow-agents
# console-board-runner.sh rotation. ---
if [[ -f "$LOG_FILE" ]]; then
  log_size=$(stat -f%z "$LOG_FILE" 2>/dev/null || stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)
  [[ "$log_size" -gt "$LOG_MAX_BYTES" ]] && : > "$LOG_FILE"
fi
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG_FILE" 2>/dev/null; }

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

# 1. process projection (#918: --skip-invalid so one malformed legacy sidecar never zeroes
# the whole repo's projection).
if ( cd "$REPO_ROOT" && "${FLOW_AGENTS_CLI[@]}" console-process-projection --skip-invalid --scope "$SCOPE_ID" ) >>"$LOG_FILE" 2>&1; then
  log "console-process-projection OK"
else
  log "console-process-projection FAILED (see above) -- continuing"
fi

# 2. trust projection.
if ( cd "$REPO_ROOT" && "${FLOW_AGENTS_CLI[@]}" console-trust-projection --scope "$SCOPE_ID" ) >>"$LOG_FILE" 2>&1; then
  log "console-trust-projection OK"
else
  log "console-trust-projection FAILED (see above) -- continuing"
fi

# --- bridge both envelopes to the hosted console. CONSOLE_AUTH_TOKEN is exported only into
# each bridge subshell's own environment (never printed, never logged). ---
if ! command -v npx >/dev/null 2>&1; then
  log "SKIP kontour-process-bridge and kontour-trust-bridge: npx is not available"
  log "RUN end"
  exit 0
fi

TENANT_ARGS=()
[[ -n "${CONSOLE_TENANT_ID:-}" ]] && TENANT_ARGS=(--tenant "$CONSOLE_TENANT_ID")

# 3. process bridge: always attempted -- published in every @kontourai/console release so far.
if ( cd "$REPO_ROOT" && CONSOLE_AUTH_TOKEN="$CONSOLE_TOKEN" npx -y -p @kontourai/console@latest kontour-process-bridge --no-local --hub "$CONSOLE_HUB_URL" "${TENANT_ARGS[@]}" ) >>"$LOG_FILE" 2>&1; then
  log "kontour-process-bridge OK"
else
  log "kontour-process-bridge FAILED (see above) -- continuing"
fi

# 4. trust bridge: graceful degradation. @kontourai/console@2.8.0's published bin map
# predates kontour-trust-bridge (rides next release). A shell "command not found" from
# npx's own bin resolution (exit 127, or the shell's literal "command not found" text) means
# the bin genuinely does not exist in the resolved package version yet -- that is a
# log-skip, not a failure. Any other non-zero exit is a real bridge failure, logged as
# such, still fail-soft (never aborts this script).
trust_bridge_status=0
trust_bridge_output=$(cd "$REPO_ROOT" && CONSOLE_AUTH_TOKEN="$CONSOLE_TOKEN" npx -y -p @kontourai/console@latest kontour-trust-bridge --no-local --hub "$CONSOLE_HUB_URL" "${TENANT_ARGS[@]}" 2>&1) || trust_bridge_status=$?
if [[ "$trust_bridge_status" -eq 0 ]]; then
  log "kontour-trust-bridge OK"
  printf '%s\n' "$trust_bridge_output" >>"$LOG_FILE" 2>/dev/null
elif [[ "$trust_bridge_status" -eq 127 || "$trust_bridge_output" == *"command not found"* || "$trust_bridge_output" == *"not found in this package"* ]]; then
  log "SKIP kontour-trust-bridge: not published in this @kontourai/console version yet (rides next release)"
else
  log "kontour-trust-bridge FAILED (exit $trust_bridge_status) -- continuing"
  printf '%s\n' "$trust_bridge_output" >>"$LOG_FILE" 2>/dev/null
fi

log "RUN end"
exit 0
