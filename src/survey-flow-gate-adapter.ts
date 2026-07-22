import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
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
  /** Canonical projection stored with the server-owned review resolution. */
  readonly surveyInput: SurveyInput;
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

  assertSurveyProjectionBinding(resolved.surveyInput, derived.results, derived.replayedSession, run.state.subject, run.definition, run.config, input.gate);
  const trustBundle = buildSurveyTrustBundle(resolved.surveyInput, {
    projectionContextId: surveyProjectionContext(resolved.record, input.gate),
  }) as unknown as JsonObject;
  assertBundleBinding(trustBundle, run.state.subject, run.definition, run.config, input.gate);

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
    || !isRecord(value.surveyInput)) {
    throw new SurveyFlowGateInputError("reviewSessionRef", "did not resolve to canonical review state and projection");
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

function assertSurveyProjectionBinding(
  surveyInput: SurveyInput,
  results: readonly any[],
  replayedSession: ReviewQueueSessionState,
  subject: string,
  definition: unknown,
  config: unknown,
  gateId: string,
): void {
  const relevant = relevantSurveyClaims(surveyInput, definition, config, gateId);
  if (relevant.length === 0) {
    throw new SurveyFlowGateInputError("surveyInput.claims", "contains no claim matching the persisted current open Flow gate");
  }
  for (const claim of relevant) {
    if (!isRecord(claim.metadata) || claim.metadata.workflow_subject_ref !== subject) {
      throw new SurveyFlowGateInputError("surveyInput.claims.metadata.workflow_subject_ref", "must match the persisted Flow Run subject");
    }
    const candidateSet = surveyInput.candidateSets.find((entry) => entry.id === claim.candidateSetId);
    const candidate = candidateSet?.candidates.find((entry) => entry.id === (claim.candidateId ?? candidateSet.selectedCandidateId ?? candidateSet.candidates[0]?.id));
    const review = candidate ? surveyInput.reviewOutcomes.find((entry) => entry.candidateSetId === claim.candidateSetId && entry.candidateId === candidate.id) : undefined;
    const result = results.find((entry) => (
      entry?.reviewDecision?.spec?.projection?.reviewOutcomeId === review?.id
      && entry?.reviewDecision?.spec?.candidateId === candidate?.id
      && entry?.reviewDecision?.spec?.status === review?.status
      && entry?.reviewDecision?.status?.appliedToClaimIds?.includes(claim.id)
    ));
    if (!candidateSet || !candidate || !review || !result) {
      throw new SurveyFlowGateInputError("surveyInput.reviewOutcomes", `claim ${claim.id} is not bound to a canonical server-derived review decision`);
    }
    const reviewItem = replayedSession.items.find((item) => item.metadata.name === result.reviewItemName);
    if (!reviewItem) {
      throw new SurveyFlowGateInputError("surveyInput.reviewOutcomes", `claim ${claim.id} is not bound to a canonical replayed ReviewItem`);
    }
    assertReviewedProjectionMatches({ surveyInput, claim, candidateSet, candidate, review, result, reviewItem });
  }
}

function assertReviewedProjectionMatches(input: {
  surveyInput: SurveyInput;
  claim: SurveyInput["claims"][number];
  candidateSet: SurveyInput["candidateSets"][number];
  candidate: SurveyInput["candidateSets"][number]["candidates"][number];
  review: SurveyInput["reviewOutcomes"][number];
  result: any;
  reviewItem: ReviewQueueSessionState["items"][number];
}): void {
  const reviewedCandidate = input.result.selectedCandidate;
  const decision = input.result.reviewDecision?.spec;
  const target = reviewedCandidate?.claimTarget;
  const projection = reviewedCandidate?.projection;
  const rawSource = input.surveyInput.rawSources.find((entry) => entry.id === projection?.rawSourceId);
  const extraction = input.surveyInput.extractions.find((entry) => entry.id === input.candidate.extractionId);
  const fail = (field: string): never => {
    throw new SurveyFlowGateInputError(`surveyInput.${field}`, `does not match the canonical replayed ReviewItem for claim ${input.claim.id}`);
  };
  const same = (field: string, left: unknown, right: unknown) => {
    if (!isDeepStrictEqual(left, right)) fail(field);
  };

  same("candidateSets.target", input.candidateSet.target, input.reviewItem.spec.target);
  same("candidateSets.status", input.candidateSet.status, input.reviewItem.spec.candidateSetStatus);
  same("claims.id", input.claim.id, target?.claimId);
  same("claims.subjectType", input.claim.subjectType, target?.subjectType);
  same("claims.subjectId", input.claim.subjectId, target?.subjectId);
  same("claims.facet", input.claim.facet, target?.facet);
  same("claims.claimType", input.claim.claimType, target?.claimType);
  same("claims.fieldOrBehavior", input.claim.fieldOrBehavior, target?.fieldOrBehavior);
  same("claims.impactLevel", input.claim.impactLevel, target?.impactLevel);
  same("claims.candidateSetId", input.claim.candidateSetId, projection?.candidateSetId);
  same("claims.candidateId", input.candidate.id, projection?.candidateId);
  same("reviewOutcomes.id", input.review.id, projection?.reviewOutcomeId);
  same("candidates.id", input.candidate.id, input.result.selectedCandidateId);
  same("candidates.value", input.candidate.value, input.result.effectiveValue);
  same("candidateSets.selectedCandidateId", input.candidateSet.selectedCandidateId, input.candidate.id);
  if (input.claim.value !== undefined) same("claims.value", input.claim.value, input.result.effectiveValue);

  const boundRawSource = rawSource ?? fail("rawSources");
  const boundExtraction = extraction ?? fail("extractions");
  same("rawSources.id", boundRawSource.id, reviewedCandidate?.source?.sourceId);
  same("rawSources.kind", boundRawSource.kind, reviewedCandidate?.source?.kind);
  same("rawSources.sourceRef", boundRawSource.sourceRef, reviewedCandidate?.source?.sourceRef);
  same("rawSources.observedAt", boundRawSource.observedAt, reviewedCandidate?.source?.observedAt);
  same("rawSources.fetchedAt", boundRawSource.fetchedAt, reviewedCandidate?.source?.fetchedAt);
  same("rawSources.checksum", boundRawSource.checksum, reviewedCandidate?.source?.checksum);
  same("rawSources.locatorScheme", boundRawSource.locatorScheme, reviewedCandidate?.source?.locatorScheme);
  same("extractions.id", boundExtraction.id, reviewedCandidate?.extraction?.extractionId);
  same("extractions.target", boundExtraction.target, reviewedCandidate?.extraction?.target);
  same("extractions.confidence", boundExtraction.confidence, reviewedCandidate?.extraction?.confidence);
  same("extractions.extractor", boundExtraction.extractor, reviewedCandidate?.extraction?.extractor);
  same("extractions.extractedAt", boundExtraction.extractedAt, reviewedCandidate?.extraction?.extractedAt);
  same("extractions.value", boundExtraction.value, input.result.effectiveValue);

  same("reviewOutcomes.status", input.review.status, decision?.status);
  same("reviewOutcomes.actor", input.review.actor, decision?.actor?.id);
  same("reviewOutcomes.reviewedAt", input.review.reviewedAt, decision?.reviewedAt);
  same("reviewOutcomes.resolution", input.review.resolution, decision?.resolution);
  same("reviewOutcomes.resolutionReason", input.review.resolutionReason, decision?.resolutionReason);
  same("reviewOutcomes.editedValue", decision?.editedValue, input.result.editedValue);
}

function assertBundleBinding(
  bundle: JsonObject,
  subject: string,
  definition: unknown,
  config: unknown,
  gateId: string,
): void {
  const claims = Array.isArray(bundle.claims) ? bundle.claims.filter(isRecord) : [];
  const gate = findCurrentGate(definition, gateId);
  const selectors = expectationsForGate(gate, config as any).map((expectation: any) => expectation.bundle_claim ?? expectation.claim).filter(Boolean);
  const relevant = claims.filter((claim) => selectors.some((selector: any) => matchesSelector(claim, selector)));
  if (relevant.length === 0) throw new SurveyFlowGateInputError("trustBundle.claims", "contains no claim matching the persisted current open Flow gate");
  for (const claim of relevant) {
    if (!isRecord(claim.metadata) || claim.metadata.workflow_subject_ref !== subject) {
      throw new SurveyFlowGateInputError("trustBundle.claims.metadata.workflow_subject_ref", "must match the persisted Flow Run subject");
    }
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
