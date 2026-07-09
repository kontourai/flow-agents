import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  attachEvidence,
  evaluateRun,
  loadRun,
  normalizeTrustBundle,
  openGates,
  readJson,
  startRun,
  validateDefinition,
  type FlowEvidenceEntry,
  type FlowRunState,
  type GateOutcome,
  type JsonObject,
} from "@kontourai/flow";

export const BUILDER_BUILD_FLOW_ID = "builder.build";
export const BUILDER_BUILD_FLOW_RELATIVE_PATH = "kits/builder/flows/build.flow.json";

export interface BuilderBuildTrustBundleEvidenceInput {
  gate: string;
  /**
   * Trusted local evidence path interpreted by Flow relative to `cwd`.
   * Callers must not pass raw user-controlled paths to this local runtime API.
   */
  file: string;
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

export interface EvaluateBuilderBuildRunInput {
  runId: string;
  /**
   * Trusted local runtime root. Flow owns persistence and interprets attached
   * evidence files relative to this directory.
   */
  cwd?: string;
  evidence?: BuilderBuildTrustBundleEvidenceInput;
}

export interface BuilderBuildRunResult {
  definitionId: typeof BUILDER_BUILD_FLOW_ID;
  definitionVersion: string;
  runId: string;
  dir: string;
  state: FlowRunState;
  attachedEvidence: FlowEvidenceEntry[];
  outcomes: GateOutcome[];
  manifest: JsonObject;
  freshnessTransitions: JsonObject[];
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
  const root = findPackageRoot(startDir);
  return path.join(root, BUILDER_BUILD_FLOW_RELATIVE_PATH);
}

export async function startBuilderBuildRun(input: StartBuilderBuildRunInput): Promise<BuilderBuildRunResult> {
  assertRuntimeInput(input, ["evidence", "now", "gate"]);
  if (!isNonEmptyString(input.subject)) {
    throw new BuilderBuildRunInputError("subject", "must be a non-empty string");
  }

  const cwd = input.cwd ?? process.cwd();
  const definitionPath = resolveBuilderBuildFlowDefinitionPath();
  const definition = await loadShippedBuilderBuildDefinition(definitionPath);
  const started = await startRun(definitionPath, {
    cwd,
    runId: input.runId,
    params: {
      ...(input.params ?? {}),
      subject: input.subject,
    },
  });
  const run = await loadCanonicalBuilderBuildRun(started.runId, cwd, definition);

  return resultFromRun(run, started.runId);
}

export async function evaluateBuilderBuildRun(input: EvaluateBuilderBuildRunInput): Promise<BuilderBuildRunResult> {
  assertRuntimeInput(input, ["now", "gate"]);
  if (Array.isArray(input.evidence)) {
    throw new BuilderBuildRunInputError("evidence", "must be zero or one evidence object, not an array");
  }

  const cwd = input.cwd ?? process.cwd();
  const run = await loadRun(input.runId, cwd);
  const definition = await loadShippedBuilderBuildDefinition(resolveBuilderBuildFlowDefinitionPath());
  assertCanonicalDefinition(input.runId, definition, run.definition);

  let attachedEvidence: FlowEvidenceEntry[] = [];
  if (input.evidence !== undefined) {
    const evidence = validateEvidenceInput(input.evidence);
    assertCurrentOpenGate(run.definition, run.state, evidence.gate);
    const normalized = normalizeTrustBundle(await readJson(path.resolve(cwd, evidence.file)));
    assertBundleSubjects(normalized.bundle, run.state.subject);
    attachedEvidence = [await attachEvidence(input.runId, trustBundleAttachOptions(cwd, evidence))];
  }

  const evaluated = await evaluateRun(input.runId, { cwd });
  return {
    definitionId: evaluated.definition.id,
    definitionVersion: evaluated.definition.version,
    runId: input.runId,
    dir: evaluated.dir,
    state: evaluated.state,
    attachedEvidence,
    outcomes: evaluated.outcomes,
    manifest: evaluated.manifest,
    freshnessTransitions: evaluated.freshness_transitions,
  };
}

function resultFromRun(run: Awaited<ReturnType<typeof loadRun>>, runId: string): BuilderBuildRunResult {
  return {
    definitionId: run.definition.id,
    definitionVersion: run.definition.version,
    runId,
    dir: run.dir,
    state: run.state,
    attachedEvidence: [],
    outcomes: [],
    manifest: run.manifest,
    freshnessTransitions: [],
  };
}

async function loadCanonicalBuilderBuildRun(
  runId: string,
  cwd: string,
  definition: { id: string; version: string },
): Promise<Awaited<ReturnType<typeof loadRun>>> {
  const run = await loadRun(runId, cwd);
  assertCanonicalDefinition(runId, definition, run.definition);
  return run;
}

async function loadShippedBuilderBuildDefinition(definitionPath: string): Promise<{ id: string; version: string }> {
  const definition = validateDefinition(await readJson(definitionPath));
  if (definition.id !== BUILDER_BUILD_FLOW_ID) {
    throw new BuilderBuildRunInputError("definition", `expected shipped definition id ${BUILDER_BUILD_FLOW_ID}`);
  }
  return definition;
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

function assertBundleSubjects(bundle: unknown, subject: string): void {
  if (!isRecord(bundle) || !Array.isArray(bundle.claims)) {
    throw new BuilderBuildRunInputError("evidence", "contains no normalized claims");
  }
  for (const claim of bundle.claims) {
    if (!isRecord(claim) || !isNonEmptyString(claim.subjectId) || claim.subjectId !== subject) {
      throw new BuilderBuildRunInputError("evidence.claims.subjectId", "must match the persisted run subject");
    }
  }
}

function trustBundleAttachOptions(cwd: string, evidence: BuilderBuildTrustBundleEvidenceInput): JsonObject {
  return {
    cwd,
    gate: evidence.gate,
    file: evidence.file,
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
