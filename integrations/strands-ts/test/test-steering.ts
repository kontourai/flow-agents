/**
 * test-steering.ts — Tests for FlowAgentsHooks.steeringContext() kit flow surfacing.
 *
 * Issue #32 AC2: steering context surfaces activated kit flows from the
 * strands-local runtime path (.flow-agents/runtime/strands/flows/).
 *
 * Fixture approach: write fake *.flow.json files (same structure as the real
 * kit flow files produced by activateStrandsLocal) and assert the steering
 * context text contains kit flow ids and descriptions.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FlowAgentsHooks } from "../src/hooks.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fa-ts-steering-"));
}

function writeFlow(
  workspace: string,
  kitId: string,
  assetId: string,
  description = ""
): void {
  const flowsDir = path.join(
    workspace,
    ".flow-agents",
    "runtime",
    "strands",
    "flows",
    kitId
  );
  fs.mkdirSync(flowsDir, { recursive: true });
  const safeName = assetId.replace(/\./g, "-");
  fs.writeFileSync(
    path.join(flowsDir, `${safeName}.flow.json`),
    JSON.stringify({ id: assetId, description }),
    "utf8"
  );
}

describe("FlowAgentsHooks.steeringContext() — kit flow surfacing (Issue #32 AC2)", () => {
  test("empty string when no runtime strands dir exists", () => {
    const tmpDir = makeTmpDir();
    try {
      const hooks = new FlowAgentsHooks({ workspace: tmpDir });
      const ctx = hooks.steeringContext();
      assert.strictEqual(ctx, "", "Expected empty steering context with no runtime dir");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("KIT FLOWS hint appears when a flow file exists", () => {
    const tmpDir = makeTmpDir();
    try {
      writeFlow(tmpDir, "builder", "builder.shape", "Shape a problem.");
      const hooks = new FlowAgentsHooks({ workspace: tmpDir });
      const ctx = hooks.steeringContext();
      assert.ok(ctx.includes("KIT FLOWS"), `Expected 'KIT FLOWS' in context, got: ${ctx}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("flow asset_id appears in steering context", () => {
    const tmpDir = makeTmpDir();
    try {
      writeFlow(tmpDir, "builder", "builder.shape", "Shape a problem.");
      const hooks = new FlowAgentsHooks({ workspace: tmpDir });
      const ctx = hooks.steeringContext();
      assert.ok(
        ctx.includes("builder.shape"),
        `Expected 'builder.shape' in context, got: ${ctx}`
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("flow description appears in steering context", () => {
    const tmpDir = makeTmpDir();
    try {
      writeFlow(tmpDir, "builder", "builder.build", "Build a feature end-to-end.");
      const hooks = new FlowAgentsHooks({ workspace: tmpDir });
      const ctx = hooks.steeringContext();
      assert.ok(
        ctx.includes("Build a feature end-to-end."),
        `Expected description in context, got: ${ctx}`
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("multiple flows all listed in steering context", () => {
    const tmpDir = makeTmpDir();
    try {
      writeFlow(tmpDir, "builder", "builder.shape", "Shape.");
      writeFlow(tmpDir, "builder", "builder.build", "Build.");
      const hooks = new FlowAgentsHooks({ workspace: tmpDir });
      const ctx = hooks.steeringContext();
      assert.ok(ctx.includes("builder.shape"), "Expected builder.shape in context");
      assert.ok(ctx.includes("builder.build"), "Expected builder.build in context");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("malformed flow JSON does not crash; other flows still listed", () => {
    const tmpDir = makeTmpDir();
    try {
      writeFlow(tmpDir, "builder", "builder.shape", "Shape.");
      // Write a malformed flow file
      const flowsDir = path.join(
        tmpDir,
        ".flow-agents",
        "runtime",
        "strands",
        "flows",
        "builder"
      );
      fs.writeFileSync(path.join(flowsDir, "bad.flow.json"), "{ not valid json", "utf8");
      const hooks = new FlowAgentsHooks({ workspace: tmpDir });
      const ctx = hooks.steeringContext();
      // builder.shape should still appear
      assert.ok(ctx.includes("builder.shape"), "Expected builder.shape despite bad file");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("steering context wraps with --- delimiters", () => {
    const tmpDir = makeTmpDir();
    try {
      writeFlow(tmpDir, "builder", "builder.shape", "Shape.");
      const hooks = new FlowAgentsHooks({ workspace: tmpDir });
      const ctx = hooks.steeringContext();
      assert.ok(ctx.includes("---"), "Expected --- delimiters in context");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns string type (even empty)", () => {
    const tmpDir = makeTmpDir();
    try {
      const hooks = new FlowAgentsHooks({ workspace: tmpDir });
      const ctx = hooks.steeringContext();
      assert.strictEqual(typeof ctx, "string");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
