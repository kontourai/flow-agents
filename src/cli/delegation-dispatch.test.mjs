import assert from 'node:assert/strict';
import test from 'node:test';
import { rm } from 'node:fs/promises';
import { FileAuthorizationLedger, AuthorizationPersistenceError } from '@kontourai/dispatch';
import { dispatchDelegation } from '../../build/src/delegation-dispatch.js';
import { makeFixtureDirAsync } from './fixture-temp-dir.mjs';

for (const usage of [{}, { inputTokens: 2, outputTokens: 3, costUsd: 0.002 }]) {
  test(`durable dispatch retains output and ${usage.costUsd === undefined ? 'holds unknown usage' : 'settles reported usage'} across reopen`, async () => {
    const root = await makeFixtureDirAsync('delegation-dispatch-');
    try {
      let calls = 0;
      const retained = [];
      const runtime = { id: 'worker', capabilities: () => ({ structuredTools: false, streaming: false, abort: true, usage: true }),
        async invoke() { calls++; return { provider: 'fixture', model: 'fixture', outputText: 'raw report', toolCalls: [], usage, latencyMs: 1 }; } };
      const plan = { schemaVersion: 1, role: 'reader', request: { messages: [{ role: 'user', content: 'read' }] },
        candidates: [{ id: 'worker', runtimeId: 'worker', worstCaseUsage: { maxTokens: 10, maxCostUsd: 0.01 } }],
        budget: { maxAttempts: 1 }, authorization: { schemaVersion: 1, id: 'family', invocationId: 'one', limits: { maxAttempts: 2, maxTotalTokens: 15, maxCostUsd: 0.05 } } };
      const run = (invocationId) => dispatchDelegation({ plan: { ...plan, authorization: { ...plan.authorization, invocationId } },
        ledger: new FileAuthorizationLedger({ root }), runtimes: new Map([['worker', runtime]]), retainResult: async (result) => { retained.push(result.outputText); } });
      if (usage.costUsd === undefined) {
        await assert.rejects(run('one'), AuthorizationPersistenceError);
        assert.equal((await run('two')).receipt.outcome, 'budget-exceeded');
        assert.equal(calls, 1);
      } else {
        assert.equal((await run('one')).receipt.outcome, 'succeeded');
        assert.equal((await run('two')).receipt.outcome, 'succeeded');
        assert.equal(calls, 2);
      }
      assert.deepEqual(retained, Array(calls).fill('raw report'));
      await assert.rejects(run('one'), AuthorizationPersistenceError);
      assert.equal(calls, usage.costUsd === undefined ? 1 : 2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('failed durable result retention stops fallback and replay after a physical invocation', async () => {
  const root = await makeFixtureDirAsync('delegation-retention-');
  try {
    let calls = 0;
    const runtime = { id: 'worker', capabilities: () => ({ structuredTools: false, streaming: false, abort: true, usage: true }),
      async invoke() { calls++; return { provider: 'fixture', model: 'fixture', outputText: 'report', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 }, latencyMs: 1 }; } };
    const plan = { schemaVersion: 1, role: 'reader', request: { messages: [{ role: 'user', content: 'read' }] },
      candidates: ['first', 'fallback'].map((id) => ({ id, runtimeId: 'worker', worstCaseUsage: { maxTokens: 10, maxCostUsd: 0.01 } })),
      policy: { retryRuntimeFailures: true }, budget: { maxAttempts: 2 },
      authorization: { schemaVersion: 1, id: 'family', invocationId: 'one', limits: { maxAttempts: 2, maxTotalTokens: 20, maxCostUsd: 0.05 } } };
    const run = () => dispatchDelegation({ plan, ledger: new FileAuthorizationLedger({ root }), runtimes: new Map([['worker', runtime]]),
      retainResult: async () => { throw new Error('storage unavailable'); } });
    await assert.rejects(run(), AuthorizationPersistenceError);
    assert.equal(calls, 1);
    await assert.rejects(run(), AuthorizationPersistenceError);
    assert.equal(calls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
