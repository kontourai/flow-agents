import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";
import { canonicalRunFlowIds, isCanonicalRunFlowId } from "../../build/src/builder-flow-run-adapter.js";
import { startBuilderFlowSession } from "../../build/src/builder-flow-runtime.js";
import { canonicalKitFlowSourceRoots, resolveKitFlowBinding } from "../../build/src/lib/kit-flow-binding.js";
import { declaredKitFlowIds, declaredKitFlows, resolveFlowFilePath } from "../../build/src/lib/flow-resolver.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(ROOT, "build/src/cli.js");
const SIDECAR = path.join(ROOT, "build/src/cli/workflow-sidecar.js");
const ACTOR = "installed-kit-run-binding-fixture";
process.env.FLOW_AGENTS_ACTOR = ACTOR;

function command(file, args, cwd) {
  const result = spawnSync(process.execPath, [file, ...args], {
    cwd, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, FLOW_AGENTS_ACTOR: ACTOR },
  });
  assert.equal(result.status, 0, `${args[0]} failed: ${result.stderr}\n${result.stdout}`);
  return result;
}

function workspace(t) {
  const cwd = fs.realpathSync(makeFixtureDir("installed-kit-run-binding-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  for (const args of [["init", "-q", "."], ["-c", "user.email=fixture@example.test", "-c", "user.name=fixture", "commit", "-q", "--allow-empty", "-m", "fixture"]]) {
    assert.equal(spawnSync("git", args, { cwd }).status, 0);
  }
  return cwd;
}

function install(cwd) {
  command(CLI, ["kit", "install", path.join(ROOT, "examples/aidlc"), "--dest", cwd], cwd);
  return path.join(cwd, "kits/local/repositories/aidlc");
}

test("a publicly installed standalone kit declares runnable profiles and starts pinned canonical sessions", { timeout: 60_000 }, async (t) => {
  const cwd = workspace(t);
  const installed = install(cwd);
  command(CLI, ["kit", "activate", "--adapter", "codex-local", "--dest", cwd, "--source-root", ROOT], cwd);
  const manifest = JSON.parse(fs.readFileSync(path.join(installed, "kit.json"), "utf8"));
  const ids = manifest.flows.map((flow) => flow.id).sort();
  assert.equal(ids.length, 11);
  assert.deepEqual(canonicalRunFlowIds(cwd).filter((id) => id.startsWith("aidlc.")), ids);
  assert.deepEqual(declaredKitFlowIds(cwd).filter((id) => id.startsWith("aidlc.")), ids);
  assert.equal(fs.existsSync(path.join(cwd, "kits/aidlc")), false, "installation does not mirror into a privileged kit path");
  const digests = [];
  for (const [flowId, workItem, slug] of [["aidlc.feature", "acme/widgets#81", "acme-widgets-81"], ["aidlc.bugfix", "acme/widgets#82", "acme-widgets-82"]]) {
    const binding = resolveKitFlowBinding(flowId, canonicalKitFlowSourceRoots(cwd));
    assert.equal(binding.sourceRoot, cwd);
    assert.equal(binding.flowRelativePath, `kits/local/repositories/aidlc/flows/${flowId.split(".")[1]}.flow.json`);
    assert.equal(resolveFlowFilePath("aidlc", flowId.split(".")[1], flowId, cwd), binding.definitionPath);
    const artifactRoot = path.join(cwd, ".kontourai/flow-agents");
    command(SIDECAR, ["ensure-session", "--artifact-root", artifactRoot, "--work-item", workItem, "--flow-id", flowId, "--source-request", "synthetic installed-kit fixture", "--summary", "synthetic installed-kit fixture"], cwd);
    const sessionDir = path.join(artifactRoot, slug);
    const started = await startBuilderFlowSession({ sessionDir, flowId });
    assert.ok(started.gateActionEnvelope.action.skills.length > 0, "installed stage exposes executable skill instructions");
    for (const skill of started.gateActionEnvelope.action.skills) {
      assert.ok(skill.path.startsWith("kits/local/repositories/aidlc/"));
      assert.equal(fs.existsSync(path.join(cwd, skill.path)), true);
    }
    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, "state.json"), "utf8"));
    assert.equal(state.flow_run.definition_id, flowId);
    assert.match(state.flow_run.definition_digest, /^[a-f0-9]{64}$/);
    assert.equal(fs.existsSync(path.join(cwd, state.flow_run.run_ref)), true);
    digests.push(state.flow_run.definition_digest);
  }
  assert.notEqual(digests[0], digests[1], "distinct workflow profiles retain distinct pinned definitions");
});

test("installed registry corruption, escaped pointers, changed bytes and symlinks cannot supply bindings", { timeout: 60_000 }, (t) => {
  const cwd = workspace(t);
  const installed = install(cwd);
  const registryFile = path.join(cwd, "kits/local/installed-kits.json");
  const original = fs.readFileSync(registryFile, "utf8");
  const assertRefused = () => {
    assert.equal(resolveKitFlowBinding("aidlc.feature", canonicalKitFlowSourceRoots(cwd)), null);
    assert.equal(isCanonicalRunFlowId("aidlc.feature", cwd), false);
    assert.equal(declaredKitFlowIds(cwd).includes("aidlc.feature"), false);
  };
  for (const malformed of ["{", JSON.stringify({ schema_version: "1.0", kits: [null] }), JSON.stringify({ ...JSON.parse(original), kits: [{ ...JSON.parse(original).kits[0], installed_path: "../../outside" }] }), JSON.stringify({ ...JSON.parse(original), kits: [JSON.parse(original).kits[0], JSON.parse(original).kits[0]] })]) {
    fs.writeFileSync(registryFile, malformed);
    assertRefused();
  }
  fs.writeFileSync(registryFile, original);
  const definition = path.join(installed, "flows/feature.flow.json");
  const originalDefinition = fs.readFileSync(definition);
  fs.appendFileSync(definition, " ");
  assertRefused();
  fs.writeFileSync(definition, originalDefinition);
  fs.renameSync(registryFile, `${registryFile}.real`);
  fs.symlinkSync(`${registryFile}.real`, registryFile);
  assertRefused();
});

test("installed kits cannot shadow packaged kit bindings and explicit overrides remain refused", { timeout: 60_000 }, (t) => {
  const cwd = workspace(t);
  command(CLI, ["kit", "install", path.join(ROOT, "kits/builder"), "--dest", cwd], cwd);
  const binding = resolveKitFlowBinding("builder.build", canonicalKitFlowSourceRoots(cwd));
  assert.equal(binding.sourceRoot, ROOT);
  assert.equal(binding.definitionPath, path.join(ROOT, "kits/builder/flows/build.flow.json"));
  assert.equal(resolveFlowFilePath("builder", "build", "builder.build", cwd), binding.definitionPath);
  install(cwd);
  const override = path.join(cwd, "override");
  fs.mkdirSync(override);
  fs.copyFileSync(path.join(cwd, "kits/local/repositories/aidlc/flows/feature.flow.json"), path.join(override, "aidlc.feature.flow.json"));
  const prior = process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
  process.env.FLOW_AGENTS_FLOW_DEFS_DIR = override;
  try {
    const result = spawnSync(process.execPath, [SIDECAR, "ensure-session", "--artifact-root", path.join(cwd, ".kontourai/flow-agents"), "--work-item", "acme/widgets#83", "--flow-id", "aidlc.feature", "--source-request", "fixture", "--summary", "fixture"], { cwd, encoding: "utf8", timeout: 30_000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /env var is not provenance|FLOW_AGENTS_FLOW_DEFS_DIR/);
  } finally {
    if (prior === undefined) delete process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
    else process.env.FLOW_AGENTS_FLOW_DEFS_DIR = prior;
  }
});

test("an undeclared direct-tree decoy cannot replace an installed definition or rescue a drifted install", { timeout: 60_000 }, async (t) => {
  const cwd = workspace(t);
  const installed = install(cwd);
  const installedDefinition = path.join(installed, "flows/feature.flow.json");
  const decoy = path.join(cwd, "kits/aidlc/flows/feature.flow.json");
  fs.mkdirSync(path.dirname(decoy), { recursive: true });
  const value = JSON.parse(fs.readFileSync(installedDefinition, "utf8"));
  fs.writeFileSync(decoy, JSON.stringify({ ...value, version: "decoy" }));
  const binding = resolveKitFlowBinding("aidlc.feature", canonicalKitFlowSourceRoots(cwd));
  assert.equal(binding.definitionPath, installedDefinition);
  assert.equal(resolveFlowFilePath("aidlc", "feature", "aidlc.feature", cwd), installedDefinition);
  assert.equal(declaredKitFlows(cwd).find((entry) => entry.flowId === "aidlc.feature").via, "manifest");
  assert.equal(isCanonicalRunFlowId("aidlc.feature", cwd), true);
  const artifactRoot = path.join(cwd, ".kontourai/flow-agents");
  command(SIDECAR, ["ensure-session", "--artifact-root", artifactRoot, "--work-item", "acme/widgets#84", "--flow-id", "aidlc.feature", "--source-request", "decoy fixture", "--summary", "decoy fixture"], cwd);
  await startBuilderFlowSession({ sessionDir: path.join(artifactRoot, "acme-widgets-84"), flowId: "aidlc.feature" });
  const state = JSON.parse(fs.readFileSync(path.join(artifactRoot, "acme-widgets-84/state.json"), "utf8"));
  assert.equal(state.flow_run.definition_version, value.version);
  fs.appendFileSync(installedDefinition, " ");
  assert.equal(resolveKitFlowBinding("aidlc.feature", canonicalKitFlowSourceRoots(cwd)), null);
  assert.equal(resolveFlowFilePath("aidlc", "feature", "aidlc.feature", cwd), null);
  assert.equal(isCanonicalRunFlowId("aidlc.feature", cwd), false);
});

test("a valid explicitly declared tracked kit retains precedence over its local installation", { timeout: 60_000 }, (t) => {
  const cwd = workspace(t);
  const installed = install(cwd);
  const tracked = path.join(cwd, "kits/aidlc");
  fs.cpSync(installed, tracked, { recursive: true });
  const file = path.join(tracked, "flows/feature.flow.json");
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...value, version: "tracked" }));
  const binding = resolveKitFlowBinding("aidlc.feature", canonicalKitFlowSourceRoots(cwd));
  assert.equal(binding.definitionPath, file);
  assert.equal(resolveFlowFilePath("aidlc", "feature", "aidlc.feature", cwd), file);
  assert.equal(isCanonicalRunFlowId("aidlc.feature", cwd), true);
});
