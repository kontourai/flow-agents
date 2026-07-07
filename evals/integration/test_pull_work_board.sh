#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/env.sh"
flow_agents_eval_bootstrap "$ROOT" || exit $?
SCRIPT="$ROOT/scripts/pull-work-provider.js"
TMPDIR_EVAL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_EVAL"' EXIT

errors=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

json_query() {
  NO_COLOR=1 FORCE_COLOR=0 node -e 'const fs=require("fs"); let cur=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); for (const part of process.argv[2].split(".")) cur=part==="length" ? cur.length : (Array.isArray(cur) ? cur[Number(part)] : cur[part]); console.log(cur);' "$1" "$2"
}

cat > "$TMPDIR_EVAL/settings.json" <<'JSON'
{
  "schema_version": "1.0",
  "projects": [
    {
      "project": { "repo": { "owner": "kontourai", "name": "flow-agents" } },
      "work_item_provider": {
        "role": "WorkItemProvider",
        "kind": "github",
        "repo": { "owner": "kontourai", "name": "flow-agents" },
        "capabilities": ["issues", "labels"]
      },
      "board_provider": {
        "role": "BoardProvider",
        "kind": "github",
        "repo": { "owner": "kontourai", "name": "flow-agents" },
        "board": { "type": "github_project", "owner": "kontourai", "number": 1 },
        "capabilities": ["projects_boards", "status_fields", "custom_fields"]
      },
      "selection": {
        "filters": {
          "issue_state": "open",
          "include_labels": [],
          "ready_statuses": ["ready"],
          "exclude_statuses": ["in_progress", "blocked", "review", "verification", "done"]
        },
        "wip_policy": {
          "prefer_finishing_active_work": true,
          "active_statuses": ["in_progress", "review", "verification"],
          "block_new_work_when_active_count_exceeds": 0
        }
      }
    }
  ]
}
JSON

cat > "$TMPDIR_EVAL/items.json" <<'JSON'
{
  "items": [
    {
      "id": "PVTI_1",
      "position": 0,
      "fieldValues": [
        { "field": { "name": "Status" }, "name": "Ready" },
        { "field": { "name": "Priority" }, "name": "P1" }
      ],
      "content": {
        "id": "I_7",
        "number": 7,
        "title": "P1 ready board item",
        "body": "## Scope\nDo P1 work.\n\n## Acceptance criteria\nDone.",
        "state": "OPEN",
        "url": "https://github.com/kontourai/flow-agents/issues/7",
        "repository": { "name": "flow-agents", "owner": { "login": "kontourai" } },
        "labels": { "nodes": [{ "name": "builder" }] }
      }
    },
    {
      "id": "PVTI_2",
      "position": 1,
      "status": "In Progress",
      "priority": "P0",
      "content": {
        "id": "I_8",
        "number": 8,
        "title": "Active item excluded from ready queue",
        "body": "## Scope\nAlready active.",
        "state": "OPEN",
        "url": "https://github.com/kontourai/flow-agents/issues/8",
        "repository": { "name": "flow-agents", "owner": { "login": "kontourai" } },
        "labels": []
      }
    },
    {
      "id": "PVTI_3",
      "position": 2,
      "status": "ready",
      "priority": "P0",
      "content": {
        "id": "I_5",
        "number": 5,
        "title": "P0 lower-case ready item",
        "body": "## Scope\nDo P0 work.\n\n## Acceptance criteria\nDone.",
        "state": "OPEN",
        "url": "https://github.com/kontourai/flow-agents/issues/5",
        "repository": { "name": "flow-agents", "owner": { "login": "kontourai" } },
        "labels": []
      }
    },
    {
      "id": "PVTI_4",
      "position": 3,
      "status": "Ready",
      "priority": "P2",
      "content": {
        "id": "I_9",
        "number": 9,
        "title": "P2 ready board item",
        "body": "## Scope\nDo P2 work.\n\n## Acceptance criteria\nDone.",
        "state": "OPEN",
        "url": "https://github.com/kontourai/flow-agents/issues/9",
        "repository": { "name": "flow-agents", "owner": { "login": "kontourai" } },
        "labels": []
      }
    }
  ],
  "open_issues": [
    {
      "id": "I_5",
      "number": 5,
      "title": "P0 lower-case ready item",
      "state": "OPEN",
      "url": "https://github.com/kontourai/flow-agents/issues/5",
      "labels": []
    },
    {
      "id": "I_11",
      "number": 11,
      "title": "Open issue missing from board",
      "state": "OPEN",
      "url": "https://github.com/kontourai/flow-agents/issues/11",
      "labels": [{ "name": "intake" }]
    }
  ]
}
JSON

cat > "$TMPDIR_EVAL/zero-ready.json" <<'JSON'
{
  "items": [
    {
      "id": "PVTI_10",
      "position": 0,
      "status": "Blocked",
      "priority": "P0",
      "content": {
        "id": "I_10",
        "number": 10,
        "title": "Blocked board item",
        "state": "OPEN",
        "url": "https://github.com/kontourai/flow-agents/issues/10",
        "labels": []
      }
    }
  ],
  "open_issues": []
}
JSON

echo "=== Pull Work Board Ready Queue ==="

node "$SCRIPT" \
  --settings-json "$TMPDIR_EVAL/settings.json" \
  --items-json "$TMPDIR_EVAL/items.json" \
  > "$TMPDIR_EVAL/board.json"
status=$?
[[ "$status" -eq 0 ]] && pass "board reader exits successfully" || fail "board reader exits successfully"

[[ "$(json_query "$TMPDIR_EVAL/board.json" "ready_queue.length")" == "3" ]] && pass "filters only ready board items" || fail "filters only ready board items"
[[ "$(json_query "$TMPDIR_EVAL/board.json" "ready_queue.0.id")" == "github:kontourai/flow-agents#5" ]] && pass "orders P0 before P1 and preserves board position tiebreak" || fail "orders P0 before P1 and preserves board position tiebreak"
[[ "$(json_query "$TMPDIR_EVAL/board.json" "ready_queue.1.id")" == "github:kontourai/flow-agents#7" ]] && pass "orders P1 before P2" || fail "orders P1 before P2"
[[ "$(json_query "$TMPDIR_EVAL/board.json" "ready_queue.2.id")" == "github:kontourai/flow-agents#9" ]] && pass "keeps P2 ready after higher priorities" || fail "keeps P2 ready after higher priorities"
[[ "$(json_query "$TMPDIR_EVAL/board.json" "ready_queue.0.status")" == "ready" ]] && pass "matches ready status case-insensitively" || fail "matches ready status case-insensitively"
[[ "$(json_query "$TMPDIR_EVAL/board.json" "ready_queue.0.board_membership.priority")" == "P0" ]] && pass "preserves board priority on candidate" || fail "preserves board priority on candidate"
[[ "$(json_query "$TMPDIR_EVAL/board.json" "intake_gaps.length")" == "1" ]] && pass "detects open WorkItemProvider issues absent from board" || fail "detects open WorkItemProvider issues absent from board"
[[ "$(json_query "$TMPDIR_EVAL/board.json" "intake_gaps.0.id")" == "github:kontourai/flow-agents#11" ]] && pass "reports missing issue as intake gap" || fail "reports missing issue as intake gap"

node "$SCRIPT" \
  --settings-json "$TMPDIR_EVAL/settings.json" \
  --items-json "$TMPDIR_EVAL/zero-ready.json" \
  > "$TMPDIR_EVAL/zero-ready-output.json"
[[ "$(json_query "$TMPDIR_EVAL/zero-ready-output.json" "ready_queue.length")" == "0" ]] && pass "zero-ready fixture has empty ready queue" || fail "zero-ready fixture has empty ready queue"
[[ "$(json_query "$TMPDIR_EVAL/zero-ready-output.json" "warnings.0.code")" == "zero_ready_items" ]] && pass "zero ready emits loud warning" || fail "zero ready emits loud warning"

if [[ "$errors" -eq 0 ]]; then
  echo "Pull work board checks passed"
else
  echo "Pull work board checks failed: $errors"
fi

exit "$errors"
