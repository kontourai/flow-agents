import assert from "node:assert/strict";
import test from "node:test";

import { ChangeProviderError } from "../../build/src/cli/change-provider.js";
import { createGithubChangeProvider } from "../../build/src/cli/github-change-provider.js";

const SHA = "a".repeat(40);
const STALE_SHA = "b".repeat(40);
const SECRET = "SENTINEL_AUTH_SECRET_604";
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
  return ["authenticated\n", { login: "briananderson1222" }, { full_name: "kontourai/flow-agents" }];
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
  const result = await provider(fake).createOrRecover(request());

  assert.deepEqual(fake.calls.map((call) => call.argv.slice(0, 2)), [["auth", "status"], ["api", "user"], ["api", "repos/kontourai/flow-agents"], ["pr", "list"], ["api", "repos/kontourai/flow-agents/pulls/610"], ["auth", "status"], ["api", "user"], ["api", "repos/kontourai/flow-agents"]]);
  assert.equal(fake.calls.every((call) => call.file === "gh"), true);
  assert.equal(fake.calls.every((call) => call.options.maxOutputBytes === 256 * 1024), true);
  assert.equal(fake.calls.some((call) => call.argv.includes("--head") && call.argv.includes("agent/change-provider-604-v2")), true);
  assert.equal(result.change_ref.number, 610);
  assert.equal(result.assignment_actor, "codex:session:Kontour");
  assert.equal(result.provider_actor, "briananderson1222");
  assert.notEqual(result.assignment_actor, result.provider_actor);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test("GitHub adapter truthfully recovers a matching merged PR without creating a duplicate", async () => {
  const fake = fakeExecutor([...prefix(), [listRecord({ state: "MERGED" })], providerRecord({ state: "CLOSED", merged: true }), ...finalPrefix()]);
  const result = await provider(fake).createOrRecover(request());

  assert.equal(result.change_ref.state, "merged");
  assert.equal(fake.calls.filter((call) => call.argv[0] === "pr" && call.argv[1] === "create").length, 0);
  const list = fake.calls.find((call) => call.argv[0] === "pr" && call.argv[1] === "list");
  assert.deepEqual(list.argv.slice(list.argv.indexOf("--state"), list.argv.indexOf("--state") + 2), ["--state", "all"]);
});

test("GitHub adapter creates once with direct argv and verifies through a fresh bounded observation", async () => {
  const fake = fakeExecutor([...prefix(), [], "https://github.com/kontourai/flow-agents/pull/610\n", [listRecord({ isDraft: true })], providerRecord({ draft: true }), ...finalPrefix()]);
  await provider(fake).createOrRecover(request({ intent: { draft: true } }));

  const create = fake.calls[4];
  assert.deepEqual(create.argv.slice(0, 2), ["pr", "create"]);
  assert.equal(create.argv.includes("--draft"), true);
  assert.equal(create.argv.includes("kontourai/flow-agents"), true);
  assert.equal(create.argv.includes("bash"), false);
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
  assert.equal(fake.calls.length, 8, "the adapter must reauthenticate after observing the provider record");
});

test("GitHub adapter rejects ambiguity, stale SHA, wrong observations, and malformed responses before returning a result", async () => {
  for (const [label, outputs, code] of [
    ["ambiguous", [...prefix(), [listRecord(), listRecord({ id: "PR_second", number: 611 })]], "ambiguous_provider_change"],
    ["stale", [...prefix(), [listRecord({ headRefOid: STALE_SHA })]], "provider_observation_mismatch"],
    ["closed", [...prefix(), [listRecord()], providerRecord({ state: "CLOSED" })], "provider_observation_mismatch"],
    ["wrong-base", [...prefix(), [listRecord()], providerRecord({ base: { ref: "develop" } })], "provider_observation_mismatch"],
    ["wrong-repository", [...prefix(), [listRecord()], providerRecord({ base: { repo: { full_name: "other/repo" } } })], "provider_observation_mismatch"],
    ["wrong-title", [...prefix(), [listRecord({ title: "different intent" })]], "provider_observation_mismatch"],
    ["wrong-body", [...prefix(), [listRecord({ body: "different intent" })]], "provider_observation_mismatch"],
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
