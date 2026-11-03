import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { validate, loadWorkflows, assignments, root, admissionGroup, laneExpression } from '../../scripts/ci/compute-policy.mjs';
import { legacyLintSources } from '../../scripts/ci/actionlint-compute.mjs';

const clone = x => structuredClone(x);
// Pinned literal, independent of the constants under test.
const PARITY = "(endsWith(github.run_id, '0') || endsWith(github.run_id, '2') || endsWith(github.run_id, '4') || endsWith(github.run_id, '6') || endsWith(github.run_id, '8')) && 'a' || 'b'";
const LANE_GROUP = slot => `flow-agents-compute-v2-${slot}-\${{ ${PARITY} }}`;
const graph = validate();
test('complete original YAML expands 15 admission units into 16 runners, including every matrix child', () => {
  assert.equal(graph.length, 15);
  assert.equal(graph.reduce((n, job) => n + job.runners.length, 0), 16);
  assert.equal(graph.filter(x => x.file === 'ci.yml').length, 7);
  assert.equal(graph.filter(x => x.id === 'harness-canary').length, 2);
});
for (const [label, mutate] of Object.entries({
  'slot remapping to the other slot': w => { w['ci.yml'].jobs['source-and-static'].concurrency.group = LANE_GROUP(1); },
  'retired single-slot group name': w => { w['ci.yml'].jobs['source-and-static'].concurrency.group = 'flow-agents-compute-2'; },
  'retired group with the lane expression': w => { w['ci.yml'].jobs['source-and-static'].concurrency.group = LANE_GROUP(2).replace('compute-v2-2', 'compute-2'); },
  'literal lane without the parity expression': w => { w['ci.yml'].jobs['source-and-static'].concurrency.group = 'flow-agents-compute-v2-2-a'; },
  'fifth group via a third lane': w => { w['ci.yml'].jobs['source-and-static'].concurrency.group = LANE_GROUP(2).replace("&& 'a' || 'b'", "&& 'a' || endsWith(github.run_id, '1') && 'b' || 'c'"); },
  'fifth group via a third slot': w => { w['ci.yml'].jobs['source-and-static'].concurrency.group = LANE_GROUP(3); },
  'lane parity digit dropped': w => { w['ci.yml'].jobs['source-and-static'].concurrency.group = LANE_GROUP(2).replace(" || endsWith(github.run_id, '8')", ''); },
  'lane parity inverted': w => { w['ci.yml'].jobs['source-and-static'].concurrency.group = LANE_GROUP(2).replace("&& 'a' || 'b'", "&& 'b' || 'a'"); },
  'lane from run attempt': w => { w['ci.yml'].jobs['source-and-static'].concurrency.group = LANE_GROUP(2).replaceAll('github.run_id', 'github.run_attempt'); },
  'lane from PR number': w => { w['ci.yml'].jobs['source-and-static'].concurrency.group = LANE_GROUP(2).replaceAll('github.run_id', 'github.event.pull_request.number'); },
  'lane from head sha': w => { w['ci.yml'].jobs['source-and-static'].concurrency.group = LANE_GROUP(2).replaceAll('github.run_id', 'github.sha'); },
  'lane from head ref': w => { w['ci.yml'].jobs['source-and-static'].concurrency.group = LANE_GROUP(2).replaceAll('github.run_id', 'github.head_ref'); },
  'head identifier appended to a lane group': w => { w['ci.yml'].jobs['source-and-static'].concurrency.group = `${LANE_GROUP(2)}-\${{ github.event.pull_request.head.sha }}`; },
  'extra heavy job': w => { w['ci.yml'].jobs.extra = clone(w['ci.yml'].jobs['source-and-static']); },
  'scalar PR bypass': w => { w['publish-npm.yml'].on = 'pull_request'; },
  'array PR bypass': w => { w['publish-npm.yml'].on = ['pull_request']; },
  'mixed array PR bypass': w => { w['publish-npm.yml'].on = ['push', 'pull_request_target']; },
  'third group': w => { w['ci.yml'].jobs['source-and-static'].concurrency.group = 'flow-agents-compute-3'; },
  'third v2 group': w => { w['ci.yml'].jobs['source-and-static'].concurrency.group = 'flow-agents-compute-v2-3-a'; },
  'ref split': w => { w['ci.yml'].jobs['source-and-static'].concurrency.group += '-${{ github.ref }}'; },
  'omitted admission': w => { delete w['ci.yml'].jobs['secret-scan'].concurrency; },
  'omitted job': w => { delete w['ci.yml'].jobs['secret-scan']; },
  'cross PR cancellation on a v2 job': w => { w['docs.yml'].jobs.gate.concurrency['cancel-in-progress'] = true; },
  'queue value changed': w => { w['ci.yml'].jobs['source-and-static'].concurrency.queue = 'min'; },
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
    for (const mutate of [x => { delete x.jobs.deploy.needs; }, x => { x.jobs.build.concurrency = { group: 'flow-agents-compute-v2-2-a' }; },
      x => { x.jobs.build.strategy = { matrix: { os: ['ubuntu-latest', 'windows-latest'] } }; },
      ...['flow-agents-compute-v2-2-a', { group: 'FLOW-AGENTS-COMPUTE-V2-2-A' }, { group: "${{ 'flow-agents-compute-v2-2-a' }}" }].map(concurrency => x => { x.jobs.build.concurrency = concurrency; })]) {
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

test('lane expression is pinned, parity-only and maps run IDs to exactly two lanes', () => {
  assert.equal(laneExpression, PARITY.replace(/^\(|\) && 'a' \|\| 'b'$/g, ''));
  assert.equal(admissionGroup(1), LANE_GROUP(1));
  assert.equal(admissionGroup(2), LANE_GROUP(2));
  // The only inputs are endsWith(github.run_id, <even digit>) calls: no PR, ref,
  // head, SHA, attempt or arithmetic.
  assert.deepEqual([...PARITY.matchAll(/github\.[a-z_.]+/g)].map(m => m[0]), Array(5).fill('github.run_id'));
  const evens = [...PARITY.matchAll(/endsWith\(github\.run_id, '(\d)'\)/g)].map(m => m[1]);
  assert.deepEqual(evens, ['0', '2', '4', '6', '8']);
  const lane = id => evens.some(d => String(id).endsWith(d)) ? 'a' : 'b';
  for (let id = 0; id < 100; id++) assert.equal(lane(id), id % 2 === 0 ? 'a' : 'b', `run id ${id}`);
  assert.equal(lane(26500000000), 'a'); assert.equal(lane(26500000001), 'b');
});

test('real workflows resolve to exactly four groups: two slots x two lanes, none of them the retired names', () => {
  const workflows = loadWorkflows();
  const resolved = new Set();
  let jobs = 0;
  for (const [file, byId] of Object.entries(assignments)) for (const [id, slot] of Object.entries(byId)) {
    const group = workflows[file].jobs[id].concurrency.group; jobs++;
    assert.ok(group.startsWith(`flow-agents-compute-v2-${slot}-\${{ `) && group.endsWith(' }}'), `${file}/${id}`);
    for (const lane of ['a', 'b']) resolved.add(`flow-agents-compute-v2-${slot}-${lane}`);
  }
  assert.equal(jobs, 14); // 15 admission units once harness-canary expands to two children
  assert.deepEqual([...resolved].sort(), ['flow-agents-compute-v2-1-a', 'flow-agents-compute-v2-1-b', 'flow-agents-compute-v2-2-a', 'flow-agents-compute-v2-2-b']);
  assert.ok(!JSON.stringify(workflows).match(/flow-agents-compute-[12]\b/), 'retired stuck group names must not reappear');
});

// A finite native-admission MODEL, not a claim about observed GitHub behavior.
// Waiting entries hold no runner. Each group admits its oldest pending entry;
// the platform's overflow result is cancellation, never success. There are four
// groups: group index = (slot - 1) * 2 + lane, lane 0 = 'a', lane 1 = 'b'.
const GROUPS = 4;
const groupOf = job => (job.slot - 1) * 2 + (job.lane ?? 0);
function enqueue(state, job) {
  const queue = state.pending[groupOf(job)];
  if (queue.length === 100) { state.cancelled.push(job.key); return; }
  queue.push(job);
}
function admit(state) {
  for (let g = 0; g < GROUPS; g++) if (!state.running[g]) state.running[g] = state.pending[g].shift() ?? null;
  assert.ok(state.running.filter(Boolean).length <= 4);
  for (let g = 0; g < GROUPS; g++) assert.ok(!state.running[g] || groupOf(state.running[g]) === g);
}
const empty = () => ({ pending: Array.from({ length: GROUPS }, () => []), running: Array(GROUPS).fill(null), cancelled: [], done: [] });
function cancelWorkflow(state, workflow) {
  for (let i = 0; i < GROUPS; i++) {
    const removed = state.pending[i].filter(x => x.workflow === workflow);
    state.cancelled.push(...removed.map(x => x.key));
    state.pending[i] = state.pending[i].filter(x => x.workflow !== workflow);
    if (state.running[i]?.workflow === workflow) { state.cancelled.push(state.running[i].key); state.running[i] = null; }
  }
}
function permutations(xs) { return xs.length ? xs.flatMap((x, i) => permutations(xs.filter((_, j) => i !== j)).map(rest => [x, ...rest])) : [[]]; }

test('exhaust every completion interleaving of the expanded graph for two PRs plus compatibility, six caller arrival orders, both job orders and every lane assignment', () => {
  let states = 0, peak = 0;
  const scenarios = [];
  const owners = ['pr-a', 'pr-b', 'compat'];
  // A run's lane is fixed for the whole run, so every job of an owner shares it.
  for (const laneBits of [0, 1, 2, 3, 4, 5, 6, 7]) for (const order of permutations(owners)) for (const reverse of [false, true]) {
    const laneOf = owner => (laneBits >> owners.indexOf(owner)) & 1;
    // Both PRs include CI, full readiness, docs gate and the demo. Pages is a
    // separate push caller, included pessimistically in pr-a's arrival batch.
    const jobs = order.flatMap(owner => graph.filter(x => owner === 'compat' ? x.file === 'runtime-compat.yml' : x.file !== 'runtime-compat.yml' && (x.id !== 'pages' || owner === 'pr-a'))
      .map((x, i) => ({ ...x, key: `${owner}/${x.file}/${x.id}/${i}`, workflow: `${owner}/${x.file}`, owner, lane: laneOf(owner) })));
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
      peak = Math.max(peak, state.running.filter(Boolean).length);
      assert.equal(state.cancelled.length, 0, 'non-overflow work cannot disappear');
      if (!state.running.some(Boolean)) {
        assert.equal(waiting.length, 0, 'no dependency deadlock');
        assert.equal(state.done.length, jobs.length, 'all expanded admission units finish');
        return;
      }
      for (let g = 0; g < GROUPS; g++) if (state.running[g]) {
        const next = clone(state); next.done.push(next.running[g].key); next.running[g] = null;
        visit(next, waiting);
      }
    }
    visit(empty(), jobs);
    scenarios.push({ order, reverse, laneBits, jobs, states: [...seen].map(x => JSON.parse(x)) });
  }
  if (process.env.FLOW_COMPUTE_MODEL_OUTPUT) writeFileSync(process.env.FLOW_COMPUTE_MODEL_OUTPUT, JSON.stringify({ kind: 'finite-model-not-platform-proof', scenarios }, null, 2));
  assert.ok(states > 1000);
  assert.ok(peak > 2 && peak <= 4, `peak concurrent runners ${peak} must use the raised bound but never exceed 4`);
  console.log(`MODEL: ${states} distinct states; peak ${peak}; all completion interleavings in ${scenarios.length} bounded expanded-graph scenarios`);
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
  assert.equal(state.running[0].key, 'b/0'); assert.equal(state.running[2].key, 'compat');
  assert.deepEqual(state.pending[0].map(x => x.key), ['b/duplicate', 'a/new']);
  assert.deepEqual(state.cancelled, ['a/old/1', 'a/old/0']);
  for (let i = 0; i < 98; i++) enqueue(state, { key: `pending-${i}`, slot: 1 });
  enqueue(state, { key: 'overflow', slot: 1 });
  assert.equal(state.pending[0].length, 100); assert.ok(state.cancelled.includes('overflow'));
  assert.ok(!state.done.includes('overflow'));
  state.running[0] = null; admit(state); assert.equal(state.running[0].key, 'b/duplicate');
});

test('the two lanes of a slot admit independently while one lane stays FIFO', () => {
  const state = empty();
  enqueue(state, { key: 'x', workflow: 'x', slot: 2, lane: 0 });
  enqueue(state, { key: 'y', workflow: 'y', slot: 2, lane: 0 });
  enqueue(state, { key: 'z', workflow: 'z', slot: 2, lane: 1 });
  enqueue(state, { key: 'other-slot', workflow: 'o', slot: 1, lane: 1 });
  admit(state);
  assert.deepEqual(state.running.map(x => x?.key ?? null), [null, 'other-slot', 'x', 'z']);
  assert.deepEqual(state.pending[2].map(x => x.key), ['y']);
});
