import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryClaim } from '../adapters/memory-claims/index.mjs';
import { planInstinctConsolidation, planClusterInstincts } from './consolidate.js';

const claim = memoryClaim({ subject: { type: 'instinct', id: 'fixture' }, claimType: 'knowledge.memory-claim', property: 'pattern', value: 'fixture', speaker: 'legacy-import', source: { ref: 'legacy-fixture', locator: 'chars:0-7', excerpt: 'fixture', observedAt: '2026-01-01T00:00:00Z' }, posture: 'proposed' });
test('consolidation plans decayed confidence and routes the same claim without applying', () => {
  const result = planInstinctConsolidation({ claim, confidence: { baseline: 0.21, baselineSources: 1, sourceIds: ['one'], lastObservedAt: '2026-01-01T00:00:00Z', now: '2026-01-08T00:00:00Z' } });
  assert.equal(result.confidence, 0.19); assert.equal(result.decision.changeId, claim.id);
  assert.deepEqual(result.retirement, { proposed: true, reason: 'confidence-below-0.2' });
  assert.equal(result.entry.claim.posture, 'proposed'); assert.equal(result.reviewItem.metadata.labels['memory.reviewer'], 'human-required');
});

test('the consolidate flow plans confidence from reviewed linked observations without mutating the instinct', async (t) => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { KitDefaultStoreAdapter, standaloneFileMutationLock } = await import('@kontourai/corpus-store');
  const { KnowledgeFlowRunner } = await import('../adapters/flow-runner/index.js');
  const { encodeEnvelope, visibilityKey } = await import('../dream/envelope.js');
  const { routeMemoryChange } = await import('../adapters/memory-claims/index.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instinct-consolidate-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new KitDefaultStoreAdapter({ storeRoot: path.join(root, 'store'), coordinationDirectory: path.join(root, 'coord'), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock });
  const rawProposal = await store.proposeCreate({ type: 'raw', title: 'Observation', category: 'memory.observation', body: JSON.stringify({ turn: { at: '2026-01-01T00:00:00Z' } }), provenance: { agent: 'producer' } }, 'producer', { agent: 'producer', proposal: 'source' });
  const rawId = await store.applyCreate(rawProposal, 'reviewer');
  const legacyProposal = await store.proposeCreate({ id: 'legacy-fixture', type: 'raw', title: 'Legacy', category: 'memory.legacy-instinct', body: `fixture\n\n${JSON.stringify({ confidence: 0.21, confidence_at: '2026-01-01T00:00:00Z' })}`, provenance: { agent: 'producer' } }, 'producer', { agent: 'producer', proposal: 'source' });
  const legacyId = await store.applyCreate(legacyProposal, 'reviewer');
  const entry = { claim, agreement: null, project: null };
  const decision = routeMemoryChange({ type: 'claim', claim, current: [], agreement: null, sourceVisibility: null });
  const body = encodeEnvelope({ plan: [entry], index: 0, decision, sitting: { id: 'fixture', contentHash: 'fixture', visibilityKey: visibilityKey(undefined) } });
  const compiledProposal = await store.proposeCreate({ type: 'compiled', title: 'Instinct', category: 'memory.claim', confidence: 0.21, body, provenance: { agent: 'producer', source_ids: [legacyId, rawId] }, links: [{ kind: 'source', target_id: legacyId }, { kind: 'source', target_id: rawId }] }, 'producer', { agent: 'producer', proposal: 'instinct' });
  const compiledId = await store.applyCreate(compiledProposal, 'reviewer'); const before = await store.get(compiledId);
  const runner = new KnowledgeFlowRunner({ store, workspace: root, agent: 'fixture' });
  const baseOptions = { sourceRecordIds: [compiledId], proposedBody: 'snapshot', rationale: 'fixture' };
  await assert.rejects(runner.consolidate({ topic: 'memory.claim', category: 'memory.claim' }, { ...baseOptions, instincts: [{ recordId: compiledId, sourceIds: [rawId], baselineSources: 1, baselineAt: '2026-01-02T00:00:00Z', now: '2026-01-08T00:00:00Z', current: [], visibility: null }] }), /baseline time/);
  assert.equal((await store.listByType('snapshot')).length, 0, 'invalid confidence evidence fails before snapshot writes');
  const result = await runner.consolidate({ topic: 'memory.claim', category: 'memory.claim' }, { sourceRecordIds: [compiledId], proposedBody: 'snapshot', rationale: 'fixture', instincts: [{ recordId: compiledId, sourceIds: [rawId], baselineSources: 1, baselineAt: '2026-01-01T00:00:00Z', now: '2026-01-08T00:00:00Z', current: [], visibility: null }] });
  assert.equal(result.instinctPlans.length, 1); assert.equal(result.instinctPlans[0].confidence, 0.19);
  assert.equal(result.instinctPlans[0].status, 'requires-review'); assert.equal(result.instinctPlans[0].decision.changeId, claim.id);
  assert.equal((await store.get(compiledId)).body, before.body, 'planning does not mutate the compiled instinct');
  const newProposal = await store.proposeCreate({ type: 'raw', title: 'New observation', category: 'memory.observation', body: JSON.stringify({ turn: { at: '2026-01-08T00:00:00Z' } }), provenance: { agent: 'producer' } }, 'producer', { agent: 'producer', proposal: 'source' });
  const newId = await store.applyCreate(newProposal, 'reviewer');
  await store.link(compiledId, [{ kind: 'source', target_id: newId }], { agent: 'reviewer' });
  const [reinforced] = await planClusterInstincts({ store, cluster: [compiledId], inputs: [{ recordId: compiledId, sourceIds: [rawId, newId], baselineSources: 1, baselineAt: '2026-01-01T00:00:00Z', now: '2026-01-15T00:00:00Z', current: [], visibility: null }] });
  assert.equal(reinforced.confidence, 0.24, 'one new reviewed source reinforces once and one inactive week decays');
  await assert.rejects(planClusterInstincts({ store, cluster: [compiledId], inputs: [{ recordId: compiledId, sourceIds: [newId], baselineSources: 0, baselineAt: '2026-01-01T00:00:00Z', now: '2026-01-15T00:00:00Z', current: [], visibility: null }] }), /baseline source was omitted/);
});
