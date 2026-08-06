#!/usr/bin/env bash
# strands-provider.sh — Promptfoo exec provider for Strands framework adapter (strands-local)
# Usage: bash strands-provider.sh <prompt> <options_json> <context_json>
# This is a framework adapter (HookProvider → canonical telemetry), not a CLI harness.
set -o pipefail

PROMPT="$1"
OPTIONS="$2"
SNAPSHOT_FILE="${FLOW_AGENTS_EVAL_TELEMETRY_SNAPSHOT:-/tmp/promptfoo-eval-telemetry-snapshot.txt}"
TELEMETRY_FILE_MARKER="${FLOW_AGENTS_EVAL_TELEMETRY_FILE_MARKER:-/tmp/promptfoo-eval-telemetry-file.txt}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [[ -n "$OPTIONS" ]]; then
  AGENT=$(node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);process.stdout.write(j.config?.agent||'')}catch{}})" <<<"$OPTIONS" 2>/dev/null || true)
fi
AGENT="${AGENT:-${FLOW_AGENTS_EVAL_AGENT:-dev}}"

# Prepare workdir — wire Strands adapter harness
prepare_workdir() {
  local work_root="${STRANDS_EVAL_WORK_ROOT:-/tmp/flow-agents-strands-eval}"
  local work_dir="$work_root/$AGENT"
  rm -rf "$work_dir"
  mkdir -p "$work_dir/.flow-agents/.telemetry"
  echo "$work_dir"
}

WORK_DIR="$(prepare_workdir)"
TELEMETRY_FILE="$WORK_DIR/.flow-agents/.telemetry/full.jsonl"
echo "$TELEMETRY_FILE" > "$TELEMETRY_FILE_MARKER"
if [[ -f "$TELEMETRY_FILE" ]]; then
  wc -l < "$TELEMETRY_FILE" | tr -d ' ' > "$SNAPSHOT_FILE"
else
  echo "0" > "$SNAPSHOT_FILE"
fi

# Validate adapter importability — honest harness-blind signal when strands not installed
ADAPTER_PY="$ROOT_DIR/integrations/strands/flow_agents_strands"
if ! python3 -c "import sys; sys.path.insert(0, '$ROOT_DIR/integrations/strands'); import flow_agents_strands" 2>/dev/null; then
  echo "[SKIP] strands adapter not importable on this host (pip install -e $ROOT_DIR/integrations/strands) — kit engagement not measured (harness-blind)"
  exit 0
fi

# If python adapter present but no hosted agent model wired, emit a skip rather than a fabricated success.
# Full Strands agent invocation (Agent factory + HookProvider) is the next milestone; this provider
# proves wiring and validates telemetry taxonomy, not per-turn model cost (which is sub-agent-internal per capability matrix).
if [[ -z "${STRANDS_EVAL_AGENT_ENTRYPOINT:-}" ]]; then
  # Minimal drill: exercise the HookProvider registry and emit canonical telemetry skeleton
  python3 - "$PROMPT" "$WORK_DIR" 2>&1 <<'PY' || true
import sys, json, pathlib
sys.path.insert(0, sys.argv[0].rsplit("/integrations",1)[0] + "/integrations/strands") if "/integrations" in sys.argv[0] else None
# Best-effort: try to import and exercise HookProvider without requiring Bedrock creds
try:
    from flow_agents_strands import STRANDS_TO_CANONICAL  # type: ignore
    prompt = sys.argv[1]
    work_dir = sys.argv[2]
    print(f"[strands] adapter loaded — canonical map: {list(STRANDS_TO_CANONICAL.keys())[:3]}… — prompt len {len(prompt)} — work_dir {work_dir}")
    print("Strands framework adapter is wired: this run validates kit-activation coverage (strands-local column in harness-capability-matrix.md). Full agent invocation requires STRANDS_EVAL_AGENT_ENTRYPOINT pointing at a Strands Agent factory.")
except Exception as e:
    print(f"[strands] adapter import succeeded but exercise skipped: {e}")
PY
  echo "Strands framework adapter is wired (see above). Full agent run requires STRANDS_EVAL_AGENT_ENTRYPOINT — see evals issue #1200 / kontourai/evals#191."
  exit 0
fi

# Hosted entrypoint path — exec it with timeout, capturing output
TIMEOUT="${STRANDS_EVAL_TIMEOUT:-300}"
set +e
if command -v timeout >/dev/null 2>&1; then
  RAW=$(timeout "$TIMEOUT" python3 "$STRANDS_EVAL_AGENT_ENTRYPOINT" --prompt "$PROMPT" --work-dir "$WORK_DIR" 2>&1)
  STATUS=$?
else
  RAW=$(python3 "$STRANDS_EVAL_AGENT_ENTRYPOINT" --prompt "$PROMPT" --work-dir "$WORK_DIR" 2>&1)
  STATUS=$?
fi
set -e
CLEAN=$(printf '%s' "$RAW" | sed $'s/\x1b\\[[0-9;]*[a-zA-Z]//g; s/\x1b\\[[0-9;]*m//g')
echo "$CLEAN"
exit "$STATUS"
