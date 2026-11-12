// #1092: a process holding the implementation assignment cannot satisfy Builder's
// `clean-critique` by renaming itself.
//
// Observed in a real eval run: the implementer's honest review left the verify gate blocked, so in
// the same environment it set FLOW_AGENTS_ACTOR=tool-code-reviewer, ran `workflow critique
// --verdict pass`, and the run completed. These tests replay that sequence through the real CLI
// over a real Git fixture and pin the contract:
//
//   PROVENANCE  every critique records the inputs of its reviewer assurance
//               (`metadata.reviewer_assurance`: reviewer and implementer session refs and whether
//               each was runtime_derived or self_declared), in the trust bundle and in the
//               canonical Flow manifest that embeds it. The gate computes the relation and level
//               from those inputs (shaped to map onto hachure-org/spec#37).
//   POLICY      Builder's `workflow.critique` bindings declare `reviewer_assurance:
//               runtime-derived`; a caller-chosen identity (a FLOW_AGENTS_ACTOR override, or a
//               sidecar `--reviewer` label) cannot pass the gate.
//   NO INVITE   no refusal on this path recommends `FLOW_AGENTS_ACTOR=<reviewer-id>`.
//   COORDINATION FLOW_AGENTS_ACTOR still identifies the assignment holder.
//
// Run: `npm run test:unit`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { makeFixtureDir } from "./fixture-temp-dir.mjs";
import { declaredCritiqueReviewerAssurance } from "../../build/src/builder-gate-action-envelope.js";
import { parseKitFlowStepActions } from "../../build/src/flow-kit/validate.js";
import { reviewerAssuranceLevel, reviewerAssuranceMeets, reviewerVerifierRelation, sessionRefSourceForActorSource } from "../../build/src/lib/reviewer-assurance.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const CLI = path.resolve(REPO_ROOT, "build/src/cli.js");
const SIDECAR = path.resolve(REPO_ROOT, "build/src/cli/workflow-sidecar.js");
const TEST_COMMAND = "node --test checks/existing.test.mjs";

// Every input the actor resolver reads, so an inherited runtime or CI identity cannot leak in.
const ACTOR_ENV = ["FLOW_AGENTS_ACTOR", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "OPENCODE_SESSION_ID", "PI_SESSION_ID"];

/** The implementing process: a runtime-derived identity (its own Codex thread), no override. */
const IMPLEMENTER = { CODEX_THREAD_ID: "implementer-thread" };
/** A genuinely separate reviewer runtime session. */
const SEPARATE_REVIEWER = { CODEX_THREAD_ID: "reviewer-thread" };

function env(overrides) {
  const base = { ...process.env };
  for (const name of ACTOR_ENV) delete base[name];
  return { ...base, ...overrides };
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function makeExistingChange() {
  const project = fs.realpathSync(makeFixtureDir("reviewer-assurance-"));
  fs.mkdirSync(path.join(project, "checks"), { recursive: true });
  git(project, ["init", "-q", "."]);
  git(project, ["config", "user.email", "reviewer-assurance@example.invalid"]);
  git(project, ["config", "user.name", "Reviewer Assurance"]);
  git(project, ["config", "core.hooksPath", "/dev/null"]);
  git(project, ["remote", "add", "origin", "https://github.com/acme/widgets.git"]);
  fs.writeFileSync(path.join(project, ".gitignore"), ".kontourai/\n");
  fs.writeFileSync(path.join(project, "checks", "existing.test.mjs"),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('existing change works', () => { assert.equal(1 + 1, 2); });\n");
  git(project, ["add", "."]);
  git(project, ["commit", "-qm", "base"]);
  const base = git(project, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(project, "feature.txt"), "the existing change\n");
  git(project, ["add", "."]);
  git(project, ["commit", "-qm", "existing change"]);
  const head = git(project, ["rev-parse", "HEAD"]);
  const slug = "acme-widgets-1092";
  const artifactRoot = path.join(project, ".kontourai", "flow-agents");
  const sessionDir = path.join(artifactRoot, slug);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, `${slug}--pull-work.md`), "Selected Work Item: acme/widgets#1092\n");
  const report = path.join(sessionDir, `${slug}--existing-change.md`);
  return { project, base, head, slug, artifactRoot, sessionDir, report, runDir: path.join(project, ".kontourai", "flow", "runs", slug) };
}

function run(fx, argv, actorEnv) {
  const result = spawnSync(process.execPath, argv, { cwd: fx.project, encoding: "utf8", env: env(actorEnv) });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

const workflow = (fx, args, actorEnv) => run(fx, [CLI, "workflow", ...args], actorEnv);

function assertOk(result, label) {
  assert.equal(result.status, 0, `${label} failed:\n${result.output}`);
}

function runState(fx) {
  return JSON.parse(fs.readFileSync(path.join(fx.runDir, "state.json"), "utf8"));
}

function critiqueClaims(fx) {
  const bundle = JSON.parse(fs.readFileSync(path.join(fx.sessionDir, "trust.bundle"), "utf8"));
  return bundle.claims.filter((claim) => claim.metadata?.origin === "critique");
}

/** Start an existing-change run and reach `verify` as `holder`. */
function reachVerify(fx, holder) {
  assertOk(workflow(fx, ["start", "--artifact-root", fx.artifactRoot, "--flow", "builder.review-existing", "--work-item", "acme/widgets#1092",
    "--assignment-provider", "local-file", "--criterion", "The existing change passes its tests.", "--source-head", fx.head], holder), "start");
  fs.writeFileSync(fx.report, `# Existing change\n\nBase: ${fx.base}\nHead: ${fx.head}\nChanged files: feature.txt\n`);
  assertOk(workflow(fx, ["evidence", "--session-dir", fx.sessionDir, "--expectation", "pre-existing-implementation", "--status", "pass",
    "--summary", "The change existed before this run at the pinned head.",
    "--evidence-ref-json", JSON.stringify({ kind: "provider", url: "https://github.com/acme/widgets/pull/1092", summary: "Provider record." }),
    "--evidence-ref-json", JSON.stringify({ kind: "artifact", file: fx.report, summary: "Base, head, and changed files." }), "--json"], holder), "pre-existing-implementation");
  assert.equal(runState(fx).current_step, "verify");
}

function lane(fx, status) {
  return JSON.stringify({ id: "code-review", status, summary: "Reviewed the existing change at the pinned head.",
    evidence_refs: [{ kind: "artifact", file: fx.report, summary: "Existing change record." }] });
}

function passingCritique(fx, actorEnv) {
  return workflow(fx, ["critique", "--session-dir", fx.sessionDir, "--id", "code-review", "--verdict", "pass", "--summary", "Clean review.",
    "--artifact-ref", fx.report, "--artifact-ref", "feature.txt", "--lane-json", lane(fx, "pass"), "--json"], actorEnv);
}

function testsEvidence(fx, actorEnv) {
  const criterionId = JSON.parse(fs.readFileSync(path.join(fx.sessionDir, "acceptance.json"), "utf8")).criteria[0].id;
  const ref = { kind: "command", excerpt: TEST_COMMAND, summary: "Project test for the existing change." };
  return workflow(fx, ["evidence", "--session-dir", fx.sessionDir, "--expectation", "tests-evidence", "--status", "pass",
    "--summary", "The existing change passes its tests.", "--command", TEST_COMMAND, "--evidence-ref-json", JSON.stringify(ref),
    "--criterion-json", JSON.stringify({ id: criterionId, status: "pass", evidence_refs: [ref] }), "--json"], actorEnv);
}

const RELABEL_INVITATION = /FLOW_AGENTS_ACTOR=<reviewer-id>/;

test("#1092 the implementer cannot pass clean-critique by setting FLOW_AGENTS_ACTOR in its own environment", () => {
  const fx = makeExistingChange();
  reachVerify(fx, IMPLEMENTER);

  // 1. No independent reviewer: the implementer's own review is refused and the gate stays blocked.
  const own = workflow(fx, ["critique", "--session-dir", fx.sessionDir, "--id", "code-review", "--verdict", "not_verified",
    "--summary", "No independent reviewer runtime is available.", "--lane-json", lane(fx, "not_verified"), "--json"], IMPLEMENTER);
  assert.notEqual(own.status, 0, "the assignment holder cannot review its own work");
  assert.doesNotMatch(own.output, RELABEL_INVITATION, "the self-review refusal must not invite relabelling");
  const blocked = testsEvidence(fx, IMPLEMENTER);
  assert.notEqual(blocked.status, 0);
  assert.doesNotMatch(blocked.output, RELABEL_INVITATION, "the missing-critique refusal must not invite relabelling");

  // 2. The relabel: the SAME environment plus only FLOW_AGENTS_ACTOR.
  const relabelled = passingCritique(fx, { ...IMPLEMENTER, FLOW_AGENTS_ACTOR: "tool-code-reviewer" });
  assert.notEqual(relabelled.status, 0, `a relabelled implementer recorded a passing critique:\n${relabelled.output}`);
  assert.match(relabelled.output, /requires runtime-derived reviewer identity, and this critique has reviewer identity self_declared \(explicit-override\), relation undetermined/);
  assert.doesNotMatch(relabelled.output, RELABEL_INVITATION);
  assert.deepEqual(critiqueClaims(fx).filter((claim) => claim.value === "pass"), [], "no passing critique may be recorded");

  // 3. The gate stays blocked and the run does not complete.
  assert.notEqual(testsEvidence(fx, IMPLEMENTER).status, 0);
  assert.equal(runState(fx).status, "active");
  assert.equal(runState(fx).current_step, "verify");
});

test("#1092 a caller-chosen sidecar --reviewer label is recorded as self_declared and cannot pass the gate", () => {
  const fx = makeExistingChange();
  reachVerify(fx, IMPLEMENTER);
  assertOk(run(fx, [SIDECAR, "record-critique", fx.sessionDir, "--reviewer", "tool-code-reviewer", "--id", "code-review", "--verdict", "pass",
    "--summary", "Clean review.", "--artifact-ref", fx.report, "--artifact-ref", "feature.txt", "--lane-json", lane(fx, "pass")], IMPLEMENTER), "sidecar record-critique");
  const [claim] = critiqueClaims(fx);
  assert.deepEqual(claim.metadata.reviewer_assurance, {
    reviewer: { session_ref: "tool-code-reviewer", session_ref_source: "self_declared", resolved_by: "sidecar-reviewer-label" },
    implementer: null,
  });

  const refused = testsEvidence(fx, IMPLEMENTER);
  assert.notEqual(refused.status, 0, `a sidecar-labelled critique satisfied the gate:\n${refused.output}`);
  assert.match(refused.output, /evidence\.critique\.reviewer_assurance: requires runtime-derived reviewer identity outside the implementer's session; critique '[^']+' has reviewer identity self_declared \(sidecar-reviewer-label\), relation undetermined/);
  assert.equal(runState(fx).status, "active");
});

test("#1092 a separate reviewer runtime session passes, and its assurance reaches the trust bundle and canonical manifest", () => {
  const fx = makeExistingChange();
  // The holder identifies itself with FLOW_AGENTS_ACTOR: the override still works for coordination.
  const holder = { FLOW_AGENTS_ACTOR: "existing-change-holder" };
  reachVerify(fx, holder);
  assertOk(passingCritique(fx, SEPARATE_REVIEWER), "separate-session critique");
  const [claim] = critiqueClaims(fx);
  assert.equal(claim.value, "pass");
  const assurance = claim.metadata.reviewer_assurance;
  assert.equal(assurance.reviewer.session_ref, claim.metadata.reviewer, "the session ref is the recorded reviewer");
  assert.equal(assurance.reviewer.session_ref_source, "runtime_derived");
  assert.equal(assurance.reviewer.resolved_by, "runtime-session-id:codex");
  assert.deepEqual(assurance.implementer, { session_ref: "existing-change-holder", session_ref_source: "self_declared" },
    "the holder's FLOW_AGENTS_ACTOR identity is recorded as self_declared coordination identity");
  assert.equal(reviewerVerifierRelation(assurance), "undetermined", "no receipt-backed identity: never independent");
  assert.equal(reviewerAssuranceLevel(assurance), "runtime-derived");

  assertOk(testsEvidence(fx, holder), "tests-evidence");
  assert.equal(runState(fx).status, "completed");

  // Canonical projection: the Flow manifest embeds the bundle claim with its assurance.
  const manifest = JSON.parse(fs.readFileSync(path.join(fx.runDir, "evidence", "manifest.json"), "utf8"));
  const projected = manifest.evidence.flatMap((entry) => entry.bundle?.claims ?? [])
    .filter((entry) => entry.metadata?.origin === "critique" && entry.metadata.critique_record_id === claim.metadata.critique_record_id);
  assert.ok(projected.length > 0, "the canonical manifest must carry the critique claim");
  for (const entry of projected) assert.deepEqual(entry.metadata.reviewer_assurance, claim.metadata.reviewer_assurance);
});

test("#1092 an in-session subagent shares the implementer's runtime session and is refused as same-session", () => {
  const fx = makeExistingChange();
  // A Claude Code orchestrator and its in-session subagent share one CLAUDE_CODE_SESSION_ID.
  const session = { CLAUDE_CODE_SESSION_ID: "orchestrator-session" };
  reachVerify(fx, session);
  const subagent = passingCritique(fx, session);
  assert.notEqual(subagent.status, 0);
  assert.match(subagent.output, /relation same-session/);
  assert.doesNotMatch(subagent.output, RELABEL_INVITATION);
  assert.equal(fs.existsSync(path.join(fx.sessionDir, "trust.bundle")) ? critiqueClaims(fx).length : 0, 0);
});

test("#1092 the gate decision is computed from recorded inputs, not a stored label", () => {
  const identity = (session_ref, session_ref_source) => ({ session_ref, session_ref_source });
  // Source mapping from the actor resolver.
  assert.equal(sessionRefSourceForActorSource("explicit-override"), "self_declared");
  for (const source of ["runtime-session-id:codex", "ci-runtime:github-actions", "process-ancestry"]) assert.equal(sessionRefSourceForActorSource(source), "runtime_derived");
  // Relation: same-session first; otherwise undetermined, never independent.
  const separate = { reviewer: identity("reviewer", "runtime_derived"), implementer: identity("implementer", "runtime_derived") };
  assert.equal(reviewerVerifierRelation(separate), "undetermined");
  assert.equal(reviewerAssuranceMeets(separate, "runtime-derived"), true);
  const sameSession = { reviewer: identity("shared", "runtime_derived"), implementer: identity("shared", "runtime_derived") };
  assert.equal(reviewerVerifierRelation(sameSession), "same-session");
  assert.equal(reviewerAssuranceMeets(sameSession, "runtime-derived"), false);
  assert.equal(reviewerAssuranceMeets(sameSession, "caller-asserted"), false, "same-session never satisfies any level");
  const selfDeclared = { reviewer: identity("tool-code-reviewer", "self_declared"), implementer: identity("implementer", "runtime_derived") };
  assert.equal(reviewerAssuranceLevel(selfDeclared), "caller-asserted");
  assert.equal(reviewerAssuranceMeets(selfDeclared, "runtime-derived"), false);
  // A stored label without inputs, a legacy record, or a malformed source fails closed.
  for (const recorded of [undefined, null, { level: "runtime-derived" }, { reviewer: identity("r", "receipt_backed"), implementer: null }]) {
    assert.equal(reviewerAssuranceMeets(recorded, "runtime-derived"), false, JSON.stringify(recorded));
  }
});

test("#1092 every Builder flow's critique binding declares runtime-derived reviewer assurance", () => {
  const kit = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "kits/builder/kit.json"), "utf8"));
  const critiqueSteps = kit.flow_step_actions.filter((row) => row.expectation_bindings?.some((binding) => binding.interface === "workflow.critique"));
  assert.deepEqual(critiqueSteps.map((row) => `${row.flow_id}/${row.step_id}`).sort(),
    ["builder.build-lean/verify", "builder.build/verify", "builder.deliver-existing/verify", "builder.review-existing/verify"]);
  for (const row of critiqueSteps) {
    assert.equal(declaredCritiqueReviewerAssurance(row.flow_id, row.step_id), "runtime-derived", `${row.flow_id}/${row.step_id}`);
  }
});

test("#1092 kit metadata accepts reviewer_assurance only on workflow.critique bindings with a known level", () => {
  const manifest = (binding) => ({ flow_step_actions: [{ flow_id: "fixture.flow", step_id: "verify", skills: ["review"], implementation_allowed: false,
    artifacts: [], expectation_ids: ["review-proof"], expectation_bindings: [binding], artifact_bindings: [] }] });
  const ok = parseKitFlowStepActions(manifest({ expectation_id: "review-proof", interface: "workflow.critique", reviewer_assurance: "runtime-derived" }), "kit.json");
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.entries[0].expectation_bindings[0].reviewer_assurance, "runtime-derived");
  for (const binding of [
    { expectation_id: "review-proof", interface: "workflow.critique", reviewer_assurance: "authenticated" },
    { expectation_id: "review-proof", interface: "workflow.evidence", reviewer_assurance: "runtime-derived" },
  ]) {
    assert.match(parseKitFlowStepActions(manifest(binding), "kit.json").errors.join("\n"), /reviewer_assurance is allowed only for workflow\.critique bindings/);
  }
});
