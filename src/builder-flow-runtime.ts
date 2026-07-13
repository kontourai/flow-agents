import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { flowAgentsPackageVersion } from "./lib/package-version.js";
import { pinnedFlowAgentsCommand } from "./lib/pinned-cli-command.js";
import { deriveBuilderGateActionEnvelope, deriveBuilderGateActionProgressSnapshot, type GateActionEnvelope, type GateActionProgressSnapshot } from "./builder-gate-action-envelope.js";
import {
  evaluateGate,
  expectationsForGate,
  lifecycleRequestMatches,
  openGates,
  type FlowGate,
  type FlowExpectation,
  type FlowRunState,
  type JsonObject,
} from "@kontourai/flow";
import { assertAuthorizationUnused, loadBuilderLifecycleAuthorization, readAuthorizationConsumption, recordAuthorizationConsumed } from "./builder-lifecycle-authority.js";
import { assignmentFilePath, performLocalReleaseUnderLock, readLocalAssignmentStatus, resolveCurrentAssignmentActor, withSubjectLock, type ActorStruct } from "./cli/assignment-provider.js";
import {
  BUILDER_BUILD_FLOW_ID,
  type BuilderFlowId,
  BuilderBuildRunInputError,
  cancelBuilderFlowRun,
  evaluateBuilderFlowRun,
  loadBuilderFlowRun,
  pauseBuilderFlowRun,
  resumeBuilderFlowRun,
  startBuilderFlowRun,
  type BuilderFlowRunResult,
} from "./builder-flow-run-adapter.js";

type AnyRecord = Record<string, any>;

export interface BuilderFlowSessionInput {
  sessionDir: string;
  flowId?: BuilderFlowId;
}

export interface BuilderFlowAuthorizedLifecycleInput extends BuilderFlowSessionInput {
  authorizationFile: string;
}

export interface BuilderFlowAgentLifecycleInput extends BuilderFlowSessionInput {
  reason: string;
}

export interface BuilderFlowSessionResult {
  sessionDir: string;
  projectRoot: string;
  run: BuilderFlowRunResult;
  projection: AnyRecord;
  /** Ephemeral adapter context; deliberately excluded from durable state.json projection. */
  gateActionEnvelope: GateActionEnvelope | null;
  /** Canonical progress observation, retained even when terminal runs emit no action envelope. */
  progressSnapshot: GateActionProgressSnapshot;
  attached: boolean;
}

type SessionContext = {
  sessionDir: string;
  artifactRoot: string;
  projectRoot: string;
  slug: string;
  stateFile: string;
  bundleFile: string;
};

type SidecarSnapshot = {
  state: AnyRecord;
  raw: string;
};

type ProjectionTargetSnapshot = {
  file: string;
  raw: string | null;
  root: string;
  field: string;
};

type PreparedProjectionWrites = {
  targets: ProjectionTargetSnapshot[];
  actorEntries: string[] | null;
  writes: Array<{ file: string; content: string }>;
};

type TrustBundleSnapshot = {
  file: string;
  raw: Buffer;
  sha256: string;
};

export async function startBuilderFlowSession(input: BuilderFlowSessionInput): Promise<BuilderFlowSessionResult> {
  const context = resolveSessionContext(input.sessionDir);
  const sidecarSnapshot = readSidecarSnapshot(context);
  const subject = workflowSubject(sidecarSnapshot.state);
  const requestedFlowId = input.flowId ?? persistedFlowId(sidecarSnapshot.state) ?? BUILDER_BUILD_FLOW_ID;
  let run: BuilderFlowRunResult;
  try {
    run = await loadBuilderFlowRun({
      cwd: context.projectRoot,
      runId: context.slug,
    });
    if (run.definitionId !== requestedFlowId) {
      throw new BuilderBuildRunInputError("flowId", `requested ${requestedFlowId} does not match the existing ${run.definitionId} run; start builder.build from a provider Work Item instead of retrying a local shape session`);
    }
  } catch (error) {
    if (!isRunNotFound(error)) throw error;
    run = await startBuilderFlowRun({
      cwd: context.projectRoot,
      runId: context.slug,
      subject,
      flowId: requestedFlowId,
      params: {
        subject,
      },
    });
  }
  assertRunSubjectBinding(run, subject);
  return syncAndProject(context, run, sidecarSnapshot);
}

export async function syncBuilderFlowSession(input: BuilderFlowSessionInput): Promise<BuilderFlowSessionResult> {
  const context = resolveSessionContext(input.sessionDir);
  const sidecarSnapshot = readSidecarSnapshot(context);
  const subject = workflowSubject(sidecarSnapshot.state);
  const run = await loadBuilderFlowRun({
    cwd: context.projectRoot,
    runId: context.slug,
  });
  assertRunSubjectBinding(run, subject);
  return syncAndProject(context, run, sidecarSnapshot);
}

export async function recoverBuilderFlowSession(input: BuilderFlowSessionInput): Promise<BuilderFlowSessionResult> {
  const context = resolveSessionContext(input.sessionDir);
  const sidecarSnapshot = readSidecarSnapshot(context);
  const subject = workflowSubject(sidecarSnapshot.state);
  const run = await loadBuilderFlowRun({
    cwd: context.projectRoot,
    runId: context.slug,
  });
  assertRunSubjectBinding(run, subject);
  const { projection, gateActionEnvelope, progressSnapshot } = projectFlowRun(context, run, sidecarSnapshot.state);
  writeProjection(context, projection, sidecarSnapshot.raw, "recovery");
  return {
    sessionDir: context.sessionDir,
    projectRoot: context.projectRoot,
    run,
    projection,
    gateActionEnvelope,
    progressSnapshot,
    attached: false,
  };
}

export async function inspectBuilderFlowSession(input: BuilderFlowSessionInput): Promise<BuilderFlowSessionResult> {
  const context = resolveSessionContext(input.sessionDir);
  const sidecarSnapshot = readSidecarSnapshot(context);
  const subject = workflowSubject(sidecarSnapshot.state);
  const run = await loadBuilderFlowRun({ cwd: context.projectRoot, runId: context.slug });
  assertRunSubjectBinding(run, subject);
  const { projection, gateActionEnvelope, progressSnapshot } = projectFlowRun(context, run, sidecarSnapshot.state);
  return {
    sessionDir: context.sessionDir,
    projectRoot: context.projectRoot,
    run,
    projection,
    gateActionEnvelope,
    progressSnapshot,
    attached: false,
  };
}

export async function pauseBuilderFlowSession(input: BuilderFlowAgentLifecycleInput): Promise<BuilderFlowSessionResult> {
  return changeBuilderFlowSessionLifecycle(input, "pause");
}

export async function resumeBuilderFlowSession(input: BuilderFlowAgentLifecycleInput): Promise<BuilderFlowSessionResult> {
  return changeBuilderFlowSessionLifecycle(input, "resume");
}

export async function cancelBuilderFlowSession(input: BuilderFlowAuthorizedLifecycleInput): Promise<BuilderFlowSessionResult & { assignmentReleased: boolean; idempotent: boolean }> {
  const context = resolveSessionContext(input.sessionDir);
  return await withSubjectLock(context.artifactRoot, context.slug, async () => {
    const prepared = await prepareAuthorizedLifecycleChange(input, "cancel", context);
    assertAuthorizationUnused(prepared.context.artifactRoot, prepared.authorization);
    const changed = await cancelBuilderFlowRun({ cwd: prepared.context.projectRoot, runId: prepared.context.slug, request: prepared.authorization.request });
    const released = performLocalReleaseUnderLock(prepared.context.artifactRoot, prepared.context.slug, prepared.authorization.assignment_actor, {
      actorKey: prepared.authorization.assignment_actor_key,
      reason: `canonical Flow run canceled by ${prepared.authorization.request.authority.request_ref}`,
      tolerateNoActiveClaim: true,
    });
    const { projection, gateActionEnvelope, progressSnapshot } = projectFlowRun(prepared.context, changed, prepared.sidecarSnapshot.state);
    writeProjection(prepared.context, projection, prepared.sidecarSnapshot.raw, "cancellation projection");
    recordAuthorizationConsumed(prepared.context.artifactRoot, prepared.authorization);
    return { sessionDir: prepared.context.sessionDir, projectRoot: prepared.context.projectRoot, run: changed, projection, gateActionEnvelope, progressSnapshot, attached: false, assignmentReleased: released !== null, idempotent: changed.idempotent };
  });
}

export async function releaseBuilderFlowAssignment(input: BuilderFlowAgentLifecycleInput): Promise<BuilderFlowSessionResult & { assignmentReleased: boolean }> {
  const context = resolveSessionContext(input.sessionDir);
  return await withSubjectLock(context.artifactRoot, context.slug, async () => {
    const prepared = prepareAgentLifecycleChange(input, context);
    const run = await loadBuilderFlowRun({ cwd: context.projectRoot, runId: context.slug });
    const released = performLocalReleaseUnderLock(context.artifactRoot, context.slug, prepared.actor, { actorKey: prepared.actorKey, reason: input.reason });
    const { progressSnapshot } = projectFlowRun(context, run, prepared.sidecarSnapshot.state);
    return { sessionDir: context.sessionDir, projectRoot: context.projectRoot, run, projection: prepared.sidecarSnapshot.state, gateActionEnvelope: null, progressSnapshot, attached: false, assignmentReleased: released !== null };
  });
}

export async function archiveBuilderFlowSession(input: BuilderFlowAuthorizedLifecycleInput): Promise<BuilderFlowSessionResult & { archiveDir: string }> {
  const context = resolveSessionContext(input.sessionDir);
  return await withSubjectLock(context.artifactRoot, context.slug, async () => {
  const prepared = await prepareAuthorizedLifecycleChange(input, "archive", context);
  const priorConsumption = readAuthorizationConsumption(prepared.context.artifactRoot, prepared.authorization);
  const recoveringPreparedArchive = priorConsumption !== null && prepared.sidecarSnapshot.state.status === "archived";
  if (priorConsumption && !recoveringPreparedArchive) throw new Error("lifecycle authorization nonce has already been consumed");
  const run = await loadBuilderFlowRun({ cwd: prepared.context.projectRoot, runId: prepared.context.slug });
  if (run.state.status !== "completed" && run.state.status !== "canceled") {
    throw new BuilderBuildRunInputError("flow_run.status", "must be completed or canceled before archival");
  }
  const archiveRoot = path.join(prepared.context.artifactRoot, "archive");
  const archiveDir = path.join(archiveRoot, prepared.context.slug);
  if (pathExistsNoFollow(archiveDir)) throw new BuilderBuildRunInputError("archive", "destination already exists");
  fs.mkdirSync(archiveRoot, { recursive: true });
  assertSafeDirectory(archiveRoot, prepared.context.artifactRoot, "archive root");
  assertSafeDirectory(prepared.context.sessionDir, prepared.context.artifactRoot, "sessionDir");
  if (!recoveringPreparedArchive && fs.readFileSync(prepared.context.stateFile, "utf8") !== prepared.sidecarSnapshot.raw) {
    throw new BuilderBuildRunInputError("state.json", "changed during archive preparation");
  }
  const archivedState = recoveringPreparedArchive ? prepared.sidecarSnapshot.state : {
    ...prepared.sidecarSnapshot.state,
    status: "archived",
    phase: "done",
    updated_at: new Date().toISOString(),
    next_action: { status: "done", summary: "Builder session archived; canonical Flow artifacts remain retained." },
  };
  if (!recoveringPreparedArchive) {
    writeExistingFileNoFollow(prepared.context.stateFile, `${JSON.stringify(archivedState, null, 2)}\n`);
    clearCurrentPointers(prepared.context.artifactRoot, prepared.context.slug);
    recordAuthorizationConsumed(prepared.context.artifactRoot, prepared.authorization);
  }
  const { progressSnapshot } = projectFlowRun(prepared.context, run, prepared.sidecarSnapshot.state);
  fs.renameSync(prepared.context.sessionDir, archiveDir);
  return {
    sessionDir: archiveDir,
    projectRoot: prepared.context.projectRoot,
    run,
    projection: archivedState,
    gateActionEnvelope: null,
    progressSnapshot,
    attached: false,
    archiveDir,
  };
  });
}

async function changeBuilderFlowSessionLifecycle(
  input: BuilderFlowAgentLifecycleInput,
  operation: "pause" | "resume",
): Promise<BuilderFlowSessionResult> {
  const context = resolveSessionContext(input.sessionDir);
  return await withSubjectLock(context.artifactRoot, context.slug, async () => {
  const prepared = prepareAgentLifecycleChange(input, context);
  const change = operation === "pause" ? pauseBuilderFlowRun : resumeBuilderFlowRun;
  const at = new Date().toISOString();
  const run = await change({
    cwd: context.projectRoot,
    runId: context.slug,
    request: { reason: input.reason, authority: { kind: "operator_request", actor: prepared.actorKey, request_ref: `flow-agents://assignment/${context.slug}/${operation}/${at}`, requested_at: at } },
  });
  const { projection, gateActionEnvelope, progressSnapshot } = projectFlowRun(context, run, prepared.sidecarSnapshot.state);
  writeProjection(context, projection, prepared.sidecarSnapshot.raw, `${operation} projection`);
  return {
    sessionDir: context.sessionDir,
    projectRoot: context.projectRoot,
    run,
    projection,
    gateActionEnvelope,
    progressSnapshot,
    attached: false,
  };
  });
}

async function prepareAuthorizedLifecycleChange(input: BuilderFlowAuthorizedLifecycleInput, operation: "cancel" | "archive", context: SessionContext): Promise<{
  context: SessionContext;
  sidecarSnapshot: SidecarSnapshot;
  authorization: ReturnType<typeof loadBuilderLifecycleAuthorization>;
}> {
  const sidecarSnapshot = readSidecarSnapshot(context);
  const subject = workflowSubject(sidecarSnapshot.state);
  const activeAssignment = readLocalAssignmentStatus(context.artifactRoot, context.slug).record;
  const assignmentFile = assignmentFilePath(context.artifactRoot, context.slug);
  const persistedAssignment = pathExistsNoFollow(assignmentFile)
    ? (assertSafeFile(assignmentFile, context.artifactRoot, "assignment record"), JSON.parse(fs.readFileSync(assignmentFile, "utf8")) as AnyRecord)
    : null;
  const canonicalRun = await loadBuilderFlowRun({ cwd: context.projectRoot, runId: context.slug });
  const acceptsReleasedAssignment = (operation === "cancel" && canonicalRun.state.status === "canceled") || operation === "archive";
  const assignment = activeAssignment ?? (acceptsReleasedAssignment && persistedAssignment?.status === "released" ? persistedAssignment : null);
  if (!assignment || (assignment.status !== "claimed" && !acceptsReleasedAssignment) || !assignment.actor_key) {
    throw new BuilderBuildRunInputError("assignment", "must be actively held by a canonical actor before a lifecycle change");
  }
  if (assignment.work_item_ref && assignment.work_item_ref !== subject) {
    throw new BuilderBuildRunInputError("assignment.work_item_ref", "must match the selected Work Item");
  }
  const authorization = loadBuilderLifecycleAuthorization(input.authorizationFile, {
    projectRoot: context.projectRoot,
    operation,
    runId: context.slug,
    subject,
    actorKey: assignment.actor_key,
    ...(operation === "cancel" && canonicalRun.state.status === "canceled" ? { allowExpired: true } : {}),
    ...(operation === "archive" && sidecarSnapshot.state.status === "archived" ? { allowExpired: true } : {}),
  });
  if (operation === "cancel" && canonicalRun.state.status === "canceled") {
    const terminalEvent = canonicalRun.state.lifecycle?.at(-1);
    if (!terminalEvent || terminalEvent.action !== "cancel" || !lifecycleRequestMatches(terminalEvent, authorization.request)) {
      throw new BuilderBuildRunInputError("authorization.request", "does not match the canonical cancellation being recovered");
    }
  }
  if (!sameActor(authorization.assignment_actor, assignment.actor)) {
    throw new BuilderBuildRunInputError("authorization.assignment_actor", "must match the active assignment holder");
  }
  return { context, sidecarSnapshot, authorization };
}

function prepareAgentLifecycleChange(input: BuilderFlowAgentLifecycleInput, context: SessionContext): { sidecarSnapshot: SidecarSnapshot; actor: ActorStruct; actorKey: string } {
  if (!input.reason.trim()) throw new BuilderBuildRunInputError("reason", "must be non-empty");
  const resolved = resolveCurrentAssignmentActor();
  const sidecarSnapshot = readSidecarSnapshot(context);
  const subject = workflowSubject(sidecarSnapshot.state);
  const assignment = readLocalAssignmentStatus(context.artifactRoot, context.slug).record;
  if (!assignment || assignment.status !== "claimed" || assignment.actor_key !== resolved.actorKey || !sameActor(assignment.actor, resolved.actor)) {
    throw new BuilderBuildRunInputError("assignment", "must be actively held by the current workflow actor");
  }
  if (assignment.work_item_ref && assignment.work_item_ref !== subject) throw new BuilderBuildRunInputError("assignment.work_item_ref", "must match the selected Work Item");
  return { sidecarSnapshot, actor: resolved.actor, actorKey: resolved.actorKey };
}

function sameActor(left: ActorStruct, right: ActorStruct): boolean {
  return isDeepStrictEqual({ ...left, human: left.human ?? null }, { ...right, human: right.human ?? null });
}

function clearCurrentPointers(artifactRoot: string, slug: string): void {
  const candidates = [path.join(artifactRoot, "current.json")];
  const actorRoot = path.join(artifactRoot, "current");
  if (pathExistsNoFollow(actorRoot)) {
    assertSafeDirectory(actorRoot, artifactRoot, "current directory");
    candidates.push(...fs.readdirSync(actorRoot).filter((name) => name.endsWith(".json")).map((name) => path.join(actorRoot, name)));
  }
  for (const file of candidates) {
    if (!pathExistsNoFollow(file) || !fs.lstatSync(file).isFile()) continue;
    const root = file === candidates[0] ? artifactRoot : actorRoot;
    if (root === actorRoot) assertSafeDirectory(actorRoot, artifactRoot, "current directory");
    assertSafeFile(file, root, "current pointer");
    let pointer: AnyRecord;
    try {
      pointer = JSON.parse(fs.readFileSync(file, "utf8")) as AnyRecord;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // Archival retains malformed unrelated pointers for explicit repair.
      continue;
    }
    if (pointer.active_slug === slug) fs.unlinkSync(file);
  }
}

async function syncAndProject(
  context: SessionContext,
  initial: BuilderFlowRunResult,
  sidecarSnapshot: SidecarSnapshot,
): Promise<BuilderFlowSessionResult> {
  let run = initial;
  let attached = false;
  const gates = openGatesForResult(run);
  if (run.state.status === "active" && gates.length !== 1) {
    throw new BuilderBuildRunInputError("flow_run.open_gates", `expected exactly one gate for active step ${run.state.current_step}, found ${gates.length}`);
  }
  if (gates.length === 1 && fs.existsSync(context.bundleFile)) {
    const snapshot = stageTrustBundleSnapshot(context);
    try {
      const rawBundle = JSON.parse(snapshot.raw.toString("utf8"));
      const gateEvidence = await bundleGateEvidence(
        rawBundle,
        gates[0]!,
        run.state,
        run.state.subject,
        context.projectRoot,
        manifestEvidence(run.manifest),
        run.config,
      );
      if (gateEvidence) {
        const alreadyAttached = manifestEvidence(run.manifest).some((entry) =>
          entry.gate_id === gates[0]!.id
          && entry.sha256 === snapshot.sha256
          && typeof entry.superseded_by !== "string"
          && timestampAtOrAfter(entry.attached_at, gateEvidence.visitEnteredAt)
          && gateEvidence.expectationIds.every((expectationId) => Array.isArray(entry.expectation_ids) && entry.expectation_ids.includes(expectationId))
        );
        if (!alreadyAttached) {
          const supersede = manifestEvidence(run.manifest)
            .filter((entry) => entry.gate_id === gates[0]!.id && typeof entry.superseded_by !== "string")
            .map((entry) => String(entry.id));
          run = await evaluateBuilderFlowRun({
            cwd: context.projectRoot,
            runId: context.slug,
            evidence: {
              gate: gates[0]!.id,
              file: path.relative(context.projectRoot, snapshot.file),
              expectedSha256: snapshot.sha256,
              ...(supersede.length > 0 ? { supersede } : {}),
              ...(gateEvidence.failed ? { status: "failed" } : {}),
              ...(gateEvidence.routeReason ? { routeReason: gateEvidence.routeReason } : {}),
              expectationIds: gateEvidence.expectationIds,
            },
          });
          attached = true;
        }
      }
    } finally {
      removeTrustBundleSnapshot(snapshot);
    }
  }
  if (!attached && gates.length === 1 && gateCanPassWithoutNewEvidence(run, gates[0]!)) {
    run = await evaluateBuilderFlowRun({ cwd: context.projectRoot, runId: context.slug });
  }
  const { projection, gateActionEnvelope, progressSnapshot } = projectFlowRun(context, run, sidecarSnapshot.state);
  writeProjection(context, projection, sidecarSnapshot.raw, "projection");
  return {
    sessionDir: context.sessionDir,
    projectRoot: context.projectRoot,
    run,
    projection,
    gateActionEnvelope,
    progressSnapshot,
    attached,
  };
}

function gateCanPassWithoutNewEvidence(run: BuilderFlowRunResult, gate: FlowGate & { id: string }): boolean {
  const definition = JSON.parse(fs.readFileSync(path.join(run.dir, "definition.json"), "utf8"));
  const expectations = expectationsForGate(gate, run.config) as FlowExpectation[];
  const outcome = evaluateGate(definition, run.state, run.manifest, gate.id, run.config);
  return outcome.status === "pass"
    && (typeof outcome.accepted_exception_id === "string" || expectations.every((expectation) => !expectation.required));
}

function assertRunSubjectBinding(run: BuilderFlowRunResult, subject: string): void {
  if (run.state.subject !== subject) {
    throw new BuilderBuildRunInputError("flow_run.state.subject", "must match the selected Work Item");
  }
  if (isRecord(run.state.params)
    && Object.prototype.hasOwnProperty.call(run.state.params, "subject")
    && run.state.params.subject !== subject) {
    throw new BuilderBuildRunInputError("flow_run.state.params.subject", "must match the selected Work Item");
  }
}

function resolveSessionContext(sessionDirInput: string): SessionContext {
  const sessionDir = path.resolve(sessionDirInput);
  const artifactRoot = path.dirname(sessionDir);
  const kontouraiRoot = path.dirname(artifactRoot);
  if (path.basename(artifactRoot) !== "flow-agents" || path.basename(kontouraiRoot) !== ".kontourai") {
    throw new BuilderBuildRunInputError("sessionDir", "must be .kontourai/flow-agents/<slug>");
  }
  assertSafeDirectory(sessionDir, artifactRoot, "sessionDir");
  const slug = path.basename(sessionDir);
  if (!slug || slug === "." || slug === "..") {
    throw new BuilderBuildRunInputError("sessionDir", "must name a session");
  }
  const stateFile = path.join(sessionDir, "state.json");
  if (!fs.existsSync(stateFile)) {
    throw new BuilderBuildRunInputError("sessionDir", "must contain state.json");
  }
  assertSafeFile(stateFile, sessionDir, "state.json");
  return {
    sessionDir,
    artifactRoot,
    projectRoot: path.dirname(kontouraiRoot),
    slug,
    stateFile,
    bundleFile: path.join(sessionDir, "trust.bundle"),
  };
}

function readSidecarSnapshot(context: SessionContext): SidecarSnapshot {
  assertSafeFile(context.stateFile, context.sessionDir, "state.json");
  const raw = fs.readFileSync(context.stateFile, "utf8");
  const value = JSON.parse(raw);
  if (!isRecord(value) || value.task_slug !== context.slug) {
    throw new BuilderBuildRunInputError("sessionDir", "state.json task_slug must match the session directory");
  }
  return { state: value, raw };
}

function workflowSubject(state: AnyRecord): string {
  const refs = state.work_item_refs;
  if (!Array.isArray(refs)
    || refs.length !== 1
    || typeof refs[0] !== "string"
    || refs[0].trim().length === 0) {
    throw new BuilderBuildRunInputError("state.work_item_refs", "must contain exactly one selected Work Item for builder.build");
  }
  return refs[0]!;
}

function persistedFlowId(state: AnyRecord): BuilderFlowId | null {
  const flowRun = isRecord(state.flow_run) ? state.flow_run : null;
  const flowId = flowRun?.definition_id;
  return flowId === "builder.build" || flowId === "builder.shape" ? flowId : null;
}

function openGatesForResult(run: BuilderFlowRunResult): Array<FlowGate & { id: string }> {
  return openGates(
    JSON.parse(fs.readFileSync(path.join(run.dir, "definition.json"), "utf8")),
    run.state,
  ) as Array<FlowGate & { id: string }>;
}

async function bundleGateEvidence(
  bundle: unknown,
  gate: FlowGate,
  state: FlowRunState,
  subject: string,
  projectRoot: string,
  manifest: AnyRecord[],
  config: JsonObject,
): Promise<{ failed: boolean; routeReason: string | null; expectationIds: string[]; visitEnteredAt: number } | null> {
  if (!isRecord(bundle) || !Array.isArray(bundle.claims)) return null;
  const expectations = expectationsForGate(gate, config) as FlowExpectation[];
  const visit = currentGateVisit(state, String((gate as AnyRecord).step));
  const enteredAt = visit.enteredAt;
  const synchronizedAt = Date.now();
  const maxClockSkewMs = 30_000;
  const priorVisitClaimIds = new Set<string>();
  const priorVisitEvidenceIds = new Set<string>();
  for (const entry of manifest) {
    if (entry.gate_id !== String((gate as AnyRecord).id)) continue;
    const claims = isRecord(entry.bundle) && Array.isArray(entry.bundle.claims) ? entry.bundle.claims : [];
    for (const historical of claims) {
      if (isRecord(historical) && typeof historical.id === "string") priorVisitClaimIds.add(historical.id);
    }
    const evidence = isRecord(entry.bundle) && Array.isArray(entry.bundle.evidence) ? entry.bundle.evidence : [];
    for (const historical of evidence) {
      if (isRecord(historical) && typeof historical.id === "string") priorVisitEvidenceIds.add(historical.id);
    }
  }
  const claimIsCurrent = (claim: AnyRecord): boolean => {
    if (typeof claim.id !== "string" || priorVisitClaimIds.has(claim.id)) return false;
    const timestamps: number[] = [];
    const createdAt = parseTimestamp(claim.createdAt);
    if (createdAt !== null) timestamps.push(createdAt);
    if (Array.isArray((bundle as AnyRecord).evidence)) for (const evidence of (bundle as AnyRecord).evidence) {
      if (!isRecord(evidence) || evidence.claimId !== claim.id) continue;
      if (typeof evidence.id !== "string" || priorVisitEvidenceIds.has(evidence.id)) return false;
      const observedAt = parseTimestamp(evidence.observedAt);
      if (observedAt !== null) timestamps.push(observedAt);
    }
    const initialAcquisitionSkew = visit.initial && claim.claimType === "builder.pull-work.selected" ? maxClockSkewMs : 0;
    return timestamps.some((timestamp) => timestamp >= enteredAt - initialAcquisitionSkew
      && timestamp <= synchronizedAt + maxClockSkewMs);
  };
  const relevant = bundle.claims.filter((claim: unknown): claim is AnyRecord => {
    if (!isRecord(claim)) return false;
    if (claim.producerStatus === "superseded") return false;
    const metadata = isRecord(claim.metadata) ? claim.metadata : null;
    if (metadata && typeof metadata.superseded_by === "string") return false;
    return expectations.some((expectation) => {
      const candidate = expectation.bundle_claim;
      return candidate
      && claimIsCurrent(claim)
      &&
      candidate.claimType === claim.claimType
      && (!candidate.subjectType || candidate.subjectType === claim.subjectType)
    });
  });
  if (relevant.length === 0) return null;
  if (relevant.some((claim) => workflowSubjectRef(claim) !== subject)) {
    throw new BuilderBuildRunInputError("evidence.claims.metadata.workflow_subject_ref", "must match the persisted run subject");
  }
  const failed = relevant.some((claim) => claim.value === "fail" || claim.status === "disputed");
  const expectationIds = expectations.filter((expectation) => relevant.some((claim: AnyRecord) => {
    const selector = expectation.bundle_claim;
    return selector.claimType === claim.claimType && (!selector.subjectType || selector.subjectType === claim.subjectType);
  })).map((expectation) => expectation.id);
  const missingRequired = expectations.filter((expectation) => expectation.required && !expectationIds.includes(expectation.id));
  const routeReasons = [...new Set(relevant.flatMap((claim) => {
    const metadata = isRecord(claim.metadata) ? claim.metadata : null;
    const gateClaim = metadata && isRecord(metadata.gate_claim) ? metadata.gate_claim : null;
    return gateClaim && typeof gateClaim.route_reason === "string" ? [gateClaim.route_reason] : [];
  }))];
  if (routeReasons.length > 1) {
    throw new BuilderBuildRunInputError("evidence.claims.metadata.gate_claim.route_reason", "must agree across current-gate claims");
  }
  const routeReason = routeReasons[0] ?? null;
  if (failed && !routeReason) return null;
  // Passing evidence waits for the complete expectation set. A failing
  // snapshot is complete only when a gate producer explicitly declares its
  // route reason; report-only disputed critique state remains pending.
  if (!failed && missingRequired.length > 0) return null;
  if (routeReason && !failed) {
    throw new BuilderBuildRunInputError("evidence.claims.metadata.gate_claim.route_reason", "requires failed current-gate evidence");
  }
  const routeMap = isRecord((gate as AnyRecord).on_route_back) ? (gate as AnyRecord).on_route_back : null;
  if (routeReason && (!routeMap || typeof routeMap[routeReason] !== "string")) {
    throw new BuilderBuildRunInputError("evidence.claims.metadata.gate_claim.route_reason", `is not declared by gate ${String((gate as AnyRecord).id ?? "<unknown>")}`);
  }
  if (String((gate as AnyRecord).id) === "verify-gate" && relevant.some((claim) => claim.claimType === "builder.verify.tests" && claim.value === "pass")) {
    await assertVerifiedTestsTrust(bundle.claims, projectRoot);
  }
  return { failed, routeReason, expectationIds, visitEnteredAt: enteredAt };
}

function currentGateVisit(state: FlowRunState, step: string): { enteredAt: number; initial: boolean } {
  let enteredAt: number | null = null;
  for (const transition of state.transitions ?? []) {
    if (transition.to_step !== step) continue;
    const parsed = parseTimestamp(transition.at);
    if (parsed !== null) enteredAt = parsed;
  }
  const initial = parseTimestamp(state.updated_at);
  if (enteredAt !== null) return { enteredAt, initial: false };
  if (initial !== null) return { enteredAt: initial, initial: true };
  throw new BuilderBuildRunInputError("flow_run.state.updated_at", "must establish the current gate visit boundary");
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestampAtOrAfter(value: unknown, boundary: number): boolean {
  const parsed = parseTimestamp(value);
  return parsed !== null && parsed >= boundary;
}

async function assertVerifiedTestsTrust(claims: unknown[], projectRoot: string): Promise<void> {
  const testClaims = claims.filter((claim): claim is AnyRecord => isRecord(claim)
    && claim.claimType === "builder.verify.tests"
    && claim.value === "pass"
    && isRecord(claim.metadata)
    && isRecord(claim.metadata.gate_claim)
    && claim.metadata.gate_claim.expectation_id === "tests-evidence");
  if (testClaims.length === 0) throw new BuilderBuildRunInputError("evidence.tests", "is missing a passing tests-evidence claim");
  const liveCritiques = claims.filter((claim): claim is AnyRecord => isRecord(claim)
    && isRecord(claim.metadata)
    && claim.metadata.origin === "critique"
    && typeof claim.metadata.superseded_by !== "string");
  if (liveCritiques.length === 0 || liveCritiques.some((claim) => !isSubstantivePassingCritique(claim))) {
    throw new BuilderBuildRunInputError("evidence.critique", "a passing tests-evidence claim requires a current clean critique");
  }
  const implementationActors = new Set(testClaims.map((claim) => claim.metadata.recorded_by).filter((actor): actor is string => typeof actor === "string" && actor.length > 0));
  if (implementationActors.size !== 1 || liveCritiques.some((claim) => typeof claim.metadata.reviewer !== "string" || implementationActors.has(claim.metadata.reviewer))) {
    throw new BuilderBuildRunInputError("evidence.critique.reviewer", "must identify a reviewer distinct from the tests-evidence implementation actor");
  }
  await Promise.all(liveCritiques.flatMap(async (claim) => {
    const artifacts = reviewedArtifacts(claim);
    await Promise.all(artifacts.map((artifact) => assertReviewedArtifactDigest(artifact, projectRoot)));
    assertReviewedWorkspaceSnapshot(claim, artifacts, projectRoot);
  }));
  const criteria = claims.filter((claim): claim is AnyRecord => isRecord(claim) && isRecord(claim.metadata) && claim.metadata.origin === "acceptance");
  if (criteria.length === 0 || criteria.some((claim) => {
    const criterion = isRecord(claim.metadata.criterion) ? claim.metadata.criterion : null;
    return claim.value !== "pass" || !criterion || !Array.isArray(criterion.evidence_refs) || criterion.evidence_refs.length === 0;
  })) {
    throw new BuilderBuildRunInputError("evidence.acceptance", "a passing tests-evidence claim requires complete verified acceptance criteria");
  }
  for (const testClaim of testClaims) assertObservedTestsEvidence(testClaim, criteria);
}

function assertObservedTestsEvidence(testClaim: AnyRecord, criteria: AnyRecord[]): void {
  const observed = testClaim.metadata.observed_commands;
  if (!Array.isArray(observed) || observed.length === 0) {
    throw new BuilderBuildRunInputError("evidence.tests.observed_commands", "must contain successful command observations");
  }
  const commands = new Set<string>();
  for (const entry of observed) {
    if (!isRecord(entry) || typeof entry.command !== "string" || entry.exit_code !== 0 || !Number.isSafeInteger(entry.test_count) || Number(entry.test_count) <= 0 || typeof entry.output_sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(entry.output_sha256) || commands.has(entry.command)) {
      throw new BuilderBuildRunInputError("evidence.tests.observed_commands", "must contain unique commands with exit_code 0, a positive executed-test count, and SHA-256 output digests");
    }
    commands.add(entry.command);
  }
  const topRefs = Array.isArray(testClaim.metadata.artifact_refs) ? testClaim.metadata.artifact_refs : [];
  const topCommands = new Set(topRefs.flatMap((ref: unknown) => isRecord(ref) && ref.kind === "command" && typeof ref.excerpt === "string" ? [ref.excerpt.trim()] : []));
  if ([...commands].some((command) => !topCommands.has(command))) {
    throw new BuilderBuildRunInputError("evidence.tests.artifact_refs", "must reference every successful observed command exactly");
  }
  const criterionCommands = new Set<string>();
  for (const claim of criteria) {
    const criterion = claim.metadata.criterion as AnyRecord;
    const refs = Array.isArray(criterion.evidence_refs) ? criterion.evidence_refs : [];
    const matched = refs.flatMap((ref: unknown) => isRecord(ref) && ref.kind === "command" && typeof ref.excerpt === "string" && commands.has(ref.excerpt.trim()) ? [ref.excerpt.trim()] : []);
    if (matched.length === 0) throw new BuilderBuildRunInputError("evidence.acceptance.evidence_refs", `criterion ${String(criterion.id ?? claim.id)} must reference a successful observed command`);
    matched.forEach((command) => criterionCommands.add(command));
  }
  if ([...commands].some((command) => !criterionCommands.has(command))) {
    throw new BuilderBuildRunInputError("evidence.acceptance.evidence_refs", "must bind every successful observed command to at least one criterion");
  }
}

function isSubstantivePassingCritique(claim: AnyRecord): boolean {
  if (claim.value !== "pass" || (Array.isArray(claim.metadata.findings) && claim.metadata.findings.some((finding: unknown) => isRecord(finding) && finding.status === "open"))) return false;
  const lanes = claim.metadata.lanes;
  return Array.isArray(lanes)
    && lanes.length > 0
    && lanes.every((lane) => isRecord(lane) && (lane.status === "pass" || lane.verdict === "pass"))
    && reviewedArtifacts(claim).length > 0;
}

function reviewedArtifacts(claim: AnyRecord): AnyRecord[] {
  const reviewTarget = isRecord(claim.metadata.review_target) ? claim.metadata.review_target : null;
  const artifacts = reviewTarget?.artifacts;
  if (!Array.isArray(artifacts) || artifacts.length === 0) return [];
  if (!artifacts.every((artifact) => isRecord(artifact) && typeof artifact.file === "string" && typeof artifact.sha256 === "string" && /^[a-f0-9]{64}$/i.test(artifact.sha256))) return [];
  return artifacts as AnyRecord[];
}

function assertReviewedWorkspaceSnapshot(claim: AnyRecord, artifacts: AnyRecord[], projectRoot: string): void {
  const reviewTarget = isRecord(claim.metadata.review_target) ? claim.metadata.review_target : null;
  const expected = reviewTarget?.workspace_snapshot;
  if (!isRecord(expected)) {
    throw new BuilderBuildRunInputError("evidence.critique.review_target.workspace_snapshot", "is required for a passing critique");
  }
  const current = captureReviewWorkspaceSnapshot(
    projectRoot,
    expected.kind === "reviewed-files"
      ? reviewedWorkspaceFiles(expected)
      : artifacts.map((artifact) => ({ file: artifact.file as string, sha256: artifact.sha256 as string })),
  );
  if (expected.version !== current.version || expected.kind !== current.kind || expected.algorithm !== current.algorithm) {
    throw new BuilderBuildRunInputError("evidence.critique.review_target.workspace_snapshot", "does not match the current workspace snapshot strategy");
  }
  if (expected.digest !== current.digest) {
    throw new BuilderBuildRunInputError("evidence.critique.review_target.workspace_snapshot.digest", "does not match the current implementation workspace");
  }
  if (current.kind === "git-worktree" && expected.head_sha !== current.head_sha) {
    throw new BuilderBuildRunInputError("evidence.critique.review_target.workspace_snapshot.head_sha", "does not match the current Git HEAD");
  }
  if (current.kind === "reviewed-files" && !isDeepStrictEqual(expected.files, current.files)) {
    throw new BuilderBuildRunInputError("evidence.critique.review_target.workspace_snapshot.files", "does not match the explicitly reviewed files");
  }
}

function gitWorktreeSnapshot(projectRoot: string): AnyRecord | null {
  const root = fs.realpathSync(projectRoot);
  const hasGitMarker = fs.existsSync(path.join(root, ".git"));
  try {
    const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!gitRoot || fs.realpathSync(gitRoot) !== root) {
      throw new BuilderBuildRunInputError("evidence.critique.review_target.workspace_snapshot", "requires the canonical project root to match the Git worktree root");
    }
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const trackedDiff = execFileSync("git", ["diff", "--binary", "--no-ext-diff", "HEAD", "--"], { cwd: root, encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] });
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] })
      .toString("utf8").split("\0").filter(Boolean).sort();
    const hash = createHash("sha256");
    hash.update("flow-agents:git-worktree:v1\0");
    hash.update(headSha).update("\0");
    hash.update(trackedDiff).update("\0");
    for (const file of untracked) {
      const absolute = path.resolve(root, file);
      if (!pathIsWithin(absolute, root)) throw new Error("untracked file escapes repository root");
      const stat = fs.lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("untracked entry is not a regular file");
      hash.update(file).update("\0").update(fs.readFileSync(absolute)).update("\0");
    }
    return { version: 1, kind: "git-worktree", algorithm: "sha256", digest: hash.digest("hex"), head_sha: headSha };
  } catch (error) {
    if (hasGitMarker || error instanceof BuilderBuildRunInputError) {
      if (error instanceof BuilderBuildRunInputError) throw error;
      throw new BuilderBuildRunInputError("evidence.critique.review_target.workspace_snapshot", `could not inspect the Git worktree: ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  }
}

export function captureReviewWorkspaceSnapshot(
  projectRoot: string,
  reviewedFiles: Array<{ file: string; sha256: string }>,
): AnyRecord {
  return gitWorktreeSnapshot(projectRoot) ?? reviewedFilesSnapshot(projectRoot, reviewedFiles);
}

function reviewedWorkspaceFiles(snapshot: AnyRecord): Array<{ file: string; sha256: string }> {
  if (!Array.isArray(snapshot.files) || snapshot.files.length === 0
    || !snapshot.files.every((file) => isRecord(file) && typeof file.file === "string" && /^[a-f0-9]{64}$/i.test(String(file.sha256)))) {
    throw new BuilderBuildRunInputError("evidence.critique.review_target.workspace_snapshot.files", "must list explicitly reviewed files with SHA-256 digests");
  }
  const files = snapshot.files.map((file) => ({ file: file.file as string, sha256: file.sha256 as string })).sort((left, right) => left.file.localeCompare(right.file));
  if (new Set(files.map((file) => file.file)).size !== files.length) {
    throw new BuilderBuildRunInputError("evidence.critique.review_target.workspace_snapshot.files", "must not contain duplicate files");
  }
  return files;
}

function reviewedFilesSnapshot(projectRoot: string, reviewedFiles: Array<{ file: string; sha256: string }>): AnyRecord {
  const files = reviewedFiles.map((file) => ({ ...file }));
  const hash = createHash("sha256");
  hash.update("flow-agents:reviewed-files:v1\0");
  for (const artifact of files) {
    const absolute = safeReviewedArtifactPath(projectRoot, artifact.file);
    hash.update(artifact.file).update("\0").update(fs.readFileSync(absolute)).update("\0");
  }
  return { version: 1, kind: "reviewed-files", algorithm: "sha256", digest: hash.digest("hex"), files };
}

async function assertReviewedArtifactDigest(artifact: AnyRecord, projectRoot: string): Promise<void> {
  const canonicalArtifact = safeReviewedArtifactPath(projectRoot, artifact.file);
  if (createHash("sha256").update(fs.readFileSync(canonicalArtifact)).digest("hex") !== artifact.sha256) {
    throw new BuilderBuildRunInputError("evidence.critique.review_target.artifacts.sha256", `does not match ${artifact.file}`);
  }
}

function safeReviewedArtifactPath(projectRoot: string, file: string): string {
  const canonicalRoot = fs.realpathSync(projectRoot);
  const candidate = path.resolve(canonicalRoot, file);
  const relative = path.relative(canonicalRoot, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new BuilderBuildRunInputError("evidence.critique.review_target.artifacts.file", "must resolve within the canonical project root");
  }
  let canonicalArtifact: string;
  try {
    canonicalArtifact = fs.realpathSync(candidate);
  } catch {
    throw new BuilderBuildRunInputError("evidence.critique.review_target.artifacts.file", `is missing: ${file}`);
  }
  const canonicalRelative = path.relative(canonicalRoot, canonicalArtifact);
  if (canonicalRelative === ".." || canonicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRelative) || !fs.statSync(canonicalArtifact).isFile()) {
    throw new BuilderBuildRunInputError("evidence.critique.review_target.artifacts.file", "must be a regular file within the canonical project root");
  }
  return canonicalArtifact;
}

function stageTrustBundleSnapshot(context: SessionContext): TrustBundleSnapshot {
  assertSafeFile(context.bundleFile, context.sessionDir, "trust.bundle");
  const source = fs.openSync(context.bundleFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let raw: Buffer;
  try {
    const stat = fs.fstatSync(source);
    if (!stat.isFile()) throw new BuilderBuildRunInputError("trust.bundle", "must be a regular file");
    raw = fs.readFileSync(source);
  } finally {
    fs.closeSync(source);
  }
  const directory = path.join(context.sessionDir, ".trust-bundle-snapshots");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertSafeDirectory(directory, context.sessionDir, "trust.bundle snapshot directory");
  fs.chmodSync(directory, 0o700);
  const file = path.join(directory, `${randomBytes(16).toString("hex")}.json`);
  const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(descriptor, raw);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(file, 0o400);
  return { file, raw, sha256: createHash("sha256").update(raw).digest("hex") };
}

function removeTrustBundleSnapshot(snapshot: TrustBundleSnapshot): void {
  try {
    fs.unlinkSync(snapshot.file);
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") throw error;
  }
  try {
    fs.rmdirSync(path.dirname(snapshot.file));
  } catch (error) {
    if (!isRecord(error) || (error.code !== "ENOENT" && error.code !== "ENOTEMPTY")) throw error;
  }
}

function workflowSubjectRef(claim: AnyRecord): string | null {
  const metadata = isRecord(claim.metadata) ? claim.metadata : null;
  return metadata && typeof metadata.workflow_subject_ref === "string"
    ? metadata.workflow_subject_ref
    : null;
}

function manifestEvidence(manifest: JsonObject): AnyRecord[] {
  return Array.isArray(manifest.evidence) ? manifest.evidence.filter(isRecord) : [];
}

function projectFlowRun(context: SessionContext, run: BuilderFlowRunResult, sidecar: AnyRecord): { projection: AnyRecord; gateActionEnvelope: GateActionEnvelope | null; progressSnapshot: GateActionProgressSnapshot } {
  const definition = JSON.parse(fs.readFileSync(path.join(run.dir, "definition.json"), "utf8"));
  const gates = openGates(definition, run.state) as Array<FlowGate & { id: string }>;
  const complete = run.state.status === "completed";
  const paused = run.state.status === "paused";
  const canceled = run.state.status === "canceled";
  const needsDecision = run.state.status === "needs_decision";
  const failed = run.state.status === "failed";
  const progressSnapshot = deriveBuilderGateActionProgressSnapshot({
    sessionDir: context.sessionDir,
    projectRoot: context.projectRoot,
    run,
    definition: definition as AnyRecord,
  });
  const envelope = complete || paused || canceled || needsDecision || failed
    ? null
    : deriveBuilderGateActionEnvelope({
        sessionDir: context.sessionDir,
        projectRoot: context.projectRoot,
        run,
        definition: definition as AnyRecord,
      });
  const action = envelope ? {
    skills: envelope.action.skills.map((skill) => skill.id),
    operations: envelope.action.operations,
  } : { skills: [], operations: [] };
  const required = gates.flatMap((gate) => (expectationsForGate(gate, run.config) as FlowExpectation[])
    .filter((expectation: FlowExpectation) => expectation.required)
    .map((expectation: FlowExpectation) => `${expectation.id} (${expectation.bundle_claim.claimType}/${expectation.bundle_claim.subjectType ?? "any"})`));
  const skills = action.skills;
  const operations = action.operations;
  const syncCommand = pinnedFlowAgentsCommand(flowAgentsPackageVersion(), ["workflow", "status", "--session-dir", `.kontourai/flow-agents/${context.slug}`, "--json"]);
  const routeBack = latestRouteBack(run.state);
  const externalCapability = envelope?.stop_condition.external_capability;
  const skillText = skills.length ? `Activate ${skills.map((skill) => `\`${skill}\``).join(" then ")}.` : "No Builder skill is required.";
  const operationText = operations.length ? ` Perform ${operations.map((operation) => `\`${operation}\``).join(" then ")}.` : "";
  const gateText = gates.length
    ? `Complete ${gates.map((gate) => `\`${gate.id}\``).join(", ")} by recording: ${required.join(", ") || "its declared evidence"}.`
    : "No Flow gate is open.";
  const routeText = routeBack
    ? ` Route-back history: attempt ${routeBack.attempt ?? "n/a"}${routeBack.max_attempts ? `/${routeBack.max_attempts}` : ""} returned to \`${routeBack.route_back_to ?? "an earlier step"}\`${routeBack.route_reason ? ` for \`${routeBack.route_reason}\`` : ""}.`
    : "";
  const nextAction = complete
    ? { status: "done", summary: "Canonical Flow run is complete." }
    : canceled
      ? { status: "done", summary: "Canonical Flow run was canceled by an authorized external request. Artifacts are retained until separately archived." }
      : paused
        ? { status: "blocked", summary: "Canonical Flow run is paused. The current assignment actor may resume it with a reason." }
      : needsDecision
        ? { status: "blocked", summary: "Canonical Flow requires an external decision before continuation." }
      : failed
        ? { status: "failed", summary: "Canonical Flow run failed; no continuation turn is allowed." }
      : externalCapability
        ? {
            status: "blocked",
            summary: `Flow step \`${run.state.current_step}\` is waiting for external capability \`${externalCapability.capability}\`. Flow Agents has no authenticated executor and cannot record provider completion.`,
            skills,
            operations,
            external_capability: externalCapability,
          }
    : {
        status: "continue",
        summary: `Flow step \`${run.state.current_step}\`: ${skillText}${operationText} ${gateText}${routeText} Then synchronize the recorded evidence.`,
        skills,
        operations,
        command: syncCommand,
      };
  const phase = phaseForStep(definition.phase_map, run.state.current_step) ?? sidecar.phase;
  return { gateActionEnvelope: envelope, progressSnapshot, projection: {
    ...sidecar,
    status: complete ? "delivered" : canceled ? "canceled" : failed ? "failed" : (paused || needsDecision) ? "blocked" : (run.state.transitions.length > 0 ? "in_progress" : sidecar.status),
    phase: complete || canceled || failed ? "done" : phase,
    updated_at: run.state.updated_at,
    flow_run: {
      run_id: run.runId,
      definition_id: run.definitionId,
      definition_version: run.definitionVersion,
      status: run.state.status,
      current_step: run.state.current_step,
      run_ref: path.relative(context.projectRoot, run.dir),
      open_gate_ids: gates.map((gate) => gate.id),
      ...(typeof routeBack?.attempt === "number" ? { route_back_attempt: routeBack.attempt } : {}),
      ...(typeof routeBack?.max_attempts === "number" ? { route_back_max_attempts: routeBack.max_attempts } : {}),
    },
    next_action: nextAction,
  } };
}

function writeProjection(context: SessionContext, projection: AnyRecord, expectedStateRaw: string, operation: string): void {
  const prepared = prepareProjectionWrites(context, projection, expectedStateRaw, operation);
  assertProjectionTargetsUnchanged(context, prepared, operation);
  for (const write of prepared.writes) writeExistingFileNoFollow(write.file, write.content);
}

function prepareProjectionWrites(
  context: SessionContext,
  projection: AnyRecord,
  expectedStateRaw: string,
  operation: string,
): PreparedProjectionWrites {
  const targets: ProjectionTargetSnapshot[] = [];
  const writes: Array<{ file: string; content: string }> = [];
  const stateTarget = readProjectionTarget(context.stateFile, context.sessionDir, "state.json");
  targets.push(stateTarget);
  if (stateTarget.raw !== expectedStateRaw) {
    throw new BuilderBuildRunInputError("state.json", `changed during ${operation}`);
  }
  writes.push({ file: context.stateFile, content: `${JSON.stringify(projection, null, 2)}\n` });

  const pointerFiles: string[] = [];
  const globalPointer = path.join(context.artifactRoot, "current.json");
  const globalTarget = readOptionalProjectionTarget(globalPointer, context.artifactRoot, "current.json");
  targets.push(globalTarget);
  if (globalTarget.raw !== null) pointerFiles.push(globalPointer);

  const actorRoot = path.join(context.artifactRoot, "current");
  let actorEntries: string[] | null = null;
  if (pathExistsNoFollow(actorRoot)) {
    assertSafeDirectory(actorRoot, context.artifactRoot, "current directory");
    actorEntries = fs.readdirSync(actorRoot).sort();
    for (const name of actorEntries) {
      const file = path.join(actorRoot, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) {
        throw new BuilderBuildRunInputError("projection target", `current/${name} must not be a symbolic link`);
      }
      if (!name.endsWith(".json")) continue;
      if (!stat.isFile()) {
        throw new BuilderBuildRunInputError("projection target", `current/${name} must be a regular file`);
      }
      const target = readProjectionTarget(file, actorRoot, `current/${name}`);
      targets.push(target);
      pointerFiles.push(file);
    }
  }

  for (const file of pointerFiles) {
    const target = targets.find((candidate) => candidate.file === file)!;
    const pointer = parseProjectionTarget(target);
    if (!isRecord(pointer) || pointer.active_slug !== context.slug) continue;
    const output = {
      ...pointer,
      active_flow_id: projection.flow_run.definition_id,
      active_step_id: projection.flow_run.current_step,
      updated_at: projection.updated_at,
    };
    writes.push({ file, content: `${JSON.stringify(output, null, 2)}\n` });
  }
  return { targets, actorEntries, writes };
}

function assertProjectionTargetsUnchanged(
  context: SessionContext,
  prepared: PreparedProjectionWrites,
  operation: string,
): void {
  const actorRoot = path.join(context.artifactRoot, "current");
  const currentActorEntries = pathExistsNoFollow(actorRoot)
    ? (assertSafeDirectory(actorRoot, context.artifactRoot, "current directory"), fs.readdirSync(actorRoot).sort())
    : null;
  if (JSON.stringify(currentActorEntries) !== JSON.stringify(prepared.actorEntries)) {
    throw new BuilderBuildRunInputError("current", `directory changed during ${operation}`);
  }
  for (const target of prepared.targets) {
    const current = readOptionalProjectionTarget(target.file, target.root, target.field);
    if (current.raw !== target.raw) {
      throw new BuilderBuildRunInputError(target.field, `changed during ${operation}`);
    }
  }
}

function readOptionalProjectionTarget(file: string, root: string, field: string): ProjectionTargetSnapshot {
  if (!pathExistsNoFollow(file)) return { file, raw: null, root, field };
  return readProjectionTarget(file, root, field);
}

function readProjectionTarget(file: string, root: string, field: string): ProjectionTargetSnapshot {
  assertSafeFile(file, root, field);
  return { file, raw: fs.readFileSync(file, "utf8"), root, field };
}

function parseProjectionTarget(target: ProjectionTargetSnapshot): unknown {
  try {
    return JSON.parse(target.raw!);
  } catch (error) {
    throw new BuilderBuildRunInputError("projection target", `${target.field} must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertSafeDirectory(directory: string, root: string, field: string): void {
  if (!pathExistsNoFollow(directory)) {
    throw new BuilderBuildRunInputError(field, "must exist");
  }
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink()) {
    throw new BuilderBuildRunInputError(field, "must not be a symbolic link");
  }
  if (!stat.isDirectory()) {
    throw new BuilderBuildRunInputError(field, "must be a directory");
  }
  assertContainedPath(directory, root, field);
}

function pathExistsNoFollow(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function assertSafeFile(file: string, root: string, field: string): void {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) {
    throw new BuilderBuildRunInputError(field, "must not be a symbolic link");
  }
  if (!stat.isFile()) {
    throw new BuilderBuildRunInputError(field, "must be a regular file");
  }
  assertContainedPath(file, root, field);
}

function assertContainedPath(candidate: string, root: string, field: string): void {
  if (!pathIsWithin(candidate, root)) {
    throw new BuilderBuildRunInputError(field, "must remain within its expected artifact root");
  }
  const realCandidate = fs.realpathSync(candidate);
  const realRoot = fs.realpathSync(root);
  if (!pathIsWithin(realCandidate, realRoot)) {
    throw new BuilderBuildRunInputError(field, "must not escape its expected artifact root");
  }
}

function pathIsWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function writeExistingFileNoFollow(file: string, content: string): void {
  const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW);
  try {
    fs.writeFileSync(descriptor, content);
  } finally {
    fs.closeSync(descriptor);
  }
}

function phaseForStep(phaseMap: unknown, stepId: string): string | null {
  if (!isRecord(phaseMap)) return stepId === "design-probe" ? "pickup" : null;
  return Object.entries(phaseMap).find(([, step]) => step === stepId)?.[0] ?? (stepId === "design-probe" ? "pickup" : null);
}

function latestRouteBack(state: FlowRunState): AnyRecord | null {
  const outcomes = Array.isArray(state.gate_outcomes) ? state.gate_outcomes : [];
  return [...outcomes].reverse().find((outcome) => isRecord(outcome) && outcome.status === "route-back") ?? null;
}

function isRunNotFound(error: unknown): boolean {
  return isRecord(error) && (
    error.code === "flow.run_location.not_found"
    || (typeof error.message === "string" && error.message.includes("flow.run_location.not_found"))
  );
}

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
