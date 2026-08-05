#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI="$ROOT/build/src/cli.js"
BACKLOG_SETTINGS="$ROOT/context/settings/backlog-provider-settings.json"
ASSIGNMENT_SETTINGS="$ROOT/context/settings/assignment-provider-settings.json"
BACKLOG_GLOBAL="$ROOT/evals/fixtures/backlog-provider-settings/global-default.json"
BACKLOG_OVERRIDE="$ROOT/evals/fixtures/backlog-provider-settings/project-override.json"
TMPDIR_EVAL="$(mktemp -d)"
EMPTY_BACKLOG="$TMPDIR_EVAL/empty-backlog-settings.json"
EMPTY_ASSIGNMENT="$TMPDIR_EVAL/empty-assignment-settings.json"
trap 'rm -rf "$TMPDIR_EVAL"' EXIT

printf '{"schema_version":"1.0","projects":[]}\n' > "$EMPTY_BACKLOG"
printf '{"schema_version":"1.0","projects":[]}\n' > "$EMPTY_ASSIGNMENT"

errors=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

json_value() {
  NO_COLOR=1 FORCE_COLOR=0 node -e 'const fs=require("fs"); let cur=JSON.parse(fs.readFileSync(0,"utf8")); for (const part of process.argv[1].split(".")) cur=Array.isArray(cur) ? cur[Number(part)] : cur[part]; console.log(cur);' "$1"
}

echo "=== Effective provider settings ==="

# Build exactly once before calling the actual compiled CLI commands below.
if (cd "$ROOT" && npm run build --silent); then
  pass "compiled CLI build succeeds"
else
  fail "compiled CLI build succeeds"
fi

if [[ ! -f "$CLI" ]]; then
  fail "compiled CLI is available"
else
  pass "compiled CLI is available"
fi

echo "--- existing backlog precedence and ask-user behavior ---"

default_result="$(node "$CLI" effective-backlog-settings --repo-path "$ROOT" --json 2>/dev/null)"
[[ "$(printf '%s' "$default_result" | json_value status)" == "configured" ]] && pass "default project settings resolve through compiled CLI" || fail "default project settings resolve through compiled CLI"
[[ "$(printf '%s' "$default_result" | json_value settings.work_item_provider.kind)" == "github" ]] && pass "default provider kind is github" || fail "default provider kind is github"
[[ "$(printf '%s' "$default_result" | json_value settings.work_item_provider.repo.owner)" == "kontourai" ]] && pass "default repo owner is kontourai" || fail "default repo owner is kontourai"
[[ "$(printf '%s' "$default_result" | json_value settings.work_item_provider.repo.name)" == "flow-agents" ]] && pass "default repo name is flow-agents" || fail "default repo name is flow-agents"
[[ "$(printf '%s' "$default_result" | json_value settings.board_provider.board.number)" == "1" ]] && pass "default project number is 1" || fail "default project number is 1"
! printf '%s' "$default_result" | rg -q '/build/context/settings/backlog-provider-settings.json' && pass "default settings path is not build-relative" || fail "default settings path is not build-relative"

configured="$(node "$CLI" effective-backlog-settings --repo-path "$ROOT" --project-settings "$BACKLOG_SETTINGS" --global-settings "$EMPTY_BACKLOG" --json)"
[[ "$(printf '%s' "$configured" | json_value status)" == "configured" ]] && pass "configured repo resolves" || fail "configured repo resolves"
[[ "$(printf '%s' "$configured" | json_value settings.work_item_provider.kind)" == "github" ]] && pass "provider kind is github" || fail "provider kind is github"
[[ "$(printf '%s' "$configured" | json_value settings.work_item_provider.repo.owner)" == "kontourai" ]] && pass "repo owner is kontourai" || fail "repo owner is kontourai"
[[ "$(printf '%s' "$configured" | json_value settings.work_item_provider.repo.name)" == "flow-agents" ]] && pass "repo name is flow-agents" || fail "repo name is flow-agents"
[[ "$(printf '%s' "$configured" | json_value settings.board_provider.board.number)" == "1" ]] && pass "project number is 1" || fail "project number is 1"
printf '%s' "$configured" | rg -F -q '"ready_statuses": [' && pass "filters include ready statuses" || fail "filters include ready statuses"
printf '%s' "$configured" | rg -F -q '"include_labels": []' && pass "filters do not require labels by default" || fail "filters do not require labels by default"
printf '%s' "$configured" | rg -q '"prefer_finishing_active_work": true' && pass "WIP policy prefers finishing active work" || fail "WIP policy prefers finishing active work"

override_result="$(node "$CLI" effective-backlog-settings --repo-path "$ROOT" --project-settings "$BACKLOG_OVERRIDE" --global-settings "$BACKLOG_GLOBAL" --json)"
[[ "$(printf '%s' "$override_result" | json_value source)" == "project" ]] && pass "project settings override global defaults" || fail "project settings override global defaults"
[[ "$(printf '%s' "$override_result" | json_value settings.board_provider.board.number)" == "1" ]] && pass "project override keeps Project 1" || fail "project override keeps Project 1"
! printf '%s' "$override_result" | rg -q 'global-ready' && pass "project override replaces global filters" || fail "project override replaces global filters"

missing_output="$(node "$CLI" effective-backlog-settings --repo-path "$ROOT" --project-settings "$EMPTY_BACKLOG" --global-settings "$EMPTY_BACKLOG" --json 2>/dev/null)"
missing_status=$?
[[ "$missing_status" -eq 2 ]] && pass "missing settings exits with ask-user status" || fail "missing settings exits with ask-user status"
[[ "$(printf '%s' "$missing_output" | json_value status)" == "ask_user" ]] && pass "missing settings reports ask_user" || fail "missing settings reports ask_user"
printf '%s' "$missing_output" | rg -q 'WorkItemProvider and BoardProvider' && pass "missing settings names provider roles" || fail "missing settings names provider roles"

echo "--- public self-configuration and external multi-repository settings ---"

# Product-specific fleet routing belongs in consumer-owned settings. The public package proves
# that an external settings file can configure multiple repositories without embedding those
# consumer mappings in Flow Agents source.
if node --input-type=module - "$ROOT" "$CLI" "$TMPDIR_EVAL/repos" "$BACKLOG_SETTINGS" "$ASSIGNMENT_SETTINGS" "$EMPTY_BACKLOG" "$EMPTY_ASSIGNMENT" <<'NODE'
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

const [root, cli, reposRoot, publicBacklogPath, publicAssignmentPath, emptyBacklog, emptyAssignment] = process.argv.slice(2);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const backlogSchema = readJson(path.join(root, "schemas/backlog-provider-settings.schema.json"));
const assignmentSchema = readJson(path.join(root, "schemas/assignment-provider-settings.schema.json"));
const ajv = new Ajv2020({ allErrors: true });
const validateBacklog = ajv.compile(backlogSchema);
const validateAssignment = ajv.compile(assignmentSchema);

const publicBacklog = readJson(publicBacklogPath);
const publicAssignment = readJson(publicAssignmentPath);
assert(validateBacklog(publicBacklog), `public backlog settings schema validation failed: ${ajv.errorsText(validateBacklog.errors)}`);
assert(validateAssignment(publicAssignment), `public assignment settings schema validation failed: ${ajv.errorsText(validateAssignment.errors)}`);
assert(publicBacklog.projects.length === 1 && publicBacklog.projects[0]?.project?.repo?.name === "flow-agents", "public backlog settings must remain self-only");
assert(publicAssignment.projects.length === 1 && publicAssignment.projects[0]?.project?.repo?.name === "flow-agents", "public assignment settings must remain self-only");

const owner = "example-org";
const targets = ["alpha", "beta"];
const projectNumber = 42;
const repoRef = (name) => ({ owner, name, url: `https://github.com/${owner}/${name}` });
const externalBacklog = {
  schema_version: "1.0",
  projects: targets.map((name) => ({
    project: { repo: repoRef(name) },
    work_item_provider: { role: "WorkItemProvider", kind: "github", repo: repoRef(name), capabilities: ["issues", "labels", "assignees", "pr_links", "comments"] },
    board_provider: { role: "BoardProvider", kind: "github", repo: repoRef(name), board: { type: "github_project", owner, number: projectNumber, url: `https://github.com/orgs/${owner}/projects/${projectNumber}` }, capabilities: ["projects_boards", "status_fields", "custom_fields"] },
    selection: { filters: { issue_state: "open", include_labels: [], ready_statuses: ["ready"], exclude_statuses: ["triage", "in_progress", "blocked", "review", "verification", "done"] }, wip_policy: { prefer_finishing_active_work: true, active_statuses: ["in_progress", "review", "verification"], block_new_work_when_active_count_exceeds: 0 } },
  })),
};
const externalAssignment = {
  schema_version: "1.0",
  projects: targets.map((name) => ({
    project: { repo: repoRef(name) },
    provider: { kind: "github", repo: repoRef(name), capabilities: ["assignees", "labels", "comments"] },
    policy: { label_name: "agent:claimed", claim_comment_marker: "<!-- flow-agents:assignment-claim -->", human_assignee_policy: { behavior: "ask_first", idle_threshold_days: 3 }, comment_refresh_on_phase_transition: false },
  })),
};
assert(validateBacklog(externalBacklog), `external backlog settings schema validation failed: ${ajv.errorsText(validateBacklog.errors)}`);
assert(validateAssignment(externalAssignment), `external assignment settings schema validation failed: ${ajv.errorsText(validateAssignment.errors)}`);

fs.mkdirSync(reposRoot, { recursive: true });
const externalBacklogPath = path.join(reposRoot, "backlog-provider-settings.json");
const externalAssignmentPath = path.join(reposRoot, "assignment-provider-settings.json");
fs.writeFileSync(externalBacklogPath, JSON.stringify(externalBacklog, null, 2));
fs.writeFileSync(externalAssignmentPath, JSON.stringify(externalAssignment, null, 2));

for (const name of targets) {
  const repoPath = path.join(reposRoot, name);
  fs.mkdirSync(repoPath, { recursive: true });
  fs.writeFileSync(path.join(repoPath, "package.json"), JSON.stringify({ name: `fixture-${name}`, repository: { type: "git", url: `https://github.com/${owner}/${name}.git` } }, null, 2));
  const resolve = (command, globalPath, emptyProject) => JSON.parse(execFileSync(process.execPath, [cli, command, "--repo-path", repoPath, "--project-settings", emptyProject, "--global-settings", globalPath, "--json"], { encoding: "utf8" }));
  const backlogResult = resolve("effective-backlog-settings", externalBacklogPath, emptyBacklog);
  const assignmentResult = resolve("effective-assignment-provider-settings", externalAssignmentPath, emptyAssignment);

  assert(backlogResult.status === "configured" && backlogResult.source === "global", `${name} backlog settings must resolve from the external file`);
  assert(backlogResult.settings.work_item_provider?.repo?.name === name, `${name} must select its own work item repository`);
  assert(backlogResult.settings.board_provider?.board?.number === projectNumber, `${name} must select the external board`);
  assert(assignmentResult.status === "configured" && assignmentResult.source === "global", `${name} assignment settings must resolve from the external file`);
  assert(assignmentResult.settings.provider?.repo?.name === name, `${name} must select its own assignment repository`);
}

console.log("Public settings remain self-only and external multi-repository settings resolve through the supported global precedence layer.");
NODE
then
  pass "public settings stay self-only and external multi-repository settings resolve"
else
  fail "public settings stay self-only and external multi-repository settings resolve"
fi

if [[ "$errors" -eq 0 ]]; then
  echo "Effective provider settings checks passed"
else
  echo "Effective provider settings checks failed: $errors"
fi

exit "$errors"
