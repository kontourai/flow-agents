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
{"schema_version":"grounded-execution-narrative/v1","narrative_id":"narrative-1","content_canary":"NARRATIVE_CONTENT_MUST_NOT_ENTER_TRUST_BUNDLE","sections":[],"conclusions":[]}
JSON
cat >"$NARRATIVE/envelopes/rendered.md" <<'MARKDOWN'
# Grounded Execution Narrative

## Authority provenance

- Narrative composer: flow-agents-narrative-composer 3.12.1.

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
if node "$ROOT/build/src/cli/workflow-sidecar.js" record-evidence "$SESSION" --verdict pass \
  --check-json '{"id":"copied-narrative","kind":"policy","status":"pass","summary":"must reject","artifact_refs":[{"kind":"artifact","file":".kontourai/flow-agents/isolation-fixture/copied-envelope.json","summary":"copied narrative"}]}' \
  >"$TMP/ac1-record.out" 2>"$TMP/ac1-record.err"; then
  ac1_record_status=0
else
  ac1_record_status=$?
fi
run_hook copied env
copied_status=$?
node "$ROOT/build/src/cli/workflow-sidecar.js" current --artifact-root "$ARTIFACT_ROOT" --format slug >"$TMP/current-after" 2>"$TMP/current-after.err"
current_after_status=$?
after="$(state_digest)"
if [[ "$before" == "$after" && "$baseline_status" -eq "$copied_status" \
  && "$current_before_status" -eq 0 && "$current_after_status" -eq 0 \
  && "$ac1_record_status" -ne 0 && $(rg -c 'narrative trust isolation \(#619\)' "$TMP/ac1-record.err") -gt 0 \
  && "$(<"$TMP/current-before")" == "$(<"$TMP/current-after")" ]]; then
  pass "AC1: writer rejects copied envelope evidence and leaves Flow/trust state byte-unchanged"
else
  fail "AC1: copied narrative changed state or sidecar read behavior"
fi

# #622: an at-action agent_stated intent annotation is narrative-kind self-report
# and can NEVER be cited as trust/gate evidence. A planted annotation content
# canary must be rejected as evidence AND never appear in trust.bundle.
INTENT_CANARY="INTENT_ANNOTATION_MUST_NOT_ENTER_TRUST_BUNDLE"
cat >"$NARRATIVE/intent-annotation.json" <<JSON
{"schema_version":"1.0","mode":"agent_stated","captured_at":"2026-07-15T00:00:00.000Z","runtime":"claude-code","action_ref":"fa1:file:action.json:$(printf 'a%.0s' {1..64})","statement":{"id":"0123456789abcdef","class":"agent_stated","proposition":"Agent stated the purpose of this action is to $INTENT_CANARY","source_refs":["fa1:file:action.json:$(printf 'a%.0s' {1..64})"],"actor":"codex","self_report":true},"redactions":[]}
JSON
if node "$ROOT/build/src/cli/workflow-sidecar.js" record-evidence "$SESSION" --verdict pass \
  --check-json '{"id":"intent-annotation","kind":"policy","status":"pass","summary":"must reject","artifact_refs":[{"kind":"artifact","file":".kontourai/narrative/isolation-fixture/narrative-1/intent-annotation.json","summary":"intent annotation"}]}' \
  >"$TMP/intent.out" 2>"$TMP/intent.err"; then
  fail "#622: intent annotation accepted as trust evidence"
elif rg -q 'narrative trust isolation \(#619\)' "$TMP/intent.err" && ! rg -q "$INTENT_CANARY" "$SESSION/trust.bundle"; then
  pass "#622: intent annotation rejected as trust evidence and canary absent from trust.bundle"
else
  fail "#622: intent annotation isolation failed: $(tail -n 3 "$TMP/intent.err")"
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

# AC5/H1/M3: all 5 evidence kinds x all 3 free-form channels, aliases, and positive source control.
mkdir -p "$REPO/evidence" "$REPO/src/narrative"
cp "$NARRATIVE/envelopes/envelope.json" "$REPO/evidence/relocated-output.json"
ln "$NARRATIVE/envelopes/envelope.json" "$REPO/evidence/hardlink-output.json"
ln -s "$NARRATIVE/envelopes/envelope.json" "$REPO/evidence/symlink-output.json"
ln -s "$NARRATIVE/envelopes/rendered.md" "$REPO/evidence/narrative-symlink.sh"
printf 'export const sourceOnly = true;\n' >"$REPO/src/narrative/source-only.ts"
ln -s "$ROOT/kits" "$REPO/kits"
if node --input-type=module - "$ROOT/build/src/cli/workflow-sidecar.js" "$REPO" <<'NODE'
const api=await import(`file://${process.argv[2]}`);
const root=process.argv[3];
const kinds=['source','artifact','command','provider','external'];
const fields=['file','url','excerpt'];
for (const kind of kinds) for (const field of fields) {
  const ref={kind,[field]:'.kontourai/narrative/isolation-fixture/narrative-1/envelopes/envelope.json'};
  if (kind==='source') Object.assign(ref,{line_start:1,line_end:1,excerpt:field==='excerpt'?ref.excerpt:'source'});
  if (kind==='artifact') ref.summary='artifact';
  try { api.validateEvidenceRef(ref,'AC5'); process.exit(1); }
  catch (error) { if (!/narrative trust isolation \(#619\)/.test(String(error.message))) process.exit(2); }
}
const aliases=[
  {kind:'artifact',file:'.KONTOURAI/NARRATIVE/isolation-fixture/narrative-1/envelopes/envelope.json',summary:'case'},
  {kind:'provider',url:'file%3A%2F%2F%2F.KONTOURAI%2FNARRATIVE%2Fisolation-fixture%2Fnarrative-1%2Fenvelopes%2Fenvelope.json'},
  {kind:'artifact',file:'evidence/symlink-output.json',summary:'symlink'},
  {kind:'artifact',file:'evidence/hardlink-output.json',summary:'hardlink'},
  {kind:'artifact',file:'evidence/relocated-output.json',summary:'relocated'},
];
for (const ref of aliases) {
  try { api.validateEvidenceRef(ref,'AC5 alias',root); process.exit(3); }
  catch (error) { if (!/narrative trust isolation \(#619\)/.test(String(error.message))) process.exit(4); }
}
for (const check of [
  {id:'standard-ref',kind:'test',status:'pass',summary:'must reject',standard_refs:[{standard:'junit',ref:'.kontourai/narrative/run/n1/envelope.json'}]},
  {id:'surface-ref',kind:'policy',status:'pass',summary:'must reject',surface_trust_refs:[{artifact_kind:'trust.bundle',artifact_ref:'.kontourai/narrative/run/n1/envelope.json',claim_status:'accepted',freshness:{status:'fresh'},authority:{producer:'surface-local'},integrity:{status:'matched'},status:'pass',summary:'accepted'}]},
]) {
  try { api.normalizeCheck(check,false,undefined,root); process.exit(5); }
  catch (error) { if (!/narrative trust isolation \(#619\)/.test(String(error.message))) process.exit(6); }
}
api.validateEvidenceRef({kind:'source',file:'src/narrative/source-only.ts',line_start:1,line_end:1,excerpt:'source code'},'positive source',root);
NODE
then
  pass "AC5: all evidence forms, aliases, standard refs, and surface refs reject; source code remains valid"
else
  fail "AC5: a narrative evidence-reference channel was not rejected"
fi

if node "$ROOT/build/src/cli/workflow-sidecar.js" record-evidence "$SESSION" --verdict pass \
  --check-json '{"id":"standard-ref","kind":"test","status":"pass","summary":"must reject","standard_refs":[{"standard":"junit","ref":".kontourai/narrative/run/n1/envelope.json"}]}' \
  >"$TMP/residual-standard.out" 2>"$TMP/residual-standard.err"; then
  fail "residual 2: writer accepted narrative standard_refs[].ref"
elif ! rg -q 'narrative trust isolation \(#619\)' "$TMP/residual-standard.err"; then
  fail "residual 2: standard_refs rejection omitted typed diagnostic"
elif node "$ROOT/build/src/cli/workflow-sidecar.js" record-evidence "$SESSION" --verdict pass \
  --check-json '{"id":"surface-ref","kind":"policy","status":"pass","summary":"must reject","surface_trust_refs":[{"artifact_kind":"trust.bundle","artifact_ref":".kontourai/narrative/run/n1/envelope.json","claim_status":"accepted","freshness":{"status":"fresh"},"authority":{"producer":"surface-local"},"integrity":{"status":"matched"},"status":"pass","summary":"accepted"}]}' \
  >"$TMP/residual-surface.out" 2>"$TMP/residual-surface.err"; then
  fail "residual 2: writer accepted narrative surface_trust_refs[].artifact_ref"
elif rg -q 'narrative trust isolation \(#619\)' "$TMP/residual-surface.err"; then
  pass "residual 2: writer rejects standard and surface trust reference channels with typed diagnostics"
else
  fail "residual 2: surface trust ref rejection omitted typed diagnostic"
fi

if node "$ROOT/build/src/cli/workflow-sidecar.js" record-check "$SESSION" \
  --command 'cd .kontourai && test -f narrative/isolation-fixture/narrative-1/envelopes/envelope.json' \
  >"$TMP/h2-composed.out" 2>"$TMP/h2-composed.err"; then
  fail "H2: record-check accepted the tractable cd-plus-relative narrative command"
elif rg -q 'narrative trust isolation \(#619\)' "$TMP/h2-composed.err"; then
  pass "H2: writer refuses cd into .kontourai followed by a relative narrative path"
else
  fail "H2: composed-command rejection omitted typed diagnostic"
fi

# H2: direct writer commands and both stop-hook command sources refuse raw and indirect narrative paths.
if node "$ROOT/build/src/cli/workflow-sidecar.js" record-check "$SESSION" \
  --command 'bash evidence/narrative-symlink.sh' >"$TMP/h2-check.out" 2>"$TMP/h2-check.err"; then
  fail "H2: record-check accepted an indirect narrative command"
elif rg -q 'narrative trust isolation \(#619\)' "$TMP/h2-check.err"; then
  pass "H2: record-check rejects indirect narrative commands before execution"
else
  fail "H2: record-check rejection omitted typed diagnostic"
fi

if FLOW_AGENTS_GOAL_FIT_RECHECK=true node - "$ROOT/scripts/hooks/stop-goal-fit.js" "$REPO" "$SESSION" <<'NODE'
const hook=require(process.argv[2]);
const root=process.argv[3], dir=process.argv[4];
const commands=[
  'test -f .kontourai/narrative/isolation-fixture/narrative-1/envelopes/rendered.md',
  'test -f .KONTOURAI/NARRATIVE/isolation-fixture/narrative-1/envelopes/rendered.md',
  'test -f .kontourai%2Fnarrative%2Fisolation-fixture%2Fnarrative-1%2Fenvelopes%2Frendered.md',
  'bash evidence/narrative-symlink.sh',
  'cat evidence/hardlink-output.json',
  'cat evidence/relocated-output.json',
  'cd .kontourai && test -f narrative/isolation-fixture/narrative-1/envelopes/envelope.json',
];
for (const command of commands) {
  const model=hook.resolveTrustedCommand(root,dir,{id:'probe',command},{criteria:[]});
  if (!model || !model.refused || !/narrative trust isolation \(#619\)/.test(model.refusal)) process.exit(1);
  const acceptance={criteria:[{id:'probe',evidence_refs:[{kind:'command',excerpt:command}]}]};
  const accepted=hook.resolveTrustedCommand(root,dir,{id:'probe',command},acceptance);
  if (!accepted || !accepted.refused || !/narrative trust isolation \(#619\)/.test(accepted.refusal)) process.exit(2);
}
NODE
then
  pass "H2: stop hook refuses normal/RECHECK command aliases and relocated narrative content"
else
  fail "H2: a stop-hook trusted-command source accepted narrative content"
fi

# Residual compensation: arbitrary shell variables are statically undecidable, but command
# evidence must never materialize the referenced narrative bytes into trust.bundle.
VARIABLE_SESSION="$ARTIFACT_ROOT/variable-composition"
mkdir -p "$VARIABLE_SESSION"
cp "$SESSION/trust.bundle" "$VARIABLE_SESSION/trust.bundle"
variable_command='base=.kontourai; test -f "$base/narrative/isolation-fixture/narrative-1/envelopes/envelope.json"'
if node "$ROOT/build/src/cli/workflow-sidecar.js" record-check "$VARIABLE_SESSION" --command "$variable_command" \
  >"$TMP/h2-variable.out" 2>"$TMP/h2-variable.err" \
  && node - "$VARIABLE_SESSION/trust.bundle" "$variable_command" <<'NODE'
const fs=require('fs');
const bundle=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const command=process.argv[3];
const serialized=JSON.stringify(bundle);
if (serialized.includes('NARRATIVE_CONTENT_MUST_NOT_ENTER_TRUST_BUNDLE')) process.exit(1);
if (serialized.includes('grounded-execution-narrative/v1')) process.exit(2);
if (!bundle.evidence.some(entry => entry?.execution?.label === command && entry.execution.isError === false)) process.exit(3);
NODE
then
  pass "H2 residual control: variable-composed command records execution only; narrative content bytes never enter trust.bundle"
else
  fail "H2 residual control: variable-composed command imported content or failed to record safely: $(tail -n 3 "$TMP/h2-variable.err")"
fi

GATE_SESSION="$ARTIFACT_ROOT/gate-command"
mkdir -p "$GATE_SESSION"
cat >"$GATE_SESSION/state.json" <<'JSON'
{"schema_version":"1.0","task_slug":"gate-command","status":"active","phase":"execution","flow_run":{"definition_id":"builder.build","current_step":"execute"}}
JSON
cp "$SESSION/trust.bundle" "$GATE_SESSION/trust.bundle"
if node "$ROOT/build/src/cli/workflow-sidecar.js" record-gate-claim "$GATE_SESSION" --status pass --summary reject \
  --expectation implementation-scope --command 'cat evidence/relocated-output.json' >"$TMP/h2-gate.out" 2>"$TMP/h2-gate.err"; then
  fail "H2: record-gate-claim accepted relocated narrative content"
elif rg -q 'narrative trust isolation \(#619\)' "$TMP/h2-gate.err"; then
  pass "H2: record-gate-claim rejects narrative commands before execution"
else
  fail "H2: record-gate-claim rejection omitted typed diagnostic: $(tail -n 3 "$TMP/h2-gate.err")"
fi

# H3/H4: alternate trust ingestion and generic promotion routes reject path and content shapes.
if node "$ROOT/build/src/cli/workflow-sidecar.js" record-evidence "$SESSION" --verdict pass \
  --surface-trust-json "$REPO/evidence/relocated-output.json" >"$TMP/h3.out" 2>"$TMP/h3.err"; then
  fail "H3: --surface-trust-json accepted relocated narrative content"
elif rg -q 'narrative trust isolation \(#619\)' "$TMP/h3.err"; then
  pass "H3: --surface-trust-json rejects narrative path/content with typed diagnostic"
else
  fail "H3: surface-trust rejection omitted typed diagnostic"
fi
if node "$ROOT/build/src/cli/workflow-sidecar.js" promote "$SESSION" --repo-root "$REPO" \
  --evidence-path evidence/hardlink-output.json >"$TMP/h4.out" 2>"$TMP/h4.err"; then
  fail "H4: generic promote accepted narrative content"
elif rg -q 'narrative trust isolation \(#619\)' "$TMP/h4.err"; then
  pass "H4: generic promote rejects narrative evidence paths with typed diagnostic"
else
  fail "H4: promote rejection omitted typed diagnostic"
fi

# M2: critique findings, learning sources, and release references are guarded independently.
if node --input-type=module - "$ROOT/build/src/cli/workflow-sidecar.js" "$REPO" <<'NODE'
const api=await import(`file://${process.argv[2]}`), root=process.argv[3];
const expectReject=(fn)=>{try{fn();process.exit(1)}catch(error){if(!/narrative trust isolation \(#619\)/.test(String(error.message)))process.exit(2)}};
expectReject(()=>api.normalizeFinding({file_refs:['evidence/hardlink-output.json']},root));
expectReject(()=>api.normalizeLearning({source_refs:['evidence/relocated-output.json'],facts:[],routing:[],outcome:'unknown',correction:{needed:false,evidence:'none'}},'2026-07-14T00:00:00.000Z',root));
NODE
then
  pass "M2: finding file_refs and learning source_refs reject narrative content"
else
  fail "M2: finding or learning reference guard failed"
fi
if node "$ROOT/build/src/cli/workflow-sidecar.js" record-critique "$SESSION" --verdict fail --summary reject \
  --lane-json '{"id":"isolation","status":"fail","summary":"reject","evidence_refs":[{"kind":"artifact","file":"evidence/hardlink-output.json","summary":"hardlink"}]}' \
  --finding-json '{"id":"narrative-ref","status":"open","file_refs":["evidence/relocated-output.json"]}' \
  >"$TMP/m2-critique.out" 2>"$TMP/m2-critique.err"; then
  fail "M2: critique lane/finding accepted narrative references"
elif rg -q 'narrative trust isolation \(#619\)' "$TMP/m2-critique.err"; then
  pass "M2: critique lane and finding paths reject narrative aliases before persistence"
else
  fail "M2: critique rejection omitted typed diagnostic"
fi
if node "$ROOT/build/src/cli/workflow-sidecar.js" record-release "$SESSION" --decision hold --scope fixture \
  --evidence-ref evidence/relocated-output.json >"$TMP/m2-release.out" 2>"$TMP/m2-release.err"; then
  fail "M2: release evidence_ref accepted narrative content"
elif rg -q 'narrative trust isolation \(#619\)' "$TMP/m2-release.err"; then
  pass "M2: release evidence references reject narrative content with typed diagnostic"
else
  fail "M2: release rejection omitted typed diagnostic"
fi
if node "$ROOT/build/src/cli/workflow-sidecar.js" record-release "$SESSION" --decision hold --scope fixture \
  --docs-json '{"status":"updated","summary":"reject","refs":["evidence/hardlink-output.json"]}' \
  >"$TMP/m2-release-nested.out" 2>"$TMP/m2-release-nested.err"; then
  fail "M2: nested release docs refs accepted narrative content"
elif rg -q 'narrative trust isolation \(#619\)' "$TMP/m2-release-nested.err"; then
  pass "M2: nested release reference fields reject narrative content"
else
  fail "M2: nested release rejection omitted typed diagnostic"
fi

# AC6: exercise Flow's real gate evaluation, with a genuine trust.bundle positive control.
if node --input-type=module <<'NODE'
import { evaluateGate } from '@kontourai/flow';
const definition={id:'isolation',version:'1',steps:[{id:'verify',next:null}],gates:{gate:{step:'verify',expects:[{id:'trust',kind:'trust.bundle',required:true,bundle_claim:{claimType:'builder.execute.scope',subjectType:'change'}}]}}};
const state={status:'active',current_step:'verify',exceptions:[],transitions:[],gate_outcomes:[]};
const narrative={id:'narrative',gate_id:'gate',kind:'artifact',requested_kind:'artifact',status:'passed',original_path:'.kontourai/narrative/run/n1/rendered.md'};
const blocked=evaluateGate(definition,state,{schema_version:'1',evidence:[narrative]},'gate');
if (blocked.status==='pass') process.exit(1);
const trust={id:'trust',gate_id:'gate',kind:'trust.bundle',requested_kind:'trust.bundle',status:'passed',bundle:{schemaVersion:5,source:'positive',claims:[],evidence:[],policies:[],events:[]},bundle_report:{claims:[{id:'scope',claimType:'builder.execute.scope',subjectType:'change',status:'verified'}]}};
const passed=evaluateGate(definition,state,{schema_version:'1',evidence:[trust]},'gate');
if (passed.status!=='pass') process.exit(2);
NODE
then
  pass "AC6: real Flow gate evaluation rejects narrative-shaped evidence and accepts a real trust.bundle"
else
  fail "AC6: real Flow evaluation isolation or positive control failed"
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

if cmp -s "$ROOT/scripts/hooks/stop-goal-fit.js" "$ROOT/context/scripts/hooks/stop-goal-fit.js"; then
  pass "hook runtime and kit copies are byte-identical"
else
  fail "hook runtime and kit copies differ"
fi

if [[ "$errors" -eq 0 ]]; then
  echo "narrative trust isolation tests passed."
  exit 0
fi
echo "narrative trust isolation tests FAILED: $errors issue(s)."
exit 1
