import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

import { withSubjectLock } from "../../build/src/cli/assignment-provider.js";

test("async subject locks remain owned through settlement and release for both outcomes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-lock-async-lifetime-"));
  const subject = "async-lifetime";
  const lockDir = path.join(root, "assignment", ".async-lifetime.lockdir");
  let resolve;
  const pending = withSubjectLock(root, subject, () => new Promise((done) => { resolve = done; }));
  assert.equal(fs.existsSync(lockDir), true, "the lock remains held while the Promise is pending");
  resolve("done");
  await pending;
  assert.equal(fs.existsSync(lockDir), false, "the lock releases after resolution");

  const rejected = withSubjectLock(root, subject, () => Promise.reject(new Error("fixture rejection")));
  assert.equal(fs.existsSync(lockDir), true, "the lock remains held until rejection settles");
  await assert.rejects(rejected, /fixture rejection/);
  assert.equal(fs.existsSync(lockDir), false, "the lock releases after rejection");
});

test("a displaced lock owner cannot heartbeat or release a replacement lock", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-lock-aba-"));
  const subject = "lock-aba";
  const lockDir = path.join(root, "assignment", ".lock-aba.lockdir");
  let finish;
  const held = withSubjectLock(root, subject, () => new Promise((resolve) => { finish = resolve; }));
  const original = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"));

  const quarantine = `${lockDir}.stale-test`;
  fs.renameSync(lockDir, quarantine);
  fs.mkdirSync(lockDir);
  const replacement = { token: "replacement-owner", stale_after_ms: 300000 };
  fs.writeFileSync(path.join(lockDir, "owner.json"), `${JSON.stringify(replacement)}\n`);
  fs.rmSync(quarantine, { recursive: true, force: true });

  finish();
  await held;
  assert.equal(fs.existsSync(lockDir), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8")), replacement);
  assert.notEqual(original.token, replacement.token);
});

test("stale locks fail closed instead of risking concurrent reclamation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-lock-stale-"));
  const lockDir = path.join(root, "assignment", ".lock-stale.lockdir");
  fs.mkdirSync(lockDir, { recursive: true });
  const ownerFile = path.join(lockDir, "owner.json");
  fs.writeFileSync(ownerFile, `${JSON.stringify({ token: "old-owner", stale_after_ms: 1 })}\n`);
  // The owner-provided one-millisecond threshold is ignored. Reclamation uses
  // the contender's bounded policy, so this must be older than its default.
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(ownerFile, old, old);

  assert.throws(() => withSubjectLock(root, "lock-stale", () => "unreachable"), /requires explicit operator cleanup/);
  assert.equal(fs.existsSync(lockDir), true);
});

test("old ownerless and malformed locks fail closed without a busy-spin", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-lock-malformed-"));
  const assignmentDir = path.join(root, "assignment");
  for (const [subject, owner] of [["ownerless", null], ["malformed", "not-json\n"]]) {
    const lockDir = path.join(assignmentDir, `.${subject}.lockdir`);
    fs.mkdirSync(lockDir, { recursive: true });
    if (owner !== null) fs.writeFileSync(path.join(lockDir, "owner.json"), owner);
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(lockDir, old, old);
    if (owner !== null) fs.utimesSync(path.join(lockDir, "owner.json"), old, old);
    const started = Date.now();
    assert.throws(() => withSubjectLock(root, subject, () => "unreachable"), /requires explicit operator cleanup/);
    assert.ok(Date.now() - started < 1_000, `${subject} stale lock should fail without spinning until deadline`);
    assert.equal(fs.existsSync(lockDir), true);
  }
});

test("failed owner metadata creation removes the ownerless lock directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-lock-owner-write-"));
  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = function injectedOwnerWriteFailure(file, ...args) {
    if (path.basename(String(file)) === "owner.json") {
      const error = new Error("injected owner write failure");
      error.code = "EACCES";
      throw error;
    }
    return originalWriteFileSync.call(this, file, ...args);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => withSubjectLock(root, "owner-write", () => "unreachable"), /failed to acquire assignment lock/);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    syncBuiltinESMExports();
  }
  assert.equal(fs.existsSync(path.join(root, "assignment", ".owner-write.lockdir")), false);
});
