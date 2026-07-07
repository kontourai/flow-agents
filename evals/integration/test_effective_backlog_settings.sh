#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/effective-backlog-settings.js"
PROJECT="$ROOT/context/settings/backlog-provider-settings.json"
GLOBAL="$ROOT/evals/fixtures/backlog-provider-settings/global-default.json"
OVERRIDE="$ROOT/evals/fixtures/backlog-provider-settings/project-override.json"
EMPTY="$(mktemp)"
trap 'rm -f "$EMPTY"' EXIT
printf '{"schema_version":"1.0","projects":[]}\n' > "$EMPTY"

errors=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

json_value() {
  NO_COLOR=1 FORCE_COLOR=0 node -e 'const fs=require("fs"); let cur=JSON.parse(fs.readFileSync(0,"utf8")); for (const part of process.argv[1].split(".")) cur=Array.isArray(cur) ? cur[Number(part)] : cur[part]; console.log(cur);' "$1"
}

echo "=== Effective Backlog Settings ==="

default_result="$(cd "$ROOT" && npm run --silent effective-backlog-settings -- --repo-path . --json)"
[[ "$(printf '%s' "$default_result" | json_value status)" == "configured" ]] && pass "default project settings resolve through npm command" || fail "default project settings resolve through npm command"
[[ "$(printf '%s' "$default_result" | json_value settings.work_item_provider.kind)" == "github" ]] && pass "default provider kind is github" || fail "default provider kind is github"
[[ "$(printf '%s' "$default_result" | json_value settings.work_item_provider.repo.owner)" == "kontourai" ]] && pass "default repo owner is kontourai" || fail "default repo owner is kontourai"
[[ "$(printf '%s' "$default_result" | json_value settings.work_item_provider.repo.name)" == "flow-agents" ]] && pass "default repo name is flow-agents" || fail "default repo name is flow-agents"
[[ "$(printf '%s' "$default_result" | json_value settings.board_provider.board.number)" == "1" ]] && pass "default project number is 1" || fail "default project number is 1"
! printf '%s' "$default_result" | rg -q '/build/context/settings/backlog-provider-settings.json' && pass "default settings path is not build-relative" || fail "default settings path is not build-relative"

configured="$(node "$SCRIPT" --repo-path "$ROOT" --project-settings "$PROJECT" --global-settings "$EMPTY" --json)"
[[ "$(printf '%s' "$configured" | json_value status)" == "configured" ]] && pass "configured repo resolves" || fail "configured repo resolves"
[[ "$(printf '%s' "$configured" | json_value settings.work_item_provider.kind)" == "github" ]] && pass "provider kind is github" || fail "provider kind is github"
[[ "$(printf '%s' "$configured" | json_value settings.work_item_provider.repo.owner)" == "kontourai" ]] && pass "repo owner is kontourai" || fail "repo owner is kontourai"
[[ "$(printf '%s' "$configured" | json_value settings.work_item_provider.repo.name)" == "flow-agents" ]] && pass "repo name is flow-agents" || fail "repo name is flow-agents"
[[ "$(printf '%s' "$configured" | json_value settings.board_provider.board.number)" == "1" ]] && pass "project number is 1" || fail "project number is 1"
printf '%s' "$configured" | rg -F -q '"ready_statuses": [' && pass "filters include ready statuses" || fail "filters include ready statuses"
printf '%s' "$configured" | rg -F -q '"include_labels": []' && pass "filters do not require labels by default" || fail "filters do not require labels by default"
printf '%s' "$configured" | rg -q '"prefer_finishing_active_work": true' && pass "WIP policy prefers finishing active work" || fail "WIP policy prefers finishing active work"

override_result="$(node "$SCRIPT" --repo-path "$ROOT" --project-settings "$OVERRIDE" --global-settings "$GLOBAL" --json)"
[[ "$(printf '%s' "$override_result" | json_value source)" == "project" ]] && pass "project settings override global defaults" || fail "project settings override global defaults"
[[ "$(printf '%s' "$override_result" | json_value settings.board_provider.board.number)" == "1" ]] && pass "project override keeps Project 1" || fail "project override keeps Project 1"
! printf '%s' "$override_result" | rg -q 'global-ready' && pass "project override replaces global filters" || fail "project override replaces global filters"

missing_output="$(node "$SCRIPT" --repo-path "$ROOT" --project-settings "$EMPTY" --global-settings "$EMPTY" --json 2>/dev/null)"
missing_status=$?
[[ "$missing_status" -eq 2 ]] && pass "missing settings exits with ask-user status" || fail "missing settings exits with ask-user status"
[[ "$(printf '%s' "$missing_output" | json_value status)" == "ask_user" ]] && pass "missing settings reports ask_user" || fail "missing settings reports ask_user"
printf '%s' "$missing_output" | rg -q 'WorkItemProvider and BoardProvider' && pass "missing settings names provider roles" || fail "missing settings names provider roles"

if [[ "$errors" -eq 0 ]]; then
  echo "Effective backlog settings checks passed"
else
  echo "Effective backlog settings checks failed: $errors"
fi

exit "$errors"
