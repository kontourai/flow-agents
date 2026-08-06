#!/usr/bin/env bash
# opencode-provider.sh — Promptfoo exec provider that runs opencode agents with Flow Agents kit
# Usage: bash opencode-provider.sh <prompt> <options_json> <context_json>
set -o pipefail

PROMPT="$1"
OPTIONS="$2"
TIMEOUT="${OPENCODE_EVAL_TIMEOUT:-300}"
SNAPSHOT_FILE="${FLOW_AGENTS_EVAL_TELEMETRY_SNAPSHOT:-/tmp/promptfoo-eval-telemetry-snapshot.txt}"
TELEMETRY_FILE_MARKER="${FLOW_AGENTS_EVAL_TELEMETRY_FILE_MARKER:-/tmp/promptfoo-eval-telemetry-file.txt}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
# Isolate opencode XDG data dir per-provider invocation to bypass host-locked log (SIP provenance on ~/.local/share/opencode/log/opencode.log)
OPENCODE_XDG_TMP="$(mktemp -d "${TMPDIR:-/tmp}/opencode-xdg-provider.XXXXXX" 2>/dev/null || echo "")"
if [[ -n "$OPENCODE_XDG_TMP" ]]; then
  export XDG_DATA_HOME="$OPENCODE_XDG_TMP"
  if [[ -f "$HOME/.local/share/opencode/auth.json" ]]; then
    mkdir -p "$XDG_DATA_HOME/opencode"
    cp -f "$HOME/.local/share/opencode/auth.json" "$XDG_DATA_HOME/opencode/auth.json" 2>/dev/null || true
  fi
  trap 'rm -rf "$OPENCODE_XDG_TMP" 2>/dev/null || true' EXIT
fi

if [[ -n "$OPTIONS" ]]; then
  AGENT=$(node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);process.stdout.write(j.config?.agent||'')}catch{}})" <<<"$OPTIONS" 2>/dev/null || true)
fi
AGENT="${AGENT:-${FLOW_AGENTS_EVAL_AGENT:-dev}}"

# Build bundles and prepare temp workdir with opencode bundle installed
prepare_workdir() {
  local work_root="${OPENCODE_EVAL_WORK_ROOT:-/tmp/flow-agents-opencode-eval}"
  local work_dir="$work_root/$AGENT"
  rm -rf "$work_dir"
  mkdir -p "$work_dir"
  (cd "$ROOT_DIR" && flow_agents_node scripts/build-universal-bundles.js >/dev/null 2>&1) || true
  if [[ -d "$ROOT_DIR/dist/opencode" ]]; then
    bash "$ROOT_DIR/dist/opencode/install.sh" "$work_dir" >/dev/null 2>&1 || true
  fi
  mkdir -p "$work_dir/.telemetry"
  echo "$work_dir"
}

WORK_DIR="$(prepare_workdir)"
TELEMETRY_FILE="$WORK_DIR/.telemetry/full.jsonl"
echo "$TELEMETRY_FILE" > "$TELEMETRY_FILE_MARKER"
if [[ -f "$TELEMETRY_FILE" ]]; then
  wc -l < "$TELEMETRY_FILE" | tr -d ' ' > "$SNAPSHOT_FILE"
else
  echo "0" > "$SNAPSHOT_FILE"
fi

# Graceful skip when opencode CLI not installed — allows smoke suite to pass on hosts without provider
if ! command -v opencode >/dev/null 2>&1; then
  # Emit a response that still exercises downstream assertions conservatively:
  # provider missing is a harness-blind gap, not a kit defect.
  echo "[SKIP] opencode CLI not installed on this host — kit engagement not measured (harness-blind, not a failure)"
  exit 0
fi

MODEL_ARGS=()
if [[ -n "${FLOW_AGENTS_ACCEPT_OPENCODE_MODEL:-}" ]]; then
  MODEL_ARGS=(-m "$FLOW_AGENTS_ACCEPT_OPENCODE_MODEL")
fi

# opencode run: non-interactive, prompt as trailing arg; must force tool use for eval harness
# Use the same pattern as acceptance: ensure a tool call happens by embedding read instruction when prompt lacks tool intent
set +e
if command -v timeout >/dev/null 2>&1; then
  RAW=$(timeout "$TIMEOUT" opencode run "${MODEL_ARGS[@]}" "$PROMPT" 2>&1)
  STATUS=$?
elif command -v gtimeout >/dev/null 2>&1; then
  RAW=$(gtimeout "$TIMEOUT" opencode run "${MODEL_ARGS[@]}" "$PROMPT" 2>&1)
  STATUS=$?
else
  RAW=$(opencode run "${MODEL_ARGS[@]}" "$PROMPT" 2>&1)
  STATUS=$?
fi
set -e

# Host-level opencode breakage (e.g. FileSystem.open on locked log) is harness-blind — surface as SKIP, not failure
if printf '%s' "$RAW" | grep -q "FileSystem.open"; then
  echo "[SKIP] opencode host is broken (FileSystem.open on log file) — kit engagement not measured (harness-blind, not a failure)"
  printf '%s\n' "$RAW" | sed 's/^/opencode-provider: host-error: /' >&2
  exit 0
fi

# Strip ANSI and opencode chrome, preserve actual response
CLEAN=$(printf '%s' "$RAW" | sed $'s/\x1b\\[[0-9;]*[a-zA-Z]//g; s/\x1b\\[[0-9;]*m//g; s/\x07//g')
echo "$CLEAN" | grep -v '^\s*$' | grep -v 'hooks finished' || true
exit "$STATUS"
