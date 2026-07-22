import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, type KeyObject } from "node:crypto";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { expectationsForGate, flowRunHead, loadRun, openGates, validateDefinition } from "@kontourai/flow";
import { loadBuilderFlowRun } from "../builder-flow-run-adapter.js";
import { parseKitFlowStepActions } from "../flow-kit/validate.js";
import { MAX_CONTINUATION_TURN_RESULT_BYTES, createFileContinuationStore, driveBuilderFlowSession, withContinuationDriverLock } from "../continuation-driver.js";
import { currentGateVisit, inspectBuilderFlowSession, recoverBuilderFlowSession, syncBuilderFlowSession } from "../builder-flow-runtime.js";
import { buildUnsignedCritiqueResolutionAuthorization } from "../builder-lifecycle-authority.js";
import { flowAgentsPackageRoot, flowAgentsPackageVersion } from "../lib/package-version.js";
import { pinnedFlowAgentsCommand } from "../lib/pinned-cli-command.js";
import { captureReviewWorkspaceSnapshot } from "../lib/review-workspace-snapshot.js";
import { invokeExternalLifecycleAuthority } from "../external-lifecycle-authority.js";
import { defaultArtifactRootForRead, flowAgentsArtifactRoot } from "../lib/local-artifact-root.js";
import { flagBool, flagList, flagString, parseArgs } from "../lib/args.js";
import { main as builderRun } from "./builder-run.js";
import { normalizeCritiqueChainRecords } from "./critique-resolution.js";
import { appendWriterTransactionAbort, assertCurrentVerifiedWorkspaceEvidence, createWriterTransactionAbortCapability, currentWorkflowSessionDir, isMeaningfulTestCommand, mainFromPublicWorkflow, publishDelivery, sealTrustCheckpoint, type TrustBundleWriterTarget, type TrustCheckpointSealResult, type WriterTransactionAbortCapability, WORKFLOW_WRITER_CONTRACT_VERSION } from "./workflow-sidecar.js";
import { resolveCurrentAssignmentActor, withSubjectLock } from "./assignment-provider.js";
import { assertLoadedContinuationAdapterIntegrity, executeLoadedContinuationAdapter, loadContinuationAdapterCommand, waitForContinuationBarrier } from "./continuation-adapter.js";

type JsonRecord = Record<string, unknown>;

export const WORKFLOW_CONTRACT_VERSION = "1.0";
const PACKAGE_ROOT = flowAgentsPackageRoot();
const REQUIRE = createRequire(import.meta.url);
const PACKAGE_METADATA = readJsonFile(path.join(PACKAGE_ROOT, "package.json"), "Flow Agents package metadata");
const CLI_VERSION = flowAgentsPackageVersion();
const PUBLIC_VERBS = ["start", "status", "evidence", "critique", "resolve-critique-request", "resolve-critique", "drive", "publish-delivery", "pause", "resume", "release", "cancel", "archive", "doctor"] as const;

function usage(): void {
  console.log(`Usage: flow-agents workflow <verb> [options]

Public workflow verbs:
  start               Start or resume a workflow for a Work Item.
  status              Show the current canonical run and projected next action.
  evidence            Record evidence for the current Flow gate and synchronize it.
  critique            Record review critique directly into the current trust bundle.
  resolve-critique    Resolve a repaired historical critique through a later review record.
  drive               Continue the canonical run through an explicit runtime adapter.
  publish-delivery    Publish the current session's verified trust bundle for CI reconciliation.
  pause               Pause the current run as its assignment actor.
  resume              Resume the current paused run as its assignment actor.
  release             Release the current assignment without canceling the run.
  cancel              Cancel through a signed user/operator authorization record.
  archive             Archive a terminal session through a signed authorization record.
  doctor              Report CLI, install, Kit, Flow, and artifact compatibility.

Use the isolated exact-package command emitted by workflow status and doctor in automation.`);
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const verb = parsed.positionals[0];
  if (!verb || verb === "help" || verb === "--help" || verb === "-h") {
    usage();
    return 0;
  }
  if (!(PUBLIC_VERBS as readonly string[]).includes(verb)) {
    console.error(`Unknown workflow verb: ${verb}`);
    usage();
    return 64;
  }
  if (verb === "start") return start(argv.slice(1));
  if (verb === "doctor") return doctor(argv.slice(1));

  const sessionDir = resolveSessionDir(parsed.flags);
  if (verb === "status") return status(sessionDir, flagBool(parsed.flags, "json"));
  if (verb === "evidence") return evidence(sessionDir, argv.slice(1), flagBool(parsed.flags, "json"));
  if (verb === "critique") return critique(sessionDir, argv.slice(1), flagBool(parsed.flags, "json"));
  if (verb === "resolve-critique-request") return resolveCritiqueRequest(sessionDir, argv.slice(1));
  if (verb === "resolve-critique") return resolveCritique(sessionDir, argv.slice(1), flagBool(parsed.flags, "json"));
  if (verb === "drive") return drive(sessionDir, argv.slice(1), flagBool(parsed.flags, "json"));
  if (verb === "publish-delivery") {
    assertOnlyFlags(parsed.flags, new Set(["artifact-root", "session-dir", "json"]), "workflow publish-delivery");
    return publishDeliveryFromPublicWorkflow(sessionDir, flagBool(parsed.flags, "json"));
  }

  const forwarded = stripPublicFlags(argv.slice(1), new Set(["artifact-root", "session-dir", "json"]));
  if (verb === "release" && !flagString(parsed.flags, "reason")) throw new Error("workflow release requires --reason <text>");
  return builderRun([verb === "release" ? "release-assignment" : verb, "--session-dir", sessionDir, ...forwarded]);
}

async function publishDeliveryFromPublicWorkflow(sessionDir: string, json: boolean): Promise<number> {
  const { projectRoot, slug } = readBoundSession(sessionDir);
  const report = await withSubjectLock(path.dirname(sessionDir), slug, async () => {
    assertOrdinaryMatchingAssignmentActor(sessionDir, slug);
    if (!fs.existsSync(path.join(sessionDir, "trust.bundle"))) {
      throw new Error("workflow publish-delivery requires a current session trust.bundle; complete the declared Builder evidence and release-readiness steps first");
    }
    const inspected = await inspectBuilderFlowSession({ sessionDir });
    const completed = inspected.run.definitionId === "builder.build" && inspected.run.state.status === "completed";
    const release = readOptionalJson(path.join(sessionDir, "release.json"));
    const releaseReady = inspected.run.definitionId === "builder.build"
      && inspected.run.state.status === "active"
      && inspected.run.state.current_step === "learn"
      && ["merge", "release", "deploy"].includes(String(release?.decision));
    if (!completed && !releaseReady) {
      throw new Error("workflow publish-delivery requires a completed or release-ready canonical builder.build run; partial sessions cannot publish delivery evidence");
    }
    const guardedSeal = await withStableDeliverySnapshot(
      () => assertCurrentVerifiedWorkspaceEvidence(sessionDir),
      () => sealTrustCheckpoint(sessionDir, slug, new Date().toISOString(), "delivered", "release", projectRoot),
    );
    const verifiedSnapshot = guardedSeal.snapshot;
    const seal = guardedSeal.result;
    if (!seal) throw new Error("workflow publish-delivery could not emit a fresh checkpoint attestation for the current trust bundle");
    validateFreshCheckpointSeal(sessionDir, seal);
    const checkpointPath = path.join(sessionDir, "trust.checkpoint.json");
    const checkpoint = readJsonFile(checkpointPath, "workflow trust checkpoint");
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (checkpoint.commit_sha !== headSha) {
      throw new Error("workflow publish-delivery requires a checkpoint sealed against the derived project root's current HEAD");
    }
    const immediatelyBeforePublish = assertCurrentVerifiedWorkspaceEvidence(sessionDir);
    if (!isDeepStrictEqual(verifiedSnapshot, immediatelyBeforePublish)) {
      throw new Error("workflow publish-delivery source snapshot changed while sealing; re-run canonical review and verification");
    }
    assertOrdinaryMatchingAssignmentActor(sessionDir, slug);
    const ownedDeliveryRoot = `delivery/${slug}`;
    const sourceSnapshot = captureReviewWorkspaceSnapshot(projectRoot, [], [ownedDeliveryRoot]);
    const afterSourceSnapshot = assertCurrentVerifiedWorkspaceEvidence(sessionDir);
    if (!isDeepStrictEqual(verifiedSnapshot, afterSourceSnapshot)) {
      throw new Error("workflow publish-delivery source snapshot changed before copying delivery evidence; re-run canonical review and verification");
    }
    const deliveryBundle = path.join(projectRoot, "delivery", slug, "trust.bundle");
    const deliveryCheckpoint = path.join(projectRoot, "delivery", slug, "trust.checkpoint.json");
    const deliveryAttestation = path.join(projectRoot, "delivery", slug, "trust.checkpoint.attestation.json");
    const transaction = stageDeliveryDestination(projectRoot, slug, sessionDir);
    await withStablePublishedDeliverySnapshot(
      sourceSnapshot,
      () => captureReviewWorkspaceSnapshot(projectRoot, [], [ownedDeliveryRoot]),
      async () => {
        await publishDelivery(sessionDir, projectRoot);
        if (!fs.existsSync(deliveryBundle) || !fs.existsSync(deliveryCheckpoint) || !fs.existsSync(deliveryAttestation)) {
          throw new Error("workflow publish-delivery did not produce the required delivery trust bundle and checkpoint companions");
        }
      },
      transaction.rollback,
      transaction.commit,
    );
    return immutableReport({ session_dir: sessionDir, delivery_bundle: deliveryBundle, delivery_checkpoint: deliveryCheckpoint, published: true });
  });
  if (json) console.log(JSON.stringify(report));
  else console.log(`Published delivery trust bundle: ${String(report.delivery_bundle)}`);
  return 0;
}

export async function withStableDeliverySnapshot<T>(capture: () => JsonRecord, seal: () => Promise<T>): Promise<{ snapshot: JsonRecord; result: T }> {
  const before = structuredClone(capture());
  const result = await seal();
  const after = capture();
  if (!isDeepStrictEqual(before, after)) {
    throw new Error("workflow publish-delivery source snapshot changed while sealing; re-run canonical review and verification");
  }
  return { snapshot: before, result };
}

export async function withStablePublishedDeliverySnapshot(
  expected: JsonRecord,
  capture: () => JsonRecord,
  publish: () => Promise<void>,
  rollback: () => void,
  commit: () => void,
): Promise<void> {
  try {
    await publish();
    if (!isDeepStrictEqual(expected, capture())) {
      throw new Error("workflow publish-delivery source snapshot changed while copying delivery evidence; the prior delivery was restored");
    }
    commit();
  } catch (error) {
    rollback();
    throw error;
  }
}

export function stageDeliveryDestination(projectRoot: string, slug: string, sessionDir: string): { rollback: () => void; commit: () => void } {
  const deliveryRoot = path.join(projectRoot, "delivery");
  if (fs.existsSync(deliveryRoot)) {
    const rootStat = fs.lstatSync(deliveryRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("workflow publish-delivery requires delivery to be a non-symlink directory");
  }
  const destination = path.join(deliveryRoot, slug);
  let backup: string | null = null;
  if (fs.existsSync(destination)) {
    const destinationStat = fs.lstatSync(destination);
    if (destinationStat.isSymbolicLink() || !destinationStat.isDirectory()) throw new Error("workflow publish-delivery requires its delivery destination to be a non-symlink directory");
    backup = path.join(sessionDir, `.delivery-publish-backup-${randomBytes(16).toString("hex")}`);
    fs.renameSync(destination, backup);
  }
  let settled = false;
  return {
    rollback: () => {
      if (settled) return;
      fs.rmSync(destination, { recursive: true, force: true });
      if (backup) fs.renameSync(backup, destination);
      settled = true;
    },
    commit: () => {
      if (settled) return;
      if (backup) fs.rmSync(backup, { recursive: true, force: true });
      settled = true;
    },
  };
}

function validateFreshCheckpointSeal(sessionDir: string, seal: TrustCheckpointSealResult): void {
  const checkpointPath = path.join(sessionDir, "trust.checkpoint.json");
  const attestationPath = path.join(sessionDir, "trust.checkpoint.attestation.json");
  const expectedCompanion = path.join(sessionDir, seal.status === "signed" ? "trust.checkpoint.sig.json" : "trust.checkpoint.intoto.json");
  const staleCompanion = path.join(sessionDir, seal.status === "signed" ? "trust.checkpoint.intoto.json" : "trust.checkpoint.sig.json");
  if (seal.checkpointPath !== checkpointPath || seal.attestationPath !== attestationPath || seal.companionPath !== expectedCompanion
    || !fs.existsSync(checkpointPath) || !fs.existsSync(attestationPath) || !fs.existsSync(expectedCompanion) || fs.existsSync(staleCompanion)) {
    throw new Error("workflow publish-delivery requires the fresh, mutually-exclusive checkpoint companions returned by the current seal attempt");
  }
  const checkpointBytes = fs.readFileSync(checkpointPath);
  const bundleBytes = fs.readFileSync(path.join(sessionDir, "trust.bundle"));
  if (createHash("sha256").update(checkpointBytes).digest("hex") !== seal.checkpointSha256
    || createHash("sha256").update(bundleBytes).digest("hex") !== seal.bundleSha256) {
    throw new Error("workflow publish-delivery checkpoint or trust bundle changed after the current seal attempt");
  }
  const attestation = readJsonFile(attestationPath, "workflow checkpoint attestation");
  if (attestation.status !== seal.status || attestation.path !== path.basename(expectedCompanion)) {
    throw new Error("workflow publish-delivery checkpoint attestation does not identify the companion emitted by the current seal attempt");
  }
  const statement = seal.status === "signed"
    ? readSignedCheckpointStatement(expectedCompanion)
    : readJsonFile(expectedCompanion, "workflow unsigned checkpoint statement");
  const subjects = Array.isArray(statement.subject) ? statement.subject : [];
  const subject = subjects.find((entry) => entry && typeof entry === "object" && (entry as JsonRecord).name === "trust.checkpoint.json") as JsonRecord | undefined;
  const digest = subject?.digest && typeof subject.digest === "object" ? (subject.digest as JsonRecord).sha256 : null;
  if (statement._type !== "https://in-toto.io/Statement/v1"
    || statement.predicateType !== "https://hachure.org/v1/bundle"
    || digest !== seal.checkpointSha256
    || !isDeepStrictEqual(statement.predicate, JSON.parse(bundleBytes.toString("utf8")))) {
    throw new Error("workflow publish-delivery checkpoint companion is not digest-bound to the current checkpoint and trust bundle");
  }
}

function readSignedCheckpointStatement(file: string): JsonRecord {
  const envelope = readJsonFile(file, "workflow signed checkpoint envelope");
  if (envelope.payloadType !== "application/vnd.in-toto+json" || typeof envelope.payload !== "string" || !Array.isArray(envelope.signatures) || envelope.signatures.length === 0) {
    throw new Error("workflow publish-delivery signed checkpoint companion has an invalid DSSE envelope");
  }
  try {
    const decoded = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("not an object");
    return decoded as JsonRecord;
  } catch {
    throw new Error("workflow publish-delivery signed checkpoint companion payload is not valid JSON");
  }
}

async function drive(sessionDir: string, argv: string[], json: boolean): Promise<number> {
  const parsed = parseArgs(argv);
  assertOnlyFlags(parsed.flags, new Set(["artifact-root", "session-dir", "json", "adapter-command-file", "evidence-signing-key-file", "max-turns", "turn-timeout-ms", "barrier-wait-ms", "barrier-poll-ms", "context-policy"]), "workflow drive");
  const adapterCommandFile = flagString(parsed.flags, "adapter-command-file");
  if (!adapterCommandFile) throw new Error("workflow drive requires --adapter-command-file <path>");
  const evidenceSigningKeyFile = flagString(parsed.flags, "evidence-signing-key-file");
  if (evidenceSigningKeyFile && !json) throw new Error("workflow drive --evidence-signing-key-file requires --json");
  const maxTurns = integerFlag(parsed.flags, "max-turns", 4, 1, 100);
  const turnTimeoutMs = integerFlag(parsed.flags, "turn-timeout-ms", 900_000, 1, 86_400_000);
  const barrierWaitMs = integerFlag(parsed.flags, "barrier-wait-ms", 300_000, 0, 86_400_000);
  const barrierPollMs = integerFlag(parsed.flags, "barrier-poll-ms", 1_000, 1, 60_000);
  const contextPolicy = enumFlag(parsed.flags, "context-policy", ["warm", "fresh"] as const, "warm");
  const { slug, projectRoot } = readBoundSession(sessionDir);
  assertOrdinaryMatchingAssignmentActor(sessionDir, slug);
  const adapterCommand = loadContinuationAdapterCommand(adapterCommandFile);
  let evidenceSigner: EvidenceSigner | null = null;
  let observedAdapterTurns: Array<Record<string, unknown>> = [];
  const result = await withContinuationDriverLock(sessionDir, async (lock) => {
    assertOrdinaryMatchingAssignmentActor(sessionDir, slug);
    evidenceSigner = evidenceSigningKeyFile ? consumeEvidenceSigningKey(evidenceSigningKeyFile) : null;
    const continuationStore = createFileContinuationStore(sessionDir);
    const outcome = await driveBuilderFlowSession({
      sessionDir,
      store: continuationStore,
      maxTurns,
      adapterCommandIdentity: adapterCommand.identity,
      contextPolicy,
      authorizeTurn: async () => { assertOrdinaryMatchingAssignmentActor(sessionDir, slug); },
      issueTurnAuthority: async (request) => {
        const currentAssignment = assertOrdinaryMatchingAssignmentActor(sessionDir, slug);
        assertLoadedContinuationAdapterIntegrity(adapterCommand);
        const authority = loadContinuationTurnAuthority();
        return authority.issueActiveTurnAuthority({
          sessionDir,
          runId: request.run_id,
          definitionId: request.definition_id,
          definitionVersion: request.definition_version,
          definitionDigest: request.definition_digest,
          currentStep: request.current_step,
          iteration: request.iteration,
          maxTurns: request.max_turns,
          adapterCommandIdentity: adapterCommand.identity,
          assignmentActor: currentAssignment.actorKey,
          assignmentActorStruct: currentAssignment.actor,
          lock,
          timeoutMs: turnTimeoutMs,
        });
      },
      execute: async (request, context) => executeLoadedContinuationAdapter(adapterCommand, request, {
        cwd: projectRoot,
        timeoutMs: turnTimeoutMs,
        continuationTurnSecret: context?.continuationTurnSecret,
        continuationRunId: context?.continuationRunId,
      }),
      ...(evidenceSigningKeyFile ? { preflightTurn: async (request) => {
        assertAcceptedTurnEvidenceCapacity(attestationTurns(continuationStore.acceptedTurns()), request);
      } } : {}),
      waitForBarrier: async (barrier) => waitForContinuationBarrier(barrier, { maxWaitMs: barrierWaitMs, pollMs: barrierPollMs }),
    });
    if (evidenceSigningKeyFile) observedAdapterTurns = attestationTurns(continuationStore.acceptedTurns());
    return outcome;
  });
  const output = evidenceSigner
    ? { ...result, evidence_attestation: signDriveEvidence(evidenceSigner, adapterCommand.identity, maxTurns, result, observedAdapterTurns) }
    : result;
  if (json) console.log(JSON.stringify(output));
  else console.log(`Continuation driver ${result.outcome} after ${result.turns_started} turn(s); canonical Flow is ${result.snapshot.status} at ${result.snapshot.current_step}.`);
  return 0;
}

function attestationTurns(turns: Array<{ request: Record<string, unknown>; result: Record<string, unknown> }>): Array<Record<string, unknown>> {
  const covered = turns.map((turn) => ({ request: structuredClone(turn.request), result: structuredClone(turn.result) }));
  if (Buffer.byteLength(JSON.stringify(covered), "utf8") > 1_048_576) {
    throw new Error("continuation accepted-turn evidence must not exceed 1048576 aggregate bytes");
  }
  return covered;
}

export function assertAcceptedTurnEvidenceCapacity(observedTurns: Array<Record<string, unknown>>, request: Record<string, unknown>): void {
  const base = [...observedTurns, { request: structuredClone(request), result: null }];
  const bytesWithPlaceholder = Buffer.byteLength(JSON.stringify(base), "utf8");
  const exactReservedBytes = bytesWithPlaceholder - Buffer.byteLength("null", "utf8") + MAX_CONTINUATION_TURN_RESULT_BYTES;
  if (exactReservedBytes > 1_048_576) {
    throw new Error("continuation accepted-turn evidence lacks capacity for another bounded result");
  }
}

type EvidenceSigner = { privateKey: KeyObject; publicKeySpkiB64: string };

function consumeEvidenceSigningKey(fileInput: string): EvidenceSigner {
  if (!path.isAbsolute(fileInput) || fileInput !== path.normalize(fileInput)) {
    throw new Error("workflow drive evidence signing key file must be an absolute canonical path");
  }
  const stat = fs.lstatSync(fileInput, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("workflow drive evidence signing key must be a regular file");
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const fd = fs.openSync(fileInput, fs.constants.O_RDONLY | noFollow);
  let keyText: Buffer;
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new Error("workflow drive evidence signing key changed while opening");
    }
    keyText = fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const current = fs.lstatSync(fileInput, { bigint: true });
  if (current.dev !== stat.dev || current.ino !== stat.ino || !current.isFile() || current.isSymbolicLink()) {
    throw new Error("workflow drive evidence signing key changed before consumption");
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(keyText);
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
  } catch {
    throw new Error("workflow drive evidence signing key must be a valid Ed25519 private key");
  }
  fs.unlinkSync(fileInput);
  const publicKeySpkiB64 = createPublicKey(privateKey as unknown as Parameters<typeof createPublicKey>[0])
    .export({ type: "spki", format: "der" }).toString("base64");
  return { privateKey, publicKeySpkiB64 };
}

function signDriveEvidence(
  signer: EvidenceSigner,
  adapterCommandIdentity: string,
  maxTurns: number,
  outcome: unknown,
  observedAdapterTurns: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const payload = {
    schema: "kontour.flow-agents.continuation_evidence",
    version: "1.0",
    adapter_command_identity: adapterCommandIdentity,
    max_turns: maxTurns,
    outcome: structuredClone(outcome),
    adapter_turns: structuredClone(observedAdapterTurns),
  };
  const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
  return {
    schema: "kontour.flow-agents.continuation_evidence_attestation",
    version: "1.0",
    public_key_spki_b64: signer.publicKeySpkiB64,
    payload_b64: payloadBytes.toString("base64"),
    signature_b64: sign(null, payloadBytes, signer.privateKey).toString("base64"),
  };
}

function loadContinuationTurnAuthority(): {
  issueActiveTurnAuthority(input: Record<string, unknown>): { runId: string; turnSecret: string; publicKeyDigest: string; cleanup(): boolean };
  validateSignedActiveTurnAssignmentAuthority(input: Record<string, unknown>): { valid: boolean; record?: { assignment_actor: string; assignment_actor_struct: Record<string, unknown> } };
} {
  return REQUIRE(path.resolve(PACKAGE_ROOT, "scripts", "hooks", "lib", "continuation-turn-authority.js")) as {
    issueActiveTurnAuthority(input: Record<string, unknown>): { runId: string; turnSecret: string; publicKeyDigest: string; cleanup(): boolean };
    validateSignedActiveTurnAssignmentAuthority(input: Record<string, unknown>): { valid: boolean; record?: { assignment_actor: string; assignment_actor_struct: Record<string, unknown> } };
  };
}

async function start(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  assertOnlyFlags(parsed.flags, new Set(["flow", "work-item", "task-slug", "artifact-root", "source-request", "summary", "title", "criterion", "assignment-provider", "effective-state-json"]), "workflow start");
  const flow = flagString(parsed.flags, "flow", "builder.build")!;
  if (flow !== "builder.build" && flow !== "builder.shape") throw new Error("workflow start supports only --flow builder.build or builder.shape");
  const workItem = flagString(parsed.flags, "work-item");
  const artifactRoot = path.resolve(flagString(parsed.flags, "artifact-root", flowAgentsArtifactRoot())!);
  const taskSlug = flagString(parsed.flags, "task-slug");
  if (flow === "builder.shape") {
    if (!taskSlug || !isSafeSlug(taskSlug)) throw new Error("workflow start --flow builder.shape requires an explicit safe --task-slug");
    if (workItem) throw new Error("workflow start --flow builder.shape creates a local Work Item; omit --work-item");
  } else if (!workItem) {
    throw new Error("workflow start requires --work-item <provider-ref>");
  }
  const assignmentProvider = flagString(parsed.flags, "assignment-provider", flow === "builder.shape" || workItem?.startsWith("local:") ? "local-file" : undefined);
  const effectiveStateJson = flagString(parsed.flags, "effective-state-json");
  if (flow === "builder.build" && workItem && !workItem.startsWith("local:") && !assignmentProvider) {
    throw new Error("workflow start requires --assignment-provider <kind> for a provider-backed Work Item; provider identity is never inferred from its reference");
  }
  if (assignmentProvider !== "local-file" && !effectiveStateJson) {
    throw new Error(`workflow start requires --effective-state-json <path> for assignment provider ${assignmentProvider}`);
  }
  if (assignmentProvider === "local-file" && effectiveStateJson) {
    throw new Error("workflow start --effective-state-json is only valid for a non-local assignment provider");
  }
  if (workItem?.startsWith("local:")) {
    const localSlug = workItem.slice("local:".length);
    if (!taskSlug || taskSlug !== localSlug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(localSlug)) {
      throw new Error("local Work Item retries require the exact existing --task-slug binding");
    }
    const sessionDir = validateCanonicalSessionDir(path.join(artifactRoot, taskSlug));
    const localRecord = readJsonFile(path.join(sessionDir, "work-item.json"), "local Work Item binding");
    if (localRecord.id !== taskSlug || (localRecord.source_provider as JsonRecord | undefined)?.kind !== "local") {
      throw new Error("local Work Item retry does not match the existing session binding");
    }
  } else if (taskSlug && flow !== "builder.shape") {
    throw new Error("--task-slug is reserved for an existing local Work Item retry");
  }
  const existingSlug = taskSlug ?? (workItem ? workItemSlug(workItem) : null);
  if (existingSlug && fs.existsSync(path.join(artifactRoot, existingSlug, "state.json"))) {
    try {
      const existing = await loadBuilderFlowRun({ cwd: path.dirname(path.dirname(artifactRoot)), runId: existingSlug });
      if (existing.definitionId !== flow) {
        throw new Error(`workflow start cannot resume ${existing.definitionId} as ${flow}; local shape sessions are not build retries. Create or claim a provider Work Item for the builder.build handoff.`);
      }
    } catch (error) {
      if ((error as { code?: string }).code !== "flow.run_location.not_found") throw error;
    }
  }
  if (flow === "builder.build" && workItem && !workItem.startsWith("local:")) {
    const slug = workItemSlug(workItem);
    const report = path.join(artifactRoot, slug, `${slug}--pull-work.md`);
    try {
      const stat = fs.lstatSync(report);
      if (stat.isSymbolicLink() || !stat.isFile() || !fs.readFileSync(report, "utf8").includes(workItem)) {
        throw new Error("invalid");
      }
    } catch {
      throw new Error(`workflow start requires concrete pull-work selection evidence at ${report} naming ${workItem} before it can produce selected-work`);
    }
  }
  const sourceRequest = flagString(parsed.flags, "source-request", `Start ${flow} for ${workItem ?? `local:${taskSlug}`}`)!;
  const summary = flagString(parsed.flags, "summary", `Deliver ${workItem ?? `local:${taskSlug}`} through ${flow}.`)!;
  const forwarded = keepFlags(argv, new Set(["title", "criterion"]));
  return mainFromPublicWorkflow([
    "ensure-session",
    "--artifact-root", artifactRoot,
    "--flow-id", flow,
    ...(workItem ? ["--work-item", workItem] : []),
    ...(taskSlug ? ["--task-slug", taskSlug] : []),
    ...(assignmentProvider ? ["--assignment-provider", assignmentProvider] : []),
    ...(effectiveStateJson ? ["--effective-state-json", path.resolve(effectiveStateJson)] : []),
    "--source-request", sourceRequest,
    "--summary", summary,
    ...forwarded,
  ]);
}

function workItemSlug(workItem: string): string {
  return workItem.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function status(sessionDir: string, json: boolean): Promise<number> {
  const inspected = await inspectBuilderFlowSession({ sessionDir });
  const result = inspected.run;
  const report = {
    run_id: result.runId,
    definition_id: result.definitionId,
    definition_version: result.definitionVersion,
    status: result.state.status,
    current_step: result.state.current_step,
    session_dir: sessionDir,
    next_action: inspected.projection.next_action ?? null,
  };
  if (json) console.log(JSON.stringify(report));
  else {
    console.log(`${report.definition_id}@${report.definition_version} ${report.run_id}`);
    console.log(`Status: ${report.status}`);
    console.log(`Step: ${report.current_step}`);
    console.log(`Next: ${String(report.next_action && typeof report.next_action === "object" ? (report.next_action as JsonRecord).summary ?? "" : "")}`);
  }
  return 0;
}

async function evidence(sessionDir: string, argv: string[], json: boolean): Promise<number> {
  const parsed = parseArgs(argv);
  assertOnlyFlags(parsed.flags, new Set(["artifact-root", "session-dir", "json", "expectation", "status", "summary", "route-reason", "evidence-ref-json", "criterion-json", "accepted-gap-reason", "waived-by", "command"]), "workflow evidence");
  if (!flagString(parsed.flags, "expectation")) throw new Error("workflow evidence requires --expectation <gate-expectation-id>");
  if (!flagString(parsed.flags, "status")) throw new Error("workflow evidence requires --status <pass|fail|not_verified>");
  if (!flagString(parsed.flags, "summary")) throw new Error("workflow evidence requires --summary <text>");
  const forwarded = stripPublicFlags(argv, new Set(["artifact-root", "session-dir", "json"]));
  const { slug, projectRoot } = readBoundSession(sessionDir);
  const commands = flagList(parsed.flags, "command");
  if (Object.hasOwn(parsed.flags, "command") && commands.length === 0) {
    throw new Error("workflow evidence --command requires a shell command value");
  }
  const expectation = flagString(parsed.flags, "expectation")!;
  // Operation-bound expectations deliberately have no generic evidence writer.
  // Check before recovery, locking, or actor resolution so a locally authored
  // operation result cannot cause any canonical or projection mutation.
  const inspected = await inspectBuilderFlowSession({ sessionDir });
  const operation = builderOperationForExpectation(inspected.run.definitionId, expectation);
  if (operation) {
    throw new Error(`workflow evidence cannot satisfy operation-bound expectation ${expectation}; ${operation} requires authenticated external ChangeProvider completion`);
  }
  assertExecuteFailureRouteBeforeMutation(
    inspected.run.definition as JsonRecord,
    inspected.run.state.current_step,
    flagString(parsed.flags, "status")!,
    flagString(parsed.flags, "route-reason"),
  );
  const requiresTestEvidence = flagString(parsed.flags, "expectation") === "tests-evidence" && flagString(parsed.flags, "status") === "pass";
  // Argument and command-shape rejection must be read-only. Recovery below may
  // repair stale projections, so it runs only after every command is accepted.
  assertRunnableEvidenceCommands(commands, projectRoot, requiresTestEvidence);
  const outcome = await withSubjectLock(path.dirname(sessionDir), slug, async () => {
    // Validate the owner after the lock is held, then keep the lock through command
    // execution, evidence recording, and postcondition capture so assignment and
    // session state cannot change mid-invocation.
    const repaired = await recoverBuilderFlowSession({ sessionDir });
    const caller = await assertMatchingAssignmentActor(sessionDir, slug);
    return runEvidenceTransaction({
      sessionDir,
      slug,
      projectRoot: repaired.projectRoot,
      callerActor: caller.actorKey,
      expectedRunHead: caller.expectedRunHead,
      forwarded,
      expectation,
      requestedStatus: flagString(parsed.flags, "status")!,
      beforeRun: repaired.run,
    });
  });
  if ("error" in outcome) {
    if (outcome.state === "safely_rolled_back") throw outcome.error;
    throw new Error(`workflow evidence recovery required; inspect canonical workflow state: ${errorMessage(outcome.error)}`);
  }
  const report = outcome.report;
  if (json) console.log(JSON.stringify(report));
  else if (outcome.state === "recovered") console.log(`Recovered committed evidence; canonical run is ${report.status} at ${report.current_step}. No retry is required.`);
  else console.log(report.attached
    ? `Recorded evidence (${report.gate_verdict.persisted_value}; commands: ${formatCommandOutcomes(report.command_observations)}); canonical run is ${report.status} at ${report.current_step}.`
    : `Recorded evidence (${report.gate_verdict.persisted_value}; commands: ${formatCommandOutcomes(report.command_observations)}); canonical run is awaiting the remaining gate expectations at ${report.current_step}.`);
  return 0;
}

type CommandObservationReport = { ordinal: number; observation_id: string; exit_code: number; output_sha256: string; outcome: "pass" | "fail" };
type EvidenceReceipt = {
  runId: string; subject: string | null; gateId: string; stepId: string | null; expectedRunHead: string;
  expectationIds: string[]; expectation: string; visit: { enteredAt: number; initial: boolean };
  recordedAt: string | null; digest: string; claimSubject: string | null; claimStepId: string | null;
  claimExpectation: string | null; claimRunHead: string | null;
};
type EvidenceReport = { run_id: string; status: string; current_step: string; attached: boolean; awaiting_evidence: boolean; next_action: unknown; gate_verdict: { requested_status: string; persisted_value: string | null; persisted_status: string | null }; command_observations: CommandObservationReport[]; recovery?: { committed: boolean; retry: "none" } };
type EvidenceTransactionSuccess = { state: "attached" | "recovered"; report: EvidenceReport };
type EvidenceTransactionFailure = { state: "safely_rolled_back" | "recovery_required"; error: unknown };
type EvidenceTransactionResult = EvidenceTransactionSuccess | EvidenceTransactionFailure;

/** Test-only fault boundary for the otherwise atomic public-evidence transaction. */
export let workflowEvidenceTransactionTestHooks: {
  afterRecord?: () => void | Promise<void>; beforePostconditions?: () => void | Promise<void>; beforeSidecarRead?: () => void | Promise<void>;
  afterCandidateResourceAcquired?: (resource: "artifact-directory" | "session-directory" | "trust-snapshot" | "abort-capability" | "candidate-directory" | "candidate-file") => void;
  candidateWrite?: typeof fs.writeSync;
  beforeCandidateReread?: (descriptor: number) => void;
  beforeCandidateCommit?: () => void;
  afterCandidateLink?: (canonicalFile: string) => void;
  beforeCandidateCommitDirectoryFsync?: () => void;
  candidateResourceClosed?: (resource: "trust-snapshot" | "candidate-file" | "candidate-directory" | "session-directory" | "artifact-directory") => void;
} | undefined;
export function setWorkflowEvidenceTransactionTestHooksForTest(hooks: typeof workflowEvidenceTransactionTestHooks): void {
  workflowEvidenceTransactionTestHooks = hooks;
}

export type StagedWorkflowEvidenceCandidate = { transaction_id: string; directory: string; file: string; digest: string; bytes: Buffer };
type StagedWorkflowEvidenceContext = StagedWorkflowEvidenceCandidate & {
  writerError: unknown | null;
  abortCapability: WriterTransactionAbortCapability;
  descriptor: number;
  identity: { dev: number; ino: number };
  sessionDescriptor: number;
  sessionIdentity: { dev: number; ino: number };
  baseline: { exists: boolean; descriptor: number | null; identity: { dev: number; ino: number } | null; bytes: Buffer | null; digest: string | null };
};
class StagedEvidenceSetupRecoveryRequiredError extends Error {}

/** Wave-2 internal seam. Candidates are retained audit residue and never become authoritative here. */
export async function stageWorkflowEvidenceCandidate(sessionDir: string, argv: string[]): Promise<StagedWorkflowEvidenceCandidate> {
  return withStagedWorkflowEvidenceCandidate(sessionDir, argv, async ({ writerError, abortCapability: _abortCapability, descriptor: _descriptor, identity: _identity, sessionDescriptor: _sessionDescriptor, sessionIdentity: _sessionIdentity, baseline: _baseline, ...candidate }) => {
    if (writerError) throw writerError;
    return candidate;
  });
}

async function withStagedWorkflowEvidenceCandidate<T>(
  sessionDir: string,
  argv: string[],
  consume: (candidate: StagedWorkflowEvidenceContext) => Promise<T>,
): Promise<T> {
  const transactionId = randomBytes(16).toString("hex");
  let artifactDescriptor: number | null = null;
  let sessionDescriptor: number | null = null;
  let trustDescriptor: number | null = null;
  let trustBytes: Buffer | null = null;
  let trustIdentity: { dev: number; ino: number } | null = null;
  let candidateDirectoryDescriptor: number | null = null;
  let candidateDescriptor: number | null = null;
  let candidateDirectory = "";
  let candidateFile = "";
  let abortCapability: WriterTransactionAbortCapability | null = null;
  try {
    const artifactRoot = path.dirname(sessionDir);
    artifactDescriptor = openStableDirectoryDescriptor(artifactRoot, "artifact root");
    workflowEvidenceTransactionTestHooks?.afterCandidateResourceAcquired?.("artifact-directory");
    sessionDescriptor = openStableDirectoryDescriptor(sessionDir, "session directory");
    workflowEvidenceTransactionTestHooks?.afterCandidateResourceAcquired?.("session-directory");

    try {
      const canonical = path.join(sessionDir, "trust.bundle");
      trustDescriptor = fs.openSync(canonical, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(trustDescriptor);
      if (!stat.isFile()) throw new Error("workflow evidence canonical trust snapshot must be a regular file");
      trustIdentity = { dev: stat.dev, ino: stat.ino };
      trustBytes = readDescriptorBytes(trustDescriptor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      trustDescriptor = null;
    }
    workflowEvidenceTransactionTestHooks?.afterCandidateResourceAcquired?.("trust-snapshot");

    abortCapability = createWriterTransactionAbortCapability(sessionDir);
    workflowEvidenceTransactionTestHooks?.afterCandidateResourceAcquired?.("abort-capability");

    candidateDirectory = path.join(sessionDir, `.workflow-evidence-transaction-${transactionId}`);
    fs.mkdirSync(candidateDirectory, { mode: 0o700 });
    candidateDirectoryDescriptor = openStableDirectoryDescriptor(candidateDirectory, "candidate directory");
    workflowEvidenceTransactionTestHooks?.afterCandidateResourceAcquired?.("candidate-directory");

    candidateFile = path.join(candidateDirectory, "trust.bundle.candidate");
    candidateDescriptor = fs.openSync(candidateFile, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    const candidateStat = fs.fstatSync(candidateDescriptor);
    const candidateParentStat = fs.fstatSync(candidateDirectoryDescriptor);
    const sessionStat = fs.fstatSync(sessionDescriptor);
    if (!candidateStat.isFile() || !candidateParentStat.isDirectory()) throw new Error("workflow evidence candidate resources are not regular file/directory descriptors");
    workflowEvidenceTransactionTestHooks?.afterCandidateResourceAcquired?.("candidate-file");

    const writerTarget: TrustBundleWriterTarget = {
      file: candidateFile,
      descriptor: candidateDescriptor,
      identity: { dev: candidateStat.dev, ino: candidateStat.ino },
      parentDescriptor: candidateDirectoryDescriptor,
      parentIdentity: { dev: candidateParentStat.dev, ino: candidateParentStat.ino },
      write: workflowEvidenceTransactionTestHooks?.candidateWrite,
      beforeReread: workflowEvidenceTransactionTestHooks?.beforeCandidateReread,
    };
    let writerError: unknown | null = null;
    try { await mainFromPublicWorkflow(argv, { writerTransactionId: transactionId, writerTarget }); }
    catch (error) { writerError = error; }
    const bytes = readDescriptorBytes(candidateDescriptor);
    if (bytes.length > 0) fs.fsyncSync(candidateDirectoryDescriptor);
    return await consume({
      transaction_id: transactionId,
      directory: candidateDirectory,
      file: candidateFile,
      digest: createHash("sha256").update(bytes).digest("hex"),
      bytes,
      writerError,
      abortCapability,
      descriptor: candidateDescriptor,
      identity: { dev: candidateStat.dev, ino: candidateStat.ino },
      sessionDescriptor,
      sessionIdentity: { dev: sessionStat.dev, ino: sessionStat.ino },
      baseline: {
        exists: trustDescriptor !== null,
        descriptor: trustDescriptor,
        identity: trustIdentity,
        bytes: trustBytes,
        digest: trustBytes ? createHash("sha256").update(trustBytes).digest("hex") : null,
      },
    });
  } catch (error) {
    if (candidateDirectory && abortCapability) {
      const aborted = appendWriterTransactionAbort(abortCapability, transactionId, new Date().toISOString());
      if (!aborted) throw new StagedEvidenceSetupRecoveryRequiredError(`workflow evidence staged setup failed and its correlated abort could not be persisted: ${errorMessage(error)}`);
    }
    throw error;
  } finally {
    if (candidateDescriptor !== null) { fs.closeSync(candidateDescriptor); workflowEvidenceTransactionTestHooks?.candidateResourceClosed?.("candidate-file"); }
    if (candidateDirectoryDescriptor !== null) { fs.closeSync(candidateDirectoryDescriptor); workflowEvidenceTransactionTestHooks?.candidateResourceClosed?.("candidate-directory"); }
    if (trustDescriptor !== null) { fs.closeSync(trustDescriptor); workflowEvidenceTransactionTestHooks?.candidateResourceClosed?.("trust-snapshot"); }
    if (sessionDescriptor !== null) { fs.closeSync(sessionDescriptor); workflowEvidenceTransactionTestHooks?.candidateResourceClosed?.("session-directory"); }
    if (artifactDescriptor !== null) { fs.closeSync(artifactDescriptor); workflowEvidenceTransactionTestHooks?.candidateResourceClosed?.("artifact-directory"); }
  }
}

function openStableDirectoryDescriptor(directory: string, label: string): number {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(descriptor);
    const current = fs.lstatSync(directory);
    if (!opened.isDirectory() || current.isSymbolicLink() || !current.isDirectory() || opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error(`workflow evidence ${label} must be a stable non-symlink directory`);
    }
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function commitStagedWorkflowEvidence(candidate: StagedWorkflowEvidenceContext, canonicalFile: string): void {
  workflowEvidenceTransactionTestHooks?.beforeCandidateCommit?.();
  const candidateBytes = readDescriptorBytes(candidate.descriptor);
  const digest = createHash("sha256").update(candidateBytes).digest("hex");
  if (digest !== candidate.digest) throw new Error("workflow evidence candidate bytes changed before commit");
  if (candidate.baseline.exists) {
    assertCanonicalBaselineUnchanged(candidate, canonicalFile);
    const descriptor = candidate.baseline.descriptor!;
    writeDescriptorFully(descriptor, candidateBytes);
    fs.ftruncateSync(descriptor, candidateBytes.length);
    fs.fsyncSync(descriptor);
    if (!readDescriptorBytes(descriptor).equals(candidateBytes)) throw new Error("workflow evidence canonical trust reread did not match committed candidate bytes");
    const current = fs.lstatSync(canonicalFile);
    const identity = candidate.baseline.identity!;
    if (current.isSymbolicLink() || !current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new Error("workflow evidence canonical trust pathname changed during pinned-descriptor commit");
    }
  } else {
    try { fs.linkSync(candidate.file, canonicalFile); }
    catch (error) { throw new Error(`workflow evidence candidate create-if-absent commit failed without replacing canonical trust: ${errorMessage(error)}`); }
    workflowEvidenceTransactionTestHooks?.afterCandidateLink?.(canonicalFile);
    const current = fs.lstatSync(canonicalFile);
    if (current.isSymbolicLink() || !current.isFile() || current.dev !== candidate.identity.dev || current.ino !== candidate.identity.ino) {
      throw new Error("workflow evidence candidate hard-link commit did not preserve staged inode identity");
    }
    const canonicalDescriptor = fs.openSync(canonicalFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (!readDescriptorBytes(canonicalDescriptor).equals(candidateBytes)) throw new Error("workflow evidence hard-linked canonical bytes do not match the staged candidate");
    } finally { fs.closeSync(canonicalDescriptor); }
  }
  workflowEvidenceTransactionTestHooks?.beforeCandidateCommitDirectoryFsync?.();
  const session = fs.fstatSync(candidate.sessionDescriptor);
  if (!session.isDirectory() || session.dev !== candidate.sessionIdentity.dev || session.ino !== candidate.sessionIdentity.ino) {
    throw new Error("workflow evidence pinned session directory changed before candidate commit durability");
  }
  fs.fsyncSync(candidate.sessionDescriptor);
}

function assertCanonicalBaselineUnchanged(candidate: StagedWorkflowEvidenceContext, canonicalFile: string): void {
  if (!candidate.baseline.exists) {
    if (fs.existsSync(canonicalFile)) throw new Error("workflow evidence canonical trust appeared after absent baseline");
    return;
  }
  const identity = candidate.baseline.identity!;
  const descriptor = fs.fstatSync(candidate.baseline.descriptor!);
  const current = fs.lstatSync(canonicalFile);
  if (!descriptor.isFile() || current.isSymbolicLink() || !current.isFile()
    || descriptor.dev !== identity.dev || descriptor.ino !== identity.ino
    || current.dev !== identity.dev || current.ino !== identity.ino
    || createHash("sha256").update(readDescriptorBytes(candidate.baseline.descriptor!)).digest("hex") !== candidate.baseline.digest) {
    throw new Error("workflow evidence canonical trust baseline changed");
  }
}

function writeDescriptorFully(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error("workflow evidence canonical trust write returned zero or invalid byte count");
    offset += count;
  }
}

async function runEvidenceTransaction(input: {
  sessionDir: string; slug: string; projectRoot: string; callerActor: string; expectedRunHead: string; forwarded: string[];
  expectation: string; requestedStatus: string; beforeRun: Awaited<ReturnType<typeof recoverBuilderFlowSession>>["run"];
}): Promise<EvidenceTransactionResult> {
  const trustBundleFile = path.join(input.sessionDir, "trust.bundle");
  const beforeEvidence = manifestEvidenceIdentity(input.beforeRun.manifest);
  const preMutationReceipt = captureEvidenceReceipt(input.beforeRun, input.expectation, input.expectedRunHead);
  try {
    return await withStagedWorkflowEvidenceCandidate(input.sessionDir, [
      "record-gate-claim", input.sessionDir, ...input.forwarded, "--actor", input.callerActor,
      "--flow-run-head", input.expectedRunHead,
    ], async (candidate) => {
      let receipt: EvidenceReceipt | null = null;
      let commitAttempted = false;
      let commitSucceeded = false;
      try {
        if (candidate.writerError) throw candidate.writerError;
        if (candidate.bytes.length === 0) throw new Error("workflow evidence staged writer produced no candidate bytes");
        await workflowEvidenceTransactionTestHooks?.afterRecord?.();
        receipt = receiptForGateClaim(candidate.file, preMutationReceipt, candidate.digest);
        const synchronized = await syncBuilderFlowSession({
          sessionDir: input.sessionDir,
          expectedRunHead: input.expectedRunHead,
          stagedTrustBundle: { file: candidate.file, descriptor: candidate.descriptor, identity: candidate.identity, expectedSha256: candidate.digest },
        });
        const run = await loadBuilderFlowRun({ cwd: input.projectRoot, runId: input.slug });
        await workflowEvidenceTransactionTestHooks?.beforePostconditions?.();
        assertEvidencePostconditions(synchronized.attached, beforeEvidence, run, receipt);
        commitAttempted = true;
        commitStagedWorkflowEvidence(candidate, trustBundleFile);
        commitSucceeded = true;
        await workflowEvidenceTransactionTestHooks?.beforeSidecarRead?.();
        const updatedSidecar = readBoundSession(input.sessionDir).sidecar;
        const gateVerdict = readGateVerdict(trustBundleFile, input.expectation);
        return {
          state: "attached",
          report: immutableReport({
            run_id: run.runId, status: run.state.status, current_step: run.state.current_step,
            attached: synchronized.attached, awaiting_evidence: !synchronized.attached,
            next_action: updatedSidecar.next_action ?? null,
            gate_verdict: { requested_status: input.requestedStatus, persisted_value: gateVerdict.value, persisted_status: gateVerdict.status },
            command_observations: gateVerdict.observations,
          }),
        } satisfies EvidenceTransactionSuccess;
      } catch (error) {
        const attachment = receipt
          ? await canonicalEvidenceAttachment(input.projectRoot, input.slug, receipt, beforeEvidence)
          : await canonicalManifestStillUnchanged(input.projectRoot, input.slug, beforeEvidence) ? "unattached" : "unknown";
        if (attachment === "attached") {
          if (commitAttempted && !commitSucceeded) return { state: "recovery_required", error: new Error(`workflow evidence is canonically attached; no retry is required, but candidate commit needs recovery: ${errorMessage(error)}`) };
          try {
            if (!commitSucceeded) {
              commitAttempted = true;
              commitStagedWorkflowEvidence(candidate, trustBundleFile);
              commitSucceeded = true;
            }
            const recovered = await recoverBuilderFlowSession({ sessionDir: input.sessionDir });
            const gateVerdict = readGateVerdict(trustBundleFile, receipt!.expectation);
            return {
              state: "recovered",
              report: immutableReport({
                run_id: recovered.run.runId, status: recovered.run.state.status, current_step: recovered.run.state.current_step,
                attached: true, awaiting_evidence: false, next_action: recovered.projection.next_action ?? null,
                gate_verdict: { requested_status: input.requestedStatus, persisted_value: gateVerdict.value, persisted_status: gateVerdict.status },
                command_observations: gateVerdict.observations, recovery: { committed: true, retry: "none" },
              }),
            };
          } catch (commitError) {
            return { state: "recovery_required", error: new Error(`workflow evidence is canonically attached; no retry is required: ${errorMessage(commitError)}`) };
          }
        }
        if (attachment !== "unattached") return { state: "recovery_required", error };
        try {
          assertCanonicalBaselineUnchanged(candidate, trustBundleFile);
          if (!appendWriterTransactionAbort(candidate.abortCapability, candidate.transaction_id, new Date().toISOString())) {
            return { state: "recovery_required", error: new Error(`workflow evidence retained staged candidate but could not append its correlated abort marker: ${errorMessage(error)}`) };
          }
          return { state: "safely_rolled_back", error };
        } catch (abortError) {
          return { state: "recovery_required", error: evidenceRollbackError(error, abortError) };
        }
      }
    });
  } catch (error) {
    return error instanceof StagedEvidenceSetupRecoveryRequiredError
      ? { state: "recovery_required", error }
      : { state: "safely_rolled_back", error };
  }
}

async function canonicalManifestStillUnchanged(projectRoot: string, slug: string, beforeEvidence: readonly JsonRecord[]): Promise<boolean> {
  try {
    const raw = await loadRun(slug, projectRoot);
    return isDeepStrictEqual(manifestEvidenceIdentity(raw.manifest as JsonRecord), beforeEvidence);
  } catch { return false; }
}

function readDescriptorBytes(descriptor: number): Buffer {
  const stat = fs.fstatSync(descriptor);
  if (!stat.isFile() || stat.size > Number.MAX_SAFE_INTEGER) throw new Error("workflow evidence expected a readable regular file descriptor");
  const bytes = Buffer.alloc(stat.size);
  let offset = 0;
  while (offset < bytes.length) {
    const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (read === 0) throw new Error("workflow evidence encountered a short descriptor read");
    offset += read;
  }
  return bytes;
}

function captureEvidenceReceipt(
  beforeRun: Awaited<ReturnType<typeof recoverBuilderFlowSession>>["run"], expectation: string, expectedRunHead: string,
): Omit<EvidenceReceipt, "recordedAt" | "digest" | "claimSubject" | "claimStepId" | "claimExpectation" | "claimRunHead"> {
  if (flowRunHead(beforeRun.state) !== expectedRunHead) {
    throw new Error("workflow evidence cannot bind a stale canonical Flow run head");
  }
  const gates = openGates(beforeRun.definition, beforeRun.state) as Array<JsonRecord>;
  if (gates.length !== 1) throw new Error("workflow evidence requires exactly one canonical open gate before recording a claim");
  const gate = gates[0]!;
  const gateId = typeof gate.id === "string" ? gate.id : null;
  const stepId = typeof gate.step === "string" ? gate.step : null;
  if (!gateId || !stepId) throw new Error("workflow evidence cannot bind a canonical gate identifier and step");
  const expectationIds = (expectationsForGate(gate as never, beforeRun.config) as Array<JsonRecord>)
    .filter((candidate) => candidate.required === true || candidate.id === expectation)
    .map((candidate) => typeof candidate.id === "string" ? candidate.id : null);
  if (expectationIds.some((id) => !id) || new Set(expectationIds).size !== expectationIds.length || !expectationIds.includes(expectation)) {
    throw new Error("workflow evidence cannot bind an exact canonical expectation set");
  }
  return {
    runId: beforeRun.runId,
    subject: typeof beforeRun.state.subject === "string" ? beforeRun.state.subject : null,
    gateId,
    stepId,
    expectedRunHead,
    expectationIds: (expectationIds as string[]).sort(),
    expectation,
    visit: currentGateVisit(beforeRun.state, stepId),
  };
}

function receiptForGateClaim(
  bundleFile: string,
  canonical: Omit<EvidenceReceipt, "recordedAt" | "digest" | "claimSubject" | "claimStepId" | "claimExpectation" | "claimRunHead">,
  digest: string,
): EvidenceReceipt {
  const gate = readGateClaim(bundleFile, canonical.expectation);
  const metadata = gate.metadata as JsonRecord;
  const gateClaim = metadata.gate_claim as JsonRecord;
  return {
    ...canonical,
    recordedAt: typeof gateClaim.recorded_at === "string" ? gateClaim.recorded_at : null,
    digest,
    claimSubject: typeof metadata.workflow_subject_ref === "string" ? metadata.workflow_subject_ref : null,
    claimStepId: typeof gateClaim.step_id === "string" ? gateClaim.step_id : null,
    claimExpectation: typeof gateClaim.expectation_id === "string" ? gateClaim.expectation_id : null,
    claimRunHead: typeof gateClaim.flow_run_head === "string" ? gateClaim.flow_run_head : null,
  };
}

/**
 * Exact, deliberately conservative classifier used after a failed public-evidence
 * transaction.  It has no transition scan: the receipt's visit boundary was
 * captured by the runtime before the writer was invoked.
 */
export function classifyCanonicalEvidenceAttachment(
  receipt: EvidenceReceipt,
  run: { runId: string; state: JsonRecord; manifest: JsonRecord },
  beforeEvidence: readonly JsonRecord[],
): "attached" | "unattached" | "unknown" {
  if (!validReceipt(receipt) || run.runId !== receipt.runId || run.state.subject !== receipt.subject) return "unknown";
  const evidence = Array.isArray(run.manifest.evidence) ? run.manifest.evidence : null;
  if (!evidence) return "unknown";
  const beforeById = new Map<string, JsonRecord>();
  for (const entry of beforeEvidence) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.id !== "string" || beforeById.has(entry.id)) return "unknown";
    beforeById.set(entry.id, entry);
  }
  const allIds = new Set<string>();
  for (const entry of evidence) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "unknown";
    const id = (entry as JsonRecord).id;
    if (typeof id !== "string" || allIds.has(id)) return "unknown";
    allIds.add(id);
  }
  const newEntries = evidence.filter((entry) => {
    const id = (entry as JsonRecord).id;
    return !beforeById.has(id as string);
  });
  if (newEntries.length === 0) {
    return priorManifestEvidenceIsUnchanged(evidence as JsonRecord[], beforeById) ? "unattached" : "unknown";
  }
  if (newEntries.length !== 1) return "unknown";
  const entry = newEntries[0];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "unknown";
  const candidate = entry as JsonRecord;
  if (typeof candidate.id !== "string" || (Object.hasOwn(candidate, "superseded_by") && candidate.superseded_by !== null)) return "unknown";
  if (candidate.gate_id !== receipt.gateId || candidate.sha256 !== receipt.digest) return "unknown";
  if (!sameStringSet(candidate.expectation_ids, receipt.expectationIds)) return "unknown";
  const recordedAt = parseEvidenceTimestamp(receipt.recordedAt);
  const attachedAt = parseEvidenceTimestamp(candidate.attached_at);
  if (recordedAt === null || attachedAt === null || recordedAt < receipt.visit.enteredAt || attachedAt < recordedAt) return "unknown";
  if (!priorManifestEvidenceMatchesAttachment(evidence as JsonRecord[], beforeById, candidate)) return "unknown";
  return "attached";
}

function priorManifestEvidenceIsUnchanged(evidence: JsonRecord[], beforeById: ReadonlyMap<string, JsonRecord>): boolean {
  if (evidence.length !== beforeById.size) return false;
  return evidence.every((entry) => typeof entry.id === "string" && isDeepStrictEqual(stableManifestEvidenceIdentity(entry), beforeById.get(entry.id)));
}

function priorManifestEvidenceMatchesAttachment(evidence: JsonRecord[], beforeById: ReadonlyMap<string, JsonRecord>, candidate: JsonRecord): boolean {
  const priorEntries = evidence.filter((entry) => entry.id !== candidate.id);
  if (priorEntries.length !== beforeById.size || typeof candidate.id !== "string") return false;
  return priorEntries.every((entry) => {
    if (typeof entry.id !== "string") return false;
    const before = beforeById.get(entry.id);
    if (!before) return false;
    const normalizedEntry = stableManifestEvidenceIdentity(entry);
    const normalizedBefore = { ...before };
    if (isDeepStrictEqual(normalizedEntry, normalizedBefore)) return true;
    if (normalizedEntry.gate_id !== candidate.gate_id || normalizedEntry.superseded_by !== candidate.id) return false;
    delete normalizedEntry.superseded_by;
    if (normalizedBefore.superseded_by === null) delete normalizedBefore.superseded_by;
    return isDeepStrictEqual(normalizedEntry, normalizedBefore);
  });
}

function validReceipt(receipt: EvidenceReceipt): boolean {
  return typeof receipt.runId === "string"
    && (typeof receipt.subject === "string" || receipt.subject === null)
    && typeof receipt.gateId === "string"
    && typeof receipt.stepId === "string"
    && typeof receipt.expectedRunHead === "string"
    && typeof receipt.expectation === "string"
    && Array.isArray(receipt.expectationIds)
    && receipt.expectationIds.length > 0
    && new Set(receipt.expectationIds).size === receipt.expectationIds.length
    && receipt.expectationIds.includes(receipt.expectation)
    && Number.isFinite(receipt.visit?.enteredAt)
    && typeof receipt.digest === "string"
    && receipt.claimSubject === receipt.subject
    && receipt.claimStepId === receipt.stepId
    && receipt.claimExpectation === receipt.expectation
    && receipt.claimRunHead === receipt.expectedRunHead;
}

function sameStringSet(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.every((entry) => typeof entry === "string")
    && value.length === expected.length
    && new Set(value).size === value.length
    && value.every((entry) => expected.includes(entry));
}

function parseEvidenceTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function assertEvidencePostconditions(attached: boolean, beforeEvidence: readonly JsonRecord[], run: { runId: string; state: JsonRecord; manifest: JsonRecord }, receipt: EvidenceReceipt): void {
  const classification = classifyCanonicalEvidenceAttachment(receipt, run, beforeEvidence);
  if (attached && classification !== "attached") {
    throw new Error("workflow evidence did not attach exactly this invocation's resulting trust.bundle digest");
  }
  if (!attached && classification !== "unattached") {
    throw new Error("workflow evidence changed the canonical manifest while synchronization reported no attachment");
  }
}

async function canonicalEvidenceAttachment(projectRoot: string, slug: string, receipt: EvidenceReceipt | null, beforeEvidence: readonly JsonRecord[]): Promise<"attached" | "unattached" | "unknown"> {
  if (!receipt) return "unknown";
  try {
    const run = await loadBuilderFlowRun({ cwd: projectRoot, runId: slug });
    return classifyCanonicalEvidenceAttachment(receipt, run, beforeEvidence);
  } catch {
    // A valid but not-yet-shipped definition amendment makes the Builder adapter
    // intentionally reject its own identity.  The raw Flow manifest can still
    // prove a clean absence: any new entry remains uncertain for a later exact
    // receipt classifier, but no new entry permits the transaction-owned bundle
    // to be restored safely.
    try {
      const raw = await loadRun(slug, projectRoot);
      return classifyCanonicalEvidenceAttachment(receipt, { runId: slug, state: raw.state as JsonRecord, manifest: raw.manifest as JsonRecord }, beforeEvidence);
    } catch {
      return "unknown";
    }
  }
}

function evidenceRollbackError(operationError: unknown, rollbackError: unknown): Error {
  return new Error(`workflow evidence failed and rollback was incomplete: ${errorMessage(operationError)}; rollback error: ${errorMessage(rollbackError)}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readGateClaim(bundleFile: string, expectationId: string): JsonRecord {
  const bundle = readJsonFile(bundleFile, "workflow trust bundle");
  const claims = Array.isArray(bundle.claims) ? bundle.claims : [];
  const claim = claims.find((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const metadata = (candidate as JsonRecord).metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
    const gateClaim = (metadata as JsonRecord).gate_claim;
    return Boolean(gateClaim && typeof gateClaim === "object" && !Array.isArray(gateClaim) && (gateClaim as JsonRecord).expectation_id === expectationId);
  }) as JsonRecord | undefined;
  if (!claim) throw new Error(`workflow evidence did not persist a gate claim for expectation ${expectationId}`);
  return claim;
}

function readGateVerdict(bundleFile: string, expectationId: string): { value: string | null; status: string | null; observations: CommandObservationReport[] } {
  const claim = readGateClaim(bundleFile, expectationId);
  const metadata = claim.metadata as JsonRecord;
  const observations = Array.isArray(metadata.observed_commands)
    ? metadata.observed_commands.flatMap((entry): CommandObservationReport[] => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const observation = entry as JsonRecord;
      if (typeof observation.command !== "string" || !Number.isInteger(observation.exit_code) || typeof observation.output_sha256 !== "string") return [];
      const digest = createHash("sha256").update(observation.command).digest("hex");
      return [{ ordinal: 0, observation_id: `command:${digest}`, exit_code: observation.exit_code as number, output_sha256: observation.output_sha256, outcome: observation.exit_code === 0 ? "pass" : "fail" }];
    })
    .map((observation, index) => ({ ...observation, ordinal: index + 1 }))
    : [];
  return {
    value: typeof claim.value === "string" ? claim.value : null,
    status: typeof claim.status === "string" ? claim.status : null,
    observations,
  };
}

function formatCommandOutcomes(observations: CommandObservationReport[]): string {
  return observations.length === 0 ? "none" : observations.map((observation) => `${observation.outcome} (exit ${observation.exit_code})`).join(", ");
}

function assertExecuteFailureRouteBeforeMutation(
  definition: JsonRecord,
  currentStep: string,
  status: string,
  routeReason: string | undefined,
): void {
  if (currentStep !== "execute" || status !== "fail") return;
  if (!routeReason) {
    throw new Error("workflow evidence --route-reason is required for failed execute evidence");
  }
  const gates = definition.gates;
  if (!gates || typeof gates !== "object" || Array.isArray(gates)) {
    throw new Error("workflow evidence cannot resolve the active execute gate route map");
  }
  const executeGate = Object.values(gates).find((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    return (candidate as JsonRecord).step === "execute";
  }) as JsonRecord | undefined;
  const routes = executeGate?.on_route_back;
  if (!routes || typeof routes !== "object" || Array.isArray(routes)
    || typeof (routes as JsonRecord)[routeReason] !== "string") {
    throw new Error(`workflow evidence --route-reason ${routeReason} is not declared by the active execute gate`);
  }
}

function builderOperationForExpectation(flowId: string, expectationId: string): string | null {
  const kit = readJsonFile(path.join(PACKAGE_ROOT, "kits", "builder", "kit.json"), "Builder kit metadata");
  const parsed = parseKitFlowStepActions(kit, "kits/builder/kit.json");
  if (parsed.errors.length) throw new Error(`Builder kit metadata is invalid: ${parsed.errors.join("; ")}`);
  for (const action of parsed.entries) {
    if (action.flow_id !== flowId) continue;
    const binding = action.expectation_bindings.find((candidate) => candidate.expectation_id === expectationId);
    if (binding?.interface === "operation") return binding.operation ?? "the declared external operation";
  }
  return null;
}

async function critique(sessionDir: string, argv: string[], json: boolean): Promise<number> {
  const parsed = parseArgs(argv);
  assertOnlyFlags(parsed.flags, new Set(["artifact-root", "session-dir", "json", "id", "verdict", "summary", "artifact-ref", "finding-json", "lane-json"]), "workflow critique");
  if (!flagString(parsed.flags, "summary")) throw new Error("workflow critique requires --summary <text>");
  if (Object.hasOwn(parsed.flags, "reviewer")) throw new Error("workflow critique derives reviewer identity from the authenticated assignment actor; --reviewer is not accepted");
  const { slug, projectRoot } = readBoundSession(sessionDir);
  const forwarded = stripPublicFlags(argv, new Set(["artifact-root", "session-dir", "json"]));
  const report = await withSubjectLock(path.dirname(sessionDir), slug, async () => {
    const caller = assertDistinctReviewActor(sessionDir, slug);
    const current = await loadBuilderFlowRun({ cwd: projectRoot, runId: slug });
    if (current.definitionId !== "builder.build" || current.state.current_step !== "verify") throw new Error("workflow critique is allowed only for the canonical builder.build verify step");
    const beforeManifest = JSON.parse(JSON.stringify(current.manifest)) as JsonRecord;
    const beforeTrustBundle = optionalFileDigest(path.join(sessionDir, "trust.bundle"));
    const legacySidecars = ["critique.json", "evidence.json"].map((name) => ({ name, digest: optionalFileDigest(path.join(sessionDir, name)) }));
    await mainFromPublicWorkflow(["record-critique", sessionDir, ...forwarded, "--reviewer", caller.actorKey]);
    const result = await recoverBuilderFlowSession({ sessionDir });
    const digest = fileSha256(path.join(sessionDir, "trust.bundle"));
    if (!isDeepStrictEqual(result.run.manifest, beforeManifest)) {
      throw new Error("workflow critique must not attach or otherwise mutate the Flow manifest");
    }
    if (beforeTrustBundle === digest) {
      throw new Error("workflow critique did not change trust.bundle");
    }
    if (legacySidecars.some(({ name, digest: legacyDigest }) => optionalFileDigest(path.join(sessionDir, name)) !== legacyDigest)) {
      throw new Error("workflow critique must persist only through trust.bundle");
    }
    return immutableReport({ run_id: slug, recorded: true });
  });
  if (json) console.log(JSON.stringify(report));
  else console.log("Recorded critique in the trust bundle.");
  return 0;
}

async function resolveCritique(sessionDir: string, argv: string[], json: boolean): Promise<number> {
  const parsed = parseArgs(argv);
  assertOnlyFlags(parsed.flags, new Set(["artifact-root", "session-dir", "json", "prior-record-id", "resolving-record-id", "authorization-file"]), "workflow resolve-critique");
  if (!flagString(parsed.flags, "prior-record-id") || !flagString(parsed.flags, "resolving-record-id")) {
    throw new Error("workflow resolve-critique requires --prior-record-id <id> and --resolving-record-id <id>");
  }
  const authorizationFile = flagString(parsed.flags, "authorization-file");
  if (!authorizationFile) throw new Error("workflow resolve-critique requires a signed --authorization-file <path>");
  const { projectRoot } = readBoundSession(sessionDir);
  const report = invokeExternalLifecycleAuthority({ action: "resolve-critique", project_root: projectRoot, session_dir: path.resolve(sessionDir), authorization_file: path.resolve(authorizationFile), prior_record_id: flagString(parsed.flags, "prior-record-id")!, resolving_record_id: flagString(parsed.flags, "resolving-record-id")! });
  if (json) console.log(JSON.stringify(report));
  else console.log(report.operation_status === "replayed" ? "Critique resolution was already recorded." : "Resolved historical critique in the trust bundle.");
  return 0;
}

async function resolveCritiqueRequest(sessionDir: string, argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  assertOnlyFlags(parsed.flags, new Set(["artifact-root", "session-dir", "json", "prior-record-id", "resolving-record-id", "expires-in-hours"]), "workflow resolve-critique-request");
  const priorRecordId = flagString(parsed.flags, "prior-record-id");
  const resolvingRecordId = flagString(parsed.flags, "resolving-record-id");
  if (!priorRecordId || !resolvingRecordId) throw new Error("workflow resolve-critique-request requires both critique record ids");
  const { slug, projectRoot } = readBoundSession(sessionDir);
  const bundleFile = path.join(sessionDir, "trust.bundle");
  const bundleBytes = fs.readFileSync(bundleFile);
  const bundle = JSON.parse(bundleBytes.toString("utf8")) as JsonRecord;
  const claims = normalizedCritiqueClaims(Array.isArray(bundle.claims) ? bundle.claims as JsonRecord[] : []);
  const metadata = (id: string): JsonRecord => {
    const matches = claims.filter((claim) => (claim.metadata as JsonRecord | undefined)?.critique_record_id === id);
    if (matches.length !== 1) throw new Error(`critique record ${id} is missing or ambiguous`);
    return matches[0]!.metadata as JsonRecord;
  };
  const prior = metadata(priorRecordId);
  const resolving = metadata(resolvingRecordId);
  const unresolvedLaneIds = (Array.isArray(prior.lanes) ? prior.lanes as JsonRecord[] : []).filter((lane) => lane.status !== "pass").map((lane) => String(lane.id)).sort();
  const unresolvedFindingIds = (Array.isArray(prior.findings) ? prior.findings as JsonRecord[] : []).filter((finding) => finding.status === "open").map((finding) => String(finding.id)).sort();
  const snapshot = (record: JsonRecord): JsonRecord => {
    const target = record.review_target as JsonRecord | undefined;
    return target?.workspace_snapshot && typeof target.workspace_snapshot === "object" ? target.workspace_snapshot as JsonRecord : {};
  };
  const priorWorkspace = snapshot(prior);
  const resolvingWorkspace = snapshot(resolving);
  const state = readJsonFile(path.join(sessionDir, "state.json"), "workflow state");
  const subject = Array.isArray(state.work_item_refs) && state.work_item_refs.length === 1 ? String(state.work_item_refs[0]) : "";
  if (!subject) throw new Error("workflow resolve-critique-request requires one bound subject");
  const now = new Date();
  const hours = Number(flagString(parsed.flags, "expires-in-hours") ?? "24");
  if (!Number.isFinite(hours) || hours <= 0 || hours > 8760) throw new Error("expires-in-hours must be between 0 and 8760");
  const request = buildUnsignedCritiqueResolutionAuthorization({
    project_root: projectRoot, run_id: slug, subject, prior_bundle_sha256: createHash("sha256").update(bundleBytes).digest("hex"),
    prior_record_id: priorRecordId, prior_record_hash: String(prior.critique_record_hash),
    resolving_record_id: resolvingRecordId, resolving_record_hash: String(resolving.critique_record_hash),
    expected_resolver: String(resolving.reviewer), resolved_lane_ids: unresolvedLaneIds, resolved_finding_ids: unresolvedFindingIds,
    prior_snapshot_sha256: String(priorWorkspace.digest), resolving_snapshot_sha256: String(resolvingWorkspace.digest),
    prior_head_sha: String(priorWorkspace.head_sha ?? "none"), resolving_head_sha: String(resolvingWorkspace.head_sha ?? "none"),
    nonce: `critique-resolution-${slug}-${now.getTime()}-${randomBytes(6).toString("hex")}`,
    requested_at: now.toISOString(), expires_at: new Date(now.getTime() + hours * 3_600_000).toISOString(),
  });
  console.log(JSON.stringify({ authorization: request.unsigned, signing_payload: request.signingPayload }, null, 2));
  return 0;
}

function normalizedCritiqueClaims(claims: JsonRecord[]): JsonRecord[] {
  const critiqueClaims = claims.filter((claim) => (claim.metadata as JsonRecord | undefined)?.origin === "critique");
  const records = critiqueClaims.map((claim) => {
    const metadata = claim.metadata as JsonRecord;
    return { ...metadata, verdict: claim.value, summary: claim.fieldOrBehavior };
  });
  const normalized = normalizeCritiqueChainRecords(records).records;
  let index = 0;
  return claims.map((claim) => (claim.metadata as JsonRecord | undefined)?.origin === "critique"
    ? { ...claim, metadata: { ...(claim.metadata as JsonRecord), ...normalized[index++] } }
    : claim);
}

function assertRunnableEvidenceCommands(commands: string[], projectRoot: string, requiresTestEvidence: boolean): void {
  const helperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/hooks/lib/runnable-command.js");
  const { isRunnableCommandText } = REQUIRE(helperPath) as { isRunnableCommandText: (text: string) => boolean };
  if (commands.length > 1 && new Set(commands).size !== commands.length) {
    throw new Error("workflow evidence --command values must be unique because observations are matched by exact command text");
  }
  for (const command of commands) {
    if (!isRunnableCommandText(command)) {
      throw new Error(`workflow evidence ${publicCommandReference(commands, command)} is not a runnable shell command — prose belongs in --summary, which is never executed.`);
    }
    if (requiresTestEvidence && !isMeaningfulTestCommand(command, projectRoot)) {
      throw new Error("workflow evidence tests-evidence command must resolve through a non-vacuous package script or a known test/check/verify/eval runner or project-local test path; shell wrappers, no-ops, version/help commands, and arbitrary node -e commands are not evidence");
    }
  }
}

function publicCommandReference(commands: readonly string[], command: string): string {
  const ordinal = commands.indexOf(command) + 1;
  const digest = createHash("sha256").update(command).digest("hex");
  return `command #${ordinal > 0 ? ordinal : "?"} (sha256:${digest})`;
}

function resolveSessionDir(flags: ReturnType<typeof parseArgs>["flags"]): string {
  const explicit = flagString(flags, "session-dir");
  if (explicit) return validateCanonicalSessionDir(path.resolve(explicit));
  const artifactRoot = path.resolve(flagString(flags, "artifact-root", defaultArtifactRootForRead())!);
  const candidate = currentWorkflowSessionDir(artifactRoot);
  if (!candidate || !isWithin(candidate, artifactRoot) || !fs.existsSync(path.join(candidate, "state.json"))) {
    throw new Error("current workflow pointer does not resolve to a valid session; pass --session-dir explicitly");
  }
  return validateCanonicalSessionDir(candidate);
}

function doctor(argv: string[]): number {
  const parsed = parseArgs(argv);
  const projectRoot = path.resolve(flagString(parsed.flags, "project-root", process.cwd())!);
  const artifactRoot = path.resolve(flagString(parsed.flags, "artifact-root", defaultArtifactRootForRead(projectRoot))!);
  const packageRoot = PACKAGE_ROOT;
  const packageJson = PACKAGE_METADATA;
  const cliVersion = CLI_VERSION;
  const installFile = path.join(projectRoot, ".flow-agents", "install.json");
  const install = readOptionalJson(installFile);
  const state = readCurrentState(artifactRoot);
  const packageKit = readOptionalJson(path.join(packageRoot, "kits", "builder", "kit.json"));
  const installedKitFile = path.join(projectRoot, "kits", "builder", "kit.json");
  const installedKit = readOptionalJson(installedKitFile);
  const definitions = [
    { id: "builder.build", file: "build.flow.json" },
    { id: "builder.shape", file: "shape.flow.json" },
  ].map(({ id, file }) => {
    const packageFile = path.join(packageRoot, "kits", "builder", "flows", file);
    const installedFile = path.join(projectRoot, "kits", "builder", "flows", file);
    return { id, packageFile, installedFile, packageDefinition: readOptionalJson(packageFile), installedDefinition: readOptionalJson(installedFile) };
  });
  const resolvedFlowPackage = readOptionalJson(resolveDependencyPackageJson("@kontourai/flow"));
  const installedVersion = typeof install?.version === "string" ? install.version : null;
  const staleInstall = installedVersion !== null && installedVersion !== cliVersion;
  const activeKitIds = Array.isArray(install?.active_kit_ids) ? install.active_kit_ids.map(String) : (installedKit ? ["builder"] : []);
  const runtime = typeof install?.runtime === "string" ? install.runtime : "base";
  const remediation = pinnedFlowAgentsCommand(cliVersion, ["init", "--runtime", runtime, "--dest", projectRoot, ...activeKitIds.flatMap((id) => ["--activate-kit", id]), "--yes"]);
  const localDependencyFile = path.join(projectRoot, "node_modules", "@kontourai", "flow-agents", "package.json");
  const localDependency = readOptionalJson(localDependencyFile);
  const installIntegrity = verifyInstalledAssets(projectRoot, packageRoot, runtime);
  const warnings: string[] = [];
  if (!install) warnings.push(`No installed hook/bundle version found at ${installFile}. Run: ${remediation}`);
  else if (staleInstall) warnings.push(`Installed hook/writer version ${installedVersion} is incompatible with CLI ${cliVersion}. Run: ${remediation}`);
  if (!installIntegrity.ok) warnings.push(`Installed hook/writer assets failed integrity verification: ${installIntegrity.problems.join("; ")}. Run: ${remediation}`);
  if (localDependency?.version && localDependency.version !== cliVersion) warnings.push(`Repository-local Flow Agents ${String(localDependency.version)} differs from executing CLI ${cliVersion}; keep automation explicitly versioned.`);
  if (activeKitIds.includes("builder") && !installedKit) warnings.push(`Activated Builder Kit is missing at ${installedKitFile}. Run: ${remediation}`);
  for (const definition of definitions) {
    if (activeKitIds.includes("builder") && !definition.installedDefinition) {
      warnings.push(`Activated ${definition.id} definition is missing at ${definition.installedFile}. Run: ${remediation}`);
      continue;
    }
    if (!definition.installedDefinition) continue;
    const validationError = validateFlowDefinition(definition.id, definition.installedDefinition);
    if (validationError) warnings.push(`Installed ${definition.id} definition is invalid: ${validationError}. Run: ${remediation}`);
    if (definition.installedDefinition.id !== definition.packageDefinition?.id) {
      warnings.push(`Installed ${definition.id} definition id ${String(definition.installedDefinition.id)} differs from CLI definition ${String(definition.packageDefinition?.id)}. Run: ${remediation}`);
    }
    if (definition.installedDefinition.version !== definition.packageDefinition?.version) {
      warnings.push(`Installed ${definition.id} version ${String(definition.installedDefinition.version)} differs from CLI version ${String(definition.packageDefinition?.version)}. Run: ${remediation}`);
    } else if (fileSha256(definition.installedFile) !== fileSha256(definition.packageFile)) {
      warnings.push(`Installed ${definition.id} content differs from Flow Agents ${cliVersion}. Run: ${remediation}`);
    }
  }
  if (installedKit && installedKit.schema_version !== packageKit?.schema_version) {
    warnings.push(`Installed Builder Kit schema ${String(installedKit.schema_version)} differs from CLI schema ${String(packageKit?.schema_version)}. Run: ${remediation}`);
  }
  if (installedKit && fileSha256(installedKitFile) !== fileSha256(path.join(packageRoot, "kits", "builder", "kit.json"))) {
    warnings.push(`Installed Builder Kit content differs from Flow Agents ${cliVersion}. Run: ${remediation}`);
  }
  const currentRun = state?.flow_run && typeof state.flow_run === "object" ? state.flow_run as JsonRecord : null;
  const currentDefinition = definitions.find((definition) => definition.id === currentRun?.definition_id);
  if (currentRun?.definition_id && !currentDefinition) {
    warnings.push(`Current run uses unsupported Flow definition ${String(currentRun.definition_id)}; recover or migrate before mutation.`);
  } else if (currentRun && currentDefinition && currentRun.definition_version !== currentDefinition.packageDefinition?.version
    && typeof currentRun.definition_digest !== "string") {
    warnings.push(`Current run uses ${currentDefinition.id}@${String(currentRun.definition_version)} while CLI resolves ${currentDefinition.id}@${String(currentDefinition.packageDefinition?.version)}; recover or migrate before mutation.`);
  }
  if (state && state.schema_version !== "1.0") warnings.push(`Artifact schema ${String(state.schema_version)} is unsupported; recreate or migrate the session with CLI ${cliVersion}.`);
  const trustBundleSchema = readCurrentTrustBundleSchema(artifactRoot);
  if (trustBundleSchema !== null && trustBundleSchema !== "1.0") warnings.push(`Trust bundle schema ${String(trustBundleSchema)} is unsupported; recreate or migrate the session with CLI ${cliVersion}.`);
  const resolvedFlowVersion = typeof resolvedFlowPackage?.version === "string" ? resolvedFlowPackage.version : null;
  const expectedFlowRange = packageJson.dependencies && typeof packageJson.dependencies === "object" ? String((packageJson.dependencies as JsonRecord)["@kontourai/flow"] ?? "") : "";
  if (!resolvedFlowVersion || !flowVersionCompatible(resolvedFlowVersion, expectedFlowRange)) {
    warnings.push(`Resolved Flow runtime ${resolvedFlowVersion ?? "missing"} does not satisfy ${expectedFlowRange || "the package contract"}. Reinstall Flow Agents ${cliVersion}.`);
  }
  const report = {
    ok: warnings.length === 0,
    project_root: projectRoot,
    cli: { version: cliVersion, workflow_contract_version: WORKFLOW_CONTRACT_VERSION, package_root: packageRoot },
    writer: { contract_version: WORKFLOW_WRITER_CONTRACT_VERSION, package_version: cliVersion },
    hook: { contract_version: install && !staleInstall && installIntegrity.ok ? WORKFLOW_CONTRACT_VERSION : null, install_version: installedVersion, path: installIntegrity.hook_config, integrity: installIntegrity },
    local_dependency: {
      version: localDependency?.version ?? null,
      path: localDependency ? path.dirname(localDependencyFile) : null,
      selected: localDependency ? fs.realpathSync(path.dirname(localDependencyFile)) === fs.realpathSync(packageRoot) : false,
    },
    installed: {
      hooks: { version: installedVersion, source: installIntegrity.hook_config, compatible: Boolean(install && !staleInstall && installIntegrity.ok) },
      writer: { version: cliVersion, source: packageRoot, compatible: true },
      runtime: install?.runtime ?? null,
      active_kit_ids: activeKitIds,
    },
    kit: {
      id: packageKit?.id ?? null,
      resolved_schema_version: packageKit?.schema_version ?? null,
      installed_schema_version: installedKit?.schema_version ?? null,
      resolved_content_sha256: fileSha256(path.join(packageRoot, "kits", "builder", "kit.json")),
      installed_content_sha256: installedKit ? fileSha256(installedKitFile) : null,
      source: installedKit ? installedKitFile : path.join(packageRoot, "kits", "builder", "kit.json"),
    },
    flow_runtime: { package_version: resolvedFlowVersion, expected_range: expectedFlowRange, compatible: resolvedFlowVersion ? flowVersionCompatible(resolvedFlowVersion, expectedFlowRange) : false },
    definition: { id: currentRun?.definition_id ?? definitions[0]!.packageDefinition?.id ?? null, version: currentRun?.definition_version ?? definitions[0]!.packageDefinition?.version ?? null },
    definitions: definitions.map((definition) => ({
      id: definition.id,
      resolved_version: definition.packageDefinition?.version ?? null,
      installed_version: definition.installedDefinition?.version ?? null,
      installed_valid: definition.installedDefinition ? validateFlowDefinition(definition.id, definition.installedDefinition) === null : false,
    })),
    artifact: {
      state_schema_version: state?.schema_version ?? null,
      trust_bundle_schema_version: trustBundleSchema,
      session: state ? resolveStateSession(artifactRoot) : null,
    },
    warnings,
    remediation: warnings.length ? remediation : null,
  };
  if (flagBool(parsed.flags, "json")) console.log(JSON.stringify(report));
  else {
    console.log(`Flow Agents CLI: ${cliVersion}`);
    console.log(`Installed hooks/writer: ${installedVersion ?? "missing"}`);
    console.log(`Builder Kit schema: installed=${String(installedKit?.schema_version ?? "missing")} resolved=${String(packageKit?.schema_version ?? "missing")}`);
    console.log(`Flow: ${String(report.definition.id ?? "none")}@${String(report.definition.version ?? "unknown")}`);
    console.log(`Artifact schema: state=${String(report.artifact.state_schema_version ?? "none")} trust=${String(report.artifact.trust_bundle_schema_version ?? "none")}`);
    for (const warning of warnings) console.log(`WARNING: ${warning}`);
  }
  return report.ok ? 0 : 2;
}

function readCurrentState(artifactRoot: string): JsonRecord | null {
  try {
    const session = resolveSessionDir({ "artifact-root": artifactRoot });
    return readJsonFile(path.join(session, "state.json"), "workflow state");
  } catch {
    return null;
  }
}

function resolveStateSession(artifactRoot: string): string | null {
  try { return resolveSessionDir({ "artifact-root": artifactRoot }); } catch { return null; }
}

function readJsonFile(file: string, label: string): JsonRecord {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error(`${label} must be a regular file no larger than 1 MiB`);
    const value = JSON.parse(fs.readFileSync(descriptor, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
    return value as JsonRecord;
  } finally {
    fs.closeSync(descriptor);
  }
}

function readOptionalJson(file: string): JsonRecord | null {
  try { return readJsonFile(file, file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function validateFlowDefinition(expectedId: string, definition: JsonRecord): string | null {
  if (definition.id !== expectedId) return `expected id ${expectedId}, received ${String(definition.id)}`;
  try {
    validateDefinition(definition as never);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function isSafeSlug(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function readBoundSession(sessionDir: string): { sidecar: JsonRecord; slug: string; projectRoot: string } {
  const slug = path.basename(sessionDir);
  if (!isSafeSlug(slug)) throw new Error("workflow session basename must be a safe task slug");
  const sidecar = readJsonFile(path.join(sessionDir, "state.json"), "workflow state");
  if (sidecar.task_slug !== slug) throw new Error("workflow state task_slug must exactly match the safe session basename");
  return { sidecar, slug, projectRoot: path.dirname(path.dirname(path.dirname(sessionDir))) };
}

function readAssignment(sessionDir: string, slug: string): JsonRecord {
  const artifactRoot = path.dirname(sessionDir);
  const assignmentRoot = path.join(artifactRoot, "assignment");
  const stat = fs.lstatSync(assignmentRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("workflow assignment directory must be a non-symlink directory");
  const file = path.join(assignmentRoot, `${slug}.json`);
  const fileStat = fs.lstatSync(file);
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) throw new Error("workflow assignment must be a non-symlink regular file");
  return readJsonFile(file, "workflow assignment");
}

type MatchingAssignmentActor = ReturnType<typeof resolveCurrentAssignmentActor> & { expectedRunHead: string };

async function assertMatchingAssignmentActor(sessionDir: string, slug: string): Promise<MatchingAssignmentActor> {
  const { assignment, caller, matches } = assignmentActorContext(sessionDir, slug);
  const { projectRoot } = readBoundSession(sessionDir);
  const canonical = await loadBuilderFlowRun({ cwd: projectRoot, runId: slug });
  const expectedRunHead = flowRunHead(canonical.state);
  if (matches) return { ...caller, expectedRunHead };

  const authority = loadContinuationTurnAuthority().validateSignedActiveTurnAssignmentAuthority({
    sessionDir,
    runId: process.env.FLOW_AGENTS_CONTINUATION_RUN_ID,
    turnSecret: process.env.FLOW_AGENTS_CONTINUATION_TURN_SECRET,
    definitionVersion: canonical.definitionVersion,
    definitionDigest: canonical.definitionDigest,
  });
  if (authority.valid && authority.record
    && assignment.actor_key === authority.record.assignment_actor
    && isDeepStrictEqual(normalizeAssignmentActor(assignment.actor), normalizeAssignmentActor(authority.record.assignment_actor_struct))) {
    return {
      actorKey: authority.record.assignment_actor,
      actor: normalizeAssignmentActor(authority.record.assignment_actor_struct)! as ReturnType<typeof resolveCurrentAssignmentActor>["actor"],
      expectedRunHead,
    };
  }
  throw new Error("workflow mutation requires the session's active, matching assignment actor");
}

function assertOrdinaryMatchingAssignmentActor(sessionDir: string, slug: string): ReturnType<typeof resolveCurrentAssignmentActor> {
  const { caller, matches } = assignmentActorContext(sessionDir, slug);
  if (!matches) throw new Error("workflow mutation requires the session's active, matching assignment actor");
  return caller;
}

function assignmentActorContext(sessionDir: string, slug: string): {
  assignment: JsonRecord;
  caller: ReturnType<typeof resolveCurrentAssignmentActor>;
  matches: boolean;
} {
  const assignment = readActiveAssignment(sessionDir, slug);
  const caller = resolveCurrentAssignmentActor();
  return { assignment, caller, matches: assignment.actor_key === caller.actorKey && isDeepStrictEqual(normalizeAssignmentActor(assignment.actor), normalizeAssignmentActor(caller.actor)) };
}

function normalizeAssignmentActor(value: unknown): JsonRecord | null {
  return value && typeof value === "object" ? { ...(value as JsonRecord), human: (value as JsonRecord).human ?? null } : null;
}

function readActiveAssignment(sessionDir: string, slug: string): JsonRecord {
  const assignment = readAssignment(sessionDir, slug);
  if (assignment.status !== "claimed" || assignment.artifact_dir !== slug || typeof assignment.actor_key !== "string" || !assignment.actor_key || !assignment.actor || typeof assignment.actor !== "object" || Array.isArray(assignment.actor)) {
    throw new Error("workflow mutation requires the session's active implementation assignment");
  }
  return assignment;
}

function assertDistinctReviewActor(sessionDir: string, slug: string): ReturnType<typeof resolveCurrentAssignmentActor> {
  const assignment = readActiveAssignment(sessionDir, slug);
  const caller = resolveCurrentAssignmentActor();
  if (assignment.actor_key === caller.actorKey) {
    throw new Error(
      "workflow critique requires a reviewer identity distinct from the active implementation assignment actor. " +
        "The reviewer identity is derived from the runtime actor, so an orchestrator that implemented and now reviews " +
        "resolves to the same actor. To record an independent review, run the reviewer under a distinct actor: set " +
        "FLOW_AGENTS_ACTOR=<reviewer-id> on the reviewing process, or run the reviewer in a separate runtime session " +
        "(the runtime session id seeds the actor).",
    );
  }
  return caller;
}

function immutableReport<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  for (const nested of Object.values(value as Record<string, unknown>)) immutableReport(nested);
  return Object.freeze(value);
}

function manifestEvidenceIdentity(manifest: JsonRecord): JsonRecord[] {
  const evidence = Array.isArray(manifest.evidence) ? manifest.evidence : [];
  return evidence
    .flatMap((entry) => entry && typeof entry === "object"
      && typeof (entry as JsonRecord).id === "string"
      && typeof (entry as JsonRecord).sha256 === "string"
      ? [stableManifestEvidenceIdentity(entry as JsonRecord)]
      : []);
}

function stableManifestEvidenceIdentity(entry: JsonRecord): JsonRecord {
  const identity = structuredClone(entry);
  // Flow refreshes these two embedded projections on every attachment. They
  // describe report folding, not the manifest receipt's identity. Every other
  // field remains bound, including id, gate, digest, status, paths, timestamps,
  // expectations, supersession, and route metadata.
  delete identity.bundle_report;
  delete identity.inquiry_records;
  return identity;
}

function optionalFileDigest(file: string): string | null {
  try { return fileSha256(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function stripPublicFlags(argv: string[], removed: Set<string>): string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) { result.push(token); continue; }
    const equals = token.indexOf("=");
    const key = token.slice(2, equals === -1 ? undefined : equals);
    if (!removed.has(key)) { result.push(token); continue; }
    if (equals === -1 && argv[index + 1] !== undefined && !argv[index + 1].startsWith("--")) index += 1;
  }
  return result;
}

function keepFlags(argv: string[], kept: Set<string>): string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const equals = token.indexOf("=");
    const key = token.slice(2, equals === -1 ? undefined : equals);
    const hasValue = equals === -1 && argv[index + 1] !== undefined && !argv[index + 1].startsWith("--");
    if (kept.has(key)) {
      result.push(token);
      if (hasValue) result.push(argv[index + 1]);
    }
    if (hasValue) index += 1;
  }
  return result;
}

function assertOnlyFlags(flags: ReturnType<typeof parseArgs>["flags"], allowed: Set<string>, command: string): void {
  const unsupported = Object.keys(flags).find((key) => !allowed.has(key));
  if (unsupported) throw new Error(`${command} does not support --${unsupported}`);
}

function integerFlag(
  flags: ReturnType<typeof parseArgs>["flags"],
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = flagString(flags, name);
  if (raw === undefined) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error(`workflow drive --${name} must be an integer from ${min} through ${max}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`workflow drive --${name} must be an integer from ${min} through ${max}`);
  return value;
}

function enumFlag<const T extends readonly string[]>(
  flags: ReturnType<typeof parseArgs>["flags"],
  name: string,
  allowed: T,
  fallback: T[number],
): T[number] {
  const raw = flagString(flags, name);
  if (raw === undefined) return fallback;
  if (!allowed.includes(raw)) throw new Error(`workflow drive --${name} must be one of: ${allowed.join(", ")}`);
  return raw;
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function fileSha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function readCurrentTrustBundleSchema(artifactRoot: string): unknown {
  const session = resolveStateSession(artifactRoot);
  if (!session) return null;
  return readOptionalJson(path.join(session, "trust.bundle"))?.schema_version ?? null;
}

function validateCanonicalSessionDir(candidate: string): string {
  const sessionDir = path.resolve(candidate);
  const artifactRoot = path.dirname(sessionDir);
  const kontouraiRoot = path.dirname(artifactRoot);
  const projectRoot = path.dirname(kontouraiRoot);
  if (path.basename(artifactRoot) !== "flow-agents" || path.basename(kontouraiRoot) !== ".kontourai" || path.dirname(sessionDir) !== artifactRoot) {
    throw new Error("workflow session must be .kontourai/flow-agents/<slug>");
  }
  for (const [label, entry, kind] of [
    ["project root", projectRoot, "directory"],
    [".kontourai root", kontouraiRoot, "directory"],
    ["artifact root", artifactRoot, "directory"],
    ["session directory", sessionDir, "directory"],
    ["workflow state", path.join(sessionDir, "state.json"), "file"],
  ] as const) {
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink() || (kind === "directory" ? !stat.isDirectory() : !stat.isFile())) throw new Error(`${label} must be a non-symlink ${kind}`);
  }
  const bundle = path.join(sessionDir, "trust.bundle");
  if (fs.existsSync(bundle)) {
    const stat = fs.lstatSync(bundle);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("workflow trust bundle must be a non-symlink file");
  }
  return sessionDir;
}

function verifyInstalledAssets(projectRoot: string, packageRoot: string, runtime: string): { ok: boolean; problems: string[]; hook_config: string | null } {
  const problems: string[] = [];
  const bundleRoot = path.join(packageRoot, "dist", runtime);
  for (const relativeRoot of ["build/src", "scripts/hooks"]) {
    const expectedRoot = path.join(bundleRoot, relativeRoot);
    if (!fs.existsSync(expectedRoot)) {
      problems.push(`package bundle is missing: ${relativeRoot}`);
      continue;
    }
    const pending = [expectedRoot];
    while (pending.length > 0) {
      const current = pending.pop()!;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const expected = path.join(current, entry.name);
        if (entry.isDirectory()) {
          pending.push(expected);
          continue;
        }
        if (!entry.isFile()) continue;
        const relative = path.relative(bundleRoot, expected);
        const installed = path.join(projectRoot, relative);
        try {
          const stat = fs.lstatSync(installed);
          const matches = runtime === "kiro"
            ? fs.readFileSync(installed, "utf8") === fs.readFileSync(expected, "utf8").replaceAll("__KIRO_PACKAGE_ROOT__", projectRoot)
            : fileSha256(installed) === fileSha256(expected);
          if (stat.isSymbolicLink() || !stat.isFile() || !matches) problems.push(`asset mismatch: ${relative}`);
        } catch { problems.push(`asset missing: ${relative}`); }
      }
    }
  }
  const verifyExactRuntimeFile = (relative: string, expectedContent?: string): void => {
    const expected = path.join(bundleRoot, relative);
    const installed = path.join(projectRoot, relative);
    try {
      const stat = fs.lstatSync(installed);
      const matches = expectedContent === undefined ? fileSha256(installed) === fileSha256(expected) : fs.readFileSync(installed, "utf8") === expectedContent;
      if (stat.isSymbolicLink() || !stat.isFile() || !matches) problems.push(`runtime wiring mismatch: ${relative}`);
    } catch { problems.push(`runtime wiring missing: ${relative}`); }
  };
  const verifyManagedHooks = (relative: string): void => {
    const installedFile = path.join(projectRoot, relative);
    try {
      const stat = fs.lstatSync(installedFile);
      const installed = readJsonFile(installedFile, "installed runtime hook configuration");
      const expected = readJsonFile(path.join(bundleRoot, relative), "packaged runtime hook configuration");
      const installedHooks = installed.hooks as JsonRecord | undefined;
      const expectedHooks = expected.hooks as JsonRecord | undefined;
      const complete = !stat.isSymbolicLink() && stat.isFile() && installedHooks && expectedHooks && Object.entries(expectedHooks).every(([event, groups]) => {
        const actualGroups = installedHooks[event];
        return Array.isArray(groups) && Array.isArray(actualGroups) && groups.every((group) => actualGroups.some((actual) => isDeepStrictEqual(actual, group)));
      });
      if (!complete) problems.push("runtime hook configuration does not contain the packaged managed hooks");
    } catch { problems.push("runtime hook configuration is missing"); }
  };

  let hookConfig: string | null = null;
  if (runtime === "codex") {
    hookConfig = path.join(projectRoot, ".codex", "hooks.json");
    verifyManagedHooks(".codex/hooks.json");
  } else if (runtime === "claude-code") {
    hookConfig = path.join(projectRoot, ".claude", "settings.json");
    verifyManagedHooks(".claude/settings.json");
  } else if (runtime === "opencode") {
    hookConfig = path.join(projectRoot, ".opencode", "plugins", "flow-agents.js");
    verifyExactRuntimeFile(".opencode/plugins/flow-agents.js");
  } else if (runtime === "pi") {
    hookConfig = path.join(projectRoot, ".pi", "extensions", "flow-agents.ts");
    verifyExactRuntimeFile(".pi/extensions/flow-agents.ts");
  } else if (runtime === "kiro") {
    hookConfig = path.join(projectRoot, "agents", "dev.json");
    const expectedAgentsRoot = path.join(bundleRoot, "agents");
    try {
      for (const entry of fs.readdirSync(expectedAgentsRoot, { withFileTypes: true })) {
        if (!entry.isFile() || path.extname(entry.name) !== ".json") continue;
        const relative = path.join("agents", entry.name);
        const rendered = fs.readFileSync(path.join(expectedAgentsRoot, entry.name), "utf8").replaceAll("__KIRO_PACKAGE_ROOT__", projectRoot);
        verifyExactRuntimeFile(relative, rendered);
      }
    } catch { problems.push("runtime wiring missing: agents"); }
  }
  return { ok: problems.length === 0, problems, hook_config: hookConfig };
}

function flowVersionCompatible(version: string, range: string): boolean {
  const actual = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  const minimum = range.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!actual || !minimum) return false;
  const a = actual.slice(1).map(Number);
  const m = minimum.slice(1).map(Number);
  if (a[0] !== m[0]) return false;
  return a[1] > m[1] || (a[1] === m[1] && a[2] >= m[2]);
}

function resolveDependencyPackageJson(packageName: string): string {
  let candidate = path.dirname(REQUIRE.resolve(packageName));
  for (let depth = 0; depth < 8; depth += 1) {
    const metadata = path.join(candidate, "package.json");
    if (fs.existsSync(metadata)) return metadata;
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw new Error(`could not resolve ${packageName} package metadata`);
}
