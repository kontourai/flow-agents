import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldStore } from "../adapters/shared/store-resolve.js";
import { acquireDreamLock } from "./fs-safe.js";

test("lock acquisition rolls back the owner file and lock directory when metadata persistence fails", () => {
  const fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dream-lock-rollback-"));
  try {
    const repo = path.join(fixture, "store-repo"); fs.mkdirSync(repo); const storeRoot = scaffoldStore(repo); const lock = path.join(storeRoot, "dream", "locks", "run.lock");
    assert.throws(() => acquireDreamLock(storeRoot, "run", () => "2026-07-20T00:00:00.000Z", 300_000, { writeOwner() { throw new Error("injected owner metadata failure"); } }), /injected owner metadata failure/);
    assert.equal(fs.existsSync(lock), false);
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});
