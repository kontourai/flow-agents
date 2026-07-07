// Unit tests for the runtime auto-detection helpers in src/cli/init.ts (AC1,
// install-flow-foundations Thread A): detectRuntimeFromProcessEnv,
// detectRuntimeFromFilesystem, detectDefaultRuntime.
//
// Loaded from the built JS (mirrors src/cli/sidecar-pure-helpers.test.mjs's
// import-from-build convention). Run: `npm run test:unit`, or directly after
// `npm run build`:
//   node --test src/cli/init.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  detectRuntimeFromProcessEnv,
  detectRuntimeFromFilesystem,
  detectDefaultRuntime,
} from "../../build/src/cli/init.js";

function fakeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "init-detect-home-"));
}

// --- detectRuntimeFromProcessEnv ---

test("detectRuntimeFromProcessEnv: CLAUDECODE=1 detects claude-code", () => {
  assert.equal(detectRuntimeFromProcessEnv({ CLAUDECODE: "1" }), "claude-code");
});

test("detectRuntimeFromProcessEnv: CLAUDE_CODE_SESSION_ID detects claude-code", () => {
  assert.equal(detectRuntimeFromProcessEnv({ CLAUDE_CODE_SESSION_ID: "sess-1" }), "claude-code");
});

test("detectRuntimeFromProcessEnv: CODEX_SESSION_ID detects codex", () => {
  assert.equal(detectRuntimeFromProcessEnv({ CODEX_SESSION_ID: "sess-1" }), "codex");
});

test("detectRuntimeFromProcessEnv: OPENCODE_SESSION_ID detects opencode", () => {
  assert.equal(detectRuntimeFromProcessEnv({ OPENCODE_SESSION_ID: "sess-1" }), "opencode");
});

test("detectRuntimeFromProcessEnv: PI_SESSION_ID is out of scope, maps to unknown", () => {
  assert.equal(detectRuntimeFromProcessEnv({ PI_SESSION_ID: "sess-1" }), "unknown");
});

test("detectRuntimeFromProcessEnv: no signals returns unknown", () => {
  assert.equal(detectRuntimeFromProcessEnv({}), "unknown");
});

// --- detectRuntimeFromFilesystem ---

test("detectRuntimeFromFilesystem: exactly one candidate dir (.claude) detects claude-code", () => {
  const home = fakeHome();
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  assert.equal(detectRuntimeFromFilesystem(home, {}), "claude-code");
});

test("detectRuntimeFromFilesystem: exactly one candidate dir (.codex) detects codex", () => {
  const home = fakeHome();
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  assert.equal(detectRuntimeFromFilesystem(home, {}), "codex");
});

test("detectRuntimeFromFilesystem: exactly one candidate dir (opencode global config) detects opencode", () => {
  const home = fakeHome();
  fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
  assert.equal(detectRuntimeFromFilesystem(home, {}), "opencode");
});

test("detectRuntimeFromFilesystem: two candidate dirs present is ambiguous, returns unknown", () => {
  const home = fakeHome();
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  assert.equal(detectRuntimeFromFilesystem(home, {}), "unknown");
});

test("detectRuntimeFromFilesystem: no candidate dirs present returns unknown", () => {
  const home = fakeHome();
  assert.equal(detectRuntimeFromFilesystem(home, {}), "unknown");
});

test("detectRuntimeFromFilesystem: CODEX_HOME override takes precedence over ~/.codex presence", () => {
  const home = fakeHome();
  // ~/.codex does NOT exist; CODEX_HOME points at a directory that DOES exist.
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "init-detect-codexhome-"));
  assert.equal(detectRuntimeFromFilesystem(home, { CODEX_HOME: codexHome }), "codex");
});

test("detectRuntimeFromFilesystem: CODEX_HOME override to a missing dir is not a false positive", () => {
  const home = fakeHome();
  const missingCodexHome = path.join(os.tmpdir(), "init-detect-codexhome-does-not-exist-" + process.pid);
  assert.equal(detectRuntimeFromFilesystem(home, { CODEX_HOME: missingCodexHome }), "unknown");
});

// --- detectDefaultRuntime (layered: env first, then filesystem, then base) ---

test("detectDefaultRuntime: env signal wins even when filesystem would suggest a different runtime", () => {
  const home = fakeHome();
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  assert.equal(detectDefaultRuntime({ CLAUDECODE: "1" }, home), "claude-code");
});

test("detectDefaultRuntime: falls back to filesystem probe when no env signal present", () => {
  const home = fakeHome();
  fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
  assert.equal(detectDefaultRuntime({}, home), "opencode");
});

test("detectDefaultRuntime: no env signal and no filesystem signal falls back to base", () => {
  const home = fakeHome();
  assert.equal(detectDefaultRuntime({}, home), "base");
});

test("detectDefaultRuntime: ambiguous filesystem (2+ dirs) and no env signal falls back to base", () => {
  const home = fakeHome();
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
  assert.equal(detectDefaultRuntime({}, home), "base");
});
