import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDockerExecutor } from '../scripts/executor.mjs';
import { digest } from '../scripts/compile.mjs';

// This is a local host-port boundary test, not a Docker/provider receipt.
// The port creates real competing fork bytes; the executor decides publication.
function fixture(t, { responseStatus = 'failed', terminalStatus = 0, maxTurns = 5, portThrows = false, storageBudget } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-publication-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'source'), controllerRoot = path.join(root, 'controller');
  fs.mkdirSync(workspace); fs.mkdirSync(controllerRoot);
  fs.writeFileSync(path.join(workspace, 'app.js'), 'canonical implementation');
  fs.writeFileSync(path.join(workspace, 'keep.js'), 'canonical retained file');
  const artifact = '.aidlc/artifacts/code-generation/code-summary.md';
  fs.mkdirSync(path.dirname(path.join(workspace, artifact)), { recursive: true });
  fs.writeFileSync(path.join(workspace, artifact), 'canonical artifact');
  const request = { workspace, source_root: workspace, run_id: 'publication-fixture', execution: { max_turns: maxTurns, timeout_s: 60, model: 'local-fixture' }, engine_sandbox: { image: `sha256:${'a'.repeat(64)}`, artifact_root: path.join(root, 'artifacts'), storage_budget: storageBudget } };
  let fork, calls = 0, dispatch, observedStorageBudget;
  const workerRunner = async (input) => {
    calls++;observedStorageBudget=input.storageBudget;
    if (portThrows) throw new Error('Synthetic unreceipted worker failure');
    fork = input.workspace;
    fs.writeFileSync(path.join(fork, 'app.js'), 'worker edit');
    fs.unlinkSync(path.join(fork, 'keep.js'));
    fs.writeFileSync(path.join(fork, 'added.js'), 'worker addition');
    fs.mkdirSync(path.dirname(path.join(fork, artifact)), { recursive: true });
    fs.writeFileSync(path.join(fork, artifact), 'worker artifact');
    return { observed: { container_id: 'local-port-fixture', context_digest: 'fixture', stdin_digest: 'fixture', source_fork_digest: 'fixture' }, provider_thread_id: 'local-port-fixture', terminal: { status: terminalStatus, timeout: false, overflow: false }, container_removed: true, usage: { complete: false }, final: JSON.stringify({ status: responseStatus, artifacts: [{ path: artifact }] }) };
  };
  const freshExecutor = () => createDockerExecutor({ request, controllerRoot, workerRunner });
  const executor = freshExecutor();
  const execute = async (phase = 'inline') => {
    dispatch = { request_digest: digest({ responseStatus, terminalStatus, phase }), stage: 'code-generation', role: 'aidlc-developer-agent', phase, unit: 'stage', context: { stage: { workspace_requires: true }, artifact_targets: [{ path: artifact }] }, basis: await executor.snapshotBasis({}) };
    dispatch.expected_identity = await executor.admit(dispatch);
    return executor.execute(dispatch);
  };
  return { workspace, controllerRoot, artifact, execute, executor, freshExecutor, fork: () => fork, calls: () => calls, dispatch: () => dispatch, observedStorageBudget:()=>observedStorageBudget };
}

test('a final failed result publishes no modifications, deletions, additions or artifacts', async (t) => {
  const f = fixture(t);
  const result = await f.execute();
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.artifacts, []);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'app.js'), 'utf8'), 'canonical implementation');
  assert.equal(fs.readFileSync(path.join(f.workspace, 'keep.js'), 'utf8'), 'canonical retained file');
  assert.equal(fs.existsSync(path.join(f.workspace, 'added.js')), false);
  assert.equal(fs.readFileSync(path.join(f.workspace, f.artifact), 'utf8'), 'canonical artifact');
  assert.equal(fs.readFileSync(path.join(f.fork(), 'app.js'), 'utf8'), 'worker edit');
});
test('a failed provider process cannot publish a model-declared completed result', async (t) => {
  const f = fixture(t, { responseStatus: 'completed', terminalStatus: 1 });
  assert.equal((await f.execute()).status, 'failed');
  assert.equal(fs.readFileSync(path.join(f.workspace, 'app.js'), 'utf8'), 'canonical implementation');
  assert.equal(fs.readFileSync(path.join(f.workspace, f.artifact), 'utf8'), 'canonical artifact');
});
test('a completed result still publishes authorized source and assigned artifacts', async (t) => {
  const f = fixture(t, { responseStatus: 'completed' });
  const result = await f.execute();
  assert.equal(result.status, 'completed');
  assert.equal(fs.readFileSync(path.join(f.workspace, 'app.js'), 'utf8'), 'worker edit');
  assert.equal(fs.existsSync(path.join(f.workspace, 'keep.js')), false);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'added.js'), 'utf8'), 'worker addition');
  assert.equal(fs.readFileSync(path.join(f.workspace, f.artifact), 'utf8'), 'worker artifact');
});
test('durable receipt replay restores history without starting or charging another worker', async (t) => {
  const f = fixture(t, { maxTurns: 1 });
  const result = await f.execute();
  await f.executor.saveReceipt(f.dispatch(), result);
  const resumed = f.freshExecutor();
  assert.equal(resumed.turnsStarted, 1);
  assert.equal(resumed.observed.length, 1);
  assert.equal(resumed.observed[0].provider_thread_id, 'local-port-fixture');
  assert.equal(resumed.hasUnobservedStarts, false);
  assert.deepEqual(await resumed.loadReceipt(f.dispatch()), result);
  assert.equal(resumed.turnsStarted, 1);
  assert.equal(f.calls(), 1);
  await resumed.admit(f.dispatch());
  await assert.rejects(resumed.execute(f.dispatch()), (error) => error.code === 'execution_budget' && /budget exhausted/.test(error.message));
  assert.equal(f.calls(), 1);
});
test('a crashed unreceipted invocation remains charged and cannot be relaunched on restart', async (t) => {
  const f = fixture(t, { portThrows: true });
  await assert.rejects(f.execute(), /Synthetic unreceipted/);
  const resumed = f.freshExecutor();
  assert.equal(resumed.turnsStarted, 1);
  assert.equal(resumed.observed.length, 0);
  assert.equal(resumed.hasUnobservedStarts, true);
  await resumed.admit(f.dispatch());
  await assert.rejects(resumed.execute(f.dispatch()), /automatic retry is forbidden/);
  assert.equal(f.calls(), 1);
  assert.equal(resumed.turnsStarted, 1);
});
test('stored receipt integrity binds final status and artifacts as well as raw worker metadata', async (t) => {
  const f = fixture(t);
  const result = await f.execute();
  await f.executor.saveReceipt(f.dispatch(), result);
  const file = path.join(f.controllerRoot, 'executions', `${f.dispatch().request_digest}.json`);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  stored.result.status = 'completed';
  stored.result.artifacts = [{ path: 'fabricated.md', digest: 'b'.repeat(64) }];
  fs.writeFileSync(file, JSON.stringify(stored));
  await assert.rejects(f.freshExecutor().loadReceipt(f.dispatch()), /receipt drifted/);
});
test('contributors and dialogue participants cannot publish source edits in a source-authorized stage', async (t) => {
  for (const phase of ['contribute', 'dialogue']) {
    const f = fixture(t, { responseStatus: 'completed' });
    await assert.rejects(f.execute(phase), /source outside stage authority/);
    assert.equal(fs.readFileSync(path.join(f.workspace, 'app.js'), 'utf8'), 'canonical implementation');
    assert.equal(fs.readFileSync(path.join(f.workspace, 'keep.js'), 'utf8'), 'canonical retained file');
    assert.equal(fs.existsSync(path.join(f.workspace, 'added.js')), false);
    assert.equal(fs.readFileSync(path.join(f.workspace, f.artifact), 'utf8'), 'canonical artifact');
  }
});

test('every worker receives the registered aggregate case storage budget',async t=>{const storageBudget={scope_roots:['/synthetic-owned-case'],max_total_bytes:128*1024*1024,max_file_bytes:16*1024*1024,max_entries:10000,min_free_bytes:4*1024*1024*1024};const f=fixture(t,{responseStatus:'completed',storageBudget});await f.execute();assert.deepEqual(f.observedStorageBudget(),storageBudget);});
