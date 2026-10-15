import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { ChangeProviderError } from "../../build/src/cli/change-provider.js";
import { createGithubChangeProvider, observeGithubMergedChange } from "../../build/src/cli/github-change-provider.js";

const SHA = "a".repeat(40);
const STALE_SHA = "b".repeat(40);
const SECRET = "SENTINEL_AUTH_SECRET_604";
const TOKEN = "gho_fixture_token_604";
const OBSERVED_AT = "2026-07-19T01:00:00.000Z";
const settings = {
  role: "ChangeProvider",
  kind: "github",
  repository: { owner: "kontourai", name: "flow-agents" },
  capabilities: ["change.create", "change.observe"],
  executor: "gh-cli",
};

function request(overrides = {}) {
  const value = {
    schema_version: "1.0",
    operation: "publish-change",
    binding: { run_id: "kontourai-flow-agents-604", definition_id: "builder.build", definition_version: "1.1", step_id: "pr-open", gate_ids: ["pr-open-gate"], gate_visit_id: "visit-1" },
    repository: { owner: "kontourai", name: "flow-agents" },
    base_ref: "main",
    head_ref: "agent/change-provider-604-v2",
    head_sha: SHA,
    intent: { title: "Authenticated ChangeProvider", body: "Closes #604", draft: false },
    assignment_actor: "codex:session:Kontour",
    provider: { kind: "github", configuration_id: "settings-sha256" },
  };
  return {
    ...value,
    ...overrides,
    binding: { ...value.binding, ...(overrides.binding ?? {}) },
    repository: { ...value.repository, ...(overrides.repository ?? {}) },
    intent: { ...value.intent, ...(overrides.intent ?? {}) },
    provider: { ...value.provider, ...(overrides.provider ?? {}) },
  };
}

function listRecord(overrides = {}) {
  return { id: "PR_kwDOexample", number: 610, state: "OPEN", baseRefName: "main", headRefName: "agent/change-provider-604-v2", headRefOid: SHA, title: "Authenticated ChangeProvider", body: "Closes #604", isDraft: false, ...overrides };
}

function providerRecord(overrides = {}) {
  const value = {
    node_id: "PR_kwDOexample",
    number: 610,
    html_url: "https://github.com/kontourai/flow-agents/pull/610",
    state: "OPEN",
    merged: false,
    title: "Authenticated ChangeProvider",
    body: "Closes #604",
    draft: false,
    base: { ref: "main", repo: { full_name: "kontourai/flow-agents" } },
    head: { ref: "agent/change-provider-604-v2", sha: SHA },
  };
  return {
    ...value,
    ...overrides,
    base: { ...value.base, ...(overrides.base ?? {}), repo: { ...value.base.repo, ...(overrides.base?.repo ?? {}) } },
    head: { ...value.head, ...(overrides.head ?? {}) },
  };
}

function fakeExecutor(outputs) {
  const calls = [];
  const executor = async (file, argv, options) => {
    calls.push({ file, argv: [...argv], options: { ...options } });
    const next = outputs.shift();
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next({ file, argv, options });
    if (next === undefined) throw new Error("unexpected invocation");
    return { stdout: typeof next === "string" ? next : JSON.stringify(next) };
  };
  return { executor, calls };
}

function provider(fake) {
  return createGithubChangeProvider(settings, "settings-sha256", { executor: fake.executor, executable: "gh", now: () => OBSERVED_AT });
}

function prefix() {
  return [TOKEN, "authenticated\n", { login: "briananderson1222" }, { full_name: "kontourai/flow-agents" }];
}

function finalPrefix(actor = "briananderson1222") {
  return ["authenticated\n", { login: actor }, { full_name: "kontourai/flow-agents" }];
}

function assertCode(error, code) {
  assert.ok(error instanceof ChangeProviderError);
  assert.equal(error.code, code);
  return true;
}

test("GitHub adapter checks authentication and repository capability, recovers exactly one PR, then re-observes it", async () => {
  const fake = fakeExecutor([...prefix(), [listRecord()], providerRecord(), ...finalPrefix()]);
  process.env.Git_Dir = "/foreign/repository/.git";
  process.env.git_work_tree = "/foreign/repository";
  process.env.Gh_Host = "attacker.invalid";
  process.env.GH_CONFIG_DIR = "/attacker/gh-config";
  process.env.http_unix_socket = "/attacker/provider.sock";
  process.env.DYLD_INSERT_LIBRARIES = "/attacker/inject.dylib";
  process.env.HTTPS_PROXY = "https://attacker.invalid";
  let result;
  try {
    result = await provider(fake).createOrRecover(request());
  } finally {
    delete process.env.Git_Dir;
    delete process.env.git_work_tree;
    delete process.env.Gh_Host;
    delete process.env.GH_CONFIG_DIR;
    delete process.env.http_unix_socket;
    delete process.env.DYLD_INSERT_LIBRARIES;
    delete process.env.HTTPS_PROXY;
  }

  assert.deepEqual(fake.calls.map((call) => call.argv.slice(0, 2)), [["auth", "token"], ["auth", "status"], ["api", "user"], ["api", "repos/kontourai/flow-agents"], ["pr", "list"], ["api", "repos/kontourai/flow-agents/pulls/610"], ["auth", "status"], ["api", "user"], ["api", "repos/kontourai/flow-agents"]]);
  assert.equal(fake.calls.every((call) => call.file === "gh"), true);
  assert.equal(fake.calls.every((call) => call.options.maxOutputBytes === 256 * 1024), true);
  assert.equal(fake.calls.slice(1).every((call) => call.options.env.GH_TOKEN === TOKEN && call.options.env.GITHUB_TOKEN === undefined), true);
  assert.equal(fake.calls.slice(1).every((call) => Object.keys(call.options.env).every((key) => !key.toUpperCase().startsWith("GIT_") && key.toUpperCase() !== "GH_HOST")), true);
  const isolatedConfigDir = fake.calls[1].options.env.GH_CONFIG_DIR;
  assert.equal(fake.calls.slice(1).every((call) => call.options.env.GH_CONFIG_DIR === isolatedConfigDir && call.options.env.http_unix_socket === undefined), true);
  assert.equal(fake.calls.every((call) => call.options.env.DYLD_INSERT_LIBRARIES === undefined && call.options.env.HTTPS_PROXY === undefined), true);
  assert.equal(typeof fake.calls[0].options.env.HOME, "string");
  assert.equal(fs.existsSync(isolatedConfigDir), false);
  assert.equal(fake.calls.some((call) => call.argv.includes("--head") && call.argv.includes("agent/change-provider-604-v2")), true);
  assert.equal(result.change_ref.number, 610);
  assert.equal(result.assignment_actor, "codex:session:Kontour");
  assert.equal(result.provider_actor, "briananderson1222");
  assert.notEqual(result.assignment_actor, result.provider_actor);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test("GitHub adapter truthfully recovers a matching merged PR without creating a duplicate", async () => {
  const fake = fakeExecutor([...prefix(), [listRecord({ state: "MERGED" })], providerRecord({ state: "CLOSED", merged: true }), ...finalPrefix()]);
  const result = await provider(fake).createOrRecover(request());

  assert.equal(result.change_ref.state, "merged");
  assert.equal(fake.calls.filter((call) => call.argv[0] === "pr" && call.argv[1] === "create").length, 0);
  const list = fake.calls.find((call) => call.argv[0] === "pr" && call.argv[1] === "list");
  assert.deepEqual(list.argv.slice(list.argv.indexOf("--state"), list.argv.indexOf("--state") + 2), ["--state", "all"]);
});

test("GitHub adapter creates once with direct argv and verifies exact canonical body bytes through a fresh observation", async (t) => {
  for (const [label, body, observedBody] of [
    ["ordinary", "Closes #604", "Closes #604"],
    ["trailing LF", "Closes #604\n", "Closes #604\n"],
    ["leading LF", "\nCloses #604", "\nCloses #604"],
    ["empty", "", ""],
    ["empty REST null", "", null],
  ]) {
    await t.test(label, async () => {
      const fake = fakeExecutor([...prefix(), [], "https://github.com/kontourai/flow-agents/pull/610\n", [listRecord({ body, isDraft: true })], providerRecord({ body: observedBody, draft: true }), ...finalPrefix()]);
      const result = await provider(fake).createOrRecover(request({ intent: { body, draft: true } }));

      const create = fake.calls[5];
      assert.deepEqual(create.argv.slice(0, 2), ["pr", "create"]);
      assert.equal(create.argv[create.argv.indexOf("--body") + 1], body);
      assert.equal(fake.calls.filter((call) => call.argv[0] === "pr" && call.argv[1] === "create").length, 1);
      assert.equal(create.argv.includes("--draft"), true);
      assert.equal(create.argv.includes("kontourai/flow-agents"), true);
      assert.equal(create.argv.includes("bash"), false);
      assert.equal(result.change_ref.number, 610);
    });
  }
});

test("GitHub adapter re-observes after an ambiguous create timeout without a second create", async () => {
  const timedOut = new Error(`timeout after GitHub wrote ${SECRET}`);
  const fake = fakeExecutor([...prefix(), [], timedOut, [listRecord()], providerRecord(), ...finalPrefix()]);
  const result = await provider(fake).createOrRecover(request());
  assert.equal(result.change_ref.number, 610);
  assert.equal(fake.calls.filter((call) => call.argv[0] === "pr" && call.argv[1] === "create").length, 1);
});

test("GitHub adapter strips hostile provider failures from public errors", async () => {
  const fake = fakeExecutor([...prefix(), [], new Error(`provider stderr ${SECRET}`)]);
  await assert.rejects(() => provider(fake).createOrRecover(request()), (error) => {
    assertCode(error, "provider_failure");
    assert.equal(String(error).includes(SECRET), false);
    return true;
  });
});

test("GitHub adapter fails closed when the authenticated actor changes after the final observation", async () => {
  const fake = fakeExecutor([...prefix(), [listRecord()], providerRecord(), ...finalPrefix("different-user")]);
  await assert.rejects(() => provider(fake).createOrRecover(request()), (error) => assertCode(error, "provider_observation_mismatch"));
  assert.equal(fake.calls.length, 9, "the adapter must reauthenticate after observing the provider record");
});

test("GitHub adapter rejects ambiguity, stale SHA, wrong observations, and malformed responses before returning a result", async () => {
  for (const [label, outputs, code] of [
    ["ambiguous", [...prefix(), [listRecord(), listRecord({ id: "PR_second", number: 611 })]], "ambiguous_provider_change"],
    ["stale", [...prefix(), [listRecord({ headRefOid: STALE_SHA })]], "provider_observation_mismatch"],
    ["closed", [...prefix(), [listRecord()], providerRecord({ state: "CLOSED" }), ...finalPrefix()], "provider_observation_mismatch"],
    ["wrong-base", [...prefix(), [listRecord()], providerRecord({ base: { ref: "develop" } }), ...finalPrefix()], "provider_observation_mismatch"],
    ["wrong-repository", [...prefix(), [listRecord()], providerRecord({ base: { repo: { full_name: "other/repo" } } }), ...finalPrefix()], "provider_observation_mismatch"],
    ["wrong-title", [...prefix(), [listRecord({ title: "different intent" })]], "provider_observation_mismatch"],
    ["wrong-body", [...prefix(), [listRecord({ body: "different intent" })]], "provider_observation_mismatch"],
    ["changed-final-body", [...prefix(), [listRecord()], providerRecord({ body: "Closes #604\n" }), ...finalPrefix()], "provider_observation_mismatch"],
    ["final-body-null-mismatch", [...prefix(), [listRecord()], providerRecord({ body: null }), ...finalPrefix()], "provider_observation_mismatch"],
    ["final-body-missing", [...prefix(), [listRecord()], providerRecord({ body: undefined }), ...finalPrefix()], "provider_observation_mismatch"],
    ["final-body-nonstring", [...prefix(), [listRecord()], providerRecord({ body: 42 }), ...finalPrefix()], "provider_observation_mismatch"],
    ["final-body-CR", [...prefix(), [listRecord()], providerRecord({ body: "Closes #604\r\n" }), ...finalPrefix()], "provider_observation_mismatch"],
    ["final-body-NUL", [...prefix(), [listRecord()], providerRecord({ body: "Closes #604\0" }), ...finalPrefix()], "provider_observation_mismatch"],
    ["final-body-oversize", [...prefix(), [listRecord()], providerRecord({ body: "é".repeat(32_769) }), ...finalPrefix()], "provider_observation_mismatch"],
    ["wrong-draft", [...prefix(), [listRecord({ isDraft: true })]], "provider_observation_mismatch"],
    ["malformed", [...prefix(), "not-json"], "malformed_provider_output"],
  ]) {
    await assert.rejects(() => provider(fakeExecutor(outputs)).createOrRecover(request()), (error) => {
      assertCode(error, code);
      assert.equal(String(error).includes(SECRET), false, label);
      return true;
    });
  }
});

test("GitHub adapter rejects auth failures and does not accept a different configured repository", async () => {
  const authFailure = fakeExecutor([new Error(`auth output ${SECRET}`)]);
  await assert.rejects(() => provider(authFailure).createOrRecover(request()), (error) => {
    assertCode(error, "provider_auth_failed");
    assert.equal(String(error).includes(SECRET), false);
    return true;
  });

  const wrongRepo = fakeExecutor(prefix());
  await assert.rejects(() => provider(wrongRepo).createOrRecover(request({ repository: { owner: "other", name: "repo" } })), (error) => assertCode(error, "provider_observation_mismatch"));
  assert.equal(wrongRepo.calls.length, 0);
});

test("merged-change closeout observation binds the authenticated actor, exact head, and merge commit", async () => {
  const mergeSha = "c".repeat(40);
  const fake = fakeExecutor([
    ...prefix(),
    providerRecord({ state: "CLOSED", merged: true, merge_commit_sha: mergeSha }),
  ]);
  const result = await observeGithubMergedChange({
    settings,
    configurationId: "settings-sha256",
    expected: {
      number: 610,
      repository: { owner: "kontourai", name: "flow-agents" },
      baseRef: "main",
      headRef: "agent/change-provider-604-v2",
      headSha: SHA,
      providerActor: "briananderson1222",
    },
  }, { executor: fake.executor, executable: "gh", now: () => OBSERVED_AT });

  assert.equal(result.state, "merged");
  assert.equal(result.mergeSha, mergeSha);
  assert.equal(result.headSha, SHA);
  assert.deepEqual(fake.calls.at(-1).argv, ["api", "repos/kontourai/flow-agents/pulls/610"]);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test("merged-change closeout observation refuses an open or actor-mismatched provider record", async () => {
  const expected = {
    number: 610,
    repository: { owner: "kontourai", name: "flow-agents" },
    baseRef: "main",
    headRef: "agent/change-provider-604-v2",
    headSha: SHA,
    providerActor: "briananderson1222",
  };
  await assert.rejects(
    observeGithubMergedChange({ settings, configurationId: "settings-sha256", expected }, {
      executor: fakeExecutor([...prefix(), providerRecord({ merge_commit_sha: "c".repeat(40) })]).executor,
      executable: "gh",
    }),
    (error) => assertCode(error, "provider_observation_mismatch"),
  );
  await assert.rejects(
    observeGithubMergedChange({ settings, configurationId: "settings-sha256", expected }, {
      executor: fakeExecutor([TOKEN, "authenticated\n", { login: "different-user" }, { full_name: "kontourai/flow-agents" }]).executor,
      executable: "gh",
    }),
    (error) => assertCode(error, "provider_observation_mismatch"),
  );
});

// ─── #1415 slice 2: adoptExisting ────────────────────────────────────────────────────────────
// An existing-change run adopts the one open, same-repository pull request at its exact head. It
// never runs `pr create` and never compares or sets the pull request's title, body, or draft flag.

function sameRepoRecord(overrides = {}) {
  return providerRecord({ ...overrides, head: { repo: { full_name: "kontourai/flow-agents" }, ...(overrides.head ?? {}) } });
}

/** One `gh pr list --json` row for the adopt listing: no title or body, plus the head repository identity. */
function adoptListRecord(overrides = {}) {
  return { id: "PR_kwDOexample", number: 610, state: "OPEN", baseRefName: "main", headRefName: "agent/change-provider-604-v2", headRefOid: SHA, isCrossRepository: false, headRepositoryOwner: { id: "O_kontourai", login: "kontourai" }, ...overrides };
}

function forkListRecord(overrides = {}) {
  return adoptListRecord({ id: "PR_fork", number: 700, isCrossRepository: true, headRepositoryOwner: { id: "O_attacker", login: "attacker" }, headRefOid: STALE_SHA, ...overrides });
}

function createCalls(fake) {
  return fake.calls.filter((call) => call.argv[0] === "pr" && call.argv[1] === "create");
}

function listCall(fake) {
  return fake.calls.find((call) => call.argv[0] === "pr" && call.argv[1] === "list").argv;
}

test("adoptExisting observes the one open same-repository PR at the exact head without creating one or comparing its intent", async () => {
  // Title, body, and draft flag all differ from the request, and the body is not even a string: an
  // adopted pull request's metadata is not the adopting run's, so none of it may be compared.
  const fake = fakeExecutor([
    ...prefix(),
    [adoptListRecord()],
    sameRepoRecord({ title: "Someone else's title", body: 42, draft: true }),
    ...finalPrefix(),
  ]);
  const result = await provider(fake).adoptExisting(request());
  assert.equal(result.change_ref.state, "open");
  assert.equal(result.change_ref.number, 610);
  assert.equal(result.change_ref.head_sha, SHA);
  assert.equal(result.change_ref.url, "https://github.com/kontourai/flow-agents/pull/610");
  assert.equal(result.provider_actor, "briananderson1222");
  assert.deepEqual(fake.calls.map((call) => call.argv.slice(0, 2)), [["auth", "token"], ["auth", "status"], ["api", "user"], ["api", "repos/kontourai/flow-agents"], ["pr", "list"], ["api", "repos/kontourai/flow-agents/pulls/610"], ["auth", "status"], ["api", "user"], ["api", "repos/kontourai/flow-agents"]]);
  assert.deepEqual(createCalls(fake), [], "adoption never opens a pull request");
  assert.equal(fake.calls.some((call) => call.argv.includes("--title") || call.argv.includes("--body")), false);
  // The listing asks only for open pull requests, one more than the bound, with the head repository
  // identity and without title or body.
  const argv = listCall(fake);
  assert.equal(argv[argv.indexOf("--state") + 1], "open");
  assert.equal(argv[argv.indexOf("--limit") + 1], "101");
  assert.deepEqual(argv[argv.indexOf("--json") + 1].split(",").sort(), ["baseRefName", "headRefName", "headRefOid", "headRepositoryOwner", "id", "isCrossRepository", "number", "state"]);
});

test("adoptExisting ignores closed or merged history and fork pull requests from a same-named branch", async () => {
  for (const [label, listed] of [
    ["an earlier closed PR on the same branch", [adoptListRecord({ id: "PR_old", number: 500, state: "CLOSED", headRefOid: STALE_SHA }), adoptListRecord()]],
    ["an earlier merged PR on the same branch", [adoptListRecord({ id: "PR_old", number: 500, state: "MERGED", headRefOid: STALE_SHA }), adoptListRecord()]],
    ["a fork PR from a same-named branch", [forkListRecord(), adoptListRecord()]],
    ["a fork PR whose head repository was deleted", [forkListRecord({ headRepositoryOwner: null }), adoptListRecord()]],
    ["exactly the listing bound of 100 rows", [...Array.from({ length: 99 }, (_, index) => forkListRecord({ id: `PR_fork_${index}`, number: 700 + index })), adoptListRecord()]],
  ]) {
    const fake = fakeExecutor([...prefix(), listed, sameRepoRecord(), ...finalPrefix()]);
    const result = await provider(fake).adoptExisting(request());
    assert.equal(result.change_ref.number, 610, label);
    assert.deepEqual(createCalls(fake), [], `${label}: adoption never opens a pull request`);
  }
});

test("adoptExisting refuses a missing, duplicate, closed, merged, moved, fork, or over-bound pull request and never creates one", async () => {
  for (const [label, outputs, code, message] of [
    ["no pull request", [...prefix(), []], "provider_observation_mismatch", /no open same-repository pull request exists for the pinned head and base refs; an existing-change run adopts an open pull request and never opens one/],
    ["two open same-repository pull requests", [...prefix(), [adoptListRecord(), adoptListRecord({ id: "PR_second", number: 611 })]], "ambiguous_provider_change", /more than one open same-repository pull request exists/],
    ["only a closed pull request", [...prefix(), [adoptListRecord({ state: "CLOSED" })]], "provider_observation_mismatch", /no open same-repository pull request exists/],
    ["only a merged pull request", [...prefix(), [adoptListRecord({ state: "MERGED" })]], "provider_observation_mismatch", /no open same-repository pull request exists/],
    ["only a fork pull request", [...prefix(), [forkListRecord({ headRefOid: SHA })]], "provider_observation_mismatch", /no open same-repository pull request exists/],
    ["more than the listing bound", [...prefix(), Array.from({ length: 101 }, (_, index) => forkListRecord({ id: `PR_fork_${index}`, number: 700 + index }))], "ambiguous_provider_change", /more than 100 open pull requests match the pinned head and base refs; refusing to adopt from a truncated listing/],
    ["head moved", [...prefix(), [adoptListRecord({ headRefOid: STALE_SHA })]], "provider_observation_mismatch", /head has moved off the pinned source head/],
    ["fork per the authoritative record", [...prefix(), [adoptListRecord()], sameRepoRecord({ head: { repo: { full_name: "attacker/flow-agents" } } })], "provider_observation_mismatch", /not in the configured repository; an existing-change run adopts only a same-repository pull request/],
    ["fork with deleted head repository", [...prefix(), [adoptListRecord()], providerRecord({ head: { repo: null } })], "malformed_provider_output", /head repository/],
    ["missing cross-repository flag", [...prefix(), [adoptListRecord({ isCrossRepository: undefined })]], "malformed_provider_output", /cross-repository flag/],
    ["merged since listing", [...prefix(), [adoptListRecord()], sameRepoRecord({ state: "CLOSED", merged: true }), ...finalPrefix()], "provider_observation_mismatch", /adopted change must be open/],
    ["closed since listing", [...prefix(), [adoptListRecord()], sameRepoRecord({ state: "CLOSED" }), ...finalPrefix()], "provider_observation_mismatch", /does not match the canonical request/],
    ["head moved since listing", [...prefix(), [adoptListRecord()], sameRepoRecord({ head: { sha: STALE_SHA } }), ...finalPrefix()], "provider_observation_mismatch", /does not match the canonical request/],
    ["actor changed", [...prefix(), [adoptListRecord()], sameRepoRecord(), ...finalPrefix("different-user")], "provider_observation_mismatch", /actor changed/],
  ]) {
    const fake = fakeExecutor(outputs);
    await assert.rejects(() => provider(fake).adoptExisting(request()), (error) => {
      assertCode(error, code);
      assert.match(error.message, message, label);
      return true;
    });
    assert.deepEqual(createCalls(fake), [], `${label}: adoption never opens a pull request`);
  }
});
