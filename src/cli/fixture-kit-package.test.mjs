import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";
import { makeFixturePackage } from "./fixture-kit-package.mjs";

for (const removeRoot of [false, true]) {
  test(`package copy failure retains the exception and ${removeRoot ? 'removed' : 'present'} destination identity`, () => {
    const originalCopy = fs.cpSync;
    const failure = Object.assign(new Error("controlled copy failure"), { code: "ENOENT", syscall: "cp" });
    let calls = 0;
    let root;
    fs.cpSync = (source, destination) => {
      calls += 1;
      root = path.dirname(destination);
      if (removeRoot) fs.rmSync(root, { recursive: true, force: true });
      throw failure;
    };
    try {
      assert.throws(() => makeFixturePackage("fixture-copy-diagnostic-", {}), (error) => {
        assert.equal(error, failure, "original exception, code and stack must survive");
        assert.equal(error.code, "ENOENT");
        assert.equal(error.syscall, "cp");
        const diagnostic = JSON.parse(error.fixtureCopy);
        assert.equal(diagnostic.pid, process.pid);
        assert.equal(diagnostic.node, process.version);
        assert.equal(diagnostic.destination, path.join(root, "build"));
        assert.ok(diagnostic.before.source.ino);
        assert.ok(diagnostic.before.sourceSrc.ino);
        assert.ok(diagnostic.before.root.ino);
        assert.equal(diagnostic.before.destination.code, "ENOENT");
        assert.deepEqual(diagnostic.after.source, diagnostic.before.source);
        if (removeRoot) assert.equal(diagnostic.after.root.code, "ENOENT");
        else assert.deepEqual(diagnostic.after.root, diagnostic.before.root);
        return true;
      });
      assert.equal(calls, 1, "setup must not retry past copy failures");
    } finally {
      fs.cpSync = originalCopy;
      if (root) fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("the default spec reporter retains copy identities rather than collapsed objects", () => {
  const root = makeFixtureDir("fixture-copy-reporter-");
  try {
    const file = path.join(root, "fault.test.mjs");
    fs.writeFileSync(file, `
import test from "node:test";
import fs from "node:fs";
import { makeFixturePackage } from ${JSON.stringify(new URL("./fixture-kit-package.mjs", import.meta.url).href)};
test("intentional copy fault", () => {
  fs.cpSync = () => { throw Object.assign(new Error("intentional copy fault"), { code: "ENOENT" }); };
  makeFixturePackage("fixture-copy-reporter-child-", {});
});
`);
    const { NODE_TEST_CONTEXT: _testContext, ...env } = process.env;
    const result = spawnSync(process.execPath, ["--test", "--test-reporter=spec", file], { env, encoding: "utf8", timeout: 20_000 });
    assert.equal(result.status, 1, `${result.stdout} ${result.stderr}`);
    assert.match(result.stdout, /intentional copy fault/);
    assert.match(result.stdout, /fixtureCopy:/);
    assert.match(result.stdout, /"before":\{"source":\{"dev":\d+,"ino":\d+/);
    assert.match(result.stdout, /"after":\{"source":\{"dev":\d+,"ino":\d+/);
    assert.ok(!result.stdout.includes("[Object]"), "filesystem identities must be retained in raw failure output");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fixture package ignores disappearing private instrumentation but preserves real copy failures', () => {
  const originalCopy = fs.cpSync;
  const source = fileURLToPath(new URL('../../build/src/.builder-flow-runtime.test-seam-123-456.mjs', import.meta.url));
  fs.writeFileSync(source, 'export const privateProbe = true;\n', { flag: 'wx' });
  let root, observed = false;
  fs.cpSync = (from, to, options) => originalCopy(from, to, { ...options, filter(file, destination) {
    const include = options?.filter ? options.filter(file, destination) : true;
    if (file === source) { observed = true; fs.unlinkSync(source); }
    return include;
  } });
  try {
    const fixture = makeFixturePackage('fixture-copy-transient-', {}); root = fixture.root;
    assert.equal(observed, true);
    assert.equal(fs.existsSync(path.join(root, 'build/src', path.basename(source))), false);
    assert.equal(fs.existsSync(fixture.cli), true);
  } finally {
    fs.cpSync = originalCopy; fs.rmSync(source, { force: true });
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});
