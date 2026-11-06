import type { MemoryClaim } from "@kontourai/flow-agents/memory-claims";

/** Declarations for `@kontourai/flow-agents/memory-envelope` (the canonical codec in `envelope.js`; nothing here is a second implementation). */

export const ENVELOPE_VERSION: "1.2";
export const MEMORY_CATEGORY: "memory.claim";
export const MAX_CLAIMS_PER_SITTING: number;
export const MAX_PLAN_BYTES: number;
export const MAX_CLAIM_BYTES: number;
export const MAX_ENVELOPE_BYTES: number;
export const MAX_FACT_IDS: number;
export const MAX_FACT_GAPS: number;
export const MAX_FACT_STRING: number;

export interface MemoryAgreement { passes: number; agreeing: number }
export interface MemoryPlanEntry { claim: MemoryClaim; agreement: MemoryAgreement | null; project: string | null }
export interface MemorySitting { id: string; contentHash: string; visibilityKey: string }

/** A routing decision as `routeMemoryChange` makes it (opaque here; `recomputeMemoryRouting` checks it). */
export type MemoryRoutingDecisionRecord = Record<string, unknown> & { changeId: string };

/** What a dream proposal body decodes to. */
export interface MemoryEnvelope {
  dream: typeof ENVELOPE_VERSION;
  claim: MemoryClaim;
  agreement: MemoryAgreement | null;
  decision: MemoryRoutingDecisionRecord;
  project: string | null;
  sitting: MemorySitting & { index: number; planDigest: string };
  plan: MemoryPlanEntry[];
}

/** A Corpus create proposal, as far as the codec reads it. */
export interface MemoryProposalLike {
  id: string;
  state: string;
  proposer_id: string;
  candidate: { category?: string; body: string; [key: string]: unknown };
  [key: string]: unknown;
}

export function planDigest(plan: readonly MemoryPlanEntry[]): string;
export function visibilityKey(visibility: unknown): string;
export function encodeEnvelope(input: { plan: readonly MemoryPlanEntry[]; index: number; decision: MemoryRoutingDecisionRecord; sitting: MemorySitting }): string;
export function fitPlan(entries: readonly MemoryPlanEntry[]): { plan: MemoryPlanEntry[]; dropped: number };
export function boundFact<F extends { candidateClaimIds: string[]; gapCodes: string[]; reason?: unknown }>(fact: F | null | undefined, claimId: string, prefer?: readonly string[]): { fact: F | null | undefined; cut: number };
export function titleFor(claim: Pick<MemoryClaim, "id" | "subject" | "property">): string;
export function verifyEntry(entry: unknown): boolean;
export function verifyDecision(decision: unknown, claim: Pick<MemoryClaim, "id">): boolean;
/** The envelope in a proposal body, or null when the body is not one this module wrote or does not verify. */
export function decodeEnvelope(body: unknown): MemoryEnvelope | null;
export function indexProposals(proposals: readonly MemoryProposalLike[], proposerId: string): {
  byClaim: Map<string, { proposal: MemoryProposalLike; envelope: MemoryEnvelope }>;
  sitting(sittingId: string, contentHash: string, visibilityKey: string): { plan: MemoryPlanEntry[]; complete: boolean; landed: Set<string> } | null;
  unreadable: number;
};
