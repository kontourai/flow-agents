import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { validateDefinition } from "@kontourai/flow";
import { loadBuilderFlowRun } from "../builder-flow-run-adapter.js";
import { parseKitFlowStepActions } from "../flow-kit/validate.js";
import { MAX_CONTINUATION_TURN_RESULT_BYTES, createFileContinuationStore, driveBuilderFlowSession, withContinuationDriverLock } from "../continuation-driver.js";
import { inspectBuilderFlowSession, recoverBuilderFlowSession, syncBuilderFlowSession } from "../builder-flow-runtime.js";
import { flowAgentsPackageRoot, flowAgentsPackageVersion } from "../lib/package-version.js";
import { pinnedFlowAgentsCommand } from "../lib/pinned-cli-command.js";
import { defaultArtifactRootForRead, flowAgentsArtifactRoot } from "../lib/local-artifact-root.js";
import { flagBool, flagList, flagString, parseArgs } from "../lib/args.js";
import { main as builderRun } from "./builder-run.js";
import { currentWorkflowSessionDir, isMeaningfulTestCommand, mainFromPublicWorkflow, WORKFLOW_WRITER_CONTRACT_VERSION } from "./workflow-sidecar.js";
import { resolveCurrentAssignmentActor, withSubjectLock } from "./assignment-provider.js";
import { assertLoadedContinuationAdapterIntegrity, executeLoadedContinuationAdapter, loadContinuationAdapterCommand, waitForContinuationBarrier } from "./continuation-adapter.js";

type JsonRecord = Record<string, unknown>;

export const WORKFLOW_CONTRACT_VERSION = "1.0";
const PACKAGE_ROOT = flowAgentsPackageRoot();
const REQUIRE = createRequire(import.meta.url);
const PACKAGE_METADATA = readJsonFile(path.join(PACKAGE_ROOT, "package.json"), "Flow Agents package metadata");
const CLI_VERSION = flowAgentsPackageVersion();
const PUBLIC_VERBS = ["start", "status", "evidence", "critique", "resolve-critique", "drive", "pause", "resume", "release", "cancel", "archive", "doctor"] as const;

function usage(): void {
  console.log(`Usage: flow-agents workflow <verb> [options]

Public workflow verbs:
  start               Start or resume a workflow for a Work Item.
  status              Show the current canonical run and projected next action.
  evidence            Record evidence for the current Flow gate and synchronize it.
  critique            Record review critique directly into the current trust bundle.
  resolve-critique    Resolve a repaired historical critique through a later review record.
  drive               Continue the canonical run through an explicit runtime adapter.
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
  if (verb === "resolve-critique") return resolveCritique(sessionDir, argv.slice(1), flagBool(parsed.flags, "json"));
  if (verb === "drive") return drive(sessionDir, argv.slice(1), flagBool(parsed.flags, "json"));

  const forwarded = stripPublicFlags(argv.slice(1), new Set(["artifact-root", "session-dir", "json"]));
  if (verb === "release" && !flagString(parsed.flags, "reason")) throw new Error("workflow release requires --reason <text>");
  return builderRun([verb === "release" ? "release-assignment" : verb, "--session-dir", sessionDir, ...forwarded]);
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
  const requiresTestEvidence = flagString(parsed.flags, "expectation") === "tests-evidence" && flagString(parsed.flags, "status") === "pass";
  // Argument and command-shape rejection must be read-only. Recovery below may
  // repair stale projections, so it runs only after every command is accepted.
  assertRunnableEvidenceCommands(commands, projectRoot, requiresTestEvidence);
  const report = await withSubjectLock(path.dirname(sessionDir), slug, async () => {
    // Validate the owner after the lock is held, then keep the lock through command
    // execution, evidence recording, and postcondition capture so assignment and
    // session state cannot change mid-invocation.
    const caller = assertMatchingAssignmentActor(sessionDir, slug);
    const repaired = await recoverBuilderFlowSession({ sessionDir });
    const beforeEvidence = manifestEvidenceIdentity(repaired.run.manifest);
    await mainFromPublicWorkflow([
      "record-gate-claim",
      sessionDir,
      ...forwarded,
      "--actor",
      caller.actorKey,
    ]);

    const synchronized = await syncBuilderFlowSession({ sessionDir });

    const digest = fileSha256(path.join(sessionDir, "trust.bundle"));
    const run = await loadBuilderFlowRun({ cwd: repaired.projectRoot, runId: slug });
    const afterEvidence = manifestEvidenceIdentity(run.manifest);
    const beforeIds = new Set(beforeEvidence.map((entry) => entry.id));
    const newEvidence = afterEvidence.filter((entry) => !beforeIds.has(entry.id));
    if (synchronized.attached && (newEvidence.length !== 1 || newEvidence[0]?.sha256 !== digest)) {
      throw new Error("workflow evidence did not attach exactly this invocation's resulting trust.bundle digest");
    }
    if (!synchronized.attached && newEvidence.length !== 0) {
      throw new Error("workflow evidence changed the canonical manifest while synchronization reported no attachment");
    }
    const updatedSidecar = readBoundSession(sessionDir).sidecar;
    return immutableReport({
      run_id: run.runId,
      status: run.state.status,
      current_step: run.state.current_step,
      attached: synchronized.attached,
      awaiting_evidence: !synchronized.attached,
      next_action: updatedSidecar.next_action ?? null,
    });
  });
  if (json) console.log(JSON.stringify(report));
  else console.log(report.attached
    ? `Recorded evidence; canonical run is ${report.status} at ${report.current_step}.`
    : `Recorded evidence; canonical run is awaiting the remaining gate expectations at ${report.current_step}.`);
  return 0;
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
  assertOnlyFlags(parsed.flags, new Set(["artifact-root", "session-dir", "json", "prior-record-id", "resolving-record-id"]), "workflow resolve-critique");
  if (!flagString(parsed.flags, "prior-record-id") || !flagString(parsed.flags, "resolving-record-id")) {
    throw new Error("workflow resolve-critique requires --prior-record-id <id> and --resolving-record-id <id>");
  }
  const { slug, projectRoot } = readBoundSession(sessionDir);
  const forwarded = stripPublicFlags(argv, new Set(["artifact-root", "session-dir", "json"]));
  const report = await withSubjectLock(path.dirname(sessionDir), slug, async () => {
    const caller = assertStableDistinctReviewActor(sessionDir, slug);
    const current = await loadBuilderFlowRun({ cwd: projectRoot, runId: slug });
    if (current.definitionId !== "builder.build" || current.state.current_step !== "verify") {
      throw new Error("workflow resolve-critique is allowed only for the canonical builder.build verify step");
    }
    const beforeManifest = JSON.parse(JSON.stringify(current.manifest)) as JsonRecord;
    const beforeTrustBundle = optionalFileDigest(path.join(sessionDir, "trust.bundle"));
    const legacySidecars = ["critique.json", "evidence.json"].map((name) => ({ name, digest: optionalFileDigest(path.join(sessionDir, name)) }));
    await mainFromPublicWorkflow(["resolve-critique", sessionDir, ...forwarded, "--resolver", caller.actorKey]);
    const result = await recoverBuilderFlowSession({ sessionDir });
    const afterTrustBundle = optionalFileDigest(path.join(sessionDir, "trust.bundle"));
    if (!isDeepStrictEqual(result.run.manifest, beforeManifest)) {
      throw new Error("workflow resolve-critique must not attach or otherwise mutate the Flow manifest");
    }
    if (legacySidecars.some(({ name, digest }) => optionalFileDigest(path.join(sessionDir, name)) !== digest)) {
      throw new Error("workflow resolve-critique must persist only through trust.bundle");
    }
    return immutableReport({ run_id: slug, resolved: beforeTrustBundle !== afterTrustBundle, replayed: beforeTrustBundle === afterTrustBundle });
  });
  if (json) console.log(JSON.stringify(report));
  else console.log(report.replayed ? "Critique resolution was already recorded." : "Resolved historical critique in the trust bundle.");
  return 0;
}

function assertRunnableEvidenceCommands(commands: string[], projectRoot: string, requiresTestEvidence: boolean): void {
  const helperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/hooks/lib/runnable-command.js");
  const { isRunnableCommandText } = REQUIRE(helperPath) as { isRunnableCommandText: (text: string) => boolean };
  if (commands.length > 1 && new Set(commands).size !== commands.length) {
    throw new Error("workflow evidence --command values must be unique because observations are matched by exact command text");
  }
  for (const command of commands) {
    if (!isRunnableCommandText(command)) {
      throw new Error(`workflow evidence --command ${JSON.stringify(command)} is not a runnable shell command — prose belongs in --summary, which is never executed.`);
    }
    if (requiresTestEvidence && !isMeaningfulTestCommand(command, projectRoot)) {
      throw new Error("workflow evidence tests-evidence command must resolve through a non-vacuous package script or a known test/check/verify/eval runner or project-local test path; shell wrappers, no-ops, version/help commands, and arbitrary node -e commands are not evidence");
    }
  }
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
  } else if (currentRun && currentDefinition && currentRun.definition_version !== currentDefinition.packageDefinition?.version) {
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

function assertMatchingAssignmentActor(sessionDir: string, slug: string): ReturnType<typeof resolveCurrentAssignmentActor> {
  const { assignment, caller, matches } = assignmentActorContext(sessionDir, slug);
  if (matches) return caller;

  const authority = loadContinuationTurnAuthority().validateSignedActiveTurnAssignmentAuthority({
    sessionDir,
    runId: process.env.FLOW_AGENTS_CONTINUATION_RUN_ID,
    turnSecret: process.env.FLOW_AGENTS_CONTINUATION_TURN_SECRET,
  });
  if (authority.valid && authority.record
    && assignment.actor_key === authority.record.assignment_actor
    && isDeepStrictEqual(normalizeAssignmentActor(assignment.actor), normalizeAssignmentActor(authority.record.assignment_actor_struct))) {
    return { actorKey: authority.record.assignment_actor, actor: normalizeAssignmentActor(authority.record.assignment_actor_struct)! as ReturnType<typeof resolveCurrentAssignmentActor>["actor"] };
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

function assertStableDistinctReviewActor(sessionDir: string, slug: string): ReturnType<typeof resolveCurrentAssignmentActor> {
  const helperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/hooks/lib/actor-identity.js");
  const helper = REQUIRE(helperPath) as {
    resolveActorIdentity: (env: NodeJS.ProcessEnv) => { actor: string; source: string; actorStruct: JsonRecord | null };
  };
  const identity = helper.resolveActorIdentity(process.env);
  if (!identity.source.startsWith("runtime-session-id:") && !identity.source.startsWith("ci-runtime:")) {
    throw new Error("workflow resolve-critique requires a stable runtime-session or CI identity; explicit actor overrides and process-ancestry identities are not accepted");
  }
  const caller = assertDistinctReviewActor(sessionDir, slug);
  if (caller.actorKey !== identity.actor) throw new Error("workflow resolve-critique runtime identity changed during authorization");
  return caller;
}

function immutableReport<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  for (const nested of Object.values(value as Record<string, unknown>)) immutableReport(nested);
  return Object.freeze(value);
}

function manifestEvidenceIdentity(manifest: JsonRecord): Array<{ id: string; sha256: string }> {
  const evidence = Array.isArray(manifest.evidence) ? manifest.evidence : [];
  return evidence
    .flatMap((entry) => entry && typeof entry === "object"
      && typeof (entry as JsonRecord).id === "string"
      && typeof (entry as JsonRecord).sha256 === "string"
      ? [{ id: String((entry as JsonRecord).id), sha256: String((entry as JsonRecord).sha256) }]
      : []);
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
