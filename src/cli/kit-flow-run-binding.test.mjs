// #1316: a packaged, kit-declared flow must actually RUN, with provenance.
//
// #1315 removed core's enumeration of flow identifiers at `workflow start`, but the run adapter
// still answered three questions for ONE kit — where the definition lives, who produces a gate's
// evidence, and which flows have a canonical run — so every other kit was refused outright. These
// tests drive the derivations that replaced those constants:
//
//   BINDING     — flowRelativePath comes from the DECLARING kit's kit.json flows[] entry, with
//                 ownership and path agreement enforced (a manifest may not declare another
//                 kit's id, nor point an id at a file canonical resolution would not read).
//   PRODUCERS   — the producer for a gate expectation comes from the declaring kit's own
//                 flow_step_actions/skill_roles.
//   ELIGIBILITY — a flow is canonically runnable exactly when its declaring kit supplies every
//                 binding the adapter needs; a missing binding is REFUSED WITH THE BINDING NAMED,
//                 never half-started.
//   PROVENANCE  — the run record pins the bound definition and the session's gate claims carry
//                 which flow AND WHICH VARIANT of it ran, so a reduced-gate run cannot be read as
//                 a full one (#1280).
//   #1314       — the canonical artifact-root hardening used to skip entirely for any flow other
//                 than the two hardcoded ones. It now runs for every flow; the discriminating
//                 case is a symlinked artifact root refused for a kit flow exactly as for the
//                 previously-covered ones.
//
// Every fixture kit here is kit-neutral: no assertion depends on the builder kit's contents
// except the explicit regression that the derived set is still exactly what it enumerated.
// Run: `npm run test:unit`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  canonicalRunFlowIds,
  canonicalRunFlowRefusal,
  isCanonicalRunFlowId,
  resolveBuilderFlowDefinitionPath,
} from "../../build/src/builder-flow-run-adapter.js";
import { resolveKitFlowBinding, resolveKitGateProducer, kitFlowSourceRoots } from "../../build/src/lib/kit-flow-binding.js";
import { startBuilderFlowSession } from "../../build/src/builder-flow-runtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const SIDECAR = path.resolve(REPO_ROOT, "build/src/cli/workflow-sidecar.js");
const CLI = path.resolve(REPO_ROOT, "build/src/cli.js");
// The run-start seam requires the assignment to be actively held by the current workflow actor,
// so the in-process half of the end-to-end must use the same actor the sidecar sessions claimed.
const ACTOR = "kit-flow-binding-actor";
process.env.FLOW_AGENTS_ACTOR = ACTOR;

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * A kit-neutral FlowDefinition. `expectations` selects the GATE SET: the same flow with fewer
 * expectations is a reduced-gate VARIANT, which is the thing #1280 requires be distinguishable
 * from the full one after the fact.
 */
function fixtureFlow(id, expectations = ["probe-readiness", "probe-record"]) {
  return {
    id,
    version: "1.0",
    steps: [{ id: "probe", next: "closeout" }, { id: "closeout", next: null }],
    // "done" here was a real fixture defect the #1316 review FIX-4 contract floor caught: the
    // definition declares no `done` step, so advance-state --phase closeout would have published
    // an active_step_id nothing can resolve. Nothing had ever checked a phase_map value.
    phase_map: { probe: "probe", closeout: "closeout" },
    gates: {
      "probe-gate": {
        step: "probe",
        on_route_back: { missing_evidence: "probe" },
        route_back_policy: { max_attempts: 3, on_exceeded: "block" },
        expects: expectations.map((id) => ({
          id,
          kind: "trust.bundle",
          required: true,
          description: `fixture ${id}`,
          bundle_claim: { claimType: `fixture.${id}`, subjectType: "flow-step", accepted_statuses: ["verified"] },
        })),
      },
    },
  };
}

/** A manifest that supplies EVERY binding the run adapter needs for `flowName`. */
function completeKitManifest(kitId, flowName, expectations = ["probe-readiness", "probe-record"]) {
  return {
    schema_version: "1.0",
    id: kitId,
    name: `${kitId} kit`,
    flows: [{ id: `${kitId}.${flowName}`, path: `flows/${flowName}.flow.json`, description: "fixture flow" }],
    flow_step_actions: [{
      flow_id: `${kitId}.${flowName}`,
      step_id: "probe",
      skills: [`${kitId}-probe`],
      implementation_allowed: false,
      artifacts: ["<slug>--probe.md"],
      expectation_ids: expectations,
      expectation_bindings: expectations.map((id) => ({ expectation_id: id, interface: "workflow.evidence" })),
      artifact_bindings: [{ artifact: "<slug>--probe.md", expectation_ids: expectations }],
    }],
    skill_roles: expectations.map((id) => ({
      // The kit namespaces its own skill roles; the step action names the bare skill. Deriving
      // the prefix from the DECLARING kit is the generic form of the one-kit literal this
      // replaced — a kit called anything at all resolves its own producers.
      skill_id: `${kitId}.${kitId}-probe`,
      step_ids: ["probe"],
      expectation_ids: [id],
      artifacts: ["<slug>--probe.md"],
    })),
    // The gate-action envelope resolves the skill a step action names in the DECLARING kit's own
    // namespace and directory (both were one kit's literals before #1316), so the fixture kit
    // ships the skill source it binds — exactly as a real kit does.
    skills: [{ id: `${kitId}.${kitId}-probe`, path: `skills/${kitId}-probe/SKILL.md`, description: "fixture probe skill" }],
  };
}

/** A project tree containing `kits/<kitId>/` for each supplied kit. */
function makeProject(prefix, kits) {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  spawnSync("git", ["init", "-q", "."], { cwd: project });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: project });
  for (const [kitId, { manifest, flows }] of Object.entries(kits)) {
    writeJson(path.join(project, "kits", kitId, "kit.json"), manifest);
    for (const [flowName, definition] of Object.entries(flows)) {
      writeJson(path.join(project, "kits", kitId, "flows", `${flowName}.flow.json`), definition);
    }
    if (Array.isArray(manifest.skills)) {
      for (const skill of manifest.skills) {
        const file = path.join(project, "kits", kitId, skill.path);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `# ${skill.id}\n\nFixture skill.\n`);
      }
    }
  }
  return project;
}

function runSidecar(args, cwd, env = {}) {
  return spawnSync(process.execPath, [SIDECAR, ...args], {
    cwd, encoding: "utf8", env: { ...process.env, FLOW_AGENTS_ACTOR: ACTOR, ...env },
  });
}

// ─── The builder regression, stated first ────────────────────────────────────────────────────

test("the derived canonical run set is exactly what the hardcoded pair enumerated", () => {
  // #1315 shipped `CANONICAL_RUN_FLOW_IDS = [builder.build, builder.shape]`. #1316 derives the
  // set from what each declaring kit binds. This asserts the derivation lands on the SAME set for
  // the packaged tree — not because those two ids are special-cased, but because they are the
  // only packaged flows whose kit supplies a producer binding for every gate expectation.
  assert.deepEqual(canonicalRunFlowIds(), ["builder.build", "builder.shape"]);
  assert.equal(isCanonicalRunFlowId("builder.build"), true);
  assert.equal(isCanonicalRunFlowId("builder.shape"), true);
  assert.equal(canonicalRunFlowRefusal("builder.build"), null);
  assert.equal(canonicalRunFlowRefusal("builder.shape"), null);

  // The packaged extension flow is DECLARED but composed into another flow rather than started,
  // so it supplies no producer bindings of its own and stays unrunnable — the honest answer, and
  // the one the previous hardcoded pair also gave.
  assert.equal(isCanonicalRunFlowId("builder.publish-learn"), false);
});

test("flowRelativePath comes from the declaring kit's manifest, not a constant", () => {
  // The packaged flows still resolve to the files their own kit.json names.
  const binding = resolveKitFlowBinding("builder.build", kitFlowSourceRoots(REPO_ROOT));
  assert.ok(binding, "the packaged flow must resolve a binding");
  assert.equal(binding.flowRelativePath, "kits/builder/flows/build.flow.json");
  assert.equal(binding.kitId, "builder");
  assert.equal(resolveBuilderFlowDefinitionPath("builder.build"), path.join(binding.sourceRoot, binding.flowRelativePath));
});

// ─── Binding derivation ──────────────────────────────────────────────────────────────────────

test("a kit-neutral kit binds its own flow, at the path its own manifest declares", () => {
  const project = makeProject("kit-bind-", {
    acme: { manifest: completeKitManifest("acme", "probe"), flows: { probe: fixtureFlow("acme.probe") } },
  });
  try {
    const roots = kitFlowSourceRoots(REPO_ROOT, project);
    const binding = resolveKitFlowBinding("acme.probe", roots);
    assert.ok(binding, "a kit declaring its own flow must bind");
    assert.equal(binding.kitId, "acme");
    assert.equal(binding.flowRelativePath, "kits/acme/flows/probe.flow.json");
    assert.equal(binding.sourceRoot, project);
    assert.equal(binding.definitionPath, path.join(project, "kits/acme/flows/probe.flow.json"));

    // The producer for each expectation comes from THIS kit's roles, with THIS kit's namespace
    // stripped — nothing in the resolution refers to any other kit.
    const producer = resolveKitGateProducer(binding.manifest, "acme", "acme.probe", "probe", "probe-readiness");
    assert.equal(producer.kind, "producer");
    assert.equal(producer.skillId, "acme.acme-probe");

    assert.equal(isCanonicalRunFlowId("acme.probe", project), true);
    assert.equal(canonicalRunFlowRefusal("acme.probe", project), null);
    assert.ok(canonicalRunFlowIds(project).includes("acme.probe"));
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("a manifest cannot bind another kit's id, nor point an id at a file canonical resolution would not read", () => {
  const project = makeProject("kit-own-", {
    acme: {
      manifest: {
        ...completeKitManifest("acme", "probe"),
        flows: [
          { id: "acme.probe", path: "flows/probe.flow.json" },
          // cross-kit: acme claims victim's flow
          { id: "victim.hidden", path: "flows/hidden.flow.json" },
          // path disagreement: the id says `elsewhere`, the path says something else entirely
          { id: "acme.elsewhere", path: "flows/probe.flow.json" },
        ],
      },
      flows: { probe: fixtureFlow("acme.probe"), elsewhere: fixtureFlow("acme.elsewhere") },
    },
    victim: { manifest: { id: "victim", flows: [] }, flows: { hidden: fixtureFlow("victim.hidden") } },
    // a manifest whose own id disagrees with its directory is refused wholesale
    liar: { manifest: { ...completeKitManifest("acme", "probe"), id: "acme" }, flows: { probe: fixtureFlow("liar.probe") } },
  });
  try {
    const roots = kitFlowSourceRoots(REPO_ROOT, project);
    assert.ok(resolveKitFlowBinding("acme.probe", roots), "the declaring kit keeps its own flow");
    assert.equal(resolveKitFlowBinding("victim.hidden", roots), null, "a manifest may only declare ids namespaced to its own directory");
    assert.equal(resolveKitFlowBinding("acme.elsewhere", roots), null, "a declared path must name the file canonical resolution reads");
    assert.equal(resolveKitFlowBinding("liar.probe", roots), null, "a manifest that misnames its own kit is refused wholesale");
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("a definition file present but undeclared by the manifest does not bind", () => {
  // #1315 lets an undeclared `flows/` file count for EXISTENCE (a refusal should list everything
  // a start could resolve). A RUN binding is the provenance the run record pins, so it requires
  // the kit to have said so in its manifest.
  const project = makeProject("kit-undeclared-", {
    acme: { manifest: completeKitManifest("acme", "probe"), flows: { probe: fixtureFlow("acme.probe"), extra: fixtureFlow("acme.extra") } },
  });
  try {
    const roots = kitFlowSourceRoots(REPO_ROOT, project);
    assert.ok(resolveKitFlowBinding("acme.probe", roots));
    assert.equal(resolveKitFlowBinding("acme.extra", roots), null);
    assert.equal(isCanonicalRunFlowId("acme.extra", project), false);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

// ─── Fail-closed: a missing binding is refused, and NAMED ────────────────────────────────────

test("a kit missing a producer binding is refused, naming the binding that is missing", () => {
  const noAction = completeKitManifest("gapkit", "probe");
  delete noAction.flow_step_actions;
  const noRole = completeKitManifest("rolekit", "probe");
  noRole.skill_roles = [];
  const ambiguous = completeKitManifest("dupekit", "probe", ["probe-readiness"]);
  // two roles owning the same expectation: "exactly one producer" is not derivable
  ambiguous.skill_roles = [
    { skill_id: "dupekit.dupekit-probe", step_ids: ["probe"], expectation_ids: ["probe-readiness"], artifacts: ["a.md"] },
    { skill_id: "dupekit.dupekit-probe", step_ids: ["probe"], expectation_ids: ["probe-readiness"], artifacts: ["b.md"] },
  ];

  const project = makeProject("kit-gap-", {
    gapkit: { manifest: noAction, flows: { probe: fixtureFlow("gapkit.probe") } },
    rolekit: { manifest: noRole, flows: { probe: fixtureFlow("rolekit.probe") } },
    dupekit: { manifest: ambiguous, flows: { probe: fixtureFlow("dupekit.probe", ["probe-readiness"]) } },
  });
  try {
    // The flow BINDS (it is declared, and its definition file resolves) — so this is not the
    // "unknown flow" path. It is refused for the specific binding it lacks.
    assert.ok(resolveKitFlowBinding("gapkit.probe", kitFlowSourceRoots(REPO_ROOT, project)));

    const noActionRefusal = canonicalRunFlowRefusal("gapkit.probe", project);
    assert.ok(noActionRefusal, "a flow with no step action must be refused");
    assert.match(noActionRefusal, /gapkit\/kit\.json declares no flow_step_actions binding/);
    assert.match(noActionRefusal, /"probe-gate"/, "the refusal names the gate that cannot be satisfied");
    assert.match(noActionRefusal, /"probe-readiness"/, "the refusal names the expectation whose binding is missing");
    assert.equal(isCanonicalRunFlowId("gapkit.probe", project), false);

    const noRoleRefusal = canonicalRunFlowRefusal("rolekit.probe", project);
    assert.ok(noRoleRefusal);
    assert.match(noRoleRefusal, /resolves 0 producing skill_roles in rolekit\/kit\.json; exactly one is required/);

    const ambiguousRefusal = canonicalRunFlowRefusal("dupekit.probe", project);
    assert.ok(ambiguousRefusal);
    assert.match(ambiguousRefusal, /resolves 2 producing skill_roles in dupekit\/kit\.json; exactly one is required/);

    // NEVER HALF-STARTED: the public verb refuses with the same derivation, so a session is not
    // created for a flow whose gates could not be satisfied.
    const started = spawnSync(process.execPath, [CLI, "workflow", "start", "--flow", "gapkit.probe", "--work-item", "local:gap-1", "--task-slug", "gap-1"], {
      cwd: project, encoding: "utf8", env: { ...process.env, CODEX_SESSION_ID: "kit-flow-binding-test" },
    });
    assert.notEqual(started.status, 0, "a flow missing a binding must not start");
    const out = started.stderr + started.stdout;
    assert.match(out, /gapkit\/kit\.json declares no flow_step_actions binding/);
    assert.equal(fs.existsSync(path.join(project, ".kontourai", "flow-agents", "gap-1")), false, "a refused start must leave no session behind");
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

// ─── #1314: the canonical artifact-root hardening is universal ───────────────────────────────

test("#1314: a symlinked artifact root is refused for a kit flow exactly as for a packaged one", () => {
  // The guard used to be gated on two hardcoded flow ids, so this exact setup SUCCEEDED for any
  // other flow. The discriminator is the pair: the same symlinked root must be refused for both,
  // with the same message modulo the flow id.
  const project = makeProject("kit-root-", {
    acme: { manifest: completeKitManifest("acme", "probe"), flows: { probe: fixtureFlow("acme.probe") } },
  });
  const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kit-root-target-")));
  try {
    // `<project>/.kontourai` is a symlink to a directory outside the project.
    fs.mkdirSync(path.join(elsewhere, "flow-agents"), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(project, ".kontourai"));
    const artifactRoot = path.join(project, ".kontourai", "flow-agents");

    const kitFlow = runSidecar([
      "ensure-session", "--artifact-root", artifactRoot,
      "--work-item", "acme/widgets#31", "--flow-id", "acme.probe",
      "--source-request", "root fixture", "--summary", "root fixture",
    ], project);
    assert.notEqual(kitFlow.status, 0, "a symlinked .kontourai root must be refused for a kit flow");
    assert.match(kitFlow.stderr + kitFlow.stdout, /--flow-id acme\.probe requires a non-symlink \.kontourai root/);

    const packagedFlow = runSidecar([
      "ensure-session", "--artifact-root", artifactRoot,
      "--work-item", "acme/widgets#32", "--flow-id", "builder.build",
      "--source-request", "root fixture", "--summary", "root fixture",
    ], project);
    assert.notEqual(packagedFlow.status, 0);
    assert.match(packagedFlow.stderr + packagedFlow.stdout, /--flow-id builder\.build requires a non-symlink \.kontourai root/);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

// ─── End to end, with provenance ─────────────────────────────────────────────────────────────

/**
 * Start a session for `flowId` in `project` and return its session dir and Flow projection.
 */
async function startKitFlowSession(project, flowId, workItem, slug) {
  const artifactRoot = path.join(project, ".kontourai", "flow-agents");
  const ensure = runSidecar([
    "ensure-session", "--artifact-root", artifactRoot,
    "--work-item", workItem, "--flow-id", flowId,
    "--source-request", "run fixture", "--summary", "run fixture",
  ], project);
  assert.equal(ensure.status, 0, `ensure-session for ${flowId} failed: ${ensure.stderr}`);
  const sessionDir = path.join(artifactRoot, slug);
  // startBuilderFlowSession is the production run-start seam: the public `workflow start` verb
  // reaches it through ensure-session's canonical-flow mutation branch, gated on the same
  // isCanonicalRunFlowId predicate this issue derives. Driving it directly keeps the test on the
  // real seam without the assignment-provider ceremony the public verb also requires.
  const started = await startBuilderFlowSession({ sessionDir, flowId });
  const state = JSON.parse(fs.readFileSync(path.join(sessionDir, "state.json"), "utf8"));
  return { artifactRoot, sessionDir, state, started };
}

test("a kit-declared flow runs end to end, and its run record carries which flow and which variant ran", async () => {
  // TWO variants of the same flow shape, declared by two kits: `full` has both expectations,
  // `lite` has one. #1280's requirement is that a run of the reduced-gate variant can never be
  // mistaken for a run of the full one.
  const project = makeProject("kit-run-", {
    fullkit: { manifest: completeKitManifest("fullkit", "probe"), flows: { probe: fixtureFlow("fullkit.probe") } },
    litekit: { manifest: completeKitManifest("litekit", "probe", ["probe-readiness"]), flows: { probe: fixtureFlow("litekit.probe", ["probe-readiness"]) } },
  });
  try {
    assert.equal(isCanonicalRunFlowId("fullkit.probe", project), true);
    assert.equal(isCanonicalRunFlowId("litekit.probe", project), true);

    const full = await startKitFlowSession(project, "fullkit.probe", "acme/widgets#41", "acme-widgets-41");
    const lite = await startKitFlowSession(project, "litekit.probe", "acme/widgets#42", "acme-widgets-42");

    // THE RUN RECORD EXISTS AND IS PINNED. #1315 refused this flow precisely because no run
    // record — and therefore no pinned definition digest — could be produced for it.
    for (const [label, session, flowId] of [["full", full, "fullkit.probe"], ["lite", lite, "litekit.probe"]]) {
      const run = session.state.flow_run;
      assert.ok(run, `${label}: the session must carry a canonical Flow run`);
      assert.equal(run.definition_id, flowId, `${label}: the run record names the flow that ran`);
      assert.match(run.definition_digest, /^[a-f0-9]{16,}$/, `${label}: the run record pins a definition digest`);
      assert.equal(run.definition_version, "1.0");
      assert.ok(fs.existsSync(path.join(project, run.run_ref)), `${label}: the Flow run directory exists`);
    }

    // THE VARIANT IS IDENTIFIED, NOT JUST THE FLOW. Two runs of gate-set variants differ in the
    // pinned digest, so a reduced-gate run is distinguishable from a full one after the fact.
    assert.notEqual(full.state.flow_run.definition_digest, lite.state.flow_run.definition_digest);

    // A GATE CLAIM CARRIES THE BOUND DEFINITION. This is what a kit-declared flow could not do
    // before: `expectedGateProducer` loaded one packaged manifest, so no producer resolved and
    // no gate could be claimed at all.
    const claim = runSidecar([
      "record-gate-claim", full.sessionDir,
      "--expectation", "probe-readiness", "--status", "fail",
      "--route-reason", "missing_evidence",
      "--summary", "fixture route-back claim",
    ], project);
    assert.equal(claim.status, 0, `record-gate-claim failed: ${claim.stderr}`);

    const bundle = JSON.parse(fs.readFileSync(path.join(full.sessionDir, "trust.bundle"), "utf8"));
    const stamped = bundle.claims.filter((c) => c.metadata && c.metadata.gate_claim);
    assert.ok(stamped.length > 0, "the recorded gate claim must carry a gate_claim stamp");
    for (const c of stamped) {
      assert.equal(c.metadata.gate_claim.flow_id, "fullkit.probe", "the claim names the flow it was recorded against");
      assert.equal(c.metadata.gate_claim.definition_version, full.state.flow_run.definition_version);
      assert.equal(c.metadata.gate_claim.definition_digest, full.state.flow_run.definition_digest, "the claim pins the VARIANT, not just the flow");
      assert.notEqual(c.metadata.gate_claim.definition_digest, lite.state.flow_run.definition_digest);
    }
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("a gate claim recorded under one definition cannot be rebuilt into a session bound to another", async () => {
  // The provenance has to REFUSE, not merely record: carrying a reduced-gate variant's claim into
  // the full flow's session must not be silently re-typed against whatever definition is bound
  // now — that is exactly how a reduced-gate run would come to be read as a full one.
  const project = makeProject("kit-crossvariant-", {
    fullkit: { manifest: completeKitManifest("fullkit", "probe"), flows: { probe: fixtureFlow("fullkit.probe") } },
    litekit: { manifest: completeKitManifest("litekit", "probe", ["probe-readiness"]), flows: { probe: fixtureFlow("litekit.probe", ["probe-readiness"]) } },
  });
  try {
    const full = await startKitFlowSession(project, "fullkit.probe", "acme/widgets#51", "acme-widgets-51");
    const lite = await startKitFlowSession(project, "litekit.probe", "acme/widgets#52", "acme-widgets-52");

    const recorded = runSidecar([
      "record-gate-claim", lite.sessionDir,
      "--expectation", "probe-readiness", "--status", "fail",
      "--route-reason", "missing_evidence",
      "--summary", "lite variant claim",
    ], project);
    assert.equal(recorded.status, 0, `record-gate-claim failed: ${recorded.stderr}`);

    // Transplant the reduced-gate variant's claim into the full flow's bundle and force a rebuild.
    const liteBundle = JSON.parse(fs.readFileSync(path.join(lite.sessionDir, "trust.bundle"), "utf8"));
    const fullBundlePath = path.join(full.sessionDir, "trust.bundle");
    const fullBundle = fs.existsSync(fullBundlePath) ? JSON.parse(fs.readFileSync(fullBundlePath, "utf8")) : { claims: [], evidence: [] };
    const transplanted = liteBundle.claims.filter((c) => c.metadata && c.metadata.gate_claim);
    assert.ok(transplanted.length > 0, "the fixture must produce a stamped claim to transplant");
    fullBundle.claims = [...(fullBundle.claims ?? []), ...transplanted];
    fs.writeFileSync(fullBundlePath, `${JSON.stringify(fullBundle, null, 2)}\n`);

    const rebuilt = runSidecar([
      "record-gate-claim", full.sessionDir,
      "--expectation", "probe-record", "--status", "fail",
      "--route-reason", "missing_evidence",
      "--summary", "rebuild after transplant",
    ], project);
    assert.notEqual(rebuilt.status, 0, "a claim from another definition must not be absorbed into this run's bundle");
    assert.match(rebuilt.stderr + rebuilt.stdout, /recorded against flow definition litekit\.probe/);
    assert.match(rebuilt.stderr + rebuilt.stdout, /this session's Flow run is bound to fullkit\.probe/);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});
