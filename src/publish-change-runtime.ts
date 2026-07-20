import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveTrustedLocalGitCommit } from "./lib/trusted-git.js";
import { deriveBuilderGateActionEnvelope, type GateActionEnvelope } from "./builder-gate-action-envelope.js";
import type { BuilderFlowRunResult } from "./builder-flow-run-adapter.js";
import { readLocalAssignmentStatus, resolveCurrentAssignmentActor } from "./cli/assignment-provider.js";
import { resolveEffectiveChangeProviderSettings } from "./cli/effective-change-provider-settings.js";
import { buildTrustBundle, validateTrustBundle } from "./cli/workflow-sidecar.js";
import type {
  AuthenticatedPublishChangeObservation,
  IssuedPublishChangeAction,
  PublishChangeIntent,
} from "./publish-change-operation-authority.js";
import { issuePublishChangeAction } from "./publish-change-operation-authority.js";
import {
  completePublishChangeOperation,
  executePublishChangeOperation,
  issuePublishChangeOperation,
  type CompletePublishChangeOperationInput,
  type ExecutePublishChangeOperationInput,
  type PublishChangeOperationDependencies,
} from "./publish-change-operation.js";

type AnyRecord = Record<string, any>;
export type PublishChangeRuntimeContext = { sessionDir: string; artifactRoot: string; projectRoot: string; slug: string };

/**
 * Provider-result persistence and Flow completion mechanics.  The Builder
 * runtime supplies its canonical Flow/projection adapters, but this module
 * owns the bounded receipt, recovery, trust-evidence, and trusted-head work.
 */
export type PublishChangeRuntimeDependencies<Result, Run> = {
  loadRun: (context: PublishChangeRuntimeContext) => Promise<Run>;
  manifestEvidence: (run: Run) => AnyRecord[];
  evaluateEvidence: (context: PublishChangeRuntimeContext, action: IssuedPublishChangeAction, evidence: { file: string; sha256: string }) => Promise<Run>;
  assertAdvanced: (run: Run, action: IssuedPublishChangeAction) => void;
  project: (context: PublishChangeRuntimeContext, action: IssuedPublishChangeAction, observation: AuthenticatedPublishChangeObservation, run: Run, attached: boolean, operation: string) => Result;
  assertSafeFile: (file: string, root: string, field: string) => void;
  pathExistsNoFollow: (file: string) => boolean;
  error: (field: string, message: string) => Error;
};

export type PublishChangeFacadeDependencies<Context extends PublishChangeRuntimeContext, Result, Run extends BuilderFlowRunResult> = {
  resolveSessionContext: (sessionDir: string) => Context;
  readState: (context: Context) => AnyRecord;
  assertSubject: (run: Run, subject: string) => void;
  openGates: (run: Run) => Array<{ id: string }>;
  loadRun: (context: Context) => Promise<Run>;
  manifestEvidence: (run: Run) => AnyRecord[];
  evaluateEvidence: (context: Context, action: IssuedPublishChangeAction, evidence: { file: string; sha256: string }) => Promise<Run>;
  assertAdvanced: (run: Run, action: IssuedPublishChangeAction) => void;
  project: (context: Context, action: IssuedPublishChangeAction, observation: AuthenticatedPublishChangeObservation, run: Run, attached: boolean, operation: string) => Result;
  assertSafeFile: (file: string, root: string, field: string) => void;
  pathExistsNoFollow: (file: string) => boolean;
  error: (field: string, message: string) => Error;
};

/** Public-operation facade; Builder supplies only canonical Flow adapters. */
export function createPublishChangeFacade<Context extends PublishChangeRuntimeContext, Result, Run extends BuilderFlowRunResult>(
  dependencies: PublishChangeFacadeDependencies<Context, Result, Run>,
): {
  issue(input: ExecutePublishChangeOperationInput): Promise<IssuedPublishChangeAction>;
  execute(input: ExecutePublishChangeOperationInput): Promise<Result>;
  complete(input: CompletePublishChangeOperationInput, observe: (request: IssuedPublishChangeAction) => AuthenticatedPublishChangeObservation | Promise<AuthenticatedPublishChangeObservation>): Promise<Result>;
} {
  const operationDependencies: PublishChangeOperationDependencies<Result, Run> = {
    resolveSessionContext: dependencies.resolveSessionContext,
    currentAction: (context, intent) => currentPublishChangeAction(context as Context, intent, dependencies as unknown as CurrentPublishChangeActionDependencies<Run>),
    ...createPublishChangeRuntimeDependencies({
      loadRun: (context) => dependencies.loadRun(context as Context),
      manifestEvidence: dependencies.manifestEvidence,
      evaluateEvidence: (context, action, evidence) => dependencies.evaluateEvidence(context as Context, action, evidence),
      assertAdvanced: dependencies.assertAdvanced,
      project: (context, action, observation, run, attached, operation) => dependencies.project(context as Context, action, observation, run, attached, operation),
      assertSafeFile: dependencies.assertSafeFile,
      pathExistsNoFollow: dependencies.pathExistsNoFollow,
      error: dependencies.error,
    }),
    operationStaleError: () => dependencies.error("publish-change.action", "does not match the current canonical run, gate visit, assignment actor, or provider configuration"),
  };
  return {
    issue: async (input) => await issuePublishChangeOperation(input, operationDependencies),
    execute: async (input) => await executePublishChangeOperation(input, operationDependencies),
    complete: async (input, observe) => await completePublishChangeOperation(input, observe, operationDependencies),
  };
}

export function createPublishChangeRuntimeDependencies<Result, Run>(
  dependencies: PublishChangeRuntimeDependencies<Result, Run>,
): Pick<PublishChangeOperationDependencies<Result, Run>, "assertTrustedHead" | "hasCommittedReceipt" | "recoverCommitted" | "persistResult" | "advanceGate" | "projectCompleted"> {
  return {
    assertTrustedHead: (context, action) => assertTrustedHead(context as PublishChangeRuntimeContext, action, dependencies),
    hasCommittedReceipt: (context, action) => hasCommittedReceipt(context as PublishChangeRuntimeContext, action, dependencies),
    recoverCommitted: (context, action, observation) => recoverCommitted(context as PublishChangeRuntimeContext, action, observation, dependencies),
    persistResult: (context, action, observation) => persistResult(context as PublishChangeRuntimeContext, action, observation, dependencies),
    advanceGate: (context, action, observation, sha256) => advanceGate(context as PublishChangeRuntimeContext, action, observation, sha256, dependencies),
    projectCompleted: (context, action, observation, run) => dependencies.project(context as PublishChangeRuntimeContext, action, observation, run, true, "publish-change completion"),
  };
}

export type CurrentPublishChangeActionDependencies<Run extends BuilderFlowRunResult> = {
  readState: (context: PublishChangeRuntimeContext) => AnyRecord;
  loadRun: (context: PublishChangeRuntimeContext) => Promise<Run>;
  assertSubject: (run: Run, subject: string) => void;
  openGates: (run: Run) => Array<{ id: string }>;
  error: (field: string, message: string) => Error;
};

/** Derive the issued action entirely from canonical state and trusted settings. */
export async function currentPublishChangeAction<Run extends BuilderFlowRunResult>(
  context: PublishChangeRuntimeContext,
  intent: PublishChangeIntent,
  dependencies: CurrentPublishChangeActionDependencies<Run>,
): Promise<IssuedPublishChangeAction> {
  const state = dependencies.readState(context);
  const refs = state.work_item_refs;
  if (!Array.isArray(refs) || refs.length !== 1 || typeof refs[0] !== "string" || refs[0].trim().length === 0) {
    throw dependencies.error("state.work_item_refs", "must contain exactly one selected Work Item for builder.build");
  }
  const run = await dependencies.loadRun(context);
  dependencies.assertSubject(run, refs[0]);
  const gates = dependencies.openGates(run);
  if (run.state.status !== "active" || gates.length !== 1) throw dependencies.error("publish-change", "requires exactly one active canonical gate");
  const envelope = deriveBuilderGateActionEnvelope({ sessionDir: context.sessionDir, projectRoot: context.projectRoot, run, definition: JSON.parse(fs.readFileSync(path.join(run.dir, "definition.json"), "utf8")) as AnyRecord });
  const operation = envelope.public_interfaces.mutations.find((mutation): mutation is Extract<GateActionEnvelope["public_interfaces"]["mutations"][number], { interface: "operation" }> => mutation.interface === "operation" && mutation.operation === "publish-change");
  if (!operation || operation.expectation_id !== "pull-request-opened" || operation.protocol.availability.status !== "configured") {
    throw dependencies.error("publish-change", "requires the configured canonical publish-change operation at pull-request-opened");
  }
  const effective = resolveEffectiveChangeProviderSettings(context.projectRoot, path.join(context.projectRoot, "context", "settings", "change-provider-settings.json"));
  if (effective.status !== "configured" || !effective.provider || typeof effective.provider !== "object") {
    throw dependencies.error("publish-change.provider", "is not configured for this project");
  }
  const assignment = readLocalAssignmentStatus(context.artifactRoot, context.slug);
  const actor = resolveCurrentAssignmentActor();
  if (!assignment.record || assignment.record.status !== "claimed" || (assignment.record.actor_key ?? assignment.assignee) !== actor.actorKey) {
    throw dependencies.error("publish-change.assignment", "is no longer held by the current actor");
  }
  return issuePublishChangeAction({ binding: operation.binding, provider: effective.provider as any, assignment_actor: actor.actorKey, intent });
}

function assertTrustedHead<Result, Run>(context: PublishChangeRuntimeContext, action: IssuedPublishChangeAction, dependencies: PublishChangeRuntimeDependencies<Result, Run>): void {
  if (resolveTrustedLocalGitCommit(context.projectRoot, action.head_ref) !== action.head_sha) {
    throw dependencies.error("publish-change.intent.head_sha", "does not match the trusted local head ref during commit");
  }
}

function payloadFor(action: IssuedPublishChangeAction, observation: AuthenticatedPublishChangeObservation): Buffer {
  return Buffer.from(`${JSON.stringify({ ...observation, operation_action_id: action.action_id }, null, 2)}\n`);
}

function persistResult<Result, Run>(context: PublishChangeRuntimeContext, action: IssuedPublishChangeAction, observation: AuthenticatedPublishChangeObservation, dependencies: PublishChangeRuntimeDependencies<Result, Run>): { file: string; sha256: string } {
  const file = path.join(context.sessionDir, "publish-change.result.json");
  const payload = payloadFor(action, observation);
  if (payload.byteLength > 65_536) throw dependencies.error("publish-change.result", "exceeds the 65,536 byte operation bound");
  const existing = readResult(context, dependencies);
  if (existing) {
    // A provider observation is a receipt, not an equivalence class.  In
    // particular, a different observed_at value proves this is a different
    // observation and cannot replay a prior receipt.
    if (!existing.equals(payload)) {
      throw dependencies.error("publish-change.result", "already exists with different authenticated operation bytes");
    }
    return { file, sha256: createHash("sha256").update(existing).digest("hex") };
  }
  const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(descriptor, payload); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  dependencies.assertSafeFile(file, context.sessionDir, "publish-change.result.json");
  return { file, sha256: createHash("sha256").update(payload).digest("hex") };
}

function readResult<Result, Run>(context: PublishChangeRuntimeContext, dependencies: PublishChangeRuntimeDependencies<Result, Run>): Buffer | null {
  const file = path.join(context.sessionDir, "publish-change.result.json");
  if (!dependencies.pathExistsNoFollow(file)) return null;
  dependencies.assertSafeFile(file, context.sessionDir, "publish-change.result.json");
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw dependencies.error("publish-change.result", "must be a regular file");
    if (stat.size > 65_536) throw dependencies.error("publish-change.result", "exceeds the 65,536 byte operation bound");
    return fs.readFileSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

async function hasCommittedReceipt<Result, Run>(context: PublishChangeRuntimeContext, action: IssuedPublishChangeAction, dependencies: PublishChangeRuntimeDependencies<Result, Run>): Promise<boolean> {
  const bytes = readResult(context, dependencies);
  if (!bytes) return false;
  try { if ((JSON.parse(bytes.toString("utf8")) as AnyRecord).operation_action_id !== action.action_id) return false; } catch { return false; }
  const resultSha256 = createHash("sha256").update(bytes).digest("hex");
  const run = await dependencies.loadRun(context);
  return dependencies.manifestEvidence(run).some((entry) => entry.gate_id === action.binding.gate_ids[0]
    && entry.producer === "publish-change-operation-authority" && entry.authority_trace === action.action_id
    && Array.isArray(entry.expectation_ids) && entry.expectation_ids.length === 1 && entry.expectation_ids[0] === "pull-request-opened"
    && manifestReferencesResultDigest(entry, resultSha256));
}

async function recoverCommitted<Result, Run>(context: PublishChangeRuntimeContext, action: IssuedPublishChangeAction, observation: AuthenticatedPublishChangeObservation, dependencies: PublishChangeRuntimeDependencies<Result, Run>): Promise<Result | null> {
  const bytes = readResult(context, dependencies);
  if (!bytes || !bytes.equals(payloadFor(action, observation))) return null;
  const run = await dependencies.loadRun(context);
  const attached = dependencies.manifestEvidence(run).some((entry) => entry.gate_id === action.binding.gate_ids[0]
    && Array.isArray(entry.expectation_ids) && entry.expectation_ids.length === 1 && entry.expectation_ids[0] === "pull-request-opened"
    && isRecord(entry.bundle) && Array.isArray(entry.bundle.claims)
    && entry.bundle.claims.some((claim: unknown) => isRecord(claim)
      && claim.fieldOrBehavior === `Authenticated publish-change operation ${action.action_id} observed ${observation.change_ref.state} provider record ${observation.change_ref.provider_record_id}`));
  return attached ? dependencies.project(context, action, observation, run, false, "publish-change recovery projection") : null;
}

function manifestReferencesResultDigest(entry: AnyRecord, resultSha256: string): boolean {
  if (!isRecord(entry.bundle) || !Array.isArray(entry.bundle.claims)) return false;
  return entry.bundle.claims.some((claim: unknown) => {
    if (!isRecord(claim) || !isRecord(claim.metadata) || !Array.isArray(claim.metadata.artifact_refs)) return false;
    return claim.metadata.artifact_refs.some((reference: unknown) => isRecord(reference) && reference.sha256 === resultSha256);
  });
}

async function advanceGate<Result, Run>(context: PublishChangeRuntimeContext, action: IssuedPublishChangeAction, observation: AuthenticatedPublishChangeObservation, resultSha256: string, dependencies: PublishChangeRuntimeDependencies<Result, Run>): Promise<Run> {
  const evidence = await writeEvidence(context, action, observation, resultSha256, dependencies);
  try {
    const run = await dependencies.evaluateEvidence(context, action, evidence);
    dependencies.assertAdvanced(run, action);
    return run;
  } finally { removeTemporaryFile(evidence.file, dependencies); }
}

async function writeEvidence<Result, Run>(context: PublishChangeRuntimeContext, action: IssuedPublishChangeAction, observation: AuthenticatedPublishChangeObservation, resultSha256: string, dependencies: PublishChangeRuntimeDependencies<Result, Run>): Promise<{ file: string; sha256: string }> {
  const file = path.join(context.sessionDir, `.publish-change.evidence-${randomBytes(16).toString("hex")}.json`);
  const bundle = await buildOperationTrustBundle(context, action, observation, resultSha256);
  if (!bundle) throw dependencies.error("publish-change", "could not build the required operation-bound trust bundle");
  const validation = await validateTrustBundle(bundle);
  if (validation.available && !validation.valid) throw dependencies.error("publish-change", `operation-bound trust bundle is invalid: ${validation.errors.join("; ")}`);
  const bytes = Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`);
  if (bytes.byteLength > 65_536) throw dependencies.error("publish-change", "operation-bound evidence exceeds the 65,536 byte bound");
  const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  dependencies.assertSafeFile(file, context.sessionDir, "publish-change temporary evidence");
  return { file, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function buildOperationTrustBundle(context: PublishChangeRuntimeContext, action: IssuedPublishChangeAction, observation: AuthenticatedPublishChangeObservation, resultSha256: string): Promise<unknown> {
  const timestamp = observation.observed_at;
  return await buildTrustBundle(context.slug, timestamp, [{
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
  }], [], [], [], context.artifactRoot, action.assignment_actor, { flowId: action.binding.definition_id, stepId: action.binding.step_id });
}

function removeTemporaryFile<Result, Run>(file: string, dependencies: PublishChangeRuntimeDependencies<Result, Run>): void {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw dependencies.error("publish-change temporary evidence", "was replaced before cleanup");
    fs.unlinkSync(file);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return;
    throw error;
  }
}

function isRecord(value: unknown): value is AnyRecord { return typeof value === "object" && value !== null && !Array.isArray(value); }
