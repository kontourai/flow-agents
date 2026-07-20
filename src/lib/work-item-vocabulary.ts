/**
 * Provider-neutral work-item vocabulary and shapes (#775).
 *
 * Canonical source: `context/contracts/work-item-contract.md` ("Status
 * Guidance" and "Work Item Shape"). Native hosts should import these
 * instead of hand-mirroring the neutral status vocabulary or the work-item
 * field shape.
 *
 * The structured shapes below (`BoardRef`, `ProviderRef`, `WorkItemBlocker`,
 * `WorkItemSourceRevision`, and the `board_membership`/`blockers`/
 * `related_links`/`updated_at`/`created_at`/`source_revisions` fields on
 * `WorkItem`) are derived from what `src/cli/pull-work-provider.ts`'s GitHub
 * adapter actually emits (see `normalize()` and `boardCandidate()`), not
 * only from the contract's prose field table, which does not enumerate a
 * fixed shape for those fields (and does not mention `updated_at`,
 * `created_at`, or `source_revisions` at all — a known contract-doc gap
 * relative to the reference adapter).
 *
 * `workItemStatuses` is the same lifecycle vocabulary embedded as JSON-Schema
 * enums in `schemas/backlog-provider-settings.schema.json`
 * (`selection.filters.ready_statuses` union `selection.filters.exclude_statuses`
 * union `selection.wip_policy.active_statuses`), minus the schema's `triage`
 * value. `triage` is a board pre-readiness intake sentinel (see
 * `docs/decisions/backlog-readiness-source.md`), not a workflow-facing
 * lifecycle status, so it is intentionally excluded here. Note the GitHub
 * adapter's `statusKey()` falls back to the raw, normalized board status
 * string (e.g. `"triage"`) when it does not recognize it, so a work item's
 * `status` field is not strictly guaranteed to be one of `workItemStatuses`
 * at runtime; `WorkItem.status` is typed to allow that.
 *
 * @module
 */

/**
 * Provider-neutral work-item lifecycle statuses, in lifecycle order.
 */
export const workItemStatuses = [
  "todo",
  "ready",
  "in_progress",
  "blocked",
  "review",
  "verification",
  "done",
] as const;

/**
 * A value from {@link workItemStatuses}, or any other provider-normalized
 * status string the adapter did not recognize (e.g. a board's pre-readiness
 * `"triage"` status) — see the module-level note on `statusKey()`.
 */
export type WorkItemStatus = (typeof workItemStatuses)[number] | (string & {});

/**
 * Provider identity and source location for a work item, per the contract's
 * `source_provider` field. Modeled on the GitHub `WorkItemProvider` adapter's
 * emitted shape (`{ role, kind, owner, repo, number, url, state, node_id,
 * capabilities }`); other provider-specific identifiers are carried as
 * additional properties rather than a fixed field list.
 */
export interface SourceProvider {
  /** Provider kind, e.g. `"github"`. */
  kind: string;
  /** Provider role that supplied this record, when known, e.g. `"WorkItemProvider"`. */
  role?: string;
  /** Owner, organization, or workspace that scopes the repo/project. */
  owner?: string;
  /** Repository or project name. */
  repo?: string;
  /** Provider-native issue/item number, when the provider uses numeric ids. */
  number?: number;
  /** Canonical URL for the source record. */
  url?: string;
  /** Provider-native lifecycle state, e.g. GitHub's `"OPEN"` / `"CLOSED"`. */
  state?: string;
  /** Provider-native node/opaque id, when distinct from `id`/`number`. */
  node_id?: string;
  /** Capabilities the configured `WorkItemProvider` declares (see the work-item contract's Capability Flags). */
  capabilities?: string[];
  /** Provider-specific identifiers and metadata. */
  [key: string]: unknown;
}

/**
 * The configured board reference from `backlog-provider-settings.schema.json`
 * (`board_provider.board`): `{ type, owner?, number, url? }`, e.g. a GitHub
 * Projects v2 board.
 */
export interface BoardRef {
  /** Board kind, e.g. `"github_project"`. */
  type: string;
  /** Board/project number. */
  number: number;
  /** Board/project owner (org or user), when distinct from the repo owner. */
  owner?: string;
  /** Canonical URL for the board/project. */
  url?: string;
}

/**
 * Board, project, milestone, sprint, or queue membership supplied by a
 * `BoardProvider`, per the contract's `board_membership` /
 * `project_membership` field. Modeled on the GitHub `BoardProvider` adapter's
 * emitted shape (`{ role, kind, board, project_item_id, position, status,
 * priority, capabilities }` for the board-driven path, or `{ role, kind,
 * board, items, capabilities }` for the issue-listing path); other
 * provider-specific fields are carried as additional properties rather than
 * a fixed field list.
 */
export interface BoardMembership {
  /** Provider role that supplied this record, when known, e.g. `"BoardProvider"`. */
  role?: string;
  /** Provider kind supplying board membership, e.g. `"github"`. */
  kind?: string;
  /** The configured board/project this item belongs to. */
  board?: BoardRef;
  /** Provider-native board/project item id, when distinct from `id`. */
  project_item_id?: string;
  /** Rank/position within the board's ready queue, when the provider orders items. */
  position?: number;
  /** Board's raw (unmapped) status/column value, e.g. `"Triage"`, `"Ready"`, `"In Progress"`. */
  status?: string;
  /** Board's raw priority field value, when distinct from the work item's mapped `priority`. */
  priority?: string;
  /** Capabilities the configured `BoardProvider` declares (see the work-item contract's Capability Flags). */
  capabilities?: string[];
  /** Provider-specific board fields and metadata. */
  [key: string]: unknown;
}

/**
 * A provider-native reference to another work item, e.g. a cross-linked
 * GitHub issue or pull request extracted from a work item's body.
 */
export interface ProviderRef {
  /** Provider kind, e.g. `"github"`. */
  kind?: string;
  /** Owner, organization, or workspace of the referenced record. */
  owner?: string;
  /** Repository of the referenced record. */
  repo?: string;
  /** Provider-native issue/item number, when the provider uses numeric ids. */
  number?: number;
  /** Canonical URL for the referenced record, when captured. */
  url?: string;
  /** Provider-specific identifiers and metadata. */
  [key: string]: unknown;
}

/**
 * A single blocking work item, decision, external dependency, or explicit
 * blocked reason, per the contract's `blockers` field. Modeled on the GitHub
 * adapter's emitted shape: `{ type: "provider_ref", ref: ProviderRef,
 * evidence }` when a cross-reference was extracted, or `{ type: "text",
 * evidence }` for a prose-only blocker mention.
 */
export interface WorkItemBlocker {
  /** Blocker kind, e.g. `"provider_ref"` or `"text"` (adapters may emit other values). */
  type: string;
  /** The referenced blocking work item, when a provider reference was extracted. */
  ref?: ProviderRef;
  /** Human-readable evidence for the blocker (the source text it was extracted from, or a caller-supplied summary). */
  evidence?: string;
  /** Provider-specific blocker fields and metadata. */
  [key: string]: unknown;
}

/**
 * A single source-revision entry from a work item's embedded planning
 * metadata, per the contract's "Planning Base And Drift" recommended
 * fields. Modeled on the GitHub adapter's `normalizeSourceRevision()`
 * output; present when a work item's body embeds
 * `<!-- flow-agents:work-item-metadata -->` with a `source_revisions` array
 * (e.g. a multi-repo work item shaped against more than one repo).
 */
export interface WorkItemSourceRevision {
  /** `owner/repo` this revision entry applies to, for multi-repo work items. */
  repo?: string;
  /** Branch or ref used when shaping the work item, usually `main`. */
  planned_base_ref?: string;
  /** Exact commit SHA of `planned_base_ref` at shaping time. */
  planned_base_sha?: string;
  /** Timestamp when the work item was shaped or last materially re-shaped. */
  planned_at?: string;
  /** Idea-to-backlog, design, ADR, or plan artifact that produced the work item. */
  planning_artifact_ref?: string;
  /** Key docs, contracts, schemas, files, or packages considered during shaping. */
  planning_scope_refs?: string[];
}

/**
 * The provider-neutral work-item shape from the contract's "Work Item
 * Shape" and "Planning Base And Drift" field tables, plus `updated_at`,
 * `created_at`, and `source_revisions`, which the GitHub reference adapter
 * emits but the contract's field table does not currently document (see
 * the module-level note). Provider-specific fields beyond this shape may be
 * carried as adapter metadata (e.g. inside `source_provider` or
 * `board_membership`).
 */
export interface WorkItem {
  /** Stable provider identifier, such as an issue number or provider-qualified id. */
  id: string;
  /** Human-readable summary. */
  title: string;
  /** Main description, problem statement, or request body. */
  body?: string;
  /** Provider-neutral lifecycle state or mapped board status. */
  status?: WorkItemStatus;
  /** Provider labels, tags, components, or categories used for filtering and triage. */
  labels?: string[];
  /** Alias for `labels` some adapters use. */
  tags?: string[];
  /** Provider priority value mapped without changing meaning, such as `P0`, `P1`, or `high`. */
  priority?: string;
  /** Estimated implementation size, complexity, or effort. */
  size?: string;
  /** Delivery, technical, product, security, migration, or coordination risk. */
  risk?: string;
  /** Blocking work items, decisions, external dependencies, or explicit blocked reasons. */
  blockers?: WorkItemBlocker[];
  /** Provider references for related issues, discussions, docs, designs, incidents, and decisions. */
  related_links?: ProviderRef[];
  /** Provider identity and source location. */
  source_provider: SourceProvider;
  /** Board, project, milestone, sprint, queue, column, or status-field membership from a `BoardProvider`. */
  board_membership?: BoardMembership;
  /** Alias for `board_membership` some adapters/contract text use. */
  project_membership?: BoardMembership;
  /** Pull requests, merge requests, or changesets associated with the work item. */
  pr_links?: string[];
  /** Workflow artifacts, sidecars, evidence, plans, reviews, handoffs, or durable docs that trace the work. */
  artifact_refs?: string[];
  /** Branch or ref used when shaping the work item, usually `main`. */
  planned_base_ref?: string;
  /** Exact commit SHA of `planned_base_ref` at shaping time. */
  planned_base_sha?: string;
  /** Timestamp when the work item was shaped or last materially re-shaped. */
  planned_at?: string;
  /** Idea-to-backlog, design, ADR, or plan artifact that produced the work item. */
  planning_artifact_ref?: string;
  /** Key docs, contracts, schemas, files, or packages considered during shaping. */
  planning_scope_refs?: string[];
  /** Issues, changes, releases, or commits assumed complete, pending, or blocking during shaping. */
  dependency_refs?: string[];
  /** Provider's last-updated timestamp for the underlying record. */
  updated_at?: string;
  /** Provider's creation timestamp for the underlying record. */
  created_at?: string;
  /** Per-repo planning-base entries, present for work items whose embedded metadata spans more than one repo. */
  source_revisions?: WorkItemSourceRevision[];
}
