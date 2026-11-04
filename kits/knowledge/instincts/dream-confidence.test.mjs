import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryClaim, routeMemoryChange } from '../adapters/memory-claims/index.mjs';
import { encodeEnvelope, decodeEnvelope } from '../dream/envelope.js';
import { confidenceOf } from '../dream/brief.js';

function sample(confidence) {
  const claim = memoryClaim({ subject: { type: 'service', id: 'sample' }, claimType: 'knowledge.memory-claim', property: 'pattern', value: 'example', speaker: 'owner', source: { ref: 'fixture', locator: 'chars:0-7', excerpt: 'example', observedAt: '2026-01-01T00:00:00Z' }, posture: 'stated', visibility: { kind: 'public' } });
  const entry = { claim, agreement: null, project: null, instinctConfidence: confidence };
  const decision = routeMemoryChange({ type: 'claim', claim, current: [], agreement: null, sourceVisibility: { kind: 'public' } });
  return encodeEnvelope({ plan: [entry], index: 0, decision, sitting: { id: 'fixture', contentHash: 'sha256:fixture', visibilityKey: 'public' } });
}
test('confidence is bound to the verified proposal plan and affects confidence scoring', () => {
  const envelope = decodeEnvelope(sample(0.8));
  assert.equal(envelope.instinctConfidence, 0.8);
  assert.ok(confidenceOf({ state: 'applied', instinctConfidence: 0.8 }) > confidenceOf({ state: 'applied', instinctConfidence: 0.3 }));
  assert.ok(confidenceOf({ state: 'pending', instinctConfidence: 1 }) < confidenceOf({ state: 'applied', instinctConfidence: 0 }));
  const tampered = JSON.parse(sample(0.8)); tampered.instinctConfidence = 1;
  assert.equal(decodeEnvelope(JSON.stringify(tampered)), null);
});
test('out of bounds confidence cannot be read as a verified envelope', () => {
  for (const value of [-1, 1.1, '0.8', null]) assert.equal(decodeEnvelope(sample(value)), null);
});

 test('legacy and confidence envelopes use distinct readable versions', () => {
  const value = JSON.parse(sample(0.8));
  assert.equal(value.dream, '1.3');
  value.dream = '1.2';
  assert.equal(decodeEnvelope(JSON.stringify(value)), null);
});
