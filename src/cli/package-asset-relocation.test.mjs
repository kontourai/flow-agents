import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { relocatePackageAssets } from '../../build/src/tools/relocate-package-assets.js';

const source = 'const assets = dirname(_require.resolve("format-fixture"));';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'package-assets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function write(relative, content) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  }
  const ownerEntry = write('node_modules/owner/index.js', '');
  write('node_modules/owner/package.json', JSON.stringify({ name: 'owner', version: '2.0.0', dependencies: { 'format-fixture': '^1.0.0' } }));
  for (const [base, version] of [['node_modules/format-fixture', '9.0.0'], ['node_modules/owner/node_modules/format-fixture', '1.2.3']]) {
    write(`${base}/package.json`, JSON.stringify({ name: 'format-fixture', version, main: 'dist/index.js', license: 'MIT' }));
    write(`${base}/LICENSE`, `license ${version}\n`);
    write(`${base}/dist/index.js`, '');
    write(`${base}/dist/schemas/trust.schema.json`, JSON.stringify({ version }));
  }
  return { root, write, ownerEntry, vendor: path.join(root, 'vendor') };
}

test('asset relocation preserves owner-resolved version and bytes despite competing ambient package', async t => {
  const { root, ownerEntry, vendor } = fixture(t);
  const relocated = relocatePackageAssets(source, ownerEntry, vendor);
  const destination = path.join(vendor, 'format-fixture');
  const original = path.join(root, 'node_modules/owner/node_modules/format-fixture');
  for (const relative of ['package.json', 'LICENSE', 'schemas/trust.schema.json']) {
    const from = relative.startsWith('schemas/') ? path.join(original, 'dist', relative) : path.join(original, relative);
    assert.deepEqual(fs.readFileSync(path.join(destination, relative)), fs.readFileSync(from));
  }
  const originalProvenance = fs.readFileSync(path.join(destination, 'assets.bundle.json'));
  relocatePackageAssets(source, ownerEntry, vendor);
  assert.deepEqual(fs.readFileSync(path.join(destination, 'assets.bundle.json')), originalProvenance);
  const provenance = JSON.parse(originalProvenance);
  assert.equal(provenance.owner_package, 'owner');
  assert.equal(provenance.owner_version, '2.0.0');
  assert.equal(provenance.version, '1.2.3');
  for (const file of provenance.files) assert.equal(file.sha256, crypto.createHash('sha256').update(fs.readFileSync(path.join(destination, file.path))).digest('hex'));
  const module = path.join(vendor, 'probe.mjs');
  fs.writeFileSync(module, `import {fileURLToPath} from 'node:url';\n${relocated}\nexport default assets;`);
  assert.equal((await import(pathToFileURL(module))).default, `${fs.realpathSync(destination)}${path.sep}`);
});

for (const [label, mutate, error] of [
  ['changed seam', () => 'no lookup', /lookup seam changed/],
  ['multiple seams', () => `${source}\n${source}`, /lookup seam changed/],
  ['undeclared dependency', f => { f.write('node_modules/owner/package.json', JSON.stringify({ name: 'owner', version: '2.0.0' })); return source; }, /Undeclared/],
  ['missing schemas', f => { fs.rmSync(path.join(f.root, 'node_modules/owner/node_modules/format-fixture/dist/schemas'), { recursive: true }); return source; }, /ENOENT/],
  ['missing license metadata', f => { f.write('node_modules/owner/node_modules/format-fixture/package.json', JSON.stringify({ name: 'format-fixture', version: '1.2.3', main: 'dist/index.js' })); fs.rmSync(path.join(f.root, 'node_modules/owner/node_modules/format-fixture/LICENSE')); return source; }, /license metadata missing/],
]) test(`asset relocation rejects ${label} before writing`, t => {
  const f = fixture(t);
  assert.throws(() => relocatePackageAssets(mutate(f), f.ownerEntry, f.vendor), error);
  assert.equal(fs.existsSync(f.vendor), false);
});

test('published Flow validator relocation retains its actual transitive schemas and provenance', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-assets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const flowEntry = fileURLToPath(import.meta.resolve('@kontourai/flow'));
  const requireFlow = createRequire(flowEntry);
  const flowRoot = path.dirname(path.dirname(flowEntry));
  const validator = fs.readFileSync(path.join(flowRoot, 'dist/gates/trust-bundle-validator.js'), 'utf8');
  const relocated = relocatePackageAssets(validator, flowEntry, root);
  const dependencyEntry = requireFlow.resolve('hachure');
  const schemas = path.join(path.dirname(dependencyEntry), 'schemas');
  for (const name of fs.readdirSync(schemas)) assert.deepEqual(fs.readFileSync(path.join(root, 'hachure/schemas', name)), fs.readFileSync(path.join(schemas, name)));
  assert.ok(relocated.includes('new URL("./hachure/", import.meta.url)'));
  const provenance = JSON.parse(fs.readFileSync(path.join(root, 'hachure/assets.bundle.json')));
  assert.equal(provenance.owner_package, '@kontourai/flow');
  assert.equal(provenance.package, 'hachure');
  let dependencyRoot = path.dirname(dependencyEntry);
  while (!fs.existsSync(path.join(dependencyRoot, 'package.json'))) dependencyRoot = path.dirname(dependencyRoot);
  assert.equal(provenance.version, JSON.parse(fs.readFileSync(path.join(dependencyRoot, 'package.json'))).version);
  assert.deepEqual(fs.readFileSync(path.join(root, 'hachure/package.json')), fs.readFileSync(path.join(dependencyRoot, 'package.json')));
  assert.ok(provenance.files.some(file => file.path === 'schemas/trust-bundle.schema.json'));
});
