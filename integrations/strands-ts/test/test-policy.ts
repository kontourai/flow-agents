/**
 * test-policy.ts — Tests for policy module and registry wiring.
 *
 * Covers:
 *   - Policy gate block/allow via pure-TS fallback
 *   - Config-protection block through THE REAL ENGINE (native import, no mocks)
 *   - Registry wiring with a fake registry
 *   - PROTECTED_FILES constant
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PolicyGate, PROTECTED_FILES } from "../src/policy.js";
import { FlowAgentsHooks } from "../src/hooks.js";
import type { HookRegistry, StrandsEvent } from "../src/hooks.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Walk up from __dirname to find the repo root (contains scripts/hooks/run-hook.js).
// Works for both source (test/) and compiled (dist/test/) layouts.
function findRepoRoot(start: string): string | null {
  let current = start;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(current, "scripts", "hooks", "run-hook.js"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

const repoRoot = findRepoRoot(__dirname) ?? "";
const runHookPath = repoRoot ? path.join(repoRoot, "scripts", "hooks", "run-hook.js") : "";
const engineAvailableInRepo = Boolean(repoRoot) && fs.existsSync(runHookPath);

// ---------------------------------------------------------------------------
// PROTECTED_FILES constant
// ---------------------------------------------------------------------------

describe("PROTECTED_FILES constant", () => {
  test("contains expected protected file basenames", () => {
    const expected = [
      ".eslintrc.json",
      "biome.json",
      "prettier.config.js",
      ".prettierrc",
      "ruff.toml",
      ".markdownlint.json",
    ];
    for (const fname of expected) {
      assert.ok(PROTECTED_FILES.has(fname), `Expected PROTECTED_FILES to contain ${fname}`);
    }
  });

  test("does not contain regular source files", () => {
    assert.ok(!PROTECTED_FILES.has("package.json"));
    assert.ok(!PROTECTED_FILES.has("src/main.ts"));
    assert.ok(!PROTECTED_FILES.has("README.md"));
  });
});

// ---------------------------------------------------------------------------
// PolicyGate — pure-TS fallback (engine root nonexistent)
// ---------------------------------------------------------------------------

describe("PolicyGate pure-TS fallback", () => {
  const fallbackGate = new PolicyGate({
    engineRoot: "/nonexistent/path/that/does/not/exist",
    suppressFallbackWarning: true,
  });

  test("blocks write to .eslintrc.json (fallback)", () => {
    const reason = fallbackGate.checkToolCall("write", { path: "/repo/.eslintrc.json" });
    assert.ok(reason !== null, "Expected block reason");
    assert.ok(reason.includes("BLOCKED"));
    assert.ok(reason.includes(".eslintrc.json"));
  });

  test("allows write to regular file (fallback)", () => {
    const reason = fallbackGate.checkToolCall("write", { path: "src/main.ts" });
    assert.strictEqual(reason, null);
  });

  test("allows read on protected file (fallback - tool-name pre-filter)", () => {
    const reason = fallbackGate.checkToolCall("read", { path: ".eslintrc.json" });
    assert.strictEqual(reason, null);
  });

  test("allows write without path (fallback)", () => {
    const reason = fallbackGate.checkToolCall("write", {});
    assert.strictEqual(reason, null);
  });

  test("blocks edit to biome.json via file_path key (fallback)", () => {
    const reason = fallbackGate.checkToolCall("edit", { file_path: "biome.json" });
    assert.ok(reason !== null);
    assert.ok(reason.includes("biome.json"));
  });

  test("blocks all canonical protected files (fallback)", () => {
    for (const fname of PROTECTED_FILES) {
      const reason = fallbackGate.checkToolCall("write", { path: `/repo/${fname}` });
      assert.ok(reason !== null, `Expected ${fname} to be blocked`);
      assert.ok(reason.includes("BLOCKED"), `Block reason for ${fname} missing BLOCKED`);
    }
  });
});

// ---------------------------------------------------------------------------
// PolicyGate — custom protected files
// ---------------------------------------------------------------------------

describe("PolicyGate custom protected files", () => {
  test("custom set blocks custom file, not built-in files", () => {
    const customGate = new PolicyGate({
      customProtectedFiles: new Set(["pyproject.toml"]),
    });
    const blocked = customGate.checkToolCall("write", { path: "pyproject.toml" });
    assert.ok(blocked !== null, "Expected custom set to block pyproject.toml");

    const allowed = customGate.checkToolCall("write", { path: ".eslintrc.json" });
    assert.strictEqual(allowed, null, "Custom set should not block .eslintrc.json");
  });
});

// ---------------------------------------------------------------------------
// PolicyGate — REAL engine via native import (no mocks, no subprocess)
// ---------------------------------------------------------------------------

describe("PolicyGate via real native engine", () => {
  test("engineAvailable is true when repo engine is available", () => {
    if (!engineAvailableInRepo) return;
    const gate = new PolicyGate({ engineRoot: repoRoot });
    assert.ok(gate.engineAvailable, "engineAvailable should be true in repo context");
  });

  test("engineAvailable is false when engineRoot is invalid", () => {
    const gate = new PolicyGate({
      engineRoot: "/nonexistent/path",
      suppressFallbackWarning: true,
    });
    assert.ok(!gate.engineAvailable, "engineAvailable should be false with invalid path");
  });

  test("blocks write to .eslintrc.json via native engine", () => {
    if (!engineAvailableInRepo) return;
    const gate = new PolicyGate({ engineRoot: repoRoot });
    const reason = gate.checkToolCall("write", { path: "/repo/.eslintrc.json" });
    assert.ok(reason !== null, "Native engine should block .eslintrc.json write");
    assert.ok(reason.includes("BLOCKED"), "Block reason should contain BLOCKED");
    assert.ok(reason.includes(".eslintrc.json"), "Block reason should mention file");
  });

  test("allows write to src/main.ts via native engine", () => {
    if (!engineAvailableInRepo) return;
    const gate = new PolicyGate({ engineRoot: repoRoot });
    const reason = gate.checkToolCall("write", { path: "src/main.ts" });
    assert.strictEqual(reason, null, "Native engine should allow src/main.ts");
  });

  test("allows read on .eslintrc.json (tool-name pre-filter, no engine call)", () => {
    if (!engineAvailableInRepo) return;
    const gate = new PolicyGate({ engineRoot: repoRoot });
    const reason = gate.checkToolCall("read", { path: ".eslintrc.json" });
    assert.strictEqual(reason, null, "Read tool should never be blocked");
  });

  test("blocks edit to biome.json via file_path key via native engine", () => {
    if (!engineAvailableInRepo) return;
    const gate = new PolicyGate({ engineRoot: repoRoot });
    const reason = gate.checkToolCall("edit", { file_path: "biome.json" });
    assert.ok(reason !== null, "Should block biome.json edit");
    assert.ok(reason.includes("biome.json"));
  });
});

// ---------------------------------------------------------------------------
// FlowAgentsHooks — registry wiring with a fake registry
// ---------------------------------------------------------------------------

describe("FlowAgentsHooks registry wiring (fake registry)", () => {
  test("registerHooks calls addCallback for expected events or throws ImportError", () => {
    const hooks = new FlowAgentsHooks({ engineRoot: repoRoot });

    const registered: Array<{ eventClass: unknown; callback: unknown }> = [];
    const fakeRegistry: HookRegistry = {
      addCallback(eventClass, callback) {
        registered.push({ eventClass, callback });
      },
    };

    // Without strands-agents installed this throws; both outcomes are acceptable.
    try {
      hooks.registerHooks(fakeRegistry);
      // If SDK is installed, we should have callbacks
      assert.ok(registered.length >= 1, "Expected at least one addCallback call");
    } catch (err) {
      assert.ok(err instanceof Error);
      const msg = (err as Error).message;
      assert.ok(
        msg.includes("strands-agents") || msg.includes("Cannot find module"),
        `Expected error about strands-agents, got: ${msg}`
      );
    }
  });

  test("onBeforeInvocation emits turn.user event", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fa-ts-reg-"));
    try {
      const hooks = new FlowAgentsHooks({ sinkPath: tmpDir, engineRoot: repoRoot });
      hooks.onBeforeInvocation({});
      const events = fs
        .readFileSync(path.join(tmpDir, "full.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      assert.ok(events.some((e) => e.event_type === "turn.user"), "Expected turn.user event");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("onAfterInvocation emits session.end event", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fa-ts-reg2-"));
    try {
      const hooks = new FlowAgentsHooks({ sinkPath: tmpDir, engineRoot: repoRoot });
      hooks.onAfterInvocation({});
      const events = fs
        .readFileSync(path.join(tmpDir, "full.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      assert.ok(events.some((e) => e.event_type === "session.end"), "Expected session.end event");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("onBeforeToolCall emits tool.invoke event", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fa-ts-reg3-"));
    try {
      const hooks = new FlowAgentsHooks({ sinkPath: tmpDir, engineRoot: repoRoot });
      const event: StrandsEvent = { toolName: "bash", toolInput: { command: "ls" } };
      hooks.onBeforeToolCall(event);
      const events = fs
        .readFileSync(path.join(tmpDir, "full.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      assert.ok(events.some((e) => e.event_type === "tool.invoke"), "Expected tool.invoke event");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("onAfterToolCall emits tool.result event", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fa-ts-reg4-"));
    try {
      const hooks = new FlowAgentsHooks({ sinkPath: tmpDir, engineRoot: repoRoot });
      const event: StrandsEvent = { toolName: "read", result: "file contents" };
      hooks.onAfterToolCall(event);
      const events = fs
        .readFileSync(path.join(tmpDir, "full.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      assert.ok(events.some((e) => e.event_type === "tool.result"), "Expected tool.result event");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Config-protection block THROUGH THE REAL ENGINE (native call, no mocks)
  // -------------------------------------------------------------------------

  test("config-protection block: event.cancel set for protected write (REAL ENGINE)", () => {
    if (!engineAvailableInRepo) return;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fa-ts-block-"));
    try {
      const hooks = new FlowAgentsHooks({ sinkPath: tmpDir, engineRoot: repoRoot });
      const event: StrandsEvent = {
        toolName: "write",
        toolInput: { path: "/repo/.eslintrc.json" },
      };
      hooks.onBeforeToolCall(event);
      assert.ok(
        typeof event.cancel === "string" && event.cancel.includes("BLOCKED"),
        `Expected event.cancel to contain BLOCKED, got: ${JSON.stringify(event.cancel)}`
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("config-protection allow: event.cancel NOT set for safe write (REAL ENGINE)", () => {
    if (!engineAvailableInRepo) return;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fa-ts-allow-"));
    try {
      const hooks = new FlowAgentsHooks({ sinkPath: tmpDir, engineRoot: repoRoot });
      const event: StrandsEvent = {
        toolName: "write",
        toolInput: { path: "src/main.ts" },
      };
      hooks.onBeforeToolCall(event);
      assert.strictEqual(event.cancel, undefined, "Expected no cancel for safe file");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
