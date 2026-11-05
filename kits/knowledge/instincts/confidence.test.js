import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instinctConfidence } from './confidence.js';

const base = { baseline: 0.3, baselineSources: 1, sourceIds: ['a'], lastObservedAt: '2026-01-01T00:00:00Z', now: '2026-01-01T00:00:00Z' };
test('distinct observations reinforce once and complete inactive weeks decay', () => {
  assert.deepEqual(instinctConfidence({ ...base, sourceIds: ['a', 'b', 'b', 'c'], now: '2026-01-15T00:00:00Z' }), { confidence: 0.36, proposeRetirement: false });
  assert.equal(instinctConfidence({ ...base, now: '2026-01-07T23:59:59Z' }).confidence, 0.3);
});
test('confidence is bounded and retirement is proposed only below threshold', () => {
  assert.equal(instinctConfidence({ ...base, baseline: 1, sourceIds: ['a', 'b'] }).confidence, 1);
  assert.equal(instinctConfidence({ ...base, baseline: 0.2 }).proposeRetirement, false);
  assert.deepEqual(instinctConfidence({ ...base, baseline: 0.2, now: '2026-01-08T00:00:00Z' }), { confidence: 0.18, proposeRetirement: true });
  assert.equal(instinctConfidence({ ...base, baseline: 0, now: '2026-01-08T00:00:00Z' }).confidence, 0);
});
test('invalid state and future evidence are refused', () => {
  for (const change of [{ baseline: NaN }, { baselineSources: -1 }, { sourceIds: [''] }, { now: 'bad' }, { now: '2025-12-31T00:00:00Z' }]) assert.throws(() => instinctConfidence({ ...base, ...change }), TypeError);
});

test('an unchanged baseline keeps its recorded precision', () => {
  for (const baseline of [0.1234567, 0.333333333]) assert.equal(instinctConfidence({ ...base, baseline }).confidence, baseline);
});
