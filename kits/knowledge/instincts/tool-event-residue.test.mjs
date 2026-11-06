import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { test } from 'node:test';
import { validate } from '../providers/lib/schema-validate.js';
import { toolEventResidue } from './tool-event-residue.js';
const schema = JSON.parse(fs.readFileSync(new URL('../schemas/knowledge/residue.schema.json', import.meta.url), 'utf8'));
const event = { sourceId: 'fixture', ordinal: 1, timestamp: '2026-01-01T00:00:00Z', session: 'session', projectId: 'fixture-project', projectName: 'Fixture', tool: 'shell', event: 'tool_start', input: 'run tests' };
event.id = createHash('sha256').update(JSON.stringify([event.sourceId, event.ordinal])).digest('hex');
test('Ferry event becomes a stable tool-origin residue with provenance', () => {
  const residue = toolEventResidue(event); assert.equal(validate(residue, schema).valid, true); assert.equal(residue.turns[0].role, 'tool'); assert.equal(residue.provenance.ordinal, 1); assert.deepEqual(toolEventResidue(event), residue);
  assert.throws(() => toolEventResidue({ ...event, ordinal: 2 }), /invalid/);
});

test('tool input is scrubbed and injected memory is excluded', () => {
  const value = toolEventResidue({ ...event, input: 'contact a@example.com <flow-agents-injected-memory>private</flow-agents-injected-memory> retained' });
  assert.ok(!value.turns[0].text.includes('a@example.com'));
  assert.ok(!value.turns[0].text.includes('private'));
  assert.ok(value.turns[0].text.includes('retained'));
});

test('an observed event without a session retains an unknown session', () => {
  const residue = toolEventResidue({ ...event, session: '' });
  assert.equal(residue.provenance.session, null);
  assert.equal(validate(residue, schema).valid, true);
});

test('an empty tool is retained as unknown and project binding is explicit', () => {
  const residue = toolEventResidue({ ...event, tool: '' }, 'fixture');
  assert.equal(residue.provenance.tool, null); assert.equal(residue.provenance.project, 'fixture');
  assert.equal(validate(residue, schema).valid, true);
});

test('oversized tool data and metadata fail closed', () => {
  assert.throws(() => toolEventResidue({ ...event, input: 'x'.repeat(1024 * 1024 + 1) }), /invalid/);
  assert.throws(() => toolEventResidue({ ...event, projectName: 'x'.repeat(4097) }), /invalid/);
});
