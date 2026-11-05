import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { KitDefaultStoreAdapter, standaloneFileMutationLock } from '@kontourai/corpus-store';
import { memoryClaim, routeMemoryChange } from '../adapters/memory-claims/index.mjs';
import { encodeEnvelope, visibilityKey } from '../dream/envelope.js';
import { planClusterInstincts } from './consolidate.js';

async function fixture(t, { observationAt = '2026-01-01T00:00:00Z', baselineAt = '2026-01-01T00:00:00Z', metadataConfidence = 0.21, sourceText = 'fixture', includeLegacy = true } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'instinct-guards-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new KitDefaultStoreAdapter({ storeRoot: path.join(root, 'store'), coordinationDirectory: path.join(root, 'coord'), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock });
  async function reviewedRaw(id, category, body) {
    const proposal = await store.proposeCreate({ id, type: 'raw', title: id, category, body, provenance: { agent: 'producer' } }, 'producer', { agent: 'producer', proposal: 'source' });
    return store.applyCreate(proposal, 'reviewer');
  }
  const obs = await reviewedRaw('observation-fixture', 'memory.observation', JSON.stringify({ turn: { at: observationAt } }));
  const legacy = await reviewedRaw('legacy-fixture', 'memory.legacy-instinct', `${sourceText}\n\n${JSON.stringify({ confidence: metadataConfidence, confidence_at: baselineAt })}`);
  const claim = memoryClaim({ subject: { type: 'instinct', id: 'fixture' }, claimType: 'knowledge.memory-claim', property: 'pattern', value: 'fixture', speaker: 'legacy-import', source: { ref: legacy, locator: 'chars:0-7', excerpt: 'fixture', observedAt: baselineAt }, posture: 'proposed' });
  const decision = routeMemoryChange({ type: 'claim', claim, current: [], agreement: null, sourceVisibility: null });
  const body = encodeEnvelope({ plan: [{ claim, agreement: null, project: null }], index: 0, decision, sitting: { id: 'fixture', contentHash: 'fixture', visibilityKey: visibilityKey(undefined) } });
  const ids = includeLegacy ? [legacy, obs] : [obs];
  const proposal = await store.proposeCreate({ type: 'compiled', title: 'Instinct', category: 'memory.claim', confidence: 0.21, body, provenance: { agent: 'producer', source_ids: ids }, links: ids.map((target_id) => ({ kind: 'source', target_id })) }, 'producer', { agent: 'producer', proposal: 'instinct' });
  const compiled = await store.applyCreate(proposal, 'reviewer');
  const input = { recordId: compiled, sourceIds: [obs], baselineSources: 1, baselineAt, now: '2026-01-15T00:00:00Z', current: [], visibility: null };
  return { store, input, obs, legacy, compiled, reviewedRaw };
}

const plan = ({ store, compiled, input }) => planClusterInstincts({ store, cluster: [compiled], inputs: [input] });
test('unreviewed confidence changes are refused', async (t) => {
  const f = await fixture(t); await f.store.update(f.compiled, { confidence: 0.5 }, { agent: 'other' });
  await assert.rejects(plan(f), /active reviewed compiled claim/);
});
test('the claim source must belong to the original baseline', async (t) => {
  const f = await fixture(t, { includeLegacy: false }); await assert.rejects(plan(f), /claim source is not in its baseline/);
});
test('the reviewed source must support the claim excerpt', async (t) => {
  const f = await fixture(t, { sourceText: 'changed' }); await assert.rejects(plan(f), /excerpt is not supported/);
});
test('the reviewed source must bind the baseline confidence', async (t) => {
  const f = await fixture(t, { metadataConfidence: 0.2 }); await assert.rejects(plan(f), /baseline time is not verified/);
});
test('baseline observations cannot postdate the recorded confidence', async (t) => {
  const f = await fixture(t, { observationAt: '2026-01-02T00:00:00Z' }); await assert.rejects(plan(f), /baseline time is not verified/);
});
test('an unreviewed raw observation cannot reinforce confidence', async (t) => {
  const f = await fixture(t); const id = await f.store.create({ type: 'raw', title: 'Unreviewed', category: 'memory.observation', body: JSON.stringify({ turn: { at: '2026-01-08T00:00:00Z' } }), provenance: { agent: 'producer' } });
  await f.store.link(f.compiled, [{ kind: 'source', target_id: id }], { agent: 'producer' }); f.input.sourceIds.push(id);
  await assert.rejects(plan(f), /active reviewed observation/);
});
test('old evidence cannot be counted as new reinforcement', async (t) => {
  const f = await fixture(t); const id = await f.reviewedRaw('old-observation', 'memory.observation', JSON.stringify({ turn: { at: '2025-12-31T00:00:00Z' } }));
  await f.store.link(f.compiled, [{ kind: 'source', target_id: id }], { agent: 'reviewer' }); f.input.sourceIds.push(id);
  await assert.rejects(plan(f), /baseline time is not verified/);
});
