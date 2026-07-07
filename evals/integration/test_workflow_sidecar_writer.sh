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
ARTIFACT_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/auto-sidecars"
mkdir -p "$ARTIFACT_DIR"

DEFAULT_ROOT_REPO="$TMPDIR_EVAL/default-root-repo"
mkdir -p "$DEFAULT_ROOT_REPO"
if (cd "$DEFAULT_ROOT_REPO" && flow_agents_node "$WRITER" ensure-session \
  --task-slug default-root \
  --title "Default Root" \
  --summary "Default root should use the Kontour runtime artifact home." \
  --criterion "Default root exists" \
  --timestamp "2026-05-09T00:00:00Z" >"$TMPDIR_EVAL/default-root.out" 2>"$TMPDIR_EVAL/default-root.err"); then
  if [[ -f "$DEFAULT_ROOT_REPO/.kontourai/flow-agents/default-root/state.json" ]] \
    && [[ -f "$DEFAULT_ROOT_REPO/.kontourai/flow-agents/current.json" ]] \
    && [[ ! -e "$DEFAULT_ROOT_REPO/.flow-agents/default-root/state.json" ]]; then
    _pass "sidecar writer defaults new sessions to .kontourai/flow-agents"
  else
    _fail "sidecar writer default root did not use .kontourai/flow-agents"
  fi
else
  _fail "sidecar writer default-root ensure-session failed: $(cat "$TMPDIR_EVAL/default-root.out" "$TMPDIR_EVAL/default-root.err")"
fi

PREVIOUS_ROOT_REPO="$TMPDIR_EVAL/previous-root-repo"
mkdir -p "$PREVIOUS_ROOT_REPO/.flow-agents/previous-session"
cat > "$PREVIOUS_ROOT_REPO/.flow-agents/current.json" <<'JSON'
{"schema_version":"1.0","active_slug":"previous-session","artifact_dir":"previous-session"}
JSON
cat > "$PREVIOUS_ROOT_REPO/.flow-agents/previous-session/state.json" <<'JSON'
{"schema_version":"1.0","task_slug":"previous-session","status":"planned","phase":"planning","next_action":{"status":"continue","summary":"continue"}}
JSON
if (cd "$PREVIOUS_ROOT_REPO" && flow_agents_node "$WRITER" current --format slug >"$TMPDIR_EVAL/previous-current.out" 2>"$TMPDIR_EVAL/previous-current.err"); then
  _fail "sidecar writer default current unexpectedly read previous .flow-agents runtime root: $(cat "$TMPDIR_EVAL/previous-current.out")"
else
  _pass "sidecar writer does not fall back to previous .flow-agents runtime root"
fi

if (cd "$PREVIOUS_ROOT_REPO" && flow_agents_node "$WRITER" current --artifact-root "$PREVIOUS_ROOT_REPO/.flow-agents" --format slug >"$TMPDIR_EVAL/previous-current-explicit.out" 2>"$TMPDIR_EVAL/previous-current-explicit.err") \
  && [[ "$(cat "$TMPDIR_EVAL/previous-current-explicit.out")" == "previous-session" ]]; then
  _pass "sidecar writer reads explicitly supplied artifact root"
else
  _fail "sidecar writer did not read explicit artifact root: $(cat "$TMPDIR_EVAL/previous-current-explicit.out" "$TMPDIR_EVAL/previous-current-explicit.err")"
fi

TRAVERSAL_ROOT="$TMPDIR_EVAL/traversal-repo/.kontourai/flow-agents"
TRAVERSAL_OUTSIDE="$TMPDIR_EVAL/traversal-outside-existing"
mkdir -p "$TRAVERSAL_ROOT" "$TRAVERSAL_OUTSIDE"
node - "$TRAVERSAL_ROOT" "$TRAVERSAL_OUTSIDE" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
const outside = process.argv[3];
fs.writeFileSync(path.join(root, "current.json"), JSON.stringify({
  schema_version: "1.0",
  active_slug: "escape",
  artifact_dir: path.relative(root, outside),
  updated_at: "2026-05-09T00:00:00Z",
}) + "\n");
NODE
if run_bounded 20 flow_agents_node "$WRITER" record-agent-event \
  --artifact-root "$TRAVERSAL_ROOT" \
  --agent-id tool-worker \
  --kind note \
  --status active \
  --summary "must not write outside" \
  >"$TMPDIR_EVAL/current-traversal.out" 2>"$TMPDIR_EVAL/current-traversal.err"; then
  _fail "sidecar writer accepted current.json artifact_dir outside artifact root"
elif [[ ! -e "$TRAVERSAL_OUTSIDE/agents" ]]; then
  _pass "sidecar writer rejects current.json artifact_dir outside artifact root"
else
  _fail "sidecar writer wrote agent events outside artifact root"
fi

SESSION_ROOT="$TMPDIR_EVAL/repo/.kontourai/flow-agents"
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
    --artifact-root ".kontourai/flow-agents" \
    --task-slug unsafe-repo \
    --title "Unsafe repo" \
    --summary "Unsafe repo fallback." \
    --timestamp "2026-05-09T00:00:00Z" >/dev/null 2>"$TMPDIR_EVAL/unsafe-repo.err" \
  && node - ".kontourai/flow-agents/unsafe-repo/state.json" <<'NODE'
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
TRAVERSAL_AGENT_OUTSIDE="$TMPDIR_EVAL/repo/.kontourai/flow-agents/evil-agent-outside.jsonl"
if run_bounded 20 flow_agents_node "$WRITER" record-agent-event \
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
  && [[ ! -d "$TMPDIR_EVAL/repo/.kontourai/flow-agents/outside" ]]; then
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
if run_bounded 20 flow_agents_node "$WRITER" record-agent-event \
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
if run_bounded 20 flow_agents_node "$WRITER" record-agent-event \
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
  if run_bounded 20 flow_agents_node "$WRITER" record-agent-event \
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
  && ! rg -q 'Different CLI criterion' "$EXISTING_ONLY_DIR/acceptance.json" \
  && rg -q '"branch": "main"' "$EXISTING_ONLY_DIR/state.json"; then
  _pass "sidecar writer derives missing sidecars from existing session Markdown and preserves its own pre-#289 branch: main line (legacy, not re-derived)"
else
  _fail "sidecar writer drifted sidecars from existing session Markdown: $(cat "$TMPDIR_EVAL/ensure-existing.out" "$TMPDIR_EVAL/ensure-existing.err")"
fi

# ─── #289: branch as first-class routing state (agent/<actor>/<slug>) ─────────
# AC2/AC7 (derivation + current.json mirror): a freshly created session with no explicit
# --actor derives its branch from the ambient runtime session id. CLAUDE_CODE_SESSION_ID is
# injected here to exercise the real Claude Code runtime-session-id path in
# actor-identity.js's resolveActor (rather than the --actor override seam) — state.json, the
# freshly seeded session Markdown, and current.json must all carry the same derived
# agent/<actor>/<slug> value.
BRANCH_ENV_DIR="$SESSION_ROOT/branch-session-env"
if CLAUDE_CODE_SESSION_ID="claude-session-alpha-001" flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$SESSION_ROOT" \
  --task-slug branch-session-env \
  --source-request "Derive a routing branch from an injected runtime session id." \
  --summary "A fresh session with no explicit --actor should derive its branch from the injected runtime session id." \
  --timestamp "2026-05-09T00:03:00Z" >"$TMPDIR_EVAL/branch-session-env.out" 2>"$TMPDIR_EVAL/branch-session-env.err" \
  && rg -q '"branch": "agent/claude-code-claude-session-alpha-001-[A-Za-z0-9_.-]+/branch-session-env"' "$BRANCH_ENV_DIR/state.json" \
  && grep -Eq '^branch: agent/claude-code-claude-session-alpha-001-[A-Za-z0-9_.-]+/branch-session-env$' "$BRANCH_ENV_DIR/branch-session-env--deliver.md" \
  && rg -q '"branch": "agent/claude-code-claude-session-alpha-001-[A-Za-z0-9_.-]+/branch-session-env"' "$SESSION_ROOT/current.json"; then
  _pass "sidecar writer derives agent/<actor>/<slug> branch from an injected runtime session id into state.json, markdown, and current.json (AC2, AC7)"
else
  _fail "sidecar writer did not derive a consistent injected-session-id branch across state.json/markdown/current.json: $(cat "$TMPDIR_EVAL/branch-session-env.out" "$TMPDIR_EVAL/branch-session-env.err")"
fi

# AC3 (explicit override): --branch on a brand-new session records the value verbatim,
# not a derived agent/<actor>/<slug> name.
BRANCH_OVERRIDE_DIR="$SESSION_ROOT/branch-override-a"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$SESSION_ROOT" \
  --task-slug branch-override-a \
  --branch "custom/my-branch" \
  --source-request "An explicit --branch overrides derivation." \
  --summary "A brand-new session with --branch should record the value verbatim." \
  --timestamp "2026-05-09T00:03:05Z" >"$TMPDIR_EVAL/branch-override.out" 2>"$TMPDIR_EVAL/branch-override.err" \
  && rg -q '"branch": "custom/my-branch"' "$BRANCH_OVERRIDE_DIR/state.json" \
  && grep -Eq '^branch: custom/my-branch$' "$BRANCH_OVERRIDE_DIR/branch-override-a--deliver.md"; then
  _pass "sidecar writer records an explicit --branch value verbatim, not a derived name (AC3)"
else
  _fail "sidecar writer did not honor an explicit --branch override: $(cat "$TMPDIR_EVAL/branch-override.out" "$TMPDIR_EVAL/branch-override.err")"
fi

# AC4 (distinct actors): two fresh sessions with distinct explicit --actor values produce
# distinct branch values, differing only in the actor segment.
BRANCH_DERIVE_A_DIR="$SESSION_ROOT/branch-derive-a"
BRANCH_DERIVE_B_DIR="$SESSION_ROOT/branch-derive-b"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$SESSION_ROOT" \
  --task-slug branch-derive-a \
  --actor test-actor-alpha \
  --source-request "Derive a branch for actor alpha." \
  --summary "Distinct actor alpha." \
  --timestamp "2026-05-09T00:03:10Z" >"$TMPDIR_EVAL/branch-derive-a.out" 2>"$TMPDIR_EVAL/branch-derive-a.err" \
  && flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$SESSION_ROOT" \
  --task-slug branch-derive-b \
  --actor test-actor-beta \
  --source-request "Derive a branch for actor beta." \
  --summary "Distinct actor beta." \
  --timestamp "2026-05-09T00:03:11Z" >"$TMPDIR_EVAL/branch-derive-b.out" 2>"$TMPDIR_EVAL/branch-derive-b.err" \
  && rg -q '"branch": "agent/test-actor-alpha/branch-derive-a"' "$BRANCH_DERIVE_A_DIR/state.json" \
  && rg -q '"branch": "agent/test-actor-beta/branch-derive-b"' "$BRANCH_DERIVE_B_DIR/state.json"; then
  _pass "sidecar writer derives distinct branch values for distinct actors (AC4)"
else
  _fail "sidecar writer did not derive distinct branches for distinct actors: $(cat "$TMPDIR_EVAL/branch-derive-a.out" "$TMPDIR_EVAL/branch-derive-a.err" "$TMPDIR_EVAL/branch-derive-b.out" "$TMPDIR_EVAL/branch-derive-b.err")"
fi

# AC5 (existing-session continuity): re-running ensure-session against the SAME slug from a
# DIFFERENT actor never re-derives or overwrites the already-recorded branch (ADR 0021 §5
# takeover continuity — resume the incumbent's branch, never a parallel one). #291's
# ensure-session ownership guard now classifies alpha's still-fresh-assignment/no-liveness
# claim as `reclaimable` and refuses gamma's entry without an explicit takeover — so this
# takeover is made explicit via --supersede-stale (ADR 0021 §5's grace-beat/auto-resume
# protocol is still #294's scope; #291 only wires the explicit, caller-invoked takeover path).
# The supersede updates the ASSIGNMENT record's actor (assignment/<slug>.json), never
# state.json — state.json's `branch` field (and the rest of state.json) must stay exactly
# alpha's, proving the takeover resumes the incumbent's branch rather than reforking one for
# gamma.
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$SESSION_ROOT" \
  --task-slug branch-derive-a \
  --actor test-actor-gamma \
  --supersede-stale \
  --source-request "A takeover by a different actor must not refork the branch." \
  --summary "Resuming actor gamma should inherit alpha's already-recorded branch." \
  --timestamp "2026-05-09T00:03:12Z" >"$TMPDIR_EVAL/branch-no-rederive.out" 2>"$TMPDIR_EVAL/branch-no-rederive.err" \
  && rg -q '"branch": "agent/test-actor-alpha/branch-derive-a"' "$BRANCH_DERIVE_A_DIR/state.json" \
  && ! rg -q 'test-actor-gamma' "$BRANCH_DERIVE_A_DIR/state.json"; then
  _pass "sidecar writer's explicit --supersede-stale takeover (#291) never re-derives or overwrites an existing session's branch for the new actor (AC5, ADR 0021 §5)"
else
  _fail "sidecar writer's explicit --supersede-stale takeover re-derived or overwrote an existing session's branch: $(cat "$TMPDIR_EVAL/branch-no-rederive.out" "$TMPDIR_EVAL/branch-no-rederive.err")"
fi

# ─── #309: init-plan (and advance-state) must never drop an already-recorded branch ────
# Regression cover for the full ensure-session -> init-plan -> advance-state lifecycle every
# real session goes through. init-plan is invoked (per plan-work/SKILL.md) against the
# PLAN artifact the tool-planner writes (e.g. "<slug>--plan-work.md"), a DIFFERENT file than
# the session "<slug>--deliver.md" that carries the "branch:" line ensure-session seeded — that
# plan artifact below deliberately carries NO "branch:" field, reproducing the exact shape of
# the live kontourai-flow-agents-166 regression. state.json (and current.json's mirror) must
# still carry the derived branch after init-plan, and again after a subsequent advance-state.
BRANCH_SEQ_DIR="$SESSION_ROOT/branch-full-sequence"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$SESSION_ROOT" \
  --task-slug branch-full-sequence \
  --actor seq-actor \
  --source-request "Establish a session whose branch must survive init-plan and advance-state." \
  --summary "Fresh session for the full ensure-session -> init-plan -> advance-state sequence." \
  --timestamp "2026-07-01T00:04:20Z" >"$TMPDIR_EVAL/branch-seq-ensure.out" 2>"$TMPDIR_EVAL/branch-seq-ensure.err" \
  && rg -q '"branch": "agent/seq-actor/branch-full-sequence"' "$BRANCH_SEQ_DIR/state.json"; then
  _pass "sidecar writer (#309 setup) seeds branch-full-sequence with a derived branch via ensure-session"
else
  _fail "sidecar writer (#309 setup) failed to seed branch-full-sequence: $(cat "$TMPDIR_EVAL/branch-seq-ensure.out" "$TMPDIR_EVAL/branch-seq-ensure.err")"
fi

BRANCH_SEQ_PLAN_ARTIFACT="$BRANCH_SEQ_DIR/branch-full-sequence--plan-work.md"
cat > "$BRANCH_SEQ_PLAN_ARTIFACT" <<'MARKDOWN'
---
role: plan
parent: branch-full-sequence--deliver
created: 2026-07-01
---

# Plan: #309 branch survival fixture

## Plan

A plan artifact deliberately carrying no `branch:` line (mirrors the real tool-planner output).

## Definition Of Done

- **Acceptance criteria:**
  - [ ] init-plan preserves the already-recorded branch - Evidence: pending.
MARKDOWN

if flow_agents_node "$WRITER" init-plan "$BRANCH_SEQ_PLAN_ARTIFACT" \
  --source-request "Plan artifact carries no branch: line." \
  --summary "Planning sidecars initialized from a branch-less plan artifact." \
  --next-action "Advance to execution." \
  --timestamp "2026-07-01T00:04:21Z" >"$TMPDIR_EVAL/branch-seq-initplan.out" 2>"$TMPDIR_EVAL/branch-seq-initplan.err" \
  && rg -q '"branch": "agent/seq-actor/branch-full-sequence"' "$BRANCH_SEQ_DIR/state.json"; then
  _pass "sidecar writer (#309) preserves the already-recorded branch across init-plan even when the plan artifact carries no branch: line"
else
  _fail "sidecar writer (#309) DROPPED the branch on init-plan: $(cat "$TMPDIR_EVAL/branch-seq-initplan.out" "$TMPDIR_EVAL/branch-seq-initplan.err"); state.json=$(cat "$BRANCH_SEQ_DIR/state.json" 2>/dev/null)"
fi

if flow_agents_node "$WRITER" advance-state "$BRANCH_SEQ_DIR" \
  --status in_progress \
  --phase execution \
  --summary "Execution started." \
  --next-action "Run checks." \
  --timestamp "2026-07-01T00:04:22Z" >"$TMPDIR_EVAL/branch-seq-advance.out" 2>"$TMPDIR_EVAL/branch-seq-advance.err" \
  && rg -q '"branch": "agent/seq-actor/branch-full-sequence"' "$BRANCH_SEQ_DIR/state.json" \
  && rg -q '"branch": "agent/seq-actor/branch-full-sequence"' "$SESSION_ROOT/current.json"; then
  _pass "sidecar writer (#309) still carries the branch in state.json and its current.json mirror after advance-state"
else
  _fail "sidecar writer (#309) lost the branch by advance-state, or current.json mirror drifted: $(cat "$TMPDIR_EVAL/branch-seq-advance.out" "$TMPDIR_EVAL/branch-seq-advance.err"); state.json=$(cat "$BRANCH_SEQ_DIR/state.json" 2>/dev/null)"
fi

# #309 backfill repro: an ALREADY-BROKEN pre-fix session (state.json has no branch key at all,
# matching kontourai-flow-agents-166/-290) can be repaired by re-running init-plan against the
# SAME branch-less plan artifact that dropped the branch in the first place -- WITHOUT any direct
# file edit -- because initSidecars falls back to reading the session's own canonical
# "<slug>--deliver.md" from disk when neither the existing state.json nor the passed-in markdown
# carries a branch.
BRANCH_BACKFILL_DIR="$SESSION_ROOT/branch-backfill-repro"
mkdir -p "$BRANCH_BACKFILL_DIR"
cat > "$BRANCH_BACKFILL_DIR/branch-backfill-repro--deliver.md" <<'MARKDOWN'
# branch-backfill-repro

branch: agent/seq-actor/branch-backfill-repro
worktree: main
created: 2026-07-01T00:04:23Z
status: planning
type: deliver
iteration: 1

## Plan

Pre-fix victim fixture: state.json below was written WITHOUT a branch key (simulating #309).
MARKDOWN
cat > "$BRANCH_BACKFILL_DIR/state.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "branch-backfill-repro",
  "repo": "kontourai/flow-agents",
  "status": "planned",
  "phase": "planning",
  "created_at": "2026-07-01T00:04:23Z",
  "updated_at": "2026-07-01T00:04:23Z",
  "artifact_paths": ["state.json"],
  "next_action": { "status": "continue", "summary": "pre-fix victim fixture" }
}
JSON
BRANCH_BACKFILL_PLAN_ARTIFACT="$BRANCH_BACKFILL_DIR/branch-backfill-repro--plan-work.md"
cat > "$BRANCH_BACKFILL_PLAN_ARTIFACT" <<'MARKDOWN'
---
role: plan
parent: branch-backfill-repro--deliver
created: 2026-07-01
---

# Plan: #309 backfill repro fixture

## Definition Of Done

- **Acceptance criteria:**
  - [ ] backfill repairs the dropped branch - Evidence: pending.
MARKDOWN

if flow_agents_node "$WRITER" init-plan "$BRANCH_BACKFILL_PLAN_ARTIFACT" \
  --source-request "Re-run init-plan against the same branch-less plan artifact to backfill." \
  --summary "Backfill re-run." \
  --next-action "n/a" \
  --timestamp "2026-07-01T00:04:23Z" >"$TMPDIR_EVAL/branch-backfill.out" 2>"$TMPDIR_EVAL/branch-backfill.err" \
  && rg -q '"branch": "agent/seq-actor/branch-backfill-repro"' "$BRANCH_BACKFILL_DIR/state.json"; then
  _pass "sidecar writer (#309) backfills a pre-fix-broken session's branch via a sanctioned init-plan re-run (no direct file edit)"
else
  _fail "sidecar writer (#309) failed to backfill an already-broken session's branch: $(cat "$TMPDIR_EVAL/branch-backfill.out" "$TMPDIR_EVAL/branch-backfill.err"); state.json=$(cat "$BRANCH_BACKFILL_DIR/state.json" 2>/dev/null)"
fi

# Actor charset guard: an explicit --actor value that strips to empty under the allowed
# charset dies before any session artifact is written (mirrors the liveness write path's
# existing F7 test coverage).
BRANCH_BAD_ACTOR_DIR="$SESSION_ROOT/branch-bad-actor"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$SESSION_ROOT" \
  --task-slug branch-bad-actor \
  --actor ":::" \
  --source-request "Garbage --actor should die." \
  --summary "Should not create a session." \
  --timestamp "2026-05-09T00:03:13Z" >"$TMPDIR_EVAL/branch-bad-actor.out" 2>"$TMPDIR_EVAL/branch-bad-actor.err"; then
  _fail "sidecar writer should reject a --actor value that strips to empty under the allowed charset"
elif rg -q -- '--actor value strips to empty' "$TMPDIR_EVAL/branch-bad-actor.out" "$TMPDIR_EVAL/branch-bad-actor.err" \
  && [[ ! -f "$BRANCH_BAD_ACTOR_DIR/state.json" ]]; then
  _pass "sidecar writer dies on a garbage --actor value before writing any session artifact"
else
  _fail "garbage --actor rejection was not fail-closed or lacked diagnostics: $(cat "$TMPDIR_EVAL/branch-bad-actor.out" "$TMPDIR_EVAL/branch-bad-actor.err")"
fi

# ─── #289 fix-plan iteration 1 (F1/F2/F4) ──────────────────────────────────────
# F1: a trailing-dot slug (git-check-ref-format forbids a ref component ending in ".") derives a
# branch that is a REAL, valid git ref — asserted against the actual `git check-ref-format`
# binary, not a hand-rolled regex re-implementation of its rules.
BRANCH_TRAILING_DOT_DIR="$SESSION_ROOT/branch-trailing-dot"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$SESSION_ROOT" \
  --task-slug branch-trailing-dot \
  --actor "my-fix." \
  --source-request "A trailing-dot actor segment must not leave an illegal git ref." \
  --summary "Trailing dot should be stripped, not left dangling." \
  --timestamp "2026-07-01T00:04:00Z" >"$TMPDIR_EVAL/branch-trailing-dot.out" 2>"$TMPDIR_EVAL/branch-trailing-dot.err"; then
  TRAILING_DOT_BRANCH="$(jq -r '.branch // empty' "$BRANCH_TRAILING_DOT_DIR/state.json" 2>/dev/null)"
  if [[ -n "$TRAILING_DOT_BRANCH" ]] && [[ "$TRAILING_DOT_BRANCH" != *"." ]] && git check-ref-format --branch "$TRAILING_DOT_BRANCH" >/dev/null 2>&1; then
    _pass "sidecar writer strips a trailing dot from a derived branch segment and the result passes the real git check-ref-format binary (F1)"
  else
    _fail "sidecar writer derived a branch that git check-ref-format rejects (F1): branch=$TRAILING_DOT_BRANCH"
  fi
else
  _fail "sidecar writer ensure-session failed for trailing-dot actor fixture: $(cat "$TMPDIR_EVAL/branch-trailing-dot.out" "$TMPDIR_EVAL/branch-trailing-dot.err")"
fi

# F2: an explicit --branch is strictly validated, not trusted verbatim. Each hostile value below
# must die BEFORE any session artifact is written (no state.json / no session Markdown), with a
# diagnostic naming the actual problem.
assert_hostile_branch_dies() {
  local label="$1" branch_value="$2" slug="$3" expect_pattern="$4"
  local dir="$SESSION_ROOT/$slug"
  local out="$TMPDIR_EVAL/hostile-branch-$slug.out"
  if flow_agents_node "$WRITER" ensure-session \
    --artifact-root "$SESSION_ROOT" \
    --task-slug "$slug" \
    --branch "$branch_value" \
    --source-request "Hostile --branch should die before mutation." \
    --summary "Should not create a session." \
    --timestamp "2026-07-01T00:04:10Z" >"$out" 2>&1; then
    _fail "sidecar writer should reject a hostile --branch value ($label)"
  elif rg -q -- "$expect_pattern" "$out" && [[ ! -f "$dir/state.json" ]]; then
    _pass "sidecar writer dies on a hostile --branch value before writing any session artifact ($label, F2)"
  else
    _fail "hostile --branch rejection ($label) was not fail-closed or lacked diagnostics: $(cat "$out")"
  fi
}
assert_hostile_branch_dies "embedded newline" "$(printf 'main\nbad')" "branch-hostile-newline" "control character or newline"
assert_hostile_branch_dies '".." sequence' "foo..bar" "branch-hostile-dotdot" 'must not contain a "\.\." sequence'
assert_hostile_branch_dies "trailing .lock" "foo.lock" "branch-hostile-lock" '"\.lock"'
assert_hostile_branch_dies "embedded space" "foo bar" "branch-hostile-space" "contains a space"

# F4: two distinct all-garbage --task-slug values (each collapsing sanitizeBranchSegment's
# charset filter to empty) must derive DISTINCT branches, not silently collide on the bare
# literal "unknown". Actor is held fixed and valid so the slug segment is the only variable.
BRANCH_GARBAGE_A_DIR="$SESSION_ROOT/???"
BRANCH_GARBAGE_B_DIR="$SESSION_ROOT/!!!"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$SESSION_ROOT" \
  --task-slug '???' \
  --actor test-actor-fix4 \
  --source-request "All-garbage slug A." \
  --summary "Garbage slug A." \
  --timestamp "2026-07-01T00:04:20Z" >"$TMPDIR_EVAL/branch-garbage-a.out" 2>"$TMPDIR_EVAL/branch-garbage-a.err" \
  && flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$SESSION_ROOT" \
  --task-slug '!!!' \
  --actor test-actor-fix4 \
  --source-request "All-garbage slug B." \
  --summary "Garbage slug B." \
  --timestamp "2026-07-01T00:04:21Z" >"$TMPDIR_EVAL/branch-garbage-b.out" 2>"$TMPDIR_EVAL/branch-garbage-b.err"; then
  GARBAGE_A_BRANCH="$(jq -r '.branch // empty' "$BRANCH_GARBAGE_A_DIR/state.json" 2>/dev/null)"
  GARBAGE_B_BRANCH="$(jq -r '.branch // empty' "$BRANCH_GARBAGE_B_DIR/state.json" 2>/dev/null)"
  if [[ -n "$GARBAGE_A_BRANCH" ]] && [[ -n "$GARBAGE_B_BRANCH" ]] \
    && [[ "$GARBAGE_A_BRANCH" != "$GARBAGE_B_BRANCH" ]] \
    && [[ "$GARBAGE_A_BRANCH" == agent/test-actor-fix4/unknown-* ]] \
    && [[ "$GARBAGE_B_BRANCH" == agent/test-actor-fix4/unknown-* ]] \
    && git check-ref-format --branch "$GARBAGE_A_BRANCH" >/dev/null 2>&1 \
    && git check-ref-format --branch "$GARBAGE_B_BRANCH" >/dev/null 2>&1; then
    _pass "sidecar writer derives distinct disambiguated branches for two all-garbage task slugs (F4): $GARBAGE_A_BRANCH vs $GARBAGE_B_BRANCH"
  else
    _fail "sidecar writer did not disambiguate two all-garbage task slugs (F4): a=$GARBAGE_A_BRANCH b=$GARBAGE_B_BRANCH"
  fi
else
  _fail "sidecar writer ensure-session failed for all-garbage slug fixtures: $(cat "$TMPDIR_EVAL/branch-garbage-a.out" "$TMPDIR_EVAL/branch-garbage-a.err" "$TMPDIR_EVAL/branch-garbage-b.out" "$TMPDIR_EVAL/branch-garbage-b.err")"
fi

# ─── #289 fix-plan iteration 2 (F2'/F4' residuals from code-review-289-iteration-1) ─────────────
# F2': the whole-string checks above (iteration 1) only look at the START/END of the full
# --branch value, so a fuzz of charset-valid values found hostile /-delimited PATH COMPONENTS
# that slip past them. Each of these four escape classes must still die pre-mutation.
assert_hostile_branch_dies "leading '-' (path component)" "-lead" "branch-hostile-lead" 'starting with "-"'
assert_hostile_branch_dies "non-first component starting with '.'" "a/.b" "branch-hostile-dotcomp" 'starting with "\."'
assert_hostile_branch_dies "non-last component ending in .lock" "foo.lock/bar" "branch-hostile-lockcomp" '"\.lock"'
assert_hostile_branch_dies "component that is exactly '.'" "a/./b" "branch-hostile-dotonly" '"\."'

# F2' belt-and-braces: every --branch value validateExplicitBranch ACCEPTS must also pass the
# real `git check-ref-format --branch` binary — not just this repo's earlier fixtures
# ("custom/my-branch", AC3 above), but a representative additional accepted value with a nested
# path and mixed charset.
BRANCH_ACCEPTED_GIT_DIR="$SESSION_ROOT/branch-accepted-git-valid"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$SESSION_ROOT" \
  --task-slug branch-accepted-git-valid \
  --branch "release/2026.07_hotfix-1" \
  --source-request "An accepted --branch value must also be a real, git-valid ref." \
  --summary "Accepted --branch values are double-checked against the real git binary." \
  --timestamp "2026-07-02T00:04:30Z" >"$TMPDIR_EVAL/branch-accepted-git.out" 2>"$TMPDIR_EVAL/branch-accepted-git.err"; then
  ACCEPTED_GIT_BRANCH="$(jq -r '.branch // empty' "$BRANCH_ACCEPTED_GIT_DIR/state.json" 2>/dev/null)"
  if [[ "$ACCEPTED_GIT_BRANCH" == "release/2026.07_hotfix-1" ]] && git check-ref-format --branch "$ACCEPTED_GIT_BRANCH" >/dev/null 2>&1; then
    _pass "sidecar writer's accepted --branch value passes the real git check-ref-format binary (F2')"
  else
    _fail "sidecar writer accepted a --branch value that the real git binary rejects (F2'): branch=$ACCEPTED_GIT_BRANCH"
  fi
else
  _fail "sidecar writer ensure-session failed for the accepted git-valid --branch fixture: $(cat "$TMPDIR_EVAL/branch-accepted-git.out" "$TMPDIR_EVAL/branch-accepted-git.err")"
fi

# F4': the FINAL sanitized segment equaling the literal fallback token "unknown" must ALWAYS be
# disambiguated with the 6-hex sha256 suffix - including a literal --actor "unknown" (no
# literal-input carve-out), and including near-miss inputs ("unknown.", ".unknown") that only
# collapse to the literal "unknown" via this function's OWN leading/trailing-dot stripping.
# All three must derive DISTINCT branches (distinct raw input -> distinct hash) despite sharing
# the same effective actor "meaning".
BRANCH_UNKNOWN_LITERAL_DIR="$SESSION_ROOT/branch-unknown-literal"
BRANCH_UNKNOWN_TRAILING_DIR="$SESSION_ROOT/branch-unknown-trailing-dot"
BRANCH_UNKNOWN_LEADING_DIR="$SESSION_ROOT/branch-unknown-leading-dot"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$SESSION_ROOT" \
  --task-slug branch-unknown-literal \
  --actor "unknown" \
  --source-request "Literal --actor unknown must still be disambiguated." \
  --summary "No literal-input carve-out." \
  --timestamp "2026-07-02T00:04:40Z" >"$TMPDIR_EVAL/branch-unknown-literal.out" 2>"$TMPDIR_EVAL/branch-unknown-literal.err" \
  && flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$SESSION_ROOT" \
  --task-slug branch-unknown-trailing-dot \
  --actor "unknown." \
  --source-request "Trailing-dot actor collapsing to literal unknown must still be disambiguated." \
  --summary "Near-miss trailing dot." \
  --timestamp "2026-07-02T00:04:41Z" >"$TMPDIR_EVAL/branch-unknown-trailing-dot.out" 2>"$TMPDIR_EVAL/branch-unknown-trailing-dot.err" \
  && flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$SESSION_ROOT" \
  --task-slug branch-unknown-leading-dot \
  --actor ".unknown" \
  --source-request "Leading-dot actor collapsing to literal unknown must still be disambiguated." \
  --summary "Near-miss leading dot." \
  --timestamp "2026-07-02T00:04:42Z" >"$TMPDIR_EVAL/branch-unknown-leading-dot.out" 2>"$TMPDIR_EVAL/branch-unknown-leading-dot.err"; then
  UNKNOWN_LITERAL_BRANCH="$(jq -r '.branch // empty' "$BRANCH_UNKNOWN_LITERAL_DIR/state.json" 2>/dev/null)"
  UNKNOWN_TRAILING_BRANCH="$(jq -r '.branch // empty' "$BRANCH_UNKNOWN_TRAILING_DIR/state.json" 2>/dev/null)"
  UNKNOWN_LEADING_BRANCH="$(jq -r '.branch // empty' "$BRANCH_UNKNOWN_LEADING_DIR/state.json" 2>/dev/null)"
  if [[ "$UNKNOWN_LITERAL_BRANCH" == agent/unknown-*/branch-unknown-literal ]] \
    && [[ "$UNKNOWN_TRAILING_BRANCH" == agent/unknown-*/branch-unknown-trailing-dot ]] \
    && [[ "$UNKNOWN_LEADING_BRANCH" == agent/unknown-*/branch-unknown-leading-dot ]] \
    && [[ "${UNKNOWN_LITERAL_BRANCH#agent/}" != "${UNKNOWN_TRAILING_BRANCH#agent/}" ]] \
    && [[ "${UNKNOWN_LITERAL_BRANCH#agent/}" != "${UNKNOWN_LEADING_BRANCH#agent/}" ]] \
    && [[ "${UNKNOWN_TRAILING_BRANCH#agent/}" != "${UNKNOWN_LEADING_BRANCH#agent/}" ]] \
    && git check-ref-format --branch "$UNKNOWN_LITERAL_BRANCH" >/dev/null 2>&1 \
    && git check-ref-format --branch "$UNKNOWN_TRAILING_BRANCH" >/dev/null 2>&1 \
    && git check-ref-format --branch "$UNKNOWN_LEADING_BRANCH" >/dev/null 2>&1; then
    _pass "sidecar writer derives three DISTINCT disambiguated branches for actors 'unknown', 'unknown.', '.unknown' (F4'): $UNKNOWN_LITERAL_BRANCH vs $UNKNOWN_TRAILING_BRANCH vs $UNKNOWN_LEADING_BRANCH"
  else
    _fail "sidecar writer did not disambiguate all three unknown-collapsing actor variants distinctly (F4'): literal=$UNKNOWN_LITERAL_BRANCH trailing=$UNKNOWN_TRAILING_BRANCH leading=$UNKNOWN_LEADING_BRANCH"
  fi
else
  _fail "sidecar writer ensure-session failed for one of the unknown-collapsing actor fixtures: $(cat "$TMPDIR_EVAL/branch-unknown-literal.out" "$TMPDIR_EVAL/branch-unknown-literal.err" "$TMPDIR_EVAL/branch-unknown-trailing-dot.out" "$TMPDIR_EVAL/branch-unknown-trailing-dot.err" "$TMPDIR_EVAL/branch-unknown-leading-dot.out" "$TMPDIR_EVAL/branch-unknown-leading-dot.err")"
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

SCOPE_REPO="$TMPDIR_EVAL/scope-repo"
SCOPE_ROOT="$SCOPE_REPO/.kontourai/flow-agents"
SCOPE_DIR="$SCOPE_ROOT/scope-session"
mkdir -p "$SCOPE_REPO"
if (
  cd "$SCOPE_REPO" \
    && git init -q \
    && git config user.email "flow-agents@example.test" \
    && git config user.name "Flow Agents Test" \
    && printf 'base\n' > scoped.txt \
    && git add scoped.txt \
    && git commit -q -m "base" \
    && git branch base \
    && printf 'changed\n' > scoped.txt \
    && ln -s outside-target linked.txt
) \
  && (cd "$SCOPE_REPO" && flow_agents_node "$WRITER" ensure-session \
    --artifact-root "$SCOPE_ROOT" \
    --task-slug scope-session \
    --summary "Scope session." \
    --criterion "Scope recorded." \
    --timestamp "2026-05-09T00:01:30Z" >/dev/null 2>"$TMPDIR_EVAL/scope-ensure.err") \
  && (cd "$SCOPE_REPO" && flow_agents_node "$WRITER" record-scope "$SCOPE_DIR" \
    --base-ref base \
    --timestamp "2026-05-09T00:02:00Z" >"$TMPDIR_EVAL/scope-record.out" 2>"$TMPDIR_EVAL/scope-record.err") \
  && node - "$SCOPE_DIR/trust.bundle" <<'NODE'
const fs = require("fs");
const crypto = require("crypto");
const bundle = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const state = JSON.parse(fs.readFileSync(process.argv[2].replace(/trust\.bundle$/, "state.json"), "utf8"));
if (state.status === "verified") throw new Error("record-scope must not mark the workflow verified");
const claim = bundle.claims.find((c) => c.metadata && c.metadata.check_kind === "scope");
if (!claim) throw new Error("no scope claim");
if (claim.claimType !== "workflow.check.scope") throw new Error(`unexpected claimType ${claim.claimType}`);
const entries = claim.metadata.scope && claim.metadata.scope.entries;
if (!Array.isArray(entries)) throw new Error("missing scope entries");
const entry = entries.find((e) => e.path === "scoped.txt");
if (!entry) throw new Error(`missing scoped.txt entry: ${JSON.stringify(entries)}`);
const expectedHash = crypto.createHash("sha256").update("changed\n").digest("hex");
if (entry.blobHash !== expectedHash) throw new Error(`expected dirty worktree hash ${expectedHash}, got ${entry.blobHash}`);
const symlinkEntry = entries.find((e) => e.path === "linked.txt");
if (!symlinkEntry) throw new Error(`missing linked.txt symlink entry: ${JSON.stringify(entries)}`);
const expectedSymlinkHash = `symlink:${crypto.createHash("sha256").update("outside-target").digest("hex")}`;
if (symlinkEntry.blobHash !== expectedSymlinkHash) throw new Error(`expected symlink hash ${expectedSymlinkHash}, got ${symlinkEntry.blobHash}`);
const ev = bundle.evidence.find((e) => e.claimId === claim.id);
if (!ev) throw new Error("missing evidence");
if (ev.execution && ev.execution.label) throw new Error("scope evidence must not carry execution.label");
NODE
then
  _pass "sidecar writer record-scope records a non-command scope claim from git ground truth"
else
  _fail "sidecar writer record-scope did not produce expected scope claim: $(cat "$TMPDIR_EVAL/scope-ensure.err" "$TMPDIR_EVAL/scope-record.out" "$TMPDIR_EVAL/scope-record.err" 2>/dev/null)"
fi

SCOPE_NO_BASE_REPO="$TMPDIR_EVAL/scope-no-base-repo"
SCOPE_NO_BASE_ROOT="$SCOPE_NO_BASE_REPO/.kontourai/flow-agents"
SCOPE_NO_BASE_DIR="$SCOPE_NO_BASE_ROOT/scope-no-base-session"
mkdir -p "$SCOPE_NO_BASE_REPO"
if (
  cd "$SCOPE_NO_BASE_REPO" \
    && git init -q \
    && git config user.email "flow-agents@example.test" \
    && git config user.name "Flow Agents Test" \
    && printf 'only\n' > only.txt \
    && git add only.txt \
    && git commit -q -m "only commit" \
    && git branch -M topic \
    && printf 'changed\n' > only.txt
) \
  && (cd "$SCOPE_NO_BASE_REPO" && flow_agents_node "$WRITER" ensure-session \
    --artifact-root "$SCOPE_NO_BASE_ROOT" \
    --task-slug scope-no-base-session \
    --summary "Scope no-base session." \
    --criterion "Scope must fail closed without git base." \
    --timestamp "2026-05-09T00:02:30Z" >/dev/null 2>"$TMPDIR_EVAL/scope-no-base-ensure.err") \
  && ! (cd "$SCOPE_NO_BASE_REPO" && TRUST_RECONCILE_BASE_REF= GITHUB_BASE_REF= flow_agents_node "$WRITER" record-scope "$SCOPE_NO_BASE_DIR" \
    --base-ref missing-base-ref \
    --timestamp "2026-05-09T00:03:00Z" >"$TMPDIR_EVAL/scope-no-base-record.out" 2>"$TMPDIR_EVAL/scope-no-base-record.err") \
  && rg -q "record-scope: cannot attest scope .*no resolvable base ref" "$TMPDIR_EVAL/scope-no-base-record.err" \
  && [[ ! -f "$SCOPE_NO_BASE_DIR/trust.bundle" ]]
then
  _pass "sidecar writer record-scope fails closed without a resolvable git base and writes no passing scope claim"
else
  _fail "sidecar writer record-scope did not fail closed without git ground truth: $(cat "$TMPDIR_EVAL/scope-no-base-ensure.err" "$TMPDIR_EVAL/scope-no-base-record.out" "$TMPDIR_EVAL/scope-no-base-record.err" 2>/dev/null)"
fi

# Phase 4c: acceptance.json criteria status no longer updated at verification time (bundle-only).
# State is verified; bundle claims carry the criteria status.
if rg -q '"status": "verified"' "$ARTIFACT_DIR/state.json"   && [[ -f "$ARTIFACT_DIR/trust.bundle" ]]   && node -e 'const fs=require("fs"); const b=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const ac=b.claims.filter(c=>c.claimType==="workflow.acceptance.criterion"); if(ac.length===0) throw new Error("no acceptance criterion claims in bundle"); if(ac.some(c=>c.value!=="pass")) throw new Error("some acceptance criterion not pass in bundle: "+JSON.stringify(ac.map(c=>c.value)));' "$ARTIFACT_DIR/trust.bundle" 2>/dev/null; then
  _pass "sidecar writer updates state and records acceptance in bundle from evidence"
else
  _fail "sidecar writer did not update state or bundle from evidence"
fi

# ─── WS8 (ADR 0020) AC1: producer evidence classification ─────────────────────
# buildTrustBundle derives evidence.evidenceType/method from check.kind instead of
# hardcoding test_output, and always stamps execution.label on command-backed checks.
CLASSIFY_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/evidence-classification"
mkdir -p "$CLASSIFY_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$CLASSIFY_DIR/evidence-classification--deliver.md"
flow_agents_node "$WRITER" init-plan "$CLASSIFY_DIR/evidence-classification--deliver.md" \
  --source-request "Classify evidence by kind." \
  --summary "Evidence classification fixture." \
  --next-action "Record mixed-kind evidence." \
  --timestamp "2026-05-09T00:01:00Z" >"$TMPDIR_EVAL/classify-init.out" 2>"$TMPDIR_EVAL/classify-init.err"

if flow_agents_node "$WRITER" record-evidence "$CLASSIFY_DIR" \
  --verdict pass \
  --check-json '{"id":"unit-tests","kind":"test","status":"pass","summary":"Unit tests passed.","command":"npm test"}' \
  --check-json '{"id":"dashboard-ui","kind":"browser","status":"pass","summary":"Visual check of dashboard."}' \
  --timestamp "2026-05-09T00:01:05Z" >"$TMPDIR_EVAL/classify.out" 2>"$TMPDIR_EVAL/classify.err"; then
  if node - "$CLASSIFY_DIR/trust.bundle" << 'NODE' 2>/dev/null
const fs = require("fs");
const b = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const ev = b.evidence || [];
const testEv = ev.find((e) => /unit-tests/.test(String(e.claimId)) || /Unit tests/.test(String(e.excerptOrSummary)));
const browserEv = ev.find((e) => /dashboard-ui/.test(String(e.claimId)) || /dashboard/.test(String(e.excerptOrSummary)));
if (!testEv) throw new Error("no test-kind evidence item");
if (!browserEv) throw new Error("no browser-kind evidence item");
if (testEv.evidenceType !== "test_output") throw new Error("test-kind evidenceType expected test_output, got " + testEv.evidenceType);
if (!testEv.execution || testEv.execution.label !== "npm test") throw new Error("test-kind must stamp execution.label 'npm test', got " + JSON.stringify(testEv.execution));
if (browserEv.evidenceType === "test_output") throw new Error("browser-kind evidenceType must NOT be test_output (got test_output)");
if (browserEv.evidenceType !== "crawl_observation") throw new Error("browser-kind evidenceType expected crawl_observation, got " + browserEv.evidenceType);
NODE
  then
    _pass "AC1: producer classifies test-kind as test_output+label and browser-kind as crawl_observation"
  else
    _fail "AC1: evidence classification incorrect: $(cat "$TMPDIR_EVAL/classify.out" "$TMPDIR_EVAL/classify.err")"
  fi
else
  _fail "AC1: record-evidence for classification fixture failed: $(cat "$TMPDIR_EVAL/classify.out" "$TMPDIR_EVAL/classify.err")"
fi

INVALID_REF_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/invalid-evidence-ref"
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

INVALID_ACCEPTANCE_REF_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/invalid-acceptance-ref"
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
# Phase 4c: evidence.json no longer written; verify in trust.bundle (sole verification artifact).
if flow_agents_node "$WRITER" record-evidence "$ARTIFACT_DIR" \
  --verdict pass \
  --check-json "$SURFACE_CHECK" \
  --timestamp "2026-05-09T00:01:05Z" >"$TMPDIR_EVAL/surface-evidence.out" 2>"$TMPDIR_EVAL/surface-evidence.err" \
  && [[ -f "$ARTIFACT_DIR/trust.bundle" ]] \
  && ! rg -q 'veritas' "$ARTIFACT_DIR/trust.bundle" \
  && node -e 'const fs=require("fs"); const b=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const c=b.claims.find(c=>c.claimType==="workflow.check.policy"); if(!c) throw new Error("no policy claim in bundle"); if(c.value!=="pass") throw new Error("expected pass, got "+c.value);' "$ARTIFACT_DIR/trust.bundle" 2>/dev/null; then
  _pass "sidecar writer records Hachure-aligned trust.bundle refs (verified in bundle)"
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
  local dir="$TMPDIR_EVAL/repo/.kontourai/flow-agents/surface-$name"
  mkdir -p "$dir"
  # Phase 4c: evidence.json no longer written; verify surface trust check status in trust.bundle.
  if flow_agents_node "$WRITER" record-evidence "$dir" \
    --task-slug "surface-$name" \
    --verdict "$verdict" \
    --check-json '{"id":"ordinary-builder-evidence","kind":"test","status":"pass","summary":"Ordinary Builder Kit evidence still records."}' \
    --surface-trust-json "$SURFACE_FIXTURE_DIR/$fixture" \
    --timestamp "2026-05-09T00:02:00Z" >"$TMPDIR_EVAL/surface-$name.out" 2>"$TMPDIR_EVAL/surface-$name.err" \
    && [[ -f "$dir/trust.bundle" ]] \
    && ! grep -qi 'veritas' "$dir/trust.bundle" \
    && node -e 'const fs=require("fs"); const [bundleFile, expectedStatus, expectedText]=process.argv.slice(1); const b=JSON.parse(fs.readFileSync(bundleFile,"utf8")); const policyClaims=b.claims.filter((c)=>c.claimType==="workflow.check.policy"); if(policyClaims.length!==1) throw new Error("expected one policy claim, found "+policyClaims.length); const c=policyClaims[0]; if(c.value!==expectedStatus) throw new Error("expected "+expectedStatus+", got "+c.value); const blob=JSON.stringify(b); if(!blob.includes(expectedText)) throw new Error("missing expected text "+expectedText+" in bundle");' "$dir/trust.bundle" "$expected_status" "$expected_text" 2>/dev/null
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

PURE_SURFACE_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/surface-trust-only"
mkdir -p "$PURE_SURFACE_DIR"
# Phase 4c: evidence.json no longer written; verify in trust.bundle.
if flow_agents_node "$WRITER" record-evidence "$PURE_SURFACE_DIR" \
  --task-slug "surface-trust-only" \
  --verdict pass \
  --surface-trust-json "$SURFACE_FIXTURE_DIR/accepted-claim-trust-report.json" \
  --timestamp "2026-05-09T00:02:30Z" >"$TMPDIR_EVAL/surface-only.out" 2>"$TMPDIR_EVAL/surface-only.err" \
  && [[ -f "$PURE_SURFACE_DIR/trust.bundle" ]] \
  && node -e 'const fs=require("fs"); const b=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(!Array.isArray(b.claims)||b.claims.length===0) throw new Error("no claims in bundle"); ' "$PURE_SURFACE_DIR/trust.bundle" 2>/dev/null; then
  _pass "sidecar writer records Surface trust evidence without unrelated check-json (verified in bundle)"
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

BUILDER_TRANSITION_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/builder-transition-guard"
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

LEGACY_TRANSITION_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/legacy-transition-guard"
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

NV_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/not-verified-sidecars"
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

# Phase 4c: evidence.json no longer written; not-verified state is in state.json + trust.bundle.
# not_verified_gaps are accepted as input but not persisted to a sidecar (bundle-only sessions).
if rg -q '"status": "not_verified"' "$NV_DIR/state.json" \
  && [[ -f "$NV_DIR/trust.bundle" ]] \
  && node -e 'const fs=require("fs"); const b=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const c=b.claims.find(c=>c.claimType==="workflow.check.external"); if(!c) throw new Error("no external check claim"); if(c.value!=="not_verified") throw new Error("expected not_verified, got "+c.value);' "$NV_DIR/trust.bundle" 2>/dev/null; then
  _pass "sidecar writer preserves not-verified state in state.json and bundle"
else
  _fail "sidecar writer did not preserve not-verified state"
fi

NEW_INVALID_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/new-invalid-artifact"
if flow_agents_node "$WRITER" record-evidence "$NEW_INVALID_DIR" \
  --verdict banana \
  --check-json '{"id":"invalid-new","kind":"test","status":"pass","summary":"Should fail."}' >"$TMPDIR_EVAL/new-invalid.out" 2>&1; then
  _fail "sidecar writer should reject invalid new artifact command"
elif [[ ! -e "$NEW_INVALID_DIR/.workflow-sidecar.lock" ]]; then
  _pass "sidecar writer does not leave lock files for invalid new artifact commands"
else
  _fail "sidecar writer left lock file for invalid new artifact command"
fi

LOCK_DENIED_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/lock-denied"
mkdir -p "$LOCK_DENIED_DIR"
if chmod 500 "$LOCK_DENIED_DIR" 2>"$TMPDIR_EVAL/lock-denied-chmod.err"; then
  if run_bounded 20 flow_agents_node "$WRITER" record-critique "$LOCK_DENIED_DIR" \
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

CONCURRENT_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/concurrent-critiques"
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

# Phase 4c: critique.json no longer written; verify both reviews are in trust.bundle claims.
if [[ "$status_a" -eq 0 && "$status_b" -eq 0 ]] \
  && [[ -f "$CONCURRENT_DIR/trust.bundle" ]] \
  && node -e 'const fs=require("fs"); const b=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const cc=b.claims.filter(c=>c.claimType==="workflow.critique.review"); if(cc.length<2) throw new Error("expected 2 critique claims, found "+cc.length+": "+JSON.stringify(cc.map(c=>c.subjectId)));' "$CONCURRENT_DIR/trust.bundle" 2>/dev/null; then
  _pass "sidecar writer serializes concurrent sidecar writes (both reviews in bundle)"
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

NO_SUMMARY_RELEASE_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/no-summary-release"
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

CORRECTION_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/correction-needed-learning"
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

DOGFOOD_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/dogfood-pass"
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

DIRTY_EVIDENCE_DOGFOOD_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/dogfood-dirty-evidence"
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

INVALID_EXISTING_EVIDENCE_DOGFOOD_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/dogfood-existing-invalid-evidence"
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

INVALID_EVIDENCE_DOGFOOD_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/dogfood-invalid-evidence"
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

INVALID_LEARNING_DOGFOOD_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/dogfood-invalid-learning"
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

INVALID_LEARNING_SHAPE_DOGFOOD_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/dogfood-invalid-learning-shape"
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

EXISTING_INVALID_LEARNING_DOGFOOD_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/dogfood-existing-invalid-learning"
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

EXISTING_LEARNED_NO_CORRECTION_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/dogfood-learned-no-correction"
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

INVALID_CRITIQUE_DOGFOOD_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/dogfood-invalid-critique"
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

EXISTING_INVALID_CRITIQUE_DOGFOOD_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/dogfood-existing-invalid-critique"
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

DIRTY_CRITIQUE_DOGFOOD_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/dogfood-dirty-critique"
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

FAILED_DOGFOOD_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/dogfood-failed-pass"
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

# Phase 4c: evidence.json/critique.json no longer written; verify in trust.bundle.
if rg -q '"status": "failed"' "$FAILED_DOGFOOD_DIR/state.json" \
  && rg -q 'Required dogfood critique is not passing' "$FAILED_DOGFOOD_DIR/handoff.json" \
  && [[ -f "$FAILED_DOGFOOD_DIR/trust.bundle" ]] \
  && node -e 'const fs=require("fs"); const b=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const cc=b.claims.filter(c=>c.claimType==="workflow.check.test"); if(!cc.length) throw new Error("no test check claim"); if(cc[0].value!=="fail") throw new Error("expected fail, got "+cc[0].value); const crit=b.claims.filter(c=>c.claimType==="workflow.critique.review"); if(!crit.length) throw new Error("no critique claim"); if(crit[0].value!=="fail") throw new Error("expected fail critique, got "+crit[0].value);' "$FAILED_DOGFOOD_DIR/trust.bundle" 2>/dev/null; then
  _pass "dogfood-pass failed records preserve failed state and blockers (verified in bundle)"
else
  _fail "dogfood-pass failed record did not preserve routing state"
fi

# Phase 4c: critique.json no longer written; validator reports sidecar missing (still blocks gate).
# The trust.bundle carries the disputed critique claim which is the authoritative gate signal.
if flow_agents_node "$VALIDATOR" --require-sidecars --require-critique "$FAILED_DOGFOOD_DIR" >"$TMPDIR_EVAL/dogfood-failed-valid.out" 2>"$TMPDIR_EVAL/dogfood-failed-valid.err"; then
  _fail "strict validator should still reject when critique is missing (4c bundle-only)"
elif rg -q 'required critique must pass|required sidecar is missing' "$TMPDIR_EVAL/dogfood-failed-valid.out" "$TMPDIR_EVAL/dogfood-failed-valid.err"; then
  _pass "dogfood-pass failed records remain visibly blocked under strict validation (sidecar missing or critique fail)"
else
  _fail "dogfood-pass failed record strict validation did not expose critique blocker: $(cat "$TMPDIR_EVAL/dogfood-failed-valid.out" "$TMPDIR_EVAL/dogfood-failed-valid.err")"
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

# Phase 4c: critique.json no longer written; verify in trust.bundle.
if rg -q '"state_status": "verified"' "$TMPDIR_EVAL/dogfood-pass.out" \
  && rg -q '"status": "learned"' "$DOGFOOD_DIR/learning.json" \
  && rg -q '"status": "verified"' "$DOGFOOD_DIR/state.json" \
  && [[ -f "$DOGFOOD_DIR/trust.bundle" ]] \
  && node -e 'const fs=require("fs"); const b=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const crit=b.claims.filter(c=>c.claimType==="workflow.critique.review"); if(!crit.length) throw new Error("no critique claim in bundle"); if(crit[0].value!=="pass") throw new Error("expected pass critique, got "+crit[0].value);' "$DOGFOOD_DIR/trust.bundle" 2>/dev/null; then
  _pass "dogfood-pass writes clean bundle, learning, and state (4c bundle-only)"
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

DOGFOOD_NV_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/dogfood-not-verified"
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

# Phase 4c: evidence.json no longer written; verify not-verified claim in trust.bundle.
if flow_agents_node "$WRITER" dogfood-pass \
  --artifact-root "$SESSION_ROOT" \
  --artifact-dir "$DOGFOOD_NV_DIR" \
  --verdict not_verified \
  --check-json '{"id":"dogfood-external","kind":"external","status":"not_verified","summary":"External live runtime was unavailable."}' \
  --gap "External live runtime unavailable." \
  --summary "Dogfood pass preserved not verified evidence." \
  --timestamp "2026-05-09T00:06:00Z" >"$TMPDIR_EVAL/dogfood-nv.out" 2>"$TMPDIR_EVAL/dogfood-nv.err" \
  && rg -q '"state_status": "not_verified"' "$TMPDIR_EVAL/dogfood-nv.out" \
  && [[ -f "$DOGFOOD_NV_DIR/trust.bundle" ]] \
  && node -e 'const fs=require("fs"); const b=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const ec=b.claims.filter(c=>c.claimType==="workflow.check.external"); if(!ec.length) throw new Error("no external check claim"); if(ec[0].value!=="not_verified") throw new Error("expected not_verified, got "+ec[0].value);' "$DOGFOOD_NV_DIR/trust.bundle" 2>/dev/null; then
  _pass "dogfood-pass preserves NOT_VERIFIED evidence and routing (verified in bundle)"
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

SEMANTIC_RELEASE_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/semantic-release"
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

SEMANTIC_LEARNING_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/semantic-learning"
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

REVIEW_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/imported-critique"
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

# Phase 4c: critique.json no longer written; verify critique claim in trust.bundle.
if [[ -f "$REVIEW_DIR/trust.bundle" ]] \
  && node -e 'const fs=require("fs"); const b=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const crit=b.claims.filter(c=>c.claimType==="workflow.critique.review"); if(!crit.length) throw new Error("no critique claim"); if(crit[0].value!=="pass") throw new Error("expected pass, got "+crit[0].value);' "$REVIEW_DIR/trust.bundle" 2>/dev/null; then
  _pass "sidecar writer extracts review findings (verified in bundle)"
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

BAD_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/bad-critique"
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

IMPORT_BAD="$TMPDIR_EVAL/repo/.kontourai/flow-agents/imported-bad-critique"
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
elif rg -q 'required critique must pass' "$TMPDIR_EVAL/import-bad-critique.out" \
  && [[ -f "$IMPORT_BAD/trust.bundle" ]] \
  && node -e 'const fs=require("fs"); const b=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const crit=b.claims.filter(c=>c.claimType==="workflow.critique.review"); if(!crit.length) throw new Error("no critique claim"); if(crit[0].value!=="fail") throw new Error("expected fail, got "+crit[0].value);' "$IMPORT_BAD/trust.bundle" 2>/dev/null; then
  _pass "sidecar writer persists and rejects imported failing critique (critique in bundle, not sidecar)"
else
  _fail "imported failing critique did not persist actionable finding"
fi


# ─── AC1: trust.bundle dual-write file existence and schema validity ──────────
TB_SCHEMA_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/trust-bundle-schema"
mkdir -p "$TB_SCHEMA_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$TB_SCHEMA_DIR/trust-bundle-schema--deliver.md"
flow_agents_node "$WRITER" init-plan "$TB_SCHEMA_DIR/trust-bundle-schema--deliver.md" \
  --source-request "Trust bundle schema fixture." \
  --summary "Trust bundle schema fixture." \
  --next-action "Record evidence and verify trust.bundle." \
  --timestamp "2026-05-09T00:00:00Z" >"$TMPDIR_EVAL/tb-schema-init.out" 2>"$TMPDIR_EVAL/tb-schema-init.err"

if flow_agents_node "$WRITER" record-evidence "$TB_SCHEMA_DIR" \
  --verdict pass \
  --check-json '{"id":"tb-schema-check","kind":"test","status":"pass","summary":"Trust bundle schema fixture check passed."}' \
  --timestamp "2026-05-09T00:01:00Z" >"$TMPDIR_EVAL/tb-schema-evidence.out" 2>"$TMPDIR_EVAL/tb-schema-evidence.err" \
  && [[ -f "$TB_SCHEMA_DIR/trust.bundle" ]]; then
  _pass "trust.bundle dual-write creates trust.bundle after record-evidence"
else
  _fail "trust.bundle dual-write did not create trust.bundle after record-evidence: $(cat "$TMPDIR_EVAL/tb-schema-evidence.out" "$TMPDIR_EVAL/tb-schema-evidence.err")"
fi

TB_BUNDLE_PATH="$TB_SCHEMA_DIR/trust.bundle"
if [[ -f "$TB_BUNDLE_PATH" ]]; then
  if node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/tb-validate.err"
import { readFileSync } from 'node:fs';
import { validateTrustBundle } from '${ROOT}/build/src/cli/workflow-sidecar.js';
const bundle = JSON.parse(readFileSync('${TB_BUNDLE_PATH}', 'utf8'));
const result = await validateTrustBundle(bundle);
if (!result.available) { process.stderr.write('surface unavailable: validateTrustBundle.available was false\n'); process.exit(2); }
if (!result.valid) { process.stderr.write('schema invalid: ' + result.errors.join('; ') + '\n'); process.exit(1); }
NODEOF
  then
    _pass "trust.bundle dual-write produces schema-valid bundle (available:true, valid:true)"
  else
    _fail "trust.bundle schema validation failed: $(cat "$TMPDIR_EVAL/tb-validate.err")"
  fi
fi

# ─── AC2: claim status fidelity — pass→verified, fail→disputed ───────────────
TB_FIDELITY_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/trust-bundle-fidelity"
mkdir -p "$TB_FIDELITY_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$TB_FIDELITY_DIR/trust-bundle-fidelity--deliver.md"
flow_agents_node "$WRITER" init-plan "$TB_FIDELITY_DIR/trust-bundle-fidelity--deliver.md" \
  --source-request "Trust bundle claim fidelity fixture." \
  --summary "Trust bundle claim fidelity fixture." \
  --next-action "Seed pass and fail checks to verify claim status mapping." \
  --timestamp "2026-05-09T00:00:00Z" >"$TMPDIR_EVAL/tb-fidelity-init.out" 2>"$TMPDIR_EVAL/tb-fidelity-init.err"

if flow_agents_node "$WRITER" record-evidence "$TB_FIDELITY_DIR" \
  --verdict fail \
  --check-json '{"id":"tb-pass-check","kind":"test","status":"pass","summary":"This check passed."}' \
  --check-json '{"id":"tb-fail-check","kind":"test","status":"fail","summary":"This check failed."}' \
  --timestamp "2026-05-09T00:01:00Z" >"$TMPDIR_EVAL/tb-fidelity-evidence.out" 2>"$TMPDIR_EVAL/tb-fidelity-evidence.err" \
  && [[ -f "$TB_FIDELITY_DIR/trust.bundle" ]]; then
  if node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/tb-fidelity-check.err"
import { readFileSync } from 'node:fs';
const bundle = JSON.parse(readFileSync('${TB_FIDELITY_DIR}/trust.bundle', 'utf8'));
const claims = bundle.claims;
// Surface uses generateClaimId: search by subjectId (which encodes slug/checkId)
const passClaim = claims.find((c) => c.subjectId && c.subjectId.endsWith('/tb-pass-check'));
const failClaim = claims.find((c) => c.subjectId && c.subjectId.endsWith('/tb-fail-check'));
if (!passClaim) { process.stderr.write('missing claim for subjectId ending with /tb-pass-check\n'); process.exit(1); }
if (!failClaim) { process.stderr.write('missing claim for subjectId ending with /tb-fail-check\n'); process.exit(1); }
if (passClaim.status !== 'verified') { process.stderr.write('pass check claim status was ' + passClaim.status + ', expected verified (Surface deriveClaimStatus)\n'); process.exit(1); }
if (failClaim.status !== 'disputed') { process.stderr.write('fail check claim status was ' + failClaim.status + ', expected disputed (Surface deriveClaimStatus)\n'); process.exit(1); }
// Assert at least one acceptance criterion claim exists (seeded by init-plan)
const acClaims = claims.filter((c) => c.claimType === 'workflow.acceptance.criterion');
if (acClaims.length === 0) { process.stderr.write('expected at least one workflow.acceptance.criterion claim but found none\n'); process.exit(1); }
NODEOF
  then
    _pass "trust.bundle claim fidelity: pass check maps to verified, fail check maps to disputed, ac criterion claim present (Surface deriveClaimStatus)"
  else
    _fail "trust.bundle claim fidelity assertion failed: $(cat "$TMPDIR_EVAL/tb-fidelity-check.err")"
  fi
else
  _fail "trust.bundle claim fidelity setup failed: $(cat "$TMPDIR_EVAL/tb-fidelity-evidence.out" "$TMPDIR_EVAL/tb-fidelity-evidence.err")"
fi

# ─── AC2: claim status fidelity — critique fail→disputed, pass→verified ──────
TB_CRITIQUE_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/trust-bundle-critique"
mkdir -p "$TB_CRITIQUE_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$TB_CRITIQUE_DIR/trust-bundle-critique--deliver.md"
flow_agents_node "$WRITER" init-plan "$TB_CRITIQUE_DIR/trust-bundle-critique--deliver.md" \
  --source-request "Trust bundle critique claim fidelity fixture." \
  --summary "Trust bundle critique claim fidelity fixture." \
  --next-action "Record pass and fail critiques to verify claim status mapping." \
  --timestamp "2026-05-09T00:00:00Z" >"$TMPDIR_EVAL/tb-critique-init.out" 2>"$TMPDIR_EVAL/tb-critique-init.err"
flow_agents_node "$WRITER" record-evidence "$TB_CRITIQUE_DIR" \
  --verdict pass \
  --check-json '{"id":"tb-critique-setup","kind":"test","status":"pass","summary":"Critique fidelity setup passed."}' \
  --timestamp "2026-05-09T00:01:00Z" >"$TMPDIR_EVAL/tb-critique-evidence.out" 2>"$TMPDIR_EVAL/tb-critique-evidence.err"

# Record a failing critique (verdict fail → claim status disputed)
flow_agents_node "$WRITER" record-critique "$TB_CRITIQUE_DIR" \
  --id tb-fail-review \
  --reviewer tool-code-reviewer \
  --verdict fail \
  --summary "Critique failed — blocking finding." \
  --timestamp "2026-05-09T00:02:00Z" >"$TMPDIR_EVAL/tb-critique-fail.out" 2>"$TMPDIR_EVAL/tb-critique-fail.err" || true

# Record a passing critique (verdict pass, no open findings → claim status verified)
if flow_agents_node "$WRITER" record-critique "$TB_CRITIQUE_DIR" \
  --id tb-pass-review \
  --reviewer tool-code-reviewer \
  --verdict pass \
  --summary "Critique passed — no blocking findings." \
  --timestamp "2026-05-09T00:02:30Z" >"$TMPDIR_EVAL/tb-critique-pass.out" 2>"$TMPDIR_EVAL/tb-critique-pass.err" \
  && [[ -f "$TB_CRITIQUE_DIR/trust.bundle" ]]; then
  if node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/tb-critique-assert.err"
import { readFileSync } from 'node:fs';
const bundle = JSON.parse(readFileSync('${TB_CRITIQUE_DIR}/trust.bundle', 'utf8'));
const claims = bundle.claims;
// Surface uses generateClaimId: search by subjectId (which encodes slug/reviewId)
const failCritique = claims.find((c) => c.subjectId && c.subjectId.endsWith('/tb-fail-review'));
const passCritique = claims.find((c) => c.subjectId && c.subjectId.endsWith('/tb-pass-review'));
if (!failCritique) { process.stderr.write('missing claim for subjectId ending with /tb-fail-review\n'); process.exit(1); }
if (!passCritique) { process.stderr.write('missing claim for subjectId ending with /tb-pass-review\n'); process.exit(1); }
if (failCritique.status !== 'disputed') { process.stderr.write('fail critique claim status was ' + failCritique.status + ', expected disputed (Surface deriveClaimStatus)\n'); process.exit(1); }
if (passCritique.status !== 'verified') { process.stderr.write('pass critique claim status was ' + passCritique.status + ', expected verified (Surface deriveClaimStatus)\n'); process.exit(1); }
NODEOF
  then
    _pass "trust.bundle claim fidelity: critique fail→disputed, critique pass→verified"
  else
    _fail "trust.bundle critique claim fidelity assertion failed: $(cat "$TMPDIR_EVAL/tb-critique-assert.err")"
  fi
else
  _fail "trust.bundle critique claim fidelity setup failed: $(cat "$TMPDIR_EVAL/tb-critique-pass.out" "$TMPDIR_EVAL/tb-critique-pass.err")"
fi

# ─── AC3: capture authoritative over claimed status + policies present (ADR 0010 maximal) ──
TB_CAPTURE_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/trust-bundle-capture"
mkdir -p "$TB_CAPTURE_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$TB_CAPTURE_DIR/trust-bundle-capture--deliver.md"
flow_agents_node "$WRITER" init-plan "$TB_CAPTURE_DIR/trust-bundle-capture--deliver.md" \
  --source-request "Capture-authoritative trust bundle fixture." \
  --summary "Capture-authoritative trust bundle fixture." \
  --next-action "Seed a claimed-pass check whose command actually failed in the capture log." \
  --timestamp "2026-05-09T00:00:00Z" >"$TMPDIR_EVAL/tb-capture-init.out" 2>"$TMPDIR_EVAL/tb-capture-init.err"
# Deterministic capture log: the command FAILED (exit 1), recorded before record-evidence.
printf '%s\n' '{"command":"npm test","observedResult":"fail","exitCode":1}' > "$TB_CAPTURE_DIR/command-log.jsonl"
if flow_agents_node "$WRITER" record-evidence "$TB_CAPTURE_DIR" \
  --verdict pass \
  --check-json '{"id":"tb-capture-check","kind":"test","status":"pass","summary":"Claimed pass.","command":"npm test"}' \
  --timestamp "2026-05-09T00:01:00Z" >"$TMPDIR_EVAL/tb-capture-evidence.out" 2>"$TMPDIR_EVAL/tb-capture-evidence.err" \
  && [[ -f "$TB_CAPTURE_DIR/trust.bundle" ]]; then
  if node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/tb-capture-assert.err"
import { readFileSync } from 'node:fs';
const bundle = JSON.parse(readFileSync('${TB_CAPTURE_DIR}/trust.bundle', 'utf8'));
const claim = bundle.claims.find((c) => c.subjectId && c.subjectId.endsWith('/tb-capture-check'));
if (!claim) { process.stderr.write('missing claim for /tb-capture-check\n'); process.exit(1); }
if (claim.status !== 'disputed') { process.stderr.write('claimed-pass check with captured FAIL had status ' + claim.status + ', expected disputed (capture authoritative)\n'); process.exit(1); }
if (!Array.isArray(bundle.policies) || bundle.policies.length === 0) { process.stderr.write('bundle.policies empty — expected a verification policy per claimType\n'); process.exit(1); }
const ev = bundle.evidence.find((e) => e.claimId === claim.id);
if (!ev || !ev.execution || ev.execution.isError !== true) { process.stderr.write('capture evidence with execution.isError=true missing\n'); process.exit(1); }
NODEOF
  then
    _pass "trust.bundle capture authoritative: claimed-pass + captured-fail → disputed; policies present; execution evidence folded in"
  else
    _fail "trust.bundle capture-authoritative assertion failed: $(cat "$TMPDIR_EVAL/tb-capture-assert.err")"
  fi
else
  _fail "trust.bundle capture-authoritative setup failed: $(cat "$TMPDIR_EVAL/tb-capture-evidence.out" "$TMPDIR_EVAL/tb-capture-evidence.err")"
fi

# ─── #470 iteration 2 (finding #2, HIGH): captureByCommand treats ambiguous as
# non-confirming, never coerced to "pass" (would reconcile as a verified event + passing:true,
# reintroducing the #470 false-pass). A command-log entry whose only capture is
# observedResult:"ambiguous" (e.g. a codex no-signal capture, or the #362 grep/diff absence
# carve-out) paired with a claimed-pass check must build a bundle claim whose value is the
# EXISTING canonical non-confirming status "not_verified", an evidence item stamped
# passing:false, and NO verification event for that claim. ------------------------------------
TB_AMBIGUOUS_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/trust-bundle-ambiguous"
mkdir -p "$TB_AMBIGUOUS_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$TB_AMBIGUOUS_DIR/trust-bundle-ambiguous--deliver.md"
flow_agents_node "$WRITER" init-plan "$TB_AMBIGUOUS_DIR/trust-bundle-ambiguous--deliver.md" \
  --source-request "Ambiguous-capture non-confirming trust bundle fixture (#470 iteration 2)." \
  --summary "Ambiguous-capture non-confirming trust bundle fixture." \
  --next-action "Seed a claimed-pass check whose only capture is observedResult:ambiguous." \
  --timestamp "2026-05-09T00:00:00Z" >"$TMPDIR_EVAL/tb-ambiguous-init.out" 2>"$TMPDIR_EVAL/tb-ambiguous-init.err"
# Deterministic capture log: the command produced NO usable pass/fail signal (codex no-signal
# default / #362 absence carve-out), recorded before record-evidence.
printf '%s\n' '{"command":"npm test","observedResult":"ambiguous","exitCode":null}' > "$TB_AMBIGUOUS_DIR/command-log.jsonl"
if flow_agents_node "$WRITER" record-evidence "$TB_AMBIGUOUS_DIR" \
  --verdict pass \
  --check-json '{"id":"tb-ambiguous-check","kind":"test","status":"pass","summary":"Claimed pass.","command":"npm test"}' \
  --timestamp "2026-05-09T00:01:00Z" >"$TMPDIR_EVAL/tb-ambiguous-evidence.out" 2>"$TMPDIR_EVAL/tb-ambiguous-evidence.err" \
  && [[ -f "$TB_AMBIGUOUS_DIR/trust.bundle" ]]; then
  if node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/tb-ambiguous-assert.err"
import { readFileSync } from 'node:fs';
const bundle = JSON.parse(readFileSync('${TB_AMBIGUOUS_DIR}/trust.bundle', 'utf8'));
const claim = bundle.claims.find((c) => c.subjectId && c.subjectId.endsWith('/tb-ambiguous-check'));
if (!claim) { process.stderr.write('missing claim for /tb-ambiguous-check\n'); process.exit(1); }
if (claim.value !== 'not_verified') { process.stderr.write('claimed-pass check with captured ambiguous had claim.value ' + claim.value + ', expected not_verified\n'); process.exit(1); }
if (claim.status === 'verified') { process.stderr.write('claimed-pass check with captured ambiguous derived claim.status verified -- ambiguous must never confirm\n'); process.exit(1); }
const ev = bundle.evidence.find((e) => e.claimId === claim.id);
if (!ev) { process.stderr.write('missing evidence item for ambiguous-captured claim\n'); process.exit(1); }
if (ev.passing !== false) { process.stderr.write('ambiguous-captured evidence item had passing=' + ev.passing + ', expected false\n'); process.exit(1); }
if (ev.execution && ev.execution.isError !== false) { process.stderr.write('ambiguous-captured evidence item had execution.isError=' + (ev.execution && ev.execution.isError) + ', expected false (ambiguous is not an error)\n'); process.exit(1); }
const verifiedEvent = bundle.events.find((e) => e.claimId === claim.id && e.status === 'verified');
if (verifiedEvent) { process.stderr.write('a verified event was emitted for an ambiguous-captured claim -- #470 false-pass reintroduced\n'); process.exit(1); }
NODEOF
  then
    _pass "trust.bundle ambiguous non-confirming (#470 iter2): claimed-pass + captured-ambiguous -> claim.value=not_verified, passing:false, no verified event"
  else
    _fail "trust.bundle ambiguous non-confirming assertion failed: $(cat "$TMPDIR_EVAL/tb-ambiguous-assert.err")"
  fi
else
  _fail "trust.bundle ambiguous non-confirming setup failed: $(cat "$TMPDIR_EVAL/tb-ambiguous-evidence.out" "$TMPDIR_EVAL/tb-ambiguous-evidence.err")"
fi

# ---- #347: hard cutover -- an unstamped (pre-#344) claim in a session trust bundle is a loud,
# typed error; checksFromBundle/critiquesFromBundle carry NO claimType-derivation fallback (that
# fallback WAS the #268 defect kept reachable). ----------------------------------------------
TB_UNSTAMPED_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/trust-bundle-unstamped"
mkdir -p "$TB_UNSTAMPED_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$TB_UNSTAMPED_DIR/trust-bundle-unstamped--deliver.md"
flow_agents_node "$WRITER" init-plan "$TB_UNSTAMPED_DIR/trust-bundle-unstamped--deliver.md" \
  --source-request "Unstamped bundle regression fixture." \
  --summary "Unstamped bundle regression fixture." \
  --next-action "Seed a stamped check, then strip its origin stamp to simulate a pre-#344 bundle." \
  --timestamp "2026-05-09T00:00:00Z" >"$TMPDIR_EVAL/tb-unstamped-init.out" 2>"$TMPDIR_EVAL/tb-unstamped-init.err"
flow_agents_node "$WRITER" record-evidence "$TB_UNSTAMPED_DIR" \
  --verdict pass \
  --check-json '{"id":"tb-unstamped-check","kind":"test","status":"pass","summary":"Stamped check, about to be corrupted."}' \
  --timestamp "2026-05-09T00:01:00Z" >"$TMPDIR_EVAL/tb-unstamped-evidence.out" 2>"$TMPDIR_EVAL/tb-unstamped-evidence.err"

# Simulate a pre-#344 bundle by stripping the origin/check_kind stamp from every claim -- never
# done by hand-editing production sessions, only here to recreate the on-disk shape of a bundle
# recorded before #344 shipped stamping.
export UNSTAMPED_TARGET="$TB_UNSTAMPED_DIR/trust.bundle"
node --input-type=module <<NODEOF
import { readFileSync, writeFileSync } from 'node:fs';
const target = process.env.UNSTAMPED_TARGET;
const data = JSON.parse(readFileSync(target, 'utf8'));
data.claims = (data.claims || []).map((c) => {
  if (c && c.metadata && typeof c.metadata === 'object') {
    const rest = { ...c.metadata };
    delete rest.origin;
    delete rest.check_kind;
    return { ...c, metadata: rest };
  }
  return c;
});
writeFileSync(target, JSON.stringify(data, null, 2) + '\n');
NODEOF

if flow_agents_node "$WRITER" record-critique "$TB_UNSTAMPED_DIR" \
  --id tb-unstamped-review \
  --reviewer tool-code-reviewer \
  --verdict pass \
  --summary "Should never be recorded -- the bundle is unstamped." \
  --timestamp "2026-05-09T00:02:00Z" >"$TMPDIR_EVAL/tb-unstamped-critique.out" 2>"$TMPDIR_EVAL/tb-unstamped-critique.err"; then
  _fail "record-critique should refuse to read an unstamped (pre-#344) trust.bundle, not silently reclassify it by claimType"
elif rg -q 'pre-supersession trust\.bundle' "$TMPDIR_EVAL/tb-unstamped-critique.out" "$TMPDIR_EVAL/tb-unstamped-critique.err" \
  && rg -qF "$TB_UNSTAMPED_DIR" "$TMPDIR_EVAL/tb-unstamped-critique.out" "$TMPDIR_EVAL/tb-unstamped-critique.err" \
  && rg -q 're-record evidence to regenerate' "$TMPDIR_EVAL/tb-unstamped-critique.out" "$TMPDIR_EVAL/tb-unstamped-critique.err" \
  && rg -q 'record-evidence' "$TMPDIR_EVAL/tb-unstamped-critique.out" "$TMPDIR_EVAL/tb-unstamped-critique.err"; then
  _pass "record-critique refuses an unstamped (pre-#344) trust.bundle: typed error names the session dir and the record-evidence remedy (no claimType-derivation fallback, #347)"
else
  _fail "record-critique on an unstamped bundle failed for the wrong reason: $(cat "$TMPDIR_EVAL/tb-unstamped-critique.out" "$TMPDIR_EVAL/tb-unstamped-critique.err")"
fi

# The same unstamped bundle also refuses promote (checksFromBundle) -- not just
# record-critique/critiquesFromBundle.
if flow_agents_node "$WRITER" promote "$TB_UNSTAMPED_DIR" --none --reason "regression probe" \
  --timestamp "2026-05-09T00:03:00Z" >"$TMPDIR_EVAL/tb-unstamped-promote.out" 2>"$TMPDIR_EVAL/tb-unstamped-promote.err"; then
  _fail "promote should refuse to read an unstamped (pre-#344) trust.bundle via checksFromBundle"
elif rg -q 'pre-supersession trust\.bundle' "$TMPDIR_EVAL/tb-unstamped-promote.out" "$TMPDIR_EVAL/tb-unstamped-promote.err"; then
  _pass "promote (checksFromBundle) also refuses an unstamped (pre-#344) trust.bundle with the same typed error"
else
  _fail "promote on an unstamped bundle failed for the wrong reason: $(cat "$TMPDIR_EVAL/tb-unstamped-promote.out" "$TMPDIR_EVAL/tb-unstamped-promote.err")"
fi

# (b) STAMPED bundles are unaffected: the earlier, still-stamped trust-bundle-critique fixture
# carries the origin stamp on every claim -- the normal write path was never touched by this cutover.
export STAMPED_TARGET="$TB_CRITIQUE_DIR/trust.bundle"
if [[ -f "$STAMPED_TARGET" ]] && node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/tb-stamped-unaffected.err"
import { readFileSync } from 'node:fs';
const target = process.env.STAMPED_TARGET;
const bundle = JSON.parse(readFileSync(target, 'utf8'));
const unstamped = bundle.claims.filter((c) => !(c.metadata && typeof c.metadata === 'object' && typeof c.metadata.origin === 'string' && c.metadata.origin.length > 0));
if (unstamped.length > 0) { process.stderr.write('found ' + unstamped.length + ' claim(s) with no origin stamp in a normally-written bundle\n'); process.exit(1); }
NODEOF
then
  _pass "stamped bundles are unaffected: every claim in a normally-written trust bundle carries the origin stamp (#347)"
else
  _fail "stamped-bundle regression: $(cat "$TMPDIR_EVAL/tb-stamped-unaffected.err")"
fi

# ─── AC4: render-trust-panel projects the bundle to a standalone Surface Trust Panel (ADR 0010 Phase 3) ──
if [[ -f "$TB_CAPTURE_DIR/trust.bundle" ]] && flow_agents_node "$WRITER" render-trust-panel "$TB_CAPTURE_DIR" --out "$TB_CAPTURE_DIR/trust-panel.html" >"$TMPDIR_EVAL/tb-panel.out" 2>"$TMPDIR_EVAL/tb-panel.err"; then
  PANEL="$TB_CAPTURE_DIR/trust-panel.html"
  REPORT="$TB_CAPTURE_DIR/trust-report.json"
  if [[ -f "$PANEL" ]] \
    && rg -q "<surface-trust-panel" "$PANEL" \
    && rg -q "customElements.define" "$PANEL" \
    && rg -q '"status":"disputed"' "$PANEL"; then
    _pass "render-trust-panel: standalone Trust Panel HTML with inlined Surface element + disputed claim from the derived report"
  else
    _fail "render-trust-panel output missing panel element / inlined JS / disputed claim"
  fi
  # report artifact: the derived TrustReport (universal input for Surface's Snapshot Viewer / bare element)
  if [[ -f "$REPORT" ]] && rg -q '"status": "disputed"' "$REPORT" && rg -q '"claims"' "$REPORT"; then
    _pass "render-trust-panel: also emits trust-report.json (derived report with the disputed claim)"
  else
    _fail "render-trust-panel did not emit a valid trust-report.json: $(head -c 200 "$REPORT" 2>/dev/null)"
  fi
else
  _fail "render-trust-panel failed: $(cat "$TMPDIR_EVAL/tb-panel.out" "$TMPDIR_EVAL/tb-panel.err")"
fi

# ─── AC5: trust-mcp wiring (flow-agents#137) — zero-write print + opt-in, reversible enable/disable ──
TB_MCP_CFG="$TMPDIR_EVAL/mcp/.mcp.json"
mkdir -p "$(dirname "$TB_MCP_CFG")"
echo '{"mcpServers":{"other":{"command":"x","args":[]}}}' > "$TB_MCP_CFG"
if flow_agents_node "$WRITER" trust-mcp >"$TMPDIR_EVAL/tb-mcp-print.out" 2>/dev/null \
  && rg -q "flow-agents-surface-trust" "$TMPDIR_EVAL/tb-mcp-print.out" \
  && flow_agents_node "$WRITER" trust-mcp --mode enable --config "$TB_MCP_CFG" >/dev/null 2>&1 \
  && flow_agents_node "$WRITER" trust-mcp --mode enable --config "$TB_MCP_CFG" >/dev/null 2>&1; then
  if node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/tb-mcp.err"
import { readFileSync } from 'node:fs';
const s = (JSON.parse(readFileSync('${TB_MCP_CFG}','utf8')).mcpServers) || {};
if (!s['flow-agents-surface-trust']) { process.stderr.write('enable did not add our server\n'); process.exit(1); }
if (!s['other']) { process.stderr.write('enable clobbered an existing server\n'); process.exit(1); }
if (Object.keys(s).length !== 2) { process.stderr.write('enable not idempotent (count ' + Object.keys(s).length + ')\n'); process.exit(1); }
NODEOF
  then
    flow_agents_node "$WRITER" trust-mcp --mode disable --config "$TB_MCP_CFG" >/dev/null 2>&1
    if node --input-type=module <<NODEOF 2>>"$TMPDIR_EVAL/tb-mcp.err"
import { readFileSync } from 'node:fs';
const s = (JSON.parse(readFileSync('${TB_MCP_CFG}','utf8')).mcpServers) || {};
if (s['flow-agents-surface-trust']) { process.stderr.write('disable left our server\n'); process.exit(1); }
if (!s['other']) { process.stderr.write('disable removed an existing server\n'); process.exit(1); }
NODEOF
    then
      _pass "trust-mcp: zero-write print; enable idempotent + preserves existing; disable removes only ours"
    else
      _fail "trust-mcp disable assertion failed: $(cat "$TMPDIR_EVAL/tb-mcp.err")"
    fi
  else
    _fail "trust-mcp enable assertion failed: $(cat "$TMPDIR_EVAL/tb-mcp.err")"
  fi
else
  _fail "trust-mcp print/enable invocation failed"
fi

# ─── AC6: agent liveness (ADR 0012) — held / free-on-lapse / free-on-release ──
TB_LIVENESS_ROOT="$TMPDIR_EVAL/liveness/.kontourai/flow-agents"
flow_agents_node "$WRITER" liveness claim     held-subj  --actor agent-A --at "2026-06-25T11:50:00Z" --ttl 1800 --artifact-root "$TB_LIVENESS_ROOT" >/dev/null 2>&1
flow_agents_node "$WRITER" liveness heartbeat held-subj  --actor agent-A --at "2026-06-25T11:58:00Z" --artifact-root "$TB_LIVENESS_ROOT" >/dev/null 2>&1
flow_agents_node "$WRITER" liveness claim     stale-subj --actor agent-B --at "2026-06-25T11:00:00Z" --ttl 1800 --artifact-root "$TB_LIVENESS_ROOT" >/dev/null 2>&1
flow_agents_node "$WRITER" liveness claim     rel-subj   --actor agent-C --at "2026-06-25T11:50:00Z" --ttl 1800 --artifact-root "$TB_LIVENESS_ROOT" >/dev/null 2>&1
flow_agents_node "$WRITER" liveness release   rel-subj   --actor agent-C --at "2026-06-25T11:55:00Z" --artifact-root "$TB_LIVENESS_ROOT" >/dev/null 2>&1
LIVENESS_OUT=$(flow_agents_node "$WRITER" liveness status --now "2026-06-25T12:00:00Z" --artifact-root "$TB_LIVENESS_ROOT" 2>/dev/null | grep -viE "unknown format")
if echo "$LIVENESS_OUT" | grep -qE "held-subj.*agent-A.*held" \
  && echo "$LIVENESS_OUT" | grep -qE "stale-subj.*agent-B.*free" \
  && echo "$LIVENESS_OUT" | grep -qE "rel-subj.*agent-C.*free"; then
  _pass "liveness: liveness claims recompute held / free(lapsed) / free(released) via Surface deriveTrustStatus (ADR 0012)"
else
  _fail "liveness status mismatch (expected held/free/free): $LIVENESS_OUT"
fi

# ─── F8(i) (#288 fix iteration 2, orphan-heartbeat invariant): direct CLI `liveness
# heartbeat`/`release` must die with remediation when no prior claim event exists for the
# (subjectId, actor) pair — the exact reproduction the reviewer flagged ("liveness heartbeat
# <subj> --actor <a> with no prior claim writes an orphan heartbeat"). `claim` itself is
# unaffected (it establishes the pair). ──
TB_ORPHAN_ROOT="$TMPDIR_EVAL/liveness-orphan/.kontourai/flow-agents"
if flow_agents_node "$WRITER" liveness heartbeat orphan-subj --actor agent-orphan --artifact-root "$TB_ORPHAN_ROOT" >"$TMPDIR_EVAL/orphan-heartbeat.out" 2>"$TMPDIR_EVAL/orphan-heartbeat.err"; then
  _fail "liveness (F8(i)): heartbeat with no prior claim for the (subject, actor) pair should have exited nonzero"
elif rg -qi 'prior claim' "$TMPDIR_EVAL/orphan-heartbeat.err" && rg -qi 'liveness claim' "$TMPDIR_EVAL/orphan-heartbeat.err"   && [[ ! -f "$TB_ORPHAN_ROOT/liveness/events.jsonl" ]]; then
  _pass "liveness (F8(i)): heartbeat with no prior claim dies with remediation naming 'liveness claim' and writes no orphan event"
else
  _fail "liveness (F8(i)) orphan-heartbeat rejection lacked remediation or wrote an event: $(cat "$TMPDIR_EVAL/orphan-heartbeat.out" "$TMPDIR_EVAL/orphan-heartbeat.err")"
fi

if flow_agents_node "$WRITER" liveness release orphan-release-subj --actor agent-orphan-r --artifact-root "$TB_ORPHAN_ROOT" >"$TMPDIR_EVAL/orphan-release.out" 2>"$TMPDIR_EVAL/orphan-release.err"; then
  _fail "liveness (F8(i)): release with no prior claim for the (subject, actor) pair should have exited nonzero"
elif rg -qi 'prior claim' "$TMPDIR_EVAL/orphan-release.err" && rg -qi 'liveness claim' "$TMPDIR_EVAL/orphan-release.err"   && ! rg -q '"subjectId":"orphan-release-subj"' "$TB_ORPHAN_ROOT/liveness/events.jsonl" 2>/dev/null; then
  _pass "liveness (F8(i)): release with no prior claim dies with remediation naming 'liveness claim' and writes no orphan event"
else
  _fail "liveness (F8(i)) orphan-release rejection lacked remediation or wrote an event: $(cat "$TMPDIR_EVAL/orphan-release.out" "$TMPDIR_EVAL/orphan-release.err")"
fi

# A prior claim for the SAME subjectId but a DIFFERENT actor must not satisfy the check — the
# invariant is per-(subject, actor) pair, not merely per-subject.
flow_agents_node "$WRITER" liveness claim orphan-crossactor-subj --actor agent-orphan-real --artifact-root "$TB_ORPHAN_ROOT" >/dev/null 2>&1
if flow_agents_node "$WRITER" liveness heartbeat orphan-crossactor-subj --actor agent-orphan-impostor --artifact-root "$TB_ORPHAN_ROOT" >"$TMPDIR_EVAL/orphan-crossactor.out" 2>"$TMPDIR_EVAL/orphan-crossactor.err"; then
  _fail "liveness (F8(i)): heartbeat for a different actor than the one who claimed should have exited nonzero"
elif rg -qi 'prior claim' "$TMPDIR_EVAL/orphan-crossactor.err"   && ! rg -q '"subjectId":"orphan-crossactor-subj","actor":"agent-orphan-impostor","at":"[^"]*","type":"heartbeat"' "$TB_ORPHAN_ROOT/liveness/events.jsonl" 2>/dev/null   && ! rg -q '"type":"heartbeat".*"subjectId":"orphan-crossactor-subj".*"actor":"agent-orphan-impostor"' "$TB_ORPHAN_ROOT/liveness/events.jsonl" 2>/dev/null; then
  _pass "liveness (F8(i)): the prior-claim check is scoped per (subject, actor) pair — another actor's claim on the same subject does not satisfy it"
else
  _fail "liveness (F8(i)) cross-actor orphan-heartbeat check failed: $(cat "$TMPDIR_EVAL/orphan-crossactor.out" "$TMPDIR_EVAL/orphan-crossactor.err")"
fi

# claim itself is unaffected: it must still succeed with no prior claim of any kind.
if flow_agents_node "$WRITER" liveness claim orphan-claim-ok-subj --actor agent-orphan-ok --artifact-root "$TB_ORPHAN_ROOT" >"$TMPDIR_EVAL/orphan-claim-ok.out" 2>"$TMPDIR_EVAL/orphan-claim-ok.err"   && rg -q '"type":"claim","subjectId":"orphan-claim-ok-subj"' "$TB_ORPHAN_ROOT/liveness/events.jsonl"; then
  _pass "liveness (F8(i)): claim is unaffected by the prior-claim requirement — it succeeds with no prior events at all"
else
  _fail "liveness (F8(i)) claim regressed: $(cat "$TMPDIR_EVAL/orphan-claim-ok.out" "$TMPDIR_EVAL/orphan-claim-ok.err")"
fi

# ─── AC7: lifecycle-driven liveness (ADR 0012) — init-plan claims, advance-state releases (default-on) ──
TB_LC_ROOT="$TMPDIR_EVAL/liveness-lifecycle/.kontourai/flow-agents"
TB_LC_DIR="$TB_LC_ROOT/lc-task"; mkdir -p "$TB_LC_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$TB_LC_DIR/lc-task--deliver.md"
FLOW_AGENTS_ACTOR=agent-LC flow_agents_node "$WRITER" init-plan "$TB_LC_DIR/lc-task--deliver.md" --task-slug lc-task --source-request x --summary y --next-action z --timestamp "2026-06-25T11:50:00Z" >/dev/null 2>&1
LC_HELD=$(flow_agents_node "$WRITER" liveness status --now "2026-06-25T12:00:00Z" --artifact-root "$TB_LC_ROOT" 2>/dev/null | grep -viE "unknown format")
LC_CLAIM_EVENTS=$(cat "$TB_LC_ROOT/liveness/events.jsonl" 2>/dev/null)
FLOW_AGENTS_ACTOR=agent-LC flow_agents_node "$WRITER" advance-state "$TB_LC_DIR" --status delivered --phase done --task-slug lc-task --timestamp "2026-06-25T11:55:00Z" >/dev/null 2>&1
LC_FREE=$(flow_agents_node "$WRITER" liveness status --now "2026-06-25T12:00:00Z" --artifact-root "$TB_LC_ROOT" 2>/dev/null | grep -viE "unknown format")
TB_OFF_ROOT="$TMPDIR_EVAL/liveness-off/.kontourai/flow-agents"; mkdir -p "$TB_OFF_ROOT/off-task"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$TB_OFF_ROOT/off-task/off-task--deliver.md"
FLOW_AGENTS_LIVENESS=off flow_agents_node "$WRITER" init-plan "$TB_OFF_ROOT/off-task/off-task--deliver.md" --task-slug off-task --source-request x --summary y --next-action z >/dev/null 2>&1
if echo "$LC_HELD" | grep -qE "lc-task.*agent-LC.*held" \
  && echo "$LC_CLAIM_EVENTS" | grep -qE '"type":"claim","subjectId":"lc-task"' \
  && echo "$LC_FREE" | grep -qE "lc-task.*agent-LC.*free" \
  && [ ! -f "$TB_OFF_ROOT/liveness/events.jsonl" ]; then
  _pass "liveness lifecycle: no env set → init-plan writes a claim event + shows held (default-on proof), advance→delivered releases (free); FLOW_AGENTS_LIVENESS=off respected (no events written)"
else
  _fail "liveness lifecycle mismatch: held=[$LC_HELD] claim-event=[$(echo "$LC_CLAIM_EVENTS" | head -c 200)] free=[$LC_FREE] off=$([ -f "$TB_OFF_ROOT/liveness/events.jsonl" ] && echo wrote || echo none)"
fi

# ─── F2 (#288 fix iteration 1, cr-HIGH coverage gap): FLOW_AGENTS_LIVENESS_TTL_SECONDS is
# honored by the lifecycle auto-claim path — init-plan with the env var set to a custom value
# must emit a claim event carrying that exact ttlSeconds, not the DEFAULT_TTL_SECONDS literal ──
TB_TTL_ROOT="$TMPDIR_EVAL/liveness-ttl-env/.kontourai/flow-agents"
TB_TTL_DIR="$TB_TTL_ROOT/ttl-task"; mkdir -p "$TB_TTL_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$TB_TTL_DIR/ttl-task--deliver.md"
FLOW_AGENTS_ACTOR=agent-TTL FLOW_AGENTS_LIVENESS_TTL_SECONDS=300 flow_agents_node "$WRITER" init-plan "$TB_TTL_DIR/ttl-task--deliver.md" --task-slug ttl-task --source-request x --summary y --next-action z --timestamp "2026-06-25T11:50:00Z" >/dev/null 2>&1
TTL_CLAIM_EVENTS=$(cat "$TB_TTL_ROOT/liveness/events.jsonl" 2>/dev/null)
if echo "$TTL_CLAIM_EVENTS" | grep -qE '"type":"claim","subjectId":"ttl-task".*"ttlSeconds":300'; then
  _pass "liveness lifecycle: FLOW_AGENTS_LIVENESS_TTL_SECONDS=300 → emitted claim carries ttlSeconds:300 (F2, AC2)"
else
  _fail "liveness lifecycle did not honor FLOW_AGENTS_LIVENESS_TTL_SECONDS=300: events=[$(echo "$TTL_CLAIM_EVENTS" | head -c 200)]"
fi

# ─── F5 (#288 fix iteration 1, sec-LOW): hostile subjectId is stripped from the terminal print,
# but preserved verbatim in the persisted event (display-only concern, not a write-shape change) ──
TB_HOSTILE_ROOT="$TMPDIR_EVAL/liveness-hostile-subject/.kontourai/flow-agents"
HOSTILE_SUBJECT=$'hostile\x1b[31msubj\x07tail'
HOSTILE_OUT=$(flow_agents_node "$WRITER" liveness claim "$HOSTILE_SUBJECT" --actor agent-hostile --at "2026-06-25T11:50:00Z" --ttl 1800 --artifact-root "$TB_HOSTILE_ROOT" 2>&1)
HOSTILE_EVENT=$(cat "$TB_HOSTILE_ROOT/liveness/events.jsonl" 2>/dev/null)
if printf '%s' "$HOSTILE_OUT" | grep -qF $'\x1b[31m'; then
  HOSTILE_ESCAPE_LEAKED=true
else
  HOSTILE_ESCAPE_LEAKED=false
fi
if [[ "$HOSTILE_ESCAPE_LEAKED" == "false" ]] \
  && printf '%s' "$HOSTILE_OUT" | grep -qF "hostile" \
  && printf '%s' "$HOSTILE_OUT" | grep -qF "tail" \
  && echo "$HOSTILE_EVENT" | grep -qF 'hostile'; then
  _pass "liveness claim: hostile subjectId (ANSI escape + control char) is stripped from the terminal confirmation print, but preserved verbatim in the persisted event (F5)"
else
  _fail "liveness claim hostile-subjectId print check failed: escape-leaked=$HOSTILE_ESCAPE_LEAKED out=$(printf '%s' "$HOSTILE_OUT" | cat -v) event=$(echo "$HOSTILE_EVENT" | head -c 200)"
fi

# ─── AC5 (#287): two auto-derived sessions (no --actor, no FLOW_AGENTS_ACTOR) → two distinct held holders ──
# Simulates two concurrent sessions on one host via injected CLAUDE_CODE_SESSION_ID envs (the
# runtime-native session-id signal actor-identity.js's resolveActor() reads at priority layer 2).
# Neither invocation passes --actor; the actor is fully auto-derived.
TB_TWOHOLDERS_ROOT="$TMPDIR_EVAL/liveness-two-holders/.kontourai/flow-agents"
CLAUDE_CODE_SESSION_ID=sess-a flow_agents_node "$WRITER" liveness claim two-holder-subj --ttl 1800 --artifact-root "$TB_TWOHOLDERS_ROOT" >"$TMPDIR_EVAL/two-holders-a.out" 2>"$TMPDIR_EVAL/two-holders-a.err"
TWO_HOLDERS_A_STATUS=$?
CLAUDE_CODE_SESSION_ID=sess-b flow_agents_node "$WRITER" liveness claim two-holder-subj --ttl 1800 --artifact-root "$TB_TWOHOLDERS_ROOT" >"$TMPDIR_EVAL/two-holders-b.out" 2>"$TMPDIR_EVAL/two-holders-b.err"
TWO_HOLDERS_B_STATUS=$?
flow_agents_node "$WRITER" liveness status --json --subject two-holder-subj --artifact-root "$TB_TWOHOLDERS_ROOT" >"$TMPDIR_EVAL/two-holders-status.json" 2>"$TMPDIR_EVAL/two-holders-status.err"
if [[ "$TWO_HOLDERS_A_STATUS" -eq 0 && "$TWO_HOLDERS_B_STATUS" -eq 0 ]] \
  && node - "$TMPDIR_EVAL/two-holders-status.json" <<'NODE'
const fs = require("node:fs");
const rows = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!Array.isArray(rows) || rows.length !== 2) throw new Error("expected 2 rows, got " + JSON.stringify(rows));
const held = rows.filter((r) => r.label === "held");
if (held.length !== 2) throw new Error("expected 2 held rows, got " + JSON.stringify(rows));
const actors = new Set(held.map((r) => r.actor));
if (actors.size !== 2) throw new Error("expected 2 distinct actors, got " + JSON.stringify([...actors]));
if ([...actors].some((a) => String(a).toLowerCase() === "local")) throw new Error("actor collapsed to local: " + JSON.stringify([...actors]));
NODE
then
  _pass "liveness (AC5): two auto-derived sessions (no --actor) produce two distinct held holders, not one collapsed 'local' holder"
else
  _fail "liveness (AC5) two-holder check failed: $(cat "$TMPDIR_EVAL/two-holders-a.out" "$TMPDIR_EVAL/two-holders-a.err" "$TMPDIR_EVAL/two-holders-b.out" "$TMPDIR_EVAL/two-holders-b.err" "$TMPDIR_EVAL/two-holders-status.err") json=$(cat "$TMPDIR_EVAL/two-holders-status.json" 2>/dev/null)"
fi

# ─── AC6 (#287): forced-unresolved actor → liveness write exits nonzero with remediation ──
# FLOW_AGENTS_ACTOR_TEST_FORCE_UNRESOLVED=1 (together with NODE_ENV=test — F4, #287 fix iteration 1:
# the hatch requires BOTH vars) is the test-only escape hatch in actor-identity.js's resolveActor():
# it short-circuits to {actor: "", source: "test-forced-unresolved"} before any real runtime/ancestry
# detection runs, deterministically proving the fail-loud path without needing to sabotage ps/proc.
# No --actor flag, no (non-forced) FLOW_AGENTS_ACTOR set.
TB_FORCEUNRES_ROOT="$TMPDIR_EVAL/liveness-forced-unresolved/.kontourai/flow-agents"
if FLOW_AGENTS_ACTOR_TEST_FORCE_UNRESOLVED=1 NODE_ENV=test flow_agents_node "$WRITER" liveness claim forced-unresolved-subj --artifact-root "$TB_FORCEUNRES_ROOT" >"$TMPDIR_EVAL/forced-unresolved.out" 2>"$TMPDIR_EVAL/forced-unresolved.err"; then
  _fail "liveness (AC6): claim with FLOW_AGENTS_ACTOR_TEST_FORCE_UNRESOLVED=1 should have exited nonzero"
elif rg -q -- '--actor' "$TMPDIR_EVAL/forced-unresolved.err" && rg -q -- 'FLOW_AGENTS_ACTOR' "$TMPDIR_EVAL/forced-unresolved.err" \
  && [[ ! -f "$TB_FORCEUNRES_ROOT/liveness/events.jsonl" ]]; then
  _pass "liveness (AC6): forced-unresolved actor (no --actor, no runtime/ancestry signal) exits nonzero naming --actor and FLOW_AGENTS_ACTOR"
else
  _fail "liveness (AC6) forced-unresolved rejection lacked remediation or wrote an event: $(cat "$TMPDIR_EVAL/forced-unresolved.out" "$TMPDIR_EVAL/forced-unresolved.err")"
fi

# ─── AC3 (#287): literal "local" actor is rejected even when explicitly set, not just when absent ──
# Deviation note (see worker report): `FLOW_AGENTS_ACTOR=local` alone (env override, no --actor) is
# REJECTED by actor-identity.js's resolveActor() at the override layer (it can never round-trip back
# in via that seam — see the module's own header comment) but the command then falls through to a
# real runtime/ancestry-derived actor and SUCCEEDS with that distinct, non-"local" value whenever any
# resolution layer is available (true in this sandbox via CLAUDE_CODE_SESSION_ID, and true in nearly
# any environment via the process-ancestry fallback) — empirically confirmed exit 0 during this
# task's investigation. The `--actor local` explicit-flag path bypasses resolveActor's override
# rejection and hits the liveness() guard directly, so it is the deterministic, environment-independent
# way to prove "explicitly set literal local is rejected, never silently written" at the CLI level.
TB_LITERALLOCAL_ROOT="$TMPDIR_EVAL/liveness-literal-local/.kontourai/flow-agents"
if flow_agents_node "$WRITER" liveness claim literal-local-subj --actor local --artifact-root "$TB_LITERALLOCAL_ROOT" >"$TMPDIR_EVAL/literal-local.out" 2>"$TMPDIR_EVAL/literal-local.err"; then
  _fail "liveness (AC3): claim with --actor local should have exited nonzero"
elif rg -q -- '--actor' "$TMPDIR_EVAL/literal-local.err" && rg -q -- 'FLOW_AGENTS_ACTOR' "$TMPDIR_EVAL/literal-local.err" \
  && [[ ! -f "$TB_LITERALLOCAL_ROOT/liveness/events.jsonl" ]]; then
  _pass "liveness (AC3): explicit --actor local (case-insensitive literal) exits nonzero naming --actor and FLOW_AGENTS_ACTOR"
else
  _fail "liveness (AC3) literal-local rejection lacked remediation or wrote an event: $(cat "$TMPDIR_EVAL/literal-local.out" "$TMPDIR_EVAL/literal-local.err")"
fi
if flow_agents_node "$WRITER" liveness claim literal-local-subj-upper --actor LOCAL --artifact-root "$TB_LITERALLOCAL_ROOT" >"$TMPDIR_EVAL/literal-local-upper.out" 2>"$TMPDIR_EVAL/literal-local-upper.err"; then
  _fail "liveness (AC3): claim with --actor LOCAL (case-insensitive) should have exited nonzero"
else
  _pass "liveness (AC3): explicit --actor LOCAL is rejected case-insensitively"
fi
# Env-only override path: FLOW_AGENTS_ACTOR=local (no --actor) must never let "local" round-trip back
# in as the persisted actor — it falls through to auto-derivation instead of dying when a resolution
# layer is available (documented behavior of the override seam, see comment above).
if FLOW_AGENTS_ACTOR=local flow_agents_node "$WRITER" liveness claim literal-local-env-subj --artifact-root "$TB_LITERALLOCAL_ROOT" >"$TMPDIR_EVAL/literal-local-env.out" 2>"$TMPDIR_EVAL/literal-local-env.err" \
  && ! rg -q '"actor":"local"' "$TB_LITERALLOCAL_ROOT/liveness/events.jsonl" 2>/dev/null \
  && ! rg -qi 'by local$' "$TMPDIR_EVAL/literal-local-env.out"; then
  _pass "liveness (AC3): FLOW_AGENTS_ACTOR=local override is rejected and never round-trips into the persisted actor"
else
  _fail "liveness (AC3) FLOW_AGENTS_ACTOR=local override handling regressed: $(cat "$TMPDIR_EVAL/literal-local-env.out" "$TMPDIR_EVAL/literal-local-env.err")"
fi

# ─── T4 (#287 fix iteration 2, F7): explicit --actor value that strips to empty under the allowed
# [A-Za-z0-9_.-] charset is a hard error on the write path (unlike the env-override seam, which
# falls through to derivation) — claim exits nonzero with remediation and writes no event.
TB_STRIPEMPTY_ROOT="$TMPDIR_EVAL/liveness-strip-empty/.kontourai/flow-agents"
if flow_agents_node "$WRITER" liveness claim strip-empty-subj --actor ':::' --artifact-root "$TB_STRIPEMPTY_ROOT" >"$TMPDIR_EVAL/strip-empty.out" 2>"$TMPDIR_EVAL/strip-empty.err"; then
  _fail "liveness (T4/F7): claim with --actor ':::' should have exited nonzero"
elif rg -q -- '--actor' "$TMPDIR_EVAL/strip-empty.err"   && [[ ! -f "$TB_STRIPEMPTY_ROOT/liveness/events.jsonl" ]]; then
  _pass "liveness (T4/F7): --actor ':::' (strips to empty) exits nonzero with --actor remediation and writes no event"
else
  _fail "liveness (T4/F7) strip-to-empty --actor rejection lacked remediation or wrote an event: $(cat "$TMPDIR_EVAL/strip-empty.out" "$TMPDIR_EVAL/strip-empty.err")"
fi

# ─── AC4 (#287): backward-compatible reads of legacy literal "local" events ──
# Hand-seed liveness/events.jsonl directly (bypassing the CLI) to simulate a pre-#287 event whose
# actor field is the literal string "local", then confirm `liveness status` still parses, groups, and
# labels it correctly — reads must keep tolerating historical "local" events (unlike writes).
TB_LEGACY_ROOT="$TMPDIR_EVAL/liveness-legacy/.kontourai/flow-agents"
mkdir -p "$TB_LEGACY_ROOT/liveness"
printf '%s\n' '{"type":"claim","subjectId":"legacy-subj","actor":"local","at":"2026-06-25T11:50:00Z","ttlSeconds":1800}' > "$TB_LEGACY_ROOT/liveness/events.jsonl"
LEGACY_STATUS_OUT=$(flow_agents_node "$WRITER" liveness status --subject legacy-subj --now "2026-06-25T12:00:00Z" --artifact-root "$TB_LEGACY_ROOT" 2>/dev/null)
if echo "$LEGACY_STATUS_OUT" | grep -qE "legacy-subj.*local.*held"; then
  _pass "liveness (AC4): hand-seeded legacy actor:\"local\" event still parses as one held row"
else
  _fail "liveness (AC4) legacy 'local' event failed to parse: $LEGACY_STATUS_OUT"
fi

# ─── AC8: bundle-writers fail LOUDLY when Surface unavailable — no silent data loss (#156) ──
TB_FO_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/failopen"
mkdir -p "$TB_FO_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$TB_FO_DIR/failopen--deliver.md"
flow_agents_node "$WRITER" init-plan "$TB_FO_DIR/failopen--deliver.md" --task-slug failopen --source-request x --summary y --next-action z --timestamp "2026-05-09T00:00:00Z" >/dev/null 2>&1
flow_agents_node "$WRITER" record-evidence "$TB_FO_DIR" --verdict pass --check-json '{"id":"c1","kind":"test","status":"pass","summary":"s"}' --timestamp "2026-05-09T00:01:00Z" >/dev/null 2>&1
# With Surface forced-unavailable, record-critique MUST fail (non-zero), not silently drop the critique.
if FLOW_AGENTS_SURFACE_UNAVAILABLE=1 flow_agents_node "$WRITER" record-critique "$TB_FO_DIR" --id rev-fo --reviewer r --verdict pass --summary fo --timestamp "2026-05-09T00:02:00Z" >"$TMPDIR_EVAL/failopen.out" 2>&1; then
  _fail "record-critique fail-opened (exit 0) when Surface unavailable — SILENT DATA LOSS: $(cat "$TMPDIR_EVAL/failopen.out")"
elif grep -qiE "was NOT written|not persisted" "$TMPDIR_EVAL/failopen.out"; then
  _pass "bundle-writers fail loudly (no silent data loss) when Surface unavailable (#156)"
else
  _fail "record-critique failed but without a clear not-persisted message: $(cat "$TMPDIR_EVAL/failopen.out")"
fi


# ─── AC3: statusFunctionVersion conformance ───────────────────────────────────
# Assert the statusFunctionVersion embedded in the emitted trust.bundle source
# field matches @kontourai/surface's exported statusFunctionVersion constant.
# Also run hachure conformance vectors through Surface's deriveClaimStatus to
# confirm our producer path produces canonical statuses.
TB_CONF_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/trust-bundle-conformance"
mkdir -p "$TB_CONF_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$TB_CONF_DIR/trust-bundle-conformance--deliver.md"
flow_agents_node "$WRITER" init-plan "$TB_CONF_DIR/trust-bundle-conformance--deliver.md"   --source-request "Conformance fixture."   --summary "Conformance fixture."   --next-action "Record evidence and check statusFunctionVersion."   --timestamp "2026-05-09T00:00:00Z" >"$TMPDIR_EVAL/tb-conf-init.out" 2>"$TMPDIR_EVAL/tb-conf-init.err"
flow_agents_node "$WRITER" record-evidence "$TB_CONF_DIR"   --verdict pass   --check-json '{"id":"conf-check","kind":"test","status":"pass","summary":"Conformance check passed."}'   --timestamp "2026-05-09T00:01:00Z" >"$TMPDIR_EVAL/tb-conf-evidence.out" 2>"$TMPDIR_EVAL/tb-conf-evidence.err"

if [[ -f "$TB_CONF_DIR/trust.bundle" ]]; then
  if node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/tb-sfv-check.err"
import { readFileSync } from 'node:fs';
import { statusFunctionVersion } from '@kontourai/surface';
const bundle = JSON.parse(readFileSync('${TB_CONF_DIR}/trust.bundle', 'utf8'));
// statusFunctionVersion is encoded in the source field as "...;statusFunctionVersion=<version>"
const sourceMatch = (bundle.source || '').match(/statusFunctionVersion=(.+)$/);
if (!sourceMatch) { process.stderr.write('bundle source does not contain statusFunctionVersion: ' + bundle.source + '\n'); process.exit(1); }
const bundleSfv = sourceMatch[1];
const surfaceSfv = String(statusFunctionVersion);
if (bundleSfv !== surfaceSfv) {
  process.stderr.write('bundle statusFunctionVersion ' + bundleSfv + ' does not match Surface statusFunctionVersion ' + surfaceSfv + '\n');
  process.exit(1);
}
NODEOF
  then
    _pass "trust.bundle source encodes statusFunctionVersion matching Surface\'s canonical export"
  else
    _fail "trust.bundle statusFunctionVersion mismatch: $(cat "$TMPDIR_EVAL/tb-sfv-check.err")"
  fi
fi

# Conformance vectors: assert Surface's deriveClaimStatus produces canonical statuses
# for hachure's reference sf-*.json vectors (sf-verified-commit → verified, sf-disputed-blocking → disputed).
HACHURE_CONF="$ROOT/node_modules/hachure/conformance"
if [[ -d "$HACHURE_CONF" ]]; then
  if node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/tb-conf-vectors.err"
import { readFileSync, readdirSync } from 'node:fs';
import { deriveClaimStatus, statusFunctionVersion } from '@kontourai/surface';
const confDir = '${HACHURE_CONF}';
const vectors = readdirSync(confDir).filter(f => f.startsWith('sf-') && f.endsWith('.json'));
let passed = 0; let failed = 0;
for (const vec of vectors) {
  const data = JSON.parse(readFileSync(confDir + '/' + vec, 'utf8'));
  const { input, expect, now: nowStr } = data;
  const now = nowStr ? new Date(nowStr) : new Date();
  for (const [claimId, expectedStatus] of Object.entries(expect.statusByClaimId ?? {})) {
    const claim = input.claims.find((c) => c.id === claimId);
    if (!claim) { process.stderr.write('vector ' + vec + ': claim ' + claimId + ' not found\n'); failed++; continue; }
    const evidence = (input.evidence || []).filter((e) => e.claimId === claimId);
    const events = (input.events || []).filter((e) => e.claimId === claimId);
    const policies = (input.policies || []);
    const authorityTrace = (input.authorityTrace || []);
    const result = deriveClaimStatus({ claim, evidence, events, policies, now, authorityTrace });
    if (result.status !== expectedStatus) {
      process.stderr.write('vector ' + vec + ' claim ' + claimId + ': got ' + result.status + ', expected ' + expectedStatus + '\n');
      failed++;
    } else {
      passed++;
    }
  }
}
process.stderr.write('conformance vectors: ' + passed + ' passed, ' + failed + ' failed (statusFunctionVersion=' + statusFunctionVersion + ')\n');
if (failed > 0) process.exit(1);
NODEOF
  then
    _pass "hachure conformance vectors pass Surface deriveClaimStatus"
  else
    _fail "hachure conformance vectors failed: $(cat "$TMPDIR_EVAL/tb-conf-vectors.err")"
  fi
fi

# ─── Deterministic session slug from work-item ref (#161) ───────────────────

WORK_ITEM_ROOT="$TMPDIR_EVAL/work-item-repo/.kontourai/flow-agents"

# (a) --work-item derives deterministic slug kontourai-flow-agents-161
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$WORK_ITEM_ROOT" \
  --work-item "kontourai/flow-agents#161" \
  --title "Work Item 161" \
  --summary "Deterministic slug from work-item ref." \
  --timestamp "2026-06-25T00:00:00Z" >"$TMPDIR_EVAL/wi-ensure.out" 2>"$TMPDIR_EVAL/wi-ensure.err"; then
  _pass "ensure-session --work-item derives slug kontourai-flow-agents-161"
else
  _fail "ensure-session --work-item failed: $(cat "$TMPDIR_EVAL/wi-ensure.out" "$TMPDIR_EVAL/wi-ensure.err")"
fi

if [[ -f "$WORK_ITEM_ROOT/kontourai-flow-agents-161/state.json" ]]; then
  _pass "ensure-session --work-item creates expected session directory"
else
  _fail "ensure-session --work-item did not create $WORK_ITEM_ROOT/kontourai-flow-agents-161/"
fi

# (b) idempotency: second call same ref → same directory, no failure
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$WORK_ITEM_ROOT" \
  --work-item "kontourai/flow-agents#161" \
  --title "Work Item 161 Second" \
  --summary "Idempotent call." \
  --timestamp "2026-06-25T00:00:01Z" >"$TMPDIR_EVAL/wi-ensure2.out" 2>"$TMPDIR_EVAL/wi-ensure2.err" \
  && [[ -f "$WORK_ITEM_ROOT/kontourai-flow-agents-161/state.json" ]]; then
  _pass "ensure-session --work-item is idempotent (same slug/dir on second call)"
else
  _fail "ensure-session --work-item idempotency failed: $(cat "$TMPDIR_EVAL/wi-ensure2.out" "$TMPDIR_EVAL/wi-ensure2.err")"
fi

# (c) --task-slug wins over --work-item (back-compat: explicit overrides derived)
TASK_SLUG_ROOT="$TMPDIR_EVAL/task-slug-repo/.kontourai/flow-agents"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$TASK_SLUG_ROOT" \
  --task-slug "manual-slug" \
  --work-item "kontourai/flow-agents#161" \
  --title "Manual Slug" \
  --summary "Explicit task-slug must win over work-item." \
  --timestamp "2026-06-25T00:00:02Z" >"$TMPDIR_EVAL/wi-taskslug.out" 2>"$TMPDIR_EVAL/wi-taskslug.err" \
  && [[ -d "$TASK_SLUG_ROOT/manual-slug" ]] \
  && [[ ! -d "$TASK_SLUG_ROOT/kontourai-flow-agents-161" ]]; then
  _pass "ensure-session --task-slug wins over --work-item (back-compat)"
else
  _fail "ensure-session --task-slug did not win over --work-item: $(cat "$TMPDIR_EVAL/wi-taskslug.out" "$TMPDIR_EVAL/wi-taskslug.err")"
fi

# (c2) --task-slug only (no --work-item) still works
TASK_SLUG_ONLY_ROOT="$TMPDIR_EVAL/task-slug-only-repo/.kontourai/flow-agents"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$TASK_SLUG_ONLY_ROOT" \
  --task-slug "explicit-only" \
  --title "Explicit Only" \
  --summary "task-slug only, no work-item." \
  --timestamp "2026-06-25T00:00:03Z" >"$TMPDIR_EVAL/wi-onlyslug.out" 2>"$TMPDIR_EVAL/wi-onlyslug.err" \
  && [[ -d "$TASK_SLUG_ONLY_ROOT/explicit-only" ]]; then
  _pass "ensure-session --task-slug alone still works (back-compat regression guard)"
else
  _fail "ensure-session --task-slug alone failed: $(cat "$TMPDIR_EVAL/wi-onlyslug.out" "$TMPDIR_EVAL/wi-onlyslug.err")"
fi

# (d) liveness subjectId matches work-item slug
# ensure-session establishes the slug; liveness events (emitted by init-plan/advance-state) key
# on that same slug as subjectId. We verify this by emitting two liveness claim events directly
# via `liveness claim` using the slug derived from the ref, then asserting both share subjectId.
LIVENESS_WORK_ROOT="$TMPDIR_EVAL/liveness-wi-repo/.kontourai/flow-agents"
# First: ensure-session --work-item produces the expected slug (directory name proof)
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$LIVENESS_WORK_ROOT" \
  --work-item "kontourai/flow-agents#162" \
  --title "Liveness Work Item" \
  --summary "Liveness subjectId test." \
  --timestamp "2026-06-25T00:00:04Z" >"$TMPDIR_EVAL/wi-liveness1.out" 2>"$TMPDIR_EVAL/wi-liveness1.err" \
  && [[ -d "$LIVENESS_WORK_ROOT/kontourai-flow-agents-162" ]]; then
  _pass "ensure-session --work-item creates session dir with deterministic slug"
else
  _fail "ensure-session --work-item session dir check failed: $(cat "$TMPDIR_EVAL/wi-liveness1.out" "$TMPDIR_EVAL/wi-liveness1.err")"
fi

# Emit two liveness claim events using the same subjectId (as init-plan does when FLOW_AGENTS_LIVENESS=on).
# This proves: same work-item ref → same slug → same subjectId across two agents.
FLOW_AGENTS_ACTOR=agent-a flow_agents_node "$WRITER" liveness claim \
  --artifact-root "$LIVENESS_WORK_ROOT" \
  kontourai-flow-agents-162 >"$TMPDIR_EVAL/wi-liveness-claim-a.out" 2>"$TMPDIR_EVAL/wi-liveness-claim-a.err"
FLOW_AGENTS_ACTOR=agent-b flow_agents_node "$WRITER" liveness claim \
  --artifact-root "$LIVENESS_WORK_ROOT" \
  kontourai-flow-agents-162 >"$TMPDIR_EVAL/wi-liveness-claim-b.out" 2>"$TMPDIR_EVAL/wi-liveness-claim-b.err"

LIVENESS_EVENTS="$LIVENESS_WORK_ROOT/liveness/events.jsonl"
if [[ -f "$LIVENESS_EVENTS" ]] \
  && grep -q '"subjectId":"kontourai-flow-agents-162"' "$LIVENESS_EVENTS"; then
  _pass "liveness events contain subjectId kontourai-flow-agents-162"
else
  _fail "liveness events missing expected subjectId: $(cat "$LIVENESS_EVENTS" 2>/dev/null || echo 'file not found')"
fi

# Both events must share the same subjectId value (two agents, same ref → same subjectId)
subject_count=$(grep -c '"subjectId":"kontourai-flow-agents-162"' "$LIVENESS_EVENTS" 2>/dev/null || echo 0)
if [[ "$subject_count" -ge 2 ]]; then
  _pass "both liveness events share subjectId kontourai-flow-agents-162 (same ref → same subjectId)"
else
  _fail "expected >=2 liveness events with subjectId kontourai-flow-agents-162, found $subject_count"
fi

# (e) malformed ref is rejected
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$WORK_ITEM_ROOT" \
  --work-item "kontourai/flow-agents/bad" \
  --title "Bad Ref" \
  --summary "Should fail." \
  --timestamp "2026-06-25T00:00:06Z" >"$TMPDIR_EVAL/wi-bad-slash.out" 2>&1; then
  _fail "ensure-session should reject work-item ref without # separator"
elif grep -q 'owner/repo#id format' "$TMPDIR_EVAL/wi-bad-slash.out"; then
  _pass "ensure-session rejects work-item ref without # separator"
else
  _fail "malformed ref rejection message was unexpected: $(cat "$TMPDIR_EVAL/wi-bad-slash.out")"
fi

if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$WORK_ITEM_ROOT" \
  --work-item "kontourai/flow-agents#abc" \
  --title "Bad ID" \
  --summary "Should fail on non-numeric id." \
  --timestamp "2026-06-25T00:00:07Z" >"$TMPDIR_EVAL/wi-bad-id.out" 2>&1; then
  _fail "ensure-session should reject work-item with non-numeric id"
elif grep -q 'numeric issue number' "$TMPDIR_EVAL/wi-bad-id.out"; then
  _pass "ensure-session rejects work-item with non-numeric id"
else
  _fail "non-numeric id rejection message was unexpected: $(cat "$TMPDIR_EVAL/wi-bad-id.out")"
fi

# Neither --task-slug nor --work-item → back-compat error message must contain "task-slug is required"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$WORK_ITEM_ROOT" \
  --title "No Slug" \
  --summary "Should fail." \
  --timestamp "2026-06-25T00:00:08Z" >"$TMPDIR_EVAL/wi-no-slug.out" 2>&1; then
  _fail "ensure-session should require --task-slug or --work-item"
elif grep -q 'task-slug is required' "$TMPDIR_EVAL/wi-no-slug.out"; then
  _pass "ensure-session dies with 'task-slug is required' when neither flag is supplied (back-compat)"
else
  _fail "missing slug error message lacked 'task-slug is required': $(cat "$TMPDIR_EVAL/wi-no-slug.out")"
fi

# ─── #270/#298 compose layer: gate-claim accumulation, gate-claim typing survives rebuild, ──
# compose-two/three/four-writer round-trip, waiver + artifact_refs/standard_refs round-trip,
# runnability rejection at record time (AC1-AC6, AC8, AC10) ──────────────────────────────────
COMPOSE_ROOT="$TMPDIR_EVAL/compose-root"
COMPOSE_SLUG="compose-270"
COMPOSE_DIR="$COMPOSE_ROOT/$COMPOSE_SLUG"
mkdir -p "$COMPOSE_ROOT"

flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$COMPOSE_ROOT" \
  --task-slug "$COMPOSE_SLUG" \
  --actor compose-actor \
  --flow-id builder.build \
  --title "Compose layer session" \
  --source-request "Compose-safe writer layer smoke session." \
  --summary "Seed session for compose-layer round-trip assertions." \
  --criterion "Compose layer round-trips losslessly" \
  --timestamp "2026-07-05T09:00:00Z" >"$TMPDIR_EVAL/compose-seed.out" 2>"$TMPDIR_EVAL/compose-seed.err"

_compose_claims_json() {
  cat "$COMPOSE_DIR/trust.bundle"
}

# ─── AC3/AC6: record-evidence #1 — command-backed check carrying artifact_refs/standard_refs ──
if flow_agents_node "$WRITER" record-evidence "$COMPOSE_DIR" \
  --verdict pass \
  --check-json '{"id":"compose-build-check","kind":"build","status":"pass","summary":"Build passed","command":"npm run build","artifact_refs":[{"kind":"artifact","file":"build/out.js","summary":"build output"}],"standard_refs":[{"standard":"junit","file":"build/out.xml"}]}' \
  --timestamp "2026-07-05T09:05:00Z" >"$TMPDIR_EVAL/compose-ev1.out" 2>"$TMPDIR_EVAL/compose-ev1.err" \
  && [[ -f "$COMPOSE_DIR/trust.bundle" ]]; then
  _pass "compose: record-evidence #1 (command-backed check w/ artifact_refs/standard_refs) writes trust.bundle"
else
  _fail "compose: record-evidence #1 failed: $(cat "$TMPDIR_EVAL/compose-ev1.out" "$TMPDIR_EVAL/compose-ev1.err")"
fi

if node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/compose-ev1-assert.err"
import { readFileSync } from 'node:fs';
const bundle = JSON.parse(readFileSync('${COMPOSE_DIR}/trust.bundle', 'utf8'));
const claim = bundle.claims.find((c) => c.subjectId && c.subjectId.endsWith('/compose-build-check'));
if (!claim) { process.stderr.write('missing compose-build-check claim\n'); process.exit(1); }
const md = claim.metadata || {};
if (!Array.isArray(md.artifact_refs) || md.artifact_refs.length !== 1) { process.stderr.write('artifact_refs did not stamp onto claim.metadata: ' + JSON.stringify(md.artifact_refs) + '\n'); process.exit(1); }
if (!Array.isArray(md.standard_refs) || md.standard_refs.length !== 1) { process.stderr.write('standard_refs did not stamp onto claim.metadata: ' + JSON.stringify(md.standard_refs) + '\n'); process.exit(1); }
NODEOF
then
  _pass "AC6: artifact_refs/standard_refs stamp onto claim.metadata on FIRST write (#298, previously silently dropped)"
else
  _fail "AC6: artifact_refs/standard_refs did not stamp onto claim.metadata: $(cat "$TMPDIR_EVAL/compose-ev1-assert.err")"
fi

# ─── AC5: record-evidence #2 — a SEPARATE call records a waived session-local check ──────────
if flow_agents_node "$WRITER" record-evidence "$COMPOSE_DIR" \
  --verdict pass \
  --check-json '{"id":"compose-manual-check","kind":"external","status":"pass","summary":"Manual review confirmed no regressions"}' \
  --accepted-gap-reason "manual check waived for compose eval" \
  --waived-by "compose-tester" \
  --timestamp "2026-07-05T09:06:00Z" >"$TMPDIR_EVAL/compose-ev2.out" 2>"$TMPDIR_EVAL/compose-ev2.err"; then
  _pass "compose: record-evidence #2 (waived session-local check) succeeds"
else
  _fail "compose: record-evidence #2 failed: $(cat "$TMPDIR_EVAL/compose-ev2.out" "$TMPDIR_EVAL/compose-ev2.err")"
fi

# ─── AC3: compose-two-writer — check #1 (with artifact_refs/standard_refs) survives the SECOND
# record-evidence call (#298's core complaint: record-evidence previously REPLACED all checks) ──
if node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/compose-two-writer.err"
import { readFileSync } from 'node:fs';
const bundle = JSON.parse(readFileSync('${COMPOSE_DIR}/trust.bundle', 'utf8'));
const claims = bundle.claims;
const buildClaim = claims.find((c) => c.subjectId && c.subjectId.endsWith('/compose-build-check'));
const manualClaim = claims.find((c) => c.subjectId && c.subjectId.endsWith('/compose-manual-check'));
const acClaim = claims.find((c) => c.metadata && c.metadata.origin === 'acceptance');
if (!buildClaim) { process.stderr.write('compose-build-check claim LOST after second record-evidence call (#298 regression)\n'); process.exit(1); }
if (!manualClaim) { process.stderr.write('compose-manual-check claim missing after its own record-evidence call\n'); process.exit(1); }
if (!acClaim) { process.stderr.write('acceptance criterion claim LOST after second record-evidence call\n'); process.exit(1); }
const md = buildClaim.metadata || {};
if (!Array.isArray(md.artifact_refs) || md.artifact_refs.length !== 1) { process.stderr.write('artifact_refs did not survive the SECOND writer pass (AC6 second-writer round-trip)\n'); process.exit(1); }
if (!Array.isArray(md.standard_refs) || md.standard_refs.length !== 1) { process.stderr.write('standard_refs did not survive the SECOND writer pass\n'); process.exit(1); }
const waiverMd = manualClaim.metadata || {};
if (!waiverMd.waiver || waiverMd.waiver.approved_by !== 'compose-tester') { process.stderr.write('waiver did not stamp onto compose-manual-check claim\n'); process.exit(1); }
if (claims.length !== 3) { process.stderr.write('expected exactly 3 claims after 2 record-evidence calls (2 checks + 1 acceptance criterion), got ' + claims.length + '\n'); process.exit(1); }
NODEOF
then
  _pass "AC3: compose-two-writer — record-evidence #1's check (+ artifact_refs/standard_refs) AND the acceptance criterion survive record-evidence #2's call, not replaced"
else
  _fail "AC3: compose-two-writer assertion failed: $(cat "$TMPDIR_EVAL/compose-two-writer.err")"
fi

# ─── AC1/AC10: record-gate-claim (pull-work-gate/selected-work) with --command ───────────────
if flow_agents_node "$WRITER" record-gate-claim "$COMPOSE_DIR" \
  --actor compose-actor \
  --status pass \
  --summary "Work item selected for compose session" \
  --command "npm run validate:source --" \
  --timestamp "2026-07-05T09:07:00Z" >"$TMPDIR_EVAL/compose-gate1.out" 2>"$TMPDIR_EVAL/compose-gate1.err"; then
  _pass "compose: record-gate-claim (selected-work) with --command succeeds"
else
  _fail "compose: record-gate-claim (selected-work) failed: $(cat "$TMPDIR_EVAL/compose-gate1.out" "$TMPDIR_EVAL/compose-gate1.err")"
fi

if node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/compose-gate1-assert.err"
import { readFileSync } from 'node:fs';
const bundle = JSON.parse(readFileSync('${COMPOSE_DIR}/trust.bundle', 'utf8'));
const claims = bundle.claims;
const buildClaim = claims.find((c) => c.subjectId && c.subjectId.endsWith('/compose-build-check'));
const manualClaim = claims.find((c) => c.subjectId && c.subjectId.endsWith('/compose-manual-check'));
const gateClaim = claims.find((c) => c.metadata && c.metadata.gate_claim && c.metadata.gate_claim.expectation_id === 'selected-work');
if (!buildClaim || !manualClaim) { process.stderr.write('record-gate-claim clobbered prior checks (#270 21-claims-to-1 wipe class)\n'); process.exit(1); }
if (!gateClaim) { process.stderr.write('gate claim missing metadata.gate_claim stamp\n'); process.exit(1); }
if (gateClaim.claimType !== 'builder.pull-work.selected' || gateClaim.subjectType !== 'work-item') { process.stderr.write('gate claim typed incorrectly: ' + gateClaim.claimType + '/' + gateClaim.subjectType + '\n'); process.exit(1); }
const ev = bundle.evidence.find((e) => e.claimId === gateClaim.id);
if (!ev || !ev.execution || ev.execution.label !== 'npm run validate:source --') { process.stderr.write('AC10: --command did not stamp execution.label on the gate claim evidence\n'); process.exit(1); }
if (claims.length !== 4) { process.stderr.write('expected exactly 4 claims after record-gate-claim (2 checks + 1 acceptance + 1 gate claim), got ' + claims.length + '\n'); process.exit(1); }
NODEOF
then
  _pass "AC1/AC10: record-gate-claim accumulates (prior checks/criteria survive) and --command sets execution.label on the gate claim"
else
  _fail "AC1/AC10: record-gate-claim accumulation/command assertion failed: $(cat "$TMPDIR_EVAL/compose-gate1-assert.err")"
fi

# ─── advance to `plan` step (phase_map.planning → plan) so a SECOND gate claim can target a ──
# DIFFERENT expectation than pull-work-gate's single "selected-work" entry ────────────────────
if flow_agents_node "$WRITER" advance-state "$COMPOSE_DIR" \
  --actor compose-actor \
  --status in_progress \
  --phase planning \
  --summary "Advance to plan step for a second, different-expectation gate claim" \
  --next-action "Continue" \
  --flow-definition builder.build \
  --route-back-reason implementation_defect \
  --timestamp "2026-07-05T09:07:15Z" >"$TMPDIR_EVAL/compose-advance-plan.out" 2>"$TMPDIR_EVAL/compose-advance-plan.err"; then
  _pass "compose: advance-state moves active step to plan"
else
  _fail "compose: advance-state (to plan) failed: $(cat "$TMPDIR_EVAL/compose-advance-plan.out" "$TMPDIR_EVAL/compose-advance-plan.err")"
fi

# ─── AC1: a SECOND gate claim against a DIFFERENT expectation (plan-gate/implementation-plan) ──
# is additive, not a replacement, of the FIRST gate claim (pull-work-gate/selected-work) ───────
if flow_agents_node "$WRITER" record-gate-claim "$COMPOSE_DIR" \
  --actor compose-actor \
  --status pass \
  --summary "Implementation plan recorded for compose session" \
  --expectation implementation-plan \
  --timestamp "2026-07-05T09:07:30Z" >"$TMPDIR_EVAL/compose-gate2.out" 2>"$TMPDIR_EVAL/compose-gate2.err"; then
  _pass "compose: second record-gate-claim (different expectation, implementation-plan) succeeds"
else
  _fail "compose: second record-gate-claim failed: $(cat "$TMPDIR_EVAL/compose-gate2.out" "$TMPDIR_EVAL/compose-gate2.err")"
fi

if node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/compose-gate2-assert.err"
import { readFileSync } from 'node:fs';
const bundle = JSON.parse(readFileSync('${COMPOSE_DIR}/trust.bundle', 'utf8'));
const claims = bundle.claims;
const gate1 = claims.find((c) => c.metadata && c.metadata.gate_claim && c.metadata.gate_claim.expectation_id === 'selected-work');
const gate2 = claims.find((c) => c.metadata && c.metadata.gate_claim && c.metadata.gate_claim.expectation_id === 'implementation-plan');
if (!gate1) { process.stderr.write('first gate claim (selected-work) LOST after second gate-claim call (#270 wipe class)\n'); process.exit(1); }
if (!gate2) { process.stderr.write('second gate claim (implementation-plan) missing\n'); process.exit(1); }
if (gate2.claimType !== 'builder.plan.implementation' || gate2.subjectType !== 'artifact') { process.stderr.write('second gate claim typed incorrectly: ' + gate2.claimType + '/' + gate2.subjectType + '\n'); process.exit(1); }
if (claims.length !== 5) { process.stderr.write('expected exactly 5 claims after 2 gate claims (2 checks + 1 acceptance + 2 gate claims), got ' + claims.length + '\n'); process.exit(1); }
NODEOF
then
  _pass "AC1: two record-gate-claim calls against DIFFERENT expectations are both additive (neither clobbers the other or prior checks)"
else
  _fail "AC1: two-gate-claim additivity assertion failed: $(cat "$TMPDIR_EVAL/compose-gate2-assert.err")"
fi

# ─── AC2: gate-claim typing survives rebuild after the ACTIVE STEP moves to N+1 ──────────────
if flow_agents_node "$WRITER" advance-state "$COMPOSE_DIR" \
  --actor compose-actor \
  --status in_progress \
  --phase goal_fit \
  --summary "Advance to merge-ready for AC2 rebuild assertion" \
  --next-action "Continue" \
  --flow-definition builder.build \
  --timestamp "2026-07-05T09:08:00Z" >"$TMPDIR_EVAL/compose-advance.out" 2>"$TMPDIR_EVAL/compose-advance.err"; then
  _pass "compose: advance-state moves active step to merge-ready (N+1 relative to pull-work/plan)"
else
  _fail "compose: advance-state failed: $(cat "$TMPDIR_EVAL/compose-advance.out" "$TMPDIR_EVAL/compose-advance.err")"
fi

# record-critique REBUILDS the bundle (checksFromBundle + writeTrustBundle) while the active
# step is merge-ready — the gate claims recorded at pull-work/plan above must NOT be silently
# re-typed as merge-ready claims (that re-typing IS the #270(c) defect).
if flow_agents_node "$WRITER" record-critique "$COMPOSE_DIR" \
  --id compose-review \
  --reviewer compose-reviewer \
  --verdict pass \
  --summary "Compose review looks good" \
  --timestamp "2026-07-05T09:09:00Z" >"$TMPDIR_EVAL/compose-critique.out" 2>"$TMPDIR_EVAL/compose-critique.err"; then
  _pass "compose: record-critique rebuilds the bundle at the new active step (merge-ready)"
else
  _fail "compose: record-critique failed: $(cat "$TMPDIR_EVAL/compose-critique.out" "$TMPDIR_EVAL/compose-critique.err")"
fi

if node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/compose-ac2-assert.err"
import { readFileSync } from 'node:fs';
const bundle = JSON.parse(readFileSync('${COMPOSE_DIR}/trust.bundle', 'utf8'));
const claims = bundle.claims;
const gateClaim1 = claims.find((c) => c.metadata && c.metadata.gate_claim && c.metadata.gate_claim.expectation_id === 'selected-work');
const gateClaim2 = claims.find((c) => c.metadata && c.metadata.gate_claim && c.metadata.gate_claim.expectation_id === 'implementation-plan');
if (!gateClaim1 || !gateClaim2) { process.stderr.write('a gate claim was LOST after rebuild at a later step\n'); process.exit(1); }
if (gateClaim1.claimType !== 'builder.pull-work.selected' || gateClaim1.subjectType !== 'work-item') {
  process.stderr.write('AC2 REGRESSION: gate claim recorded at pull-work was re-typed to ' + gateClaim1.claimType + '/' + gateClaim1.subjectType + ' after rebuild at merge-ready (the #270(c) defect)\n');
  process.exit(1);
}
if (gateClaim2.claimType !== 'builder.plan.implementation' || gateClaim2.subjectType !== 'artifact') {
  process.stderr.write('AC2 REGRESSION: gate claim recorded at plan was re-typed to ' + gateClaim2.claimType + '/' + gateClaim2.subjectType + ' after rebuild at merge-ready\n');
  process.exit(1);
}
if (gateClaim1.metadata.gate_claim.step_id !== 'pull-work') { process.stderr.write('gate_claim.step_id was overwritten to the currently-active step instead of staying pull-work: ' + gateClaim1.metadata.gate_claim.step_id + '\n'); process.exit(1); }
if (gateClaim2.metadata.gate_claim.step_id !== 'plan') { process.stderr.write('gate_claim.step_id was overwritten to the currently-active step instead of staying plan: ' + gateClaim2.metadata.gate_claim.step_id + '\n'); process.exit(1); }
// Meanwhile a PLAIN check claim (no gate_claim stamp) IS correctly re-typed to the new active step —
// this is legitimate, documented behavior (only a stamped gate claim is frozen).
const buildClaim = claims.find((c) => c.subjectId && c.subjectId.endsWith('/compose-build-check'));
if (!buildClaim || buildClaim.claimType !== 'builder.merge-ready.readiness') { process.stderr.write('plain check claim did not re-type to the new active step as expected (unrelated to AC2, sanity check): ' + (buildClaim && buildClaim.claimType) + '\n'); process.exit(1); }
NODEOF
then
  _pass "AC2: gate-claim typing (claimType/subjectType/step_id) survives a rebuild after the active step advances — frozen at record time, not re-derived (#270(a)/(c))"
else
  _fail "AC2: gate-claim-typing-survives-rebuild assertion failed: $(cat "$TMPDIR_EVAL/compose-ac2-assert.err")"
fi

# ─── AC4: compose-three-writer (five writer calls total: evidence x2, gate-claim x2, critique, ──
# then record-learning) — all claim families present and correctly typed in the final bundle ──
if flow_agents_node "$WRITER" record-learning "$COMPOSE_DIR" \
  --status learned \
  --summary "Compose layer round-trips losslessly" \
  --record-json '{"source_refs":[],"facts":["compose layer round-trips losslessly"],"routing":[],"outcome":"success","correction":{"needed":false,"evidence":"compose eval passed"}}' \
  --timestamp "2026-07-05T09:10:00Z" >"$TMPDIR_EVAL/compose-learning.out" 2>"$TMPDIR_EVAL/compose-learning.err"; then
  _pass "compose: record-learning (fourth distinct writer family) succeeds"
else
  _fail "compose: record-learning failed: $(cat "$TMPDIR_EVAL/compose-learning.out" "$TMPDIR_EVAL/compose-learning.err")"
fi

if node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/compose-ac4-assert.err"
import { readFileSync } from 'node:fs';
const bundle = JSON.parse(readFileSync('${COMPOSE_DIR}/trust.bundle', 'utf8'));
const claims = bundle.claims;
const origins = claims.map((c) => (c.metadata || {}).origin);
const originCounts = origins.reduce((acc, o) => { acc[o] = (acc[o] || 0) + 1; return acc; }, {});
// Expect: 2 plain "check" claims (build-check, manual-check) + 2 gate-claim checks (also origin
// "check", distinguished by metadata.gate_claim) + 1 "acceptance" + 1 "critique" = 6 total.
if (originCounts.check !== 4) { process.stderr.write('expected 4 origin:check claims (2 plain checks + 2 gate claims), got ' + originCounts.check + ' (' + JSON.stringify(originCounts) + ')\n'); process.exit(1); }
if (originCounts.acceptance !== 1) { process.stderr.write('expected 1 origin:acceptance claim, got ' + originCounts.acceptance + '\n'); process.exit(1); }
if (originCounts.critique !== 1) { process.stderr.write('expected 1 origin:critique claim, got ' + originCounts.critique + '\n'); process.exit(1); }
if (claims.length !== 6) { process.stderr.write('expected exactly 6 claims total after the full 6-writer sequence, got ' + claims.length + '\n'); process.exit(1); }
const gateClaim1 = claims.find((c) => c.metadata && c.metadata.gate_claim && c.metadata.gate_claim.expectation_id === 'selected-work');
const gateClaim2 = claims.find((c) => c.metadata && c.metadata.gate_claim && c.metadata.gate_claim.expectation_id === 'implementation-plan');
const manualClaim = claims.find((c) => c.subjectId && c.subjectId.endsWith('/compose-manual-check'));
if (!gateClaim1 || gateClaim1.claimType !== 'builder.pull-work.selected') { process.stderr.write('gate claim 1 typing did not survive the FIFTH rebuild (record-learning)\n'); process.exit(1); }
if (!gateClaim2 || gateClaim2.claimType !== 'builder.plan.implementation') { process.stderr.write('gate claim 2 typing did not survive the FIFTH rebuild (record-learning)\n'); process.exit(1); }
if (!manualClaim || !manualClaim.metadata.waiver) { process.stderr.write('waiver did not survive the fifth writer rebuild\n'); process.exit(1); }
NODEOF
then
  _pass "AC4: compose-three-writer (six writer calls total: evidence x2, gate-claim x2, critique, learning) — all claim families present and correctly typed in the final bundle"
else
  _fail "AC4: compose-three-writer assertion failed: $(cat "$TMPDIR_EVAL/compose-ac4-assert.err")"
fi

# ─── AC8: a kind:"command" evidence_refs entry carrying PROSE excerpt is rejected at record ──
# time by record-evidence (validateAcceptanceEvidenceRefs), not silently accepted for the ─────
# Stop-hook backstop to catch later. ───────────────────────────────────────────────────────────
AC8_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/ac8-runnability"
mkdir -p "$AC8_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$AC8_DIR/ac8-runnability--deliver.md"
flow_agents_node "$WRITER" init-plan "$AC8_DIR/ac8-runnability--deliver.md" \
  --source-request "AC8 runnability rejection fixture." \
  --summary "AC8 runnability rejection fixture." \
  --next-action "Seed a prose kind:command evidence_ref." \
  --timestamp "2026-07-05T09:00:00Z" >"$TMPDIR_EVAL/ac8-init.out" 2>"$TMPDIR_EVAL/ac8-init.err"

# Overwrite acceptance.json's criterion with a kind:"command" ref whose excerpt is prose — the
# split-literal convention (see test_validate_source_kit_asset_scope.sh's "self-scan hazard"
# comments) is not needed here since this file is not itself scanned for the phrase.
node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/ac8-mutate.err"
import { readFileSync, writeFileSync } from 'node:fs';
const file = '${AC8_DIR}/acceptance.json';
const data = JSON.parse(readFileSync(file, 'utf8'));
if (!Array.isArray(data.criteria) || data.criteria.length === 0) { process.stderr.write('no criteria to mutate\n'); process.exit(1); }
data.criteria[0].evidence_refs = [{ kind: 'command', excerpt: 'Manually confirmed the output looks correct.' }];
writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
NODEOF

if flow_agents_node "$WRITER" record-evidence "$AC8_DIR" \
  --verdict pass \
  --check-json '{"id":"ac8-check","kind":"test","status":"pass","summary":"AC8 fixture check passed."}' \
  --timestamp "2026-07-05T09:01:00Z" >"$TMPDIR_EVAL/ac8-evidence.out" 2>"$TMPDIR_EVAL/ac8-evidence.err"; then
  _fail "AC8 REGRESSION: record-evidence accepted a kind:\"command\" evidence_ref with prose excerpt instead of rejecting it at record time"
elif grep -qi "not a runnable shell command" "$TMPDIR_EVAL/ac8-evidence.out" "$TMPDIR_EVAL/ac8-evidence.err"; then
  _pass "AC8: record-evidence rejects a kind:\"command\" evidence_ref with a prose excerpt at record time, with an actionable error"
else
  _fail "AC8: record-evidence rejected the prose ref but without the expected 'not a runnable shell command' message: $(cat "$TMPDIR_EVAL/ac8-evidence.out" "$TMPDIR_EVAL/ac8-evidence.err")"
fi

# ─── #270 MEDIUM security fix eval: --skip-evidence-ref-runnability-guard is a logged bypass, ──
# never silent (mirrors --skip-ownership-guard's existing pattern) — reusing AC8_DIR's already-
# mutated prose-in-excerpt fixture (same lockout AC8 above proves is otherwise unconditional).
if flow_agents_node "$WRITER" record-evidence "$AC8_DIR" \
  --verdict pass \
  --check-json '{"id":"ac8-bypass-check","kind":"test","status":"pass","summary":"AC8 bypass fixture check passed."}' \
  --skip-evidence-ref-runnability-guard \
  --timestamp "2026-07-05T09:01:30Z" >"$TMPDIR_EVAL/ac8-bypass.out" 2>"$TMPDIR_EVAL/ac8-bypass.err"; then
  if grep -qi "evidence-ref runnability guard skipped via --skip-evidence-ref-runnability-guard" "$TMPDIR_EVAL/ac8-bypass.out" "$TMPDIR_EVAL/ac8-bypass.err"; then
    _pass "#270: --skip-evidence-ref-runnability-guard bypasses the lockout AND logs it loudly (never silent), mirroring --skip-ownership-guard's pattern"
  else
    _fail "#270: --skip-evidence-ref-runnability-guard bypassed the guard but did NOT log it (silent bypass regression): $(cat "$TMPDIR_EVAL/ac8-bypass.out" "$TMPDIR_EVAL/ac8-bypass.err")"
  fi
else
  _fail "#270: --skip-evidence-ref-runnability-guard should have bypassed the lockout, but record-evidence still failed: $(cat "$TMPDIR_EVAL/ac8-bypass.out" "$TMPDIR_EVAL/ac8-bypass.err")"
fi

# ─── #362 AC7: validateAcceptanceEvidenceRefs' ADVISORY (non-fatal) ambiguous-absence-command ──
# nudge — a kind:"command" evidence ref whose excerpt is a bare (non-negated, non-count-asserted)
# grep/diff invocation gets a stderr advisory suggesting the self-asserting rewrite, but the
# record-evidence call is NOT blocked (this is guidance, not enforcement — distinct from the
# runnability guard immediately above, which stays fatal/unchanged).
AC7_ADV_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/ac7-ambiguous-advisory"
mkdir -p "$AC7_ADV_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$AC7_ADV_DIR/ac7-ambiguous-advisory--deliver.md"
flow_agents_node "$WRITER" init-plan "$AC7_ADV_DIR/ac7-ambiguous-advisory--deliver.md"   --source-request "AC7 ambiguous-absence-command advisory fixture."   --summary "AC7 ambiguous-absence-command advisory fixture."   --next-action "Seed a bare-grep kind:command evidence_ref."   --timestamp "2026-07-05T09:02:00Z" >"$TMPDIR_EVAL/ac7-init.out" 2>"$TMPDIR_EVAL/ac7-init.err"

node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/ac7-mutate.err"
import { readFileSync, writeFileSync } from 'node:fs';
const file = '${AC7_ADV_DIR}/acceptance.json';
const data = JSON.parse(readFileSync(file, 'utf8'));
if (!Array.isArray(data.criteria) || data.criteria.length === 0) { process.stderr.write('no criteria to mutate\n'); process.exit(1); }
data.criteria[0].evidence_refs = [{ kind: 'command', excerpt: "grep -E 'this-pattern-does-not-exist-anywhere' package.json" }];
writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
NODEOF

if flow_agents_node "$WRITER" record-evidence "$AC7_ADV_DIR"   --verdict pass   --check-json '{"id":"ac7-adv-check","kind":"test","status":"pass","summary":"AC7 advisory fixture check passed."}'   --timestamp "2026-07-05T09:02:30Z" >"$TMPDIR_EVAL/ac7-adv.out" 2>"$TMPDIR_EVAL/ac7-adv.err"; then
  _pass "AC7: record-evidence with a bare-grep-shaped kind:\"command\" evidence ref succeeds (advisory is non-fatal, does NOT block the write)"
else
  _fail "AC7 REGRESSION: record-evidence with a bare-grep-shaped evidence ref should succeed (advisory only), but it was rejected: $(cat "$TMPDIR_EVAL/ac7-adv.out" "$TMPDIR_EVAL/ac7-adv.err")"
fi

if grep -qi "advisory" "$TMPDIR_EVAL/ac7-adv.err" && grep -qi "self-asserting\|ambiguous" "$TMPDIR_EVAL/ac7-adv.err"; then
  _pass "AC7: record-evidence emits an advisory stderr note recommending the self-asserting form for a bare-grep evidence ref"
else
  _fail "AC7: expected advisory stderr note (mentioning 'advisory' and 'self-asserting'/'ambiguous') was missing: $(cat "$TMPDIR_EVAL/ac7-adv.err")"
fi

if [[ -f "$AC7_ADV_DIR/acceptance.json" ]] && node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/ac7-adv-assert.err"
import { readFileSync } from 'node:fs';
const data = JSON.parse(readFileSync('${AC7_ADV_DIR}/acceptance.json', 'utf8'));
const ref = data.criteria[0].evidence_refs[0];
if (ref.kind !== 'command') { process.stderr.write('expected the ref to remain kind:"command", got: ' + ref.kind + '\n'); process.exit(1); }
if (ref.excerpt !== "grep -E 'this-pattern-does-not-exist-anywhere' package.json") { process.stderr.write('the advisory must NOT alter the ref excerpt: got ' + JSON.stringify(ref.excerpt) + '\n'); process.exit(1); }
NODEOF
then
  _pass "AC7: the advisory does not alter or reject the existing evidence ref (excerpt unchanged, still kind:\"command\")"
else
  _fail "AC7: evidence-ref-unchanged assertion failed: $(cat "$TMPDIR_EVAL/ac7-adv-assert.err")"
fi

# Regression guard: a self-asserting form (`! grep ...`, the NATURAL negated form -- not a
# count-assertion workaround; isRunnableCommandText now strips a leading `!` before evaluating
# runnability, per the coherence fix, so the runnability guard ACCEPTS this excerpt) never
# triggers the advisory.
AC7_NEG_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/ac7-self-asserting-no-advisory"
mkdir -p "$AC7_NEG_DIR"
cp "$ARTIFACT_DIR/auto-sidecars--deliver.md" "$AC7_NEG_DIR/ac7-self-asserting-no-advisory--deliver.md"
flow_agents_node "$WRITER" init-plan "$AC7_NEG_DIR/ac7-self-asserting-no-advisory--deliver.md" --source-request "AC7 self-asserting-form no-advisory regression fixture." --summary "AC7 self-asserting-form no-advisory regression fixture." --next-action "Seed a negated-grep kind:command evidence_ref." --timestamp "2026-07-05T09:03:00Z" >"$TMPDIR_EVAL/ac7-neg-init.out" 2>"$TMPDIR_EVAL/ac7-neg-init.err"

node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/ac7-neg-mutate.err"
import { readFileSync, writeFileSync } from 'node:fs';
const file = '${AC7_NEG_DIR}/acceptance.json';
const data = JSON.parse(readFileSync(file, 'utf8'));
if (!Array.isArray(data.criteria) || data.criteria.length === 0) { process.stderr.write('no criteria to mutate\n'); process.exit(1); }
data.criteria[0].evidence_refs = [{ kind: 'command', excerpt: "! grep -E 'this-pattern-does-not-exist-anywhere' package.json" }];
writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
NODEOF

if flow_agents_node "$WRITER" record-evidence "$AC7_NEG_DIR" --verdict pass --check-json '{"id":"ac7-neg-check","kind":"test","status":"pass","summary":"AC7 negation regression fixture check passed."}' --timestamp "2026-07-05T09:03:30Z" >"$TMPDIR_EVAL/ac7-neg.out" 2>"$TMPDIR_EVAL/ac7-neg.err"; then
  if grep -qi "not a runnable shell command" "$TMPDIR_EVAL/ac7-neg.out" "$TMPDIR_EVAL/ac7-neg.err"; then
    _fail "REGRESSION: record-evidence rejected a '! grep ...' evidence ref as non-runnable — isRunnableCommandText's leading-'!' strip is not working"
  else
    _pass "record-evidence ACCEPTS a '! grep ...' evidence ref as runnable (leading '!' is stripped before evaluation)"
  fi
  if grep -qi "advisory" "$TMPDIR_EVAL/ac7-neg.err"; then
    _fail "regression: a self-asserting '! grep ...' evidence ref should NOT trigger the ambiguous-absence advisory, but it did: $(cat "$TMPDIR_EVAL/ac7-neg.err")"
  else
    _pass "regression guard: a self-asserting '! grep ...' evidence ref does not trigger the ambiguous-absence advisory"
  fi
else
  _fail "regression fixture: record-evidence with a self-asserting negated-grep evidence ref unexpectedly failed: $(cat "$TMPDIR_EVAL/ac7-neg.out" "$TMPDIR_EVAL/ac7-neg.err")"
fi

# ─── #270 MEDIUM fix eval: parseCriterion routes a PROSE "- Evidence:" line through the REAL ──
# init-plan parse path (definitionAcceptanceLines -> parseCriterion), not a hand-mutated
# acceptance.json — asserting the resulting acceptance.json ref carries the prose in `summary`
# and has NO `excerpt` (never validated for runnability, never executed), per the #412 contract
# ("prose belongs in ref.summary"). This is a DIRECT eval of parseCriterion's classification
# behavior (distinct from AC8 above, which exercises the record-time REJECTION of an
# already-mutated prose-in-excerpt ref).
PARSE_CRITERION_DIR="$TMPDIR_EVAL/repo/.kontourai/flow-agents/parse-criterion-prose"
mkdir -p "$PARSE_CRITERION_DIR"
cat > "$PARSE_CRITERION_DIR/parse-criterion-prose--deliver.md" <<'MARKDOWN'
# parseCriterion prose Evidence line eval

status: delivered
type: deliver

## Plan

Exercise parseCriterion's classification of a prose Evidence line through the real parse path.

## Definition Of Done

- **User outcome:** Prose evidence is classified correctly at parse time.
- **Scope:** parseCriterion / definitionAcceptanceLines.
- **Acceptance criteria:**
  - [ ] Dashboard reviewed - Evidence: manual review of the dashboard.
- **Usefulness checks:**
  - [ ] User-facing workflow is documented or discoverable
- **Stop-short risks:** none
- **Durable docs target:** not needed
- **Sandbox mode:** local-edit

## Verification Report

Build: [NOT_VERIFIED] pending

### Verdict: NOT_VERIFIED

## Goal Fit Gate

- [ ] Original user goal restated

## Final Acceptance

- [ ] CI/relevant checks passed or local equivalent recorded
MARKDOWN

if flow_agents_node "$WRITER" init-plan "$PARSE_CRITERION_DIR/parse-criterion-prose--deliver.md"   --source-request "parseCriterion prose Evidence line eval."   --summary "Exercise the real parse path for a prose Evidence line."   --next-action "Assert the resulting acceptance.json ref."   --timestamp "2026-07-05T09:00:00Z" >"$TMPDIR_EVAL/parse-criterion-init.out" 2>"$TMPDIR_EVAL/parse-criterion-init.err"; then
  _pass "parseCriterion eval: init-plan runs against the prose-Evidence-line fixture"
else
  _fail "parseCriterion eval: init-plan failed: $(cat "$TMPDIR_EVAL/parse-criterion-init.out" "$TMPDIR_EVAL/parse-criterion-init.err")"
fi

if node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/parse-criterion-assert.err"
import { readFileSync } from 'node:fs';
const data = JSON.parse(readFileSync('${PARSE_CRITERION_DIR}/acceptance.json', 'utf8'));
const criterion = Array.isArray(data.criteria) ? data.criteria.find((c) => c.description && c.description.includes('Dashboard reviewed')) : null;
if (!criterion) { process.stderr.write('no matching criterion found in acceptance.json: ' + JSON.stringify(data.criteria) + '\n'); process.exit(1); }
if (!Array.isArray(criterion.evidence_refs) || criterion.evidence_refs.length !== 1) { process.stderr.write('expected exactly one evidence_refs entry, got: ' + JSON.stringify(criterion.evidence_refs) + '\n'); process.exit(1); }
const ref = criterion.evidence_refs[0];
if (ref.kind !== 'command') { process.stderr.write('expected kind:"command" (still a structured ref; only WHICH field carries the text differs), got: ' + ref.kind + '\n'); process.exit(1); }
if (typeof ref.summary !== 'string' || !ref.summary.includes('manual review of the dashboard')) { process.stderr.write('prose text did not land in ref.summary: ' + JSON.stringify(ref) + '\n'); process.exit(1); }
if (ref.excerpt !== undefined && ref.excerpt !== '') { process.stderr.write('ref.excerpt should be absent/empty for prose evidence (prose never belongs in excerpt), got: ' + JSON.stringify(ref.excerpt) + '\n'); process.exit(1); }
NODEOF
then
  _pass "#270: parseCriterion (via the real init-plan parse path) routes a prose \"- Evidence:\" line into ref.summary with no excerpt, not a hand-mutated acceptance.json"
else
  _fail "#270: parseCriterion prose-routing assertion failed: $(cat "$TMPDIR_EVAL/parse-criterion-assert.err")"
fi

# ─── AC10: record-gate-claim --command with PROSE is rejected at record time ─────────────────
if flow_agents_node "$WRITER" record-gate-claim "$COMPOSE_DIR" \
  --actor compose-actor \
  --status pass \
  --summary "Manual review" \
  --expectation merge-readiness \
  --command "Manually verified the output looks correct." \
  --timestamp "2026-07-05T09:11:00Z" >"$TMPDIR_EVAL/compose-gate-prose.out" 2>"$TMPDIR_EVAL/compose-gate-prose.err"; then
  _fail "AC10 REGRESSION: record-gate-claim --command accepted prose instead of rejecting it at record time"
elif grep -qi "not a runnable shell command" "$TMPDIR_EVAL/compose-gate-prose.out" "$TMPDIR_EVAL/compose-gate-prose.err"; then
  _pass "AC10: record-gate-claim --command rejects a prose value at record time, with an actionable error"
else
  _fail "AC10: record-gate-claim --command prose rejection message was unexpected: $(cat "$TMPDIR_EVAL/compose-gate-prose.out" "$TMPDIR_EVAL/compose-gate-prose.err")"
fi

# ─── #270 CRITICAL/HIGH fix evals: forged-stamp negative + pre-cluster missing-stamp negative ──
# Both mutate a FRESH COPY of the compose session's trust.bundle (never COMPOSE_DIR itself) so
# these negative fixtures stay isolated from the compose-layer assertions above.

# ─── Forged-stamp negative: hand-edit metadata.gate_claim.expectation_id to a nonexistent ─────
# expects[] id. Any rebuild (record-critique) must die naming the stamp AND the claim id — never
# silently fall through to matchExpectsEntry (the exact #270 CRITICAL/HIGH defect this closes).
# Copy the WHOLE compose root (not just COMPOSE_DIR) — current.json / current/<actor>.json live
# in the PARENT of the session dir, and resolveActiveFlowStep (hence sessionFlowId/flowRepoRoot in
# buildTrustBundle) needs them to resolve the flow definition for stamp validation. Copying only
# the session dir would silently make sessionFlowId resolve to null, which changes what's being
# tested (the "no flow definition resolvable" edge case) rather than the forged-stamp case.
FORGED_ROOT="$TMPDIR_EVAL/forged-stamp-root"
cp -r "$COMPOSE_ROOT" "$FORGED_ROOT"
FORGED_DIR="$FORGED_ROOT/$COMPOSE_SLUG"

node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/forged-mutate.err"
import { readFileSync, writeFileSync } from 'node:fs';
const file = '${FORGED_DIR}/trust.bundle';
const bundle = JSON.parse(readFileSync(file, 'utf8'));
const claim = bundle.claims.find((c) => c.metadata && c.metadata.gate_claim && c.metadata.gate_claim.expectation_id === 'selected-work');
if (!claim) { process.stderr.write('setup: selected-work gate claim not found to forge\n'); process.exit(1); }
claim.metadata.gate_claim.expectation_id = 'nonexistent-expectation-id';
writeFileSync(file, JSON.stringify(bundle, null, 2) + '\n');
NODEOF

if [[ -s "$TMPDIR_EVAL/forged-mutate.err" ]]; then
  _fail "eval setup: forging metadata.gate_claim.expectation_id failed: $(cat "$TMPDIR_EVAL/forged-mutate.err")"
fi

if flow_agents_node "$WRITER" record-critique "$FORGED_DIR" \
  --id forged-stamp-review \
  --reviewer forged-stamp-tester \
  --verdict pass \
  --summary "Rebuild attempt against a forged gate_claim stamp" \
  --timestamp "2026-07-05T09:12:00Z" >"$TMPDIR_EVAL/forged-critique.out" 2>"$TMPDIR_EVAL/forged-critique.err"; then
  _fail "FORGED-STAMP REGRESSION: record-critique succeeded against a bundle with a forged metadata.gate_claim.expectation_id (silent re-typing fall-through, the #270 CRITICAL/HIGH defect)"
elif grep -qi "forged or corrupt" "$TMPDIR_EVAL/forged-critique.out" "$TMPDIR_EVAL/forged-critique.err" \
  && grep -q "nonexistent-expectation-id" "$TMPDIR_EVAL/forged-critique.out" "$TMPDIR_EVAL/forged-critique.err"; then
  _pass "#270 CRITICAL/HIGH: a forged metadata.gate_claim stamp (nonexistent expectation_id) makes any rebuild die loudly, naming the stamp — never silently re-typed"
else
  _fail "#270 forged-stamp rejection message was unexpected: $(cat "$TMPDIR_EVAL/forged-critique.out" "$TMPDIR_EVAL/forged-critique.err")"
fi

# ─── Pre-cluster missing-stamp negative: strip metadata.gate_claim from a gate-claim-SHAPED ────
# claim (origin:"check", check_kind:"external", kit-typed claimType) — mimicking the real
# kontourai-flow-agents-303 bundle shape (a claim recorded before the gate_claim stamp existed).
# Any rebuild must die with the re-record remedy, never silently re-type via matchExpectsEntry.
PRECLUSTER_ROOT="$TMPDIR_EVAL/precluster-missing-stamp-root"
cp -r "$COMPOSE_ROOT" "$PRECLUSTER_ROOT"
PRECLUSTER_DIR="$PRECLUSTER_ROOT/$COMPOSE_SLUG"

node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/precluster-mutate.err"
import { readFileSync, writeFileSync } from 'node:fs';
const file = '${PRECLUSTER_DIR}/trust.bundle';
const bundle = JSON.parse(readFileSync(file, 'utf8'));
const claim = bundle.claims.find((c) => c.metadata && c.metadata.gate_claim && c.metadata.gate_claim.expectation_id === 'implementation-plan');
if (!claim) { process.stderr.write('setup: implementation-plan gate claim not found to strip\n'); process.exit(1); }
delete claim.metadata.gate_claim;
writeFileSync(file, JSON.stringify(bundle, null, 2) + '\n');
NODEOF

if [[ -s "$TMPDIR_EVAL/precluster-mutate.err" ]]; then
  _fail "eval setup: stripping metadata.gate_claim failed: $(cat "$TMPDIR_EVAL/precluster-mutate.err")"
fi

if flow_agents_node "$WRITER" record-critique "$PRECLUSTER_DIR" \
  --id precluster-review \
  --reviewer precluster-tester \
  --verdict pass \
  --summary "Rebuild attempt against a pre-cluster-270 unstamped gate claim" \
  --timestamp "2026-07-05T09:13:00Z" >"$TMPDIR_EVAL/precluster-critique.out" 2>"$TMPDIR_EVAL/precluster-critique.err"; then
  _fail "PRE-CLUSTER-270 REGRESSION: record-critique succeeded against a bundle with an unstamped gate-claim-shaped claim (silent re-typing fall-through)"
elif grep -qi "pre-cluster-270 gate claim" "$TMPDIR_EVAL/precluster-critique.out" "$TMPDIR_EVAL/precluster-critique.err" \
  && grep -qi "re-record it (record-gate-claim) to regenerate" "$TMPDIR_EVAL/precluster-critique.out" "$TMPDIR_EVAL/precluster-critique.err"; then
  _pass "#270 pre-cluster-270 missing-stamp: an unstamped gate-claim-shaped claim makes any rebuild die with the re-record remedy — never silently re-typed"
else
  _fail "#270 pre-cluster missing-stamp rejection message was unexpected: $(cat "$TMPDIR_EVAL/precluster-critique.out" "$TMPDIR_EVAL/precluster-critique.err")"
fi

# ─── #270 HIGH fix (iteration 3): reserve the "gate-claim-" check-id namespace ─────────────────
# (a) reserved-prefix rejection via record-evidence --check-json (exit + message)
if flow_agents_node "$WRITER" record-evidence "$COMPOSE_DIR" \
  --verdict pass \
  --check-json '{"id":"gate-claim-caller-supplied","kind":"external","status":"pass","summary":"A caller-chosen id that collides with the reserved gate-claim- prefix"}' \
  --timestamp "2026-07-05T09:15:30Z" >"$TMPDIR_EVAL/reserved-prefix.out" 2>"$TMPDIR_EVAL/reserved-prefix.err"; then
  _fail "#270 HIGH REGRESSION: record-evidence --check-json accepted a caller-supplied id starting with the reserved 'gate-claim-' prefix"
elif grep -qi 'reserved for record-gate-claim' "$TMPDIR_EVAL/reserved-prefix.out" "$TMPDIR_EVAL/reserved-prefix.err" \
  && grep -q 'gate-claim-caller-supplied' "$TMPDIR_EVAL/reserved-prefix.out" "$TMPDIR_EVAL/reserved-prefix.err"; then
  _pass "#270 HIGH: record-evidence --check-json rejects a caller-supplied id starting with the reserved 'gate-claim-' prefix, naming the offending id"
else
  _fail "#270 HIGH: reserved-prefix rejection message was unexpected: $(cat "$TMPDIR_EVAL/reserved-prefix.out" "$TMPDIR_EVAL/reserved-prefix.err")"
fi

# Confirm record-check's --id is covered by the same guard (a second writer of caller-supplied ids).
if flow_agents_node "$WRITER" record-check "$COMPOSE_DIR" --id "gate-claim-record-check-collision" -- true \
  >"$TMPDIR_EVAL/reserved-prefix-record-check.out" 2>"$TMPDIR_EVAL/reserved-prefix-record-check.err"; then
  _fail "#270 HIGH REGRESSION: record-check accepted a caller-supplied --id starting with the reserved 'gate-claim-' prefix"
elif grep -qi 'reserved for record-gate-claim' "$TMPDIR_EVAL/reserved-prefix-record-check.out" "$TMPDIR_EVAL/reserved-prefix-record-check.err"; then
  _pass "#270 HIGH: record-check --id is covered by the same reserved-prefix guard as record-evidence"
else
  _fail "#270 HIGH: record-check reserved-prefix rejection message was unexpected: $(cat "$TMPDIR_EVAL/reserved-prefix-record-check.out" "$TMPDIR_EVAL/reserved-prefix-record-check.err")"
fi

# Confirm record-gate-claim's OWN internally-constructed gate-claim-<id> is still accepted — the
# guard must reject only CALLER-supplied ids on other writers, never record-gate-claim's own path.
# (compose-gate1's earlier record-gate-claim call above already exercises and asserts this; this
# is a targeted re-assertion scoped to the reserved-prefix fix itself.)
if node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/reserved-prefix-gate-claim-own.err"
import { readFileSync } from 'node:fs';
const bundle = JSON.parse(readFileSync('${COMPOSE_DIR}/trust.bundle', 'utf8'));
const gateClaim = bundle.claims.find((c) => c.subjectId && c.subjectId.endsWith('/gate-claim-selected-work'));
if (!gateClaim) { process.stderr.write('record-gate-claims own gate-claim-selected-work id was not found — its own reserved-prefix construction must still succeed\n'); process.exit(1); }
if (!gateClaim.metadata || !gateClaim.metadata.gate_claim) { process.stderr.write('record-gate-claims own claim is missing its metadata.gate_claim stamp\n'); process.exit(1); }
NODEOF
then
  _pass "#270 HIGH: record-gate-claim's own internally-constructed 'gate-claim-<id>' still succeeds (the guard applies only to caller-supplied ids on OTHER writers)"
else
  _fail "#270 HIGH: record-gate-claim's own id-construction regressed: $(cat "$TMPDIR_EVAL/reserved-prefix-gate-claim-own.err")"
fi

# (b) collision regression scenario end-to-end: the EXACT pre-cluster-false-positive collision —
# a caller-chosen record-evidence check id starting with "gate-claim-" that would, absent this
# fix, get declared-typed via matchExpectsEntry's P-d fallback (kit-typed, unstamped) and then be
# misclassified as an unstamped pre-cluster-270 gate claim on the NEXT rebuild — is now rejected
# AT RECORD TIME instead, in a FRESH session (isolated from COMPOSE_DIR) so no rebuild landmine
# is ever created.
COLLISION_ROOT="$TMPDIR_EVAL/collision-root"
COLLISION_SLUG="collision-270"
COLLISION_DIR="$COLLISION_ROOT/$COLLISION_SLUG"
mkdir -p "$COLLISION_ROOT"

flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$COLLISION_ROOT" \
  --task-slug "$COLLISION_SLUG" \
  --actor collision-actor \
  --flow-id builder.build \
  --title "Collision regression session" \
  --source-request "Regression: gate-claim- id collision must die at record time, not rebuild time." \
  --summary "Seed session for the collision regression eval." \
  --criterion "Collision regression is caught at record time" \
  --timestamp "2026-07-05T09:16:00Z" >"$TMPDIR_EVAL/collision-seed.out" 2>"$TMPDIR_EVAL/collision-seed.err"

if flow_agents_node "$WRITER" record-evidence "$COLLISION_DIR" \
  --verdict pass \
  --check-json '{"id":"gate-claim-my-custom-check","kind":"external","status":"pass","summary":"A caller-chosen check id colliding with the reserved prefix, at the active pull-work step (kit-typed via matchExpectsEntry fallback)"}' \
  --timestamp "2026-07-05T09:16:15Z" >"$TMPDIR_EVAL/collision-record.out" 2>"$TMPDIR_EVAL/collision-record.err"; then
  _fail "#270 HIGH REGRESSION: the collision scenario's record-evidence call succeeded — this recreates the pre-cluster false-positive rebuild landmine"
elif grep -qi 'reserved for record-gate-claim' "$TMPDIR_EVAL/collision-record.out" "$TMPDIR_EVAL/collision-record.err" \
  && [[ ! -f "$COLLISION_DIR/trust.bundle" || ! $(node --input-type=module -e "
import { readFileSync } from 'node:fs';
const b = JSON.parse(readFileSync('${COLLISION_DIR}/trust.bundle', 'utf8'));
process.stdout.write(String(b.claims.some((c) => c.subjectId && c.subjectId.endsWith('/gate-claim-my-custom-check'))));
" 2>/dev/null) == "true" ]]; then
  _pass "#270 HIGH: the collision scenario is rejected AT RECORD TIME (record-evidence), never lands in trust.bundle, and no rebuild landmine is created"
else
  _fail "#270 HIGH: collision regression assertion failed: $(cat "$TMPDIR_EVAL/collision-record.out" "$TMPDIR_EVAL/collision-record.err")"
fi

# Now prove a REBUILD against the (empty/unaffected) collision session succeeds cleanly — there is
# no landmine left behind by the rejected record-evidence call above.
if flow_agents_node "$WRITER" record-critique "$COLLISION_DIR" \
  --id collision-rebuild-review \
  --reviewer collision-tester \
  --verdict pass \
  --summary "Rebuild after the rejected collision write — must succeed, no landmine" \
  --timestamp "2026-07-05T09:16:30Z" >"$TMPDIR_EVAL/collision-rebuild.out" 2>"$TMPDIR_EVAL/collision-rebuild.err"; then
  _pass "#270 HIGH: a rebuild (record-critique) after the rejected collision write succeeds cleanly — no rebuild-time landmine"
else
  _fail "#270 HIGH REGRESSION: rebuild after the rejected collision write unexpectedly failed: $(cat "$TMPDIR_EVAL/collision-rebuild.out" "$TMPDIR_EVAL/collision-rebuild.err")"
fi

# ─── #270 MEDIUM fix (iteration 3): unresolvable FlowDefinition dies with the dedicated ────────
# "cannot be loaded" message, never "forged or corrupt". Create a REAL stamped gate claim first
# (real flow, real record-gate-claim), then break resolution by pointing active_flow_id at a
# bogus flow id that cannot resolve under kits/ (mirrors the re-reviewer's approach of pointing
# at an unresolvable kits/ path), in an ISOLATED fixture copied from a fresh session.
UNRESOLVABLE_ROOT="$TMPDIR_EVAL/unresolvable-root"
UNRESOLVABLE_SLUG="unresolvable-270"
UNRESOLVABLE_DIR="$UNRESOLVABLE_ROOT/$UNRESOLVABLE_SLUG"
mkdir -p "$UNRESOLVABLE_ROOT"

flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$UNRESOLVABLE_ROOT" \
  --task-slug "$UNRESOLVABLE_SLUG" \
  --actor unresolvable-actor \
  --flow-id builder.build \
  --title "Unresolvable FlowDefinition regression" \
  --source-request "Regression: an unresolvable FlowDefinition must die with the dedicated cannot-be-loaded message." \
  --summary "Seed session with a REAL flow so a real stamped gate claim can be recorded." \
  --criterion "Unresolvable FlowDefinition dies with the dedicated message" \
  --timestamp "2026-07-05T09:17:00Z" >"$TMPDIR_EVAL/unresolvable-seed.out" 2>"$TMPDIR_EVAL/unresolvable-seed.err"

if flow_agents_node "$WRITER" record-gate-claim "$UNRESOLVABLE_DIR" \
  --actor unresolvable-actor \
  --status pass \
  --summary "Work item selected for unresolvable-flow-definition regression" \
  --timestamp "2026-07-05T09:17:15Z" >"$TMPDIR_EVAL/unresolvable-gate-claim.out" 2>"$TMPDIR_EVAL/unresolvable-gate-claim.err"; then
  _pass "#270 MEDIUM setup: real stamped gate claim recorded before breaking FlowDefinition resolution"
else
  _fail "#270 MEDIUM setup: record-gate-claim (real flow) failed: $(cat "$TMPDIR_EVAL/unresolvable-gate-claim.out" "$TMPDIR_EVAL/unresolvable-gate-claim.err")"
fi

# Break resolution: point BOTH the legacy and per-actor current-pointer files at a flow id with
# no corresponding kits/<kit>/flows/<name>.flow.json file.
node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/unresolvable-mutate.err"
import { readFileSync, writeFileSync } from 'node:fs';
for (const f of ['${UNRESOLVABLE_ROOT}/current.json', '${UNRESOLVABLE_ROOT}/current/unresolvable-actor.json']) {
  const d = JSON.parse(readFileSync(f, 'utf8'));
  d.active_flow_id = 'builder.bogus-nonexistent-flow-270';
  writeFileSync(f, JSON.stringify(d, null, 2) + '\n');
}
NODEOF

if [[ -s "$TMPDIR_EVAL/unresolvable-mutate.err" ]]; then
  _fail "eval setup: pointing active_flow_id at a bogus flow id failed: $(cat "$TMPDIR_EVAL/unresolvable-mutate.err")"
fi

if flow_agents_node "$WRITER" record-critique "$UNRESOLVABLE_DIR" \
  --id unresolvable-review \
  --reviewer unresolvable-tester \
  --verdict pass \
  --summary "Rebuild attempt against an unresolvable FlowDefinition" \
  --timestamp "2026-07-05T09:17:30Z" >"$TMPDIR_EVAL/unresolvable-critique.out" 2>"$TMPDIR_EVAL/unresolvable-critique.err"; then
  _fail "#270 MEDIUM REGRESSION: record-critique succeeded against a stamped gate claim whose FlowDefinition cannot be loaded"
elif grep -qi "cannot be loaded" "$TMPDIR_EVAL/unresolvable-critique.out" "$TMPDIR_EVAL/unresolvable-critique.err" \
  && grep -qi "cannot validate the gate-claim stamp" "$TMPDIR_EVAL/unresolvable-critique.out" "$TMPDIR_EVAL/unresolvable-critique.err" \
  && ! grep -qi "forged or corrupt" "$TMPDIR_EVAL/unresolvable-critique.out" "$TMPDIR_EVAL/unresolvable-critique.err"; then
  _pass "#270 MEDIUM: an unresolvable FlowDefinition dies with the dedicated 'cannot be loaded' message, naming the flow id — NEVER the 'forged or corrupt' message"
else
  _fail "#270 MEDIUM: unresolvable-FlowDefinition rejection message was unexpected: $(cat "$TMPDIR_EVAL/unresolvable-critique.out" "$TMPDIR_EVAL/unresolvable-critique.err")"
fi

# ─── Mutation test (#270 HIGH reserved-prefix guard): temporarily disable normalizeCheck's ──────
# reserved-"gate-claim-"-prefix rejection in a SCRATCH COPY of the compiled build/ output,
# confirm the reserved-prefix fixture above now SUCCEEDS against that mutated binary (eval "goes
# red" without the guard), then restore the original compiled file immediately. Proves the eval
# is actually exercising this specific guard, not passing vacuously for an unrelated reason.
DIST_SIDECAR="$ROOT/build/src/cli/workflow-sidecar.js"
RESERVED_PREFIX_SCRATCH="$TMPDIR_EVAL/reserved-prefix-mutation-scratch"
mkdir -p "$RESERVED_PREFIX_SCRATCH"

if [[ -f "$DIST_SIDECAR" ]]; then
  cp "$DIST_SIDECAR" "$RESERVED_PREFIX_SCRATCH/workflow-sidecar.orig.js"
  node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/reserved-prefix-mutation-patch.err"
import { readFileSync, writeFileSync } from 'node:fs';
const file = '${RESERVED_PREFIX_SCRATCH}/workflow-sidecar.orig.js';
let src = readFileSync(file, 'utf8');
const needle = 'if (!allowGateClaimPrefix && typeof check.id === "string" && check.id.startsWith("gate-claim-")) {';
if (!src.includes(needle)) { process.stderr.write('mutation: reserved-prefix guard text not found — source pattern drifted, cannot mutation-test\n'); process.exit(1); }
src = src.split(needle).join('if (false) {');
writeFileSync('${RESERVED_PREFIX_SCRATCH}/workflow-sidecar.mutated.js', src);
NODEOF

  if [[ -s "$TMPDIR_EVAL/reserved-prefix-mutation-patch.err" ]]; then
    _fail "mutation-test setup failed (reserved-prefix guard source pattern did not match compiled output): $(cat "$TMPDIR_EVAL/reserved-prefix-mutation-patch.err")"
  else
    if node --check "$RESERVED_PREFIX_SCRATCH/workflow-sidecar.mutated.js" 2>"$TMPDIR_EVAL/reserved-prefix-mutation-syntax.err"; then
      cp "$RESERVED_PREFIX_SCRATCH/workflow-sidecar.mutated.js" "$DIST_SIDECAR"

      if flow_agents_node "$WRITER" record-evidence "$COMPOSE_DIR" \
        --verdict pass \
        --check-json '{"id":"gate-claim-mutation-test","kind":"external","status":"pass","summary":"Mutation-test: reserved-prefix guard disabled, must go red"}' \
        --timestamp "2026-07-05T09:17:45Z" >"$TMPDIR_EVAL/reserved-prefix-mutation.out" 2>"$TMPDIR_EVAL/reserved-prefix-mutation.err"; then
        _pass "mutation-test: with the reserved-prefix guard neutered, a caller-supplied 'gate-claim-' id now SUCCEEDS (eval correctly goes red without the guard, proving the eval exercises it)"
      else
        _fail "mutation-test: reserved-prefix fixture still rejected even with the guard neutered — the eval may not be exercising the intended guard: $(cat "$TMPDIR_EVAL/reserved-prefix-mutation.out" "$TMPDIR_EVAL/reserved-prefix-mutation.err")"
      fi
    else
      _fail "mutation-test setup: mutated workflow-sidecar.js (reserved-prefix guard) failed a syntax check, refusing to run it: $(cat "$TMPDIR_EVAL/reserved-prefix-mutation-syntax.err")"
    fi

    # Restore the real compiled guard immediately — never leave the mutated binary in place — and
    # re-run the reserved-prefix negative to confirm the restored binary rejects it again.
    cp "$RESERVED_PREFIX_SCRATCH/workflow-sidecar.orig.js" "$DIST_SIDECAR"
    if flow_agents_node "$WRITER" record-evidence "$COMPOSE_DIR" \
      --verdict pass \
      --check-json '{"id":"gate-claim-restore-check","kind":"external","status":"pass","summary":"Restore check: reserved-prefix guard must be back after mutation-test cleanup"}' \
      --timestamp "2026-07-05T09:18:00Z" >"$TMPDIR_EVAL/reserved-prefix-restore.out" 2>"$TMPDIR_EVAL/reserved-prefix-restore.err"; then
      _fail "mutation-test cleanup REGRESSION: the reserved-prefix guard did not come back after restoring the original compiled file"
    else
      _pass "mutation-test cleanup: the real compiled reserved-prefix guard is restored and rejects a caller-supplied 'gate-claim-' id again"
    fi
  fi
else
  _fail "mutation-test setup: could not locate the compiled build/src/cli/workflow-sidecar.js to mutate for the reserved-prefix guard (ran 'npm run build' first?)"
fi


# ─── #270 follow-up fix (publish-preflight, iteration 5): reserved-prefix rejection applies ────
# ONLY to NEW mints — a caller-supplied id that ALREADY EXISTS as a check claim id in the
# session's CURRENT trust.bundle is a CORRECTION (supersession), not a new mint, and must be
# allowed even when it starts with the reserved "gate-claim-" prefix. Without this exemption a
# mis-recorded gate-claim-* check (e.g. one mistakenly recorded kind:"test" with no manifest
# label, exactly the real kontourai-flow-agents-270 wedge this closes) can NEVER be corrected:
# every attempt to re-record that exact id — the only way to supersede/fix it — is itself
# rejected by the guard, permanently wedging that id and blocking publish-preflight forever.
CORRECTION_ROOT="$TMPDIR_EVAL/correction-root"
CORRECTION_SLUG="correction-270"
CORRECTION_DIR="$CORRECTION_ROOT/$CORRECTION_SLUG"
mkdir -p "$CORRECTION_ROOT"

# A dedicated, FRESH session (never copied from COMPOSE_ROOT/COMPOSE_DIR) — COMPOSE_DIR's bundle
# already carries the reserved-prefix mutation-test's own transient (deliberately unstamped,
# guard-neutered) 'gate-claim-mutation-test' claim by this point in the script; copying it here
# would poison this fixture with an unrelated pre-cluster-270 unstamped-claim landmine that has
# nothing to do with the correction-path behavior under test.
flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$CORRECTION_ROOT" \
  --task-slug "$CORRECTION_SLUG" \
  --actor correction-actor \
  --flow-id builder.build \
  --title "Correction-path session" \
  --source-request "Regression: a mis-recorded gate-claim-* id (kind test, no manifest label) must be correctable via supersession, not permanently wedged." \
  --summary "Seed session for the reserved-prefix existing-id correction eval." \
  --criterion "Mis-recorded gate-claim-* ids are correctable via same-id supersession" \
  --timestamp "2026-07-05T09:10:45Z" >"$TMPDIR_EVAL/correction-seed.out" 2>"$TMPDIR_EVAL/correction-seed.err"

# A real record-gate-claim call creates the FIRST trust.bundle write (ensure-session alone does
# not write trust.bundle yet) — a real, properly-stamped gate claim at pull-work-gate/selected-work,
# exactly the compose-layer pattern above, so this session has a normal, valid bundle to seed the
# mis-recorded claim alongside (never the sole content of the bundle).
flow_agents_node "$WRITER" record-gate-claim "$CORRECTION_DIR" \
  --actor correction-actor \
  --status pass \
  --summary "Work item selected for correction-path session" \
  --timestamp "2026-07-05T09:10:50Z" >"$TMPDIR_EVAL/correction-gate-seed.out" 2>"$TMPDIR_EVAL/correction-gate-seed.err"

if [[ ! -f "$CORRECTION_DIR/trust.bundle" ]]; then
  _fail "eval setup: record-gate-claim did not create trust.bundle for the correction-path session: $(cat "$TMPDIR_EVAL/correction-gate-seed.out" "$TMPDIR_EVAL/correction-gate-seed.err")"
fi

# Seed the EXACT real wedge shape by hand-editing a copy of trust.bundle (the current, already-
# fixed binary can no longer MINT a fresh gate-claim-* id via record-evidence/record-check, so a
# hand-constructed claim is how a pre-fix mis-recording is replicated here — same idiom the
# forged-stamp/pre-cluster-missing-stamp negatives above already use for defect-class shapes the
# CLI itself must never be able to produce). Mirrors the real wedged claim byte-for-byte in
# shape: origin:"check", check_kind:"test" (WS8's classifyEvidence always maps kind:"test" to
# evidenceType:"test_output" regardless of a command), no execution.label on its evidence entry
# (no manifest-matchable command — the "without manifest labels" defect) — exactly what makes
# reconcile-preflight's sessionLocalShapeIssues/noEvidenceCommandIssues path a divergence
# ('test_output-unreconciled') and blocks publish.
CORRECTION_CHECK_ID="gate-claim-accumulates"
node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/correction-seed-mutate.err"
import { readFileSync, writeFileSync } from 'node:fs';
const file = '${CORRECTION_DIR}/trust.bundle';
const bundle = JSON.parse(readFileSync(file, 'utf8'));
const ts = '2026-07-05T09:11:00Z';
const claimId = 'correction-270-${CORRECTION_CHECK_ID}';
bundle.claims.push({
  id: claimId,
  subjectType: 'change',
  subjectId: '${CORRECTION_SLUG}/${CORRECTION_CHECK_ID}',
  facet: 'flow-agents.workflow',
  claimType: 'builder.execute.scope',
  fieldOrBehavior: 'Mis-recorded (pre-fix) gate claim: kind test, no manifest label — the exact real wedge shape.',
  value: 'pass',
  createdAt: ts,
  updatedAt: ts,
  impactLevel: 'high',
  verificationPolicyId: 'policy:builder.execute.scope:test_output',
  metadata: { origin: 'check', check_kind: 'test' },
  status: 'verified',
});
bundle.evidence.push({
  id: 'ev:' + claimId,
  claimId,
  evidenceType: 'test_output',
  method: 'validation',
  sourceRef: '${CORRECTION_SLUG}/evidence.json',
  excerptOrSummary: 'Mis-recorded (pre-fix) gate claim: kind test, no manifest label.',
  observedAt: ts,
  collectedBy: 'flow-agents/workflow-sidecar',
  passing: true,
});
writeFileSync(file, JSON.stringify(bundle, null, 2) + '\n');
NODEOF

if [[ -s "$TMPDIR_EVAL/correction-seed-mutate.err" ]]; then
  _fail "eval setup: seeding the mis-recorded gate-claim-* (kind:test, no manifest label) wedge claim failed: $(cat "$TMPDIR_EVAL/correction-seed-mutate.err")"
fi

# Sanity: reconcile-preflight FAILS against the wedged bundle (the real defect this closes) —
# an unreconciled test_output claim with no manifest-matchable command is a divergence.
if flow_agents_node "$WRITER" reconcile-preflight "$CORRECTION_DIR" --repo-root "$ROOT" \
  >"$TMPDIR_EVAL/correction-preflight-before.out" 2>"$TMPDIR_EVAL/correction-preflight-before.err"; then
  _fail "eval setup REGRESSION: reconcile-preflight unexpectedly PASSED against the seeded wedge claim (kind:test, no manifest label) — the wedge fixture is not actually reproducing the real defect"
else
  _pass "eval setup: reconcile-preflight FAILS against the seeded wedge claim (mis-recorded kind:test, no manifest label) — reproduces the real publish-preflight defect before the correction"
fi

# ─── Eval 1 (correction path): record-evidence --check-json with the SAME id, kind "policy" ────
# (no command) — must SUCCEED and supersede the mis-recorded claim, even though the id starts
# with the reserved "gate-claim-" prefix, because that id ALREADY EXISTS in the bundle.
if flow_agents_node "$WRITER" record-evidence "$CORRECTION_DIR" \
  --verdict pass \
  --check-json "{\"id\":\"${CORRECTION_CHECK_ID}\",\"kind\":\"policy\",\"status\":\"pass\",\"summary\":\"Correction: re-recorded as a policy claim, superseding the mis-recorded kind:test entry.\"}" \
  --timestamp "2026-07-05T09:11:15Z" >"$TMPDIR_EVAL/correction-record.out" 2>"$TMPDIR_EVAL/correction-record.err"; then
  _pass "correction path: record-evidence supersedes an EXISTING gate-claim-* id (kind test -> policy) instead of rejecting it as a new mint"
else
  _fail "correction path REGRESSION: record-evidence rejected supersession of an EXISTING gate-claim-* id: $(cat "$TMPDIR_EVAL/correction-record.out" "$TMPDIR_EVAL/correction-record.err")"
fi

if node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/correction-assert.err"
import { readFileSync } from 'node:fs';
const bundle = JSON.parse(readFileSync('${CORRECTION_DIR}/trust.bundle', 'utf8'));
const claims = bundle.claims.filter((c) => c.subjectId && c.subjectId.endsWith('/${CORRECTION_CHECK_ID}'));
if (claims.length !== 1) { process.stderr.write('expected exactly ONE claim for ${CORRECTION_CHECK_ID} after supersession (same-id resupply must replace, not duplicate), found ' + claims.length + '\n'); process.exit(1); }
const claim = claims[0];
if (!claim.metadata || claim.metadata.check_kind !== 'policy') { process.stderr.write('claim.metadata.check_kind is not policy after the correction: ' + JSON.stringify(claim.metadata) + '\n'); process.exit(1); }
NODEOF
then
  _pass "correction path: the bundle's claim for gate-claim-accumulates now has check_kind:policy (superseded, not duplicated)"
else
  _fail "correction path assertion failed: $(cat "$TMPDIR_EVAL/correction-assert.err")"
fi

# Assert reconcile-preflight now PASSES (or at least no longer reports the corrected claim as a
# divergence) — the correction is what publish-preflight needed to unwedge.
if flow_agents_node "$WRITER" reconcile-preflight "$CORRECTION_DIR" --repo-root "$ROOT" \
  >"$TMPDIR_EVAL/correction-preflight-after.out" 2>"$TMPDIR_EVAL/correction-preflight-after.err"; then
  _pass "correction path: reconcile-preflight now PASSES after the correction (policy claim is session-local, not an unreconciled test_output divergence)"
else
  _fail "correction path: reconcile-preflight still fails after the correction: $(cat "$TMPDIR_EVAL/correction-preflight-after.out" "$TMPDIR_EVAL/correction-preflight-after.err")"
fi

# ─── Eval 2 (new-mint rejection still enforced): a NOVEL gate-claim-* id (never seen in this ───
# session's bundle) is still rejected exactly as before — the exemption above must be scoped
# strictly to ids that already exist, never a blanket bypass.
if flow_agents_node "$WRITER" record-evidence "$CORRECTION_DIR" \
  --verdict pass \
  --check-json '{"id":"gate-claim-novel-never-seen-before","kind":"policy","status":"pass","summary":"A brand-new gate-claim- id that has never existed in this bundle before."}' \
  --timestamp "2026-07-05T09:11:30Z" >"$TMPDIR_EVAL/correction-novel.out" 2>"$TMPDIR_EVAL/correction-novel.err"; then
  _fail "new-mint REGRESSION: record-evidence accepted a NOVEL gate-claim-* id that never existed in the bundle — the existing-id exemption must not apply to brand-new mints"
elif grep -qi 'reserved for record-gate-claim' "$TMPDIR_EVAL/correction-novel.out" "$TMPDIR_EVAL/correction-novel.err" \
  && grep -q 'gate-claim-novel-never-seen-before' "$TMPDIR_EVAL/correction-novel.out" "$TMPDIR_EVAL/correction-novel.err"; then
  _pass "new-mint rejection: a NOVEL gate-claim-* id (not already present) is still rejected with the reserved-prefix message"
else
  _fail "new-mint rejection message was unexpected: $(cat "$TMPDIR_EVAL/correction-novel.out" "$TMPDIR_EVAL/correction-novel.err")"
fi

# ─── Eval 3 (#270 CRITICAL, iteration 6 — the reviewer's exact repro): superseding a REAL, ─────
# STAMPED gate claim via record-evidence --check-json must DIE, and the stamp must survive
# UNTOUCHED. The iteration-5 exemption treated "id already exists in the bundle" as sufficient
# for supersession, which also exempted overwriting a live, properly-stamped record-gate-claim
# output — silently destroying its metadata.gate_claim stamp, and the caller fully controls
# check_kind so the replacement claim can be shaped to evade gateClaimShapeUnstampedId's detector
# (which requires check_kind==="external"). This eval reproduces that exact attack end-to-end
# against the CURRENT (narrowed) binary and asserts it now dies, with the stamp intact afterward.
STAMPED_ROOT="$TMPDIR_EVAL/stamped-claim-root"
STAMPED_SLUG="stamped-claim-270"
STAMPED_DIR="$STAMPED_ROOT/$STAMPED_SLUG"
mkdir -p "$STAMPED_ROOT"

flow_agents_node "$WRITER" ensure-session   --artifact-root "$STAMPED_ROOT"   --task-slug "$STAMPED_SLUG"   --actor stamped-claim-actor   --flow-id builder.build   --title "Stamped gate-claim supersession attack session"   --source-request "Regression: a REAL, stamped gate claim must never be supersedable via record-evidence/record-check/dogfood-pass."   --summary "Seed session for the stamped-claim supersession negative."   --criterion "A stamped gate claim id cannot be superseded by record-evidence"   --timestamp "2026-07-05T09:12:30Z" >"$TMPDIR_EVAL/stamped-claim-seed.out" 2>"$TMPDIR_EVAL/stamped-claim-seed.err"

# Real record-gate-claim call — a genuine, properly-stamped gate claim (metadata.gate_claim is
# stamped by buildTrustBundle itself, never hand-constructed).
flow_agents_node "$WRITER" record-gate-claim "$STAMPED_DIR"   --actor stamped-claim-actor   --status pass   --summary "Work item selected for stamped-claim supersession session"   --timestamp "2026-07-05T09:12:35Z" >"$TMPDIR_EVAL/stamped-claim-gate.out" 2>"$TMPDIR_EVAL/stamped-claim-gate.err"

if [[ ! -f "$STAMPED_DIR/trust.bundle" ]]; then
  _fail "eval setup: record-gate-claim did not create trust.bundle for the stamped-claim session: $(cat "$TMPDIR_EVAL/stamped-claim-gate.out" "$TMPDIR_EVAL/stamped-claim-gate.err")"
fi

STAMPED_CHECK_ID="gate-claim-selected-work"
if node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/stamped-claim-preassert.err"
import { readFileSync } from 'node:fs';
const bundle = JSON.parse(readFileSync('${STAMPED_DIR}/trust.bundle', 'utf8'));
const claim = bundle.claims.find((c) => c.subjectId && c.subjectId.endsWith('/${STAMPED_CHECK_ID}'));
if (!claim) { process.stderr.write('eval setup: no claim found for ${STAMPED_CHECK_ID} after record-gate-claim\n'); process.exit(1); }
if (!claim.metadata || !claim.metadata.gate_claim || typeof claim.metadata.gate_claim !== 'object') { process.stderr.write('eval setup: record-gate-claim did NOT stamp metadata.gate_claim — cannot exercise this eval: ' + JSON.stringify(claim.metadata) + '\n'); process.exit(1); }
NODEOF
then
  _pass "eval setup: record-gate-claim produced a REAL, stamped claim for ${STAMPED_CHECK_ID} (metadata.gate_claim present)"
else
  _fail "eval setup: stamped-claim precondition failed: $(cat "$TMPDIR_EVAL/stamped-claim-preassert.err")"
fi

cp "$STAMPED_DIR/trust.bundle" "$TMPDIR_EVAL/stamped-claim-trust-bundle.before"

# The attack: record-evidence --check-json with the SAME id, caller-chosen kind:"policy" — must
# now DIE (the narrowed iteration-6 rule), not silently supersede and destroy the stamp.
if flow_agents_node "$WRITER" record-evidence "$STAMPED_DIR"   --verdict pass   --check-json "{\"id\":\"${STAMPED_CHECK_ID}\",\"kind\":\"policy\",\"status\":\"pass\",\"summary\":\"Attack: attempt to supersede a live stamped gate claim via record-evidence.\"}"   --timestamp "2026-07-05T09:12:45Z" >"$TMPDIR_EVAL/stamped-claim-attack.out" 2>"$TMPDIR_EVAL/stamped-claim-attack.err"; then
  _fail "#270 CRITICAL REGRESSION: record-evidence --check-json SUCCEEDED in superseding a live, stamped gate claim (${STAMPED_CHECK_ID}) — the narrowed guard did not fire"
elif grep -qi 'live, properly-stamped gate claim' "$TMPDIR_EVAL/stamped-claim-attack.out" "$TMPDIR_EVAL/stamped-claim-attack.err"   && grep -q "${STAMPED_CHECK_ID}" "$TMPDIR_EVAL/stamped-claim-attack.out" "$TMPDIR_EVAL/stamped-claim-attack.err"   && grep -qi 'only record-gate-claim' "$TMPDIR_EVAL/stamped-claim-attack.out" "$TMPDIR_EVAL/stamped-claim-attack.err"; then
  _pass "#270 CRITICAL: record-evidence --check-json dies when attempting to supersede a live, stamped gate claim, naming the id and pointing at record-gate-claim as the only legitimate path"
else
  _fail "#270 CRITICAL: stamped-claim supersession rejection message was unexpected: $(cat "$TMPDIR_EVAL/stamped-claim-attack.out" "$TMPDIR_EVAL/stamped-claim-attack.err")"
fi

# Assert the bundle is BYTE-IDENTICAL to before the attack — the die must happen before ANY
# write, so the stamp (and everything else) survives completely untouched.
if cmp -s "$TMPDIR_EVAL/stamped-claim-trust-bundle.before" "$STAMPED_DIR/trust.bundle"; then
  _pass "#270 CRITICAL: trust.bundle is byte-identical after the rejected attack — the die is fail-closed BEFORE any write"
else
  _fail "#270 CRITICAL REGRESSION: trust.bundle changed after the rejected supersession attempt — the die is not fail-closed before writing"
fi

# Semantic re-assertion: metadata.gate_claim is still present and unchanged (belt-and-suspenders
# on top of the byte-identical check above).
if node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/stamped-claim-postassert.err"
import { readFileSync } from 'node:fs';
const before = JSON.parse(readFileSync('${TMPDIR_EVAL}/stamped-claim-trust-bundle.before', 'utf8'));
const after = JSON.parse(readFileSync('${STAMPED_DIR}/trust.bundle', 'utf8'));
const claimBefore = before.claims.find((c) => c.subjectId && c.subjectId.endsWith('/${STAMPED_CHECK_ID}'));
const claimAfter = after.claims.find((c) => c.subjectId && c.subjectId.endsWith('/${STAMPED_CHECK_ID}'));
if (!claimAfter || !claimAfter.metadata || !claimAfter.metadata.gate_claim) { process.stderr.write('metadata.gate_claim is MISSING after the attack attempt — the stamp was destroyed\n'); process.exit(1); }
if (JSON.stringify(claimAfter.metadata.gate_claim) !== JSON.stringify(claimBefore.metadata.gate_claim)) { process.stderr.write('metadata.gate_claim CHANGED after the attack attempt: before=' + JSON.stringify(claimBefore.metadata.gate_claim) + ' after=' + JSON.stringify(claimAfter.metadata.gate_claim) + '\n'); process.exit(1); }
if (claimAfter.metadata.check_kind === 'policy') { process.stderr.write('claim.metadata.check_kind was overwritten to policy — the attack partially succeeded\n'); process.exit(1); }
NODEOF
then
  _pass "#270 CRITICAL: metadata.gate_claim stamp is semantically intact (present, unchanged) after the rejected attack"
else
  _fail "#270 CRITICAL: stamp-intact semantic assertion failed: $(cat "$TMPDIR_EVAL/stamped-claim-postassert.err")"
fi

# ─── Mutation test (existing-id exists-check, iteration 5, needle updated iteration 6): neuter ──
# the EXISTING-ID LOOKUP in a scratch copy of the compiled build/ output (force
# existingHasStamp to always be `undefined`, i.e. always treated as "not already present") — the
# correction eval above must go RED (the mis-recorded, unstamped wedge id becomes uncorrectable
# again, since `undefined` now routes to the new-mint die), proving the eval actually exercises
# the exists-check, not passing vacuously.
EXISTS_CHECK_SCRATCH="$TMPDIR_EVAL/exists-check-mutation-scratch"
mkdir -p "$EXISTS_CHECK_SCRATCH"

if [[ -f "$DIST_SIDECAR" ]]; then
  cp "$DIST_SIDECAR" "$EXISTS_CHECK_SCRATCH/workflow-sidecar.orig.js"
  node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/exists-check-neuter-allowance.err"
import { readFileSync, writeFileSync } from 'node:fs';
const file = '${EXISTS_CHECK_SCRATCH}/workflow-sidecar.orig.js';
let src = readFileSync(file, 'utf8');
const needle = 'const existingHasStamp = existingCheckStampById?.get(check.id);';
if (!src.includes(needle)) { process.stderr.write('mutation: existing-id stamp-map lookup text not found — source pattern drifted, cannot mutation-test\n'); process.exit(1); }
src = src.split(needle).join('const existingHasStamp = undefined;');
writeFileSync('${EXISTS_CHECK_SCRATCH}/workflow-sidecar.mutated-neuter-allowance.js', src);
NODEOF

  if [[ -s "$TMPDIR_EVAL/exists-check-neuter-allowance.err" ]]; then
    _fail "mutation-test setup failed (existing-id allowance source pattern did not match compiled output): $(cat "$TMPDIR_EVAL/exists-check-neuter-allowance.err")"
  else
    if node --check "$EXISTS_CHECK_SCRATCH/workflow-sidecar.mutated-neuter-allowance.js" 2>"$TMPDIR_EVAL/exists-check-neuter-allowance-syntax.err"; then
      cp "$EXISTS_CHECK_SCRATCH/workflow-sidecar.mutated-neuter-allowance.js" "$DIST_SIDECAR"

      MUTATION_CORRECTION_ROOT="$TMPDIR_EVAL/mutation-correction-root"
      cp -r "$CORRECTION_ROOT" "$MUTATION_CORRECTION_ROOT"
      MUTATION_CORRECTION_DIR="$MUTATION_CORRECTION_ROOT/$CORRECTION_SLUG"

      if flow_agents_node "$WRITER" record-evidence "$MUTATION_CORRECTION_DIR" \
        --verdict pass \
        --check-json "{\"id\":\"${CORRECTION_CHECK_ID}\",\"kind\":\"policy\",\"status\":\"pass\",\"summary\":\"Correction attempt with the existing-id allowance neutered — must go red.\"}" \
        --timestamp "2026-07-05T09:11:45Z" >"$TMPDIR_EVAL/exists-check-neuter-allowance-run.out" 2>"$TMPDIR_EVAL/exists-check-neuter-allowance-run.err"; then
        _fail "mutation-test: with the existing-id allowance neutered, the correction still SUCCEEDED — the eval may not be exercising the intended exists-check"
      else
        _pass "mutation-test: with the existing-id allowance neutered, the SAME correction that succeeded above now FAILS (eval correctly goes red without the exists-check, proving it exercises the exemption)"
      fi
    else
      _fail "mutation-test setup: mutated workflow-sidecar.js (existing-id allowance) failed a syntax check, refusing to run it: $(cat "$TMPDIR_EVAL/exists-check-neuter-allowance-syntax.err")"
    fi

    # Restore the real compiled guard immediately.
    cp "$EXISTS_CHECK_SCRATCH/workflow-sidecar.orig.js" "$DIST_SIDECAR"
  fi
else
  _fail "mutation-test setup: could not locate the compiled build/src/cli/workflow-sidecar.js to mutate for the existing-id allowance (ran 'npm run build' first?)"
fi

# ─── Mutation test (new-mint rejection, iteration 5): neuter the reserved-prefix rejection ─────
# ITSELF (force the whole `if` to false, same technique as the original reserved-prefix mutation
# test below but re-run here against the NOVEL-id eval) — Eval 2 (new-mint rejection) must go
# RED, proving that eval still exercises the underlying rejection and is not vacuously green
# just because the existing-id exemption happens to be present.
if [[ -f "$DIST_SIDECAR" ]]; then
  cp "$DIST_SIDECAR" "$EXISTS_CHECK_SCRATCH/workflow-sidecar.orig2.js"
  node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/exists-check-neuter-rejection.err"
import { readFileSync, writeFileSync } from 'node:fs';
const file = '${EXISTS_CHECK_SCRATCH}/workflow-sidecar.orig2.js';
let src = readFileSync(file, 'utf8');
const needle = 'if (!allowGateClaimPrefix && typeof check.id === "string" && check.id.startsWith("gate-claim-")) {';
if (!src.includes(needle)) { process.stderr.write('mutation: reserved-prefix guard text not found — source pattern drifted, cannot mutation-test\n'); process.exit(1); }
src = src.split(needle).join('if (false) {');
writeFileSync('${EXISTS_CHECK_SCRATCH}/workflow-sidecar.mutated-neuter-rejection.js', src);
NODEOF

  if [[ -s "$TMPDIR_EVAL/exists-check-neuter-rejection.err" ]]; then
    _fail "mutation-test setup failed (reserved-prefix guard source pattern did not match compiled output for the new-mint mutation test): $(cat "$TMPDIR_EVAL/exists-check-neuter-rejection.err")"
  else
    if node --check "$EXISTS_CHECK_SCRATCH/workflow-sidecar.mutated-neuter-rejection.js" 2>"$TMPDIR_EVAL/exists-check-neuter-rejection-syntax.err"; then
      cp "$EXISTS_CHECK_SCRATCH/workflow-sidecar.mutated-neuter-rejection.js" "$DIST_SIDECAR"

      if flow_agents_node "$WRITER" record-evidence "$CORRECTION_DIR" \
        --verdict pass \
        --check-json '{"id":"gate-claim-novel-mutation-red-check","kind":"policy","status":"pass","summary":"New-mint attempt with the reserved-prefix rejection neutered — must go red."}' \
        --timestamp "2026-07-05T09:12:00Z" >"$TMPDIR_EVAL/exists-check-neuter-rejection-run.out" 2>"$TMPDIR_EVAL/exists-check-neuter-rejection-run.err"; then
        _pass "mutation-test: with the reserved-prefix rejection neutered, a NOVEL gate-claim-* id now SUCCEEDS (eval correctly goes red without the rejection, proving Eval 2 exercises it)"
      else
        _fail "mutation-test: NOVEL gate-claim-* id still rejected even with the rejection neutered — Eval 2 may not be exercising the intended rejection: $(cat "$TMPDIR_EVAL/exists-check-neuter-rejection-run.out" "$TMPDIR_EVAL/exists-check-neuter-rejection-run.err")"
      fi
    else
      _fail "mutation-test setup: mutated workflow-sidecar.js (reserved-prefix rejection) failed a syntax check, refusing to run it: $(cat "$TMPDIR_EVAL/exists-check-neuter-rejection-syntax.err")"
    fi

    # Restore the real compiled guard immediately, and re-run BOTH evals to confirm green again.
    cp "$EXISTS_CHECK_SCRATCH/workflow-sidecar.orig2.js" "$DIST_SIDECAR"
    if flow_agents_node "$WRITER" record-evidence "$CORRECTION_DIR" \
      --verdict pass \
      --check-json '{"id":"gate-claim-novel-restore-check","kind":"policy","status":"pass","summary":"Restore check: new-mint rejection must be back after mutation-test cleanup."}' \
      --timestamp "2026-07-05T09:12:15Z" >"$TMPDIR_EVAL/exists-check-restore-novel.out" 2>"$TMPDIR_EVAL/exists-check-restore-novel.err"; then
      _fail "mutation-test cleanup REGRESSION: the new-mint reserved-prefix rejection did not come back after restoring the original compiled file"
    else
      _pass "mutation-test cleanup: the real compiled new-mint rejection is restored and rejects a caller-supplied 'gate-claim-' id again"
    fi
  fi
else
  _fail "mutation-test setup: could not locate the compiled build/src/cli/workflow-sidecar.js to mutate for the new-mint rejection (ran 'npm run build' first?)"
fi

# ─── Mutation test (#270 CRITICAL, iteration 6): neuter the STAMPED-CLAIM GUARD itself (force ──
# `existingHasStamp === true` to never be treated as stamped) in a scratch copy of the compiled
# build/ output — the Eval 3 negative above (stamped-claim supersession must die) must go RED
# (the attack SUCCEEDS against the mutated binary), proving Eval 3 actually exercises the new
# narrowed guard and is not vacuously green for an unrelated reason.
STAMPED_GUARD_SCRATCH="$TMPDIR_EVAL/stamped-guard-mutation-scratch"
mkdir -p "$STAMPED_GUARD_SCRATCH"

if [[ -f "$DIST_SIDECAR" ]]; then
  cp "$DIST_SIDECAR" "$STAMPED_GUARD_SCRATCH/workflow-sidecar.orig.js"
  node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/stamped-guard-neuter.err"
import { readFileSync, writeFileSync } from 'node:fs';
const file = '${STAMPED_GUARD_SCRATCH}/workflow-sidecar.orig.js';
let src = readFileSync(file, 'utf8');
const needle = 'if (existingHasStamp === true)';
if (!src.includes(needle)) { process.stderr.write('mutation: stamped-claim guard text not found — source pattern drifted, cannot mutation-test\n'); process.exit(1); }
src = src.split(needle).join('if (false)');
writeFileSync('${STAMPED_GUARD_SCRATCH}/workflow-sidecar.mutated-neuter-stamp-guard.js', src);
NODEOF

  if [[ -s "$TMPDIR_EVAL/stamped-guard-neuter.err" ]]; then
    _fail "mutation-test setup failed (stamped-claim guard source pattern did not match compiled output): $(cat "$TMPDIR_EVAL/stamped-guard-neuter.err")"
  else
    if node --check "$STAMPED_GUARD_SCRATCH/workflow-sidecar.mutated-neuter-stamp-guard.js" 2>"$TMPDIR_EVAL/stamped-guard-neuter-syntax.err"; then
      cp "$STAMPED_GUARD_SCRATCH/workflow-sidecar.mutated-neuter-stamp-guard.js" "$DIST_SIDECAR"

      MUTATION_STAMPED_ROOT="$TMPDIR_EVAL/mutation-stamped-root"
      cp -r "$STAMPED_ROOT" "$MUTATION_STAMPED_ROOT"
      MUTATION_STAMPED_DIR="$MUTATION_STAMPED_ROOT/$STAMPED_SLUG"

      if flow_agents_node "$WRITER" record-evidence "$MUTATION_STAMPED_DIR"         --verdict pass         --check-json "{\"id\":\"${STAMPED_CHECK_ID}\",\"kind\":\"policy\",\"status\":\"pass\",\"summary\":\"Mutation-test: stamped-claim guard disabled, attack must now succeed.\"}"         --timestamp "2026-07-05T09:13:00Z" >"$TMPDIR_EVAL/stamped-guard-neuter-run.out" 2>"$TMPDIR_EVAL/stamped-guard-neuter-run.err"; then
        _pass "mutation-test: with the stamped-claim guard neutered, superseding a live stamped gate claim now SUCCEEDS (eval correctly goes red without the guard, proving Eval 3 exercises it)"
      else
        _fail "mutation-test: stamped-claim supersession attack still rejected even with the guard neutered — Eval 3 may not be exercising the intended guard: $(cat "$TMPDIR_EVAL/stamped-guard-neuter-run.out" "$TMPDIR_EVAL/stamped-guard-neuter-run.err")"
      fi
    else
      _fail "mutation-test setup: mutated workflow-sidecar.js (stamped-claim guard) failed a syntax check, refusing to run it: $(cat "$TMPDIR_EVAL/stamped-guard-neuter-syntax.err")"
    fi

    # Restore the real compiled guard immediately, and re-run the negative to confirm green again.
    cp "$STAMPED_GUARD_SCRATCH/workflow-sidecar.orig.js" "$DIST_SIDECAR"
    if flow_agents_node "$WRITER" record-evidence "$STAMPED_DIR"       --verdict pass       --check-json "{\"id\":\"${STAMPED_CHECK_ID}\",\"kind\":\"policy\",\"status\":\"pass\",\"summary\":\"Restore check: stamped-claim guard must be back after mutation-test cleanup.\"}"       --timestamp "2026-07-05T09:13:15Z" >"$TMPDIR_EVAL/stamped-guard-restore.out" 2>"$TMPDIR_EVAL/stamped-guard-restore.err"; then
      _fail "mutation-test cleanup REGRESSION: the stamped-claim guard did not come back after restoring the original compiled file"
    else
      _pass "mutation-test cleanup: the real compiled stamped-claim guard is restored and rejects supersession of a live stamped gate claim again"
    fi
  fi
else
  _fail "mutation-test setup: could not locate the compiled build/src/cli/workflow-sidecar.js to mutate for the stamped-claim guard (ran 'npm run build' first?)"
fi

# ─── Mutation test (forged-stamp guard): temporarily disable assertStampedGateClaimValid's ────
# die() in a SCRATCH COPY of the compiled build/ output, confirm the forged-stamp fixture above
# now SUCCEEDS against that mutated binary (eval "goes red" — i.e. would no longer catch the
# defect — without the guard), then restore the original compiled file immediately. Proves the
# eval is actually exercising this guard, not passing vacuously for an unrelated reason.
MUTATION_SCRATCH="$TMPDIR_EVAL/mutation-scratch"
mkdir -p "$MUTATION_SCRATCH"

if [[ -f "$DIST_SIDECAR" ]]; then
  cp "$DIST_SIDECAR" "$MUTATION_SCRATCH/workflow-sidecar.orig.js"
  node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/mutation-patch.err"
import { readFileSync, writeFileSync } from 'node:fs';
const file = '${MUTATION_SCRATCH}/workflow-sidecar.orig.js';
let src = readFileSync(file, 'utf8');
// Neuter the stamp-tuple-mismatch check (assertStampedGateClaimValid's SECOND die call — the
// mismatch guard, not the no-flow-definition guard) by short-circuiting 'const match = ...' to
// an unconditional 'const match = true;' via a simple, exact single-line string replacement (no
// regex, no unbalanced parens) so the mutated file stays syntactically valid.
const matchNeedle = 'const match = allExpects.some((entry) => entry.gateExpects.some((exp) => exp.id === stamp.expectationId\n            && exp.bundle_claim.claimType === stamp.claimType\n            && exp.bundle_claim.subjectType === stamp.subjectType\n            && (stamp.stepId === null || stamp.stepId === entry.stepId)));';
if (!src.includes(matchNeedle)) { process.stderr.write('mutation: assertStampedGateClaimValid match-check text not found — source pattern drifted, cannot mutation-test\n'); process.exit(1); }
src = src.split(matchNeedle).join('const match = true;');
// Neuter the pre-cluster-270 unstamped-guard's if() condition the same way — exact single-line
// string replacement, no regex.
const unstampedNeedle = 'if (gateClaimShapeUnstampedClaimId) {';
if (!src.includes(unstampedNeedle)) { process.stderr.write('mutation: gateClaimShapeUnstampedClaimId guard text not found — source pattern drifted\n'); process.exit(1); }
src = src.split(unstampedNeedle).join('if (false && gateClaimShapeUnstampedClaimId) {');
writeFileSync('${MUTATION_SCRATCH}/workflow-sidecar.mutated.js', src);
NODEOF

  if [[ -s "$TMPDIR_EVAL/mutation-patch.err" ]]; then
    _fail "mutation-test setup failed (guard source pattern did not match compiled output): $(cat "$TMPDIR_EVAL/mutation-patch.err")"
  else
    # Syntax-check the mutated file before swapping it in — a broken mutation must not corrupt
    # the eval run itself.
    if node --check "$MUTATION_SCRATCH/workflow-sidecar.mutated.js" 2>"$TMPDIR_EVAL/mutation-syntax.err"; then
      cp "$MUTATION_SCRATCH/workflow-sidecar.mutated.js" "$DIST_SIDECAR"
      # Copy the WHOLE root again (see the FORGED_ROOT/PRECLUSTER_ROOT comment above) — same
      # current.json/current/<actor>.json resolution requirement applies here.
      MUTATION_FORGED_ROOT="$TMPDIR_EVAL/mutation-forged-root"
      cp -r "$FORGED_ROOT" "$MUTATION_FORGED_ROOT"
      MUTATION_FORGED_DIR="$MUTATION_FORGED_ROOT/$COMPOSE_SLUG"
      MUTATION_PRECLUSTER_ROOT="$TMPDIR_EVAL/mutation-precluster-root"
      cp -r "$PRECLUSTER_ROOT" "$MUTATION_PRECLUSTER_ROOT"
      MUTATION_PRECLUSTER_DIR="$MUTATION_PRECLUSTER_ROOT/$COMPOSE_SLUG"

      if flow_agents_node "$WRITER" record-critique "$MUTATION_FORGED_DIR" \
        --id mutation-forged-review --reviewer mutation-tester --verdict pass \
        --summary "Mutation-test: forged-stamp guard disabled, must go red" \
        --timestamp "2026-07-05T09:14:00Z" >"$TMPDIR_EVAL/mutation-forged.out" 2>"$TMPDIR_EVAL/mutation-forged.err"; then
        _pass "mutation-test: with the stamp-mismatch guard neutered, the forged-stamp fixture now SUCCEEDS (eval correctly goes red without the guard, proving the guard is what the eval exercises)"
      else
        _fail "mutation-test: forged-stamp fixture still failed even with the guard neutered — the eval may not be exercising the intended guard: $(cat "$TMPDIR_EVAL/mutation-forged.out" "$TMPDIR_EVAL/mutation-forged.err")"
      fi

      if flow_agents_node "$WRITER" record-critique "$MUTATION_PRECLUSTER_DIR" \
        --id mutation-precluster-review --reviewer mutation-tester --verdict pass \
        --summary "Mutation-test: pre-cluster-270 guard disabled, must go red" \
        --timestamp "2026-07-05T09:14:30Z" >"$TMPDIR_EVAL/mutation-precluster.out" 2>"$TMPDIR_EVAL/mutation-precluster.err"; then
        _pass "mutation-test: with the pre-cluster-270 unstamped guard neutered, the missing-stamp fixture now SUCCEEDS (eval correctly goes red without the guard)"
      else
        _fail "mutation-test: pre-cluster missing-stamp fixture still failed even with the guard neutered: $(cat "$TMPDIR_EVAL/mutation-precluster.out" "$TMPDIR_EVAL/mutation-precluster.err")"
      fi
    else
      _fail "mutation-test setup: mutated workflow-sidecar.js failed a syntax check, refusing to run it: $(cat "$TMPDIR_EVAL/mutation-syntax.err")"
    fi

    # Restore the real compiled guard immediately — never leave the mutated binary in place, and
    # re-run BOTH negatives to confirm the restored binary rejects them again (guard is back).
    cp "$MUTATION_SCRATCH/workflow-sidecar.orig.js" "$DIST_SIDECAR"
    RESTORE_FORGED_ROOT="$TMPDIR_EVAL/restore-check-forged-root"
    cp -r "$FORGED_ROOT" "$RESTORE_FORGED_ROOT"
    RESTORE_FORGED_DIR="$RESTORE_FORGED_ROOT/$COMPOSE_SLUG"
    if flow_agents_node "$WRITER" record-critique "$RESTORE_FORGED_DIR" \
      --id restore-check-review --reviewer restore-check-tester --verdict pass \
      --summary "Restore check: forged-stamp guard must be back after mutation-test cleanup" \
      --timestamp "2026-07-05T09:15:00Z" >"$TMPDIR_EVAL/mutation-restore.out" 2>"$TMPDIR_EVAL/mutation-restore.err"; then
      _fail "mutation-test cleanup REGRESSION: the forged-stamp guard did not come back after restoring the original compiled file"
    else
      _pass "mutation-test cleanup: the real compiled guard is restored and rejects the (already-forged) fixture again"
    fi
  fi
else
  _fail "mutation-test setup: could not locate the compiled build/src/cli/workflow-sidecar.js to mutate (ran 'npm run build' first?)"
fi



if [[ "$errors" -eq 0 ]]; then
  echo "Workflow sidecar writer integration passed."
  exit 0
fi

echo "Workflow sidecar writer integration failed: $errors issue(s)."
exit 1
