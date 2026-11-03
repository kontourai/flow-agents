import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotDir } from './lib.js';
import { ingestFromSource, runPromote } from './index.js';

// Produced by #669 ingestRuntimeSessions from its runtime rollout fixture.
const residue = JSON.parse(fs.readFileSync(new URL('./fixtures/runtime-residue-669.json', import.meta.url)));
const candidates = [{ title: 'A learning', body: 'Distilled content', category: 'memory.learning' }];
function setup() {
  const calls = [];
  return { calls, opts: { target: 'store', residue, candidates, proposerId: 'distiller', root: '/authorized/memory', rootName: 'memory',
    registerRoot: async (...args) => calls.push(['register', ...args]),
    store: { proposeCreate: async (...args) => { calls.push(['propose', ...args]); return 'proposal-1'; } },
  } };
}

test('store target registers the host root and passes distilled content and all provenance to Corpus', async () => {
  const { calls, opts } = setup();
  const result = await runPromote(opts);
  assert.deepEqual(result, { root: 'memory', posture: 'proposed', review_state: 'not_observed', proposals: ['proposal-1'] });
  assert.deepEqual(calls[0], ['register', 'memory', '/authorized/memory']);
  assert.equal(calls.length, 2);
  const [, candidate, proposer, evidence, options] = calls[1];
  assert.deepEqual(candidate, { type: 'raw', ...candidates[0], provenance: { agent: 'distiller', session_id: residue.provenance.sessionId, note: JSON.stringify({ session_id: residue.provenance.sessionId, transcript_ref: residue.provenance.transcriptRef, sitting_id: residue.sittingId, content_hash: residue.contentHash }) } });
  assert.equal(proposer, 'distiller');
  assert.equal(evidence.agent, 'distiller');
  assert.match(options.requestKey, /^knowledge\.promote:[a-f0-9]{64}$/);
  await runPromote(opts);
  assert.equal(calls[3][4].requestKey, options.requestKey);
  assert.ok(!options.requestKey.includes(residue.provenance.sessionId));
});

test('missing provenance, incomplete sittings and invalid candidates fail before registration or writes', async () => {
  for (const change of [
    { residue: { ...residue, sittingId: '' } },
    { residue: { ...residue, provenance: { ...residue.provenance, sessionId: '' } } },
    { residue: { ...residue, provenance: { ...residue.provenance, transcriptRef: '' } } },
    { residue: { ...residue, complete: false } },
    { residue: { ...residue, contentHash: 'invalid' } },
    { residue: { ...residue, provenance: { ...residue.provenance, harness: 'unknown' } } },
    { residue: { ...residue, turns: [] } },
    { residue: { ...residue, extra: true } },
    { residue: { ...residue, sittingId: 'codex:another-session:0' } },
    { candidates: [{ ...candidates[0], tags: ['ignored'] }] },
    { write: 'false' },
    { candidates: [{ ...candidates[0], body: '' }] },
    { root: 'relative' },
  ]) {
    const { calls, opts } = setup();
    await assert.rejects(runPromote({ ...opts, ...change }));
    assert.deepEqual(calls, []);
  }
});

test('dry run neither registers nor writes', async () => {
  const { calls, opts } = setup();
  const result = await runPromote({ ...opts, write: false });
  assert.equal(result.posture, 'preview');
  assert.deepEqual(calls, []);
});

test('registration failure stops before Corpus; an uncertain proposal failure is surfaced without retry', async () => {
  const first = setup();
  first.opts.registerRoot = async () => { throw new Error('registration refused'); };
  await assert.rejects(runPromote(first.opts), /registration refused/);
  assert.deepEqual(first.calls, []);
  const second = setup();
  second.opts.candidates = [...candidates, ...candidates];
  let attempts = 0;
  const attemptedKeys = [];
  second.opts.store.proposeCreate = async (_candidate, _proposer, _evidence, options) => { attemptedKeys.push(options.requestKey); if (++attempts === 1) return 'first'; throw Object.assign(new Error('lost response'), { code: 'ETIMEDOUT' }); };
  await assert.rejects(runPromote(second.opts), (error) => {
    assert.match(error.message, /unconfirmed/);
    assert.equal(error.code, undefined);
    assert.equal(error.cause.code, 'ETIMEDOUT');
    assert.deepEqual(error.completedProposals, ['first']);
    assert.equal(error.failedCandidateIndex, 1);
    assert.equal(error.requestKey, attemptedKeys[1]);
    assert.notEqual(error.requestKey, attemptedKeys[0]);
    return true;
  });
  assert.equal(attempts, 2);
  const third = setup();
  third.opts.store.proposeCreate = async () => { throw Object.assign(new Error('conflict'), { code: 'REQUEST_KEY_CONFLICT' }); };
  await assert.rejects(runPromote(third.opts), (error) => error.code === 'REQUEST_KEY_CONFLICT' && error.failedCandidateIndex === 0 && /^knowledge\.promote:[a-f0-9]{64}$/.test(error.requestKey));
  const fourth = setup();
  fourth.opts.store.proposeCreate = async () => { throw Object.assign(new Error('invalid'), { code: 'MISSING_EVIDENCE' }); };
  await assert.rejects(runPromote(fourth.opts), (error) => error.code === 'MISSING_EVIDENCE' && /refused/.test(error.message));
});


test('empty candidates are a no-op without registration', async () => {
  const { calls, opts } = setup();
  const result = await runPromote({ ...opts, candidates: [] });
  assert.deepEqual(result, { root: 'memory', posture: 'noop', proposals: [] });
  assert.deepEqual(calls, []);
  const preview = await runPromote({ ...opts, candidates: [], write: false });
  assert.equal(preview.posture, 'preview');
  assert.deepEqual(calls, []);
});

test('unknown targets and store output directories are refused before effects', async () => {
  const { calls, opts } = setup();
  const fixture = fileURLToPath(new URL('./fixtures/', import.meta.url));
  await assert.rejects(runPromote({ target: 'unexpected', sessionDir: path.join(fixture, 'session'), repoRoot: path.join(fixture, 'repo'), write: false }), /unknown promote target/);
  for (const target of ['', null, 0, false]) {
    await assert.rejects(runPromote({ target, sessionDir: path.join(fixture, 'session'), repoRoot: path.join(fixture, 'repo'), write: false }), /unknown promote target/);
  }
  for (const outDir of ['/somewhere', '']) {
    await assert.rejects(runPromote({ ...opts, outDir }), /outDir.*store target/);
  }
  for (const key of ['sessionDir', 'repoRoot', 'provenance', 'decided', 'agent']) {
    await assert.rejects(runPromote({ ...opts, [key]: 'ignored' }), /not valid for the store target/);
  }
  await assert.rejects(runPromote({ ...opts, wirte: false }), /wirte.*store target/);
  await assert.rejects(runPromote({ ...opts, rootName: undefined }), /rootName/);
  await assert.rejects(runPromote({ target: 'repo-docs', sessionDir: path.join(fixture, 'session'), repoRoot: path.join(fixture, 'repo'), root: '/unexpected', write: false }), /root.*store target/);
  assert.deepEqual(calls, []);
});


test('explicit repo-docs matches the default result and output bytes', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wi2-parity-'));
  const fixture = fileURLToPath(new URL('./fixtures/', import.meta.url));
  const sessionDir = path.join(base, 'session');
  fs.cpSync(path.join(fixture, 'session'), sessionDir, { recursive: true });
  const repoRoot = path.join(fixture, 'repo');
  const outDir = path.join(sessionDir, 'proposals');
  const RealDate = globalThis.Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : ['2026-07-20T00:00:00.000Z'])); }
    static now() { return new RealDate('2026-07-20T00:00:00.000Z').getTime(); }
  };
  try {
    const opts = { sessionDir, repoRoot, decided: '2026-07-20' };
    const omitted = await runPromote(opts);
    const bytes = snapshotDir(outDir);
    fs.rmSync(outDir, { recursive: true });
    const explicit = await runPromote({ ...opts, target: 'repo-docs' });
    assert.deepEqual(explicit, omitted);
    assert.deepEqual(snapshotDir(outDir), bytes);
  } finally {
    globalThis.Date = RealDate;
    fs.rmSync(base, { recursive: true, force: true });
  }
});


test('runtime producer output passes the merged residue contract and reaches the store target', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wi2-runtime-producer-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const transcriptRoot = path.join(base, 'sessions');
  fs.mkdirSync(transcriptRoot);
  const transcript = path.join(transcriptRoot, 'rollout.jsonl');
  fs.copyFileSync(fileURLToPath(new URL('./fixtures/runtime/codex-rollout.jsonl', import.meta.url)), transcript);
  const event = {
    schema_version: '0.3.0', timestamp: '1793455200000', session_id: 'telemetry-session', event_id: 'event', event_type: 'stop',
    agent: { name: 'dev', runtime: 'codex', version: 'fixture' },
    install_identity: { package_version: 'fixture', content_fingerprint: 'fixture', source: 'fixture' },
    hook: { event_name: 'Stop', runtime_session_id: 'runtime-session', turn_id: '', transcript_path: transcript, model: '', source: '', stop_hook_active: false, last_assistant_message: '', raw_input: null },
  };
  const telemetryFile = path.join(base, 'telemetry.jsonl');
  fs.writeFileSync(telemetryFile, `${JSON.stringify(event)}\n`);
  const ingested = ingestFromSource('runtime-session', { telemetryFile, transcriptRoots: [transcriptRoot], now: Date.parse('2026-11-01T00:00:00.000Z') });
  assert.ok(ingested.residues.length > 0, 'producer must yield a sitting');
  const sitting = ingested.residues[0];
  const { calls, opts } = setup();
  await runPromote({ ...opts, residue: sitting });
  assert.deepEqual(JSON.parse(calls[1][1].provenance.note), { session_id: sitting.provenance.sessionId, transcript_ref: sitting.provenance.transcriptRef, sitting_id: sitting.sittingId, content_hash: sitting.contentHash });
});


test('request keys separate sittings and positions but exclude candidate content', async () => {
  const { calls, opts } = setup();
  await runPromote({ ...opts, candidates: [candidates[0], { ...candidates[0], title: 'Another' }] });
  const initial = calls.filter((call) => call[0] === 'propose').map((call) => call[4].requestKey);
  assert.notEqual(initial[0], initial[1], 'positions must use different keys');
  calls.length = 0;
  await runPromote({ ...opts, candidates: [{ ...candidates[0], body: 'Changed' }] });
  assert.equal(calls[1][4].requestKey, initial[0], 'changed content must conflict at the same key');
  calls.length = 0;
  await runPromote({ ...opts, proposerId: 'another-proposer' });
  assert.equal(calls[1][4].requestKey, initial[0], 'changed proposer must use the same key');
  calls.length = 0;
  await runPromote({ ...opts, residue: { ...residue, provenance: { ...residue.provenance, transcriptRef: 'other.jsonl' } } });
  assert.equal(calls[1][4].requestKey, initial[0], 'changed transcript must use the same key');
  calls.length = 0;
  const anotherSitting = { ...residue, sittingId: residue.sittingId.replace(/:0$/, ':1') };
  await runPromote({ ...opts, residue: anotherSitting });
  assert.notEqual(calls[1][4].requestKey, initial[0], 'different sittings must use different keys');
});
