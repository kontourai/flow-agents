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

function runInit(args, { home, cwd }, extraEnv = {}) {
  const result = spawnSync(process.execPath, [cli, "init", ...args, "--yes"], { cwd, env: { ...isolatedEnv(home), ...extraEnv }, encoding: "utf8" });
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

// Both aliases of a Console field given at once: the first-listed alias wins, as the separate
// flagString(a) ?? flagString(b) reads did before CONSOLE_FLAGS replaced them.
test("project init: --console-endpoint beats --console-endpoint-url and --console-tenant beats --console-tenant-id", () => {
  const dirs = freshHome("project-alias-precedence");
  const dest = path.join(makeFixtureDir("init-global-console-alias-dest-"), "dest");
  const result = runInit([
    "--runtime", "claude-code", "--dest", dest, "--telemetry-sink", "user-hosted-console", "--console-url", URL,
    "--console-endpoint-url", "https://b.example/e", "--console-endpoint", "https://a.example/e",
    "--console-tenant-id", "Y", "--console-tenant", "X",
  ], dirs);
  assert.equal(result.status, 0, result.output);
  const conf = fs.readFileSync(path.join(dest, "scripts", "telemetry", "telemetry.conf"), "utf8");
  assert.match(conf, /^console_telemetry_endpoint_url=https:\/\/a\.example\/e$/m);
  assert.match(conf, /^console_tenant_id=X$/m);
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

// --- Fix round: environment variables, sink validation, valueless flags, quoting, interactive. ---

const operatorConfOf = (home) => path.join(home, ".flow-agents", "telemetry-console.conf");

// Written independently of init.ts's CONSOLE_ENV_VARS: the variables install-console-config.sh
// reads Console settings from. The drift test below pins this list against that script.
const CONSOLE_ENV_CASES = {
  FLOW_AGENTS_TELEMETRY_SINKS: "user-hosted-console",
  FLOW_AGENTS_TELEMETRY_SINK: "kontour-hosted-console",
  FLOW_AGENTS_CONSOLE_URL: URL,
  CONSOLE_TELEMETRY_URL: URL,
  CONSOLE_URL: URL,
  FLOW_AGENTS_CONSOLE_ENDPOINT_URL: `${URL}/api/telemetry/records`,
  CONSOLE_TELEMETRY_ENDPOINT_URL: `${URL}/api/telemetry/records`,
  FLOW_AGENTS_CONSOLE_TOKEN_FILE: tokenFile,
  CONSOLE_TELEMETRY_TOKEN_FILE: tokenFile,
  FLOW_AGENTS_CONSOLE_TENANT: "t1",
  CONSOLE_TENANT_ID: "t1",
};

test("the Console environment list matches the variables install-console-config.sh reads", () => {
  const script = fs.readFileSync(path.join(repoRoot, "scripts", "telemetry", "install-console-config.sh"), "utf8");
  const main = script.slice(script.indexOf("\nmain() {"));
  const read = [...new Set([...main.matchAll(/\$\{([A-Z][A-Z0-9_]*):-/g)].map((match) => match[1]))].filter((name) => name !== "TMPDIR");
  assert.deepEqual(read.sort(), Object.keys(CONSOLE_ENV_CASES).sort());
});

for (const [name, value] of Object.entries(CONSOLE_ENV_CASES)) {
  test(`init --global claude-code warns that ${name} is not applied, and still installs`, () => {
    const dirs = freshHome(`env-${name}`);
    const result = runInit(["--runtime", "claude-code", "--global", "--dry-run"], dirs, { [name]: value });
    assert.equal(result.status, 0, result.output);
    assert.ok(result.stderr.includes(`warning: ${name} is set in the environment, but \`init --global\` for claude-code does not write Console settings, so this install does not apply it.`), result.output);
    assert.ok(result.stderr.includes(operatorConfOf(dirs.home)), result.output);
  });
}

test("init --global opencode warns about every Console variable set, installs, and writes no Console config", () => {
  const dirs = freshHome("env-opencode");
  const result = runInit(["--runtime", "opencode", "--global"], dirs, { FLOW_AGENTS_TELEMETRY_SINK: "user-hosted-console", FLOW_AGENTS_CONSOLE_URL: URL, CONSOLE_TENANT_ID: "t1" });
  assert.equal(result.status, 0, result.output);
  assert.ok(result.stderr.includes("warning: FLOW_AGENTS_TELEMETRY_SINK, FLOW_AGENTS_CONSOLE_URL, CONSOLE_TENANT_ID are set in the environment, but `init --global` for opencode does not write Console settings, so this install does not apply them."), result.output);
  assert.equal(fs.existsSync(operatorConfOf(dirs.home)), false);
  // The runtime ships a default telemetry.conf; none of the written files carries the Console URL.
  for (const rel of listTree(dirs.home).filter((entry) => /telemetry.*\.conf$/.test(entry))) {
    assert.doesNotMatch(fs.readFileSync(path.join(dirs.home, rel), "utf8"), /console\.example\.test|console_tenant_id=t1/, rel);
  }
});

test("init --global: a local-files sink in the environment, or no Console variable, does not warn", () => {
  for (const env of [{}, { FLOW_AGENTS_TELEMETRY_SINK: "local-files" }, { FLOW_AGENTS_TELEMETRY_SINKS: "local-files," }, { FLOW_AGENTS_CONSOLE_URL: "" }]) {
    const dirs = freshHome("env-quiet");
    const result = runInit(["--runtime", "claude-code", "--global", "--dry-run"], dirs, env);
    assert.equal(result.status, 0, result.output);
    assert.doesNotMatch(result.stderr, /set in the environment/, JSON.stringify(env));
  }
});

// The contrast the warning reports: the same environment on a project install is applied.
test("project init applies the Console environment variables and does not warn", () => {
  const dirs = freshHome("env-project");
  const dest = path.join(makeFixtureDir("init-global-console-env-project-dest-"), "dest");
  const result = runInit(["--runtime", "claude-code", "--dest", dest], dirs, { FLOW_AGENTS_TELEMETRY_SINK: "user-hosted-console", FLOW_AGENTS_CONSOLE_URL: URL, CONSOLE_TENANT_ID: "t1" });
  assert.equal(result.status, 0, result.output);
  assert.doesNotMatch(result.stderr, /set in the environment/);
  const conf = fs.readFileSync(path.join(dest, "scripts", "telemetry", "telemetry.conf"), "utf8");
  assert.match(conf, /^console_telemetry_url=https:\/\/console\.example\.test$/m);
  assert.match(conf, /^console_tenant_id=t1$/m);
});

test("init --global claude-code: an invalid sink gets the usual unknown-sink error, not the refusal", () => {
  const dirs = freshHome("invalid-sink");
  const result = runInit(["--runtime", "claude-code", "--global", "--telemetry-sink", "LOCAL-FILES"], dirs);
  assert.equal(result.status, 2, result.output);
  assert.match(result.stderr, /unknown telemetry sink 'LOCAL-FILES'/);
  assert.doesNotMatch(result.output, /not applied by `init --global`|^ {2}bash /m);
  assert.deepEqual(listTree(dirs.home), []);
});

for (const [label, flagArgs, missing] of [
  ["followed by another flag", ["--console-url", "--console-tenant", "t1"], "--console-url"],
  ["last before --yes", ["--console-tenant", "t1", "--console-url"], "--console-url"],
  ["with an empty = value", ["--console-url="], "--console-url"],
  ["repeated, the second with no value", ["--console-url", URL, "--console-url"], "--console-url"],
  ["as a sink flag", ["--telemetry-sink"], "--telemetry-sink"],
]) {
  test(`init --global opencode refuses a Console flag ${label} with "requires a value" and prints no command`, () => {
    const dirs = freshHome("valueless");
    const result = runInit(["--runtime", "opencode", "--global", ...flagArgs], dirs);
    assert.equal(result.status, 2, result.output);
    assert.ok(result.stderr.includes(`${missing} requires a value`), result.output);
    assert.doesNotMatch(result.output, /^ {2}bash /m);
    assert.deepEqual(listTree(dirs.home), []);
  });
}

test("the refusal's command quotes a value that starts with =", () => {
  const dirs = freshHome("equals");
  const result = runInit(["--runtime", "claude-code", "--global", "--console-tenant", "=t1"], dirs);
  assert.equal(result.status, 2, result.output);
  assert.ok(suggestedCommand(result.stderr).endsWith(" --console-tenant '=t1'"), result.stderr);
});

test("the refusal's command names a relative --console-token-file by its absolute path", () => {
  const dirs = freshHome("relative-token");
  fs.writeFileSync(path.join(dirs.cwd, "tok"), "test-token-value", { mode: 0o600 });
  const result = runInit(["--runtime", "opencode", "--global", "--console-url", URL, "--console-token-file", "tok"], dirs);
  assert.equal(result.status, 2, result.output);
  const command = suggestedCommand(result.stderr);
  assert.ok(command.includes(` --console-token-file ${path.join(fs.realpathSync(dirs.cwd), "tok")}`), command);
  // Run from another directory: the file still resolves, and the token lands in the operator conf.
  const written = spawnSync("bash", ["-c", command], { cwd: dirs.home, env: isolatedEnv(dirs.home), encoding: "utf8" });
  assert.equal(written.status, 0, `${written.stdout}\n${written.stderr}`);
  assert.match(fs.readFileSync(operatorConfOf(dirs.home), "utf8"), /^console_telemetry_token=test-token-value$/m);
});

// Interactive init needs a terminal on stdin, so these drive it through a pseudo-terminal.
// The driver answers each prompt pattern once, in whatever order they appear.
const PTY_DRIVER = String.raw`
import json, os, pty, re, select, signal, sys, time
spec = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.chdir(spec["cwd"])
    os.execve(spec["cmd"][0], spec["cmd"], spec["env"])
buf, pos, pending, timed_out = b"", 0, list(spec["answers"]), False
deadline = time.time() + spec["timeout"]
while True:
    if time.time() > deadline:
        timed_out = True
        os.kill(pid, signal.SIGKILL)
        break
    ready, _, _ = select.select([fd], [], [], 0.2)
    if not ready:
        continue
    try:
        data = os.read(fd, 4096)
    except OSError:
        break
    if not data:
        break
    buf += data
    text = buf.decode("utf8", "replace")
    while True:
        hits = [(m.end(), i) for i, (pattern, _) in enumerate(pending) for m in [re.search(pattern, text[pos:])] if m]
        if not hits:
            break
        end, index = min(hits)
        pos += end
        os.write(fd, (pending.pop(index)[1] + "\n").encode())
_, status = os.waitpid(pid, 0)
print(json.dumps({"status": os.waitstatus_to_exitcode(status), "output": buf.decode("utf8", "replace"), "timedOut": timed_out}))
`;

const python3 = spawnSync("python3", ["-c", "import pty"], { encoding: "utf8" }).status === 0 ? "python3" : null;

function runInitInteractive(args, { home, cwd }, answers) {
  const spec = { cmd: [process.execPath, cli, "init", ...args], cwd, env: isolatedEnv(home), answers, timeout: 60 };
  const result = spawnSync(python3, ["-I", "-c", PTY_DRIVER, JSON.stringify(spec)], { encoding: "utf8", timeout: 90_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const run = JSON.parse(result.stdout);
  assert.equal(run.timedOut, false, run.output);
  return run;
}

test("interactive init --global opencode refuses a Console flag before any prompt", { skip: python3 ? false : "python3 with the pty module is not available" }, () => {
  const dirs = freshHome("interactive-refuse");
  // Every later prompt is answered so a regression fails on the assertions, not the timeout.
  const run = runInitInteractive(["--runtime", "opencode", "--global", "--console-url", URL], dirs, [
    ["Install destination \\[[^\\]]*\\]: ", ""],
    ["Connect to Kontour Console\\?[^\\n]*: ", "Skip"],
    ["Activate kits by id[^\\n]*: ", ""],
    ["Configure GitHub backlog[^\\n]*: ", "n"],
  ]);
  assert.equal(run.status, 2, run.output);
  assert.ok(run.output.includes("--console-url is not applied by `init --global` for opencode, so nothing was installed."), run.output);
  assert.doesNotMatch(run.output, /Install destination/);
  assert.deepEqual(listTree(dirs.home), []);
});

test("interactive init --global opencode skips the Console wizard and installs", { skip: python3 ? false : "python3 with the pty module is not available" }, () => {
  const dirs = freshHome("interactive-skip");
  const run = runInitInteractive(["--runtime", "opencode", "--global"], dirs, [
    ["Install destination \\[[^\\]]*\\]: ", ""],
    // Answered only so a regression fails on the assertion below instead of hanging.
    ["Connect to Kontour Console\\?[^\\n]*: ", "Skip"],
    ["Activate kits by id[^\\n]*: ", ""],
    ["Configure GitHub backlog[^\\n]*: ", "n"],
  ]);
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /Skipping Console setup: `init --global` for opencode does not configure a Console\./);
  assert.doesNotMatch(run.output, /Connect to Kontour Console/);
  assert.match(run.output, /Flow Agents global config and runtime assets synced for opencode/);
  assert.equal(fs.existsSync(operatorConfOf(dirs.home)), false);
});
