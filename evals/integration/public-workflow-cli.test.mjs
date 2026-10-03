import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../..');

test('the complete installed public workflow CLI journey passes', t => {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'public-workflow-cli-state-'));
  t.after(() => fs.rmSync(stateHome, { recursive: true, force: true }));
  const result = spawnSync('bash', ['evals/integration/test_public_workflow_cli.sh'], {
    cwd: root,
    env: { ...process.env, XDG_STATE_HOME: stateHome },
    encoding: 'utf8', timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  });
  assert.equal(result.status, 0, [result.error?.message, result.signal, result.stdout, result.stderr].filter(Boolean).join('\n'));
});
