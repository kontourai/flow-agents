#!/usr/bin/env bash
# Effectiveness-loop demo: an isolated, inspectable builder.build run with
# run-derived economics and ceremony measurement. It intentionally leaves its
# fixture behind so a human can inspect the report and Flow Console projection.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

FIXTURE_ROOT="${EFFECTIVENESS_LOOP_FIXTURE_ROOT:-$(mktemp -d "${TMPDIR:-/tmp}/flow-agents-effectiveness-loop.XXXXXX")}" 
FIXTURE_HOME="$FIXTURE_ROOT/home"
PROJECT="$FIXTURE_ROOT/project"
ARTIFACT_ROOT="$PROJECT/.kontourai/flow-agents"
SLUG="wedge-effectiveness-loop-demo"
SESSION="$ARTIFACT_ROOT/$SLUG"
FLOW_RUN_DIR="$PROJECT/.kontourai/flow/runs/$SLUG"
LOG="$FIXTURE_ROOT/workflow.log"
VERBS="$FIXTURE_ROOT/workflow-verbs.tsv"
ECONOMICS_LOG="$FIXTURE_ROOT/economics.jsonl"
REPORT="$FIXTURE_ROOT/effectiveness-loop-report.md"
POWER_REFUSAL="$FIXTURE_ROOT/power-proof-blocked.log"
PR_REFUSAL="$FIXTURE_ROOT/pr-open-refusal.log"
errors=0
not_reachable_reason=""
not_reachable_refusal=""

pass() { printf '  PASS  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; errors=$((errors + 1)); }

# The ledger is the authoritative ceremony numerator. Each entry is a public
# workflow verb attempted by this run; it deliberately includes the failed
# tests-evidence attempt so retry rate is observable rather than inferred.
public() {
  local verb="$1" key="$2"; shift 2
  (cd "$PROJECT" && FLOW_AGENTS_ACTOR=demo-owner node "$ROOT/build/src/cli.js" workflow "$verb" "$@")
  local rc=$?
  printf '%s\t%s\t%s\n' "$verb" "$key" "$rc" >> "$VERBS"
  return "$rc"
}
public_as() {
  local actor="$1" verb="$2" key="$3"; shift 3
  (cd "$PROJECT" && FLOW_AGENTS_ACTOR="$actor" node "$ROOT/build/src/cli.js" workflow "$verb" "$@")
  local rc=$?
  printf '%s\t%s\t%s\n' "$verb" "$key" "$rc" >> "$VERBS"
  return "$rc"
}
record() {
  local expectation="$1" artifact="$2" summary="$3"
  if public evidence "$expectation" evidence --session-dir "$SESSION" --status pass --expectation "$expectation" --summary "$summary" \
    --evidence-ref-json "{\"kind\":\"artifact\",\"file\":\"$artifact\",\"summary\":\"$summary\"}" >>"$LOG" 2>&1; then
    pass "public evidence accepted $expectation"
  else
    fail "public evidence refused $expectation"
  fi
}
assert_step() {
  local expected="$1"
  if node - "$FLOW_RUN_DIR/state.json" "$expected" <<'NODE'
const fs = require('node:fs');
const [file, expected] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
if (state.current_step !== expected) throw new Error(`expected ${expected}, got ${state.current_step}`);
NODE
  then pass "canonical Flow state is at $expected"; else fail "canonical Flow state did not reach $expected"; fi
}

echo '=== EFFECTIVENESS LOOP DEMO: isolated fixture ==='
mkdir -p "$FIXTURE_HOME" "$PROJECT/checks" "$ARTIFACT_ROOT" "$SESSION"
git -C "$PROJECT" init -q
git -C "$PROJECT" config user.email fixture@flow-agents.invalid
git -C "$PROJECT" config user.name 'Effectiveness Loop Fixture'
printf '.kontourai/\n' > "$PROJECT/.gitignore"
printf "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('effectiveness fixture executes a real test', () => assert.equal(2 + 2, 4));\n" > "$PROJECT/checks/effectiveness.test.mjs"
git -C "$PROJECT" add .gitignore checks/effectiveness.test.mjs
git -C "$PROJECT" commit -qm 'fixture: baseline for effectiveness loop'

# This is a real kit installation into a disposable Codex home, not an
# assumption that the repository's own installation is usable.
if HOME="$FIXTURE_HOME" CODEX_HOME="$FIXTURE_HOME/.codex" node "$ROOT/build/src/cli.js" init --runtime codex --dest "$FIXTURE_HOME/.codex" --telemetry-sink local-files --activate-kit builder --yes >"$FIXTURE_ROOT/install.log" 2>&1; then
  pass "installed kit into fixture home"
else
  fail "could not install kit into fixture home"
fi
find "$FIXTURE_HOME/.codex" -maxdepth 2 -type f -o -type l | sed "s|$FIXTURE_HOME/||" | sort > "$FIXTURE_ROOT/installed-files.txt"
if [[ -s "$FIXTURE_ROOT/installed-files.txt" ]]; then pass 'fixture install produced files'; else fail 'fixture install produced no files'; fi

printf 'Selected Work Item: wedge:effectiveness-loop-demo\n' > "$SESSION/$SLUG--pull-work.md"
if public start start --artifact-root "$ARTIFACT_ROOT" --flow builder.build --work-item 'wedge:effectiveness-loop-demo' \
  --assignment-provider local-file --title 'Effectiveness loop fixture' --summary 'Prove run economics and ceremony.' \
  --criterion 'The fixture test executes and exits zero.' >>"$LOG" 2>&1; then
  pass 'started isolated builder.build run through the public interface'
else fail 'could not start isolated run'; fi

printf 'Selected Work Item: wedge:effectiveness-loop-demo\n' > "$SESSION/$SLUG--pull-work.md"
printf '# Demo plan\n\nUse public workflow evidence only.\n' > "$SESSION/$SLUG--plan-work.md"
printf '# Demo delivery\n\nThe fixture contains one substantive test.\n' > "$SESSION/$SLUG--deliver.md"
printf '# Evidence gate\n\nAll local required evidence is recorded.\n' > "$SESSION/$SLUG--evidence-gate.md"

assert_step design-probe
record pickup-probe-readiness "$SESSION/$SLUG--pull-work.md" 'Probe confirms fixture readiness.'
record probe-decisions-or-accepted-gaps "$SESSION/$SLUG--pull-work.md" 'Probe decisions are recorded.'
assert_step plan
record implementation-plan "$SESSION/$SLUG--plan-work.md" 'Reviewable implementation plan.'
assert_step execute
record implementation-scope "$SESSION/$SLUG--deliver.md" 'Implemented fixture scope.'
assert_step verify
if public_as demo-reviewer critique critique --session-dir "$SESSION" --id demo-review --verdict pass --summary 'Independent fixture review is clean.' \
  --artifact-ref "$SESSION/$SLUG--deliver.md" \
  --lane-json "{\"id\":\"code-review\",\"status\":\"pass\",\"summary\":\"Fixture review completed.\",\"evidence_refs\":[{\"kind\":\"artifact\",\"file\":\"$SESSION/$SLUG--deliver.md\",\"summary\":\"Reviewed fixture delivery artifact.\"}]}" >>"$LOG" 2>&1; then
  pass 'public critique records clean review'
else fail 'public critique refused clean fixture review'; fi

# POWER PROOF: this non-executed command must be rejected before mutation.
if public evidence tests-evidence evidence --session-dir "$SESSION" --status pass --expectation tests-evidence --summary 'Deliberately missing execution proof.' \
  --evidence-ref-json '{"kind":"command","excerpt":"node --test checks/effectiveness.test.mjs","summary":"Would run the fixture test."}' >"$POWER_REFUSAL" 2>&1; then
  fail 'POWER-PROOF BLOCKED: tests-evidence without execution was accepted'
else
  pass 'POWER-PROOF BLOCKED: tests-evidence without execution was refused'
fi
power_restored=false
if public evidence tests-evidence evidence --session-dir "$SESSION" --status pass --expectation tests-evidence --summary 'Observed fixture test execution.' \
  --command 'node --test checks/effectiveness.test.mjs' \
  --evidence-ref-json '{"kind":"command","excerpt":"node --test checks/effectiveness.test.mjs","summary":"Runs the isolated fixture test."}' \
  --criterion-json '{"id":"the-fixture-test-executes-and-exits-zero","status":"pass","evidence_refs":[{"kind":"command","excerpt":"node --test checks/effectiveness.test.mjs","summary":"Runs the isolated fixture test."}]}' >>"$LOG" 2>&1; then
  power_restored=true
  pass 'POWER-PROOF RESTORED: real execution proof was accepted'
else fail 'POWER-PROOF RESTORED: real execution proof was refused'; fi
assert_step merge-ready
record merge-readiness "$SESSION/$SLUG--evidence-gate.md" 'Local merge readiness is reviewable.'
assert_step pr-open
if public evidence pull-request-opened evidence --session-dir "$SESSION" --status pass --expectation pull-request-opened --summary 'Attempt public fixture PR evidence.' \
  --evidence-ref-json "{\"kind\":\"artifact\",\"file\":\"$SESSION/$SLUG--evidence-gate.md\",\"summary\":\"Fixture readiness artifact.\"}" >"$PR_REFUSAL" 2>&1; then
  fail 'pr-open operation-bound expectation unexpectedly accepted generic evidence'
else
  not_reachable_reason='authenticated ChangeProvider required for terminal completion'
  not_reachable_refusal="$(tr '\n' ' ' < "$PR_REFUSAL" | sed 's/[[:space:]]\+/ /g' | cut -c1-360)"
  pass 'pr-open is honestly blocked by authenticated external ChangeProvider boundary'
fi

# Golden-run hard assertion: any cancel/recovery, including a future accidental
# mutation, fails this demo rather than contaminating its economics.
if node - "$FLOW_RUN_DIR/state.json" "$SESSION/trust.bundle" <<'NODE'
const fs = require('node:fs');
const [stateFile, bundleFile] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const bundle = JSON.parse(fs.readFileSync(bundleFile, 'utf8'));
if ((state.transitions || []).some((t) => /cancel|recover/i.test(JSON.stringify(t)))) process.exit(1);
if (/cancel|recover-exact-current-completion|reseal-verification-evidence/i.test(JSON.stringify(bundle))) process.exit(1);
NODE
then pass 'HARD ASSERTION: zero signed cancels and zero manual/out-of-band recovery'; else fail 'HARD ASSERTION: cancel or manual/out-of-band recovery appeared'; fi

# Fixture-only close emitter. It has the same detached/best-effort isolation as
# telemetry.sh: it cannot affect a workflow command. The following poll is a
# separate demo assertion, not a hook dependency.
( TELEMETRY_ECONOMICS_LOG_FILE="$ECONOMICS_LOG" bash "$ROOT/scripts/telemetry/economics-record.sh" --flow-run-dir "$FLOW_RUN_DIR" --task-slug "$SLUG" ) </dev/null >/dev/null 2>&1 &
emit_pid=$!
disown 2>/dev/null || true
record_seen=false
for _attempt in 1 2 3 4 5 6 7 8 9 10; do
  if [[ -s "$ECONOMICS_LOG" ]]; then record_seen=true; break; fi
  sleep 0.1
done
if [[ "$record_seen" == true ]] && node - "$ECONOMICS_LOG" "$FLOW_RUN_DIR/state.json" <<'NODE'
const fs = require('node:fs');
const [log, stateFile] = process.argv.slice(2);
const record = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').at(-1));
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
if (record.run_id !== state.run_id || record.terminal_status !== state.status || !Array.isArray(record.phases) || !record.phases.length || typeof record.iterations?.route_backs !== 'number' || !record.phases.every((phase) => phase.source === 'flow-run-record' && typeof phase.wall_clock_s === 'number')) process.exit(1);
NODE
then pass 'AUTO-EMIT: economics record appeared from fixture close path'; else fail 'AUTO-EMIT: no valid economics record appeared'; fi

# This calls the exact projection used by `flow console` before the server
# binds a loopback port. It proves the run directory is console-consumable
# without making this non-networking eval depend on a local listener policy.
if node --input-type=module - "$ROOT/node_modules/@kontourai/flow/dist/console/console-projection.js" "$SLUG" "$PROJECT" <<'NODE'
const [modulePath, runId, cwd] = process.argv.slice(2);
const { projectFlowRunFromFiles } = await import(`file://${modulePath}`);
const projection = await projectFlowRunFromFiles(runId, { cwd, repairReports: true });
if (!projection || projection.run?.run_id !== runId) process.exit(1);
NODE
then pass 'FLOW CONSOLE: exact run projection is consumable'; else fail 'FLOW CONSOLE: run projection is not consumable'; fi

node - "$FLOW_RUN_DIR/state.json" "$SESSION/trust.bundle" "$ECONOMICS_LOG" "$VERBS" "$FIXTURE_HOME" "$PROJECT" "$not_reachable_reason" "$not_reachable_refusal" > "$REPORT" <<'NODE'
const fs = require('node:fs');
const [stateFile, bundleFile, economicsFile, verbsFile, fixtureHome, project, notReachable, refusal] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const bundle = JSON.parse(fs.readFileSync(bundleFile, 'utf8'));
// Select by producer, never by position: the economics log is a multi-producer stream and
// this report is about the canonical Flow-run-derived record specifically.
const record = JSON.parse(fs.readFileSync(economicsFile, 'utf8').trim().split('\n')
  .filter(Boolean)
  .filter((line) => { try { return JSON.parse(line).producer_authority === 'flow_run_record'; } catch { return false; } })
  .at(-1));
const claims = Array.isArray(bundle.claims) ? bundle.claims : [];
const byExpectation = new Map(claims.map((claim) => [claim.metadata?.gate_claim?.expectation_id, claim]));
byExpectation.set('clean-critique', byExpectation.get('clean-critique') || claims.find((claim) => claim.claimType === 'workflow.critique.review'));
byExpectation.set('acceptance-criteria', byExpectation.get('acceptance-criteria') || claims.find((claim) => claim.claimType === 'workflow.acceptance.criterion'));
const steps = [['pull-work','selected-work'],['design-probe','pickup-probe-readiness'],['design-probe','probe-decisions-or-accepted-gaps'],['plan','implementation-plan'],['execute','implementation-scope'],['verify','clean-critique'],['verify','acceptance-criteria'],['verify','tests-evidence'],['merge-ready','merge-readiness'],['pr-open','pull-request-opened'],['merge-ready-ci','ci-merge-readiness'],['learn','decision-evidence'],['learn','learning-evidence']];
const rows = fs.readFileSync(verbsFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => { const [verb,key,code] = line.split('\t'); return {verb,key,code:Number(code)}; });
const failedAndRetried = rows.filter((row, index) => row.code !== 0 && rows.slice(index + 1).some((later) => later.key === row.key && later.code === 0)).length;
console.log('# Effectiveness Loop Demo Report');
console.log('');
console.log(`fixture_home: ${fixtureHome}`);
console.log(`run_id: ${state.run_id}`);
console.log('');
console.log('## Run summary');
console.log('');
console.log('| step | result | gate | evidence kind or reason |'); console.log('| --- | --- | --- | --- |');
for (const [step, expectation] of steps) {
 const claim = byExpectation.get(expectation); const evidence = claim && (bundle.evidence || []).find((entry) => entry.claimId === claim.id);
 if (claim) console.log(`| ${step} | PASS | ${expectation} | ${evidence?.evidenceType || (expectation === 'clean-critique' ? 'independent_critique' : 'test_output')} |`);
 else if (expectation === 'acceptance-criteria' && Array.isArray(bundle.criteria) && bundle.criteria.every((criterion) => criterion.status === 'pass')) console.log(`| ${step} | PASS | ${expectation} | test_output |`);
 else if (['pr-open','merge-ready-ci','learn'].includes(step)) console.log(`| ${step} | NOT-REACHABLE | ${expectation} | ${notReachable}; refusal=${JSON.stringify(refusal)} |`);
 else console.log(`| ${step} | NOT-RECORDED | ${expectation} | |`);
}
const routes = (state.transitions || []).filter((transition) => transition.route_back || transition.routeBack || transition.kind === 'route_back');
console.log(`route_backs: ${routes.length}`); console.log(`terminal_status: ${state.status}`);
console.log(''); console.log('## Economics record'); console.log('');
console.log(`producer_authority: ${record.producer_authority}`); console.log(`terminal_status: ${record.terminal_status}`); console.log(`wall_clock_s: ${record.time?.wall_clock_s ?? null}`); console.log(`human_wait_s: ${record.time?.human_wait_s ?? null}`); console.log(`route_backs: ${record.iterations?.route_backs ?? null}`); console.log(`input_tokens: ${record.cost?.input_tokens ?? null} (null: ${record.tokens_unattributed ? 'no transcript token attribution' : 'not applicable'})`); console.log(`output_tokens: ${record.cost?.output_tokens ?? null} (null: ${record.tokens_unattributed ? 'no transcript token attribution' : 'not applicable'})`); console.log(`estimated_cost_usd: ${record.cost?.estimated_cost_usd ?? null} (null: pricing is not derived in flow-run-record mode)`);
for (const phase of record.phases || []) console.log(`phase ${phase.phase}: wall_clock_s=${phase.wall_clock_s ?? null}; input_tokens=${phase.input_tokens ?? null}; output_tokens=${phase.output_tokens ?? null}`);
console.log(''); console.log('## Ceremony summary'); console.log('');
console.log(`workflow/sidecar verb invocations: ${rows.length}`); console.log(`failed verb invocations retried: ${failedAndRetried}`); console.log(`verb failure rate: ${rows.length ? (failedAndRetried / rows.length * 100).toFixed(1) : null}%`); console.log('Per-phase wall-clock and token windows are listed above from the run-derived economics record.');
console.log(''); console.log('## Human inspection'); console.log(''); console.log('Console projection: verified by the same projectFlowRunFromFiles reader that flow console uses before binding its loopback listener.'); console.log(`flow console --run ${state.run_id} --cwd ${JSON.stringify(project)}`);
console.log(''); console.log('## Limits this demo does not prove'); console.log(''); console.log('- Terminal completion past pr-open (an authenticated ChangeProvider correctly refuses this fixture).'); console.log('- Production stop-hook auto-emit: this run wires auto-emit in the demo close path only.'); console.log('- Live token attribution or live provider cost: no transcript is available, so token and cost fields are null.');
NODE

cat "$REPORT"
printf '\nREPORT ARTIFACT: %s\n' "$REPORT"
printf 'POWER-PROOF BLOCKED: tests-evidence — %s\n' "$(tr '\n' ' ' < "$POWER_REFUSAL" | sed 's/[[:space:]]\+/ /g' | cut -c1-240)"
if [[ "$power_restored" == true ]]; then
  printf 'POWER-PROOF RESTORED: real execution proof accepted.\n'
else
  printf 'POWER-PROOF RESTORED: real execution proof was not accepted.\n'
fi
if [[ "$errors" -gt 0 ]]; then echo "EFFECTIVENESS LOOP DEMO VERDICT: FAIL — $errors assertion(s) failed"; exit 1; fi
echo 'EFFECTIVENESS LOOP DEMO VERDICT: PASS — fixture installation, real reachable gates, fixture-only auto-emit, and report completed.'
