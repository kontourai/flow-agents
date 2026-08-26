#!/usr/bin/env bash
# Certifies builder.build's six owned gates against the shipped effective Flow
# definition. Every run is an isolated Flow fixture; the repository's own
# .kontourai state is never read or written.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

TMP="$(mktemp -d)"
harness_failures=0
DRIVER=""
trap 'rm -rf "$TMP" "$DRIVER"' EXIT

pass() { echo "  PASS  $1"; }
fail() { echo "  HARNESS-FAIL  $1"; harness_failures=$((harness_failures + 1)); }
cell_name() { printf 'cell_%s_%s' "${1//-/_}" "${2//-/_}"; }
set_cell() { local name; name="$(cell_name "$1" "$2")"; printf -v "$name" '%s' "$3"; }
get_cell() { local name; name="$(cell_name "$1" "$2")"; eval "printf '%s' \"\${$name:-UNSET}\""; }
cert() { set_cell "$1" "$2" "PASS"; pass "$1 / $2 — $3"; }
uncertified() { set_cell "$1" "$2" "NOT-CERTIFIED: $3"; echo "  NOT-CERTIFIED  $1 / $2 — $3"; }
ceremony() { set_cell "$1" "$2" "CEREMONY: $3"; echo "  CEREMONY  $1 / $2 — $3"; }
covered() { set_cell "$1" "$2" "OUT OF SCOPE: $3"; }

echo "=== Gate Certification Matrix (builder.build) ==="

# The driver uses the same resolveEffectiveFlowDefinition + @kontourai/flow
# evaluation surface that builder-flow-run-adapter uses. Public workflow
# commands are intentionally not used to manufacture gate state: their writer
# validates and serializes evidence, while this test must observe the canonical
# gate reducer's resulting current_step and gate outcome. The fixture's copied
# definition is also the controlled power-proof seam.
DRIVER="$(mktemp "$ROOT/.eval-tmp-gate-certification-driver-XXXXXX")"
mv "$DRIVER" "$DRIVER.mjs"
DRIVER="$DRIVER.mjs"
cat >"$DRIVER" <<'NODE'
import { attachEvidence, evaluateRun, loadRun, startRun, validateDefinition } from '@kontourai/flow';
import fs from 'node:fs';
import path from 'node:path';

const [root, fixture, mode, gateId] = process.argv.slice(2);
const resolverModule = path.join(root, 'build', 'src', 'lib', 'flow-' + 'resolver.js');
const { resolveEffectiveFlowDefinition } = await import(resolverModule);
const original = validateDefinition(resolveEffectiveFlowDefinition('builder.build', root, { allowOverride: false }));
const clone = (value) => JSON.parse(JSON.stringify(value));
const orderedGates = ['pull-work-gate', 'design-probe-gate', 'plan-gate', 'execute-gate', 'verify-gate', 'merge-ready-gate'];

function gate(id, definition = original) {
  const found = definition.gates[id];
  if (!found) throw new Error(`missing gate ${id}`);
  return found;
}
function bundle(entries) {
  const now = new Date().toISOString();
  const claims = entries.map((entry) => ({
    id: `claim.${entry.id}`, subjectType: entry.subjectType, subjectId: entry.subjectId ?? `subject/${entry.id}`,
    claimType: entry.claimType, fieldOrBehavior: entry.note ?? `${entry.id} fixture`, value: 'pass', createdAt: now, updatedAt: now,
  }));
  const evidence = entries.map((entry) => ({
    id: `evidence.${entry.id}`, claimId: `claim.${entry.id}`, evidenceType: 'human_attestation', method: 'attestation',
    sourceRef: 'test_gate_certification_matrix', excerptOrSummary: entry.note ?? `${entry.id} fixture`, observedAt: now, collectedBy: 'test_gate_certification_matrix',
  }));
  const events = entries.map((entry) => ({
    id: `event.${entry.id}`, claimId: `claim.${entry.id}`, status: 'verified', actor: 'test_gate_certification_matrix',
    method: 'attestation', evidenceIds: [`evidence.${entry.id}`], createdAt: now, verifiedAt: now,
  }));
  return { schemaVersion: 5, source: 'test_gate_certification_matrix', claims, evidence, policies: [], events };
}
function passingEntries(id, definition = original) {
  return gate(id, definition).expects.filter((entry) => entry.required).map((entry) => ({
    id: entry.id, claimType: entry.bundle_claim.claimType, subjectType: entry.bundle_claim.subjectType,
  }));
}
async function run(definition, entries) {
  fs.mkdirSync(fixture, { recursive: true });
  fs.writeFileSync(path.join(fixture, 'flow.json'), JSON.stringify(definition, null, 2));
  await startRun('flow.json', { cwd: fixture, runId: 'certification-run', params: { subject: 'work-item/certification' } });
  const targetIndex = orderedGates.indexOf(gateId);
  if (targetIndex < 0) throw new Error(`unknown ordered gate ${gateId}`);
  for (const priorGate of orderedGates.slice(0, targetIndex)) {
    const priorFile = path.join(fixture, `prior-${priorGate}.bundle.json`);
    fs.writeFileSync(priorFile, JSON.stringify(bundle(passingEntries(priorGate, definition)), null, 2));
    await attachEvidence('certification-run', { cwd: fixture, gate: priorGate, file: priorFile, kind: 'trust.bundle', bundle: true });
    const priorEvaluation = await evaluateRun('certification-run', { cwd: fixture });
    if (priorEvaluation.outcomes?.at(-1)?.status !== 'pass') throw new Error(`could not advance fixture through ${priorGate}`);
  }
  const before = await loadRun('certification-run', fixture);
  const evidenceFile = path.join(fixture, 'trust.bundle.json');
  fs.writeFileSync(evidenceFile, JSON.stringify(bundle(entries), null, 2));
  await attachEvidence('certification-run', { cwd: fixture, gate: gateId, file: evidenceFile, kind: 'trust.bundle', bundle: true });
  const evaluated = await evaluateRun('certification-run', { cwd: fixture });
  const after = await loadRun('certification-run', fixture);
  const outcome = evaluated.outcomes?.at(-1);
  process.stdout.write(JSON.stringify({ before: before.state, after: after.state, outcome, gate: gate(gateId, definition) }) + '\n');
}

if (mode === 'fires') await run(original, passingEntries(gateId));
else if (mode === 'refusal') await run(original, []);
else if (mode === 'plant-missing') await run(original, []);
else if (mode === 'disabled') {
  const weakened = clone(original);
  // Disable only this gate's expectation check in the isolated fixture.
  weakened.gates[gateId].expects = weakened.gates[gateId].expects.map((entry) => ({ ...entry, required: false }));
  await run(validateDefinition(weakened), []);
} else throw new Error(`unknown mode ${mode}`);
NODE

flow_agents_build_ts || { echo "FAIL: build failed"; exit 1; }

run_case() {
  local gate="$1"
  local mode="$2"
  local output="$TMP/${gate}-${mode}.json"
  if node "$DRIVER" "$ROOT" "$TMP/${gate}-${mode}-${RANDOM}" "$mode" "$gate" >"$output" 2>"$output.err"; then
    printf '%s' "$output"
    return 0
  fi
  sed -n '1,80p' "$output.err" >&2
  return 1
}

assert_fires() {
  local gate="$1" next="$2" output
  if output="$(run_case "$gate" fires)" \
    && node - "$output" "$next" <<'NODE'
const fs = require('fs');
const [file, next] = process.argv.slice(2);
const x = JSON.parse(fs.readFileSync(file, 'utf8'));
if (x.outcome?.status !== 'pass') process.exit(1);
if (x.before.current_step === x.after.current_step || x.after.current_step !== next) process.exit(1);
NODE
  then cert "$gate" FIRES "complete declared evidence advances to $next"
  else failed=1; fail "$gate / FIRES — complete evidence did not advance the canonical run"; fi
}

assert_refusal() {
  local gate="$1" output
  if output="$(run_case "$gate" refusal)" \
    && node - "$output" <<'NODE'
const fs = require('fs');
const x = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const expected = x.gate.expects.filter((entry) => entry.required);
const summary = String(x.outcome?.summary || '');
if (x.outcome?.status === 'pass') process.exit(1);
if (!expected.some((entry) => summary.includes(entry.description))) process.exit(1);
NODE
  then cert "$gate" REFUSES-WITH-REMEDIATION "refusal names the missing declared expectation (including an explicit route-back where configured)"
  else uncertified "$gate" REFUSES-WITH-REMEDIATION "refusal did not include a declared expectation description as remediation"; fi
}

# For the first three classes, absence is the defect itself.
assert_useful_missing() {
  local gate="$1" output
  if output="$(run_case "$gate" plant-missing)" \
    && node - "$output" <<'NODE'
const fs = require('fs'); const x = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (x.outcome?.status === 'pass') process.exit(1);
NODE
  then cert "$gate" USEFUL "planted missing required evidence is caught"
  else ceremony "$gate" USEFUL "missing required evidence advanced the run"; fi
}
assert_verify_execution_proof() {
  # This is deliberately the Builder runtime path, not the bare Flow reducer.
  # The fixture creates a passing builder.verify.tests claim, removes its real
  # observed_commands execution proof, and requires writeAndSync to reject it.
  if node "$ROOT/scripts/build-test-support.mjs" >"$TMP/verify-test-support.log" 2>&1 \
    && node --test --test-name-pattern 'passing tests-evidence without an observation array' \
    "$ROOT/src/cli/builder-flow-runtime.test.mjs" >"$TMP/verify-no-proof.tap" 2>&1; then
    cert verify-gate USEFUL "real plant refused: passing tests-evidence with no observed command execution proof"
  else
    fail "verify-gate / USEFUL — the Builder runtime no-execution-proof plant did not run or was accepted"
  fi
}

assert_fires pull-work-gate design-probe
assert_refusal pull-work-gate
assert_useful_missing pull-work-gate
assert_fires design-probe-gate plan
assert_refusal design-probe-gate
assert_useful_missing design-probe-gate
assert_fires plan-gate execute
assert_refusal plan-gate
assert_useful_missing plan-gate
assert_fires execute-gate verify
assert_refusal execute-gate
# A builder.execute.scope claim has no schema field for the claimed paths, and
# this reducer fixture has no diff/workspace snapshot input. It can see only a
# typed verified claim plus attached bundle metadata, so it cannot compare a
# claimed scope with actual modified files.
uncertified execute-gate USEFUL "can see typed/signed scope claims and optional freshness snapshots; cannot see a claimed file set or compare it with the workspace diff"
assert_fires verify-gate merge-ready
assert_refusal verify-gate
assert_verify_execution_proof
assert_fires merge-ready-gate pr-open
assert_refusal merge-ready-gate
# Flow ordering proves earlier gates passed, but this gate itself receives only
# builder.merge-ready.readiness. It has no input naming an independently
# required upstream expectation or its failing status to check.
uncertified merge-ready-gate USEFUL "can see the readiness claim and canonical prior Flow state; cannot inspect an independently supplied required upstream expectation/failure"

# POWER: remove the checks only from a copied fixture, prove omission advances,
# then rerun the normal missing-evidence plant to prove the shipped definition
# remains green. These are intentionally explicit verdict lines for CI logs.
for gate in pull-work-gate design-probe-gate plan-gate verify-gate; do
  disabled="$TMP/${gate}-disabled.json"
  restored="$TMP/${gate}-plant-missing.json"
  if run_case "$gate" disabled >/dev/null \
    && node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(x.outcome?.status!=="pass"||x.before.current_step===x.after.current_step)process.exit(1)' "$disabled" \
    && run_case "$gate" plant-missing >/dev/null \
    && node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(x.outcome?.status==="pass")process.exit(1)' "$restored"; then
    echo "POWER $gate: injected FIRES=RED USEFUL=RED; restored FIRES=GREEN USEFUL=GREEN"
  else echo "POWER $gate: injected/restored verdict HARNESS-FAIL"; harness_failures=$((harness_failures + 1)); fi
done

covered pr-open-gate FIRES "builder.publish-learn follow-on"
covered pr-open-gate REFUSES-WITH-REMEDIATION "builder.publish-learn follow-on"
covered pr-open-gate USEFUL "builder.publish-learn follow-on"
covered merge-ready-ci-gate FIRES "builder.publish-learn follow-on"
covered merge-ready-ci-gate REFUSES-WITH-REMEDIATION "builder.publish-learn follow-on"
covered merge-ready-ci-gate USEFUL "builder.publish-learn follow-on"
covered learn-gate FIRES "builder.publish-learn follow-on"
covered learn-gate REFUSES-WITH-REMEDIATION "builder.publish-learn follow-on"
covered learn-gate USEFUL "builder.publish-learn follow-on"

echo
printf '%-22s | %-28s | %-44s | %-44s\n' 'GATE' 'FIRES' 'REFUSES-WITH-REMEDIATION' 'USEFUL'
printf '%s\n' '-----------------------+------------------------------+----------------------------------------------+----------------------------------------------'
for gate in pull-work-gate design-probe-gate plan-gate execute-gate verify-gate merge-ready-gate pr-open-gate merge-ready-ci-gate learn-gate; do
  printf '%-22s | %-28s | %-44s | %-44s\n' "$gate" "$(get_cell "$gate" FIRES)" "$(get_cell "$gate" REFUSES-WITH-REMEDIATION)" "$(get_cell "$gate" USEFUL)"
done

if [[ $harness_failures -gt 0 ]]; then
  echo "GATE CERTIFICATION MATRIX: HARNESS-FAIL ($harness_failures assertions/power probes)"
  exit 1
fi
echo "GATE CERTIFICATION MATRIX: COMPLETE (findings are machine-readable cells; only harness failures fail this eval)"
