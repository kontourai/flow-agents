import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

import { bindHostWorkflowSession } from "../../build/src/index.js";

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
