import type { EntityProposal } from "@kontourai/survey";

export const ENTITY_ENVELOPE_VERSION: "1.0";
export const ENTITY_PROPOSAL_CATEGORY: "memory.entity-proposal";
export const MAX_ENTITY_ALTERNATIVES: number;
export const MAX_ENTITY_EVIDENCE: number;
export const MAX_ENTITY_EXCERPT_BYTES: number;
export const MAX_ENTITY_ENVELOPE_BYTES: number;

/** A decoded entity envelope: Survey's proposal, verbatim. */
export interface EntityEnvelope {
  version: typeof ENTITY_ENVELOPE_VERSION;
  proposal: EntityProposal;
}

/** The body for a Corpus create proposal. Throws (`DREAM_ENTITY_PROPOSAL_INVALID` or `DREAM_ENTITY_PROPOSAL_TOO_LARGE`) rather than truncate. */
export function encodeEntityEnvelope(proposal: EntityProposal): string;
/** The envelope in a proposal body, or null when it is not one this module wrote or does not verify. Never throws. */
export function decodeEntityEnvelope(body: unknown): EntityEnvelope | null;
/** The Corpus create key for a proposal, derived from its id alone. */
export function entityProposalKey(proposal: EntityProposal): string;
/** A short title for the Corpus proposal. */
export function entityProposalTitle(proposal: EntityProposal): string;
/** The verified entity proposals among a store's Corpus proposals, keyed by proposal id, and how many under this category did not verify. */
export function indexEntityProposals(proposals: readonly unknown[]): {
  byId: Map<string, { proposal: unknown; envelope: EntityEnvelope }>;
  unreadable: number;
};
