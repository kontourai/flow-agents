#!/usr/bin/env bash
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RESULTS_DIR="${FLOW_AGENTS_CI_RESULTS_DIR:-$ROOT_DIR/evals/results/ci-baseline}"
LOG_DIR="$RESULTS_DIR/logs"
STATUS_FILE="$RESULTS_DIR/status.tsv"
SUMMARY_FILE="$RESULTS_DIR/summary.md"

mkdir -p "$LOG_DIR"

CHECKS=(
  "Content boundary|npm run check:content-boundary --"
  "Source tree validation|npm run validate:source --"
  "Context map drift|npm run context-map -- --check"
  "Static eval suite|bash evals/run.sh static"
  "Workflow artifact integration|bash evals/integration/test_workflow_artifacts.sh"
  "Workflow artifact cleanup audit integration|bash evals/integration/test_workflow_artifact_cleanup_audit.sh"
  "Publish-change helper integration|bash evals/integration/test_publish_change_helper.sh"
  "Workflow sidecar writer integration|bash evals/integration/test_workflow_sidecar_writer.sh"
  "Goal Fit hook integration|bash evals/integration/test_goal_fit_hook.sh"
  "Workflow steering hook integration|bash evals/integration/test_workflow_steering_hook.sh"
  "Hook influence contract integration|bash evals/integration/test_hook_influence_cases.sh"
  "Flow Kit repository integration|bash evals/integration/test_flow_kit_repository.sh"
  "Runtime adapter activation integration|bash evals/integration/test_runtime_adapter_activation.sh"
  "Bundle install integration|bash evals/integration/test_bundle_install.sh"
)

slugify() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-//; s/-$//'
}

init_results() {
  mkdir -p "$LOG_DIR"
  : >"$STATUS_FILE"
}

find_check() {
  local requested="$1"
  local entry label command id
  for entry in "${CHECKS[@]}"; do
    label="${entry%%|*}"
    command="${entry#*|}"
    id="$(slugify "$label")"
    if [[ "$requested" == "$id" || "$requested" == "$label" ]]; then
      printf '%s\t%s\t%s\n' "$id" "$label" "$command"
      return 0
    fi
  done
  return 1
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
    echo "PASS $label"
  else
    echo -e "$id\t$label\tfail\t$command\t$log" >>"$STATUS_FILE"
    echo "FAIL $label (see $log)"
    return 1
  fi
  echo ""
}

record_skip() {
  local label="$1"
  local reason="$2"
  local id
  id="$(slugify "$label")"
  if [[ -f "$STATUS_FILE" ]] && grep -q "^$id"$'\t' "$STATUS_FILE"; then
    return
  fi
  echo -e "$id\t$label\tskip\t$reason\t" >>"$STATUS_FILE"
}

ensure_expected_results() {
  local entry label id count

  touch "$STATUS_FILE"
  for entry in "${CHECKS[@]}"; do
    label="${entry%%|*}"
    id="$(slugify "$label")"
    count="$(awk -F'\t' -v expected="$id" '$1 == expected { count += 1 } END { print count + 0 }' "$STATUS_FILE")"
    if [[ "$count" -eq 0 ]]; then
      echo -e "$id\t$label\tfail\tmissing CI result row\t" >>"$STATUS_FILE"
    elif [[ "$count" -gt 1 ]]; then
      echo -e "$id-duplicate\t$label duplicate result\tfail\tduplicate CI result rows for $id\t" >>"$STATUS_FILE"
    fi
  done
}

finalize_results() {
  local pass=0
  local fail=0
  local skip=0
  local id label status command log marker rel_log

  ensure_expected_results
  record_skip "Live GitHub mutation checks" "Skipped by default; publish-change/live provider mutation checks require an explicit maintainer-run lane."
  record_skip "LLM acceptance evals" "Skipped by default; invoke acceptance or LLM eval lanes separately with explicit opt-in flags."
  record_skip "Veritas governance provider evidence" "Skipped unless a governance adapter is configured; evidence-gate must record NOT_VERIFIED when required evidence is unavailable."

  while IFS=$'\t' read -r id label status command log; do
    case "$status" in
      pass) pass=$((pass + 1)) ;;
      fail) fail=$((fail + 1)) ;;
      skip) skip=$((skip + 1)) ;;
      *) fail=$((fail + 1)) ;;
    esac
  done <"$STATUS_FILE"

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
}

case "${1:-}" in
  --init)
    init_results
    ;;
  --check)
    if [[ -z "${2:-}" ]]; then
      echo "Usage: $0 --check <check-id-or-label>" >&2
      exit 2
    fi
    if ! check_row="$(find_check "$2")"; then
      echo "Unknown CI baseline check: $2" >&2
      exit 2
    fi
    IFS=$'\t' read -r _check_id check_label check_command <<<"$check_row"
    run_check "$check_label" "$check_command"
    ;;
  --finalize)
    finalize_results
    ;;
  "")
    init_results
    for entry in "${CHECKS[@]}"; do
      run_check "${entry%%|*}" "${entry#*|}" || true
    done
    finalize_results
    ;;
  *)
    echo "Usage: $0 [--init|--check <check-id-or-label>|--finalize]" >&2
    exit 2
    ;;
esac
