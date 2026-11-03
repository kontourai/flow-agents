/**
 * Entity merge, split and alias proposals, emitted in Survey's reviewed-entity contract (kontourai/survey#243,
 * merged in survey#358: `EntityProposalInput` / `createEntityProposal` in src/entity-review.ts).
 *
 * The Kit does not decide that two subjects are one. It hands Survey exactly what Survey asks for: the two subject
 * references, the operation, and the exact source spans that support or contradict it, taken from the memory claims
 * that name them. Survey makes the proposal content-addressed (`createEntityProposal`), builds the review item
 * (`entityProposalToReviewItem`) and records the outcome. A confidence component is descriptive and never accepts
 * anything. This module returns plain data, so it needs no Survey import; pass its result to Survey.
 */
import { MemoryClaimError, type MemoryClaim } from "./memory-claims.js";

const isOperation = (value: unknown): boolean => typeof value === "string" && (["merge", "split", "alias", "same-as", "related-to"].includes(value) || /^domain:\S+$/.test(value));

/** Survey's `EntityOperation`. */
export type MemoryEntityOperation = "merge" | "split" | "alias" | "same-as" | "related-to" | `domain:${string}`;

/** Survey's `EntityEvidence`. */
export interface MemoryEntityEvidence {
  id: string;
  sourceRef: string;
  sourceId: string;
  checksum: string;
  observedAt: string;
  locatorScheme: "text-span";
  locator: string;
  excerpt: string;
  stance: "supports" | "contradicts" | "context";
}

/** The part of Survey's `EntityProposalInput` this Kit fills. */
export interface MemoryEntityProposalInput {
  revision: string;
  proposer: { id: string; model?: string; rule?: string };
  policy: { id: string; revision: string };
  alternatives: {
    subjects: [{ subjectType: string; subjectId: string }, { subjectType: string; subjectId: string }];
    operation: MemoryEntityOperation;
    evidence: MemoryEntityEvidence[];
    confidenceComponents: Record<string, number>;
  }[];
}

export interface MemoryEntityCandidate {
  operation: MemoryEntityOperation;
  /** The two subjects, as they appear on memory claims. */
  subjects: [MemoryClaim["subject"], MemoryClaim["subject"]];
  /** The claims that ground the proposal, and what each says about it. */
  claims: { claim: MemoryClaim; stance: MemoryEntityEvidence["stance"] }[];
  /** Descriptive scores, each 0..1. Never an acceptance rule. */
  confidenceComponents: Record<string, number>;
}

/**
 * Builds the input for Survey's `createEntityProposal`. `checksums` maps each source ref (a sitting id) to its content
 * hash (`contentHash` of the #669 residue): Survey requires an exact source checksum on every piece of evidence, and
 * the claim does not carry one. A missing checksum is an error, never a guess.
 */
export function memoryEntityProposalInput(input: {
  revision: string;
  proposer: MemoryEntityProposalInput["proposer"];
  policy: MemoryEntityProposalInput["policy"];
  candidates: readonly MemoryEntityCandidate[];
  checksums: Readonly<Record<string, string>>;
}): MemoryEntityProposalInput {
  // Survey makes the same demands; refuse here so the Kit never hands it (or records) what it would reject.
  for (const [label, value] of [["revision", input.revision], ["proposer id", input.proposer?.id], ["policy id", input.policy?.id], ["policy revision", input.policy?.revision]] as const) {
    if (typeof value !== "string" || !value.trim()) throw new MemoryClaimError("invalid", `an entity proposal needs a ${label}`);
  }
  if (input.candidates.length === 0) throw new MemoryClaimError("invalid", "an entity proposal needs at least one candidate");
  return {
    revision: input.revision,
    proposer: input.proposer,
    policy: input.policy,
    alternatives: input.candidates.map(candidate => {
      const [a, b] = candidate.subjects;
      if (a.type === b.type && a.id === b.id) throw new MemoryClaimError("invalid", "an entity candidate needs two different subjects");
      if (candidate.claims.length === 0) throw new MemoryClaimError("invalid", "an entity candidate needs the claims that ground it");
      if (!isOperation(candidate.operation)) throw new MemoryClaimError("invalid", "an entity candidate needs one of Survey's operations");
      for (const [key, score] of Object.entries(candidate.confidenceComponents ?? {})) {
        if (!key.trim() || typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) throw new MemoryClaimError("invalid", `confidence component ${key} must be a number from 0 to 1`);
      }
      const evidence = candidate.claims.map(({ claim, stance }) => {
        if (!["supports", "contradicts", "context"].includes(stance)) throw new MemoryClaimError("invalid", "an evidence stance is supports, contradicts or context");
        if (!Number.isFinite(Date.parse(claim.source.observedAt))) throw new MemoryClaimError("invalid", "evidence needs an observedAt that is a date-time");
        const checksum = input.checksums[claim.source.ref];
        if (!checksum) throw new MemoryClaimError("invalid", `no checksum for source ${claim.source.ref}`);
        return {
          id: claim.id, sourceRef: claim.source.ref, sourceId: claim.source.ref, checksum,
          observedAt: claim.source.observedAt, locatorScheme: "text-span" as const, locator: claim.source.locator, excerpt: claim.source.excerpt, stance,
        };
      });
      if (new Set(evidence.map(item => item.id)).size !== evidence.length) throw new MemoryClaimError("invalid", "a claim grounds an entity candidate once");
      return {
        subjects: [{ subjectType: a.type, subjectId: a.id }, { subjectType: b.type, subjectId: b.id }],
        operation: candidate.operation, evidence, confidenceComponents: { ...candidate.confidenceComponents },
      };
    }),
  };
}
