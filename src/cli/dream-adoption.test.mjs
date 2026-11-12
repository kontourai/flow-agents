// Adopting the dream run from the published package alone: a consumer with no host runtime and no Datum config, a
// Claude Code subscription instead of an API key, a config under macOS /tmp, and the installed command. Every run here
// is a child process with a clean environment, so the exit code is the real one and no operator setting leaks in.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { resolveRef } from "@kontourai/datum";
import { validateDreamConfig } from "../../kits/knowledge/dream/config.js";
import { MODEL_SETUP_DOC } from "../../kits/knowledge/dream/model.js";
import { telemetryLine, tempDir } from "./dream-support.mjs";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const KIT_CLI = path.join(REPO, "kits", "knowledge", "dream", "cli.js");
const PACKAGE_CLI = path.join(REPO, "build", "src", "cli.js");
const SUPPORT = path.join(import.meta.dirname, "dream-support.mjs");

// Synthetic, assembled from fragments so no detector-shaped literal is committed. The token has the shape of a
// GitHub personal access token, which the #669 scrub replaces with <SECRET>.
const SECRET = ["gh", "p_", "Q9w8E7r6T5y4U3i2O1p0A9s8D7f6G5h4J3k2"].join("");
const MARKER = "quokka-marker-7f3a";
const QUOTE = `I pinned the ledger rounding to half-even under ${MARKER}.`;
const SESSION = "7d3e1a20-0000-4000-8000-0000000000a1";

/** A Claude Code project transcript in the shape Claude Code writes: a user turn carrying the token, an assistant turn carrying the marker. */
function transcript(cwd = "/Users/fixture-user/dev/ledger") {
  const base = { isSidechain: false, cwd, sessionId: SESSION, version: "2.1.316", gitBranch: "main", userType: "external", entrypoint: "cli" };
  return [
    { ...base, parentUuid: null, promptId: "p-1", message: { role: "user", content: `Please pin the ledger rounding. The registry deploy token is ${SECRET} if you need it.` }, permissionMode: "default", type: "user", uuid: "00000000-0000-4000-8000-0000000000b1", timestamp: "2026-10-30T09:00:02.000Z" },
    { ...base, parentUuid: "00000000-0000-4000-8000-0000000000b1", message: { model: "claude-opus-5-5", id: "msg_b1", type: "message", role: "assistant", content: [{ type: "text", text: `Done. ${QUOTE}` }], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }, requestId: "req_msg_b1", type: "assistant", uuid: "00000000-0000-4000-8000-0000000000b2", timestamp: "2026-10-30T09:00:06.000Z" },
  ].map((line) => JSON.stringify(line)).join("\n").concat("\n");
}

/**
 * A stand-in for the `claude` command that Relay's Claude Code runtime spawns. It records what it was given (argv,
 * working directory, two environment values and stdin) and answers in the CLI's `--output-format json` shape, with the
 * structured output the forced tool asks for: one claim, grounded in QUOTE, when the content holds it.
 */
function fakeClaude(dir) {
  const script = path.join(dir, "fake-claude.mjs");
  fs.writeFileSync(script, `
    import fs from "node:fs";
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const stdin = Buffer.concat(chunks).toString("utf8");
    fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv: process.argv.slice(2), trigger: process.env.FLOW_AGENTS_DREAM_TRIGGER ?? null, disabledHooks: process.env.SA_DISABLED_HOOKS ?? null, cwd: process.cwd(), stdin }) + "\\n");
    // FAKE_CLAUDE_STATUSES: one HTTP status per call, in order (the last repeats); 200 answers normally. A 401 is what
    // the CLI prints when its sign-in is missing or expired, a 529 an overloaded API.
    const statuses = (process.env.FAKE_CLAUDE_STATUSES ?? "").split(",").filter(Boolean).map(Number);
    if (statuses.length) {
      const counter = process.env.FAKE_CLAUDE_LOG + ".calls";
      const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
      fs.writeFileSync(counter, String(n + 1));
      const status = statuses[Math.min(n, statuses.length - 1)];
      if (status !== 200) {
        process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: true, api_error_status: status, result: status === 401 ? "Invalid API key · Please run /login" : "Overloaded" }));
        process.exit(1);
      }
    }
    const quote = ${JSON.stringify(QUOTE)};
    const claim = { subject: "ledger service", subjectType: "service", property: "rounding mode", value: "half-even", posture: "stated" };
    const proposals = stdin.includes(quote) ? Object.entries(claim).map(([field, value]) => ({ fieldPath: "claims[0]." + field, value, confidence: 0.9, excerpt: quote })) : [];
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "", structured_output: { proposals }, usage: { input_tokens: 12, output_tokens: 7 }, stop_reason: "end_turn" }));
  `, { mode: 0o600 });
  const executable = path.join(dir, "claude");
  fs.writeFileSync(executable, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, { mode: 0o700 });
  return executable;
}

/**
 * Preloaded into the run: every network primitive throws and is logged, and a child process is allowed only when it is
 * the configured runtime's executable. The log is the proof of where the run sent anything.
 */
function egressGuard(dir) {
  const file = path.join(dir, "egress-guard.cjs");
  fs.writeFileSync(file, `
    const fs = require("node:fs");
    const record = (entry) => fs.appendFileSync(process.env.EGRESS_LOG, JSON.stringify(entry) + "\\n");
    const block = (name) => function () { record({ blocked: name }); throw new Error("egress blocked: " + name); };
    const net = require("node:net"), tls = require("node:tls"), http = require("node:http"), https = require("node:https"), dns = require("node:dns"), cp = require("node:child_process");
    for (const [owner, key, name] of [[net, "connect", "net.connect"], [net, "createConnection", "net.createConnection"], [net.Socket.prototype, "connect", "socket.connect"], [tls, "connect", "tls.connect"], [http, "request", "http.request"], [http, "get", "http.get"], [https, "request", "https.request"], [https, "get", "https.get"], [dns, "lookup", "dns.lookup"]]) owner[key] = block(name);
    globalThis.fetch = async () => { record({ blocked: "fetch" }); throw new Error("egress blocked: fetch"); };
    for (const key of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
      const original = cp[key];
      cp[key] = function (command, ...rest) {
        record({ exec: key, command: String(command) });
        if (command !== process.env.EGRESS_ALLOWED_EXEC) throw new Error("exec blocked: " + command);
        return original.call(this, command, ...rest);
      };
    }
    require("node:module").syncBuiltinESMExports();
  `);
  return file;
}

/** A consumer's machine: an empty home (no Datum config), a working directory without `.datum/`, one session, and a host module with a store and no model. */
function consumer(t, { config = {} } = {}) {
  const root = tempDir("dream-adopt-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const work = path.join(root, "work");
  const transcripts = path.join(root, "transcripts");
  for (const dir of [home, work, transcripts]) fs.mkdirSync(dir, { recursive: true });
  const session = path.join(transcripts, "session.jsonl");
  fs.writeFileSync(session, transcript());
  const telemetryFile = path.join(root, "telemetry.jsonl");
  fs.writeFileSync(telemetryFile, telemetryLine("claude-code", session));
  const memoryRoot = path.join(root, "memory");
  const published = path.join(root, "published.jsonl");
  const host = path.join(root, "host.mjs");
  fs.writeFileSync(host, `
    import fs from "node:fs";
    import { FakeCorpusStore } from ${JSON.stringify(SUPPORT)};
    export async function createDreamHost({ dryRun }) {
      if (!dryRun) fs.mkdirSync(${JSON.stringify(memoryRoot)}, { recursive: true });
      return {
        store: new FakeCorpusStore(${JSON.stringify(memoryRoot)}), registerRoot() {}, root: ${JSON.stringify(memoryRoot)}, rootName: "memory",
        publish(batch) { fs.appendFileSync(${JSON.stringify(published)}, JSON.stringify(batch) + "\\n"); },
      };
    }
  `, { mode: 0o600 });
  const dreamDir = path.join(root, "dream");
  const configFile = path.join(root, "dream.config.json");
  fs.writeFileSync(configFile, JSON.stringify({ enabled: true, telemetryFile, transcriptRoots: [transcripts], host, dreamDir, visibility: { kind: "restricted", audiences: ["user:owner"] }, ...config }), { mode: 0o600 });
  // Only what a fresh shell would have: no DATUM_* overrides, no provider keys, nothing from the operator's own setup.
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), TMPDIR: root };
  const run = (command, args, extraEnv = {}, nodeArgs = []) => spawnSync(process.execPath, [...nodeArgs, command, ...args], { cwd: work, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 60_000 });
  return { root, home, work, transcripts, memoryRoot, published, dreamDir, configFile, run };
}

function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).map((name) => path.join(dir, name)).filter((file) => fs.statSync(file).isFile());
}
const readLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);

// ── 1. No model set up is a configuration error ─────────────────────────────────────────────────────────────

test("with no host runtime and no Datum config, the run exits 2 and says how to give it a model", (t) => {
  const c = consumer(t);
  const result = c.run(KIT_CLI, ["run", "--config", c.configFile]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /^DREAM_MODEL_UNCONFIGURED: .*"extraction-default"/m, "names the missing role");
  assert.match(result.stderr, /Datum UNKNOWN_ROLE/);
  assert.match(result.stderr, /~\/\.config\/kontour\/datum\.json/);
  assert.match(result.stderr, /"runtime": \{ "kind": "claude-code" \} option is not available yet; see kontourai\/relay#84/, "says the subscription path is not open yet, and why");
  assert.match(result.stderr, /return `runtime`.*createDreamHost/, "offers the host path");
  assert.ok(result.stderr.includes(`See ${MODEL_SETUP_DOC}`), "links the doc");
  assert.equal(fs.existsSync(c.dreamDir), false, "nothing ran");

  // The Datum example in the message is one Datum accepts for that role: paste it, export the key, and the role resolves.
  const example = result.stderr.split("\n").find((line) => line.trim().startsWith('{"providers"'));
  const resolved = resolveRef("extraction-default", { config: JSON.parse(example), env: { ANTHROPIC_API_KEY: "placeholder" } });
  assert.equal(resolved.provider, "anthropic");
  assert.equal(resolved.auth.available, true);
});

test("a configured role names itself in the message", (t) => {
  const c = consumer(t, { config: { role: "memory-extraction" } });
  const result = c.run(KIT_CLI, ["run", "--config", c.configFile]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /Datum role "memory-extraction"/);
  assert.match(result.stderr, /"roles":\{"memory-extraction":/);
});

// ── 2. The Claude Code CLI as the model: refused until Relay can isolate it ─────────────────────────────────

/** A host module whose model is Relay's own Claude Code runtime over `executable`: the host's choice, in the host's code. */
function relayHost(c, executable) {
  const file = path.join(c.root, "relay-host.mjs");
  fs.writeFileSync(file, `
    import fs from "node:fs";
    import { createClaudeCodeRuntime } from ${JSON.stringify(import.meta.resolve("@kontourai/relay/claude-code"))};
    import { FakeCorpusStore } from ${JSON.stringify(SUPPORT)};
    export async function createDreamHost({ dryRun }) {
      if (!dryRun) fs.mkdirSync(${JSON.stringify(c.memoryRoot)}, { recursive: true });
      return {
        store: new FakeCorpusStore(${JSON.stringify(c.memoryRoot)}), registerRoot() {}, root: ${JSON.stringify(c.memoryRoot)}, rootName: "memory",
        runtime: createClaudeCodeRuntime({ model: "sonnet", executable: ${JSON.stringify(executable)} }),
        publish(batch) { fs.appendFileSync(${JSON.stringify(c.published)}, JSON.stringify(batch) + "\\n"); },
      };
    }
  `, { mode: 0o600 });
  const config = JSON.parse(fs.readFileSync(c.configFile, "utf8"));
  fs.writeFileSync(c.configFile, JSON.stringify({ ...config, host: file }), { mode: 0o600 });
}

test("runtime claude-code is refused with exit 2 and starts nothing, because Relay cannot yet isolate the claude process", (t) => {
  const c0 = consumer(t);
  const executable = fakeClaude(c0.root);
  const c = consumer(t, { config: { runtime: { kind: "claude-code", model: "sonnet", executable } } });
  const log = path.join(c.root, "claude.jsonl");
  const result = c.run(KIT_CLI, ["run", "--config", c.configFile], { FAKE_CLAUDE_LOG: log });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /^DREAM_MODEL_UNSUPPORTED: runtime "claude-code" is not available yet/m);
  assert.match(result.stderr, /kontourai\/relay#84/);
  assert.match(result.stderr, /Give the dream run a model in one of these ways/, "and says what does work");
  assert.equal(fs.existsSync(log), false, "the claude command was never started");
  assert.equal(fs.existsSync(path.join(c.dreamDir, "reports")), false, "no run started");
  const dry = c.run(KIT_CLI, ["run", "--config", c.configFile, "--dry-run"]);
  assert.equal(dry.status, 0, "a dry run needs no model, so the option does not block it");
});

function authRun(t, statuses) {
  const c0 = consumer(t);
  const executable = fakeClaude(c0.root);
  const c = consumer(t);
  relayHost(c, executable);
  const log = path.join(c.root, "claude.jsonl");
  const result = c.run(KIT_CLI, ["run", "--config", c.configFile], { FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_STATUSES: statuses });
  return { result, calls: readLines(log).length };
}

test("a runtime that refuses its credentials on every pass (claude not signed in) exits 2 with setup help, not 1", (t) => {
  const { result } = authRun(t, "401,401");
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /^DREAM_MODEL_UNAVAILABLE: the model runtime refused its credentials on every pass/m);
  assert.match(result.stderr, /sign in with \/login/);
  assert.match(result.stderr, /Give the dream run a model in one of these ways/);
  assert.equal(JSON.parse(result.stdout).status, "failed", "the failed run's report is still printed");
});

test("a sitting whose passes failed with a 401 and then an outage is a failed run (exit 1), not a setup error", (t) => {
  const { result, calls } = authRun(t, "401,529");
  assert.equal(calls, 2, "both passes reached the runtime");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /^DREAM_DISTILL_FAILED/m);
  assert.doesNotMatch(result.stderr, /DREAM_MODEL_UNAVAILABLE/);
});

test("config: runtime is validated, and cannot be combined with role", () => {
  const base = { telemetryFile: "/t.jsonl", transcriptRoots: ["/r"], host: "/h.mjs" };
  assert.deepEqual(validateDreamConfig({ ...base, runtime: { kind: "claude-code", model: "sonnet" } }).runtime, { kind: "claude-code", model: "sonnet" });
  for (const runtime of [{ kind: "codex", model: "m" }, { kind: "claude-code" }, { kind: "claude-code", model: " " }, { kind: "claude-code", model: "sonnet", executable: "claude" }, { kind: "claude-code", model: "sonnet", apiKey: "x" }, "claude-code", []]) {
    assert.throws(() => validateDreamConfig({ ...base, runtime }), (error) => error.code === "DREAM_CONFIG_INVALID", JSON.stringify(runtime));
  }
  assert.throws(() => validateDreamConfig({ ...base, role: "r", runtime: { kind: "claude-code", model: "sonnet" } }), /role or runtime, not both/);
});

// ── 3. A symlinked config path names the path to use ─────────────────────────────────────────────────────────

test("a config reached through a symlinked directory is refused with its real path, and that path works", (t) => {
  const c = consumer(t);
  const real = path.join(c.root, "real");
  fs.mkdirSync(real, { mode: 0o700 });
  fs.copyFileSync(c.configFile, path.join(real, "dream.config.json"));
  fs.chmodSync(path.join(real, "dream.config.json"), 0o600);
  fs.symlinkSync(real, path.join(c.root, "via-link")); // what macOS /tmp -> /private/tmp looks like
  const refused = c.run(KIT_CLI, ["run", "--config", path.join(c.root, "via-link", "dream.config.json")]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /symlink/);
  assert.ok(refused.stderr.includes(`resolves to ${path.join(real, "dream.config.json")}; pass that path instead`), refused.stderr);
  const accepted = c.run(KIT_CLI, ["run", "--config", path.join(real, "dream.config.json")]);
  assert.match(accepted.stderr, /^DREAM_MODEL_UNCONFIGURED/m, "the named path passes the config and host checks and the run reaches the model step");
});

// ── 4. The installed command ─────────────────────────────────────────────────────────────────────────────────

test("flow-agents dream forwards to the dream run, with its arguments and exit code", (t) => {
  const c = consumer(t);
  const unconfigured = c.run(PACKAGE_CLI, ["dream", "run", "--config", c.configFile]);
  assert.equal(unconfigured.status, 2, unconfigured.stderr);
  assert.match(unconfigured.stderr, /DREAM_MODEL_UNCONFIGURED/);
  const usage = c.run(PACKAGE_CLI, ["dream"]);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /DREAM_USAGE/);
  const dry = c.run(PACKAGE_CLI, ["dream", "run", "--config", c.configFile, "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).status, "dry-run");
});

// ── 8. Privacy: what a local run sends, and where ─────────────────────────────────────────────────────────────

test("privacy: in local mode the transcript reaches only the configured runtime, the token never leaves the scrub, and the marker appears only where documented", (t) => {
  const c0 = consumer(t);
  const executable = fakeClaude(c0.root);
  const guard = egressGuard(c0.root);
  const c = consumer(t);
  relayHost(c, executable); // the configured runtime: Relay's Claude Code runtime, from the operator's host module
  const log = path.join(c.root, "claude.jsonl");
  const egress = path.join(c.root, "egress.jsonl");
  const result = c.run(KIT_CLI, ["run", "--config", c.configFile], { FAKE_CLAUDE_LOG: log, EGRESS_LOG: egress, EGRESS_ALLOWED_EXEC: executable }, ["--require", guard]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.claims.created, 1, "the sitting was distilled, so the excerpt did travel");

  // Where the run sent anything: the configured runtime's executable, once per pass, and nothing else.
  const attempts = readLines(egress);
  assert.deepEqual(attempts, [{ exec: "spawn", command: executable }, { exec: "spawn", command: executable }], "no network call and no other process");

  // What the runtime was given: the scrubbed excerpt. The token was replaced before the model saw it; the marker,
  // ordinary conversation text, is what the docs say the model receives.
  const calls = readLines(log);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    const sent = JSON.stringify(call);
    assert.equal(sent.includes(SECRET), false, "the token reached the model runtime");
    assert.match(call.stdin, /registry deploy token is <SECRET>/, "the scrub ran on this turn, and the turn was sent");
    assert.ok(call.stdin.includes(QUOTE), "the excerpt reached the configured runtime");
  }
  assert.ok(report.redaction_hits >= 1);

  // Every output of the run: stdout, stderr, and every file it wrote (reports, cursor, briefs, proposals, the
  // published review batch). The inputs (transcript, telemetry) and the recordings above are excluded.
  const outputs = [
    ["stdout", result.stdout], ["stderr", result.stderr],
    ...[...filesUnder(c.dreamDir), ...filesUnder(c.memoryRoot), c.published].filter((file) => fs.existsSync(file)).map((file) => [path.relative(c.root, file), fs.readFileSync(file, "utf8")]),
  ];
  assert.ok(outputs.some(([name]) => name.startsWith("dream/reports/")), "the run wrote its report");
  assert.ok(outputs.some(([name]) => name.startsWith("memory/.corpus-proposals/")), "the run wrote its proposals");
  for (const [name, text] of outputs) assert.equal(text.includes(SECRET), false, `the token reached ${name}`);

  // The marker appears where the docs say transcript text goes: the proposed claim's grounded excerpt in the store,
  // and the routing decisions handed to the host's review delivery. Not in the report, the cursor or the briefs.
  const withMarker = outputs.filter(([, text]) => text.includes(MARKER)).map(([name]) => name.replace(/\/[^/]+$/, "/*"));
  assert.deepEqual([...new Set(withMarker)].sort(), ["memory/.corpus-proposals/*", "published.jsonl"]);
});

// ── Dry run over a memory root that does not exist yet ────────────────────────────────────────────────────────

/** A host over the real Corpus store that follows the dry-run rule: construct the store only when it creates nothing. */
function corpusHost(c, { constructAlways = false } = {}) {
  const file = path.join(c.root, "corpus-host.mjs");
  fs.writeFileSync(file, `
    import fs from "node:fs";
    import { KitDefaultStoreAdapter, standaloneFileMutationLock } from ${JSON.stringify(import.meta.resolve("@kontourai/corpus-store"))};
    const root = ${JSON.stringify(c.memoryRoot)};
    // Outside the root: the store's file-transaction constructor creates it.
    const coordinationDirectory = ${JSON.stringify(path.join(c.root, "coordination"))};
    export async function createDreamHost({ dryRun }) {
      const open = ${constructAlways ? "true" : "!dryRun || fs.existsSync(root)"};
      const store = open ? new KitDefaultStoreAdapter({ storeRoot: root, coordinationDirectory, coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock }) : undefined;
      return { store, registerRoot() {}, root, rootName: "memory", publish() {} };
    }
  `, { mode: 0o600 });
  const config = JSON.parse(fs.readFileSync(c.configFile, "utf8"));
  fs.writeFileSync(c.configFile, JSON.stringify({ ...config, host: file }), { mode: 0o600 });
}
const tree = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort();

test("a dry run over a memory root that does not exist yet leaves the filesystem untouched, with a real Corpus store host", (t) => {
  const c = consumer(t);
  corpusHost(c);
  const before = tree(c.root);
  const result = c.run(KIT_CLI, ["run", "--config", c.configFile, "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "dry-run");
  assert.equal(report.would_distill.length, 1, "the dry run still reports the sitting it would distil");
  assert.deepEqual(tree(c.root), before, "no memory root, records, coordination directory or dream directory was created");
});

test("a dry-run host may leave out the store only while its memory root is missing", (t) => {
  const c = consumer(t);
  corpusHost(c);
  fs.mkdirSync(c.memoryRoot);
  fs.writeFileSync(path.join(c.root, "corpus-host.mjs"), fs.readFileSync(path.join(c.root, "corpus-host.mjs"), "utf8").replace("!dryRun || fs.existsSync(root)", "false"), { mode: 0o600 });
  const result = c.run(KIT_CLI, ["run", "--config", c.configFile, "--dry-run"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no store, but its memory root exists/);
  assert.equal(c.run(KIT_CLI, ["run", "--config", c.configFile]).status, 2, "a real run without a store is still a configuration error");
});

// ── The dream directory must be the user's alone ─────────────────────────────────────────────────────────────

test("a dreamDir another user can write, or a briefs directory reached through a symlink, is refused with exit 2", (t) => {
  const c = consumer(t);
  fs.mkdirSync(c.dreamDir, { mode: 0o700 });
  fs.chmodSync(c.dreamDir, 0o777);
  const open = c.run(KIT_CLI, ["run", "--config", c.configFile, "--dry-run"]);
  assert.equal(open.status, 2, open.stderr);
  assert.match(open.stderr, /dreamDir must not be group or world writable/);
  fs.chmodSync(c.dreamDir, 0o700);
  const elsewhere = path.join(c.root, "elsewhere");
  fs.mkdirSync(elsewhere, { mode: 0o700 });
  fs.symlinkSync(elsewhere, path.join(c.dreamDir, "briefs"));
  const linked = c.run(KIT_CLI, ["run", "--config", c.configFile, "--dry-run"]);
  assert.equal(linked.status, 2, linked.stderr);
  assert.match(linked.stderr, /dreamDir\/briefs path must not contain a symlink/);
  fs.rmSync(path.join(c.dreamDir, "briefs"));
  assert.equal(c.run(KIT_CLI, ["run", "--config", c.configFile, "--dry-run"]).status, 0, "a private dreamDir passes");
});

test("each run-side directory check stands on its own: a world-writable briefs directory, and a dreamDir that is a symlink", (t) => {
  const c = consumer(t);
  fs.mkdirSync(path.join(c.dreamDir, "briefs"), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(c.dreamDir, "briefs"), 0o777);
  const open = c.run(KIT_CLI, ["run", "--config", c.configFile, "--dry-run"]);
  assert.equal(open.status, 2, open.stderr);
  assert.match(open.stderr, /dreamDir\/briefs must not be group or world writable/);
  fs.chmodSync(path.join(c.dreamDir, "briefs"), 0o700);
  // The link sits above dreamDir, so only the symlink check can refuse it.
  const link = path.join(c.root, "linked-parent");
  fs.symlinkSync(c.root, link);
  fs.writeFileSync(c.configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(c.configFile, "utf8")), dreamDir: path.join(link, "dream") }), { mode: 0o600 });
  const viaLink = c.run(KIT_CLI, ["run", "--config", c.configFile, "--dry-run"]);
  assert.equal(viaLink.status, 2, viaLink.stderr);
  assert.match(viaLink.stderr, /^DREAM_CONFIG_INVALID: dreamDir path must not contain a symlink/m);
});

test("a dreamDir under a directory its group can write is refused, though dreamDir itself is private", (t) => {
  const c = consumer(t);
  const shared = path.join(c.root, "shared");
  fs.mkdirSync(path.join(shared, "dream", "briefs"), { recursive: true, mode: 0o700 });
  fs.chmodSync(shared, 0o775); // not sticky: anyone in the group can rename dream away and put another in its place
  fs.writeFileSync(c.configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(c.configFile, "utf8")), dreamDir: path.join(shared, "dream") }), { mode: 0o600 });
  const result = c.run(KIT_CLI, ["run", "--config", c.configFile, "--dry-run"]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /dreamDir is under a group or world writable directory/);
});

test("a dreamDir that is a dangling symlink is refused with exit 2, not treated as not created yet", (t) => {
  const c = consumer(t);
  fs.symlinkSync(path.join(c.root, "nowhere"), c.dreamDir);
  const result = c.run(KIT_CLI, ["run", "--config", c.configFile, "--dry-run"]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /^DREAM_CONFIG_INVALID: dreamDir path must not contain a symlink/m);
});

test("the kit index exports the directory check for hosts that call runDream as a library", async (t) => {
  const kit = await import("../../kits/knowledge/dream/index.js");
  assert.equal(typeof kit.assertOwnerControlledDir, "function");
  const dir = tempDir("dream-lib-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(kit.assertOwnerControlledDir(dir, "dreamDir"), dir);
  fs.chmodSync(dir, 0o777);
  assert.throws(() => kit.assertOwnerControlledDir(dir, "dreamDir"), (error) => error.code === "DREAM_CONFIG_INVALID");
});
