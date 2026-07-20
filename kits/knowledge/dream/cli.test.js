import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { main, parseArgs } from "./cli.js";
import { ensureGlobalStore, globalStoreLocation, rootsRegistryPath, scaffoldStore } from "../adapters/shared/store-resolve.js";

function privateEnv(root) { const home = path.join(root, "home"); const xdg = path.join(root, "xdg"); fs.mkdirSync(home); fs.mkdirSync(xdg); return { HOME: home, XDG_DATA_HOME: xdg }; }

test("dream CLI accepts only bounded explicit options", () => {
  assert.deepEqual(parseArgs(["--telemetry", "/t.jsonl", "--cursor", "/c.json", "--transcript-root", "/r", "--store", "personal", "--apply-policy", "pending", "--dry-run"]), { telemetryFile: "/t.jsonl", cursorFile: "/c.json", transcriptRoots: ["/r"], store: "personal", applyPolicy: "pending", dryRun: true });
  assert.throws(() => parseArgs(["--unknown"]), /unknown option/);
  assert.throws(() => parseArgs(["--telemetry", "/t", "--cursor", "/c", "--transcript-root", "/r", "--repo-root", "/s"]), /unknown option/);
  assert.throws(() => parseArgs(["--telemetry", "/t", "--cursor", "/c", "--transcript-root", "/r", "--store", "/arbitrary"]), /personal/);
  assert.throws(() => parseArgs(["--telemetry", "/t", "--cursor", "/c", "--transcript-root", "/r", "--store", "personal", "--distiller", "/adapter.js"]), /distiller-root/);
});

test("CLI main runs a hermetic Codex response_item fixture", async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dream-cli-"));
  try {
    const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../promote/fixtures/runtime/codex-rollout.jsonl"); const transcript = path.join(root, "codex.jsonl"); const telemetry = path.join(root, "telemetry.jsonl"); const env = privateEnv(root); const storeRoot = ensureGlobalStore(env);
    fs.copyFileSync(source, transcript);
    fs.writeFileSync(telemetry, `${JSON.stringify({ schema_version: "0.3.0", timestamp: "2026-07-20T00:00:00Z", session_id: "s", event_id: "e", event_type: "session.end", agent: { name: "dev", runtime: "codex", version: "test" }, hook: { event_name: "Stop", runtime_session_id: "s", turn_id: "", transcript_path: transcript, model: "", source: "fixture", stop_hook_active: null, last_assistant_message: "", raw_input: null } })}\n`);
    const result = await main(["--telemetry", telemetry, "--cursor", path.join(storeRoot, "dream", "cursors", "runtime-session.cursor.json"), "--transcript-root", root, "--store", "personal"], env);
    assert.equal(result.status, "success"); assert.ok(result.cursor);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("CLI executable runs the hermetic fixture with stable JSON output", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dream-cli-spawn-"));
  try {
    const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../promote/fixtures/runtime/codex-rollout.jsonl"); const transcript = path.join(root, "codex.jsonl"); const telemetry = path.join(root, "telemetry.jsonl"); const env = privateEnv(root); const store = ensureGlobalStore(env); const cursor = path.join(store, "dream", "cursors", "runtime-session.cursor.json");
    fs.copyFileSync(source, transcript); fs.writeFileSync(telemetry, `${JSON.stringify({ schema_version: "0.3.0", timestamp: "2026-07-20T00:00:00Z", session_id: "s", event_id: "e", event_type: "session.end", agent: { name: "dev", runtime: "codex", version: "test" }, hook: { event_name: "Stop", runtime_session_id: "s", turn_id: "", transcript_path: transcript, model: "", source: "fixture", stop_hook_active: null, last_assistant_message: "", raw_input: null } })}\n`);
    const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "cli.js"); const run = spawnSync(process.execPath, [cli, "--telemetry", telemetry, "--cursor", cursor, "--transcript-root", root, "--store", "personal"], { encoding: "utf8", env: { ...process.env, ...env } });
    assert.equal(run.status, 0, run.stderr); assert.equal(JSON.parse(run.stdout).status, "success");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("CLI dry-run requires the canonical personal root to be registered without creating registry state", async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dream-cli-dry-registry-"));
  try {
    const env = privateEnv(root); const location = globalStoreLocation(env); fs.mkdirSync(location.repoRoot, { recursive: true }); const storeRoot = scaffoldStore(location.repoRoot); const telemetry = path.join(root, "telemetry.jsonl"); fs.writeFileSync(telemetry, "");
    await assert.rejects(() => main(["--telemetry", telemetry, "--transcript-root", root, "--store", "personal", "--dry-run"], env), /registered|personal/i); assert.equal(fs.existsSync(rootsRegistryPath(env)), false, "unregistered dry-run remains read-only");
    assert.equal(ensureGlobalStore(env), storeRoot); const before = fs.readFileSync(rootsRegistryPath(env), "utf8"); const result = await main(["--telemetry", telemetry, "--transcript-root", root, "--store", "personal", "--dry-run"], env); assert.equal(result.status, "dry-run"); assert.equal(fs.readFileSync(rootsRegistryPath(env), "utf8"), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Boo add/disable recipe is syntax-valid, explicit-auto, and never executed by tests", () => {
  const recipe = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "boo-recipe.sh"); const checked = spawnSync("sh", ["-n", recipe], { encoding: "utf8" }); assert.equal(checked.status, 0, checked.stderr);
  const content = `${fs.readFileSync(recipe, "utf8")}\n${fs.readFileSync(path.join(path.dirname(recipe), "scheduler-command.js"), "utf8")}`; assert.match(content, /boo add --name knowledge-dream --runner shell/); assert.match(content, /--apply-policy auto/); assert.match(content, /--store personal/); assert.match(content, /boo disable knowledge-dream/);
});

test("Boo command builder rejects unsafe paths and quotes embedded single quotes", async () => {
  const { buildBooCommand } = await import("./scheduler-command.js");
  assert.throws(() => buildBooCommand({ flowAgentsRoot: "relative", telemetryFile: "/t", transcriptRoot: "/r" }), /absolute/);
  assert.throws(() => buildBooCommand({ flowAgentsRoot: "/flow", telemetryFile: "/bad\npath", transcriptRoot: "/r" }), /control/);
  const command = buildBooCommand({ flowAgentsRoot: "/flow's", telemetryFile: "/tele'metry", transcriptRoot: "/tran'scripts" });
  assert.match(command, /'"'"'/); assert.match(command, /--store personal/);
});

test("CLI failure output does not echo private path arguments", () => {
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "cli.js"); const privateCanary = "/private/Users/example/secret-telemetry.jsonl";
  const run = spawnSync(process.execPath, [cli, "--telemetry", privateCanary, "--cursor", "/tmp/outside.cursor", "--transcript-root", "/tmp", "--store", "personal"], { encoding: "utf8" });
  assert.equal(run.status, 1); assert.equal(run.stderr.includes(privateCanary), false); assert.match(run.stderr, /dream command failed/);
});
