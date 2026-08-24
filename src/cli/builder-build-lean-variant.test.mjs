// #1280 / #1324: `builder.build-lean`, the gate-value ablation's INDEPENDENT VARIABLE.
//
// The programme is deciding, with evidence rather than taste, which builder.build gates are worth
// their cost. #1324 made core stop enumerating kit flow identifiers and made kit-declared flows
// runnable WITH PROVENANCE, precisely so a kit could declare a reduced-gate variant of its own
// flow and the run record could prove which variant ran. This is that variant, and these are the
// properties the experiment depends on:
//
//   ADMISSIBLE   — the variant passes the same four admission questions as the control, through
//                  the SAME `flowAdmissionRefusal` every door calls. No core change made it
//                  runnable; the derivation did.
//   IDENTIFIED   — a run of the variant carries flow_id + definition_version + definition_digest,
//                  and its digest differs from the control's. A reduced-gate run that could be
//                  read as a full one would make every measurement taken from it a lie.
//   NON-FUNGIBLE — a gate claim recorded under the variant cannot be rebuilt into a session bound
//                  to builder.build. Provenance has to REFUSE, not merely record.
//   CONTROL INTACT — builder.build's gate set, route maps and producer rows are asserted
//                  EXPLICITLY here. An ablation whose control drifts measures nothing, and a
//                  sibling flow is only a valid treatment if the control is byte-stable.
//   FAIL-CLOSED  — the variant is admissible only because its declaring kit supplies a producer
//                  binding for every expectation of every remaining gate. Drop one and it is
//                  refused with the missing binding NAMED.
//
// Run: `npm run test:unit`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { flowAdmissionRefusal } from "../../build/src/lib/flow-admission.js";
import {
  canonicalRunFlowIds,
  canonicalRunFlowRefusal,
  isCanonicalRunFlowId,
} from "../../build/src/builder-flow-run-adapter.js";
import { resolveEffectiveFlowDefinition } from "../../build/src/lib/flow-resolver.js";
import { kitFlowRunBindingIssues, resolveKitFlowBinding } from "../../build/src/lib/kit-flow-binding.js";
import { startBuilderFlowSession } from "../../build/src/builder-flow-runtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const CLI = path.resolve(REPO_ROOT, "build/src/cli.js");
const SIDECAR = path.resolve(REPO_ROOT, "build/src/cli/workflow-sidecar.js");

const CONTROL = "builder.build";
const VARIANT = "builder.build-lean";
/** The gates the ablation removes — the whole experiment, named once. */
const ABLATED_GATES = ["design-probe-gate", "plan-gate"];
/** The gates it deliberately KEEPS: each has demonstrably caught a defect. */
const RETAINED_GATES = ["execute-gate", "merge-ready-gate", "pull-work-gate", "verify-gate"];
/** Composed in from builder.publish-learn; kept, so closeout is measured identically in both arms. */
const COMPOSED_GATES = [
  "builder.publish-learn:learn-gate",
  "builder.publish-learn:merge-ready-ci-gate",
  "builder.publish-learn:pr-open-gate",
];

// The run-start seam requires the assignment to be held by the current workflow actor, so the
// in-process half of the end-to-end must use the actor the sidecar sessions claimed.
const ACTOR = "build-lean-variant-actor";
process.env.FLOW_AGENTS_ACTOR = ACTOR;

function makeProject(prefix) {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  spawnSync("git", ["init", "-q", "."], { cwd: project });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: project });
  return project;
}

function runSidecar(args, cwd, env = {}) {
  return spawnSync(process.execPath, [SIDECAR, ...args], {
    cwd, encoding: "utf8", env: { ...process.env, FLOW_AGENTS_ACTOR: ACTOR, ...env },
  });
}

function runCli(args, cwd, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd, encoding: "utf8", env: { ...process.env, CODEX_SESSION_ID: "build-lean-variant-test", ...env },
  });
}

/** Start a session for `flowId` and return its dir plus the persisted state. */
async function startSession(project, flowId, workItem, slug) {
  const artifactRoot = path.join(project, ".kontourai", "flow-agents");
  const ensure = runSidecar([
    "ensure-session", "--artifact-root", artifactRoot,
    "--work-item", workItem, "--flow-id", flowId,
    "--source-request", "ablation fixture", "--summary", "ablation fixture",
  ], project);
  assert.equal(ensure.status, 0, `ensure-session for ${flowId} failed: ${ensure.stderr}`);
  const sessionDir = path.join(artifactRoot, slug);
  // The production run-start seam: `workflow start` reaches it through ensure-session's
  // canonical-flow mutation branch, gated on the same admission predicate asserted below.
  await startBuilderFlowSession({ sessionDir, flowId });
  return { artifactRoot, sessionDir, state: JSON.parse(fs.readFileSync(path.join(sessionDir, "state.json"), "utf8")) };
}

// ─── The ablation itself: what differs, and what must not ────────────────────────────────────

test("the variant ablates exactly the two unproven gates and changes nothing else", () => {
  const control = resolveEffectiveFlowDefinition(CONTROL, REPO_ROOT);
  const variant = resolveEffectiveFlowDefinition(VARIANT, REPO_ROOT);
  assert.ok(control && variant, "both arms must resolve a composed definition");

  assert.deepEqual(Object.keys(control.gates).sort(), [...COMPOSED_GATES, ...ABLATED_GATES, ...RETAINED_GATES].sort());
  assert.deepEqual(Object.keys(variant.gates).sort(), [...COMPOSED_GATES, ...RETAINED_GATES].sort());
  // Stated as a set difference rather than two lists, so the assertion says what the experiment
  // varies rather than merely what each arm happens to contain today.
  const controlGates = new Set(Object.keys(control.gates));
  const variantGates = new Set(Object.keys(variant.gates));
  assert.deepEqual([...controlGates].filter((gate) => !variantGates.has(gate)).sort(), [...ABLATED_GATES].sort());
  assert.deepEqual([...variantGates].filter((gate) => !controlGates.has(gate)), [], "the treatment may only REMOVE gates");

  // THE STEPS ARE PRESERVED AS SEQUENCING, NOT AS WORK. design-probe and plan still exist and
  // still sequence into execute, but in the variant they declare no producer skill, so nothing
  // instructs an agent to do that step's work. The variable under test is therefore the gate
  // TOGETHER WITH its step's demanded work — never the gate alone. Asserted below against the
  // kit's own action rows so this comment cannot drift from what the manifest declares.
  assert.deepEqual(variant.steps, control.steps, "sequencing must be identical in both arms");
  assert.deepEqual(variant.phase_map, control.phase_map, "phase mapping must be identical in both arms");
  assert.equal(variant.version, control.version);
  for (const step of ["design-probe", "plan"]) {
    assert.ok(control.steps.some((entry) => entry.id === step), `${step} must exist in the control`);
    assert.ok(variant.steps.some((entry) => entry.id === step), `${step} must survive the ablation as a step`);
    assert.equal(Object.values(variant.gates).some((gate) => gate.step === step), false, `${step} must be UNGATED in the variant`);
    assert.equal(Object.values(control.gates).some((gate) => gate.step === step), true, `${step} must stay gated in the control`);
  }
  // THE SECOND VARIABLE, ASSERTED RATHER THAN DESCRIBED. The ablated steps declare no producer
  // skill in the variant, so removing the gate also removes the instruction to do the work. That
  // is a deliberate design call — it models the realistic post-cut world — but it is exactly the
  // kind of property a comment can assert while nothing computes it. Deriving it here from the
  // kit's own action rows means the arm cannot silently become one-variable (or stay two-variable
  // while some future description claims otherwise) without this test saying so.
  const actionRows = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "kits/builder/kit.json"), "utf8")).flow_step_actions;
  const skillsAt = (flowId, stepId) =>
    actionRows.filter((row) => row.flow_id === flowId && row.step_id === stepId).flatMap((row) => row.skills ?? []);
  for (const step of ["design-probe", "plan"]) {
    assert.deepEqual(skillsAt(VARIANT, step), [], `${step} must declare NO producer skill in the variant — the ablation removes the gate AND the work`);
    assert.notDeepEqual(skillsAt(CONTROL, step), [], `${step} must declare a producer skill in the control, or there is no second variable to disclose`);
  }
  for (const step of ["execute", "verify"]) {
    assert.deepEqual(skillsAt(VARIANT, step), skillsAt(CONTROL, step), `${step} is retained, so its producer skills must be identical in both arms`);
  }
  // A retained gate must be byte-identical to the control's, or "fewer gates" quietly becomes
  // "fewer AND weaker gates" and the measurement has two variables.
  for (const gate of [...RETAINED_GATES, ...COMPOSED_GATES]) {
    assert.deepEqual(variant.gates[gate], control.gates[gate], `retained gate ${gate} must be identical to the control's`);
  }
});

test("the variant is named and described as reduced-gate everywhere it is declared", () => {
  // Nothing that reads the declaration may mistake the treatment for the control. This is the
  // cheapest possible defence against the label-vs-derivation failure the run record guards
  // against downstream: the name and the prose must not disagree with the gate set.
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "kits/builder/kit.json"), "utf8"));
  const declaration = manifest.flows.find((entry) => entry.id === VARIANT);
  assert.ok(declaration, "the kit must declare the variant in flows[]");
  assert.equal(declaration.path, "flows/build-lean.flow.json");
  const definition = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "kits/builder/flows/build-lean.flow.json"), "utf8"));
  for (const [label, text] of [["kit declaration", declaration.description], ["flow definition", definition.description]]) {
    assert.match(text, /reduced-gate/i, `${label} must name itself as reduced-gate`);
    assert.match(text, /design-probe/i, `${label} must disclose the ablated design-probe gate`);
    assert.match(text, /plan/i, `${label} must disclose the ablated plan gate`);
  }
  assert.doesNotMatch(
    manifest.flows.find((entry) => entry.id === CONTROL).description,
    /reduced-gate/i,
    "the control must not describe itself as reduced-gate",
  );
});

// ─── Admission through the public path ───────────────────────────────────────────────────────

test("the variant is admissible and startable through the public admission path", () => {
  // Same function, every door — a refusal on one door is a property of the door, not the system.
  assert.equal(flowAdmissionRefusal(VARIANT, REPO_ROOT, "workflow start --flow"), null);
  assert.equal(flowAdmissionRefusal(VARIANT, REPO_ROOT, "ensure-session --flow-id"), null);
  assert.equal(canonicalRunFlowRefusal(VARIANT), null);
  assert.equal(isCanonicalRunFlowId(VARIANT), true);
  assert.ok(canonicalRunFlowIds().includes(VARIANT), "the derived canonical run set must include the variant");

  // The PUBLIC verb: it must get past admission and stop only on its own input contract. The two
  // negative assertions are what distinguish "admitted" from "refused for a different reason".
  const started = runCli(["workflow", "start", "--flow", VARIANT], makeProject("lean-public-"));
  assert.notEqual(started.status, 0, "start without a work item must still fail on its input contract");
  const output = started.stderr + started.stdout;
  assert.match(output, /workflow start requires --work-item <provider-ref>/);
  assert.ok(!output.includes("is not a flow declared"), `the variant must be declared: ${output}`);
  assert.ok(!output.includes("cannot bind it"), `the variant must be bindable: ${output}`);
  assert.ok(!output.includes("does not conform"), `the variant must conform: ${output}`);
});

// ─── Provenance: which variant ran ───────────────────────────────────────────────────────────

test("a variant run records the variant identity, distinguishably from the control", async () => {
  const project = makeProject("lean-run-");
  try {
    const control = await startSession(project, CONTROL, "acme/widgets#71", "acme-widgets-71");
    const variant = await startSession(project, VARIANT, "acme/widgets#72", "acme-widgets-72");

    for (const [label, session, flowId] of [["control", control, CONTROL], ["variant", variant, VARIANT]]) {
      const run = session.state.flow_run;
      assert.ok(run, `${label}: the session must carry a canonical Flow run`);
      assert.equal(run.definition_id, flowId, `${label}: the run record names the flow that ran`);
      assert.equal(run.definition_version, "1.4", `${label}: the run record pins a definition version`);
      assert.match(run.definition_digest, /^[a-f0-9]{16,}$/, `${label}: the run record pins a definition digest`);
      assert.ok(fs.existsSync(path.join(project, run.run_ref)), `${label}: the Flow run directory exists`);
    }

    // THE POINT OF THE WHOLE MECHANISM: the two arms are told apart by the run record, not by a
    // label someone wrote down. Same steps, same version, DIFFERENT gate set -> different digest.
    assert.notEqual(
      variant.state.flow_run.definition_digest,
      control.state.flow_run.definition_digest,
      "a reduced-gate run must never share a definition digest with the full flow",
    );

    // And the difference is legible in what the run OPENS: the variant's first gate is the same,
    // but the control gates design-probe and plan on the way to execute while the variant does not.
    assert.deepEqual(control.state.flow_run.open_gate_ids, ["pull-work-gate"]);
    assert.deepEqual(variant.state.flow_run.open_gate_ids, ["pull-work-gate"]);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

/**
 * Advance `session` (a builder.build run) from pull-work to design-probe by satisfying
 * pull-work-gate for real, so the next claim targets an expectation the VARIANT does not have.
 * That asymmetry is what keeps a transplanted variant claim alive through the rebuild instead of
 * being superseded by a same-expectation re-record.
 */
async function advanceControlToDesignProbe(project, session, slug) {
  const artifact = path.join(session.sessionDir, `${slug}--pull-work.md`);
  fs.writeFileSync(artifact, `# pull-work\n\nSelected ${slug} with scope and acceptance context.\n`);
  const passed = runSidecar([
    "record-gate-claim", session.sessionDir,
    "--expectation", "selected-work", "--status", "pass",
    "--summary", "control selected work",
    "--evidence-ref-json", JSON.stringify({
      kind: "artifact",
      file: `.kontourai/flow-agents/${slug}/${slug}--pull-work.md`,
      summary: "pull-work selection record",
    }),
  ], project);
  assert.equal(passed.status, 0, `satisfying pull-work-gate failed: ${passed.stderr}`);
  await startBuilderFlowSession({ sessionDir: session.sessionDir, flowId: CONTROL });
  const state = JSON.parse(fs.readFileSync(path.join(session.sessionDir, "state.json"), "utf8"));
  assert.deepEqual(state.flow_run.open_gate_ids, ["design-probe-gate"], "the control must reach the gate the variant ablates");
  return state;
}

test("a gate claim recorded under the variant cannot be rebuilt into a session bound to builder.build", async () => {
  // Provenance has to REFUSE, not merely record. Carrying a reduced-gate claim into the control's
  // session must not be silently re-typed against whatever definition is bound now — that is
  // exactly how an ablation arm's evidence would come to be counted as the full flow's.
  //
  // The control is driven to design-probe first, ON PURPOSE: design-probe-gate is one of the two
  // gates this variant ABLATES, so the rebuild targets an expectation the variant cannot possibly
  // have produced. It is also what makes the test discriminate — a same-expectation re-record
  // supersedes the transplanted claim before the identity check ever sees it, which would let a
  // broken guard pass.
  const project = makeProject("lean-crossvariant-");
  try {
    const control = await startSession(project, CONTROL, "acme/widgets#81", "acme-widgets-81");
    const variant = await startSession(project, VARIANT, "acme/widgets#82", "acme-widgets-82");
    await advanceControlToDesignProbe(project, control, "acme-widgets-81");

    const recorded = runSidecar([
      "record-gate-claim", variant.sessionDir,
      "--expectation", "selected-work", "--status", "fail",
      "--summary", "reduced-gate variant claim",
    ], project);
    assert.equal(recorded.status, 0, `record-gate-claim failed: ${recorded.stderr}`);

    const variantBundle = JSON.parse(fs.readFileSync(path.join(variant.sessionDir, "trust.bundle"), "utf8"));
    const transplanted = variantBundle.claims.filter((claim) => claim.metadata && claim.metadata.gate_claim);
    assert.ok(transplanted.length > 0, "the fixture must produce a stamped claim to transplant");
    // The claim names the VARIANT and pins its digest — not merely the kit, and not merely "some
    // builder flow".
    for (const claim of transplanted) {
      assert.equal(claim.metadata.gate_claim.flow_id, VARIANT);
      assert.equal(claim.metadata.gate_claim.definition_digest, variant.state.flow_run.definition_digest);
      assert.notEqual(claim.metadata.gate_claim.definition_digest, control.state.flow_run.definition_digest);
    }

    // DISCRIMINATOR: the same rebuild, WITHOUT the transplant, must succeed. Without this the
    // refusal below could be the fixture failing for an unrelated reason rather than the guard
    // firing. Recorded as `fail` so it neither advances the run nor perturbs what follows.
    const controlBundlePath = path.join(control.sessionDir, "trust.bundle");
    const cleanBundleBytes = fs.readFileSync(controlBundlePath, "utf8");
    const clean = runSidecar([
      "record-gate-claim", control.sessionDir,
      "--expectation", "pickup-probe-readiness", "--status", "fail",
      "--summary", "rebuild without transplant",
    ], project);
    assert.equal(clean.status, 0, `the untransplanted rebuild must succeed: ${clean.stderr}`);

    // Now the same command against a bundle carrying the variant's claim.
    fs.writeFileSync(controlBundlePath, cleanBundleBytes);
    const controlBundle = JSON.parse(cleanBundleBytes);
    controlBundle.claims = [...(controlBundle.claims ?? []), ...transplanted];
    fs.writeFileSync(controlBundlePath, `${JSON.stringify(controlBundle, null, 2)}\n`);

    const rebuilt = runSidecar([
      "record-gate-claim", control.sessionDir,
      "--expectation", "pickup-probe-readiness", "--status", "fail",
      "--summary", "rebuild after transplant",
    ], project);
    assert.notEqual(rebuilt.status, 0, "a variant claim must not be absorbed into the control's bundle");
    const output = rebuilt.stderr + rebuilt.stdout;
    assert.match(output, /was recorded against flow definition builder\.build-lean@1\.4/);
    assert.match(output, /this session's Flow run is bound to builder\.build@1\.4/);
    // Both digests are named, so the refusal identifies the VARIANT, not merely a flow id — and
    // the write is refused outright rather than partially applied.
    assert.ok(output.includes(variant.state.flow_run.definition_digest), "the refusal must name the variant's digest");
    assert.ok(output.includes(control.state.flow_run.definition_digest), "the refusal must name the control's digest");
    assert.match(output, /trust\.bundle was NOT written/);

    // SECOND DOOR, same property: the run binding itself refuses to re-bind a variant session to
    // the control. A bundle of reduced-gate claims cannot be re-flagged as a full-flow run by
    // restarting the session under the other id.
    await assert.rejects(
      () => startBuilderFlowSession({ sessionDir: variant.sessionDir, flowId: CONTROL }),
      /does not match the existing builder\.build-lean run/,
      "a variant session must not be re-bound to the control flow",
    );
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

// ─── The control is untouched ────────────────────────────────────────────────────────────────

test("builder.build is unchanged by the addition of its variant", () => {
  // Asserted EXPLICITLY, not by diffing against the variant: an ablation is only interpretable if
  // the control is the same flow it was before the treatment existed. These are the same route
  // maps and producer rows the pre-variant contract pinned.
  const control = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "kits/builder/flows/build.flow.json"), "utf8"));
  assert.equal(control.id, CONTROL);
  assert.equal(control.version, "1.4");
  assert.deepEqual(Object.keys(control.gates).sort(), [...ABLATED_GATES, ...RETAINED_GATES].sort());
  assert.deepEqual(control.steps.map((step) => step.id), [
    "pull-work", "design-probe", "plan", "execute", "verify", "merge-ready", "pr-open", "merge-ready-ci", "learn", "done",
  ]);
  assert.deepEqual(control.phase_map, {
    pickup: "pull-work", planning: "plan", execution: "execute", verification: "verify",
    goal_fit: "merge-ready", evidence: "merge-ready", release: "pr-open", learning: "learn",
  });

  // ROUTE MAPS, verbatim.
  assert.deepEqual(control.gates["execute-gate"].on_route_back, { plan_gap: "plan" });
  for (const gateId of ["verify-gate", "merge-ready-gate"]) {
    assert.deepEqual(control.gates[gateId].on_route_back, {
      missing_evidence: "verify", implementation_defect: "execute", plan_gap: "plan", decision_gap: "design-probe", default: "verify",
    }, `${gateId} route map must be unchanged`);
    assert.deepEqual(control.gates[gateId].route_back_policy, { max_attempts: 3, on_exceeded: "block" });
  }
  // The two ablated gates are still fully present in the CONTROL, with their expectations.
  assert.deepEqual(control.gates["design-probe-gate"].expects.map((expect) => expect.id), ["pickup-probe-readiness", "probe-decisions-or-accepted-gaps"]);
  assert.deepEqual(control.gates["plan-gate"].expects.map((expect) => expect.id), ["implementation-plan"]);

  // PRODUCER ROWS for the control, unchanged: the variant adds siblings, it does not edit these.
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "kits/builder/kit.json"), "utf8"));
  const controlActions = manifest.flow_step_actions.filter((action) => action.flow_id === CONTROL);
  assert.deepEqual(controlActions.map((action) => action.step_id), [
    "pull-work", "design-probe", "plan", "execute", "verify", "merge-ready", "pr-open", "merge-ready-ci", "learn", "done",
  ]);
  assert.deepEqual(
    controlActions.find((action) => action.step_id === "design-probe").expectation_ids,
    ["pickup-probe-readiness", "probe-decisions-or-accepted-gaps"],
    "the control still binds the design-probe expectations the variant drops",
  );
  assert.deepEqual(
    controlActions.find((action) => action.step_id === "plan").expectation_ids,
    ["implementation-plan"],
    "the control still binds the plan expectation the variant drops",
  );

  // And the control still starts: the pre-existing, consumer-matched refusal strings are intact.
  const project = makeProject("lean-control-");
  try {
    const build = runCli(["workflow", "start", "--flow", CONTROL], project);
    assert.notEqual(build.status, 0);
    assert.match(build.stderr + build.stdout, /workflow start requires --work-item <provider-ref>/);
    const shape = runCli(["workflow", "start", "--flow", "builder.shape"], project);
    assert.notEqual(shape.status, 0);
    assert.match(shape.stderr + shape.stdout, /workflow start --flow builder\.shape requires an explicit safe --task-slug/);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

// ─── Fail-closed: an incomplete binding is refused, with the binding named ───────────────────

test("the variant is refused when its declaring kit drops a producer binding", () => {
  // The variant is admissible ONLY because the kit binds a producer to every expectation of every
  // remaining gate. This drops one binding at a time from a COPY OF THE REAL MANIFEST BYTES and
  // asserts the refusal names what is missing — the discriminating case for "the bindings are
  // actually load-bearing" rather than "the flow happens to be listed".
  //
  // Scope, disclosed: this drives the run adapter's own derivation over the real kit tree. That
  // the PUBLIC DOOR refuses an unbindable flow (leaving no session and no active pointer behind)
  // is proved kit-neutrally in kit-flow-run-binding.test.mjs; it cannot be re-proved here because
  // the packaged kit root is searched before any temporary tree, so a `builder.*` id can never be
  // shadowed by a fixture.
  const project = makeProject("lean-binding-");
  try {
    fs.cpSync(path.join(REPO_ROOT, "kits", "builder"), path.join(project, "kits", "builder"), { recursive: true });
    const binding = resolveKitFlowBinding(VARIANT, [project]);
    assert.ok(binding, "the copied kit tree must bind the variant");
    assert.equal(binding.flowRelativePath, "kits/builder/flows/build-lean.flow.json");
    const definition = resolveEffectiveFlowDefinition(VARIANT, project);
    assert.ok(definition, "the copied kit tree must resolve the composed definition");

    // CONTROL: the unmodified copy is fully bound. Without this the assertions below could pass
    // for a fixture that never bound anything.
    assert.deepEqual(kitFlowRunBindingIssues(binding, definition), [], "the intact kit must supply every binding");

    // Every gate expectation the variant retains, dropped one at a time. Each must be refused,
    // and the refusal must name the gate AND the expectation.
    const gatedExpectations = Object.entries(definition.gates).flatMap(([gateId, gate]) =>
      gate.expects.map((expect) => ({ gateId, stepId: gate.step, expectationId: expect.id })));
    assert.ok(gatedExpectations.length >= 8, `the variant must retain a substantive gate set, found ${gatedExpectations.length}`);

    for (const { gateId, stepId, expectationId } of gatedExpectations) {
      // Drop the whole step action — the binding surface the adapter reads for this step.
      const withoutAction = structuredClone(binding.manifest);
      withoutAction.flow_step_actions = withoutAction.flow_step_actions.filter(
        (action) => !(action.flow_id === VARIANT && action.step_id === stepId));
      const issues = kitFlowRunBindingIssues({ ...binding, manifest: withoutAction }, definition);
      assert.ok(issues.length > 0, `dropping the ${stepId} step action must refuse the variant`);
      const text = issues.join("; ");
      assert.match(text, new RegExp(`gate "${gateId}"`), `the refusal must name gate ${gateId}`);
      assert.match(text, new RegExp(`"${expectationId}"`), `the refusal must name expectation ${expectationId}`);
      assert.match(text, /builder\/kit\.json declares no flow_step_actions binding/);
    }

    // A step action that exists but binds no producing skill_role is refused too, with a
    // different, equally specific message — the "producer-ambiguous" branch.
    const withoutRoles = structuredClone(binding.manifest);
    withoutRoles.skill_roles = [];
    const roleIssues = kitFlowRunBindingIssues({ ...binding, manifest: withoutRoles }, definition);
    assert.ok(roleIssues.length > 0, "a kit with no producing skill_roles must refuse the variant");
    assert.match(roleIssues.join("; "), /resolves 0 producing skill_roles in builder\/kit\.json; exactly one is required/);

    // The operation-bound expectation is NOT a missing binding: pr-open's pull-request-opened is
    // satisfied by an external operation, which is a declared property of the flow. Asserted so a
    // future "tighten the check" change cannot quietly make the variant unrunnable.
    const prOpenOnly = structuredClone(binding.manifest);
    prOpenOnly.skill_roles = [];
    const prIssues = kitFlowRunBindingIssues({ ...binding, manifest: prOpenOnly }, definition);
    assert.ok(!prIssues.some((issue) => issue.includes('"pull-request-opened"')),
      "an operation-bound expectation must not be reported as a missing producer binding");
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

// ─── #1336: the retained gates are reachable by DECLARATION, not by flow name ─────────────────

import { declaredStepBindsInterface } from "../../build/src/builder-gate-action-envelope.js";
import { freshnessTurnstileGateEntry, mergeReadyCiRefreshRoutesSatisfied } from "../../packaging/lifecycle-authority/coordinator.mjs";

test("every retained gate's public verb finds the variant by what it declares", () => {
  const control = resolveEffectiveFlowDefinition(CONTROL, REPO_ROOT);
  const variant = resolveEffectiveFlowDefinition(VARIANT, REPO_ROOT);

  // `workflow critique`, `recover-exact-current-completion` and `reseal-verification-evidence`
  // used to ask "is this builder.build at verify". They now ask the declaring kit which interface
  // produces the step's evidence — and the answer must be the SAME for both arms, because the
  // ablation does not touch verify-gate.
  for (const flowId of [CONTROL, VARIANT]) {
    assert.equal(declaredStepBindsInterface(flowId, "verify", "workflow.critique", REPO_ROOT), true, `${flowId}/verify must be reachable by the critique verb`);
    // And the derivation must still DISCRIMINATE: a step that produces evidence through
    // workflow.evidence is not a review gate, whichever arm it belongs to.
    for (const step of ["pull-work", "execute", "merge-ready", "learn"]) {
      assert.equal(declaredStepBindsInterface(flowId, step, "workflow.critique", REPO_ROOT), false, `${flowId}/${step} must not be mistaken for the review gate`);
    }
  }
  // A flow no installed kit declares fails closed rather than defaulting to permitted.
  assert.equal(declaredStepBindsInterface("acme.nonexistent", "verify", "workflow.critique", REPO_ROOT), false);

  // publish-provisional-delivery, publish-delivery and merge-change key on the freshness turnstile
  // the DEFINITION declares, which replaced both the `merge-ready-ci` step name and the composed
  // gate-id literal `builder.publish-learn:merge-ready-ci-gate` in the privileged coordinator.
  for (const [label, definition] of [["control", control], ["variant", variant]]) {
    const turnstile = freshnessTurnstileGateEntry(definition);
    assert.ok(turnstile, `${label}: exactly one gate must declare requires_current_verification`);
    assert.equal(turnstile.id, "builder.publish-learn:merge-ready-ci-gate", `${label}: the derivation still resolves the gate the literal named`);
    assert.equal(turnstile.gate.step, "merge-ready-ci", `${label}: and it still sits at the step the literal named`);
    assert.equal(mergeReadyCiRefreshRoutesSatisfied(turnstile.gate), true, `${label}: merge-change's evidence-refresh control is satisfied`);
  }
  // The derivation refuses ambiguity rather than picking: two declaring gates is not "the" gate.
  assert.equal(freshnessTurnstileGateEntry({ gates: {} }), null);
  assert.equal(freshnessTurnstileGateEntry({
    gates: { a: { step: "x", requires_current_verification: true }, b: { step: "y", requires_current_verification: true } },
  }), null);
});
