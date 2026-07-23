import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import * as lifecycleAuthority from "../../build/src/external-lifecycle-authority.js";

const {
  LIFECYCLE_AUTHORITY_COMPLETION_VERIFICATION_KEY_PATH,
  LIFECYCLE_AUTHORITY_HELPER_PATH,
  LIFECYCLE_AUTHORITY_PROTOCOL_VERSION,
  invokeExternalLifecycleAuthority,
  lifecycleAuthorityCompletionBindsExactState,
  lifecycleAuthorityResultDigest,
  validateLifecycleAuthorityHelperInstallation,
  validateLifecycleAuthorityResponse,
} = lifecycleAuthority;

const action = "cancel";
const digest = "a".repeat(64);
const completion = { schema_version: "1.0", kind: "kontourai.lifecycle-authority.completion", action, request_sha256: digest, run_id: "run-1", operation_status: "applied", result_core_sha256: "b".repeat(64), coordinator_runtime_sha256: "c".repeat(64), completed_at: "2026-07-20T00:00:00.000Z", signature: { algorithm: "ed25519", value: "signed-by-external-authority" } };
const valid = { schema_version: LIFECYCLE_AUTHORITY_PROTOCOL_VERSION, action, request_sha256: digest, status: "accepted", result: { run_id: "run-1", operation_status: "applied", completion } };
const output = (overrides = {}) => `${JSON.stringify({ ...valid, ...overrides })}\n`;

test("strict lifecycle consumers reject a historical core and accept only the new exact-current post-repair core", () => {
  const bundle = { schema_version: "1.0", claims: [{ id: "current-review" }] };
  const historicalEvents = [{ event_id: "historical" }];
  const postRepairEvents = [...historicalEvents, { event_id: "repair" }];
  const historicalCompletion = {
    action: "resolve-critique", run_id: "run-1",
    result_core_sha256: lifecycleAuthorityResultDigest({ schema_version: "1.0", claims: [], critique_resolution_events: historicalEvents }),
  };
  assert.equal(lifecycleAuthorityCompletionBindsExactState(historicalCompletion, "run-1", bundle, postRepairEvents), false);
  const postRepairCompletion = {
    action: "repair-critique-resolution-history", run_id: "run-1",
    result_core_sha256: lifecycleAuthorityResultDigest({ ...bundle, critique_resolution_events: postRepairEvents }),
  };
  assert.equal(lifecycleAuthorityCompletionBindsExactState(postRepairCompletion, "run-1", bundle, postRepairEvents), true);
  assert.equal(lifecycleAuthorityCompletionBindsExactState({ ...postRepairCompletion, run_id: "other" }, "run-1", bundle, postRepairEvents), false);
});

function protectedDirectory() {
  return { isSymbolicLink: () => false, isFile: () => false, uid: 0, mode: 0o755 };
}

function protectedExecutable() {
  return { isSymbolicLink: () => false, isFile: () => true, uid: 0, mode: 0o755 };
}

const completionVerificationKeyPair = generateKeyPairSync("ed25519");
const completionVerificationKey = completionVerificationKeyPair.publicKey.export({ type: "spki", format: "pem" });
const completionVerificationPrivateKeyPem = completionVerificationKeyPair.privateKey.export({ type: "pkcs8", format: "pem" });
const completionVerificationPrivateKeyDer = completionVerificationKeyPair.privateKey.export({ type: "pkcs8", format: "der" });
const nonEd25519CompletionVerificationKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "pem" });
const resolvedCompletionVerificationKeyPath = "/private/etc/kontourai/flow-agents-lifecycle-authority-v1/completion-verification-key.pem";
const directCompletionVerificationKeyPath = LIFECYCLE_AUTHORITY_COMPLETION_VERIFICATION_KEY_PATH;

function protectedCompletionDirectory(overrides = {}) {
  return { isSymbolicLink: () => false, isFile: () => false, uid: 0, mode: 0o755, ...overrides };
}

function protectedCompletionKey(overrides = {}) {
  return { isSymbolicLink: () => false, isFile: () => true, uid: 0, mode: 0o644, size: completionVerificationKey.length, ...overrides };
}

/**
 * The planned boundary is intentionally narrower than the helper host: package
 * verification may inspect only the immutable completion-key installation.
 */
function completionVerificationKeyHost({
  platform = "darwin",
  etcTarget = "/private/etc",
  etcIsAlias = true,
  writeErrorCode = "EACCES",
  entries = {},
  key = completionVerificationKey,
} = {}) {
  const keyPath = etcIsAlias ? resolvedCompletionVerificationKeyPath : directCompletionVerificationKeyPath;
  const etcRoot = etcIsAlias ? "/private/etc" : "/etc";
  const defaultEntries = new Map([
    ["/", protectedCompletionDirectory()],
    ["/etc", { ...protectedCompletionDirectory(), isSymbolicLink: () => etcIsAlias }],
    ...(etcIsAlias ? [["/private", protectedCompletionDirectory()]] : []),
    [etcRoot, protectedCompletionDirectory()],
    [`${etcRoot}/kontourai`, protectedCompletionDirectory()],
    [`${etcRoot}/kontourai/flow-agents-lifecycle-authority-v1`, protectedCompletionDirectory()],
    [keyPath, protectedCompletionKey({ size: key.length })],
  ]);
  for (const [file, stat] of Object.entries(entries)) defaultEntries.set(file, stat);
  let closed = false;
  return {
    platform,
    lstatSync(file) {
      const stat = defaultEntries.get(file);
      if (!stat) { const error = new Error(`ENOENT: ${file}`); error.code = "ENOENT"; throw error; }
      return stat;
    },
    readlinkSync(file) {
      assert.equal(file, "/etc", "only the fixed lexical /etc component may be resolved as the platform alias");
      assert.equal(etcIsAlias, true, "a protected direct /etc must not be read as a symlink");
      return etcTarget;
    },
    accessSync(file) {
      assert.ok(defaultEntries.has(file), `runtime-user write probe must cover ${file}`);
      const error = new Error(writeErrorCode);
      error.code = writeErrorCode;
      throw error;
    },
    openSync(file, flags) {
      assert.equal(file, keyPath, "the final descriptor must open the fixed resolved key path");
      assert.equal(flags, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW, "the final key descriptor must retain O_NOFOLLOW");
      return 43;
    },
    fstatSync(descriptor) {
      assert.equal(descriptor, 43);
      return defaultEntries.get(keyPath);
    },
    readFileSync(descriptor) {
      assert.equal(descriptor, 43);
      return key;
    },
    closeSync(descriptor) {
      assert.equal(descriptor, 43);
      closed = true;
    },
    get closed() { return closed; },
  };
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

test("completion-key verification admits protected direct /etc or the exact Darwin platform alias and retains every resolved-path and final-key boundary", () => {
  const validateCompletionVerificationKeyInstallation = lifecycleAuthority.validateLifecycleAuthorityCompletionVerificationKeyInstallation;
  assert.equal(
    typeof validateCompletionVerificationKeyInstallation,
    "function",
    "completion-key verification retains an injectable fixed-key host boundary for protected direct /etc and the standard Darwin /etc -> /private/etc alias",
  );

  const standardAliasHost = completionVerificationKeyHost();
  const key = validateCompletionVerificationKeyInstallation(standardAliasHost);
  assert.equal(key.type, "public");
  assert.equal(key.asymmetricKeyType, "ed25519");
  assert.equal(standardAliasHost.closed, true, "the final protected key descriptor is closed");
  const directEtcHost = completionVerificationKeyHost({ etcIsAlias: false });
  assert.equal(validateCompletionVerificationKeyInstallation(directEtcHost).asymmetricKeyType, "ed25519", "a protected direct Darwin /etc remains valid");
  assert.equal(directEtcHost.closed, true, "the direct /etc key descriptor is closed");
  assert.equal(validateCompletionVerificationKeyInstallation(completionVerificationKeyHost({ writeErrorCode: "EROFS" })).asymmetricKeyType, "ed25519", "read-only protected Darwin components report EROFS rather than writable access");

  assert.throws(
    () => validateCompletionVerificationKeyInstallation(completionVerificationKeyHost({ etcTarget: "/var/etc" })),
    /symlink|alias|private\/etc/i,
    "Darwin must not accept an arbitrary root-owned /etc symlink target",
  );
  assert.throws(
    () => validateCompletionVerificationKeyInstallation(completionVerificationKeyHost({
      entries: {
        "/private/etc/kontourai": { ...protectedCompletionDirectory(), isSymbolicLink: () => true },
      },
    })),
    /symlink/i,
    "only the first lexical /etc component may be the platform alias; descendants remain symlink-free",
  );
  assert.throws(
    () => validateCompletionVerificationKeyInstallation(completionVerificationKeyHost({
      entries: { "/private": protectedCompletionDirectory({ mode: 0o775 }) },
    })),
    /OS-owned|non-writable|root-owned/i,
    "every resolved parent remains group/world non-writable",
  );
  assert.throws(
    () => validateCompletionVerificationKeyInstallation(completionVerificationKeyHost({
      entries: { "/private/etc": protectedCompletionDirectory({ uid: 501 }) },
    })),
    /OS-owned|root-owned/i,
    "every resolved parent remains root-owned",
  );
  assert.throws(
    () => validateCompletionVerificationKeyInstallation(completionVerificationKeyHost({ writeErrorCode: "ENOENT" })),
    /runtime-user write protection could not be verified/i,
    "unexpected runtime-user write probe failures are not treated as protected read-only paths",
  );
  assert.throws(
    () => validateCompletionVerificationKeyInstallation(completionVerificationKeyHost({
      entries: { [resolvedCompletionVerificationKeyPath]: protectedCompletionKey({ mode: 0o664 }) },
    })),
    /protected regular file|non-writable/i,
    "final fstat validation retains group/world mode protection",
  );
  assert.throws(
    () => validateCompletionVerificationKeyInstallation(completionVerificationKeyHost({
      entries: { [resolvedCompletionVerificationKeyPath]: protectedCompletionKey({ isFile: () => false }) },
    })),
    /protected regular file/i,
    "final fstat validation retains the regular-file requirement",
  );
  assert.throws(
    () => validateCompletionVerificationKeyInstallation(completionVerificationKeyHost({ key: nonEd25519CompletionVerificationKey })),
    /Ed25519/i,
    "the fixed protected file must still contain an Ed25519 public key",
  );
  assert.throws(
    () => validateCompletionVerificationKeyInstallation(completionVerificationKeyHost({ key: completionVerificationPrivateKeyPem })),
    /must not contain private key material/i,
    "PKCS#8 PEM private material cannot be promoted to a public verification key",
  );
  assert.throws(
    () => validateCompletionVerificationKeyInstallation(completionVerificationKeyHost({ key: completionVerificationPrivateKeyDer })),
    /must not contain private key material/i,
    "PKCS#8 DER private material cannot be promoted to a public verification key",
  );
  assert.throws(
    () => validateCompletionVerificationKeyInstallation(completionVerificationKeyHost({ platform: "linux" })),
    /symlink/i,
    "non-Darwin platforms retain the no-symlink component policy",
  );
  assert.equal(validateCompletionVerificationKeyInstallation(completionVerificationKeyHost({ platform: "linux", etcIsAlias: false })).asymmetricKeyType, "ed25519", "non-Darwin protected direct paths retain the no-symlink policy");
  assert.throws(
    () => validateLifecycleAuthorityHelperInstallation(LIFECYCLE_AUTHORITY_HELPER_PATH, {
      platform: "darwin",
      getuid: () => 501,
      lstatSync: (file) => file === "/usr" ? { ...protectedDirectory(), isSymbolicLink: () => true } : protectedDirectory(),
      accessSync: () => { const error = new Error("EACCES"); error.code = "EACCES"; throw error; },
      openSync: () => 42,
      fstatSync: () => protectedExecutable(),
      closeSync: () => {},
    }),
    /symlink/i,
    "the completion-key alias exception must not relax helper installation validation",
  );
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
