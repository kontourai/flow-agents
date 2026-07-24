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
    tool_name: "Bash",
    tool_input: {command: "echo installed"}
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
  if [[ -s "$full" && -s "$analytics" ]] \
    && cmp -s <(tail -1 "$full" | jq -S '.run_correlation') <(jq -S . "$expected") \
    && cmp -s <(tail -1 "$analytics" | jq -S '.run_correlation') <(jq -S . "$expected") \
    && [[ "$(tail -1 "$full" | jq -r '.task_slug')" == "$slug" ]]; then
    _pass "packed $runtime producer preserves exact correlation through full and redacted channels"
  else
    _fail "packed $runtime producer did not emit the exact Builder correlation"
  fi
done

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
