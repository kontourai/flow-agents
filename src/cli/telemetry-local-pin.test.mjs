// The local-only pin (kontourai/flow-agents#1483).
//
// `--telemetry-sink local-files` typed at install records `telemetry_sink_pin=local-files` in the
// installed scripts/telemetry/telemetry.conf. Every runtime reader of the Console config must then
// skip the operator Console confs (<workspace>/.kontourai/telemetry-console.conf and
// ~/.flow-agents/telemetry-console.conf), while an explicit TELEMETRY_CONFIG_FILE still wins. An
// install without the flag writes no pin, and the operator confs keep working for it.
//
// Four readers implement that resolution separately (bash, two JS, one TS), so each one is run
// here as a child process against the SAME real installed workspace, with an exact environment
// (the spawnSync `env` option replaces the parent's, like `env -i`) and a temporary HOME:
//   - scripts/telemetry/lib/config.sh           (sourced by every bash hook and relay)
//   - scripts/hooks/lib/liveness-write.js       (liveness relay spawn pre-gate)
//   - scripts/telemetry/console-board-sync.sh   (board sync gate; sources config.sh)
//   - flow-agents telemetry-doctor              (src/cli/telemetry-doctor.ts)
//
// Run: `npm run test:unit`, or after `npm run build` and `node build/src/cli.js build-bundles`:
//   node --test src/cli/telemetry-local-pin.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = path.join(repoRoot, "build", "src", "cli.js");
const NODE_PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`;
// console-board-sync.sh looks for a `flow-agents` bin on PATH once its gate passes; a PATH
// without the node directory keeps a globally installed one out, so the run stops at a
// recorded SKIP instead of calling a real Console.
const SHELL_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const PIN_LINE = /^telemetry_sink_pin=local-files$/m;

const GLOBAL_URL = "http://127.0.0.1:9";
const WORKSPACE_URL = "http://127.0.0.1:7";
const EXPLICIT_URL = "http://127.0.0.1:8";

function writeConf(file, url, token) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `console_telemetry_url=${url}\nconsole_telemetry_token=${token}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function runInit(args, home, extraEnv = {}) {
  const result = spawnSync(process.execPath, [cli, "init", ...args, "--yes"], {
    cwd: home,
    env: { HOME: home, PATH: NODE_PATH, XDG_CONFIG_HOME: path.join(home, ".config"), ...extraEnv },
    encoding: "utf8",
  });
  return { ...result, output: `${result.stdout}\n${result.stderr}` };
}

// One real install per pin state, shared by the reader matrix. Each case gets its own HOME and
// creates/removes the workspace conf inside the shared destination itself.
function install(label, sinkArgs) {
  const home = makeFixtureDir(`telemetry-pin-${label}-install-home-`);
  const dest = path.join(makeFixtureDir(`telemetry-pin-${label}-dest-`), "ws");
  const result = runInit(["--runtime", "base", "--dest", dest, ...sinkArgs], home);
  assert.equal(result.status, 0, result.output);
  return { dest, output: result.output };
}

const pinned = install("pinned", ["--telemetry-sink", "local-files"]);
const unpinned = install("unpinned", []);

function installedConf(dest) {
  return path.join(dest, "scripts", "telemetry", "telemetry.conf");
}

function readConfigSh(dest, env) {
  const script = 'source "$1"; printf "%s\\n%s\\n%s\\n%s\\n" "$TELEMETRY_CONFIG_FILE" "$CONSOLE_TELEMETRY_URL" "${FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY:-}" "${FLOW_AGENTS_CONSOLE_LIVENESS_RELAY:-}"';
  const result = spawnSync("/bin/bash", ["-c", script, "_", path.join(dest, "scripts", "telemetry", "lib", "config.sh")], { env: { PATH: SHELL_PATH, ...env }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const [file, url, economics, liveness] = result.stdout.split("\n");
  return { file, url, economics, liveness };
}

function readLivenessWrite(dest, env) {
  const script = "const m = require(process.argv[1]); process.stdout.write(JSON.stringify({ file: m.resolveConsoleConfPath(process.env), enabled: m.resolveLivenessRelayEnabled(process.env) }));";
  const result = spawnSync(process.execPath, ["-e", script, path.join(dest, "scripts", "hooks", "lib", "liveness-write.js")], { env: { PATH: NODE_PATH, ...env }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function readDoctor(dest, env) {
  const result = spawnSync(process.execPath, [cli, "telemetry-doctor", "--dest", dest, "--json", "--headless", "--timeout-ms", "300"], { env: { PATH: NODE_PATH, ...env }, encoding: "utf8" });
  const report = JSON.parse(result.stdout);
  return { file: report.telemetry.configFile, url: report.console.url, pinned: report.telemetry.localOnlyPinned, skipped: report.telemetry.skippedConfigFiles, warnings: report.warnings };
}

// Whether console-board-sync.sh passed its "URL and token resolved" gate: past it, the script
// writes its log (here a SKIP, since no flow-agents CLI is reachable); gated off, it writes none.
function boardSyncPassedGate(dest, env) {
  const log = path.join(dest, ".kontourai", "telemetry", "console-board-sync.log");
  fs.rmSync(log, { force: true });
  const repo = makeFixtureDir("telemetry-pin-board-repo-");
  const result = spawnSync("/bin/bash", [path.join(dest, "scripts", "telemetry", "console-board-sync.sh")], { env: { PATH: SHELL_PATH, FLOW_AGENTS_BOARD_SYNC_CWD: repo, ...env }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  if (!fs.existsSync(log)) return false;
  assert.match(fs.readFileSync(log, "utf8"), /SKIP: no flow-agents CLI found/);
  return true;
}

function readAll(dest, env) {
  return { configSh: readConfigSh(dest, env), liveness: readLivenessWrite(dest, env), doctor: readDoctor(dest, env), boardSync: boardSyncPassedGate(dest, env) };
}

// Readers spell the same file differently (Node's require() realpaths liveness-write.js's
// __dirname; bash and the doctor keep the logical path), so compare canonical paths.
function real(file) {
  return file && fs.existsSync(file) ? fs.realpathSync(file) : file;
}

function assertResolved(observed, { file, url, relays, pinned: pinnedFlag }) {
  file = real(file);
  observed.configSh.file = real(observed.configSh.file);
  observed.liveness.file = real(observed.liveness.file);
  observed.doctor.file = real(observed.doctor.file);
  assert.equal(observed.configSh.file, file, "config.sh resolved file");
  assert.equal(observed.configSh.url, url ?? "", "config.sh CONSOLE_TELEMETRY_URL");
  assert.equal(observed.configSh.economics, relays ? "1" : "", "config.sh economics relay");
  assert.equal(observed.configSh.liveness, relays ? "1" : "", "config.sh liveness relay");
  assert.equal(observed.liveness.file, file, "liveness-write.js resolved file");
  assert.equal(observed.liveness.enabled, Boolean(relays), "liveness-write.js relay pre-gate");
  assert.equal(observed.doctor.file, file, "telemetry-doctor resolved file");
  assert.equal(observed.doctor.url, url ? `${url}/` : undefined, "telemetry-doctor Console URL");
  assert.equal(observed.doctor.pinned, pinnedFlag, "telemetry-doctor localOnlyPinned");
  assert.equal(observed.boardSync, Boolean(url), "console-board-sync.sh gate");
}

function withWorkspaceConf(dest, fn) {
  const file = path.join(dest, ".kontourai", "telemetry-console.conf");
  writeConf(file, WORKSPACE_URL, "workspace-token");
  try {
    return fn(file);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function homeWithGlobalConf(label) {
  const home = makeFixtureDir(`telemetry-pin-${label}-home-`);
  const file = path.join(home, ".flow-agents", "telemetry-console.conf");
  writeConf(file, GLOBAL_URL, "global-token");
  return { home, file };
}

// --- the installer --------------------------------------------------------------------------

test("init --telemetry-sink local-files records the pin and the summary reports it", () => {
  const conf = fs.readFileSync(installedConf(pinned.dest), "utf8");
  assert.match(conf, PIN_LINE);
  assert.match(pinned.output, new RegExp(`✓ Telemetry pinned local-only in ${installedConf(pinned.dest).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("init with no --telemetry-sink writes no pin and claims none", () => {
  assert.doesNotMatch(fs.readFileSync(installedConf(unpinned.dest), "utf8"), /telemetry_sink_pin/);
  assert.doesNotMatch(unpinned.output, /pinned local-only|local-only pin/);
});

test("init with no --telemetry-sink on a machine with an operator conf suggests the pin", () => {
  const { home, file } = homeWithGlobalConf("suggest");
  const dest = path.join(makeFixtureDir("telemetry-pin-suggest-dest-"), "ws");
  const result = runInit(["--runtime", "base", "--dest", dest], home);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, new RegExp(`Telemetry config resolved from: ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(user-global`));
  assert.match(result.output, /re-run init with `--telemetry-sink local-files`, which pins it/);
  assert.doesNotMatch(fs.readFileSync(installedConf(dest), "utf8"), /telemetry_sink_pin/);
});

test("init --telemetry-sink local-files on a machine with an operator conf resolves the installed conf", () => {
  const { home } = homeWithGlobalConf("pinned-install");
  const dest = path.join(makeFixtureDir("telemetry-pin-pinned-install-dest-"), "ws");
  const result = runInit(["--runtime", "base", "--dest", dest, "--telemetry-sink", "local-files"], home);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, new RegExp(`✓ Telemetry config resolved from: ${installedConf(dest).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\n`));
  assert.match(result.output, /- Console: not configured/);
});

// install-console-config.sh is where the pin is written; run it directly against a copy of the
// bundle's scripts/telemetry so each rule is visible on its own.
function telemetryCopy(label) {
  const ws = path.join(makeFixtureDir(`telemetry-pin-icc-${label}-`), "ws");
  fs.cpSync(path.join(repoRoot, "dist", "base", "scripts", "telemetry"), path.join(ws, "scripts", "telemetry"), { recursive: true });
  return { ws, conf: path.join(ws, "scripts", "telemetry", "telemetry.conf"), script: path.join(ws, "scripts", "telemetry", "install-console-config.sh") };
}

function runInstaller(script, args, env = {}) {
  const home = makeFixtureDir("telemetry-pin-icc-home-");
  const result = spawnSync("/bin/bash", [script, ...args], { env: { HOME: home, PATH: SHELL_PATH, ...env }, encoding: "utf8" });
  return { ...result, output: `${result.stdout}\n${result.stderr}`, home };
}

test("install-console-config.sh: a typed local-files sink pins the installed telemetry.conf", () => {
  const { conf, script } = telemetryCopy("typed");
  const result = runInstaller(script, [conf, "--telemetry-sink", "local-files"]);
  assert.equal(result.status, 0, result.output);
  assert.match(fs.readFileSync(conf, "utf8"), PIN_LINE);
  assert.match(result.stdout, /Pinned telemetry to local files/);
});

test("install-console-config.sh: no sink, an environment-only sink, or local-files with a Console URL does not pin", () => {
  for (const [label, args, env] of [
    ["none", [], {}],
    ["env", [], { FLOW_AGENTS_TELEMETRY_SINK: "local-files" }],
    ["url", ["--telemetry-sink", "local-files", "--console-url", GLOBAL_URL], {}],
  ]) {
    const { conf, script } = telemetryCopy(label);
    const result = runInstaller(script, [conf, ...args], env);
    assert.equal(result.status, 0, `${label}: ${result.output}`);
    assert.doesNotMatch(fs.readFileSync(conf, "utf8"), /telemetry_sink_pin/, label);
  }
});

test("install-console-config.sh: selecting a Console sink later removes the pin", () => {
  const { conf, script } = telemetryCopy("lift");
  assert.equal(runInstaller(script, [conf, "--telemetry-sink", "local-files"]).status, 0);
  assert.match(fs.readFileSync(conf, "utf8"), PIN_LINE);
  const result = runInstaller(script, [conf, "--telemetry-sink", "local-kontour-console", "--console-tenant", "t1"]);
  assert.equal(result.status, 0, result.output);
  const after = fs.readFileSync(conf, "utf8");
  assert.doesNotMatch(after, /telemetry_sink_pin/);
  assert.match(after, /^console_telemetry_url=/m);
});

test("install-console-config.sh: never writes a pin into an operator conf", () => {
  const { script } = telemetryCopy("operator");
  const home = makeFixtureDir("telemetry-pin-operator-home-");
  const operatorConf = path.join(home, ".flow-agents", "telemetry-console.conf");
  fs.mkdirSync(path.dirname(operatorConf), { recursive: true });
  const result = runInstaller(script, [operatorConf, "--telemetry-sink", "local-files"], { HOME: home });
  assert.equal(result.status, 0, result.output);
  assert.equal(fs.existsSync(operatorConf), false, "no file written for a pin-only request");
  assert.doesNotMatch(result.stdout, /Pinned/);
});

// --- the readers ----------------------------------------------------------------------------

test("unpinned, no operator conf: every reader resolves the installed telemetry.conf", () => {
  const home = makeFixtureDir("telemetry-pin-unpinned-bare-home-");
  assertResolved(readAll(unpinned.dest, { HOME: home }), { file: installedConf(unpinned.dest), url: undefined, relays: false, pinned: false });
});

test("unpinned + user-global conf: every reader uses the operator conf (today's precedence)", () => {
  const { home, file } = homeWithGlobalConf("unpinned-global");
  assertResolved(readAll(unpinned.dest, { HOME: home }), { file, url: GLOBAL_URL, relays: true, pinned: false });
});

test("unpinned + workspace conf: every reader uses the workspace conf (today's precedence)", () => {
  const { home } = homeWithGlobalConf("unpinned-workspace");
  withWorkspaceConf(unpinned.dest, (file) => {
    assertResolved(readAll(unpinned.dest, { HOME: home }), { file, url: WORKSPACE_URL, relays: true, pinned: false });
  });
});

test("pinned, no operator conf: every reader resolves the installed telemetry.conf", () => {
  const home = makeFixtureDir("telemetry-pin-pinned-bare-home-");
  const observed = readAll(pinned.dest, { HOME: home });
  assertResolved(observed, { file: installedConf(pinned.dest), url: undefined, relays: false, pinned: true });
  assert.deepEqual(observed.doctor.skipped, []);
});

test("pinned + user-global conf: every reader skips the operator conf", () => {
  const { home, file } = homeWithGlobalConf("pinned-global");
  const observed = readAll(pinned.dest, { HOME: home });
  assertResolved(observed, { file: installedConf(pinned.dest), url: undefined, relays: false, pinned: true });
  assert.deepEqual(observed.doctor.skipped, [file]);
});

test("pinned + workspace conf: every reader skips the workspace conf too", () => {
  const home = makeFixtureDir("telemetry-pin-pinned-workspace-home-");
  withWorkspaceConf(pinned.dest, (file) => {
    const observed = readAll(pinned.dest, { HOME: home });
    assertResolved(observed, { file: installedConf(pinned.dest), url: undefined, relays: false, pinned: true });
    assert.deepEqual(observed.doctor.skipped, [file]);
  });
});

test("pinned + TELEMETRY_CONFIG_FILE: the explicit file still wins over the pin", () => {
  const { home } = homeWithGlobalConf("pinned-explicit");
  const explicit = path.join(makeFixtureDir("telemetry-pin-explicit-"), "explicit.conf");
  writeConf(explicit, EXPLICIT_URL, "explicit-token");
  assertResolved(readAll(pinned.dest, { HOME: home, TELEMETRY_CONFIG_FILE: explicit }), { file: explicit, url: EXPLICIT_URL, relays: true, pinned: false });
});

test("pinned: an untrusted operator conf draws no warning, since it is never read", () => {
  const home = makeFixtureDir("telemetry-pin-untrusted-home-");
  const file = path.join(home, ".flow-agents", "telemetry-console.conf");
  writeConf(file, GLOBAL_URL, "global-token");
  fs.chmodSync(file, 0o644);
  const result = spawnSync("/bin/bash", ["-c", 'source "$1"', "_", path.join(pinned.dest, "scripts", "telemetry", "lib", "config.sh")], { env: { HOME: home, PATH: SHELL_PATH }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /not trusted/);
  assert.deepEqual(readDoctor(pinned.dest, { HOME: home }).warnings, []);
  // Control: the unpinned install does warn about the same file.
  const control = spawnSync("/bin/bash", ["-c", 'source "$1"', "_", path.join(unpinned.dest, "scripts", "telemetry", "lib", "config.sh")], { env: { HOME: home, PATH: SHELL_PATH }, encoding: "utf8" });
  assert.match(control.stderr, /not trusted/);
});

// --- --global installs ----------------------------------------------------------------------

test("init --global claude-code with --telemetry-sink local-files says no pin is recorded and writes none", () => {
  const home = makeFixtureDir("telemetry-pin-global-claude-home-");
  const packageConf = path.join(repoRoot, "scripts", "telemetry", "telemetry.conf");
  const before = fs.readFileSync(packageConf, "utf8");
  const result = runInit(["--runtime", "claude-code", "--global", "--telemetry-sink", "local-files"], home, { FLOW_AGENTS_USER_CLAUDE_SETTINGS: path.join(home, ".claude", "settings.json") });
  assert.equal(result.status, 0, result.output);
  assert.match(result.stderr, /--telemetry-sink local-files does not pin `init --global` for claude-code local-only/);
  assert.doesNotMatch(result.stdout, /pinned local-only|Pinned telemetry/);
  assert.equal(fs.readFileSync(packageConf, "utf8"), before, "the package's own telemetry.conf is never pinned");
});

test("init --global codex with --telemetry-sink local-files pins the Codex home's telemetry.conf", () => {
  const home = makeFixtureDir("telemetry-pin-global-codex-home-");
  const dest = path.join(makeFixtureDir("telemetry-pin-global-codex-dest-"), "codex-home");
  const result = runInit(["--runtime", "codex", "--global", "--dest", dest, "--telemetry-sink", "local-files"], home);
  assert.equal(result.status, 0, result.output);
  assert.match(fs.readFileSync(installedConf(dest), "utf8"), PIN_LINE);
  assert.doesNotMatch(result.stderr, /does not pin/);
});

// --- interactive init -------------------------------------------------------------------------
//
// Interactive init only runs on a TTY (a piped stdin is treated as headless), so these drive it
// through a pseudo-terminal with Python's pty module, answering each prompt as it appears.
const PTY_DRIVER = `
import json, os, pty, select, sys, time
argv, env, steps = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.execve(argv[0], argv, env)
out = b""
def read_until(needle, deadline):
    global out
    while needle.encode() not in out:
        if time.time() > deadline:
            raise SystemExit("timed out waiting for " + repr(needle) + "; output so far: " + out.decode(errors="replace"))
        ready, _, _ = select.select([fd], [], [], 0.5)
        if ready:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                chunk = b""
            if not chunk:
                raise SystemExit("child exited waiting for " + repr(needle) + "; output: " + out.decode(errors="replace"))
            out += chunk
for needle, answer in steps:
    read_until(needle, time.time() + 120)
    out = out.split(needle.encode(), 1)[1]
    os.write(fd, (answer + "\\r").encode())
while True:
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    out += chunk
_, status = os.waitpid(pid, 0)
sys.stdout.write(out.decode(errors="replace"))
sys.exit(os.waitstatus_to_exitcode(status))
`;

const python = ["/usr/bin/python3", "/usr/local/bin/python3", "/opt/homebrew/bin/python3"].find((candidate) => fs.existsSync(candidate));

function runInteractiveInit(args, steps) {
  const home = makeFixtureDir("telemetry-pin-interactive-home-");
  const file = path.join(home, ".flow-agents", "telemetry-console.conf");
  writeConf(file, GLOBAL_URL, "global-token");
  const env = { HOME: home, PATH: NODE_PATH, XDG_CONFIG_HOME: path.join(home, ".config"), TERM: "dumb" };
  const result = spawnSync(python, ["-I", "-c", PTY_DRIVER, JSON.stringify([[process.execPath, cli, "init", ...args], env, steps])], { cwd: home, encoding: "utf8", timeout: 240000 });
  return { ...result, output: `${result.stdout}\n${result.stderr}` };
}

const KIT_PROMPT = "Activate kits by id";
const PROVIDER_PROMPT = "Configure GitHub backlog, assignment, and change providers?";

test("interactive init: answering Skip at the Console prompt does not pin", { skip: python ? false : "python3 (pty driver) not found" }, () => {
  const dest = path.join(makeFixtureDir("telemetry-pin-interactive-skip-"), "ws");
  const result = runInteractiveInit(["--runtime", "base", "--dest", dest], [["Connect to Kontour Console?", "skip"], [KIT_PROMPT, ""], [PROVIDER_PROMPT, "n"]]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Telemetry sink \(selected\): local-files/);
  assert.doesNotMatch(fs.readFileSync(installedConf(dest), "utf8"), /telemetry_sink_pin/);
  assert.match(result.output, /re-run init with `--telemetry-sink local-files`, which pins it/);
});

test("interactive init: a typed --telemetry-sink local-files pins", { skip: python ? false : "python3 (pty driver) not found" }, () => {
  const dest = path.join(makeFixtureDir("telemetry-pin-interactive-flag-"), "ws");
  const result = runInteractiveInit(["--runtime", "base", "--dest", dest, "--telemetry-sink", "local-files"], [[KIT_PROMPT, ""], [PROVIDER_PROMPT, "n"]]);
  assert.equal(result.status, 0, result.output);
  assert.match(fs.readFileSync(installedConf(dest), "utf8"), PIN_LINE);
  assert.match(result.output, /Telemetry pinned local-only in /);
});

// --- uninstall and re-install ------------------------------------------------------------------
//
// The ownership manifest records telemetry.conf as installed (pin included), so uninstall removes
// it, and a re-install resets it to the bundle's bytes before applying the new invocation's sink.
test("uninstall removes a pinned install's telemetry.conf", () => {
  const home = makeFixtureDir("telemetry-pin-uninstall-home-");
  const dest = path.join(makeFixtureDir("telemetry-pin-uninstall-dest-"), "ws");
  const installed = runInit(["--runtime", "claude-code", "--dest", dest, "--telemetry-sink", "local-files"], home);
  assert.equal(installed.status, 0, installed.output);
  assert.match(fs.readFileSync(installedConf(dest), "utf8"), PIN_LINE);
  const removed = runInit(["--uninstall", "--runtime", "claude-code", "--dest", dest], home);
  assert.equal(removed.status, 0, removed.output);
  assert.equal(fs.existsSync(installedConf(dest)), false, removed.output);
});

test("re-running init without --telemetry-sink drops the pin; with it, keeps it", () => {
  const home = makeFixtureDir("telemetry-pin-reinit-home-");
  const dest = path.join(makeFixtureDir("telemetry-pin-reinit-dest-"), "ws");
  for (const [args, pinnedAfter] of [[["--telemetry-sink", "local-files"], true], [["--telemetry-sink", "local-files"], true], [[], false]]) {
    const result = runInit(["--runtime", "base", "--dest", dest, ...args], home);
    assert.equal(result.status, 0, result.output);
    assert.equal(PIN_LINE.test(fs.readFileSync(installedConf(dest), "utf8")), pinnedAfter, `${args.join(" ") || "(no sink flag)"}: ${result.output}`);
    assert.doesNotMatch(result.output, /preserved scripts\/telemetry\/telemetry\.conf/);
  }
});

test("a typed local-files sink over a user-edited telemetry.conf reports the pin as NOT recorded", () => {
  const { home } = homeWithGlobalConf("not-recorded");
  const dest = path.join(makeFixtureDir("telemetry-pin-not-recorded-dest-"), "ws");
  assert.equal(runInit(["--runtime", "base", "--dest", dest], home).status, 0);
  // A user edit makes the file not bundle-owned, so the next init preserves it untouched.
  fs.appendFileSync(installedConf(dest), "# edited by the user\n");
  const result = runInit(["--runtime", "base", "--dest", dest, "--telemetry-sink", "local-files"], home);
  assert.equal(result.status, 0, result.output);
  assert.doesNotMatch(fs.readFileSync(installedConf(dest), "utf8"), /telemetry_sink_pin/);
  assert.match(result.output, /! Telemetry local-only pin: requested with --telemetry-sink local-files but NOT recorded/);
  assert.doesNotMatch(result.output, /✓ Telemetry pinned local-only/);
});
