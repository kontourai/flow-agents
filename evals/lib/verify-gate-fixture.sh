#!/usr/bin/env bash
# evals/lib/verify-gate-fixture.sh — Reusable fixture helpers that drive a
# public builder.build session from `start` through the multi-expectation
# verify-gate (clean-critique, acceptance-criteria, tests-evidence).
#
# Built for kontourai/flow-agents#974 AC4 (narrowing the current-gate
# `flow_run_head` check from cross-claim identity to per-claim presence), and
# intended for reuse by later evals that need a session parked at verify-gate.
#
# Requires evals/lib/node.sh already sourced (needs ROOT and
# flow_agents_build_ts). Source this file after that.
#
# Public functions:
#   vgf_flow <actor_session_id> <workflow-subcommand...>
#   vgf_new_public_root <parent_dir>
#   vgf_prepare_artifacts <session_dir>
#   vgf_drive_to_verify <producer_actor> <public_root> <work_item>   # echoes session_dir
#   vgf_pause_resume <actor_session_id> <session_dir> [reason]
#   vgf_trigger_sync <actor_session_id> <public_root> <work_item>
#   vgf_reenter_execute_to_verify <producer_actor> <session_dir>
#   vgf_record_critique <reviewer_actor> <session_dir> [verdict] [summary]
#   vgf_test_command <session_dir>
#   vgf_record_tests_evidence <producer_actor> <session_dir> <status> [route_reason]
#   vgf_current_step <actor_session_id> <session_dir>

vgf_flow() {
  local actor="$1"; shift
  # FLOW_AGENTS_ACTOR is an explicit override that always wins over ambient
  # runtime detection (see scripts/hooks/lib/actor-identity.js) -- necessary
  # because this suite itself runs under an agent runtime (Claude Code/Codex)
  # whose own ambient session id would otherwise make every "actor" resolve
  # identically regardless of CODEX_SESSION_ID.
  env -u CODEX_THREAD_ID CODEX_SESSION_ID="$actor" FLOW_AGENTS_ACTOR="$actor" node "$ROOT/build/src/cli.js" workflow "$@"
}

vgf_new_public_root() {
  local parent="$1"
  local repo="$parent/public-$$-$RANDOM"
  mkdir -p "$repo"
  git -C "$repo" init -q
  git -C "$repo" config user.email verify-gate-fixture@example.invalid
  git -C "$repo" config user.name "Verify Gate Fixture"
  printf '.kontourai/\n' > "$repo/.gitignore"
  git -C "$repo" add .gitignore
  git -C "$repo" commit -qm "seed verify-gate fixture repo"
  echo "$repo/.kontourai/flow-agents"
}

vgf_prepare_artifacts() {
  local session_dir="$1"
  node - "$session_dir" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const session = process.argv[2];
const slug = path.basename(session);
const write = (name, body) => fs.writeFileSync(path.join(session, name), body, 'utf8');
const projectRoot = path.dirname(path.dirname(path.dirname(session)));
const checksDir = path.join(projectRoot, 'checks');
fs.mkdirSync(checksDir, { recursive: true });
const checkScript = path.join(checksDir, 'check-vgf-fixture.sh');
fs.writeFileSync(checkScript, '#!/usr/bin/env bash\nset -eu\ntest -f "$1"\nprintf "1..1\\nok 1 - session exists\\n"\n', 'utf8');
fs.chmodSync(checkScript, 0o755);
// pull-work.md is intentionally NOT (re)written here: workflow start already
// validated it contains the literal --work-item ref, and a caller that
// re-invokes `workflow start` later (e.g. as a non-writing sync trigger) needs
// that exact content to still be present.
write(`${slug}--plan-work.md`, '# Plan\n\n## Definition Of Done\n\n- AC-1: The fixture records criterion-backed evidence.\n- AC-2: Every accepted criterion is backed by the exact test command.\n');
write(`${slug}--deliver.md`, '# Delivery\n\nImplementation scope and change summary are reviewable here.\n');
write(`${slug}--evidence-gate.md`, '# Evidence Gate\n\nAcceptance coverage and scope-integrity decision.\n');
write('acceptance.json', JSON.stringify({ schema_version: '1.0', task_slug: slug, criteria: [{ id: 'AC-1', description: 'The fixture records criterion-backed evidence.', status: 'pending', evidence_refs: [] }, { id: 'AC-2', description: 'Every accepted criterion is backed by the exact test command.', status: 'pending', evidence_refs: [] }], goal_fit: { status: 'pending', summary: 'Fixture has not completed Goal Fit review.' } }, null, 2));
write('handoff.json', JSON.stringify({ schema_version: '1.0', task_slug: slug, summary: 'Fixture execution handoff.', next_steps: ['Execute the reviewed plan.'], blockers: [] }, null, 2));
write('release.json', JSON.stringify({ schema_version: '1.0', task_slug: slug, decision: 'hold', updated_at: '2026-06-26T00:00:00Z', scope: 'fixture', evidence_ref: `${slug}--evidence-gate.md`, gates: [{ name: 'merge', status: 'hold', summary: 'Fixture is not authorized to merge.' }], rollback_plan: { status: 'not_required', summary: 'No release.', owner: 'fixture' }, observability_plan: { status: 'not_required', summary: 'No release.' }, post_deploy_checks: [], docs: { status: 'not_needed', summary: 'Fixture.' } }, null, 2));
write('learning.json', JSON.stringify({ schema_version: '1.0', task_slug: slug, status: 'learned', updated_at: '2026-06-26T00:00:00Z', records: [] }, null, 2));
NODE
}

vgf_evidence_for() {
  local session_dir="$1" expectation="$2" slug
  slug="$(basename "$session_dir")"
  case "$expectation" in
    pickup-probe-readiness|probe-decisions-or-accepted-gaps) echo "$session_dir/$slug--pull-work.md" ;;
    implementation-plan) echo "$session_dir/$slug--plan-work.md" ;;
    implementation-scope) echo "$session_dir/$slug--deliver.md" ;;
    *) echo "$session_dir/$slug--deliver.md" ;;
  esac
}

vgf_record_expectation() {
  local actor="$1" session_dir="$2" expectation="$3" artifact
  artifact="$(vgf_evidence_for "$session_dir" "$expectation")"
  vgf_flow "$actor" evidence --session-dir "$session_dir" --expectation "$expectation" --status pass \
    --summary "Fixture producer records $expectation" \
    --evidence-ref-json "{\"kind\":\"artifact\",\"file\":\"$artifact\",\"summary\":\"Fixture artifact for $expectation.\"}"
}

# A pause/resume cycle is a Flow-canonical, unrelated-to-this-gate state
# mutation: it advances flowRunHead(state) (the run state hash covers the
# whole state, including lifecycle bookkeeping) without transitioning
# to_step, so it never moves currentGateVisit's boundary. This is the
# realistic trigger for two claims on the SAME multi-expectation gate to
# legitimately carry DIFFERENT flow_run_head values within one visit --
# recording two claims back-to-back with nothing else touching Flow state in
# between leaves both claims stamped with the SAME head, which would never
# have exercised the removed cross-claim identity check.
vgf_pause_resume() {
  local actor="$1" session_dir="$2" reason="${3:-fixture head-shift}"
  env -u CODEX_THREAD_ID CODEX_SESSION_ID="$actor" FLOW_AGENTS_ACTOR="$actor" \
    node "$ROOT/build/src/cli.js" builder-run pause --session-dir "$session_dir" --reason "$reason" >/dev/null 2>&1
  env -u CODEX_THREAD_ID CODEX_SESSION_ID="$actor" FLOW_AGENTS_ACTOR="$actor" \
    node "$ROOT/build/src/cli.js" builder-run resume --session-dir "$session_dir" --reason "$reason" >/dev/null 2>&1
}

# `workflow start` always derives the session slug from --work-item (owner/repo#N
# -> lowercased "owner-repo-N"; see src/lib/work-item-identity.ts workItemSlug),
# never from a caller-chosen slug. Mirror that derivation so callers can predict
# the session dir without depending on our fixture accepting an independent slug
# the CLI would silently ignore.
vgf_work_item_slug() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
}

# Starts a fresh session (slug derived from work_item) and records every
# expectation through implementation-scope. Leaves the run active at
# `verify`, visit 1, with no verify-gate claims recorded yet. Echoes the
# session dir on success.
vgf_drive_to_verify() {
  local producer="$1" public_root="$2" work_item="$3"
  local slug session_dir
  slug="$(vgf_work_item_slug "$work_item")"
  session_dir="$public_root/$slug"
  mkdir -p "$public_root" "$session_dir"
  printf 'Selected Work Item: %s\n' "$work_item" > "$session_dir/$slug--pull-work.md"
  vgf_flow "$producer" start --artifact-root "$public_root" --flow builder.build \
    --work-item "$work_item" --assignment-provider local-file --summary "Fixture: drive to verify-gate" >/dev/null 2>&1 || return 1
  vgf_prepare_artifacts "$session_dir"
  # design-probe-gate has TWO required expectations -- record the first,
  # insert an unrelated Flow-state mutation (see vgf_pause_resume), then
  # record the second, so the two claims legitimately carry different
  # flow_run_head values within the same visit (see vgf_pause_resume).
  vgf_record_expectation "$producer" "$session_dir" "pickup-probe-readiness" >/dev/null 2>&1 || return 1
  vgf_pause_resume "$producer" "$session_dir" "fixture: unrelated mutation between design-probe claims"
  vgf_record_expectation "$producer" "$session_dir" "probe-decisions-or-accepted-gaps" >/dev/null 2>&1 || return 1
  local expectation
  for expectation in implementation-plan implementation-scope; do
    vgf_record_expectation "$producer" "$session_dir" "$expectation" >/dev/null 2>&1 || return 1
  done
  echo "$session_dir"
}

# Re-enters `execute` after a route-back by re-recording implementation-scope
# with fresh evidence, advancing back to `verify` (a NEW gate visit).
vgf_reenter_execute_to_verify() {
  local producer="$1" session_dir="$2"
  vgf_record_expectation "$producer" "$session_dir" "implementation-scope" >/dev/null 2>&1
}

vgf_record_critique() {
  local reviewer="$1" session_dir="$2" verdict="${3:-pass}" summary="${4:-Fixture: authenticated review found no blocking findings.}" slug
  slug="$(basename "$session_dir")"
  vgf_flow "$reviewer" critique --session-dir "$session_dir" \
    --verdict "$verdict" \
    --summary "$summary" \
    --artifact-ref "$session_dir/$slug--deliver.md" \
    --lane-json "{\"id\":\"code-review\",\"status\":\"$verdict\",\"summary\":\"Fixture code review completed.\",\"evidence_refs\":[{\"kind\":\"artifact\",\"file\":\"$session_dir/$slug--deliver.md\",\"summary\":\"Reviewed fixture delivery artifact.\"}]}"
}

# The check script only needs an existing file to point at; deliberately NOT
# a flow-agents runtime sidecar path (current.json/state.json/trust.bundle
# are hook-protected tokens that a raw interpreter invocation must not
# reference on disk-writing commands elsewhere in this suite).
vgf_test_command() {
  local session_dir="$1" slug
  slug="$(basename "$session_dir")"
  echo "bash checks/check-vgf-fixture.sh .kontourai/flow-agents/$slug/handoff.json"
}

vgf_record_tests_evidence() {
  local producer="$1" session_dir="$2" status="${3:-pass}" route_reason="${4:-}"
  local test_command criterion_one criterion_two command_ref
  test_command="$(vgf_test_command "$session_dir")"
  command_ref="$(printf '{"kind":"command","excerpt":%s,"summary":"Exact project-local verification command."}' "$(vgf_json_string "$test_command")")"
  criterion_one="$(vgf_criterion_json AC-1 "$status" "$test_command")"
  criterion_two="$(vgf_criterion_json AC-2 "$status" "$test_command")"
  local -a args=(evidence --session-dir "$session_dir" --expectation tests-evidence --status "$status"
    --command "$test_command" --summary "Fixture tests-evidence recording ($status)"
    --evidence-ref-json "$command_ref"
    --criterion-json "$criterion_one" --criterion-json "$criterion_two")
  if [ "$status" = "fail" ] && [ -n "$route_reason" ]; then
    args+=(--route-reason "$route_reason")
  fi
  vgf_flow "$producer" "${args[@]}"
}

vgf_criterion_json() {
  local id="$1" status="$2" command="$3"
  printf '{"id":"%s","status":"%s","evidence_refs":[{"kind":"command","excerpt":%s,"summary":"Fixture %s evidence."}]}' \
    "$id" "$status" "$(vgf_json_string "$command")" "$id"
}

vgf_json_string() {
  node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"
}

# `workflow critique` (and record-gate-claim) write to trust.bundle WITHOUT
# ever calling syncBuilderFlowSession -- only `workflow evidence` and
# `workflow start` (idempotent) actually attach/evaluate. Call this after a
# critique-only recording (or any raw record-gate-claim write) to actually
# ask Flow "is this gate satisfied now?" without writing a new claim.
vgf_trigger_sync() {
  local actor="$1" public_root="$2" work_item="$3"
  vgf_flow "$actor" start --artifact-root "$public_root" --flow builder.build \
    --work-item "$work_item" --assignment-provider local-file --summary "Fixture: trigger sync" >/dev/null 2>&1
}

vgf_current_step() {
  local actor="$1" session_dir="$2"
  vgf_flow "$actor" status --session-dir "$session_dir" --json 2>/dev/null | vgf_read_json_field current_step
}

vgf_read_json_field() {
  local field="$1"
  node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(d);console.log(j[process.argv[1]]??"");}catch{console.log("");}});' "$field"
}
