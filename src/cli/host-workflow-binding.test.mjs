import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire, syncBuiltinESMExports } from "node:module";

import { bindHostWorkflowSession, retireHostWorkflowSession } from "../../build/src/index.js";

const require = createRequire(import.meta.url);
const pointers = require("../../scripts/hooks/lib/current-pointer.js");

test("bindHostWorkflowSession writes the canonical actor-scoped pointer", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-host-binding-"));
  try {
    const root = path.join(workspace, ".kontourai", "flow-agents");
    const task = path.join(root, "runtime-switch");
    fs.mkdirSync(task, { recursive: true });
    fs.writeFileSync(path.join(task, "state.json"), JSON.stringify({ branch: "agent/station/runtime-switch" }));

    const result = bindHostWorkflowSession({
      artifactRoot: root,
      artifactDir: task,
      actorKey: "station.thread-123",
      owner: "station",
      source: "session-start",
      updatedAt: "2026-07-23T00:00:00.000Z",
      activeFlowId: "builder.build",
      activeStepId: "execute",
    });

    assert.deepEqual(pointers.readOwnCurrentPointer(root, "station.thread-123"), {
      payload: result,
      source: "per-actor",
      file: pointers.perActorCurrentFile(root, "station.thread-123"),
    });
    assert.equal(fs.existsSync(path.join(root, "current.json")), false);
    assert.equal(result.artifact_dir, "runtime-switch");
    assert.equal(result.branch, "agent/station/runtime-switch");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("bindHostWorkflowSession rejects unsafe actor and task boundaries", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-host-binding-invalid-"));
  try {
    const root = path.join(workspace, ".kontourai", "flow-agents");
    const task = path.join(root, "task");
    fs.mkdirSync(task, { recursive: true });
    const base = { artifactRoot: root, artifactDir: task, owner: "host", source: "resume" };
    assert.throws(() => bindHostWorkflowSession({ ...base, actorKey: "a:b" }), /actorKey/);
    assert.throws(
      () => bindHostWorkflowSession({ ...base, artifactRoot: ".kontourai/flow-agents", actorKey: "actor" }),
      /absolute paths/,
    );
    assert.throws(
      () => bindHostWorkflowSession({ ...base, artifactDir: workspace, actorKey: "actor" }),
      /inside artifactRoot/,
    );
    assert.throws(
      () => bindHostWorkflowSession({ ...base, actorKey: "actor", owner: "/tmp/private" }),
      /owner.*without paths or credentials/,
    );
    assert.throws(
      () => bindHostWorkflowSession({ ...base, actorKey: "actor", source: "token=secret-value" }),
      /source.*without paths or credentials/,
    );
    assert.throws(
      () => bindHostWorkflowSession({ ...base, actorKey: "actor", owner: ["github_", "pat_12345678901234567890"].join("") }),
      /owner.*without paths or credentials/,
    );
    assert.throws(
      () => bindHostWorkflowSession({ ...base, actorKey: "actor", updatedAt: "not-a-date" }),
      /updatedAt must be a valid date-time/,
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("bindHostWorkflowSession rejects a task symlink escaping the artifact root", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-host-binding-symlink-"));
  try {
    const root = path.join(workspace, ".kontourai", "flow-agents");
    const outside = path.join(workspace, "outside-task");
    const linkedTask = path.join(root, "linked-task");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(outside);
    try {
      fs.symlinkSync(outside, linkedTask, "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.skip(`directory symlinks unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    assert.throws(
      () =>
        bindHostWorkflowSession({
          artifactRoot: root,
          artifactDir: linkedTask,
          actorKey: "actor",
          owner: "host",
          source: "resume",
        }),
      /inside artifactRoot/,
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("bindHostWorkflowSession rejects a symlinked actor-pointer directory", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-host-binding-current-symlink-"));
  try {
    const root = path.join(workspace, ".kontourai", "flow-agents");
    const task = path.join(root, "task");
    const outside = path.join(workspace, "outside-current");
    fs.mkdirSync(task, { recursive: true });
    fs.mkdirSync(outside);
    try {
      fs.symlinkSync(outside, path.join(root, "current"), "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.skip(`directory symlinks unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    const escapedFile = path.join(
      outside,
      path.basename(pointers.perActorCurrentFile(root, "station.thread-123")),
    );
    fs.writeFileSync(escapedFile, `${JSON.stringify({ active_slug: "outside-task" })}\n`);
    assert.deepEqual(pointers.readOwnCurrentPointer(root, "station.thread-123"), {
      payload: null,
      source: "none",
      file: pointers.perActorCurrentFile(root, "station.thread-123"),
    });
    assert.throws(
      () => bindHostWorkflowSession({
        artifactRoot: root,
        artifactDir: task,
        actorKey: "station.thread-123",
        owner: "station",
        source: "session-start",
      }),
      /current-pointer directory must be a real directory/,
    );
    assert.deepEqual(fs.readdirSync(outside), [path.basename(escapedFile)]);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("bindHostWorkflowSession rejects task-directory replacement after state read", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-host-task-swap-"));
  const realOpenSync = fs.openSync;
  const realReadFileSync = fs.readFileSync;
  let task;
  let savedTask;
  try {
    const root = path.join(workspace, ".kontourai", "flow-agents");
    task = path.join(root, "task");
    savedTask = path.join(root, "task.saved");
    const stateFile = path.join(task, "state.json");
    fs.mkdirSync(task, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ branch: "agent/task" }));
    let stateDescriptor = null;
    fs.openSync = (target, ...args) => {
      const descriptor = realOpenSync(target, ...args);
      if (
        path.basename(String(target)) === "state.json"
        && path.basename(path.dirname(String(target))) === "task"
      ) stateDescriptor = descriptor;
      return descriptor;
    };
    fs.readFileSync = (target, ...args) => {
      const result = realReadFileSync(target, ...args);
      if (typeof target === "number" && stateDescriptor !== null) {
        stateDescriptor = null;
        fs.renameSync(task, savedTask);
        fs.mkdirSync(task);
      }
      return result;
    };
    syncBuiltinESMExports();

    assert.throws(
      () => bindHostWorkflowSession({
        artifactRoot: root,
        artifactDir: task,
        actorKey: "station.thread-123",
        owner: "station",
        source: "session-start",
      }),
      /artifact directories changed/,
    );
    assert.equal(fs.existsSync(pointers.perActorCurrentFile(root, "station.thread-123")), false);
  } finally {
    fs.openSync = realOpenSync;
    fs.readFileSync = realReadFileSync;
    syncBuiltinESMExports();
    if (savedTask && fs.existsSync(savedTask)) {
      fs.rmSync(task, { recursive: true, force: true });
      fs.renameSync(savedTask, task);
    }
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("bindHostWorkflowSession revalidates task identity inside the pointer lock", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-host-task-lock-swap-"));
  const realMkdirSync = fs.mkdirSync;
  let task;
  let savedTask;
  try {
    const root = path.join(workspace, ".kontourai", "flow-agents");
    task = path.join(root, "task");
    savedTask = path.join(root, "task.saved");
    fs.mkdirSync(task, { recursive: true });
    let swapped = false;
    fs.mkdirSync = (target, ...args) => {
      if (!swapped && String(target).endsWith(".actor-pointers.lockdir")) {
        swapped = true;
        fs.renameSync(task, savedTask);
        realMkdirSync(task);
      }
      return realMkdirSync(target, ...args);
    };

    assert.throws(
      () => bindHostWorkflowSession({
        artifactRoot: root,
        artifactDir: task,
        actorKey: "station.thread-123",
        owner: "station",
        source: "session-start",
      }),
      /artifact directories changed/,
    );
    assert.equal(fs.existsSync(pointers.perActorCurrentFile(root, "station.thread-123")), false);
  } finally {
    fs.mkdirSync = realMkdirSync;
    if (savedTask && fs.existsSync(savedTask)) {
      fs.rmSync(task, { recursive: true, force: true });
      fs.renameSync(savedTask, task);
    }
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("current pointer publication rolls back the actor binding when shared publication fails", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-pointer-publication-"));
  try {
    const root = path.join(workspace, ".kontourai", "flow-agents");
    fs.mkdirSync(path.join(root, "current"), { recursive: true });
    fs.mkdirSync(path.join(root, "current.json"));
    assert.throws(
      () => pointers.publishCurrentPointers(root, "station.thread-123", {
        active_slug: "unstarted-task",
      }),
      /current pointer must be a stable regular file/,
    );
    assert.equal(
      fs.existsSync(pointers.perActorCurrentFile(root, "station.thread-123")),
      false,
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("actor pointer reads reject a directory swapped only during descriptor open", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-pointer-read-swap-"));
  const realOpenSync = fs.openSync;
  try {
    const root = path.join(workspace, ".kontourai", "flow-agents");
    const actorRoot = path.join(root, "current");
    const savedActorRoot = path.join(root, "current.saved");
    const outside = path.join(workspace, "outside-current");
    const actor = "station.thread-123";
    const file = pointers.perActorCurrentFile(root, actor);
    fs.mkdirSync(actorRoot, { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(file, `${JSON.stringify({ active_slug: "inside-task" })}\n`);
    fs.writeFileSync(
      path.join(outside, path.basename(file)),
      `${JSON.stringify({ active_slug: "outside-task" })}\n`,
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

    let swapped = false;
    fs.openSync = ((candidate, flags, ...args) => {
      if (!swapped && path.resolve(String(candidate)) === path.resolve(file)) {
        swapped = true;
        fs.renameSync(actorRoot, savedActorRoot);
        fs.symlinkSync(outside, actorRoot, "dir");
        try {
          return realOpenSync(candidate, flags, ...args);
        } finally {
          fs.unlinkSync(actorRoot);
          fs.renameSync(savedActorRoot, actorRoot);
        }
      }
      return realOpenSync(candidate, flags, ...args);
    });

    assert.deepEqual(pointers.readOwnCurrentPointer(root, actor), {
      payload: null,
      source: "none",
      file,
    });
    assert.equal(swapped, true);
  } finally {
    fs.openSync = realOpenSync;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("pointer validation completes before an agent-event append is staged", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-pointer-event-stage-"));
  try {
    const root = path.join(workspace, ".kontourai", "flow-agents");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "current.json"), "{ malformed");
    let staged = 0;
    assert.throws(
      () => pointers.updateCurrentPointersForBinding(
        root,
        undefined,
        "task",
        (payload) => payload,
        () => {
          staged += 1;
          return { rollback: () => {} };
        },
      ),
      SyntaxError,
    );
    assert.equal(staged, 0);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("pointer mutation rejects a lock created under a transiently swapped actor directory", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-pointer-lock-detached-"));
  const realMkdirSync = fs.mkdirSync;
  const realWriteFileSync = fs.writeFileSync;
  try {
    const root = path.join(workspace, ".kontourai", "flow-agents");
    const actorRoot = path.join(root, "current");
    const savedActorRoot = path.join(root, "current.saved");
    const outside = path.join(workspace, "outside-current");
    const actor = "station.thread-123";
    fs.mkdirSync(actorRoot, { recursive: true });
    fs.mkdirSync(outside);
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
    const lockDir = path.join(actorRoot, ".actor-pointers.lockdir");
    const ownerFile = path.join(lockDir, "owner.json");
    fs.mkdirSync = ((target, ...args) => {
      if (path.resolve(String(target)) === path.resolve(lockDir)) {
        fs.renameSync(actorRoot, savedActorRoot);
        fs.symlinkSync(outside, actorRoot, "dir");
      }
      return realMkdirSync(target, ...args);
    });
    fs.writeFileSync = ((target, ...args) => {
      const result = realWriteFileSync(target, ...args);
      if (path.resolve(String(target)) === path.resolve(ownerFile)) {
        fs.unlinkSync(actorRoot);
        fs.renameSync(savedActorRoot, actorRoot);
      }
      return result;
    });

    assert.throws(
      () => pointers.writePerActorCurrent(root, actor, { active_slug: "task" }),
    );
    assert.equal(fs.existsSync(pointers.perActorCurrentFile(root, actor)), false);
  } finally {
    fs.mkdirSync = realMkdirSync;
    fs.writeFileSync = realWriteFileSync;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("pointer transaction restores every pointer when its state commit fails", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-pointer-transaction-rollback-"));
  try {
    const root = path.join(workspace, ".kontourai", "flow-agents");
    const actor = "station.thread-123";
    const original = {
      active_slug: "task",
      artifact_dir: "nested/task",
      active_step_id: "execute",
    };
    pointers.publishCurrentPointers(root, actor, original);
    const globalFile = path.join(root, "current.json");
    const actorFile = pointers.perActorCurrentFile(root, actor);
    const globalRaw = fs.readFileSync(globalFile, "utf8");
    const actorRaw = fs.readFileSync(actorFile, "utf8");
    const replacements = [globalFile, actorFile].map((file) => ({
      file,
      expectedRaw: fs.readFileSync(file, "utf8"),
      payload: { ...original, active_step_id: "verify" },
    }));
    assert.throws(
      () => pointers.replaceCurrentPointersIfUnchanged(
        root,
        replacements,
        {
          expectedGlobalRaw: globalRaw,
          expectedActorEntries: [path.basename(actorFile)],
        },
        () => {
          assert.equal(fs.readFileSync(globalFile, "utf8"), globalRaw);
          assert.equal(fs.readFileSync(actorFile, "utf8"), actorRaw);
          throw new Error("state commit failed");
        },
      ),
      /state commit failed/,
    );
    assert.equal(fs.readFileSync(globalFile, "utf8"), globalRaw);
    assert.equal(fs.readFileSync(actorFile, "utf8"), actorRaw);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("pointer mutation rejects actor-directory replacement after lock acquisition", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-pointer-parent-replacement-"));
  const realOpenSync = fs.openSync;
  try {
    const root = path.join(workspace, ".kontourai", "flow-agents");
    const actorRoot = path.join(root, "current");
    const savedActorRoot = path.join(root, "current.saved");
    const actor = "station.thread-123";
    const original = {
      active_slug: "task",
      artifact_dir: "task",
      active_step_id: "execute",
    };
    pointers.writePerActorCurrent(root, actor, original);
    const actorFile = pointers.perActorCurrentFile(root, actor);
    const originalRaw = fs.readFileSync(actorFile, "utf8");
    let replaced = false;
    fs.openSync = (target, ...args) => {
      if (!replaced && String(target).includes(".tmp-")) {
        replaced = true;
        fs.renameSync(actorRoot, savedActorRoot);
        fs.mkdirSync(actorRoot);
      }
      return realOpenSync(target, ...args);
    };

    assert.throws(
      () => pointers.writePerActorCurrent(root, actor, {
        ...original,
        active_step_id: "verify",
      }),
      /changed while its (?:mutation )?lock was held/,
    );
    assert.equal(fs.readFileSync(path.join(savedActorRoot, path.basename(actorFile)), "utf8"), originalRaw);
  } finally {
    fs.openSync = realOpenSync;
    const actorRoot = path.join(workspace, ".kontourai", "flow-agents", "current");
    const savedActorRoot = path.join(workspace, ".kontourai", "flow-agents", "current.saved");
    if (fs.existsSync(savedActorRoot)) {
      fs.rmSync(actorRoot, { recursive: true, force: true });
      fs.renameSync(savedActorRoot, actorRoot);
    }
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("failed pointer-lock initialization never deletes a successor lock", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-pointer-lock-successor-"));
  const realWriteFileSync = fs.writeFileSync;
  try {
    const root = path.join(workspace, ".kontourai", "flow-agents");
    const actor = "station.thread-123";
    const actorFile = pointers.perActorCurrentFile(root, actor);
    const lockDir = `${path.join(root, "current", ".actor-pointers")}.lockdir`;
    const ownerFile = path.join(lockDir, "owner.json");
    let replaced = false;
    fs.writeFileSync = (target, ...args) => {
      if (!replaced && path.resolve(String(target)) === path.resolve(ownerFile)) {
        replaced = true;
        fs.rmSync(lockDir, { recursive: true, force: true });
        fs.mkdirSync(lockDir, { recursive: true });
        realWriteFileSync(ownerFile, `${JSON.stringify({ token: "successor" })}\n`);
        throw Object.assign(new Error("injected pointer lock initialization failure"), { code: "EIO" });
      }
      return realWriteFileSync(target, ...args);
    };
    assert.throws(
      () => pointers.writePerActorCurrent(root, actor, { active_slug: "task", artifact_dir: "task" }),
      /injected pointer lock initialization failure/,
    );
    assert.equal(JSON.parse(fs.readFileSync(ownerFile, "utf8")).token, "successor");
    assert.equal(fs.existsSync(actorFile), false);
  } finally {
    fs.writeFileSync = realWriteFileSync;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("failed pointer-lock owner creation removes its own empty lock", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-pointer-lock-owner-failure-"));
  const realWriteFileSync = fs.writeFileSync;
  try {
    const root = path.join(workspace, ".kontourai", "flow-agents");
    const actor = "station.thread-123";
    const lockDir = path.join(root, "current", ".actor-pointers.lockdir");
    const ownerFile = path.join(lockDir, "owner.json");
    fs.writeFileSync = (target, ...args) => {
      if (path.resolve(String(target)) === path.resolve(ownerFile)) {
        throw Object.assign(new Error("injected pointer owner failure"), { code: "EIO" });
      }
      return realWriteFileSync(target, ...args);
    };
    assert.throws(
      () => pointers.writePerActorCurrent(root, actor, { active_slug: "task", artifact_dir: "task" }),
      /injected pointer owner failure/,
    );
    assert.equal(fs.existsSync(lockDir), false);
  } finally {
    fs.writeFileSync = realWriteFileSync;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("pointer transaction rejects a binding added after discovery", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-pointer-discovery-race-"));
  try {
    const root = path.join(workspace, ".kontourai", "flow-agents");
    const actorRoot = path.join(root, "current");
    fs.mkdirSync(actorRoot, { recursive: true });
    fs.writeFileSync(path.join(root, "current.json"), `${JSON.stringify({
      active_slug: "task",
      artifact_dir: "task",
    })}\n`);
    fs.writeFileSync(path.join(actorRoot, "late.json"), `${JSON.stringify({
      active_slug: "task",
      artifact_dir: "task",
    })}\n`);
    let committed = false;
    assert.equal(
      pointers.replaceCurrentPointersIfUnchanged(
        root,
        [],
        {
          expectedGlobalRaw: fs.readFileSync(path.join(root, "current.json"), "utf8"),
          expectedActorEntries: [],
        },
        () => { committed = true; },
      ),
      "changed",
    );
    assert.equal(committed, false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("retirement uses root-relative task identity when basenames collide", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-binding-relative-identity-"));
  try {
    const root = path.join(workspace, ".kontourai", "flow-agents");
    const first = path.join(root, "first", "task");
    const second = path.join(root, "second", "task");
    fs.mkdirSync(first, { recursive: true });
    fs.mkdirSync(second, { recursive: true });
    const binding = bindHostWorkflowSession({
      artifactRoot: root,
      artifactDir: first,
      actorKey: "station.thread-123",
      owner: "station",
      source: "session-start",
    });
    assert.equal(
      retireHostWorkflowSession({
        artifactRoot: root,
        artifactDir: second,
        actorKey: "station.thread-123",
        bindingId: binding.binding_id,
        reason: "wrong-task",
      }),
      "not-bound",
    );
    assert.equal(
      pointers.readOwnCurrentPointer(root, "station.thread-123").payload.artifact_dir,
      path.join("first", "task"),
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("retireHostWorkflowSession supersedes only the actor's matching task binding", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-host-retire-"));
  try {
    const root = path.join(workspace, ".kontourai", "flow-agents");
    const task = path.join(root, "runtime-switch");
    const other = path.join(root, "other-task");
    fs.mkdirSync(task, { recursive: true });
    fs.mkdirSync(other);
    const binding = bindHostWorkflowSession({
      artifactRoot: root,
      artifactDir: task,
      actorKey: "station.thread-123",
      owner: "station",
      source: "session-start",
    });

    assert.equal(retireHostWorkflowSession({
      artifactRoot: root,
      artifactDir: other,
      actorKey: "station.thread-123",
      bindingId: binding.binding_id,
      reason: "wrong-task",
    }), "not-bound");
    assert.equal(retireHostWorkflowSession({
      artifactRoot: root,
      artifactDir: task,
      actorKey: "station.thread-123",
      bindingId: binding.binding_id,
      reason: "session-ended",
      updatedAt: "2026-07-24T01:00:00.000Z",
    }), "retired");
    fs.writeFileSync(path.join(root, "current.json"), `${JSON.stringify({
      active_slug: "unrelated-global",
    })}\n`);
    assert.deepEqual(pointers.readOwnCurrentPointer(root, "station.thread-123"), {
      payload: null,
      source: "none",
      file: pointers.perActorCurrentFile(root, "station.thread-123"),
    });
    assert.deepEqual(pointers.readCurrentPointer(root, "station.thread-123"), {
      payload: null,
      source: "none",
      file: pointers.perActorCurrentFile(root, "station.thread-123"),
    });
    const retired = JSON.parse(
      fs.readFileSync(pointers.perActorCurrentFile(root, "station.thread-123"), "utf8"),
    );
    assert.equal(retired.active_slug, "runtime-switch");
    assert.equal(retired.binding_status, "retired");
    assert.equal(retired.binding_reason, "session-ended");
    assert.equal(retired.updated_at, "2026-07-24T01:00:00.000Z");
    fs.writeFileSync(
      pointers.legacyPerActorCurrentFile(root, "station.thread-123"),
      `${JSON.stringify({ active_slug: "revived-legacy" })}\n`,
    );
    fs.writeFileSync(
      pointers.perActorCurrentFile(root, "station.thread-123"),
      "{corrupt retirement marker",
    );
    assert.deepEqual(pointers.readOwnCurrentPointer(root, "station.thread-123"), {
      payload: null,
      source: "none",
      file: pointers.perActorCurrentFile(root, "station.thread-123"),
    });
    assert.equal(retireHostWorkflowSession({
      artifactRoot: root,
      artifactDir: task,
      actorKey: "station.thread-123",
      bindingId: binding.binding_id,
      reason: "duplicate-end",
    }), "not-bound");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("stale retirement cannot retire a newer binding of the same task", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-host-stale-retire-"));
  try {
    const root = path.join(workspace, ".kontourai", "flow-agents");
    const task = path.join(root, "same-task");
    fs.mkdirSync(task, { recursive: true });
    const prior = bindHostWorkflowSession({
      artifactRoot: root,
      artifactDir: task,
      actorKey: "station.thread-123",
      owner: "station",
      source: "session-start",
    });
    const current = bindHostWorkflowSession({
      artifactRoot: root,
      artifactDir: task,
      actorKey: "station.thread-123",
      owner: "station",
      source: "session-resume",
    });

    assert.notEqual(current.binding_id, prior.binding_id);
    assert.equal(retireHostWorkflowSession({
      artifactRoot: root,
      artifactDir: task,
      actorKey: "station.thread-123",
      bindingId: prior.binding_id,
      reason: "stale-session-end",
    }), "changed");
    assert.equal(
      pointers.readOwnCurrentPointer(root, "station.thread-123").payload.binding_id,
      current.binding_id,
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
