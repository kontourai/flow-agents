/**
 * Compute an instinct's confidence from a preserved migration baseline and
 * distinct evidence boundaries. This only plans a value; callers must route any
 * resulting change through the memory review and Corpus proposal contracts.
 * The baseline is the confidence at lastObservedAt before subsequent decay;
 * baselineSources counts distinct evidence boundaries already in that baseline.
 * sourceIds must include those boundaries so additions are not undercounted.
 */
export function instinctConfidence({ baseline, baselineSources, sourceIds, lastObservedAt, now }) {
  if (typeof baseline !== 'number' || !Number.isFinite(baseline) || baseline < 0 || baseline > 1) throw new TypeError('baseline must be between 0 and 1');
  if (!Number.isSafeInteger(baselineSources) || baselineSources < 0) throw new TypeError('baselineSources must be a nonnegative integer');
  if (!Array.isArray(sourceIds) || sourceIds.some((id) => typeof id !== 'string' || !id)) throw new TypeError('sourceIds must contain nonempty strings');
  const observed = Date.parse(lastObservedAt);
  const current = Date.parse(now);
  if (!Number.isFinite(observed) || !Number.isFinite(current) || observed > current) throw new TypeError('observation and current times must be valid and ordered');
  const sources = new Set(sourceIds).size;
  const weeks = Math.floor((current - observed) / (7 * 24 * 60 * 60 * 1000));
  const added = Math.max(0, sources - baselineSources);
  // Import preserves the exact recorded value until evidence or time changes it.
  const confidence = added === 0 && weeks === 0 ? baseline : Math.max(0, Math.min(1, Number((baseline + added * 0.05 - weeks * 0.02).toFixed(6))));
  return { confidence, proposeRetirement: confidence < 0.2 };
}
