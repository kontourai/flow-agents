// `init --global` and the telemetry-sink / --console-* flags (kontourai/flow-agents#1484).
//
// The claude-code and opencode --global branches never run install-console-config.sh, so init
// used to accept these flags, exit 0 and apply none of them. It now refuses them before writing
// anything. Every case runs init as a child process with an empty temporary HOME and cwd.
//
// Run: `npm run test:unit`, or after `npm run build` and `node build/src/cli.js build-bundles`:
//   node --test src/cli/init-global-console-flags.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = path.join(repoRoot, "build", "src", "cli.js");
const URL = "https://console.example.test";

// Decided independently of init.ts's GLOBAL_INSTALL_APPLIES_CONSOLE_FLAGS table. The two lists
// must cover every runtime init accepts (pinned by the runtime-coverage test below).
const REFUSING_GLOBAL_RUNTIMES = ["claude-code", "opencode"];
const APPLYING_GLOBAL_RUNTIMES = ["codex", "base", "kiro", "pi"];

// Ambient Console or runtime-detection settings must not leak into the child.
function isolatedEnv(home) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(CONSOLE_|FLOW_AGENTS_CONSOLE_|FLOW_AGENTS_TELEMETRY_|FLOW_AGENTS_USER_|TELEMETRY_|CODEX_|CLAUDE|OPENCODE_)/.test(key)) continue;
    env[key] = value;
  }
  return { ...env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") };
}

function runInit(args, { home, cwd }) {
  const result = spawnSync(process.execPath, [cli, "init", ...args, "--yes"], { cwd, env: isolatedEnv(home), encoding: "utf8" });
  return { ...result, output: `${result.stdout}\n${result.stderr}` };
}

function listTree(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    out.push(path.relative(dir, full));
    if (entry.isDirectory()) out.push(...listTree(full).map((rel) => path.join(entry.name, rel)));
  }
  return out;
}

function freshHome(label) {
  return { home: makeFixtureDir(`init-global-console-${label}-home-`), cwd: makeFixtureDir(`init-global-console-${label}-cwd-`) };
}

const tokenFile = (() => {
  const dir = makeFixtureDir("init-global-console-token-");
  const file = path.join(dir, "console-token");
  fs.writeFileSync(file, "test-token-value", { mode: 0o600 });
  return file;
})();

const CONSOLE_FLAG_CASES = [
  ["--telemetry-sink", "kontour-hosted-console"],
  ["--telemetry-sinks", "local-files,user-hosted-console"],
  ["--console-url", URL],
  ["--console-endpoint", `${URL}/api/telemetry/records`],
  ["--console-endpoint-url", `${URL}/api/telemetry/records`],
  ["--console-token-file", tokenFile],
  ["--console-tenant", "t1"],
  ["--console-tenant-id", "t1"],
];

for (const runtime of REFUSING_GLOBAL_RUNTIMES) {
  for (const flagArgs of CONSOLE_FLAG_CASES) {
    test(`init --global ${runtime} refuses ${flagArgs[0]} and writes nothing`, () => {
      const dirs = freshHome(`${runtime}-${flagArgs[0].slice(2)}`);
      const result = runInit(["--runtime", runtime, "--global", ...flagArgs], dirs);
      assert.equal(result.status, 2, result.output);
      assert.ok(result.stderr.includes(`${flagArgs[0]} is not applied by \`init --global\` for ${runtime}, so nothing was installed.`), result.output);
      assert.ok(result.stderr.includes(path.join(dirs.home, ".flow-agents", "telemetry-console.conf")), result.output);
      assert.ok(result.stderr.includes(path.join(repoRoot, "scripts", "telemetry", "install-console-config.sh")), result.output);
      assert.deepEqual(listTree(dirs.home), []);
      assert.deepEqual(listTree(dirs.cwd), []);
    });
  }
}

test("init --global claude-code: no Console flag, or a local-files sink alone, is not refused", () => {
  for (const extra of [[], ["--telemetry-sink", "local-files"]]) {
    const dirs = freshHome("claude-code-defaults");
    const result = runInit(["--runtime", "claude-code", "--global", "--dry-run", ...extra], dirs);
    assert.equal(result.status, 0, result.output);
    assert.doesNotMatch(result.output, /not applied by `init --global`/);
  }
});

test("init --global opencode with a local-files sink alone installs", () => {
  const dirs = freshHome("opencode-local-files");
  const result = runInit(["--runtime", "opencode", "--global", "--telemetry-sink", "local-files"], dirs);
  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /Flow Agents global config and runtime assets synced for opencode/);
});

// Positive control and drift catch: every runtime whose --global install is NOT refused must
// really write the Console settings, so a new --global branch that drops them fails here.
for (const runtime of APPLYING_GLOBAL_RUNTIMES) {
  test(`init --global ${runtime} applies the Console flags to the installed telemetry.conf`, () => {
    const dirs = freshHome(`${runtime}-applies`);
    const dest = path.join(makeFixtureDir(`init-global-console-${runtime}-dest-`), "dest");
    const result = runInit(["--runtime", runtime, "--global", "--dest", dest, "--telemetry-sink", "user-hosted-console", "--console-url", URL, "--console-tenant", "t1"], dirs);
    assert.equal(result.status, 0, result.output);
    const conf = fs.readFileSync(path.join(dest, "scripts", "telemetry", "telemetry.conf"), "utf8");
    assert.match(conf, /^console_telemetry_url=https:\/\/console\.example\.test$/m);
    assert.match(conf, /^console_tenant_id=t1$/m);
  });
}

test("project init (no --global) applies the Console flags to the installed telemetry.conf", () => {
  const dirs = freshHome("project-applies");
  const dest = path.join(makeFixtureDir("init-global-console-project-dest-"), "dest");
  const result = runInit(["--runtime", "claude-code", "--dest", dest, "--telemetry-sink", "user-hosted-console", "--console-url", URL, "--console-tenant", "t1"], dirs);
  assert.equal(result.status, 0, result.output);
  const conf = fs.readFileSync(path.join(dest, "scripts", "telemetry", "telemetry.conf"), "utf8");
  assert.match(conf, /^console_telemetry_url=https:\/\/console\.example\.test$/m);
});

test("the refusal and positive-control lists cover every runtime init accepts", () => {
  const dirs = freshHome("runtime-list");
  const result = runInit(["--runtime", "not-a-runtime"], dirs);
  assert.equal(result.status, 2, result.output);
  const listed = result.stderr.match(/expected (.+)$/m)?.[1].split(/, (?:or )?| or /).map((name) => name.trim()).sort();
  assert.deepEqual(listed, [...REFUSING_GLOBAL_RUNTIMES, ...APPLYING_GLOBAL_RUNTIMES].sort());
});

function suggestedCommand(stderr) {
  const line = stderr.split("\n").find((entry) => entry.startsWith("  bash "));
  assert.ok(line, stderr);
  return line.trim();
}

function resolvedTelemetryConfig(configSh, home, extraEnv = {}) {
  const result = spawnSync("bash", ["-c", 'source "$1"; printf "%s\\n%s\\n" "$TELEMETRY_CONFIG_FILE" "$CONSOLE_TELEMETRY_URL"', "_", configSh], {
    env: { ...isolatedEnv(home), ...extraEnv },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const [configFile, consoleUrl] = result.stdout.split("\n");
  return { configFile, consoleUrl };
}

// The alternative the refusal names must be real: running its suggested command writes a conf
// that the global hooks' telemetry config actually resolves.
test("the refusal's suggested command writes the operator conf that global telemetry reads", () => {
  const dirs = freshHome("suggested-command");
  const refused = runInit(["--runtime", "opencode", "--global", "--telemetry-sink", "user-hosted-console", "--console-url", URL, "--console-tenant", "t1"], dirs);
  assert.equal(refused.status, 2, refused.output);
  const written = spawnSync("bash", ["-c", suggestedCommand(refused.stderr)], { env: isolatedEnv(dirs.home), encoding: "utf8" });
  assert.equal(written.status, 0, `${written.stdout}\n${written.stderr}`);
  const operatorConf = path.join(dirs.home, ".flow-agents", "telemetry-console.conf");

  // claude-code --global hooks run from the package root. Point its workspace root at an empty
  // directory so a developer's own <repo>/.kontourai/telemetry-console.conf cannot win.
  const claude = resolvedTelemetryConfig(path.join(repoRoot, "scripts", "telemetry", "lib", "config.sh"), dirs.home, { TELEMETRY_WORKSPACE_ROOT: makeFixtureDir("init-global-console-empty-ws-") });
  assert.deepEqual(claude, { configFile: operatorConf, consoleUrl: URL });

  // opencode --global hooks run from the installed runtime root.
  const installed = runInit(["--runtime", "opencode", "--global"], dirs);
  assert.equal(installed.status, 0, installed.output);
  const opencodeConfigSh = path.join(dirs.home, ".config", "opencode", ".flow-agents", "runtime", "scripts", "telemetry", "lib", "config.sh");
  assert.deepEqual(resolvedTelemetryConfig(opencodeConfigSh, dirs.home), { configFile: operatorConf, consoleUrl: URL });
});
