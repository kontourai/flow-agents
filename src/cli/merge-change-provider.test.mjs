import assert from "node:assert/strict";
import test from "node:test";
import { issueMergeChangeAction } from "../../build/src/merge-change-operation-authority.js";
import { executeMergeChangeProvider } from "../../build/src/cli/merge-change-provider.js";

const SHA = "a".repeat(40);
const provider = { role: "ChangeProvider", kind: "github", repository: { owner: "kontourai", name: "flow-agents" }, capabilities: ["change.create", "change.observe", "change.merge"], executor: "gh-cli" };
const binding = { run_id: "kontourai-flow-agents-1000", definition_id: "builder.build", definition_version: "1.3", step_id: "done", gate_ids: ["learn-gate"], gate_visit_id: "f".repeat(64) };
function action(strategy = "squash") { return issueMergeChangeAction({ binding, provider, assignment_actor: "codex:1000:Kontour", expected_provider_actor: "fixture", intent: { strategy, change_number: 1000, base_ref: "main", head_ref: "fix/terminal-before-merge-1000", terminal_head_sha: SHA } }); }
function record(merged = false) { return { base: { ref: "main", repo: { full_name: "kontourai/flow-agents" } }, head: { ref: "fix/terminal-before-merge-1000", sha: SHA, repo: { full_name: "kontourai/flow-agents" } }, merged, merge_commit_sha: merged ? "c".repeat(40) : null }; }
function fake({ failing = false, noRequired = false, changedAfterChecks = false, mergeAfterMutation = true, queueAccepted = true, alreadyQueued = false, actor = "fixture", terminalActor = actor, reviewDecision = "APPROVED", mergeable = "MERGEABLE", mergeStateStatus = "CLEAN", strategyEnabled = true, enforceAdmins = true, requiredApprovals = 1, rulesetApprovals = requiredApprovals, effectiveRules = [{ type: "pull_request", parameters: { required_approving_review_count: rulesetApprovals } }] } = {}) {
  const calls = []; let pullReads = 0; let queueReads = 0;
  return {
    calls,
    executor: async (_file, argv) => {
      calls.push([...argv]);
      if (argv[0] === "auth" && argv[1] === "token") return { stdout: "fixture-token" };
      if (argv[0] === "auth") return { stdout: "" };
      if (argv[0] === "api" && argv[1] === "user") return { stdout: JSON.stringify({ login: actor }) };
      if (argv[0] === "api" && argv[1] === "repos/kontourai/flow-agents/branches/main/protection") return { stdout: JSON.stringify({ enforce_admins: { enabled: enforceAdmins }, required_pull_request_reviews: { required_approving_review_count: requiredApprovals } }) };
      if (argv[0] === "api" && argv[1] === "repos/kontourai/flow-agents/rules/branches/main") return { stdout: JSON.stringify(effectiveRules) };
      if (argv[0] === "api" && argv[1] === "repos/kontourai/flow-agents") return { stdout: JSON.stringify({ full_name: "kontourai/flow-agents", allow_squash_merge: strategyEnabled, allow_rebase_merge: strategyEnabled, allow_merge_commit: strategyEnabled, allow_auto_merge: strategyEnabled }) };
      if (argv[0] === "api" && argv[1] === "graphql") {
        const query = argv.find((value) => value.startsWith("query=")) ?? "";
        if (query.includes("mergeQueueEntry")) return { stdout: JSON.stringify({ data: { repository: { pullRequest: { headRefOid: SHA, mergeQueueEntry: queueAccepted && (alreadyQueued || queueReads++ > 0) ? { id: "MQE_fixture", state: "QUEUED", headCommit: { oid: "d".repeat(40) } } : null } } } }) };
        return { stdout: JSON.stringify({ data: { viewer: { login: terminalActor }, repository: { pullRequest: { headRefOid: SHA, isDraft: false, merged: false, reviewDecision, mergeable, mergeStateStatus } } } }) };
      }
      if (argv[0] === "pr" && argv[1] === "checks") return { stdout: JSON.stringify(noRequired ? [] : [{ bucket: failing ? "pending" : "pass", name: "required-ci", link: "https://example.test/check" }]) };
      if (argv[0] === "api" && argv[1] === "--method") return { stdout: JSON.stringify({ merged: true, sha: "c".repeat(40) }) };
      if (argv[0] === "pr" && argv[1] === "merge") return { stdout: "" };
      if (argv[0] === "api" && argv[1] === "repos/kontourai/flow-agents/pulls/1000") {
        const output = record(mergeAfterMutation && pullReads++ > 1);
        if (changedAfterChecks && pullReads > 1) output.head.sha = "b".repeat(40);
        return { stdout: JSON.stringify(output) };
      }
      throw new Error(`unexpected argv ${argv.join(" ")}`);
    },
  };
}

test("GitHub merge mutation checks the exact terminal SHA before strategy-specific squash", async () => {
  const fixture = fake();
  const result = await executeMergeChangeProvider(provider, action(), { executor: fixture.executor, executable: "gh", now: () => "2026-07-26T00:00:00.000Z" });
  assert.equal(result.state, "merged");
  const checks = fixture.calls.find((argv) => argv[0] === "pr" && argv[1] === "checks");
  assert.deepEqual(checks.slice(-3), ["--required", "--json", "bucket,name,link"]);
  const mutation = fixture.calls.find((argv) => argv[0] === "api" && argv[1] === "--method");
  assert.deepEqual(mutation.slice(-4), ["-f", `sha=${SHA}`, "-f", "merge_method=squash"]);
});

test("GitHub merge refuses failing exact-head checks before any mutation", async () => {
  const fixture = fake({ failing: true });
  await assert.rejects(executeMergeChangeProvider(provider, action(), { executor: fixture.executor, executable: "gh" }), /required provider checks/);
  assert.equal(fixture.calls.some((argv) => argv[1] === "--method"), false);
});

test("GitHub merge rejects provider configuration drift before authentication or mutation", async () => {
  const fixture = fake();
  const drifted = { ...provider, capabilities: ["change.create", "change.observe", "change.merge", "change.extra"] };
  await assert.rejects(executeMergeChangeProvider(drifted, action(), { executor: fixture.executor, executable: "gh" }), /configuration changed/);
  assert.equal(fixture.calls.length, 0);
});

test("GitHub merge fails closed when no required checks are returned or the PR head moves after checks", async () => {
  for (const fixture of [fake({ noRequired: true }), fake({ changedAfterChecks: true })]) {
    await assert.rejects(executeMergeChangeProvider(provider, action(), { executor: fixture.executor, executable: "gh" }), /no required provider checks|no longer matches/);
    assert.equal(fixture.calls.some((argv) => argv[1] === "--method"), false);
  }
});

test("rebase, merge-commit, and merge-queue retain distinct exact-head provider behavior", async () => {
  for (const [strategy, expected] of [["rebase", "rebase"], ["merge-commit", "merge"], ["merge-queue", "queue"]]) {
    const fixture = fake({ mergeAfterMutation: strategy !== "merge-queue" });
    const result = await executeMergeChangeProvider(provider, action(strategy), { executor: fixture.executor, executable: "gh" });
    if (strategy === "merge-queue") {
      assert.equal(result.state, "queued");
      const queued = fixture.calls.find((argv) => argv[0] === "pr" && argv[1] === "merge");
      assert.ok(queued.includes("--auto") && queued.includes("--match-head-commit") && queued.includes(SHA));
      assert.ok(fixture.calls.some((argv) => argv[0] === "api" && argv[1] === "graphql"));
    } else {
      assert.equal(result.state, "merged");
      const mutation = fixture.calls.find((argv) => argv[0] === "api" && argv[1] === "--method");
      assert.ok(mutation.includes(`merge_method=${expected}`));
    }
  }
});

test("merge-queue refuses a successful command without authenticated queue admission", async () => {
  const fixture = fake({ mergeAfterMutation: false, queueAccepted: false });
  await assert.rejects(
    executeMergeChangeProvider(provider, action("merge-queue"), { executor: fixture.executor, executable: "gh" }),
    /merge queue entry/,
  );
});

test("merge-queue replay reauthenticates the persisted exact queue identity without a second mutation", async () => {
  const fixture = fake({ mergeAfterMutation: false, alreadyQueued: true });
  const result = await executeMergeChangeProvider(provider, action("merge-queue"), { executor: fixture.executor, executable: "gh" });
  assert.equal(result.state, "queued");
  assert.equal(result.queue_entry.id, "MQE_fixture");
  assert.equal(result.queue_entry.head_sha, SHA);
  assert.equal(result.queue_entry.admitted_merge_group_sha, "d".repeat(40));
  assert.equal(fixture.calls.some((argv) => argv[0] === "pr" && argv[1] === "merge"), false);
});

test("merge-queue fails closed when GraphQL omits its exact PR head or immutable queue identity", async () => {
  for (const response of [
    { data: { repository: { pullRequest: { headRefOid: "b".repeat(40), mergeQueueEntry: { id: "MQE_fixture", state: "QUEUED", headCommit: { oid: "d".repeat(40) } } } } } },
    { data: { repository: { pullRequest: { headRefOid: SHA, mergeQueueEntry: { state: "QUEUED", headCommit: { oid: "d".repeat(40) } } } } } },
  ]) {
    const fixture = fake({ mergeAfterMutation: false });
    const original = fixture.executor;
    fixture.executor = async (file, argv, options) => argv[0] === "api" && argv[1] === "graphql" ? { stdout: JSON.stringify(response) } : original(file, argv, options);
    await assert.rejects(executeMergeChangeProvider(provider, action("merge-queue"), { executor: fixture.executor, executable: "gh" }), /exact terminal head|queue entry/);
  }
});

test("merge rejects a provider PR whose head repository identity differs from the configured repository", async () => {
  const fixture = fake();
  const original = fixture.executor;
  fixture.executor = async (file, argv, options) => {
    const result = await original(file, argv, options);
    if (argv[0] === "api" && argv[1] === "repos/kontourai/flow-agents/pulls/1000") {
      const body = JSON.parse(result.stdout);
      body.head.repo.full_name = "attacker/flow-agents";
      return { stdout: JSON.stringify(body) };
    }
    return result;
  };
  await assert.rejects(executeMergeChangeProvider(provider, action(), { executor: fixture.executor, executable: "gh" }), /provider head no longer matches/);
});

test("GitHub merge rejects authenticated provider actor drift before the destructive call", async () => {
  for (const fixture of [fake({ actor: "different-actor" }), fake({ terminalActor: "different-actor" })]) {
    await assert.rejects(
      executeMergeChangeProvider(provider, action(), { executor: fixture.executor, executable: "gh" }),
      /authenticated provider actor changed/,
    );
    assert.equal(fixture.calls.some((argv) => argv[0] === "api" && argv[1] === "--method"), false);
  }
});

test("GitHub merge rejects stale, dismissed, or changed-requested review decisions before mutation", async () => {
  for (const reviewDecision of ["REVIEW_REQUIRED", "CHANGES_REQUESTED", null]) {
    const fixture = fake({ reviewDecision });
    await assert.rejects(
      executeMergeChangeProvider(provider, action(), { executor: fixture.executor, executable: "gh" }),
      /review, mergeability, or policy observation/,
    );
    assert.equal(fixture.calls.some((argv) => argv[0] === "api" && argv[1] === "--method"), false);
  }
});

test("GitHub merge rejects a non-mergeable exact terminal head before mutation", async () => {
  for (const policy of [
    { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" },
    { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" },
    { mergeable: "MERGEABLE", mergeStateStatus: "BEHIND" },
  ]) {
    const fixture = fake(policy);
    await assert.rejects(
      executeMergeChangeProvider(provider, action(), { executor: fixture.executor, executable: "gh" }),
      /review, mergeability, or policy observation/,
    );
    assert.equal(fixture.calls.some((argv) => argv[0] === "api" && argv[1] === "--method"), false);
  }
});

test("GitHub merge fails closed when strategy or no-bypass branch policy is ambiguous", async () => {
  for (const policy of [
    { strategyEnabled: false },
    { enforceAdmins: false },
    { requiredApprovals: 0 },
    { rulesetApprovals: 0 },
  ]) {
    const fixture = fake(policy);
    await assert.rejects(
      executeMergeChangeProvider(provider, action(), { executor: fixture.executor, executable: "gh" }),
      /selected .* merge strategy|no-bypass approval policy|effective ruleset/,
    );
    assert.equal(fixture.calls.some((argv) => argv[0] === "api" && argv[1] === "--method"), false);
  }
});

test("GitHub merge consumes the real effective-rules array and rejects malformed or ambiguous arrays", async () => {
  const valid = fake({ effectiveRules: [{ type: "commit_message_pattern", parameters: {} }, { type: "pull_request", parameters: { required_approving_review_count: 1 } }] });
  await executeMergeChangeProvider(provider, action(), { executor: valid.executor, executable: "gh" });
  assert.equal(valid.calls.some((argv) => argv[0] === "api" && argv[1] === "--method"), true);

  for (const [effectiveRules, message] of [
    [{ type: "pull_request", parameters: null }],
    [null],
    { rules: [{ type: "pull_request", parameters: { required_approving_review_count: 1 } }] },
  ].map((value) => [value, /review policy parameters|policy rule 0|bounded array/])) {
    const fixture = fake({ effectiveRules });
    await assert.rejects(
      executeMergeChangeProvider(provider, action(), { executor: fixture.executor, executable: "gh" }),
      message,
    );
    assert.equal(fixture.calls.some((argv) => argv[0] === "api" && argv[1] === "--method"), false);
  }

  const ambiguous = fake({ effectiveRules: [
    { type: "pull_request", parameters: { required_approving_review_count: 1 } },
    { type: "pull_request", parameters: { required_approving_review_count: 2 } },
  ] });
  await assert.rejects(
    executeMergeChangeProvider(provider, action(), { executor: ambiguous.executor, executable: "gh" }),
    /ambiguous pull-request review policy/,
  );
  assert.equal(ambiguous.calls.some((argv) => argv[0] === "api" && argv[1] === "--method"), false);
});
