#!/usr/bin/env bash
# test_workflow_sidecar_writer.sh - workflow sidecar writer integration tests
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

TMPDIR_EVAL="$(mktemp -d)"
errors=0

cleanup() {
  rm -rf "$TMPDIR_EVAL"
}
trap cleanup EXIT

_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }
run_bounded() {
  local seconds="$1"
  shift
  "$@" &
  local pid=$!
  local deadline=$((SECONDS + seconds))
  while kill -0 "$pid" 2>/dev/null; do
    if [[ "$SECONDS" -ge "$deadline" ]]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    sleep 0.05
  done
  wait "$pid"
}

WRITER="workflow-sidecar"
VALIDATOR="validate-workflow-artifacts"
ARTIFACT_DIR="$TMPDIR_EVAL/repo/.flow-agents/auto-sidecars"
mkdir -p "$ARTIFACT_DIR"

SESSION_ROOT="$TMPDIR_EVAL/repo/.flow-agents"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$SESSION_ROOT" \
  --task-slug ensured-session \
  --source-request "Create a current workflow session automatically." \
  --title "Ensured Session" \
  --summary "Automatically create a durable session artifact and initial sidecars." \
  --criterion "Session artifact exists" \
  --criterion "Initial sidecars validate" \
  --next-action "Continue execution with durable state." \
  --timestamp "2026-05-09T00:00:00Z" >"$TMPDIR_EVAL/ensure.out" 2>"$TMPDIR_EVAL/ensure.err"; then
  _pass "sidecar writer ensures current session artifact"
else
  _fail "sidecar writer ensure-session failed: $(cat "$TMPDIR_EVAL/ensure.out" "$TMPDIR_EVAL/ensure.err")"
fi

ENSURED_DIR="$SESSION_ROOT/ensured-session"
if [[ -f "$ENSURED_DIR/ensured-session--deliver.md" ]] \
  && [[ -f "$ENSURED_DIR/state.json" ]] \
  && [[ -f "$ENSURED_DIR/acceptance.json" ]] \
  && [[ -f "$ENSURED_DIR/handoff.json" ]] \
  && [[ -f "$SESSION_ROOT/current.json" ]]; then
  _pass "sidecar writer creates session markdown and initial sidecars"
else
  _fail "sidecar writer did not create expected session files"
fi

if node - "$ENSURED_DIR/state.json" "$ENSURED_DIR/acceptance.json" "$ENSURED_DIR/handoff.json" <<'NODE'
const fs = require("node:fs");
for (const file of process.argv.slice(2)) {
  const repo = JSON.parse(fs.readFileSync(file, "utf8")).repo;
  if (repo !== "kontourai/flow-agents") throw new Error(`${file} repo was ${JSON.stringify(repo)}`);
  if (repo.includes("/") && repo.startsWith("/")) throw new Error(`${file} repo is an absolute path`);
}
NODE
then
  _pass "sidecar writer records stable repository identity without local paths"
else
  _fail "sidecar writer did not record stable repository identity"
fi

UNSAFE_REPO_ROOT="$TMPDIR_EVAL/unsafe-repo"
mkdir -p "$UNSAFE_REPO_ROOT"
if (cd "$UNSAFE_REPO_ROOT" \
  && git init -q \
  && git remote add origin "file:///Users/alice/customer-secret.git" \
  && FLOW_AGENTS_REPO="/Users/alice/customer-secret" flow_agents_node "$WRITER" ensure-session \
    --artifact-root ".flow-agents" \
    --task-slug unsafe-repo \
    --title "Unsafe repo" \
    --summary "Unsafe repo fallback." \
    --timestamp "2026-05-09T00:00:00Z" >/dev/null 2>"$TMPDIR_EVAL/unsafe-repo.err" \
  && node - ".flow-agents/unsafe-repo/state.json" <<'NODE'
const fs = require("node:fs");
const repo = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).repo;
if (repo !== "unsafe-repo") throw new Error(`unsafe repo fallback was ${JSON.stringify(repo)}`);
if (repo.includes("alice") || repo.includes("/") || repo.startsWith("/")) throw new Error(`unsafe repo leaked local path material: ${repo}`);
NODE
); then
  _pass "sidecar writer rejects path-like repository identity inputs"
else
  _fail "sidecar writer leaked or rejected path-like repository identity inputs: $(cat "$TMPDIR_EVAL/unsafe-repo.err" 2>/dev/null)"
fi

if flow_agents_node "$WRITER" current --artifact-root "$SESSION_ROOT" --format slug >"$TMPDIR_EVAL/current-slug.out" 2>"$TMPDIR_EVAL/current-slug.err" \
  && [[ "$(cat "$TMPDIR_EVAL/current-slug.out")" == "ensured-session" ]] \
  && flow_agents_node "$WRITER" current --artifact-root "$SESSION_ROOT" --format path >"$TMPDIR_EVAL/current-path.out" 2>"$TMPDIR_EVAL/current-path.err" \
  && [[ "$(cd "$TMPDIR_EVAL/repo" && realpath "$(cat "$TMPDIR_EVAL/current-path.out")")" == "$(realpath "$ENSURED_DIR")" ]]; then
  _pass "sidecar writer resolves current workflow identity"
else
  _fail "sidecar writer did not resolve current workflow identity: $(cat "$TMPDIR_EVAL/current-slug.out" "$TMPDIR_EVAL/current-slug.err" "$TMPDIR_EVAL/current-path.out" "$TMPDIR_EVAL/current-path.err")"
fi

AGENT_EVENT_PATH="$ENSURED_DIR/ag""ents/tool-worker-1/events.jsonl"
if flow_agents_node "$WRITER" record-agent-event \
  --artifact-root "$SESSION_ROOT" \
  --agent-id tool-worker-1 \
  --kind evidence \
  --status active \
  --summary "Worker started a bounded implementation pass." \
  --ref wave-1 \
  --timestamp "2026-05-09T00:00:30Z" >"$TMPDIR_EVAL/agent-event.out" 2>"$TMPDIR_EVAL/agent-event.err" \
  && [[ -f "$AGENT_EVENT_PATH" ]] \
  && rg -q '"agent_id": "tool-worker-1"' "$AGENT_EVENT_PATH" \
  && rg -q '"agent_id": "tool-worker-1"' "$SESSION_ROOT/current.json"; then
  _pass "sidecar writer records delegation-safe agent events"
else
  _fail "sidecar writer did not record delegation-safe agent event: $(cat "$TMPDIR_EVAL/agent-event.out" "$TMPDIR_EVAL/agent-event.err")"
fi

cp "$SESSION_ROOT/current.json" "$TMPDIR_EVAL/current-before-traversal-agent.json"
TRAVERSAL_AGENT_OUTSIDE="$TMPDIR_EVAL/repo/.flow-agents/evil-agent-outside.jsonl"
if run_bounded 5 flow_agents_node "$WRITER" record-agent-event \
  --artifact-root "$SESSION_ROOT" \
  --agent-id ../evil-agent-outside \
  --kind evidence \
  --status active \
  --summary "This traversal agent id should fail before mutation." >"$TMPDIR_EVAL/traversal-agent-event.out" 2>&1; then
  _fail "sidecar writer should reject traversal agent ids"
elif rg -q -- '--agent-id must not contain' "$TMPDIR_EVAL/traversal-agent-event.out" \
  && [[ ! -e "$TRAVERSAL_AGENT_OUTSIDE" ]] \
  && cmp -s "$SESSION_ROOT/current.json" "$TMPDIR_EVAL/current-before-traversal-agent.json" \
  && [[ ! -e "$SESSION_ROOT/.workflow-sidecar.lockdir" ]]; then
  _pass "sidecar writer rejects traversal agent ids without mutation or lock residue"
else
  _fail "sidecar writer traversal agent rejection lacked diagnostics or left residue: $(cat "$TMPDIR_EVAL/traversal-agent-event.out")"
fi

cp "$SESSION_ROOT/current.json" "$TMPDIR_EVAL/current-before-bad-agent.json"
if flow_agents_node "$WRITER" record-agent-event \
  --artifact-root "$SESSION_ROOT" \
  --artifact-dir "$SESSION_ROOT/ensured-sessoin" \
  --agent-id typo-worker \
  --kind evidence \
  --status active \
  --summary "This typo should not create a workflow." >"$TMPDIR_EVAL/bad-agent-event.out" 2>&1; then
  _fail "sidecar writer should reject missing explicit artifact dirs"
elif cmp -s "$SESSION_ROOT/current.json" "$TMPDIR_EVAL/current-before-bad-agent.json"; then
  _pass "sidecar writer rejects bad explicit artifact dirs without changing current"
else
  _fail "sidecar writer changed current after bad explicit artifact dir"
fi

if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$SESSION_ROOT" \
  --task-slug fresh-session \
  --source-request "Create a fresh session after worker activity." \
  --title "Fresh Session" \
  --summary "A new active workflow should not inherit agents from the prior slug." \
  --criterion "Fresh session is active" \
  --timestamp "2026-05-09T00:00:45Z" >"$TMPDIR_EVAL/ensure-fresh.out" 2>"$TMPDIR_EVAL/ensure-fresh.err" \
  && rg -q '"active_slug": "fresh-session"' "$SESSION_ROOT/current.json" \
  && node -e 'const fs=require("fs"); const current=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if (JSON.stringify(current.active_agents)!=="[]") process.exit(1);' "$SESSION_ROOT/current.json"
then
  _pass "sidecar writer resets active agents for a new current workflow"
else
  _fail "sidecar writer carried stale active agents into a new workflow: $(cat "$TMPDIR_EVAL/ensure-fresh.out" "$TMPDIR_EVAL/ensure-fresh.err")"
fi

if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$SESSION_ROOT" \
  --task-slug ../outside \
  --source-request "Traversal should be rejected." \
  --title "Traversal Fixture" \
  --summary "This must not create artifacts outside the root." \
  --timestamp "2026-05-09T00:00:50Z" >"$TMPDIR_EVAL/ensure-traversal.out" 2>&1; then
  _fail "sidecar writer should reject traversal task slugs"
elif rg -q -- '--task-slug must not contain' "$TMPDIR_EVAL/ensure-traversal.out" \
  && [[ ! -d "$TMPDIR_EVAL/repo/.flow-agents/outside" ]]; then
  _pass "sidecar writer rejects traversal task slugs without creating outside dirs"
else
  _fail "sidecar writer traversal rejection was not fail-closed: $(cat "$TMPDIR_EVAL/ensure-traversal.out")"
fi

LATE_AGENT_EVENT_PATH="$ENSURED_DIR/ag""ents/late-worker/events.jsonl"
if flow_agents_node "$WRITER" record-agent-event \
  --artifact-root "$SESSION_ROOT" \
  --artifact-dir "$ENSURED_DIR" \
  --agent-id late-worker \
  --kind completed \
  --status done \
  --summary "A late worker finished the old workflow after a newer session became active." \
  --timestamp "2026-05-09T00:01:00Z" >"$TMPDIR_EVAL/late-agent-event.out" 2>"$TMPDIR_EVAL/late-agent-event.err" \
  && [[ -f "$LATE_AGENT_EVENT_PATH" ]] \
  && rg -q '"agent_id": "late-worker"' "$LATE_AGENT_EVENT_PATH" \
  && rg -q '"active_slug": "fresh-session"' "$SESSION_ROOT/current.json" \
  && ! rg -q '"agent_id": "late-worker"' "$SESSION_ROOT/current.json"; then
  _pass "sidecar writer keeps late explicit agent events from stealing current workflow"
else
  _fail "sidecar writer let a late explicit agent event change current workflow: $(cat "$TMPDIR_EVAL/late-agent-event.out" "$TMPDIR_EVAL/late-agent-event.err")"
fi

COPIED_ROOT="$TMPDIR_EVAL/copied-workflows"
COPIED_DIR="$COPIED_ROOT/ensured-session"
mkdir -p "$COPIED_ROOT"
cp -R "$ENSURED_DIR" "$COPIED_DIR"
cp "$SESSION_ROOT/current.json" "$TMPDIR_EVAL/current-before-copied-agent.json"
COPIED_AGENT_EVENT_PATH="$COPIED_DIR/ag""ents/copied-worker/events.jsonl"
if run_bounded 5 flow_agents_node "$WRITER" record-agent-event \
  --artifact-dir "$COPIED_DIR" \
  --agent-id copied-worker \
  --kind evidence \
  --status done \
  --summary "A copied workflow outside the default root records without hanging." \
  --timestamp "2026-05-09T00:01:05Z" >"$TMPDIR_EVAL/copied-agent-event.out" 2>"$TMPDIR_EVAL/copied-agent-event.err" \
  && [[ -f "$COPIED_AGENT_EVENT_PATH" ]] \
  && rg -q '"agent_id": "copied-worker"' "$COPIED_AGENT_EVENT_PATH" \
  && cmp -s "$SESSION_ROOT/current.json" "$TMPDIR_EVAL/current-before-copied-agent.json" \
  && [[ ! -e "$COPIED_ROOT/.workflow-sidecar.lockdir" ]] \
  && [[ ! -e "$COPIED_DIR/.workflow-sidecar.lockdir" ]] \
  && [[ ! -e "$SESSION_ROOT/.workflow-sidecar.lockdir" ]]; then
  _pass "sidecar writer records bounded explicit events in copied workflow dirs"
else
  _fail "sidecar writer copied explicit event failed or left residue: $(cat "$TMPDIR_EVAL/copied-agent-event.out" "$TMPDIR_EVAL/copied-agent-event.err")"
fi

cp "$SESSION_ROOT/current.json" "$TMPDIR_EVAL/current-before-mismatch-agent.json"
MISMATCH_AGENT_EVENT_PATH="$COPIED_DIR/ag""ents/mismatch-worker/events.jsonl"
if run_bounded 5 flow_agents_node "$WRITER" record-agent-event \
  --artifact-root "$SESSION_ROOT" \
  --artifact-dir "$COPIED_DIR" \
  --agent-id mismatch-worker \
  --kind evidence \
  --status active \
  --summary "This root mismatch should fail before mutation." >"$TMPDIR_EVAL/mismatch-agent-event.out" 2>&1; then
  _fail "sidecar writer should reject explicit artifact-dir/root mismatches"
elif rg -q 'artifact directory must be under artifact root' "$TMPDIR_EVAL/mismatch-agent-event.out" \
  && [[ ! -e "$MISMATCH_AGENT_EVENT_PATH" ]] \
  && cmp -s "$SESSION_ROOT/current.json" "$TMPDIR_EVAL/current-before-mismatch-agent.json" \
  && [[ ! -e "$COPIED_ROOT/.workflow-sidecar.lockdir" ]] \
  && [[ ! -e "$COPIED_DIR/.workflow-sidecar.lockdir" ]] \
  && [[ ! -e "$SESSION_ROOT/.workflow-sidecar.lockdir" ]]; then
  _pass "sidecar writer rejects artifact-dir/root mismatches without mutation or lock residue"
else
  _fail "sidecar writer mismatch rejection lacked diagnostics or left residue: $(cat "$TMPDIR_EVAL/mismatch-agent-event.out")"
fi

SYMLINK_TARGET="$TMPDIR_EVAL/symlink-target-workflow"
SYMLINK_DIR="$SESSION_ROOT/symlink-session"
mkdir -p "$SYMLINK_TARGET"
if ln -s "$SYMLINK_TARGET" "$SYMLINK_DIR" 2>"$TMPDIR_EVAL/symlink-create.err"; then
  cp "$SESSION_ROOT/current.json" "$TMPDIR_EVAL/current-before-symlink-agent.json"
  if run_bounded 5 flow_agents_node "$WRITER" record-agent-event \
    --artifact-root "$SESSION_ROOT" \
    --artifact-dir "$SYMLINK_DIR" \
    --agent-id symlink-worker \
    --kind evidence \
    --status active \
    --summary "A symlink artifact dir should fail before mutation." >"$TMPDIR_EVAL/symlink-agent-event.out" 2>&1; then
    _fail "sidecar writer should reject symlink artifact dirs"
  elif rg -q 'artifact directory must not be a symlink' "$TMPDIR_EVAL/symlink-agent-event.out" \
    && [[ ! -e "$SYMLINK_TARGET/ag""ents/symlink-worker/events.jsonl" ]] \
    && cmp -s "$SESSION_ROOT/current.json" "$TMPDIR_EVAL/current-before-symlink-agent.json" \
    && [[ ! -e "$SESSION_ROOT/.workflow-sidecar.lockdir" ]] \
    && [[ ! -e "$SYMLINK_TARGET/.workflow-sidecar.lockdir" ]]; then
    _pass "sidecar writer rejects symlink artifact dirs without mutation or lock residue"
  else
    _fail "sidecar writer symlink artifact-dir rejection lacked diagnostics or left residue: $(cat "$TMPDIR_EVAL/symlink-agent-event.out")"
  fi
else
  _pass "sidecar writer symlink artifact-dir coverage skipped because symlink creation is unavailable: $(cat "$TMPDIR_EVAL/symlink-create.err")"
fi

if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$SESSION_ROOT" \
  --task-slug race-session-a \
  --source-request "Create a race fixture session." \
  --title "Race Session A" \
  --summary "Explicit agent events should serialize with current session switches." \
  --criterion "Race session A exists" \
  --timestamp "2026-05-09T00:01:10Z" >"$TMPDIR_EVAL/ensure-race-a.out" 2>"$TMPDIR_EVAL/ensure-race-a.err"; then
  RACE_A_DIR="$SESSION_ROOT/race-session-a"
  FLOW_AGENTS_WORKFLOW_SIDECAR_LOCK_DELAY=1.2 flow_agents_node "$WRITER" record-agent-event \
    --artifact-root "$SESSION_ROOT" \
    --artifact-dir "$RACE_A_DIR" \
    --agent-id race-worker \
    --kind evidence \
    --status active \
    --summary "This explicit event races with a session switch." \
    --timestamp "2026-05-09T00:01:12Z" >"$TMPDIR_EVAL/race-agent-event.out" 2>"$TMPDIR_EVAL/race-agent-event.err" &
  race_pid=$!
  node -e 'const fs=require("fs"); const lock=process.argv[1]; const deadline=Date.now()+5000; (function wait(){ if (fs.existsSync(lock)) process.exit(0); if (Date.now()>deadline) { console.error("record-agent-event did not acquire root lock before timeout"); process.exit(1); } setTimeout(wait,20); })();' "$SESSION_ROOT/.workflow-sidecar.lockdir"
  flow_agents_node "$WRITER" ensure-session \
    --artifact-root "$SESSION_ROOT" \
    --task-slug race-session-b \
    --source-request "Switch current session during explicit event." \
    --title "Race Session B" \
    --summary "The current workflow switch should not be lost." \
    --criterion "Race session B remains current" \
    --timestamp "2026-05-09T00:01:15Z" >"$TMPDIR_EVAL/ensure-race-b.out" 2>"$TMPDIR_EVAL/ensure-race-b.err"
  race_status_b=$?
  wait "$race_pid"
  race_status_event=$?
  race_event_path="$RACE_A_DIR/agen""ts/race-worker/even""ts.jsonl"
  if [[ "$race_status_event" -eq 0 && "$race_status_b" -eq 0 ]] \
	    && rg -q '"active_slug": "race-session-b"' "$SESSION_ROOT/current.json" \
	    && [[ -f "$race_event_path" ]] \
	    && rg -q '"agent_id": "race-worker"' "$race_event_path"
	  then
	    _pass "sidecar writer serializes explicit agent events with current workflow switches"
  else
    _fail "sidecar writer did not serialize explicit agent events with current workflow switches: $(cat "$TMPDIR_EVAL/race-agent-event.out" "$TMPDIR_EVAL/race-agent-event.err" "$TMPDIR_EVAL/ensure-race-b.out" "$TMPDIR_EVAL/ensure-race-b.err")"
  fi
else
  _fail "sidecar writer could not create race fixture: $(cat "$TMPDIR_EVAL/ensure-race-a.out" "$TMPDIR_EVAL/ensure-race-a.err")"
fi

if flow_agents_node "$VALIDATOR" --require-sidecars "$ENSURED_DIR" >"$TMPDIR_EVAL/ensure-valid.out" 2>"$TMPDIR_EVAL/ensure-valid.err"; then
  _pass "ensured session artifacts validate"
else
  _fail "ensured session artifacts failed validation: $(cat "$TMPDIR_EVAL/ensure-valid.out" "$TMPDIR_EVAL/ensure-valid.err")"
fi

EXISTING_ONLY_DIR="$SESSION_ROOT/existing-session"
mkdir -p "$EXISTING_ONLY_DIR"
cat > "$EXISTING_ONLY_DIR/existing-session--deliver.md" <<'MARKDOWN'
# Existing Session

branch: main
worktree: main
created: 2026-05-09T00:00:00Z
status: planning
type: deliver
iteration: 1

## Plan

Existing artifact should keep its own criteria when sidecars are filled in later.

## Definition Of Done

- **User outcome:** Existing session remains the source of truth.
- **Scope:** Existing Markdown plus missing sidecars.
- **Acceptance criteria:**
  - [ ] Existing artifact criterion - Evidence: existing Markdown.
- **Usefulness checks:**
  - [ ] User-facing workflow is documented or discoverable
- **Stop-short risks:** Sidecars could drift from existing Markdown.
- **Durable docs target:** not needed
- **Sandbox mode:** local-edit

## Execution Progress

- [ ] Session initialized.

## Verification Report

Build: [FAIL] Verification has not run yet.

### Acceptance Criteria
- [FAIL] Verification has not run yet - Evidence: pending workflow execution and checks.

### Verdict: FAIL

## Goal Fit Gate

- [ ] Original user goal restated

## Final Acceptance

- [ ] CI/relevant checks passed or local equivalent recorded
MARKDOWN

if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$SESSION_ROOT" \
  --task-slug existing-session \
  --source-request "Select existing session." \
  --summary "Fill missing sidecars for an existing artifact." \
  --criterion "Different CLI criterion" \
  --timestamp "2026-05-09T00:02:00Z" >"$TMPDIR_EVAL/ensure-existing.out" 2>"$TMPDIR_EVAL/ensure-existing.err" \
  && rg -q '"description": "Existing artifact criterion"' "$EXISTING_ONLY_DIR/acceptance.json" \
  && ! rg -q 'Different CLI criterion' "$EXISTING_ONLY_DIR/acceptance.json"; then
  _pass "sidecar writer derives missing sidecars from existing session Markdown"
else
  _fail "sidecar writer drifted sidecars from existing session Markdown: $(cat "$TMPDIR_EVAL/ensure-existing.out" "$TMPDIR_EVAL/ensure-existing.err")"
fi

printf 'DO NOT OVERWRITE\n' >> "$ENSURED_DIR/ensured-session--deliver.md"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$SESSION_ROOT" \
  --task-slug ensured-session \
  --source-request "Create a current workflow session automatically." \
  --summary "This second call should select the existing session." \
  --criterion "Should not replace the artifact" \
  --timestamp "2026-05-09T00:01:00Z" >"$TMPDIR_EVAL/ensure-again.out" 2>"$TMPDIR_EVAL/ensure-again.err" \
  && rg -q 'DO NOT OVERWRITE' "$ENSURED_DIR/ensured-session--deliver.md"; then
  _pass "sidecar writer selects existing session without overwrite"
else
  _fail "sidecar writer overwrote existing ensured session: $(cat "$TMPDIR_EVAL/ensure-again.out" "$TMPDIR_EVAL/ensure-again.err")"
fi

cat > "$ARTIFACT_DIR/auto-sidecars--deliver.md" <<'MARKDOWN'
# Generate sidecars automatically

status: delivered
type: deliver

## Plan

Use a writer utility to create machine-readable workflow sidecars.

## Definition Of Done

- **User outcome:** Workflow agents can create sidecars without hand-writing JSON.
- **Scope:** Sidecar writer utility and integration tests.
- **Acceptance criteria:**
  - [x] Planning sidecars are initialized - Evidence: writer creates state, acceptance, and handoff JSON.
  - [x] Evidence sidecar is recorded - Evidence: writer records evidence JSON and updates acceptance state.
  - [x] Critique sidecar is recorded - Evidence: writer records critique JSON and strict validation passes.
  - [x] Release and learning sidecars are recorded - Evidence: writer records release and learning JSON and updates workflow state.
- **Usefulness checks:**
  - [x] User-facing workflow is documented or discoverable
  - [x] Unknown, NOT_VERIFIED, and TODO gaps are resolved or explicitly accepted
- **Stop-short risks:** Writer output could be syntactically valid but inconsistent with Markdown.
- **Durable docs target:** docs/workflow-usage-guide.md
- **Sandbox mode:** local-edit

## Verification Report

Build: [PASS] sidecar writer fixture

### Acceptance Criteria
- [PASS] Planning sidecars are initialized - Evidence: state, acceptance, and handoff JSON exist.
- [PASS] Evidence sidecar is recorded - Evidence: evidence JSON exists.
- [PASS] Critique sidecar is recorded - Evidence: critique JSON exists.

### Verdict: PASS

## Goal Fit Gate

- [x] Original user goal restated
- [x] Every acceptance criterion has evidence

## Final Acceptance

- [x] CI/relevant checks passed
MARKDOWN

if flow_agents_node "$WRITER" init-plan "$ARTIFACT_DIR/auto-sidecars--deliver.md" \
  --source-request "Generate workflow sidecars automatically." \
  --summary "Planning sidecars were initialized from Markdown." \
  --next-action "Record evidence after checks run." \
  --timestamp "2026-05-09T00:00:00Z" >"$TMPDIR_EVAL/init.out" 2>"$TMPDIR_EVAL/init.err"; then
  _pass "sidecar writer initializes planning sidecars"
else
  _fail "sidecar writer init failed: $(cat "$TMPDIR_EVAL/init.out" "$TMPDIR_EVAL/init.err")"
fi

if rg -q '"id": "planning-sidecars-are-initialized"' "$ARTIFACT_DIR/acceptance.json"; then
  _pass "sidecar writer extracts Definition Of Done criteria"
else
  _fail "sidecar writer did not extract expected acceptance criterion"
fi

if flow_agents_node "$WRITER" record-evidence "$ARTIFACT_DIR" \
  --verdict pass \
  --check-json '{"id":"writer-fixture","kind":"test","status":"pass","summary":"Writer fixture passed.","command":"test_workflow_sidecar_writer.sh"}' \
  --timestamp "2026-05-09T00:01:00Z" >"$TMPDIR_EVAL/evidence.out" 2>"$TMPDIR_EVAL/evidence.err"; then
  _pass "sidecar writer records evidence"
else
  _fail "sidecar writer evidence failed: $(cat "$TMPDIR_EVAL/evidence.out" "$TMPDIR_EVAL/evidence.err")"
fi

if rg -q '"status": "verified"' "$ARTIFACT_DIR/state.json" && rg -q '"status": "pass"' "$ARTIFACT_DIR/acceptance.json"; then
  _pass "sidecar writer updates state and acceptance from evidence"
else
  _fail "sidecar writer did not update state and acceptance"
fi

INVALID_REF_DIR="$TMPDIR_EVAL/repo/.flow-agents/invalid-evidence-ref"
mkdir -p "$INVALID_REF_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$INVALID_REF_DIR/invalid-evidence-ref--deliver.md"
flow_agents_node "$WRITER" init-plan "$INVALID_REF_DIR/invalid-evidence-ref--deliver.md" \
  --source-request "Reject invalid evidence refs." \
  --summary "Invalid evidence refs fixture." \
  --next-action "Try invalid evidence refs." \
  --timestamp "2026-05-09T00:01:01Z" >"$TMPDIR_EVAL/invalid-ref-init.out" 2>"$TMPDIR_EVAL/invalid-ref-init.err"

if flow_agents_node "$WRITER" record-evidence "$INVALID_REF_DIR" \
  --verdict pass \
  --check-json '{"id":"legacy-ref-check","kind":"test","status":"pass","summary":"Should fail.","artifact_refs":["legacy-string-ref"]}' \
  --timestamp "2026-05-09T00:01:02Z" >"$TMPDIR_EVAL/legacy-ref.out" 2>"$TMPDIR_EVAL/legacy-ref.err"; then
  _fail "sidecar writer should reject legacy string artifact_refs"
elif rg -q 'legacy string refs are not supported' "$TMPDIR_EVAL/legacy-ref.out" "$TMPDIR_EVAL/legacy-ref.err" \
  && [[ ! -f "$INVALID_REF_DIR/evidence.json" ]] \
  && rg -q '"status": "planned"' "$INVALID_REF_DIR/state.json"; then
  _pass "sidecar writer rejects legacy string artifact_refs before mutation"
else
  _fail "legacy string artifact_refs rejection was not fail-closed: $(cat "$TMPDIR_EVAL/legacy-ref.out" "$TMPDIR_EVAL/legacy-ref.err")"
fi

if flow_agents_node "$WRITER" record-evidence "$INVALID_REF_DIR" \
  --verdict pass \
  --check-json '{"id":"incomplete-ref-check","kind":"test","status":"pass","summary":"Should fail.","artifact_refs":[{"kind":"artifact"}]}' \
  --timestamp "2026-05-09T00:01:03Z" >"$TMPDIR_EVAL/incomplete-ref.out" 2>"$TMPDIR_EVAL/incomplete-ref.err"; then
  _fail "sidecar writer should reject incomplete structured artifact_refs"
elif rg -q 'artifact refs require file or url' "$TMPDIR_EVAL/incomplete-ref.out" "$TMPDIR_EVAL/incomplete-ref.err" \
  && [[ ! -f "$INVALID_REF_DIR/evidence.json" ]] \
  && rg -q '"status": "planned"' "$INVALID_REF_DIR/state.json"; then
  _pass "sidecar writer rejects incomplete structured artifact_refs before mutation"
else
  _fail "incomplete structured artifact_refs rejection was not fail-closed: $(cat "$TMPDIR_EVAL/incomplete-ref.out" "$TMPDIR_EVAL/incomplete-ref.err")"
fi

INVALID_ACCEPTANCE_REF_DIR="$TMPDIR_EVAL/repo/.flow-agents/invalid-acceptance-ref"
mkdir -p "$INVALID_ACCEPTANCE_REF_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$INVALID_ACCEPTANCE_REF_DIR/invalid-acceptance-ref--deliver.md"
flow_agents_node "$WRITER" init-plan "$INVALID_ACCEPTANCE_REF_DIR/invalid-acceptance-ref--deliver.md" \
  --source-request "Reject invalid existing acceptance refs." \
  --summary "Invalid acceptance refs fixture." \
  --next-action "Try invalid acceptance refs." \
  --timestamp "2026-05-09T00:01:04Z" >"$TMPDIR_EVAL/invalid-acceptance-ref-init.out" 2>"$TMPDIR_EVAL/invalid-acceptance-ref-init.err"
node -e 'const fs=require("fs"); const file=process.argv[1]; const data=JSON.parse(fs.readFileSync(file,"utf8")); data.criteria[0].evidence_refs=["legacy-acceptance-ref.md"]; fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");' "$INVALID_ACCEPTANCE_REF_DIR/acceptance.json"

if flow_agents_node "$WRITER" record-evidence "$INVALID_ACCEPTANCE_REF_DIR" \
  --verdict pass \
  --check-json '{"id":"valid-check","kind":"test","status":"pass","summary":"Valid check."}' \
  --timestamp "2026-05-09T00:01:05Z" >"$TMPDIR_EVAL/invalid-acceptance-ref.out" 2>"$TMPDIR_EVAL/invalid-acceptance-ref.err"; then
  _fail "sidecar writer should reject existing legacy acceptance evidence_refs"
elif rg -q 'acceptance\.criteria\[0\]\.evidence_refs entries must be structured evidence reference objects' "$TMPDIR_EVAL/invalid-acceptance-ref.out" "$TMPDIR_EVAL/invalid-acceptance-ref.err" \
  && [[ ! -f "$INVALID_ACCEPTANCE_REF_DIR/evidence.json" ]] \
  && rg -q '"status": "planned"' "$INVALID_ACCEPTANCE_REF_DIR/state.json"; then
  _pass "sidecar writer rejects existing invalid acceptance refs before mutation"
else
  _fail "existing invalid acceptance ref rejection was not fail-closed: $(cat "$TMPDIR_EVAL/invalid-acceptance-ref.out" "$TMPDIR_EVAL/invalid-acceptance-ref.err")"
fi

SURFACE_CHECK='{"id":"surface-trust-fixture","kind":"policy","status":"pass","summary":"Hachure trust.bundle evidence passed.","surface_trust_refs":[{"artifact_kind":"trust.bundle","artifact_ref":"trust/report.json","gate_id":"builder.trust.bundle","claim_type":"builder.trust.bundle","claim_status":"accepted","subject":"builder-kit","freshness":{"status":"fresh","summary":"Issued during this workflow."},"authority":{"producer":"surface-local","summary":"Local Surface trust producer."},"integrity":{"status":"matched","summary":"Artifact digest matched expected subject and gate.","digest":"sha256:abc123"},"status":"pass","summary":"Accepted trust.bundle claim."}]}'
if flow_agents_node "$WRITER" record-evidence "$ARTIFACT_DIR" \
  --verdict pass \
  --check-json "$SURFACE_CHECK" \
  --timestamp "2026-05-09T00:01:05Z" >"$TMPDIR_EVAL/surface-evidence.out" 2>"$TMPDIR_EVAL/surface-evidence.err" \
  && rg -q '"surface_trust_refs"' "$ARTIFACT_DIR/evidence.json" \
  && rg -q '"artifact_kind": "trust.bundle"' "$ARTIFACT_DIR/evidence.json" \
  && ! rg -q 'veritas' "$ARTIFACT_DIR/evidence.json"; then
  _pass "sidecar writer records Hachure-aligned trust.bundle refs"
else
  _fail "sidecar writer did not record Hachure-aligned trust.bundle refs: $(cat "$TMPDIR_EVAL/surface-evidence.out" "$TMPDIR_EVAL/surface-evidence.err")"
fi

if flow_agents_node "$WRITER" record-evidence "$ARTIFACT_DIR" \
  --verdict pass \
  --check-json '{"id":"surface-trust-native-field","kind":"policy","status":"pass","summary":"Should fail.","surface_trust_refs":[{"artifact_kind":"trust.bundle","artifact_ref":"trust/snapshot.json","gate_id":"builder.trust.bundle","claim_type":"builder.trust.bundle","claim_status":"accepted","subject":"builder-kit","freshness":{"status":"fresh","summary":"Fresh."},"authority":{"producer":"surface-local","summary":"Producer exists.","veritas_policy":"native-field"},"integrity":{"status":"matched","summary":"Matched."},"status":"pass"}]}' >"$TMPDIR_EVAL/surface-invalid.out" 2>&1; then
  _fail "sidecar writer should reject provider-specific Surface trust fields"
elif rg -q 'unsupported field' "$TMPDIR_EVAL/surface-invalid.out"; then
  _pass "sidecar writer rejects provider-specific Surface trust fields"
else
  _fail "provider-specific Surface trust failure was not actionable: $(cat "$TMPDIR_EVAL/surface-invalid.out")"
fi

check_contradictory_surface_ref() {
  local name="$1"
  local ref="$2"
  if flow_agents_node "$WRITER" record-evidence "$ARTIFACT_DIR" \
    --verdict pass \
    --check-json "{\"id\":\"surface-trust-$name\",\"kind\":\"policy\",\"status\":\"pass\",\"summary\":\"Should fail.\",\"surface_trust_refs\":[$ref]}" >"$TMPDIR_EVAL/surface-contradictory-$name.out" 2>&1; then
    _fail "sidecar writer should reject contradictory Surface trust ref: $name"
  elif rg -q 'contradicts Surface trust facts' "$TMPDIR_EVAL/surface-contradictory-$name.out"; then
    _pass "sidecar writer rejects contradictory Surface trust ref: $name"
  else
    _fail "contradictory Surface trust ref failure was not actionable for $name: $(cat "$TMPDIR_EVAL/surface-contradictory-$name.out")"
  fi
}

check_contradictory_surface_ref "rejected-pass" '{"artifact_kind":"trust.bundle","artifact_ref":"trust/report.json","gate_id":"builder.trust.bundle","claim_type":"builder.trust.bundle","claim_status":"rejected","subject":"builder-kit","freshness":{"status":"fresh","summary":"Fresh."},"authority":{"producer":"surface-local","summary":"Producer exists."},"integrity":{"status":"matched","summary":"Matched."},"status":"pass"}'
check_contradictory_surface_ref "stale-pass" '{"artifact_kind":"trust.bundle","artifact_ref":"trust/report.json","gate_id":"builder.trust.bundle","claim_type":"builder.trust.bundle","claim_status":"accepted","subject":"builder-kit","freshness":{"status":"stale","summary":"Stale."},"authority":{"producer":"surface-local","summary":"Producer exists."},"integrity":{"status":"matched","summary":"Matched."},"status":"pass"}'
check_contradictory_surface_ref "missing-authority-pass" '{"artifact_kind":"trust.bundle","artifact_ref":"trust/report.json","gate_id":"builder.trust.bundle","claim_type":"builder.trust.bundle","claim_status":"accepted","subject":"builder-kit","freshness":{"status":"fresh","summary":"Fresh."},"authority":{"producer":"unknown","summary":"Producer missing."},"integrity":{"status":"matched","summary":"Matched."},"status":"pass"}'
check_contradictory_surface_ref "integrity-mismatch-pass" '{"artifact_kind":"trust.bundle","artifact_ref":"trust/report.json","gate_id":"builder.trust.bundle","claim_type":"builder.trust.bundle","claim_status":"accepted","subject":"builder-kit","freshness":{"status":"fresh","summary":"Fresh."},"authority":{"producer":"surface-local","summary":"Producer exists."},"integrity":{"status":"mismatch","summary":"Mismatch."},"status":"pass"}'

SURFACE_FIXTURE_DIR="$ROOT/evals/fixtures/surface-trust"
check_surface_fixture() {
  local name="$1"
  local fixture="$2"
  local verdict="$3"
  local expected_status="$4"
  local expected_text="$5"
  local dir="$TMPDIR_EVAL/repo/.flow-agents/surface-$name"
  mkdir -p "$dir"
  if flow_agents_node "$WRITER" record-evidence "$dir" \
    --task-slug "surface-$name" \
    --verdict "$verdict" \
    --check-json '{"id":"ordinary-builder-evidence","kind":"test","status":"pass","summary":"Ordinary Builder Kit evidence still records."}' \
    --surface-trust-json "$SURFACE_FIXTURE_DIR/$fixture" \
    --timestamp "2026-05-09T00:02:00Z" >"$TMPDIR_EVAL/surface-$name.out" 2>"$TMPDIR_EVAL/surface-$name.err" \
    && node -e 'const fs=require("fs"); const [file, expectedStatus, expectedText]=process.argv.slice(1); const data=JSON.parse(fs.readFileSync(file,"utf8")); const trustChecks=data.checks.filter((check)=>check.id.startsWith("surface-trust-")); if (trustChecks.length!==1) throw new Error(`expected one surface trust check, found ${trustChecks.length}`); const check=trustChecks[0]; if (check.status!==expectedStatus) throw new Error(`expected ${expectedStatus}, got ${check.status}`); const ref=check.surface_trust_refs[0]; const blob=JSON.stringify(check); if (!blob.includes(expectedText)) throw new Error(`missing expected text ${expectedText}: ${blob}`); if (blob.toLowerCase().includes("veritas")) throw new Error("surface trust output leaked a Veritas-specific field"); if (ref.gate_id==="unknown" || ref.claim_type==="unknown") throw new Error("surface trust ref did not map gate and claim metadata");' "$dir/evidence.json" "$expected_status" "$expected_text"
  then
    _pass "surface trust fixture maps $name to $expected_status evidence"
  else
    _fail "surface trust fixture $name failed: $(cat "$TMPDIR_EVAL/surface-$name.out" "$TMPDIR_EVAL/surface-$name.err")"
  fi
}

check_surface_fixture "accepted" "accepted-claim-trust-report.json" "pass" "pass" "accepted"
check_surface_fixture "rejected" "rejected-claim-trust-report.json" "fail" "fail" "rejected"
check_surface_fixture "stale" "stale-claim-trust-snapshot.json" "not_verified" "not_verified" "not currently verifiable"
check_surface_fixture "missing-authority" "missing-authority-trust-report.json" "fail" "fail" "missing authority"
check_surface_fixture "integrity-mismatch" "integrity-mismatch-trust-report.json" "fail" "fail" "integrity"
check_surface_fixture "provider-absent" "provider-absent.json" "not_verified" "not_verified" "No trust provider is configured"
check_surface_fixture "artifact-absent" "artifact-absent.json" "not_verified" "not_verified" "not readable"

PURE_SURFACE_DIR="$TMPDIR_EVAL/repo/.flow-agents/surface-trust-only"
mkdir -p "$PURE_SURFACE_DIR"
if flow_agents_node "$WRITER" record-evidence "$PURE_SURFACE_DIR" \
  --task-slug "surface-trust-only" \
  --verdict pass \
  --surface-trust-json "$SURFACE_FIXTURE_DIR/accepted-claim-trust-report.json" \
  --timestamp "2026-05-09T00:02:30Z" >"$TMPDIR_EVAL/surface-only.out" 2>"$TMPDIR_EVAL/surface-only.err" \
  && rg -q '"surface_trust_refs"' "$PURE_SURFACE_DIR/evidence.json"; then
  _pass "sidecar writer records Surface trust evidence without unrelated check-json"
else
  _fail "sidecar writer should accept Surface trust evidence without check-json: $(cat "$TMPDIR_EVAL/surface-only.out" "$TMPDIR_EVAL/surface-only.err")"
fi

if flow_agents_node "$WRITER" advance-state "$ARTIFACT_DIR" \
  --status in_progress \
  --phase execution \
  --summary "Execution started from the planned sidecars." \
  --next-action "Run focused validation and record evidence." \
  --target-phase verification \
  --artifact-ref auto-sidecars--deliver.md \
  --timestamp "2026-05-09T00:01:30Z" >"$TMPDIR_EVAL/advance.out" 2>"$TMPDIR_EVAL/advance.err"; then
  _pass "sidecar writer advances workflow state"
else
  _fail "sidecar writer advance-state failed: $(cat "$TMPDIR_EVAL/advance.out" "$TMPDIR_EVAL/advance.err")"
fi

if rg -q '"phase": "execution"' "$ARTIFACT_DIR/state.json" && rg -q 'Run focused validation' "$ARTIFACT_DIR/handoff.json"; then
  _pass "sidecar writer updates handoff during phase transitions"
else
  _fail "sidecar writer did not update state and handoff for phase transition"
fi

if flow_agents_node "$WRITER" advance-state "$ARTIFACT_DIR" \
  --status dancing \
  --phase execution \
  --summary "Invalid status fixture." \
  --next-action "Should fail." >"$TMPDIR_EVAL/advance-invalid.out" 2>&1; then
  _fail "sidecar writer should reject invalid workflow states"
elif rg -q 'status must be one of' "$TMPDIR_EVAL/advance-invalid.out"; then
  _pass "sidecar writer rejects invalid workflow states"
else
  _fail "invalid state failure was not actionable"
fi

if flow_agents_node "$WRITER" advance-state "$ARTIFACT_DIR" \
  --status in_progress \
  --phase execution \
  --summary "Invalid target phase fixture." \
  --next-action "Should fail." \
  --target-phase banana >"$TMPDIR_EVAL/advance-invalid-target.out" 2>&1; then
  _fail "sidecar writer should reject invalid target phases"
elif rg -q 'target phase must be one of' "$TMPDIR_EVAL/advance-invalid-target.out"; then
  _pass "sidecar writer rejects invalid target phases"
else
  _fail "invalid target phase failure was not actionable"
fi

cp "$ARTIFACT_DIR/state.json" "$TMPDIR_EVAL/terminal-jump-state.before"
cp "$ARTIFACT_DIR/handoff.json" "$TMPDIR_EVAL/terminal-jump-handoff.before"
if flow_agents_node "$WRITER" advance-state "$ARTIFACT_DIR" \
  --status archived \
  --phase done \
  --summary "Verifier terminal jump fixture." \
  --next-status done \
  --next-action "Should not become terminal before release and learning." \
  --target-phase done \
  --timestamp "2026-05-09T00:01:40Z" >"$TMPDIR_EVAL/terminal-jump.out" 2>&1; then
  _fail "transition guard should reject verifier terminal jumps"
elif rg -q 'terminal_jump_rejected' "$TMPDIR_EVAL/terminal-jump.out" \
  && [[ -f "$ARTIFACT_DIR/transition-diagnostics.jsonl" ]] \
  && rg -q '"code": "terminal_jump_rejected"' "$ARTIFACT_DIR/transition-diagnostics.jsonl" \
  && cmp -s "$ARTIFACT_DIR/state.json" "$TMPDIR_EVAL/terminal-jump-state.before" \
  && cmp -s "$ARTIFACT_DIR/handoff.json" "$TMPDIR_EVAL/terminal-jump-handoff.before"; then
  _pass "transition guard rejects terminal jumps without mutating state or handoff"
else
  _fail "terminal jump rejection lacked diagnostics or mutated authoritative sidecars"
fi

BUILDER_TRANSITION_DIR="$TMPDIR_EVAL/repo/.flow-agents/builder-transition-guard"
mkdir -p "$BUILDER_TRANSITION_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$BUILDER_TRANSITION_DIR/builder-transition-guard--deliver.md"
flow_agents_node "$WRITER" init-plan "$BUILDER_TRANSITION_DIR/builder-transition-guard--deliver.md" \
  --source-request "Builder transition guard fixture." \
  --summary "Builder transition guard fixture." \
  --next-action "Move into verification." \
  --timestamp "2026-05-09T00:00:00Z" >"$TMPDIR_EVAL/builder-transition-init.out" 2>"$TMPDIR_EVAL/builder-transition-init.err"
flow_agents_node "$WRITER" advance-state "$BUILDER_TRANSITION_DIR" \
  --status verifying \
  --phase verification \
  --summary "Builder verification fixture." \
  --next-action "Verify according to Builder Kit build flow." \
  --target-phase evidence \
  --flow-definition builder.build \
  --timestamp "2026-05-09T00:01:00Z" >"$TMPDIR_EVAL/builder-transition-verify.out" 2>"$TMPDIR_EVAL/builder-transition-verify.err"

cp "$BUILDER_TRANSITION_DIR/state.json" "$TMPDIR_EVAL/builder-missing-reason-state.before"
cp "$BUILDER_TRANSITION_DIR/handoff.json" "$TMPDIR_EVAL/builder-missing-reason-handoff.before"
if flow_agents_node "$WRITER" advance-state "$BUILDER_TRANSITION_DIR" \
  --status in_progress \
  --phase execution \
  --summary "Missing route-back reason fixture." \
  --next-action "Route back to execution." \
  --target-phase verification \
  --flow-definition builder.build >"$TMPDIR_EVAL/builder-missing-reason.out" 2>&1; then
  _fail "transition guard should reject Builder Kit route-back without reason"
elif rg -q 'route_back_reason_required' "$TMPDIR_EVAL/builder-missing-reason.out" \
  && rg -q 'implementation_defect' "$BUILDER_TRANSITION_DIR/transition-diagnostics.jsonl" \
  && cmp -s "$BUILDER_TRANSITION_DIR/state.json" "$TMPDIR_EVAL/builder-missing-reason-state.before" \
  && cmp -s "$BUILDER_TRANSITION_DIR/handoff.json" "$TMPDIR_EVAL/builder-missing-reason-handoff.before"; then
  _pass "transition guard rejects missing Builder Kit route-back reasons without mutation"
else
  _fail "missing Builder Kit route-back reason was not fail-closed"
fi

if flow_agents_node "$WRITER" advance-state "$BUILDER_TRANSITION_DIR" \
  --status in_progress \
  --phase execution \
  --summary "Allowed route-back fixture." \
  --next-action "Fix implementation defect." \
  --target-phase verification \
  --flow-definition builder.build \
  --route-back-reason implementation_defect \
  --timestamp "2026-05-09T00:01:10Z" >"$TMPDIR_EVAL/builder-route-back.out" 2>"$TMPDIR_EVAL/builder-route-back.err" \
  && rg -q '"phase": "execution"' "$BUILDER_TRANSITION_DIR/state.json" \
  && rg -q '"count": 1' "$BUILDER_TRANSITION_DIR/transition-attempts.json"; then
  _pass "transition guard allows Builder Kit route-back with deterministic attempt key"
else
  _fail "allowed Builder Kit route-back failed: $(cat "$TMPDIR_EVAL/builder-route-back.out" "$TMPDIR_EVAL/builder-route-back.err")"
fi

for attempt in 2 3; do
  flow_agents_node "$WRITER" advance-state "$BUILDER_TRANSITION_DIR" \
    --status verifying \
    --phase verification \
    --summary "Return to verification attempt $attempt." \
    --next-action "Verify again." \
    --target-phase evidence \
    --flow-definition builder.build \
    --timestamp "2026-05-09T00:01:${attempt}0Z" >"$TMPDIR_EVAL/builder-forward-$attempt.out" 2>"$TMPDIR_EVAL/builder-forward-$attempt.err"
  flow_agents_node "$WRITER" advance-state "$BUILDER_TRANSITION_DIR" \
    --status in_progress \
    --phase execution \
    --summary "Route back attempt $attempt." \
    --next-action "Fix implementation defect again." \
    --target-phase verification \
    --flow-definition builder.build \
    --route-back-reason implementation_defect \
    --timestamp "2026-05-09T00:01:${attempt}5Z" >"$TMPDIR_EVAL/builder-route-back-$attempt.out" 2>"$TMPDIR_EVAL/builder-route-back-$attempt.err"
done

flow_agents_node "$WRITER" advance-state "$BUILDER_TRANSITION_DIR" \
  --status verifying \
  --phase verification \
  --summary "Return to verification before exceeded route-back." \
  --next-action "Verify again." \
  --target-phase evidence \
  --flow-definition builder.build \
  --timestamp "2026-05-09T00:01:50Z" >"$TMPDIR_EVAL/builder-forward-4.out" 2>"$TMPDIR_EVAL/builder-forward-4.err"
cp "$BUILDER_TRANSITION_DIR/transition-attempts.json" "$TMPDIR_EVAL/builder-attempts.before"
if flow_agents_node "$WRITER" advance-state "$BUILDER_TRANSITION_DIR" \
  --status in_progress \
  --phase execution \
  --summary "Exceeded route-back fixture." \
  --next-action "Should block after max attempts." \
  --target-phase verification \
  --flow-definition builder.build \
  --route-back-reason implementation_defect >"$TMPDIR_EVAL/builder-route-back-exceeded.out" 2>&1; then
  _fail "transition guard should block exceeded Builder Kit route-back attempts"
elif rg -q 'route_back_attempts_exceeded' "$TMPDIR_EVAL/builder-route-back-exceeded.out" \
  && rg -q '"count": 3' "$BUILDER_TRANSITION_DIR/transition-attempts.json" \
  && cmp -s "$BUILDER_TRANSITION_DIR/transition-attempts.json" "$TMPDIR_EVAL/builder-attempts.before"; then
  _pass "transition guard blocks route-back loops without double incrementing rejected attempts"
else
  _fail "Builder Kit max-attempt route-back behavior was not deterministic"
fi

LEGACY_TRANSITION_DIR="$TMPDIR_EVAL/repo/.flow-agents/legacy-transition-guard"
mkdir -p "$LEGACY_TRANSITION_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$LEGACY_TRANSITION_DIR/legacy-transition-guard--deliver.md"
flow_agents_node "$WRITER" init-plan "$LEGACY_TRANSITION_DIR/legacy-transition-guard--deliver.md" \
  --source-request "Legacy transition guard fixture." \
  --summary "Legacy transition guard fixture." \
  --next-action "Move into verification." \
  --timestamp "2026-05-09T00:00:00Z" >"$TMPDIR_EVAL/legacy-transition-init.out" 2>"$TMPDIR_EVAL/legacy-transition-init.err"
flow_agents_node "$WRITER" advance-state "$LEGACY_TRANSITION_DIR" \
  --status verifying \
  --phase verification \
  --summary "Legacy verification fixture." \
  --next-action "Verify direct primitive workflow." \
  --target-phase evidence \
  --timestamp "2026-05-09T00:01:00Z" >"$TMPDIR_EVAL/legacy-transition-verify.out" 2>"$TMPDIR_EVAL/legacy-transition-verify.err"
if flow_agents_node "$WRITER" advance-state "$LEGACY_TRANSITION_DIR" \
  --status in_progress \
  --phase execution \
  --summary "Legacy direct primitive route-back." \
  --next-action "Direct primitive can route back without Builder Kit metadata." \
  --target-phase verification \
  --timestamp "2026-05-09T00:01:10Z" >"$TMPDIR_EVAL/legacy-route-back.out" 2>"$TMPDIR_EVAL/legacy-route-back.err" \
  && rg -q '"phase": "execution"' "$LEGACY_TRANSITION_DIR/state.json" \
  && [[ ! -f "$LEGACY_TRANSITION_DIR/transition-attempts.json" ]]; then
  _pass "transition guard preserves backward-compatible legacy direct primitives"
else
  _fail "legacy-compatible direct primitive route-back failed: $(cat "$TMPDIR_EVAL/legacy-route-back.out" "$TMPDIR_EVAL/legacy-route-back.err")"
fi

NV_DIR="$TMPDIR_EVAL/repo/.flow-agents/not-verified-sidecars"
mkdir -p "$NV_DIR"
cat > "$NV_DIR/not-verified-sidecars--deliver.md" <<'MARKDOWN'
# Route not verified evidence

status: needs-decision
type: deliver

## Plan

Record uncertain evidence without pretending it passed.

## Definition Of Done

- **User outcome:** Workflow agents can persist uncertain evidence for routing.
- **Scope:** Not-verified sidecar writer behavior.
- **Acceptance criteria:**
  - [x] Not verified evidence is recorded - Evidence: evidence sidecar.
- **Usefulness checks:**
  - [x] Unknown, NOT_VERIFIED, and TODO gaps are resolved or explicitly accepted
- **Stop-short risks:** Not verified evidence could be hidden as pass.
- **Durable docs target:** not needed
- **Sandbox mode:** local-edit

## Verification Report

Build: [NOT_VERIFIED] external service unavailable

### Acceptance Criteria
- [NOT_VERIFIED] Not verified evidence is recorded - Evidence collection unavailable.

### Verdict: NOT_VERIFIED

## Goal Fit Gate

- [x] Original user goal restated
- [ ] Every acceptance criterion has evidence

## Final Acceptance

- [ ] CI/relevant checks passed
MARKDOWN

if flow_agents_node "$WRITER" init-plan "$NV_DIR/not-verified-sidecars--deliver.md" \
  --source-request "Route not verified evidence." \
  --summary "Not verified fixture initialized." \
  --next-action "Record not verified evidence." \
  --timestamp "2026-05-09T00:00:00Z" >"$TMPDIR_EVAL/nv-init.out" 2>"$TMPDIR_EVAL/nv-init.err"; then
  _pass "sidecar writer initializes not-verified fixture"
else
  _fail "sidecar writer not-verified init failed: $(cat "$TMPDIR_EVAL/nv-init.out" "$TMPDIR_EVAL/nv-init.err")"
fi

if flow_agents_node "$WRITER" record-evidence "$NV_DIR" \
  --verdict not_verified \
  --check-json '{"id":"external-check","kind":"external","status":"not_verified","summary":"External service was unavailable."}' \
  --gap "External service was unavailable before user decision." \
  --timestamp "2026-05-09T00:01:00Z" >"$TMPDIR_EVAL/nv-evidence.out" 2>"$TMPDIR_EVAL/nv-evidence.err"; then
  _pass "sidecar writer records not-verified evidence for routing"
else
  _fail "sidecar writer not-verified evidence failed: $(cat "$TMPDIR_EVAL/nv-evidence.out" "$TMPDIR_EVAL/nv-evidence.err")"
fi

if rg -q '"status": "not_verified"' "$NV_DIR/state.json" && rg -q '"not_verified_gaps"' "$NV_DIR/evidence.json"; then
  _pass "sidecar writer preserves not-verified state and gaps"
else
  _fail "sidecar writer did not preserve not-verified state"
fi

NEW_INVALID_DIR="$TMPDIR_EVAL/repo/.flow-agents/new-invalid-artifact"
if flow_agents_node "$WRITER" record-evidence "$NEW_INVALID_DIR" \
  --verdict banana \
  --check-json '{"id":"invalid-new","kind":"test","status":"pass","summary":"Should fail."}' >"$TMPDIR_EVAL/new-invalid.out" 2>&1; then
  _fail "sidecar writer should reject invalid new artifact command"
elif [[ ! -e "$NEW_INVALID_DIR/.workflow-sidecar.lock" ]]; then
  _pass "sidecar writer does not leave lock files for invalid new artifact commands"
else
  _fail "sidecar writer left lock file for invalid new artifact command"
fi

LOCK_DENIED_DIR="$TMPDIR_EVAL/repo/.flow-agents/lock-denied"
mkdir -p "$LOCK_DENIED_DIR"
if chmod 500 "$LOCK_DENIED_DIR" 2>"$TMPDIR_EVAL/lock-denied-chmod.err"; then
  if run_bounded 5 flow_agents_node "$WRITER" record-critique "$LOCK_DENIED_DIR" \
    --id lock-denied-review \
    --reviewer tool-code-reviewer \
    --verdict pass \
    --summary "This lock acquisition should fail quickly." >"$TMPDIR_EVAL/lock-denied.out" 2>&1; then
    chmod 700 "$LOCK_DENIED_DIR" 2>/dev/null || true
    _fail "sidecar writer should reject lock acquisition permission failures"
  else
    chmod 700 "$LOCK_DENIED_DIR" 2>/dev/null || true
    if rg -q 'failed to acquire workflow sidecar lock' "$TMPDIR_EVAL/lock-denied.out" \
      && rg -q 'record-critique' "$TMPDIR_EVAL/lock-denied.out" \
      && rg -q "$LOCK_DENIED_DIR/.workflow-sidecar.lockdir" "$TMPDIR_EVAL/lock-denied.out" \
      && rg -q 'EPERM|EACCES|permission denied|operation not permitted' "$TMPDIR_EVAL/lock-denied.out" \
      && rg -q 'permissions, ownership, or sandbox restrictions' "$TMPDIR_EVAL/lock-denied.out" \
      && rg -q 'fix permissions or ownership' "$TMPDIR_EVAL/lock-denied.out" \
      && rg -q 'approved writable workspace' "$TMPDIR_EVAL/lock-denied.out" \
      && rg -q 'manually write schema-valid sidecars' "$TMPDIR_EVAL/lock-denied.out" \
      && rg -q 'workflow artifact validation rather than bypassing locks' "$TMPDIR_EVAL/lock-denied.out" \
      && [[ ! -e "$LOCK_DENIED_DIR/.workflow-sidecar.lockdir" ]] \
      && [[ ! -e "$LOCK_DENIED_DIR/critique.json" ]]; then
      _pass "sidecar writer fails fast with actionable lock acquisition permission guidance"
    else
      _fail "sidecar writer lock acquisition failure was not actionable: $(cat "$TMPDIR_EVAL/lock-denied.out")"
    fi
  fi
else
  _pass "sidecar writer lock permission coverage skipped because chmod is unavailable: $(cat "$TMPDIR_EVAL/lock-denied-chmod.err")"
fi

if flow_agents_node "$WRITER" record-critique "$ARTIFACT_DIR" \
  --id writer-review \
  --reviewer tool-code-reviewer \
  --verdict pass \
  --summary "No blocking findings." \
  --artifact-ref auto-sidecars--deliver.md \
  --timestamp "2026-05-09T00:02:00Z" >"$TMPDIR_EVAL/critique.out" 2>"$TMPDIR_EVAL/critique.err"; then
  _pass "sidecar writer records passing critique"
else
  _fail "sidecar writer critique failed: $(cat "$TMPDIR_EVAL/critique.out" "$TMPDIR_EVAL/critique.err")"
fi

CONCURRENT_DIR="$TMPDIR_EVAL/repo/.flow-agents/concurrent-critiques"
mkdir -p "$CONCURRENT_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$CONCURRENT_DIR/concurrent-critiques--deliver.md"
flow_agents_node "$WRITER" init-plan "$CONCURRENT_DIR/concurrent-critiques--deliver.md" \
  --source-request "Concurrent critique fixture." \
  --summary "Concurrent critique fixture." \
  --next-action "Record concurrent critique." \
  --timestamp "2026-05-09T00:00:00Z" >"$TMPDIR_EVAL/concurrent-init.out" 2>"$TMPDIR_EVAL/concurrent-init.err"
flow_agents_node "$WRITER" record-evidence "$CONCURRENT_DIR" \
  --verdict pass \
  --check-json '{"id":"concurrent-fixture","kind":"test","status":"pass","summary":"Concurrent fixture setup passed."}' \
  --timestamp "2026-05-09T00:01:00Z" >"$TMPDIR_EVAL/concurrent-evidence.out" 2>"$TMPDIR_EVAL/concurrent-evidence.err"

FLOW_AGENTS_WORKFLOW_SIDECAR_LOCK_DELAY=0.2 flow_agents_node "$WRITER" record-critique "$CONCURRENT_DIR" \
  --id concurrent-review-a \
  --reviewer tool-code-reviewer \
  --verdict pass \
  --summary "Concurrent review A passed." \
  --timestamp "2026-05-09T00:02:00Z" >"$TMPDIR_EVAL/concurrent-a.out" 2>"$TMPDIR_EVAL/concurrent-a.err" &
pid_a=$!
FLOW_AGENTS_WORKFLOW_SIDECAR_LOCK_DELAY=0.2 flow_agents_node "$WRITER" record-critique "$CONCURRENT_DIR" \
  --id concurrent-review-b \
  --reviewer tool-code-reviewer \
  --verdict pass \
  --summary "Concurrent review B passed." \
  --timestamp "2026-05-09T00:02:01Z" >"$TMPDIR_EVAL/concurrent-b.out" 2>"$TMPDIR_EVAL/concurrent-b.err" &
pid_b=$!
wait "$pid_a"
status_a=$?
wait "$pid_b"
status_b=$?

if [[ "$status_a" -eq 0 && "$status_b" -eq 0 ]] \
  && rg -q '"id": "concurrent-review-a"' "$CONCURRENT_DIR/critique.json" \
  && rg -q '"id": "concurrent-review-b"' "$CONCURRENT_DIR/critique.json"; then
  _pass "sidecar writer serializes concurrent sidecar writes"
else
  _fail "sidecar writer lost concurrent critique writes: $(cat "$TMPDIR_EVAL/concurrent-a.out" "$TMPDIR_EVAL/concurrent-a.err" "$TMPDIR_EVAL/concurrent-b.out" "$TMPDIR_EVAL/concurrent-b.err")"
fi

if flow_agents_node "$WRITER" record-release "$ARTIFACT_DIR" \
  --decision merge \
  --scope "Workflow sidecar writer fixture." \
  --evidence-ref evidence.json \
  --gate-json '{"name":"merge","status":"pass","summary":"Evidence and critique passed.","evidence_refs":["writer-fixture"]}' \
  --gate-json '{"name":"docs","status":"pass","summary":"Workflow usage docs are the durable target."}' \
  --rollback-json '{"status":"not_required","summary":"No deployed runtime change.","owner":"codex"}' \
  --observability-json '{"status":"not_required","summary":"No production telemetry needed for this fixture."}' \
  --post-deploy-json '{"id":"post-merge-static","status":"planned","summary":"Run static checks after merge."}' \
  --docs-json '{"status":"updated","summary":"Workflow usage documentation covers sidecar use.","refs":["docs/workflow-usage-guide.md"]}' \
  --summary "Release readiness recorded for merge." \
  --timestamp "2026-05-09T00:03:00Z" >"$TMPDIR_EVAL/release.out" 2>"$TMPDIR_EVAL/release.err"; then
  _pass "sidecar writer records release readiness"
else
  _fail "sidecar writer release failed: $(cat "$TMPDIR_EVAL/release.out" "$TMPDIR_EVAL/release.err")"
fi

if rg -q '"decision": "merge"' "$ARTIFACT_DIR/release.json" && rg -q '"phase": "release"' "$ARTIFACT_DIR/state.json"; then
  _pass "sidecar writer advances state from release readiness"
else
  _fail "sidecar writer did not update release state"
fi

NO_SUMMARY_RELEASE_DIR="$TMPDIR_EVAL/repo/.flow-agents/no-summary-release"
mkdir -p "$NO_SUMMARY_RELEASE_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$NO_SUMMARY_RELEASE_DIR/no-summary-release--deliver.md"
flow_agents_node "$WRITER" init-plan "$NO_SUMMARY_RELEASE_DIR/no-summary-release--deliver.md" \
  --source-request "No-summary release fixture." \
  --summary "No-summary release fixture." \
  --next-action "Record release without an explicit summary." \
  --timestamp "2026-05-09T00:00:00Z" >"$TMPDIR_EVAL/no-summary-release-init.out" 2>"$TMPDIR_EVAL/no-summary-release-init.err"
flow_agents_node "$WRITER" record-evidence "$NO_SUMMARY_RELEASE_DIR" \
  --verdict pass \
  --check-json '{"id":"no-summary-release-fixture","kind":"test","status":"pass","summary":"No-summary release setup passed."}' \
  --timestamp "2026-05-09T00:01:00Z" >"$TMPDIR_EVAL/no-summary-release-evidence.out" 2>"$TMPDIR_EVAL/no-summary-release-evidence.err"

if flow_agents_node "$WRITER" record-release "$NO_SUMMARY_RELEASE_DIR" \
  --decision merge \
  --scope "No-summary release fixture." \
  --evidence-ref evidence.json \
  --gate-json '{"name":"merge","status":"pass","summary":"Evidence passed.","evidence_refs":["no-summary-release-fixture"]}' \
  --rollback-json '{"status":"not_required","summary":"No deployed runtime change.","owner":"codex"}' \
  --observability-json '{"status":"not_required","summary":"No production telemetry needed for this fixture."}' \
  --docs-json '{"status":"not_needed","summary":"No docs change needed."}' \
  --timestamp "2026-05-09T00:03:30Z" >"$TMPDIR_EVAL/no-summary-release.out" 2>"$TMPDIR_EVAL/no-summary-release.err" \
  && node -e 'const fs = require("fs"); const dir = process.argv[1]; const state = JSON.parse(fs.readFileSync(`${dir}/state.json`, "utf8")); if (state.phase !== "release") throw new Error(`expected release phase, got ${state.phase}`); if (state.next_action?.summary !== "Release readiness recorded for merge.") throw new Error(`unexpected summary: ${state.next_action?.summary}`);' "$NO_SUMMARY_RELEASE_DIR" \
  && rg -q '"decision": "merge"' "$NO_SUMMARY_RELEASE_DIR/release.json" \
  && flow_agents_node "$VALIDATOR" --skip-markdown-validation "$NO_SUMMARY_RELEASE_DIR" >"$TMPDIR_EVAL/no-summary-release-valid.out" 2>"$TMPDIR_EVAL/no-summary-release-valid.err"; then
  _pass "sidecar writer records valid release state without explicit summary"
else
  _fail "no-summary release state fallback failed: $(cat "$TMPDIR_EVAL/no-summary-release.out" "$TMPDIR_EVAL/no-summary-release.err" "$TMPDIR_EVAL/no-summary-release-valid.out" "$TMPDIR_EVAL/no-summary-release-valid.err" 2>/dev/null)"
fi

if flow_agents_node "$WRITER" record-learning "$ARTIFACT_DIR" \
  --status learned \
  --record-json '{"id":"writer-loop","source_refs":["release.json","evidence.json"],"outcome":"success","facts":["Release sidecar validated."],"interpretation":"Writer commands can carry release and learning feedback without hand-authored JSON.","routing":[{"target":"none","action":"No follow-up required after intended-vs-observed closeout.","status":"completed"}],"correction":{"needed":false,"evidence":"Release, evidence, and learning closeout matched intended behavior."}}' \
  --summary "Learning recorded and no follow-up remains." \
  --timestamp "2026-05-09T00:04:00Z" >"$TMPDIR_EVAL/learning.out" 2>"$TMPDIR_EVAL/learning.err"; then
  _pass "sidecar writer records learning feedback"
else
  _fail "sidecar writer learning failed: $(cat "$TMPDIR_EVAL/learning.out" "$TMPDIR_EVAL/learning.err")"
fi

if rg -q '"status": "learned"' "$ARTIFACT_DIR/learning.json" && rg -q '"phase": "learning"' "$ARTIFACT_DIR/state.json"; then
  _pass "sidecar writer advances state from learning feedback"
else
  _fail "sidecar writer did not update learning state"
fi

if flow_agents_node "$VALIDATOR" --skip-markdown-validation "$ARTIFACT_DIR/learning.json" >"$TMPDIR_EVAL/learning-valid.out" 2>"$TMPDIR_EVAL/learning-valid.err" \
  && rg -q '"needed": false' "$ARTIFACT_DIR/learning.json" \
  && rg -q '"target": "none"' "$ARTIFACT_DIR/learning.json"; then
  _pass "sidecar writer records valid no-correction learning closeout"
else
  _fail "no-correction learning closeout failed validation: $(cat "$TMPDIR_EVAL/learning-valid.out" "$TMPDIR_EVAL/learning-valid.err")"
fi

CORRECTION_DIR="$TMPDIR_EVAL/repo/.flow-agents/correction-needed-learning"
mkdir -p "$CORRECTION_DIR"
if flow_agents_node "$WRITER" record-learning "$CORRECTION_DIR" \
  --task-slug correction-needed-learning \
  --status followup_required \
  --record-json '{"id":"stale-learning-route","source_refs":["release.json","issue-93"],"outcome":"mixed","facts":["A stale learning route remained local after durable tracking existed."],"interpretation":"Terminal learning review must force a correction or no-correction decision.","routing":[{"target":"skill","action":"Update learning-review closeout contract.","status":"open","ref":"https://github.com/kontourai/flow-agents/issues/93"}],"correction":{"needed":true,"type":"workflow","recurrence_key":"learning-review.stale-route-closeout","intended_behavior":"Terminal learning review routes or closes every actionable gap.","observed_behavior":"A stale learning route remained local after durable tracking existed.","gap":"Learning review did not force a correction/no-correction decision.","prevention":{"target":"skill","action":"Update learning-review closeout contract.","status":"open","ref":"https://github.com/kontourai/flow-agents/issues/93"}}}' \
  --summary "Correction-needed learning recorded." \
  --timestamp "2026-05-09T00:04:30Z" >"$TMPDIR_EVAL/correction-needed-learning.out" 2>"$TMPDIR_EVAL/correction-needed-learning.err" \
  && flow_agents_node "$VALIDATOR" --skip-markdown-validation "$CORRECTION_DIR/learning.json" >"$TMPDIR_EVAL/correction-needed-valid.out" 2>"$TMPDIR_EVAL/correction-needed-valid.err"; then
  _pass "sidecar writer records valid correction-needed learning closeout"
else
  _fail "correction-needed learning closeout failed: $(cat "$TMPDIR_EVAL/correction-needed-learning.out" "$TMPDIR_EVAL/correction-needed-learning.err" "$TMPDIR_EVAL/correction-needed-valid.out" "$TMPDIR_EVAL/correction-needed-valid.err")"
fi

DOGFOOD_DIR="$TMPDIR_EVAL/repo/.flow-agents/dogfood-pass"
mkdir -p "$DOGFOOD_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$DOGFOOD_DIR/dogfood-pass--deliver.md"
flow_agents_node "$WRITER" init-plan "$DOGFOOD_DIR/dogfood-pass--deliver.md" \
  --source-request "Dogfood pass fixture." \
  --summary "Dogfood pass fixture." \
  --next-action "Run dogfood pass." \
  --timestamp "2026-05-09T00:00:00Z" >"$TMPDIR_EVAL/dogfood-init.out" 2>"$TMPDIR_EVAL/dogfood-init.err"

if flow_agents_node "$WRITER" dogfood-pass \
  --artifact-root "$SESSION_ROOT" \
  --artifact-dir "$DOGFOOD_DIR" \
  --verdict pass \
  --summary "Should fail without evidence." >"$TMPDIR_EVAL/dogfood-no-evidence.out" 2>&1; then
  _fail "dogfood-pass should reject clean pass without evidence"
elif rg -q 'cannot mark clean without passing evidence' "$TMPDIR_EVAL/dogfood-no-evidence.out"; then
  _pass "dogfood-pass refuses clean completion without evidence"
else
  _fail "dogfood-pass missing actionable no-evidence error"
fi

DIRTY_EVIDENCE_DOGFOOD_DIR="$TMPDIR_EVAL/repo/.flow-agents/dogfood-dirty-evidence"
mkdir -p "$DIRTY_EVIDENCE_DOGFOOD_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$DIRTY_EVIDENCE_DOGFOOD_DIR/dogfood-dirty-evidence--deliver.md"
flow_agents_node "$WRITER" init-plan "$DIRTY_EVIDENCE_DOGFOOD_DIR/dogfood-dirty-evidence--deliver.md" \
  --source-request "Dogfood dirty evidence fixture." \
  --summary "Dogfood dirty evidence fixture." \
  --next-action "Run dogfood pass against existing dirty evidence." \
  --timestamp "2026-05-09T00:00:00Z" >"$TMPDIR_EVAL/dogfood-dirty-evidence-init.out" 2>"$TMPDIR_EVAL/dogfood-dirty-evidence-init.err"
cat > "$DIRTY_EVIDENCE_DOGFOOD_DIR/evidence.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "dogfood-dirty-evidence",
  "verdict": "pass",
  "checks": [
    {
      "id": "existing-pass",
      "kind": "test",
      "status": "pass",
      "summary": "Existing pass check."
    },
    {
      "id": "existing-fail",
      "kind": "test",
      "status": "fail",
      "summary": "Existing fail check."
    }
  ],
  "not_verified_gaps": []
}
JSON
cp "$DIRTY_EVIDENCE_DOGFOOD_DIR/state.json" "$TMPDIR_EVAL/dogfood-dirty-evidence-state.before"
cp "$DIRTY_EVIDENCE_DOGFOOD_DIR/handoff.json" "$TMPDIR_EVAL/dogfood-dirty-evidence-handoff.before"
if flow_agents_node "$WRITER" dogfood-pass \
  --artifact-root "$SESSION_ROOT" \
  --artifact-dir "$DIRTY_EVIDENCE_DOGFOOD_DIR" \
  --verdict pass \
  --summary "Should fail before state writes." >"$TMPDIR_EVAL/dogfood-dirty-evidence.out" 2>&1; then
  _fail "dogfood-pass should reject existing dirty pass evidence before state writes"
elif rg -q 'cannot mark clean without passing evidence' "$TMPDIR_EVAL/dogfood-dirty-evidence.out" \
  && cmp -s "$DIRTY_EVIDENCE_DOGFOOD_DIR/state.json" "$TMPDIR_EVAL/dogfood-dirty-evidence-state.before" \
  && cmp -s "$DIRTY_EVIDENCE_DOGFOOD_DIR/handoff.json" "$TMPDIR_EVAL/dogfood-dirty-evidence-handoff.before"; then
  _pass "dogfood-pass rejects existing dirty evidence before state and handoff writes"
else
  _fail "dogfood-pass existing dirty evidence was not fail-closed"
fi

INVALID_EXISTING_EVIDENCE_DOGFOOD_DIR="$TMPDIR_EVAL/repo/.flow-agents/dogfood-existing-invalid-evidence"
mkdir -p "$INVALID_EXISTING_EVIDENCE_DOGFOOD_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$INVALID_EXISTING_EVIDENCE_DOGFOOD_DIR/dogfood-existing-invalid-evidence--deliver.md"
flow_agents_node "$WRITER" init-plan "$INVALID_EXISTING_EVIDENCE_DOGFOOD_DIR/dogfood-existing-invalid-evidence--deliver.md" \
  --source-request "Dogfood existing invalid evidence fixture." \
  --summary "Dogfood existing invalid evidence fixture." \
  --next-action "Run dogfood pass against existing invalid evidence." \
  --timestamp "2026-05-09T00:00:00Z" >"$TMPDIR_EVAL/dogfood-existing-invalid-evidence-init.out" 2>"$TMPDIR_EVAL/dogfood-existing-invalid-evidence-init.err"
cat > "$INVALID_EXISTING_EVIDENCE_DOGFOOD_DIR/evidence.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "dogfood-existing-invalid-evidence",
  "verdict": "pass",
  "checks": [
    {
      "id": "existing-invalid-pass",
      "kind": "test",
      "status": "pass",
      "summary": "Existing pass check with invalid metadata.",
      "standard_refs": [
        {
          "standard": "unknown",
          "ref": "bad-ref"
        }
      ]
    }
  ],
  "not_verified_gaps": []
}
JSON
cp "$INVALID_EXISTING_EVIDENCE_DOGFOOD_DIR/state.json" "$TMPDIR_EVAL/dogfood-existing-invalid-evidence-state.before"
cp "$INVALID_EXISTING_EVIDENCE_DOGFOOD_DIR/handoff.json" "$TMPDIR_EVAL/dogfood-existing-invalid-evidence-handoff.before"
if flow_agents_node "$WRITER" dogfood-pass \
  --artifact-root "$SESSION_ROOT" \
  --artifact-dir "$INVALID_EXISTING_EVIDENCE_DOGFOOD_DIR" \
  --verdict pass \
  --summary "Should fail before state writes." >"$TMPDIR_EVAL/dogfood-existing-invalid-evidence.out" 2>&1; then
  _fail "dogfood-pass should reject existing invalid pass evidence before state writes"
elif rg -q 'cannot mark clean without passing evidence' "$TMPDIR_EVAL/dogfood-existing-invalid-evidence.out" \
  && cmp -s "$INVALID_EXISTING_EVIDENCE_DOGFOOD_DIR/state.json" "$TMPDIR_EVAL/dogfood-existing-invalid-evidence-state.before" \
  && cmp -s "$INVALID_EXISTING_EVIDENCE_DOGFOOD_DIR/handoff.json" "$TMPDIR_EVAL/dogfood-existing-invalid-evidence-handoff.before"; then
  _pass "dogfood-pass rejects existing invalid evidence before state and handoff writes"
else
  _fail "dogfood-pass existing invalid evidence was not fail-closed"
fi

if flow_agents_node "$WRITER" dogfood-pass \
  --artifact-root "$SESSION_ROOT" \
  --artifact-dir "$DOGFOOD_DIR" \
  --verdict pass \
  --check-json '{"id":"dogfood-failed-check","kind":"test","status":"fail","summary":"Should not write."}' \
  --summary "Should fail before evidence." >"$TMPDIR_EVAL/dogfood-pass-failed-check.out" 2>&1; then
  _fail "dogfood-pass should reject failed checks on clean pass before evidence writes"
elif rg -q 'clean evidence requires all non-skipped checks to pass' "$TMPDIR_EVAL/dogfood-pass-failed-check.out" \
  && [[ ! -f "$DOGFOOD_DIR/evidence.json" ]]; then
  _pass "dogfood-pass rejects failed clean-pass checks before partial evidence writes"
else
  _fail "dogfood-pass failed clean-pass check was not fail-closed"
fi

if flow_agents_node "$WRITER" dogfood-pass \
  --artifact-root "$SESSION_ROOT" \
  --artifact-dir "$DOGFOOD_DIR" \
  --verdict pass \
  --check-json '{"id":"dogfood-not-verified-check","kind":"test","status":"not_verified","summary":"Should not write."}' \
  --summary "Should fail before evidence." >"$TMPDIR_EVAL/dogfood-pass-not-verified-check.out" 2>&1; then
  _fail "dogfood-pass should reject not_verified checks on clean pass before evidence writes"
elif rg -q 'clean evidence requires all non-skipped checks to pass' "$TMPDIR_EVAL/dogfood-pass-not-verified-check.out" \
  && [[ ! -f "$DOGFOOD_DIR/evidence.json" ]]; then
  _pass "dogfood-pass rejects not_verified clean-pass checks before partial evidence writes"
else
  _fail "dogfood-pass not_verified clean-pass check was not fail-closed"
fi

INVALID_EVIDENCE_DOGFOOD_DIR="$TMPDIR_EVAL/repo/.flow-agents/dogfood-invalid-evidence"
mkdir -p "$INVALID_EVIDENCE_DOGFOOD_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$INVALID_EVIDENCE_DOGFOOD_DIR/dogfood-invalid-evidence--deliver.md"
flow_agents_node "$WRITER" init-plan "$INVALID_EVIDENCE_DOGFOOD_DIR/dogfood-invalid-evidence--deliver.md" \
  --artifact-root "$SESSION_ROOT" \
  --source-request "Dogfood invalid evidence fixture." \
  --summary "Dogfood invalid evidence fixture." \
  --next-action "Run dogfood pass with invalid evidence metadata." \
  --timestamp "2026-05-09T00:00:00Z" >"$TMPDIR_EVAL/dogfood-invalid-evidence-init.out" 2>"$TMPDIR_EVAL/dogfood-invalid-evidence-init.err"
cp "$INVALID_EVIDENCE_DOGFOOD_DIR/state.json" "$TMPDIR_EVAL/dogfood-invalid-evidence-state.before"
cp "$INVALID_EVIDENCE_DOGFOOD_DIR/handoff.json" "$TMPDIR_EVAL/dogfood-invalid-evidence-handoff.before"
if flow_agents_node "$WRITER" dogfood-pass \
  --artifact-root "$SESSION_ROOT" \
  --artifact-dir "$INVALID_EVIDENCE_DOGFOOD_DIR" \
  --verdict pass \
  --check-json '{"id":"dogfood-check","kind":"test","status":"pass","summary":"Should not write invalid metadata.","standard_refs":[{"standard":"unknown","ref":"bad-ref"}]}' \
  --summary "Should fail before evidence." >"$TMPDIR_EVAL/dogfood-invalid-evidence.out" 2>&1; then
  _fail "dogfood-pass should reject invalid evidence metadata before sidecar writes"
elif rg -q 'standard' "$TMPDIR_EVAL/dogfood-invalid-evidence.out" \
  && [[ ! -f "$INVALID_EVIDENCE_DOGFOOD_DIR/evidence.json" ]] \
  && cmp -s "$INVALID_EVIDENCE_DOGFOOD_DIR/state.json" "$TMPDIR_EVAL/dogfood-invalid-evidence-state.before" \
  && cmp -s "$INVALID_EVIDENCE_DOGFOOD_DIR/handoff.json" "$TMPDIR_EVAL/dogfood-invalid-evidence-handoff.before"; then
  _pass "dogfood-pass rejects invalid evidence metadata before partial sidecar writes"
else
  _fail "dogfood-pass invalid evidence metadata was not fail-closed"
fi

INVALID_LEARNING_DOGFOOD_DIR="$TMPDIR_EVAL/repo/.flow-agents/dogfood-invalid-learning"
mkdir -p "$INVALID_LEARNING_DOGFOOD_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$INVALID_LEARNING_DOGFOOD_DIR/dogfood-invalid-learning--deliver.md"
flow_agents_node "$WRITER" init-plan "$INVALID_LEARNING_DOGFOOD_DIR/dogfood-invalid-learning--deliver.md" \
  --source-request "Dogfood invalid learning fixture." \
  --summary "Dogfood invalid learning fixture." \
  --next-action "Run dogfood pass with invalid learning." \
  --timestamp "2026-05-09T00:00:00Z" >"$TMPDIR_EVAL/dogfood-invalid-learning-init.out" 2>"$TMPDIR_EVAL/dogfood-invalid-learning-init.err"
if flow_agents_node "$WRITER" dogfood-pass \
  --artifact-root "$SESSION_ROOT" \
  --artifact-dir "$INVALID_LEARNING_DOGFOOD_DIR" \
  --verdict pass \
  --check-json '{"id":"dogfood-check","kind":"test","status":"pass","summary":"Should not write before invalid learning."}' \
  --learning-status learned \
  --learning-record-json '{"id":"dogfood-invalid-learning","source_refs":["evidence.json"],"outcome":"mixed","facts":["Learning has open routing."],"interpretation":"Open routing cannot be learned.","routing":[{"target":"doc","action":"Close this follow-up later.","status":"open"}]}' \
  --learning-summary "Invalid learning should fail before writes." \
  --summary "Should fail before evidence." >"$TMPDIR_EVAL/dogfood-invalid-learning.out" 2>&1; then
  _fail "dogfood-pass should reject invalid learning before evidence writes"
elif rg -q 'learned status cannot have open learning routing' "$TMPDIR_EVAL/dogfood-invalid-learning.out" \
  && [[ ! -f "$INVALID_LEARNING_DOGFOOD_DIR/evidence.json" ]] \
  && [[ ! -f "$INVALID_LEARNING_DOGFOOD_DIR/learning.json" ]]; then
  _pass "dogfood-pass rejects invalid learning before partial sidecar writes"
else
  _fail "dogfood-pass invalid learning was not fail-closed"
fi

INVALID_LEARNING_SHAPE_DOGFOOD_DIR="$TMPDIR_EVAL/repo/.flow-agents/dogfood-invalid-learning-shape"
mkdir -p "$INVALID_LEARNING_SHAPE_DOGFOOD_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$INVALID_LEARNING_SHAPE_DOGFOOD_DIR/dogfood-invalid-learning-shape--deliver.md"
flow_agents_node "$WRITER" init-plan "$INVALID_LEARNING_SHAPE_DOGFOOD_DIR/dogfood-invalid-learning-shape--deliver.md" \
  --source-request "Dogfood invalid learning shape fixture." \
  --summary "Dogfood invalid learning shape fixture." \
  --next-action "Run dogfood pass with invalid learning shape." \
  --timestamp "2026-05-09T00:00:00Z" >"$TMPDIR_EVAL/dogfood-invalid-learning-shape-init.out" 2>"$TMPDIR_EVAL/dogfood-invalid-learning-shape-init.err"
if flow_agents_node "$WRITER" dogfood-pass \
  --artifact-root "$SESSION_ROOT" \
  --artifact-dir "$INVALID_LEARNING_SHAPE_DOGFOOD_DIR" \
  --verdict pass \
  --check-json '{"id":"dogfood-check","kind":"test","status":"pass","summary":"Should not write before invalid learning shape."}' \
  --learning-status learned \
  --learning-record-json '{"id":"dogfood-invalid-learning-shape","source_refs":"evidence.json","outcome":"success","facts":"Learning facts must be an array.","interpretation":"Invalid shape cannot be learned.","routing":[{"target":"doc","action":"Already closed.","status":"completed"}]}' \
  --learning-summary "Invalid learning shape should fail before writes." \
  --summary "Should fail before evidence." >"$TMPDIR_EVAL/dogfood-invalid-learning-shape.out" 2>&1; then
  _fail "dogfood-pass should reject invalid learning shape before evidence writes"
elif rg -q 'source_refs' "$TMPDIR_EVAL/dogfood-invalid-learning-shape.out" \
  && [[ ! -f "$INVALID_LEARNING_SHAPE_DOGFOOD_DIR/evidence.json" ]] \
  && [[ ! -f "$INVALID_LEARNING_SHAPE_DOGFOOD_DIR/learning.json" ]]; then
  _pass "dogfood-pass rejects invalid learning shape before partial sidecar writes"
else
  _fail "dogfood-pass invalid learning shape was not fail-closed"
fi

EXISTING_INVALID_LEARNING_DOGFOOD_DIR="$TMPDIR_EVAL/repo/.flow-agents/dogfood-existing-invalid-learning"
mkdir -p "$EXISTING_INVALID_LEARNING_DOGFOOD_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$EXISTING_INVALID_LEARNING_DOGFOOD_DIR/dogfood-existing-invalid-learning--deliver.md"
flow_agents_node "$WRITER" init-plan "$EXISTING_INVALID_LEARNING_DOGFOOD_DIR/dogfood-existing-invalid-learning--deliver.md" \
  --source-request "Dogfood existing invalid learning fixture." \
  --summary "Dogfood existing invalid learning fixture." \
  --next-action "Run dogfood pass against existing invalid learning." \
  --timestamp "2026-05-09T00:00:00Z" >"$TMPDIR_EVAL/dogfood-existing-invalid-learning-init.out" 2>"$TMPDIR_EVAL/dogfood-existing-invalid-learning-init.err"
cat > "$EXISTING_INVALID_LEARNING_DOGFOOD_DIR/learning.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "dogfood-existing-invalid-learning",
  "status": "learned",
  "updated_at": "2026-05-09T00:01:00Z",
  "records": [
    {
      "id": "existing-invalid-learning",
      "recorded_at": "2026-05-09T00:01:00Z",
      "source_refs": "evidence.json",
      "outcome": "success",
      "facts": [
        "Existing learning has invalid source_refs shape."
      ],
      "interpretation": "This should not be accepted by clean dogfood pass.",
      "routing": [
        {
          "target": "none",
          "action": "No follow-up.",
          "status": "completed"
        }
      ]
    }
  ]
}
JSON
cp "$EXISTING_INVALID_LEARNING_DOGFOOD_DIR/state.json" "$TMPDIR_EVAL/dogfood-existing-invalid-learning-state.before"
cp "$EXISTING_INVALID_LEARNING_DOGFOOD_DIR/handoff.json" "$TMPDIR_EVAL/dogfood-existing-invalid-learning-handoff.before"
if flow_agents_node "$WRITER" dogfood-pass \
  --artifact-root "$SESSION_ROOT" \
  --artifact-dir "$EXISTING_INVALID_LEARNING_DOGFOOD_DIR" \
  --verdict pass \
  --check-json '{"id":"dogfood-check","kind":"test","status":"pass","summary":"Should not write before existing invalid learning."}' \
  --summary "Should fail before evidence." >"$TMPDIR_EVAL/dogfood-existing-invalid-learning.out" 2>&1; then
  _fail "dogfood-pass should reject existing invalid learning before evidence writes"
elif rg -q 'source_refs' "$TMPDIR_EVAL/dogfood-existing-invalid-learning.out" \
  && [[ ! -f "$EXISTING_INVALID_LEARNING_DOGFOOD_DIR/evidence.json" ]] \
  && cmp -s "$EXISTING_INVALID_LEARNING_DOGFOOD_DIR/state.json" "$TMPDIR_EVAL/dogfood-existing-invalid-learning-state.before" \
  && cmp -s "$EXISTING_INVALID_LEARNING_DOGFOOD_DIR/handoff.json" "$TMPDIR_EVAL/dogfood-existing-invalid-learning-handoff.before"; then
  _pass "dogfood-pass rejects existing invalid learning before partial sidecar writes"
else
  _fail "dogfood-pass existing invalid learning was not fail-closed"
fi

EXISTING_LEARNED_NO_CORRECTION_DIR="$TMPDIR_EVAL/repo/.flow-agents/dogfood-learned-no-correction"
mkdir -p "$EXISTING_LEARNED_NO_CORRECTION_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$EXISTING_LEARNED_NO_CORRECTION_DIR/dogfood-learned-no-correction--deliver.md"
flow_agents_node "$WRITER" init-plan "$EXISTING_LEARNED_NO_CORRECTION_DIR/dogfood-learned-no-correction--deliver.md" \
  --source-request "Dogfood learned missing correction fixture." \
  --summary "Dogfood learned missing correction fixture." \
  --next-action "Run dogfood pass against terminal learning missing correction." \
  --timestamp "2026-05-09T00:00:00Z" >"$TMPDIR_EVAL/dogfood-learned-no-correction-init.out" 2>"$TMPDIR_EVAL/dogfood-learned-no-correction-init.err"
cat > "$EXISTING_LEARNED_NO_CORRECTION_DIR/learning.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "dogfood-learned-no-correction",
  "status": "learned",
  "updated_at": "2026-05-09T00:01:00Z",
  "records": [
    {
      "id": "learned-without-correction",
      "recorded_at": "2026-05-09T00:01:00Z",
      "source_refs": [
        "evidence.json"
      ],
      "outcome": "success",
      "facts": [
        "Existing learning is otherwise well-shaped."
      ],
      "interpretation": "Terminal learned records must include a correction or no-correction decision.",
      "routing": [
        {
          "target": "none",
          "action": "No follow-up.",
          "status": "completed"
        }
      ]
    }
  ]
}
JSON
cp "$EXISTING_LEARNED_NO_CORRECTION_DIR/state.json" "$TMPDIR_EVAL/dogfood-learned-no-correction-state.before"
cp "$EXISTING_LEARNED_NO_CORRECTION_DIR/handoff.json" "$TMPDIR_EVAL/dogfood-learned-no-correction-handoff.before"
if flow_agents_node "$WRITER" dogfood-pass \
  --artifact-root "$SESSION_ROOT" \
  --artifact-dir "$EXISTING_LEARNED_NO_CORRECTION_DIR" \
  --verdict pass \
  --check-json '{"id":"dogfood-check","kind":"test","status":"pass","summary":"Should not write before existing learned learning is corrected."}' \
  --summary "Should fail before evidence." >"$TMPDIR_EVAL/dogfood-learned-no-correction.out" 2>&1; then
  _fail "dogfood-pass should reject existing learned learning missing correction before evidence writes"
elif rg -q 'learning status learned requires every record to include correction.needed' "$TMPDIR_EVAL/dogfood-learned-no-correction.out" \
  && [[ ! -f "$EXISTING_LEARNED_NO_CORRECTION_DIR/evidence.json" ]] \
  && cmp -s "$EXISTING_LEARNED_NO_CORRECTION_DIR/state.json" "$TMPDIR_EVAL/dogfood-learned-no-correction-state.before" \
  && cmp -s "$EXISTING_LEARNED_NO_CORRECTION_DIR/handoff.json" "$TMPDIR_EVAL/dogfood-learned-no-correction-handoff.before"; then
  _pass "dogfood-pass rejects existing learned learning missing correction before partial sidecar writes"
else
  _fail "dogfood-pass existing learned learning missing correction was not fail-closed"
fi

INVALID_CRITIQUE_DOGFOOD_DIR="$TMPDIR_EVAL/repo/.flow-agents/dogfood-invalid-critique"
mkdir -p "$INVALID_CRITIQUE_DOGFOOD_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$INVALID_CRITIQUE_DOGFOOD_DIR/dogfood-invalid-critique--deliver.md"
flow_agents_node "$WRITER" init-plan "$INVALID_CRITIQUE_DOGFOOD_DIR/dogfood-invalid-critique--deliver.md" \
  --source-request "Dogfood invalid critique fixture." \
  --summary "Dogfood invalid critique fixture." \
  --next-action "Run dogfood pass with invalid critique metadata." \
  --timestamp "2026-05-09T00:00:00Z" >"$TMPDIR_EVAL/dogfood-invalid-critique-init.out" 2>"$TMPDIR_EVAL/dogfood-invalid-critique-init.err"
cp "$INVALID_CRITIQUE_DOGFOOD_DIR/state.json" "$TMPDIR_EVAL/dogfood-invalid-critique-state.before"
cp "$INVALID_CRITIQUE_DOGFOOD_DIR/handoff.json" "$TMPDIR_EVAL/dogfood-invalid-critique-handoff.before"
if flow_agents_node "$WRITER" dogfood-pass \
  --artifact-root "$SESSION_ROOT" \
  --artifact-dir "$INVALID_CRITIQUE_DOGFOOD_DIR" \
  --verdict pass \
  --check-json '{"id":"dogfood-check","kind":"test","status":"pass","summary":"Should not write before invalid critique."}' \
  --require-critique \
  --critique-id dogfood-invalid-critique \
  --critique-verdict pass \
  --critique-summary "Invalid critique finding metadata should fail before writes." \
  --finding-json '{"id":"invalid-file-refs","severity":"low","status":"fixed","description":"file_refs must be an array.","file_refs":"not-an-array"}' \
  --summary "Should fail before evidence." >"$TMPDIR_EVAL/dogfood-invalid-critique.out" 2>&1; then
  _fail "dogfood-pass should reject invalid critique metadata before evidence writes"
elif rg -q 'file_refs' "$TMPDIR_EVAL/dogfood-invalid-critique.out" \
  && [[ ! -f "$INVALID_CRITIQUE_DOGFOOD_DIR/evidence.json" ]] \
  && [[ ! -f "$INVALID_CRITIQUE_DOGFOOD_DIR/critique.json" ]] \
  && cmp -s "$INVALID_CRITIQUE_DOGFOOD_DIR/state.json" "$TMPDIR_EVAL/dogfood-invalid-critique-state.before" \
  && cmp -s "$INVALID_CRITIQUE_DOGFOOD_DIR/handoff.json" "$TMPDIR_EVAL/dogfood-invalid-critique-handoff.before"; then
  _pass "dogfood-pass rejects invalid critique metadata before partial sidecar writes"
else
  _fail "dogfood-pass invalid critique metadata was not fail-closed"
fi

EXISTING_INVALID_CRITIQUE_DOGFOOD_DIR="$TMPDIR_EVAL/repo/.flow-agents/dogfood-existing-invalid-critique"
mkdir -p "$EXISTING_INVALID_CRITIQUE_DOGFOOD_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$EXISTING_INVALID_CRITIQUE_DOGFOOD_DIR/dogfood-existing-invalid-critique--deliver.md"
flow_agents_node "$WRITER" init-plan "$EXISTING_INVALID_CRITIQUE_DOGFOOD_DIR/dogfood-existing-invalid-critique--deliver.md" \
  --source-request "Dogfood existing invalid critique fixture." \
  --summary "Dogfood existing invalid critique fixture." \
  --next-action "Run dogfood pass against existing invalid critique." \
  --timestamp "2026-05-09T00:00:00Z" >"$TMPDIR_EVAL/dogfood-existing-invalid-critique-init.out" 2>"$TMPDIR_EVAL/dogfood-existing-invalid-critique-init.err"
cat > "$EXISTING_INVALID_CRITIQUE_DOGFOOD_DIR/critique.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "dogfood-existing-invalid-critique",
  "status": "pass",
  "required": true,
  "updated_at": "2026-05-09T00:01:00Z",
  "critiques": [
    {
      "id": "existing-invalid-review",
      "reviewer": "tool-code-reviewer",
      "reviewed_at": "2026-05-09T00:01:00Z",
      "verdict": "pass",
      "summary": "Looks clean but has invalid finding shape.",
      "findings": [
        {
          "id": "invalid-existing-file-refs",
          "severity": "low",
          "status": "fixed",
          "description": "file_refs must be an array.",
          "file_refs": "not-an-array"
        }
      ]
    }
  ]
}
JSON
cp "$EXISTING_INVALID_CRITIQUE_DOGFOOD_DIR/state.json" "$TMPDIR_EVAL/dogfood-existing-invalid-critique-state.before"
cp "$EXISTING_INVALID_CRITIQUE_DOGFOOD_DIR/handoff.json" "$TMPDIR_EVAL/dogfood-existing-invalid-critique-handoff.before"
if flow_agents_node "$WRITER" dogfood-pass \
  --artifact-root "$SESSION_ROOT" \
  --artifact-dir "$EXISTING_INVALID_CRITIQUE_DOGFOOD_DIR" \
  --verdict pass \
  --check-json '{"id":"dogfood-check","kind":"test","status":"pass","summary":"Should not write before existing invalid critique."}' \
  --require-critique \
  --summary "Should fail before evidence." >"$TMPDIR_EVAL/dogfood-existing-invalid-critique.out" 2>&1; then
  _fail "dogfood-pass should reject existing invalid critique before evidence writes"
elif rg -q 'requires passing critique' "$TMPDIR_EVAL/dogfood-existing-invalid-critique.out" \
  && [[ ! -f "$EXISTING_INVALID_CRITIQUE_DOGFOOD_DIR/evidence.json" ]] \
  && cmp -s "$EXISTING_INVALID_CRITIQUE_DOGFOOD_DIR/state.json" "$TMPDIR_EVAL/dogfood-existing-invalid-critique-state.before" \
  && cmp -s "$EXISTING_INVALID_CRITIQUE_DOGFOOD_DIR/handoff.json" "$TMPDIR_EVAL/dogfood-existing-invalid-critique-handoff.before"; then
  _pass "dogfood-pass rejects existing invalid critique before partial sidecar writes"
else
  _fail "dogfood-pass existing invalid critique was not fail-closed"
fi

if flow_agents_node "$WRITER" dogfood-pass \
  --artifact-root "$SESSION_ROOT" \
  --artifact-dir "$DOGFOOD_DIR" \
  --verdict pass \
  --check-json '{"id":"dogfood-check","kind":"test","status":"pass","summary":"Dogfood check passed."}' \
  --require-critique \
  --summary "Should fail without critique." >"$TMPDIR_EVAL/dogfood-no-critique.out" 2>&1; then
  _fail "dogfood-pass should reject required critique gaps before writing evidence"
elif rg -q 'requires passing critique' "$TMPDIR_EVAL/dogfood-no-critique.out" \
  && [[ ! -f "$DOGFOOD_DIR/evidence.json" ]]; then
  _pass "dogfood-pass requires critique when configured without partial evidence writes"
else
  _fail "dogfood-pass critique requirement was not fail-closed"
fi

if flow_agents_node "$WRITER" dogfood-pass \
  --artifact-root "$SESSION_ROOT" \
  --artifact-dir "$SESSION_ROOT/dogfood-pas" \
  --verdict pass \
  --check-json '{"id":"dogfood-check","kind":"test","status":"pass","summary":"Should not write."}' \
  --summary "Should fail for typo artifact dir." >"$TMPDIR_EVAL/dogfood-bad-dir.out" 2>&1; then
  _fail "dogfood-pass should reject bad explicit artifact dirs"
elif rg -q 'artifact directory does not exist' "$TMPDIR_EVAL/dogfood-bad-dir.out" \
  && [[ ! -d "$SESSION_ROOT/dogfood-pas" ]]; then
  _pass "dogfood-pass rejects bad explicit artifact dirs without creating sidecars"
else
  _fail "dogfood-pass bad artifact dir failure was not fail-closed"
fi

OUTSIDE_DOGFOOD_DIR="$TMPDIR_EVAL/outside-dogfood"
mkdir -p "$OUTSIDE_DOGFOOD_DIR"
cat > "$OUTSIDE_DOGFOOD_DIR/outside--deliver.md" <<'MARKDOWN'
# Outside artifact

status: planning
type: deliver

## Plan

This should not be writable from a different artifact root.
MARKDOWN
if flow_agents_node "$WRITER" dogfood-pass \
  --artifact-root "$SESSION_ROOT" \
  --artifact-dir "$OUTSIDE_DOGFOOD_DIR" \
  --verdict pass \
  --check-json '{"id":"dogfood-check","kind":"test","status":"pass","summary":"Should not write."}' \
  --summary "Should fail outside root." >"$TMPDIR_EVAL/dogfood-outside-dir.out" 2>&1; then
  _fail "dogfood-pass should reject artifact dirs outside artifact root"
elif rg -q 'artifact directory must be under artifact root' "$TMPDIR_EVAL/dogfood-outside-dir.out" \
  && [[ ! -f "$OUTSIDE_DOGFOOD_DIR/evidence.json" ]]; then
  _pass "dogfood-pass rejects outside-root artifact dirs without writes"
else
  _fail "dogfood-pass outside-root failure was not fail-closed"
fi

DOGFOOD_SYMLINK_TARGET="$TMPDIR_EVAL/dogfood-symlink-target"
DOGFOOD_SYMLINK_DIR="$SESSION_ROOT/dogfood-symlink"
mkdir -p "$DOGFOOD_SYMLINK_TARGET"
if ln -s "$DOGFOOD_SYMLINK_TARGET" "$DOGFOOD_SYMLINK_DIR" 2>"$TMPDIR_EVAL/dogfood-symlink-create.err"; then
  if flow_agents_node "$WRITER" dogfood-pass \
    --artifact-root "$SESSION_ROOT" \
    --artifact-dir "$DOGFOOD_SYMLINK_DIR" \
    --verdict pass \
    --check-json '{"id":"dogfood-check","kind":"test","status":"pass","summary":"Should not write."}' \
    --summary "Should reject symlink artifact dir." >"$TMPDIR_EVAL/dogfood-symlink-dir.out" 2>&1; then
    _fail "dogfood-pass should reject symlink artifact dirs"
  elif rg -q 'artifact directory must not be a symlink' "$TMPDIR_EVAL/dogfood-symlink-dir.out" \
    && [[ ! -f "$DOGFOOD_SYMLINK_TARGET/evidence.json" ]]; then
    _pass "dogfood-pass rejects symlink artifact dirs without writes"
  else
    _fail "dogfood-pass symlink artifact-dir failure was not fail-closed"
  fi
else
  _pass "dogfood-pass symlink artifact-dir coverage skipped because symlink creation is unavailable: $(cat "$TMPDIR_EVAL/dogfood-symlink-create.err")"
fi

if flow_agents_node "$WRITER" dogfood-pass \
  --artifact-root "$SESSION_ROOT" \
  --artifact-dir "$DOGFOOD_DIR" \
  --verdict pass \
  --check-json '{"id":"dogfood-check","kind":"test","status":"pass","summary":"Should not write."}' \
  --require-critique \
  --critique-id dogfood-bad-json \
  --critique-summary "Invalid finding should fail before evidence." \
  --finding-json '{bad json' \
  --summary "Should fail before evidence." >"$TMPDIR_EVAL/dogfood-bad-finding.out" 2>&1; then
  _fail "dogfood-pass should reject invalid critique JSON before evidence writes"
elif rg -q -- '--finding-json must be valid JSON' "$TMPDIR_EVAL/dogfood-bad-finding.out" \
  && [[ ! -f "$DOGFOOD_DIR/evidence.json" ]]; then
  _pass "dogfood-pass rejects invalid critique JSON before partial evidence writes"
else
  _fail "dogfood-pass invalid critique JSON was not fail-closed"
fi

if flow_agents_node "$WRITER" dogfood-pass \
  --artifact-root "$SESSION_ROOT" \
  --artifact-dir "$DOGFOOD_DIR" \
  --verdict pass \
  --check-json '{"id":"dogfood-check","kind":"test","status":"pass","summary":"Should not write."}' \
  --require-critique \
  --critique-id dogfood-failing-review \
  --critique-verdict fail \
  --critique-summary "Failing critique should fail before evidence." \
  --summary "Should fail before evidence." >"$TMPDIR_EVAL/dogfood-failing-critique.out" 2>&1; then
  _fail "dogfood-pass should reject failing required critique before evidence writes"
elif rg -q 'requires clean critique before recording pass evidence' "$TMPDIR_EVAL/dogfood-failing-critique.out" \
  && [[ ! -f "$DOGFOOD_DIR/evidence.json" ]]; then
  _pass "dogfood-pass rejects failing required critique before partial evidence writes"
else
  _fail "dogfood-pass failing critique was not fail-closed"
fi

DIRTY_CRITIQUE_DOGFOOD_DIR="$TMPDIR_EVAL/repo/.flow-agents/dogfood-dirty-critique"
mkdir -p "$DIRTY_CRITIQUE_DOGFOOD_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$DIRTY_CRITIQUE_DOGFOOD_DIR/dogfood-dirty-critique--deliver.md"
flow_agents_node "$WRITER" init-plan "$DIRTY_CRITIQUE_DOGFOOD_DIR/dogfood-dirty-critique--deliver.md" \
  --source-request "Dogfood dirty critique fixture." \
  --summary "Dogfood dirty critique fixture." \
  --next-action "Run dogfood pass against existing open critique." \
  --timestamp "2026-05-09T00:00:00Z" >"$TMPDIR_EVAL/dogfood-dirty-init.out" 2>"$TMPDIR_EVAL/dogfood-dirty-init.err"
cat > "$DIRTY_CRITIQUE_DOGFOOD_DIR/critique.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "dogfood-dirty-critique",
  "status": "fail",
  "required": true,
  "updated_at": "2026-05-09T00:01:00Z",
  "critiques": [
    {
      "id": "existing-open-review",
      "reviewer": "tool-code-reviewer",
      "reviewed_at": "2026-05-09T00:01:00Z",
      "verdict": "fail",
      "summary": "Existing open finding blocks clean completion.",
      "findings": [
        {
          "severity": "high",
          "status": "open",
          "summary": "Existing finding remains open."
        }
      ]
    }
  ]
}
JSON
if flow_agents_node "$WRITER" dogfood-pass \
  --artifact-root "$SESSION_ROOT" \
  --artifact-dir "$DIRTY_CRITIQUE_DOGFOOD_DIR" \
  --verdict pass \
  --check-json '{"id":"dogfood-check","kind":"test","status":"pass","summary":"Should not write."}' \
  --require-critique \
  --critique-id dogfood-clean-review \
  --critique-verdict pass \
  --critique-summary "New critique is clean but prior critique is still open." \
  --summary "Should fail before evidence." >"$TMPDIR_EVAL/dogfood-existing-dirty-critique.out" 2>&1; then
  _fail "dogfood-pass should reject existing dirty critique before evidence writes"
elif rg -q 'requires clean critique before recording pass evidence' "$TMPDIR_EVAL/dogfood-existing-dirty-critique.out" \
  && [[ ! -f "$DIRTY_CRITIQUE_DOGFOOD_DIR/evidence.json" ]]; then
  _pass "dogfood-pass rejects existing dirty critique before partial evidence writes"
else
  _fail "dogfood-pass existing dirty critique was not fail-closed"
fi

FAILED_DOGFOOD_DIR="$TMPDIR_EVAL/repo/.flow-agents/dogfood-failed-pass"
mkdir -p "$FAILED_DOGFOOD_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$FAILED_DOGFOOD_DIR/dogfood-failed-pass--deliver.md"
flow_agents_node "$WRITER" init-plan "$FAILED_DOGFOOD_DIR/dogfood-failed-pass--deliver.md" \
  --source-request "Dogfood failed pass fixture." \
  --summary "Dogfood failed pass fixture." \
  --next-action "Record failed dogfood pass." \
  --timestamp "2026-05-09T00:00:00Z" >"$TMPDIR_EVAL/dogfood-failed-init.out" 2>"$TMPDIR_EVAL/dogfood-failed-init.err"
if flow_agents_node "$WRITER" dogfood-pass \
  --artifact-root "$SESSION_ROOT" \
  --artifact-dir "$FAILED_DOGFOOD_DIR" \
  --verdict fail \
  --check-json '{"id":"dogfood-failed-check","kind":"test","status":"fail","summary":"Dogfood check failed."}' \
  --require-critique \
  --critique-id dogfood-failed-review \
  --critique-verdict fail \
  --critique-summary "Failed critique should be recorded for routing." \
  --finding-json '{"id":"failed-dogfood-finding","severity":"high","status":"open","description":"Failed dogfood finding remains open."}' \
  --summary "Dogfood pass failed and should route back to execution." \
  --timestamp "2026-05-09T00:04:30Z" >"$TMPDIR_EVAL/dogfood-failed-pass.out" 2>"$TMPDIR_EVAL/dogfood-failed-pass.err"; then
  _pass "dogfood-pass records failed evidence and failing critique for routing"
else
  _fail "dogfood-pass should allow honest failed records: $(cat "$TMPDIR_EVAL/dogfood-failed-pass.out" "$TMPDIR_EVAL/dogfood-failed-pass.err")"
fi

if rg -q '"verdict": "fail"' "$FAILED_DOGFOOD_DIR/evidence.json" \
  && rg -q '"status": "fail"' "$FAILED_DOGFOOD_DIR/critique.json" \
  && rg -q '"status": "failed"' "$FAILED_DOGFOOD_DIR/state.json" \
  && rg -q 'Required dogfood critique is not passing' "$FAILED_DOGFOOD_DIR/handoff.json"; then
  _pass "dogfood-pass failed records preserve failed state and blockers"
else
  _fail "dogfood-pass failed record did not preserve routing state"
fi

if flow_agents_node "$VALIDATOR" --require-sidecars --require-critique "$FAILED_DOGFOOD_DIR" >"$TMPDIR_EVAL/dogfood-failed-valid.out" 2>"$TMPDIR_EVAL/dogfood-failed-valid.err"; then
  _fail "strict validator should still reject failed required critique"
elif rg -q 'required critique must pass' "$TMPDIR_EVAL/dogfood-failed-valid.out" "$TMPDIR_EVAL/dogfood-failed-valid.err"; then
  _pass "dogfood-pass failed records remain visibly blocked under strict validation"
else
  _fail "dogfood-pass failed record strict validation did not expose critique blocker"
fi

if flow_agents_node "$WRITER" dogfood-pass \
  --artifact-root "$SESSION_ROOT" \
  --artifact-dir "$DOGFOOD_DIR" \
  --verdict pass \
  --check-json '{"id":"dogfood-check","kind":"test","status":"pass","summary":"Dogfood check passed.","artifact_refs":[{"kind":"artifact","file":"dogfood-pass--deliver.md","summary":"Dogfood pass deliver artifact."}]}' \
  --require-critique \
  --critique-id dogfood-review \
  --reviewer tool-code-reviewer \
  --critique-verdict pass \
  --critique-summary "Dogfood critique passed." \
  --learning-record-json '{"id":"dogfood-learning","source_refs":["evidence.json","critique.json"],"outcome":"success","facts":["Dogfood pass command recorded evidence and critique."],"interpretation":"Dogfood pass can close a clean local loop.","routing":[{"target":"none","action":"No follow-up required.","status":"completed"}],"correction":{"needed":false,"evidence":"Evidence, critique, and learning matched intended dogfood behavior."}}' \
  --learning-summary "Dogfood command learning recorded." \
  --summary "Dogfood pass completed." \
  --timestamp "2026-05-09T00:05:00Z" >"$TMPDIR_EVAL/dogfood-pass.out" 2>"$TMPDIR_EVAL/dogfood-pass.err"; then
  _pass "sidecar writer records dogfood pass"
else
  _fail "dogfood-pass failed: $(cat "$TMPDIR_EVAL/dogfood-pass.out" "$TMPDIR_EVAL/dogfood-pass.err")"
fi

if rg -q '"state_status": "verified"' "$TMPDIR_EVAL/dogfood-pass.out" \
  && rg -q '"status": "pass"' "$DOGFOOD_DIR/critique.json" \
  && rg -q '"status": "learned"' "$DOGFOOD_DIR/learning.json" \
  && rg -q '"status": "verified"' "$DOGFOOD_DIR/state.json"; then
  _pass "dogfood-pass writes clean evidence, critique, learning, and state"
else
  _fail "dogfood-pass did not produce expected clean sidecars"
fi

if flow_agents_node "$VALIDATOR" --require-sidecars --require-critique "$DOGFOOD_DIR" >"$TMPDIR_EVAL/dogfood-valid.out" 2>"$TMPDIR_EVAL/dogfood-valid.err"; then
  _pass "dogfood-pass output passes strict sidecar validation"
else
  _fail "dogfood-pass output failed validation: $(cat "$TMPDIR_EVAL/dogfood-valid.out" "$TMPDIR_EVAL/dogfood-valid.err")"
fi

if flow_agents_node "$WRITER" dogfood-pass \
  --artifact-root "$SESSION_ROOT" \
  --artifact-dir "$DOGFOOD_DIR" \
  --verdict pass \
  --check-json '{"id":"dogfood-release-fail-check","kind":"test","status":"pass","summary":"Dogfood release failure fixture check passed."}' \
  --critique-id dogfood-release-failing-review \
  --reviewer tool-code-reviewer \
  --critique-verdict fail \
  --critique-summary "Dogfood release critique failed." \
  --finding-json '{"id":"dogfood-release-finding","severity":"high","status":"open","description":"Release readiness must not ignore failing critique."}' \
  --release-decision merge \
  --release-scope "Dogfood pass release readiness should fail." \
  --summary "Dogfood pass release readiness should be blocked." \
  --timestamp "2026-05-09T00:05:20Z" >"$TMPDIR_EVAL/dogfood-release-fail.out" 2>"$TMPDIR_EVAL/dogfood-release-fail.err"; then
  _fail "dogfood-pass release readiness should reject failing critique even when critique is not explicitly required"
elif rg -q 'requires clean critique' "$TMPDIR_EVAL/dogfood-release-fail.out" "$TMPDIR_EVAL/dogfood-release-fail.err" \
  && [[ ! -f "$DOGFOOD_DIR/release.json" ]] \
  && rg -q '"status": "verified"' "$DOGFOOD_DIR/state.json"; then
  _pass "dogfood-pass release readiness requires clean critique"
else
  _fail "dogfood-pass release readiness failing critique was not fail-closed"
fi

if flow_agents_node "$WRITER" dogfood-pass \
  --artifact-root "$SESSION_ROOT" \
  --artifact-dir "$DOGFOOD_DIR" \
  --verdict pass \
  --check-json '{"id":"dogfood-release-check","kind":"test","status":"pass","summary":"Dogfood release check passed.","artifact_refs":[{"kind":"artifact","file":"dogfood-pass--deliver.md","summary":"Dogfood pass deliver artifact."}]}' \
  --require-critique \
  --critique-id dogfood-release-review \
  --reviewer tool-code-reviewer \
  --critique-verdict pass \
  --critique-summary "Dogfood release critique passed." \
  --release-decision merge \
  --release-scope "Dogfood pass release readiness." \
  --release-summary "Dogfood pass can record release readiness after clean evidence and critique." \
  --release-doc-ref docs/workflow-usage-guide.md \
  --summary "Dogfood pass release readiness completed." \
  --timestamp "2026-05-09T00:05:30Z" >"$TMPDIR_EVAL/dogfood-release.out" 2>"$TMPDIR_EVAL/dogfood-release.err"; then
  _pass "dogfood-pass records release readiness after clean pass"
else
  _fail "dogfood-pass release readiness failed: $(cat "$TMPDIR_EVAL/dogfood-release.out" "$TMPDIR_EVAL/dogfood-release.err")"
fi

if rg -q '"release_decision": "merge"' "$TMPDIR_EVAL/dogfood-release.out" \
  && rg -q '"decision": "merge"' "$DOGFOOD_DIR/release.json" \
  && rg -q '"phase": "release"' "$DOGFOOD_DIR/state.json"; then
  _pass "dogfood-pass release readiness updates release sidecar and state"
else
  _fail "dogfood-pass release readiness did not update expected sidecars"
fi

DOGFOOD_NV_DIR="$TMPDIR_EVAL/repo/.flow-agents/dogfood-not-verified"
mkdir -p "$DOGFOOD_NV_DIR"
cat > "$DOGFOOD_NV_DIR/dogfood-not-verified--deliver.md" <<'MARKDOWN'
# Dogfood not verified fixture

status: needs-decision
type: deliver

## Plan

Record a dogfood pass with explicit not verified evidence.

## Definition Of Done

- **User outcome:** Dogfood pass preserves not verified evidence.
- **Scope:** Dogfood not verified fixture.
- **Acceptance criteria:**
  - [x] Not verified evidence is preserved - Evidence: evidence.json
- **Usefulness checks:**
  - [x] Unknown, NOT_VERIFIED, and TODO gaps are resolved or explicitly accepted
- **Stop-short risks:** Not verified evidence could be hidden as pass.
- **Durable docs target:** not needed
- **Sandbox mode:** local-edit

## Verification Report

Build: [NOT_VERIFIED] external live runtime unavailable

### Acceptance Criteria
- [NOT_VERIFIED] Not verified evidence is preserved - Evidence: external live runtime unavailable.

### Verdict: NOT_VERIFIED

## Goal Fit Gate

- [x] Original user goal restated
- [ ] Every acceptance criterion has evidence

## Final Acceptance

- [ ] CI/relevant checks passed
MARKDOWN
flow_agents_node "$WRITER" init-plan "$DOGFOOD_NV_DIR/dogfood-not-verified--deliver.md" \
  --source-request "Dogfood not verified fixture." \
  --summary "Dogfood not verified fixture." \
  --next-action "Record not verified dogfood pass." \
  --timestamp "2026-05-09T00:00:00Z" >"$TMPDIR_EVAL/dogfood-nv-init.out" 2>"$TMPDIR_EVAL/dogfood-nv-init.err"

if flow_agents_node "$WRITER" dogfood-pass \
  --artifact-root "$SESSION_ROOT" \
  --artifact-dir "$DOGFOOD_NV_DIR" \
  --verdict not_verified \
  --check-json '{"id":"dogfood-external","kind":"external","status":"not_verified","summary":"External live runtime was unavailable."}' \
  --gap "External live runtime unavailable." \
  --summary "Dogfood pass preserved not verified evidence." \
  --timestamp "2026-05-09T00:06:00Z" >"$TMPDIR_EVAL/dogfood-nv.out" 2>"$TMPDIR_EVAL/dogfood-nv.err" \
  && rg -q '"verdict": "not_verified"' "$DOGFOOD_NV_DIR/evidence.json" \
  && rg -q '"state_status": "not_verified"' "$TMPDIR_EVAL/dogfood-nv.out" \
  && rg -q '"External live runtime unavailable."' "$DOGFOOD_NV_DIR/evidence.json"; then
  _pass "dogfood-pass preserves NOT_VERIFIED evidence and routing"
else
  _fail "dogfood-pass did not preserve not verified evidence: $(cat "$TMPDIR_EVAL/dogfood-nv.out" "$TMPDIR_EVAL/dogfood-nv.err")"
fi

if flow_agents_node "$WRITER" record-release "$ARTIFACT_DIR" \
  --decision launch \
  --scope "Invalid release fixture." \
  --gate-json '{"name":"merge","status":"pass","summary":"Should fail."}' \
  --rollback-json '{"status":"not_required","summary":"Should fail.","owner":"codex"}' \
  --observability-json '{"status":"not_required","summary":"Should fail."}' \
  --docs-json '{"status":"not_needed","summary":"Should fail."}' \
  --summary "Should fail." >"$TMPDIR_EVAL/release-invalid.out" 2>&1; then
  _fail "sidecar writer should reject invalid release decisions"
elif rg -q 'decision must be one of' "$TMPDIR_EVAL/release-invalid.out"; then
  _pass "sidecar writer rejects invalid release decisions"
else
  _fail "invalid release decision failure was not actionable"
fi

SEMANTIC_RELEASE_DIR="$TMPDIR_EVAL/repo/.flow-agents/semantic-release"
mkdir -p "$SEMANTIC_RELEASE_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$SEMANTIC_RELEASE_DIR/semantic-release--deliver.md"
flow_agents_node "$WRITER" init-plan "$SEMANTIC_RELEASE_DIR/semantic-release--deliver.md" \
  --source-request "Semantic release failure fixture." \
  --summary "Semantic release failure fixture." \
  --next-action "Record evidence." \
  --timestamp "2026-05-09T00:00:00Z" >"$TMPDIR_EVAL/semantic-release-init.out" 2>"$TMPDIR_EVAL/semantic-release-init.err"
flow_agents_node "$WRITER" record-evidence "$SEMANTIC_RELEASE_DIR" \
  --verdict pass \
  --check-json '{"id":"semantic-release-fixture","kind":"test","status":"pass","summary":"Semantic release setup passed."}' \
  --timestamp "2026-05-09T00:01:00Z" >"$TMPDIR_EVAL/semantic-release-evidence.out" 2>"$TMPDIR_EVAL/semantic-release-evidence.err"

if flow_agents_node "$WRITER" record-release "$SEMANTIC_RELEASE_DIR" \
  --decision merge \
  --scope "Semantic release fixture." \
  --gate-json '{"name":"docs","status":"pass","summary":"Docs passed but merge gate is missing."}' \
  --rollback-json '{"status":"not_required","summary":"No deployed runtime change.","owner":"codex"}' \
  --observability-json '{"status":"not_required","summary":"No production telemetry needed."}' \
  --docs-json '{"status":"updated","summary":"Docs are updated."}' \
  --summary "Should fail before state advances." >"$TMPDIR_EVAL/semantic-release-invalid.out" 2>&1; then
  _fail "sidecar writer should reject semantically invalid release decisions"
elif rg -q 'positive release decision requires merge gate to pass' "$TMPDIR_EVAL/semantic-release-invalid.out" \
  && rg -q '"phase": "verification"' "$SEMANTIC_RELEASE_DIR/state.json"; then
  _pass "sidecar writer does not advance state after invalid release semantics"
else
  _fail "semantic release failure advanced state or lacked actionable output"
fi

if flow_agents_node "$WRITER" record-learning "$ARTIFACT_DIR" \
  --status learned \
  --record-json '{"id":"bad-learning","source_refs":["release.json"],"outcome":"celebration","facts":["Should fail."],"interpretation":"Should fail.","routing":[{"target":"doc","action":"Should fail.","status":"completed"}]}' \
  --summary "Should fail." >"$TMPDIR_EVAL/learning-invalid.out" 2>&1; then
  _fail "sidecar writer should reject invalid learning outcomes"
elif rg -q 'learning outcome must be one of' "$TMPDIR_EVAL/learning-invalid.out"; then
  _pass "sidecar writer rejects invalid learning outcomes"
else
  _fail "invalid learning outcome failure was not actionable"
fi

if flow_agents_node "$WRITER" record-learning "$ARTIFACT_DIR" \
  --status followup_required \
  --record-json '{"id":"bad-correction-recurrence","source_refs":["release.json"],"outcome":"mixed","facts":["Should fail."],"interpretation":"Should fail.","routing":[{"target":"skill","action":"Should fail.","status":"open"}],"correction":{"needed":true,"type":"workflow","intended_behavior":"A recurrence key is recorded.","observed_behavior":"The recurrence key is missing.","gap":"Grouping would be impossible.","prevention":{"target":"skill","action":"Should fail.","status":"open"}}}' \
  --summary "Should fail." >"$TMPDIR_EVAL/correction-missing-recurrence.out" 2>&1; then
  _fail "sidecar writer should reject correction-needed records without recurrence key"
elif rg -q 'correction.recurrence_key is required' "$TMPDIR_EVAL/correction-missing-recurrence.out"; then
  _pass "sidecar writer rejects correction-needed records without recurrence key"
else
  detail="$(cat "$TMPDIR_EVAL/correction-missing-recurrence.out")"
  _fail "missing correction recurrence key failure was not actionable: $detail"
fi

if flow_agents_node "$WRITER" record-learning "$ARTIFACT_DIR" \
  --status followup_required \
  --record-json '{"id":"bad-correction-prevention","source_refs":["release.json"],"outcome":"mixed","facts":["Should fail."],"interpretation":"Should fail.","routing":[{"target":"none","action":"Should fail.","status":"completed"}],"correction":{"needed":true,"type":"workflow","recurrence_key":"learning-review.missing-prevention","intended_behavior":"A prevention route or no-change rationale is recorded.","observed_behavior":"Neither decision is present.","gap":"The mismatch has no closeout decision."}}' \
  --summary "Should fail." >"$TMPDIR_EVAL/correction-missing-prevention.out" 2>&1; then
  _fail "sidecar writer should reject correction-needed records without prevention or no-change rationale"
elif rg -q 'correction requires prevention route or no_change_rationale' "$TMPDIR_EVAL/correction-missing-prevention.out"; then
  _pass "sidecar writer rejects correction-needed records without prevention or no-change rationale"
else
  detail="$(cat "$TMPDIR_EVAL/correction-missing-prevention.out")"
  _fail "missing correction prevention failure was not actionable: $detail"
fi

if flow_agents_node "$WRITER" record-learning "$ARTIFACT_DIR" \
  --status followup_required \
  --record-json '{"id":"bad-correction-prevention-shape","source_refs":["release.json"],"outcome":"mixed","facts":["Should fail."],"interpretation":"Should fail.","routing":[{"target":"none","action":"Should fail.","status":"completed"}],"correction":{"needed":true,"type":"workflow","recurrence_key":"learning-review.incomplete-prevention","intended_behavior":"A complete prevention route is recorded.","observed_behavior":"Prevention only named an action.","gap":"The prevention route was not actionable.","prevention":{"action":"Should fail."}}}' \
  --summary "Should fail." >"$TMPDIR_EVAL/correction-incomplete-prevention.out" 2>&1; then
  _fail "sidecar writer should reject incomplete correction prevention routes"
elif rg -q 'correction.prevention.target is required' "$TMPDIR_EVAL/correction-incomplete-prevention.out"; then
  _pass "sidecar writer rejects incomplete correction prevention routes"
else
  _fail "incomplete correction prevention failure was not actionable: $(cat "$TMPDIR_EVAL/correction-incomplete-prevention.out")"
fi

SEMANTIC_LEARNING_DIR="$TMPDIR_EVAL/repo/.flow-agents/semantic-learning"
mkdir -p "$SEMANTIC_LEARNING_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$SEMANTIC_LEARNING_DIR/semantic-learning--deliver.md"
flow_agents_node "$WRITER" init-plan "$SEMANTIC_LEARNING_DIR/semantic-learning--deliver.md" \
  --source-request "Semantic learning failure fixture." \
  --summary "Semantic learning failure fixture." \
  --next-action "Record evidence." \
  --timestamp "2026-05-09T00:00:00Z" >"$TMPDIR_EVAL/semantic-learning-init.out" 2>"$TMPDIR_EVAL/semantic-learning-init.err"
flow_agents_node "$WRITER" record-evidence "$SEMANTIC_LEARNING_DIR" \
  --verdict pass \
  --check-json '{"id":"semantic-learning-fixture","kind":"test","status":"pass","summary":"Semantic learning setup passed."}' \
  --timestamp "2026-05-09T00:01:00Z" >"$TMPDIR_EVAL/semantic-learning-evidence.out" 2>"$TMPDIR_EVAL/semantic-learning-evidence.err"
flow_agents_node "$WRITER" record-release "$SEMANTIC_LEARNING_DIR" \
  --decision merge \
  --scope "Semantic learning fixture." \
  --gate-json '{"name":"merge","status":"pass","summary":"Merge gate passed."}' \
  --rollback-json '{"status":"not_required","summary":"No deployed runtime change.","owner":"codex"}' \
  --observability-json '{"status":"not_required","summary":"No production telemetry needed."}' \
  --docs-json '{"status":"updated","summary":"Docs are updated."}' \
  --summary "Release state exists before learning failure." \
  --timestamp "2026-05-09T00:02:00Z" >"$TMPDIR_EVAL/semantic-learning-release.out" 2>"$TMPDIR_EVAL/semantic-learning-release.err"

if flow_agents_node "$WRITER" record-learning "$SEMANTIC_LEARNING_DIR" \
  --status learned \
  --record-json '{"id":"open-routing","source_refs":["release.json"],"outcome":"success","facts":["Should fail."],"interpretation":"Should fail before archiving.","routing":[{"target":"backlog","action":"Route open follow-up.","status":"open"}]}' \
  --summary "Should fail before state advances." >"$TMPDIR_EVAL/semantic-learning-invalid.out" 2>&1; then
  _fail "sidecar writer should reject semantically invalid learning records"
elif rg -q 'learning status learned cannot have open routing' "$TMPDIR_EVAL/semantic-learning-invalid.out" \
  && rg -q '"phase": "release"' "$SEMANTIC_LEARNING_DIR/state.json"; then
  _pass "sidecar writer does not archive state after invalid learning semantics"
else
  _fail "semantic learning failure advanced state or lacked actionable output"
fi

REVIEW_DIR="$TMPDIR_EVAL/repo/.flow-agents/imported-critique"
mkdir -p "$REVIEW_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$REVIEW_DIR/imported-critique--deliver.md"
flow_agents_node "$WRITER" init-plan "$REVIEW_DIR/imported-critique--deliver.md" \
  --source-request "Imported critique fixture." \
  --summary "Imported critique fixture." \
  --next-action "Import critique." \
  --timestamp "2026-05-09T00:00:00Z" >"$TMPDIR_EVAL/import-init.out" 2>"$TMPDIR_EVAL/import-init.err"
flow_agents_node "$WRITER" record-evidence "$REVIEW_DIR" \
  --verdict pass \
  --check-json '{"id":"import-fixture","kind":"test","status":"pass","summary":"Import fixture setup passed."}' \
  --timestamp "2026-05-09T00:01:00Z" >"$TMPDIR_EVAL/import-evidence.out" 2>"$TMPDIR_EVAL/import-evidence.err"
cat > "$REVIEW_DIR/imported-critique--review.md" <<'MARKDOWN'
---
role: code-review
parent: imported-critique--deliver
created: 2026-05-09T00:02:00Z
verdict: PASS
---

## Code Review

Findings: 1 LOW

### Findings

#### [LOW] src/cli/workflow-sidecar.ts - Minor style note
This finding was already addressed before import.

### Verdict: PASS
MARKDOWN

if flow_agents_node "$WRITER" import-critique "$REVIEW_DIR" "$REVIEW_DIR/imported-critique--review.md" \
  --finding-status fixed >"$TMPDIR_EVAL/import-critique.out" 2>"$TMPDIR_EVAL/import-critique.err"; then
  _pass "sidecar writer imports passing critique artifact"
else
  _fail "sidecar writer import critique failed: $(cat "$TMPDIR_EVAL/import-critique.out" "$TMPDIR_EVAL/import-critique.err")"
fi

if rg -q '"id": "minor-style-note"' "$REVIEW_DIR/critique.json" && rg -q '"status": "fixed"' "$REVIEW_DIR/critique.json"; then
  _pass "sidecar writer extracts review findings"
else
  _fail "sidecar writer did not extract review findings"
fi

cat > "$REVIEW_DIR/unrelated-note.md" <<'MARKDOWN'
# Unrelated Note

This is ordinary Markdown and must not satisfy required critique.
MARKDOWN

if flow_agents_node "$WRITER" import-critique "$REVIEW_DIR" "$REVIEW_DIR/unrelated-note.md" >"$TMPDIR_EVAL/import-unrelated.out" 2>&1; then
  _fail "sidecar writer should reject non-review Markdown imports"
elif rg -q 'review artifact must declare role' "$TMPDIR_EVAL/import-unrelated.out"; then
  _pass "sidecar writer rejects non-review Markdown imports"
else
  _fail "non-review import failure was not actionable"
fi

if flow_agents_node "$VALIDATOR" --require-sidecars --require-critique "$ARTIFACT_DIR" >"$TMPDIR_EVAL/valid.out" 2>"$TMPDIR_EVAL/valid.err"; then
  _pass "writer output passes strict sidecar validation"
else
  _fail "writer output failed validation: $(cat "$TMPDIR_EVAL/valid.out" "$TMPDIR_EVAL/valid.err")"
fi

BAD_DIR="$TMPDIR_EVAL/repo/.flow-agents/bad-critique"
mkdir -p "$BAD_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$BAD_DIR/bad-critique--deliver.md"

flow_agents_node "$WRITER" init-plan "$BAD_DIR/bad-critique--deliver.md" \
  --source-request "Bad critique fixture." \
  --summary "Bad critique fixture." \
  --next-action "Record evidence." \
  --timestamp "2026-05-09T00:00:00Z" >"$TMPDIR_EVAL/bad-init.out" 2>"$TMPDIR_EVAL/bad-init.err"
flow_agents_node "$WRITER" record-evidence "$BAD_DIR" \
  --verdict pass \
  --check-json '{"id":"bad-fixture","kind":"test","status":"pass","summary":"Bad fixture setup passed."}' \
  --timestamp "2026-05-09T00:01:00Z" >"$TMPDIR_EVAL/bad-evidence.out" 2>"$TMPDIR_EVAL/bad-evidence.err"

if flow_agents_node "$WRITER" record-critique "$BAD_DIR" \
  --id bad-review \
  --reviewer tool-code-reviewer \
  --verdict pass \
  --summary "Open finding should fail." \
  --finding-json '{"id":"open-medium","severity":"medium","status":"open","description":"Open finding."}' \
  --timestamp "2026-05-09T00:02:00Z" >"$TMPDIR_EVAL/bad-critique.out" 2>&1; then
  _fail "sidecar writer should reject open critique findings"
elif rg -q 'required critique must pass' "$TMPDIR_EVAL/bad-critique.out"; then
  _pass "sidecar writer rejects open critique findings"
else
  _fail "open critique failure did not mention open findings"
fi

IMPORT_BAD="$TMPDIR_EVAL/repo/.flow-agents/imported-bad-critique"
mkdir -p "$IMPORT_BAD"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$IMPORT_BAD/imported-bad-critique--deliver.md"
flow_agents_node "$WRITER" init-plan "$IMPORT_BAD/imported-bad-critique--deliver.md" \
  --source-request "Bad imported critique fixture." \
  --summary "Bad imported critique fixture." \
  --next-action "Import failing critique." \
  --timestamp "2026-05-09T00:00:00Z" >"$TMPDIR_EVAL/import-bad-init.out" 2>"$TMPDIR_EVAL/import-bad-init.err"
flow_agents_node "$WRITER" record-evidence "$IMPORT_BAD" \
  --verdict pass \
  --check-json '{"id":"import-bad-fixture","kind":"test","status":"pass","summary":"Bad import fixture setup passed."}' \
  --timestamp "2026-05-09T00:01:00Z" >"$TMPDIR_EVAL/import-bad-evidence.out" 2>"$TMPDIR_EVAL/import-bad-evidence.err"
cat > "$IMPORT_BAD/imported-bad-critique--review.md" <<'MARKDOWN'
---
role: code-review
parent: imported-bad-critique--deliver
created: 2026-05-09T00:02:00Z
verdict: CHANGES_REQUESTED
---

## Code Review

Findings: 1 HIGH

### Findings

#### [HIGH] src/cli/workflow-sidecar.ts - Imported blocker
This finding should keep required critique from passing.

### Verdict: CHANGES_REQUESTED
MARKDOWN

if flow_agents_node "$WRITER" import-critique "$IMPORT_BAD" "$IMPORT_BAD/imported-bad-critique--review.md" >"$TMPDIR_EVAL/import-bad-critique.out" 2>&1; then
  _fail "sidecar writer should reject imported failing critique"
elif rg -q 'required critique must pass' "$TMPDIR_EVAL/import-bad-critique.out" && rg -q '"id": "imported-blocker"' "$IMPORT_BAD/critique.json"; then
  _pass "sidecar writer persists and rejects imported failing critique"
else
  _fail "imported failing critique did not persist actionable finding"
fi

if [[ "$errors" -eq 0 ]]; then
  echo "Workflow sidecar writer integration passed."
  exit 0
fi

echo "Workflow sidecar writer integration failed: $errors issue(s)."
exit 1
