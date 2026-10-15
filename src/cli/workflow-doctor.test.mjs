// `workflow doctor` checks the kits an install actually activates, and judges a current run by
// whether its declared source resolves, rather than one kit's hardcoded definition list.
//
// Doctor used to read only the Builder kit and only two of its flows. A non-Builder kit's drift
// went unreported, and a current run on any other flow (including Builder's own build-lean,
// review-existing and publish-learn) was reported as an "unsupported Flow definition".
//
// The non-Builder kit here is the packaged Knowledge kit: doctor compares installed bytes with
// the bytes the executing package ships, so only a shipped kit has a comparison to make.
// Run: `npm run test:unit`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = path.join(repoRoot, "build", "src", "cli.js");
const version = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

/** A project whose install record activates `activeKitIds`, each copied from the package. */
function makeInstall(prefix, activeKitIds) {
  const project = fs.realpathSync(makeFixtureDir(prefix));
  writeJson(path.join(project, ".flow-agents", "install.json"), { version, runtime: "base", active_kit_ids: activeKitIds });
  for (const id of activeKitIds) fs.cpSync(path.join(repoRoot, "kits", id), path.join(project, "kits", id), { recursive: true });
  return project;
}

function withCurrentRun(project, flowRun) {
  const artifactRoot = path.join(project, ".kontourai", "flow-agents");
  writeJson(path.join(artifactRoot, "current.json"), { active_slug: "doctor-run", artifact_dir: "doctor-run" });
  writeJson(path.join(artifactRoot, "doctor-run", "state.json"), { schema_version: "1.0", task_slug: "doctor-run", flow_run: flowRun });
}

function doctor(project) {
  const result = spawnSync(process.execPath, [
    cli, "workflow", "doctor", "--project-root", project,
    "--artifact-root", path.join(project, ".kontourai", "flow-agents"), "--json",
  ], { cwd: project, encoding: "utf8" });
  assert.ok(result.status === 0 || result.status === 2, `doctor crashed (${result.status}): ${result.stderr}`);
  return JSON.parse(result.stdout);
}

/** Kit and definition warnings only; the fixture installs no hooks, so those warnings are expected. */
function kitWarnings(report) {
  return report.warnings.filter((warning) => warning.startsWith("Activated ") || /^Installed (?!hook\/writer)/.test(warning));
}

function packagedVersion(kitId, flowName) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, "kits", kitId, "flows", `${flowName}.flow.json`), "utf8")).version;
}

test("doctor checks an active non-Builder kit's declared definitions and reports their drift", () => {
  const project = makeInstall("doctor-knowledge-", ["knowledge"]);
  try {
    const healthy = doctor(project);
    assert.deepEqual(healthy.kits.map((kit) => kit.id), ["knowledge"]);
    assert.equal(healthy.kit.id, "knowledge", "`kit` reports the first checked kit");
    const declared = JSON.parse(fs.readFileSync(path.join(repoRoot, "kits", "knowledge", "kit.json"), "utf8")).flows.map((flow) => flow.id);
    assert.deepEqual(healthy.definitions.map((definition) => definition.id), declared, "every flow the kit declares is checked");
    assert.ok(healthy.definitions.every((definition) => definition.installed_valid), JSON.stringify(healthy.definitions));
    assert.deepEqual(kitWarnings(healthy), []);

    // Drift: one definition's version differs, another is gone, and the manifest is edited.
    const ingest = path.join(project, "kits", "knowledge", "flows", "ingest.flow.json");
    writeJson(ingest, { ...JSON.parse(fs.readFileSync(ingest, "utf8")), version: "0.1" });
    fs.rmSync(path.join(project, "kits", "knowledge", "flows", "compile.flow.json"));
    const manifest = path.join(project, "kits", "knowledge", "kit.json");
    writeJson(manifest, { ...JSON.parse(fs.readFileSync(manifest, "utf8")), schema_version: "0.9" });

    const drifted = doctor(project);
    assert.equal(drifted.ok, false);
    const has = (text) => drifted.warnings.some((warning) => warning.includes(text));
    assert.ok(has(`Installed knowledge.ingest version 0.1 differs from CLI version ${packagedVersion("knowledge", "ingest")}`), drifted.warnings.join("\n"));
    assert.ok(has(`Activated knowledge.compile definition is missing at ${path.join(project, "kits", "knowledge", "flows", "compile.flow.json")}`), drifted.warnings.join("\n"));
    assert.ok(has("Installed Knowledge Kit schema 0.9 differs from CLI schema 1.0"), drifted.warnings.join("\n"));
    assert.ok(drifted.remediation.includes("'--activate-kit' 'knowledge'"), drifted.remediation);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("doctor locates the current run's declared source and reports missing sources or version skew", () => {
  const project = makeInstall("doctor-current-", ["builder", "knowledge"]);
  try {
    // Source lookup covers Builder flows beyond build/shape and a non-Builder flow. This does
    // not claim that the flow supplies the producer bindings required for runtime admission.
    for (const [flowId, kitId, flowName] of [
      ["builder.build-lean", "builder", "build-lean"],
      ["builder.review-existing", "builder", "review-existing"],
      ["knowledge.ingest", "knowledge", "ingest"],
    ]) {
      withCurrentRun(project, { definition_id: flowId, definition_version: packagedVersion(kitId, flowName) });
      const report = doctor(project);
      assert.equal(report.definition.id, flowId);
      assert.deepEqual(report.warnings.filter((warning) => warning.startsWith("Current run")), [], `${flowId}: ${report.warnings.join("\n")}`);
    }

    // A version skew on a non-build/shape flow is reported against the version the CLI binds.
    withCurrentRun(project, { definition_id: "builder.build-lean", definition_version: "0.9" });
    const skewed = doctor(project);
    assert.ok(skewed.warnings.includes(`Current run uses builder.build-lean@0.9 while CLI resolves builder.build-lean@${packagedVersion("builder", "build-lean")}; recover or migrate before mutation.`), skewed.warnings.join("\n"));

    // Fail closed: a flow no kit declares is still unsupported.
    withCurrentRun(project, { definition_id: "nokit.ghost", definition_version: "1.0" });
    const unsupported = doctor(project);
    assert.ok(unsupported.warnings.includes("Current run uses unsupported Flow definition nokit.ghost; recover or migrate before mutation."), unsupported.warnings.join("\n"));

    // A project-owned declaration is a binding source even when the package ships no such kit.
    writeJson(path.join(project, "kits", "localprobe", "kit.json"), {
      id: "localprobe", flows: [{ id: "localprobe.check", path: "flows/check.flow.json" }],
    });
    writeJson(path.join(project, "kits", "localprobe", "flows", "check.flow.json"), {
      id: "localprobe.check", version: "2.0", steps: [{ id: "done", next: null }],
    });
    withCurrentRun(project, { definition_id: "localprobe.check", definition_version: "2.0" });
    const local = doctor(project);
    assert.equal(local.definition.id, "localprobe.check");
    assert.deepEqual(local.warnings.filter((warning) => warning.startsWith("Current run")), []);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("doctor checks copied inactive packaged kits without activating them", () => {
  const project = makeInstall("doctor-inactive-", []);
  try {
    fs.cpSync(path.join(repoRoot, "kits", "knowledge"), path.join(project, "kits", "knowledge"), { recursive: true });
    const manifest = path.join(project, "kits", "knowledge", "kit.json");
    writeJson(manifest, { ...JSON.parse(fs.readFileSync(manifest, "utf8")), description: "project drift" });
    const report = doctor(project);
    assert.deepEqual(report.installed.active_kit_ids, []);
    assert.deepEqual(report.kits.map((kit) => kit.id), ["knowledge"]);
    assert.ok(report.warnings.some((warning) => warning.startsWith("Installed Knowledge Kit content differs")), report.warnings.join("\n"));
    assert.ok(!report.warnings.some((warning) => warning.startsWith("Activated ")), report.warnings.join("\n"));
    assert.ok(!report.remediation.includes("'--activate-kit'"), report.remediation);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("doctor keeps its Builder report and default definition for a Builder install", () => {
  const project = makeInstall("doctor-builder-", ["builder"]);
  try {
    const report = doctor(project);
    assert.equal(report.kit.id, "builder");
    assert.equal(report.kit.source, path.join(project, "kits", "builder", "kit.json"));
    assert.deepEqual(report.kits.map((kit) => kit.id), ["builder"]);
    // No current run: the definition a bare `workflow start` would bind.
    assert.deepEqual(report.definition, { id: "builder.build", version: packagedVersion("builder", "build") });
    // The composition fragment validates only through its parent; byte identity stands in for it.
    const publishLearn = report.definitions.find((definition) => definition.id === "builder.publish-learn");
    assert.equal(publishLearn?.installed_valid, true);
    assert.deepEqual(kitWarnings(report), []);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("doctor refuses an active kit id that is neither shipped nor installed", () => {
  const project = makeInstall("doctor-unknown-", []);
  try {
    writeJson(path.join(project, ".flow-agents", "install.json"), { version, runtime: "base", active_kit_ids: ["ghost-kit", "../escape"] });
    const report = doctor(project);
    assert.equal(report.ok, false);
    assert.ok(report.warnings.some((warning) => warning.startsWith(`Activated kit ghost-kit is neither shipped by Flow Agents ${version} nor an installed local kit.`)), report.warnings.join("\n"));
    assert.ok(report.warnings.some((warning) => warning.startsWith('Activated kit id "../escape" is not a valid kit id.')), report.warnings.join("\n"));
    assert.deepEqual(report.kits, []);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});
