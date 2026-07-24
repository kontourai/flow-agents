#!/usr/bin/env bash
# Packed-install proof that every shipped runtime telemetry path carries the
# authenticated Builder correlation envelope after activation.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d /tmp/installed-runtime-correlation.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }

echo "=== Installed Runtime Correlation ==="

npm run build --silent >/dev/null
npm pack --ignore-scripts --silent --pack-destination "$TMP" >/dev/null
TARBALL="$(find "$TMP" -maxdepth 1 -name 'kontourai-flow-agents-*.tgz' -print -quit)"
CONSUMER="$TMP/consumer"
mkdir -p "$CONSUMER"
npm install --silent --no-audit --no-fund --ignore-scripts --prefix "$CONSUMER" "$TARBALL"
PACKAGE="$CONSUMER/node_modules/@kontourai/flow-agents"

cat > "$TMP/start-run.mjs" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [packageRoot, workspace, slug] = process.argv.slice(2);
const runtime = await import(pathToFileURL(path.join(packageRoot, 'build/src/builder-flow-runtime.js')).href);
const assignment = await import(pathToFileURL(path.join(packageRoot, 'build/src/cli/assignment-provider.js')).href);
const artifactRoot = path.join(workspace, '.kontourai', 'flow-agents');
const sessionDir = path.join(artifactRoot, slug);
const subject = `local:work-item/${slug}`;
fs.mkdirSync(sessionDir, { recursive: true });
fs.writeFileSync(path.join(workspace, 'package.json'), '{"name":"installed-runtime-correlation","private":true}\n');
fs.writeFileSync(path.join(sessionDir, 'state.json'), `${JSON.stringify({
  schema_version: '1.0',
  task_slug: slug,
  status: 'planned',
  phase: 'planning',
  updated_at: new Date().toISOString(),
  work_item_refs: [subject],
  next_action: { status: 'continue', summary: 'Installed runtime fixture.' },
}, null, 2)}\n`);
fs.writeFileSync(path.join(sessionDir, 'acceptance.json'), `${JSON.stringify({
  schema_version: '1.0',
  task_slug: slug,
  criteria: [{
    id: 'AC-1',
    description: 'Installed telemetry carries authenticated correlation.',
    status: 'pending',
    evidence_refs: [],
  }],
  goal_fit: { status: 'pending', summary: 'Fixture acceptance is pending.' },
}, null, 2)}\n`);
const actor = assignment.resolveCurrentAssignmentActor();
assignment.performLocalClaim(artifactRoot, slug, actor.actor, {
  ttlSeconds: 1800,
  actorKey: actor.actorKey,
  branch: `fixture/${slug}`,
  artifactDir: slug,
  workItemRef: subject,
  reason: 'installed runtime correlation fixture',
});
const started = await runtime.startBuilderFlowSession({ sessionDir });
if (started.run.correlation.status !== 'present') throw new Error('Builder correlation was not minted');
process.stdout.write(`${JSON.stringify(started.run.correlation.envelope)}\n`);
NODE

run_runtime() {
  local runtime="$1" session="$2"
  shift 2
  local clean_env=(
    env
    -u CLAUDECODE
    -u CLAUDE_CODE_SESSION_ID
    -u CODEX_THREAD_ID
    -u CODEX_SESSION_ID
    -u OPENCODE_SESSION_ID
    -u PI_SESSION_ID
    -u FLOW_AGENTS_ACTOR
  )
  case "$runtime" in
    claude)
      "${clean_env[@]}" CLAUDECODE=1 CLAUDE_CODE_SESSION_ID="$session" "$@"
      ;;
    codex)
      "${clean_env[@]}" CODEX_THREAD_ID="$session" "$@"
      ;;
    kiro)
      "${clean_env[@]}" FLOW_AGENTS_ACTOR="$session" "$@"
      ;;
    opencode)
      "${clean_env[@]}" OPENCODE_SESSION_ID="$session" "$@"
      ;;
    pi)
      "${clean_env[@]}" PI_SESSION_ID="$session" "$@"
      ;;
    *)
      return 2
      ;;
  esac
}

invoke_hook() {
  local runtime="$1" session="$2" workspace="$3" prefix="$4"
  local input
  input=$(jq -nc --arg cwd "$workspace" --arg session "$session" '{
    session_id: $session,
    turn_id: "turn-one",
    cwd: $cwd,
    hook_event_name: "PreToolUse",
    tool_name: "Task",
    tool_input: {subagent_type: "worker", prompt: "perform the installed fixture step"}
  }')
  local common=(
    HOME="$TMP/home"
    TELEMETRY_ENABLED=true
    TELEMETRY_CHANNELS=full,analytics
    TELEMETRY_CHANNEL_FULL_LOG_FILE="$prefix.full.jsonl"
    TELEMETRY_CHANNEL_ANALYTICS_LOG_FILE="$prefix.analytics.jsonl"
    TELEMETRY_CONFIG_FILE="$TMP/telemetry.conf"
    TELEMETRY_DATA_DIR="$TMP/telemetry"
    TELEMETRY_SESSION_DIR="$TMP/telemetry/sessions"
    TELEMETRY_USAGE_TRACKING=false
    FLOW_AGENTS_CLAUDE_TELEMETRY_FOREGROUND=true
    FLOW_AGENTS_CODEX_TELEMETRY_FOREGROUND=true
    FLOW_AGENTS_OPENCODE_TELEMETRY_FOREGROUND=true
    FLOW_AGENTS_PI_TELEMETRY_FOREGROUND=true
    FLOW_AGENTS_CLAUDE_TELEMETRY_CHANNELS=full,analytics
    FLOW_AGENTS_CODEX_TELEMETRY_CHANNELS=full,analytics
    FLOW_AGENTS_OPENCODE_TELEMETRY_CHANNELS=full,analytics
    FLOW_AGENTS_PI_TELEMETRY_CHANNELS=full,analytics
  )
  mkdir -p "$TMP/home" "$TMP/telemetry/sessions"
  case "$runtime" in
    claude)
      printf '%s' "$input" | run_runtime "$runtime" "$session" env "${common[@]}" \
        node "$PACKAGE/scripts/hooks/claude-telemetry-hook.js" PreToolUse dev >/dev/null
      ;;
    codex)
      printf '%s' "$input" | run_runtime "$runtime" "$session" env "${common[@]}" \
        node "$PACKAGE/scripts/hooks/codex-telemetry-hook.js" PreToolUse dev >/dev/null
      ;;
    kiro)
      printf '%s' "$input" | run_runtime "$runtime" "$session" env "${common[@]}" \
        FLOW_AGENTS_TELEMETRY_RUNTIME=kiro-cli FLOW_AGENTS_TELEMETRY_FOREGROUND=true \
        bash "$PACKAGE/context/scripts/telemetry/telemetry.sh" preToolUse dev >/dev/null
      ;;
    opencode)
      printf '%s' "$input" | run_runtime "$runtime" "$session" env "${common[@]}" \
        node "$PACKAGE/scripts/hooks/opencode-telemetry-hook.js" tool.execute.before dev >/dev/null
      ;;
    pi)
      printf '%s' "$input" | run_runtime "$runtime" "$session" env "${common[@]}" \
        node "$PACKAGE/scripts/hooks/pi-telemetry-hook.js" tool_call dev >/dev/null
      ;;
  esac
}

invoke_claude_lifecycle() {
  local event="$1" session="$2" workspace="$3" prefix="$4" transcript="$5"
  local input
  input=$(jq -nc \
    --arg event "$event" \
    --arg cwd "$workspace" \
    --arg session "$session" \
    --arg transcript "$transcript" '{
      session_id: $session,
      turn_id: "terminal-turn",
      cwd: $cwd,
      hook_event_name: $event,
      transcript_path: $transcript
    }')
  local common=(
    HOME="$TMP/home"
    TELEMETRY_ENABLED=true
    TELEMETRY_CHANNELS=full,analytics
    TELEMETRY_CHANNEL_FULL_LOG_FILE="$prefix.full.jsonl"
    TELEMETRY_CHANNEL_ANALYTICS_LOG_FILE="$prefix.analytics.jsonl"
    TELEMETRY_CONFIG_FILE="$TMP/telemetry.conf"
    TELEMETRY_DATA_DIR="$TMP/telemetry"
    TELEMETRY_SESSION_DIR="$TMP/telemetry/sessions"
    TELEMETRY_USAGE_TRACKING=true
    TELEMETRY_PRICING_FILE="$ROOT/scripts/telemetry/pricing.json"
    TELEMETRY_ECONOMICS_LOG_FILE="$prefix.economics.jsonl"
    FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY=false
    FLOW_AGENTS_CLAUDE_TELEMETRY_FOREGROUND=true
    FLOW_AGENTS_CLAUDE_TELEMETRY_CHANNELS=full,analytics
  )
  printf '%s' "$input" | run_runtime claude "$session" env "${common[@]}" \
    node "$PACKAGE/scripts/hooks/claude-telemetry-hook.js" "$event" dev >/dev/null
}

PRE_WORKSPACE="$TMP/pre-activation"
mkdir -p "$PRE_WORKSPACE"
invoke_hook claude pre-activation-session "$PRE_WORKSPACE" "$TMP/pre"
if [[ "$(tail -1 "$TMP/pre.full.jsonl" | jq -r '.run_correlation.status')" == "incomplete" ]] \
  && [[ "$(tail -1 "$TMP/pre.full.jsonl" | jq -r 'has("task_slug")')" == "false" ]]; then
  _pass "packed Claude hook emits explicit incomplete correlation before activation"
else
  _fail "packed pre-activation event was not explicitly unbound"
fi

SHARED_WORKSPACE="$TMP/shared-workspace"
mkdir -p "$SHARED_WORKSPACE"
for runtime in claude codex kiro opencode pi; do
  session="${runtime}-session-one"
  workspace="$SHARED_WORKSPACE"
  slug="${runtime}-run-one"
  expected="$TMP/$runtime.expected.json"
  run_runtime "$runtime" "$session" node "$TMP/start-run.mjs" "$PACKAGE" "$workspace" "$slug" > "$expected"
  invoke_hook "$runtime" "$session" "$workspace" "$TMP/$runtime"

  full="$TMP/$runtime.full.jsonl"
  analytics="$TMP/$runtime.analytics.jsonl"
  state="$workspace/.kontourai/flow-agents/$slug/state.json"
  usage_event="$(jq -nc \
    --arg session "$session" \
    --arg slug "$slug" \
    --arg cwd "$workspace" \
    --slurpfile correlation "$expected" '{
      event_type: "session.usage",
      session_id: $session,
      timestamp: "1784707200000",
      task_slug: $slug,
      context: {cwd: $cwd},
      run_correlation: $correlation[0],
      usage: {
        model: "installed-fixture",
        input_tokens: 100,
        output_tokens: 25,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        estimated_cost_usd: null,
        duration_s: 1,
        by_model: null
      }
    }')"
  TELEMETRY_ECONOMICS_LOG_FILE="$TMP/$runtime.economics.jsonl" \
    TELEMETRY_ECONOMICS_RELAY=false \
    FLOW_AGENTS_ECONOMICS_FIXTURE_MODE=true \
    bash "$PACKAGE/scripts/telemetry/economics-record.sh" "$usage_event" --state "$state"

  if [[ -s "$full" && -s "$analytics" ]] \
    && cmp -s <(tail -1 "$full" | jq -S '.run_correlation') <(jq -S . "$expected") \
    && cmp -s <(tail -1 "$analytics" | jq -S '.run_correlation') <(jq -S . "$expected") \
    && cmp -s <(jq -cS 'select(.event_type == "agent.delegate") | .run_correlation' "$full" | tail -1) <(jq -cS . "$expected") \
    && cmp -s <(jq -cS '.run_correlation' "$state") <(jq -cS . "$expected") \
    && cmp -s <(tail -1 "$TMP/$runtime.economics.jsonl" | jq -cS '.run_correlation') <(jq -cS . "$expected") \
    && jq -e '
      .workflow_outcome.source == "canonical_flow_projection"
      and .workflow_outcome.process_status == "not_verified"
      and .workflow_outcome.quality_status == "not_independently_evaluated"
    ' "$state" >/dev/null \
    && [[ ! -e "$workspace/.kontourai/flow-agents/$slug/workflow-outcome.json" ]] \
    && [[ "$(tail -1 "$full" | jq -r '.task_slug')" == "$slug" ]]; then
    _pass "packed $runtime producers preserve exact correlation through telemetry, delegation, state, and economics"
  else
    _fail "packed $runtime producers did not preserve the exact Builder correlation"
  fi
done

echo ""
echo "--- Installed terminal reconstruction from producer-owned records ---"
TERMINAL_WORKSPACE="$TMP/terminal-workspace"
TERMINAL_ROOT="$TERMINAL_WORKSPACE/.kontourai/flow-agents"
TERMINAL_SLUG="installed-terminal-shape"
TERMINAL_SESSION="$TERMINAL_ROOT/$TERMINAL_SLUG"
TERMINAL_RUNTIME_SESSION="claude-terminal-session"
TERMINAL_PREFIX="$TMP/terminal"
TERMINAL_TRANSCRIPT="$TMP/terminal-transcript.jsonl"
TERMINAL_ARTIFACT="$TERMINAL_SESSION/$TERMINAL_SLUG--idea-to-backlog.md"
TERMINAL_CLI="$PACKAGE/build/src/cli.js"
mkdir -p "$TERMINAL_WORKSPACE" "$TERMINAL_SESSION"
: > "$TERMINAL_TRANSCRIPT"
printf '%s\n' '{"name":"installed-terminal-reconstruction","private":true}' > "$TERMINAL_WORKSPACE/package.json"
printf '%s\n' '# Installed terminal shape' > "$TERMINAL_ARTIFACT"

terminal_flow() {
  (cd "$TERMINAL_WORKSPACE" && run_runtime claude "$TERMINAL_RUNTIME_SESSION" \
    node "$TERMINAL_CLI" workflow "$@")
}

invoke_claude_lifecycle SessionStart "$TERMINAL_RUNTIME_SESSION" "$TERMINAL_WORKSPACE" "$TERMINAL_PREFIX" "$TERMINAL_TRANSCRIPT"
terminal_flow start --artifact-root "$TERMINAL_ROOT" --flow builder.shape \
  --task-slug "$TERMINAL_SLUG" --summary "Installed terminal reconstruction fixture." >/dev/null
TERMINAL_CORRELATION="$TMP/terminal.expected.json"
jq '.run_correlation' "$TERMINAL_SESSION/state.json" > "$TERMINAL_CORRELATION"
invoke_claude_lifecycle UserPromptSubmit "$TERMINAL_RUNTIME_SESSION" "$TERMINAL_WORKSPACE" "$TERMINAL_PREFIX" "$TERMINAL_TRANSCRIPT"
invoke_hook claude "$TERMINAL_RUNTIME_SESSION" "$TERMINAL_WORKSPACE" "$TERMINAL_PREFIX"

TERMINAL_REF="$(jq -nc --arg file "$TERMINAL_ARTIFACT" '{
  kind:"artifact",
  file:$file,
  summary:"Installed shape evidence bound to the terminal run."
}')"
for expectation in shaped-problem shaped-outcome shaped-constraints shaped-non-goals shaped-success shaped-risk slices-defined work-items-filed; do
  terminal_flow evidence --session-dir "$TERMINAL_SESSION" \
    --expectation "$expectation" \
    --status pass \
    --summary "Installed terminal fixture records $expectation." \
    --evidence-ref-json "$TERMINAL_REF" >/dev/null
done
cp "$ROOT/evals/fixtures/telemetry/usage-transcript-sample.jsonl" "$TERMINAL_TRANSCRIPT"
invoke_claude_lifecycle Stop "$TERMINAL_RUNTIME_SESSION" "$TERMINAL_WORKSPACE" "$TERMINAL_PREFIX" "$TERMINAL_TRANSCRIPT"
for _ in $(seq 1 50); do
  [[ -s "$TERMINAL_PREFIX.economics.jsonl" ]] && break
  sleep 0.1
done

TERMINAL_FLOW_DIR="$TERMINAL_WORKSPACE/.kontourai/flow/runs/$TERMINAL_SLUG"
if node --input-type=module - \
  "$PACKAGE" \
  "$TERMINAL_PREFIX.full.jsonl" \
  "$TERMINAL_SESSION/state.json" \
  "$TERMINAL_SESSION/trust.bundle" \
  "$TERMINAL_FLOW_DIR/state.json" \
  "$TERMINAL_FLOW_DIR/evidence/manifest.json" \
  "$TERMINAL_PREFIX.economics.jsonl" \
  "$TERMINAL_SESSION/workflow-outcome.json" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [packageRoot, fullFile, stateFile, trustFile, flowFile, manifestFile, economicsFile, terminalFile] = process.argv.slice(2);
const { reconstructRun } = await import(pathToFileURL(path.join(packageRoot, 'build/src/run-reconstruction.js')).href);
const lines = fs.readFileSync(fullFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const trust = JSON.parse(fs.readFileSync(trustFile, 'utf8'));
const flow = JSON.parse(fs.readFileSync(flowFile, 'utf8'));
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const economics = JSON.parse(fs.readFileSync(economicsFile, 'utf8').trim().split('\n').at(-1));
const terminal = JSON.parse(fs.readFileSync(terminalFile, 'utf8'));
const correlation = terminal.run_correlation;
const exact = (value, label) => {
  if (JSON.stringify(value) !== JSON.stringify(correlation)) throw new Error(`${label} correlation mismatch`);
  return value;
};
const usage = lines.findLast((record) => record.event_type === 'session.usage');
const turn = lines.findLast((record) => record.event_type === 'turn.user');
const tool = lines.findLast((record) => record.event_type === 'tool.invoke');
const delegation = lines.findLast((record) => record.event_type === 'agent.delegate');
for (const [record, label] of [[usage, 'usage'], [turn, 'turn'], [tool, 'tool'], [delegation, 'delegation']]) {
  if (!record) throw new Error(`missing ${label} producer record`);
  exact(record.run_correlation, label);
}
exact(state.run_correlation, 'state');
exact(economics.run_correlation, 'economics');
if (flow.status !== 'completed' || state.workflow_outcome.process_status !== 'completed') {
  throw new Error('canonical Flow did not complete');
}
if (!Array.isArray(trust.claims) || trust.claims.length < 8) throw new Error('trust evidence is incomplete');
const attached = (manifest.evidence || []).filter((entry) =>
  entry.analytics?.run_correlation
  && JSON.stringify(entry.analytics.run_correlation) === JSON.stringify(correlation));
if (attached.length < 3) throw new Error('canonical Flow trust references lack correlation');
const facts = [
  { kind: 'runtime_session', record_id: usage.event_id, run_correlation: usage.run_correlation },
  { kind: 'runtime_turn', record_id: turn.event_id, run_correlation: turn.run_correlation },
  { kind: 'tool', record_id: tool.event_id, run_correlation: tool.run_correlation },
  { kind: 'flow_gate', record_id: `flow-gates:${flow.run_id}`, run_correlation: state.run_correlation },
  { kind: 'route_back', record_id: `route-backs:${flow.run_id}`, run_correlation: state.run_correlation },
  { kind: 'delegation', record_id: delegation.event_id, run_correlation: delegation.run_correlation },
  { kind: 'trust', record_id: `trust:${flow.run_id}`, run_correlation: attached.at(-1).analytics.run_correlation },
  { kind: 'economics', record_id: `economics:${economics.run_id}`, run_correlation: economics.run_correlation },
  { kind: 'terminal', record_id: terminal.record_id, run_correlation: terminal.run_correlation, process_status: terminal.process_status },
];
const reconstructed = reconstructRun(facts, correlation.correlation_id);
if (reconstructed.missing_kinds.length !== 0 || reconstructed.process_status !== 'completed') {
  throw new Error(`incomplete reconstruction: ${reconstructed.missing_kinds.join(',')}`);
}
NODE
then
  _pass "installed producers reconstruct one terminal run by canonical identity alone"
else
  _fail "installed terminal producer path did not reconstruct end to end"
fi

unique_correlations="$(
  for runtime in claude codex kiro opencode pi; do
    jq -r '.correlation_id' "$TMP/$runtime.expected.json"
  done | sort -u | wc -l | tr -d ' '
)"
if [[ "$unique_correlations" == "5" ]]; then
  _pass "five installed runtime sessions remain isolated in one workspace"
else
  _fail "concurrent installed runtime sessions reused or crossed correlation"
fi

prior_claude_correlation="$(jq -r '.correlation_id' "$TMP/claude.expected.json")"
run_runtime claude claude-session-one \
  node "$TMP/start-run.mjs" "$PACKAGE" "$SHARED_WORKSPACE" claude-run-two \
  > "$TMP/claude-sequential.expected.json"
invoke_hook claude claude-session-one "$SHARED_WORKSPACE" "$TMP/claude-sequential"
sequential_claude_correlation="$(tail -1 "$TMP/claude-sequential.full.jsonl" | jq -r '.run_correlation.correlation_id')"
if cmp -s \
    <(tail -1 "$TMP/claude-sequential.full.jsonl" | jq -S '.run_correlation') \
    <(jq -S . "$TMP/claude-sequential.expected.json") \
  && [[ "$sequential_claude_correlation" != "$prior_claude_correlation" ]]; then
  _pass "one installed runtime session replaces its prior run generation"
else
  expected_sequential_correlation="$(jq -r '.correlation_id' "$TMP/claude-sequential.expected.json")"
  emitted_sequential_slug="$(tail -1 "$TMP/claude-sequential.full.jsonl" | jq -r '.task_slug // empty')"
  _fail "sequential installed runtime mismatch (prior=$prior_claude_correlation expected=$expected_sequential_correlation emitted=$sequential_claude_correlation slug=$emitted_sequential_slug)"
fi

kiro_runtime_status="$(jq -r '.identities.runtime_session.status' "$TMP/kiro.expected.json")"
kiro_runtime_reason="$(jq -r '.identities.runtime_session.reason // empty' "$TMP/kiro.expected.json")"
if [[ "$kiro_runtime_status" != "present" && -n "$kiro_runtime_reason" ]]; then
  _pass "packed Kiro fixture keeps unavailable Builder-start session identity explicit"
else
  _fail "packed Kiro fixture fabricated or omitted runtime identity support"
fi

if node --input-type=module - "$PACKAGE" <<'NODE'
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const packageRoot = process.argv[2];
const contract = await import(pathToFileURL(path.join(packageRoot, 'build/src/run-correlation.js')).href);
for (const runtime of ['claude-code', 'codex', 'kiro', 'opencode', 'pi']) {
  const declaration = contract.runtimeCorrelationIdentityDeclaration(runtime);
  for (const key of contract.RUN_CORRELATION_IDENTITY_KEYS) {
    const support = declaration[key];
    if (!support || typeof support.status !== 'string') throw new Error(`${runtime}.${key} is undeclared`);
    if (support.status === 'unsupported' && (typeof support.reason !== 'string' || !support.reason)) {
      throw new Error(`${runtime}.${key} omitted its unsupported reason`);
    }
  }
}
NODE
then
  _pass "packed runtime capability declarations keep every identity slot explicit"
else
  _fail "packed runtime capability declarations omitted identity support"
fi

if bash "$ROOT/evals/ci/run-baseline.sh" --manifest-json \
  | jq -e 'any(.[]; .id == "installed-runtime-correlation-integration" and (.lanes | index("runtime-and-kit")))' \
    >/dev/null; then
  _pass "packed-runtime proof is a required runtime-and-kit manifest check"
else
  _fail "packed-runtime proof is missing from the required runtime-and-kit manifest"
fi

echo ""
echo "Installed runtime correlation: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
