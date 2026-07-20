import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  attachEvidence,
  definitionDigest,
  evaluateRun,
  expectationsForGate,
  loadRun,
  normalizeTrustBundle,
  openGates,
  pauseRun,
  resumeRun,
  startRun,
  validateDefinition,
  type FlowEvidenceEntry,
  type FlowLifecycleRequest,
  type FlowRunState,
  type GateOutcome,
  type JsonObject,
} from "@kontourai/flow";
import { resolveEffectiveFlowDefinition } from "./lib/flow-resolver.js";

export const BUILDER_BUILD_FLOW_ID = "builder.build";
export const BUILDER_BUILD_FLOW_RELATIVE_PATH = "kits/builder/flows/build.flow.json";
export const BUILDER_SHAPE_FLOW_ID = "builder.shape";
export const BUILDER_SHAPE_FLOW_RELATIVE_PATH = "kits/builder/flows/shape.flow.json";
export type BuilderFlowId = typeof BUILDER_BUILD_FLOW_ID | typeof BUILDER_SHAPE_FLOW_ID;

export interface BuilderBuildTrustBundleEvidenceInput {
  gate: string;
  /**
   * Trusted local evidence path interpreted by Flow relative to `cwd`.
   * Callers must not pass raw user-controlled paths to this local runtime API.
   */
  file: string;
  /** SHA-256 of the immutable snapshot validated by Flow Agents before Flow attaches it. */
  expectedSha256?: string;
  status?: "passed" | "failed";
  producer?: string;
  authorityTrace?: string;
  routeReason?: string;
  expectationIds?: string[];
  supersede?: string | string[];
  classifier?: JsonObject;
  diagnostics?: JsonObject;
  analytics?: JsonObject;
}

export interface StartBuilderBuildRunInput {
  subject: string;
  params?: JsonObject;
  /**
   * Trusted local runtime root. Flow owns persistence and interprets attached
   * evidence files relative to this directory.
   */
  cwd?: string;
  runId?: string;
}

export interface StartBuilderFlowRunInput extends StartBuilderBuildRunInput {
  flowId: BuilderFlowId;
}

export interface EvaluateBuilderBuildRunInput {
  runId: string;
  /**
   * Trusted local runtime root. Flow owns persistence and interprets attached
   * evidence files relative to this directory.
   */
  cwd?: string;
  evidence?: BuilderBuildTrustBundleEvidenceInput;
}

export interface LoadBuilderBuildRunInput {
  runId: string;
  cwd?: string;
}

export interface ChangeBuilderBuildRunLifecycleInput extends LoadBuilderBuildRunInput {
  request: FlowLifecycleRequest;
  at?: string;
}

export interface BuilderFlowRunResult {
  definitionId: BuilderFlowId;
  definitionVersion: string;
  definitionDigest: string;
  /** Flow-validated effective definition, including any authorized successor. */
  definition: JsonObject;
  /** Immutable definition that authenticated this run at start. */
  startDefinition: JsonObject;
  runId: string;
  dir: string;
  state: FlowRunState;
  attachedEvidence: FlowEvidenceEntry[];
  outcomes: GateOutcome[];
  manifest: JsonObject;
  config: JsonObject;
  freshnessTransitions: JsonObject[];
}

export interface BuilderBuildRunResult extends Omit<BuilderFlowRunResult, "definitionId"> {
  definitionId: typeof BUILDER_BUILD_FLOW_ID;
}

export type BuilderBuildRunIdentityMismatch = "definition-id" | "definition-version" | "definition-content";

export class BuilderBuildRunInputError extends Error {
  readonly code = "BUILDER_BUILD_RUN_INVALID_INPUT" as const;
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`invalid Builder build run input for ${field}: ${reason}`);
    this.name = "BuilderBuildRunInputError";
    this.field = field;
  }
}

export class BuilderBuildRunIdentityError extends Error {
  readonly code = "BUILDER_BUILD_RUN_IDENTITY_MISMATCH" as const;
  readonly expectedDefinitionId: string;
  readonly expectedDefinitionVersion: string;
  readonly actualDefinitionId: string;
  readonly actualDefinitionVersion: string;
  readonly mismatch: BuilderBuildRunIdentityMismatch;
  readonly runId: string;

  constructor(
    runId: string,
    expectedDefinition: { id: string; version: string },
    actualDefinition: { id: string; version: string },
    mismatch: BuilderBuildRunIdentityMismatch,
  ) {
    super(`expected canonical ${expectedDefinition.id}@${expectedDefinition.version} run, received ${actualDefinition.id}@${actualDefinition.version} for ${runId}`);
    this.name = "BuilderBuildRunIdentityError";
    this.expectedDefinitionId = expectedDefinition.id;
    this.expectedDefinitionVersion = expectedDefinition.version;
    this.actualDefinitionId = actualDefinition.id;
    this.actualDefinitionVersion = actualDefinition.version;
    this.mismatch = mismatch;
    this.runId = runId;
  }
}

export function resolveBuilderBuildFlowDefinitionPath(startDir = moduleDirectory()): string {
  return resolveBuilderFlowDefinitionPath(BUILDER_BUILD_FLOW_ID, startDir);
}

export async function startBuilderBuildRun(input: StartBuilderBuildRunInput): Promise<BuilderBuildRunResult> {
  const result = await startBuilderFlowRun({ ...input, flowId: BUILDER_BUILD_FLOW_ID });
  return asBuilderBuildResult(result, input.runId ?? result.runId);
}

export function resolveBuilderFlowDefinitionPath(flowId: BuilderFlowId, startDir = moduleDirectory()): string {
  const root = findPackageRoot(startDir);
  return path.join(root, flowRelativePath(flowId));
}

export async function startBuilderFlowRun(input: StartBuilderFlowRunInput): Promise<BuilderFlowRunResult> {
  assertRuntimeInput(input, ["evidence", "now", "gate"]);
  if (!isNonEmptyString(input.subject)) {
    throw new BuilderBuildRunInputError("subject", "must be a non-empty string");
  }

  const cwd = input.cwd ?? process.cwd();
  const definitionPath = resolveBuilderFlowDefinitionPath(input.flowId);
  const definition = await loadShippedBuilderFlowDefinition(input.flowId, definitionPath);
  const runtimeDefinitionPath = materializeRuntimeDefinition(cwd, input.flowId, definition);
  const started = await startRun(runtimeDefinitionPath, {
    cwd,
    runId: input.runId,
    params: {
      ...(input.params ?? {}),
      subject: input.subject,
    },
  });
  const run = await loadCanonicalBuilderFlowRun(started.runId, cwd, definition);

  return resultFromRun(run, started.runId);
}

export async function evaluateBuilderBuildRun(input: EvaluateBuilderBuildRunInput): Promise<BuilderBuildRunResult> {
  const result = await evaluateBuilderFlowRun(input);
  return asBuilderBuildResult(result, input.runId);
}

export async function evaluateBuilderFlowRun(input: EvaluateBuilderBuildRunInput): Promise<BuilderFlowRunResult> {
  assertRuntimeInput(input, ["now", "gate"]);
  if (Array.isArray(input.evidence)) {
    throw new BuilderBuildRunInputError("evidence", "must be zero or one evidence object, not an array");
  }

  const cwd = input.cwd ?? process.cwd();
  const run = await loadRun(input.runId, cwd);
  await assertCanonicalBuilderRunOrigin(input.runId, run);

  let attachedEvidence: FlowEvidenceEntry[] = [];
  if (input.evidence !== undefined) {
    const evidence = validateEvidenceInput(input.evidence);
    assertCurrentOpenGate(run.definition, run.state, evidence.gate);
    const source = path.resolve(cwd, evidence.file);
    const bytes = readFileSync(source);
    const validatedSha256 = createHash("sha256").update(bytes).digest("hex");
    if (evidence.expectedSha256 && evidence.expectedSha256 !== validatedSha256) {
      throw new BuilderBuildRunInputError("evidence.expectedSha256", "does not match the bytes presented for validation");
    }
    const normalized = normalizeTrustBundle(JSON.parse(bytes.toString("utf8")));
    assertBundleSubjects(normalized.bundle, run.state.subject, openGates(run.definition, run.state)[0]);
    const attached = await attachEvidence(input.runId, trustBundleAttachOptions(cwd, evidence, validatedSha256));
    if (attached.sha256 !== validatedSha256) {
      throw new BuilderBuildRunInputError("evidence.file", "changed after validation before Flow attachment");
    }
    attachedEvidence = [attached];
  }

  const evaluated = await evaluateRun(input.runId, { cwd });
  const result = resultFromRun(evaluated, input.runId);
  return {
    ...result,
    attachedEvidence,
    outcomes: evaluated.outcomes,
    freshnessTransitions: evaluated.freshness_transitions,
  };
}

export async function loadBuilderBuildRun(input: LoadBuilderBuildRunInput): Promise<BuilderBuildRunResult> {
  const result = await loadBuilderFlowRun(input);
  return asBuilderBuildResult(result, input.runId);
}

export async function loadBuilderFlowRun(input: LoadBuilderBuildRunInput): Promise<BuilderFlowRunResult> {
  assertRuntimeInput(input, ["evidence", "now", "gate"]);
  const cwd = input.cwd ?? process.cwd();
  const run = await loadRun(input.runId, cwd);
  await assertCanonicalBuilderRunOrigin(input.runId, run);
  return resultFromRun(run, input.runId);
}

export async function pauseBuilderBuildRun(input: ChangeBuilderBuildRunLifecycleInput): Promise<BuilderBuildRunResult> {
  const result = await pauseBuilderFlowRun(input);
  return asBuilderBuildResult(result, input.runId);
}

export async function resumeBuilderBuildRun(input: ChangeBuilderBuildRunLifecycleInput): Promise<BuilderBuildRunResult> {
  const result = await resumeBuilderFlowRun(input);
  return asBuilderBuildResult(result, input.runId);
}

export async function pauseBuilderFlowRun(input: ChangeBuilderBuildRunLifecycleInput): Promise<BuilderFlowRunResult> {
  return changeBuilderFlowRunLifecycle(input, pauseRun);
}

export async function resumeBuilderFlowRun(input: ChangeBuilderBuildRunLifecycleInput): Promise<BuilderFlowRunResult> {
  return changeBuilderFlowRunLifecycle(input, resumeRun);
}

async function changeBuilderFlowRunLifecycle(
  input: ChangeBuilderBuildRunLifecycleInput,
  operation: typeof pauseRun | typeof resumeRun,
): Promise<BuilderFlowRunResult> {
  const changed = await changeBuilderFlowRunLifecycleResult(input, operation);
  return resultFromRun(changed, input.runId);
}

async function changeBuilderFlowRunLifecycleResult(
  input: ChangeBuilderBuildRunLifecycleInput,
  operation: typeof pauseRun | typeof resumeRun,
) {
  assertRuntimeInput(input, []);
  if (!isRecord(input.request)) throw new BuilderBuildRunInputError("request", "must be a lifecycle request object");
  const cwd = input.cwd ?? process.cwd();
  const before = await loadBuilderFlowRun({ runId: input.runId, cwd });
  const changed = await operation(input.runId, { cwd, ...input.request, ...(input.at ? { at: input.at } : {}) });
  await assertCanonicalBuilderRunOrigin(input.runId, changed);
  if (changed.state.subject !== before.state.subject) {
    throw new BuilderBuildRunInputError("flow_run.state.subject", "changed during lifecycle transition");
  }
  return changed;
}

function resultFromRun(run: Awaited<ReturnType<typeof loadRun>>, runId: string): BuilderFlowRunResult {
  const definition = run.definition as JsonObject & { id: BuilderFlowId; version: string };
  return {
    definitionId: definition.id,
    definitionVersion: definition.version,
    definitionDigest: definitionDigest(definition),
    definition,
    startDefinition: run.startDefinition as JsonObject,
    runId,
    dir: run.dir,
    state: run.state,
    attachedEvidence: [],
    outcomes: [],
    manifest: run.manifest,
    config: run.config,
    freshnessTransitions: [],
  };
}

async function loadCanonicalBuilderFlowRun(
  runId: string,
  cwd: string,
  definition: { id: string; version: string },
): Promise<Awaited<ReturnType<typeof loadRun>>> {
  const run = await loadRun(runId, cwd);
  assertCanonicalDefinition(runId, definition, run.startDefinition);
  return run;
}

async function assertCanonicalBuilderRunOrigin(
  runId: string,
  run: Pick<Awaited<ReturnType<typeof loadRun>>, "definition" | "startDefinition">,
): Promise<void> {
  const definition = await loadShippedBuilderFlowDefinitionForRun(runId, run.startDefinition);
  assertCanonicalDefinition(runId, definition, run.startDefinition);
  if (!isBuilderFlowId(run.definition.id)) {
    throw new BuilderBuildRunIdentityError(runId, definition, run.definition, "definition-id");
  }
}

async function loadShippedBuilderFlowDefinition(flowId: BuilderFlowId, definitionPath: string): Promise<{ id: string; version: string }> {
  const packageRoot = findPackageRoot(path.dirname(definitionPath));
  const effective = resolveEffectiveFlowDefinition(flowId, packageRoot, { allowOverride: false });
  if (!effective) {
    throw new BuilderBuildRunInputError("definition", "could not compile the shipped uses_flow composition");
  }
  const definition = validateDefinition(effective);
  if (definition.id !== flowId) {
    throw new BuilderBuildRunInputError("definition", `expected shipped definition id ${flowId}`);
  }
  return definition;
}

async function loadShippedBuilderFlowDefinitionForRun(runId: string, actualDefinition: { id: string; version: string }): Promise<{ id: string; version: string }> {
  const flowId = actualDefinition.id;
  if (!isBuilderFlowId(flowId)) {
    throw new BuilderBuildRunIdentityError(runId, { id: BUILDER_BUILD_FLOW_ID, version: "unknown" }, actualDefinition, "definition-id");
  }
  return loadShippedBuilderFlowDefinition(flowId, resolveBuilderFlowDefinitionPath(flowId));
}

function materializeRuntimeDefinition(cwd: string, flowId: BuilderFlowId, definition: unknown): string {
  const content = `${JSON.stringify(definition, null, 2)}\n`;
  const digest = createHash("sha256").update(content).digest("hex").slice(0, 16);
  const directory = path.join(cwd, ".kontourai", "flow-agents", "runtime-definitions");
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${flowId.replace(".", "-")}-${digest}.flow.json`);
  if (!existsSync(file)) writeFileSync(file, content);
  return file;
}

function flowRelativePath(flowId: BuilderFlowId): string {
  return flowId === BUILDER_BUILD_FLOW_ID ? BUILDER_BUILD_FLOW_RELATIVE_PATH : BUILDER_SHAPE_FLOW_RELATIVE_PATH;
}

function isBuilderFlowId(value: string): value is BuilderFlowId {
  return value === BUILDER_BUILD_FLOW_ID || value === BUILDER_SHAPE_FLOW_ID;
}

function assertExpectedFlow(runId: string, actual: BuilderFlowId, expected: BuilderFlowId): void {
  if (actual === expected) return;
  throw new BuilderBuildRunIdentityError(runId, { id: expected, version: "unknown" }, { id: actual, version: "unknown" }, "definition-id");
}

function asBuilderBuildResult(result: BuilderFlowRunResult, runId: string): BuilderBuildRunResult {
  assertExpectedFlow(runId, result.definitionId, BUILDER_BUILD_FLOW_ID);
  return result as BuilderBuildRunResult;
}

function assertCanonicalDefinition(
  runId: string,
  expectedDefinition: { id: string; version: string },
  actualDefinition: { id: string; version: string },
): void {
  if (isDeepStrictEqual(actualDefinition, expectedDefinition)) return;

  const mismatch: BuilderBuildRunIdentityMismatch = actualDefinition.id !== expectedDefinition.id
    ? "definition-id"
    : actualDefinition.version !== expectedDefinition.version
      ? "definition-version"
      : "definition-content";
  throw new BuilderBuildRunIdentityError(runId, expectedDefinition, actualDefinition, mismatch);
}

function assertRuntimeInput(input: unknown, forbiddenFields: string[]): asserts input is Record<string, unknown> {
  if (!isRecord(input)) {
    throw new BuilderBuildRunInputError("input", "must be an object");
  }
  for (const field of forbiddenFields) {
    if (field in input) {
      throw new BuilderBuildRunInputError(field, "is not supported by this API");
    }
  }
}

function validateEvidenceInput(evidence: unknown): BuilderBuildTrustBundleEvidenceInput {
  if (!isRecord(evidence)) {
    throw new BuilderBuildRunInputError("evidence", "must be an object");
  }
  if (!isNonEmptyString(evidence.gate)) {
    throw new BuilderBuildRunInputError("evidence.gate", "must be a non-empty string");
  }
  if (!isNonEmptyString(evidence.file)) {
    throw new BuilderBuildRunInputError("evidence.file", "must be a non-empty string");
  }
  if (evidence.expectedSha256 !== undefined && (!isNonEmptyString(evidence.expectedSha256) || !/^[a-f0-9]{64}$/i.test(evidence.expectedSha256))) {
    throw new BuilderBuildRunInputError("evidence.expectedSha256", "must be a SHA-256 hex digest");
  }
  if (evidence.status !== undefined && evidence.status !== "passed" && evidence.status !== "failed") {
    throw new BuilderBuildRunInputError("evidence.status", "must be passed or failed");
  }
  return evidence as unknown as BuilderBuildTrustBundleEvidenceInput;
}

function assertCurrentOpenGate(definition: unknown, state: FlowRunState, evidenceGate: string): void {
  const gates = openGates(definition, state);
  if (gates.length !== 1) {
    throw new BuilderBuildRunInputError("evidence.gate", "requires exactly one current open gate");
  }
  if (gates[0].id !== evidenceGate) {
    throw new BuilderBuildRunInputError("evidence.gate", "must target the persisted current open gate");
  }
}

function assertBundleSubjects(bundle: unknown, subject: string, gate: unknown): void {
  if (!isRecord(bundle) || !Array.isArray(bundle.claims)) {
    throw new BuilderBuildRunInputError("evidence", "contains no normalized claims");
  }
  const selectors = expectationsForGate(gate).map((expectation: any) => expectation.bundle_claim);
  const relevant = bundle.claims.filter((claim) =>
    isRecord(claim)
    && selectors.some((selector: any) =>
      selector.claimType === claim.claimType
      && (!selector.subjectType || selector.subjectType === claim.subjectType)
    )
  );
  if (relevant.length === 0) {
    throw new BuilderBuildRunInputError("evidence.claims", "contains no claim matching the persisted current open gate");
  }
  for (const claim of relevant) {
    const metadata = isRecord(claim.metadata) ? claim.metadata : null;
    if (!metadata || metadata.workflow_subject_ref !== subject) {
      throw new BuilderBuildRunInputError("evidence.claims.metadata.workflow_subject_ref", "must match the persisted run subject");
    }
  }
}

function trustBundleAttachOptions(cwd: string, evidence: BuilderBuildTrustBundleEvidenceInput, expectedSha256: string): JsonObject {
  return {
    cwd,
    gate: evidence.gate,
    file: evidence.file,
    expectedSha256,
    kind: "trust.bundle",
    bundle: true,
    ...(evidence.status ? { status: evidence.status } : {}),
    ...(evidence.producer ? { producer: evidence.producer } : {}),
    ...(evidence.authorityTrace ? { authorityTrace: evidence.authorityTrace } : {}),
    ...(evidence.routeReason ? { route_reason: evidence.routeReason } : {}),
    ...(evidence.expectationIds ? { expectation_ids: evidence.expectationIds } : {}),
    ...(evidence.supersede ? { supersede: evidence.supersede } : {}),
    ...(evidence.classifier ? { classifier: evidence.classifier } : {}),
    ...(evidence.diagnostics ? { diagnostics: evidence.diagnostics } : {}),
    ...(evidence.analytics ? { analytics: evidence.analytics } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function moduleDirectory(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function findPackageRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(path.join(dir, "package.json")) && existsSync(path.join(dir, BUILDER_BUILD_FLOW_RELATIVE_PATH))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`unable to locate ${BUILDER_BUILD_FLOW_RELATIVE_PATH} from ${startDir}`);
    }
    dir = parent;
  }
}
