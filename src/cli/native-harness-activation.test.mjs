import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";

// Consume an npm-packed archive through its public export. The dependency tree is
// supplied from this checkout; this is package-boundary proof, not registry qualification.
let temp, packageRoot, cli, activateNativeHarness;
before(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-native-package-"));
  const archiveName = execFileSync("npm", ["pack", "--ignore-scripts", "--silent", "--pack-destination", temp], { encoding: "utf8" }).trim();
  const moduleRoot = path.join(temp, "node_modules", "@kontourai");
  fs.mkdirSync(moduleRoot, { recursive: true });
  execFileSync("tar", ["-xzf", path.join(temp, archiveName), "-C", moduleRoot]);
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
    const agent = JSON.parse(fs.readFileSync(path.join(dest, ".kiro/agents/flow-agents-example-kit-cli.json")));
    assert.deepEqual(agent.resources, ["skill://.kiro/skills/example-review/SKILL.md"]);
    assert.equal(agent.hooks, undefined);
    assert.deepEqual(agent.allowedTools, ["fs_read"]);
  }
  if (surface === "kiro-ide") assert.match(fs.readFileSync(path.join(dest, ".kiro/agents/flow-agents-example-kit-ide.md"), "utf8"), /^---\nname: flow-agents-example-kit-ide/);
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


test("Kiro CLI and IDE activate distinct native agent identities in one project", () => {
  const { dest } = fixture("kiro-shared-project");
  for (const surface of ["kiro-cli", "kiro-ide"]) assert.deepEqual(activateNativeHarness(packageRoot, dest, { surface, kitIdFilter: ["example-kit"] }).errors, []);
  const agents = path.join(dest, ".kiro/agents");
  assert.deepEqual(fs.readdirSync(agents).sort(), ["flow-agents-example-kit-cli.json", "flow-agents-example-kit-ide.md"]);
  const cliAgent = JSON.parse(fs.readFileSync(path.join(agents, "flow-agents-example-kit-cli.json")));
  const ideAgent = fs.readFileSync(path.join(agents, "flow-agents-example-kit-ide.md"), "utf8");
  assert.equal(cliAgent.name, "flow-agents-example-kit-cli");
  assert.match(ideAgent, /^---\nname: flow-agents-example-kit-ide\n/);
  const ownership = JSON.parse(fs.readFileSync(path.join(dest, ".flow-agents/native-harness-activation.json")));
  const skill = ownership.files.find((entry) => entry.path === ".kiro/skills/example-review/SKILL.md");
  assert.deepEqual(new Set(skill.surfaces), new Set(["kiro-cli", "kiro-ide"]));
});

function installAdditionalKit(root, dest, id, dependencies = []) {
  const source = path.join(root, id);
  fs.cpSync(path.resolve("evals/fixtures/flow-kit-repository/valid-local-kit"), source, { recursive: true });
  const file = path.join(source, "kit.json");
  const manifest = JSON.parse(fs.readFileSync(file));
  manifest.id = id;
  if (dependencies.length) manifest.dependencies = dependencies.map((kit_id) => ({ kit_id }));
  fs.writeFileSync(file, JSON.stringify(manifest));
  const installed = command(["kit", "install", source, "--dest", dest]);
  assert.equal(installed.status, 0, installed.stderr);
  return path.join(dest, "kits/local/repositories", id);
}

test("selected native activation skips unrelated installed drift without modifying its files", () => {
  const { root, dest } = fixture("selected-unrelated-drift");
  const unrelated = installAdditionalKit(root, dest, "unrelated-kit");
  const readme = path.join(unrelated, "docs/README.md");
  fs.appendFileSync(readme, "Unrelated owner edit\n");
  const before = fs.readFileSync(readme);
  const result = activateNativeHarness(packageRoot, dest, { surface: "codex", kitIdFilter: ["example-kit"] });
  assert.deepEqual(result.errors, []);
  assert.match(result.warnings.join("\n"), /unrelated-kit.*outside selected kit\/dependency scope/);
  assert.ok(result.generated_runtime_files.some((file) => file.path === ".agents/skills/example-review/SKILL.md"));
  assert.ok(result.generated_runtime_files.every((file) => file.kit_id === "example-kit"));
  assert.deepEqual(fs.readFileSync(readme), before);
  // Whole-inventory activation still strictly refuses that same drift.
  assert.match(activateNativeHarness(packageRoot, dest, { surface: "codex" }).errors.join("\n"), /unrelated-kit.*content drift/);
});

test("selected native activation requires integrity throughout its transitive dependency closure", () => {
  const { root, source, dest } = fixture("selected-dependency-drift");
  const leaf = installAdditionalKit(root, dest, "leaf-kit");
  installAdditionalKit(root, dest, "dependency-kit", ["leaf-kit"]);
  const file = path.join(source, "kit.json");
  const manifest = JSON.parse(fs.readFileSync(file));
  manifest.dependencies = [{ kit_id: "dependency-kit" }];
  fs.writeFileSync(file, JSON.stringify(manifest));
  assert.equal(command(["kit", "install", source, "--dest", dest, "--update"]).status, 0);
  const healthy = activateNativeHarness(packageRoot, dest, { surface: "codex", kitIdFilter: ["example-kit"] });
  assert.deepEqual(healthy.errors, []);
  assert.deepEqual(new Set(healthy.generated_runtime_files.map((file) => file.kit_id)), new Set(["example-kit", "dependency-kit", "leaf-kit"]));
  const ownership = fs.readFileSync(path.join(dest, ".flow-agents/native-harness-activation.json"));
  fs.appendFileSync(path.join(leaf, "docs/README.md"), "Selected dependency drift\n");
  const refused = activateNativeHarness(packageRoot, dest, { surface: "codex", kitIdFilter: ["example-kit"] });
  assert.match(refused.errors.join("\n"), /leaf-kit.*content drift/);
  assert.deepEqual(refused.generated_runtime_files, []);
  assert.deepEqual(fs.readFileSync(path.join(dest, ".flow-agents/native-harness-activation.json")), ownership);
});

test("unrelated duplicate and malformed registry identities remain global native activation refusals", () => {
  const { root, dest } = fixture("selected-ambiguous-registry");
  installAdditionalKit(root, dest, "unrelated-kit");
  const file = path.join(dest, "kits/local/installed-kits.json");
  const registry = JSON.parse(fs.readFileSync(file));
  const unrelated = registry.kits.find((entry) => entry.id === "unrelated-kit");
  registry.kits.push(unrelated); fs.writeFileSync(file, JSON.stringify(registry));
  assert.match(activateNativeHarness(packageRoot, dest, { surface: "codex", kitIdFilter: ["example-kit"] }).errors.join("\n"), /duplicate installed kit identity 'unrelated-kit'/);
  registry.kits.pop(); registry.kits.push({ ...unrelated, id: "../unrelated-kit" });
  fs.writeFileSync(file, JSON.stringify(registry));
  assert.match(activateNativeHarness(packageRoot, dest, { surface: "codex", kitIdFilter: ["example-kit"] }).errors.join("\n"), /ambiguous kit id/);
  assert.equal(fs.existsSync(path.join(dest, ".agents")), false);
});

function treeDigest(root) {
  const hash = createHash("sha256");
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      hash.update(path.relative(root, file));
      if (entry.isDirectory()) walk(file);
      else if (entry.isSymbolicLink()) hash.update(fs.readlinkSync(file));
      else hash.update(fs.readFileSync(file));
    }
  };
  walk(root);
  return hash.digest("hex");
}

test("packed SDK projects a selected external kit and dependencies into a separate app with a usable bound launcher", () => {
  const { root, source, dest: bootstrap, installed } = fixture("separate-project");
  const leaf = installAdditionalKit(root, bootstrap, "leaf-kit");
  installAdditionalKit(root, bootstrap, "dependency-kit", ["leaf-kit"]);
  installAdditionalKit(root, bootstrap, "unselected-kit");
  const kitFile = path.join(source, "kit.json");
  const kit = JSON.parse(fs.readFileSync(kitFile)); kit.dependencies = [{ kit_id: "dependency-kit" }];
  fs.writeFileSync(kitFile, JSON.stringify(kit));
  assert.equal(command(["kit", "install", source, "--dest", bootstrap, "--update"]).status, 0);
  const project = path.join(root, "application with spaces");
  fs.mkdirSync(project); fs.writeFileSync(path.join(project, "AGENTS.md"), "Application-owned instructions\n");
  fs.mkdirSync(path.join(bootstrap, "node_modules"));
  fs.writeFileSync(path.join(bootstrap, "node_modules/tooling-only.txt"), "Bootstrap tooling stays here\n");
  const before = treeDigest(bootstrap);
  const registryBefore = fs.readFileSync(path.join(bootstrap, "kits/local/installed-kits.json"));
  const receipt = activateNativeHarness(packageRoot, bootstrap, { surface: "codex", targetRoot: project, kitIdFilter: ["example-kit"] });
  assert.deepEqual(receipt.errors, []);
  assert.equal(receipt.installed_root, bootstrap); assert.equal(receipt.target_root, project);
  assert.equal(receipt.runtime_cli, fs.realpathSync(cli)); assert.deepEqual(receipt.runtime_argv, [process.execPath, fs.realpathSync(cli)]);
  assert.notEqual(receipt.runtime_argv[1], process.argv[1], "launcher is derived from the published SDK, not its caller");
  assert.deepEqual(new Set(receipt.generated_runtime_files.map((file) => file.kit_id)), new Set(["example-kit", "dependency-kit", "leaf-kit"]));
  for (const file of receipt.generated_runtime_files) {
    assert.ok(file.source_path.startsWith(path.join(bootstrap, "kits/local/repositories") + path.sep));
    assert.equal(fs.existsSync(file.source_path), true);
    assert.equal(file.source_path.includes("flow-agents-kit-activation-"), false);
    assert.equal(fs.existsSync(path.join(project, file.path)), true);
  }
  const skill = fs.readFileSync(path.join(project, ".agents/skills/example-review/SKILL.md"), "utf8");
  const original = fs.readFileSync(path.join(installed, "skills/example-review/SKILL.md"), "utf8");
  const frontmatter = /^---\n[\s\S]*?\n---\n/.exec(original)[0];
  assert.ok(skill.startsWith(frontmatter)); assert.ok(skill.endsWith(original.slice(frontmatter.length)));
  const header = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(skill)[1]);
  assert.equal(header.installed_root, bootstrap); assert.equal(header.installed_kit_root, installed);
  assert.equal(header.source_path, path.join(installed, "skills/example-review/SKILL.md"));
  assert.deepEqual(header.runtime_argv, receipt.runtime_argv);
  const run = spawnSync(header.runtime_argv[0], [...header.runtime_argv.slice(1), "kit", "list", "--dest", header.installed_root], { cwd: project, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /example-kit/);
  const ownership = JSON.parse(fs.readFileSync(path.join(project, ".flow-agents/native-harness-activation.json")));
  assert.equal(ownership.installed_root, bootstrap); assert.deepEqual(ownership.runtime_argv, receipt.runtime_argv);
  assert.ok(ownership.files.every((file) => file.installed_root === bootstrap && file.source_path.startsWith(bootstrap + path.sep)));
  assert.deepEqual(fs.readFileSync(path.join(project, ".kontourai/flow-agents/projections/codex/leaf-kit/docs/README.md")), fs.readFileSync(path.join(leaf, "docs/README.md")));
  assert.equal(fs.existsSync(path.join(project, "node_modules")), false); assert.equal(fs.existsSync(path.join(project, "kits")), false);
  assert.equal(fs.readFileSync(path.join(project, "AGENTS.md"), "utf8"), "Application-owned instructions\n");
  assert.deepEqual(fs.readFileSync(path.join(bootstrap, "kits/local/installed-kits.json")), registryBefore);
  assert.equal(treeDigest(bootstrap), before, "activation never writes back to the bootstrap");
});

test("both packed public CLIs support separate --target and selected --kits including dependency expansion", () => {
  const { root, source, dest: bootstrap } = fixture("separate-cli");
  installAdditionalKit(root, bootstrap, "dependency-kit");
  const file = path.join(source, "kit.json"), kit = JSON.parse(fs.readFileSync(file));
  kit.dependencies = [{ kit_id: "dependency-kit" }]; fs.writeFileSync(file, JSON.stringify(kit));
  assert.equal(command(["kit", "install", source, "--dest", bootstrap, "--update"]).status, 0);
  installAdditionalKit(root, bootstrap, "unselected-kit");
  const before = treeDigest(bootstrap);
  for (const [index, prefix] of [["kit", "activate"], ["runtime-adapter", "activate"]].entries()) {
    const project = path.join(root, `application-${index}`);
    const result = command([...prefix, "--dest", bootstrap, "--target", project, "--adapter", "claude-code", "--kits", "example-kit", "--source-root", packageRoot]);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.target_root, project);
    assert.deepEqual(new Set(receipt.generated_runtime_files.map((entry) => entry.kit_id)), new Set(["example-kit", "dependency-kit"]));
    assert.equal(fs.existsSync(path.join(project, ".claude/skills/example-review/SKILL.md")), true);
  }
  assert.equal(treeDigest(bootstrap), before);
  for (const flags of [["--target", path.join(root, "invalid"), "--adapter", "codex-local"], ["--adapter", "codex", "--kits", "example-kit,"], ["--adapter", "codex", "--target"], ["--adapter", "codex", "--kits", "example-kit", "--kits", "dependency-kit"]]) {
    const result = command(["kit", "activate", "--dest", bootstrap, ...flags]);
    assert.equal(result.status, 2, result.stderr);
  }
});

test("separate target preserves unowned conflicts and modified owned files without bootstrap mutation", () => {
  const { root, dest: bootstrap } = fixture("separate-conflicts");
  const project = path.join(root, "application");
  const skill = path.join(project, ".agents/skills/example-review/SKILL.md");
  fs.mkdirSync(path.dirname(skill), { recursive: true }); fs.writeFileSync(skill, "User-owned skill\n");
  const before = treeDigest(bootstrap);
  const options = { surface: "codex", targetRoot: project, kitIdFilter: ["example-kit"] };
  assert.match(activateNativeHarness(packageRoot, bootstrap, options).errors.join("\n"), /conflict/);
  assert.equal(fs.readFileSync(skill, "utf8"), "User-owned skill\n");
  fs.unlinkSync(skill);
  assert.deepEqual(activateNativeHarness(packageRoot, bootstrap, options).errors, []);
  fs.appendFileSync(skill, "User edit\n");
  const ownership = fs.readFileSync(path.join(project, ".flow-agents/native-harness-activation.json"));
  assert.match(activateNativeHarness(packageRoot, bootstrap, options).errors.join("\n"), /conflict/);
  assert.deepEqual(fs.readFileSync(path.join(project, ".flow-agents/native-harness-activation.json")), ownership);
  assert.equal(fs.readFileSync(skill, "utf8").endsWith("User edit\n"), true);
  assert.equal(treeDigest(bootstrap), before);
});

test("separate target rejects symlinks and overlapping bootstrap/application roots", () => {
  const { root, dest: bootstrap, installed } = fixture("separate-fences");
  const project = path.join(root, "application"), outside = path.join(root, "outside");
  fs.mkdirSync(project); fs.mkdirSync(outside); fs.symlinkSync(outside, path.join(project, ".agents"));
  const before = treeDigest(bootstrap);
  assert.match(activateNativeHarness(packageRoot, bootstrap, { surface: "codex", targetRoot: project, kitIdFilter: ["example-kit"] }).errors.join("\n"), /symlink/);
  assert.deepEqual(fs.readdirSync(outside), []);
  for (const targetRoot of [installed, root]) assert.match(activateNativeHarness(packageRoot, bootstrap, { surface: "codex", targetRoot, kitIdFilter: ["example-kit"] }).errors.join("\n"), /overlapping paths/);
  assert.equal(treeDigest(bootstrap), before);
});

test("first-run target creation accepts concurrent directories and rejects concurrent symlink/file collisions", () => {
  const { root, dest: bootstrap } = fixture("separate-create-race");
  const original = fs.mkdirSync;
  for (const collision of ["directory", "symlink", "file"]) {
    const project = path.join(root, `application-${collision}`), physicalProject = path.join(fs.realpathSync(root), `application-${collision}`);
    let injected = false;
    fs.mkdirSync = (directory, ...args) => {
      if (path.resolve(String(directory)) === physicalProject && !injected) {
        injected = true;
        if (collision === "directory") original(directory);
        else if (collision === "symlink") fs.symlinkSync(bootstrap, directory);
        else fs.writeFileSync(directory, "Concurrent owner file\n");
      }
      return original(directory, ...args);
    };
    syncBuiltinESMExports();
    let receipt;
    try { receipt = activateNativeHarness(packageRoot, bootstrap, { surface: "codex", targetRoot: project, kitIdFilter: ["example-kit"] }); }
    finally { fs.mkdirSync = original; syncBuiltinESMExports(); }
    assert.equal(injected, true);
    if (collision === "directory") {
      assert.deepEqual(receipt.errors, []);
      assert.equal(fs.existsSync(path.join(project, ".agents/skills/example-review/SKILL.md")), true);
    } else {
      assert.match(receipt.errors.join("\n"), collision === "symlink" ? /symlink/ : /not a directory/);
      assert.deepEqual(receipt.generated_runtime_files, []);
      assert.equal(fs.existsSync(path.join(bootstrap, ".agents")), false);
    }
  }
});

test("physically identical explicit target preserves same-root skill content", () => {
  const { dest: bootstrap, installed } = fixture("same-root-alias");
  const receipt = activateNativeHarness(packageRoot, bootstrap, { surface: "codex", targetRoot: fs.realpathSync(bootstrap), kitIdFilter: ["example-kit"] });
  assert.deepEqual(receipt.errors, []);
  assert.deepEqual(fs.readFileSync(path.join(bootstrap, ".agents/skills/example-review/SKILL.md")), fs.readFileSync(path.join(installed, "skills/example-review/SKILL.md")));
});

test("packed public CLI resolves selected builtin dependencies from its own catalog without source-root flags", () => {
  const { root, source, dest: bootstrap } = fixture("default-public-catalog");
  const file = path.join(source, "kit.json"), kit = JSON.parse(fs.readFileSync(file));
  kit.dependencies = [{ kit_id: "knowledge" }]; fs.writeFileSync(file, JSON.stringify(kit));
  assert.equal(command(["kit", "install", source, "--dest", bootstrap, "--update"]).status, 0);
  const before = treeDigest(bootstrap);
  for (const [index, prefix] of [["kit", "activate"], ["runtime-adapter", "activate"]].entries()) {
    const project = path.join(root, `application-${index}`);
    const result = command([...prefix, "--dest", bootstrap, "--target", project, "--adapter", "codex", "--kits", "example-kit"]);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.deepEqual(new Set(receipt.generated_runtime_files.map((entry) => entry.kit_id)), new Set(["example-kit", "knowledge"]));
    const skill = receipt.generated_runtime_files.find((entry) => entry.kit_id === "knowledge" && entry.path.endsWith("/SKILL.md"));
    assert.ok(skill);
    assert.ok(skill.source_path.startsWith(path.join(fs.realpathSync(packageRoot), "kits/knowledge") + path.sep));
    const text = fs.readFileSync(path.join(project, skill.path), "utf8");
    const header = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text)[1]);
    assert.equal(header.installed_kit_root, path.join(fs.realpathSync(packageRoot), "kits/knowledge"));
    assert.equal(fs.existsSync(path.join(project, "node_modules")), false);
  }
  const override = command(["kit", "activate", "--dest", bootstrap, "--target", path.join(root, "override-project"), "--adapter", "codex", "--kits", "example-kit", "--source-root", path.join(root, "empty-catalog")]);
  assert.equal(override.status, 1);
  assert.match(JSON.parse(override.stdout).errors.join("\n"), /knowledge.*not installed or activated/);
  assert.equal(fs.existsSync(path.join(root, "override-project")), false);
  assert.equal(treeDigest(bootstrap), before);
});
