import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
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
        const diagnostic = error.fixtureCopy;
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
