// Rejection-path tests for scripts/check-shipped-dependencies.mjs. Each case runs the guard as a
// child process against a throwaway package and asserts its exit status and report, so the CLI
// seam CI runs is the one under test. The real-repo pass runs as its own CI command.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD = fileURLToPath(new URL('../../scripts/check-shipped-dependencies.mjs', import.meta.url));

function fixture(t, { manifest = {}, files = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipped-deps-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = {
    name: 'fixture-pkg',
    version: '1.0.0',
    type: 'module',
    main: 'index.js',
    files: ['index.js', 'lib/'],
    exports: { '.': './index.js', './sub': './lib/sub.cjs' },
    dependencies: { declared: '1.0.0' },
    devDependencies: { devonly: '1.0.0' },
    ...manifest,
  };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg, null, 2));
  const tree = {
    'index.js': [
      'import fs from "fs";',
      'import path from "node:path";',
      'import { a } from "declared";',
      'import "./lib/sub.cjs";',
      '// import ghost from "ghost-in-comment";',
      '/** @type {import("ghost-in-jsdoc").T} */',
      'export const label = "import x from \\"ghost-in-string\\"";',
      'export { a, fs, path };',
      '',
    ].join('\n'),
    'lib/sub.cjs': 'module.exports = require("declared/sub");\n',
    ...files,
  };
  for (const [rel, content] of Object.entries(tree)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

function runGuard(root) {
  const result = spawnSync(process.execPath, [GUARD, '--root', root], { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test('declared imports, builtins, relative paths and prose mentions pass', (t) => {
  const { status, output } = runGuard(fixture(t));
  assert.equal(status, 0, output);
  assert.match(output, /shipped-dependencies: OK/);
  assert.doesNotMatch(output, /ghost/);
});

test('a lazy dynamic import of a devDependency fails and names file, kind and specifier', (t) => {
  const root = fixture(t, { files: { 'lib/model.js': 'export async function load() { return import("devonly/anthropic"); }\n' } });
  const { status, output } = runGuard(root);
  assert.equal(status, 1, output);
  assert.match(output, /FAIL — 1 shipped import/);
  assert.match(output, /devonly \(only in devDependencies\)/);
  assert.match(output, /lib\/model\.js: dynamic-import "devonly\/anthropic"/);
});

test('a require of a package missing from package.json fails', (t) => {
  const root = fixture(t, { files: { 'lib/req.cjs': 'module.exports = require("nowhere");\n' } });
  const { status, output } = runGuard(root);
  assert.equal(status, 1, output);
  assert.match(output, /nowhere \(not in package\.json\)\n\s+lib\/req\.cjs: require-call "nowhere"/);
});

test('moving the package to dependencies, peerDependencies or optionalDependencies clears it', (t) => {
  const files = { 'lib/model.js': 'export const load = () => import("devonly");\n' };
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    const manifest = { devDependencies: {}, [field]: { declared: '1.0.0', devonly: '1.0.0' } };
    if (field !== 'dependencies') manifest.dependencies = { declared: '1.0.0' };
    const { status, output } = runGuard(fixture(t, { manifest, files }));
    assert.equal(status, 0, `${field}: ${output}`);
  }
});

test('only files npm would publish are scanned', (t) => {
  const root = fixture(t, { files: { 'tools/dev-only.js': 'import "devonly";\n' } });
  const { status, output } = runGuard(root);
  assert.equal(status, 0, output);
});

test('a self-reference must name an exports subpath', (t) => {
  const ok = runGuard(fixture(t, { files: { 'lib/self.js': 'import "fixture-pkg/sub";\n' } }));
  assert.equal(ok.status, 0, ok.output);
  const bad = runGuard(fixture(t, { files: { 'lib/self.js': 'import "fixture-pkg/lib/self.js";\n' } }));
  assert.equal(bad.status, 1, bad.output);
  assert.match(bad.output, /fixture-pkg \(self-reference to a subpath not in "exports"\)/);
});

test('a manifest entry point missing from the pack refuses instead of scanning a partial tree', (t) => {
  const root = fixture(t, { manifest: { main: 'build/index.js', exports: { '.': './build/index.js' } } });
  const { status, output } = runGuard(root);
  assert.equal(status, 1, output);
  assert.match(output, /missing manifest entry points/);
  assert.match(output, /missing: build\/index\.js/);
});

test('an unparseable shipped file is an error, not a pass', (t) => {
  const root = fixture(t, { files: { 'lib/broken.js': 'export const = ;\n' } });
  const { status, output } = runGuard(root);
  assert.equal(status, 1, output);
  assert.match(output, /ERROR — esbuild could not parse shipped files/);
});
