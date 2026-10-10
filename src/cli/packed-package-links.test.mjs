import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertInstalledPackageLinks, assertShippedPackageLinks } from '../../evals/integration/packed-package-links.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packed-links-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const consumer = path.join(root, 'consumer'), sdk = path.join(consumer, 'node_modules/sdk'), shipped = path.join(root, 'shipped');
  const dependency = path.join(sdk, 'node_modules/tool'), bin = path.join(sdk, 'node_modules/.bin');
  for (const directory of [shipped, dependency, bin]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(dependency, 'package.json'), JSON.stringify({ name: 'tool', version: '1.0.0', bin: { tool: 'cli.mjs' } }));
  fs.writeFileSync(path.join(dependency, 'cli.mjs'), 'console.log("tool");\n');
  fs.symlinkSync('../tool/cli.mjs', path.join(bin, 'tool'));
  return { root, consumer, sdk, shipped, dependency, bin };
}

test('nested npm bin links require declared targets inside their isolated consumer', t => {
  const f = fixture(t);
  assert.deepEqual(assertInstalledPackageLinks(f.sdk, f.consumer), [{ path: 'node_modules/.bin/tool', target: fs.realpathSync(path.join(f.dependency, 'cli.mjs')), package: 'tool', version: '1.0.0' }]);
  assertShippedPackageLinks(f.shipped);
});

test('publisher-owned links refuse even when shaped like a legitimate nested npm bin', t => {
  const f = fixture(t), shippedBin = path.join(f.shipped, 'node_modules/.bin');
  fs.mkdirSync(shippedBin, { recursive: true });
  fs.symlinkSync(path.join(f.dependency, 'cli.mjs'), path.join(shippedBin, 'tool'));
  assert.throws(() => assertShippedPackageLinks(f.shipped), /shipped package contains a symlink\/workspace link/);
});

test('unexpected dependency workspace links never receive a blanket node_modules waiver', t => {
  const f = fixture(t);
  fs.symlinkSync(f.dependency, path.join(f.sdk, 'node_modules/workspace-alias'));
  assert.throws(() => assertInstalledPackageLinks(f.sdk, f.consumer), /unexpected symlink\/workspace link/);
});

test('npm bin link escaping consumer refuses even when declared by the package', t => {
  const f = fixture(t), outside = path.join(f.root, 'outside.mjs');
  fs.writeFileSync(outside, 'outside\n');
  fs.unlinkSync(path.join(f.bin, 'tool')); fs.symlinkSync(outside, path.join(f.bin, 'tool'));
  assert.throws(() => assertInstalledPackageLinks(f.sdk, f.consumer), /escapes its consumer/);
});

test('contained bin symlink with an undeclared command name refuses', t => {
  const f = fixture(t);
  fs.symlinkSync('../tool/cli.mjs', path.join(f.bin, 'undeclared'));
  assert.throws(() => assertInstalledPackageLinks(f.sdk, f.consumer), /not declared by its owning package/);
});

test('publisher-owned dependency-shaped file cannot become an admitted npm bin link after installation', t => {
  const f = fixture(t), directory = path.join(f.shipped, 'node_modules/.bin');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'tool'), 'Publisher-owned executable\n');
  assert.throws(() => assertInstalledPackageLinks(f.sdk, f.consumer, f.shipped), /publisher-owned installed path became a symlink/);
});

test('bin-shaped directory inside a package is not an npm wiring directory', t => {
  const f = fixture(t), directory = path.join(f.sdk, 'node_modules/other-package/.bin');
  fs.mkdirSync(directory, { recursive: true });
  fs.symlinkSync(path.join(f.dependency, 'cli.mjs'), path.join(directory, 'tool'));
  assert.throws(() => assertInstalledPackageLinks(f.sdk, f.consumer), /unexpected symlink\/workspace link/);
});

test('contained and declared target from another node_modules level is not this bin directory owner', t => {
  const f = fixture(t), other = path.join(f.consumer, 'node_modules/other-owner');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ name: 'other-owner', version: '1.0.0', bin: { tool: 'cli.mjs' } }));
  fs.writeFileSync(path.join(other, 'cli.mjs'), 'console.log("other");\n');
  fs.unlinkSync(path.join(f.bin, 'tool')); fs.symlinkSync(path.join(other, 'cli.mjs'), path.join(f.bin, 'tool'));
  assert.throws(() => assertInstalledPackageLinks(f.sdk, f.consumer), /owner does not belong to its node_modules directory/);
});
