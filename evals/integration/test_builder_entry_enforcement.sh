#!/usr/bin/env bash
# Proves first-step workflow entry and provider-neutral local work-item anchoring (#438).

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

TMP="$(mktemp -d)"
errors=0
trap 'rm -rf "$TMP"' EXIT

pass() { printf '  PASS %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; errors=$((errors + 1)); }

WRITER="workflow-sidecar"

echo "=== Builder workflow entry enforcement ==="

REFUSED_ROOT="$TMP/refused/.kontourai/flow-agents"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$REFUSED_ROOT" \
  --task-slug refused-plan \
  --title "Refused plan entry" \
  --summary "Must enter through the declared prefix." \
  --flow-id builder.build \
  --step-id plan >"$TMP/refused.out" 2>&1; then
  fail "fresh later-step entry is rejected"
elif [[ ! -e "$REFUSED_ROOT" ]] && grep -q 'must start at first step "pull-work"' "$TMP/refused.out"; then
  pass "fresh later-step entry is rejected before artifact-root creation"
else
  fail "later-step refusal wrote files or returned the wrong diagnostic: $(cat "$TMP/refused.out")"
fi

AD_HOC_ROOT="$TMP/ad-hoc/.kontourai/flow-agents"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$AD_HOC_ROOT" \
  --task-slug refused-ad-hoc \
  --title "Refused ad-hoc entry" \
  --summary "A reason is not workflow authority." \
  --flow-id builder.build \
  --step-id plan \
  --ad-hoc-reason "skip the prefix" >"$TMP/ad-hoc.out" 2>&1; then
  fail "ad-hoc reason cannot authorize later-step entry"
elif [[ ! -e "$AD_HOC_ROOT" ]] && grep -q 'cannot authorize workflow entry' "$TMP/ad-hoc.out"; then
  pass "ad-hoc reason cannot authorize later-step entry or write artifacts"
else
  fail "ad-hoc refusal wrote files or returned the wrong diagnostic: $(cat "$TMP/ad-hoc.out")"
fi

LOCAL_ROOT="$TMP/local/.kontourai/flow-agents"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$LOCAL_ROOT" \
  --task-slug local-request \
  --title "Local request" \
  --summary "Providerless work still needs an anchor." \
  --flow-id builder.build \
  --timestamp "2026-07-10T00:00:00Z" >"$TMP/local.out" 2>&1; then
  if node - "$LOCAL_ROOT" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const current = JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8'));
const state = JSON.parse(fs.readFileSync(path.join(root, 'local-request', 'state.json'), 'utf8'));
const workItem = JSON.parse(fs.readFileSync(path.join(root, 'local-request', 'work-item.json'), 'utf8'));
if (current.active_flow_id !== 'builder.build' || current.active_step_id !== 'pull-work') process.exit(1);
if (state.status !== 'new' || state.phase !== 'pickup') process.exit(1);
if (JSON.stringify(state.work_item_refs) !== JSON.stringify(['local:local-request'])) process.exit(1);
if (workItem.id !== 'local-request' || workItem.title !== 'Local request') process.exit(1);
if (workItem.source_provider?.kind !== 'local' || workItem.source_provider?.path !== 'work-item.json') process.exit(1);
if (state.next_action?.command !== 'flow-agents builder-run start --session-dir .kontourai/flow-agents/local-request') process.exit(1);
if (state.next_action?.enforcement !== 'before_tool_use') process.exit(1);
if (JSON.stringify(state.next_action?.skills) !== JSON.stringify(['pull-work'])) process.exit(1);
if (!state.next_action?.summary?.includes('`pull-work`')) process.exit(1);
NODE
  then
    pass "providerless request creates a local Work Item and starts at pull-work"
  else
    fail "local Work Item or first-step state is invalid"
  fi
else
  fail "providerless Builder entry failed: $(cat "$TMP/local.out")"
fi

LOCAL_SESSION="$LOCAL_ROOT/local-request"
if flow_agents_node builder-run start --session-dir "$LOCAL_SESSION" >"$TMP/builder-start.out" 2>&1 \
  && node - "$TMP/local" "$LOCAL_SESSION" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const project = process.argv[2];
const session = process.argv[3];
const flowState = JSON.parse(fs.readFileSync(path.join(project, '.kontourai', 'flow', 'runs', 'local-request', 'state.json'), 'utf8'));
const sidecar = JSON.parse(fs.readFileSync(path.join(session, 'state.json'), 'utf8'));
if (flowState.current_step !== 'pull-work' || flowState.subject !== 'local:local-request') process.exit(1);
if (sidecar.flow_run?.current_step !== 'pull-work') process.exit(1);
if (JSON.stringify(sidecar.next_action?.skills) !== JSON.stringify(['pull-work'])) process.exit(1);
if (!sidecar.next_action?.command?.includes('builder-run sync')) process.exit(1);
NODE
then
  pass "small-model entry command creates canonical Flow run and projects pull-work action"
else
  fail "canonical Builder run did not start or project correctly: $(cat "$TMP/builder-start.out")"
fi

if flow_agents_node "$WRITER" record-gate-claim "$LOCAL_SESSION" \
  --expectation selected-work \
  --status pass \
  --summary "Selected local:local-request with scope and acceptance context." \
  --evidence-ref-json '{"kind":"artifact","file":".kontourai/flow-agents/local-request/work-item.json","summary":"Provider-neutral local Work Item."}' \
  >"$TMP/selected-work.out" 2>&1 \
  && node - "$TMP/local" "$LOCAL_SESSION" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const project = process.argv[2];
const session = process.argv[3];
const flowState = JSON.parse(fs.readFileSync(path.join(project, '.kontourai', 'flow', 'runs', 'local-request', 'state.json'), 'utf8'));
const sidecar = JSON.parse(fs.readFileSync(path.join(session, 'state.json'), 'utf8'));
if (flowState.current_step !== 'design-probe') process.exit(1);
if (sidecar.flow_run?.current_step !== 'design-probe') process.exit(1);
if (JSON.stringify(sidecar.next_action?.skills) !== JSON.stringify(['pickup-probe'])) process.exit(1);
NODE
then
  pass "gate-claim write synchronizes Flow and projects the next skill"
else
  fail "selected-work claim did not advance the canonical run: $(cat "$TMP/selected-work.out")"
fi

if FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=100000 \
  node "$ROOT/scripts/hooks/stop-goal-fit.js" >"$TMP/stop.out" 2>"$TMP/stop.err" <<JSON
{"hook_event_name":"Stop","cwd":"$TMP/local"}
JSON
then
  fail "active pre-execution Flow run should block Stop"
else
  stop_status=$?
  if [[ "$stop_status" -eq 2 ]] \
    && grep -q 'required skills: pickup-probe' "$TMP/stop.err" \
    && grep -q 'builder-run sync' "$TMP/stop.err" \
    && grep -q 'release skipped for active Flow run' "$TMP/stop.err" \
    && node - "$LOCAL_SESSION/state.json" <<'NODE'
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (state.flow_run?.status !== 'active' || state.flow_run?.current_step !== 'design-probe') process.exit(1);
NODE
  then
    pass "active Flow run blocks Stop, preserves liveness, and exposes executable guidance"
  else
    fail "active Flow Stop enforcement or guidance was incomplete (exit $stop_status): $(cat "$TMP/stop.err")"
  fi
fi

if flow_agents_node "$WRITER" record-gate-claim "$LOCAL_SESSION" \
  --expectation pickup-probe-readiness \
  --status pass \
  --summary "Pickup Probe confirmed scope and planning readiness." \
  --evidence-ref-json '{"kind":"artifact","file":".kontourai/flow-agents/local-request/work-item.json","summary":"Probe fixture evidence."}' >/dev/null 2>&1 \
  && flow_agents_node "$WRITER" record-gate-claim "$LOCAL_SESSION" \
  --expectation probe-decisions-or-accepted-gaps \
  --status pass \
  --summary "Probe decisions and accepted gaps are recorded." \
  --evidence-ref-json '{"kind":"artifact","file":".kontourai/flow-agents/local-request/work-item.json","summary":"Probe decision fixture evidence."}' >/dev/null 2>&1 \
  && flow_agents_node "$WRITER" record-gate-claim "$LOCAL_SESSION" \
  --expectation implementation-plan \
  --status pass \
  --summary "Implementation plan records files, sequence, and evidence." \
  --evidence-ref-json '{"kind":"artifact","file":".kontourai/flow-agents/local-request/work-item.json","summary":"Plan fixture evidence."}' >/dev/null 2>&1 \
  && flow_agents_node "$WRITER" record-gate-claim "$LOCAL_SESSION" \
  --expectation implementation-scope \
  --status pass \
  --summary "Implementation scope and changed files are recorded." \
  --evidence-ref-json '{"kind":"artifact","file":".kontourai/flow-agents/local-request/work-item.json","summary":"Execution fixture evidence."}' >/dev/null 2>&1 \
  && flow_agents_node "$WRITER" record-gate-claim "$LOCAL_SESSION" \
  --expectation tests-evidence \
  --status fail \
  --route-reason implementation_defect \
  --summary "Verification found an implementation defect." \
  --evidence-ref-json '{"kind":"artifact","file":".kontourai/flow-agents/local-request/work-item.json","summary":"Failed verification fixture evidence."}' >"$TMP/route-back.out" 2>&1 \
  && node - "$TMP/local" "$LOCAL_SESSION" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const project = process.argv[2];
const session = process.argv[3];
const flowState = JSON.parse(fs.readFileSync(path.join(project, '.kontourai', 'flow', 'runs', 'local-request', 'state.json'), 'utf8'));
const sidecar = JSON.parse(fs.readFileSync(path.join(session, 'state.json'), 'utf8'));
if (flowState.current_step !== 'execute') process.exit(1);
if (sidecar.flow_run?.route_back_attempt !== 1 || sidecar.flow_run?.route_back_max_attempts !== 3) process.exit(1);
if (JSON.stringify(sidecar.next_action?.skills) !== JSON.stringify(['execute-plan'])) process.exit(1);
if (!sidecar.next_action?.summary?.includes('Route-back history: attempt 1/3')) process.exit(1);
NODE
then
  pass "sidecar failure classifier drives Flow route-back and projects its attempt budget"
else
  fail "route-back classifier did not produce the canonical execute retry: $(cat "$TMP/route-back.out" 2>/dev/null)"
fi

PROVIDER_ROOT="$TMP/provider/.kontourai/flow-agents"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$PROVIDER_ROOT" \
  --work-item "kontourai/flow-agents#438" \
  --title "Provider work item" \
  --summary "Keep the provider reference." \
  --flow-id builder.build \
  --timestamp "2026-07-10T00:01:00Z" >/dev/null 2>&1 \
  && node - "$PROVIDER_ROOT/kontourai-flow-agents-438/state.json" <<'NODE'
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (JSON.stringify(state.work_item_refs) !== JSON.stringify(['kontourai/flow-agents#438'])) process.exit(1);
NODE
then
  pass "provider-backed request preserves its neutral work-item ref"
else
  fail "provider-backed work-item ref was not persisted"
fi

# A direct primitive remains usable without claiming Builder prefix completion.
STANDALONE_ROOT="$TMP/standalone/.kontourai/flow-agents"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$STANDALONE_ROOT" \
  --task-slug standalone-plan \
  --title "Standalone plan" \
  --summary "Direct primitive session." \
  --timestamp "2026-07-10T00:02:00Z" >/dev/null 2>&1 \
  && node - "$STANDALONE_ROOT" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const current = JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8'));
const state = JSON.parse(fs.readFileSync(path.join(root, 'standalone-plan', 'state.json'), 'utf8'));
if ('active_flow_id' in current || 'active_step_id' in current) process.exit(1);
if (state.status !== 'planned' || state.phase !== 'planning') process.exit(1);
if (JSON.stringify(state.work_item_refs) !== JSON.stringify(['local:standalone-plan'])) process.exit(1);
NODE
then
  pass "standalone primitive session remains available without a Builder stamp"
else
  fail "standalone primitive session was incorrectly stamped as Builder"
fi

if [[ "$errors" -gt 0 ]]; then
  printf 'test_builder_entry_enforcement: %d failure(s)\n' "$errors" >&2
  exit 1
fi

echo "test_builder_entry_enforcement: all checks passed"
