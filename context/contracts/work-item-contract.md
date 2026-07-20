# Work Item Contract

> Read [`context/contracts/standing-directives.md`](standing-directives.md) — ratified owner directives that override default engineering conservatism.

This contract defines the provider-neutral vocabulary for selecting, planning, and handing off backlog work. It is the source shape for provider-backed workflows such as `pull-work`; provider-specific adapters map into this model without making GitHub, Jira, Linear, or any other provider the generic language.

Native hosts should consume this vocabulary from `@kontourai/flow-agents` instead of hand-mirroring it: the package exports `workItemStatuses` (the ordered `WorkItemStatus` lifecycle array below) and the `WorkItem`, `SourceProvider`, and `BoardMembership` TypeScript interfaces from its library entry (`src/lib/work-item-vocabulary.ts`). The shipped JSON Schemas, including `backlog-provider-settings.schema.json` whose status enums this vocabulary summarizes, are also resolvable via the package's `./schemas/*` export subpath instead of `require.resolve` path math.

## Provider Roles

- `WorkItemProvider`: supplies issue-like records that represent requested work, defects, chores, or decisions.
- `BoardProvider`: supplies project, board, milestone, sprint, or queue membership and the fields used to order or route work.
- `ChangeProvider`: supplies branch, review, merge request, pull request, changeset, release, or deploy records that represent a published implementation.

A single external system can implement both roles. For example, GitHub Issues is a `WorkItemProvider`, while GitHub Projects is a `BoardProvider`.

## Work Item Shape

Every provider-backed work item should preserve the stable fields below when the provider can supply them. `@kontourai/flow-agents` exports this shape as the `WorkItem` TypeScript interface (with `SourceProvider` and `BoardMembership` for the corresponding nested fields).

| Field | Required | Description |
| --- | --- | --- |
| `id` | yes | Stable provider identifier, such as an issue number, opaque item id, or provider-qualified id. |
| `title` | yes | Human-readable summary. |
| `body` | optional | Main description, problem statement, or request body. |
| `status` | optional | Provider-neutral lifecycle state or mapped board status, such as `todo`, `ready`, `in_progress`, `blocked`, `review`, `verification`, or `done`. |
| `labels` / `tags` | optional | Provider labels, tags, components, or categories used for filtering and triage. |
| `priority` | optional | Provider priority value mapped without changing meaning, such as `P0`, `P1`, or `high`. |
| `size` | optional | Estimated implementation size, complexity, or effort. |
| `risk` | optional | Delivery, technical, product, security, migration, or coordination risk. |
| `blockers` | optional | Blocking work items, decisions, external dependencies, or explicit blocked reasons. |
| `related_links` | optional | URLs or provider references for related issues, discussions, docs, designs, incidents, and decisions. |
| `source_provider` | yes | Provider identity and source location, including provider kind, owner or workspace, repository or project, and canonical URL when available. |
| `project_membership` / `board_membership` | optional | Board, project, milestone, sprint, queue, column, or status-field membership supplied by a `BoardProvider`. |
| `pr_links` | optional | Pull requests, merge requests, or changesets associated with the work item. |
| `artifact_refs` | optional | Workflow artifacts, sidecars, evidence, plans, reviews, handoffs, or durable docs that trace the work. |

Provider-specific fields may be carried as adapter metadata, but generic workflow skills should make selection and handoff decisions from the neutral shape above.

## Planning Base And Drift

Executable work items should record the source revision that shaped their scope. This lets pickup Probe compare the current repository against the assumptions used when the work entered the backlog.

Recommended fields:

| Field | Required | Description |
| --- | --- | --- |
| `planned_base_ref` | recommended | Branch or ref used when shaping the work item, usually `main`. |
| `planned_base_sha` | recommended | Exact commit SHA of `planned_base_ref` at shaping time. |
| `planned_at` | recommended | Timestamp when the work item was shaped or last materially re-shaped. |
| `planning_artifact_ref` | recommended | Idea-to-backlog, design, ADR, or plan artifact that produced the work item. |
| `planning_scope_refs` | optional | Key docs, contracts, schemas, files, or packages considered during shaping. |
| `dependency_refs` | optional | Issues, changes, releases, or commits assumed complete, pending, or blocking during shaping. |

`pull-work` and pickup Probe should compare `planned_base_sha` with the current target ref before planning implementation. At minimum, record:

- current target ref and SHA
- files, docs, contracts, or schemas changed since `planned_base_sha` when they overlap `planning_scope_refs` or likely execution scope
- dependency issue/change state that has moved since shaping
- whether drift is material to scope, acceptance criteria, dependencies, or risk

Pickup Probe drift outcomes:

| Outcome | Meaning |
| --- | --- |
| `no_material_drift` | The work item is still aligned with current main and dependencies. |
| `scope_drift` | Current code/docs changed the intended scope or acceptance criteria; ask for alignment or route back to shaping. |
| `dependency_drift` | Assumed blockers, prerequisites, or related changes moved; refresh dependency assumptions before planning. |
| `contract_drift` | Relevant docs, contracts, schemas, or provider policies changed; re-check the work item against the current contract. |
| `conflict_risk` | Changed files or active work overlap likely execution scope; require worktree, rebase, sequencing, or coordination before planning. |

If a legacy work item lacks `planned_base_sha`, pickup Probe should record the gap and use current main plus provider history as the best available baseline instead of inventing certainty.

## Publish Change Shape

`publish-change` is the provider-neutral step between clean local evidence and release readiness. It publishes the verified diff to a `ChangeProvider`, records the provider result, and collects provider checks without making any one provider's terms core workflow vocabulary.

### Authenticated ChangeProvider completion

For a Builder `pull-request-opened` gate, a generic publish result is descriptive evidence, not
completion authority. The only completion path is the configured public operation
`flow-agents publish-change execute --session-dir <session-dir>`. It accepts bounded title, body,
base ref, head ref, and optional draft intent, and derives repository, immutable head SHA, current
assignment actor, canonical run/definition/step, and current gate-visit identity from Flow state.

ChangeProvider configuration is explicit and secret-free: project
`<repo-path>/context/settings/change-provider-settings.json` overrides global
`$HOME/.config/flow-agents/change-provider-settings.json` in this order: global defaults, matching
global project entry, project defaults, matching project entry. A configured provider must declare
the `ChangeProvider` role and compatible create/observe capabilities. Absent configuration remains
`external_capability_required`; malformed or incompatible configuration remains unavailable with
its reason. Neither state may expose an executable completion claim or be rewritten as a completed
provider change.

An authenticated provider observation is bounded to the operation binding, provider kind,
configuration id and adapter, repository, provider record id/number/HTTPS URL, normalized
published state (`open` or `merged`),
base/head refs and immutable SHA, the bound `assignment_actor`, the authenticated provider's
`provider_actor`, and observation time. Flow must reacquire its subject
lock before persistence and revalidate assignment ownership, active gate visit, request binding,
and effective configuration. It writes only `publish-change.result.json`, attaches only
`pull-request-opened`, requires that canonical evaluation to advance exactly one step, and projects
the resulting state.

Caller-authored result JSON, generic evidence, and private/package-internal writers have no
completion authority. Authentication data and provider diagnostics must not be persisted in
configuration, artifacts, trust bundles, logs, or snapshots. A retry after provider or transport
failure must recover an exact matching published change before attempting another create. An exact
merged record is valid when reconciling provider work that completed before the local run caught up;
ambiguity, wrong repository/base/head/SHA/intent, stale or closed-but-unmerged records, or multiple matches fail without
creating or selecting a duplicate.

### References

Use typed references instead of provider-specific nouns in core artifacts:

| Ref | Description |
| --- | --- |
| `work_item_ref` | Provider-backed work request, defect, task, or decision selected for the workflow. |
| `board_ref` | Project, board, queue, milestone, sprint, or planning surface that contextualizes the work item. |
| `change_ref` | Published implementation record such as a pull request, merge request, changeset, review request, release proposal, or deploy request. |
| `evidence_ref` | Workflow evidence, CI/check run, test report, review artifact, governance report, or provider-native proof linked to the change. |

### PublishChangeResult

A publish-change result should preserve:

| Field | Required | Description |
| --- | --- | --- |
| `provider` | yes | Stable provider id and adapter version when known. |
| `status` | yes | `published`, `updated`, `skipped`, `failed`, or `not_verified`. |
| `work_item_refs` | optional | Work items the change intends to address. |
| `board_refs` | optional | Board or project records affected by the change. |
| `change_ref` | optional | Provider change identity, canonical URL, branch, target, and state. Required unless status is `skipped`, `failed`, or `not_verified`. |
| `closing_reference_check` | optional | Whether the provider recognized references that will close or resolve work items. |
| `provider_checks` | optional | Provider-native checks such as CI, required review, policy, mergeability, status, or deployment gates. |
| `evidence_refs` | optional | Local sidecars, standard evidence artifacts, provider checks, and external evidence records used for release readiness. |
| `summary` | yes | Human-readable outcome and next action. |

### ClosingReferenceCheck

Closing-reference recognition is provider behavior. Core workflow artifacts should record the neutral result:

| Field | Required | Description |
| --- | --- | --- |
| `expected_work_item_refs` | yes | Work items the change is expected to close, resolve, or complete. |
| `recognized_work_item_refs` | yes | Work items the provider reports as recognized by the change record. |
| `missing_work_item_refs` | yes | Expected refs not recognized by the provider. |
| `status` | yes | `pass`, `fail`, `not_verified`, or `skip`. |
| `evidence_refs` | optional | Provider API response, rendered body, check output, or dry-run fixture supporting the result. |

If closing behavior matters and expected refs are missing, publish-change must return `fail` or `not_verified`; do not hide it as a successful publish.

### Provider Checks

Provider checks are external facts used by evidence-gate and release-readiness. Examples include CI checks, required status checks, branch protection, mergeability, required review, deployment checks, and external policy checks. Record them as provider-neutral check records with status `pass`, `fail`, `not_verified`, or `skip`, plus evidence refs.

Missing provider checks are risk-sensitive:

- Docs-only changes may pass with an explicit `skip` when the skipped provider check is not required by the repository and the artifact records why local review is enough.
- Runtime, schema, package, hook, security, migration, release, or infrastructure changes require provider check evidence or an explicit `not_verified` / release `hold`.
- A provider being unavailable is not a pass. Record `not_verified` unless the workflow explicitly chooses a low-risk no-provider path.

## Capability Flags

Adapters must describe provider capabilities explicitly so workflows can avoid assuming unavailable fields.

| Capability | Meaning |
| --- | --- |
| `issues` | Provider can list or read issue-like work items. |
| `projects_boards` | Provider can list or read project, board, queue, sprint, or milestone membership. |
| `status_fields` | Provider exposes lifecycle, column, state, or status field values. |
| `custom_fields` | Provider exposes typed project or work item fields beyond the base shape. |
| `dependencies` | Provider exposes blocked-by, blocks, parent-child, or linked-dependency relationships. |
| `labels` | Provider exposes labels, tags, components, or categories. |
| `milestones` | Provider exposes milestones, releases, iterations, or equivalent delivery targets. |
| `assignees` | Provider exposes owner or assignee information. |
| `pr_links` | Provider exposes pull request, merge request, changeset, or branch links. |
| `comments` | Provider exposes discussion comments or activity entries. |
| `change_records` | Provider exposes branch, pull request, merge request, changeset, release, deploy, or review records. |
| `closing_references` | Provider reports whether change text or metadata will close, resolve, or complete linked work items. |
| `checks` | Provider exposes CI, status, review, mergeability, policy, deployment, or equivalent checks. |

Capabilities are descriptive, not discovery settings. Provider settings and configured-provider discovery are separate implementation concerns.

## Status Guidance

Adapters may keep the provider's original status in metadata, but workflow-facing status should be mapped to a small neutral category when possible. `@kontourai/flow-agents` exports this list as the ordered `workItemStatuses` array (and the `WorkItemStatus` type):

- `todo`: known work that is not ready or started.
- `ready`: scoped work that can be selected.
- `in_progress`: work currently owned or being implemented.
- `blocked`: work waiting on another item, decision, access, or external event.
- `review`: work waiting for human or automated critique.
- `verification`: work waiting for validation, evidence, or CI.
- `done`: accepted, closed, merged, released, or otherwise complete according to the provider.

When a provider has more detail than these categories, carry it in `project_membership`, `board_membership`, or adapter metadata rather than expanding the generic status vocabulary.

## GitHub Mapping

GitHub is the first concrete mapping for this contract, not the generic vocabulary.

### GitHub Issues as `WorkItemProvider`

| Work item field | GitHub Issues source |
| --- | --- |
| `id` | Repository-qualified issue number or node id. |
| `title` | Issue title. |
| `body` | Issue body. |
| `status` | Issue state plus mapped project status when available. |
| `labels` / `tags` | Issue labels. |
| `priority`, `size`, `risk` | Labels or GitHub Projects custom fields when present. |
| `blockers` | Linked issues, task lists, project fields, or issue body references marked as blocked/blocking. |
| `related_links` | Issue links, closing references, discussions, docs, and cross-references. |
| `source_provider` | `github`, repository owner/name, issue number, node id, and issue URL. |
| `pr_links` | Linked pull requests, closing PRs, branches, or manually referenced PR URLs. |
| `artifact_refs` | `.kontourai/flow-agents/<slug>/` artifacts, plan/review/evidence links, and promoted docs referenced from the issue or workflow. |

### GitHub Projects as `BoardProvider`

| Board field | GitHub Projects source |
| --- | --- |
| `project_membership` / `board_membership` | Organization or repository project, project item id, view or board name when known, status field, milestone, iteration, and custom fields. |
| `status` | Mapped project status field when it is more workflow-relevant than issue open/closed state. |
| `priority`, `size`, `risk` | Project custom fields or labels when those fields are configured. |
| `blockers` | Project dependency fields, linked issues, or custom blocked fields when configured. |
| `related_links` | Project item URL, project URL, milestone URL, and linked provider references. |

GitHub capability flags should reflect what the current token and project configuration can actually read. Do not treat unavailable project fields as empty truth; record them as not available or `NOT_VERIFIED` in workflow evidence when they affect selection.

### GitHub Pull Requests as `ChangeProvider`

| Publish/change field | GitHub source |
| --- | --- |
| `change_ref` | Pull request number, node id, head branch, base branch, URL, merge state, and review state. |
| `work_item_refs` | Issues linked in the pull request body, branch, commits, manually supplied metadata, or GraphQL closing issue references. |
| `closing_reference_check` | Provider-recognized closing issues from GitHub, compared with expected issue refs. |
| `provider_checks` | Check runs, status checks, required reviews, branch protection, mergeability, and deployment checks visible to the token. |
| `evidence_refs` | Workflow sidecars, verification summaries, CI URLs, check run URLs, review artifacts, and release-readiness records linked from the pull request. |

GitHub is the first adapter/example for publish-change. Core workflow text should still say `change_ref`, `provider_checks`, and `closing_reference_check` unless it is inside a GitHub mapping or example.

## Artifact References

Workflow artifacts should be linked by stable path or URL and should preserve traceability to source work items:

- pull-work artifacts that capture board snapshots and selection rationale
- plan artifacts and `acceptance.json`
- execution handoffs and modified-file evidence
- review, verification, evidence, release, and learning sidecars
- promoted durable docs or release notes

`artifact_refs` should not replace provider state. They connect agent workflow evidence back to the provider-backed work item.
