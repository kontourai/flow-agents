#!/bin/sh
# Operator-run recipe only. This repository never invokes it or enables Boo.
set -eu

action=${1:-}
case "$action" in
  add)
    : "${FLOW_AGENTS_ROOT:?absolute Flow Agents checkout required}"
    : "${KNOWLEDGE_TELEMETRY:?absolute telemetry JSONL required}"
    : "${KNOWLEDGE_TRANSCRIPT_ROOT:?absolute transcript root required}"
    command=$(node "$FLOW_AGENTS_ROOT/kits/knowledge/dream/scheduler-command.js" "$FLOW_AGENTS_ROOT" "$KNOWLEDGE_TELEMETRY" "$KNOWLEDGE_TRANSCRIPT_ROOT")
    boo add --name knowledge-dream --runner shell --cron "0 3 * * *" \
      --dir "$FLOW_AGENTS_ROOT" --timeout 300 --retry 1 --retry-delay 60 \
      --command "$command"
    ;;
  disable)
    boo disable knowledge-dream
    ;;
  *)
    echo "usage: boo-recipe.sh add|disable" >&2
    exit 2
    ;;
esac
