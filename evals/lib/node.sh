#!/usr/bin/env bash
# Shared command adapter for evals. Historical script entry paths are routed to TypeScript tools.

FLOW_AGENTS_EVAL_ROOT="${ROOT:-${ROOT_DIR:-}}"

flow_agents_build_ts() {
  (cd "$FLOW_AGENTS_EVAL_ROOT" && npm run build --silent >/dev/null)
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
    */scripts/filter-installed-packs.js|scripts/filter-installed-packs.js)
      shift
      flow_agents_build_ts || return
      node "$FLOW_AGENTS_EVAL_ROOT/build/src/cli.js" filter-installed-packs "$@"
      return
      ;;
    workflow-sidecar)
      shift
      flow_agents_build_ts || return
      node "$FLOW_AGENTS_EVAL_ROOT/build/src/cli/workflow-sidecar.js" "$@"
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
    veritas-governance)
      shift
      flow_agents_build_ts || return
      node "$FLOW_AGENTS_EVAL_ROOT/build/src/cli.js" veritas-governance "$@"
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
