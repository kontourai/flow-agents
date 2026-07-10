import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  expectationsForGate,
  openGates,
  readJson,
  runDir,
  sha256File,
  type FlowGate,
  type FlowExpectation,
  type FlowRunState,
  type JsonObject,
} from "@kontourai/flow";
import {
  BUILDER_BUILD_FLOW_ID,
  BuilderBuildRunInputError,
  evaluateBuilderBuildRun,
  loadBuilderBuildRun,
  startBuilderBuildRun,
  type BuilderBuildRunResult,
} from "./builder-flow-run-adapter.js";

type AnyRecord = Record<string, any>;

export interface BuilderFlowSessionInput {
  sessionDir: string;
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

export async function startBuilderFlowSession(input: BuilderFlowSessionInput): Promise<BuilderFlowSessionResult> {
  const context = resolveSessionContext(input.sessionDir);
  const sidecarState = readSidecarState(context);
  const subject = workflowSubject(sidecarState);
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
  return syncAndProject(context, run);
}

export async function syncBuilderFlowSession(input: BuilderFlowSessionInput): Promise<BuilderFlowSessionResult> {
  const context = resolveSessionContext(input.sessionDir);
  const run = await loadBuilderBuildRun({
    cwd: context.projectRoot,
    runId: context.slug,
  });
  return syncAndProject(context, run);
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

async function syncAndProject(context: SessionContext, initial: BuilderBuildRunResult): Promise<BuilderFlowSessionResult> {
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
  const projection = projectFlowRun(context, run);
  writeProjection(context, projection);
  return {
    sessionDir: context.sessionDir,
    projectRoot: context.projectRoot,
    run,
    projection,
    attached,
  };
}

function resolveSessionContext(sessionDirInput: string): SessionContext {
  const sessionDir = path.resolve(sessionDirInput);
  const artifactRoot = path.dirname(sessionDir);
  const kontouraiRoot = path.dirname(artifactRoot);
  if (path.basename(artifactRoot) !== "flow-agents" || path.basename(kontouraiRoot) !== ".kontourai") {
    throw new BuilderBuildRunInputError("sessionDir", "must be .kontourai/flow-agents/<slug>");
  }
  const slug = path.basename(sessionDir);
  if (!slug || slug === "." || slug === "..") {
    throw new BuilderBuildRunInputError("sessionDir", "must name a session");
  }
  const stateFile = path.join(sessionDir, "state.json");
  if (!fs.existsSync(stateFile)) {
    throw new BuilderBuildRunInputError("sessionDir", "must contain state.json");
  }
  return {
    sessionDir,
    artifactRoot,
    projectRoot: path.dirname(kontouraiRoot),
    slug,
    stateFile,
    bundleFile: path.join(sessionDir, "trust.bundle"),
  };
}

function readSidecarState(context: SessionContext): AnyRecord {
  const value = JSON.parse(fs.readFileSync(context.stateFile, "utf8"));
  if (!isRecord(value) || value.task_slug !== context.slug) {
    throw new BuilderBuildRunInputError("sessionDir", "state.json task_slug must match the session directory");
  }
  return value;
}

function workflowSubject(state: AnyRecord): string {
  const refs = Array.isArray(state.work_item_refs)
    ? state.work_item_refs.filter((value: unknown): value is string => typeof value === "string" && value.length > 0)
    : [];
  if (refs.length !== 1) {
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

function projectFlowRun(context: SessionContext, run: BuilderBuildRunResult): AnyRecord {
  const sidecar = readSidecarState(context);
  const definition = JSON.parse(fs.readFileSync(path.join(run.dir, "definition.json"), "utf8"));
  const gates = openGates(definition, run.state) as Array<FlowGate & { id: string }>;
  const complete = run.state.status === "completed";
  const action = complete ? { skills: [], operations: [] } : stepAction(run.state.current_step);
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
    status: complete ? "delivered" : (run.state.transitions.length > 0 ? "in_progress" : sidecar.status),
    phase: complete ? "done" : phase,
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

function writeProjection(context: SessionContext, projection: AnyRecord): void {
  fs.writeFileSync(context.stateFile, `${JSON.stringify(projection, null, 2)}\n`);
  const pointerFiles = [path.join(context.artifactRoot, "current.json")];
  const actorRoot = path.join(context.artifactRoot, "current");
  if (fs.existsSync(actorRoot)) {
    pointerFiles.push(...fs.readdirSync(actorRoot)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(actorRoot, name)));
  }
  for (const file of pointerFiles) {
    if (!fs.existsSync(file)) continue;
    const pointer = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isRecord(pointer) || pointer.active_slug !== context.slug) continue;
    pointer.active_flow_id = BUILDER_BUILD_FLOW_ID;
    pointer.active_step_id = projection.flow_run.current_step;
    pointer.updated_at = projection.updated_at;
    fs.writeFileSync(file, `${JSON.stringify(pointer, null, 2)}\n`);
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
