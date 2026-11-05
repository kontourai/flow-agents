/** Plan an instinct confidence update through the existing claim router. No store writes. */
import { assertMemoryClaim, buildMemoryReviewItem, routeMemoryChange } from '../adapters/memory-claims/index.mjs';
import { instinctConfidence } from './confidence.js';

export function planInstinctConsolidation({ claim, confidence, current = [], visibility = null, project = null, policy } = {}) {
  assertMemoryClaim(claim);
  if (!Array.isArray(current) || (project !== null && typeof project !== 'string')) throw new TypeError('invalid consolidation context');
  const result = instinctConfidence(confidence);
  const decision = routeMemoryChange({ type: 'claim', claim, current, agreement: null, sourceVisibility: visibility }, policy);
  const reviewItem = buildMemoryReviewItem(decision);
  if (!reviewItem) throw new Error('instinct confidence change requires human review');
  return {
    entry: { claim, agreement: null, project },
    confidence: result.confidence,
    decision,
    claimReviewItem: reviewItem,
    confidenceReview: 'not-bound',
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
    if (!proposal || proposal.state !== 'applied' || proposal.record_id !== record.id || !proposal.reviewer_id || proposal.reviewer_id === proposal.proposer_id || proposal.candidate?.body !== record.body || proposal.candidate?.type !== record.type || proposal.candidate?.category !== record.category || proposal.candidate?.confidence !== record.confidence) return false;
    const recordLinks = new Set((record.links ?? []).map(({ kind, target_id }) => JSON.stringify([kind, target_id])));
    return (proposal.candidate.links ?? []).every(({ kind, target_id }) => recordLinks.has(JSON.stringify([kind, target_id]))) && JSON.stringify((proposal.candidate.provenance?.source_ids ?? []).slice().sort()) === JSON.stringify((record.provenance?.source_ids ?? []).slice().sort());
  }
  for (const input of inputs) {
    if (!input || typeof input.recordId !== 'string' || !cluster.includes(input.recordId) || seen.has(input.recordId) || !Array.isArray(input.sourceIds) || !input.sourceIds.length || input.sourceIds.length > 1000 || !Array.isArray(input.current) || !Object.hasOwn(input, 'visibility') || !Number.isSafeInteger(input.baselineSources) || input.baselineSources < 0) throw new Error('invalid instinct consolidation input');
    seen.add(input.recordId);
    const record = await store.get(input.recordId);
    if (!record || record.type !== 'compiled' || record.category !== 'memory.claim' || ['retired', 'purged'].includes(record.status) || !(await reviewed(record))) throw new Error('instinct record must be an active reviewed compiled claim');
    const envelope = decodeEnvelope(record.body);
    if (!envelope || typeof record.confidence !== 'number' || !Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1) throw new Error('instinct record lacks verified confidence');
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
    if (baselineIds.size > 1001 || !baselineIds.has(envelope.claim.source.ref)) throw new Error('instinct claim source is not in its baseline');
    let originalObservations = 0; let baselineLast = -Infinity; let recordedBaseline = null;
    for (const id of baselineIds) {
      const original = await store.get(id);
      if (!original || original.type !== 'raw' || ['retired', 'purged'].includes(original.status) || !(await reviewed(original))) throw new Error('instinct baseline source is not an active reviewed raw record');
      if (id === envelope.claim.source.ref) {
        const range = /^chars:(\d+)-(\d+)$/.exec(envelope.claim.source.locator);
        const start = range ? Number(range[1]) : NaN; const end = range ? Number(range[2]) : NaN;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start || end > original.body.length || original.body.slice(start, end) !== envelope.claim.source.excerpt) throw new Error('instinct claim excerpt is not supported by its source');
        try {
          const metadata = JSON.parse(original.body.slice(end).trim());
          if (metadata.confidence !== record.confidence || typeof metadata.confidence_at !== 'string') throw new Error('unverified');
          recordedBaseline = Date.parse(metadata.confidence_at);
        } catch { throw new Error('instinct confidence baseline time is not verified'); }
      }
      if (original.category === 'memory.observation') {
        originalObservations++;
        if (!sourceTimes.has(id)) throw new Error('instinct baseline source was omitted');
        baselineLast = Math.max(baselineLast, sourceTimes.get(id));
      }
    }
    if (input.baselineSources !== originalObservations) throw new Error('instinct baseline source count is not verified');
    // The legacy record's explicit observation time is the baseline for its
    // stored confidence. Original observations must not postdate it; new
    // reinforcement must be newer, so old evidence is never counted twice.
    const baselineAt = Date.parse(input.baselineAt);
    if (!Number.isFinite(baselineAt) || recordedBaseline !== baselineAt || baselineLast > baselineAt || [...sourceTimes].some(([id, time]) => !baselineIds.has(id) && time <= baselineAt)) throw new Error('instinct confidence baseline time is not verified');
    const anchor = Math.max(baselineAt, last);
    const planned = planInstinctConsolidation({ claim: envelope.claim, current: input.current, visibility: input.visibility, project: envelope.project, policy: input.policy, confidence: { baseline: record.confidence, baselineSources: input.baselineSources, sourceIds, lastObservedAt: new Date(anchor).toISOString(), now: input.now } });
    plans.push({ recordId: input.recordId, status: 'requires-review', ...planned });
  }
  return plans;
}
