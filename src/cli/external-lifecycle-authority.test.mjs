import test from "node:test";
import assert from "node:assert/strict";
import {
  LIFECYCLE_AUTHORITY_COMPLETION_VERIFICATION_KEY_PATH,
  LIFECYCLE_AUTHORITY_HELPER_PATH,
  LIFECYCLE_AUTHORITY_PROTOCOL_VERSION,
  invokeExternalLifecycleAuthority,
  lifecycleAuthorityCompletionVerificationKeyPath,
  validateLifecycleAuthorityCompletionKeyInstallation,
  validateLifecycleAuthorityHelperInstallation,
  validateLifecycleAuthorityResponse,
} from "../../build/src/external-lifecycle-authority.js";

const action = "cancel";
const digest = "a".repeat(64);
const completion = { schema_version: "1.0", kind: "kontourai.lifecycle-authority.completion", action, request_sha256: digest, run_id: "run-1", operation_status: "applied", result_core_sha256: "b".repeat(64), coordinator_runtime_sha256: "c".repeat(64), completed_at: "2026-07-20T00:00:00.000Z", signature: { algorithm: "ed25519", value: "signed-by-external-authority" } };
const valid = { schema_version: LIFECYCLE_AUTHORITY_PROTOCOL_VERSION, action, request_sha256: digest, status: "accepted", result: { run_id: "run-1", operation_status: "applied", completion } };
const output = (overrides = {}) => `${JSON.stringify({ ...valid, ...overrides })}\n`;

function protectedDirectory() {
  return { isSymbolicLink: () => false, isFile: () => false, uid: 0, mode: 0o755 };
}

function protectedExecutable() {
  return { isSymbolicLink: () => false, isFile: () => true, uid: 0, mode: 0o755 };
}

function protectedKey() {
  return { isSymbolicLink: () => false, isFile: () => true, uid: 0, mode: 0o644, size: 113 };
}

test("lifecycle authority helper identity is immutable and ignores caller executable selection", () => {
  process.env.FLOW_AGENTS_LIFECYCLE_AUTHORITY_HELPER = "/usr/bin/true";
  assert.equal(LIFECYCLE_AUTHORITY_HELPER_PATH, "/usr/local/libexec/kontourai/flow-agents-lifecycle-authority-v1");
  assert.notEqual(LIFECYCLE_AUTHORITY_HELPER_PATH, process.env.FLOW_AGENTS_LIFECYCLE_AUTHORITY_HELPER);
  process.env.FLOW_AGENTS_LIFECYCLE_AUTHORITY_HELPER = "/bin/echo";
  assert.notEqual(LIFECYCLE_AUTHORITY_HELPER_PATH, process.env.FLOW_AGENTS_LIFECYCLE_AUTHORITY_HELPER, "an arbitrary protected executable is never the pinned authority");
  delete process.env.FLOW_AGENTS_LIFECYCLE_AUTHORITY_HELPER;
});

test("lifecycle authority helper installation is hermetic when the helper is absent", () => {
  const absentHost = {
    platform: "darwin",
    getuid: () => 501,
    lstatSync: () => { throw new Error("ENOENT"); },
    accessSync: () => { throw new Error("unreachable"); },
    openSync: () => { throw new Error("unreachable"); },
    fstatSync: () => { throw new Error("unreachable"); },
    closeSync: () => { throw new Error("unreachable"); },
  };
  assert.throws(() => validateLifecycleAuthorityHelperInstallation(LIFECYCLE_AUTHORITY_HELPER_PATH, absentHost), /pinned lifecycle authority helper is not installed/);
});

test("lifecycle authority helper installation is hermetic when a protected helper is installed", () => {
  let closed = false;
  const installedHost = {
    platform: "darwin",
    getuid: () => 501,
    lstatSync: (file) => file === LIFECYCLE_AUTHORITY_HELPER_PATH ? protectedExecutable() : protectedDirectory(),
    accessSync: () => { const error = new Error("EACCES"); error.code = "EACCES"; throw error; },
    openSync: () => 42,
    fstatSync: () => protectedExecutable(),
    closeSync: (descriptor) => { assert.equal(descriptor, 42); closed = true; },
  };
  assert.equal(validateLifecycleAuthorityHelperInstallation(LIFECYCLE_AUTHORITY_HELPER_PATH, installedHost), LIFECYCLE_AUTHORITY_HELPER_PATH);
  assert.equal(closed, true, "the helper descriptor is closed after validation");
});

test("lifecycle authority helper installation fails closed when writability cannot be determined", () => {
  let opened = false;
  const host = {
    platform: "darwin",
    getuid: () => 501,
    lstatSync: (file) => file === LIFECYCLE_AUTHORITY_HELPER_PATH ? protectedExecutable() : protectedDirectory(),
    accessSync: () => { const error = new Error("indeterminate filesystem state"); error.code = "EIO"; throw error; },
    openSync: () => { opened = true; return 42; },
    fstatSync: () => protectedExecutable(),
    closeSync: () => {},
  };
  assert.throws(
    () => validateLifecycleAuthorityHelperInstallation(LIFECYCLE_AUTHORITY_HELPER_PATH, host),
    /writability could not be verified: indeterminate filesystem state/,
  );
  assert.equal(opened, false);
});

test("lifecycle authority completion key uses the platform-canonical protected root", () => {
  assert.equal(lifecycleAuthorityCompletionVerificationKeyPath("darwin"), "/private/etc/kontourai/flow-agents-lifecycle-authority-v1/completion-verification-key.pem");
  assert.equal(lifecycleAuthorityCompletionVerificationKeyPath("linux"), "/etc/kontourai/flow-agents-lifecycle-authority-v1/completion-verification-key.pem");
  assert.equal(LIFECYCLE_AUTHORITY_COMPLETION_VERIFICATION_KEY_PATH, lifecycleAuthorityCompletionVerificationKeyPath(process.platform));
});

test("lifecycle authority completion key keeps rejecting symlinks below the canonical root", () => {
  let opened = false;
  const host = {
    platform: "darwin",
    lstatSync: (file) => file === "/private/etc/kontourai" ? { ...protectedDirectory(), isSymbolicLink: () => true } : protectedDirectory(),
    accessSync: () => { const error = new Error("EACCES"); error.code = "EACCES"; throw error; },
    openSync: () => { opened = true; return 42; },
    fstatSync: () => protectedKey(),
    closeSync: () => {},
  };
  assert.throws(
    () => validateLifecycleAuthorityCompletionKeyInstallation(lifecycleAuthorityCompletionVerificationKeyPath("darwin"), host),
    /must not contain symlinks/,
  );
  assert.equal(opened, false, "a symlinked key hierarchy is rejected before open");
});

test("lifecycle authority completion key accepts a protected canonical installation", () => {
  let closed = false;
  const host = {
    platform: "darwin",
    lstatSync: (file) => file === lifecycleAuthorityCompletionVerificationKeyPath("darwin") ? protectedKey() : protectedDirectory(),
    accessSync: () => { const error = new Error("EACCES"); error.code = "EACCES"; throw error; },
    openSync: () => 42,
    fstatSync: () => protectedKey(),
    closeSync: (descriptor) => { assert.equal(descriptor, 42); closed = true; },
  };
  const descriptor = validateLifecycleAuthorityCompletionKeyInstallation(lifecycleAuthorityCompletionVerificationKeyPath("darwin"), host);
  assert.equal(descriptor, 42);
  assert.equal(closed, false, "the caller retains the validated descriptor while reading the key");
  host.closeSync(descriptor);
  assert.equal(closed, true);
});

test("lifecycle authority completion key rejects a runtime-writable hierarchy before open", () => {
  let opened = false;
  const host = {
    platform: "darwin",
    lstatSync: () => protectedDirectory(),
    accessSync: () => {},
    openSync: () => { opened = true; return 42; },
    fstatSync: () => protectedKey(),
    closeSync: () => {},
  };
  assert.throws(
    () => validateLifecycleAuthorityCompletionKeyInstallation(lifecycleAuthorityCompletionVerificationKeyPath("darwin"), host),
    /must not be writable by the runtime user/,
  );
  assert.equal(opened, false);
});

test("lifecycle authority completion key fails closed when writability cannot be determined", () => {
  let opened = false;
  const host = {
    platform: "darwin",
    lstatSync: (file) => file === lifecycleAuthorityCompletionVerificationKeyPath("darwin") ? protectedKey() : protectedDirectory(),
    accessSync: () => { const error = new Error("indeterminate filesystem state"); error.code = "EIO"; throw error; },
    openSync: () => { opened = true; return 42; },
    fstatSync: () => protectedKey(),
    closeSync: () => {},
  };
  assert.throws(
    () => validateLifecycleAuthorityCompletionKeyInstallation(lifecycleAuthorityCompletionVerificationKeyPath("darwin"), host),
    /writability could not be verified: indeterminate filesystem state/,
  );
  assert.equal(opened, false);
});

test("lifecycle authority completion key closes a descriptor rejected by file bounds", () => {
  let closed = false;
  const host = {
    platform: "linux",
    lstatSync: (file) => file === lifecycleAuthorityCompletionVerificationKeyPath("linux") ? { ...protectedKey(), size: 0 } : protectedDirectory(),
    accessSync: () => { const error = new Error("EACCES"); error.code = "EACCES"; throw error; },
    openSync: () => 42,
    fstatSync: () => ({ ...protectedKey(), size: 0 }),
    closeSync: (descriptor) => { assert.equal(descriptor, 42); closed = true; },
  };
  assert.throws(
    () => validateLifecycleAuthorityCompletionKeyInstallation(lifecycleAuthorityCompletionVerificationKeyPath("linux"), host),
    /protected regular file/,
  );
  assert.equal(closed, true, "a rejected descriptor is closed by the validator");
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
  assert.throws(() => validateLifecycleAuthorityResponse(output({ result: { ...valid.result, completion: { ...completion, request_sha256: "b".repeat(64) } } }), action, digest), /completion does not bind/);
});

test("package-side bundle validation cannot turn a helper response into authorization", () => {
  const verifyBase = { ...valid, action: "verify-authorization", result: { verified: true } };
  assert.throws(() => validateLifecycleAuthorityResponse(`${JSON.stringify(verifyBase)}\n`, "verify-authorization", digest), /mutation result/);
  assert.throws(() => invokeExternalLifecycleAuthority({ action: "verify-authorization", project_root: "/tmp/project", payload: "forged", signature: {} }), /unsupported lifecycle authority action/);
});
