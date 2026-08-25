// #1341: the gate-value ablation's two arms must differ in GATE SET ALONE.
//
// Independent review of #1346 found four further differences, none intended. Three were unprivileged
// and shared one root cause: `flowId === "builder.build"` used as a stand-in for a derivable
// property. That literal decided whether a run got provider-ownership validation
// (`workflow-sidecar.ts` selectionWorkItemRef → five behaviours inside enforceEnsureSessionOwnership),
// selection-evidence checking (`workflow.ts`, the `--pull-work.md` report), and a machine-readable
// `next_action` (skills + pinned start command, versus a bare string).
//
// None of those are properties of a NAME. They are properties of "does this flow select a Work
// Item", which the definition declares by expecting `selected-work`.
//
// WHY THIS MATTERS BEYOND TIDINESS: kontourai/evals#193 declares the gate set as its single
// independent variable. An outcome difference caused by the treatment arm running with the
// ownership guard off would have been attributed to gate removal — a wrong conclusion drawn
// confidently, which is the failure the measurement stack exists to prevent.
//
// Run: `npm run test:unit`.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { flowSelectsWorkItem, resolveEffectiveFlowDefinition } from "../../build/src/lib/flow-resolver.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CONTROL = "builder.build";
const VARIANT = "builder.build-lean";

const selectsWorkItem = (flowId) => flowSelectsWorkItem(resolveEffectiveFlowDefinition(flowId, REPO_ROOT));

test("the ablation arms agree on every start-time behaviour derived from work-item selection", () => {
  // Stated as an EQUALITY between the arms rather than as two independent expectations, so the
  // assertion says what the experiment requires: not "both are true" but "they do not differ".
  assert.equal(
    selectsWorkItem(VARIANT),
    selectsWorkItem(CONTROL),
    "the treatment arm must receive exactly the same provider-ownership validation, selection-evidence requirement and next_action shape as the control — any difference is a variable the ablation does not intend to vary",
  );
  // Pinned positively too: an equality that held because BOTH arms lost the checks would satisfy
  // the assertion above while silently weakening the control.
  assert.equal(selectsWorkItem(CONTROL), true, "the control must keep its start-time validation");
});

test("a flow that does not select a Work Item is unaffected", () => {
  // The negative case. Without it, "make the arms agree" degenerates into "turn the checks on for
  // everything", which would break shaping runs — they have no Work Item to validate ownership of.
  assert.equal(selectsWorkItem("builder.shape"), false, "builder.shape declares no selected-work expectation and must not acquire work-item validation");
  assert.equal(selectsWorkItem("builder.publish-learn"), false, "a composed publish flow declares no selected-work expectation");
});

test("the derivation fails closed on anything it cannot classify", () => {
  // A flow we cannot read must keep the STRICTER behaviour. Silently granting weaker checks to an
  // unclassifiable flow is precisely the defect being replaced.
  assert.equal(flowSelectsWorkItem(null), true);
  assert.equal(flowSelectsWorkItem(undefined), true);
  assert.equal(flowSelectsWorkItem({}), true, "a definition with no gates is unclassifiable, not exempt");
  assert.equal(flowSelectsWorkItem({ gates: null }), true);
  assert.equal(flowSelectsWorkItem({ gates: { g: { expects: "not-an-array" } } }), true);
});

test("the derivation reads the expectation, not the gate or step name", () => {
  // Guards against re-introducing a name check one level down: a gate called `pull-work-gate` that
  // expects nothing must NOT count, and an oddly-named gate that expects selected-work must.
  assert.equal(flowSelectsWorkItem({ gates: { "pull-work-gate": { expects: [] } } }), false);
  assert.equal(flowSelectsWorkItem({ gates: { "anything-at-all": { expects: [{ id: "selected-work" }] } } }), true);
});

// ─── The derivation is not the point; the three CALL SITES are ────────────────────────────────
//
// Independent review proved the tests above cannot fail if the fix regresses: with
// `flow-resolver.js` byte-identical but all three call sites reverted to
// `flowId === "builder.build"`, they still passed 4/4. They pin the derivation, and nothing bound
// the derivation to the behaviours it was extracted to control — which is the regression this
// file's own header names.
//
// So these drive the real entry points and assert the ARMS BEHAVE IDENTICALLY, which is the
// property kontourai/evals#193 actually depends on.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

const CLI = path.resolve(REPO_ROOT, "build/src/cli.js");
const SIDECAR = path.resolve(REPO_ROOT, "build/src/cli/workflow-sidecar.js");

function scratchProject(prefix) {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  spawnSync("git", ["init", "-q", "."], { cwd: project });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: project });
  return project;
}

test("both arms refuse a bogus provider AssignmentStatus at ensure-session", () => {
  // The ownership guard. Before the fix the variant sailed past this with exit 0 because
  // `selectionWorkItemRef` was undefined for any flow not literally named `builder.build`.
  const project = scratchProject("flow-agents-arm-own-");
  const bogus = path.join(project, "bogus-state.json");
  fs.writeFileSync(bogus, JSON.stringify({ role: "AssignmentStatus", provider: "github", assignment: {} }));
  const codes = {};
  for (const flowId of [CONTROL, VARIANT]) {
    const slug = `arm-own-${flowId.replace(/[^a-z]/g, "")}`;
    codes[flowId] = spawnSync(process.execPath, [SIDECAR, "ensure-session",
      "--artifact-root", path.join(project, ".kontourai", "flow-agents"),
      "--work-item", "acme/widgets#1", "--flow-id", flowId,
      "--assignment-provider", "github", "--effective-state-json", bogus,
      "--source-request", "arm parity", "--summary", "arm parity",
    ], { cwd: project, encoding: "utf8" }).status;
  }
  assert.equal(codes[VARIANT], codes[CONTROL],
    `both arms must reach the same verdict on a bogus AssignmentStatus (control=${codes[CONTROL]}, variant=${codes[VARIANT]}) — a variant that starts where the control refuses is running with the ownership guard off`);
  assert.notEqual(codes[CONTROL], 0, "the control must refuse a bogus AssignmentStatus, or this asserts nothing");
});

test("both arms refuse to start without pull-work selection evidence", () => {
  // The selection-evidence check. Before the fix the variant started with no `--pull-work.md`.
  const project = scratchProject("flow-agents-arm-sel-");
  const codes = {};
  for (const flowId of [CONTROL, VARIANT]) {
    codes[flowId] = spawnSync(process.execPath, [CLI, "workflow", "start",
      "--artifact-root", path.join(project, ".kontourai", "flow-agents"),
      "--work-item", "acme/widgets#2", "--flow", flowId,
      "--source-request", "arm parity", "--summary", "arm parity",
    ], { cwd: project, encoding: "utf8" }).status;
  }
  assert.equal(codes[VARIANT], codes[CONTROL],
    `both arms must reach the same verdict when selection evidence is absent (control=${codes[CONTROL]}, variant=${codes[VARIANT]})`);
  assert.notEqual(codes[CONTROL], 0, "the control must refuse without selection evidence, or this asserts nothing");
});
