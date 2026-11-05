import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { retirementPlan } from './retirement-plan.js';

const command = fileURLToPath(new URL('./retirement-plan.js', import.meta.url));
test('plan and help print without creating files or executing retirement', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'instinct-plan-')); t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  for (const args of [[], ['--help']]) {
    const result = spawnSync(process.execPath, [command, ...args], { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0); assert.match(result.stdout, /makes no changes/); assert.deepEqual(fs.readdirSync(cwd), []);
  }
  assert.equal(retirementPlan.executed, false); assert.equal(retirementPlan.status, 'not-ready');
  assert.match(retirementPlan.steps.join(' '), /stop the new dream path/);
  assert.equal(spawnSync(process.execPath, [command, '--apply'], { cwd }).status, 2);
});
