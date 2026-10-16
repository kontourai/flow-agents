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
// Type-only imports of the CLI's OWN exported runtime const arrays (#777 review finding 5):
// `WorkItemReadinessClassification`/`ReferenceAdapterFreshnessDiagnostic` below derive their
// union directly from these arrays via `typeof ...[number]`, so a change to what `classify()`/
// `classifyRevisionFreshness()` actually emit is a type error here, not a silently-stale hand
// copy. `import type` keeps this module's own import graph runtime-value-free (see this file's
// header); the `typeof` type-query usage of these names is a type-only use, which `import type`
// permits.
import type { referenceAdapterFreshnessDiagnostics, workItemReadinessClassifications } from "./pull-work-provider.js";

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
 * The exact classification literals `pull-work-provider.ts`'s `classify()` emits — derived
 * directly from that module's own exported `workItemReadinessClassifications` runtime const array
 * (#777 review finding 5), so this type cannot silently drift from what the function actually
 * returns; `provider-interfaces.test.mjs` additionally asserts the array's current value.
 * Distinct from `WorkItemStatus` (`work-item-vocabulary.ts`, #775): that is the provider-neutral
 * LIFECYCLE status a work item carries; this is the SELECTION verdict `pull-work` derives from
 * status, blockers, and labels for a given selection-settings pass.
 */
export type WorkItemReadinessClassification = (typeof workItemReadinessClassifications)[number];

export interface WorkItemReadiness {
  classification: WorkItemReadinessClassification;
  reasons: WorkItemReadinessReason[];
}

/**
 * The contract's NORMATIVE five-value MATERIAL-DRIFT JUDGMENT vocabulary, verbatim from
 * work-item-contract.md's "Planning Base And Drift" table: `no_material_drift` (aligned),
 * `scope_drift` (scope/acceptance criteria changed), `dependency_drift` (assumed
 * blockers/prerequisites moved), `contract_drift` (relevant docs/contracts/schemas/policy
 * changed), `conflict_risk` (changed files or active work overlap likely execution scope).
 *
 * DISTINCT DIMENSION from `ReferenceAdapterFreshnessDiagnostic` below (#818, correcting an
 * earlier #818 draft that wrongly treated these as competing/overlapping vocabularies for the
 * same signal and retired this one — see git history on this doc comment for that dead end).
 * `ReferenceAdapterFreshnessDiagnostic` grades revision-freshness SEVERITY: how stale is the
 * planning base, mechanically, from `pull-work-provider.ts`'s `classifyRevisionFreshness()`. This
 * type classifies the KIND of drift for ROUTING: why does it matter, and where should the item go
 * next. They compose: `pull-work`'s CLI emits `ReferenceAdapterFreshnessDiagnostic` on
 * `revision_freshness.classification`; pickup Probe (`kits/builder/skills/pickup-probe/SKILL.md`,
 * `kits/builder/skills/pull-work/SKILL.md`) is the actor that produces THIS type's value, informed
 * by that freshness signal plus data the CLI already carries but does not fold into freshness —
 * `dependencyImpacts()`'s blocker-resolution state, and (via the Builder handoff) planning
 * scope/expected-files/conflict-risk context — not by `FreshnessInputs` alone. No `WorkItemProvider`
 * CLI emits this type today (that remains true and is not itself a defect: it is Probe's judgment
 * output, not adapter output), so nothing in `pull-work-provider.ts` derives this type from a
 * runtime array the way `ReferenceAdapterFreshnessDiagnostic` does — keep it a plain literal union.
 * Do not treat the two types as interchangeable or silently map one onto the other.
 */
export type WorkItemDriftOutcome = "no_material_drift" | "scope_drift" | "dependency_drift" | "contract_drift" | "conflict_risk";

/**
 * The reference adapter's revision-freshness SEVERITY diagnostic — derived directly from
 * `pull-work-provider.ts`'s own exported `referenceAdapterFreshnessDiagnostics` runtime const
 * array (#777 review finding 5), so this type cannot silently drift from what
 * `classifyRevisionFreshness()` actually returns. This is a DIFFERENT DIMENSION from
 * `WorkItemDriftOutcome` above, not a narrower version of it — see that type's doc comment for how
 * the two compose (mechanical freshness severity here vs. Probe's material-drift routing judgment
 * there). `WorkItemRevisionFreshness` carries THIS diagnostic on `classification`.
 */
export type ReferenceAdapterFreshnessDiagnostic = (typeof referenceAdapterFreshnessDiagnostics)[number];

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
  /** The reference adapter's mechanical freshness-severity diagnostic — NOT
   * `WorkItemDriftOutcome` (Probe's material-drift routing judgment, a distinct dimension). See
   * `ReferenceAdapterFreshnessDiagnostic`'s doc comment (#818). */
  classification: ReferenceAdapterFreshnessDiagnostic;
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
// The AssignmentProvider contract is the engine's kit-neutral coordination primitive and lives in
// `src/lib/assignment-model.ts` (published as `@kontourai/flow-agents/assignment-contract`); it is
// re-exported here so existing imports keep working. `LocalAssignmentProviderExt` is the local-file
// store's capability extension (`src/lib/assignment-local-store.ts`).
export type {
  AssignmentClaimMeta,
  AssignmentProvider,
  AssignmentReleaseMeta,
  AssignmentSupersedeMeta,
} from "../lib/assignment-model.js";
export type { LocalAssignmentProviderExt } from "../lib/assignment-local-store.js";

// ─── WorkItemMutationProvider ────────────────────────────────────────────────
// work-item-contract.md "Mutations" (issue #776).

/**
 * Per-call context for `WorkItemMutationProvider.mutate` (#777 review finding 4). Carries the two
 * things a mutation adapter may need beyond the request itself: `observed` (provider-neutral,
 * every adapter's own type) and `providerTarget` (adapter-specific, deliberately opaque here).
 *
 * `providerTarget` is what lets ONE provider-neutral `mutate()` signature actually type BOTH
 * shipped adapters: the local-file adapter needs no target (its `file` is bound at adapter
 * construction — see `createLocalFileMutationProvider`), while the GitHub render adapter needs a
 * validated `GithubMutationTarget` (repo/number/optional project-field coordinate) PER CALL,
 * because a single long-lived renderer instance is used across many different work items over its
 * lifetime (unlike `file`, target is not adapter-construction-stable — see
 * `createGithubMutationRenderer` in `github-mutation-renderer.ts`). Typing this slot `unknown`
 * rather than `GithubMutationTarget` keeps the interface itself provider-neutral; each concrete
 * adapter documents and validates/narrows what it expects here (the GitHub renderer delegates
 * that validation to the already-reviewed `parseGithubMutationTarget`).
 */
export interface ProviderMutationContext {
  /** The caller's freshly re-fetched provider-state snapshot to diff `request.base` against, per
   * the Conflict Policy ("provider wins, with staleness detection"). Every adapter that cannot
   * read its own storage (the GitHub render adapter) REQUIRES it and returns `not_verified` when
   * omitted for a non-`comment` operation; an adapter with direct storage access (the local-file
   * adapter) ignores it. `comment` mutations never use it (append-only, non-clobbering). */
  observed?: WorkItemMutationBase | null;
  /** Adapter-specific validated render/write target, opaque to this provider-neutral interface.
   * See this interface's doc comment for why it is per-call, not adapter-construction-time. */
  providerTarget?: unknown;
}

export interface WorkItemMutationProvider {
  /**
   * Execute (or render) a single provider-neutral mutation request, per the contract's
   * "Operations" table (`status_transition` | `field_update` | `comment`) and "Render, Don't
   * Execute". A provider with direct storage access performs the mutation itself and returns
   * `status: "applied"` (e.g. `applyLocalFileMutation`, `src/cli/work-item-mutation-provider.ts`
   * — it self-observes current state and ignores `context`); a provider that must defer execution
   * to an external host instead renders the native command and returns
   * `rendered`/`conflict`/`rejected`/`not_verified` without executing anything (e.g.
   * `renderGithubMutation`'s pure `gh` argv render, via `context.observed`/`context.providerTarget`
   * — see `createGithubMutationRenderer` in `github-mutation-renderer.ts`, which proves this
   * interface types the GitHub side too, not just the local-file side).
   * See `ProviderMutationContext`'s doc comment for `observed`/`providerTarget`'s full semantics.
   */
  mutate(
    request: WorkItemMutationRequest,
    context?: ProviderMutationContext,
  ): WorkItemMutationResult | Promise<WorkItemMutationResult>;
}
