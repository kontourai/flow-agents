import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalKitsRoot } from '../../build/src/lib/kit-flow-binding.js';
import { flowAdmissionRefusal } from '../../build/src/lib/flow-admission.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function run(args, cwd, env) {
  const result = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 120000 });
  assert.ifError(result.error);
  return result;
}

for (const runtime of ['claude-code', 'opencode', 'kiro']) {
  test(`${runtime} real global install discovers package flows and hook gates`, () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vendored-kit-'));
    try {
      const home = path.join(scratch, 'home');
      const ws = path.join(scratch, 'ws');
      fs.mkdirSync(home); fs.mkdirSync(ws);
      const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') };
      for (const key of ['FLOW_AGENTS_FLOW_DEFS_DIR', 'FLOW_AGENTS_USER_CLAUDE_SETTINGS', 'FLOW_AGENTS_USER_OPENCODE_CONFIG']) delete env[key];
      const installed = run([path.join(root, 'build/src/cli.js'), 'init', '--runtime', runtime, '--global', '--activate-kit', 'builder', '--yes'], ws, env);
      assert.equal(installed.status, 0, installed.stdout + installed.stderr);
      const packageRoot = runtime === 'kiro' ? path.join(home, '.flow-agents')
        : runtime === 'claude-code' ? path.join(home, '.claude/.flow-agents/runtime')
        : path.join(home, '.config/opencode/.flow-agents/runtime');
      const started = run([path.join(packageRoot, 'build/src/cli.js'), 'workflow', 'start', '--flow', 'builder.build'], ws, env);
      // Exercise the actual installed hook's exported lookup, with a real active pointer.
      const artifactRoot = path.join(ws, '.kontourai/flow-agents');
      fs.mkdirSync(artifactRoot, { recursive: true });
      fs.writeFileSync(path.join(artifactRoot, 'current.json'), JSON.stringify({ active_flow_id: 'builder.build', active_step_id: 'verify' }));
      const lookup = run(['-e', `const hook = require(${JSON.stringify(path.join(packageRoot, 'scripts/hooks/stop-goal-fit.js'))}); const step = hook.loadActiveFlowStep(${JSON.stringify(artifactRoot)}); console.log(JSON.stringify(step));`], ws, env);
      console.log(`${runtime} installed hook lookup: ${lookup.stdout.trim() === "null" ? "null" : "Builder verify gate"}`);
      assert.doesNotMatch(started.stderr, /declared flows: <none>/);
      assert.match(started.stderr, /--work-item|--effective-state-json/, started.stdout + started.stderr);
      assert.notEqual(started.status, 0, 'missing work item must still refuse');
      assert.equal(lookup.status, 0, lookup.stderr);
      const step = JSON.parse(lookup.stdout);
      assert.equal(step?.flowId, 'builder.build', lookup.stdout);
      assert.equal(step.gateId, 'verify-gate');
      assert.ok(step.gateExpects.some(e => e.bundle_claim?.claimType?.startsWith('builder.')));
      if (runtime === 'claude-code') {
        const sibling = path.join(path.dirname(packageRoot), 'agent-kits');
        fs.renameSync(path.join(packageRoot, 'kits'), sibling);
        fs.symlinkSync(sibling, path.join(packageRoot, 'kits'));
        const redirected = run(['--input-type=module', '-e', `import { canonicalKitsRoot } from ${JSON.stringify(path.join(packageRoot, 'build/src/lib/kit-flow-binding.js'))}; console.log(canonicalKitsRoot(${JSON.stringify(packageRoot)}));`], ws, env);
        assert.equal(redirected.status, 0, redirected.stderr);
        assert.equal(redirected.stdout.trim(), 'null', 'redirecting the executing kits root cannot exempt a sibling');
      }

    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  });
}

test('agent artifact kits cannot impersonate the executing package', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-kit-'));
  try {
    const fake = path.join(scratch, '.flow-agents/runtime');
    fs.mkdirSync(fake, { recursive: true });
    fs.cpSync(path.join(root, 'kits/builder'), path.join(fake, 'kits/builder'), { recursive: true });
    fs.writeFileSync(path.join(fake, 'package.json'), '{"name":"@kontourai/flow-agents"}');
    assert.equal(canonicalKitsRoot(fake), null, 'copied metadata is not executing-module identity');
    const refusal = flowAdmissionRefusal('agent.missing', fake, 'workflow start --flow');
    assert.ok(refusal.includes(fake), refusal);
    assert.match(refusal, /skipped kit sources:.*runtime artifact storage/);
    const alias = path.join(scratch, 'alias');
    fs.mkdirSync(alias);
    fs.symlinkSync(path.join(fake, 'kits'), path.join(alias, 'kits'));
    assert.equal(canonicalKitsRoot(alias), null, 'symlink cannot launder an artifact kit');
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});
