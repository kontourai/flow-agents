import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveCritiqueTransition } from "../../packaging/lifecycle-authority/runtime-v1.mjs";

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

async function loadProtectedReadFromCoordinator({ registryFile, completionKeyFile } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-coordinator-test-"));
  fs.copyFileSync(RUNTIME, path.join(directory, "runtime-v1.mjs"));
  let source = fs.readFileSync(COORDINATOR, "utf8");
  if (registryFile) source = source.replace(/export const REGISTRY_FILE = .*?;/, `export const REGISTRY_FILE = ${JSON.stringify(registryFile)};`);
  if (completionKeyFile) source = source.replace(/export const COMPLETION_PUBLIC_KEY_FILE = .*?;/, `export const COMPLETION_PUBLIC_KEY_FILE = ${JSON.stringify(completionKeyFile)};`);
  fs.writeFileSync(path.join(directory, "coordinator.mjs"), `${source}\nexport { protectedRegularFile, protectedJson, loadResolutionEventLedger, assertResolutionEventLedgerPreimage, assertAuthorizedBundlePreimage, verifyCurrentLifecycleCompletion, lifecycleAuthorityResultDigest };\n`);
  const module = await import(`${pathToFileURL(path.join(directory, "coordinator.mjs")).href}?test=${Date.now()}-${Math.random()}`);
  return { directory, protectedRegularFile: module.protectedRegularFile, protectedJson: module.protectedJson, loadResolutionEventLedger: module.loadResolutionEventLedger, assertResolutionEventLedgerPreimage: module.assertResolutionEventLedgerPreimage, assertAuthorizedBundlePreimage: module.assertAuthorizedBundlePreimage, verifyCurrentLifecycleCompletion: module.verifyCurrentLifecycleCompletion, lifecycleAuthorityResultDigest: module.lifecycleAuthorityResultDigest, canonicalJson: module.canonicalJson };
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

test("root replay source keeps completed and prepared recovery separate from live expiry and preserves newer receipts", () => {
  const source = fs.readFileSync(COORDINATOR, "utf8");
  assert.match(source, /verifyAuthorization\(authorizationPath, \{ requireCurrentExpiry: false \}\)[\s\S]*?fs\.existsSync\(completionFile\)/, "exact completed replay authenticates before durable lookup without applying live expiry");
  assert.match(source, /fs\.existsSync\(nonceFile\)[\s\S]*?else \{\s*verifySignedAuthorization\(authorization, \{ requireCurrentExpiry: true \}\)/, "only a new nonce consumption requires unexpired authority");
  assert.match(source, /completion\.result_core_sha256 !== lifecycleAuthorityResultDigest\(bundle, events\)[\s\S]*?if \(fs\.existsSync\(receiptFile\)\)[\s\S]*?receipt: "preserved"/s, "receipt replay restores only exact current state and never overwrites a different valid receipt");
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
