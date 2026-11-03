import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotDir } from './lib.js';
import { runPromote } from './index.js';

// Produced by #669 ingestRuntimeSessions from its Codex rollout fixture.
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
  assert.deepEqual(result, { root: 'memory', posture: 'proposed', proposals: ['proposal-1'] });
  assert.deepEqual(calls[0], ['register', 'memory', '/authorized/memory']);
  assert.equal(calls.length, 2);
  const [, candidate, proposer, evidence] = calls[1];
  assert.deepEqual(candidate, { type: 'raw', ...candidates[0], provenance: { agent: 'distiller', session_id: residue.provenance.sessionId, note: JSON.stringify({ session_id: residue.provenance.sessionId, transcript_ref: residue.provenance.transcriptRef, sitting_id: residue.sittingId }) } });
  assert.equal(proposer, 'distiller');
  assert.equal(evidence.agent, 'distiller');
});

test('missing provenance, incomplete sittings and invalid candidates fail before registration or writes', async () => {
  for (const change of [
    { residue: { ...residue, sittingId: '' } },
    { residue: { ...residue, provenance: { ...residue.provenance, sessionId: '' } } },
    { residue: { ...residue, provenance: { ...residue.provenance, transcriptRef: '' } } },
    { residue: { ...residue, complete: false } },
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
  second.opts.store.proposeCreate = async () => { if (++attempts === 1) return 'first'; throw new Error('lost response'); };
  await assert.rejects(runPromote(second.opts), (error) => {
    assert.match(error.message, /unconfirmed/);
    assert.deepEqual(error.completedProposals, ['first']);
    assert.equal(error.failedCandidateIndex, 1);
    return true;
  });
  assert.equal(attempts, 2);
});


test('empty candidates are a no-op without registration', async () => {
  const { calls, opts } = setup();
  const result = await runPromote({ ...opts, candidates: [] });
  assert.deepEqual(result, { root: 'memory', posture: 'noop', proposals: [] });
  assert.deepEqual(calls, []);
});

test('unknown targets and store output directories are refused before effects', async () => {
  const { calls, opts } = setup();
  await assert.rejects(runPromote({ ...opts, target: 'unexpected' }), /unknown promote target/);
  await assert.rejects(runPromote({ ...opts, outDir: '/somewhere' }), /outDir.*repo-docs/);
  await assert.rejects(runPromote({ ...opts, rootName: undefined }), /rootName/);
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
