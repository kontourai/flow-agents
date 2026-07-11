import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  expectationsForGate,
  lifecycleRequestMatches,
  openGates,
  readJson,
  runDir,
  sha256File,
  type FlowGate,
  type FlowExpectation,
  type FlowRunState,
  type JsonObject,
} from "@kontourai/flow";
import { assertAuthorizationUnused, loadBuilderLifecycleAuthorization, readAuthorizationConsumption, recordAuthorizationConsumed } from "./builder-lifecycle-authority.js";
import { assignmentFilePath, performLocalReleaseUnderLock, readLocalAssignmentStatus, resolveCurrentAssignmentActor, withSubjectLock, type ActorStruct } from "./cli/assignment-provider.js";
import {
  BUILDER_BUILD_FLOW_ID,
  BuilderBuildRunInputError,
  cancelBuilderBuildRun,
  evaluateBuilderBuildRun,
  loadBuilderBuildRun,
  pauseBuilderBuildRun,
  resumeBuilderBuildRun,
  startBuilderBuildRun,
  type BuilderBuildRunResult,
} from "./builder-flow-run-adapter.js";

type AnyRecord = Record<string, any>;

export interface BuilderFlowSessionInput {
  sessionDir: string;
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
  run: BuilderBuildRunResult;
  projection: AnyRecord;
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

export async function startBuilderFlowSession(input: BuilderFlowSessionInput): Promise<BuilderFlowSessionResult> {
  const context = resolveSessionContext(input.sessionDir);
  const sidecarSnapshot = readSidecarSnapshot(context);
  const subject = workflowSubject(sidecarSnapshot.state);
  let run: BuilderBuildRunResult;
  try {
    run = await loadBuilderBuildRun({
      cwd: context.projectRoot,
      runId: context.slug,
    });
  } catch (error) {
    if (!isRunNotFound(error)) throw error;
    run = await startBuilderBuildRun({
      cwd: context.projectRoot,
      runId: context.slug,
      subject,
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
  const run = await loadBuilderBuildRun({
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
  const run = await loadBuilderBuildRun({
    cwd: context.projectRoot,
    runId: context.slug,
  });
  assertRunSubjectBinding(run, subject);
  const projection = projectFlowRun(context, run, sidecarSnapshot.state);
  writeProjection(context, projection, sidecarSnapshot.raw, "recovery");
  return {
    sessionDir: context.sessionDir,
    projectRoot: context.projectRoot,
    run,
    projection,
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
    const changed = await cancelBuilderBuildRun({ cwd: prepared.context.projectRoot, runId: prepared.context.slug, request: prepared.authorization.request });
    const released = performLocalReleaseUnderLock(prepared.context.artifactRoot, prepared.context.slug, prepared.authorization.assignment_actor, {
      actorKey: prepared.authorization.assignment_actor_key,
      reason: `canonical Flow run canceled by ${prepared.authorization.request.authority.request_ref}`,
      tolerateNoActiveClaim: true,
    });
    const projection = projectFlowRun(prepared.context, changed, prepared.sidecarSnapshot.state);
    writeProjection(prepared.context, projection, prepared.sidecarSnapshot.raw, "cancellation projection");
    recordAuthorizationConsumed(prepared.context.artifactRoot, prepared.authorization);
    return { sessionDir: prepared.context.sessionDir, projectRoot: prepared.context.projectRoot, run: changed, projection, attached: false, assignmentReleased: released !== null, idempotent: changed.idempotent };
  });
}

export async function releaseBuilderFlowAssignment(input: BuilderFlowAgentLifecycleInput): Promise<BuilderFlowSessionResult & { assignmentReleased: boolean }> {
  const context = resolveSessionContext(input.sessionDir);
  return await withSubjectLock(context.artifactRoot, context.slug, async () => {
    const prepared = prepareAgentLifecycleChange(input, context);
    const run = await loadBuilderBuildRun({ cwd: context.projectRoot, runId: context.slug });
    const released = performLocalReleaseUnderLock(context.artifactRoot, context.slug, prepared.actor, { actorKey: prepared.actorKey, reason: input.reason });
    return { sessionDir: context.sessionDir, projectRoot: context.projectRoot, run, projection: prepared.sidecarSnapshot.state, attached: false, assignmentReleased: released !== null };
  });
}

export async function archiveBuilderFlowSession(input: BuilderFlowAuthorizedLifecycleInput): Promise<BuilderFlowSessionResult & { archiveDir: string }> {
  const context = resolveSessionContext(input.sessionDir);
  return await withSubjectLock(context.artifactRoot, context.slug, async () => {
  const prepared = await prepareAuthorizedLifecycleChange(input, "archive", context);
  const priorConsumption = readAuthorizationConsumption(prepared.context.artifactRoot, prepared.authorization);
  const recoveringPreparedArchive = priorConsumption !== null && prepared.sidecarSnapshot.state.status === "archived";
  if (priorConsumption && !recoveringPreparedArchive) throw new Error("lifecycle authorization nonce has already been consumed");
  const run = await loadBuilderBuildRun({ cwd: prepared.context.projectRoot, runId: prepared.context.slug });
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
  fs.renameSync(prepared.context.sessionDir, archiveDir);
  return {
    sessionDir: archiveDir,
    projectRoot: prepared.context.projectRoot,
    run,
    projection: archivedState,
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
  const change = operation === "pause" ? pauseBuilderBuildRun : resumeBuilderBuildRun;
  const at = new Date().toISOString();
  const run = await change({
    cwd: context.projectRoot,
    runId: context.slug,
    request: { reason: input.reason, authority: { kind: "operator_request", actor: prepared.actorKey, request_ref: `flow-agents://assignment/${context.slug}/${operation}/${at}`, requested_at: at } },
  });
  const projection = projectFlowRun(context, run, prepared.sidecarSnapshot.state);
  writeProjection(context, projection, prepared.sidecarSnapshot.raw, `${operation} projection`);
  return {
    sessionDir: context.sessionDir,
    projectRoot: context.projectRoot,
    run,
    projection,
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
  const canonicalRun = await loadBuilderBuildRun({ cwd: context.projectRoot, runId: context.slug });
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

export async function syncBuilderFlowSessionIfPresent(sessionDir: string): Promise<BuilderFlowSessionResult | null> {
  let context: SessionContext;
  try {
    context = resolveSessionContext(sessionDir);
  } catch (error) {
    if (error instanceof BuilderBuildRunInputError && error.field === "sessionDir") return null;
    throw error;
  }
  if (!fs.existsSync(runDir(context.slug, context.projectRoot))) return null;
  return syncBuilderFlowSession({ sessionDir });
}

async function syncAndProject(
  context: SessionContext,
  initial: BuilderBuildRunResult,
  sidecarSnapshot: SidecarSnapshot,
): Promise<BuilderFlowSessionResult> {
  let run = initial;
  let attached = false;
  const gates = openGatesForResult(run);
  if (run.state.status === "active" && gates.length !== 1) {
    throw new BuilderBuildRunInputError("flow_run.open_gates", `expected exactly one gate for active step ${run.state.current_step}, found ${gates.length}`);
  }
  if (gates.length === 1 && fs.existsSync(context.bundleFile)) {
    const rawBundle = await readJson(context.bundleFile);
    const gateEvidence = bundleGateEvidence(rawBundle, gates[0]!, run.state.subject);
    if (gateEvidence) {
      const digest = await sha256File(context.bundleFile);
      const alreadyAttached = manifestEvidence(run.manifest).some((entry) =>
        entry.gate_id === gates[0]!.id && entry.sha256 === digest
      );
      if (!alreadyAttached) {
        run = await evaluateBuilderBuildRun({
          cwd: context.projectRoot,
          runId: context.slug,
          evidence: {
            gate: gates[0]!.id,
            file: path.relative(context.projectRoot, context.bundleFile),
            ...(gateEvidence.failed ? { status: "failed" } : {}),
            ...(gateEvidence.routeReason ? { routeReason: gateEvidence.routeReason } : {}),
          },
        });
        attached = true;
      }
    }
  }
  const projection = projectFlowRun(context, run, sidecarSnapshot.state);
  writeProjection(context, projection, sidecarSnapshot.raw, "projection");
  return {
    sessionDir: context.sessionDir,
    projectRoot: context.projectRoot,
    run,
    projection,
    attached,
  };
}

function assertRunSubjectBinding(run: BuilderBuildRunResult, subject: string): void {
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

function openGatesForResult(run: BuilderBuildRunResult): Array<FlowGate & { id: string }> {
  return openGates(
    JSON.parse(fs.readFileSync(path.join(run.dir, "definition.json"), "utf8")),
    run.state,
  ) as Array<FlowGate & { id: string }>;
}

function bundleGateEvidence(bundle: unknown, gate: FlowGate, subject: string): { failed: boolean; routeReason: string | null } | null {
  if (!isRecord(bundle) || !Array.isArray(bundle.claims)) return null;
  const selectors = (expectationsForGate(gate) as FlowExpectation[]).map((expectation) => expectation.bundle_claim);
  const relevant = bundle.claims.filter((claim: unknown): claim is AnyRecord => {
    if (!isRecord(claim)) return false;
    return selectors.some((candidate: FlowExpectation["bundle_claim"]) =>
      candidate.claimType === claim.claimType
      && (!candidate.subjectType || candidate.subjectType === claim.subjectType)
    );
  });
  if (relevant.length === 0) return null;
  if (relevant.some((claim) => workflowSubjectRef(claim) !== subject)) {
    throw new BuilderBuildRunInputError("evidence.claims.metadata.workflow_subject_ref", "must match the persisted run subject");
  }
  const failed = relevant.some((claim) => claim.value === "fail" || claim.status === "disputed");
  const routeReasons = [...new Set(relevant.flatMap((claim) => {
    const metadata = isRecord(claim.metadata) ? claim.metadata : null;
    const gateClaim = metadata && isRecord(metadata.gate_claim) ? metadata.gate_claim : null;
    return gateClaim && typeof gateClaim.route_reason === "string" ? [gateClaim.route_reason] : [];
  }))];
  if (routeReasons.length > 1) {
    throw new BuilderBuildRunInputError("evidence.claims.metadata.gate_claim.route_reason", "must agree across current-gate claims");
  }
  const routeReason = routeReasons[0] ?? null;
  if (routeReason && !failed) {
    throw new BuilderBuildRunInputError("evidence.claims.metadata.gate_claim.route_reason", "requires failed current-gate evidence");
  }
  const routeMap = isRecord((gate as AnyRecord).on_route_back) ? (gate as AnyRecord).on_route_back : null;
  if (routeReason && (!routeMap || typeof routeMap[routeReason] !== "string")) {
    throw new BuilderBuildRunInputError("evidence.claims.metadata.gate_claim.route_reason", `is not declared by gate ${String((gate as AnyRecord).id ?? "<unknown>")}`);
  }
  return { failed, routeReason };
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

function projectFlowRun(context: SessionContext, run: BuilderBuildRunResult, sidecar: AnyRecord): AnyRecord {
  const definition = JSON.parse(fs.readFileSync(path.join(run.dir, "definition.json"), "utf8"));
  const gates = openGates(definition, run.state) as Array<FlowGate & { id: string }>;
  const complete = run.state.status === "completed";
  const paused = run.state.status === "paused";
  const canceled = run.state.status === "canceled";
  const action = complete || paused || canceled ? { skills: [], operations: [] } : stepAction(run.state.current_step);
  if (!action) {
    throw new BuilderBuildRunInputError("kit.flow_step_actions", `does not declare Builder step ${run.state.current_step}`);
  }
  const required = gates.flatMap((gate) => (expectationsForGate(gate) as FlowExpectation[])
    .filter((expectation: FlowExpectation) => expectation.required)
    .map((expectation: FlowExpectation) => `${expectation.id} (${expectation.bundle_claim.claimType}/${expectation.bundle_claim.subjectType ?? "any"})`));
  const skills = action?.skills ?? [];
  const operations = action?.operations ?? [];
  const syncCommand = `flow-agents builder-run sync --session-dir .kontourai/flow-agents/${context.slug}`;
  const routeBack = latestRouteBack(run.state);
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
    : {
        status: "continue",
        summary: `Flow step \`${run.state.current_step}\`: ${skillText}${operationText} ${gateText}${routeText} Then synchronize the recorded evidence.`,
        skills,
        operations,
        command: syncCommand,
      };
  const phase = phaseForStep(definition.phase_map, run.state.current_step) ?? sidecar.phase;
  return {
    ...sidecar,
    status: complete ? "delivered" : canceled ? "canceled" : paused ? "blocked" : (run.state.transitions.length > 0 ? "in_progress" : sidecar.status),
    phase: complete || canceled ? "done" : phase,
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
  };
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
      active_flow_id: BUILDER_BUILD_FLOW_ID,
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

function stepAction(stepId: string): { skills: string[]; operations: string[] } | null {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot(), "kits", "builder", "kit.json"), "utf8"));
  const actions = Array.isArray(manifest.flow_step_actions) ? manifest.flow_step_actions : [];
  const action = actions.find((candidate: unknown) =>
    isRecord(candidate)
    && candidate.flow_id === BUILDER_BUILD_FLOW_ID
    && candidate.step_id === stepId
  );
  if (!isRecord(action) || !Array.isArray(action.skills) || !action.skills.every((skill: unknown) => typeof skill === "string")) {
    return null;
  }
  const operations = Array.isArray(action.operations) && action.operations.every((operation: unknown) => typeof operation === "string")
    ? action.operations
    : [];
  return { skills: action.skills, operations };
}

function phaseForStep(phaseMap: unknown, stepId: string): string | null {
  if (!isRecord(phaseMap)) return stepId === "design-probe" ? "pickup" : null;
  return Object.entries(phaseMap).find(([, step]) => step === stepId)?.[0] ?? (stepId === "design-probe" ? "pickup" : null);
}

function latestRouteBack(state: FlowRunState): AnyRecord | null {
  const outcomes = Array.isArray(state.gate_outcomes) ? state.gate_outcomes : [];
  return [...outcomes].reverse().find((outcome) => isRecord(outcome) && outcome.status === "route-back") ?? null;
}

function packageRoot(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (!fs.existsSync(path.join(directory, "package.json"))) {
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error("unable to locate Flow Agents package root");
    directory = parent;
  }
  return directory;
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
