import assert from "node:assert/strict";
import test from "node:test";

import {
  ChangeProviderError,
  buildChangeProviderResult,
  parseChangeProviderRequest,
} from "../../build/src/cli/change-provider.js";

const SHA = "a".repeat(40);
const SECRET = "SENTINEL_AUTH_SECRET_604";

function request(overrides = {}) {
  const value = {
    schema_version: "1.0",
    operation: "publish-change",
    binding: {
      run_id: "kontourai-flow-agents-604",
      definition_id: "builder.build",
      definition_version: "1.1",
      step_id: "pr-open",
      gate_ids: ["pr-open-gate"],
      gate_visit_id: "visit-1",
    },
    repository: { owner: "kontourai", name: "flow-agents" },
    base_ref: "main",
    head_ref: "agent/change-provider-604-v2",
    head_sha: SHA,
    intent: { title: "Authenticated ChangeProvider", body: "Closes #604", draft: false },
    actor: "codex:session:Kontour",
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

function assertCode(error, code) {
  assert.ok(error instanceof ChangeProviderError);
  assert.equal(error.code, code);
  return true;
}

test("ChangeProvider accepts only a bounded canonical request and freezes it", () => {
  const parsed = parseChangeProviderRequest(request());
  assert.equal(parsed.head_sha, SHA);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.binding), true);
  assert.equal(Object.isFrozen(parsed.binding.gate_ids), true);

  assert.throws(() => parseChangeProviderRequest({ ...request(), token: SECRET }), (error) => assertCode(error, "invalid_request"));
  assert.throws(() => parseChangeProviderRequest(request({ intent: { title: "x".repeat(513) } })), (error) => assertCode(error, "invalid_request"));
  assert.throws(() => parseChangeProviderRequest(request({ binding: { gate_ids: [] } })), (error) => assertCode(error, "invalid_request"));
  assert.throws(() => parseChangeProviderRequest(request({ head_ref: "--injected" })), (error) => assertCode(error, "invalid_request"));
});

test("ChangeProvider result records bounded immutable open and merged observations and rejects unpublished states", () => {
  const parsed = parseChangeProviderRequest(request());
  const result = buildChangeProviderResult({
    request: parsed,
    providerRecord: {
      id: "PR_kwDOexample",
      number: 610,
      url: "https://github.com/kontourai/flow-agents/pull/610",
      state: "OPEN",
      baseRefName: "main",
      headRefName: "agent/change-provider-604-v2",
      headRefOid: SHA,
      title: "Authenticated ChangeProvider",
      body: "Closes #604",
      isDraft: false,
    },
    adapter: "github-gh-cli",
    actor: "briananderson1222",
    observedAt: "2026-07-19T01:00:00.000Z",
  });
  assert.equal(result.change_ref.provider_record_id, "PR_kwDOexample");
  assert.equal(result.change_ref.state, "open");
  assert.equal(result.actor, "briananderson1222");
  assert.equal(Object.isFrozen(result), true);
  assert.equal(JSON.stringify(result).includes(SECRET), false);

  const merged = buildChangeProviderResult({
    request: parsed,
    providerRecord: { id: "PR_kwDOexample", number: 610, url: "https://github.com/kontourai/flow-agents/pull/610", state: "merged", baseRefName: "main", headRefName: "agent/change-provider-604-v2", headRefOid: SHA, title: "Authenticated ChangeProvider", body: "Closes #604", isDraft: false },
    adapter: "github-gh-cli",
    actor: "briananderson1222",
    observedAt: "2026-07-19T01:00:00.000Z",
  });
  assert.equal(merged.change_ref.state, "merged");

  assert.throws(() => buildChangeProviderResult({
    request: parsed,
    providerRecord: { id: "PR_kwDOexample", number: 610, url: "https://github.com/kontourai/flow-agents/pull/610", state: "closed", baseRefName: "main", headRefName: "agent/change-provider-604-v2", headRefOid: SHA, title: "Authenticated ChangeProvider", body: "Closes #604", isDraft: false },
    adapter: "github-gh-cli",
    actor: "briananderson1222",
    observedAt: "2026-07-19T01:00:00.000Z",
  }), (error) => assertCode(error, "provider_observation_mismatch"));
});
