import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { createKnowledgeLearningLifecycle } from '@kontourai/flow-agents/knowledge-learning';
import { createLocalFileKnowledgeLearningStore } from '@kontourai/flow-agents/knowledge-learning-file';
import { KnowledgeLearningError } from '@kontourai/flow-agents/knowledge-learning-contract';

const refKey = ({ authority, kind, id, revision }) => JSON.stringify([authority, kind, id, revision]);
const scope = { kind: 'project', id: 'project-demo' };
const source = { authority: 'knowledge', kind: 'record', id: 'source-1', revision: 'source-revision-1' };
const target = { authority: 'station', kind: 'project-context', id: scope.id, revision: 'target-1' };
const evaluation = { authority: 'flow', kind: 'evaluation', id: 'evaluation-1', revision: 'evaluation-revision-1' };
const proposal = { kind: 'guideline', title: 'Preserve source authority', body: 'Refresh the selected source before an action.', expectedEffect: 'Avoid decisions based on stale account or Task facts.', scope, supporting: [source], counter: [], conflicts: [], targets: [target] };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-learning-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const refs = new Map([source, target, evaluation].map(ref => [refKey(ref), ref]));
  let authorized = true, mayDecide = true, afterRead;
  const host = {
    authorize: async requested => {
      if (!authorized || JSON.stringify(requested) !== JSON.stringify(scope)) throw new KnowledgeLearningError('restricted');
      return { actorId: 'person:reviewer', mayDecide, assertCurrent() { if (!authorized) throw new KnowledgeLearningError('restricted'); } };
    },
    readEvidence: async ref => { const value = refs.get(refKey(ref)); afterRead?.(); return value; },
  };
  const service = () => createKnowledgeLearningLifecycle(createLocalFileKnowledgeLearningStore(root), host);
  return { root, service, host, refs, setAuthorized(value) { authorized = value; }, setMayDecide(value) { mayDecide = value; }, afterRead(value) { afterRead = value; } };
}
const intent = (action, expectedRevision, extra = {}) => ({ intentId: `${action}-${expectedRevision}`, learningId: 'learning-1', scope, expectedRevision, action, ...extra });
async function approve(service) {
  await service.apply(intent('propose', 0, { proposal }));
  await service.apply(intent('evaluate', 1, { status: 'supported', evidence: [evaluation] }));
  await service.apply(intent('approve', 2, { rationale: 'Compared the source and evaluation before approval.' }));
}

test('actual private store: reviewed activation contributes exact revision, no effect is invented, retirement stops contribution', async t => {
  const f = fixture(t), service = f.service();
  await approve(service);
  let active = await service.active(scope);
  assert.equal(active.coverage, 'complete'); assert.equal(active.records.length, 0);
  const receipt = await service.apply(intent('activate', 3));
  const projection = await service.get(scope, 'learning-1');
  assert.equal(projection.state, 'available'); assert.equal(projection.active, true);
  assert.equal(projection.record.activation.revision, projection.record.contentRevision);
  assert.deepEqual(projection.record.effects, []);
  assert.equal(projection.receipts.at(-1).id, receipt.id);
  active = await service.active(scope); assert.equal(active.records.length, 1);
  await service.apply(intent('observe-effect', 4, { assessment: 'unresolved', evidence: evaluation }));
  assert.equal((await service.get(scope, 'learning-1')).record.effects[0].assessment, 'unresolved');
  await service.apply(intent('retire', 5, { reason: 'Replaced by a current project policy.' }));
  assert.deepEqual((await service.active(scope)).records, []);
  assert.equal((await service.get(scope, 'learning-1')).receipts.length, 6);
});

test('lost-reply replay after a fresh service returns original receipt; reused identity with changed bytes is refused', async t => {
  const f = fixture(t), first = intent('propose', 0, { proposal });
  const receipt = await f.service().apply(first);
  assert.deepEqual(await f.service().apply(first), receipt);
  await assert.rejects(f.service().apply({ ...first, proposal: { ...proposal, body: 'Different intent' } }), { code: 'conflict' });
  assert.equal((await f.service().get(scope, 'learning-1')).receipts.length, 1);
});

test('two fresh store instances racing one revision admit one owner mutation', async t => {
  const f = fixture(t); await approve(f.service());
  const results = await Promise.allSettled([f.service().apply(intent('activate', 3)), f.service().apply({ ...intent('activate', 3), intentId: 'other-activation' })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'stale');
  assert.equal((await f.service().get(scope, 'learning-1')).record.revision, 4);
});

test('a proposal is not an activation and agent capabilities cannot approve', async t => {
  const f = fixture(t); await f.service().apply(intent('propose', 0, { proposal }));
  await assert.rejects(f.service().apply(intent('activate', 1)), { code: 'conflict' });
  await f.service().apply(intent('evaluate', 1, { status: 'inconclusive', evidence: [evaluation] }));
  f.setMayDecide(false);
  await assert.rejects(f.service().apply(intent('approve', 2, { rationale: 'not authorized' })), { code: 'restricted' });
  assert.equal((await f.service().get(scope, 'learning-1')).active, false);
});

test('source or authority revocation withholds identity/body and prevents pending proposal commit', async t => {
  const f = fixture(t); f.afterRead(() => f.setAuthorized(false));
  await assert.rejects(f.service().apply(intent('propose', 0, { proposal })), { code: 'restricted' });
  assert.equal(fs.existsSync(path.join(f.root, 'knowledge-learning', 'registry.json')), false);
  f.afterRead(undefined); f.setAuthorized(true); await approve(f.service());
  await f.service().apply(intent('activate', 3)); f.refs.delete(refKey(source));
  assert.deepEqual(await f.service().get(scope, 'learning-1'), { state: 'restricted' });
  assert.deepEqual(await f.service().active(scope), { records: [], coverage: 'partial' });
  await f.service().apply(intent('retire', 4, { reason: 'Withdraw without requiring access to the revoked source.' }));
});

test('corrupt or forged raw-record activation is unavailable rather than usable guidance', async t => {
  const f = fixture(t); await f.service().apply(intent('propose', 0, { proposal }));
  const file = path.join(f.root, 'knowledge-learning', 'registry.json');
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  registry.records[0].activation = { revision: registry.records[0].contentRevision, targets: [target], receiptId: 'invented' };
  fs.writeFileSync(file, JSON.stringify(registry), { mode: 0o600 });
  assert.deepEqual(await f.service().get(scope, 'learning-1'), { state: 'unavailable' });
  await assert.rejects(f.service().apply(intent('evaluate', 1, { status: 'supported', evidence: [evaluation] })));
});

test('intent JSON cannot carry host authority and unknown evidence never becomes an approved fact', async t => {
  const f = fixture(t);
  await assert.rejects(f.service().apply({ ...intent('propose', 0, { proposal }), actorId: 'operator', mayDecide: true }), { code: 'invalid' });
  await assert.rejects(f.service().apply(intent('propose', 0, { proposal: { ...proposal, supporting: [{ ...source, revision: 'missing' }] } })), { code: 'restricted' });
  assert.deepEqual((await f.service().active(scope)).records, []);
});


test('retained retire receipt cannot be erased from materialized lifecycle state', async t => {
  const f = fixture(t); await approve(f.service());
  await f.service().apply(intent('activate', 3));
  await f.service().apply(intent('retire', 4, { reason: 'Withdraw this guidance.' }));
  const file = path.join(f.root, 'knowledge-learning', 'registry.json');
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete registry.records[0].retirement;
  fs.writeFileSync(file, JSON.stringify(registry), { mode: 0o600 });
  assert.deepEqual(await f.service().get(scope, 'learning-1'), { state: 'unavailable' });
  assert.equal((await f.service().active(scope)).records.length, 0);
});

test('revocation after transaction callback settlement is checked at physical commit', async t => {
  const f = fixture(t), store = createLocalFileKnowledgeLearningStore(f.root);
  const delayed = { read: () => store.read(), transact: operation => store.transact(async registry => {
    const result = await operation(registry);
    queueMicrotask(() => f.setAuthorized(false));
    return result;
  }) };
  const service = createKnowledgeLearningLifecycle(delayed, f.host);
  await assert.rejects(service.apply(intent('propose', 0, { proposal })), { code: 'restricted' });
  assert.equal(fs.existsSync(path.join(f.root, 'knowledge-learning', 'registry.json')), false);
});

test('new registry directory is durably linked before initial success or record publication', async t => {
  const f = fixture(t), rootIdentity = fs.statSync(f.root), original = fs.fsyncSync;
  fs.fsyncSync = descriptor => {
    const identity = fs.fstatSync(descriptor);
    if (identity.dev === rootIdentity.dev && identity.ino === rootIdentity.ino) throw new Error('injected parent sync failure');
    original(descriptor);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.service().apply(intent('propose', 0, { proposal })), /injected parent sync failure/);
    assert.equal(fs.existsSync(path.join(f.root, 'knowledge-learning', 'registry.json')), false);
  } finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
});


test('active-set read batches one canonical snapshot and observes retirement on the next request', async t => {
  const f = fixture(t); await approve(f.service()); await f.service().apply(intent('activate', 3));
  const actual = createLocalFileKnowledgeLearningStore(f.root); let reads = 0;
  const service = createKnowledgeLearningLifecycle({ read: async () => { reads += 1; return actual.read(); }, transact: operation => actual.transact(operation) }, f.host);
  assert.equal((await service.active(scope)).records.length, 1); assert.equal(reads, 1);
  await f.service().apply(intent('retire', 4, { reason: 'New policy' }));
  assert.equal((await service.active(scope)).records.length, 0); assert.equal(reads, 2);
});
