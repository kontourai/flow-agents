import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";
import { observeKitContentHash } from "../../build/src/flow-kit/content-hash.js";
import {
  WORKSPACE_KIT_TREE_SCHEME,
  WorkspaceArtifactError,
  createWorkspaceArtifactBudget,
  observeWorkspaceKitTree,
  captureWorkspaceKitTree,
  sealWorkspaceKitTree,
} from "../../build/src/flow-kit/workspace-artifact.js";

function fixture(t) {
  const root = fs.realpathSync(makeFixtureDir("wk-artifact-"));
  t.after(() => {
    function thaw(file) {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) return;
      fs.chmodSync(file, stat.isDirectory() ? 0o755 : 0o644);
      if (stat.isDirectory()) for (const child of fs.readdirSync(file)) thaw(path.join(file, child));
    }
    thaw(root);
    fs.rmSync(root, { recursive: true });
  });
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  return { root, source, destination: path.join(root, "staged") };
}

function refusal(fn, code, status = "corrupt") {
  assert.throws(fn, (error) => error instanceof WorkspaceArtifactError && error.code === code && error.status === status);
}

function patchFs(method, replacement, operation) {
  const original = fs[method];
  fs[method] = replacement(original);
  syncBuiltinESMExports();
  try { return operation(); } finally { fs[method] = original; syncBuiltinESMExports(); }
}

test("unsupported platform refuses observation, capture and sealing before filesystem access", (t) => {
  const f = fixture(t);
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
    refusal(() => observeWorkspaceKitTree(path.join(f.root, "absent")), "artifact-platform", "unsupported");
    refusal(() => captureWorkspaceKitTree(f.source, f.destination, createWorkspaceArtifactBudget()), "artifact-platform", "unsupported");
    refusal(() => sealWorkspaceKitTree(f.source), "artifact-platform", "unsupported");
    assert.equal(fs.existsSync(f.destination), false);
    assert.equal(fs.statSync(f.source).mode & 0o777, 0o755);
  } finally { Object.defineProperty(process, "platform", descriptor); }
});

test("artifact identity uses framed sorted tuples, empty directories and executable behavior", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.source, "empty"));
  fs.writeFileSync(path.join(f.source, "z"), "z");
  fs.writeFileSync(path.join(f.source, "a"), "a", { mode: 0o755 });
  const observed = observeWorkspaceKitTree(f.source);
  const expected = [
    ["file", "a", 1, 1, createHash("sha256").update("a").digest("hex")],
    ["directory", "empty", 0],
    ["file", "z", 0, 1, createHash("sha256").update("z").digest("hex")],
  ];
  assert.deepEqual(observed.entries, expected);
  assert.equal(observed.digest, createHash("sha256").update(JSON.stringify([WORKSPACE_KIT_TREE_SCHEME, expected])).digest("hex"));
  fs.chmodSync(path.join(f.source, "a"), 0o555);
  assert.equal(observeWorkspaceKitTree(f.source).digest, observed.digest);
  fs.chmodSync(path.join(f.source, "a"), 0o644);
  assert.notEqual(observeWorkspaceKitTree(f.source).digest, observed.digest);
  fs.chmodSync(path.join(f.source, "a"), 0o755);
  fs.rmdirSync(path.join(f.source, "empty"));
  assert.notEqual(observeWorkspaceKitTree(f.source).digest, observed.digest);
});

test("framing distinguishes trees with equal legacy NUL-concatenated identities", (t) => {
  const f = fixture(t);
  const other = path.join(f.root, "other");
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(f.source, "a"), "x\0b\0y");
  fs.writeFileSync(path.join(other, "a"), "x");
  fs.writeFileSync(path.join(other, "b"), "y");
  assert.equal(observeKitContentHash(f.source).observed_hash, observeKitContentHash(other).observed_hash);
  assert.notEqual(observeWorkspaceKitTree(f.source).digest, observeWorkspaceKitTree(other).digest);
});

test("capture normalizes staging, prunes before descent and sealing keeps identity", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.source, "empty"), { mode: 0o700 });
  fs.writeFileSync(path.join(f.source, "run"), "run", { mode: 0o711 });
  fs.writeFileSync(path.join(f.source, "data"), "data", { mode: 0o600 });
  fs.mkdirSync(path.join(f.source, "__pycache__"));
  fs.writeFileSync(path.join(f.source, "__pycache__", "ignored"), "not copied");
  fs.symlinkSync(path.join(f.root, "absent"), path.join(f.source, ".git"));
  const budget = createWorkspaceArtifactBudget();
  const result = captureWorkspaceKitTree(f.source, f.destination, budget);
  assert.equal(budget.entries, 5);
  assert.equal(budget.bytes, 7);
  assert.deepEqual(fs.readdirSync(f.destination).sort(), ["data", "empty", "run"]);
  for (const [name, mode] of [["data", 0o644], ["run", 0o755], ["empty", 0o755]])
    assert.equal(fs.statSync(path.join(f.destination, name)).mode & 0o777, mode);
  sealWorkspaceKitTree(f.destination);
  for (const [name, mode] of [["data", 0o444], ["run", 0o555], ["empty", 0o555]])
    assert.equal(fs.statSync(path.join(f.destination, name)).mode & 0o777, mode);
  assert.equal(fs.statSync(f.destination).mode & 0o777, 0o555);
  assert.deepEqual(observeWorkspaceKitTree(f.destination), result);
  assert.equal(fs.statSync(path.join(f.source, "run")).mode & 0o777, 0o711);
});

test("published observation rejects even pruned-name injections", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.source, ".pytest_cache"));
  refusal(() => observeWorkspaceKitTree(f.source), "artifact-pruned-entry");
});

test("capture refuses existing destinations, overlap and links without overwriting", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.source, "data"), "source");
  fs.mkdirSync(f.destination);
  fs.writeFileSync(path.join(f.destination, "sentinel"), "keep");
  assert.throws(() => captureWorkspaceKitTree(f.source, f.destination, createWorkspaceArtifactBudget()), WorkspaceArtifactError);
  assert.equal(fs.readFileSync(path.join(f.destination, "sentinel"), "utf8"), "keep");
  refusal(() => captureWorkspaceKitTree(f.source, path.join(f.source, "nested"), createWorkspaceArtifactBudget()), "artifact-overlap");
  assert.equal(fs.existsSync(path.join(f.source, "nested")), false);
  fs.symlinkSync(f.source, path.join(f.root, "linked"), "dir");
  refusal(() => observeWorkspaceKitTree(path.join(f.root, "linked")), "artifact-root");
  fs.symlinkSync(path.join(f.destination, "sentinel"), path.join(f.source, "escape"));
  refusal(() => observeWorkspaceKitTree(f.source), "artifact-entry-type");
  refusal(() => observeWorkspaceKitTree(path.join(f.root, "missing")), "artifact-missing", "missing");
});

test("portable paths reject unsafe names and normalization aliases", (t) => {
  const f = fixture(t);
  for (const name of ["bad:name", "trailing.", "trailing ", "CON.txt", "com1", "LPT².log", "back\\slash", "control\u0001", "e\u0301"]) {
    const file = path.join(f.source, name);
    fs.writeFileSync(file, "x");
    refusal(() => observeWorkspaceKitTree(f.source), "artifact-path");
    fs.unlinkSync(file);
  }
});

test("portable paths reject case-fold collisions when the filesystem can store both names", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.source, "SS"), "x");
  fs.writeFileSync(path.join(f.source, "ß"), "y");
  if (fs.readdirSync(f.source).length !== 2) {
    t.skip("Filesystem aliases the two case-fold-equivalent names before observation");
    return;
  }
  refusal(() => observeWorkspaceKitTree(f.source), "artifact-path-collision");
});

test("UTF-8 names survive byte-preserving enumeration", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.source, "文�.txt"), "é");
  const captured = captureWorkspaceKitTree(f.source, f.destination, createWorkspaceArtifactBudget());
  assert.equal(captured.entries[0][1], "文�.txt");
  assert.equal(fs.readFileSync(path.join(f.destination, "文�.txt"), "utf8"), "é");
});

test("invalid UTF-8 directory-entry bytes refuse rather than being replaced", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  const file = Buffer.concat([Buffer.from(`${f.source}/`), Buffer.from([0xff])]);
  try { fs.writeFileSync(file, "invalid name"); } catch (error) {
    if (error.code === "EILSEQ") { t.skip("Filesystem rejects invalid UTF-8 names before observation"); return; }
    throw error;
  }
  try { refusal(() => observeWorkspaceKitTree(f.source), "artifact-path"); }
  finally { fs.unlinkSync(file); }
});

test("budgets are cumulative, sparse files are rejected before reading, and depth is bounded", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.source, "a"), "abc");
  const budget = createWorkspaceArtifactBudget();
  observeWorkspaceKitTree(f.source, budget);
  observeWorkspaceKitTree(f.source, budget);
  assert.deepEqual(budget, { entries: 2, bytes: 6 });
  refusal(() => observeWorkspaceKitTree(f.source, { entries: 10_000, bytes: 0 }), "artifact-entry-limit", "unsupported");
  refusal(() => observeWorkspaceKitTree(f.source, { entries: 0, bytes: 256 * 1024 * 1024 - 2 }), "artifact-byte-limit", "unsupported");
  fs.truncateSync(path.join(f.source, "a"), 64 * 1024 * 1024 + 1);
  patchFs("readSync", () => () => { assert.fail("oversize content must never be read"); }, () => {
    refusal(() => observeWorkspaceKitTree(f.source), "artifact-file-limit", "unsupported");
  });
  fs.unlinkSync(path.join(f.source, "a"));
  let dir = f.source;
  for (let i = 0; i < 33; i++) { dir = path.join(dir, "d"); fs.mkdirSync(dir); }
  refusal(() => observeWorkspaceKitTree(f.source), "artifact-depth-limit", "unsupported");
});

test("enumeration counts excluded names without visiting their contents", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.source, ".git"));
  refusal(() => captureWorkspaceKitTree(f.source, f.destination, { entries: 10_000, bytes: 0 }), "artifact-entry-limit", "unsupported");
});

test("file replacement between inspection and open refuses even with identical bytes", (t) => {
  const f = fixture(t);
  const file = path.join(f.source, "a");
  fs.writeFileSync(file, "same");
  let injected = false;
  patchFs("openSync", (original) => (target, ...args) => {
    if (target === file && !injected) {
      injected = true;
      fs.renameSync(file, path.join(f.root, "retained"));
      fs.writeFileSync(file, "same");
    }
    return original(target, ...args);
  }, () => refusal(() => observeWorkspaceKitTree(f.source), "artifact-source-changed"));
  assert.equal(injected, true);
});

test("content growth during a streaming read refuses", (t) => {
  const f = fixture(t);
  const file = path.join(f.source, "a");
  fs.writeFileSync(file, Buffer.alloc(128 * 1024, 97));
  let injected = false;
  patchFs("readSync", (original) => (...args) => {
    assert.ok(args[3] <= 64 * 1024, "reads use bounded chunks");
    const result = original(...args);
    if (!injected) { injected = true; fs.appendFileSync(file, "extra"); }
    return result;
  }, () => refusal(() => captureWorkspaceKitTree(f.source, f.destination, createWorkspaceArtifactBudget()), "artifact-source-changed"));
  assert.equal(injected, true);
});

test("staging directory replacement never chmods or populates a symlink target", (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, "outside");
  fs.mkdirSync(outside, { mode: 0o700 });
  fs.writeFileSync(path.join(outside, "sentinel"), "keep");
  let injected = false;
  patchFs("mkdirSync", (original) => (target, ...args) => {
    const result = original(target, ...args);
    if (target === f.destination) {
      injected = true;
      fs.rmdirSync(target);
      fs.symlinkSync(outside, target, "dir");
    }
    return result;
  }, () => assert.throws(() => captureWorkspaceKitTree(f.source, f.destination, createWorkspaceArtifactBudget()), WorkspaceArtifactError));
  assert.equal(injected, true);
  assert.equal(fs.statSync(outside).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(outside), ["sentinel"]);
  assert.equal(fs.readFileSync(path.join(outside, "sentinel"), "utf8"), "keep");
});

test("special filesystem entries refuse without opening their contents", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  const socket = path.join(f.source, "socket");
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  try { refusal(() => observeWorkspaceKitTree(f.source), "artifact-entry-type"); }
  finally { await new Promise((resolve) => server.close(resolve)); }
});
