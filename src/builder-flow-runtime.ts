import * as fs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { flowAgentsPackageVersion } from "./lib/package-version.js";
import { pinnedFlowAgentsCommand } from "./lib/pinned-cli-command.js";
import { deriveBuilderGateActionEnvelope, deriveBuilderGateActionProgressSnapshot, type GateActionEnvelope, type GateActionProgressSnapshot } from "./builder-gate-action-envelope.js";
import {
  evaluateGate,
  expectationsForGate,
  openGates,
  type FlowGate,
  type FlowExpectation,
  type FlowRunState,
  type JsonObject,
} from "@kontourai/flow";
import { buildUnsignedLifecycleAuthorization, type BuilderLifecycleAuthorization } from "./builder-lifecycle-authority.js";
import { captureReviewWorkspaceSnapshot } from "./lib/review-workspace-snapshot.js";
export { captureReviewWorkspaceSnapshot } from "./lib/review-workspace-snapshot.js";
import { invokeExternalLifecycleAuthority, lifecycleAuthorityResultDigest, verifyLifecycleAuthorityCompletion, type ExternalLifecycleMutationResult } from "./external-lifecycle-authority.js";
import { assignmentFilePath, performLocalReleaseUnderLock, readLocalAssignmentStatus, resolveCurrentAssignmentActor, withSubjectLockAsync, type ActorStruct } from "./cli/assignment-provider.js";
import { validateCritiqueResolutionGraph } from "./cli/critique-resolution.js";
import { resolveEffectiveChangeProviderSettings } from "./cli/effective-change-provider-settings.js";
import { createGithubChangeProvider, resolveTrustedGithubExecutable } from "./cli/github-change-provider.js";
import type { ChangeProviderRequest } from "./cli/change-provider.js";
import type { ChangeProviderSettings } from "./cli/public-contracts.js";
import { execTrustedGitSync, resolveTrustedLocalGitCommit } from "./lib/trusted-git.js";
import { buildTrustBundle, validateTrustBundle } from "./cli/workflow-sidecar.js";
import {
  assertAuthenticatedPublishChangeObservation,
  assertIssuedPublishChangeAction,
  issuePublishChangeAction,
  type AuthenticatedPublishChangeObservation,
  type IssuedPublishChangeAction,
  type PublishChangeIntent,
} from "./publish-change-operation-authority.js";
import {
  BUILDER_BUILD_FLOW_ID,
  type BuilderFlowId,
  BuilderBuildRunInputError,
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

export interface ExecutePublishChangeOperationInput extends BuilderFlowSessionInput {
  intent: PublishChangeIntent;
}

export interface CompletePublishChangeOperationInput extends BuilderFlowSessionInput {
  /**
   * An action previously derived by issuePublishChangeOperation. This is not a
   * caller-authored result: the transaction re-derives it under the subject lock.
   */
  action: IssuedPublishChangeAction;
}

export interface CompletePublishChangeOperationResult extends BuilderFlowSessionResult {
  action: IssuedPublishChangeAction;
  observation: AuthenticatedPublishChangeObservation;
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

/**
 * Private operation issuance seam for the Wave 3 command. It derives the full
 * action from canonical state and effective configuration; no public workflow
 * writer or caller-provided result is involved.
 */
async function issuePublishChangeOperation(input: ExecutePublishChangeOperationInput): Promise<IssuedPublishChangeAction> {
  const context = resolveSessionContext(input.sessionDir);
  return await withSubjectLockAsync(context.artifactRoot, context.slug, async () => await currentPublishChangeAction(context, input.intent));
}

/**
 * The sole production publish-change mutation surface. The caller supplies
 * intent, never an adapter or a provider-shaped observation. Configuration and
 * authenticated provider identity are resolved inside the operation.
 */
export async function executePublishChangeOperation(input: ExecutePublishChangeOperationInput): Promise<CompletePublishChangeOperationResult> {
  resolveTrustedGithubExecutable();
  const context = resolveSessionContext(input.sessionDir);
  const trustedHeadSha = resolveTrustedLocalGitCommit(context.projectRoot, input.intent.head_ref);
  if (trustedHeadSha !== input.intent.head_sha.toLowerCase()) {
    throw new BuilderBuildRunInputError("publish-change.intent.head_sha", "does not match the trusted local head ref");
  }
  const action = await issuePublishChangeOperation(input);
  const effective = resolveEffectiveChangeProviderSettings(
    context.projectRoot,
    path.join(context.projectRoot, "context", "settings", "change-provider-settings.json"),
  );
  if (effective.status !== "configured" || !effective.provider || typeof effective.provider !== "object") {
    throw new Error("publish-change execute requires a configured ChangeProvider for this repository");
  }
  const provider = createGithubChangeProvider(effective.provider as ChangeProviderSettings, action.provider.configuration_id);
  return await completePublishChangeOperation({ sessionDir: input.sessionDir, action }, async (issued) => {
    const { action_id: _actionId, ...request } = issued;
    return await provider.createOrRecover(request as ChangeProviderRequest);
  });
}

async function completePublishChangeOperation(
  input: CompletePublishChangeOperationInput,
  observe: (request: IssuedPublishChangeAction) => AuthenticatedPublishChangeObservation | Promise<AuthenticatedPublishChangeObservation>,
): Promise<CompletePublishChangeOperationResult> {
  const context = resolveSessionContext(input.sessionDir);
  const issued = assertIssuedPublishChangeAction(input.action);
  // Validate before invoking a mutating provider, but never retain the subject
  // lock across network I/O. The commit phase revalidates after observation.
  await withSubjectLockAsync(context.artifactRoot, context.slug, async () => {
    await assertPublishChangeActionCurrentOrRecoverable(context, issued);
  });
  const observation = assertAuthenticatedPublishChangeObservation(issued, await observe(structuredClone(issued)));
  return await withSubjectLockAsync(context.artifactRoot, context.slug, async () => {
    const trustedHeadSha = resolveTrustedLocalGitCommit(context.projectRoot, issued.head_ref);
    if (trustedHeadSha !== issued.head_sha.toLowerCase()) {
      throw new BuilderBuildRunInputError("publish-change.action.head_sha", "does not match the trusted local head ref during commit");
    }
    const recovery = await recoverPublishChangeIfCommitted(context, issued, observation);
    if (recovery) return recovery;
    const current = await currentPublishChangeAction(context, publishChangeIntentFromAction(issued));
    if (!isDeepStrictEqual(current, issued)) {
      throw new BuilderBuildRunInputError("publish-change.action", "does not match the current canonical run, gate visit, assignment actor, or provider configuration");
    }
    const persisted = persistPublishChangeResult(context, issued, observation);
    const run = await advancePublishChangeGate(context, issued, observation, persisted.sha256);
    return projectCompletedPublishChange(context, issued, observation, run);
  });
}

/** Reject stale actions before they can reach a mutating provider. */
async function assertPublishChangeActionCurrentOrRecoverable(
  context: SessionContext,
  issued: IssuedPublishChangeAction,
): Promise<void> {
  try {
    const current = await currentPublishChangeAction(context, publishChangeIntentFromAction(issued));
    if (!isDeepStrictEqual(current, issued)) {
      throw new BuilderBuildRunInputError("publish-change.action", "does not match the current canonical run, gate visit, assignment actor, or provider configuration");
    }
    return;
  } catch (error) {
    if (!await hasCommittedPublishChangeRecoveryReceipt(context, issued)) throw error;
  }
}

async function recoverPublishChangeIfCommitted(
  context: SessionContext,
  issued: IssuedPublishChangeAction,
  observation: AuthenticatedPublishChangeObservation,
): Promise<CompletePublishChangeOperationResult | null> {
  if (!await hasCommittedPublishChangeRecoveryReceipt(context, issued)) return null;
  return await recoverCommittedPublishChange(context, issued, observation);
}

function publishChangeIntentFromAction(action: IssuedPublishChangeAction): PublishChangeIntent {
  return {
    title: action.intent.title,
    body: action.intent.body,
    ...(action.intent.draft === undefined ? {} : { draft: action.intent.draft }),
    base_ref: action.base_ref,
    head_ref: action.head_ref,
    head_sha: action.head_sha,
  };
}

/** Phase 3: attach exactly the operation-bound claim and require gate advance. */
async function advancePublishChangeGate(
  context: SessionContext,
  issued: IssuedPublishChangeAction,
  observation: AuthenticatedPublishChangeObservation,
  resultSha256: string,
): Promise<BuilderFlowRunResult> {
  const evidenceFile = await writePublishChangeEvidence(context, issued, observation, resultSha256);
  try {
    const run = await evaluateBuilderFlowRun({
      cwd: context.projectRoot,
      runId: context.slug,
      evidence: {
        gate: issued.binding.gate_ids[0]!,
        file: path.relative(context.projectRoot, evidenceFile.file),
        expectedSha256: evidenceFile.sha256,
        expectationIds: ["pull-request-opened"],
        producer: "publish-change-operation-authority",
        authorityTrace: issued.action_id,
      },
    });
    if (run.state.current_step === issued.binding.step_id && run.state.status === "active") {
      throw new BuilderBuildRunInputError("publish-change", "authenticated provider observation did not advance the bound Flow gate");
    }
    return run;
  } finally {
    removeTemporaryFile(evidenceFile.file);
  }
}

/** Phase 4: project only a successfully advanced canonical Flow run. */
function projectCompletedPublishChange(
  context: SessionContext,
  action: IssuedPublishChangeAction,
  observation: AuthenticatedPublishChangeObservation,
  run: BuilderFlowRunResult,
): CompletePublishChangeOperationResult {
  const sidecarSnapshot = readSidecarSnapshot(context);
  const { projection, gateActionEnvelope, progressSnapshot } = projectFlowRun(context, run, sidecarSnapshot.state);
  writeProjection(context, projection, sidecarSnapshot.raw, "publish-change completion");
  return { sessionDir: context.sessionDir, projectRoot: context.projectRoot, run, projection, gateActionEnvelope, progressSnapshot, attached: true, action, observation };
}

async function hasCommittedPublishChangeRecoveryReceipt(context: SessionContext, action: IssuedPublishChangeAction): Promise<boolean> {
  const bytes = readPublishChangeResultBytes(context);
  if (!bytes) return false;
  try {
    const persisted = JSON.parse(bytes.toString("utf8")) as AnyRecord;
    if (persisted.operation_action_id !== action.action_id) return false;
  } catch {
    return false;
  }
  const resultDigest = createHash("sha256").update(bytes).digest("hex");
  const run = await loadBuilderFlowRun({ cwd: context.projectRoot, runId: context.slug });
  return manifestEvidence(run.manifest).some((entry) => entry.gate_id === action.binding.gate_ids[0]
    && entry.producer === "publish-change-operation-authority"
    && entry.authority_trace === action.action_id
    && Array.isArray(entry.expectation_ids) && entry.expectation_ids.length === 1
    && entry.expectation_ids[0] === "pull-request-opened"
    && publishChangeEvidenceCarriesDigest(entry, resultDigest));
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

export async function cancelBuilderFlowSession(input: BuilderFlowAuthorizedLifecycleInput): Promise<ExternalLifecycleMutationResult> {
  const context = resolveSessionContext(input.sessionDir);
  return invokeExternalLifecycleAuthority({ action: "cancel", project_root: context.projectRoot, session_dir: context.sessionDir, authorization_file: path.resolve(input.authorizationFile) });
}

export interface BuilderCancelRequestInput extends BuilderFlowSessionInput {
  /** Free-text reason recorded in the authorization request. */
  reason?: string;
  /** Human/operator identity recorded as request.authority.actor. */
  requestActor?: string;
  /** Validity window for the emitted authorization (default 24h). */
  expiresInHours?: number;
  /** Override the request timestamp (tests); defaults to now. */
  now?: string;
  /** Override the nonce (tests); defaults to a fresh unique value. */
  nonce?: string;
}

export interface BuilderCancelRequestResult {
  runId: string;
  subject: string;
  runStatus: string;
  /** True when the run is already terminal (cancel would be idempotent/no-op). */
  alreadyTerminal: boolean;
  /** The unsigned, ready-to-sign authorization (schema-valid, canonical order). */
  authorization: Omit<BuilderLifecycleAuthorization, "signature">;
  /** The exact bytes the operator must sign; a signature over these verifies. */
  signingPayload: string;
  /** Where the CLI writes the unsigned authorization by default. */
  suggestedOutFile: string;
}

/**
 * Generate a ready-to-sign cancel authorization for a run (#659 Slice C).
 *
 * READ-ONLY: this mints the *unsigned* payload (correct run identity, active
 * assignment holder, fresh nonce/expiry) so an operator no longer has to
 * hand-assemble the JSON. It does NOT sign, cancel, or mutate anything — the
 * ed25519 signature lock is fully preserved; the operator still signs
 * `signingPayload` with their key, and `builder-run cancel --authorization-file`
 * verifies it as before.
 */
export async function prepareBuilderCancelRequest(input: BuilderCancelRequestInput): Promise<BuilderCancelRequestResult> {
  const context = resolveSessionContext(input.sessionDir);
  const sidecarSnapshot = readSidecarSnapshot(context);
  const subject = workflowSubject(sidecarSnapshot.state);
  const canonicalRun = await loadBuilderFlowRun({ cwd: context.projectRoot, runId: context.slug });
  const terminalStatuses = ["canceled", "completed", "archived"];
  const alreadyTerminal = terminalStatuses.includes(canonicalRun.state.status);

  const activeAssignment = readLocalAssignmentStatus(context.artifactRoot, context.slug).record;
  const assignmentFile = assignmentFilePath(context.artifactRoot, context.slug);
  const persistedAssignment = pathExistsNoFollow(assignmentFile)
    ? JSON.parse(fs.readFileSync(assignmentFile, "utf8")) as AnyRecord
    : null;
  // When the run is already canceled, its assignment is released — accept the
  // persisted holder so an operator can still mint a (recovery) authorization.
  // Mirror prepareAuthorizedLifecycleChange's redemption gate EXACTLY so we never
  // mint an authorization the real cancel would reject: a cancel may reuse a
  // released assignment only when the run is already `canceled` (idempotent
  // recovery) and the persisted record's status is `released`. A completed or
  // archived run with no active holder is not cancel-redeemable, so refuse.
  const acceptsReleasedAssignment = canonicalRun.state.status === "canceled";
  const assignment = activeAssignment
    ?? (acceptsReleasedAssignment && persistedAssignment?.status === "released" ? persistedAssignment : null);
  if (!assignment || !assignment.actor_key || !assignment.actor) {
    throw new BuilderBuildRunInputError("assignment", "the run has no assignment holder to authorize a cancel against");
  }

  const now = input.now ? new Date(input.now) : new Date();
  if (!Number.isFinite(now.getTime())) throw new BuilderBuildRunInputError("now", "must be a valid date-time");
  const requestedAt = now.toISOString();
  const hours = input.expiresInHours && input.expiresInHours > 0 ? input.expiresInHours : 24;
  const expiresAt = new Date(now.getTime() + hours * 3_600_000).toISOString();
  const nonce = input.nonce ?? `cancel-request-${context.slug}-${now.getTime()}-${randomBytes(6).toString("hex")}`;

  const { unsigned, signingPayload } = buildUnsignedLifecycleAuthorization({
    operation: "cancel",
    project_root: context.projectRoot,
    run_id: context.slug,
    subject,
    assignment_actor_key: assignment.actor_key as string,
    assignment_actor: assignment.actor,
    nonce,
    expires_at: expiresAt,
    request: {
      reason: (input.reason && input.reason.trim()) || `Operator-requested cancellation of run ${context.slug}.`,
      authority: {
        kind: "user_request",
        actor: (input.requestActor && input.requestActor.trim()) || "operator",
        request_ref: `flow-agents://cancel-request/${context.slug}/${now.getTime()}`,
        requested_at: requestedAt,
      },
    },
  });

  return {
    runId: context.slug,
    subject,
    runStatus: canonicalRun.state.status,
    alreadyTerminal,
    authorization: unsigned,
    signingPayload,
    suggestedOutFile: path.join(context.sessionDir, "cancel.authorization.unsigned.json"),
  };
}

export async function releaseBuilderFlowAssignment(input: BuilderFlowAgentLifecycleInput): Promise<BuilderFlowSessionResult & { assignmentReleased: boolean }> {
  const context = resolveSessionContext(input.sessionDir);
  return await withSubjectLockAsync(context.artifactRoot, context.slug, async () => {
    const prepared = prepareAgentLifecycleChange(input, context);
    const run = await loadBuilderFlowRun({ cwd: context.projectRoot, runId: context.slug });
    const released = performLocalReleaseUnderLock(context.artifactRoot, context.slug, prepared.actor, { actorKey: prepared.actorKey, reason: input.reason });
    const { progressSnapshot } = projectFlowRun(context, run, prepared.sidecarSnapshot.state);
    return { sessionDir: context.sessionDir, projectRoot: context.projectRoot, run, projection: prepared.sidecarSnapshot.state, gateActionEnvelope: null, progressSnapshot, attached: false, assignmentReleased: released !== null };
  });
}

export async function archiveBuilderFlowSession(input: BuilderFlowAuthorizedLifecycleInput): Promise<ExternalLifecycleMutationResult> {
  const context = resolveSessionContext(input.sessionDir);
  return invokeExternalLifecycleAuthority({ action: "archive", project_root: context.projectRoot, session_dir: context.sessionDir, authorization_file: path.resolve(input.authorizationFile) });
}

async function changeBuilderFlowSessionLifecycle(
  input: BuilderFlowAgentLifecycleInput,
  operation: "pause" | "resume",
): Promise<BuilderFlowSessionResult> {
  const context = resolveSessionContext(input.sessionDir);
  return await withSubjectLockAsync(context.artifactRoot, context.slug, async () => {
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

async function syncAndProject(
  context: SessionContext,
  initial: BuilderFlowRunResult,
  sidecarSnapshot: SidecarSnapshot,
): Promise<BuilderFlowSessionResult> {
  let run = initial;
  assertLifecycleResolutionAttestation(context, run);
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
        context.sessionDir,
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
  assertLifecycleResolutionAttestation(context, run);
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

function assertLifecycleResolutionAttestation(context: SessionContext, run: BuilderFlowRunResult): void {
  const attachments = manifestEvidence(run.manifest).filter((entry) => typeof entry.id === "string" && entry.id.startsWith("lifecycle-authority:") && typeof entry.superseded_by !== "string");
  if (attachments.length === 0) return;
  if (attachments.length !== 1) throw new BuilderBuildRunInputError("flow_run.lifecycle_authority", "must have exactly one live lifecycle resolution attachment");
  const storedPath = attachments[0]!.stored_path;
  if (typeof storedPath !== "string") throw new BuilderBuildRunInputError("flow_run.lifecycle_authority", "must identify its immutable Flow evidence");
  const evidenceFile = path.resolve(run.dir, storedPath);
  assertSafeFile(evidenceFile, run.dir, "lifecycle authority Flow evidence");
  const evidenceBytes = fs.readFileSync(evidenceFile);
  if (typeof attachments[0]!.sha256 !== "string" || createHash("sha256").update(evidenceBytes).digest("hex") !== attachments[0]!.sha256) {
    throw new BuilderBuildRunInputError("flow_run.lifecycle_authority", "immutable Flow evidence digest does not match its manifest");
  }
  const bundle = JSON.parse(evidenceBytes.toString("utf8"));
  if (!isRecord(bundle) || !Array.isArray(bundle.claims)) throw new BuilderBuildRunInputError("flow_run.lifecycle_authority", "must attach a trust bundle");
  const authority = verifiedResolutionAuthority(bundle, context.sessionDir);
  const graph = validateCritiqueResolutionGraph(bundle.claims as AnyRecord[], run.state.subject, authority.events, context.projectRoot, authority.verified);
  if (!graph.valid) throw new BuilderBuildRunInputError("flow_run.lifecycle_authority", graph.errors.join("; "));
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

async function currentPublishChangeAction(context: SessionContext, intent: PublishChangeIntent): Promise<IssuedPublishChangeAction> {
  const sidecarSnapshot = readSidecarSnapshot(context);
  const subject = workflowSubject(sidecarSnapshot.state);
  const run = await loadBuilderFlowRun({ cwd: context.projectRoot, runId: context.slug });
  assertRunSubjectBinding(run, subject);
  const gates = openGatesForResult(run);
  if (run.state.status !== "active" || gates.length !== 1) throw new BuilderBuildRunInputError("publish-change", "requires exactly one active canonical gate");
  const envelope = deriveBuilderGateActionEnvelope({ sessionDir: context.sessionDir, projectRoot: context.projectRoot, run, definition: JSON.parse(fs.readFileSync(path.join(run.dir, "definition.json"), "utf8")) as AnyRecord });
  const operation = envelope.public_interfaces.mutations.find((mutation): mutation is Extract<GateActionEnvelope["public_interfaces"]["mutations"][number], { interface: "operation" }> => mutation.interface === "operation" && mutation.operation === "publish-change");
  if (!operation || operation.expectation_id !== "pull-request-opened" || operation.protocol.availability.status !== "configured") {
    throw new BuilderBuildRunInputError("publish-change", "requires the configured canonical publish-change operation at pull-request-opened");
  }
  const effective = resolveEffectiveChangeProviderSettings(
    context.projectRoot,
    path.join(context.projectRoot, "context", "settings", "change-provider-settings.json"),
  );
  if (effective.status !== "configured" || !effective.provider || typeof effective.provider !== "object") {
    throw new BuilderBuildRunInputError("publish-change.provider", "is not configured for this project");
  }
  const assignment = readLocalAssignmentStatus(context.artifactRoot, context.slug);
  const actor = resolveCurrentAssignmentActor();
  if (!assignment.record || assignment.record.status !== "claimed" || (assignment.record.actor_key ?? assignment.assignee) !== actor.actorKey) {
    throw new BuilderBuildRunInputError("publish-change.assignment", "is no longer held by the current actor");
  }
  return issuePublishChangeAction({ binding: operation.binding, provider: effective.provider as any, assignment_actor: actor.actorKey, intent });
}

function persistPublishChangeResult(
  context: SessionContext,
  action: IssuedPublishChangeAction,
  observation: AuthenticatedPublishChangeObservation,
): { file: string; sha256: string } {
  const file = path.join(context.sessionDir, "publish-change.result.json");
  const payload = Buffer.from(`${JSON.stringify({ ...observation, operation_action_id: action.action_id }, null, 2)}\n`);
  if (payload.byteLength > 65_536) throw new BuilderBuildRunInputError("publish-change.result", "exceeds the 65,536 byte operation bound");
  const existing = readPublishChangeResultBytes(context);
  if (existing) {
    if (!existing.equals(payload) && !sameObservedPublishChangeResult(existing, payload, action.action_id)) {
      throw new BuilderBuildRunInputError("publish-change.result", "already exists with different authenticated operation bytes");
    }
    if (existing.equals(payload)) return { file, sha256: createHash("sha256").update(existing).digest("hex") };
    // An interrupted attempt may have fsynced a valid observation before Flow
    // committed its evidence. Never retain those unauthenticated local bytes:
    // atomically replace them with this attempt's fresh provider observation.
    const temporary = path.join(context.sessionDir, `.publish-change.result-${randomBytes(16).toString("hex")}.tmp`);
    const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.writeFileSync(descriptor, payload);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    try {
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    assertSafeFile(file, context.sessionDir, "publish-change.result.json");
    return { file, sha256: createHash("sha256").update(payload).digest("hex") };
  }
  const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(descriptor, payload);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  assertSafeFile(file, context.sessionDir, "publish-change.result.json");
  return { file, sha256: createHash("sha256").update(payload).digest("hex") };
}

function readPublishChangeResultBytes(context: SessionContext): Buffer | null {
  const result = path.join(context.sessionDir, "publish-change.result.json");
  if (!pathExistsNoFollow(result)) return null;
  assertSafeFile(result, context.sessionDir, "publish-change.result.json");
  const descriptor = fs.openSync(result, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new BuilderBuildRunInputError("publish-change.result", "must be a regular file");
    if (stat.size > 65_536) throw new BuilderBuildRunInputError("publish-change.result", "exceeds the 65,536 byte operation bound");
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

/** A retry must re-observe the provider, but observation timestamps naturally differ. */
function sameObservedPublishChangeResult(existing: Buffer, current: Buffer, actionId: string): boolean {
  try {
    const left = JSON.parse(existing.toString("utf8")) as AnyRecord;
    const right = JSON.parse(current.toString("utf8")) as AnyRecord;
    if (left.operation_action_id !== actionId || right.operation_action_id !== actionId) return false;
    delete left.observed_at;
    delete right.observed_at;
    return isDeepStrictEqual(left, right);
  } catch {
    return false;
  }
}

function publishChangeEvidenceCarriesDigest(entry: AnyRecord, digest: string): boolean {
  if (!isRecord(entry.bundle) || !Array.isArray(entry.bundle.claims)) return false;
  return entry.bundle.claims.some((claim: unknown) => {
    if (!isRecord(claim) || !isRecord(claim.metadata) || !Array.isArray(claim.metadata.artifact_refs)) return false;
    return claim.metadata.artifact_refs.some((ref: unknown) => isRecord(ref)
      && ref.kind === "provider"
      && typeof ref.sha256 === "string"
      && ref.sha256.toLowerCase() === digest);
  });
}

async function recoverCommittedPublishChange(
  context: SessionContext,
  action: IssuedPublishChangeAction,
  observation: AuthenticatedPublishChangeObservation,
): Promise<CompletePublishChangeOperationResult | null> {
  const bytes = readPublishChangeResultBytes(context);
  if (!bytes) return null;
  const resultDigest = createHash("sha256").update(bytes).digest("hex");
  const currentBytes = Buffer.from(`${JSON.stringify({ ...observation, operation_action_id: action.action_id }, null, 2)}\n`);
  if (!sameObservedPublishChangeResult(bytes, currentBytes, action.action_id)) return null;
  const run = await loadBuilderFlowRun({ cwd: context.projectRoot, runId: context.slug });
  const attached = manifestEvidence(run.manifest).some((entry) => entry.gate_id === action.binding.gate_ids[0]
    && Array.isArray(entry.expectation_ids) && entry.expectation_ids.length === 1 && entry.expectation_ids[0] === "pull-request-opened"
    && isRecord(entry.bundle) && Array.isArray(entry.bundle.claims)
    && publishChangeEvidenceCarriesDigest(entry, resultDigest)
    && entry.bundle.claims.some((claim: unknown) => isRecord(claim)
      && claim.fieldOrBehavior === `Authenticated publish-change operation ${action.action_id} observed ${observation.change_ref.state} provider record ${observation.change_ref.provider_record_id}`));
  if (!attached) return null;
  const sidecarSnapshot = readSidecarSnapshot(context);
  const { projection, gateActionEnvelope, progressSnapshot } = projectFlowRun(context, run, sidecarSnapshot.state);
  writeProjection(context, projection, sidecarSnapshot.raw, "publish-change recovery projection");
  return {
    sessionDir: context.sessionDir,
    projectRoot: context.projectRoot,
    run,
    projection,
    gateActionEnvelope,
    progressSnapshot,
    attached: false,
    action,
    observation,
  };
}

async function writePublishChangeEvidence(
  context: SessionContext,
  action: IssuedPublishChangeAction,
  observation: AuthenticatedPublishChangeObservation,
  resultSha256: string,
): Promise<{ file: string; sha256: string }> {
  const file = path.join(context.sessionDir, `.publish-change.evidence-${randomBytes(16).toString("hex")}.json`);
  const timestamp = observation.observed_at;
  const check = {
    id: `publish-change-${action.action_id}`,
    kind: "external",
    status: "pass",
    summary: `Authenticated publish-change operation ${action.action_id} observed ${observation.change_ref.state} provider record ${observation.change_ref.provider_record_id}`,
    _gate_claim_expectation_id: "pull-request-opened",
    _gate_claim_identity_version: 2,
    _gate_claim_recorded_at: timestamp,
    _producer: "publish-change-operation-authority",
    _recorded_by: action.assignment_actor,
    artifact_refs: [{ kind: "provider", url: observation.change_ref.url, summary: `Authenticated ${observation.provider.kind} observation by ${observation.provider_actor}`, sha256: resultSha256 }],
  };
  const bundle = await buildTrustBundle(
    context.slug,
    timestamp,
    [check],
    [],
    [],
    [],
    context.artifactRoot,
    action.assignment_actor,
    { flowId: action.binding.definition_id, stepId: action.binding.step_id },
  );
  if (!bundle) throw new BuilderBuildRunInputError("publish-change", "could not build the required operation-bound trust bundle");
  const validation = await validateTrustBundle(bundle);
  if (validation.available && !validation.valid) throw new BuilderBuildRunInputError("publish-change", `operation-bound trust bundle is invalid: ${validation.errors.join("; ")}`);
  const bytes = Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`);
  if (bytes.byteLength > 65_536) throw new BuilderBuildRunInputError("publish-change", "operation-bound evidence exceeds the 65,536 byte bound");
  const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  assertSafeFile(file, context.sessionDir, "publish-change temporary evidence");
  return { file, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function removeTemporaryFile(file: string): void {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new BuilderBuildRunInputError("publish-change temporary evidence", "was replaced before cleanup");
    fs.unlinkSync(file);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return;
    throw error;
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
  sessionDir: string,
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
    const authority = verifiedResolutionAuthority(bundle as AnyRecord, sessionDir);
    await assertVerifiedTestsTrust(relevant, projectRoot, authority.events, authority.verified);
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

function verifiedResolutionAuthority(bundle: AnyRecord, sessionDir: string): { events: AnyRecord[]; verified: boolean } {
  const eventsFile = path.join(sessionDir, "lifecycle-authority.resolution-events.json");
  if (!fs.existsSync(eventsFile)) return { events: [], verified: false };
  assertSafeFile(eventsFile, sessionDir, "lifecycle-authority.resolution-events.json");
  const payload = JSON.parse(fs.readFileSync(eventsFile, "utf8"));
  const events = isRecord(payload) && Array.isArray(payload.events) ? payload.events as AnyRecord[] : [];
  const completionFile = path.join(sessionDir, "lifecycle-authority.completion.json");
  assertSafeFile(completionFile, sessionDir, "lifecycle-authority.completion.json");
  const completion = verifyLifecycleAuthorityCompletion(JSON.parse(fs.readFileSync(completionFile, "utf8")));
  const expectedCore = lifecycleAuthorityResultDigest({ ...bundle, critique_resolution_events: events });
  if (completion.action !== "resolve-critique" || completion.run_id !== path.basename(sessionDir) || completion.result_core_sha256 !== expectedCore) {
    throw new BuilderBuildRunInputError("evidence.critique.authority_completion", "must bind the exact resolved critique graph and session");
  }
  return { events, verified: true };
}

async function assertVerifiedTestsTrust(currentGateClaims: AnyRecord[], projectRoot: string, resolutionEvents: AnyRecord[], externalCompletionVerified: boolean): Promise<void> {
  const testClaims = currentGateClaims.filter((claim): claim is AnyRecord => isRecord(claim)
    && claim.claimType === "builder.verify.tests"
    && claim.value === "pass"
    && isRecord(claim.metadata)
    && isRecord(claim.metadata.gate_claim)
    && claim.metadata.gate_claim.expectation_id === "tests-evidence");
  if (testClaims.length === 0) throw new BuilderBuildRunInputError("evidence.tests", "is missing a passing tests-evidence claim");
  // A route-back starts a new gate visit and therefore a new critique generation. Historical
  // reviewer slices remain in the bundle and manifest for audit, but only critiques acquired
  // during this visit describe the implementation snapshot currently being verified. Within a
  // visit every live reviewer slice still participates, so changing reviewers cannot bury a
  // disputed finding.
  const graph = validateCritiqueResolutionGraph(currentGateClaims, typeof testClaims[0]?.metadata?.workflow_subject_ref === "string" ? testClaims[0].metadata.workflow_subject_ref : undefined, resolutionEvents, projectRoot, externalCompletionVerified);
  if (!graph.valid) throw new BuilderBuildRunInputError("evidence.critique.resolution_graph", graph.errors.join("; "));
  const liveRecordIds = new Set(graph.live.map((record) => record.critique_record_id));
  const liveCritiques = currentGateClaims.filter((claim): claim is AnyRecord => isRecord(claim)
    && isRecord(claim.metadata)
    && claim.metadata.origin === "critique"
    && liveRecordIds.has(claim.metadata.critique_record_id));
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
  const criteria = currentGateClaims.filter((claim): claim is AnyRecord => isRecord(claim) && isRecord(claim.metadata) && claim.metadata.origin === "acceptance");
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

async function assertReviewedArtifactDigest(artifact: AnyRecord, projectRoot: string): Promise<void> {
  const canonicalArtifact = safeReviewedArtifactPath(projectRoot, artifact.file);
  if (createHash("sha256").update(fs.readFileSync(canonicalArtifact)).digest("hex") !== artifact.sha256) {
    throw new BuilderBuildRunInputError("evidence.critique.review_target.artifacts.sha256", `does not match ${artifact.file}`);
  }
}

/** Revalidate the current substantive PASS represented by one persisted critique claim. */
export async function assertCurrentCritiqueClaim(claim: AnyRecord, projectRoot: string): Promise<void> {
  const metadata = isRecord(claim.metadata) ? claim.metadata : {};
  if (claim.value !== "pass" || claim.status !== "verified"
    || !Array.isArray(metadata.lanes) || metadata.lanes.length === 0 || metadata.lanes.some((lane: AnyRecord) => lane.status !== "pass")
    || (Array.isArray(metadata.findings) && metadata.findings.some((finding: AnyRecord) => finding.status === "open"))) {
    throw new BuilderBuildRunInputError("evidence.critique", "must remain a substantive current PASS");
  }
  const target = isRecord(metadata.review_target) ? metadata.review_target : {};
  const artifacts = Array.isArray(target.artifacts) ? target.artifacts : [];
  if (artifacts.length === 0) throw new BuilderBuildRunInputError("evidence.critique.review_target.artifacts", "must not be empty");
  await Promise.all(artifacts.map((artifact: AnyRecord) => assertReviewedArtifactDigest(artifact, projectRoot)));
  assertReviewedWorkspaceSnapshot({ metadata }, artifacts, projectRoot);
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
