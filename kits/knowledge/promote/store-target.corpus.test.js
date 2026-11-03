import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { KitDefaultStoreAdapter, standaloneFileMutationLock } from '@kontourai/corpus-store';
import { runPromote } from './index.js';
import { snapshotDir } from './lib.js';

test('Corpus stages an unreviewed proposal without a working-set record', async (t) => {
  const residue = JSON.parse(fs.readFileSync(new URL('./fixtures/runtime-residue-669.json', import.meta.url), 'utf8'));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wi2-corpus-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'memory');
  const store = new KitDefaultStoreAdapter({ storeRoot: root, coordinationDirectory: path.join(base, 'coordination'), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock });
  const roots = new Map();
  const result = await runPromote({ target: 'store', residue, candidates: [{ title: 'Learning', body: 'Distilled fixture', category: 'memory.learning' }], proposerId: 'distiller', root, rootName: 'memory', store, registerRoot: async (name, value) => roots.set(name, value) });
  const proposal = await store.getProposal(result.proposals[0]);
  assert.equal(proposal.state, 'pending');
  assert.equal(roots.get('memory'), root);
  assert.equal((await store.listProposals({ state: 'pending' })).length, 1);
  assert.equal((await store.listByType('raw')).length, 0);
  assert.deepEqual(JSON.parse(proposal.candidate.provenance.note), { session_id: residue.provenance.sessionId, transcript_ref: residue.provenance.transcriptRef, sitting_id: residue.sittingId, content_hash: residue.contentHash });
  await assert.rejects(store.applyCreate(proposal.id, 'distiller'), (error) => error.code === 'SELF_APPROVAL');
  assert.equal((await store.getProposal(proposal.id)).state, 'pending');
  const recordId = await store.applyCreate(proposal.id, 'independent-reviewer');
  const record = await store.get(recordId);
  assert.equal(record.body, 'Distilled fixture');
  assert.equal(record.provenance.note, proposal.candidate.provenance.note);
  const rejectedId = await store.proposeCreate(proposal.candidate, 'distiller', proposal.evidence);
  await store.rejectCreate(rejectedId, 'independent-reviewer', 'Not needed');
  assert.equal((await store.getProposal(rejectedId)).state, 'rejected');
  assert.equal((await store.listByType('raw')).length, 1);
});

test('identical batch retries reuse receipts and changed content conflicts', async (t) => {
  const residue = JSON.parse(fs.readFileSync(new URL('./fixtures/runtime-residue-669.json', import.meta.url), 'utf8'));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wi2-retry-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'memory');
  const store = new KitDefaultStoreAdapter({ storeRoot: root, coordinationDirectory: path.join(base, 'coordination'), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock, allowPurge: true });
  const candidates = [{ title: 'First', body: 'One', category: 'memory.learning' }, { title: 'Second', body: 'Two', category: 'memory.learning' }];
  let calls = 0;
  const unreliable = { proposeCreate: async (...args) => { const id = await store.proposeCreate(...args); if (++calls === 2) throw new Error('response lost after commit'); return id; } };
  const options = { target: 'store', residue, candidates, proposerId: 'distiller', root, rootName: 'memory', store: unreliable, registerRoot: async () => {} };
  let firstId;
  await assert.rejects(runPromote(options), (error) => { firstId = error.completedProposals[0]; assert.equal(error.failedCandidateIndex, 1); return /unconfirmed/.test(error.message); });
  assert.equal((await store.listProposals({ state: 'pending' })).length, 2);
  const retried = await runPromote({ ...options, store });
  assert.equal(retried.proposals[0], firstId);
  assert.equal(new Set(retried.proposals).size, 2);
  assert.equal((await store.listProposals({ state: 'pending' })).length, 2);
  assert.deepEqual((await runPromote({ ...options, store })).proposals, retried.proposals);
  await store.rejectCreate(retried.proposals[0], 'independent-reviewer', 'Not needed');
  const settledReplay = await runPromote({ ...options, store });
  assert.equal(settledReplay.review_state, 'not_observed');
  assert.equal((await store.getProposal(settledReplay.proposals[0])).state, 'rejected');
  await assert.rejects(runPromote({ ...options, store, candidates: [{ ...candidates[0], body: 'Changed' }, candidates[1]] }), (error) => error.code === 'REQUEST_KEY_CONFLICT');
  await assert.rejects(runPromote({ ...options, store, proposerId: 'another-proposer' }), (error) => error.code === 'REQUEST_KEY_CONFLICT');
  await assert.rejects(runPromote({ ...options, store, candidates: [candidates[0], { ...candidates[1], category: 'Invalid Category!' }] }), (error) => error.code === 'MISSING_EVIDENCE' && error.failedCandidateIndex === 1 && error.completedProposals[0] === retried.proposals[0]);
  await assert.rejects(runPromote({ ...options, store, residue: { ...residue, provenance: { ...residue.provenance, transcriptRef: 'another-transcript.jsonl' } } }), (error) => error.code === 'REQUEST_KEY_CONFLICT');
  assert.equal((await store.listProposals({ state: 'pending' })).length, 1);
  assert.equal((await store.listByType('raw')).length, 0);
  const created = await store.applyCreate(retried.proposals[1], 'independent-reviewer');
  await store.purge([created], { agent: 'independent-reviewer', rationale: 'erase' });
  await assert.rejects(runPromote({ ...options, store }), (error) => error.code === 'REQUEST_KEY_CONFLICT' && error.failedCandidateIndex === 1);
  assert.equal((await store.listByType('raw')).length, 0);
});

test('the host registry exposes the authorized root through the real MCP server', { skip: !process.env.KNOWLEDGE_HOST_ROOT }, async (t) => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const host = process.env.KNOWLEDGE_HOST_ROOT;
  const { scaffoldStore, registerRoot } = await import(pathToFileURL(path.join(host, 'scripts/lib/store-resolve.mjs')).href);
  const residue = JSON.parse(fs.readFileSync(new URL('./fixtures/runtime-residue-669.json', import.meta.url), 'utf8'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wi2-mcp-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const env = { ...process.env, HOME: tmp, XDG_DATA_HOME: path.join(tmp, 'xdg') };
  const root = scaffoldStore(path.join(env.XDG_DATA_HOME, 'knowledge-store'));
  const curated = scaffoldStore(path.join(tmp, 'curated'));
  const sentinel = path.join(curated, 'records', 'sentinel.txt');
  fs.writeFileSync(sentinel, 'curated unchanged');
  registerRoot('curated', curated, env);
  const curatedBefore = snapshotDir(curated);
  const store = new KitDefaultStoreAdapter({ storeRoot: root, coordinationDirectory: path.join(tmp, 'coord'), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock });
  await runPromote({ target: 'store', residue, candidates: [{ title: 'Memory', body: 'Fixture', category: 'memory.learning' }], root, rootName: 'memory', store, proposerId: 'fixture-agent', registerRoot: (name, value) => registerRoot(name, value, env) });
  const child = spawn(process.execPath, [path.join(host, 'scripts/knowledge-mcp/index.mjs')], { cwd: tmp, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    const message = await new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error(`MCP response timeout: ${stderr}`)), 30000);
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`MCP exited ${code}: ${stderr}`)));
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          const response = JSON.parse(line);
          if (response.id === 1) { clearTimeout(timer); resolve(response); }
        }
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'knowledge_roots', arguments: {} } })}\n`);
    });
    const roots = JSON.parse(message.result.content[0].text).roots;
    assert.equal(roots.find((entry) => entry.name === 'memory')?.path, root);
    assert.equal(roots.find((entry) => entry.name === 'memory')?.exists, true);
    assert.equal(roots.find((entry) => entry.name === 'curated')?.path, curated);
    assert.deepEqual(snapshotDir(curated), curatedBefore);
  } finally {
    child.stdin.end();
    await exited;
  }
});
