// Admission policy is checked on ORIGINAL YAML, before any lint compatibility copy.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import assert from 'node:assert/strict';

export const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const assignments = {
  'ci.yml': { 'secret-scan': 1, 'source-and-static': 2, 'workflow-contracts': 1,
    'runtime-and-kit': 2, 'integration-coverage': 1, 'usage-feedback': 2, 'windows-hook-smoke': 1 },
  'runtime-compat.yml': { 'harness-canary': 1, 'framework-sdk-canary': 2, report: 1 },
  'veritas-advisory.yml': { readiness: 2 },
  'docs.yml': { gate: 1, pages: 2 },
  'kit-gates-demo.yml': { 'release-evidence-gate-demo': 1 },
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
  assert.deepEqual(sorted(Object.keys(workflows)), sorted([...Object.keys(assignments), ...Object.keys(exclusions)]), 'unclassified workflow');
  const lock = JSON.parse(readFileSync(join(fixtureDirectory, 'lock.json')));
  const expanded = [];
  for (const [file, workflow] of Object.entries(workflows)) {
    assert.deepEqual(sorted(Object.keys(workflow.jobs)), sorted(Object.keys(assignments[file] ?? Object.fromEntries(exclusions[file].map(x => [x, true])))), `${file}: omitted/unclassified job`);
    if (!assignments[file]) {
      // Exclusions cannot turn into PR compute without an explicit policy revision.
      assert.ok(!triggers(workflow.on).some(x => ['pull_request', 'pull_request_target', 'merge_group'].includes(x)), `${file}: PR bypass`);
      continue;
    }
    assert.deepEqual(workflow.concurrency, file === 'ci.yml'
      ? { group: 'flow-agents-ci-${{ github.ref }}', 'cancel-in-progress': true } : undefined,
    `${file}: workflow cancellation changed`);
    for (const [id, job] of Object.entries(workflow.jobs)) {
      const slot = assignments[file][id];
      assert.deepEqual(job.concurrency, { group: `flow-agents-compute-${slot}`, queue: 'max', 'cancel-in-progress': false }, `${file}/${id}: admission shape`);
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
          'unreviewed callee concurrency / caller-slot deadlock');
          const before = ancestors(key);
          for (const other of runners) {
            assert.ok(other === key || before.includes(other) || ancestors(other).includes(key), 'callee concurrent runner expansion exceeds one');
          }
        }
      } else assert.ok(job['runs-on'] && job.steps, 'runner job missing');
      for (const child of children) expanded.push({ file, id, child, slot, runners, needs: needs(job) });
    }
  }
  return expanded;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const expanded = validate();
  console.log(JSON.stringify({ admissionUnits: expanded.length, expandedRunnerJobs: expanded.reduce((n, x) => n + x.runners.length, 0), slots: 2, expanded }, null, 2));
}
