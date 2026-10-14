// #1415 slice 2: `builder.deliver-existing` — review, verify, and MERGE a change that already exists
// as an open pull request, without a retroactive Builder implementation claim.
//
// The invariant this file pins (the design's "parity"):
//   - the delivery checkpoint commit == the run's pinned source head == the adopted PR's head;
//   - the merged terminal head T == the pinned head plus exactly this session's delivery-only commit;
//   - the provider's PR head == T at merge time.
//
// Flow and CLI steps run as child processes through the public CLI over a real Git fixture.
// Provider steps run in-process: publish-change through the runtime's provider-factory seam with
// the real GitHub adapter and an injected `gh` executor, merge-change through its main(argv, deps)
// seams. Production refuses a `gh` that is not on a secure system path, and no test here may reach
// GitHub.
//
// Run: `npm run test:unit`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { flowAdmissionRefusal } from "../../build/src/lib/flow-admission.js";
import { canonicalRunFlowIds, isCanonicalRunFlowId } from "../../build/src/builder-flow-run-adapter.js";
import { resolveEffectiveFlowDefinition } from "../../build/src/lib/flow-resolver.js";
import { declaredFlowBindsOperation } from "../../build/src/builder-gate-action-envelope.js";
import { createGithubChangeProvider } from "../../build/src/cli/github-change-provider.js";
import { executeMergeChangeProvider } from "../../build/src/cli/merge-change-provider.js";
import { main as mergeChangeMain } from "../../build/src/cli/merge-change.js";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const CLI = path.resolve(REPO_ROOT, "build/src/cli.js");

const FLOW = "builder.deliver-existing";
const CHILD = "builder.publish-existing";
const HOLDER = "deliver-existing-holder";
const REVIEWER = "deliver-existing-reviewer";
const GH_ACTOR = "existing-change-gh-actor";
const TEST_COMMAND = "node --test checks/existing.test.mjs";
const REPO = "acme/widgets";

/**
 * The private provider-factory seam (`executePublishChangeOperationWithProvider`) is exported only
 * from an instrumented copy of the built module, the same way builder-flow-runtime.test.mjs reaches
 * issue/complete. The public operation always uses the trusted-executable factory.
 */
async function loadRuntimeSeam() {
  const source = new URL("../../build/src/builder-flow-runtime.js", import.meta.url);
  const transient = new URL(`../../build/src/.builder-deliver-existing.test-seam-${process.pid}-${Date.now()}.mjs`, import.meta.url);
  fs.writeFileSync(transient, `${fs.readFileSync(source, "utf8")}\nexport { executePublishChangeOperationWithProvider };\n`, { flag: "wx" });
  try {
    return await import(`${transient.href}?seam=${Date.now()}`);
  } finally {
    fs.unlinkSync(transient);
  }
}
const runtimeSeam = await loadRuntimeSeam();

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * A consumer repository whose change ALREADY EXISTS on a same-repository pull request branch: a base
 * commit on main and the change on `feature/existing-<n>`, which is checked out.
 */
function makeExistingChange(number) {
  const project = fs.realpathSync(makeFixtureDir("deliver-existing-"));
  fs.mkdirSync(path.join(project, "checks"), { recursive: true });
  fs.mkdirSync(path.join(project, "context", "settings"), { recursive: true });
  git(project, ["init", "-q", "-b", "main", "."]);
  git(project, ["config", "user.email", "deliver-existing@example.invalid"]);
  git(project, ["config", "user.name", "Deliver Existing"]);
  git(project, ["config", "core.hooksPath", "/dev/null"]);
  git(project, ["remote", "add", "origin", `https://github.com/${REPO}.git`]);
  fs.writeFileSync(path.join(project, ".gitignore"), ".kontourai/\n");
  fs.writeFileSync(path.join(project, "checks", "existing.test.mjs"),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('existing change works', () => { assert.equal(1 + 1, 2); });\n");
  fs.writeFileSync(path.join(project, "context", "settings", "change-provider-settings.json"), `${JSON.stringify({
    schema_version: "1.0",
    defaults: { provider: { role: "ChangeProvider", kind: "github", repository: { owner: "acme", name: "widgets" }, capabilities: ["change.create", "change.observe", "change.merge"], executor: "gh-cli" } },
  }, null, 2)}\n`);
  git(project, ["add", "."]);
  git(project, ["commit", "-qm", "base"]);
  const base = git(project, ["rev-parse", "HEAD"]);
  const branch = `feature/existing-${number}`;
  git(project, ["checkout", "-q", "-b", branch]);
  fs.writeFileSync(path.join(project, "feature.txt"), "the existing change\n");
  git(project, ["add", "."]);
  git(project, ["commit", "-qm", "existing change"]);
  const head = git(project, ["rev-parse", "HEAD"]);
  const workItem = `${REPO}#${number}`;
  const slug = `acme-widgets-${number}`;
  const artifactRoot = path.join(project, ".kontourai", "flow-agents");
  const sessionDir = path.join(artifactRoot, slug);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, `${slug}--pull-work.md`), `Selected Work Item: ${workItem}\n`);
  return {
    project, base, head, branch, number, workItem, slug, artifactRoot, sessionDir,
    prUrl: `https://github.com/${REPO}/pull/${number}`,
    runDir: path.join(project, ".kontourai", "flow", "runs", slug),
  };
}

function workflow(fx, args, actor = HOLDER, env = {}) {
  const result = spawnSync(process.execPath, [CLI, "workflow", ...args], {
    cwd: fx.project, encoding: "utf8", env: { ...process.env, FLOW_AGENTS_ACTOR: actor, ...env },
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}`, stdout: result.stdout };
}

function assertOk(result, label) {
  assert.equal(result.status, 0, `${label} failed:\n${result.output}`);
}

function refused(result, pattern, label) {
  assert.notEqual(result.status, 0, `${label} must be refused:\n${result.output}`);
  assert.match(result.output, pattern, label);
}

function runState(fx) {
  return JSON.parse(fs.readFileSync(path.join(fx.runDir, "state.json"), "utf8"));
}

function manifest(fx) {
  return JSON.parse(fs.readFileSync(path.join(fx.runDir, "evidence", "manifest.json"), "utf8"));
}

function start(fx, flow = FLOW) {
  return workflow(fx, ["start", "--artifact-root", fx.artifactRoot, "--flow", flow, "--work-item", fx.workItem,
    "--assignment-provider", "local-file", "--criterion", "The existing change passes its tests.",
    ...(flow === FLOW ? ["--source-head", fx.head] : [])]);
}

function existingChangeReport(fx) {
  const file = path.join(fx.sessionDir, `${fx.slug}--existing-change.md`);
  fs.writeFileSync(file, `# Existing change\n\nChange: ${fx.prUrl}\nBase: ${fx.base}\nHead: ${fx.head}\nChanged files: feature.txt\n`);
  return file;
}

function recordPreExisting(fx) {
  const file = existingChangeReport(fx);
  return workflow(fx, ["evidence", "--session-dir", fx.sessionDir, "--expectation", "pre-existing-implementation", "--status", "pass",
    "--summary", "The change existed before this run at the pinned head.",
    "--evidence-ref-json", JSON.stringify({ kind: "provider", url: fx.prUrl, summary: "The existing pull request." }),
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

function testsEvidence(fx) {
  const criterionId = JSON.parse(fs.readFileSync(path.join(fx.sessionDir, "acceptance.json"), "utf8")).criteria[0].id;
  const ref = { kind: "command", excerpt: TEST_COMMAND, summary: "Project test for the existing change." };
  return workflow(fx, ["evidence", "--session-dir", fx.sessionDir, "--expectation", "tests-evidence", "--status", "pass",
    "--summary", "The existing change passes its tests.", "--command", TEST_COMMAND,
    "--evidence-ref-json", JSON.stringify(ref),
    "--criterion-json", JSON.stringify({ id: criterionId, status: "pass", evidence_refs: [ref] }), "--json"]);
}

function releaseRef(fx) {
  const file = path.join(fx.sessionDir, "release.json");
  fs.writeFileSync(file, `${JSON.stringify({
    schema_version: "1.0", task_slug: fx.slug, decision: "merge", updated_at: new Date().toISOString(), scope: "existing change",
    evidence_ref: `${fx.slug}--existing-change.md`, gates: [{ name: "ci", status: "pass", summary: "Required checks pass at the pinned head." }],
    rollback_plan: { status: "not_required", summary: "Revert the merge.", owner: "holder" }, observability_plan: { status: "not_required", summary: "None." },
    post_deploy_checks: [], docs: { status: "not_needed", summary: "None." },
  }, null, 2)}\n`);
  return JSON.stringify({ kind: "artifact", file, summary: "Release readiness at the pinned head." });
}

function learningRef(fx) {
  const file = path.join(fx.sessionDir, "learning.json");
  fs.writeFileSync(file, `${JSON.stringify({
    schema_version: "1.0", task_slug: fx.slug, status: "learned", updated_at: new Date().toISOString(),
    records: [{ id: "existing-change", recorded_at: new Date().toISOString(), source_refs: [`${fx.slug}--existing-change.md`], outcome: "success",
      facts: ["The existing change was delivered at its pinned head."], interpretation: "No workflow correction is needed.",
      routing: [{ target: "none", action: "No follow-up required.", status: "completed" }], correction: { needed: false, evidence: "The route passed." } }],
  }, null, 2)}\n`);
  return JSON.stringify({ kind: "artifact", file, summary: "Learning from the delivery." });
}

function ciReadiness(fx, extra = ["--status", "pass"]) {
  return workflow(fx, ["evidence", "--session-dir", fx.sessionDir, "--expectation", "ci-merge-readiness", ...extra,
    "--summary", "CI and review support merging the pinned head.", "--evidence-ref-json", releaseRef(fx), "--json"]);
}

function learnEvidence(fx, expectation) {
  return workflow(fx, ["evidence", "--session-dir", fx.sessionDir, "--expectation", expectation, "--status", "pass",
    "--summary", `${expectation} for the delivered existing change.`, "--evidence-ref-json", learningRef(fx), "--json"]);
}

async function withActor(actor, fn) {
  const previous = process.env.FLOW_AGENTS_ACTOR;
  process.env.FLOW_AGENTS_ACTOR = actor;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.FLOW_AGENTS_ACTOR;
    else process.env.FLOW_AGENTS_ACTOR = previous;
  }
}

async function captureConsole(fn) {
  const out = [];
  const err = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values) => out.push(values.join(" "));
  console.error = (...values) => err.push(values.join(" "));
  try {
    const status = await fn();
    return { status, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

// ─── Provider fakes (no test reaches GitHub) ─────────────────────────────────────────────────

/** A `gh` that knows the one open pull request for the fixture's branch, for publish-change. */
function fakeAdoptGithub(fx, { list, record, onList } = {}) {
  const calls = [];
  const prRecord = {
    node_id: `PR_existing_${fx.number}`, number: fx.number, html_url: fx.prUrl, state: "open", merged: false,
    // Neither is anything this run set; adoption must not read them.
    title: "A title this run never set", body: "A body this run never set", draft: false,
    base: { ref: "main", repo: { full_name: REPO } },
    head: { ref: fx.branch, sha: fx.head, repo: { full_name: REPO } },
  };
  const listed = { id: prRecord.node_id, number: fx.number, state: "OPEN", baseRefName: "main", headRefName: fx.branch, headRefOid: fx.head, title: prRecord.title, body: prRecord.body, isDraft: false };
  return {
    calls,
    creates: () => calls.filter((argv) => argv[0] === "pr" && argv[1] === "create"),
    executor: async (_file, argv) => {
      calls.push([...argv]);
      if (argv[0] === "auth" && argv[1] === "token") return { stdout: "fixture-token" };
      if (argv[0] === "auth") return { stdout: "" };
      if (argv[0] === "api" && argv[1] === "user") return { stdout: JSON.stringify({ login: GH_ACTOR }) };
      if (argv[0] === "api" && argv[1] === `repos/${REPO}`) return { stdout: JSON.stringify({ full_name: REPO }) };
      if (argv[0] === "pr" && argv[1] === "list") {
        onList?.();
        return { stdout: JSON.stringify(list ?? [listed]) };
      }
      if (argv[0] === "api" && argv[1] === `repos/${REPO}/pulls/${fx.number}`) return { stdout: JSON.stringify(record ? record(structuredClone(prRecord)) : prRecord) };
      if (argv[0] === "pr" && argv[1] === "create") return { stdout: `${fx.prUrl}\n` };
      throw new Error(`unexpected gh invocation: ${argv.join(" ")}`);
    },
  };
}

function adopt(fx, github, intent = { base_ref: "main", head_ref: fx.branch, head_sha: fx.head }) {
  return withActor(HOLDER, () => runtimeSeam.executePublishChangeOperationWithProvider(
    { sessionDir: fx.sessionDir, intent },
    (settings, configurationId) => createGithubChangeProvider(settings, configurationId, { executor: github.executor, executable: "gh", now: () => new Date().toISOString() }),
  ));
}

/** Nothing was adopted: the run is still at pr-open and no provider result was persisted. */
function assertNotAdopted(fx, github, label) {
  const state = runState(fx);
  assert.equal(state.status, "active", label);
  assert.equal(state.current_step, "pr-open", `${label}: the gate must not advance`);
  assert.equal(fs.existsSync(path.join(fx.sessionDir, "publish-change.result.json")), false, `${label}: no provider result may be persisted`);
  if (github) assert.deepEqual(github.creates(), [], `${label}: adoption never opens a pull request`);
}

/** A `gh` for merge-change execute, at the terminal head T unless told otherwise. */
function fakeMergeGithub(fx, terminalHead, options = {}) {
  const {
    actor = GH_ACTOR, headSha = terminalHead, baseRef = "main", checks = [{ bucket: "pass", name: "required-ci", link: "https://example.test/ci" }],
    reviewDecision = "APPROVED", mergeStateStatus = "CLEAN", alreadyMerged = false, mergedBy = GH_ACTOR,
  } = options;
  const calls = [];
  let merged = alreadyMerged;
  return {
    calls,
    puts: () => calls.filter((argv) => argv[0] === "api" && argv[1] === "--method" && argv[2] === "PUT"),
    executor: async (_file, argv) => {
      calls.push([...argv]);
      if (argv[0] === "auth" && argv[1] === "token") return { stdout: "fixture-token" };
      if (argv[0] === "auth") return { stdout: "" };
      if (argv[0] === "api" && argv[1] === "user") return { stdout: JSON.stringify({ login: actor }) };
      if (argv[0] === "api" && argv[1] === `repos/${REPO}`) return { stdout: JSON.stringify({ full_name: REPO, allow_squash_merge: true, allow_rebase_merge: true, allow_merge_commit: true, allow_auto_merge: true }) };
      if (argv[0] === "api" && argv[1] === `repos/${REPO}/branches/main/protection`) return { stdout: JSON.stringify({ enforce_admins: { enabled: true }, required_pull_request_reviews: { required_approving_review_count: 1 } }) };
      if (argv[0] === "api" && argv[1] === `repos/${REPO}/rules/branches/main`) return { stdout: JSON.stringify([{ type: "pull_request", parameters: { required_approving_review_count: 1 } }]) };
      if (argv[0] === "api" && argv[1] === `repos/${REPO}/pulls/${fx.number}`) {
        return { stdout: JSON.stringify({ base: { ref: baseRef, repo: { full_name: REPO } }, head: { ref: fx.branch, sha: headSha, repo: { full_name: REPO } }, merged, merge_commit_sha: merged ? "c".repeat(40) : null, merged_by: merged ? { login: mergedBy } : null }) };
      }
      if (argv[0] === "pr" && argv[1] === "checks") return { stdout: JSON.stringify(checks) };
      if (argv[0] === "api" && argv[1] === "graphql") {
        return { stdout: JSON.stringify({ data: { viewer: { login: actor }, repository: { pullRequest: { headRefOid: headSha, isDraft: false, merged: false, reviewDecision, mergeable: "MERGEABLE", mergeStateStatus } } } }) };
      }
      if (argv[0] === "api" && argv[1] === "--method" && argv[2] === "PUT") {
        merged = true;
        return { stdout: JSON.stringify({ merged: true, sha: "c".repeat(40) }) };
      }
      throw new Error(`unexpected gh invocation: ${argv.join(" ")}`);
    },
  };
}

function mergeRequest(fx) {
  return withActor(HOLDER, () => captureConsole(() => mergeChangeMain(
    ["request", "--session-dir", fx.sessionDir, "--strategy", "squash", "--out", path.join(fx.sessionDir, "unsigned-merge-authorization.json")],
    { preflightProvider: async () => ({ status: "satisfied", base_ref: "main" }) },
  )));
}

function mergeExecute(fx, github, strategy = "squash") {
  return withActor(HOLDER, () => captureConsole(() => mergeChangeMain(
    ["execute", "--session-dir", fx.sessionDir, "--strategy", strategy, "--authorization-file", path.join(fx.sessionDir, "signed-merge-authorization.json")],
    {
      authorizeOperation: (_context, issued) => ({ run_id: fx.slug, operation_status: "applied", authorized_action_id: issued.action_id, completion: {} }),
      executeProvider: (settings, action) => executeMergeChangeProvider(settings, action, { executor: github.executor, executable: "gh", now: () => new Date().toISOString() }),
    },
  )));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// ─── The definition ──────────────────────────────────────────────────────────────────────────

test("the definition delivers an existing change: review-existing's gates, an adopting closeout, no implementation step", () => {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "kits/builder/flows", name), "utf8"));
  const review = read("review-existing.flow.json");
  const deliver = read("deliver-existing.flow.json");
  const publishLearn = read("publish-learn.flow.json");
  const publishExisting = read("publish-existing.flow.json");
  assert.equal(deliver.id, FLOW);
  assert.match(deliver.description, /EXISTING-CHANGE DELIVERY: no implementation step; the head is pinned at start/);
  assert.match(deliver.description, /never opens one/);
  assert.deepEqual(deliver.source_binding, { head: "pinned-at-start" });
  assert.deepEqual(deliver.steps.map((step) => [step.id, step.uses_flow ?? null]), [
    ["pull-work", null], ["existing-change", null], ["verify", null],
    ["pr-open", CHILD], ["merge-ready-ci", CHILD], ["learn", CHILD], ["done", null],
  ]);
  // The v1 review gates are reused byte for byte, so verification means exactly what it means there.
  assert.deepEqual(deliver.gates, review.gates);

  // The child is publish-learn minus the implementation_defect route; only the adoption wording of
  // the pull-request expectation differs. Step and expectation ids the runtime binds are unchanged.
  assert.equal(publishExisting.id, CHILD);
  const expected = structuredClone(publishLearn.gates);
  delete expected["merge-ready-ci-gate"].on_route_back.implementation_defect;
  const prOpen = (gates) => gates["pr-open-gate"].expects[0];
  assert.match(prOpen(publishExisting.gates).description, /existing pull request is adopted .* at the pinned source head\. This route never opens a pull request\./);
  prOpen(expected).description = prOpen(publishExisting.gates).description;
  assert.deepEqual(publishExisting.gates, expected);
  assert.deepEqual(publishExisting.steps, publishLearn.steps);
  assert.deepEqual(publishExisting.exports, publishLearn.exports);
  assert.equal(prOpen(publishExisting.gates).id, "pull-request-opened");

  // Composed: exactly one freshness turnstile, no route to an execute step, and the run ends at learn.
  const resolved = resolveEffectiveFlowDefinition(FLOW, REPO_ROOT);
  assert.deepEqual(resolved.source_binding, { head: "pinned-at-start" }, "the pin survives composition, so the definition digest covers it");
  assert.deepEqual(Object.entries(resolved.gates).filter(([, gate]) => gate.requires_current_verification === true).map(([id]) => id), [`${CHILD}:merge-ready-ci-gate`]);
  const routeTargets = Object.values(resolved.gates).flatMap((gate) => Object.values(gate.on_route_back ?? {}));
  assert.deepEqual([...new Set(routeTargets)], ["verify"], "every route-back returns to verify; none reaches an implementation step");
  assert.equal(resolved.steps.at(-1).id, "learn");
  assert.equal(resolved.steps.at(-1).next, null);

  const kit = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "kits/builder/kit.json"), "utf8"));
  const rows = kit.flow_step_actions.filter((row) => row.flow_id === FLOW);
  assert.deepEqual(rows.map((row) => row.step_id), ["pull-work", "existing-change", "verify", "pr-open", "merge-ready-ci", "learn", "done"]);
  assert.deepEqual(rows.filter((row) => row.implementation_allowed), [], "no step of this flow may allow implementation");
  assert.deepEqual(rows.find((row) => row.step_id === "pr-open").operations, ["publish-change"]);
  const producers = (flowId, expectationId) => kit.skill_roles.filter((role) => role.role === "step"
    && [role.flow_id, ...(role.flow_ids ?? [])].includes(flowId) && role.expectation_ids.includes(expectationId)).map((role) => role.skill_id);
  assert.deepEqual(producers(FLOW, "pre-existing-implementation"), ["builder.review-existing"]);
  assert.deepEqual(producers(CHILD, "ci-merge-readiness"), ["builder.release-readiness"]);
  assert.deepEqual(producers(CHILD, "decision-evidence"), ["builder.learning-review"]);

  assert.equal(flowAdmissionRefusal(FLOW, REPO_ROOT, "workflow start --flow"), null);
  assert.equal(isCanonicalRunFlowId(FLOW), true);
  assert.ok(canonicalRunFlowIds().includes(FLOW));
  assert.equal(isCanonicalRunFlowId(CHILD), false, "the child closeout is composed, never run on its own");
  // merge-change binds this flow's publish-change step; v1 review-only runs stay refused.
  assert.equal(declaredFlowBindsOperation(FLOW, "publish-change", REPO_ROOT), true);
  assert.equal(declaredFlowBindsOperation("builder.review-existing", "publish-change", REPO_ROOT), false);
});

test("the definitions in-flight runs pin are byte-for-byte unchanged", () => {
  // A run load deep-compares its start definition with the effective one, so editing any of these
  // would break every in-flight run of it. Digests are of the files at 737c1b15.
  for (const [file, digest] of [
    ["build.flow.json", "89e29301603a5ea9c78201d776b9aec89bd7771eb5cb0021841e035786d0f260"],
    ["build-lean.flow.json", "d6cd858430480c605022b233004ddd30121540bb9416188ffa6270ba80791112"],
    ["publish-learn.flow.json", "5b81a6c5d2a5d619766b8e0390bc182448f8c82223baa2812b97476866e4c0ca"],
    ["review-existing.flow.json", "4bb803d9e22d8ba746fb49802806fb42b786ef86dd7b394ec132a94fee95ae0e"],
  ]) {
    assert.equal(sha256(fs.readFileSync(path.join(REPO_ROOT, "kits/builder/flows", file))), digest, file);
  }
});

// ─── The whole route, one fixture ────────────────────────────────────────────────────────────
//
// The tests below share one fixture and run in order: they walk a single run from start to merge,
// pinning each refusal at the step where it applies. A failure early stops the rest.

const fx = makeExistingChange(9);
let terminalHead = null;
let issuedMergeAction = null;

test("a run reaches pr-open at the pinned head; the assignment holder cannot critique it", () => {
  assertOk(start(fx), "start");
  assert.equal(runState(fx).params.source_head, fx.head);
  assertOk(recordPreExisting(fx), "pre-existing-implementation");
  assert.equal(runState(fx).current_step, "verify");
  refused(critique(fx, HOLDER), /requires a reviewer identity distinct from the active implementation assignment actor/, "a critique by the assignment holder");
  assertOk(critique(fx), "independent critique");
  assertOk(testsEvidence(fx), "tests-evidence");
  assert.equal(runState(fx).current_step, "pr-open");
});

test("publish-change for a pinned run takes no title, body, or draft flag", async () => {
  for (const flags of [["--title", "Mine now"], ["--body", "Rewritten"], ["--draft"]]) {
    const result = spawnSync(process.execPath, [CLI, "publish-change", "execute", "--session-dir", fx.sessionDir, "--head-ref", fx.branch, "--base-ref", "main", ...flags], {
      cwd: fx.project, encoding: "utf8", env: { ...process.env, FLOW_AGENTS_ACTOR: HOLDER },
    });
    assert.equal(result.status, 1, `${flags[0]} must be refused:\n${result.stderr}`);
    assert.match(result.stderr, new RegExp(`publish-change: publish-change execute adopts the existing pull request for this session's pinned run and never opens one, so it does not accept ${flags[0]}`));
  }
  // The operation applies the same rule itself; the CLI check is only an early refusal.
  const github = fakeAdoptGithub(fx);
  await assert.rejects(adopt(fx, github, { title: "Mine now", body: "Rewritten", base_ref: "main", head_ref: fx.branch, head_sha: fx.head }),
    /builder\.deliver-existing adopts the existing pull request at its pinned source head and never opens one, so it takes no title, body, or draft flag/);
  assert.deepEqual(github.calls, [], "the refusal comes before any provider call");
  assertNotAdopted(fx, github, "caller-supplied title");
});

test("adoption refuses when there is no pull request, and never opens one", async () => {
  const github = fakeAdoptGithub(fx, { list: [] });
  await assert.rejects(adopt(fx, github), /no pull request exists for the pinned head and base refs; an existing-change run adopts a pull request and never opens one/);
  assertNotAdopted(fx, github, "no pull request");
});

test("adoption refuses a duplicate, closed, merged, moved, or fork pull request", async () => {
  const listed = (overrides) => [{ id: `PR_existing_${fx.number}`, number: fx.number, state: "OPEN", baseRefName: "main", headRefName: fx.branch, headRefOid: fx.head, title: "t", body: "b", isDraft: false, ...overrides }];
  for (const [label, options, pattern] of [
    ["duplicate", { list: [...listed(), ...listed({ id: "PR_other", number: fx.number + 100 })] }, /more than one pull request exists/],
    ["closed", { list: listed({ state: "CLOSED" }) }, /closed or merged; an existing-change run adopts only an open pull request/],
    ["merged", { list: listed({ state: "MERGED" }) }, /closed or merged/],
    ["provider head moved", { list: listed({ headRefOid: fx.base }) }, /the pull request head has moved off the pinned source head/],
    ["fork", { record: (record) => ({ ...record, head: { ...record.head, repo: { full_name: "attacker/widgets" } } }) }, /adopts only a same-repository pull request/],
    ["merged since listing", { record: (record) => ({ ...record, state: "closed", merged: true }) }, /an adopted change must be open/],
  ]) {
    const github = fakeAdoptGithub(fx, options);
    await assert.rejects(adopt(fx, github), pattern, label);
    assertNotAdopted(fx, github, label);
  }
});

test("adoption refuses a local head other than the pinned one, a moved HEAD, or a dirty tree", async () => {
  // A local branch that names another commit: the intent's head is not the pinned head.
  git(fx.project, ["branch", "-f", "elsewhere", fx.base]);
  let github = fakeAdoptGithub(fx);
  await assert.rejects(adopt(fx, github, { base_ref: "main", head_ref: "elsewhere", head_sha: fx.base }),
    new RegExp(`${fx.base} is not the source head ${fx.head} this builder\\.deliver-existing run was started at; it adopts a pull request only at that commit`));
  assert.deepEqual(github.calls, [], "refused before any provider call");
  assertNotAdopted(fx, github, "local head ref elsewhere");

  // HEAD checked out elsewhere, though the PR branch still names the pinned head.
  git(fx.project, ["checkout", "-q", "--detach", fx.base]);
  try {
    github = fakeAdoptGithub(fx);
    await assert.rejects(adopt(fx, github), new RegExp(`pinned to source head ${fx.head}, but the checked-out HEAD is ${fx.base}`));
    assert.deepEqual(github.calls, []);
    assertNotAdopted(fx, github, "HEAD moved");
  } finally {
    git(fx.project, ["checkout", "-q", fx.branch]);
  }

  // A dirty tree at the pinned head.
  fs.writeFileSync(path.join(fx.project, "scratch.txt"), "uncommitted\n");
  try {
    github = fakeAdoptGithub(fx);
    await assert.rejects(adopt(fx, github), new RegExp(`the Git worktree has uncommitted or untracked changes; builder\\.deliver-existing adopts its pull request only from a clean worktree at its pinned source head ${fx.head}`));
    assert.deepEqual(github.calls, []);
    assertNotAdopted(fx, github, "dirty tree");
  } finally {
    fs.rmSync(path.join(fx.project, "scratch.txt"));
  }
});

test("adoption re-proves the pin under the lock after the provider call, before the gate advances", async () => {
  // The provider call is outside the lock. A tree or HEAD that changes during it must be caught by
  // the commit phase, which is the only pin check on this evidence path (it bypasses bundleGateEvidence).
  let github = fakeAdoptGithub(fx, { onList: () => fs.writeFileSync(path.join(fx.project, "scratch.txt"), "written during the provider call\n") });
  try {
    await assert.rejects(adopt(fx, github), /the Git worktree has uncommitted or untracked changes; builder\.deliver-existing adopts its pull request only from a clean worktree/);
    assert.ok(github.calls.some((argv) => argv[0] === "pr" && argv[1] === "list"), "the provider was reached, so the commit phase refused");
    assertNotAdopted(fx, github, "dirtied during the provider call");
  } finally {
    fs.rmSync(path.join(fx.project, "scratch.txt"), { force: true });
  }
  github = fakeAdoptGithub(fx, { onList: () => git(fx.project, ["checkout", "-q", "--detach", fx.base]) });
  try {
    await assert.rejects(adopt(fx, github), new RegExp(`pinned to source head ${fx.head}, but the checked-out HEAD is ${fx.base}`));
    assertNotAdopted(fx, github, "HEAD moved during the provider call");
  } finally {
    git(fx.project, ["checkout", "-q", fx.branch]);
  }
});

test("adoption refuses a pull request other than the one the pre-existing claim names", async () => {
  const other = `https://github.com/${REPO}/pull/${fx.number + 1}`;
  const github = fakeAdoptGithub(fx, { record: (record) => ({ ...record, html_url: other }) });
  await assert.rejects(adopt(fx, github), new RegExp(`the adopted pull request ${other.replaceAll("/", "\\/")} must be the one this run's pre-existing-implementation claim names as its provider record, and that claim names ${fx.prUrl.replaceAll("/", "\\/")}`));
  assertNotAdopted(fx, github, "another pull request");
});

test("adoption of the named open pull request advances pr-open at the pinned head, with a clean snapshot", async () => {
  const github = fakeAdoptGithub(fx);
  const result = await adopt(fx, github);
  assert.deepEqual(github.creates(), [], "adoption never opens a pull request");
  assert.equal(github.calls.some((argv) => argv.includes("--title") || argv.includes("--body")), false);
  assert.equal(result.observation.change_ref.head_sha, fx.head);
  assert.equal(result.observation.change_ref.url, fx.prUrl);
  assert.equal(result.observation.change_ref.state, "open");
  assert.equal(result.observation.provider_actor, GH_ACTOR);
  assert.equal(runState(fx).current_step, "merge-ready-ci");
  const persisted = JSON.parse(fs.readFileSync(path.join(fx.sessionDir, "publish-change.result.json"), "utf8"));
  assert.equal(persisted.change_ref.head_sha, fx.head);
  // The adoption claim carries the clean worktree it was observed in, like every claim a pinned run accepts.
  const entry = manifest(fx).evidence.find((candidate) => candidate.gate_id === `${CHILD}:pr-open-gate` && candidate.producer === "publish-change-operation-authority");
  assert.ok(entry, "the operation-bound evidence is attached to the adopting closeout's pr-open gate");
  const claim = entry.bundle.claims.find((candidate) => candidate.metadata?.verification_workspace_snapshot);
  assert.ok(claim, "the adoption claim carries a workspace snapshot");
  assert.equal(claim.metadata.verification_workspace_snapshot.head_sha, fx.head);
  assert.equal(claim.metadata.verification_workspace_snapshot.worktree_clean, true);
});

test("at merge-ready-ci: provisional delivery, an implementation_defect route, and a moved HEAD are refused", () => {
  const provisional = /provisional delivery is refused for builder\.deliver-existing runs: the run is pinned to source head [0-9a-f]{40}, and a provisional delivery commit would move the pull request head off it/;
  refused(workflow(fx, ["publish-provisional-delivery-request", "--session-dir", fx.sessionDir]), provisional, "provisional delivery request");
  refused(workflow(fx, ["publish-provisional-delivery", "--session-dir", fx.sessionDir, "--authorization-file", path.join(fx.sessionDir, "provisional.json"), "--json"]), provisional, "provisional delivery");
  assert.equal(fs.existsSync(path.join(fx.project, "delivery")), false, "no delivery output may be written");

  refused(ciReadiness(fx, ["--status", "fail", "--route-reason", "implementation_defect"]), /implementation_defect/, "an implementation_defect route");
  assert.equal(runState(fx).current_step, "merge-ready-ci");
  assert.equal(runState(fx).status, "active");

  fs.writeFileSync(path.join(fx.project, "feature.txt"), "edited at merge-ready-ci\n");
  git(fx.project, ["commit", "-qam", "edited at merge-ready-ci"]);
  const moved = git(fx.project, ["rev-parse", "HEAD"]);
  try {
    // Here the #1302 freshness turnstile refuses first: the verification evidence no longer matches
    // the workspace. The source pin is the next line of defense behind it.
    refused(ciReadiness(fx), /builder\.publish-existing:merge-ready-ci-gate declares requires_current_verification: a passing ci-merge-readiness claim cannot advance the cursor/, `CI readiness at a moved HEAD ${moved}`);
    assert.equal(runState(fx).current_step, "merge-ready-ci");
  } finally {
    git(fx.project, ["reset", "-q", "--hard", fx.head]);
  }
  assertOk(ciReadiness(fx), "CI readiness at the pinned head");
  assert.equal(runState(fx).current_step, "learn");
});

test("at learn: a moved HEAD is refused; the completed run ends at learn and seals delivery at the pinned head", () => {
  fs.writeFileSync(path.join(fx.project, "feature.txt"), "edited at learn\n");
  git(fx.project, ["commit", "-qam", "edited at learn"]);
  const moved = git(fx.project, ["rev-parse", "HEAD"]);
  try {
    refused(learnEvidence(fx, "learning-evidence"), new RegExp(`pinned to source head ${fx.head}, but the checked-out HEAD is ${moved}`), "learning at a moved HEAD");
    assert.equal(runState(fx).status, "active");
  } finally {
    git(fx.project, ["reset", "-q", "--hard", fx.head]);
  }
  assertOk(learnEvidence(fx, "decision-evidence"), "decision-evidence");
  assertOk(learnEvidence(fx, "learning-evidence"), "learning-evidence");
  const state = runState(fx);
  assert.equal(state.status, "completed");
  assert.equal(state.current_step, "learn", "the lifecycle coordinator accepts a completed merge-change run only at learn or done");
  assert.equal(state.params.source_head, fx.head);

  assertOk(workflow(fx, ["publish-delivery", "--session-dir", fx.sessionDir, "--json"], HOLDER, { TRUST_RECONCILE_COMMANDS: TEST_COMMAND }), "publish-delivery");
  const checkpoint = JSON.parse(fs.readFileSync(path.join(fx.sessionDir, "trust.checkpoint.json"), "utf8"));
  assert.equal(checkpoint.commit_sha, fx.head, "the delivery checkpoint is sealed at the pinned head");
  // The one delivery-only commit on the pull request branch.
  git(fx.project, ["add", `delivery/${fx.slug}`]);
  git(fx.project, ["commit", "-qm", "delivery evidence"]);
  terminalHead = git(fx.project, ["rev-parse", "HEAD"]);
  assert.equal(git(fx.project, ["rev-parse", `${terminalHead}~1`]), fx.head, "T is the pinned head plus exactly one commit");
});

test("merge-change request issues the merge of T, the pinned head plus its delivery-only commit", async () => {
  const result = await mergeRequest(fx);
  assert.equal(result.status, 0, result.err);
  const printed = JSON.parse(result.out);
  const unsigned = JSON.parse(printed.signing_payload);
  issuedMergeAction = unsigned.issued_action;
  assert.equal(issuedMergeAction.intent.terminal_head_sha, terminalHead);
  assert.equal(issuedMergeAction.intent.head_ref, fx.branch);
  assert.equal(issuedMergeAction.intent.change_number, fx.number);
  assert.equal(issuedMergeAction.expected_provider_actor, GH_ACTOR);
  assert.equal(unsigned.flow_definition_id, FLOW);
});

test("merge-change refuses a non-delivery change in T, a checkpoint sealed elsewhere, and a forged publish result", async () => {
  // (1) T carries a change outside this session's delivery files.
  fs.writeFileSync(path.join(fx.project, "smuggled.txt"), "not reviewed\n");
  git(fx.project, ["add", "smuggled.txt"]);
  git(fx.project, ["commit", "-q", "--amend", "--no-edit"]);
  try {
    const result = await mergeRequest(fx);
    assert.equal(result.status, 1);
    assert.match(result.err, /merge-change requires an ancestor-bound delivery-only terminal commit/);
  } finally {
    git(fx.project, ["reset", "-q", "--hard", terminalHead]);
  }

  // (2) A checkpoint sealed at another head. publish-delivery itself refuses a moved HEAD, so this
  // forges the unsigned companions: an extra unreviewed commit X under a checkpoint naming X.
  const names = ["trust.bundle", "trust.checkpoint.json", "trust.checkpoint.attestation.json", "trust.checkpoint.intoto.json"];
  const backup = Object.fromEntries(names.map((name) => [name, fs.readFileSync(path.join(fx.sessionDir, name))]));
  assert.equal(JSON.parse(backup["trust.checkpoint.attestation.json"]).status, "unsigned", "the fixture's checkpoint is unsigned, so its companions are forgeable locally");
  git(fx.project, ["reset", "-q", "--hard", fx.head]);
  fs.writeFileSync(path.join(fx.project, "unreviewed.txt"), "never reviewed\n");
  git(fx.project, ["add", "unreviewed.txt"]);
  git(fx.project, ["commit", "-qm", "unreviewed"]);
  const unreviewed = git(fx.project, ["rev-parse", "HEAD"]);
  try {
    const checkpoint = JSON.parse(backup["trust.checkpoint.json"]);
    checkpoint.commit_sha = unreviewed;
    const checkpointBytes = Buffer.from(`${JSON.stringify(checkpoint, null, 2)}\n`);
    const statement = JSON.parse(backup["trust.checkpoint.intoto.json"]);
    statement.subject.find((subject) => subject.name === "trust.checkpoint.json").digest.sha256 = sha256(checkpointBytes);
    fs.writeFileSync(path.join(fx.sessionDir, "trust.checkpoint.json"), checkpointBytes);
    fs.writeFileSync(path.join(fx.sessionDir, "trust.checkpoint.intoto.json"), `${JSON.stringify(statement, null, 2)}\n`);
    const attestation = JSON.parse(backup["trust.checkpoint.attestation.json"]);
    attestation.checkpoint_sha256 = sha256(checkpointBytes);
    fs.writeFileSync(path.join(fx.sessionDir, "trust.checkpoint.attestation.json"), `${JSON.stringify(attestation, null, 2)}\n`);
    fs.mkdirSync(path.join(fx.project, "delivery", fx.slug), { recursive: true });
    for (const name of names) fs.copyFileSync(path.join(fx.sessionDir, name), path.join(fx.project, "delivery", fx.slug, name));
    git(fx.project, ["add", `delivery/${fx.slug}`]);
    git(fx.project, ["commit", "-qm", "delivery sealed at the unreviewed head"]);
    const result = await mergeRequest(fx);
    assert.equal(result.status, 1);
    assert.match(result.err, new RegExp(`merge-change requires this builder\\.deliver-existing run's delivery checkpoint to be sealed at its pinned source head ${fx.head}; it was sealed at ${unreviewed}`));
  } finally {
    for (const name of names) fs.writeFileSync(path.join(fx.sessionDir, name), backup[name]);
    git(fx.project, ["reset", "-q", "--hard", terminalHead]);
  }

  // (3) A publish result whose head was edited: its digest no longer matches the canonical run.
  const resultFile = path.join(fx.sessionDir, "publish-change.result.json");
  const resultBytes = fs.readFileSync(resultFile);
  const manifestFile = path.join(fx.runDir, "evidence", "manifest.json");
  const manifestBytes = fs.readFileSync(manifestFile);
  try {
    const forged = JSON.parse(resultBytes);
    forged.change_ref.head_sha = fx.base;
    const forgedBytes = Buffer.from(`${JSON.stringify(forged, null, 2)}\n`);
    fs.writeFileSync(resultFile, forgedBytes);
    let result = await mergeRequest(fx);
    assert.equal(result.status, 1);
    assert.match(result.err, /publish-change\.result\.json action and digest bound to canonical completed run evidence/);

    // (4) The same forgery with a canonical-looking evidence entry for its digest: only the pinned
    // head check is left to refuse it.
    const original = manifest(fx).evidence.find((entry) => entry.producer === "publish-change-operation-authority");
    const summary = `Authenticated publish-change operation ${forged.operation_action_id} observed open provider record ${forged.change_ref.provider_record_id}`;
    const canonical = JSON.parse(manifestBytes);
    canonical.evidence.push({
      id: "forged-publish-change", gate_id: original.gate_id, kind: "custom", requested_kind: "custom", status: "passed", attached_at: new Date().toISOString(),
      producer: "publish-change-operation-authority", authority_trace: forged.operation_action_id, expectation_ids: ["pull-request-opened"],
      bundle: { schemaVersion: 5, source: "forged", claims: [{ fieldOrBehavior: summary, metadata: { artifact_refs: [{ kind: "provider", sha256: sha256(forgedBytes) }] } }], evidence: [], policies: [], events: [] },
    });
    fs.writeFileSync(manifestFile, JSON.stringify(canonical));
    result = await mergeRequest(fx);
    assert.equal(result.status, 1);
    assert.match(result.err, new RegExp(`merge-change requires this builder\\.deliver-existing run's adopted pull request to have been observed at its pinned source head ${fx.head}; publish-change observed ${fx.base}`));
  } finally {
    fs.writeFileSync(resultFile, resultBytes);
    fs.writeFileSync(manifestFile, manifestBytes);
  }
  // DISCRIMINATOR: restored, the same request is issued again.
  assert.equal((await mergeRequest(fx)).status, 0);
});

test("merge-change execute refuses a moved or retargeted PR, unready checks or review, and another actor, with no PUT", async () => {
  for (const [label, options, pattern] of [
    ["provider head moved after request", { headSha: fx.base }, /provider head no longer matches the exact terminal merge action/],
    ["base retargeted", { baseRef: "develop" }, /provider head no longer matches the exact terminal merge action/],
    ["failing checks", { checks: [{ bucket: "fail", name: "required-ci", link: "https://example.test/ci" }] }, /required provider checks are not passing/],
    ["pending checks", { checks: [{ bucket: "pending", name: "required-ci", link: "https://example.test/ci" }] }, /required provider checks are not passing/],
    ["no required checks", { checks: [] }, /no required provider checks were returned/],
    ["not approved", { reviewDecision: "REVIEW_REQUIRED" }, /review, mergeability, or policy observation does not permit merge/],
    ["not clean", { mergeStateStatus: "BLOCKED" }, /review, mergeability, or policy observation does not permit merge/],
    ["another gh actor", { actor: "someone-else" }, /authenticated provider actor changed after canonical publish-change observation/],
  ]) {
    const github = fakeMergeGithub(fx, terminalHead, options);
    const result = await mergeExecute(fx, github);
    assert.equal(result.status, 1, `${label} must be refused`);
    assert.match(result.err, pattern, label);
    assert.deepEqual(github.puts(), [], `${label}: no merge PUT`);
    assert.equal(fs.existsSync(path.join(fx.sessionDir, "merge-change.result.json")), false, `${label}: no merge result`);
  }
});

test("merge-change execute merges T, never trusts a persisted result, and refuses a replay for another strategy or merger", async () => {
  const resultFile = path.join(fx.sessionDir, "merge-change.result.json");
  // A shape-valid persisted "merged" result is a recovery hint, not authority: the provider is
  // re-observed, and here it has not merged, so the exact-head merge still happens.
  assert.ok(issuedMergeAction);
  fs.writeFileSync(resultFile, `${JSON.stringify({ action: issuedMergeAction, observation: {
    schema_version: "1.0", operation: "merge-change", binding: issuedMergeAction.binding, repository: issuedMergeAction.repository, intent: issuedMergeAction.intent,
    provider: { kind: "github", configuration_id: issuedMergeAction.provider.configuration_id, adapter: "github-gh-cli" }, assignment_actor: issuedMergeAction.assignment_actor,
    provider_actor: GH_ACTOR, state: "merged", merge_sha: "f".repeat(40), observed_at: "2026-01-01T00:00:00.000Z",
  } })}\n`);
  let github = fakeMergeGithub(fx, terminalHead);
  let result = await mergeExecute(fx, github);
  assert.equal(result.status, 0, result.err);
  assert.equal(github.puts().length, 1, "the forged persisted result did not stand in for the merge");
  const put = github.puts()[0];
  assert.ok(put.includes(`sha=${terminalHead}`), "the merge is fenced on the exact terminal head T");
  assert.equal(JSON.parse(result.out).terminal_head_sha, terminalHead);
  assert.equal(JSON.parse(fs.readFileSync(resultFile, "utf8")).observation.merge_sha, "c".repeat(40), "only the fresh provider observation is persisted");

  // Already merged by the same actor: re-observed, no second PUT.
  github = fakeMergeGithub(fx, terminalHead, { alreadyMerged: true });
  result = await mergeExecute(fx, github);
  assert.equal(result.status, 0, result.err);
  assert.deepEqual(github.puts(), []);

  // Merged by someone else: refused.
  github = fakeMergeGithub(fx, terminalHead, { alreadyMerged: true, mergedBy: "someone-else" });
  result = await mergeExecute(fx, github);
  assert.equal(result.status, 1);
  assert.match(result.err, /was performed by a different actor/);
  assert.deepEqual(github.puts(), []);

  // A replay for another strategy: refused before the provider is reached.
  github = fakeMergeGithub(fx, terminalHead);
  result = await mergeExecute(fx, github, "rebase");
  assert.equal(result.status, 1);
  assert.match(result.err, /merge-change\.result\.json already exists for a different strategy, head, assignment, or provider configuration/);
  assert.deepEqual(github.calls, []);
});

// ─── Concurrency ─────────────────────────────────────────────────────────────────────────────

test("one Work Item cannot carry a builder.build run and an existing-change delivery run at once", () => {
  const delivering = makeExistingChange(20);
  assertOk(start(delivering), "deliver-existing start");
  refused(start(delivering, "builder.build"), /cannot resume builder\.deliver-existing as builder\.build; this Work Item's run was started as builder\.deliver-existing and keeps that flow/, "builder.build over deliver-existing");

  const building = makeExistingChange(21);
  assertOk(start(building, "builder.build"), "build start");
  refused(start(building), /cannot resume builder\.build as builder\.deliver-existing; this Work Item's run was started as builder\.build/, "deliver-existing over builder.build");
});
