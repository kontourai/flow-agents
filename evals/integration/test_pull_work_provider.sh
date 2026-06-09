#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SETTINGS="$ROOT/context/settings/backlog-provider-settings.json"
FIXTURE="$ROOT/evals/fixtures/pull-work-provider/github-issues.json"
SCRIPT="$ROOT/scripts/pull-work-provider.js"
TMPDIR_EVAL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_EVAL"' EXIT

errors=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

json_query() {
  node -e 'const fs=require("fs"); let cur=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); for (const part of process.argv[2].split(".")) cur=part==="length" ? cur.length : (Array.isArray(cur) ? cur[Number(part)] : cur[part]); console.log(cur);' "$1" "$2"
}

echo "=== Pull Work Provider Normalization ==="

node "$SCRIPT" \
  --settings-json "$SETTINGS" \
  --issues-json "$FIXTURE" \
  --resolved-ref 'kontourai/flow#2=closed' \
  --current-ref main \
  --current-sha cccccccccccccccccccccccccccccccccccccccc \
  --changed-file docs/readme.md \
  --commits-since dddddddddddddddddddddddddddddddddddddddd=2 \
  --commits-since eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee=12 \
  --now 2026-06-03T00:00:00Z \
  > "$TMPDIR_EVAL/normalized.json"
status=$?
[[ "$status" -eq 0 ]] && pass "normalizer exits successfully" || fail "normalizer exits successfully"

[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.0.id")" == "github:kontourai/flow-agents#22" ]] && pass "normalizes provider-qualified id" || fail "normalizes provider-qualified id"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.0.source_provider.role")" == "WorkItemProvider" ]] && pass "preserves work item provider ref" || fail "preserves work item provider ref"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.0.board_membership.role")" == "BoardProvider" ]] && pass "preserves board provider ref" || fail "preserves board provider ref"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.0.artifact_refs.0")" == ".flow-agents/flow-agents-kit-platform-backlog/flow-agents-kit-platform-backlog--idea-to-backlog.md" ]] && pass "preserves source artifact ref" || fail "preserves source artifact ref"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.0.blockers.0.ref.owner")" == "kontourai" ]] && pass "preserves blocker owner" || fail "preserves blocker owner"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.0.blockers.0.ref.repo")" == "flow" ]] && pass "preserves cross-repo blocker repo" || fail "preserves cross-repo blocker repo"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.0.dependency_impacts.0.ref.owner")" == "kontourai" ]] && pass "projects prose blocker impact owner" || fail "projects prose blocker impact owner"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.0.dependency_impacts.0.ref.repo")" == "flow" ]] && pass "projects prose blocker impact repo" || fail "projects prose blocker impact repo"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.0.dependency_impacts.0.cross_repo")" == "true" ]] && pass "marks prose blocker impact cross-repo" || fail "marks prose blocker impact cross-repo"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.0.dependency_impacts.0.known_status")" == "closed" ]] && pass "projects resolved prose blocker status" || fail "projects resolved prose blocker status"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.0.dependency_impacts.0.impact_state")" == "resolved" ]] && pass "projects resolved prose blocker impact state" || fail "projects resolved prose blocker impact state"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.0.readiness.classification")" == "ready" ]] && pass "#22 ready when flow#2 is closed" || fail "#22 ready when flow#2 is closed"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.1.readiness.classification")" == "blocked" ]] && pass "blocked item classified blocked" || fail "blocked item classified blocked"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.2.readiness.classification")" == "related-only" ]] && pass "research item classified related-only" || fail "research item classified related-only"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.3.readiness.classification")" == "in_progress" ]] && pass "in-progress item classified in_progress" || fail "in-progress item classified in_progress"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.4.readiness.classification")" == "stale" ]] && pass "old unshaped item classified stale" || fail "old unshaped item classified stale"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.5.planned_base_ref")" == "main" ]] && pass "marker normalizes planned_base_ref" || fail "marker normalizes planned_base_ref"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.5.planned_base_sha")" == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" ]] && pass "marker normalizes planned_base_sha" || fail "marker normalizes planned_base_sha"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.5.planned_at")" == "2026-06-03T03:23:14Z" ]] && pass "marker normalizes planned_at" || fail "marker normalizes planned_at"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.5.planning_artifact_ref")" == ".flow-agents/idea-to-backlog-source-revision-structured-blockers/idea-to-backlog-source-revision-structured-blockers--plan.md" ]] && pass "marker normalizes planning_artifact_ref" || fail "marker normalizes planning_artifact_ref"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.5.planning_scope_refs.0")" == "skills/idea-to-backlog/SKILL.md" ]] && pass "marker normalizes planning_scope_refs" || fail "marker normalizes planning_scope_refs"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.5.source_revisions.1.repo")" == "kontourai/flow" ]] && pass "marker preserves repo-scoped source_revisions" || fail "marker preserves repo-scoped source_revisions"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.5.blockers.0.ref.owner")" == "kontourai" ]] && pass "structured blocker preserves provider owner" || fail "structured blocker preserves provider owner"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.5.blockers.0.ref.repo")" == "flow" ]] && pass "structured blocker preserves provider repo" || fail "structured blocker preserves provider repo"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.5.blockers.0.ref.number")" == "2" ]] && pass "structured blocker preserves provider number" || fail "structured blocker preserves provider number"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.5.blockers.1.type")" == "text" ]] && pass "structured blocker preserves text blocker" || fail "structured blocker preserves text blocker"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.5.blockers.1.evidence")" == "Product decision on rollout scope." ]] && pass "structured blocker preserves text evidence" || fail "structured blocker preserves text evidence"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.5.blockers.2.evidence")" == "Blocked by product decision on rollout scope." ]] && pass "prose blocker remains alongside structured blockers" || fail "prose blocker remains alongside structured blockers"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.5.readiness.classification")" == "blocked" ]] && pass "text blocker keeps marker item blocked" || fail "text blocker keeps marker item blocked"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.6.blockers.0.ref.repo")" == "flow-agents" ]] && pass "invalid marker falls back to prose blocker repo" || fail "invalid marker falls back to prose blocker repo"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.6.readiness.classification")" == "blocked" ]] && pass "invalid marker fallback preserves blocked readiness" || fail "invalid marker fallback preserves blocked readiness"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.7.revision_freshness.classification")" == "fresh" ]] && pass "fresh item freshness classified fresh" || fail "fresh item freshness classified fresh"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.7.revision_freshness.planned_base_sha")" == "cccccccccccccccccccccccccccccccccccccccc" ]] && pass "freshness preserves planned base sha" || fail "freshness preserves planned base sha"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.7.revision_freshness.current_sha")" == "cccccccccccccccccccccccccccccccccccccccc" ]] && pass "freshness reports current sha" || fail "freshness reports current sha"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.7.revision_freshness.planned_age_days")" == "1" ]] && pass "freshness reports planned age" || fail "freshness reports planned age"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.8.revision_freshness.classification")" == "drifted" ]] && pass "drifted item freshness classified drifted" || fail "drifted item freshness classified drifted"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.8.revision_freshness.commits_since_planned_base")" == "2" ]] && pass "drifted item reports commits since planned base" || fail "drifted item reports commits since planned base"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.8.revision_freshness.planning_scope_intersections.length")" == "0" ]] && pass "drifted item reports no scope intersections" || fail "drifted item reports no scope intersections"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.9.revision_freshness.classification")" == "stale" ]] && pass "stale item freshness classified stale" || fail "stale item freshness classified stale"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.9.revision_freshness.route_recommendation.target")" == "idea-to-backlog" ]] && pass "stale item routes back to idea-to-backlog" || fail "stale item routes back to idea-to-backlog"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.9.readiness.classification")" == "stale" ]] && pass "stale freshness constrains readiness" || fail "stale freshness constrains readiness"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.10.revision_freshness.classification")" == "not_verified" ]] && pass "legacy item without planned_base_sha is not_verified" || fail "legacy item without planned_base_sha is not_verified"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.10.revision_freshness.reasons.0.code")" == "missing_planned_base_sha" ]] && pass "legacy item records missing planned_base_sha reason" || fail "legacy item records missing planned_base_sha reason"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.10.readiness.classification")" == "ready" ]] && pass "legacy freshness gap preserves readiness while reporting not_verified freshness" || fail "legacy freshness gap preserves readiness while reporting not_verified freshness"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.11.blockers.0.ref.owner")" == "kontourai" ]] && pass "structured-only blocker preserves owner" || fail "structured-only blocker preserves owner"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.11.blockers.0.ref.repo")" == "flow" ]] && pass "structured-only blocker preserves cross-repo repo" || fail "structured-only blocker preserves cross-repo repo"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.11.blockers.0.ref.number")" == "2" ]] && pass "structured-only blocker preserves number" || fail "structured-only blocker preserves number"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.11.dependency_impacts.0.ref.owner")" == "kontourai" ]] && pass "structured-only dependency impact preserves owner" || fail "structured-only dependency impact preserves owner"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.11.dependency_impacts.0.ref.repo")" == "flow" ]] && pass "structured-only dependency impact preserves repo" || fail "structured-only dependency impact preserves repo"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.11.dependency_impacts.0.ref.number")" == "2" ]] && pass "structured-only dependency impact preserves number" || fail "structured-only dependency impact preserves number"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.11.dependency_impacts.0.source.type")" == "provider_ref" ]] && pass "structured-only dependency impact records source blocker type" || fail "structured-only dependency impact records source blocker type"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.11.dependency_impacts.0.source.evidence")" == "Requires Flow contract issue first." ]] && pass "structured-only dependency impact records source evidence" || fail "structured-only dependency impact records source evidence"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.11.dependency_impacts.0.cross_repo")" == "true" ]] && pass "structured-only dependency impact is cross-repo" || fail "structured-only dependency impact is cross-repo"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.11.dependency_impacts.0.known_status")" == "closed" ]] && pass "structured-only dependency impact records resolved status" || fail "structured-only dependency impact records resolved status"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.11.dependency_impacts.0.impact_state")" == "resolved" ]] && pass "structured-only dependency impact state is resolved" || fail "structured-only dependency impact state is resolved"
[[ "$(json_query "$TMPDIR_EVAL/normalized.json" "items.11.readiness.classification")" == "ready" ]] && pass "structured-only item ready when cross-repo blocker is closed" || fail "structured-only item ready when cross-repo blocker is closed"

node "$SCRIPT" \
  --settings-json "$SETTINGS" \
  --issues-json "$FIXTURE" \
  --current-ref main \
  --current-sha ffffffffffffffffffffffffffffffffffffffff \
  --now 2026-06-03T00:00:00Z \
  > "$TMPDIR_EVAL/missing-drift-evidence.json"
[[ "$(json_query "$TMPDIR_EVAL/missing-drift-evidence.json" "items.8.revision_freshness.classification")" == "not_verified" ]] && pass "moved target without drift evidence is not_verified" || fail "moved target without drift evidence is not_verified"
[[ "$(json_query "$TMPDIR_EVAL/missing-drift-evidence.json" "items.8.revision_freshness.reasons.1.code")" == "missing_drift_evidence" ]] && pass "moved target records missing drift evidence reason" || fail "moved target records missing drift evidence reason"
[[ "$(json_query "$TMPDIR_EVAL/missing-drift-evidence.json" "items.8.readiness.classification")" == "blocked" ]] && pass "missing drift evidence blocks ready classification" || fail "missing drift evidence blocks ready classification"

node "$SCRIPT" \
  --settings-json "$SETTINGS" \
  --issues-json "$FIXTURE" \
  --current-ref main \
  --current-sha cccccccccccccccccccccccccccccccccccccccc \
  --changed-file context/contracts/work-item-contract.md \
  --commits-since dddddddddddddddddddddddddddddddddddddddd=2 \
  --now 2026-06-03T00:00:00Z \
  > "$TMPDIR_EVAL/material-contract-drift.json"
[[ "$(json_query "$TMPDIR_EVAL/material-contract-drift.json" "items.8.revision_freshness.classification")" == "stale" ]] && pass "contract drift marks non-scoped planned item stale" || fail "contract drift marks non-scoped planned item stale"
[[ "$(json_query "$TMPDIR_EVAL/material-contract-drift.json" "items.8.revision_freshness.reasons.2.code")" == "material_freshness_files_changed" ]] && pass "contract drift records material freshness reason" || fail "contract drift records material freshness reason"
[[ "$(json_query "$TMPDIR_EVAL/material-contract-drift.json" "items.9.revision_freshness.planning_scope_intersections.0")" == "context/contracts/work-item-contract.md" ]] && pass "stale item reports planning scope intersection" || fail "stale item reports planning scope intersection"

node "$SCRIPT" \
  --settings-json - \
  --issues-json "$FIXTURE" \
  --resolved-ref 'kontourai/flow#2=closed' \
  < "$SETTINGS" \
  > "$TMPDIR_EVAL/stdin-settings.json"
[[ "$(json_query "$TMPDIR_EVAL/stdin-settings.json" "items.0.readiness.classification")" == "ready" ]] && pass "normalizer accepts stdin settings JSON" || fail "normalizer accepts stdin settings JSON"

node "$SCRIPT" \
  --settings-json "$SETTINGS" \
  --issues-json "$FIXTURE" \
  > "$TMPDIR_EVAL/unresolved.json"
[[ "$(json_query "$TMPDIR_EVAL/unresolved.json" "items.0.readiness.classification")" == "blocked" ]] && pass "#22 blocked when flow#2 state is unknown" || fail "#22 blocked when flow#2 state is unknown"
[[ "$(json_query "$TMPDIR_EVAL/unresolved.json" "items.5.readiness.classification")" == "blocked" ]] && pass "marker item blocked when provider ref and text blocker are unresolved" || fail "marker item blocked when provider ref and text blocker are unresolved"
[[ "$(json_query "$TMPDIR_EVAL/unresolved.json" "items.11.dependency_impacts.0.known_status")" == "unknown" ]] && pass "structured-only dependency impact records unknown status without resolved ref" || fail "structured-only dependency impact records unknown status without resolved ref"
[[ "$(json_query "$TMPDIR_EVAL/unresolved.json" "items.11.dependency_impacts.0.impact_state")" == "unknown" ]] && pass "structured-only dependency impact state is unknown without resolved ref" || fail "structured-only dependency impact state is unknown without resolved ref"
[[ "$(json_query "$TMPDIR_EVAL/unresolved.json" "items.11.readiness.classification")" == "blocked" ]] && pass "structured-only blocker blocks without prose parsing" || fail "structured-only blocker blocks without prose parsing"

if [[ "$errors" -eq 0 ]]; then
  echo "Pull work provider checks passed"
else
  echo "Pull work provider checks failed: $errors"
fi

exit "$errors"
