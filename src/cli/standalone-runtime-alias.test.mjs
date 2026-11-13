import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { matchesDeclaredRuntimePackage } from '../../build/src/tools/build-universal-bundles.js';

test('runtime aliases require the exact declared published name and version', () => {
  const actual = { name: '@kontourai/surface', version: '6.3.0' };
  assert.equal(matchesDeclaredRuntimePackage('@kontourai/surface-knowledge', 'npm:@kontourai/surface@6.3.0', actual), true);
  for (const declared of ['npm:@kontourai/surface@^6.3.0', 'npm:@kontourai/other@6.3.0', 'npm:@kontourai/surface', '6.3.0', undefined]) {
    assert.equal(matchesDeclaredRuntimePackage('@kontourai/surface-knowledge', declared, actual), false, String(declared));
  }
  assert.equal(matchesDeclaredRuntimePackage('@kontourai/surface', '6.3.0', actual), true);
  assert.equal(matchesDeclaredRuntimePackage('@kontourai/surface-knowledge', 'npm:@kontourai/surface@6.3.0', { ...actual, name: '@kontourai/other' }), false);
  assert.equal(matchesDeclaredRuntimePackage('@kontourai/surface-knowledge', 'npm:@kontourai/surface@6.3.0', { ...actual, version: '6.3.1' }), false);
});

test('standalone memory runtime loads its bundled Surface alias without node_modules', () => {
  const root = mkdtempSync(join(tmpdir(), 'flow-runtime-alias-'));
  try {
    for (const runtime of ['codex', 'claude-code']) {
      cpSync(resolve(`dist/${runtime}/build`), join(root, 'build'), { recursive: true });
      const metadata = JSON.parse(readFileSync(join(root, 'build/src/vendor/surface-knowledge/surface-knowledge.runtime.bundle.json'), 'utf8'));
      assert.equal(metadata.entry_package, '@kontourai/surface');
      assert.equal(metadata.entry_specifier, '@kontourai/surface-knowledge');
      assert.equal(metadata.entry_version, '6.3.0');
      const relay = JSON.parse(readFileSync(join(root, 'build/src/vendor/relay-anthropic/relay-anthropic.runtime.bundle.json'), 'utf8'));
      assert.equal(relay.entry_package, '@kontourai/relay');
      assert.equal(relay.entry_specifier, '@kontourai/relay/anthropic');
      const program = `import { memoryVisibilityWithin } from './build/src/memory-routing.js';
        if (!memoryVisibilityWithin({kind:'public'}, {kind:'public'})) process.exit(2);`;
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['NODE_OPTIONS', 'NODE_PATH'].includes(key)));
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], { cwd: root, env, encoding: 'utf8', timeout: 20_000 });
      assert.equal(result.status, 0, `${runtime}: ${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
      rmSync(join(root, 'build'), { recursive: true, force: true });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
