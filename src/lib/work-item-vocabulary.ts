/**
 * Provider-neutral work-item vocabulary and shapes (#775).
 *
 * Canonical source: `context/contracts/work-item-contract.md` ("Status
 * Guidance" and "Work Item Shape"). Native hosts should import these
 * instead of hand-mirroring the neutral status vocabulary or the work-item
 * field shape.
 *
 * `workItemStatuses` is the same lifecycle vocabulary embedded as JSON-Schema
 * enums in `schemas/backlog-provider-settings.schema.json`
 * (`selection.filters.ready_statuses` union `selection.filters.exclude_statuses`
 * union `selection.wip_policy.active_statuses`), minus the schema's `triage`
 * value. `triage` is a board pre-readiness intake sentinel (see
 * `docs/decisions/backlog-readiness-source.md`), not a workflow-facing
 * lifecycle status, so it is intentionally excluded here.
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

/** A single value from {@link workItemStatuses}. */
export type WorkItemStatus = (typeof workItemStatuses)[number];

/**
 * Provider identity and source location for a work item, per the contract's
 * `source_provider` field. Provider-specific identifiers (issue number, node
 * id, state, capabilities, etc.) are carried as additional properties rather
 * than a fixed field list.
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
  /** Canonical URL for the source record. */
  url?: string;
  /** Provider-specific identifiers and metadata. */
  [key: string]: unknown;
}

/**
 * Board, project, milestone, sprint, or queue membership supplied by a
 * `BoardProvider`, per the contract's `board_membership` /
 * `project_membership` field. Provider-specific fields (status field,
 * column, custom fields, capabilities, etc.) are carried as additional
 * properties rather than a fixed field list.
 */
export interface BoardMembership {
  /** Provider kind supplying board membership, e.g. `"github"`. */
  kind?: string;
  /** Board, project, milestone, sprint, or queue name. */
  board?: string;
  /** Provider-specific board fields and metadata. */
  [key: string]: unknown;
}

/**
 * The provider-neutral work-item shape from the contract's "Work Item
 * Shape" and "Planning Base And Drift" field tables. Provider-specific
 * fields beyond this shape may be carried as adapter metadata (e.g. inside
 * `source_provider` or `board_membership`).
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
  blockers?: string[];
  /** URLs or provider references for related issues, discussions, docs, designs, incidents, and decisions. */
  related_links?: string[];
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
}
