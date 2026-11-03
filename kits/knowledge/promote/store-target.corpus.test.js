import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runPromote } from './index.js';
import { snapshotDir } from './lib.js';

// Set CORPUS_STORE_ENTRY to the installed packed-branch entry until npm publish.
test('Corpus stages an unreviewed proposal without a working-set record', { skip: !process.env.CORPUS_STORE_ENTRY }, async (t) => {
  const { KitDefaultStoreAdapter, standaloneFileMutationLock } = await import(pathToFileURL(process.env.CORPUS_STORE_ENTRY).href);
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
  assert.deepEqual(JSON.parse(proposal.candidate.provenance.note), { session_id: residue.provenance.sessionId, transcript_ref: residue.provenance.transcriptRef, sitting_id: residue.sittingId });
  await assert.rejects(store.applyCreate(proposal.id, 'distiller'), (error) => error.code === 'SELF_APPROVAL');
  assert.equal((await store.getProposal(proposal.id)).state, 'pending');
  const recordId = await store.applyCreate(proposal.id, 'independent-reviewer');
  const record = await store.get(recordId);
  assert.equal(record.body, 'Distilled fixture');
  assert.equal(record.provenance.note, proposal.candidate.provenance.note);
});

test('the host registry exposes the authorized root through the real MCP server', { skip: !process.env.CORPUS_STORE_ENTRY || !process.env.KNOWLEDGE_HOST_ROOT }, async (t) => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const host = process.env.KNOWLEDGE_HOST_ROOT;
  const { scaffoldStore, registerRoot } = await import(pathToFileURL(path.join(host, 'scripts/lib/store-resolve.mjs')).href);
  const { KitDefaultStoreAdapter, standaloneFileMutationLock } = await import(pathToFileURL(process.env.CORPUS_STORE_ENTRY).href);
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
