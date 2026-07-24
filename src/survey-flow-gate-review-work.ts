import { createHash } from "node:crypto";
import {
  expectationsForGate,
  flowRunHead,
  flowTransitionRef,
  loadRun,
  type FlowExpectation,
} from "@kontourai/flow";
import type { ReviewItem } from "@kontourai/survey";
import { SurveyFlowGateInputError } from "./survey-flow-gate-adapter.js";

const BINDING_VERSION = "kontourai.flow-agents.survey-gate-review-work.v1";

export interface DiscoverSurveyGateReviewWorkInput {
  readonly runId: string;
  readonly cwd?: string;
  readonly gate: string;
  /** Exact run state on which the discovery decision is based. */
  readonly expectedRunHead: string;
  /**
   * Explicit host classification of expectations handled by a Survey producer.
   * Claim-type naming is producer-owned, so this adapter never guesses it.
   */
  readonly reviewExpectationIds: readonly string[];
}

export interface SurveyGateReviewWorkRequest {
  readonly id: string;
  readonly bindingVersion: typeof BINDING_VERSION;
  readonly flow: {
    readonly runId: string;
    readonly runHead: string;
    /** Stable identity of the blocking transition; unlike runHead, pause does not change it. */
    readonly blockedTransitionRef: string;
    readonly definitionId: string;
    readonly definitionVersion: string;
    readonly subject: string;
    readonly step: string;
    readonly gate: string;
    readonly expectationId: string;
  };
  readonly expectation: {
    readonly description: string;
    readonly exploreHint?: string;
    readonly claim: {
      readonly claimType: string;
      readonly subjectType?: string;
      readonly subjectId?: string;
      readonly acceptedStatuses?: readonly string[];
    };
  };
}

export interface SurveyGateReviewWorkProducer {
  createReviewItem(request: SurveyGateReviewWorkRequest): ReviewItem | Promise<ReviewItem>;
}

export interface SurveyGateReviewWorkQueue {
  publish(input: {
    readonly idempotencyKey: string;
    readonly request: SurveyGateReviewWorkRequest;
    readonly item: ReviewItem;
  }): unknown | Promise<unknown>;
}

export interface PublishSurveyGateReviewWorkDependencies {
  readonly producer: SurveyGateReviewWorkProducer;
  readonly queue: SurveyGateReviewWorkQueue;
}

export interface PublishedSurveyGateReviewWork {
  readonly request: SurveyGateReviewWorkRequest;
  readonly item: ReviewItem;
  readonly publication: unknown;
}

/**
 * Discover explicitly classified, required review expectations that the
 * persisted current gate reports missing. This is read-only and exact-head
 * bound; it neither evaluates the gate nor fabricates review candidates.
 */
export async function discoverSurveyGateReviewWork(
  input: DiscoverSurveyGateReviewWorkInput,
): Promise<SurveyGateReviewWorkRequest[]> {
  assertDiscoveryInput(input);
  const run = await loadRun(input.runId, input.cwd ?? process.cwd());
  const head = flowRunHead(run.state);
  if (head !== input.expectedRunHead.toLowerCase()) {
    throw new SurveyFlowGateInputError("expectedRunHead", "does not match the persisted Flow Run");
  }
  const gate = findGate(run.definition, input.gate);
  if (gate.step !== run.state.current_step) {
    throw new SurveyFlowGateInputError("gate", "must match the persisted current Flow gate");
  }
  const outcome = [...(run.state.gate_outcomes ?? [])]
    .reverse()
    .find((entry: any) => entry?.gate_id === input.gate);
  if (!outcome || outcome.status !== "block" || !Array.isArray(outcome.missing)) {
    throw new SurveyFlowGateInputError("gate", "must have a persisted blocking outcome with missing expectations");
  }
  if (run.state.status !== "blocked" && run.state.status !== "paused") {
    throw new SurveyFlowGateInputError("flowRun.status", "must be blocked or paused at a blocking gate");
  }

  const expectations = expectationsForGate(gate, run.config) as FlowExpectation[];
  const byId = new Map(expectations.map((expectation) => [expectation.id, expectation]));
  const selected = [...new Set(input.reviewExpectationIds)];
  for (const id of selected) {
    const expectation = byId.get(id);
    if (!expectation) throw new SurveyFlowGateInputError("reviewExpectationIds", `contains unknown expectation ${id}`);
    if (!expectation.required) throw new SurveyFlowGateInputError("reviewExpectationIds", `contains optional expectation ${id}`);
  }

  return selected
    .filter((id) => outcome.missing.includes(id))
    .map((id) => buildRequest(run, gate, byId.get(id)!, outcome, head));
}

/**
 * Bind producer-authored Survey review work to its originating Flow
 * expectation. The producer remains the authority for candidates and source
 * provenance; the adapter adds only immutable workflow correlation metadata.
 */
export function bindSurveyGateReviewItem(
  request: SurveyGateReviewWorkRequest,
  item: ReviewItem,
): ReviewItem {
  assertReviewItemMatches(request, item);
  return {
    ...item,
    metadata: {
      ...item.metadata,
      annotations: {
        ...(item.metadata.annotations ?? {}),
        "flow.kontourai.io/review-work-id": request.id,
        "flow.kontourai.io/run-id": request.flow.runId,
        "flow.kontourai.io/run-head": request.flow.runHead,
        "flow.kontourai.io/blocked-transition-ref": request.flow.blockedTransitionRef,
        "flow.kontourai.io/gate-id": request.flow.gate,
        "flow.kontourai.io/expectation-id": request.flow.expectationId,
        "flow.kontourai.io/workflow-subject-ref": request.flow.subject,
      },
    },
  };
}

/** Discover, producer-materialize, validate, bind, and publish review work. */
export async function publishSurveyGateReviewWork(
  input: DiscoverSurveyGateReviewWorkInput,
  dependencies: PublishSurveyGateReviewWorkDependencies,
): Promise<PublishedSurveyGateReviewWork[]> {
  if (!dependencies?.producer || typeof dependencies.producer.createReviewItem !== "function") {
    throw new SurveyFlowGateInputError("dependencies.producer", "must create canonical Survey ReviewItems");
  }
  if (!dependencies.queue || typeof dependencies.queue.publish !== "function") {
    throw new SurveyFlowGateInputError("dependencies.queue", "must publish into a host-owned review queue");
  }
  const requests = await discoverSurveyGateReviewWork(input);
  const published: PublishedSurveyGateReviewWork[] = [];
  for (const request of requests) {
    const item = bindSurveyGateReviewItem(request, await dependencies.producer.createReviewItem(request));
    const publication = await dependencies.queue.publish({ idempotencyKey: request.id, request, item });
    published.push({ request, item, publication });
  }
  return published;
}

function buildRequest(run: any, gate: any, expectation: FlowExpectation, outcome: any, head: string): SurveyGateReviewWorkRequest {
  const selector = expectation.bundle_claim;
  const transition = outcome.transition_validation?.transition
    ?? [...(run.state.transitions ?? [])].reverse().find((entry: any) => entry?.gate_id === gate.id && entry?.status === "blocked");
  if (!transition) throw new SurveyFlowGateInputError("gate", "blocking outcome has no persisted transition identity");
  const blockedTransitionRef = flowTransitionRef(transition);
  const identity = [BINDING_VERSION, run.state.run_id, blockedTransitionRef, gate.id, expectation.id];
  return {
    id: `survey-gate-review-${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`,
    bindingVersion: BINDING_VERSION,
    flow: {
      runId: run.state.run_id,
      runHead: head,
      blockedTransitionRef,
      definitionId: run.state.definition_id,
      definitionVersion: run.state.definition_version,
      subject: run.state.subject,
      step: gate.step,
      gate: gate.id,
      expectationId: expectation.id,
    },
    expectation: {
      description: expectation.description,
      ...(expectation.explore_hint ? { exploreHint: expectation.explore_hint } : {}),
      claim: {
        claimType: selector.claimType,
        ...(selector.subjectType ? { subjectType: selector.subjectType } : {}),
        ...(selector.subjectId ? { subjectId: selector.subjectId } : {}),
        ...(selector.accepted_statuses ? { acceptedStatuses: [...selector.accepted_statuses] } : {}),
      },
    },
  };
}

function assertReviewItemMatches(request: SurveyGateReviewWorkRequest, item: ReviewItem): void {
  if (!item || item.apiVersion !== "survey.kontourai.io/v1alpha1" || item.kind !== "ReviewItem") {
    throw new SurveyFlowGateInputError("reviewItem", "must be a canonical Survey ReviewItem");
  }
  if (!isNonEmptyString(item.metadata?.name)) {
    throw new SurveyFlowGateInputError("reviewItem.metadata.name", "must be a non-empty string");
  }
  if (!Array.isArray(item.spec?.candidates) || item.spec.candidates.length === 0) {
    throw new SurveyFlowGateInputError("reviewItem.spec.candidates", "must be supplied by the producer");
  }
  for (const candidate of item.spec.candidates) {
    const target = candidate?.claimTarget;
    const expected = request.expectation.claim;
    if (!target || target.claimType !== expected.claimType
      || (expected.subjectType && target.subjectType !== expected.subjectType)
      || (expected.subjectId && target.subjectId !== expected.subjectId)) {
      throw new SurveyFlowGateInputError(
        "reviewItem.spec.candidates.claimTarget",
        `must match Flow expectation ${request.flow.expectationId}`,
      );
    }
  }
  const annotations = item.metadata.annotations ?? {};
  for (const key of [
    "flow.kontourai.io/review-work-id",
    "flow.kontourai.io/run-id",
    "flow.kontourai.io/run-head",
    "flow.kontourai.io/blocked-transition-ref",
    "flow.kontourai.io/gate-id",
    "flow.kontourai.io/expectation-id",
    "flow.kontourai.io/workflow-subject-ref",
  ]) {
    if (key in annotations) {
      throw new SurveyFlowGateInputError(`reviewItem.metadata.annotations.${key}`, "is adapter-owned and cannot be producer-supplied");
    }
  }
}

function assertDiscoveryInput(input: DiscoverSurveyGateReviewWorkInput): void {
  if (!isNonEmptyString(input.runId)) throw new SurveyFlowGateInputError("runId", "must be a non-empty string");
  if (!isNonEmptyString(input.gate)) throw new SurveyFlowGateInputError("gate", "must be a non-empty string");
  if (!/^[a-f0-9]{64}$/i.test(input.expectedRunHead)) throw new SurveyFlowGateInputError("expectedRunHead", "must be a SHA-256 digest");
  if (!Array.isArray(input.reviewExpectationIds) || input.reviewExpectationIds.length === 0
    || input.reviewExpectationIds.some((id) => !isNonEmptyString(id))) {
    throw new SurveyFlowGateInputError("reviewExpectationIds", "must explicitly select at least one expectation id");
  }
}

function findGate(definition: any, gateId: string): any {
  const gate = definition?.gates?.[gateId];
  if (!gate) throw new SurveyFlowGateInputError("gate", "does not exist on the persisted Flow definition");
  return { ...gate, id: gateId };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
