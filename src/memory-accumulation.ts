/**
 * The Kit's side of Surface's knowledge accumulation (kontourai/surface#204, `projectAccumulation`, surface#359).
 *
 * Surface decides what is current for a slot, and whether it is contested. That needs custody the Kit does not hold: bundle
 * observations with digests and authenticated publishers, and an authority snapshot binding owners, event admissions and
 * replacement grants. So the HOST runs the projection. The Kit supplies the two things that are its own: how a memory claim
 * becomes a Surface claim, and the one fact it reads back (`outcome`, which candidates, which gaps).
 *
 * Contradiction routing reads that fact (`contested-by-accumulation`); the Kit does not compare values itself.
 * Surface's package is not yet published with the projection, so none of it is imported here: the shapes below are
 * structural mirrors of the parts read, pinned by fixtures that were produced by running the real projection.
 */
import { MemoryClaimError, readMemoryVisibility, type MemoryClaim } from "./memory-claims.js";

/** Surface's `AccumulationClaim` (a `Claim` plus the provisional `validTime` and `supersedes`), as the Kit fills it. */
export interface MemoryAccumulationClaim {
  id: string;
  subjectType: string;
  subjectId: string;
  facet: string;
  claimType: string;
  fieldOrBehavior: string;
  qualifiers?: Record<string, string>;
  value: unknown;
  status: "proposed";
  createdAt: string;
  updatedAt: string;
  impactLevel: "medium";
  validTime?: { from?: string; until?: string };
  supersedes?: { claimId: string; kind: "correction" | "succession"; reason: string }[];
  metadata: { visibility?: "public" | { audiences: string[] }; memory: { speaker: string; source: MemoryClaim["source"] } };
}

/** Surface's `AccumulationQuery` for the slot of a claim. */
export interface MemoryAccumulationQuery {
  slot: { subjectType: string; subjectId: string; fieldOrBehavior: string; claimType: string; qualifiers?: Record<string, string> };
  now: string;
  valuePolicy: "single-json-v1";
}

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
  // Audiences are a set (the claim id treats them so); sorted and de-duplicated, so one claim has one content digest.
  const visibility = claim.visibility === undefined ? undefined : readMemoryVisibility(claim.visibility);
  if (claim.visibility !== undefined && visibility === undefined) throw new MemoryClaimError("invalid", "visibility must be public or restricted to named audiences");
  const declared = visibility === undefined ? undefined : visibility.kind === "public" ? "public" as const : { audiences: [...visibility.audiences] };
  return {
    id: claim.id, subjectType: claim.subject.type, subjectId: claim.subject.id, facet: "memory", claimType: claim.claimType, fieldOrBehavior: claim.property,
    ...(claim.qualifiers ? { qualifiers: claim.qualifiers } : {}), value: claim.value, status: "proposed",
    createdAt: claim.source.observedAt, updatedAt: claim.source.observedAt, impactLevel: "medium",
    ...(claim.validTime ? { validTime: claim.validTime } : {}),
    ...(claim.supersedes ? { supersedes: claim.supersedes.map(edge => ({ claimId: edge.claimId, kind: edge.kind, reason: edge.reason })) } : {}),
    metadata: { ...(declared !== undefined ? { visibility: declared } : {}), memory: { speaker: claim.speaker, source: claim.source } },
  };
}

/**
 * The Surface claims to publish for `claims`: each stated claim, plus every claim its `supersedes` edges point at.
 * Surface refuses a replacement whose target is not carried in the same bundle, so the targets travel with the
 * successor. A target that is not available, or is not a stated claim (only those are candidates), is an error here
 * rather than a throw inside the projection.
 */
export function memoryAccumulationClaims(claims: readonly MemoryClaim[], available: readonly MemoryClaim[] = []): MemoryAccumulationClaim[] {
  const byId = new Map(available.map(claim => [claim.id, claim]));
  const out = new Map<string, MemoryClaim>();
  for (const claim of claims) {
    if (claim.posture !== "stated") continue;
    out.set(claim.id, claim);
    for (const edge of claim.supersedes ?? []) {
      const target = out.get(edge.claimId) ?? claims.find(other => other.id === edge.claimId) ?? byId.get(edge.claimId);
      if (!target) throw new MemoryClaimError("invalid", `claim ${claim.id} replaces ${edge.claimId}, which is not available to carry with it`);
      if (target.posture !== "stated") throw new MemoryClaimError("invalid", `claim ${claim.id} replaces ${edge.claimId}, which is not a stated claim`);
      out.set(target.id, target);
    }
  }
  return [...out.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(memoryClaimToAccumulationClaim);
}

/** The accumulation query for a claim's slot. `now` is the host's evaluation instant (Surface takes no hidden clock). */
export function memoryAccumulationQuery(claim: MemoryClaim, now: string): MemoryAccumulationQuery {
  return {
    slot: { subjectType: claim.subject.type, subjectId: claim.subject.id, fieldOrBehavior: claim.property, claimType: claim.claimType, ...(claim.qualifiers ? { qualifiers: claim.qualifiers } : {}) },
    now, valuePolicy: "single-json-v1",
  };
}

const OUTCOMES = ["current", "contested", "invalid", "none"];
const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");

/** Reads the fact out of a `projectAccumulation` result, or throws: a result that does not look like one is not a fact. */
export function memoryAccumulationFact(result: unknown): MemoryAccumulationFact {
  const r = result as Partial<Record<keyof MemoryAccumulationFact, unknown>> | null;
  if (!r || typeof r !== "object" || typeof r.outcome !== "string" || !OUTCOMES.includes(r.outcome) || !stringList(r.candidateClaimIds) || !stringList(r.gapCodes)) {
    throw new MemoryClaimError("invalid", "not an accumulation projection result: it needs an outcome, candidateClaimIds and gapCodes");
  }
  return { outcome: r.outcome as MemoryAccumulationFact["outcome"], ...(typeof r.reason === "string" ? { reason: r.reason } : {}), candidateClaimIds: [...r.candidateClaimIds].sort(), gapCodes: [...r.gapCodes].sort() };
}
