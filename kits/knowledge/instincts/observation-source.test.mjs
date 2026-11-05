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
  const sources = ['one', 'two'].map((sourceId) => ({ sourceId, data: '', importer }));
  assert.throws(() => ingestObservationSources(sources, {}, {}, (event) => ({ sittingId: `${event.sourceId}:${event.ordinal}`, contentHash: 'fixture' })), /event limit/);
});
