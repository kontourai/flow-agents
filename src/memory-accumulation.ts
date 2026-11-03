/**
 * The Kit's side of Surface's knowledge accumulation (kontourai/surface#204, `projectAccumulation`, surface#359).
 *
 * Surface decides what is current for a slot, and whether it is contested. That needs custody the Kit does not hold: bundle
 * observations with digests and authenticated publishers, and an authority snapshot binding owners, event admissions and
 * replacement grants. So the HOST runs the projection. The Kit supplies the two things that are its own: how a memory claim
 * becomes a Surface claim, and the one fact it reads back (`outcome`, which candidates, which gaps).
 *
 * Contradiction routing reads that fact (`contested-by-accumulation`); the Kit does not compare values itself.
 * The claim and query shapes are Surface's own (surface@6.3.0); the Kit does not import `projectAccumulation` because the host
 * runs it. What the Kit reads back is pinned by fixtures that were produced by running the real projection, and a test
 * replays them through the pinned release.
 */
import type { AccumulationClaim, AccumulationQuery } from "@kontourai/surface";
import { MemoryClaimError, assertMemoryClaim, memoryInstant, readMemoryVisibility, type MemoryClaim } from "./memory-claims.js";
import { types } from "node:util";
import { jsonSnapshot, jsonSnapshotEach } from "./memory-json.js";

/** Surface's `AccumulationClaim` (a `Claim` plus the provisional `validTime` and `supersedes`), which is what the Kit fills. */
export type MemoryAccumulationClaim = AccumulationClaim;

/** Surface refuses a slot whose id or claim type has surrounding whitespace, or any slot field blank; say so here rather than inside the projection. */
function assertSlotFields(claim: Pick<MemoryClaim, "subject" | "claimType" | "property">): void {
  for (const [what, text] of [["subject type", claim.subject.type], ["subject id", claim.subject.id], ["claim type", claim.claimType], ["property", claim.property]] as const) {
    if (typeof text !== "string" || !text.trim()) throw new MemoryClaimError("invalid", `${what} must not be blank to be a Surface slot`);
  }
  if (claim.subject.id !== claim.subject.id.trim() || claim.claimType !== claim.claimType.trim()) throw new MemoryClaimError("invalid", "subject id and claim type must not have surrounding whitespace to be a Surface slot");
}

const utc = (text: string, what: string): string => {
  const ms = memoryInstant(text);
  if (ms === undefined) throw new MemoryClaimError("invalid", `${what} is not an ISO 8601 date or date-time, which Surface requires`);
  return new Date(ms).toISOString();
};

/** Surface's `AccumulationQuery` for the slot of a claim. */
export type MemoryAccumulationQuery = AccumulationQuery;

/** The part of `projectAccumulation`'s result the Kit reads. */
export interface MemoryAccumulationFact {
  outcome: "current" | "contested" | "invalid" | "none";
  reason?: string;
  /**
   * The slot of the query the host says it ran. A projection result carries no query of its own, so this is the host's word:
   * the Kit checks it is the claim's slot, and cannot check the result was computed for it.
   */
  slot: MemoryAccumulationQuery["slot"];
  /** The claims that are candidates for the slot's value. A contest names every one of them. */
  candidateClaimIds: string[];
  /**
   * The claims that support the slot's current value. Surface joins subjects an admitted identity mapping declares equivalent,
   * so with equal values the slot is `current`, nobody is a candidate, and this list is the only place the joined claims appear.
   */
  supportingClaimIds: string[];
  gapCodes: string[];
}

/**
 * A stated claim as a Surface claim. Only `stated` claims assert a value that holds: a plan or a what-if is not a
 * candidate for the slot, and a retraction is Surface's admitted `revoked` event on the retracted claim (the claim's
 * `supersedes` edges name its targets), which the host's authority admits, not a value to compare.
 *
 * The status is `proposed`: nothing here has been verified, so under Surface's rules a different value from another claim
 * leaves the slot contested until a reviewer decides. `visibility` goes where Surface reads a declared visibility
 * (`metadata.visibility`); absent stays absent, which Surface reads as sealed.
 */
export function memoryClaimToAccumulationClaim(input: MemoryClaim): MemoryAccumulationClaim {
  // The claim is copied once, as plain JSON, and everything below reads the copy: a getter or a Proxy cannot hand one value to
  // a check and another to the mapped claim. A key set to undefined is the same as no key (that is what the claim's id covers),
  // and Surface digests the object as given, so one claim gives one Surface claim.
  const claim = jsonSnapshot(input, "memory claim") as MemoryClaim;
  assertMemoryClaim(claim); // a claim that lost a required field in the copy (a hidden accessor, say) is refused here, not mapped half-empty
  if (claim.posture !== "stated") throw new MemoryClaimError("invalid", `only a stated claim is a candidate for a slot, not a ${claim.posture} one`);
  assertSlotFields(claim);
  const { value, source, qualifiers } = claim;
  // Audiences are a set (the claim id treats them so); sorted and de-duplicated, so one claim has one content digest.
  const visibility = claim.visibility === undefined ? undefined : readMemoryVisibility(claim.visibility);
  if (claim.visibility !== undefined && visibility === undefined) throw new MemoryClaimError("invalid", "visibility must be public or restricted to named audiences");
  const declared = visibility === undefined ? undefined : visibility.kind === "public" ? "public" as const : { audiences: [...visibility.audiences] };
  // Surface parses timestamps strictly, and a claim built directly keeps whatever spelling it was given (a bare date): the
  // mapping is where they become the UTC instants Surface reads.
  const observed = utc(source.observedAt, "source.observedAt");
  const validTime = claim.validTime === undefined ? undefined : {
    ...(claim.validTime.from !== undefined ? { from: utc(claim.validTime.from, "validTime.from") } : {}),
    ...(claim.validTime.until !== undefined ? { until: utc(claim.validTime.until, "validTime.until") } : {}),
  };
  return {
    id: claim.id, subjectType: claim.subject.type, subjectId: claim.subject.id, facet: "memory", claimType: claim.claimType, fieldOrBehavior: claim.property,
    ...(qualifiers ? { qualifiers } : {}), value, status: "proposed",
    createdAt: observed, updatedAt: observed, impactLevel: "medium",
    ...(validTime ? { validTime } : {}),
    // Edges are a set, as in the claim id: one claim maps to one Surface claim whatever order its edges were given in.
    ...(claim.supersedes ? { supersedes: [...claim.supersedes].sort((x, y) => x.claimId < y.claimId ? -1 : x.claimId > y.claimId ? 1 : 0).map(edge => ({ claimId: edge.claimId, kind: edge.kind, reason: edge.reason })) } : {}),
    metadata: { ...(declared !== undefined ? { visibility: declared } : {}), memory: { speaker: claim.speaker, source } },
  };
}

/**
 * The Surface claims to publish for `claims`: each stated claim, plus every claim its `supersedes` edges point at.
 * Surface refuses a replacement whose target is not carried in the same bundle, so the targets travel with the
 * successor. A target that is not available, or is not a stated claim (only those are candidates), is an error here
 * rather than a throw inside the projection.
 */
export function memoryAccumulationClaims(claimsInput: readonly MemoryClaim[], availableInput: readonly MemoryClaim[] = []): MemoryAccumulationClaim[] {
  // Copied once, as plain JSON, before anything is read from them (see memoryClaimToAccumulationClaim).
  const claims = jsonSnapshotEach(claimsInput, "claims") as MemoryClaim[], available = jsonSnapshotEach(availableInput, "available claims") as MemoryClaim[];
  const byId = new Map([...available, ...claims].map(claim => [claim.id, claim]));
  const out = new Map<string, MemoryClaim>();
  // Surface refuses an edge whose target is not in the same bundle, so every claim reachable through edges travels with
  // the successor (a chain C -> B -> A carries all three), not only the direct targets. A cycle simply stops the walk.
  // Iterative: a long chain must not exhaust the stack.
  const pending: MemoryClaim[] = claims.filter(claim => claim.posture === "stated").reverse();
  while (pending.length) {
    const claim = pending.pop()!;
    if (out.has(claim.id)) continue;
    out.set(claim.id, claim);
    for (const edge of claim.supersedes ?? []) {
      const target = byId.get(edge.claimId);
      if (!target) throw new MemoryClaimError("invalid", `claim ${claim.id} replaces ${edge.claimId}, which is not available to carry with it`);
      if (target.posture !== "stated") throw new MemoryClaimError("invalid", `claim ${claim.id} replaces ${edge.claimId}, which is not a stated claim`);
      pending.push(target);
    }
  }
  return [...out.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(memoryClaimToAccumulationClaim);
}

/** The accumulation query for a claim's slot. `now` is the host's evaluation instant (Surface takes no hidden clock). */
export function memoryAccumulationQuery(claim: MemoryClaim, now: string): MemoryAccumulationQuery {
  assertSlotFields(claim);
  return {
    slot: { subjectType: claim.subject.type, subjectId: claim.subject.id, fieldOrBehavior: claim.property, claimType: claim.claimType, ...(claim.qualifiers ? { qualifiers: claim.qualifiers } : {}) },
    now, valuePolicy: "single-json-v1",
  };
}

const OUTCOMES = ["current", "contested", "invalid", "none"];
/** A list of non-empty strings, read by own index so a hole or an inherited entry is refused rather than skipped or invented. */
function readStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || types.isProxy(value)) return undefined;
  const length = value.length; // once: a list whose length changes while it is read is not a list we can trust
  if (length > 10_000) return undefined;
  const out: string[] = [];
  for (let index = 0; index < length; index++) {
    // A data descriptor, read once: an accessor would run caller code and could answer differently the next time.
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !("value" in descriptor)) return undefined;
    const item: unknown = descriptor.value;
    if (typeof item !== "string" || item === "") return undefined;
    out.push(item);
  }
  return value.length === length ? out : undefined;
}

/**
 * One own data property, read once. An accessor reads as absent, so it fails the type checks that follow: it could answer
 * differently the next time it is read, and Surface's result has none.
 */
function ownData(record: object, key: string): unknown {
  if (types.isProxy(record)) return undefined; // a Proxy answers as it likes, differently each time: it reads as absent, so it is refused
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** Every claim the projection names for the slot, as a candidate or as support. These, not the raw subject, say who is in the slot. */
export const memoryAccumulationMembers = (fact: Pick<MemoryAccumulationFact, "candidateClaimIds" | "supportingClaimIds">): string[] => [...new Set([...fact.candidateClaimIds, ...fact.supportingClaimIds])].sort();

/** The slot of a query the Kit could have built: four non-blank names and optional qualifiers, under the one value policy it knows. */
function readQuerySlot(query: unknown): MemoryAccumulationQuery["slot"] {
  const refuse = (): never => { throw new MemoryClaimError("invalid", "the projection's query is needed to read its result: a slot and the single-json-v1 value policy"); };
  if (!query || typeof query !== "object" || ownData(query, "valuePolicy") !== "single-json-v1") return refuse();
  const raw = ownData(query, "slot");
  if (!raw || typeof raw !== "object") return refuse();
  const slot = jsonSnapshot(raw, "query slot") as Record<string, unknown>;
  const names = ["subjectType", "subjectId", "fieldOrBehavior", "claimType"].map(key => slot[key]);
  if (names.some(name => typeof name !== "string" || !name.trim())) return refuse();
  const qualifiers = slot.qualifiers;
  if (qualifiers !== undefined && (typeof qualifiers !== "object" || qualifiers === null || Array.isArray(qualifiers) || Object.values(qualifiers).some(value => typeof value !== "string"))) return refuse();
  const [subjectType, subjectId, fieldOrBehavior, claimType] = names as string[];
  return { subjectType, subjectId, fieldOrBehavior, claimType, ...(qualifiers ? { qualifiers: qualifiers as Record<string, string> } : {}) };
}

/**
 * Reads the fact out of a `projectAccumulation` result and the query it answered, or throws: a result that does not look like
 * one is not a fact, and one without its query cannot be told apart from a result for another slot.
 */
export function memoryAccumulationFact(result: unknown, query: unknown): MemoryAccumulationFact {
  return factFrom(result, readQuerySlot(query));
}

/** Reads a fact that was already read (or stored) back into canonical form, or throws. Its slot is part of it. */
export function readMemoryAccumulationFact(fact: unknown): MemoryAccumulationFact {
  if (!fact || typeof fact !== "object") return factFrom(fact, undefined as never);
  return factFrom(fact, readQuerySlot({ slot: ownData(fact, "slot"), valuePolicy: "single-json-v1" }));
}

function factFrom(result: unknown, slot: MemoryAccumulationQuery["slot"]): MemoryAccumulationFact {
  const refuse = (): never => { throw new MemoryClaimError("invalid", "not an accumulation projection result: it needs an outcome, candidateClaimIds, supportingClaimIds and gapCodes"); };
  if (!result || typeof result !== "object") return refuse();
  // Each field is read once, as data (Surface's result is a plain object), so what is checked is what is returned.
  const outcome = ownData(result, "outcome"), reason = ownData(result, "reason");
  const candidates = readStrings(ownData(result, "candidateClaimIds")), supporting = readStrings(ownData(result, "supportingClaimIds")), gaps = readStrings(ownData(result, "gapCodes"));
  if (typeof outcome !== "string" || !OUTCOMES.includes(outcome) || !candidates || !supporting || !gaps) return refuse();
  const distinct = [...new Set(candidates)].sort();
  // A contest is between at least two candidates: Surface reports `contested` only when they hold different values.
  if (outcome === "contested" && distinct.length < 2) throw new MemoryClaimError("invalid", "a contested projection names at least two candidates");
  return { outcome: outcome as MemoryAccumulationFact["outcome"], ...(typeof reason === "string" ? { reason } : {}), slot, candidateClaimIds: distinct, supportingClaimIds: [...new Set(supporting)].sort(), gapCodes: [...new Set(gaps)].sort() };
}
