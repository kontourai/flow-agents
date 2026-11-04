import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readObservationResidues } from './observation-source.js';

const fixture = JSON.parse(readFileSync(new URL('../promote/fixtures/runtime-residue-669.json', import.meta.url), 'utf8'));
// Fixture adapter only: never interprets observation files or writes cursors.
const fixtureAdapter = { async read(cursor) { return { residues: cursor.done ? [] : [fixture], cursor: { done: true } }; } };
test('fixture adapter returns the existing residue contract and does not mutate its input cursor', async () => {
  const cursor = {}; const result = await readObservationResidues(fixtureAdapter, cursor);
  assert.equal(result.residues[0].sittingId, fixture.sittingId); assert.deepEqual(cursor, {});
  assert.deepEqual((await readObservationResidues(fixtureAdapter, result.cursor)).residues, []);
});
test('invalid and duplicate residues fail closed', async () => {
  await assert.rejects(readObservationResidues({ read: () => ({ residues: [fixture, fixture], cursor: {} }) }), /duplicate/);
  await assert.rejects(readObservationResidues({ read: () => ({ residues: [{ ...fixture, source: 'unknown' }], cursor: {} }) }), /invalid/);
});
