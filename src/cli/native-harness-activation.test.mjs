import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

// Consume an npm-packed archive through its public export. The dependency tree is
// supplied from this checkout; this is package-boundary proof, not registry qualification.
let temp, packageRoot, cli, activateNativeHarness;
before(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-native-package-"));
  const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temp], { encoding: "utf8" }));
  const moduleRoot = path.join(temp, "node_modules", "@kontourai");
  fs.mkdirSync(moduleRoot, { recursive: true });
  execFileSync("tar", ["-xzf", path.join(temp, packed[0].filename), "-C", moduleRoot]);
  packageRoot = path.join(moduleRoot, "flow-agents");
  fs.renameSync(path.join(moduleRoot, "package"), packageRoot);
  fs.symlinkSync(path.resolve("node_modules"), path.join(packageRoot, "node_modules"), "dir");
  const loader = path.join(temp, "load.mjs");
  fs.writeFileSync(loader, 'export * from "@kontourai/flow-agents/kit-activation";\n');
  ({ activateNativeHarness } = await import(pathToFileURL(loader)));
  cli = path.join(packageRoot, "build/src/cli.js");
});
after(() => fs.rmSync(temp, { recursive: true, force: true }));

function command(args, cwd = temp) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
}

function fixture(name) {
  const root = path.join(temp, name);
  const source = path.join(root, "source");
  const dest = path.join(root, "project");
  fs.mkdirSync(root, { recursive: true });
  fs.cpSync(path.resolve("evals/fixtures/flow-kit-repository/valid-local-kit"), source, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(source, "kit.json")));
  manifest.skills = [{ id: "example-review", path: "skills/example-review/SKILL.md" }];
  fs.writeFileSync(path.join(source, "kit.json"), JSON.stringify(manifest));
  fs.mkdirSync(path.join(source, "skills/example-review/scripts"), { recursive: true });
  fs.writeFileSync(path.join(source, "skills/example-review/SKILL.md"), "---\nname: example-review\ndescription: Review a change using the installed example workflow.\n---\nRead ../../docs/README.md in the installed kit. Inspect the installed kit with `flow-agents kit list --dest .` before following flows/review.flow.json. Run the sibling scripts/list-installed.mjs with the installed Flow Agents CLI path to inspect registration.\n");
  fs.writeFileSync(path.join(source, "skills/example-review/scripts/list-installed.mjs"), 'import {spawnSync} from "node:child_process"; const r=spawnSync(process.execPath,[process.argv[2],"kit","list","--dest",process.cwd()],{stdio:"inherit"});process.exitCode=r.status??1;\n');
  const install = command(["kit", "install", source, "--dest", dest]);
  assert.equal(install.status, 0, install.stderr);
  return { root, source, dest, installed: path.join(dest, "kits/local/repositories/example-kit") };
}

const layouts = {
  "claude-code": ".claude/skills", codex: ".agents/skills", "kiro-cli": ".kiro/skills",
  "kiro-ide": ".kiro/skills", cursor: ".cursor/skills", opencode: ".opencode/skills",
  "copilot-cli": ".github/skills", vscode: ".github/skills",
};

for (const [surface, skills] of Object.entries(layouts)) test(`packed package activates ${surface} native assets and executable skill companions`, () => {
  const { dest, installed } = fixture(surface);
  fs.writeFileSync(path.join(dest, "AGENTS.md"), "User-owned project instructions\n");
  const result = activateNativeHarness(packageRoot, dest, { surface, kitIdFilter: ["example-kit"] });
  assert.deepEqual(result.errors, []);
  assert.equal(result.runtime_execution, "NOT_VERIFIED");
  assert.equal(result.hook_enforcement, "NOT_INSTALLED");
  assert.equal(fs.readFileSync(path.join(dest, "AGENTS.md"), "utf8"), "User-owned project instructions\n");
  const skill = path.join(dest, skills, "example-review/SKILL.md");
  assert.deepEqual(fs.readFileSync(skill), fs.readFileSync(path.join(installed, "skills/example-review/SKILL.md")));
  const run = spawnSync(process.execPath, [path.join(path.dirname(skill), "scripts/list-installed.mjs"), cli], { cwd: dest, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /example-kit/);
  const flow = path.join(dest, `.kontourai/flow-agents/projections/${surface}/example-kit/flows/review.flow.json`);
  assert.deepEqual(fs.readFileSync(flow), fs.readFileSync(path.join(installed, "flows/review.flow.json")));
  if (surface === "kiro-cli") {
    const agent = JSON.parse(fs.readFileSync(path.join(dest, ".kiro/agents/flow-agents-example-kit.json")));
    assert.deepEqual(agent.resources, ["skill://.kiro/skills/example-review/SKILL.md"]);
    assert.equal(agent.hooks, undefined);
    assert.deepEqual(agent.allowedTools, ["fs_read"]);
  }
  if (surface === "kiro-ide") assert.match(fs.readFileSync(path.join(dest, ".kiro/agents/flow-agents-example-kit.md"), "utf8"), /^---\nname: flow-agents-example-kit/);
  if (surface === "cursor") assert.match(fs.readFileSync(path.join(dest, ".cursor/rules/flow-agents-example-kit.mdc"), "utf8"), /alwaysApply: false/);
});

test("both CLI entry points dispatch native activation and preserve legacy codex-local", () => {
  const { dest } = fixture("cli");
  for (const verb of [["kit", "activate"], ["runtime-adapter", "activate"]]) {
    const result = command([...verb, "--dest", dest, "--adapter", "codex", "--source-root", path.join(temp, "empty-source")]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).selected_adapter, "codex");
  }
  const legacy = command(["kit", "activate", "--dest", dest, "--source-root", path.join(temp, "empty-source")]);
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.equal(JSON.parse(legacy.stdout).selected_adapter, "codex-local");
  const invalid = command(["kit", "activate", "--dest", dest, "--adapter", "unknown"]);
  assert.equal(invalid.status, 2);
});

test("native activation rejects installed drift and duplicate identities before writing", () => {
  const { dest, installed } = fixture("drift");
  fs.appendFileSync(path.join(installed, "skills/example-review/SKILL.md"), "drift\n");
  const result = activateNativeHarness(packageRoot, dest, { surface: "codex", kitIdFilter: ["example-kit"] });
  assert.match(result.errors.join("\n"), /content drift/);
  assert.equal(fs.existsSync(path.join(dest, ".agents")), false);
  const registryPath = path.join(dest, "kits/local/installed-kits.json");
  const registry = JSON.parse(fs.readFileSync(registryPath)); registry.kits.push(registry.kits[0]);
  fs.writeFileSync(registryPath, JSON.stringify(registry));
  assert.match(activateNativeHarness(packageRoot, dest, { surface: "codex" }).errors.join("\n"), /duplicate installed kit identity/);
});

test("unowned user files and dangling symlink ancestors refuse whole activation", () => {
  const { root, dest } = fixture("conflict");
  const userSkill = path.join(dest, ".agents/skills/example-review/SKILL.md");
  fs.mkdirSync(path.dirname(userSkill), { recursive: true }); fs.writeFileSync(userSkill, "User content");
  const result = activateNativeHarness(packageRoot, dest, { surface: "codex", kitIdFilter: ["example-kit"] });
  assert.match(result.errors.join("\n"), /conflict/);
  assert.equal(fs.readFileSync(userSkill, "utf8"), "User content");
  assert.equal(fs.existsSync(path.join(dest, ".kontourai")), false);
  fs.rmSync(path.join(dest, ".agents"), { recursive: true });
  fs.symlinkSync(path.join(root, "missing-outside"), path.join(dest, ".agents"));
  assert.match(activateNativeHarness(packageRoot, dest, { surface: "codex", kitIdFilter: ["example-kit"] }).errors.join("\n"), /symlink/);
  assert.equal(fs.existsSync(path.join(root, "missing-outside")), false);
});

test("owned updates remove only stale unmodified files and preserve shared surfaces", () => {
  const { source, dest } = fixture("update");
  for (const surface of ["copilot-cli", "vscode"]) assert.deepEqual(activateNativeHarness(packageRoot, dest, { surface, kitIdFilter: ["example-kit"] }).errors, []);
  fs.appendFileSync(path.join(source, "skills/example-review/SKILL.md"), "Updated review procedure\n");
  assert.equal(command(["kit", "install", source, "--dest", dest, "--update"]).status, 0);
  const updated = activateNativeHarness(packageRoot, dest, { surface: "copilot-cli", kitIdFilter: ["example-kit"] });
  assert.deepEqual(updated.errors, []);
  assert.deepEqual(new Set(updated.affected_surfaces), new Set(["copilot-cli", "vscode"]));
  assert.match(fs.readFileSync(path.join(dest, ".github/skills/example-review/SKILL.md"), "utf8"), /Updated review procedure/);
  const manifest = JSON.parse(fs.readFileSync(path.join(source, "kit.json")));
  manifest.skills = []; fs.writeFileSync(path.join(source, "kit.json"), JSON.stringify(manifest));
  assert.equal(command(["kit", "install", source, "--dest", dest, "--update"]).status, 0);
  const stale = path.join(dest, ".github/skills/example-review/SKILL.md");
  assert.deepEqual(activateNativeHarness(packageRoot, dest, { surface: "copilot-cli", kitIdFilter: ["example-kit"] }).errors, []);
  assert.equal(fs.existsSync(stale), true, "VSCode still owns shared skill");
  assert.deepEqual(activateNativeHarness(packageRoot, dest, { surface: "vscode", kitIdFilter: ["example-kit"] }).errors, []);
  assert.equal(fs.existsSync(stale), false);
});

test("modified owned and stale files refuse refresh without losing custody", () => {
  const { source, dest } = fixture("modified");
  assert.deepEqual(activateNativeHarness(packageRoot, dest, { surface: "codex", kitIdFilter: ["example-kit"] }).errors, []);
  const skill = path.join(dest, ".agents/skills/example-review/SKILL.md");
  fs.appendFileSync(skill, "User edit\n");
  const ownership = fs.readFileSync(path.join(dest, ".flow-agents/native-harness-activation.json"), "utf8");
  assert.match(activateNativeHarness(packageRoot, dest, { surface: "codex", kitIdFilter: ["example-kit"] }).errors.join("\n"), /conflict/);
  const manifest = JSON.parse(fs.readFileSync(path.join(source, "kit.json"))); manifest.skills = [];
  fs.writeFileSync(path.join(source, "kit.json"), JSON.stringify(manifest));
  assert.equal(command(["kit", "install", source, "--dest", dest, "--update"]).status, 0);
  assert.match(activateNativeHarness(packageRoot, dest, { surface: "codex", kitIdFilter: ["example-kit"] }).errors.join("\n"), /modified stale/);
  assert.equal(fs.readFileSync(path.join(dest, ".flow-agents/native-harness-activation.json"), "utf8"), ownership);
});

test("poisoned ownership paths and final symlinks cannot delete outside the project", () => {
  const { root, dest } = fixture("poison");
  assert.deepEqual(activateNativeHarness(packageRoot, dest, { surface: "codex", kitIdFilter: ["example-kit"] }).errors, []);
  const outside = path.join(root, "outside.md"); fs.writeFileSync(outside, "outside");
  const skill = path.join(dest, ".agents/skills/example-review/SKILL.md");
  fs.unlinkSync(skill); fs.symlinkSync(outside, skill);
  assert.match(activateNativeHarness(packageRoot, dest, { surface: "codex", kitIdFilter: ["example-kit"] }).errors.join("\n"), /symlink/);
  assert.equal(fs.readFileSync(outside, "utf8"), "outside");
  fs.unlinkSync(skill);
  const manifestFile = path.join(dest, ".flow-agents/native-harness-activation.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile)); manifest.files[0].path = "../outside.md";
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.match(activateNativeHarness(packageRoot, dest, { surface: "codex" }).errors.join("\n"), /invalid native projection ownership entry/);
  assert.equal(fs.readFileSync(outside, "utf8"), "outside");
});


test("simultaneous native CLI activations retain both shared surface owners", async () => {
  const { dest } = fixture("concurrent");
  const run = (surface) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "runtime-adapter", "activate", "--adapter", surface, "--dest", dest, "--source-root", path.join(temp, "empty-source")], { stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let errors = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output, errors }));
  });
  const results = await Promise.all([run("copilot-cli"), run("vscode")]);
  for (const result of results) { assert.equal(result.code, 0, result.errors); assert.deepEqual(JSON.parse(result.output).errors, []); }
  const ownership = JSON.parse(fs.readFileSync(path.join(dest, ".flow-agents/native-harness-activation.json")));
  const skill = ownership.files.find((entry) => entry.path === ".github/skills/example-review/SKILL.md");
  assert.deepEqual(new Set(skill.surfaces), new Set(["copilot-cli", "vscode"]));
});
