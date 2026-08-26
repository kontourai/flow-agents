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
import { spawnSync } from "node:child_process";

import {
  detectRuntimeFromProcessEnv,
  detectRuntimeFromFilesystem,
  detectDefaultRuntime,
  rewriteCommandForGlobalInstall,
} from "../../build/src/cli/init.js";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

function fakeHome() {
  return makeFixtureDir("init-detect-home-");
}

function installRecord(dest) {
  return JSON.parse(fs.readFileSync(path.join(dest, ".flow-agents", "install.json"), "utf8"));
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
  const codexHome = makeFixtureDir("init-detect-codexhome-");
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

test("init headless: no kit selection records zero active kits", () => {
  const dest = makeFixtureDir("flow-agents-init-no-kits-");
  const result = spawnSync(process.execPath, ["build/src/cli.js", "init", "--runtime", "base", "--dest", dest, "--telemetry-sink", "local-files", "--yes"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(installRecord(dest).active_kit_ids, []);
});

test("init headless: --activate-kit selects a non-Builder catalog kit without activating Builder", () => {
  const dest = makeFixtureDir("flow-agents-init-one-kit-");
  const result = spawnSync(process.execPath, ["build/src/cli.js", "init", "--runtime", "codex", "--dest", dest, "--telemetry-sink", "local-files", "--activate-kit", "release-evidence", "--yes"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(installRecord(dest).active_kit_ids, ["release-evidence"]);
  const activation = JSON.parse(fs.readFileSync(path.join(dest, ".kontourai", "flow-agents", "projections", "codex", "activation.json"), "utf8"));
  const activatedKitIds = new Set((activation.generated_runtime_files ?? []).map((entry) => entry.kit_id));
  assert.equal(activatedKitIds.has("release-evidence"), true);
  assert.equal(activatedKitIds.has("builder"), false);
});

test("init headless: --activate-kit auto-includes declared kit dependencies", () => {
  const dest = makeFixtureDir("flow-agents-init-kit-deps-");
  const result = spawnSync(process.execPath, ["build/src/cli.js", "init", "--runtime", "codex", "--dest", dest, "--telemetry-sink", "local-files", "--activate-kit", "builder", "--yes"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(installRecord(dest).active_kit_ids, ["builder"]);
  const activation = JSON.parse(fs.readFileSync(path.join(dest, ".kontourai", "flow-agents", "projections", "codex", "activation.json"), "utf8"));
  const activatedKitIds = new Set((activation.generated_runtime_files ?? []).map((entry) => entry.kit_id));
  assert.equal(activatedKitIds.has("builder"), true);
  assert.equal(activatedKitIds.has("knowledge"), true);
  assert.deepEqual(activation.errors ?? [], []);
});

// ── #945 SEC: global-install command rewriting must escape for the quoting
// context the substitution site is actually in.
//
// Today every emitted claude-code hook/statusLine command is a `bash -lc '…'`
// wrapper whose script path sits in double quotes NESTED inside that outer
// single-quoted argument, so the substituted root needs both layers escaped.
// #1101 removes the wrapper (hooks become exec-form `args` vectors that never
// reach a shell; statusLine becomes a bare `node "…"` shell string with ONE
// layer). Applying the outer `'\''` transform to a single-layer string is not
// inert -- it writes literal quote characters into the path -- so the layer is
// derived from the command rather than assumed. Both branches are exercised
// below by EXECUTING the rewritten command, not just matching its text.

function execRewritten(command, sourceRoot, cwd) {
  const rewritten = rewriteCommandForGlobalInstall(command, sourceRoot);
  const result = spawnSync(rewritten, { shell: true, cwd, encoding: "utf8", timeout: 30000 });
  return { rewritten, result };
}

/** A directory whose name breaks naive single-quoting, plus a probe script inside it. */
function apostropheRootFixture(prefix) {
  const base = makeFixtureDir(prefix);
  const root = path.join(base, "o'brien; touch INJECTED; echo 'x");
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts", "probe.js"), "console.log('PROBE_RAN');\n", "utf8");
  return { base, root };
}

test("#945 SEC: nested bash -lc command escapes both quoting layers, runs, and injects nothing", () => {
  const { base, root } = apostropheRootFixture("init-rewrite-nested-");
  const command = `bash -lc 'root="\${CLAUDE_PROJECT_DIR:-$(pwd)}"; node "$root/scripts/probe.js"'`;
  const { rewritten, result } = execRewritten(command, root, base);

  // The outer single-quoted layer is present, so the outer transform must apply.
  assert.match(rewritten, /'\\''/, `expected outer single-quote escaping in: ${rewritten}`);
  assert.equal(result.status, 0, `rewritten command failed: ${rewritten}\n${result.stderr}`);
  assert.match(result.stdout, /PROBE_RAN/, `escaped path did not resolve: ${rewritten}\n${result.stderr}`);
  assert.equal(fs.existsSync(path.join(base, "INJECTED")), false, "injected shell executed");
  assert.equal(fs.existsSync(path.join(root, "INJECTED")), false, "injected shell executed");
});

test("#945 SEC: single-layer shell string (the #1101 statusLine shape) escapes ONE layer and still resolves", () => {
  const { base, root } = apostropheRootFixture("init-rewrite-single-");
  // No `bash -lc '…'` wrapper: one double-quoted layer only.
  const command = `node "$root/scripts/probe.js"`;
  const { rewritten, result } = execRewritten(command, root, base);

  // Applying the outer transform here would put literal `'\''` into the path.
  assert.doesNotMatch(rewritten, /'\\''/, `outer escaping wrongly applied to a single-layer command: ${rewritten}`);
  assert.equal(result.status, 0, `rewritten command failed: ${rewritten}\n${result.stderr}`);
  assert.match(result.stdout, /PROBE_RAN/, `escaped path did not resolve: ${rewritten}\n${result.stderr}`);
  assert.equal(fs.existsSync(path.join(base, "INJECTED")), false, "injected shell executed");
  assert.equal(fs.existsSync(path.join(root, "INJECTED")), false, "injected shell executed");
});

test("#945 SEC: a benign path is unchanged in both quoting contexts", () => {
  const plain = "/opt/flow-agents/runtime";
  assert.equal(
    rewriteCommandForGlobalInstall(`bash -lc 'node "$root/scripts/probe.js"'`, plain),
    `bash -lc 'node "${plain}/scripts/probe.js"'`,
  );
  assert.equal(
    rewriteCommandForGlobalInstall(`node "$root/scripts/probe.js"`, plain),
    `node "${plain}/scripts/probe.js"`,
  );
});
