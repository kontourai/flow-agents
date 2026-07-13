#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS %s\n' "$*"; }

cd "$ROOT_DIR"
npm run build --silent
npm run build:bundles --silent
npm pack --silent --pack-destination "$TMP" >/dev/null
TARBALL="$(find "$TMP" -maxdepth 1 -name 'kontourai-flow-agents-*.tgz' -print -quit)"
[[ -n "$TARBALL" ]] || fail "npm pack did not produce a tarball"
VERSION="$(node -p "require('./package.json').version")"
CONSUMER="$TMP/consumer"
ARTIFACT_ROOT="$CONSUMER/.kontourai/flow-agents"
TOOL_ROOT="$TMP/tool"
mkdir -p "$CONSUMER"
mkdir -p "$CONSUMER/checks"
npm install --silent --prefix "$TOOL_ROOT" --no-save "$TARBALL"
FLOW_AGENTS_BIN="$TOOL_ROOT/node_modules/.bin/flow-agents"
WORKFLOW_SIDECAR_BIN="$TOOL_ROOT/node_modules/.bin/flow-agents-workflow-sidecar"
[[ -x "$FLOW_AGENTS_BIN" && -x "$WORKFLOW_SIDECAR_BIN" ]] || fail "packed install did not expose the expected binaries"
printf '#!/usr/bin/env bash\nset -eu\ntest -f "$1"\nprintf "1..1\\nok 1 - session exists\\n"\n' > "$CONSUMER/checks/check-public-workflow.sh"
chmod +x "$CONSUMER/checks/check-public-workflow.sh"
printf '#!/usr/bin/env bash\nset -eu\ntouch "$1"\nsleep 1\n' > "$CONSUMER/checks/check-command-lock.sh"
chmod +x "$CONSUMER/checks/check-command-lock.sh"
printf '#!/usr/bin/env bash\nset -eu\ntest -f "$1"\nprintf "run\\n" >> "$2"\nprintf "1..1\\nok 1 - session exists\\n"\n' > "$CONSUMER/checks/check-multi-command.sh"
chmod +x "$CONSUMER/checks/check-multi-command.sh"
printf '#!/usr/bin/env bash\nset -eu\ntrap "" TERM\n( trap "" TERM; sleep 5; touch "$2" ) &\nchild=$!\nprintf "%s\\n" "$child" > "$1"\nwait "$child"\ntouch "$2"\n' > "$CONSUMER/checks/check-command-timeout.sh"
chmod +x "$CONSUMER/checks/check-command-timeout.sh"
printf '#!/usr/bin/env bash\nset -eu\n( trap "" TERM; while ! sleep 5; do :; done; touch "$2" ) &\nprintf "%s\\n" "$!" > "$1"\n' > "$CONSUMER/checks/check-success-background.sh"
chmod +x "$CONSUMER/checks/check-success-background.sh"

run_candidate() {
  (cd "$CONSUMER" && env -u CODEX_THREAD_ID CODEX_SESSION_ID=public-workflow-eval "$FLOW_AGENTS_BIN" workflow "$@")
}

run_candidate_as() {
  local actor="$1"
  shift
  (cd "$CONSUMER" && env -u CODEX_THREAD_ID CODEX_SESSION_ID="$actor" "$FLOW_AGENTS_BIN" workflow "$@")
}

snapshot_tree() {
  local root="$1"
  find "$root" -type f -print0 | sort -z | xargs -0 shasum -a 256
}

PRIMARY_HELP="$(cd "$CONSUMER" && "$FLOW_AGENTS_BIN" --help)"
WORKFLOW_HELP="$(run_candidate --help)"
[[ "$PRIMARY_HELP" == *"workflow"* && "$WORKFLOW_HELP" != *"workflow-sidecar"* && "$WORKFLOW_HELP" != *"npm run workflow:sidecar"* ]] || fail "public help exposes internal writer terminology or omits workflow"
pass "isolated packed install exposes the public workflow command without internal writer terminology"

seed_pull_work() {
  local work_item="$1"
  local slug
  slug="$(printf '%s' "$work_item" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"
  mkdir -p "$ARTIFACT_ROOT/$slug"
  printf 'Selected Work Item: %s\n' "$work_item" >"$ARTIFACT_ROOT/$slug/$slug--pull-work.md"
}

seed_pull_work acme/widgets#101
run_candidate start --artifact-root "$ARTIFACT_ROOT" --flow builder.build --work-item acme/widgets#101 --assignment-provider local-file --summary "Release fixture" >/dev/null
RELEASE_SESSION="$ARTIFACT_ROOT/acme-widgets-101"
[[ -f "$RELEASE_SESSION/state.json" ]] || fail "packed start did not create a session"
[[ ! -e "$CONSUMER/package.json" ]] || fail "consumer unexpectedly gained package.json"
pass "packed start works in a non-Node consumer"
seed_pull_work provider:work-item-123
run_candidate start --artifact-root "$ARTIFACT_ROOT" --flow builder.build --work-item provider:work-item-123 --assignment-provider local-file --summary "Provider-neutral fixture" >/dev/null
PROVIDER_STATUS="$(run_candidate status --session-dir "$ARTIFACT_ROOT/provider-work-item-123" --json)"
node -e 'const r=JSON.parse(process.argv[1]);if(r.definition_id!=="builder.build"||r.current_step!=="design-probe")process.exit(1)' "$PROVIDER_STATUS" || fail "provider-neutral Work Item did not start canonically"
pass "documented provider-neutral Work Item refs start without GitHub identity inference"
seed_pull_work provider:externally-owned-456
PROVIDER_STATE="$CONSUMER/provider-assignment-state.json"
node - "$PROVIDER_STATE" "$ARTIFACT_ROOT/assignment/acme-widgets-101.json" <<'NODE'
const fs = require('node:fs');
const local = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const subject = 'provider-externally-owned-456';
const record = { ...local, subject_id: subject, work_item_ref: 'provider:externally-owned-456' };
fs.writeFileSync(process.argv[2], `${JSON.stringify({ role: 'AssignmentStatus', provider: 'example-provider', assignment: { subject_id: subject, provider: 'example-provider', assignee: local.actor_key, record }, effective: { effective_state: 'held', reason: 'self_is_holder', holder: { actor: local.actor_key } } }, null, 2)}\n`);
NODE
run_candidate start --artifact-root "$ARTIFACT_ROOT" --flow builder.build --work-item provider:externally-owned-456 --assignment-provider example-provider --effective-state-json "$PROVIDER_STATE" --summary "Externally assigned fixture" >/dev/null
EXTERNAL_SESSION="$ARTIFACT_ROOT/provider-externally-owned-456"
node - "$ARTIFACT_ROOT/assignment/provider-externally-owned-456.json" "$EXTERNAL_SESSION/assignment-provider-state.json" "$EXTERNAL_SESSION/trust.bundle" <<'NODE'
const fs = require('node:fs');
const assignment = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const provider = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const bundle = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
const selected = bundle.claims.find((claim) => claim.metadata?.gate_claim?.expectation_id === 'selected-work');
if (assignment.work_item_ref !== 'provider:externally-owned-456' || provider.effective?.reason !== 'self_is_holder' || !selected?.metadata?.artifact_refs?.some((ref) => ref.file?.endsWith('assignment-provider-state.json'))) process.exit(1);
NODE
pass "provider-confirmed ownership is retained as evidence and mirrored into a local runtime lease"
seed_pull_work provider:missing-provider
set +e
MISSING_PROVIDER="$(run_candidate start --artifact-root "$ARTIFACT_ROOT" --flow builder.build --work-item provider:missing-provider --summary "Missing provider fixture" 2>&1)"
MISSING_PROVIDER_RC=$?
set -e
[[ "$MISSING_PROVIDER_RC" -ne 0 && "$MISSING_PROVIDER" == *"requires --assignment-provider"* && ! -e "$ARTIFACT_ROOT/provider-missing-provider/state.json" ]] || fail "public start inferred an assignment provider or mutated before rejecting it"
pass "public start requires explicit assignment-provider resolution before mutation"
set +e
MISSING_PULL_WORK="$(run_candidate start --artifact-root "$ARTIFACT_ROOT" --flow builder.build --work-item acme/widgets#105 --assignment-provider local-file --summary "Missing selection evidence" 2>&1)"
MISSING_PULL_WORK_RC=$?
set -e
[[ "$MISSING_PULL_WORK_RC" -ne 0 && "$MISSING_PULL_WORK" == *"requires concrete pull-work selection evidence"* && ! -e "$ARTIFACT_ROOT/acme-widgets-105/state.json" ]] || fail "public start produced selected-work without a concrete pull-work report"
pass "public start requires session-local pull-work selection evidence before auto-producing selected-work"
run_candidate start --artifact-root "$ARTIFACT_ROOT" --flow builder.shape --task-slug shape-fixture --summary "Shape fixture" >/dev/null
SHAPE_SESSION="$ARTIFACT_ROOT/shape-fixture"
SHAPE_STATUS="$(run_candidate status --session-dir "$SHAPE_SESSION" --json)"
node -e 'const r=JSON.parse(process.argv[1]);if(r.definition_id!=="builder.shape"||r.current_step!=="shape")process.exit(1)' "$SHAPE_STATUS" || fail "shape status did not resolve canonical Flow run"
node - "$SHAPE_SESSION/work-item.json" <<'NODE'
const fs = require('node:fs');
const record = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (record.id !== 'shape-fixture' || record.source_provider?.kind !== 'local') process.exit(1);
NODE
run_candidate evidence --session-dir "$SHAPE_SESSION" --expectation shaped-problem --status not_verified --summary "Shape fixture remains intentionally unverified." --json >/dev/null
pass "shape starts as an explicit local Work Item and records public evidence through Flow"
SHAPE_RETRY_BEFORE="$(snapshot_tree "$ARTIFACT_ROOT/shape-fixture")"
set +e
SHAPE_TO_BUILD="$(run_candidate start --artifact-root "$ARTIFACT_ROOT" --flow builder.build --work-item local:shape-fixture --task-slug shape-fixture --assignment-provider local-file --summary "Invalid shape retry" 2>&1)"
SHAPE_TO_BUILD_RC=$?
set -e
SHAPE_RETRY_AFTER="$(snapshot_tree "$ARTIFACT_ROOT/shape-fixture")"
[[ "$SHAPE_TO_BUILD_RC" -ne 0 && "$SHAPE_TO_BUILD" == *"local shape sessions are not build retries"* && "$SHAPE_RETRY_BEFORE" == "$SHAPE_RETRY_AFTER" ]] || fail "public local shape-to-build retry did not fail clearly before mutation"
pass "public start rejects local shape-to-build retries; provider Work Items are the build handoff"
set +e
UNSAFE_START="$(run_candidate start --artifact-root "$ARTIFACT_ROOT" --flow builder.build --work-item acme/widgets#103 --assignment-provider local-file --skip-ownership-guard 2>&1)"
UNSAFE_START_RC=$?
set -e
[[ "$UNSAFE_START_RC" -ne 0 && "$UNSAFE_START" == *"does not support --skip-ownership-guard"* && ! -e "$ARTIFACT_ROOT/acme-widgets-103" ]] || fail "public start accepted an internal ownership bypass"
pass "public start rejects internal authority flags before mutation"

LOCAL_RETRY_PROJECT="$TMP/local-retry-project"
LOCAL_RETRY_ROOT="$LOCAL_RETRY_PROJECT/.kontourai/flow-agents"
mkdir -p "$LOCAL_RETRY_ROOT/local-retry"
printf 'Selected Work Item: local:local-retry\n' > "$LOCAL_RETRY_ROOT/local-retry/local-retry--pull-work.md"
printf 'not a run-store directory\n' >"$LOCAL_RETRY_PROJECT/.kontourai/flow"
set +e
(cd "$LOCAL_RETRY_PROJECT" && env -u CODEX_THREAD_ID CODEX_SESSION_ID=public-workflow-eval "$WORKFLOW_SIDECAR_BIN" ensure-session \
  --artifact-root "$LOCAL_RETRY_ROOT" --task-slug local-retry \
  --title "Local retry" --summary "Resume the bound local workflow." --flow-id builder.build >/dev/null 2>&1)
LOCAL_SEED_RC=$?
set -e
[[ "$LOCAL_SEED_RC" -eq 0 && ! -e "$LOCAL_RETRY_PROJECT/.kontourai/flow/runs/local-retry/state.json" ]] || fail "private writer advanced canonical Flow instead of only seeding the public retry"
pass "private workflow writer cannot start or advance canonical Flow"
LOCAL_RETRY_COMMAND="$(node -p "JSON.parse(require('fs').readFileSync('$LOCAL_RETRY_ROOT/local-retry/state.json')).next_action.command")"
[[ "$LOCAL_RETRY_COMMAND" == *"'--work-item' 'local:local-retry'"* && "$LOCAL_RETRY_COMMAND" == *"'--task-slug' 'local-retry'"* && "$LOCAL_RETRY_COMMAND" == *"'--artifact-root' '$LOCAL_RETRY_ROOT'"* ]] || fail "emitted local retry did not bind its Work Item, slug, and originating artifact root"
rm -f "$LOCAL_RETRY_PROJECT/.kontourai/flow"
FOREIGN_RETRY_CWD="$TMP/foreign-retry-cwd"
mkdir -p "$FOREIGN_RETRY_CWD"
EXECUTABLE_RETRY="$(node -e 'process.stdout.write(process.argv[1].replace(process.argv[2], process.argv[3]))' "$LOCAL_RETRY_COMMAND" "'@kontourai/flow-agents@$VERSION'" "'file:$TARBALL'")"
(cd "$FOREIGN_RETRY_CWD" && unset CODEX_THREAD_ID && export CODEX_SESSION_ID=public-workflow-eval && eval "$EXECUTABLE_RETRY" >/dev/null)
[[ -f "$LOCAL_RETRY_PROJECT/.kontourai/flow/runs/local-retry/state.json" && ! -e "$FOREIGN_RETRY_CWD/.kontourai" ]] || fail "emitted local retry mutated the caller cwd instead of the originating store"
pass "emitted local retry executes from a foreign cwd against its exact originating store"

BEFORE_STATUS="$(snapshot_tree "$CONSUMER/.kontourai")"
STATUS_JSON="$(run_candidate status --session-dir "$RELEASE_SESSION" --json)"
AFTER_STATUS="$(snapshot_tree "$CONSUMER/.kontourai")"
[[ "$BEFORE_STATUS" == "$AFTER_STATUS" ]] || fail "workflow status mutated durable artifacts"
node -e 'const r=JSON.parse(process.argv[1]); if(r.definition_id!=="builder.build"||r.current_step!=="design-probe")process.exit(1)' "$STATUS_JSON" || fail "status did not report canonical run"
pass "status is canonical and byte-read-only"

FLOW_MANIFEST="$CONSUMER/.kontourai/flow/runs/acme-widgets-101/evidence/manifest.json"
BEFORE_EVIDENCE="$(node -p "JSON.parse(require('fs').readFileSync('$FLOW_MANIFEST')).evidence.length")"
PARTIAL_EVIDENCE="$(run_candidate evidence --session-dir "$RELEASE_SESSION" --expectation pickup-probe-readiness --status not_verified --summary "Consumer fixture intentionally leaves this claim unverified." --json)"
AFTER_EVIDENCE="$(node -p "JSON.parse(require('fs').readFileSync('$FLOW_MANIFEST')).evidence.length")"
[[ "$AFTER_EVIDENCE" -eq "$BEFORE_EVIDENCE" ]] || fail "partial evidence changed the canonical manifest"
node -e 'const r=JSON.parse(process.argv[1]);if(r.attached!==false||r.awaiting_evidence!==true||r.current_step!=="design-probe")process.exit(1)' "$PARTIAL_EVIDENCE" || fail "partial evidence did not report an explicit awaiting-evidence result"
pass "partial evidence records locally without evaluation or canonical attachment"

PULL_REPORT="$RELEASE_SESSION/$(basename "$RELEASE_SESSION")--pull-work.md"
PULL_REPORT_REF="{\"kind\":\"artifact\",\"file\":\"$PULL_REPORT\",\"summary\":\"Concrete selected-work and probe report.\"}"
READINESS_PARTIAL="$(run_candidate evidence --session-dir "$RELEASE_SESSION" --expectation pickup-probe-readiness --status pass --summary "Complete the consumer readiness expectation after exercising NOT_VERIFIED." --evidence-ref-json "$PULL_REPORT_REF" --json)"
node -e 'const r=JSON.parse(process.argv[1]);if(r.attached!==false||r.awaiting_evidence!==true||r.current_step!=="design-probe")process.exit(1)' "$READINESS_PARTIAL" || fail "first passing member of a multi-expectation gate did not remain pending"
PROBE_COMPLETE="$(run_candidate evidence --session-dir "$RELEASE_SESSION" --expectation probe-decisions-or-accepted-gaps --status pass --summary "Complete the consumer probe gate." --evidence-ref-json "$PULL_REPORT_REF" --json)"
node -e 'const r=JSON.parse(process.argv[1]);if(r.attached!==true||r.awaiting_evidence!==false||r.current_step!=="plan")process.exit(1)' "$PROBE_COMPLETE" || fail "complete multi-expectation gate did not attach and advance exactly once"
AFTER_COMPLETE_EVIDENCE="$(node -p "JSON.parse(require('fs').readFileSync('$FLOW_MANIFEST')).evidence.length")"
[[ "$AFTER_COMPLETE_EVIDENCE" -eq $((BEFORE_EVIDENCE + 1)) ]] || fail "complete multi-expectation gate did not attach exactly once"
pass "multi-expectation evidence attaches atomically only when complete"
seed_pull_work acme/widgets#104
run_candidate_as poison-pointer start --artifact-root "$ARTIFACT_ROOT" --flow builder.build --work-item acme/widgets#104 --assignment-provider local-file --summary "Poison global pointer fixture" >/dev/null
node - "$ARTIFACT_ROOT" "$(basename "$RELEASE_SESSION")" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [root, releaseSlug] = process.argv.slice(2);
const actorRoot = path.join(root, 'current');
for (const name of fs.readdirSync(actorRoot)) {
  if (!name.endsWith('.json')) continue;
  const file = path.join(actorRoot, name);
  const pointer = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (pointer.active_slug !== releaseSlug) continue;
  pointer.active_slug = 'acme-widgets-104';
  pointer.artifact_dir = 'acme-widgets-104';
  pointer.active_step_id = 'design-probe';
  fs.writeFileSync(file, `${JSON.stringify(pointer, null, 2)}\n`);
}
NODE
PLAN_REPORT="$RELEASE_SESSION/$(basename "$RELEASE_SESSION")--plan-work.md"
printf '# Plan Work\n\nReviewed fixture plan and acceptance mapping.\n' > "$PLAN_REPORT"
PLAN_REPORT_REF="{\"kind\":\"artifact\",\"file\":\"$PLAN_REPORT\",\"summary\":\"Reviewed implementation plan.\"}"
EXACT_SESSION_RESULT="$(run_candidate evidence --session-dir "$RELEASE_SESSION" --expectation implementation-plan --status pass --summary "Exact session binding must ignore the poisoned global pointer." --evidence-ref-json "$PLAN_REPORT_REF" --json)"
node -e 'const r=JSON.parse(process.argv[1]);if(r.current_step!=="execute"||!String(r.next_action?.summary).includes("`execute`"))process.exit(1)' "$EXACT_SESSION_RESULT" || fail "public evidence followed a poisoned global pointer or returned a stale next action"
pass "evidence binds the exact session and returns the locked post-transition next action"
set +e
UNRELATED_EVIDENCE="$(run_candidate_as unrelated-caller evidence --session-dir "$RELEASE_SESSION" --expectation implementation-scope --status pass --summary rejected 2>&1)"
UNRELATED_EVIDENCE_RC=$?
set -e
[[ "$UNRELATED_EVIDENCE_RC" -ne 0 && "$UNRELATED_EVIDENCE" == *"active, matching assignment actor"* ]] || fail "public evidence allowed a non-holder to impersonate the assignment actor"
pass "evidence rejects callers that do not match the exact session assignment"

STALE_STATE="$TMP/stale-state.json"
cp "$RELEASE_SESSION/state.json" "$STALE_STATE"
node - "$RELEASE_SESSION/state.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
state.flow_run.current_step = 'pull-work';
state.next_action = { status: 'continue', summary: 'tampered projection' };
fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
NODE
DELIVER_REPORT="$RELEASE_SESSION/$(basename "$RELEASE_SESSION")--deliver.md"
DELIVER_REPORT_REF="{\"kind\":\"artifact\",\"file\":\"$DELIVER_REPORT\",\"summary\":\"Executed implementation scope report.\"}"
REPAIRED_EVIDENCE_RESULT="$(run_candidate evidence --session-dir "$RELEASE_SESSION" --expectation implementation-scope --status pass --summary "Repair stale projection before evidence." --evidence-ref-json "$DELIVER_REPORT_REF" --json)"
node -e 'const r=JSON.parse(process.argv[1]);if(r.current_step!=="verify"||!String(r.next_action?.summary).includes("`verify`"))process.exit(1)' "$REPAIRED_EVIDENCE_RESULT" || fail "evidence did not return its locked post-transition report"
pass "evidence returns immutable postconditions captured while the subject lock is held"
FAILED_ROUTE_RESULT="$(run_candidate evidence --session-dir "$RELEASE_SESSION" --expectation tests-evidence --status fail --route-reason implementation_defect --summary "Failing fixture routes back to execution." --command false --json)"
node -e 'const r=JSON.parse(process.argv[1]);if(r.current_step!=="execute"||!String(r.next_action?.summary).includes("implementation_defect"))process.exit(1)' "$FAILED_ROUTE_RESULT" || fail "failed command evidence did not select the declared canonical route-back"
REENTER_VERIFY_RESULT="$(run_candidate evidence --session-dir "$RELEASE_SESSION" --expectation implementation-scope --status pass --summary "Corrected implementation re-enters verification." --evidence-ref-json "$DELIVER_REPORT_REF" --json)"
node -e 'const r=JSON.parse(process.argv[1]);if(r.current_step!=="verify")process.exit(1)' "$REENTER_VERIFY_RESULT" || fail "corrected implementation did not re-enter verification"
pass "public evidence records failing command observations and declared route-back reasons"
set +e
MISSING_TEST_COMMAND="$(run_candidate evidence --session-dir "$RELEASE_SESSION" --expectation tests-evidence --status pass --summary "Missing runnable test command." 2>&1)"
MISSING_TEST_COMMAND_RC=$?
FAILED_TEST_COMMAND="$(run_candidate evidence --session-dir "$RELEASE_SESSION" --expectation tests-evidence --status pass --summary "Failing test command." --command 'false' 2>&1)"
FAILED_TEST_COMMAND_RC=$?
VERSION_TEST_COMMAND="$(run_candidate evidence --session-dir "$RELEASE_SESSION" --expectation tests-evidence --status pass --summary "Version-only test command." --command 'node --version' 2>&1)"
VERSION_TEST_COMMAND_RC=$?
set -e
[[ "$MISSING_TEST_COMMAND_RC" -ne 0 && "$MISSING_TEST_COMMAND" == *"--command"* && "$FAILED_TEST_COMMAND_RC" -ne 0 && "$FAILED_TEST_COMMAND" == *"non-vacuous package script"* && "$VERSION_TEST_COMMAND_RC" -ne 0 && "$VERSION_TEST_COMMAND" == *"non-vacuous package script"* ]] || fail "tests-evidence did not require a real passing fixture assertion"
REJECTED_COMMAND_MARKER="$TMP/rejected-command-marker"
cp "$RELEASE_SESSION/state.json" "$TMP/rejected-command-state.clean.json"
node - "$RELEASE_SESSION/state.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
state.flow_run.current_step = 'pull-work';
state.next_action = { status: 'continue', summary: 'stale projection must remain untouched on rejection' };
fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
NODE
REJECTED_COMMAND_BEFORE="$(snapshot_tree "$RELEASE_SESSION")"
set +e
REJECTED_COMMAND="$(run_candidate evidence --session-dir "$RELEASE_SESSION" --expectation tests-evidence --status pass --summary "Rejected prose command must not run." --command "This prose command is invalid; touch '$REJECTED_COMMAND_MARKER'" 2>&1)"
REJECTED_COMMAND_RC=$?
set -e
REJECTED_COMMAND_AFTER="$(snapshot_tree "$RELEASE_SESSION")"
[[ "$REJECTED_COMMAND_RC" -ne 0 && "$REJECTED_COMMAND" == *"not a runnable shell command"* && ! -e "$REJECTED_COMMAND_MARKER" && "$REJECTED_COMMAND_BEFORE" == "$REJECTED_COMMAND_AFTER" ]] || fail "rejected evidence command executed or mutated durable artifacts"
mv "$TMP/rejected-command-state.clean.json" "$RELEASE_SESSION/state.json"
pass "rejected evidence commands have no process or durable-artifact side effects"
BEFORE_CRITIQUE_MANIFEST="$(shasum -a 256 "$FLOW_MANIFEST" | awk '{print $1}')"
BEFORE_CRITIQUE_BUNDLE="$(shasum -a 256 "$RELEASE_SESSION/trust.bundle" | awk '{print $1}')"
CODE_LANE="{\"id\":\"code\",\"status\":\"pass\",\"summary\":\"Code review covered the planned implementation.\",\"evidence_refs\":[{\"kind\":\"artifact\",\"file\":\"$PLAN_REPORT\",\"summary\":\"Reviewed implementation plan.\"}]}"
SECURITY_LANE="{\"id\":\"security\",\"status\":\"pass\",\"summary\":\"Security review covered the delivered scope.\",\"evidence_refs\":[{\"kind\":\"artifact\",\"file\":\"$DELIVER_REPORT\",\"summary\":\"Reviewed delivered scope.\"}]}"
set +e
SAME_ACTOR_CRITIQUE="$(run_candidate critique --session-dir "$RELEASE_SESSION" --id public-review --verdict pass --summary "Implementation actor cannot review its own work." --artifact-ref "$DELIVER_REPORT" --lane-json "$CODE_LANE" --lane-json "$SECURITY_LANE" 2>&1)"
SAME_ACTOR_CRITIQUE_RC=$?
set -e
[[ "$SAME_ACTOR_CRITIQUE_RC" -ne 0 && "$SAME_ACTOR_CRITIQUE" == *"reviewer identity distinct"* ]] || fail "public critique allowed the active implementation actor to self-review"
run_candidate_as public-reviewer critique --session-dir "$RELEASE_SESSION" --id public-review --verdict pass --summary "Public critique fixture." --artifact-ref "$DELIVER_REPORT" --lane-json "$CODE_LANE" --lane-json "$SECURITY_LANE" --json >/dev/null
AFTER_CRITIQUE_MANIFEST="$(shasum -a 256 "$FLOW_MANIFEST" | awk '{print $1}')"
AFTER_CRITIQUE_BUNDLE="$(shasum -a 256 "$RELEASE_SESSION/trust.bundle" | awk '{print $1}')"
[[ "$BEFORE_CRITIQUE_MANIFEST" == "$AFTER_CRITIQUE_MANIFEST" && "$BEFORE_CRITIQUE_BUNDLE" != "$AFTER_CRITIQUE_BUNDLE" ]] || fail "public critique attached to Flow or did not change trust.bundle"
pass "critique requires an active assignment but rejects self-review by its implementation actor"
CRITERION_ID="$(node -p "JSON.parse(require('fs').readFileSync('$RELEASE_SESSION/acceptance.json')).criteria[0].id")"
TEST_COMMAND="bash checks/check-public-workflow.sh .kontourai/flow-agents/$(basename "$RELEASE_SESSION")/state.json"
MULTI_COMMAND_ONE="$TMP/multi-command-one"
MULTI_COMMAND_TWO="$TMP/multi-command-two"
TEST_COMMAND_TWO="bash checks/check-multi-command.sh .kontourai/flow-agents/$(basename "$RELEASE_SESSION")/state.json '$MULTI_COMMAND_ONE'"
TEST_COMMAND_THREE="bash checks/check-multi-command.sh .kontourai/flow-agents/$(basename "$RELEASE_SESSION")/state.json '$MULTI_COMMAND_TWO'"
CRITERION_JSON="$(node - "$CRITERION_ID" "$TEST_COMMAND" "$TEST_COMMAND_TWO" "$TEST_COMMAND_THREE" <<'NODE'
const [id, ...commands] = process.argv.slice(2);
process.stdout.write(JSON.stringify({ id, status: 'pass', evidence_refs: commands.map((excerpt) => ({ kind: 'command', excerpt, summary: 'Asserts the bound session state exists.' })) }));
NODE
)"
COMMAND_REF="$(node - "$TEST_COMMAND" <<'NODE'
const command = process.argv[2];
process.stdout.write(JSON.stringify({ kind: 'command', excerpt: command, summary: 'Exact project-local public workflow check.' }));
NODE
)"
COMMAND_REF_TWO="$(node - "$TEST_COMMAND_TWO" <<'NODE'
const command = process.argv[2];
process.stdout.write(JSON.stringify({ kind: 'command', excerpt: command, summary: 'Exact first additional project-local check.' }));
NODE
)"
COMMAND_REF_THREE="$(node - "$TEST_COMMAND_THREE" <<'NODE'
const command = process.argv[2];
process.stdout.write(JSON.stringify({ kind: 'command', excerpt: command, summary: 'Exact second additional project-local check.' }));
NODE
)"
run_candidate evidence --session-dir "$RELEASE_SESSION" --expectation tests-evidence --status pass --summary "Passing fixture assertion." --command "$TEST_COMMAND" --command "$TEST_COMMAND_TWO" --command "$TEST_COMMAND_THREE" --evidence-ref-json "$COMMAND_REF" --evidence-ref-json "$COMMAND_REF_TWO" --evidence-ref-json "$COMMAND_REF_THREE" --criterion-json "$CRITERION_JSON" --json >/dev/null
node - "$RELEASE_SESSION/trust.bundle" <<'NODE'
const fs = require('node:fs');
const bundle = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const claim = bundle.claims.find((entry) => entry.metadata?.gate_claim?.expectation_id === 'tests-evidence');
if (!claim || claim.metadata?.output_digest?.algorithm !== 'sha256' || typeof claim.metadata.output_digest.hex !== 'string' || claim.metadata?.observed_commands?.length !== 3) process.exit(1);
NODE
[[ "$(wc -l < "$MULTI_COMMAND_ONE" | tr -d ' ')" == 1 && "$(wc -l < "$MULTI_COMMAND_TWO" | tr -d ' ')" == 1 ]] || fail "public evidence did not execute every repeated --command exactly once"
pass "tests-evidence executes every repeated command once and records matching observations"

ASSIGNMENT="$ARTIFACT_ROOT/assignment/$(basename "$RELEASE_SESSION").json"
ASSIGNMENT_TARGET="$TMP/assignment-target.json"
cp "$ASSIGNMENT" "$ASSIGNMENT_TARGET"
rm "$ASSIGNMENT"
ln -s "$ASSIGNMENT_TARGET" "$ASSIGNMENT"
set +e
SYMLINK_ASSIGNMENT="$(run_candidate critique --session-dir "$RELEASE_SESSION" --summary "Rejected assignment symlink." 2>&1)"
SYMLINK_ASSIGNMENT_RC=$?
set -e
rm "$ASSIGNMENT"
mv "$ASSIGNMENT_TARGET" "$ASSIGNMENT"
[[ "$SYMLINK_ASSIGNMENT_RC" -ne 0 && "$SYMLINK_ASSIGNMENT" == *"assignment must be a non-symlink regular file"* ]] || fail "public critique followed a symlinked assignment"
pass "public assignment readers reject symlinked assignment files"
node - "$RELEASE_SESSION/trust.bundle" "$RELEASE_SESSION" <<'NODE'
const fs = require('node:fs');
const [bundleFile, session] = process.argv.slice(2);
const bundle = JSON.parse(fs.readFileSync(bundleFile, 'utf8'));
const critique = bundle.claims.find((claim) => claim.metadata?.origin === 'critique');
if (!critique || critique.claimType !== 'workflow.critique.review' || critique.metadata?.lanes?.length !== 2 || fs.existsSync(`${session}/critique.json`) || fs.existsSync(`${session}/evidence.json`)) process.exit(1);
NODE
pass "public critique is report-only, forwards lanes, and writes only to trust.bundle"

cp "$RELEASE_SESSION/state.json" "$TMP/release-state.clean.json"
node - "$RELEASE_SESSION/state.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
state.task_slug = '../outside';
fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
NODE
set +e
TAMPERED_SLUG="$(run_candidate evidence --session-dir "$RELEASE_SESSION" --expectation policy-compliance --status not_verified --summary rejected 2>&1)"
TAMPERED_SLUG_RC=$?
set -e
mv "$TMP/release-state.clean.json" "$RELEASE_SESSION/state.json"
[[ "$TAMPERED_SLUG_RC" -ne 0 && "$TAMPERED_SLUG" == *"task_slug must exactly match"* ]] || fail "public evidence accepted a tampered task slug"
pass "public evidence rejects a mismatched or traversal task slug before assignment lookup"

OUTSIDE="$TMP/outside-session"
mkdir -p "$OUTSIDE"
printf '{"schema_version":"1.0","task_slug":"outside"}\n' >"$OUTSIDE/state.json"
ln -s "$OUTSIDE" "$ARTIFACT_ROOT/symlink-session"
OUTSIDE_BEFORE="$(snapshot_tree "$OUTSIDE")"
set +e
SYMLINK_EVIDENCE="$(run_candidate evidence --session-dir "$ARTIFACT_ROOT/symlink-session" --expectation pickup-probe-readiness --status not_verified --summary rejected 2>&1)"
SYMLINK_RC=$?
set -e
[[ "$SYMLINK_RC" -ne 0 && "$SYMLINK_EVIDENCE" == *"session directory must be a non-symlink directory"* && "$(snapshot_tree "$OUTSIDE")" == "$OUTSIDE_BEFORE" ]] || fail "evidence followed a symlinked session"
pass "evidence rejects symlinked session paths before mutation"

run_candidate pause --session-dir "$RELEASE_SESSION" --reason "consumer pause" >/dev/null
run_candidate resume --session-dir "$RELEASE_SESSION" --reason "consumer resume" >/dev/null
run_candidate release --session-dir "$RELEASE_SESSION" --reason "consumer release" >/dev/null
node -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync(process.argv[1]));if(r.status!=="released")process.exit(1)' "$ARTIFACT_ROOT/assignment/acme-widgets-101.json" || fail "release did not release assignment"
pass "pause, resume, and release use the public command"

seed_pull_work acme/widgets#102
run_candidate start --artifact-root "$ARTIFACT_ROOT" --flow builder.build --work-item acme/widgets#102 --assignment-provider local-file --summary "Cancel fixture" >/dev/null
CANCEL_SESSION="$ARTIFACT_ROOT/acme-widgets-102"
node --input-type=module - "$CONSUMER" "$CANCEL_SESSION" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
const [project, session] = process.argv.slice(2);
const slug = path.basename(session);
const assignment = JSON.parse(fs.readFileSync(path.join(project, '.kontourai', 'flow-agents', 'assignment', `${slug}.json`), 'utf8'));
const state = JSON.parse(fs.readFileSync(path.join(session, 'state.json'), 'utf8'));
const keys = generateKeyPairSync('ed25519');
fs.mkdirSync(path.join(project, '.flow-agents'), { recursive: true });
fs.writeFileSync(path.join(project, '.flow-agents', 'lifecycle-authority-keys.json'), JSON.stringify({ schema_version: '1.0', keys: [{ id: 'consumer', algorithm: 'ed25519', public_key_pem: keys.publicKey.export({ type: 'spki', format: 'pem' }) }] }, null, 2));
for (const operation of ['cancel', 'archive']) {
  const requestedAt = new Date();
  const unsigned = {
    schema_version: '1.0', operation, run_id: slug, subject: state.work_item_refs[0],
    assignment_actor_key: assignment.actor_key,
    assignment_actor: { ...assignment.actor, human: assignment.actor.human ?? null },
    nonce: `consumer-${operation}`,
    expires_at: new Date(requestedAt.getTime() + 3600000).toISOString(),
    request: { reason: `consumer ${operation}`, authority: { kind: 'user_request', actor: 'consumer-user', request_ref: `fixture://consumer/${operation}`, requested_at: requestedAt.toISOString() } },
  };
  const authorization = { ...unsigned, signature: { algorithm: 'ed25519', key_id: 'consumer', value: sign(null, Buffer.from(JSON.stringify(unsigned)), keys.privateKey).toString('base64') } };
  fs.writeFileSync(path.join(project, `${operation}.authorization.json`), JSON.stringify(authorization, null, 2));
}
NODE
run_candidate cancel --session-dir "$CANCEL_SESSION" --authorization-file "$CONSUMER/cancel.authorization.json" >/dev/null
run_candidate archive --session-dir "$CANCEL_SESSION" --authorization-file "$CONSUMER/archive.authorization.json" >/dev/null
[[ -f "$ARTIFACT_ROOT/archive/acme-widgets-102/state.json" && ! -e "$CANCEL_SESSION" ]] || fail "cancel/archive did not retain archived session"
pass "signed cancel and archive execute through the public command"

seed_pull_work acme/widgets#106
run_candidate start --artifact-root "$ARTIFACT_ROOT" --flow builder.build --work-item acme/widgets#106 --assignment-provider local-file --summary "Command authority lock fixture" >/dev/null
LOCK_SESSION="$ARTIFACT_ROOT/acme-widgets-106"
LOCK_PULL_REPORT="$LOCK_SESSION/$(basename "$LOCK_SESSION")--pull-work.md"
LOCK_PULL_REF="{\"kind\":\"artifact\",\"file\":\"$LOCK_PULL_REPORT\",\"summary\":\"Lock fixture selected work report.\"}"
run_candidate evidence --session-dir "$LOCK_SESSION" --expectation pickup-probe-readiness --status pass --summary "Complete lock fixture probe." --evidence-ref-json "$LOCK_PULL_REF" --json >/dev/null
run_candidate evidence --session-dir "$LOCK_SESSION" --expectation probe-decisions-or-accepted-gaps --status pass --summary "Complete lock fixture decisions." --evidence-ref-json "$LOCK_PULL_REF" --json >/dev/null
LOCK_PLAN_REPORT="$LOCK_SESSION/$(basename "$LOCK_SESSION")--plan-work.md"
printf '# Lock Plan\n' > "$LOCK_PLAN_REPORT"
LOCK_PLAN_REF="{\"kind\":\"artifact\",\"file\":\"$LOCK_PLAN_REPORT\",\"summary\":\"Lock fixture plan.\"}"
run_candidate evidence --session-dir "$LOCK_SESSION" --expectation implementation-plan --status pass --summary "Complete lock fixture plan." --evidence-ref-json "$LOCK_PLAN_REF" --json >/dev/null
LOCK_DELIVER_REPORT="$LOCK_SESSION/$(basename "$LOCK_SESSION")--deliver.md"
LOCK_DELIVER_REF="{\"kind\":\"artifact\",\"file\":\"$LOCK_DELIVER_REPORT\",\"summary\":\"Lock fixture execution report.\"}"
LOCK_STARTED="$TMP/command-lock.started"
LOCK_COMMAND="bash checks/check-command-lock.sh '$LOCK_STARTED'"
run_candidate evidence --session-dir "$LOCK_SESSION" --expectation implementation-scope --status pass --summary "Long command retains authority lock." --evidence-ref-json "$LOCK_DELIVER_REF" --command "$LOCK_COMMAND" --json >"$TMP/command-lock-evidence.out" 2>&1 &
LOCK_EVIDENCE_PID=$!
for _ in $(seq 1 250); do [[ -f "$LOCK_STARTED" ]] && break; sleep 0.02; done
[[ -f "$LOCK_STARTED" ]] || fail "authority-lock fixture command did not start"
run_candidate release --session-dir "$LOCK_SESSION" --reason "release must wait for the observed command" >"$TMP/command-lock-release.out" 2>&1 &
LOCK_RELEASE_PID=$!
sleep 0.1
kill -0 "$LOCK_RELEASE_PID" 2>/dev/null || fail "lifecycle release bypassed the running command lock"
node -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync(process.argv[1]));if(r.status!=="claimed")process.exit(1)' "$ARTIFACT_ROOT/assignment/acme-widgets-106.json" || fail "assignment changed before the locked command completed"
wait "$LOCK_EVIDENCE_PID" || fail "locked evidence command failed"
wait "$LOCK_RELEASE_PID" || fail "blocked release failed after command completion"
node -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync(process.argv[1]));if(r.status!=="released")process.exit(1)' "$ARTIFACT_ROOT/assignment/acme-widgets-106.json" || fail "release did not complete after the command lock was released"
pass "authority-bound commands retain the subject lock through lifecycle release"

seed_pull_work acme/widgets#107
run_candidate start --artifact-root "$ARTIFACT_ROOT" --flow builder.build --work-item acme/widgets#107 --assignment-provider local-file --summary "Process group timeout fixture" >/dev/null
TIMEOUT_SESSION="$ARTIFACT_ROOT/acme-widgets-107"
TIMEOUT_CHILD_PID="$TMP/command-timeout-child.pid"
TIMEOUT_MARKER="$TMP/command-timeout-marker"
set +e
(cd "$CONSUMER" && env -u CODEX_THREAD_ID CODEX_SESSION_ID=public-workflow-eval FLOW_AGENTS_EVIDENCE_COMMAND_TIMEOUT_MS=1000 FLOW_AGENTS_EVIDENCE_COMMAND_KILL_GRACE_MS=250 "$FLOW_AGENTS_BIN" workflow evidence --session-dir "$TIMEOUT_SESSION" --expectation pickup-probe-readiness --status not_verified --summary "Timeout fixture captures full process-group termination." --command "bash checks/check-command-timeout.sh '$TIMEOUT_CHILD_PID' '$TIMEOUT_MARKER'" --json) >"$TMP/command-timeout.out" 2>&1
TIMEOUT_RC=$?
set -e
[[ "$TIMEOUT_RC" -ne 0 && -s "$TIMEOUT_CHILD_PID" && ! -e "$TIMEOUT_MARKER" ]] || fail "timed-out evidence command did not complete its controlled capture"
TIMEOUT_CHILD="$(cat "$TIMEOUT_CHILD_PID")"
kill -0 "$TIMEOUT_CHILD" 2>/dev/null && fail "timed-out evidence command left a child process running"
pass "timed-out evidence commands terminate their complete process group"

BACKGROUND_CHILD_PID="$TMP/success-background-child.pid"
BACKGROUND_MARKER="$TMP/success-background-marker"
TIMEOUT_PULL_REPORT="$TIMEOUT_SESSION/$(basename "$TIMEOUT_SESSION")--pull-work.md"
(cd "$CONSUMER" && env -u CODEX_THREAD_ID CODEX_SESSION_ID=public-workflow-eval FLOW_AGENTS_EVIDENCE_COMMAND_KILL_GRACE_MS=50 "$FLOW_AGENTS_BIN" workflow evidence \
  --session-dir "$TIMEOUT_SESSION" --expectation pickup-probe-readiness --status pass \
  --summary "Successful evidence cleans up surviving background processes." \
  --command "bash checks/check-success-background.sh '$BACKGROUND_CHILD_PID' '$BACKGROUND_MARKER'" \
  --evidence-ref-json "{\"kind\":\"artifact\",\"file\":\"$TIMEOUT_PULL_REPORT\",\"summary\":\"Selected work for background cleanup fixture.\"}" --json >/dev/null)
[[ -s "$BACKGROUND_CHILD_PID" && ! -e "$BACKGROUND_MARKER" ]] || fail "successful evidence command did not expose a surviving background child"
BACKGROUND_CHILD="$(cat "$BACKGROUND_CHILD_PID")"
kill -0 "$BACKGROUND_CHILD" 2>/dev/null && fail "successful evidence command left a background process running"
pass "successful evidence commands terminate surviving process-group children before recording"

DOCTOR="$TMP/doctor-consumer"
mkdir -p "$DOCTOR/node_modules/@kontourai/flow-agents" "$DOCTOR/node_modules/.bin" "$DOCTOR/.flow-agents" "$DOCTOR/kits/builder/flows" "$DOCTOR/.kontourai/flow-agents/doctor-session"
cat >"$DOCTOR/node_modules/@kontourai/flow-agents/package.json" <<'JSON'
{"name":"@kontourai/flow-agents","version":"3.4.3","bin":{"flow-agents":"bin.js"}}
JSON
cat >"$DOCTOR/node_modules/.bin/flow-agents" <<'SH'
#!/usr/bin/env bash
echo STALE_LOCAL_BINARY
SH
chmod +x "$DOCTOR/node_modules/.bin/flow-agents"
cat >"$DOCTOR/.flow-agents/install.json" <<'JSON'
{"version":"3.4.3","runtime":"codex","active_kit_ids":["builder"]}
JSON
cat >"$DOCTOR/kits/builder/kit.json" <<'JSON'
{"schema_version":"0.9","id":"builder"}
JSON
cat >"$DOCTOR/kits/builder/flows/build.flow.json" <<'JSON'
{"id":"builder.build","version":"0.9"}
JSON
cat >"$DOCTOR/.kontourai/flow-agents/current.json" <<'JSON'
{"active_slug":"doctor-session","artifact_dir":"doctor-session"}
JSON
cat >"$DOCTOR/.kontourai/flow-agents/doctor-session/state.json" <<'JSON'
{"schema_version":"0.9","task_slug":"doctor-session","flow_run":{"definition_id":"builder.build","definition_version":"0.9"}}
JSON
cat >"$DOCTOR/.kontourai/flow-agents/doctor-session/trust.bundle" <<'JSON'
{"schema_version":"0.9"}
JSON
set +e
DOCTOR_JSON="$(cd "$DOCTOR" && npx --yes --package="file:$TARBALL" flow-agents workflow doctor --project-root "$DOCTOR" --artifact-root "$DOCTOR/.kontourai/flow-agents" --json 2>/dev/null)"
DOCTOR_RC=$?
set -e
[[ "$DOCTOR_RC" -eq 2 ]] || fail "doctor should return 2 for incompatible consumer fixtures"
node - "$DOCTOR_JSON" "$VERSION" "$DOCTOR" <<'NODE'
const [reportText, version, root] = process.argv.slice(2);
const report = JSON.parse(reportText);
if (report.cli.version !== version || report.cli.workflow_contract_version !== '1.0') process.exit(1);
if (report.local_dependency.version !== '3.4.3' || report.local_dependency.selected !== false) process.exit(2);
if (!report.warnings.some((w) => w.includes('hook/writer version 3.4.3'))) process.exit(3);
if (!report.warnings.some((w) => w.includes('Builder Kit'))) process.exit(4);
if (!report.warnings.some((w) => w.includes('builder.build version 0.9'))) process.exit(5);
if (!report.warnings.some((w) => w.includes('Artifact schema 0.9'))) process.exit(6);
if (!report.warnings.some((w) => w.includes('Trust bundle schema 0.9'))) process.exit(7);
if (!report.warnings.some((w) => w.includes('hook/writer assets failed integrity'))) process.exit(10);
if (!report.remediation.startsWith('sh -c ') || !report.remediation.includes(`'@kontourai/flow-agents@${version}'`) || !report.remediation.includes("'--runtime' 'codex'") || !report.remediation.includes("'--activate-kit' 'builder'")) process.exit(8);
if (report.cli.package_root.startsWith(root)) process.exit(9);
NODE
pass "doctor detects same-major hook/writer, Kit, Flow, and schema skew with exact remediation"
[[ "$DOCTOR_JSON" != *"STALE_LOCAL_BINARY"* ]] || fail "explicit package invocation selected stale local binary"
pass "explicit packed package wins over an old local dependency"

node - "$DOCTOR/node_modules/@kontourai/flow-agents/package.json" "$VERSION" <<'NODE'
const fs = require('node:fs');
const [file, version] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
value.version = version;
fs.writeFileSync(file, JSON.stringify(value));
NODE
SAME_VERSION_HELP="$(cd "$DOCTOR" && npx --yes --package="file:$TARBALL" flow-agents --help)"
[[ "$SAME_VERSION_HELP" == *"workflow"* && "$SAME_VERSION_HELP" != *"STALE_LOCAL_BINARY"* ]] || fail "explicit tarball selected a hostile same-version local binary"
pass "explicit tarball wins over a hostile same-version local binary"

PINNED_COMMAND_MODULE="pinned-cli-command.js"
ISOLATED_COMMAND="$(node --input-type=module - "$ROOT_DIR/build/src/lib/$PINNED_COMMAND_MODULE" "file:$TARBALL" <<'NODE'
import { pathToFileURL } from 'node:url';
const [modulePath, packageSpec] = process.argv.slice(2);
const { isolatedPackageCommand } = await import(pathToFileURL(modulePath));
console.log(isolatedPackageCommand(packageSpec, 'flow-agents', ['--help']));
NODE
)"
ISOLATED_HELP="$(cd "$DOCTOR" && eval "$ISOLATED_COMMAND")"
[[ "$ISOLATED_HELP" == *"workflow"* && "$ISOLATED_HELP" != *"STALE_LOCAL_BINARY"* ]] || fail "isolated package command selected a hostile same-version local binary"
pass "generated isolated package command defeats a hostile same-version local binary"

rm -f "$DOCTOR/kits/builder/kit.json" "$DOCTOR/kits/builder/flows/build.flow.json"
printf '{"version":"%s","runtime":"codex","active_kit_ids":["builder"]}\n' "$VERSION" >"$DOCTOR/.flow-agents/install.json"
set +e
MISSING_JSON="$(cd "$DOCTOR" && "$FLOW_AGENTS_BIN" workflow doctor --project-root "$DOCTOR" --artifact-root "$DOCTOR/.kontourai/flow-agents" --json 2>/dev/null)"
MISSING_RC=$?
set -e
[[ "$MISSING_RC" -eq 2 ]] || fail "doctor should fail when an activated Kit is missing"
node -e 'const r=JSON.parse(process.argv[1]);if(!r.warnings.some(w=>w.includes("Activated Builder Kit is missing"))||!r.warnings.some(w=>w.includes("Activated builder.build definition is missing"))||!r.warnings.some(w=>w.includes("Activated builder.shape definition is missing")))process.exit(1)' "$MISSING_JSON" || fail "doctor did not report both missing activated Builder definitions"
pass "doctor fails closed for missing activated Kit components"

HEALTHY="$TMP/healthy-install"
mkdir -p "$HEALTHY"
(cd "$HEALTHY" && "$FLOW_AGENTS_BIN" init --runtime codex --dest "$HEALTHY" --activate-kit builder --yes >/dev/null)
HEALTHY_JSON="$(cd "$HEALTHY" && "$FLOW_AGENTS_BIN" workflow doctor --project-root "$HEALTHY" --artifact-root "$HEALTHY/.kontourai/flow-agents" --json)"
node -e 'const r=JSON.parse(process.argv[1]);if(!r.ok||r.warnings.length||!r.hook.integrity.ok||r.installed.active_kit_ids[0]!=="builder")process.exit(1)' "$HEALTHY_JSON" || fail "doctor did not pass immediately after its own remediation install"
pass "real init converges to doctor PASS"

cp "$HEALTHY/build/src/cli/workflow.js" "$TMP/workflow.js.clean"
printf '\n// WORKFLOW_CONTRACT_VERSION = "1.0"\n' >>"$HEALTHY/build/src/cli/workflow.js"
set +e
TAMPERED_CLI_JSON="$(cd "$HEALTHY" && "$FLOW_AGENTS_BIN" workflow doctor --project-root "$HEALTHY" --artifact-root "$HEALTHY/.kontourai/flow-agents" --json 2>/dev/null)"
TAMPERED_CLI_RC=$?
set -e
[[ "$TAMPERED_CLI_RC" -eq 2 && "$TAMPERED_CLI_JSON" == *"asset mismatch: build/src/cli/workflow.js"* ]] || fail "doctor accepted marker-preserving CLI tampering"
cp "$TMP/workflow.js.clean" "$HEALTHY/build/src/cli/workflow.js"
pass "doctor rejects marker-preserving CLI tampering"

cp "$HEALTHY/.codex/hooks.json" "$TMP/hooks.json.clean"
node - "$HEALTHY/.codex/hooks.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
const group = value.hooks.SessionStart.find((entry) => JSON.stringify(entry).includes('workflow-steering'));
group.hooks[0].command += '; true';
fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
NODE
set +e
TAMPERED_HOOK_JSON="$(cd "$HEALTHY" && "$FLOW_AGENTS_BIN" workflow doctor --project-root "$HEALTHY" --artifact-root "$HEALTHY/.kontourai/flow-agents" --json 2>/dev/null)"
TAMPERED_HOOK_RC=$?
set -e
[[ "$TAMPERED_HOOK_RC" -eq 2 && "$TAMPERED_HOOK_JSON" == *"does not contain the packaged managed hooks"* ]] || fail "doctor accepted name-preserving hook tampering"
cp "$TMP/hooks.json.clean" "$HEALTHY/.codex/hooks.json"
pass "doctor rejects name-preserving hook configuration tampering"

for RUNTIME in base claude-code opencode pi kiro; do
  RUNTIME_ROOT="$TMP/runtime-$RUNTIME"
  mkdir -p "$RUNTIME_ROOT"
  (cd "$RUNTIME_ROOT" && "$FLOW_AGENTS_BIN" init --runtime "$RUNTIME" --dest "$RUNTIME_ROOT" --activate-kit builder --yes >/dev/null)
  RUNTIME_JSON="$(cd "$RUNTIME_ROOT" && "$FLOW_AGENTS_BIN" workflow doctor --project-root "$RUNTIME_ROOT" --artifact-root "$RUNTIME_ROOT/.kontourai/flow-agents" --json)"
  node -e 'const r=JSON.parse(process.argv[1]);if(!r.ok||r.warnings.length||!r.hook.integrity.ok)process.exit(1)' "$RUNTIME_JSON" || fail "doctor did not validate $RUNTIME runtime wiring"
  pass "doctor validates $RUNTIME runtime wiring"
done

printf 'public workflow CLI integration passed\n'
