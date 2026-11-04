import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, cpSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse, stringify } from 'yaml';
import { validate, loadWorkflows, participants, refGroups, root } from '../../scripts/ci/compute-policy.mjs';

const clone = x => structuredClone(x);
const graph = validate();

// Pinned literals, independent of the constants under test.
const PINNED_GROUPS = {
  'ci.yml': 'flow-agents-ci-${{ github.ref }}',
  'docs.yml': 'flow-agents-docs-${{ github.ref }}',
  'kit-gates-demo.yml': 'flow-agents-kit-gates-demo-${{ github.ref }}',
  'runtime-compat.yml': 'flow-agents-runtime-compat-${{ github.ref }}',
  'veritas-advisory.yml': 'veritas-advisory-${{ github.ref }}',
};
const jobs = Object.entries(participants).flatMap(([file, ids]) => ids.map(id => [file, id]));

test('complete original YAML expands 15 participating jobs into 16 runners, including every matrix child', () => {
  assert.equal(jobs.length, 14);
  assert.equal(graph.length, 15);
  assert.equal(graph.reduce((n, job) => n + job.runners.length, 0), 16);
  assert.equal(graph.filter(x => x.file === 'ci.yml').length, 7);
  assert.equal(graph.filter(x => x.id === 'harness-canary').length, 2);
});

test('the real workflows carry no job-level concurrency and exactly the pinned per-ref cancelling group', () => {
  assert.deepEqual(refGroups, PINNED_GROUPS);
  const workflows = loadWorkflows();
  for (const [file, ids] of Object.entries(participants)) {
    assert.deepEqual(workflows[file].concurrency, { group: PINNED_GROUPS[file], 'cancel-in-progress': true }, file);
    for (const id of ids) assert.equal(workflows[file].jobs[id].concurrency, undefined, `${file}/${id}`);
  }
  // No trace of the retired repo-wide groups or of queue admission in any workflow.
  for (const [file, text] of Object.entries(Object.fromEntries(Object.keys(workflows).map(f => [f, readFileSync(join(root, '.github/workflows', f), 'utf8')])))) {
    assert.ok(!/flow-agents-compute/.test(text), `${file}: retired compute group`);
    assert.ok(!/^\s*queue:/m.test(text), `${file}: queue admission`);
  }
});

// A reintroduced job-level group, in any of the shapes the earlier policies used.
const jobGroups = {
  'legacy slot group': { group: 'flow-agents-compute-1', queue: 'max', 'cancel-in-progress': false },
  'v2 lane group': { group: "flow-agents-compute-v2-2-${{ (endsWith(github.run_id, '0')) && 'a' || 'b' }}", queue: 'max', 'cancel-in-progress': false },
  'bare string group': 'flow-agents-compute-2',
  'group without queue': { group: 'shared', 'cancel-in-progress': false },
  'per-ref job group': { group: 'x-${{ github.ref }}', 'cancel-in-progress': true },
  'empty block': {},
};
for (const [file, id] of jobs) for (const [label, concurrency] of Object.entries(jobGroups)) {
  test(`rejects ${label} reintroduced on ${file}/${id}`, () => {
    const w = loadWorkflows(); w[file].jobs[id].concurrency = clone(concurrency);
    assert.throws(() => validate(w), /job-level concurrency is not allowed/);
  });
}

for (const file of Object.keys(participants)) {
  for (const [label, mutate] of Object.entries({
    'missing per-ref cancellation': w => { delete w.concurrency; },
    'cancel-in-progress false': w => { w.concurrency['cancel-in-progress'] = false; },
    'cancel-in-progress omitted': w => { delete w.concurrency['cancel-in-progress']; },
    'cancel-in-progress as string': w => { w.concurrency['cancel-in-progress'] = 'true'; },
    'constant group (cross-branch cancellation)': w => { w.concurrency.group = 'shared'; },
    'group without the ref': w => { w.concurrency.group = w.concurrency.group.replace('${{ github.ref }}', ''); },
    'group split by sha': w => { w.concurrency.group += '-${{ github.sha }}'; },
    'group keyed on head ref instead': w => { w.concurrency.group = w.concurrency.group.replace('github.ref', 'github.head_ref'); },
    'extra queue key': w => { w.concurrency.queue = 'max'; },
    'bare string group': w => { w.concurrency = 'shared'; },
  })) test(`rejects ${label} on workflow ${file}`, () => {
    const w = loadWorkflows(); mutate(w[file]);
    assert.throws(() => validate(w), /per-ref cancel-in-progress group required/);
  });
}

for (const [label, mutate] of Object.entries({
  'extra heavy job': w => { w['ci.yml'].jobs.extra = clone(w['ci.yml'].jobs['source-and-static']); },
  'scalar PR bypass': w => { w['publish-npm.yml'].on = 'pull_request'; },
  'array PR bypass': w => { w['publish-npm.yml'].on = ['pull_request']; },
  'mixed array PR bypass': w => { w['publish-npm.yml'].on = ['push', 'pull_request_target']; },
  'omitted job': w => { delete w['ci.yml'].jobs['secret-scan']; },
  'matrix growth': w => { w['runtime-compat.yml'].jobs['harness-canary'].strategy.matrix.include.push({ runtime: 'third' }); },
  'mutable callee': w => { w['ci.yml'].jobs['secret-scan'].uses = w['ci.yml'].jobs['secret-scan'].uses.replace(/@.*/, '@main'); },
  'new PR bypass': w => { w['publish-npm.yml'].on.pull_request = null; },
  'new workflow': w => { w['extra.yml'] = { on: { pull_request: null }, jobs: {} }; },
  'omitted job of an excluded workflow': w => { delete w['publish-npm.yml'].jobs.verify; },
})) test(`rejects ${label}`, () => { const w = loadWorkflows(); mutate(w); assert.throws(() => validate(w)); });

test('callee width and nested concurrency changes fail even when snapshot hash is updated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flow-callee-'));
  try {
    cpSync(join(root, 'evals/fixtures/ci-compute'), dir, { recursive: true });
    const lock = JSON.parse(readFileSync(join(dir, 'lock.json')));
    const entry = Object.values(lock).find(x => x.file === 'docs-pages.yml');
    const original = parse(readFileSync(join(dir, entry.file), 'utf8'));
    for (const mutate of [x => { delete x.jobs.deploy.needs; }, x => { x.jobs.build.concurrency = { group: 'any-shared-group' }; },
      x => { x.jobs.build.strategy = { matrix: { os: ['ubuntu-latest', 'windows-latest'] } }; },
      ...['any-shared-group', { group: 'ANY-SHARED-GROUP' }, { group: "${{ 'any-shared-group' }}" }].map(concurrency => x => { x.jobs.build.concurrency = concurrency; })]) {
      const changed = clone(original); mutate(changed); const bytes = stringify(changed);
      entry.sha256 = createHash('sha256').update(bytes).digest('hex');
      writeFileSync(join(dir, entry.file), bytes); writeFileSync(join(dir, 'lock.json'), JSON.stringify(lock));
      assert.throws(() => validate(loadWorkflows(), dir));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the checker CLI exits non-zero when a job-level group is reintroduced and zero on the real tree', () => {
  const run = cwdRoot => spawnSync(process.execPath, [join(cwdRoot, 'scripts/ci/compute-policy.mjs')], { encoding: 'utf8' });
  assert.equal(run(root).status, 0);
  const copy = mkdtempSync(join(tmpdir(), 'flow-policy-cli-'));
  try {
    for (const path of ['scripts/ci', '.github/workflows', 'evals/fixtures/ci-compute']) cpSync(join(root, path), join(copy, path), { recursive: true });
    symlinkSync(join(root, 'node_modules'), join(copy, 'node_modules'));
    const file = join(copy, '.github/workflows/docs.yml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('  gate:\n', "  gate:\n    concurrency:\n      group: sneaky\n"));
    const result = run(copy);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /job-level concurrency is not allowed/);
  } finally { rmSync(copy, { recursive: true, force: true }); }
});

test('importing the checker from stdin does not crash on the non-file entry path', () => {
  const href = new URL('../../scripts/ci/compute-policy.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-'], { input: `const m = await import(${JSON.stringify(href)}); console.log(Object.keys(m.participants).length);`, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '5');
});
