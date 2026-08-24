import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

const helper = path.resolve("scripts/hooks/lib/anchored-jsonl-stage.js");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(file) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (fs.existsSync(file)) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${file}`);
}

test("anchored JSONL staging cannot be redirected by a concurrent parent replacement", async (t) => {
  const root = makeFixtureDir("flow-agents-anchored-jsonl-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  const movedDir = path.join(root, "agent-original");
  const outside = path.join(root, "outside");
  const coordination = path.join(root, "coordination");
  fs.mkdirSync(agentDir);
  fs.mkdirSync(outside);
  fs.mkdirSync(coordination, { mode: 0o700 });
  fs.writeFileSync(path.join(coordination, "payload"), '{"agent_id":"worker"}\n', { mode: 0o600 });
  const identity = fs.statSync(agentDir);

  const child = spawn(process.execPath, [
    helper,
    String(identity.dev),
    String(identity.ino),
    coordination,
  ], { cwd: agentDir, stdio: "ignore" });
  fs.renameSync(agentDir, movedDir);
  fs.symlinkSync(outside, agentDir);
  await waitFor(path.join(coordination, "ready"));
  fs.writeFileSync(path.join(coordination, "commit"), "", { flag: "wx" });
  await waitFor(path.join(coordination, "done"));
  if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));

  assert.equal(fs.existsSync(path.join(outside, "events.jsonl")), false);
  assert.match(fs.readFileSync(path.join(movedDir, "events.jsonl"), "utf8"), /"worker"/);
});
