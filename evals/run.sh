#!/usr/bin/env bash
# run.sh — Entry point for the agent eval suite
# Usage:
#   bash run.sh              # Run layers 1+2 (fast, no LLM)
#   bash run.sh static       # Layer 1 only
#   bash run.sh integration  # Layer 2 only
#   bash run.sh acceptance   # Layer 4: harness-native smoke tests
#   bash run.sh acceptance kiro
#   bash run.sh llm          # Layer 3: all agents
#   bash run.sh llm dev      # Layer 3: dev agent only
#   bash run.sh llm dev --runtime codex  # Run dev evals through Codex
#   bash run.sh llm dev --runtime claude --judge-runtime codex
#   bash run.sh llm dev --suite regression
#   bash run.sh report dev   # Generate report from last run
#   bash run.sh llm dev --repeat 3  # Run with pass@k measurement
set -uo pipefail

EVAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$EVAL_DIR/.." && pwd)"
LAYER="${1:-all}"
AGENT="${2:-}"
RUNTIME="${FLOW_AGENTS_EVAL_RUNTIME:-${EVAL_RUNTIME:-kiro}}"
JUDGE_RUNTIME="${FLOW_AGENTS_EVAL_JUDGE_RUNTIME:-${EVAL_JUDGE_RUNTIME:-}}"
SUITE="${FLOW_AGENTS_EVAL_SUITE:-full}"
PROMPTFOO_BIN="${PROMPTFOO_BIN:-$ROOT_DIR/node_modules/.bin/promptfoo}"
if [[ ! -x "$PROMPTFOO_BIN" ]]; then
  PROMPTFOO_BIN="$(command -v promptfoo 2>/dev/null || true)"
fi

run_promptfoo() {
  if [[ -z "$PROMPTFOO_BIN" ]]; then
    echo "promptfoo is not installed. Run 'npm install' from the repo root." >&2
    return 127
  fi
  local config_dir="${PROMPTFOO_CONFIG_DIR:-$ROOT_DIR/.promptfoo}"
  mkdir -p "$config_dir"
  PROMPTFOO_CONFIG_DIR="$config_dir" \
    PROMPTFOO_DISABLE_WAL_MODE="${PROMPTFOO_DISABLE_WAL_MODE:-true}" \
    PROMPTFOO_DISABLE_TELEMETRY="${PROMPTFOO_DISABLE_TELEMETRY:-true}" \
    "$PROMPTFOO_BIN" "$@"
}

parse_runtime_args() {
  local rest=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --runtime)
        if [[ -z "${2:-}" ]]; then
          echo "--runtime requires kiro or codex" >&2
          exit 1
        fi
        RUNTIME="$2"
        shift 2
        ;;
      --runtime=*)
        RUNTIME="${1#--runtime=}"
        shift
        ;;
      --judge-runtime)
        if [[ -z "${2:-}" ]]; then
          echo "--judge-runtime requires kiro, codex, or claude" >&2
          exit 1
        fi
        JUDGE_RUNTIME="$2"
        shift 2
        ;;
      --judge-runtime=*)
        JUDGE_RUNTIME="${1#--judge-runtime=}"
        shift
        ;;
      --suite)
        if [[ -z "${2:-}" ]]; then
          echo "--suite requires smoke, regression, capability, or full" >&2
          exit 1
        fi
        SUITE="$2"
        shift 2
        ;;
      --suite=*)
        SUITE="${1#--suite=}"
        shift
        ;;
      *)
        rest+=("$1")
        shift
        ;;
    esac
  done
  case "$RUNTIME" in
    kiro|Claude\ Code|codex|claude|claude-code) ;;
    *)
      echo "Unsupported eval runtime '$RUNTIME' (expected kiro, codex, or claude)" >&2
      exit 1
      ;;
  esac
  JUDGE_RUNTIME="${JUDGE_RUNTIME:-$RUNTIME}"
  case "$JUDGE_RUNTIME" in
    kiro|Claude\ Code|codex|claude|claude-code) ;;
    *)
      echo "Unsupported judge runtime '$JUDGE_RUNTIME' (expected kiro, codex, or claude)" >&2
      exit 1
      ;;
  esac
  case "$SUITE" in
    smoke)
      rest=(--filter-first-n 3 "${rest[@]}")
      ;;
    regression)
      rest=(--filter-metadata type=regression "${rest[@]}")
      ;;
    capability)
      rest=(--filter-metadata type=capability "${rest[@]}")
      ;;
    full|"")
      ;;
    *)
      echo "Unsupported suite '$SUITE' (expected smoke, regression, capability, or full)" >&2
      exit 1
      ;;
  esac
  EVAL_ARGS=("${rest[@]}")
}

run_static() {
  echo ""
  echo "╔══════════════════════════════════════╗"
  echo "║  Layer 1: Static Package Validation  ║"
  echo "╚══════════════════════════════════════╝"
  local result=0
  bash "$EVAL_DIR/static/test_package.sh" || result=1
  echo ""
  bash "$EVAL_DIR/static/test_universal_bundles.sh" || result=1
  echo ""
  bash "$EVAL_DIR/static/test_workflow_skills.sh" || result=1
  echo ""
  bash "$EVAL_DIR/static/test_evidence_refs.sh" || result=1
  echo ""
  bash "$EVAL_DIR/static/test_library_exports.sh" || result=1
  echo ""
  bash "$EVAL_DIR/static/test_console_presets.sh" || result=1
  echo ""
  bash "$EVAL_DIR/static/test_repo_hooks.sh" || result=1
  echo ""
  bash "$EVAL_DIR/static/test_flowdef_codeowners_coverage.sh" || result=1
  echo ""
  bash "$EVAL_DIR/static/test_unit_helpers.sh" || result=1
  return $result
}

run_integration() {
  echo ""
  echo "╔══════════════════════════════════════════╗"
  echo "║  Layer 2: Telemetry Contract Validation  ║"
  echo "╚══════════════════════════════════════════╝"
  local result=0
  bash "$EVAL_DIR/integration/test_telemetry.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_telemetry_doctor.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_usage_feedback_outcomes.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_usage_feedback_import.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_usage_feedback_report.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_usage_feedback_dashboard.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_usage_feedback_global.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_goal_fit_hook.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_goal_fit_escape_hatch.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_goal_fit_rederive.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_evidence_capture_hook.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_hook_category_behaviors.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_workflow_artifacts.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_workflow_artifact_cleanup_audit.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_fixture_retirement_audit.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_publish_change_helper.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_workflow_sidecar_writer.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_veritas_governance_adapter.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_workflow_steering_hook.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_session_resume_roundtrip.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_hook_influence_cases.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_flow_agents_statusline.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_context_map.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_flow_kit_repository.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_local_flow_kit_install.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_runtime_adapter_activation.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_validate_artifacts_portability.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_codex_hook_resolution.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_bundle_install.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_bundle_lifecycle.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_kit_conformance_levels.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_dual_emit_flow_step.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_enforcer_expects_driven.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_phase_map_and_gate_claim.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_builder_step_producers.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_flowdef_session_history_preservation.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_flowdef_session_activation.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_trust_checkpoint.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_checkpoint_signing.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_gate_bypass_chain.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_command_log_integrity.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_gate_lockdown.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_resolvefirststep_security.sh" || result=1
  bash "$EVAL_DIR/integration/test_captured_fail_reconciliation.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_trust_reconcile.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_reconcile_soundness.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_publish_delivery.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_mint_attestation.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_verify_cli.sh" || result=1
  echo ""
  bash "$EVAL_DIR/integration/test_kit_identity_trust.sh" || result=1
  echo ""
  bash "$EVAL_DIR/acceptance/prove-capture-teeth-declared.sh" || result=1
  return $result
}

run_llm() {
  parse_runtime_args "$@"
  echo ""
  echo "╔═══════════════════════════════════════╗"
  echo "║  Layer 3: LLM Behavioral Evals        ║"
  echo "╚═══════════════════════════════════════╝"
  echo ""
  echo "Runtime: $RUNTIME"
  echo "Judge Runtime: ${JUDGE_RUNTIME:-$RUNTIME}"
  echo "Suite: $SUITE"
  echo ""

  if [[ -n "$AGENT" ]]; then
    local config="$EVAL_DIR/cases/$AGENT/promptfooconfig.yaml"
    if [[ ! -f "$config" ]]; then
      echo "No config found for agent '$AGENT' at $config"
      exit 1
    fi
    echo "Running evals for: $AGENT"
    cd "$EVAL_DIR/cases/$AGENT"
    mkdir -p "$EVAL_DIR/results"
    local output_file="$EVAL_DIR/results/${AGENT}-${RUNTIME}-$(date +%Y-%m-%d).json"
    FLOW_AGENTS_EVAL_RUNTIME="$RUNTIME" FLOW_AGENTS_EVAL_JUDGE_RUNTIME="${JUDGE_RUNTIME:-$RUNTIME}" FLOW_AGENTS_EVAL_SUITE="$SUITE" FLOW_AGENTS_EVAL_AGENT="$AGENT" KIRO_EVAL_AGENT="$AGENT" run_promptfoo eval --no-cache --output "$output_file" "${EVAL_ARGS[@]}"
    echo ""
    echo "Results saved to: $output_file"
  else
    echo "Running all agent evals..."
    for agent_dir in "$EVAL_DIR"/cases/*/; do
      agent=$(basename "$agent_dir")
      [[ ! -f "$agent_dir/promptfooconfig.yaml" ]] && continue
      echo ""
      echo "--- $agent ---"
      cd "$agent_dir"
      mkdir -p "$EVAL_DIR/results"
      local output_file="$EVAL_DIR/results/${agent}-${RUNTIME}-$(date +%Y-%m-%d).json"
      FLOW_AGENTS_EVAL_RUNTIME="$RUNTIME" FLOW_AGENTS_EVAL_JUDGE_RUNTIME="${JUDGE_RUNTIME:-$RUNTIME}" FLOW_AGENTS_EVAL_SUITE="$SUITE" FLOW_AGENTS_EVAL_AGENT="$agent" KIRO_EVAL_AGENT="$agent" run_promptfoo eval --no-cache --output "$output_file" "${EVAL_ARGS[@]}"
    done
  fi
  echo ""
  echo "View results: npm run promptfoo:view"
}

run_acceptance() {
  echo ""
  echo "╔═══════════════════════════════════════╗"
  echo "║  Layer 4: Harness Acceptance         ║"
  echo "╚═══════════════════════════════════════╝"
  echo ""
  local target="${AGENT:-all}"
  bash "$EVAL_DIR/acceptance/run.sh" "$target"
}

run_report() {
  local agent="${1:?Usage: bash run.sh report <agent>}"
  local latest
  latest=$(ls -t "$EVAL_DIR/results/${agent}"-*.json 2>/dev/null | head -1)
  if [[ -z "$latest" ]]; then
    echo "No results found for agent '$agent' in $EVAL_DIR/results/"
    exit 1
  fi
  local previous
  previous=$(ls -t "$EVAL_DIR/results/${agent}"-*.json 2>/dev/null | sed -n '2p')

  echo ""
  echo "╔══════════════════════════════╗"
  echo "║  Eval Report: $agent"
  echo "╚══════════════════════════════╝"
  echo ""

  mkdir -p "$EVAL_DIR/results/reports"
  local report_file="$EVAL_DIR/results/reports/$(date +%Y-%m-%d)-${agent}.md"
  bash "$EVAL_DIR/lib/eval-report.sh" "$latest" "$previous" | tee "$report_file"
  echo ""
  echo "Report saved to: $report_file"
}

case "$LAYER" in
  static)      run_static ;;
  integration) run_integration ;;
  llm)
    shift
    if [[ "${1:-}" == --* ]]; then
      AGENT=""
    else
      AGENT="${1:-}"
      [[ $# -gt 0 ]] && shift
    fi
    run_llm "$@"
    ;;
  acceptance)  shift; AGENT="${1:-all}"; run_acceptance ;;
  report)      shift; run_report "$@" ;;
  all)
    run_static
    static_exit=$?
    run_integration
    integration_exit=$?
    echo ""
    echo "╔══════════════════════════╗"
    echo "║  Summary: Layers 1 + 2  ║"
    echo "╚══════════════════════════╝"
    echo "  Static:      $([ $static_exit -eq 0 ] && echo PASS || echo FAIL)"
    echo "  Integration: $([ $integration_exit -eq 0 ] && echo PASS || echo FAIL)"
    echo ""
    if [[ $static_exit -ne 0 || $integration_exit -ne 0 ]]; then
      echo "Fix Layer 1/2 failures before running Layer 3."
      exit 1
    fi
    echo "Layers 1+2 passed. Run 'bash run.sh acceptance [kiro|claude|codex]' for harness smoke tests or 'bash run.sh llm [dev] [--runtime kiro|codex|claude] [--judge-runtime kiro|codex|claude]' for behavioral evals."
    ;;
  *)
    echo "Usage: bash run.sh [static|integration|acceptance|llm|report|all] [target]"
    exit 1
    ;;
esac
