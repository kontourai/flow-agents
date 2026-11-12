/**
 * Declarations for `@kontourai/flow-agents/learning-review-proposals` (re-exports of `learn/ledger.js` and
 * `learn/scope.js`; nothing here is a second implementation). The proposal shapes follow
 * `scripts/telemetry/learning-review-proposals.schema.json` (`kontour.learning-review-proposals` v0.2), exported as
 * `@kontourai/flow-agents/schemas/learning-review-proposals.schema.json`.
 */

/** The repository a correction-recurrence proposal was learned for. `repo` is the main checkout path, home as `~`. */
export type LearningReviewScope = { kind: "repo"; repo: string } | { kind: "all-projects" };

export type DecisionStatus = "proposed" | "ratified" | "rejected" | "deferred";

export interface ProposalDecision {
  status: DecisionStatus;
  decided_by: string | null;
  decided_at: string | null;
  rationale: string | null;
}

export interface ExpectedEffect {
  metric: string;
  direction: "decrease" | "increase" | "maintain";
  description: string;
}

export interface EffectObserved {
  measured_at: string;
  metric: string;
  before: number | null;
  after: number | null;
  moved: "improved" | "worsened" | "unchanged" | "insufficient-data";
  /** Correction-recurrence only: what the recurrence was counted on. */
  measured_on?: "human" | "inferred";
  after_occurrences?: number;
  after_days?: number;
  expected_occurrences?: number;
  tolerance?: number;
  min_expected?: number;
  [key: string]: unknown;
}

interface ProposalBase {
  proposal_id: string;
  proposed_change: string;
  severity?: "advisory";
  expected_effect: ExpectedEffect;
  decision: ProposalDecision;
  follow_on_ref?: string | null;
  effect_observed?: EffectObserved | null;
  window?: { since: number | string | null; until: number | string | null };
  [key: string]: unknown;
}

/** A v0.1 kit or gate tuning proposal (`learning-review-proposals.sh`). It carries no scope. */
export interface KitGateProposal extends ProposalBase {
  pattern: "kit-review-cost-inflation" | "gate-false-block-review" | "gate-well-calibrated";
  target: { kind: "kit" | "gate"; id: string };
  evidence: { cost: Record<string, unknown>; defect: Record<string, unknown> };
}

export type EnforcementRung = "agents-md" | "skill" | "hook" | "veritas-check";

export interface ProposalCitation {
  /** `<harness>:<session id>`. */
  thread_id: string;
  message_id: string;
  harness?: string;
  at: string;
  authority?: "human" | "inferred";
  kind?: "correction" | "nudge" | "frustration";
  pain?: number;
  /** Scrubbed, at most 200 bytes. */
  excerpt: string;
}

/** A rule file line a model judge cited (`conflict`, `covered_by`). */
export interface RuleLine {
  file: string | null;
  line: number;
  text: string;
  explanation?: string;
  judge?: string;
}

/** A v0.2 correction-recurrence proposal (`flow-agents learn`). */
export interface CorrectionRecurrenceProposal extends ProposalBase {
  pattern: "correction-recurrence";
  source: { family: "correction-recurrence"; producer: string; contract_version?: "0.2"; classifier_version?: string };
  scope: LearningReviewScope;
  authority: "human" | "inferred";
  target: { kind: EnforcementRung; id: string };
  theme: { id: string; label: string; parent?: string | null };
  rule: string;
  severity: "advisory";
  evidence: {
    cost: {
      occurrences: number;
      sessions: number;
      high_pain: number;
      rate_per_week: number;
      human_occurrences: number;
      inferred_occurrences: number;
      human_sessions?: number;
      inferred_sessions?: number;
      [key: string]: unknown;
    };
    defect: { rule: string; citations: ProposalCitation[]; citations_total?: number; [key: string]: unknown };
  };
  enforcement: { recommended: EnforcementRung; rung: number; ladder: string[]; reason: string; prior_proposal_ids?: string[] };
  conflict: RuleLine | null;
  covered_by?: RuleLine | null;
  conflict_check: { status: "checked" | "skipped"; file: string | null };
  measurement_basis?: { measured_on: "human" | "inferred"; thresholds: { min_occurrences: number; min_sessions: number }; decided_at: string };
  effect_history?: EffectObserved[];
}

export type LearningReviewProposal = CorrectionRecurrenceProposal | KitGateProposal;

/** Why a ledger line is not an entry. `line` is 1-based. */
export interface LedgerGap {
  line: number;
  code: "invalid-json" | "not-an-object" | "schema";
  message: string;
  /** Present when the line parsed and named one. */
  proposal_id?: string;
}

export interface LearningReviewLedger {
  /** False when the file does not exist yet (then `entries` and `gaps` are empty). */
  exists: boolean;
  entries: LearningReviewProposal[];
  gaps: LedgerGap[];
}

/** The document schema (`kontour.learning-review-proposals`). */
export const ledgerDocumentSchema: Readonly<Record<string, unknown>>;
/** One ledger line: the document schema's `#/$defs/proposal`, rooted so its references resolve. */
export const ledgerLineSchema: Readonly<Record<string, unknown>>;
/** Absolute path of the shipped document schema file. */
export const LEDGER_SCHEMA_PATH: string;

/** Validate one parsed ledger line against `ledgerLineSchema` (Flow Agents' own dependency-free validator). */
export function validateLedgerLine(value: unknown): { valid: boolean; errors: string[] };

/**
 * The ledger file for a directory: `LEARNING_REVIEW_PROPOSALS_LEDGER` when set, else
 * `<TELEMETRY_DATA_DIR or dir>/.kontourai/telemetry/learning-review-proposals.jsonl`. Relative overrides resolve against `dir`.
 */
export function defaultLedger(env?: Record<string, string | undefined>, dir?: string): string;

/**
 * Where `flow-agents learn` run in `cwd` keeps its ledger, and the scope it learns for: the main checkout of the
 * repository containing `cwd` (a bare repository's worktree), or `cwd` itself with `allProjects`. Throws an error with
 * `code: "LEARN_NOT_A_REPOSITORY"` outside a repository unless `allProjects`.
 */
export function resolveLearningReviewLedger(options?: {
  cwd?: string;
  env?: Record<string, string | undefined>;
  allProjects?: boolean;
}): { ledgerPath: string; scope: LearningReviewScope };

/**
 * Read a ledger without the lock: valid lines are entries, the rest are gaps (BOM and CRLF tolerated). With `scope`,
 * only that scope's correction-recurrence entries are kept; kit and gate entries carry no scope and are always kept.
 */
export function readLearningReviewLedger(path: string, options?: { scope?: LearningReviewScope }): LearningReviewLedger;

/** The scope's identity in comparisons: `repo:<path>`, `all-projects`, or null for anything else. */
export function scopeKey(scope: unknown): string | null;
/** The suffix every proposal id carries: `r<8 hex>` for a repository, `all` for all projects. */
export function scopeTag(scope: unknown): string;
