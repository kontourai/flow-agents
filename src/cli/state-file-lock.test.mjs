import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const helperUrl = new URL("../../build/src/lib/state-file-lock.js", import.meta.url).href;

function runHelper(source, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`state helper exited ${code}: ${stderr}`));
    });
  });
}

test("initial state write creates its destination directory", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-state-lock-create-"));
  try {
    const file = path.join(workspace, "new-session", "state.json");
    const { writeStateJson } = await import(helperUrl);
    writeStateJson(file, { status: "planned" });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { status: "planned" });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("state replacement preserves a newer value when its expected snapshot is stale", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-state-lock-stale-"));
  try {
    const file = path.join(workspace, "state.json");
    fs.writeFileSync(file, '{"version":"newer"}\n');
    const { replaceStateIfUnchanged } = await import(helperUrl);
    assert.equal(
      replaceStateIfUnchanged(file, '{"version":"old"}\n', '{"version":"projection"}\n'),
      false,
    );
    assert.equal(fs.readFileSync(file, "utf8"), '{"version":"newer"}\n');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("sidecar writes and Builder compare-and-swap serialize across processes", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-state-lock-race-"));
  try {
    const file = path.join(workspace, "state.json");
    const lockDir = `${file}.lockdir`;
    fs.writeFileSync(file, '{"version":"old"}\n');
    fs.mkdirSync(lockDir);
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      `${JSON.stringify({ token: "test-owner", pid: process.pid, acquired_at: new Date().toISOString() })}\n`,
    );

    const replace = runHelper(
      `import { replaceStateIfUnchanged } from ${JSON.stringify(helperUrl)};
       process.stdout.write(String(replaceStateIfUnchanged(process.argv[1], '{"version":"old"}\\n', '{"version":"projection"}\\n')));`,
      [file],
    );
    const write = runHelper(
      `import { writeStateJson } from ${JSON.stringify(helperUrl)};
       writeStateJson(process.argv[1], { version: "newer" });
       process.stdout.write("written");`,
      [file],
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.rmSync(lockDir, { recursive: true });
    const [replaceResult, writeResult] = await Promise.all([replace, write]);
    assert.match(replaceResult, /^(true|false)$/);
    assert.equal(writeResult, "written");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: "newer" });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("a sidecar read-modify-write observes a Builder projection committed while it waits", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-state-lock-update-"));
  try {
    const file = path.join(workspace, "state.json");
    const lockDir = `${file}.lockdir`;
    fs.writeFileSync(file, '{"version":"old"}\n');
    fs.mkdirSync(lockDir);
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      `${JSON.stringify({ token: "test-owner", pid: process.pid, acquired_at: new Date().toISOString() })}\n`,
    );

    const update = runHelper(
      `import { updateStateJson } from ${JSON.stringify(helperUrl)};
       updateStateJson(process.argv[1], (current) => ({ ...current, sidecar: "updated" }));
       process.stdout.write("updated");`,
      [file],
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.writeFileSync(file, '{"version":"projection","flow_run":{"status":"active"}}\n');
    fs.rmSync(lockDir, { recursive: true });

    assert.equal(await update, "updated");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
      version: "projection",
      flow_run: { status: "active" },
      sidecar: "updated",
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("state replacement rejects a symlink without changing its target", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-state-lock-symlink-"));
  try {
    const target = path.join(workspace, "target.json");
    const file = path.join(workspace, "state.json");
    fs.writeFileSync(target, '{"version":"outside"}\n');
    try {
      fs.symlinkSync(target, file);
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.skip(`symlinks unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    const { replaceStateIfUnchanged } = await import(helperUrl);
    assert.throws(
      () => replaceStateIfUnchanged(file, '{"version":"outside"}\n', '{"version":"projection"}\n'),
      /symbolic link|ELOOP/,
    );
    assert.equal(fs.readFileSync(target, "utf8"), '{"version":"outside"}\n');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("state replacement rejects a parent directory swapped while lock acquisition waits", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-state-lock-parent-swap-"));
  try {
    const session = path.join(workspace, "session");
    const savedSession = path.join(workspace, "session.saved");
    const outside = path.join(workspace, "outside");
    const file = path.join(session, "state.json");
    const outsideFile = path.join(outside, "state.json");
    fs.mkdirSync(session);
    fs.mkdirSync(outside);
    fs.writeFileSync(file, '{"version":"inside"}\n');
    fs.writeFileSync(outsideFile, '{"version":"outside"}\n');
    fs.mkdirSync(`${file}.lockdir`);
    fs.writeFileSync(
      path.join(`${file}.lockdir`, "owner.json"),
      `${JSON.stringify({ token: "test-owner", pid: process.pid, acquired_at: new Date().toISOString() })}\n`,
    );
    try {
      fs.symlinkSync(outside, path.join(workspace, "symlink-probe"), "dir");
      fs.unlinkSync(path.join(workspace, "symlink-probe"));
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.skip(`directory symlinks unavailable: ${error.code}`);
        return;
      }
      throw error;
    }

    const replacement = runHelper(
      `import { replaceStateIfUnchanged } from ${JSON.stringify(helperUrl)};
       replaceStateIfUnchanged(process.argv[1], '{"version":"inside"}\\n', '{"version":"projection"}\\n');`,
      [file],
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.renameSync(session, savedSession);
    fs.symlinkSync(outside, session, "dir");
    await assert.rejects(replacement, /state file parent changed during locked update/);
    assert.equal(fs.readFileSync(outsideFile, "utf8"), '{"version":"outside"}\n');
    fs.unlinkSync(session);
    fs.renameSync(savedSession, session);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("state replacement rejects a lock created under a transiently swapped parent", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-state-lock-detached-"));
  try {
    const session = path.join(workspace, "session");
    const outside = path.join(workspace, "outside");
    const file = path.join(session, "state.json");
    fs.mkdirSync(session);
    fs.mkdirSync(outside);
    fs.writeFileSync(file, '{"version":"inside"}\n');
    try {
      fs.symlinkSync(outside, path.join(workspace, "symlink-probe"), "dir");
      fs.unlinkSync(path.join(workspace, "symlink-probe"));
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.skip(`directory symlinks unavailable: ${error.code}`);
        return;
      }
      throw error;
    }

    await assert.rejects(
      runHelper(
        `import { createRequire, syncBuiltinESMExports } from "node:module";
         import path from "node:path";
         const require = createRequire(import.meta.url);
         const fs = require("node:fs");
         const file = process.argv[1];
         const outside = process.argv[2];
         const parent = path.dirname(file);
         const saved = parent + ".saved";
         const lockDir = file + ".lockdir";
         const ownerFile = path.join(lockDir, "owner.json");
         const realMkdir = fs.mkdirSync;
         const realWriteFile = fs.writeFileSync;
         fs.mkdirSync = (target, ...args) => {
           if (path.resolve(String(target)) === path.resolve(lockDir)) {
             fs.renameSync(parent, saved);
             fs.symlinkSync(outside, parent, "dir");
           }
           return realMkdir(target, ...args);
         };
         fs.writeFileSync = (target, ...args) => {
           const result = realWriteFile(target, ...args);
           if (path.resolve(String(target)) === path.resolve(ownerFile)) {
             fs.unlinkSync(parent);
             fs.renameSync(saved, parent);
           }
           return result;
         };
         syncBuiltinESMExports();
         const { replaceStateIfUnchanged } = await import(${JSON.stringify(helperUrl)});
         replaceStateIfUnchanged(file, '{"version":"inside"}\\n', '{"version":"projection"}\\n');`,
        [file, outside],
      ),
    );
    assert.equal(fs.readFileSync(file, "utf8"), '{"version":"inside"}\n');
    assert.equal(fs.existsSync(path.join(outside, "state.json")), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("state replacement completes legal short writes before reporting success", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-state-lock-short-write-"));
  try {
    const file = path.join(workspace, "state.json");
    fs.writeFileSync(file, '{"version":"old"}\n');
    const result = await runHelper(
      `import { createRequire, syncBuiltinESMExports } from "node:module";
       const require = createRequire(import.meta.url);
       const fs = require("node:fs");
       const realWrite = fs.writeSync;
       fs.writeSync = (descriptor, buffer, offset, length, position) =>
         realWrite(descriptor, buffer, offset, Math.max(1, Math.floor(length / 2)), position);
       syncBuiltinESMExports();
       const { replaceStateIfUnchanged } = await import(${JSON.stringify(helperUrl)});
       process.stdout.write(String(replaceStateIfUnchanged(
         process.argv[1],
         '{"version":"old"}\\n',
         '{"version":"projection","detail":"complete"}\\n',
       )));`,
      [file],
    );
    assert.equal(result, "true");
    assert.equal(
      fs.readFileSync(file, "utf8"),
      '{"version":"projection","detail":"complete"}\n',
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("a failed replacement write leaves the prior state byte-identical", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-state-lock-write-failure-"));
  try {
    const file = path.join(workspace, "state.json");
    const original = '{"version":"old","durable":true}\n';
    fs.writeFileSync(file, original);
    await assert.rejects(
      runHelper(
        `import { createRequire, syncBuiltinESMExports } from "node:module";
         const require = createRequire(import.meta.url);
         const fs = require("node:fs");
         const realOpen = fs.openSync;
         const realWrite = fs.writeSync;
         let temporaryDescriptor = null;
         let calls = 0;
         fs.openSync = (target, ...args) => {
           const descriptor = realOpen(target, ...args);
           if (String(target).includes(".tmp-")) temporaryDescriptor = descriptor;
           return descriptor;
         };
         fs.writeSync = (descriptor, buffer, offset, length, position) => {
           if (descriptor !== temporaryDescriptor) {
             return realWrite(descriptor, buffer, offset, length, position);
           }
           calls += 1;
           if (calls === 1) return realWrite(descriptor, buffer, offset, Math.max(1, Math.floor(length / 2)), position);
           const error = new Error("injected state replacement failure");
           error.code = "EIO";
           throw error;
         };
         syncBuiltinESMExports();
         const { replaceStateIfUnchanged } = await import(${JSON.stringify(helperUrl)});
         replaceStateIfUnchanged(
           process.argv[1],
           ${JSON.stringify(original)},
           '{"version":"projection","durable":true}\\n',
         );`,
        [file],
      ),
      /injected state replacement failure/,
    );
    assert.equal(fs.readFileSync(file, "utf8"), original);
    assert.deepEqual(fs.readdirSync(workspace).sort(), ["state.json"]);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("failed state-lock initialization never deletes a successor lock", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-state-lock-successor-"));
  try {
    const file = path.join(workspace, "state.json");
    const lockDir = `${file}.lockdir`;
    const ownerFile = path.join(lockDir, "owner.json");
    fs.writeFileSync(file, '{"version":"old"}\n');
    await assert.rejects(
      runHelper(
        `import { createRequire, syncBuiltinESMExports } from "node:module";
         import path from "node:path";
         const require = createRequire(import.meta.url);
         const fs = require("node:fs");
         const file = process.argv[1];
         const lockDir = file + ".lockdir";
         const ownerFile = path.join(lockDir, "owner.json");
         const realWriteFile = fs.writeFileSync;
         let replaced = false;
         fs.writeFileSync = (target, ...args) => {
           if (!replaced && path.resolve(String(target)) === path.resolve(ownerFile)) {
             replaced = true;
             fs.rmSync(lockDir, { recursive: true, force: true });
             fs.mkdirSync(lockDir, { recursive: true });
             realWriteFile(ownerFile, JSON.stringify({ token: "successor" }) + "\\n");
             const error = new Error("injected state lock initialization failure");
             error.code = "EIO";
             throw error;
           }
           return realWriteFile(target, ...args);
         };
         syncBuiltinESMExports();
         const { replaceStateIfUnchanged } = await import(${JSON.stringify(helperUrl)});
         replaceStateIfUnchanged(file, '{"version":"old"}\\n', '{"version":"new"}\\n');`,
        [file],
      ),
      /injected state lock initialization failure/,
    );
    assert.equal(JSON.parse(fs.readFileSync(ownerFile, "utf8")).token, "successor");
    assert.equal(fs.readFileSync(file, "utf8"), '{"version":"old"}\n');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("failed state-lock owner creation removes its own empty lock", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-state-lock-owner-failure-"));
  try {
    const file = path.join(workspace, "state.json");
    const lockDir = `${file}.lockdir`;
    fs.writeFileSync(file, '{"version":"old"}\n');
    await assert.rejects(
      runHelper(
        `import { createRequire, syncBuiltinESMExports } from "node:module";
         import path from "node:path";
         const require = createRequire(import.meta.url);
         const fs = require("node:fs");
         const file = process.argv[1];
         const ownerFile = path.join(file + ".lockdir", "owner.json");
         const realWriteFile = fs.writeFileSync;
         fs.writeFileSync = (target, ...args) => {
           if (path.resolve(String(target)) === path.resolve(ownerFile)) {
             const error = new Error("injected state owner failure");
             error.code = "EIO";
             throw error;
           }
           return realWriteFile(target, ...args);
         };
         syncBuiltinESMExports();
         const { replaceStateIfUnchanged } = await import(${JSON.stringify(helperUrl)});
         replaceStateIfUnchanged(file, '{"version":"old"}\\n', '{"version":"new"}\\n');`,
        [file],
      ),
      /injected state owner failure/,
    );
    assert.equal(fs.existsSync(lockDir), false);
    assert.equal(fs.readFileSync(file, "utf8"), '{"version":"old"}\n');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
