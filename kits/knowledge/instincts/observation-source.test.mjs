import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importObservationSource, ingestObservationSources } from './observation-source.js';

// Fixture only: supplies an already-constructed Ferry result and parses no data.
function fixtureImporter(data, options) {
  assert.equal(data, 'fixture input');
  return { events: [{ id: 'event-id', sourceId: options.sourceId, ordinal: 1, timestamp: '2026-01-01T00:00:00Z', session: 'session', projectId: 'project', projectName: 'project', event: 'tool_start', tool: 'tool' }], malformed: 0, partial: 0, cursor: { version: 1, sourceId: options.sourceId, lines: 1, digest: 'a'.repeat(64) } };
}
test('the stand-in importer returns a fixture in the documented API shape', () => {
  const result = importObservationSource(fixtureImporter, 'fixture input', { sourceId: 'fixture' });
  assert.equal(result.events[0].sourceId, 'fixture');
  assert.deepEqual(result.cursor, { version: 1, sourceId: 'fixture', lines: 1, digest: 'a'.repeat(64) });
  assert.equal(result.malformed, 0); assert.equal(result.partial, 0);
});
test('passes the saved cursor and limits through without letting an importer mutate them', () => {
  const options = { sourceId: 'fixture', cursor: { version: 1, sourceId: 'fixture', lines: 1, digest: 'a'.repeat(64) }, maxMalformed: 2 };
  const result = importObservationSource((data, input) => { assert.equal(input.maxMalformed, 2); assert.equal(input.cursor.lines, 1); input.cursor.lines = 2; return { events: [], malformed: 0, partial: 1, cursor: input.cursor }; }, '', options);
  assert.equal(options.cursor.lines, 1); assert.equal(result.cursor.lines, 2); assert.equal(result.partial, 1);
});
test('propagates importer errors without advancing or replacing the cursor', () => {
  const options = { sourceId: 'fixture', cursor: { version: 1, sourceId: 'fixture', lines: 1, digest: 'a'.repeat(64) } };
  assert.throws(() => importObservationSource(() => { throw new Error('prefix changed'); }, '', options), /prefix changed/);
  assert.equal(options.cursor.lines, 1);
  assert.throws(() => importObservationSource(null, '', options), (error) => error instanceof TypeError && error.message === 'observation importer must be a function');
  for (const sourceId of ['', '   ']) assert.throws(() => importObservationSource(() => 'wrong', '', { sourceId }), /sourceId/);
});

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
