// #1415 slice 1: `builder.review-existing` — review and verify an EXISTING exact-head change
// without a retroactive Builder implementation claim.
//
// The properties this file pins, each through the real public CLI over a real Git fixture:
//
//   NO IMPLEMENTATION — the flow has no execute step and no implementation-allowed row, and a
//                       completed run's bundle carries no execute/plan/design-probe claim.
//   PINNED HEAD       — `workflow start --source-head` must name the clean checked-out HEAD; the
//                       commit is persisted in the run and re-proved at every gate evaluation,
//                       so evidence about any other commit cannot satisfy the run.
//   EVERY DOOR        — the rule lives in the shared runtime (`startBuilderFlowSession`), so the
//                       package API and the sidecar entry refuse exactly what `workflow start` does.
//   CONSUMERS         — publish-delivery accepts a completed run at the pinned head; merge-change
//                       refuses before any provider call.
//
// Run: `npm run test:unit`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { flowAdmissionRefusal } from "../../build/src/lib/flow-admission.js";
import { canonicalRunFlowIds, isCanonicalRunFlowId } from "../../build/src/builder-flow-run-adapter.js";
import { resolveEffectiveFlowDefinition } from "../../build/src/lib/flow-resolver.js";
import { definitionPinsSourceHead, pinnedRunSourceHead, startBuilderFlowSession } from "../../build/src/builder-flow-runtime.js";
import { main as mergeChangeMain } from "../../build/src/cli/merge-change.js";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const CLI = path.resolve(REPO_ROOT, "build/src/cli.js");
const SIDECAR = path.resolve(REPO_ROOT, "build/src/cli/workflow-sidecar.js");

const FLOW = "builder.review-existing";
const HOLDER = "review-existing-holder";
const REVIEWER = "review-existing-reviewer";
const TEST_COMMAND = "node --test checks/existing.test.mjs";
const PR_URL = "https://github.com/acme/widgets/pull/9";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * A consumer repository whose change ALREADY EXISTS: a base commit and a feature commit on top.
 * Workflow artifacts are gitignored, as the flow requires, so the tree is clean at the head.
 */
function makeExistingChange(number) {
  const project = fs.realpathSync(makeFixtureDir("review-existing-"));
  fs.mkdirSync(path.join(project, "checks"), { recursive: true });
  fs.mkdirSync(path.join(project, "context", "settings"), { recursive: true });
  git(project, ["init", "-q", "."]);
  git(project, ["config", "user.email", "review-existing@example.invalid"]);
  git(project, ["config", "user.name", "Review Existing"]);
  git(project, ["config", "core.hooksPath", "/dev/null"]);
  // The ChangeProvider resolves the repository from origin; merge-change must see it configured.
  git(project, ["remote", "add", "origin", "https://github.com/acme/widgets.git"]);
  fs.writeFileSync(path.join(project, ".gitignore"), ".kontourai/\n");
  fs.writeFileSync(path.join(project, "checks", "existing.test.mjs"),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('existing change works', () => { assert.equal(1 + 1, 2); });\n");
  fs.writeFileSync(path.join(project, "checks", "empty.test.mjs"), "// declares no tests\n");
  fs.writeFileSync(path.join(project, "context", "settings", "change-provider-settings.json"), `${JSON.stringify({
    schema_version: "1.0",
    defaults: { provider: { role: "ChangeProvider", kind: "github", repository: { owner: "acme", name: "widgets" }, capabilities: ["change.create", "change.observe", "change.merge"], executor: "gh-cli" } },
  }, null, 2)}\n`);
  git(project, ["add", "."]);
  git(project, ["commit", "-qm", "base"]);
  const base = git(project, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(project, "feature.txt"), "the existing change\n");
  git(project, ["add", "."]);
  git(project, ["commit", "-qm", "existing change"]);
  const head = git(project, ["rev-parse", "HEAD"]);
  const workItem = `acme/widgets#${number}`;
  const slug = `acme-widgets-${number}`;
  const artifactRoot = path.join(project, ".kontourai", "flow-agents");
  const sessionDir = path.join(artifactRoot, slug);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, `${slug}--pull-work.md`), `Selected Work Item: ${workItem}\n`);
  return { project, base, head, workItem, slug, artifactRoot, sessionDir, runDir: path.join(project, ".kontourai", "flow", "runs", slug) };
}

function workflow(fx, args, actor = HOLDER, env = {}) {
  const result = spawnSync(process.execPath, [CLI, "workflow", ...args], {
    cwd: fx.project, encoding: "utf8", env: { ...process.env, FLOW_AGENTS_ACTOR: actor, ...env },
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}`, stdout: result.stdout };
}

function startArgs(fx, flow = FLOW) {
  return ["start", "--artifact-root", fx.artifactRoot, "--flow", flow, "--work-item", fx.workItem, "--assignment-provider", "local-file",
    "--criterion", "The existing change passes its tests."];
}

const NO_HEAD = Symbol("no --source-head");

function start(fx, sourceHead = fx.head) {
  return workflow(fx, [...startArgs(fx), ...(sourceHead === NO_HEAD ? [] : ["--source-head", sourceHead])]);
}

function runState(fx) {
  return JSON.parse(fs.readFileSync(path.join(fx.runDir, "state.json"), "utf8"));
}

function bundle(fx) {
  return JSON.parse(fs.readFileSync(path.join(fx.sessionDir, "trust.bundle"), "utf8"));
}

function existingChangeReport(fx) {
  const file = path.join(fx.sessionDir, `${fx.slug}--existing-change.md`);
  fs.writeFileSync(file, `# Existing change\n\nChange: ${PR_URL}\nBase: ${fx.base}\nHead: ${fx.head}\nChanged files: feature.txt\n`);
  return file;
}

function recordPreExisting(fx) {
  const file = existingChangeReport(fx);
  return workflow(fx, ["evidence", "--session-dir", fx.sessionDir, "--expectation", "pre-existing-implementation", "--status", "pass",
    "--summary", "The change existed before this run at the pinned head.",
    "--evidence-ref-json", JSON.stringify({ kind: "provider", url: PR_URL, summary: "Provider record of the existing change." }),
    "--evidence-ref-json", JSON.stringify({ kind: "artifact", file, summary: "Base, exact head, and changed files." }),
    "--json"]);
}

function critique(fx, actor = REVIEWER) {
  const report = path.join(fx.sessionDir, `${fx.slug}--existing-change.md`);
  const lane = { id: "code-review", status: "pass", summary: "Reviewed the existing change at the pinned head.", evidence_refs: [{ kind: "artifact", file: report, summary: "Existing change record." }] };
  return workflow(fx, ["critique", "--session-dir", fx.sessionDir, "--id", "existing-review", "--verdict", "pass",
    "--summary", "Independent review of the existing change.", "--artifact-ref", report, "--artifact-ref", "feature.txt",
    "--lane-json", JSON.stringify(lane), "--json"], actor);
}

function testsEvidence(fx, command = TEST_COMMAND) {
  const criterionId = JSON.parse(fs.readFileSync(path.join(fx.sessionDir, "acceptance.json"), "utf8")).criteria[0].id;
  const ref = { kind: "command", excerpt: command, summary: "Project test for the existing change." };
  return workflow(fx, ["evidence", "--session-dir", fx.sessionDir, "--expectation", "tests-evidence", "--status", "pass",
    "--summary", "The existing change passes its tests.", "--command", command,
    "--evidence-ref-json", JSON.stringify(ref),
    "--criterion-json", JSON.stringify({ id: criterionId, status: "pass", evidence_refs: [ref] }), "--json"]);
}

function assertOk(result, label) {
  assert.equal(result.status, 0, `${label} failed:\n${result.output}`);
}

/** Drive a run through every gate to completion, asserting each step. */
function completeRun(fx) {
  assertOk(start(fx), "start");
  assert.equal(runState(fx).current_step, "existing-change");
  assertOk(recordPreExisting(fx), "pre-existing-implementation");
  assert.equal(runState(fx).current_step, "verify");
  assertOk(critique(fx), "critique");
  assertOk(testsEvidence(fx), "tests-evidence");
  assert.equal(runState(fx).status, "completed");
}

function assertNoRunCreated(fx, label) {
  assert.equal(fs.existsSync(path.join(fx.sessionDir, "state.json")), false, `${label}: no session state may be written`);
  assert.equal(fs.existsSync(fx.runDir), false, `${label}: no canonical run may be created`);
}

// ─── The definition ──────────────────────────────────────────────────────────────────────────

test("the definition reviews an existing change: no execute step, verify identical to builder.build", () => {
  const build = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "kits/builder/flows/build.flow.json"), "utf8"));
  const flow = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "kits/builder/flows/review-existing.flow.json"), "utf8"));
  assert.equal(flow.id, FLOW);
  assert.match(flow.description, /EXISTING-CHANGE REVIEW: no implementation step; the head is pinned at start/);
  assert.deepEqual(flow.source_binding, { head: "pinned-at-start" });
  assert.deepEqual(flow.steps.map((step) => step.id), ["pull-work", "existing-change", "verify", "done"]);
  assert.deepEqual(Object.keys(flow.gates).sort(), ["existing-change-gate", "pull-work-gate", "verify-gate"]);
  // Selection and verification are the control's own gates, so this route is not a weaker review.
  assert.deepEqual(flow.gates["pull-work-gate"], build.gates["pull-work-gate"]);
  assert.deepEqual(flow.gates["verify-gate"].expects, build.gates["verify-gate"].expects);
  // Defects block: only the evidence-refresh routes survive, and no route reaches an implementation step.
  assert.deepEqual(flow.gates["verify-gate"].on_route_back, { missing_evidence: "verify", default: "verify" });
  assert.deepEqual(flow.gates["verify-gate"].route_back_policy, { max_attempts: 3, on_exceeded: "block" });
  assert.deepEqual(flow.gates["existing-change-gate"].expects.map((expect) => [expect.id, expect.required, expect.bundle_claim]), [[
    "pre-existing-implementation", true,
    { claimType: "builder.existing-change.pre-existing-implementation", subjectType: "change", accepted_statuses: ["verified"] },
  ]]);

  const kit = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "kits/builder/kit.json"), "utf8"));
  const rows = kit.flow_step_actions.filter((row) => row.flow_id === FLOW);
  assert.deepEqual(rows.map((row) => row.step_id), ["pull-work", "existing-change", "verify", "done"]);
  assert.deepEqual(rows.filter((row) => row.implementation_allowed), [], "no step of this flow may allow implementation");
  assert.deepEqual(rows.find((row) => row.step_id === "existing-change").skills, ["review-existing"]);
  const producers = kit.skill_roles.filter((role) => role.role === "step"
    && [role.flow_id, ...(role.flow_ids ?? [])].includes(FLOW)
    && role.expectation_ids.includes("pre-existing-implementation"));
  assert.deepEqual(producers.map((role) => role.skill_id), ["builder.review-existing"], "exactly one producer owns the pre-existing claim");
  assert.ok(!kit.flow_step_actions.some((row) => row.flow_id === FLOW && row.artifacts.includes("<slug>--deliver.md")),
    "the existing-change record must not reuse the execution report review treats specially");
});

test("the flow is admitted and canonically runnable through the shared admission path", () => {
  assert.equal(flowAdmissionRefusal(FLOW, REPO_ROOT, "workflow start --flow"), null);
  assert.equal(flowAdmissionRefusal(FLOW, REPO_ROOT, "ensure-session --flow-id"), null);
  assert.equal(isCanonicalRunFlowId(FLOW), true);
  assert.ok(canonicalRunFlowIds().includes(FLOW));
  const resolved = resolveEffectiveFlowDefinition(FLOW, REPO_ROOT);
  assert.deepEqual(resolved.source_binding, { head: "pinned-at-start" }, "the pin survives composition, so the definition digest covers it");
});

test("an unrecognised source_binding, or a run whose pin disagrees with its definition, is refused", () => {
  const pinned = resolveEffectiveFlowDefinition(FLOW, REPO_ROOT);
  const unpinned = resolveEffectiveFlowDefinition("builder.build", REPO_ROOT);
  const sha = "a".repeat(40);
  assert.equal(definitionPinsSourceHead(pinned), true);
  assert.equal(definitionPinsSourceHead(unpinned), false);
  // A declared binding the runtime does not understand must not silently read as "unpinned".
  for (const binding of [{ head: "follows-branch" }, { head: "pinned-at-start", base: "pinned" }, "pinned-at-start", null]) {
    assert.throws(() => definitionPinsSourceHead({ ...unpinned, source_binding: binding }), /source_binding: must be exactly \{"head":"pinned-at-start"\}/);
  }
  // The persisted head and the definition's declaration must agree in both directions.
  assert.equal(pinnedRunSourceHead(pinned, { params: { subject: "s", source_head: sha } }), sha);
  assert.equal(pinnedRunSourceHead(unpinned, { params: { subject: "s" } }), null);
  assert.throws(() => pinnedRunSourceHead(pinned, { params: { subject: "s" } }), /source_head: must be the 40-hex commit/);
  assert.throws(() => pinnedRunSourceHead(pinned, { params: { subject: "s", source_head: sha.toUpperCase() } }), /source_head: must be the 40-hex commit/);
  assert.throws(() => pinnedRunSourceHead(unpinned, { params: { subject: "s", source_head: sha } }), /is present but the run's start definition declares no source_binding/);
});

// ─── (a) the start pin ───────────────────────────────────────────────────────────────────────

test("start refuses a missing, malformed, non-HEAD, or dirty-tree source head before writing anything", () => {
  const fx = makeExistingChange(11);
  const cases = [
    ["missing", NO_HEAD, /builder\.review-existing pins the reviewed commit at start; pass --source-head <40-hex commit>/],
    ["empty", "", /pins the reviewed commit at start/],
    ["abbreviated", fx.head.slice(0, 12), /must be a full 40-character lowercase hexadecimal commit SHA/],
    ["uppercase", fx.head.toUpperCase(), /must be a full 40-character lowercase hexadecimal commit SHA/],
    ["not HEAD", fx.base, new RegExp(`${fx.base} is not the checked-out HEAD ${fx.head}`)],
  ];
  for (const [label, head, pattern] of cases) {
    const result = start(fx, head);
    assert.notEqual(result.status, 0, `${label} must be refused`);
    assert.match(result.output, pattern, label);
    assertNoRunCreated(fx, label);
  }
  // A tracked modification and an untracked file each make the tree dirty.
  fs.appendFileSync(path.join(fx.project, "feature.txt"), "uncommitted\n");
  let result = start(fx);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /has uncommitted or untracked changes/);
  assertNoRunCreated(fx, "tracked modification");
  git(fx.project, ["checkout", "--", "feature.txt"]);
  fs.writeFileSync(path.join(fx.project, "scratch.txt"), "untracked\n");
  result = start(fx);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /has uncommitted or untracked changes/);
  assertNoRunCreated(fx, "untracked file");
  fs.rmSync(path.join(fx.project, "scratch.txt"));

  // DISCRIMINATOR: the same fixture starts once the head is exact and the tree clean.
  assertOk(start(fx), "exact clean start");
  const state = runState(fx);
  assert.equal(state.definition_id, FLOW);
  assert.equal(state.params.source_head, fx.head, "the run persists the pinned head");
  assert.equal(state.current_step, "existing-change", "selected-work was produced at pull-work");
});

test("a flow without the pin refuses --source-head rather than ignoring it", () => {
  const fx = makeExistingChange(12);
  for (const extra of [["--source-head", fx.head], ["--source-head"]]) {
    const result = workflow(fx, [...startArgs(fx, "builder.build"), ...extra]);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /--source-head is accepted only by a flow whose definition declares source_binding\.head; builder\.build does not/);
    assertNoRunCreated(fx, `builder.build ${extra.join(" ")}`);
  }
});

// ─── (b) the second door ─────────────────────────────────────────────────────────────────────

test("the package API and the sidecar entry refuse a pinned start without its head (rule lives in the runtime)", async () => {
  const fx = makeExistingChange(13);
  // The installed sidecar seeds a session but cannot start a canonical run on its own; the run is
  // started by whoever calls the exported runtime entry next. That entry must apply the same pin.
  const seeded = spawnSync(process.execPath, [SIDECAR, "ensure-session", "--artifact-root", fx.artifactRoot,
    "--work-item", fx.workItem, "--flow-id", FLOW, "--source-request", "second door", "--summary", "second door"], {
    cwd: fx.project, encoding: "utf8", env: { ...process.env, FLOW_AGENTS_ACTOR: HOLDER },
  });
  assert.equal(seeded.status, 0, `sidecar ensure-session failed: ${seeded.stderr}`);
  assert.equal(fs.existsSync(fx.runDir), false, "the private writer must not start the canonical run");

  const previousActor = process.env.FLOW_AGENTS_ACTOR;
  process.env.FLOW_AGENTS_ACTOR = HOLDER;
  try {
    await assert.rejects(() => startBuilderFlowSession({ sessionDir: fx.sessionDir, flowId: FLOW }), /pins the reviewed commit at start/);
    await assert.rejects(() => startBuilderFlowSession({ sessionDir: fx.sessionDir, flowId: FLOW, sourceHead: fx.base }), /is not the checked-out HEAD/);
    assert.equal(fs.existsSync(fx.runDir), false, "a refused API start must leave no canonical run");
    // DISCRIMINATOR: the same door starts the run when given the exact head.
    const started = await startBuilderFlowSession({ sessionDir: fx.sessionDir, flowId: FLOW, sourceHead: fx.head });
    assert.equal(started.run.state.params.source_head, fx.head);
    // And it never pins a head for a flow that does not declare one.
    const other = makeExistingChange(14);
    const otherSeeded = spawnSync(process.execPath, [SIDECAR, "ensure-session", "--artifact-root", other.artifactRoot,
      "--work-item", other.workItem, "--flow-id", "builder.build", "--source-request", "second door", "--summary", "second door"], {
      cwd: other.project, encoding: "utf8", env: { ...process.env, FLOW_AGENTS_ACTOR: HOLDER },
    });
    assert.equal(otherSeeded.status, 0, `sidecar ensure-session failed: ${otherSeeded.stderr}`);
    await assert.rejects(() => startBuilderFlowSession({ sessionDir: other.sessionDir, flowId: "builder.build", sourceHead: other.head }),
      /--source-head is accepted only by a flow whose definition declares source_binding\.head/);
  } finally {
    if (previousActor === undefined) delete process.env.FLOW_AGENTS_ACTOR;
    else process.env.FLOW_AGENTS_ACTOR = previousActor;
  }
});

// ─── (c) a new head needs a new run ──────────────────────────────────────────────────────────

test("resuming with a different head is refused for an active run", () => {
  const fx = makeExistingChange(15);
  assertOk(start(fx), "start");
  fs.writeFileSync(path.join(fx.project, "feature.txt"), "a second revision\n");
  git(fx.project, ["commit", "-qam", "second revision"]);
  const newHead = git(fx.project, ["rev-parse", "HEAD"]);
  let result = start(fx, newHead);
  assert.notEqual(result.status, 0);
  assert.match(result.output, new RegExp(`${newHead} does not match the source head ${fx.head} this builder\\.review-existing run was started at; a new head needs a new run`));
  result = start(fx, fx.head);
  assert.notEqual(result.status, 0, "the old head is no longer HEAD");
  assert.match(result.output, new RegExp(`${fx.head} is not the checked-out HEAD ${newHead}`));
  assert.equal(runState(fx).params.source_head, fx.head, "the persisted pin is unchanged");
});

// ─── The whole route, and what a completed run contains ──────────────────────────────────────

test("a completed run records the existing change truthfully and publishes at the pinned head; merge-change refuses", async () => {
  const fx = makeExistingChange(16);
  completeRun(fx);
  const state = runState(fx);
  assert.equal(state.definition_id, FLOW);
  assert.equal(state.params.source_head, fx.head);

  // (e) NO IMPLEMENTATION CLAIM, and exactly one live pre-existing claim observed at the pin.
  const claims = bundle(fx).claims;
  const live = claims.filter((claim) => claim.producerStatus !== "superseded" && !claim.metadata?.superseded_by);
  assert.deepEqual(live.filter((claim) => /^builder\.(execute|plan|design-probe)\./.test(claim.claimType)).map((claim) => claim.claimType), [],
    "a completed existing-change run carries no implementation, plan, or design-probe claim");
  const preExisting = live.filter((claim) => claim.claimType === "builder.existing-change.pre-existing-implementation");
  assert.equal(preExisting.length, 1);
  assert.equal(preExisting[0].value, "pass");
  assert.equal(preExisting[0].metadata.verification_workspace_snapshot.head_sha, fx.head, "the writer observed the head; the caller did not supply it");
  assert.equal(preExisting[0].metadata.verification_workspace_snapshot.worktree_clean, true);
  assert.ok(preExisting[0].metadata.artifact_refs.some((ref) => ref.kind === "provider" && ref.url === PR_URL));
  for (const claim of live.filter((entry) => entry.metadata?.gate_claim)) {
    assert.equal(claim.metadata.gate_claim.flow_id, FLOW, `${claim.claimType} names the route that produced it`);
  }
  assert.deepEqual(live.map((claim) => claim.claimType).sort(), [
    "builder.existing-change.pre-existing-implementation", "builder.pull-work.selected", "builder.verify.tests",
    "workflow.acceptance.criterion", "workflow.critique.review",
  ]);

  // A completed run cannot be resumed onto another head either.
  fs.writeFileSync(path.join(fx.project, "feature.txt"), "post-completion revision\n");
  git(fx.project, ["commit", "-qam", "post-completion revision"]);
  const laterHead = git(fx.project, ["rev-parse", "HEAD"]);
  const resumed = start(fx, laterHead);
  assert.notEqual(resumed.status, 0);
  assert.match(resumed.output, /does not match the source head .* a new head needs a new run/);
  git(fx.project, ["reset", "-q", "--hard", fx.head]);

  // CONSUMER 1: publish-delivery seals the checkpoint at the pinned head.
  const published = workflow(fx, ["publish-delivery", "--session-dir", fx.sessionDir, "--json"], HOLDER, { TRUST_RECONCILE_COMMANDS: TEST_COMMAND });
  assertOk(published, "publish-delivery");
  assert.equal(JSON.parse(published.stdout.trim().split("\n").at(-1)).published, true);
  const checkpoint = JSON.parse(fs.readFileSync(path.join(fx.sessionDir, "trust.checkpoint.json"), "utf8"));
  assert.equal(checkpoint.commit_sha, fx.head);
  assert.ok(fs.existsSync(path.join(fx.project, "delivery", fx.slug, "trust.bundle")));

  // CONSUMER 2: merge-change refuses before any authorization or provider call. The provider is
  // configured, so the refusal is the missing publish-change result, not missing configuration.
  const calls = [];
  const errors = [];
  const previousActor = process.env.FLOW_AGENTS_ACTOR;
  process.env.FLOW_AGENTS_ACTOR = HOLDER;
  const originalError = console.error;
  console.error = (...args) => { errors.push(args.join(" ")); };
  let exitCode;
  try {
    exitCode = await mergeChangeMain(["execute", "--session-dir", fx.sessionDir, "--strategy", "squash", "--authorization-file", path.join(fx.sessionDir, "merge-authorization.json")], {
      authorizeOperation: () => { calls.push("authorize"); throw new Error("authorization must not be reached"); },
      executeProvider: async () => { calls.push("provider"); throw new Error("provider must not be reached"); },
    });
  } finally {
    console.error = originalError;
    if (previousActor === undefined) delete process.env.FLOW_AGENTS_ACTOR;
    else process.env.FLOW_AGENTS_ACTOR = previousActor;
  }
  assert.equal(exitCode, 1, `merge-change must refuse a review-existing run: ${errors.join("\n")}`);
  assert.match(errors.join("\n"), /merge-change: .*publish-change\.result\.json/);
  assert.deepEqual(calls, [], "merge-change must refuse before authorization or any provider mutation");
  assert.equal(fs.existsSync(path.join(fx.sessionDir, "merge-change.result.json")), false);
});

// ─── (d) the key protection ──────────────────────────────────────────────────────────────────

test("a commit after start cannot be verified, even when every claim is re-recorded at the new head", () => {
  const fx = makeExistingChange(17);
  assertOk(start(fx), "start");
  assertOk(recordPreExisting(fx), "pre-existing-implementation");
  assert.equal(runState(fx).current_step, "verify");

  // Someone "fixes" the change inside the review run, then re-records everything at the new head.
  fs.writeFileSync(path.join(fx.project, "feature.txt"), "edited during review\n");
  git(fx.project, ["commit", "-qam", "edited during review"]);
  const newHead = git(fx.project, ["rev-parse", "HEAD"]);
  const pinned = new RegExp(`pinned to source head ${fx.head}, but the checked-out HEAD is ${newHead}`);

  // A critique is a report-only write (it evaluates no gate), so it records; the claim that would
  // complete verify is refused at gate evaluation, naming both commits.
  assertOk(critique(fx), "critique at the new head");
  const tested = testsEvidence(fx);
  assert.notEqual(tested.status, 0, `tests-evidence at a new head must not complete verify:\n${tested.output}`);
  assert.match(tested.output, pinned);
  assert.match(tested.output, /A new head needs a new run/);
  const state = runState(fx);
  assert.equal(state.status, "active", "the run must not complete on evidence about another commit");
  assert.equal(state.current_step, "verify");
  assert.equal(state.params.source_head, fx.head);
});

// ─── The per-claim half of the pin ───────────────────────────────────────────────────────────

test("a non-command pre-existing claim observed in a dirty tree cannot satisfy its gate", () => {
  const fx = makeExistingChange(18);
  assertOk(start(fx), "start");
  // HEAD is still the pinned commit; only the tree is dirty. The Flow-head freshness fast path
  // would accept this claim, because no command backs it.
  fs.writeFileSync(path.join(fx.project, "scratch.txt"), "uncommitted work\n");
  const dirty = recordPreExisting(fx);
  assert.notEqual(dirty.status, 0, `a dirty-tree claim must be refused:\n${dirty.output}`);
  assert.match(dirty.output, new RegExp(`was observed at ${fx.head} in a dirty worktree; this run accepts only evidence observed in a clean worktree at its pinned source head ${fx.head}`));
  assert.equal(runState(fx).current_step, "existing-change");
  // DISCRIMINATOR: the same claim from the clean tree advances the run.
  fs.rmSync(path.join(fx.project, "scratch.txt"));
  assertOk(recordPreExisting(fx), "clean pre-existing-implementation");
  assert.equal(runState(fx).current_step, "verify");
});

// ─── Reviewer identity, tests, and concurrency ───────────────────────────────────────────────

test("verify requires an independent reviewer and real tests", () => {
  const fx = makeExistingChange(19);
  assertOk(start(fx), "start");
  assertOk(recordPreExisting(fx), "pre-existing-implementation");
  const self = critique(fx, HOLDER);
  assert.notEqual(self.status, 0);
  assert.match(self.output, /requires a reviewer identity distinct from the active implementation assignment actor/);
  assertOk(critique(fx, REVIEWER), "independent critique");
  assert.equal(runState(fx).current_step, "verify", "a clean critique alone cannot complete verify");
  const zero = testsEvidence(fx, "node --test checks/empty.test.mjs");
  assert.notEqual(zero.status, 0, `a command that runs zero tests must be refused:\n${zero.output}`);
  assert.match(zero.output, /tests-evidence command must resolve through a non-vacuous package script or a known test\/check\/verify\/eval runner or project-local test path/);
  assert.equal(runState(fx).status, "active");
  assertOk(testsEvidence(fx), "tests-evidence");
  assert.equal(runState(fx).status, "completed");
});

test("one Work Item cannot carry a builder.build run and an existing-change run at once", () => {
  const review = makeExistingChange(20);
  assertOk(start(review), "review start");
  const build = workflow(review, startArgs(review, "builder.build"));
  assert.notEqual(build.status, 0);
  assert.match(build.output, /cannot resume builder\.review-existing as builder\.build/);

  const built = makeExistingChange(21);
  assertOk(workflow(built, startArgs(built, "builder.build")), "build start");
  const reviewed = start(built);
  assert.notEqual(reviewed.status, 0);
  assert.match(reviewed.output, /cannot resume builder\.build as builder\.review-existing/);
});
