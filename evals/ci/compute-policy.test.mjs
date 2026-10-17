import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { validate, loadWorkflows, assignments, root } from '../../scripts/ci/compute-policy.mjs';
import { legacyLintSources } from '../../scripts/ci/actionlint-compute.mjs';

const clone = x => structuredClone(x);
const graph = validate();
test('complete original YAML expands 15 admission units into 16 runners, including every matrix child', () => {
  assert.equal(graph.length, 15);
  assert.equal(graph.reduce((n, job) => n + job.runners.length, 0), 16);
  assert.equal(graph.filter(x => x.file === 'ci.yml').length, 7);
  assert.equal(graph.filter(x => x.id === 'harness-canary').length, 2);
});
for (const [label, mutate] of Object.entries({
  'valid slot remapping': w => { w['ci.yml'].jobs['source-and-static'].concurrency.group = 'flow-agents-compute-1'; },
  'extra heavy job': w => { w['ci.yml'].jobs.extra = clone(w['ci.yml'].jobs['source-and-static']); },
  'scalar PR bypass': w => { w['publish-npm.yml'].on = 'pull_request'; },
  'array PR bypass': w => { w['publish-npm.yml'].on = ['pull_request']; },
  'mixed array PR bypass': w => { w['publish-npm.yml'].on = ['push', 'pull_request_target']; },
  'third group': w => { w['ci.yml'].jobs['source-and-static'].concurrency.group = 'flow-agents-compute-3'; },
  'ref split': w => { w['ci.yml'].jobs['source-and-static'].concurrency.group += '-${{ github.ref }}'; },
  'omitted admission': w => { delete w['ci.yml'].jobs['secret-scan'].concurrency; },
  'omitted job': w => { delete w['ci.yml'].jobs['secret-scan']; },
  'cross PR cancellation': w => { w['ci.yml'].jobs['source-and-static'].concurrency['cancel-in-progress'] = true; },
  'queue omission': w => { delete w['ci.yml'].jobs['source-and-static'].concurrency.queue; },
  'matrix growth': w => { w['runtime-compat.yml'].jobs['harness-canary'].strategy.matrix.include.push({ runtime: 'third' }); },
  'mutable callee': w => { w['ci.yml'].jobs['secret-scan'].uses = w['ci.yml'].jobs['secret-scan'].uses.replace(/@.*/, '@main'); },
  'new PR bypass': w => { w['publish-npm.yml'].on.pull_request = null; },
  'new workflow': w => { w['extra.yml'] = { on: { pull_request: null }, jobs: {} }; },
  'workflow latest head cancellation removed': w => { delete w['ci.yml'].concurrency; },
})) test(`rejects ${label}`, () => { const w = loadWorkflows(); mutate(w); assert.throws(() => validate(w)); });

test('callee width and nested same-slot changes fail even when snapshot hash is updated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flow-callee-'));
  try {
    cpSync(join(root, 'evals/fixtures/ci-compute'), dir, { recursive: true });
    const lock = JSON.parse(readFileSync(join(dir, 'lock.json')));
    const entry = Object.values(lock).find(x => x.file === 'docs-pages.yml');
    const original = parse(readFileSync(join(dir, entry.file), 'utf8'));
    for (const mutate of [x => { delete x.jobs.deploy.needs; }, x => { x.jobs.build.concurrency = { group: 'flow-agents-compute-2' }; },
      x => { x.jobs.build.strategy = { matrix: { os: ['ubuntu-latest', 'windows-latest'] } }; },
      ...['flow-agents-compute-2', { group: 'FLOW-AGENTS-COMPUTE-2' }, { group: "${{ 'flow-agents-compute-2' }}" }].map(concurrency => x => { x.jobs.build.concurrency = concurrency; })]) {
      const changed = clone(original); mutate(changed); const bytes = stringify(changed);
      entry.sha256 = createHash('sha256').update(bytes).digest('hex');
      writeFileSync(join(dir, entry.file), bytes); writeFileSync(join(dir, 'lock.json'), JSON.stringify(lock));
      assert.throws(() => validate(loadWorkflows(), dir));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('legacy copies strip only reviewed queue keys and retain all other semantics', () => {
  const sources = Object.fromEntries(Object.keys(loadWorkflows()).map(name => [name, readFileSync(join(root, '.github/workflows', name), 'utf8')]));
  const copies = legacyLintSources(sources);
  for (const [file, text] of Object.entries(sources)) {
    const expected = parse(text);
    for (const id of Object.keys(assignments[file] ?? {})) delete expected.jobs[id].concurrency.queue;
    assert.deepEqual(parse(copies[file]), expected);
    assert.equal(sources[file], readFileSync(join(root, '.github/workflows', file), 'utf8'));
  }
  const bad = parse(sources['ci.yml']); bad.jobs['secret-scan'].concurrency.queue = 'anything';
  assert.throws(() => legacyLintSources({ ...sources, 'ci.yml': stringify(bad) }));
});

// A finite native-admission MODEL, not a claim about observed GitHub behavior.
// Waiting entries hold no runner. Each group admits its oldest pending entry;
// the platform's overflow result is cancellation, never success.
function enqueue(state, job) {
  const queue = state.pending[job.slot - 1];
  if (queue.length === 100) { state.cancelled.push(job.key); return; }
  queue.push(job);
}
function admit(state) {
  for (let slot = 0; slot < 2; slot++) if (!state.running[slot]) state.running[slot] = state.pending[slot].shift() ?? null;
  assert.ok(state.running.filter(Boolean).length <= 2);
  for (let slot = 0; slot < 2; slot++) assert.ok(!state.running[slot] || state.running[slot].slot === slot + 1);
}
const empty = () => ({ pending: [[], []], running: [null, null], cancelled: [], done: [] });
function cancelWorkflow(state, workflow) {
  for (let i = 0; i < 2; i++) {
    const removed = state.pending[i].filter(x => x.workflow === workflow);
    state.cancelled.push(...removed.map(x => x.key));
    state.pending[i] = state.pending[i].filter(x => x.workflow !== workflow);
    if (state.running[i]?.workflow === workflow) { state.cancelled.push(state.running[i].key); state.running[i] = null; }
  }
}
function permutations(xs) { return xs.length ? xs.flatMap((x, i) => permutations(xs.filter((_, j) => i !== j)).map(rest => [x, ...rest])) : [[]]; }

test('exhaust every completion interleaving of the expanded graph for two PRs plus compatibility, six caller arrival orders and both job orders', () => {
  let states = 0;
  const scenarios = [];
  for (const order of permutations(['pr-a', 'pr-b', 'compat'])) for (const reverse of [false, true]) {
    // Both PRs include CI, full readiness, docs gate and the demo. Pages is a
    // separate push caller, included pessimistically in pr-a's arrival batch.
    const jobs = order.flatMap(owner => graph.filter(x => owner === 'compat' ? x.file === 'runtime-compat.yml' : x.file !== 'runtime-compat.yml' && (x.id !== 'pages' || owner === 'pr-a'))
      .map((x, i) => ({ ...x, key: `${owner}/${x.file}/${x.id}/${i}`, workflow: `${owner}/${x.file}`, owner })));
    if (reverse) jobs.reverse();
    for (const job of jobs) job.dependencies = jobs.filter(x => x.workflow === job.workflow && job.needs.includes(x.id)).map(x => x.key);
    const seen = new Set();
    function visit(state, waiting) {
      const ready = waiting.filter(x => x.dependencies.every(k => state.done.includes(k)));
      for (const job of ready) enqueue(state, job);
      waiting = waiting.filter(x => !ready.includes(x));
      admit(state);
      const key = JSON.stringify([state.pending.map(q => q.map(x => x.key)), state.running.map(x => x?.key), [...state.done].sort(), waiting.map(x => x.key)]);
      if (seen.has(key)) return; seen.add(key); states++;
      assert.equal(state.cancelled.length, 0, 'non-overflow work cannot disappear');
      if (!state.running.some(Boolean)) {
        assert.equal(waiting.length, 0, 'no dependency deadlock');
        assert.equal(state.done.length, jobs.length, 'all expanded admission units finish');
        return;
      }
      for (let slot = 0; slot < 2; slot++) if (state.running[slot]) {
        const next = clone(state); next.done.push(next.running[slot].key); next.running[slot] = null;
        visit(next, waiting);
      }
    }
    visit(empty(), jobs);
    scenarios.push({ order, reverse, jobs, states: [...seen].map(x => JSON.parse(x)) });
  }
  if (process.env.FLOW_COMPUTE_MODEL_OUTPUT) writeFileSync(process.env.FLOW_COMPUTE_MODEL_OUTPUT, JSON.stringify({ kind: 'finite-model-not-platform-proof', scenarios }, null, 2));
  assert.ok(states > 1000);
  console.log(`MODEL: ${states} distinct states; all completion interleavings in 12 bounded expanded-graph scenarios`);
});

test('FIFO within each group, same-head duplicates, cross-head cancellation and overflow remain explicit', () => {
  const state = empty();
  enqueue(state, { key: 'a/old/0', workflow: 'ci-a-old', slot: 1 }); admit(state);
  enqueue(state, { key: 'b/0', workflow: 'ci-b', slot: 1 });
  enqueue(state, { key: 'a/old/1', workflow: 'ci-a-old', slot: 1 });
  enqueue(state, { key: 'b/duplicate', workflow: 'ci-b-duplicate', slot: 1 });
  enqueue(state, { key: 'compat', workflow: 'compat', slot: 2 }); admit(state);
  cancelWorkflow(state, 'ci-a-old');
  enqueue(state, { key: 'a/new', workflow: 'ci-a-new', slot: 1 }); admit(state);
  assert.equal(state.running[0].key, 'b/0'); assert.equal(state.running[1].key, 'compat');
  assert.deepEqual(state.pending[0].map(x => x.key), ['b/duplicate', 'a/new']);
  assert.deepEqual(state.cancelled, ['a/old/1', 'a/old/0']);
  for (let i = 0; i < 98; i++) enqueue(state, { key: `pending-${i}`, slot: 1 });
  enqueue(state, { key: 'overflow', slot: 1 });
  assert.equal(state.pending[0].length, 100); assert.ok(state.cancelled.includes('overflow'));
  assert.ok(!state.done.includes('overflow'));
  state.running[0] = null; admit(state); assert.equal(state.running[0].key, 'b/duplicate');
});
