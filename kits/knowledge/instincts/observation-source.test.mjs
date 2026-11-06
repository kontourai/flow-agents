import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ingestObservationSources } from './observation-source.js';

test('the combined event limit fails before a second source is accepted', () => {
  const importer = (_data, { sourceId }) => ({ events: Array.from({ length: 50001 }, (_, i) => ({ sourceId, ordinal: i + 1 })), malformed: 0, partial: 0, cursor: { version: 1, sourceId, lines: 50001, digest: 'a'.repeat(64) } });
  const sources = ['one', 'two'].map((sourceId) => ({ sourceId, project: null, data: '', importer }));
  assert.throws(() => ingestObservationSources(sources, {}, {}, (event) => ({ sittingId: `${event.sourceId}:${event.ordinal}`, contentHash: 'fixture', provenance: { projectId: null } })), /event limit/);
});

test('observation ingestion asks the importer to refuse malformed lines', () => {
  const sourceId = 'fixture';
  const importer = (_data, options) => {
    assert.equal(options.maxMalformed, 0);
    return { events: [], malformed: 0, partial: 0, cursor: { version: 1, sourceId, lines: 0, digest: 'a'.repeat(64) } };
  };
  const result = ingestObservationSources([{ sourceId, project: null, data: '', importer }], {}, {}, () => { throw new Error('no events'); });
  assert.equal(result.batches.length, 1);
});

test('an earlier draft cursor is reported as needing scope reconciliation', () => {
  const sourceId = 'fixture'; const old = { version: 1, sourceId, lines: 1, digest: 'a'.repeat(64) };
  const result = ingestObservationSources([{ sourceId, project: null, data: '', importer: () => { throw new Error('must not run'); } }], { [`source:${sourceId}`]: old }, {}, () => { throw new Error('must not map'); }, { isolateFailures: true });
  assert.equal(result.batches.length, 0); assert.equal(result.blocked[0].reason, 'OBSERVATION_CURSOR_LEGACY'); assert.deepEqual(result.cursors[`source:${sourceId}`], old);
});

test('an over-budget source is reported separately and can be retried', () => {
  const importer = (_data, { sourceId }) => ({ events: Array.from({ length: 50001 }, (_, i) => ({ sourceId, ordinal: i + 1 })), malformed: 0, partial: 0, cursor: { version: 1, sourceId, lines: 50001, digest: 'a'.repeat(64) } });
  const sources = ['one', 'two'].map((sourceId) => ({ sourceId, project: null, data: '', importer }));
  const result = ingestObservationSources(sources, {}, {}, (event) => ({ sittingId: `${event.sourceId}:${event.ordinal}`, contentHash: 'fixture', provenance: { projectId: null } }), { isolateFailures: true });
  assert.equal(result.batches.length, 1); assert.equal(result.blocked[0].reason, 'OBSERVATION_EVENT_LIMIT'); assert.equal(result.blocked[0].errorClass, 'Error');
  const retry = ingestObservationSources([sources[1]], {}, {}, (event) => ({ sittingId: `${event.sourceId}:${event.ordinal}`, contentHash: 'fixture', provenance: { projectId: null } }), { isolateFailures: true });
  assert.equal(retry.batches.length, 1); assert.deepEqual(retry.blocked, []);
});

test('unexpected mapping errors fail the run instead of being hidden as bad input', () => {
  const sourceId = 'fixture';
  const importer = () => ({ events: [{ sourceId, ordinal: 1 }], malformed: 0, partial: 0, cursor: { version: 1, sourceId, lines: 1, digest: 'a'.repeat(64) } });
  assert.throws(() => ingestObservationSources([{ sourceId, project: null, data: '', importer }], {}, {}, () => { throw new TypeError('mapper defect'); }, { isolateFailures: true }), /mapper defect/);
});
