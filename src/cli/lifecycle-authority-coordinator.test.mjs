import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { critiqueHistoryProjectionSummary, critiqueResolutionEdgeProjectionSummary, critiqueResolutionHistoryBridgeDigest, resolveCritiqueTransition, selectUniqueHistoricalLedgerPrefix } from "../../packaging/lifecycle-authority/runtime-v1.mjs";

const COORDINATOR = path.resolve("packaging/lifecycle-authority/coordinator.mjs");
const RUNTIME = path.resolve("packaging/lifecycle-authority/runtime-v1.mjs");
const CURRENT_MANIFEST_BYTES = 4_288_259;
const EXPECTED_MANIFEST_BYTES = 16 * 1024 * 1024;

function writeProtectedManifest(directory, bytes) {
  const file = path.join(directory, `manifest-${bytes}.json`);
  const prefix = '{"evidence":[],"padding":"';
  const suffix = '"}';
  const paddingBytes = bytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  assert.ok(paddingBytes >= 0, "fixture must have room for a JSON payload");
  fs.writeFileSync(file, `${prefix}${"x".repeat(paddingBytes)}${suffix}`, { mode: 0o600 });
  assert.equal(fs.statSync(file).size, bytes, "generated manifest has the requested byte size");
  return file;
}

async function loadProtectedReadFromCoordinator({ registryFile, completionKeyFile, stateRoot } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-coordinator-test-"));
  fs.copyFileSync(RUNTIME, path.join(directory, "runtime-v1.mjs"));
  let source = fs.readFileSync(COORDINATOR, "utf8");
  if (registryFile) source = source.replace(/export const REGISTRY_FILE = .*?;/, `export const REGISTRY_FILE = ${JSON.stringify(registryFile)};`);
  if (completionKeyFile) source = source.replace(/export const COMPLETION_PUBLIC_KEY_FILE = .*?;/, `export const COMPLETION_PUBLIC_KEY_FILE = ${JSON.stringify(completionKeyFile)};`);
  if (stateRoot) source = source.replace(/export const STATE_ROOT = .*?;/, `export const STATE_ROOT = ${JSON.stringify(stateRoot)};`);
  fs.writeFileSync(path.join(directory, "coordinator.mjs"), `${source}\nexport { protectedRegularFile, protectedJson, loadResolutionEventLedger, assertResolutionEventLedgerPreimage, assertAuthorizedBundlePreimage, verifyAuthorization, verifyCurrentLifecycleCompletion, verifyHistoricalLifecycleCompletion, lifecycleAuthorityResultDigest, deriveHistoricalRepairBridge, verifyHistoricalDurableAnchor, installCompletionReceipt, durableCompletionRecord, reconcileCompletedNonce, assertPrivilegedAuthorizationShape, assertCanonicalFlowPostimages, HISTORY_REPAIR_AUTHORIZATION_FIELDS };\n`);
  const module = await import(`${pathToFileURL(path.join(directory, "coordinator.mjs")).href}?test=${Date.now()}-${Math.random()}`);
  return { directory, protectedRegularFile: module.protectedRegularFile, protectedJson: module.protectedJson, loadResolutionEventLedger: module.loadResolutionEventLedger, assertResolutionEventLedgerPreimage: module.assertResolutionEventLedgerPreimage, assertAuthorizedBundlePreimage: module.assertAuthorizedBundlePreimage, verifyAuthorization: module.verifyAuthorization, verifyCurrentLifecycleCompletion: module.verifyCurrentLifecycleCompletion, verifyHistoricalLifecycleCompletion: module.verifyHistoricalLifecycleCompletion, lifecycleAuthorityResultDigest: module.lifecycleAuthorityResultDigest, deriveHistoricalRepairBridge: module.deriveHistoricalRepairBridge, verifyHistoricalDurableAnchor: module.verifyHistoricalDurableAnchor, installCompletionReceipt: module.installCompletionReceipt, durableCompletionRecord: module.durableCompletionRecord, reconcileCompletedNonce: module.reconcileCompletedNonce, assertPrivilegedAuthorizationShape: module.assertPrivilegedAuthorizationShape, assertCanonicalFlowPostimages: module.assertCanonicalFlowPostimages, historyRepairAuthorizationFields: module.HISTORY_REPAIR_AUTHORIZATION_FIELDS, canonicalJson: module.canonicalJson, sha256: module.sha256 };
}

const rawSha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function signHistoricalAuthorization(authorization, privateKey) {
  const { signature: _signature, ...unsigned } = authorization;
  return { ...unsigned, signature: { algorithm: "ed25519", key_id: "test-key", value: sign(null, Buffer.from(JSON.stringify(unsigned)), privateKey).toString("base64") } };
}

function resignHistoricalEvent(event, bundle, privateKey, mutateAuthorization = (authorization) => authorization) {
  const signedAuthorization = signHistoricalAuthorization(mutateAuthorization({ ...event.signed_authorization }), privateKey);
  const authorizationSha256 = rawSha256(Buffer.from(JSON.stringify(signedAuthorization)));
  const eventId = `critique-resolution:${authorizationSha256}`;
  const edge = { ...event.edge, authorization_sha256: authorizationSha256, resolution_event_id: eventId };
  const { event_hash: _eventHash, ...unsigned } = { ...event, event_id: eventId, authorization_sha256: authorizationSha256, authorization_key_id: "test-key", edge, signed_authorization: signedAuthorization };
  const signedEvent = { ...unsigned, event_hash: rawSha256(Buffer.from(JSON.stringify(unsigned))) };
  const prior = bundle.claims.find((claim) => claim.metadata?.critique_resolution?.prior_record_id === edge.prior_record_id);
  prior.metadata.critique_resolution = edge;
  return signedEvent;
}

function critiqueClaim(id, hash, sequence, predecessor, reviewer, verdict, laneStatus, findingStatus) {
  return {
    id: `claim-${id}`,
    value: verdict,
    status: "verified",
    metadata: {
      origin: "critique",
      critique_record_id: id,
      critique_record_hash: hash,
      critique_sequence: sequence,
      critique_predecessor_hash: predecessor,
      workflow_subject_ref: "work-item:ledger-test",
      reviewer,
      lanes: [{ id: "security", status: laneStatus }],
      findings: [{ id: "F-1", status: findingStatus }],
      review_target: { workspace_snapshot: { digest: `${String(sequence).repeat(64)}`, head_sha: "none" } },
    },
  };
}

function resolutionAuthorization(prior, resolving, nonce) {
  return {
    schema_version: "1.0",
    operation: "resolve-critique",
    project_root: "/project",
    run_id: "ledger-test-run",
    subject: "work-item:ledger-test",
    prior_record_id: prior.metadata.critique_record_id,
    prior_record_hash: prior.metadata.critique_record_hash,
    resolving_record_id: resolving.metadata.critique_record_id,
    resolving_record_hash: resolving.metadata.critique_record_hash,
    expected_resolver: resolving.metadata.reviewer,
    resolved_lane_ids: ["security"],
    resolved_finding_ids: ["F-1"],
    prior_snapshot_sha256: prior.metadata.review_target.workspace_snapshot.digest,
    resolving_snapshot_sha256: resolving.metadata.review_target.workspace_snapshot.digest,
    prior_head_sha: "none",
    resolving_head_sha: "none",
    prior_bundle_sha256: "e".repeat(64),
    requested_at: "2030-01-01T00:00:00.000Z",
    nonce,
    signature: { algorithm: "ed25519", key_id: "test-operator", value: "signed-elsewhere" },
  };
}

function twoEdgeLedgerFixture() {
  const firstPrior = critiqueClaim("prior-one", "a".repeat(64), 1, "0".repeat(64), "reviewer-a", "fail", "fail", "open");
  const firstResolving = critiqueClaim("resolving-one", "b".repeat(64), 2, firstPrior.metadata.critique_record_hash, "reviewer-b", "pass", "pass", "fixed");
  const secondPrior = critiqueClaim("prior-two", "c".repeat(64), 3, firstResolving.metadata.critique_record_hash, "reviewer-c", "fail", "fail", "open");
  const secondResolving = critiqueClaim("resolving-two", "d".repeat(64), 4, secondPrior.metadata.critique_record_hash, "reviewer-d", "pass", "pass", "fixed");
  const firstAuthorization = resolutionAuthorization(firstPrior, firstResolving, "nonce-one");
  const first = resolveCritiqueTransition({
    bundle: { schema_version: "1.0", claims: [firstPrior, firstResolving] },
    resolution_events: [],
    authorization: firstAuthorization,
    prior_record_id: firstPrior.metadata.critique_record_id,
    resolving_record_id: firstResolving.metadata.critique_record_id,
  });
  const secondAuthorization = resolutionAuthorization(secondPrior, secondResolving, "nonce-two");
  const bundle = { schema_version: "1.0", claims: [...first.bundle.claims, secondPrior, secondResolving] };
  return {
    bundle,
    ledger: { schema_version: "1.0", events: first.resolution_events },
    authorization: secondAuthorization,
    priorRecordId: secondPrior.metadata.critique_record_id,
    resolvingRecordId: secondResolving.metadata.critique_record_id,
  };
}

function writeLedger(directory, value, mode = 0o600, name = "lifecycle-authority.resolution-events.json") {
  const file = path.join(directory, name);
  fs.writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value)}\n`, { mode });
  return file;
}

function explicitSecondTransition(fixture, resolutionEvents) {
  return resolveCritiqueTransition({
    bundle: fixture.bundle,
    resolution_events: resolutionEvents,
    authorization: fixture.authorization,
    prior_record_id: fixture.priorRecordId,
    resolving_record_id: fixture.resolvingRecordId,
  });
}

test("canonical Flow manifest declares and uses the isolated 16 MiB capacity", () => {
  const source = fs.readFileSync(COORDINATOR, "utf8");
  assert.ok(
    /(?:export\s+)?const\s+MAX_CANONICAL_FLOW_MANIFEST_BYTES\s*=\s*16\s*\*\s*1024\s*\*\s*1024\s*;/.test(source),
    "coordinator must declare the named 16 MiB canonical-manifest cap",
  );
  assert.ok(
    /protectedRegularFile\(\s*files\.manifest,\s*"canonical Flow evidence manifest",\s*MAX_CANONICAL_FLOW_MANIFEST_BYTES\s*\)/s.test(source),
    "coordinator must apply the named cap only to the canonical evidence manifest",
  );
});

test("privileged history-repair authorization rejects signed shape drift and legacy payloads", async () => {
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-privileged-authorization-"));
  let loaded = null;
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const registryFile = path.join(fixtureDirectory, "keys.json");
    fs.writeFileSync(registryFile, JSON.stringify({ schema_version: "1.0", keys: [{ id: "test-key", algorithm: "ed25519", public_key_pem: publicKey.export({ type: "spki", format: "pem" }) }] }), { mode: 0o600 });
    loaded = await loadProtectedReadFromCoordinator({ registryFile });
    const unsigned = Object.fromEntries(loaded.historyRepairAuthorizationFields.filter((field) => field !== "signature").map((field) => [field, `fixture-${field}`]));
    unsigned.operation = "repair-critique-resolution-history";
    unsigned.expires_at = "2030-01-01T00:00:00.000Z";
    const verifySigned = (candidate) => {
      const authorizationFile = path.join(fixtureDirectory, `authorization-${Math.random()}.json`);
      fs.writeFileSync(authorizationFile, JSON.stringify(signHistoricalAuthorization(candidate, privateKey)), { mode: 0o600 });
      return loaded.verifyAuthorization(authorizationFile);
    };
    assert.doesNotThrow(() => verifySigned(unsigned));
    assert.throws(() => verifySigned({ ...unsigned, unexpected: "signed-too" }), /unexpected or missing fields/i);
    const missing = { ...unsigned };
    delete missing.historical_bridge_sha256;
    assert.throws(() => verifySigned(missing), /unexpected or missing fields/i);
    const legacy = Object.fromEntries(Object.entries(unsigned).filter(([field]) => !field.startsWith("historical_") && !field.startsWith("current_")));
    assert.throws(() => verifySigned(legacy), /unexpected or missing fields/i);
  } finally {
    if (loaded) fs.rmSync(loaded.directory, { recursive: true, force: true });
    fs.rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test("current four MiB coordinator guard rejects the protected 4,288,259-byte canonical manifest", async () => {
  const { directory, protectedRegularFile } = await loadProtectedReadFromCoordinator();
  try {
    const manifest = writeProtectedManifest(directory, CURRENT_MANIFEST_BYTES);
    assert.throws(
      () => protectedRegularFile(manifest, "canonical Flow evidence manifest", 4 * 1024 * 1024),
      /canonical Flow evidence manifest must be a protected regular file/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the named 16 MiB boundary admits protected valid manifests and rejects one byte over", async () => {
  const { directory, protectedRegularFile } = await loadProtectedReadFromCoordinator();
  try {
    const currentScale = writeProtectedManifest(directory, CURRENT_MANIFEST_BYTES);
    const atLimit = writeProtectedManifest(directory, EXPECTED_MANIFEST_BYTES);
    const overLimit = writeProtectedManifest(directory, EXPECTED_MANIFEST_BYTES + 1);
    assert.doesNotThrow(() => JSON.parse(protectedRegularFile(currentScale, "canonical Flow evidence manifest", EXPECTED_MANIFEST_BYTES).toString("utf8")));
    assert.doesNotThrow(() => JSON.parse(protectedRegularFile(atLimit, "canonical Flow evidence manifest", EXPECTED_MANIFEST_BYTES).toString("utf8")));
    assert.throws(
      () => protectedRegularFile(overLimit, "canonical Flow evidence manifest", EXPECTED_MANIFEST_BYTES),
      /canonical Flow evidence manifest must be a protected regular file/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the manifest boundary retains malformed JSON and writable-file rejection", async () => {
  const { directory, protectedRegularFile } = await loadProtectedReadFromCoordinator();
  try {
    const malformed = path.join(directory, "malformed.json");
    fs.writeFileSync(malformed, "{not-json", { mode: 0o600 });
    assert.throws(() => JSON.parse(protectedRegularFile(malformed, "canonical Flow evidence manifest", EXPECTED_MANIFEST_BYTES).toString("utf8")), SyntaxError);

    const writable = writeProtectedManifest(directory, 128);
    fs.chmodSync(writable, 0o622);
    assert.throws(
      () => protectedRegularFile(writable, "canonical Flow evidence manifest", EXPECTED_MANIFEST_BYTES),
      /canonical Flow evidence manifest must be a protected regular file/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("external authority events are an explicit transition input and append after the protected ledger tail", () => {
  const fixture = twoEdgeLedgerFixture();
  const next = explicitSecondTransition(fixture, fixture.ledger.events);
  assert.equal(next.resolution_events.length, 2, "a second resolution must retain the first external event");
  assert.deepEqual(next.resolution_events[0], fixture.ledger.events[0], "prior external event bytes/semantics remain first");
  assert.equal(next.resolution_events[1].sequence, 2, "the new event follows the protected ledger tail");
  assert.equal(next.bundle.critique_resolution_events, undefined, "the persisted Hachure bundle must not carry authority events");
});

test("coordinator declares a protected external ledger loader and chain validator before mutation", () => {
  const source = fs.readFileSync(COORDINATOR, "utf8");
  assert.ok(
    /(?:lifecycle-authority\.resolution-events\.json[\s\S]{0,800}protectedJson|protectedJson[\s\S]{0,800}lifecycle-authority\.resolution-events\.json)/.test(source),
    "coordinator must protected-load lifecycle-authority.resolution-events.json before resolving",
  );
  assert.ok(
    /validat\w*Resolution\w*(?:Event|Ledger)/i.test(source),
    "coordinator must validate ledger sequence, predecessor, hash, and duplicate-event invariants before mutation",
  );
});

test("coordinator protected-loads the external ledger, rejects an untrusted historical authorization, and fails closed when a post-edge ledger is absent", async () => {
  const { directory, loadResolutionEventLedger } = await loadProtectedReadFromCoordinator();
  try {
    const fixture = twoEdgeLedgerFixture();
    const sessionDir = path.join(directory, "session");
    fs.mkdirSync(sessionDir);
    const ledgerFile = writeLedger(sessionDir, fixture.ledger);
    const before = fs.readFileSync(ledgerFile);
    assert.throws(
      () => loadResolutionEventLedger({ sessionDir, projectRoot: "/project" }, fixture.bundle, fixture.authorization),
      /authorization key is not trusted/i,
      "a ledger event is never trusted merely because its hash chain is coherent",
    );
    assert.deepEqual(fs.readFileSync(ledgerFile), before, "failed historical authorization verification never rewrites the protected ledger");

    fs.unlinkSync(ledgerFile);
    assert.throws(
      () => loadResolutionEventLedger({ sessionDir, projectRoot: "/project" }, fixture.bundle, fixture.authorization),
      /ledger is required.*repair is required/i,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("coordinator cryptographically verifies stored historical authorizations without applying live expiry", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-coordinator-registry-test-"));
  let moduleDirectory = null;
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const registryFile = path.join(directory, "keys.json");
    fs.writeFileSync(registryFile, JSON.stringify({ schema_version: "1.0", keys: [{ id: "test-key", algorithm: "ed25519", public_key_pem: publicKey.export({ type: "spki", format: "pem" }) }] }), { mode: 0o600 });
    const loaded = await loadProtectedReadFromCoordinator({ registryFile });
    moduleDirectory = loaded.directory;
    const { loadResolutionEventLedger } = loaded;
    const fixture = twoEdgeLedgerFixture();
    const bundle = structuredClone(fixture.bundle);
    const historical = resignHistoricalEvent(structuredClone(fixture.ledger.events[0]), bundle, privateKey, (authorization) => ({ ...authorization, expires_at: "2000-01-01T00:00:00.000Z" }));
    const sessionDir = path.join(directory, "session");
    fs.mkdirSync(sessionDir);
    writeLedger(sessionDir, { schema_version: "1.0", events: [historical] });
    assert.deepEqual(loadResolutionEventLedger({ sessionDir, projectRoot: "/project" }, bundle, fixture.authorization).events, [historical], "a valid historical signature remains valid after expiry");

    const forged = resignHistoricalEvent(structuredClone(historical), bundle, privateKey, (authorization) => ({ ...authorization, requested_at: "2031-01-01T00:00:00.000Z" }));
    forged.signed_authorization.requested_at = "2032-01-01T00:00:00.000Z";
    forged.authorization_sha256 = rawSha256(Buffer.from(JSON.stringify(forged.signed_authorization)));
    forged.event_id = `critique-resolution:${forged.authorization_sha256}`;
    forged.edge = { ...forged.edge, authorization_sha256: forged.authorization_sha256, resolution_event_id: forged.event_id };
    bundle.claims.find((claim) => claim.metadata?.critique_resolution?.prior_record_id === forged.prior_record_id).metadata.critique_resolution = forged.edge;
    const { event_hash: _forgedHash, ...forgedUnsigned } = forged;
    forged.event_hash = rawSha256(Buffer.from(JSON.stringify(forgedUnsigned)));
    writeLedger(sessionDir, { schema_version: "1.0", events: [forged] });
    assert.throws(() => loadResolutionEventLedger({ sessionDir, projectRoot: "/project" }, bundle, fixture.authorization), /authorization signature is invalid/i, "a coherently rehashed ledger cannot forge its embedded Ed25519 authorization");
  } finally {
    if (moduleDirectory) fs.rmSync(moduleDirectory, { recursive: true, force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("coordinator rejects forged or stale current completions before history repair", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-coordinator-completion-test-"));
  let moduleDirectory = null;
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const completionKeyFile = path.join(directory, "completion-verification-key.pem");
    fs.writeFileSync(completionKeyFile, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
    const loaded = await loadProtectedReadFromCoordinator({ completionKeyFile });
    moduleDirectory = loaded.directory;
    const fixture = twoEdgeLedgerFixture();
    const sessionDir = path.join(directory, "session"); fs.mkdirSync(sessionDir);
    const unsigned = {
      schema_version: "1.0", kind: "kontourai.lifecycle-authority.completion", action: "resolve-critique", request_sha256: "a".repeat(64), run_id: fixture.authorization.run_id,
      operation_status: "applied", result_core_sha256: loaded.lifecycleAuthorityResultDigest(fixture.bundle, fixture.ledger.events), coordinator_runtime_sha256: "b".repeat(64), completed_at: "2030-01-01T00:00:00.000Z",
    };
    const complete = (value) => ({ ...value, signature: { algorithm: "ed25519", value: sign(null, Buffer.from(loaded.canonicalJson(value)), privateKey).toString("base64") } });
    const writeCompletion = (completion) => fs.writeFileSync(path.join(sessionDir, "lifecycle-authority.completion.json"), `${JSON.stringify(completion)}\n`, { mode: 0o600 });
    writeCompletion(complete(unsigned));
    assert.equal(loaded.verifyCurrentLifecycleCompletion({ sessionDir, runId: fixture.authorization.run_id }, fixture.bundle, fixture.ledger.events).result_core_sha256, unsigned.result_core_sha256);
    writeCompletion({ ...complete(unsigned), result_core_sha256: "f".repeat(64) });
    assert.throws(() => loaded.verifyCurrentLifecycleCompletion({ sessionDir, runId: fixture.authorization.run_id }, fixture.bundle, fixture.ledger.events), /completion signature is invalid/i, "a forged completion is rejected cryptographically");
    writeCompletion(complete({ ...unsigned, result_core_sha256: "f".repeat(64) }));
    assert.throws(() => loaded.verifyCurrentLifecycleCompletion({ sessionDir, runId: fixture.authorization.run_id }, fixture.bundle, fixture.ledger.events), /does not bind the exact bundle and resolution ledger/i, "a valid but stale completion cannot authorize repair");
    const replayed = complete({ ...unsigned, operation_status: "replayed" });
    writeCompletion(replayed);
    assert.throws(() => loaded.verifyCurrentLifecycleCompletion({ sessionDir, runId: fixture.authorization.run_id }, fixture.bundle, fixture.ledger.events), /current lifecycle completion identity is invalid/i, "a correctly signed replayed completion cannot authorize the current receipt");
    assert.deepEqual(
      loaded.verifyHistoricalLifecycleCompletion({ sessionDir, runId: fixture.authorization.run_id }, replayed),
      replayed,
      "historical bridge authentication preserves legacy replayed completion support",
    );
  } finally {
    if (moduleDirectory) fs.rmSync(moduleDirectory, { recursive: true, force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("committed recovery replaces only an authenticated stale receipt with an exact-current root candidate", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-coordinator-replay-receipt-"));
  let moduleDirectory = null;
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const completionKeyFile = path.join(directory, "completion-verification-key.pem");
    fs.writeFileSync(completionKeyFile, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
    const loaded = await loadProtectedReadFromCoordinator({ completionKeyFile });
    moduleDirectory = loaded.directory;
    const sessionDir = path.join(directory, "project", ".kontourai", "flow-agents", "run-replay");
    fs.mkdirSync(sessionDir, { recursive: true });
    const bundle = { schema_version: "1.0", claims: [] };
    fs.writeFileSync(path.join(sessionDir, "trust.bundle"), `${JSON.stringify(bundle)}\n`, { mode: 0o600 });
    const exactCore = loaded.lifecycleAuthorityResultDigest(bundle, []);
    const signedCompletion = (requestSha256, resultCoreSha256, action = "repair-critique-resolution-history", operationStatus = "applied", overrides = {}) => {
      const unsigned = { schema_version: "1.0", kind: "kontourai.lifecycle-authority.completion", action, request_sha256: requestSha256, run_id: "run-replay", operation_status: operationStatus, result_core_sha256: resultCoreSha256, coordinator_runtime_sha256: "a".repeat(64), completed_at: "2030-01-01T00:00:00.000Z", ...overrides };
      return { ...unsigned, signature: { algorithm: "ed25519", value: sign(null, Buffer.from(loaded.canonicalJson(unsigned)), privateKey).toString("base64") } };
    };
    const exactCandidate = signedCompletion("b".repeat(64), exactCore);
    const staleHistorical = signedCompletion("c".repeat(64), "d".repeat(64));
    const receiptFile = path.join(sessionDir, "lifecycle-authority.completion.json");
    fs.writeFileSync(receiptFile, `${JSON.stringify(staleHistorical)}\n`, { mode: 0o600 });
    assert.deepEqual(loaded.installCompletionReceipt({ sessionDir, runId: "run-replay" }, exactCandidate), { run_id: "run-replay", receipt: "replaced" });
    assert.deepEqual(JSON.parse(fs.readFileSync(receiptFile, "utf8")), exactCandidate, "a signed stale receipt is replaced after committed recovery");

    const newer = signedCompletion("e".repeat(64), exactCore);
    fs.writeFileSync(receiptFile, `${JSON.stringify(newer)}\n`, { mode: 0o600 });
    const newerBytes = fs.readFileSync(receiptFile);
    assert.deepEqual(loaded.installCompletionReceipt({ sessionDir, runId: "run-replay" }, exactCandidate), { run_id: "run-replay", receipt: "preserved" });
    assert.deepEqual(fs.readFileSync(receiptFile), newerBytes, "a valid different exact-current newer receipt is preserved");
    assert.deepEqual(loaded.installCompletionReceipt({ sessionDir, runId: "run-replay" }, staleHistorical), { run_id: "run-replay", receipt: "preserved" });
    assert.deepEqual(fs.readFileSync(receiptFile), newerBytes, "a stale completed replay cannot displace a newer exact-current receipt");

    const forgedExisting = { ...staleHistorical, result_core_sha256: exactCore };
    fs.writeFileSync(receiptFile, `${JSON.stringify(forgedExisting)}\n`, { mode: 0o600 });
    const forgedBytes = fs.readFileSync(receiptFile);
    assert.throws(() => loaded.installCompletionReceipt({ sessionDir, runId: "run-replay" }, exactCandidate), /signature is invalid/i);
    assert.deepEqual(fs.readFileSync(receiptFile), forgedBytes, "a forged existing receipt is never replaced");

    const malformedExisting = { ...staleHistorical, unexpected: true };
    fs.writeFileSync(receiptFile, `${JSON.stringify(malformedExisting)}\n`, { mode: 0o600 });
    const malformedBytes = fs.readFileSync(receiptFile);
    assert.throws(() => loaded.installCompletionReceipt({ sessionDir, runId: "run-replay" }, exactCandidate), /historical lifecycle completion contains unexpected or missing fields/i);
    assert.deepEqual(fs.readFileSync(receiptFile), malformedBytes, "a malformed existing receipt is never replaced");

    const forgedCandidate = { ...exactCandidate, result_core_sha256: "f".repeat(64) };
    fs.writeFileSync(receiptFile, `${JSON.stringify(staleHistorical)}\n`, { mode: 0o600 });
    const staleBytes = fs.readFileSync(receiptFile);
    assert.throws(() => loaded.installCompletionReceipt({ sessionDir, runId: "run-replay" }, forgedCandidate), /signature is invalid/i);
    assert.deepEqual(fs.readFileSync(receiptFile), staleBytes, "a forged candidate cannot replace a stale receipt");

    const replayedCandidate = signedCompletion("f".repeat(64), exactCore, "repair-critique-resolution-history", "replayed");
    assert.throws(() => loaded.installCompletionReceipt({ sessionDir, runId: "run-replay" }, replayedCandidate), /current lifecycle completion identity is invalid/i);
    assert.deepEqual(fs.readFileSync(receiptFile), staleBytes, "a correctly signed replayed candidate cannot replace a stale receipt");

    const invalidProtocolCandidates = [
      ["runtime digest", signedCompletion("1".repeat(64), exactCore, undefined, undefined, { coordinator_runtime_sha256: "A".repeat(64) }), /coordinator_runtime_sha256 is invalid/i],
      ["timestamp", signedCompletion("2".repeat(64), exactCore, undefined, undefined, { completed_at: "not-a-timestamp" }), /timestamp is invalid/i],
      ["Base64 signature", { ...exactCandidate, signature: { ...exactCandidate.signature, value: "!" } }, /signature is invalid/i],
    ];
    for (const [label, invalidCandidate, error] of invalidProtocolCandidates) {
      assert.throws(() => loaded.installCompletionReceipt({ sessionDir, runId: "run-replay" }, invalidCandidate), error, `invalid candidate ${label} fails closed`);
      assert.deepEqual(fs.readFileSync(receiptFile), staleBytes, `invalid candidate ${label} leaves the existing receipt untouched`);
    }

    const invalidProtocolExisting = [
      ["runtime digest", signedCompletion("3".repeat(64), "d".repeat(64), undefined, undefined, { coordinator_runtime_sha256: "A".repeat(64) }), /coordinator_runtime_sha256 is invalid/i],
      ["timestamp", signedCompletion("4".repeat(64), "d".repeat(64), undefined, undefined, { completed_at: "not-a-timestamp" }), /timestamp is invalid/i],
      ["Base64 signature", { ...staleHistorical, signature: { ...staleHistorical.signature, value: "!" } }, /signature is invalid/i],
    ];
    for (const [label, invalidExisting, error] of invalidProtocolExisting) {
      fs.writeFileSync(receiptFile, `${JSON.stringify(invalidExisting)}\n`, { mode: 0o600 });
      const invalidExistingBytes = fs.readFileSync(receiptFile);
      assert.throws(() => loaded.installCompletionReceipt({ sessionDir, runId: "run-replay" }, exactCandidate), error, `invalid existing ${label} fails closed`);
      assert.deepEqual(fs.readFileSync(receiptFile), invalidExistingBytes, `invalid existing ${label} is never replaced`);
    }

    fs.unlinkSync(receiptFile);
    assert.throws(() => loaded.installCompletionReceipt({ sessionDir, runId: "run-replay" }, staleHistorical), /does not bind the exact bundle and resolution ledger/i);
    assert.equal(fs.existsSync(receiptFile), false, "a missing receipt is not restored from a stale candidate");
    assert.deepEqual(loaded.installCompletionReceipt({ sessionDir, runId: "run-replay" }, exactCandidate), { run_id: "run-replay", receipt: "written" });
    assert.deepEqual(JSON.parse(fs.readFileSync(receiptFile, "utf8")), exactCandidate);
    assert.deepEqual(loaded.installCompletionReceipt({ sessionDir, runId: "run-replay" }, exactCandidate), { run_id: "run-replay", receipt: "present" }, "ordinary exact replay remains present");
    for (const action of ["cancel", "archive"]) {
      const requestSha256 = action === "cancel" ? "6".repeat(64) : "7".repeat(64);
      const completion = signedCompletion(requestSha256, exactCore, action);
      assert.deepEqual(
        loaded.durableCompletionRecord(
          { authorization_sha256: "8".repeat(64), request_sha256: requestSha256, result_core_sha256: exactCore, completion },
          { action, request_sha256: requestSha256 }, { runId: "run-replay" }, "8".repeat(64),
        ),
        completion,
        `${action} replay reuses its exact signed durable completion`,
      );
    }
  } finally {
    if (moduleDirectory) fs.rmSync(moduleDirectory, { recursive: true, force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("historical repair bridge is request-keyed, append-only, and rejects an altered canonical snapshot", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-coordinator-historical-bridge-"));
  let moduleDirectory = null;
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const completionKeyFile = path.join(directory, "completion-verification-key.pem");
    fs.writeFileSync(completionKeyFile, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
    const stateRoot = path.join(directory, "root-state");
    const loaded = await loadProtectedReadFromCoordinator({ completionKeyFile, stateRoot });
    moduleDirectory = loaded.directory;
    const projectRoot = path.join(directory, "project");
    const runId = "run-bridge";
    const sessionDir = path.join(projectRoot, ".kontourai", "flow-agents", runId);
    const flowRoot = path.join(projectRoot, ".kontourai", "flow", "runs", runId);
    fs.mkdirSync(path.join(flowRoot, "evidence"), { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    const historicalAuthorization = { operation: "resolve-critique", project_root: projectRoot, run_id: runId, nonce: "historical-nonce", signature: { key_id: "historical-key" } };
    const event = { event_id: "historical-event", event_hash: "e".repeat(64), operation: "resolve-critique", run_id: runId, signed_authorization: historicalAuthorization };
    const historicalBundle = { schema_version: "1.0", claims: [] };
    const resultCore = loaded.lifecycleAuthorityResultDigest(historicalBundle, [event]);
    const completionUnsigned = { schema_version: "1.0", kind: "kontourai.lifecycle-authority.completion", action: "resolve-critique", request_sha256: "a".repeat(64), run_id: runId, operation_status: "applied", result_core_sha256: resultCore, coordinator_runtime_sha256: "b".repeat(64), completed_at: "2030-01-01T00:00:00.000Z" };
    const completion = { ...completionUnsigned, signature: { algorithm: "ed25519", value: sign(null, Buffer.from(loaded.canonicalJson(completionUnsigned)), privateKey).toString("base64") } };
    fs.writeFileSync(path.join(sessionDir, "lifecycle-authority.completion.json"), `${JSON.stringify(completion)}\n`, { mode: 0o600 });
    const attachmentId = `lifecycle-authority:${completion.request_sha256}`;
    const storedPath = `evidence/${attachmentId}.json`;
    const storedBytes = Buffer.from(`${JSON.stringify(historicalBundle)}\n`);
    fs.writeFileSync(path.join(flowRoot, storedPath), storedBytes, { mode: 0o600 });
    const entry = { id: attachmentId, kind: "trust.bundle", stored_path: storedPath, sha256: rawSha256(storedBytes) };
    fs.writeFileSync(path.join(flowRoot, "evidence", "manifest.json"), `${JSON.stringify({ evidence: [entry] })}\n`, { mode: 0o600 });
    const currentBundle = structuredClone(historicalBundle);
    const ledgerBytes = Buffer.from(`${JSON.stringify({ schema_version: "1.0", events: [event] })}\n`);
    const ledger = { events: [event], bytes: ledgerBytes };
    const prefix = selectUniqueHistoricalLedgerPrefix(historicalBundle, ledger.events, resultCore);
    const history = critiqueHistoryProjectionSummary(currentBundle.claims);
    const edges = critiqueResolutionEdgeProjectionSummary(currentBundle.claims);
    const operationId = loaded.sha256({ project: projectRoot, run_id: runId, action: "resolve-critique", key_id: "historical-key", nonce: "historical-nonce" });
    const authorization = {
      operation: "repair-critique-resolution-history", current_bundle_sha256: rawSha256(Buffer.from(JSON.stringify(currentBundle))), current_ledger_sha256: rawSha256(ledgerBytes), current_ledger_length: 1, current_ledger_tail_hash: event.event_hash,
      current_completion_sha256: rawSha256(Buffer.from(JSON.stringify(completion))), historical_completion_sha256: rawSha256(Buffer.from(JSON.stringify(completion))), historical_completion_request_sha256: completion.request_sha256, historical_completion_action: completion.action, historical_completion_result_core_sha256: completion.result_core_sha256,
      historical_attachment_id: attachmentId, historical_manifest_entry_sha256: loaded.sha256(entry), historical_stored_path: storedPath, historical_stored_raw_sha256: rawSha256(storedBytes), historical_stored_bundle_sha256: loaded.sha256(historicalBundle), historical_durable_operation_id: operationId, historical_durable_completion_record_sha256: "c".repeat(64),
      historical_ledger_prefix_length: prefix.length, historical_ledger_prefix_raw_sha256: prefix.raw_sha256, historical_ledger_prefix_canonical_sha256: prefix.canonical_sha256, historical_ledger_prefix_tail_hash: prefix.tail_hash,
      historical_critique_projection_version: history.version, historical_critique_projection_sha256: history.digest, historical_critique_projection_length: history.length, historical_critique_projection_tail_hash: history.tail_hash,
      current_critique_projection_version: history.version, current_critique_projection_sha256: history.digest, current_critique_projection_length: history.length, current_critique_projection_tail_hash: history.tail_hash,
      historical_resolution_edge_projection_sha256: edges.digest, historical_resolution_edge_projection_count: edges.count, current_resolution_edge_projection_sha256: edges.digest, current_resolution_edge_projection_count: edges.count,
    };
    authorization.historical_bridge_sha256 = critiqueResolutionHistoryBridgeDigest(authorization);
    const paths = { projectRoot, sessionDir, runId };
    let bridge = loaded.deriveHistoricalRepairBridge(paths, authorization, Buffer.from(JSON.stringify(currentBundle)), currentBundle, ledger);
    const historicalAuthorizationSha256 = loaded.sha256(historicalAuthorization);
    const durableCompletion = { authorization_sha256: historicalAuthorizationSha256, request_sha256: completion.request_sha256, result_core_sha256: completion.result_core_sha256, completion };
    authorization.historical_durable_completion_record_sha256 = loaded.sha256(durableCompletion);
    authorization.historical_bridge_sha256 = critiqueResolutionHistoryBridgeDigest(authorization);
    bridge = loaded.deriveHistoricalRepairBridge(paths, authorization, Buffer.from(JSON.stringify(currentBundle)), currentBundle, ledger);
    fs.mkdirSync(path.join(stateRoot, "completions"), { recursive: true });
    fs.mkdirSync(path.join(stateRoot, "nonces"), { recursive: true });
    const completionFile = path.join(stateRoot, "completions", `${operationId}.json`);
    const nonceFile = path.join(stateRoot, "nonces", `${loaded.sha256("historical-key\u0000historical-nonce")}.json`);
    fs.writeFileSync(completionFile, `${JSON.stringify(durableCompletion)}\n`, { mode: 0o600 });
    const durableNonce = { schema_version: "1.0", operation_id: operationId, authorization_sha256: historicalAuthorizationSha256, key_id: "historical-key", nonce: "historical-nonce", request_sha256: completion.request_sha256, status: "applied", result_core_sha256: completion.result_core_sha256 };
    fs.writeFileSync(nonceFile, `${JSON.stringify(durableNonce)}\n`, { mode: 0o600 });
    const replayEnvelope = { action: "resolve-critique", request_sha256: completion.request_sha256 };
    assert.deepEqual(
      loaded.durableCompletionRecord(durableCompletion, replayEnvelope, { runId }, historicalAuthorizationSha256),
      completion,
      "completed replay authenticates and reuses the exact signed durable completion",
    );
    assert.throws(
      () => loaded.durableCompletionRecord({ ...durableCompletion, request_sha256: "f".repeat(64) }, replayEnvelope, { runId }, historicalAuthorizationSha256),
      /does not match the exact request/i,
      "a mismatched durable completion cannot be replayed",
    );
    assert.doesNotThrow(() => loaded.verifyHistoricalDurableAnchor(bridge, authorization, { completion, event }));
    const preparedNonce = { ...durableNonce, status: "prepared" };
    fs.writeFileSync(nonceFile, `${JSON.stringify(preparedNonce)}\n`, { mode: 0o600 });
    assert.deepEqual(
      loaded.reconcileCompletedNonce(nonceFile, preparedNonce, completion.result_core_sha256),
      durableNonce,
      "a replay after the durable completion write promotes only its exact prepared nonce",
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(nonceFile, "utf8")), durableNonce);
    assert.doesNotThrow(
      () => loaded.verifyHistoricalDurableAnchor(bridge, authorization, { completion, event }),
      "the completion-write crash window restores the exact durable three-anchor state for a later repair",
    );
    const appliedNonceBytes = fs.readFileSync(nonceFile);
    assert.deepEqual(loaded.reconcileCompletedNonce(nonceFile, preparedNonce, completion.result_core_sha256), durableNonce);
    assert.deepEqual(fs.readFileSync(nonceFile), appliedNonceBytes, "an exact applied nonce is not rewritten during replay");
    fs.unlinkSync(path.join(sessionDir, "lifecycle-authority.completion.json"));
    fs.writeFileSync(path.join(sessionDir, "trust.bundle"), `${JSON.stringify(currentBundle)}\n`, { mode: 0o600 });
    writeLedger(sessionDir, { schema_version: "1.0", events: [event] });
    assert.deepEqual(
      loaded.installCompletionReceipt({ sessionDir, runId }, durableCompletion.completion),
      { run_id: runId, receipt: "written" },
      "a replay after the nonce write restores the exact authenticated durable completion rather than minting a replay receipt",
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sessionDir, "lifecycle-authority.completion.json"), "utf8")), durableCompletion.completion);
    assert.doesNotThrow(
      () => loaded.verifyHistoricalDurableAnchor(bridge, authorization, { completion, event }),
      "the nonce-write crash window remains usable by the later three-anchor repair",
    );
    fs.unlinkSync(nonceFile);
    assert.throws(
      () => loaded.reconcileCompletedNonce(nonceFile, preparedNonce, completion.result_core_sha256),
      /nonce record is missing/i,
      "replay never fabricates a missing durable nonce anchor",
    );
    fs.writeFileSync(nonceFile, `${JSON.stringify(durableNonce)}\n`, { mode: 0o600 });
    fs.unlinkSync(completionFile);
    assert.throws(() => loaded.verifyHistoricalDurableAnchor(bridge, authorization, { completion, event }), /ENOENT|historical durable completion/i, "a missing historical completion record rejects before publication");
    fs.writeFileSync(completionFile, `${JSON.stringify({ ...durableCompletion, request_sha256: "f".repeat(64) })}\n`, { mode: 0o600 });
    assert.throws(() => loaded.verifyHistoricalDurableAnchor(bridge, authorization, { completion, event }), /completion record does not match/i, "a mismatched historical completion record rejects before publication");
    fs.writeFileSync(completionFile, `${JSON.stringify(durableCompletion)}\n`, { mode: 0o600 });
    fs.unlinkSync(nonceFile);
    assert.throws(() => loaded.verifyHistoricalDurableAnchor(bridge, authorization, { completion, event }), /ENOENT|historical durable nonce/i, "a missing historical nonce record rejects before publication");
    fs.writeFileSync(nonceFile, `${JSON.stringify({ ...durableNonce, nonce: "mismatched" })}\n`, { mode: 0o600 });
    assert.throws(() => loaded.verifyHistoricalDurableAnchor(bridge, authorization, { completion, event }), /nonce record does not match/i, "a mismatched historical nonce record rejects before publication");
    fs.writeFileSync(nonceFile, `${JSON.stringify(durableNonce)}\n`, { mode: 0o600 });
    assert.doesNotThrow(() => loaded.verifyHistoricalDurableAnchor(bridge, authorization, { completion, event }));
    const supersedingAttachmentId = `lifecycle-authority:${"f".repeat(64)}`;
    const supersededEntry = { ...entry, superseded_by: supersedingAttachmentId };
    const manifestFile = path.join(flowRoot, "evidence", "manifest.json");
    fs.writeFileSync(manifestFile, `${JSON.stringify({ evidence: [supersededEntry] })}\n`, { mode: 0o600 });
    assert.doesNotThrow(
      () => loaded.deriveHistoricalRepairBridge(paths, authorization, Buffer.from(JSON.stringify(currentBundle)), currentBundle, ledger, { expectedSupersededBy: supersedingAttachmentId }),
      "the final CAS authenticates the signed entry after the one expected supersession",
    );
    fs.writeFileSync(manifestFile, `${JSON.stringify({ evidence: [{ ...supersededEntry, unrelated: "drift" }] })}\n`, { mode: 0o600 });
    assert.throws(
      () => loaded.deriveHistoricalRepairBridge(paths, authorization, Buffer.from(JSON.stringify(currentBundle)), currentBundle, ledger, { expectedSupersededBy: supersedingAttachmentId }),
      /does not match the signed bridge/i,
      "unrelated manifest-entry drift is not hidden by the expected supersession",
    );
    const expectedManifestBytes = Buffer.from(`${JSON.stringify({ evidence: [supersededEntry] })}\n`);
    fs.writeFileSync(manifestFile, expectedManifestBytes, { mode: 0o600 });
    assert.doesNotThrow(() => loaded.assertCanonicalFlowPostimages({ postimages: [{ file: manifestFile, bytes: expectedManifestBytes, label: "canonical Flow evidence manifest", max_bytes: EXPECTED_MANIFEST_BYTES }] }));
    fs.appendFileSync(manifestFile, " ");
    assert.throws(() => loaded.assertCanonicalFlowPostimages({ postimages: [{ file: manifestFile, bytes: expectedManifestBytes, label: "canonical Flow evidence manifest", max_bytes: EXPECTED_MANIFEST_BYTES }] }), /postimage changed/i, "post-synchronize manifest drift aborts before session publication");
    fs.writeFileSync(manifestFile, expectedManifestBytes, { mode: 0o600 });
    fs.writeFileSync(path.join(flowRoot, storedPath), `${JSON.stringify({ schema_version: "1.0", claims: ["tampered"] })}\n`, { mode: 0o600 });
    assert.throws(() => loaded.deriveHistoricalRepairBridge(paths, authorization, Buffer.from(JSON.stringify(currentBundle)), currentBundle, ledger, { expectedSupersededBy: supersedingAttachmentId }), /stored trust bundle digest/i);
  } finally {
    if (moduleDirectory) fs.rmSync(moduleDirectory, { recursive: true, force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("coordinator accepts only the signed exact raw trust.bundle bytes before mutation", async () => {
  const { directory, assertAuthorizedBundlePreimage } = await loadProtectedReadFromCoordinator();
  try {
    const fixture = twoEdgeLedgerFixture();
    const prettyPrinted = Buffer.from(`${JSON.stringify(fixture.bundle, null, 2)}\n`);
    const differentlyPrettyPrinted = Buffer.from(`${JSON.stringify(fixture.bundle, null, 4)}\n`);
    assert.deepEqual(JSON.parse(prettyPrinted), JSON.parse(differentlyPrettyPrinted), "fixture differs only in raw JSON presentation");
    const authorization = { ...fixture.authorization, prior_bundle_sha256: rawSha256(prettyPrinted) };
    assert.doesNotThrow(() => assertAuthorizedBundlePreimage(prettyPrinted, "resolve-critique", authorization));
    assert.throws(
      () => assertAuthorizedBundlePreimage(differentlyPrettyPrinted, "resolve-critique", authorization),
      /preimage bundle digest changed/i,
      "a raw-byte change fails before the coordinator can mutate the bundle or Flow state",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("coordinator ledger CAS rejects a newly appeared, removed, or byte-changed external ledger", async () => {
  const { directory, assertResolutionEventLedgerPreimage } = await loadProtectedReadFromCoordinator();
  try {
    const sessionDir = path.join(directory, "session"); fs.mkdirSync(sessionDir);
    const paths = { sessionDir };
    assert.doesNotThrow(() => assertResolutionEventLedgerPreimage(paths, { absent: true, bytes: Buffer.alloc(0) }));
    const ledgerFile = writeLedger(sessionDir, { schema_version: "1.0", events: [] });
    assert.throws(() => assertResolutionEventLedgerPreimage(paths, { absent: true, bytes: Buffer.alloc(0) }), /appeared/i);
    const initial = fs.readFileSync(ledgerFile);
    assert.doesNotThrow(() => assertResolutionEventLedgerPreimage(paths, { absent: false, bytes: initial }));
    fs.writeFileSync(ledgerFile, `${JSON.stringify({ schema_version: "1.0", events: [], padding: "changed" })}\n`, { mode: 0o600 });
    assert.throws(() => assertResolutionEventLedgerPreimage(paths, { absent: false, bytes: initial }), /bytes changed/i);
    fs.unlinkSync(ledgerFile);
    assert.throws(() => assertResolutionEventLedgerPreimage(paths, { absent: false, bytes: initial }), /disappeared/i);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("coordinator verifies the raw-byte preimage before parsing and at the mutation boundary", () => {
  const source = fs.readFileSync(COORDINATOR, "utf8");
  assert.match(
    source,
    /const beforeBytes = protectedRegularFile\(bundleFile, "trust bundle", 4 \* 1024 \* 1024\);\s*assertAuthorizedBundlePreimage\(beforeBytes, envelope\.action, authorization\);\s*const before = JSON\.parse/s,
    "the coordinator must reject a mismatched raw bundle before handing its parsed object to the pure transition",
  );
  assert.match(
    source,
    /await inProjectTransaction[\s\S]*?const currentBytes = protectedRegularFile\(bundleFile, "trust bundle", 4 \* 1024 \* 1024\);\s*assertAuthorizedBundlePreimage\(currentBytes, envelope\.action, authorization\);\s*if \(!currentBytes\.equals\(beforeBytes\)\)[\s\S]*?await synchronizeCanonicalFlow/s,
    "the coordinator must revalidate the same exact bytes before its first canonical mutation",
  );
});

test("protected ledger read prerequisites reject malformed, writable, symlinked, and oversized inputs", async () => {
  const { directory, protectedJson } = await loadProtectedReadFromCoordinator();
  try {
    const malformed = writeLedger(directory, "{not-json");
    assert.throws(() => protectedJson(malformed, "lifecycle authority resolution event ledger"), SyntaxError);

    const writable = writeLedger(directory, { schema_version: "1.0", events: [] }, 0o622, "writable.json");
    fs.chmodSync(writable, 0o622);
    assert.throws(() => protectedJson(writable, "lifecycle authority resolution event ledger"), /protected regular file/);

    fs.unlinkSync(writable);
    fs.symlinkSync(malformed, writable);
    assert.throws(() => protectedJson(writable, "lifecycle authority resolution event ledger"));

    fs.unlinkSync(writable);
    fs.writeFileSync(writable, " ".repeat(4 * 1024 * 1024 + 1), { mode: 0o600 });
    assert.throws(() => protectedJson(writable, "lifecycle authority resolution event ledger"), /protected regular file/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("pure transition requires an explicit ledger after a prior cross-reviewer edge instead of resetting to sequence one", () => {
  const fixture = twoEdgeLedgerFixture();
  assert.throws(
    () => resolveCritiqueTransition({
      bundle: fixture.bundle,
      authorization: fixture.authorization,
      prior_record_id: fixture.priorRecordId,
      resolving_record_id: fixture.resolvingRecordId,
    }),
    /unexpected or missing fields/i,
  );
});

test("empty explicit ledger remains a supported genesis input", () => {
  const firstPrior = critiqueClaim("genesis-prior", "1".repeat(64), 1, "0".repeat(64), "reviewer-a", "fail", "fail", "open");
  const firstResolving = critiqueClaim("genesis-resolving", "2".repeat(64), 2, firstPrior.metadata.critique_record_hash, "reviewer-b", "pass", "pass", "fixed");
  const result = resolveCritiqueTransition({
    bundle: { schema_version: "1.0", claims: [firstPrior, firstResolving] },
    resolution_events: [],
    authorization: resolutionAuthorization(firstPrior, firstResolving, "genesis-nonce"),
    prior_record_id: firstPrior.metadata.critique_record_id,
    resolving_record_id: firstResolving.metadata.critique_record_id,
  });
  assert.equal(result.resolution_events.length, 1);
  assert.equal(result.resolution_events[0].sequence, 1);
});

for (const [name, mutate] of [
  ["invalid ledger shape", () => ({})],
  ["invalid sequence", (events) => [{ ...events[0], sequence: 2 }]],
  ["invalid predecessor", (events) => [{ ...events[0], predecessor_hash: "f".repeat(64) }]],
  ["invalid event hash", (events) => [{ ...events[0], event_hash: "0".repeat(64) }]],
  ["duplicate event id", (events) => [events[0], structuredClone(events[0])]],
]) {
  test(`explicit ledger rejects ${name} before mutation`, () => {
    const fixture = twoEdgeLedgerFixture();
    const ledger = mutate(fixture.ledger.events);
    assert.throws(() => explicitSecondTransition(fixture, ledger), /ledger|event|sequence|predecessor|hash|duplicate/i);
  });
}
