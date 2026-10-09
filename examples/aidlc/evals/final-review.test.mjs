import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startRun, loadRun } from '@kontourai/flow';
import { dispatchStage } from '../scripts/dispatch.mjs';
import { createUnitFlow } from '../scripts/unit-flow.mjs';
import { verifyFinalUnits } from '../scripts/final-review.mjs';
import { snapshotWorkspace } from '../scripts/runtime.mjs';
import { digest } from '../scripts/compile.mjs';

const stage = { slug: 'code-generation', source_digest: 'a'.repeat(64), mode: 'inline', lead_agent: 'developer', support_agents: [], reviewer: 'independent-reviewer', review_class: 'adversarial', reviewer_max_iterations: 1, workspace_requires: true, produces: ['code-summary'], procedure: 'Implement and independently verify every unit.' };
const units = [{ id: 'a', depends_on: [], mutable_resources: ['source'] }, { id: 'b', depends_on: ['a'], mutable_resources: ['source'] }];
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-final-review-'));
  const workspace = path.join(root, 'source'), controllerRoot = path.join(root, 'controller');
  fs.mkdirSync(workspace); fs.mkdirSync(controllerRoot);
  fs.writeFileSync(path.join(workspace, 'app.js'), 'export const initial = true;\n');
  const file = path.join(controllerRoot, 'parent.json');
  fs.writeFileSync(file, JSON.stringify({ id: 'parent', version: '1', steps: [{ id: stage.slug, next: null }], gates: { 'parent-gate': { step: stage.slug, expects: [] } } }));
  await startRun(file, { cwd: controllerRoot, runId: 'final-review-parent' });
  const calls = [], receipts = new Map(), bases = new Map();
  let sequence = 0, finalBehavior = 'ready', historical;
  const executor = {
    async snapshotBasis({ artifacts = [] }) { return { source_digest: snapshotWorkspace(workspace).source_digest, artifacts: artifacts.map(ref => ({ path: ref.path, digest: digest(fs.readFileSync(path.join(workspace, ref.path))) })) }; },
    async loadBasis(key) { return bases.get(key); }, async saveBasis(key, value) { bases.set(key, value); },
    async loadReceipt(request) { return receipts.get(request.request_digest); }, async saveReceipt(request, result) { receipts.set(request.request_digest, result); },
    async execute(request) {
      sequence++;
      const final = request.context.acceptance_phase === 'final-source';
      calls.push({ phase: request.phase, unit: request.unit, final, input_basis: structuredClone(request.basis), request_digest: request.request_digest, artifacts: structuredClone(request.reviewed_artifacts ?? []) });
      const artifact = `.aidlc/artifacts/code-generation/${request.unit}/code-summary.md`;
      const script = request.phase === 'review'
        ? 'process.stdout.write(JSON.stringify({verdict:process.argv[1],findings:JSON.parse(process.argv[2])}))'
        : 'const fs=require("node:fs"),path=require("node:path");fs.writeFileSync(process.argv[1]+".js","export const "+process.argv[1]+" = true;\\n");fs.mkdirSync(path.dirname(process.argv[2]),{recursive:true});fs.writeFileSync(process.argv[2],"## Unit\\n"+process.argv[1]+"\\n## Implementation\\nObserved source bytes.\\n");';
      const findings = final && finalBehavior === 'open' ? [{ id: 'regression', severity: 'high', status: 'open', reason: 'Final integration is inconsistent' }] : [];
      const args = request.phase === 'review' ? [final && finalBehavior === 'not_ready' ? 'not_ready' : 'ready', JSON.stringify(findings)] : [request.unit, artifact];
      const observed = spawnSync(process.execPath, ['-e', script, ...args], { cwd: workspace, encoding: 'utf8', timeout: 10000 });
      assert.equal(observed.status, 0, observed.stderr);
      if (final && finalBehavior === 'mutate_source') fs.writeFileSync(path.join(workspace, 'app.js'), 'Concurrent final-source change');
      let identity = { actor: { runtime: 'node', session_id: `subprocess-${observed.pid}`, host: os.hostname() }, instance_id: `subprocess-${observed.pid}` };
      if (final && finalBehavior === 'same_author') identity = historical.units[0].receipts[0].identity;
      if (final && finalBehavior === 'same_reviewer') identity = historical.units[0].reviews[0].identity;
      const artifacts = request.phase === 'review' ? request.reviewed_artifacts : [{ path: artifact, digest: digest(fs.readFileSync(path.join(workspace, artifact))) }];
      const result = { status: 'completed', identity, identity_basis: 'executor-observed', receipt: { id: `actual-subprocess-${observed.pid}`, request_digest: request.request_digest, digest: digest({ pid: observed.pid, status: observed.status, stdout: observed.stdout, stderr: observed.stderr }) }, input_basis: request.basis, artifacts, observation: { pid: observed.pid, status: observed.status, stdout: observed.stdout } };
      if (request.phase === 'review') Object.assign(result, JSON.parse(observed.stdout), { basis: await executor.snapshotBasis({ artifacts }) });
      return result;
    },
  };
  const originalFlow = await createUnitFlow({ controllerRoot, parentRunId: 'final-review-parent', stage, units, snapshotBasis: executor.snapshotBasis });
  t.after(async () => { await originalFlow.close(); fs.rmSync(root, { recursive: true, force: true }); });
  historical = await dispatchStage({ stage, units, executor: originalFlow.bindExecutor(executor), policy: { requiresClaim: true } });
  assert.equal(historical.status, 'completed', JSON.stringify(historical));
  const originalJoin = await originalFlow.join();
  assert.equal(originalJoin.status, 'completed');
  assert.equal(originalJoin.complete, false);
  assert.equal(originalJoin.units[0].current, false);
  const verify = () => verifyFinalUnits({ stage, units, dispatched: historical, context: {}, executor, controllerRoot, parentRunId: 'final-review-parent', policy: { maxParallel: 2 } });
  return { workspace, controllerRoot, executor, historical, originalFlow, originalJoin, calls, verify, setBehavior: value => finalBehavior = value };
}

test('later unit source writes make original completion historical; fresh actual reviews settle a distinct final-source child Flow', async (t) => {
  const f = await fixture(t), before = JSON.stringify(f.historical), originalCalls = f.calls.length;
  const result = await f.verify();
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.join.complete, true);
  assert.notEqual(result.join.run_id, f.originalFlow.runId);
  assert.equal((await loadRun(result.join.run_id, f.controllerRoot)).state.status, 'completed');
  assert.equal((await f.originalFlow.join()).complete, false);
  assert.equal(JSON.stringify(f.historical), before);
  assert.deepEqual(result.historical, f.historical);
  const finalCalls = f.calls.slice(originalCalls);
  assert.equal(finalCalls.length, 2);
  assert.ok(finalCalls.every(call => call.phase === 'review' && call.final && call.artifacts.length === 1));
  assert.ok(result.dispatch.units.every(unit => unit.receipts.length === 1 && unit.receipts[0].phase === 'review' && unit.receipts[0].final_review.ready));
  const oldReceipts = new Set(f.historical.units.flatMap(unit => unit.receipts.map(receipt => receipt.receipt.id)));
  assert.ok(result.dispatch.units.every(unit => !oldReceipts.has(unit.receipts[0].receipt.id)));
});
test('artifact changes cannot be laundered into final-source acceptance', async (t) => {
  const f = await fixture(t), before = f.calls.length;
  fs.writeFileSync(path.join(f.workspace, f.historical.units[0].artifacts[0].path), 'Changed historical unit artifact');
  const result = await f.verify();
  assert.equal(result.status, 'blocked');
  assert.equal(result.failure.reason, 'historical_artifact_changed');
  assert.equal(f.calls.length, before);
});
test('not-ready verdicts and open findings leave fresh canonical final units incomplete', async (t) => {
  for (const behavior of ['not_ready', 'open']) {
    const f = await fixture(t); f.setBehavior(behavior);
    const result = await f.verify();
    assert.equal(result.status, 'blocked');
    assert.equal(result.join.complete, false);
    assert.ok(result.dispatch.units.some(unit => unit.receipts.some(receipt => receipt.status === 'failed')));
    assert.notEqual((await loadRun(result.join.run_id, f.controllerRoot)).state.status, 'completed');
  }
});
test('final reviewers cannot reuse any original author or reviewer principal', async (t) => {
  for (const behavior of ['same_author', 'same_reviewer']) {
    const f = await fixture(t); f.setBehavior(behavior);
    const result = await f.verify();
    assert.equal(result.status, 'blocked');
    assert.equal(result.join.complete, false);
    const actual = result.dispatch.units.flatMap(unit => unit.receipts).find(receipt => receipt.final_review);
    assert.equal(actual.final_review.independent, false);
  }
});
test('unchanged final-source verification replays its own durable reviews without new execution', async (t) => {
  const f = await fixture(t);
  const first = await f.verify(); assert.equal(first.status, 'completed');
  const count = f.calls.length;
  const resumed = await f.verify();
  assert.equal(resumed.status, 'completed', JSON.stringify(resumed));
  assert.equal(resumed.join.run_id, first.join.run_id);
  assert.equal(f.calls.length, count);
  assert.ok(resumed.dispatch.units.every(unit => unit.receipts.every(receipt => receipt.replayed)));
});
test('a concurrent source change prevents a ready reviewer from settling fresh canonical units', async (t) => {
  const f = await fixture(t); f.setBehavior('mutate_source');
  const result = await f.verify();
  assert.equal(result.status, 'blocked');
  assert.notEqual(result.join?.complete, true);
  if (result.join) assert.notEqual((await loadRun(result.join.run_id, f.controllerRoot)).state.status, 'completed');
});
