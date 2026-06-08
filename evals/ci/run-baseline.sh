#!/usr/bin/env bash
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RESULTS_DIR="${FLOW_AGENTS_CI_RESULTS_DIR:-$ROOT_DIR/evals/results/ci-baseline}"
LOG_DIR="$RESULTS_DIR/logs"
STATUS_FILE="$RESULTS_DIR/status.tsv"
SUMMARY_FILE="$RESULTS_DIR/summary.md"

mkdir -p "$LOG_DIR"
: >"$STATUS_FILE"

pass=0
fail=0
skip=0

slugify() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-//; s/-$//'
}

run_check() {
  local label="$1"
  local command="$2"
  local id
  id="$(slugify "$label")"
  local log="$LOG_DIR/$id.log"

  echo "==> $label"
  echo "+ $command" >"$log"
  if (cd "$ROOT_DIR" && bash -lc "$command") >>"$log" 2>&1; then
    echo -e "$id\t$label\tpass\t$command\t$log" >>"$STATUS_FILE"
    pass=$((pass + 1))
    echo "PASS $label"
  else
    echo -e "$id\t$label\tfail\t$command\t$log" >>"$STATUS_FILE"
    fail=$((fail + 1))
    echo "FAIL $label (see $log)"
  fi
  echo ""
}

record_skip() {
  local label="$1"
  local reason="$2"
  local id
  id="$(slugify "$label")"
  echo -e "$id\t$label\tskip\t$reason\t" >>"$STATUS_FILE"
  skip=$((skip + 1))
}

run_check "Content boundary" "npm run check:content-boundary --"
run_check "Source tree validation" "npm run validate:source --"
run_check "Context map drift" "npm run context-map -- --check"
run_check "Static eval suite" "bash evals/run.sh static"
run_check "Workflow artifact integration" "bash evals/integration/test_workflow_artifacts.sh"
run_check "Workflow artifact cleanup audit integration" "bash evals/integration/test_workflow_artifact_cleanup_audit.sh"
run_check "Publish-change helper integration" "bash evals/integration/test_publish_change_helper.sh"
run_check "Workflow sidecar writer integration" "bash evals/integration/test_workflow_sidecar_writer.sh"
run_check "Goal Fit hook integration" "bash evals/integration/test_goal_fit_hook.sh"
run_check "Workflow steering hook integration" "bash evals/integration/test_workflow_steering_hook.sh"
run_check "Hook influence contract integration" "bash evals/integration/test_hook_influence_cases.sh"
run_check "Flow Kit repository integration" "bash evals/integration/test_flow_kit_repository.sh"
run_check "Runtime adapter activation integration" "bash evals/integration/test_runtime_adapter_activation.sh"
run_check "Bundle install integration" "bash evals/integration/test_bundle_install.sh"

record_skip "Live GitHub mutation checks" "Skipped by default; publish-change/live provider mutation checks require an explicit maintainer-run lane."
record_skip "LLM acceptance evals" "Skipped by default; invoke acceptance or LLM eval lanes separately with explicit opt-in flags."
record_skip "Veritas governance provider evidence" "Skipped unless a governance adapter is configured; evidence-gate must record NOT_VERIFIED when required evidence is unavailable."

{
  echo "# Flow Agents CI Evidence Summary"
  echo ""
  echo "| Status | Check | Command or rationale | Log |"
  echo "| --- | --- | --- | --- |"
  while IFS=$'\t' read -r id label status command log; do
    case "$status" in
      pass) marker="PASS" ;;
      fail) marker="FAIL" ;;
      skip) marker="SKIP" ;;
      *) marker="$status" ;;
    esac
    if [[ -n "$log" ]]; then
      rel_log="${log#$ROOT_DIR/}"
      echo "| $marker | $label | \`$command\` | \`$rel_log\` |"
    else
      echo "| $marker | $label | $command | |"
    fi
  done <"$STATUS_FILE"
  echo ""
  echo "Totals: $pass passed, $fail failed, $skip skipped."
  echo ""
  echo "Skipped live/provider/LLM checks are not a clean substitute for provider evidence. Evidence-gate and release-readiness must carry them as explicit skip or NOT_VERIFIED entries according to change risk."
} >"$SUMMARY_FILE"

echo "Summary written to $SUMMARY_FILE"

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  cat "$SUMMARY_FILE" >>"$GITHUB_STEP_SUMMARY"
fi

if [[ "$fail" -gt 0 ]]; then
  exit 1
fi

exit 0
