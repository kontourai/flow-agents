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
  const source=path.join(cwd,'.fixture-sources/portable');fs.mkdirSync(path.join(source,'flows'),{recursive:true});fs.mkdirSync(path.join(source,'skills/check'),{recursive:true});
  fs.writeFileSync(path.join(source,'skills/check/SKILL.md'),'# Check\n\nInspect the current input and retain observed evidence.\n');
  const profiles=['feature','bugfix'],expectation='check-completion',artifact='<slug>--check.json';
  const actions=profiles.map(profile=>({flow_id:`portable.${profile}`,step_id:'check',skills:['check'],implementation_allowed:false,artifacts:[artifact],expectation_ids:[expectation],expectation_bindings:[{expectation_id:expectation,interface:'workflow.evidence'}],artifact_bindings:[{artifact,expectation_ids:[expectation]}]}));
  const manifest={schema_version:'1.0',id:'portable',name:'Portable Fixture',flows:profiles.map(profile=>({id:`portable.${profile}`,path:`flows/${profile}.flow.json`})),skills:[{id:'portable.check',path:'skills/check/SKILL.md'}],flow_step_actions:actions,skill_roles:[{skill_id:'portable.check',role:'step',flow_id:'portable.feature',flow_ids:['portable.bugfix'],step_ids:['check'],expectation_ids:[expectation],artifacts:[artifact]}]};
  fs.writeFileSync(path.join(source,'kit.json'),JSON.stringify(manifest));
  for(const profile of profiles)fs.writeFileSync(path.join(source,`flows/${profile}.flow.json`),JSON.stringify({id:`portable.${profile}`,version:'1.0',steps:[{id:'check',next:null,needs:[]}],phase_map:{check:'check'},gates:{'check-gate':{step:'check',expects:[{id:expectation,kind:'trust.bundle',required:true,description:'Retained current check',bundle_claim:{claimType:'portable.check',subjectId:`portable.${profile}/check`,accepted_statuses:['verified']}}],on_route_back:{default:'check'},route_back_policy:{max_attempts:2,on_exceeded:'block'}}}}));
  command(CLI,['kit','install',source,'--dest',cwd],cwd);
  return path.join(cwd,'kits/local/repositories/portable');
}

test("a publicly installed standalone kit declares runnable profiles and starts pinned canonical sessions", { timeout: 60_000 }, async (t) => {
  const cwd = workspace(t);
  const installed = install(cwd);
  command(CLI, ["kit", "activate", "--adapter", "codex-local", "--dest", cwd, "--source-root", ROOT], cwd);
  const manifest = JSON.parse(fs.readFileSync(path.join(installed, "kit.json"), "utf8"));
  const ids = manifest.flows.map((flow) => flow.id).sort();
  assert.equal(ids.length, 2);
  assert.deepEqual(canonicalRunFlowIds(cwd).filter((id) => id.startsWith("portable.")), ids);
  assert.deepEqual(declaredKitFlowIds(cwd).filter((id) => id.startsWith("portable.")), ids);
  assert.equal(fs.existsSync(path.join(cwd, "kits/portable")), false, "installation does not mirror into a privileged kit path");
  const digests = [];
  for (const [flowId, workItem, slug] of [["portable.feature", "acme/widgets#81", "acme-widgets-81"], ["portable.bugfix", "acme/widgets#82", "acme-widgets-82"]]) {
    const binding = resolveKitFlowBinding(flowId, canonicalKitFlowSourceRoots(cwd));
    assert.equal(binding.sourceRoot, cwd);
    assert.equal(binding.flowRelativePath, `kits/local/repositories/portable/flows/${flowId.split(".")[1]}.flow.json`);
    assert.equal(resolveFlowFilePath("portable", flowId.split(".")[1], flowId, cwd), binding.definitionPath);
    const artifactRoot = path.join(cwd, ".kontourai/flow-agents");
    command(SIDECAR, ["ensure-session", "--artifact-root", artifactRoot, "--work-item", workItem, "--flow-id", flowId, "--source-request", "synthetic installed-kit fixture", "--summary", "synthetic installed-kit fixture"], cwd);
    const sessionDir = path.join(artifactRoot, slug);
    const started = await startBuilderFlowSession({ sessionDir, flowId });
    assert.ok(started.gateActionEnvelope.action.skills.length > 0, "installed stage exposes executable skill instructions");
    for (const skill of started.gateActionEnvelope.action.skills) {
      assert.ok(skill.path.startsWith("kits/local/repositories/portable/"));
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
    assert.equal(resolveKitFlowBinding("portable.feature", canonicalKitFlowSourceRoots(cwd)), null);
    assert.equal(isCanonicalRunFlowId("portable.feature", cwd), false);
    assert.equal(declaredKitFlowIds(cwd).includes("portable.feature"), false);
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
  fs.copyFileSync(path.join(cwd, "kits/local/repositories/portable/flows/feature.flow.json"), path.join(override, "portable.feature.flow.json"));
  const prior = process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
  process.env.FLOW_AGENTS_FLOW_DEFS_DIR = override;
  try {
    const result = spawnSync(process.execPath, [SIDECAR, "ensure-session", "--artifact-root", path.join(cwd, ".kontourai/flow-agents"), "--work-item", "acme/widgets#83", "--flow-id", "portable.feature", "--source-request", "fixture", "--summary", "fixture"], { cwd, encoding: "utf8", timeout: 30_000 });
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
  const decoy = path.join(cwd, "kits/portable/flows/feature.flow.json");
  fs.mkdirSync(path.dirname(decoy), { recursive: true });
  const value = JSON.parse(fs.readFileSync(installedDefinition, "utf8"));
  fs.writeFileSync(decoy, JSON.stringify({ ...value, version: "decoy" }));
  const binding = resolveKitFlowBinding("portable.feature", canonicalKitFlowSourceRoots(cwd));
  assert.equal(binding.definitionPath, installedDefinition);
  assert.equal(resolveFlowFilePath("portable", "feature", "portable.feature", cwd), installedDefinition);
  assert.equal(declaredKitFlows(cwd).find((entry) => entry.flowId === "portable.feature").via, "manifest");
  assert.equal(isCanonicalRunFlowId("portable.feature", cwd), true);
  const artifactRoot = path.join(cwd, ".kontourai/flow-agents");
  command(SIDECAR, ["ensure-session", "--artifact-root", artifactRoot, "--work-item", "acme/widgets#84", "--flow-id", "portable.feature", "--source-request", "decoy fixture", "--summary", "decoy fixture"], cwd);
  await startBuilderFlowSession({ sessionDir: path.join(artifactRoot, "acme-widgets-84"), flowId: "portable.feature" });
  const state = JSON.parse(fs.readFileSync(path.join(artifactRoot, "acme-widgets-84/state.json"), "utf8"));
  assert.equal(state.flow_run.definition_version, value.version);
  fs.appendFileSync(installedDefinition, " ");
  assert.equal(resolveKitFlowBinding("portable.feature", canonicalKitFlowSourceRoots(cwd)), null);
  assert.equal(resolveFlowFilePath("portable", "feature", "portable.feature", cwd), null);
  assert.equal(isCanonicalRunFlowId("portable.feature", cwd), false);
});

test("a valid explicitly declared tracked kit retains precedence over its local installation", { timeout: 60_000 }, (t) => {
  const cwd = workspace(t);
  const installed = install(cwd);
  const tracked = path.join(cwd, "kits/portable");
  fs.cpSync(installed, tracked, { recursive: true });
  const file = path.join(tracked, "flows/feature.flow.json");
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...value, version: "tracked" }));
  const binding = resolveKitFlowBinding("portable.feature", canonicalKitFlowSourceRoots(cwd));
  assert.equal(binding.definitionPath, file);
  assert.equal(resolveFlowFilePath("portable", "feature", "portable.feature", cwd), file);
  assert.equal(isCanonicalRunFlowId("portable.feature", cwd), true);
});
