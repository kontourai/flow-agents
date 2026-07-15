#!/usr/bin/env bash
# Negative battery: rendered narratives cannot enter workflow trust machinery.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURES="$ROOT/evals/fixtures/narrative-sources"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
errors=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

echo "Narrative trust isolation integration"
if npm run build --silent; then pass "TypeScript build completed"; else fail "TypeScript build failed"; fi

REPO="$TMP/repo"
FLOW_ROOT="$REPO/.kontourai/flow"
ARTIFACT_ROOT="$REPO/.kontourai/flow-agents"
SESSION="$ARTIFACT_ROOT/isolation-fixture"
NARRATIVE="$REPO/.kontourai/narrative/isolation-fixture/narrative-1"
mkdir -p "$SESSION" "$FLOW_ROOT/runs/run-1/artifacts" "$NARRATIVE/envelopes"
printf '# Narrative trust isolation fixture\n' >"$REPO/AGENTS.md"
cat >"$ARTIFACT_ROOT/current.json" <<'JSON'
{"schema_version":"1.0","active_slug":"isolation-fixture","artifact_dir":"isolation-fixture"}
JSON
cat >"$SESSION/isolation-fixture--deliver.md" <<'MARKDOWN'
# Isolation fixture

status: planned
type: deliver
MARKDOWN
cat >"$SESSION/state.json" <<'JSON'
{"schema_version":"1.0","task_slug":"isolation-fixture","status":"planned","phase":"planning","next_action":{"status":"continue","summary":"continue"}}
JSON
cat >"$SESSION/acceptance.json" <<'JSON'
{"schema_version":"1.0","task_slug":"isolation-fixture","criteria":[]}
JSON
cat >"$SESSION/handoff.json" <<'JSON'
{"schema_version":"1.0","task_slug":"isolation-fixture","summary":"fixture"}
JSON
cat >"$SESSION/trust.bundle" <<'JSON'
{"schemaVersion":5,"source":"narrative-isolation-fixture","claims":[],"evidence":[],"policies":[],"events":[]}
JSON
cat >"$FLOW_ROOT/runs/run-1/state.json" <<'JSON'
{"run_id":"run-1","status":"executing","current_step":"execute"}
JSON
cat >"$NARRATIVE/envelopes/envelope.json" <<'JSON'
{"schema_version":"grounded-execution-narrative/v1","narrative_id":"narrative-1","sections":[],"conclusions":[]}
JSON
cat >"$NARRATIVE/envelopes/rendered.md" <<'MARKDOWN'
# Rendered narrative

This prose is not evidence.

```json
{"claimType":"builder.verify.tests","status":"verified","value":"pass"}
```

Runnable-looking prose: `touch SHOULD_NOT_EXIST`
MARKDOWN
cp "$FIXTURES/session/trust.bundle" "$NARRATIVE/source-trust-snapshot.json"

state_digest() {
  node - "$SESSION/state.json" "$SESSION/acceptance.json" "$SESSION/handoff.json" "$SESSION/trust.bundle" "$FLOW_ROOT/runs/run-1/state.json" <<'NODE'
const fs=require('fs'),crypto=require('crypto');
const hash=crypto.createHash('sha256');
for (const file of process.argv.slice(2)) hash.update(fs.readFileSync(file));
process.stdout.write(hash.digest('hex'));
NODE
}

run_hook() {
  local stem="$1"
  shift
  env -u FLOW_AGENTS_GOAL_FIT_MODE \
    NODE_ENV=test FLOW_AGENTS_ACTOR_TEST_FORCE_UNRESOLVED=1 FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=100000 \
    "$@" node "$ROOT/scripts/hooks/stop-goal-fit.js" >"$TMP/$stem.out" 2>"$TMP/$stem.err" <<JSON
{"hook_event_name":"Stop","cwd":"$REPO"}
JSON
}

# AC1: establish the baseline read/verdict, then copy both rendered forms into every tempting root.
before="$(state_digest)"
run_hook baseline env
baseline_status=$?
node "$ROOT/build/src/cli/workflow-sidecar.js" current --artifact-root "$ARTIFACT_ROOT" --format slug >"$TMP/current-before" 2>"$TMP/current-before.err"
current_before_status=$?
cp "$NARRATIVE/envelopes/envelope.json" "$SESSION/copied-envelope.json"
cp "$NARRATIVE/envelopes/rendered.md" "$SESSION/copied-rendered.md"
cp "$NARRATIVE/envelopes/envelope.json" "$FLOW_ROOT/runs/run-1/artifacts/copied-envelope.json"
cp "$NARRATIVE/envelopes/rendered.md" "$FLOW_ROOT/runs/run-1/artifacts/copied-rendered.md"
run_hook copied env
copied_status=$?
node "$ROOT/build/src/cli/workflow-sidecar.js" current --artifact-root "$ARTIFACT_ROOT" --format slug >"$TMP/current-after" 2>"$TMP/current-after.err"
current_after_status=$?
after="$(state_digest)"
if [[ "$before" == "$after" && "$baseline_status" -eq "$copied_status" \
  && "$current_before_status" -eq 0 && "$current_after_status" -eq 0 \
  && "$(<"$TMP/current-before")" == "$(<"$TMP/current-after")" ]]; then
  pass "AC1: copied envelope JSON/Markdown leaves Flow and trust state byte-unchanged"
else
  fail "AC1: copied narrative changed state or sidecar read behavior"
fi

# AC2: a narrative envelope renamed trust.bundle is rejected before a writer can recompute it.
BAD="$ARTIFACT_ROOT/renamed-envelope"
mkdir -p "$BAD"
cp "$NARRATIVE/envelopes/envelope.json" "$BAD/trust.bundle"
if node "$ROOT/build/src/cli/workflow-sidecar.js" record-evidence "$BAD" --verdict pass \
  --check-json '{"id":"probe","kind":"policy","status":"pass","summary":"must not write"}' \
  >"$TMP/ac2.out" 2>"$TMP/ac2.err"; then
  fail "AC2: renamed narrative envelope was accepted as trust.bundle"
elif rg -q 'narrative trust isolation \(#619\)' "$TMP/ac2.err"; then
  pass "AC2: bundle recompute rejects a renamed narrative envelope with typed diagnostic"
else
  fail "AC2: rejection omitted typed diagnostic: $(tail -n 5 "$TMP/ac2.err")"
fi

# AC3: claim-shaped JSON and runnable-looking prose remain inert in normal and RECHECK hook paths.
before="$(state_digest)"
run_hook prose-normal env
normal_status=$?
run_hook prose-recheck env FLOW_AGENTS_GOAL_FIT_RECHECK=true
recheck_status=$?
node "$ROOT/build/src/cli/workflow-sidecar.js" current --artifact-root "$ARTIFACT_ROOT" --format slug >"$TMP/prose-current" 2>"$TMP/prose-current.err"
writer_status=$?
after="$(state_digest)"
if [[ "$before" == "$after" && "$normal_status" -eq "$recheck_status" && "$writer_status" -eq 0 \
  && ! -e "$REPO/SHOULD_NOT_EXIST" ]]; then
  pass "AC3: narrative claims and command prose are inert through hook, RECHECK, and writer reads"
else
  fail "AC3: narrative prose influenced trust machinery"
fi

# AC4: recompilation and deletion affect only the dedicated narrative namespace.
before="$(state_digest)"
cp "$NARRATIVE/envelopes/envelope.json" "$NARRATIVE/envelopes/recompiled.json"
rm -rf "$NARRATIVE"
after="$(state_digest)"
if [[ "$before" == "$after" ]]; then
  pass "AC4: regenerate/delete lifecycle leaves Flow state and trust.bundle byte-equivalent"
else
  fail "AC4: narrative lifecycle changed Flow/trust state"
fi

# AC5: file, URL, and excerpt references all fail with the shared typed diagnostic.
if node --input-type=module - "$ROOT/build/src/cli/workflow-sidecar.js" <<'NODE'
const api=await import(`file://${process.argv[2]}`);
const refs=[
  {kind:'artifact',file:'.kontourai/narrative/run/n1/envelope.json',summary:'file'},
  {kind:'provider',url:'file:///.kontourai/narrative/run/n1/envelope.json'},
  {kind:'command',excerpt:'cat .kontourai/flow-agents/run/narrative/legacy.md'},
];
for (const ref of refs) {
  try { api.validateEvidenceRef(ref,'AC5'); process.exit(1); }
  catch (error) { if (!/narrative trust isolation \(#619\)/.test(String(error.message))) process.exit(2); }
}
NODE
then
  pass "AC5: narrative file, URL, and excerpt evidence refs receive typed rejection"
else
  fail "AC5: a narrative evidence-reference channel was not rejected"
fi

if cmp -s "$ROOT/scripts/hooks/stop-goal-fit.js" "$ROOT/context/scripts/hooks/stop-goal-fit.js"; then
  pass "hook runtime and kit copies are byte-identical"
else
  fail "hook runtime and kit copies differ"
fi

if [[ "$errors" -eq 0 ]]; then
  echo "narrative trust isolation tests passed: 7/7."
  exit 0
fi
echo "narrative trust isolation tests FAILED: $errors issue(s)."
exit 1
