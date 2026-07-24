import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  continuePausedGate,
  expectationsForGate,
  flowRunHead,
  loadRun,
  type FlowLifecycleRequest,
  type FlowPausedGateContinuationResult,
  type JsonObject,
} from "@kontourai/flow";
import {
  buildCanonicalReviewedTrustInput,
  buildSurveyTrustBundle,
  type ReviewDecision,
  type ReviewSessionEvent,
  type SurveyInput,
} from "@kontourai/survey";
import {
  deriveServerReviewSessionApplyResult,
  type ServerReviewSessionRecord,
} from "@kontourai/survey/review-workbench/server-review-session";
import type { ReviewQueueSessionState } from "@kontourai/survey/review-workbench";

/** Input rejected before a Survey bundle can be attached to a Flow Run. */
export class SurveyFlowGateInputError extends Error {
  readonly code = "SURVEY_FLOW_GATE_INVALID_INPUT" as const;
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`invalid Survey Flow gate input for ${field}: ${reason}`);
    this.name = "SurveyFlowGateInputError";
    this.field = field;
  }
}

export interface ResolvedSurveyFlowGateReviewSession {
  /** Server-persisted review-session record resolved by the host capability. */
  readonly record: ServerReviewSessionRecord;
  readonly events: readonly ReviewSessionEvent[];
  readonly currentSnapshot: ReviewQueueSessionState;
  readonly currentEventCount: number;
  /** Producer identity recorded on Survey's canonical trust input. */
  readonly projectionSource: string;
  /** Host-owned binding between this review session and its Flow Run subject. */
  readonly workflowSubjectRef: string;
}

export interface SurveyFlowGateReviewSessionResolver {
  resolve(reviewSessionRef: string): ResolvedSurveyFlowGateReviewSession | Promise<ResolvedSurveyFlowGateReviewSession>;
}

export interface SurveyFlowGateAdapterDependencies {
  /** Host-owned authority capability, configured independently of each request. */
  readonly reviewSessions: SurveyFlowGateReviewSessionResolver;
}

export interface ContinuePausedFlowGateFromSurveyInput {
  /** Flow Run identity and persistence root. */
  readonly runId: string;
  readonly cwd?: string;
  /** Exact run state observed by the host before it presents review evidence. */
  readonly expectedRunHead: string;
  /** The persisted, currently open Flow gate this review is allowed to satisfy. */
  readonly gate: string;
  /** An explicit lifecycle authority; Survey decisions never imply resume authority. */
  readonly resume: FlowLifecycleRequest & { readonly at?: string };
  /** Opaque handle resolved by the host-owned review-session capability. */
  readonly reviewSessionRef: string;
  /** Evaluation instant shared by Flow's freshness and lifecycle validation. */
  readonly now?: string;
}

export interface ContinuePausedFlowGateFromSurveyResult {
  readonly review: {
    readonly ref: string;
    readonly record: ServerReviewSessionRecord;
    readonly decisions: readonly ReviewDecision[];
    readonly results: readonly unknown[];
  };
  /** The Survey-produced immutable bundle Flow attached only when continuation passed. */
  readonly trustBundle: JsonObject;
  /** Flow remains the owner of attachment, evaluation, and lifecycle transition. */
  readonly flow: FlowPausedGateContinuationResult;
}

/**
 * Continue an already-paused Flow gate from canonical, server-derived Survey
 * review state. This adapter deliberately adds no gate semantics: it validates
 * identity bindings, projects Survey's bundle, then delegates the entire
 * attach/evaluate/resume transaction to Flow's public operation.
 */
export async function continuePausedFlowGateFromSurvey(
  input: ContinuePausedFlowGateFromSurveyInput,
  dependencies: SurveyFlowGateAdapterDependencies,
): Promise<ContinuePausedFlowGateFromSurveyResult> {
  assertInputShape(input);
  assertDependencies(dependencies);
  const cwd = input.cwd ?? process.cwd();
  const run = await loadRun(input.runId, cwd);
  assertRunAndGateBinding(run, input);
  const resolved = await dependencies.reviewSessions.resolve(input.reviewSessionRef);
  assertResolvedReviewSession(resolved);

  const derived = deriveServerReviewSessionApplyResult({
    record: resolved.record,
    events: resolved.events,
    currentSnapshot: resolved.currentSnapshot,
    currentEventCount: resolved.currentEventCount,
    requiredResolvedItems: "all",
  });
  if (!derived.ok) {
    throw new SurveyFlowGateInputError("reviewSession", derived.issues.map((issue) => issue.message).join(" ") || "does not contain a complete server-derived review result");
  }

  assertWorkflowSubjectBinding(resolved.workflowSubjectRef, run.state.subject);
  const canonical = buildCanonicalReviewedTrustInput({
    source: resolved.projectionSource,
    generatedAt: resolved.record.updatedAt,
    projectionContextId: surveyProjectionContext(resolved.record, input.gate),
    items: resolved.record.snapshot.items,
    results: derived.results,
  });
  assertCanonicalProjectionMatchesGate(canonical.surveyInput, run.definition, run.config, input.gate);
  const trustBundle = buildSurveyTrustBundle(canonical.surveyInput, {
    projectionContextId: canonical.projectionContextId,
  }) as unknown as JsonObject;

  const snapshot = await writeInvocationSnapshot(trustBundle);
  try {
    const flow = await continuePausedGate(input.runId, {
      cwd,
      gate: input.gate,
      expectedRunHead: input.expectedRunHead,
      evidence: { file: snapshot, kind: "trust.bundle" },
      resumeOnPass: true,
      resume: input.resume,
      ...(input.now ? { now: input.now } : {}),
    });
    return {
      review: {
        ref: input.reviewSessionRef,
        record: resolved.record,
        decisions: derived.decisions,
        results: derived.results,
      },
      trustBundle,
      flow,
    };
  } finally {
    // The Flow operation reads/copies the snapshot before it returns. Cleanup is
    // hygiene, not part of its durable commit, and must never reverse success.
    await rm(path.dirname(snapshot), { recursive: true, force: true }).catch(() => undefined);
  }
}

/** A small in-process host surface; it intentionally invokes the same adapter. */
export function createSurveyFlowGateAdapter(dependencies: SurveyFlowGateAdapterDependencies) {
  assertDependencies(dependencies);
  return {
    continuePausedGate: (input: ContinuePausedFlowGateFromSurveyInput) => continuePausedFlowGateFromSurvey(input, dependencies),
  };
}

function assertInputShape(input: ContinuePausedFlowGateFromSurveyInput): void {
  for (const forbidden of ["reviewSession", "surveyInput", "record", "events", "currentSnapshot", "currentEventCount"]) {
    if (Object.prototype.hasOwnProperty.call(input, forbidden)) {
      throw new SurveyFlowGateInputError(forbidden, "is authority-bearing data and cannot be supplied in a continuation request");
    }
  }
  if (!isNonEmptyString(input.runId)) throw new SurveyFlowGateInputError("runId", "must be a non-empty string");
  if (!isNonEmptyString(input.gate)) throw new SurveyFlowGateInputError("gate", "must be a non-empty string");
  if (!isNonEmptyString(input.reviewSessionRef)) throw new SurveyFlowGateInputError("reviewSessionRef", "must be a non-empty opaque reference");
  if (!isSha256(input.expectedRunHead)) throw new SurveyFlowGateInputError("expectedRunHead", "must be a SHA-256 digest");
  if (!input.resume || !isNonEmptyString(input.resume.reason) || !isRecord(input.resume.authority)) {
    throw new SurveyFlowGateInputError("resume", "must contain an explicit lifecycle reason and authority");
  }
}

function assertDependencies(dependencies: SurveyFlowGateAdapterDependencies): void {
  if (!isRecord(dependencies) || !isRecord(dependencies.reviewSessions) || typeof dependencies.reviewSessions.resolve !== "function") {
    throw new SurveyFlowGateInputError("dependencies.reviewSessions", "must be a host-owned review-session resolver capability");
  }
}

function assertResolvedReviewSession(value: unknown): asserts value is ResolvedSurveyFlowGateReviewSession {
  if (!isRecord(value)
    || !isRecord(value.record)
    || !Array.isArray(value.events)
    || !isRecord(value.currentSnapshot)
    || !Number.isSafeInteger(value.currentEventCount)
    || value.currentEventCount < 0
    || !isNonEmptyString(value.projectionSource)
    || !isNonEmptyString(value.workflowSubjectRef)
    || Object.prototype.hasOwnProperty.call(value, "surveyInput")) {
    throw new SurveyFlowGateInputError("reviewSessionRef", "did not resolve to canonical review state and workflow binding");
  }
}

function assertRunAndGateBinding(run: Awaited<ReturnType<typeof loadRun>>, input: ContinuePausedFlowGateFromSurveyInput): void {
  if (flowRunHead(run.state) !== input.expectedRunHead.toLowerCase()) {
    throw new SurveyFlowGateInputError("expectedRunHead", "does not match the persisted Flow Run");
  }
  if (run.state.status !== "paused") {
    throw new SurveyFlowGateInputError("flowRun.status", "must be paused before a Survey review can continue it");
  }
  const gate = findCurrentGate(run.definition, input.gate);
  if (gate.step !== run.state.current_step) {
    throw new SurveyFlowGateInputError("gate", "must match the persisted current open Flow gate");
  }
}

function assertCanonicalProjectionMatchesGate(
  surveyInput: SurveyInput,
  definition: unknown,
  config: unknown,
  gateId: string,
): void {
  const relevant = relevantSurveyClaims(surveyInput, definition, config, gateId);
  if (relevant.length === 0) {
    throw new SurveyFlowGateInputError("canonicalSurveyInput.claims", "contains no claim matching the persisted current open Flow gate");
  }
}

function assertWorkflowSubjectBinding(resolvedSubject: string, runSubject: string): void {
  if (resolvedSubject !== runSubject) {
    throw new SurveyFlowGateInputError("reviewSession.workflowSubjectRef", "must match the persisted Flow Run subject");
  }
}

function relevantSurveyClaims(surveyInput: SurveyInput, definition: unknown, config: unknown, gateId: string) {
  const gate = findCurrentGate(definition, gateId);
  const selectors = expectationsForGate(gate, config as any).map((expectation: any) => expectation.bundle_claim ?? expectation.claim).filter(Boolean);
  return surveyInput.claims.filter((claim) => selectors.some((selector: any) => matchesSelector(claim as unknown as Record<string, unknown>, selector)));
}

function findCurrentGate(definition: unknown, gateId: string): any {
  const gates = isRecord(definition) && isRecord(definition.gates) ? definition.gates : null;
  const gate = gates?.[gateId];
  if (!gate) throw new SurveyFlowGateInputError("gate", "does not exist on the persisted Flow definition");
  return { ...gate, id: gateId };
}

function matchesSelector(claim: Record<string, unknown>, selector: Record<string, unknown>): boolean {
  return selector.claimType === claim.claimType
    && (!selector.subjectType || selector.subjectType === claim.subjectType)
    && (!selector.subjectId || selector.subjectId === claim.subjectId);
}

async function writeInvocationSnapshot(bundle: JsonObject): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "flow-agents-survey-gate-"));
  const snapshot = path.join(directory, "survey.trust.bundle.json");
  await writeFile(snapshot, `${JSON.stringify(bundle)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return snapshot;
}

function surveyProjectionContext(record: ServerReviewSessionRecord, gate: string): string {
  const tuple = JSON.stringify(["kontourai.flow-agents.survey-flow-gate-projection.v1", record.sessionName, record.snapshotHash, gate]);
  return `survey-review-${createHash("sha256").update(tuple).digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}
