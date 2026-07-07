#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EFFECTIVE="$ROOT/scripts/effective-backlog-settings.js"
PROVIDER="$ROOT/scripts/pull-work-provider.js"
TMPDIR_EVAL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_EVAL"' EXIT

errors=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

json_query() {
  NO_COLOR=1 FORCE_COLOR=0 node -e 'const fs=require("fs"); let cur=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); for (const part of process.argv[2].split(".")) cur=part==="length" ? cur.length : (Array.isArray(cur) ? cur[Number(part)] : cur[part]); console.log(cur);' "$1" "$2"
}

write_settings() {
  local file="$1"
  local owner="$2"
  local repo="$3"
  local project_number="$4"
  local labels_json="$5"
  local workspace_json="${6:-}"
  mkdir -p "$(dirname "$file")"
  node - "$file" "$owner" "$repo" "$project_number" "$labels_json" "$workspace_json" <<'NODE'
const fs = require("fs");
const [file, owner, repo, projectNumber, labelsJson, workspaceJson] = process.argv.slice(2);
const doc = {
  schema_version: "1.0",
  defaults: {
    work_item_provider: {
      role: "WorkItemProvider",
      kind: "github",
      repo: { owner, name: repo },
      capabilities: ["issues", "labels"]
    },
    board_provider: {
      role: "BoardProvider",
      kind: "github",
      repo: { owner, name: repo },
      board: { type: "github_project", owner, number: Number(projectNumber) },
      capabilities: ["projects_boards", "status_fields", "custom_fields"]
    },
    selection: {
      filters: {
        issue_state: "open",
        include_labels: JSON.parse(labelsJson),
        ready_statuses: ["ready"],
        exclude_statuses: ["in_progress", "blocked", "review", "verification", "done"]
      },
      wip_policy: {
        prefer_finishing_active_work: true,
        active_statuses: ["in_progress", "review", "verification"],
        block_new_work_when_active_count_exceeds: 0
      }
    }
  }
};
if (workspaceJson) doc.workspace = JSON.parse(workspaceJson);
fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
NODE
}

make_git_repo() {
  local dir="$1"
  local remote="$2"
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" remote add origin "$remote"
}

GLOBAL="$TMPDIR_EVAL/global.json"
EMPTY="$TMPDIR_EVAL/empty.json"
WORKSPACE="$TMPDIR_EVAL/org"
HEURISTIC_WORKSPACE="$TMPDIR_EVAL/heuristic-org"
LONELY="$TMPDIR_EVAL/lonely"

printf '{"schema_version":"1.0","projects":[]}\n' > "$EMPTY"
write_settings "$GLOBAL" "example" "global-default" "9" '["global-ready"]'
write_settings "$WORKSPACE/.kontourai/settings.json" "kontourai" "flow-agents" "1" '[]' '{"repos":["flow-agents","surface"]}'
mkdir -p "$LONELY"
make_git_repo "$WORKSPACE/flow-agents" "https://github.com/kontourai/flow-agents.git"
make_git_repo "$HEURISTIC_WORKSPACE/flow-agents" "https://github.com/kontourai/flow-agents.git"
make_git_repo "$HEURISTIC_WORKSPACE/surface" "https://github.com/kontourai/surface.git"

echo "=== Workspace Settings Resolution ==="

node "$EFFECTIVE" --repo-path "$WORKSPACE" --project-settings "$EMPTY" --global-settings "$GLOBAL" --json > "$TMPDIR_EVAL/workspace.json"
status=$?
[[ "$status" -eq 0 ]] && pass "workspace settings-file detection exits configured" || fail "workspace settings-file detection exits configured"
[[ "$(json_query "$TMPDIR_EVAL/workspace.json" "scope")" == "workspace" ]] && pass "settings-file detection reports workspace scope" || fail "settings-file detection reports workspace scope"
[[ "$(json_query "$TMPDIR_EVAL/workspace.json" "source")" == "workspace" ]] && pass "workspace file has precedence over global" || fail "workspace file has precedence over global"
[[ "$(json_query "$TMPDIR_EVAL/workspace.json" "settings.board_provider.board.number")" == "1" ]] && pass "workspace board overrides global board" || fail "workspace board overrides global board"
[[ "$(json_query "$TMPDIR_EVAL/workspace.json" "settings.workspace.repos.length")" == "2" ]] && pass "effective settings carry workspace repo list" || fail "effective settings carry workspace repo list"
[[ "$(json_query "$TMPDIR_EVAL/workspace.json" "settings.workspace.repos.1")" == "surface" ]] && pass "workspace repo list preserves repo names" || fail "workspace repo list preserves repo names"

node "$EFFECTIVE" --repo-path "$HEURISTIC_WORKSPACE" --project-settings "$EMPTY" --global-settings "$GLOBAL" --json > "$TMPDIR_EVAL/heuristic.json"
status=$?
[[ "$status" -eq 0 ]] && pass "two-repo heuristic exits configured from global fallback" || fail "two-repo heuristic exits configured from global fallback"
[[ "$(json_query "$TMPDIR_EVAL/heuristic.json" "scope")" == "workspace" ]] && pass "two-repo heuristic reports workspace scope" || fail "two-repo heuristic reports workspace scope"
[[ "$(json_query "$TMPDIR_EVAL/heuristic.json" "source")" == "global" ]] && pass "two-repo heuristic can fall back to global defaults" || fail "two-repo heuristic can fall back to global defaults"

node "$EFFECTIVE" --repo-path "$WORKSPACE/flow-agents" --project-settings "$EMPTY" --global-settings "$GLOBAL" --json > "$TMPDIR_EVAL/repo.json"
status=$?
[[ "$status" -eq 0 ]] && pass "repo path remains configured" || fail "repo path remains configured"
[[ "$(json_query "$TMPDIR_EVAL/repo.json" "scope")" == "repo" ]] && pass "repo path does not switch to workspace scope" || fail "repo path does not switch to workspace scope"
[[ "$(json_query "$TMPDIR_EVAL/repo.json" "current_repo.name")" == "flow-agents" ]] && pass "repo path still identifies current repo" || fail "repo path still identifies current repo"

node "$EFFECTIVE" --repo-path "$LONELY" --project-settings "$EMPTY" --global-settings "$EMPTY" --json > "$TMPDIR_EVAL/lonely.json" 2>/dev/null
status=$?
[[ "$status" -eq 2 ]] && pass "non-repo without workspace context exits ask_user" || fail "non-repo without workspace context exits ask_user"
[[ "$(json_query "$TMPDIR_EVAL/lonely.json" "status")" == "ask_user" ]] && pass "non-repo without workspace context reports ask_user" || fail "non-repo without workspace context reports ask_user"

cat > "$TMPDIR_EVAL/items.json" <<'JSON'
{
  "items": [
    {
      "id": "PVTI_1",
      "position": 0,
      "status": "Ready",
      "priority": "P1",
      "content": {
        "id": "I_1",
        "number": 1,
        "title": "Boarded flow-agents issue",
        "state": "OPEN",
        "url": "https://github.com/kontourai/flow-agents/issues/1",
        "repository": { "name": "flow-agents", "owner": { "login": "kontourai" } },
        "labels": []
      }
    },
    {
      "id": "PVTI_2",
      "position": 1,
      "status": "Ready",
      "priority": "P2",
      "content": {
        "id": "I_2",
        "number": 2,
        "title": "Boarded surface issue",
        "state": "OPEN",
        "url": "https://github.com/kontourai/surface/issues/2",
        "repository": { "name": "surface", "owner": { "login": "kontourai" } },
        "labels": []
      }
    }
  ],
  "open_issues": {
    "flow-agents": [
      { "id": "I_1", "number": 1, "title": "Boarded flow-agents issue", "state": "OPEN", "url": "https://github.com/kontourai/flow-agents/issues/1", "labels": [] },
      { "id": "I_3", "number": 3, "title": "Missing flow-agents issue", "state": "OPEN", "url": "https://github.com/kontourai/flow-agents/issues/3", "labels": [] }
    ],
    "surface": [
      { "id": "I_2", "number": 2, "title": "Boarded surface issue", "state": "OPEN", "url": "https://github.com/kontourai/surface/issues/2", "labels": [] },
      { "id": "I_4", "number": 4, "title": "Missing surface issue", "state": "OPEN", "url": "https://github.com/kontourai/surface/issues/4", "labels": [] }
    ]
  }
}
JSON

node "$PROVIDER" --settings-json "$TMPDIR_EVAL/workspace.json" --items-json "$TMPDIR_EVAL/items.json" > "$TMPDIR_EVAL/board.json"
status=$?
[[ "$status" -eq 0 ]] && pass "workspace board fixture exits successfully" || fail "workspace board fixture exits successfully"
[[ "$(json_query "$TMPDIR_EVAL/board.json" "ready_queue.length")" == "2" ]] && pass "workspace board reads ready items across repos" || fail "workspace board reads ready items across repos"
[[ "$(json_query "$TMPDIR_EVAL/board.json" "intake_gaps.length")" == "2" ]] && pass "workspace intake gaps cover all configured repos" || fail "workspace intake gaps cover all configured repos"
[[ "$(json_query "$TMPDIR_EVAL/board.json" "intake_gaps.0.id")" == "github:kontourai/flow-agents#3" ]] && pass "workspace gaps include missing flow-agents issue" || fail "workspace gaps include missing flow-agents issue"
[[ "$(json_query "$TMPDIR_EVAL/board.json" "intake_gaps.1.id")" == "github:kontourai/surface#4" ]] && pass "workspace gaps include missing surface issue" || fail "workspace gaps include missing surface issue"

if [[ "$errors" -eq 0 ]]; then
  echo "Workspace settings checks passed"
else
  echo "Workspace settings checks failed: $errors"
fi

exit "$errors"
