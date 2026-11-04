// Admission policy is checked on ORIGINAL YAML, before any lint compatibility copy.
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import assert from 'node:assert/strict';

export const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
// Participating workflows and their jobs. There is NO repo-wide job-level compute
// cap: GitHub's job-level `queue: max` admission stalled repeatedly on
// 2026-11-03/04 (runs sat pending with every group empty), and the repository is
// public, so hosted minutes are free. The only concurrency control is each
// workflow's own per-ref group with cancel-in-progress, so a new push supersedes
// that branch's older run.
export const participants = {
  'ci.yml': ['secret-scan', 'source-and-static', 'workflow-contracts',
    'runtime-and-kit', 'integration-coverage', 'usage-feedback', 'windows-hook-smoke'],
  'runtime-compat.yml': ['harness-canary', 'framework-sdk-canary', 'report'],
  'veritas-advisory.yml': ['readiness'],
  'docs.yml': ['gate', 'pages'],
  'kit-gates-demo.yml': ['release-evidence-gate-demo'],
};
// Exact per-ref supersession group of each participating workflow. The only
// identity in a name is the workflow's own ref, so a push cancels that branch's
// previous run and never another branch's.
export const refGroups = {
  'ci.yml': 'flow-agents-ci-${{ github.ref }}',
  'runtime-compat.yml': 'flow-agents-runtime-compat-${{ github.ref }}',
  'veritas-advisory.yml': 'veritas-advisory-${{ github.ref }}',
  'docs.yml': 'flow-agents-docs-${{ github.ref }}',
  'kit-gates-demo.yml': 'flow-agents-kit-gates-demo-${{ github.ref }}',
};
// These controllers are outside the participating budget. New workflows/jobs must
// receive an explicit classification, rather than silently escaping the bound.
export const exclusions = {
  'publish-npm.yml': ['verify', 'publish'],
  'release-please.yml': ['release-please'],
  'add-to-project.yml': ['add-to-project'],
};
export function loadWorkflows(directory = join(root, '.github/workflows')) {
  return Object.fromEntries(readdirSync(directory).filter(x => /\.ya?ml$/.test(x))
    .map(file => [file, parse(readFileSync(join(directory, file), 'utf8'))]));
}
const sorted = value => [...value].sort();
const needs = job => job.needs === undefined ? [] : [job.needs].flat();
const triggers = on => typeof on === 'string' ? [on] : Array.isArray(on) ? on : Object.keys(on ?? {});
export function matrixChildren(job) {
  if (!job.strategy) return [{}];
  assert.deepEqual(Object.keys(job.strategy).filter(x => x !== 'fail-fast'), ['matrix'], 'unreviewed strategy');
  const matrix = job.strategy.matrix;
  // Exact current include-only expansion. Dynamic/product/exclude growth requires review.
  assert.deepEqual(Object.keys(matrix), ['include'], 'unreviewed matrix expansion');
  assert.ok(Array.isArray(matrix.include) && matrix.include.length > 0);
  return matrix.include;
}
export function validate(workflows = loadWorkflows(), fixtureDirectory = join(root, 'evals/fixtures/ci-compute')) {
  assert.deepEqual(sorted(Object.keys(workflows)), sorted([...Object.keys(participants), ...Object.keys(exclusions)]), 'unclassified workflow');
  const lock = JSON.parse(readFileSync(join(fixtureDirectory, 'lock.json')));
  const expanded = [];
  for (const [file, workflow] of Object.entries(workflows)) {
    assert.deepEqual(sorted(Object.keys(workflow.jobs)), sorted(participants[file] ?? exclusions[file]), `${file}: omitted/unclassified job`);
    if (!participants[file]) {
      // Exclusions cannot turn into PR compute without an explicit policy revision.
      assert.ok(!triggers(workflow.on).some(x => ['pull_request', 'pull_request_target', 'merge_group'].includes(x)), `${file}: PR bypass`);
      continue;
    }
    assert.deepEqual(workflow.concurrency, { group: refGroups[file], 'cancel-in-progress': true },
      `${file}: per-ref cancel-in-progress group required`);
    for (const [id, job] of Object.entries(workflow.jobs)) {
      assert.equal(job.concurrency, undefined, `${file}/${id}: job-level concurrency is not allowed (no repo-wide compute cap)`);
      const children = matrixChildren(job);
      if (file === 'runtime-compat.yml' && id === 'harness-canary') {
        assert.deepEqual(children.map(x => x.runtime), ['opencode', 'pi'], 'review matrix child budget');
      } else assert.equal(children.length, 1, 'unreviewed matrix');
      let runners = [id];
      if (job.uses) {
        assert.ok(!job['runs-on'] && !job.steps && !job.strategy, 'invalid reusable call');
        const entry = lock[job.uses];
        assert.ok(entry && /@[0-9a-f]{40}$/.test(job.uses), `${file}/${id}: unreviewed callee pin`);
        const bytes = readFileSync(join(fixtureDirectory, entry.file));
        assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, 'callee snapshot digest');
        const callee = parse(bytes.toString());
        assert.equal(callee.concurrency, undefined, 'unreviewed callee workflow concurrency');
        runners = Object.keys(callee.jobs);
        const ancestors = (key, seen = new Set()) => {
          assert.ok(callee.jobs[key], 'unknown callee dependency');
          assert.ok(!seen.has(key), 'callee cycle');
          return needs(callee.jobs[key]).flatMap(parent => [parent, ...ancestors(parent, new Set([...seen, key]))]);
        };
        for (const [key, child] of Object.entries(callee.jobs)) {
          assert.ok(child['runs-on'] && !child.uses && !child.strategy, 'unreviewed nested/matrix callee');
          // Only this exact existing inner group is reviewed. Reject arbitrary
          // expressions, shorthand and case variants rather than guessing whether
          // they could resolve to a caller group (GitHub is case-insensitive).
          assert.deepEqual(child.concurrency, entry.file === 'docs-pages.yml' && key === 'deploy'
            ? { group: 'docs-pages-${{ github.repository }}', 'cancel-in-progress': false } : undefined,
          'unreviewed callee concurrency (a callee group would reintroduce a shared queue)');
          const before = ancestors(key);
          for (const other of runners) {
            assert.ok(other === key || before.includes(other) || ancestors(other).includes(key), 'callee concurrent runner expansion exceeds one');
          }
        }
      } else assert.ok(job['runs-on'] && job.steps, 'runner job missing');
      for (const child of children) expanded.push({ file, id, child, runners, needs: needs(job) });
    }
  }
  return expanded;
}
// Real paths: a symlinked invocation path must not make the CLI silently skip validation.
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const expanded = validate();
  console.log(JSON.stringify({ participatingJobs: expanded.length, expandedRunnerJobs: expanded.reduce((n, x) => n + x.runners.length, 0), expanded }, null, 2));
}
