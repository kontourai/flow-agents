import type { MemoryClaim } from "@kontourai/flow-agents/memory-claims";
import type { BriefItem, BriefPolicy } from "@kontourai/flow-agents/memory-brief";

/** Declarations for `@kontourai/flow-agents/memory-recall` (`recallMemoryClaims`, in `memory-recall.js`). */

export type MemoryRecallStatus = "current" | "contested" | "superseded" | "not_current";

export interface MemoryRecallResult {
  claim_id: string;
  /** The claim as `presentMemoryClaims` shows it: posture and review label come first. */
  text: string;
  status: MemoryRecallStatus;
  review: { label: "unreviewed" | "in-review" | "confirmed" | "corrected"; routing: "not-evaluated" | "uncontested" | "routed" };
  posture: MemoryClaim["posture"];
  value: unknown;
  speaker: string;
  project: string | null;
  valid_time?: MemoryClaim["validTime"];
  observed_at: string;
  /** The verbatim quote the claim is grounded in. */
  excerpt: string;
  history: { supersedes: string[]; replaced_by: string[] };
  matched_terms: string[];
  coverage: number;
  /** Present when a sentence of the excerpt is on the question. */
  passage?: string;
  /** The question words the quoted sentence and the claim's title leave out. */
  missing_terms?: string[];
  outcome: "answered" | "abstained";
  reason?: "contested" | "replaced" | "not_in_effect" | "no_passage_on_question";
}

export interface MemoryRecallAnswer {
  question: string;
  as_of: string;
  evidence: "source_excerpt";
  outcome: "answered" | "abstained";
  abstained?: "no_question_terms" | "no_claim_covers_question" | "no_current_claim_states_it";
  excluded: { sealed: number; withheld: { id: string; reason: string }[] };
  stats: { claims: number; considered: number };
  terms: string[];
  below_threshold: { id: string; coverage: number; matched: string[] }[];
  results: MemoryRecallResult[];
}

export function recallMemoryClaims(options: {
  items: readonly BriefItem[];
  question: string;
  now: string;
  reviewDecisions?: readonly unknown[];
  routing?: readonly unknown[];
  policy?: BriefPolicy;
  limit?: number;
  minCoverage?: number;
  minPassageCoverage?: number;
}): MemoryRecallAnswer;
