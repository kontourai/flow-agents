import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import childProcess, { execFileSync, spawn, spawnSync } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";

import { FLOW_RUN_EVIDENCE_MANIFEST_PATH, acceptException, defaultFlowConfig, flowConfigPath, runDir } from "@kontourai/flow";
import {
  archiveBuilderFlowSession,
  cancelBuilderFlowSession,
  captureReviewWorkspaceSnapshot,
  pauseBuilderFlowSession,
  prepareBuilderCancelRequest,
  recoverBuilderFlowSession,
  releaseBuilderFlowAssignment,
  resumeBuilderFlowSession,
  startBuilderFlowSession,
  syncBuilderFlowSession,
} from "../../build/src/builder-flow-runtime.js";
import { builderLifecycleAuthorizationPayload, critiqueResolutionAuthorizationPayload, loadBuilderLifecycleAuthorization, loadCritiqueResolutionAuthorization } from "../../build/src/builder-lifecycle-authority.js";
import { driveBuilderFlowSession, withContinuationDriverLock } from "../../build/src/continuation-driver.js";
import { deriveBuilderGateActionEnvelope } from "../../build/src/builder-gate-action-envelope.js";
import { WORKFLOW_CRITIQUE_STATUSES } from "../../build/src/cli/public-contracts.js";
import { CRITIQUE_CHAIN_GENESIS, critiqueRecordHash, normalizeCritiqueChainRecords, validateCritiqueResolutionGraph } from "../../build/src/cli/critique-resolution.js";
import { startBuilderFlowRun } from "../../build/src/builder-flow-run-adapter.js";
import { performLocalClaim, performLocalRelease, readLocalAssignmentStatus, resolveCurrentAssignmentActor } from "../../build/src/cli/assignment-provider.js";
import { main as builderRunMain } from "../../build/src/cli/builder-run.js";
import { assertAcceptedTurnEvidenceCapacity, main as workflowMain } from "../../build/src/cli/workflow.js";
import { main as publishChangeMain } from "../../build/src/cli/publish-change-helper.js";
import { createGithubChangeProvider } from "../../build/src/cli/github-change-provider.js";
import { buildTrustBundle, inferExecutedTestCount, main as workflowSidecarMain, validateEvidenceRef } from "../../build/src/cli/workflow-sidecar.js";
import { assertTrustedGitAncestor } from "../../build/src/lib/trusted-git.js";

const SUBJECT = "local:work-item/runtime-projection";
const NOW = "2026-07-09T20:00:00.000Z";
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
const ACTOR = { runtime: "codex", session_id: "runtime-projection", host: "test-host", human: null };
const ACTOR_KEY = "codex:runtime-projection:test-host";
const AUTHORITY_KEY_ID = "runtime-test";
const AUTHORITY_KEYS = generateKeyPairSync("ed25519");
const TEST_AUTHORITY_REGISTRY = { schema_version: "1.0", keys: [{ id: AUTHORITY_KEY_ID, algorithm: "ed25519", public_key_pem: AUTHORITY_KEYS.publicKey.export({ type: "spki", format: "pem" }) }] };
const TEST_AUTHORITY_FILE = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-os-authority-"))), "authority.json");
fs.writeFileSync(TEST_AUTHORITY_FILE, `${JSON.stringify(TEST_AUTHORITY_REGISTRY)}\n`, { mode: 0o444 });
const realExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = ((file, args, options) => {
  if (Array.isArray(args) && String(args[0]).endsWith("lifecycle-authority-verifier.js")) {
    if (process.env.FLOW_AGENTS_LIFECYCLE_AUTHORITY_REGISTRY !== TEST_AUTHORITY_FILE) return realExecFileSync(file, args, options);
    const request = JSON.parse(String(options?.input));
    const key = TEST_AUTHORITY_REGISTRY.keys.find((candidate) => candidate.id === request.signature.key_id);
    if (!key || !verify(null, Buffer.from(request.payload), key.public_key_pem, Buffer.from(request.signature.value, "base64"))) {
      const message = key ? "lifecycle authorization signature is invalid" : `lifecycle authorization key ${request.signature.key_id} is not trusted`;
      const error = new Error(message);
      error.stderr = `${message}\n`;
      throw error;
    }
    return '{"verified":true}\n';
  }
  return realExecFileSync(file, args, options);
});
syncBuiltinESMExports();
process.env.FLOW_AGENTS_LIFECYCLE_AUTHORITY_REGISTRY = TEST_AUTHORITY_FILE;
const require = createRequire(import.meta.url);
const activeTurnAuthority = require("../../scripts/hooks/lib/continuation-turn-authority.js");
const runtimeTestSeams = await loadRuntimeTestSeams();
const issuePublishChangeOperation = runtimeTestSeams.issuePublishChangeOperation;
const createPublishChangeOperationCompleter = (observe) => (input) => runtimeTestSeams.completePublishChangeOperation(input, observe);

async function loadRuntimeTestSeams() {
  const source = new URL("../../build/src/builder-flow-runtime.js", import.meta.url);
  const transient = new URL(`../../build/src/.builder-flow-runtime.test-seam-${process.pid}-${Date.now()}.mjs`, import.meta.url);
  const instrumented = `${fs.readFileSync(source, "utf8")}\nexport { issuePublishChangeOperation, completePublishChangeOperation };\n`;
  fs.writeFileSync(transient, instrumented, { flag: "wx" });
  try {
    return await import(`${transient.href}?test-seam=${Date.now()}`);
  } finally {
    fs.unlinkSync(transient);
  }
}
const AMBIENT_IDENTITY_ENV_KEYS = [
  "FLOW_AGENTS_ACTOR",
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "CLAUDE_CODE_SESSION_ID",
  "OPENCODE_SESSION_ID",
  "PI_SESSION_ID",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "CIRCLECI",
  "JENKINS_URL",
  "TF_BUILD",
  "BUILDKITE",
];
// Positive mutation E2E requires an independently provisioned OS-owned helper.
// Ordinary developer/CI checkouts cannot safely manufacture that trust anchor.
const externalAuthorityE2E = test.skip;
const provisionedExternalAuthorityE2E = process.env.FLOW_AGENTS_TEST_EXTERNAL_AUTHORITY === "1" ? test : test.skip;

provisionedExternalAuthorityE2E("provisioned protocol-v1 helper returns the minimal bound cancellation receipt", async () => {
  const sessionDir = process.env.FLOW_AGENTS_TEST_EXTERNAL_SESSION_DIR;
  const authorizationFile = process.env.FLOW_AGENTS_TEST_EXTERNAL_AUTHORIZATION_FILE;
  assert.ok(sessionDir && authorizationFile, "platform lane must provide its provisioned session and signed authorization fixture");
  const result = await cancelBuilderFlowSession({ sessionDir, authorizationFile });
  assert.deepEqual(Object.keys(result).sort(), ["completion", "operation_status", "run_id"]);
  assert.equal(result.run_id, path.basename(path.resolve(sessionDir)));
  assert.ok(["applied", "replayed"].includes(result.operation_status));
  assert.equal(result.completion.run_id, result.run_id);
});

function makeSession(slug = "runtime-projection") {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-builder-runtime-"));
  const artifactRoot = path.join(projectRoot, ".kontourai", "flow-agents");
  const sessionDir = path.join(artifactRoot, slug);
  writeJson(path.join(sessionDir, "state.json"), {
    schema_version: "1.0",
    task_slug: slug,
    status: "planned",
    phase: "planning",
    updated_at: NOW,
    work_item_refs: [SUBJECT],
    next_action: { status: "continue", summary: "Start Builder." },
  });
  writeJson(path.join(artifactRoot, "current.json"), {
    active_slug: slug,
    artifact_dir: `.kontourai/flow-agents/${slug}`,
    updated_at: NOW,
  });
  fs.mkdirSync(path.join(projectRoot, "review-target"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "review-target", "implementation.txt"), "reviewed implementation\n");
  fs.writeFileSync(path.join(projectRoot, "review-target", "delivery.md"), "reviewed delivery artifact\n");
  return { projectRoot, artifactRoot, sessionDir, slug };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function runWorkflowProcess(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "../../build/src/cli.js"), "workflow", ...args], { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => { if (code !== 0) process.stderr.write(stderr); resolve(code); });
  });
}

test("shell output cannot spoof an executed-test count", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-test-count-"));
  fs.mkdirSync(path.join(root, "checks"), { recursive: true });
  fs.writeFileSync(path.join(root, "checks", "fake-test.sh"), "#!/bin/sh\nset -e\nprintf '1 passed\\n'\n");
  fs.writeFileSync(path.join(root, "checks", "real-test.sh"), "#!/bin/sh\nset -e\ntest -f checks/real-test.sh\n");
  assert.equal(inferExecutedTestCount("sh checks/fake-test.sh", root, "1 passed\n"), 0);
  assert.equal(inferExecutedTestCount("sh checks/real-test.sh", root, "1..1\nok 1 - file exists\n"), 1);
});

test("pre-chain critique migration is deterministic and never rewrites legacy reviewer attribution", () => {
  // Hermetic analogue of a real pre-chain history: many disputed reviews from mixed
  // ephemeral identities followed by repeated PASS observations. Values are synthetic;
  // only key absence, cardinality, and lifecycle shape are retained.
  const laneCounts = [5, 1, 1, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1];
  const findingCounts = [6, 2, 3, 2, 2, 1, 1, 1, 1, 1, 1, 0, 0];
  const legacy = laneCounts.map((laneCount, index) => ({
    reviewer: `ephemeral-reviewer-${(index % 4) + 1}`,
    reviewed_at: `2030-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
    verdict: index < 11 ? "fail" : "pass", summary: `synthetic review ${index + 1}`,
    lanes: Array.from({ length: laneCount }, (_, lane) => ({ id: `lane-${lane + 1}`, status: index < 11 ? "fail" : "pass" })),
    findings: Array.from({ length: findingCounts[index] }, (_, finding) => ({ id: `finding-${finding + 1}`, status: "open" })),
    review_target: { artifacts: [{ path: `fixtures/artifact-${index + 1}.txt`, sha256: "a".repeat(64) }] }, workflow_subject_ref: "work-item:synthetic",
  }));
  assert.doesNotMatch(JSON.stringify(legacy), /604|change-provider|kontourai|codex|github|\/Users\//i, "public fixture shape must contain no source-session identifiers");
  const first = normalizeCritiqueChainRecords(structuredClone(legacy));
  const copied = normalizeCritiqueChainRecords(structuredClone(legacy));
  assert.equal(first.migrated, true);
  assert.deepEqual(first.records, copied.records, "a copied real-shape legacy history receives identical versioned anchors");
  assert.deepEqual(first.records.map((record) => record.reviewer), legacy.map((record) => record.reviewer));
  assert.equal(first.records[0].critique_predecessor_hash, CRITIQUE_CHAIN_GENESIS);
  assert.equal(first.records[1].critique_predecessor_hash, first.records[0].critique_record_hash);
});

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function consumedAuthorizationRecords(session) {
  const directory = path.join(session.artifactRoot, "lifecycle-authority", "consumed");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).sort().map((name) => readJson(path.join(directory, name)));
}

function claimSessionAssignment(session) {
  performLocalClaim(session.artifactRoot, session.slug, ACTOR, {
    ttlSeconds: 1800,
    actorKey: ACTOR_KEY,
    branch: `agent/${session.slug}`,
    artifactDir: session.slug,
    workItemRef: SUBJECT,
    reason: "test",
  });
}

function claimAmbientSessionAssignment(session) {
  const ambient = resolveCurrentAssignmentActor();
  performLocalClaim(session.artifactRoot, session.slug, ambient.actor, {
    ttlSeconds: 1800,
    actorKey: ambient.actorKey,
    branch: `agent/${session.slug}`,
    artifactDir: session.slug,
    workItemRef: SUBJECT,
    reason: "test",
  });
  return ambient;
}

function lifecycleAuthorization(session, operation, name, overrides = {}) {
  const file = path.join(session.projectRoot, `${name}.authorization.json`);
  const unsigned = {
    schema_version: "1.0",
    operation,
    run_id: session.slug,
    subject: SUBJECT,
    assignment_actor_key: ACTOR_KEY,
    assignment_actor: ACTOR,
    nonce: `${session.slug}:${name}`,
    expires_at: "2026-07-09T21:00:00.000Z",
    request: {
      reason: `${name} requested by fixture`,
      authority: {
        kind: "user_request",
        actor: "fixture-user",
        request_ref: `fixture://request/${name}`,
        requested_at: NOW,
      },
    },
    ...overrides,
  };
  const value = {
    ...unsigned,
    signature: {
      algorithm: "ed25519",
      key_id: AUTHORITY_KEY_ID,
      value: sign(null, Buffer.from(builderLifecycleAuthorizationPayload(unsigned)), AUTHORITY_KEYS.privateKey).toString("base64"),
    },
  };
  writeJson(file, value);
  return file;
}

function liveLifecycleAuthorization(session, operation, name, overrides = {}) {
  const requestedAt = new Date();
  return lifecycleAuthorization(session, operation, name, {
    expires_at: new Date(requestedAt.getTime() + 60 * 60_000).toISOString(),
    request: {
      reason: `${name} requested by fixture`,
      authority: {
        kind: "user_request",
        actor: "fixture-user",
        request_ref: `fixture://request/${name}`,
        requested_at: requestedAt.toISOString(),
      },
    },
    ...overrides,
  });
}

function expiredLifecycleAuthorization(session, operation, name, overrides = {}) {
  const requestedAt = new Date(Date.now() - 120_000);
  return lifecycleAuthorization(session, operation, name, {
    expires_at: new Date(Date.now() - 60_000).toISOString(),
    request: {
      reason: `${name} requested by fixture`,
      authority: {
        kind: "user_request",
        actor: "fixture-user",
        request_ref: `fixture://request/${name}`,
        requested_at: requestedAt.toISOString(),
      },
    },
    ...overrides,
  });
}

function critiqueResolutionAuthorization(session, priorRecordId, resolvingRecordId, resolver, name = "resolve", overrides = {}) {
  const bundleFile = path.join(session.sessionDir, "trust.bundle");
  const bundle = readJson(bundleFile);
  const critiqueClaims = bundle.claims.filter((claim) => claim.metadata?.origin === "critique");
  const normalized = normalizeCritiqueChainRecords(critiqueClaims.map((claim) => ({
    ...claim.metadata,
    verdict: claim.value,
    summary: claim.fieldOrBehavior,
  }))).records;
  const metadata = (id) => {
    const existing = critiqueClaims.find((claim) => claim.metadata?.critique_record_id === id)?.metadata;
    if (existing) return existing;
    return normalized.find((record) => record.critique_record_id === id);
  };
  const now = new Date();
  const prior = metadata(priorRecordId);
  const resolving = metadata(resolvingRecordId);
  const priorSnapshot = prior.review_target?.workspace_snapshot ?? {};
  const resolvingSnapshot = resolving.review_target?.workspace_snapshot ?? {};
  const unsigned = {
    schema_version: "1.0", operation: "resolve-critique", run_id: session.slug, subject: SUBJECT,
    prior_bundle_sha256: createHash("sha256").update(fs.readFileSync(bundleFile)).digest("hex"),
    prior_record_id: priorRecordId, prior_record_hash: prior.critique_record_hash,
    resolving_record_id: resolvingRecordId, resolving_record_hash: resolving.critique_record_hash,
    expected_resolver: resolver,
    resolved_lane_ids: (prior.lanes ?? []).filter((lane) => lane.status !== "pass").map((lane) => lane.id).sort(),
    resolved_finding_ids: (prior.findings ?? []).filter((finding) => finding.status === "open").map((finding) => finding.id).sort(),
    prior_snapshot_sha256: priorSnapshot.digest, resolving_snapshot_sha256: resolvingSnapshot.digest,
    prior_head_sha: priorSnapshot.head_sha ?? "none", resolving_head_sha: resolvingSnapshot.head_sha ?? "none",
    nonce: `${name}-${Date.now()}-${Math.random()}`,
    expires_at: new Date(now.getTime() + 60_000).toISOString(), requested_at: now.toISOString(),
    ...overrides,
  };
  const value = { ...unsigned, signature: { algorithm: "ed25519", key_id: AUTHORITY_KEY_ID, value: sign(null, Buffer.from(critiqueResolutionAuthorizationPayload(unsigned)), AUTHORITY_KEYS.privateKey).toString("base64") } };
  const file = path.join(session.sessionDir, `${name}.authorization.json`);
  writeJson(file, value);
  return file;
}


function snapshotFile(file) {
  return fs.existsSync(file) ? fs.readFileSync(file).toString("base64") : null;
}

function snapshotTree(directory) {
  if (!fs.existsSync(directory)) return null;
  const files = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else files.push([path.relative(directory, absolute), fs.readFileSync(absolute).toString("base64")]);
    }
  }
  visit(directory);
  return files;
}

function snapshotProjectionTargets(session) {
  const actorRoot = path.join(session.artifactRoot, "current");
  const actors = fs.existsSync(actorRoot)
    ? fs.readdirSync(actorRoot).filter((name) => name.endsWith(".json")).sort()
    : [];
  return {
    state: snapshotFile(path.join(session.sessionDir, "state.json")),
    current: snapshotFile(path.join(session.artifactRoot, "current.json")),
    actors: actors.map((name) => [name, snapshotFile(path.join(actorRoot, name))]),
  };
}

async function assertRecoveryRejectsWithoutWrites(session, pattern) {
  const flowDirectory = runDir(session.slug, session.projectRoot);
  const beforeFlow = snapshotTree(flowDirectory);
  const beforeProjection = snapshotProjectionTargets(session);
  await assert.rejects(() => recoverBuilderFlowSession({ sessionDir: session.sessionDir }), pattern);
  assert.deepEqual(snapshotTree(flowDirectory), beforeFlow);
  assert.deepEqual(snapshotProjectionTargets(session), beforeProjection);
}

function bundleClaim({ expectation, claimType, subjectType, status = "pass", routeReason, subject = SUBJECT, testCount = 1, timestamp = new Date().toISOString() }) {
  const stepByExpectation = {
    "selected-work": "pull-work",
    "pickup-probe-readiness": "design-probe",
    "probe-decisions-or-accepted-gaps": "design-probe",
    "implementation-plan": "plan",
    "implementation-scope": "execute",
    "clean-critique": "verify",
    "tests-evidence": "verify",
    "verified-criterion": "verify",
    "merge-readiness": "merge-ready",
  };
  const claimId = `claim.${expectation}`;
  return {
    claim: {
      id: claimId,
      subjectType,
      subjectId: `runtime-projection/gate-claim-${expectation}`,
      claimType,
      fieldOrBehavior: `${expectation} fixture`,
      value: status,
      metadata: {
        workflow_subject_ref: subject,
        origin: "check",
        check_kind: "external",
        ...(expectation === "tests-evidence" ? {
          recorded_by: "implementation-actor",
          artifact_refs: [{ kind: "command", excerpt: "node --test src/cli/builder-flow-runtime.test.mjs", summary: "Runtime fixture assertion." }],
          observed_commands: [{ command: "node --test src/cli/builder-flow-runtime.test.mjs", exit_code: 0, test_count: testCount, output_sha256: "0".repeat(64) }],
        } : {}),
        gate_claim: {
          expectation_id: expectation,
          claim_type: claimType,
          subject_type: subjectType,
          ...(stepByExpectation[expectation] ? { step_id: stepByExpectation[expectation], recorded_at: timestamp, identity_version: 2 } : {}),
          ...(routeReason ? { route_reason: routeReason } : {}),
        },
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    evidence: {
      id: `evidence.${expectation}`,
      claimId,
      evidenceType: "human_attestation",
      method: "attestation",
      sourceRef: "src/cli/builder-flow-runtime.test.mjs",
      excerptOrSummary: `${expectation} fixture`,
      observedAt: timestamp,
      collectedBy: "flow-agents-test",
    },
    event: {
      id: `event.${expectation}`,
      claimId,
      status: status === "pass" ? "verified" : "disputed",
      actor: "flow-agents-test",
      method: "attestation",
      evidenceIds: [`evidence.${expectation}`],
      createdAt: timestamp,
      verifiedAt: timestamp,
    },
  };
}

function verifiedTestsPrerequisites(session, timestamp = new Date().toISOString()) {
  const reviewArtifact = path.join(session.projectRoot, "review-target", "delivery.md");
  const implementation = path.join(session.projectRoot, "review-target", "implementation.txt");
  const implementationFile = path.relative(session.projectRoot, implementation);
  const implementationBytes = fs.readFileSync(implementation);
  const implementationSha256 = createHash("sha256").update(implementationBytes).digest("hex");
  const workspaceDigest = createHash("sha256")
    .update("flow-agents:reviewed-files:v1\0")
    .update(implementationFile).update("\0").update(implementationBytes).update("\0")
    .digest("hex");
  const critique = bundleClaim({ expectation: "clean-critique", claimType: "workflow.critique.review", subjectType: "workflow-critique", timestamp });
  critique.claim.metadata = {
    workflow_subject_ref: SUBJECT,
    origin: "critique",
    reviewer: "reviewer-actor",
    findings: [],
    lanes: [{ id: "code", status: "pass" }],
    review_target: {
      artifacts: [{ file: path.relative(session.projectRoot, reviewArtifact), sha256: createHash("sha256").update(fs.readFileSync(reviewArtifact)).digest("hex") }],
      workspace_snapshot: {
        version: 1,
        kind: "reviewed-files",
        algorithm: "sha256",
        digest: workspaceDigest,
        files: [{ file: implementationFile, sha256: implementationSha256 }],
      },
    },
  };
  const critiqueRecord = {
    critique_sequence: 1,
    critique_predecessor_hash: CRITIQUE_CHAIN_GENESIS,
    reviewer: critique.claim.metadata.reviewer,
    reviewed_at: timestamp,
    verdict: critique.claim.value,
    summary: critique.claim.fieldOrBehavior,
    lanes: critique.claim.metadata.lanes,
    review_target: critique.claim.metadata.review_target,
    findings: critique.claim.metadata.findings,
    workflow_subject_ref: SUBJECT,
  };
  critique.claim.metadata.reviewed_at = timestamp;
  critique.claim.metadata.critique_sequence = 1;
  critique.claim.metadata.critique_predecessor_hash = CRITIQUE_CHAIN_GENESIS;
  critique.claim.metadata.critique_record_hash = critiqueRecordHash(critiqueRecord);
  critique.claim.metadata.critique_record_id = `critique:${critique.claim.metadata.critique_record_hash}`;
  critique.claim.status = "verified";
  const criterion = bundleClaim({ expectation: "verified-criterion", claimType: "workflow.acceptance.criterion", subjectType: "flow-step", timestamp });
  criterion.claim.metadata = {
    workflow_subject_ref: SUBJECT,
    origin: "acceptance",
    criterion: { id: "ac-runtime", status: "pass", evidence_refs: [{ kind: "command", excerpt: "node --test src/cli/builder-flow-runtime.test.mjs", summary: "Runtime fixture assertion." }] },
  };
  return [critique, criterion];
}

function restampCritiqueClaim(claim) {
  const metadata = claim.claim.metadata;
  metadata.critique_record_hash = critiqueRecordHash({
    critique_sequence: metadata.critique_sequence,
    critique_predecessor_hash: metadata.critique_predecessor_hash,
    reviewer: metadata.reviewer,
    reviewed_at: metadata.reviewed_at,
    verdict: claim.claim.value,
    summary: claim.claim.fieldOrBehavior,
    lanes: metadata.lanes,
    review_target: metadata.review_target,
    findings: metadata.findings,
    workflow_subject_ref: metadata.workflow_subject_ref,
  });
  metadata.critique_record_id = `critique:${metadata.critique_record_hash}`;
  return claim;
}

function appendCritiqueAfter(prior, current) {
  restampCritiqueClaim(prior);
  current.claim.metadata.critique_sequence = prior.claim.metadata.critique_sequence + 1;
  current.claim.metadata.critique_predecessor_hash = prior.claim.metadata.critique_record_hash;
  return restampCritiqueClaim(current);
}

function asPreChainCritique(entry, suffix) {
  const copy = withIdentitySuffix(entry, suffix);
  delete copy.claim.metadata.critique_sequence;
  delete copy.claim.metadata.critique_predecessor_hash;
  delete copy.claim.metadata.critique_record_hash;
  delete copy.claim.metadata.critique_record_id;
  return copy;
}

function writeBundle(sessionDir, entries) {
  writeJson(path.join(sessionDir, "trust.bundle"), {
    schemaVersion: 5,
    source: "flow-agents-builder-runtime-test",
    claims: entries.map((entry) => entry.claim),
    evidence: entries.map((entry) => entry.evidence),
    policies: [],
    events: entries.map((entry) => entry.event),
  });
}

function historicalProducerSuperseded(entry, suffix = "historical") {
  const copy = withIdentitySuffix(entry, suffix);
  copy.claim.producerStatus = "superseded";
  return copy;
}

function withIdentitySuffix(entry, suffix) {
  const copy = structuredClone(entry);
  const priorId = copy.claim.id;
  copy.claim.id = `${priorId}.${suffix}`;
  copy.evidence.id = `${copy.evidence.id}.${suffix}`;
  copy.evidence.claimId = copy.claim.id;
  copy.event.id = `${copy.event.id}.${suffix}`;
  copy.event.claimId = copy.claim.id;
  copy.event.evidenceIds = [copy.evidence.id];
  return copy;
}

async function writeAndSync(session, entries) {
  writeBundle(session.sessionDir, entries);
  return syncBuilderFlowSession({ sessionDir: session.sessionDir });
}

test("small-model client can start and advance from projected actions without choosing Flow steps", async () => {
  const session = makeSession();
  const started = await startBuilderFlowSession({ sessionDir: session.sessionDir });

  assert.equal(started.run.state.current_step, "pull-work");
  assert.deepEqual(started.projection.next_action.skills, ["pull-work"]);
  assert.deepEqual(started.projection.next_action.operations, []);
  assert.match(started.projection.next_action.command, /^sh -c /);
  assert.match(started.projection.next_action.command, /--prefix "\$root"/);
  assert.ok(started.projection.next_action.command.includes(`'@kontourai/flow-agents@${PACKAGE_VERSION}'`));
  assert.ok(started.projection.next_action.command.includes(`'workflow' 'status' '--session-dir' '.kontourai/flow-agents/${session.slug}' '--json'`));
  const envelope = started.gateActionEnvelope;
  assert.equal(Object.hasOwn(started.projection.next_action, "gate_action_envelope"), false, "durable state has no duplicate envelope");
  assert.equal(envelope.schema_version, "3.0");
  assert.equal(envelope.gate.requirements[0].gate_id, "pull-work-gate");
  assert.equal(envelope.action.implementation_allowed, false, "implementation is forbidden before builder.build/execute");
  assert.deepEqual(envelope.action.declared_evidence, ["selected-work"]);
  assert.deepEqual(envelope.action.declared_artifacts, [
    { kind: "file", ref: "<slug>--pull-work.md", path: `.kontourai/flow-agents/${session.slug}/${session.slug}--pull-work.md`, direct_write_allowed: true, produced_via: { interface: "skill", skill_ids: ["pull-work"] } },
    { kind: "trust_slice", ref: "trust.bundle#selected-work", bundle_file: "trust.bundle", slice_id: "selected-work", direct_write_allowed: false, record_via: ["workflow.evidence"] },
  ]);
  assert.deepEqual(envelope.action.artifact_bindings, envelope.action.declared_artifacts.map((target) => ({
    target,
    expectation_ids: ["selected-work"],
  })));
  assert.equal(envelope.stop_condition.kind, "one_turn");
  assert.equal(envelope.stop_condition.scope.current_gate_only, true);
  assert.deepEqual(envelope.stop_condition.required.unresolved_evidence_ids, ["selected-work"]);
  assert.deepEqual(envelope.stop_condition.sequence, ["activate_required_skills", "produce_declared_artifacts", "record_bound_evidence", "synchronize_canonical_flow", "return_adapter_result"]);
  assert.equal(envelope.stop_condition.adapter_evidence_is_gate_evidence, false);
  assert.equal(envelope.action.skills[0].id, "pull-work");
  assert.equal(envelope.action.skills[0].package.name, "@kontourai/flow-agents");
  assert.match(envelope.action.skills[0].path, /kits\/builder\/skills\/pull-work\/SKILL\.md$/);
  assert.match(envelope.action.skills[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(envelope.public_interfaces.mutations[0].expectation_id, "selected-work");
  assert.deepEqual(envelope.public_interfaces.status, {
    package: { name: "@kontourai/flow-agents", version: PACKAGE_VERSION },
    command: "flow-agents",
    argv: ["workflow", "status", "--session-dir", `.kontourai/flow-agents/${session.slug}`, "--json"],
  });
  assert.deepEqual(envelope.public_interfaces.mutations[0].package, { name: "@kontourai/flow-agents", version: PACKAGE_VERSION });
  assert.deepEqual(envelope.public_interfaces.mutations[0].argv.slice(0, 2), ["workflow", "evidence"]);
  assert.equal(envelope.public_interfaces.mutations[0].parameters.find((entry) => entry.name === "evidence_ref_json").value_schema_ref, "#/public_interfaces/schemas/evidence_ref_json");
  assert.deepEqual(envelope.public_interfaces.schemas.evidence_ref_json.properties.kind.enum, ["source", "command", "artifact", "provider", "external"]);
  assert.deepEqual(envelope.public_interfaces.schemas.evidence_ref_json.examples[0], { kind: "artifact", file: "<project-relative-artifact-path>", summary: "<what this artifact proves>" });
  for (const example of envelope.public_interfaces.schemas.evidence_ref_json.examples) {
    assert.deepEqual(validateEvidenceRef(structuredClone(example), "projected evidence example"), example);
  }
  assert.equal(envelope.public_interfaces.mutations[0].argv.some((value) => value.includes("<")), false, "argv contains no substitution placeholders");
  assert.ok(fs.existsSync(runDir(session.slug, session.projectRoot)));
  assert.ok(!fs.existsSync(path.join(session.projectRoot, ".flow", "runs")), "retired runtime path must not be created");

  const advanced = await writeAndSync(session, [bundleClaim({
    expectation: "selected-work",
    claimType: "builder.pull-work.selected",
    subjectType: "work-item",
  })]);

  assert.equal(advanced.attached, true);
  assert.equal(advanced.run.state.current_step, "design-probe");
  assert.deepEqual(advanced.projection.next_action.skills, ["pickup-probe"]);
  assert.equal(advanced.gateActionEnvelope.action.implementation_allowed, false);
  assert.equal(advanced.gateActionEnvelope.progress.canonical_evidence.some((entry) => entry.startsWith("pull-work-gate:")), true, "advancing evidence remains attributable after the step namespace changes");
  assert.equal(readJson(path.join(session.artifactRoot, "current.json")).active_step_id, "design-probe");

  const duplicate = await syncBuilderFlowSession({ sessionDir: session.sessionDir });
  assert.equal(duplicate.attached, false);
  assert.equal(duplicate.run.manifest.evidence.length, advanced.run.manifest.evidence.length);
});

test("gate-action implementation policy permits code only at builder.build/execute", async () => {
  const session = makeSession("gate-action-implementation-policy");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  await writeAndSync(session, [bundleClaim({ expectation: "selected-work", claimType: "builder.pull-work.selected", subjectType: "work-item" })]);
  await writeAndSync(session, [
    bundleClaim({ expectation: "pickup-probe-readiness", claimType: "builder.design-probe.pickup-readiness", subjectType: "work-item" }),
    bundleClaim({ expectation: "probe-decisions-or-accepted-gaps", claimType: "builder.design-probe.decisions", subjectType: "decision" }),
  ]);
  const executing = await writeAndSync(session, [bundleClaim({ expectation: "implementation-plan", claimType: "builder.plan.implementation", subjectType: "artifact" })]);
  assert.equal(executing.run.state.current_step, "execute");
  assert.equal(executing.gateActionEnvelope.action.implementation_allowed, true);
  assert.equal(executing.gateActionEnvelope.action.declared_artifacts.some((artifact) => artifact.ref === "state.json"), false, "control state is not a declared model artifact");
  assert.equal(executing.gateActionEnvelope.stop_condition.required.artifact_refs.some((artifact) => artifact.ref === "state.json"), false, "control state is not a required model artifact");
  assert.equal(executing.gateActionEnvelope.progress.observed_artifacts.some((entry) => entry.startsWith("state.json:")), false, "control state never counts as progress");

  const requests = [];
  await driveBuilderFlowSession({
    sessionDir: session.sessionDir,
    maxTurns: 2,
    execute: async (request) => { requests.push(request); return { status: "completed" }; },
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].gate_action_envelope.progress.prior_turn.stagnation, "possible");
  const mission = readJson(path.join(session.sessionDir, "continuation-driver", "state.json"));
  assert.equal(mission.prior_progress.stagnation, "stagnant", "two no-op execute turns are true stagnation");
});

test("gate-action artifact identity reads reject symlinks and oversized files", async (t) => {
  await t.test("symlink", async () => {
    const session = makeSession("gate-action-artifact-symlink");
    const outside = path.join(session.projectRoot, "outside-release.json");
    fs.writeFileSync(outside, "{}\n");
    fs.symlinkSync(outside, path.join(session.sessionDir, "release.json"));
    await assert.rejects(startBuilderFlowSession({ sessionDir: session.sessionDir }), /ELOOP|regular file|changed identity/);
  });

  await t.test("oversized", async () => {
    const session = makeSession("gate-action-artifact-oversized");
    fs.writeFileSync(path.join(session.sessionDir, "release.json"), Buffer.alloc(1_048_577));
    await assert.rejects(startBuilderFlowSession({ sessionDir: session.sessionDir }), /bounded regular file/);
  });
});

test("Builder projection preserves Flow continuation semantics for exceptional statuses", async () => {
  const session = makeSession("continuation-status-projection");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  const stateFile = path.join(runDir(session.slug, session.projectRoot), "state.json");
  const original = readJson(stateFile);
  for (const [status, expected] of [
    ["blocked", "continue"],
    ["accepted_by_exception", "continue"],
    ["needs_decision", "blocked"],
    ["failed", "failed"],
  ]) {
    writeJson(stateFile, { ...original, status, next_action: `fixture ${status}` });
    const recovered = await recoverBuilderFlowSession({ sessionDir: session.sessionDir });
    assert.equal(recovered.projection.next_action.status, expected, status);
  }
});

test("accepted Flow exceptions explicitly waive the current envelope requirements", async () => {
  const session = makeSession("accepted-exception-envelope");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  const exception = await acceptException(session.slug, {
    cwd: session.projectRoot,
    gate: "pull-work-gate",
    reason: "authorized fixture waiver",
    authority: "test-reviewer",
  });
  const recovered = await recoverBuilderFlowSession({ sessionDir: session.sessionDir });
  assert.deepEqual(recovered.gateActionEnvelope.gate.accepted_exceptions, [{ gate_id: "pull-work-gate", exception_id: exception.id }]);
  assert.equal(recovered.gateActionEnvelope.gate.requirements[0].gate_id, "pull-work-gate");
  assert.equal(recovered.gateActionEnvelope.gate.requirements[0].status, "accepted_exception");
  assert.deepEqual(recovered.gateActionEnvelope.stop_condition.required.unresolved_evidence_ids, []);
  assert.deepEqual(recovered.gateActionEnvelope.stop_condition.required.artifact_refs, []);
  assert.deepEqual(recovered.gateActionEnvelope.stop_condition.required.skill_ids, []);
  const synchronized = await syncBuilderFlowSession({ sessionDir: session.sessionDir });
  assert.equal(synchronized.attached, false);
  assert.equal(synchronized.run.state.current_step, "design-probe");
  assert.deepEqual(synchronized.gateActionEnvelope.action.skills.map((skill) => skill.id), ["pickup-probe"]);
});

test("all-optional effective Flow gate overrides advance during canonical sync without bundle evidence", async () => {
  const session = makeSession("gate-override-envelope");
  const config = defaultFlowConfig();
  config.gate_overrides["pull-work-gate"] = { expectations: { "selected-work": { required: false } } };
  fs.mkdirSync(path.dirname(flowConfigPath(session.projectRoot)), { recursive: true });
  writeJson(flowConfigPath(session.projectRoot), config);
  const unevaluated = await startBuilderFlowRun({ cwd: session.projectRoot, runId: session.slug, subject: SUBJECT, flowId: "builder.build" });
  const directEnvelope = deriveBuilderGateActionEnvelope({
    sessionDir: session.sessionDir,
    projectRoot: session.projectRoot,
    run: unevaluated,
    definition: readJson(path.join(unevaluated.dir, "definition.json")),
  });
  assert.deepEqual(directEnvelope.stop_condition.required.skill_ids, []);
  fs.rmSync(unevaluated.dir, { recursive: true, force: true });
  const started = await startBuilderFlowSession({ sessionDir: session.sessionDir });
  assert.equal(started.attached, false);
  assert.equal(started.run.state.current_step, "design-probe");
  assert.deepEqual(started.gateActionEnvelope.action.skills.map((skill) => skill.id), ["pickup-probe"]);
  assert.equal(started.gateActionEnvelope.flow.current_step, "design-probe");
});

test("weak structured consumer advances real Builder gates through envelope public interfaces", async () => {
  const session = makeSession("continuation-driver-two-steps");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  const visited = [];

  const result = await driveBuilderFlowSession({
    sessionDir: session.sessionDir,
    maxTurns: 2,
    execute: async (request) => {
      visited.push(request.current_step);
      const expectationIds = request.gate_action_envelope.public_interfaces.mutations.map((mutation) => mutation.expectation_id);
      if (expectationIds.includes("selected-work")) {
        writeBundle(session.sessionDir, [bundleClaim({
          expectation: "selected-work",
          claimType: "builder.pull-work.selected",
          subjectType: "work-item",
        })]);
      } else if (expectationIds.includes("pickup-probe-readiness")) {
        writeBundle(session.sessionDir, [
          bundleClaim({
            expectation: "pickup-probe-readiness",
            claimType: "builder.design-probe.pickup-readiness",
            subjectType: "work-item",
          }),
          bundleClaim({
            expectation: "probe-decisions-or-accepted-gaps",
            claimType: "builder.design-probe.decisions",
            subjectType: "decision",
          }),
        ]);
      } else {
        assert.fail(`unexpected public mutation set ${expectationIds.join(",")}`);
      }
      return { status: "completed", summary: `completed ${request.current_step}` };
    },
  });

  assert.equal(result.outcome, "budget_exhausted");
  assert.equal(result.turns_started, 2);
  assert.deepEqual(visited, ["pull-work", "design-probe"]);
  assert.equal(result.snapshot.current_step, "plan");
  assert.equal(result.snapshot.next_action.skills[0], "plan-work");
  const driverState = readJson(path.join(session.sessionDir, "continuation-driver", "state.json"));
  assert.equal(driverState.status, "budget_exhausted");
  assert.equal(driverState.turns_started, 2);
  const events = fs.readFileSync(path.join(session.sessionDir, "continuation-driver", "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.filter((event) => event.type === "turn_started").map((event) => event.current_step), ["pull-work", "design-probe"]);
});

test("public workflow evidence accepts only live signed turn authority after ordinary ancestry resolution mismatches", async () => {
  const session = makeSession("continuation-driver-cli");
  claimAmbientSessionAssignment(session);
  fs.writeFileSync(path.join(session.projectRoot, "AGENTS.md"), "# Test Repo\n");
  fs.writeFileSync(path.join(session.sessionDir, `${session.slug}--deliver.md`), "# Continuation\n\nstatus: executing\ntype: deliver\n");
  fs.writeFileSync(path.join(session.sessionDir, `${session.slug}--pull-work.md`), "# Pull Work\n\nSelected continuation fixture.\n");
  writeJson(path.join(session.sessionDir, "acceptance.json"), {
    schema_version: "1.0",
    task_slug: session.slug,
    source_request: "Advance a bounded continuation through public workflow evidence.",
    criteria: [{
      id: "AC-1",
      description: "The complete continuation reaches its terminal workflow gate.",
      status: "pending",
      evidence_refs: [],
    }],
    goal_fit: { status: "pending", summary: "The bounded continuation is still active." },
  });
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  const unrelatedSlug = "unrelated-pointer-session";
  const unrelatedDir = path.join(session.artifactRoot, unrelatedSlug);
  fs.mkdirSync(unrelatedDir, { recursive: true });
  fs.writeFileSync(path.join(unrelatedDir, `${unrelatedSlug}--deliver.md`), "# Unrelated\n\nstatus: executing\ntype: deliver\n");
  writeJson(path.join(unrelatedDir, "state.json"), {
    schema_version: "1.0", task_slug: unrelatedSlug, status: "executing", phase: "execution",
    updated_at: new Date().toISOString(), next_action: { status: "continue", summary: "Unrelated work" },
  });
  writeJson(path.join(session.artifactRoot, "current.json"), { active_slug: unrelatedSlug, artifact_dir: unrelatedSlug });
  const adapter = path.join(session.projectRoot, "adapter.mjs");
  const commandFile = path.join(session.projectRoot, "adapter-command.json");
  const authorityFile = path.join(session.sessionDir, "continuation-driver", "active-turn.json");
  fs.writeFileSync(adapter, `
    import fs from "node:fs";
    import { spawnSync } from "node:child_process";
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const request = JSON.parse(input);
    fs.writeFileSync("adapter-request.json", input);
    const evidenceEnv = { ...process.env };
    for (const key of ${JSON.stringify(AMBIENT_IDENTITY_ENV_KEYS)}) delete evidenceEnv[key];
    const ordinaryChild = ${JSON.stringify(path.resolve(import.meta.dirname, "../../scripts/hooks/lib/actor-identity.js"))};
    const childIdentity = (await import("node:module")).createRequire(import.meta.url)(ordinaryChild).resolveActorIdentity(evidenceEnv);
    const record = (expectation) => {
      const binding = request.gate_action_envelope.public_interfaces.mutations.find((entry) => entry.expectation_id === expectation && entry.interface === "workflow.evidence");
      if (!binding) throw new Error("missing workflow.evidence binding for " + expectation);
      const evidence = { kind: "artifact", file: ${JSON.stringify(`.kontourai/flow-agents/${session.slug}/${session.slug}--pull-work.md`)}, summary: "adapter child records " + expectation };
      return spawnSync(process.execPath, [${JSON.stringify(path.resolve(import.meta.dirname, "../../build/src/cli.js"))}, ...binding.argv, "--status", "pass", "--summary", "adapter child records " + expectation, "--evidence-ref-json", JSON.stringify(evidence)], { cwd: ${JSON.stringify(session.projectRoot)}, encoding: "utf8", env: evidenceEnv });
    };
    const evidenceRuns = request.current_step === "pull-work"
      ? [record("selected-work")]
      : [record("pickup-probe-readiness"), record("probe-decisions-or-accepted-gaps")];
    if (evidenceRuns.some((result) => result.status !== 0)) {
      fs.writeFileSync("adapter-evidence-error.json", JSON.stringify(evidenceRuns.map((result) => ({ status: result.status, stderr: result.stderr, stdout: result.stdout }))));
      throw new Error("public workflow evidence rejected signed adapter authority: " + evidenceRuns.map((result) => result.stderr).join("\\n"));
    }
    const lifecycleRuns = [
      ["pause", "--reason", "capability must not pause"],
      ["resume"],
      ["release", "--reason", "capability must not release"],
      ["cancel"],
      ["archive"],
    ].map((args) => spawnSync(process.execPath, [${JSON.stringify(path.resolve(import.meta.dirname, "../../build/src/cli.js"))}, "workflow", ...args, "--session-dir", ${JSON.stringify(session.sessionDir)}], { cwd: ${JSON.stringify(session.projectRoot)}, encoding: "utf8", env: evidenceEnv }));
    const currentPointer = (await import("node:module")).createRequire(import.meta.url)(${JSON.stringify(path.resolve(import.meta.dirname, "../../scripts/hooks/lib/current-pointer.js"))});
    currentPointer.writePerActorCurrent(${JSON.stringify(session.artifactRoot)}, childIdentity.actor, { active_slug: ${JSON.stringify(unrelatedSlug)}, artifact_dir: ${JSON.stringify(unrelatedSlug)} });
    fs.writeFileSync(${JSON.stringify(path.join(session.artifactRoot, "current.json"))}, JSON.stringify({ active_slug: ${JSON.stringify(unrelatedSlug)}, artifact_dir: ${JSON.stringify(unrelatedSlug)} }));
    const unrelatedAssignment = ${JSON.stringify(path.join(session.artifactRoot, "assignment", `${unrelatedSlug}.json`))};
    fs.mkdirSync((await import("node:path")).dirname(unrelatedAssignment), { recursive: true });
    fs.writeFileSync(unrelatedAssignment, JSON.stringify({ schema_version: "1.0", role: "AssignmentClaimRecord", subject_id: ${JSON.stringify(unrelatedSlug)}, actor: childIdentity.actorStruct, actor_key: childIdentity.actor, artifact_dir: ${JSON.stringify(unrelatedSlug)}, status: "claimed" }));
    const canonicalState = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(runDir(session.slug, session.projectRoot), "state.json"))}, "utf8"));
    const authorityValidation = (await import("node:module")).createRequire(import.meta.url)(${JSON.stringify(path.resolve(import.meta.dirname, "../../scripts/hooks/lib/continuation-turn-authority.js"))}).validateActiveTurnAuthority({ sessionDir: ${JSON.stringify(session.sessionDir)}, runId: process.env.FLOW_AGENTS_CONTINUATION_RUN_ID, turnSecret: process.env.FLOW_AGENTS_CONTINUATION_TURN_SECRET, canonicalState });
    const hookEnv = { ...process.env, FLOW_AGENTS_GOAL_FIT_MODE: "block" };
    const hook = spawnSync(process.execPath, [${JSON.stringify(path.resolve(import.meta.dirname, "../../scripts/hooks/stop-goal-fit.js"))}], { cwd: ${JSON.stringify(session.projectRoot)}, input: JSON.stringify({ hook_event_name: "Stop", cwd: ${JSON.stringify(session.projectRoot)} }), encoding: "utf8", env: hookEnv });
    fs.writeFileSync("adapter-authority.json", JSON.stringify({ turnSecret: process.env.FLOW_AGENTS_CONTINUATION_TURN_SECRET || null, runId: process.env.FLOW_AGENTS_CONTINUATION_RUN_ID || null, childIdentity, evidenceRuns: evidenceRuns.map((result) => ({ status: result.status, stderr: result.stderr })), lifecycleRuns: lifecycleRuns.map((result) => ({ status: result.status, stderr: result.stderr })), unrelatedAssignment: JSON.parse(fs.readFileSync(unrelatedAssignment, "utf8")), unrelatedHandoffExists: fs.existsSync(${JSON.stringify(path.join(unrelatedDir, "handoff.json"))}), active: fs.existsSync(${JSON.stringify(authorityFile)}), authorityValidation, hookStatus: hook.status, hookStderr: hook.stderr }));
    if (hook.status !== 0) throw new Error("Stop hook blocked canonical continuation: " + hook.stderr);
    process.stdout.write(JSON.stringify({ status: "completed", summary: "adapter advanced " + request.current_step }));
  `);
  writeJson(commandFile, { argv: [process.execPath, adapter] });

  const rc = await workflowMain([
    "drive",
    "--session-dir", session.sessionDir,
    "--adapter-command-file", commandFile,
    "--context-policy", "fresh",
    "--max-turns", "2",
    // This adapter intentionally performs several nested CLI and Stop-hook
    // subprocesses. Keep the timeout bounded while allowing the same contract
    // test to run alongside the provider/security suites on slower CI workers.
    "--turn-timeout-ms", "30000",
    "--barrier-wait-ms", "0",
    "--json",
  ]);

  assert.equal(rc, 0);
  const request = readJson(path.join(session.projectRoot, "adapter-request.json"));
  assert.equal(request.current_step, "design-probe", fs.existsSync(path.join(session.projectRoot, "adapter-evidence-error.json")) ? fs.readFileSync(path.join(session.projectRoot, "adapter-evidence-error.json"), "utf8") : "adapter did not advance canonical Flow");
  assert.deepEqual(request.next_action.skills, ["pickup-probe"]);
  assert.deepEqual(request.context_strategy, { thread: "new", handoff: "canonical", reason: "configured_policy" });
  assert.equal(Object.hasOwn(request, "system_prompt"), false);
  const authority = readJson(path.join(session.projectRoot, "adapter-authority.json"));
  assert.match(authority.turnSecret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(authority.runId, session.slug);
  assert.equal(authority.childIdentity.source, "process-ancestry");
  assert.ok(authority.evidenceRuns.every((result) => result.status === 0), JSON.stringify(authority.evidenceRuns));
  assert.ok(authority.lifecycleRuns.every((result) => result.status !== 0), JSON.stringify(authority.lifecycleRuns));
  assert.equal(authority.unrelatedAssignment.status, "claimed", "Stop does not release the unrelated per-actor/global-pointer session");
  assert.equal(authority.unrelatedHandoffExists, false, "Stop does not relax or hand off the unrelated session");
  assert.equal(authority.active, true);
  assert.equal(authority.authorityValidation.valid, true, authority.authorityValidation.reason);
  assert.equal(authority.hookStatus, 0, `the blocking Stop hook returns control during the signed adapter turn: ${authority.hookStderr}`);
  assert.match(authority.hookStderr, /continuation driver active turn is authorized/);
  assert.match(authority.hookStderr, /Final Acceptance: 1 acceptance criterion\/criteria still pending/);
  assert.equal(fs.existsSync(authorityFile), false, "adapter turn authority is removed after the child exits");
  const driverState = readJson(path.join(session.sessionDir, "continuation-driver", "state.json"));
  assert.equal(driverState.status, "budget_exhausted");
  assert.equal(driverState.context_policy, "fresh");
  const canonical = await recoverBuilderFlowSession({ sessionDir: session.sessionDir });
  assert.equal(canonical.run.state.status, "active");
  assert.equal(canonical.run.state.current_step, "plan");
  const events = fs.readFileSync(path.join(session.sessionDir, "continuation-driver", "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.filter((event) => event.type === "turn_started").map((event) => event.current_step), ["pull-work", "design-probe"]);
  assert.equal(events.some((event) => event.type === "gate_not_advanced"), false);
  const replayEnv = { ...process.env, FLOW_AGENTS_CONTINUATION_TURN_SECRET: authority.turnSecret, FLOW_AGENTS_CONTINUATION_RUN_ID: authority.runId };
  for (const key of AMBIENT_IDENTITY_ENV_KEYS) delete replayEnv[key];
  const replay = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../../build/src/cli.js"), "workflow", "evidence", "--session-dir", session.sessionDir, "--expectation", "implementation-plan", "--status", "pass", "--summary", "replayed turn capability", "--evidence-ref-json", JSON.stringify({ kind: "artifact", file: "adapter.mjs", summary: "replay fixture" })], { cwd: session.projectRoot, encoding: "utf8", env: replayEnv });
  assert.notEqual(replay.status, 0, "copied capability values fail after active-turn cleanup");
  replayEnv.FLOW_AGENTS_CONTINUATION_TURN_SECRET = "A".repeat(43);
  const forged = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../../build/src/cli.js"), "workflow", "evidence", "--session-dir", session.sessionDir, "--expectation", "implementation-plan", "--status", "pass", "--summary", "forged turn capability", "--evidence-ref-json", JSON.stringify({ kind: "artifact", file: "adapter.mjs", summary: "forgery fixture" })], { cwd: session.projectRoot, encoding: "utf8", env: replayEnv });
  assert.notEqual(forged.status, 0, "fake nonce and digest without a signed active turn fail ownership");
});

test("signed turn evidence capacity is rejected by preflight before another bounded result", () => {
  assert.doesNotThrow(() => assertAcceptedTurnEvidenceCapacity([], { schema_version: "1.0", iteration: 1 }));
  assert.throws(
    () => assertAcceptedTurnEvidenceCapacity([{ request: { padding: "x".repeat(980_000) }, result: {} }], { schema_version: "1.0", iteration: 2 }),
    /lacks capacity for another bounded result/,
  );
});

test("public workflow drive signs adapter evidence with a consumed one-time key", async () => {
  const session = makeSession("continuation-driver-signed-evidence");
  claimAmbientSessionAssignment(session);
  fs.writeFileSync(path.join(session.projectRoot, "AGENTS.md"), "# Test Repo\n");
  fs.writeFileSync(path.join(session.sessionDir, `${session.slug}--deliver.md`), "# Continuation\n\nstatus: executing\ntype: deliver\n");
  fs.writeFileSync(path.join(session.sessionDir, `${session.slug}--pull-work.md`), "# Pull Work\n\nSelected continuation fixture.\n");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });

  const adapter = path.join(session.projectRoot, "signed-evidence-adapter.mjs");
  const commandFile = path.join(session.projectRoot, "signed-evidence-adapter-command.json");
  const keyFile = path.join(session.projectRoot, ".continuation-evidence-key.pem");
  const keyConsumedMarker = path.join(session.projectRoot, "key-consumed.json");
  const observedRequestsFile = path.join(session.projectRoot, "observed-adapter-requests.jsonl");
  const keys = generateKeyPairSync("ed25519");
  fs.writeFileSync(keyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  fs.writeFileSync(adapter, `
    import fs from "node:fs";
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const request = JSON.parse(input);
    fs.appendFileSync(${JSON.stringify(observedRequestsFile)}, JSON.stringify(request) + "\\n");
    fs.writeFileSync(${JSON.stringify(keyConsumedMarker)}, JSON.stringify({ key_exists: fs.existsSync(${JSON.stringify(keyFile)}) }));
    process.stdout.write(JSON.stringify({
      status: "completed",
      summary: "signed fixture",
      evidence: { iteration: request.iteration, transcript_sha256: "a".repeat(64), usage: { input_tokens: 10, output_tokens: 2 } },
    }));
  `);
  writeJson(commandFile, { argv: [process.execPath, adapter] });

  await assert.rejects(
    workflowMain([
      "drive", "--session-dir", session.sessionDir,
      "--adapter-command-file", commandFile,
      "--evidence-signing-key-file", keyFile,
      "--max-turns", "0",
      "--json",
    ]),
    /max-turns must be an integer/,
  );
  assert.equal(fs.existsSync(keyFile), true, "preflight failure preserves the unused one-time key");

  const output = [];
  const originalLog = console.log;
  console.log = (...args) => output.push(args.join(" "));
  try {
    const rc = await workflowMain([
      "drive",
      "--session-dir", session.sessionDir,
      "--adapter-command-file", commandFile,
      "--evidence-signing-key-file", keyFile,
      "--max-turns", "10",
      "--turn-timeout-ms", "5000",
      "--barrier-wait-ms", "0",
      "--json",
    ]);
    assert.equal(rc, 0);
  } finally {
    console.log = originalLog;
  }

  assert.equal(fs.existsSync(keyFile), false);
  assert.deepEqual(readJson(keyConsumedMarker), { key_exists: false });
  const result = JSON.parse(output.at(-1));
  assert.equal(result.outcome, "budget_exhausted");
  const attestation = result.evidence_attestation;
  assert.equal(attestation.schema, "kontour.flow-agents.continuation_evidence_attestation");
  const expectedPublicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  assert.equal(attestation.public_key_spki_b64, expectedPublicKey);
  const payloadBytes = Buffer.from(attestation.payload_b64, "base64");
  assert.equal(verify(null, payloadBytes, keys.publicKey, Buffer.from(attestation.signature_b64, "base64")), true);
  const payload = JSON.parse(payloadBytes);
  assert.equal(payload.schema, "kontour.flow-agents.continuation_evidence");
  assert.equal(payload.outcome.outcome, "budget_exhausted");
  assert.equal(payload.adapter_turns.length, 10);
  assert.deepEqual(payload.adapter_turns.map((turn) => turn.request.iteration), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const observedRequests = fs.readFileSync(observedRequestsFile, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(payload.adapter_turns.map((turn) => turn.request), observedRequests);
  assert.equal(payload.adapter_turns[0].request.schema_version, "1.0");
  assert.equal(payload.adapter_turns[0].request.next_action.status, "continue");
  assert.equal(payload.adapter_turns[0].request.gate_action_envelope.schema_version, "3.0");
  assert.deepEqual(payload.adapter_turns.map((turn) => turn.request), observedRequests, "the signed payload binds the unchanged envelope bytes observed by the adapter");
  assert.deepEqual(payload.adapter_turns[0].result.evidence.usage, { input_tokens: 10, output_tokens: 2 });
  const tampered = Buffer.from(JSON.stringify({ ...payload, max_turns: 2 }));
  assert.equal(verify(null, tampered, keys.publicKey, Buffer.from(attestation.signature_b64, "base64")), false);
});

test("public workflow drive rejects a non-owner before adapter execution", async () => {
  const session = makeSession("continuation-driver-owner");
  claimSessionAssignment(session);
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  const marker = path.join(session.projectRoot, "adapter-ran");
  const adapter = path.join(session.projectRoot, "adapter.mjs");
  const commandFile = path.join(session.projectRoot, "adapter-command.json");
  fs.writeFileSync(adapter, `
    import fs from "node:fs";
    fs.writeFileSync(${JSON.stringify(marker)}, "ran");
    process.stdout.write(JSON.stringify({ status: "completed" }));
  `);
  writeJson(commandFile, { argv: [process.execPath, adapter] });

  await assert.rejects(
    workflowMain(["drive", "--session-dir", session.sessionDir, "--adapter-command-file", commandFile]),
    /active, matching assignment actor/,
  );
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(path.join(session.sessionDir, "continuation-driver")), false);
});

test("sync attaches the staged trust.bundle bytes when the session bundle is replaced", async () => {
  const session = makeSession("snapshot-attachment");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  const originalEntries = [bundleClaim({ expectation: "selected-work", claimType: "builder.pull-work.selected", subjectType: "work-item" })];
  writeBundle(session.sessionDir, originalEntries);
  const bundleFile = path.join(session.sessionDir, "trust.bundle");
  const originalDigest = createHash("sha256").update(fs.readFileSync(bundleFile)).digest("hex");
  let replaceBundle;
  const replaced = new Promise((resolve) => { replaceBundle = resolve; });
  const watcher = fs.watch(session.sessionDir, (_event, filename) => {
    if (String(filename) !== ".trust-bundle-snapshots") return;
    fs.writeFileSync(bundleFile, "{\"claims\":[]}");
    replaceBundle();
  });
  try {
    const syncing = syncBuilderFlowSession({ sessionDir: session.sessionDir });
    await Promise.race([
      replaced,
      new Promise((_, reject) => setTimeout(() => reject(new Error("trust.bundle snapshot was not staged")), 2_000)),
    ]);
    const synced = await syncing;
    assert.equal(synced.attached, true);
  } finally {
    watcher.close();
  }
  const manifest = readJson(path.join(runDir(session.slug, session.projectRoot), FLOW_RUN_EVIDENCE_MANIFEST_PATH));
  assert.equal(manifest.evidence.at(-1).sha256, originalDigest);
  assert.equal(fs.existsSync(path.join(session.sessionDir, ".trust-bundle-snapshots")), false);
});

test("start rejects a requested Builder flow that differs from the existing run before projection mutation", async (t) => {
  for (const [existingFlowId, requestedFlowId] of [["builder.shape", "builder.build"], ["builder.build", "builder.shape"]]) {
    await t.test(`${existingFlowId} cannot resume as ${requestedFlowId}`, async () => {
      const session = makeSession(`flow-mismatch-${existingFlowId.replace('.', '-')}`);
      await startBuilderFlowSession({ sessionDir: session.sessionDir, flowId: existingFlowId });
      const beforeFlow = snapshotTree(runDir(session.slug, session.projectRoot));
      const beforeProjection = snapshotProjectionTargets(session);
      await assert.rejects(
        () => startBuilderFlowSession({ sessionDir: session.sessionDir, flowId: requestedFlowId }),
        new RegExp(`requested ${requestedFlowId} does not match the existing ${existingFlowId} run`),
      );
      assert.deepEqual(snapshotTree(runDir(session.slug, session.projectRoot)), beforeFlow);
      assert.deepEqual(snapshotProjectionTargets(session), beforeProjection);
    });
  }
});

test("pause and resume preserve the current Flow step and active assignment", async () => {
  const session = makeSession("lifecycle-pause-resume");
  claimAmbientSessionAssignment(session);
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  const before = readJson(path.join(runDir(session.slug, session.projectRoot), "state.json"));

  const paused = await pauseBuilderFlowSession({
    sessionDir: session.sessionDir,
    reason: "fixture pause",
  });
  assert.equal(paused.run.state.status, "paused");
  assert.equal(paused.run.state.current_step, before.current_step);
  assert.deepEqual(paused.run.state.transitions, before.transitions);
  assert.equal(paused.projection.status, "blocked");
  assert.equal(readLocalAssignmentStatus(session.artifactRoot, session.slug).record.status, "claimed");

  const resumed = await resumeBuilderFlowSession({
    sessionDir: session.sessionDir,
    reason: "fixture resume",
  });
  assert.equal(resumed.run.state.status, "active");
  assert.equal(resumed.run.state.current_step, before.current_step);
  assert.deepEqual(resumed.run.state.transitions, before.transitions);
  assert.equal(readLocalAssignmentStatus(session.artifactRoot, session.slug).record.status, "claimed");
});

externalAuthorityE2E("authorized cancellation is canonical, terminal, and releases the assignment exactly once", async () => {
  const session = makeSession("lifecycle-cancel");
  claimSessionAssignment(session);
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  const authorizationFile = liveLifecycleAuthorization(session, "cancel", "cancel");

  const canceled = await cancelBuilderFlowSession({
    sessionDir: session.sessionDir,
    authorizationFile,
  });
  assert.equal(canceled.run.state.status, "canceled");
  assert.equal(canceled.projection.status, "canceled");
  assert.equal(canceled.assignmentReleased, true);
  assert.equal(canceled.idempotent, false);
  const assignmentFile = path.join(session.artifactRoot, "assignment", `${session.slug}.json`);
  assert.equal(readJson(assignmentFile).status, "released");
  const firstAudit = readJson(assignmentFile).audit_trail;

  await assert.rejects(() => cancelBuilderFlowSession({
    sessionDir: session.sessionDir,
    authorizationFile,
  }), /nonce has already been consumed/);
  assert.deepEqual(readJson(assignmentFile).audit_trail, firstAudit);
});

// #659 Slice C — friendly cancel. The linchpin: a payload minted by
// prepareBuilderCancelRequest, once signed by the operator key, must verify and
// cancel the run. If buildUnsignedLifecycleAuthorization's signing payload
// diverged by even one byte from what the verifier recomputes, this fails.
externalAuthorityE2E("prepareBuilderCancelRequest emits a payload that, signed by the operator key, cancels the run end-to-end", async () => {
  const session = makeSession("friendly-cancel-e2e");
  claimSessionAssignment(session);
  await startBuilderFlowSession({ sessionDir: session.sessionDir });

  const req = await prepareBuilderCancelRequest({ sessionDir: session.sessionDir });
  // Identity is carried from the run's active assignment, never fabricated.
  assert.equal(req.runId, session.slug);
  assert.equal(req.authorization.operation, "cancel");
  assert.equal(req.authorization.run_id, session.slug);
  assert.equal(req.authorization.subject, SUBJECT);
  assert.equal(req.authorization.assignment_actor_key, ACTOR_KEY);
  assert.deepEqual(req.authorization.assignment_actor, ACTOR);
  assert.equal(req.alreadyTerminal, false);
  // signing_payload is exactly JSON.stringify(unsigned) — the bytes to sign.
  assert.equal(req.signingPayload, JSON.stringify(req.authorization));
  assert.ok(Date.parse(req.authorization.expires_at) > Date.parse(req.authorization.request.authority.requested_at));

  // The operator signs EXACTLY the emitted payload with their ed25519 key and
  // drops the signature into the file — nothing else changes.
  const signed = {
    ...req.authorization,
    signature: {
      algorithm: "ed25519",
      key_id: AUTHORITY_KEY_ID,
      value: sign(null, Buffer.from(req.signingPayload), AUTHORITY_KEYS.privateKey).toString("base64"),
    },
  };
  const file = path.join(session.projectRoot, "friendly-cancel-e2e.authorization.json");
  writeJson(file, signed);

  const canceled = await cancelBuilderFlowSession({ sessionDir: session.sessionDir, authorizationFile: file });
  assert.equal(canceled.run.state.status, "canceled");
  assert.equal(canceled.assignmentReleased, true);
  assert.equal(canceled.idempotent, false);
});

test("prepareBuilderCancelRequest refuses a run with no assignment holder", async () => {
  const session = makeSession("friendly-cancel-no-holder");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  await assert.rejects(
    () => prepareBuilderCancelRequest({ sessionDir: session.sessionDir }),
    /no assignment holder/,
  );
});

test("prepareBuilderCancelRequest respects a custom reason, actor, and expiry window", async () => {
  const session = makeSession("friendly-cancel-custom");
  claimSessionAssignment(session);
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  const req = await prepareBuilderCancelRequest({
    sessionDir: session.sessionDir,
    reason: "stale orphaned run",
    requestActor: "brian",
    expiresInHours: 2,
    now: "2026-07-15T12:00:00.000Z",
  });
  assert.equal(req.authorization.request.reason, "stale orphaned run");
  assert.equal(req.authorization.request.authority.actor, "brian");
  assert.equal(req.authorization.request.authority.requested_at, "2026-07-15T12:00:00.000Z");
  assert.equal(req.authorization.expires_at, "2026-07-15T14:00:00.000Z");
});

externalAuthorityE2E("a cancel-request payload signed with the WRONG key is rejected (signature lock intact)", async () => {
  const session = makeSession("friendly-cancel-badsig");
  claimSessionAssignment(session);
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  // Default (live) timing so the request is not expired — the signature, not the
  // clock, must be what rejects it.
  const req = await prepareBuilderCancelRequest({ sessionDir: session.sessionDir });
  const wrongKey = generateKeyPairSync("ed25519");
  const badSigned = {
    ...req.authorization,
    signature: { algorithm: "ed25519", key_id: AUTHORITY_KEY_ID, value: sign(null, Buffer.from(req.signingPayload), wrongKey.privateKey).toString("base64") },
  };
  const file = path.join(session.projectRoot, "friendly-cancel-badsig.authorization.json");
  writeJson(file, badSigned);
  await assert.rejects(() => cancelBuilderFlowSession({ sessionDir: session.sessionDir, authorizationFile: file }), /signature is invalid/);
});

test("builder-run cancel-request CLI writes the unsigned authorization and prints signing guidance", async () => {
  const session = makeSession("friendly-cancel-cli");
  claimSessionAssignment(session);
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  const outFile = path.join(session.projectRoot, "out.unsigned.json");

  const output = [];
  const originalLog = console.log;
  console.log = (...args) => output.push(args.join(" "));
  let rc;
  try {
    rc = await builderRunMain(["cancel-request", "--session-dir", session.sessionDir, "--out", outFile, "--actor", "brian"]);
  } finally {
    console.log = originalLog;
  }
  assert.equal(rc, 0);

  // The unsigned authorization file is written and structurally valid.
  const unsigned = readJson(outFile);
  assert.equal(unsigned.operation, "cancel");
  assert.equal(unsigned.run_id, session.slug);
  assert.equal(unsigned.assignment_actor_key, ACTOR_KEY);
  assert.equal(unsigned.signature, undefined, "the emitted file is UNSIGNED — the operator adds the signature");

  // The printed JSON carries the signing payload + human next-steps.
  const printed = JSON.parse(output.join("\n"));
  assert.equal(printed.unsigned_authorization_file, outFile);
  assert.equal(printed.signing_payload, JSON.stringify(unsigned));
  assert.ok(Array.isArray(printed.next_steps) && printed.next_steps.some((s) => s.includes("builder-run cancel")));

  // Unknown flags are rejected with a usage error, not silently accepted.
  assert.equal(await builderRunMain(["cancel-request", "--session-dir", session.sessionDir, "--bogus", "x"]), 64);
  // --expires-in-hours is bounded: non-positive, non-finite, and absurd values
  // return a clean usage code instead of crashing the Date math.
  assert.equal(await builderRunMain(["cancel-request", "--session-dir", session.sessionDir, "--expires-in-hours", "0"]), 64);
  assert.equal(await builderRunMain(["cancel-request", "--session-dir", session.sessionDir, "--expires-in-hours", "1e309"]), 64);
  assert.equal(await builderRunMain(["cancel-request", "--session-dir", session.sessionDir, "--expires-in-hours", "100000"]), 64);
});

externalAuthorityE2E("cancel-request signing-payload parity holds for non-ASCII reason/actor (unicode regression)", async () => {
  const session = makeSession("friendly-cancel-unicode");
  claimSessionAssignment(session);
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  const req = await prepareBuilderCancelRequest({
    sessionDir: session.sessionDir,
    reason: "café — Ünïcödé 😀 العربية",
    requestActor: "brián-Ω-中文",
  });
  assert.equal(req.signingPayload, JSON.stringify(req.authorization));
  const signed = {
    ...req.authorization,
    signature: { algorithm: "ed25519", key_id: AUTHORITY_KEY_ID, value: sign(null, Buffer.from(req.signingPayload), AUTHORITY_KEYS.privateKey).toString("base64") },
  };
  const file = path.join(session.projectRoot, "unicode.authorization.json");
  writeJson(file, signed);
  const canceled = await cancelBuilderFlowSession({ sessionDir: session.sessionDir, authorizationFile: file });
  assert.equal(canceled.run.state.status, "canceled");
});

externalAuthorityE2E("prepareBuilderCancelRequest mints from the released assignment once the run is canceled (redemption-gate aligned)", async () => {
  const session = makeSession("friendly-cancel-recovery");
  claimSessionAssignment(session);
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  // Cancel the run first — this releases the assignment and sets status=canceled.
  const first = await prepareBuilderCancelRequest({ sessionDir: session.sessionDir });
  const firstSigned = {
    ...first.authorization,
    signature: { algorithm: "ed25519", key_id: AUTHORITY_KEY_ID, value: sign(null, Buffer.from(first.signingPayload), AUTHORITY_KEYS.privateKey).toString("base64") },
  };
  const firstFile = path.join(session.projectRoot, "recovery-1.authorization.json");
  writeJson(firstFile, firstSigned);
  await cancelBuilderFlowSession({ sessionDir: session.sessionDir, authorizationFile: firstFile });

  // Now canceled with a RELEASED assignment: the mint-time fallback matches the
  // redemption gate, so cancel-request still mints (an idempotent-recovery auth).
  const recovery = await prepareBuilderCancelRequest({ sessionDir: session.sessionDir });
  assert.equal(recovery.runStatus, "canceled");
  assert.equal(recovery.alreadyTerminal, true);
  assert.equal(recovery.authorization.assignment_actor_key, ACTOR_KEY);
});

test("assignment release is independent of Flow lifecycle", async () => {
  const session = makeSession("lifecycle-release-assignment");
  claimAmbientSessionAssignment(session);
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  const beforeFlow = snapshotTree(runDir(session.slug, session.projectRoot));

  const released = await releaseBuilderFlowAssignment({
    sessionDir: session.sessionDir,
    reason: "fixture assignment release",
  });

  assert.equal(released.assignmentReleased, true);
  assert.deepEqual(snapshotTree(runDir(session.slug, session.projectRoot)), beforeFlow);
  assert.equal(readJson(path.join(session.artifactRoot, "assignment", `${session.slug}.json`)).status, "released");
});

externalAuthorityE2E("archive rejects active runs and retains canceled Flow and session artifacts", async () => {
  const session = makeSession("lifecycle-archive");
  claimSessionAssignment(session);
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  const cancelAuthorization = liveLifecycleAuthorization(session, "cancel", "archive-cancel");
  const authorizationFile = liveLifecycleAuthorization(session, "archive", "archive");
  const beforeReject = snapshotTree(session.sessionDir);
  await assert.rejects(() => archiveBuilderFlowSession({
    sessionDir: session.sessionDir,
    authorizationFile,
  }), /must be completed or canceled/);
  assert.deepEqual(snapshotTree(session.sessionDir), beforeReject);

  await cancelBuilderFlowSession({
    sessionDir: session.sessionDir,
    authorizationFile: cancelAuthorization,
  });
  const beforeFlow = snapshotTree(runDir(session.slug, session.projectRoot));
  const beforeSession = snapshotTree(session.sessionDir);
  const archived = await archiveBuilderFlowSession({
    sessionDir: session.sessionDir,
    authorizationFile,
  });

  assert.equal(archived.archiveDir, path.join(session.artifactRoot, "archive", session.slug));
  assert.equal(fs.existsSync(session.sessionDir), false);
  assert.equal(readJson(path.join(archived.archiveDir, "state.json")).status, "archived");
  assert.deepEqual(snapshotTree(runDir(session.slug, session.projectRoot)), beforeFlow);
  const archivedFiles = snapshotTree(archived.archiveDir).map(([name]) => name);
  for (const [name] of beforeSession) assert.ok(archivedFiles.includes(name), `archive retained ${name}`);
  assert.deepEqual(consumedAuthorizationRecords(session).map((record) => record.operation).sort(), ["archive", "cancel"]);
});

externalAuthorityE2E("archive rejects a symlinked archive root without moving the session", async () => {
  const session = makeSession("lifecycle-archive-symlink");
  claimSessionAssignment(session);
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  const cancelAuthorization = liveLifecycleAuthorization(session, "cancel", "archive-symlink-cancel");
  const authorizationFile = liveLifecycleAuthorization(session, "archive", "archive-symlink");
  await cancelBuilderFlowSession({
    sessionDir: session.sessionDir,
    authorizationFile: cancelAuthorization,
  });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-archive-outside-"));
  fs.symlinkSync(outside, path.join(session.artifactRoot, "archive"), "dir");
  const beforeSession = snapshotTree(session.sessionDir);

  await assert.rejects(() => archiveBuilderFlowSession({
    sessionDir: session.sessionDir,
    authorizationFile,
  }), /archive root.*symbolic link/);

  assert.deepEqual(snapshotTree(session.sessionDir), beforeSession);
  assert.deepEqual(fs.readdirSync(outside), []);
});

externalAuthorityE2E("archive retries the exact consumed authorization after an interrupted prepared move", async () => {
  const session = makeSession("lifecycle-archive-recovery");
  claimSessionAssignment(session);
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  await cancelBuilderFlowSession({
    sessionDir: session.sessionDir,
    authorizationFile: liveLifecycleAuthorization(session, "cancel", "archive-recovery-cancel"),
  });
  const authorizationFile = expiredLifecycleAuthorization(session, "archive", "archive-recovery");
  const rawAuthorization = readJson(authorizationFile);
  const authorization = loadBuilderLifecycleAuthorization(authorizationFile, {
    projectRoot: session.projectRoot,
    operation: "archive",
    runId: session.slug,
    subject: SUBJECT,
    actorKey: ACTOR_KEY,
    now: new Date(Date.parse(rawAuthorization.request.authority.requested_at) + 30_000).toISOString(),
  });
  const preparedState = readJson(path.join(session.sessionDir, "state.json"));
  preparedState.status = "archived";
  preparedState.phase = "done";
  preparedState.next_action = { status: "done", summary: "Builder session archived; canonical Flow artifacts remain retained." };
  writeJson(path.join(session.sessionDir, "state.json"), preparedState);
  recordAuthorizationConsumed(session.artifactRoot, authorization);

  const conflictingAuthorization = liveLifecycleAuthorization(session, "archive", "archive-recovery-conflict", {
    nonce: authorization.nonce,
  });
  await assert.rejects(
    () => archiveBuilderFlowSession({ sessionDir: session.sessionDir, authorizationFile: conflictingAuthorization }),
    /does not match its integrity key/,
  );
  assert.equal(fs.existsSync(session.sessionDir), true);

  const recovered = await archiveBuilderFlowSession({ sessionDir: session.sessionDir, authorizationFile });
  assert.equal(fs.existsSync(session.sessionDir), false);
  assert.equal(readJson(path.join(recovered.archiveDir, "state.json")).status, "archived");
  assert.equal(consumedAuthorizationRecords(session).length, 2);
});

externalAuthorityE2E("mismatched and expired cancellation authority fail before Flow or sidecar mutation", async (t) => {
  for (const [name, overrides, pattern] of [
    ["wrong-run", { run_id: "another-run" }, /run_id does not match/],
    ["wrong-subject", { subject: "local:other" }, /subject does not match/],
    ["wrong-actor", { assignment_actor_key: "another-actor" }, /assignment_actor_key does not match/],
    ["wrong-actor-struct", { assignment_actor: { ...ACTOR, session_id: "another-session" } }, /assignment_actor.*active assignment holder/],
    ["wrong-operation", { operation: "archive" }, /operation does not match/],
    ["expired", {}, /expired/],
  ]) {
    await t.test(name, async () => {
      const session = makeSession(`lifecycle-reject-${name}`);
      claimSessionAssignment(session);
      await startBuilderFlowSession({ sessionDir: session.sessionDir });
      const beforeFlow = snapshotTree(runDir(session.slug, session.projectRoot));
      const beforeProjection = snapshotProjectionTargets(session);
      const beforeAssignment = snapshotFile(path.join(session.artifactRoot, "assignment", `${session.slug}.json`));
      await assert.rejects(() => cancelBuilderFlowSession({
        sessionDir: session.sessionDir,
        authorizationFile: name === "expired"
          ? expiredLifecycleAuthorization(session, "cancel", name, overrides)
          : liveLifecycleAuthorization(session, "cancel", name, overrides),
      }), pattern);
      assert.deepEqual(snapshotTree(runDir(session.slug, session.projectRoot)), beforeFlow);
      assert.deepEqual(snapshotProjectionTargets(session), beforeProjection);
      assert.equal(snapshotFile(path.join(session.artifactRoot, "assignment", `${session.slug}.json`)), beforeAssignment);
    });
  }
});

externalAuthorityE2E("conflicting cancellation request replay is rejected without a second transition or release", async () => {
  const session = makeSession("lifecycle-conflicting-replay");
  claimSessionAssignment(session);
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  await cancelBuilderFlowSession({
    sessionDir: session.sessionDir,
    authorizationFile: liveLifecycleAuthorization(session, "cancel", "cancel-original"),
  });
  const beforeFlow = snapshotTree(runDir(session.slug, session.projectRoot));
  const assignmentFile = path.join(session.artifactRoot, "assignment", `${session.slug}.json`);
  const beforeAssignment = snapshotFile(assignmentFile);
  await assert.rejects(() => cancelBuilderFlowSession({
    sessionDir: session.sessionDir,
    authorizationFile: liveLifecycleAuthorization(session, "cancel", "cancel-conflict"),
  }), /does not match the canonical cancellation/);
  assert.deepEqual(snapshotTree(runDir(session.slug, session.projectRoot)), beforeFlow);
  assert.equal(snapshotFile(assignmentFile), beforeAssignment);
});

externalAuthorityE2E("tampered or unsigned cancellation authority fails before mutation", async () => {
  const session = makeSession("lifecycle-signature-reject");
  claimSessionAssignment(session);
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  const authorizationFile = liveLifecycleAuthorization(session, "cancel", "signature-reject");
  const tampered = readJson(authorizationFile);
  tampered.request.reason = "agent-authored replacement";
  writeJson(authorizationFile, tampered);
  const beforeFlow = snapshotTree(runDir(session.slug, session.projectRoot));
  const beforeAssignment = snapshotFile(path.join(session.artifactRoot, "assignment", `${session.slug}.json`));

  await assert.rejects(() => cancelBuilderFlowSession({ sessionDir: session.sessionDir, authorizationFile }), /signature is invalid/);
  assert.deepEqual(snapshotTree(runDir(session.slug, session.projectRoot)), beforeFlow);
  assert.equal(snapshotFile(path.join(session.artifactRoot, "assignment", `${session.slug}.json`)), beforeAssignment);
});

externalAuthorityE2E("expired authority can finish side effects for its matching canonical cancellation", async () => {
  const session = makeSession("lifecycle-cancel-recovery");
  claimSessionAssignment(session);
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  const authorizationFile = expiredLifecycleAuthorization(session, "cancel", "cancel-recovery");
  const authorization = readJson(authorizationFile);
  await cancelBuilderBuildRun({
    cwd: session.projectRoot,
    runId: session.slug,
    request: authorization.request,
    at: new Date(Date.parse(authorization.expires_at) - 1_000).toISOString(),
  });
  assert.equal(readJson(path.join(runDir(session.slug, session.projectRoot), "state.json")).status, "canceled");
  assert.equal(readJson(path.join(session.artifactRoot, "assignment", `${session.slug}.json`)).status, "claimed");
  assert.deepEqual(consumedAuthorizationRecords(session), []);

  const recovered = await cancelBuilderFlowSession({ sessionDir: session.sessionDir, authorizationFile });
  assert.equal(recovered.idempotent, true);
  assert.equal(recovered.assignmentReleased, true);
  assert.equal(recovered.projection.status, "canceled");
  assert.equal(consumedAuthorizationRecords(session).length, 1);
});

externalAuthorityE2E("builder-run exposes lifecycle actions without caller-selected Flow identity", async () => {
  const session = makeSession("lifecycle-cli");
  const ambient = resolveCurrentAssignmentActor();
  performLocalClaim(session.artifactRoot, session.slug, ambient.actor, { actorKey: ambient.actorKey, ttlSeconds: 1800, branch: `agent/${session.slug}`, artifactDir: session.sessionDir, workItemRef: SUBJECT, reason: "test" });
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  assert.equal(await builderRunMain(["start", "--session-dir", session.sessionDir]), 64);
  assert.equal(await builderRunMain(["sync", "--session-dir", session.sessionDir]), 64);
  assert.equal(await builderRunMain([
    "pause", "--session-dir", session.sessionDir,
    "--reason", "cli pause",
  ]), 0);
  assert.equal(await builderRunMain([
    "resume", "--session-dir", session.sessionDir,
    "--reason", "cli resume",
  ]), 0);
  const cliCancel = liveLifecycleAuthorization(session, "cancel", "cli-cancel", { assignment_actor_key: ambient.actorKey, assignment_actor: ambient.actor });
  assert.equal(await builderRunMain([
    "cancel", "--session-dir", session.sessionDir,
    "--authorization-file", cliCancel,
  ]), 0);
  assert.equal(readJson(path.join(runDir(session.slug, session.projectRoot), "state.json")).status, "canceled");
  assert.equal(await builderRunMain([
    "cancel", "--session-dir", session.sessionDir,
    "--authorization-file", liveLifecycleAuthorization(session, "cancel", "cli-clock-override", { assignment_actor_key: ambient.actorKey, assignment_actor: ambient.actor }),
    "--now", "2020-01-01T00:00:00.000Z",
  ]), 64);
});

test("automatic start refuses a slug-bound run for another Work Item without mutation", async () => {
  const session = makeSession("start-subject-mismatch");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  const sidecar = readJson(path.join(session.sessionDir, "state.json"));
  sidecar.work_item_refs = ["local:work-item/other"];
  writeJson(path.join(session.sessionDir, "state.json"), sidecar);
  const beforeFlow = snapshotTree(runDir(session.slug, session.projectRoot));
  const beforeProjection = snapshotProjectionTargets(session);

  await assert.rejects(
    () => startBuilderFlowSession({ sessionDir: session.sessionDir }),
    /flow_run\.state\.subject.*selected Work Item/,
  );
  assert.deepEqual(snapshotTree(runDir(session.slug, session.projectRoot)), beforeFlow);
  assert.deepEqual(snapshotProjectionTargets(session), beforeProjection);
});

test("automatic start refuses a sidecar changed after its immutable subject snapshot", async () => {
  const session = makeSession("start-sidecar-race");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  const beforeFlow = snapshotTree(runDir(session.slug, session.projectRoot));
  const startup = startBuilderFlowSession({ sessionDir: session.sessionDir });
  const changed = readJson(path.join(session.sessionDir, "state.json"));
  changed.next_action = { status: "continue", summary: "concurrent change" };
  writeJson(path.join(session.sessionDir, "state.json"), changed);
  const beforeProjection = snapshotProjectionTargets(session);

  await assert.rejects(() => startup, /state\.json.*changed during projection/);
  assert.deepEqual(snapshotTree(runDir(session.slug, session.projectRoot)), beforeFlow);
  assert.deepEqual(snapshotProjectionTargets(session), beforeProjection);
});

test("wrong workflow subject is rejected before canonical Flow mutation", async () => {
  const session = makeSession("wrong-subject");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  const beforeState = readJson(path.join(runDir(session.slug, session.projectRoot), "state.json"));
  const beforeManifest = readJson(path.join(runDir(session.slug, session.projectRoot), FLOW_RUN_EVIDENCE_MANIFEST_PATH));
  writeBundle(session.sessionDir, [bundleClaim({
    expectation: "selected-work",
    claimType: "builder.pull-work.selected",
    subjectType: "work-item",
    subject: "local:work-item/other",
  })]);

  await assert.rejects(
    () => syncBuilderFlowSession({ sessionDir: session.sessionDir }),
    /workflow_subject_ref.*persisted run subject/,
  );
  assert.deepEqual(readJson(path.join(runDir(session.slug, session.projectRoot), "state.json")), beforeState);
  assert.deepEqual(readJson(path.join(runDir(session.slug, session.projectRoot), FLOW_RUN_EVIDENCE_MANIFEST_PATH)), beforeManifest);
});

test("failed verification projects Flow-owned route-back attempt and budget", async () => {
  const session = makeSession("route-back-projection");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  await writeAndSync(session, [bundleClaim({ expectation: "selected-work", claimType: "builder.pull-work.selected", subjectType: "work-item" })]);
  await writeAndSync(session, [
    bundleClaim({ expectation: "pickup-probe-readiness", claimType: "builder.design-probe.pickup-readiness", subjectType: "work-item" }),
    bundleClaim({ expectation: "probe-decisions-or-accepted-gaps", claimType: "builder.design-probe.decisions", subjectType: "decision" }),
  ]);
  await writeAndSync(session, [bundleClaim({ expectation: "implementation-plan", claimType: "builder.plan.implementation", subjectType: "artifact" })]);
  const verify = await writeAndSync(session, [bundleClaim({ expectation: "implementation-scope", claimType: "builder.execute.scope", subjectType: "change" })]);
  assert.equal(verify.run.state.current_step, "verify");

  const failureTimestamp = new Date().toISOString();
  const initialPrerequisites = verifiedTestsPrerequisites(session, failureTimestamp);
  initialPrerequisites[0].claim.metadata.reviewer = "reviewer-before-route-back";
  restampCritiqueClaim(initialPrerequisites[0]);
  const routed = await writeAndSync(session, [bundleClaim({
    expectation: "tests-evidence",
    claimType: "builder.verify.tests",
    subjectType: "flow-step",
    status: "fail",
    routeReason: "implementation_defect",
    timestamp: failureTimestamp,
  }), ...initialPrerequisites]);

  assert.equal(routed.run.state.current_step, "execute");
  assert.equal(routed.projection.flow_run.route_back_attempt, 1);
  assert.equal(routed.projection.flow_run.route_back_max_attempts, 3);
  assert.match(routed.projection.next_action.summary, /Route-back history: attempt 1\/3 returned to `execute` for `implementation_defect`/);
  assert.deepEqual(routed.projection.next_action.skills, ["execute-plan"]);

  const reentered = await writeAndSync(session, [withIdentitySuffix(bundleClaim({
    expectation: "implementation-scope",
    claimType: "builder.execute.scope",
    subjectType: "change",
    timestamp: new Date().toISOString(),
  }), "reentry")]);
  assert.equal(reentered.run.state.current_step, "verify");
  const staleRetry = await writeAndSync(session, [bundleClaim({
    expectation: "tests-evidence",
    claimType: "builder.verify.tests",
    subjectType: "flow-step",
    status: "fail",
    routeReason: "implementation_defect",
    timestamp: NOW,
  })]);
  assert.equal(staleRetry.attached, false);
  assert.equal(staleRetry.run.state.current_step, "verify");
  assert.equal(staleRetry.run.state.transitions.filter((transition) => transition.type === "route_back").length, 1);
  fs.writeFileSync(path.join(session.projectRoot, "review-target", "delivery.md"), "corrected delivery after route-back\n");
  const correctedAt = new Date(Date.parse(reentered.run.state.transitions.at(-1).at) + 1).toISOString();
  const correctedPrerequisites = verifiedTestsPrerequisites(session, correctedAt)
    .map((entry, index) => withIdentitySuffix(entry, `corrected-${index}`));
  correctedPrerequisites[0].claim.metadata.reviewer = "reviewer-after-route-back";
  restampCritiqueClaim(correctedPrerequisites[0]);
  const corrected = await writeAndSync(session, [
    withIdentitySuffix(bundleClaim({ expectation: "tests-evidence", claimType: "builder.verify.tests", subjectType: "flow-step", timestamp: correctedAt }), "corrected"),
    ...correctedPrerequisites,
    // Compose-safe writers preserve this older reviewer's still-live PASS slice. It targets the
    // prior implementation bytes and must remain audit history without deadlocking the new gate
    // visit or requiring the new reviewer to impersonate the old one.
    initialPrerequisites[0],
  ]);
  assert.equal(corrected.run.state.current_step, "merge-ready");
  const verifyEvidence = corrected.run.manifest.evidence.filter((entry) => entry.gate_id === "verify-gate");
  assert.equal(verifyEvidence.length, 2);
  assert.equal(verifyEvidence[0].superseded_by, verifyEvidence[1].id);
  const retainedCritiques = readJson(path.join(session.sessionDir, "trust.bundle")).claims
    .filter((claim) => claim.metadata?.origin === "critique" && !claim.metadata.superseded_by);
  assert.deepEqual(retainedCritiques.map((claim) => claim.metadata.reviewer).sort(), [
    "reviewer-after-route-back",
    "reviewer-before-route-back",
  ]);
});

test("a different passing reviewer cannot hide a disputed critique in the same gate visit", async () => {
  const session = makeSession("same-visit-reviewer-handoff");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  await writeAndSync(session, [bundleClaim({ expectation: "selected-work", claimType: "builder.pull-work.selected", subjectType: "work-item" })]);
  await writeAndSync(session, [
    bundleClaim({ expectation: "pickup-probe-readiness", claimType: "builder.design-probe.pickup-readiness", subjectType: "work-item" }),
    bundleClaim({ expectation: "probe-decisions-or-accepted-gaps", claimType: "builder.design-probe.decisions", subjectType: "decision" }),
  ]);
  await writeAndSync(session, [bundleClaim({ expectation: "implementation-plan", claimType: "builder.plan.implementation", subjectType: "artifact" })]);
  await writeAndSync(session, [bundleClaim({ expectation: "implementation-scope", claimType: "builder.execute.scope", subjectType: "change" })]);
  const timestamp = new Date().toISOString();
  const prerequisites = verifiedTestsPrerequisites(session, timestamp);
  prerequisites[0].claim.metadata.reviewer = "passing-reviewer";
  const disputedCritique = withIdentitySuffix(structuredClone(prerequisites[0]), "disputed-reviewer");
  disputedCritique.claim.value = "fail";
  disputedCritique.claim.status = "disputed";
  disputedCritique.claim.metadata.reviewer = "disputed-reviewer";
  disputedCritique.claim.metadata.lanes = [{ id: "code", status: "fail" }];
  disputedCritique.claim.metadata.findings = [{ id: "unresolved", status: "open", severity: "high" }];
  disputedCritique.event.status = "disputed";

  const blocked = await writeAndSync(session, [
    bundleClaim({ expectation: "tests-evidence", claimType: "builder.verify.tests", subjectType: "flow-step", timestamp }),
    ...prerequisites,
    disputedCritique,
  ]);
  assert.equal(blocked.attached, false);
  assert.equal(blocked.run.state.current_step, "verify");
  const retainedCritiques = readJson(path.join(session.sessionDir, "trust.bundle")).claims
    .filter((claim) => claim.metadata?.origin === "critique" && !claim.metadata.superseded_by);
  assert.deepEqual(retainedCritiques.map((claim) => [claim.metadata.reviewer, claim.value]).sort(), [
    ["disputed-reviewer", "fail"],
    ["passing-reviewer", "pass"],
  ]);
});

externalAuthorityE2E("an authenticated final reviewer resolves an earlier repaired critique without erasing audit history", async () => {
  const session = makeSession("cross-reviewer-critique-resolution");
  claimSessionAssignment(session);
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  await writeAndSync(session, [bundleClaim({ expectation: "selected-work", claimType: "builder.pull-work.selected", subjectType: "work-item" })]);
  await writeAndSync(session, [
    bundleClaim({ expectation: "pickup-probe-readiness", claimType: "builder.design-probe.pickup-readiness", subjectType: "work-item" }),
    bundleClaim({ expectation: "probe-decisions-or-accepted-gaps", claimType: "builder.design-probe.decisions", subjectType: "decision" }),
  ]);
  await writeAndSync(session, [bundleClaim({ expectation: "implementation-plan", claimType: "builder.plan.implementation", subjectType: "artifact" })]);
  await writeAndSync(session, [bundleClaim({ expectation: "implementation-scope", claimType: "builder.execute.scope", subjectType: "change" })]);
  const delivery = path.join(session.projectRoot, "review-target", "delivery.md");
  const lane = (id, status) => JSON.stringify({
    id,
    status,
    summary: status === "pass" ? "Repair was independently reviewed." : "Review found a blocking defect.",
    evidence_refs: [{ kind: "artifact", file: path.relative(session.projectRoot, delivery), summary: "Reviewed delivery artifact." }],
  });
  await workflowSidecarMain([
    "record-critique", session.sessionDir,
    "--id", "ephemeral-failure", "--reviewer", "ephemeral-reviewer", "--verdict", "fail",
    "--summary", "The original review found a blocking defect.",
    "--artifact-ref", delivery, "--lane-json", lane("code-review", "fail"), "--lane-json", lane("security-review", "not_verified"),
    "--finding-json", JSON.stringify({ id: "blocking-defect", severity: "high", status: "open", description: "Requires repair." }),
    "--timestamp", "2026-07-19T10:00:00.000Z",
  ]);
  fs.writeFileSync(delivery, "repaired delivery artifact\n");
  const originalCodexThread = process.env.CODEX_THREAD_ID;
  process.env.CODEX_THREAD_ID = "critique-resolution-reviewer-thread";
  const finalReviewer = resolveCurrentAssignmentActor();
  await workflowSidecarMain([
    "record-critique", session.sessionDir,
    "--id", "final-repair-review", "--reviewer", finalReviewer.actorKey, "--verdict", "pass",
    "--summary", "An independent final reviewer verified the repair.",
    "--artifact-ref", delivery, "--lane-json", lane("code-review", "pass"), "--lane-json", lane("security-review", "pass"),
    "--finding-json", JSON.stringify({ id: "blocking-defect", severity: "high", status: "fixed", description: "Repair verified." }),
    "--timestamp", "2026-07-19T10:01:00.000Z",
  ]);

  const before = readJson(path.join(session.sessionDir, "trust.bundle"));
  const critiques = before.claims.filter((claim) => claim.metadata?.origin === "critique");
  const prior = critiques.find((claim) => claim.metadata?.reviewer === "ephemeral-reviewer");
  const resolving = critiques.find((claim) => claim.metadata?.reviewer === finalReviewer.actorKey);
  assert.ok(prior, "fixture must retain the earlier failing critique");
  assert.ok(resolving, "fixture must retain the final resolving critique");
  const priorRecordId = prior.metadata.critique_record_id ?? prior.id;
  const resolvingRecordId = resolving.metadata.critique_record_id ?? resolving.id;
  const beforeRejectedResolution = fs.readFileSync(path.join(session.sessionDir, "trust.bundle"), "utf8");
  const canonicalManifest = path.join(runDir(session.slug, session.projectRoot), FLOW_RUN_EVIDENCE_MANIFEST_PATH);
  const manifestBeforeResolution = fs.readFileSync(canonicalManifest, "utf8");
  const validateCritiques = (cwd = session.projectRoot) => spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../../build/src/cli/validate-workflow-artifacts.js"), "--require-critique", session.sessionDir], { cwd, encoding: "utf8" });
  const validateResolvedGraph = (bundle) => validateCritiqueResolutionGraph(bundle.claims, SUBJECT, bundle.critique_resolution_events ?? [], session.projectRoot);
  const onlyFailBundle = structuredClone(before);
  onlyFailBundle.claims = onlyFailBundle.claims.filter((claim) => claim.metadata?.critique_record_id === priorRecordId || claim.metadata?.origin !== "critique");
  onlyFailBundle.events = onlyFailBundle.events.filter((event) => onlyFailBundle.claims.some((claim) => claim.id === event.claimId));
  fs.writeFileSync(path.join(session.sessionDir, "trust.bundle"), `${JSON.stringify(onlyFailBundle, null, 2)}\n`);
  assert.notEqual(validateCritiques().status, 0, "a bundle with only a failing critique must not validate");
  fs.writeFileSync(path.join(session.sessionDir, "trust.bundle"), beforeRejectedResolution);
  await assert.rejects(
    workflowSidecarMain(["resolve-critique", session.sessionDir, "--prior-record-id", priorRecordId, "--resolving-record-id", resolvingRecordId, "--resolver", finalReviewer.actorKey]),
    /authenticated public workflow interface/,
  );
  await assert.rejects(
    workflowMain(["resolve-critique", "--session-dir", session.sessionDir, "--prior-record-id", priorRecordId, "--resolving-record-id", resolvingRecordId]),
    /signed --authorization-file/,
  );
  const staleAuthorization = critiqueResolutionAuthorization(session, priorRecordId, resolvingRecordId, finalReviewer.actorKey, "stale");
  fs.writeFileSync(delivery, "post-review mutation must make the resolver stale\n");
  await assert.rejects(
    workflowMain(["resolve-critique", "--session-dir", session.sessionDir, "--prior-record-id", priorRecordId, "--resolving-record-id", resolvingRecordId, "--authorization-file", staleAuthorization]),
    /verified, current passing critique/,
  );
  fs.writeFileSync(delivery, "repaired delivery artifact\n");
  assert.equal(fs.readFileSync(path.join(session.sessionDir, "trust.bundle"), "utf8"), beforeRejectedResolution, "rejected resolution attempts must not mutate history");

  const authorizationFile = critiqueResolutionAuthorization(session, priorRecordId, resolvingRecordId, finalReviewer.actorKey);
  const validAuthorization = readJson(authorizationFile);
  const resolveWith = (file, priorId = priorRecordId, resolverId = resolvingRecordId) => workflowMain([
    "resolve-critique", "--session-dir", session.sessionDir, "--prior-record-id", priorId,
    "--resolving-record-id", resolverId, "--authorization-file", file,
  ]);
  const expiredAt = new Date(Date.now() - 60_000).toISOString();
  const futureAt = new Date(Date.now() + 10 * 60_000).toISOString();
  await assert.rejects(() => resolveWith(critiqueResolutionAuthorization(session, priorRecordId, resolvingRecordId, finalReviewer.actorKey, "wrong-run", { run_id: "other-run" })), /run_id does not match/);
  await assert.rejects(() => resolveWith(critiqueResolutionAuthorization(session, priorRecordId, resolvingRecordId, finalReviewer.actorKey, "wrong-subject", { subject: "local:work-item/other" })), /subject does not match/);
  await assert.rejects(() => resolveWith(critiqueResolutionAuthorization(session, priorRecordId, resolvingRecordId, finalReviewer.actorKey, "wrong-preimage", { prior_bundle_sha256: "0".repeat(64) })), /prior_bundle_sha256 does not match/);
  await assert.rejects(() => resolveWith(critiqueResolutionAuthorization(session, priorRecordId, resolvingRecordId, finalReviewer.actorKey, "wrong-record-hash", { prior_record_hash: "1".repeat(64) })), /prior_record_hash does not match/);
  await assert.rejects(() => resolveWith(critiqueResolutionAuthorization(session, priorRecordId, resolvingRecordId, finalReviewer.actorKey, "wrong-lanes", { resolved_lane_ids: [] })), /resolved_lane_ids does not match/);
  await assert.rejects(() => resolveWith(critiqueResolutionAuthorization(session, priorRecordId, resolvingRecordId, finalReviewer.actorKey, "wrong-snapshot", { resolving_snapshot_sha256: "2".repeat(64) })), /resolving_snapshot_sha256 does not match/);
  await assert.rejects(() => resolveWith(critiqueResolutionAuthorization(session, priorRecordId, resolvingRecordId, "wrong-resolver", "wrong-resolver")), /expected_resolver does not match/);
  await assert.rejects(() => resolveWith(critiqueResolutionAuthorization(session, priorRecordId, resolvingRecordId, finalReviewer.actorKey, "expired", { requested_at: new Date(Date.now() - 120_000).toISOString(), expires_at: expiredAt })), /is expired/);
  await assert.rejects(() => resolveWith(critiqueResolutionAuthorization(session, priorRecordId, resolvingRecordId, finalReviewer.actorKey, "future", { requested_at: futureAt, expires_at: new Date(Date.now() + 20 * 60_000).toISOString() })), /request time is in the future/);
  const unknownKeyAuthorization = structuredClone(validAuthorization);
  unknownKeyAuthorization.signature.key_id = "untrusted-authority";
  const unknownKeyFile = path.join(session.sessionDir, "untrusted-key.authorization.json");
  writeJson(unknownKeyFile, unknownKeyAuthorization);
  await assert.rejects(() => resolveWith(unknownKeyFile), /is not trusted/);
  await assert.rejects(() => resolveWith(authorizationFile, "critique:missing"), /missing or ambiguous/);
  writeJson(authorizationFile, { ...validAuthorization, signature: { ...validAuthorization.signature, value: Buffer.alloc(64).toString("base64") } });
  await assert.rejects(workflowMain([
    "resolve-critique", "--session-dir", session.sessionDir, "--prior-record-id", priorRecordId,
    "--resolving-record-id", resolvingRecordId, "--authorization-file", authorizationFile,
  ]), /signature is invalid/);
  writeJson(authorizationFile, validAuthorization);
  const priorAuthorityPath = process.env.FLOW_AGENTS_LIFECYCLE_AUTHORITY_REGISTRY;
  process.env.FLOW_AGENTS_LIFECYCLE_AUTHORITY_REGISTRY = authorizationFile;
  assert.throws(() => loadCritiqueResolutionAuthorization(authorizationFile, {
    projectRoot: session.projectRoot, runId: session.slug, subject: SUBJECT,
    priorBundleSha256: validAuthorization.prior_bundle_sha256, priorRecordId, priorRecordHash: validAuthorization.prior_record_hash,
    resolvingRecordId, resolvingRecordHash: validAuthorization.resolving_record_hash,
  }), /must be outside the project|must not contain symlinks/);
  const foreignProject = makeSession("foreign-authority-project");
  const foreignRegistry = path.join(foreignProject.projectRoot, "authority.json");
  writeJson(foreignRegistry, TEST_AUTHORITY_REGISTRY);
  process.env.FLOW_AGENTS_LIFECYCLE_AUTHORITY_REGISTRY = foreignRegistry;
  assert.throws(() => loadCritiqueResolutionAuthorization(authorizationFile, {
    projectRoot: session.projectRoot, runId: session.slug, subject: SUBJECT,
    priorBundleSha256: validAuthorization.prior_bundle_sha256, priorRecordId, priorRecordHash: validAuthorization.prior_record_hash,
    resolvingRecordId, resolvingRecordHash: validAuthorization.resolving_record_hash,
  }), /OS-owned|must not contain symlinks/);
  if (priorAuthorityPath === undefined) delete process.env.FLOW_AGENTS_LIFECYCLE_AUTHORITY_REGISTRY;
  else process.env.FLOW_AGENTS_LIFECYCLE_AUTHORITY_REGISTRY = priorAuthorityPath;
  const preparedAuthorization = loadCritiqueResolutionAuthorization(authorizationFile, {
    projectRoot: session.projectRoot, runId: session.slug, subject: SUBJECT,
    priorBundleSha256: validAuthorization.prior_bundle_sha256,
    priorRecordId, priorRecordHash: validAuthorization.prior_record_hash,
    resolvingRecordId, resolvingRecordHash: validAuthorization.resolving_record_hash,
  });
  recordAuthorizationConsumed(session.artifactRoot, preparedAuthorization);
  const conflictingNonceAuthorization = critiqueResolutionAuthorization(session, priorRecordId, resolvingRecordId, finalReviewer.actorKey, "conflicting-nonce", {
    nonce: validAuthorization.nonce,
    expires_at: new Date(Date.now() + 120_000).toISOString(),
  });
  await assert.rejects(() => resolveWith(conflictingNonceAuthorization), /consumed lifecycle authorization record does not match/);
  const result = await workflowMain([
    "resolve-critique", "--session-dir", session.sessionDir,
    "--prior-record-id", priorRecordId,
    "--resolving-record-id", resolvingRecordId,
    "--authorization-file", authorizationFile,
    "--json",
  ]);
  assert.equal(result, 0);
  const after = readJson(path.join(session.sessionDir, "trust.bundle"));
  const history = after.claims.find((claim) => claim.metadata?.origin === "critique" && claim.metadata?.reviewer === "ephemeral-reviewer");
  assert.equal(history.status, "superseded");
  assert.equal(history.value, "fail");
  assert.equal(history.createdAt, prior.createdAt);
  assert.equal(history.updatedAt, prior.updatedAt);
  assert.equal(history.metadata.reviewed_at, prior.metadata.reviewed_at);
  assert.deepEqual(history.metadata.findings, [{ id: "blocking-defect", severity: "high", status: "open", description: "Requires repair." }]);
  assert.equal(history.metadata.critique_resolution.resolving_record_id, resolvingRecordId);
  assert.equal(history.metadata.critique_resolution.resolver, finalReviewer.actorKey);
  assert.equal(after.critique_resolution_events.length, 1);
  assert.equal(after.critique_resolution_events[0].authorization_nonce, validAuthorization.nonce);
  assert.equal(fs.readFileSync(canonicalManifest, "utf8"), manifestBeforeResolution, "critique resolution must preserve canonical manifest bytes");
  assert.equal(validateResolvedGraph(after).valid, true);
  const resolvedBytes = fs.readFileSync(path.join(session.sessionDir, "trust.bundle"), "utf8");
  const forgedBundle = JSON.parse(resolvedBytes);
  const forgedHistory = forgedBundle.claims.find((claim) => claim.metadata?.critique_resolution);
  forgedHistory.metadata.superseded_by = "critique:missing";
  forgedHistory.metadata.critique_resolution.resolving_record_id = "critique:missing";
  fs.writeFileSync(path.join(session.sessionDir, "trust.bundle"), `${JSON.stringify(forgedBundle, null, 2)}\n`);
  assert.equal(validateResolvedGraph(forgedBundle).valid, false, "a forged resolution edge must not validate");
  const forgedEventBundle = JSON.parse(resolvedBytes);
  const forgedEvent = forgedEventBundle.critique_resolution_events[0];
  forgedEvent.resolver = "forged-reviewer";
  forgedEvent.edge.resolver = "forged-reviewer";
  const { event_hash: _oldEventHash, ...forgedUnsignedEvent } = forgedEvent;
  forgedEvent.event_hash = createHash("sha256").update(JSON.stringify(forgedUnsignedEvent)).digest("hex");
  fs.writeFileSync(path.join(session.sessionDir, "trust.bundle"), `${JSON.stringify(forgedEventBundle, null, 2)}\n`);
  assert.equal(validateResolvedGraph(forgedEventBundle).valid, false, "a coherently rehashed event without matching signed authority must not validate");
  const forgedSemanticEventBundle = JSON.parse(resolvedBytes);
  const forgedSemanticEvent = forgedSemanticEventBundle.critique_resolution_events[0];
  forgedSemanticEvent.edge.resolved_at = "2030-01-01T00:00:00.000Z";
  const { event_hash: _semanticEventHash, ...forgedSemanticUnsignedEvent } = forgedSemanticEvent;
  forgedSemanticEvent.event_hash = createHash("sha256").update(JSON.stringify(forgedSemanticUnsignedEvent)).digest("hex");
  fs.writeFileSync(path.join(session.sessionDir, "trust.bundle"), `${JSON.stringify(forgedSemanticEventBundle, null, 2)}\n`);
  assert.equal(validateResolvedGraph(forgedSemanticEventBundle).valid, false, "an event whose embedded edge differs from its signed resolution edge must not validate");
  const forgedResultBundle = JSON.parse(resolvedBytes);
  forgedResultBundle.critique_resolution_events[0].resulting_core_sha256 = "f".repeat(64);
  const { event_hash: _resultEventHash, ...forgedResultUnsigned } = forgedResultBundle.critique_resolution_events[0];
  forgedResultBundle.critique_resolution_events[0].event_hash = createHash("sha256").update(JSON.stringify(forgedResultUnsigned)).digest("hex");
  assert.equal(validateResolvedGraph(forgedResultBundle).valid, false, "a coherently rehashed divergent result digest must not validate");
  const cyclicBundle = JSON.parse(resolvedBytes);
  const cyclicResolver = cyclicBundle.claims.find((claim) => claim.metadata?.critique_record_id === resolvingRecordId);
  cyclicResolver.metadata.superseded_by = priorRecordId;
  cyclicResolver.metadata.critique_resolution = {
    schema_version: "1.0", kind: "cross-reviewer", prior_record_id: resolvingRecordId,
    resolving_record_id: priorRecordId, resolver: cyclicBundle.claims.find((claim) => claim.metadata?.critique_record_id === priorRecordId).metadata.reviewer,
    resolved_lane_ids: ["code-review"], resolved_finding_ids: [], resolved_at: "2026-07-19T10:02:00Z",
  };
  fs.writeFileSync(path.join(session.sessionDir, "trust.bundle"), `${JSON.stringify(cyclicBundle, null, 2)}\n`);
  assert.equal(validateResolvedGraph(cyclicBundle).valid, false, "a cyclic resolution graph must not validate");
  fs.writeFileSync(path.join(session.sessionDir, "trust.bundle"), resolvedBytes);
  const replay = await workflowMain([
    "resolve-critique", "--session-dir", session.sessionDir,
    "--prior-record-id", priorRecordId,
    "--resolving-record-id", resolvingRecordId,
    "--authorization-file", authorizationFile,
    "--json",
  ]);
  assert.equal(replay, 0);
  assert.equal(fs.readFileSync(path.join(session.sessionDir, "trust.bundle"), "utf8"), resolvedBytes, "a valid resolution replay is idempotent");
  if (originalCodexThread === undefined) delete process.env.CODEX_THREAD_ID;
  else process.env.CODEX_THREAD_ID = originalCodexThread;
});

externalAuthorityE2E("a scrubbed thirteen-review repair history migrates through sequential signed resolutions", async () => {
  // This is deliberately synthetic but mirrors the cardinality and review-shape of
  // a real historical session. It proves migration without carrying repository,
  // provider, or runtime identifiers into a public test fixture.
  const session = makeSession("scrubbed-critique-history");
  claimSessionAssignment(session);
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  await writeAndSync(session, [bundleClaim({ expectation: "selected-work", claimType: "builder.pull-work.selected", subjectType: "work-item" })]);
  await writeAndSync(session, [
    bundleClaim({ expectation: "pickup-probe-readiness", claimType: "builder.design-probe.pickup-readiness", subjectType: "work-item" }),
    bundleClaim({ expectation: "probe-decisions-or-accepted-gaps", claimType: "builder.design-probe.decisions", subjectType: "decision" }),
  ]);
  await writeAndSync(session, [bundleClaim({ expectation: "implementation-plan", claimType: "builder.plan.implementation", subjectType: "artifact" })]);
  await writeAndSync(session, [bundleClaim({ expectation: "implementation-scope", claimType: "builder.execute.scope", subjectType: "change" })]);
  const delivery = path.join(session.projectRoot, "review-target", "delivery.md");
  const lane = (status) => JSON.stringify({
    id: "repair-review", status, summary: "Independent repair review.",
    evidence_refs: [{ kind: "artifact", file: path.relative(session.projectRoot, delivery), summary: "Reviewed delivery artifact." }],
  });
  const reviewerCount = 4;
  for (let index = 0; index < 11; index += 1) {
    await workflowSidecarMain([
      "record-critique", session.sessionDir,
      "--id", `ephemeral-history-${index + 1}`, "--reviewer", `ephemeral-reviewer-${(index % reviewerCount) + 1}`, "--verdict", "fail",
      "--summary", `Synthetic historical finding ${index + 1}.`, "--artifact-ref", delivery,
      "--lane-json", lane("fail"),
      "--finding-json", JSON.stringify({ id: `finding-${index + 1}`, severity: "high", status: "open", description: `Repair ${index + 1} required.` }),
      "--timestamp", `2026-07-19T10:${String(index).padStart(2, "0")}:00.000Z`,
    ]);
  }
  fs.writeFileSync(delivery, "repaired delivery artifact after every historical finding\n");
  const fixedFindingArgs = () => Array.from({ length: 11 }, (_, index) => "--finding-json")
    .flatMap((flag, index) => [flag, JSON.stringify({ id: `finding-${index + 1}`, severity: "high", status: "fixed", description: `Repair ${index + 1} verified.` })]);
  await workflowSidecarMain([
    "record-critique", session.sessionDir,
    "--id", "independent-repair-observation", "--reviewer", "independent-repair-reviewer", "--verdict", "pass",
    "--summary", "Independent repair observation passed.", "--artifact-ref", delivery, "--lane-json", lane("pass"),
    ...fixedFindingArgs(), "--timestamp", "2026-07-19T10:11:00.000Z",
  ]);
  await workflowSidecarMain([
    "record-critique", session.sessionDir,
    "--id", "final-migration-review", "--reviewer", "final-independent-reviewer", "--verdict", "pass",
    "--summary", "Final independent repair review passed.", "--artifact-ref", delivery, "--lane-json", lane("pass"),
    ...fixedFindingArgs(),
    "--timestamp", "2026-07-19T10:12:00.000Z",
  ]);

  const bundleFile = path.join(session.sessionDir, "trust.bundle");
  const preChain = readJson(bundleFile);
  const historicalClaims = preChain.claims.filter((claim) => claim.metadata?.origin === "critique");
  assert.equal(historicalClaims.length, 13, "fixture has eleven disputed reviews plus two independent passing observations");
  for (const claim of historicalClaims) {
    delete claim.metadata.critique_sequence;
    delete claim.metadata.critique_predecessor_hash;
    delete claim.metadata.critique_record_hash;
    delete claim.metadata.critique_record_id;
  }
  fs.writeFileSync(bundleFile, `${JSON.stringify(preChain, null, 2)}\n`);
  const migrated = normalizeCritiqueChainRecords(historicalClaims.map((claim) => ({ ...claim.metadata, verdict: claim.value, summary: claim.fieldOrBehavior }))).records;
  assert.equal(migrated.length, 13);
  const finalRecordId = migrated.at(-1).critique_record_id;
  const validate = () => {
    const current = readJson(bundleFile);
    return validateCritiqueResolutionGraph(current.claims, SUBJECT, current.critique_resolution_events ?? [], session.projectRoot);
  };
  assert.equal(validate().valid, false, "unmigrated historical reviews remain fail-closed");

  for (const [index, prior] of migrated.filter((record) => record.verdict !== "pass").entries()) {
    const authorizationFile = critiqueResolutionAuthorization(session, prior.critique_record_id, finalRecordId, "final-independent-reviewer", `migrate-${prior.critique_sequence}`);
    const args = [
      "resolve-critique", "--session-dir", session.sessionDir,
      "--prior-record-id", prior.critique_record_id,
      "--resolving-record-id", finalRecordId,
      "--authorization-file", authorizationFile,
    ];
    if (index === 0) {
      const results = [await workflowMain(args), await workflowMain(args)];
      assert.deepEqual(results, [0, 0], "an identical retry validates and replays the persisted resolution");
    } else {
      await workflowMain(args);
    }
  }

  const migratedBundle = readJson(bundleFile);
  const migratedClaims = migratedBundle.claims.filter((claim) => claim.metadata?.origin === "critique");
  assert.equal(migratedClaims.filter((claim) => claim.status === "superseded").length, 11);
  assert.equal(migratedClaims.filter((claim) => !claim.metadata?.superseded_by && claim.value === "pass" && claim.status === "verified").length, 2);
  assert.equal(migratedBundle.critique_resolution_events.length, 11);
  assert.equal(validate().valid, true, "all historical failures have authenticated, hash-chained resolutions");
  assert.equal(consumedAuthorizationRecords(session).length, 11, "each migration edge consumes exactly one signed authority nonce");
});

test("trusted Git ancestry rejects a divergent repair snapshot", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-trusted-git-"));
  const git = (args) => {
    const result = spawnSync("/usr/bin/git", args, { cwd: projectRoot, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["init", "--initial-branch=main"]);
  git(["config", "user.email", "fixture@example.test"]);
  git(["config", "user.name", "Fixture"]);
  fs.writeFileSync(path.join(projectRoot, "review.txt"), "base\n");
  git(["add", "review.txt"]);
  git(["commit", "-m", "base"]);
  git(["checkout", "-b", "repair"]);
  fs.writeFileSync(path.join(projectRoot, "review.txt"), "repair\n");
  git(["commit", "-am", "repair"]);
  const repairHead = git(["rev-parse", "HEAD"]);
  git(["checkout", "main"]);
  fs.writeFileSync(path.join(projectRoot, "review.txt"), "other\n");
  git(["commit", "-am", "other"]);
  const divergentHead = git(["rev-parse", "HEAD"]);
  const maliciousReplacement = git(["commit-tree", `${divergentHead}^{tree}`, "-p", repairHead, "-m", "hostile replacement"]);
  git(["replace", divergentHead, maliciousReplacement]);
  assert.equal(spawnSync("/usr/bin/git", ["merge-base", "--is-ancestor", repairHead, divergentHead], { cwd: projectRoot }).status, 0, "hostile replacement makes ordinary Git accept false ancestry");
  assert.throws(() => assertTrustedGitAncestor(projectRoot, repairHead, divergentHead));
});

test("producer-superseded FAIL is audit history and live PASS drives verify", async () => {
  const session = makeSession("producer-superseded-verify");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  await writeAndSync(session, [bundleClaim({ expectation: "selected-work", claimType: "builder.pull-work.selected", subjectType: "work-item" })]);
  await writeAndSync(session, [
    bundleClaim({ expectation: "pickup-probe-readiness", claimType: "builder.design-probe.pickup-readiness", subjectType: "work-item" }),
    bundleClaim({ expectation: "probe-decisions-or-accepted-gaps", claimType: "builder.design-probe.decisions", subjectType: "decision" }),
  ]);
  await writeAndSync(session, [bundleClaim({ expectation: "implementation-plan", claimType: "builder.plan.implementation", subjectType: "artifact" })]);
  await writeAndSync(session, [bundleClaim({ expectation: "implementation-scope", claimType: "builder.execute.scope", subjectType: "change" })]);

  const livePass = bundleClaim({ expectation: "tests-evidence", claimType: "builder.verify.tests", subjectType: "flow-step" });
  const historicalFail = historicalProducerSuperseded(bundleClaim({
    expectation: "tests-evidence",
    claimType: "builder.verify.tests",
    subjectType: "flow-step",
    status: "fail",
    routeReason: "implementation_defect",
  }));
  const result = await writeAndSync(session, [historicalFail, livePass, ...verifiedTestsPrerequisites(session)]);

  assert.equal(result.run.state.current_step, "merge-ready");
  const attached = result.run.manifest.evidence.filter((entry) => entry.gate_id === "verify-gate" && !entry.superseded_by);
  assert.equal(attached.length, 1);
  assert.deepEqual(attached[0].expectation_ids.sort(), ["acceptance-criteria", "clean-critique", "tests-evidence"]);
});

test("partial passing review snapshot waits for the complete verify expectation set", async () => {
  const session = makeSession("atomic-review-sync");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  await writeAndSync(session, [bundleClaim({ expectation: "selected-work", claimType: "builder.pull-work.selected", subjectType: "work-item" })]);
  await writeAndSync(session, [
    bundleClaim({ expectation: "pickup-probe-readiness", claimType: "builder.design-probe.pickup-readiness", subjectType: "work-item" }),
    bundleClaim({ expectation: "probe-decisions-or-accepted-gaps", claimType: "builder.design-probe.decisions", subjectType: "decision" }),
  ]);
  await writeAndSync(session, [bundleClaim({ expectation: "implementation-plan", claimType: "builder.plan.implementation", subjectType: "artifact" })]);
  await writeAndSync(session, [bundleClaim({ expectation: "implementation-scope", claimType: "builder.execute.scope", subjectType: "change" })]);

  const disputedCritique = verifiedTestsPrerequisites(session)[0];
  disputedCritique.claim.value = "fail";
  disputedCritique.claim.status = "disputed";
  disputedCritique.event.status = "disputed";
  const disputedPartial = await writeAndSync(session, [disputedCritique]);
  assert.equal(disputedPartial.attached, false);
  assert.equal(disputedPartial.run.state.transitions.filter((transition) => transition.type === "route_back").length, 0);

  const partial = await writeAndSync(session, verifiedTestsPrerequisites(session).slice(0, 1));
  assert.equal(partial.attached, false);
  assert.equal(partial.run.state.current_step, "verify");
  assert.equal(partial.run.state.transitions.filter((transition) => transition.type === "route_back").length, 0);

  const definition = readJson(path.join(partial.run.dir, "definition.json"));
  const validPartialBundle = readJson(path.join(session.sessionDir, "trust.bundle"));
  const validPartialEvidence = {
    id: "partial-verify-evidence",
    gate_id: "verify-gate",
    kind: "trust.bundle",
    requested_kind: "trust.bundle",
    sha256: "a".repeat(64),
    status: "passed",
    attached_at: new Date().toISOString(),
    expectation_ids: ["clean-critique"],
    bundle: validPartialBundle,
  };
  const partialEnvelope = deriveBuilderGateActionEnvelope({
    sessionDir: session.sessionDir,
    projectRoot: session.projectRoot,
    run: {
      ...partial.run,
      manifest: {
        ...partial.run.manifest,
        evidence: [...partial.run.manifest.evidence, validPartialEvidence],
      },
    },
    definition,
  });
  assert.equal(partialEnvelope.gate.requirements.find((entry) => entry.id === "clean-critique").status, "satisfied");
  assert.deepEqual(partialEnvelope.gate.unresolved_requirement_ids.sort(), ["acceptance-criteria", "policy-compliance", "tests-evidence"]);
  assert.equal(partialEnvelope.gate.requirements.find((entry) => entry.id === "policy-compliance").required, false);
  assert.deepEqual(partialEnvelope.stop_condition.required.unresolved_evidence_ids.sort(), ["acceptance-criteria", "tests-evidence"]);
  assert.equal(partialEnvelope.stop_condition.required.artifact_refs.some((artifact) => artifact.ref === "trust.bundle#policy-compliance"), false);
  const critique = partialEnvelope.public_interfaces.mutations.find((entry) => entry.interface === "workflow.critique");
  assert.deepEqual(critique.parameters.find((entry) => entry.name === "verdict").allowed_values, [...WORKFLOW_CRITIQUE_STATUSES]);
  assert.deepEqual(critique.parameters.find((entry) => entry.name === "artifact_ref"), {
    name: "artifact_ref", flag: "--artifact-ref", required: false, repeatable: true,
    required_when: { parameter: "verdict", equals: "pass" },
  });

  const complete = await writeAndSync(session, [
    bundleClaim({ expectation: "tests-evidence", claimType: "builder.verify.tests", subjectType: "flow-step" }),
    ...verifiedTestsPrerequisites(session),
  ]);
  assert.equal(complete.run.state.current_step, "merge-ready");
});

test("expectation_ids labels cannot satisfy a mismatched trust bundle claim", async () => {
  const session = makeSession("mislabeled-partial-gate");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  await writeAndSync(session, [bundleClaim({ expectation: "selected-work", claimType: "builder.pull-work.selected", subjectType: "work-item" })]);
  await writeAndSync(session, [
    bundleClaim({ expectation: "pickup-probe-readiness", claimType: "builder.design-probe.pickup-readiness", subjectType: "work-item" }),
    bundleClaim({ expectation: "probe-decisions-or-accepted-gaps", claimType: "builder.design-probe.decisions", subjectType: "decision" }),
  ]);
  await writeAndSync(session, [bundleClaim({ expectation: "implementation-plan", claimType: "builder.plan.implementation", subjectType: "artifact" })]);
  await writeAndSync(session, [bundleClaim({ expectation: "implementation-scope", claimType: "builder.execute.scope", subjectType: "change" })]);
  const partial = await writeAndSync(session, verifiedTestsPrerequisites(session).slice(0, 1));

  const mislabeledBundle = readJson(path.join(session.sessionDir, "trust.bundle"));
  mislabeledBundle.claims[0].claimType = "workflow.critique.wrong-claim";
  const definition = readJson(path.join(partial.run.dir, "definition.json"));
  const envelope = deriveBuilderGateActionEnvelope({
    sessionDir: session.sessionDir,
    projectRoot: session.projectRoot,
    run: {
      ...partial.run,
      manifest: {
        ...partial.run.manifest,
        evidence: [...partial.run.manifest.evidence, {
          id: "mislabeled-partial-verify-evidence",
          gate_id: "verify-gate",
          kind: "trust.bundle",
          requested_kind: "trust.bundle",
          sha256: "b".repeat(64),
          status: "passed",
          attached_at: new Date().toISOString(),
          expectation_ids: ["clean-critique"],
          bundle: mislabeledBundle,
        }],
      },
    },
    definition,
  });

  assert.equal(envelope.gate.requirements.find((entry) => entry.id === "clean-critique").status, "unresolved");
  assert.equal(envelope.gate.unresolved_requirement_ids.includes("clean-critique"), true);
});

test("initial gate boundary rejects pre-run and far-future claims", async () => {
  for (const [name, timestamp] of [
    ["pre-run", NOW],
    ["far-future", new Date(Date.now() + 60 * 60_000).toISOString()],
  ]) {
    const session = makeSession(`freshness-${name}`);
    await startBuilderFlowSession({ sessionDir: session.sessionDir });
    const result = await writeAndSync(session, [bundleClaim({
      expectation: "selected-work",
      claimType: "builder.pull-work.selected",
      subjectType: "work-item",
      timestamp,
    })]);
    assert.equal(result.attached, false, name);
    assert.equal(result.run.state.current_step, "pull-work", name);
  }
});

test("prior claim identity is rejected after re-entry and a new identity can recover", async () => {
  const session = makeSession("same-digest-reentry");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  await writeAndSync(session, [bundleClaim({ expectation: "selected-work", claimType: "builder.pull-work.selected", subjectType: "work-item" })]);
  await writeAndSync(session, [
    bundleClaim({ expectation: "pickup-probe-readiness", claimType: "builder.design-probe.pickup-readiness", subjectType: "work-item" }),
    bundleClaim({ expectation: "probe-decisions-or-accepted-gaps", claimType: "builder.design-probe.decisions", subjectType: "decision" }),
  ]);
  await writeAndSync(session, [bundleClaim({ expectation: "implementation-plan", claimType: "builder.plan.implementation", subjectType: "artifact" })]);
  await writeAndSync(session, [bundleClaim({ expectation: "implementation-scope", claimType: "builder.execute.scope", subjectType: "change" })]);
  const future = new Date(Date.now() + 10_000).toISOString();
  const failure = [bundleClaim({ expectation: "tests-evidence", claimType: "builder.verify.tests", subjectType: "flow-step", status: "fail", routeReason: "implementation_defect", timestamp: future }), ...verifiedTestsPrerequisites(session, future)];
  const first = await writeAndSync(session, failure);
  assert.equal(first.run.state.current_step, "execute");
  await writeAndSync(session, [withIdentitySuffix(bundleClaim({ expectation: "implementation-scope", claimType: "builder.execute.scope", subjectType: "change", timestamp: future }), "reentry")]);
  const replay = await writeAndSync(session, failure);
  assert.equal(replay.attached, false);
  assert.equal(replay.run.state.current_step, "verify");
  assert.equal(replay.run.state.transitions.filter((transition) => transition.type === "route_back").length, 1);
  const newIdentity = failure.map((entry, index) => withIdentitySuffix(entry, `visit-2-${index}`));
  const second = await writeAndSync(session, newIdentity);
  assert.equal(second.run.state.current_step, "execute");
  const verifyEvidence = second.run.manifest.evidence.filter((entry) => entry.gate_id === "verify-gate");
  assert.equal(verifyEvidence.length, 2);
  assert.equal(verifyEvidence[0].superseded_by, verifyEvidence[1].id);
});

test("legacy colon-bearing assignment actor releases only through its normalized equivalent", () => {
  const session = makeSession("legacy-actor-release");
  const legacyActor = { runtime: "unknown", session_id: "legacy-session", host: "Kontour", human: null };
  performLocalClaim(session.artifactRoot, session.slug, legacyActor, {
    ttlSeconds: 1800,
    actorKey: "unknown:legacy-session:Kontour",
    branch: `agent/${session.slug}`,
    artifactDir: session.sessionDir,
    workItemRef: SUBJECT,
    reason: "legacy fixture",
  });
  assert.throws(() => performLocalRelease(session.artifactRoot, session.slug, legacyActor, {
    actorKey: "different-actor",
  }), /refusing to release/);
  assert.throws(() => performLocalRelease(session.artifactRoot, session.slug, { ...legacyActor, session_id: "different" }, {
    actorKey: "unknownlegacy-sessionKontour",
  }), /refusing to release/);
  const released = performLocalRelease(session.artifactRoot, session.slug, legacyActor, {
    actorKey: "unknownlegacy-sessionKontour",
  });
  assert.equal(released.status, "released");
});

test("string-only legacy liveness identity cannot be released by a colliding modern actor", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-legacy-liveness-"));
  const eventsFile = path.join(root, "liveness", "events.jsonl");
  fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
  fs.writeFileSync(eventsFile, `${JSON.stringify({
    type: "claim",
    subjectId: "legacy-subject",
    actor: "unknown:anc-123456789abc:Kontour",
    at: NOW,
    ttlSeconds: 1800,
  })}\n`);

  await assert.rejects(() => workflowSidecarMain([
    "liveness", "release", "legacy-subject",
    "--actor", "unknownanc-123456789abcKontour",
    "--artifact-root", root,
    "--at", "2026-07-09T20:01:00.000Z",
  ]), /prior claim/);
  const events = fs.readFileSync(eventsFile, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(events.length, 1);
});

test("lossy modern liveness key collision cannot release a non-reversible legacy actor", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-lossy-liveness-"));
  const eventsFile = path.join(root, "liveness", "events.jsonl");
  fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
  fs.writeFileSync(eventsFile, `${JSON.stringify({ type: "claim", subjectId: "collision", actor: "a:b", at: NOW, ttlSeconds: 1800 })}\n`);
  await assert.rejects(() => workflowSidecarMain([
    "liveness", "release", "collision", "--actor", "ab", "--artifact-root", root,
  ]), /prior claim/);
  assert.equal(fs.readFileSync(eventsFile, "utf8").trim().split("\n").length, 1);
});

test("upgrade rebuild preserves legacy critique identity until a versioned new review", async () => {
  const legacy = {
    id: "upgrade-review",
    reviewer: "reviewer",
    reviewed_at: "2026-07-01T00:00:00Z",
    verdict: "pass",
    summary: "Legacy clean review",
    findings: [],
    lanes: [{ id: "code", status: "pass" }],
    review_target: { artifacts: [] },
    artifact_refs: [],
  };
  const beforeUpgrade = await buildTrustBundle("upgrade-fixture", "2026-07-01T00:00:00Z", [], [], [legacy]);
  const rebuiltAfterUpgrade = await buildTrustBundle("upgrade-fixture", "2026-07-12T00:00:00Z", [], [], [legacy]);
  const newReview = await buildTrustBundle("upgrade-fixture", "2026-07-12T00:01:00Z", [], [], [{
    ...legacy,
    reviewed_at: "2026-07-12T00:01:00Z",
    identity_version: 2,
  }]);
  assert.equal(beforeUpgrade.claims[0].id, rebuiltAfterUpgrade.claims[0].id);
  assert.notEqual(newReview.claims[0].id, beforeUpgrade.claims[0].id);
  assert.equal(rebuiltAfterUpgrade.claims[0].metadata.identity_version, undefined);
  assert.equal(newReview.claims[0].metadata.identity_version, 2);
});

test("passing tests-evidence rejects a critique whose reviewed artifact changed", async () => {
  const session = makeSession("stale-critique-artifact");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  await writeAndSync(session, [bundleClaim({ expectation: "selected-work", claimType: "builder.pull-work.selected", subjectType: "work-item" })]);
  await writeAndSync(session, [
    bundleClaim({ expectation: "pickup-probe-readiness", claimType: "builder.design-probe.pickup-readiness", subjectType: "work-item" }),
    bundleClaim({ expectation: "probe-decisions-or-accepted-gaps", claimType: "builder.design-probe.decisions", subjectType: "decision" }),
  ]);
  await writeAndSync(session, [bundleClaim({ expectation: "implementation-plan", claimType: "builder.plan.implementation", subjectType: "artifact" })]);
  await writeAndSync(session, [bundleClaim({ expectation: "implementation-scope", claimType: "builder.execute.scope", subjectType: "change" })]);
  const prerequisites = verifiedTestsPrerequisites(session);
  fs.writeFileSync(path.join(session.projectRoot, "review-target", "delivery.md"), "changed after review\n");
  await assert.rejects(
    () => writeAndSync(session, [bundleClaim({ expectation: "tests-evidence", claimType: "builder.verify.tests", subjectType: "flow-step" }), ...prerequisites]),
    /review_target\.artifacts\.sha256.*does not match/,
  );
});

test("stale passing critique remains audit history when a current exact-workspace critique passes", async () => {
  const session = makeSession("stale-passing-current-clean");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  await writeAndSync(session, [bundleClaim({ expectation: "selected-work", claimType: "builder.pull-work.selected", subjectType: "work-item" })]);
  await writeAndSync(session, [
    bundleClaim({ expectation: "pickup-probe-readiness", claimType: "builder.design-probe.pickup-readiness", subjectType: "work-item" }),
    bundleClaim({ expectation: "probe-decisions-or-accepted-gaps", claimType: "builder.design-probe.decisions", subjectType: "decision" }),
  ]);
  await writeAndSync(session, [bundleClaim({ expectation: "implementation-plan", claimType: "builder.plan.implementation", subjectType: "artifact" })]);
  await writeAndSync(session, [bundleClaim({ expectation: "implementation-scope", claimType: "builder.execute.scope", subjectType: "change" })]);
  const capturedAt = Date.now();
  const legacy = asPreChainCritique(verifiedTestsPrerequisites(session, new Date(capturedAt).toISOString())[0], "legacy-same-reviewer-pass");
  legacy.claim.metadata.superseded_by = "legacy-same-reviewer-recheck";
  const stale = asPreChainCritique(verifiedTestsPrerequisites(session, new Date(capturedAt + 1).toISOString())[0], "stale-other-reviewer-pass");
  stale.claim.metadata.reviewer = "unavailable-prior-reviewer";
  fs.writeFileSync(path.join(session.projectRoot, "review-target", "implementation.txt"), "corrected implementation\n");
  const [currentEntry, criterion] = verifiedTestsPrerequisites(session, new Date(capturedAt + 2).toISOString());
  const current = asPreChainCritique(currentEntry, "current-pass");

  const result = await writeAndSync(session, [
    bundleClaim({ expectation: "tests-evidence", claimType: "builder.verify.tests", subjectType: "flow-step" }),
    legacy,
    stale,
    current,
    criterion,
  ]);

  assert.equal(result.run.state.current_step, "merge-ready");
});

test("stale open critique remains blocking even when a different reviewer supplies a current clean critique", async () => {
  const session = makeSession("stale-open-current-clean");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  await writeAndSync(session, [bundleClaim({ expectation: "selected-work", claimType: "builder.pull-work.selected", subjectType: "work-item" })]);
  await writeAndSync(session, [
    bundleClaim({ expectation: "pickup-probe-readiness", claimType: "builder.design-probe.pickup-readiness", subjectType: "work-item" }),
    bundleClaim({ expectation: "probe-decisions-or-accepted-gaps", claimType: "builder.design-probe.decisions", subjectType: "decision" }),
  ]);
  await writeAndSync(session, [bundleClaim({ expectation: "implementation-plan", claimType: "builder.plan.implementation", subjectType: "artifact" })]);
  await writeAndSync(session, [bundleClaim({ expectation: "implementation-scope", claimType: "builder.execute.scope", subjectType: "change" })]);
  const capturedAt = Date.now();
  const stale = asPreChainCritique(verifiedTestsPrerequisites(session, new Date(capturedAt).toISOString())[0], "stale-open");
  stale.claim.metadata.reviewer = "unavailable-prior-reviewer";
  stale.claim.metadata.findings = [{ id: "old-open-finding", status: "open", summary: "Must not be buried." }];
  fs.writeFileSync(path.join(session.projectRoot, "review-target", "implementation.txt"), "corrected implementation\n");
  const [currentEntry, criterion] = verifiedTestsPrerequisites(session, new Date(capturedAt + 1).toISOString());
  const current = asPreChainCritique(currentEntry, "current-after-open");

  await assert.rejects(
    () => writeAndSync(session, [
      bundleClaim({ expectation: "tests-evidence", claimType: "builder.verify.tests", subjectType: "flow-step" }),
      stale,
      current,
      criterion,
    ]),
    /requires a current clean critique/,
  );
});

test("malformed stale passing critique remains blocking when a current clean critique exists", async () => {
  const session = makeSession("malformed-stale-current-clean");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  await writeAndSync(session, [bundleClaim({ expectation: "selected-work", claimType: "builder.pull-work.selected", subjectType: "work-item" })]);
  await writeAndSync(session, [
    bundleClaim({ expectation: "pickup-probe-readiness", claimType: "builder.design-probe.pickup-readiness", subjectType: "work-item" }),
    bundleClaim({ expectation: "probe-decisions-or-accepted-gaps", claimType: "builder.design-probe.decisions", subjectType: "decision" }),
  ]);
  await writeAndSync(session, [bundleClaim({ expectation: "implementation-plan", claimType: "builder.plan.implementation", subjectType: "artifact" })]);
  await writeAndSync(session, [bundleClaim({ expectation: "implementation-scope", claimType: "builder.execute.scope", subjectType: "change" })]);
  const capturedAt = Date.now();
  const stale = asPreChainCritique(verifiedTestsPrerequisites(session, new Date(capturedAt).toISOString())[0], "malformed-stale");
  stale.claim.metadata.reviewer = "unavailable-prior-reviewer";
  stale.claim.metadata.review_target.workspace_snapshot.files = [];
  fs.writeFileSync(path.join(session.projectRoot, "review-target", "implementation.txt"), "corrected implementation\n");
  const [currentEntry, criterion] = verifiedTestsPrerequisites(session, new Date(capturedAt + 1).toISOString());
  const current = asPreChainCritique(currentEntry, "current-after-malformed");

  await assert.rejects(
    () => writeAndSync(session, [
      bundleClaim({ expectation: "tests-evidence", claimType: "builder.verify.tests", subjectType: "flow-step" }),
      stale,
      current,
      criterion,
    ]),
    /workspace_snapshot\.files.*must list explicitly reviewed files/,
  );
});

test("passing tests-evidence rejects a successful command that executed zero tests", async () => {
  const session = makeSession("zero-test-evidence");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  await writeAndSync(session, [bundleClaim({ expectation: "selected-work", claimType: "builder.pull-work.selected", subjectType: "work-item" })]);
  await writeAndSync(session, [
    bundleClaim({ expectation: "pickup-probe-readiness", claimType: "builder.design-probe.pickup-readiness", subjectType: "work-item" }),
    bundleClaim({ expectation: "probe-decisions-or-accepted-gaps", claimType: "builder.design-probe.decisions", subjectType: "decision" }),
  ]);
  await writeAndSync(session, [bundleClaim({ expectation: "implementation-plan", claimType: "builder.plan.implementation", subjectType: "artifact" })]);
  await writeAndSync(session, [bundleClaim({ expectation: "implementation-scope", claimType: "builder.execute.scope", subjectType: "change" })]);
  await assert.rejects(
    () => writeAndSync(session, [
      bundleClaim({ expectation: "tests-evidence", claimType: "builder.verify.tests", subjectType: "flow-step", testCount: 0 }),
      ...verifiedTestsPrerequisites(session),
    ]),
    /positive executed-test count/,
  );
});

test("passing tests-evidence rejects a critique after implementation source changed", async () => {
  const session = makeSession("stale-critique-workspace");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  await writeAndSync(session, [bundleClaim({ expectation: "selected-work", claimType: "builder.pull-work.selected", subjectType: "work-item" })]);
  await writeAndSync(session, [
    bundleClaim({ expectation: "pickup-probe-readiness", claimType: "builder.design-probe.pickup-readiness", subjectType: "work-item" }),
    bundleClaim({ expectation: "probe-decisions-or-accepted-gaps", claimType: "builder.design-probe.decisions", subjectType: "decision" }),
  ]);
  await writeAndSync(session, [bundleClaim({ expectation: "implementation-plan", claimType: "builder.plan.implementation", subjectType: "artifact" })]);
  await writeAndSync(session, [bundleClaim({ expectation: "implementation-scope", claimType: "builder.execute.scope", subjectType: "change" })]);
  const prerequisites = verifiedTestsPrerequisites(session);
  fs.writeFileSync(path.join(session.projectRoot, "review-target", "implementation.txt"), "source changed after review\n");
  await assert.rejects(
    () => writeAndSync(session, [bundleClaim({ expectation: "tests-evidence", claimType: "builder.verify.tests", subjectType: "flow-step" }), ...prerequisites]),
    /requires a clean critique of the current implementation workspace/,
  );
});

test("workspace review fails closed when a Git worktree marker cannot be inspected", () => {
  const session = makeSession("git-inspection-unavailable");
  fs.mkdirSync(path.join(session.projectRoot, ".git"));
  assert.throws(
    () => captureReviewWorkspaceSnapshot(session.projectRoot, [{ file: "review-target/delivery.md", sha256: createHash("sha256").update("reviewed delivery\n").digest("hex") }]),
    /could not inspect the Git worktree/,
  );
});

test("workspace review uses reviewed files only for a genuine non-Git root", () => {
  const session = makeSession("non-git-review-snapshot");
  const snapshot = captureReviewWorkspaceSnapshot(session.projectRoot, [{ file: "review-target/delivery.md", sha256: createHash("sha256").update("reviewed delivery\n").digest("hex") }]);
  assert.equal(snapshot.kind, "reviewed-files");
});

test("workspace review rejects a nested root inside a Git worktree", () => {
  const session = makeSession("nested-git-review-snapshot");
  execFileSync("git", ["init", "-q"], { cwd: session.projectRoot });
  const nestedRoot = path.join(session.projectRoot, "review-target");
  assert.throws(
    () => captureReviewWorkspaceSnapshot(nestedRoot, [{ file: "delivery.md", sha256: createHash("sha256").update("reviewed delivery\n").digest("hex") }]),
    /canonical project root must match the Git worktree root/,
  );
});

test("publish-change reports an external capability gap and self-authored results cannot pass", async () => {
  const session = makeSession("composed-completion");
  const ambient = claimAmbientSessionAssignment(session);
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  const steps = [
    () => [bundleClaim({ expectation: "selected-work", claimType: "builder.pull-work.selected", subjectType: "work-item" })],
    () => [
      bundleClaim({ expectation: "pickup-probe-readiness", claimType: "builder.design-probe.pickup-readiness", subjectType: "work-item" }),
      bundleClaim({ expectation: "probe-decisions-or-accepted-gaps", claimType: "builder.design-probe.decisions", subjectType: "decision" }),
    ],
    () => [bundleClaim({ expectation: "implementation-plan", claimType: "builder.plan.implementation", subjectType: "artifact" })],
    () => [bundleClaim({ expectation: "implementation-scope", claimType: "builder.execute.scope", subjectType: "change" })],
    () => [bundleClaim({ expectation: "tests-evidence", claimType: "builder.verify.tests", subjectType: "flow-step" }), ...verifiedTestsPrerequisites(session)],
    () => [bundleClaim({ expectation: "merge-readiness", claimType: "builder.merge-ready.readiness", subjectType: "change" })],
  ];
  for (const entries of steps) await writeAndSync(session, entries());

  const prOpen = readJson(path.join(session.sessionDir, "state.json"));
  assert.equal(prOpen.flow_run.current_step, "pr-open");
  assert.equal(readJson(path.join(session.artifactRoot, "current.json")).active_step_id, "pr-open");
  assert.deepEqual(prOpen.next_action.skills, []);
  assert.deepEqual(prOpen.next_action.operations, ["publish-change"]);
  assert.equal(prOpen.next_action.status, "blocked");
  assert.equal(prOpen.next_action.external_capability.completion, "external_verification_required");

  const operationView = await syncBuilderFlowSession({ sessionDir: session.sessionDir });
  const publish = operationView.gateActionEnvelope.public_interfaces.mutations.find((entry) => entry.interface === "operation");
  assert.deepEqual(operationView.gateActionEnvelope.action.declared_artifacts, [{
    kind: "file",
    ref: "publish-change.result.json",
    path: `.kontourai/flow-agents/${session.slug}/publish-change.result.json`,
    direct_write_allowed: false,
    produced_via: { interface: "operation", operations: ["publish-change"] },
  }]);
  assert.deepEqual(operationView.gateActionEnvelope.action.artifact_bindings, [{
    target: operationView.gateActionEnvelope.action.declared_artifacts[0],
    expectation_ids: ["pull-request-opened"],
  }]);
  assert.equal(publish.operation, "publish-change");
  assert.equal(publish.protocol.capability, "change.create");
  assert.deepEqual(publish.protocol.result.required, ["schema_version", "operation", "binding", "provider", "repository", "change_ref", "assignment_actor", "provider_actor", "observed_at"]);
  assert.deepEqual(publish.protocol.result.properties.change_ref.required, ["provider_record_id", "number", "url", "state", "base_ref", "head_ref", "head_sha"]);
  assert.deepEqual(publish.protocol.result.url_protocols, ["https:"]);
  assert.equal(publish.protocol.result.persist_as, "publish-change.result.json");
  assert.equal(publish.binding.run_id, session.slug);
  assert.equal(publish.binding.step_id, "pr-open");
  assert.deepEqual(publish.binding.gate_ids, ["builder.publish-learn:pr-open-gate"]);
  assert.match(publish.binding.gate_visit_id, /^[a-f0-9]{64}$/);
  assert.deepEqual(publish.completion, {
    status: "external_verification_required",
    executable_by_flow_agents: false,
    gate_evidence_interface: null,
  });
  assert.equal(Object.hasOwn(publish, "record_completion"), false);
  const providerResult = { provider: "fixture", repository: "kontourai/flow-agents", number: 577, url: "https://example.test/kontourai/flow-agents/pull/577", head_ref: "issue-577", base_ref: "main" };
  writeJson(path.join(session.sessionDir, publish.protocol.result.persist_as), providerResult);
  const unchanged = await syncBuilderFlowSession({ sessionDir: session.sessionDir });
  assert.equal(unchanged.attached, false);
  assert.equal(unchanged.run.state.current_step, "pr-open");
  assert.equal(unchanged.projection.next_action.status, "blocked");
  assert.equal(unchanged.run.manifest.evidence.some((entry) => entry.expectation_ids?.includes("pull-request-opened")), false);
  const beforeFlow = snapshotTree(runDir(session.slug, session.projectRoot));
  const beforeProjection = snapshotProjectionTargets(session);
  const genericEvidenceArgs = ["evidence", "--session-dir", session.sessionDir, "--expectation", "pull-request-opened", "--status", "pass", "--summary", "self-completion", "--evidence-ref-json", JSON.stringify({ kind: "artifact", file: `.kontourai/flow-agents/${session.slug}/publish-change.result.json`, summary: "locally authored provider-shaped result" })];
  await assert.rejects(
    () => workflowMain(genericEvidenceArgs),
    /operation-bound expectation.*authenticated external ChangeProvider/,
  );
  assert.deepEqual(snapshotTree(runDir(session.slug, session.projectRoot)), beforeFlow);
  assert.deepEqual(snapshotProjectionTargets(session), beforeProjection);

  await withContinuationDriverLock(session.sessionDir, async (lock) => {
    const driverDir = path.join(session.sessionDir, "continuation-driver");
    writeJson(path.join(driverDir, "state.json"), {
      schema_version: "1.0", run_id: session.slug, definition_id: "builder.build", max_turns: 1,
      adapter_command_identity: "operation-rejection-test", status: "active", turns_started: 1,
      active_turn_step: "pr-open", active_turn_public_key_digest: null, pending_barrier: null,
    });
    const issued = activeTurnAuthority.issueActiveTurnAuthority({
      sessionDir: session.sessionDir,
      runId: session.slug,
      definitionId: "builder.build",
      currentStep: "pr-open",
      iteration: 1,
      maxTurns: 1,
      adapterCommandIdentity: "operation-rejection-test",
      assignmentActor: ambient.actorKey,
      assignmentActorStruct: ambient.actor,
      lock,
      timeoutMs: 10_000,
    });
    writeJson(path.join(driverDir, "state.json"), {
      ...readJson(path.join(driverDir, "state.json")),
      active_turn_public_key_digest: issued.publicKeyDigest,
    });
    const signedEnv = {
      ...process.env,
      FLOW_AGENTS_CONTINUATION_RUN_ID: issued.runId,
      FLOW_AGENTS_CONTINUATION_TURN_SECRET: issued.turnSecret,
    };
    for (const key of AMBIENT_IDENTITY_ENV_KEYS) delete signedEnv[key];
    const signed = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../../build/src/cli.js"), "workflow", ...genericEvidenceArgs], { cwd: session.projectRoot, encoding: "utf8", env: signedEnv });
    assert.notEqual(signed.status, 0);
    assert.match(signed.stderr, /operation-bound expectation.*authenticated external ChangeProvider/);
    assert.equal(issued.cleanup(), true);
  });
  assert.deepEqual(snapshotTree(runDir(session.slug, session.projectRoot)), beforeFlow);
  assert.deepEqual(snapshotProjectionTargets(session), beforeProjection);
  await releaseBuilderFlowAssignment({ sessionDir: session.sessionDir, reason: `test cleanup for ${ambient.actorKey}` });
});

async function advanceSessionToPrOpen(session) {
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  const steps = [
    () => [bundleClaim({ expectation: "selected-work", claimType: "builder.pull-work.selected", subjectType: "work-item" })],
    () => [
      bundleClaim({ expectation: "pickup-probe-readiness", claimType: "builder.design-probe.pickup-readiness", subjectType: "work-item" }),
      bundleClaim({ expectation: "probe-decisions-or-accepted-gaps", claimType: "builder.design-probe.decisions", subjectType: "decision" }),
    ],
    () => [bundleClaim({ expectation: "implementation-plan", claimType: "builder.plan.implementation", subjectType: "artifact" })],
    () => [bundleClaim({ expectation: "implementation-scope", claimType: "builder.execute.scope", subjectType: "change" })],
    () => [bundleClaim({ expectation: "tests-evidence", claimType: "builder.verify.tests", subjectType: "flow-step" }), ...verifiedTestsPrerequisites(session)],
    () => [bundleClaim({ expectation: "merge-readiness", claimType: "builder.merge-ready.readiness", subjectType: "change" })],
  ];
  let latest = null;
  for (const entries of steps) latest = await writeAndSync(session, entries());
  assert.equal(latest.run.state.current_step, "pr-open");
  return latest;
}

test("configured ChangeProvider projects only the operation-specific executable contract", async () => {
  const session = makeSession("configured-change-provider");
  writeJson(path.join(session.projectRoot, "package.json"), { repository: "https://github.com/kontourai/flow-agents.git" });
  await advanceSessionToPrOpen(session);
  writeJson(path.join(session.projectRoot, "context", "settings", "change-provider-settings.json"), {
    schema_version: "1.0",
    defaults: {
      provider: {
        role: "ChangeProvider", kind: "github",
        repository: { owner: "kontourai", name: "flow-agents" },
        capabilities: ["change.create", "change.observe"], executor: "gh-cli",
      },
    },
  });
  const configured = await syncBuilderFlowSession({ sessionDir: session.sessionDir });
  const publish = configured.gateActionEnvelope.public_interfaces.mutations.find((entry) => entry.interface === "operation");
  assert.equal(configured.projection.next_action.status, "continue");
  assert.equal(Object.hasOwn(configured.projection.next_action, "external_capability"), false);
  assert.equal(publish.protocol.availability.status, "configured");
  assert.deepEqual(publish.protocol.availability.command, ["publish-change", "execute", "--session-dir", "<session-dir>"]);
  assert.deepEqual(publish.completion, {
    status: "configured_provider_execution_required",
    executable_by_flow_agents: true,
    gate_evidence_interface: null,
  });
  assert.equal(publish.protocol.parameters.some((parameter) => parameter.flag === "--result-json"), false);
});

test("Flow completion authenticates the exact issued publish-change observation before mutating the canonical run", async () => {
  const session = makeSession("publish-change-transaction");
  const ambient = claimAmbientSessionAssignment(session);
  writeJson(path.join(session.projectRoot, "package.json"), { repository: "https://github.com/kontourai/flow-agents.git" });
  await advanceSessionToPrOpen(session);
  writeJson(path.join(session.projectRoot, "context", "settings", "change-provider-settings.json"), {
    schema_version: "1.0",
    defaults: { provider: { role: "ChangeProvider", kind: "github", repository: { owner: "kontourai", name: "flow-agents" }, capabilities: ["change.create", "change.observe"], executor: "gh-cli" } },
  });
  initializePublishChangeGitRepository(session.projectRoot);
  const action = await issuePublishChangeOperation({ sessionDir: session.sessionDir, intent: {
    title: "Open the authenticated transaction", body: "Provider observation fixture.", base_ref: "main", head_ref: "agent/publish-change", head_sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: session.projectRoot, encoding: "utf8" }).trim(),
  } });
  const beforeFlow = snapshotTree(runDir(session.slug, session.projectRoot));
  const beforeProjection = snapshotProjectionTargets(session);
  const rejectObservation = createPublishChangeOperationCompleter(() => ({
      schema_version: "1.0", operation: "publish-change", binding: action.binding,
      provider: { kind: "github", configuration_id: action.provider.configuration_id, adapter: "fixture" }, repository: action.repository,
      change_ref: { provider_record_id: "PR_kwDOfixture", number: 604, url: "https://example.test/kontourai/flow-agents/pull/604", state: "open", base_ref: "main", head_ref: "agent/publish-change", head_sha: "b".repeat(40) },
      assignment_actor: ambient.actorKey, provider_actor: "fixture-github-login", observed_at: new Date().toISOString(),
    }));
  await assert.rejects(
    () => rejectObservation({ sessionDir: session.sessionDir, action }),
    /does not match the issued base\/head\/published-state binding/,
  );
  assert.deepEqual(snapshotTree(runDir(session.slug, session.projectRoot)), beforeFlow);
  assert.deepEqual(snapshotProjectionTargets(session), beforeProjection);
  assert.equal(fs.existsSync(path.join(session.sessionDir, "publish-change.result.json")), false);

  const transactionLock = path.join(session.artifactRoot, "assignment", `.${session.slug}.lockdir`);
  const complete = createPublishChangeOperationCompleter(async (request) => {
    assert.equal(fs.existsSync(transactionLock), false, "provider observation starts without retaining the subject lock");
    await Promise.resolve();
    assert.equal(fs.existsSync(transactionLock), false, "provider observation settles outside the subject lock");
    return {
    schema_version: "1.0", operation: "publish-change", binding: request.binding,
    provider: { kind: "github", configuration_id: request.provider.configuration_id, adapter: "fixture" }, repository: request.repository,
    change_ref: { provider_record_id: "PR_kwDOfixture", number: 604, url: "https://example.test/kontourai/flow-agents/pull/604", state: "open", base_ref: request.base_ref, head_ref: request.head_ref, head_sha: request.head_sha },
    assignment_actor: request.assignment_actor, provider_actor: "fixture-github-login", observed_at: new Date().toISOString(),
    };
  });
  const completed = await complete({ sessionDir: session.sessionDir, action });
  assert.notEqual(completed.run.state.current_step, "pr-open");
  const result = readJson(path.join(session.sessionDir, "publish-change.result.json"));
  assert.equal(result.operation_action_id, action.action_id);
  assert.equal(result.assignment_actor, ambient.actorKey);
  assert.equal(result.provider_actor, "fixture-github-login");
  assert.notEqual(result.assignment_actor, result.provider_actor);
  assert.deepEqual(completed.run.manifest.evidence.filter((entry) => entry.expectation_ids?.includes("pull-request-opened")).map((entry) => entry.expectation_ids), [["pull-request-opened"]]);
  const projectedBeforeRecovery = snapshotFile(path.join(session.sessionDir, "state.json"));
  fs.writeFileSync(path.join(session.sessionDir, "state.json"), Buffer.from(beforeProjection.state, "base64"));
  const recovered = await complete({ sessionDir: session.sessionDir, action });
  assert.equal(recovered.attached, false, "recovery detects the already-attached operation claim");
  assert.equal(snapshotFile(path.join(session.sessionDir, "state.json")), projectedBeforeRecovery, "recovery restores the Flow-owned projection");
  await releaseBuilderFlowAssignment({ sessionDir: session.sessionDir, reason: `test cleanup for ${ambient.actorKey}` });
});

function publishChangeObservation(action, state = "open") {
  return {
    schema_version: "1.0", operation: "publish-change", binding: action.binding,
    provider: { kind: "github", configuration_id: action.provider.configuration_id, adapter: "fixture" }, repository: action.repository,
    change_ref: {
      provider_record_id: "PR_kwDOfixture", number: 604,
      url: "https://example.test/kontourai/flow-agents/pull/604", state,
      base_ref: action.base_ref, head_ref: action.head_ref, head_sha: action.head_sha,
    },
    assignment_actor: action.assignment_actor, provider_actor: "fixture-github-login", observed_at: new Date().toISOString(),
  };
}

test("Flow completion accepts a terminal merged observation as proof the bound change was published", async () => {
  const { session, ambient, action } = await preparePublishChangeTransaction("publish-change-merged-recovery");
  const complete = createPublishChangeOperationCompleter((request) => publishChangeObservation(request, "merged"));
  const completed = await complete({ sessionDir: session.sessionDir, action });

  assert.notEqual(completed.run.state.current_step, "pr-open");
  assert.equal(readJson(path.join(session.sessionDir, "publish-change.result.json")).change_ref.state, "merged");
  assert.equal(completed.run.manifest.evidence.filter((entry) => entry.expectation_ids?.includes("pull-request-opened")).length, 1);
  await releaseBuilderFlowAssignment({ sessionDir: session.sessionDir, reason: `test cleanup for ${ambient.actorKey}` });
});

test("committed publish-change recovery rejects timestamp-tampered result bytes before provider execution", async () => {
  const { session, ambient, action } = await preparePublishChangeTransaction("publish-change-committed-result-tamper");
  const complete = createPublishChangeOperationCompleter((request) => publishChangeObservation(request));
  await complete({ sessionDir: session.sessionDir, action });
  const resultFile = path.join(session.sessionDir, "publish-change.result.json");
  const tampered = readJson(resultFile);
  tampered.observed_at = "2000-01-01T00:00:00.000Z";
  writeJson(resultFile, tampered);
  let observations = 0;
  await assert.rejects(
    () => createPublishChangeOperationCompleter((request) => {
      observations += 1;
      return publishChangeObservation(request);
    })({ sessionDir: session.sessionDir, action }),
    /requires the configured canonical publish-change operation at pull-request-opened/,
  );
  assert.equal(observations, 0);
  await releaseBuilderFlowAssignment({ sessionDir: session.sessionDir, reason: `test cleanup for ${ambient.actorKey}` });
});

async function preparePublishChangeTransaction(slug) {
  const session = makeSession(slug);
  const ambient = claimAmbientSessionAssignment(session);
  configurePublishChangeProvider(session.projectRoot);
  await advanceSessionToPrOpen(session);
  initializePublishChangeGitRepository(session.projectRoot);
  const action = await issuePublishChangeOperation({ sessionDir: session.sessionDir, intent: {
    title: "Authenticated transaction fixture", body: "Provider observation fixture.",
    base_ref: "main", head_ref: "agent/publish-change", head_sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: session.projectRoot, encoding: "utf8" }).trim(),
  } });
  return { session, ambient, action };
}

function assertPublishChangeDidNotMutate(session, beforeFlow, beforeProjection) {
  assert.deepEqual(snapshotTree(runDir(session.slug, session.projectRoot)), beforeFlow);
  assert.deepEqual(snapshotProjectionTargets(session), beforeProjection);
}

test("publish-change rejects symlinked and forged persisted results before canonical mutation", async (t) => {
  await t.test("symlink leaves its external target untouched", async () => {
    const { session, ambient, action } = await preparePublishChangeTransaction("publish-change-result-symlink");
    const result = path.join(session.sessionDir, "publish-change.result.json");
    const externalTarget = path.join(session.projectRoot, "outside-result.json");
    fs.writeFileSync(externalTarget, "external result must not change\n");
    fs.symlinkSync(externalTarget, result);
    const beforeFlow = snapshotTree(runDir(session.slug, session.projectRoot));
    const beforeProjection = snapshotProjectionTargets(session);

    await assert.rejects(
      () => createPublishChangeOperationCompleter((request) => publishChangeObservation(request))({ sessionDir: session.sessionDir, action }),
      /publish-change\.result\.json.*symbolic link/,
    );
    assert.equal(fs.readFileSync(externalTarget, "utf8"), "external result must not change\n");
    assertPublishChangeDidNotMutate(session, beforeFlow, beforeProjection);
    fs.unlinkSync(result);
    await releaseBuilderFlowAssignment({ sessionDir: session.sessionDir, reason: `test cleanup for ${ambient.actorKey}` });
  });

  await t.test("forged bytes cannot be accepted as crash recovery", async () => {
    const { session, ambient, action } = await preparePublishChangeTransaction("publish-change-result-forgery");
    writeJson(path.join(session.sessionDir, "publish-change.result.json"), {
      operation_action_id: "forged-action", provider: "untrusted", change_ref: { number: 999 },
    });
    const beforeFlow = snapshotTree(runDir(session.slug, session.projectRoot));
    const beforeProjection = snapshotProjectionTargets(session);

    await assert.rejects(
      () => createPublishChangeOperationCompleter((request) => publishChangeObservation(request))({ sessionDir: session.sessionDir, action }),
      /already exists with different authenticated operation bytes/,
    );
    assertPublishChangeDidNotMutate(session, beforeFlow, beforeProjection);
    await releaseBuilderFlowAssignment({ sessionDir: session.sessionDir, reason: `test cleanup for ${ambient.actorKey}` });
  });

  await t.test("an uncommitted timestamp-only receipt is replaced by the fresh authenticated observation", async () => {
    const { session, ambient, action } = await preparePublishChangeTransaction("publish-change-result-timestamp-forgery");
    const observation = publishChangeObservation(action);
    writeJson(path.join(session.sessionDir, "publish-change.result.json"), {
      ...observation, observed_at: "2000-01-01T00:00:00.000Z", operation_action_id: action.action_id,
    });
    const completed = await createPublishChangeOperationCompleter(() => observation)({ sessionDir: session.sessionDir, action });
    const persisted = readJson(path.join(session.sessionDir, "publish-change.result.json"));
    assert.equal(persisted.observed_at, observation.observed_at);
    assert.notEqual(persisted.observed_at, "2000-01-01T00:00:00.000Z");
    assert.notEqual(completed.run.state.current_step, "pr-open");
    await releaseBuilderFlowAssignment({ sessionDir: session.sessionDir, reason: `test cleanup for ${ambient.actorKey}` });
  });
});

test("stale publish-change actions fail before provider execution or canonical mutation", async (t) => {
  async function assertRejectedWithoutObservation({ session, action }, mutate) {
    const beforeFlow = snapshotTree(runDir(session.slug, session.projectRoot));
    const beforeProjection = snapshotProjectionTargets(session);
    mutate();
    let observations = 0;
    const complete = createPublishChangeOperationCompleter((request) => {
      observations += 1;
      return publishChangeObservation(request);
    });
    await assert.rejects(
      () => complete({ sessionDir: session.sessionDir, action }),
      /(publish-change\.assignment|does not match the current canonical run, gate visit, assignment actor, or provider configuration)/,
    );
    assert.equal(observations, 0, "stale action must be rejected before provider create/recover");
    assertPublishChangeDidNotMutate(session, beforeFlow, beforeProjection);
  }

  await t.test("assignment transfer", async () => {
    const prepared = await preparePublishChangeTransaction("publish-change-assignment-transfer");
    const { session, ambient } = prepared;
    await assertRejectedWithoutObservation(prepared, () => {
      performLocalRelease(session.artifactRoot, session.slug, ambient.actor, { actorKey: ambient.actorKey, reason: "assignment transfer fixture" });
      performLocalClaim(session.artifactRoot, session.slug, ACTOR, {
        ttlSeconds: 1800, actorKey: ACTOR_KEY, branch: "agent/transferred", artifactDir: session.slug,
        workItemRef: SUBJECT, reason: "assignment transfer fixture",
      });
    });
    performLocalRelease(session.artifactRoot, session.slug, ACTOR, { actorKey: ACTOR_KEY, reason: "test cleanup" });
  });

  await t.test("provider configuration change", async () => {
    const prepared = await preparePublishChangeTransaction("publish-change-configuration-change");
    const { session, ambient } = prepared;
    await assertRejectedWithoutObservation(prepared, () => {
      const settings = readJson(path.join(session.projectRoot, "context", "settings", "change-provider-settings.json"));
      settings.projects[0].provider.repository = { owner: "other", name: "repository" };
      writeJson(path.join(session.projectRoot, "context", "settings", "change-provider-settings.json"), settings);
    });
    await releaseBuilderFlowAssignment({ sessionDir: session.sessionDir, reason: `test cleanup for ${ambient.actorKey}` });
  });
});

test("simultaneous publish-change recovery serializes commit without duplicate attachment", async () => {
  const { session, ambient, action } = await preparePublishChangeTransaction("publish-change-concurrent-completion");
  let observations = 0;
  let releaseBarrier;
  const barrier = new Promise((resolve) => { releaseBarrier = resolve; });
  const arrivals = [];
  const complete = createPublishChangeOperationCompleter(async (request) => {
    observations += 1;
    arrivals.push(observations);
    if (arrivals.length === 2) releaseBarrier();
    await barrier;
    const transactionLock = path.join(session.artifactRoot, "assignment", `.${session.slug}.lockdir`);
    assert.equal(fs.existsSync(transactionLock), false, "concurrent provider I/O must occur outside the subject lock");
    return publishChangeObservation(request);
  });
  const results = await Promise.all([
    complete({ sessionDir: session.sessionDir, action }),
    complete({ sessionDir: session.sessionDir, action }),
  ]);
  assert.deepEqual(results.map((result) => result.attached).sort(), [false, true]);
  assert.equal(observations, 2, "each retry re-observes, but only one completion may attach");
  assert.equal(results[1].run.manifest.evidence.filter((entry) => entry.expectation_ids?.includes("pull-request-opened")).length, 1);
  await releaseBuilderFlowAssignment({ sessionDir: session.sessionDir, reason: `test cleanup for ${ambient.actorKey}` });
});

test("publish-change rebinds the trusted local head under the Flow commit lock", async () => {
  const { session, ambient, action } = await preparePublishChangeTransaction("publish-change-commit-ref-rebind");
  const complete = createPublishChangeOperationCompleter((request) => {
    fs.writeFileSync(path.join(session.projectRoot, "README.md"), "head moved while provider observation was in flight\n");
    execFileSync("git", ["add", "README.md"], { cwd: session.projectRoot });
    execFileSync("git", ["commit", "-m", "move head during observation"], { cwd: session.projectRoot, stdio: "ignore" });
    return publishChangeObservation(request);
  });
  await assert.rejects(
    () => complete({ sessionDir: session.sessionDir, action }),
    /does not match the trusted local head ref during commit/,
  );
  assert.equal(fs.existsSync(path.join(session.sessionDir, "publish-change.result.json")), false);
  await releaseBuilderFlowAssignment({ sessionDir: session.sessionDir, reason: `test cleanup for ${ambient.actorKey}` });
});

test("provider failures cannot leak hostile output into publish-change artifacts or diagnostics", async () => {
  const secret = "SENTINEL_PROVIDER_SECRET_604";
  const session = makeSession("publish-change-secret-boundary");
  const ambient = claimAmbientSessionAssignment(session);
  configurePublishChangeProvider(session.projectRoot);
  await advanceSessionToPrOpen(session);
  initializePublishChangeGitRepository(session.projectRoot);
  const diagnostics = [];
  const previousConsoleError = console.error;
  console.error = (...args) => diagnostics.push(args.map(String).join(" "));
  try {
    const action = await issuePublishChangeOperation({ sessionDir: session.sessionDir, intent: {
      title: "Secret boundary fixture", body: "Provider failure must remain private.",
      base_ref: "main", head_ref: "agent/publish-change", head_sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: session.projectRoot, encoding: "utf8" }).trim(),
    } });
    const settings = readJson(path.join(session.projectRoot, "context", "settings", "change-provider-settings.json")).projects[0].provider;
    const provider = createGithubChangeProvider(settings, action.provider.configuration_id, {
      executor: async () => { throw new Error(`provider stderr ${secret}`); },
      executable: "in-process-test-gh",
    });
    const complete = createPublishChangeOperationCompleter(async (issued) => {
      const { action_id: _actionId, ...request } = issued;
      return await provider.createOrRecover(request);
    });
    await assert.rejects(() => complete({ sessionDir: session.sessionDir, action }), /configured ChangeProvider authentication failed/);
  } finally {
    console.error = previousConsoleError;
  }
  const secretBytes = Buffer.from(secret).toString("base64");
  assert.equal(diagnostics.join("\n").includes(secret), false);
  assert.equal(JSON.stringify([
    snapshotTree(session.sessionDir),
    snapshotTree(runDir(session.slug, session.projectRoot)),
  ]).includes(secretBytes), false, "provider output must not persist in results, trust bundles, or diagnostics");
  assert.equal(fs.existsSync(path.join(session.sessionDir, "publish-change.result.json")), false);
  await releaseBuilderFlowAssignment({ sessionDir: session.sessionDir, reason: `test cleanup for ${ambient.actorKey}` });
});

function initializePublishChangeGitRepository(projectRoot) {
  fs.writeFileSync(path.join(projectRoot, "README.md"), "publish-change fixture\n");
  execFileSync("git", ["init"], { cwd: projectRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "fixture@example.test"], { cwd: projectRoot });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: projectRoot });
  execFileSync("git", ["add", "README.md"], { cwd: projectRoot });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: projectRoot, stdio: "ignore" });
  execFileSync("git", ["branch", "-M", "agent/publish-change"], { cwd: projectRoot });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/kontourai/flow-agents.git"], { cwd: projectRoot });
}

function configurePublishChangeProvider(projectRoot) {
  writeJson(path.join(projectRoot, "package.json"), { repository: "https://github.com/kontourai/flow-agents.git" });
  writeJson(path.join(projectRoot, "context", "settings", "change-provider-settings.json"), {
    schema_version: "1.0",
    projects: [{
      project: { repo: { owner: "kontourai", name: "flow-agents" } },
      provider: {
        role: "ChangeProvider", kind: "github",
        repository: { owner: "kontourai", name: "flow-agents" },
        capabilities: ["change.create", "change.observe"], executor: "gh-cli",
      },
    }],
  });
}

function installRecoveringFakeGh(projectRoot, body) {
  const bin = path.join(projectRoot, "fake-bin");
  const log = path.join(projectRoot, "fake-gh.log");
  fs.mkdirSync(bin, { recursive: true });
  const list = JSON.stringify([{ id: "PR_fixture", number: 604, state: "OPEN", baseRefName: "main", headRefName: "agent/publish-change", headRefOid: execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim(), title: "Composed provider recovery", body, isDraft: false }]);
  const record = JSON.stringify({ node_id: "PR_fixture", number: 604, html_url: "https://github.com/kontourai/flow-agents/pull/604", state: "OPEN", title: "Composed provider recovery", body, draft: false, base: { ref: "main", repo: { full_name: "kontourai/flow-agents" } }, head: { ref: "agent/publish-change", sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim() } });
  fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"${log}\"\ncase \"$1:$2\" in\n  auth:status) printf 'authenticated\\n' ;;\n  api:user) printf '%s\\n' '${JSON.stringify({ login: "fixture-user" })}' ;;\n  api:repos/kontourai/flow-agents) printf '%s\\n' '${JSON.stringify({ full_name: "kontourai/flow-agents" })}' ;;\n  pr:list) printf '%s\\n' '${list}' ;;\n  api:repos/kontourai/flow-agents/pulls/604) printf '%s\\n' '${record}' ;;\n  *) exit 91 ;;\nesac\n`, { mode: 0o755 });
  return { bin, path: path.join(bin, "gh"), log };
}

test("in-process publish-change composition recovers through an injected GitHub adapter without a caller result", async () => {
  const session = makeSession("publish-change-composed");
  const ambient = claimAmbientSessionAssignment(session);
  configurePublishChangeProvider(session.projectRoot);
  await advanceSessionToPrOpen(session);
  initializePublishChangeGitRepository(session.projectRoot);
  const body = "Recovered through the configured adapter.";
  const fake = installRecoveringFakeGh(session.projectRoot, body);
  const before = snapshotTree(runDir(session.slug, session.projectRoot));
  const action = await issuePublishChangeOperation({ sessionDir: session.sessionDir, intent: {
    title: "Composed provider recovery", body,
    base_ref: "main", head_ref: "agent/publish-change", head_sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: session.projectRoot, encoding: "utf8" }).trim(),
  } });
  const settings = readJson(path.join(session.projectRoot, "context", "settings", "change-provider-settings.json")).projects[0].provider;
  const provider = createGithubChangeProvider(settings, action.provider.configuration_id, {
    executable: fake.path,
    executor: async (file, argv, options) => {
      if (argv[0] === "auth" && argv[1] === "token") return { stdout: "gho_fixture_token_604\n" };
      const invoked = spawnSync(file, argv, { encoding: "utf8", env: options.env });
      if (invoked.status !== 0) throw new Error("in-process fixture adapter failed");
      return { stdout: invoked.stdout };
    },
  });
  const complete = createPublishChangeOperationCompleter(async (issued) => {
    const { action_id: _actionId, ...request } = issued;
    return await provider.createOrRecover(request);
  });
  await complete({ sessionDir: session.sessionDir, action });
  const result = readJson(path.join(session.sessionDir, "publish-change.result.json"));
  assert.equal(result.change_ref.provider_record_id, "PR_fixture");
  assert.equal(result.assignment_actor, ambient.actorKey);
  assert.equal(result.provider_actor, "fixture-user");
  assert.equal(readJson(path.join(session.sessionDir, "state.json")).flow_run.current_step, "merge-ready-ci");
  assert.equal(fs.readFileSync(fake.log, "utf8").includes("pr create"), false);
  assert.equal(fs.existsSync(path.join(session.sessionDir, "publish-change.result.json")), true);
  assert.notDeepEqual(snapshotTree(runDir(session.slug, session.projectRoot)), before, "only the Flow-owned operation may advance canonical state");
  await releaseBuilderFlowAssignment({ sessionDir: session.sessionDir, reason: `test cleanup for ${ambient.actorKey}` });
});

test("public publish-change ignores a PATH-prepended gh shim and cannot advance Flow", async () => {
  const session = makeSession("publish-change-public-path-shim");
  const ambient = claimAmbientSessionAssignment(session);
  configurePublishChangeProvider(session.projectRoot);
  await advanceSessionToPrOpen(session);
  initializePublishChangeGitRepository(session.projectRoot);
  const shimDirectory = path.join(session.projectRoot, "public-path-shim");
  const shimLog = path.join(session.projectRoot, "public-path-shim.log");
  const gitShimLog = path.join(session.projectRoot, "public-path-git-shim.log");
  fs.mkdirSync(shimDirectory, { recursive: true });
  fs.writeFileSync(path.join(shimDirectory, "gh"), `#!/bin/sh\nprintf 'shim invoked\\n' >> '${shimLog}'\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(shimDirectory, "git"), `#!/bin/sh\nprintf 'git shim invoked\\n' >> '${gitShimLog}'\nprintf '%s\\n' '${"f".repeat(40)}'\n`, { mode: 0o755 });
  const before = snapshotTree(runDir(session.slug, session.projectRoot));
  const previousPath = process.env.PATH;
  const previousGhConfigDir = process.env.GH_CONFIG_DIR;
  const previousGhToken = process.env.GH_TOKEN;
  const previousGithubToken = process.env.GITHUB_TOKEN;
  const emptyGhConfig = path.join(session.projectRoot, "empty-gh-config");
  fs.mkdirSync(emptyGhConfig, { recursive: true });
  process.env.PATH = `${shimDirectory}${path.delimiter}${previousPath}`;
  process.env.GH_CONFIG_DIR = emptyGhConfig;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    const rc = await publishChangeMain([
      "execute", "--session-dir", session.sessionDir,
      "--title", "Must not use PATH shim", "--body", "The trusted CLI fails closed without authentication.",
      "--base-ref", "main", "--head-ref", "agent/publish-change",
    ]);
    assert.equal(rc, 1);
  } finally {
    process.env.PATH = previousPath;
    if (previousGhConfigDir === undefined) delete process.env.GH_CONFIG_DIR; else process.env.GH_CONFIG_DIR = previousGhConfigDir;
    if (previousGhToken === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = previousGhToken;
    if (previousGithubToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = previousGithubToken;
  }
  assert.equal(fs.existsSync(shimLog), false, "public CLI must not execute a caller-controlled PATH shim");
  assert.equal(fs.existsSync(gitShimLog), false, "public CLI must not execute a caller-controlled git PATH shim to derive its head SHA");
  assert.equal(fs.existsSync(path.join(session.sessionDir, "publish-change.result.json")), false);
  assert.deepEqual(snapshotTree(runDir(session.slug, session.projectRoot)), before);
  await releaseBuilderFlowAssignment({ sessionDir: session.sessionDir, reason: `test cleanup for ${ambient.actorKey}` });
});

test("pr-open route-back with missing_evidence returns the run to verify and supports repair re-entry (#695 item a)", async () => {
  const session = makeSession("propen-routeback");
  await advanceSessionToPrOpen(session);

  // The #663 wedge scenario: a trust divergence is discovered at pr-open. A failing
  // pull-request-opened claim declaring the missing_evidence route reason must land
  // the canonical run back at verify — the sanctioned repair surface — not throw.
  const failureTimestamp = new Date().toISOString();
  const routed = await writeAndSync(session, [bundleClaim({
    expectation: "pull-request-opened",
    claimType: "builder.pr-open.pull-request",
    subjectType: "pull-request",
    status: "fail",
    routeReason: "missing_evidence",
    timestamp: failureTimestamp,
  })]);

  assert.equal(routed.attached, true);
  assert.equal(routed.run.state.current_step, "verify");
  const routeBacks = routed.run.state.transitions.filter((transition) => transition.type === "route_back");
  assert.equal(routeBacks.length, 1);
  assert.equal(routeBacks[0].from_step, "pr-open");
  assert.equal(routeBacks[0].to_step, "verify");
  assert.equal(routeBacks[0].route_reason, "missing_evidence");
  assert.equal(routeBacks[0].gate_id, "builder.publish-learn:pr-open-gate");
  assert.equal(routed.projection.flow_run.route_back_attempt, 1);
  assert.equal(routed.projection.flow_run.route_back_max_attempts, 3);
  assert.match(routed.projection.next_action.summary, /Route-back history: attempt 1\/3 returned to `verify` for `missing_evidence`/);

  // Repair loop: fresh verify evidence re-passes verify, fresh merge-readiness
  // re-passes merge-ready, and the run returns to pr-open.
  const repairedAt = new Date(Date.parse(routed.run.state.transitions.at(-1).at) + 1).toISOString();
  const reverified = await writeAndSync(session, [
    withIdentitySuffix(bundleClaim({ expectation: "tests-evidence", claimType: "builder.verify.tests", subjectType: "flow-step", timestamp: repairedAt }), "repair"),
    ...verifiedTestsPrerequisites(session, repairedAt).map((entry, index) => withIdentitySuffix(entry, `repair-${index}`)),
  ]);
  assert.equal(reverified.run.state.current_step, "merge-ready");
  const returned = await writeAndSync(session, [
    withIdentitySuffix(bundleClaim({ expectation: "merge-readiness", claimType: "builder.merge-ready.readiness", subjectType: "change", timestamp: new Date().toISOString() }), "repair"),
  ]);
  assert.equal(returned.run.state.current_step, "pr-open");
});

test("pr-open route-back with an undeclared reason still throws and mutates nothing", async () => {
  const session = makeSession("propen-undeclared-reason");
  await advanceSessionToPrOpen(session);

  const flowDirectory = runDir(session.slug, session.projectRoot);
  const beforeState = readJson(path.join(flowDirectory, "state.json"));
  const beforeManifest = readJson(path.join(flowDirectory, FLOW_RUN_EVIDENCE_MANIFEST_PATH));

  writeBundle(session.sessionDir, [bundleClaim({
    expectation: "pull-request-opened",
    claimType: "builder.pr-open.pull-request",
    subjectType: "pull-request",
    status: "fail",
    routeReason: "stale_critique",
    timestamp: new Date().toISOString(),
  })]);
  await assert.rejects(
    () => syncBuilderFlowSession({ sessionDir: session.sessionDir }),
    /route_reason.*is not declared by gate builder\.publish-learn:pr-open-gate/,
  );
  assert.deepEqual(readJson(path.join(flowDirectory, "state.json")), beforeState);
  assert.deepEqual(readJson(path.join(flowDirectory, FLOW_RUN_EVIDENCE_MANIFEST_PATH)), beforeManifest);
});

test("recovery loads the slug-bound run, restores every matching projection, and preserves every Flow byte", async () => {
  const session = makeSession("recover-active");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  const advanced = await writeAndSync(session, [bundleClaim({
    expectation: "selected-work",
    claimType: "builder.pull-work.selected",
    subjectType: "work-item",
  })]);
  assert.equal(advanced.run.state.current_step, "design-probe");

  writeJson(path.join(session.artifactRoot, "current", "codex.json"), {
    active_slug: session.slug,
    active_step_id: "stale-step",
    updated_at: NOW,
  });
  writeJson(path.join(session.artifactRoot, "current", "other.json"), {
    active_slug: "another-session",
    active_step_id: "untouched-step",
    updated_at: NOW,
  });
  const staleState = readJson(path.join(session.sessionDir, "state.json"));
  staleState.status = "planned";
  staleState.phase = "planning";
  staleState.flow_run.current_step = "pull-work";
  staleState.next_action = { status: "continue", summary: "stale" };
  writeJson(path.join(session.sessionDir, "state.json"), staleState);
  const flowDirectory = runDir(session.slug, session.projectRoot);
  const beforeFlow = snapshotTree(flowDirectory);
  const beforeOther = snapshotFile(path.join(session.artifactRoot, "current", "other.json"));
  const bundleBefore = snapshotFile(path.join(session.sessionDir, "trust.bundle"));

  const recovered = await recoverBuilderFlowSession({ sessionDir: session.sessionDir });

  assert.equal(recovered.attached, false);
  assert.equal(recovered.run.runId, session.slug);
  assert.equal(recovered.projection.flow_run.current_step, "design-probe");
  assert.equal(recovered.projection.phase, advanced.projection.phase);
  assert.deepEqual(recovered.projection.flow_run.open_gate_ids, advanced.projection.flow_run.open_gate_ids);
  assert.deepEqual(recovered.projection.next_action.skills, ["pickup-probe"]);
  assert.equal(readJson(path.join(session.artifactRoot, "current.json")).active_step_id, "design-probe");
  assert.equal(readJson(path.join(session.artifactRoot, "current", "codex.json")).active_step_id, "design-probe");
  assert.equal(snapshotFile(path.join(session.artifactRoot, "current", "other.json")), beforeOther);
  assert.equal(snapshotFile(path.join(session.sessionDir, "trust.bundle")), bundleBefore);
  assert.deepEqual(snapshotTree(flowDirectory), beforeFlow);
});

test("recovery fails before any write for invalid Work Item cardinality and Flow subject bindings", async (t) => {
  const cases = [
    ["zero refs", [], /state\.work_item_refs.*exactly one/],
    ["empty ref", [""], /state\.work_item_refs.*exactly one/],
    ["blank ref", ["   "], /state\.work_item_refs.*exactly one/],
    ["two refs", [SUBJECT, "local:work-item/other"], /state\.work_item_refs.*exactly one/],
  ];
  for (const [name, refs, pattern] of cases) {
    await t.test(name, async () => {
      const session = makeSession(`recover-${name.replaceAll(" ", "-")}`);
      await startBuilderFlowSession({ sessionDir: session.sessionDir });
      const state = readJson(path.join(session.sessionDir, "state.json"));
      state.work_item_refs = refs;
      writeJson(path.join(session.sessionDir, "state.json"), state);
      await assertRecoveryRejectsWithoutWrites(session, pattern);
    });
  }

  await t.test("persisted state subject mismatch", async () => {
    const session = makeSession("recover-state-subject-mismatch");
    await startBuilderFlowSession({ sessionDir: session.sessionDir });
    const file = path.join(runDir(session.slug, session.projectRoot), "state.json");
    const state = readJson(file);
    state.subject = "local:work-item/other";
    writeJson(file, state);
    await assertRecoveryRejectsWithoutWrites(session, /flow_run\.state\.subject.*selected Work Item/);
  });

  await t.test("persisted params subject mismatch", async () => {
    const session = makeSession("recover-params-subject-mismatch");
    await startBuilderFlowSession({ sessionDir: session.sessionDir });
    const file = path.join(runDir(session.slug, session.projectRoot), "state.json");
    const state = readJson(file);
    state.params.subject = "local:work-item/other";
    writeJson(file, state);
    await assertRecoveryRejectsWithoutWrites(session, /flow_run\.state\.params\.subject.*selected Work Item/);
  });

  await t.test("absent persisted params subject is allowed", async () => {
    const session = makeSession("recover-params-subject-absent");
    await startBuilderFlowSession({ sessionDir: session.sessionDir });
    const flowDirectory = runDir(session.slug, session.projectRoot);
    const file = path.join(flowDirectory, "state.json");
    const state = readJson(file);
    delete state.params.subject;
    writeJson(file, state);
    const beforeFlow = snapshotTree(flowDirectory);
    const recovered = await recoverBuilderFlowSession({ sessionDir: session.sessionDir });
    assert.equal(recovered.attached, false);
    assert.deepEqual(snapshotTree(flowDirectory), beforeFlow);
  });
});

test("recovery fails closed for invalid sidecars and missing or corrupt canonical runs", async (t) => {
  await t.test("invalid session path", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-builder-invalid-session-"));
    await assert.rejects(
      () => recoverBuilderFlowSession({ sessionDir: path.join(projectRoot, "not-a-session") }),
      /sessionDir.*must be \.kontourai\/flow-agents/,
    );
    assert.equal(fs.existsSync(path.join(projectRoot, ".kontourai")), false);
  });

  await t.test("missing run remains missing", async () => {
    const session = makeSession("recover-missing-run");
    await assertRecoveryRejectsWithoutWrites(session, /not_found|not found/i);
    assert.equal(fs.existsSync(runDir(session.slug, session.projectRoot)), false);
  });

  await t.test("task slug mismatch", async () => {
    const session = makeSession("recover-task-slug-mismatch");
    await startBuilderFlowSession({ sessionDir: session.sessionDir });
    const state = readJson(path.join(session.sessionDir, "state.json"));
    state.task_slug = "other";
    writeJson(path.join(session.sessionDir, "state.json"), state);
    await assertRecoveryRejectsWithoutWrites(session, /task_slug.*match/);
  });

  await t.test("missing sidecar state", async () => {
    const session = makeSession("recover-missing-sidecar-state");
    await startBuilderFlowSession({ sessionDir: session.sessionDir });
    fs.rmSync(path.join(session.sessionDir, "state.json"));
    await assertRecoveryRejectsWithoutWrites(session, /sessionDir.*state\.json/);
  });

  await t.test("corrupt sidecar state", async () => {
    const session = makeSession("recover-corrupt-sidecar-state");
    await startBuilderFlowSession({ sessionDir: session.sessionDir });
    fs.writeFileSync(path.join(session.sessionDir, "state.json"), "not-json\n");
    await assertRecoveryRejectsWithoutWrites(session, /JSON|parse|Unexpected/i);
  });

  for (const [name, relativeFile] of [
    ["corrupt Flow state", "state.json"],
    ["corrupt Flow manifest", FLOW_RUN_EVIDENCE_MANIFEST_PATH],
  ]) {
    await t.test(name, async () => {
      const session = makeSession(`recover-${name.replaceAll(" ", "-").toLowerCase()}`);
      await startBuilderFlowSession({ sessionDir: session.sessionDir });
      fs.writeFileSync(path.join(runDir(session.slug, session.projectRoot), relativeFile), "not-json\n");
      await assertRecoveryRejectsWithoutWrites(session, /JSON|parse|invalid|Unexpected/i);
    });
  }

  for (const [name, mutate] of [
    ["foreign definition identity", (definition) => { definition.id = "foreign.build"; }],
    ["foreign definition content", (definition) => { definition.steps[0].description = "foreign content"; }],
  ]) {
    await t.test(name, async () => {
      const session = makeSession(`recover-${name.replaceAll(" ", "-")}`);
      await startBuilderFlowSession({ sessionDir: session.sessionDir });
      const file = path.join(runDir(session.slug, session.projectRoot), "definition.json");
      const definition = readJson(file);
      mutate(definition);
      writeJson(file, definition);
      await assertRecoveryRejectsWithoutWrites(session, /definition|foreign|canonical|identity|content|invalid/i);
    });
  }
});

test("recover and sync remain separate: recovery leaves bundle unattached and sync evaluates it", async () => {
  const session = makeSession("recover-then-sync");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  writeBundle(session.sessionDir, [bundleClaim({
    expectation: "selected-work",
    claimType: "builder.pull-work.selected",
    subjectType: "work-item",
  })]);
  const manifestFile = path.join(runDir(session.slug, session.projectRoot), FLOW_RUN_EVIDENCE_MANIFEST_PATH);
  const manifestBefore = snapshotFile(manifestFile);

  const recovered = await recoverBuilderFlowSession({ sessionDir: session.sessionDir });
  assert.equal(recovered.attached, false);
  assert.equal(snapshotFile(manifestFile), manifestBefore);
  assert.equal(recovered.run.state.current_step, "pull-work");

  const synced = await syncBuilderFlowSession({ sessionDir: session.sessionDir });
  assert.equal(synced.attached, true);
  assert.equal(synced.run.state.current_step, "design-probe");
  assert.notEqual(snapshotFile(manifestFile), manifestBefore);
});

test("builder-run recover accepts only a session directory and rejects caller-selected identity", async () => {
  const session = makeSession("recover-cli");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  assert.equal(await builderRunMain(["recover", "--session-dir", session.sessionDir]), 0);
  assert.equal(await builderRunMain(["recover", "--session-dir", session.sessionDir, "--run-id", "other"]), 64);
  assert.equal(await builderRunMain(["recover", "--session-dir", session.sessionDir, "--step-id", "verify"]), 64);
  assert.equal(await builderRunMain(["recover", "extra", "--session-dir", session.sessionDir]), 64);
});

test("recovery refuses a sidecar changed after its immutable subject snapshot", async () => {
  const session = makeSession("recover-sidecar-race");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  const flowDirectory = runDir(session.slug, session.projectRoot);
  const beforeFlow = snapshotTree(flowDirectory);
  const recovery = recoverBuilderFlowSession({ sessionDir: session.sessionDir });
  const changed = readJson(path.join(session.sessionDir, "state.json"));
  changed.work_item_refs = ["local:work-item/raced"];
  writeJson(path.join(session.sessionDir, "state.json"), changed);
  const beforeProjection = snapshotProjectionTargets(session);

  await assert.rejects(() => recovery, /state\.json.*changed during recovery/);
  assert.deepEqual(snapshotTree(flowDirectory), beforeFlow);
  assert.deepEqual(snapshotProjectionTargets(session), beforeProjection);
});

test("recovery parses every projection target before writing any target", async (t) => {
  for (const target of ["global", "actor"]) {
    await t.test(`malformed ${target} pointer`, async () => {
      const session = makeSession(`recover-malformed-${target}-pointer`);
      await startBuilderFlowSession({ sessionDir: session.sessionDir });
      const state = readJson(path.join(session.sessionDir, "state.json"));
      state.next_action = { status: "continue", summary: "stale projection" };
      writeJson(path.join(session.sessionDir, "state.json"), state);
      const pointer = target === "global"
        ? path.join(session.artifactRoot, "current.json")
        : path.join(session.artifactRoot, "current", "codex.json");
      fs.mkdirSync(path.dirname(pointer), { recursive: true });
      fs.writeFileSync(pointer, "not-json\n");
      await assertRecoveryRejectsWithoutWrites(session, /projection target.*JSON|JSON|parse|Unexpected/i);
    });
  }
});

test("recovery rejects symlinked session and projection targets before writes", async (t) => {
  await t.test("session directory symlink", async () => {
    const session = makeSession("recover-session-symlink");
    await startBuilderFlowSession({ sessionDir: session.sessionDir });
    const target = path.join(session.artifactRoot, "recover-session-symlink-target");
    fs.renameSync(session.sessionDir, target);
    fs.symlinkSync(target, session.sessionDir, "dir");
    const beforeFlow = snapshotTree(runDir(session.slug, session.projectRoot));
    const beforeState = snapshotFile(path.join(target, "state.json"));
    await assert.rejects(() => recoverBuilderFlowSession({ sessionDir: session.sessionDir }), /sessionDir.*symbolic link/);
    assert.deepEqual(snapshotTree(runDir(session.slug, session.projectRoot)), beforeFlow);
    assert.equal(snapshotFile(path.join(target, "state.json")), beforeState);
  });

  await t.test("state.json symlink", async () => {
    const session = makeSession("recover-state-symlink");
    await startBuilderFlowSession({ sessionDir: session.sessionDir });
    const stateFile = path.join(session.sessionDir, "state.json");
    const target = path.join(session.sessionDir, "state-target.json");
    fs.renameSync(stateFile, target);
    fs.symlinkSync(target, stateFile);
    const beforeFlow = snapshotTree(runDir(session.slug, session.projectRoot));
    const beforeTarget = snapshotFile(target);
    await assert.rejects(() => recoverBuilderFlowSession({ sessionDir: session.sessionDir }), /state\.json.*symbolic link/);
    assert.deepEqual(snapshotTree(runDir(session.slug, session.projectRoot)), beforeFlow);
    assert.equal(snapshotFile(target), beforeTarget);
  });

  for (const targetKind of ["global pointer", "actor pointer", "dangling actor pointer", "actor directory"]) {
    await t.test(targetKind, async () => {
      const session = makeSession(`recover-${targetKind.replaceAll(" ", "-")}-symlink`);
      await startBuilderFlowSession({ sessionDir: session.sessionDir });
      const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-builder-pointer-symlink-"));
      const externalPointer = path.join(externalRoot, "current.json");
      writeJson(externalPointer, { active_slug: session.slug, active_step_id: "stale", updated_at: NOW });
      if (targetKind === "global pointer") {
        fs.rmSync(path.join(session.artifactRoot, "current.json"));
        fs.symlinkSync(externalPointer, path.join(session.artifactRoot, "current.json"));
      } else if (targetKind === "actor pointer" || targetKind === "dangling actor pointer") {
        const actorRoot = path.join(session.artifactRoot, "current");
        fs.mkdirSync(actorRoot, { recursive: true });
        fs.symlinkSync(targetKind === "dangling actor pointer" ? path.join(externalRoot, "missing.json") : externalPointer, path.join(actorRoot, "codex.json"));
      } else {
        fs.symlinkSync(externalRoot, path.join(session.artifactRoot, "current"), "dir");
      }
      const beforeFlow = snapshotTree(runDir(session.slug, session.projectRoot));
      const beforeState = snapshotFile(path.join(session.sessionDir, "state.json"));
      const beforeExternal = snapshotFile(externalPointer);
      await assert.rejects(() => recoverBuilderFlowSession({ sessionDir: session.sessionDir }), /current.*symbolic link|projection target.*symbolic link/);
      assert.deepEqual(snapshotTree(runDir(session.slug, session.projectRoot)), beforeFlow);
      assert.equal(snapshotFile(path.join(session.sessionDir, "state.json")), beforeState);
      assert.equal(snapshotFile(externalPointer), beforeExternal);
    });
  }
});
