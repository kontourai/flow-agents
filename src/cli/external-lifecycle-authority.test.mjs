import test from "node:test";
import assert from "node:assert/strict";
import {
  LIFECYCLE_AUTHORITY_HELPER_PATH,
  LIFECYCLE_AUTHORITY_PROTOCOL_VERSION,
  invokeExternalLifecycleAuthority,
  validateLifecycleAuthorityResponse,
} from "../../build/src/external-lifecycle-authority.js";

const action = "cancel";
const digest = "a".repeat(64);
const valid = { schema_version: LIFECYCLE_AUTHORITY_PROTOCOL_VERSION, action, request_sha256: digest, status: "accepted", result: { run_id: "run-1", operation_status: "applied" } };
const output = (overrides = {}) => `${JSON.stringify({ ...valid, ...overrides })}\n`;

test("lifecycle authority helper identity is immutable and ignores caller executable selection", () => {
  process.env.FLOW_AGENTS_LIFECYCLE_AUTHORITY_HELPER = "/usr/bin/true";
  assert.equal(LIFECYCLE_AUTHORITY_HELPER_PATH, "/usr/local/libexec/kontourai/flow-agents-lifecycle-authority-v1");
  assert.notEqual(LIFECYCLE_AUTHORITY_HELPER_PATH, process.env.FLOW_AGENTS_LIFECYCLE_AUTHORITY_HELPER);
  assert.throws(() => invokeExternalLifecycleAuthority({ action: "cancel", project_root: "/tmp/project", session_dir: "/tmp/project/session", authorization_file: "/tmp/auth.json" }), /pinned lifecycle authority helper|root caller/);
  process.env.FLOW_AGENTS_LIFECYCLE_AUTHORITY_HELPER = "/bin/echo";
  assert.notEqual(LIFECYCLE_AUTHORITY_HELPER_PATH, process.env.FLOW_AGENTS_LIFECYCLE_AUTHORITY_HELPER, "an arbitrary protected executable is never the pinned authority");
  delete process.env.FLOW_AGENTS_LIFECYCLE_AUTHORITY_HELPER;
});

test("lifecycle authority response requires one non-empty response", () => {
  assert.throws(() => validateLifecycleAuthorityResponse("", action, digest), /exactly one non-empty/);
  assert.throws(() => validateLifecycleAuthorityResponse(`${output()}${output()}`, action, digest), /exactly one non-empty/);
  assert.throws(() => validateLifecycleAuthorityResponse(`${output()}\n`, action, digest), /exactly one non-empty/);
});

test("lifecycle authority response binds version action and canonical request digest", () => {
  assert.throws(() => validateLifecycleAuthorityResponse(output({ schema_version: "2.0" }), action, digest), /protocol version/);
  assert.throws(() => validateLifecycleAuthorityResponse(output({ action: "archive" }), action, digest), /action is invalid/);
  assert.throws(() => validateLifecycleAuthorityResponse(output({ request_sha256: "b".repeat(64) }), action, digest), /request digest/);
});

test("lifecycle authority response rejects extra fields and malformed results", () => {
  assert.throws(() => validateLifecycleAuthorityResponse(output({ extra: true }), action, digest), /unexpected or missing fields/);
  assert.throws(() => validateLifecycleAuthorityResponse(output({ result: { ...valid.result, extra: true } }), action, digest), /unexpected or missing fields/);
  assert.throws(() => validateLifecycleAuthorityResponse(output({ status: "rejected" }), action, digest), /rejected/);
});

test("bundle verification requires an exact verified response", () => {
  const verifyBase = { ...valid, action: "verify-authorization", result: { verified: true } };
  assert.deepEqual(validateLifecycleAuthorityResponse(`${JSON.stringify(verifyBase)}\n`, "verify-authorization", digest), { verified: true });
  assert.throws(() => validateLifecycleAuthorityResponse(`${JSON.stringify({ ...verifyBase, result: {} })}\n`, "verify-authorization", digest), /unexpected or missing fields/);
  assert.throws(() => validateLifecycleAuthorityResponse(`${JSON.stringify({ ...verifyBase, result: { verified: false } })}\n`, "verify-authorization", digest), /did not verify/);
});
