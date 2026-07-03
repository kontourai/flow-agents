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
  "Decision registry|npm run check:decisions --"
  "Source tree validation|npm run validate:source --"
  "Context map drift|npm run context-map -- --check"
  "Static eval suite|bash evals/run.sh static"
  "Workflow artifact integration|bash evals/integration/test_workflow_artifacts.sh"
  "Workflow artifact cleanup audit integration|bash evals/integration/test_workflow_artifact_cleanup_audit.sh"
  "Fixture retirement audit integration|bash evals/integration/test_fixture_retirement_audit.sh"
  "Publish-change helper integration|bash evals/integration/test_publish_change_helper.sh"
  "Workflow sidecar writer integration|bash evals/integration/test_workflow_sidecar_writer.sh"
  "Sidecar field preservation integration|bash evals/integration/test_sidecar_field_preservation.sh"
  "Actor identity resolver integration|bash evals/integration/test_actor_identity.sh"
  "Goal Fit hook integration|bash evals/integration/test_goal_fit_hook.sh"
  "Hook category behavior integration|bash evals/integration/test_hook_category_behaviors.sh"
  "Workflow steering hook integration|bash evals/integration/test_workflow_steering_hook.sh"
  "Hook influence contract integration|bash evals/integration/test_hook_influence_cases.sh"
  "Flow Kit repository integration|bash evals/integration/test_flow_kit_repository.sh"
  "Runtime adapter activation integration|bash evals/integration/test_runtime_adapter_activation.sh"
  "Bundle install integration|bash evals/integration/test_bundle_install.sh"
  "Bundle lifecycle integration|bash evals/integration/test_bundle_lifecycle.sh"
  "Activate npx context integration|bash evals/integration/test_activate_npx_context.sh"
  "Kit conformance levels integration|bash evals/integration/test_kit_conformance_levels.sh"
  "Local Flow Kit install integration|bash evals/integration/test_local_flow_kit_install.sh"
  "Flow Kit install-git integration|bash evals/integration/test_flow_kit_install_git.sh"
  "Console learning projection integration|bash evals/integration/test_console_learning_projection.sh"
  "Context map integration|bash evals/integration/test_context_map.sh"
  "Effective backlog settings integration|bash evals/integration/test_effective_backlog_settings.sh"
  "Flow agents statusline integration|bash evals/integration/test_flow_agents_statusline.sh"
  "Telemetry contract integration|bash evals/integration/test_telemetry.sh"
  "Liveness heartbeat integration|bash evals/integration/test_liveness_heartbeat.sh"
  "Pull work liveness preflight integration|bash evals/integration/test_pull_work_liveness_preflight.sh"
  "Liveness verdict integration|bash evals/integration/test_liveness_verdict.sh"
  "Liveness conflict injection integration|bash evals/integration/test_liveness_conflict_injection.sh"
  "Telemetry doctor integration|bash evals/integration/test_telemetry_doctor.sh"
  "Usage and cost integration|bash evals/integration/test_usage_cost.sh"
  "Utterance check integration|bash evals/integration/test_utterance_check.sh"
  "Pull work provider integration|bash evals/integration/test_pull_work_provider.sh"
  "Veritas governance kit integration|bash evals/integration/test_veritas_governance_kit.sh"
  "Anti-gaming and trust suite|bash evals/ci/antigaming-suite.sh"
  "Usage feedback import integration|bash evals/integration/test_usage_feedback_import.sh"
  "Usage feedback outcomes integration|bash evals/integration/test_usage_feedback_outcomes.sh"
  "Usage feedback report integration|bash evals/integration/test_usage_feedback_report.sh"
  "Usage feedback dashboard integration|bash evals/integration/test_usage_feedback_dashboard.sh"
  "Usage feedback global integration|bash evals/integration/test_usage_feedback_global.sh"
)

LANE_SOURCE_AND_STATIC=(
  "Content boundary"
  "Decision registry"
  "Source tree validation"
  "Context map drift"
  "Static eval suite"
)

LANE_WORKFLOW_CONTRACTS=(
  "Workflow artifact integration"
  "Workflow artifact cleanup audit integration"
  "Fixture retirement audit integration"
  "Publish-change helper integration"
  "Workflow sidecar writer integration"
  "Sidecar field preservation integration"
  "Actor identity resolver integration"
)

LANE_RUNTIME_AND_KIT=(
  "Goal Fit hook integration"
  "Hook category behavior integration"
  "Workflow steering hook integration"
  "Hook influence contract integration"
  "Flow Kit repository integration"
  "Runtime adapter activation integration"
  "Bundle install integration"
  "Bundle lifecycle integration"
  "Activate npx context integration"
  "Kit conformance levels integration"
  "Local Flow Kit install integration"
  "Flow Kit install-git integration"
  "Console learning projection integration"
  "Context map integration"
  "Effective backlog settings integration"
  "Flow agents statusline integration"
  "Telemetry contract integration"
  "Liveness heartbeat integration"
  "Pull work liveness preflight integration"
  "Liveness verdict integration"
  "Liveness conflict injection integration"
  "Telemetry doctor integration"
  "Usage and cost integration"
  "Utterance check integration"
  "Pull work provider integration"
  "Veritas governance kit integration"
  "Anti-gaming and trust suite"
)

LANE_USAGE_FEEDBACK=(
  "Usage feedback import integration"
  "Usage feedback outcomes integration"
  "Usage feedback report integration"
  "Usage feedback dashboard integration"
  "Usage feedback global integration"
)

slugify() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-//; s/-$//'
}

# WS8 (ADR 0020): the reconcile manifest is THIS registry, not a new file. Every entry
# EMITTED below is a member of a REQUIRED LANE_* array (source-and-static, workflow-contracts,
# runtime-and-kit), each of which gates a merge — so a manifest command is, by construction, a
# required-lane command. The advisory LANE_USAGE_FEEDBACK lane (continue-on-error, non-blocking)
# is EXCLUDED from the emit so a test_output claim can never reconcile against a non-gating
# command. scripts/ci/trust-reconcile.js consumes this emit to resolve the manifest.
_json_str() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '"%s"' "$s"
}

_lanes_for_label() {
  # WS8 (ADR 0020, iteration 2): LANE_USAGE_FEEDBACK is deliberately NOT considered here.
  # The reconcile manifest must contain only commands that gate a merge in a required lane.
  # The usage-feedback lane is advisory (its steps run continue-on-error and its failures do
  # not block), so a usage-feedback check is NOT a required-lane command and must not be a
  # manifest entry a test_output claim can reconcile against. Entries whose ONLY lane is
  # usage-feedback therefore resolve to empty lanes and are skipped by emit_manifest_json.
  local label="$1" out="" x
  for x in "${LANE_SOURCE_AND_STATIC[@]}"; do [[ "$x" == "$label" ]] && { out="${out}\"source-and-static\","; break; }; done
  for x in "${LANE_WORKFLOW_CONTRACTS[@]}"; do [[ "$x" == "$label" ]] && { out="${out}\"workflow-contracts\","; break; }; done
  for x in "${LANE_RUNTIME_AND_KIT[@]}"; do [[ "$x" == "$label" ]] && { out="${out}\"runtime-and-kit\","; break; }; done
  printf '%s' "${out%,}"
}

emit_manifest_json() {
  # Machine-readable manifest: every lane-covered check as {id, command, lanes[]}.
  # Only checks present in at least one LANE_* array are emitted (anti-gaming: a manifest
  # command must run in a required lane by construction).
  local entry label command id lanes first=1
  printf '['
  for entry in "${CHECKS[@]}"; do
    label="${entry%%|*}"
    command="${entry#*|}"
    id="$(slugify "$label")"
    lanes="$(_lanes_for_label "$label")"
    [[ -z "$lanes" ]] && continue
    if [[ $first -eq 1 ]]; then first=0; else printf ','; fi
    printf '{"id":%s,"command":%s,"lanes":[%s]}' "$(_json_str "$id")" "$(_json_str "$command")" "$lanes"
  done
  printf ']\n'
}

active_lane() {
  printf '%s' "${FLOW_AGENTS_CI_LANE:-all}"
}

lane_labels() {
  case "$(active_lane)" in
    all)
      local entry
      for entry in "${CHECKS[@]}"; do
        printf '%s\n' "${entry%%|*}"
      done
      ;;
    source-and-static)
      printf '%s\n' "${LANE_SOURCE_AND_STATIC[@]}"
      ;;
    workflow-contracts)
      printf '%s\n' "${LANE_WORKFLOW_CONTRACTS[@]}"
      ;;
    runtime-and-kit)
      printf '%s\n' "${LANE_RUNTIME_AND_KIT[@]}"
      ;;
    usage-feedback)
      printf '%s\n' "${LANE_USAGE_FEEDBACK[@]}"
      ;;
    *)
      echo "Unknown CI baseline lane: $(active_lane)" >&2
      return 1
      ;;
  esac
}

active_checks() {
  local label labels row
  labels="$(lane_labels)" || return 1
  while IFS= read -r label; do
    [[ -n "$label" ]] || continue
    row="$(find_check "$label")" || return 1
    printf '%s\n' "$row"
  done <<<"$labels"
}

validate_active_lane() {
  lane_labels >/dev/null
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

find_active_check() {
  # Look up the check by id-or-label without streaming active_checks through a
  # process substitution.  Streaming and returning early from the consumer loop
  # causes a SIGPIPE on the producer printf when pipefail is set, printing a
  # spurious "write error: Broken pipe" on Linux even though every check passed.
  # Instead: resolve via the pure-bash find_check, then confirm the label is
  # present in the active lane.
  local requested="$1"
  local row id label line
  row="$(find_check "$requested")" || return 1
  IFS=$'\t' read -r id label _ <<<"$row"
  while IFS= read -r line; do
    [[ "$line" == "$label" ]] && { printf '%s\n' "$row"; return 0; }
  done <<<"$(lane_labels)"
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
  local row label id count

  touch "$STATUS_FILE"
  while IFS=$'\t' read -r _check_id label _check_command; do
    id="$(slugify "$label")"
    count="$(awk -F'\t' -v expected="$id" '$1 == expected { count += 1 } END { print count + 0 }' "$STATUS_FILE")"
    if [[ "$count" -eq 0 ]]; then
      echo -e "$id\t$label\tfail\tmissing CI result row\t" >>"$STATUS_FILE"
    elif [[ "$count" -gt 1 ]]; then
      echo -e "$id-duplicate\t$label duplicate result\tfail\tduplicate CI result rows for $id\t" >>"$STATUS_FILE"
    fi
  done < <(active_checks)
}

finalize_results() {
  local pass=0
  local fail=0
  local skip=0
  local id label status command log marker rel_log

  validate_active_lane || exit 2
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
    validate_active_lane || exit 2
    init_results
    ;;
  --check)
    if [[ -z "${2:-}" ]]; then
      echo "Usage: $0 --check <check-id-or-label>" >&2
      exit 2
    fi
    validate_active_lane || exit 2
    if ! check_row="$(find_active_check "$2")"; then
      echo "Unknown CI baseline check for lane $(active_lane): $2" >&2
      exit 2
    fi
    IFS=$'\t' read -r _check_id check_label check_command <<<"$check_row"
    run_check "$check_label" "$check_command"
    ;;
  --finalize)
    finalize_results
    ;;
  --manifest-json)
    emit_manifest_json
    ;;
  "")
    validate_active_lane || exit 2
    init_results
    while IFS=$'\t' read -r _check_id check_label check_command; do
      run_check "$check_label" "$check_command" || true
    done < <(active_checks)
    finalize_results
    ;;
  --lane)
    if [[ -z "${2:-}" ]]; then
      echo "Usage: $0 --lane <source-and-static|workflow-contracts|runtime-and-kit|usage-feedback>" >&2
      exit 2
    fi
    FLOW_AGENTS_CI_LANE="$2"
    validate_active_lane || exit 2
    init_results
    while IFS=$'\t' read -r _check_id check_label check_command; do
      run_check "$check_label" "$check_command" || true
    done < <(active_checks)
    finalize_results
    ;;
  *)
    echo "Usage: $0 [--init|--check <check-id-or-label>|--finalize|--lane <lane>|--manifest-json]" >&2
    exit 2
    ;;
esac
