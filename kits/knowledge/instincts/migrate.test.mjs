import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { previewMigration } from './migrate.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
test('dry-run plans only source-backed instincts and writes nothing', (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'migration-preview-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacy = path.join(root, 'legacy'); const instincts = path.join(root, 'instincts'); fs.mkdirSync(legacy); fs.mkdirSync(instincts);
  const file = path.join(legacy, 'observations.jsonl'); fs.writeFileSync(file, 'fixture\n');
  const sourceId = `legacy-${hash('fixture\0observations.jsonl').slice(0, 48)}`; const eventId = hash(JSON.stringify([sourceId, 1]));
  const entry = { schema_version: '1.0', id: 'fixture', event: 'tool_complete', tool: 'shell', context: 'tests', resolution: 'run focused tests', scope: 'global', observed_at: '2026-01-01T00:00:00Z', confidence: 0.7, source_ids: [eventId] };
  fs.writeFileSync(path.join(instincts, 'instinct.json'), JSON.stringify([entry, { ...entry, id: 'missing', source_ids: ['unknown'] }]));
  const before = fs.readFileSync(file, 'utf8');
  const importer = (_data, options) => ({ events: [{ id: eventId, sourceId: options.sourceId, ordinal: 1, timestamp: '2026-01-01T00:00:00Z', session: 'fixture', projectId: 'fixture', projectName: 'fixture', tool: 'shell', event: 'tool_complete', output: 'run focused tests' }], malformed: 0, partial: 0, cursor: { version: 1, sourceId: options.sourceId, lines: 1, digest: 'a'.repeat(64) } });
  const report = previewMigration({ legacyRoot: legacy, instinctsRoot: instincts, sourceNamespace: 'fixture', sourceProjects: [{ file: 'observations.jsonl', project: null }], importer });
  assert.equal(fs.readFileSync(file, 'utf8'), before); assert.equal(report.writes, 0);
  assert.equal(report.observations.events, 1); assert.equal(report.observations.minimumRunsAtDefaultCap, 1); assert.equal(report.instincts.planned, 1); assert.equal(report.instincts.missingSources, 1);
  assert.deepEqual(report.instincts.confidence, [{ confidence: 0.7, count: 1 }]); assert.equal(report.diff.compiled_candidates, 1);
  assert.equal(report.brief.status, 'not-verified'); assert.ok(!JSON.stringify(report).includes('run focused tests'));
  const unbound = previewMigration({ legacyRoot: legacy, instinctsRoot: instincts, sourceNamespace: 'fixture', importer });
  assert.equal(unbound.instincts.planned, 0); assert.equal(unbound.instincts.unbound, 1);
  const mismatched = previewMigration({ legacyRoot: legacy, instinctsRoot: instincts, sourceNamespace: 'fixture', sourceProjects: [{ file: 'observations.jsonl', project: 'other' }], importer });
  assert.equal(mismatched.instincts.planned, 0); assert.equal(mismatched.instincts.scopeMismatch, 1);
  fs.writeFileSync(path.join(instincts, 'instinct.json'), JSON.stringify({ ...entry, source_ids: ['legacy-reference'] }));
  const mapping = [{ legacyId: 'legacy-reference', file: 'observations.jsonl', ordinal: 1 }];
  const mapped = previewMigration({ legacyRoot: legacy, instinctsRoot: instincts, sourceNamespace: 'fixture', sourceMap: mapping, sourceProjects: [{ file: 'observations.jsonl', project: null }], importer });
  assert.equal(mapped.instincts.planned, 1); assert.equal(mapped.instincts.sourceMapping, 'operator-supplied-unverified');
  const wrong = previewMigration({ legacyRoot: legacy, instinctsRoot: instincts, sourceNamespace: 'fixture', sourceMap: [{ ...mapping[0], ordinal: 2 }], sourceProjects: [{ file: 'observations.jsonl', project: null }], importer });
  assert.equal(wrong.instincts.planned, 0); assert.equal(wrong.instincts.missingSources, 1);
  assert.throws(() => previewMigration({ legacyRoot: legacy, instinctsRoot: instincts, sourceNamespace: 'fixture', sourceMap: [mapping[0], mapping[0]], importer }), /duplicate source mapping/);
  assert.throws(() => previewMigration({ legacyRoot: legacy, instinctsRoot: legacy, sourceNamespace: 'fixture', importer }), /select the instinct directory/);
});
test('missing instinct root is not reported as an empty inventory', (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'migration-preview-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const report = previewMigration({ legacyRoot: root, sourceNamespace: 'fixture', importer: () => { throw new Error('not used'); } });
  assert.equal(report.instincts.inventory, 'not-supplied'); assert.equal(report.writes, 0);
});

test('planned source and compiled shapes retain confidence through real Corpus review', async (t) => {
  const { KitDefaultStoreAdapter, standaloneFileMutationLock } = await import('@kontourai/corpus-store');
  const { planLegacyInstinct } = await import('./migrate.js');
  const { toolEventResidue } = await import('./tool-event-residue.js');
  const { decodeEnvelope } = await import('../dream/envelope.js');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'migration-corpus-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new KitDefaultStoreAdapter({ storeRoot: path.join(root, 'store'), coordinationDirectory: path.join(root, 'coord'), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock });
  const sourceId = 'fixture'; const ordinal = 1; const id = hash(JSON.stringify([sourceId, ordinal]));
  const source = toolEventResidue({ id, sourceId, ordinal, timestamp: '2026-01-01T00:00:00Z', session: 'fixture', projectId: 'fixture', projectName: 'fixture', tool: 'shell', event: 'tool_complete', output: 'run focused tests' });
  const value = { schema_version: '1.0', id: 'fixture', event: 'tool_complete', tool: 'shell', context: 'tests', resolution: 'run focused tests', scope: 'global', observed_at: '2026-01-02T00:00:00Z', confidence_at: '2026-01-02T00:00:00Z', confidence: 0.7, source_ids: [id] };
  const plan = planLegacyInstinct(value, [source], 'fixture');
  for (const raw of [plan.legacyRaw, ...plan.observationRaw]) {
    const proposal = await store.proposeCreate(raw, 'migrator', { agent: 'migrator', proposal: 'source' }, { requestKey: `fixture:${raw.id}` });
    await store.applyCreate(proposal, 'reviewer');
  }
  const evidence = { agent: 'migrator', proposal: 'instinct' };
  const proposal = await store.proposeCreate(plan.candidate, 'migrator', evidence, { requestKey: plan.requestKey });
  assert.equal(await store.proposeCreate(plan.candidate, 'migrator', evidence, { requestKey: plan.requestKey }), proposal);
  await assert.rejects(store.applyCreate(proposal, 'migrator'), (error) => error.code === 'SELF_APPROVAL');
  const recordId = await store.applyCreate(proposal, 'reviewer'); const record = await store.get(recordId);
  assert.equal(record.type, 'compiled'); assert.equal(record.confidence, 0.7); assert.ok(decodeEnvelope(record.body));
  assert.match(fs.readFileSync(path.join(root, 'store', 'records', `${recordId}.md`), 'utf8'), /confidence: 0\.7/);
  assert.deepEqual(new Set(record.provenance.source_ids), new Set([plan.legacyRaw.id, ...plan.observationRaw.map((item) => item.id)]));
  const { KnowledgeFlowRunner } = await import('../adapters/flow-runner/index.js');
  const runner = new KnowledgeFlowRunner({ store, workspace: root, agent: 'fixture' });
  const result = await runner.consolidate({ topic: 'memory.claim', category: 'memory.claim' }, { sourceRecordIds: [recordId], proposedBody: 'fixture snapshot', rationale: 'fixture', instincts: [{ recordId, sourceIds: [plan.observationRaw[0].id], baselineSources: 1, baselineAt: '2026-01-02T00:00:00Z', now: '2026-01-09T00:00:00Z', current: [], visibility: null }] });
  assert.equal(result.instinctPlans[0].confidence, 0.68);
  assert.equal(result.instinctPlans[0].status, 'requires-review');
  assert.equal((await store.get(recordId)).body, record.body, 'consolidation does not self-apply the confidence change');
});

test('the CLI requires explicit dry-run mode and does not create files', async (t) => {
  const { spawnSync } = await import('node:child_process'); const { fileURLToPath } = await import('node:url');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'migration-cli-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const command = fileURLToPath(new URL('./migrate.js', import.meta.url));
  const help = spawnSync(process.execPath, [command, '--help'], { cwd: root, encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /No records are written/); assert.deepEqual(fs.readdirSync(root), []);
  const missing = spawnSync(process.execPath, [command, '--legacy-root', root], { cwd: root, encoding: 'utf8' });
  assert.notEqual(missing.status, 0); assert.deepEqual(fs.readdirSync(root), []);
});

test('preview refuses symlinks and duplicate legacy identities', (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'migration-safety-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacy = path.join(root, 'legacy'); fs.mkdirSync(legacy); fs.symlinkSync(root, path.join(legacy, 'link'));
  assert.throws(() => previewMigration({ legacyRoot: legacy, sourceNamespace: 'fixture', importer: () => {} }), /symlink/);
  fs.unlinkSync(path.join(legacy, 'link')); const instincts = path.join(root, 'instincts'); fs.mkdirSync(instincts);
  const entry = { schema_version: '1.0', id: 'duplicate', event: 'tool_start', tool: 'shell', context: 'fixture', resolution: 'fixture', scope: 'global', observed_at: '2026-01-01T00:00:00Z', confidence: 0.5, source_ids: ['missing'] };
  fs.writeFileSync(path.join(instincts, 'instincts.json'), JSON.stringify([entry, entry]));
  assert.throws(() => previewMigration({ legacyRoot: legacy, instinctsRoot: instincts, sourceNamespace: 'fixture', importer: () => {} }), /duplicate legacy instinct/);
});
