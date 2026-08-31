#!/usr/bin/env bash
# test_ci_check_registration.sh — Layer 1: the CI check registry must agree with
# the workflow that runs it (#1362).
#
# Registering one suite takes edits in three places, and they fail in different
# directions:
#
#   1. evals/ci/run-baseline.sh CHECKS  — missing => `workflow evidence` refuses
#      the tests-evidence claim. Fails CLOSED and LOUDLY, at registration time.
#   2. a LANE_* array               — missing => emit_manifest_json skips the
#      entry, so it never reaches the reconcile manifest. Fails CLOSED, quietly.
#   3. a .github/workflows/ci.yml `--check` step — missing => nothing at
#      registration time notices, and from the next run onward
#      ensure_expected_results writes `fail / "missing CI result row"` and
#      finalize_results exits 1. Fails OPEN locally and RED in CI, on every
#      subsequent run, for everyone.
#
# Case 3 shipped for real: an 18th check was added to LANE_SOURCE_AND_STATIC
# with no step, and the lane went red with
# `| FAIL | ... | missing CI result row | |` until a reviewer simulated it.
# This audit derives the agreement instead of trusting three files to be edited
# together, so the missing step is named at commit time.
#
# It also pins the OTHER half of "registered" — that a suite file which exists
# actually runs somewhere CI reaches. A test that gates nothing is
# indistinguishable from a test that passes.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "── CI check registration agreement ──"

node - "$ROOT" <<'NODE'
const fs = require('fs');
const path = require('path');

const root = process.argv[2];
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// Suites that exist but are deliberately NOT wired into a CI-reachable runner.
// The reason is the value so this machine check fails closed on an empty one.
const UNWIRED_SUITE_EXEMPTIONS = {
  'evals/static/test_kit_observability_contract.sh':
    'Green but redundant: both suites it runs (src/cli/kit-observability-contract.test.mjs and src/cli/kit-observability-conformance.test.mjs) already execute in the CI-covered unit corpus, and this wrapper rebuilds the universal bundles first. Wiring it into run_static would add a bundle rebuild to a required lane for zero additional coverage. Kept as a standalone developer entry point.',
};

// Node proof wrappers whose shell subject is deliberately outside run_static().
// The exact CHECKS command is the reviewed contract: arbitrary wrapper source,
// including comments that merely name a shell suite, never establishes coverage.
const REVIEWED_DIRECT_STATIC_WRAPPERS = {
  'node --test evals/ci/codex-pr-review-action.test.mjs': {
    wrapper: 'evals/ci/codex-pr-review-action.test.mjs',
    subject: 'evals/static/test_codex_pr_review_action.sh',
  },
};

// CHECKS entries that are deliberately in no lane at all. A lane-less entry runs
// in no CI job, so it gates nothing; it must be justified, not merely absent.
const LANELESS_CHECK_EXEMPTIONS = {};

function slugify(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ---------------------------------------------------------------------------
// The registry — evals/ci/run-baseline.sh
// ---------------------------------------------------------------------------
const runBaseline = read('evals/ci/run-baseline.sh');

function bashArray(name) {
  const match = runBaseline.match(new RegExp(`^${name}=\\(([\\s\\S]*?)^\\)`, 'm'));
  if (!match) throw new Error(`evals/ci/run-baseline.sh no longer defines ${name}`);
  return [...match[1].matchAll(/"([^"\n]+)"/g)].map((entry) => entry[1]);
}

const problems = [];

const checks = new Map();
for (const entry of bashArray('CHECKS')) {
  const separator = entry.indexOf('|');
  if (separator < 0) {
    problems.push(`CHECKS entry is not "label|command": ${entry}`);
    continue;
  }
  const label = entry.slice(0, separator);
  const command = entry.slice(separator + 1);
  const id = slugify(label);
  if (checks.has(id)) {
    problems.push(`Two CHECKS entries slugify to the same id '${id}': ${checks.get(id).label} / ${label}`);
    continue;
  }
  checks.set(id, { id, label, command, lanes: [] });
}

// Lane arrays, and the lane ids run-baseline.sh itself accepts. Deriving the
// accepted lanes from lane_labels() means a lane added there without a lane
// array (or without a CI job) is caught rather than silently unrunnable.
const LANE_ARRAYS = {
  'source-and-static': 'LANE_SOURCE_AND_STATIC',
  'workflow-contracts': 'LANE_WORKFLOW_CONTRACTS',
  'runtime-and-kit': 'LANE_RUNTIME_AND_KIT',
  'integration-coverage': 'LANE_INTEGRATION_COVERAGE',
  'usage-feedback': 'LANE_USAGE_FEEDBACK',
};

const laneCaseBody = runBaseline.match(/lane_labels\(\)\s*\{[\s\S]*?\n\}/);
if (!laneCaseBody) {
  problems.push('evals/ci/run-baseline.sh no longer defines lane_labels()');
} else {
  const declared = [...laneCaseBody[0].matchAll(/^ {4}([a-z][a-z0-9-]*)\)$/gm)]
    .map((match) => match[1])
    .filter((lane) => lane !== 'all');
  for (const lane of declared) {
    if (!Object.hasOwn(LANE_ARRAYS, lane)) {
      problems.push(`lane_labels() accepts lane '${lane}' that this audit does not know about; add it to LANE_ARRAYS.`);
    }
  }
  for (const lane of Object.keys(LANE_ARRAYS)) {
    if (!declared.includes(lane)) {
      problems.push(`This audit expects lane '${lane}' but lane_labels() no longer accepts it.`);
    }
  }
}

const laneMembers = new Map();
for (const [lane, arrayName] of Object.entries(LANE_ARRAYS)) {
  const labels = bashArray(arrayName);
  laneMembers.set(lane, labels);
  const seen = new Set();
  for (const label of labels) {
    if (seen.has(label)) {
      problems.push(`${arrayName} lists '${label}' twice; the lane would run it twice and finalize would record duplicate result rows.`);
    }
    seen.add(label);
    const check = checks.get(slugify(label));
    if (!check) {
      problems.push(`${arrayName} lists '${label}', which is not a CHECKS entry — the lane would abort with "Unknown CI baseline check".`);
      continue;
    }
    check.lanes.push(lane);
  }
}

for (const check of checks.values()) {
  if (check.lanes.length > 0) continue;
  const exemption = LANELESS_CHECK_EXEMPTIONS[check.label];
  if (typeof exemption === 'string' && exemption.trim().length >= 12) continue;
  problems.push(
    `CHECKS entry '${check.label}' is in no LANE_* array, so it runs in no CI job and gates nothing. ` +
      'Add it to a lane, or record a reason in LANELESS_CHECK_EXEMPTIONS.',
  );
}

for (const label of Object.keys(LANELESS_CHECK_EXEMPTIONS)) {
  const check = checks.get(slugify(label));
  if (!check) {
    problems.push(`LANELESS_CHECK_EXEMPTIONS names '${label}', which is not a CHECKS entry; remove it.`);
  } else if (check.lanes.length > 0) {
    problems.push(`LANELESS_CHECK_EXEMPTIONS names '${label}', which now runs in lane(s) ${check.lanes.join(', ')}; remove the exemption.`);
  }
}

// ---------------------------------------------------------------------------
// The workflow that must agree with the registry — .github/workflows/ci.yml
// ---------------------------------------------------------------------------
const ci = read('.github/workflows/ci.yml');
const jobsIndex = ci.search(/^jobs:$/m);
if (jobsIndex < 0) throw new Error('.github/workflows/ci.yml has no top-level jobs: block');
const jobsBlock = ci.slice(jobsIndex);

const jobs = [];
for (const match of jobsBlock.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)) {
  jobs.push({ name: match[1], start: match.index });
}
for (let i = 0; i < jobs.length; i += 1) {
  jobs[i].body = jobsBlock.slice(jobs[i].start, i + 1 < jobs.length ? jobs[i + 1].start : jobsBlock.length);
}

const laneJobs = new Map();
for (const job of jobs) {
  const laneMatch = job.body.match(/^\s*FLOW_AGENTS_CI_LANE:\s*(\S+)\s*$/m);
  if (!laneMatch) continue;
  const lane = laneMatch[1];
  if (laneJobs.has(lane)) {
    problems.push(`Two ci.yml jobs declare FLOW_AGENTS_CI_LANE: ${lane} (${laneJobs.get(lane).name}, ${job.name}).`);
    continue;
  }
  // Only `run:` lines count. A --check named in a comment runs nothing.
  job.stepIds = [...job.body.matchAll(/^\s*run:\s*bash evals\/ci\/run-baseline\.sh --check ([A-Za-z0-9-]+)\s*$/gm)].map(
    (match) => match[1],
  );
  job.lane = lane;
  laneJobs.set(lane, job);
}

for (const lane of Object.keys(LANE_ARRAYS)) {
  if (!laneJobs.has(lane)) {
    problems.push(`Lane '${lane}' has checks registered but no ci.yml job sets FLOW_AGENTS_CI_LANE: ${lane}; nothing runs them.`);
  }
}

for (const [lane, job] of laneJobs) {
  const expected = (laneMembers.get(lane) || []).map((label) => ({ label, id: slugify(label) }));
  if (!laneMembers.has(lane)) {
    problems.push(`ci.yml job '${job.name}' runs lane '${lane}', which run-baseline.sh does not define.`);
    continue;
  }
  const present = new Map();
  for (const id of job.stepIds) present.set(id, (present.get(id) || 0) + 1);

  for (const { label, id } of expected) {
    if (!present.has(id)) {
      // The message names the step to add verbatim: this is the diagnostic the
      // #1362 blocker never produced.
      problems.push(
        `Lane '${lane}' registers check '${label}' but ci.yml job '${job.name}' has no step running it. ` +
          `finalize_results will record "missing CI result row" and exit 1 on every run. Add:\n` +
          `        - name: ${label}\n` +
          `          continue-on-error: true\n` +
          `          run: bash evals/ci/run-baseline.sh --check ${id}`,
      );
    }
  }

  for (const [id, count] of present) {
    const check = checks.get(id);
    if (!check) {
      problems.push(`ci.yml job '${job.name}' runs --check ${id}, which is not a CHECKS entry (the step exits 2).`);
      continue;
    }
    if (!check.lanes.includes(lane)) {
      problems.push(
        `ci.yml job '${job.name}' runs --check ${id} ('${check.label}'), but that check is not in lane '${lane}' ` +
          `(lanes: ${check.lanes.join(', ') || 'none'}); the step exits 2 with "Unknown CI baseline check for lane ${lane}".`,
      );
    }
    if (count > 1) {
      problems.push(`ci.yml job '${job.name}' runs --check ${id} ${count} times; finalize_results records duplicate result rows and fails.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Suites that exist must run somewhere CI reaches
// ---------------------------------------------------------------------------
// Static evals may be reached through the aggregate runner or registered as an
// exact required-lane command. Derive both paths and reject duplicate execution.
const staticEntryCheck = [...checks.values()].find((check) => /evals\/run\.sh\s+static\b/.test(check.command));
if (!staticEntryCheck) {
  problems.push('No CHECKS entry runs `evals/run.sh static`; the static eval layer would gate nothing.');
} else if (staticEntryCheck.lanes.length === 0) {
  problems.push(`The static eval entry check '${staticEntryCheck.label}' is in no lane, so the static layer gates nothing.`);
}

const runSh = read('evals/run.sh');
const runStatic = runSh.match(/run_static\(\)\s*\{[\s\S]*?\n\}/);
if (!runStatic) {
  problems.push('evals/run.sh no longer defines run_static(); cannot derive which static suites run.');
}
const wiredStatic = new Set(
  runStatic ? [...runStatic[0].matchAll(/static\/(test_[A-Za-z0-9_-]+\.sh)/g)].map((match) => `evals/static/${match[1]}`) : [],
);

function directStaticSubjects(command) {
  const directShell = command.match(/^bash (evals\/static\/test_[A-Za-z0-9_-]+\.sh)$/);
  if (directShell) return [directShell[1]];
  const reviewedWrapper = REVIEWED_DIRECT_STATIC_WRAPPERS[command];
  return reviewedWrapper ? [reviewedWrapper.subject] : [];
}

// Negative control: the old implementation scanned wrapper text, so this
// comment alone could counterfeit execution. Coverage now depends only on an
// exact executable command or the reviewed mapping above.
const commentOnlyWrapper = '// bash evals/static/test_codex_pr_review_action.sh';
if (!commentOnlyWrapper.includes('evals/static/test_codex_pr_review_action.sh') ||
    directStaticSubjects('synthetic-comment-only-wrapper-token').length !== 0) {
  problems.push('A comment-only shell path counted as direct static execution.');
}

const directlyCheckedStatic = new Set();
const usedReviewedWrappers = new Set();
for (const check of checks.values()) {
  if (check.lanes.length === 0) continue;
  for (const subject of directStaticSubjects(check.command)) directlyCheckedStatic.add(subject);
  if (Object.hasOwn(REVIEWED_DIRECT_STATIC_WRAPPERS, check.command)) usedReviewedWrappers.add(check.command);
}
for (const [command, binding] of Object.entries(REVIEWED_DIRECT_STATIC_WRAPPERS)) {
  if (!usedReviewedWrappers.has(command)) {
    problems.push(`Reviewed direct static wrapper is not a required-lane CHECKS command: ${command}`);
  }
  if (!fs.existsSync(path.join(root, binding.wrapper))) {
    problems.push(`Reviewed direct static wrapper is missing: ${binding.wrapper}`);
  }
  if (!fs.existsSync(path.join(root, binding.subject))) {
    problems.push(`Reviewed direct static subject is missing: ${binding.subject}`);
  }
}
const coveredStatic = new Set([...wiredStatic, ...directlyCheckedStatic]);

const allStatic = fs
  .readdirSync(path.join(root, 'evals/static'))
  .filter((file) => /^test_.*\.sh$/.test(file))
  .map((file) => `evals/static/${file}`)
  .sort();

for (const suite of allStatic) {
  if (coveredStatic.has(suite)) continue;
  const exemption = UNWIRED_SUITE_EXEMPTIONS[suite];
  if (typeof exemption === 'string' && exemption.trim().length >= 12) continue;
  problems.push(`Static eval '${suite}' exists but no required-lane check reaches it, so it gates nothing and has no reasoned exemption.`);
}

for (const [suite, reason] of Object.entries(UNWIRED_SUITE_EXEMPTIONS)) {
  if (!allStatic.includes(suite)) {
    problems.push(`UNWIRED_SUITE_EXEMPTIONS references a missing static eval: ${suite}`);
  } else if (coveredStatic.has(suite)) {
    problems.push(`Exempted static eval is now reached by a required-lane check; remove the exemption: ${suite}`);
  } else if (typeof reason !== 'string' || reason.trim().length < 12) {
    problems.push(`Exemption for ${suite} must include a concrete reason.`);
  }
}

for (const suite of coveredStatic) {
  if (!fs.existsSync(path.join(root, suite))) {
    problems.push(`A required-lane check reaches a missing static eval: ${suite}`);
  }
}

for (const suite of directlyCheckedStatic) {
  if (wiredStatic.has(suite)) {
    problems.push(`Static eval '${suite}' runs both directly and through run_static(); keep exactly one hosted execution path.`);
  }
}

// ---------------------------------------------------------------------------
// Unit corpus: every src/cli/*.test.mjs must be reached by something CI runs
// ---------------------------------------------------------------------------
// Most unit suites are NOT named individually in CHECKS. They gate as a corpus:
// evals/static/test_unit_helpers.sh runs `node --test src/cli/*.test.mjs`, which
// a required-lane static path invokes. That whole chain is load-bearing and
// nothing asserted it. Narrowing the
// glob to a hand-written list — the obvious way to speed the suite up — would
// silently drop every file left out. So: expand what the wired runners actually
// pass to `node --test`, and require the union to cover the corpus.
const unitFiles = fs
  .readdirSync(path.join(root, 'src/cli'))
  .filter((file) => /\.test\.mjs$/.test(file))
  .map((file) => `src/cli/${file}`)
  .sort();

const coveredUnits = new Map();

function recordNodeTestArgs(argsText, source) {
  for (const rawArg of argsText.trim().split(/\s+/)) {
    if (!rawArg || rawArg.startsWith('-')) continue;
    const arg = rawArg.replace(/^["']|["']$/g, '');
    if (arg.includes('*')) {
      const pattern = new RegExp(`^${arg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
      for (const file of unitFiles) if (pattern.test(file)) coveredUnits.set(file, source);
    } else if (unitFiles.includes(arg)) {
      coveredUnits.set(arg, source);
    }
  }
}

for (const check of checks.values()) {
  if (check.lanes.length === 0) continue;
  for (const match of check.command.matchAll(/node --test ([^&|;]+)/g)) {
    recordNodeTestArgs(match[1], `CHECKS: ${check.label}`);
  }
}

for (const suite of [...coveredStatic].sort()) {
  const suitePath = path.join(root, suite);
  if (!fs.existsSync(suitePath)) continue;
  const text = fs.readFileSync(suitePath, 'utf8');
  for (const match of text.matchAll(/node --test ([^&|;\n]+)/g)) {
    recordNodeTestArgs(match[1], suite);
  }
}

for (const file of unitFiles) {
  if (coveredUnits.has(file)) continue;
  problems.push(
    `Unit suite '${file}' is not run by any CI-covered check: it is neither named in a lane-covered CHECKS command ` +
      'nor matched by a `node --test` invocation in a required-lane-covered static eval. It gates nothing.',
  );
}

if (problems.length) {
  console.error('  FAIL: CI check registration audit failed:');
  for (const problem of problems.sort()) console.error(`    - ${problem}`);
  process.exit(1);
}

const laneSummary = [...laneJobs.keys()]
  .sort()
  .map((lane) => `${lane}:${(laneMembers.get(lane) || []).length}`)
  .join(' ');
console.log(
  `  PASS: ${checks.size} checks registered, ${laneSummary}; ` +
    `${allStatic.length} static evals (${Object.keys(UNWIRED_SUITE_EXEMPTIONS).length} exempt), ` +
    `${unitFiles.length} unit suites CI-covered.`,
);
NODE
