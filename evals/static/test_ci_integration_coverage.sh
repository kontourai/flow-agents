#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

node - "$ROOT" <<'NODE'
const fs = require('fs');
const path = require('path');

const root = process.argv[2];
const rel = (...parts) => path.join(...parts).replace(/\\/g, '/');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// Baseline-red in #297: stop-goal-fit fixture still emits no disputed-claim
// gate hint. Do not wire until fixed by the owning gate/claim-lookup work.
// Reason is duplicated in the value so this machine check can fail closed.
const EXEMPTIONS = {
  'evals/integration/test_claim_lookup.sh':
    'Baseline-red in #297: stop-goal-fit fixture emits no disputed-claim gate hint.',

  // Baseline-red in #297: goal-fit block streak fixture now exits 0 instead of
  // the expected block/release sequence. This touches hook/gate behavior, which
  // is explicitly out of scope for #297.
  'evals/integration/test_goal_fit_escape_hatch.sh':
    'Baseline-red in #297: goal-fit block streak fixture exits 0 instead of block/release sequence.',
};

function slugify(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function integrationTestsIn(text) {
  return [...text.matchAll(/evals\/integration\/test_[A-Za-z0-9_-]+\.sh/g)].map((m) => m[0]);
}

const integrationDir = path.join(root, 'evals/integration');
const allIntegration = fs
  .readdirSync(integrationDir)
  .filter((file) => /^test_.*\.sh$/.test(file))
  .map((file) => rel('evals/integration', file))
  .sort();

const runBaseline = read('evals/ci/run-baseline.sh');
const checks = new Map();
for (const match of runBaseline.matchAll(/"([^"\n]+)\|([^"\n]+)"/g)) {
  const [, label, command] = match;
  checks.set(slugify(label), { label, command });
}

const ci = read('.github/workflows/ci.yml');
const ciCheckIds = [
  ...ci.matchAll(/run:\s*bash evals\/ci\/run-baseline\.sh --check ([a-z0-9-]+)/g),
].map((match) => match[1]);

const covered = new Map();
const unknownChecks = [];

for (const checkId of ciCheckIds) {
  const check = checks.get(checkId);
  if (!check) {
    unknownChecks.push(checkId);
    continue;
  }

  const directTests = integrationTestsIn(check.command);
  for (const test of directTests) covered.set(test, check.label);

  const suiteScripts = [...check.command.matchAll(/evals\/ci\/[A-Za-z0-9_-]+\.sh/g)].map((m) => m[0]);
  for (const suiteScript of suiteScripts) {
    const suitePath = path.join(root, suiteScript);
    if (!fs.existsSync(suitePath)) {
      throw new Error(`CI check '${check.label}' references missing suite script: ${suiteScript}`);
    }
    for (const test of integrationTestsIn(fs.readFileSync(suitePath, 'utf8'))) {
      covered.set(test, `${check.label} (${suiteScript})`);
    }
  }
}

const problems = [];
for (const checkId of unknownChecks) {
  problems.push(`CI invokes unknown run-baseline check id: ${checkId}`);
}

for (const [test, reason] of Object.entries(EXEMPTIONS)) {
  if (!allIntegration.includes(test)) {
    problems.push(`Exemption references missing integration eval: ${test}`);
  }
  if (typeof reason !== 'string' || reason.trim().length < 12) {
    problems.push(`Exemption for ${test} must include a concrete reason.`);
  }
  if (covered.has(test)) {
    problems.push(`Exempted integration eval is also CI-covered; remove exemption: ${test}`);
  }
}

for (const test of allIntegration) {
  if (covered.has(test) || Object.hasOwn(EXEMPTIONS, test)) continue;
  problems.push(`Integration eval is not covered by CI and has no reasoned exemption: ${test}`);
}

for (const test of covered.keys()) {
  if (!allIntegration.includes(test)) {
    problems.push(`CI references missing integration eval: ${test}`);
  }
}

if (problems.length) {
  console.error('CI integration coverage audit failed:');
  for (const problem of problems.sort()) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`CI integration coverage audit passed: ${covered.size} covered, ${Object.keys(EXEMPTIONS).length} exempted.`);
NODE
