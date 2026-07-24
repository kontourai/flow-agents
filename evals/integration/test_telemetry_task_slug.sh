#!/usr/bin/env bash
# Authenticated Builder run attribution for canonical runtime telemetry.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -d "$ROOT_DIR/context/scripts/telemetry" ]]; then
  TELEMETRY_DIR="$ROOT_DIR/context/scripts/telemetry"
else
  TELEMETRY_DIR="$HOME/.flow-agents/context/scripts/telemetry"
fi
TELEMETRY_SH="${TELEMETRY_DIR}/telemetry.sh"
TMPDIR_EVAL=$(mktemp -d /tmp/eval-telemetry-run-binding.XXXXXX)
TMPLOG="${TMPDIR_EVAL}/test-output.jsonl"
trap 'rm -rf "$TMPDIR_EVAL"' EXIT

pass=0
fail=0
_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }

echo "=== Layer 2: Authenticated Telemetry Run Correlation ==="
echo ""

_run_event() {
  local input="$1" actor="$2"
  local before_lines
  mkdir -p "${TMPDIR_EVAL}/home" "${TMPDIR_EVAL}/sessions"
  touch "$TMPLOG"
  before_lines=$(wc -l < "$TMPLOG" | tr -d ' ')
  printf '%s' "$input" | env \
    HOME="${TMPDIR_EVAL}/home" \
    FLOW_AGENTS_ACTOR="$actor" \
    TELEMETRY_ENABLED=true \
    TELEMETRY_CHANNELS=full \
    TELEMETRY_CHANNEL_FULL_LOG_FILE="$TMPLOG" \
    FLOW_AGENTS_TELEMETRY_FOREGROUND=true \
    TELEMETRY_CONFIG_FILE="$TMPDIR_EVAL/telemetry.conf" \
    TELEMETRY_DATA_DIR="$TMPDIR_EVAL" \
    TELEMETRY_SESSION_DIR="$TMPDIR_EVAL/sessions" \
    TELEMETRY_USAGE_TRACKING=false \
    bash "$TELEMETRY_SH" preToolUse dev 2>/dev/null
  tail -n +"$((before_lines + 1))" "$TMPLOG" 2>/dev/null | tail -1
}

_seed_binding() {
  local workspace="$1" actor="$2" slug="$3"
  FLOW_AGENTS_ACTOR="$actor" node - "$ROOT_DIR" "$workspace" "$slug" <<'NODE'
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
(async () => {
  const [root, workspace, slug] = process.argv.slice(2);
  const runtime = await import(pathToFileURL(path.join(root, 'build/src/builder-flow-runtime.js')).href);
  const assignment = await import(pathToFileURL(path.join(root, 'build/src/cli/assignment-provider.js')).href);
  const artifactRoot = path.join(workspace, '.kontourai', 'flow-agents');
  const sessionDir = path.join(artifactRoot, slug);
  const subject = `local:work-item/${slug}`;
  fs.mkdirSync(sessionDir, { recursive: true });
  if (!fs.existsSync(path.join(workspace, 'package.json'))) {
    fs.writeFileSync(path.join(workspace, 'package.json'), '{"name":"telemetry-task-slug","private":true}\n');
  }
  fs.writeFileSync(path.join(sessionDir, 'state.json'), `${JSON.stringify({
    schema_version: '1.0',
    task_slug: slug,
    status: 'planned',
    phase: 'planning',
    updated_at: new Date().toISOString(),
    work_item_refs: [subject],
    next_action: { status: 'continue', summary: 'Start authenticated telemetry fixture.' },
  }, null, 2)}\n`);
  const actor = assignment.resolveCurrentAssignmentActor();
  assignment.performLocalClaim(artifactRoot, slug, actor.actor, {
    ttlSeconds: 1800,
    actorKey: actor.actorKey,
    branch: `fixture/${slug}`,
    artifactDir: slug,
    workItemRef: subject,
    reason: 'authenticated telemetry fixture',
  });
  const started = await runtime.startBuilderFlowSession({ sessionDir });
  process.stdout.write(started.run.correlation.envelope.correlation_id);
})().catch((error) => { console.error(error); process.exit(1); });
NODE
}

WORKSPACE="${TMPDIR_EVAL}/workspace"
mkdir -p "$WORKSPACE/.kontourai/flow-agents"

echo "--- Pre-activation never inherits the shared current pointer ---"
printf '%s\n' '{"active_slug":"foreign-run","artifact_dir":"foreign-run"}' \
  > "$WORKSPACE/.kontourai/flow-agents/current.json"
input=$(jq -nc --arg cwd "$WORKSPACE" '{
  session_id:"runtime-one",
  cwd:$cwd,
  hook_event_name:"PreToolUse",
  tool_name:"Bash",
  tool_input:{command:"echo hi"}
}')
pre=$(_run_event "$input" runtime-one)
if [[ "$(jq -r '.run_correlation.status // empty' <<<"$pre")" == "incomplete" ]] \
  && [[ "$(jq -r 'has("task_slug")' <<<"$pre")" == "false" ]]; then
  _pass "unbound event is explicitly incomplete and carries no foreign task_slug"
else
  _fail "unbound event inherited attribution: $pre"
fi

echo "--- Actor-bound event carries the exact persisted envelope ---"
correlation_one=$(_seed_binding "$WORKSPACE" runtime-one run-one)
first=$(_run_event "$input" runtime-one)
if [[ "$(jq -r '.task_slug // empty' <<<"$first")" == "run-one" ]] \
  && [[ "$(jq -r '.run_correlation.correlation_id // empty' <<<"$first")" == "$correlation_one" ]] \
  && cmp -s \
    <(jq -S '.run_correlation' <<<"$first") \
    <(jq -S '.run_correlation' "$WORKSPACE/.kontourai/flow-agents/run-one/state.json"); then
  _pass "bound event carries the exact validated Builder envelope and slug"
else
  _fail "bound event correlation mismatch: $first"
fi

echo "--- Concurrent actors in one workspace remain isolated ---"
correlation_two=$(_seed_binding "$WORKSPACE" runtime-two run-two)
actor_one=$(_run_event "$input" runtime-one)
actor_two=$(_run_event "$input" runtime-two)
if [[ "$(jq -r '.run_correlation.correlation_id' <<<"$actor_one")" == "$correlation_one" ]] \
  && [[ "$(jq -r '.run_correlation.correlation_id' <<<"$actor_two")" == "$correlation_two" ]]; then
  _pass "two runtime actors cannot cross-stamp"
else
  _fail "concurrent actor attribution crossed: one=$actor_one two=$actor_two"
fi

echo "--- Sequential run in one runtime replaces the prior generation ---"
correlation_three=$(_seed_binding "$WORKSPACE" runtime-one run-three)
sequential=$(_run_event "$input" runtime-one)
if [[ "$(jq -r '.run_correlation.correlation_id' <<<"$sequential")" == "$correlation_three" ]] \
  && [[ "$(jq -r '.task_slug' <<<"$sequential")" == "run-three" ]]; then
  _pass "sequential binding emits only the current run generation"
else
  _fail "sequential binding reused prior correlation: $sequential"
fi

echo "--- Tampered binding fails closed without leaking invalid identity ---"
node - "$ROOT_DIR" "$WORKSPACE" <<'NODE'
const fs = require('fs');
const path = require('path');
const [root, workspace] = process.argv.slice(2);
const pointers = require(path.join(root, 'scripts/hooks/lib/current-pointer.js'));
const actorIdentity = require(path.join(root, 'scripts/hooks/lib/actor-identity.js'));
const actorKey = actorIdentity.resolveActorIdentity({ FLOW_AGENTS_ACTOR: 'runtime-one' }).actor;
const file = pointers.perActorCurrentFile(path.join(workspace, '.kontourai', 'flow-agents'), actorKey);
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
value.binding_id = 'correlation-tampered';
fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
NODE
tampered=$(_run_event "$input" runtime-one)
if [[ "$(jq -r '.run_correlation.status // empty' <<<"$tampered")" == "incomplete" ]] \
  && [[ "$(jq -r 'has("task_slug")' <<<"$tampered")" == "false" ]] \
  && ! grep -q "correlation-tampered" <<<"$tampered"; then
  _pass "tampered generation degrades to content-free incomplete correlation"
else
  _fail "tampered binding was trusted or leaked: $tampered"
fi

echo ""
echo "Authenticated telemetry run correlation: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
