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
import { MemoryClaimError, memoryInstant, readMemoryVisibility, type MemoryClaim } from "./memory-claims.js";
import { jsonSnapshot } from "./memory-json.js";

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
  /** The claims that are candidates for the slot's value. A contest names every one of them. */
  candidateClaimIds: string[];
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
export function memoryClaimToAccumulationClaim(claim: MemoryClaim): MemoryAccumulationClaim {
  if (claim.posture !== "stated") throw new MemoryClaimError("invalid", `only a stated claim is a candidate for a slot, not a ${claim.posture} one`);
  assertSlotFields(claim);
  // What the claim's id covers is its JSON content, where a key set to undefined is the same as no key. Surface digests the
  // object as given, so the mapping copies the parts that can hold such keys as plain JSON: one claim, one Surface claim.
  const value = jsonSnapshot(claim.value, "claim value"), source = jsonSnapshot(claim.source, "claim source") as MemoryClaim["source"];
  const qualifiers = claim.qualifiers === undefined ? undefined : jsonSnapshot(claim.qualifiers, "claim qualifiers") as Record<string, string>;
  // Audiences are a set (the claim id treats them so); sorted and de-duplicated, so one claim has one content digest.
  const visibility = claim.visibility === undefined ? undefined : readMemoryVisibility(claim.visibility);
  if (claim.visibility !== undefined && visibility === undefined) throw new MemoryClaimError("invalid", "visibility must be public or restricted to named audiences");
  const declared = visibility === undefined ? undefined : visibility.kind === "public" ? "public" as const : { audiences: [...visibility.audiences] };
  // Surface parses timestamps strictly, and a claim built directly keeps whatever spelling it was given (a bare date): the
  // mapping is where they become the UTC instants Surface reads.
  const observed = utc(claim.source.observedAt, "source.observedAt");
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
export function memoryAccumulationClaims(claims: readonly MemoryClaim[], available: readonly MemoryClaim[] = []): MemoryAccumulationClaim[] {
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
  if (!Array.isArray(value)) return undefined;
  const length = value.length; // once: a list whose length changes while it is read is not a list we can trust
  if (length > 10_000) return undefined;
  const out: string[] = [];
  for (let index = 0; index < length; index++) {
    if (!Object.hasOwn(value, index)) return undefined;
    const item: unknown = value[index];
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
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** Reads the fact out of a `projectAccumulation` result, or throws: a result that does not look like one is not a fact. */
export function memoryAccumulationFact(result: unknown): MemoryAccumulationFact {
  const refuse = (): never => { throw new MemoryClaimError("invalid", "not an accumulation projection result: it needs an outcome, candidateClaimIds and gapCodes"); };
  if (!result || typeof result !== "object") return refuse();
  // Each field is read once, as data (Surface's result is a plain object), so what is checked is what is returned.
  const outcome = ownData(result, "outcome"), reason = ownData(result, "reason");
  const candidates = readStrings(ownData(result, "candidateClaimIds")), gaps = readStrings(ownData(result, "gapCodes"));
  if (typeof outcome !== "string" || !OUTCOMES.includes(outcome) || !candidates || !gaps) return refuse();
  const distinct = [...new Set(candidates)].sort();
  // A contest is between at least two candidates: Surface reports `contested` only when they hold different values.
  if (outcome === "contested" && distinct.length < 2) throw new MemoryClaimError("invalid", "a contested projection names at least two candidates");
  return { outcome: outcome as MemoryAccumulationFact["outcome"], ...(typeof reason === "string" ? { reason } : {}), candidateClaimIds: distinct, gapCodes: [...new Set(gaps)].sort() };
}
