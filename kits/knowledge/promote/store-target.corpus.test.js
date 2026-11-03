import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runPromote } from './index.js';

// Set CORPUS_STORE_ENTRY to the installed packed-branch entry until npm publish.
test('Corpus stages an unreviewed proposal without a working-set record', { skip: !process.env.CORPUS_STORE_ENTRY }, async (t) => {
  const { KitDefaultStoreAdapter, standaloneFileMutationLock } = await import(pathToFileURL(process.env.CORPUS_STORE_ENTRY).href);
  const residue = JSON.parse(fs.readFileSync(new URL('./fixtures/runtime-residue-669.json', import.meta.url), 'utf8'));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wi2-corpus-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'memory');
  const store = new KitDefaultStoreAdapter({ storeRoot: root, coordinationDirectory: path.join(base, 'coordination'), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock });
  const roots = new Map();
  const result = await runPromote({ target: 'store', residue, candidates: [{ title: 'Learning', body: 'Distilled fixture', category: 'memory.learning' }], proposerId: 'distiller', root, store, registerRoot: async (name, value) => roots.set(name, value) });
  const proposal = await store.getProposal(result.proposals[0]);
  assert.equal(proposal.state, 'pending');
  assert.equal(roots.get('memory'), root);
  assert.equal((await store.listProposals({ state: 'pending' })).length, 1);
  assert.equal((await store.listByType('raw')).length, 0);
  assert.deepEqual(JSON.parse(proposal.candidate.provenance.note), { session_id: residue.provenance.sessionId, transcript_ref: residue.provenance.transcriptRef, sitting_id: residue.sittingId });
  await assert.rejects(store.apply(proposal.id, 'distiller'), (error) => error.code === 'SELF_APPROVAL');
  assert.equal((await store.getProposal(proposal.id)).state, 'pending');
  const recordId = await store.apply(proposal.id, 'independent-reviewer');
  assert.equal((await store.get(recordId)).body, 'Distilled fixture');
});
