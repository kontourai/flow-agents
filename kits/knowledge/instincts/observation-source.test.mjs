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
  await assert.rejects(readObservationResidues({ read: () => ({ residues: [{ ...fixture, turns: [] }], cursor: {} }) }), /invalid/);
});

test('the adapter cannot change the caller cursor', async () => {
  const cursor = { nested: { offset: 7 } };
  await readObservationResidues({ read(input) { input.nested.offset = 99; return { residues: [], cursor: input }; } }, cursor);
  assert.equal(cursor.nested.offset, 7);
});
test('the adapter rejects an oversized batch before consuming it', async () => {
  await assert.rejects(readObservationResidues({ read: () => ({ residues: Array(1001).fill(fixture), cursor: {} }) }), /adapter result/);
});
test('a valid non-runtime residue is not an observation', async () => {
  const sidecar = { sessionDir: 'fixture', sessionMarkdown: null, slug: 'fixture', repo: null, status: null, phase: null, planSummary: '', definitionOfDone: '', decisions: [], learnings: [], evidence: null, critiqueSummary: '', transcriptRefs: [], touchedFiles: [] };
  await assert.rejects(readObservationResidues({ read: () => ({ residues: [sidecar], cursor: {} }) }), /invalid/);
});
