#!/usr/bin/env bash
# Shared eval environment bootstrap. Keep eval output parseable regardless of the caller shell.

flow_agents_eval_configure_env() {
  export NO_COLOR=1
  export FORCE_COLOR=0
  export npm_config_color=false
  export NODE_NO_WARNINGS=1
}

flow_agents_eval_require_node_modules() {
  local root="${1:-}"
  if [[ -z "$root" ]]; then
    echo "eval preflight failed: repo root was not provided. Run 'npm ci' from the repo root." >&2
    return 127
  fi
  if [[ ! -d "$root/node_modules" ]]; then
    echo "eval preflight failed: missing node_modules at $root/node_modules. Run 'npm ci' from the repo root." >&2
    return 127
  fi
}

flow_agents_eval_bootstrap() {
  flow_agents_eval_configure_env
  flow_agents_eval_require_node_modules "$1"
}
