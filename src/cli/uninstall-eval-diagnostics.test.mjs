import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// Exercise the real eval's exit/ERR traps without running its expensive installs.
const source = fs.readFileSync(new URL('../../evals/integration/test_init_uninstall.sh', import.meta.url), 'utf8');
const prelude = source.slice(source.indexOf('set -Eeuo pipefail'), source.indexOf('_pass()'));
for (const scenario of ['success', 'setup-failure', 'assertion-failure']) {
  test(`uninstall eval diagnostics: ${scenario}`, () => {
    const receipt = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-diagnostic-test-'));
    let fixture;
    try {
      const command = scenario === 'setup-failure'
        ? `bash -c 'echo controlled-setup-failure >&2; exit 37' >"$TMPDIR_EVAL/setup-$LINENO.out" 2>&1`
        : scenario === 'assertion-failure' ? 'fail=1; exit 1' : 'exit 0';
      const result = spawnSync('bash', ['-c', `${prelude}\nprintf '%s' "$TMPDIR_EVAL" > "$1/fixture"\n${command}`, 'diagnostic-probe', receipt], { encoding: 'utf8' });
      fixture = fs.readFileSync(path.join(receipt, 'fixture'), 'utf8');
      assert.equal(result.status, scenario === 'success' ? 0 : scenario === 'setup-failure' ? 37 : 1);
      assert.equal(fs.existsSync(fixture), scenario !== 'success');
      if (scenario !== 'success') assert.match(result.stderr, /Uninstall fixture diagnostics retained:/);
      if (scenario === 'setup-failure') {
        assert.match(result.stderr, /line=\d+ exit=37 command=bash/);
        const logs = fs.readdirSync(fixture).filter(name => /^setup-\d+\.out$/.test(name));
        assert.equal(logs.length, 1);
        assert.equal(fs.readFileSync(path.join(fixture, logs[0]), 'utf8'), 'controlled-setup-failure\n');
      }
    } finally {
      if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
      fs.rmSync(receipt, { recursive: true, force: true });
    }
  });
}
