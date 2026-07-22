/**
 * Provider-neutral TypeScript interfaces for the four provider roles this repository already
 * implements as CLIs (#777). Native orchestration hosts (e.g. Station) should import these
 * instead of shelling out to the CLIs or re-deriving the shapes by hand — the same "consume,
 * never fork" spirit `work-item-vocabulary.ts` (#775) and `work-item-mutations.ts` (#776) already
 * apply to the read-only work-item shape and the mutation vocabulary.
 *
 * This file follows the one existing precedent for a co-located "provider contract" module:
 * `change-provider.ts`'s `ChangeProvider` interface (implemented by `github-change-provider.ts`'s
 * `createGithubChangeProvider`) — a contract file living in `src/cli/` next to the CLIs that
 * implement it, with a same-shaped `create*Provider(...): SomeProvider` factory (return-type
 * annotation on an object literal) as the type-level "formally satisfies this interface" proof.
 * `local-file-provider-adapters.ts` is this issue's version of that proof for `AssignmentProvider`
 * and `WorkItemMutationProvider` (see that file's header for why those two, not all four).
 *
 * Derivation order (per issue #777 and the #775/#776 "code wins over prose" lesson — a prior
 * discrepancy between this repo's contract prose and its reference adapter's actual emissions):
 *   1. `context/contracts/work-item-contract.md` and `context/contracts/assignment-provider-contract.md`
 *      (normative prose).
 *   2. The actual CLI behaviors — `src/cli/pull-work-provider.ts`, `src/cli/assignment-provider.ts`,
 *      `src/cli/work-item-mutation-provider.ts` — matching what they really emit/accept, flagging
 *      discrepancies rather than silently picking prose over code (see the per-interface notes
 *      below for the discrepancies this pass found).
 *   3. The existing exported types — `src/lib/work-item-vocabulary.ts` (#775),
 *      `src/lib/work-item-mutations.ts` (#776) — reused directly, never duplicated.
 *
 * @module
 */
import type { WorkItem, WorkItemStatus, SourceProvider } from "../lib/work-item-vocabulary.js";
import type {
  WorkItemMutationBase,
  WorkItemMutationRequest,
  WorkItemMutationResult,
} from "../lib/work-item-mutations.js";
import type { ActorStruct, AssignmentClaimRecord, AssignmentStatus } from "./assignment-provider.js";

// ─── Shared backlog-provider-settings shapes ────────────────────────────────
// Re-typed from `schemas/backlog-provider-settings.schema.json`'s `$defs.backlog_settings` — the
// ALREADY-RESOLVED settings shape `pull-work-provider.ts`'s `main()` actually receives as
// `--settings-json` after `resolveSettings()` has picked the right `defaults`/`projects[]` entry
// (see `resolveSettings()`). The JSON Schema remains the authoritative, exhaustive shape (also
// covers `project`, and JSON-Schema-level validation); this type intentionally mirrors only the
// fields `pull-work-provider.ts` reads directly, for typed consumption, not as a schema
// replacement.

export interface BacklogProviderRepoRef {
  owner: string;
  name: string;
  url?: string;
}

/** The work-item contract's Capability Flags vocabulary (read-side; see the contract's
 * "Capability Flags" table — mutation capabilities are a separate, smaller vocabulary, see
 * `WorkItemMutationCapability` below). */
export type BacklogProviderCapability =
  | "issues"
  | "projects_boards"
  | "status_fields"
  | "custom_fields"
  | "dependencies"
  | "labels"
  | "milestones"
  | "assignees"
  | "pr_links"
  | "comments";

export interface WorkItemProviderSettings {
  role: "WorkItemProvider";
  kind: "github";
  repo: BacklogProviderRepoRef;
  capabilities: BacklogProviderCapability[];
}

export interface BoardProviderBoardRef {
  type: "github_project";
  number: number;
  owner?: string;
  url?: string;
}

export interface BoardProviderSettings {
  role: "BoardProvider";
  kind: "github";
  repo: BacklogProviderRepoRef;
  board: BoardProviderBoardRef;
  capabilities: BacklogProviderCapability[];
}

export interface WorkItemSelectionFilters {
  issue_state: "open" | "closed" | "all";
  include_labels: string[];
  ready_statuses: WorkItemStatus[];
  exclude_statuses: WorkItemStatus[];
}

export interface WorkItemWipPolicy {
  prefer_finishing_active_work: boolean;
  active_statuses: WorkItemStatus[];
  block_new_work_when_active_count_exceeds?: number;
}

export interface WorkItemSelectionSettings {
  filters: WorkItemSelectionFilters;
  wip_policy: WorkItemWipPolicy;
}

/** The work-item mutation contract's Mutation Capability Flags vocabulary (write-side; see the
 * contract's "Mutation Capability Flags" table) — distinct from `BacklogProviderCapability`,
 * which describes reading, not writing. */
export type WorkItemMutationCapability = "status_transition" | "field_update" | "comment";

export interface WorkItemMutationPolicy {
  conflict_policy: "provider_wins_with_staleness_detection";
  supported_operations: WorkItemMutationCapability[];
  status_transition_target?: "board_status_field" | "labels";
  field_update_target?: "board_custom_field" | "labels";
}

/**
 * The resolved `backlog_settings` document `pull-work-provider.ts`'s `main()` operates on.
 * `workspace` is only present for the multi-repo path (`configuredRepos()`); most single-repo
 * settings omit it.
 */
export interface EffectiveBacklogProviderSettings {
  work_item_provider: WorkItemProviderSettings;
  board_provider: BoardProviderSettings;
  selection: WorkItemSelectionSettings;
  mutation_policy?: WorkItemMutationPolicy;
  workspace?: { repos: Array<string | { owner?: string; name: string }> };
}

// ─── WorkItemProvider ────────────────────────────────────────────────────────
// work-item-contract.md "Provider Roles": "supplies issue-like records that represent requested
// work, defects, chores, or decisions."

export interface WorkItemReadinessReason {
  code: string;
  message: string;
  [key: string]: unknown;
}

/**
 * The exact classification literals `pull-work-provider.ts`'s `classify()` emits (verified
 * against the CLI source, not just contract prose — see `provider-interfaces.test.mjs`'s
 * mechanical anti-drift check against this union). Distinct from `WorkItemStatus`
 * (`work-item-vocabulary.ts`, #775): that is the provider-neutral LIFECYCLE status a work item
 * carries; this is the SELECTION verdict `pull-work` derives from status, blockers, and labels for
 * a given selection-settings pass.
 */
export type WorkItemReadinessClassification = "ready" | "blocked" | "in_progress" | "stale" | "related-only";

export interface WorkItemReadiness {
  classification: WorkItemReadinessClassification;
  reasons: WorkItemReadinessReason[];
}

/**
 * The exact classification literals `pull-work-provider.ts`'s `classifyRevisionFreshness()`
 * emits, per the contract's "Planning Base And Drift" drift-outcome table — mechanically checked
 * the same way as `WorkItemReadinessClassification` above. Note this local union
 * (`fresh`/`drifted`/`stale`/`not_verified`) is a smaller, CLI-actual vocabulary than the
 * contract prose's five-value drift-outcome table (`no_material_drift`, `scope_drift`,
 * `dependency_drift`, `contract_drift`, `conflict_risk`) — a discrepancy this pass flags rather
 * than silently picking one source: the reference adapter has not yet implemented the prose's
 * more granular drift taxonomy.
 */
export type WorkItemRevisionFreshnessClassification = "fresh" | "drifted" | "stale" | "not_verified";

export interface WorkItemRevisionFreshnessRouteRecommendation {
  target: string;
  reason: string;
}

export interface WorkItemRevisionFreshness {
  planned_base_ref?: string;
  planned_base_sha: string | null;
  current_ref?: string;
  current_sha: string | null;
  planned_age_days: number | null;
  changed_files: string[];
  planning_scope_refs: string[];
  planning_scope_intersections: string[];
  commits_since_planned_base: number | null;
  classification: WorkItemRevisionFreshnessClassification;
  route_recommendation?: WorkItemRevisionFreshnessRouteRecommendation;
  reasons: WorkItemReadinessReason[];
}

export interface WorkItemDependencyImpact {
  ref: Record<string, unknown>;
  source: { type: unknown; evidence: unknown };
  cross_repo: boolean;
  known_status: string;
  impact_state: "resolved" | "blocking" | "unknown";
}

/** A `WorkItem` (#775 vocabulary) as `pull-work-provider.ts`'s issue-level listing path emits it:
 * the neutral shape plus the three selection-time fields `classify()`/`revisionFreshness()`/
 * `dependencyImpacts()` attach. */
export interface ClassifiedWorkItem extends WorkItem {
  dependency_impacts: WorkItemDependencyImpact[];
  revision_freshness: WorkItemRevisionFreshness;
  readiness: WorkItemReadiness;
}

export interface WorkItemProviderWarning {
  code: string;
  message: string;
}

export interface WorkItemListResult {
  items: ClassifiedWorkItem[];
  warnings: WorkItemProviderWarning[];
}

export interface WorkItemListOptions {
  /** Current target ref/SHA and reported drift evidence — the "Planning Base And Drift" inputs
   * (`--current-ref`/`--current-sha`/`--changed-file`/`--commits-since` on the CLI). */
  currentRef?: string;
  currentSha?: string;
  changedFiles?: string[];
  commitsSince?: Record<string, number>;
  now?: Date;
  /** `owner/repo#number` -> resolved provider-neutral status, for blocker resolution
   * (`--resolved-ref` on the CLI). */
  resolvedRefs?: Record<string, string>;
}

export interface WorkItemProvider {
  /**
   * List (or re-observe) issue-like work items with per-item readiness classification, computed
   * against the caller's selection settings — the contract's `WorkItemProvider` role.
   * Implemented by: `src/cli/pull-work-provider.ts`'s `main()` `--issues-json` path (`normalize`,
   * `classify`, `revisionFreshness`, `applyFreshnessToReadiness`, `dependencyImpacts` — CLI-
   * internal, not individually exported today; this interface names the CLI's I/O contract at its
   * `main()` boundary, not a class the CLI currently implements — see this file's header and
   * `local-file-provider-adapters.ts` for which interfaces in this module DO have a formal
   * `satisfies` proof).
   * Governing contract sections: work-item-contract.md "Provider Roles", "Work Item Shape",
   * "Planning Base And Drift".
   *
   * `rawIssues` is the provider-native issue array (e.g. a GitHub Issues GraphQL page) the CLI's
   * `normalize()` step maps into `WorkItem` shape; it is typed `unknown[]` because that mapping is
   * provider-specific (this interface's GitHub reference adapter is not the generic vocabulary).
   */
  list(
    settings: EffectiveBacklogProviderSettings,
    rawIssues: unknown[],
    options?: WorkItemListOptions,
  ): WorkItemListResult | Promise<WorkItemListResult>;
}

// ─── BoardProvider ───────────────────────────────────────────────────────────
// work-item-contract.md "Provider Roles": "supplies project, board, milestone, sprint, or queue
// membership and the fields used to order or route work."

export interface BoardProviderWarning {
  code: string;
  message: string;
}

export interface BoardIntakeGapItem {
  id: string;
  title: string;
  status: WorkItemStatus;
  labels: string[];
  source_provider: SourceProvider;
}

export interface BoardReadResult {
  /** Board items whose mapped status is in `selection.filters.ready_statuses`, ranked by
   * priority then board position — `pull-work-provider.ts`'s `boardResult()`. */
  ready_queue: WorkItem[];
  /** Open `WorkItemProvider` issues that are not yet present on the configured board — a
   * board-provider-neutral "triage backlog" surfaced so nothing silently falls off the board. */
  intake_gaps: BoardIntakeGapItem[];
  warnings: BoardProviderWarning[];
}

export interface BoardProvider {
  /**
   * Read board membership and ordering: the ranked ready queue plus intake gaps (open work items
   * not yet triaged onto the board) — the contract's `BoardProvider` role. Implemented by:
   * `src/cli/pull-work-provider.ts`'s `main()` board-driven path (no `--issues-json`):
   * `boardItemsFromDoc`, `openIssuesFromDoc`, `boardResult`. Same CLI-internal-functions caveat as
   * `WorkItemProvider.list` above.
   * Governing contract sections: work-item-contract.md "Provider Roles" (BoardProvider), "GitHub
   * Mapping" > "GitHub Projects as BoardProvider".
   *
   * `boardDoc` is the raw board document `boardItemsFromDoc`/`openIssuesFromDoc` accept — either
   * a caller-supplied JSON document (the CLI's `--items-json`) or the live GraphQL
   * `PROJECT_BOARD_QUERY` response shape the CLI fetches itself. It is typed `unknown` because the
   * CLI itself normalizes several input document shapes (`boardItemsFromDoc`'s fallback chain
   * across `project_items`/`projectItems`/`items`/a raw GraphQL response) rather than enforcing
   * one fixed shape — narrowing this type would silently drop CLI-accepted inputs this interface
   * is supposed to describe faithfully.
   */
  readBoard(
    settings: EffectiveBacklogProviderSettings,
    boardDoc: unknown,
  ): BoardReadResult | Promise<BoardReadResult>;
}

// ─── AssignmentProvider ──────────────────────────────────────────────────────
// assignment-provider-contract.md "AssignmentProvider Operations", formalizing ADR 0021 §2.

export interface AssignmentClaimMeta {
  ttlSeconds: number;
  branch: string;
  artifactDir: string;
  reason?: string;
  actorKey?: string;
  workItemRef?: string;
}

export interface AssignmentReleaseMeta {
  reason?: string;
  actorKey?: string;
  /** When `true`, a missing claim or an ownership mismatch is a tolerated no-op (`null` return)
   * instead of a thrown error — the Stop-hook idempotent-release lifecycle's behavior
   * (`performLocalRelease`'s doc comment); the interactive/default behavior is `false`. */
  tolerateNoActiveClaim?: boolean;
}

export interface AssignmentSupersedeMeta {
  ttlSeconds?: number;
  branch?: string;
  artifactDir?: string;
  reason?: string;
  actorKey?: string;
  workItemRef?: string;
}

export interface AssignmentProvider {
  /**
   * Record durable ownership of `subjectId` for `actor`. ADR 0021 §2's abstract signature
   * documents a `void` return ("caller re-reads via `status` to confirm" —
   * assignment-provider-contract.md "AssignmentProvider Operations" table). The shipped
   * local-file implementation (`performLocalClaim`, `src/cli/assignment-provider.ts`) instead
   * returns the written `AssignmentClaimRecord` directly. This interface follows the actual code
   * (the #775/#776 "code wins over prose" lesson: a discrepancy between contract prose and the
   * reference implementation is flagged, not silently smoothed over) since every caller in this
   * repository already consumes that return value and re-deriving it via a second `status()` call
   * would be strictly less useful, not more contract-faithful.
   *
   * Same actor re-claiming before TTL expiry is idempotent; a different actor claiming an
   * already-`claimed` subject throws (AC7 — never silently overwritten; use `supersede`).
   */
  claim(subjectId: string, actor: ActorStruct, meta: AssignmentClaimMeta): AssignmentClaimRecord | Promise<AssignmentClaimRecord>;

  /**
   * Clear durable ownership and leave a handoff note. `releasedBy: null` performs an
   * unconditional release (no ownership check); every other caller should pass the releasing
   * actor so ownership is verified before the record is cleared (AC6 — never force-release a
   * claim held by a different actor). Returns `null` when `meta.tolerateNoActiveClaim` is set and
   * there was nothing to release (an idempotent no-op) or ownership could not be verified; returns
   * the terminal `AssignmentClaimRecord` (`status: "released"`) otherwise.
   */
  release(
    subjectId: string,
    releasedBy: ActorStruct | null,
    meta?: AssignmentReleaseMeta,
  ): AssignmentClaimRecord | null | Promise<AssignmentClaimRecord | null>;

  /** Reassign ownership from a lapsed actor (`from`) to a successor (`to`), with an audit-trail
   * note. Throws when `from` does not match the current holder — never force-reassigns a claim
   * held by someone else. */
  supersede(
    subjectId: string,
    from: ActorStruct,
    to: ActorStruct,
    meta?: AssignmentSupersedeMeta,
  ): AssignmentClaimRecord | Promise<AssignmentClaimRecord>;

  /**
   * Read current assignment-layer state WITHOUT joining liveness — assignment-layer truth only
   * (assignment-provider-contract.md "AssignmentProvider Operations" / "The assignment ⋈
   * liveness join"). A caller that needs to know whether work is actually available must
   * additionally join this against `freshHolders` (`scripts/hooks/lib/liveness-read.js`) via
   * `computeEffectiveState` (`src/cli/assignment-provider.ts`) — this method alone never answers
   * that question; it deliberately mirrors the contract's own "never trust one layer alone"
   * framing rather than baking a join this interface does not own into its return shape.
   */
  status(subjectId: string): AssignmentStatus | Promise<AssignmentStatus>;

  /** Enumerate subject ids currently claimed, optionally filtered to one actor's canonical
   * actor key (the same flat/bare token `resolveActor(env).actor`, `liveness whoami`, and every
   * other actor-key consumer in this repository already use — see
   * assignment-provider-contract.md's `actor_key` field doc). */
  list(actorKey?: string): string[] | Promise<string[]>;
}

// ─── WorkItemMutationProvider ────────────────────────────────────────────────
// work-item-contract.md "Mutations" (issue #776).

export interface WorkItemMutationProvider {
  /**
   * Execute (or render) a single provider-neutral mutation request, per the contract's
   * "Operations" table (`status_transition` | `field_update` | `comment`) and "Render, Don't
   * Execute". A provider with direct storage access performs the mutation itself and returns
   * `status: "applied"` (e.g. `applyLocalFileMutation`, `src/cli/work-item-mutation-provider.ts`
   * — it self-observes current state and ignores `observed`); a provider that must defer
   * execution to an external host instead renders the native command and returns
   * `rendered`/`conflict`/`rejected`/`not_verified` without executing anything (e.g.
   * `renderGithubMutation`'s pure `gh` argv render).
   *
   * `observed` is the caller's freshly re-fetched provider-state snapshot to diff `request.base`
   * against, per the Conflict Policy ("provider wins, with staleness detection"). Every adapter
   * that cannot read its own storage (the GitHub render adapter) REQUIRES it and returns
   * `not_verified` when omitted for a non-`comment` operation; an adapter with direct storage
   * access (the local-file adapter) ignores it. `comment` mutations never use it (append-only,
   * non-clobbering — see the Conflict Policy).
   *
   * This provider-neutral signature deliberately omits the GitHub adapter's extra
   * `GithubMutationTarget` parameter (a validated repo/number/optional project-field coordinate —
   * see `renderGithubMutation` and `parseGithubMutationTarget` in
   * `src/cli/work-item-mutation-provider.ts`): growing this interface a GitHub-specific parameter
   * every adapter does not need would stop it from being provider-neutral. A GitHub-specific host
   * binds or supplies that target itself (e.g. a small closure/factory around
   * `renderGithubMutation`) outside this interface's generic surface — this is a known, deliberate
   * scope line, not an oversight; see this file's header "Derivation order" note and
   * `local-file-provider-adapters.ts`, which proves the local-file side of this interface
   * (the GitHub render side is not proven here because that extra parameter cannot be dropped
   * without changing `renderGithubMutation`'s actual, reviewed signature).
   */
  mutate(
    request: WorkItemMutationRequest,
    observed?: WorkItemMutationBase | null,
  ): WorkItemMutationResult | Promise<WorkItemMutationResult>;
}
