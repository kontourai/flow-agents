import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importObservationSource } from './observation-source.js';

// Fixture only: supplies an already-constructed Ferry result and parses no data.
function fixtureImporter(data, options) {
  assert.equal(data, 'fixture input');
  return { events: [{ id: 'event-id', sourceId: options.sourceId, ordinal: 1, timestamp: '2026-01-01T00:00:00Z', session: 'session', projectId: 'project', projectName: 'project', event: 'tool_start', tool: 'tool' }], malformed: 0, partial: 0, cursor: { version: 1, sourceId: options.sourceId, lines: 1, digest: 'a'.repeat(64) } };
}
test('the fixture importer uses the merged Ferry API shape', () => {
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
  assert.throws(() => importObservationSource(null, '', options), /importer/);
  assert.throws(() => importObservationSource(fixtureImporter, '', { sourceId: '' }), /sourceId/);
});
