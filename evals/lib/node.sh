#!/usr/bin/env bash
# Shared command adapter for evals. Historical script entry paths are routed to TypeScript tools.

FLOW_AGENTS_EVAL_ROOT="${ROOT:-${ROOT_DIR:-}}"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"
flow_agents_eval_bootstrap "$FLOW_AGENTS_EVAL_ROOT" || return $?

# Memoized per-process: flow_agents_node is called dozens of times per eval script
# (often inside a `run_bounded N ...` hang-guard around a single fail-fast assertion).
# Re-running `npm run build --silent` (npm startup + tsc incremental stat-check) on EVERY
# call repeatedly re-pays that overhead inside those bounds. On a slow/loaded CI runner a
# single one of those ~100+ redundant build invocations can occasionally take long enough
# to blow a tight hang-guard bound before the actual (near-instant) validation ever runs,
# producing a spurious assertion failure that has nothing to do with the behavior under
# test (see PR #306 CI trust-reconcile divergence investigation). Source under src/ never
# changes mid-script for any eval, so building once per process is safe and correct.
_FLOW_AGENTS_BUILD_DONE=""

flow_agents_build_ts() {
  if [[ "$_FLOW_AGENTS_BUILD_DONE" == "1" ]]; then
    return 0
  fi
  if (cd "$FLOW_AGENTS_EVAL_ROOT" && npm run build --silent >/dev/null); then
    _FLOW_AGENTS_BUILD_DONE="1"
    return 0
  fi
  return 1
}

flow_agents_node() {
  case "$1" in
    */scripts/build-universal-bundles.js|scripts/build-universal-bundles.js)
      shift
      flow_agents_build_ts || return
      node "$FLOW_AGENTS_EVAL_ROOT/build/src/cli.js" build-bundles "$@"
      return
      ;;
    */scripts/generate-context-map.js|scripts/generate-context-map.js)
      shift
      flow_agents_build_ts || return
      node "$FLOW_AGENTS_EVAL_ROOT/build/src/cli.js" context-map "$@"
      return
      ;;
    workflow-sidecar)
      shift
      flow_agents_build_ts || return
      node "$FLOW_AGENTS_EVAL_ROOT/build/src/cli/workflow-sidecar.js" "$@"
      return
      ;;
    builder-run)
      shift
      flow_agents_build_ts || return
      node "$FLOW_AGENTS_EVAL_ROOT/build/src/cli.js" builder-run "$@"
      return
      ;;
    validate-workflow-artifacts)
      shift
      flow_agents_build_ts || return
      node "$FLOW_AGENTS_EVAL_ROOT/build/src/cli/validate-workflow-artifacts.js" "$@"
      return
      ;;
    */scripts/validate-source-tree.js|scripts/validate-source-tree.js)
      shift
      flow_agents_build_ts || return
      node "$FLOW_AGENTS_EVAL_ROOT/build/src/cli/validate-source-tree.js" "$@"
      return
      ;;
    */scripts/kit.js|scripts/kit.js)
      shift
      flow_agents_build_ts || return
      node "$FLOW_AGENTS_EVAL_ROOT/build/src/cli/kit.js" "$@"
      return
      ;;
    */scripts/effective-backlog-settings.js|scripts/effective-backlog-settings.js)
      shift
      flow_agents_build_ts || return
      node "$FLOW_AGENTS_EVAL_ROOT/build/src/cli/effective-backlog-settings.js" "$@"
      return
      ;;
    */scripts/pull-work-provider.js|scripts/pull-work-provider.js)
      shift
      flow_agents_build_ts || return
      node "$FLOW_AGENTS_EVAL_ROOT/build/src/cli/pull-work-provider.js" "$@"
      return
      ;;
    workflow-artifact-cleanup-audit)
      shift
      flow_agents_build_ts || return
      node "$FLOW_AGENTS_EVAL_ROOT/build/src/cli.js" workflow-artifact-cleanup-audit "$@"
      return
      ;;
    fixture-retirement-audit)
      shift
      flow_agents_build_ts || return
      node "$FLOW_AGENTS_EVAL_ROOT/build/src/cli.js" fixture-retirement-audit "$@"
      return
      ;;
    */scripts/publish-change-helper.js|scripts/publish-change-helper.js)
      shift
      flow_agents_build_ts || return
      node "$FLOW_AGENTS_EVAL_ROOT/build/src/cli/publish-change-helper.js" "$@"
      return
      ;;
    */scripts/promote-workflow-artifact.js|scripts/promote-workflow-artifact.js)
      shift
      flow_agents_build_ts || return
      node "$FLOW_AGENTS_EVAL_ROOT/build/src/cli/promote-workflow-artifact.js" "$@"
      return
      ;;
    */scripts/usage-feedback.js|scripts/usage-feedback.js)
      shift
      flow_agents_build_ts || return
      node "$FLOW_AGENTS_EVAL_ROOT/build/src/cli/usage-feedback.js" "$@"
      return
      ;;
    */scripts/validate-hook-influence-cases.js|scripts/validate-hook-influence-cases.js)
      shift
      flow_agents_build_ts || return
      node "$FLOW_AGENTS_EVAL_ROOT/build/src/cli.js" validate-hook-influence "$@"
      return
      ;;
  esac
  echo "flow_agents_node: no TypeScript adapter registered for $1" >&2
  return 64
}
