import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { discoverDeliveryBundle } from '../../scripts/ci/discover-delivery-bundle.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flow-agents-bundle-discovery-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  writeFileSync(join(root, 'README.md'), 'base\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  return { root, baseSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() };
}

function addBundle(root, slug) {
  const directory = join(root, 'delivery', slug);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'trust.bundle'), `${slug}\n`);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', slug], { cwd: root });
}

test('prefers an existing explicit legacy bundle', () => {
  const { root, baseSha } = fixture();
  mkdirSync(join(root, 'delivery'), { recursive: true });
  writeFileSync(join(root, 'delivery', 'trust.bundle'), 'legacy\n');
  assert.equal(discoverDeliveryBundle({ repoRoot: root, baseSha }), 'delivery/trust.bundle');
});

test('discovers the changed canonical per-session bundle for a pull request', () => {
  const { root, baseSha } = fixture();
  addBundle(root, 'github-kontourai-surface-172');
  assert.equal(
    discoverDeliveryBundle({ repoRoot: root, baseSha }),
    'delivery/github-kontourai-surface-172/trust.bundle',
  );
});

test('fails closed when a change introduces multiple per-session bundles', () => {
  const { root, baseSha } = fixture();
  addBundle(root, 'task-one');
  addBundle(root, 'task-two');
  assert.throws(
    () => discoverDeliveryBundle({ repoRoot: root, baseSha }),
    /multiple changed per-session trust bundles found/,
  );
});

test('does not guess among historical bundles without a pull-request base', () => {
  const { root } = fixture();
  addBundle(root, 'task-one');
  assert.equal(discoverDeliveryBundle({ repoRoot: root }), '');
});
