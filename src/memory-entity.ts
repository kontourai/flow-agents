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
import { jsonSnapshot } from "./memory-json.js";

const isOperation = (value: unknown): boolean => typeof value === "string" && (["merge", "split", "alias", "same-as", "related-to"].includes(value) || /^domain:\S+$/.test(value));

const asList = (value: unknown): any[] => (Array.isArray(value) ? value : []);

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
export function memoryEntityProposalInput(request: {
  revision: string;
  proposer: MemoryEntityProposalInput["proposer"];
  policy: MemoryEntityProposalInput["policy"];
  candidates: readonly MemoryEntityCandidate[];
  checksums: Readonly<Record<string, string>>;
}): MemoryEntityProposalInput {
  // Survey's createEntityProposal needs lossless JSON (no NaN, undefined, accessors or cycles). Take, once, only the fields
  // that go into the proposal: a claim's own value is not among them, so a value Survey would never see cannot make the
  // emitter refuse a request Survey would accept. Everything below validates this copy, which is what is handed over.
  const input = jsonSnapshot({
    revision: request?.revision, proposer: request?.proposer, policy: request?.policy,
    candidates: asList(request?.candidates).map(candidate => ({
      operation: candidate?.operation, subjects: candidate?.subjects, confidenceComponents: candidate?.confidenceComponents,
      claims: asList(candidate?.claims).map(entry => ({ stance: entry?.stance, id: entry?.claim?.id, ref: entry?.claim?.source?.ref, observedAt: entry?.claim?.source?.observedAt, locator: entry?.claim?.source?.locator, excerpt: entry?.claim?.source?.excerpt })),
    })),
    checksums: request?.checksums,
  }, "entity proposal input") as unknown as {
    revision: string; proposer: MemoryEntityProposalInput["proposer"]; policy: MemoryEntityProposalInput["policy"]; checksums: Record<string, string>;
    candidates: { operation: MemoryEntityOperation; subjects: [{ type: string; id: string }, { type: string; id: string }]; confidenceComponents: Record<string, number>; claims: { stance: MemoryEntityEvidence["stance"]; id: string; ref: string; observedAt: string; locator: string; excerpt: string }[] }[];
  };
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
      if (!Array.isArray(candidate.subjects) || candidate.subjects.length !== 2) throw new MemoryClaimError("invalid", "an entity candidate names exactly two subjects");
      const [a, b] = candidate.subjects;
      for (const subject of [a, b]) {
        if (typeof subject?.type !== "string" || !subject.type.trim() || typeof subject.id !== "string" || !subject.id.trim()) throw new MemoryClaimError("invalid", "an entity subject needs a type and an id");
      }
      if (a.type === b.type && a.id === b.id) throw new MemoryClaimError("invalid", "an entity candidate needs two different subjects");
      if (candidate.claims.length === 0) throw new MemoryClaimError("invalid", "an entity candidate needs the claims that ground it");
      if (!isOperation(candidate.operation)) throw new MemoryClaimError("invalid", "an entity candidate needs one of Survey's operations");
      for (const [key, score] of Object.entries(candidate.confidenceComponents ?? {})) {
        if (!key.trim() || typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) throw new MemoryClaimError("invalid", `confidence component ${key} must be a number from 0 to 1`);
      }
      const evidence = candidate.claims.map(entry => {
        if (!["supports", "contradicts", "context"].includes(entry.stance)) throw new MemoryClaimError("invalid", "an evidence stance is supports, contradicts or context");
        // Survey requires each of these on every piece of evidence.
        for (const [what, text] of [["claim id", entry.id], ["source ref", entry.ref], ["locator", entry.locator], ["excerpt", entry.excerpt]] as const) {
          if (typeof text !== "string" || !text.trim()) throw new MemoryClaimError("invalid", `evidence needs a ${what}`);
        }
        if (typeof entry.observedAt !== "string" || !Number.isFinite(Date.parse(entry.observedAt))) throw new MemoryClaimError("invalid", "evidence needs an observedAt that is a date-time");
        const checksum = input.checksums?.[entry.ref];
        if (typeof checksum !== "string" || !checksum.trim()) throw new MemoryClaimError("invalid", `no checksum for source ${entry.ref}`);
        return {
          id: entry.id, sourceRef: entry.ref, sourceId: entry.ref, checksum,
          observedAt: entry.observedAt, locatorScheme: "text-span" as const, locator: entry.locator, excerpt: entry.excerpt, stance: entry.stance,
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
