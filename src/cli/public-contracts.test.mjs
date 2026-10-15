import assert from "node:assert/strict";
import test from "node:test";
import {
  ADOPT_EXISTING_CHANGE_PARAMETERS,
  PUBLISH_CHANGE_OPERATION_PROTOCOL,
  adoptExistingChangeOperationProtocol,
  publishChangeOperationProtocol,
  resolveChangeProviderSupport,
} from "../../build/src/cli/public-contracts.js";

const provider = {
  role: "ChangeProvider",
  kind: "github",
  repository: { owner: "kontourai", name: "flow-agents" },
  capabilities: ["change.create", "change.observe"],
  executor: "gh-cli",
};

test("publish-change contract binds assignment and authenticated provider actors separately without result import", () => {
  assert.deepEqual(PUBLISH_CHANGE_OPERATION_PROTOCOL.request.required, ["schema_version", "operation", "binding", "repository", "base_ref", "head_ref", "head_sha", "intent", "assignment_actor", "provider"]);
  assert.deepEqual(PUBLISH_CHANGE_OPERATION_PROTOCOL.result.required, ["schema_version", "operation", "binding", "provider", "repository", "change_ref", "assignment_actor", "provider_actor", "observed_at"]);
  assert.deepEqual(PUBLISH_CHANGE_OPERATION_PROTOCOL.result.properties.change_ref.required, ["provider_record_id", "number", "url", "state", "base_ref", "head_ref", "head_sha"]);
  assert.deepEqual(PUBLISH_CHANGE_OPERATION_PROTOCOL.result.properties.change_ref.properties.state.enum, ["open", "merged"]);
  assert.equal(PUBLISH_CHANGE_OPERATION_PROTOCOL.parameters.some((parameter) => parameter.flag === "--result-json"), false);
  assert.equal(JSON.stringify(PUBLISH_CHANGE_OPERATION_PROTOCOL).includes("token"), false);
});

test("publish-change availability is truthful for configured and unavailable ChangeProviders", () => {
  const configured = publishChangeOperationProtocol(provider);
  assert.equal(configured.availability.status, "configured");
  assert.deepEqual(configured.availability.command, ["publish-change", "execute", "--session-dir", "<session-dir>"]);
  assert.equal(configured.availability.executable_by_flow_agents, true);

  const unavailable = publishChangeOperationProtocol();
  assert.equal(unavailable.availability.status, "external_capability_required");
  assert.equal(unavailable.availability.executable_by_flow_agents, false);
  assert.deepEqual(resolveChangeProviderSupport({ ...provider, token: "forbidden" }), { status: "unsupported", reason: "change_provider_repository_is_invalid" });
});

test("the adopt-only publish-change variant is additive: the open-change contract keeps title and body", () => {
  assert.deepEqual(PUBLISH_CHANGE_OPERATION_PROTOCOL.parameters.map((parameter) => parameter.name), ["session_dir", "title", "body", "head_ref", "base_ref", "draft"]);
  assert.equal(PUBLISH_CHANGE_OPERATION_PROTOCOL.capability, "change.create");
  const configured = publishChangeOperationProtocol(provider);
  const adopt = adoptExistingChangeOperationProtocol(configured);
  assert.equal(adopt.capability, "change.observe");
  assert.deepEqual(adopt.parameters, ADOPT_EXISTING_CHANGE_PARAMETERS);
  assert.deepEqual(adopt.parameters.map((parameter) => parameter.flag), ["--session-dir", "--head-ref", "--base-ref"]);
  assert.deepEqual(adopt.availability, configured.availability);
  assert.deepEqual(adopt.request, configured.request);
  assert.deepEqual(adopt.result, configured.result);
  assert.equal(configured.capability, "change.create", "the input protocol is not mutated");
});
