/**
 * Routed review for distilled memory claims.
 *
 * Policy owner: the Knowledge Kit. Verdict owner: Survey. An uncontested claim
 * is recorded as `proposed` (recallable, labelled unreviewed). A change a rule
 * flags is `routed`: it still records and recalls as proposed, and also becomes
 * a Survey review item that a person decides.
 *
 * A decision embeds the exact input and policy its rules read, so the outcome
 * can be recomputed from the record alone (`recomputeMemoryRouting`). Rules are
 * pure functions of that input; there is no clock and no model call here.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "@kontourai/relay";
import {
  currentProposedReviewItem, foldCandidateVerifications, reviewResourceApiVersion, runSupportVerifier,
  type CandidateVerification, type RunSupportVerifierOptions, type ReviewDecision, type ReviewItem, type ReviewSessionEvent, type SupportVerifier,
} from "@kontourai/survey";
import {
  MemoryClaimError, assertMemoryClaim, foldMemoryText, memoryIntervalsOverlap, memorySlotKey, memoryValuesEqual, readMemoryVisibility, readAudienceList,
  type MemoryAgreement, type MemoryClaim, type MemoryClaimPosture, type MemoryVisibility,
} from "./memory-claims.js";

export const MEMORY_ROUTING_VERSION = "1.0" as const;
export const MEMORY_ROUTING_RULE_IDS = [
  "contradicted-by-verification",
  "conflicting-current-values",
  "consequential-supersession",
  "entity-identity-change",
  "low-extraction-agreement",
  "visibility-widening",
] as const;
export type MemoryRoutingRuleId = (typeof MEMORY_ROUTING_RULE_IDS)[number];

export interface MemoryRoutingPolicy {
  version: typeof MEMORY_ROUTING_VERSION;
  /** Passes needed to measure agreement. Fewer routes as low agreement: unmeasured is not agreed. */
  minPasses: number;
  /** Smallest share of passes that must produce an equivalent claim. */
  minAgreement: number;
  /** Properties that may hold several values at once; every other property is single-valued. */
  multiValued: string[];
  /** Superseding a claim on one of these goes to review. `"*"` matches everything. */
  consequential: { properties: string[]; subjectTypes: string[] };
}
export const DEFAULT_MEMORY_ROUTING_POLICY: Readonly<MemoryRoutingPolicy> = Object.freeze({
  version: MEMORY_ROUTING_VERSION, minPasses: 2, minAgreement: 1, multiValued: [], consequential: { properties: [], subjectTypes: [] },
});

/** A bound a claim's visibility must stay within. Null is undeclared, which Surface reads as sealed. */
export interface MemoryVisibilityBaseline { ref: string; visibility: MemoryVisibility | null }
export interface MemoryClaimRoutingInput {
  type: "claim";
  claim: MemoryClaim;
  /** Current claims in the same slot. Accumulation (which claims are current) is Surface's; the caller supplies them. */
  current: MemoryClaim[];
  /** Survey support-verification records bound to this claim's value. */
  verifications: CandidateVerification[];
  /** Null when no extraction passes were measured. */
  agreement: MemoryAgreement | null;
  baselines: MemoryVisibilityBaseline[];
}
export interface MemoryEntityRoutingInput {
  type: "entity";
  /** The Survey entity-review proposal's content-addressed id; Survey owns its contents and its review item. */
  proposalRef: string;
  /** Every operation the proposal's alternatives carry (`merge`, `split`, `alias`, `same-as`, `related-to`, `domain:*`). */
  operations: string[];
  /** Every subject the proposal names, as Survey's `SubjectRef`, sorted. Not flattened: a type or id may hold any character. */
  subjects: { subjectType: string; subjectId: string }[];
}
/**
 * The part of Survey's `EntityProposal` (kontourai/survey#243, `createEntityProposal`) this Kit reads. Structural so
 * the Kit does not import an unreleased Survey; pass the real proposal object.
 */
export interface SurveyEntityProposalLike {
  id: string;
  spec: { alternatives: readonly { operation: string; subjects: readonly { subjectType: string; subjectId: string }[] }[] };
}
export type MemoryRoutingInput = MemoryClaimRoutingInput | MemoryEntityRoutingInput;

export interface MemoryRoutingReason { rule: MemoryRoutingRuleId; detail: Record<string, unknown> }
export interface MemoryRoutingDecision {
  schema_version: typeof MEMORY_ROUTING_VERSION;
  /** `sha256:` digest of `input` and `policy`. */
  id: string;
  changeId: string;
  changeType: "claim" | "entity";
  outcome: "proposed" | "routed";
  reasons: MemoryRoutingReason[];
  /** Every rule that ran, so a rule that never ran cannot read as one that passed. */
  evaluated: MemoryRoutingRuleId[];
  input: MemoryRoutingInput;
  policy: MemoryRoutingPolicy;
}

interface RoutingRule {
  id: MemoryRoutingRuleId;
  appliesTo: MemoryRoutingInput["type"];
  check(input: never, policy: MemoryRoutingPolicy): Record<string, unknown> | undefined;
}
const rule = <T extends MemoryRoutingInput>(id: MemoryRoutingRuleId, appliesTo: T["type"], check: (input: T, policy: MemoryRoutingPolicy) => Record<string, unknown> | undefined): RoutingRule =>
  ({ id, appliesTo, check: check as RoutingRule["check"] });

const agreementWellFormed = (a: MemoryAgreement): boolean => Number.isInteger(a.passes) && Number.isInteger(a.agreeing) && a.passes >= 1 && a.agreeing >= 0 && a.agreeing <= a.passes;
const SEALED: MemoryVisibility = { kind: "restricted", audiences: [] };
/**
 * Whether `inner` is no more visible than `outer` in Surface's lattice: `meetVisibility(inner, outer)` equals `inner`.
 * Surface's `meetVisibility` is merged (surface#356) but not in a published release, so this is the one place the Kit
 * states the order. It is checked against Surface's own meet vectors, and against the real function as soon as the
 * installed Surface has one. Undeclared or unreadable is sealed, as in Surface: omission never widens.
 */
export function memoryVisibilityWithin(inner: unknown, outer: unknown): boolean {
  const a = surfaceReading(inner), b = surfaceReading(outer);
  if (b.kind === "public") return true;
  if (a.kind === "public") return false;
  return a.audiences.every(audience => b.audiences.includes(audience));
}

/**
 * How Surface's `meetVisibility` reads one argument (it is total): `public` is public whatever else the object carries,
 * `restricted` with a readable audience list is that set, and everything else (null, undefined, a string, a malformed
 * list) is sealed. Not the strict claim reading: the order must agree with Surface on any input, including bad ones.
 */
function surfaceReading(value: unknown): MemoryVisibility {
  if (value === null || typeof value !== "object") return SEALED;
  const { kind, audiences } = value as { kind?: unknown; audiences?: unknown };
  if (kind === "public") return { kind: "public" };
  if (kind !== "restricted") return SEALED;
  const named = readAudienceList(audiences);
  return named === undefined ? SEALED : { kind: "restricted", audiences: [...new Set(named)].sort() };
}
const listed = (names: string[], name: string) => names.some(entry => entry === "*" || foldMemoryText(entry) === foldMemoryText(name));
/** Same-slot stated claims the new claim is not explicitly replacing. */
const asserted = (input: MemoryClaimRoutingInput) => input.current.filter(other => other.posture === "stated" && memorySlotKey(other) === memorySlotKey(input.claim));

export const MEMORY_ROUTING_RULES: readonly RoutingRule[] = [
  rule<MemoryClaimRoutingInput>("contradicted-by-verification", "claim", input => {
    const { applicable } = foldCandidateVerifications({ candidateId: memoryProposedCandidateId(input.claim.id), value: input.claim.value }, input.verifications);
    const contradicted = applicable.filter(record => record.result === "contradicted").map(record => record.id);
    return contradicted.length ? { records: contradicted } : undefined;
  }),
  rule<MemoryClaimRoutingInput>("conflicting-current-values", "claim", (input, policy) => {
    const { claim } = input;
    if (claim.posture !== "stated" || listed(policy.multiValued, claim.property)) return undefined;
    // An edge replaces a claim only for the same speaker. Another speaker's edge needs an authority decision this
    // Kit cannot make (Surface leaves a third party's edge pending), so it does not clear the conflict.
    const replaced = new Set((claim.supersedes ?? []).map(edge => edge.claimId));
    const conflicts = asserted(input).filter(other => {
      if (other.id === claim.id || (replaced.has(other.id) && other.speaker === claim.speaker) || memoryValuesEqual(other.value, claim.value)) return false;
      try { return memoryIntervalsOverlap(other.validTime, claim.validTime); } catch { return true; } // a malformed interval cannot clear a conflict
    });
    return conflicts.length ? { with: conflicts.map(other => ({ claimId: other.id, value: other.value })) } : undefined;
  }),
  rule<MemoryClaimRoutingInput>("consequential-supersession", "claim", (input, policy) => {
    const { claim } = input;
    if (!claim.supersedes?.length) return undefined;
    if (!listed(policy.consequential.properties, claim.property) && !listed(policy.consequential.subjectTypes, claim.subject.type)) return undefined;
    return { property: claim.property, subjectType: claim.subject.type, supersedes: claim.supersedes.map(edge => ({ claimId: edge.claimId, kind: edge.kind })) };
  }),
  rule<MemoryEntityRoutingInput>("entity-identity-change", "entity", input => ({ operations: input.operations, proposalRef: input.proposalRef })),
  rule<MemoryClaimRoutingInput>("low-extraction-agreement", "claim", (input, policy) => {
    const { agreement } = input;
    // A malformed count is unmeasured, never agreement: this rule also runs over stored, possibly edited, inputs.
    if (!agreement || !agreementWellFormed(agreement) || agreement.passes < policy.minPasses) return { reason: "unmeasured", passes: agreement?.passes ?? 0, minPasses: policy.minPasses };
    if (agreement.agreeing < policy.minAgreement * agreement.passes - 1e-9) return { reason: "disagreement", passes: agreement.passes, agreeing: agreement.agreeing, minAgreement: policy.minAgreement };
    return undefined;
  }),
  rule<MemoryClaimRoutingInput>("visibility-widening", "claim", input => {
    // The claim must be no more visible than its source, nor than any current claim in its slot (the slot would
    // otherwise become visible to people who could not see it before). Undeclared is sealed on every side, so a claim
    // with no visibility cannot widen anything, and a bound with none admits only a sealed claim.
    const wider = input.baselines.filter(base => !memoryVisibilityWithin(input.claim.visibility, base.visibility)).map(base => base.ref);
    return wider.length ? { visibility: input.claim.visibility ?? null, widerThan: wider } : undefined;
  }),
];

const digestOf = (value: unknown) => `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;

export function normalizeMemoryRoutingPolicy(policy: Partial<MemoryRoutingPolicy> = {}): MemoryRoutingPolicy {
  const merged: MemoryRoutingPolicy = {
    ...DEFAULT_MEMORY_ROUTING_POLICY, ...policy,
    multiValued: [...(policy.multiValued ?? DEFAULT_MEMORY_ROUTING_POLICY.multiValued)],
    consequential: { properties: [...(policy.consequential?.properties ?? [])], subjectTypes: [...(policy.consequential?.subjectTypes ?? [])] },
  };
  const names = [...merged.multiValued, ...merged.consequential.properties, ...merged.consequential.subjectTypes];
  if (merged.version !== MEMORY_ROUTING_VERSION || !Number.isInteger(merged.minPasses) || merged.minPasses < 1
    || typeof merged.minAgreement !== "number" || !(merged.minAgreement >= 0 && merged.minAgreement <= 1) || names.some(name => typeof name !== "string" || !name.trim())) {
    throw new MemoryClaimError("invalid", "routing policy is malformed");
  }
  return merged;
}

/** Runs every applicable rule over an input. Pure. */
export function evaluateMemoryRouting(input: MemoryRoutingInput, policy: MemoryRoutingPolicy): Pick<MemoryRoutingDecision, "outcome" | "reasons" | "evaluated"> {
  const reasons: MemoryRoutingReason[] = [], evaluated: MemoryRoutingRuleId[] = [];
  for (const candidate of MEMORY_ROUTING_RULES) {
    if (candidate.appliesTo !== input.type) continue;
    evaluated.push(candidate.id);
    const detail = (candidate.check as (input: MemoryRoutingInput, policy: MemoryRoutingPolicy) => Record<string, unknown> | undefined)(input, policy);
    if (detail) reasons.push({ rule: candidate.id, detail });
  }
  return { outcome: reasons.length ? "routed" : "proposed", reasons, evaluated };
}

export interface MemoryClaimChange {
  type: "claim";
  claim: MemoryClaim;
  current?: readonly MemoryClaim[];
  verifications?: readonly unknown[];
  agreement?: MemoryAgreement | null;
  /** Visibility of the source the claim came from; null or absent is undeclared, which reads as sealed. */
  sourceVisibility?: MemoryVisibility | null;
}
export interface MemoryEntityChange { type: "entity"; proposal: SurveyEntityProposalLike }
export type MemoryChange = MemoryClaimChange | MemoryEntityChange;

/** A claim's id ignores the order of its audiences and edges; so must the decision that embeds it, or one claim gets two decision ids. */
const canonicalOrder = (claim: MemoryClaim): MemoryClaim => ({
  ...claim,
  ...(claim.visibility ? { visibility: readMemoryVisibility(claim.visibility) ?? claim.visibility } : {}),
  ...(claim.supersedes ? { supersedes: [...claim.supersedes].sort((x, y) => x.claimId.localeCompare(y.claimId)) } : {}),
});
const MAX_CURRENT_PER_SLOT = 64;
const SOURCE_BASELINE = "source";

function claimInput(change: MemoryClaimChange): MemoryClaimRoutingInput {
  assertMemoryClaim(change.claim);
  const slot = memorySlotKey(change.claim);
  const current = (change.current ?? []).filter(other => { assertMemoryClaim(other); return other.id !== change.claim.id && memorySlotKey(other) === slot; });
  // Reading max + 1 and refusing: a silently truncated slot could hide the conflicting claim.
  if (current.length > MAX_CURRENT_PER_SLOT) throw new MemoryClaimError("invalid", `more than ${MAX_CURRENT_PER_SLOT} current claims in one slot`);
  if (change.agreement != null && !agreementWellFormed(change.agreement)) throw new MemoryClaimError("invalid", "agreement needs integer passes >= 1 and 0 <= agreeing <= passes");
  const { applicable } = foldCandidateVerifications({ candidateId: memoryProposedCandidateId(change.claim.id), value: change.claim.value }, change.verifications ?? []);
  // Everything order-dependent is sorted here, so the decision id does not depend on the order inputs arrive in.
  const ordered = [...current].sort((x, y) => x.id.localeCompare(y.id)).map(canonicalOrder);
  return {
    type: "claim", claim: canonicalOrder(change.claim), current: ordered, verifications: [...applicable],
    agreement: change.agreement ?? null,
    baselines: [
      { ref: SOURCE_BASELINE, visibility: readMemoryVisibility(change.sourceVisibility) ?? null },
      ...ordered.map(other => ({ ref: other.id, visibility: other.visibility ?? null })),
    ],
  };
}

/** The operations Survey's entity review accepts (kontourai/survey#243). */
const isEntityOperation = (value: unknown): value is string => typeof value === "string" && (["merge", "split", "alias", "same-as", "related-to"].includes(value) || /^domain:\S+$/.test(value));
const nonBlank = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

function entityInput(change: MemoryEntityChange): MemoryEntityRoutingInput {
  const { proposal } = change, alternatives = proposal?.spec?.alternatives;
  if (typeof proposal?.id !== "string" || !proposal.id.trim() || !Array.isArray(alternatives) || alternatives.length === 0) throw new MemoryClaimError("invalid", "an entity change needs a Survey entity proposal with alternatives");
  const operations = new Set<string>(), subjects = new Map<string, { subjectType: string; subjectId: string }>();
  for (const alternative of alternatives) {
    if (!isEntityOperation(alternative?.operation)) throw new MemoryClaimError("invalid", "an entity alternative needs one of Survey's operations");
    operations.add(alternative.operation);
    for (const subject of alternative.subjects ?? []) {
      if (!nonBlank(subject?.subjectType) || !nonBlank(subject?.subjectId)) throw new MemoryClaimError("invalid", "an entity subject needs a subjectType and subjectId");
      subjects.set(JSON.stringify([subject.subjectType, subject.subjectId]), { subjectType: subject.subjectType, subjectId: subject.subjectId });
    }
  }
  if (subjects.size === 0) throw new MemoryClaimError("invalid", "an entity proposal names no subjects");
  return { type: "entity", proposalRef: proposal.id, operations: [...operations].sort(), subjects: [...subjects].sort(([x], [y]) => x < y ? -1 : x > y ? 1 : 0).map(([, subject]) => subject) };
}

export function routeMemoryChange(change: MemoryChange, policyInput?: Partial<MemoryRoutingPolicy>): MemoryRoutingDecision {
  const policy = normalizeMemoryRoutingPolicy(policyInput);
  const input: MemoryRoutingInput = change.type === "claim" ? claimInput(change) : entityInput(change);
  return {
    schema_version: MEMORY_ROUTING_VERSION, id: digestOf({ input, policy }),
    changeId: input.type === "claim" ? input.claim.id : input.proposalRef,
    changeType: input.type, ...evaluateMemoryRouting(input, policy), input, policy,
  };
}

export const routeMemoryChanges = (changes: readonly MemoryChange[], policy?: Partial<MemoryRoutingPolicy>): MemoryRoutingDecision[] => changes.map(change => routeMemoryChange(change, policy));

const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string" && item !== "");
/** A stored input is read back from disk: refuse a shape the rules would silently misread. */
function assertStoredInputShape(input: MemoryRoutingInput): void {
  const bad = (what: string): never => { throw new MemoryClaimError("invalid", `stored routing input: ${what}`); };
  if (input.type === "entity") {
    if (typeof input.proposalRef !== "string" || !input.proposalRef || !stringList(input.operations) || input.operations.length === 0 || !input.operations.every(isEntityOperation) || !Array.isArray(input.subjects) || input.subjects.length === 0 || !input.subjects.every(subject => subject && typeof subject === "object" && nonBlank(subject.subjectType) && nonBlank(subject.subjectId) && Object.keys(subject).length === 2)) bad("entity input is malformed");
    return;
  }
  if (input.type !== "claim") bad("unknown input type");
  if (!Array.isArray(input.current) || !Array.isArray(input.verifications)) bad("current and verifications must be lists");
  if (input.agreement !== null && (typeof input.agreement !== "object" || !agreementWellFormed(input.agreement))) bad("agreement is malformed");
  if (!Array.isArray(input.baselines) || !input.baselines.every(base => base && typeof base.ref === "string" && base.ref && (base.visibility === null || readMemoryVisibility(base.visibility) !== undefined))) bad("baselines are malformed");
  // The peers' baselines are re-derivable from the embedded claims; a stored input may not drop one to clear a widening.
  const peers = input.baselines.filter(base => base.ref !== SOURCE_BASELINE);
  const expected = input.current.map(other => ({ ref: other.id, visibility: other.visibility ?? null }));
  if (input.baselines.filter(base => base.ref === SOURCE_BASELINE).length !== 1 || canonicalJson(peers) !== canonicalJson(expected)) bad("baselines do not match the embedded current claims");
}

export interface RoutingRecomputation { ok: boolean; mismatches: string[] }

/**
 * Re-runs the rules over a stored decision's own input and policy and compares
 * the result with what it recorded. Detects an edited outcome, a tampered input,
 * a changed policy, or a rule set that has drifted since the decision was made.
 */
export function recomputeMemoryRouting(decision: MemoryRoutingDecision): RoutingRecomputation {
  const mismatches: string[] = [];
  try {
    if (decision.schema_version !== MEMORY_ROUTING_VERSION) throw new MemoryClaimError("invalid", "unsupported schema_version");
    const policy = normalizeMemoryRoutingPolicy(decision.policy);
    if (canonicalJson(policy) !== canonicalJson(decision.policy)) mismatches.push("policy is not in normalised form");
    assertStoredInputShape(decision.input);
    if (decision.input.type === "claim") {
      assertMemoryClaim(decision.input.claim);
      decision.input.current.forEach(other => assertMemoryClaim(other));
      const { rejected, inapplicable } = foldCandidateVerifications({ candidateId: memoryProposedCandidateId(decision.input.claim.id), value: decision.input.claim.value }, decision.input.verifications);
      if (rejected.length) mismatches.push("a stored verification record is invalid");
      if (inapplicable.length) mismatches.push("a stored verification record is not bound to this claim's value");
    }
    const expected = evaluateMemoryRouting(decision.input, policy);
    if (expected.outcome !== decision.outcome) mismatches.push(`outcome: recorded ${decision.outcome}, recomputed ${expected.outcome}`);
    if (canonicalJson(expected.reasons) !== canonicalJson(decision.reasons)) mismatches.push("reasons differ from the recomputed reasons");
    if (canonicalJson(expected.evaluated) !== canonicalJson(decision.evaluated)) mismatches.push("evaluated rules differ from the current rule set");
    if (decision.id !== digestOf({ input: decision.input, policy: decision.policy })) mismatches.push("id is not the digest of the input and policy");
    const subject = decision.input.type === "claim" ? decision.input.claim.id : decision.input.proposalRef;
    if (decision.changeId !== subject || decision.changeType !== decision.input.type) mismatches.push("change identity differs from the input");
  } catch (error) {
    mismatches.push(error instanceof Error ? error.message : String(error));
  }
  return { ok: mismatches.length === 0, mismatches };
}

/** Runs a Survey support verifier on the claim against the same-slot claims it may contradict. Undefined when there is nothing to check against. */
export async function verifyMemoryClaimAgainstCurrent(claim: MemoryClaim, current: readonly MemoryClaim[], verifier: SupportVerifier, options?: RunSupportVerifierOptions): Promise<CandidateVerification | undefined> {
  const slot = memorySlotKey(claim);
  const evidence = current.filter(other => other.posture === "stated" && other.id !== claim.id && memorySlotKey(other) === slot)
    .sort((x, y) => x.id.localeCompare(y.id)).slice(0, 8)
    .map(other => ({ id: other.id, excerpt: other.source.excerpt, locator: other.source.locator, context: `${other.subject.label ?? other.subject.id}: ${other.property}` }));
  if (evidence.length === 0) return undefined;
  return runSupportVerifier(verifier, { candidateId: memoryProposedCandidateId(claim.id), value: claim.value, evidence }, options);
}

// ---------------------------------------------------------------------------
// Survey review items

export const memoryReviewItemName = (changeId: string): string => `memory-change.${changeId.replace(/^sha256:/, "").slice(0, 32)}`;
/** Survey binds verification records to the review candidate's id, so a verifier must be run against this id, not the raw claim id. */
export const memoryProposedCandidateId = (claimId: string): string => `${memoryReviewItemName(claimId)}.proposed`;

const candidateBase = (claim: MemoryClaim, rank: number) => ({
  value: claim.value,
  sourceRank: rank,
  source: { sourceRef: claim.source.ref, kind: "agent-utterance" as const, observedAt: claim.source.observedAt },
  locator: { scheme: "text-span" as const, locator: claim.source.locator, excerpt: claim.source.excerpt },
  extraction: { target: `${claim.subject.id}.${claim.property}`, ...(claim.source.extractor ? { extractor: claim.source.extractor } : {}) },
  claimTarget: { claimId: claim.id, subjectType: claim.subject.type, subjectId: claim.subject.id, facet: "memory", claimType: claim.claimType, fieldOrBehavior: claim.property, impactLevel: "medium" as const },
});

/**
 * The Survey ReviewItem for a routed claim change; undefined for an unrouted
 * change and for an entity change, whose review item Survey's entity review
 * (kontourai/survey#243) owns. When the decision names a current claim it is a
 * current/proposed pair; otherwise a single proposed candidate.
 */
export function buildMemoryReviewItem(decision: MemoryRoutingDecision): ReviewItem | undefined {
  if (decision.outcome !== "routed" || decision.input.type !== "claim") return undefined;
  const { claim, current, verifications } = decision.input;
  const name = memoryReviewItemName(decision.changeId);
  const target = `${claim.subject.label ?? claim.subject.id}.${claim.property}`;
  const rationale = `Routed for review: ${decision.reasons.map(reason => reason.rule).join(", ")}. Posture: ${claim.posture}.`;
  const against = new Set([
    ...decision.reasons.flatMap(reason => ((reason.detail.with as { claimId: string }[] | undefined) ?? []).map(entry => entry.claimId)),
    ...(claim.supersedes ?? []).map(edge => edge.claimId),
  ]);
  const prior = current.find(other => against.has(other.id));
  const labels = { "memory.posture": claim.posture };
  const item: ReviewItem = prior
    ? currentProposedReviewItem({ name, target, current: candidateBase(prior, 1), proposed: candidateBase(claim, 2), rationale, labels, producerPolicy: { decisionMode: "current-proposed" } })
    : {
      apiVersion: reviewResourceApiVersion, kind: "ReviewItem", metadata: { name, labels },
      spec: {
        target, rationale, candidateSetStatus: "needs-review", projection: { candidateSetId: `${name}.candidates` },
        candidates: [{ id: `${name}.proposed`, role: "proposed", ...candidateBase(claim, 1), projection: { candidateSetId: `${name}.candidates`, candidateId: `${name}.proposed` } }],
      },
      status: { observedCandidateCount: 1 },
    };
  const proposed = item.spec.candidates.find(candidate => candidate.role === "proposed");
  if (proposed && verifications.length) proposed.verifications = [...verifications];
  return item;
}

// ---------------------------------------------------------------------------
// Reviewer outcomes and run metrics

export type MemoryReviewOutcome = "confirmed" | "corrected" | "rejected" | "held";

/** What a Survey decision means for the claim it reviewed. Keeping the current value rejects the proposed claim. */
export function memoryReviewOutcome(decision: ReviewDecision, itemName: string): MemoryReviewOutcome {
  const { status, resolution, candidateId, editedValue } = decision.spec;
  if (status === "rejected" || candidateId === `${itemName}.current`) return "rejected";
  // A deciding status is verified or assumed; proposed (the workbench's "could not confirm") and anything Survey does not define is undecided.
  if ((status !== "verified" && status !== "assumed") || resolution === "held" || resolution === "could_not_confirm") return "held";
  return editedValue !== undefined ? "corrected" : "confirmed";
}

/** When a value is an instant, as a number; anything else sorts before every real instant, so it never beats one. */
const instantOf = (text: string | undefined): number => { const ms = text === undefined ? NaN : Date.parse(text); return Number.isFinite(ms) ? ms : -Infinity; };

/** Latest decision per review item, by instant (`11:00+02:00` is earlier than `10:00Z`, whatever the text says). A tie keeps the later array entry. */
function latestDecisions(decisions: readonly ReviewDecision[]): Map<string, ReviewDecision> {
  const latest = new Map<string, ReviewDecision>();
  for (const decision of decisions) {
    const name = decision.spec.reviewItemName, previous = latest.get(name);
    if (!previous || instantOf(decision.spec.reviewedAt) >= instantOf(previous.spec.reviewedAt)) latest.set(name, decision);
  }
  return latest;
}

const reviewItemNameOf = (decision: MemoryRoutingDecision) => decision.input.type === "claim" ? memoryReviewItemName(decision.changeId) : decision.input.proposalRef;

export interface MemoryRunMetrics {
  schema_version: "1.0";
  runId: string;
  decisions: number;
  claimsProposed: number;
  uncontested: number;
  routed: number;
  routedShare: number | null;
  routedByRule: Record<string, number>;
  reviewer: { decisions: number; confirmed: number; corrected: number; rejected: number; held: number; pending: number; unmatched: number; defectsCaught: number };
  reviewSeconds: number | null;
  reviewTimedDecisions: number;
  reviewSecondsPerCaughtDefect: number | null;
}

/** Selection-to-submission seconds for a decision, or undefined when the events do not show both. */
function reviewDwell(decision: ReviewDecision, itemName: string, events: readonly ReviewSessionEvent[]): number | undefined {
  // The submission of THIS decision. Sequence numbers are per session, so across sessions the latest submission by
  // time is the one; the sequence only orders submissions within one session.
  const submitted = events.filter(event => event.spec.eventType === "decision-submitted" && event.spec.reviewItemName === itemName
    && event.spec.reviewDecisionName === decision.metadata.name);
  const end = submitted.sort((x, y) => instantOf(y.spec.occurredAt) - instantOf(x.spec.occurredAt) || y.spec.sequence - x.spec.sequence)[0];
  if (!end) return undefined;
  const start = events.filter(event => event.spec.eventType === "item-selected" && event.spec.sessionName === end.spec.sessionName
    && (event.spec.reviewItemName ?? event.spec.activeItemName) === itemName && event.spec.sequence < end.spec.sequence)
    .sort((x, y) => y.spec.sequence - x.spec.sequence)[0];
  if (!start) return undefined;
  const seconds = (Date.parse(end.spec.occurredAt) - Date.parse(start.spec.occurredAt)) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/**
 * Per-run metrics from the run's routing decisions and any Survey review that
 * has happened since. Call it again as decisions arrive: `pending` falls and
 * the review figures fill in. `reviewSeconds` is selection-to-submission dwell,
 * an upper bound on attention, and is null rather than estimated when no
 * decision has events.
 */
export function deriveMemoryRunMetrics(input: { runId: string; decisions: readonly MemoryRoutingDecision[]; reviewDecisions?: readonly ReviewDecision[]; reviewEvents?: readonly ReviewSessionEvent[] }): MemoryRunMetrics {
  // A change is decided once per run. If it was routed again (say, with more current claims), the later decision
  // stands; counting both would count one claim, and its one review, twice.
  const decisions = [...new Map(input.decisions.map(decision => [decision.changeId, decision] as const)).values()];
  const routed = decisions.filter(decision => decision.outcome === "routed");
  const routedByRule: Record<string, number> = {};
  for (const decision of routed) for (const reason of decision.reasons) routedByRule[reason.rule] = (routedByRule[reason.rule] ?? 0) + 1;

  const latest = latestDecisions(input.reviewDecisions ?? []);
  const counts = { confirmed: 0, corrected: 0, rejected: 0, held: 0 };
  const matched = new Set<string>();
  let seconds = 0, timed = 0;
  for (const decision of routed) {
    const name = reviewItemNameOf(decision), made = latest.get(name);
    if (!made) continue;
    matched.add(name);
    counts[memoryReviewOutcome(made, name)]++;
    const dwell = reviewDwell(made, name, input.reviewEvents ?? []);
    if (dwell !== undefined) { seconds += dwell; timed++; }
  }
  const defectsCaught = counts.corrected + counts.rejected;
  const reviewSeconds = timed ? seconds : null;
  const total = counts.confirmed + counts.corrected + counts.rejected + counts.held;
  return {
    schema_version: "1.0", runId: input.runId, decisions: decisions.length,
    claimsProposed: decisions.filter(decision => decision.changeType === "claim").length,
    uncontested: decisions.length - routed.length, routed: routed.length,
    routedShare: decisions.length ? routed.length / decisions.length : null, routedByRule,
    reviewer: { decisions: total, ...counts, pending: routed.length - matched.size, unmatched: latest.size - matched.size, defectsCaught },
    reviewSeconds, reviewTimedDecisions: timed,
    reviewSecondsPerCaughtDefect: reviewSeconds !== null && defectsCaught > 0 ? reviewSeconds / defectsCaught : null,
  };
}

// ---------------------------------------------------------------------------
// Recall presentation

export type MemoryReviewLabel = "unreviewed" | "in-review" | "confirmed" | "corrected";
export interface PresentedMemoryClaim {
  id: string;
  subject: string;
  property: string;
  /** The value to show: the reviewer's edit when the claim was corrected, otherwise the claim's own value. */
  value: unknown;
  /** The value the extractor produced. Differs from `value` only for a corrected claim. */
  extractedValue: unknown;
  posture: MemoryClaimPosture;
  validTime?: MemoryClaim["validTime"];
  speaker: string;
  source: { ref: string; excerpt: string; observedAt: string };
  review: { label: MemoryReviewLabel; routing: "not-evaluated" | "uncontested" | "routed"; reasons: MemoryRoutingRuleId[] };
  /** Posture and review label are in the text, so a consumer that prints only `text` still shows both. */
  text: string;
}
export interface WithheldMemoryClaim { id: string; reason: "rejected-in-review" | "invalid" | "posture-missing" }

/**
 * The one way to put claims in front of a reader. Every presented claim carries
 * its posture and review label. A claim that fails validation (including one with
 * no posture) or that review rejected is withheld and reported, never presented
 * bare and never dropped silently.
 */
export function presentMemoryClaims(claims: readonly unknown[], context: { routing?: readonly MemoryRoutingDecision[]; reviewDecisions?: readonly ReviewDecision[] } = {}): { presented: PresentedMemoryClaim[]; withheld: WithheldMemoryClaim[] } {
  const routingByClaim = new Map((context.routing ?? []).filter(decision => decision.changeType === "claim").map(decision => [decision.changeId, decision]));
  const latest = latestDecisions(context.reviewDecisions ?? []);
  const presented: PresentedMemoryClaim[] = [], withheld: WithheldMemoryClaim[] = [];
  for (const raw of claims) {
    try { assertMemoryClaim(raw); } catch (error) {
      withheld.push({ id: String((raw as { id?: unknown } | null)?.id ?? "unknown"), reason: error instanceof MemoryClaimError && error.code === "posture-missing" ? "posture-missing" : "invalid" });
      continue;
    }
    const claim = raw, routing = routingByClaim.get(claim.id);
    let label: MemoryReviewLabel = routing?.outcome === "routed" ? "in-review" : "unreviewed";
    let value = claim.value;
    // A reviewer's decision is about the claim, whether or not its routing record came along with it.
    const name = memoryReviewItemName(claim.id), made = latest.get(name);
    if (made) {
      const outcome = memoryReviewOutcome(made, name);
      if (outcome === "rejected") { withheld.push({ id: claim.id, reason: "rejected-in-review" }); continue; }
      if (outcome === "confirmed" || outcome === "corrected") label = outcome;
      if (outcome === "corrected") value = made.spec.editedValue;
    }
    const subject = claim.subject.label ?? claim.subject.id;
    presented.push({
      id: claim.id, subject, property: claim.property, value, extractedValue: claim.value, posture: claim.posture, ...(claim.validTime ? { validTime: claim.validTime } : {}),
      speaker: claim.speaker, source: { ref: claim.source.ref, excerpt: claim.source.excerpt, observedAt: claim.source.observedAt },
      review: { label, routing: routing ? (routing.outcome === "routed" ? "routed" : "uncontested") : "not-evaluated", reasons: routing?.reasons.map(reason => reason.rule) ?? [] },
      text: `[${claim.posture} · ${label}] ${subject}: ${claim.property} = ${typeof value === "string" ? value : canonicalJson(value)}`,
    });
  }
  return { presented, withheld };
}
