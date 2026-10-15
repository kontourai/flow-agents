/**
 * fixture-kit-package — non-Builder fixture kits, and a fixture PACKAGE that ships only them.
 *
 * Kit-declared engine behaviour (a flow's start contract, the kit's `default_flow`) must be proven
 * on a kit that is not Builder. Two things make that awkward at the CLI seam:
 *
 *  - The executing package is always the first kit source root, and the real package ships the
 *    Builder kit, so a project kit can never stand in for a PACKAGED declaration.
 *  - `packagedKitRoot` walks up from the module that is running, so pointing it elsewhere means
 *    running a different copy of the compiled CLI.
 *
 * `makeFixturePackage` therefore builds a package root whose `kits/` holds only the supplied
 * fixture kits: it COPIES `build/` (so the running module's own path lands inside the fixture;
 * a symlink would resolve back to the real package) and symlinks every other top-level entry the
 * runtime reads from its package root.
 *
 * The kit shapes are copied from kits/builder (flows[], flow_step_actions with
 * expectation_bindings and artifact_bindings, step skill_roles, skills with a SKILL.md), so the
 * run adapter binds them exactly as it binds a real kit.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** Entries the fixture package must own rather than link: its kits, its compiled code, its identity. */
const OWNED_ENTRIES = new Set(["build", "kits", "package.json", ".git"]);

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function gatedFlow(flowId, stepId, expectation) {
  return {
    id: flowId,
    version: "1.0",
    steps: [{ id: stepId, next: "closeout" }, { id: "closeout", next: null }],
    phase_map: { [stepId]: stepId, closeout: "closeout" },
    gates: {
      [`${stepId}-gate`]: {
        step: stepId,
        on_route_back: { missing_evidence: stepId },
        route_back_policy: { max_attempts: 3, on_exceeded: "block" },
        expects: [{ kind: "trust.bundle", required: true, ...expectation }],
      },
    },
  };
}

/**
 * A two-flow kit that is not Builder:
 *   `<kit>.survey`  — gates on its own record and declares NO `selected-work` expectation, so it
 *                     selects no Work Item (the shape `builder.shape` has);
 *   `<kit>.deliver` — gates on `selected-work`, so it is Work-Item driven (the shape `builder.build` has).
 * `defaultFlow`, when given, is declared as the kit's `default_flow`.
 */
export function fixtureKit(kitId, { defaultFlow } = {}) {
  const flows = {
    survey: gatedFlow(`${kitId}.survey`, "survey", {
      id: "survey-record",
      description: "The surveyed area is recorded.",
      bundle_claim: { claimType: `${kitId}.survey.recorded`, subjectType: "flow-step", accepted_statuses: ["verified"] },
    }),
    deliver: gatedFlow(`${kitId}.deliver`, "select", {
      id: "selected-work",
      description: "A ready work item is selected with scope and acceptance context.",
      bundle_claim: { claimType: `${kitId}.select.selected`, subjectType: "work-item", accepted_statuses: ["verified"] },
    }),
  };
  const action = (flowName, stepId, skill, expectationId) => ({
    flow_id: `${kitId}.${flowName}`,
    step_id: stepId,
    skills: [skill],
    implementation_allowed: false,
    artifacts: [`<slug>--${skill}.md`],
    expectation_ids: [expectationId],
    expectation_bindings: [{ expectation_id: expectationId, interface: "workflow.evidence" }],
    artifact_bindings: [{ artifact: `<slug>--${skill}.md`, expectation_ids: [expectationId] }],
  });
  const role = (flowName, stepId, skill, expectationId) => ({
    skill_id: `${kitId}.${skill}`,
    role: "step",
    flow_id: `${kitId}.${flowName}`,
    step_ids: [stepId],
    artifacts: [`<slug>--${skill}.md`],
    expectation_ids: [expectationId],
  });
  const manifest = {
    schema_version: "1.0",
    id: kitId,
    name: `${kitId} kit`,
    description: `Fixture kit ${kitId}.`,
    flows: [
      { id: `${kitId}.survey`, path: "flows/survey.flow.json", description: "Survey without selecting a Work Item." },
      { id: `${kitId}.deliver`, path: "flows/deliver.flow.json", description: "Deliver a selected Work Item." },
    ],
    ...(defaultFlow ? { default_flow: defaultFlow } : {}),
    flow_step_actions: [
      action("survey", "survey", `${kitId}-survey`, "survey-record"),
      action("deliver", "select", `${kitId}-select`, "selected-work"),
    ],
    skill_roles: [
      role("survey", "survey", `${kitId}-survey`, "survey-record"),
      role("deliver", "select", `${kitId}-select`, "selected-work"),
    ],
    skills: [
      { id: `${kitId}.${kitId}-survey`, path: `skills/${kitId}-survey/SKILL.md`, description: "Fixture survey skill." },
      { id: `${kitId}.${kitId}-select`, path: `skills/${kitId}-select/SKILL.md`, description: "Fixture selection skill." },
    ],
  };
  return { manifest, flows };
}

/** Write `kits/<kitId>/` (manifest, flow definitions, skill sources) under `root`. */
export function writeKit(root, kitId, { manifest, flows }) {
  const kitDir = path.join(root, "kits", kitId);
  writeJson(path.join(kitDir, "kit.json"), manifest);
  for (const [flowName, definition] of Object.entries(flows)) writeJson(path.join(kitDir, "flows", `${flowName}.flow.json`), definition);
  for (const skill of manifest.skills ?? []) {
    const file = path.join(kitDir, skill.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `# ${skill.id}\n\nFixture skill.\n`);
  }
}

/** A git-initialized project directory with one empty commit, optionally carrying kits. */
export function makeFixtureProject(prefix, kits = {}) {
  const project = fs.realpathSync(makeFixtureDir(prefix));
  spawnSync("git", ["init", "-q", "."], { cwd: project });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: project });
  for (const [kitId, kit] of Object.entries(kits)) writeKit(project, kitId, kit);
  return project;
}

/**
 * A package root whose `kits/` holds exactly `kits` (no Builder kit), with its own copy of the
 * compiled CLI. Returns the root and the paths of its CLI entry points.
 */
export function makeFixturePackage(prefix, kits) {
  const root = fs.realpathSync(makeFixtureDir(prefix));
  for (const entry of fs.readdirSync(REPO_ROOT)) {
    if (OWNED_ENTRIES.has(entry)) continue;
    fs.symlinkSync(path.join(REPO_ROOT, entry), path.join(root, entry));
  }
  fs.copyFileSync(path.join(REPO_ROOT, "package.json"), path.join(root, "package.json"));
  fs.cpSync(path.join(REPO_ROOT, "build"), path.join(root, "build"), { recursive: true });
  fs.mkdirSync(path.join(root, "kits"));
  for (const [kitId, kit] of Object.entries(kits)) writeKit(root, kitId, kit);
  return {
    root,
    cli: path.join(root, "build", "src", "cli.js"),
    sidecar: path.join(root, "build", "src", "cli", "workflow-sidecar.js"),
    module: (relative) => path.join(root, "build", "src", relative),
  };
}
