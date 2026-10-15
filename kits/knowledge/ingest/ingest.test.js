import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { KnowledgeIngestFlow } from "./index.js";
import { DefaultKnowledgeStore } from "../adapters/default-store/index.js";

const flowCli = fileURLToPath(new URL("../../../node_modules/@kontourai/flow/dist/cli.js", import.meta.url));
const flowCommand = [process.execPath, flowCli];
const rawText = fs.readFileSync(new URL("../promote/fixtures/session/kontourai-flow-agents-287--deliver.md", import.meta.url), "utf8");

function fixture(t, runId) {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-flow-ingest-")));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const store = new DefaultKnowledgeStore({ storeRoot: path.join(workspace, "store") });
  const pilot = new KnowledgeIngestFlow({ store, workspace, runId, flowCommand });
  const status = () => JSON.parse(execFileSync(process.execPath, [flowCli, "status", runId, "--format", "json", "--cwd", workspace], { encoding: "utf8" }));
  return { workspace, store, pilot, status };
}

test("published Flow CLI advances fixture ingest only after each operation claim", async (t) => {
  const { pilot, store, status } = fixture(t, "fixture-ingest");
  const meta = { category: "engineering.testing", title: "Delivered session source", agent: "fixture-reader", session_id: "fixture-session", note: "promote/fixtures/session/kontourai-flow-agents-287--deliver.md", routing: "hold" };
  const inputFile = path.join(pilot.workspace, "input.json");
  fs.writeFileSync(inputFile, JSON.stringify({ rawText, meta }));
  const result = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL("./cli.js", import.meta.url)), "--input", inputFile, "--workspace", pilot.workspace, "--store-root", path.join(pilot.workspace, "store"), "--run-id", pilot.runId, "--flow-bin", fileURLToPath(new URL("../../../node_modules/.bin/flow", import.meta.url))], { encoding: "utf8" }));
  const stored = await store.get(result.id);
  assert.equal(stored.body, rawText);
  assert.equal(stored.type, "raw");
  assert.equal(stored.category, meta.category);
  assert.equal(stored.title, meta.title);
  assert.deepEqual(stored.provenance, { agent: meta.agent, session_id: meta.session_id, note: meta.note });
  assert.equal(result.routing, "hold");
  const evaluations = result.trace.filter((entry) => entry.args[0] === "evaluate");
  assert.deepEqual(evaluations.map((entry) => entry.args[3]), ["capture-gate", "classify-gate", "route-gate"]);
  for (const [index, step] of ["classify", "route", "done"].entries()) {
    assert.equal(evaluations[index].exitCode, 0);
    assert.match(evaluations[index].stdout, new RegExp(`current step: ${step}`));
  }
  assert.equal(status().current_step, "done");
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.artifactRoot, "routing.json"))).record_id, result.id);
});

test("Flow holds at capture when the capture-gate artifact is absent", async (t) => {
  const { pilot, store, status } = fixture(t, "missing-capture");
  await pilot.start();
  await assert.rejects(pilot.evaluate("capture-gate"), (error) => {
    assert.equal(error.code, "FLOW_GATE_BLOCKED");
    assert.match(error.message, /raw text.*missing/i);
    return true;
  });
  assert.equal(status().current_step, "capture");
  assert.deepEqual(await store.listByType("raw"), []);
});

for (const [name, text, meta, expectedStep] of [
  ["blank source", " \n ", {}, "capture"],
  ["invalid category", rawText, { category: "Not a category" }, "classify"],
]) {
  test(`${name} emits no successful downstream claim or store write`, async (t) => {
    const { pilot, store, status } = fixture(t, name.replaceAll(" ", "-"));
    await assert.rejects(pilot.capture(text, meta), { code: "MISSING_EVIDENCE" });
    assert.equal(status().current_step, expectedStep);
    assert.deepEqual(await store.listByType("raw"), []);
  });
}

test("initialized Flow workspace keeps authored scaffolds during ingest", async (t) => {
  const { pilot, workspace, status } = fixture(t, "existing-workspace");
  execFileSync(process.execPath, [flowCli, "init", "--cwd", workspace]);
  const readme = path.join(workspace, ".flow", "README.md");
  const sample = path.join(workspace, ".flow", "definitions", "agent-dev-flow.json");
  fs.writeFileSync(readme, "Authored workspace process notes\n");
  const sampleText = '{"id":"user.authored.flow","version":"1.0","steps":[{"id":"user","next":null}],"gates":{}}\n';
  fs.writeFileSync(sample, sampleText);
  const config = fs.readFileSync(path.join(workspace, ".flow", "config.json"));
  const result = await pilot.capture(rawText);
  assert.equal(status().current_step, "done");
  assert.equal(fs.readFileSync(readme, "utf8"), "Authored workspace process notes\n");
  assert.equal(fs.readFileSync(sample, "utf8"), sampleText);
  assert.deepEqual(fs.readFileSync(path.join(workspace, ".flow", "config.json")), config);
  assert.equal(result.trace.some((entry) => entry.args[0] === "init"), false);
});

for (const relative of ["README.md", "definitions/agent-dev-flow.json"]) {
  test(`partial Flow workspace refuses authored ${relative} before pilot writes`, async (t) => {
    const { pilot, workspace, store } = fixture(t, "partial-workspace");
    const file = path.join(workspace, ".flow", relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "Authored content\n");
    await assert.rejects(pilot.capture(rawText), /FLOW_INIT_COLLISION/);
    assert.equal(fs.readFileSync(file, "utf8"), "Authored content\n");
    assert.equal(fs.existsSync(path.join(workspace, ".kontourai")), false);
    assert.equal(fs.existsSync(path.join(workspace, ".flow", "config.json")), false);
    assert.deepEqual(await store.listByType("raw"), []);
  });
}

test("classification refuses an adapter identity mismatch before its claim or routing", async (t) => {
  const { pilot, store, status } = fixture(t, "wrong-record-id");
  let actualId;
  pilot.store = {
    create: async (input) => { actualId = await store.create(input); return "wrong-record-id"; },
    get: async () => store.get(actualId),
  };
  await assert.rejects(pilot.capture(rawText), /store readback does not match/);
  assert.equal(status().current_step, "classify");
  assert.equal(fs.existsSync(path.join(pilot.artifactRoot, "classification.trust.json")), false);
  assert.equal(fs.existsSync(path.join(pilot.artifactRoot, "routing.json")), false);
  assert.equal((await store.listByType("raw"))[0].id, actualId);
});

for (const relative of [".kontourai", ".kontourai/knowledge", ".kontourai/knowledge/ingest", ".kontourai/knowledge/ingest/artifact-symlink"]) {
  test(`artifact symlink at ${relative} refuses before writing outside the workspace`, async (t) => {
    const { pilot, workspace, store } = fixture(t, "artifact-symlink");
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-outside-")));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    const target = path.join(workspace, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(outside, target);
    await assert.rejects(pilot.capture(rawText), /UNSAFE_INGEST_PATH/);
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.equal(fs.existsSync(path.join(workspace, ".flow")), false);
    assert.deepEqual(await store.listByType("raw"), []);
  });
}
