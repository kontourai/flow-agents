import assert from "node:assert/strict";
import test from "node:test";
import {
  PUBLISH_CHANGE_OPERATION_PROTOCOL,
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

test("publish-change contract binds canonical request and observed immutable change result without result import", () => {
  assert.deepEqual(PUBLISH_CHANGE_OPERATION_PROTOCOL.request.required, ["schema_version", "operation", "binding", "repository", "base_ref", "head_ref", "head_sha", "intent", "actor", "provider"]);
  assert.deepEqual(PUBLISH_CHANGE_OPERATION_PROTOCOL.result.required, ["schema_version", "operation", "binding", "provider", "repository", "change_ref", "actor", "observed_at"]);
  assert.deepEqual(PUBLISH_CHANGE_OPERATION_PROTOCOL.result.properties.change_ref.required, ["provider_record_id", "number", "url", "state", "base_ref", "head_ref", "head_sha"]);
  assert.equal(PUBLISH_CHANGE_OPERATION_PROTOCOL.result.properties.change_ref.properties.state.const, "open");
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
