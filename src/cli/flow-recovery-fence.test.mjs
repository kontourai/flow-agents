import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  assertFlowRunRecoveryFenceOpen,
  withFlowRunRecoveryFenceRead,
  withFlowRunRecoveryFenceReadAsync,
} from "../../build/src/flow-recovery-fence.js";
import {
  withNarrativeFlowRunRecoveryFenceRead,
} from "../../build/src/narrative/recovery-fence.js";

const require = createRequire(import.meta.url);
const hookFence = require("../../scripts/hooks/lib/flow-recovery-fence.js");
const contextHookFence = require("../../context/scripts/hooks/lib/flow-recovery-fence.js");

function fixture() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-recovery-fence-"));
  const runId = "run-1";
  const runRoot = path.join(projectRoot, ".kontourai", "flow", "runs", runId);
  fs.mkdirSync(runRoot, { recursive: true });
  return { projectRoot, runId, file: path.join(runRoot, "recovery-fence.json") };
}

function fence(runId, status = "open", recoveryId = "a".repeat(64)) {
  return {
    protocol: "flow.run-recovery-fence.v1",
    run_id: runId,
    recovery_id: recoveryId,
    status,
    updated_at: "2026-07-23T00:00:00.000Z",
    generation: recoveryId.startsWith("a")
      ? "11111111-1111-4111-8111-111111111111"
      : "22222222-2222-4222-8222-222222222222",
  };
}

function writeWritableFence(value) {
  fs.writeFileSync(value.file, `${JSON.stringify(fence(value.runId))}\n`, { mode: 0o600 });
  fs.chmodSync(value.file, 0o666);
  assert.equal(fs.statSync(value.file).mode & 0o777, 0o666);
}

test("Flow Agents recovery adapter allows absence/open and rejects active or unknown records", () => {
  const value = fixture();
  try {
    assert.doesNotThrow(() => assertFlowRunRecoveryFenceOpen(value.projectRoot, value.runId));
    fs.writeFileSync(value.file, `${JSON.stringify(fence(value.runId))}\n`, { mode: 0o600 });
    assert.doesNotThrow(() => assertFlowRunRecoveryFenceOpen(value.projectRoot, value.runId));
    fs.writeFileSync(value.file, `${JSON.stringify(fence(value.runId, "active"))}\n`, { mode: 0o600 });
    assert.throws(() => assertFlowRunRecoveryFenceOpen(value.projectRoot, value.runId), /fenced for recovery/);
    fs.writeFileSync(value.file, `${JSON.stringify({ ...fence(value.runId), protocol: "unknown" })}\n`, { mode: 0o600 });
    assert.throws(() => assertFlowRunRecoveryFenceOpen(value.projectRoot, value.runId), /malformed or unsupported/);
  } finally {
    fs.rmSync(value.projectRoot, { recursive: true, force: true });
  }
});

test("Flow Agents recovery adapter rejects a fence generation change during a read", () => {
  const value = fixture();
  try {
    fs.writeFileSync(value.file, `${JSON.stringify(fence(value.runId))}\n`, { mode: 0o600 });
    assert.throws(
      () => withFlowRunRecoveryFenceRead(value.projectRoot, value.runId, () => {
        fs.writeFileSync(value.file, `${JSON.stringify(fence(value.runId, "open", "b".repeat(64)))}\n`, { mode: 0o600 });
      }),
      /changed during read/,
    );
  } finally {
    fs.rmSync(value.projectRoot, { recursive: true, force: true });
  }
});

test("Flow Agents recovery adapter rejects a group/world-writable fence", () => {
  const value = fixture();
  try {
    writeWritableFence(value);
    assert.throws(
      () => assertFlowRunRecoveryFenceOpen(value.projectRoot, value.runId),
      /malformed/,
    );
  } finally {
    fs.rmSync(value.projectRoot, { recursive: true, force: true });
  }
});

test("narrative recovery reader rejects a group/world-writable fence", () => {
  const value = fixture();
  try {
    writeWritableFence(value);
    assert.throws(
      () => withNarrativeFlowRunRecoveryFenceRead(value.projectRoot, value.runId, () => null),
      /malformed/,
    );
  } finally {
    fs.rmSync(value.projectRoot, { recursive: true, force: true });
  }
});

test("both hook recovery readers reject a group/world-writable fence", () => {
  for (const [name, reader] of [
    ["source hook", hookFence.withFlowRecoveryFenceRead],
    ["context hook", contextHookFence.withFlowRecoveryFenceRead],
  ]) {
    const value = fixture();
    try {
      writeWritableFence(value);
      assert.throws(
        () => reader(value.projectRoot, value.runId, () => null),
        /malformed/,
        name,
      );
    } finally {
      fs.rmSync(value.projectRoot, { recursive: true, force: true });
    }
  }
});

test("all supported fence wrappers reject a deterministic generation transition during the protected read", () => {
  for (const [name, wrapper] of [
    ["narrative", withNarrativeFlowRunRecoveryFenceRead],
    ["hook", hookFence.withFlowRecoveryFenceRead],
  ]) {
    const value = fixture();
    try {
      fs.writeFileSync(value.file, `${JSON.stringify(fence(value.runId))}\n`, { mode: 0o600 });
      assert.throws(
        () => wrapper(value.projectRoot, value.runId, () => {
          fs.writeFileSync(value.file, `${JSON.stringify(fence(value.runId, "open", "b".repeat(64)))}\n`, { mode: 0o600 });
        }),
        /changed during read/,
        name,
      );
    } finally {
      fs.rmSync(value.projectRoot, { recursive: true, force: true });
    }
  }
});

test("all synchronous fence wrappers surface an active fence after a throwing callback", () => {
  for (const [name, wrapper] of [
    ["Flow Agents", withFlowRunRecoveryFenceRead],
    ["narrative", withNarrativeFlowRunRecoveryFenceRead],
    ["source hook", hookFence.withFlowRecoveryFenceRead],
    ["context hook", contextHookFence.withFlowRecoveryFenceRead],
  ]) {
    const value = fixture();
    const sentinel = new Error(`${name} callback sentinel`);
    try {
      fs.writeFileSync(value.file, `${JSON.stringify(fence(value.runId))}\n`, { mode: 0o600 });
      assert.throws(
        () => wrapper(value.projectRoot, value.runId, () => {
          fs.writeFileSync(value.file, `${JSON.stringify(fence(value.runId, "active", "b".repeat(64)))}\n`, { mode: 0o600 });
          throw sentinel;
        }),
        (error) => {
          assert.notEqual(error, sentinel, name);
          assert.match(String(error), /fenced for recovery/, name);
          return true;
        },
      );
    } finally {
      fs.rmSync(value.projectRoot, { recursive: true, force: true });
    }
  }
});

test("all asynchronous fence wrappers surface an active fence after a throwing callback", async () => {
  for (const [name, wrapper] of [
    ["Flow Agents", withFlowRunRecoveryFenceReadAsync],
    ["source hook", hookFence.withFlowRecoveryFenceReadAsync],
    ["context hook", contextHookFence.withFlowRecoveryFenceReadAsync],
  ]) {
    const value = fixture();
    const sentinel = new Error(`${name} async callback sentinel`);
    try {
      fs.writeFileSync(value.file, `${JSON.stringify(fence(value.runId))}\n`, { mode: 0o600 });
      await assert.rejects(
        () => wrapper(value.projectRoot, value.runId, async () => {
          fs.writeFileSync(value.file, `${JSON.stringify(fence(value.runId, "active", "b".repeat(64)))}\n`, { mode: 0o600 });
          throw sentinel;
        }),
        (error) => {
          assert.notEqual(error, sentinel, name);
          assert.match(String(error), /fenced for recovery/, name);
          return true;
        },
      );
    } finally {
      fs.rmSync(value.projectRoot, { recursive: true, force: true });
    }
  }
});

test("all synchronous fence wrappers preserve a callback error while the fence stays stable", () => {
  for (const [name, wrapper] of [
    ["Flow Agents", withFlowRunRecoveryFenceRead],
    ["narrative", withNarrativeFlowRunRecoveryFenceRead],
    ["source hook", hookFence.withFlowRecoveryFenceRead],
    ["context hook", contextHookFence.withFlowRecoveryFenceRead],
  ]) {
    const value = fixture();
    const sentinel = new Error(`${name} stable callback sentinel`);
    try {
      fs.writeFileSync(value.file, `${JSON.stringify(fence(value.runId))}\n`, { mode: 0o600 });
      assert.throws(
        () => wrapper(value.projectRoot, value.runId, () => {
          throw sentinel;
        }),
        (error) => {
          assert.equal(error, sentinel, name);
          return true;
        },
      );
    } finally {
      fs.rmSync(value.projectRoot, { recursive: true, force: true });
    }
  }
});

test("all asynchronous fence wrappers preserve a callback error while the fence stays stable", async () => {
  for (const [name, wrapper] of [
    ["Flow Agents", withFlowRunRecoveryFenceReadAsync],
    ["source hook", hookFence.withFlowRecoveryFenceReadAsync],
    ["context hook", contextHookFence.withFlowRecoveryFenceReadAsync],
  ]) {
    const value = fixture();
    const sentinel = new Error(`${name} stable async callback sentinel`);
    try {
      fs.writeFileSync(value.file, `${JSON.stringify(fence(value.runId))}\n`, { mode: 0o600 });
      await assert.rejects(
        () => wrapper(value.projectRoot, value.runId, async () => {
          throw sentinel;
        }),
        (error) => {
          assert.equal(error, sentinel, name);
          return true;
        },
      );
    } finally {
      fs.rmSync(value.projectRoot, { recursive: true, force: true });
    }
  }
});

test("fence readers reject symlinked fixed Flow ancestry before treating the fence as absent", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-fence-ancestry-"));
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-fence-foreign-"));
  try {
    fs.mkdirSync(path.join(projectRoot, ".kontourai"), { recursive: true });
    fs.symlinkSync(foreign, path.join(projectRoot, ".kontourai", "flow"));
    assert.throws(() => assertFlowRunRecoveryFenceOpen(projectRoot, "run-1"), /ancestry is unsafe/);
    assert.throws(() => withNarrativeFlowRunRecoveryFenceRead(projectRoot, "run-1", () => null), /ancestry is unsafe/);
    assert.throws(() => hookFence.withFlowRecoveryFenceRead(projectRoot, "run-1", () => null), /ancestry is unsafe/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(foreign, { recursive: true, force: true });
  }
});
