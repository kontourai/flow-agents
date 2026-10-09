import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareCheckWorkspace } from '../scripts/commands.mjs';
import { digest } from '../scripts/compile.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-check-isolation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'source'), controllerRoot = path.join(root, 'controller');
  fs.mkdirSync(workspace); fs.mkdirSync(controllerRoot);
  fs.writeFileSync(path.join(workspace, 'app.js'), 'canonical application');
  fs.writeFileSync(path.join(workspace, 'run.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const artifact = '.aidlc/artifacts/code-generation/unit-test-instructions.md';
  fs.mkdirSync(path.dirname(path.join(workspace, artifact)), { recursive: true });
  fs.writeFileSync(path.join(workspace, artifact), 'approved tests');
  return { workspace, controllerRoot, artifact, basis: [{ path: artifact, sha256: digest('approved tests') }] };
}
test('an actual check subprocess can rewrite only its private source/artifact fork', (t) => {
  const f = fixture(t), check = prepareCheckWorkspace(f);
  t.after(check.close);
  const observed = spawnSync(process.execPath, ['-e', 'const fs=require("node:fs");fs.writeFileSync("app.js","test rewrite");fs.writeFileSync(process.argv[1],"test rewrite");fs.writeFileSync("new.js","test output");', f.artifact], { cwd: check.workspace, encoding: 'utf8', timeout: 10000 });
  assert.equal(observed.status, 0, observed.stderr);
  assert.equal(fs.readFileSync(path.join(check.workspace, 'app.js'), 'utf8'), 'test rewrite');
  assert.equal(fs.readFileSync(path.join(f.workspace, 'app.js'), 'utf8'), 'canonical application');
  assert.equal(fs.readFileSync(path.join(f.workspace, f.artifact), 'utf8'), 'approved tests');
  assert.equal(fs.existsSync(path.join(f.workspace, 'new.js')), false);
  assert.doesNotThrow(check.assertCurrent);
  assert.equal(fs.statSync(path.join(check.workspace, 'run.sh')).mode & 0o111, 0o111);
});
test('canonical source changes during a check invalidate otherwise successful output', (t) => {
  const f = fixture(t), check = prepareCheckWorkspace(f);
  t.after(check.close);
  fs.writeFileSync(path.join(f.workspace, 'app.js'), 'external concurrent edit');
  assert.throws(check.assertCurrent, /basis changed/);
});
test('canonical artifact mutation and a stale supplied instruction digest cannot verify', (t) => {
  const f = fixture(t), check = prepareCheckWorkspace(f);
  t.after(check.close);
  fs.writeFileSync(path.join(f.workspace, f.artifact), 'unapproved tests');
  assert.throws(check.assertCurrent, /Stale command basis|basis changed/);
  assert.throws(() => prepareCheckWorkspace(f), /Stale command basis/);
});
test('a check fork excludes controller evidence and rejects artifact symlink escape', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.controllerRoot, 'private-grader.json'), 'private fixture marker');
  const check = prepareCheckWorkspace(f); t.after(check.close);
  assert.equal(fs.existsSync(path.join(check.workspace, 'private-grader.json')), false);
  fs.symlinkSync(path.join(f.controllerRoot, 'private-grader.json'), path.join(f.workspace, '.aidlc/artifacts/leak.md'));
  assert.throws(() => prepareCheckWorkspace(f), /symlinks/);
});
