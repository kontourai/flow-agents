#!/usr/bin/env bash
# The Golden Run: drive the shipped builder.build workflow exclusively through
# its public CLI in a disposable Git project.  This intentionally does not
# turn an unavailable authenticated ChangeProvider into locally authored state.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

TMP="$(mktemp -d)"
PROJECT="$TMP/project"
ARTIFACT_ROOT="$PROJECT/.kontourai/flow-agents"
SLUG="wedge-golden-run-e2e"
SESSION="$ARTIFACT_ROOT/$SLUG"
FLOW_RUN_DIR="$PROJECT/.kontourai/flow/runs/$SLUG"
LOG="$TMP/golden-run.log"
POWER_REFUSAL="$TMP/power-refusal.log"
ECONOMICS_LOG="$TMP/economics.jsonl"
errors=0
not_reachable_reason=""
not_reachable_refusal=""

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

pass() { printf '  PASS  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; errors=$((errors + 1)); }
public() { (cd "$PROJECT" && FLOW_AGENTS_ACTOR=golden-owner node "$ROOT/build/src/cli.js" workflow "$@"); }
public_as() { local actor="$1"; shift; (cd "$PROJECT" && FLOW_AGENTS_ACTOR="$actor" node "$ROOT/build/src/cli.js" workflow "$@"); }

record() {
  local expectation="$1" artifact="$2" summary="$3"
  if public evidence --session-dir "$SESSION" --status pass --expectation "$expectation" --summary "$summary" \
    --evidence-ref-json "{\"kind\":\"artifact\",\"file\":\"$artifact\",\"summary\":\"$summary\"}" >>"$LOG" 2>&1; then
    pass "public evidence accepted $expectation"
    return 0
  fi
  local log_text
  log_text="$(<"$LOG")"
  fail "public evidence refused $expectation: ${log_text: -500}"
  return 1
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

print_summary() {
  node - "$FLOW_RUN_DIR/state.json" "$SESSION/trust.bundle" "$POWER_REFUSAL" "$ECONOMICS_LOG" "$not_reachable_reason" "$not_reachable_refusal" <<'NODE'
const fs = require('node:fs');
const [stateFile, bundleFile, powerFile, economicsFile, notReachable, refusal] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const bundle = JSON.parse(fs.readFileSync(bundleFile, 'utf8'));
const claims = Array.isArray(bundle.claims) ? bundle.claims : [];
const byExpectation = new Map(claims.map((claim) => [claim.metadata?.gate_claim?.expectation_id, claim]));
byExpectation.set('clean-critique', byExpectation.get('clean-critique') || claims.find((claim) => claim.claimType === 'workflow.critique.review'));
byExpectation.set('acceptance-criteria', byExpectation.get('acceptance-criteria') || claims.find((claim) => claim.claimType === 'workflow.acceptance.criterion'));
const steps = [
  ['pull-work', 'selected-work'], ['design-probe', 'pickup-probe-readiness'],
  ['design-probe', 'probe-decisions-or-accepted-gaps'], ['plan', 'implementation-plan'],
  ['execute', 'implementation-scope'], ['verify', 'clean-critique'],
  ['verify', 'acceptance-criteria'], ['verify', 'tests-evidence'],
  ['merge-ready', 'merge-readiness'], ['pr-open', 'pull-request-opened'],
  ['merge-ready-ci', 'ci-merge-readiness'], ['learn', 'decision-evidence'], ['learn', 'learning-evidence'],
];
console.log('\n=== GOLDEN RUN SUMMARY ===');
console.log(`run_id: ${state.run_id}`);
console.log('| step | result | gate | evidence or reason |');
console.log('| --- | --- | --- | --- |');
for (const [step, expectation] of steps) {
  const claim = byExpectation.get(expectation);
  if (claim) {
    const observed = claim.metadata?.observed_commands;
    const evidence = (bundle.evidence || []).find((entry) => entry.claimId === claim.id);
    console.log(`| ${step} | PASS | ${expectation} | ${evidence?.evidenceType || (expectation === 'clean-critique' ? 'independent_critique' : 'unknown')}${Array.isArray(observed) ? `; observed_commands=${observed.length}` : ''} |`);
  } else if (expectation === 'clean-critique' && (bundle.critiques || []).some((critique) => critique.verdict === 'pass' || critique.status === 'pass')) {
    console.log(`| ${step} | PASS | ${expectation} | independent_critique |`);
  } else if (expectation === 'acceptance-criteria' && Array.isArray(bundle.criteria) && bundle.criteria.length > 0 && bundle.criteria.every((criterion) => criterion.status === 'pass')) {
    console.log(`| ${step} | PASS | ${expectation} | test_output |`);
  } else if (['pr-open', 'merge-ready-ci', 'learn'].includes(step) && notReachable) {
    console.log(`| ${step} | NOT-REACHABLE | ${expectation} | reason=${notReachable}; refusal=${JSON.stringify(refusal)} |`);
  } else console.log(`| ${step} | NOT-RECORDED | ${expectation} | |`);
}
const routes = (state.transitions || []).filter((transition) => transition.route_back || transition.routeBack || transition.kind === 'route_back');
console.log(`route_backs: ${routes.length}`);
console.log(`terminal_status: ${state.status}`);
const lifecycle = JSON.stringify({ state, bundle });
console.log(`signed_cancels: ${/signed[ _-]?cancel|\"operation\"\s*:\s*\"cancel\"/i.test(lifecycle) ? 'PRESENT' : 'NONE'}`);
console.log(`manual_recovery: ${/recover-exact-current-completion|reseal-verification-evidence|manual recovery/i.test(lifecycle) ? 'PRESENT' : 'NONE'}`);
console.log(fs.existsSync(powerFile) ? `POWER-PROOF BLOCKED: ${fs.readFileSync(powerFile, 'utf8').trim().replace(/\s+/g, ' ').slice(0, 360)}` : 'POWER-PROOF BLOCKED: missing');
if (fs.existsSync(economicsFile)) {
  const rows = fs.readFileSync(economicsFile, 'utf8').trim().split('\n').filter(Boolean);
  const record = JSON.parse(rows.at(-1));
  console.log(`ECONOMICS run_id=${record.run_id} terminal_status=${record.terminal_status} phases=${record.phases?.length ?? null} route_backs=${record.iterations?.route_backs ?? null} wall_clock_s=${record.time?.wall_clock_s ?? null}`);
} else console.log('ECONOMICS null reason=producer emitted no local record');
NODE
}

echo '=== GOLDEN RUN: public builder.build workflow in isolated fixture ==='
mkdir -p "$PROJECT/checks"
mkdir -p "$ARTIFACT_ROOT"
git -C "$PROJECT" init -q
git -C "$PROJECT" config user.email fixture@flow-agents.invalid
git -C "$PROJECT" config user.name 'Golden Run Fixture'
printf '.kontourai/\n' > "$PROJECT/.gitignore"
printf "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('golden fixture executes a real test', () => assert.equal(2 + 2, 4));\n" > "$PROJECT/checks/golden.test.mjs"
git -C "$PROJECT" add .gitignore checks/golden.test.mjs
git -C "$PROJECT" commit -qm 'fixture: baseline for golden workflow'

mkdir -p "$SESSION"
printf 'Selected Work Item: wedge:golden-run-e2e\n' > "$SESSION/$SLUG--pull-work.md"
if public start --artifact-root "$ARTIFACT_ROOT" --flow builder.build --work-item 'wedge:golden-run-e2e' \
  --assignment-provider local-file --title 'Golden run fixture' --summary 'Prove public evidence composition.' \
  --criterion 'The fixture test executes and exits zero.' >>"$LOG" 2>&1; then
  pass 'started isolated builder.build run through the public interface'
else
  start_log="$(<"$LOG")"
  fail "could not start isolated run: ${start_log: -700}"
fi

# These are ordinary reviewable work artifacts, created only after the public
# start command has made the canonical session and Flow run.
printf 'Selected Work Item: wedge:golden-run-e2e\n' > "$SESSION/$SLUG--pull-work.md"
printf '# Golden plan\n\nUse only public workflow evidence.\n' > "$SESSION/$SLUG--plan-work.md"
printf '# Golden delivery\n\nThe isolated fixture contains one substantive test.\n' > "$SESSION/$SLUG--deliver.md"
printf '# Evidence gate\n\nAll local required evidence is recorded.\n' > "$SESSION/$SLUG--evidence-gate.md"

assert_step design-probe
record pickup-probe-readiness "$SESSION/$SLUG--pull-work.md" 'Probe confirms fixture is ready.'
record probe-decisions-or-accepted-gaps "$SESSION/$SLUG--pull-work.md" 'Probe decisions are recorded.'
assert_step plan
record implementation-plan "$SESSION/$SLUG--plan-work.md" 'Reviewable implementation plan.'
assert_step execute
record implementation-scope "$SESSION/$SLUG--deliver.md" 'Implemented fixture scope.'
assert_step verify

if public_as golden-reviewer critique --session-dir "$SESSION" --id golden-review --verdict pass --summary 'Independent fixture review is clean.' \
  --artifact-ref "$SESSION/$SLUG--deliver.md" \
  --lane-json "{\"id\":\"code-review\",\"status\":\"pass\",\"summary\":\"Fixture review completed.\",\"evidence_refs\":[{\"kind\":\"artifact\",\"file\":\"$SESSION/$SLUG--deliver.md\",\"summary\":\"Reviewed fixture delivery artifact.\"}]}" >"$TMP/critique.log" 2>&1; then
  pass 'public critique records clean review'
else
  critique_log="$(<"$TMP/critique.log")"
  fail "public critique refused clean fixture review: $critique_log"
fi

# POWER PROOF: this must refuse before mutation because the public writer has
# no observed execution to bind to tests-evidence.
if public evidence --session-dir "$SESSION" --status pass --expectation tests-evidence --summary 'Deliberately missing execution proof.' \
  --evidence-ref-json "{\"kind\":\"command\",\"excerpt\":\"node --test checks/golden.test.mjs\",\"summary\":\"Would run the fixture test.\"}" >"$POWER_REFUSAL" 2>&1; then
  fail 'POWER-PROOF: tests-evidence without executed command was accepted'
else
  pass 'POWER-PROOF: tests-evidence without executed command was refused'
fi

if public evidence --session-dir "$SESSION" --status pass --expectation tests-evidence --summary 'Observed fixture test execution.' \
  --command 'node --test checks/golden.test.mjs' \
  --evidence-ref-json "{\"kind\":\"command\",\"excerpt\":\"node --test checks/golden.test.mjs\",\"summary\":\"Runs the isolated fixture test.\"}" \
  --criterion-json "{\"id\":\"the-fixture-test-executes-and-exits-zero\",\"status\":\"pass\",\"evidence_refs\":[{\"kind\":\"command\",\"excerpt\":\"node --test checks/golden.test.mjs\",\"summary\":\"Runs the isolated fixture test.\"}]}" >"$TMP/restored-tests.log" 2>&1; then
  pass 'restored tests-evidence records real execution proof'
else
  restored_log="$(<"$TMP/restored-tests.log")"
  fail "restored tests-evidence was refused: $restored_log"
fi
assert_step merge-ready
record merge-readiness "$SESSION/$SLUG--evidence-gate.md" 'Local merge readiness is reviewable.'
assert_step pr-open

# `pull-request-opened` is intentionally an authenticated ChangeProvider
# operation, not a generic evidence assertion.  Attempt it to preserve the
# exact refusal in the transcript; never manufacture a provider result.
if public evidence --session-dir "$SESSION" --status pass --expectation pull-request-opened --summary 'Attempt public fixture PR evidence.' \
  --evidence-ref-json "{\"kind\":\"artifact\",\"file\":\"$SESSION/$SLUG--evidence-gate.md\",\"summary\":\"Fixture readiness artifact.\"}" >"$TMP/pr-open-refusal.log" 2>&1; then
  fail 'pr-open operation-bound expectation unexpectedly accepted generic evidence'
else
  if not_reachable_refusal="$(node - "$TMP/pr-open-refusal.log" <<'NODE'
const fs = require('node:fs');
process.stdout.write(fs.readFileSync(process.argv[2], 'utf8').trim());
NODE
  )"; then
    not_reachable_reason='authenticated ChangeProvider required for terminal completion'
    pass 'pr-open is honestly blocked by authenticated external ChangeProvider boundary'
  else
    fail 'could not capture the authenticated ChangeProvider refusal text'
  fi
fi

if [[ "${GOLDEN_RUN_TEST_INJECT:-}" == "cancel" ]]; then
  if node - "$FLOW_RUN_DIR/state.json" "$SESSION/trust.bundle" <<'NODE'
const fs = require('node:fs');
const [stateFile, bundleFile] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
state.transitions.push({ action: 'cancel', test_injection: true, at: new Date().toISOString() });
fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
const bundle = JSON.parse(fs.readFileSync(bundleFile, 'utf8'));
bundle.test_injected_operation = { operation: 'cancel', test_injection: true };
fs.writeFileSync(bundleFile, `${JSON.stringify(bundle, null, 2)}\n`);
NODE
  then pass 'test-only cancel injection applied to isolated fixture'; else fail 'test-only cancel injection could not be applied'; fi
elif [[ -n "${GOLDEN_RUN_TEST_INJECT:-}" ]]; then
  fail "unknown GOLDEN_RUN_TEST_INJECT value: ${GOLDEN_RUN_TEST_INJECT}"
fi

if node - "$FLOW_RUN_DIR/state.json" "$SESSION/trust.bundle" <<'NODE'
const fs = require('node:fs');
const [stateFile, bundleFile] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const bundle = JSON.parse(fs.readFileSync(bundleFile, 'utf8'));
if ((state.transitions || []).some((t) => /cancel|recover/i.test(JSON.stringify(t)))) process.exit(1);
if (/cancel|recover-exact-current-completion|reseal-verification-evidence/i.test(JSON.stringify(bundle))) process.exit(1);
NODE
then pass 'HARD ASSERTION: zero signed cancels and zero manual/out-of-band recovery';
else fail 'HARD ASSERTION: cancel or manual/out-of-band recovery appeared'; fi

if TELEMETRY_ECONOMICS_LOG_FILE="$ECONOMICS_LOG" bash "$ROOT/scripts/telemetry/economics-record.sh" --flow-run-dir "$FLOW_RUN_DIR"; then
  if node - "$ECONOMICS_LOG" "$FLOW_RUN_DIR/state.json" <<'NODE'
const fs = require('node:fs');
const [log, stateFile] = process.argv.slice(2);
const record = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').at(-1));
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
if (record.run_id !== state.run_id || record.terminal_status !== state.status || !Array.isArray(record.phases) || record.phases.length === 0 || typeof record.iterations?.route_backs !== 'number' || !record.phases.every((p) => p.source === 'flow-run-record' && typeof p.wall_clock_s === 'number')) process.exit(1);
NODE
  then pass 'economics record joins the canonical run with real phase windows'; else fail 'economics record is missing required honest run-derived fields'; fi
else fail 'economics producer exited nonzero'; fi

print_summary
if [[ "$errors" -gt 0 ]]; then echo "GOLDEN RUN VERDICT: FAIL — $errors harness assertions failed"; exit 1; fi
echo 'GOLDEN RUN (SANDBOX): PASS — all sandbox-reachable gates satisfied with real evidence; no cancels; no recovery. Terminal completion requires an authenticated ChangeProvider and is proven separately against a real repository.'
