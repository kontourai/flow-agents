import type { MemoryClaim } from "@kontourai/flow-agents/memory-claims";

/** Declarations for `@kontourai/flow-agents/memory-brief` (the canonical compiler in `brief.js`; nothing here is a second implementation). */

export const BRIEF_VERSION: 1;
export const DEFAULT_GLOBAL_BUDGET_BYTES: number;
export const DEFAULT_PROJECT_BUDGET_BYTES: number;
export const DEFAULT_MAX_ENTRY_BYTES: number;

export interface BriefItem {
  claim: MemoryClaim;
  project: string | null;
  agreement: { passes: number; agreeing: number } | null;
  /** `applied`: a reviewer other than the proposer applied the proposal. `pending`: not yet. */
  state: "applied" | "pending";
  /** The routing outcome recorded with the proposal. */
  routing?: { outcome: "proposed" | "routed" };
}

export interface BriefPolicy { multiValued?: string[] }

export function joinedBytes(entries: readonly string[]): number;
/** Sealed is the narrowest visibility: absent, or restricted to no audience. */
export function isSealed(claim: Pick<MemoryClaim, "visibility">): boolean;
export function classifyCurrent(items: readonly BriefItem[], policy?: BriefPolicy): { current: BriefItem[]; contested: BriefItem[]; superseded: BriefItem[]; notCurrent: BriefItem[] };
export function effectiveItems(items: readonly BriefItem[], reviewDecisions?: readonly unknown[]): { views: BriefItem[]; byView: Map<BriefItem, BriefItem> };
export function isEligible(item: BriefItem, options?: { includeUnreviewed?: boolean }): boolean;
export function confidenceOf(item: BriefItem): number;
export function rankItems(items: readonly BriefItem[], options?: { project?: string | null; now: string; includeUnreviewed?: boolean; policy?: BriefPolicy; current?: readonly BriefItem[]; reviewDecisions?: readonly unknown[] }): BriefItem[];
export function compileBrief(items: readonly BriefItem[], options: { budget: number; maxEntryBytes?: number; reviewDecisions?: readonly unknown[]; purgeGeneration?: string | null }): {
  entries: string[];
  claimIds: string[];
  withheld: { id: string; reason: string }[];
  budget: number;
  bytes: number;
  content: string;
  digest: string;
};
export function writeBriefs(options: {
  briefsDir: string;
  items: readonly BriefItem[];
  now: string;
  globalBudget?: number;
  projectBudget?: number;
  maxEntryBytes?: number;
  includeUnreviewed?: boolean;
  reviewDecisions?: readonly unknown[];
  dryRun?: boolean;
  policy?: BriefPolicy;
  purgeGate?: unknown;
}): Array<{ name: string; entries: number; claim_ids: string[]; bytes: number; budget: number; digest: string; written: boolean }> & { removed: string[]; excluded: { contested: number; superseded: number; not_current: number; considered: number }; held?: string | null };
