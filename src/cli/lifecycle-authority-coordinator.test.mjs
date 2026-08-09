import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { coordinatorRuntimeSha256, critiqueHistoryProjectionSummary, critiqueResolutionEdgeProjectionSummary, critiqueResolutionHistoryBridgeDigest, resolveCritiqueTransition, selectUniqueHistoricalLedgerPrefix } from "../../packaging/lifecycle-authority/runtime-v1.mjs";
import { EXACT_CURRENT_RECOVERY_ARTIFACT_IDS, VERIFICATION_RESEAL_ARTIFACT_IDS, VERIFICATION_RESEAL_ATOMIC_REPLACE_PROTOCOL, assertVerificationResealFlowCapabilities, canonicalJson, classifyExactCurrentRecoveryArtifacts, classifyVerificationResealArtifacts, cleanupVerificationResealTransaction, exactCurrentRecoveryArtifactFiles, inProjectTransaction, provisionalWorkspaceSnapshot, recoverMatchingTransaction, rejectActiveLegacyResealJournal, replaceVerificationResealArtifactCAS, resolveCanonicalFlowRunIdentity, resolveProvisionalTrustedGitExecutable, sha256, snapshotTree, validateEnvelope, validateExactCurrentRecoveryPlan, validateProvisionalDeliveryAuthorizationBinding, validateVerificationResealPlan, verificationResealArtifactFiles, withCanonicalFlowRunMutationLock } from "../../packaging/lifecycle-authority/coordinator.mjs";
import { captureReviewWorkspaceSnapshot } from "../../build/src/lib/review-workspace-snapshot.js";
import * as pinnedFlow from "../../node_modules/@kontourai/flow/dist/index.js";
import { amendRunDefinition, definitionDigest, definitionIdentity, flowRunHead, loadRun, pauseRun, startRun } from "../../node_modules/@kontourai/flow/dist/index.js";
import { withRunMutationLock } from "../../node_modules/@kontourai/flow/dist/runtime/flow-run-store.js";

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
  fs.writeFileSync(path.join(directory, "coordinator.mjs"), `${source}\nexport { protectedRegularFile, protectedJson, loadResolutionEventLedger, loadProvisionalDeliveryLedger, recoverPreparedProvisionalDeliveryEvent, assertResolutionEventLedgerPreimage, assertAuthorizedBundlePreimage, verifyAuthorization, verifyCurrentLifecycleCompletion, verifyHistoricalLifecycleCompletion, lifecycleAuthorityResultDigest, deriveHistoricalRepairBridge, verifyHistoricalDurableAnchor, installCompletionReceipt, durableCompletionRecord, reconcileCompletedNonce, assertPrivilegedAuthorizationShape, assertCanonicalFlowPostimages, assertMergeChangeRequestAction, assertMergeChangeVerificationRefreshProvenance, assertPreparedMergeAuthorizationCurrent, HISTORY_REPAIR_AUTHORIZATION_FIELDS, EXACT_CURRENT_COMPLETION_RECOVERY_AUTHORIZATION_FIELDS };\n`);
  const module = await import(`${pathToFileURL(path.join(directory, "coordinator.mjs")).href}?test=${Date.now()}-${Math.random()}`);
  return { directory, protectedRegularFile: module.protectedRegularFile, protectedJson: module.protectedJson, loadResolutionEventLedger: module.loadResolutionEventLedger, loadProvisionalDeliveryLedger: module.loadProvisionalDeliveryLedger, recoverPreparedProvisionalDeliveryEvent: module.recoverPreparedProvisionalDeliveryEvent, validateProvisionalDeliveryTransport: module.validateProvisionalDeliveryTransport, assertResolutionEventLedgerPreimage: module.assertResolutionEventLedgerPreimage, assertAuthorizedBundlePreimage: module.assertAuthorizedBundlePreimage, verifyAuthorization: module.verifyAuthorization, verifyCurrentLifecycleCompletion: module.verifyCurrentLifecycleCompletion, verifyHistoricalLifecycleCompletion: module.verifyHistoricalLifecycleCompletion, lifecycleAuthorityResultDigest: module.lifecycleAuthorityResultDigest, deriveHistoricalRepairBridge: module.deriveHistoricalRepairBridge, verifyHistoricalDurableAnchor: module.verifyHistoricalDurableAnchor, installCompletionReceipt: module.installCompletionReceipt, durableCompletionRecord: module.durableCompletionRecord, reconcileCompletedNonce: module.reconcileCompletedNonce, assertPrivilegedAuthorizationShape: module.assertPrivilegedAuthorizationShape, assertCanonicalFlowPostimages: module.assertCanonicalFlowPostimages, assertMergeChangeRequestAction: module.assertMergeChangeRequestAction, assertMergeChangeVerificationRefreshProvenance: module.assertMergeChangeVerificationRefreshProvenance, assertPreparedMergeAuthorizationCurrent: module.assertPreparedMergeAuthorizationCurrent, historyRepairAuthorizationFields: module.HISTORY_REPAIR_AUTHORIZATION_FIELDS, recoveryAuthorizationFields: module.EXACT_CURRENT_COMPLETION_RECOVERY_AUTHORIZATION_FIELDS, canonicalJson: module.canonicalJson, sha256: module.sha256 };
}

const rawSha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("coordinator resolves effective definition identity through authorized amendments", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coordinator-effective-definition-"));
  const runId = "effective-definition";
  await startRun(path.resolve("kits/builder/flows/build.flow.json"), {
    cwd: projectRoot,
    runId,
    params: { subject: "kontourai/flow-agents#1000" },
  });
  const started = await loadRun(runId, projectRoot);
  const successor = { ...structuredClone(started.definition), version: `${started.definition.version}-coordinator-test` };
  await amendRunDefinition(runId, {
    cwd: projectRoot,
    definition: successor,
    request: {
      reason: "exercise privileged effective-definition resolution",
      expected_run_head: flowRunHead(started.state),
      expected_definition: definitionIdentity(started.definition),
      successor_digest: definitionDigest(successor),
      authority: {
        kind: "user_request",
        actor: "coordinator-test",
        request_ref: "test:coordinator-effective-definition",
        requested_at: new Date().toISOString(),
      },
    },
  });
  const amended = await loadRun(runId, projectRoot);
  const resolved = resolveCanonicalFlowRunIdentity(
    pinnedFlow,
    JSON.parse(fs.readFileSync(path.join(amended.dir, "definition.json"), "utf8")),
    JSON.parse(fs.readFileSync(path.join(amended.dir, "state.json"), "utf8")),
    runId,
  );
  assert.equal(resolved.definition.version, successor.version);
  assert.equal(definitionDigest(resolved.definition), definitionDigest(successor));
  assert.equal(flowRunHead(resolved.state), flowRunHead(amended.state));
});

test("canonical Flow synchronization attaches through an authorized amended gate", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coordinator-amended-gate-"));
  const projectRoot = path.join(root, "project");
  const installRoot = path.join(root, "installed");
  const runId = "amended-gate";
  const sessionDir = path.join(projectRoot, ".kontourai", "flow-agents", runId);
  try {
    fs.mkdirSync(projectRoot, { recursive: true });
    copyPinnedFlowClosure(installRoot);
    fs.copyFileSync(RUNTIME, path.join(installRoot, "runtime-v1.mjs"));
    const source = fs.readFileSync(COORDINATOR, "utf8");
    fs.writeFileSync(path.join(installRoot, "coordinator.mjs"), `${source}\nexport { prepareCanonicalFlowSynchronization };\n`);
    const coordinator = await import(`${pathToFileURL(path.join(installRoot, "coordinator.mjs")).href}?amended-gate=${Date.now()}-${Math.random()}`);
    await startRun(path.resolve("kits/builder/flows/build.flow.json"), {
      cwd: projectRoot,
      runId,
      params: { subject: "kontourai/flow-agents#1000" },
    });
    const started = await loadRun(runId, projectRoot);
    const successor = structuredClone(started.definition);
    successor.version = `${started.definition.version}-amended-gate`;
    successor.gates["amended-verify-gate"] = { ...successor.gates["verify-gate"] };
    delete successor.gates["verify-gate"];
    await amendRunDefinition(runId, {
      cwd: projectRoot,
      definition: successor,
      request: {
        reason: "exercise effective gate resolution in canonical synchronization",
        expected_run_head: flowRunHead(started.state),
        expected_definition: definitionIdentity(started.definition),
        successor_digest: definitionDigest(successor),
        authority: {
          kind: "user_request",
          actor: "coordinator-test",
          request_ref: "test:coordinator-amended-gate",
          requested_at: new Date().toISOString(),
        },
      },
    });
    const flowRoot = path.join(projectRoot, ".kontourai", "flow", "runs", runId);
    const stateFile = path.join(flowRoot, "state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    state.current_step = "verify";
    state.next_action = "attach amended verify gate evidence";
    fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    fs.mkdirSync(sessionDir, { recursive: true });

    const prepared = await coordinator.prepareCanonicalFlowSynchronization(
      { projectRoot, sessionDir, runId },
      { schemaVersion: 5, source: "coordinator-amended-gate-test", claims: [], evidence: [], policies: [], events: [] },
      { request_sha256: "a".repeat(64) },
    );
    const manifestPostimage = prepared.postimages.find(({ file }) => file === path.join(flowRoot, "evidence", "manifest.json"));
    assert.ok(manifestPostimage, "synchronization emits the canonical manifest postimage");
    const manifest = JSON.parse(manifestPostimage.bytes.toString("utf8"));
    const attachment = manifest.evidence.find(({ id }) => id === prepared.attachment_id);
    assert.equal(attachment.gate_id, "amended-verify-gate");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("merge-change requires an exact signed request action and post-amendment verify pass", async () => {
  const loaded = await loadProtectedReadFromCoordinator();
  const actionId = "a".repeat(64);
  const authorization = { issued_action: { action_id: actionId } };
  assert.equal(loaded.assertMergeChangeRequestAction({ request: { issued_action_id: actionId } }, authorization), actionId);
  assert.throws(
    () => loaded.assertMergeChangeRequestAction({ request: { issued_action_id: "b".repeat(64) } }, authorization),
    /does not bind the signed exact issued action/,
  );

  const definition = { id: "builder.build", version: "1.4" };
  const digest = "c".repeat(64);
  const amendment = {
    type: "definition_amended",
    at: "2026-07-27T12:00:00.000Z",
    successor_definition: { ...definition, digest },
  };
  const stalePass = {
    definition_digest: digest,
    definition_amendments: [amendment],
    gate_outcome_history: [{ gate_id: "verify-gate", status: "pass", transition_validation: { transition: { at: "2026-07-27T11:59:59.000Z" } } }],
  };
  assert.throws(
    () => loaded.assertMergeChangeVerificationRefreshProvenance(stalePass, definition, digest),
    /accepted verify-gate pass ordered after the definition amendment/,
  );
  const refreshedPass = structuredClone(stalePass);
  refreshedPass.gate_outcome_history[0].transition_validation.transition.at = "2026-07-27T12:00:01.000Z";
  assert.doesNotThrow(() => loaded.assertMergeChangeVerificationRefreshProvenance(refreshedPass, definition, digest));
  assert.doesNotThrow(() => loaded.assertMergeChangeVerificationRefreshProvenance({ definition_digest: digest, definition_amendments: [] }, definition, digest));
});

test("prepared merge-change recovery cannot outlive its signed authorization", async () => {
  const keys = generateKeyPairSync("ed25519");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prepared-merge-expiry-"));
  const registry = path.join(root, "keys.json");
  fs.writeFileSync(registry, JSON.stringify({ schema_version: "1.0", keys: [{ id: "fixture", algorithm: "ed25519", public_key_pem: keys.publicKey.export({ type: "spki", format: "pem" }) }] }), { mode: 0o600 });
  const loaded = await loadProtectedReadFromCoordinator({ registryFile: registry });
  const now = Date.now();
  const unsigned = {
    schema_version: "1.0", operation: "merge-change", project_root: root, run_id: "run-1", subject: "kontourai/flow-agents#1000",
    flow_definition_id: "builder.build", flow_definition_version: "1.4", flow_definition_digest: "a".repeat(64),
    flow_run_head: "b".repeat(64), flow_manifest_sha256: "c".repeat(64), issued_action: {},
    issued_action_sha256: "d".repeat(64), nonce: "prepared-expired", requested_at: new Date(now - 120_000).toISOString(),
    expires_at: new Date(now - 60_000).toISOString(),
  };
  const authorization = {
    ...unsigned,
    signature: { algorithm: "ed25519", key_id: "fixture", value: sign(null, Buffer.from(JSON.stringify(unsigned)), keys.privateKey).toString("base64") },
  };
  assert.throws(
    () => loaded.assertPreparedMergeAuthorizationCurrent({ action: "merge-change" }, authorization),
    /authorization is expired/,
  );
  const currentUnsigned = { ...unsigned, requested_at: new Date(now).toISOString(), expires_at: new Date(now + 60_000).toISOString() };
  const current = {
    ...currentUnsigned,
    signature: { algorithm: "ed25519", key_id: "fixture", value: sign(null, Buffer.from(JSON.stringify(currentUnsigned)), keys.privateKey).toString("base64") },
  };
  fs.writeFileSync(registry, JSON.stringify({ schema_version: "1.0", keys: [
    { id: "fixture", algorithm: "ed25519", public_key_pem: keys.publicKey.export({ type: "spki", format: "pem" }) },
    { id: "fixture-alias", algorithm: "ed25519", public_key_pem: keys.publicKey.export({ type: "spki", format: "pem" }) },
  ] }), { mode: 0o600 });
  assert.throws(
    () => loaded.assertPreparedMergeAuthorizationCurrent({ action: "merge-change" }, current),
    /duplicate key ids or cryptographic identities/,
    "one signature cannot become a second authority identity through a registry alias",
  );
  assert.doesNotThrow(
    () => loaded.assertPreparedMergeAuthorizationCurrent({ action: "archive" }, authorization),
    "non-provider lifecycle recovery retains its existing exact-state semantics",
  );
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(loaded.directory, { recursive: true, force: true });
});

function provisionalAuthorization(overrides = {}) {
  const now = new Date();
  return {
    schema_version: "1.0", operation: "publish-provisional-delivery", project_root: "/project", run_id: "session-a",
    subject: "kontourai/flow-agents#957", work_item: "kontourai/flow-agents#957", assignment_actor_key: "codex:test:host",
    assignment_generation: now.toISOString(), published_head_sha: "a".repeat(40), provider_record_id: "provider-957",
    provider_observation_sha256: "9".repeat(64), flow_definition_id: "builder.build", flow_definition_version: "1.3",
    flow_definition_digest: "1".repeat(64), flow_run_head: "2".repeat(64), flow_gate_id: "merge-ready-ci-gate",
    flow_gate_visit: now.toISOString(), workspace_snapshot: { version: 1, kind: "git-worktree", algorithm: "sha256", head_sha: "a".repeat(40), digest: "3".repeat(64), worktree_clean: true },
    checkpoint_slug: "session-a", checkpoint_commit_sha: "a".repeat(40), checkpoint_sha256: "4".repeat(64),
    bundle_sha256: "5".repeat(64), attestation_sha256: "6".repeat(64),
    companions: [
      { path: "trust.bundle", sha256: "5".repeat(64) },
      { path: "trust.checkpoint.attestation.json", sha256: "6".repeat(64) },
      { path: "trust.checkpoint.intoto.json", sha256: "7".repeat(64) },
      { path: "trust.checkpoint.json", sha256: "4".repeat(64) },
    ],
    nonce: "fixture-nonce", requested_at: now.toISOString(), expires_at: new Date(now.getTime() + 60_000).toISOString(),
    signature: { algorithm: "ed25519", key_id: "fixture", value: "signature" }, ...overrides,
  };
}

test("provisional authorization validator rejects forged and wrong-session bindings", () => {
  const authorization = provisionalAuthorization();
  assert.equal(validateProvisionalDeliveryAuthorizationBinding(authorization, {
    project_root: "/project", run_id: "session-a", checkpoint_slug: "session-a",
    subject: "kontourai/flow-agents#957", work_item: "kontourai/flow-agents#957",
  }), authorization);
  assert.throws(() => validateProvisionalDeliveryAuthorizationBinding({ ...authorization, run_id: "session-b" }, {
    project_root: "/project", run_id: "session-a", checkpoint_slug: "session-a",
  }), /run_id does not match/);
  assert.throws(() => validateProvisionalDeliveryAuthorizationBinding({ ...authorization, companions: [...authorization.companions, { path: "extra", sha256: "8".repeat(64) }] }, {
    project_root: "/project", run_id: "session-a", checkpoint_slug: "session-a", companions: authorization.companions,
  }), /companions do not match/);
  assert.throws(() => validateProvisionalDeliveryAuthorizationBinding({ ...authorization, workspace_snapshot: { ...authorization.workspace_snapshot, worktree_clean: "true" } }, {
    project_root: "/project", run_id: "session-a", checkpoint_slug: "session-a",
  }), /workspace snapshot/);
  for (const length of [41, 63]) {
    assert.throws(() => validateProvisionalDeliveryAuthorizationBinding({ ...authorization, workspace_snapshot: { ...authorization.workspace_snapshot, head_sha: "a".repeat(length) } }, {
      project_root: "/project", run_id: "session-a", checkpoint_slug: "session-a",
    }), /workspace snapshot/, `workspace snapshot ${length}-character SHA must be rejected without an expected snapshot`);
  }
  assert.throws(() => validateProvisionalDeliveryAuthorizationBinding({ ...authorization, published_head_sha: "a".repeat(41) }, {
    project_root: "/project", run_id: "session-a", checkpoint_slug: "session-a",
  }), /published_head_sha is invalid/);
  assert.throws(() => validateProvisionalDeliveryAuthorizationBinding({ ...authorization, checkpoint_commit_sha: "a".repeat(63) }, {
    project_root: "/project", run_id: "session-a", checkpoint_slug: "session-a",
  }), /checkpoint_commit_sha is invalid/);
});

test("provisional coordinator snapshot includes cleanliness and rejects hidden index entries", () => {
  const executable = resolveProvisionalTrustedGitExecutable();
  assert.ok(path.isAbsolute(executable.path));
  assert.ok(["/usr/bin/git", "/run/current-system/sw/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git", "C:\\Program Files\\Git\\cmd\\git.exe"].includes(executable.candidate));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provisional-workspace-snapshot-"));
  try {
    fs.writeFileSync(path.join(root, "tracked.txt"), "clean\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "tracked.txt"], { cwd: root });
    execFileSync("git", ["-c", "user.email=fixture@example.invalid", "-c", "user.name=Fixture", "commit", "-qm", "fixture"], { cwd: root });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const clean = provisionalWorkspaceSnapshot(root, "session-a");
    assert.deepEqual(
      Object.keys(clean).sort(),
      ["algorithm", "digest", "head_sha", "kind", "version", "worktree_clean"],
      "the coordinator signs the complete canonical snapshot shape",
    );
    assert.equal(clean.head_sha, head);
    assert.equal(clean.worktree_clean, true);
    assert.deepEqual(clean, captureReviewWorkspaceSnapshot(root, [], ["delivery/session-a"]), "the privileged coordinator uses the exact canonical snapshot representation");

    fs.writeFileSync(path.join(root, "untracked.txt"), "dirty\n");
    assert.equal(provisionalWorkspaceSnapshot(root, "session-a").worktree_clean, false);
    fs.unlinkSync(path.join(root, "untracked.txt"));
    execFileSync("git", ["update-index", "--assume-unchanged", "tracked.txt"], { cwd: root });
    assert.throws(() => provisionalWorkspaceSnapshot(root, "session-a"), /nonordinary ls-files tag/);
    execFileSync("git", ["update-index", "--no-assume-unchanged", "tracked.txt"], { cwd: root });
    for (const mutation of [
      { label: "tracked", apply() { fs.appendFileSync(path.join(root, "tracked.txt"), "mutation\n"); } },
      { label: "untracked", apply() { fs.writeFileSync(path.join(root, "arrived.txt"), "mutation\n"); } },
    ]) {
      assert.throws(
        () => provisionalWorkspaceSnapshot(root, "session-a", { afterInitialInputsRead: mutation.apply }),
        /workspace inputs changed/,
        `${mutation.label} mutation after the first read must reject the authorization snapshot`,
      );
      if (mutation.label === "tracked") execFileSync("git", ["checkout", "--", "tracked.txt"], { cwd: root });
      else fs.unlinkSync(path.join(root, "arrived.txt"));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("provisional authority ledger rejects forged signatures and broken predecessor chains", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provisional-ledger-"));
  const sessionDir = path.join(root, ".kontourai", "flow-agents", "session-a");
  fs.mkdirSync(sessionDir, { recursive: true });
  const keys = generateKeyPairSync("ed25519");
  const registry = path.join(root, "keys.json");
  fs.writeFileSync(registry, JSON.stringify({ schema_version: "1.0", keys: [{ id: "fixture", algorithm: "ed25519", public_key_pem: keys.publicKey.export({ type: "spki", format: "pem" }) }] }), { mode: 0o600 });
  const loaded = await loadProtectedReadFromCoordinator({ registryFile: registry });
  const unsignedAuthorization = provisionalAuthorization({ project_root: root });
  delete unsignedAuthorization.signature;
  const authorization = { ...unsignedAuthorization, signature: { algorithm: "ed25519", key_id: "fixture", value: sign(null, Buffer.from(JSON.stringify(unsignedAuthorization)), keys.privateKey).toString("base64") } };
  const eventUnsigned = { schema_version: "1.0", kind: "kontourai.lifecycle-authority.provisional-delivery-event", run_id: "session-a", subject: authorization.subject, authorization_sha256: loaded.sha256(loaded.canonicalJson(authorization)), predecessor_hash: "0".repeat(64), signed_authorization: authorization };
  const event = { ...eventUnsigned, event_hash: loaded.sha256(eventUnsigned) };
  const ledger = path.join(sessionDir, "lifecycle-authority.provisional-delivery-events.json");
  fs.writeFileSync(ledger, JSON.stringify({ schema_version: "1.0", events: [event] }), { mode: 0o600 });
  assert.equal(loaded.loadProvisionalDeliveryLedger({ projectRoot: root, sessionDir, runId: "session-a" }).value.events.length, 1);
  fs.writeFileSync(ledger, JSON.stringify({ schema_version: "1.0", events: [event, { ...event, predecessor_hash: "f".repeat(64) }] }), { mode: 0o600 });
  assert.throws(() => loaded.loadProvisionalDeliveryLedger({ projectRoot: root, sessionDir, runId: "session-a" }), /binding|hash chain/);
  fs.writeFileSync(ledger, JSON.stringify({ schema_version: "1.0", events: [{ ...event, signed_authorization: { ...authorization, signature: { ...authorization.signature, value: Buffer.alloc(64).toString("base64") } } }] }), { mode: 0o600 });
  assert.throws(() => loaded.loadProvisionalDeliveryLedger({ projectRoot: root, sessionDir, runId: "session-a" }), /event binding|authorization digest|signature/);
});

test("prepared provisional recovery accepts only the exact authorization at the validated ledger tail", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provisional-prepared-tail-"));
  const sessionDir = path.join(root, ".kontourai", "flow-agents", "session-a");
  fs.mkdirSync(sessionDir, { recursive: true });
  const keys = generateKeyPairSync("ed25519");
  const registry = path.join(root, "keys.json");
  fs.writeFileSync(registry, JSON.stringify({ schema_version: "1.0", keys: [{ id: "fixture", algorithm: "ed25519", public_key_pem: keys.publicKey.export({ type: "spki", format: "pem" }) }] }), { mode: 0o600 });
  const loaded = await loadProtectedReadFromCoordinator({ registryFile: registry });
  const signedAuthorization = (nonce) => {
    const unsigned = provisionalAuthorization({ project_root: root, nonce });
    delete unsigned.signature;
    return { ...unsigned, signature: { algorithm: "ed25519", key_id: "fixture", value: sign(null, Buffer.from(JSON.stringify(unsigned)), keys.privateKey).toString("base64") } };
  };
  const event = (authorization, predecessorHash) => {
    const unsigned = {
      schema_version: "1.0",
      kind: "kontourai.lifecycle-authority.provisional-delivery-event",
      run_id: "session-a",
      subject: authorization.subject,
      authorization_sha256: loaded.sha256(loaded.canonicalJson(authorization)),
      predecessor_hash: predecessorHash,
      signed_authorization: authorization,
    };
    return { ...unsigned, event_hash: loaded.sha256(unsigned) };
  };
  const firstAuthorization = signedAuthorization("prepared-first");
  const secondAuthorization = signedAuthorization("prepared-second");
  const firstEvent = event(firstAuthorization, "0".repeat(64));
  const secondEvent = event(secondAuthorization, firstEvent.event_hash);
  const ledgerFile = path.join(sessionDir, "lifecycle-authority.provisional-delivery-events.json");
  fs.writeFileSync(ledgerFile, JSON.stringify({ schema_version: "1.0", events: [firstEvent, secondEvent] }), { mode: 0o600 });
  const events = loaded.loadProvisionalDeliveryLedger({ projectRoot: root, sessionDir, runId: "session-a" }).value.events;

  assert.deepEqual(loaded.recoverPreparedProvisionalDeliveryEvent(events, secondAuthorization), secondEvent);
  assert.throws(
    () => loaded.recoverPreparedProvisionalDeliveryEvent(events, firstAuthorization),
    /already present before the durable ledger tail/,
  );
});

test("signed provisional authority event installs an exact durable coordinator completion receipt", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provisional-completion-e2e-"));
  const sessionDir = path.join(root, ".kontourai", "flow-agents", "session-a");
  fs.mkdirSync(sessionDir, { recursive: true });
  const operatorKeys = generateKeyPairSync("ed25519");
  const completionKeys = generateKeyPairSync("ed25519");
  const registry = path.join(root, "keys.json");
  const completionPublic = path.join(root, "completion-public.pem");
  fs.writeFileSync(registry, JSON.stringify({ schema_version: "1.0", keys: [{ id: "fixture", algorithm: "ed25519", public_key_pem: operatorKeys.publicKey.export({ type: "spki", format: "pem" }) }] }), { mode: 0o600 });
  fs.writeFileSync(completionPublic, completionKeys.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
  const loaded = await loadProtectedReadFromCoordinator({ registryFile: registry, completionKeyFile: completionPublic });
  const unsignedAuthorization = provisionalAuthorization({ project_root: root });
  delete unsignedAuthorization.signature;
  const authorization = { ...unsignedAuthorization, signature: { algorithm: "ed25519", key_id: "fixture", value: sign(null, Buffer.from(JSON.stringify(unsignedAuthorization)), operatorKeys.privateKey).toString("base64") } };
  const eventUnsigned = { schema_version: "1.0", kind: "kontourai.lifecycle-authority.provisional-delivery-event", run_id: "session-a", subject: authorization.subject, authorization_sha256: loaded.sha256(loaded.canonicalJson(authorization)), predecessor_hash: "0".repeat(64), signed_authorization: authorization };
  const event = { ...eventUnsigned, event_hash: loaded.sha256(eventUnsigned) };
  fs.writeFileSync(path.join(sessionDir, "lifecycle-authority.provisional-delivery-events.json"), JSON.stringify({ schema_version: "1.0", events: [event] }), { mode: 0o600 });
  const completionUnsigned = { schema_version: "1.0", kind: "kontourai.lifecycle-authority.completion", action: "publish-provisional-delivery", request_sha256: "c".repeat(64), run_id: "session-a", operation_status: "applied", result_core_sha256: loaded.sha256(event), coordinator_runtime_sha256: "d".repeat(64), completed_at: new Date().toISOString() };
  const completion = { ...completionUnsigned, signature: { algorithm: "ed25519", value: sign(null, Buffer.from(loaded.canonicalJson(completionUnsigned)), completionKeys.privateKey).toString("base64") } };
  assert.deepEqual(loaded.installCompletionReceipt({ projectRoot: root, sessionDir, runId: "session-a" }, completion), { run_id: "session-a", receipt: "written" });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sessionDir, "provisional-delivery.authority-completion.json"), "utf8")), completion);
});

test("provisional completion receipt rotates only to the validated ledger tail and recovers atomic replacement crashes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provisional-completion-generations-"));
  const sessionDir = path.join(root, ".kontourai", "flow-agents", "session-a");
  fs.mkdirSync(sessionDir, { recursive: true });
  const operatorKeys = generateKeyPairSync("ed25519");
  const completionKeys = generateKeyPairSync("ed25519");
  const registry = path.join(root, "keys.json");
  const completionPublic = path.join(root, "completion-public.pem");
  fs.writeFileSync(registry, JSON.stringify({ schema_version: "1.0", keys: [{ id: "fixture", algorithm: "ed25519", public_key_pem: operatorKeys.publicKey.export({ type: "spki", format: "pem" }) }] }), { mode: 0o600 });
  fs.writeFileSync(completionPublic, completionKeys.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
  const loaded = await loadProtectedReadFromCoordinator({ registryFile: registry, completionKeyFile: completionPublic });
  const signAuthorization = (nonce) => {
    const unsigned = provisionalAuthorization({ project_root: root, nonce });
    delete unsigned.signature;
    return { ...unsigned, signature: { algorithm: "ed25519", key_id: "fixture", value: sign(null, Buffer.from(JSON.stringify(unsigned)), operatorKeys.privateKey).toString("base64") } };
  };
  const eventFor = (authorization, predecessorHash) => {
    const unsigned = {
      schema_version: "1.0",
      kind: "kontourai.lifecycle-authority.provisional-delivery-event",
      run_id: "session-a",
      subject: authorization.subject,
      authorization_sha256: loaded.sha256(loaded.canonicalJson(authorization)),
      predecessor_hash: predecessorHash,
      signed_authorization: authorization,
    };
    return { ...unsigned, event_hash: loaded.sha256(unsigned) };
  };
  const completionFor = (event, requestSha256) => {
    const unsigned = {
      schema_version: "1.0",
      kind: "kontourai.lifecycle-authority.completion",
      action: "publish-provisional-delivery",
      request_sha256: requestSha256,
      run_id: "session-a",
      operation_status: "applied",
      result_core_sha256: loaded.sha256(event),
      coordinator_runtime_sha256: "d".repeat(64),
      completed_at: new Date().toISOString(),
    };
    return { ...unsigned, signature: { algorithm: "ed25519", value: sign(null, Buffer.from(loaded.canonicalJson(unsigned)), completionKeys.privateKey).toString("base64") } };
  };
  const firstEvent = eventFor(signAuthorization("generation-one"), "0".repeat(64));
  const secondEvent = eventFor(signAuthorization("generation-two"), firstEvent.event_hash);
  const firstCompletion = completionFor(firstEvent, "1".repeat(64));
  const secondCompletion = completionFor(secondEvent, "2".repeat(64));
  const ledgerFile = path.join(sessionDir, "lifecycle-authority.provisional-delivery-events.json");
  const receiptFile = path.join(sessionDir, "provisional-delivery.authority-completion.json");
  const paths = { projectRoot: root, sessionDir, runId: "session-a" };

  fs.writeFileSync(ledgerFile, JSON.stringify({ schema_version: "1.0", events: [firstEvent] }), { mode: 0o600 });
  assert.deepEqual(loaded.installCompletionReceipt(paths, firstCompletion), { run_id: "session-a", receipt: "written" });
  assert.deepEqual(loaded.installCompletionReceipt(paths, firstCompletion), { run_id: "session-a", receipt: "present" }, "first generation replay is idempotent");

  fs.writeFileSync(ledgerFile, JSON.stringify({ schema_version: "1.0", events: [firstEvent, secondEvent] }), { mode: 0o600 });
  assert.deepEqual(loaded.installCompletionReceipt(paths, secondCompletion), { run_id: "session-a", receipt: "replaced" });
  assert.deepEqual(loaded.installCompletionReceipt(paths, secondCompletion), { run_id: "session-a", receipt: "present" }, "second generation replay is idempotent");
  assert.deepEqual(loaded.installCompletionReceipt(paths, firstCompletion), { run_id: "session-a", receipt: "preserved" }, "old generation replay cannot replace the current tail receipt");
  assert.deepEqual(JSON.parse(fs.readFileSync(receiptFile, "utf8")), secondCompletion);

  fs.writeFileSync(receiptFile, `${JSON.stringify(firstCompletion)}\n`);
  assert.throws(
    () => loaded.installCompletionReceipt(paths, secondCompletion, { beforeRename: () => { throw new Error("injected before-receipt-rename crash"); } }),
    /before-receipt-rename crash/,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(receiptFile, "utf8")), firstCompletion, "a pre-rename crash preserves the prior generation");
  assert.deepEqual(loaded.installCompletionReceipt(paths, secondCompletion), { run_id: "session-a", receipt: "replaced" });

  fs.writeFileSync(receiptFile, `${JSON.stringify(firstCompletion)}\n`);
  assert.throws(
    () => loaded.installCompletionReceipt(paths, secondCompletion, { afterRename: () => { throw new Error("injected after-receipt-rename crash"); } }),
    /after-receipt-rename crash/,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(receiptFile, "utf8")), secondCompletion, "a post-rename crash leaves the complete new generation");
  assert.deepEqual(loaded.installCompletionReceipt(paths, secondCompletion), { run_id: "session-a", receipt: "present" });
});

test("root coordinator transport validation rejects non-exact companion sets before ledger mutation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provisional-companion-validation-"));
  const sessionDir = path.join(root, ".kontourai", "flow-agents", "session-a");
  const destination = path.join(root, "delivery", "session-a");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(destination, { recursive: true });
  const loaded = await loadProtectedReadFromCoordinator();
  const coordinatorSource = fs.readFileSync(COORDINATOR, "utf8");
  const provisionalPreparation = coordinatorSource.slice(
    coordinatorSource.indexOf("async function prepareProvisionalDeliveryMutation"),
    coordinatorSource.indexOf("async function appendOrRecoverProvisionalDeliveryEvent"),
  );
  assert.ok(
    provisionalPreparation.indexOf("assertProvisionalCheckpoint(paths, authorization, destination, expected)")
      < provisionalPreparation.indexOf("loadProvisionalDeliveryLedger(paths)"),
    "the root-authenticated coordinator worker validates the exact transport before opening the durable ledger for append",
  );
  const checkpointValidation = coordinatorSource.slice(
    coordinatorSource.indexOf("function assertProvisionalCheckpoint"),
    coordinatorSource.indexOf("function assertProvisionalAuthorizationShape"),
  );
  assert.match(checkpointValidation, /validateProvisionalDeliveryTransport\(destination, expected\)/);
  const ledgerFile = path.join(sessionDir, "lifecycle-authority.provisional-delivery-events.json");
  const ledgerBytes = Buffer.from('{"schema_version":"1.0","events":[]}\n');
  fs.writeFileSync(ledgerFile, ledgerBytes);
  const writeTransport = (attestation = { status: "unsigned", path: "trust.checkpoint.intoto.json" }, extras = {}) => {
    fs.rmSync(destination, { recursive: true, force: true });
    fs.mkdirSync(destination, { recursive: true });
    const files = {
      "trust.bundle": "{}\n",
      "trust.checkpoint.json": "{}\n",
      "trust.checkpoint.attestation.json": `${JSON.stringify(attestation)}\n`,
      "trust.checkpoint.intoto.json": "{}\n",
      ...extras,
    };
    for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(destination, name), bytes);
    return Object.keys(files).sort().map((name) => ({ path: name, sha256: loaded.sha256(fs.readFileSync(path.join(destination, name))) }));
  };
  const cases = [
    ["unsigned extra", () => writeTransport(undefined, { "extra.json": "{}\n" }), /exactly four|unsigned extra/],
    ["both signature forms", () => writeTransport(undefined, { "trust.checkpoint.sig.json": "{}\n" }), /exactly four|one signature or in-toto/],
    ["duplicate identity", () => {
      const expected = writeTransport();
      return [expected[0], expected[0], expected[1], expected[2]];
    }, /companions are invalid|exact/],
    ["alternate companion", () => {
      const expected = writeTransport(undefined, { "trust.checkpoint.other.json": "{}\n" })
        .filter((entry) => entry.path !== "trust.checkpoint.intoto.json");
      fs.rmSync(path.join(destination, "trust.checkpoint.intoto.json"));
      return expected;
    }, /one signature or in-toto/],
    ["attestation mismatch", () => writeTransport({ status: "signed", path: "trust.checkpoint.sig.json" }), /does not declare the exact authorized companion/],
  ];
  for (const [label, fixture, error] of cases) {
    const expected = fixture();
    assert.throws(() => loaded.validateProvisionalDeliveryTransport(destination, expected), error, label);
    assert.equal(fs.readFileSync(ledgerFile).equals(ledgerBytes), true, `${label} must not mutate the durable authority ledger`);
  }
});

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
    subjectId: "work-item:ledger-test",
    subjectType: "work-item",
    claimType: "workflow.review.critique",
    fieldOrBehavior: `Review critique ${id}`,
    value: verdict,
    impactLevel: "high",
    status: "verified",
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
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

/**
 * This is deliberately a non-Docker install-shaped fixture.  It runs the
 * coordinator's root entry point and its separately spawned mutation workers
 * against a copied, pinned reducer closure.  The production installer is not
 * involved and neither /etc nor /var nor an installed helper are touched.
 */
function copyPinnedFlowClosure(installRoot) {
  const sourceModules = path.resolve("node_modules");
  const targetModules = path.join(installRoot, "flow-reducer", "node_modules");
  const copied = new Set();
  const copyPackage = (name) => {
    if (copied.has(name)) return;
    copied.add(name);
    const source = path.join(sourceModules, name);
    const target = path.join(targetModules, name);
    const metadata = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true, dereference: true });
    for (const dependency of Object.keys(metadata.dependencies ?? {})) copyPackage(dependency);
  };
  copyPackage("@kontourai/flow");
  fs.copyFileSync("packaging/lifecycle-authority/flow-reducer-v1.json", path.join(installRoot, "flow-reducer-v1.json"));
}

async function createHermeticRecoveryFixture(runId = "exact-current-recovery") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-exact-current-e2e-"));
  let projectRoot = path.join(root, "project");
  const installRoot = path.join(root, "installed");
  const configRoot = path.join(root, "operator-config");
  const stateRoot = path.join(root, "operator-state");
  const sessionDir = path.join(projectRoot, ".kontourai", "flow-agents", runId);
  const subject = "kontourai/flow-agents#944";
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o755 });
  fs.mkdirSync(configRoot, { recursive: true, mode: 0o755 });
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  copyPinnedFlowClosure(installRoot);

  const { privateKey: operatorPrivate, publicKey: operatorPublic } = generateKeyPairSync("ed25519");
  const { privateKey: historyPrivate, publicKey: historyPublic } = generateKeyPairSync("ed25519");
  const { privateKey: completionPrivate, publicKey: completionPublic } = generateKeyPairSync("ed25519");
  const pem = (key, type) => key.export({ type, format: "pem" });
  fs.writeFileSync(path.join(configRoot, "keys.json"), `${JSON.stringify({ schema_version: "1.0", keys: [
    { id: "fixture-operator", algorithm: "ed25519", public_key_pem: pem(operatorPublic, "spki") },
    { id: "test-key", algorithm: "ed25519", public_key_pem: pem(historyPublic, "spki") },
  ] })}\n`, { mode: 0o644 });
  fs.writeFileSync(path.join(configRoot, "completion-signing-key.pem"), pem(completionPrivate, "pkcs8"), { mode: 0o600 });
  fs.writeFileSync(path.join(configRoot, "completion-verification-key.pem"), pem(completionPublic, "spki"), { mode: 0o644 });

  let coordinatorSource = fs.readFileSync(COORDINATOR, "utf8");
  coordinatorSource = coordinatorSource
    .replace(/export const CONFIG_ROOT = .*?;/, `export const CONFIG_ROOT = ${JSON.stringify(configRoot)};`)
    .replace(/export const STATE_ROOT = .*?;/, `export const STATE_ROOT = ${JSON.stringify(stateRoot)};`);
  coordinatorSource += "\nexport { prepareExactCurrentRecoveryPublication, publishExactCurrentRecoveryPublication, recoverExactCurrentRecoveryPublication, finalizeExactCurrentRecoveryPublication, finalizeVerificationResealFence, signedCapability };\n";
  fs.writeFileSync(path.join(installRoot, "runtime-v1.mjs"), fs.readFileSync(RUNTIME), { mode: 0o644 });
  fs.writeFileSync(path.join(installRoot, "coordinator.mjs"), coordinatorSource, { mode: 0o755 });
  const coordinator = await import(`${pathToFileURL(path.join(installRoot, "coordinator.mjs")).href}?fixture=${Date.now()}-${Math.random()}`);

  await startRun(path.resolve("kits/builder/flows/build.flow.json"), { cwd: projectRoot, runId, params: { subject } });
  // Darwin resolves /var through /private/var; the coordinator intentionally
  // binds the real canonical root, so the signed fixture must do the same.
  projectRoot = fs.realpathSync(projectRoot);
  const flowRoot = path.join(projectRoot, ".kontourai", "flow", "runs", runId);
  const flowStateFile = path.join(flowRoot, "state.json");
  const flowState = JSON.parse(fs.readFileSync(flowStateFile, "utf8"));
  flowState.current_step = "verify";
  flowState.next_action = "attach verify gate evidence";
  fs.writeFileSync(flowStateFile, `${JSON.stringify(flowState, null, 2)}\n`, { mode: 0o644 });
  fs.writeFileSync(path.join(sessionDir, "state.json"), `${JSON.stringify({ schema_version: "1.0", task_slug: runId, status: "verifying", phase: "verification", updated_at: new Date().toISOString(), work_item_refs: [subject], next_action: { status: "continue", summary: "Hermetic coordinator fixture." } }, null, 2)}\n`, { mode: 0o644 });

  const seed = { schemaVersion: 5, source: "lifecycle-authority-test", claims: [], evidence: [], policies: [], events: [] };
  const prior = critiqueClaim("fixture-prior", "1".repeat(64), 1, "0".repeat(64), "fixture-reviewer-a", "fail", "fail", "open");
  const resolving = structuredClone(prior);
  prior.id = "fixture-prior-critique";
  prior.value = "fail";
  prior.status = "verified";
  prior.metadata = { ...prior.metadata, critique_record_id: "fixture-prior", critique_record_hash: "1".repeat(64), critique_sequence: 1, critique_predecessor_hash: "0".repeat(64), reviewer: "fixture-reviewer-a", reviewed_at: "2026-07-24T00:00:00.000Z", workflow_subject_ref: subject, lanes: [{ id: "fixture", status: "fail" }], findings: [{ id: "fixture-finding", status: "open" }], review_target: { workspace_snapshot: { digest: "2".repeat(64), head_sha: "none" } } };
  resolving.id = "fixture-resolving-critique";
  resolving.value = "pass";
  resolving.status = "verified";
  resolving.metadata = { ...prior.metadata, critique_record_id: "fixture-resolving", critique_record_hash: "3".repeat(64), critique_sequence: 2, critique_predecessor_hash: prior.metadata.critique_record_hash, reviewer: "fixture-reviewer-b", reviewed_at: "2026-07-24T00:01:00.000Z", lanes: [{ id: "fixture", status: "pass" }], findings: [{ id: "fixture-finding", status: "fixed" }], review_target: { workspace_snapshot: { digest: "4".repeat(64), head_sha: "none" } } };
  const resolutionAuthorization = {
    schema_version: "1.0", operation: "resolve-critique", project_root: projectRoot, run_id: runId, subject,
    prior_record_id: prior.metadata.critique_record_id, prior_record_hash: prior.metadata.critique_record_hash,
    resolving_record_id: resolving.metadata.critique_record_id, resolving_record_hash: resolving.metadata.critique_record_hash,
    expected_resolver: resolving.metadata.reviewer, resolved_lane_ids: ["fixture"], resolved_finding_ids: ["fixture-finding"],
    prior_snapshot_sha256: prior.metadata.review_target.workspace_snapshot.digest, resolving_snapshot_sha256: resolving.metadata.review_target.workspace_snapshot.digest,
    prior_head_sha: "none", resolving_head_sha: "none", prior_bundle_sha256: "0".repeat(64), requested_at: "2026-07-24T00:00:00.000Z", nonce: "fixture-resolution", signature: { algorithm: "ed25519", key_id: "fixture-operator", value: "unused" },
  };
  const historical = resolveCritiqueTransition({ bundle: { ...seed, claims: [...seed.claims, prior, resolving] }, resolution_events: [], authorization: resolutionAuthorization, prior_record_id: prior.metadata.critique_record_id, resolving_record_id: resolving.metadata.critique_record_id });
  const signedEvent = resignHistoricalEvent(structuredClone(historical.resolution_events[0]), historical.bundle, historyPrivate);
  const priorWithEdge = historical.bundle.claims.find((claim) => claim.id === prior.id);
  priorWithEdge.metadata.critique_resolution = signedEvent.edge;
  const later = structuredClone(resolving);
  later.id = "fixture-later-critique";
  later.metadata = { ...later.metadata, critique_record_id: "fixture-later", critique_record_hash: "5".repeat(64), critique_sequence: 3, critique_predecessor_hash: resolving.metadata.critique_record_hash, reviewer: "fixture-reviewer-c", reviewed_at: "2026-07-24T00:02:00.000Z" };
  later.fieldOrBehavior = "Legitimate later final review makes the prior completion stale.";
  const currentBundle = { ...historical.bundle, claims: [...historical.bundle.claims, later] };
  const ledger = { schema_version: "1.0", events: [signedEvent] };
  const bundleFile = path.join(sessionDir, "trust.bundle");
  const ledgerFile = path.join(sessionDir, "lifecycle-authority.resolution-events.json");
  fs.writeFileSync(bundleFile, `${JSON.stringify(currentBundle, null, 2)}\n`, { mode: 0o644 });
  fs.writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o644 });

  const signCompletion = (unsigned) => ({ ...unsigned, signature: { algorithm: "ed25519", value: sign(null, Buffer.from(coordinator.canonicalJson(unsigned)), completionPrivate).toString("base64") } });
  const staleCore = coordinator.sha256({ ...historical.bundle, critique_resolution_events: [signedEvent] });
  const stale = signCompletion({ schema_version: "1.0", kind: "kontourai.lifecycle-authority.completion", action: "resolve-critique", request_sha256: "6".repeat(64), run_id: runId, operation_status: "applied", result_core_sha256: staleCore, coordinator_runtime_sha256: coordinatorRuntimeSha256(), completed_at: "2026-07-24T00:03:00.000Z" });
  const completionFile = path.join(sessionDir, "lifecycle-authority.completion.json");
  fs.writeFileSync(completionFile, `${JSON.stringify(stale)}\n`, { mode: 0o644 });
  const bundleBytes = fs.readFileSync(bundleFile), ledgerBytes = fs.readFileSync(ledgerFile), completionBytes = fs.readFileSync(completionFile);
  const definitionBytes = fs.readFileSync(path.join(flowRoot, "definition.json"));
  const manifestBytes = fs.readFileSync(path.join(flowRoot, "evidence", "manifest.json"));
  const definition = JSON.parse(definitionBytes);
  const gate = definition.gates["verify-gate"];
  const critique = critiqueHistoryProjectionSummary(currentBundle.claims);
  const edges = critiqueResolutionEdgeProjectionSummary(currentBundle.claims);
  const now = new Date();
  const unsigned = {
    schema_version: "1.0", operation: "recover-exact-current-completion", project_root: projectRoot, run_id: runId, subject, permitted_transition: "exact-current-completion-only",
    stale_completion_sha256: rawSha256(completionBytes), stale_completion_action: stale.action, stale_completion_request_sha256: stale.request_sha256, stale_completion_result_core_sha256: stale.result_core_sha256, stale_completion_coordinator_runtime_sha256: stale.coordinator_runtime_sha256,
    current_bundle_sha256: rawSha256(bundleBytes), current_ledger_sha256: rawSha256(ledgerBytes), current_ledger_length: ledger.events.length, current_ledger_tail_hash: signedEvent.event_hash,
    critique_projection_sha256: critique.digest, resolution_edge_projection_sha256: edges.digest, resolution_edge_projection_count: edges.count,
    flow_definition_id: "builder.build", flow_definition_sha256: rawSha256(definitionBytes), flow_step_id: "verify", flow_gate_id: "verify-gate", flow_gate_policy_sha256: coordinator.sha256(coordinator.canonicalJson({ gate_id: "verify-gate", requirements: gate.expects })), flow_run_head: (await import(pathToFileURL(path.join(installRoot, "flow-reducer", "node_modules", "@kontourai", "flow", "dist", "index.js")).href)).flowRunHead(flowState), flow_manifest_sha256: rawSha256(manifestBytes),
    nonce: `fixture-${runId}`, requested_at: now.toISOString(), expires_at: new Date(now.getTime() + 3_600_000).toISOString(),
  };
  const authorization = { ...unsigned, signature: { algorithm: "ed25519", key_id: "fixture-operator", value: sign(null, Buffer.from(JSON.stringify(unsigned)), operatorPrivate).toString("base64") } };
  const authorizationFile = path.join(root, "authorization.json");
  fs.writeFileSync(authorizationFile, `${JSON.stringify(authorization)}\n`, { mode: 0o600 });
  const request = { action: "recover-exact-current-completion", project_root: projectRoot, session_dir: sessionDir, authorization_file: authorizationFile };
  const envelope = { schema_version: "1.0", action: request.action, request_sha256: coordinator.sha256(request), request };
  return { root, coordinator, projectRoot, sessionDir, flowRoot, stateRoot, bundleFile, ledgerFile, completionFile, bundleBytes, ledgerBytes, completionBytes, authorization, authorizationFile, envelope, operatorPrivate, signCompletion, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

async function invokeHermeticCoordinator(fixture) {
  const previousUid = process.env.SUDO_UID, previousGid = process.env.SUDO_GID;
  process.env.SUDO_UID = String(process.getuid());
  process.env.SUDO_GID = String(process.getgid());
  try { return await fixture.coordinator.main(`${JSON.stringify(fixture.envelope)}\n`); }
  finally {
    if (previousUid === undefined) delete process.env.SUDO_UID; else process.env.SUDO_UID = previousUid;
    if (previousGid === undefined) delete process.env.SUDO_GID; else process.env.SUDO_GID = previousGid;
  }
}

test("hermetic privileged coordinator recovers a stale completion without rewriting evidence and replays exactly", async () => {
  const fixture = await createHermeticRecoveryFixture();
  try {
    const applied = await invokeHermeticCoordinator(fixture);
    assert.equal(applied.result.operation_status, "applied");
    assert.equal(applied.result.completion.action, "recover-exact-current-completion");
    assert.equal(fs.readFileSync(fixture.bundleFile).compare(fixture.bundleBytes), 0, "recovery must retain exact trust.bundle bytes");
    assert.equal(fs.readFileSync(fixture.ledgerFile).compare(fixture.ledgerBytes), 0, "recovery must retain exact ledger bytes");
    const manifest = JSON.parse(fs.readFileSync(path.join(fixture.flowRoot, "evidence", "manifest.json"), "utf8"));
    const attachmentId = `lifecycle-authority:${fixture.envelope.request_sha256}:${fixture.coordinator.sha256(fixture.coordinator.canonicalJson(fixture.authorization))}`;
    assert.equal(manifest.evidence.filter((entry) => entry.id === attachmentId).length, 1, "one request-keyed canonical attachment is published");
    const receipt = JSON.parse(fs.readFileSync(fixture.completionFile, "utf8"));
    assert.equal(receipt.result_core_sha256, fixture.coordinator.sha256({ ...JSON.parse(fixture.bundleBytes), critique_resolution_events: JSON.parse(fixture.ledgerBytes).events }));
    const durableBefore = fs.readdirSync(path.join(fixture.stateRoot, "completions")).sort();
    const replay = await invokeHermeticCoordinator(fixture);
    assert.equal(replay.result.operation_status, "replayed");
    assert.deepEqual(replay.result.completion, applied.result.completion, "exact request reuses immutable completion");
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.flowRoot, "evidence", "manifest.json"), "utf8")).evidence.filter((entry) => entry.id === attachmentId).length, 1, "replay adds no duplicate attachment");
    assert.deepEqual(fs.readdirSync(path.join(fixture.stateRoot, "completions")).sort(), durableBefore, "replay adds no durable completion");
  } finally { fixture.cleanup(); }
});

for (const [label, crashAfter] of [["first Flow postimage", 1], ["all Flow postimages before root completion", EXACT_CURRENT_RECOVERY_ARTIFACT_IDS.length]]) {
  test(`exact-current recovery prepared retry converges after a crash following ${label}`, async () => {
    const fixture = await createHermeticRecoveryFixture(`crash-${crashAfter}`);
    try {
      const paths = { projectRoot: fixture.projectRoot, sessionDir: fixture.sessionDir, runId: `crash-${crashAfter}` };
      const prepared = await fixture.coordinator.prepareExactCurrentRecoveryPublication(fixture.envelope, paths, fixture.authorization);
      const capability = fixture.coordinator.signedCapability("exact-current-recovery-plan-capability", {
        request: fixture.envelope.request,
        plan: prepared.plan,
      });
      const binding = {
        request_sha256: fixture.envelope.request_sha256,
        authorization_sha256: fixture.coordinator.sha256(fixture.coordinator.canonicalJson(fixture.authorization)),
      };
      await assert.rejects(
        fixture.coordinator.publishExactCurrentRecoveryPublication(paths, capability, binding, {
          async after_write({ writes }) {
            if (writes === crashAfter) throw new Error(`injected crash after ${crashAfter} Flow postimages`);
          },
        }),
        /injected crash/,
      );
      assert.ok(fs.existsSync(path.join(fixture.sessionDir, ".exact-current-recovery.transaction.json")), "signed plan is durable before any crashable Flow write");
      assert.deepEqual(fs.readFileSync(fixture.bundleFile), fixture.bundleBytes, "crash never rewrites trust.bundle");
      assert.deepEqual(fs.readFileSync(fixture.ledgerFile), fixture.ledgerBytes, "crash never rewrites the resolution ledger");
      assert.deepEqual(fs.readFileSync(fixture.completionFile), fixture.completionBytes, "crash never rewrites the stale receipt");
      const recovered = await fixture.coordinator.recoverExactCurrentRecoveryPublication(paths, binding);
      assert.equal(recovered.state, "new");
      assert.equal(recovered.result_core_sha256, prepared.plan.result_core_sha256);
      assert.equal(fixture.coordinator.classifyExactCurrentRecoveryArtifacts(paths, prepared.plan), "new");
    } finally { fixture.cleanup(); }
  });
}

test("exact-current recovery fence rejects a normal Flow writer until exact finalization opens it", async () => {
  const fixture = await createHermeticRecoveryFixture("recovery-fence");
  try {
    const paths = { projectRoot: fixture.projectRoot, sessionDir: fixture.sessionDir, runId: "recovery-fence" };
    const prepared = await fixture.coordinator.prepareExactCurrentRecoveryPublication(fixture.envelope, paths, fixture.authorization);
    const capability = fixture.coordinator.signedCapability("exact-current-recovery-plan-capability", {
      request: fixture.envelope.request,
      plan: prepared.plan,
    });
    const binding = {
      request_sha256: fixture.envelope.request_sha256,
      authorization_sha256: fixture.coordinator.sha256(fixture.coordinator.canonicalJson(fixture.authorization)),
    };
    await fixture.coordinator.publishExactCurrentRecoveryPublication(paths, capability, binding);
    await assert.rejects(
      pauseRun(paths.runId, {
        cwd: paths.projectRoot,
        reason: "must wait for recovery finalization",
        authority: { kind: "operator_request", actor: "fence-test", request_ref: "test:recovery-fence", requested_at: "2026-07-24T00:10:00.000Z" },
        at: "2026-07-24T00:10:01.000Z",
      }),
      /recovery fence|recovery.*active/i,
    );
    const completion = fixture.signCompletion({
      schema_version: "1.0",
      kind: "kontourai.lifecycle-authority.completion",
      action: "recover-exact-current-completion",
      request_sha256: prepared.plan.request_sha256,
      run_id: paths.runId,
      operation_status: "applied",
      result_core_sha256: prepared.plan.result_core_sha256,
      coordinator_runtime_sha256: coordinatorRuntimeSha256(),
      completed_at: "2026-07-24T00:10:02.000Z",
    });
    fs.writeFileSync(fixture.completionFile, `${JSON.stringify(completion)}\n`, { mode: 0o644 });
    const finalized = await fixture.coordinator.finalizeExactCurrentRecoveryPublication(paths, completion);
    assert.equal(finalized.finalized, true);
    await pauseRun(paths.runId, {
      cwd: paths.projectRoot,
      reason: "recovery finalized",
      authority: { kind: "operator_request", actor: "fence-test", request_ref: "test:recovery-open", requested_at: "2026-07-24T00:10:03.000Z" },
      at: "2026-07-24T00:10:04.000Z",
    });
    assert.equal((await loadRun(paths.runId, paths.projectRoot)).state.status, "paused");
  } finally { fixture.cleanup(); }
});

test("exact-current cleanup replay preserves a legitimate Flow write after its matching fence was finalized", async () => {
  const fixture = await createHermeticRecoveryFixture("recovery-cleanup-replay");
  try {
    const paths = { projectRoot: fixture.projectRoot, sessionDir: fixture.sessionDir, runId: "recovery-cleanup-replay" };
    const prepared = await fixture.coordinator.prepareExactCurrentRecoveryPublication(fixture.envelope, paths, fixture.authorization);
    const capability = fixture.coordinator.signedCapability("exact-current-recovery-plan-capability", {
      request: fixture.envelope.request,
      plan: prepared.plan,
    });
    const binding = {
      request_sha256: fixture.envelope.request_sha256,
      authorization_sha256: fixture.coordinator.sha256(fixture.coordinator.canonicalJson(fixture.authorization)),
    };
    await fixture.coordinator.publishExactCurrentRecoveryPublication(paths, capability, binding);
    const completion = fixture.signCompletion({
      schema_version: "1.0",
      kind: "kontourai.lifecycle-authority.completion",
      action: "recover-exact-current-completion",
      request_sha256: prepared.plan.request_sha256,
      run_id: paths.runId,
      operation_status: "applied",
      result_core_sha256: prepared.plan.result_core_sha256,
      coordinator_runtime_sha256: coordinatorRuntimeSha256(),
      completed_at: "2026-07-24T00:15:00.000Z",
    });
    fs.writeFileSync(fixture.completionFile, `${JSON.stringify(completion)}\n`, { mode: 0o644 });
    const fenceFile = path.join(fixture.flowRoot, "recovery-fence.json");
    const activeFence = JSON.parse(fs.readFileSync(fenceFile, "utf8"));
    assert.equal(activeFence.status, "active");
    await fixture.coordinator.finalizeVerificationResealFence(paths, prepared.plan.recovery_id, activeFence.generation);
    const openFence = JSON.parse(fs.readFileSync(fenceFile, "utf8"));
    assert.equal(openFence.status, "open");
    assert.equal(openFence.previous_generation, activeFence.generation);

    await pauseRun(paths.runId, {
      cwd: paths.projectRoot,
      reason: "legitimate post-finalization mutation",
      authority: { kind: "operator_request", actor: "cleanup-replay-test", request_ref: "test:cleanup-replay", requested_at: "2026-07-24T00:15:01.000Z" },
      at: "2026-07-24T00:15:02.000Z",
    });
    const stateFile = path.join(fixture.flowRoot, "state.json");
    const postWriterState = fs.readFileSync(stateFile);
    const protectedBeforeCleanup = {
      bundle: fs.readFileSync(fixture.bundleFile),
      ledger: fs.readFileSync(fixture.ledgerFile),
      receipt: fs.readFileSync(fixture.completionFile),
      fence: fs.readFileSync(fenceFile),
    };
    const files = exactCurrentRecoveryArtifactFiles(paths, prepared.plan.request_sha256, prepared.plan.authorization_sha256);
    const stages = [...files.values()].flatMap((file) => [
      `${file}.exact-current-recovery-old`,
      `${file}.exact-current-recovery-new`,
    ]);
    const planFile = path.join(fixture.sessionDir, ".exact-current-recovery.transaction.json");
    assert.ok(fs.existsSync(planFile));
    assert.ok(stages.some((file) => fs.existsSync(file)));

    const replay = await fixture.coordinator.finalizeExactCurrentRecoveryPublication(paths, completion);
    assert.deepEqual(replay, { run_id: paths.runId, finalized: true, cleanup_replayed: true });
    assert.equal(fs.existsSync(planFile), false);
    assert.ok(stages.every((file) => !fs.existsSync(file)));
    assert.deepEqual(fs.readFileSync(stateFile), postWriterState, "cleanup does not restore superseded Flow postimages");
    assert.deepEqual(fs.readFileSync(fixture.bundleFile), protectedBeforeCleanup.bundle);
    assert.deepEqual(fs.readFileSync(fixture.ledgerFile), protectedBeforeCleanup.ledger);
    assert.deepEqual(fs.readFileSync(fixture.completionFile), protectedBeforeCleanup.receipt);
    assert.deepEqual(fs.readFileSync(fenceFile), protectedBeforeCleanup.fence, "cleanup does not rewrite the finalized fence");
  } finally { fixture.cleanup(); }
});

test("same recovery request path accepts a second signed authorization generation with a distinct attachment", async () => {
  const fixture = await createHermeticRecoveryFixture("repeat-recovery");
  try {
    const first = await invokeHermeticCoordinator(fixture);
    const firstAuthorizationSha256 = fixture.coordinator.sha256(fixture.coordinator.canonicalJson(fixture.authorization));
    const bundle = JSON.parse(fs.readFileSync(fixture.bundleFile, "utf8"));
    bundle.claims.push({
      id: "post-recovery-gate-claim",
      subjectId: "kontourai/flow-agents#944",
      subjectType: "work-item",
      claimType: "workflow.check.command",
      fieldOrBehavior: "A later legitimate gate observation makes the first recovery completion stale.",
      value: "pass",
      impactLevel: "high",
      status: "verified",
      createdAt: "2026-07-24T00:20:00.000Z",
      updatedAt: "2026-07-24T00:20:00.000Z",
      metadata: { origin: "verification" },
    });
    fs.writeFileSync(fixture.bundleFile, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o644 });
    const bundleBytes = fs.readFileSync(fixture.bundleFile);
    const ledgerBytes = fs.readFileSync(fixture.ledgerFile);
    const ledger = JSON.parse(ledgerBytes);
    const staleBytes = fs.readFileSync(fixture.completionFile);
    const stale = JSON.parse(staleBytes);
    const definitionFile = path.join(fixture.flowRoot, "definition.json");
    const manifestFile = path.join(fixture.flowRoot, "evidence", "manifest.json");
    const definitionBytes = fs.readFileSync(definitionFile);
    const manifestBytes = fs.readFileSync(manifestFile);
    const definition = JSON.parse(definitionBytes);
    const state = JSON.parse(fs.readFileSync(path.join(fixture.flowRoot, "state.json"), "utf8"));
    const gate = definition.gates["verify-gate"];
    const critique = critiqueHistoryProjectionSummary(bundle.claims);
    const edges = critiqueResolutionEdgeProjectionSummary(bundle.claims);
    const now = new Date();
    const unsigned = {
      ...fixture.authorization,
      stale_completion_sha256: rawSha256(staleBytes),
      stale_completion_action: stale.action,
      stale_completion_request_sha256: stale.request_sha256,
      stale_completion_result_core_sha256: stale.result_core_sha256,
      stale_completion_coordinator_runtime_sha256: stale.coordinator_runtime_sha256,
      current_bundle_sha256: rawSha256(bundleBytes),
      current_ledger_sha256: rawSha256(ledgerBytes),
      current_ledger_length: ledger.events.length,
      current_ledger_tail_hash: ledger.events.at(-1)?.event_hash ?? "0".repeat(64),
      critique_projection_sha256: critique.digest,
      resolution_edge_projection_sha256: edges.digest,
      resolution_edge_projection_count: edges.count,
      flow_definition_sha256: rawSha256(definitionBytes),
      flow_gate_policy_sha256: fixture.coordinator.sha256(fixture.coordinator.canonicalJson({ gate_id: "verify-gate", requirements: gate.expects })),
      flow_run_head: flowRunHead(state),
      flow_manifest_sha256: rawSha256(manifestBytes),
      nonce: "fixture-repeat-recovery-second",
      requested_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 3_600_000).toISOString(),
    };
    delete unsigned.signature;
    const secondAuthorization = {
      ...unsigned,
      signature: {
        algorithm: "ed25519",
        key_id: "fixture-operator",
        value: sign(null, Buffer.from(JSON.stringify(unsigned)), fixture.operatorPrivate).toString("base64"),
      },
    };
    fs.writeFileSync(fixture.authorizationFile, `${JSON.stringify(secondAuthorization)}\n`, { mode: 0o600 });
    const second = await invokeHermeticCoordinator(fixture);
    assert.equal(second.result.operation_status, "applied");
    assert.equal(second.result.completion.request_sha256, first.result.completion.request_sha256, "durable completion retains the unchanged request envelope digest");
    const secondAuthorizationSha256 = fixture.coordinator.sha256(fixture.coordinator.canonicalJson(secondAuthorization));
    assert.notEqual(secondAuthorizationSha256, firstAuthorizationSha256);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    const ids = manifest.evidence.map((entry) => entry.id).filter((id) => id.startsWith(`lifecycle-authority:${fixture.envelope.request_sha256}:`));
    assert.ok(ids.includes(`lifecycle-authority:${fixture.envelope.request_sha256}:${firstAuthorizationSha256}`));
    assert.ok(ids.includes(`lifecycle-authority:${fixture.envelope.request_sha256}:${secondAuthorizationSha256}`));
    assert.equal(new Set(ids).size, 2, "each signed authorization generation has one distinct stored attachment");
  } finally { fixture.cleanup(); }
});

test("hermetic privileged coordinator rejects tampered protected recovery inputs without publication", async () => {
  const mutations = [
    ["bundle", (fixture) => fs.writeFileSync(fixture.bundleFile, `${fs.readFileSync(fixture.bundleFile, "utf8").trimEnd()} \n`, { mode: 0o644 })],
    ["ledger", (fixture) => fs.writeFileSync(fixture.ledgerFile, `${fs.readFileSync(fixture.ledgerFile, "utf8").trimEnd()} \n`, { mode: 0o644 })],
    ["stale receipt", (fixture) => fs.writeFileSync(fixture.completionFile, `${fs.readFileSync(fixture.completionFile, "utf8").replace("resolve-critique", "recover-exact-current-completion")}\n`, { mode: 0o644 })],
    ["Flow manifest", (fixture) => fs.writeFileSync(path.join(fixture.flowRoot, "evidence", "manifest.json"), `${fs.readFileSync(path.join(fixture.flowRoot, "evidence", "manifest.json"), "utf8").trimEnd()} \n`, { mode: 0o644 })],
  ];
  for (const [label, mutate] of mutations) {
    const fixture = await createHermeticRecoveryFixture(`tamper-${label.replace(/\W+/g, "-")}`);
    try {
      const manifestFile = path.join(fixture.flowRoot, "evidence", "manifest.json");
      const manifestBefore = fs.readFileSync(manifestFile);
      mutate(fixture);
      await assert.rejects(invokeHermeticCoordinator(fixture), /preimage|signature|canonical Flow|stale lifecycle completion/i, `${label} must reject`);
      const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
      const attachmentId = `lifecycle-authority:${fixture.envelope.request_sha256}:${fixture.coordinator.sha256(fixture.coordinator.canonicalJson(fixture.authorization))}`;
      assert.equal(manifest.evidence.filter((entry) => entry.id === attachmentId).length, 0, `${label} created no attachment`);
      assert.equal(fs.existsSync(path.join(fixture.stateRoot, "completions")) ? fs.readdirSync(path.join(fixture.stateRoot, "completions")).length : 0, 0, `${label} created no durable completion`);
      if (label !== "Flow manifest") assert.equal(fs.readFileSync(manifestFile).compare(manifestBefore), 0, `${label} did not change Flow artifacts`);
    } finally { fixture.cleanup(); }
  }
});

test("hermetic privileged coordinator resumes a prepared recovery and preserves a newer exact-current receipt", async () => {
  const fixture = await createHermeticRecoveryFixture("prepared-recovery");
  try {
    const authorizationSha256 = fixture.coordinator.sha256(fixture.coordinator.canonicalJson(fixture.authorization));
    const operationId = fixture.coordinator.sha256({ project: fixture.projectRoot, run_id: "prepared-recovery", action: fixture.envelope.action, key_id: "fixture-operator", nonce: fixture.authorization.nonce });
    const nonceFile = path.join(fixture.stateRoot, "nonces", `${fixture.coordinator.sha256(`fixture-operator\u0000${fixture.authorization.nonce}`)}.json`);
    fs.mkdirSync(path.dirname(nonceFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(nonceFile, `${JSON.stringify({ schema_version: "1.0", operation_id: operationId, authorization_sha256: authorizationSha256, key_id: "fixture-operator", nonce: fixture.authorization.nonce, request_sha256: fixture.envelope.request_sha256, status: "prepared" })}\n`, { mode: 0o600 });
    const applied = await invokeHermeticCoordinator(fixture);
    assert.equal(applied.result.operation_status, "applied", "prepared all-old state resumes to one all-new completion");
    const currentCore = fixture.coordinator.sha256({ ...JSON.parse(fixture.bundleBytes), critique_resolution_events: JSON.parse(fixture.ledgerBytes).events });
    const newerUnsigned = { ...applied.result.completion, request_sha256: "f".repeat(64), result_core_sha256: currentCore, completed_at: new Date(Date.now() + 1_000).toISOString() };
    delete newerUnsigned.signature;
    const newer = fixture.signCompletion(newerUnsigned);
    fs.writeFileSync(fixture.completionFile, `${JSON.stringify(newer)}\n`, { mode: 0o644 });
    const replay = await invokeHermeticCoordinator(fixture);
    assert.equal(replay.result.operation_status, "replayed");
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.completionFile, "utf8")), newer, "a distinct newer exact-current receipt is never overwritten by replay");
  } finally { fixture.cleanup(); }
});

test("coordinator exposes a distinct exact reseal-verification-evidence action", () => {
  const request = {
    action: "reseal-verification-evidence",
    project_root: "/project",
    session_dir: "/project/.kontourai/flow-agents/run-1",
    authorization_file: "/outside/authorization.json",
  };
  const envelope = { schema_version: "1.0", action: request.action, request_sha256: sha256(request), request };
  assert.deepEqual(validateEnvelope(envelope), envelope);
  assert.throws(
    () => validateEnvelope({ ...envelope, request: { ...request, candidate_file: "/attacker/chosen" }, request_sha256: sha256({ ...request, candidate_file: "/attacker/chosen" }) }),
    /unexpected or missing fields/i,
    "candidate location is derived only from the signed transaction identity",
  );
  assert.equal(typeof canonicalJson(envelope), "string");
});

test("coordinator exposes a fixed completion-only recovery envelope", () => {
  const request = {
    action: "recover-exact-current-completion",
    project_root: "/project",
    session_dir: "/project/.kontourai/flow-agents/run-1",
    authorization_file: "/outside/authorization.json",
  };
  const envelope = { schema_version: "1.0", action: request.action, request_sha256: sha256(request), request };
  assert.deepEqual(validateEnvelope(envelope), envelope);
  assert.throws(
    () => validateEnvelope({ ...envelope, request: { ...request, bundle_file: "/attacker/current.bundle" }, request_sha256: sha256({ ...request, bundle_file: "/attacker/current.bundle" }) }),
    /unexpected or missing fields/i,
    "recovery never accepts caller-selected evidence or Flow paths",
  );
  const source = fs.readFileSync(COORDINATOR, "utf8");
  assert.match(source, /recoverExactCurrentCompletionTransition/, "recovery uses the no-write pure transition");
  assert.match(source, /assertExactCurrentCompletionRecoveryPreimages/, "recovery revalidates protected bytes before publication");
});

test("privileged recovery authorization fails closed on forged field shape", async () => {
  const loaded = await loadProtectedReadFromCoordinator();
  try {
    const authorization = Object.fromEntries(loaded.recoveryAuthorizationFields.map((field) => [field, field === "schema_version" ? "1.0"
      : field === "operation" ? "recover-exact-current-completion"
      : field === "permitted_transition" ? "exact-current-completion-only"
      : field === "signature" ? { algorithm: "ed25519", key_id: "operator", value: "AA==" }
      : field.endsWith("_sha256") || field.endsWith("_tail_hash") || field === "flow_run_head" ? "a".repeat(64)
      : field.endsWith("_length") || field.endsWith("_count") ? 0
      : "fixture"]));
    assert.doesNotThrow(() => loaded.assertPrivilegedAuthorizationShape(authorization));
    assert.throws(() => loaded.assertPrivilegedAuthorizationShape({ ...authorization, forged: true }), /unexpected or missing fields/i);
    const missing = { ...authorization }; delete missing.stale_completion_sha256;
    assert.throws(() => loaded.assertPrivilegedAuthorizationShape(missing), /unexpected or missing fields/i);
  } finally { fs.rmSync(loaded.directory, { recursive: true, force: true }); }
});

test("exact-current recovery classifies all-old, mixed, all-new, and unknown Flow-only states", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-cas-"));
  try {
    const paths = { projectRoot: root, sessionDir: path.join(root, ".kontourai", "flow-agents", "run-1"), runId: "run-1" };
    const requestSha256 = "a".repeat(64);
    const authorizationSha256 = "c".repeat(64);
    const files = exactCurrentRecoveryArtifactFiles(paths, requestSha256, authorizationSha256);
    const descriptor = (bytes) => ({ presence: "present", mode: 0o644, size: bytes.length, sha256: rawSha256(bytes) });
    const artifacts = EXACT_CURRENT_RECOVERY_ARTIFACT_IDS.map((id) => {
      const oldBytes = Buffer.from(`old-${id}\n`), newBytes = Buffer.from(`new-${id}\n`);
      fs.mkdirSync(path.dirname(files.get(id)), { recursive: true });
      fs.writeFileSync(files.get(id), oldBytes, { mode: 0o644 });
      return { id, pre: descriptor(oldBytes), post: descriptor(newBytes), oldBytes, newBytes };
    });
    const plan = {
      schema_version: "1.0", kind: "flow-agents.exact-current-recovery-publication.v1", recovery_id: "b".repeat(64),
      run_id: paths.runId, request_sha256: requestSha256, authorization_sha256: authorizationSha256,
      authorization_key_id: "operator", authorization_nonce: "nonce", reducer: { id: "fixture" },
      result_core_sha256: "d".repeat(64),
      protected_preimages: ["trust-bundle", "resolution-ledger", "stale-receipt"].map((id) => ({ id, pre: { presence: "absent", mode: null, size: 0, sha256: null } })),
      artifacts: artifacts.map(({ id, pre, post }) => ({ id, pre, post })),
    };
    assert.deepEqual(validateExactCurrentRecoveryPlan(plan), plan);
    assert.equal(classifyExactCurrentRecoveryArtifacts(paths, plan), "old");
    fs.writeFileSync(files.get(artifacts[0].id), artifacts[0].newBytes, { mode: 0o644 });
    assert.equal(classifyExactCurrentRecoveryArtifacts(paths, plan), "mixed");
    for (const artifact of artifacts) fs.writeFileSync(files.get(artifact.id), artifact.newBytes, { mode: 0o644 });
    assert.equal(classifyExactCurrentRecoveryArtifacts(paths, plan), "new");
    fs.writeFileSync(files.get(artifacts[2].id), "foreign\n", { mode: 0o644 });
    assert.equal(classifyExactCurrentRecoveryArtifacts(paths, plan), "unknown");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("reseal uses Flow's native mutation lock to serialize a legitimate concurrent lifecycle write", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-reseal-native-flow-lock-"));
  const runId = "run-1";
  const sessionDir = path.join(projectRoot, ".kontourai", "flow-agents", runId);
  const bundleFile = path.join(sessionDir, "trust.bundle");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(bundleFile, '{"claims":[{"id":"before"}]}\n');
  try {
    await startRun(path.resolve("kits/builder/flows/build.flow.json"), {
      cwd: projectRoot,
      runId,
      params: { subject: "work-item:native-lock-race" },
    });
    let releaseTransaction;
    let transactionEntered;
    const entered = new Promise((resolve) => { transactionEntered = resolve; });
    const release = new Promise((resolve) => { releaseTransaction = resolve; });
    const transaction = withCanonicalFlowRunMutationLock(
      { projectRoot, sessionDir, runId },
      () => inProjectTransaction(
        { projectRoot, sessionDir, runId },
        { request_sha256: "a".repeat(64), authorization_sha256: "b".repeat(64) },
        async () => {
          transactionEntered();
          await release;
          fs.writeFileSync(bundleFile, '{"claims":[{"id":"resealed"}]}\n');
        },
      ),
      withRunMutationLock,
    );
    await entered;

    const flowModule = pathToFileURL(path.resolve("node_modules/@kontourai/flow/dist/index.js")).href;
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { pauseRun } from ${JSON.stringify(flowModule)};
      await pauseRun(${JSON.stringify(runId)}, {
        cwd: ${JSON.stringify(projectRoot)},
        reason: "legitimate concurrent lifecycle write",
        authority: {
          kind: "operator_request",
          actor: "native-lock-test",
          request_ref: "test:native-lock",
          requested_at: "2026-07-23T18:00:00.000Z"
        },
        at: "2026-07-23T18:00:01.000Z"
      });
    `], { stdio: ["ignore", "pipe", "pipe"] });
    let childExited = false;
    child.once("exit", () => { childExited = true; });
    const childResultPromise = new Promise((resolve) => {
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("close", (code) => resolve({ code, stderr }));
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(childExited, false, "public pause must wait behind the coordinator's native Flow ticket");

    releaseTransaction();
    await transaction;
    const childResult = await childResultPromise;
    assert.deepEqual(childResult, { code: 0, stderr: "" });
    assert.equal(fs.readFileSync(bundleFile, "utf8"), '{"claims":[{"id":"resealed"}]}\n');
    const run = await loadRun(runId, projectRoot);
    assert.equal(run.state.status, "paused");
    assert.equal(run.state.lifecycle.at(-1)?.authority?.request_ref, "test:native-lock", "the legitimate foreign Flow write must be preserved");
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

for (const journalStatus of ["prepared", "committed"]) {
  test(`${journalStatus} recovery rejects malformed snapshot entries before any write and preserves the active Flow lock`, async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), `lifecycle-reseal-${journalStatus}-malformed-recovery-`));
    const runId = "run-1";
    const sessionDir = path.join(projectRoot, ".kontourai", "flow-agents", runId);
    const flowRoot = path.join(projectRoot, ".kontourai", "flow", "runs", runId);
    const bundleFile = path.join(sessionDir, "trust.bundle");
    const journalFile = path.join(sessionDir, ".lifecycle-authority.transaction.json");
    const outsideFile = path.join(projectRoot, "outside-sentinel");
    const binding = { request_sha256: "7".repeat(64), authorization_sha256: "8".repeat(64) };
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(bundleFile, '{"claims":[{"id":"snapshot-baseline"}]}\n');
    fs.writeFileSync(outsideFile, "outside remains unchanged\n");
    try {
      await startRun(path.resolve("kits/builder/flows/build.flow.json"), {
        cwd: projectRoot,
        runId,
        params: { subject: `work-item:${journalStatus}-malformed-recovery` },
      });
      const sessionSnapshot = snapshotTree(sessionDir);
      const flowSnapshot = snapshotTree(flowRoot);
      fs.writeFileSync(bundleFile, '{"claims":[{"id":"current-must-survive"}]}\n');

      const invalidCases = [
        ["case-folded protected lock alias", (journal) => journal.flow.push({ path: ".MUTATION.LOCK/owner.json", bytes: "YQ==", mode: 0o600 })],
        ["Unicode-normalized protected lock alias", (journal) => journal.flow.push({ path: ".mutation.loc\u212A/owner.json", bytes: "YQ==", mode: 0o600 })],
        ["aliased lock path", (journal) => journal.flow.push({ path: ".mutation.lock/../state.json", bytes: "YQ==", mode: 0o600 })],
        ["outside traversal", (journal) => journal.session.push({ path: "../../../outside-sentinel", bytes: "YQ==", mode: 0o600 })],
        ["absolute path", (journal) => journal.flow.push({ path: outsideFile, bytes: "YQ==", mode: 0o600 })],
        ["backslash platform alias", (journal) => journal.flow.push({ path: ".mutation.lock\\owner.json", bytes: "YQ==", mode: 0o600 })],
        ["drive-relative platform alias", (journal) => journal.flow.push({ path: "C:outside", bytes: "YQ==", mode: 0o600 })],
        ["dot segment", (journal) => journal.flow.push({ path: "evidence/./manifest.json", bytes: "YQ==", mode: 0o600 })],
        ["empty segment", (journal) => journal.flow.push({ path: "evidence//manifest.json", bytes: "YQ==", mode: 0o600 })],
        ["empty path", (journal) => journal.flow.push({ path: "", bytes: "YQ==", mode: 0o600 })],
        ["duplicate canonical path", (journal) => journal.flow.push(structuredClone(journal.flow[0]))],
        ["case-folded duplicate identity", (journal) => journal.flow.push(
          { path: "Case-Sensitive.json", bytes: "YQ==", mode: 0o600 },
          { path: "case-sensitive.json", bytes: "Yg==", mode: 0o600 },
        )],
        ["Unicode-normalized duplicate identity", (journal) => journal.flow.push(
          { path: "evidence/ArtifactK.json", bytes: "YQ==", mode: 0o600 },
          { path: "evidence/Artifact\u212A.json", bytes: "Yg==", mode: 0o600 },
        )],
        ["non-ASCII case variants", (journal) => journal.flow.push(
          { path: "\u00c5.json", bytes: "YQ==", mode: 0o600 },
          { path: "\u00e5.json", bytes: "Yg==", mode: 0o600 },
        )],
        ["composed and decomposed case variants", (journal) => journal.flow.push(
          { path: "\u00c5.json", bytes: "YQ==", mode: 0o600 },
          { path: "a\u030a.json", bytes: "Yg==", mode: 0o600 },
        )],
        ["distinct lone surrogates", (journal) => journal.flow.push(
          { path: "surrogate-\ud800.json", bytes: "YQ==", mode: 0o600 },
          { path: "surrogate-\ud801.json", bytes: "Yg==", mode: 0o600 },
        )],
        ["lone surrogate and replacement collision", (journal) => journal.flow.push(
          { path: "collision-\ud800.json", bytes: "YQ==", mode: 0o600 },
          { path: "collision-\ufffd.json", bytes: "Yg==", mode: 0o600 },
        )],
        ["extra entry field", (journal) => journal.flow.push({ path: "extra.json", bytes: "YQ==", mode: 0o600, unexpected: true })],
        ["unsafe mode", (journal) => journal.flow.push({ path: "unsafe-mode.json", bytes: "YQ==", mode: 0o100644 })],
        ["noncanonical base64", (journal) => journal.flow.push({ path: "noncanonical-base64.json", bytes: "YQ", mode: 0o600 })],
      ];

      await withCanonicalFlowRunMutationLock(
        { projectRoot, sessionDir, runId },
        async () => {
          const lockRoot = path.join(flowRoot, ".mutation.lock");
          const tickets = fs.readdirSync(lockRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith("ticket-"));
          assert.equal(tickets.length, 1);
          const currentTicket = path.join(lockRoot, tickets[0].name);
          const ownerFile = path.join(currentTicket, "owner.json");
          const ownerBytes = fs.readFileSync(ownerFile);
          const caseAlias = path.join(flowRoot, ".MUTATION.LOCK");
          const lockStat = fs.statSync(lockRoot);
          const aliasStat = fs.existsSync(caseAlias) ? fs.statSync(caseAlias) : null;
          const caseInsensitiveDarwinProbe = process.platform === "darwin"
            && aliasStat !== null
            && aliasStat.dev === lockStat.dev
            && aliasStat.ino === lockStat.ino;

          for (const [label, mutate] of invalidCases) {
            const journal = {
              schema_version: "1.0",
              status: journalStatus,
              binding,
              created_at: "2026-07-23T19:00:00.000Z",
              session: structuredClone(sessionSnapshot),
              flow: structuredClone(flowSnapshot),
            };
            mutate(journal);
            fs.writeFileSync(journalFile, `${JSON.stringify(journal)}\n`);
            const journalBytes = fs.readFileSync(journalFile);
            const sessionBefore = canonicalJson(snapshotTree(sessionDir));
            const flowBefore = canonicalJson(snapshotTree(flowRoot, "", [".mutation.lock"]));
            const outsideBefore = fs.readFileSync(outsideFile);

            assert.throws(
              () => recoverMatchingTransaction({ projectRoot, sessionDir, runId }, binding),
              /lifecycle transaction .*snapshot/i,
              label,
            );
            assert.equal(canonicalJson(snapshotTree(sessionDir)), sessionBefore, `${label} changed the session tree`);
            assert.equal(canonicalJson(snapshotTree(flowRoot, "", [".mutation.lock"])), flowBefore, `${label} changed the Flow tree`);
            assert.equal(fs.readFileSync(outsideFile).equals(outsideBefore), true, `${label} wrote outside the transaction root`);
            assert.equal(fs.readFileSync(journalFile).equals(journalBytes), true, `${label} rewrote the invalid journal`);
            assert.equal(fs.existsSync(currentTicket), true, `${label} removed the active Flow ticket`);
            assert.equal(fs.readFileSync(ownerFile).equals(ownerBytes), true, `${label} changed the active Flow ticket owner bytes`);
          }
          if (caseInsensitiveDarwinProbe) {
            assert.deepEqual(
              { dev: aliasStat.dev, ino: aliasStat.ino },
              { dev: lockStat.dev, ino: lockStat.ino },
              "Darwin probe must exercise the actual case-insensitive lock inode",
            );
          }
          if (process.platform === "linux") {
            assert.equal(invalidCases.some(([label]) => label === "case-folded protected lock alias"), true, "Linux must exercise deterministic protected-alias rejection");
          }
        },
        withRunMutationLock,
      );
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
}

for (const journalStatus of ["prepared", "committed"]) {
  test(`${journalStatus} recovery preserves the live Flow mutation ticket and a waiting public mutation`, async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), `lifecycle-reseal-${journalStatus}-native-recovery-`));
    const runId = "run-1";
    const sessionDir = path.join(projectRoot, ".kontourai", "flow-agents", runId);
    const flowRoot = path.join(projectRoot, ".kontourai", "flow", "runs", runId);
    const bundleFile = path.join(sessionDir, "trust.bundle");
    const journalFile = path.join(sessionDir, ".lifecycle-authority.transaction.json");
    const binding = { request_sha256: "c".repeat(64), authorization_sha256: "d".repeat(64) };
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(bundleFile, '{"claims":[{"id":"baseline"}]}\n');
    try {
      await startRun(path.resolve("kits/builder/flows/build.flow.json"), {
        cwd: projectRoot,
        runId,
        params: { subject: `work-item:${journalStatus}-native-recovery` },
      });
      const legacyObsoleteTicket = path.join(".mutation.lock", "ticket-obsolete", "owner.json");
      const journal = {
        schema_version: "1.0",
        status: journalStatus,
        binding,
        created_at: "2026-07-23T18:00:00.000Z",
        session: snapshotTree(sessionDir),
        flow: [
          ...snapshotTree(flowRoot),
          { path: legacyObsoleteTicket, bytes: Buffer.from('{"token":"obsolete"}\n').toString("base64"), mode: 0o600 },
        ],
      };
      fs.writeFileSync(journalFile, `${JSON.stringify(journal)}\n`);

      let childResultPromise;
      await withCanonicalFlowRunMutationLock(
        { projectRoot, sessionDir, runId },
        async () => {
          const lockRoot = path.join(flowRoot, ".mutation.lock");
          const currentTickets = fs.readdirSync(lockRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && entry.name.startsWith("ticket-"))
            .map((entry) => entry.name);
          assert.equal(currentTickets.length, 1, "recovery must run under one live native Flow ticket");
          const currentTicket = path.join(lockRoot, currentTickets[0]);

          const flowModule = pathToFileURL(path.resolve("node_modules/@kontourai/flow/dist/index.js")).href;
          const child = spawn(process.execPath, ["--input-type=module", "-e", `
            import { pauseRun } from ${JSON.stringify(flowModule)};
            for (let attempt = 0;; attempt += 1) {
              try {
                await pauseRun(${JSON.stringify(runId)}, {
                  cwd: ${JSON.stringify(projectRoot)},
                  reason: ${JSON.stringify(`${journalStatus} recovery waiter`)},
                  authority: {
                    kind: "operator_request",
                    actor: "native-recovery-test",
                    request_ref: ${JSON.stringify(`test:native-recovery:${journalStatus}`)},
                    requested_at: "2026-07-23T18:00:00.000Z"
                  },
                  at: "2026-07-23T18:00:02.000Z"
                });
                break;
              } catch (error) {
                if (error?.code !== "flow.run_mutation.lock.owner_unreadable" || attempt >= 20) throw error;
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            }
          `], { stdio: ["ignore", "pipe", "pipe"] });
          let childExited = false;
          child.once("exit", () => { childExited = true; });
          childResultPromise = new Promise((resolve) => {
            let stderr = "";
            child.stderr.on("data", (chunk) => { stderr += chunk; });
            child.once("close", (code) => resolve({ code, stderr }));
          });
          await new Promise((resolve) => setTimeout(resolve, 150));
          assert.equal(childExited, false, "public pause must wait for recovery to release the native ticket");

          fs.writeFileSync(bundleFile, '{"claims":[{"id":"interrupted"}]}\n');
          assert.equal(recoverMatchingTransaction({ projectRoot, sessionDir, runId }, binding), true);
          assert.equal(fs.existsSync(currentTicket), true, "current recovery ticket must remain intact");
          assert.equal(fs.existsSync(path.join(flowRoot, legacyObsoleteTicket)), false, "obsolete journal ticket must never be restored");
          assert.equal(fs.readFileSync(bundleFile, "utf8"), '{"claims":[{"id":"baseline"}]}\n');
          assert.equal(JSON.parse(fs.readFileSync(journalFile, "utf8")).status, "rolled_back");
        },
        withRunMutationLock,
      );

      assert.deepEqual(await childResultPromise, { code: 0, stderr: "" });
      const run = await loadRun(runId, projectRoot);
      assert.equal(run.state.status, "paused");
      assert.equal(run.state.lifecycle.at(-1)?.authority?.request_ref, `test:native-recovery:${journalStatus}`, "the waiting foreign Flow mutation must be preserved");
      assert.equal(fs.existsSync(path.join(flowRoot, ".mutation.lock", "ticket-obsolete")), false);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
}

test("reseal plan is closed over exactly six fixed artifact identities and no journal paths", () => {
  const present = { presence: "present", mode: 0o644, size: 7, sha256: "a".repeat(64) };
  const absent = { presence: "absent", mode: null, size: 0, sha256: null };
  const authorization = {
    signature: { key_id: "operator" }, nonce: "nonce",
    assignment_generation_sha256: "5".repeat(64), assignment_actor_key: "actor",
    assignment_actor: { runtime: "test", session_id: "session", host: "host", human: null },
  };
  const plan = {
    schema_version: "1.0",
    kind: "flow-agents.verification-reseal-transaction.v1",
    recovery_id: "1".repeat(64),
    run_id: "run-1",
    request_sha256: "2".repeat(64),
    authorization_sha256: sha256(canonicalJson(authorization)),
    authorization_key_id: "operator",
    authorization_nonce: "nonce",
    authorization,
    assignment: { generation_sha256: "5".repeat(64), actor_key: "actor", actor: { runtime: "test", session_id: "session", host: "host", human: null } },
    reducer: { package: "@kontourai/flow", version: "test" },
    result_core_sha256: "4".repeat(64),
    artifacts: VERIFICATION_RESEAL_ARTIFACT_IDS.map((id) => ({ id, parent: { dev: 1, ino: 1 }, pre: id === "flow-attachment" ? absent : present, post: present })),
  };
  assert.deepEqual(validateVerificationResealPlan(plan), plan);
  assert.deepEqual(plan.artifacts.map(({ id }) => id), [
    "session-trust-bundle", "flow-manifest", "flow-state", "flow-attachment", "flow-report-json", "flow-report-markdown",
  ]);
  assert.equal(JSON.stringify(plan).includes("path"), false, "signed plan artifact entries must not contain caller-selected paths");
  assert.throws(
    () => validateVerificationResealPlan({ ...plan, artifacts: [...plan.artifacts, { id: "journal", parent: { dev: 1, ino: 1 }, pre: absent, post: absent }] }),
    /exactly the fixed six artifact ids|identity is invalid/i,
  );

  const source = fs.readFileSync(COORDINATOR, "utf8");
  const resealBranch = source.slice(source.indexOf("async function prepareVerificationResealTransaction"), source.indexOf("function assertVerificationResealStages"));
  assert.doesNotMatch(resealBranch, /\binProjectTransaction\s*\(/, "reseal must never use the recursive tree transaction");
  const fenceWriter = source.slice(source.indexOf("async function writeVerificationResealFence"), source.indexOf("function stageVerificationResealImage"));
  assert.match(fenceWriter, /\bwriteRunRecoveryFence\s*\(/, "reseal must use Flow's native generated-fence writer");
  assert.match(fenceWriter, /\bfinalizeRunRecoveryFence\s*\(/, "reseal must use Flow's generation-bound native fence finalizer");
  assert.doesNotMatch(fenceWriter, /\batomicWrite\s*\(/, "reseal must not locally synthesize a Flow recovery fence");
  assert.throws(
    () => assertVerificationResealFlowCapabilities({ withRunMutationLock() {} }),
    /withRunRecoveryLock is unavailable/,
  );
  assert.equal(assertVerificationResealFlowCapabilities({
    withRunMutationLock() {}, withRunRecoveryLock() {}, writeRunRecoveryFence() {}, finalizeRunRecoveryFence() {},
  }), true);
  const rootOperation = source.slice(source.indexOf("async function processRootOperation"), source.indexOf("function response"));
  assert.ok(
    rootOperation.indexOf('"preflight-reseal"') < rootOperation.indexOf("atomicWrite(nonceFile"),
    "fresh reseal must preflight the exact installed Flow API before creating durable nonce state",
  );
  const replacement = source.slice(
    source.indexOf("export function replaceVerificationResealArtifactCAS"),
    source.indexOf("function readVerificationResealArtifact"),
  );
  assert.match(replacement, /atomicReplaceExpectedPreimage\s*\(/);
  assert.doesNotMatch(replacement, /fs\.(?:renameSync|unlinkSync|writeFileSync)\s*\(/, "the reference coordinator must not implement leaf replacement");
});

test("reseal delegates literal expected-preimage replacement and pins the opened parent", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "reseal-pinned-parent-"));
  try {
    const parent = path.join(workspace, "evidence");
    const outside = path.join(workspace, "outside");
    fs.mkdirSync(parent); fs.mkdirSync(outside);
    const file = path.join(parent, "state.json");
    const before = Buffer.from("before\n");
    const after = Buffer.from("after\n");
    fs.writeFileSync(file, before, { mode: 0o644 });
    const parentStat = fs.statSync(parent);
    const artifact = {
      id: "flow-state",
      parent: { dev: parentStat.dev, ino: parentStat.ino },
      pre: { presence: "present", mode: 0o644, size: before.length, sha256: rawSha256(before) },
      post: { presence: "present", mode: 0o644, size: after.length, sha256: rawSha256(after) },
    };
    const injectedCapability = (beforeAtomicCheck = () => {}) => ({
      protocol: VERIFICATION_RESEAL_ATOMIC_REPLACE_PROTOCOL,
      atomicReplaceExpectedPreimage(request) {
        assert.equal(request.protocol, VERIFICATION_RESEAL_ATOMIC_REPLACE_PROTOCOL);
        assert.equal(request.target_name, "state.json");
        assert.deepEqual(
          { dev: fs.fstatSync(request.parent_descriptor).dev, ino: fs.fstatSync(request.parent_descriptor).ino },
          request.parent,
          "the host capability receives the pinned parent descriptor and identity",
        );
        beforeAtomicCheck();
        const current = fs.readFileSync(file);
        const currentStat = fs.statSync(file);
        const currentDescriptor = {
          presence: "present", mode: currentStat.mode & 0o777, size: current.length, sha256: rawSha256(current),
        };
        if (canonicalJson(currentDescriptor) !== canonicalJson(request.preimage)) {
          throw new Error("host atomic expected-preimage mismatch");
        }
        const postimage = Buffer.from(request.postimage_bytes_base64, "base64");
        fs.writeFileSync(file, postimage, { mode: request.postimage.mode });
        return {
          protocol: VERIFICATION_RESEAL_ATOMIC_REPLACE_PROTOCOL,
          status: "replaced",
          preimage: request.preimage,
          postimage: request.postimage,
        };
      },
    });
    const unchangedWithoutCapability = fs.readFileSync(file);
    assert.throws(
      () => replaceVerificationResealArtifactCAS(file, artifact, after),
      /administrator-injected atomic expected-preimage replacement capability.*no artifacts were mutated/,
    );
    assert.deepEqual(fs.readFileSync(file), unchangedWithoutCapability);
    fs.writeFileSync(file, "foreign\n");
    assert.throws(
      () => replaceVerificationResealArtifactCAS(file, artifact, after, injectedCapability()),
      /host atomic expected-preimage mismatch/,
    );
    assert.equal(fs.readFileSync(file, "utf8"), "foreign\n");
    fs.writeFileSync(file, before);
    assert.throws(
      () => replaceVerificationResealArtifactCAS(
        file,
        artifact,
        after,
        injectedCapability(() => fs.writeFileSync(file, "interposed\n")),
      ),
      /host atomic expected-preimage mismatch/,
    );
    assert.equal(fs.readFileSync(file, "utf8"), "interposed\n", "an interposed leaf is rejected, not overwritten");
    fs.writeFileSync(file, before);
    replaceVerificationResealArtifactCAS(file, artifact, after, injectedCapability());
    assert.equal(fs.readFileSync(file, "utf8"), "after\n");
    fs.writeFileSync(file, before);
    const parked = `${parent}.parked`;
    fs.renameSync(parent, parked);
    fs.symlinkSync(outside, parent);
    assert.throws(
      () => replaceVerificationResealArtifactCAS(file, artifact, after, injectedCapability()),
      /stable real directory|ELOOP/,
    );
    assert.equal(fs.existsSync(path.join(outside, "state.json")), false);
    assert.equal(fs.readFileSync(path.join(parked, "state.json"), "utf8"), "before\n");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("reseal recovery classifies only exact all-old or all-new generations and rejects active legacy tree journals", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-reseal-generation-"));
  const runId = "run-1";
  const sessionDir = path.join(projectRoot, ".kontourai", "flow-agents", runId);
  const paths = { projectRoot, sessionDir, runId };
  const requestSha256 = "2".repeat(64);
  const artifactFiles = verificationResealArtifactFiles(paths, requestSha256);
  for (const file of artifactFiles.values()) fs.mkdirSync(path.dirname(file), { recursive: true });
  const artifacts = VERIFICATION_RESEAL_ARTIFACT_IDS.map((id, index) => {
    const preBytes = Buffer.from(`old-${id}\n`);
    const postBytes = Buffer.from(`new-${id}\n`);
    return {
      id,
      pre: { presence: "present", mode: 0o644, size: preBytes.length, sha256: rawSha256(preBytes) },
      post: { presence: "present", mode: 0o644, size: postBytes.length, sha256: rawSha256(postBytes) },
      preBytes,
      postBytes,
      index,
    };
  });
  const authorization = {
    signature: { key_id: "operator" }, nonce: "nonce",
    assignment_generation_sha256: "5".repeat(64), assignment_actor_key: "actor",
    assignment_actor: { runtime: "test", session_id: "session", host: "host", human: null },
  };
  const plan = validateVerificationResealPlan({
    schema_version: "1.0", kind: "flow-agents.verification-reseal-transaction.v1",
    recovery_id: "1".repeat(64), run_id: runId, request_sha256: requestSha256,
    authorization_sha256: sha256(canonicalJson(authorization)), authorization_key_id: "operator", authorization_nonce: "nonce",
    authorization,
    assignment: { generation_sha256: "5".repeat(64), actor_key: "actor", actor: { runtime: "test", session_id: "session", host: "host", human: null } },
    reducer: { package: "@kontourai/flow" }, result_core_sha256: "4".repeat(64),
    artifacts: artifacts.map(({ id, pre, post }) => ({ id, parent: { dev: 1, ino: 1 }, pre, post })),
  });
  try {
    for (const artifact of artifacts) fs.writeFileSync(artifactFiles.get(artifact.id), artifact.preBytes, { mode: 0o644 });
    assert.equal(classifyVerificationResealArtifacts(paths, plan), "old");
    for (const artifact of artifacts) fs.writeFileSync(artifactFiles.get(artifact.id), artifact.postBytes, { mode: 0o644 });
    assert.equal(classifyVerificationResealArtifacts(paths, plan), "new");
    fs.writeFileSync(artifactFiles.get(artifacts[0].id), artifacts[0].preBytes, { mode: 0o644 });
    assert.equal(classifyVerificationResealArtifacts(paths, plan), "unknown");

    const binding = { request_sha256: requestSha256, authorization_sha256: "3".repeat(64) };
    const journalFile = path.join(sessionDir, ".lifecycle-authority.transaction.json");
    fs.writeFileSync(journalFile, `${JSON.stringify({
      schema_version: "1.0", status: "prepared",
      binding: { request_sha256: "9".repeat(64), authorization_sha256: "8".repeat(64) },
      created_at: "2026-07-23T00:00:00.000Z", session: [], flow: [],
    })}\n`, { mode: 0o600 });
    assert.throws(() => rejectActiveLegacyResealJournal(paths, binding), /offline quarantine.*forbidden/i);
    assert.equal(fs.existsSync(journalFile), false);
    assert.equal(fs.readdirSync(sessionDir).some((name) => name.startsWith(".lifecycle-authority.transaction.json.quarantine-legacy-")), true);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("reseal cleanup removes stages before the signed plan and safely resumes after a cleanup crash", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-reseal-cleanup-"));
  const runId = "run-cleanup";
  const sessionDir = path.join(projectRoot, ".kontourai", "flow-agents", runId);
  const paths = { projectRoot, sessionDir, runId };
  const plan = { request_sha256: "6".repeat(64) };
  try {
    const files = verificationResealArtifactFiles(paths, plan.request_sha256);
    const stages = [...files.values()].flatMap((file) => [`${file}.verification-reseal-old`, `${file}.verification-reseal-new`]);
    for (const file of stages) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "stage\n");
    }
    const planFile = path.join(sessionDir, ".verification-reseal.transaction.json");
    fs.writeFileSync(planFile, "{}\n");
    assert.throws(
      () => cleanupVerificationResealTransaction(paths, plan, {
        before_unlink(file) { if (file === planFile) throw new Error("injected cleanup crash"); },
      }),
      /injected cleanup crash/,
    );
    assert.equal(stages.some((file) => fs.existsSync(file)), false);
    assert.equal(fs.existsSync(planFile), true, "signed plan remains the cleanup recovery marker");
    cleanupVerificationResealTransaction(paths, plan);
    assert.equal(fs.existsSync(planFile), false);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

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
    unsigned.requested_at = new Date().toISOString();
    unsigned.expires_at = new Date(Date.now() + 10 * 60_000).toISOString();
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
    assert.throws(() => verifySigned({ ...unsigned, requested_at: new Date(Date.now() + 6 * 60_000).toISOString() }), /time window is invalid/);
    assert.throws(() => verifySigned({ ...unsigned, expires_at: new Date(Date.now() - 60_000).toISOString() }), /time window is invalid|expired/);
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
  const registryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-coordinator-untrusted-registry-"));
  const registryFile = path.join(registryDirectory, "keys.json");
  fs.writeFileSync(registryFile, JSON.stringify({ schema_version: "1.0", keys: [] }), { mode: 0o600 });
  const { directory, loadResolutionEventLedger } = await loadProtectedReadFromCoordinator({ registryFile });
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
    fs.rmSync(registryDirectory, { recursive: true, force: true });
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
    const exactCandidate = signedCompletion("b".repeat(64), exactCore, "reseal-verification-evidence");
    const staleHistorical = signedCompletion("c".repeat(64), "d".repeat(64));
    const receiptFile = path.join(sessionDir, "lifecycle-authority.completion.json");
    fs.writeFileSync(receiptFile, `${JSON.stringify(staleHistorical)}\n`, { mode: 0o600 });
    assert.deepEqual(loaded.installCompletionReceipt({ sessionDir, runId: "run-replay" }, exactCandidate), { run_id: "run-replay", receipt: "replaced" });
    assert.deepEqual(JSON.parse(fs.readFileSync(receiptFile, "utf8")), exactCandidate, "a signed stale receipt is replaced after committed recovery");

    const newer = signedCompletion("e".repeat(64), exactCore, "reseal-verification-evidence");
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
