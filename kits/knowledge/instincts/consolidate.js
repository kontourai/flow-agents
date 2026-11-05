/** Plan an instinct confidence update through the existing claim router. No store writes. */
import { assertMemoryClaim, routeMemoryChange } from '../adapters/memory-claims/index.mjs';
import { instinctConfidence } from './confidence.js';

export function planInstinctConsolidation({ claim, confidence, current = [], visibility = null, project = null, policy } = {}) {
  assertMemoryClaim(claim);
  if (!Array.isArray(current) || (project !== null && typeof project !== 'string')) throw new TypeError('invalid consolidation context');
  const result = instinctConfidence(confidence);
  const decision = routeMemoryChange({ type: 'claim', claim, current, agreement: null, sourceVisibility: visibility }, policy);
  return {
    entry: { claim, agreement: null, project, instinctConfidence: result.confidence },
    decision,
    retirement: result.proposeRetirement ? { proposed: true, reason: 'confidence-below-0.2' } : null,
  };
}

/** Plan confidence changes for reviewed compiled records in a consolidate cluster. */
export async function planClusterInstincts({ store, cluster, inputs }) {
  if (!Array.isArray(inputs) || inputs.length > 128 || !Array.isArray(cluster)) throw new TypeError('instinct inputs must be a bounded array');
  const { decodeEnvelope } = await import('../dream/envelope.js');
  if (typeof store?.getProposal !== 'function') throw new Error('store cannot verify review provenance');
  const plans = []; const seen = new Set(); let totalSources = 0;
  async function reviewed(record) {
    const log = (record.mutation_log ?? []).find((item) => item.op === 'apply-create' && typeof item.evidence?.proposal_id === 'string');
    if (!log) return false;
    const proposal = await store.getProposal(log.evidence.proposal_id);
    if (!proposal || proposal.state !== 'applied' || proposal.record_id !== record.id || !proposal.reviewer_id || proposal.reviewer_id === proposal.proposer_id || proposal.candidate?.body !== record.body || proposal.candidate?.type !== record.type || proposal.candidate?.category !== record.category) return false;
    const recordLinks = new Set((record.links ?? []).map(({ kind, target_id }) => JSON.stringify([kind, target_id])));
    return (proposal.candidate.links ?? []).every(({ kind, target_id }) => recordLinks.has(JSON.stringify([kind, target_id]))) && JSON.stringify((proposal.candidate.provenance?.source_ids ?? []).slice().sort()) === JSON.stringify((record.provenance?.source_ids ?? []).slice().sort());
  }
  for (const input of inputs) {
    if (!input || typeof input.recordId !== 'string' || !cluster.includes(input.recordId) || seen.has(input.recordId) || !Array.isArray(input.sourceIds) || !input.sourceIds.length || input.sourceIds.length > 1000 || !Array.isArray(input.current) || !Object.hasOwn(input, 'visibility') || !Number.isSafeInteger(input.baselineSources) || input.baselineSources < 0) throw new Error('invalid instinct consolidation input');
    seen.add(input.recordId);
    const record = await store.get(input.recordId);
    if (!record || record.type !== 'compiled' || record.category !== 'memory.claim' || ['retired', 'purged'].includes(record.status) || !(await reviewed(record))) throw new Error('instinct record must be an active reviewed compiled claim');
    const envelope = decodeEnvelope(record.body);
    if (!envelope || typeof envelope.instinctConfidence !== 'number') throw new Error('instinct record lacks verified confidence');
    const sourceIds = [...new Set(input.sourceIds)];
    totalSources += sourceIds.length;
    if (sourceIds.length !== input.sourceIds.length || input.baselineSources > sourceIds.length || totalSources > 1000) throw new Error('invalid instinct source boundaries');
    const linked = new Set((record.links ?? []).filter((link) => link.kind === 'source').map((link) => link.target_id));
    let last = -Infinity; const sourceTimes = new Map();
    for (const id of sourceIds) {
      if (typeof id !== 'string' || !linked.has(id)) throw new Error('instinct source is not linked');
      const source = await store.get(id);
      if (!source || source.type !== 'raw' || source.category !== 'memory.observation' || ['retired', 'purged'].includes(source.status) || !(await reviewed(source))) throw new Error('instinct source must be an active reviewed observation');
      let time; try { time = Date.parse(JSON.parse(source.body).turn.at); } catch { time = NaN; }
      if (!Number.isFinite(time)) throw new Error('instinct source lacks an observation time');
      last = Math.max(last, time); sourceTimes.set(id, time);
    }
    const baselineIds = new Set(record.provenance?.source_ids ?? []);
    let originalObservations = 0; let baselineLast = -Infinity;
    for (const id of baselineIds) {
      const original = await store.get(id);
      if (!original) throw new Error('instinct baseline source is missing');
      if (original.category === 'memory.observation') {
        originalObservations++;
        if (!sourceTimes.has(id)) throw new Error('instinct baseline source was omitted');
        baselineLast = Math.max(baselineLast, sourceTimes.get(id));
      }
    }
    if (input.baselineSources !== originalObservations) throw new Error('instinct baseline source count is not verified');
    // Confidence dates imported without an explicit baseline cannot safely be decayed.
    if (!input.baselineAt || Date.parse(input.baselineAt) !== baselineLast || Date.parse(envelope.claim.source.observedAt) !== baselineLast) throw new Error('instinct confidence baseline time is not verified');
    const planned = planInstinctConsolidation({ claim: envelope.claim, current: input.current, visibility: input.visibility, project: envelope.project, policy: input.policy, confidence: { baseline: envelope.instinctConfidence, baselineSources: input.baselineSources, sourceIds, lastObservedAt: new Date(last).toISOString(), now: input.now } });
    plans.push({ recordId: input.recordId, status: 'requires-review', ...planned });
  }
  return plans;
}
