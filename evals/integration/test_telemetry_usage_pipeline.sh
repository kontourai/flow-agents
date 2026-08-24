#!/usr/bin/env bash
# test_telemetry_usage_pipeline.sh — Layer 2: hermetic Stop-hook usage pipeline
#
# Proves the full telemetry.sh Stop path (add_stop_data_and_emit_usage) yields
# a session.usage event with real tokens, a concrete (non-"unknown") model,
# and a non-null estimated_cost_usd when a runtime transcript is supplied —
# and that tokens still survive (with estimated_cost_usd null) when the
# pricing registry is forced unavailable. Also guards the kiro-cli
# non-regression case: with no transcript, model still resolves via the
# existing usage_get_model() kiro lookup (unaffected by this fix).
#
# Uses the same TELEMETRY_DIR resolution convention as test_telemetry.sh
# (prefers context/scripts/telemetry when present) so this exercises the same
# copy CI actually runs, while explicitly pointing TELEMETRY_PRICING_FILE at
# the canonical bundled registry so pricing resolves regardless of which copy
# is under test (context/scripts/telemetry ships no bundled pricing.json).
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -d "$ROOT_DIR/context/scripts/telemetry" ]]; then
  TELEMETRY_DIR="$ROOT_DIR/context/scripts/telemetry"
else
  TELEMETRY_DIR="$HOME/.flow-agents/context/scripts/telemetry"
fi
TELEMETRY_SH="${TELEMETRY_DIR}/telemetry.sh"
PRICING_FILE="$ROOT_DIR/scripts/telemetry/pricing.json"
FIXTURE_TRANSCRIPT="$ROOT_DIR/evals/fixtures/telemetry/usage-transcript-sample.jsonl"

TMPDIR_EVAL=$(mktemp -d /tmp/eval-telemetry-usage-pipeline.XXXXXX)
TMPLOG="${TMPDIR_EVAL}/test-output.jsonl"
FAKE_HOME="${TMPDIR_EVAL}/home"
mkdir -p "$FAKE_HOME" "$TMPDIR_EVAL/sessions"

pass=0; fail=0
_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }

echo "=== Layer 2: Telemetry Usage Pipeline (hermetic fixture) ==="
echo ""

if [[ ! -f "$TELEMETRY_SH" ]]; then
  _fail "telemetry.sh not found at $TELEMETRY_SH"
  echo "Cannot continue without telemetry script"
  rm -rf "$TMPDIR_EVAL"
  exit 1
fi
if [[ ! -f "$FIXTURE_TRANSCRIPT" ]]; then
  _fail "fixture transcript not found at $FIXTURE_TRANSCRIPT"
  rm -rf "$TMPDIR_EVAL"
  exit 1
fi

# Wait for a new line to land in TMPLOG (telemetry.sh's Stop path emits
# asynchronously even in foreground mode's background-adjacent callers).
_wait_for_line() {
  local before_lines="$1" i=0 current_lines
  while [[ $i -lt 50 ]]; do
    current_lines=$(wc -l < "$TMPLOG" 2>/dev/null | tr -d ' ')
    [[ "${current_lines:-0}" -gt "$before_lines" ]] && break
    sleep 0.1; i=$((i + 1))
  done
}

_wait_for_file_line() { # <file> [jq-selector]
  # A single Builder Stop appends TWO economics records from two INDEPENDENT detached writers
  # (legacy session.usage-derived and canonical Flow-run-derived), so their append order is a race
  # and "the file has a line" no longer means "the record I need has arrived" — waiting on the raw
  # line count returns as soon as EITHER producer wins. Callers reading a specific producer must
  # pass the same selector they read with, or they will sample an empty result and report it as a
  # missing field rather than as a race they lost.
  local file="$1" selector="${2:-}" i=0 current_lines
  while [[ $i -lt 50 ]]; do
    if [[ -n "$selector" ]]; then
      current_lines=$(jq -c "$selector" "$file" 2>/dev/null | wc -l | tr -d ' ')
    else
      current_lines=$(wc -l < "$file" 2>/dev/null | tr -d ' ')
    fi
    [[ "${current_lines:-0}" -gt 0 ]] && break
    sleep 0.1; i=$((i + 1))
  done
}
# The legacy authenticated-session producer, which is what every assertion in this eval is about.
LEGACY_ECON='select(.producer_authority != "flow_run_record")'

# Run a real Stop event against a freshly-established session (agentSpawn
# first, matching real usage — Claude Code always sends SessionStart before
# Stop). Returns the emitted session.usage event (jq-compact, one line).
_run_stop() {
  local input="$1"; shift
  local extra_env_count="$#"
  local extra_env=("$@")
  local common_env=(
    HOME="$FAKE_HOME"
    TELEMETRY_ENABLED=true
    TELEMETRY_CHANNELS=full
    TELEMETRY_CHANNEL_FULL_LOG_FILE="$TMPLOG"
    FLOW_AGENTS_TELEMETRY_FOREGROUND=true
    TELEMETRY_CONFIG_FILE="$TMPDIR_EVAL/telemetry.conf"
    TELEMETRY_DATA_DIR="$TMPDIR_EVAL"
    TELEMETRY_SESSION_DIR="$TMPDIR_EVAL/sessions"
  )

  local before_lines
  touch "$TMPLOG"
  before_lines=$(wc -l < "$TMPLOG" | tr -d ' ')
  echo "$input" | env "${common_env[@]}" bash "$TELEMETRY_SH" agentSpawn dev >/dev/null 2>&1
  _wait_for_line "$before_lines"

  # Give an active Builder binding one non-terminal observation on which to
  # seal its cumulative transcript baseline before the terminal Stop snapshot.
  if [[ "$extra_env_count" -gt 0 ]]; then
    echo "$input" | env "${common_env[@]}" TELEMETRY_USAGE_TRACKING=true "${extra_env[@]}" \
      bash "$TELEMETRY_SH" UserPromptSubmit dev >/dev/null 2>&1
  else
    echo "$input" | env "${common_env[@]}" TELEMETRY_USAGE_TRACKING=true \
      bash "$TELEMETRY_SH" UserPromptSubmit dev >/dev/null 2>&1
  fi

  before_lines=$(wc -l < "$TMPLOG" | tr -d ' ')
  if [[ "$extra_env_count" -gt 0 ]]; then
    echo "$input" | env "${common_env[@]}" TELEMETRY_USAGE_TRACKING=true "${extra_env[@]}" \
      bash "$TELEMETRY_SH" Stop dev 2>/dev/null
  else
    echo "$input" | env "${common_env[@]}" TELEMETRY_USAGE_TRACKING=true \
      bash "$TELEMETRY_SH" Stop dev 2>/dev/null
  fi
  _wait_for_line "$before_lines"

  tail -n +"$((before_lines + 1))" "$TMPLOG" 2>/dev/null | jq -c 'select(.event_type=="session.usage")' | tail -1
}

# --- 1. With transcript + pricing available: real tokens, cost, concrete model
echo "--- Fixture transcript, pricing available ---"
input1=$(jq -nc --arg tp "$FIXTURE_TRANSCRIPT" '{session_id:"pipeline-1",transcript_path:$tp,hook_event_name:"Stop"}')
out1=$(_run_stop "$input1" TELEMETRY_PRICING_FILE="$PRICING_FILE")

if [[ -n "$out1" ]]; then
  model=$(echo "$out1" | jq -r '.usage.model')
  it=$(echo "$out1" | jq -r '.usage.input_tokens')
  ot=$(echo "$out1" | jq -r '.usage.output_tokens')
  cost=$(echo "$out1" | jq -r '.usage.estimated_cost_usd')
  by_model_len=$(echo "$out1" | jq -r '.usage.by_model | length')
  semantics=$(echo "$out1" | jq -r '.usage.semantics // empty')

  [[ "$model" != "unknown" && "$model" != "null" && -n "$model" ]] && _pass "model is concrete (got: $model)" || _fail "model should not be unknown (got: $model)"
  [[ "$model" == "claude-opus-4-8" ]] && _pass "model is the dominant-by-tokens model (claude-opus-4-8)" || _fail "expected dominant model claude-opus-4-8, got $model"
  [[ "$it" != "null" && "$it" -gt 0 ]] && _pass "input_tokens is real and non-null (got: $it)" || _fail "input_tokens should be non-null/positive (got: $it)"
  [[ "$ot" != "null" && "$ot" -gt 0 ]] && _pass "output_tokens is real and non-null (got: $ot)" || _fail "output_tokens should be non-null/positive (got: $ot)"
  cost_positive=$(echo "$out1" | jq -r '(.usage.estimated_cost_usd // 0) > 0')
  [[ "$semantics" == "snapshot" ]] && _pass "session usage declares cumulative snapshot semantics" || _fail "expected usage.semantics=snapshot, got $semantics"
  [[ "$cost" != "null" && "$cost_positive" == "true" ]] && _pass "estimated_cost_usd is real and non-null (got: $cost)" || _fail "estimated_cost_usd should be non-null/positive (got: $cost)"
  [[ "$by_model_len" == "2" ]] && _pass "by_model has 2 entries" || _fail "expected 2 by_model entries, got $by_model_len"
else
  _fail "no session.usage event emitted for fixture transcript"
fi

# --- 1a. Concurrent runtime sessions keep independent lifecycle clocks
echo ""
echo "--- Interleaved runtime sessions keep independent elapsed time ---"
INTERLEAVE_LOG="$TMPDIR_EVAL/interleaved.jsonl"
INTERLEAVE_SESSIONS="$TMPDIR_EVAL/interleaved-sessions"
mkdir -p "$INTERLEAVE_SESSIONS"
: > "$INTERLEAVE_LOG"
interleave_env=(
  HOME="$FAKE_HOME"
  TELEMETRY_ENABLED=true
  TELEMETRY_CHANNELS=full
  TELEMETRY_CHANNEL_FULL_LOG_FILE="$INTERLEAVE_LOG"
  FLOW_AGENTS_TELEMETRY_FOREGROUND=true
  FLOW_AGENTS_TELEMETRY_RUNTIME=claude-code
  TELEMETRY_CONFIG_FILE="$TMPDIR_EVAL/telemetry.conf"
  TELEMETRY_DATA_DIR="$TMPDIR_EVAL"
  TELEMETRY_SESSION_DIR="$INTERLEAVE_SESSIONS"
  TELEMETRY_USAGE_TRACKING=true
  TELEMETRY_PRICING_FILE="$PRICING_FILE"
)
clock_a=$(jq -nc --arg tp "$FIXTURE_TRANSCRIPT" '{session_id:"clock-a",transcript_path:$tp,hook_event_name:"SessionStart"}')
clock_b=$(jq -nc --arg tp "$FIXTURE_TRANSCRIPT" '{session_id:"clock-b",transcript_path:$tp,hook_event_name:"SessionStart"}')
printf '%s' "$clock_a" | env "${interleave_env[@]}" bash "$TELEMETRY_SH" agentSpawn dev >/dev/null
printf '%s' "$clock_b" | env "${interleave_env[@]}" bash "$TELEMETRY_SH" agentSpawn dev >/dev/null
clock_a_file=""
clock_b_file=""
for file in "$INTERLEAVE_SESSIONS"/*.session; do
  case "$(jq -r '.runtime_session_id // ""' "$file")" in
    clock-a) clock_a_file="$file" ;;
    clock-b) clock_b_file="$file" ;;
  esac
done
now_epoch=$(date +%s)
jq --argjson start "$((now_epoch - 120))" '.start_time = $start' "$clock_a_file" > "$clock_a_file.tmp" && mv "$clock_a_file.tmp" "$clock_a_file"
jq --argjson start "$((now_epoch - 5))" '.start_time = $start' "$clock_b_file" > "$clock_b_file.tmp" && mv "$clock_b_file.tmp" "$clock_b_file"
printf '%s' "$clock_a" | env "${interleave_env[@]}" bash "$TELEMETRY_SH" Stop dev >/dev/null
clock_a_usage=$(jq -c 'select(.event_type == "session.usage" and .hook.runtime_session_id == "clock-a")' "$INTERLEAVE_LOG" | tail -1)
clock_a_duration=$(printf '%s' "$clock_a_usage" | jq -r '.usage.duration_s // 0')
clock_a_session_duration=$(jq -r '.duration_s // 0' "$clock_a_file")
clock_b_ended=$(jq -r 'has("end_time")' "$clock_b_file")
if [[ "$clock_a_duration" -ge 110 && "$clock_a_session_duration" -ge 110 && "$clock_b_ended" == "false" ]]; then
  _pass "interleaved Stop uses the exact runtime session clock"
else
  _fail "runtime clocks crossed (usage=$clock_a_duration session=$clock_a_session_duration clock_b_ended=$clock_b_ended)"
fi

# --- 1b. Authenticated economics/outcome attribution ignores competing shared current
echo ""
echo "--- Economics and workflow outcome use authenticated correlation, never shared current ---"
ATTR_CWD="${TMPDIR_EVAL}/workspace"
CANON_SLUG="canonical-task"
LEGACY_SLUG="legacy-task"
ECON_LOG="${TMPDIR_EVAL}/economics.jsonl"
ECON_RELAY_LOG="${TMPDIR_EVAL}/economics-relay.jsonl"
ECON_FAKE_BIN="${TMPDIR_EVAL}/fake-curl-bin"
ATTR_ROOT="$ATTR_CWD/.kontourai/flow-agents"
mkdir -p "$ATTR_ROOT/$CANON_SLUG" "$ATTR_ROOT/$LEGACY_SLUG" "$ECON_FAKE_BIN"
: > "$ECON_LOG"
: > "$ECON_RELAY_LOG"
cat > "$ECON_FAKE_BIN/curl" <<'SH'
#!/usr/bin/env bash
config=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) config="$2"; shift 2 ;;
    *) shift ;;
  esac
done
body_file="$(sed -n 's/^data-binary = "@\(.*\)"$/\1/p' "$config" | head -1)"
[[ -n "$body_file" && -f "$body_file" ]] || exit 2
cat "$body_file" >> "$TELEMETRY_RELAY_CAPTURE"
printf '\n' >> "$TELEMETRY_RELAY_CAPTURE"
SH
chmod +x "$ECON_FAKE_BIN/curl"
ATTR_CORRELATION="$(FLOW_AGENTS_ACTOR=runtime-a node - "$ROOT_DIR" "$ATTR_CWD" "$CANON_SLUG" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
(async () => {
  const [root, workspace, slug] = process.argv.slice(2);
  const runtime = await import(pathToFileURL(path.join(root, "build/src/builder-flow-runtime.js")).href);
  const assignment = await import(pathToFileURL(path.join(root, "build/src/cli/assignment-provider.js")).href);
  const flow = await import("@kontourai/flow");
  const artifactRoot = path.join(workspace, ".kontourai", "flow-agents");
  const sessionDir = path.join(artifactRoot, slug);
  const subject = `local:work-item/${slug}`;
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(workspace, "package.json"), '{"name":"telemetry-usage-pipeline","private":true}\n');
  fs.writeFileSync(path.join(sessionDir, "state.json"), `${JSON.stringify({
    schema_version: "1.0",
    task_slug: slug,
    status: "planned",
    phase: "planning",
    updated_at: new Date().toISOString(),
    work_item_refs: [subject],
    next_action: { status: "continue", summary: "Start telemetry attribution fixture." },
  }, null, 2)}\n`);
  const actor = assignment.resolveCurrentAssignmentActor();
  assignment.performLocalClaim(artifactRoot, slug, actor.actor, {
    ttlSeconds: 1800,
    actorKey: actor.actorKey,
    branch: `fixture/${slug}`,
    artifactDir: slug,
    workItemRef: subject,
    reason: "telemetry attribution fixture",
  });
  const started = await runtime.startBuilderFlowSession({ sessionDir });
  await flow.pauseRun(slug, {
    cwd: workspace,
    reason: "exercise a non-terminal blocked process outcome",
    authority: {
      kind: "operator_request",
      actor: "fixture",
      request_ref: "fixture://telemetry-pause",
      requested_at: "2026-07-24T15:00:00.000Z",
    },
    at: "2026-07-24T15:00:00.000Z",
  });
  await runtime.syncBuilderFlowSession({ sessionDir });
  process.stdout.write(JSON.stringify(started.run.correlation.envelope));
})().catch((error) => { console.error(error); process.exit(1); });
NODE
)"
printf '%s\n' '{"schema_version":"1.0","task_slug":"legacy-task","phase":"wrong","verification_verdict":"PASS","flow_run":{"run_id":"legacy-task","status":"completed"}}' > "$ATTR_ROOT/$LEGACY_SLUG/state.json"
printf '%s\n' '{"gate_fires":99,"verification_verdict":"PASS"}' > "$ATTR_ROOT/$LEGACY_SLUG/critique.json"
ln -s "../$LEGACY_SLUG/critique.json" "$ATTR_ROOT/$CANON_SLUG/critique.json"
printf '%s\n' "{\"active_slug\":\"$LEGACY_SLUG\",\"artifact_dir\":\"$LEGACY_SLUG\"}" > "$ATTR_ROOT/current.json"
ATTR_PHASE="$(jq -r '.phase' "$ATTR_ROOT/$CANON_SLUG/state.json")"
input_attr=$(jq -nc --arg tp "$FIXTURE_TRANSCRIPT" --arg cwd "$ATTR_CWD" '{session_id:"pipeline-attribution",transcript_path:$tp,hook_event_name:"Stop",cwd:$cwd}')
TELEMETRY_SH_SAVED="$TELEMETRY_SH"
TELEMETRY_SH="$ROOT_DIR/scripts/telemetry/telemetry.sh"
out_attr=$(_run_stop "$input_attr" \
  FLOW_AGENTS_ACTOR=runtime-a \
  TELEMETRY_PRICING_FILE="$PRICING_FILE" \
  TELEMETRY_ECONOMICS_LOG_FILE="$ECON_LOG" \
  FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY=1 \
  FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL=http://127.0.0.1:43119/records \
  CONSOLE_TELEMETRY_TOKEN=fixture-token \
  TELEMETRY_RELAY_CAPTURE="$ECON_RELAY_LOG" \
  PATH="$ECON_FAKE_BIN:$PATH")
TELEMETRY_SH="$TELEMETRY_SH_SAVED"
_wait_for_file_line "$ECON_LOG" "$LEGACY_ECON"

if [[ -n "$out_attr" && -s "$ECON_LOG" ]]; then
  attr_task=$(jq -c "$LEGACY_ECON" "$ECON_LOG" | tail -1 | jq -r '.task_slug')
  attr_phase=$(jq -c "$LEGACY_ECON" "$ECON_LOG" | tail -1 | jq -r '.phases[0].phase')
  attr_gate_fires=$(jq -c "$LEGACY_ECON" "$ECON_LOG" | tail -1 | jq -r '.defects.gate_fires')
  attr_correlation=$(jq -c "$LEGACY_ECON" "$ECON_LOG" | tail -1 | jq -r '.run_correlation.correlation_id')
  [[ "$attr_task" == "$CANON_SLUG" ]] && _pass "economics task_slug comes from authenticated actor binding" || _fail "expected authenticated task_slug '$CANON_SLUG', got '$attr_task'"
  [[ "$attr_phase" == "$ATTR_PHASE" && "$attr_phase" != "wrong" ]] && _pass "economics sidecars come from the correlated state, not competing shared current" || _fail "expected correlated phase '$ATTR_PHASE', got '$attr_phase'"
  [[ "$attr_gate_fires" == "0" ]] && _pass "economics snapshot rejects a symlinked critique instead of following foreign sidecar content" || _fail "symlinked critique leaked gate_fires=$attr_gate_fires"
  [[ "$attr_correlation" == "$(printf '%s' "$ATTR_CORRELATION" | jq -r '.correlation_id')" ]] && _pass "economics record preserves the authenticated correlation" || _fail "expected authenticated correlation, got '$attr_correlation'"
  outcome_record=$(jq -c 'select(.event_type=="workflow.outcome")' "$TMPLOG" | tail -1)
  outcome_correlation=$(printf '%s' "$outcome_record" | jq -r '.run_correlation.correlation_id')
  outcome_status=$(printf '%s' "$outcome_record" | jq -r '.workflow_outcome.process_status')
  outcome_quality=$(printf '%s' "$outcome_record" | jq -r '.workflow_outcome.quality_status')
  [[ "$outcome_correlation" == "$(printf '%s' "$ATTR_CORRELATION" | jq -r '.correlation_id')" ]] && _pass "workflow outcome preserves the same correlation" || _fail "workflow outcome correlation mismatch: '$outcome_correlation'"
  [[ "$outcome_status" == "blocked" ]] && _pass "workflow outcome distinguishes blocked process state" || _fail "expected blocked process status, got '$outcome_status'"
  [[ "$outcome_quality" == "not_independently_evaluated" ]] && _pass "workflow outcome does not impersonate independent task quality" || _fail "workflow outcome quality boundary missing: '$outcome_quality'"
  sleep 1
  [[ ! -s "$ECON_RELAY_LOG" ]] && _pass "non-terminal cumulative snapshot stays local" || _fail "non-terminal cumulative snapshot was relayed"
else
  _fail "authenticated economics/outcome records were not emitted"
fi

# A canonical terminal projection retires the actor pointer before the runtime's
# Stop hook necessarily runs. The terminal-only handoff must preserve the exact
# generation without making that retired binding visible to ordinary events.
echo ""
echo "--- Terminal Stop consumes the exact retired actor generation ---"
FLOW_AGENTS_ACTOR=runtime-a node - "$ROOT_DIR" "$ATTR_CWD" "$CANON_SLUG" <<'NODE'
const path = require("node:path");
const { pathToFileURL } = require("node:url");
(async () => {
  const [root, workspace, slug] = process.argv.slice(2);
  const runtime = await import(pathToFileURL(path.join(root, "build/src/builder-flow-runtime.js")).href);
  const flow = await import("@kontourai/flow");
  await flow.cancelRun(slug, {
    cwd: workspace,
    reason: "exercise terminal telemetry handoff",
    authority: {
      kind: "operator_request",
      actor: "fixture",
      request_ref: "fixture://telemetry-cancel",
      requested_at: "2026-07-24T15:01:00.000Z",
    },
    at: "2026-07-24T15:01:00.000Z",
  });
  await runtime.syncBuilderFlowSession({
    sessionDir: path.join(workspace, ".kontourai", "flow-agents", slug),
  });
})().catch((error) => { console.error(error); process.exit(1); });
NODE
: > "$ECON_LOG"
input_terminal=$(jq -nc --arg tp "$FIXTURE_TRANSCRIPT" --arg cwd "$ATTR_CWD" '{session_id:"pipeline-terminal",transcript_path:$tp,hook_event_name:"Stop",cwd:$cwd}')
TELEMETRY_SH_SAVED="$TELEMETRY_SH"
TELEMETRY_SH="$ROOT_DIR/scripts/telemetry/telemetry.sh"
out_terminal=$(_run_stop "$input_terminal" \
  FLOW_AGENTS_ACTOR=runtime-a \
  TELEMETRY_PRICING_FILE="$PRICING_FILE" \
  TELEMETRY_ECONOMICS_LOG_FILE="$ECON_LOG" \
  FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY=1 \
  FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL=http://127.0.0.1:43119/records \
  CONSOLE_TELEMETRY_TOKEN=fixture-token \
  TELEMETRY_RELAY_CAPTURE="$ECON_RELAY_LOG" \
  PATH="$ECON_FAKE_BIN:$PATH")
TELEMETRY_SH="$TELEMETRY_SH_SAVED"
_wait_for_file_line "$ECON_LOG" "$LEGACY_ECON"
terminal_usage_correlation=$(printf '%s' "$out_terminal" | jq -r '.run_correlation.correlation_id')
terminal_usage_scope=$(printf '%s' "$out_terminal" | jq -r '.usage.scope')
terminal_baseline_status=$(printf '%s' "$out_terminal" | jq -r '.usage.baseline_status')
terminal_econ_correlation=$(jq -c "$LEGACY_ECON" "$ECON_LOG" | tail -1 | jq -r '.run_correlation.correlation_id')
terminal_outcome=$(jq -c 'select(.event_type=="workflow.outcome" and .workflow_outcome.process_status=="canceled")' "$TMPLOG" | tail -1)
terminal_outcome_correlation=$(printf '%s' "$terminal_outcome" | jq -r '.run_correlation.correlation_id')
_wait_for_file_line "$ECON_RELAY_LOG"
terminal_relay_run_id=$(tail -1 "$ECON_RELAY_LOG" | jq -r '.run_id')
terminal_relay_authority=$(tail -1 "$ECON_RELAY_LOG" | jq -r '.producer_authority')
ATTR_CORRELATION_ID="$(printf '%s' "$ATTR_CORRELATION" | jq -r '.correlation_id')"
[[ "$terminal_usage_correlation" == "$ATTR_CORRELATION_ID" ]] && _pass "terminal usage consumes the retired binding's exact generation" || _fail "terminal usage correlation mismatch: '$terminal_usage_correlation'"
[[ "$terminal_usage_scope" == "run" && "$terminal_baseline_status" == "present" ]] && _pass "terminal usage is run-scoped only after a sealed baseline" || _fail "terminal usage scope/baseline mismatch: '$terminal_usage_scope'/'$terminal_baseline_status'"
[[ "$terminal_econ_correlation" == "$ATTR_CORRELATION_ID" ]] && _pass "terminal economics preserves the retired binding's exact generation" || _fail "terminal economics correlation mismatch: '$terminal_econ_correlation'"
[[ "$terminal_outcome_correlation" == "$ATTR_CORRELATION_ID" ]] && _pass "terminal workflow outcome preserves the retired binding's exact generation" || _fail "terminal workflow outcome correlation mismatch: '$terminal_outcome_correlation'"
[[ "$terminal_relay_run_id" == "$ATTR_CORRELATION_ID" ]] && _pass "terminal economics relay uses correlation as immutable run id" || _fail "terminal economics relay run id mismatch: '$terminal_relay_run_id'"
[[ "$terminal_relay_authority" == "authenticated_runtime_binding" ]] && _pass "terminal economics relay discloses authenticated runtime authority" || _fail "terminal economics authority mismatch: '$terminal_relay_authority'"

# --- 2. Pricing forced unavailable: tokens survive, cost is null ------------
echo ""
echo "--- Fixture transcript, pricing forced unavailable ---"
input2=$(jq -nc --arg tp "$FIXTURE_TRANSCRIPT" '{session_id:"pipeline-2",transcript_path:$tp,hook_event_name:"Stop"}')
out2=$(_run_stop "$input2" TELEMETRY_PRICING_FILE=/nonexistent/pricing.json TELEMETRY_PRICING_URL="" FLOW_AGENTS_PRICING_FILE="" FLOW_AGENTS_PRICING_URL="")

if [[ -n "$out2" ]]; then
  it2=$(echo "$out2" | jq -r '.usage.input_tokens')
  ot2=$(echo "$out2" | jq -r '.usage.output_tokens')
  cost2=$(echo "$out2" | jq -r '.usage.estimated_cost_usd')
  pv2=$(echo "$out2" | jq -r '.usage.pricing_version')
  model2=$(echo "$out2" | jq -r '.usage.model')

  [[ "$it2" != "null" && "$it2" -gt 0 ]] && _pass "tokens survive when pricing unavailable (input_tokens=$it2)" || _fail "tokens should survive when pricing unavailable (got input_tokens=$it2)"
  [[ "$ot2" != "null" && "$ot2" -gt 0 ]] && _pass "output_tokens survive when pricing unavailable (got: $ot2)" || _fail "output_tokens should survive when pricing unavailable (got: $ot2)"
  [[ "$cost2" == "null" ]] && _pass "estimated_cost_usd is null when pricing unavailable (cost degrades, tokens don't)" || _fail "estimated_cost_usd should be null when pricing unavailable (got: $cost2)"
  [[ "$pv2" == "null" ]] && _pass "pricing_version is null when pricing unavailable" || _fail "pricing_version should be null when pricing unavailable (got: $pv2)"
  [[ "$model2" == "claude-opus-4-8" ]] && _pass "model still resolves from transcript when pricing unavailable" || _fail "expected model claude-opus-4-8, got $model2"
else
  _fail "no session.usage event emitted when pricing forced unavailable"
fi

# --- 3. No transcript (kiro-cli style): model still resolves via kiro fallback, no regression
echo ""
echo "--- No transcript (kiro-cli non-regression) ---"
input3='{"session_id":"pipeline-3","hook_event_name":"Stop"}'
out3=$(_run_stop "$input3")

if [[ -n "$out3" ]]; then
  model3=$(echo "$out3" | jq -r '.usage.model')
  it3=$(echo "$out3" | jq -r '.usage.input_tokens')
  by_model3=$(echo "$out3" | jq -r '.usage.by_model')

  # FAKE_HOME has no ~/.kiro/agents spec, so usage_get_model's kiro lookup
  # falls through to "unknown" — this is the pre-existing, unfixed kiro path
  # and must be untouched by the transcript-model override (transcript_usage
  # is null here, so model is never overridden).
  [[ "$model3" == "unknown" ]] && _pass "no-transcript path still resolves via usage_get_model kiro fallback (unknown, no regression)" || _fail "expected kiro fallback 'unknown' with no transcript, got $model3"
  [[ "$it3" == "null" ]] && _pass "input_tokens is null with no transcript (expected)" || _fail "expected null input_tokens with no transcript, got $it3"
  [[ "$by_model3" == "null" ]] && _pass "by_model is null with no transcript (expected)" || _fail "expected null by_model with no transcript, got $by_model3"
else
  _fail "no session.usage event emitted for no-transcript case"
fi

# --- 4. Empty transcript + TELEMETRY_USAGE_DEBUG=1: debug reason is emitted -
echo ""
echo "--- Empty transcript, TELEMETRY_USAGE_DEBUG=1 (debug path) ---"
EMPTY_TRANSCRIPT="${TMPDIR_EVAL}/empty-transcript.jsonl"
: > "$EMPTY_TRANSCRIPT"
DEBUG_DRIFT_LOG="${TMPDIR_EVAL}/debug-drift.log"
input4=$(jq -nc --arg tp "$EMPTY_TRANSCRIPT" '{session_id:"pipeline-4",transcript_path:$tp,hook_event_name:"Stop"}')
out4=$(_run_stop "$input4" TELEMETRY_USAGE_DEBUG=1 TELEMETRY_DRIFT_LOG="$DEBUG_DRIFT_LOG")

if grep -q '\[telemetry\] usage_parse_transcript:' "$DEBUG_DRIFT_LOG" 2>/dev/null; then
  _pass "debug reason line emitted for empty-transcript no-usage scenario"
else
  _fail "expected a usage_parse_transcript debug reason line in $DEBUG_DRIFT_LOG"
fi

model4=$(echo "$out4" | jq -r '.usage.model // "unknown"' 2>/dev/null)
[[ -z "$out4" || "$model4" == "unknown" ]] && _pass "empty-transcript path emits no real usage (no regression)" || _fail "expected no/unknown usage for empty transcript, got model=$model4"

rm -rf "$TMPDIR_EVAL"

echo ""
echo "Telemetry usage pipeline: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
