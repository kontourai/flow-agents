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
import { meetVisibility } from "@kontourai/surface";
import {
  currentProposedReviewItem, foldCandidateVerifications, reviewResourceApiVersion, runSupportVerifier,
  type CandidateVerification, type EntityProposal, type RunSupportVerifierOptions, type ReviewDecision, type ReviewItem, type ReviewSessionEvent, type SupportVerifier,
} from "@kontourai/survey";
import { memoryAccumulationFact, memoryAccumulationMembers, readMemoryAccumulationFact, type MemoryAccumulationFact } from "./memory-accumulation.js";
import { MAX_DECISION_DEPTH, MAX_DECISION_NODES, MAX_HISTORY_ENTRIES, MAX_PEERS, MAX_VERIFICATIONS, MAX_VERIFICATION_NODES, jsonSnapshot, jsonSnapshotEach, ownEntries, ownField } from "./memory-json.js";
import {
  MemoryClaimError, assertMemoryClaim, foldMemoryText, memoryFieldKey, memorySlotKey, readMemoryVisibility,
  type MemoryAgreement, type MemoryClaim, type MemoryClaimPosture, type MemoryVisibility,
} from "./memory-claims.js";

export const MEMORY_ROUTING_VERSION = "1.0" as const;
export const MEMORY_ROUTING_RULE_IDS = [
  "contradicted-by-verification",
  "contested-by-accumulation",
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
  /** Properties that may hold several values at once. Surface's projection cannot contest them (one value policy), so they are not projected. */
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
  /**
   * What Surface's projection says about the claim's slot, run by the host (`projectAccumulation`). Null when it was not
   * run, which the rule treats as not evaluated. Only a stated claim is projected.
   */
  accumulation: MemoryAccumulationFact | null;
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
/** The part of Survey's `EntityProposal` (`createEntityProposal`, survey@8.3.0) this Kit reads: pass the real proposal object. */
export type SurveyEntityProposal = Pick<EntityProposal, "id" | "spec">;
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
/**
 * Whether `inner` is no more visible than `outer` in Surface's lattice (surface@6.3.0): the meet of the two is `inner`'s own
 * meet. Surface's `meetVisibility` is total and fail-closed, so undeclared or unreadable is sealed and omission never widens;
 * the Kit states no order of its own. `meetVisibility` returns audiences sorted, so the two results compare as JSON.
 */
export function memoryVisibilityWithin(inner: unknown, outer: unknown): boolean {
  const bound = meetVisibility(inner as MeetArgument, outer as MeetArgument), own = meetVisibility(inner as MeetArgument);
  return JSON.stringify(bound) === JSON.stringify(own);
}
type MeetArgument = Parameters<typeof meetVisibility>[number];
const listed = (names: string[], name: string) => names.some(entry => entry === "*" || foldMemoryText(entry) === foldMemoryText(name));

export const MEMORY_ROUTING_RULES: readonly RoutingRule[] = [
  rule<MemoryClaimRoutingInput>("contradicted-by-verification", "claim", input => {
    const { applicable } = foldCandidateVerifications({ candidateId: memoryProposedCandidateId(input.claim.id), value: input.claim.value }, input.verifications);
    const contradicted = applicable.filter(record => record.result === "contradicted").map(record => record.id);
    return contradicted.length ? { records: contradicted } : undefined;
  }),
  rule<MemoryClaimRoutingInput>("contested-by-accumulation", "claim", (input, policy) => {
    const { claim, accumulation } = input;
    // Only a stated claim is a candidate for a slot's value; a plan or a what-if is never contested. Surface's projection
    // has one value policy (a single JSON value), so a property the host declares multi-valued is not projected.
    if (claim.posture !== "stated" || listed(policy.multiValued, claim.property)) return undefined;
    // Surface decides what is contested (identity, validity, retraction, replacement admission); the Kit compares no
    // values and reads no edge. Until a reviewer verifies a successor, Surface normally keeps both candidates, so an unreviewed
    // succession normally routes here; the projection decides, and can answer `current` earlier (an equal-value replacement
    // projects `current` while its edge is still pending).
    if (!accumulation) {
      // Without a projection, a slot with nothing else in it cannot be contested; one with a peer cannot be called uncontested.
      const peers = input.current.filter(other => other.posture === "stated" && other.id !== claim.id).map(other => other.id);
      return peers.length ? { reason: "not-evaluated", peers } : undefined;
    }
    // An invalid projection (identity unresolved, a replacement cycle, missing lineage) gives no unique answer for the slot.
    if (accumulation.outcome === "invalid") return { outcome: accumulation.outcome, ...(accumulation.reason ? { reason: accumulation.reason } : {}), candidateClaimIds: accumulation.candidateClaimIds, gapCodes: accumulation.gapCodes };
    if (accumulation.outcome !== "contested" || !accumulation.candidateClaimIds.includes(claim.id)) return undefined;
    return { outcome: accumulation.outcome, candidateClaimIds: accumulation.candidateClaimIds, gapCodes: accumulation.gapCodes };
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
  /**
   * The host's `projectAccumulation` result for this claim's slot, and (required with it) the query the host says it ran:
   * `memoryAccumulationFact` reads the pair and refuses a query for another slot than the claim's. The result carries no query
   * of its own, so that is a check on the host's word, not on the result. Null or absent: not evaluated.
   */
  accumulation?: unknown;
  accumulationQuery?: unknown;
  /** Visibility of the source the claim came from; null or absent is undeclared, which reads as sealed. */
  sourceVisibility?: MemoryVisibility | null;
}
export interface MemoryEntityChange { type: "entity"; proposal: SurveyEntityProposal }
export type MemoryChange = MemoryClaimChange | MemoryEntityChange;

/**
 * The claims that share `claim`'s slot, which is what bounds its visibility, what a verifier checks it against and what a
 * review item pairs it with. Two things put a claim there:
 *  - the raw slot: the same subject, claim type, property and qualifiers;
 *  - the projection naming it, as a candidate or as support. Surface joins subjects an admitted identity mapping declares
 *    equivalent, so a joined claim carries another raw subject and, with equal values, is named only as support.
 * A claim the projection names must be a stated claim of the same claim type, property and qualifiers (the subject is the one
 * dimension the mapping may change; the Kit cannot check the mapping itself, which is the host's authority), and must have been
 * supplied: a member the Kit never saw would be missing from every bound built from the slot. The projection must also have
 * answered for this claim's slot. More than `MAX_CURRENT_PER_SLOT` is refused, never cut short.
 */
export function memorySlotPeers(claim: MemoryClaim, current: readonly MemoryClaim[], fact?: MemoryAccumulationFact | null): MemoryClaim[] {
  const slot = memorySlotKey(claim), field = memoryFieldKey(claim);
  // The fact's slot is compared as Surface compares slots (canonical key, exact claim type), not as spelled: `HEADQUARTERS` and
  // `headquarters`, or no qualifiers and `{}`, are one slot there.
  if (fact && memorySlotKey({ subject: { type: fact.slot.subjectType, id: fact.slot.subjectId }, property: fact.slot.fieldOrBehavior, claimType: fact.slot.claimType, ...(fact.slot.qualifiers ? { qualifiers: fact.slot.qualifiers } : {}) }) !== slot) {
    throw new MemoryClaimError("invalid", "the projection answered for another slot than this claim's");
  }
  const members = new Set(fact ? memoryAccumulationMembers(fact) : []);
  // The claim itself, if the projection names it, is held to the same rule as any other member.
  if (members.has(claim.id) && claim.posture !== "stated") throw new MemoryClaimError("invalid", `the projection names claim ${claim.id}, which is not a stated claim`);
  const peers = new Map<string, MemoryClaim>();
  for (const other of current) {
    assertMemoryClaim(other);
    if (other.id === claim.id) continue;
    // Every claim the projection names is checked, whether or not its raw subject is the claim's: a plan, a what-if or a
    // retraction is never support for a slot's value, and a different property is a different slot.
    if (members.has(other.id) && (other.posture !== "stated" || memoryFieldKey(other) !== field)) {
      throw new MemoryClaimError("invalid", `the projection names claim ${other.id}, which is not a stated claim of this claim type, property and qualifiers`);
    }
    if (members.has(other.id) || memorySlotKey(other) === slot) peers.set(other.id, other);
  }
  const missing = [...members].filter(id => id !== claim.id && !peers.has(id));
  if (missing.length) throw new MemoryClaimError("invalid", `the projection names claim(s) ${missing.join(", ")} that are not among the slot's current claims`);
  // Reading max + 1 and refusing: a silently truncated slot could hide the conflicting claim.
  if (peers.size > MAX_CURRENT_PER_SLOT) throw new MemoryClaimError("invalid", `more than ${MAX_CURRENT_PER_SLOT} current claims in one slot`);
  return [...peers.values()].sort((x, y) => x.id.localeCompare(y.id));
}

/** A claim's id ignores the order of its audiences and edges; so must the decision that embeds it, or one claim gets two decision ids. */
const canonicalOrder = (claim: MemoryClaim): MemoryClaim => ({
  ...claim,
  ...(claim.visibility ? { visibility: readMemoryVisibility(claim.visibility) ?? claim.visibility } : {}),
  ...(claim.supersedes ? { supersedes: [...claim.supersedes].sort((x, y) => x.claimId.localeCompare(y.claimId)) } : {}),
});
const MAX_CURRENT_PER_SLOT = MAX_PEERS;
/** The bounds for copying one routing decision (see memory-json.ts: derived from the claim, peer and verification bounds). */
export const DECISION_BOUNDS = { maxNodes: MAX_DECISION_NODES, maxDepth: MAX_DECISION_DEPTH } as const;
const SOURCE_BASELINE = "source";

function claimInput(request: MemoryClaimChange): MemoryClaimRoutingInput {
  // Each field of the request is read once, with nothing the caller defined running, and the claims and lists are copied as
  // plain JSON: what is validated below is exactly what is recorded, whatever the objects handed in would answer next time.
  const field = (key: string) => ownField(request, key, `routing change ${key}`);
  const claim = jsonSnapshot(field("claim"), "routing change claim") as MemoryClaim;
  const currentClaims = jsonSnapshotEach(field("current"), "routing change current") as MemoryClaim[];
  const verificationList = ownEntries(field("verifications"), "routing change verifications");
  // Reading max + 1 and refusing, like the peers: a decision carries a bounded number of bounded records, so it stays copyable.
  if (verificationList.length > MAX_VERIFICATIONS) throw new MemoryClaimError("invalid", `more than ${MAX_VERIFICATIONS} verification records`);
  const verifications = verificationList.map((record, index) => jsonSnapshot(record, `routing change verifications[${index}]`, { maxNodes: MAX_VERIFICATION_NODES }));
  const agreementInput = field("agreement"), sourceInput = field("sourceVisibility");
  const agreement = agreementInput == null ? null : jsonSnapshot(agreementInput, "routing change agreement") as MemoryAgreement;
  // A source visibility that cannot be copied as plain data (a hole, a getter, a Proxy) is unreadable, and unreadable is
  // undeclared, which is sealed: it cannot widen anything, so the claim is checked against a sealed source and routed.
  let sourceVisibility: MemoryVisibility | null = null;
  if (sourceInput != null) { try { sourceVisibility = jsonSnapshot(sourceInput, "routing change sourceVisibility") as MemoryVisibility; } catch { sourceVisibility = null; } }
  assertMemoryClaim(claim);
  if (agreement !== null && !agreementWellFormed(agreement)) throw new MemoryClaimError("invalid", "agreement needs integer passes >= 1 and 0 <= agreeing <= passes");
  const accumulation = field("accumulation");
  const fact = accumulation ? memoryAccumulationFact(accumulation, field("accumulationQuery")) : null;
  // Everything order-dependent is sorted here, so the decision id does not depend on the order inputs arrive in.
  const ordered = memorySlotPeers(claim, currentClaims, fact).map(canonicalOrder);
  const { applicable } = foldCandidateVerifications({ candidateId: memoryProposedCandidateId(claim.id), value: claim.value }, verifications);
  return {
    type: "claim", claim: canonicalOrder(claim), current: ordered, verifications: [...applicable],
    agreement,
    accumulation: fact,
    baselines: [
      { ref: SOURCE_BASELINE, visibility: readMemoryVisibility(sourceVisibility) ?? null },
      ...ordered.map(other => ({ ref: other.id, visibility: other.visibility ?? null })),
    ],
  };
}

/** The operations Survey's entity review accepts (kontourai/survey#243). */
const isEntityOperation = (value: unknown): value is string => typeof value === "string" && (["merge", "split", "alias", "same-as", "related-to"].includes(value) || /^domain:\S+$/.test(value));
const nonBlank = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

function entityInput(request: MemoryEntityChange): MemoryEntityRoutingInput {
  const proposal = jsonSnapshot(ownField(request, "proposal", "routing change proposal"), "routing change proposal") as SurveyEntityProposal, alternatives = proposal?.spec?.alternatives;
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
  const type = ownField(change, "type", "routing change");
  const input: MemoryRoutingInput = type === "claim" ? claimInput(change as MemoryClaimChange) : entityInput(change as MemoryEntityChange);
  return {
    schema_version: MEMORY_ROUTING_VERSION, id: digestOf({ input, policy }),
    changeId: input.type === "claim" ? input.claim.id : input.proposalRef,
    changeType: input.type, ...evaluateMemoryRouting(input, policy), input, policy,
  };
}

export const routeMemoryChanges = (changes: readonly MemoryChange[], policy?: Partial<MemoryRoutingPolicy>): MemoryRoutingDecision[] =>
  (ownEntries(changes, "changes") as MemoryChange[]).map(change => routeMemoryChange(change, policy));

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
  if (input.verifications.length > MAX_VERIFICATIONS) bad(`more than ${MAX_VERIFICATIONS} verification records`);
  if (input.agreement !== null && (typeof input.agreement !== "object" || !agreementWellFormed(input.agreement))) bad("agreement is malformed");
  let fact: MemoryAccumulationFact | null = null;
  if (input.accumulation !== null) {
    try { fact = readMemoryAccumulationFact(input.accumulation); } catch { bad("accumulation is not a projection result"); }
    // The reader also sorts; a stored fact must already be in that form, or the id would not be stable.
    if (canonicalJson(fact) !== canonicalJson(input.accumulation)) bad("accumulation is not in canonical form");
  }
  // The stored `current` must be exactly the claim's slot peers: nothing foreign, nothing dropped, within the bound, and the
  // projection (if any) answering for this claim's slot and naming only stated claims of its property.
  try {
    assertMemoryClaim(input.claim);
    const peers = memorySlotPeers(input.claim, input.current, fact);
    if (canonicalJson(peers.map(other => other.id)) !== canonicalJson([...input.current].map(other => other.id).sort((x, y) => x.localeCompare(y)))) bad("current holds a claim that is not in the claim's slot");
  } catch (error) {
    if (error instanceof MemoryClaimError && /^Memory claim invalid: stored routing input/.test(error.message)) throw error;
    bad(error instanceof Error ? error.message : "slot membership is malformed");
  }
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
export function recomputeMemoryRouting(request: MemoryRoutingDecision): RoutingRecomputation {
  const mismatches: string[] = [];
  try {
    // Copied once, so every check below reads the data the next one does.
    const decision = jsonSnapshot(request, "routing decision", DECISION_BOUNDS) as MemoryRoutingDecision;
    if (decision.schema_version !== MEMORY_ROUTING_VERSION) throw new MemoryClaimError("invalid", "unsupported schema_version");
    const policy = normalizeMemoryRoutingPolicy(decision.policy);
    if (canonicalJson(policy) !== canonicalJson(decision.policy)) mismatches.push("policy is not in normalised form");
    assertStoredInputShape(decision.input);
    if (decision.input.type === "claim") {
      assertMemoryClaim(decision.input.claim);
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
export async function verifyMemoryClaimAgainstCurrent(claim: MemoryClaim, current: readonly MemoryClaim[], verifier: SupportVerifier, options?: RunSupportVerifierOptions, accumulation?: MemoryAccumulationFact | null): Promise<CandidateVerification | undefined> {
  // The same membership routing uses: pass the fact `memoryAccumulationFact` read, and a claim joined through an admitted
  // identity mapping is checked against too. The claims are copied once, as plain JSON, before anything is read from them.
  const own = jsonSnapshot(claim, "claim to verify") as MemoryClaim;
  const evidence = memorySlotPeers(own, jsonSnapshotEach(current, "current claims") as MemoryClaim[], accumulation).filter(other => other.posture === "stated")
    .slice(0, 8)
    .map(other => ({ id: other.id, excerpt: other.source.excerpt, locator: other.source.locator, context: `${other.subject.label ?? other.subject.id}: ${other.property}` }));
  if (evidence.length === 0) return undefined;
  return runSupportVerifier(verifier, { candidateId: memoryProposedCandidateId(own.id), value: own.value, evidence }, options);
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
export function buildMemoryReviewItem(request: MemoryRoutingDecision): ReviewItem | undefined {
  // Copied once: the check below and the item built after it read the same data, not an object that answers twice.
  const decision = jsonSnapshot(request, "routing decision", DECISION_BOUNDS) as MemoryRoutingDecision;
  if (decision.outcome !== "routed" || decision.input?.type !== "claim") return undefined;
  // The item is built from the decision's embedded claim, so a decision that no longer recomputes (an edited value under the old
  // claim id, say) must not become a candidate the reviewer sees under that id.
  const check = recomputeMemoryRouting(decision);
  if (!check.ok) throw new MemoryClaimError("invalid", `routing decision ${decision.id} does not recompute, so no review item is built from it: ${check.mismatches.join("; ")}`);
  const { claim, current, verifications } = decision.input;
  const name = memoryReviewItemName(decision.changeId);
  const target = `${claim.subject.label ?? claim.subject.id}.${claim.property}`;
  const rationale = `Routed for review: ${decision.reasons.map(reason => reason.rule).join(", ")}. Posture: ${claim.posture}.`;
  const against = new Set([
    ...decision.reasons.flatMap(reason => ((reason.detail.candidateClaimIds as string[] | undefined) ?? []).filter(id => id !== claim.id)),
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
  const decisions = [...new Map((ownEntries(ownField(input, "decisions", "metrics input"), "metrics input decisions", MAX_HISTORY_ENTRIES) as MemoryRoutingDecision[]).map(decision => [decision.changeId, decision] as const)).values()];
  const routed = decisions.filter(decision => decision.outcome === "routed");
  const routedByRule: Record<string, number> = {};
  for (const decision of routed) for (const reason of decision.reasons) routedByRule[reason.rule] = (routedByRule[reason.rule] ?? 0) + 1;

  const reviewDecisions = ownEntries(ownField(input, "reviewDecisions", "metrics input"), "metrics input reviewDecisions", MAX_HISTORY_ENTRIES) as ReviewDecision[];
  const reviewEvents = ownEntries(ownField(input, "reviewEvents", "metrics input"), "metrics input reviewEvents", MAX_HISTORY_ENTRIES) as ReviewSessionEvent[];
  const latest = latestDecisions(reviewDecisions);
  const counts = { confirmed: 0, corrected: 0, rejected: 0, held: 0 };
  const matched = new Set<string>();
  let seconds = 0, timed = 0;
  for (const decision of routed) {
    const name = reviewItemNameOf(decision), made = latest.get(name);
    if (!made) continue;
    matched.add(name);
    counts[memoryReviewOutcome(made, name)]++;
    const dwell = reviewDwell(made, name, reviewEvents);
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
  // Everything shown is read from a copy taken once, as plain JSON: a claim whose posture answers one way to the check and
  // another to the presentation would otherwise print a claim with no posture. A claim that cannot be copied is withheld.
  // From each routing decision recall reads four small fields (what was decided, for which claim, and the rule names), so those
  // are all it takes: copying a whole decision would refuse one the Kit legitimately produced (a large value and 64 peers).
  const routingByClaim = new Map<string, { outcome: unknown; reasons: string[] }>();
  for (const decision of ownEntries(ownField(context, "routing", "recall context"), "recall routing")) {
    const changeType = ownField(decision, "changeType", "recall routing decision"), changeId = ownField(decision, "changeId", "recall routing decision");
    if (changeType !== "claim" || typeof changeId !== "string") continue;
    const reasons = ownEntries(ownField(decision, "reasons", "recall routing decision"), "recall routing reasons").map(reason => ownField(reason, "rule", "recall routing reason"));
    routingByClaim.set(changeId, { outcome: ownField(decision, "outcome", "recall routing decision"), reasons: reasons.filter((rule): rule is string => typeof rule === "string") });
  }
  const latest = latestDecisions(jsonSnapshotEach(ownField(context, "reviewDecisions", "recall context"), "recall reviewDecisions") as ReviewDecision[]);
  const presented: PresentedMemoryClaim[] = [], withheld: WithheldMemoryClaim[] = [];
  for (const entry of ownEntries(claims, "recall claims")) {
    let claim: MemoryClaim;
    try { claim = jsonSnapshot(entry, "recall claim") as MemoryClaim; } catch { withheld.push({ id: "unknown", reason: "invalid" }); continue; }
    try { assertMemoryClaim(claim); } catch (error) {
      withheld.push({ id: String((claim as { id?: unknown } | null)?.id ?? "unknown"), reason: error instanceof MemoryClaimError && error.code === "posture-missing" ? "posture-missing" : "invalid" });
      continue;
    }
    const routing = routingByClaim.get(claim.id);
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
      review: { label, routing: routing ? (routing.outcome === "routed" ? "routed" : "uncontested") : "not-evaluated", reasons: (routing?.reasons ?? []) as MemoryRoutingRuleId[] },
      text: `[${claim.posture} · ${label}] ${subject}: ${claim.property} = ${typeof value === "string" ? value : canonicalJson(value)}`,
    });
  }
  return { presented, withheld };
}
